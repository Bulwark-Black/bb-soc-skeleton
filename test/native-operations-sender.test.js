"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), http = require("node:http"), crypto = require("node:crypto");
const { execFile } = require("node:child_process"), { promisify } = require("node:util");
const { MonitorStore } = require("../server/native-monitor/store");
const { createHostRegistry } = require("../server/native-monitor/registry");
const { createOperations } = require("../server/native-monitor/operations");
const execute = promisify(execFile), sender = path.join(__dirname, "../tools/native-monitor/send-operation.py");
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "operation-sender-test-"));
  const token = crypto.randomBytes(32).toString("base64url"), tokenFile = path.join(directory, "credential");
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  const registry = createHostRegistry({ hosts: [{ id: "resource-test", sourceId: "source-test", appId: "app-test", label: "Synthetic resource" }] });
  let store = new MonitorStore({ data: path.join(directory, "monitor"), minFreeBytes: 0, registry });
  let operations = createOperations(store.db, { registry }), drop = false, badReceipt = false, forcedStatus = null;
  operations.route({ method: "POST", path: "/jobs", body: { id: "job-test", host: "resource-test", label: "Synthetic job", actor: "operator:test", idempotencyKey: "register-job", schedule: { kind: "observed", timeZone: "UTC" } } });
  const received = [];
  const server = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString(); received.push(raw);
    assert.equal(request.url, "/api/v1/monitor/operations");
    assert.equal(request.headers.authorization, "Bearer " + token);
    assert.equal(request.headers.cookie, undefined);
    if (forcedStatus) { response.writeHead(forcedStatus, { "Content-Type": "application/json" }); response.end(JSON.stringify({ secret: token })); return; }
    try {
      const body = JSON.parse(raw);
      const result = operations.route({ method: "POST", path: "/operations/ingest", body, hosts: ["resource-test"] });
      if (drop) { drop = false; request.socket.destroy(); return; }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(badReceipt ? { ...result.body, eventId: "wrong-event" } : result.body));
    } catch (error) { response.writeHead(error.status || 500, { "Content-Type": "application/json" }); response.end(JSON.stringify({ message: error.message })); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const config = { schemaVersion: 1, sourceId: "source-test", host: "resource-test", tokenFile, consoleUrl: "http://127.0.0.1:" + server.address().port };
  const configFile = path.join(directory, "config.json"), eventFile = path.join(directory, "event.json"), queueDir = path.join(directory, "queue");
  fs.writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
  async function cli(command, extra = []) {
    let result;
    try { result = { ...await execute("python3", [sender, command, "--config", configFile, "--queue-dir", queueDir, ...extra], { timeout: 15000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } }), code: 0 }; }
    catch (error) { result = { stdout: error.stdout || "", stderr: error.stderr || "", code: error.code }; }
    assert.ok(!(result.stdout + result.stderr).includes(token), "credential never appears in CLI output");
    return { ...result, value: result.stdout.trim() ? JSON.parse(result.stdout) : null };
  }
  const write = value => fs.writeFileSync(eventFile, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
  const enqueue = async value => { write(value); return cli("enqueue", ["--event-file", eventFile]); };
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, token, config, configFile, eventFile, queueDir, cli, enqueue, received, write,
    event: (id, kind = "start") => ({ schemaVersion: 1, eventId: id, jobId: "job-test", runId: "run-test", kind, observedAt: new Date().toISOString(), evidence: { basis: "Synthetic external observation", verification: "unknown" } }),
    drop() { drop = true; }, bad(value) { badReceipt = value; }, force(value) { forcedStatus = value; },
    restart() { store.close(); store = new MonitorStore({ data: path.join(directory, "monitor"), minFreeBytes: 0, registry }); operations = createOperations(store.db, { registry }); },
    runCount() { return store.db.prepare("SELECT count(*) AS n FROM ops_runs").get().n; },
    receiptCount() { return store.db.prepare("SELECT count(*) AS n FROM ops_receipts WHERE id LIKE 'host:%'").get().n; } };
}

test("operation sender persists exact event through uncertain delivery and both restarts without duplicate execution evidence", async t => {
  const f = await fixture(t), start = f.event("start-test");
  assert.equal((await f.enqueue(start)).code, 0);
  assert.equal((await f.cli("status")).value.counts.pending, 1);
  f.drop(); assert.equal((await f.cli("send")).code, 1);
  assert.equal(f.runCount(), 1); assert.equal(f.receiptCount(), 1);
  assert.equal((await f.cli("status")).value.counts.pending, 1);
  f.restart(); assert.equal((await f.enqueue(start)).value.replay, true);
  const sent = await f.cli("send"); assert.equal(sent.code, 0); assert.equal(sent.value.counts.delivered, 1);
  assert.equal(f.received.length, 2); assert.equal(f.received[0], f.received[1]); assert.equal(f.runCount(), 1); assert.equal(f.receiptCount(), 1);
  assert.equal((await f.enqueue({ ...start, evidence: { changed: true } })).code, 1);
  assert.equal((await f.cli("status")).value.counts.delivered, 1);
  assert.equal((await f.enqueue(f.event("finish-test", "succeeded"))).code, 0);
  f.bad(true); assert.equal((await f.cli("send")).code, 1); assert.equal((await f.cli("status")).value.counts.pending, 1);
  f.bad(false); assert.equal((await f.cli("send")).code, 0); assert.equal(f.receiptCount(), 2);
  assert.equal((await f.cli("status")).value.retained, 2, "delivered evidence is retained without automatic purge");
});

