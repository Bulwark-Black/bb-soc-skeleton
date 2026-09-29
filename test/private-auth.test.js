"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const test = require("node:test");
const Database = require("better-sqlite3");
const { createPrivateAuth, validatePrivateOrigin, MAX_AUTH_BODY, SESSION_SECONDS } = require("../server/private-auth");
const { parseArguments, readPasswordLine } = require("../tools/private-account");

const ORIGIN = "http://127.0.0.1:8080";
const EMAIL = "operator@example.invalid";
const PASSWORD = crypto.randomBytes(24).toString("base64url");
const NEXT_PASSWORD = crypto.randomBytes(24).toString("base64url");
const TAILNET_ORIGIN = "https://" + ["console", "sample-tailnet", "ts", "net"].join(".");

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "bb-soc-auth-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function harness(t, origin = ORIGIN) {
  const directory = temporaryDirectory(t);
  let auth = await createPrivateAuth({ stateDir: directory, baseURL: origin });
  t.after(() => auth.close());
  return {
    directory,
    get auth() { return auth; },
    async restart() {
      auth.close();
      auth = await createPrivateAuth({ stateDir: directory, baseURL: origin });
    },
    request(endpoint, { method = "POST", body, cookie, headers = {}, clientIP } = {}) {
      return auth.handler(new Request(origin + "/api/auth/" + endpoint, {
        method,
        headers: { "content-type": "application/json", origin, ...(cookie ? { cookie } : {}), ...headers },
        ...(method === "POST" ? { body: JSON.stringify(body || {}) } : {})
      }), { clientIP });
    },
    create() { return auth.createOperator({ email: EMAIL, name: "Private operator", password: PASSWORD }); },
    login(password = PASSWORD, extra = {}) { return this.request("sign-in/email", { body: { email: EMAIL, password }, ...extra }); }
  };
}

function cookies(response) { return response.headers.getSetCookie().map(value => value.split(";")[0]).join("; "); }

test("private origins allow only exact local HTTP or Tailnet HTTPS origins", () => {
  for (const origin of [ORIGIN, "http://localhost:8080", "http://[::1]:8080", TAILNET_ORIGIN]) {
    assert.equal(validatePrivateOrigin(origin + "/"), origin);
  }
  for (const origin of ["https://console.example.invalid", "http://" + [0, 0, 0, 0].join(".") + ":8080", "http://" + [100, 64, 0, 1].join(".") + ":8080", TAILNET_ORIGIN.replace("https:", "http:"), "https://" + ["ts", "net"].join("."), TAILNET_ORIGIN + ".attacker.invalid", ORIGIN + "/path", ORIGIN + "/?x=1", ORIGIN.replace("://", "://user:pass@"), ORIGIN + "/#x", "bad URL"]) {
    assert.throws(() => validatePrivateOrigin(origin));
  }
});

test("closed sign-up, real sign-in, token-free JSON, persisted sessions, and sign-out", async t => {
  const h = await harness(t);
  assert.equal(h.auth.countOperators(), 0);
  const signup = await h.request("sign-up/email", { body: { email: EMAIL, name: "Uninvited", password: PASSWORD } });
  assert.equal(signup.status, 404);
  assert.equal(h.auth.countOperators(), 0);
  const user = await h.create();
  assert.equal(h.auth.countOperators(), 1);
  assert.equal((await h.login("not-the-right-test-password")).status, 401);
  const login = await h.login();
  assert.equal(login.status, 200);
  const loginBody = await login.json();
  assert.equal(loginBody.user.id, user.id);
  assert.equal(loginBody.token, undefined);
  assert.equal(login.headers.get("cache-control"), "no-store");
  const cookie = cookies(login);
  for (const value of login.headers.getSetCookie()) {
    assert.match(value, /HttpOnly/);
    assert.match(value, /SameSite=Strict/);
    assert.doesNotMatch(value, /; Secure/);
  }
  assert.match(login.headers.getSetCookie()[0], new RegExp("Max-Age=" + SESSION_SECONDS));
  const session = await h.auth.getSession(new Headers({ cookie }));
  assert.equal(session.user.id, user.id);
  assert.ok(new Date(session.session.expiresAt) - Date.now() <= SESSION_SECONDS * 1000);
  const publicSession = await h.request("get-session", { method: "GET", cookie });
  assert.equal((await publicSession.json()).session.token, undefined);
  await h.restart();
  assert.equal((await h.auth.getSession(new Headers({ cookie }))).user.id, user.id);
  const logout = await h.request("sign-out", { cookie });
  assert.equal(logout.status, 200);
  assert.equal(await h.auth.getSession(new Headers({ cookie })), null);
});

