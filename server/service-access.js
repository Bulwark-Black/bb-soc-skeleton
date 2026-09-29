"use strict";

// Service access is a separate, least-privilege identity plane. Browser cookies
// never authorize these endpoints and service credentials never mint credentials.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const ConnectorContract = require("../public/connector-contract");
const AdministrationContract = require("../public/administration-contract");
const { distinctHeader, readJsonBody, sendJson } = require("./reference-control-plane");

const DEFAULT_SCOPES = Object.freeze(["connector:read", "agents:read", "governance:read"]);
const CONNECTOR_COMMANDS = Object.freeze(["app.register", "source.setup", "source.test", "source.update", "source.pause", "source.resume", "source.archive", "source.remove", "source.revoke"]);
const ADMINISTRATION_COMMANDS = Object.freeze([
  "agent.pause", "agent.archive", "agent.remove", "prompt.revise", "prompt.archive", "enrollment.revoke",
  "attestation.create", "attestation.update", "attestation.transition", "attestation.archive", "attestation.restore", "attestation.remove",
  "risk.create", "risk.update", "risk.transition", "risk.archive", "risk.restore", "risk.remove"
]);
const SCOPES = Object.freeze([...DEFAULT_SCOPES, "prompts:read", ...CONNECTOR_COMMANDS.map(command => "connector:" + command), ...ADMINISTRATION_COMMANDS.map(command => "administration:" + command)]);
const SERVICE_ID = /^service-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^bbsvc_(service-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;
const MAX_SERVICES = 1000;
const MAX_AUDIT = 10000;
const DEFAULT_LIFETIME_SECONDS = 86400;
const MAX_LIFETIME_SECONDS = 30 * 86400;
const RATE_PER_MINUTE = 120;

class ServiceAccessError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = "ServiceAccessError"; this.code = code; this.status = status; }
}
function fail(code, message, status) { throw new ServiceAccessError(code, message, status); }
function exact(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) fail("invalid-input", "Expected a plain object.");
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !allowed.includes(key) || property.get || property.set) fail("invalid-input", "Unsupported input field.");
  }
}
function text(value, maximum) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) fail("invalid-input", "Text field is invalid.");
  return value.trim();
}
function actorId(value) {
  if (typeof value !== "string" || !/^operator:[a-f0-9]{64}$/.test(value)) fail("human-required", "An authenticated human operator is required.", 403);
  return value;
}
function secureDatabasePath(directory) {
  if (typeof directory !== "string" || !path.isAbsolute(directory) || directory !== path.resolve(directory)) fail("invalid-storage", "Service state requires a canonical absolute private state directory.", 503);
  const root = fs.realpathSync(path.join(__dirname, ".."));
  if (directory === path.parse(directory).root || directory === root || directory.startsWith(root + path.sep) || root.startsWith(directory + path.sep)) fail("invalid-storage", "Service state must be outside the repository.", 503);
  let cursor = path.parse(directory).root;
  for (const part of directory.slice(cursor.length).split(path.sep)) {
    cursor = path.join(cursor, part);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail("invalid-storage", "Service state cannot use linked directories.", 503);
  }
  const stat = fs.lstatSync(directory);
  if ((stat.mode & 0o077) || (typeof process.getuid === "function" && stat.uid !== process.getuid())) fail("invalid-storage", "Service state must be owner-only (0700).", 503);
  const filename = path.join(directory, "service-access.sqlite");
  for (const suffix of ["", "-wal", "-shm", "-journal"]) inspectFile(filename + suffix);
  if (!fs.existsSync(filename)) {
    const fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.closeSync(fd);
  }
  return filename;
}
function inspectFile(filename) {
  let stat;
  try { stat = fs.lstatSync(filename); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) || (typeof process.getuid === "function" && stat.uid !== process.getuid())) fail("invalid-storage", "Service database files must be private regular files without links.", 503);
}
function publicService(row, now) {
  return { id: row.id, name: row.name, scopes: JSON.parse(row.scopes), revision: row.revision,
    createdAt: row.created_at, expiresAt: row.expires_at, lastUsedAt: row.last_used_at,
    rotatedAt: row.rotated_at, revokedAt: row.revoked_at,
    status: row.revoked_at ? "revoked" : Date.parse(row.expires_at) <= now ? "expired" : "active" };
}
function credentialFor(id) { return "bbsvc_" + id + "_" + crypto.randomBytes(32).toString("base64url"); }
function digest(value) { return crypto.createHash("sha256").update(value).digest(); }