test("operation sender blocks rejected lifecycle order until explicit retry and pins source/destination", async t => {
  const f = await fixture(t);
  await f.enqueue(f.event("start-test")); await f.enqueue(f.event("finish-test", "succeeded"));
  f.force(403); assert.equal((await f.cli("send")).code, 1);
  assert.deepEqual((await f.cli("status")).value.counts, { abandoned: 0, blocked: 1, delivered: 0, pending: 1 });
  const attempts = f.received.length; f.force(null);
  assert.equal((await f.cli("send")).code, 1); assert.equal(f.received.length, attempts, "later finish cannot overtake blocked start");
  assert.equal((await f.cli("retry", ["--event-id", "start-test"])).code, 0);
  assert.equal((await f.cli("send")).code, 0); assert.equal(f.receiptCount(), 2);
  for (const change of [{ host: "other-host" }, { sourceId: "other-source" }, { consoleUrl: "http://127.0.0.1:9" }]) {
    fs.writeFileSync(f.configFile, JSON.stringify({ ...f.config, ...change }));
    assert.equal((await f.cli("status")).code, 1);
  }
});

test("operation sender rejects unsafe files, duplicate JSON and forged envelopes without echoing secrets", async t => {
  const f = await fixture(t), event = f.event("valid-test");
  for (const value of [{ ...event, actor: f.token }, { ...event, sourceId: "foreign-source" }, { ...event, jobId: undefined }, { ...event, employeeId: "employee-test" }, { ...event, eventId: "x".repeat(97) }, { ...event, observedAt: "yesterday" }, { ...event, evidence: "x".repeat(65536) }]) {
    assert.equal((await f.enqueue(value)).code, 1);
  }
  assert.equal((await f.enqueue('{"schemaVersion":1,"schemaVersion":1}')).code, 1);
  f.write(event); fs.chmodSync(f.eventFile, 0o644);
  assert.equal((await f.cli("enqueue", ["--event-file", f.eventFile])).code, 1);
  fs.chmodSync(f.eventFile, 0o600);
  const symlink = path.join(f.directory, "linked.json"); fs.symlinkSync(f.eventFile, symlink);
  assert.equal((await f.cli("enqueue", ["--event-file", symlink])).code, 1);
  const fifo = path.join(f.directory, "fifo"); await execute("mkfifo", [fifo]);
  assert.equal((await f.cli("enqueue", ["--event-file", fifo])).code, 1);
  assert.equal((await f.cli("status", ["--token", f.token])).code, 2);
  assert.equal((await f.cli("status")).value.retained, 0);
});

test("explicit abandonment retains immutable operation evidence and releases later entries without allowing reuse", async t => {
  const f = await fixture(t), invalid = { ...f.event("blocked-event"), jobId: "unregistered-job" };
  await f.enqueue(invalid); await f.enqueue(f.event("later-start"));
  assert.equal((await f.cli("send")).code, 1);
  assert.equal((await f.cli("status")).value.next.id, "blocked-event");
  const { DatabaseSync } = require("node:sqlite");
  const retained = () => { const db = new DatabaseSync(path.join(f.queueDir, "operations.sqlite")); try { return db.prepare("SELECT * FROM events WHERE id='blocked-event'").get(); } finally { db.close(); } };
  const before = retained(), reason = "Reviewed invalid job identity; original evidence retained for investigation.";
  const args = ["--event-id", "blocked-event", "--reason", reason];
  assert.equal((await f.cli("abandon", args)).value.state, "abandoned");
  assert.equal((await f.cli("abandon", args)).value.replay, true);
  const after = retained(); assert.equal(after.body, before.body); assert.equal(after.digest, before.digest);
  assert.equal(after.state, "blocked", "original delivery outcome remains retained");
  assert.equal(after.abandoned_reason, reason); assert.ok(Number.isFinite(Date.parse(after.abandoned_at)));
  assert.equal((await f.cli("abandon", ["--event-id", "blocked-event", "--reason", "Changed reason"])).code, 1);
  assert.equal((await f.cli("retry", ["--event-id", "blocked-event"])).code, 1);
  assert.equal((await f.enqueue(invalid)).value.state, "abandoned");
  assert.equal((await f.enqueue({ ...invalid, jobId: "job-test" })).code, 1);
  assert.equal((await f.cli("send")).code, 0); assert.equal(f.receiptCount(), 1);
  assert.deepEqual((await f.cli("status")).value.counts, { abandoned: 1, blocked: 0, delivered: 1, pending: 0 });
  assert.equal((await f.cli("abandon", ["--event-id", "later-start", "--reason", reason])).code, 1);
  assert.equal((await f.cli("status")).value.retained, 2);
});
