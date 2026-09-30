"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { createIntegrationClient, prepareBatch, readBatchFile, readSourceTokenFile,
  validateReceipt, retryAfterMs, MAX_BATCH_BYTES, MAX_RESPONSE_BYTES } = require("../tools/integration-client");
const { parseArguments, main } = require("../tools/send-events");
const { RECORD_KINDS } = require("../tools/ingest-contract");
const ROOT = path.resolve(__dirname, "..");
const AT = "2026-09-29T12:00:00Z";

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "bb-soc-sender-"));
  const tokenFile = path.join(directory, "source-token"), token = crypto.randomBytes(32).toString("base64url");
  fs.writeFileSync(tokenFile, token + "\n", { mode: 0o600 });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, tokenFile, token };
}
function batch(count = 1) {
  return { schemaVersion: "1", documentType: "ingest-batch", sourceId: "synthetic-source", receiptId: "synthetic-batch-0001", sentAt: AT,
    records: Array.from({ length: count }, (_, index) => ({ schemaVersion: "1", documentType: "normalized-record",
      recordId: "synthetic-record-" + index, sourceId: "synthetic-source", estateId: "synthetic-app", kind: "log.event", observedAt: AT,
      payload: { title: "Synthetic application event", state: "ok", message: "Synthetic sender test" } })) };
}
function receipt(value, overrides = {}) {
  return { schemaVersion: "1", documentType: "ingest-receipt", sourceId: value.sourceId, receiptId: value.receiptId,
    status: "accepted", accepted: value.records.length, duplicates: 0, receivedAt: AT, replay: false, ...overrides };
}
function respond(response, value, status = 200, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json", ...headers }); response.end(JSON.stringify(value));
}
function testUrl(scheme, authority, suffix = "") { return [scheme, ":", "/", "/", authority, suffix].join(""); }
async function serve(t, handler) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    const entry = { method: request.method, path: request.url, headers: request.headers, body, value: JSON.parse(body) };
    requests.push(entry);
    handler(entry, response, requests.length, request);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { requests, baseUrl: "http://127.0.0.1:" + server.address().port };
}

test("sender validates every canonical kind, count/byte bounds, and refuses secret fields without echoing values", () => {
  assert.equal(MAX_BATCH_BYTES, require("../server/reference-control-plane").INGEST_BODY_LIMIT);
  const all = batch(RECORD_KINDS.length);
  all.records.forEach((record, index) => {
    record.kind = RECORD_KINDS[index];
    record.payload = { ...record.payload, severity: "info", assetRef: "synthetic-asset", identityRef: "synthetic-identity",
      ruleRef: "synthetic-rule", findingRef: "synthetic-finding", category: "synthetic", indicatorType: "domain", indicator: "example.invalid" };
  });
  const prepared = prepareBatch(all);
  assert.equal(prepared.batch.records.length, 29); assert.ok(Object.isFrozen(prepared.batch));
  assert.throws(() => prepareBatch(batch(1001)), { code: "invalid-batch" });
  const oversized = batch(300); oversized.records.forEach(record => { record.payload.message = "x".repeat(4000); });
  assert.throws(() => prepareBatch(oversized), { code: "batch-too-large" });
  const sensitiveValue = crypto.randomBytes(24).toString("base64url");
  const invalid = batch(); invalid.records[0].payload.fields = { apiToken: sensitiveValue };
  assert.throws(() => prepareBatch(invalid), error => error.code === "invalid-batch" && !error.message.includes(sensitiveValue));
  assert.throws(() => prepareBatch({ ...batch(), records: [] }), { code: "invalid-batch" });
});

test("sender token custody rejects links, exposed files, repo files, service credentials and raw credential options", t => {
  const f = fixture(t);
  assert.equal(readSourceTokenFile(f.tokenFile), f.token);
  fs.chmodSync(f.tokenFile, 0o640); assert.throws(() => readSourceTokenFile(f.tokenFile), { code: "invalid-token-file" }); fs.chmodSync(f.tokenFile, 0o600);
  const symlink = path.join(f.directory, "linked"); fs.symlinkSync(f.tokenFile, symlink);
  assert.throws(() => readSourceTokenFile(symlink), { code: "invalid-token-file" });
  const hardlink = path.join(f.directory, "hardlinked"); fs.linkSync(f.tokenFile, hardlink);
  assert.throws(() => readSourceTokenFile(f.tokenFile), { code: "invalid-token-file" }); fs.unlinkSync(hardlink);
  assert.throws(() => readSourceTokenFile(path.join(ROOT, "package.json")), { code: "invalid-token-file" });
  fs.writeFileSync(f.tokenFile, "bbsvc_service-" + crypto.randomUUID() + "_" + f.token);
  assert.throws(() => readSourceTokenFile(f.tokenFile), { code: "invalid-token-file" });
  assert.throws(() => createIntegrationClient({ tokenFile: f.tokenFile, token: f.token }), error => error.code === "invalid-options" && !error.message.includes(f.token));
  assert.throws(() => readSourceTokenFile("relative-token"), { code: "invalid-token-file" });
});

