#!/usr/bin/env node
"use strict";

// Narrow MCP facade for the SOC control-plane contracts.
// It intentionally exposes no shell, SQL, filesystem path, arbitrary URL,
// telemetry, or credential tools. All mutations go through the same versioned
// HTTP command endpoints used by the reference/application control plane.

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const readline = require("node:readline");
const { TextDecoder } = require("node:util");
const ConnectorRuntime = require("../public/connector-contract");
const AdministrationRuntime = require("../public/administration-contract");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_BASE_URL = "http://127.0.0.1:8787";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_MCP_LINE_BYTES = 1024 * 1024;
const MODERN_PROTOCOL = "2026-07-28";
const LEGACY_PROTOCOLS = Object.freeze([
  "2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"
]);
const SERVER_INFO = Object.freeze({ name: "bulwark-black-soc", version: "0.1.0" });
const SERVER_INSTRUCTIONS = [
  "Read the implementation resources before issuing a command.",
  "For guided setup, read soc://documentation/ai-setup or select the user-controlled setup_application prompt.",
  "This facade calls the canonical connector and administration services; it is not a second registry.",
  "Never send telemetry or plaintext credentials through MCP.",
  "Credential-issuing commands are intentionally blocked; use the protected operator flow.",
  "Require human approval for destructive, privilege-expanding, prompt-activation, and production-impacting commands."
].join(" ");
const SERVER_META_KEY = "io.modelcontextprotocol/serverInfo";
const PROTOCOL_META_KEY = "io.modelcontextprotocol/protocolVersion";
const PRIVATE_DNS_SUFFIX = ["ts", "net"].join(".");
const SECRET_ISSUING_CONNECTOR_COMMANDS = new Set(["host.enroll", "source.activate", "source.rotate"]);
const SECRET_ISSUING_ADMINISTRATION_COMMANDS = new Set(["enrollment.issue"]);
const SERVICE_PRIVILEGE_COMMANDS = new Set(["agent.create", "agent.update", "agent.resume", "agent.restore", "prompt.activate"]);
const SERVICE_TOKEN_PATTERN = /^bbsvc_service-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/;
const PROTECTED_KEY_SUFFIXES = Object.freeze([
  "secret", "password", "passwd", "token", "apikey", "privatekey",
  "credential", "credentials", "authorization", "cookie", "sessionid",
  "clientsecret", "accesskey"
]);

const RESOURCE_DEFINITIONS = Object.freeze([
  resource("soc://documentation/technical-manual", "technical-manual", "Technical implementation manual",
    "Complete human- and agent-readable implementation, security, lifecycle, and screen-population manual.",
    "public/technical-reference.md", "text/markdown"),
  resource("soc://documentation/agent-guide", "agent-guide", "Agent integration guide",
    "Focused private-deployment, agent-administration, MCP, and completion guidance.",
    "docs/AGENTS.md", "text/markdown"),
  resource("soc://documentation/readme", "readme", "Project setup and capability overview",
    "Installation prerequisites, shipped features, private access and adoption boundaries.",
    "README.md", "text/markdown"),
  resource("soc://documentation/authentication", "authentication", "Private authentication and account security",
    "One-time owner setup, Better Auth sessions, optional TOTP, recovery and private identity boundaries.",
    "docs/AUTHENTICATION.md", "text/markdown"),
  resource("soc://documentation/connectors", "connector-guide", "Connector integration guide",
    "Connector manifests, source lifecycle, canonical ingest, projectors, and secret-reference rules.",
    "docs/CONNECTORS.md", "text/markdown"),
  resource("soc://documentation/integration-review", "integration-review", "Integration capability and adoption review",
    "Implemented transports, custom definitions, canonical sender, screen coverage, limits, remaining work and acceptance checks.",
    "docs/INTEGRATION-REVIEW.md", "text/markdown"),
  resource("soc://documentation/vendor-integrations", "vendor-integrations", "Vendor adapters and durable delivery",
    "Ten reviewed vendor export mappings, private import setup, source binding, persistent delivery queue, recovery and acquisition boundaries.",
    "docs/VENDOR-INTEGRATIONS.md", "text/markdown"),
  resource("soc://documentation/live-monitoring", "live-monitoring", "Live application monitoring",
    "Guided Sentry collection, encrypted credential custody, checkpoints, collection health, alerts, Slack notifications and private operations.",
    "docs/LIVE-MONITORING.md", "text/markdown"),
  resource("soc://documentation/guided-setup", "guided-setup", "Guided application setup and diagnostics",
    "Resumable application/source setup, read-only evidence checks, supported paths, storage, private API and recovery limits.",
    "docs/GUIDED-SETUP.md", "text/markdown"),
  resource("soc://documentation/ai-setup", "ai-setup", "Private AI-assisted application setup",
    "Client connection choices, least-privilege setup workflow, human credential checkpoints and evidence-based completion.",
    "docs/AI-SETUP.md", "text/markdown"),
  resource("soc://documentation/architecture", "architecture", "Architecture guide",
    "Trust planes, adopter boundaries, and production architecture responsibilities.",
    "docs/ARCHITECTURE.md", "text/markdown"),
  resource("soc://documentation/configuration", "configuration", "Configuration guide",
    "Public bootstrap configuration and provider wiring without secret material.",
    "docs/CONFIGURATION.md", "text/markdown"),
  resource("soc://documentation/features", "features", "Feature and route guide",
    "Human-readable feature, route, tab, population, and ownership descriptions.",
    "docs/FEATURES.md", "text/markdown"),
  resource("soc://contracts/administration-v1-schema", "administration-v1-schema", "Administration v1 schema",
    "Portable closed schema for agent, prompt, enrollment, attestation, risk, snapshot, and command documents.",
    "contracts/administration.v1.schema.json", "application/schema+json"),
  resource("soc://contracts/connector-manifest-v1", "connector-manifest-v1", "Connector manifest v1 schema",
    "Portable closed schema for an installed data-only connector manifest.",
    "contracts/connector-manifest.v1.schema.json", "application/schema+json"),
  resource("soc://contracts/source-registration-v1", "source-registration-v1", "Source registration v1 schema",
    "Portable closed schema for source registration and health metadata.",
    "contracts/source-registration.v1.schema.json", "application/schema+json"),
  resource("soc://contracts/normalized-record-v1", "normalized-record-v1", "Normalized record v1 schema",
    "Portable closed canonical security-record schema.",
    "contracts/normalized-record.v1.schema.json", "application/schema+json"),
  resource("soc://contracts/ingest-batch-v1", "ingest-batch-v1", "Ingest batch v1 schema",
    "Portable closed canonical ingest-batch schema. MCP is not an ingest transport.",
    "contracts/ingest-batch.v1.schema.json", "application/schema+json"),
  resource("soc://contracts/page-model-v1", "page-model-v1", "Page model v1 schema",
    "Portable closed authorized presentation-envelope schema.",
    "contracts/page-model.v1.schema.json", "application/schema+json"),
  resource("soc://contracts/connector-runtime-v1", "connector-runtime-v1", "Connector runtime v1",
    "Executable connector document and provider validator used at the JavaScript trust boundary.",
    "public/connector-contract.js", "text/javascript"),
  resource("soc://contracts/administration-runtime-v1", "administration-runtime-v1", "Administration runtime v1",
    "Executable administration document and provider validator used at the JavaScript trust boundary.",
    "public/administration-contract.js", "text/javascript"),
  resource("soc://contracts/page-runtime-v1", "page-runtime-v1", "Page runtime v1",
    "Executable page-envelope and provider validator used at the JavaScript trust boundary.",
    "public/adapter-contract.js", "text/javascript"),
  resource("soc://contracts/ingest-runtime-v1", "ingest-runtime-v1", "Ingest runtime v1",
    "Executable normalized-record and ingest-batch validators.",
    "tools/ingest-contract.js", "text/javascript")
]);

