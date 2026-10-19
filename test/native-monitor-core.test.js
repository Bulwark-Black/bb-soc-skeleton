"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MonitorStore } = require("../server/native-monitor/store");
const { validateRegistry, createHostRegistry } = require("../server/native-monitor/registry");

const HOSTS = [
  { id: "server-a", sourceId: "source-a", appId: "app-a", label: "Application server", services: ["example.service"] },
  { id: "server-b", sourceId: "source-b", appId: "app-a", label: "Database server", services: ["example.service"], postgres: true }
];
function fixture(t, options = {}) {
  const data = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "soc-native-core-"));
  let at = Date.UTC(2026, 9, 18, 12);
  const registry = options.registry || createHostRegistry({ hosts: HOSTS });
  const configuration = { data, registry, minFreeBytes: 0, now: () => at, ...options };
  const f = { data, registry, store: new MonitorStore(configuration), get now() { return at; },
    tick(ms = 60000) { at += ms; }, reopen() { f.store.close(); f.store = new MonitorStore(configuration); },
    batch(sequence, values = {}) {
      const host = values.host || "server-a";
      const defaults = { "cpu.utilization_pct": 10, "memory.available_pct": 50, "filesystem.root.used_pct": 40,
        "filesystem.root.free_bytes": 50 * 1024 ** 3, "load.1": 0.5, "swap.used_bytes": 0,
        "postgres.connections_used_pct": 20, "postgres.usable_max_connections": 100 };
      const samples = registry.SERIES.filter(s => s.host === host).map(s => ({ seriesId: s.id, value: defaults[s.suffix] ?? 0, quality: "good" }));
      const checks = registry.CHECKS.filter(c => c.host === host && !["metric", "collection"].includes(c.type))
        .map(c => ({ checkId: c.id, status: "healthy", summary: "Synthetic healthy observation" }));
      if (values.service) checks[0] = { ...checks[0], status: values.service, summary: "Synthetic service " + values.service };
      if (values.cpu !== undefined) samples.find(s => s.seriesId === host + ".cpu.utilization_pct").value = values.cpu;
      return { schemaVersion: 1, sourceId: registry.HOSTS.find(h => h.id === host).sourceId, streamId: "stream-1", sequence,
        batchId: host + "-batch-" + sequence, observedAt: new Date(at).toISOString(), bootId: "boot-1", monotonicNs: String(sequence * 60000000000),
        collectorVersion: "fixture-1", configRevision: "a".repeat(64), collection: { ok: true, durationMs: 10 }, samples, checks, ...values.override };
    },
    ingest(sequence, values = {}) { return f.store.ingest(values.host || "server-a", f.batch(sequence, values)); }
  };
  t.after(() => { f.store.close(); fs.rmSync(data, { recursive: true, force: true }); });
  return f;
}
function status(f, id) { return f.store.currentChecks().find(c => c.id === id); }
function open(f, id) { return f.store.incidents(null, { openOnly: true }).incidents.find(i => i.checkId === id); }
function rejects(fn, code) { assert.throws(fn, e => e.status === code); }

test("native registry is empty by default, bounded, immutable and scoped", () => {
  assert.deepEqual(validateRegistry(), { VERSION: 1, HOSTS: [], SERIES: [], CHECKS: [] });
  const registry = createHostRegistry({ hosts: HOSTS });
  assert.equal(registry.SERIES.length, 21);
  assert.equal(Object.isFrozen(registry.HOSTS[0]), true);
  for (const change of [
    r => { r.HOSTS[1].sourceId = r.HOSTS[0].sourceId; },
    r => { r.HOSTS[1].appId = "another-app"; },
    r => { r.HOSTS[0].intervalSeconds = 30; },
    r => { r.CHECKS = r.CHECKS.filter(c => c.id !== "server-a.collection"); },
    r => { r.CHECKS[0].dependencies = [{ checkId: "server-b.collection", reason: "wrong host" }]; },
    r => { r.CHECKS[0].policy.warning = 101; },
    r => { r.CHECKS[0].notificationEnabled = true; },
    r => { r.HOSTS[0].command = "unregistered action"; }
  ]) {
    const copy = structuredClone(registry); change(copy); assert.throws(() => validateRegistry(copy));
  }
  assert.throws(() => createHostRegistry({ hosts: [{ ...HOSTS[0], services: ["bad;unit.service"] }] }));
});

