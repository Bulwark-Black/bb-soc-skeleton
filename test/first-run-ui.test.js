"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../public/private-sign-in.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "../public/sign-in.html"), "utf8");
const setupState = (extra = {}) => ({ schemaVersion: "1", setupRequired: true, browserSetupAllowed: true, ...extra });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const settle = async () => { for (let index = 0; index < 8; index += 1) await new Promise(setImmediate); };
class Element {
  constructor() { this.value = ""; this.textContent = ""; this.listeners = new Map(); this.hidden = false; this.disabled = false; this.required = false; }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  click() { if (!this.disabled && !this.hidden) return this.listeners.get("click")?.(); }
  submit() { return this.listeners.get("submit")?.({ preventDefault() {} }); }
  focus() { this.focused = true; }
}
function harness(t, options = {}) {
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1], new Element()]));
  elements.get("private-sign-in-form").hidden = true; elements.get("sign-in-submit").disabled = true;
  const requests = [], navigations = [], events = new Map(), timers = new Map(); let timerId = 0;
  const context = vm.createContext({ URLSearchParams, TextDecoder, AbortController,
    document: { getElementById: id => { assert.ok(elements.has(id), "Known element " + id); return elements.get(id); } },
    location: { search: options.search || "", replace: target => navigations.push(target), reload: () => navigations.push("reload") },
    setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id),
    addEventListener: (event, callback) => events.set(event, callback),
    fetch: async (url, init) => { requests.push({ url, init, body: init.body ? JSON.parse(init.body) : null }); return options.fetch ? options.fetch(url, init) : json(setupState()); }
  }); context.window = context; vm.runInContext(source, context, { filename: "private-sign-in.js" });
  t.after(() => events.get("pagehide")?.());
  const field = id => elements.get(id), submit = () => field("private-sign-in-form").submit();
  return { field, requests, navigations, events, timers, submit,
    fill: (extra = {}) => { for (const [id, value] of Object.entries({ "operator-name": "Test administrator", "operator-email": "operator@example.invalid", "operator-password": ["synthetic", "private", "credential"].join("-"), "operator-confirm-password": ["synthetic", "private", "credential"].join("-"), ...extra })) field(id).value = value; }
  };
}
test("initial HTML is closed by default and provides accessible setup fields without changing branding", () => {
  assert.match(html, /id="private-sign-in-form"[^>]*hidden/);
  assert.match(html, /id="operator-name"[^>]*maxlength="100"/);
  assert.match(html, /id="operator-confirm-password"[^>]*autocomplete="new-password"/);
  assert.match(html, /id="sign-in-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /assets\/mark\.png/); assert.match(html, /assets\/favicon\.ico/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|innerHTML|document\.cookie/);
});
test("fresh local installation opens one-time creation only after bounded same-origin status read", async t => {
  const h = harness(t); assert.equal(h.field("private-sign-in-form").hidden, true); await settle();
  assert.equal(h.field("sign-in-title").textContent, "Create your administrator account");
  assert.equal(h.field("name-label").hidden, false); assert.equal(h.field("confirm-password-label").hidden, false);
  assert.equal(h.field("operator-password").autocomplete, "new-password"); assert.equal(h.field("operator-confirm-password").required, true);
  assert.equal(h.field("operator-name").value, ""); assert.equal(h.field("operator-email").value, "");
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].url, "/api/v1/first-run");
  assert.equal(h.requests[0].init.method, "GET"); assert.equal(h.requests[0].init.credentials, "same-origin");
  assert.equal(h.requests[0].init.cache, "no-store"); assert.equal(h.requests[0].init.redirect, "error"); assert.equal(h.timers.size, 0);
});
test("completed setup exposes sign-in, not creation, even if browser transport is unavailable", async t => {
  const h = harness(t, { fetch: async () => json(setupState({ setupRequired: false, browserSetupAllowed: false })) }); await settle();
  assert.equal(h.field("sign-in-title").textContent, "Sign in to your SOC"); assert.equal(h.field("name-label").hidden, true);
  assert.equal(h.field("operator-password").autocomplete, "current-password"); assert.equal(h.field("operator-confirm-password").required, false);
  assert.equal(h.field("first-run-local").hidden, true); assert.equal(h.field("first-run-retry").hidden, true);
});
test("nonlocal first-run context offers CLI instructions and cannot submit a hidden creation form", async t => {
  const h = harness(t, { fetch: async () => json(setupState({ browserSetupAllowed: false })) }); await settle();
  assert.equal(h.field("private-sign-in-form").hidden, true); assert.equal(h.field("first-run-local").hidden, false);
  assert.equal(h.field("first-run-retry").hidden, false); h.fill(); await h.submit(); assert.equal(h.requests.length, 1);
  assert.match(html, /npm run account -- create --state-dir/); assert.match(html, /prompts for the password privately/);
});
test("unverified, malformed, extra-field and oversized status responses fail closed without reflecting server text", async t => {
  const invalid = [() => json({ secret: "remote-marker" }, 503), () => json(null), () => json([]), () => json({ ...setupState(), secret: "remote-marker" }), () => json(setupState({ setupRequired: "true" })), () => json(setupState({ schemaVersion: "2" })), () => new Response(" ".repeat(4097)), () => new Response("{}", { headers: { "Content-Length": "4097" } }), () => new Response("remote-marker")];
  for (const fetch of invalid) {
    const h = harness(t, { fetch }); await settle(); assert.equal(h.field("private-sign-in-form").hidden, true);
    assert.equal(h.field("first-run-retry").hidden, false); assert.match(h.field("sign-in-status").textContent, /could not be verified/);
    assert.doesNotMatch(h.field("sign-in-status").textContent, /remote-marker/); h.fill(); await h.submit(); assert.equal(h.requests.length, 1);
  }
});
test("failed status read can be retried without creating any account", async t => {
  let reads = 0; const h = harness(t, { fetch: async () => ++reads === 1 ? json({}, 503) : json(setupState()) }); await settle();
  await h.field("first-run-retry").click(); assert.equal(h.requests.length, 2); assert.ok(h.requests.every(request => request.init.method === "GET"));
  assert.equal(h.field("sign-in-title").textContent, "Create your administrator account");
});
test("creation sends exact user-entered fields, clears secrets and offers sign-in without automatic session creation", async t => {
  const h = harness(t, { fetch: async (url, init) => init.method === "POST" ? json({ schemaVersion: "1", created: true }, 201) : json(setupState()) }); await settle();
  h.fill({ "operator-name": "  Test administrator  ", "operator-email": "  operator@example.invalid  " }); await h.submit();
  assert.equal(h.requests.length, 2); assert.equal(h.requests[1].url, "/api/v1/first-run");
  assert.deepEqual(h.requests[1].body, { name: "Test administrator", email: "operator@example.invalid", password: ["synthetic", "private", "credential"].join("-"), confirmPassword: ["synthetic", "private", "credential"].join("-") });
  assert.equal(h.requests[1].init.redirect, "error"); assert.equal(h.requests[1].init.cache, "no-store");
  assert.equal(h.field("operator-password").value, ""); assert.equal(h.field("operator-confirm-password").value, "");
  assert.equal(h.field("operator-name").value, ""); assert.equal(h.field("operator-email").value, "  operator@example.invalid  ");
  assert.equal(h.field("sign-in-title").textContent, "Sign in to your SOC"); assert.match(h.field("sign-in-status").textContent, /Administrator account created/);
  assert.equal(h.navigations.length, 0); assert.equal(h.field("sign-in-submit").disabled, false); assert.equal(h.field("operator-password").focused, true);
});
test("local validation rejects mismatching, short, long or control-containing secrets and invalid names", async t => {
  const h = harness(t); await settle();
  for (const fields of [{ "operator-name": "" }, { "operator-name": "x".repeat(101) }, { "operator-name": "bad\nname" }, { "operator-email": "" }, { "operator-email": "x".repeat(255) }, { "operator-password": "short", "operator-confirm-password": "short" }, { "operator-password": "x".repeat(129), "operator-confirm-password": "x".repeat(129) }, { "operator-confirm-password": "does-not-match-value" }, { "operator-password": "long-password\nsecret", "operator-confirm-password": "long-password\nsecret" }]) {
    h.fill(fields); await h.submit(); assert.equal(h.requests.length, 1); assert.match(h.field("sign-in-status").textContent, /matches the confirmation/);
  }
});
test("creation errors and ambiguous success receipts clear passwords and require a fresh setup check", async t => {
  for (const response of [() => json({ message: "remote-marker" }, 400), () => json({}, 403), () => json({}, 429), () => json({ schemaVersion: "1", created: true }), () => json({ schemaVersion: "1", created: true, password: ["remote", "marker"].join("-") }, 201), () => json(null, 201)]) {
    const h = harness(t, { fetch: async (url, init) => init.method === "POST" ? response() : json(setupState()) }); await settle(); h.fill(); await h.submit();
    assert.equal(h.field("operator-password").value, ""); assert.equal(h.field("operator-confirm-password").value, "");
    assert.equal(h.field("private-sign-in-form").hidden, true); assert.equal(h.field("first-run-retry").hidden, false);
    assert.doesNotMatch(h.field("sign-in-status").textContent, /remote-marker|Administrator account created/); assert.equal(h.navigations.length, 0);
  }
});
test("simultaneous setup conflict rechecks state and closes creation when another account won", async t => {
  let reads = 0; const h = harness(t, { fetch: async (url, init) => init.method === "POST" ? json({}, 409) : json(setupState({ setupRequired: ++reads === 1 })) }); await settle(); h.fill(); await h.submit();
  assert.equal(h.requests.length, 3); assert.equal(h.field("sign-in-title").textContent, "Sign in to your SOC"); assert.match(h.field("sign-in-status").textContent, /another window/);
});
test("double submits cannot create concurrent first-run requests", async t => {
  let finish; const h = harness(t, { fetch: (url, init) => init.method === "POST" ? new Promise(resolve => { finish = resolve; }) : json(setupState()) }); await settle(); h.fill();
  const pending = h.submit(); await h.submit(); assert.equal(h.requests.length, 2); finish(json({ schemaVersion: "1", created: true }, 201)); await pending;
});
test("existing sign-in uses the original auth endpoint and preserves only validated local return routes", async t => {
  for (const [requested, expected] of [["#/sources?stab=setup&appId=app-example", "/#/sources?stab=setup&appId=app-example"], ["https://example.invalid/path", "/#/"], ["#/x\n", "/#/"], ["#/" + "x".repeat(513), "/#/"]]) {
    const h = harness(t, { search: "?returnTo=" + encodeURIComponent(requested), fetch: async (url, init) => init.method === "POST" ? json({}) : json(setupState({ setupRequired: false })) }); await settle(); h.fill(); await h.submit();
    assert.equal(h.requests[1].url, "/api/auth/sign-in/email"); assert.deepEqual(Object.keys(h.requests[1].body).sort(), ["email", "password", "rememberMe"]);
    assert.equal(h.requests[1].body.rememberMe, false); assert.equal(h.navigations[0], expected); assert.equal(h.field("operator-password").value, "");
  }
});
test("password change still uses existing session and revokes other sessions without reopening setup", async t => {
  const h = harness(t, { search: "?mode=password&returnTo=%23%2Fagents", fetch: async () => json({}) }); await settle();
  assert.equal(h.requests.length, 0); assert.equal(h.field("sign-in-title").textContent, "Change your password");
  assert.equal(h.field("email-label").hidden, true); assert.equal(h.field("operator-email").required, false); assert.equal(h.field("operator-new-password").required, true);
  h.fill({ "operator-new-password": "synthetic-replacement-value" }); await h.submit(); assert.equal(h.requests[0].url, "/api/auth/change-password");
  assert.equal(h.requests[0].body.revokeOtherSessions, true); assert.equal(h.field("operator-new-password").value, ""); assert.equal(h.navigations[0], "/#/agents");
});
test("page disposal aborts pending status and creation requests and suppresses late success", async t => {
  let finishStatus; const h = harness(t, { fetch: () => new Promise(resolve => { finishStatus = resolve; }) });
  h.events.get("pagehide")(); assert.equal(h.requests[0].init.signal.aborted, true); const before = h.field("sign-in-status").textContent;
  finishStatus(json(setupState())); await settle(); assert.equal(h.field("sign-in-status").textContent, before); assert.equal(h.field("private-sign-in-form").hidden, true);
  let finishCreate; const second = harness(t, { fetch: (url, init) => init.method === "POST" ? new Promise(resolve => { finishCreate = resolve; }) : json(setupState()) }); await settle(); second.fill(); const pending = second.submit();
  second.events.get("pagehide")(); assert.equal(second.requests[1].init.signal.aborted, true); assert.equal(second.field("operator-password").value, "");
  finishCreate(json({ schemaVersion: "1", created: true }, 201)); await pending; assert.equal(second.navigations.length, 0); assert.doesNotMatch(second.field("sign-in-status").textContent, /Administrator account created/);
});
test("first-run timeout aborts the request rather than leaving an interactive creation form", async t => {
  const h = harness(t, { fetch: (url, init) => new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("Aborted")))) });
  assert.equal(h.timers.size, 1); [...h.timers.values()][0](); await settle(); assert.equal(h.requests[0].init.signal.aborted, true);
  assert.equal(h.field("private-sign-in-form").hidden, true); assert.equal(h.field("first-run-retry").hidden, false); assert.equal(h.timers.size, 0);
});
test("back-forward cache restoration reloads first-run state instead of reusing a disposed or stale setup form", async t => {
  const h = harness(t); await settle(); h.fill(); h.events.get("pagehide")(); h.events.get("pageshow")({ persisted: true });
  assert.deepEqual(h.navigations, ["reload"]); assert.equal(h.field("operator-password").value, ""); assert.equal(h.field("operator-confirm-password").value, "");
});

