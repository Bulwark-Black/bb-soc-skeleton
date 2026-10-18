"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const Database = require("better-sqlite3");
const { collectLogChunk, runLogCollector, previewLog, CollectorError, MAX_LINE_BYTES } = require("../tools/log-collector");
const { parseArguments, main } = require("../tools/collect-logs");
const { validateCollectionRecord } = require("../tools/log-collection-contract");
const { openOutbox } = require("../tools/integration-outbox");
const ROOT = path.resolve(__dirname, "..");

function fixture(t, content = "synthetic server event\n", format = "plain") {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "soc-collector-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "input.log"), tokenFile = path.join(directory, "source-token");
  fs.writeFileSync(file, content, { mode: 0o600 }); fs.writeFileSync(tokenFile, crypto.randomBytes(32).toString("base64url"), { mode: 0o600 });
  const options = { file, format, reviewedInput: true, sourceId: "synthetic-source", estateId: "synthetic-app", tokenFile,
    stateDirectory: path.join(directory, "state"), outboxDirectory: path.join(directory, "queue") };
  const sql = (kind, callback) => {
    const filename = kind === "state" ? path.join(options.stateDirectory, "collector.sqlite") : path.join(options.outboxDirectory, "outbox.sqlite");
    const db = new Database(filename); try { return callback(db); } finally { db.close(); }
  };
  return { options, directory, sql, batches: () => sql("queue", db => db.prepare("SELECT body FROM deliveries WHERE body IS NOT NULL ORDER BY rowid").all().map(row => JSON.parse(row.body))),
    state: () => sql("state", db => db.prepare("SELECT * FROM collector").get()),
    preview: () => { const { file, format, reviewedInput, sourceId, estateId } = options; return previewLog({ file, format, reviewedInput, sourceId, estateId }); } };
}
async function remote(t, handler) {
  const seen = [];
  const server = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8"), batch = JSON.parse(raw); seen.push({ raw, batch });
    if (handler && handler(response, batch, seen.length, request)) return;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ schemaVersion: "1", documentType: "ingest-receipt", sourceId: batch.sourceId, receiptId: batch.receiptId,
      status: "accepted", accepted: batch.records.length, duplicates: 0, receivedAt: new Date().toISOString(), replay: false }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { seen, baseUrl: "http://127.0.0.1:" + server.address().port };
}
function child(options, code) {
  return spawnSync(process.execPath, ["-e", code], { cwd: ROOT, input: JSON.stringify(options), encoding: "utf8", timeout: 20000 });
}
const readOptions = 'const fs=require("node:fs"); const options=JSON.parse(fs.readFileSync(0,"utf8")); ';

test("plain preview is a real normalized sample, writes nothing and labels collection time", t => {
  const f = fixture(t); const before = fs.readdirSync(f.directory);
  const record = f.preview();
  assert.equal(record.kind, "log.event"); assert.equal(record.payload.message, "synthetic server event");
  assert.equal(record.payload.fields.timestampOrigin, "collection-time");
  assert.deepEqual(fs.readdirSync(f.directory), before);
  assert.throws(() => previewLog({ file: f.options.file, format: "plain", sourceId: "s", estateId: "a" }), error => error.code === "input-review-required");
});

test("structured formats preserve original precision and reject absent, invalid or binary timestamp/message values", t => {
  const dockerTime = "2026-01-01T01:02:03.123456789Z";
  const docker = fixture(t, JSON.stringify({ log: "synthetic container event\n", stream: "stderr", time: dockerTime, ignored: "not retained" }) + "\n", "docker-json");
  const d = docker.preview(); assert.equal(d.observedAt, "2026-01-01T01:02:03.123Z");
  assert.equal(d.payload.fields.sourceTimestamp, dockerTime); assert.equal(d.payload.fields.stream, "stderr"); assert.equal(d.payload.ignored, undefined);
  const micros = String(BigInt(Date.parse("2026-01-01T01:02:03.123Z")) * 1000n + 456n);
  const journal = fixture(t, JSON.stringify({ MESSAGE: "synthetic journal event", __REALTIME_TIMESTAMP: micros }) + "\n", "journald-json");
  assert.equal(journal.preview().observedAt, "2026-01-01T01:02:03.123Z"); assert.equal(journal.preview().payload.fields.sourceTimestamp, micros);
  for (const value of [ { log: "event", stream: "stdout" }, { log: "event", stream: "stdout", time: "2026-02-31T00:00:00Z" },
    { log: "event", stream: "stdout", time: "today" }, { log: "event", stream: "stdout", time: "2026-01-01T00:00:00.0000000000Z" } ]) {
    fs.writeFileSync(docker.options.file, JSON.stringify(value) + "\n"); assert.throws(() => docker.preview(), error => error.code === "invalid-line");
  }
  fs.writeFileSync(journal.options.file, JSON.stringify({ MESSAGE: [65, 66], __REALTIME_TIMESTAMP: micros }) + "\n");
  assert.throws(() => journal.preview(), error => error.code === "invalid-line");
});

