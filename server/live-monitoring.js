"use strict";

// A deliberately narrow, supervised collector. Vendor payloads exist only in
// memory; the recovery journal contains canonical records and bounded metadata.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const transport = require("./live-monitoring-transport");
const { vendorManifest, normalizeVendorPayload } = require("../tools/vendor-adapters");
const { runAsOperator } = require("./operator-context");
const { readJsonBody, sendJson } = require("./reference-control-plane");
const { validateIngestBatch } = require("../tools/ingest-contract");

const BASE = "/api/v1/monitoring";
const MINUTE = 60000, DAY = 86400000;
const LIMITS = Object.freeze({ connections: 20, alerts: 10000, identities: 100000, pollSeconds: 60,
  initialLookbackMinutes: 15, overlapMinutes: 5, pagesPerPass: 5, pageRecords: 100, maxCatchupDays: 6 });
const digest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const iso = value => new Date(value).toISOString();
// Unrepresentable vendor cooldowns block indefinitely; never shorten them.
const scheduledAt = (time, delay) => time + delay <= 253402300799999 ? iso(time + delay) : null;
const JOURNAL_SCHEMA = Object.freeze({
  connections: "CREATE TABLE connections (id TEXT PRIMARY KEY, data TEXT NOT NULL, secrets TEXT NOT NULL)",
  alerts: "CREATE TABLE alerts (id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL)",
  alerts_connection: "CREATE INDEX alerts_connection ON alerts(connection_id, created_at)",
  seen_events: "CREATE TABLE seen_events (connection_id TEXT NOT NULL, record_id TEXT NOT NULL, observed_at TEXT NOT NULL, PRIMARY KEY(connection_id, record_id))",
  seen_age: "CREATE INDEX seen_age ON seen_events(observed_at)",
  audit: "CREATE TABLE audit (sequence INTEGER PRIMARY KEY AUTOINCREMENT, connection_id TEXT NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL)"
});
function fail(message, status = 400, code = "monitoring-refused") {
  const error = new Error(message); error.status = status; error.code = code; throw error;
}
function exact(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) fail("Unsupported monitoring input.");
}
function human(actor) { if (typeof actor !== "string" || !/^operator:[a-f0-9]{64}$/.test(actor)) fail("An authenticated human operator is required.", 403); }
function label(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 100 || /[\u0000-\u001f\u007f]/.test(value)) fail("Supply a display name of 1–100 characters.");
  return value.trim();
}
function validateCredential(callback) {
  try { return callback(); } catch (error) { if (error.name === "LiveTransportError") fail(error.message); throw error; }
}
function secureFile(filename) {
  let stat;
  try { stat = fs.lstatSync(filename); } catch (error) { if (error.code === "ENOENT") return false; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077)
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())) fail("Monitoring state files must be owner-only regular files without links.", 503);
  return true;
}
function openStorage(directory) {
  if (typeof directory !== "string" || !path.isAbsolute(directory) || directory !== fs.realpathSync(directory)) fail("Monitoring requires a canonical private state directory.", 503);
  const project = fs.realpathSync(path.join(__dirname, ".."));
  if (directory === path.parse(directory).root || directory === project || directory.startsWith(project + path.sep) || project.startsWith(directory + path.sep)) fail("Monitoring state must be outside the repository.", 503);
  let current = path.parse(directory).root;
  for (const component of directory.slice(current.length).split(path.sep)) {
    current = path.join(current, component); const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail("Monitoring state cannot use linked directories.", 503);
  }
  const stat = fs.lstatSync(directory);
  if ((stat.mode & 0o077) || (typeof process.getuid === "function" && stat.uid !== process.getuid())) fail("Monitoring state directory must be owner-only.", 503);
  const filename = path.join(directory, "live-monitoring.sqlite"), keyfile = path.join(directory, "live-monitoring.key");
  for (const suffix of ["", "-wal", "-shm", "-journal"]) secureFile(filename + suffix);
  if (!secureFile(keyfile)) {
    if (fs.existsSync(filename)) fail("Monitoring key is missing. Restore the database and its original key together.", 503);
    fs.writeFileSync(keyfile, crypto.randomBytes(32), { mode: 0o600, flag: "wx" });
  }
  const key = fs.readFileSync(keyfile);
  if (key.length !== 32) fail("Monitoring key is invalid. Restore its trusted backup.", 503);
  if (!fs.existsSync(filename)) fs.closeSync(fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600));
  const db = new Database(filename);
  try {
    db.pragma("trusted_schema = OFF");
    const version = db.pragma("user_version", { simple: true });
    if (![0, 1].includes(version)) fail("Unsupported monitoring database version.", 503);
    if (!version) {
      if (db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all().length) fail("Unrecognized monitoring database.", 503);
      db.transaction(() => db.exec(`
        CREATE TABLE connections (id TEXT PRIMARY KEY, data TEXT NOT NULL, secrets TEXT NOT NULL);
        CREATE TABLE alerts (id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
        CREATE INDEX alerts_connection ON alerts(connection_id, created_at);
        CREATE TABLE seen_events (connection_id TEXT NOT NULL, record_id TEXT NOT NULL, observed_at TEXT NOT NULL, PRIMARY KEY(connection_id, record_id));
        CREATE INDEX seen_age ON seen_events(observed_at);
        CREATE TABLE audit (sequence INTEGER PRIMARY KEY AUTOINCREMENT, connection_id TEXT NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL);
        PRAGMA user_version = 1;
      `))();
    }
    const schema = db.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
    const normalizeSql = value => value.replace(/\s+/g, " ").trim();
    if (schema.length !== Object.keys(JOURNAL_SCHEMA).length || schema.some(item => !Object.hasOwn(JOURNAL_SCHEMA, item.name)
        || normalizeSql(item.sql || "") !== normalizeSql(JOURNAL_SCHEMA[item.name]))) fail("Monitoring database schema does not match this version.", 503);
    if (db.pragma("quick_check", { simple: true }) !== "ok") fail("Monitoring database integrity check failed.", 503);
    db.pragma("journal_mode = WAL"); db.pragma("synchronous = FULL"); db.pragma("busy_timeout = 5000");
    for (const suffix of ["", "-wal", "-shm"]) if (fs.existsSync(filename + suffix)) fs.chmodSync(filename + suffix, 0o600);
    const seal = (id, value) => {
      const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(Buffer.from(id));
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64");
    };
    const unseal = (id, value) => {
      try {
        const bytes = Buffer.from(value, "base64"), decipher = crypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
        decipher.setAAD(Buffer.from(id)); decipher.setAuthTag(bytes.subarray(12, 28));
        return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"));
      } catch { fail("Monitoring credentials cannot be decrypted. Restore the matching database and key.", 503); }
    };
    return { db, seal, unseal, key };
  } catch (error) { db.close(); key.fill(0); throw error; }
}

