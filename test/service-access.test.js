"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createServiceAccessStore, SCOPES, DEFAULT_SCOPES } = require("../server/service-access");
const { operatorId } = require("../server/operator-context");
const { startPrivateApplication } = require("../server/private-application");
const { ControlPlaneClient, createMcpServer, MODERN_PROTOCOL, readServiceTokenFile, parseArguments } = require("../tools/agent-mcp");

const actor = operatorId("service-access-test-operator");
function temporary(t) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "bb-soc-service-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("service store defaults to explicit read scopes, persists hashes only, rotates and revokes with optimistic revisions", (t) => {
  const directory = temporary(t); let store = createServiceAccessStore({ stateDir: directory });
  t.after(() => store.close());
  const issued = store.issue({ name: "Read-only integration" }, actor);
  assert.deepEqual(issued.service.scopes, DEFAULT_SCOPES);
  assert.equal(issued.service.revision, 1);
  assert.match(issued.oneTimeCredential, /^bbsvc_service-/);
  assert.equal(store.authenticate(issued.oneTimeCredential).id, issued.service.id);
  assert.doesNotMatch(JSON.stringify(store.list()), /bbsvc_/);
  assert.throws(() => store.authorize(issued.oneTimeCredential, "connector:app.register", "app.register"), { status: 403 });
  assert.equal(store.authorize(issued.oneTimeCredential, "connector:read", "connector.snapshot").id, issued.service.id);
  assert.throws(() => store.change(issued.service.id, "rotate", { expectedRevision: 9 }, actor), { status: 409 });
  const rotated = store.change(issued.service.id, "rotate", { expectedRevision: 1 }, actor);
  assert.notEqual(rotated.oneTimeCredential, issued.oneTimeCredential);
  assert.equal(rotated.service.expiresAt, issued.service.expiresAt);
  assert.throws(() => store.authenticate(issued.oneTimeCredential), { status: 401 });
  store.close(); store = createServiceAccessStore({ stateDir: directory });
  assert.equal(store.authenticate(rotated.oneTimeCredential).revision, 2);
  const revoked = store.change(issued.service.id, "revoke", { expectedRevision: 2 }, actor);
  assert.equal(revoked.service.status, "revoked");
  assert.throws(() => store.authenticate(rotated.oneTimeCredential), { status: 401 });
  const audit = store.list().audit;
  assert.ok(audit.some(entry => entry.outcome === "denied"));
  assert.ok(audit.some(entry => entry.actor === "service:" + issued.service.id));
  for (const filename of fs.readdirSync(directory)) {
    const bytes = fs.readFileSync(path.join(directory, filename));
    assert.equal(bytes.includes(Buffer.from(issued.oneTimeCredential)), false, "initial credential must not be stored");
    assert.equal(bytes.includes(Buffer.from(rotated.oneTimeCredential)), false, "rotated credential must not be stored");
  }
});

test("service expiry, fixed scopes, limits and durable per-minute rate gate fail closed", (t) => {
  const directory = temporary(t); let clock = new Date("2026-09-29T10:00:00Z");
  let store = createServiceAccessStore({ stateDir: directory, clock: () => clock }); t.after(() => store.close());
  assert.throws(() => store.issue({ name: "No human" }, "service:other"), { status: 403 });
  assert.throws(() => store.issue({ name: "Wildcard", scopes: ["*"] }, actor), { status: 400 });
  assert.throws(() => store.issue({ name: "Too long", expiresInSeconds: 2592001 }, actor), { status: 400 });
  assert.throws(() => store.issue({ name: "Empty", scopes: [] }, actor), { status: 400 });
  for (const forbidden of ["connector:source.activate", "connector:source.rotate", "connector:host.enroll", "administration:enrollment.issue", "administration:agent.create", "administration:agent.update", "administration:prompt.activate"]) assert.equal(SCOPES.includes(forbidden), false);
  const issued = store.issue({ name: "Limited", expiresInSeconds: 300 }, actor);
  for (let i = 0; i < 120; i++) store.authorize(issued.oneTimeCredential, "connector:read", "connector.snapshot");
  assert.throws(() => store.authorize(issued.oneTimeCredential, "connector:read", "connector.snapshot"), { status: 429 });
  store.close(); store = createServiceAccessStore({ stateDir: directory, clock: () => clock });
  assert.throws(() => store.authorize(issued.oneTimeCredential, "connector:read", "connector.snapshot"), { status: 429 });
  clock = new Date(clock.getTime() + 60000);
  assert.doesNotThrow(() => store.authorize(issued.oneTimeCredential, "connector:read", "connector.snapshot"));
  clock = new Date(clock.getTime() + 240000);
  assert.equal(store.list().services[0].status, "expired");
  assert.throws(() => store.authenticate(issued.oneTimeCredential), { status: 401 });
  assert.throws(() => store.change(issued.service.id, "rotate", { expectedRevision: 1 }, actor), { status: 409 });
});

