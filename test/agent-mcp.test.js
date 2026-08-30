"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");
const {
  ControlPlaneClient,
  DEFAULT_BASE_URL,
  MODERN_PROTOCOL,
  RESOURCE_DEFINITIONS,
  TOOL_DEFINITIONS,
  createMcpServer,
  parseArguments,
  readResource,
  validateBaseUrl
} = require("../tools/agent-mcp");

const ROOT = path.resolve(__dirname, "..");
const AT = "2026-08-30T10:00:00Z";
const PROTOCOL_KEY = "io.modelcontextprotocol/protocolVersion";

function modernParams(value = {}) {
  return { ...value, _meta: { [PROTOCOL_KEY]: MODERN_PROTOCOL } };
}

function rpc(id, method, params) {
  return { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
}

function response(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function testUrl(scheme, authority, suffix = "") {
  return [scheme, ":", "/", "/", authority, suffix].join("");
}

function connectorSnapshot() {
  return {
    schemaVersion: "1",
    documentType: "connector-control-snapshot",
    connectorTypes: [],
    apps: [],
    hosts: [],
    connectorInstances: [],
    setups: [],
    sources: [],
    changes: [],
    revision: 0
  };
}

function administrationSnapshot(domain) {
  return domain === "agents" ? {
    schemaVersion: "1",
    documentType: "agent-administration-snapshot",
    domain: "agents",
    revision: 0,
    agents: [],
    prompts: [],
    enrollments: [],
    changes: []
  } : {
    schemaVersion: "1",
    documentType: "governance-administration-snapshot",
    domain: "governance",
    revision: 0,
    attestations: [],
    risks: [],
    changes: []
  };
}

function connectorCommandRequest(command = "app.register") {
  if (command === "host.enroll") {
    return {
      schemaVersion: "1",
      documentType: "connector-command-request",
      requestId: "request-host-enroll",
      command,
      requestedAt: AT,
      input: { appId: "app-one", hostId: "host-one" }
    };
  }
  return {
    schemaVersion: "1",
    documentType: "connector-command-request",
    requestId: "request-register",
    command,
    requestedAt: AT,
    input: { displayName: "Application", hosts: ["host-one"], publicPages: [] }
  };
}

function administrationCommandRequest(command = "agent.create") {
  if (command === "enrollment.issue") {
    return {
      schemaVersion: "1",
      documentType: "administration-command-request",
      requestId: "request-enrollment-issue",
      command,
      requestedAt: AT,
      expectedRevision: 0,
      input: { agentId: "agent-one", expiresInSeconds: 300 }
    };
  }
  return {
    schemaVersion: "1",
    documentType: "administration-command-request",
    requestId: "request-agent-create",
    command,
    requestedAt: AT,
    expectedRevision: 0,
    input: {
      displayName: "Triage agent",
      kind: "automation",
      capabilities: ["triage:read"]
    }
  };
}

test("base URL accepts exact loopback and private HTTPS origins but rejects arbitrary destinations", () => {
  const privateV4 = ["10", "22", "0", "7"].join(".");
  const overlayV4 = ["100", "70", "1", "2"].join(".");
  const privateDns = ["console", "team", ["ts", "net"].join(".")].join(".");

  assert.equal(validateBaseUrl(), DEFAULT_BASE_URL);
  assert.equal(validateBaseUrl("http://localhost:9000"), "http://localhost:9000");
  assert.equal(validateBaseUrl(testUrl("http", "[::1]:9000")), testUrl("http", "[::1]:9000"));
  assert.equal(validateBaseUrl(testUrl("https", `${privateV4}:9443`)), testUrl("https", `${privateV4}:9443`));
  assert.equal(validateBaseUrl(testUrl("https", overlayV4)), testUrl("https", overlayV4));
  assert.equal(validateBaseUrl(testUrl("https", "[fd00::7]:9443")), testUrl("https", "[fd00::7]:9443"));
  assert.equal(validateBaseUrl(testUrl("https", privateDns)), testUrl("https", privateDns));

  [
    testUrl("http", privateV4),
    "https://example.invalid",
    "https://127.0.0.1.example.invalid",
    testUrl("http", "localhost.example.invalid"),
    "file:///tmp/control",
    "http://user:password@localhost:8787",
    "http://localhost:8787/api",
    "http://localhost:8787/?target=x",
    testUrl("http", "localhost:0"),
    "http://127.1:8787",
    "http://2130706433:8787",
    "http://127%2e0%2e0%2e1:8787"
  ].forEach((value) => assert.throws(() => validateBaseUrl(value), TypeError, value));

  assert.deepEqual(parseArguments([], {}), { baseUrl: DEFAULT_BASE_URL });
  assert.deepEqual(parseArguments(["--base-url", "http://localhost:8787"], {}), {
    baseUrl: "http://localhost:8787"
  });
  assert.throws(() => parseArguments(["--unknown"], {}), /unknown|incomplete/i);
});

test("resources are a fixed allowlist of public docs and contracts", async () => {
  assert.equal(RESOURCE_DEFINITIONS.length >= 12, true);
  assert.equal(new Set(RESOURCE_DEFINITIONS.map((entry) => entry.uri)).size, RESOURCE_DEFINITIONS.length);
  assert.equal(RESOURCE_DEFINITIONS.every((entry) => entry.uri.startsWith("soc://")), true);
  const technical = await readResource("soc://documentation/technical-manual");
  assert.equal(technical.mimeType, "text/markdown");
  assert.match(technical.text, /^# Bulwark Black SOC technical implementation manual/m);
  const administration = await readResource("soc://contracts/administration-v1-schema");
  assert.doesNotThrow(() => JSON.parse(administration.text));
  await assert.rejects(() => readResource("soc://documentation/../../private"), /unknown resource/i);
});

test("tool inventory is narrow, deterministic, closed, and contains no generic execution or credential surface", () => {
  assert.deepEqual(TOOL_DEFINITIONS.map((entry) => entry.name), [
    "connector_snapshot",
    "connector_command",
    "administration_snapshot",
    "administration_prompt",
    "administration_command"
  ]);
  const serialized = JSON.stringify(TOOL_DEFINITIONS).toLowerCase();
  assert.doesNotMatch(serialized, /shell|sql|generic[_ -]?fetch|credential[_ -]?(?:get|read|retrieve)/);
  TOOL_DEFINITIONS.forEach((entry) => {
    assert.equal(Object.isFrozen(entry.inputSchema), true);
    assert.equal(entry.inputSchema.type, "object");
    assert.equal(entry.inputSchema.additionalProperties, false);
    assert.equal(entry.annotations.openWorldHint, false);
  });
});

test("modern MCP discovery, resources, tools, calls, and protocol errors are well formed", async () => {
  const calls = [];
  const fakeClient = {
    async connectorSnapshot(value) { calls.push(["connector", value]); return connectorSnapshot(); },
    async connectorCommand(value) { calls.push(["connector-command", value]); return { ok: true }; },
    async administrationSnapshot(value) { calls.push(["administration", value]); return administrationSnapshot(value.domain); },
    async administrationPrompt(value) { calls.push(["prompt", value]); return { promptId: value, body: "literal" }; },
    async administrationCommand(value) { calls.push(["administration-command", value]); return { ok: true }; }
  };
  const server = createMcpServer({ client: fakeClient });

  const discovered = await server.handle(rpc("discover", "server/discover", modernParams()));
  assert.equal(discovered.result.resultType, "complete");
  assert.deepEqual(discovered.result.supportedVersions, [MODERN_PROTOCOL]);
  assert.equal(discovered.result.capabilities.tools.listChanged, false);

  const listed = await server.handle(rpc(1, "resources/list", modernParams()));
  assert.equal(listed.result.resources.length, RESOURCE_DEFINITIONS.length);
  assert.equal(listed.result.cacheScope, "public");
  assert.equal(Object.prototype.hasOwnProperty.call(listed.result.resources[0], "relativePath"), false);

  const tools = await server.handle(rpc(2, "tools/list", modernParams()));
  assert.deepEqual(tools.result.tools.map((entry) => entry.name), TOOL_DEFINITIONS.map((entry) => entry.name));

  const snapshot = await server.handle(rpc(3, "tools/call", modernParams({
    name: "connector_snapshot",
    arguments: { reason: "refresh", knownRevision: 0 }
  })));
  assert.equal(snapshot.result.isError, undefined);
  assert.deepEqual(snapshot.result.structuredContent, connectorSnapshot());
  assert.deepEqual(calls[0], ["connector", { reason: "refresh", knownRevision: 0 }]);

  const invalidTool = await server.handle(rpc(4, "tools/call", modernParams({ name: "run_shell", arguments: {} })));
  assert.equal(invalidTool.error.code, -32602);
  const noMetadata = await server.handle(rpc(5, "tools/list", {}));
  assert.equal(noMetadata.error.code, -32022);
  const wrongVersion = await createMcpServer({ client: fakeClient }).handle(
    rpc(6, "tools/list", { _meta: { [PROTOCOL_KEY]: "1900-01-01" } })
  );
  assert.equal(wrongVersion.error.code, -32022);
});

test("legacy initialize flow, batching, notification silence, and invalid JSON-RPC shapes are supported", async () => {
  const fakeClient = {
    connectorSnapshot: async () => connectorSnapshot(),
    connectorCommand: async () => ({}),
    administrationSnapshot: async () => administrationSnapshot("agents"),
    administrationPrompt: async () => ({}),
    administrationCommand: async () => ({})
  };
  const server = createMcpServer({ client: fakeClient });
  const beforeInitialize = await server.handle(rpc(1, "tools/list", {}));
  assert.equal(beforeInitialize.error.code, -32002);

  const initialized = await server.handle(rpc(2, "initialize", {
    protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" }
  }));
  assert.equal(initialized.result.protocolVersion, "2025-11-25");
  assert.equal(initialized.result.serverInfo.name, "bulwark-black-soc");
  const notification = await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(notification, null);

  const batch = await server.handle([
    rpc("resources", "resources/list", {}),
    { jsonrpc: "2.0", method: "notifications/cancelled", params: {} },
    rpc("ping", "ping", {})
  ]);
  assert.equal(batch.length, 2);
  assert.equal(batch[0].result.resultType, undefined);
  assert.deepEqual(batch[1].result, {});

  const invalid = await server.handle({ jsonrpc: "2.0", id: 3, method: "ping", unexpected: true });
  assert.equal(invalid.error.code, -32600);
  const invalidParams = await server.handle(rpc(4, "ping", null));
  assert.equal(invalidParams.error.code, -32602);
  const emptyBatch = await server.handle([]);
  assert.equal(emptyBatch.error.code, -32600);
});

test("control-plane client uses only fixed endpoints, exact contracts, same-origin mutation headers, and no redirects", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: url.toString(), options });
    if (url.pathname === "/api/v1/control/snapshot") return response(connectorSnapshot());
    if (url.pathname === "/api/v1/control/commands") {
      const request = JSON.parse(options.body);
      return response({
        schemaVersion: "1",
        documentType: "connector-command-result",
        requestId: request.requestId,
        command: request.command,
        status: "succeeded",
        completedAt: AT,
        output: { appId: "app-created", state: "registered" }
      });
    }
    if (url.pathname === "/api/v1/administration/snapshot") {
      return response(administrationSnapshot(url.searchParams.get("domain")));
    }
    if (url.pathname === "/api/v1/administration/prompts") {
      return response({
        schemaVersion: "1",
        documentType: "agent-prompt",
        promptId: url.searchParams.get("promptId"),
        agentId: "agent-one",
        version: 1,
        title: "Triage prompt",
        state: "draft",
        body: "Review only the assigned queue.",
        revision: 0,
        createdAt: AT,
        updatedAt: AT
      });
    }
    if (url.pathname === "/api/v1/administration/commands") {
      const request = JSON.parse(options.body);
      return response({
        schemaVersion: "1",
        documentType: "administration-command-result",
        requestId: request.requestId,
        command: request.command,
        status: "succeeded",
        completedAt: AT,
        output: { agentId: "agent-created", state: "active", revision: 1 }
      });
    }
    throw new Error("Unexpected endpoint");
  };
  const client = new ControlPlaneClient({ baseUrl: "http://localhost:8787", fetchImpl });

  assert.equal((await client.connectorSnapshot({ reason: "refresh", knownRevision: 0 })).revision, 0);
  assert.equal((await client.connectorCommand(connectorCommandRequest())).output.appId, "app-created");
  assert.equal((await client.administrationSnapshot({ domain: "agents", reason: "initial" })).domain, "agents");
  assert.equal((await client.administrationPrompt("prompt-one")).body, "Review only the assigned queue.");
  assert.equal((await client.administrationCommand(administrationCommandRequest())).output.agentId, "agent-created");

  assert.match(calls[0].url, /^http:\/\/localhost:8787\/api\/v1\/control\/snapshot\?/);
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.headers.Origin, undefined);
  const mutationCalls = calls.filter((entry) => entry.options.method === "POST");
  assert.equal(mutationCalls.length, 2);
  mutationCalls.forEach((entry) => {
    assert.equal(entry.options.redirect, "error");
    assert.equal(entry.options.headers.Origin, "http://localhost:8787");
    assert.equal(entry.options.headers["Content-Type"], "application/json; charset=utf-8");
  });
  assert.equal(calls[2].url, "http://localhost:8787/api/v1/administration/snapshot?domain=agents&reason=initial");
  assert.equal(calls[3].url, "http://localhost:8787/api/v1/administration/prompts?promptId=prompt-one");
});