const CONNECTOR_REQUEST_SCHEMA = deepFreeze({
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "documentType", "requestId", "command", "requestedAt", "input"],
  properties: {
    schemaVersion: { const: "1" },
    documentType: { const: "connector-command-request" },
    requestId: { type: "string", minLength: 1, maxLength: 128 },
    command: { type: "string", enum: Array.from(ConnectorRuntime.COMMANDS) },
    requestedAt: { type: "string", format: "date-time" },
    input: { type: "object" }
  }
});

const ADMINISTRATION_REQUEST_SCHEMA = deepFreeze({
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion", "documentType", "requestId", "command", "requestedAt", "expectedRevision", "input"
  ],
  properties: {
    schemaVersion: { const: "1" },
    documentType: { const: "administration-command-request" },
    requestId: { type: "string", minLength: 1, maxLength: 128 },
    command: { type: "string", enum: Array.from(AdministrationRuntime.COMMANDS) },
    requestedAt: { type: "string", format: "date-time" },
    expectedRevision: { type: "integer", minimum: 0 },
    input: { type: "object" }
  }
});

const TOOL_DEFINITIONS = Object.freeze([
  tool("setup_guides", "Read saved setup guides",
    "Read saved application/source bindings and compatible choices. Requires a private service credential with setup:read; does not create guides or grant access.",
    { type: "object", additionalProperties: false, properties: {} }, true),
  tool("setup_check", "Check application setup evidence",
    "Read local source activation, retained records, collection and delivery evidence. Requires setup:read. Never polls vendors, sends notifications, scans, or certifies production readiness.",
    { type: "object", additionalProperties: false, required: ["appId", "environment", "path"], properties: {
      appId: { type: "string", minLength: 1, maxLength: 128 }, environment: { type: "string", minLength: 1, maxLength: 128 },
      path: { type: "string", enum: ["live", "vendor", "custom", "trivy"] }, sourceId: { type: "string", minLength: 1, maxLength: 128 }
    } }, true),
  tool("connector_snapshot", "Read connector registry snapshot",
    "Read the authorized connector manifest, app, host, source, health, and change projection. This never returns credentials.",
    {
      type: "object", additionalProperties: false,
      properties: {
        reason: { type: "string", enum: Array.from(ConnectorRuntime.SNAPSHOT_REASONS), default: "refresh" },
        knownRevision: { type: "integer", minimum: 0 }
      }
    }, true),
  tool("connector_command", "Run connector control command",
    "Submit one exact version-1 connector command to the canonical control service. Human approval is required for production-impacting operations. Credential-issuing host.enroll, source.activate, and source.rotate commands are blocked in MCP.",
    {
      type: "object", additionalProperties: false, required: ["request"],
      properties: { request: CONNECTOR_REQUEST_SCHEMA }
    }, false),
  tool("administration_snapshot", "Read administration snapshot",
    "Read authorized safe metadata for either the agents or governance domain. Agent prompt bodies are excluded.",
    {
      type: "object", additionalProperties: false, required: ["domain"],
      properties: {
        domain: { type: "string", enum: Array.from(AdministrationRuntime.DOMAINS) },
        reason: { type: "string", enum: Array.from(AdministrationRuntime.SNAPSHOT_REASONS), default: "refresh" },
        knownRevision: { type: "integer", minimum: 0 }
      }
    }, true),
  tool("administration_prompt", "Read one agent prompt revision",
    "Read one separately authorized literal prompt revision by stable ID. Prompt reads do not grant tools, capabilities, or execution authority.",
    {
      type: "object", additionalProperties: false, required: ["promptId"],
      properties: { promptId: { type: "string", minLength: 1, maxLength: 128 } }
    }, true),
  tool("administration_command", "Run administration command",
    "Submit one exact version-1 agent or governance command to the canonical administration service. Human approval is required for destructive, privilege-expanding, and prompt-activation operations. Credential-issuing enrollment.issue is blocked in MCP.",
    {
      type: "object", additionalProperties: false, required: ["request"],
      properties: { request: ADMINISTRATION_REQUEST_SCHEMA }
    }, false)
]);

