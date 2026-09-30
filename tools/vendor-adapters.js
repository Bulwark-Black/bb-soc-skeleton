"use strict";

// Trusted, checked-in mappers only. A manifest never loads executable code.
const crypto = require("node:crypto");
const { validateNormalizedRecord, validateIngestBatch } = require("./ingest-contract");
const { prepareBatch } = require("./integration-client");
const { validateConnectorManifest } = require("../public/connector-contract");

const MAX_VENDOR_BYTES = 8 * 1024 * 1024;
const MAX_VENDOR_RECORDS = 1000;
const VERSION = "1";
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
function adapters() {
  return [...require("./vendors/cloud").adapters, ...require("./vendors/identity").adapters, ...require("./vendors/devops").adapters];
}
function adapter(id) {
  const value = adapters().find(item => item.id === id);
  if (!value) throw new TypeError("Choose a supported vendor adapter ID.");
  return value;
}
function identifier(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new TypeError(label + " must be a canonical identifier.");
  return value;
}
function vendorManifest(id) {
  const value = adapter(id);
  return validateConnectorManifest({ schemaVersion: "1", documentType: "connector-manifest", connectorType: "vendor." + value.id,
    connectorVersion: VERSION + ".0.0", displayName: value.title + " import", scope: "application",
    description: "Checked-in version-1 mapping for supplied vendor exports/API pages. Acquisition, pagination and polling remain external; no vendor secret is stored here.",
    supportedSourceKinds: [value.id], payload: { schemaId: "soc.canonical-records", schemaVersion: "1", recordKinds: value.recordKinds, lines: "forbidden", content: "required" },
    targets: [{ route: "/sources", surfaces: ["expected-sources"], recordKinds: value.recordKinds }],
    configFields: [{ key: "cadence-seconds", label: "Expected delivery cadence", valueType: "duration-seconds", required: true, minimum: 60, maximum: 31536000 }],
    credentialSlots: [], healthPolicy: { deliveryMode: "push", expectedIntervalSeconds: 300, staleAfterSeconds: 600, offlineAfterSeconds: 900, emptyPayloadIsHealthy: false } });
}
function listVendorAdapters() {
  return adapters().map(({ id, title, description, recordKinds, formats, docs }) => ({ id, title, description, recordKinds, formats, docs,
    version: VERSION, delivery: "export-or-api-page", automaticPolling: false, manifest: vendorManifest(id) }));
}
function parseVendorText(text) {
  if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text) > MAX_VENDOR_BYTES) throw new TypeError("Vendor input must be nonempty UTF-8 JSON or NDJSON no larger than 8 MiB.");
  try { return JSON.parse(text); } catch { /* Try one complete JSON object per nonblank line. */ }
  const lines = text.split(/\r?\n/).filter(line => line.trim());
  if (!lines.length || lines.length > MAX_VENDOR_RECORDS) throw new TypeError("NDJSON must contain at most 1,000 complete records.");
  try {
    return lines.map(line => { const value = JSON.parse(line); if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(); return value; });
  } catch { throw new TypeError("Vendor input is not valid JSON or complete one-object-per-line NDJSON."); }
}
function normalizeVendorPayload(id, input, context) {
  const selected = adapter(id);
  const sourceId = identifier(context?.sourceId, "sourceId"), estateId = identifier(context?.estateId, "estateId");
  let encoded;
  try { encoded = JSON.stringify(input); } catch { throw new TypeError("Vendor input must be bounded JSON data."); }
  if (!encoded || Buffer.byteLength(encoded) > MAX_VENDOR_BYTES) throw new TypeError("Vendor input exceeds 8 MiB.");
  // Reparse to eliminate prototypes/accessors before traversing untrusted data.
  let mapped;
  try { mapped = selected.normalize(JSON.parse(encoded)); }
  catch (error) { throw new TypeError("Vendor payload does not match the documented " + selected.id + " v1 format. Check IDs, original timestamps and required fields; no records were accepted."); }
  if (!Array.isArray(mapped) || !mapped.length || mapped.length > MAX_VENDOR_RECORDS) throw new TypeError("Supply 1–1,000 vendor events. Empty results do not prove collection health.");
  const unique = new Map();
  for (const item of mapped) {
    if (typeof item.upstreamId !== "string" || !item.upstreamId || item.upstreamId.length > 4096 || !selected.recordKinds.includes(item.kind)) throw new TypeError("Vendor mapper returned an invalid event identity or kind.");
    const record = validateNormalizedRecord({ schemaVersion: "1", documentType: "normalized-record",
      recordId: "vendor:" + hash([VERSION, id, sourceId, estateId, item.kind, item.upstreamId]), sourceId, estateId, kind: item.kind,
      observedAt: item.observedAt, payload: { ...item.payload, fields: { ...item.payload.fields, adapterId: id, adapterVersion: VERSION } } });
    const previous = unique.get(record.recordId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(record)) throw new TypeError("Repeated upstream event ID has conflicting content; no records were accepted.");
    unique.set(record.recordId, record);
  }
  const records = [...unique.values()].sort((a, b) => a.recordId.localeCompare(b.recordId));
  const sentAt = records.map(record => record.observedAt).sort().at(-1);
  const batch = validateIngestBatch({ schemaVersion: "1", documentType: "ingest-batch", sourceId,
    receiptId: "vendor:" + hash([VERSION, id, sourceId, estateId, records]), sentAt, records });
  // One input is one atomic delivery: never silently drop rows or partially split.
  const { body } = prepareBatch(batch);
  return { batch, bodyHash: crypto.createHash("sha256").update(body).digest("hex"), summary: {
    adapterId: id, adapterVersion: VERSION, inputEvents: mapped.length, records: records.length, duplicatesWithinInput: mapped.length - records.length,
    originalBytesRetained: false, automaticPolling: false, coverage: "supplied-events-only"
  } };
}
module.exports = { listVendorAdapters, vendorManifest, normalizeVendorPayload, parseVendorText, MAX_VENDOR_BYTES, MAX_VENDOR_RECORDS };
