"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { SqliteTelemetryStore } = require("../server/sqlite-telemetry-store");
const { ReferenceControlPlane } = require("../server/reference-runtime");
const { runAsOperator } = require("../server/operator-context");
const { RECORD_KINDS, validateNormalizedRecord } = require("../tools/ingest-contract");
const { INTEGRATION_COVERAGE, normalizeObservationQuery } = require("../server/integration-coverage");
const { createPageEnvelope } = require("../server/reference-pages");
const { digest } = require("../tools/benchmark-private");
const { normalizeTrivyReport } = require("../server/scanner-ingest");

const AT = "2026-09-29T12:00:00.000Z";
function record(identity, kind, index, extra = {}) {
  return validateNormalizedRecord({ schemaVersion: "1", documentType: "normalized-record", recordId: `observation-${index}`,
    sourceId: identity.sourceId, estateId: identity.appId, kind, observedAt: AT,
    payload: { title: "Synthetic imported fact", state: "unknown", severity: "medium", assetRef: "test-asset", identityRef: "test-identity",
      ruleRef: "test-rule", findingRef: "test-finding", category: "test", message: "Synthetic message", indicatorType: "domain", indicator: "example.invalid", ...extra } });
}
function fixture(t, retention) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "bb-soc-projections-test-"));
  let currentTime = AT;
  const clock = () => new Date(currentTime);
  const store = new SqliteTelemetryStore({ directory, clock, retention });
  const runtime = new ReferenceControlPlane({ store, clock, enabledConnectorTypes: ["canonical-push", "canonical-events", "trivy-report"] });
  t.after(() => { runtime.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  let sequence = 0;
  function execute(command, input) {
    const result = runAsOperator("projection-test-operator", () => runtime.execute({ schemaVersion: "1", documentType: "connector-command-request",
      requestId: `projection-command-${++sequence}`, requestedAt: currentTime, command, input }));
    assert.equal(result.status, "succeeded");
    return result.output;
  }
  function source(name = "Application", connectorType = "canonical-events") {
    const app = execute("app.register", { displayName: name, hosts: [], publicPages: [], environments: ["test"] });
    const setup = execute("source.setup", { appId: app.appId, environment: "test", connectorType, sourceKind: connectorType === "trivy-report" ? "trivy.scan" : "log.event",
      displayName: name + " facts", config: { "cadence-seconds": 300 }, credentialReferences: [] });
    const identity = { appId: app.appId, sourceId: setup.sourceId, connectorInstanceId: setup.connectorInstanceId };
    const tested = execute("source.test", { sourceId: setup.sourceId, connectorInstanceId: setup.connectorInstanceId, expectedRevision: setup.revision,
      ...(connectorType === "canonical-events" ? { recordSample: record(identity, "log.event", "sample") } : {}) });
    const activated = execute("source.activate", { sourceId: setup.sourceId, connectorInstanceId: setup.connectorInstanceId, expectedRevision: tested.revision });
    return { ...identity, credential: activated.oneTimeCredential.value };
  }
  function ingest(identity, records) {
    const batch = { schemaVersion: "1", documentType: "ingest-batch", sourceId: identity.sourceId,
      receiptId: `projection-receipt-${++sequence}`, sentAt: currentTime, records };
    return runtime.ingest(batch, identity.credential, digest(batch));
  }
  return { store, runtime, execute, source, ingest, directory, setTime(value) { currentTime = value; } };
}

test("every canonical kind is discoverable in bounded application/source-scoped observations without full-history reads", (t) => {
  const { store, source, ingest } = fixture(t);
  const first = source("First application");
  const second = source("Second application");
  ingest(first, RECORD_KINDS.map((kind, index) => record(first, kind, index)));
  ingest(second, [record(second, "log.event", 100)]);
  store.snapshot = () => { throw new Error("Never materialize telemetry history for observation reads."); };
  const all = store.queryObservations();
  assert.equal(all.count, 30);
  assert.deepEqual(new Set(all.records.map((entry) => entry.kind)), new Set(RECORD_KINDS));
  const selected = store.queryObservations({ appId: first.appId, limit: 7, offset: 3 });
  assert.equal(selected.count, 29);
  assert.equal(selected.records.length, 7);
  assert.equal(selected.omitted, 22);
  assert.equal(selected.hasMore, true);
  assert.ok(selected.records.every((entry) => entry.sourceId === first.sourceId));
  assert.equal(store.queryObservations({ appId: first.appId, sourceId: second.sourceId }).count, 0);
  assert.equal(store.queryObservations({ kinds: ["log.event"], sourceId: first.sourceId }).count, 1);
  assert.equal(store.queryObservations({ offset: 30 }).records.length, 0);
  assert.equal(store.queryObservations({ offset: 30 }).hasMore, false);
});

test("observation filters reject unknown kinds/keys and invalid unbounded arguments", (t) => {
  const { store } = fixture(t);
  for (const query of [{ kinds: ["unknown.kind"] }, { kinds: ["log.event", "log.event"] }, { kinds: [] }, { limit: 201 }, { limit: "20" },
    { offset: -1 }, { offset: 1000001 }, { state: "anything" }, { sourceId: "x' OR 1=1" }, { appId: "bad/id" },
    { observedAfter: "today" }, { observedAfter: AT, observedBefore: AT }]) {
    assert.throws(() => store.queryObservations(query), TypeError);
  }
  assert.throws(() => normalizeObservationQuery({ get sourceId() { throw new Error("must not evaluate"); } }), /Unsupported/);
});

test("generic screens expose truthful schema-valid observations; Logs remains log.event only and governance remains authored", (t) => {
  const { runtime, store, source, ingest } = fixture(t);
  const identity = source();
  ingest(identity, RECORD_KINDS.map((kind, index) => record(identity, kind, index)));
  const state = store.snapshot();
  store.snapshot = () => { throw new Error("Full-history reads are forbidden."); };
  for (const entry of INTEGRATION_COVERAGE.filter((item) => item.status === "observations")) {
    const indexed = runtime.readPage(entry.route, entry.query);
    const reference = createPageEnvelope(entry.route, entry.query, state, AT);
    assert.equal(indexed.state, "ready", entry.title);
    assert.equal(indexed.panels[1].title, "Imported observations");
    assert.match(indexed.panels[0].body, /not a console verdict/);
    assert.equal(indexed.panels[1].rows.length, entry.recordKinds.length, entry.title);
    assert.equal(reference.panels[1].rows.length, indexed.panels[1].rows.length);
    assert.ok(indexed.panels.every((panel) => ["notice", "table"].includes(panel.type)));
  }
  assert.equal(runtime.readPage("/logs", {}).panels[0].rows.length, 1);
  assert.equal(runtime.readPage("/attestations", {}).state, "empty");
  assert.equal(runtime.readPage("/register", {}).state, "empty");
  assert.equal(runtime.readPage("/scans", { tab: "trivy" }).state, "empty");
  assert.throws(() => runtime.readPage("/scans", { tab: "invented" }), /Unknown scanner tab/);
  assert.throws(() => runtime.readPage("/timeline", { range: "forever" }), /Unknown timeline range/);
  assert.equal(runtime.readPage("/timeline", { appId: "missing-app" }).state, "empty");
});

test("archived and removed source history remains labeled instead of implying active collection", (t) => {
  const { runtime, store, source, ingest, execute } = fixture(t);
  const identity = source("Lifecycle application");
  ingest(identity, [record(identity, "backup.status", 1)]);
  for (const action of ["archive", "remove"]) {
    const current = store.controlSnapshot().sources.find((item) => item.sourceId === identity.sourceId);
    execute("source." + action, { sourceId: identity.sourceId, connectorInstanceId: identity.connectorInstanceId, expectedRevision: current.revision });
    const page = runtime.readPage("/backups", {});
    assert.equal(page.panels[1].rows[0][1], "Lifecycle application / test");
    assert.equal(page.panels[1].rows[0][3], action === "archive" ? "archived" : "removed");
    assert.equal(store.queryObservations({ appId: identity.appId }).count, 1);
  }
});

test("record and byte bounds are explicit and pagination can retrieve the next bounded page", (t) => {
  const { store, source, ingest } = fixture(t);
  const identity = source();
  const fields = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`field${index}`, "x".repeat(1000)]));
  ingest(identity, Array.from({ length: 48 }, (_, index) => record(identity, "log.event", index, { fields })));
  const first = store.queryObservations();
  assert.equal(first.count, 48);
  assert.equal(first.bytesLimited, true);
  assert.ok(first.records.length > 0 && first.records.length < 48);
  assert.ok(first.returnedBytes <= 2 * 1024 * 1024);
  assert.equal(first.hasMore, true);
  const second = store.queryObservations({ offset: first.records.length });
  assert.equal(second.records.length + first.records.length, 48);
  assert.equal(second.hasMore, false);
  assert.equal(new Set([...first.records, ...second.records].map((entry) => entry.recordId)).size, 48);
});