function resource(uri, name, title, description, relativePath, mimeType) {
  return Object.freeze({ uri, name, title, description, relativePath, mimeType });
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Reflect.ownKeys(value).forEach((key) => deepFreeze(value[key]));
  return Object.freeze(value);
}

function tool(name, title, description, inputSchema, readOnly) {
  return Object.freeze({
    name,
    title,
    description,
    inputSchema: deepFreeze(inputSchema),
    annotations: Object.freeze({
      readOnlyHint: readOnly,
      destructiveHint: !readOnly,
      idempotentHint: true,
      openWorldHint: false
    })
  });
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertObject(value, label, allowedKeys) {
  if (!isPlainObject(value)) throw new TypeError(label + " must be a plain object.");
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowedKeys.includes(key)) {
      throw new TypeError(label + " contains an unsupported key.");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set) throw new TypeError(label + " must use data properties.");
  }
  return value;
}

function stripBrackets(hostname) {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function isLoopbackHost(hostname) {
  const candidate = stripBrackets(hostname).toLowerCase();
  return candidate === "localhost" || candidate === "127.0.0.1" || candidate === "::1";
}

function isPrivateIpv4(hostname) {
  const candidate = stripBrackets(hostname);
  if (net.isIP(candidate) !== 4) return false;
  const octets = candidate.split(".").map(Number);
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168)
    || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127);
}

function isPrivateIpv6(hostname) {
  const candidate = stripBrackets(hostname).toLowerCase();
  return net.isIP(candidate) === 6 && (candidate.startsWith("fc") || candidate.startsWith("fd"));
}

function isPrivateDnsHost(hostname) {
  const candidate = stripBrackets(hostname).toLowerCase();
  if (candidate.endsWith(".") || candidate.length > 253
      || !candidate.endsWith("." + PRIVATE_DNS_SUFFIX)) return false;
  const labels = candidate.split(".");
  if (labels.length < 3) return false;
  return labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

function validateBaseUrl(value = DEFAULT_BASE_URL) {
  if (typeof value !== "string" || value.length < 1 || value.length > 2048
      || /[\u0000-\u0020\u007f]/.test(value) || value.includes("%")) {
    throw new TypeError("MCP control-plane base URL is invalid.");
  }
  let parsed;
  try { parsed = new URL(value); }
  catch { throw new TypeError("MCP control-plane base URL is invalid."); }
  const rawAuthority = value.slice(value.indexOf("://") + 3);
  const rawHostname = rawAuthority.startsWith("[")
    ? rawAuthority.slice(0, rawAuthority.indexOf("]") + 1)
    : rawAuthority.split(":", 1)[0];
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
      || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.port === "0") {
    throw new TypeError("MCP control-plane base URL must be an origin without credentials, path, query, or fragment.");
  }
  if (net.isIP(stripBrackets(parsed.hostname)) === 4
      && rawHostname.toLowerCase() !== parsed.hostname.toLowerCase()) {
    throw new TypeError("IPv4 control-plane hosts must use canonical dotted-decimal notation.");
  }
  const loopback = isLoopbackHost(parsed.hostname);
  const privateDestination = loopback || isPrivateIpv4(parsed.hostname)
    || isPrivateIpv6(parsed.hostname) || isPrivateDnsHost(parsed.hostname);
  if (parsed.protocol === "http:" && !loopback) {
    throw new TypeError("Plain HTTP is accepted only for an exact loopback host.");
  }
  if (parsed.protocol === "https:" && !privateDestination) {
    throw new TypeError("HTTPS MCP control-plane hosts must be loopback or an approved private destination.");
  }
  return parsed.origin;
}

