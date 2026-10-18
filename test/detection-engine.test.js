"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ReferenceControlPlane } = require("../server/reference-runtime");
const { SqliteTelemetryStore } = require("../server/sqlite-telemetry-store");
const { createDetectionEngine, configuration } = require("../server/detection-engine");
const { normalizeVendorPayload } = require("../tools/vendor-adapters");
const START = Date.parse("2026-10-18T12:00:00.000Z");
const digest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const BURST = "windows.failed-logon-burst", CLEARED = "windows.audit-log-cleared";

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "bb-detection-test-"));
  let current = START, sequence = 0, config;
  const clock = () => new Date(current);
  const open = () => new ReferenceControlPlane({ clock, store: new SqliteTelemetryStore({ directory, clock }), enabledConnectorTypes: ["canonical-events"] });
  const f = { directory, runtime: open(), now: () => clock().toISOString(), advance: value => { current += value; } };
  t.after(() => { f.runtime.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  f.command = (command, input) => {
    const result = f.runtime.execute({ schemaVersion: "1", documentType: "connector-command-request", requestId: "detection-command-" + (++sequence), command, requestedAt: f.now(), input });
    assert.equal(result.status, "succeeded", JSON.stringify(result)); return result.output;
  };
  f.app = () => f.command("app.register", { displayName: "Synthetic detection application", environments: ["test"], publicPages: [] }).appId;
  f.event = (source, changes = {}, fields = {}) => ({ schemaVersion: "1", documentType: "normalized-record", sourceId: source.sourceId, estateId: source.appId,
    recordId: "detection-event-" + (++sequence), kind: "log.event", observedAt: f.now(), payload: { title: "Synthetic Windows event", state: "failed", message: "Synthetic audit evidence",
      fields: { provider: "windows-eventlog", providerName: "Microsoft-Windows-Security-Auditing", channel: "Security", eventId: 4625, eventVersion: 0,
        computer: "server.example.invalid", "win.TargetUserName": "synthetic-user", "win.IpAddress": "synthetic-client", ...fields } }, ...changes });
  f.source = appId => {
    const source = { appId, ...f.command("source.setup", { appId, environment: "test", connectorType: "canonical-events", sourceKind: "log.event", displayName: "Synthetic Windows source", config: { "cadence-seconds": 60 }, credentialReferences: [] }) };
    const input = () => ({ sourceId: source.sourceId, connectorInstanceId: source.connectorInstanceId, expectedRevision: f.runtime.controlState().sources.find(row => row.sourceId === source.sourceId).revision });
    f.command("source.test", { ...input(), recordSample: f.event(source) });
    source.credential = f.command("source.activate", input()).oneTimeCredential.value; return source;
  };
  f.enable = applications => {
    config = { schemaVersion: 1, applications };
    f.runtime.detectionEngine = createDetectionEngine({ store: f.runtime.store, stateDir: directory, config, now: () => current });
    return f.runtime.detectionEngine;
  };
  f.reopen = () => {
    f.runtime.dispose(); f.runtime = open();
    f.runtime.detectionEngine = createDetectionEngine({ store: f.runtime.store, stateDir: directory, config, now: () => current });
  };
  f.batch = (source, records) => ({ schemaVersion: "1", documentType: "ingest-batch", sourceId: source.sourceId, receiptId: "detection-receipt-" + (++sequence), sentAt: f.now(), records });
  f.ingest = (source, batch) => f.runtime.ingest(batch, source.credential, digest(batch));
  f.findings = () => f.runtime.store.snapshot().records.filter(record => record.kind === "finding");
  f.count = table => f.runtime.store.db.prepare("SELECT count(*) n FROM " + table).get().n;
  f.appId = f.app(); f.identity = f.source(f.appId);
  return f;
}

const policy = (appId, rules) => ({ appId, rules: rules.map(rule => typeof rule === "string" ? { id: rule } : rule) });
const cleared = (f, source = f.identity, fields = {}) => f.event(source, {}, { eventId: 1102, providerName: "Microsoft-Windows-Eventlog", ...fields });

test("detections are disabled by default and policy validation fails closed", t => {
  const f = fixture(t);
  f.runtime.detectionEngine = createDetectionEngine({ store: f.runtime.store, stateDir: f.directory, now: () => START });
  assert.ok(f.runtime.detectionEngine.catalog(f.appId).rules.every(rule => !rule.enabled));
  assert.equal(f.runtime.detectionEngine.catalog(f.appId).sigmaExecution, false);
  f.ingest(f.identity, f.batch(f.identity, [cleared(f)]));
  assert.equal(f.findings().length, 0); assert.equal(f.count("detection_matches"), 0);
  const config = rules => ({ schemaVersion: 1, applications: [policy(f.appId, rules)] });
  for (const rules of [["unknown-rule"], [CLEARED, CLEARED], [{ id: CLEARED, threshold: 2 }], [{ id: BURST, threshold: 1 }], [{ id: BURST, windowSeconds: 59 }]]) {
    assert.throws(() => configuration(config(rules)));
  }
  assert.throws(() => createDetectionEngine({ store: f.runtime.store, config: { schemaVersion: 1, applications: [policy("unregistered-app", [CLEARED])] } }), /Register each application/);
  assert.throws(() => f.runtime.detectionEngine.derive([cleared(f)]), /share the telemetry admission transaction/);
});

test("admitted evidence and original findings commit together with truthful receipt counts", t => {
  const f = fixture(t); f.enable([policy(f.appId, [CLEARED])]);
  const event = cleared(f), batch = f.batch(f.identity, [event]), receipt = f.ingest(f.identity, batch);
  assert.equal(receipt.accepted, 1); assert.equal(receipt.duplicates, 0);
  assert.equal(f.runtime.store.stats().records, 2); assert.equal(f.count("detection_matches"), 1);
  const [finding] = f.findings();
  assert.equal(finding.sourceId, event.sourceId); assert.equal(finding.estateId, event.estateId); assert.equal(finding.observedAt, event.observedAt);
  assert.equal(finding.payload.ruleRef, CLEARED); assert.equal(finding.payload.state, "open"); assert.equal(finding.payload.count, 1);
  assert.equal(finding.payload.fields.evidenceRecordId, event.recordId); assert.equal(finding.payload.fields.evidenceDigest, digest([event.recordId]));
  assert.equal(finding.payload.fields.ruleVersion, 1); assert.equal(finding.payload.fields.ruleLicense, "MIT");
  assert.equal(finding.payload.fields.evaluationMode, "single-event"); assert.match(finding.payload.summary, /not a confirmed compromise/);
  assert.equal(f.runtime.store.queryObservations({ kinds: ["finding"] }).count, 1);
});

test("audit failure rolls back observations, matches, records, source health and receipt before retry", t => {
  const f = fixture(t); f.enable([policy(f.appId, [{ id: BURST, threshold: 2 }])]);
  const batch = f.batch(f.identity, [f.event(f.identity), f.event(f.identity)]), before = f.runtime.store.snapshot();
  f.runtime.store.db.exec("CREATE TEMP TRIGGER fail_detection_test BEFORE INSERT ON telemetry_audit BEGIN SELECT RAISE(ABORT, 'synthetic detection rollback'); END");
  assert.throws(() => f.ingest(f.identity, batch), /synthetic detection rollback/);
  assert.deepEqual(f.runtime.store.snapshot(), before); assert.equal(f.count("detection_observations"), 0); assert.equal(f.count("detection_matches"), 0);
  f.runtime.store.db.exec("DROP TRIGGER fail_detection_test");
  assert.equal(f.ingest(f.identity, batch).accepted, 2); assert.equal(f.findings().length, 1); assert.equal(f.count("detection_observations"), 2);
});

test("receipt replay, record replay, restart and direct repeated evaluation cannot multiply findings", t => {
  const f = fixture(t); f.enable([policy(f.appId, [CLEARED, { id: BURST, threshold: 2 }])]);
  const records = [cleared(f), f.event(f.identity), f.event(f.identity)], batch = f.batch(f.identity, records);
  f.ingest(f.identity, batch); const ids = f.findings().map(record => record.recordId).sort(), before = f.runtime.store.snapshot();
  assert.equal(ids.length, 2); assert.equal(f.ingest(f.identity, batch).replay, true); assert.deepEqual(f.runtime.store.snapshot(), before);
  f.reopen(); assert.equal(f.ingest(f.identity, batch).replay, true);
  const receipt = f.ingest(f.identity, f.batch(f.identity, records)); assert.equal(receipt.accepted, 0); assert.equal(receipt.duplicates, 3);
  const repeated = f.runtime.store.db.transaction(() => f.runtime.detectionEngine.derive(records))(); assert.deepEqual(repeated, []);
  assert.deepEqual(f.findings().map(record => record.recordId).sort(), ids); assert.equal(f.count("detection_observations"), 2); assert.equal(f.count("detection_matches"), 2);
});

test("Windows provider, channel and event version gates survive actual vendor normalization", t => {
  const f = fixture(t); f.enable([policy(f.appId, [CLEARED])]);
  const event = { computer: "server.example.invalid", channel: "Security", collectionChannel: "ForwardedEvents", logEpoch: "synthetic-epoch", eventRecordId: "18446744073709551615",
    eventId: 1102, eventVersion: 0, providerName: "Microsoft-Windows-Eventlog", timeCreated: f.now(), userData: { SubjectUserName: "synthetic-operator" } };
  const input = [event, ...[{ eventVersion: 1 }, { channel: "Application" }, { providerName: "Microsoft-Windows-Security-Auditing" }].map((patch, index) => ({ ...event, eventRecordId: String(index + 1), ...patch }))];
  const mapped = normalizeVendorPayload("windows-eventlog", input, { sourceId: f.identity.sourceId, estateId: f.appId });
  f.ingest(f.identity, f.batch(f.identity, mapped.batch.records));
  assert.equal(f.runtime.store.logSummary().count, 4); assert.equal(f.findings().length, 1);
  assert.equal(f.findings()[0].payload.fields.evidenceRecordId, mapped.batch.records.find(record => record.payload.fields.eventRecordId === event.eventRecordId).recordId);
});

test("out-of-order evidence correlates within fixed event-time buckets without crossing their boundary", t => {
  const f = fixture(t); f.enable([policy(f.appId, [{ id: BURST, threshold: 3, windowSeconds: 300 }])]); f.advance(600000);
  const eventAt = offset => f.event(f.identity, { observedAt: new Date(START + offset).toISOString() });
  const newest = eventAt(250000), oldest = eventAt(10000), middle = eventAt(100000);
  f.ingest(f.identity, f.batch(f.identity, [newest])); f.ingest(f.identity, f.batch(f.identity, [oldest])); assert.equal(f.findings().length, 0);
  f.ingest(f.identity, f.batch(f.identity, [middle])); const [finding] = f.findings();
  assert.equal(finding.payload.count, 3); assert.equal(finding.payload.fields.evidenceDigest, digest([oldest.recordId, middle.recordId, newest.recordId]));
  assert.equal(finding.payload.fields.evaluationMode, "fixed-event-time-window"); assert.equal(finding.payload.fields.windowSeconds, 300);
  f.ingest(f.identity, f.batch(f.identity, [eventAt(299999), eventAt(300000), eventAt(300001)])); assert.equal(f.findings().length, 1, "Two events in the next bucket cannot borrow earlier evidence.");
  f.ingest(f.identity, f.batch(f.identity, [eventAt(300002)])); assert.equal(f.findings().length, 2);
});

test("threshold state is partitioned by source, application and complete grouping fields", t => {
  const f = fixture(t), secondSource = f.source(f.appId), secondApp = f.app(), otherAppSource = f.source(secondApp);
  f.enable([policy(f.appId, [{ id: BURST, threshold: 2 }]), policy(secondApp, [{ id: BURST, threshold: 2 }])]);
  const sameId = "shared-upstream-record";
  for (const source of [f.identity, secondSource, otherAppSource]) f.ingest(source, f.batch(source, [f.event(source, { recordId: sameId })]));
  assert.equal(f.findings().length, 0); assert.equal(f.count("detection_observations"), 3);
  for (const source of [f.identity, secondSource, otherAppSource]) f.ingest(source, f.batch(source, [f.event(source)]));
  assert.equal(f.findings().length, 3); assert.equal(new Set(f.findings().map(row => row.sourceId)).size, 3);
  const noGroupSource = f.source(f.appId), missing = f.event(noGroupSource); delete missing.payload.fields["win.IpAddress"];
  const invalid = [missing, ...["", " ", "-", "::", [0, 0, 0, 0].join(".")].map(value => f.event(noGroupSource, {}, { "win.IpAddress": value }))];
  f.ingest(noGroupSource, f.batch(noGroupSource, invalid)); assert.equal(f.count("detection_observations"), 6);
  f.ingest(noGroupSource, f.batch(noGroupSource, [f.event(noGroupSource, {}, { "win.TargetUserName": "one" }), f.event(noGroupSource, {}, { "win.TargetUserName": "two" })]));
  assert.equal(f.findings().length, 3, "Different complete identities must not combine.");
});

test("a changed threshold policy starts separate evidence and a disabled app adds no observations", t => {
  const f = fixture(t); f.enable([policy(f.appId, [{ id: BURST, threshold: 2 }])]);
  f.ingest(f.identity, f.batch(f.identity, [f.event(f.identity), f.event(f.identity)])); const original = f.findings()[0];
  f.enable([policy(f.appId, [{ id: BURST, threshold: 3 }])]); f.reopen();
  f.ingest(f.identity, f.batch(f.identity, [f.event(f.identity), f.event(f.identity)])); assert.equal(f.findings().length, 1);
  f.ingest(f.identity, f.batch(f.identity, [f.event(f.identity)])); const changed = f.findings().find(row => row.recordId !== original.recordId);
  assert.ok(changed); assert.equal(changed.payload.count, 3); assert.notEqual(changed.payload.fields.policyRevision, original.payload.fields.policyRevision);
  assert.equal(f.count("detection_observations"), 5);
  f.enable([]); f.ingest(f.identity, f.batch(f.identity, [f.event(f.identity), cleared(f)]));
  assert.equal(f.count("detection_observations"), 5); assert.equal(f.findings().length, 2);
});

test("historical logs remain searchable while expired threshold evidence is excluded and pruned", t => {
  const f = fixture(t); f.enable([policy(f.appId, [{ id: BURST, threshold: 2 }])]);
  f.ingest(f.identity, f.batch(f.identity, [f.event(f.identity)])); assert.equal(f.count("detection_observations"), 1);
  f.advance(86400001);
  const historical = () => f.event(f.identity, { observedAt: new Date(START).toISOString() });
  f.ingest(f.identity, f.batch(f.identity, [historical(), historical()]));
  assert.equal(f.count("detection_observations"), 0); assert.equal(f.findings().length, 0); assert.equal(f.runtime.store.logSummary().count, 3);
  f.ingest(f.identity, f.batch(f.identity, [f.event(f.identity), f.event(f.identity)])); assert.equal(f.findings().length, 1);
});
