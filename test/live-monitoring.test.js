"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { createLiveMonitoring, LIMITS } = require("../server/live-monitoring");
const { ReferenceControlPlane } = require("../server/reference-runtime");
const { SqliteTelemetryStore } = require("../server/sqlite-telemetry-store");
const { operatorId, runAsOperator } = require("../server/operator-context");

const START = Date.parse("2026-09-29T12:00:00.000Z");
const WHO = operatorId("synthetic-live-owner");
const TOKEN = "synthetic" + "-live-read-token-not-a-real-secret";
const WEBHOOK = "https://" + ["hooks", "slack", "com"].join(".")
  + ["", "services", "TSYNTHETIC", "BSYNTHETIC", "synthetic-not-a-live-secret"].join("/");
function event(number, overrides = {}) {
  return { eventID: number.toString(16).padStart(32, "0"), dateCreated: new Date(START - 60000).toISOString(),
    type: "error", platform: "node", level: "error", ...overrides };
}
function sentryResponse(url, events = [], { next = null, status = 200, headers = {}, body } = {}) {
  const destination = new URL(url); destination.searchParams.set("cursor", next || "0:999:0");
  return new Response(body === undefined ? JSON.stringify(events) : body, { status,
    headers: { "content-type": "application/json", link: `<${destination.href}>; rel="next"; results="${Boolean(next)}"; cursor="${next || "0:999:0"}"`, ...headers } });
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "bb-soc-live-monitor-test-"));
  fs.chmodSync(directory, 0o700);
  let milliseconds = START, monitoring, runtime, sequence = 0;
  const clock = () => new Date(milliseconds), calls = [], steps = [];
  const fetchImpl = async (url, init) => {
    const call = { url, init }; calls.push(call);
    assert.ok(steps.length, "All outbound requests must match an explicitly queued synthetic response.");
    const step = steps.shift();
    const kind = new URL(url).hostname === "hooks.slack.com" ? "slack" : "sentry";
    assert.equal(kind, step.kind);
    return step.handle(url, init);
  };
  const open = (autoStart = false) => {
    runtime = new ReferenceControlPlane({ clock, store: new SqliteTelemetryStore({ directory, clock }),
      enabledConnectorTypes: ["canonical-push", "canonical-events", "trivy-report"] });
    monitoring = createLiveMonitoring({ stateDir: directory, runtime, clock, fetchImpl, autoStart });
  };
  open();
  t.after(async () => { await monitoring?.close(); runtime?.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  const command = (name, input) => runAsOperator("synthetic-live-owner", () => runtime.execute({ schemaVersion: "1",
    documentType: "connector-command-request", requestId: "live-monitor-test-" + (++sequence), requestedAt: clock().toISOString(), command: name, input }));
  const app = command("app.register", { displayName: "Synthetic monitored application", environments: ["test"], publicPages: [] });
  assert.equal(app.status, "succeeded");
  const f = { directory, calls, steps, command, appId: app.output.appId, now: () => clock().toISOString(), advance: amount => { milliseconds += amount; },
    get monitoring() { return monitoring; }, get runtime() { return runtime; },
    sentry(events = [], options = {}) { steps.push({ kind: "sentry", handle: url => sentryResponse(url, events, options) }); },
    slack({ status = 200, body = "ok", headers = {} } = {}) { steps.push({ kind: "slack", handle: () => new Response(body, { status, headers }) }); },
    pending(kind = "sentry") {
      const entered = deferred(), response = deferred();
      steps.push({ kind, handle: (url, init) => { entered.resolve({ url, init }); return response.promise; } });
      return { entered: entered.promise, resolve: response.resolve };
    },
    input(overrides = {}) { return { appId: app.output.appId, environment: "test", displayName: "Synthetic Sentry", region: "us",
      organization: "synthetic-org", project: "synthetic-project", token: TOKEN, ...overrides }; },
    connect(overrides = {}) { return monitoring.connect(f.input(overrides), WHO); },
    connection() { return monitoring.list().connections[0]; },
    source() { return runtime.controlState().sources.find(item => item.sourceId === f.connection().sourceId); },
    change(action, fields = {}) { const row = f.connection(); return monitoring.change(row.id, action, { expectedRevision: row.revision, ...fields }, WHO); },
    async reopen(autoStart = false) { await monitoring.close(); runtime.dispose(); open(autoStart); },
    inspect(callback) { const db = new Database(path.join(directory, "live-monitoring.sqlite")); try { return callback(db); } finally { db.close(); } },
    stored() { return f.inspect(db => JSON.parse(db.prepare("SELECT data FROM connections ORDER BY id LIMIT 1").get().data)); }
  };
  return f;
}

test("guided quiet connection verifies real read-only transport and becomes healthy without synthetic telemetry", async t => {
  const f = await fixture(t); f.sentry();
  const result = await f.connect();
  assert.equal(result.connection.health, "starting");
  assert.equal(result.connection.lastSuccessAt, null);
  assert.equal(f.runtime.store.stats().records, 0);
  assert.equal(f.runtime.store.stats().receipts, 0);
  assert.deepEqual(f.runtime.controlState().sourceCredentials, []);
  assert.equal(f.source().state, "active");
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].init.method, "GET");
  assert.equal(f.calls[0].init.headers.Authorization, "Bearer " + TOKEN);
  assert.equal(new URL(f.calls[0].url).origin, "https://us.sentry.io");
  await f.monitoring.runOnce();
  assert.equal(f.calls.length, 1, "The validated onboarding page is durably reused, not fetched twice.");
  assert.equal(f.connection().health, "healthy");
  assert.equal(f.connection().completedThrough, new Date(START - 30000).toISOString());
  assert.equal(f.connection().lastSuccessAt, f.now());
  assert.equal(f.connection().lastEventAt, null);
  assert.equal(f.source().health.state, "healthy");
  assert.equal(f.source().health.counters.receivedRecords, 0);
  assert.equal(f.runtime.store.stats().records, 0);
  assert.equal(f.monitoring.list().totalAlerts, 0);
  await f.reopen();
  assert.equal(f.connection().health, "healthy");
  f.advance(301000);
  assert.equal(f.connection().health, "offline", "A stopped scheduler must not imply a healthy quiet application.");
});