test("generic scan results cannot shadow specialized Trivy reports and additive indexes reopen existing stores", (t) => {
  const { runtime, store, source, ingest, directory } = fixture(t);
  const identity = source();
  ingest(identity, [record(identity, "scan.result", 1, { fields: { scanner: "trivy", reportRef: "untrusted-claim", packageCount: 1, vulnerabilityCount: 0 } })]);
  assert.equal(store.latestScannerRecords().records.length, 0);
  assert.equal(store.queryObservations({ kinds: ["scan.result"] }).count, 1);
  const before = store.stats();
  store.db.exec("DROP INDEX telemetry_observation_time; DROP INDEX telemetry_observation_source");
  runtime.dispose();
  const reopened = new SqliteTelemetryStore({ directory, clock: () => new Date(AT) });
  try {
    assert.deepEqual(reopened.stats(), before);
    assert.equal(reopened.queryObservations().count, 1);
    assert.equal(reopened.db.prepare("SELECT count(*) AS total FROM sqlite_schema WHERE name IN ('telemetry_observation_time', 'telemetry_observation_source')").get().total, 2);
  } finally { reopened.close(); }
});

function importReport(runtime, identity) {
  const normalized = normalizeTrivyReport({ SchemaVersion: 2, CreatedAt: AT, ArtifactName: "Synthetic application artifact", ArtifactType: "filesystem", Results: [{
    Target: "synthetic-package-lock", Class: "lang-pkgs", Type: "npm", Packages: [{ Name: "mixed-package", Version: "1.0.0" }],
    Vulnerabilities: [{ VulnerabilityID: "CVE-2026-0001", PkgName: "mixed-package", InstalledVersion: "1.0.0", FixedVersion: "1.0.1", Severity: "HIGH" }]
  }] }, { sourceId: identity.sourceId, estateId: identity.appId });
  runtime.ingestScanner(normalized.batch, identity.credential, digest(normalized.batch));
  return normalized.batch.records;
}