function parseArguments(argv, environment = process.env) {
  if (!Array.isArray(argv)) throw new TypeError("MCP arguments must be an array.");
  let baseUrl = environment.SOC_AGENT_MCP_BASE_URL || DEFAULT_BASE_URL;
  let tokenFile = environment.SOC_AGENT_MCP_TOKEN_FILE;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!["--base-url", "--token-file"].includes(argument) || index + 1 >= argv.length) {
      throw new TypeError("Unknown or incomplete MCP argument. Use --base-url and optional --token-file.");
    }
    if (argument === "--base-url") baseUrl = argv[++index];
    else tokenFile = argv[++index];
  }
  return Object.freeze({ baseUrl: validateBaseUrl(baseUrl), ...(tokenFile === undefined ? {} : { tokenFile }) });
}

function readServiceTokenFile(filename) {
  // Reject links before opening and verify the opened inode, not only its name.
  // The path may be in environment/argv; the credential itself never should be.
  try {
    if (typeof filename !== "string" || !path.isAbsolute(filename) || filename !== path.resolve(filename)) throw new Error();
    const repository = fs.realpathSync(ROOT);
    if (filename === repository || filename.startsWith(repository + path.sep)) throw new Error();
    let cursor = path.parse(filename).root;
    for (const part of filename.slice(cursor.length).split(path.sep)) {
      cursor = path.join(cursor, part);
      if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error();
    }
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.size > 256
          || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error();
      const value = fs.readFileSync(fd, "utf8").replace(/\r?\n$/, "");
      if (!SERVICE_TOKEN_PATTERN.test(value)) throw new Error();
      return value;
    } finally { fs.closeSync(fd); }
  } catch { throw new TypeError("Service token file must be an owner-only regular file outside the repository at a canonical absolute path, containing one issued service credential."); }
}

function safeProblemCode(value) {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value) ? value : null;
}

class ControlPlaneError extends Error {
  constructor(kind, options = {}) {
    super(kind === "rejected" ? "The control plane rejected the request."
      : kind === "invalid-response" ? "The control plane returned an invalid contract document."
        : kind === "response-too-large" ? "The control-plane response exceeded the MCP safety limit."
          : "The private control plane is unavailable.");
    this.name = "ControlPlaneError";
    this.kind = kind;
    this.status = options.status;
    this.code = options.code || null;
  }
}

async function readBoundedJson(response) {
  const contentType = response.headers && response.headers.get("content-type");
  if (typeof contentType !== "string" || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new ControlPlaneError("invalid-response");
  }
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    throw new ControlPlaneError("response-too-large");
  }
  const chunks = [];
  let length = 0;
  if (response.body) {
    const reader = response.body.getReader();
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new ControlPlaneError("response-too-large");
      }
      chunks.push(Buffer.from(part.value));
    }
  }
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { throw new ControlPlaneError("invalid-response"); }
  try { return JSON.parse(text); }
  catch { throw new ControlPlaneError("invalid-response"); }
}

function normalizedProtectedKey(key) {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function containsProtectedMaterial(value, seen = new Set()) {
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return true;
  seen.add(value);
  for (const key of Object.keys(value)) {
    const normalized = normalizedProtectedKey(key);
    if (PROTECTED_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) return true;
    if (containsProtectedMaterial(value[key], seen)) return true;
  }
  seen.delete(value);
  return false;
}

function safeCommandProjection(value) {
  const projected = JSON.parse(JSON.stringify(value));
  if (projected.status !== "succeeded" && projected.error) {
    projected.error.message = "The control-plane command did not succeed.";
  }
  if (containsProtectedMaterial(projected)) {
    throw new ControlPlaneError("invalid-response");
  }
  return projected;
}

function validateSetupInput(input) {
  assertObject(input, "Setup check", ["appId", "environment", "path", "sourceId"]);
  for (const key of ["appId", "environment", ...(input.sourceId === undefined ? [] : ["sourceId"])]) {
    if (typeof input[key] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input[key])) throw new TypeError("Setup identifiers are invalid.");
  }
  if (!["live", "vendor", "custom", "trivy"].includes(input.path)) throw new TypeError("Setup path is invalid.");
  return input;
}
function validateSetupDocument(value, input) {
  const text = (candidate, max = 4000) => typeof candidate === "string" && candidate.length <= max;
  const id = candidate => typeof candidate === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(candidate);
  const time = candidate => text(candidate, 35) && Number.isFinite(Date.parse(candidate));
  const href = candidate => candidate === undefined || text(candidate, 2048) && /^#\/(?!\/)[a-z0-9/-]*(?:\?[^#\s\\<>]*)?$/.test(candidate);
  const ensure = valid => { if (!valid) throw new Error("Invalid setup response."); };
  ensure(value?.schemaVersion === "1" && !containsProtectedMaterial(value));
  if (input) {
    assertObject(value, "Setup diagnostic", ["schemaVersion", "checkedAt", "appId", "environment", "sourceId", "path", "checks", "destinations", "summary"]);
    ensure(time(value.checkedAt) && value.appId === input.appId && value.environment === input.environment && value.path === input.path
      && value.sourceId === (input.sourceId || null) && text(value.summary) && Array.isArray(value.checks) && value.checks.length <= 20
      && Array.isArray(value.destinations) && value.destinations.length <= 100);
    for (const item of value.checks) {
      assertObject(item, "Setup check result", ["id", "title", "state", "detail", "href"]);
      ensure(id(item.id) && text(item.title, 200) && ["pass", "waiting", "attention", "not-applicable"].includes(item.state) && text(item.detail) && href(item.href));
    }
    for (const item of value.destinations) {
      assertObject(item, "Setup destination", ["title", "href", "detail"]);
      ensure(text(item.title, 200) && typeof item.href === "string" && href(item.href) && text(item.detail));
    }
  } else {
    assertObject(value, "Setup guides", ["schemaVersion", "revision", "plans", "choices"]);
    ensure(Number.isSafeInteger(value.revision) && value.revision >= 0 && Array.isArray(value.plans) && value.plans.length <= 200
      && Array.isArray(value.choices) && value.choices.length <= 20000);
    for (const item of value.plans) {
      assertObject(item, "Setup plan", ["id", "appId", "environment", "path", "sourceId", "createdAt", "updatedAt"]);
      validateSetupInput({ appId: item.appId, environment: item.environment, path: item.path, ...(item.sourceId === null ? {} : { sourceId: item.sourceId }) });
      ensure(id(item.id) && time(item.createdAt) && time(item.updatedAt));
    }
    for (const item of value.choices) {
      assertObject(item, "Setup source choice", ["appId", "environment", "path", "sourceId", "displayName", "state"]);
      validateSetupInput({ appId: item.appId, environment: item.environment, path: item.path, sourceId: item.sourceId });
      ensure(text(item.displayName, 120) && text(item.state, 40));
    }
  }
  return value;
}