test("quiet files produce proof from an actual read; missing files produce explicit failure without a cursor", t => {
  const f = fixture(t, ""); const sample = f.preview(); assert.equal(validateCollectionRecord(sample).payload.fields.linesRead, 0);
  const result = collectLogChunk(f.options); assert.equal(result.complete, true); assert.equal(result.lines, 0);
  const proof = f.batches()[0].records[0]; assert.equal(proof.payload.fields.ok, true); assert.equal(proof.payload.fields.inputsRead, 1);
  const absent = fixture(t); fs.unlinkSync(absent.options.file);
  const failed = collectLogChunk(absent.options); assert.equal(failed.error, "input-unavailable"); assert.equal(absent.state().cursor, null);
  assert.equal(absent.batches()[0].records[0].payload.fields.ok, false);
});

test("bounded batches drain before further reads and emit completion only on the final chunk", async t => {
  const f = fixture(t, "first synthetic\nsecond synthetic\nthird synthetic\n"); const server = await remote(t);
  f.options.baseUrl = server.baseUrl; f.options.maxRecords = 2;
  const first = await runLogCollector(f.options); assert.equal(first.lines, 2); assert.equal(first.complete, false); assert.equal(first.pendingDeliveries, 0);
  assert.ok(server.seen[0].batch.records.every(record => record.kind === "log.event"));
  const second = await runLogCollector(f.options); assert.equal(second.lines, 1); assert.equal(second.complete, true);
  assert.equal(server.seen[1].batch.records.at(-1).kind, "source.heartbeat");
  const third = await runLogCollector(f.options); assert.equal(third.lines, 0); assert.equal(third.complete, true);
  assert.equal(server.seen.flatMap(row => row.batch.records).filter(record => record.kind === "log.event").length, 3);
  fs.appendFileSync(f.options.file, "fourth synthetic\n"); const fourth = await runLogCollector(f.options); assert.equal(fourth.lines, 1);
  assert.equal(server.seen[3].batch.records[0].payload.message, "fourth synthetic");
});

test("incomplete, malformed, blank, invalid UTF-8 and oversized lines never advance or disappear", async t => {
  const invalid = [ ["partial", "plain", "invalid-line"], ["{broken}\n", "docker-json", "invalid-line"], ["\n", "plain", "invalid-line"],
    [Buffer.from([0xff, 10]), "plain", "invalid-line"], ["x".repeat(MAX_LINE_BYTES + 1) + "\n", "plain", "line-too-long"],
    ["x".repeat(4001) + "\n", "plain", "line-too-long"] ];
  for (const [content, format, expected] of invalid) {
    const f = fixture(t, content, format), result = collectLogChunk(f.options);
    assert.equal(result.error, expected); assert.equal(result.offset, 0); assert.equal(f.state().cursor, null);
    assert.equal(f.batches()[0].records.length, 1); assert.equal(f.batches()[0].records[0].payload.fields.error, expected);
  }
  const f = fixture(t, "complete synthetic\npartial synthetic"), server = await remote(t); f.options.baseUrl = server.baseUrl;
  const before = await runLogCollector(f.options); assert.equal(before.error, "invalid-line"); assert.equal(before.offset, 0);
  fs.appendFileSync(f.options.file, " finished\n"); const after = await runLogCollector(f.options);
  assert.equal(after.complete, true); assert.equal(after.lines, 2);
  assert.deepEqual(server.seen[1].batch.records.filter(row => row.kind === "log.event").map(row => row.payload.message), ["complete synthetic", "partial synthetic finished"]);
});

