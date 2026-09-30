"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { startPrivateApplication } = require("../server/private-application");
const { normalizeVendorPayload, MAX_VENDOR_BYTES } = require("../tools/vendor-adapters");
const { runAsOperator, runAsService } = require("../server/operator-context");

const BASE = "/api/v1/integrations/vendors";

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "bb-soc-vendor-http-"));
  let app = await startPrivateApplication({ stateDirectory: directory, port: 0 });
  t.after(async () => { if (app) await app.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const password = crypto.randomBytes(30).toString("base64url");
  await app.authentication.createOperator({ email: "vendor-owner@example.invalid", name: "Vendor import operator", password });
  let cookie = "", serial = 0;
  const request = (endpoint, { body, method = body === undefined ? "GET" : "POST", anonymous = false, headers = {} } = {}) => fetch(app.url + endpoint, {
    method, headers: { Connection: "close", Origin: app.url, ...(cookie && !anonymous ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) })
  });
  const expect = async (pending, status) => {
    const response = await pending, document = await response.json();
    assert.equal(response.status, status, JSON.stringify(document)); return document;
  };
  const login = async () => {
    const response = await request("/api/auth/sign-in/email", { body: { email: "vendor-owner@example.invalid", password } });
    assert.equal(response.status, 200); cookie = response.headers.getSetCookie().map(item => item.split(";")[0]).join("; "); await response.arrayBuffer();
  };
  const command = async (command, input) => {
    const result = await expect(request("/api/v1/control/commands", { body: { schemaVersion: "1", documentType: "connector-command-request",
      requestId: "vendor-http-command-" + (++serial), command, requestedAt: new Date().toISOString(), input } }), 200);
    assert.equal(result.status, "succeeded", JSON.stringify(result)); return result.output;
  };
  const revision = sourceId => {
    const source = app.runtime.controlState().sources.find(item => item.sourceId === sourceId);
    return { sourceId, connectorInstanceId: source.connectorInstanceId, expectedRevision: source.revision };
  };
  const register = () => command("app.register", { displayName: "Synthetic web application", environments: ["test"], publicPages: [] });
  const setup = (appId, connectorType = "vendor.github-audit", sourceKind = "github-audit") => command("source.setup", { appId, environment: "test",
    connectorType, sourceKind, displayName: "Synthetic vendor source", config: { "cadence-seconds": 300 }, credentialReferences: [] });
  const declaredRequest = (endpoint, bytes) => new Promise((resolve, reject) => {
    // Send only headers so an intentional early 413 does not race a large
    // fetch body write and appear to that client as EPIPE instead of a response.
    const pending = http.request(app.url + endpoint, { method: "POST", headers: { Origin: app.url, Cookie: cookie,
      Connection: "close", "Content-Type": "application/json", "Content-Length": bytes } }, response => {
      const chunks = []; response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => { pending.destroy(); resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); });
    });
    pending.on("error", reject); pending.setTimeout(2000, () => pending.destroy(new Error("Expected bounded declared-length refusal.")));
    pending.flushHeaders();
  });
  return { get app() { return app; }, directory, request, declaredRequest, expect, login, command, revision, register, setup,
    async restart() { const port = Number(new URL(app.url).port); await app.close(); app = null; app = await startPrivateApplication({ stateDirectory: directory, port }); } };
}

function rawEvent(id, at, hidden, overrides = {}) {
  return { _document_id: id, "@timestamp": at, action: "team.add_member", actor_id: 11, org_id: 22, repo_id: 33,
    actor: "private-person@example.invalid", title: hidden, message: hidden, data: { headers: { authorization: hidden }, privateValue: hidden }, ...overrides };
}

