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
const { validateIngestBatch } = require("../tools/ingest-contract");
const { openOutbox } = require("../tools/integration-outbox");
const { MAX_VENDOR_BYTES } = require("../tools/vendor-adapters");
const ROOT = path.resolve(__dirname, ".."), CLI = path.join(ROOT, "tools/vendor-cli.js");
const AT = "2026-09-29T12:00:00Z";

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "bb-soc-vendor-cli-"));
  const inputFile = path.join(directory, "events.json"), outbox = path.join(directory, "queue");
  const tokenFile = path.join(directory, "source-credential"), credential = crypto.randomBytes(32).toString("base64url");
  fs.writeFileSync(tokenFile, credential + "\n", { mode: 0o600 });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, inputFile, outbox, tokenFile, credential, write(value) { fs.writeFileSync(inputFile, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 }); } };
}
function event(index = 1) {
  return { eventID: "synthetic-cli-event-" + index, eventTime: AT, eventName: "CreateBucket", eventSource: "s3.amazonaws.com",
    recipientAccountId: "000000000001", userIdentity: { arn: "arn:aws:iam::000000000001:user/synthetic-reader" } };
}
function args(command, f, extra = []) {
  return [command, "--adapter", "aws-cloudtrail", "--file", f.inputFile, "--source-id", "synthetic-cli-source", "--app-id", "synthetic-cli-app", ...extra];
}
function run(argv, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(options.npm ? "npm" : process.execPath, options.npm ? ["run", "--silent", "vendor", "--", ...argv] : [CLI, ...argv],
      { cwd: ROOT, env: { ...process.env, ...options.env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", size = 0;
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Vendor subprocess exceeded its bounded test timeout.")); }, 10000);
    for (const [stream, output] of [[child.stdout, "stdout"], [child.stderr, "stderr"]]) stream.on("data", bytes => {
      size += bytes.length;
      if (size > 2 * 1024 * 1024) { child.kill("SIGKILL"); return reject(new Error("Vendor subprocess exceeded its output budget.")); }
      if (output === "stdout") stdout += bytes.toString(); else stderr += bytes.toString();
    });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}
function success(result) { assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, ""); return JSON.parse(result.stdout); }
function failure(result, ...notReflected) {
  assert.equal(result.code, 1); assert.equal(result.signal, null); assert.equal(result.stdout, "");
  assert.ok(result.stderr.trim()); assert.ok(result.stderr.length <= 301);
  for (const marker of notReflected) assert.ok(!result.stderr.includes(marker));
}
async function serve(t, handler) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8"), value = JSON.parse(body);
    const entry = { body, value, headers: request.headers, url: request.url }; requests.push(entry);
    handler(entry, response, requests.length);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { requests, baseUrl: "http://127.0.0.1:" + server.address().port };
}
function receipt(value) {
  return { schemaVersion: "1", documentType: "ingest-receipt", sourceId: value.sourceId, receiptId: value.receiptId,
    status: "accepted", accepted: value.records.length, duplicates: 0, receivedAt: AT, replay: false };
}
function respond(response, value, status = 200) { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)); }

test("vendor npm command lists ten adapters as clean JSON and help states the collection boundary", async () => {
  const catalog = success(await run(["list"], { npm: true }));
  assert.equal(catalog.length, 10); assert.equal(new Set(catalog.map(item => item.id)).size, 10);
  assert.ok(catalog.every(item => item.automaticPolling === false && item.delivery === "export-or-api-page"));
  const help = await run(["--help"]); assert.equal(help.code, 0); assert.equal(help.stderr, "");
  assert.match(help.stdout, /not automatic vendor polling/); assert.match(help.stdout, /one bounded pass/);
});

test("CLI single JSON and NDJSON normalization produce stable source/application-bound records without raw sensitive output", async t => {
  const f = fixture(t), privateMarker = crypto.randomBytes(24).toString("hex");
  const first = { ...event(1), requestParameters: { value: privateMarker }, sourceIPAddress: "203.0.113.25",
    responseElements: { value: privateMarker }, userIdentity: { arn: privateMarker }, message: privateMarker };
  f.write(first);
  const single = success(await run(args("normalize", f))); validateIngestBatch(single);
  assert.equal(single.records.length, 1); assert.equal(single.sourceId, "synthetic-cli-source");
  assert.equal(single.records[0].estateId, "synthetic-cli-app"); assert.equal(single.records[0].observedAt, "2026-09-29T12:00:00.000Z");
  for (const marker of [privateMarker, "203.0.113.25", f.credential, f.directory]) assert.ok(!JSON.stringify(single).includes(marker));
  f.write(JSON.stringify(first) + "\n" + JSON.stringify(event(2)) + "\n");
  const ndjson = success(await run(args("normalize", f))); validateIngestBatch(ndjson); assert.equal(ndjson.records.length, 2);
  f.write([first, event(2)]); assert.deepEqual(success(await run(args("normalize", f))), ndjson);
  const changed = args("normalize", f); changed[changed.indexOf("synthetic-cli-app")] = "another-cli-app";
  const rescoped = success(await run(changed)); assert.notEqual(rescoped.receiptId, ndjson.receiptId);
  assert.ok(rescoped.records.every(record => record.estateId === "another-cli-app"));
});

