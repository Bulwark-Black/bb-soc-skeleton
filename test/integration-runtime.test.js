"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ReferenceControlPlane } = require("../server/reference-runtime");
const { ReferenceStateStore, emptyState, validateState } = require("../server/reference-store");
const { SqliteTelemetryStore } = require("../server/sqlite-telemetry-store");
const { CANONICAL_EVENTS_MANIFEST } = require("../server/reference-manifest");
const { MAX_CUSTOM_INTEGRATIONS, getIntegrationManifests, validateCustomManifest } = require("../server/integration-catalog");
const { runAsOperator, runAsService, operatorId } = require("../server/operator-context");
const { RECORD_KINDS } = require("../tools/ingest-contract");

const NOW = "2026-09-29T12:00:00.000Z";
const clock = () => new Date(NOW);
const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const human = (callback) => runAsOperator("integration-review-operator", callback);
function manifest(type = "custom-events", kinds = ["log.event", "authentication.event", "finding"]) {
  const value = structuredClone(CANONICAL_EVENTS_MANIFEST);
  value.connectorType = type;
  value.displayName = "Custom event sender";
  value.supportedSourceKinds = ["custom.events"];
  value.payload.recordKinds = kinds;
  value.targets = [{ route: "/sources", surfaces: ["expected-sources"], recordKinds: kinds }];
  return value;
}
function fixture(t, { indexed = true, enabled = true } = {}) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "bb-soc-integration-test-"));
  const open = (enable = enabled) => new ReferenceControlPlane({ clock,
    store: indexed ? new SqliteTelemetryStore({ directory, clock }) : new ReferenceStateStore({ directory, clock }),
    ...(enable ? { enabledConnectorTypes: ["canonical-push", "canonical-events", "trivy-report"] } : {}) });
  const f = { directory, runtime: open(), sequence: 0 };
  t.after(() => { f.runtime.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  f.reopen = (enable = enabled) => { f.runtime.dispose(); f.runtime = open(enable); };
  f.command = (command, input) => human(() => f.runtime.execute({ schemaVersion: "1", documentType: "connector-command-request",
    requestId: "integration-command-" + (++f.sequence), command, requestedAt: NOW, input }));
  f.install = (value = manifest()) => human(() => f.runtime.installIntegration({ manifest: value, expectedRevision: f.runtime.controlState().revision }));
  f.remove = (connectorType) => human(() => f.runtime.removeIntegration({ connectorType, expectedRevision: f.runtime.controlState().revision }));
  f.source = (type = "custom-events", sourceKind = "custom.events") => {
    const app = f.command("app.register", { displayName: "Integration application " + f.sequence, publicPages: [], environments: ["live"] });
    assert.equal(app.status, "succeeded");
    const setup = f.command("source.setup", { appId: app.output.appId, connectorType: type, sourceKind,
      displayName: "Application event source", environment: "live", config: { "cadence-seconds": 300 }, credentialReferences: [] });
    assert.equal(setup.status, "succeeded");
    return { ...setup.output, appId: app.output.appId };
  };
  f.input = (identity) => ({ sourceId: identity.sourceId, connectorInstanceId: identity.connectorInstanceId,
    expectedRevision: f.runtime.controlState().sources.find((source) => source.sourceId === identity.sourceId).revision });
  f.activate = (identity, kind = "log.event") => {
    const result = f.command("source.test", { ...f.input(identity), recordSample: record(identity, kind, "redacted-source-validation") });
    assert.equal(result.status, "succeeded", JSON.stringify(result));
    const activated = f.command("source.activate", f.input(identity));
    assert.equal(activated.status, "succeeded");
    identity.credential = activated.output.oneTimeCredential.value;
    return identity;
  };
  return f;
}
function record(identity, kind, id = kind.replaceAll(".", "-")) {
  return { schemaVersion: "1", documentType: "normalized-record", recordId: id, sourceId: identity.sourceId,
    estateId: identity.appId, kind, observedAt: NOW, payload: {
      title: "Synthetic integration fact", state: "unknown", severity: "unknown", assetRef: "synthetic-app",
      identityRef: "synthetic-identity", ruleRef: "synthetic-rule", findingRef: "synthetic-finding",
      indicatorType: "domain", indicator: "example.invalid", message: "Synthetic integration event", category: "synthetic"
    } };
}
function batch(identity, kinds, receiptId = "integration-receipt-0001") {
  return { schemaVersion: "1", documentType: "ingest-batch", sourceId: identity.sourceId, receiptId, sentAt: NOW,
    records: kinds.map((kind) => record(identity, kind)) };
}

test("universal canonical admission accepts all 29 kinds without hosts and survives restart", (t) => {
  const f = fixture(t);
  const catalog = f.runtime.listIntegrations();
  assert.equal(catalog.integrations.length, 14);
  assert.equal(catalog.capacity.customMaximum, 86);
  const identity = f.activate(f.source("canonical-events", "authentication.event"), "authentication.event");
  assert.equal(f.runtime.controlState().hosts.length, 0);
  assert.equal(f.runtime.getState().records.length, 0, "source tests never fabricate telemetry");
  assert.doesNotMatch(JSON.stringify(f.runtime.getState()), /redacted-source-validation/);
  const delivery = batch(identity, RECORD_KINDS);
  assert.equal(f.runtime.ingest(delivery, identity.credential, digest(delivery)).accepted, 29);
  const before = f.runtime.getState();
  f.reopen();
  assert.deepEqual(f.runtime.getState(), before);
  assert.equal(f.runtime.ingest(delivery, identity.credential, digest(delivery)).replay, true);
  assert.equal(f.runtime.getSnapshot({ schemaVersion: "1", reason: "refresh" }).sources[0].health.state, "healthy");
});

test("custom declarations are human-installed, immutable, revisioned, atomic and audited", (t) => {
  const f = fixture(t);
  const input = { manifest: manifest(), expectedRevision: 0 };
  assert.throws(() => f.runtime.installIntegration(input), (error) => error.status === 403);
  assert.throws(() => runAsService("review-agent", () => f.runtime.installIntegration(input)), (error) => error.status === 403);
  assert.throws(() => human(() => f.runtime.installIntegration({ ...input, expectedRevision: 1 })), (error) => error.code === "revision-conflict");
  assert.equal(f.runtime.controlState().revision, 0);
  const installed = f.install();
  assert.equal(installed.revision, 1);
  assert.equal(installed.integrations.at(-1).origin, "custom");
  assert.equal(installed.integrations.at(-1).available, true);
  assert.equal(installed.integrations.at(-1).removable, true);
  assert.throws(() => f.install(), (error) => error.code === "already-exists");
  const altered = manifest(); altered.payload.recordKinds = ["log.event"];
  altered.targets[0].recordKinds = ["log.event"];
  assert.throws(() => f.install(altered), (error) => error.code === "already-exists");
  assert.equal(f.runtime.controlState().revision, 1);
  const audit = f.runtime.store.db.prepare("SELECT json FROM telemetry_audit WHERE revision = 1").get();
  assert.equal(JSON.parse(audit.json).actor, operatorId("integration-review-operator"));
  f.runtime.store.db.exec("CREATE TEMP TRIGGER reject_integration_audit BEFORE INSERT ON telemetry_audit BEGIN SELECT RAISE(ABORT, 'integration rollback'); END");
  assert.throws(() => f.install(manifest("will-roll-back")), /integration rollback/);
  assert.equal(f.runtime.listIntegrations().capacity.customInstalled, 1);
  assert.equal(f.runtime.controlState().revision, 1);
  f.runtime.store.db.exec("DROP TRIGGER reject_integration_audit");
  assert.equal(f.remove("custom-events").capacity.customInstalled, 0);
  assert.throws(() => f.remove("canonical-events"), (error) => error.status === 404);
});

test("custom multikind sources enforce source/app/kind bindings and lifecycle after restart", (t) => {
  const f = fixture(t);
  f.install();
  const identity = f.activate(f.source());
  const second = f.activate(f.source());
  const delivery = batch(identity, ["log.event", "authentication.event", "finding"]);
  assert.equal(f.runtime.ingest(delivery, identity.credential, digest(delivery)).accepted, 3);
  const unchanged = f.runtime.controlState();
  const wrongKind = batch(identity, ["scan.result"], "integration-receipt-denied");
  assert.throws(() => f.runtime.ingest(wrongKind, identity.credential, digest(wrongKind)), (error) => error.code === "validation-failed");
  const wrongApp = batch(identity, ["log.event"], "integration-receipt-wrong-app"); wrongApp.records[0].estateId = second.appId;
  assert.throws(() => f.runtime.ingest(wrongApp, identity.credential, digest(wrongApp)), (error) => error.status === 403);
  assert.throws(() => f.runtime.ingest(delivery, second.credential, digest(delivery)), (error) => error.status === 403);
  const unknown = batch(identity, ["vendor.unknown"], "integration-receipt-unknown");
  assert.throws(() => f.runtime.ingest(unknown, identity.credential, digest(unknown)), /kind is unsupported/);
  assert.deepEqual(f.runtime.controlState(), unchanged, "rejected deliveries change no receipts, health, audit or credentials");
  f.reopen();
  assert.equal(f.runtime.ingest(delivery, identity.credential, digest(delivery)).replay, true);
  assert.equal(f.command("source.pause", f.input(identity)).status, "succeeded");
  assert.throws(() => f.runtime.ingest(delivery, identity.credential, digest(delivery)), (error) => error.status === 409);
  assert.equal(f.command("source.resume", f.input(identity)).status, "succeeded");
  assert.equal(f.command("source.archive", f.input(identity)).status, "succeeded");
  assert.equal(f.command("source.remove", f.input(identity)).status, "succeeded");
  assert.equal(f.runtime.listIntegrations().integrations.at(-1).removable, false);
  assert.throws(() => f.remove("custom-events"), /including archived or removed tombstones/);
  assert.equal(f.runtime.getState().records.length, 3);
});

test("complete source samples are validated without retention and arbitrary scanner templates stay disabled", (t) => {
  const f = fixture(t);
  f.install(manifest("narrow-auth", ["authentication.event"]));
  const identity = f.source("narrow-auth");
  assert.equal(f.command("source.test", f.input(identity)).error.code, "test-failed");
  for (const invalid of [record(identity, "log.event"), { ...record(identity, "authentication.event"), estateId: "app-00000000-0000-0000-0000-000000000000" },
    { ...record(identity, "authentication.event"), observedAt: "2026-09-29T12:06:00.000Z" }]) {
    assert.equal(f.command("source.test", { ...f.input(identity), recordSample: invalid }).error.code, "test-failed");
  }
  f.activate(identity, "authentication.event");
  assert.equal(f.runtime.getState().records.length, 0);
  assert.equal(f.runtime.listIntegrations().integrations.filter((entry) => entry.manifest.connectorType.endsWith("-template")).every((entry) => !entry.available), true);
  assert.throws(() => new ReferenceControlPlane({ stateDirectory: f.directory, enabledConnectorTypes: ["trivy-template"] }), /unimplemented/);
  assert.throws(() => f.command("source.setup", { appId: identity.appId, connectorType: "missing-driver", sourceKind: "custom.events", displayName: "Missing source", config: {}, credentialReferences: [] }), /unavailable/);
});

test("reference default keeps universal and installed custom drivers disabled without losing history", (t) => {
  const f = fixture(t, { indexed: false });
  f.install();
  const identity = f.activate(f.source());
  const delivery = batch(identity, ["authentication.event"]);
  assert.equal(f.runtime.ingest(delivery, identity.credential, digest(delivery)).accepted, 1);
  f.reopen(false);
  assert.equal(f.runtime.listIntegrations().integrations.find((entry) => entry.manifest.connectorType === "custom-events").available, false);
  assert.throws(() => f.runtime.ingest(delivery, identity.credential, digest(delivery)), (error) => error.code === "connector-unavailable");
  assert.throws(() => f.install(manifest("disabled-install")), (error) => error.code === "connector-unavailable");
  const universal = f.source("canonical-events", "log.event");
  assert.equal(f.command("source.test", { ...f.input(universal), recordSample: record(universal, "log.event") }).error.code, "connector-unavailable");
  assert.equal(f.command("source.rotate", f.input(identity)).error.code, "connector-unavailable");
  assert.equal(f.runtime.getState().records.length, 1);
  f.reopen(true);
  assert.equal(f.runtime.ingest(delivery, identity.credential, digest(delivery)).replay, true);
});

test("old control state remains byte-shape compatible and migrates before first custom install", (t) => {
  const f = fixture(t, { indexed: false });
  assert.equal(Object.hasOwn(f.runtime.getState(), "integrationManifests"), false);
  assert.deepEqual(validateState(emptyState()), emptyState());
  const source = f.source("canonical-events", "finding");
  f.activate(source, "finding");
  const delivery = batch(source, ["finding"]);
  f.runtime.ingest(delivery, source.credential, digest(delivery));
  const before = f.runtime.getState();
  f.runtime.dispose();
  f.runtime = new ReferenceControlPlane({ clock, store: new SqliteTelemetryStore({ directory: f.directory, clock }),
    enabledConnectorTypes: ["canonical-push", "canonical-events"] });
  assert.deepEqual(f.runtime.getState(), before);
  f.install();
  assert.equal(f.runtime.getState().integrationManifests.length, 1);
  assert.equal(f.runtime.ingest(delivery, source.credential, digest(delivery)).replay, true);
});

test("registry validation rejects executable, remote-secret and incompatible declarations and preserves bounded capacity", () => {
  const mutations = [
    (m) => { m.connectorType = "canonical-push"; }, (m) => { m.scope = "host"; },
    (m) => { m.healthPolicy.deliveryMode = "poll"; }, (m) => { m.payload.schemaId = "vendor.schema"; },
    (m) => { m.payload.schemaVersion = "2"; }, (m) => { m.payload.lines = "required"; },
    (m) => { m.payload.content = "optional"; }, (m) => { m.healthPolicy.emptyPayloadIsHealthy = true; },
    (m) => { m.configFields = []; }, (m) => { m.configFields[0].required = false; },
    (m) => { m.payload.recordKinds = ["vendor.unknown"]; }, (m) => { m.execute = "untrusted module"; },
    (m) => { m.credentialSlots = [{ key: "provider-access", label: "Provider access", kind: "api-key", required: true }]; }
  ];
  for (const mutate of mutations) { const value = manifest(); mutate(value); assert.throws(() => validateCustomManifest(value)); }
  const duplicates = { ...emptyState(), integrationManifests: [manifest(), manifest()] };
  assert.throws(() => validateState(duplicates), /unique and immutable/);
  const full = { ...emptyState(), integrationManifests: Array.from({ length: MAX_CUSTOM_INTEGRATIONS }, (_, index) => manifest("custom-" + index)) };
  assert.equal(getIntegrationManifests(full).length, 100);
  assert.doesNotThrow(() => validateState(full));
  full.integrationManifests.push(manifest("too-many"));
  assert.throws(() => validateState(full), /bounded capacity/);
});