const factorStatus = (enabled = false) => ({ schemaVersion: "1", enabled, method: "totp", trustedDevicesAllowed: false });
const enrollment = () => ({ method: "totp", totpURI: "otpauth://totp/BB%20SOC:operator%40example.invalid?" + new URLSearchParams({ secret: "A".repeat(32), issuer: "BB SOC", digits: "6", period: "30" }), backupCodes: Array.from({ length: 10 }, (_, index) => "aaaaa-" + String(index).padStart(5, "0")) });

test("security settings read real per-account factor status without beginning enrollment", async t => {
  const h = harness(t, { search: "?mode=security", fetch: async () => json(factorStatus()) }); await settle();
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].url, "/api/auth/two-factor/status");
  assert.equal(h.requests[0].init.method, "GET"); assert.equal(h.requests[0].init.cache, "no-store");
  assert.equal(h.field("sign-in-title").textContent, "Account security"); assert.equal(h.field("account-security").hidden, false);
  assert.match(h.field("two-factor-state").textContent, /not enabled/); assert.equal(h.field("two-factor-enrollment").hidden, true);
  assert.match(h.field("sign-in-help").textContent, /Tailnet/); assert.match(h.field("sign-in-help").textContent, /Optional per account/);
});

test("security settings fail closed and expired sessions sign in before returning to security", async t => {
  const h = harness(t, { search: "?mode=security&returnTo=%23%2Fagents", fetch: async (url, init) => url.endsWith("/status") ? json({}, 401) : init.method === "POST" ? json({}) : json(setupState({ setupRequired: false })) }); await settle();
  assert.equal(h.field("account-security").hidden, true); assert.equal(h.field("sign-in-title").textContent, "Sign in to your SOC");
  h.fill(); await h.submit(); assert.equal(h.navigations[0], "/sign-in?mode=security&returnTo=%23%2Fagents");
  const invalid = harness(t, { search: "?mode=security", fetch: async () => json({ ...factorStatus(), trustedDevicesAllowed: true }) }); await settle();
  assert.equal(invalid.field("account-security").hidden, true); assert.equal(invalid.field("first-run-retry").hidden, false);
  assert.match(invalid.field("sign-in-status").textContent, /could not be verified/);
});

