"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { createSetupGuides, MAX_PLANS } = require("../server/setup-guides");
const { vendorManifest } = require("../tools/vendor-adapters");
const { operatorId } = require("../server/operator-context");

const START = "2026-09-29T12:00:00.000Z";
const WHO = operatorId("synthetic-setup-owner");
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "bb-soc-setup-guides-"));
  fs.chmodSync(directory, 0o700);
  let time = Date.parse(START), store;
  const state = { apps: [{ appId: "app-" + crypto.randomUUID(), displayName: "Synthetic application", environments: ["test", "other"] }],
    sources: [], integrationManifests: [], records: [] };
  const connections = [], alerts = [], reads = [], enabled = new Set(["canonical-push", "canonical-events", "trivy-report"]);
  const runtime = {
    controlState: () => structuredClone(state),
    connectorAvailable: type => enabled.has(type),
    store: { queryObservations(query) {
      reads.push(structuredClone(query));
      const matching = state.records.filter(record => record.sourceId === query.sourceId && record.estateId === query.appId
        && (!query.kinds || query.kinds.includes(record.kind)) && (!query.observedAfter || record.observedAt >= query.observedAfter)
        && (!query.observedBefore || record.observedAt < query.observedBefore));
      return { count: matching.length, records: structuredClone(matching.slice(0, query.limit)) };
    } }
  };
  const monitoring = { list({ offset = 0, limit = 100 } = {}) {
    return { connections: structuredClone(connections), alerts: structuredClone(alerts.slice(offset, offset + limit)),
      nextOffset: offset + limit < alerts.length ? offset + limit : null };
  } };
  const clock = () => new Date(time);
  const open = () => createSetupGuides({ stateDir: directory, runtime, monitoring, clock });
  store = open();
  const f = { directory, state, runtime, monitoring, connections, alerts, reads, enabled, clock, open,
    get store() { return store; }, advance(milliseconds) { time += milliseconds; },
    input(overrides = {}) { return { expectedRevision: store.list().revision, appId: state.apps[0].appId, environment: "test", path: "custom", ...overrides }; },
    check(overrides = {}) { const { expectedRevision, ...input } = f.input(overrides); return store.check(input); },
    source(overrides = {}) {
      const source = { sourceId: "source-" + crypto.randomUUID(), appId: state.apps[0].appId, environment: "test", connectorType: "canonical-push",
        sourceKind: "log.event", displayName: "Synthetic source", state: "configured", config: { "cadence-seconds": 60 },
        health: { state: "pending", lastSuccessAt: null }, ...overrides };
      state.sources.push(source); return source;
    },
    record(source, overrides = {}) { const record = { sourceId: source.sourceId, estateId: source.appId, kind: "log.event", observedAt: START,
      payload: { title: "Synthetic retained record" }, ...overrides }; state.records.push(record); return record; },
    live(overrides = {}) {
      state.integrationManifests.push(vendorManifest("sentry-events")); enabled.add("vendor.sentry-events");
      const source = f.source({ connectorType: "vendor.sentry-events", sourceKind: "sentry-events", state: "active" });
      const connection = { id: "monitor-" + crypto.randomUUID(), sourceId: source.sourceId, appId: source.appId, environment: "test", enabled: true,
        health: "healthy", lastSuccessAt: START, completedThrough: new Date(time - 30000).toISOString(), pendingWindow: null, lastError: null,
        hasSlack: false, notificationStatus: "in-app only", ...overrides };
      connections.push(connection); return { source, connection };
    },
    close() { store.close(); },
    reopen() { store.close(); store = open(); },
    inspect(callback) { const db = new Database(path.join(directory, "setup-guides.sqlite")); try { return callback(db); } finally { db.close(); } }
  };
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return f;
}
const checked = (result, id) => result.checks.find(check => check.id === id);

test("setup plans save only bounded binding identifiers, resume on restart, and CAS every mutation", t => {
  const f = fixture(t), before = structuredClone(f.state), source = f.source();
  const created = f.store.create(f.input(), WHO);
  assert.equal(created.revision, 1); assert.equal(created.plan.sourceId, null);
  assert.deepEqual(Object.keys(created.plan).sort(), ["id", "appId", "environment", "path", "sourceId", "createdAt", "updatedAt"].sort());
  assert.throws(() => f.store.update(created.plan.id, { expectedRevision: 0, sourceId: source.sourceId }, WHO), error => error.status === 409);
  f.advance(1000);
  const updated = f.store.update(created.plan.id, { expectedRevision: 1, sourceId: source.sourceId }, WHO);
  assert.equal(updated.revision, 2); assert.equal(updated.plan.updatedAt, f.clock().toISOString());
  f.reopen(); assert.deepEqual(f.store.list().plans, [updated.plan]); assert.equal(f.store.list().revision, 2);
  assert.throws(() => f.store.remove(created.plan.id, { expectedRevision: 1 }, WHO), error => error.status === 409);
  assert.deepEqual(f.store.remove(created.plan.id, { expectedRevision: 2 }, WHO), { schemaVersion: "1", revision: 3, removed: true });
  assert.equal(f.state.sources.length, 1); assert.deepEqual(f.state.apps, before.apps);
  assert.equal(f.store.list().plans.length, 0); f.reopen(); assert.equal(f.store.list().revision, 3);
});

