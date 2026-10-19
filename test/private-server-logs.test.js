"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const Database = require("better-sqlite3");
const { startPrivateApplication } = require("../server/private-application");
const { previewLog, runLogCollector } = require("../tools/log-collector");
const { validateDocument } = require("../tools/validate-provider");
const ROOT = path.resolve(__dirname, "..");

function collectorProcess(options) {
  const args = ["tools/collect-logs.js", "--once", "--reviewed-input", "--file", options.file, "--format", options.format,
    "--source-id", options.sourceId, "--app-id", options.estateId, "--state-dir", options.stateDirectory,
    "--outbox-dir", options.outboxDirectory, "--token-file", options.tokenFile, "--base-url", options.baseUrl];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Private server-log collector exceeded its test timeout.")); }, 15000);
    child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

test("private HTTP server-log workflow collects, projects, survives restart and reports failed reads without skipping input", async t => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "bb-private-server-logs-"));
  const stateDirectory = path.join(directory, "application"), file = path.join(directory, "server.log");
  let app;
  t.after(async () => { if (app) await app.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  app = await startPrivateApplication({ stateDirectory, port: 0 });
  const password = crypto.randomBytes(30).toString("base64url"), email = "server-log-operator@example.invalid";
  await app.authentication.createOperator({ email, name: "Synthetic server-log operator", password });
  let cookie = "", sequence = 0;
  const request = (endpoint, body) => fetch(app.url + endpoint, {
    method: body === undefined ? "GET" : "POST",
    headers: { Origin: app.url, Connection: "close", ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  async function expect(promise, status = 200) {
    const response = await promise, body = await response.json();
    assert.equal(response.status, status, JSON.stringify(body)); return body;
  }
  async function command(name, input) {
    const result = await expect(request("/api/v1/control/commands", { schemaVersion: "1", documentType: "connector-command-request",
      requestId: "private-server-log-command-" + (++sequence), command: name, requestedAt: new Date().toISOString(), input }));
    assert.equal(result.status, "succeeded", JSON.stringify(result)); return result.output;
  }
  const snapshot = () => expect(request("/api/v1/control/snapshot?reason=refresh"));
  const page = async route => { const body = await expect(request("/api/v1/pages?route=" + encodeURIComponent(route))); validateDocument(body); return body; };
  await expect(request("/api/v1/integrations/observations"), 401);
  const signed = await request("/api/auth/sign-in/email", { email, password });
  assert.equal(signed.status, 200); cookie = signed.headers.getSetCookie().map(value => value.split(";")[0]).join("; "); await signed.arrayBuffer();
  const application = await command("app.register", { displayName: "Synthetic server application", environments: ["test"], publicPages: [] });
  const configured = await command("source.setup", { appId: application.appId, environment: "test", connectorType: "server-log-push",
    sourceKind: "server.log", displayName: "Synthetic server collection", config: { "cadence-seconds": 60 }, credentialReferences: [] });
  const sourceRevision = async () => {
    const current = await snapshot(), source = [...current.sources, ...current.setups].find(item => item.sourceId === configured.sourceId);
    return { sourceId: source.sourceId, connectorInstanceId: source.connectorInstanceId, expectedRevision: source.revision };
  };
  const logLine = message => JSON.stringify({ log: message + "\n", stream: "stdout", time: new Date().toISOString() }) + "\n";
  fs.writeFileSync(file, logLine("First synthetic server request") + logLine("Second synthetic server request"), { mode: 0o600 });
  const previewOptions = { file, format: "docker-json", reviewedInput: true, sourceId: configured.sourceId, estateId: application.appId };
  const sample = previewLog(previewOptions); assert.equal(sample.kind, "log.event");
  await command("source.test", { ...await sourceRevision(), recordSample: sample });
  assert.equal(app.runtime.store.stats().records, 0, "preview and sample validation do not ingest telemetry");
  const activation = await command("source.activate", await sourceRevision());
  const tokenFile = path.join(directory, "source-token"); fs.writeFileSync(tokenFile, activation.oneTimeCredential.value + "\n", { mode: 0o600 });
  const options = { ...previewOptions, tokenFile, stateDirectory: path.join(directory, "collector"), outboxDirectory: path.join(directory, "outbox"), baseUrl: app.url };
  const checkpoint = () => {
    const db = new Database(path.join(options.stateDirectory, "collector.sqlite"), { readonly: true });
    try { return db.prepare("SELECT cursor FROM collector WHERE id=1").get().cursor; } finally { db.close(); }
  };
  const sourceHealth = async () => (await snapshot()).sources.find(source => source.sourceId === configured.sourceId).health;
  const observations = values => expect(request("/api/v1/integrations/observations?" + new URLSearchParams({ sourceId: configured.sourceId, limit: "100", ...values })));
  const logRows = async () => (await page("/logs")).panels.find(panel => panel.id === "log-results").rows;
  assert.equal((await sourceHealth()).state, "pending");
  const first = await runLogCollector(options);
  assert.equal(first.complete, true); assert.equal(first.lines, 2); assert.equal(first.delivered, 1); assert.equal(first.pendingDeliveries, 0);
  const healthy = await sourceHealth(); assert.equal(healthy.state, "healthy"); assert.ok(healthy.lastSuccessAt);
  const rows = await logRows(); assert.equal(rows.length, 2); assert.match(JSON.stringify(rows), /First synthetic server request/);
  assert.doesNotMatch(JSON.stringify(rows), /Server log collection|source\.heartbeat/);
  const initial = await observations({}); assert.equal(initial.matched, 3);
  const initialLogs = initial.records.filter(record => record.kind === "log.event");
  assert.equal(initialLogs.length, 2); assert.equal(initial.records.filter(record => record.kind === "source.heartbeat").length, 1);
  const earliest = initialLogs.map(record => record.observedAt).sort()[0], latest = initialLogs.map(record => record.observedAt).sort().at(-1);
  const filtered = await observations({ kinds: "log.event", observedAfter: earliest, observedBefore: new Date(Date.parse(latest) + 1).toISOString() });
  assert.equal(filtered.matched, 2); assert.ok(filtered.records.every(record => record.kind === "log.event"));
  assert.equal((await observations({ kinds: "log.event", observedBefore: earliest })).matched, 0, "end time is exclusive");
  for (const route of ["/sources", "/health"]) {
    const proof = (await page(route)).panels.find(panel => panel.id === "server-log-collection-status").rows[0];
    assert.equal(proof[1].value, healthy.lastAttemptAt); assert.equal(proof[2].value, healthy.lastSuccessAt);
    assert.ok(proof[3].value); assert.equal(proof[4].value, latest); assert.equal(proof[5].value, 2);
    assert.match(proof[6], /Completed server-log read/);
  }

  const cursorBeforeRestart = checkpoint(), port = Number(new URL(app.url).port);
  await app.close(); app = null;
  app = await startPrivateApplication({ stateDirectory, port });
  assert.equal(checkpoint(), cursorBeforeRestart); assert.equal((await sourceHealth()).lastSuccessAt, healthy.lastSuccessAt);
  fs.appendFileSync(file, logLine("Third synthetic server request after restart"));
  const restarted = await collectorProcess(options);
  assert.equal(restarted.code, 0, restarted.stderr); assert.equal(restarted.stderr, "");
  const appended = JSON.parse(restarted.stdout); assert.equal(appended.lines, 1); assert.equal(appended.complete, true); assert.equal(appended.pendingDeliveries, 0);
  const afterRestart = await observations({ kinds: "log.event" }); assert.equal(afterRestart.matched, 3);
  assert.equal(new Set(afterRestart.records.map(record => record.recordId)).size, 3);
  assert.deepEqual(new Set(afterRestart.records.filter(record => initialLogs.some(old => old.recordId === record.recordId)).map(record => record.recordId)), new Set(initialLogs.map(record => record.recordId)));
  assert.equal((await logRows()).length, 3);
  const quiet = await runLogCollector(options); assert.equal(quiet.lines, 0); assert.equal(quiet.complete, true); assert.equal(quiet.pendingDeliveries, 0);
  const quietHealth = await sourceHealth(); assert.equal(quietHealth.state, "healthy");
  assert.equal((await observations({ kinds: "log.event" })).matched, 3, "a quiet read never creates a synthetic log event");

  const cursorBeforeFailure = checkpoint(); fs.appendFileSync(file, "{synthetic malformed JSON}\n");
  const failed = await runLogCollector(options);
  assert.equal(failed.error, "invalid-line"); assert.equal(failed.complete, false); assert.equal(failed.lines, 0); assert.equal(failed.pendingDeliveries, 0);
  assert.equal(checkpoint(), cursorBeforeFailure, "a failed read cannot skip the malformed input");
  const failedHealth = await sourceHealth(); assert.equal(failedHealth.state, "degraded"); assert.equal(failedHealth.lastSuccessAt, quietHealth.lastSuccessAt);
  assert.equal((await observations({ kinds: "log.event" })).matched, 3);
  const failureProof = (await observations({ kinds: "source.heartbeat" })).records.find(record => record.payload.fields.error === "invalid-line");
  assert.ok(failureProof); assert.equal(failureProof.payload.fields.ok, false);
  const healthPage = await page("/health");
  assert.equal(healthPage.panels.find(panel => panel.id === "summary-metrics").items.find(item => item.label === "Healthy feeds").value, 0);
  assert.match(healthPage.panels.find(panel => panel.id === "server-log-collection-status").rows[0][6], /read failed: invalid-line/);
});