test("sender destination and CLI options reject public origins, downgrade, URLs containing credentials, and raw token flags", t => {
  const f = fixture(t);
  const privateAddress = [192, 168, 1, 2].join(".");
  for (const baseUrl of [testUrl("https", "example.com"), testUrl("http", privateAddress), "http://127.0.0.1/path", testUrl("http", "operator:secret@127.0.0.1"), testUrl("http", "127.1"), "http://127.0.0.1/?a=1"]) {
    assert.throws(() => createIntegrationClient({ baseUrl, tokenFile: f.tokenFile }), { code: "invalid-origin" });
  }
  for (const baseUrl of ["http://127.0.0.1:8080", testUrl("https", privateAddress), testUrl("https", ["synthetic", "tailnet", "ts", "net"].join("."))]) {
    assert.doesNotThrow(() => createIntegrationClient({ baseUrl, tokenFile: f.tokenFile }));
  }
  assert.throws(() => parseArguments(["--token", f.token]), error => !error.message.includes(f.token));
  assert.throws(() => parseArguments(["--file", "file", "--file", "again", "--token-file", f.tokenFile]), { code: "invalid-options" });
  assert.throws(() => createIntegrationClient({ tokenFile: f.tokenFile, attempts: 6 }), { code: "invalid-options" });
  assert.throws(() => createIntegrationClient({ tokenFile: f.tokenFile, timeoutMs: 30001 }), { code: "invalid-options" });
});

test("HTTP sender uses scoped bearer, fixed endpoint, bounded JSON, matching receipt and no browser cookies", async t => {
  const f = fixture(t), remote = await serve(t, (request, response) => respond(response, receipt(request.value)));
  const value = batch(2), result = await createIntegrationClient({ baseUrl: remote.baseUrl, tokenFile: f.tokenFile }).sendBatch(value);
  assert.deepEqual(result, receipt(value));
  assert.equal(remote.requests.length, 1);
  assert.equal(remote.requests[0].method, "POST"); assert.equal(remote.requests[0].path, "/api/v1/ingest");
  assert.equal(remote.requests[0].headers.authorization, "Bearer " + f.token);
  assert.equal(remote.requests[0].headers.cookie, undefined); assert.equal(remote.requests[0].headers.origin, undefined);
  assert.equal(remote.requests[0].body, prepareBatch(value).body);
});

test("HTTP retries network loss and 503 with identical bodies and supports token rotation between attempts", async t => {
  const f = fixture(t), rotated = crypto.randomBytes(32).toString("base64url");
  const remote = await serve(t, (request, response, count, incoming) => {
    if (count === 1) { incoming.socket.destroy(); fs.writeFileSync(f.tokenFile, rotated); return; }
    if (count === 2) return respond(response, { message: "untrusted remote text" }, 503, { "Retry-After": "0" });
    respond(response, receipt(request.value, { replay: true }));
  });
  const result = await createIntegrationClient({ baseUrl: remote.baseUrl, tokenFile: f.tokenFile, backoffMs: 25 }).sendBatch(batch());
  assert.equal(result.replay, true); assert.equal(remote.requests.length, 3);
  assert.equal(new Set(remote.requests.map(request => request.body)).size, 1);
  assert.equal(remote.requests[0].headers.authorization, "Bearer " + f.token);
  assert.equal(remote.requests[1].headers.authorization, "Bearer " + rotated);
});