test("duplicate bindings cannot create divergent saved guides and no-op/unsupported/secret inputs are refused", t => {
  const f = fixture(t), created = f.store.create(f.input(), WHO);
  assert.throws(() => f.store.create(f.input(), WHO), error => error.status === 409);
  for (const input of [{ token: ["synthetic", "never", "store"].join("-") }, { prompt: "synthetic-never-store" }, { completed: true }, { expectedRevision: -1 }]) {
    assert.throws(() => f.store.create(f.input(input), WHO), error => error.status === 400);
  }
  assert.throws(() => f.store.update(created.plan.id, { expectedRevision: 1 }, WHO), error => error.status === 400);
  assert.throws(() => f.store.update(created.plan.id, { expectedRevision: 1, appId: "other" }, WHO), error => error.status === 400);
  assert.equal(f.store.list().revision, 1);
  assert.ok(!JSON.stringify(f.store.list()).includes("synthetic-never-store"));
});

test("guide mutations require a human operator and reject prototype/accessor inputs", t => {
  const f = fixture(t);
  for (const actor of [null, "service:any", "operator:any", "operator:" + "f".repeat(63)]) {
    assert.throws(() => f.store.create(f.input(), actor), error => error.status === 403);
  }
  const value = f.input(); Object.defineProperty(value, "sourceId", { get() { throw new Error("Getter must not run"); }, enumerable: true });
  assert.throws(() => f.store.create(value, WHO), error => error.status === 400);
  assert.throws(() => f.store.create(Object.assign(Object.create({ token: "ignored" }), f.input()), WHO), error => error.status === 400);
  assert.equal(f.store.list().revision, 0);
});

test("application/environment/path binding is checked for every plan change and diagnostic", t => {
  const f = fixture(t), source = f.source(), other = f.source({ environment: "other" }), trivy = f.source({ connectorType: "trivy-report", sourceKind: "trivy.scan" });
  for (const overrides of [{ appId: "missing" }, { environment: "missing" }, { sourceId: "missing" }, { sourceId: other.sourceId },
    { sourceId: source.sourceId, path: "live" }, { sourceId: trivy.sourceId, path: "custom" }]) {
    assert.throws(() => f.store.create(f.input(overrides), WHO), error => error.status === 400);
    assert.throws(() => f.check(overrides), error => error.status === 400);
  }
  const created = f.store.create(f.input({ sourceId: source.sourceId }), WHO);
  assert.throws(() => f.store.update(created.plan.id, { expectedRevision: 1, sourceId: other.sourceId }, WHO), error => error.status === 400);
  assert.equal(f.store.list().revision, 1);
  f.store.update(created.plan.id, { expectedRevision: 1, sourceId: null, path: "trivy" }, WHO);
  assert.equal(f.store.list().plans[0].sourceId, null);
});

test("bounded guide capacity does not mutate revision or sources on overflow", t => {
  const f = fixture(t);
  for (let index = 0; index <= MAX_PLANS; index++) f.state.apps.push({ appId: "app-" + crypto.randomUUID(), environments: ["test"] });
  for (let index = 0; index < MAX_PLANS; index++) f.store.create(f.input({ appId: f.state.apps[index].appId }), WHO);
  assert.throws(() => f.store.create(f.input({ appId: f.state.apps[MAX_PLANS].appId }), WHO), error => error.status === 409);
  assert.equal(f.store.list().plans.length, MAX_PLANS); assert.equal(f.store.list().revision, MAX_PLANS);
  f.reopen(); assert.equal(f.store.list().plans.length, MAX_PLANS);
});

test("missing source is an honest resumable waiting state with no runtime changes", t => {
  const f = fixture(t), before = JSON.stringify(f.state), result = f.check();
  assert.equal(result.sourceId, null);
  for (const id of ["binding", "activation", "admission", "collection", "projection"]) assert.equal(checked(result, id).state, "waiting");
  assert.deepEqual(result.destinations, []); assert.match(result.summary, /not a security verdict/);
  assert.equal(JSON.stringify(f.state), before); assert.equal(f.reads.length, 0); assert.equal(f.store.list().revision, 0);
});

