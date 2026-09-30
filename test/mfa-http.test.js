"use strict";

const assert = require("node:assert/strict"), crypto = require("node:crypto"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), test = require("node:test");
const Database = require("better-sqlite3");
const { startPrivateApplication } = require("../server/private-application");

function authenticatorCode(uri, offset = 0) {
  const alphabet = ["ABCDEFGH", "IJKLMNOP", "QRSTUVWX", "YZ234567"].join(""), encoded = new URL(uri).searchParams.get("secret");
  let bits = "";
  for (const letter of encoded) bits += alphabet.indexOf(letter).toString(2).padStart(5, "0");
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offset));
  const hmac = crypto.createHmac("sha1", Buffer.from(bytes)).update(counter).digest(), index = hmac[hmac.length - 1] & 15;
  return String((hmac.readUInt32BE(index) & 0x7fffffff) % 1000000).padStart(6, "0");
}

async function harness(t) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "bb-soc-mfa-http-"));
  let app;
  const start = port => startPrivateApplication({ stateDirectory: directory, port, monitoring: { autoStart: false, fetchImpl: async () => { throw new Error("No external requests in MFA tests."); } } });
  t.after(async () => { if (app) await app.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  app = await start(0);
  const password = crypto.randomBytes(24).toString("base64url"), email = "operator@example.invalid", jar = new Map();
  const operator = await app.authentication.createOperator({ name: "MFA test operator", email, password });
  return {
    directory, password, email, jar, operator,
    get app() { return app; },
    async restart(mutate) { const port = app.server.address().port; await app.close(); app = null; if (mutate) mutate(); app = await start(port); },
    async request(route, { body, method = body === undefined ? "GET" : "POST", cookies = jar, headers = {} } = {}) {
      const response = await fetch(app.url + route, { method, redirect: "manual", headers: { origin: app.url, connection: "close", ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookies.size ? { cookie: [...cookies].map(([key, value]) => key + "=" + value).join("; ") } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      for (const value of response.headers.getSetCookie()) {
        const pair = value.split(";", 1)[0], index = pair.indexOf("="), key = pair.slice(0, index), content = pair.slice(index + 1);
        if (content) cookies.set(key, content); else cookies.delete(key);
      }
      const text = await response.text();
      return { status: response.status, headers: response.headers, text, value: text && response.headers.get("content-type")?.includes("application/json") ? JSON.parse(text) : null };
    },
    api(route, body, cookies = jar, headers = {}) { return this.request("/api/auth/" + route, { body, cookies, headers }); },
    login(cookies = jar) { return this.api("sign-in/email", { email, password }, cookies); },
    async prepare() { assert.equal((await this.login()).status, 200); const response = await this.api("two-factor/enable", { password }); assert.equal(response.status, 200); return response.value; },
    async enroll() { const setup = await this.prepare(); const proof = await this.api("two-factor/verify-totp", { code: authenticatorCode(setup.totpURI) }); assert.equal(proof.status, 200); assert.deepEqual(proof.value, { status: true, reauthenticate: true }); return setup; }
  };
}

test("TOTP enrollment is optional, needs password and proof, revokes all prior sessions and encrypts secrets", async t => {
  const h = await harness(t);
  assert.equal((await h.api("two-factor/status")).status, 401);
  await h.login();
  const other = new Map(); await h.login(other);
  assert.deepEqual((await h.api("two-factor/status")).value, { schemaVersion: "1", enabled: false, method: "totp", trustedDevicesAllowed: false });
  assert.equal((await h.api("two-factor/enable", { password: crypto.randomBytes(24).toString("hex") })).status, 400);
  const setup = (await h.api("two-factor/enable", { password: h.password })).value;
  assert.equal(setup.method, "totp"); assert.equal(setup.backupCodes.length, 10); assert.equal(new Set(setup.backupCodes).size, 10);
  assert.equal((await h.api("two-factor/status")).value.enabled, false);
  assert.equal((await h.request("/api/v1/setup")).status, 200);
  const proof = await h.api("two-factor/verify-totp", { code: authenticatorCode(setup.totpURI) });
  assert.deepEqual(proof.value, { status: true, reauthenticate: true });
  assert.equal((await h.api("two-factor/status")).status, 401);
  assert.equal((await h.request("/api/v1/setup", { cookies: other })).status, 401);
  const database = new Database(path.join(h.directory, "auth.sqlite"), { readonly: true });
  try {
    const factor = database.prepare("SELECT * FROM twoFactor").get();
    assert.equal(factor.verified, 1); assert.equal(database.prepare('SELECT twoFactorEnabled FROM "user"').get().twoFactorEnabled, 1);
    assert.ok(!factor.secret.includes(new URL(setup.totpURI).searchParams.get("secret")));
    for (const code of setup.backupCodes) assert.ok(!factor.backupCodes.includes(code));
    assert.deepEqual(database.prepare("SELECT action FROM privateAccountAudit ORDER BY rowid").all().map(row => row.action), ["operator.create", "operator.two-factor-enable"]);
  } finally { database.close(); }
});

test("password alone gives only a five-minute challenge; TOTP creates a token-free authenticated session", async t => {
  const h = await harness(t), setup = await h.enroll();
  const login = await h.login();
  assert.deepEqual(login.value, { twoFactorRedirect: true, twoFactorMethods: ["totp"] });
  const challengeCookie = login.headers.getSetCookie().find(value => value.includes(".two_factor="));
  assert.match(challengeCookie, /Max-Age=300/); assert.match(challengeCookie, /HttpOnly/); assert.match(challengeCookie, /SameSite=Strict/i);
  assert.equal((await h.request("/api/v1/setup")).status, 401);
  const challenge = new Map(h.jar);
  assert.equal((await h.api("two-factor/verify-totp", { code: authenticatorCode(setup.totpURI, -5) })).status, 401);
  const proof = await h.api("two-factor/verify-totp", { code: authenticatorCode(setup.totpURI) });
  assert.equal(proof.status, 200); assert.equal(proof.value.user.id, h.operator.id); assert.equal(proof.value.token, undefined);
  assert.equal(proof.headers.get("cache-control"), "no-store"); assert.equal((await h.request("/api/v1/setup")).status, 200);
  assert.equal((await h.api("two-factor/status")).value.enabled, true);
  assert.equal((await h.api("two-factor/verify-totp", { code: authenticatorCode(setup.totpURI) }, challenge)).status, 401);
  assert.ok(!proof.headers.getSetCookie().some(value => value.includes("trust_device")));
});

test("backup codes sign in exactly once and cannot create trusted devices", async t => {
  const h = await harness(t), setup = await h.enroll();
  await h.login();
  assert.equal((await h.api("two-factor/verify-backup-code", { code: setup.backupCodes[0], trustDevice: true })).status, 400);
  assert.equal((await h.api("two-factor/verify-backup-code", { code: setup.backupCodes[0], disableSession: true })).status, 400);
  const proof = await h.api("two-factor/verify-backup-code", { code: setup.backupCodes[0] });
  assert.equal(proof.status, 200); assert.equal(proof.value.token, undefined); assert.equal(proof.value.session?.token, undefined);
  assert.equal((await h.request("/api/v1/setup")).status, 200);
  await h.api("sign-out", {}); await h.login();
  assert.equal((await h.api("two-factor/verify-backup-code", { code: setup.backupCodes[0] })).status, 401);
  assert.equal((await h.request("/api/v1/setup")).status, 401);
  assert.equal((await h.api("two-factor/verify-backup-code", { code: setup.backupCodes[1] })).status, 200);
});

test("disabling requires an authenticated password-confirmed session, deletes factors and signs out everyone", async t => {
  const h = await harness(t), setup = await h.enroll();
  assert.equal((await h.api("two-factor/disable", { password: h.password })).status, 401);
  await h.login(); await h.api("two-factor/verify-backup-code", { code: setup.backupCodes[0] });
  const other = new Map(); await h.login(other); await h.api("two-factor/verify-backup-code", { code: setup.backupCodes[1] }, other);
  assert.equal((await h.api("two-factor/disable", { password: crypto.randomBytes(24).toString("hex") })).status, 400);
  const disabled = await h.api("two-factor/disable", { password: h.password });
  assert.deepEqual(disabled.value, { status: true, reauthenticate: true });
  assert.equal((await h.request("/api/v1/setup")).status, 401); assert.equal((await h.request("/api/v1/setup", { cookies: other })).status, 401);
  const login = await h.login(); assert.equal(login.status, 200); assert.equal(login.value.twoFactorRedirect, undefined);
  assert.equal((await h.api("two-factor/status")).value.enabled, false);
  const database = new Database(path.join(h.directory, "auth.sqlite"), { readonly: true });
  try { assert.equal(database.prepare("SELECT COUNT(*) AS n FROM twoFactor").get().n, 0); } finally { database.close(); }
});

test("unfinished enrollment can be replaced without locking out an account", async t => {
  const h = await harness(t), first = await h.prepare();
  const second = await h.api("two-factor/enable", { password: h.password }); assert.equal(second.status, 200);
  assert.notEqual(second.value.totpURI, first.totpURI);
  await h.api("sign-out", {});
  assert.equal((await h.login()).value.twoFactorRedirect, undefined);
  assert.equal((await h.api("two-factor/status")).value.enabled, false);
});

test("factor routes enforce origin, method, bounded exact fields and deny unneeded plugin APIs", async t => {
  const h = await harness(t); await h.login();
  for (const endpoint of ["two-factor/send-otp", "two-factor/verify-otp", "two-factor/get-totp-uri", "two-factor/view-backup-codes", "two-factor/generate-backup-codes", "totp/generate"]) assert.equal((await h.api(endpoint, {})).status, 404);
  assert.equal((await h.api("two-factor/enable")).status, 405);
  assert.equal((await h.api("two-factor/status", {})).status, 405);
  assert.equal((await h.api("two-factor/enable", { password: h.password, method: "otp" })).status, 400);
  assert.equal((await h.api("two-factor/verify-totp", { code: "123456", trustDevice: false })).status, 400);
  assert.equal((await h.api("two-factor/verify-totp", { code: "1".repeat(16384) })).status, 413);
  assert.equal((await h.api("two-factor/enable", { password: h.password }, h.jar, { origin: "https://example.invalid" })).status, 403);
  assert.equal((await h.api("two-factor/status", undefined, h.jar, { authorization: "Bearer " + crypto.randomBytes(24).toString("hex") })).status, 401);
  assert.equal((await h.api("two-factor/status?anything=true")).status, 400);
});

test("factor attempt limits persist across restart and ignore supplied forwarded addresses", async t => {
  const h = await harness(t);
  for (let i = 0; i < 5; i += 1) assert.equal((await h.api("two-factor/verify-totp", { code: "123456" }, h.jar, { "x-forwarded-for": "192.0.2." + (i + 1), "x-bb-soc-client-ip": "192.0.2." + (i + 1) })).status, 401);
  assert.equal((await h.api("two-factor/verify-totp", { code: "123456" })).status, 429);
  await h.restart(); assert.equal((await h.api("two-factor/verify-totp", { code: "123456" })).status, 429);
});

test("MFA migrates an existing account database without reopening first-run or invalidating its current session", async t => {
  const h = await harness(t); await h.login();
  await h.restart(() => {
    const database = new Database(path.join(h.directory, "auth.sqlite"));
    try { database.exec('DROP TABLE twoFactor; ALTER TABLE "user" DROP COLUMN twoFactorEnabled'); } finally { database.close(); }
  });
  assert.equal((await h.request("/api/v1/first-run")).value.setupRequired, false);
  assert.equal((await h.request("/api/v1/setup")).status, 200);
  assert.equal((await h.api("two-factor/status")).value.enabled, false);
});

test("password resets preserve enabled MFA but invalidate pending password challenges", async t => {
  const h = await harness(t), setup = await h.enroll(); await h.login();
  await h.app.authentication.resetOperatorPassword({ email: h.email, password: h.password });
  assert.equal((await h.api("two-factor/verify-backup-code", { code: setup.backupCodes[0] })).status, 401);
  assert.equal((await h.login()).value.twoFactorRedirect, true);
  assert.equal((await h.api("two-factor/verify-backup-code", { code: setup.backupCodes[0] })).status, 200);
});

test("concurrent activation and password sign-in cannot retain a password-only session", async t => {
  const h = await harness(t), setup = await h.prepare(), other = new Map();
  await Promise.all([h.api("two-factor/verify-totp", { code: authenticatorCode(setup.totpURI) }), h.login(other)]);
  assert.equal((await h.request("/api/v1/setup", { cookies: other })).status, 401);
  assert.equal((await h.request("/api/v1/setup")).status, 401);
});

test("expired second-factor challenges cannot open a private session", async t => {
  const h = await harness(t), setup = await h.enroll(); await h.login();
  const database = new Database(path.join(h.directory, "auth.sqlite"));
  try { database.prepare("UPDATE verification SET expiresAt = ? WHERE identifier LIKE '2fa-%'").run(new Date(Date.now() - 60000).toISOString()); } finally { database.close(); }
  assert.equal((await h.api("two-factor/verify-backup-code", { code: setup.backupCodes[0] })).status, 401);
  assert.equal((await h.request("/api/v1/setup")).status, 401);
});

test("a fully verified MFA session survives restart and keeps its fixed lifetime", async t => {
  const h = await harness(t), setup = await h.enroll(); await h.login();
  assert.equal((await h.api("two-factor/verify-backup-code", { code: setup.backupCodes[0] })).status, 200);
  const before = (await h.api("get-session")).value;
  await h.restart();
  const after = (await h.api("get-session")).value;
  assert.equal(after.user.twoFactorEnabled, true); assert.equal(after.session.id, before.session.id);
  assert.equal(after.session.expiresAt, before.session.expiresAt); assert.equal(after.session.token, undefined);
  assert.equal((await h.request("/api/v1/setup")).status, 200);
});

test("even a valid legacy trusted-device cookie cannot bypass the wrapper's second-factor challenge", async t => {
  const h = await harness(t), setup = await h.enroll(); await h.login();
  // Simulate a cookie issued by an earlier plugin configuration, using the
  // installed library directly. The application's endpoint forbids this flag.
  const response = await h.app.authentication.auth.handler(new Request(h.app.url + "/api/auth/two-factor/verify-backup-code", {
    method: "POST", headers: { origin: h.app.url, "content-type": "application/json", cookie: [...h.jar].map(([key, value]) => key + "=" + value).join("; ") },
    body: JSON.stringify({ code: setup.backupCodes[0], trustDevice: true })
  }));
  assert.equal(response.status, 200);
  const trusted = response.headers.getSetCookie().find(value => value.includes(".trust_device=")); assert.ok(trusted);
  const pair = trusted.split(";", 1)[0], index = pair.indexOf("=");
  h.jar.clear(); h.jar.set(pair.slice(0, index), pair.slice(index + 1));
  assert.equal((await h.login()).value.twoFactorRedirect, true);
  assert.equal((await h.request("/api/v1/setup")).status, 401);
});

test("ten failed sign-in factors lock the account across fresh challenges and restart", async t => {
  const h = await harness(t), setup = await h.enroll();
  // Distinct trusted transport IPs isolate the per-account lockout from the
  // separately tested persisted per-IP route budget. No network is contacted.
  const direct = async (endpoint, body, jar, ip) => {
    const response = await h.app.authentication.handler(new Request(h.app.url + "/api/auth/" + endpoint, {
      method: "POST", headers: { origin: h.app.url, "content-type": "application/json", cookie: [...jar].map(([key, value]) => key + "=" + value).join("; ") }, body: JSON.stringify(body)
    }), { clientIP: ip });
    for (const value of response.headers.getSetCookie()) { const pair = value.split(";", 1)[0], at = pair.indexOf("="); if (pair.slice(at + 1)) jar.set(pair.slice(0, at), pair.slice(at + 1)); else jar.delete(pair.slice(0, at)); }
    return response;
  };
  for (let i = 0; i < 10; i += 1) {
    const jar = new Map(), ip = "192.0.2." + (i + 1);
    assert.equal((await direct("sign-in/email", { email: h.email, password: h.password }, jar, ip)).status, 200);
    assert.equal((await direct("two-factor/verify-backup-code", { code: "aaaaa-00000" }, jar, ip)).status, 401);
  }
  await h.restart(); await h.login();
  assert.equal((await h.api("two-factor/verify-backup-code", { code: setup.backupCodes[0] })).status, 429);
  assert.equal((await h.request("/api/v1/setup")).status, 401);
  const database = new Database(path.join(h.directory, "auth.sqlite"), { readonly: true });
  try { const row = database.prepare("SELECT failedVerificationCount, lockedUntil FROM twoFactor").get(); assert.equal(row.failedVerificationCount, 10); assert.ok(new Date(row.lockedUntil).getTime() > Date.now() + 14 * 60000); } finally { database.close(); }
});
