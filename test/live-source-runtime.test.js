"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ReferenceControlPlane, LIVE_SENTRY_HEALTH_MESSAGES } = require("../server/reference-runtime");
const { SqliteTelemetryStore } = require("../server/sqlite-telemetry-store");
const { vendorManifest, normalizeVendorPayload } = require("../tools/vendor-adapters");
const { runAsOperator, runAsService, operatorId } = require("../server/operator-context");

const START = "2026-09-29T12:00:00.000Z";
const collector = callback => runAsOperator("live-monitor:synthetic-connection", callback);
function fixture(t, { altered = false } = {}) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "bb-soc-live-runtime-"));
  let current = Date.parse(START), sequence = 0;
  const clock = () => new Date(current);
  const open = () => new ReferenceControlPlane({ clock, store: new SqliteTelemetryStore({ directory, clock }),
    enabledConnectorTypes: ["canonical-push", "canonical-events", "trivy-report"] });
  const f = { directory, runtime: open(), now: () => clock().toISOString(), advance: milliseconds => { current += milliseconds; } };
  t.after(() => { f.runtime.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  f.reopen = () => { f.runtime.dispose(); f.runtime = open(); };
  f.command = (command, input) => collector(() => f.runtime.execute({ schemaVersion: "1", documentType: "connector-command-request",
    requestId: "live-runtime-command-" + (++sequence), command, requestedAt: f.now(), input }));
  const manifest = structuredClone(vendorManifest("sentry-events"));
  if (altered) manifest.displayName = "A different Sentry declaration";
  collector(() => f.runtime.installIntegration({ manifest, expectedRevision: 0 }));
  const app = f.command("app.register", { displayName: "Synthetic live application", environments: ["test"], publicPages: [] });
  assert.equal(app.status, "succeeded");
  const setup = f.command("source.setup", { appId: app.output.appId, environment: "test", connectorType: "vendor.sentry-events",
    sourceKind: "sentry-events", displayName: "Synthetic live Sentry", config: { "cadence-seconds": 60 }, credentialReferences: [] });
  assert.equal(setup.status, "succeeded");
  f.identity = { ...setup.output, appId: app.output.appId };
  f.source = () => f.runtime.controlState().sources.find(item => item.sourceId === f.identity.sourceId);
  f.input = () => ({ sourceId: f.identity.sourceId, connectorInstanceId: f.identity.connectorInstanceId, expectedRevision: f.source().revision });
  f.activate = () => collector(() => f.runtime.activateLiveSentrySource(f.identity.sourceId));
  f.healthInput = state => ({ state, lastAttemptAt: f.now(),
    lastSuccessAt: state === "healthy" ? f.now() : f.source().health.lastSuccessAt,
    nextExpectedAt: new Date(current + 60000).toISOString() });
  f.health = (state, overrides = {}) => collector(() => f.runtime.updateLiveSentryHealth(f.identity.sourceId, { ...f.healthInput(state), ...overrides }));
  f.batch = (...ids) => normalizeVendorPayload("sentry-events", ids.map(id => ({ eventID: String(id).padStart(32, "0"),
    dateCreated: START, type: "error", platform: "node", level: "error" })), { sourceId: f.identity.sourceId, estateId: f.identity.appId });
  f.ingest = normalized => collector(() => f.runtime.ingestVendorAsOperator(normalized.batch, normalized.bodyHash, "sentry-events"));
  return f;
}

test("live activation requires operator authority and exact configured preset, without sample events or unused credentials", t => {
  const f = fixture(t);
  assert.throws(() => f.runtime.activateLiveSentrySource(f.identity.sourceId), error => error.status === 403);
  assert.throws(() => runAsService("agent", () => f.runtime.activateLiveSentrySource(f.identity.sourceId)), error => error.status === 403);
  assert.throws(() => collector(() => f.runtime.activateLiveSentrySource("source-missing")), error => error.status === 403);
  assert.equal(f.command("source.test", f.input()).status, "failed", "Public source tests still require a real record sample.");
  const before = f.runtime.store.stats(), activated = f.activate();
  assert.equal(activated.state, "active");
  assert.equal(activated.health.state, "pending");
  assert.equal(activated.health.lastSuccessAt, null, "An access test is not a completed collection window.");
  assert.equal(activated.oneTimeCredential, undefined);
  assert.deepEqual(f.runtime.controlState().sourceCredentials, []);
  assert.equal(f.runtime.store.stats().records, 0);
  assert.equal(f.runtime.store.stats().receipts, 0);
  assert.equal(f.runtime.store.stats().auditRows, before.auditRows + 1);
  const audit = JSON.parse(f.runtime.store.db.prepare("SELECT json FROM telemetry_audit ORDER BY revision DESC LIMIT 1").get().json);
  assert.equal(audit.action, "source.live-sentry.activate");
  assert.equal(audit.actor, operatorId("live-monitor:synthetic-connection"));
  assert.match(audit.detail, /trusted live collector validated read-only Sentry access/);
  assert.match(audit.detail, /without a source-ingest credential/);
  assert.throws(() => f.activate(), error => error.status === 409);
  activated.displayName = "Changed outside state";
  assert.notEqual(f.source().displayName, activated.displayName, "Returned source metadata is a detached copy.");
  assert.throws(() => f.command("source.live-sentry.activate", f.input()), /command/);
});

test("lookalike custom declarations and disabled admission cannot gain live activation", t => {
  const altered = fixture(t, { altered: true });
  assert.throws(() => altered.activate(), error => error.status === 403);
  assert.equal(altered.source().state, "configured");
  const f = fixture(t);
  f.runtime.enabledConnectorTypes.delete("canonical-events");
  assert.throws(() => f.activate(), error => error.code === "connector-unavailable");
  assert.equal(f.source().state, "configured");
});

test("a successfully checked quiet window is healthy without invented events, receipts, or delivery counters and ages after polling stops", t => {
  const f = fixture(t); f.activate(); f.advance(60000);
  const counters = f.source().health.counters;
  const healthy = f.health("healthy");
  assert.equal(healthy.health.lastAttemptAt, f.now());
  assert.equal(healthy.health.lastSuccessAt, f.now());
  assert.equal(healthy.health.message, LIVE_SENTRY_HEALTH_MESSAGES.healthy);
  assert.deepEqual(healthy.health.counters, counters);
  assert.equal(f.runtime.store.stats().records, 0);
  assert.equal(f.runtime.store.stats().receipts, 0);
  assert.equal(f.runtime.getSnapshot({ schemaVersion: "1", reason: "refresh" }).sources[0].health.state, "healthy");
  const sources = f.runtime.readPage("/sources", {});
  assert.ok(JSON.stringify(sources).includes('"label":"healthy"'));
  assert.match(sources.summary, /0 canonical log events retained/);
  f.reopen();
  assert.deepEqual(f.source(), healthy);
  f.advance(121000);
  assert.equal(f.runtime.getSnapshot({ schemaVersion: "1", reason: "refresh" }).sources[0].health.state, "stale");
  f.advance(60000);
  assert.equal(f.runtime.getSnapshot({ schemaVersion: "1", reason: "refresh" }).sources[0].health.state, "offline");
  assert.ok(JSON.stringify(f.runtime.readPage("/sources", {})).includes('"label":"offline"'));
});

test("failed collection cannot be presented as healthy by recent event timestamps", t => {
  const f = fixture(t); f.activate(); f.health("healthy"); f.advance(1000);
  const before = f.source().health.lastSuccessAt;
  f.health("offline");
  assert.equal(f.source().health.lastSuccessAt, before);
  assert.equal(f.runtime.getSnapshot({ schemaVersion: "1", reason: "refresh" }).sources[0].health.state, "offline");
  assert.ok(JSON.stringify(f.runtime.readPage("/sources", {})).includes('"label":"offline"'));
  f.advance(1000); f.health("degraded");
  assert.ok(JSON.stringify(f.runtime.readPage("/sources", {})).includes('"label":"degraded"'));
});

test("successful completion after a request start retains real completion time within the existing source health contract", t => {
  const f = fixture(t); f.activate(); const started = f.now(); f.advance(2500);
  const updated = f.health("healthy", { lastAttemptAt: started });
  assert.equal(updated.health.lastSuccessAt, f.now());
  assert.equal(updated.health.lastAttemptAt, f.now(), "Source health observes the successful attempt at completion; monitoring keeps its separate start time.");
  assert.equal(updated.health.counters.receivedRecords, 0);
  assert.equal(f.runtime.store.stats().records, 0);
});

test("health after a slow admitted page records completion without rejecting its earlier collection start", t => {
  const f = fixture(t); f.activate(); const started = f.now(); f.advance(2500);
  f.ingest(f.batch(1));
  const updated = f.health("healthy", { lastAttemptAt: started });
  assert.equal(updated.health.lastSuccessAt, f.now());
  assert.equal(updated.health.lastAttemptAt, f.now());
  assert.equal(updated.health.counters.acceptedRecords, 1);
  f.advance(60000); const failedStart = f.now(); f.advance(2500); f.ingest(f.batch(2));
  const failed = f.health("degraded", { lastAttemptAt: failedStart });
  assert.equal(failed.health.state, "degraded");
  assert.equal(failed.health.lastSuccessAt, f.now(), "The preceding real page delivery remains separately true during incomplete collection.");
});

test("health authority, schema, monotonic timestamps and fixed safe messages reject invalid mutations atomically", t => {
  const f = fixture(t); f.activate(); f.health("healthy"); f.advance(60000);
  assert.throws(() => f.runtime.updateLiveSentryHealth(f.identity.sourceId, f.healthInput("healthy")), error => error.status === 403);
  assert.throws(() => runAsService("agent", () => f.runtime.updateLiveSentryHealth(f.identity.sourceId, f.healthInput("healthy"))), error => error.status === 403);
  const before = f.runtime.getState(), audit = f.runtime.store.stats().auditRows;
  const invalid = [null, [], { state: "healthy" }, { ...f.healthInput("healthy"), state: "unknown" },
    { ...f.healthInput("healthy"), message: "Arbitrary upstream error or secret" },
    { ...f.healthInput("healthy"), unexpected: true }, { ...f.healthInput("healthy"), lastAttemptAt: null },
    { ...f.healthInput("healthy"), lastAttemptAt: "2026-09-29T12:00:01Z" },
    { ...f.healthInput("healthy"), lastAttemptAt: "2026-09-29T11:59:59.000Z" },
    { ...f.healthInput("healthy"), lastSuccessAt: START },
    { ...f.healthInput("healthy"), lastAttemptAt: "2026-09-29T12:02:00.000Z", lastSuccessAt: "2026-09-29T12:02:00.000Z" },
    { ...f.healthInput("healthy"), nextExpectedAt: START },
    { ...f.healthInput("degraded"), lastSuccessAt: f.now() },
    { ...f.healthInput("degraded"), lastSuccessAt: null },
    Object.defineProperty({ ...f.healthInput("healthy") }, "message", { get() { throw new Error("accessor invoked"); } })];
  for (const input of invalid) assert.throws(() => collector(() => f.runtime.updateLiveSentryHealth(f.identity.sourceId, input)), error => error.status === 422);
  assert.deepEqual(f.runtime.getState(), before);
  assert.equal(f.runtime.store.stats().auditRows, audit);
});

test("external lifecycle changes fence both live health and normal vendor admission", t => {
  const f = fixture(t); f.activate(); const pending = f.batch(1);
  assert.equal(f.command("source.pause", f.input()).status, "succeeded");
  assert.throws(() => f.health("healthy"), error => error.status === 409);
  assert.throws(() => f.ingest(pending), error => error.status === 409);
  assert.equal(f.command("source.archive", f.input()).status, "succeeded");
  assert.throws(() => f.activate(), error => error.status === 409);
  assert.throws(() => f.health("offline"), error => error.status === 409);
  assert.equal(f.command("source.remove", f.input()).status, "succeeded");
  assert.throws(() => f.health("healthy"), error => error.status === 409);
  assert.equal(f.runtime.store.stats().records, 0);
});

test("admit-before-checkpoint replay and overlapping pages deduplicate after restart while retaining true event times", t => {
  const f = fixture(t); f.activate();
  const first = f.batch(1, 2);
  const original = f.ingest(first);
  assert.equal(original.accepted, 2);
  f.reopen(); f.advance(60000);
  const replay = f.ingest(first);
  assert.equal(replay.replay, true); assert.equal(replay.receivedAt, original.receivedAt);
  const overlap = f.ingest(f.batch(2, 3));
  assert.equal(overlap.accepted, 1); assert.equal(overlap.duplicates, 1);
  const records = f.runtime.getState().records, counters = f.source().health.counters;
  f.advance(60000); f.health("healthy");
  assert.deepEqual(f.runtime.getState().records, records);
  assert.ok(records.every(record => record.observedAt === START));
  assert.deepEqual(f.source().health.counters, counters);
  assert.equal(counters.acceptedRecords, 3);
  assert.equal(f.runtime.store.stats().records, 3);
  f.advance(8 * 86400000);
  assert.throws(() => f.ingest(first), error => error.code === "validation-failed");
});

test("live activation and health audit failures roll back source changes", t => {
  const f = fixture(t), before = f.runtime.getState();
  const deny = () => f.runtime.store.db.exec("CREATE TEMP TRIGGER reject_live_audit BEFORE INSERT ON telemetry_audit BEGIN SELECT RAISE(ABORT, 'live rollback'); END");
  const allow = () => f.runtime.store.db.exec("DROP TRIGGER reject_live_audit");
  deny(); assert.throws(() => f.activate(), /live rollback/); assert.deepEqual(f.runtime.getState(), before); allow();
  f.activate(); const active = f.runtime.getState();
  deny(); assert.throws(() => f.health("healthy"), /live rollback/); assert.deepEqual(f.runtime.getState(), active); allow();
});
