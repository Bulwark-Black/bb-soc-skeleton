"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ReferenceControlPlane } = require("../server/reference-runtime");
const { SqliteTelemetryStore } = require("../server/sqlite-telemetry-store");
const { createCollectionRecord, validateCollectionRecord } = require("../tools/log-collection-contract");
const { validateIngestBatch } = require("../tools/ingest-contract");
const START = "2026-09-29T12:00:00.000Z";
const digest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

function fixture(t, type = "server-log-push") {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "bb-server-log-test-"));
  let current = Date.parse(START), sequence = 0;
  const clock = () => new Date(current);
  const open = () => new ReferenceControlPlane({ clock, store: new SqliteTelemetryStore({ directory, clock }), enabledConnectorTypes: ["canonical-push", "canonical-events"] });
  const f = { directory, runtime: open(), now: () => clock().toISOString(), advance: amount => { current += amount; } };
  t.after(() => { f.runtime.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  f.reopen = () => { f.runtime.dispose(); f.runtime = open(); };
  f.command = (command, input) => f.runtime.execute({ schemaVersion: "1", documentType: "connector-command-request",
    requestId: "server-log-command-" + (++sequence), command, requestedAt: f.now(), input });
  const app = f.command("app.register", { displayName: "Synthetic log application", environments: ["test"], publicPages: [] });
  assert.equal(app.status, "succeeded");
  const setup = f.command("source.setup", { appId: app.output.appId, environment: "test", connectorType: type,
    sourceKind: type === "server-log-push" ? "server.log" : "log.event", displayName: "Synthetic server logs",
    config: { "cadence-seconds": 60 }, credentialReferences: [] });
  assert.equal(setup.status, "succeeded");
  f.identity = { ...setup.output, appId: app.output.appId };
  f.source = () => f.runtime.controlState().sources.find(source => source.sourceId === f.identity.sourceId);
  f.input = () => ({ sourceId: f.identity.sourceId, connectorInstanceId: f.identity.connectorInstanceId, expectedRevision: f.source().revision });
  f.proof = (changes = {}) => createCollectionRecord({ sourceId: f.identity.sourceId, estateId: f.identity.appId,
    recordId: "collection-proof-" + (++sequence), observedAt: f.now(), inputsPlanned: 1, inputsRead: 1,
    linesRead: 0, linesDropped: 0, ok: true, error: null, ...changes });
  f.log = (changes = {}) => ({ schemaVersion: "1", documentType: "normalized-record", sourceId: f.identity.sourceId, estateId: f.identity.appId,
    recordId: "synthetic-log-" + (++sequence), kind: "log.event", observedAt: f.now(),
    payload: { title: "Synthetic server event", state: "unknown", message: "Synthetic redacted event" }, ...changes });
  const tested = f.command("source.test", { ...f.input(), ...(type === "canonical-events" ? { recordSample: f.log() } : { sample: { message: "Synthetic redacted sample" } }) });
  assert.equal(tested.status, "succeeded");
  const activated = f.command("source.activate", f.input()); assert.equal(activated.status, "succeeded");
  f.identity.credential = activated.output.oneTimeCredential.value;
  f.batch = (records, changes = {}) => ({ schemaVersion: "1", documentType: "ingest-batch", sourceId: f.identity.sourceId,
    receiptId: "server-log-receipt-" + (++sequence), sentAt: f.now(), records, ...changes });
  f.ingest = batch => f.runtime.ingest(batch, f.identity.credential, digest(batch));
  f.health = () => f.runtime.getSnapshot({ schemaVersion: "1", reason: "refresh" }).sources[0].health;
  return f;
}

test("collection proof requires exact version, counters and consistent outcomes without arbitrary fields", () => {
  const args = { sourceId: "synthetic-source", estateId: "synthetic-app", recordId: "synthetic-proof", observedAt: START,
    inputsPlanned: 1, inputsRead: 1, linesRead: 0, linesDropped: 0, ok: true, error: null };
  const proof = createCollectionRecord(args); assert.equal(validateCollectionRecord(proof).payload.state, "ok");
  for (const patch of [{ inputsPlanned: 0 }, { inputsPlanned: 100001 }, { inputsRead: 2 }, { linesRead: -1 },
    { linesRead: Number.MAX_SAFE_INTEGER + 1 }, { linesDropped: 1 }, { ok: false }, { inputsRead: 0, ok: false },
    { linesDropped: 1, ok: false }, { error: "unknown" }, { error: "input-unavailable" }]) {
    assert.throws(() => createCollectionRecord({ ...args, ...patch }));
  }
  for (const change of [p => { p.payload.summary = "Unrecognized"; }, p => { p.payload.summary = undefined; },
    p => { p.payload.fields.unrecognized = 1; }, p => { p.payload.fields.collectorSchemaVersion = 2; },
    p => { p.payload.state = "active"; }, p => { p.kind = "log.event"; p.payload.message = "Wrong kind"; }]) {
    const altered = structuredClone(proof); change(altered); assert.throws(() => validateCollectionRecord(altered));
  }
  assert.equal(createCollectionRecord({ ...args, inputsRead: 0, ok: false, error: "input-unavailable" }).payload.state, "failed");
});

test("a real quiet read is healthy with zero log events, persists and exposes separate read/delivery/activity times", t => {
  const f = fixture(t); f.advance(1000); const proof = f.proof(); f.advance(1000);
  const receipt = f.ingest(f.batch([proof])); assert.equal(receipt.accepted, 1);
  assert.equal(f.source().health.lastSuccessAt, proof.observedAt);
  assert.equal(f.source().health.lastAttemptAt, proof.observedAt);
  assert.equal(f.health().state, "healthy");
  assert.equal(f.runtime.store.logSummary().count, 0);
  assert.equal(f.runtime.readPage("/logs", {}).state, "empty");
  for (const route of ["/sources", "/health"]) {
    const page = f.runtime.readPage(route, {}), panel = page.panels.find(item => item.id === "server-log-collection-status");
    assert.equal(panel.rows[0][1].value, proof.observedAt);
    assert.equal(panel.rows[0][2].value, proof.observedAt);
    assert.equal(panel.rows[0][3].value, receipt.receivedAt);
    assert.equal(panel.rows[0][4], "No retained log events");
    assert.equal(panel.rows[0][5].value, 0);
    assert.match(JSON.stringify(page), /0 log events/);
  }
  const before = f.source(); f.reopen(); assert.deepEqual(f.source(), before);
  f.advance(90000); assert.equal(f.health().state, "stale");
  f.advance(90000); assert.equal(f.health().state, "offline");
  assert.equal(f.runtime.readPage("/health", {}).panels[0].items[1].value, 0);
});

test("event chunks and both receipt and record replay cannot establish or refresh collection health", t => {
  const f = fixture(t); f.ingest(f.batch([f.log()]));
  assert.equal(f.health().state, "pending"); assert.equal(f.source().health.lastSuccessAt, null);
  f.advance(1000); const proof = f.proof(), batch = f.batch([proof]); f.ingest(batch);
  const healthy = f.source().health;
  f.advance(200000); const beforeReplay = f.runtime.store.snapshot();
  assert.equal(f.ingest(batch).replay, true); assert.deepEqual(f.runtime.store.snapshot(), beforeReplay);
  assert.equal(f.ingest(f.batch([proof])).duplicates, 1);
  assert.equal(f.source().health.lastAttemptAt, healthy.lastAttemptAt);
  f.ingest(f.batch([f.log()]));
  assert.equal(f.source().health.lastSuccessAt, healthy.lastSuccessAt); assert.equal(f.health().state, "offline");
  const page = f.runtime.readPage("/health", {}), row = page.panels.find(p => p.id === "server-log-collection-status").rows[0];
  assert.equal(row[4].value, f.now()); assert.equal(row[2].value, healthy.lastSuccessAt);
});

test("failed and older reads never replace newer successful coverage, and delayed success ages from collection time", t => {
  const f = fixture(t); f.advance(1000); const old = f.proof(); f.advance(1000);
  f.ingest(f.batch([f.proof()])); const success = f.source().health.lastSuccessAt;
  f.advance(1000); f.ingest(f.batch([f.proof({ inputsRead: 0, ok: false, error: "input-unavailable" })]));
  assert.equal(f.health().state, "degraded"); assert.equal(f.source().health.lastSuccessAt, success);
  f.ingest(f.batch([old])); assert.equal(f.health().state, "degraded");
  f.ingest(f.batch([f.log()])); assert.equal(f.health().state, "degraded");
  const failureAt = f.source().health.lastAttemptAt;
  f.ingest(f.batch([f.proof({ observedAt: failureAt })])); assert.equal(f.health().state, "degraded", "Equal-time success cannot erase failure.");
  f.advance(1000); const delayed = f.proof(); f.advance(200000);
  f.ingest(f.batch([delayed])); assert.equal(f.source().health.lastSuccessAt, delayed.observedAt);
  assert.equal(f.health().state, "offline"); assert.equal(f.source().health.state, "offline");
  f.advance(1000); f.ingest(f.batch([f.proof()])); assert.equal(f.health().state, "healthy");
  f.ingest(f.batch([f.proof({ inputsRead: 0, ok: false, error: "input-changed" })]));
  assert.equal(f.health().state, "degraded", "Equal-time failure takes precedence over success.");
});

test("invalid or cross-bound collection proofs and paused sources cannot mutate durable telemetry", t => {
  const f = fixture(t); const unknown = structuredClone(f.proof()); unknown.payload.category = "arbitrary-heartbeat";
  const future = f.proof({ observedAt: new Date(Date.parse(f.now()) + 1000).toISOString() });
  const beforeCreation = f.proof({ observedAt: new Date(Date.parse(START) - 1000).toISOString() });
  const wrongEstate = f.proof({ estateId: "another-application" });
  const wrongSource = f.proof({ sourceId: "another-source" });
  for (const records of [[unknown], [future], [beforeCreation], [wrongEstate], [wrongSource], [f.proof(), f.proof()]]) {
    const batch = f.batch(records), before = f.runtime.store.snapshot();
    assert.throws(() => f.ingest(batch)); assert.deepEqual(f.runtime.store.snapshot(), before);
  }
  const batch = f.batch([f.proof()]), before = f.runtime.store.snapshot();
  assert.throws(() => f.runtime.ingest(batch, "not-a-source-credential", digest(batch))); assert.deepEqual(f.runtime.store.snapshot(), before);
  assert.equal(f.command("source.pause", f.input()).status, "succeeded");
  assert.throws(() => f.ingest(batch), error => error.status === 409);
  assert.equal(f.command("source.resume", f.input()).status, "succeeded");
  assert.equal(f.health().state, "pending");
});

test("collection proof, source health, receipts and audit commit together or all roll back", t => {
  const f = fixture(t); f.advance(1000); const batch = f.batch([f.log(), f.proof({ linesRead: 1 })]);
  const before = f.runtime.store.snapshot();
  f.runtime.store.db.exec("CREATE TEMP TRIGGER fail_log_test BEFORE INSERT ON telemetry_audit BEGIN SELECT RAISE(ABORT, 'synthetic log rollback'); END");
  assert.throws(() => f.ingest(batch), /synthetic log rollback/); assert.deepEqual(f.runtime.store.snapshot(), before);
  f.runtime.store.db.exec("DROP TRIGGER fail_log_test");
  assert.equal(f.ingest(batch).accepted, 2); assert.equal(f.health().state, "healthy");
  f.runtime.store.snapshot = () => { throw new Error("Full history must not be read by projections"); };
  assert.equal(f.runtime.readPage("/sources", {}).state, "ready"); assert.equal(f.runtime.readPage("/health", {}).state, "ready");
  assert.throws(() => f.runtime.store.sourceActivity(Array(201).fill(f.identity.sourceId)), /at most 200/);
});

test("the private driver supports server logs while existing canonical delivery and generic heartbeats remain unchanged", t => {
  const f = fixture(t); f.runtime.enabledConnectorTypes.delete("canonical-events");
  assert.equal(f.runtime.connectorAvailable("server-log-push"), false);
  assert.throws(() => f.ingest(f.batch([f.proof()])), error => error.code === "connector-unavailable");
  const log = fixture(t, "canonical-push"); log.ingest(log.batch([log.log()])); assert.equal(log.health().state, "healthy");
  assert.throws(() => log.ingest(log.batch([log.proof()])), error => error.code === "validation-failed");
  const generic = fixture(t, "canonical-events"), record = generic.proof();
  const batch = generic.batch([{ ...record, payload: { title: "Generic producer heartbeat", state: "unknown", category: "producer" } }]);
  validateIngestBatch(batch); generic.ingest(batch); assert.equal(generic.health().state, "healthy");
});
