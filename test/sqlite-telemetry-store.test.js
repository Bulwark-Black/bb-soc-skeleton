"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { SqliteTelemetryStore, retentionOptions } = require("../server/sqlite-telemetry-store");
const { ReferenceControlPlane } = require("../server/reference-runtime");
const { ReferenceStateStore } = require("../server/reference-store");
const { validateNormalizedRecord } = require("../tools/ingest-contract");
const { FIXTURE_TIME, createSyntheticSource, syntheticBatch, digest } = require("../tools/benchmark-private");

function directory(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "bb-soc-indexed-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function fixture(t, retention) {
  const dir = directory(t);
  let time = new Date(FIXTURE_TIME);
  const clock = () => new Date(time);
  const store = new SqliteTelemetryStore({ directory: dir, retention, clock });
  const runtime = new ReferenceControlPlane({ store, clock });
  t.after(() => runtime.dispose());
  const identity = createSyntheticSource(runtime);
  return { dir, store, runtime, identity, setTime(value) { time = new Date(value); },
    ingest(start, count, extra = {}) {
      const batch = { ...syntheticBatch(identity, start, count, time.toISOString()), ...extra };
      return { batch, receipt: runtime.ingest(batch, identity.credential, digest(batch)) };
    } };
}

test("indexed telemetry admits beyond the reference cap and projections never materialize history", (t) => {
  const { runtime, store, identity, ingest } = fixture(t);
  // Normal HTTP paths must not call the diagnostic full-history export.
  store.snapshot = () => { throw new Error("Whole-history snapshot is forbidden on request paths."); };
  for (let start = 0; start < 12_000; start += 1000) ingest(start, 1000);
  assert.equal(store.stats().records, 12_000);
  assert.equal(store.controlSnapshot().records.length, 0);
  const logs = runtime.readPage("/logs", { sourceId: identity.sourceId, q: "synthetic", limit: "12" });
  assert.match(logs.summary, /12000 canonical events matched.*12 of 12000/);
  assert.equal(logs.panels[0].rows.length, 12);
  const exact = runtime.readPage("/logs", { q: "Synthetic event 11999" });
  assert.match(exact.summary, /^1 canonical event matched/);
  const byApplication = runtime.readPage("/logs", { q: "Synthetic application / test", limit: "1" });
  assert.match(byApplication.summary, /^12000 canonical/);
  assert.throws(() => runtime.readPage("/logs", { q: "ab" }), /at least three/);
  assert.equal(runtime.readPage("/logs", { q: 'none "quoted"' }).state, "empty");
  const analytics = runtime.readPage("/analytics", { h: "24" });
  assert.equal(analytics.panels[0].items[0].value, 12_000);
  assert.equal(analytics.panels[1].series[0].values.reduce((sum, value) => sum + value, 0), 12_000);
  assert.equal(runtime.readPage("/", {}).panels[1].rows.length, 20);
  assert.match(runtime.readPage("/sources", {}).summary, /12000 canonical log events retained/);
  assert.equal(runtime.readPage("/health", {}).panels[0].items[3].value, 12_000);
});

test("receipt, records, source health, credential usage and audit roll back as one transaction", (t) => {
  const { runtime, store, identity, ingest } = fixture(t);
  const first = ingest(0, 3);
  const before = store.snapshot();
  const totals = store.stats();
  store.db.exec("CREATE TEMP TRIGGER reject_test_audit BEFORE INSERT ON telemetry_audit BEGIN SELECT RAISE(ABORT, 'synthetic rollback'); END");
  assert.throws(() => ingest(3, 2), /synthetic rollback/);
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual(store.stats(), totals);
  store.db.exec("DROP TRIGGER reject_test_audit");
  const replay = runtime.ingest(first.batch, identity.credential, digest(first.batch));
  assert.equal(replay.replay, true);
  assert.deepEqual(store.stats(), totals);
  const changed = structuredClone(first.batch); changed.records[0].payload.message = "different content";
  assert.throws(() => runtime.ingest(changed, identity.credential, digest(changed)), /receiptId was already used/);
  changed.receiptId = "synthetic-conflict";
  assert.throws(() => runtime.ingest(changed, identity.credential, digest(changed)), /recordId was already used/);
  const duplicate = { ...first.batch, receiptId: "synthetic-duplicate-records" };
  assert.equal(runtime.ingest(duplicate, identity.credential, digest(duplicate)).duplicates, 3);
  assert.equal(store.stats().records, 3);
});

