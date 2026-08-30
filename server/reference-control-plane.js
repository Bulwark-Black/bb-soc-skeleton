#!/usr/bin/env node
"use strict";

// REFERENCE LOOPBACK MODE ONLY. This dependency-free integration workbench is
// not a production control plane or production telemetry receiver.

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { TextDecoder } = require("node:util");
const { ReferenceControlError, ReferenceControlPlane } = require("./reference-runtime");
const {
  ReferenceAdministrationError,
  ReferenceAdministrationRuntime
} = require("./reference-administration-runtime");

const HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const CONTROL_BODY_LIMIT = 64 * 1024;
const INGEST_BODY_LIMIT = 1024 * 1024;
const MAX_REQUEST_TARGET = 2048;
const PUBLIC_ROOT = path.resolve(__dirname, "..", "public");
const API_PREFIX = "/api/v1";
const CSP = [
  "default-src 'none'", "style-src 'self'", "script-src 'self'",
  "img-src 'self' data:", "font-src 'self'", "connect-src 'self'",
  "media-src 'none'", "object-src 'none'", "base-uri 'none'",
  "form-action 'none'", "frame-ancestors 'none'"
].join("; ");
const CONTENT_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8"
});

function addSecurityHeaders(response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", CSP);
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Permissions-Policy", "camera=(), geolocation=(), microphone=(), payment=(), usb=()");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function parsePort(value, fallback = DEFAULT_PORT) {
  if (value === undefined || value === "") return fallback;
  if (!/^\d{1,5}$/.test(String(value))) throw new TypeError("Port must be an integer from 1 through 65535.");
  const port = Number(value);
  if (port < 1 || port > 65535) throw new TypeError("Port must be an integer from 1 through 65535.");
  return port;
}

function parseRequestUrl(requestTarget) {
  if (typeof requestTarget !== "string" || requestTarget.length > MAX_REQUEST_TARGET
      || !requestTarget.startsWith("/") || requestTarget.startsWith("//")
      || requestTarget.includes("\\") || requestTarget.includes("\u0000") || requestTarget.includes("#")) {
    throw new ReferenceControlError("validation-failed", "Request target is invalid.", { status: 400 });
  }
  try { return new URL(requestTarget, "http://127.0.0.1"); }
  catch { throw new ReferenceControlError("validation-failed", "Request target is invalid.", { status: 400 }); }
}

function distinctHeader(request, name) {
  if (request.headersDistinct && request.headersDistinct[name]) {
    const values = request.headersDistinct[name];
    if (values.length !== 1) throw new ReferenceControlError("validation-failed", "Duplicate " + name + " header.", { status: 400 });
    return values[0];
  }
  return request.headers[name];
}

function validateAuthority(request, localPort, mutation) {
  const host = distinctHeader(request, "host");
  if (typeof host !== "string") throw new ReferenceControlError("not-authorized", "A loopback Host header is required.", { status: 403 });
  const match = /^(127\.0\.0\.1|localhost)(?::([0-9]{1,5}))?$/.exec(host);
  if (!match) throw new ReferenceControlError("not-authorized", "Host is not the loopback workbench.", { status: 403 });
  const suppliedPort = match[2] === undefined ? 80 : Number(match[2]);
  if (Number.isSafeInteger(localPort) && localPort > 0 && suppliedPort !== localPort) {
    throw new ReferenceControlError("not-authorized", "Host port does not match the loopback listener.", { status: 403 });
  }
  if (!mutation) return;
  const origin = distinctHeader(request, "origin");
  const allowedOrigins = new Set([
    "http://127.0.0.1:" + localPort,
    "http://localhost:" + localPort
  ]);
  if (localPort === 80) {
    allowedOrigins.add("http://127.0.0.1");
    allowedOrigins.add("http://localhost");
  }
  if (typeof origin !== "string" || !allowedOrigins.has(origin)) {
    throw new ReferenceControlError("not-authorized", "Mutation Origin must exactly match the loopback listener.", { status: 403 });
  }
  const fetchSite = distinctHeader(request, "sec-fetch-site");
  if (fetchSite !== undefined && fetchSite !== "same-origin") {
    throw new ReferenceControlError("not-authorized", "Cross-site mutation was rejected.", { status: 403 });
  }
}