test("CLI enqueue, status, restart dedupe and real HTTP drain retain one immutable delivery", async t => {
  const f = fixture(t), remote = await serve(t, (entry, response) => respond(response, receipt(entry.value)));
  f.write({ Records: [event()] });
  const enqueue = args("enqueue", f, ["--outbox-dir", f.outbox, "--base-url", remote.baseUrl]);
  const saved = success(await run(enqueue)); assert.equal(saved.state, "pending"); assert.equal(saved.duplicate, false);
  assert.equal(saved.summary.originalBytesRetained, false); assert.equal(remote.requests.length, 0);
  const duplicate = success(await run(enqueue)); assert.equal(duplicate.id, saved.id); assert.equal(duplicate.duplicate, true);
  const status = success(await run(["status", "--outbox-dir", f.outbox]));
  assert.equal(status.entries.length, 1); assert.equal(status.entries[0].state, "pending");
  assert.ok(!JSON.stringify(status).includes("body")); assert.ok(!JSON.stringify(status).includes(f.credential));
  const drained = success(await run(["drain", "--outbox-dir", f.outbox, "--base-url", remote.baseUrl,
    "--source-id", "synthetic-cli-source", "--token-file", f.tokenFile, "--limit", "1"]));
  assert.equal(drained.results[0].state, "delivered"); assert.equal(remote.requests.length, 1);
  assert.equal(remote.requests[0].url, "/api/v1/ingest"); assert.equal(remote.requests[0].headers.authorization, "Bearer " + f.credential);
  assert.equal(remote.requests[0].headers.cookie, undefined);
  assert.deepEqual(validateIngestBatch(remote.requests[0].value), remote.requests[0].value);
  assert.equal(success(await run(["status", "--outbox-dir", f.outbox])).entries[0].state, "delivered");
  const replay = success(await run(enqueue)); assert.equal(replay.duplicate, true); assert.equal(replay.state, "delivered");
});

test("CLI blocked delivery exits nonzero with safe JSON status and supports explicit retry", async t => {
  const f = fixture(t), marker = crypto.randomBytes(24).toString("hex");
  const remote = await serve(t, (entry, response, count) => count === 1 ? respond(response, { error: marker }, 401) : respond(response, receipt(entry.value)));
  f.write(event()); const saved = success(await run(args("enqueue", f, ["--outbox-dir", f.outbox, "--base-url", remote.baseUrl])));
  const drain = ["drain", "--outbox-dir", f.outbox, "--base-url", remote.baseUrl, "--source-id", "synthetic-cli-source", "--token-file", f.tokenFile];
  const failed = await run(drain); assert.equal(failed.code, 1); assert.equal(failed.stderr, "");
  assert.equal(JSON.parse(failed.stdout).results[0].state, "blocked"); assert.ok(!failed.stdout.includes(marker));
  const retried = success(await run(["retry", "--outbox-dir", f.outbox, "--id", saved.id])); assert.equal(retried.state, "pending");
  assert.equal(success(await run(drain)).results[0].state, "delivered"); assert.equal(remote.requests[0].body, remote.requests[1].body);
  failure(await run(["retry", "--outbox-dir", f.outbox, "--id", saved.id]), marker);
});

test("CLI rejects unknown, inherited, duplicate and raw-credential options; environment credentials cannot substitute", async t => {
  const f = fixture(t), marker = crypto.randomBytes(24).toString("hex"); f.write(event());
  for (const argv of [[], ["constructor"], ["__proto__"], ["unknown"], ["list", "--token", marker],
    args("normalize", f, ["--api-key", marker]), args("normalize", f, ["--file", f.inputFile]),
    ["normalize", "--adapter"], args("normalize", f, ["--execute", marker])]) failure(await run(argv), marker, f.directory);
  const env = { SOURCE_TOKEN: marker, VENDOR_API_KEY: marker, SOC_INGEST_TOKEN: marker };
  assert.equal(success(await run(args("normalize", f), { env })).records.length, 1);
  failure(await run(["drain", "--outbox-dir", f.outbox, "--source-id", "synthetic-cli-source"], { env }), marker);
  const unknown = args("normalize", f); unknown[unknown.indexOf("aws-cloudtrail")] = marker;
  failure(await run(unknown), marker, f.directory);
});