// Restore is a trust boundary: reject malformed journals before a scheduler can
// consume their cursors, canonical payloads, delivery targets, or public text.
function validateJournal(db, runtime, unseal) {
  const requireValid = value => { if (!value) fail("Monitoring recovery journal is invalid or exceeds its supported bounds. Restore a trusted backup.", 503); };
  const uuid = (value, prefix) => typeof value === "string" && new RegExp("^" + prefix + "-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$").test(value);
  const recordId = value => typeof value === "string" && /^vendor:[a-f0-9]{64}$/.test(value);
  const time = (value, nullable = false) => {
    requireValid((nullable && value === null) || (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
      && Number.isFinite(Date.parse(value)) && iso(Date.parse(value)) === value));
  };
  const integer = (value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => requireValid(Number.isSafeInteger(value) && value >= minimum && value <= maximum);
  const text = (value, maximum, nullable = false) => requireValid((nullable && value === null)
    || (typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value)));
  const json = (value, maximum) => { requireValid(typeof value === "string" && Buffer.byteLength(value) <= maximum); return JSON.parse(value); };
  const cursor = value => requireValid(value === null || (typeof value === "string" && /^\d{1,20}:\d{1,12}:0$/.test(value)));
  const context = runtime.controlState(), connections = new Map();
  for (const [table, maximum] of [["connections", LIMITS.connections], ["alerts", LIMITS.alerts], ["seen_events", LIMITS.identities], ["audit", 10000]]) {
    requireValid(db.prepare("SELECT COUNT(*) AS n FROM " + table).get().n <= maximum);
  }
  for (const entry of db.prepare("SELECT * FROM connections").iterate()) {
    const row = json(entry.data, 2 * 1024 * 1024);
    exact(row, ["id", "sourceId", "provisioning", "appId", "environment", "displayName", "config", "enabled", "revision", "createdAt", "coverageStartAt",
      "completedThrough", "window", "pending", "lastAttemptAt", "lastSuccessAt", "lastEventAt", "nextPollAt", "lastError", "failureSince", "failures", "totalEvents",
      "hasSlack", "notificationError", "notificationNextAt", "notificationRetryBlocked", "lastTestAt"]);
    requireValid(uuid(row.id, "monitor") && row.id === entry.id && uuid(row.appId, "app"));
    requireValid(typeof row.enabled === "boolean" && typeof row.provisioning === "boolean" && typeof row.hasSlack === "boolean"
      && (row.notificationRetryBlocked === undefined || typeof row.notificationRetryBlocked === "boolean"));
    integer(row.revision, 1); integer(row.failures, 0, 10); integer(row.totalEvents);
    requireValid(label(row.displayName) === row.displayName); transport.validateSentryConfig(row.config);
    const application = context.apps.find(item => item.appId === row.appId);
    requireValid(application && (application.environments || ["default"]).includes(row.environment));
    if (row.sourceId === null) requireValid(row.provisioning);
    else {
      const source = context.sources.find(item => item.sourceId === row.sourceId);
      requireValid(uuid(row.sourceId, "source") && source && source.appId === row.appId && source.environment === row.environment
        && source.connectorType === "vendor.sentry-events" && source.sourceKind === "sentry-events" && source.hostId === undefined);
    }
    for (const key of ["createdAt", "coverageStartAt"]) time(row[key]);
    for (const key of ["completedThrough", "lastAttemptAt", "lastSuccessAt", "lastEventAt", "nextPollAt", "failureSince", "notificationNextAt"]) time(row[key], true);
    if (row.lastTestAt !== undefined) time(row.lastTestAt);
    requireValid(Date.parse(row.coverageStartAt) <= Date.parse(row.createdAt));
    requireValid(row.completedThrough === null || Date.parse(row.completedThrough) >= Date.parse(row.coverageStartAt));
    for (const key of ["lastError", "notificationError"]) text(row[key], 500, true);
    text(entry.secrets, 8192); const secrets = unseal(row.id, entry.secrets);
    exact(secrets, ["token", "slackWebhook"]); transport.validateToken(secrets.token);
    if (secrets.slackWebhook !== null) transport.validateSlackWebhook(secrets.slackWebhook);
    requireValid(row.hasSlack === Boolean(secrets.slackWebhook));
    if (row.window !== null) {
      exact(row.window, ["start", "end", "cursor", "cursors", "pages"]);
      time(row.window.start); time(row.window.end); cursor(row.window.cursor); integer(row.window.pages, 0, 10000);
      requireValid(Date.parse(row.window.start) >= Date.parse(row.coverageStartAt) && Date.parse(row.window.end) > Date.parse(row.window.start)
        && Date.parse(row.window.end) - Date.parse(row.window.start) <= 65 * MINUTE);
      requireValid(Array.isArray(row.window.cursors) && row.window.cursors.length === row.window.pages
        && new Set(row.window.cursors).size === row.window.cursors.length);
      row.window.cursors.forEach(value => { cursor(value); requireValid(value !== null); });
      requireValid(row.window.cursor === (row.window.cursors.at(-1) || null));
    }
    if (row.pending !== null) {
      requireValid(row.window !== null && row.sourceId !== null);
      const pending = row.pending; exact(pending, ["batch", "bodyHash", "candidates", "nextCursor"]); cursor(pending.nextCursor);
      requireValid(pending.nextCursor === null || !row.window.cursors.includes(pending.nextCursor));
      requireValid(Array.isArray(pending.candidates) && pending.candidates.length <= LIMITS.pageRecords);
      if (pending.batch === null) requireValid(pending.bodyHash === null && pending.candidates.length === 0 && pending.nextCursor === null);
      else {
        const batch = validateIngestBatch(pending.batch);
        requireValid(JSON.stringify(batch) === JSON.stringify(pending.batch) && batch.sourceId === row.sourceId && digest(batch) === pending.bodyHash
          && batch.records.length === pending.candidates.length && batch.records.length <= LIMITS.pageRecords);
        const records = new Map(batch.records.map(record => [record.recordId, record]));
        requireValid(new Set(pending.candidates.map(item => item.recordId)).size === pending.candidates.length);
        for (const candidate of pending.candidates) {
          exact(candidate, ["recordId", "observedAt", "level", "vendorEventId", "url"]);
          const record = records.get(candidate.recordId);
          requireValid(record && recordId(record.recordId) && record.estateId === row.appId && record.kind === "log.event"
            && record.payload.fields?.adapterId === "sentry-events" && record.payload.fields.adapterVersion === "1"
            && candidate.observedAt === record.observedAt && candidate.level === record.payload.fields.reportedLevel
            && /^[a-f0-9]{32}$/.test(candidate.vendorEventId) && record.recordId === "vendor:" + digest(["1", "sentry-events", row.sourceId, row.appId, "log.event", candidate.vendorEventId])
            && Date.parse(record.observedAt) >= Date.parse(row.window.start) && Date.parse(record.observedAt) <= Date.parse(row.window.end));
          const prefix = (row.config.region === "eu" ? "https://de.sentry.io" : "https://sentry.io") + "/organizations/" + row.config.organization + "/issues/";
          requireValid(candidate.url === prefix || (typeof candidate.url === "string" && candidate.url.startsWith(prefix)
            && new RegExp("^[0-9]{1,30}/events/" + candidate.vendorEventId + "/$").test(candidate.url.slice(prefix.length))));
        }
      }
    }
    connections.set(row.id, row);
  }
  for (const entry of db.prepare("SELECT * FROM alerts").iterate()) {
    const value = json(entry.data, 8192);
    exact(value, ["id", "connectionId", "sourceId", "appId", "kind", "title", "body", "createdAt", "acknowledgedAt", "deliveryState", "attempts", "nextAttemptAt", "deliveredAt", "evidence"]);
    requireValid(/^alert-[a-f0-9]{64}$/.test(value.id) && value.id === entry.id && uuid(value.connectionId, "monitor")
      && value.connectionId === entry.connection_id && uuid(value.appId, "app") && (value.sourceId === null || uuid(value.sourceId, "source"))
      && value.createdAt === entry.created_at && ["application-errors", "collection-failed", "collection-recovered", "notification-test"].includes(value.kind)
      && ["pending", "blocked", "delivered", "in-app", "cancelled"].includes(value.deliveryState));
    time(value.createdAt); time(value.acknowledgedAt, true); time(value.nextAttemptAt, true); integer(value.attempts, 0, 10);
    if (value.deliveredAt !== undefined) time(value.deliveredAt);
    text(value.title, 200); text(value.body, 2000);
    if (value.evidence !== undefined) {
      exact(value.evidence, ["recordId", "observedAt", "vendorEventId", "url"]);
      requireValid(recordId(value.evidence.recordId) && /^[a-f0-9]{32}$/.test(value.evidence.vendorEventId)); time(value.evidence.observedAt);
      requireValid(typeof value.evidence.url === "string" && /^https:\/\/(?:sentry\.io|de\.sentry\.io)\/organizations\/[a-z0-9][a-z0-9_-]{0,199}\/issues\/(?:[0-9]{1,30}\/events\/[a-f0-9]{32}\/)?$/.test(value.evidence.url));
    }
    if (connections.has(value.connectionId)) requireValid(value.appId === connections.get(value.connectionId).appId
      && (value.sourceId === null || value.sourceId === connections.get(value.connectionId).sourceId));
    else requireValid(!["pending", "blocked"].includes(value.deliveryState));
  }
  for (const row of db.prepare("SELECT * FROM seen_events").iterate()) {
    requireValid(connections.has(row.connection_id) && recordId(row.record_id)); time(row.observed_at);
  }
  for (const row of db.prepare("SELECT * FROM audit").iterate()) {
    integer(row.sequence, 1); requireValid(uuid(row.connection_id, "monitor") && ["connect", "pause", "resume", "remove", "credentials", "retry-notifications", "alert.acknowledge"].includes(row.action));
    human(row.actor); time(row.at);
  }
}

