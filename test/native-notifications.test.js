"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { MonitorStore } = require("../server/native-monitor/store");
const { createHostRegistry } = require("../server/native-monitor/registry");
const { createNotifications, notificationConfiguration, credential, RETRY_WINDOW } = require("../server/native-monitor/notifications");
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "native-notification-test-"));
  const tokenFile = path.join(directory, "provider-token");
  fs.writeFileSync(tokenFile, options.config?.provider === "smtp" ? JSON.stringify({ user: "synthetic@example.invalid", password: crypto.randomBytes(24).toString("base64url") }) : crypto.randomBytes(24).toString("base64url"), { mode: 0o600 });
  const config = { enabled: true, reviewed: true, from: "monitor@example.invalid", destinations: ["one@example.invalid", "two@example.invalid"], credentialFile: tokenFile, ...options.config };
  const registry = createHostRegistry({ hosts: [{ id: "host-a", appId: "app-example", sourceId: "source-a", label: "Synthetic host" },
    { id: "host-b", appId: "app-example", sourceId: "source-b", label: "Other host" }] });
  let at = Date.UTC(2026, 9, 18, 12), store, worker, serial = 0;
  const calls = [];
  let provider = options.send || (async () => ({ status: 200, id: "provider-" + (++serial) }));
  const open = () => {
    worker = null;
    store = new MonitorStore({ data: path.join(directory, "state"), registry, now: () => at, minFreeBytes: 0, notificationsEnabled: () => worker?.enabled() === true });
    worker = createNotifications(store, { appId: "app-example", configuration: config, consoleOrigin: "https://console.example.invalid", send: async request => { calls.push(request); return provider(request); }, smtpSend: async request => { calls.push(request); return options.smtpSend(request); } });
  };
  open();
  const f = { config, directory, tokenFile, calls, get store() { return store; }, get worker() { return worker; }, get now() { return at; },
    advance(ms = 60000) { at += ms; }, provider(fn) { provider = fn; },
    async restart() { await worker.close(); store.close(); open(); },
    observe(status, host = "host-a") {
      const definition = { id: "operations.notification." + host, host, label: "Synthetic operation", type: "operation", intervalSeconds: 60 };
      store.reconcileOperationalConditions([{ checkId: definition.id, host, observedAt: at, status, summary: "Synthetic condition " + status }], [definition]);
      return store.incidents([host]).incidents[0];
    },
    decision(attempt, action, extra = {}) { return { actor: "operator-example", idempotencyKey: "decision-" + (++serial), expectedRevision: attempt.revision, attemptId: attempt.id, action, reason: "Reviewed synthetic provider evidence", ...extra }; },
    pause(paused) { return worker.pause({ actor: "operator-example", idempotencyKey: "pause-" + (++serial), expectedRevision: worker.status().transport.revision, reason: "Synthetic pause decision", paused }); }
  };
  t.after(async () => { await worker.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return f;
}

test("notifications require reviewed external configuration and never disclose provider secrets", async t => {
  assert.equal(notificationConfiguration().enabled, false);
  assert.throws(() => notificationConfiguration({ enabled: true }), /reviewed/);
  assert.throws(() => notificationConfiguration({ enabled: false, url: "https://example.invalid" }), /Invalid/);
  assert.throws(() => notificationConfiguration({ enabled: false, from: "bad\r\nsender@example.invalid" }), /sender/);
  const f = fixture(t, { config: { enabled: false } });
  f.observe("critical"); await f.worker.tick(); assert.equal(f.calls.length, 0);
  fs.chmodSync(f.tokenFile, 0o644); assert.throws(() => credential(f.tokenFile), /file requirements/);
  fs.chmodSync(f.tokenFile, 0o600);
  const symlink = path.join(f.directory, "symlink"); fs.symlinkSync(f.tokenFile, symlink);
  assert.throws(() => credential(symlink), /file requirements/);
  const fifo = path.join(f.directory, "fifo");
  require("node:child_process").execFileSync("mkfifo", [fifo]);
  assert.throws(() => credential(fifo), /file requirements/);
  const text = JSON.stringify(f.worker.status());
  assert.equal(text.includes(fs.readFileSync(f.tokenFile, "utf8")), false);
  assert.equal(text.includes(f.tokenFile), false);
});

test("lost provider response replays exact body and key after restart; pause retains recovery and recipient evidence", async t => {
  const accepted = new Map();
  const f = fixture(t, { config: { destinations: ["one@example.invalid"] }, send: async request => {
    if (!accepted.has(request.key)) { accepted.set(request.key, "provider-once"); return { status: null }; }
    return { status: 200, id: accepted.get(request.key) };
  } });
  const incident = f.observe("critical");
  await f.worker.tick();
  assert.equal(f.calls.length, 1);
  let attempt = f.worker.status().attempts[0];
  assert.equal(attempt.state, "retryable"); assert.equal(attempt.requestCount, 1);
  f.pause(true); f.advance();
  await f.restart(); await f.worker.tick(); assert.equal(f.calls.length, 1);
  f.observe("healthy");
  f.pause(false);
  await f.worker.tick();
  assert.equal(f.calls.length, 3, "one retry and the recovery first attempt");
  assert.equal(f.calls[0].key, f.calls[1].key); assert.equal(f.calls[0].body, f.calls[1].body);
  assert.equal(accepted.size, 2, "one provider identity per opening/recovery");
  const ledger = f.worker.status(undefined, { incidentId: incident.id });
  assert.deepEqual(ledger.deliveries.map(d => d.role).sort(), ["opening", "recovery"]);
  assert.equal(ledger.deliveries.find(d => d.role === "opening").providerId, "provider-once");
  assert.equal(JSON.parse(f.calls[0].body).text.includes("appId=app-example"), true);
  assert.equal(ledger.attempts.some(a => Object.hasOwn(a, "body") || Object.hasOwn(a, "credential_fingerprint")), false);
});

test("partial recipient failure retains independent receipts; only attempted openings receive recovery", async t => {
  const f = fixture(t, { config: { hourlySendCap: 1 } });
  f.observe("critical"); await f.worker.tick(); assert.equal(f.calls.length, 1);
  f.advance(); f.observe("healthy"); await f.worker.tick();
  let deliveries = f.worker.status().deliveries;
  assert.equal(deliveries.filter(d => d.role === "opening" && d.state === "cancelled").length, 1);
  assert.equal(deliveries.filter(d => d.role === "recovery").length, 1);
  assert.equal(f.calls.length, 1, "cap includes recoveries, retries, and every severity");
  f.advance(3600000); await f.worker.tick();
  assert.equal(f.calls.length, 2);
  deliveries = f.worker.status().deliveries;
  assert.equal(deliveries.find(d => d.role === "recovery").destination, JSON.parse(f.calls[0].body).to[0]);
});

test("expired uncertainty requires scoped audited reconciliation; exact replay and fresh attempts retain history", async t => {
  const f = fixture(t, { config: { destinations: ["one@example.invalid"] }, send: async () => ({ status: null }) });
  f.observe("critical"); await f.worker.tick();
  f.advance(RETRY_WINDOW); await f.worker.tick();
  let attempt = f.worker.status().attempts[0];
  assert.equal(attempt.state, "needs-reconciliation");
  assert.equal(f.calls.length, 1);
  assert.throws(() => f.worker.reconcile(f.decision(attempt, "retry-exact"), ["host-b"]), e => e.status === 403);
  assert.throws(() => f.worker.reconcile(f.decision(attempt, "retry-exact")), e => e.status === 409);
  assert.throws(() => f.worker.reconcile(f.decision(attempt, "requeue-fresh")), e => e.status === 400);
  const body = f.decision(attempt, "requeue-fresh", { duplicateRiskAccepted: true });
  const result = f.worker.reconcile(body);
  assert.deepEqual(f.worker.reconcile(body), result);
  assert.throws(() => f.worker.reconcile({ ...body, reason: "different" }), e => e.status === 409);
  assert.equal(f.worker.status().attempts.length, 2);
  assert.equal(f.worker.status().attempts.find(a => a.id === attempt.id).state, "superseded");
  await f.worker.tick(); assert.equal(f.calls.length, 2);
  assert.notEqual(f.calls[0].key, f.calls[1].key);
  assert.equal(f.calls[0].body, f.calls[1].body);
  f.advance(RETRY_WINDOW); await f.worker.tick();
  attempt = f.worker.status().attempts.find(a => a.active);
  const confirm = f.decision(attempt, "confirm-accepted", { providerId: "verified-provider-identity", acceptedAt: new Date(attempt.firstRequestAt).toISOString() });
  f.worker.reconcile(confirm);
  assert.equal(f.worker.status().attempts.find(a => a.active).providerId, "verified-provider-identity");
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM notification_operator_decisions").get().n, 2);
});

test("malformed success and configuration rotation park; exact retry is explicit and revision protected", async t => {
  const f = fixture(t, { config: { destinations: ["one@example.invalid"] }, send: async () => ({ status: 200 }) });
  f.observe("critical"); await f.worker.tick();
  let attempt = f.worker.status().attempts[0];
  assert.equal(attempt.state, "needs-reconciliation");
  assert.equal(attempt.errorCode, "provider-acceptance-unproven");
  const decision = f.decision(attempt, "retry-exact");
  assert.throws(() => f.worker.reconcile({ ...decision, expectedRevision: attempt.revision - 1 }), e => e.status === 409);
  f.worker.reconcile(decision);
  fs.writeFileSync(f.tokenFile, crypto.randomBytes(24).toString("base64url"), { mode: 0o600 });
  await f.worker.tick();
  attempt = f.worker.status().attempts[0];
  assert.equal(attempt.errorCode, "configuration-changed"); assert.equal(f.calls.length, 1);
  assert.throws(() => f.worker.reconcile(f.decision(attempt, "retry-exact")), e => e.status === 409);
});

test("provider boundary is committed before I/O, leases exclude concurrent workers, and capacity closes sending", async t => {
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const f = fixture(t, { config: { destinations: ["one@example.invalid"] }, send: async () => {
    const row = f.store.db.prepare("SELECT * FROM notification_provider_attempts").get();
    assert.equal(row.state, "in-flight"); assert.equal(row.request_count, 1); assert.equal(row.first_request_at, f.now);
    entered(); return new Promise(resolve => { release = () => resolve({ status: 200, id: "provider-one" }); });
  } });
  f.observe("critical");
  const pending = f.worker.tick(); await ready;
  let second;
  const other = new MonitorStore({ data: path.join(f.directory, "state"), registry: f.store.registry, now: () => f.now, minFreeBytes: 0, notificationsEnabled: () => second?.enabled() === true });
  second = createNotifications(other, { appId: "app-example", configuration: f.config, consoleOrigin: "https://console.example.invalid", send: async () => { assert.fail("concurrent send"); } });
  await second.tick(); await second.close(); other.close();
  f.pause(true); release(); await pending;
  assert.equal(f.worker.status().attempts[0].state, "accepted", "a request already in flight can complete after pause");
  f.pause(false); f.advance(); f.observe("healthy");
  const original = f.store.capacity; f.store.capacity = () => { throw new Error("Synthetic capacity limit"); };
  await f.worker.tick(); assert.equal(f.calls.length, 1); assert.match(f.worker.status().transport.error, /retained attempts/);
  f.store.capacity = original;
});

test("paused backlog coalesces state notices without deleting evidence", async t => {
  const f = fixture(t, { config: { destinations: ["one@example.invalid"] } });
  f.pause(true);
  f.observe("critical"); f.advance(1000000); f.observe("critical");
  f.advance(4000000); f.observe("critical");
  assert.ok(f.store.events(null, true).events.length >= 3);
  f.pause(false); await f.worker.tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.worker.status().deliveries[0].role, "opening");
  assert.ok(f.store.events(null, true).events.filter(row => row.outcome === "notification-coalesced").length >= 2);
});