test("failed onboarding stores no connection, source, credential or telemetry and reflects no raw vendor errors", async t => {
  const f = await fixture(t), marker = crypto.randomBytes(24).toString("hex");
  for (const response of [{ status: 403, body: marker }, { body: "not-json", headers: { link: "invalid" } }, { events: [event(1, { dateCreated: "2026-09-20T12:00:00.000Z" })] }]) {
    f.sentry(response.events || [], response);
    await assert.rejects(f.connect(), error => error.status === 422 && !error.message.includes(marker));
    assert.equal(f.monitoring.list().connections.length, 0);
    assert.equal(f.runtime.controlState().sources.length, 0);
    assert.equal(f.runtime.store.stats().records, 0);
  }
  assert.equal(f.calls.length, 3);
});

test("a two-page window checkpoints only the admitted page and resumes its exact cursor after persisted rate limiting", async t => {
  const f = await fixture(t); f.sentry([event(1)], { next: "0:100:0" }); await f.connect();
  f.sentry([], { status: 429, headers: { "retry-after": "120" } });
  await f.monitoring.runOnce();
  assert.equal(f.runtime.store.stats().records, 1);
  assert.equal(f.connection().totalEvents, 1);
  assert.equal(f.connection().completedThrough, null);
  assert.equal(f.connection().pendingWindow.pages, 1);
  assert.equal(f.connection().health, "degraded");
  assert.match(f.connection().lastError, /rate limited/);
  assert.equal(f.source().health.state, "degraded");
  const checkpoint = f.stored().window, next = f.connection().nextPollAt;
  assert.equal(checkpoint.cursor, "0:100:0");
  assert.equal(next, new Date(START + 120000).toISOString());
  await f.reopen();
  await f.change("poll"); await f.monitoring.runOnce();
  f.advance(119999); await f.change("poll"); await f.monitoring.runOnce();
  assert.equal(f.calls.length, 2, "Manual poll cannot bypass the durable vendor cooldown.");
  f.advance(1); f.sentry([event(2)]); await f.monitoring.runOnce();
  const request = new URL(f.calls.at(-1).url);
  assert.equal(request.searchParams.get("cursor"), checkpoint.cursor);
  assert.equal(request.searchParams.get("start"), checkpoint.start);
  assert.equal(request.searchParams.get("end"), checkpoint.end);
  assert.equal(f.connection().totalEvents, 2, JSON.stringify({ connection: f.connection(), calls: f.calls.length, pending: f.stored().pending !== null }));
  assert.equal(f.connection().completedThrough, checkpoint.end);
  assert.equal(f.connection().pendingWindow, null);
  assert.equal(f.connection().health, "healthy");
  assert.equal(f.runtime.store.stats().records, 2);
  assert.equal(f.monitoring.list().alerts.filter(item => item.kind === "collection-recovered").length, 1);
});

