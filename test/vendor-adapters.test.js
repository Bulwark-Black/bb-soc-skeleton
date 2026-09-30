"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { listVendorAdapters, vendorManifest, normalizeVendorPayload, parseVendorText,
  MAX_VENDOR_BYTES, MAX_VENDOR_RECORDS } = require("../tools/vendor-adapters");
const { validateIngestBatch } = require("../tools/ingest-contract");
const { validateConnectorManifest } = require("../public/connector-contract");
const { getIntegrationManifests, validateCustomManifest, MAX_CUSTOM_INTEGRATIONS,
  MAX_INTEGRATION_MANIFESTS } = require("../server/integration-catalog");
const AT = "2026-09-29T12:00:00Z";
const CONTEXT = { sourceId: "synthetic-vendor-source", estateId: "synthetic-application" };
const fixtures = {
  "aws-cloudtrail": index => ({ eventID: "synthetic-aws-" + index, eventTime: AT, eventSource: "s3.amazonaws.com", eventName: "CreateBucket" }),
  "gcp-audit": index => ({ insertId: "synthetic-gcp-" + index, timestamp: AT,
    logName: "projects/synthetic-project/logs/cloudaudit.googleapis.com%2Factivity",
    protoPayload: { "@type": "type.googleapis.com/google.cloud.audit.AuditLog", serviceName: "storage.googleapis.com", methodName: "storage.buckets.create" } }),
  "cloudflare-firewall": index => ({ RayID: "synthetic-ray-" + index, Datetime: AT, Action: "block", Source: "waf" }),
  "entra-signin": index => ({ id: "synthetic-entra-" + index, createdDateTime: AT, userId: "synthetic-user", status: { errorCode: 0 } }),
  "okta-system-log": index => ({ uuid: "synthetic-okta-" + index, published: AT, eventType: "user.session.start", actor: { id: "synthetic-user" }, outcome: { result: "SUCCESS" } }),
  "auth0-logs": index => ({ log_id: "synthetic-auth0-" + index, date: AT, type: "f", user_id: "synthetic-user" }),
  "github-audit": index => ({ _document_id: "synthetic-github-" + index, "@timestamp": Date.parse(AT), action: "repo.create" }),
  "gitlab-audit": index => ({ id: index + 1, created_at: AT, entity_id: 1, entity_type: "Project", details: {} }),
  "sentry-events": index => ({ eventID: String(index + 1).padStart(32, "0"), dateCreated: AT, type: "error", platform: "node" }),
  "datadog-logs": index => ({ id: "synthetic-datadog-" + index, type: "log", attributes: { timestamp: AT, status: "error" } })
};

test("vendor catalog exposes exactly ten reviewed export adapters and valid narrow no-secret push presets", () => {
  const catalog = listVendorAdapters();
  assert.equal(catalog.length, 10);
  assert.deepEqual(catalog.map(item => item.id).sort(), Object.keys(fixtures).sort());
  for (const item of catalog) {
    assert.equal(item.automaticPolling, false);
    assert.equal(item.delivery, "export-or-api-page");
    assert.equal(item.version, "1");
    assert.ok(item.title && item.description && item.formats.length && item.docs.length);
    assert.ok(item.docs.every(doc => doc.title && doc.url.startsWith("https://")));
    assert.equal(item.normalize, undefined, "Public metadata does not expose executable callbacks.");
    assert.deepEqual(item.manifest, vendorManifest(item.id));
    assert.deepEqual(validateConnectorManifest(item.manifest), item.manifest);
    assert.deepEqual(validateCustomManifest(item.manifest), item.manifest);
    assert.equal(item.manifest.connectorType, "vendor." + item.id);
    assert.deepEqual(item.manifest.supportedSourceKinds, [item.id]);
    assert.deepEqual(item.manifest.payload.recordKinds, item.recordKinds);
    assert.equal(item.manifest.scope, "application");
    assert.equal(item.manifest.healthPolicy.deliveryMode, "push");
    assert.equal(item.manifest.healthPolicy.emptyPayloadIsHealthy, false);
    assert.deepEqual(item.manifest.credentialSlots, []);
  }
});

