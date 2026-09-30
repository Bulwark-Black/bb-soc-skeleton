"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { startPrivateApplication } = require("../server/private-application");

const BASE = "/api/v1/monitoring";
const TOKEN = "synthetic" + "-sentry-read-token-not-live";
const SLACK_ORIGIN = "https://" + ["hooks", "slack", "com"].join(".");
const WEBHOOK = SLACK_ORIGIN + ["", "services", "TSYNTHETIC", "BSYNTHETIC", "synthetic-webhook-not-live"].join("/");
const PRIVATE_MARKER = "synthetic-raw-event-must-not-be-retained";

async function fixture(t, { quiet = false, slack = true } = {}) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "bb-soc-live-http-"));
  let currentTime = Date.now(), app, cookie = "", serial = 0, sentryStatus = 200, slackStatus = 200;
  const clock = () => new Date(currentTime), calls = [];
  let events = quiet ? [] : [{ eventID: "a".repeat(32), dateCreated: new Date(currentTime - 60000).toISOString(), "event.type": "error",
    projectID: "456", groupID: "123", platform: "javascript", tags: [{ key: "level", value: "fatal" }],
    title: PRIVATE_MARKER, message: PRIVATE_MARKER, user: { email: PRIVATE_MARKER }, request: { headers: { Authorization: PRIVATE_MARKER } } }];
  const fetchImpl = async (input, init) => {
    const url = new URL(input); calls.push({ url: url.href, method: init.method, authorization: init.headers.Authorization, body: init.body });
    if (url.origin === SLACK_ORIGIN) return new Response(slackStatus === 200 ? "ok" : PRIVATE_MARKER, { status: slackStatus });
    assert.equal(url.origin, "https://us.sentry.io", "no arbitrary outbound destinations");
    assert.equal(url.pathname, "/api/0/projects/synthetic-org/synthetic-app/events/");
    currentTime += 25; // Completion/admission is later than request start, as on a real network.
    const previous = new URL(url), next = new URL(url);
    previous.searchParams.set("cursor", "0:0:1"); next.searchParams.set("cursor", "0:100:0");
    return new Response(sentryStatus === 200 ? JSON.stringify(events) : PRIVATE_MARKER, { status: sentryStatus,
      headers: { "content-type": "application/json", link: `<${previous.href}>; rel="previous"; results="false"; cursor="0:0:1", <${next.href}>; rel="next"; results="false"; cursor="0:100:0"` } });
  };
  const start = async port => {
    app = await startPrivateApplication({ stateDirectory: directory, port, monitoring: { fetchImpl, autoStart: false, clock } });
    // Use one deterministic clock for admission and collection; browser auth
    // keeps its real clock. This prevents tests from sleeping for poll windows.
    app.runtime.clock = clock;
  };
  await start(0);
  t.after(async () => { if (app) await app.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const password = crypto.randomBytes(30).toString("base64url");
  await app.authentication.createOperator({ email: "monitor-owner@example.invalid", name: "Monitoring operator", password });
  const request = (endpoint, { body, method = body === undefined ? "GET" : "POST", anonymous = false, headers = {} } = {}) => fetch(app.url + endpoint, {
    method, headers: { Connection: "close", Origin: app.url, ...(cookie && !anonymous ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) })
  });
  const expect = async (pending, status) => {
    const response = await pending, body = await response.json();
    assert.equal(response.status, status, JSON.stringify(body));
    for (const value of [TOKEN, WEBHOOK, PRIVATE_MARKER]) assert.equal(JSON.stringify(body).includes(value), false, "HTTP response must not reflect credential/raw-event material");
    return body;
  };
  const login = async () => {
    const response = await request("/api/auth/sign-in/email", { body: { email: "monitor-owner@example.invalid", password } });
    assert.equal(response.status, 200); cookie = response.headers.getSetCookie().map(item => item.split(";")[0]).join("; "); await response.arrayBuffer();
  };
  const command = async (command, input) => {
    const result = await expect(request("/api/v1/control/commands", { body: { schemaVersion: "1", documentType: "connector-command-request",
      requestId: "monitor-http-command-" + (++serial), command, requestedAt: clock().toISOString(), input } }), 200);
    assert.equal(result.status, "succeeded", JSON.stringify(result)); return result.output;
  };
  const register = () => command("app.register", { displayName: "Synthetic web application", environments: ["test"], publicPages: [] });
  const connectionBody = appId => ({ appId, environment: "test", displayName: "Synthetic application errors", region: "us", organization: "synthetic-org", project: "synthetic-app",
    token: TOKEN, ...(slack ? { slackWebhook: WEBHOOK } : {}) });
  const list = () => expect(request(BASE), 200);
  const change = (connection, action, body = {}) => expect(request(BASE + "/connections/" + connection.id + "/" + action,
    { body: { expectedRevision: connection.revision, ...body } }), 200);
  return { get app() { return app; }, directory, request, expect, login, command, register, connectionBody, list, change, calls,
    setEvents(value) { events = value; }, setSentryStatus(value) { sentryStatus = value; }, setSlackStatus(value) { slackStatus = value; },
    advance(ms) { currentTime += ms; }, async restart() { const port = Number(new URL(app.url).port); await app.close(); app = null; await start(port); } };
}

