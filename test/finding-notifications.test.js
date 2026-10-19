"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const Database = require("better-sqlite3");
const { createFindingNotifications } = require("../server/finding-notifications");
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "finding-mail-test-"));
  const credentialFile = path.join(directory, "credential");
  const provider = options.provider || "resend", value = crypto.randomBytes(24).toString("base64url");
  fs.writeFileSync(credentialFile, provider === "smtp" ? JSON.stringify({ user: "operator@example.invalid", password: value }) : value, { mode: 0o600 });
  const db = new Database(path.join(directory, "state.sqlite")); db.pragma("journal_mode=WAL");
  db.exec("CREATE TABLE original_findings(id TEXT PRIMARY KEY)");
  const store = { db, controlSnapshot: () => ({ apps: [{ appId: "app-one" }, { appId: "app-two" }] }) };
  const notifications = { enabled: true, reviewed: true, provider, credentialFile, from: "monitor@example.invalid", destinations: options.destinations || ["team@example.invalid"], hourlySendCap: 100,
    ...(provider === "smtp" ? { smtp: { host: "mail.example.invalid", port: 587, security: "starttls" } } : {}) };
  const config = { schemaVersion: 1, applications: [{ appId: "app-one", notifications, ...(options.filters || {}) }] };
  let at = Date.UTC(2026, 9, 18, 12), worker, serial = 0;
  const calls = [];
  let send = options.send || (async () => ({ status: 200, id: "provider-example" }));
  const transports = {
    resend: async request => { calls.push(request); return send(request); },
    smtp: async request => { calls.push(request); return send(request); },
    verifySmtp: options.verify || (async () => ({ verified: true }))
  };
  const open = () => worker = createFindingNotifications({ store, stateDir: directory, consoleOrigin: "https://console.example.invalid", config, transports, now: () => at, maxAttempts: options.maxAttempts || 10000 });
  open();
  const f = { db, store, config, calls, directory, credentialFile, transports, get worker() { return worker; }, get now() { return at; },
    advance(ms = 60000) { at += ms; }, provider(fn) { send = fn; }, async restart() { await worker.close(); open(); },
    finding(id = "finding-one", extra = {}) { return { recordId: id, sourceId: "source-one", estateId: "app-one", kind: "finding", observedAt: new Date(at).toISOString(),
      payload: { title: "Synthetic signal", summary: "Review evidence", severity: "high", ruleRef: "rule-one", fields: { ruleAuthor: "Synthetic author", ruleLicense: "MIT" } }, ...extra }; },
    admit(records) { return db.transaction(() => worker.admit(records)).immediate(); },
    decision(extra = {}) { return { actor: "operator-example", reason: "Reviewed synthetic mail evidence", idempotencyKey: "decision-" + (++serial), ...extra }; }
  };
  t.after(async () => { await worker.close(); db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return f;
}
test("finding mail admission is atomic, filtered, deterministic and separate from native hosts", async t => {
  const f = fixture(t, { destinations: ["one@example.invalid", "two@example.invalid"], filters: { ruleIds: ["rule-one"], sourceIds: ["source-one"] } });
  const record = f.finding();
  assert.throws(() => f.worker.admit([record]), /share the finding transaction/);
  assert.throws(() => f.db.transaction(() => { f.db.prepare("INSERT INTO original_findings VALUES(?)").run(record.recordId); f.worker.admit([record]); throw new Error("rollback"); })(), /rollback/);
  assert.equal(f.worker.status("app-one").attempts.length, 0);
  assert.equal(f.db.prepare("SELECT count(*) n FROM original_findings").get().n, 0);
  assert.equal(f.admit([record]).queued, 2); assert.equal(f.admit([record]).queued, 0);
  assert.equal(f.admit([f.finding("foreign-source", { sourceId: "source-other" }), f.finding("foreign-app", { estateId: "app-two" })]).queued, 0);
  await f.worker.tick(); assert.equal(f.calls.length, 2);
  assert.match(JSON.parse(f.calls[0].body).text, /Rule author: Synthetic author/);
  assert.equal(f.db.prepare("SELECT name FROM sqlite_master WHERE name IN ('incidents','targets','notification_deliveries')").all().length, 0);
  assert.deepEqual(f.worker.status("app-two").attempts, []);
  await f.restart(); assert.equal(f.admit([record]).queued, 0); await f.worker.tick(); assert.equal(f.calls.length, 2);
});
test("canonical finding and queue capacity roll back together without silently losing mail", t => {
  const f = fixture(t, { maxAttempts: 2, destinations: ["one@example.invalid", "two@example.invalid"] });
  f.admit([f.finding()]);
  assert.throws(() => f.db.transaction(() => {
    f.db.prepare("INSERT INTO original_findings VALUES('second')").run(); f.worker.admit([f.finding("second")]);
  })(), error => error.status === 507);
  assert.equal(f.db.prepare("SELECT count(*) n FROM original_findings").get().n, 0);
  assert.equal(f.worker.status("app-one").attempts.length, 2);
});
test("finding Resend unknown response retries exactly after restart and pause survives restart", async t => {
  let sequence = 0;
  const f = fixture(t, { send: async () => ++sequence === 1 ? { status: null } : { status: 200, id: "provider-once" } });
  f.admit([f.finding()]); await f.worker.tick();
  f.worker.pause("app-one", f.decision({ paused: true, expectedRevision: 1 }));
  f.advance(); await f.restart(); await f.worker.tick(); assert.equal(f.calls.length, 1);
  f.worker.pause("app-one", f.decision({ paused: false, expectedRevision: 2 }));
  await f.worker.tick(); assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].body, f.calls[1].body); assert.equal(f.calls[0].key, f.calls[1].key);
  assert.equal(f.worker.status("app-one").attempts[0].state, "accepted");
  assert.equal(JSON.stringify(f.worker.status("app-one")).includes(fs.readFileSync(f.credentialFile, "utf8")), false);
});
test("finding SMTP ambiguity requires scoped explicit reconciliation and never replays on restart", async t => {
  const f = fixture(t, { provider: "smtp", send: async request => {
    request.beforeData(); return { accepted: false, retryable: false, ambiguous: true, errorCode: "smtp-data-outcome-unknown" };
  } });
  f.admit([f.finding()]); await f.worker.tick();
  const attempt = f.worker.status("app-one").attempts[0]; assert.equal(attempt.state, "needs-reconciliation");
  await f.restart(); f.advance(); await f.worker.tick(); assert.equal(f.calls.length, 1);
  assert.throws(() => f.worker.reconcile("app-two", f.decision({ attemptId: attempt.id, expectedRevision: attempt.revision, action: "retry-exact" })), e => e.status === 404);
  assert.throws(() => f.worker.reconcile("app-one", f.decision({ attemptId: attempt.id, expectedRevision: attempt.revision, action: "retry-exact" })), e => e.status === 409);
  const body = f.decision({ attemptId: attempt.id, expectedRevision: attempt.revision, action: "requeue-fresh", duplicateRiskAccepted: true });
  const receipt = f.worker.reconcile("app-one", body); assert.deepEqual(f.worker.reconcile("app-one", body), receipt);
  await f.worker.tick(); assert.equal(f.calls.length, 2); assert.equal(f.calls[0].raw, f.calls[1].raw);
  assert.equal(f.worker.status("app-one").attempts.length, 2);
});
test("commissioning requires explicit reviewed recipient; verify sends no mail and records replayable result", async t => {
  let verified = 0;
  const f = fixture(t, { provider: "smtp", verify: async () => { verified++; return { verified: true }; }, send: async request => {
    request.beforeData(); return { accepted: true, smtpStatus: 250, receiptId: "smtp-receipt-" + "a".repeat(64), responseDigest: "b".repeat(64) };
  } });
  const body = f.decision();
  assert.equal((await f.worker.verify("app-one", body)).verified, true);
  assert.equal((await f.worker.verify("app-one", body)).verified, true); assert.equal(verified, 1); assert.equal(f.calls.length, 0);
  assert.equal(f.worker.status("app-one").verification.verified, true);
  await f.restart(); assert.equal(f.worker.status("app-one").verification.verified, true);
  assert.throws(() => f.worker.testSend("app-one", f.decision({ recipient: "unreviewed@example.invalid" })), e => e.status === 400);
  const testBody = f.decision({ recipient: "team@example.invalid" });
  const receipt = f.worker.testSend("app-one", testBody); assert.deepEqual(f.worker.testSend("app-one", testBody), receipt);
  await f.worker.tick(); assert.equal(f.calls.length, 1);
  const attempt = f.worker.status("app-one").attempts[0];
  assert.equal(attempt.kind, "commissioning"); assert.equal(attempt.sourceId, null); assert.equal(attempt.recordId, null); assert.equal(attempt.state, "accepted");
});

