"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");
const { spawn, spawnSync } = require("node:child_process");
const Database = require("better-sqlite3");
const { MAX_BATCH_BYTES } = require("../tools/integration-client");
const { argumentsFor } = require("../tools/events-cli");
const ROOT = path.resolve(__dirname, ".."), CLI = path.join(ROOT, "tools/events-cli.js");
const AT = "2026-10-18T12:00:00.000Z";

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "bb-soc-events-cli-"));
  const inputFile = path.join(directory, "batch.json"), outbox = path.join(directory, "queue");
  const tokenFile = path.join(directory, "source-credential"), credential = crypto.randomBytes(32).toString("base64url");
  fs.writeFileSync(tokenFile, credential + "\n", { mode: 0o600 });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, inputFile, outbox, tokenFile, credential,
    write(value) { fs.writeFileSync(inputFile, typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value), { mode: 0o600 }); } };
}
function batch(index = 1, sourceId = "synthetic-log-source") {
  return { schemaVersion: "1", documentType: "ingest-batch", sourceId, receiptId: "synthetic-cli-receipt-" + index, sentAt: AT,
    records: [{ schemaVersion: "1", documentType: "normalized-record", recordId: "synthetic-cli-log-" + index,
      sourceId, estateId: "synthetic-log-app", observedAt: AT, kind: "log.event",
      payload: { title: "Synthetic server event", state: "ok", severity: "info", message: "Synthetic server request completed.", channel: "application" } }] };
}
function run(argv, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...argv], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", size = 0;
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Events CLI exceeded its bounded test timeout.")); }, 10000);
    for (const [stream, output] of [[child.stdout, "stdout"], [child.stderr, "stderr"]]) stream.on("data", bytes => {
      size += bytes.length;
      if (size > 2 * 1024 * 1024) { child.kill("SIGKILL"); return reject(new Error("Events CLI exceeded its output budget.")); }
      if (output === "stdout") stdout += bytes.toString(); else stderr += bytes.toString();
    });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}
function success(result) { assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, ""); return JSON.parse(result.stdout); }
function failure(result, ...markers) {
  assert.equal(result.code, 1); assert.equal(result.signal, null); assert.equal(result.stdout, "");
  assert.ok(result.stderr.trim()); assert.ok(result.stderr.length <= 301);
  for (const marker of markers) assert.ok(!result.stderr.includes(marker), "private content must not be echoed");
}
function enqueue(f, extra = []) { return ["enqueue", "--file", f.inputFile, "--outbox-dir", f.outbox, ...extra]; }
function drain(f, baseUrl) { return ["drain", "--outbox-dir", f.outbox, "--source-id", "synthetic-log-source", "--token-file", f.tokenFile, "--base-url", baseUrl]; }
function receipt(value) { return { schemaVersion: "1", documentType: "ingest-receipt", sourceId: value.sourceId, receiptId: value.receiptId,
  status: "accepted", accepted: value.records.length, duplicates: 0, receivedAt: AT, replay: false }; }
function respond(response, body, status = 200) { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(body)); }
async function serve(t, handler) {
  const requests = [], server = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8"), entry = { body, value: JSON.parse(body), headers: request.headers, url: request.url };
    requests.push(entry); handler(entry, response, requests.length);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { requests, baseUrl: "http://127.0.0.1:" + server.address().port };
}

test("events help explains canonical input, durable custody and bounded drain", async () => {
  const help = await run(["--help"]); assert.equal(help.code, 0); assert.equal(help.stderr, "");
  assert.match(help.stdout, /canonical ingest-batch/); assert.match(help.stdout, /before any network request/);
  assert.match(help.stdout, /one bounded pass/); assert.match(help.stdout, /token file/);
  for (const value of [null, {}, [null], ["status", 42]]) assert.throws(() => argumentsFor(value), TypeError);
});

