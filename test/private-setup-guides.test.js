"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startPrivateApplication } = require("../server/private-application");

const BASE = "/api/v1/setup";
const SENTRY_TOKEN = "synthetic" + "-setup-guide-token-not-live";
const SLACK_ORIGIN = "https://" + ["hooks", "slack", "com"].join(".");
const SLACK_WEBHOOK = SLACK_ORIGIN + ["", "services", "TSYNTHETIC", "BSYNTHETIC", "synthetic-setup-guide-not-live"].join("/");

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "bb-soc-setup-http-"));
  let app, cookie = "", serial = 0, currentTime = Date.now();
  const calls = [], clock = () => new Date(currentTime);
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    calls.push({ url: url.href, method: init.method });
    if (url.origin === SLACK_ORIGIN) return new Response("ok");
    assert.equal(url.origin, "https://us.sentry.io", "tests never contact a real vendor or arbitrary destination");
    assert.equal(url.pathname, "/api/0/projects/synthetic-org/synthetic-project/events/");
    url.searchParams.set("cursor", "0:100:0");
    return new Response("[]", { headers: { "content-type": "application/json",
      link: `<${url.href}>; rel="next"; results="false"; cursor="0:100:0"` } });
  };
  const start = async port => {
    app = await startPrivateApplication({ stateDirectory: directory, port, monitoring: { fetchImpl, clock, autoStart: false } });
    app.runtime.clock = clock;
  };
  await start(0);
  t.after(async () => { if (app) await app.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const password = crypto.randomBytes(30).toString("base64url");
  await app.authentication.createOperator({ email: "setup-owner@example.invalid", name: "Synthetic setup operator", password });
  const request = (endpoint, { body, method = body === undefined ? "GET" : "POST", anonymous = false, headers = {} } = {}) => fetch(app.url + endpoint, {
    method, headers: { Connection: "close", Origin: app.url, ...(cookie && !anonymous ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) })
  });
  const expect = async (pending, status) => {
    const response = await pending, body = await response.json();
    assert.equal(response.status, status, JSON.stringify(body));
    for (const value of [password, SENTRY_TOKEN, SLACK_WEBHOOK]) {
      assert.equal(JSON.stringify(body).includes(value), false, "setup HTTP output must not disclose secret material");
    }
    return body;
  };
  const login = async () => {
    const response = await request("/api/auth/sign-in/email", { body: { email: "setup-owner@example.invalid", password } });
    assert.equal(response.status, 200);
    cookie = response.headers.getSetCookie().map(item => item.split(";")[0]).join("; ");
    await response.arrayBuffer();
  };
  const command = async (command, input) => {
    const result = await expect(request("/api/v1/control/commands", { body: { schemaVersion: "1", documentType: "connector-command-request",
      requestId: "setup-http-command-" + (++serial), command, requestedAt: clock().toISOString(), input } }), 200);
    assert.equal(result.status, "succeeded", JSON.stringify(result));
    return result.output;
  };
  const register = (displayName = "Synthetic guided web application", environments = ["test", "staging"]) => command("app.register", { displayName, environments, publicPages: [] });
  const source = (application, environment = "test") => command("source.setup", { appId: application.appId, environment,
    connectorType: "canonical-events", sourceKind: "log.event", displayName: "Synthetic custom application feed",
    config: { "cadence-seconds": 300 }, credentialReferences: [] });
  const scope = item => {
    const current = app.runtime.controlState().sources.find(source => source.sourceId === item.sourceId);
    return { sourceId: current.sourceId, connectorInstanceId: current.connectorInstanceId, expectedRevision: current.revision };
  };
  return { get app() { return app; }, directory, request, expect, login, command, register, source, scope, clock, calls,
    advance(ms) { currentTime += ms; }, async restart() { const port = Number(new URL(app.url).port); await app.close(); app = null; await start(port); } };
}

function checkPath(application, pathName = "custom", sourceId, environment = "test") {
  const query = new URLSearchParams({ appId: application.appId, environment, path: pathName });
  if (sourceId) query.set("sourceId", sourceId);
  return BASE + "/check?" + query;
}