function createServiceAccessStore({ stateDir, clock = () => new Date() } = {}) {
  const filename = secureDatabasePath(stateDir);
  const db = new Database(filename, { timeout: 5000 });
  let closed = false;
  const now = () => {
    const instant = new Date(clock());
    if (!Number.isFinite(instant.getTime())) throw new TypeError("Service clock is invalid.");
    return instant;
  };
  try {
    db.pragma("trusted_schema = OFF");
    const version = db.pragma("user_version", { simple: true });
    if (version !== 0 && version !== 1) fail("invalid-storage", "Unsupported service database version.", 503);
    if (version === 0) {
      if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().length) fail("invalid-storage", "Unrecognized service database.", 503);
      db.transaction(() => {
        db.exec(`CREATE TABLE service_access (id TEXT PRIMARY KEY, name TEXT NOT NULL, scopes TEXT NOT NULL, revision INTEGER NOT NULL,
          digest BLOB NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, last_used_at TEXT, rotated_at TEXT, revoked_at TEXT,
          rate_window INTEGER NOT NULL DEFAULT 0, rate_count INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE service_audit (sequence INTEGER PRIMARY KEY AUTOINCREMENT, service_id TEXT NOT NULL,
          action TEXT NOT NULL, actor TEXT NOT NULL, outcome TEXT NOT NULL, occurred_at TEXT NOT NULL);
          PRAGMA user_version = 1;`);
      })();
    }
    db.pragma("journal_mode = WAL"); db.pragma("synchronous = FULL");
    for (const suffix of ["", "-wal", "-shm"]) if (fs.existsSync(filename + suffix)) fs.chmodSync(filename + suffix, 0o600);
  } catch (error) { db.close(); throw error; }
  const find = id => db.prepare("SELECT * FROM service_access WHERE id = ?").get(id);
  function audit(id, action, actor, outcome, at) {
    db.prepare("INSERT INTO service_audit (service_id, action, actor, outcome, occurred_at) VALUES (?, ?, ?, ?, ?)").run(id, action, actor, outcome, at);
    db.prepare("DELETE FROM service_audit WHERE sequence <= (SELECT COALESCE(MAX(sequence), 0) - ? FROM service_audit)").run(MAX_AUDIT);
  }
  function checkedId(value) { if (!SERVICE_ID.test(value)) fail("invalid-input", "Service identity is invalid."); return value; }
  function validCredential(value) {
    const match = typeof value === "string" && TOKEN.exec(value);
    const row = match && find(match[1]);
    const actual = digest(typeof value === "string" ? value : "");
    const wanted = row ? row.digest : Buffer.alloc(32);
    if (!crypto.timingSafeEqual(actual, wanted) || !row || row.revoked_at || Date.parse(row.expires_at) <= now().getTime()) fail("service-unauthorized", "A valid, unexpired service credential is required.", 401);
    return row;
  }
  return Object.freeze({
    list({ offset = 0, limit = 50 } = {}) {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail("invalid-input", "Invalid service pagination.");
      const services = db.prepare("SELECT * FROM service_access ORDER BY created_at DESC, id LIMIT ? OFFSET ?").all(limit, offset).map(row => publicService(row, now().getTime()));
      const total = db.prepare("SELECT COUNT(*) AS count FROM service_access").get().count;
      return { services, total, offset, nextOffset: offset + services.length < total ? offset + services.length : null,
        availableScopes: SCOPES, defaultScopes: DEFAULT_SCOPES, defaultLifetimeSeconds: DEFAULT_LIFETIME_SECONDS,
        maxLifetimeSeconds: MAX_LIFETIME_SECONDS, ratePerMinute: RATE_PER_MINUTE, auditRetention: MAX_AUDIT,
        audit: db.prepare("SELECT service_id AS serviceId, action, actor, outcome, occurred_at AS occurredAt FROM service_audit ORDER BY sequence DESC LIMIT 100").all() };
    },
    issue(input, actor) {
      exact(input, ["name", "scopes", "expiresInSeconds"]); actorId(actor);
      const name = text(input.name, 120);
      const scopes = input.scopes === undefined ? [...DEFAULT_SCOPES] : input.scopes;
      if (!Array.isArray(scopes) || !scopes.length || scopes.length > SCOPES.length || new Set(scopes).size !== scopes.length || scopes.some(scope => !SCOPES.includes(scope))) fail("invalid-input", "Choose one or more explicit supported scopes.");
      const lifetime = input.expiresInSeconds === undefined ? DEFAULT_LIFETIME_SECONDS : input.expiresInSeconds;
      if (!Number.isSafeInteger(lifetime) || lifetime < 300 || lifetime > MAX_LIFETIME_SECONDS) fail("invalid-input", "Service expiry must be between five minutes and thirty days.");
      return db.transaction(() => {
        if (db.prepare("SELECT COUNT(*) AS count FROM service_access").get().count >= MAX_SERVICES) fail("service-limit", "Service identity retention limit reached.", 409);
        const at = now(); const id = "service-" + crypto.randomUUID(); const credential = credentialFor(id);
        db.prepare("INSERT INTO service_access (id,name,scopes,revision,digest,created_at,expires_at) VALUES (?,?,?,?,?,?,?)")
          .run(id, name, JSON.stringify(scopes), 1, digest(credential), at.toISOString(), new Date(at.getTime() + lifetime * 1000).toISOString());
        audit(id, "service.issue", actor, "succeeded", at.toISOString());
        return { service: publicService(find(id), at.getTime()), oneTimeCredential: credential };
      }).immediate();
    },
    change(id, action, input, actor) {
      checkedId(id); actorId(actor); exact(input, ["expectedRevision"]);
      if (!["rotate", "revoke"].includes(action)) fail("invalid-input", "Unsupported service change.");
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) fail("invalid-input", "Expected revision is required.");
      return db.transaction(() => {
        const row = find(id); const at = now();
        if (!row) fail("not-found", "Service identity was not found.", 404);
        if (row.revision !== input.expectedRevision) fail("revision-conflict", "Service identity changed. Refresh before retrying.", 409);
        if (row.revoked_at || (action === "rotate" && Date.parse(row.expires_at) <= at.getTime())) fail("transition-invalid", "This service credential cannot be changed in its current state.", 409);
        let credential;
        if (action === "rotate") {
          credential = credentialFor(id);
          db.prepare("UPDATE service_access SET digest=?, revision=revision+1, rotated_at=? WHERE id=?").run(digest(credential), at.toISOString(), id);
        } else db.prepare("UPDATE service_access SET revoked_at=?, revision=revision+1 WHERE id=?").run(at.toISOString(), id);
        audit(id, "service." + action, actor, "succeeded", at.toISOString());
        return { service: publicService(find(id), at.getTime()), ...(credential ? { oneTimeCredential: credential } : {}) };
      }).immediate();
    },
    authenticate(value) { return publicService(validCredential(value), now().getTime()); },
    authorize(value, scope, action) {
      if (typeof action !== "string" || !/^[a-z][a-z0-9:.-]{0,99}$/.test(action)) fail("invalid-input", "Service action is invalid.");
      const outcome = db.transaction(() => {
        const row = validCredential(value); const at = now();
        const allowed = SCOPES.includes(scope) && JSON.parse(row.scopes).includes(scope);
        const window = Math.floor(at.getTime() / 60000);
        const count = row.rate_window === window ? row.rate_count : 0;
        if (count >= RATE_PER_MINUTE) return { denied: "rate" };
        db.prepare("UPDATE service_access SET last_used_at=?, rate_window=?, rate_count=? WHERE id=?").run(at.toISOString(), window, count + 1, row.id);
        audit(row.id, action, "service:" + row.id, allowed ? "authorized" : "denied", at.toISOString());
        return allowed ? { principal: publicService(find(row.id), at.getTime()) } : { denied: "scope" };
      }).immediate();
      if (outcome.denied === "rate") fail("service-rate-limited", "Service request limit reached. Retry in the next minute.", 429);
      if (outcome.denied) fail("service-forbidden", "This operation is not granted to this service identity.", 403);
      return outcome.principal;
    },
    close() { if (!closed) { closed = true; db.close(); } }
  });
}

