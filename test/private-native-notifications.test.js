"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { startPrivateApplication } = require("../server/private-application");

test("native notification HTTP controls require operator sessions, retain scoped audit and replay across restart", async t => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "private-notification-test-"));
  const stateDirectory = path.join(directory, "state"), tokenFile = path.join(directory, "provider-token");
  fs.writeFileSync(tokenFile, crypto.randomBytes(24).toString("base64url"), { mode: 0o600 });
  let app, cookie = "", serial = 0;
  const now = Date.now(), calls = [];
  const launch = async port => startPrivateApplication({ stateDirectory, port,
    operations: { now: () => now, minFreeBytes: 0, notificationSend: async request => { calls.push(request); return { status: 200 }; } } });
  app = await launch(0);
  t.after(async () => { await app?.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const email = "operator@example.invalid", password = crypto.randomBytes(30).toString("base64url");
  await app.authentication.createOperator({ name: "Synthetic operator", email, password });
  const request = (url, body, headers = {}, browser = true) => fetch(app.url + url, {
    method: body === undefined ? "GET" : "POST",
    headers: { Connection: "close", ...(browser ? { Origin: app.url, Cookie: cookie } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const expect = async (promise, status = 200) => { const response = await promise, value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value; };
  const signIn = async () => {
    const response = await request("/api/auth/sign-in/email", { email, password });
    assert.equal(response.status, 200); cookie = response.headers.getSetCookie().map(v => v.split(";")[0]).join("; "); await response.arrayBuffer();
  };
  await signIn();
  const command = async (command, input) => {
    const value = await expect(request("/api/v1/control/commands", { schemaVersion: "1", documentType: "connector-command-request",
      requestId: "notification-http-" + (++serial), command, requestedAt: new Date().toISOString(), input }));
    assert.equal(value.status, "succeeded", JSON.stringify(value)); return value.output;
  };
  const application = await command("app.register", { displayName: "Notification fixture", environments: ["test"], publicPages: [] });
  const other = await command("app.register", { displayName: "Other notification application", environments: ["test"], publicPages: [] });
  const source = await command("source.setup", { appId: application.appId, environment: "test", connectorType: "native-monitor", sourceKind: "monitor.batch",
    displayName: "Synthetic collector", config: { "cadence-seconds": 60 }, credentialReferences: [] });
  const revision = () => ({ sourceId: source.sourceId, connectorInstanceId: source.connectorInstanceId,
    expectedRevision: app.runtime.controlState().sources.find(s => s.sourceId === source.sourceId).revision });
  await command("source.test", revision());
  const { oneTimeCredential } = await command("source.activate", revision());
  const config = { schemaVersion: 1, applications: [{ appId: application.appId, hosts: [
    { id: "host-example", appId: application.appId, sourceId: source.sourceId, label: "Synthetic host" },
    { id: "host-other", appId: application.appId, sourceId: "source-other", label: "Other synthetic host" }
  ], notifications: { enabled: true, reviewed: true, from: "monitor@example.invalid", destinations: ["team@example.invalid"], credentialFile: tokenFile } }] };
  fs.writeFileSync(path.join(stateDirectory, "operations-config.json"), JSON.stringify(config), { mode: 0o600 });
  const port = Number(new URL(app.url).port); await app.close(); app = await launch(port); await signIn();
  const op = (suffix, body, extra = "") => request("/api/v1/operations/" + suffix + "?appId=" + application.appId + extra, body);
  const entry = app.operations.instance(application.appId);
  const definition = { id: "operations.notification-fixture", host: "host-example", label: "Synthetic condition", type: "operation", intervalSeconds: 60 };
  entry.store.reconcileOperationalConditions([{ checkId: definition.id, host: definition.host, status: "critical", observedAt: now, summary: "Synthetic failure" }], [definition]);
  await entry.notifications.tick();
  assert.equal(calls.length, 1);
  const status = await expect(op("notifications"));
  assert.equal(status.transport.enabled, true);
  assert.equal(status.attempts[0].state, "needs-reconciliation");
  assert.equal(JSON.stringify(status).includes(tokenFile), false);
  const attempt = status.attempts[0];
  const mutation = { attemptId: attempt.id, expectedRevision: attempt.revision, action: "confirm-accepted",
    providerId: "verified-example", acceptedAt: new Date(now).toISOString(), reason: "Checked synthetic provider record", idempotencyKey: "confirmed" };
  const auth = { Authorization: "Bearer " + oneTimeCredential.value };
  await expect(request("/api/v1/operations/notifications?appId=" + application.appId, undefined, auth, false), 401);
  await expect(request("/api/v1/operations/notifications/reconcile?appId=" + application.appId, mutation, auth, false), 403);
  await expect(request("/api/v1/operations/notifications/reconcile?appId=" + application.appId, mutation, { ...auth, Origin: app.url }, false), 401);
  await expect(op("notifications/reconcile", { ...mutation, actor: "forged" }), 400);
  await expect(op("notifications/reconcile", mutation, "&hosts=host-other"), 403);
  await expect(request("/api/v1/operations/notifications/reconcile?appId=" + other.appId, mutation), 404);
  assert.deepEqual((await expect(request("/api/v1/operations/notifications?appId=" + other.appId))).attempts, []);
  const confirmed = await expect(op("notifications/reconcile", mutation));
  const pause = { paused: true, expectedRevision: status.transport.revision, reason: "Hold future requests for review", idempotencyKey: "pause-example" };
  await expect(op("notifications/pause", pause, "&hosts=host-example"), 400);
  await expect(op("notifications/pause", pause));
  await app.close(); app = await launch(port); await signIn();
  assert.deepEqual(await expect(op("notifications/reconcile", mutation)), confirmed);
  const after = await expect(op("notifications"));
  assert.equal(after.transport.paused, true); assert.equal(after.transport.enabled, false);
  assert.equal(after.attempts[0].providerId, "verified-example");
  assert.equal(after.decisions.length, 2); assert.ok(after.decisions.every(decision => decision.actor && decision.actor !== "forged"));
  assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(after).includes(fs.readFileSync(tokenFile, "utf8")), false);
});