test("MCP loads only canonical owner-only token files and never accepts raw token arguments", (t) => {
  const directory = temporary(t); const store = createServiceAccessStore({ stateDir: directory }); t.after(() => store.close());
  const issued = store.issue({ name: "MCP file" }, actor);
  const file = path.join(directory, "mcp-credential");
  fs.writeFileSync(file, issued.oneTimeCredential + "\n", { mode: 0o600 });
  assert.equal(readServiceTokenFile(file), issued.oneTimeCredential);
  assert.deepEqual(parseArguments(["--base-url", "http://127.0.0.1:8080", "--token-file", file], {}), { baseUrl: "http://127.0.0.1:8080", tokenFile: file });
  assert.equal(parseArguments([], { SOC_AGENT_MCP_TOKEN_FILE: file }).tokenFile, file);
  assert.throws(() => parseArguments(["--token", issued.oneTimeCredential], {}), error => !error.message.includes(issued.oneTimeCredential));
  fs.chmodSync(file, 0o640); assert.throws(() => readServiceTokenFile(file), /owner-only/); fs.chmodSync(file, 0o600);
  const link = path.join(directory, "linked"); fs.symlinkSync(file, link); assert.throws(() => readServiceTokenFile(link), /owner-only/);
  const hardlink = path.join(directory, "hardlinked"); fs.linkSync(file, hardlink); assert.throws(() => readServiceTokenFile(file), /owner-only/);
  fs.unlinkSync(hardlink);
  fs.writeFileSync(file, "not-a-service-credential", { mode: 0o600 }); assert.throws(() => readServiceTokenFile(file), /owner-only/);
  const host = ["private", "example", "ts", "net"].join(".");
  assert.throws(() => new ControlPlaneClient({ baseUrl: "https://" + host }), /explicit service token file/);
});

test("service database rejects linked and permissive state files", (t) => {
  const directory = temporary(t); const state = path.join(directory, "state"); fs.mkdirSync(state, { mode: 0o700 });
  const store = createServiceAccessStore({ stateDir: state }); store.close();
  const filename = path.join(state, "service-access.sqlite");
  fs.chmodSync(filename, 0o644); assert.throws(() => createServiceAccessStore({ stateDir: state }), /private regular/);
  fs.chmodSync(filename, 0o600);
  const linked = path.join(directory, "linked-state"); fs.symlinkSync(state, linked);
  assert.throws(() => createServiceAccessStore({ stateDir: linked }), /linked directories/);
});

