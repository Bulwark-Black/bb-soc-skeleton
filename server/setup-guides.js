"use strict";

// Durable bookmarks for a guided workflow, never a second source registry or a
// credential store. Diagnostics are derived afresh from committed local facts.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const { readJsonBody, sendJson } = require("./reference-control-plane");
const { getIntegrationManifest } = require("./integration-catalog");
const { INTEGRATION_COVERAGE } = require("./integration-coverage");
const { scaledHealthThresholds } = require("./reference-manifest");
const { listVendorAdapters, vendorManifest } = require("../tools/vendor-adapters");

const SETUP_BASE = "/api/v1/setup";
const MAX_PLANS = 200;
const PATHS = Object.freeze(["live", "vendor", "custom", "trivy"]);
const SCHEMA = Object.freeze({
  setup_state: "CREATE TABLE setup_state (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL)",
  plans: "CREATE TABLE plans (id TEXT PRIMARY KEY, app_id TEXT NOT NULL, environment TEXT NOT NULL, path TEXT NOT NULL, source_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  plan_binding: "CREATE UNIQUE INDEX plan_binding ON plans(app_id, environment, path)"
});
const VENDOR_TYPES = new Set(listVendorAdapters().map(item => vendorManifest(item.id).connectorType));
const PLAN_ID = /^setup-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const identifier = value => typeof value === "string" && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
const instant = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function fail(message, status = 400, code = "setup-refused") {
  const error = new Error(message); error.status = status; error.code = code; throw error;
}
function exact(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
      || Reflect.ownKeys(value).some(key => !allowed.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"))) fail("Unsupported setup input.");
}
function human(actor) {
  if (typeof actor !== "string" || !/^operator:[a-f0-9]{64}$/.test(actor)) fail("An authenticated human operator is required.", 403);
}
function secureFile(filename) {
  let stat;
  try { stat = fs.lstatSync(filename); } catch (error) { if (error.code === "ENOENT") return false; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077)
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())) fail("Setup state files must be owner-only regular files without links.", 503);
  return true;
}
function openStorage(directory) {
  if (typeof directory !== "string" || !path.isAbsolute(directory) || directory !== fs.realpathSync(directory)) fail("Setup requires a canonical private state directory.", 503);
  const project = fs.realpathSync(path.join(__dirname, ".."));
  if (directory === path.parse(directory).root || directory === project || directory.startsWith(project + path.sep) || project.startsWith(directory + path.sep)) fail("Setup state must be outside the repository.", 503);
  let current = path.parse(directory).root;
  for (const component of directory.slice(current.length).split(path.sep)) {
    current = path.join(current, component); const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail("Setup state cannot use linked directories.", 503);
  }
  const stat = fs.lstatSync(directory);
  if ((stat.mode & 0o077) || (typeof process.getuid === "function" && stat.uid !== process.getuid())) fail("Setup state directory must be owner-only.", 503);
  const filename = path.join(directory, "setup-guides.sqlite");
  for (const suffix of ["", "-wal", "-shm", "-journal"]) secureFile(filename + suffix);
  const created = !fs.existsSync(filename);
  if (created) fs.closeSync(fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600));
  let db;
  try {
    db = new Database(filename); db.pragma("trusted_schema = OFF");
    const version = db.pragma("user_version", { simple: true });
    if (![0, 1].includes(version)) fail("Unsupported setup database version.", 503);
    if (!version) {
      if (!created) fail("Existing setup state has no recognized version.", 503);
      if (db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all().length) fail("Unrecognized setup database.", 503);
      db.transaction(() => {
        Object.values(SCHEMA).forEach(sql => db.exec(sql));
        db.prepare("INSERT INTO setup_state(id,revision) VALUES (1,0)").run(); db.pragma("user_version = 1");
      })();
    }
    const schema = db.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
    const normalize = sql => sql.replace(/\s+/g, " ").trim();
    if (schema.length !== Object.keys(SCHEMA).length || schema.some(item => !Object.hasOwn(SCHEMA, item.name)
      || normalize(item.sql || "") !== normalize(SCHEMA[item.name]))) fail("Setup database schema does not match this version.", 503);
    if (db.pragma("quick_check", { simple: true }) !== "ok") fail("Setup database integrity check failed.", 503);
    db.pragma("journal_mode = WAL"); db.pragma("synchronous = FULL"); db.pragma("busy_timeout = 5000");
    for (const suffix of ["", "-wal", "-shm"]) if (fs.existsSync(filename + suffix)) fs.chmodSync(filename + suffix, 0o600);
    return db;
  } catch { db?.close(); fail("Setup database is invalid. Restore a trusted backup.", 503); }
}
function publicPlan(row) {
  return { id: row.id, appId: row.app_id, environment: row.environment, path: row.path, sourceId: row.source_id,
    createdAt: row.created_at, updatedAt: row.updated_at };
}
function validPlan(value) {
  return PLAN_ID.test(value.id) && identifier(value.appId) && identifier(value.environment) && PATHS.includes(value.path)
    && (value.sourceId === null || identifier(value.sourceId)) && instant(value.createdAt) && instant(value.updatedAt) && value.updatedAt >= value.createdAt;
}
function validateStorage(db) {
  const states = db.prepare("SELECT id,revision FROM setup_state").all();
  if (states.length !== 1 || states[0].id !== 1 || !Number.isSafeInteger(states[0].revision) || states[0].revision < 0
      || db.prepare("SELECT COUNT(*) AS n FROM plans").get().n > MAX_PLANS
      || db.prepare("SELECT * FROM plans").all().some(row => !validPlan(publicPlan(row)))) fail("Setup recovery state is invalid or exceeds its supported bounds. Restore a trusted backup.", 503);
}
function pathMatches(source, selectedPath, connections, { choices = false } = {}) {
  const managed = connections.some(connection => connection.sourceId === source.sourceId);
  if (selectedPath === "live") return source.connectorType === "vendor.sentry-events" && source.sourceKind === "sentry-events" && (!choices || managed);
  if (selectedPath === "vendor") return VENDOR_TYPES.has(source.connectorType) && !managed;
  if (selectedPath === "trivy") return source.connectorType === "trivy-report";
  return !VENDOR_TYPES.has(source.connectorType) && source.connectorType !== "trivy-report";
}
function bind(runtime, monitoring, input) {
  if (!identifier(input.appId) || !identifier(input.environment) || !PATHS.includes(input.path)
      || (input.sourceId !== undefined && input.sourceId !== null && !identifier(input.sourceId))) fail("Choose a registered application, environment, and supported setup path.");
  const state = runtime.controlState(), application = state.apps.find(app => app.appId === input.appId);
  if (!application || !(application.environments || ["default"]).includes(input.environment)) fail("Choose a registered application and one of its declared environments.");
  const connections = monitoring.list({ limit: 1 }).connections;
  const source = input.sourceId ? state.sources.find(item => item.sourceId === input.sourceId) : null;
  if (input.sourceId && (!source || source.appId !== input.appId || source.environment !== input.environment || !pathMatches(source, input.path, connections))) {
    fail("The selected source does not belong to this application, environment, and setup path.");
  }
  return { state, source, connections };
}
function sourceHref(source, query = { stab: "observations" }) {
  return "#/sources?" + new URLSearchParams({ ...query, sourceId: source.sourceId, appId: source.appId });
}
function checkSetup({ runtime, monitoring, clock = () => new Date() }, input) {
  exact(input, ["appId", "environment", "path", "sourceId"]);
  const { state, source, connections } = bind(runtime, monitoring, input);
  const checkedAt = new Date(clock()).toISOString(), now = Date.parse(checkedAt), checks = [], destinations = [];
  const add = (id, title, status, detail, href) => checks.push({ id, title, state: status, detail, ...(href ? { href } : {}) });
  const route = input.path === "live" ? "#/sources?stab=live" : input.path === "vendor" ? "#/sources?stab=vendors" : input.path === "trivy" ? "#/scans?tab=trivy" : "#/sources?stab=add";
  add("binding", "Application and source", source ? "pass" : "waiting", source
    ? "This source belongs to the selected application and environment. Association does not prove collection."
    : "The application and environment exist. Connect or configure a source, then select it in this guide.", route);
  if (!source) {
    for (const [id, title] of [["activation", "Source activation"], ["admission", "Accepted canonical records"], ["collection", "Collection status"], ["projection", "Screen population"]]) {
      add(id, title, "waiting", "Select a compatible source before this check can inspect local evidence.", route);
    }
    add("notification-provider", "Notification provider", "not-applicable", "No live source is selected. External alert delivery is not inferred.");
    add("notification-human", "Human receipt confirmation", "not-applicable", "No notification channel is selected.");
  } else {
    const manifest = getIntegrationManifest(state, source.connectorType);
    const available = Boolean(manifest && runtime.connectorAvailable(source.connectorType, state));
    const active = available && source.state === "active";
    add("activation", "Source activation", active ? "pass" : ["paused", "archived", "removed", "disabled"].includes(source.state) || !available ? "attention" : "waiting",
      !available ? "The source declaration has no enabled admission driver. Installing a declaration does not install a collector."
        : active ? "The source is active and its canonical admission driver is enabled. Activation alone is not proof of data arrival."
          : "The source is not active. Complete its access or sample test and activation, or resolve its lifecycle state.", route);
    const selection = runtime.store.queryObservations({ sourceId: source.sourceId, appId: source.appId, limit: 1 });
    add("admission", "Accepted canonical records", selection.count ? "pass" : "waiting", selection.count
      ? selection.count + " accepted canonical records are still retained for this exact source. Retained history does not prove fresh delivery."
      : "No canonical records are currently retained for this source. A successful quiet poll does not manufacture records; previously accepted data may also have expired.", sourceHref(source));
    const connection = connections.find(item => item.sourceId === source.sourceId);
    if (input.path === "live") {
      const healthy = active && connection?.enabled && connection.health === "healthy" && instant(connection.lastSuccessAt)
        && instant(connection.completedThrough) && now - Date.parse(connection.lastSuccessAt) >= 0 && now - Date.parse(connection.lastSuccessAt) <= 300000
        && now - Date.parse(connection.completedThrough) >= 0 && now - Date.parse(connection.completedThrough) <= 300000 && !connection.pendingWindow && !connection.lastError;
      add("collection", "Collection status", healthy ? "pass" : !connection ? "attention" : connection.health === "starting" && active ? "waiting" : "attention",
        !connection ? "There is no managed live connection for this source. Reconnect it through Live monitoring; historical records are not evidence of a running collector."
          : healthy ? "The live collector recently completed its collection window successfully. A quiet window is healthy even with zero events. This does not certify complete upstream event coverage."
            : "The live collector is paused, starting, stale, failing, or still catching up. Inspect Live monitoring for its checkpoint and recovery action; retained history does not make it healthy.", route);
    } else if (input.path === "vendor" || input.path === "trivy") {
      add("collection", "Collection status", "not-applicable", "This path imports supplied files or reports. It does not install a polling service or run a scanner; arrange and verify any continuing export or scan schedule separately.", route);
    } else {
      const health = source.health || {}, last = health.lastSuccessAt;
      const staleAfter = manifest ? scaledHealthThresholds(source.connectorType, source.config["cadence-seconds"], manifest).staleAfterSeconds * 1000 : 0;
      const recent = instant(last) && now - Date.parse(last) >= 0 && now - Date.parse(last) <= staleAfter;
      const failed = ["offline", "stale", "degraded", "disabled"].includes(health.state), healthy = health.state === "healthy";
      add("collection", "Collection status", active && recent && healthy ? "pass" : !active || failed || last ? "attention" : "waiting",
        active && recent && healthy ? "The latest accepted delivery is within the configured cadence. The external sender process, its scheduling, and upstream completeness were not inspected."
          : !last ? "No successful delivery is recorded. Configure the external sender and verify an actual accepted batch. Registration and sample validation are not delivery."
            : "Delivery is inactive, failed, or overdue under the configured cadence. Historical records do not prove that the external sender is still running.", route);
    }
    const kinds = manifest?.payload.recordKinds || [];
    add("projection", "Screen population", selection.count ? "pass" : "waiting", selection.count
      ? "Retained source-scoped records can be opened in Observations. Other screens depend on their implemented record kinds and time ranges; imported facts do not execute workflows."
      : "The declaration is compatible with the destinations below, but compatibility is not populated data. No source-scoped retained records can currently populate Observations.", sourceHref(source));
    for (const entry of INTEGRATION_COVERAGE.filter(item => item.status === "observations" && item.recordKinds.some(kind => kinds.includes(kind)))) {
      const query = { ...entry.query, sourceId: source.sourceId, appId: source.appId };
      const filters = { kinds: entry.recordKinds.filter(kind => kinds.includes(kind)), sourceId: source.sourceId, appId: source.appId, limit: 1 };
      if (entry.route === "/timeline") { filters.observedAfter = new Date(now - 86400000).toISOString(); filters.observedBefore = new Date(now + 1).toISOString(); }
      const matches = runtime.store.queryObservations(filters).count;
      destinations.push({ title: entry.title, href: "#" + entry.route + "?" + new URLSearchParams(query),
        detail: matches + " retained matching records" + (entry.route === "/timeline" ? " in the default last 24 hours" : "") + ". " + entry.limitation });
    }
    if (input.path === "trivy") destinations.push({ title: "Trivy report imports", href: "#/scans?tab=trivy&appId=" + encodeURIComponent(input.appId) + "&sourceId=" + encodeURIComponent(source.sourceId),
      detail: "Specialized latest reports for this application and source; row limits and latest-report selection differ from Observations. Imported reports do not run Trivy." });
    if (!connection || !connection.hasSlack) {
      add("notification-provider", "Notification provider", "not-applicable", "Optional Slack delivery is not configured for this source. In-app evidence or imported alert.delivery facts are not proof of external notification delivery.");
      add("notification-human", "Human receipt confirmation", "not-applicable", "No Slack channel is configured. This check does not verify external notification systems.");
    } else {
      // The alert API is deliberately bounded. Paginate all retained rows rather
      // than treating a different connection's newest alert as delivery proof.
      let offset = 0, latest = null, blocked = false, pending = false;
      do {
        const page = monitoring.list({ offset, limit: 100 });
        for (const alert of page.alerts) if (alert.connectionId === connection.id) {
          if (alert.deliveryState === "delivered" && (!latest || alert.deliveredAt > latest)) latest = alert.deliveredAt || alert.createdAt;
          if (alert.deliveryState === "blocked") blocked = true;
          if (alert.deliveryState === "pending") pending = true;
        }
        offset = page.nextOffset;
      } while (offset !== null);
      const deliveryProblem = blocked || !["configured", "in-app only"].includes(connection.notificationStatus);
      add("notification-provider", "Notification provider", deliveryProblem ? "attention" : pending ? "waiting" : latest ? "pass" : "waiting",
        deliveryProblem ? "Slack delivery is blocked or has a recorded error. Inspect Live monitoring and resolve the credential, cooldown, or retry failure."
          : pending ? "At least one notification is still pending provider acknowledgment. Inspect the delivery queue; an older delivered alert does not confirm this one."
            : latest ? "Slack acknowledged at least one retained notification at " + latest + ". This is historical provider acknowledgment, not a test of current credentials or proof a person saw it."
              : "Slack is configured, but no retained provider acknowledgment was found. Send an explicit notification test from Live monitoring.", "#/sources?stab=live");
      add("notification-human", "Human receipt confirmation", "waiting", "Open the intended Slack channel and confirm the test message yourself. The application cannot observe channel membership, human receipt, or attention; this step is never automatically certified.", "#/sources?stab=live");
    }
  }
  const counts = status => checks.filter(item => item.state === status).length;
  return { schemaVersion: "1", checkedAt, appId: input.appId, environment: input.environment, sourceId: source?.sourceId || null, path: input.path,
    checks, destinations, summary: counts("pass") + " checks have local evidence; " + counts("waiting") + " are waiting; " + counts("attention")
      + " need attention. This read-only snapshot is not a security verdict, proof of complete monitoring, or an external connectivity test." };
}

