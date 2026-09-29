"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ConnectorRuntime = require("../public/connector-contract");
const { RECORD_KINDS, validateIngestBatch, validateNormalizedRecord } = require("../tools/ingest-contract");
const {
  REFERENCE_CONNECTOR_MANIFEST,
  REFERENCE_CONNECTOR_MANIFESTS,
  REFERENCE_SCAN_CONNECTOR_MANIFESTS,
  scaledHealthThresholds
} = require("../server/reference-manifest");
const { ReferenceControlError, ReferenceControlPlane, validateConnectionCheck } = require("../server/reference-runtime");
const { CSP, HOST, startReferenceServer } = require("../server/reference-control-plane");
const { ReferenceStateStore, hashCredential, validateState } = require("../server/reference-store");

const START = Date.parse("2026-08-30T10:00:00.000Z");

test("application sources validate real samples and preserve environment, delivery, and lifecycle across restart", (t) => {
  const harness = createReferenceHarness(t);
  let sequence = 0;
  const execute = (command, input) => harness.plane.execute(harness.command(`app-flow-${++sequence}`, command, input));
  const registered = execute("app.register", { displayName: "Application under test", hosts: [], publicPages: [], environments: ["preview", "live"] });
  assert.equal(registered.status, "succeeded");
  const appId = registered.output.appId;
  assert.equal(harness.plane.getState().hosts.length, 0);
  const configured = execute("source.setup", { appId, environment: "live", connectorType: "canonical-push", sourceKind: "log.event",
    displayName: "Application events", config: { "cadence-seconds": 300 }, credentialReferences: [] });
  assert.equal(configured.status, "succeeded");
  const sourceId = configured.output.sourceId;
  const connectorInstanceId = configured.output.connectorInstanceId;
  const revisionInput = () => ({ sourceId, connectorInstanceId, expectedRevision: harness.plane.getState().sources[0].revision });
  const untested = execute("source.test", revisionInput());
  assert.equal(untested.error.code, "test-failed");
  assert.equal(execute("source.test", { ...revisionInput(), sample: { message: "A real redacted application line", channel: "application" } }).status, "succeeded");
  assert.equal(harness.plane.getState().records.length, 0, "sample validation never fabricates telemetry");
  assert.equal(JSON.stringify(harness.plane.getState()).includes("A real redacted application line"), false, "sample text is never retained in command state");
  const activationRequest = harness.command("app-flow-activate", "source.activate", revisionInput());
  const activation = harness.plane.execute(activationRequest);
  assert.equal(activation.status, "succeeded");
  let credential = activation.output.oneTimeCredential.value;
  const batch = logBatch({ appId, sourceId, at: harness.clock().toISOString(), message: "Admitted application event", receiptId: "application-receipt-0001", recordId: "application-event-1" });
  assert.equal(harness.plane.ingest(batch, credential, digest(batch)).accepted, 1);
  assert.equal(harness.plane.ingest(batch, credential, digest(batch)).replay, true);
  assert.equal(harness.plane.getSnapshot({ schemaVersion: "1", reason: "refresh" }).sources[0].environment, "live");
  for (const route of ["/", "/sources", "/logs", "/analytics", "/health"]) assert.equal(harness.plane.readPage(route, {}).state, "ready");
  const pauseRequest = harness.command("app-flow-pause", "source.pause", revisionInput());
  assert.equal(harness.plane.execute(pauseRequest).status, "succeeded");
  assert.throws(() => harness.plane.ingest(batch, credential, digest(batch)), (error) => error.code === "activation-blocked");
  assert.equal(harness.plane.execute(pauseRequest).status, "succeeded", "lifecycle retries are idempotent");
  assert.equal(execute("source.resume", revisionInput()).status, "succeeded");
  const oldCredential = credential;
  const rotateRequest = harness.command("app-flow-rotate", "source.rotate", revisionInput());
  const rotated = harness.plane.execute(rotateRequest);
  credential = rotated.output.oneTimeCredential.value;
  assert.throws(() => harness.plane.ingest(batch, oldCredential, digest(batch)), (error) => error.code === "not-authorized");
  assert.equal(harness.plane.execute(rotateRequest).output.oneTimeCredential, undefined);
  assert.equal(execute("source.revoke", revisionInput()).status, "succeeded");
  assert.throws(() => harness.plane.ingest(batch, credential, digest(batch)), (error) => error.code === "not-authorized");
  assert.equal(execute("source.resume", revisionInput()).error.code, "activation-blocked");
  assert.equal(execute("source.rotate", revisionInput()).status, "succeeded");
  assert.equal(execute("source.update", { ...revisionInput(), displayName: "Updated events", config: { "cadence-seconds": 600 } }).status, "succeeded");
  assert.equal(harness.plane.getState().sources[0].state, "configured");
  assert.equal(execute("source.activate", revisionInput()).error.code, "activation-blocked");
  assert.equal(execute("source.test", { ...revisionInput(), sample: { message: "Updated redacted sample" } }).status, "succeeded");
  const reactivated = execute("source.activate", revisionInput());
  credential = reactivated.output.oneTimeCredential.value;
  harness.plane.dispose();
  harness.plane = new ReferenceControlPlane({ stateDirectory: harness.directory, clock: harness.clock });
  assert.equal(harness.plane.getState().sources[0].environment, "live");
  assert.equal(harness.plane.ingest(batch, credential, digest(batch)).replay, true);
  assert.equal(harness.plane.execute(activationRequest).output.oneTimeCredential, undefined);
  assert.equal(execute("source.remove", revisionInput()).error.code, "activation-blocked");
  assert.equal(execute("source.archive", revisionInput()).status, "succeeded");
  assert.throws(() => harness.plane.ingest(batch, credential, digest(batch)), (error) => error.code === "not-authorized");
  assert.equal(execute("source.remove", revisionInput()).status, "succeeded");
  assert.equal(harness.plane.getSnapshot({ schemaVersion: "1", reason: "refresh" }).sources.length, 0);
  assert.equal(harness.plane.getState().sources[0].state, "removed", "removal preserves a tombstone");
  assert.equal(harness.plane.getState().records.length, 1, "removal preserves admitted history");
  assert.equal(harness.plane.readPage("/logs", {}).state, "ready");
  const invalidEnvironment = execute("source.setup", { appId, environment: "absent", connectorType: "canonical-push", sourceKind: "log.event",
    displayName: "Invalid environment", config: { "cadence-seconds": 300 }, credentialReferences: [] });
  assert.equal(invalidEnvironment.error.code, "validation-failed");
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createReferenceHarness(t) {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(temporaryRoot, "bb-soc-reference-test-"));
  let instant = START;
  let plane = new ReferenceControlPlane({
    stateDirectory: directory,
    clock: () => new Date(instant)
  });
  t.after(() => {
    if (plane) plane.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    get plane() { return plane; },
    set plane(value) { plane = value; },
    advance(milliseconds = 1000) {
      instant += milliseconds;
      return new Date(instant);
    },
    command(requestId, command, input) {
      return {
        schemaVersion: "1",
        documentType: "connector-command-request",
        requestId,
        command,
        requestedAt: new Date(instant).toISOString(),
        input
      };
    },
    clock() { return new Date(instant); }
  };
}

function registerAndProveHost(harness) {
  const registerRequest = harness.command("request-register", "app.register", {
    displayName: "Reference application",
    hosts: ["host-alpha"],
    publicPages: ["https://app.example.invalid/"]
  });
  const registerResult = harness.plane.execute(registerRequest);
  assert.equal(registerResult.status, "succeeded");

  const registered = harness.plane.getSnapshot({ schemaVersion: "1", reason: "refresh" });
  const app = registered.apps[0];
  const host = registered.hosts[0];
  harness.advance();
  const enrollRequest = harness.command("request-enroll", "host.enroll", {
    appId: app.appId,
    hostId: host.hostId
  });
  const enrollResult = harness.plane.execute(enrollRequest);
  assert.equal(enrollResult.status, "succeeded");
  assert.equal(enrollResult.output.oneTimeCredential.purpose, "connection-check");
  const enrollmentCredential = enrollResult.output.oneTimeCredential.value;

  const replay = harness.plane.execute(enrollRequest);
  assert.equal(replay.status, "succeeded");
  assert.equal(Object.prototype.hasOwnProperty.call(replay.output, "oneTimeCredential"), false,
    "a retried command never replays one-time credential material");

  harness.advance();
  const connectionCheck = {
    schemaVersion: "1",
    documentType: "connection-check",
    appId: app.appId,
    hostId: host.hostId,
    observedAt: harness.clock().toISOString(),
    nonce: "connection-nonce-1"
  };
  const proof = harness.plane.proveConnection(connectionCheck, enrollmentCredential);
  assert.equal(proof.status, "accepted");
  assert.throws(
    () => harness.plane.proveConnection(connectionCheck, enrollmentCredential),
    (error) => error instanceof ReferenceControlError && error.code === "not-authorized",
    "connection credentials are single use"
  );
  return { app, host, enrollmentCredential };
}

function setupAndActivate(harness, identity, suffix) {
  harness.advance();
  const setupResult = harness.plane.execute(harness.command(`request-setup-${suffix}`, "source.setup", {
    appId: identity.app.appId,
    hostId: identity.host.hostId,
    connectorType: "canonical-push",
    sourceKind: "log.event",
    displayName: `Security log ${suffix}`,
    config: { "cadence-seconds": 300 },
    credentialReferences: []
  }));
  assert.equal(setupResult.status, "succeeded");

  harness.advance();
  const testResult = harness.plane.execute(harness.command(`request-test-${suffix}`, "source.test", {
    sourceId: setupResult.output.sourceId,
    connectorInstanceId: setupResult.output.connectorInstanceId,
    expectedRevision: setupResult.output.revision
  }));
  assert.equal(testResult.status, "succeeded");

  harness.advance();
  const activateRequest = harness.command(`request-activate-${suffix}`, "source.activate", {
    sourceId: testResult.output.sourceId,
    connectorInstanceId: testResult.output.connectorInstanceId,
    expectedRevision: testResult.output.revision
  });
  const activateResult = harness.plane.execute(activateRequest);
  assert.equal(activateResult.status, "succeeded");
  assert.equal(activateResult.output.oneTimeCredential.purpose, "source-ingest");
  const credential = activateResult.output.oneTimeCredential.value;
  const replay = harness.plane.execute(activateRequest);
  assert.equal(Object.prototype.hasOwnProperty.call(replay.output, "oneTimeCredential"), false,
    "an activation retry never replays its ingest credential");
  return {
    connectorInstanceId: activateResult.output.connectorInstanceId,
    credential,
    revision: activateResult.output.revision,
    sourceId: activateResult.output.sourceId
  };
}

function logBatch({ appId, at, message, receiptId, recordId, sourceId }) {
  return {
    schemaVersion: "1",
    documentType: "ingest-batch",
    sourceId,
    receiptId,
    sentAt: at,
    records: [{
      schemaVersion: "1",
      documentType: "normalized-record",
      recordId,
      sourceId,
      estateId: appId,
      kind: "log.event",
      observedAt: at,
      payload: {
        title: "Authentication event",
        state: "open",
        severity: "high",
        message,
        channel: "security"
      }
    }]
  };
}

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function referenceRequest(started, options = {}) {
  const method = options.method || "GET";
  const hasBody = options.body !== undefined;
  const bytes = hasBody
    ? Buffer.from(options.rawBody === undefined ? JSON.stringify(options.body) : options.rawBody, "utf8")
    : null;
  const headers = {
    Accept: "application/json",
    Host: `${HOST}:${started.port}`,
    ...(options.headers || {})
  };
  if (hasBody) {
    if (headers["Content-Type"] === undefined && headers["content-type"] === undefined) {
      headers["Content-Type"] = "application/json; charset=utf-8";
    }
    headers["Content-Length"] = bytes.length;
  }
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: HOST,
      port: started.port,
      method,
      path: options.path || "/",
      headers
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const body = Buffer.concat(chunks);
        let json = null;
        if (body.length && String(response.headers["content-type"] || "").startsWith("application/json")) {
          json = JSON.parse(body.toString("utf8"));
        }
        resolve({ body, headers: response.headers, json, status: response.statusCode });
      });
    });
    request.once("error", reject);
    if (bytes) request.write(bytes);
    request.end();
  });
}