test("CLI malformed files, payloads, cursors and canonical identifiers fail without reflecting raw text or paths", async t => {
  const f = fixture(t), marker = crypto.randomBytes(24).toString("hex");
  for (const input of ["{\"raw\":\"" + marker, "{}\n" + marker, { Records: [event(), { raw: marker }] },
    { Events: [{ CloudTrailEvent: JSON.stringify(event()) }], NextToken: { value: marker } }, [], { error: marker }]) {
    f.write(input); failure(await run(args("normalize", f)), marker, f.directory);
  }
  f.write(event()); const badIdentity = args("normalize", f); badIdentity[badIdentity.indexOf("synthetic-cli-source")] = marker + " invalid";
  failure(await run(badIdentity), marker, f.directory);
  const goodCursor = { Events: [{ CloudTrailEvent: JSON.stringify(event()) }], NextToken: marker };
  f.write(goodCursor); const result = success(await run(args("normalize", f)));
  assert.equal(result.records.length, 1); assert.ok(!JSON.stringify(result).includes(marker));
});

test("CLI input paths must be stable regular files without symlinks and remain inside size and UTF-8 bounds", async t => {
  const f = fixture(t); f.write(event());
  const checkPath = async filename => { const argv = args("normalize", f); argv[argv.indexOf(f.inputFile)] = filename; failure(await run(argv), filename, f.directory); };
  await checkPath("relative.json"); await checkPath(path.join(f.directory, "missing-private-file")); await checkPath(f.directory);
  await checkPath(f.directory + "/../" + path.basename(f.directory) + "/events.json");
  const link = path.join(f.directory, "linked.json"); fs.symlinkSync(f.inputFile, link); await checkPath(link);
  const parentLink = path.join(f.directory, "linked-parent"); fs.symlinkSync(f.directory, parentLink); await checkPath(path.join(parentLink, "events.json"));
  fs.writeFileSync(f.inputFile, Buffer.from([0xff, 0xfe])); await checkPath(f.inputFile);
  fs.writeFileSync(f.inputFile, ""); await checkPath(f.inputFile);
  const fd = fs.openSync(f.inputFile, "r+"); fs.ftruncateSync(fd, MAX_VENDOR_BYTES + 1); fs.closeSync(fd); await checkPath(f.inputFile);
  if (process.platform !== "win32") {
    const fifo = path.join(f.directory, "named-input"); const made = spawnSync("mkfifo", [fifo]);
    if (!made.error && made.status === 0) await checkPath(fifo);
  }
});

test("CLI outbox/delivery options reject checkout state, public targets, bad limits and unsafe credential files", async t => {
  const f = fixture(t); f.write(event());
  failure(await run(args("enqueue", f, ["--outbox-dir", ROOT])), ROOT, f.directory);
  failure(await run(args("enqueue", f, ["--outbox-dir", f.outbox, "--base-url", ["https:", "", "example.com"].join("/")])), f.directory);
  success(await run(args("enqueue", f, ["--outbox-dir", f.outbox])));
  for (const limit of ["0", "101", "1.5", "+1", "01", "1e1"]) {
    failure(await run(["drain", "--outbox-dir", f.outbox, "--source-id", "synthetic-cli-source", "--token-file", f.tokenFile, "--limit", limit]), f.directory);
  }
  const linked = path.join(f.directory, "linked-credential"); fs.symlinkSync(f.tokenFile, linked);
  failure(await run(["drain", "--outbox-dir", f.outbox, "--source-id", "synthetic-cli-source", "--token-file", linked]), f.directory, f.credential);
  fs.chmodSync(f.tokenFile, 0o644);
  failure(await run(["drain", "--outbox-dir", f.outbox, "--source-id", "synthetic-cli-source", "--token-file", f.tokenFile]), f.directory, f.credential);
});

