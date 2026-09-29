"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startPrivateApplication } = require("../server/private-application");
const { normalizeTrivyReport } = require("../server/scanner-ingest");
const { spawn } = require("node:child_process");

test("private Trivy upload authenticates operator and scoped sender, rejects failures, projects and replays across restart", async (t) => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "bb-soc-private-scanner-"));
  let app = await startPrivateApplication({ stateDirectory: directory, port: 0 });
  t.after(async () => { if (app) await app.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const password = crypto.randomBytes(30).toString("base64url");
  await app.authentication.createOperator({ email: "scanner-owner@example.invalid", name: "Scanner operator", password });
  let cookie, serial = 0;
  const request = (endpoint, { body, credential, anonymous = false, machine = false, headers = {}, method = "POST" } = {}) => fetch(app.url + endpoint, {
    method, headers: { Connection: "close", ...(!machine ? { Origin: app.url } : {}),
      ...(cookie && !anonymous && !machine ? { Cookie: cookie } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(credential ? { Authorization: "Bearer " + credential } : {}), ...headers },
    ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {})
  });
  const signIn = await request("/api/auth/sign-in/email", { body: { email: "scanner-owner@example.invalid", password } });
  assert.equal(signIn.status, 200);
  cookie = signIn.headers.getSetCookie().map((entry) => entry.split(";")[0]).join("; "); await signIn.arrayBuffer();
  const command = async (name, input) => {
    const response = await request("/api/v1/control/commands", { body: { schemaVersion: "1", documentType: "connector-command-request",
      requestId: "scanner-command-" + (++serial), command: name, requestedAt: new Date().toISOString(), input } });
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); assert.equal(result.status, "succeeded", JSON.stringify(result)); return result.output;
  };
  const application = await command("app.register", { displayName: "Web application", environments: ["production"], publicPages: [] });
  const setup = await command("source.setup", { appId: application.appId, environment: "production", connectorType: "trivy-report",
    sourceKind: "trivy.scan", displayName: "Application package reports", config: { "cadence-seconds": 86400 }, credentialReferences: [] });
  const revision = () => {
    const source = app.runtime.controlState().sources.find((entry) => entry.sourceId === setup.sourceId);
    return { sourceId: source.sourceId, connectorInstanceId: source.connectorInstanceId, expectedRevision: source.revision };
  };
  await command("source.test", revision());
  const activation = await command("source.activate", revision());
  const credential = activation.oneTimeCredential.value;
  const report = { SchemaVersion: 2, CreatedAt: new Date(Date.now() - 1000).toISOString(), ArtifactName: "application-build",
    ArtifactType: "filesystem", Metadata: { ImageConfig: { Env: ["PRIVATE_SAMPLE=discard-this"] } }, Results: [{
      Target: "package-lock.json", Class: "lang-pkgs", Type: "npm", Vulnerabilities: [{ VulnerabilityID: "CVE-2026-0001",
        PkgName: "sample-package", InstalledVersion: "1.0.0", FixedVersion: "1.0.1", Severity: "HIGH", Description: "discard-this" }]
    }] };
  const endpoint = "/api/v1/scanners/trivy/import?sourceId=" + encodeURIComponent(setup.sourceId);
  const expectStatus = async (promise, status) => { const response = await promise; const text = await response.text(); assert.equal(response.status, status, text); return text && JSON.parse(text); };
  await expectStatus(request(endpoint, { body: report, anonymous: true }), 401);
  await expectStatus(request(endpoint, { body: report, machine: true, credential: crypto.randomBytes(30).toString("base64url") }), 401);
  await expectStatus(request(endpoint, { body: report, headers: { Origin: "https://example.invalid" } }), 403);
  await expectStatus(request(endpoint, { body: report, headers: { "Content-Encoding": "gzip" } }), 415);
  await expectStatus(request(endpoint + "&sourceId=other", { body: report }), 400);
  await expectStatus(request(endpoint, { body: "not JSON" }), 400);
  await expectStatus(request(endpoint, { body: { ...report, Error: "scanner incomplete" } }), 422);
  await expectStatus(request(endpoint, { body: { ...report, CreatedAt: new Date(Date.now() - 8 * 86400000).toISOString() } }), 422);
  await expectStatus(request(endpoint, { body: { ...report, CreatedAt: new Date(Date.now() + 10 * 60000).toISOString() } }), 422);
  assert.equal(app.runtime.controlState().sources[0].health.lastSuccessAt, null, "failed report attempts cannot claim successful scanner collection");
  const imported = await expectStatus(request(endpoint, { body: report }), 200);
  assert.equal(imported.receipt.replay, false); assert.equal(imported.receipt.accepted, 3);
  assert.equal(imported.summary.vulnerabilityCount, 1);
  const repeated = await expectStatus(request(endpoint, { body: report, machine: true, credential }), 200);
  assert.equal(repeated.receipt.replay, true); assert.equal(repeated.receipt.receivedAt, imported.receipt.receivedAt);
  const reportPath = path.join(directory, "scanner-test-report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report), { mode: 0o600 });
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(__dirname, "../tools/import-trivy.js"), "--base-url", app.url,
        "--file", reportPath, "--source-id", setup.sourceId, "--credential-stdin"], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("error", reject); child.once("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(credential + "\n");
    });
    assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).replay, true);
    assert.ok(!result.stdout.includes(credential)); assert.ok(!result.stderr.includes(credential));
  } finally { fs.unlinkSync(reportPath); }
  const records = app.runtime.getState().records;
  assert.equal(records.length, 3);
  assert.ok(!JSON.stringify(records).includes("discard-this"));
  const normalized = normalizeTrivyReport(report, { sourceId: setup.sourceId, estateId: application.appId });
  await expectStatus(request("/api/v1/ingest", { body: normalized.batch, machine: true, credential }), 422);
  const page = await expectStatus(request("/api/v1/pages?route=%2Fscans&tab=trivy", { method: "GET" }), 200);
  assert.equal(page.state, "ready");
  assert.match(JSON.stringify(page), /sample-package/);
  assert.match(JSON.stringify(page), /Web application \/ production/);
  const otherSetup = await command("source.setup", { appId: application.appId, environment: "production", connectorType: "trivy-report",
    sourceKind: "trivy.scan", displayName: "Other application artifact", config: { "cadence-seconds": 86400 }, credentialReferences: [] });
  const otherSource = () => app.runtime.controlState().sources.find((entry) => entry.sourceId === otherSetup.sourceId);
  await command("source.test", { sourceId: otherSetup.sourceId, connectorInstanceId: otherSetup.connectorInstanceId, expectedRevision: otherSource().revision });
  await command("source.activate", { sourceId: otherSetup.sourceId, connectorInstanceId: otherSetup.connectorInstanceId, expectedRevision: otherSource().revision });
  await expectStatus(request("/api/v1/scanners/trivy/import?sourceId=" + encodeURIComponent(otherSetup.sourceId), { body: report, machine: true, credential }), 403);
  await command("source.pause", revision());
  await expectStatus(request(endpoint, { body: report }), 409);
  await command("source.resume", revision());
  const port = Number(new URL(app.url).port);
  await app.close(); app = null;
  app = await startPrivateApplication({ stateDirectory: directory, port });
  const replayAfterRestart = await expectStatus(request(endpoint, { body: report, machine: true, credential }), 200);
  assert.equal(replayAfterRestart.receipt.replay, true);
  assert.equal(app.runtime.getState().records.length, 3);
  await command("source.revoke", revision());
  await expectStatus(request(endpoint, { body: report, machine: true, credential }), 401);
});