test("private vendor HTTP authenticates, previews without writes, activates, imports, replays and preserves bound context across restart", async t => {
  const f = await fixture(t);
  await f.expect(f.request(BASE), 401);
  await f.expect(f.request(BASE + "/preview", { body: {} }), 401);
  await f.expect(f.request(BASE + "/import", { body: {} }), 401);
  await f.login();
  const catalog = await f.expect(f.request(BASE), 200);
  assert.equal(catalog.adapters.length, 10); assert.equal(new Set(catalog.adapters.map(item => item.id)).size, 10);
  assert.equal(catalog.automaticPolling, false); assert.equal(catalog.rawStorage, false); assert.equal(catalog.limits.inputBytes, MAX_VENDOR_BYTES);
  assert.ok(catalog.adapters.every(item => item.docs.length && item.formats.length && item.manifest.connectorType === "vendor." + item.id));
  const github = catalog.adapters.find(item => item.id === "github-audit");
  const integrations = await f.expect(f.request("/api/v1/integrations"), 200);
  await f.expect(f.request("/api/v1/integrations", { body: { manifest: github.manifest, expectedRevision: integrations.revision } }), 201);
  const application = await f.register(), otherApp = await f.register();
  const source = await f.setup(application.appId);
  const hidden = crypto.randomBytes(24).toString("hex"), observed = Date.now() - 2000;
  const raw = [rawEvent("synthetic-github-first", observed, hidden, { sourceId: "attempted-source", estateId: otherApp.appId, adapterId: "gitlab-audit" }),
    rawEvent("synthetic-github-second", observed + 1, hidden)];
  const body = { adapterId: "github-audit", sourceId: source.sourceId, text: raw.map(item => JSON.stringify(item)).join("\n") };
  const before = JSON.stringify(f.app.runtime.controlState()), stats = f.app.runtime.store.stats();
  const preview = await f.expect(f.request(BASE + "/preview", { body }), 200);
  assert.equal(preview.stored, false); assert.equal(preview.state, "configured"); assert.equal(preview.totalRecords, 2);
  assert.equal(preview.recordSample.sourceId, source.sourceId); assert.equal(preview.recordSample.estateId, application.appId);
  assert.equal(preview.recordSample.kind, "audit.event"); assert.equal(preview.summary.coverage, "supplied-events-only");
  assert.equal(preview.summary.originalBytesRetained, false);
  assert.ok(!JSON.stringify(preview).includes(hidden)); assert.ok(!JSON.stringify(preview).includes("private-person@example.invalid"));
  assert.deepEqual(f.app.runtime.store.stats(), stats); assert.equal(JSON.stringify(f.app.runtime.controlState()), before);
  const jsonPreview = await f.expect(f.request(BASE + "/preview", { body: { ...body, text: JSON.stringify(raw) } }), 200);
  assert.equal(jsonPreview.previewHash, preview.previewHash, "JSON and NDJSON containing the same events normalize identically");
  await f.expect(f.request(BASE + "/import", { body: { ...body, previewHash: preview.previewHash } }), 409);
  assert.equal(f.app.runtime.store.stats().records, 0, "configured sources cannot admit data");
  await f.command("source.test", { ...f.revision(source.sourceId), recordSample: preview.recordSample });
  assert.equal(f.app.runtime.store.stats().records, 0, "a tested sample is not retained telemetry");
  const activation = await f.command("source.activate", f.revision(source.sourceId));
  assert.equal(activation.oneTimeCredential.purpose, "source-ingest");
  const activePreview = await f.expect(f.request(BASE + "/preview", { body }), 200);
  assert.equal(activePreview.previewHash, preview.previewHash);
  await f.expect(f.request(BASE + "/import", { body: { ...body, previewHash: "0".repeat(64) } }), 409);
  assert.equal(f.app.runtime.store.stats().records, 0);
  const imported = await f.expect(f.request(BASE + "/import", { body: { ...body, previewHash: activePreview.previewHash } }), 200);
  assert.equal(imported.receipt.accepted, 2); assert.equal(imported.receipt.replay, false);
  const repeated = await f.expect(f.request(BASE + "/import", { body: { ...body, text: JSON.stringify(raw.slice().reverse()), previewHash: activePreview.previewHash } }), 200);
  assert.equal(repeated.receipt.replay, true); assert.equal(repeated.receipt.receivedAt, imported.receipt.receivedAt);
  assert.equal(f.app.runtime.store.stats().records, 2);
  const observations = await f.expect(f.request("/api/v1/integrations/observations?sourceId=" + source.sourceId), 200);
  assert.equal(observations.records.length, 2);
  assert.ok(observations.records.every(item => item.sourceId === source.sourceId && item.estateId === application.appId && item.kind === "audit.event"));
  assert.equal(observations.sourceContexts[0].appId, application.appId);
  const sourceState = f.app.runtime.controlState().sources.find(item => item.sourceId === source.sourceId);
  assert.ok(sourceState.health.lastSuccessAt); assert.equal(sourceState.health.counters.acceptedRecords, 2);
  assert.ok(!JSON.stringify(f.app.runtime.getState()).includes(hidden));
  for (const name of fs.readdirSync(f.directory)) {
    const file = path.join(f.directory, name);
    if (fs.statSync(file).isFile()) assert.equal(fs.readFileSync(file).includes(Buffer.from(hidden)), false, "raw private marker must not reach any state file");
  }
  await f.restart();
  const afterRestart = await f.expect(f.request(BASE + "/import", { body: { ...body, previewHash: activePreview.previewHash } }), 200);
  assert.equal(afterRestart.receipt.replay, true); assert.equal(f.app.runtime.store.stats().records, 2);
  const nextBody = { ...body, text: JSON.stringify(rawEvent("synthetic-github-next", observed + 2, hidden)) };
  const nextPreview = await f.expect(f.request(BASE + "/preview", { body: nextBody }), 200);
  await f.command("source.pause", f.revision(source.sourceId));
  await f.expect(f.request(BASE + "/import", { body: { ...nextBody, previewHash: nextPreview.previewHash } }), 409);
  assert.equal(f.app.runtime.store.stats().records, 2, "pause after preview is rechecked at admission");
});

