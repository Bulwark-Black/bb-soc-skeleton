"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { startPrivateApplication } = require("../server/private-application");
const { ControlPlaneClient } = require("../tools/agent-mcp");
const { runAsOperator, operatorId } = require("../server/operator-context");

test("setup MCP reads require their own explicit scope and cannot mutate guides or inspect secrets", async t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "bb-setup-agent-")), state = path.join(root, "state"); fs.mkdirSync(state, { mode: 0o700 });
  const app = await startPrivateApplication({ stateDirectory: state, port: 0, monitoring: { autoStart: false, fetchImpl: async () => { throw new Error("No outbound access in this test."); } } });
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const actor = operatorId("synthetic-operator");
  const registered = runAsOperator("synthetic-operator", () => app.runtime.execute({ schemaVersion: "1", documentType: "connector-command-request", command: "app.register", requestId: "setup-agent-register", requestedAt: new Date().toISOString(), input: { displayName: "Synthetic application", environments: ["test"], hosts: [], publicPages: [] } }));
  assert.equal(registered.status, "succeeded"); const appId = registered.output.appId;
  app.setupGuides.create({ appId, environment: "test", path: "custom", expectedRevision: 0 }, actor);
  const read = app.serviceAccess.issue({ name: "Read setup only", scopes: ["setup:read"] }, actor);
  const ordinary = app.serviceAccess.issue({ name: "Default registry reader" }, actor);
  const tokenFile = path.join(root, "reader-key"); fs.writeFileSync(tokenFile, read.oneTimeCredential, { mode: 0o600 });
  const client = new ControlPlaneClient({ baseUrl: app.url, tokenFile });
  const guides = await client.setupGuides(); assert.equal(guides.plans.length, 1); assert.equal(guides.plans[0].appId, appId);
  const result = await client.setupCheck({ appId, environment: "test", path: "custom" });
  assert.ok(result.checks.some(item => item.state === "waiting")); assert.equal(result.sourceId, null);
  assert.equal(app.setupGuides.list().revision, 1, "reads do not change saved choices");
  await assert.rejects(() => client.connectorSnapshot({}), error => error.status === 403);
  await assert.rejects(() => client.setupCheck({ appId, environment: "test", path: "custom", token: "not-used" }), /unsupported|unexpected/i);
  for (const endpoint of ["/api/v1/service/setup", "/api/v1/service/setup/check?appId=" + appId + "&environment=test&path=custom"]) {
    const denied = await fetch(app.url + endpoint, { headers: { Authorization: "Bearer " + ordinary.oneTimeCredential } });
    assert.equal(denied.status, 403); await denied.arrayBuffer();
    const mixed = await fetch(app.url + endpoint, { headers: { Authorization: "Bearer " + read.oneTimeCredential, Cookie: "synthetic=value" } });
    assert.equal(mixed.status, 401); await mixed.arrayBuffer();
  }
  const mutation = await fetch(app.url + "/api/v1/service/setup/plans", { method: "POST", headers: { Authorization: "Bearer " + read.oneTimeCredential, "Content-Type": "application/json" }, body: "{}" });
  assert.equal(mutation.status, 404); await mutation.arrayBuffer();
  const noToken = new ControlPlaneClient({ baseUrl: app.url, fetchImpl: async () => { throw new Error("Must reject before network"); } });
  await assert.rejects(() => noToken.setupGuides(), /private service token file/);
  await assert.rejects(() => noToken.setupCheck({ appId, environment: "test", path: "custom" }), /private service token file/);
  for (const bad of [{ ...result, appId: "another-app" }, { ...result, token: "private" }, { ...result, checks: [{ id: "binding", title: "Redirect", state: "pass", detail: "Untrusted", href: "https://example.invalid/" }] }]) {
    const mock = new ControlPlaneClient({ baseUrl: app.url, tokenFile, fetchImpl: async () => new Response(JSON.stringify(bad), { headers: { "Content-Type": "application/json" } }) });
    await assert.rejects(() => mock.setupCheck({ appId, environment: "test", path: "custom" }), /invalid|response/i);
  }
});
