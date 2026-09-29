#!/usr/bin/env node
"use strict";

// A single-tenant private starter. Never bind this listener to a public interface.
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { ReferenceControlPlane, ReferenceControlError } = require("./reference-runtime");
const { ReferenceAdministrationRuntime } = require("./reference-administration-runtime");
const { createPrivateAuth, validatePrivateOrigin } = require("./private-auth");
const { createDocumentStore } = require("./document-store");
const { runAsOperator, runAsService, operatorId } = require("./operator-context");
const { createServiceAccessStore, handleServiceManagement, handleServiceRequest, isServicePath } = require("./service-access");
const { handleScannerImport } = require("./scanner-ingest");
const { SqliteTelemetryStore } = require("./sqlite-telemetry-store");
const {
  createRequestHandler, buildBrowserProviderSource, addSecurityHeaders,
  parseRequestUrl, distinctHeader, readJsonBody, sendJson, sendBuffer, serveStatic,
  PUBLIC_ROOT, parsePort
} = require("./reference-control-plane");

const MACHINE_PATHS = new Set(["/api/v1/ingest", "/api/v1/connection-check", "/api/v1/agents/connection"]);
const UPLOAD_LIMIT = 10 * 1024 * 1024;
const SCANNER_IMPORT_PATH = "/api/v1/scanners/trivy/import";

function fail(status, message) {
  return new ReferenceControlError(status === 401 ? "not-authenticated" : "request-rejected", message, { status });
}

function validatePrivateRequest(request, baseURL) {
  const origin = new URL(baseURL);
  if (distinctHeader(request, "host") !== origin.host) throw fail(403, "Host must match the configured private origin.");
  const suppliedOrigin = distinctHeader(request, "origin");
  const pathname = parseRequestUrl(request.url).pathname;
  const machine = MACHINE_PATHS.has(pathname) || isServicePath(pathname)
    || (pathname === SCANNER_IMPORT_PATH && distinctHeader(request, "authorization") !== undefined);
  const mutation = !["GET", "HEAD", "OPTIONS"].includes(request.method);
  if (suppliedOrigin !== undefined && suppliedOrigin !== origin.origin) throw fail(403, "Origin must match the private application.");
  if (mutation && !machine && suppliedOrigin !== origin.origin) throw fail(403, "A same-origin request is required.");
  const site = distinctHeader(request, "sec-fetch-site");
  if (site && !["same-origin", "none"].includes(site)) throw fail(403, "Cross-site requests are not allowed.");
}

function browserPrivateAuth(global) {
  global.SOC_PRIVATE_APPLICATION = true;
  global.SOC_CONSOLE_AUTH = Object.freeze({
    schemaVersion: "1", id: "private-better-auth",
    async getSession() {
      const response = await global.fetch("/api/v1/session", { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error("Session could not be checked.");
      return response.json();
    },
    login({ returnTo }) { global.location.assign("/sign-in?returnTo=" + encodeURIComponent(returnTo)); },
    async logout() {
      const response = await global.fetch("/api/auth/sign-out", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}"
      });
      if (!response.ok) throw new Error("Sign out failed. Try again.");
      global.location.assign("/sign-in");
    }
  });
}

function requestHeaders(request) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

function sessionView(session) {
  if (!session || !session.user) return { authenticated: false };
  const name = String(session.user.name || "Operator").slice(0, 120);
  const initials = name.split(/\s+/).map((word) => Array.from(word)[0] || "").join("").replace(/[^\p{L}\p{N}]/gu, "").slice(0, 4) || "OP";
  return { authenticated: true, display: { name, initials }, capabilities: ["administration:agents", "administration:governance"] };
}