test("vendor import rejects wrong authority, mismatched source/preset, malformed and over-limit input without retaining raw data", async t => {
  const f = await fixture(t); await f.login();
  const vendors = await f.expect(f.request(BASE), 200), github = vendors.adapters.find(item => item.id === "github-audit");
  const integrations = await f.expect(f.request("/api/v1/integrations"), 200);
  await f.expect(f.request("/api/v1/integrations", { body: { manifest: github.manifest, expectedRevision: integrations.revision } }), 201);
  const application = await f.register(), source = await f.setup(application.appId);
  const hidden = crypto.randomBytes(24).toString("hex"), at = Date.now() - 1000;
  const raw = rawEvent("synthetic-private-import", at, hidden), body = { adapterId: "github-audit", sourceId: source.sourceId, text: JSON.stringify(raw) };
  const service = await f.expect(f.request("/api/v1/service-access", { body: { name: "Synthetic vendor read client" } }), 201);
  const token = service.oneTimeCredential;
  assert.ok(token);
  for (const endpoint of [BASE, BASE + "/preview", BASE + "/import"]) {
    const options = endpoint === BASE ? {} : { body };
    await f.expect(f.request(endpoint, { ...options, anonymous: true }), 401);
    await f.expect(f.request(endpoint, { ...options, headers: { Authorization: "Bearer " + token } }), 401);
    await f.expect(f.request(endpoint, { ...options, anonymous: true, headers: { Authorization: "Bearer " + token } }), 401);
  }
  await f.expect(f.request(BASE + "/preview", { body, headers: { Origin: "https://example.invalid" } }), 403);
  await f.expect(f.request(BASE + "/import", { body, headers: { Origin: "https://example.invalid" } }), 403);
  await f.expect(f.request(BASE + "/preview?sourceId=ignored", { body }), 400);
  await f.expect(f.request(BASE + "/preview", { body, headers: { "Content-Encoding": "gzip" } }), 415);
  await f.expect(f.request(BASE + "/preview", { body: "{broken}" }), 400);
  await f.expect(f.request(BASE + "/preview", { body: { ...body, adapterId: "unknown-adapter" } }), 422);
  await f.expect(f.request(BASE + "/preview", { body: { ...body, adapterId: "gitlab-audit" } }), 409);
  await f.expect(f.request(BASE + "/preview", { body: { ...body, sourceId: "missing-source" } }), 409);
  await f.expect(f.request(BASE + "/preview", { body: { ...body, estateId: application.appId } }), 400);
  await f.expect(f.request(BASE + "/preview", { body: { ...body, previewHash: "0".repeat(64) } }), 400);
  await f.expect(f.request(BASE + "/import", { body }), 409);
  const stats = f.app.runtime.store.stats(), state = JSON.stringify(f.app.runtime.controlState());
  for (const text of ["not-json", "[]", JSON.stringify({ message: hidden }), JSON.stringify([raw, {}]), JSON.stringify(Array(1001).fill(raw)), " ".repeat(MAX_VENDOR_BYTES + 1)]) {
    const result = await f.expect(f.request(BASE + "/preview", { body: { ...body, text } }), 400);
    assert.ok(!JSON.stringify(result).includes(hidden));
    assert.deepEqual(f.app.runtime.store.stats(), stats); assert.equal(JSON.stringify(f.app.runtime.controlState()), state);
  }
  const oversized = await f.declaredRequest(BASE + "/preview", MAX_VENDOR_BYTES * 2 + 4096);
  assert.equal(oversized.status, 413);
  assert.deepEqual(f.app.runtime.store.stats(), stats); assert.equal(JSON.stringify(f.app.runtime.controlState()), state);
  const sourceHealth = f.app.runtime.controlState().sources.find(item => item.sourceId === source.sourceId).health;
  assert.equal(sourceHealth.lastSuccessAt, null);
});