test("enrollment reveals bounded manual setup secrets, requires saved backup acknowledgement and proof, then signs in again", async t => {
  const setup = enrollment();
  const h = harness(t, { search: "?mode=security", fetch: async url => json(url.endsWith("/enable") ? setup : url.endsWith("/verify-totp") ? { status: true, reauthenticate: true } : factorStatus()) }); await settle();
  h.field("two-factor-password").value = "test-current-password-value"; await h.field("two-factor-password-form").submit();
  assert.equal(h.requests[1].url, "/api/auth/two-factor/enable"); assert.deepEqual(Object.keys(h.requests[1].body), ["password"]);
  assert.equal(h.field("two-factor-password").value, ""); assert.equal(h.field("two-factor-enrollment").hidden, false);
  assert.equal(h.field("two-factor-key").value, "A".repeat(32)); assert.equal(h.field("two-factor-uri").value, setup.totpURI);
  assert.equal(h.field("two-factor-backup-codes").value, setup.backupCodes.join("\n")); assert.equal(h.field("two-factor-use-backup").hidden, true);
  h.field("two-factor-code").value = "123456"; await h.field("two-factor-form").submit(); assert.equal(h.requests.length, 2);
  assert.match(h.field("sign-in-status").textContent, /Save your backup/);
  h.field("two-factor-saved").checked = true; await h.field("two-factor-form").submit();
  assert.deepEqual(h.requests[2].body, { code: "123456" }); assert.equal(h.requests[2].url, "/api/auth/two-factor/verify-totp");
  assert.equal(h.field("sign-in-title").textContent, "Sign in to your SOC"); assert.match(h.field("sign-in-status").textContent, /authentication is enabled/);
  for (const id of ["two-factor-password", "two-factor-key", "two-factor-uri", "two-factor-backup-codes", "two-factor-code"]) assert.equal(h.field(id).value, "");
  assert.equal(h.navigations.length, 0);
});