test("connector contract validates manifests, credential references, commands, and provider boundaries", async () => {
  const manifest = ConnectorRuntime.validateConnectorManifest(REFERENCE_CONNECTOR_MANIFEST);
  assert.equal(manifest.connectorType, "canonical-push");
  assert.equal(manifest.payload.recordKinds.includes("log.event"), true);
  assert.equal(manifest.targets.some((target) => target.route === "/logs"), true);
  assert.deepEqual(
    manifest.targets.map((target) => [target.route, Array.from(target.surfaces)]),
    [
      ["/", ["summary-metrics", "detections"]],
      ["/sources", ["expected-sources"]],
      ["/logs", ["log-results"]],
      ["/analytics", ["summary-metrics", "events-collected-per-hour"]],
      ["/health", ["summary-metrics", "is-the-collection-working"]]
    ]
  );
  assert.equal(manifest.configFields[0].minimum, 60);
  assert.equal(manifest.configFields[0].maximum, 31536000);
  assert.equal(Object.isFrozen(manifest), true);
  assert.equal(Object.isFrozen(manifest.targets[0]), true);

  const credentialManifest = clone(REFERENCE_CONNECTOR_MANIFEST);
  credentialManifest.connectorType = "credential-reference-push";
  credentialManifest.credentialSlots = [{
    key: "api-key",
    label: "API key reference",
    kind: "api-key",
    required: true
  }];
  const source = ConnectorRuntime.validateSourceRegistration({
    schemaVersion: "1",
    documentType: "source-registration",
    sourceId: "source-one",
    connectorInstanceId: "connector-one",
    appId: "app-one",
    connectorType: credentialManifest.connectorType,
    sourceKind: "log.event",
    displayName: "Log source",
    hostId: "host-one",
    state: "configured",
    config: { "cadence-seconds": 300 },
    credentialReferences: [{ slot: "api-key", store: "vault", referenceId: "vault:connector-key" }],
    revision: 1,
    createdAt: "2026-08-30T10:00:00Z",
    updatedAt: "2026-08-30T10:00:00Z"
  }, credentialManifest);
  assert.deepEqual(source.credentialReferences[0], {
    slot: "api-key",
    store: "vault",
    referenceId: "vault:connector-key"
  });
  assert.equal(Object.prototype.hasOwnProperty.call(source.credentialReferences[0], "value"), false);

  const unsafeSetup = {
    schemaVersion: "1",
    documentType: "connector-command-request",
    requestId: "request-unsafe",
    command: "source.setup",
    requestedAt: "2026-08-30T10:00:00Z",
    input: {
      appId: "app-one",
      hostId: "host-one",
      connectorType: "canonical-push",
      sourceKind: "log.event",
      displayName: "Unsafe source",
      config: { "api-token": "must-not-enter-config" },
      credentialReferences: []
    }
  };
  assert.throws(() => ConnectorRuntime.validateCommandRequest(unsafeSetup), /sensitive|credentialReferences/i);

  const outOfBoundsSetup = clone(unsafeSetup);
  outOfBoundsSetup.requestId = "request-out-of-bounds";
  outOfBoundsSetup.input.config = { "cadence-seconds": 1 };
  assert.throws(
    () => ConnectorRuntime.validateCommandRequest(outOfBoundsSetup, manifest),
    /at least 60/i,
    "manifest bounds are executable constraints, not descriptive text"
  );

  const emptySnapshot = {
    schemaVersion: "1",
    documentType: "connector-control-snapshot",
    connectorTypes: [manifest],
    apps: [],
    hosts: [],
    connectorInstances: [],
    setups: [],
    sources: [],
    changes: [],
    revision: 0
  };
  let receivedSnapshotRequest;
  let receivedCommand;
  const mutableProvider = {
    schemaVersion: "1",
    id: "reference-provider",
    getSnapshot(request) {
      receivedSnapshotRequest = request;
      return emptySnapshot;
    },
    execute(request) {
      receivedCommand = request;
      return {
        schemaVersion: "1",
        documentType: "connector-command-result",
        requestId: request.requestId,
        command: request.command,
        status: "succeeded",
        completedAt: request.requestedAt,
        output: { appId: "app-created", state: "registered" }
      };
    }
  };
  const provider = ConnectorRuntime.validateProvider(mutableProvider);
  mutableProvider.getSnapshot = () => { throw new Error("late provider mutation"); };
  const snapshot = await provider.getSnapshot({ schemaVersion: "1", reason: "initial" });
  assert.equal(snapshot.revision, 0);
  assert.equal(Object.isFrozen(receivedSnapshotRequest), true);

  const registerRequest = {
    schemaVersion: "1",
    documentType: "connector-command-request",
    requestId: "request-provider-register",
    command: "app.register",
    requestedAt: "2026-08-30T10:00:00Z",
    input: { displayName: "Application", hosts: ["host-alpha"], publicPages: [] }
  };
  const result = await provider.execute(registerRequest);
  assert.equal(result.output.appId, "app-created");
  assert.equal(Object.isFrozen(receivedCommand), true);
  assert.equal(Object.isFrozen(provider), true);
});