function createSetupGuides({ stateDir, runtime, monitoring, clock = () => new Date() } = {}) {
  if (!runtime?.controlState || !runtime?.store?.queryObservations || !monitoring?.list) fail("Setup requires the private runtime and monitoring store.", 503);
  const db = openStorage(stateDir); let closed = false;
  try { validateStorage(db); } catch { db.close(); fail("Setup recovery state is invalid or exceeds its supported bounds. Restore a trusted backup.", 503); }
  const ensureOpen = () => { if (closed) fail("Setup store is closed.", 503); };
  const revision = () => db.prepare("SELECT revision FROM setup_state WHERE id=1").get().revision;
  const get = id => { if (!PLAN_ID.test(id)) fail("Setup plan not found.", 404); const row = db.prepare("SELECT * FROM plans WHERE id=?").get(id); if (!row) fail("Setup plan not found.", 404); return publicPlan(row); };
  const now = () => { const value = new Date(clock()).toISOString(); if (!instant(value)) fail("Invalid setup clock.", 503); return value; };
  function mutate(expected, actor, callback) {
    ensureOpen(); human(actor);
    if (!Number.isSafeInteger(expected) || expected < 0) fail("Supply the current setup revision.");
    return db.transaction(() => {
      const previous = revision();
      if (expected !== previous) fail("Setup changed. Refresh the saved guides and retry.", 409, "setup-conflict");
      if (previous >= Number.MAX_SAFE_INTEGER) fail("Setup revision capacity is exhausted.", 507);
      const result = callback(); db.prepare("UPDATE setup_state SET revision=? WHERE id=1").run(previous + 1);
      return { schemaVersion: "1", revision: previous + 1, ...result };
    }).immediate();
  }
  function duplicate(value, except) {
    const row = db.prepare("SELECT id FROM plans WHERE app_id=? AND environment=? AND path=?").get(value.appId, value.environment, value.path);
    if (row && row.id !== except) fail("A guide already exists for this application, environment, and path. Resume or update that guide.", 409, "setup-conflict");
  }
  return {
    list() {
      ensureOpen(); const state = runtime.controlState(), connections = monitoring.list({ limit: 1 }).connections;
      const choices = state.sources.flatMap(source => PATHS.filter(selected => pathMatches(source, selected, connections, { choices: true }))
        .map(selected => ({ appId: source.appId, environment: source.environment, path: selected, sourceId: source.sourceId, displayName: source.displayName, state: source.state })));
      return { schemaVersion: "1", revision: revision(), plans: db.prepare("SELECT * FROM plans ORDER BY created_at,id").all().map(publicPlan), choices };
    },
    create(input, actor) {
      exact(input, ["expectedRevision", "appId", "environment", "path", "sourceId"]);
      return mutate(input.expectedRevision, actor, () => {
        bind(runtime, monitoring, input); duplicate(input);
        if (db.prepare("SELECT COUNT(*) AS n FROM plans").get().n >= MAX_PLANS) fail("At most 200 setup guides can be saved. Remove an unused guide; this does not delete its source.", 409);
        const at = now(), plan = { id: "setup-" + crypto.randomUUID(), appId: input.appId, environment: input.environment, path: input.path, sourceId: input.sourceId ?? null, createdAt: at, updatedAt: at };
        db.prepare("INSERT INTO plans(id,app_id,environment,path,source_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
          .run(plan.id, plan.appId, plan.environment, plan.path, plan.sourceId, at, at);
        return { plan };
      });
    },
    update(id, input, actor) {
      exact(input, ["expectedRevision", "path", "sourceId"]);
      if (!Object.hasOwn(input, "path") && !Object.hasOwn(input, "sourceId")) fail("Supply a setup path or source selection to update.");
      return mutate(input.expectedRevision, actor, () => {
        const previous = get(id), plan = { ...previous, ...(Object.hasOwn(input, "path") ? { path: input.path } : {}),
          ...(Object.hasOwn(input, "sourceId") ? { sourceId: input.sourceId } : {}), updatedAt: now() };
        bind(runtime, monitoring, plan); duplicate(plan, id);
        if (!validPlan(plan)) fail("Invalid setup update.");
        db.prepare("UPDATE plans SET path=?,source_id=?,updated_at=? WHERE id=?").run(plan.path, plan.sourceId, plan.updatedAt, id);
        return { plan };
      });
    },
    remove(id, input, actor) {
      exact(input, ["expectedRevision"]);
      return mutate(input.expectedRevision, actor, () => { get(id); db.prepare("DELETE FROM plans WHERE id=?").run(id); return { removed: true }; });
    },
    check(input) { ensureOpen(); return checkSetup({ runtime, monitoring, clock }, input); },
    close() { if (!closed) { closed = true; db.close(); } }
  };
}
async function handleSetupGuides(request, response, url, store, actor) {
  if (request.method === "GET" && url.pathname === SETUP_BASE) {
    if (url.search) fail("Setup listing does not accept query parameters.");
    sendJson(response, 200, store.list()); return;
  }
  if (request.method === "GET" && url.pathname === SETUP_BASE + "/check") {
    const input = {};
    for (const [key, value] of url.searchParams) {
      if (!["appId", "environment", "path", "sourceId"].includes(key) || Object.hasOwn(input, key)) fail("Unsupported or repeated setup query.");
      input[key] = value;
    }
    sendJson(response, 200, store.check(input)); return;
  }
  if (url.search) fail("Setup mutations do not accept query parameters.");
  if (request.method === "POST" && url.pathname === SETUP_BASE + "/plans") {
    const { value } = await readJsonBody(request, 4096); sendJson(response, 201, store.create(value, actor)); return;
  }
  const match = /^\/api\/v1\/setup\/plans\/(setup-[a-f0-9-]{36})$/.exec(url.pathname);
  if (match && ["PATCH", "DELETE"].includes(request.method)) {
    const { value } = await readJsonBody(request, 4096);
    sendJson(response, 200, request.method === "PATCH" ? store.update(match[1], value, actor) : store.remove(match[1], value, actor)); return;
  }
  fail("Setup endpoint or method not found.", match || url.pathname === SETUP_BASE || url.pathname === SETUP_BASE + "/plans" || url.pathname === SETUP_BASE + "/check" ? 405 : 404);
}
module.exports = { SETUP_BASE, MAX_PLANS, PATHS, createSetupGuides, handleSetupGuides, checkSetup };