test("count and byte retention keep replay identities, bounded receipts fail closed, expiry rejects old batches", (t) => {
  const f = fixture(t, { maxRecords: 3, maxReceipts: 2, replayDays: 2, recordDays: 1 });
  const original = f.ingest(0, 3);
  f.ingest(3, 2);
  assert.equal(f.store.stats().records, 3);
  assert.equal(f.store.stats().identities, 5);
  assert.equal(f.store.findRecordHash(f.identity.sourceId, original.batch.records[0].recordId), digest(validateNormalizedRecord(original.batch.records[0])));
  assert.equal(f.runtime.ingest(original.batch, f.identity.credential, digest(original.batch)).replay, true);
  const before = f.store.stats();
  assert.throws(() => f.ingest(5, 1), (error) => error.status === 507 && /receipt capacity/.test(error.message));
  assert.deepEqual(f.store.stats(), before);
  f.setTime("2026-09-04T12:00:00.000Z");
  assert.throws(() => f.runtime.ingest(original.batch, f.identity.credential, digest(original.batch)), (error) => error.status === 422 && /replay window/.test(error.message));
  f.ingest(6, 1);
  assert.equal(f.store.stats().records, 1);
  assert.equal(f.store.stats().receipts, 1);
  assert.equal(f.store.stats().identities, 1);
  const byteFixture = fixture(t, { maxRecordBytes: 1100 });
  byteFixture.ingest(0, 2);
  byteFixture.ingest(2, 2);
  byteFixture.ingest(4, 2);
  assert.ok(byteFixture.store.stats().recordBytes <= 1100);
  assert.equal(byteFixture.store.stats().records, 2);
  assert.equal(byteFixture.store.stats().identities, 6);
});

test("a batch exceeding its own payload capacity is rejected without receipt, health, usage or audit mutation", (t) => {
  for (const policy of [{ maxRecords: 2 }, { maxRecordBytes: 1100 }]) {
    const f = fixture(t, policy);
    f.ingest(0, 1);
    const before = f.store.snapshot();
    const totals = f.store.stats();
    assert.throws(() => f.ingest(1, 3), (error) => error.status === 507 && /newly admitted batch exceeds/.test(error.message));
    assert.deepEqual(f.store.snapshot(), before);
    assert.deepEqual(f.store.stats(), totals);
    assert.equal(f.store.findReceipt(f.identity.sourceId, "synthetic-receipt-00000001"), null);
    // A smaller retry fits, commits both new payloads, and retires only the old
    // payload when the count or byte bound requires it (equal timestamps too).
    f.ingest(1, 2);
    assert.deepEqual(f.store.snapshot().records.map((record) => record.recordId), ["synthetic-event-1", "synthetic-event-2"]);
  }
});

test("validated migration preserves original files, credentials, receipts and audit and blocks reference rollback", (t) => {
  const dir = directory(t);
  const clock = () => new Date(FIXTURE_TIME);
  let reference = new ReferenceControlPlane({ stateDirectory: dir, clock });
  const identity = createSyntheticSource(reference);
  const batch = syntheticBatch(identity, 0, 4);
  reference.ingest(batch, identity.credential, digest(batch));
  const original = reference.getState();
  reference.dispose();
  const stateFile = fs.readFileSync(path.join(dir, "state.json"));
  const auditFile = fs.readFileSync(path.join(dir, "audit.jsonl"));
  let store = new SqliteTelemetryStore({ directory: dir, clock });
  assert.deepEqual(store.snapshot(), original);
  assert.equal(store.stats().auditRows, original.revision);
  let runtime = new ReferenceControlPlane({ store, clock });
  assert.equal(runtime.ingest(batch, identity.credential, digest(batch)).replay, true);
  runtime.dispose();
  assert.throws(() => new ReferenceStateStore({ directory: dir }), /upgraded to indexed telemetry/);
  store = new SqliteTelemetryStore({ directory: dir, clock });
  runtime = new ReferenceControlPlane({ store, clock });
  try {
    assert.deepEqual(store.snapshot(), original);
    const next = syntheticBatch(identity, 4, 1);
    runtime.ingest(next, identity.credential, digest(next));
    assert.equal(store.stats().records, 5);
    assert.deepEqual(fs.readFileSync(path.join(dir, "state.json")), stateFile);
    assert.deepEqual(fs.readFileSync(path.join(dir, "audit.jsonl")), auditFile);
  } finally { runtime.dispose(); }
});

test("retention policy persists and cannot silently expand replay window on restart", (t) => {
  const f = fixture(t, { maxRecords: 4, replayDays: 2 });
  f.ingest(0, 2);
  f.runtime.dispose();
  const reopened = new SqliteTelemetryStore({ directory: f.dir });
  assert.equal(reopened.retention.replayDays, 2);
  assert.equal(reopened.retention.maxRecords, 4);
  reopened.close();
  assert.throws(() => new SqliteTelemetryStore({ directory: f.dir, retention: { maxRecords: 4, replayDays: 3 } }), /pinned at initialization/);
  assert.throws(() => retentionOptions({ maxRecords: 0 }), /Invalid/);
  assert.throws(() => retentionOptions({ maxRecordIdentities: 1 }), /must cover/);
  assert.throws(() => retentionOptions({ unknown: 5 }), /Invalid/);
});