test("all scan views ship exact data-only connection templates with meaningful opaque-reference fields", () => {
  const expected = [
    ["trivy-template", ["trivy-operating-system-packages"], ["scan.result", "software.package", "vulnerability.finding"], ["registry-access", "scanner-access"]],
    ["patch-first-template", ["patch-first"], ["software.package", "vulnerability.finding"], ["provider-access"]],
    ["file-integrity-template", ["file-integrity-critical-files-and-canaries"], ["file.integrity"], ["collector-access"]],
    ["end-of-life-template", ["end-of-life-runway"], ["software.package"], ["catalog-access"]],
    ["external-surface-template", ["external-attack-surface-shodan", "sweep-history"], ["asset.snapshot", "scan.result"], ["provider-access"]],
    ["ioc-scan-template", ["ioc-scan-is-anything-on-disk-a-known-bad-file"], ["finding", "scan.result"], ["feed-access"]],
    ["urlscan-template", ["our-pages-rendered-from-outside", "url-history-results"], ["network.event", "scan.result"], ["api-access"]],
    ["dependency-template", ["dependency-advisories"], ["software.package", "vulnerability.finding"], ["source-access", "advisory-access"]],
    ["upload-av-template", ["upload-malware-scanning-clamav-at-the-door", "recent-scan-events"], ["endpoint.event", "finding"], ["scanner-access"]],
    ["quarantine-template", ["quarantined-now", "deleted-from-quarantine"], ["endpoint.event", "finding"], ["store-access", "encryption-access"]],
    ["remediation-template", ["vm-analyst-latest-review", "remediation-log"], ["remediation.record"], ["workflow-access", "evidence-store-access"]]
  ];
  assert.equal(REFERENCE_CONNECTOR_MANIFESTS.length, 13);
  assert.equal(REFERENCE_CONNECTOR_MANIFESTS.filter((manifest) => manifest.connectorType === "trivy-report").length, 1);
  assert.equal(REFERENCE_SCAN_CONNECTOR_MANIFESTS.length, expected.length);
  expected.forEach(([connectorType, surfaces, requiredKinds, credentialSlots], index) => {
    const manifest = ConnectorRuntime.validateConnectorManifest(REFERENCE_SCAN_CONNECTOR_MANIFESTS[index]);
    assert.equal(manifest.connectorType, connectorType);
    assert.equal(manifest.scope, "host");
    assert.match(manifest.description, /Data-only setup template/);
    assert.equal(manifest.targets.length, 1);
    assert.equal(manifest.targets[0].route, "/scans");
    assert.deepEqual(Array.from(manifest.targets[0].surfaces), surfaces);
    requiredKinds.forEach((kind) => {
      assert.ok(manifest.targets[0].recordKinds.includes(kind), `${connectorType} target ${kind}`);
      assert.ok(manifest.payload.recordKinds.includes(kind), `${connectorType} payload ${kind}`);
    });
    assert.equal(manifest.configFields[0].key, "cadence-seconds");
    assert.ok(manifest.configFields.length >= 4, `${connectorType} meaningful config fields`);
    assert.deepEqual(manifest.credentialSlots.map((slot) => slot.key), credentialSlots);
    manifest.credentialSlots.forEach((slot) => {
      assert.equal(Object.prototype.hasOwnProperty.call(slot, "value"), false);
      assert.match(slot.description, /^Opaque .*reference/);
    });
  });
});