test("mixed canonical and real Trivy ingestion validates every catalog main route and tab without conflating scanner provenance", (t) => {
  const { store, runtime, source, ingest } = fixture(t);
  const generic = source("Mixed generic application");
  const scanner = source("Mixed scanner application", "trivy-report");
  ingest(generic, RECORD_KINDS.map((kind, index) => record(generic, kind, index)));
  const scannerRecords = importReport(runtime, scanner);
  assert.equal(scannerRecords.length, 3);
  assert.equal(store.queryObservations().count, 32);
  assert.equal(store.queryObservations({ appId: scanner.appId }).count, 3);
  assert.equal(store.queryObservations({ sourceId: "missing-source" }).count, 0);
  assert.equal(store.queryObservations({ appId: "missing-app" }).count, 0);
  assert.equal(store.latestScannerRecords().records.length, 3);
  assert.ok(store.latestScannerRecords().records.every((item) => item.sourceId === scanner.sourceId));
  const trivy = runtime.readPage("/scans", { tab: "trivy" });
  assert.equal(trivy.panels.find((panel) => panel.id === "trivy-operating-system-packages").rows.length, 1);
  assert.equal(trivy.panels.find((panel) => panel.id === "trivy-vulnerabilities").rows.length, 1);
  assert.match(JSON.stringify(trivy), /mixed-package/);
  assert.doesNotMatch(JSON.stringify(trivy), /Mixed generic application/);
  assert.equal(runtime.readPage("/scans", { tab: "deps" }).panels[1].rows.length, 4);
  assert.equal(runtime.readPage("/logs", {}).panels[0].rows.length, 1);
  const context = vm.createContext({}); context.window = context;
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../public/ui-catalog.js"), "utf8"), context);
  const pages = JSON.parse(JSON.stringify(context.SocConsoleUiCatalog.pages));
  store.snapshot = () => { throw new Error("Catalog read cannot materialize history."); };
  let checked = 0;
  for (const page of pages) {
    assert.equal(runtime.readPage(page.path, {}).route, page.path);
    checked += 1;
    for (const tabset of page.tabsets || []) for (const item of tabset.items) {
      const query = Object.fromEntries(Object.entries(tabset.when || {}).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]));
      query[tabset.param] = item.id;
      Object.assign(query, item.query || {});
      const route = item.path || page.path;
      assert.equal(runtime.readPage(route, query).route, route, route + " " + JSON.stringify(query));
      checked += 1;
    }
  }
  assert.ok(checked > 130, "Main routes and nested tab selectors must all validate.");
});

