"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startPrivateApplication, validatePrivateRequest } = require("../server/private-application");
const { validateDocument } = require("../tools/validate-provider");
const { runAsOperator } = require("../server/operator-context");

test("private origin rejects public hosts, foreign origins and browser CSRF without trusting proxy headers", () => {
  const origin = "http://127.0.0.1:8080";
  const req = { url: "/api/v1/control/commands", method: "POST", headers: { host: "127.0.0.1:8080", origin } };
  assert.doesNotThrow(() => validatePrivateRequest(req, origin));
  for (const headers of [ { ...req.headers, host: "app.example.invalid" }, { host: req.headers.host },
    { ...req.headers, origin: "https://app.example.invalid" }, { ...req.headers, "sec-fetch-site": "cross-site" } ]) {
    assert.throws(() => validatePrivateRequest({ ...req, headers }, origin), /Host|Origin|origin|Cross-site/);
  }
  assert.doesNotThrow(() => validatePrivateRequest({ ...req, url: "/api/v1/ingest", headers: { host: req.headers.host } }, origin));
});

test("private sign-in gates all operator APIs and documents persist with authenticated version history", async (t) => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "bb-soc-private-test-"));
  let app;
  t.after(async () => { if (app) await app.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  app = await startPrivateApplication({ stateDirectory: directory, port: 0 });
  const password = crypto.randomBytes(30).toString("base64url");
  await app.authentication.createOperator({ email: "owner@example.invalid", name: "Test owner", password });
  let cookie;
  const request = (url, options = {}) => fetch(app.url + url, {
    ...options, headers: { Origin: app.url, Connection: "close", ...(cookie ? { Cookie: cookie } : {}), ...options.headers }
  });
  for (const endpoint of ["/api/v1/control/snapshot", "/api/v1/administration/snapshot?domain=agents", "/api/v1/pages", "/api/v1/administration/prompts?promptId=any", "/api/v1/documents", "/api/v1/telemetry/storage", "/api/v1/service-access"]) {
    assert.equal((await request(endpoint)).status, 401, endpoint);
  }
  assert.deepEqual(await (await request("/api/v1/session")).json(), { authenticated: false });
  assert.match(await (await request("/app-config.js")).text(), /required: true/);
  assert.match(await (await request("/sign-in")).text(), /Sign in to your SOC/);
  for (const url of ["/node_modules/better-auth/package.json", "/auth.sqlite", "/auth-secret", "/package-lock.json"]) assert.equal((await request(url)).status, 404);
  const signUp = await request("/api/auth/sign-up/email", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "stranger@example.invalid", password, name: "Stranger" }) });
  assert.equal(signUp.status, 404);
  const signed = await request("/api/auth/sign-in/email", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "owner@example.invalid", password }) });
  assert.equal(signed.status, 200);
  cookie = signed.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  assert.ok(cookie);
  const signedBody = await signed.json();
  assert.equal(signedBody.token, undefined);
  const session = await (await request("/api/v1/session")).json();
  assert.equal(session.authenticated, true);
  assert.equal(session.display.name, "Test owner");
  assert.equal((await request("/api/v1/control/snapshot")).status, 200);
  const storage = await (await request("/api/v1/telemetry/storage")).json();
  assert.equal(storage.records, 0);
  assert.equal(storage.retention.maxRecords, 100000);
  assert.equal((await request("/api/v1/telemetry/storage?unknown=1")).status, 400);
  for (const vtab of ["policy", "reality"]) {
    const retention = await (await request("/api/v1/pages?route=%2Fretention&vtab=" + vtab)).json();
    assert.doesNotThrow(() => validateDocument(retention));
    assert.equal(retention.state, "ready");
    assert.match(JSON.stringify(retention), /telemetry/i);
  }
  const access = await (await request("/api/v1/pages?route=%2Faccess&atab=who")).json();
  assert.equal(access.state, "ready");
  assert.doesNotThrow(() => validateDocument(access));
  assert.deepEqual(access.panels.find((panel) => panel.id === "who-has-full-access").rows, [["Test owner", "Full operator", "All private application reads and writes"]]);
  // Imported identity facts have their own explicit tab and cannot substitute
  // for, or grant, actual local application permissions.
  let accessSequence = 0;
  const accessCommand = (command, input) => {
    const result = runAsOperator("access-projection-test", () => app.runtime.execute({ schemaVersion: "1", documentType: "connector-command-request",
      requestId: "access-proof-" + (++accessSequence), requestedAt: new Date().toISOString(), command, input }));
    assert.equal(result.status, "succeeded");
    return result.output;
  };
  const externalApp = accessCommand("app.register", { displayName: "External identity provider", environments: ["test"], publicPages: [] });
  const externalSource = accessCommand("source.setup", { appId: externalApp.appId, environment: "test", connectorType: "canonical-events", sourceKind: "identity.access",
    displayName: "External access claims", config: { "cadence-seconds": 300 }, credentialReferences: [] });
  const identityFact = { schemaVersion: "1", documentType: "normalized-record", recordId: "external-access-claim", sourceId: externalSource.sourceId,
    estateId: externalApp.appId, kind: "identity.access", observedAt: new Date().toISOString(),
    payload: { title: "External provider access claim", state: "active", identityRef: "external-identity" } };
  const testedSource = accessCommand("source.test", { sourceId: externalSource.sourceId, connectorInstanceId: externalSource.connectorInstanceId,
    expectedRevision: externalSource.revision, recordSample: identityFact });
  const activeSource = accessCommand("source.activate", { sourceId: externalSource.sourceId, connectorInstanceId: externalSource.connectorInstanceId,
    expectedRevision: testedSource.revision });
  const identityBatch = { schemaVersion: "1", documentType: "ingest-batch", sourceId: externalSource.sourceId,
    receiptId: "external-access-receipt", sentAt: new Date().toISOString(), records: [identityFact] };
  app.runtime.ingest(identityBatch, activeSource.oneTimeCredential.value, crypto.createHash("sha256").update(JSON.stringify(identityBatch)).digest("hex"));
  const importedAccess = await (await request("/api/v1/pages?route=%2Faccess&atab=observations")).json();
  assert.doesNotThrow(() => validateDocument(importedAccess));
  assert.equal(importedAccess.state, "ready");
  assert.equal(importedAccess.panels.find((panel) => panel.id === "imported-observations").rows.length, 1);
  assert.match(JSON.stringify(importedAccess), /External provider access claim/);
  assert.match(importedAccess.panels[0].body, /Who tab for actual local application permissions/);
  assert.equal(importedAccess.panels.some((panel) => panel.id === "who-has-full-access"), false);
  for (const suffix of ["", "&atab=who"]) {
    const actualAccess = await (await request("/api/v1/pages?route=%2Faccess" + suffix)).json();
    assert.doesNotThrow(() => validateDocument(actualAccess));
    assert.deepEqual(actualAccess.panels.find((panel) => panel.id === "who-has-full-access").rows, [["Test owner", "Full operator", "All private application reads and writes"]]);
    assert.equal(actualAccess.panels.some((panel) => panel.id === "imported-observations"), false);
  }
  const upload = async (metadata, bytes) => request("/api/v1/documents/upload", { method: "POST", headers: {
    "Content-Type": "application/octet-stream", "X-Document-Metadata": encodeURIComponent(JSON.stringify(metadata))
  }, body: bytes });
  let response = await upload({ expectedRevision: 0, metadata: { title: "Operator policy", status: "draft", linkKind: "policy", linkId: "policy-example" }, filename: "policy.md", mime: "text/markdown" }, "# Policy\n");
  assert.equal(response.status, 201, await response.clone().text());
  let record = await response.json();
  const id = record.document.id;
  response = await request("/api/v1/documents/" + id, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision: record.document.revision, patch: { status: "current" } }) });
  assert.equal(response.status, 200);
  record = await response.json();
  const version = await upload({ documentId: id, expectedRevision: record.document.revision, filename: "policy.md", mime: "text/markdown" }, "# Updated policy\n");
  assert.equal(version.status, 201, await version.clone().text());
  const downloaded = await request("/api/v1/documents/" + id + "/versions/1/download");
  assert.equal(downloaded.status, 200);
  assert.match(downloaded.headers.get("content-disposition"), /^attachment/);
  assert.equal(await downloaded.text(), "# Policy\n");
  assert.equal((await request("/api/v1/documents/" + id + "/versions/1/download", {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision: 3, patch: { status: "retired" } })
  })).status, 405, "download path never accepts metadata updates");
  const oldURL = app.url;
  await app.close(); app = null;
  app = await startPrivateApplication({ stateDirectory: directory, port: Number(new URL(oldURL).port) });
  assert.equal((await (await request("/api/v1/session")).json()).authenticated, true, "session survives restart");
  record = await (await request("/api/v1/documents/" + id)).json();
  assert.equal(record.versions.length, 2);
  assert.equal(record.document.status, "current");
  assert.ok(record.history.every((entry) => entry.actor.startsWith("operator:")));
  const signOut = await request("/api/auth/sign-out", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(signOut.status, 200);
  assert.equal((await request("/api/v1/documents")).status, 401, "old session cookie is invalid after sign-out");
});