function createLiveMonitoring({ stateDir, runtime, clock = () => new Date(), fetchImpl = globalThis.fetch, autoStart = true } = {}) {
  const { db, seal, unseal, key } = openStorage(stateDir);
  const jobs = new Map(); let closed = false, timer, creating = false, lastScheduledId = null;
  const now = () => { const value = new Date(clock()).getTime(); if (!Number.isFinite(value)) fail("Invalid monitoring clock.", 503); return value; };
  const rows = () => db.prepare("SELECT * FROM connections ORDER BY id").all();
  const get = id => { const row = db.prepare("SELECT * FROM connections WHERE id=?").get(id); return row && { ...JSON.parse(row.data), sealed: row.secrets }; };
  const put = row => { const { sealed, ...data } = row; db.prepare("UPDATE connections SET data=?,secrets=? WHERE id=?").run(JSON.stringify(data), sealed, row.id); };
  const actor = id => callback => runAsOperator("live-monitor:" + id, callback);
  const audit = (id, action, who) => {
    db.prepare("INSERT INTO audit(connection_id,action,actor,at) VALUES(?,?,?,?)").run(id, action, who, iso(now()));
    db.prepare("DELETE FROM audit WHERE sequence <= (SELECT COALESCE(MAX(sequence),0)-10000 FROM audit)").run();
  };
  const command = (row, name, input, stable = false) => actor(row.id)(() => {
    const result = runtime.execute({ schemaVersion: "1", documentType: "connector-command-request", requestId: stable ? row.id + ":setup" : crypto.randomUUID(),
      command: name, requestedAt: stable ? row.createdAt : iso(now()), input });
    if (result.status !== "succeeded") fail("The managed source could not be updated. Review Sources and retry.", 409);
    return result.output;
  });
  function provision(row) {
    if (!row.provisioning) {
      const source = runtime.controlState().sources.find(item => item.sourceId === row.sourceId);
      if (source?.state !== "active") fail("The managed source is no longer active. Review its lifecycle in Sources.", 409);
      return;
    }
    if (!row.sourceId) {
      const desired = vendorManifest("sentry-events"), catalog = runtime.listIntegrations();
      const existing = catalog.integrations.find(item => item.manifest.connectorType === desired.connectorType)?.manifest;
      if (!existing) actor(row.id)(() => runtime.installIntegration({ manifest: desired, expectedRevision: catalog.revision }));
      else if (JSON.stringify(existing) !== JSON.stringify(desired)) fail("The Sentry preset differs from the reviewed live collector definition.", 409);
      const source = command(row, "source.setup", { appId: row.appId, environment: row.environment, connectorType: desired.connectorType,
        sourceKind: "sentry-events", displayName: row.displayName, config: { "cadence-seconds": 60 }, credentialReferences: [] }, true);
      row.sourceId = source.sourceId; put(row);
    }
    const source = runtime.controlState().sources.find(item => item.sourceId === row.sourceId);
    if (source?.state === "configured") actor(row.id)(() => runtime.activateLiveSentrySource(row.sourceId));
    else if (source?.state !== "active") fail("The managed source is not active. Review its lifecycle in Sources.", 409);
    row.provisioning = false; put(row);
  }
  function health(row) {
    if (!row.enabled) return "paused";
    const source = runtime.controlState().sources.find(item => item.sourceId === row.sourceId);
    if (row.sourceId && source?.state !== "active") return "offline";
    if (row.lastError) return "degraded";
    if (!row.lastSuccessAt) return row.window?.pages ? "degraded" : "starting";
    if (now() - Date.parse(row.lastSuccessAt) > 5 * MINUTE) return "offline";
    if (row.window || !row.completedThrough || now() - Date.parse(row.completedThrough) > 5 * MINUTE) return "degraded";
    return "healthy";
  }
  function publicConnection(row) {
    return { id: row.id, sourceId: row.sourceId, appId: row.appId, environment: row.environment, displayName: row.displayName,
      region: row.config.region, organization: row.config.organization, project: row.config.project, enabled: row.enabled,
      revision: row.revision, health: health(row), lastAttemptAt: row.lastAttemptAt, lastSuccessAt: row.lastSuccessAt,
      lastEventAt: row.lastEventAt, nextPollAt: row.nextPollAt, lastError: row.lastError,
      hasSlack: row.hasSlack, notificationStatus: row.notificationError || (row.hasSlack ? "configured" : "in-app only"),
      coverageStartAt: row.coverageStartAt, completedThrough: row.completedThrough, pendingWindow: row.window ? { start: row.window.start, end: row.window.end, pages: row.window.pages } : null,
      totalEvents: row.totalEvents, createdAt: row.createdAt };
  }
  function alert(row, kind, title, body, evidence, identity) {
    const id = "alert-" + digest([row.id, identity]);
    if (db.prepare("SELECT id FROM alerts WHERE id=?").get(id)) return;
    if (db.prepare("SELECT COUNT(*) AS n FROM alerts").get().n >= LIMITS.alerts) {
      // Never silently evict unread/undelivered alerts to claim continued coverage.
      db.prepare("DELETE FROM alerts WHERE id IN (SELECT id FROM alerts WHERE json_extract(data,'$.acknowledgedAt') IS NOT NULL AND json_extract(data,'$.deliveryState') IN ('delivered','in-app','cancelled') ORDER BY created_at LIMIT 100)").run();
      if (db.prepare("SELECT COUNT(*) AS n FROM alerts").get().n >= LIMITS.alerts) fail("Monitoring alert capacity reached. Acknowledge old alerts and resolve delivery failures.", 507);
    }
    const value = { id, connectionId: row.id, sourceId: row.sourceId, appId: row.appId, kind, title, body,
      createdAt: iso(now()), acknowledgedAt: null, deliveryState: row.hasSlack ? "pending" : "in-app", attempts: 0, nextAttemptAt: iso(now()), ...(evidence ? { evidence } : {}) };
    db.prepare("INSERT INTO alerts(id,connection_id,created_at,data) VALUES(?,?,?,?)").run(id, row.id, value.createdAt, JSON.stringify(value));
  }
  function updateSourceHealth(row, state) {
    if (!row.sourceId) return;
    const source = runtime.controlState().sources.find(item => item.sourceId === row.sourceId);
    actor(row.id)(() => runtime.updateLiveSentryHealth(row.sourceId, { state, lastAttemptAt: row.lastAttemptAt,
      lastSuccessAt: state === "healthy" ? row.lastSuccessAt : source?.health.lastSuccessAt || null, nextExpectedAt: row.nextPollAt }));
  }
  function checked(id, revision) {
    const row = get(id); if (!row) fail("Monitoring connection not found.", 404);
    if (!Number.isSafeInteger(revision) || row.revision !== revision) fail("Connection changed. Refresh and retry.", 409);
    return row;
  }
  function active(id, revision, signal) {
    const row = get(id);
    return !closed && !signal.aborted && row?.enabled && row.revision === revision ? row : null;
  }
  function createPending(row, events, nextCursor) {
    if (nextCursor && (row.window.cursors.includes(nextCursor) || row.window.pages >= 10000)) {
      fail("Pagination repeated or exceeded the safety limit. The checkpoint has not advanced.", 422);
    }
    let normalized = null, candidates = [];
    if (events.length) {
      normalized = normalizeVendorPayload("sentry-events", events, { sourceId: row.sourceId, estateId: row.appId });
      const upstream = new Map(events.map(event => {
        const one = normalizeVendorPayload("sentry-events", [event], { sourceId: row.sourceId, estateId: row.appId }).batch.records[0];
        return [one.recordId, event];
      }));
      for (const record of normalized.batch.records) {
        const time = Date.parse(record.observedAt);
        if (time < Date.parse(row.window.start) || time > Date.parse(row.window.end)) fail("Sentry returned an event outside the requested collection window.", 422);
        const event = upstream.get(record.recordId), eventId = event.eventID.toLowerCase();
        const issueId = typeof event.groupID === "string" && /^\d{1,30}$/.test(event.groupID) ? event.groupID : null;
        const origin = row.config.region === "eu" ? "https://de.sentry.io" : "https://sentry.io";
        candidates.push({ recordId: record.recordId, observedAt: record.observedAt, level: record.payload.fields.reportedLevel,
          vendorEventId: eventId, url: origin + "/organizations/" + encodeURIComponent(row.config.organization) + "/issues/" + (issueId ? issueId + "/events/" + eventId + "/" : "") });
      }
    }
    return { batch: normalized?.batch || null, bodyHash: normalized?.bodyHash || null, candidates, nextCursor };
  }
  function commitPending(row) {
    const pending = row.pending;
    if (pending.batch) actor(row.id)(() => runtime.ingestVendorAsOperator(pending.batch, pending.bodyHash, "sentry-events"));
    // If admission committed but this transaction did not, the saved pending
    // batch is replayed unchanged. Alert identities and seen events commit here.
    db.transaction(() => {
      db.prepare("DELETE FROM seen_events WHERE observed_at < ?").run(iso(now() - 7 * DAY));
      const fresh = pending.candidates.filter(item => !db.prepare("SELECT 1 FROM seen_events WHERE connection_id=? AND record_id=?").get(row.id, item.recordId));
      if (db.prepare("SELECT COUNT(*) AS n FROM seen_events").get().n + fresh.length > LIMITS.identities) fail("Monitoring identity capacity reached. Collection is stopped without advancing the checkpoint.", 507);
      if (fresh.length) {
        const sample = fresh[0], high = fresh.filter(item => ["fatal", "error"].includes(item.level)).length;
        alert(row, "application-errors", fresh.length + " new application error event(s)",
          row.displayName + ": " + fresh.length + " newly observed Sentry error event(s); " + high + " reported error/fatal. Inspect the event evidence and recent deployments in Sentry. These are application errors, not a security verdict.",
          { recordId: sample.recordId, observedAt: sample.observedAt, vendorEventId: sample.vendorEventId, url: sample.url },
          ["events", fresh.map(item => item.recordId).sort()]);
        for (const item of fresh) db.prepare("INSERT INTO seen_events VALUES(?,?,?)").run(row.id, item.recordId, item.observedAt);
        row.totalEvents += fresh.length;
        row.lastEventAt = [row.lastEventAt, ...fresh.map(item => item.observedAt)].filter(Boolean).sort().at(-1);
      }
      row.window.pages += 1;
      if (pending.nextCursor) {
        if (row.window.cursors.includes(pending.nextCursor) || row.window.pages > 10000) fail("Pagination repeated or exceeded the safety limit. The checkpoint has not advanced.", 422);
        row.window.cursors.push(pending.nextCursor); row.window.cursor = pending.nextCursor;
      } else {
        row.completedThrough = row.window.end; row.window = null; row.lastSuccessAt = iso(now());
        if (row.failureSince) alert(row, "collection-recovered", "Collection recovered", row.displayName + ": a complete collection window succeeded. Review any gap since the previous success; late events beyond the five-minute overlap are not guaranteed.", null, ["recovery", row.failureSince]);
        row.failureSince = null; row.lastError = null; row.failures = 0;
      }
      row.pending = null; put(row);
    })();
  }
  async function collect(id, signal) {
    let row = get(id); if (!row?.enabled || !row.nextPollAt || Date.parse(row.nextPollAt) > now()) return;
    const revision = row.revision;
    try {
      if (!row.provisioning) provision(row);
      if (now() - Date.parse(row.completedThrough || row.coverageStartAt) > LIMITS.maxCatchupDays * DAY) fail("Collection gap exceeds six days. Preserve this history and reconnect to begin an explicitly new coverage period.", 409);
      if (!row.window) {
        const end = Math.min(now() - 30000, Date.parse(row.completedThrough || row.coverageStartAt) + 60 * MINUTE);
        row.window = { start: iso(Math.max(Date.parse(row.coverageStartAt), Date.parse(row.completedThrough || row.coverageStartAt) - 5 * MINUTE)), end: iso(end), cursor: null, cursors: [], pages: 0 };
        put(row);
      }
      for (let page = 0; page < LIMITS.pagesPerPass; page += 1) {
        row.lastAttemptAt = iso(now()); put(row);
        if (!row.pending) {
          const secrets = unseal(row.id, row.sealed);
          const result = await transport.fetchSentryPage({ config: row.config, token: secrets.token, start: row.window.start, end: row.window.end,
            cursor: row.window.cursor, fetchImpl, signal });
          row = active(id, revision, signal); if (!row) return;
          provision(row);
          row.pending = createPending(row, result.events, result.nextCursor); put(row);
        }
        if (!active(id, revision, signal)) return;
        commitPending(row);
        if (!row.window) break;
      }
      row.nextPollAt = iso(now() + (row.window || now() - Date.parse(row.completedThrough) > 5 * MINUTE ? 5000 : MINUTE)); put(row);
      updateSourceHealth(row, row.window || now() - Date.parse(row.completedThrough) > 5 * MINUTE ? "degraded" : "healthy");
    } catch (error) {
      row = active(id, revision, signal); if (!row) return;
      row.failures = Math.min((row.failures || 0) + 1, 10);
      const backoff = Math.max(Math.min(MINUTE * 2 ** (row.failures - 1), 60 * MINUTE), Number(error.retryAfterMs) || 0);
      row.nextPollAt = scheduledAt(now(), backoff);
      row.lastError = error.name === "LiveTransportError" ? safeTransportMessage(error) : "Collection could not complete. Check source lifecycle, retained state capacity, credentials and the coverage window. No checkpoint was skipped.";
      if (!row.nextPollAt) row.lastError = "The vendor requested a retry delay beyond the supported calendar. Collection is blocked; the delay was not shortened.";
      row.failureSince ||= iso(now()); put(row);
      try { alert(row, "collection-failed", "Collection needs attention", row.displayName + ": " + row.lastError, null, ["failure", row.failureSince]); } catch { /* Capacity failure is still visible on the connection. */ }
      try { updateSourceHealth(row, "degraded"); } catch { /* An independently disabled source must not be revived. */ }
    }
  }
  function safeTransportMessage(error) {
    if (error.status === 401 || error.status === 403) return "Sentry denied access. Replace the read-only token or correct its project permissions.";
    if (error.status === 429) return "Sentry rate limited collection. The saved retry delay will be respected.";
    return "The vendor request or response validation failed. Collection is not verified; retry is scheduled without skipping the checkpoint.";
  }
  async function deliver(id, signal) {
    let row = get(id); if (!row?.hasSlack || row.notificationRetryBlocked || (row.notificationNextAt && Date.parse(row.notificationNextAt) > now())) return;
    const item = db.prepare("SELECT data FROM alerts WHERE connection_id=? AND json_extract(data,'$.deliveryState')='pending' AND json_extract(data,'$.nextAttemptAt')<=? ORDER BY created_at,id LIMIT 1").get(id, iso(now()));
    if (!item) return;
    const value = JSON.parse(item.data), revision = row.revision;
    if (value.attempts >= 10) {
      value.deliveryState = "blocked"; db.prepare("UPDATE alerts SET data=? WHERE id=?").run(JSON.stringify(value), value.id);
      row.notificationError = "Slack delivery exhausted ten attempts. Review the destination and explicitly retry blocked notifications."; put(row); return;
    }
    value.attempts += 1; db.prepare("UPDATE alerts SET data=? WHERE id=?").run(JSON.stringify(value), value.id);
    try {
      const { slackWebhook } = unseal(id, row.sealed);
      await transport.sendSlack({ webhook: slackWebhook, text: value.title + "\n" + value.body + "\nSource: " + row.sourceId + "\nAlert: " + value.id + (value.evidence ? "\nEvidence record: " + value.evidence.recordId + "\nSentry event: " + value.evidence.vendorEventId : ""), fetchImpl, signal });
      row = get(id); if (closed || signal.aborted || !row || row.revision !== revision) return;
      value.deliveryState = "delivered"; value.deliveredAt = iso(now()); row.notificationError = null; row.notificationNextAt = iso(now() + 1000);
    } catch (error) {
      row = get(id); if (closed || signal.aborted || !row || row.revision !== revision) return;
      value.deliveryState = error.retryable === true && value.attempts < 10 ? "pending" : "blocked";
      value.nextAttemptAt = scheduledAt(now(), Math.max(MINUTE * 2 ** Math.min(value.attempts - 1, 6), Number(error.retryAfterMs) || 0));
      if (!value.nextAttemptAt) { value.deliveryState = "blocked"; row.notificationRetryBlocked = true; }
      row.notificationError = "Slack delivery failed. Inspect the destination, rotate its webhook if needed, then retry blocked notifications.";
      row.notificationNextAt = value.nextAttemptAt;
    }
    // Preserve acknowledgements submitted while the network request was pending.
    const current = db.prepare("SELECT data FROM alerts WHERE id=?").get(value.id);
    if (current) { value.acknowledgedAt = JSON.parse(current.data).acknowledgedAt; db.prepare("UPDATE alerts SET data=? WHERE id=?").run(JSON.stringify(value), value.id); }
    put(row);
  }
  function startJob(id) {
    if (closed || jobs.has(id) || jobs.size >= 2) return jobs.get(id)?.promise || Promise.resolve();
    const controller = new AbortController();
    const promise = Promise.resolve().then(async () => { await collect(id, controller.signal); if (!controller.signal.aborted) await deliver(id, controller.signal); })
      .catch(() => { /* Connection retains its prior checkpoint; stale health ages visibly. */ }).finally(() => jobs.delete(id));
    jobs.set(id, { controller, promise }); return promise;
  }
  function tick() {
    if (closed) return;
    const available = rows(), start = (available.findIndex(item => item.id === lastScheduledId) + 1) % (available.length || 1);
    for (let offset = 0; offset < available.length && jobs.size < 2; offset += 1) {
      const item = available[(start + offset) % available.length];
      if (jobs.has(item.id)) continue;
      const row = JSON.parse(item.data);
      const notificationDue = row.hasSlack && !row.notificationRetryBlocked && (!row.notificationNextAt || Date.parse(row.notificationNextAt) <= now())
        && db.prepare("SELECT 1 FROM alerts WHERE connection_id=? AND json_extract(data,'$.deliveryState')='pending' AND json_extract(data,'$.nextAttemptAt')<=? LIMIT 1").get(row.id, iso(now()));
      if ((row.enabled && row.nextPollAt && Date.parse(row.nextPollAt) <= now()) || notificationDue) {
        lastScheduledId = row.id; startJob(row.id);
      }
    }
  }
  // Validate encrypted state on startup; never silently replace a lost key.
  try { validateJournal(db, runtime, unseal); }
  catch { db.close(); key.fill(0); fail("Monitoring recovery journal is invalid or exceeds its supported bounds. Restore a trusted backup.", 503); }
  if (autoStart) { timer = setInterval(tick, 1000); timer.unref(); }
  return {
    list({ offset = 0, limit = 100 } = {}) {
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > LIMITS.alerts || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail("Invalid alert pagination.");
      const total = db.prepare("SELECT COUNT(*) AS n FROM alerts").get().n;
      return { schemaVersion: "1", connections: rows().map(item => publicConnection(get(item.id))), alerts: db.prepare("SELECT data FROM alerts ORDER BY created_at DESC,id LIMIT ? OFFSET ?").all(limit, offset).map(item => JSON.parse(item.data)),
        totalAlerts: total, offset, nextOffset: offset + limit < total ? offset + limit : null, limits: LIMITS };
    },
    async connect(input, who) {
      human(who);
      exact(input, ["appId", "environment", "displayName", "region", "organization", "project", "token", "slackWebhook"]);
      if (creating) fail("Another connection is being tested. Retry shortly.", 409);
      if (rows().length >= LIMITS.connections) fail("This private collector supports at most twenty live connections.", 409);
      const config = validateCredential(() => transport.validateSentryConfig({ region: input.region, organization: input.organization, project: input.project }));
      const token = validateCredential(() => transport.validateToken(input.token)), slackWebhook = input.slackWebhook ? validateCredential(() => transport.validateSlackWebhook(input.slackWebhook)) : null;
      const displayName = label(input.displayName), application = runtime.controlState().apps.find(item => item.appId === input.appId);
      if (!application || !(application.environments || ["default"]).includes(input.environment)) fail("Choose a registered application and one of its declared environments.");
      if (rows().some(item => { const row = JSON.parse(item.data); return row.appId === input.appId && row.environment === input.environment && JSON.stringify(row.config) === JSON.stringify(config); })) fail("This project is already connected to that application environment.", 409);
      creating = true;
      try {
        const start = iso(now() - 15 * MINUTE), end = iso(now() - 30000);
        const result = await transport.fetchSentryPage({ config, token, start, end, fetchImpl });
        // Validate the real payload before creating any source or storing a key.
        if (result.events.length) normalizeVendorPayload("sentry-events", result.events, { sourceId: "connection-test", estateId: input.appId });
        const id = "monitor-" + crypto.randomUUID();
        const row = { id, sourceId: null, provisioning: true, appId: input.appId, environment: input.environment, displayName, config, enabled: true, revision: 1,
          createdAt: iso(now()), coverageStartAt: start, completedThrough: null, window: { start, end, cursor: null, cursors: [], pages: 0 }, pending: null,
          lastAttemptAt: null, lastSuccessAt: null, lastEventAt: null, nextPollAt: iso(now()), lastError: null, failureSince: null, failures: 0, totalEvents: 0,
          hasSlack: Boolean(slackWebhook), notificationError: null, notificationNextAt: null };
        const sealed = seal(id, { token, slackWebhook });
        db.prepare("INSERT INTO connections VALUES(?,?,?)").run(id, JSON.stringify(row), sealed); row.sealed = sealed;
        audit(id, "connect", who); provision(row);
        row.pending = createPending(row, result.events, result.nextCursor); put(row);
        if (autoStart) void startJob(id);
        return { connection: publicConnection(get(id)) };
      } catch (error) {
        if (error.name === "LiveTransportError") fail(safeTransportMessage(error), 422, "connection-test-failed");
        throw error;
      } finally { creating = false; }
    },
    async change(id, action, input, who) {
      human(who);
      exact(input, action === "credentials" ? ["expectedRevision", "token", "slackWebhook"] : ["expectedRevision"]);
      const row = checked(id, input.expectedRevision);
      if (action === "poll") {
        if (!row.enabled) fail("Resume this collector before polling.", 409);
        if (!row.nextPollAt) fail("Vendor cooldown blocks this collector. Review its health before reconnecting.", 409);
        void startJob(id); return { connection: publicConnection(get(id)), queued: true };
      }
      if (action === "test-notification") {
        if (!row.hasSlack) fail("Configure Slack before requesting a test.", 409);
        if (row.lastTestAt && now() - Date.parse(row.lastTestAt) < MINUTE) fail("Wait one minute between notification tests.", 429);
        row.lastTestAt = iso(now()); put(row);
        alert(row, "notification-test", "Monitoring notification test", "This is an explicitly requested notification test. It does not prove that collection is healthy.", null, ["test", row.lastTestAt]);
        if (autoStart) void startJob(id);
        return { connection: publicConnection(get(id)) };
      }
      jobs.get(id)?.controller.abort();
      if (action === "remove") {
        const source = runtime.controlState().sources.find(item => item.sourceId === row.sourceId);
        if (source && !["archived", "removed"].includes(source.state)) command(row, "source.archive", { sourceId: source.sourceId, connectorInstanceId: source.connectorInstanceId, expectedRevision: source.revision });
        db.transaction(() => {
          for (const item of db.prepare("SELECT id,data FROM alerts WHERE connection_id=?").all(id)) {
            const value = JSON.parse(item.data); if (["pending", "blocked"].includes(value.deliveryState)) { value.deliveryState = "cancelled"; db.prepare("UPDATE alerts SET data=? WHERE id=?").run(JSON.stringify(value), item.id); }
          }
          db.prepare("DELETE FROM connections WHERE id=?").run(id); db.prepare("DELETE FROM seen_events WHERE connection_id=?").run(id); audit(id, action, who);
        })();
        return { removed: true, sourceId: row.sourceId };
      }
      if (action === "pause") row.enabled = false;
      else if (action === "resume") row.enabled = true;
      else if (action === "credentials") {
        const secrets = unseal(id, row.sealed);
        if (input.token !== undefined) secrets.token = validateCredential(() => transport.validateToken(input.token));
        if (input.slackWebhook !== undefined) secrets.slackWebhook = input.slackWebhook === "" ? null : validateCredential(() => transport.validateSlackWebhook(input.slackWebhook));
        if (input.token === undefined && input.slackWebhook === undefined) fail("Supply a replacement token or Slack webhook.");
        row.sealed = seal(id, secrets); row.hasSlack = Boolean(secrets.slackWebhook);
        if (!row.hasSlack) for (const item of db.prepare("SELECT id,data FROM alerts WHERE connection_id=?").all(id)) {
          const value = JSON.parse(item.data); if (["pending", "blocked"].includes(value.deliveryState)) { value.deliveryState = "cancelled"; db.prepare("UPDATE alerts SET data=? WHERE id=?").run(JSON.stringify(value), item.id); }
        }
      } else if (action === "retry-notifications") {
        if (!row.hasSlack) fail("Configure Slack first.", 409);
        if (row.notificationRetryBlocked) fail("The vendor retry delay is beyond the supported calendar. Delivery remains blocked.", 409);
        for (const item of db.prepare("SELECT id,data FROM alerts WHERE connection_id=?").all(id)) {
          const value = JSON.parse(item.data); if (value.deliveryState === "blocked") { value.deliveryState = "pending"; value.attempts = 0; db.prepare("UPDATE alerts SET data=? WHERE id=?").run(JSON.stringify(value), item.id); }
        }
      } else fail("Unsupported monitoring action.", 405);
      row.revision += 1; put(row); audit(id, action, who);
      return { connection: publicConnection(row) };
    },
    acknowledge(id, who) {
      human(who);
      const item = db.prepare("SELECT data FROM alerts WHERE id=?").get(id); if (!item) fail("Alert not found.", 404);
      const value = JSON.parse(item.data); value.acknowledgedAt ||= iso(now()); db.prepare("UPDATE alerts SET data=? WHERE id=?").run(JSON.stringify(value), id);
      audit(value.connectionId, "alert.acknowledge", who); return { alert: value };
    },
    async runOnce() { for (const row of rows()) await startJob(row.id); },
    async close() { if (closed) return; closed = true; clearInterval(timer); for (const item of jobs.values()) item.controller.abort(); await Promise.all([...jobs.values()].map(item => item.promise)); db.close(); key.fill(0); }
  };
}

