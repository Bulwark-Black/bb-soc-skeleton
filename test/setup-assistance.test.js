"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { screenHelp, operationsHelp } = require("../server/setup-assistance");
const { DEFAULT_MANIFESTS } = require("../server/reference-manifest");

function fixture() {
  const state = { apps: [{ appId: "app-one", displayName: "Application", environments: ["test"] }], sources: [], integrations: [] }, queries = [];
  const runtime = { controlState: () => state, store: { queryObservations: input => { queries.push(input); return { count: state.count || 0, records: [] }; }, stats: () => ({ records: 0, retention: { maxRecords: 1000 } }) } };
  return { state, runtime, queries };
}
test("screen help distinguishes no producer, declaration, retained facts and specialized workflow boundaries", () => {
  const f = fixture();
  let report = screenHelp(f.runtime, { route: "/logs" });
  assert.equal(report.configuredSources, 0); assert.equal(report.retainedRecords, 0); assert.match(report.detail, /No compatible source/);
  f.state.sources.push({ sourceId: "source-one", appId: "app-one", environment: "test", connectorType: "canonical-push", state: "configured", displayName: "Feed" });
  report = screenHelp(f.runtime, { route: "/logs", appId: "app-one", sourceId: "source-one" });
  assert.equal(report.configuredSources, 1); assert.equal(report.activeSources, 0); assert.match(report.detail, /no matching retained/);
  assert.equal(f.queries.at(-1).sourceId, "source-one");
  f.state.count = 4; report = screenHelp(f.runtime, { route: "/logs" });
  assert.match(report.detail, /time range, filters/); assert.equal(report.retainedRecords, 4);
  assert.match(screenHelp(f.runtime, { route: "/scans", tab: "trivy" }).detail, /generic scan records do not count/);
  assert.equal(screenHelp(f.runtime, { route: "/documents" }).retainedRecords, null);
});
test("screen help bounds listed declarations and rejects unknown views and wrong source scope", () => {
  const f = fixture();
  for (let i = 0; i < 55; i++) f.state.sources.push({ sourceId: "source-" + i, appId: "app-one", environment: "test", connectorType: "canonical-push", state: "active", displayName: "Feed" });
  const report = screenHelp(f.runtime, { route: "/logs" }); assert.equal(report.sources.length, 50); assert.equal(report.omittedSources, 5);
  for (const input of [{ route: "https://example.invalid/" }, { route: "/logs", tab: "unknown" }, { route: "/logs", appId: "missing" }, { route: "/scans", tab: "unknown" }, { route: "/logs", sourceId: "missing" }, { route: "/logs", path: "/private" }]) assert.throws(() => screenHelp(f.runtime, input));
});
test("operations facts are read-only and distinguish observed state from external verification", t => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "bb-ops-guide-")); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "synthetic-state"); fs.writeFileSync(file, "private-marker-never-in-response", { mode: 0o600 });
  const f = fixture(), ctx = { runtime: f.runtime, stateDir: directory, origin: "http://127.0.0.1:8080", port: 8080 };
  let report = operationsHelp(ctx);
  assert.equal(report.checks.find(item => item.id === "state").state, "pass");
  assert.equal(report.checks.find(item => item.id === "origin").state, "manual");
  assert.equal(report.checks.find(item => item.id === "restore").state, "manual");
  assert.equal(report.checks.find(item => item.id === "supervision").state, "manual");
  assert.doesNotMatch(JSON.stringify(report), /private-marker-never-in-response|synthetic-state|bb-ops-guide-/);
  assert.equal(fs.readFileSync(file, "utf8"), "private-marker-never-in-response");
  fs.chmodSync(file, 0o644); report = operationsHelp(ctx); assert.equal(report.checks.find(item => item.id === "state").state, "attention");
});