test("reference scan templates can be configured but fail closed until a driver is installed", (t) => {
  const harness = createReferenceHarness(t);
  const identity = registerAndProveHost(harness);
  harness.advance();
  const setup = harness.plane.execute(harness.command("request-template-setup", "source.setup", {
    appId: identity.app.appId,
    hostId: identity.host.hostId,
    connectorType: "trivy-template",
    sourceKind: "trivy.scan",
    displayName: "Trivy runner template",
    config: {
      "cadence-seconds": 3600,
      "collection-mode": "local-json",
      "scan-target": "sbom:application-one",
      "severity-threshold": "all"
    },
    credentialReferences: [{
      slot: "registry-access",
      store: "vault",
      referenceId: "vault:trivy-registry"
    }]
  }));
  assert.equal(setup.status, "succeeded");

  harness.advance();
  const tested = harness.plane.execute(harness.command("request-template-test", "source.test", {
    sourceId: setup.output.sourceId,
    connectorInstanceId: setup.output.connectorInstanceId,
    expectedRevision: setup.output.revision
  }));
  assert.equal(tested.status, "failed");
  assert.equal(tested.error.code, "connector-unavailable");
  assert.match(tested.error.message, /data-only connection template.*server driver/i);

  const snapshot = harness.plane.getSnapshot({ schemaVersion: "1", reason: "refresh" });
  assert.equal(snapshot.setups.length, 1);
  assert.equal(snapshot.sources.length, 0, "a template without a driver never becomes an active source");
  assert.equal(snapshot.setups[0].state, "configured");
  assert.deepEqual(snapshot.setups[0].credentialReferences, [{
    slot: "registry-access",
    store: "vault",
    referenceId: "vault:trivy-registry"
  }]);
  assert.doesNotMatch(JSON.stringify(harness.plane.getState()), /oneTimeCredential|source-ingest/);
});

