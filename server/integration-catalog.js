"use strict";

// Data-only declarations for the existing canonical admission driver. Installing
// a manifest never installs JavaScript, vendor clients, credentials or a runner.
const ConnectorContract = require("../public/connector-contract");
const { REFERENCE_CONNECTOR_MANIFESTS } = require("./reference-manifest");

const MAX_INTEGRATION_MANIFESTS = 100;
const MAX_CUSTOM_INTEGRATIONS = MAX_INTEGRATION_MANIFESTS - REFERENCE_CONNECTOR_MANIFESTS.length;
const MAX_MANIFEST_BYTES = 64 * 1024;
const BUILTIN_TYPES = new Set(REFERENCE_CONNECTOR_MANIFESTS.map((manifest) => manifest.connectorType));

function validateCustomManifest(value) {
  const manifest = ConnectorContract.validateConnectorManifest(value);
  if (BUILTIN_TYPES.has(manifest.connectorType)) throw new TypeError("Custom integrations cannot replace a built-in connector type.");
  if (Buffer.byteLength(JSON.stringify(manifest), "utf8") > MAX_MANIFEST_BYTES) throw new TypeError("Custom integration manifest exceeds 64 KiB.");
  if (manifest.scope !== "application" || manifest.healthPolicy.deliveryMode !== "push"
      || manifest.payload.schemaId !== "soc.canonical-records" || manifest.payload.schemaVersion !== "1"
      || manifest.payload.lines !== "forbidden" || manifest.payload.content !== "required") {
    throw new TypeError("Custom integrations must be application-scoped canonical v1 push declarations with forbidden lines and required content.");
  }
  if (manifest.credentialSlots.length) throw new TypeError("Custom integration vendor secrets belong to the external sender; credential slots are not supported.");
  if (manifest.healthPolicy.emptyPayloadIsHealthy) throw new TypeError("Empty custom deliveries cannot prove source health.");
  const cadence = manifest.configFields.find((field) => field.key === "cadence-seconds");
  if (!cadence || cadence.valueType !== "duration-seconds" || !cadence.required
      || !Number.isSafeInteger(cadence.minimum) || cadence.minimum < 60
      || !Number.isSafeInteger(cadence.maximum) || cadence.maximum > 31536000) {
    throw new TypeError("Custom integrations require cadence-seconds from 60 through 31536000 seconds.");
  }
  return manifest;
}

function getIntegrationManifests(state) {
  const custom = state.integrationManifests === undefined ? [] : state.integrationManifests;
  if (!Array.isArray(custom) || custom.length > MAX_CUSTOM_INTEGRATIONS) {
    throw new TypeError("Custom integration registry exceeds its bounded capacity.");
  }
  const seen = new Set(BUILTIN_TYPES);
  const normalized = custom.map((value) => {
    const manifest = validateCustomManifest(value);
    if (seen.has(manifest.connectorType)) throw new TypeError("Integration connector types must be unique and immutable.");
    seen.add(manifest.connectorType);
    return manifest;
  });
  return [...REFERENCE_CONNECTOR_MANIFESTS, ...normalized];
}

function getIntegrationManifest(state, connectorType) {
  return getIntegrationManifests(state).find((manifest) => manifest.connectorType === connectorType) || null;
}

module.exports = {
  MAX_INTEGRATION_MANIFESTS, MAX_CUSTOM_INTEGRATIONS, MAX_MANIFEST_BYTES,
  getIntegrationManifests, getIntegrationManifest, validateCustomManifest
};