test("manifest compatibility and another source's retained records do not satisfy admission or projection", t => {
  const f = fixture(t), source = f.source({ state: "active" }), other = f.source({ state: "active" }); f.record(other);
  const result = f.check({ sourceId: source.sourceId });
  assert.equal(checked(result, "activation").state, "pass");
  assert.equal(checked(result, "admission").state, "waiting"); assert.equal(checked(result, "projection").state, "waiting");
  assert.ok(result.destinations.every(item => item.detail.startsWith("0 retained")));
  assert.ok(f.reads.every(query => query.sourceId === source.sourceId && query.appId === source.appId));
  assert.ok(result.destinations.every(item => item.href.includes("sourceId=" + source.sourceId)));
});

test("retained historical data does not certify fresh external delivery or current timeline population", t => {
  const f = fixture(t), source = f.source({ state: "active", health: { state: "healthy", lastSuccessAt: START } });
  f.record(source, { observedAt: "2026-09-01T00:00:00.000Z" });
  let result = f.check({ sourceId: source.sourceId });
  assert.equal(checked(result, "collection").state, "pass"); assert.match(checked(result, "collection").detail, /external sender process/);
  assert.equal(checked(result, "admission").state, "pass"); assert.equal(checked(result, "projection").state, "pass");
  assert.match(result.destinations.find(item => item.title === "Timeline").detail, /^0 retained/);
  f.advance(100000); result = f.check({ sourceId: source.sourceId });
  assert.equal(checked(result, "collection").state, "attention"); assert.equal(checked(result, "admission").state, "pass");
  source.health.state = "degraded"; source.health.lastSuccessAt = f.clock().toISOString();
  assert.equal(checked(f.check({ sourceId: source.sourceId }), "collection").state, "attention");
  source.health.state = "pending";
  assert.notEqual(checked(f.check({ sourceId: source.sourceId }), "collection").state, "pass");
});

test("quiet successful live window passes collection without invented admission or projection", t => {
  const f = fixture(t), { source, connection } = f.live();
  const input = { path: "live", sourceId: source.sourceId };
  let result = f.check(input);
  assert.equal(checked(result, "collection").state, "pass"); assert.match(checked(result, "collection").detail, /quiet window/);
  assert.equal(checked(result, "admission").state, "waiting"); assert.equal(checked(result, "projection").state, "waiting");
  connection.pendingWindow = { pages: 1 }; assert.equal(checked(f.check(input), "collection").state, "attention"); connection.pendingWindow = null;
  connection.lastError = "Synthetic failure"; assert.equal(checked(f.check(input), "collection").state, "attention"); connection.lastError = null;
  connection.enabled = false; assert.equal(checked(f.check(input), "collection").state, "attention"); connection.enabled = true;
  connection.lastSuccessAt = new Date(Date.parse(START) + 1).toISOString();
  assert.equal(checked(f.check(input), "collection").state, "attention", "A future success timestamp cannot certify freshness after clock rollback."); connection.lastSuccessAt = START;
  connection.completedThrough = new Date(Date.parse(START) + 1).toISOString();
  assert.equal(checked(f.check(input), "collection").state, "attention"); connection.completedThrough = START;
  f.advance(301000); assert.equal(checked(f.check(input), "collection").state, "attention");
  assert.equal(f.state.records.length, 0);
});

test("managed live choices, imports, archived sources and removed connections are not confused", t => {
  const f = fixture(t), { source } = f.live();
  assert.deepEqual(f.store.list().choices.filter(item => item.sourceId === source.sourceId).map(item => item.path), ["live"]);
  assert.throws(() => f.check({ sourceId: source.sourceId, path: "vendor" }), error => error.status === 400);
  const saved = f.store.create(f.input({ sourceId: source.sourceId, path: "live" }), WHO);
  f.connections.splice(0); source.state = "archived";
  f.reopen(); assert.equal(f.store.list().plans[0].id, saved.plan.id);
  assert.equal(checked(f.check({ sourceId: source.sourceId, path: "live" }), "collection").state, "attention");
  assert.deepEqual(f.store.list().choices.filter(item => item.sourceId === source.sourceId).map(item => item.path), ["vendor"]);
  assert.equal(checked(f.check({ sourceId: source.sourceId, path: "vendor" }), "collection").state, "not-applicable");
  const trivy = f.source({ connectorType: "trivy-report", sourceKind: "trivy.scan" });
  const result = f.check({ sourceId: trivy.sourceId, path: "trivy" });
  assert.equal(checked(result, "collection").state, "not-applicable"); assert.ok(result.destinations.some(item => item.title === "Trivy report imports"));
  const destination = new URL(result.destinations.find(item => item.title === "Trivy report imports").href.slice(1), "https://console.example.invalid");
  assert.equal(destination.searchParams.get("appId"), result.appId);
  assert.equal(destination.searchParams.get("sourceId"), trivy.sourceId);
});