test("bounded passes retain multi-page progress through restart and never claim partial-window success", async t => {
  const f = await fixture(t); f.sentry([event(1)], { next: "0:100:0" }); await f.connect();
  for (let page = 2; page <= 5; page += 1) f.sentry([event(page)], { next: "0:" + page * 100 + ":0" });
  await f.monitoring.runOnce();
  assert.equal(f.connection().totalEvents, 5);
  assert.equal(f.connection().pendingWindow.pages, LIMITS.pagesPerPass);
  assert.equal(f.connection().completedThrough, null);
  assert.equal(f.connection().health, "degraded");
  const window = f.stored().window;
  await f.reopen(); f.advance(5000); f.sentry([event(6)]); await f.monitoring.runOnce();
  assert.equal(new URL(f.calls.at(-1).url).searchParams.get("cursor"), window.cursor);
  assert.equal(f.connection().totalEvents, 6);
  assert.equal(f.connection().pendingWindow, null);
  assert.equal(f.connection().health, "healthy");
});

test("overlapping collection and restart deduplicate records and alerts without refreshing true event times", async t => {
  const f = await fixture(t); f.sentry([event(1), event(2)]); await f.connect(); await f.monitoring.runOnce();
  assert.equal(f.connection().totalEvents, 2);
  const firstAlert = f.monitoring.list().alerts.find(item => item.kind === "application-errors");
  await f.reopen(); f.advance(60000); f.sentry([event(2), event(3)]); await f.monitoring.runOnce();
  assert.equal(f.connection().totalEvents, 3);
  assert.equal(f.runtime.store.stats().records, 3);
  assert.equal(f.monitoring.list().alerts.filter(item => item.kind === "application-errors").length, 2);
  assert.ok(f.monitoring.list().alerts.some(item => item.id === firstAlert.id));
  const records = f.runtime.getState().records;
  assert.ok(records.every(item => item.observedAt === event(1).dateCreated));
  f.advance(60000); f.sentry([event(1), event(2), event(3)]); await f.monitoring.runOnce();
  assert.equal(f.connection().totalEvents, 3);
  assert.equal(f.monitoring.list().alerts.filter(item => item.kind === "application-errors").length, 2);
  f.advance(60000); f.sentry(); await f.monitoring.runOnce();
  assert.deepEqual(f.runtime.getState().records, records);
  assert.equal(f.connection().lastEventAt, event(1).dateCreated);
  assert.equal(f.connection().health, "healthy");
});

test("admission-before-checkpoint failure replays the original durable batch without losing or duplicating alert evidence", async t => {
  const f = await fixture(t); f.sentry([event(1)]); await f.connect();
  f.inspect(db => db.exec("CREATE TRIGGER refuse_checkpoint BEFORE INSERT ON seen_events BEGIN SELECT RAISE(ABORT,'synthetic crash after telemetry admission'); END"));
  await f.monitoring.runOnce();
  assert.equal(f.runtime.store.stats().records, 1);
  assert.equal(f.connection().totalEvents, 0);
  const pending = f.stored().pending;
  assert.ok(pending.batch && pending.bodyHash);
  assert.equal(f.connection().completedThrough, null);
  f.inspect(db => db.exec("DROP TRIGGER refuse_checkpoint"));
  await f.reopen(); f.advance(60000); await f.monitoring.runOnce();
  assert.equal(f.calls.length, 1, "Recovery replays the journaled canonical body instead of refetching unstable upstream content.");
  assert.equal(f.connection().totalEvents, 1);
  assert.equal(f.runtime.store.stats().records, 1);
  assert.equal(f.runtime.store.stats().receipts, 1);
  assert.equal(f.stored().pending, null);
  assert.equal(f.monitoring.list().alerts.filter(item => item.kind === "application-errors").length, 1);
  assert.equal(f.connection().health, "healthy");
});