test("HTTP sender honors bounded Retry-After and stops instead of retrying early for a longer delay", async t => {
  const f = fixture(t), remote = await serve(t, (request, response, count) => count === 1
    ? respond(response, {}, 429, { "Retry-After": "1" }) : respond(response, receipt(request.value)));
  const started = Date.now();
  await createIntegrationClient({ baseUrl: remote.baseUrl, tokenFile: f.tokenFile, backoffMs: 25 }).sendBatch(batch());
  assert.ok(Date.now() - started >= 990);
  const long = await serve(t, (request, response) => respond(response, {}, 429, { "Retry-After": "60" }));
  await assert.rejects(createIntegrationClient({ baseUrl: long.baseUrl, tokenFile: f.tokenFile }).sendBatch(batch()), { code: "ingest-rejected", status: 429, retryAfterMs: 60000 });
  assert.equal(long.requests.length, 1);
  assert.equal(retryAfterMs("invalid"), null); assert.equal(retryAfterMs("2029"), 2029000);
  assert.equal(retryAfterMs("Tue, 29 Sep 2026 12:00:01 GMT", Date.parse(AT)), 1000);
});

test("HTTP sender never retries validation, credential, conflict, capacity, or redirect responses and never echoes response text", async t => {
  const f = fixture(t);
  for (const status of [400, 401, 403, 409, 413, 422, 500, 507, 302]) {
    const remote = await serve(t, (request, response) => respond(response, { secret: f.token, message: "must-not-echo-response" }, status, { Location: "/different" }));
    await assert.rejects(createIntegrationClient({ baseUrl: remote.baseUrl, tokenFile: f.tokenFile }).sendBatch(batch()), error => {
      assert.equal(error.status, status); assert.equal(error.attempts, 1);
      assert.ok(!error.message.includes(f.token)); assert.ok(!error.message.includes("must-not-echo-response")); return true;
    });
    assert.equal(remote.requests.length, 1);
  }
});

test("HTTP sender bounds retry attempts and stalled responses", async t => {
  const f = fixture(t), remote = await serve(t, (request, response) => respond(response, {}, 504));
  await assert.rejects(createIntegrationClient({ baseUrl: remote.baseUrl, tokenFile: f.tokenFile, attempts: 2, backoffMs: 25 }).sendBatch(batch()), { code: "ingest-rejected", attempts: 2, status: 504 });
  assert.equal(remote.requests.length, 2);
  const hanging = await serve(t, () => {});
  await assert.rejects(createIntegrationClient({ baseUrl: hanging.baseUrl, tokenFile: f.tokenFile, attempts: 1, timeoutMs: 50 }).sendBatch(batch()), { code: "network-unavailable", attempts: 1 });
});

test("receipt validation binds identity, counts, timestamps and exact keys", () => {
  const value = batch(2);
  assert.deepEqual(validateReceipt(receipt(value, { accepted: 1, duplicates: 1 }), value), receipt(value, { accepted: 1, duplicates: 1 }));
  for (const changes of [{ sourceId: "other" }, { receiptId: "other" }, { accepted: 3 }, { duplicates: -1 }, { replay: "false" }, { receivedAt: "yesterday" }, { extra: "untrusted" }]) {
    assert.throws(() => validateReceipt(receipt(value, changes), value), { code: "invalid-receipt" });
  }
});

test("HTTP sender refuses malformed and oversized receipts without retrying them", async t => {
  const f = fixture(t);
  const handlers = [
    (request, response) => respond(response, receipt(request.value, { sourceId: "other" })),
    (request, response) => { response.writeHead(200, { "Content-Type": "text/html" }); response.end("must-not-echo-body"); },
    (request, response) => { response.writeHead(200, { "Content-Type": "application/json" }); response.end("{malformed}"); },
    (request, response) => { response.writeHead(200, { "Content-Type": "application/json", "Content-Length": MAX_RESPONSE_BYTES + 1 }); response.end(" ".repeat(MAX_RESPONSE_BYTES + 1)); },
    (request, response) => { response.writeHead(200, { "Content-Type": "application/json" }); response.write(" ".repeat(MAX_RESPONSE_BYTES)); response.end(" "); }
  ];
  for (const handler of handlers) {
    const remote = await serve(t, handler);
    await assert.rejects(createIntegrationClient({ baseUrl: remote.baseUrl, tokenFile: f.tokenFile }).sendBatch(batch()), error => ["invalid-receipt", "response-too-large"].includes(error.code));
    assert.equal(remote.requests.length, 1);
  }
});