test("Tailnet sessions use secure cookies and reject cross-origin authentication", async t => {
  const h = await harness(t, TAILNET_ORIGIN);
  await h.create();
  const login = await h.login();
  assert.equal(login.status, 200);
  assert.match(login.headers.getSetCookie()[0], /; Secure/);
  assert.match(login.headers.getSetCookie()[0], /^__Secure-/);
  for (const origin of [TAILNET_ORIGIN.replace("console", "other"), "null", ""]) {
    assert.equal((await h.login(PASSWORD, { headers: { origin } })).status, 403);
  }
  assert.equal((await h.auth.handler(new Request(ORIGIN + "/api/auth/get-session"))).status, 403);
  assert.equal((await h.request("get-session", { method: "GET", headers: { origin: "https://untrusted.example.invalid" } })).status, 403);
});

test("password reset and session revocation are durable and never expose credentials", async t => {
  const h = await harness(t);
  await h.create();
  const firstCookie = cookies(await h.login());
  const secondCookie = cookies(await h.login());
  const reset = await h.auth.resetOperatorPassword({ email: EMAIL, password: NEXT_PASSWORD });
  assert.equal(reset.revokedSessions, 2);
  assert.equal(await h.auth.getSession(new Headers({ cookie: firstCookie })), null);
  assert.equal(await h.auth.getSession(new Headers({ cookie: secondCookie })), null);
  assert.equal((await h.login()).status, 401);
  const nextLogin = await h.login(NEXT_PASSWORD);
  assert.equal(nextLogin.status, 200);
  const nextCookie = cookies(nextLogin);
  await h.restart();
  assert.ok(await h.auth.getSession(new Headers({ cookie: nextCookie })));
  assert.equal(h.auth.revokeOperatorSessions({ email: EMAIL }).revokedSessions, 1);
  assert.equal(await h.auth.getSession(new Headers({ cookie: nextCookie })), null);
  const database = new Database(path.join(h.directory, "auth.sqlite"), { readonly: true });
  try {
    const record = database.prepare("SELECT password FROM account").get();
    assert.notEqual(record.password, PASSWORD);
    assert.notEqual(record.password, NEXT_PASSWORD);
    assert.match(record.password, /^[a-f0-9]+:[a-f0-9]+$/);
    assert.deepEqual(database.prepare("SELECT action FROM privateAccountAudit ORDER BY rowid").all().map(row => row.action), ["operator.create", "operator.password-reset", "operator.sessions-revoke"]);
  } finally { database.close(); }
});

test("password change requires current password and revokes other sessions", async t => {
  const h = await harness(t);
  await h.create();
  const cookie = cookies(await h.login());
  const otherCookie = cookies(await h.login());
  assert.equal((await h.request("change-password", { cookie, body: { currentPassword: NEXT_PASSWORD, newPassword: NEXT_PASSWORD } })).status, 400);
  const changed = await h.request("change-password", { cookie, body: { currentPassword: PASSWORD, newPassword: NEXT_PASSWORD, revokeOtherSessions: false } });
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).token, undefined);
  assert.equal(await h.auth.getSession(new Headers({ cookie: otherCookie })), null);
  assert.equal((await h.login()).status, 401);
  assert.equal((await h.login(NEXT_PASSWORD)).status, 200);
});

test("expired and tampered sessions fail without cookie-cache fallback", async t => {
  const h = await harness(t);
  await h.create();
  const cookie = cookies(await h.login());
  assert.equal(await h.auth.getSession(new Headers({ cookie: cookie.replace(/=./, "=x") })), null);
  const database = new Database(path.join(h.directory, "auth.sqlite"));
  try { database.prepare("UPDATE session SET expiresAt = ?").run(new Date(Date.now() - 1000).toISOString()); }
  finally { database.close(); }
  assert.equal(await h.auth.getSession(new Headers({ cookie })), null);
});