test("failure and recovery are durable episode alerts, and a successful window resets collection backoff", async t => {
  const f = await fixture(t); f.sentry(); await f.connect(); await f.monitoring.runOnce();
  f.advance(60000); f.sentry([], { status: 503 }); await f.monitoring.runOnce();
  const failureId = f.monitoring.list().alerts.find(item => item.kind === "collection-failed").id;
  f.advance(60000); f.sentry([], { status: 403 }); await f.monitoring.runOnce();
  assert.equal(f.monitoring.list().alerts.filter(item => item.kind === "collection-failed").length, 1);
  assert.equal(f.monitoring.list().alerts.find(item => item.kind === "collection-failed").id, failureId);
  await f.reopen(); f.advance(120000); f.sentry(); await f.monitoring.runOnce();
  assert.equal(f.connection().health, "healthy");
  assert.equal(f.monitoring.list().alerts.filter(item => item.kind === "collection-recovered").length, 1);
  f.advance(60000); f.sentry([], { status: 503 }); await f.monitoring.runOnce();
  assert.equal(f.monitoring.list().alerts.filter(item => item.kind === "collection-failed").length, 2);
  assert.equal(Date.parse(f.connection().nextPollAt) - Date.parse(f.now()), 60000, "A recovered episode starts a fresh bounded retry budget.");
});

test("Slack delivery retries and acknowledgements survive restart independently from collection health", async t => {
  const f = await fixture(t); f.sentry([event(1)]); await f.connect({ slackWebhook: WEBHOOK });
  f.slack({ status: 429, headers: { "retry-after": "120" } }); await f.monitoring.runOnce();
  const alert = f.monitoring.list().alerts.find(item => item.kind === "application-errors");
  assert.equal(alert.deliveryState, "pending"); assert.equal(alert.attempts, 1);
  assert.equal(f.connection().health, "healthy");
  assert.match(f.connection().notificationStatus, /failed/);
  f.monitoring.acknowledge(alert.id, WHO);
  await f.reopen(); f.advance(60000); f.sentry(); await f.monitoring.runOnce();
  assert.equal(f.calls.filter(item => new URL(item.url).hostname === "hooks.slack.com").length, 1);
  f.advance(60000); f.sentry(); f.slack(); await f.monitoring.runOnce();
  const delivered = f.monitoring.list().alerts.find(item => item.id === alert.id);
  assert.equal(delivered.deliveryState, "delivered"); assert.equal(delivered.attempts, 2);
  assert.ok(delivered.acknowledgedAt && delivered.deliveredAt);
  assert.equal(f.connection().notificationStatus, "configured");
  assert.ok(!JSON.stringify(delivered).includes(TOKEN));
  const slackRequest = f.calls.find(item => new URL(item.url).hostname === "hooks.slack.com");
  assert.equal(slackRequest.init.method, "POST");
  const body = JSON.parse(slackRequest.init.body);
  assert.equal(body.mrkdwn, false); assert.equal(body.blocks[0].text.type, "plain_text");
});

test("Slack hard failures require explicit retry and cannot shorten the retained cooldown", async t => {
  const f = await fixture(t); f.sentry([event(1)]); await f.connect({ slackWebhook: WEBHOOK });
  f.slack({ status: 403 }); await f.monitoring.runOnce();
  const first = f.monitoring.list().alerts[0];
  assert.equal(first.deliveryState, "blocked");
  await f.change("retry-notifications"); await f.change("poll");
  assert.equal(f.calls.filter(item => new URL(item.url).hostname === "hooks.slack.com").length, 1);
  assert.equal(f.monitoring.list().alerts[0].deliveryState, "pending");
  await f.reopen(); f.advance(60000); f.sentry(); f.slack(); await f.monitoring.runOnce();
  assert.equal(f.monitoring.list().alerts[0].deliveryState, "delivered");
});

test("pause fences an in-flight read, resume preserves its checkpoint, and removal archives the source", async t => {
  const f = await fixture(t); f.sentry(); await f.connect(); await f.monitoring.runOnce(); f.advance(60000);
  const checkpoint = f.connection().completedThrough, pending = f.pending();
  const running = f.monitoring.runOnce(), request = await pending.entered;
  await f.change("pause");
  pending.resolve(sentryResponse(request.url, [event(1)])); await running;
  assert.equal(f.connection().health, "paused");
  assert.equal(f.connection().completedThrough, checkpoint);
  assert.equal(f.runtime.store.stats().records, 0);
  assert.equal(f.source().state, "active", "Collector pause does not change unrelated manual source lifecycle.");
  await assert.rejects(f.change("poll"), error => error.status === 409);
  await f.change("resume"); f.sentry([event(1)]); await f.monitoring.runOnce();
  assert.equal(f.connection().totalEvents, 1);
  f.advance(60000); const later = f.pending(), deletingRun = f.monitoring.runOnce(), laterRequest = await later.entered;
  const sourceId = f.connection().sourceId;
  const removed = await f.change("remove");
  later.resolve(sentryResponse(laterRequest.url, [event(2)])); await deletingRun;
  assert.equal(removed.removed, true);
  assert.equal(f.monitoring.list().connections.length, 0);
  assert.equal(f.runtime.controlState().sources.find(item => item.sourceId === sourceId).state, "archived");
  assert.equal(f.runtime.store.stats().records, 1);
  assert.equal(f.monitoring.list().totalAlerts, 1, "Removing a connection preserves admitted alert history.");
});