function requireJsonContentType(request) {
  const encoding = distinctHeader(request, "content-encoding");
  if (encoding !== undefined && String(encoding).toLocaleLowerCase() !== "identity") {
    throw new ReferenceControlError("validation-failed", "Compressed request bodies are not accepted.", { status: 415 });
  }
  const contentType = distinctHeader(request, "content-type");
  if (typeof contentType !== "string" || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
    throw new ReferenceControlError("validation-failed", "Content-Type must be application/json with optional UTF-8 charset.", { status: 415 });
  }
}

function readJsonBody(request, limit) {
  requireJsonContentType(request);
  const declared = distinctHeader(request, "content-length");
  if (declared !== undefined && (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > limit)) {
    throw new ReferenceControlError("validation-failed", "Request body exceeds its byte limit.", { status: 413 });
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    let settled = false;
    function fail(error) {
      if (settled) return;
      settled = true;
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.resume();
      reject(error);
    }
    function onData(chunk) {
      length += chunk.length;
      if (length > limit) {
        fail(new ReferenceControlError("validation-failed", "Request body exceeds its byte limit.", { status: 413 }));
        return;
      }
      chunks.push(chunk);
    }
    function onEnd() {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks);
      if (raw.length === 0) {
        reject(new ReferenceControlError("validation-failed", "A JSON request body is required.", { status: 400 }));
        return;
      }
      let text;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(raw); }
      catch {
        reject(new ReferenceControlError("validation-failed", "Request body must be valid UTF-8.", { status: 400 }));
        return;
      }
      let value;
      try { value = JSON.parse(text); }
      catch {
        reject(new ReferenceControlError("validation-failed", "Request body must be valid JSON.", { status: 400 }));
        return;
      }
      resolve({ raw, value });
    }
    request.on("data", onData);
    request.on("end", onEnd);
    request.once("aborted", () => fail(new ReferenceControlError("validation-failed", "Request body was interrupted.", { status: 400 })));
    request.once("error", fail);
  });
}

function bearerCredential(request, expectedScheme) {
  const authorization = distinctHeader(request, "authorization");
  if (typeof authorization !== "string") {
    throw new ReferenceControlError("not-authorized", expectedScheme + " authorization is required.", { status: 401 });
  }
  const match = /^(Enrollment|Bearer) ([A-Za-z0-9_-]{32,512})$/.exec(authorization);
  if (!match || match[1] !== expectedScheme) {
    throw new ReferenceControlError("not-authorized", expectedScheme + " authorization is invalid.", { status: 401 });
  }
  return match[2];
}

function sendBuffer(response, status, contentType, body, includeBody = true) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  response.statusCode = status;
  response.setHeader("Content-Type", contentType);
  response.setHeader("Content-Length", bytes.length);
  response.end(includeBody ? bytes : undefined);
}

function sendJson(response, status, value, includeBody = true) {
  sendBuffer(response, status, "application/json; charset=utf-8", JSON.stringify(value) + "\n", includeBody);
}

function sendProblem(response, error) {
  const known = error instanceof ReferenceControlError || error instanceof ReferenceAdministrationError;
  const status = known ? error.status : error instanceof TypeError ? 400 : 500;
  const code = known ? error.code : error instanceof TypeError ? "validation-failed" : "internal-error";
  const message = status === 500 ? "Reference workbench request failed." : error.message;
  sendJson(response, status, {
    schemaVersion: "1",
    documentType: "reference-problem",
    code,
    message
  });
}

function exactQuery(searchParams, allowed) {
  const result = {};
  for (const key of searchParams.keys()) {
    if (!allowed.includes(key) || Object.prototype.hasOwnProperty.call(result, key)) {
      throw new ReferenceControlError("validation-failed", "Query parameters are invalid or duplicated.", { status: 400 });
    }
    const value = searchParams.get(key);
    if (value.length > 256) throw new ReferenceControlError("validation-failed", "Query parameter is too long.", { status: 400 });
    result[key] = value;
  }
  return result;
}