test("vendor presets consume normal registry capacity and cannot overwrite types or bypass the immutable registry", () => {
  const manifests = listVendorAdapters().map(item => item.manifest);
  assert.equal(getIntegrationManifests({ integrationManifests: manifests }).length, 24);
  assert.throws(() => getIntegrationManifests({ integrationManifests: [manifests[0], manifests[0]] }), /unique/);
  const replacement = structuredClone(manifests[0]);
  replacement.displayName = "Changed preset";
  assert.throws(() => getIntegrationManifests({ integrationManifests: [manifests[0], replacement] }), /unique/);
  replacement.connectorType = "canonical-events";
  assert.throws(() => validateCustomManifest(replacement), /built-in/);
  const full = Array.from({ length: MAX_CUSTOM_INTEGRATIONS }, (_, index) => ({
    ...structuredClone(manifests[index % manifests.length]), connectorType: "synthetic-vendor-" + index
  }));
  assert.equal(getIntegrationManifests({ integrationManifests: full }).length, MAX_INTEGRATION_MANIFESTS);
  assert.throws(() => getIntegrationManifests({ integrationManifests: [...full, manifests[0]] }), /capacity/);
});

test("all ten vendor adapters produce validated source-bound batches and stable hashes without input-order dependence", () => {
  for (const [id, fixture] of Object.entries(fixtures)) {
    const input = [fixture(0), fixture(1)];
    const result = normalizeVendorPayload(id, input, CONTEXT);
    const repeated = normalizeVendorPayload(id, input, CONTEXT);
    const reordered = normalizeVendorPayload(id, [...input].reverse(), CONTEXT);
    assert.deepEqual(result, repeated, id);
    assert.deepEqual(result, reordered, id);
    assert.deepEqual(validateIngestBatch(result.batch), result.batch, id);
    assert.equal(result.batch.records.length, 2);
    assert.equal(result.batch.sourceId, CONTEXT.sourceId);
    assert.equal(result.batch.sentAt, "2026-09-29T12:00:00.000Z");
    assert.match(result.batch.receiptId, /^vendor:[a-f0-9]{64}$/);
    assert.match(result.bodyHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(result.batch.records.map(record => record.recordId), result.batch.records.map(record => record.recordId).sort());
    for (const record of result.batch.records) {
      assert.equal(record.sourceId, CONTEXT.sourceId);
      assert.equal(record.estateId, CONTEXT.estateId);
      assert.match(record.recordId, /^vendor:[a-f0-9]{64}$/);
      assert.equal(record.payload.fields.adapterId, id);
      assert.equal(record.payload.fields.adapterVersion, "1");
    }
    assert.deepEqual(result.summary, { adapterId: id, adapterVersion: "1", inputEvents: 2, records: 2,
      duplicatesWithinInput: 0, originalBytesRetained: false, automaticPolling: false, coverage: "supplied-events-only" });
    assert.deepEqual(input, [fixture(0), fixture(1)], "Normalization leaves the input unchanged.");
  }
});

test("canonical event and receipt identities are scoped to the chosen source and application", () => {
  const input = [fixtures["entra-signin"](0)];
  const base = normalizeVendorPayload("entra-signin", input, CONTEXT);
  for (const context of [{ ...CONTEXT, sourceId: "another-source" }, { ...CONTEXT, estateId: "another-application" }]) {
    const scoped = normalizeVendorPayload("entra-signin", input, context);
    assert.notEqual(scoped.batch.records[0].recordId, base.batch.records[0].recordId);
    assert.notEqual(scoped.batch.receiptId, base.batch.receiptId);
    assert.notEqual(scoped.bodyHash, base.bodyHash);
  }
  const changed = normalizeVendorPayload("entra-signin", [{ ...input[0], status: { errorCode: 50126 } }], CONTEXT);
  assert.equal(changed.batch.records[0].recordId, base.batch.records[0].recordId, "Content changes never mint a new upstream identity.");
  assert.notEqual(changed.batch.receiptId, base.batch.receiptId, "Changed content cannot masquerade as an exact batch replay.");
});

test("JSON and NDJSON parsing preserves complete events and produces the same stable delivery", () => {
  const rows = [fixtures["entra-signin"](0), fixtures["entra-signin"](1)];
  const json = JSON.stringify(rows);
  const ndjson = "\n" + rows.map(row => JSON.stringify(row)).join("\r\n\n") + "\n";
  assert.deepEqual(parseVendorText(json), rows);
  assert.deepEqual(parseVendorText(ndjson), rows);
  assert.deepEqual(normalizeVendorPayload("entra-signin", parseVendorText(json), CONTEXT),
    normalizeVendorPayload("entra-signin", parseVendorText(ndjson), CONTEXT));
  for (const [id, fixture] of Object.entries(fixtures)) {
    assert.deepEqual(normalizeVendorPayload(id, parseVendorText(JSON.stringify(fixture(0)) + "\n"), CONTEXT),
      normalizeVendorPayload(id, [fixture(0)], CONTEXT), id + " supports a single NDJSON event");
  }
  const wrapper = { value: rows, "@odata.nextLink": "not-followed" };
  assert.deepEqual(parseVendorText(JSON.stringify(wrapper)), wrapper);
  assert.deepEqual(normalizeVendorPayload("entra-signin", wrapper, CONTEXT), normalizeVendorPayload("entra-signin", rows, CONTEXT));
  const malformed = ["", " ", "not-json", "{broken}", "{}\n[]", "{}\nnull", "{}\n3", "{}\ntrue", "{}\n\"text\"", "{}\n{broken}"];
  malformed.forEach(value => assert.throws(() => parseVendorText(value), TypeError));
  assert.throws(() => parseVendorText(Array(1001).fill("{}").join("\n")), /1,000/);
});

test("vendor normalization rejects empty, oversized, unsupported, and partially malformed batches without raw-data error reflection", () => {
  const marker = crypto.randomBytes(24).toString("hex");
  assert.equal(MAX_VENDOR_BYTES, 8 * 1024 * 1024);
  assert.equal(MAX_VENDOR_RECORDS, 1000);
  assert.throws(() => parseVendorText("x".repeat(MAX_VENDOR_BYTES + 1)), /8 MiB/);
  assert.throws(() => normalizeVendorPayload("entra-signin", { value: [fixtures["entra-signin"](0)], unused: "x".repeat(MAX_VENDOR_BYTES) }, CONTEXT), /8 MiB/);
  for (const [id, fixture] of Object.entries(fixtures)) {
    for (const input of [[], [{ error: marker }], [fixture(0), { error: marker }], Array.from({ length: 1001 }, (_, index) => fixture(index))]) {
      assert.throws(() => normalizeVendorPayload(id, input, CONTEXT), error => error instanceof TypeError && !error.message.includes(marker), id);
    }
  }
  for (const id of ["unknown", marker, "__proto__", "constructor"]) {
    assert.throws(() => vendorManifest(id), error => error instanceof TypeError && !error.message.includes(marker));
    assert.throws(() => normalizeVendorPayload(id, [], CONTEXT), error => error instanceof TypeError && !error.message.includes(marker));
  }
  for (const context of [null, {}, { ...CONTEXT, sourceId: "bad source" }, { ...CONTEXT, estateId: "x".repeat(129) }]) {
    assert.throws(() => normalizeVendorPayload("entra-signin", [fixtures["entra-signin"](0)], context), /canonical identifier/);
  }
  const cycle = {}; cycle.value = cycle;
  assert.throws(() => normalizeVendorPayload("entra-signin", cycle, CONTEXT), /bounded JSON/);
});

test("equal cloud event duplicates normalize once while conflicting upstream identities fail atomically", () => {
  const event = fixtures["aws-cloudtrail"](0);
  const duplicate = normalizeVendorPayload("aws-cloudtrail", [event, structuredClone(event)], CONTEXT);
  assert.equal(duplicate.batch.records.length, 1);
  assert.equal(duplicate.summary.inputEvents, 2);
  assert.equal(duplicate.summary.duplicatesWithinInput, 1);
  assert.equal(duplicate.batch.receiptId, normalizeVendorPayload("aws-cloudtrail", [event], CONTEXT).batch.receiptId);
  assert.throws(() => normalizeVendorPayload("aws-cloudtrail", [event, { ...event, eventName: "DeleteBucket" }], CONTEXT), /conflicting content/);
});

test("normalized delivery size remains bounded even when the larger vendor input itself is under its limit", () => {
  const input = Array.from({ length: 1000 }, (_, index) => ({ ...fixtures["aws-cloudtrail"](index),
    eventName: "n".repeat(160), eventSource: "s".repeat(160), awsRegion: "r".repeat(160), eventType: "t".repeat(160), errorCode: "e".repeat(160) }));
  assert.ok(Buffer.byteLength(JSON.stringify(input)) < MAX_VENDOR_BYTES);
  assert.throws(() => normalizeVendorPayload("aws-cloudtrail", input, CONTEXT), error => error.code === "batch-too-large");
});

test("raw arbitrary vendor messages, requests, and authorization values are absent from final canonical delivery", () => {
  const marker = crypto.randomBytes(24).toString("hex");
  for (const [id, fixture] of Object.entries(fixtures)) {
    const input = [{ ...fixture(0), message: marker, description: marker, userEmail: marker, request: { headers: { authorization: marker } },
      raw: { secret: marker }, arbitraryProperties: { marker } }];
    const result = normalizeVendorPayload(id, input, CONTEXT);
    assert.ok(!JSON.stringify(result).includes(marker), id);
  }
});