test("specialized Trivy application/source filters scope actual reports and reject invalid cross-application bindings", t => {
  const { store, runtime, source } = fixture(t);
  const first = source("First scoped scanner", "trivy-report"), second = source("Second scoped scanner", "trivy-report"), generic = source("Generic non-scanner");
  importReport(runtime, first); importReport(runtime, second);
  const all = runtime.readPage("/scans", { tab: "trivy" });
  assert.equal(all.panels.find(panel => panel.id === "trivy-operating-system-packages").rows.length, 2);
  for (const scope of [{ appId: first.appId }, { sourceId: first.sourceId }, { appId: first.appId, sourceId: first.sourceId }]) {
    const selected = store.latestScannerRecords(scope); assert.equal(selected.records.length, 3); assert.ok(selected.records.every(record => record.sourceId === first.sourceId));
    const page = runtime.readPage("/scans", { tab: "trivy", ...scope }); assert.equal(page.state, "ready");
    assert.equal(page.panels.find(panel => panel.id === "trivy-operating-system-packages").rows.length, 1);
    assert.match(JSON.stringify(page), /First scoped scanner/); assert.doesNotMatch(JSON.stringify(page), /Second scoped scanner/);
  }
  const noReports = source("Scoped scanner awaiting first report", "trivy-report");
  assert.equal(runtime.readPage("/scans", { tab: "trivy", sourceId: noReports.sourceId }).state, "empty");
  for (const scope of [{ appId: first.appId, sourceId: second.sourceId }, { appId: "missing-app" }, { sourceId: "missing-source" }, { sourceId: generic.sourceId }]) {
    assert.throws(() => store.latestScannerRecords(scope), /Trivy/); assert.throws(() => runtime.readPage("/scans", { tab: "trivy", ...scope }), /Trivy/);
  }
  for (const scope of [{ appId: "bad/app" }, { sourceId: "" }, { environment: "test" }, { limit: 300 }]) assert.throws(() => store.latestScannerRecords(scope), /Trivy/);
  assert.throws(() => runtime.readPage("/scans", { tab: "trivy", environment: "test" }), /accepts only tab/);
});

test("indexed Trivy filtering occurs before the 200-source report cap and never reads unrelated source reports", () => {
  const target = { sourceId: "source-target", appId: "app-target", connectorType: "trivy-report" };
  const sources = Array.from({ length: 205 }, (_, i) => ({ sourceId: "source-other-" + i, appId: "app-other", connectorType: "trivy-report" })).concat(target);
  const calls = [], state = { apps: [{ appId: "app-target" }, { appId: "app-other" }], sources };
  const fakeStore = {
    controlSnapshot: () => state,
    prepare: sql => sql.startsWith("SELECT json FROM telemetry_records WHERE source_id = ? AND kind = 'scan.result'")
      ? { get(sourceId) { calls.push(sourceId); return { json: JSON.stringify({ recordId: sourceId, sourceId,
        observedAt: sourceId === target.sourceId ? "2026-09-01T00:00:00.000Z" : AT, payload: { fields: { reportRef: "synthetic-report" } } }) }; } }
      : sql.startsWith("SELECT COUNT") ? { get: () => ({ count: 0 }) } : { all: () => [] }
  };
  const scoped = SqliteTelemetryStore.prototype.latestScannerRecords.call(fakeStore, { appId: target.appId, sourceId: target.sourceId });
  assert.deepEqual(calls, [target.sourceId]); assert.equal(scoped.records.length, 1); assert.equal(scoped.records[0].sourceId, target.sourceId); assert.equal(scoped.sourceLimit, false);
  calls.length = 0;
  const all = SqliteTelemetryStore.prototype.latestScannerRecords.call(fakeStore);
  assert.equal(all.records.length, 200); assert.equal(all.records.some(record => record.sourceId === target.sourceId), false); assert.equal(all.sourceLimit, true);
});