function telemetryStoragePage(runtime, view = "policy") {
  const stats = runtime.store.stats();
  const policy = stats.retention;
  const panels = view === "reality" ? [
    { id: "summary-metrics", type: "metrics", title: "Current indexed telemetry storage", items: [
      { label: "Retained records", value: stats.records, tone: "info" },
      { label: "Payload bytes", value: stats.recordBytes, tone: "info" },
      { label: "Replay receipts", value: stats.receipts, tone: "info" },
      { label: "Deduplication identities", value: stats.identities, tone: "info" }
    ] },
    { id: "measured-horizon", type: "notice", title: "What these measurements cover", tone: "info",
      body: "These are actual SQLite telemetry counters, not filesystem size or free disk. Indexes, WAL, audit, authentication, service credentials and Documents consume additional storage. Per-source horizon verification and archived-baseline inventories are not implemented." }
  ] : [
    { id: "declared-policy", type: "table", title: "Configured telemetry retention", caption: "Enforced by the private telemetry store; this is not a compliance certification or a backup policy.",
      columns: [{ key: "limit", label: "Limit" }, { key: "value", label: "Configured value" }], rows: [
        ["Record payload count", String(policy.maxRecords)], ["Record payload bytes", String(policy.maxRecordBytes)],
        ["Record age (days after admission)", String(policy.recordDays)], ["Replay window (days)", String(policy.replayDays)],
        ["Receipt capacity", String(policy.maxReceipts)], ["Record identity capacity", String(policy.maxRecordIdentities)],
        ["Audit row capacity", String(policy.maxAuditRows)]
      ] },
    { id: "enforcement-the-honest-gap", type: "notice", title: "Retention and capacity behavior", tone: "warn",
      body: "Successful state mutations apply retention. Oldest telemetry payloads are pruned by age, count and byte limits; no background purge runs while idle. Receipt and deduplication identities are retained through their replay window. Full receipt, identity or audit capacity refuses admission instead of shortening that guarantee. Raw payload eviction is not backup, legal hold or secure erasure." }
  ];
  return { schemaVersion: "1", route: "/retention", state: "ready", title: "Telemetry storage and retention",
    updatedAt: new Date().toISOString(), summary: "Indexed telemetry revision " + stats.revision + ". Single-writer, bounded local storage; Documents and administration have separate limits.", panels };
}

async function readUpload(request) {
  if (distinctHeader(request, "content-type") !== "application/octet-stream") throw fail(415, "Upload bytes as application/octet-stream.");
  if (request.headers["content-encoding"]) throw fail(415, "Compressed uploads are not accepted.");
  const length = distinctHeader(request, "content-length");
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > UPLOAD_LIMIT)) throw fail(413, "Upload exceeds 10 MiB.");
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > UPLOAD_LIMIT) throw fail(413, "Upload exceeds 10 MiB.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function queryOptions(url, allowed) {
  const result = {};
  for (const [key, value] of url.searchParams) {
    if (!allowed.includes(key) || Object.hasOwn(result, key) || value.length > 256) throw fail(400, "Invalid query parameters.");
    result[key] = ["limit", "offset"].includes(key) ? Number(value) : value;
  }
  return result;
}