test("expired SMTP DATA lease is parked by another finding worker and cannot be overwritten by the late sender", async t => {
  let release, entered; const boundary = new Promise(resolve => { entered = resolve; });
  const f = fixture(t, { provider: "smtp", send: request => {
    request.beforeData(); entered(); return new Promise(resolve => { release = resolve; });
  } });
  f.admit([f.finding()]); const first = f.worker.tick(); await boundary;
  const other = createFindingNotifications({ store: f.store, stateDir: f.directory, consoleOrigin: "https://console.example.invalid",
    config: f.config, transports: { smtp: async () => assert.fail("An unknown DATA request cannot replay") }, now: () => f.now });
  t.after(() => other.close()); f.advance(61000); await other.tick();
  assert.equal(other.status("app-one").attempts[0].state, "needs-reconciliation");
  release({ accepted: true, smtpStatus: 250, receiptId: "smtp-receipt-" + "d".repeat(64) }); await first;
  assert.equal(other.status("app-one").attempts[0].state, "needs-reconciliation");
  assert.equal(f.calls.length, 1);
});
test("finding retries stop at the provider deadline and credential or server changes park without sending", async t => {
  for (const change of ["deadline", "credential", "server"]) {
    const f = fixture(t, { provider: change === "server" ? "smtp" : "resend", send: async () => change === "server"
      ? { accepted: false, retryable: true, safeToRetry: true, ambiguous: false, errorCode: "smtp-connect-failed" } : { status: null } });
    f.admit([f.finding()]); await f.worker.tick();
    if (change === "deadline") f.advance(23 * 3600000);
    else {
      f.advance();
      if (change === "credential") fs.writeFileSync(f.credentialFile, crypto.randomBytes(24).toString("base64url"), { mode: 0o600 });
      else f.config.applications[0].notifications.smtp.host = "new-mail.example.invalid";
    }
    await f.restart(); await f.worker.tick();
    assert.equal(f.calls.length, 1, change); const row = f.worker.status("app-one").attempts[0];
    assert.equal(row.state, "needs-reconciliation", change);
    assert.equal(row.errorCode, { deadline: "retry-window-expired", credential: "credential-changed", server: "provider-configuration-changed" }[change]);
  }
});