test("auth HTTP surface is narrow and request bodies are bounded", async t => {
  const h = await harness(t);
  for (const endpoint of ["sign-up/email", "admin/create-user", "request-password-reset", "reset-password", "update-user", "delete-user", "callback/github"]) {
    assert.equal((await h.request(endpoint)).status, 404);
  }
  assert.equal((await h.request("sign-in/email", { method: "GET" })).status, 405);
  assert.equal((await h.request("sign-in/email", { body: { email: EMAIL, password: "short" } })).status, 400);
  assert.equal((await h.request("sign-in/email", { body: { email: EMAIL, password: "x".repeat(129) } })).status, 400);
  assert.equal((await h.request("sign-in/email", { body: { email: EMAIL, password: "x".repeat(MAX_AUTH_BODY) } })).status, 413);
  assert.equal((await h.request("sign-out", { headers: { "content-type": "text/plain" } })).status, 400);
  const malformed = new Request(ORIGIN + "/api/auth/sign-in/email", { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{not-json" });
  assert.equal((await h.auth.handler(malformed)).status, 400);
  const streamed = new Request(ORIGIN + "/api/auth/sign-in/email", { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_AUTH_BODY + 1)); controller.close(); } }), duplex: "half" });
  assert.equal((await h.auth.handler(streamed)).status, 413);
});

test("login rate limits survive restart and ignore attacker-supplied forwarded headers", async t => {
  const h = await harness(t);
  for (let index = 0; index < 10; index += 1) {
    assert.equal((await h.login(PASSWORD, { headers: { "x-forwarded-for": "198.51.100." + index, "x-bb-soc-client-ip": "198.51.100." + index } })).status, 401);
  }
  await h.restart();
  const limited = await h.login();
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("x-retry-after")) > 0);
  assert.equal((await h.login(PASSWORD, { clientIP: "192.0.2.2" })).status, 401);
});

test("concurrent login attempts cannot bypass the persisted attempt limit", async t => {
  const h = await harness(t);
  const statuses = await Promise.all(Array.from({ length: 14 }, async () => (await h.login()).status));
  assert.equal(statuses.filter(status => status === 401).length, 10);
  assert.equal(statuses.filter(status => status === 429).length, 4);
});

test("operator input validation and duplicate create cannot mutate existing credentials", async t => {
  const h = await harness(t);
  await h.create();
  await assert.rejects(h.create(), /already exists/);
  await assert.rejects(h.auth.createOperator({ email: "not-email", name: "Valid", password: PASSWORD }), /email/);
  await assert.rejects(h.auth.createOperator({ email: "next@example.invalid", name: "\n", password: PASSWORD }), /name/);
  await assert.rejects(h.auth.createOperator({ email: "next@example.invalid", name: "Valid", password: "short" }), /Password/);
  await assert.rejects(h.auth.resetOperatorPassword({ email: "missing@example.invalid", password: NEXT_PASSWORD }), /does not exist/);
  assert.equal(h.auth.countOperators(), 1);
  assert.equal((await h.login()).status, 200);
});

test("auth files have restrictive modes and unsafe directories/files fail closed", async t => {
  const h = await harness(t);
  assert.equal(fs.statSync(h.directory).mode & 0o777, 0o700);
  for (const name of ["auth.sqlite", "auth-secret", "auth.sqlite-wal", "auth.sqlite-shm"]) {
    assert.equal(fs.statSync(path.join(h.directory, name)).mode & 0o777, 0o600);
  }
  await assert.rejects(createPrivateAuth({ stateDir: path.join(__dirname, "private-data"), baseURL: ORIGIN }), /outside the repository/);
  await assert.rejects(createPrivateAuth({ stateDir: "/", baseURL: ORIGIN }), /filesystem root/);
  const parent = temporaryDirectory(t);
  const link = path.join(parent, "linked-state");
  fs.symlinkSync(h.directory, link);
  await assert.rejects(createPrivateAuth({ stateDir: link, baseURL: ORIGIN }), /symbolic link/);
  const linkedFileDirectory = path.join(parent, "bad-file");
  fs.mkdirSync(linkedFileDirectory);
  fs.symlinkSync(path.join(h.directory, "auth-secret"), path.join(linkedFileDirectory, "auth-secret"));
  await assert.rejects(createPrivateAuth({ stateDir: linkedFileDirectory, baseURL: ORIGIN }), /symbolic link/);
  const linkedJournalDirectory = path.join(parent, "bad-journal");
  fs.mkdirSync(linkedJournalDirectory);
  fs.symlinkSync(path.join(h.directory, "auth-secret"), path.join(linkedJournalDirectory, "auth.sqlite-wal"));
  await assert.rejects(createPrivateAuth({ stateDir: linkedJournalDirectory, baseURL: ORIGIN }), /symbolic link/);
});