async function handleLiveMonitoring(request, response, url, monitoring, actor) {
  if (request.method === "GET" && url.pathname === BASE) {
    const options = {};
    for (const [name, value] of url.searchParams) {
      if (!["offset", "limit"].includes(name) || Object.hasOwn(options, name) || !/^(0|[1-9][0-9]*)$/.test(value)) fail("Invalid monitoring query.");
      options[name] = Number(value);
    }
    sendJson(response, 200, monitoring.list(options)); return;
  }
  if (url.search) fail("Monitoring mutations do not accept query parameters.");
  if (request.method !== "POST") fail("Unsupported monitoring method.", 405);
  const { value } = await readJsonBody(request, 16384);
  if (url.pathname === BASE + "/connections") { sendJson(response, 201, await monitoring.connect(value, actor)); return; }
  const connection = /^\/api\/v1\/monitoring\/connections\/(monitor-[a-f0-9-]{36})\/(poll|pause|resume|remove|credentials|test-notification|retry-notifications)$/.exec(url.pathname);
  if (connection) { sendJson(response, 200, await monitoring.change(connection[1], connection[2], value, actor)); return; }
  const ack = /^\/api\/v1\/monitoring\/alerts\/(alert-[a-f0-9]{64})\/ack$/.exec(url.pathname);
  if (ack) { exact(value, []); sendJson(response, 200, monitoring.acknowledge(ack[1], actor)); return; }
  fail("Monitoring endpoint not found.", 404);
}
module.exports = { createLiveMonitoring, handleLiveMonitoring, MONITORING_BASE: BASE, LIMITS };
