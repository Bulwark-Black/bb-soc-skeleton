"use strict";

// Reference validation is separate from byte storage. An association proves only
// that a local record exists, never that a document satisfies that obligation.
const METADATA_KEYS = ["title", "appId", "owner", "status", "reviewAt", "linkKind", "linkId"];
const BINDING_KEYS = ["appId", "linkKind", "linkId"];
function fail(message, status = 400) {
  const error = new Error(message); error.code = "document-binding-refused"; error.status = status; throw error;
}
function plain(value) { return value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
function ref(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value.trim())) fail("Document reference is invalid.");
  return value.trim();
}
function validateDocumentBinding(metadata, { runtime, administrationRuntime, previous } = {}) {
  if (!plain(metadata) || Reflect.ownKeys(metadata).some(key => !METADATA_KEYS.includes(key)
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(metadata, key), "value"))) fail("Document metadata contains unsupported fields.");
  if (previous !== undefined && !plain(previous)) fail("Previous document metadata is unavailable.", 503);
  const binding = Object.fromEntries(BINDING_KEYS.map(key => [key, ref(Object.hasOwn(metadata, key) ? metadata[key] : previous?.[key])]));
  if (Boolean(binding.linkKind) !== Boolean(binding.linkId) || (binding.linkKind && !["risk", "attestation", "case", "policy"].includes(binding.linkKind))) {
    fail("Choose a linked record type and its reference together, or clear both.");
  }
  const unchanged = previous && BINDING_KEYS.every(key => binding[key] === ref(previous[key]));
  // Existing metadata/versions remain usable after the related record is removed.
  // Changing any part of the binding validates all newly asserted references.
  if (unchanged) return binding;
  if (binding.appId) {
    if (!runtime || typeof runtime.controlState !== "function") fail("Application references cannot currently be verified.", 503);
    const state = runtime.controlState();
    if (!Array.isArray(state?.apps)) fail("Application references cannot currently be verified.", 503);
    if (!state.apps.some(item => item.appId === binding.appId)) fail("Choose an existing registered application or use a shared document.");
  }
  if (["risk", "attestation"].includes(binding.linkKind)) {
    if (!administrationRuntime || typeof administrationRuntime.getState !== "function") fail("Governance references cannot currently be verified.", 503);
    const state = administrationRuntime.getState(), records = binding.linkKind === "risk" ? state?.risks : state?.attestations;
    if (!Array.isArray(records)) fail("Governance references cannot currently be verified.", 503);
    const key = binding.linkKind === "risk" ? "riskId" : "attestationId";
    if (!records.some(item => item[key] === binding.linkId)) fail("Choose an existing " + binding.linkKind + " record. Removed or unknown records cannot be newly linked.");
    // v1 governance records are installation-wide and have no application scope.
    // Selecting an application scopes the document, not the governance record.
  }
  // Case and policy references are operator-supplied labels, not local records.
  return binding;
}
module.exports = { validateDocumentBinding };
