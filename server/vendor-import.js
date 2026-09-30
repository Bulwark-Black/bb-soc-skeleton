"use strict";

const { listVendorAdapters, normalizeVendorPayload, parseVendorText, MAX_VENDOR_BYTES } = require("../tools/vendor-adapters");
const { readJsonBody, sendJson } = require("./reference-control-plane");
const { ReferenceControlError } = require("./reference-runtime");

const BASE = "/api/v1/integrations/vendors";
function fail(message, status = 422) { throw new ReferenceControlError("vendor-import-refused", message, { status }); }
async function handleVendorImport(request, response, url, runtime) {
  if (url.search) fail("Vendor import endpoints do not accept query parameters.", 400);
  if (request.method === "GET" && url.pathname === BASE) {
    sendJson(response, 200, { schemaVersion: "1", documentType: "vendor-adapters", adapters: listVendorAdapters(),
      limits: { inputBytes: MAX_VENDOR_BYTES, records: 1000, canonicalBytes: 1024 * 1024 },
      automaticPolling: false, rawStorage: false });
    return;
  }
  if (request.method !== "POST" || ![BASE + "/preview", BASE + "/import"].includes(url.pathname)) fail("Use a documented vendor adapter endpoint.", 405);
  const { value } = await readJsonBody(request, MAX_VENDOR_BYTES * 2 + 2048);
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some(key => !["adapterId", "sourceId", "text", "previewHash"].includes(key))) fail("Supply adapterId, sourceId and vendor JSON/NDJSON text, with previewHash only for import.", 400);
  const selected = listVendorAdapters().find(item => item.id === value.adapterId);
  if (!selected) fail("Choose a supported vendor adapter.");
  const source = runtime.controlState().sources.find(item => item.sourceId === value.sourceId);
  if (!source || source.connectorType !== selected.manifest.connectorType || source.sourceKind !== selected.id
      || !["configured", "tested", "active", "paused"].includes(source.state)) fail("Choose a source configured with this vendor's installed preset.", 409);
  const result = normalizeVendorPayload(selected.id, parseVendorText(value.text), { sourceId: source.sourceId, estateId: source.appId });
  if (url.pathname.endsWith("/preview")) {
    if (value.previewHash !== undefined) fail("Preview does not accept a previous preview hash.", 400);
    sendJson(response, 200, { schemaVersion: "1", documentType: "vendor-preview", adapterId: selected.id,
      sourceId: source.sourceId, previewHash: result.bodyHash, summary: result.summary,
      recordSample: result.batch.records[0], records: result.batch.records.slice(0, 10), totalRecords: result.batch.records.length,
      state: source.state, sourceRevision: source.revision, connectorInstanceId: source.connectorInstanceId,
      receiptId: result.batch.receiptId, stored: false });
    return;
  }
  if (typeof value.previewHash !== "string" || value.previewHash !== result.bodyHash) fail("Preview this exact source and file before importing. Nothing was stored.", 409);
  const receipt = runtime.ingestVendorAsOperator(result.batch, result.bodyHash, selected.id);
  sendJson(response, 200, { schemaVersion: "1", documentType: "vendor-import-result", receipt, summary: result.summary });
}
module.exports = { handleVendorImport, VENDOR_BASE: BASE };