test("normalized ingest contracts enforce canonical kinds, source binding, unique records, and secret-free fields", () => {
  const record = {
    schemaVersion: "1",
    documentType: "normalized-record",
    recordId: "record-one",
    sourceId: "source-one",
    estateId: "estate-one",
    kind: "log.event",
    observedAt: "2026-08-30T10:00:00Z",
    payload: {
      title: "Authentication event",
      state: "open",
      severity: "medium",
      message: "An event occurred.",
      fields: { processId: 17, interactive: false }
    }
  };
  const normalized = validateNormalizedRecord(record);
  assert.equal(RECORD_KINDS.includes(normalized.kind), true);
  assert.equal(Object.isFrozen(normalized.payload.fields), true);

  const batch = validateIngestBatch({
    schemaVersion: "1",
    documentType: "ingest-batch",
    sourceId: "source-one",
    receiptId: "receipt-one-0001",
    sentAt: "2026-08-30T10:00:01Z",
    records: [record]
  });
  assert.equal(batch.records[0].sourceId, batch.sourceId);
  assert.equal(Object.isFrozen(batch.records), true);

  const mismatched = clone(batch);
  mismatched.records[0].sourceId = "source-two";
  assert.throws(() => validateIngestBatch(mismatched), /sourceId must match/i);

  const duplicated = clone(batch);
  duplicated.records.push(clone(duplicated.records[0]));
  assert.throws(() => validateIngestBatch(duplicated), /unique recordId/i);

  const secretBearing = clone(record);
  const forbiddenField = ["session", "to", "ken"].join("");
  Object.defineProperty(secretBearing.payload.fields, forbiddenField, {
    configurable: true,
    enumerable: true,
    value: "must-not-be-admitted"
  });
  assert.throws(() => validateNormalizedRecord(secretBearing), /secret-bearing field name/i);

  const unsupported = clone(record);
  unsupported.kind = "vendor.private-event";
  assert.throws(() => validateNormalizedRecord(unsupported), /kind is unsupported/i);

  const impossibleDate = clone(record);
  impossibleDate.observedAt = "2026-02-30T10:00:00Z";
  assert.throws(() => validateNormalizedRecord(impossibleDate), /RFC 3339/i);
});

test("connection checks use the canonical ingest timestamp discipline", () => {
  const document = {
    schemaVersion: "1",
    documentType: "connection-check",
    appId: "app-one",
    hostId: "host-one",
    observedAt: "2026-08-30T03:00:00-07:00",
    nonce: "connection-check-nonce"
  };
  assert.equal(validateConnectionCheck(document).observedAt, "2026-08-30T10:00:00.000Z");

  for (const observedAt of [
    "2026-02-30T10:00:00Z",
    "2026-08-30 10:00:00Z",
    "2026-08-30T10:00:00",
    "2026-08-30T10:00:00z"
  ]) {
    assert.throws(
      () => validateConnectionCheck({ ...document, observedAt }),
      (error) => error instanceof ReferenceControlError
        && error.code === "validation-failed"
        && error.field === "observedAt"
    );
  }
});

test("checked-in connector and ingest schemas stay aligned with their executable validators", () => {
  const readSchema = (name) => JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "contracts", name), "utf8"));
  const manifestSchema = readSchema("connector-manifest.v1.schema.json");
  const sourceSchema = readSchema("source-registration.v1.schema.json");
  const recordSchema = readSchema("normalized-record.v1.schema.json");
  const batchSchema = readSchema("ingest-batch.v1.schema.json");

  for (const schema of [manifestSchema, sourceSchema, recordSchema, batchSchema]) {
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  }
  assert.deepEqual(
    Array.from(ConnectorRuntime.RECORD_KINDS),
    Array.from(RECORD_KINDS),
    "connector manifests and canonical ingest use one exact record-kind vocabulary"
  );
  assert.equal(RECORD_KINDS.length, 29);
  assert.deepEqual(manifestSchema.$defs.recordKind.enum, Array.from(ConnectorRuntime.RECORD_KINDS));
  assert.deepEqual(recordSchema.$defs.recordKind.enum, Array.from(RECORD_KINDS));
  assert.deepEqual(
    recordSchema.allOf.map((rule) => rule.if.properties.kind.const),
    Array.from(RECORD_KINDS),
    "every normalized record kind has an explicit payload requirement branch"
  );
  assert.equal(batchSchema.additionalProperties, false);
  assert.equal(batchSchema.properties.receiptId.minLength, 16);
  assert.equal(batchSchema.properties.records.maxItems, 1000);
  assert.deepEqual(
    sourceSchema.$defs.credentialReference.properties.store.enum,
    Array.from(ConnectorRuntime.CREDENTIAL_STORES)
  );
  REFERENCE_CONNECTOR_MANIFEST.payload.recordKinds.forEach((kind) => {
    assert.ok(ConnectorRuntime.RECORD_KINDS.includes(kind), `manifest connector kind ${kind}`);
    assert.ok(RECORD_KINDS.includes(kind), `manifest ingest kind ${kind}`);
  });
});