function pageQuery(searchParams) {
  const result = {};
  let count = 0;
  for (const key of searchParams.keys()) {
    count += 1;
    if (count > 21 || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)
        || Object.prototype.hasOwnProperty.call(result, key)) {
      throw new ReferenceControlError("validation-failed", "Page query parameters are invalid or duplicated.", { status: 400 });
    }
    const value = searchParams.get(key);
    if (value.length > 256) throw new ReferenceControlError("validation-failed", "Page query parameter is too long.", { status: 400 });
    result[key] = value;
  }
  return result;
}

function installBrowserProvider(global, api) {
  async function readJson(response) {
    const value = await response.json();
    if (!response.ok) throw new Error(value && value.message ? value.message : "Reference workbench request failed.");
    return value;
  }
  function jsonPost(pathname, value, authorization) {
    const headers = { "Content-Type": "application/json; charset=utf-8" };
    if (authorization) headers.Authorization = authorization;
    return global.fetch(api + pathname, {
      method: "POST",
      credentials: "same-origin",
      headers,
      body: JSON.stringify(value)
    }).then(readJson);
  }
  global.SOC_CONSOLE_CONNECTORS = Object.freeze({
    schemaVersion: "1",
    id: "reference-loopback-connectors",
    getSnapshot(request) {
      const query = new URLSearchParams({ reason: request.reason });
      if (request.knownRevision !== undefined) query.set("knownRevision", String(request.knownRevision));
      return global.fetch(api + "/control/snapshot?" + query, {
        credentials: "same-origin",
        headers: { Accept: "application/json" }
      }).then(readJson);
    },
    execute(request) {
      return jsonPost("/control/commands", request);
    }
  });
  global.SOC_CONSOLE_ADMINISTRATION = Object.freeze({
    schemaVersion: "1",
    id: "reference-loopback-administration",
    getSnapshot(request) {
      const query = new URLSearchParams({ domain: request.domain, reason: request.reason });
      if (request.knownRevision !== undefined) query.set("knownRevision", String(request.knownRevision));
      return global.fetch(api + "/administration/snapshot?" + query, {
        credentials: "same-origin",
        headers: { Accept: "application/json" }
      }).then(readJson);
    },
    getPrompt(request) {
      const query = new URLSearchParams({ promptId: request.promptId });
      return global.fetch(api + "/administration/prompts?" + query, {
        credentials: "same-origin",
        headers: { Accept: "application/json" }
      }).then(readJson);
    },
    execute(request) {
      return jsonPost("/administration/commands", request);
    }
  });
  global.SOC_CONSOLE_AUTH = Object.freeze({
    schemaVersion: "1",
    id: "reference-loopback-auth",
    getSession() {
      return Promise.resolve({
        authenticated: true,
        display: { name: "Loopback operator", initials: "LO" },
        capabilities: ["administration:agents", "administration:governance"]
      });
    },
    login() { return Promise.resolve(); },
    logout() { return Promise.resolve(); }
  });
  global.SOC_CONSOLE_ADAPTER = Object.freeze({
    schemaVersion: "1",
    id: "reference-loopback-pages",
    capabilities: Object.freeze({
      readPages: true,
      runCommands: false,
      uploads: false,
      subscriptions: false,
      persistence: true
    }),
    readPage(request) {
      const query = new URLSearchParams({ route: request.route });
      Object.entries(request.query || {}).forEach(([key, value]) => query.set(key, value));
      return global.fetch(api + "/pages?" + query, {
        credentials: "same-origin",
        headers: { Accept: "application/json" }
      }).then(readJson);
    }
  });
  global.SOC_REFERENCE_WORKBENCH = Object.freeze({
    connectionCheck(document, credential) {
      return jsonPost("/connection-check", document, "Enrollment " + credential);
    },
    ingest(batch, credential) {
      return jsonPost("/ingest", batch, "Bearer " + credential);
    },
    agentConnection(document, credential) {
      return jsonPost("/agents/connection", document, "Enrollment " + credential);
    }
  });
}

function buildBrowserProviderSource(apiBase = API_PREFIX) {
  if (typeof apiBase !== "string" || !/^\/[a-z0-9/_-]+$/i.test(apiBase)) throw new TypeError("Browser provider API base is invalid.");
  return "\"use strict\";\n(" + installBrowserProvider.toString() + ")(window," + JSON.stringify(apiBase) + ");\n";
}