test("an authenticator challenge must complete before sign-in navigation and can use a one-time backup code", async t => {
  const h = harness(t, { search: "?returnTo=%23%2Fsources", fetch: async (url, init) => init.method === "GET" ? json(setupState({ setupRequired: false })) : url.endsWith("/sign-in/email") ? json({ twoFactorRedirect: true, twoFactorMethods: ["totp"] }) : json({ user: { id: "operator-test" } }) }); await settle();
  h.fill(); await h.submit();
  assert.equal(h.navigations.length, 0); assert.equal(h.field("sign-in-title").textContent, "Verify your second factor");
  assert.equal(h.field("operator-password").value, ""); assert.equal(h.field("two-factor-form").hidden, false);
  h.field("two-factor-code").value = "bad"; await h.field("two-factor-form").submit(); assert.equal(h.requests.length, 2);
  await h.field("two-factor-use-backup").click(); assert.equal(h.field("two-factor-code").value, ""); assert.equal(h.field("two-factor-code").inputMode, "text");
  h.field("two-factor-code").value = "aaaaa-00000"; await h.field("two-factor-form").submit();
  assert.equal(h.requests[2].url, "/api/auth/two-factor/verify-backup-code"); assert.deepEqual(h.requests[2].body, { code: "aaaaa-00000" });
  assert.equal(h.field("two-factor-code").value, ""); assert.equal(h.navigations[0], "/#/sources");
});