test("reference control plane supports two same-host sources, one-time credentials, durable ingest, and page projections", (t) => {
  const harness = createReferenceHarness(t);
  const identity = registerAndProveHost(harness);
  const first = setupAndActivate(harness, identity, "one");
  const second = setupAndActivate(harness, identity, "two");

  assert.notEqual(first.sourceId, second.sourceId);
  assert.notEqual(first.connectorInstanceId, second.connectorInstanceId);
  const active = harness.plane.getSnapshot({ schemaVersion: "1", reason: "refresh" });
  assert.equal(active.sources.length, 2);
  assert.equal(active.sources.every((source) => source.hostId === identity.host.hostId), true);
  assert.equal(active.sources.every((source) => source.sourceKind === "log.event"), true);

  harness.advance();
  const firstBatch = logBatch({
    appId: identity.app.appId,
    at: harness.clock().toISOString(),
    message: "A real normalized event supplied by the test adopter.",
    receiptId: "receipt-one-0001",
    recordId: "record-one",
    sourceId: first.sourceId
  });
  const firstDigest = digest(firstBatch);
  const receipt = harness.plane.ingest(firstBatch, first.credential, firstDigest);
  assert.deepEqual(
    { accepted: receipt.accepted, duplicates: receipt.duplicates, replay: receipt.replay, status: receipt.status },
    { accepted: 1, duplicates: 0, replay: false, status: "accepted" }
  );
  const replay = harness.plane.ingest(firstBatch, first.credential, firstDigest);
  assert.equal(replay.replay, true);
  assert.equal(replay.receivedAt, receipt.receivedAt);

  const conflictingReceipt = clone(firstBatch);
  conflictingReceipt.records[0].payload.message = "Different content for the same receipt.";
  assert.throws(
    () => harness.plane.ingest(conflictingReceipt, first.credential, digest(conflictingReceipt)),
    (error) => error instanceof ReferenceControlError && error.code === "already-exists"
  );

  const secondBatch = logBatch({
    appId: identity.app.appId,
    at: harness.clock().toISOString(),
    message: "Second source event.",
    receiptId: "receipt-two-0002",
    recordId: "record-two",
    sourceId: second.sourceId
  });
  assert.throws(
    () => harness.plane.ingest(secondBatch, first.credential, digest(secondBatch)),
    (error) => error instanceof ReferenceControlError
      && error.code === "not-authorized"
      && error.status === 403,
    "an ingest credential is bound to exactly one source"
  );

  const pageExpectations = {
    "/": ["summary-metrics", "detections"],
    "/sources": ["expected-sources"],
    "/logs": ["log-results"],
    "/analytics": ["summary-metrics", "events-collected-per-hour"],
    "/health": ["summary-metrics", "is-the-collection-working"]
  };
  for (const [route, panelIds] of Object.entries(pageExpectations)) {
    const query = route === "/analytics" ? { h: "24" } : {};
    const page = harness.plane.readPage(route, query);
    assert.equal(page.route, route);
    assert.equal(page.state, "ready");
    assert.deepEqual(page.panels.map((panel) => panel.id), panelIds);
    const target = REFERENCE_CONNECTOR_MANIFEST.targets.find((entry) => entry.route === route);
    assert.deepEqual(Array.from(target.surfaces), panelIds, `${route} projector outputs match its manifest target`);
  }
  const logs = harness.plane.readPage("/logs", { q: "normalized event" });
  assert.equal(logs.panels[0].rows.length, 1);
  assert.match(logs.panels[0].rows[0][7], /real normalized event/i);
  assert.equal(harness.plane.readPage("/logs", { sourceId: second.sourceId }).state, "empty");
  assert.throws(() => harness.plane.readPage("/analytics", { h: "25" }), /24, 48, or 168/);
  const unprojected = harness.plane.readPage("/triage", {});
  assert.equal(unprojected.route, "/triage");
  assert.equal(unprojected.state, "empty");
  assert.deepEqual(unprojected.panels, []);

  const stateText = fs.readFileSync(path.join(harness.directory, "state.json"), "utf8");
  const auditText = fs.readFileSync(path.join(harness.directory, "audit.jsonl"), "utf8");
  for (const credential of [identity.enrollmentCredential, first.credential, second.credential]) {
    assert.equal(stateText.includes(credential), false, "state stores no raw credential");
    assert.equal(auditText.includes(credential), false, "audit stores no raw credential");
  }
  const stored = JSON.parse(stateText);
  validateState(stored);
  assert.equal(stored.sourceCredentials.length, 2);
  stored.sourceCredentials.forEach((entry) => {
    assert.match(entry.hash, /^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(entry).sort(), [
      "createdAt", "credentialId", "expiresAt", "hash", "lastUsedAt", "revokedAt", "sourceId"
    ]);
  });
  assert.equal(stored.records.length, 1);
  assert.equal(stored.receipts.length, 1);
  assert.equal(fs.statSync(harness.directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(harness.directory, "state.json")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(harness.directory, "audit.jsonl")).mode & 0o777, 0o600);

  harness.plane.dispose();
  harness.plane = new ReferenceControlPlane({ stateDirectory: harness.directory, clock: () => harness.clock() });
  const restored = harness.plane.getSnapshot({ schemaVersion: "1", reason: "initial" });
  assert.equal(restored.apps.length, 1);
  assert.equal(restored.hosts[0].connectionState, "proven");
  assert.equal(restored.sources.length, 2);
  assert.equal(harness.plane.readPage("/logs", {}).panels[0].rows.length, 1);
});

test("reference snapshot and pages share manifest-scaled stale and offline thresholds", (t) => {
  assert.deepEqual(scaledHealthThresholds("canonical-push", 300), {
    staleAfterSeconds: 450,
    offlineAfterSeconds: 900
  });
  assert.deepEqual(scaledHealthThresholds("canonical-push", 600), {
    staleAfterSeconds: 900,
    offlineAfterSeconds: 1800
  });

  const harness = createReferenceHarness(t);
  const identity = registerAndProveHost(harness);
  const source = setupAndActivate(harness, identity, "health");
  const at = harness.clock().toISOString();
  const batch = logBatch({
    appId: identity.app.appId,
    at,
    message: "Health-threshold event.",
    receiptId: "receipt-health-001",
    recordId: "record-health-one",
    sourceId: source.sourceId
  });
  harness.plane.ingest(batch, source.credential, digest(batch));

  function assertHealth(expected) {
    const snapshot = harness.plane.getSnapshot({ schemaVersion: "1", reason: "refresh" });
    assert.equal(snapshot.sources[0].health.state, expected);
    const page = harness.plane.readPage("/health", {});
    const table = page.panels.find((panel) => panel.id === "is-the-collection-working");
    assert.equal(table.rows[0][4].label, expected);
  }

  assertHealth("healthy");
  harness.advance(450_000);
  assertHealth("healthy");
  harness.advance(1_000);
  assertHealth("stale");
  harness.advance(449_000);
  assertHealth("stale");
  harness.advance(1_000);
  assertHealth("offline");
});

