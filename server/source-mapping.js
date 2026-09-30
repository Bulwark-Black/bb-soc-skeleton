"use strict";

// A data-only mapper: scalar selection and explicit constants, never executable
// transforms. Raw samples are scoped to this request and never written to disk.
const crypto = require("node:crypto");
const { RECORD_KINDS, validateNormalizedRecord, validateIngestBatch, validateTimestamp } = require("../tools/ingest-contract");
const { getIntegrationManifest } = require("./integration-catalog");
const { readJsonBody, sendJson } = require("./reference-control-plane");
const MAPPING_BASE = "/api/v1/source-mapping";
const LIMITS = Object.freeze({ inputBytes: 512 * 1024, records: 100, depth: 10, leafPaths: 512, nodes: 20000, recipeBytes: 64 * 1024, batchBytes: 1024 * 1024 });
const REQUIRED = Object.freeze({
  "alert.delivery": ["findingRef"], "asset.snapshot": ["assetRef"], "audit.event": ["category"], "authentication.event": ["identityRef"],
  "backup.status": ["assetRef"], "case.record": ["findingRef"], "compliance.record": ["category"], "database.schema": ["assetRef"],
  "endpoint.event": ["assetRef"], "evidence.receipt": ["category"], "file.integrity": ["assetRef", "category"], finding: ["severity"],
  "governance.attestation": ["category"], "governance.risk": ["category"], "honeypot.event": ["assetRef"], "identity.access": ["identityRef"],
  "intel.indicator": ["indicatorType", "indicator"], "intel.sync": ["category"], "log.event": ["message"], "network.event": ["category"],
  "offboarding.record": ["identityRef"], "phishing.report": ["findingRef"], "remediation.record": ["findingRef"], "retention.snapshot": ["category"],
  "rule.definition": ["ruleRef"], "scan.result": ["assetRef"], "software.package": ["assetRef"], "source.heartbeat": ["category"], "vulnerability.finding": ["assetRef", "severity"]
});
const PAYLOAD = Object.freeze(["title", "state", "severity", "assetRef", "identityRef", "ruleRef", "findingRef", "indicatorType", "indicator", "message", "summary", "channel", "category", "count", "startedAt", "completedAt", "dueAt", "fields"]);
const ENUMS = Object.freeze({ state: ["open", "closed", "active", "inactive", "ok", "warn", "failed", "unknown"], severity: ["critical", "high", "medium", "low", "info", "unknown"], indicatorType: ["ip", "domain", "url", "hash", "email", "other"] });
const SENSITIVE = ["secret", "password", "passwd", "token", "apikey", "privatekey", "credential", "authorization", "cookie", "sessionid"];
const sensitive = key => SENSITIVE.some(suffix => key.replace(/[^a-z0-9]/gi, "").toLowerCase().endsWith(suffix));
const unsafe = key => ["__proto__", "prototype", "constructor"].includes(key) || sensitive(key);
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
function fail(message, status = 400) { const error = new Error(message); error.status = status; error.code = "mapping-refused"; throw error; }
function exact(value, allowed, required = []) {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
      || Reflect.ownKeys(value).some(key => !allowed.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"))
      || required.some(key => !Object.hasOwn(value, key))) fail("Mapping input contains unsupported or missing fields.");
}
function identifier(value) { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) fail("Mapping binding identifiers are invalid."); return value; }
function pointer(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.length > 1024 || /~(?![01])/.test(value) || /[\u0000-\u001f\u007f]/.test(value)) fail("Use a bounded JSON Pointer to an own scalar field.");
  const keys = value.slice(1).split("/").map(key => key.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (keys.length > LIMITS.depth || keys.some(key => key.length > 128 || unsafe(key))) fail("Secret-bearing, prototype or excessively deep field paths are not allowed.");
  return keys;
}
function scalar(value) { return value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) || (typeof value === "string" && value.length <= 4000 && !value.includes("\u0000")); }
function selection(value, pathOnly = false) {
  exact(value, pathOnly ? ["path"] : ["path", "value"]);
  if (Object.keys(value).length !== 1) fail("Each mapping must select one field path or one explicit scalar constant.");
  if (Object.hasOwn(value, "path")) { pointer(value.path); return { path: value.path }; }
  if (pathOnly || !scalar(value.value)) fail("Mapping constants must be bounded scalar values; IDs and original timestamps require field paths.");
  return { value: value.value };
}
function validateRecipe(value) {
  exact(value, ["schemaVersion", "documentType", "appId", "environment", "sourceId", "kind", "upstreamId", "observedAt", "payload"],
    ["schemaVersion", "documentType", "appId", "environment", "sourceId", "kind", "upstreamId", "observedAt", "payload"]);
  if (value.schemaVersion !== "1" || value.documentType !== "source-mapping-recipe" || !RECORD_KINDS.includes(value.kind)) fail("Use source-mapping-recipe version 1 and a supported canonical kind.");
  exact(value.payload, PAYLOAD, ["title", "state", ...REQUIRED[value.kind]]);
  const payload = {};
  for (const key of PAYLOAD) if (Object.hasOwn(value.payload, key)) {
    if (key === "fields") {
      const fields = value.payload.fields;
      if (!fields || typeof fields !== "object" || Array.isArray(fields)) fail("Additional fields must be named scalar mappings.");
      exact(fields, Object.keys(fields));
      if (Object.keys(fields).length > 64 || Object.keys(fields).some(name => !/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(name) || unsafe(name))) fail("Additional fields contain an invalid or secret-bearing name.");
      payload.fields = {};
      for (const name of Object.keys(fields).sort()) payload.fields[name] = selection(fields[name]);
    } else payload[key] = selection(value.payload[key]);
  }
  const recipe = { schemaVersion: "1", documentType: "source-mapping-recipe", appId: identifier(value.appId), environment: identifier(value.environment), sourceId: identifier(value.sourceId),
    kind: value.kind, upstreamId: selection(value.upstreamId, true), observedAt: selection(value.observedAt, true), payload };
  if (Buffer.byteLength(JSON.stringify(recipe)) > LIMITS.recipeBytes) fail("Mapping recipe exceeds 64 KiB.", 413);
  return recipe;
}
function parseSourceText(text) {
  if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text) > LIMITS.inputBytes) fail("Supply nonempty redacted JSON or NDJSON up to 512 KiB.", typeof text === "string" && Buffer.byteLength(text) > LIMITS.inputBytes ? 413 : 400);
  let records;
  try { const parsed = JSON.parse(text); records = Array.isArray(parsed) ? parsed : [parsed]; }
  catch {
    try { records = text.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)); }
    catch { fail("The sample must be a JSON object, an array of objects, or one JSON object per nonempty NDJSON line. No data was imported."); }
  }
  if (!records.length || records.length > LIMITS.records || records.some(record => !record || typeof record !== "object" || Array.isArray(record))) fail("Supply 1–100 JSON objects; wrapped vendor pages must be unwrapped before mapping.");
  let nodes = 0; const paths = new Map();
  for (const record of records) {
    const present = new Set();
    function walk(value, keys) {
      if (++nodes > LIMITS.nodes || keys.length > LIMITS.depth) fail("Sample structure exceeds the depth or node limit.");
      if (value && typeof value === "object") {
        for (const key of Object.keys(value)) {
          if (key.length > 128 || /[\u0000-\u001f\u007f]/.test(key) || unsafe(key)) fail("Remove secret-bearing or prototype-named fields from the sample before inspection. No raw values were retained.");
          walk(value[key], [...keys, key]);
        }
      } else {
        if (typeof value === "number" && !Number.isFinite(value)) fail("Numeric sample values must be finite.");
        const fieldPath = "/" + keys.map(key => key.replace(/~/g, "~0").replace(/\//g, "~1")).join("/"); pointer(fieldPath);
        if (!paths.has(fieldPath)) paths.set(fieldPath, { path: fieldPath, types: new Set(), present: 0 });
        const field = paths.get(fieldPath); field.types.add(value === null ? "null" : typeof value); present.add(fieldPath);
        if (paths.size > LIMITS.leafPaths) fail("Sample exceeds 512 distinct leaf paths.");
      }
    }
    walk(record, []); for (const key of present) paths.get(key).present += 1;
  }
  return { records, fields: [...paths.values()].sort((a, b) => a.path.localeCompare(b.path)).map(field => ({ ...field, types: [...field.types].sort() })) };
}
function inspectSourceMapping(input) {
  exact(input, ["text"], ["text"]); const parsed = parseSourceText(input.text);
  return { schemaVersion: "1", records: parsed.records.length, fields: parsed.fields, limits: LIMITS,
    notice: "Only leaf paths, value types and presence counts are returned. Values are not stored. Secret-key rejection is not automatic redaction; review free text and identifiers yourself." };
}
function select(record, mapping) {
  if (Object.hasOwn(mapping, "value")) return mapping.value;
  let value = record;
  for (const key of pointer(mapping.path)) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) fail("A selected path is missing from at least one input record; no partial batch was produced.");
    value = value[key];
  }
  if (!scalar(value)) fail("A selected field must contain a bounded scalar in every record; no arrays, objects or implicit conversions are supported.");
  return value;
}
function mapSourceText(text, recipeInput, { clock = () => new Date() } = {}) {
  const recipe = validateRecipe(recipeInput), { records: input } = parseSourceText(text), unique = new Map();
  const now = new Date(clock()).getTime(); if (!Number.isFinite(now)) fail("The mapping clock is unavailable.", 503);
  for (const record of input) {
    const upstream = select(record, recipe.upstreamId);
    if (!((typeof upstream === "string" && upstream.trim() && upstream.length <= 512 && !/[\u0000-\u001f\u007f]/.test(upstream))
        || (typeof upstream === "number" && Number.isSafeInteger(upstream)))) fail("Every original event identity must be a nonempty string up to 512 characters or a safe integer; do not use array position or a generated time.");
    const originalTime = select(record, recipe.observedAt); let observedAt;
    try { observedAt = new Date(validateTimestamp(originalTime, "original timestamp")).toISOString(); }
    catch { fail("Every selected original timestamp must be a valid RFC 3339 date-time; no current-time replacement or coercion is performed."); }
    if (Date.parse(observedAt) > now + 300000) fail("Original event timestamps cannot be more than five minutes in the future.");
    const payload = {};
    for (const [key, mapping] of Object.entries(recipe.payload)) {
      if (key === "fields") { payload.fields = {}; for (const [name, field] of Object.entries(mapping)) payload.fields[name] = select(record, field); }
      else payload[key] = select(record, mapping);
    }
    let canonical;
    try { canonical = validateNormalizedRecord({ schemaVersion: "1", documentType: "normalized-record", recordId: "mapped:" + hash(["1", recipe.appId, recipe.environment, recipe.sourceId, recipe.kind, upstream]),
      sourceId: recipe.sourceId, estateId: recipe.appId, kind: recipe.kind, observedAt, payload }); }
    catch { fail("A selected value does not satisfy the canonical kind's required fields, enums, identifier formats or size limits. Review the mapping; no data was imported."); }
    const previous = unique.get(canonical.recordId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(canonical)) fail("One original event identity maps to conflicting content. Resolve the upstream duplicate; no partial batch was produced.");
    unique.set(canonical.recordId, canonical);
  }
  const records = [...unique.values()].sort((a, b) => a.recordId.localeCompare(b.recordId));
  const batch = validateIngestBatch({ schemaVersion: "1", documentType: "ingest-batch", sourceId: recipe.sourceId,
    receiptId: "mapped:" + hash(["1", recipe.appId, recipe.environment, recipe.sourceId, recipe.kind, records]), sentAt: records.map(record => record.observedAt).sort().at(-1), records });
  if (Buffer.byteLength(JSON.stringify(batch)) > LIMITS.batchBytes) fail("Mapped batch exceeds the sender's 1 MiB limit. Reduce the input batch; nothing was imported.", 413);
  return { schemaVersion: "1", recipe, batch, summary: { inputRecords: input.length, records: records.length, duplicatesWithinInput: input.length - records.length,
    sourceId: recipe.sourceId, appId: recipe.appId, environment: recipe.environment, kind: recipe.kind, imported: false, rawInputPersisted: false,
    notice: "Preview only. Review every retained value. Mapping validates structure, not truth, complete coverage, redaction or a running sender. Repeated IDs with changed mappings may conflict with already accepted records." } };
}
function eligible(runtime, state, source) {
  const manifest = getIntegrationManifest(state, source.connectorType);
  const custom = (state.integrationManifests || []).some(item => item.connectorType === source.connectorType);
  return Boolean(manifest && runtime.connectorAvailable(source.connectorType, state) && !source.connectorType.startsWith("vendor.") && source.connectorType !== "trivy-report"
    && (["canonical-push", "canonical-events"].includes(source.connectorType) || custom));
}
function mappingCatalog(runtime) {
  const state = runtime.controlState();
  return { schemaVersion: "1", limits: LIMITS, enums: ENUMS, apps: state.apps.map(app => ({ appId: app.appId, displayName: app.displayName, environments: app.environments || ["default"] })),
    sources: state.sources.filter(source => eligible(runtime, state, source)).map(source => ({ sourceId: source.sourceId, appId: source.appId, environment: source.environment,
      displayName: source.displayName, state: source.state, recordKinds: getIntegrationManifest(state, source.connectorType).payload.recordKinds })),
    kinds: RECORD_KINDS.map(kind => ({ kind, requiredPayload: ["title", "state", ...REQUIRED[kind]], optionalPayload: PAYLOAD.filter(key => key !== "fields" && !["title", "state", ...REQUIRED[kind]].includes(key)) })) };
}
function previewSourceMapping(runtime, input, options) {
  exact(input, ["appId", "environment", "sourceId", "text", "recipe"], ["appId", "environment", "sourceId", "text", "recipe"]);
  const recipe = validateRecipe(input.recipe), state = runtime.controlState();
  const app = state.apps.find(item => item.appId === input.appId), source = state.sources.find(item => item.sourceId === input.sourceId);
  if (!app || !(app.environments || ["default"]).includes(input.environment) || !source || source.appId !== input.appId || source.environment !== input.environment
      || !eligible(runtime, state, source) || ["removed", "archived"].includes(source.state)
      || recipe.appId !== input.appId || recipe.environment !== input.environment || recipe.sourceId !== input.sourceId
      || !getIntegrationManifest(state, source.connectorType).payload.recordKinds.includes(recipe.kind)) fail("Select a nonarchived custom or canonical source in the registered application and environment, with an enabled driver that supports this kind.");
  return mapSourceText(input.text, recipe, options);
}
async function handleSourceMapping(request, response, url, runtime) {
  if (url.search) fail("Source mapping endpoints do not accept query parameters.");
  if (request.method === "GET" && url.pathname === MAPPING_BASE) { sendJson(response, 200, mappingCatalog(runtime)); return; }
  if (request.method === "POST" && [MAPPING_BASE + "/inspect", MAPPING_BASE + "/preview"].includes(url.pathname)) {
    // JSON escaping can amplify the bounded raw input. Its decoded bytes are
    // independently checked before traversal; this envelope limit stays finite.
    const { value } = await readJsonBody(request, 4 * 1024 * 1024);
    sendJson(response, 200, url.pathname.endsWith("/inspect") ? inspectSourceMapping(value) : previewSourceMapping(runtime, value)); return;
  }
  fail("Source mapping endpoint or method not found.", [MAPPING_BASE, MAPPING_BASE + "/inspect", MAPPING_BASE + "/preview"].includes(url.pathname) ? 405 : 404);
}
module.exports = { MAPPING_BASE, LIMITS, mappingCatalog, inspectSourceMapping, previewSourceMapping, mapSourceText, validateRecipe, handleSourceMapping };