async function handleDocuments(request, response, url, documents, actor) {
  const base = "/api/v1/documents";
  const relative = url.pathname.slice(base.length);
  if (request.method === "GET" && relative === "") {
    sendJson(response, 200, documents.list(queryOptions(url, ["archived", "appId", "offset", "limit"])));
    return;
  }
  if (url.search) throw fail(400, "This document endpoint does not accept a query.");
  if (request.method === "POST" && relative === "/upload") {
    const encoded = distinctHeader(request, "x-document-metadata");
    if (!encoded || encoded.length > 8192) throw fail(400, "Upload metadata is required and must fit in 8 KiB.");
    let metadata;
    try { metadata = JSON.parse(decodeURIComponent(encoded)); } catch { throw fail(400, "Upload metadata is invalid."); }
    const bytes = await readUpload(request);
    sendJson(response, 201, documents.upload({ ...metadata, bytes, actor }));
    return;
  }
  const match = /^\/([a-zA-Z0-9_-]+)(?:\/(archive|restore)|\/versions\/([1-9][0-9]*)\/download)?$/.exec(relative);
  if (!match) throw fail(404, "Document endpoint not found.");
  const id = match[1];
  if (request.method === "GET" && match[3]) {
    const file = documents.download({ id, version: Number(match[3]) });
    response.setHeader("Content-Disposition", "attachment; filename*=UTF-8''" + encodeURIComponent(file.filename).replace(/['()]/g, (c) => "%" + c.charCodeAt(0).toString(16)));
    response.setHeader("X-Content-SHA256", file.sha256);
    sendBuffer(response, 200, "application/octet-stream", file.bytes);
    return;
  }
  if (request.method === "GET" && !match[2]) { sendJson(response, 200, documents.get(id)); return; }
  if (request.method === "PATCH" && !match[2] && !match[3]) {
    const { value } = await readJsonBody(request, 16384);
    sendJson(response, 200, documents.update({ ...value, id, actor }));
    return;
  }
  if (request.method === "POST" && match[2]) {
    const { value } = await readJsonBody(request, 16384);
    sendJson(response, 200, documents[match[2]]({ ...value, id, actor }));
    return;
  }
  throw fail(405, "Document method is not supported.");
}

async function startPrivateApplication(options = {}) {
  const port = options.port === 0 ? 0 : parsePort(options.port, 8080);
  if (typeof options.stateDirectory !== "string" || !path.isAbsolute(options.stateDirectory)) throw new TypeError("An absolute external state directory is required.");
  const project = path.resolve(__dirname, "..");
  const requested = path.resolve(options.stateDirectory);
  if (requested === project || requested.startsWith(project + path.sep)) throw new TypeError("Private state must be outside the repository.");
  let authentication, documents, runtime, administrationRuntime, serviceAccess;
  let activeUploads = 0;
  let origin = options.baseURL || "http://127.0.0.1:" + port;
  const server = http.createServer();
  const notReady = (_request, response) => { response.writeHead(503, { "Retry-After": "1" }); response.end("Private application is starting."); };
  server.on("request", notReady);
  // Bind before constructing origin-dependent auth, supporting ephemeral ports in tests.
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
    if (!options.baseURL) origin = "http://127.0.0.1:" + server.address().port;
    origin = validatePrivateOrigin(origin);
    if (origin.startsWith("http:") && Number(new URL(origin).port || 80) !== server.address().port) throw new TypeError("Local origin port must match the listener port.");
    authentication = await createPrivateAuth({ stateDir: requested, baseURL: origin });
    const realState = fs.realpathSync(requested);
    if (realState === project || realState.startsWith(project + path.sep)) throw new TypeError("Private state must be outside the repository.");
    documents = createDocumentStore({ stateDir: realState });
    serviceAccess = createServiceAccessStore({ stateDir: realState });
    runtime = new ReferenceControlPlane({
      store: new SqliteTelemetryStore({ directory: realState, retention: options.telemetryRetention }),
      enabledConnectorTypes: ["canonical-push", "trivy-report"]
    });
    administrationRuntime = new ReferenceAdministrationRuntime({ stateDirectory: realState });
    const providerSource = buildBrowserProviderSource() + "\n(" + browserPrivateAuth.toString() + ")(window);\n";
    const referenceHandler = createRequestHandler({ runtime, administrationRuntime, browserSource: providerSource, validateAuthority() {} });
    server.requestTimeout = 30000;
    server.headersTimeout = 10000;
    server.maxRequestsPerSocket = 1000;
    server.removeListener("request", notReady);
    server.on("request", async (request, response) => {
      addSecurityHeaders(response);
      let uploadLease = false;
      try {
        const url = parseRequestUrl(request.url || "/");
        validatePrivateRequest(request, origin);
        if (url.pathname.startsWith("/api/auth/")) {
          if (url.search) throw fail(400, "Auth endpoint query is not supported.");
          const headers = requestHeaders(request);
          const body = request.method === "POST" ? (await readJsonBody(request, 16384)).raw : undefined;
          const result = await authentication.handler(new Request(origin + url.pathname, { method: request.method, headers, body }), { clientIP: request.socket.remoteAddress });
          response.statusCode = result.status;
          result.headers.forEach((value, key) => { if (key.toLowerCase() !== "set-cookie") response.setHeader(key, value); });
          const cookies = result.headers.getSetCookie();
          if (cookies.length) response.setHeader("Set-Cookie", cookies);
          response.end(Buffer.from(await result.arrayBuffer()));
          return;
        }
        if (url.pathname === "/sign-in" && ["GET", "HEAD"].includes(request.method)) {
          await serveStatic(response, "/sign-in.html", PUBLIC_ROOT, request.method === "GET");
          return;
        }
        if (url.pathname === "/app-config.js" && ["GET", "HEAD"].includes(request.method)) {
          const source = 'window.SOC_CONSOLE_PUBLIC_CONFIG = { mode: "application", auth: { required: true } };\n'
            + fs.readFileSync(path.join(PUBLIC_ROOT, "app-config.js"), "utf8");
          sendBuffer(response, 200, "text/javascript; charset=utf-8", source, request.method === "GET");
          return;
        }
        if (!url.pathname.startsWith("/api/") || url.pathname === "/api/v1/browser-provider.js") {
          await referenceHandler(request, response);
          return;
        }
        if (isServicePath(url.pathname)) {
          await handleServiceRequest({ request, response, url, store: serviceAccess, runtime, administrationRuntime, runAsService });
          return;
        }
        if (url.pathname === SCANNER_IMPORT_PATH && distinctHeader(request, "authorization") !== undefined) {
          if (activeUploads >= 2) throw fail(429, "Two uploads are already in progress. Retry after they complete.");
          activeUploads += 1; uploadLease = true;
          await handleScannerImport({ request, response, url, runtime });
          return;
        }
        if (MACHINE_PATHS.has(url.pathname)) { await referenceHandler(request, response); return; }
        if (distinctHeader(request, "authorization") !== undefined) throw fail(401, "Operator endpoints require a browser session without machine authorization.");
        const session = await authentication.getSession(requestHeaders(request));
        if (url.pathname === "/api/v1/session" && request.method === "GET") { sendJson(response, 200, sessionView(session)); return; }
        if (!session || !session.user) throw fail(401, "Sign in to access this private application.");
        if (request.method === "GET" && url.pathname === "/api/v1/telemetry/storage") {
          if (url.search) throw fail(400, "Storage status does not accept query parameters.");
          sendJson(response, 200, runtime.store.stats());
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/v1/pages" && url.searchParams.get("route") === "/retention"
            && (!url.searchParams.has("vtab") || ["policy", "reality"].includes(url.searchParams.get("vtab")))) {
          queryOptions(url, ["route", "vtab"]);
          sendJson(response, 200, telemetryStoragePage(runtime, url.searchParams.get("vtab") || "policy"));
          return;
        }
        if (url.pathname === SCANNER_IMPORT_PATH) {
          if (activeUploads >= 2) throw fail(429, "Two uploads are already in progress. Retry after they complete.");
          activeUploads += 1; uploadLease = true;
          await runAsOperator(session.user.id, () => handleScannerImport({ request, response, url, runtime, actor: operatorId(session.user.id) }));
          return;
        }
        if (url.pathname === "/api/v1/service-access" || url.pathname.startsWith("/api/v1/service-access/")) {
          await handleServiceManagement({ request, response, url, store: serviceAccess, actor: operatorId(session.user.id) });
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/v1/pages" && url.searchParams.get("route") === "/access"
            && (!url.searchParams.has("atab") || url.searchParams.get("atab") === "who")) {
          queryOptions(url, ["route", "atab"]);
          const total = authentication.countOperators();
          sendJson(response, 200, {
            schemaVersion: "1", route: "/access", state: "ready", title: "Private application access",
            updatedAt: new Date().toISOString(), summary: "All " + total + " provisioned account(s) have full operator access. This starter has no read-only auditor role.",
            panels: [
              { id: "you-right-now", type: "notice", title: "You, right now", tone: "info", body: "Signed in as " + session.user.name + ". Your session expires after eight hours. Account controls are below." },
              { id: "who-has-full-access", type: "table", title: "Who has full access", caption: "Provisioned operators (first 200 of " + total + "). Names are display labels, not unique identities.",
                columns: [{ key: "name", label: "Identity" }, { key: "level", label: "Level" }, { key: "authority", label: "Can do" }],
                rows: authentication.listOperatorNames().map((name) => [name, "Full operator", "All private application reads and writes"]) },
              { id: "how-identity-works-here", type: "notice", title: "How identity works here", tone: "info", body: "Better Auth checks server-side sessions. Public registration is disabled. The installation owner provisions accounts and resets passwords locally. Tailnet membership alone does not grant an application session." }
            ]
          });
          return;
        }
        if (url.pathname === "/api/v1/documents" || url.pathname.startsWith("/api/v1/documents/")) {
          if (url.pathname.endsWith("/upload")) {
            if (activeUploads >= 2) throw fail(429, "Two uploads are already in progress. Retry after they complete.");
            activeUploads += 1; uploadLease = true;
          }
          await handleDocuments(request, response, url, documents, operatorId(session.user.id));
          return;
        }
        await runAsOperator(session.user.id, () => referenceHandler(request, response));
      } catch (error) {
        if (response.headersSent) { response.destroy(); return; }
        const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : error instanceof TypeError ? 400 : 500;
        sendJson(response, status, { code: error.code || "request-failed", message: status === 500 ? "Private application request failed." : error.message });
      } finally { if (uploadLease) activeUploads -= 1; }
    });
    let closed = false;
    return { server, url: origin, authentication, documents, runtime, administrationRuntime, serviceAccess,
      async close() {
        if (closed) return;
        closed = true;
        await new Promise((resolve) => server.close(resolve));
        runtime.dispose(); administrationRuntime.dispose(); documents.close(); serviceAccess.close(); await authentication.close();
      }
    };
  } catch (error) {
    server.close(); runtime?.dispose(); administrationRuntime?.dispose(); documents?.close(); serviceAccess?.close(); await authentication?.close();
    throw error;
  }
}

async function main(argv = process.argv.slice(2), environment = process.env) {
  const options = { stateDirectory: environment.SOC_STATE_DIR, baseURL: environment.SOC_BASE_URL, port: environment.SOC_PORT };
  for (let i = 0; i < argv.length; i += 1) {
    const key = { "--state-dir": "stateDirectory", "--origin": "baseURL", "--port": "port" }[argv[i]];
    if (!key || !argv[i + 1]) throw new TypeError("Use --state-dir, --origin, and --port with values.");
    options[key] = argv[++i];
  }
  const app = await startPrivateApplication(options);
  console.log("Bulwark Black private application: " + app.url);
  console.log("Single-tenant starter; all provisioned operators have full access. No public signup.");
  console.log("Keep the listener on loopback. Use private Tailnet HTTPS Serve, never Funnel or public ingress.");
  const stop = () => { void app.close().catch(() => { process.exitCode = 1; }); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  return app;
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { startPrivateApplication, validatePrivateRequest, sessionView, telemetryStoragePage, handleDocuments, main };
