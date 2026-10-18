"use strict";

const { normalizeVendorPayload, MAX_VENDOR_BYTES } = require("../tools/vendor-adapters");
const { readJsonBody, sendJson, distinctHeader } = require("./reference-control-plane");
const { ReferenceControlError } = require("./reference-runtime");
const PLATFORM_INGEST_PATH = "/api/v1/ingest/platform";
function fail(message, status = 400) { throw new ReferenceControlError("platform-ingest-refused", message, { status }); }
async function handlePlatformIngest(request, response, url, runtime) {
  if (url.search || request.method !== "POST") fail("Use POST without query parameters.", 405);
  if (distinctHeader(request, "cookie") !== undefined) fail("Platform delivery accepts a source token without browser cookies.", 401);
  const auth = distinctHeader(request, "authorization");
  if (typeof auth !== "string" || !/^Bearer [A-Za-z0-9._~+/-]+=*$/.test(auth)) fail("A source Bearer credential is required.", 401);
  if (distinctHeader(request, "content-encoding") !== undefined) fail("Compressed platform input is not supported.", 415);
  const credential = auth.slice(7);
  // Authenticate before reading up to 8 MiB. Binding is rechecked inside admission.
  const source = runtime.authorizePlatformSource(credential);
  const { value } = await readJsonBody(request, MAX_VENDOR_BYTES);
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== 3 || Object.keys(value).some(key => !["sourceId", "adapterId", "payload"].includes(key))) {
    fail("Supply exactly sourceId, adapterId and payload.");
  }
  if (value.sourceId !== source.sourceId || value.adapterId !== source.sourceKind) fail("The envelope must match the credential's source and installed adapter.", 403);
  const result = normalizeVendorPayload(value.adapterId, value.payload, { sourceId: source.sourceId, estateId: source.appId });
  const receipt = runtime.ingest(result.batch, credential, result.bodyHash);
  sendJson(response, 200, { schemaVersion: "1", documentType: "platform-ingest-result", receipt, summary: result.summary });
}
module.exports = { PLATFORM_INGEST_PATH, handlePlatformIngest };