test("acknowledgement during a Slack request survives its eventual delivery commit", async t => {
  const f = await fixture(t); f.sentry([event(1)]); await f.connect({ slackWebhook: WEBHOOK });
  const pending = f.pending("slack"), running = f.monitoring.runOnce(); await pending.entered;
  const alert = f.monitoring.list().alerts.find(item => item.kind === "application-errors");
  f.monitoring.acknowledge(alert.id, WHO);
  pending.resolve(new Response("ok")); await running;
  const saved = f.monitoring.list().alerts.find(item => item.id === alert.id);
  assert.equal(saved.deliveryState, "delivered"); assert.ok(saved.acknowledgedAt);
});

test("credentials are encrypted at rest, absent from public data and audit, and changed credentials replace the outbound bearer", async t => {
  const f = await fixture(t), marker = crypto.randomBytes(24).toString("hex");
  f.sentry([event(1, { message: marker, request: { headers: { authorization: marker } }, user: { email: marker } })]);
  await f.connect({ slackWebhook: WEBHOOK }); f.slack(); await f.monitoring.runOnce();
  const replacement = "synthetic-rotated-" + crypto.randomBytes(24).toString("hex");
  await f.change("credentials", { token: replacement });
  assert.equal(f.inspect(db => db.prepare("SELECT secrets FROM connections").get().secrets).includes(replacement), false);
  const publicState = JSON.stringify(f.monitoring.list());
  for (const secret of [TOKEN, replacement, WEBHOOK, marker]) assert.ok(!publicState.includes(secret));
  for (const name of fs.readdirSync(f.directory)) {
    const filename = path.join(f.directory, name);
    if (!fs.statSync(filename).isFile()) continue;
    const contents = fs.readFileSync(filename);
    for (const secret of [TOKEN, replacement, WEBHOOK, marker]) assert.equal(contents.includes(Buffer.from(secret)), false, name + " must not contain raw secrets or vendor payloads");
    if (name.startsWith("live-monitoring")) assert.equal(fs.statSync(filename).mode & 0o077, 0);
  }
  await f.reopen(); f.advance(60000); f.sentry(); await f.monitoring.runOnce();
  assert.equal(f.calls.at(-1).init.headers.Authorization, "Bearer " + replacement);
});

test("invalid configuration, wrong lifecycle revisions, duplicates and bounded connection capacity fail without outbound side effects", async t => {
  const f = await fixture(t);
  for (const input of [{ token: "bad" }, { region: "http://127.0.0.1" }, { project: "../other" }, { appId: "missing" },
    { environment: "not-registered" }, { displayName: "" }, { unknown: true }, { slackWebhook: "https://example.invalid/hook" }]) {
    await assert.rejects(f.connect(input));
  }
  assert.equal(f.calls.length, 0);
  f.sentry(); await f.connect();
  await assert.rejects(f.connect(), error => error.status === 409);
  await assert.rejects(f.monitoring.change(f.connection().id, "pause", { expectedRevision: 0 }, WHO), error => error.status === 409);
  assert.throws(() => f.monitoring.list({ offset: -1 }));
  assert.throws(() => f.monitoring.list({ limit: 101 }));
  assert.throws(() => f.monitoring.acknowledge("missing", WHO), error => error.status === 404);
  for (let index = 1; index < LIMITS.connections; index += 1) { f.sentry(); await f.connect({ project: "synthetic-project-" + index }); }
  assert.equal(f.monitoring.list().connections.length, LIMITS.connections);
  await assert.rejects(f.connect({ project: "over-capacity" }), error => error.status === 409);
  assert.equal(f.calls.length, LIMITS.connections);
});

