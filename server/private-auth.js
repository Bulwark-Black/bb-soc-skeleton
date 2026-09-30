"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const MAX_AUTH_BODY = 16 * 1024;
const PASSWORD_MIN = 15;
const PASSWORD_MAX = 128;
const SESSION_SECONDS = 8 * 60 * 60;
const AUTH_PATHS = new Map([
  ["/api/auth/sign-in/email", "POST"],
  ["/api/auth/sign-out", "POST"],
  ["/api/auth/get-session", "GET"],
  ["/api/auth/change-password", "POST"],
  ["/api/auth/two-factor/status", "GET"],
  ["/api/auth/two-factor/enable", "POST"],
  ["/api/auth/two-factor/disable", "POST"],
  ["/api/auth/two-factor/verify-totp", "POST"],
  ["/api/auth/two-factor/verify-backup-code", "POST"]
]);

function validatePrivateOrigin(value) {
  if (typeof value !== "string" || value.length > 2048) throw new TypeError("An explicit private application origin is required.");
  let url;
  try { url = new URL(value); } catch { throw new TypeError("Private application origin is invalid."); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new TypeError("Private application origin must not contain credentials, a path, query, or fragment.");
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  const tailnet = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.ts\.net$/.test(url.hostname);
  if (!(loopback && url.protocol === "http:") && !(tailnet && url.protocol === "https:")) {
    throw new TypeError("Use loopback HTTP for local access, or an explicit HTTPS *.ts.net origin for private Tailnet access.");
  }
  return url.origin;
}

function assertOwned(stat, label) {
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error(label + " must be owned by the current user.");
}

function statWithoutLinks(filename, label) {
  try {
    const stat = fs.lstatSync(filename);
    if (stat.isSymbolicLink()) throw new Error(label + " must not be a symbolic link.");
    return stat;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function preparePrivateDirectory(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 4096 || !path.isAbsolute(value)) throw new TypeError("An explicit absolute external state directory is required.");
  const directory = path.resolve(value);
  const project = fs.realpathSync(path.join(__dirname, ".."));
  const home = fs.realpathSync(os.homedir());
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const broadDirectories = new Set([home, temporaryRoot, ...["Desktop", "Documents", "Downloads", "Library", "Pictures", "Movies", "Music", "Public", "Applications"].map(name => path.join(home, name))]);
  if (directory === path.parse(directory).root || directory === project || directory.startsWith(project + path.sep) || project.startsWith(directory + path.sep) || broadDirectories.has(directory)) {
    throw new Error("Private authentication state must be a dedicated directory outside the repository, not a home, shared, ancestor, or filesystem root directory.");
  }
  let current = path.parse(directory).root;
  for (const segment of directory.slice(current.length).split(path.sep)) {
    current = path.join(current, segment);
    const stat = statWithoutLinks(current, "State directory ancestor");
    if (stat && !stat.isDirectory()) throw new Error("State directory ancestor is not a directory.");
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = statWithoutLinks(directory, "Private state directory");
  assertOwned(stat, "Private state directory");
  if (fs.realpathSync(directory) !== directory) throw new Error("Private state directory must use a canonical path without symbolic links.");
  const knownFiles = new Set(["auth-secret", "state.json", "audit.jsonl", "runtime.lock", "administration-state.json", "administration-audit.jsonl", "administration-runtime.lock"]);
  for (const name of fs.readdirSync(directory)) {
    const databaseFile = /^(auth|documents|telemetry|service-access|live-monitoring|setup-guides)\.sqlite(?:-wal|-shm|-journal)?$/.test(name);
    const interruptedWrite = /^\.(state|administration-state)\.json\.[1-9][0-9]*\.[a-f0-9-]{36}\.tmp$/.test(name);
    if (!knownFiles.has(name) && name !== "live-monitoring.key" && !databaseFile && !interruptedWrite) throw new Error("Private state requires an empty directory or an existing BB SOC state directory; unrelated contents were not changed.");
  }
  fs.chmodSync(directory, 0o700);
  return directory;
}

function secureFile(filename) {
  const stat = statWithoutLinks(filename, "Private authentication file");
  if (!stat) return null;
  if (!stat.isFile() || stat.nlink !== 1) throw new Error("Private authentication files must be regular files without hard links.");
  assertOwned(stat, "Private authentication file");
  fs.chmodSync(filename, 0o600);
  return stat;
}

function syncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function loadSecret(directory, databaseExisted) {
  const filename = path.join(directory, "auth-secret");
  if (!secureFile(filename)) {
    if (databaseExisted) throw new Error("Authentication database exists but its auth-secret is missing. Restore both files from the same backup.");
    let fd;
    try {
      fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      fs.writeFileSync(fd, crypto.randomBytes(32).toString("hex") + "\n", "utf8");
      fs.fsyncSync(fd);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    syncDirectory(directory);
  }
  const stat = secureFile(filename);
  if (stat.size !== 65) throw new Error("Authentication secret file is invalid; restore it from a trusted backup.");
  const secret = fs.readFileSync(filename, "utf8");
  if (!/^[a-f0-9]{64}\n$/.test(secret)) throw new Error("Authentication secret file is invalid; restore it from a trusted backup.");
  return secret.trim();
}

function validateEmail(value) {
  if (typeof value !== "string" || value.length > 254 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(value.trim())) {
    throw new TypeError("Supply a valid operator email address (maximum 254 characters).");
  }
  return value.trim().toLowerCase();
}

function validatePassword(password) {
  if (typeof password !== "string" || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX || /[\u0000-\u001f\u007f]/.test(password)) {
    throw new TypeError("Password must contain 15–128 characters, with no control characters.");
  }
  return password;
}

function validateName(name) {
  if (typeof name !== "string" || !name.trim() || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) throw new TypeError("Operator name must contain 1–100 characters, with no control characters.");
  return name.trim();
}

function authError(status, message) {
  return Response.json({ message }, { status, headers: { "cache-control": "no-store" } });
}

async function boundedJSON(request) {
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_AUTH_BODY)) throw new RangeError("Authentication request is too large.");
  if ((request.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase() !== "application/json") throw new TypeError("Authentication requests require JSON.");
  if (!request.body) return {};
  const reader = request.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_AUTH_BODY) {
        await reader.cancel();
        throw new RangeError("Authentication request is too large.");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new TypeError("Authentication request must be an object.");
  return body;
}

async function createPrivateAuth({ stateDir, baseURL }) {
  const origin = validatePrivateOrigin(baseURL);
  const directory = preparePrivateDirectory(stateDir);
  const databasePath = path.join(directory, "auth.sqlite");
  const existed = Boolean(secureFile(databasePath));
  for (const suffix of ["-wal", "-shm", "-journal"]) secureFile(databasePath + suffix);
  const secret = loadSecret(directory, existed);
  if (!existed) {
    let fd;
    try { fd = fs.openSync(databasePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
    secureFile(databasePath);
  }
  const [{ betterAuth }, { getMigrations }, { hashPassword }, { default: Database }, { twoFactor }] = await Promise.all([
    import("better-auth"), import("better-auth/db/migration"), import("better-auth/crypto"), import("better-sqlite3"), import("better-auth/plugins")
  ]);
  const database = new Database(databasePath);
  let closed = false;
  try {
    database.pragma("busy_timeout = 5000");
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = FULL");
    database.pragma("foreign_keys = ON");
    const options = {
      appName: "BB SOC",
      baseURL: origin,
      basePath: "/api/auth",
      secret,
      database,
      trustedOrigins: [origin],
      emailAndPassword: {
        enabled: true, disableSignUp: true, autoSignIn: false,
        minPasswordLength: PASSWORD_MIN, maxPasswordLength: PASSWORD_MAX,
        revokeSessionsOnPasswordReset: true
      },
      session: { expiresIn: SESSION_SECONDS, disableSessionRefresh: true, cookieCache: { enabled: false } },
      plugins: [twoFactor({ issuer: "BB SOC", skipVerificationOnEnable: false, twoFactorCookieMaxAge: 300,
        totpOptions: { digits: 6, period: 30 }, backupCodeOptions: { amount: 10, length: 10, storeBackupCodes: "encrypted" },
        accountLockout: { enabled: true, maxFailedAttempts: 10, durationSeconds: 900 } })],
      advanced: {
        useSecureCookies: origin.startsWith("https:"),
        cookiePrefix: "bb-soc",
        defaultCookieAttributes: { httpOnly: true, sameSite: "strict", path: "/" },
        ipAddress: { ipAddressHeaders: ["x-bb-soc-client-ip"] }
      },
      rateLimit: {
        enabled: true, window: 60, max: 100, storage: "database",
        customRules: { "/sign-in/email": { window: 60, max: 10 }, "/change-password": { window: 60, max: 5 },
          "/two-factor/enable": { window: 60, max: 5 }, "/two-factor/disable": { window: 60, max: 5 },
          "/two-factor/verify-totp": { window: 60, max: 5 }, "/two-factor/verify-backup-code": { window: 60, max: 5 } }
      },
      telemetry: { enabled: false },
      logger: { disabled: true }
    };
    const migrations = await getMigrations(options);
    await migrations.runMigrations();
    database.exec("CREATE TABLE IF NOT EXISTS privateAccountAudit (id TEXT PRIMARY KEY, action TEXT NOT NULL, userId TEXT NOT NULL, occurredAt INTEGER NOT NULL, localUid TEXT NOT NULL)");
    const readBootstrapState = () => {
      const rows = database.prepare("SELECT id, completed, completedAt FROM privateBootstrapState").all();
      if (rows.length !== 1 || rows[0].id !== 1 || ![0, 1].includes(rows[0].completed) ||
          (rows[0].completed === 0 ? rows[0].completedAt !== null : !Number.isSafeInteger(rows[0].completedAt) || rows[0].completedAt <= 0)) {
        throw new Error("Private account setup state is invalid. Restore authentication state from a trusted backup; setup was not reopened.");
      }
      return rows[0];
    };
    const hasProvisionedOperator = () => Boolean(
      database.prepare('SELECT 1 FROM "user" LIMIT 1').get() ||
      database.prepare("SELECT 1 FROM privateAccountAudit WHERE action = 'operator.create' LIMIT 1").get()
    );
    const completeBootstrap = () => {
      if (readBootstrapState().completed === 0) {
        database.prepare("UPDATE privateBootstrapState SET completed = 1, completedAt = ? WHERE id = 1").run(Date.now());
      }
    };
    database.transaction(() => {
      const bootstrapTable = database.prepare("SELECT type FROM sqlite_master WHERE name = 'privateBootstrapState'").get();
      if (!bootstrapTable) {
        database.exec("CREATE TABLE privateBootstrapState (id INTEGER PRIMARY KEY CHECK (id = 1), completed INTEGER NOT NULL CHECK (completed IN (0, 1)), completedAt INTEGER, CHECK ((completed = 0 AND completedAt IS NULL) OR (completed = 1 AND completedAt > 0)))");
        database.prepare("INSERT INTO privateBootstrapState (id, completed, completedAt) VALUES (1, 0, NULL)").run();
      } else if (bootstrapTable.type !== "table") {
        throw new Error("Private account setup state is invalid; setup was not reopened.");
      }
      // Migrate legacy installations, including accounts subsequently removed by an
      // operator. A zero user count must never become a fresh-install signal again.
      readBootstrapState();
      if (hasProvisionedOperator()) completeBootstrap();
    }).immediate();
    const auth = betterAuth(options);
    await auth.$context;
    for (const suffix of ["", "-wal", "-shm", "-journal"]) secureFile(databasePath + suffix);
    syncDirectory(directory);

    const audit = (action, userId) => database.prepare("INSERT INTO privateAccountAudit (id, action, userId, occurredAt, localUid) VALUES (?, ?, ?, ?, ?)")
      .run(crypto.randomUUID(), action, userId, Date.now(), typeof process.getuid === "function" ? String(process.getuid()) : "local-operator");
    const findOperator = email => {
      const operator = database.prepare('SELECT id, name, email FROM "user" WHERE email = ?').get(validateEmail(email));
      if (!operator) throw new Error("Operator account does not exist.");
      return operator;
    };
    const setupClosedError = () => Object.assign(new Error("Initial administrator setup is complete. Sign in with an existing account, or use the local account recovery command."), { status: 409 });
    const firstRunStatus = () => database.transaction(() => {
      const state = readBootstrapState();
      if (state.completed === 0 && hasProvisionedOperator()) completeBootstrap();
      return { setupRequired: readBootstrapState().completed === 0 };
    }).immediate();
    const createOperator = async ({ email, name, password }, firstOnly) => {
      if (firstOnly && !firstRunStatus().setupRequired) throw setupClosedError();
      const normalizedEmail = validateEmail(email);
      const normalizedName = validateName(name);
      const hashedPassword = await hashPassword(validatePassword(password));
      return database.transaction(() => {
        if (firstOnly && (readBootstrapState().completed !== 0 || hasProvisionedOperator())) throw setupClosedError();
        if (database.prepare('SELECT id FROM "user" WHERE email = ?').get(normalizedEmail)) throw new Error("Operator email already exists.");
        const id = crypto.randomUUID();
        const timestamp = new Date().toISOString();
        database.prepare('INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)')
          .run(id, normalizedName, normalizedEmail, 0, timestamp, timestamp);
        database.prepare('INSERT INTO account (id, userId, accountId, providerId, password, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(crypto.randomUUID(), id, id, "credential", hashedPassword, timestamp, timestamp);
        audit("operator.create", id);
        completeBootstrap();
        return { id, email: normalizedEmail, name: normalizedName };
      }).immediate();
    };
    // Credential sign-in and factor changes must observe one another in order:
    // an in-flight password-only sign-in cannot outlive factor activation.
    let authRequests = Promise.resolve(), pendingAuthRequests = 0;
    return {
      auth,
      origin,
      firstRunStatus,
      createFirstOperator(input) { return createOperator(input, true); },
      async handler(request, { clientIP = "127.0.0.1" } = {}) {
        if (pendingAuthRequests >= 32) return authError(429, "Authentication is busy. Retry shortly.");
        const perform = async () => {
        const url = new URL(request.url);
        if (url.origin !== origin) return authError(403, "Authentication origin is not allowed.");
        const method = AUTH_PATHS.get(url.pathname);
        if (!method) return authError(404, "Authentication endpoint is not available.");
        if (request.method !== method) return authError(405, "Authentication method is not allowed.");
        if (url.search) return authError(400, "Authentication query parameters are not allowed.");
        if (request.headers.has("authorization")) return authError(401, "Authentication endpoints do not accept machine credentials.");
        if (request.headers.has("origin") && request.headers.get("origin") !== origin) return authError(403, "Authentication origin is not allowed.");
        if (method === "POST" && request.headers.get("origin") !== origin) return authError(403, "Same-origin authentication requests are required.");
        const headers = new Headers(request.headers);
        headers.set("x-bb-soc-client-ip", net.isIP(clientIP) ? clientIP : "127.0.0.1");
        headers.delete("x-forwarded-for");
        headers.delete("x-forwarded-host");
        headers.delete("x-forwarded-proto");
        // This installation deliberately challenges every new password sign-in.
        // Even cookies created by an earlier configuration cannot bypass 2FA.
        if (headers.has("cookie")) headers.set("cookie", headers.get("cookie").split(";").filter(part => !/^(?:__Secure-)?bb-soc\.trust_device=/.test(part.trim())).join(";"));
        const factorPath = url.pathname.startsWith("/api/auth/two-factor/");
        const priorSession = factorPath || url.pathname === "/api/auth/change-password" ? await auth.api.getSession({ headers, query: { disableCookieCache: true } }) : null;
        if (url.pathname === "/api/auth/two-factor/status") {
          if (!priorSession) return authError(401, "Sign in to manage your account security.");
          return Response.json({ schemaVersion: "1", enabled: priorSession.user.twoFactorEnabled === true, method: "totp", trustedDevicesAllowed: false }, { headers: { "cache-control": "no-store" } });
        }
        let body;
        if (method === "POST") {
          try {
            body = await boundedJSON(request);
            if (url.pathname === "/api/auth/sign-in/email") {
              body = { email: validateEmail(body.email), password: validatePassword(body.password), rememberMe: true };
            } else if (url.pathname === "/api/auth/change-password") {
              body = { currentPassword: validatePassword(body.currentPassword), newPassword: validatePassword(body.newPassword), revokeOtherSessions: true };
            } else if (factorPath) {
              const passwordAction = ["/api/auth/two-factor/enable", "/api/auth/two-factor/disable"].includes(url.pathname);
              const expected = passwordAction ? "password" : "code";
              if (Object.keys(body).sort().join(",") !== expected) throw new TypeError("Supply only the required two-factor field; trusted-device bypass is not available.");
              if (passwordAction) body = { password: validatePassword(body.password), ...(url.pathname.endsWith("/enable") ? { method: "totp", issuer: "BB SOC" } : {}) };
              else {
                const pattern = url.pathname.endsWith("/verify-totp") ? /^\d{6}$/ : /^[A-Za-z0-9]{5}-[A-Za-z0-9]{5}$/;
                if (typeof body.code !== "string" || !pattern.test(body.code)) throw new TypeError("Supply a valid authenticator code or backup code.");
                body = { code: body.code, trustDevice: false };
              }
            } else body = {};
          } catch (error) {
            return authError(error instanceof RangeError ? 413 : 400, error instanceof SyntaxError ? "Authentication request must be valid JSON." : error.message);
          }
          headers.delete("content-length");
        }
        const response = await auth.handler(new Request(url, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) }));
        response.headers.set("cache-control", "no-store");
        if (response.ok && response.headers.get("content-type")?.includes("application/json")) {
          const result = await response.json();
          // Sessions belong in HttpOnly cookies, never in browser-readable JSON.
          if (result && typeof result === "object") {
            delete result.token;
            if (result.session) delete result.session.token;
          }
          if (priorSession && (url.pathname === "/api/auth/two-factor/disable" ||
              (url.pathname === "/api/auth/two-factor/verify-totp" && !priorSession.user.twoFactorEnabled))) {
            // Activating a factor must not leave password-only sessions alive.
            // Reauthentication also makes factor changes explicit in every tab.
            database.transaction(() => {
              database.prepare("DELETE FROM session WHERE userId = ?").run(priorSession.user.id);
              database.prepare("DELETE FROM verification WHERE value = ?").run(priorSession.user.id);
              audit(url.pathname.endsWith("/disable") ? "operator.two-factor-disable" : "operator.two-factor-enable", priorSession.user.id);
            }).immediate();
            return Response.json({ status: true, reauthenticate: true }, { status: response.status, headers: response.headers });
          }
          if (priorSession && url.pathname === "/api/auth/change-password") database.prepare("DELETE FROM verification WHERE value = ?").run(priorSession.user.id);
          return Response.json(result, { status: response.status, headers: response.headers });
        }
        return response;
        };
        pendingAuthRequests += 1;
        const response = authRequests.then(perform);
        authRequests = response.catch(() => {});
        try { return await response; } finally { pendingAuthRequests -= 1; }
      },
      getSession(headers) { return auth.api.getSession({ headers: new Headers(headers), query: { disableCookieCache: true } }); },
      countOperators() { return database.prepare('SELECT COUNT(*) AS count FROM "user"').get().count; },
      listOperatorNames() { return database.prepare('SELECT name FROM "user" ORDER BY createdAt, id LIMIT 200').all().map((row) => row.name); },
      createOperator(input) { return createOperator(input, false); },
      async resetOperatorPassword({ email, password }) {
        const normalizedEmail = validateEmail(email);
        const hashedPassword = await hashPassword(validatePassword(password));
        return database.transaction(() => {
          const operator = findOperator(normalizedEmail);
          const result = database.prepare("UPDATE account SET password = ?, updatedAt = ? WHERE userId = ? AND providerId = 'credential'").run(hashedPassword, new Date().toISOString(), operator.id);
          if (result.changes !== 1) throw new Error("Operator credential account is unavailable.");
          const revokedSessions = database.prepare("DELETE FROM session WHERE userId = ?").run(operator.id).changes;
          database.prepare("DELETE FROM verification WHERE value = ?").run(operator.id);
          audit("operator.password-reset", operator.id);
          return { id: operator.id, revokedSessions };
        }).immediate();
      },
      revokeOperatorSessions({ email }) {
        return database.transaction(() => {
          const operator = findOperator(email);
          const revokedSessions = database.prepare("DELETE FROM session WHERE userId = ?").run(operator.id).changes;
          database.prepare("DELETE FROM verification WHERE value = ?").run(operator.id);
          audit("operator.sessions-revoke", operator.id);
          return { id: operator.id, revokedSessions };
        }).immediate();
      },
      close() {
        if (closed) return;
        closed = true;
        database.close();
      }
    };
  } catch (error) {
    database.close();
    throw error;
  }
}

module.exports = { createPrivateAuth, validatePrivateOrigin, validatePassword, MAX_AUTH_BODY, PASSWORD_MIN, PASSWORD_MAX, SESSION_SECONDS };