function checkState(report, id) {
  const check = report.checks.find(item => item.id === id);
  assert.ok(check, "check must be reported independently: " + id);
  return check.state;
}

test("setup plans and diagnostics require a human session and enforce same-origin, exact HTTP contracts", async t => {
  const f = await fixture(t);
  await f.expect(f.request(BASE), 401);
  await f.expect(f.request(BASE + "/check?appId=missing&environment=test&path=custom"), 401);
  await f.expect(f.request(BASE + "/plans", { body: {} }), 401);
  await f.login();
  const application = await f.register();
  const catalog = await f.expect(f.request(BASE), 200);
  assert.equal(catalog.schemaVersion, "1"); assert.deepEqual(catalog.plans, []);
  const planBody = { expectedRevision: catalog.revision, appId: application.appId, environment: "test", path: "custom" };
  const service = await f.expect(f.request("/api/v1/service-access", { body: { name: "Synthetic setup client" } }), 201);
  for (const [endpoint, options] of [[BASE, {}], [checkPath(application), {}], [BASE + "/plans", { body: planBody }]]) {
    await f.expect(f.request(endpoint, { ...options, anonymous: true }), 401);
    await f.expect(f.request(endpoint, { ...options, headers: { Authorization: "Bearer " + service.oneTimeCredential } }), 401);
    await f.expect(f.request(endpoint, { ...options, anonymous: true, headers: { Authorization: "Bearer " + service.oneTimeCredential } }), 401);
    await f.expect(f.request(endpoint, { ...options, headers: { Origin: "https://example.invalid" } }), 403);
    await f.expect(f.request(endpoint, { ...options, headers: { "Sec-Fetch-Site": "cross-site" } }), 403);
  }
  for (const endpoint of [BASE + "?ignored=1", checkPath(application) + "&appId=" + application.appId,
    checkPath(application) + "&" + new URLSearchParams({ token: SENTRY_TOKEN }), BASE + "/check?appId=" + application.appId]) {
    await f.expect(f.request(endpoint), 400);
  }
  await f.expect(f.request(BASE + "/plans?ignored=1", { body: planBody }), 400);
  await f.expect(f.request(BASE + "/plans", { method: "PUT", body: planBody }), 405);
  await f.expect(f.request(BASE + "/plans", { body: "{broken" }), 400);
  await f.expect(f.request(BASE + "/plans", { body: planBody, headers: { "Content-Encoding": "gzip" } }), 415);
  for (const change of [{ token: SENTRY_TOKEN }, { slackWebhook: SLACK_WEBHOOK }, { expectedRevision: "0" },
    { appId: "missing-application" }, { environment: "undeclared" }, { path: "unknown" }]) {
    await f.expect(f.request(BASE + "/plans", { body: { ...planBody, ...change } }), 400);
  }
  assert.equal((await f.expect(f.request(BASE), 200)).plans.length, 0);
  assert.equal(f.calls.length, 0, "rejected setup requests must never make vendor calls");
  assert.equal(f.app.runtime.store.stats().records, 0);
});