test("a six-day collection gap fails closed without silently skipping the stored coverage boundary", async t => {
  const f = await fixture(t); f.sentry(); await f.connect(); await f.monitoring.runOnce();
  const checkpoint = f.connection().completedThrough;
  f.advance(7 * 86400000); await f.monitoring.runOnce();
  assert.equal(f.calls.length, 1);
  assert.equal(f.connection().completedThrough, checkpoint);
  assert.equal(f.connection().health, "degraded");
  assert.equal(f.monitoring.list().alerts.filter(item => item.kind === "collection-failed").length, 1);
});

test("restoring credentials requires the original key and ciphertext; missing or altered keys never silently reinitialize", async t => {
  const f = await fixture(t); f.sentry(); await f.connect(); await f.monitoring.close();
  const filename = path.join(f.directory, "live-monitoring.key"), held = filename + ".test-held", original = fs.readFileSync(filename);
  const reopen = () => createLiveMonitoring({ stateDir: f.directory, runtime: f.runtime, clock: () => new Date(f.now()), autoStart: false,
    fetchImpl: () => { throw new Error("Restore checks cannot make outbound requests."); } });
  fs.renameSync(filename, held);
  try { assert.throws(reopen, /key is missing/); assert.equal(fs.existsSync(filename), false); }
  finally { fs.renameSync(held, filename); }
  fs.writeFileSync(filename, crypto.randomBytes(32));
  try { assert.throws(reopen, error => error.status === 503 && /recovery journal/.test(error.message)); }
  finally { fs.writeFileSync(filename, original); }
  const sealed = f.inspect(db => db.prepare("SELECT secrets FROM connections").get().secrets);
  f.inspect(db => db.prepare("UPDATE connections SET secrets=?").run("A".repeat(sealed.length)));
  try { assert.throws(reopen, error => error.status === 503); }
  finally { f.inspect(db => db.prepare("UPDATE connections SET secrets=?").run(sealed)); }
  await f.reopen(); await f.monitoring.runOnce();
  assert.equal(f.connection().health, "healthy"); assert.equal(f.calls.length, 1);
});

test("startup rejects altered schema, malformed checkpoint and inconsistent pending canonical evidence before any collection", async t => {
  const f = await fixture(t); f.sentry([event(1)], { next: "0:100:0" }); await f.connect(); await f.monitoring.close();
  const original = f.stored(), serialized = JSON.stringify(original);
  const reopen = () => createLiveMonitoring({ stateDir: f.directory, runtime: f.runtime, clock: () => new Date(f.now()), autoStart: false,
    fetchImpl: () => { throw new Error("Untrusted recovery state cannot make requests."); } });
  f.inspect(db => db.exec("CREATE INDEX unexpected_index ON connections(id)"));
  assert.throws(reopen, /schema/); f.inspect(db => db.exec("DROP INDEX unexpected_index"));
  const mutations = [row => { row.window.end = "not-a-time"; }, row => { row.window.pages = 10001; },
    row => { row.window.cursor = "0:100:0"; }, row => { row.window.cursors = ["0:100:0", "0:100:0"]; row.window.pages = 2; },
    row => { row.pending.bodyHash = "0".repeat(64); }, row => { row.pending.candidates[0].recordId = "vendor:" + "0".repeat(64); },
    row => { row.pending.candidates[0].vendorEventId = "b".repeat(32); }, row => { row.pending.candidates[0].url = "https://example.invalid/phish"; },
    row => { row.pending.batch.records[0].estateId = "wrong-application"; }, row => { row.sourceId = null; row.provisioning = false; },
    row => { row.unrecognized = true; }, row => { row.notificationRetryBlocked = "false"; }];
  for (const mutate of mutations) {
    const changed = structuredClone(original); mutate(changed);
    f.inspect(db => db.prepare("UPDATE connections SET data=?").run(JSON.stringify(changed)));
    assert.throws(reopen, error => error.status === 503 && /recovery journal/.test(error.message));
  }
  f.inspect(db => db.prepare("UPDATE connections SET data=?").run(serialized));
  await f.reopen();
  assert.equal(f.connection().health, "starting"); assert.equal(f.calls.length, 1);
});