function resolveStaticFile(requestPath, publicRoot) {
  let decoded;
  try { decoded = decodeURIComponent(requestPath); } catch { return null; }
  if (!decoded.startsWith("/") || decoded.includes("\\") || decoded.includes("\u0000")) return null;
  if (decoded.split("/").some((part) => part === "..")) return null;
  const pathname = decoded === "/" ? "/index.html" : decoded;
  const candidate = path.resolve(publicRoot, "." + pathname);
  const rootPrefix = path.resolve(publicRoot) + path.sep;
  return candidate.startsWith(rootPrefix) ? candidate : null;
}

async function serveStatic(response, requestPath, publicRoot, includeBody) {
  const candidate = resolveStaticFile(requestPath, publicRoot);
  if (!candidate) return false;
  try {
    const [realRoot, realCandidate] = await Promise.all([
      fs.promises.realpath(publicRoot),
      fs.promises.realpath(candidate)
    ]);
    if (!realCandidate.startsWith(realRoot + path.sep)) return false;
    const stat = await fs.promises.stat(realCandidate);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return false;
    if (path.basename(realCandidate) === "index.html") {
      const staticSource = await fs.promises.readFile(realCandidate, "utf8");
      const workbenchSource = staticSource.replace("connect-src 'none'", "connect-src 'self'");
      if (workbenchSource === staticSource) throw new Error("The static index CSP boundary could not be adapted for the loopback workbench.");
      sendBuffer(response, 200, "text/html; charset=utf-8", workbenchSource, includeBody);
      return true;
    }
    response.statusCode = 200;
    response.setHeader("Content-Type", CONTENT_TYPES[path.extname(realCandidate).toLowerCase()] || "application/octet-stream");
    response.setHeader("Content-Length", stat.size);
    if (!includeBody) {
      response.end();
      return true;
    }
    const stream = fs.createReadStream(realCandidate);
    stream.once("error", () => response.destroy());
    stream.pipe(response);
    return true;
  } catch {
    return false;
  }
}