test("private monitoring connects through a session, retains only canonical evidence, notifies and resumes after restart", async t => {
  const f = await fixture(t);
  await f.expect(f.request(BASE), 401); await f.expect(f.request(BASE + "/connections", { body: {} }), 401);
  await f.login(); assert.equal((await f.list()).connections.length, 0);
  const application = await f.register();
  const created = await f.expect(f.request(BASE + "/connections", { body: f.connectionBody(application.appId) }), 201);
  assert.equal(created.connection.health, "starting"); assert.equal(created.connection.hasSlack, true); assert.ok(created.connection.sourceId);
  assert.equal(f.calls.length, 1, "connection testing only reads Sentry; it does not send Slack");
  assert.equal(f.app.runtime.store.stats().records, 0, "connection testing stages data but does not manufacture ingestion");
  const activated = f.app.runtime.controlState().sources.find(source => source.sourceId === created.connection.sourceId);
  assert.equal(activated.state, "active"); assert.equal(activated.health.lastSuccessAt, null);
  await f.app.monitoring.runOnce();
  const first = await f.list(), connection = first.connections[0];
  assert.equal(connection.health, "healthy"); assert.equal(connection.lastError, null); assert.equal(connection.totalEvents, 1);
  assert.ok(connection.completedThrough); assert.equal(connection.pendingWindow, null); assert.equal(first.alerts.length, 1);
  const alert = first.alerts[0]; assert.equal(alert.kind, "application-errors"); assert.equal(alert.deliveryState, "delivered");
  assert.match(alert.body, /not a security verdict/); assert.ok(alert.evidence.recordId);
  const observations = await f.expect(f.request("/api/v1/integrations/observations?sourceId=" + connection.sourceId), 200);
  assert.equal(observations.records.length, 1); assert.equal(observations.records[0].kind, "log.event");
  assert.equal(observations.records[0].estateId, application.appId); assert.equal(observations.records[0].recordId, alert.evidence.recordId);
  const healthy = f.app.runtime.controlState().sources.find(source => source.sourceId === connection.sourceId);
  assert.equal(healthy.health.state, "healthy"); assert.equal(healthy.health.counters.acceptedRecords, 1);
  const slackCalls = f.calls.filter(call => call.url.startsWith(SLACK_ORIGIN + "/"));
  assert.equal(slackCalls.length, 1); assert.ok(slackCalls[0].body.includes(alert.evidence.recordId));
  assert.ok(!slackCalls[0].body.includes(PRIVATE_MARKER)); assert.ok(!slackCalls[0].body.includes(TOKEN));
  await f.expect(f.request(BASE + "/alerts/" + alert.id + "/ack", { body: {} }), 200);
  const key = fs.readFileSync(path.join(f.directory, "live-monitoring.key"));
  for (const filename of fs.readdirSync(f.directory)) {
    const pathname = path.join(f.directory, filename);
    if (fs.statSync(pathname).isFile()) {
      const bytes = fs.readFileSync(pathname);
      for (const value of [TOKEN, WEBHOOK, PRIVATE_MARKER]) assert.equal(bytes.includes(Buffer.from(value)), false, "secrets and raw events must not be stored in plaintext");
    }
  }
  await f.restart();
  assert.deepEqual(fs.readFileSync(path.join(f.directory, "live-monitoring.key")), key);
  const restored = await f.list(); // Existing human session survives restart.
  assert.equal(restored.connections[0].id, connection.id); assert.ok(restored.alerts[0].acknowledgedAt);
  f.advance(61000); await f.app.monitoring.runOnce();
  const repeated = await f.list(); assert.equal(repeated.connections[0].health, "healthy"); assert.equal(repeated.connections[0].totalEvents, 1);
  assert.equal(repeated.alerts.length, 1); assert.equal(f.app.runtime.store.stats().records, 1);
  assert.equal(f.calls.filter(call => call.url.startsWith(SLACK_ORIGIN + "/")).length, 1, "overlap/restart must not repeat the event notification");
  assert.equal(f.calls.at(-1).authorization, "Bearer " + TOKEN, "encrypted token is available after restart");
});

