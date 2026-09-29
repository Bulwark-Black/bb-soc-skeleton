"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startPrivateApplication } = require("../server/private-application");
const { operatorId } = require("../server/operator-context");

test("private HTTP application source workflow authenticates control, admits machine events once, and survives restart", async (t) => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "bb-soc-private-source-"));
  let app;
  t.after(async () => {
    if (app) await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  app = await startPrivateApplication({ stateDirectory: directory, port: 0 });
  const password = crypto.randomBytes(30).toString("base64url");
  const operator = await app.authentication.createOperator({ email: "source-owner@example.invalid", name: "Source workflow operator", password });
  let cookie;
  let sequence = 0;
  const request = (endpoint, options = {}) => fetch(app.url + endpoint, {
    method: options.method || "GET",
    headers: {
      Connection: "close",
      ...(!options.machine ? { Origin: app.url } : {}),
      ...(cookie && !options.anonymous && !options.machine ? { Cookie: cookie } : {}),
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(options.credential ? { Authorization: "Bearer " + options.credential } : {})
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {})
  });
  const commandDocument = (command, input) => ({ schemaVersion: "1", documentType: "connector-command-request",
    requestId: "private-source-command-" + (++sequence), command, requestedAt: new Date().toISOString(), input });
  const sendCommand = async (command, input) => {
    const response = await request("/api/v1/control/commands", { method: "POST", body: commandDocument(command, input) });
    assert.equal(response.status, 200, command);
    const result = await response.json();
    assert.equal(result.status, "succeeded", command);
    return result.output;
  };
  const snapshot = async () => {
    const response = await request("/api/v1/control/snapshot");
    assert.equal(response.status, 200);
    return response.json();
  };
  const registration = { displayName: "HTTP workflow application", publicPages: [], environments: ["preview", "live"] };
  const denied = await request("/api/v1/control/commands", {
    method: "POST", anonymous: true, body: commandDocument("app.register", registration)
  });
  assert.equal(denied.status, 401, "anonymous callers cannot register an application");
  await denied.arrayBuffer();
  const signed = await request("/api/auth/sign-in/email", { method: "POST", body: { email: operator.email, password } });
  assert.equal(signed.status, 200);
  cookie = signed.headers.getSetCookie().map((entry) => entry.split(";")[0]).join("; ");
  assert.ok(cookie);
  await signed.arrayBuffer();
  const application = await sendCommand("app.register", registration);
  let registry = await snapshot();
  assert.deepEqual(registry.apps[0].hosts, []);
  assert.deepEqual(registry.apps[0].environments, ["preview", "live"]);
  assert.deepEqual(registry.hosts, []);
  const configured = await sendCommand("source.setup", { appId: application.appId, environment: "live",
    connectorType: "canonical-push", sourceKind: "log.event", displayName: "HTTP application events",
    config: { "cadence-seconds": 300 }, credentialReferences: [] });
  const sourceRevision = async () => {
    const current = await snapshot();
    const source = [...current.setups, ...current.sources].find((entry) => entry.sourceId === configured.sourceId);
    return { sourceId: source.sourceId, connectorInstanceId: source.connectorInstanceId, expectedRevision: source.revision };
  };
  await sendCommand("source.test", { ...await sourceRevision(), sample: { message: "Redacted operator-provided application line", channel: "application" } });
  const activated = await sendCommand("source.activate", await sourceRevision());
  const credential = activated.oneTimeCredential.value;
  assert.equal(activated.oneTimeCredential.purpose, "source-ingest");
  const bearerControl = await request("/api/v1/control/commands", { method: "POST", anonymous: true, credential,
    body: commandDocument("source.pause", await sourceRevision()) });
  assert.equal(bearerControl.status, 401, "a source credential cannot authorize operator commands");
  await bearerControl.arrayBuffer();
  const timestamp = new Date().toISOString();
  const batch = { schemaVersion: "1", documentType: "ingest-batch", sourceId: configured.sourceId,
    receiptId: "private-source-receipt-0001", sentAt: timestamp, records: [{
      schemaVersion: "1", documentType: "normalized-record", recordId: "private-source-event-1", sourceId: configured.sourceId,
      estateId: application.appId, kind: "log.event", observedAt: timestamp,
      payload: { title: "Application event", state: "ok", severity: "info", channel: "application", message: "HTTP source workflow event" }
    }] };
  const ingest = () => request("/api/v1/ingest", { method: "POST", machine: true, credential, body: batch });
  let delivery = await ingest();
  assert.equal(delivery.status, 200, "machine admission accepts a scoped bearer without a browser Origin or session");
  const firstReceipt = await delivery.json();
  assert.equal(firstReceipt.accepted, 1);
  assert.equal(firstReceipt.replay, false);
  delivery = await ingest();
  assert.equal(delivery.status, 200);
  assert.equal((await delivery.json()).replay, true);
  const page = async (route) => {
    const response = await request("/api/v1/pages?route=" + encodeURIComponent(route));
    assert.equal(response.status, 200);
    const envelope = await response.json();
    assert.equal(envelope.state, "ready", route);
    return envelope;
  };
  const logs = await page("/logs");
  const logRows = logs.panels.find((panel) => panel.id === "log-results").rows;
  assert.equal(logRows.length, 1, "the duplicate batch creates no extra record");
  assert.match(JSON.stringify(logRows), /HTTP source workflow event/);
  assert.match(JSON.stringify(logRows), /HTTP workflow application \/ live/, "hostless logs show application and environment context");
  const overview = await page("/");
  assert.equal(overview.panels.find((panel) => panel.id === "summary-metrics").items.find((item) => item.label === "Log events retained").value, 1);
  const health = await page("/health");
  const metrics = health.panels.find((panel) => panel.id === "summary-metrics").items;
  assert.equal(metrics.find((item) => item.label === "Healthy feeds").value, 1);
  assert.equal(metrics.find((item) => item.label === "Events retained").value, 1);
  await sendCommand("source.pause", await sourceRevision());
  delivery = await ingest();
  assert.equal(delivery.status, 409, "paused sources cannot ingest even a previously accepted receipt");
  await delivery.arrayBuffer();
  const committed = app.runtime.store.db.prepare("SELECT json FROM telemetry_audit ORDER BY revision").all()
    .map((entry) => JSON.parse(entry.json)).filter((entry) => entry.phase === "commit");
  const operatorCommands = committed.filter((entry) => ["app.register", "source.setup", "source.test", "source.activate", "source.pause"].includes(entry.action));
  assert.equal(operatorCommands.length, 5);
  assert.ok(operatorCommands.every((entry) => entry.actor === operatorId(operator.id)), "audits record the authenticated operator instead of the loopback identity");
  assert.equal(committed.filter((entry) => entry.action === "ingest.accept").length, 1);
  const port = Number(new URL(app.url).port);
  await app.close();
  app = null;
  app = await startPrivateApplication({ stateDirectory: directory, port });
  registry = await snapshot();
  assert.equal(registry.apps[0].appId, application.appId);
  assert.equal(registry.sources[0].sourceId, configured.sourceId);
  assert.equal(registry.sources[0].environment, "live");
  assert.equal(registry.sources[0].state, "paused");
  await sendCommand("source.resume", await sourceRevision());
  delivery = await ingest();
  assert.equal(delivery.status, 200);
  const retainedReceipt = await delivery.json();
  assert.equal(retainedReceipt.replay, true, "receipt deduplication survives process restart");
  assert.equal(retainedReceipt.receivedAt, firstReceipt.receivedAt);
  assert.equal((await page("/logs")).panels.find((panel) => panel.id === "log-results").rows.length, 1);
});