test("saved guides enforce source scope and revision conflicts, survive restart and remove only the guide", async t => {
  const f = await fixture(t); await f.login();
  const application = await f.register(), other = await f.register("Other synthetic application");
  const source = await f.source(application), otherSource = await f.source(other), stagingSource = await f.source(application, "staging");
  let catalog = await f.expect(f.request(BASE), 200);
  const body = { expectedRevision: catalog.revision, appId: application.appId, environment: "test", path: "custom" };
  for (const sourceId of [otherSource.sourceId, stagingSource.sourceId, "missing-source"]) {
    await f.expect(f.request(BASE + "/plans", { body: { ...body, sourceId } }), 400);
    await f.expect(f.request(checkPath(application, "custom", sourceId)), 400);
  }
  await f.expect(f.request(checkPath(application, "live", source.sourceId)), 400);
  await f.expect(f.request(checkPath(application, "vendor", source.sourceId)), 400);
  await f.expect(f.request(checkPath(application, "trivy", source.sourceId)), 400);
  let saved = await f.expect(f.request(BASE + "/plans", { body }), 201);
  assert.equal(saved.plan.appId, application.appId); assert.equal(saved.plan.environment, "test");
  assert.equal(saved.plan.path, "custom"); assert.equal(saved.plan.sourceId, null);
  const id = saved.plan.id, endpoint = BASE + "/plans/" + id;
  await f.expect(f.request(BASE + "/plans", { body: { ...body, expectedRevision: saved.revision } }), 409);
  await f.expect(f.request(endpoint, { method: "PATCH", body: { expectedRevision: body.expectedRevision, sourceId: source.sourceId } }), 409);
  await f.expect(f.request(endpoint, { method: "PATCH", body: { expectedRevision: saved.revision, sourceId: otherSource.sourceId } }), 400);
  saved = await f.expect(f.request(endpoint, { method: "PATCH", body: { expectedRevision: saved.revision, sourceId: source.sourceId } }), 200);
  assert.equal(saved.plan.sourceId, source.sourceId);
  const sourceRevision = f.scope(source).expectedRevision, telemetryBefore = f.app.runtime.store.stats();
  await f.restart();
  catalog = await f.expect(f.request(BASE), 200);
  assert.equal(catalog.revision, saved.revision);
  assert.deepEqual(catalog.plans.find(item => item.id === id), saved.plan);
  assert.ok(catalog.choices.some(item => item.sourceId === source.sourceId && item.appId === application.appId && item.environment === "test" && item.path === "custom"));
  assert.equal(f.calls.length, 0, "saved guides cannot start collectors or probe upstream credentials");
  await f.expect(f.request(endpoint, { method: "DELETE", body: { expectedRevision: saved.revision - 1 } }), 409);
  const removed = await f.expect(f.request(endpoint, { method: "DELETE", body: { expectedRevision: saved.revision } }), 200);
  assert.equal(removed.removed, true);
  assert.deepEqual((await f.expect(f.request(BASE), 200)).plans, []);
  assert.equal(f.scope(source).expectedRevision, sourceRevision, "removing a saved guide does not remove or update its source");
  assert.equal(f.app.runtime.store.stats().records, telemetryBefore.records);
});