test("quiet polls establish real health without observations and failures remain visible until a successful recovery", async t => {
  const f = await fixture(t, { quiet: true, slack: false }); await f.login();
  const application = await f.register();
  await f.expect(f.request(BASE + "/connections", { body: f.connectionBody(application.appId) }), 201);
  await f.app.monitoring.runOnce();
  let state = await f.list(); assert.equal(state.connections[0].health, "healthy"); assert.equal(state.connections[0].totalEvents, 0);
  assert.equal(state.alerts.length, 0); assert.equal(f.app.runtime.store.stats().records, 0);
  const sourceId = state.connections[0].sourceId;
  assert.equal(f.app.runtime.controlState().sources.find(source => source.sourceId === sourceId).health.state, "healthy");
  f.advance(61000); f.setSentryStatus(401); await f.app.monitoring.runOnce();
  state = await f.list(); assert.equal(state.connections[0].health, "degraded"); assert.match(state.connections[0].lastError, /denied access/);
  assert.equal(state.alerts[0].kind, "collection-failed"); assert.equal(state.alerts[0].deliveryState, "in-app");
  const through = state.connections[0].completedThrough;
  await f.app.monitoring.runOnce(); assert.equal((await f.list()).connections[0].completedThrough, through, "scheduled backoff does not skip failed data");
  f.advance(61000); f.setSentryStatus(200); await f.app.monitoring.runOnce();
  state = await f.list(); assert.equal(state.connections[0].health, "healthy"); assert.equal(state.connections[0].lastError, null);
  assert.ok(state.alerts.some(alert => alert.kind === "collection-recovered")); assert.equal(f.app.runtime.store.stats().records, 0);
  f.advance(6 * 60000); assert.equal((await f.list()).connections[0].health, "offline", "quiet does not hide a stopped scheduler");
});