test("startup enforces bounded persisted rows and JSON sizes without parsing unbounded journal data", async t => {
  const f = await fixture(t); f.sentry(); await f.connect(); await f.monitoring.close();
  const original = f.inspect(db => db.prepare("SELECT * FROM connections").get());
  const reopen = () => createLiveMonitoring({ stateDir: f.directory, runtime: f.runtime, clock: () => new Date(f.now()), autoStart: false });
  f.inspect(db => db.prepare("UPDATE connections SET data=?").run("x".repeat(2 * 1024 * 1024 + 1)));
  assert.throws(reopen, error => error.status === 503);
  f.inspect(db => {
    db.prepare("UPDATE connections SET data=?").run(original.data);
    const insert = db.prepare("INSERT INTO connections VALUES(?,?,?)");
    db.transaction(() => { for (let index = 0; index < LIMITS.connections; index += 1) insert.run("monitor-" + crypto.randomUUID(), original.data, original.secrets); })();
  });
  assert.throws(reopen, error => error.status === 503);
  f.inspect(db => db.prepare("DELETE FROM connections WHERE id<>?").run(original.id));
  await f.reopen(); assert.equal(f.monitoring.list().connections.length, 1);
});

test("alert capacity stops checkpoint advancement without evicting unread alerts and recovers after deliberate acknowledgement", async t => {
  const f = await fixture(t); f.sentry([event(1)]); await f.connect();
  const connection = f.connection(), alertId = index => "alert-" + index.toString(16).padStart(64, "0");
  f.inspect(db => {
    const insert = db.prepare("INSERT INTO alerts VALUES(?,?,?,?)");
    db.transaction(() => { for (let index = 0; index < LIMITS.alerts; index += 1) {
      const value = { id: alertId(index), connectionId: connection.id, sourceId: connection.sourceId, appId: f.appId, kind: "notification-test",
        title: "Synthetic retained alert", body: "Synthetic capacity fixture", createdAt: f.now(), acknowledgedAt: null,
        deliveryState: "in-app", attempts: 0, nextAttemptAt: f.now() };
      insert.run(value.id, connection.id, value.createdAt, JSON.stringify(value));
    } })();
  });
  await f.monitoring.runOnce();
  assert.equal(f.connection().completedThrough, null); assert.equal(f.connection().totalEvents, 0);
  assert.equal(f.runtime.store.stats().records, 1, "The admitted canonical page remains journaled for recovery.");
  assert.equal(f.monitoring.list().totalAlerts, LIMITS.alerts);
  f.monitoring.acknowledge(alertId(0), WHO); f.monitoring.acknowledge(alertId(1), WHO);
  await f.reopen(); f.advance(60000); await f.monitoring.runOnce();
  assert.equal(f.connection().totalEvents, 1); assert.equal(f.connection().health, "healthy");
  assert.equal(f.monitoring.list().totalAlerts, LIMITS.alerts);
  assert.equal(f.inspect(db => db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE json_extract(data,'$.kind')='application-errors'").get().n), 1);
});

test("ten Slack attempts remain exhausted across restart until an operator explicitly retries", async t => {
  const f = await fixture(t); f.sentry([event(1)]); await f.connect({ slackWebhook: WEBHOOK });
  f.slack({ status: 503 }); await f.monitoring.runOnce(); await f.change("pause");
  for (let attempt = 2; attempt <= 10; attempt += 1) {
    const alert = f.monitoring.list().alerts[0];
    f.advance(Date.parse(alert.nextAttemptAt) - Date.parse(f.now()));
    if (attempt === 5) await f.reopen();
    f.slack({ status: 503 }); await f.monitoring.runOnce();
  }
  assert.equal(f.monitoring.list().alerts[0].attempts, 10);
  assert.equal(f.monitoring.list().alerts[0].deliveryState, "blocked");
  await f.reopen(); f.advance(86400000); await f.monitoring.runOnce();
  assert.equal(f.calls.filter(item => new URL(item.url).hostname === "hooks.slack.com").length, 10);
  await f.change("retry-notifications"); f.slack(); await f.monitoring.runOnce();
  assert.equal(f.monitoring.list().alerts[0].deliveryState, "delivered");
  assert.equal(f.monitoring.list().alerts[0].attempts, 1);
});

test("connection removal cancels pending Slack delivery without allowing a late acknowledgement to resurrect it", async t => {
  const f = await fixture(t); f.sentry([event(1)]); await f.connect({ slackWebhook: WEBHOOK });
  const pending = f.pending("slack"), running = f.monitoring.runOnce(); await pending.entered;
  await f.change("remove"); pending.resolve(new Response("ok")); await running;
  assert.equal(f.monitoring.list().connections.length, 0);
  assert.equal(f.monitoring.list().alerts[0].deliveryState, "cancelled");
  await f.reopen();
  assert.equal(f.monitoring.list().alerts[0].deliveryState, "cancelled");
});

test("the unattended scheduler resumes all due connections after restart without starving the third behind its two-job limit", async t => {
  const f = await fixture(t);
  for (let index = 0; index < 3; index += 1) { f.sentry(); await f.connect({ project: "automatic-project-" + index }); }
  assert.ok(f.monitoring.list().connections.every(item => item.health === "starting"));
  await f.reopen(true);
  const deadline = Date.now() + 5000;
  while (f.monitoring.list().connections.some(item => item.health !== "healthy") && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(f.monitoring.list().connections.every(item => item.health === "healthy"));
  assert.equal(f.calls.length, 3, "Restarted scheduler consumes the retained validated pages without extra vendor reads.");
  assert.equal(f.runtime.store.stats().records, 0);
});

test("round-robin scheduling prevents a continuous notification backlog from starving later collectors", async t => {
  const f = await fixture(t);
  for (let index = 0; index < 3; index += 1) {
    f.sentry([event(index + 1)]);
    const { connection } = await f.connect({ project: "busy-project-" + index, slackWebhook: WEBHOOK });
    await f.monitoring.change(connection.id, "test-notification", { expectedRevision: connection.revision }, WHO);
  }
  let tick;
  t.mock.method(globalThis, "setInterval", callback => { tick = callback; return { unref() {} }; });
  await f.reopen(true);
  f.slack(); f.slack(); tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.monitoring.list().connections.filter(item => item.health === "healthy").length, 2);
  f.advance(1000); f.slack(); f.slack(); tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(f.monitoring.list().connections.every(item => item.health === "healthy"), "The third collector runs even though the first two still have due notifications.");
  assert.equal(f.runtime.store.stats().records, 3);
});

test("a cyclic next cursor is rejected before journaling so the last valid checkpoint remains restartable", async t => {
  const f = await fixture(t); f.sentry([event(1)], { next: "0:100:0" }); await f.connect();
  f.sentry([event(2)], { next: "0:200:0" });
  f.sentry([event(3)], { next: "0:100:0" });
  await f.monitoring.runOnce();
  assert.equal(f.connection().health, "degraded");
  assert.equal(f.connection().totalEvents, 2);
  assert.equal(f.runtime.store.stats().records, 2, "The cyclic page must not reach canonical admission.");
  const saved = f.stored();
  assert.equal(saved.pending, null, "Invalid pagination cannot poison the recovery journal.");
  assert.equal(saved.window.cursor, "0:200:0");
  assert.deepEqual(saved.window.cursors, ["0:100:0", "0:200:0"]);
  assert.equal(saved.window.pages, 2);
  assert.equal(saved.completedThrough, null);
  await f.reopen();
  assert.equal(f.connection().totalEvents, 2);
  f.advance(60000); f.sentry([event(3)]); await f.monitoring.runOnce();
  assert.equal(new URL(f.calls.at(-1).url).searchParams.get("cursor"), "0:200:0");
  assert.equal(f.connection().health, "healthy");
  assert.equal(f.connection().totalEvents, 3);
  assert.equal(f.runtime.store.stats().records, 3);
});

test("a completed but still-backlogged window keeps source health degraded until collection catches up", async t => {
  const f = await fixture(t); f.sentry(); await f.connect(); await f.monitoring.runOnce();
  const initiallyCompleted = f.connection().completedThrough;
  f.advance(2 * 60 * 60000); f.sentry(); await f.monitoring.runOnce();
  assert.equal(f.connection().pendingWindow, null, "The bounded historical window itself completed.");
  assert.equal(Date.parse(f.connection().completedThrough), Date.parse(initiallyCompleted) + 60 * 60000);
  assert.ok(Date.parse(f.now()) - Date.parse(f.connection().completedThrough) > 5 * 60000);
  assert.equal(f.connection().health, "degraded");
  assert.equal(f.source().health.state, "degraded");
  assert.ok(JSON.stringify(f.runtime.readPage("/sources", {})).includes('"label":"degraded"'), "The Sources board must not turn green while coverage remains an hour behind.");
  assert.equal(f.runtime.store.stats().records, 0);
  await f.reopen();
  assert.equal(f.source().health.state, "degraded");
  f.advance(5000); f.sentry(); await f.monitoring.runOnce();
  assert.equal(f.connection().health, "healthy");
  assert.equal(f.source().health.state, "healthy");
  assert.equal(f.runtime.store.stats().records, 0);
});