test("CLI status paginates beyond 100 deliveries and combines optional source/state filters without hiding older blocked work", async t => {
  const f = fixture(t), queue = openOutbox(f.outbox), saved = [];
  const primary = "synthetic-cli-source", other = "synthetic-cli-other", baseUrl = "http://127.0.0.1:8080";
  try {
    for (let index = 0; index < 113; index += 1) {
      const sourceId = index >= 106 && index < 111 ? other : primary;
      const value = { schemaVersion: "1", documentType: "ingest-batch", sourceId, receiptId: "synthetic-cli-page-" + index, sentAt: AT,
        records: [{ schemaVersion: "1", documentType: "normalized-record", recordId: "synthetic-cli-page-record-" + index,
          sourceId, estateId: "synthetic-cli-app", observedAt: AT, kind: "audit.event",
          payload: { title: "Synthetic paginated delivery", state: "unknown", category: "synthetic" } }] };
      saved.push({ ...queue.enqueue(value, baseUrl), sourceId, state: index < 111 ? "blocked" : "pending" });
    }
  } finally { queue.close(); }
  const db = new Database(path.join(f.outbox, "outbox.sqlite"));
  try {
    const update = db.prepare("UPDATE deliveries SET state=?,created_at=? WHERE id=?");
    const start = Date.now() - 100000;
    db.transaction(() => saved.forEach((entry, index) => update.run(entry.state, start + index, entry.id)))();
  } finally { db.close(); }
  const statusArgs = ["status", "--outbox-dir", f.outbox];
  const defaults = success(await run(statusArgs));
  assert.deepEqual(defaults.filters, { state: null, sourceId: null });
  assert.deepEqual(defaults.page, { offset: 0, limit: 100, total: 113, returned: 100, hasMore: true, nextOffset: 100 });
  assert.equal(defaults.entries.length, 100); assert.ok(defaults.entries.every(entry => entry.baseUrl === baseUrl));
  const filtered = [...statusArgs, "--state", "blocked", "--source-id", primary];
  const first = success(await run(filtered));
  assert.deepEqual(first.filters, { state: "blocked", sourceId: primary });
  assert.deepEqual(first.page, { offset: 0, limit: 100, total: 106, returned: 100, hasMore: true, nextOffset: 100 });
  assert.ok(first.entries.every(entry => entry.state === "blocked" && entry.sourceId === primary));
  const last = success(await run([...filtered, "--offset", "100", "--limit", "25"]));
  assert.deepEqual(last.page, { offset: 100, limit: 25, total: 106, returned: 6, hasMore: false, nextOffset: null });
  assert.deepEqual([...first.entries, ...last.entries].map(entry => entry.id), saved.slice(0, 106).reverse().map(entry => entry.id));
  assert.equal(new Set([...first.entries, ...last.entries].map(entry => entry.id)).size, 106);
  const pending = success(await run([...statusArgs, "--state", "pending", "--limit", "1"]));
  assert.equal(pending.page.total, 2); assert.equal(pending.page.returned, 1); assert.equal(pending.page.nextOffset, 1);
  assert.equal(success(await run([...statusArgs, "--source-id", other])).page.total, 5);
  for (const state of ["inflight", "delivered"]) assert.equal(success(await run([...statusArgs, "--state", state])).page.total, 0);
  const beyond = success(await run([...filtered, "--offset", "10000", "--limit", "100"]));
  assert.equal(beyond.page.returned, 0); assert.equal(beyond.page.hasMore, false); assert.equal(beyond.page.nextOffset, null);
  assert.ok(!JSON.stringify(defaults).includes(f.credential)); assert.ok(!JSON.stringify(defaults).includes("body"));
});

test("CLI status rejects malformed filters and pagination while keeping only the directory mandatory", async t => {
  const f = fixture(t), marker = crypto.randomBytes(24).toString("hex");
  const queue = openOutbox(f.outbox); queue.close();
  const statusArgs = ["status", "--outbox-dir", f.outbox];
  const empty = success(await run([...statusArgs, "--offset", "0", "--limit", "1"]));
  assert.deepEqual(empty.page, { offset: 0, limit: 1, total: 0, returned: 0, hasMore: false, nextOffset: null });
  for (const extra of [
    ["--state", marker], ["--state", "__proto__"], ["--state", "BLOCKED"], ["--source-id", marker + " invalid"],
    ["--source-id", "x".repeat(129)], ["--state", "pending", "--state", "blocked"], ["--offset", "1", "--offset", "2"],
    ["--base-url", marker], ["--token-file", marker], ["--limit", "0"], ["--limit", "101"], ["--limit", "1.5"],
    ["--limit", "01"], ["--limit", "+1"], ["--offset", "-1"], ["--offset", "10001"], ["--offset", "1.5"],
    ["--offset", "1e2"], ["--offset", "+1"], ["--offset", "00"], ["--offset", marker], ["--state"]
  ]) failure(await run([...statusArgs, ...extra]), marker, f.directory);
  failure(await run(["status", "--state", "blocked", "--limit", "10"]), marker, f.directory);
});
