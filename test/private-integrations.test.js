"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startPrivateApplication } = require("../server/private-application");
const { REFERENCE_CONNECTOR_MANIFESTS } = require("../server/reference-manifest");
const { validateDocument } = require("../tools/validate-provider");
const { createIntegrationClient } = require("../tools/integration-client");

test("private integration HTTP workflow installs, binds, validates, receives, projects and survives restart", async (t) => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "bb-soc-integration-http-"));
  const stateDirectory = path.join(directory, "state");
  let app;
  t.after(async () => { if (app) await app.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  app = await startPrivateApplication({ stateDirectory, port: 0 });
  const password = crypto.randomBytes(30).toString("base64url");
  await app.authentication.createOperator({ email: "integration@example.invalid", name: "Integration operator", password });
  let cookie = "", serial = 0;
  const request = (url, options = {}) => fetch(app.url + url, {
    method: options.method || (options.body === undefined ? "GET" : "POST"),
    headers: { Origin: app.url, Connection: "close", ...(cookie && !options.anonymous ? { Cookie: cookie } : {}),
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }), ...options.headers },
    ...(options.body === undefined ? {} : { body: typeof options.body === "string" ? options.body : JSON.stringify(options.body) })
  });
  async function expect(responsePromise, status) {
    const response = await responsePromise, body = await response.json(); assert.equal(response.status, status, JSON.stringify(body)); return body;
  }
  for (const endpoint of ["/api/v1/integrations", "/api/v1/integrations/observations"]) await expect(request(endpoint), 401);
  const signed = await request("/api/auth/sign-in/email", { body: { email: "integration@example.invalid", password } });
  assert.equal(signed.status, 200); cookie = signed.headers.getSetCookie().map((value) => value.split(";")[0]).join("; "); await signed.arrayBuffer();
  let catalog = await expect(request("/api/v1/integrations"), 200);
  assert.equal(catalog.recordKinds.length, 29); assert.equal(catalog.integrations.length, 14); assert.ok(catalog.coverage.length > 30);
  const manifest = structuredClone(REFERENCE_CONNECTOR_MANIFESTS.find((item) => item.connectorType === "canonical-events"));
  manifest.connectorType = "reviewed-web-events"; manifest.displayName = "Reviewed application events";
  manifest.supportedSourceKinds = ["application.events"];
  manifest.payload.recordKinds = ["authentication.event", "finding"];
  manifest.targets = [{ route: "/sources", surfaces: ["expected-sources"], recordKinds: manifest.payload.recordKinds }];
  const install = { manifest, expectedRevision: catalog.revision };
  await expect(request("/api/v1/integrations", { body: install, headers: { Origin: "https://example.invalid" } }), 403);
  await expect(request("/api/v1/integrations", { body: install, headers: { Authorization: "Bearer " + crypto.randomBytes(24).toString("base64url") } }), 401);
  await expect(request("/api/v1/integrations", { body: { ...install, module: "not-executable" } }), 422);
  await expect(request("/api/v1/integrations", { body: { ...install, manifest: { ...manifest, credentialSlots: [{ key: "vendor-access", label: "Vendor", kind: "api-key", required: true }] } } }), 422);
  catalog = await expect(request("/api/v1/integrations", { body: install }), 201);
  assert.equal(catalog.integrations.at(-1).available, true);
  await expect(request("/api/v1/integrations", { body: install }), 409);
  const command = async (name, input, status = "succeeded") => {
    const result = await expect(request("/api/v1/control/commands", { body: { schemaVersion: "1", documentType: "connector-command-request", requestId: "integration-ui-" + (++serial), command: name, requestedAt: new Date().toISOString(), input } }), 200);
    assert.equal(result.status, status, JSON.stringify(result)); return result.output;
  };
  const application = await command("app.register", { displayName: "User application", environments: ["staging"], publicPages: [] });
  const setup = await command("source.setup", { appId: application.appId, environment: "staging", connectorType: manifest.connectorType, sourceKind: "application.events", displayName: "Application audit feed", config: { "cadence-seconds": 300 }, credentialReferences: [] });
  const revision = () => ({ sourceId: setup.sourceId, connectorInstanceId: setup.connectorInstanceId, expectedRevision: app.runtime.controlState().sources.find((item) => item.sourceId === setup.sourceId).revision });
  const record = { schemaVersion: "1", documentType: "normalized-record", recordId: "event-auth-1", sourceId: setup.sourceId, estateId: application.appId, kind: "authentication.event", observedAt: new Date().toISOString(), payload: { title: "Application sign-in observation", state: "unknown", identityRef: "pseudonymous-user", category: "sign-in" } };
  await command("source.test", { ...revision(), recordSample: { ...record, estateId: "different-application" } }, "failed");
  await command("source.test", { ...revision(), recordSample: record });
  assert.equal(app.runtime.store.stats().records, 0, "validation cannot store a sample as telemetry");
  const activation = await command("source.activate", revision());
  const tokenFile = path.join(directory, "source-key"); fs.writeFileSync(tokenFile, activation.oneTimeCredential.value + "\n", { mode: 0o600 });
  const sender = createIntegrationClient({ baseUrl: app.url, tokenFile });
  const batch = { schemaVersion: "1", documentType: "ingest-batch", sourceId: setup.sourceId, receiptId: "integration-http-receipt-1", sentAt: new Date().toISOString(), records: [record, { ...record, recordId: "event-finding-1", kind: "finding", payload: { title: "Reported application finding", state: "open", severity: "high" } }] };
  const receipt = await sender.sendBatch(batch); assert.equal(receipt.accepted, 2); assert.equal(receipt.replay, false);
  assert.equal((await sender.sendBatch(batch)).replay, true);
  const observations = await expect(request("/api/v1/integrations/observations?appId=" + application.appId + "&kinds=finding&limit=1"), 200);
  assert.equal(observations.matched, 1); assert.equal(observations.records[0].kind, "finding"); assert.equal(observations.sourceContexts[0].environment, "staging");
  for (const query of ["limit=0", "limit=0x10", "limit=201", "offset=-1", "kinds=arbitrary", "sourceId=one&sourceId=two", "rawSql=anything"]) await expect(request("/api/v1/integrations/observations?" + query), 400);
  const page = await expect(request("/api/v1/pages?route=%2Ftriage"), 200);
  validateDocument(page); assert.equal(page.state, "ready"); assert.match(JSON.stringify(page), /Reported application finding/);
  assert.equal(app.administrationRuntime.getState().risks.length, 0, "upstream observations do not author local risk records");
  catalog = await expect(request("/api/v1/integrations"), 200);
  await expect(request("/api/v1/integrations/" + manifest.connectorType, { method: "DELETE", body: { expectedRevision: catalog.revision } }), 409);
  const unused = { ...manifest, connectorType: "unused-web-events" };
  catalog = await expect(request("/api/v1/integrations", { body: { manifest: unused, expectedRevision: catalog.revision } }), 201);
  catalog = await expect(request("/api/v1/integrations/" + unused.connectorType, { method: "DELETE", body: { expectedRevision: catalog.revision } }), 200);
  assert.ok(!catalog.integrations.some((item) => item.manifest.connectorType === unused.connectorType));
  const port = Number(new URL(app.url).port); await app.close(); app = null;
  app = await startPrivateApplication({ stateDirectory, port });
  catalog = await expect(request("/api/v1/integrations"), 200); assert.ok(catalog.integrations.some((item) => item.manifest.connectorType === manifest.connectorType));
  assert.equal((await sender.sendBatch(batch)).replay, true);
  await command("source.pause", revision());
  await assert.rejects(() => sender.sendBatch(batch));
  assert.equal(app.runtime.store.stats().records, 2);
});