test("monitoring mutations require human authority, valid registered scope and fixed outbound destinations", async t => {
  const f = await fixture(t, { quiet: true }); await f.login(); const application = await f.register();
  const body = f.connectionBody(application.appId), service = await f.expect(f.request("/api/v1/service-access", { body: { name: "Synthetic monitoring client" } }), 201);
  for (const endpoint of [BASE, BASE + "/connections"]) {
    const options = endpoint === BASE ? {} : { body };
    await f.expect(f.request(endpoint, { ...options, anonymous: true }), 401);
    await f.expect(f.request(endpoint, { ...options, headers: { Authorization: "Bearer " + service.oneTimeCredential } }), 401);
    await f.expect(f.request(endpoint, { ...options, anonymous: true, headers: { Authorization: "Bearer " + service.oneTimeCredential } }), 401);
  }
  await f.expect(f.request(BASE + "/connections", { body, headers: { Origin: "https://example.invalid" } }), 403);
  await f.expect(f.request(BASE + "/connections?ignored=1", { body }), 400);
  await f.expect(f.request(BASE + "/connections", { body, method: "PUT" }), 405);
  await f.expect(f.request(BASE + "/connections", { body: "{broken" }), 400);
  await f.expect(f.request(BASE + "/connections", { body, headers: { "Content-Encoding": "gzip" } }), 415);
  for (const mutation of [{ appId: "missing-app" }, { environment: "undeclared" }, { region: "http://127.0.0.1" },
    { project: "../other" }, { slackWebhook: "http://127.0.0.1/private" }, { baseURL: "https://other.example.invalid" }, { token: "short" }]) {
    await f.expect(f.request(BASE + "/connections", { body: { ...body, ...mutation } }), 400);
  }
  assert.equal(f.calls.length, 0, "invalid requests and unauthorized callers cannot trigger outbound traffic");
  f.setSentryStatus(403); await f.expect(f.request(BASE + "/connections", { body }), 422);
  assert.equal((await f.list()).connections.length, 0); assert.equal(f.app.runtime.controlState().sources.length, 0);
  f.setSentryStatus(200); const created = await f.expect(f.request(BASE + "/connections", { body }), 201);
  await f.expect(f.request(BASE + "/connections", { body }), 409);
  const endpoint = BASE + "/connections/" + created.connection.id + "/pause";
  await f.expect(f.request(endpoint, { body: { expectedRevision: 0 } }), 409);
  await f.expect(f.request(endpoint, { body: { expectedRevision: 1 }, headers: { Origin: "https://example.invalid" } }), 403);
  await f.expect(f.request(endpoint, { body: { expectedRevision: 1 }, headers: { Authorization: "Bearer " + service.oneTimeCredential } }), 401);
  assert.equal((await f.list()).connections[0].enabled, true);
});

test("pause, credentials rotation, notification tests and remove remain explicit session operations", async t => {
  const f = await fixture(t, { quiet: true }); await f.login(); const application = await f.register();
  let { connection } = await f.expect(f.request(BASE + "/connections", { body: f.connectionBody(application.appId) }), 201);
  await f.app.monitoring.runOnce(); connection = (await f.list()).connections[0];
  ({ connection } = await f.change(connection, "pause")); assert.equal(connection.health, "paused");
  const before = f.calls.length; f.advance(61000); await f.app.monitoring.runOnce(); assert.equal(f.calls.length, before);
  await f.expect(f.request(BASE + "/connections/" + connection.id + "/poll", { body: { expectedRevision: connection.revision } }), 409);
  ({ connection } = await f.change(connection, "resume"));
  const replacement = "synthetic" + "-rotated-read-only-token-not-live";
  ({ connection } = await f.change(connection, "credentials", { token: replacement }));
  await f.app.monitoring.runOnce(); assert.equal(f.calls.at(-1).authorization, "Bearer " + replacement);
  assert.ok(!JSON.stringify(await f.list()).includes(replacement));
  ({ connection } = await f.change(connection, "test-notification"));
  await f.app.monitoring.runOnce();
  const notified = await f.list(); assert.equal(notified.alerts[0].kind, "notification-test"); assert.equal(notified.alerts[0].deliveryState, "delivered");
  assert.match(notified.alerts[0].body, /does not prove that collection is healthy/);
  const removed = await f.change(connection, "remove"); assert.equal(removed.removed, true); assert.equal((await f.list()).connections.length, 0);
  assert.equal(f.app.runtime.controlState().sources.find(source => source.sourceId === connection.sourceId).state, "archived");
  const requests = f.calls.length; f.advance(61000); await f.app.monitoring.runOnce(); assert.equal(f.calls.length, requests);
  await f.restart(); assert.equal((await f.list()).connections.length, 0); await f.app.monitoring.runOnce(); assert.equal(f.calls.length, requests);
});

