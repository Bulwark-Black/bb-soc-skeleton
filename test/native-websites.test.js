"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { MonitorStore } = require("../server/native-monitor/store");
const { createHostRegistry } = require("../server/native-monitor/registry");
const { createWebsites } = require("../server/native-monitor/websites");
function fixture(t) {
  const data = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "native-website-test-"));
  let time = Date.parse("2026-10-18T10:00:00Z");
  const store = new MonitorStore({ data, minFreeBytes: 0, now: () => time, registry: createHostRegistry({ hosts: [{ id: "host-test", sourceId: "source-test", appId: "app-test", label: "Synthetic observer" }] }) });
  const websites = createWebsites(store, [{ id: "site-test", host: "host-test", label: "Synthetic site", url: "https://example.invalid/" }]);
  t.after(() => { store.close(); fs.rmSync(data, { recursive: true, force: true }); });
  const batch = (id, status, at = time) => ({ schemaVersion: 1, batchId: id, observedAt: new Date(at).toISOString(), checks: [{ url: "https://example.invalid/", at: new Date(at).toISOString(), status, ms: 35, error: null, redirect: null, certNotAfter: new Date(time + 90 * 86400000).toISOString() }] });
  const ingest = value => websites.ingest("host-test", "source-test", value);
  const evaluate = () => store.reconcileOperationalConditions(websites.conditions(), websites.conditionDefinitions());
  return { store, websites, batch, ingest, evaluate, advance(ms) { time += ms; }, now: () => time };
}
test("website replay never doubles failures; stale evidence does not resolve an outage; recovery needs fresh success", t => {
  const f = fixture(t), failed = f.batch("failure-one", 503);
  f.ingest(failed); f.evaluate(); assert.equal(f.store.incidents(null, { openOnly: true }).incidents.length, 0);
  assert.equal(f.ingest(failed).replay, true); f.evaluate(); assert.equal(f.websites.list().websites[0].failStreak, 1);
  f.advance(300000); f.ingest(f.batch("failure-two", 503)); f.evaluate();
  const incidents = () => f.store.incidents(null, { openOnly: true }).incidents;
  assert.equal(incidents().length, 1); assert.equal(incidents()[0].severity, "critical");
  f.advance(1000000); f.evaluate(); assert.equal(f.websites.list().websites[0].state, "unknown"); assert.equal(incidents().length, 1);
  f.ingest(f.batch("late-success", 200, f.now() - 1200000)); f.evaluate(); assert.equal(incidents().length, 1);
  f.ingest(f.batch("fresh-success", 200)); f.evaluate(); assert.equal(incidents().length, 0);
  assert.equal(f.websites.list().websites[0].state, "healthy");
});
test("website admission binds configured targets and refuses contradictory immutable observations", t => {
  const f = fixture(t), value = f.batch("original", 200); f.ingest(value);
  assert.throws(() => f.websites.ingest("host-test", "wrong-source", value), /source mismatch/);
  assert.throws(() => f.ingest({ ...value, batchId: "foreign", checks: [{ ...value.checks[0], url: "https://other.example.invalid/" }] }), /unregistered/);
  assert.throws(() => f.ingest({ ...value, checks: [{ ...value.checks[0], status: 503 }] }), /identity conflict/);
  assert.throws(() => f.ingest({ ...value, batchId: "same-time", checks: [{ ...value.checks[0], status: 503 }] }), /time conflicts/);
  assert.throws(() => f.ingest({ ...value, batchId: "redirect", checks: [{ ...value.checks[0], redirect: "https://other.example.invalid/" }] }), /cross-origin/);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM website_receipts").get().n, 1);
  assert.throws(() => createWebsites(f.store, [{ id: "site-test", host: "host-test", label: "Changed label", url: "https://other.example.invalid/" }]), /cannot be rebound/);
  f.advance(49 * 3600000); assert.equal(f.ingest(value).replay, true, "an accepted immutable receipt remains replayable after the admission window");
});
test("website history separates observed success from expected cadence coverage and keeps empty target gaps", t => {
  const f = fixture(t), from = f.now();
  f.ingest(f.batch("first", 200)); f.advance(600000); f.ingest(f.batch("third", 503)); f.advance(300000);
  const history = f.websites.history(null, { from, to: f.now() });
  assert.equal(history.coverage[0].expectedSlots, 3); assert.equal(history.coverage[0].observedSlots, 2);
  assert.equal(history.coverage[0].observedSuccessPercent, 50); assert.equal(history.series[0].points.length, 2);
  assert.equal(f.websites.history([], { from, to: f.now() }).series.length, 0);
  assert.throws(() => f.websites.history(null, { from, to: from + 91 * 86400000 }), /90 days/);
});