function createRequestHandler(options) {
  if (!options || !(options.runtime instanceof ReferenceControlPlane)) throw new TypeError("A ReferenceControlPlane runtime is required.");
  if (!(options.administrationRuntime instanceof ReferenceAdministrationRuntime)) {
    throw new TypeError("A ReferenceAdministrationRuntime is required.");
  }
  const runtime = options.runtime;
  const administrationRuntime = options.administrationRuntime;
  const getPort = typeof options.getPort === "function" ? options.getPort : () => options.port;
  const publicRoot = path.resolve(options.publicRoot || PUBLIC_ROOT);
  const staticEnabled = options.serveStatic !== false;
  const browserSource = Buffer.from(buildBrowserProviderSource(API_PREFIX), "utf8");

  return async function referenceRequestHandler(request, response) {
    addSecurityHeaders(response);
    try {
      const parsed = parseRequestUrl(request.url || "/");
      const method = request.method || "";
      validateAuthority(request, getPort(), method === "POST");

      if (method === "GET" && parsed.pathname === API_PREFIX + "/control/snapshot") {
        const query = exactQuery(parsed.searchParams, ["reason", "knownRevision"]);
        const controlRequest = { schemaVersion: "1", reason: query.reason || "refresh" };
        if (query.knownRevision !== undefined) {
          if (!/^(?:0|[1-9][0-9]*)$/.test(query.knownRevision)) {
            throw new ReferenceControlError("validation-failed", "knownRevision is invalid.", { status: 400 });
          }
          controlRequest.knownRevision = Number(query.knownRevision);
        }
        sendJson(response, 200, runtime.getSnapshot(controlRequest));
        return;
      }

      if (method === "POST" && parsed.pathname === API_PREFIX + "/control/commands") {
        if (parsed.search) throw new ReferenceControlError("validation-failed", "Command endpoint does not accept a query.", { status: 400 });
        const body = await readJsonBody(request, CONTROL_BODY_LIMIT);
        sendJson(response, 200, runtime.execute(body.value));
        return;
      }

      if (method === "GET" && parsed.pathname === API_PREFIX + "/administration/snapshot") {
        const query = exactQuery(parsed.searchParams, ["domain", "reason", "knownRevision"]);
        const snapshotRequest = {
          schemaVersion: "1",
          documentType: "administration-snapshot-request",
          domain: query.domain,
          reason: query.reason || "refresh"
        };
        if (query.knownRevision !== undefined) {
          if (!/^(?:0|[1-9][0-9]*)$/.test(query.knownRevision)) {
            throw new ReferenceAdministrationError("validation-failed", "knownRevision is invalid.", { status: 400 });
          }
          snapshotRequest.knownRevision = Number(query.knownRevision);
        }
        sendJson(response, 200, administrationRuntime.getSnapshot(snapshotRequest));
        return;
      }

      if (method === "GET" && parsed.pathname === API_PREFIX + "/administration/prompts") {
        const query = exactQuery(parsed.searchParams, ["promptId"]);
        sendJson(response, 200, administrationRuntime.getPrompt({
          schemaVersion: "1",
          documentType: "agent-prompt-request",
          promptId: query.promptId
        }));
        return;
      }

      if (method === "POST" && parsed.pathname === API_PREFIX + "/administration/commands") {
        if (parsed.search) throw new ReferenceAdministrationError("validation-failed", "Administration command endpoint does not accept a query.", { status: 400 });
        const body = await readJsonBody(request, CONTROL_BODY_LIMIT);
        sendJson(response, 200, administrationRuntime.execute(body.value));
        return;
      }

      if (method === "GET" && parsed.pathname === API_PREFIX + "/pages") {
        const query = pageQuery(parsed.searchParams);
        const route = query.route || "/";
        delete query.route;
        sendJson(response, 200, runtime.readPage(route, query));
        return;
      }

      if (method === "POST" && parsed.pathname === API_PREFIX + "/connection-check") {
        if (parsed.search) throw new ReferenceControlError("validation-failed", "Connection-check endpoint does not accept a query.", { status: 400 });
        const credential = bearerCredential(request, "Enrollment");
        const body = await readJsonBody(request, CONTROL_BODY_LIMIT);
        sendJson(response, 200, runtime.proveConnection(body.value, credential));
        return;
      }

      if (method === "POST" && parsed.pathname === API_PREFIX + "/agents/connection") {
        if (parsed.search) throw new ReferenceAdministrationError("validation-failed", "Agent-connection endpoint does not accept a query.", { status: 400 });
        const credential = bearerCredential(request, "Enrollment");
        const body = await readJsonBody(request, CONTROL_BODY_LIMIT);
        sendJson(response, 200, administrationRuntime.proveAgentConnection(body.value, credential));
        return;
      }

      if (method === "POST" && parsed.pathname === API_PREFIX + "/ingest") {
        if (parsed.search) throw new ReferenceControlError("validation-failed", "Ingest endpoint does not accept a query.", { status: 400 });
        const credential = bearerCredential(request, "Bearer");
        const body = await readJsonBody(request, INGEST_BODY_LIMIT);
        const bodyHash = crypto.createHash("sha256").update(body.raw).digest("hex");
        sendJson(response, 200, runtime.ingest(body.value, credential, bodyHash));
        return;
      }

      if ((method === "GET" || method === "HEAD")
          && (parsed.pathname === "/application-bridge.js" || parsed.pathname === API_PREFIX + "/browser-provider.js")) {
        sendBuffer(response, 200, "text/javascript; charset=utf-8", browserSource, method === "GET");
        return;
      }

      if ((method === "GET" || method === "HEAD") && staticEnabled) {
        if (await serveStatic(response, parsed.pathname, publicRoot, method === "GET")) return;
      }

      if (method === "OPTIONS") {
        response.setHeader("Allow", "GET, HEAD, POST");
        sendProblem(response, new ReferenceControlError("validation-failed", "CORS preflight is not supported.", { status: 405 }));
        return;
      }
      sendProblem(response, new ReferenceControlError("not-found", "Endpoint was not found.", { status: 404 }));
    } catch (error) {
      if (!response.headersSent) sendProblem(response, error);
      else response.destroy();
    }
  };
}