test("private HTTP and MCP enforce distinct service identities, exact scopes, non-escalation and rotation across restart", async (t) => {
  const directory = temporary(t); const state = path.join(directory, "state"); fs.mkdirSync(state, { mode: 0o700 });
  let app = await startPrivateApplication({ stateDirectory: state, port: 0 });
  t.after(async () => app && app.close());
  const password = crypto.randomBytes(30).toString("base64url");
  const operator = await app.authentication.createOperator({ name: "Service test operator", email: "service-operator@example.invalid", password });
  const signed = await fetch(app.url + "/api/auth/sign-in/email", { method: "POST", headers: { Origin: app.url, "Content-Type": "application/json" }, body: JSON.stringify({ email: operator.email, password }) });
  assert.equal(signed.status, 200); await signed.arrayBuffer();
  const cookie = signed.headers.getSetCookie().map(entry => entry.split(";")[0]).join("; ");
  const human = (endpoint, method = "GET", body, bearer) => fetch(app.url + endpoint, { method,
    headers: { Connection: "close", Origin: app.url, Cookie: cookie, ...(body ? { "Content-Type": "application/json" } : {}), ...(bearer ? { Authorization: "Bearer " + bearer } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const serviceRequest = (endpoint, bearer, method = "GET", body, browserCookie) => fetch(app.url + endpoint, { method,
    headers: { Connection: "close", ...(bearer ? { Authorization: "Bearer " + bearer } : {}), ...(browserCookie ? { Cookie: browserCookie } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  async function expectStatus(response, expected) { const value = await response; assert.equal(value.status, expected); return value.json(); }
  const readonly = await expectStatus(human("/api/v1/service-access", "POST", { name: "Read-only service" }), 201);
  await expectStatus(serviceRequest("/api/v1/service/control/snapshot", readonly.oneTimeCredential), 200);
  await expectStatus(serviceRequest("/api/v1/service/administration/snapshot?domain=agents", readonly.oneTimeCredential), 200);
  await expectStatus(serviceRequest("/api/v1/service/control/snapshot", null, "GET", undefined, cookie), 401);
  await expectStatus(serviceRequest("/api/v1/service/control/snapshot", readonly.oneTimeCredential, "GET", undefined, cookie), 401);
  await expectStatus(serviceRequest("/api/v1/control/snapshot", readonly.oneTimeCredential), 401);
  await expectStatus(serviceRequest("/api/v1/service-access", readonly.oneTimeCredential), 401);
  await expectStatus(human("/api/v1/service-access", "GET", undefined, readonly.oneTimeCredential), 401);
  await expectStatus(human("/api/v1/control/snapshot", "GET", undefined, readonly.oneTimeCredential), 401);
  await expectStatus(serviceRequest("/api/v1/service/administration/prompts?promptId=prompt-one", readonly.oneTimeCredential), 403);
  const command = (name, input, id = crypto.randomUUID()) => ({ schemaVersion: "1", documentType: "connector-command-request", command: name, requestId: id, requestedAt: new Date().toISOString(), input });
  const register = command("app.register", { displayName: "Service-managed application", publicPages: [], environments: ["development"] });
  await expectStatus(serviceRequest("/api/v1/service/control/commands", readonly.oneTimeCredential, "POST", register), 403);
  const writer = await expectStatus(human("/api/v1/service-access", "POST", { name: "Narrow registration", scopes: [...DEFAULT_SCOPES, "connector:app.register"] }), 201);
  const saved = await expectStatus(serviceRequest("/api/v1/service/control/commands", writer.oneTimeCredential, "POST", register), 200);
  assert.equal(saved.status, "succeeded");
  const snapshot = await expectStatus(serviceRequest("/api/v1/service/control/snapshot", writer.oneTimeCredential), 200);
  assert.equal(snapshot.apps.length, 1);
  const sourceActivate = command("source.activate", { sourceId: "source-one", connectorInstanceId: "connector-one", expectedRevision: 0 });
  await expectStatus(serviceRequest("/api/v1/service/control/commands", writer.oneTimeCredential, "POST", sourceActivate), 403);
  const sourceRotate = command("source.rotate", { sourceId: "source-one", connectorInstanceId: "connector-one", expectedRevision: 0 });
  await expectStatus(serviceRequest("/api/v1/service/control/commands", writer.oneTimeCredential, "POST", sourceRotate), 403);
  const admin = { schemaVersion: "1", documentType: "administration-command-request", requestId: crypto.randomUUID(), requestedAt: new Date().toISOString(), expectedRevision: 0,
    command: "agent.create", input: { displayName: "Must not create", kind: "automation", capabilities: ["triage:read"] } };
  await expectStatus(serviceRequest("/api/v1/service/administration/commands", writer.oneTimeCredential, "POST", admin), 403);
  const governance = await expectStatus(human("/api/v1/service-access", "POST", { name: "Risk registrar", scopes: ["governance:read", "administration:risk.create"] }), 201);
  const risk = { ...admin, command: "risk.create", requestId: crypto.randomUUID(), input: { title: "Integration-owned risk", likelihood: "low", impact: "moderate" } };
  await expectStatus(serviceRequest("/api/v1/service/administration/commands", readonly.oneTimeCredential, "POST", risk), 403);
  assert.equal((await expectStatus(serviceRequest("/api/v1/service/administration/commands", governance.oneTimeCredential, "POST", risk), 200)).status, "succeeded");
  const governanceView = await expectStatus(serviceRequest("/api/v1/service/administration/snapshot?domain=governance", governance.oneTimeCredential), 200);
  assert.equal(governanceView.risks.length, 1);
  await expectStatus(serviceRequest("/api/v1/service/administration/snapshot?domain=agents", governance.oneTimeCredential), 403);
  const enrollment = { ...admin, command: "enrollment.issue", requestId: crypto.randomUUID(), input: { agentId: "agent-one", expiresInSeconds: 300 } };
  await expectStatus(serviceRequest("/api/v1/service/administration/commands", governance.oneTimeCredential, "POST", enrollment), 403);
  const adminAudit = fs.readFileSync(path.join(state, "administration-audit.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(adminAudit.some(entry => entry.command === "risk.create" && entry.phase === "commit" && entry.actor === "service:" + governance.service.id));
  const credentialFile = path.join(directory, "agent-credential"); fs.writeFileSync(credentialFile, readonly.oneTimeCredential, { mode: 0o600 });
  const client = new ControlPlaneClient({ baseUrl: app.url, tokenFile: credentialFile,
    fetchImpl: (url, options) => fetch(url, { ...options, headers: { ...options.headers, Connection: "close" } }) });
  assert.equal((await client.connectorSnapshot({})).apps.length, 1);
  await assert.rejects(() => client.connectorCommand(register), error => error.status === 403);
  await assert.rejects(() => client.administrationCommand(admin), /privilege-expanding/);
  const mcp = createMcpServer({ client });
  const mcpResult = await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "administration_snapshot", arguments: { domain: "agents" }, _meta: { "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL } } });
  assert.equal(mcpResult.result.structuredContent.domain, "agents");
  assert.equal(mcpResult.result.structuredContent.agents.length, 0, "service-denied agent creation cannot add or expand an agent identity");
  assert.equal(app.authentication.countOperators(), 1, "service operations cannot provision additional human accounts");
  assert.doesNotMatch(JSON.stringify(mcpResult), /bbsvc_/);
  const rotated = await expectStatus(human("/api/v1/service-access/" + readonly.service.id + "/rotate", "POST", { expectedRevision: 1 }), 200);
  await assert.rejects(() => client.connectorSnapshot({}), error => error.status === 401);
  fs.writeFileSync(credentialFile, rotated.oneTimeCredential, { mode: 0o600 });
  assert.equal((await client.connectorSnapshot({})).apps.length, 1, "MCP rereads the protected file for rotation");
  const audit = app.runtime.store.db.prepare("SELECT json FROM telemetry_audit").all().map(row => JSON.parse(row.json));
  assert.ok(audit.some(entry => entry.action === "app.register" && entry.phase === "commit" && entry.actor === "service:" + writer.service.id));
  const port = Number(new URL(app.url).port); await app.close(); app = null;
  app = await startPrivateApplication({ stateDirectory: state, port });
  assert.equal((await client.connectorSnapshot({})).apps.length, 1);
  await expectStatus(human("/api/v1/service-access/" + readonly.service.id + "/revoke", "POST", { expectedRevision: 2 }), 200);
  await assert.rejects(() => client.connectorSnapshot({}), error => error.status === 401);
});