test("CLI loads one bounded batch file and emits only a safe validated receipt", async t => {
  const f = fixture(t), remote = await serve(t, (request, response) => respond(response, receipt(request.value)));
  const file = path.join(f.directory, "batch.json"); fs.writeFileSync(file, JSON.stringify(batch()));
  assert.deepEqual(readBatchFile(file), prepareBatch(batch()).batch);
  let stdout = "", stderr = "";
  const code = await main(["--file", file, "--token-file", f.tokenFile, "--base-url", remote.baseUrl], {
    stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } }
  });
  assert.equal(code, 0); assert.equal(stderr, ""); assert.deepEqual(JSON.parse(stdout), receipt(batch()));
  assert.ok(!stdout.includes(f.token));
  fs.writeFileSync(file, " ".repeat(MAX_BATCH_BYTES + 1)); assert.throws(() => readBatchFile(file), { code: "invalid-batch-file" });
  fs.writeFileSync(file, Buffer.from([0xff, 0xfe])); assert.throws(() => readBatchFile(file), { code: "invalid-batch" });
});

test("real CLI process accepts token path, ignores raw credential environment, and exits nonzero on validation error", async t => {
  const f = fixture(t), remote = await serve(t, (request, response) => respond(response, receipt(request.value)));
  const file = path.join(f.directory, "batch.json"); fs.writeFileSync(file, JSON.stringify(batch()));
  const invoke = args => new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(ROOT, "tools/send-events.js"), ...args], { env: { ...process.env, SOC_SOURCE_TOKEN: crypto.randomBytes(32).toString("base64url") }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
  const success = await invoke(["--file", file, "--token-file", f.tokenFile, "--base-url", remote.baseUrl]);
  assert.equal(success.code, 0); assert.deepEqual(JSON.parse(success.stdout), receipt(batch()));
  const failure = await invoke(["--file", file, "--token", f.token]);
  assert.equal(failure.code, 1); assert.equal(failure.stdout, ""); assert.ok(!failure.stderr.includes(f.token));
});

test("sender integrates with private durable admission, replay, wrong credentials and paused-source refusal", async t => {
  const { startPrivateApplication } = require("../server/private-application");
  const { runAsOperator } = require("../server/operator-context");
  const f = fixture(t), stateDirectory = path.join(f.directory, "state");
  fs.mkdirSync(stateDirectory, { mode: 0o700 });
  const app = await startPrivateApplication({ stateDirectory, port: 0 });
  t.after(() => app.close());
  let sequence = 0;
  const command = (name, input) => {
    const result = runAsOperator("synthetic-sender-owner", () => app.runtime.execute({ schemaVersion: "1", documentType: "connector-command-request",
      requestId: "sender-private-command-" + (++sequence), requestedAt: new Date().toISOString(), command: name, input }));
    assert.equal(result.status, "succeeded", name); return result.output;
  };
  const registered = command("app.register", { displayName: "Synthetic sender app", hosts: [], publicPages: [], environments: ["test"] });
  const source = command("source.setup", { appId: registered.appId, environment: "test", connectorType: "canonical-push", sourceKind: "log.event",
    displayName: "Synthetic sender source", config: { "cadence-seconds": 300 }, credentialReferences: [] });
  const tested = command("source.test", { sourceId: source.sourceId, connectorInstanceId: source.connectorInstanceId,
    expectedRevision: source.revision, sample: { message: "Synthetic sender validation", channel: "application" } });
  const activated = command("source.activate", { sourceId: source.sourceId, connectorInstanceId: source.connectorInstanceId, expectedRevision: tested.revision });
  const value = batch(); value.sourceId = source.sourceId; value.sentAt = new Date().toISOString();
  Object.assign(value.records[0], { sourceId: source.sourceId, estateId: registered.appId, observedAt: value.sentAt });
  const client = createIntegrationClient({ baseUrl: app.url, tokenFile: f.tokenFile, attempts: 1 });
  await assert.rejects(client.sendBatch(value), { status: 401 });
  fs.writeFileSync(f.tokenFile, activated.oneTimeCredential.value);
  const first = await client.sendBatch(value); assert.equal(first.accepted, 1); assert.equal(first.replay, false);
  const replay = await client.sendBatch(value); assert.equal(replay.replay, true);
  assert.equal(app.runtime.store.stats().records, 1);
  const current = app.runtime.controlState().sources.find(entry => entry.sourceId === source.sourceId);
  command("source.pause", { sourceId: source.sourceId, connectorInstanceId: source.connectorInstanceId, expectedRevision: current.revision });
  await assert.rejects(client.sendBatch(value), error => error.status === 403 || error.status === 409);
  assert.equal(app.runtime.store.stats().records, 1);
});