function createReferenceServer(options = {}) {
  if (options.host !== undefined && options.host !== HOST) throw new TypeError("Reference server host is fixed to 127.0.0.1.");
  const ownsRuntime = !options.runtime;
  const runtime = options.runtime || new ReferenceControlPlane({
    stateDirectory: options.stateDirectory,
    clock: options.clock,
    enrollmentTtlMs: options.enrollmentTtlMs,
    ingestTtlMs: options.ingestTtlMs
  });
  const ownsAdministrationRuntime = !options.administrationRuntime;
  let administrationRuntime;
  try {
    administrationRuntime = options.administrationRuntime || new ReferenceAdministrationRuntime({
      stateDirectory: options.stateDirectory,
      clock: options.clock
    });
  } catch (error) {
    if (ownsRuntime) runtime.dispose();
    throw error;
  }
  let server;
  const handler = createRequestHandler({
    runtime,
    administrationRuntime,
    publicRoot: options.publicRoot,
    serveStatic: options.serveStatic,
    port: options.port,
    getPort: () => {
      const address = server && server.address();
      return address && typeof address === "object" ? address.port : options.port;
    }
  });
  server = http.createServer(handler);
  server.referenceRuntime = runtime;
  server.referenceAdministrationRuntime = administrationRuntime;
  server.referenceOwnsRuntime = ownsRuntime;
  server.referenceOwnsAdministrationRuntime = ownsAdministrationRuntime;
  server.once("close", () => {
    if (ownsRuntime) runtime.dispose();
    if (ownsAdministrationRuntime) administrationRuntime.dispose();
  });
  return server;
}

function startReferenceServer(options = {}) {
  const port = options.port === 0 ? 0 : parsePort(options.port, DEFAULT_PORT);
  const server = createReferenceServer({ ...options, host: HOST, port });
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      if (server.referenceOwnsRuntime) server.referenceRuntime.dispose();
      if (server.referenceOwnsAdministrationRuntime) server.referenceAdministrationRuntime.dispose();
      reject(error);
    };
    server.once("error", onError);
    server.listen(port, HOST, () => {
      server.removeListener("error", onError);
      const address = server.address();
      resolve({
        server,
        runtime: server.referenceRuntime,
        administrationRuntime: server.referenceAdministrationRuntime,
        host: HOST,
        port: address.port,
        url: "http://" + HOST + ":" + address.port,
        close() {
          return new Promise((closeResolve, closeReject) => {
            server.close((error) => error ? closeReject(error) : closeResolve());
          });
        }
      });
    });
  });
}

function parseArguments(argv, environment) {
  const result = {
    stateDirectory: environment.SOC_REFERENCE_STATE_DIR,
    port: environment.SOC_REFERENCE_PORT
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--state-dir") result.stateDirectory = argv[++index];
    else if (argument === "--port") result.port = argv[++index];
    else if (argument === "--no-static") result.serveStatic = false;
    else throw new TypeError("Unknown reference server argument: " + argument);
  }
  if (typeof result.stateDirectory !== "string" || !result.stateDirectory.trim()) {
    throw new TypeError("Set SOC_REFERENCE_STATE_DIR or pass --state-dir with an explicit local state directory.");
  }
  result.port = parsePort(result.port, DEFAULT_PORT);
  return result;
}

async function main(argv = process.argv.slice(2), environment = process.env) {
  try {
    const options = parseArguments(argv, environment);
    const started = await startReferenceServer(options);
    console.log("REFERENCE LOOPBACK MODE — NOT FOR PRODUCTION");
    console.log("Bulwark Black connector workbench: " + started.url);
    console.log("State directory: " + path.resolve(options.stateDirectory));
    const shutdown = () => started.close().catch(() => {}).finally(() => { process.exitCode = 0; });
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    return started;
  } catch (error) {
    console.error("Unable to start reference connector workbench: " + error.message);
    process.exitCode = 1;
    return null;
  }
}

if (require.main === module) void main();

module.exports = {
  API_PREFIX,
  CONTROL_BODY_LIMIT,
  CSP,
  DEFAULT_PORT,
  HOST,
  INGEST_BODY_LIMIT,
  PUBLIC_ROOT,
  buildBrowserProviderSource,
  createReferenceServer,
  createRequestHandler,
  main,
  parseArguments,
  parsePort,
  startReferenceServer,
  validateAuthority
};