class ControlPlaneClient {
  #baseUrl;
  #fetch;
  #timeoutMs;
  #tokenFile;

  constructor(options = {}) {
    assertObject(options, "MCP control-plane client options", ["baseUrl", "fetchImpl", "timeoutMs", "tokenFile"]);
    this.#baseUrl = validateBaseUrl(options.baseUrl || DEFAULT_BASE_URL);
    if (options.tokenFile !== undefined) {
      readServiceTokenFile(options.tokenFile);
      this.#tokenFile = options.tokenFile;
    } else if (!isLoopbackHost(new URL(this.#baseUrl).hostname)) {
      throw new TypeError("Remote private control planes require an explicit service token file. The unauthenticated workbench is loopback-only.");
    }
    this.#fetch = options.fetchImpl || globalThis.fetch;
    if (typeof this.#fetch !== "function") throw new TypeError("A Fetch-compatible implementation is required.");
    this.#timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 100 || this.#timeoutMs > 120_000) {
      throw new TypeError("MCP control-plane timeout must be an integer from 100 through 120000 milliseconds.");
    }
  }

  get baseUrl() { return this.#baseUrl; }

  async setupGuides() {
    if (!this.#tokenFile) throw new TypeError("Setup reads require a private service token file with setup:read.");
    const document = await this.#request("GET", "/api/v1/setup");
    try { return validateSetupDocument(document); } catch { throw new ControlPlaneError("invalid-response"); }
  }

  async setupCheck(input) {
    if (!this.#tokenFile) throw new TypeError("Setup reads require a private service token file with setup:read.");
    const query = validateSetupInput(input), document = await this.#request("GET", "/api/v1/setup/check", query);
    try { return validateSetupDocument(document, query); } catch { throw new ControlPlaneError("invalid-response"); }
  }

  async #request(method, endpoint, query, body) {
    if (this.#tokenFile) endpoint = endpoint.replace("/api/v1/", "/api/v1/service/");
    const target = new URL(endpoint, this.#baseUrl + "/");
    Object.entries(query || {}).forEach(([key, value]) => target.searchParams.set(key, String(value)));
    const headers = { Accept: "application/json" };
    if (this.#tokenFile) headers.Authorization = "Bearer " + readServiceTokenFile(this.#tokenFile);
    const options = { method, headers, redirect: "error" };
    if (body !== undefined) {
      const encoded = JSON.stringify(body);
      if (Buffer.byteLength(encoded, "utf8") > MAX_REQUEST_BYTES) {
        throw new TypeError("Control-plane command exceeds the MCP request limit.");
      }
      headers["Content-Type"] = "application/json; charset=utf-8";
      headers.Origin = this.#baseUrl;
      options.body = encoded;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    options.signal = controller.signal;
    let response;
    let document;
    try {
      response = await this.#fetch(target, options);
      document = await readBoundedJson(response);
    } catch (error) {
      if (error instanceof ControlPlaneError) throw error;
      throw new ControlPlaneError("unavailable");
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      throw new ControlPlaneError("rejected", {
        status: response.status,
        code: safeProblemCode(document && document.code)
      });
    }
    return document;
  }

  async connectorSnapshot(input) {
    const request = ConnectorRuntime.validateControlRequest({
      schemaVersion: "1",
      reason: input.reason || "refresh",
      ...(input.knownRevision === undefined ? {} : { knownRevision: input.knownRevision })
    });
    const query = { reason: request.reason };
    if (request.knownRevision !== undefined) query.knownRevision = request.knownRevision;
    const document = await this.#request("GET", "/api/v1/control/snapshot", query);
    try { return ConnectorRuntime.validateControlSnapshot(document); }
    catch { throw new ControlPlaneError("invalid-response"); }
  }

  async connectorCommand(requestValue) {
    const request = ConnectorRuntime.validateCommandRequest(requestValue);
    if (SECRET_ISSUING_CONNECTOR_COMMANDS.has(request.command)) {
      throw new TypeError("This credential-issuing connector command is intentionally unavailable through MCP; use the protected operator flow.");
    }
    const document = await this.#request("POST", "/api/v1/control/commands", null, request);
    let result;
    try { result = ConnectorRuntime.validateCommandResult(document, request); }
    catch { throw new ControlPlaneError("invalid-response"); }
    return safeCommandProjection(result);
  }

  async administrationSnapshot(input) {
    const request = AdministrationRuntime.validateSnapshotRequest({
      schemaVersion: "1",
      documentType: "administration-snapshot-request",
      domain: input.domain,
      reason: input.reason || "refresh",
      ...(input.knownRevision === undefined ? {} : { knownRevision: input.knownRevision })
    });
    const query = { domain: request.domain, reason: request.reason };
    if (request.knownRevision !== undefined) query.knownRevision = request.knownRevision;
    const document = await this.#request("GET", "/api/v1/administration/snapshot", query);
    try { return AdministrationRuntime.validateSnapshot(document, request); }
    catch { throw new ControlPlaneError("invalid-response"); }
  }

  async administrationPrompt(promptId) {
    const request = AdministrationRuntime.validatePromptRequest({
      schemaVersion: "1", documentType: "agent-prompt-request", promptId
    });
    const document = await this.#request("GET", "/api/v1/administration/prompts", { promptId: request.promptId });
    try { return AdministrationRuntime.validatePrompt(document, request); }
    catch { throw new ControlPlaneError("invalid-response"); }
  }

  async administrationCommand(requestValue) {
    const request = AdministrationRuntime.validateCommandRequest(requestValue);
    if (SECRET_ISSUING_ADMINISTRATION_COMMANDS.has(request.command)) {
      throw new TypeError("This credential-issuing administration command is intentionally unavailable through MCP; use the protected operator flow.");
    }
    if (this.#tokenFile && SERVICE_PRIVILEGE_COMMANDS.has(request.command)) {
      throw new TypeError("This privilege-expanding command is unavailable to service agents; use the authenticated human operator flow.");
    }
    const document = await this.#request("POST", "/api/v1/administration/commands", null, request);
    let result;
    try { result = AdministrationRuntime.validateCommandResult(document, request); }
    catch { throw new ControlPlaneError("invalid-response"); }
    return safeCommandProjection(result);
  }
}

async function readResource(uri) {
  const definition = RESOURCE_DEFINITIONS.find((entry) => entry.uri === uri);
  if (!definition) throw new McpProtocolError(-32602, "Unknown resource URI.");
  const candidate = path.resolve(ROOT, definition.relativePath);
  const [realRoot, realCandidate] = await Promise.all([fs.promises.realpath(ROOT), fs.promises.realpath(candidate)]);
  if (!realCandidate.startsWith(realRoot + path.sep)) throw new McpProtocolError(-32602, "Resource is unavailable.");
  const stat = await fs.promises.stat(realCandidate);
  if (!stat.isFile() || stat.size > MAX_RESPONSE_BYTES) throw new McpProtocolError(-32602, "Resource is unavailable.");
  const text = await fs.promises.readFile(realCandidate, "utf8");
  return { uri: definition.uri, mimeType: definition.mimeType, text };
}

class McpProtocolError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = "McpProtocolError";
    this.code = code;
    this.data = data;
  }
}

function clonePublicDefinition(value) {
  const result = { ...value };
  delete result.relativePath;
  return JSON.parse(JSON.stringify(result));
}

function methodParams(params, allowedKeys) {
  const value = params === undefined ? {} : params;
  try { assertObject(value, "MCP method parameters", [...allowedKeys, "_meta"]); }
  catch { throw new McpProtocolError(-32602, "Invalid method parameters."); }
  const result = {};
  allowedKeys.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(value, key)) result[key] = value[key];
  });
  return result;
}

function modernMeta(params) {
  if (!isPlainObject(params) || !isPlainObject(params._meta)) return null;
  return params._meta[PROTOCOL_META_KEY] || null;
}

function completeResult(value, modern, cache) {
  if (!modern) return value;
  const result = { resultType: "complete", ...value };
  if (cache) {
    result.ttlMs = cache.ttlMs;
    result.cacheScope = cache.cacheScope;
  }
  result._meta = { [SERVER_META_KEY]: SERVER_INFO };
  return result;
}

function capabilities() {
  return { resources: { subscribe: false, listChanged: false }, tools: { listChanged: false }, prompts: { listChanged: false } };
}

const SETUP_PROMPT = Object.freeze({
  name: "setup_application",
  description: "Guide private application/source setup with discovery, explicit approval, human credential checkpoints and real evidence. Reading this prompt performs no operations.",
  arguments: Object.freeze([])
});

function toolResult(value, modern) {
  return completeResult({
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value
  }, modern);
}

function toolError(error, modern) {
  let message = "The tool could not complete the request.";
  if (error instanceof TypeError) message = error.message;
  else if (error instanceof ControlPlaneError) {
    message = error.message;
    if (error.code) message += " Code: " + error.code + ".";
  }
  return completeResult({ content: [{ type: "text", text: message }], isError: true }, modern);
}

function validateListParams(params) {
  const value = methodParams(params, ["cursor"]);
  if (value.cursor !== undefined) throw new McpProtocolError(-32602, "Pagination cursor is not supported.");
}

function createMcpServer(options = {}) {
  assertObject(options, "MCP server options", ["client", "baseUrl", "fetchImpl", "timeoutMs", "tokenFile"]);
  const client = options.client || new ControlPlaneClient({
    baseUrl: options.baseUrl || DEFAULT_BASE_URL,
    ...(options.tokenFile === undefined ? {} : { tokenFile: options.tokenFile }),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
  });
  const state = { era: null, legacyVersion: null, initialized: false };

  async function dispatch(method, params) {
    const requestProtocol = modernMeta(params);
    const requestsModern = requestProtocol !== null;
    if (requestsModern && requestProtocol !== MODERN_PROTOCOL) {
      throw new McpProtocolError(-32022, "Unsupported MCP protocol version.", {
        supported: [MODERN_PROTOCOL, ...LEGACY_PROTOCOLS]
      });
    }

    if (method === "server/discover") {
      if (state.era === "legacy") throw new McpProtocolError(-32022, "This connection already selected a legacy protocol.");
      methodParams(params, []);
      state.era = "modern";
      return completeResult({
        supportedVersions: [MODERN_PROTOCOL],
        capabilities: capabilities(),
        instructions: SERVER_INSTRUCTIONS
      }, true);
    }

    if (method === "initialize") {
      if (state.era === "modern" || requestsModern) {
        throw new McpProtocolError(-32022, "The modern MCP protocol does not use initialize.");
      }
      const value = methodParams(params, ["protocolVersion", "capabilities", "clientInfo"]);
      if (typeof value.protocolVersion !== "string") throw new McpProtocolError(-32602, "initialize.protocolVersion is required.");
      const selected = LEGACY_PROTOCOLS.includes(value.protocolVersion)
        ? value.protocolVersion : LEGACY_PROTOCOLS[LEGACY_PROTOCOLS.length - 1];
      state.era = "legacy";
      state.legacyVersion = selected;
      return {
        protocolVersion: selected,
        capabilities: capabilities(),
        serverInfo: SERVER_INFO,
        instructions: SERVER_INSTRUCTIONS
      };
    }

    if (method === "notifications/initialized") {
      if (state.era === "legacy") state.initialized = true;
      return null;
    }
    if (method.startsWith("notifications/")) return null;

    let modern = requestsModern;
    if (state.era === null) {
      if (!modern) throw new McpProtocolError(-32002, "MCP server is not initialized.");
      state.era = "modern";
    } else if (state.era === "modern") {
      if (!modern) throw new McpProtocolError(-32022, "Modern MCP requests require protocol metadata.");
      modern = true;
    } else if (modern) {
      throw new McpProtocolError(-32022, "This connection already selected a legacy protocol.");
    }

    if (method === "ping") {
      methodParams(params, []);
      return completeResult({}, modern);
    }
    if (method === "resources/list") {
      validateListParams(params);
      return completeResult({ resources: RESOURCE_DEFINITIONS.map(clonePublicDefinition) }, modern, {
        ttlMs: 300_000, cacheScope: "public"
      });
    }
    if (method === "resources/templates/list") {
      validateListParams(params);
      return completeResult({ resourceTemplates: [] }, modern, { ttlMs: 300_000, cacheScope: "public" });
    }
    if (method === "resources/read") {
      const value = methodParams(params, ["uri"]);
      if (typeof value.uri !== "string") throw new McpProtocolError(-32602, "resources/read requires a URI.");
      const content = await readResource(value.uri);
      return completeResult({ contents: [content] }, modern, { ttlMs: 60_000, cacheScope: "public" });
    }
    if (method === "prompts/list") {
      validateListParams(params);
      return completeResult({ prompts: [clonePublicDefinition(SETUP_PROMPT)] }, modern, { ttlMs: 300_000, cacheScope: "public" });
    }
    if (method === "prompts/get") {
      const value = methodParams(params, ["name", "arguments"]);
      if (value.name !== SETUP_PROMPT.name) throw new McpProtocolError(-32602, "Unknown prompt name.");
      try { assertObject(value.arguments === undefined ? {} : value.arguments, "Setup prompt arguments", []); }
      catch { throw new McpProtocolError(-32602, "The setup prompt accepts no arguments."); }
      const guide = await readResource("soc://documentation/ai-setup");
      return completeResult({
        description: SETUP_PROMPT.description,
        messages: [{ role: "user", content: { type: "text", text: "Help me set up my private SOC using this runbook. Begin with discovery and questions; request approval before changes.\n\n" + guide.text } }]
      }, modern, { ttlMs: 60_000, cacheScope: "public" });
    }
    if (method === "tools/list") {
      validateListParams(params);
      return completeResult({ tools: TOOL_DEFINITIONS.map(clonePublicDefinition) }, modern, {
        ttlMs: 300_000, cacheScope: "public"
      });
    }
    if (method === "tools/call") {
      const value = methodParams(params, ["name", "arguments", "inputResponses", "requestState"]);
      if (typeof value.name !== "string" || !TOOL_DEFINITIONS.some((entry) => entry.name === value.name)) {
        throw new McpProtocolError(-32602, "Unknown tool name.");
      }
      if (value.inputResponses !== undefined || value.requestState !== undefined) {
        throw new McpProtocolError(-32602, "This MCP server does not request additional input rounds.");
      }
      const args = value.arguments === undefined ? {} : value.arguments;
      try {
        if (value.name === "setup_guides") {
          assertObject(args, "setup_guides arguments", []);
          return toolResult(await client.setupGuides(), modern);
        }
        if (value.name === "setup_check") {
          validateSetupInput(args);
          return toolResult(await client.setupCheck(args), modern);
        }
        if (value.name === "connector_snapshot") {
          assertObject(args, "connector_snapshot arguments", ["reason", "knownRevision"]);
          return toolResult(await client.connectorSnapshot(args), modern);
        }
        if (value.name === "connector_command") {
          assertObject(args, "connector_command arguments", ["request"]);
          if (!Object.prototype.hasOwnProperty.call(args, "request")) throw new TypeError("connector_command.request is required.");
          return toolResult(await client.connectorCommand(args.request), modern);
        }
        if (value.name === "administration_snapshot") {
          assertObject(args, "administration_snapshot arguments", ["domain", "reason", "knownRevision"]);
          if (!Object.prototype.hasOwnProperty.call(args, "domain")) throw new TypeError("administration_snapshot.domain is required.");
          return toolResult(await client.administrationSnapshot(args), modern);
        }
        if (value.name === "administration_prompt") {
          assertObject(args, "administration_prompt arguments", ["promptId"]);
          if (!Object.prototype.hasOwnProperty.call(args, "promptId")) throw new TypeError("administration_prompt.promptId is required.");
          return toolResult(await client.administrationPrompt(args.promptId), modern);
        }
        assertObject(args, "administration_command arguments", ["request"]);
        if (!Object.prototype.hasOwnProperty.call(args, "request")) throw new TypeError("administration_command.request is required.");
        return toolResult(await client.administrationCommand(args.request), modern);
      } catch (error) {
        return toolError(error, modern);
      }
    }
    throw new McpProtocolError(-32601, "Method not found.");
  }

  async function handleOne(message) {
    const hasId = isPlainObject(message) && Object.prototype.hasOwnProperty.call(message, "id");
    const usableId = hasId && (message.id === null || typeof message.id === "string"
      || (typeof message.id === "number" && Number.isSafeInteger(message.id))) ? message.id : null;
    const notification = isPlainObject(message) && !hasId;
    try {
      if (!isPlainObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string"
          || (hasId && usableId === null && message.id !== null)) {
        throw new McpProtocolError(-32600, "Invalid JSON-RPC request.");
      }
      for (const key of Reflect.ownKeys(message)) {
        if (typeof key !== "string" || !["jsonrpc", "id", "method", "params"].includes(key)) {
          throw new McpProtocolError(-32600, "Invalid JSON-RPC request.");
        }
      }
      const result = await dispatch(message.method, message.params);
      if (notification) return null;
      return { jsonrpc: "2.0", id: usableId, result: result === null ? {} : result };
    } catch (error) {
      if (notification) return null;
      const protocolError = error instanceof McpProtocolError
        ? error : new McpProtocolError(-32603, "Internal MCP server error.");
      const response = {
        jsonrpc: "2.0",
        id: usableId,
        error: { code: protocolError.code, message: protocolError.message }
      };
      if (protocolError.data !== undefined) response.error.data = protocolError.data;
      return response;
    }
  }

  return Object.freeze({
    client,
    state,
    async handle(payload) {
      if (Array.isArray(payload)) {
        if (payload.length === 0) return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid JSON-RPC request." } };
        const responses = (await Promise.all(payload.map(handleOne))).filter(Boolean);
        return responses.length ? responses : null;
      }
      return handleOne(payload);
    }
  });
}

function parseErrorResponse() {
  return { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } };
}

function runStdio(server, input = process.stdin, output = process.stdout) {
  if (!server || typeof server.handle !== "function") throw new TypeError("An MCP server handler is required.");
  const lines = readline.createInterface({ input, crlfDelay: Infinity, terminal: false });
  let queue = Promise.resolve();
  lines.on("line", (line) => {
    queue = queue.then(async () => {
      let response;
      if (Buffer.byteLength(line, "utf8") > MAX_MCP_LINE_BYTES) {
        response = parseErrorResponse();
      } else {
        let payload;
        try { payload = JSON.parse(line); }
        catch { response = parseErrorResponse(); }
        if (response === undefined) response = await server.handle(payload);
      }
      if (response !== null && response !== undefined) output.write(JSON.stringify(response) + "\n");
    }).catch(() => {
      output.write(JSON.stringify({
        jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal MCP server error." }
      }) + "\n");
    });
  });
  return Object.freeze({ lines, completed() { return queue; } });
}

function main(argv = process.argv.slice(2), environment = process.env) {
  try {
    const options = parseArguments(argv, environment);
    const server = createMcpServer(options);
    return runStdio(server);
  } catch (error) {
    process.stderr.write("Unable to start SOC MCP server: " + error.message + "\n");
    process.exitCode = 1;
    return null;
  }
}

if (require.main === module) main();

module.exports = {
  ControlPlaneClient,
  ControlPlaneError,
  DEFAULT_BASE_URL,
  LEGACY_PROTOCOLS,
  MAX_MCP_LINE_BYTES,
  MODERN_PROTOCOL,
  RESOURCE_DEFINITIONS,
  TOOL_DEFINITIONS,
  containsProtectedMaterial,
  createMcpServer,
  main,
  parseArguments,
  readResource,
  readServiceTokenFile,
  runStdio,
  validateBaseUrl
};