test("credential-issuing commands are rejected before HTTP and remote error text is never echoed", async () => {
  let fetchCount = 0;
  const blockedClient = new ControlPlaneClient({
    fetchImpl: async () => { fetchCount += 1; return response({}); }
  });
  await assert.rejects(() => blockedClient.connectorCommand(connectorCommandRequest("host.enroll")), /credential-issuing/i);
  await assert.rejects(() => blockedClient.administrationCommand(administrationCommandRequest("enrollment.issue")), /credential-issuing/i);
  assert.equal(fetchCount, 0);

  const marker = ["do", "not", "echo", "material"].join("-");
  const errorClient = new ControlPlaneClient({
    fetchImpl: async () => response({ code: "not-authorized", message: marker }, 403)
  });
  const server = createMcpServer({ client: errorClient });
  await server.handle(rpc("discover", "server/discover", modernParams()));
  const result = await server.handle(rpc(1, "tools/call", modernParams({
    name: "connector_snapshot", arguments: { reason: "refresh" }
  })));
  assert.equal(result.result.isError, true);
  assert.match(result.result.content[0].text, /not-authorized/);
  assert.doesNotMatch(result.result.content[0].text, new RegExp(marker));
});

test("stdio executable emits newline-delimited JSON-RPC only and no startup banner", async (t) => {
  const child = spawn(process.execPath, [path.join(ROOT, "tools", "agent-mcp.js")], {
    cwd: ROOT,
    env: { ...process.env, SOC_AGENT_MCP_BASE_URL: DEFAULT_BASE_URL },
    stdio: ["pipe", "pipe", "pipe"]
  });
  t.after(() => { if (!child.killed) child.kill("SIGTERM"); });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.write(JSON.stringify(rpc(1, "initialize", {
    protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" }
  })) + "\n");
  child.stdin.write(JSON.stringify(rpc(2, "tools/list", {})) + "\n");
  child.stdin.end();
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(exitCode, 0);
  assert.equal(stderr, "");
  const lines = stdout.trim().split("\n");
  assert.equal(lines.length, 2);
  const messages = lines.map(JSON.parse);
  assert.equal(messages[0].id, 1);
  assert.equal(messages[1].id, 2);
  assert.deepEqual(messages[1].result.tools.map((entry) => entry.name), TOOL_DEFINITIONS.map((entry) => entry.name));
});
