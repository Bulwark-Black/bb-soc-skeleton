"use strict";
const fs = require("node:fs"), path = require("node:path");
const { INTEGRATION_COVERAGE } = require("./integration-coverage");
const { getIntegrationManifest } = require("./integration-catalog");
const { sendJson } = require("./reference-control-plane");
const ASSISTANCE_BASE = "/api/v1/setup-assistance";
function fail() { const error = new TypeError("Unsupported setup assistance request."); error.status = 400; throw error; }
function readQuery(url, allowed) {
  const input = {};
  for (const [key, value] of url.searchParams) { if (!allowed.includes(key) || Object.hasOwn(input, key) || !value || value.length > 128) fail(); input[key] = value; }
  return input;
}
function screenHelp(runtime, input, clock = () => new Date()) {
  if (!input || Object.keys(input).some(key => !["route", "tab", "appId", "sourceId"].includes(key))) fail();
  const entries = INTEGRATION_COVERAGE.filter(item => item.route === input.route);
  const entry = input.route === "/scans" ? entries.find(item => item.query.tab === (input.tab || "trivy")) : entries[0];
  if (!entry || (input.tab && input.route !== "/scans")) fail();
  const state = runtime.controlState();
  for (const key of ["appId", "sourceId"]) if (input[key] !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input[key])) fail();
  if (input.appId && !state.apps.some(item => item.appId === input.appId)) fail();
  if (input.sourceId && !state.sources.some(item => item.sourceId === input.sourceId && (!input.appId || item.appId === input.appId))) fail();
  const sources = state.sources.filter(source => (!input.appId || source.appId === input.appId) && (!input.sourceId || source.sourceId === input.sourceId)
    && (input.route !== "/scans" || input.tab && input.tab !== "trivy" || source.connectorType === "trivy-report")
    && getIntegrationManifest(state, source.connectorType)?.payload.recordKinds.some(kind => entry.recordKinds.includes(kind)));
  const retained = entry.recordKinds.length ? runtime.store.queryObservations({ kinds: entry.recordKinds, limit: 1,
    ...(input.appId ? { appId: input.appId } : {}), ...(input.sourceId ? { sourceId: input.sourceId } : {}) }).count : null;
  let detail = !entry.recordKinds.length ? "This is a locally managed workflow, not a telemetry-fed screen. Use its record-management guide."
    : !sources.length ? "No compatible source is configured in this scope. Start a guide and connect a producer for the record kinds below. Retained history, if any, may belong to a removed or differently configured source."
      : !retained ? "Compatible source declarations exist, but no matching retained observations were found in this scope. Validate and activate the source, then send or import a real event. Validation samples are not telemetry."
        : "Matching records exist in retained storage. Check this screen's time range, filters, supported projector and specialized semantics. Retained records do not prove a fresh collector, and they may not satisfy this specific view.";
  if (input.route === "/scans" && (!input.tab || input.tab === "trivy")) detail += " Only validated Trivy imports populate the latest-report view; generic scan records do not count as Trivy evidence.";
  return { schemaVersion: "1", checkedAt: new Date(clock()).toISOString(), title: entry.title, recordKinds: [...entry.recordKinds],
    limitation: entry.limitation, configuredSources: sources.length, activeSources: sources.filter(item => item.state === "active").length,
    retainedRecords: retained, detail, sources: sources.slice(0, 50).map(source => ({ sourceId: source.sourceId, displayName: source.displayName, environment: source.environment, state: source.state })),
    omittedSources: Math.max(0, sources.length - 50) };
}
function operationsHelp({ runtime, stateDir, origin, port, clock = () => new Date() }) {
  const stat = fs.lstatSync(stateDir), entries = fs.readdirSync(stateDir), issues = [];
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) issues.push("Directory ownership or mode needs review.");
  for (const name of entries) {
    const item = fs.lstatSync(path.join(stateDir, name));
    if (!item.isFile() || item.isSymbolicLink() || item.nlink !== 1 || (item.mode & 0o077) || (process.getuid && item.uid !== process.getuid())) issues.push("A state entry has unexpected type, links, ownership or permissions.");
  }
  let freeBytes = null;
  try { const space = fs.statfsSync(stateDir); const available = space.bavail * space.bsize; if (Number.isSafeInteger(available) && available >= 0) freeBytes = available; } catch { /* Unknown is not zero or pass. */ }
  const storage = runtime.store.stats();
  return { schemaVersion: "1", checkedAt: new Date(clock()).toISOString(), origin, listener: "127.0.0.1", port,
    checks: [
      { id: "listener", state: "pass", title: "Local listener", detail: "This application binds to IPv4 loopback. Reverse proxies, forwarding, shared nodes, and remote reachability were not inspected." },
      { id: "origin", state: origin.startsWith("https:") ? "pass" : "manual", title: "Configured origin", detail: origin.startsWith("https:") ? "A private HTTPS origin is configured. Certificate validity, tailnet membership, ACLs, and absence of public forwarding still require external verification." : "Local HTTP is suitable for loopback access. Configure the actual private HTTPS origin before remote tailnet use." },
      { id: "state", state: issues.length ? "attention" : "pass", title: "Private state file permissions", detail: issues.length ? issues[0] : "Current state entries are owner-only regular files. This does not verify backup encryption, disk encryption, or other OS accounts." },
      { id: "disk", state: freeBytes === null ? "manual" : freeBytes < 100 * 1024 * 1024 ? "attention" : "pass", title: "Available filesystem space", detail: freeBytes === null ? "Free space could not be read. Inspect the state volume locally." : freeBytes + " bytes available on the state filesystem now. This is a point-in-time measurement, not a capacity forecast or disk monitor." },
      { id: "telemetry", state: "manual", title: "Retention and capacity", detail: storage.records + " retained records / " + storage.retention.maxRecords + " configured record capacity. Review count, age, bytes and dedupe limits in Retention; document and auth storage are separate." },
      { id: "supervision", state: "manual", title: "Supervision and independent watchdog", detail: "Configure an OS supervisor and an independent private outage monitor. The app cannot alert while its own process is stopped. No daemon installation is performed here." },
      { id: "restore", state: "manual", title: "Backup and restore proof", detail: "Stop the app cleanly, copy the entire private state including matching monitoring key and databases, and test restore in isolation. No backup or restore has been performed by this check." }
    ] };
}
function handleSetupAssistance(request, response, url, context) {
  if (request.method !== "GET") { const error = new Error("Setup assistance is read-only."); error.status = 405; throw error; }
  if (url.pathname === ASSISTANCE_BASE + "/screen") { sendJson(response, 200, screenHelp(context.runtime, readQuery(url, ["route", "tab", "appId", "sourceId"]))); return; }
  if (url.pathname === ASSISTANCE_BASE + "/operations") { readQuery(url, []); sendJson(response, 200, operationsHelp(context)); return; }
  const error = new Error("Setup assistance endpoint was not found."); error.status = 404; throw error;
}
module.exports = { ASSISTANCE_BASE, screenHelp, operationsHelp, handleSetupAssistance };