test("independent source lifecycle changes cannot be overridden by saved collector credentials or pending pages", async t => {
  for (const action of ["pause", "update"]) {
    const f = await fixture(t, { slack: false }); await f.login(); const application = await f.register();
    const { connection } = await f.expect(f.request(BASE + "/connections", { body: f.connectionBody(application.appId) }), 201);
    const source = () => f.app.runtime.controlState().sources.find(item => item.sourceId === connection.sourceId);
    if (action === "update") await f.app.monitoring.runOnce(); // Exercise both pending and already-admitted pages.
    const input = { sourceId: source().sourceId, connectorInstanceId: source().connectorInstanceId, expectedRevision: source().revision,
      ...(action === "update" ? { displayName: "Explicitly reconfigured by operator", config: { "cadence-seconds": 300 } } : {}) };
    await f.command("source." + action, input);
    const expected = action === "pause" ? "paused" : "configured", admitted = action === "pause" ? 0 : 1;
    const calls = f.calls.length;
    f.advance(61000); await f.app.monitoring.runOnce();
    assert.equal(source().state, expected, "collector cannot override an independent source lifecycle decision");
    assert.equal((await f.list()).connections[0].health, "offline");
    assert.equal(f.app.runtime.store.stats().records, admitted, "pending pages cannot bypass source lifecycle");
    assert.equal(f.calls.length, calls, "an invalidated source must be checked before another outbound read");
    await f.restart(); f.advance(61000); await f.app.monitoring.runOnce();
    assert.equal(source().state, expected, "restart must preserve the independent source invalidation");
  }
});