test("vendor operator admission keeps canonical and Trivy boundaries and forbids service/loopback principals", async t => {
  const f = await fixture(t); await f.login();
  const vendors = await f.expect(f.request(BASE), 200), github = vendors.adapters.find(item => item.id === "github-audit");
  const integrations = await f.expect(f.request("/api/v1/integrations"), 200);
  await f.expect(f.request("/api/v1/integrations", { body: { manifest: github.manifest, expectedRevision: integrations.revision } }), 201);
  const application = await f.register(), vendor = await f.setup(application.appId);
  const hidden = crypto.randomBytes(24).toString("hex"), raw = rawEvent("synthetic-boundary-event", Date.now() - 1000, hidden);
  const normalized = normalizeVendorPayload("github-audit", raw, { sourceId: vendor.sourceId, estateId: application.appId });
  await f.command("source.test", { ...f.revision(vendor.sourceId), recordSample: normalized.batch.records[0] });
  await f.command("source.activate", f.revision(vendor.sourceId));
  assert.throws(() => f.app.runtime.ingestVendorAsOperator(normalized.batch, normalized.bodyHash, "github-audit"), { status: 403 });
  assert.throws(() => runAsService("synthetic-service", () => f.app.runtime.ingestVendorAsOperator(normalized.batch, normalized.bodyHash, "github-audit")), { status: 403 });
  assert.throws(() => runAsOperator("synthetic-operator", () => f.app.runtime.ingestVendorAsOperator(normalized.batch, normalized.bodyHash, "gitlab-audit")), { status: 403 });
  const wrongApp = { ...normalized.batch, records: normalized.batch.records.map(item => ({ ...item, estateId: "wrong-app" })) };
  assert.throws(() => runAsOperator("synthetic-operator", () => f.app.runtime.ingestVendorAsOperator(wrongApp, normalized.bodyHash, "github-audit")), { status: 403 });
  const canonical = await f.setup(application.appId, "canonical-events", "audit.event");
  const canonicalBatch = { ...normalized.batch, sourceId: canonical.sourceId, records: normalized.batch.records.map(item => ({ ...item, sourceId: canonical.sourceId })) };
  await f.command("source.test", { ...f.revision(canonical.sourceId), recordSample: canonicalBatch.records[0] });
  await f.command("source.activate", f.revision(canonical.sourceId));
  assert.throws(() => runAsOperator("synthetic-operator", () => f.app.runtime.ingestAsOperator(canonicalBatch, normalized.bodyHash)), { status: 403 });
  assert.throws(() => runAsOperator("synthetic-operator", () => f.app.runtime.ingestVendorAsOperator(canonicalBatch, normalized.bodyHash, "github-audit")), { status: 403 });
  const trivy = await f.setup(application.appId, "trivy-report", "trivy.scan");
  const trivyBatch = { ...normalized.batch, sourceId: trivy.sourceId, records: normalized.batch.records.map(item => ({ ...item, sourceId: trivy.sourceId })) };
  assert.throws(() => runAsOperator("synthetic-operator", () => f.app.runtime.ingestVendorAsOperator(trivyBatch, normalized.bodyHash, "github-audit")), { status: 403 });
  await f.expect(f.request(BASE + "/preview", { body: { adapterId: "github-audit", sourceId: trivy.sourceId, text: JSON.stringify(raw) } }), 409);
  await f.expect(f.request("/api/v1/ingest", { body: canonicalBatch }), 401);
  assert.equal(f.app.runtime.store.stats().records, 0);
});