test("native search/detail identifiers are rejected and presentation-only tabs are explicitly disclosed", (t) => {
  const { runtime, source, ingest } = fixture(t);
  const identity = source();
  ingest(identity, RECORD_KINDS.map((kind, index) => record(identity, kind, index)));
  const unsupported = [["/triage", { id: "case-1" }], ["/triage", { finding: "finding-1" }], ["/phishing", { id: "report-1" }],
    ["/tuning", { id: "rule-1" }], ["/rules", { ruleView: "rule-1" }], ["/intel", { q: "example.invalid" }],
    ["/intel", { oq: "example.invalid" }], ["/timeline", { host: "host-1" }], ["/scans", { tab: "patch", cve: "CVE-2026-0001" }],
    ["/access", { atab: "offboarding", id: "run-1" }]];
  for (const [route, query] of unsupported) assert.throws(() => runtime.readPage(route, query), /Unsupported observation page filter/, route);
  assert.throws(() => runtime.readPage("/triage", { view: "made-up" }), /Unknown observation presentation selector/);
  assert.throws(() => runtime.readPage("/scans", { tab: "trivy", sourceId: identity.sourceId }), /not a Trivy report source/);
  for (const query of [{ appId: "bad/app" }, { sourceId: "" }]) assert.throws(() => runtime.readPage("/timeline", query), /invalid/);
  const closed = runtime.readPage("/triage", { view: "closed" });
  assert.match(closed.panels[0].body, /Presentation-only selectors \(not applied as filters\): view=closed/);
  assert.ok(closed.panels[1].rows.every((row) => row[6] === "unknown"), "A native closed tab must not relabel producer facts.");
  const vendor = runtime.readPage("/intel", { itab: "otx" });
  assert.match(vendor.panels[0].body, /not applied as filters.*itab=otx/);
});

test("timeline time boundaries are applied and retention removes expired observations without fabricated history", (t) => {
  const f = fixture(t, { maxRecords: 29, recordDays: 1 });
  const generic = f.source("Retention application");
  const scanner = f.source("Retained scanner", "trivy-report");
  f.ingest(generic, RECORD_KINDS.map((kind, index) => record(generic, kind, index)));
  importReport(f.runtime, scanner);
  assert.equal(f.store.queryObservations().count, 29);
  assert.equal(f.store.queryObservations({ kinds: ["alert.delivery", "asset.snapshot", "audit.event"] }).count, 0);
  assert.equal(f.runtime.readPage("/alerts", {}).state, "empty");
  assert.equal(f.runtime.readPage("/alerts", {}).panels[1].rows.length, 0);
  assert.equal(f.store.queryObservations({ appId: generic.appId }).count, 26);
  f.setTime("2026-09-29T12:15:00.000Z");
  assert.equal(f.runtime.readPage("/timeline", { range: "15m" }).panels[1].rows.length, 29, "Inclusive lower time boundary.");
  f.setTime("2026-09-29T12:15:00.001Z");
  assert.equal(f.runtime.readPage("/timeline", { range: "15m" }).state, "empty");
  assert.equal(f.runtime.readPage("/timeline", { range: "1h" }).panels[1].rows.length, 29);
  f.setTime("2026-10-01T12:00:00.000Z");
  const fresh = { ...record(generic, "log.event", "fresh"), observedAt: "2026-10-01T12:00:00.000Z" };
  f.ingest(generic, [fresh]);
  assert.equal(f.store.queryObservations().count, 1);
  assert.equal(f.store.queryObservations({ sourceId: scanner.sourceId }).count, 0);
  assert.equal(f.runtime.readPage("/scans", { tab: "trivy" }).state, "empty");
  const page = f.runtime.readPage("/timeline", { range: "7d" });
  assert.match(page.summary, /1 retained observations matched/);
  assert.equal(page.panels[1].rows.length, 1);
  assert.equal(f.store.stats().identities, 33, "Retained replay fingerprints are not presented as payload history.");
});