test("empty native runtime has no manufactured observations or enabled notification sender", t => {
  assert.throws(() => new MonitorStore(), /explicit absolute/);
  const f = fixture(t, { registry: validateRegistry(), notifications: true });
  assert.equal(f.store.overview().counts.targets, 0);
  assert.deepEqual(f.store.resources().resources, []);
  assert.equal(f.store.health().notificationEnabled, false);
  assert.throws(() => { f.store.notifications = true; });
});

test("durable source-scoped admission, semantic sequence aliases and exact replay survive restart", t => {
  const f = fixture(t), batch = f.batch(1), receipt = f.store.ingest("server-a", batch);
  assert.equal(receipt.historyOnly, false);
  assert.equal(f.store.resources(["server-a"]).resources[0].state, "healthy");
  assert.equal(f.store.resources(["server-b"]).resources[0].state, "unknown");
  const alias = { ...batch, batchId: "different-delivery" };
  assert.equal(f.store.ingest("server-a", alias).receiptId, receipt.receiptId);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM points").get().n, 6);
  f.reopen();
  assert.equal(f.store.ingest("server-a", batch).replay, true);
  assert.equal(f.store.ingest("server-a", alias).replay, true);
  rejects(() => f.store.ingest("server-a", { ...batch, collection: { ok: false, durationMs: 10 } }), 409);
  rejects(() => f.store.ingest("server-b", batch), 400);
  const foreign = f.batch(2); foreign.samples[0].seriesId = "server-b.cpu.utilization_pct";
  rejects(() => f.store.ingest("server-a", foreign), 400);
  assert.deepEqual(f.store.resources([]).resources, []);
  assert.deepEqual(f.store.incidents([]).incidents, []);
  assert.deepEqual(f.store.events([]).events, []);
  rejects(() => f.store.query(["server-b.cpu.utilization_pct"], f.now - 60000, f.now, ["server-a"]), 403);
});

test("old delivery and replay cannot refresh health; future data stays unknown; streams require activation", t => {
  const f = fixture(t), initial = f.batch(1); f.store.ingest("server-a", initial);
  f.tick(181000);
  assert.equal(f.store.resources(["server-a"]).resources[0].state, "unknown");
  assert.equal(f.store.ingest("server-a", initial).replay, true);
  const late = f.batch(2, { override: { observedAt: initial.observedAt } });
  assert.equal(f.store.ingest("server-a", late).historyOnly, true);
  const future = f.batch(3, { override: { observedAt: new Date(f.now + 31000).toISOString() } });
  assert.equal(f.store.ingest("server-a", future).clockSkew, true);
  assert.equal(f.store.db.prepare("SELECT quality FROM points WHERE batch_id=? LIMIT 1").get(future.batchId).quality, "unknown");
  assert.equal(f.store.resources(["server-a"]).resources[0].lastObservedAt, Date.parse(initial.observedAt));
  f.store.evaluateFreshness(); assert.ok(open(f, "server-a.collection"));
  const next = f.batch(4, { override: { streamId: "replacement-stream" } });
  rejects(() => f.store.ingest("server-a", next), 409);
  f.store.activateStream("server-a", "replacement-stream", "test-operator");
  assert.equal(f.store.resources(["server-a"]).resources[0].lastObservedAt, null);
  assert.equal(f.store.ingest("server-a", next).historyOnly, false);
  assert.ok(open(f, "server-a.collection"), "one recovery observation cannot resolve the stale incident");
  f.tick(); f.ingest(5, { override: { streamId: "replacement-stream" } });
  assert.equal(open(f, "server-a.collection"), undefined);
});