test("truncation, same-size replacement, prefix edits and cursor corruption fail closed", async t => {
  for (const kind of ["truncate", "replace", "prefix", "cursor"]) {
    const f = fixture(t, "first synthetic line\nsecond synthetic line\n"), server = await remote(t); f.options.baseUrl = server.baseUrl;
    await runLogCollector(f.options); const cursor = f.state().cursor;
    if (kind === "truncate") fs.truncateSync(f.options.file, 2);
    if (kind === "replace") { fs.renameSync(f.options.file, f.options.file + ".old"); fs.writeFileSync(f.options.file, "first synthetic line\nsecond synthetic line\n"); }
    if (kind === "prefix") { const fd = fs.openSync(f.options.file, "r+"); fs.writeSync(fd, "other", 0, "utf8"); fs.closeSync(fd); }
    if (kind === "cursor") f.sql("state", db => db.prepare("UPDATE collector SET cursor=?").run(cursor.replace('"offset":', '"offset":1')));
    if (kind === "cursor") assert.throws(() => collectLogChunk(f.options), error => error.code === "invalid-state");
    else assert.equal(collectLogChunk(f.options).error, "input-changed");
    if (kind !== "cursor") assert.equal(f.state().cursor, cursor);
  }
});

test("pending batch survives enqueue failure with exact bytes and original timestamps", t => {
  const f = fixture(t);
  const failed = child(f.options, readOptions + `const outbox=require("./tools/integration-outbox"); const open=outbox.openOutbox; outbox.openOutbox=directory=>{const queue=open(directory);return {...queue,enqueue(){throw new Error("synthetic enqueue failure")}}}; const collector=require("./tools/log-collector");try{collector.collectLogChunk(options)}catch{process.exitCode=91}`);
  assert.equal(failed.status, 91, failed.stderr);
  const state = f.state(), pending = JSON.parse(state.pending); assert.equal(state.cursor, null); assert.equal(f.batches().length, 0);
  fs.appendFileSync(f.options.file, "another synthetic event\n");
  const resumed = collectLogChunk(f.options); assert.equal(resumed.recovered, true); assert.equal(resumed.lines, 1);
  assert.deepEqual(f.batches()[0], pending.batch); assert.equal(f.state().pending, null); assert.equal(JSON.parse(f.state().cursor).offset, Buffer.byteLength("synthetic server event\n"));
});

test("crash after durable enqueue replays the same receipt once and recovers a dead process lock", t => {
  const f = fixture(t);
  const crashed = child(f.options, readOptions + `const Database=require("better-sqlite3");const original=Database.prototype.prepare;Database.prototype.prepare=function(sql){if(sql.startsWith("UPDATE collector SET cursor="))process.exit(92);return original.call(this,sql)};require("./tools/log-collector").collectLogChunk(options);`);
  assert.equal(crashed.status, 92, crashed.stderr);
  const first = f.batches()[0]; assert.equal(f.state().cursor, null); assert.notEqual(f.state().lock_pid, null);
  const resumed = collectLogChunk(f.options); assert.equal(resumed.recovered, true); assert.equal(f.batches().length, 1); assert.deepEqual(f.batches()[0], first);
  assert.notEqual(f.state().cursor, null); assert.equal(f.state().lock_pid, null);
});

test("failed delivery cannot be overtaken by a later read or a healthy completion proof", async t => {
  const f = fixture(t, "one synthetic\ntwo synthetic\n"), server = await remote(t, response => { response.writeHead(403); response.end("discard private response"); return true; });
  f.options.baseUrl = server.baseUrl; f.options.maxRecords = 1;
  const first = await runLogCollector(f.options); assert.equal(first.complete, false); assert.equal(first.pendingDeliveries, 1);
  const cursor = f.state().cursor, second = await runLogCollector(f.options);
  assert.equal(second.lines, 0); assert.equal(second.complete, false); assert.equal(second.pendingDeliveries, 1); assert.equal(server.seen.length, 1); assert.equal(f.state().cursor, cursor);
  assert.ok(f.batches().flatMap(batch => batch.records).every(record => record.kind === "log.event"));
});