test("Slack evidence is connection-scoped and separates provider acknowledgment from human confirmation", t => {
  const f = fixture(t), { source, connection } = f.live({ hasSlack: true, notificationStatus: "configured" });
  const input = { sourceId: source.sourceId, path: "live" };
  f.alerts.push(...Array.from({ length: 101 }, () => ({ connectionId: "another-connection", deliveryState: "delivered", deliveredAt: START })));
  assert.equal(checked(f.check(input), "notification-provider").state, "waiting");
  f.alerts.push({ connectionId: connection.id, deliveryState: "delivered", deliveredAt: START });
  let result = f.check(input);
  assert.equal(checked(result, "notification-provider").state, "pass");
  assert.match(checked(result, "notification-provider").detail, /historical provider acknowledgment/);
  assert.equal(checked(result, "notification-human").state, "waiting");
  f.alerts.push({ connectionId: connection.id, deliveryState: "pending" });
  assert.equal(checked(f.check(input), "notification-provider").state, "waiting");
  f.alerts.at(-1).deliveryState = "blocked";
  assert.equal(checked(f.check(input), "notification-provider").state, "attention");
  f.alerts.pop(); connection.notificationStatus = "Synthetic provider failure";
  assert.equal(checked(f.check(input), "notification-provider").state, "attention");
  assert.ok(!JSON.stringify(f.check(input)).includes("Synthetic provider failure"), "Diagnostics emit safe fixed explanations, not raw provider text.");
});

test("fresh diagnostics age independently of saved plans and preserve data on deletion", t => {
  const f = fixture(t), { source } = f.live();
  const plan = f.store.create(f.input({ sourceId: source.sourceId, path: "live" }), WHO).plan;
  assert.equal(checked(f.check({ sourceId: source.sourceId, path: "live" }), "collection").state, "pass");
  f.advance(301000); f.reopen();
  assert.equal(checked(f.check({ sourceId: source.sourceId, path: "live" }), "collection").state, "attention");
  const before = JSON.stringify({ state: f.state, connections: f.connections });
  f.store.remove(plan.id, { expectedRevision: 1 }, WHO);
  assert.equal(JSON.stringify({ state: f.state, connections: f.connections }), before);
});

test("corrupt version, schema, saved rows and metadata fail closed without repairing the file", async t => {
  for (const [name, tamper] of [
    ["version", db => db.pragma("user_version = 2")],
    ["extra table", db => db.exec("CREATE TABLE unexpected (data TEXT)")],
    ["extra trigger", db => db.exec("CREATE TRIGGER extra AFTER INSERT ON plans BEGIN UPDATE setup_state SET revision=0; END")],
    ["revision", db => db.exec("UPDATE setup_state SET revision=-1")],
    ["missing metadata", db => db.exec("DELETE FROM setup_state")],
    ["invalid saved path", db => db.exec("UPDATE plans SET path='secret' ")],
    ["invalid source id", db => db.exec("UPDATE plans SET source_id='invalid id' ")],
    ["invalid timestamps", db => db.exec("UPDATE plans SET updated_at='2026-01-01T00:00:00.000Z' ")]
  ]) await t.test(name, sub => {
    const f = fixture(sub); f.store.create(f.input(), WHO); f.close(); f.inspect(tamper);
    assert.throws(() => f.open(), error => error.status === 503);
  });
});

test("owner-only files, sidecars and canonical directory requirements are enforced", async t => {
  for (const kind of ["directory-mode", "file-mode", "symlink", "hardlink", "sidecar", "empty-existing-file"]) await t.test(kind, sub => {
    const f = fixture(sub); f.close(); const filename = path.join(f.directory, "setup-guides.sqlite");
    if (kind === "directory-mode") fs.chmodSync(f.directory, 0o755);
    if (kind === "file-mode") fs.chmodSync(filename, 0o644);
    if (kind === "symlink") { fs.renameSync(filename, filename + ".original"); fs.symlinkSync(filename + ".original", filename); }
    if (kind === "hardlink") fs.linkSync(filename, filename + ".copy");
    if (kind === "sidecar") fs.writeFileSync(filename + "-journal", "synthetic-invalid-sidecar", { mode: 0o644 });
    if (kind === "empty-existing-file") fs.truncateSync(filename, 0);
    assert.throws(() => f.open(), error => error.status === 503);
  });
});

test("closed stores cannot be reused and closing is idempotent", t => {
  const f = fixture(t); f.close(); f.close();
  assert.throws(() => f.store.list(), error => error.status === 503);
  assert.throws(() => f.check(), error => error.status === 503);
});