test("factor verification failures never navigate or reflect server data and allow a fresh password challenge", async t => {
  const h = harness(t, { fetch: async (url, init) => init.method === "GET" ? json(setupState({ setupRequired: false })) : url.endsWith("/sign-in/email") ? json({ twoFactorRedirect: true }) : json({ marker: "remote-factor-marker" }, 429) }); await settle(); h.fill(); await h.submit();
  h.field("two-factor-code").value = "123456"; await h.field("two-factor-form").submit();
  assert.equal(h.navigations.length, 0); assert.equal(h.field("two-factor-code").value, "");
  assert.match(h.field("sign-in-status").textContent, /Too many attempts/); assert.doesNotMatch(h.field("sign-in-status").textContent, /remote-factor-marker/);
  await h.field("two-factor-cancel").click(); assert.equal(h.field("sign-in-title").textContent, "Sign in to your SOC");
});

test("factor setup rejects malformed enrollment secrets before displaying them", async t => {
  for (const value of [{ ...enrollment(), method: "otp" }, { ...enrollment(), totpURI: "https://example.invalid" }, { ...enrollment(), backupCodes: ["12345-12345"] }, { ...enrollment(), totpURI: "otpauth://totp/bad?secret=invalid" }]) {
    const h = harness(t, { search: "?mode=security", fetch: async url => json(url.endsWith("/enable") ? value : factorStatus()) }); await settle();
    h.field("two-factor-password").value = "test-current-password-value"; await h.field("two-factor-password-form").submit();
    assert.equal(h.field("two-factor-enrollment").hidden, true); assert.equal(h.field("two-factor-key").value, ""); assert.equal(h.field("two-factor-backup-codes").value, "");
    assert.equal(h.field("two-factor-password").value, ""); assert.match(h.field("sign-in-status").textContent, /could not be confirmed/);
  }
});