test("expired in-flight lease recovers exact request and a late worker cannot overwrite acceptance", async t => {
  let release, enter;
  const started = new Promise(resolve => { enter = resolve; });
  const f = fixture(t, { config: { destinations: ["one@example.invalid"] }, send: async () => {
    enter(); return new Promise(resolve => { release = () => resolve({ status: 500 }); });
  } });
  f.observe("critical");
  const pending = f.worker.tick(); await started; f.advance(61000);
  let replacement, retried;
  const store = new MonitorStore({ data: path.join(f.directory, "state"), registry: f.store.registry, minFreeBytes: 0,
    now: () => f.now, notificationsEnabled: () => replacement?.enabled() === true });
  replacement = createNotifications(store, { appId: "app-example", configuration: f.config, consoleOrigin: "https://console.example.invalid",
    send: async request => { retried = request; return { status: 200, id: "provider-recovered" }; } });
  await replacement.tick(); release(); await pending;
  assert.equal(retried.key, f.calls[0].key); assert.equal(retried.body, f.calls[0].body);
  assert.equal(f.worker.status().attempts[0].state, "accepted");
  const requests = f.worker.status().attempts[0].requests;
  assert.equal(requests[0].outcome, "accepted"); assert.equal(requests[1].finishedAt, null);
  await replacement.close(); store.close();
});