test("partial collection preserves measured service critical state; unknown and stale never resolve incidents", t => {
  const f = fixture(t), checkId = "server-b.service.example.service";
  function partial(n, service) {
    const batch = f.batch(n, { host: "server-b", service });
    batch.collection = { ok: false, durationMs: 12, error: "Optional database probe unavailable" };
    batch.samples = batch.samples.map(s => s.seriesId.includes(".postgres.") ? { seriesId: s.seriesId, value: null, quality: "unknown" } : s);
    batch.checks[1] = { ...batch.checks[1], status: "unknown", summary: "Database probe unavailable" };
    f.store.ingest("server-b", batch);
  }
  for (let n = 1; n <= 3; n++) { partial(n, "critical"); f.tick(); }
  const incident = open(f, checkId); assert.ok(incident);
  assert.equal(f.store.resources(["server-b"]).resources[0].state, "critical");
  assert.equal(f.store.resources(["server-b"]).resources[0].quality, "partial");
  partial(4, "unknown"); assert.equal(open(f, checkId).id, incident.id);
  f.tick(181000); assert.equal(status(f, checkId).status, "unknown"); assert.ok(open(f, checkId));
  partial(5, "healthy"); f.tick(); partial(6, "healthy");
  assert.equal(open(f, checkId), undefined);
  assert.equal(f.store.resources(["server-b"]).resources[0].state, "unknown");
});

test("metric dwell, recovery hysteresis and boot-reset dwell use actual observation time", t => {
  const f = fixture(t), checkId = "server-a.cpu.utilization_pct";
  for (let n = 1; n <= 15; n++) { f.ingest(n, { cpu: 90 }); assert.equal(open(f, checkId), undefined); f.tick(); }
  f.ingest(16, { cpu: 90 }); assert.ok(open(f, checkId));
  for (let n = 17; n <= 22; n++) { f.tick(); f.ingest(n, { cpu: 80 }); }
  assert.ok(open(f, checkId), "value below warning but above recovery is insufficient");
  for (let n = 23; n <= 27; n++) { f.tick(); f.ingest(n, { cpu: 70 }); assert.ok(open(f, checkId)); }
  f.tick(); f.ingest(28, { cpu: 70 }); assert.equal(open(f, checkId), undefined);
  for (let n = 29; n <= 39; n++) { f.tick(); f.ingest(n, { cpu: 90 }); }
  f.tick(); f.ingest(40, { cpu: 90, override: { bootId: "boot-2" } });
  assert.equal(open(f, checkId), undefined, "reboot resets unfinished dwell");
});

test("acknowledgement and expiring maintenance retain evidence, enforce scopes and replay safely", t => {
  const f = fixture(t), checkId = "server-a.service.example.service";
  const body = { host: "server-a", actor: "operator", reason: "Scheduled maintenance", durationMinutes: 5, idempotencyKey: "maintenance-1" };
  const maintenance = f.store.maintenance(body, ["server-a"]);
  assert.deepEqual(f.store.maintenance(body, ["server-a"]), maintenance);
  rejects(() => f.store.maintenance({ ...body, idempotencyKey: "wrong-scope" }, ["server-b"]), 403);
  for (let n = 1; n <= 3; n++) { f.ingest(n, { service: "critical" }); f.tick(); }
  let incident = open(f, checkId); assert.ok(incident);
  assert.equal(f.store.events(null, true).events.find(e => e.type === "opened").notificationDecision.reason, "maintenance");
  const ack = { incidentId: incident.id, actor: "operator", note: "Investigating", expectedRevision: incident.revision, idempotencyKey: "ack-1" };
  assert.deepEqual(f.store.acknowledge(ack, ["server-a"]), f.store.acknowledge(ack, ["server-a"]));
  rejects(() => f.store.acknowledge(ack, ["server-b"]), 403);
  rejects(() => f.store.acknowledge({ ...ack, note: "Changed" }), 409);
  assert.ok(open(f, checkId));
  f.tick(120001); f.store.response.tick();
  assert.equal(f.store.isMaintenance("server-a", checkId), false);
  assert.ok(f.store.events(null, true).events.some(e => e.type === "maintenance-ended"));
  assert.ok(f.store.events(null, true).events.every(e => e.notify === false));
  f.ingest(4, { service: "healthy" }); f.tick(); f.ingest(5, { service: "healthy" });
  assert.equal(open(f, checkId), undefined);
  assert.equal(f.store.incidentDetail(["server-a"], incident.id).incident.status, "resolved");
  rejects(() => f.store.incidentDetail(["server-b"], incident.id), 404);
});