test("disabling requires a password submission and verified reauthentication receipt", async t => {
  const h = harness(t, { search: "?mode=security", fetch: async url => json(url.endsWith("/disable") ? { status: true, reauthenticate: true } : factorStatus(true)) }); await settle();
  assert.equal(h.field("two-factor-change").textContent, "Disable two-factor authentication");
  await h.field("two-factor-password-form").submit(); assert.equal(h.requests.length, 1);
  h.field("two-factor-password").value = "test-current-password-value"; await h.field("two-factor-password-form").submit();
  assert.equal(h.requests[1].url, "/api/auth/two-factor/disable"); assert.equal(h.field("two-factor-password").value, "");
  assert.equal(h.field("sign-in-title").textContent, "Sign in to your SOC"); assert.match(h.field("sign-in-status").textContent, /authentication is disabled/);
});

test("page disposal clears enrollment material and aborts factor requests without late updates", async t => {
  let finish;
  const h = harness(t, { search: "?mode=security", fetch: url => url.endsWith("/verify-totp") ? new Promise(resolve => { finish = resolve; }) : json(url.endsWith("/enable") ? enrollment() : factorStatus()) }); await settle();
  h.field("two-factor-password").value = "test-current-password-value"; await h.field("two-factor-password-form").submit();
  h.field("two-factor-saved").checked = true; h.field("two-factor-code").value = "123456"; const pending = h.field("two-factor-form").submit();
  h.events.get("pagehide")(); assert.equal(h.requests[2].init.signal.aborted, true);
  for (const id of ["two-factor-key", "two-factor-uri", "two-factor-backup-codes", "two-factor-code"]) assert.equal(h.field(id).value, "");
  finish(json({ status: true, reauthenticate: true })); await pending;
  assert.equal(h.navigations.length, 0); assert.doesNotMatch(h.field("sign-in-status").textContent, /authentication is enabled/);
});