test("Resend transport fixes endpoint, rejects redirects, bounds body and hides raw failures", async t => {
  const { sendResend } = require("../server/native-monitor/notifications");
  let observed;
  t.mock.method(global, "fetch", async (url, init) => { observed = { url, init }; return new Response(JSON.stringify({ id: "provider-example" }), { status: 200 }); });
  const value = await sendResend({ token: crypto.randomBytes(24).toString("base64url"), body: "{}", key: "synthetic-key" });
  assert.equal(value.id, "provider-example"); assert.equal(observed.url, "https://api.resend.com/emails");
  assert.equal(observed.init.redirect, "error"); assert.equal(observed.init.method, "POST");
  assert.equal(observed.init.headers["Idempotency-Key"], "synthetic-key");
  global.fetch = async () => new Response("x".repeat(65537), { status: 200 });
  assert.deepEqual(await sendResend({ token: "synthetic", body: "{}", key: "key" }), { status: 200, invalid: true });
  global.fetch = async () => { throw new Error("Sensitive synthetic provider response"); };
  assert.deepEqual(await sendResend({ token: "synthetic", body: "{}", key: "key" }), { status: null, networkError: true });
});

test("a removed unattempted recipient cannot hold other recipients' recovery indefinitely", async t => {
  const f = fixture(t, { config: { hourlySendCap: 1 } });
  f.observe("critical"); await f.worker.tick();
  const acceptedDestination = JSON.parse(f.calls[0].body).to[0];
  f.config.destinations = [acceptedDestination];
  await f.restart(); await f.worker.tick();
  assert.equal(f.worker.status().attempts.filter(a => a.state === "needs-reconciliation").length, 1);
  f.advance(); f.observe("healthy"); await f.worker.tick();
  const deliveries = f.worker.status().deliveries;
  assert.equal(deliveries.filter(d => d.role === "opening" && d.state === "cancelled").length, 1);
  assert.equal(deliveries.filter(d => d.role === "recovery").length, 1);
  assert.equal(deliveries.find(d => d.role === "recovery").destination, acceptedDestination);
});