test("history, rollups and recurrence remain bounded and persistent", t => {
  const f = fixture(t), start = f.now;
  for (let n = 1; n <= 3; n++) { f.ingest(n, { service: "critical" }); f.tick(); }
  const first = open(f, "server-a.service.example.service");
  for (let n = 4; n <= 5; n++) { f.ingest(n); f.tick(); }
  for (let n = 6; n <= 8; n++) { f.ingest(n, { service: "critical" }); f.tick(); }
  const recurrence = open(f, "server-a.service.example.service");
  assert.equal(recurrence.lifecycle.episodeId, first.id);
  assert.equal(recurrence.lifecycle.generation, 2);
  const history = f.store.incidentHistory(["server-a"], { episodeId: first.id, limit: 1 });
  assert.equal(history.page.total, 2); assert.equal(history.page.hasNext, true);
  const older = f.store.incidentHistory(["server-a"], { episodeId: first.id, limit: 1, cursor: history.page.nextCursor });
  assert.equal(older.incidents[0].id, first.id);
  rejects(() => f.store.incidentHistory(["server-b"], { episodeId: first.id, limit: 1, cursor: history.page.nextCursor }), 409);
  assert.equal(f.store.query(["server-a.cpu.utilization_pct"], start, f.now).series[0].points.length, 8);
  assert.ok(f.store.maintenanceTick().rolled > 0);
  f.reopen();
  assert.equal(f.store.incidentDetail(["server-a"], recurrence.id).incident.lifecycle.generation, 2);
  assert.ok(f.store.db.prepare("SELECT COUNT(*) n FROM rollups").get().n > 0);
  rejects(() => f.store.query(Array(9).fill("server-a.cpu.utilization_pct"), start, f.now), 400);
});

test("failed admission rolls back receipt, points, state and incident together", t => {
  const f = fixture(t); f.ingest(1, { service: "critical" }); f.tick(); f.ingest(2, { service: "critical" }); f.tick();
  const before = { receipts: f.store.db.prepare("SELECT COUNT(*) n FROM receipts").get().n,
    points: f.store.db.prepare("SELECT COUNT(*) n FROM points").get().n, state: status(f, "server-a.service.example.service") };
  const original = f.store.queueEvent;
  f.store.queueEvent = () => { throw new Error("Synthetic transactional failure"); };
  assert.throws(() => f.ingest(3, { service: "critical" }), /Synthetic transactional/);
  f.store.queueEvent = original;
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM receipts").get().n, before.receipts);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM points").get().n, before.points);
  assert.equal(open(f, "server-a.service.example.service"), undefined);
  assert.deepEqual(status(f, "server-a.service.example.service"), before.state);
  assert.equal(f.ingest(3, { service: "critical" }).accepted, true);
});

test("registry source rebinding and database links are refused on reopen", t => {
  const f = fixture(t); f.ingest(1); f.store.close();
  const registry = structuredClone(f.registry); registry.HOSTS[0].sourceId = "replacement-source";
  assert.throws(() => new MonitorStore({ data: f.data, registry, minFreeBytes: 0 }), /binding changed/);
  const foreignMetric = structuredClone(f.registry);
  foreignMetric.SERIES.find(s => s.id === "server-a.load.1").host = "server-b";
  assert.throws(() => new MonitorStore({ data: f.data, registry: foreignMetric, minFreeBytes: 0 }), /host binding changed/);
  const backup = path.join(f.data, "unrelated.sqlite");
  fs.renameSync(path.join(f.data, "monitor.sqlite"), backup);
  fs.symlinkSync(backup, path.join(f.data, "monitor.sqlite"));
  assert.throws(() => new MonitorStore({ data: f.data, registry: f.registry }), /without links/);
});