test("migration refuses undersized caps without loss and startup rejects changed frozen inputs or audit revisions", (t) => {
  const dir = directory(t);
  const clock = () => new Date(FIXTURE_TIME);
  const runtime = new ReferenceControlPlane({ stateDirectory: dir, clock });
  const identity = createSyntheticSource(runtime);
  const batch = syntheticBatch(identity, 0, 4);
  runtime.ingest(batch, identity.credential, digest(batch));
  runtime.dispose();
  const original = fs.readFileSync(path.join(dir, "state.json"));
  assert.throws(() => new SqliteTelemetryStore({ directory: dir, retention: { maxRecords: 2 } }), /will not silently discard/);
  assert.deepEqual(fs.readFileSync(path.join(dir, "state.json")), original);
  const store = new SqliteTelemetryStore({ directory: dir });
  store.close();
  fs.appendFileSync(path.join(dir, "state.json"), "\n");
  assert.throws(() => new SqliteTelemetryStore({ directory: dir }), /migration inputs changed/);
  fs.writeFileSync(path.join(dir, "state.json"), original);
  const corrupt = new Database(path.join(dir, "telemetry.sqlite"));
  corrupt.prepare("DELETE FROM telemetry_audit WHERE revision = 2").run();
  corrupt.close();
  assert.throws(() => new SqliteTelemetryStore({ directory: dir }), /audit revisions do not agree/);
});

test("unknown schemas, linked DB files and invalid legacy inputs fail without import", (t) => {
  const unknownDir = directory(t);
  const unknownFile = path.join(unknownDir, "telemetry.sqlite");
  const unknown = new Database(unknownFile);
  unknown.exec("CREATE TABLE unrelated (value TEXT); INSERT INTO unrelated VALUES ('preserved')");
  unknown.close();
  assert.throws(() => new SqliteTelemetryStore({ directory: unknownDir }), /unknown state/);
  const verify = new Database(unknownFile);
  assert.equal(verify.prepare("SELECT value FROM unrelated").get().value, "preserved");
  assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'telemetry_meta'").get().count, 0);
  verify.close();
  const linkedDir = directory(t);
  fs.symlinkSync(path.join(linkedDir, "missing.sqlite"), path.join(linkedDir, "telemetry.sqlite"));
  assert.throws(() => new SqliteTelemetryStore({ directory: linkedDir }), /without links/);
  const legacyDir = directory(t);
  const legacy = new ReferenceStateStore({ directory: legacyDir }); legacy.close();
  fs.appendFileSync(path.join(legacyDir, "audit.jsonl"), "incomplete");
  assert.throws(() => new SqliteTelemetryStore({ directory: legacyDir }), /incomplete/);
  assert.equal(fs.existsSync(path.join(legacyDir, "telemetry.sqlite")), false);
});

test("completed SQLite admission survives SIGKILL after explicit dead-process lock recovery", async (t) => {
  const dir = directory(t);
  const code = `
    const {SqliteTelemetryStore}=require('./server/sqlite-telemetry-store');
    const {ReferenceControlPlane}=require('./server/reference-runtime');
    const {FIXTURE_TIME,createSyntheticSource,syntheticBatch,digest}=require('./tools/benchmark-private');
    const clock=()=>new Date(FIXTURE_TIME);
    const runtime=new ReferenceControlPlane({store:new SqliteTelemetryStore({directory:process.argv[1],clock}),clock});
    const identity=createSyntheticSource(runtime); const batch=syntheticBatch(identity,0,3);
    runtime.ingest(batch,identity.credential,digest(batch)); process.stdout.write('COMMITTED\\n'); setInterval(()=>{},1000);
  `;
  const child = spawn(process.execPath, ["-e", code, dir], { cwd: path.resolve(__dirname, ".."), stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  let output = "";
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Child admission timed out.")), 10_000);
    child.stdout.on("data", (chunk) => { output += chunk; if (output.includes("COMMITTED")) { clearTimeout(timeout); resolve(); } });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", () => { clearTimeout(timeout); if (!output.includes("COMMITTED")) reject(new Error("Child exited before commit.")); });
  });
  child.kill("SIGKILL"); await once(child, "exit");
  assert.throws(() => new SqliteTelemetryStore({ directory: dir }), /already in use/);
  const lock = path.join(dir, "runtime.lock");
  assert.equal(fs.readFileSync(lock, "utf8").trim(), String(child.pid));
  assert.throws(() => process.kill(child.pid, 0), (error) => error.code === "ESRCH");
  fs.unlinkSync(lock); // Exact fixture PID has exited; never broad automatic lock recovery.
  const recovered = new SqliteTelemetryStore({ directory: dir });
  try {
    assert.equal(recovered.stats().records, 3);
    assert.equal(recovered.stats().receipts, 1);
    assert.equal(recovered.stats().auditRows, 5);
    assert.equal(recovered.controlSnapshot().sources[0].health.counters.acceptedRecords, 3);
  } finally { recovered.close(); }
});