test("canonical CLI survives restarts, deduplicates immutable bodies and delivers via source credential", async t => {
  const f = fixture(t), remote = await serve(t, (entry, response) => respond(response, receipt(entry.value)));
  f.write(batch()); const args = enqueue(f, ["--base-url", remote.baseUrl]);
  const saved = success(await run(args)); assert.equal(saved.state, "pending"); assert.equal(saved.duplicate, false);
  assert.equal(remote.requests.length, 0, "enqueue is durable local storage only");
  assert.deepEqual(success(await run(args)), { ...saved, duplicate: true });
  const changed = batch(); changed.records[0].payload.message = "Different content with the same receipt"; f.write(changed);
  failure(await run(args), changed.records[0].payload.message, f.directory, f.credential);
  const pending = success(await run(["status", "--outbox-dir", f.outbox]));
  assert.equal(pending.entries.length, 1); assert.equal(pending.entries[0].id, saved.id);
  assert.ok(!JSON.stringify(pending).includes("message")); assert.ok(!JSON.stringify(pending).includes(f.credential));
  const delivered = success(await run(drain(f, remote.baseUrl)));
  assert.equal(delivered.results[0].state, "delivered"); assert.equal(remote.requests.length, 1);
  assert.equal(remote.requests[0].url, "/api/v1/ingest"); assert.equal(remote.requests[0].headers.authorization, "Bearer " + f.credential);
  assert.equal(remote.requests[0].headers.cookie, undefined); assert.deepEqual(remote.requests[0].value, batch());
  f.write(batch()); assert.deepEqual(success(await run(args)), { id: saved.id, state: "delivered", duplicate: true });
  assert.equal(success(await run(drain(f, remote.baseUrl))).processed, 0);
  assert.equal(success(await run(["status", "--outbox-dir", f.outbox])).entries[0].state, "delivered");
});

test("blocked canonical delivery retains original bytes for explicit retry without echoing remote errors", async t => {
  const f = fixture(t), privateMarker = crypto.randomBytes(24).toString("hex");
  const remote = await serve(t, (entry, response, count) => count === 1 ? respond(response, { error: privateMarker }, 401) : respond(response, receipt(entry.value)));
  f.write(batch()); const saved = success(await run(enqueue(f, ["--base-url", remote.baseUrl])));
  const rejected = await run(drain(f, remote.baseUrl)); assert.equal(rejected.code, 1); assert.equal(rejected.stderr, "");
  assert.equal(JSON.parse(rejected.stdout).results[0].state, "blocked"); assert.ok(!rejected.stdout.includes(privateMarker));
  assert.equal(success(await run(["retry", "--outbox-dir", f.outbox, "--id", saved.id])).state, "pending");
  assert.equal(success(await run(drain(f, remote.baseUrl))).results[0].state, "delivered");
  assert.equal(remote.requests[0].body, remote.requests[1].body);
  failure(await run(["retry", "--outbox-dir", f.outbox, "--id", saved.id]), privateMarker, f.directory);
});

test("canonical status combines filters and pagination while retaining global totals", async t => {
  const f = fixture(t);
  for (const value of [batch(1), batch(2), batch(3, "synthetic-other-source")]) { f.write(value); success(await run(enqueue(f))); }
  const args = ["status", "--outbox-dir", f.outbox, "--state", "pending", "--source-id", "synthetic-log-source", "--limit", "1"];
  const first = success(await run(args)), second = success(await run([...args, "--offset", String(first.page.nextOffset)]));
  assert.equal(first.page.total, 2); assert.equal(first.page.hasMore, true); assert.equal(second.page.hasMore, false);
  assert.notEqual(first.entries[0].id, second.entries[0].id); assert.equal(first.totals[0].entries, 3);
  assert.ok([...first.entries, ...second.entries].every(entry => entry.sourceId === "synthetic-log-source" && entry.state === "pending"));
});

test("canonical command rejects unsupported options, credentials and malformed bounds without reflecting them", async t => {
  const f = fixture(t), marker = crypto.randomBytes(24).toString("hex"); f.write(batch());
  for (const args of [[], ["constructor"], ["__proto__"], ["list"], ["enqueue", "--file"], enqueue(f, ["--file", f.inputFile]),
    enqueue(f, ["--token", marker]), enqueue(f, ["--api-key", marker]), enqueue(f, ["--source-id", marker]),
    ["drain", "--outbox-dir", f.outbox, "--source-id", "synthetic-log-source"],
    ["retry", "--outbox-dir", f.outbox, "--id", marker], ["status", "--outbox-dir", f.outbox, "--state", marker],
    ["status", "--outbox-dir", f.outbox, "--source-id", marker + " invalid"]]) failure(await run(args, { SOURCE_TOKEN: marker, SOC_INGEST_TOKEN: marker }), marker, f.directory);
  for (const value of ["0", "101", "1.5", "+1", "01", "1e1"]) {
    failure(await run(["status", "--outbox-dir", f.outbox, "--limit", value]), f.directory);
    failure(await run([...drain(f, "http://127.0.0.1:8080"), "--limit", value]), f.directory);
  }
  for (const value of ["-1", "10001", "1.5", "00", "+1", "1e1"]) failure(await run(["status", "--outbox-dir", f.outbox, "--offset", value]), f.directory);
});