const SMTP_CONFIG = { provider: "smtp", smtp: { host: "mail.example.invalid", port: 587, security: "starttls" }, destinations: ["one@example.invalid"] };
test("SMTP known pre-DATA failure retries frozen MIME; relay acceptance and credentials remain separate", async t => {
  let sequence = 0;
  const f = fixture(t, { config: SMTP_CONFIG, smtpSend: async request => {
    if (++sequence === 1) return { accepted: false, retryable: true, safeToRetry: true, ambiguous: false, errorCode: "smtp-before-data-failed" };
    request.beforeData();
    assert.equal(f.store.db.prepare("SELECT smtp_data_at FROM notification_provider_attempts").get().smtp_data_at, f.now);
    return { accepted: true, smtpStatus: 250, receiptId: "smtp-receipt-" + "a".repeat(64), responseDigest: "b".repeat(64) };
  } });
  f.observe("critical"); await f.worker.tick();
  assert.equal(f.worker.status().attempts[0].state, "retryable");
  assert.equal(f.worker.status().deliveries[0].attemptedAt, null);
  f.advance(); await f.restart(); await f.worker.tick();
  assert.equal(f.calls.length, 2); assert.equal(f.calls[0].raw, f.calls[1].raw); assert.equal(f.calls[0].messageId, f.calls[1].messageId);
  const result = f.worker.status(); assert.equal(result.attempts[0].state, "accepted"); assert.equal(result.attempts[0].smtpStatus, 250);
  assert.equal(result.transport.idempotencyGuaranteed, false);
  assert.equal(JSON.stringify(result).includes(f.calls[1].credentials.pass), false);
});
test("SMTP uncertain DATA is never automatically replayed and fresh requeue retains prior evidence", async t => {
  const f = fixture(t, { config: SMTP_CONFIG, smtpSend: async request => {
    request.beforeData();
    return { accepted: false, retryable: false, safeToRetry: false, ambiguous: true, errorCode: "smtp-data-outcome-unknown" };
  } });
  f.observe("critical"); await f.worker.tick();
  let attempt = f.worker.status().attempts[0]; assert.equal(attempt.state, "needs-reconciliation");
  assert.equal(attempt.exactRetryAllowed, false);
  await f.restart(); f.advance(); await f.worker.tick(); assert.equal(f.calls.length, 1);
  assert.throws(() => f.worker.reconcile(f.decision(attempt, "retry-exact")), e => e.status === 409);
  f.worker.reconcile(f.decision(attempt, "requeue-fresh", { duplicateRiskAccepted: true }));
  await f.worker.tick(); assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].raw, f.calls[1].raw); assert.equal(f.calls[0].messageId, f.calls[1].messageId);
  assert.equal(f.worker.status().attempts.length, 2);
});
test("SMTP expired lease after DATA parks across workers instead of replaying", async t => {
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const f = fixture(t, { config: SMTP_CONFIG, smtpSend: async request => {
    request.beforeData(); enter(); return new Promise(resolve => { release = () => resolve({ accepted: false, ambiguous: true }); });
  } });
  f.observe("critical"); const running = f.worker.tick(); await entered; f.advance(61000);
  let otherWorker;
  const other = new MonitorStore({ data: path.join(f.directory, "state"), registry: f.store.registry, now: () => f.now, minFreeBytes: 0, notificationsEnabled: () => otherWorker?.enabled() === true });
  otherWorker = createNotifications(other, { appId: "app-example", configuration: f.config, consoleOrigin: "https://console.example.invalid",
    smtpSend: async () => assert.fail("uncertain SMTP replayed") });
  await otherWorker.tick(); release(); await running;
  assert.equal(f.worker.status().attempts[0].state, "needs-reconciliation");
  assert.equal(f.calls.length, 1);
  await otherWorker.close(); other.close();
});