function isServicePath(pathname) { return pathname === "/api/v1/service" || pathname.startsWith("/api/v1/service/"); }
function query(url, allowed) {
  const result = {};
  for (const [key, value] of url.searchParams) {
    if (!allowed.includes(key) || Object.hasOwn(result, key) || value.length > 128) fail("invalid-input", "Invalid service query.");
    if (["knownRevision", "offset", "limit"].includes(key)) {
      if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) fail("invalid-input", "Invalid query integer.");
      result[key] = Number(value);
    } else result[key] = value;
  }
  return result;
}
async function handleServiceManagement({ request, response, url, store, actor }) {
  actorId(actor);
  if (distinctHeader(request, "authorization") !== undefined) fail("human-required", "Service management requires a human session without service authorization.", 403);
  if (url.pathname === "/api/v1/service-access" && request.method === "GET") { sendJson(response, 200, store.list(query(url, ["offset", "limit"]))); return; }
  if (url.search) fail("invalid-input", "Service management mutations do not accept a query.");
  if (url.pathname === "/api/v1/service-access" && request.method === "POST") {
    sendJson(response, 201, store.issue((await readJsonBody(request, 16384)).value, actor)); return;
  }
  const match = /^\/api\/v1\/service-access\/(service-[a-f0-9-]+)\/(rotate|revoke)$/.exec(url.pathname);
  if (match && request.method === "POST") { sendJson(response, 200, store.change(match[1], match[2], (await readJsonBody(request, 16384)).value, actor)); return; }
  fail("not-found", "Service management endpoint was not found.", 404);
}
async function handleServiceRequest({ request, response, url, store, runtime, administrationRuntime, runAsService }) {
  if (distinctHeader(request, "cookie") !== undefined) fail("service-unauthorized", "Service endpoints do not accept browser cookies.", 401);
  const header = distinctHeader(request, "authorization");
  if (typeof header !== "string" || !header.startsWith("Bearer ") || header.length > 256) fail("service-unauthorized", "A service bearer credential is required.", 401);
  const credential = header.slice(7);
  store.authenticate(credential);
  let scope, action, execute;
  if (request.method === "GET" && url.pathname === "/api/v1/service/control/snapshot") {
    const input = query(url, ["reason", "knownRevision"]);
    const value = ConnectorContract.validateControlRequest({ schemaVersion: "1", reason: "refresh", ...input });
    scope = "connector:read"; action = "connector.snapshot"; execute = () => runtime.getSnapshot(value);
  } else if (request.method === "GET" && url.pathname === "/api/v1/service/administration/snapshot") {
    const input = query(url, ["domain", "reason", "knownRevision"]);
    const value = AdministrationContract.validateSnapshotRequest({ schemaVersion: "1", documentType: "administration-snapshot-request", reason: "refresh", ...input });
    scope = value.domain + ":read"; action = value.domain + ".snapshot"; execute = () => administrationRuntime.getSnapshot(value);
  } else if (request.method === "GET" && url.pathname === "/api/v1/service/administration/prompts") {
    const value = AdministrationContract.validatePromptRequest({ schemaVersion: "1", documentType: "agent-prompt-request", ...query(url, ["promptId"]) });
    scope = "prompts:read"; action = "prompt.read"; execute = () => administrationRuntime.getPrompt(value);
  } else if (request.method === "POST" && ["/api/v1/service/control/commands", "/api/v1/service/administration/commands"].includes(url.pathname)) {
    if (url.search) fail("invalid-input", "Service commands do not accept query parameters.");
    const body = (await readJsonBody(request, 65536)).value;
    const connector = url.pathname.includes("/control/");
    const value = (connector ? ConnectorContract : AdministrationContract).validateCommandRequest(body);
    const allowed = connector ? CONNECTOR_COMMANDS : ADMINISTRATION_COMMANDS;
    // An exact command allowlist is checked before idempotent result lookup. A
    // service cannot replay an operator's credential-issuing command to read it.
    scope = allowed.includes(value.command) ? (connector ? "connector:" : "administration:") + value.command : null;
    action = value.command; execute = () => (connector ? runtime : administrationRuntime).execute(value);
  } else fail("not-found", "Service endpoint was not found.", 404);
  const principal = store.authorize(credential, scope, action);
  if (typeof runAsService !== "function") throw new TypeError("Service actor context is required.");
  const result = await runAsService(principal.id, execute);
  sendJson(response, 200, result);
}

module.exports = { createServiceAccessStore, handleServiceManagement, handleServiceRequest, isServicePath,
  ServiceAccessError, SCOPES, DEFAULT_SCOPES, CONNECTOR_COMMANDS, ADMINISTRATION_COMMANDS, TOKEN };