test("malformed canonical input and non-regular paths fail before queue creation without secret echo", async t => {
  const f = fixture(t), marker = crypto.randomBytes(24).toString("hex");
  for (const value of ["{\"private\":\"" + marker, "{}\n{}", [], { secret: marker }, "", Buffer.from([0xff, 0xfe])]) {
    f.write(value); failure(await run(enqueue(f)), marker, f.directory); assert.equal(fs.existsSync(f.outbox), false);
  }
  f.write(batch());
  const check = async filename => failure(await run(["enqueue", "--file", filename, "--outbox-dir", f.outbox]), filename, f.directory);
  await check("relative.json"); await check(f.directory); await check(path.join(f.directory, marker));
  await check(f.directory + "/../" + path.basename(f.directory) + "/batch.json");
  const linked = path.join(f.directory, "linked-batch"); fs.symlinkSync(f.inputFile, linked); await check(linked);
  const parentLink = path.join(f.directory, "linked-parent"); fs.symlinkSync(f.directory, parentLink); await check(path.join(parentLink, "batch.json"));
  const fd = fs.openSync(f.inputFile, "r+"); fs.ftruncateSync(fd, MAX_BATCH_BYTES + 1); fs.closeSync(fd); await check(f.inputFile);
  if (process.platform !== "win32") {
    const fifo = path.join(f.directory, "named-batch"), made = spawnSync("mkfifo", [fifo]);
    if (!made.error && made.status === 0) await check(fifo);
  }
  assert.equal(fs.existsSync(f.outbox), false);
});

test("delivery rejects unsafe targets, queue locations and token files without using environment secrets", async t => {
  const f = fixture(t); f.write(batch());
  failure(await run(["enqueue", "--file", f.inputFile, "--outbox-dir", ROOT]), ROOT, f.credential);
  failure(await run(enqueue(f, ["--base-url", "https://example.invalid"])), f.directory, f.credential);
  success(await run(enqueue(f)));
  const args = drain(f, "http://127.0.0.1:8080");
  const linked = path.join(f.directory, "linked-credential"); fs.symlinkSync(f.tokenFile, linked);
  args[args.indexOf(f.tokenFile)] = linked; failure(await run(args), f.directory, f.credential);
  args[args.indexOf(linked)] = f.tokenFile; fs.chmodSync(f.tokenFile, 0o644); failure(await run(args), f.directory, f.credential);
  fs.chmodSync(f.tokenFile, 0o600); fs.writeFileSync(f.tokenFile, "bbsvc_" + f.credential); failure(await run(args), f.directory, f.credential);
  if (process.platform !== "win32") {
    fs.unlinkSync(f.tokenFile); const made = spawnSync("mkfifo", [f.tokenFile]);
    if (!made.error && made.status === 0) failure(await run(args), f.directory, f.credential);
  }
});

test("events prune explicitly removes old delivered metadata while retaining unfinished deliveries", async t => {
  const f = fixture(t), remote = await serve(t, (entry, response) => respond(response, receipt(entry.value)));
  f.write(batch(1)); const delivered = success(await run(enqueue(f, ["--base-url", remote.baseUrl])));
  success(await run(drain(f, remote.baseUrl)));
  f.write(batch(2)); const pending = success(await run(enqueue(f, ["--base-url", remote.baseUrl])));
  const cutoff = Date.now() - 2 * 86400000, before = new Date(cutoff).toISOString();
  const db = new Database(path.join(f.outbox, "outbox.sqlite"));
  try { db.prepare("UPDATE deliveries SET updated_at=?").run(cutoff - 1); } finally { db.close(); }
  assert.equal(success(await run(["status", "--outbox-dir", f.outbox])).page.total, 2);
  for (const options of [[], ["--before", "invalid-private-cutoff"], ["--before", new Date().toISOString()], ["--before", before, "--before", before], ["--before", before, "--state", "pending"]]) {
    failure(await run(["prune", "--outbox-dir", f.outbox, ...options]), "invalid-private-cutoff", f.credential, f.directory);
    assert.equal(success(await run(["status", "--outbox-dir", f.outbox])).page.total, 2);
  }
  assert.deepEqual(success(await run(["prune", "--outbox-dir", f.outbox, "--before", before])), { removed: 1, before });
  const status = success(await run(["status", "--outbox-dir", f.outbox]));
  assert.deepEqual(status.entries.map(entry => entry.id), [pending.id]); assert.notEqual(pending.id, delivered.id);
  assert.equal(status.entries[0].state, "pending");
});