test("SIGKILL after canonical admission recovers the pending monitoring journal without fetching or duplicating evidence", async t => {
  const { ReferenceControlPlane } = require("../server/reference-runtime");
  const { SqliteTelemetryStore } = require("../server/sqlite-telemetry-store");
  const { createLiveMonitoring } = require("../server/live-monitoring");
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "bb-soc-live-crash-"));
  fs.chmodSync(directory, 0o700);
  const at = "2026-09-29T12:00:00.000Z", observedAt = "2026-09-29T11:59:00.000Z";
  let runtime, monitoring, child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await monitoring?.close(); runtime?.dispose(); fs.rmSync(directory, { recursive: true, force: true });
  });
  // This isolated process is intentionally terminated between the two durable
  // commits. Only its new fixture directory and synthetic event are involved.
  const code = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const { ReferenceControlPlane } = require('./server/reference-runtime');
    const { SqliteTelemetryStore } = require('./server/sqlite-telemetry-store');
    const { createLiveMonitoring } = require('./server/live-monitoring');
    const { operatorId, runAsOperator } = require('./server/operator-context');
    const clock = () => new Date(${JSON.stringify(at)});
    const directory = process.argv[1];
    const runtime = new ReferenceControlPlane({ clock, store: new SqliteTelemetryStore({ directory, clock }),
      enabledConnectorTypes: ['canonical-push', 'canonical-events', 'trivy-report'] });
    const registered = runAsOperator('synthetic-crash-owner', () => runtime.execute({ schemaVersion: '1',
      documentType: 'connector-command-request', requestId: 'synthetic-crash-register', requestedAt: clock().toISOString(),
      command: 'app.register', input: { displayName: 'Synthetic crash application', environments: ['test'], publicPages: [] } }));
    assert.equal(registered.status, 'succeeded');
    let requests = 0;
    const fetchImpl = async url => {
      requests += 1; assert.equal(requests, 1, 'Only onboarding may read the mock vendor');
      const next = new URL(url); assert.equal(next.hostname, 'us.sentry.io'); next.searchParams.set('cursor', '0:100:0');
      const event = { eventID: 'c'.repeat(32), dateCreated: ${JSON.stringify(observedAt)}, type: 'error', platform: 'node', level: 'error' };
      return new Response(JSON.stringify([event]), { headers: { 'content-type': 'application/json',
        link: '<' + next.href + '>; rel="next"; results="false"; cursor="0:100:0"' } });
    };
    const monitoring = createLiveMonitoring({ stateDir: directory, runtime, clock, fetchImpl, autoStart: false });
    (async () => {
      await monitoring.connect({ appId: registered.output.appId, environment: 'test', displayName: 'Synthetic crash monitor',
        region: 'us', organization: 'synthetic-org', project: 'synthetic-project', token: 'synthetic' + '-crash-read-token-not-live' },
        operatorId('synthetic-crash-owner'));
      assert.equal(runtime.store.stats().records, 0);
      const admit = runtime.ingestVendorAsOperator.bind(runtime);
      runtime.ingestVendorAsOperator = (...args) => {
        const receipt = admit(...args);
        assert.equal(receipt.accepted, 1);
        assert.equal(runtime.store.stats().records, 1);
        assert.equal(monitoring.list().alerts.length, 0);
        fs.writeSync(1, 'ADMITTED_BEFORE_CHECKPOINT\\n');
        process.kill(process.pid, 'SIGKILL');
        throw new Error('SIGKILL did not terminate the isolated fixture');
      };
      await monitoring.runOnce();
      process.exitCode = 2;
    })().catch(() => { process.exitCode = 3; });
  `;
  child = spawn(process.execPath, ["-e", code, directory], { cwd: path.resolve(__dirname, ".."), stdio: ["ignore", "pipe", "pipe"] });
  let output = "", stderr = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exit = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Isolated monitoring crash fixture timed out.")); }, 10000);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(timeout); resolve({ code, signal }); });
  });
  assert.deepEqual(exit, { code: null, signal: "SIGKILL" }, stderr);
  assert.match(output, /ADMITTED_BEFORE_CHECKPOINT/);
  assert.throws(() => new SqliteTelemetryStore({ directory }), /already in use/);
  const lock = path.join(directory, "runtime.lock");
  assert.equal(fs.readFileSync(lock, "utf8").trim(), String(child.pid));
  assert.throws(() => process.kill(child.pid, 0), error => error.code === "ESRCH");
  fs.unlinkSync(lock); // Exact fixture PID is confirmed dead; not automatic recovery of arbitrary locks.
  const clock = () => new Date(at);
  let outbound = 0;
  const open = () => {
    runtime = new ReferenceControlPlane({ clock, store: new SqliteTelemetryStore({ directory, clock }),
      enabledConnectorTypes: ["canonical-push", "canonical-events", "trivy-report"] });
    monitoring = createLiveMonitoring({ stateDir: directory, runtime, clock, autoStart: false,
      fetchImpl: async () => { outbound += 1; throw new Error("Recovery must reuse the saved pending canonical page."); } });
  };
  open();
  assert.equal(runtime.store.stats().records, 1); assert.equal(runtime.store.stats().receipts, 1);
  const before = monitoring.list(); assert.equal(before.alerts.length, 0); assert.ok(before.connections[0].pendingWindow);
  await monitoring.runOnce();
  const recovered = monitoring.list(), records = runtime.store.queryObservations().records;
  assert.equal(outbound, 0); assert.equal(records.length, 1); assert.equal(records[0].observedAt, observedAt);
  assert.equal(runtime.store.stats().receipts, 1, "pending replay uses the original receipt identity");
  assert.equal(recovered.connections[0].health, "healthy"); assert.equal(recovered.connections[0].totalEvents, 1);
  assert.equal(recovered.connections[0].pendingWindow, null); assert.equal(recovered.alerts.length, 1);
  assert.equal(recovered.alerts[0].evidence.recordId, records[0].recordId);
  assert.equal(recovered.alerts[0].evidence.observedAt, observedAt); assert.equal(recovered.alerts[0].deliveryState, "in-app");
  await monitoring.close(); runtime.dispose(); open();
  await monitoring.runOnce();
  assert.equal(outbound, 0); assert.equal(runtime.store.stats().records, 1); assert.equal(runtime.store.stats().receipts, 1);
  assert.deepEqual(monitoring.list().alerts, recovered.alerts, "a second reopen cannot duplicate the recovered alert");
  assert.equal(monitoring.list().connections[0].totalEvents, 1);
});