test("collector refuses a mixed source or destination outbox instead of using global totals", t => {
  for (const other of ["source", "destination"]) {
    const f = fixture(t); const queue = openOutbox(f.options.outboxDirectory);
    try {
      const sourceId = other === "source" ? "different-source" : f.options.sourceId;
      const proof = { ...previewLog({ file: f.options.file, format: "plain", sourceId, estateId: f.options.estateId, reviewedInput: true }) };
      queue.enqueue({ schemaVersion: "1", documentType: "ingest-batch", sourceId, receiptId: "synthetic-other-receipt", sentAt: new Date().toISOString(), records: [proof] },
        other === "destination" ? "http://127.0.0.1:9999" : "http://127.0.0.1:8080");
    } finally { queue.close(); }
    assert.throws(() => collectLogChunk(f.options), error => error.code === "outbox-binding-changed");
    assert.equal(f.state().cursor, null);
  }
});

test("a concurrent append is backlog and cannot produce a completion proof", t => {
  const f = fixture(t, "first synthetic\n");
  const result = child(f.options, readOptions + `const original=fs.fstatSync;let reads=0;fs.fstatSync=function(fd,...args){const stat=original.call(this,fd,...args);if(stat.ino===fs.statSync(options.file).ino&&++reads===2){fs.appendFileSync(options.file,"next synthetic\\n");return original.call(this,fd,...args)}return stat};process.stdout.write(JSON.stringify(require("./tools/log-collector").collectLogChunk(options)));`);
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).complete, false);
  assert.ok(f.batches()[0].records.every(record => record.kind === "log.event"));
});

test("private state, input links, changed bindings, lost state and replaced queue are rejected", async t => {
  const linked = fixture(t); const real = linked.options.file + ".real"; fs.renameSync(linked.options.file, real); fs.symlinkSync(real, linked.options.file);
  assert.equal(collectLogChunk(linked.options).error, "input-unavailable");
  const hard = fixture(t); fs.linkSync(hard.options.file, hard.options.file + ".link"); assert.equal(collectLogChunk(hard.options).error, "input-unavailable");
  const unsafe = fixture(t); fs.mkdirSync(unsafe.options.stateDirectory, { mode: 0o755 }); assert.throws(() => collectLogChunk(unsafe.options), error => error.code === "unsafe-state");
  const shared = fixture(t); assert.throws(() => collectLogChunk({ ...shared.options, stateDirectory: shared.directory }), error => error.code === "invalid-options");
  const bound = fixture(t); collectLogChunk(bound.options); assert.throws(() => collectLogChunk({ ...bound.options, sourceId: "other-source" }), error => error.code === "binding-changed");
  fs.unlinkSync(path.join(bound.options.stateDirectory, "collector.sqlite")); assert.throws(() => collectLogChunk(bound.options), error => error.code === "state-lost");
  const replaced = fixture(t); collectLogChunk(replaced.options); fs.renameSync(path.join(replaced.options.outboxDirectory, "outbox.sqlite"), path.join(replaced.directory, "saved-queue"));
  assert.throws(() => collectLogChunk(replaced.options), CollectorError); assert.notEqual(replaced.state().cursor, null);
  const busy = fixture(t); collectLogChunk(busy.options); busy.sql("state", db => db.prepare("UPDATE collector SET lock_pid=?,lock_token=?").run(process.pid, crypto.randomUUID()));
  assert.throws(() => collectLogChunk(busy.options), error => error.code === "collector-busy");
});

test("CLI requires one mode, keeps preview read-only, and emits only safe errors", async t => {
  const f = fixture(t); assert.throws(() => parseArguments(["--once", "--preview"]), /exactly one/);
  assert.throws(() => parseArguments(["--once", "--raw-token", "do-not-print"]), /Unsupported/);
  const output = { stdout: { write(value) { output.out += value; } }, stderr: { write(value) { output.err += value; } }, out: "", err: "" };
  const args = ["--preview", "--reviewed-input", "--file", f.options.file, "--format", "plain", "--source-id", "synthetic-source", "--app-id", "synthetic-app"];
  assert.equal(await main(args, output), 0); assert.equal(JSON.parse(output.out).kind, "log.event"); assert.equal(fs.existsSync(f.options.stateDirectory), false);
  output.out = ""; fs.writeFileSync(f.options.file, "malformed private content");
  assert.equal(await main(args, output), 1); assert.doesNotMatch(output.err, /malformed private content|input\.log/);
  assert.equal(output.out, "");
});