test("missing/corrupt durable secret cannot silently replace session signing identity", async t => {
  const directory = temporaryDirectory(t);
  const auth = await createPrivateAuth({ stateDir: directory, baseURL: ORIGIN });
  auth.close();
  const secret = path.join(directory, "auth-secret");
  fs.renameSync(secret, path.join(temporaryDirectory(t), "saved-secret"));
  await assert.rejects(createPrivateAuth({ stateDir: directory, baseURL: ORIGIN }), /secret is missing/);
  fs.writeFileSync(secret, "corrupt\n", { mode: 0o600 });
  await assert.rejects(createPrivateAuth({ stateDir: directory, baseURL: ORIGIN }), /secret file is invalid/);
});

test("private auth never changes permissions of broad or unrelated existing directories", async t => {
  for (const directory of [fs.realpathSync(os.homedir()), fs.realpathSync(os.tmpdir()), path.resolve(__dirname, "../..")]) {
    const before = fs.statSync(directory).mode;
    await assert.rejects(createPrivateAuth({ stateDir: directory, baseURL: ORIGIN }), /dedicated directory/);
    assert.equal(fs.statSync(directory).mode, before);
  }
  const directory = temporaryDirectory(t);
  fs.chmodSync(directory, 0o755);
  const marker = path.join(directory, "unrelated.txt");
  fs.writeFileSync(marker, "unrelated data\n");
  const before = fs.statSync(directory).mode;
  await assert.rejects(createPrivateAuth({ stateDir: directory, baseURL: ORIGIN }), /unrelated contents/);
  assert.equal(fs.statSync(directory).mode, before);
  assert.equal(fs.readFileSync(marker, "utf8"), "unrelated data\n");
  assert.deepEqual(fs.readdirSync(directory), ["unrelated.txt"]);
});

test("account CLI validates options and bounds stdin without accepting argument secrets", async () => {
  assert.equal(parseArguments(["--help"]).help, true);
  assert.throws(() => parseArguments(["create", "--password", PASSWORD]), /Unknown/);
  assert.throws(() => parseArguments(["create", "--email", EMAIL, "--email", EMAIL]), /Duplicate/);
  assert.throws(() => parseArguments(["revoke-sessions", "--state-dir", "/private/tmp/example", "--email", EMAIL, "--password-stdin"]), /does not accept/);
  assert.equal(await readPasswordLine(Readable.from([PASSWORD + "\n"])), PASSWORD);
  await assert.rejects(readPasswordLine(Readable.from([PASSWORD + "\nextra"])), /control characters/);
  await assert.rejects(readPasswordLine(Readable.from(["x".repeat(1025)])), /too large/);
});

test("account CLI provisions and resets an operator using stdin without echoing passwords", async t => {
  const directory = temporaryDirectory(t);
  async function cli(command, password, extra = []) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(__dirname, "../tools/private-account.js"), command, "--state-dir", directory, "--email", EMAIL, "--password-stdin", ...extra], { stdio: ["pipe", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", chunk => { output += chunk; });
      child.stderr.on("data", chunk => { output += chunk; });
      child.once("error", reject);
      child.once("close", code => resolve({ code, output }));
      child.stdin.end(password + "\n");
    });
  }
  const created = await cli("create", PASSWORD, ["--name", "CLI operator"]);
  assert.equal(created.code, 0, created.output);
  assert.match(created.output, /operator created/);
  assert.ok(!created.output.includes(PASSWORD));
  const reset = await cli("reset-password", NEXT_PASSWORD);
  assert.equal(reset.code, 0, reset.output);
  assert.ok(!reset.output.includes(NEXT_PASSWORD));
  const auth = await createPrivateAuth({ stateDir: directory, baseURL: ORIGIN });
  try {
    const login = await auth.handler(new Request(ORIGIN + "/api/auth/sign-in/email", { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: NEXT_PASSWORD }) }));
    assert.equal(login.status, 200);
  } finally { auth.close(); }
});