test("loopback HTTP workbench serves the provider bridge and carries one source from registration through Logs", async (t) => {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(temporaryRoot, "bb-soc-http-test-"));
  let instant = START;
  const started = await startReferenceServer({
    stateDirectory: directory,
    port: 0,
    clock: () => new Date(instant)
  });
  t.after(async () => {
    if (started.server.listening) await started.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const advance = () => { instant += 1000; };
  const command = (requestId, name, input) => ({
    schemaVersion: "1",
    documentType: "connector-command-request",
    requestId,
    command: name,
    requestedAt: new Date(instant).toISOString(),
    input
  });
  const mutationHeaders = {
    Origin: started.url,
    "Sec-Fetch-Site": "same-origin"
  };

  const shell = await referenceRequest(started, { path: "/" });
  assert.equal(shell.status, 200);
  assert.equal(shell.headers["content-security-policy"], CSP);
  assert.match(shell.headers["content-security-policy"], /connect-src 'self'/);
  const workbenchHtml = shell.body.toString("utf8");
  assert.match(workbenchHtml, /<!doctype html>/i);
  const workbenchMeta = workbenchHtml.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i);
  assert.ok(workbenchMeta, "workbench CSP meta element");
  assert.match(workbenchMeta[1], /connect-src 'self'/);
  assert.doesNotMatch(workbenchMeta[1], /connect-src 'none'/);

  const bridge = await referenceRequest(started, { path: "/application-bridge.js" });
  assert.equal(bridge.status, 200);
  assert.match(bridge.body.toString("utf8"), /SOC_CONSOLE_CONNECTORS/);
  assert.match(bridge.body.toString("utf8"), /SOC_CONSOLE_ADMINISTRATION/);
  assert.match(bridge.body.toString("utf8"), /SOC_CONSOLE_AUTH/);
  assert.match(bridge.body.toString("utf8"), /SOC_CONSOLE_ADAPTER/);
  assert.match(bridge.body.toString("utf8"), /SOC_REFERENCE_WORKBENCH/);
  const bridgeHead = await referenceRequest(started, { method: "HEAD", path: "/application-bridge.js" });
  assert.equal(bridgeHead.status, 200);
  assert.equal(bridgeHead.body.length, 0);
  assert.equal(Number(bridgeHead.headers["content-length"]), bridge.body.length);
  const apiBridge = await referenceRequest(started, { path: "/api/v1/browser-provider.js" });
  assert.equal(apiBridge.status, 200);
  assert.deepEqual(apiBridge.body, bridge.body);
  const apiBridgeHead = await referenceRequest(started, { method: "HEAD", path: "/api/v1/browser-provider.js" });
  assert.equal(apiBridgeHead.status, 200);
  assert.equal(apiBridgeHead.body.length, 0);
  assert.equal(Number(apiBridgeHead.headers["content-length"]), apiBridge.body.length);

  const initialAdministration = await referenceRequest(started, {
    path: "/api/v1/administration/snapshot?domain=agents&reason=initial"
  });
  assert.equal(initialAdministration.status, 200);
  assert.equal(initialAdministration.json.documentType, "agent-administration-snapshot");
  assert.equal(initialAdministration.json.revision, 0);
  const administrationCommand = (requestId, name, expectedRevision, input) => ({
    schemaVersion: "1",
    documentType: "administration-command-request",
    requestId,
    command: name,
    requestedAt: new Date(instant).toISOString(),
    expectedRevision,
    input
  });
  const createAgent = await referenceRequest(started, {
    method: "POST",
    path: "/api/v1/administration/commands",
    headers: mutationHeaders,
    body: administrationCommand("admin-http-agent", "agent.create", 0, {
      displayName: "HTTP agent",
      kind: "automation",
      capabilities: ["soc:read"]
    })
  });
  assert.equal(createAgent.status, 200);
  assert.equal(createAgent.json.status, "succeeded");
  const agentId = createAgent.json.output.agentId;
  advance();
  const revisePrompt = await referenceRequest(started, {
    method: "POST",
    path: "/api/v1/administration/commands",
    headers: mutationHeaders,
    body: administrationCommand("admin-http-prompt", "prompt.revise", 1, {
      agentId,
      title: "Initial prompt",
      body: "Read the SOC technical manual before taking an authorized action."
    })
  });
  assert.equal(revisePrompt.json.status, "succeeded");
  const promptId = revisePrompt.json.output.promptId;
  const prompt = await referenceRequest(started, {
    path: "/api/v1/administration/prompts?promptId=" + encodeURIComponent(promptId)
  });
  assert.equal(prompt.status, 200);
  assert.equal(prompt.json.promptId, promptId);
  assert.match(prompt.json.body, /technical manual/);
  advance();
  const enrollAgent = await referenceRequest(started, {
    method: "POST",
    path: "/api/v1/administration/commands",
    headers: mutationHeaders,
    body: administrationCommand("admin-http-enrollment", "enrollment.issue", 2, {
      agentId,
      expiresInSeconds: 600
    })
  });
  assert.equal(enrollAgent.json.status, "succeeded");
  const agentEnrollmentId = enrollAgent.json.output.enrollmentId;
  const agentCredential = enrollAgent.json.output.oneTimeCredential.value;
  advance();
  const connectAgent = await referenceRequest(started, {
    method: "POST",
    path: "/api/v1/agents/connection",
    headers: { ...mutationHeaders, Authorization: `Enrollment ${agentCredential}` },
    body: {
      schemaVersion: "1",
      agentId,
      enrollmentId: agentEnrollmentId,
      observedAt: new Date(instant).toISOString()
    }
  });
  assert.equal(connectAgent.status, 200);
  assert.equal(connectAgent.json.status, "connected");

  const initial = await referenceRequest(started, { path: "/api/v1/control/snapshot?reason=initial" });
  assert.equal(initial.status, 200);
  assert.equal(initial.json.documentType, "connector-control-snapshot");
  assert.equal(initial.json.connectorTypes.length, REFERENCE_CONNECTOR_MANIFESTS.length);
  assert.equal(initial.json.apps.length, 0);

  const missingOrigin = await referenceRequest(started, {
    method: "POST",
    path: "/api/v1/control/commands",
    body: command("request-no-origin", "app.register", {
      displayName: "Rejected application",
      hosts: ["host-rejected"],
      publicPages: []
    })
  });
  assert.equal(missingOrigin.status, 403);
  assert.equal(missingOrigin.json.code, "not-authorized");

  const hostileHost = await referenceRequest(started, {
    path: "/api/v1/control/snapshot?reason=refresh",
    headers: { Host: "outside.example.invalid" }
  });
  assert.equal(hostileHost.status, 403);
  assert.equal(hostileHost.json.code, "not-authorized");

  const register = await referenceRequest(started, {
    method: "POST",
    path: "/api/v1/control/commands",
    headers: mutationHeaders,
    body: command("request-http-register", "app.register", {
      displayName: "HTTP application",
      hosts: ["host-http"],
      publicPages: ["https://http-app.example.invalid/"]
    })
  });
  assert.equal(register.status, 200);
  assert.equal(register.json.status, "succeeded");
  const appId = register.json.output.appId;

  const registered = await referenceRequest(started, { path: "/api/v1/control/snapshot?reason=refresh" });
  const hostId = registered.json.hosts[0].hostId;
  advance();
  const enroll = await referenceRequest(started, {
    method: "POST",
    path: "/api/v1/control/commands",
    headers: mutationHeaders,
    body: command("request-http-enroll", "host.enroll", { appId, hostId })
  });
  assert.equal(enroll.json.status, "succeeded");
  const enrollmentCredential = enroll.json.output.oneTimeCredential.value;

  advance();
  const proof = await referenceRequest(started, {
    method: "POST",
    path: "/api/v1/connection-check",
    headers: { ...mutationHeaders, Authorization: `Enrollment ${enrollmentCredential}` },
    body: {
      schemaVersion: "1",
      documentType: "connection-check",
      appId,
      hostId,
      observedAt: new Date(instant).toISOString(),
      nonce: "http-connection-nonce"
    }
  });
  assert.equal(proof.status, 200);
  assert.equal(proof.json.status, "accepted");

  advance();
  const setup = await referenceRequest(started, {
    method: "POST",
    path: "/api/v1/control/commands",
    headers: mutationHeaders,
    body: command("request-http-setup", "source.setup", {
      appId,
      hostId,
      connectorType: "canonical-push",
      sourceKind: "log.event",
      displayName: "HTTP security log",
      config: { "cadence-seconds": 300 },
      credentialReferences: []
    })
  });
  assert.equal(setup.json.status, "succeeded");

  advance();
  const sourceTest = await referenceRequest(started, {
    method: "POST",
    path: "/api/v1/control/commands",
    headers: mutationHeaders,
    body: command("request-http-test", "source.test", {
      sourceId: setup.json.output.sourceId,
      connectorInstanceId: setup.json.output.connectorInstanceId,
      expectedRevision: setup.json.output.revision
    })
  });
  assert.equal(sourceTest.json.status, "succeeded");

  advance();
  const activate = await referenceRequest(started, {
    method: "POST",
    path: "/api/v1/control/commands",
    headers: mutationHeaders,
    body: command("request-http-activate", "source.activate", {
      sourceId: sourceTest.json.output.sourceId,
      connectorInstanceId: sourceTest.json.output.connectorInstanceId,
      expectedRevision: sourceTest.json.output.revision
    })
  });
  assert.equal(activate.json.status, "succeeded");
  const ingestCredential = activate.json.output.oneTimeCredential.value;

  advance();
  const batch = logBatch({
    appId,
    at: new Date(instant).toISOString(),
    message: "HTTP adapter event reached the canonical projection.",
    receiptId: "receipt-http-0001",
    recordId: "record-http-one",
    sourceId: activate.json.output.sourceId
  });
  const ingested = await referenceRequest(started, {
    method: "POST",
    path: "/api/v1/ingest",
    headers: { ...mutationHeaders, Authorization: `Bearer ${ingestCredential}` },
    body: batch
  });
  assert.equal(ingested.status, 200);
  assert.equal(ingested.json.accepted, 1);
  assert.equal(ingested.json.replay, false);

  const logsQuery = new URLSearchParams({ route: "/logs", q: "HTTP adapter event" });
  const logs = await referenceRequest(started, { path: `/api/v1/pages?${logsQuery}` });
  assert.equal(logs.status, 200);
  assert.equal(logs.json.route, "/logs");
  assert.equal(logs.json.state, "ready");
  assert.equal(logs.json.panels[0].id, "log-results");
  assert.match(logs.json.panels[0].rows[0][7], /HTTP adapter event/);

  const wrongContentType = await referenceRequest(started, {
    method: "POST",
    path: "/api/v1/ingest",
    headers: {
      ...mutationHeaders,
      Authorization: `Bearer ${ingestCredential}`,
      "Content-Type": "text/plain"
    },
    body: batch
  });
  assert.equal(wrongContentType.status, 415);
  assert.equal(wrongContentType.json.code, "validation-failed");
});

test("reference state store locks an active directory and fails closed on credential-shaped command cache", (t) => {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(temporaryRoot, "bb-soc-store-test-"));
  const store = new ReferenceStateStore({ directory, clock: () => new Date(START) });
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  assert.throws(
    () => new ReferenceStateStore({ directory, clock: () => new Date(START) }),
    /already in use/i
  );
  assert.equal(hashCredential("too-short"), null);
  assert.match(hashCredential("a".repeat(32)), /^[a-f0-9]{64}$/);

  const unsafe = store.snapshot();
  const unsafeResult = {};
  Object.defineProperty(unsafeResult, ["to", "ken"].join(""), {
    configurable: true,
    enumerable: true,
    value: "must-not-persist"
  });
  unsafe.commandResults.push({
    requestId: "request-one",
    requestHash: "a".repeat(64),
    command: "host.enroll",
    result: unsafeResult,
    revision: 0,
    at: "2026-08-30T10:00:00.000Z"
  });
  assert.throws(() => validateState(unsafe), /safely cacheable/i);
});