test("custom-source diagnostics distinguish configured, validated, active and genuinely received evidence without causing writes", async t => {
  const f = await fixture(t); await f.login();
  const application = await f.register();
  const waiting = await f.expect(f.request(checkPath(application)), 200);
  assert.equal(waiting.sourceId, null); assert.equal(checkState(waiting, "admission"), "waiting");
  const source = await f.source(application), endpoint = checkPath(application, "custom", source.sourceId);
  let report = await f.expect(f.request(endpoint), 200);
  assert.equal(checkState(report, "binding"), "pass");
  assert.notEqual(checkState(report, "activation"), "pass");
  assert.equal(checkState(report, "admission"), "waiting");
  for (const check of report.checks.filter(item => item.href)) {
    assert.match(check.href, /^#\/(?:sources|onboard|scans)(?:\?|$)/, "diagnostic recovery links must target implemented routes");
  }
  const record = { schemaVersion: "1", documentType: "normalized-record", recordId: "synthetic-guided-log-1", sourceId: source.sourceId,
    estateId: application.appId, kind: "log.event", observedAt: f.clock().toISOString(),
    payload: { title: "Synthetic application evidence", state: "unknown", category: "application", message: "Synthetic application record used only in an isolated test" } };
  await f.command("source.test", { ...f.scope(source), recordSample: record });
  report = await f.expect(f.request(endpoint), 200);
  assert.equal(checkState(report, "admission"), "waiting", "a validation sample is not collected telemetry");
  const active = await f.command("source.activate", f.scope(source));
  await f.expect(f.request(endpoint, { anonymous: true, headers: { Authorization: "Bearer " + active.oneTimeCredential.value } }), 401);
  report = await f.expect(f.request(endpoint), 200);
  assert.equal(checkState(report, "activation"), "pass");
  assert.equal(checkState(report, "admission"), "waiting", "activation alone cannot prove data arrived");
  assert.notEqual(checkState(report, "collection"), "pass", "custom push does not prove an upstream scheduled collector exists");
  const batch = { schemaVersion: "1", documentType: "ingest-batch", sourceId: source.sourceId,
    receiptId: "synthetic-guided-receipt-1", sentAt: f.clock().toISOString(), records: [record] };
  const receipt = await f.expect(f.request("/api/v1/ingest", { body: batch, anonymous: true,
    headers: { Authorization: "Bearer " + active.oneTimeCredential.value } }), 200);
  assert.equal(receipt.accepted, 1);
  const stats = f.app.runtime.store.stats(), control = f.app.runtime.controlState(), calls = f.calls.length;
  report = await f.expect(f.request(endpoint), 200);
  assert.equal(checkState(report, "admission"), "pass");
  assert.equal(checkState(report, "projection"), "pass");
  assert.notEqual(checkState(report, "notification-provider"), "pass");
  assert.notEqual(checkState(report, "notification-human"), "pass");
  assert.ok(report.destinations.some(destination => destination.href.includes("/sources") && destination.href.includes(source.sourceId)));
  for (const destination of report.destinations) assert.match(destination.href, /^#\//, "setup destinations must stay inside this application");
  const page = await f.expect(f.request("/api/v1/pages?route=%2Fsources&stab=observations&sourceId=" + source.sourceId), 200);
  assert.equal(page.state, "ready");
  assert.match(JSON.stringify(page), /Synthetic application evidence/, "the actual source-scoped screen exposes admitted evidence");
  for (let i = 0; i < 3; i += 1) await f.expect(f.request(endpoint), 200);
  assert.deepEqual(f.app.runtime.store.stats(), stats, "read-only setup checks do not commit telemetry, receipts or audit");
  assert.deepEqual(f.app.runtime.controlState(), control, "read-only setup checks do not change source lifecycles or health");
  assert.equal(f.calls.length, calls);
  assert.equal(JSON.stringify(report).includes(active.oneTimeCredential.value), false);
  await f.command("source.pause", f.scope(source));
  report = await f.expect(f.request(endpoint), 200);
  assert.notEqual(checkState(report, "activation"), "pass", "historical accepted records do not hide a now-paused source");
  assert.equal(checkState(report, "admission"), "pass", "retained history remains valid evidence after pause");
});

test("live setup checks observe collection and delivery separately without polling, sending Slack, or manufacturing records", async t => {
  const f = await fixture(t); await f.login();
  const application = await f.register();
  const created = await f.expect(f.request("/api/v1/monitoring/connections", { body: { appId: application.appId, environment: "test",
    displayName: "Synthetic guided live source", region: "us", organization: "synthetic-org", project: "synthetic-project",
    token: SENTRY_TOKEN, slackWebhook: SLACK_WEBHOOK } }), 201);
  const endpoint = checkPath(application, "live", created.connection.sourceId);
  let report = await f.expect(f.request(endpoint), 200);
  assert.equal(checkState(report, "admission"), "waiting");
  assert.notEqual(checkState(report, "collection"), "pass", "a connection-access test does not prove a committed collection window");
  assert.notEqual(checkState(report, "notification-provider"), "pass", "configuring a webhook does not prove delivery");
  assert.equal(f.calls.length, 1, "diagnostics did not run another access check or send a notification");
  await f.app.monitoring.runOnce();
  report = await f.expect(f.request(endpoint), 200);
  assert.equal(checkState(report, "collection"), "pass", "a genuinely quiet successful window proves collection, not admission");
  assert.equal(checkState(report, "admission"), "waiting");
  assert.notEqual(checkState(report, "projection"), "pass");
  assert.notEqual(checkState(report, "notification-provider"), "pass");
  const monitor = await f.expect(f.request("/api/v1/monitoring"), 200), stats = f.app.runtime.store.stats(), calls = f.calls.length;
  for (let i = 0; i < 3; i += 1) await f.expect(f.request(endpoint), 200);
  assert.equal(f.calls.length, calls); assert.deepEqual(f.app.runtime.store.stats(), stats);
  assert.deepEqual(await f.expect(f.request("/api/v1/monitoring"), 200), monitor);
  const connection = monitor.connections[0];
  await f.expect(f.request("/api/v1/monitoring/connections/" + connection.id + "/test-notification", { body: { expectedRevision: connection.revision } }), 200);
  await f.app.monitoring.runOnce();
  report = await f.expect(f.request(endpoint), 200);
  assert.equal(checkState(report, "notification-provider"), "pass");
  assert.notEqual(checkState(report, "notification-human"), "pass", "Slack accepting a webhook cannot prove a person saw it");
  assert.equal(f.app.runtime.store.stats().records, 0, "notification tests do not fabricate application evidence");
  assert.equal(f.calls.filter(item => item.url.startsWith(SLACK_ORIGIN + "/")).length, 1);
});

test("private mapping requires a session and previews only correctly bound real sources without ingesting or retaining raw input", async t => {
  const f = await fixture(t), base = "/api/v1/source-mapping";
  await f.expect(f.request(base), 401);
  await f.expect(f.request(base + "/inspect", { body: { text: "{}" } }), 401);
  await f.expect(f.request(base + "/preview", { body: {} }), 401);
  await f.login();
  const application = await f.register(), other = await f.register("Other synthetic mapping application");
  const source = await f.source(application), foreignSource = await f.source(other);
  const secretFreeMarker = "synthetic-unselected-value-must-not-be-retained";
  const record = { event: { id: "synthetic-map-event", time: f.clock().toISOString(), title: "Synthetic mapped log", message: "Synthetic redacted event" }, ignored: secretFreeMarker };
  const recipe = { schemaVersion: "1", documentType: "source-mapping-recipe", appId: application.appId, environment: "test", sourceId: source.sourceId,
    kind: "log.event", upstreamId: { path: "/event/id" }, observedAt: { path: "/event/time" },
    payload: { title: { path: "/event/title" }, state: { value: "unknown" }, message: { path: "/event/message" } } };
  const body = { appId: application.appId, environment: "test", sourceId: source.sourceId, text: JSON.stringify(record), recipe };
  const service = await f.expect(f.request("/api/v1/service-access", { body: { name: "Synthetic mapper client" } }), 201);
  for (const [endpoint, options] of [[base, {}], [base + "/inspect", { body: { text: body.text } }], [base + "/preview", { body }]]) {
    await f.expect(f.request(endpoint, { ...options, anonymous: true, headers: { Authorization: "Bearer " + service.oneTimeCredential } }), 401);
    await f.expect(f.request(endpoint, { ...options, headers: { Authorization: "Bearer " + service.oneTimeCredential } }), 401);
    await f.expect(f.request(endpoint, { ...options, headers: { Origin: "https://example.invalid" } }), 403);
  }
  const before = f.app.runtime.controlState(), stats = f.app.runtime.store.stats(), governance = f.app.administrationRuntime.getState();
  const catalog = await f.expect(f.request(base), 200);
  assert.ok(catalog.sources.some(item => item.sourceId === source.sourceId && item.appId === application.appId));
  const inspected = await f.expect(f.request(base + "/inspect", { body: { text: body.text } }), 200);
  assert.equal(inspected.records, 1); assert.ok(inspected.fields.some(item => item.path === "/event/id"));
  assert.equal(JSON.stringify(inspected).includes(secretFreeMarker), false); assert.equal(JSON.stringify(inspected).includes(record.event.message), false);
  const preview = await f.expect(f.request(base + "/preview", { body }), 200);
  assert.equal(preview.summary.imported, false); assert.equal(preview.summary.rawInputPersisted, false);
  assert.equal(preview.batch.records.length, 1); assert.equal(preview.batch.records[0].sourceId, source.sourceId);
  assert.equal(preview.batch.records[0].estateId, application.appId); assert.equal(preview.batch.records[0].observedAt, record.event.time);
  assert.equal(preview.batch.records[0].payload.message, record.event.message); assert.equal(JSON.stringify(preview).includes(secretFreeMarker), false);
  for (const change of [{ appId: other.appId }, { sourceId: foreignSource.sourceId }, { environment: "staging" }, { sourceId: "missing-source" },
    { recipe: { ...recipe, sourceId: foreignSource.sourceId } }, { module: "not-executable" }]) {
    await f.expect(f.request(base + "/preview", { body: { ...body, ...change } }), 400);
  }
  await f.expect(f.request(base + "?ignored=1"), 400);
  await f.expect(f.request(base + "/preview"), 405);
  await f.expect(f.request(base + "/inspect", { body: "{broken" }), 400);
  await f.expect(f.request(base + "/preview", { body, headers: { "Content-Encoding": "gzip" } }), 415);
  assert.deepEqual(f.app.runtime.controlState(), before); assert.deepEqual(f.app.runtime.store.stats(), stats);
  assert.deepEqual(f.app.administrationRuntime.getState(), governance); assert.equal(f.calls.length, 0);
  for (const filename of fs.readdirSync(f.directory)) {
    const file = path.join(f.directory, filename);
    if (fs.statSync(file).isFile()) assert.equal(fs.readFileSync(file).includes(Buffer.from(secretFreeMarker)), false, "mapping cannot retain raw sample values in any private state file");
  }
});

test("screen and operations assistance are authenticated read-only snapshots with strict scope and honest manual checks", async t => {
  const f = await fixture(t), base = "/api/v1/setup-assistance";
  for (const endpoint of [base + "/screen?route=%2Flogs", base + "/operations"]) await f.expect(f.request(endpoint), 401);
  await f.login();
  const application = await f.register(), other = await f.register("Other synthetic assistance application"), source = await f.source(application);
  const service = await f.expect(f.request("/api/v1/service-access", { body: { name: "Synthetic assistance client" } }), 201);
  const endpoint = base + "/screen?" + new URLSearchParams({ route: "/logs", appId: application.appId, sourceId: source.sourceId });
  for (const url of [endpoint, base + "/operations"]) {
    await f.expect(f.request(url, { anonymous: true, headers: { Authorization: "Bearer " + service.oneTimeCredential } }), 401);
    await f.expect(f.request(url, { headers: { Authorization: "Bearer " + service.oneTimeCredential } }), 401);
    await f.expect(f.request(url, { headers: { Origin: "https://example.invalid" } }), 403);
    await f.expect(f.request(url.split("?")[0], { body: {} }), 405);
  }
  const before = f.app.runtime.controlState(), stats = f.app.runtime.store.stats(), governance = f.app.administrationRuntime.getState();
  const help = await f.expect(f.request(endpoint), 200);
  assert.equal(help.configuredSources, 1); assert.equal(help.activeSources, 0); assert.equal(help.retainedRecords, 0);
  assert.equal(help.sources[0].sourceId, source.sourceId); assert.match(help.detail, /no matching retained observations/);
  const local = await f.expect(f.request(base + "/screen?route=%2Fdocuments"), 200);
  assert.equal(local.retainedRecords, null); assert.match(local.detail, /locally managed workflow/);
  const operations = await f.expect(f.request(base + "/operations"), 200);
  assert.equal(operations.listener, new URL(f.app.url).hostname); assert.equal(operations.origin, f.app.url);
  for (const id of ["origin", "telemetry", "supervision", "restore"]) assert.equal(operations.checks.find(item => item.id === id).state, "manual");
  assert.match(operations.checks.find(item => item.id === "listener").detail, /remote reachability were not inspected/);
  assert.match(operations.checks.find(item => item.id === "restore").detail, /No backup or restore has been performed/);
  assert.equal(JSON.stringify(operations).includes(f.directory), false, "diagnostics must not expose the private state path");
  for (const suffix of ["/operations?ignored=1", "/screen?route=%2Flogs&route=%2Flogs", "/screen?route=%2Flogs&tab=anything", "/screen?route=%2Fmissing",
    "/screen?route=%2Flogs&sourceId=" + source.sourceId + "&appId=" + other.appId, "/screen?route=%2Flogs&appId=missing-app"]) {
    await f.expect(f.request(base + suffix), 400);
  }
  await f.expect(f.request(base + "/unknown"), 404);
  assert.deepEqual(f.app.runtime.controlState(), before); assert.deepEqual(f.app.runtime.store.stats(), stats);
  assert.deepEqual(f.app.administrationRuntime.getState(), governance); assert.equal(f.calls.length, 0);
});

test("document HTTP writes enforce current references while unchanged historical evidence survives governance removal", async t => {
  const f = await fixture(t); await f.login();
  const application = await f.register(), other = await f.register("Other synthetic evidence application");
  let serial = 0;
  const administer = async (command, input) => {
    const result = await f.expect(f.request("/api/v1/administration/commands", { body: { schemaVersion: "1", documentType: "administration-command-request",
      requestId: "document-guide-admin-" + (++serial), command, requestedAt: new Date().toISOString(), expectedRevision: f.app.administrationRuntime.getState().revision, input } }), 200);
    assert.equal(result.status, "succeeded", JSON.stringify(result)); return result.output;
  };
  const risk = await administer("risk.create", { title: "Synthetic evidence obligation", likelihood: "moderate", impact: "high" });
  const attestation = await administer("attestation.create", { title: "Synthetic evidence attestation" });
  const content = "Synthetic local evidence.\n", body = { title: "Synthetic linked evidence", appId: application.appId, owner: "Synthetic reviewer", status: "draft", reviewAt: "2026-12-01", linkKind: "risk", linkId: risk.riskId };
  const upload = metadata => f.request("/api/v1/documents/upload", { body: content, headers: { "Content-Type": "application/octet-stream",
    "X-Document-Metadata": encodeURIComponent(JSON.stringify({ expectedRevision: 0, filename: "synthetic-evidence.txt", mime: "text/plain", metadata })) } });
  for (const change of [{ appId: "missing-app" }, { linkId: "risk-missing" }, { linkKind: "attestation" }, { appId: "source-not-an-app" }]) {
    await f.expect(upload({ ...body, ...change }), 400);
  }
  assert.equal((await f.expect(f.request("/api/v1/documents"), 200)).total, 0);
  const governanceBefore = f.app.administrationRuntime.getState();
  let doc = await f.expect(upload(body), 201), endpoint = "/api/v1/documents/" + doc.document.id;
  assert.equal(doc.versions[0].sha256, crypto.createHash("sha256").update(content).digest("hex"));
  assert.deepEqual(f.app.administrationRuntime.getState(), governanceBefore, "document evidence never updates compliance status");
  for (const patch of [{ appId: "missing-app" }, { linkId: "risk-missing" }, { linkKind: "attestation" }]) {
    await f.expect(f.request(endpoint, { method: "PATCH", body: { expectedRevision: doc.document.revision, patch } }), 400);
  }
  assert.deepEqual(await f.expect(f.request(endpoint), 200), doc, "refused links leave bytes, version history and metadata unchanged");
  await administer("risk.archive", { riskId: risk.riskId }); await administer("risk.remove", { riskId: risk.riskId });
  doc = await f.expect(f.request(endpoint, { method: "PATCH", body: { expectedRevision: doc.document.revision,
    patch: { ...body, owner: "Updated historical evidence owner" } } }), 200);
  assert.equal(doc.document.linkId, risk.riskId); assert.equal(doc.document.owner, "Updated historical evidence owner");
  doc = await f.expect(f.request("/api/v1/documents/upload", { body: content, headers: { "Content-Type": "application/octet-stream",
    "X-Document-Metadata": encodeURIComponent(JSON.stringify({ documentId: doc.document.id, expectedRevision: doc.document.revision, filename: "synthetic-evidence-v2.txt", mime: "text/plain" })) } }), 201);
  assert.equal(doc.document.versionCount, 2); assert.equal(doc.document.linkId, risk.riskId);
  await f.expect(f.request(endpoint, { method: "PATCH", body: { expectedRevision: doc.document.revision, patch: { appId: other.appId } } }), 400);
  doc = await f.expect(f.request(endpoint, { method: "PATCH", body: { expectedRevision: doc.document.revision,
    patch: { appId: other.appId, linkKind: "attestation", linkId: attestation.attestationId } } }), 200);
  assert.equal(doc.document.appId, other.appId); assert.equal(doc.document.linkId, attestation.attestationId);
  assert.equal(f.app.administrationRuntime.getState().attestations.find(item => item.attestationId === attestation.attestationId).status, "draft");
  await f.restart(); const restored = await f.expect(f.request(endpoint), 200);
  assert.equal(restored.document.linkId, attestation.attestationId); assert.equal(restored.versions.length, 2); assert.equal(f.calls.length, 0);
});
