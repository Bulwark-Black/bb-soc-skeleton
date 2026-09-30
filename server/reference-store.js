"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const ConnectorContract = require("../public/connector-contract");
const { validateNormalizedRecord } = require("../tools/ingest-contract");
const { getIntegrationManifests } = require("./integration-catalog");

const SCHEMA_VERSION = "1";
const STATE_FILE = "state.json";
const AUDIT_FILE = "audit.jsonl";
const LOCK_FILE = "runtime.lock";
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const MAX_AUDIT_BYTES = 50 * 1024 * 1024;
const MAX_RECORDS = 10_000;
const MAX_RECEIPTS = 10_000;
const ID_PATTERNS = Object.freeze({
  appId: /^app-[0-9a-f-]{36}$/,
  hostId: /^host-[0-9a-f-]{36}$/,
  connectorInstanceId: /^connector-[0-9a-f-]{36}$/,
  sourceId: /^source-[0-9a-f-]{36}$/,
  credentialId: /^credential-[0-9a-f-]{36}$/,
  changeId: /^change-[0-9a-f-]{36}$/
});

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainRecord(value, label) {
  if (!isPlainRecord(value)) throw new TypeError(label + " must be a plain object.");
}

function assertAllowedKeys(value, allowed, label) {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.includes(key)) throw new TypeError(label + " contains an unsupported field.");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set) throw new TypeError(label + " must use data properties.");
  }
}

function assertString(value, label, maximum, pattern) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
      || (pattern && !pattern.test(value))) {
    throw new TypeError(label + " is invalid.");
  }
  return value;
}

function assertNullableTimestamp(value, label) {
  if (value === null) return value;
  if (typeof value !== "string"
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
      || Number.isNaN(Date.parse(value))) {
    throw new TypeError(label + " must be a normalized UTC timestamp or null.");
  }
  return value;
}

function assertId(value, kind, label) {
  return assertString(value, label, 128, ID_PATTERNS[kind]);
}

function assertHash(value, label) {
  return assertString(value, label, 64, /^[a-f0-9]{64}$/);
}

function assertUnsigned(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new TypeError(label + " is invalid.");
  return value;
}

function assertArray(value, label, maximum) {
  if (!Array.isArray(value) || value.length > maximum) throw new TypeError(label + " must be a bounded array.");
  return value;
}

function assertUnique(items, key, label) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item[key])) throw new TypeError(label + " contains duplicate " + key + " values.");
    seen.add(item[key]);
  }
}

function validatePublicPage(value, label) {
  assertString(value, label, 500);
  let parsed;
  try { parsed = new URL(value); } catch { throw new TypeError(label + " must be an absolute HTTPS URL."); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError(label + " must be an HTTPS URL without credentials, query, or fragment.");
  }
}

function validateConfig(value, label) {
  assertPlainRecord(value, label);
  const keys = Reflect.ownKeys(value);
  if (keys.length > 40) throw new TypeError(label + " contains too many fields.");
  for (const key of keys) {
    if (typeof key !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(key)) throw new TypeError(label + " has an invalid key.");
    const compact = key.replace(/[^a-z0-9]/g, "");
    if (/(?:secret|password|passwd|token|apikey|privatekey|credential|authorization|cookie|sessionid|clientsecret|accesskey)$/.test(compact)) {
      throw new TypeError(label + "." + key + " may not contain secret material.");
    }
    const item = value[key];
    if (typeof item === "string") assertString(item, label + "." + key, 1000, /\S/u);
    else if (typeof item === "number" && Number.isFinite(item)) continue;
    else if (typeof item === "boolean") continue;
    else if (Array.isArray(item) && item.length <= 32) {
      item.forEach((entry, index) => assertString(entry, label + "." + key + "[" + index + "]", 200, /\S/u));
    } else throw new TypeError(label + "." + key + " must be a bounded non-secret value.");
  }
}

function validateCredentialReferences(value, label) {
  assertArray(value, label, 32);
  const slots = new Set();
  value.forEach((entry, index) => {
    const itemLabel = label + "[" + index + "]";
    assertPlainRecord(entry, itemLabel);
    assertAllowedKeys(entry, ["slot", "store", "referenceId"], itemLabel);
    assertString(entry.slot, itemLabel + ".slot", 80, /^[a-z][a-z0-9-]*$/);
    if (slots.has(entry.slot)) throw new TypeError(label + " contains a duplicate slot.");
    slots.add(entry.slot);
    if (!["environment", "host-managed", "secret-manager", "vault"].includes(entry.store)) throw new TypeError(itemLabel + ".store is invalid.");
    assertString(entry.referenceId, itemLabel + ".referenceId", 128, /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/);
  });
}

function validateApp(value, index) {
  const label = "state.apps[" + index + "]";
  assertPlainRecord(value, label);
  assertAllowedKeys(value, ["appId", "displayName", "hosts", "publicPages", "environments", "state", "revision", "createdAt", "updatedAt"], label);
  assertId(value.appId, "appId", label + ".appId");
  assertString(value.displayName, label + ".displayName", 120, /\S/u);
  if (value.state !== "registered") throw new TypeError(label + ".state is invalid.");
  assertUnsigned(value.revision, label + ".revision");
  assertNullableTimestamp(value.createdAt, label + ".createdAt");
  assertNullableTimestamp(value.updatedAt, label + ".updatedAt");
  const hosts = assertArray(value.hosts, label + ".hosts", 64);
  hosts.forEach((hostId, hostIndex) => assertId(hostId, "hostId", label + ".hosts[" + hostIndex + "]"));
  if (new Set(hosts).size !== hosts.length) throw new TypeError(label + ".hosts contains duplicates.");
  if (value.environments !== undefined) {
    const environments = assertArray(value.environments, label + ".environments", 32);
    if (!environments.length || new Set(environments).size !== environments.length) throw new TypeError(label + ".environments must be nonempty and unique.");
    environments.forEach((entry) => assertString(entry, label + ".environments", 80, /^[a-z][a-z0-9.-]*$/));
  }
  const pages = assertArray(value.publicPages, label + ".publicPages", 64);
  pages.forEach((page, pageIndex) => validatePublicPage(page, label + ".publicPages[" + pageIndex + "]"));
  if (new Set(pages).size !== pages.length) throw new TypeError(label + ".publicPages contains duplicates.");
  return value;
}

function validateHost(value, index, appIds) {
  const label = "state.hosts[" + index + "]";
  assertPlainRecord(value, label);
  assertAllowedKeys(value, ["hostId", "appId", "displayName", "state", "connectionState", "lastProvenAt", "revision", "createdAt", "updatedAt"], label);
  assertId(value.hostId, "hostId", label + ".hostId");
  assertId(value.appId, "appId", label + ".appId");
  if (!appIds.has(value.appId)) throw new TypeError(label + ".appId does not reference an app.");
  assertString(value.displayName, label + ".displayName", 120, /^[A-Za-z0-9][A-Za-z0-9._ -]*$/);
  if (!["pending", "enrolled"].includes(value.state)) throw new TypeError(label + ".state is invalid.");
  if (!["unknown", "pending", "proven", "stale", "offline"].includes(value.connectionState)) throw new TypeError(label + ".connectionState is invalid.");
  assertNullableTimestamp(value.lastProvenAt, label + ".lastProvenAt");
  assertUnsigned(value.revision, label + ".revision");
  assertNullableTimestamp(value.createdAt, label + ".createdAt");
  assertNullableTimestamp(value.updatedAt, label + ".updatedAt");
  return value;
}

function validateConnector(value, index, appIds, manifests) {
  const label = "state.connectorInstances[" + index + "]";
  assertPlainRecord(value, label);
  assertAllowedKeys(value, [
    "connectorInstanceId", "appId", "connectorType", "displayName", "state", "config",
    "credentialReferences", "revision", "createdAt", "updatedAt"
  ], label);
  assertId(value.connectorInstanceId, "connectorInstanceId", label + ".connectorInstanceId");
  assertId(value.appId, "appId", label + ".appId");
  if (!appIds.has(value.appId)) throw new TypeError(label + ".appId does not reference an app.");
  if (!manifests.has(value.connectorType)) throw new TypeError(label + ".connectorType is unsupported.");
  assertString(value.displayName, label + ".displayName", 120, /\S/u);
  if (!["configured", "tested", "active", "paused", "archived", "removed"].includes(value.state)) throw new TypeError(label + ".state is invalid.");
  validateConfig(value.config, label + ".config");
  validateCredentialReferences(value.credentialReferences, label + ".credentialReferences");
  assertUnsigned(value.revision, label + ".revision");
  assertNullableTimestamp(value.createdAt, label + ".createdAt");
  assertNullableTimestamp(value.updatedAt, label + ".updatedAt");
  return value;
}

function validateHealth(value, label, source) {
  assertPlainRecord(value, label);
  assertAllowedKeys(value, [
    "schemaVersion", "documentType", "sourceId", "connectorInstanceId", "revision", "observedAt", "state", "reason",
    "lastAttemptAt", "lastSuccessAt", "nextExpectedAt", "counters", "message"
  ], label);
  if (value.schemaVersion !== "1" || value.documentType !== "source-health-snapshot") throw new TypeError(label + " has an invalid contract.");
  if (value.sourceId !== source.sourceId || value.connectorInstanceId !== source.connectorInstanceId || value.revision !== source.revision) {
    throw new TypeError(label + " identity or revision does not match its source.");
  }
  if (!["unknown", "pending", "healthy", "degraded", "stale", "offline", "error", "disabled"].includes(value.state)) throw new TypeError(label + ".state is invalid.");
  if (!["none", "awaiting-first-delivery", "late", "connector-error", "authentication-required", "configuration-invalid", "permission-denied", "rate-limited", "disabled"].includes(value.reason)) {
    throw new TypeError(label + ".reason is invalid.");
  }
  ["observedAt", "lastAttemptAt", "lastSuccessAt", "nextExpectedAt"].forEach((key) => assertNullableTimestamp(value[key], label + "." + key));
  assertPlainRecord(value.counters, label + ".counters");
  assertAllowedKeys(value.counters, ["attempts", "successfulAttempts", "receivedRecords", "acceptedRecords", "rejectedRecords"], label + ".counters");
  Object.entries(value.counters).forEach(([key, count]) => assertUnsigned(count, label + ".counters." + key));
  if (value.counters.successfulAttempts > value.counters.attempts
      || value.counters.acceptedRecords + value.counters.rejectedRecords > value.counters.receivedRecords) {
    throw new TypeError(label + ".counters are inconsistent.");
  }
  if (value.message !== undefined) assertString(value.message, label + ".message", 500, /\S/u);
}

function validateSource(value, index, appIds, hostIds, connectorIds, manifests) {
  const label = "state.sources[" + index + "]";
  assertPlainRecord(value, label);
  assertAllowedKeys(value, [
    "schemaVersion", "documentType", "sourceId", "connectorInstanceId", "appId", "connectorType", "sourceKind",
    "displayName", "hostId", "environment", "state", "config", "credentialReferences", "revision", "createdAt", "updatedAt", "health"
  ], label);
  if (value.schemaVersion !== "1" || value.documentType !== "source-registration") throw new TypeError(label + " has an invalid contract.");
  assertId(value.sourceId, "sourceId", label + ".sourceId");
  assertId(value.connectorInstanceId, "connectorInstanceId", label + ".connectorInstanceId");
  assertId(value.appId, "appId", label + ".appId");
  if (value.hostId !== undefined) assertId(value.hostId, "hostId", label + ".hostId");
  if (value.environment !== undefined) assertString(value.environment, label + ".environment", 80, /^[a-z][a-z0-9.-]*$/);
  if (!appIds.has(value.appId) || (value.hostId !== undefined && !hostIds.has(value.hostId)) || !connectorIds.has(value.connectorInstanceId)) throw new TypeError(label + " contains an invalid reference.");
  const manifest = manifests.get(value.connectorType);
  if (!manifest || !manifest.supportedSourceKinds.includes(value.sourceKind)) throw new TypeError(label + " has an unsupported type.");
  if (manifest.scope === "host" && value.hostId === undefined) throw new TypeError(label + " requires its collector host.");
  assertString(value.displayName, label + ".displayName", 120, /\S/u);
  if (!["configured", "tested", "active", "paused", "archived", "removed"].includes(value.state)) throw new TypeError(label + ".state is invalid.");
  validateConfig(value.config, label + ".config");
  validateCredentialReferences(value.credentialReferences, label + ".credentialReferences");
  assertUnsigned(value.revision, label + ".revision");
  assertNullableTimestamp(value.createdAt, label + ".createdAt");
  assertNullableTimestamp(value.updatedAt, label + ".updatedAt");
  validateHealth(value.health, label + ".health", value);
  return value;
}

function validateEnrollment(value, index, appIds, hostIds) {
  const label = "state.enrollments[" + index + "]";
  assertPlainRecord(value, label);
  assertAllowedKeys(value, ["credentialId", "appId", "hostId", "hash", "createdAt", "expiresAt", "consumedAt", "revokedAt"], label);
  assertId(value.credentialId, "credentialId", label + ".credentialId");
  assertId(value.appId, "appId", label + ".appId");
  assertId(value.hostId, "hostId", label + ".hostId");
  if (!appIds.has(value.appId) || !hostIds.has(value.hostId)) throw new TypeError(label + " contains an invalid reference.");
  assertHash(value.hash, label + ".hash");
  ["createdAt", "expiresAt", "consumedAt", "revokedAt"].forEach((key) => assertNullableTimestamp(value[key], label + "." + key));
  if (Date.parse(value.expiresAt) <= Date.parse(value.createdAt)) throw new TypeError(label + ".expiresAt is invalid.");
  return value;
}

function validateSourceCredential(value, index, sourceIds) {
  const label = "state.sourceCredentials[" + index + "]";
  assertPlainRecord(value, label);
  assertAllowedKeys(value, ["credentialId", "sourceId", "hash", "createdAt", "expiresAt", "lastUsedAt", "revokedAt"], label);
  assertId(value.credentialId, "credentialId", label + ".credentialId");
  assertId(value.sourceId, "sourceId", label + ".sourceId");
  if (!sourceIds.has(value.sourceId)) throw new TypeError(label + ".sourceId does not reference a source.");
  assertHash(value.hash, label + ".hash");
  ["createdAt", "expiresAt", "lastUsedAt", "revokedAt"].forEach((key) => assertNullableTimestamp(value[key], label + "." + key));
  return value;
}

function validateStoredRecord(value, index, appIds, hostIds, connectorIds, sourceIds, sourcesById, manifests) {
  const label = "state.records[" + index + "]";
  assertPlainRecord(value, label);
  assertAllowedKeys(value, [
    "schemaVersion", "documentType", "recordId", "sourceId", "estateId", "kind", "observedAt", "payload",
    "connectorInstanceId", "hostId", "receivedAt"
  ], label);
  const canonical = validateNormalizedRecord({
    schemaVersion: value.schemaVersion, documentType: value.documentType, recordId: value.recordId,
    sourceId: value.sourceId, estateId: value.estateId, kind: value.kind,
    observedAt: value.observedAt, payload: value.payload
  });
  const source = sourcesById.get(value.sourceId);
  const manifest = source && manifests.get(source.connectorType);
  if (!manifest || !manifest.payload.recordKinds.includes(canonical.kind)) throw new TypeError(label + ".kind is unsupported by its source.");
  assertId(value.estateId, "appId", label + ".estateId");
  assertId(value.connectorInstanceId, "connectorInstanceId", label + ".connectorInstanceId");
  if (value.hostId !== undefined) assertId(value.hostId, "hostId", label + ".hostId");
  if (!appIds.has(value.estateId) || !connectorIds.has(value.connectorInstanceId)
      || (value.hostId !== undefined && !hostIds.has(value.hostId)) || !sourceIds.has(value.sourceId)) throw new TypeError(label + " contains an invalid reference.");
  if (source.appId !== value.estateId || source.connectorInstanceId !== value.connectorInstanceId || source.hostId !== value.hostId) {
    throw new TypeError(label + " does not match its source binding.");
  }
  assertNullableTimestamp(value.receivedAt, label + ".receivedAt");
  return value;
}

function validateReceipt(value, index, sourceIds) {
  const label = "state.receipts[" + index + "]";
  assertPlainRecord(value, label);
  assertAllowedKeys(value, ["sourceId", "receiptId", "bodyHash", "receivedAt", "accepted", "duplicates"], label);
  assertId(value.sourceId, "sourceId", label + ".sourceId");
  if (!sourceIds.has(value.sourceId)) throw new TypeError(label + ".sourceId does not reference a source.");
  assertString(value.receiptId, label + ".receiptId", 128, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
  assertHash(value.bodyHash, label + ".bodyHash");
  assertNullableTimestamp(value.receivedAt, label + ".receivedAt");
  assertUnsigned(value.accepted, label + ".accepted", 1000);
  assertUnsigned(value.duplicates, label + ".duplicates", 1000);
  return value;
}

function validateChange(value, index) {
  const label = "state.changes[" + index + "]";
  assertPlainRecord(value, label);
  assertAllowedKeys(value, ["changeId", "resourceType", "resourceId", "action", "status", "at", "message"], label);
  assertId(value.changeId, "changeId", label + ".changeId");
  if (!["app", "host", "connector-instance", "source"].includes(value.resourceType)) throw new TypeError(label + ".resourceType is invalid.");
  assertString(value.resourceId, label + ".resourceId", 128, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
  assertString(value.action, label + ".action", 80, /^[a-z][a-z0-9.-]*$/);
  if (!value.action.startsWith(value.resourceType + ".")) throw new TypeError(label + ".action is inconsistent.");
  if (!["succeeded", "failed", "rejected", "conflict"].includes(value.status)) throw new TypeError(label + ".status is invalid.");
  assertNullableTimestamp(value.at, label + ".at");
  if (value.message !== undefined) assertString(value.message, label + ".message", 500, /\S/u);
  return value;
}

function validateCommandCache(value, index) {
  const label = "state.commandResults[" + index + "]";
  assertPlainRecord(value, label);
  assertAllowedKeys(value, ["requestId", "requestHash", "command", "result", "revision", "at"], label);
  assertString(value.requestId, label + ".requestId", 128, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
  assertHash(value.requestHash, label + ".requestHash");
  if (!require("../public/connector-contract").COMMANDS.includes(value.command)) throw new TypeError(label + ".command is invalid.");
  assertPlainRecord(value.result, label + ".result");
  const serialized = JSON.stringify(value.result);
  if (serialized.length > 4096 || /"(?:value|secret|token|password|authorization)"\s*:/i.test(serialized)) {
    throw new TypeError(label + ".result is not safely cacheable.");
  }
  assertUnsigned(value.revision, label + ".revision");
  assertNullableTimestamp(value.at, label + ".at");
  return value;
}

function validateState(value) {
  assertPlainRecord(value, "state");
  assertAllowedKeys(value, [
    "schemaVersion", "revision", "apps", "hosts", "connectorInstances", "sources", "changes",
    "enrollments", "sourceCredentials", "records", "receipts", "commandResults", "integrationManifests"
  ], "state");
  if (value.schemaVersion !== SCHEMA_VERSION) throw new TypeError("state.schemaVersion is unsupported.");
  assertUnsigned(value.revision, "state.revision");
  const integrationManifests = getIntegrationManifests(value);
  const manifests = new Map(integrationManifests.map((manifest) => [manifest.connectorType, manifest]));
  const apps = assertArray(value.apps, "state.apps", 500).map(validateApp);
  assertUnique(apps, "appId", "state.apps");
  const appIds = new Set(apps.map((item) => item.appId));
  const hosts = assertArray(value.hosts, "state.hosts", 1000).map((item, index) => validateHost(item, index, appIds));
  assertUnique(hosts, "hostId", "state.hosts");
  const hostIds = new Set(hosts.map((item) => item.hostId));
  for (const app of apps) {
    const actual = hosts.filter((host) => host.appId === app.appId).map((host) => host.hostId).sort();
    if (JSON.stringify(actual) !== JSON.stringify([...app.hosts].sort())) throw new TypeError("state.apps host membership is inconsistent.");
  }
  const connectors = assertArray(value.connectorInstances, "state.connectorInstances", 2000)
    .map((item, index) => validateConnector(item, index, appIds, manifests));
  assertUnique(connectors, "connectorInstanceId", "state.connectorInstances");
  const connectorIds = new Set(connectors.map((item) => item.connectorInstanceId));
  const sources = assertArray(value.sources, "state.sources", 2000)
    .map((item, index) => validateSource(item, index, appIds, hostIds, connectorIds, manifests));
  assertUnique(sources, "sourceId", "state.sources");
  const sourceIds = new Set(sources.map((item) => item.sourceId));
  const sourcesById = new Map(sources.map((item) => [item.sourceId, item]));
  for (const source of sources) {
    const connector = connectors.find((entry) => entry.connectorInstanceId === source.connectorInstanceId);
    const host = hosts.find((entry) => entry.hostId === source.hostId);
    const app = apps.find((entry) => entry.appId === source.appId);
    if (!connector || connector.appId !== source.appId || (source.hostId !== undefined && (!host || host.appId !== source.appId))
        || (source.environment !== undefined && !(app.environments || ["default"]).includes(source.environment))
        || connector.connectorType !== source.connectorType || connector.state !== source.state) {
      throw new TypeError("state source, connector, host, and app relationships are inconsistent.");
    }
  }
  const enrollments = assertArray(value.enrollments, "state.enrollments", 4000)
    .map((item, index) => validateEnrollment(item, index, appIds, hostIds));
  assertUnique(enrollments, "credentialId", "state.enrollments");
  const sourceCredentials = assertArray(value.sourceCredentials, "state.sourceCredentials", 4000)
    .map((item, index) => validateSourceCredential(item, index, sourceIds));
  assertUnique(sourceCredentials, "credentialId", "state.sourceCredentials");
  const records = assertArray(value.records, "state.records", MAX_RECORDS)
    .map((item, index) => validateStoredRecord(item, index, appIds, hostIds, connectorIds, sourceIds, sourcesById, manifests));
  const recordKeys = new Set();
  records.forEach((record) => {
    const key = record.sourceId + "\u0000" + record.recordId;
    if (recordKeys.has(key)) throw new TypeError("state.records contains a duplicate source/record identity.");
    recordKeys.add(key);
  });
  const receipts = assertArray(value.receipts, "state.receipts", MAX_RECEIPTS)
    .map((item, index) => validateReceipt(item, index, sourceIds));
  const receiptKeys = new Set();
  receipts.forEach((receipt) => {
    const key = receipt.sourceId + "\u0000" + receipt.receiptId;
    if (receiptKeys.has(key)) throw new TypeError("state.receipts contains a duplicate source/receipt identity.");
    receiptKeys.add(key);
  });
  const changes = assertArray(value.changes, "state.changes", 200).map(validateChange);
  assertUnique(changes, "changeId", "state.changes");
  const cached = assertArray(value.commandResults, "state.commandResults", 1000).map(validateCommandCache);
  assertUnique(cached, "requestId", "state.commandResults");
  ConnectorContract.validateControlSnapshot({
    schemaVersion: "1",
    documentType: "connector-control-snapshot",
    connectorTypes: integrationManifests,
    apps,
    hosts,
    connectorInstances: connectors,
    setups: sources.filter((source) => source.state === "configured" || source.state === "tested"),
    sources: sources.filter((source) => source.state === "active"),
    changes,
    revision: value.revision
  });
  return value;
}

function emptyState() {
  return {
    schemaVersion: SCHEMA_VERSION, revision: 0, apps: [], hosts: [], connectorInstances: [],
    sources: [], changes: [], enrollments: [], sourceCredentials: [], records: [], receipts: [], commandResults: []
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function hashCredential(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{32,512}$/.test(value)) return null;
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function secureEqualHex(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || !/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function generateCredential(bytes = 32) {
  if (!Number.isSafeInteger(bytes) || bytes < 24 || bytes > 64) throw new TypeError("Credential entropy size is invalid.");
  return crypto.randomBytes(bytes).toString("base64url");
}

function stableId(prefix) {
  if (!["app", "host", "connector", "source", "credential", "change"].includes(prefix)) throw new TypeError("ID prefix is invalid.");
  return prefix + "-" + crypto.randomUUID();
}

function assertSafeDirectory(directory) {
  if (typeof directory !== "string" || !directory.trim()) throw new TypeError("An explicit reference state directory is required.");
  const resolved = path.resolve(directory);
  if (resolved === path.parse(resolved).root) throw new TypeError("The reference state directory must not be a filesystem root.");
  return resolved;
}

function rejectSymlink(filename, label) {
  try {
    const stat = fs.lstatSync(filename);
    if (stat.isSymbolicLink()) throw new Error(label + " must not be a symbolic link.");
    return stat;
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

function assertOwned(stat, label) {
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error(label + " must be owned by the current user.");
}

function ensureSecureDirectory(directory) {
  const existing = rejectSymlink(directory, "Reference state directory");
  if (existing && !existing.isDirectory()) throw new Error("Reference state path is not a directory.");
  if (!existing) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const finalStat = rejectSymlink(directory, "Reference state directory");
  if (!finalStat || !finalStat.isDirectory()) throw new Error("Reference state directory is unavailable.");
  assertOwned(finalStat, "Reference state directory");
  if (fs.realpathSync(directory) !== directory) throw new Error("Reference state directory must not traverse symbolic links.");
  fs.chmodSync(directory, 0o700);
}

function assertSecureFile(filename, label) {
  const stat = rejectSymlink(filename, label);
  if (!stat) return null;
  if (!stat.isFile()) throw new Error(label + " is not a regular file.");
  assertOwned(stat, label);
  fs.chmodSync(filename, 0o600);
  return stat;
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function atomicWriteJson(filename, value) {
  const directory = path.dirname(filename);
  const temporary = path.join(directory, "." + path.basename(filename) + "." + process.pid + "." + crypto.randomUUID() + ".tmp");
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value) + "\n", { encoding: "utf8" });
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, filename);
    fs.chmodSync(filename, 0o600);
    fsyncDirectory(directory);
  } catch (error) {
    if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch {}
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function validateAuditEntry(value, lineNumber) {
  const label = "audit line " + lineNumber;
  assertPlainRecord(value, label);
  assertAllowedKeys(value, ["schemaVersion", "at", "phase", "revision", "action", "actor", "targetType", "targetId", "detail"], label);
  if (value.schemaVersion !== SCHEMA_VERSION) throw new TypeError(label + ".schemaVersion is unsupported.");
  assertNullableTimestamp(value.at, label + ".at");
  if (!["intent", "commit", "abort"].includes(value.phase)) throw new TypeError(label + ".phase is invalid.");
  assertUnsigned(value.revision, label + ".revision");
  assertString(value.action, label + ".action", 80, /^[a-z][a-z0-9.:-]*$/);
  assertString(value.actor, label + ".actor", 100, /^[a-z][a-z0-9:._-]*$/);
  assertString(value.targetType, label + ".targetType", 40, /^[a-z][a-z0-9-]*$/);
  assertString(value.targetId, label + ".targetId", 128, /^[A-Za-z0-9._:-]+$/);
  assertString(value.detail, label + ".detail", 300, /^[^\r\n\u0000]*$/u);
  return value;
}

function validateAuditChain(entries, stateRevision) {
  const pending = new Map();
  let committedRevision = 0;
  const matchingFields = ["at", "revision", "action", "actor", "targetType", "targetId", "detail"];
  for (const entry of entries) {
    if (entry.phase === "intent") {
      if (!pending.has(entry.revision)) pending.set(entry.revision, []);
      pending.get(entry.revision).push(entry);
      continue;
    }
    const stack = pending.get(entry.revision);
    if (!stack || stack.length === 0) throw new Error("Reference audit outcome has no matching intent; refusing to start.");
    const intent = stack.pop();
    if (entry.phase === "commit" && matchingFields.some((key) => entry[key] !== intent[key])) {
      throw new Error("Reference audit commit does not match its intent; refusing to start.");
    }
    if (entry.phase === "commit") {
      committedRevision += 1;
      if (entry.revision !== committedRevision) throw new Error("Reference audit committed revisions are not contiguous; refusing to start.");
    }
  }
  if ([...pending.values()].some((stack) => stack.length > 0)) {
    throw new Error("Reference audit contains an incomplete transaction; refusing to start.");
  }
  if (committedRevision !== stateRevision) throw new Error("Reference audit and state revisions do not match; refusing to start.");
}

class ReferenceStateStore {
  constructor(options) {
    if (!options || !isPlainRecord(options)) throw new TypeError("ReferenceStateStore options are required.");
    this.directory = assertSafeDirectory(options.directory);
    this.clock = typeof options.clock === "function" ? options.clock : () => new Date();
    this.stateFile = path.join(this.directory, STATE_FILE);
    this.auditFile = path.join(this.directory, AUDIT_FILE);
    this.lockFile = path.join(this.directory, LOCK_FILE);
    this.lockDescriptor = null;
    this.failed = false;
    if (!options.allowIndexedStore && fs.existsSync(path.join(this.directory, "telemetry.sqlite"))) {
      throw new Error("This state directory was upgraded to indexed telemetry. Use the private application; the reference runtime cannot reopen its frozen migration snapshot.");
    }
    ensureSecureDirectory(this.directory);
    this.acquireLock();
    try { this.state = this.load(); } catch (error) { this.close(); throw error; }
  }

  now() {
    const value = this.clock();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TypeError("Reference clock returned an invalid date.");
    return value.toISOString();
  }

  acquireLock() {
    try {
      this.lockDescriptor = fs.openSync(this.lockFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      fs.writeFileSync(this.lockDescriptor, String(process.pid) + "\n", "utf8");
      fs.fsyncSync(this.lockDescriptor);
    } catch (error) {
      if (error && error.code === "EEXIST") {
        throw new Error("Reference state directory is already in use; remove a stale runtime.lock only after verifying no server is running.");
      }
      throw error;
    }
  }

  close() {
    if (this.lockDescriptor !== null) {
      try { fs.closeSync(this.lockDescriptor); } catch {}
      this.lockDescriptor = null;
      try { fs.unlinkSync(this.lockFile); } catch {}
    }
  }

  loadAudit() {
    const stat = assertSecureFile(this.auditFile, "Reference audit file");
    if (!stat) return [];
    if (stat.size > MAX_AUDIT_BYTES) throw new Error("Reference audit file exceeds its safety bound.");
    const content = fs.readFileSync(this.auditFile, "utf8");
    if (content && !content.endsWith("\n")) throw new Error("Reference audit file has an incomplete final entry.");
    return content.split("\n").filter(Boolean).map((line, index) => {
      if (Buffer.byteLength(line, "utf8") > 4096) throw new Error("Reference audit line exceeds its safety bound.");
      let parsed;
      try { parsed = JSON.parse(line); } catch { throw new Error("Reference audit line " + (index + 1) + " is invalid JSON."); }
      return validateAuditEntry(parsed, index + 1);
    });
  }

  load() {
    const audit = this.loadAudit();
    const stat = assertSecureFile(this.stateFile, "Reference state file");
    if (!stat) {
      if (audit.length) throw new Error("Reference state is missing while audit history exists.");
      const initial = emptyState();
      atomicWriteJson(this.stateFile, initial);
      return initial;
    }
    if (stat.size > MAX_STATE_BYTES) throw new Error("Reference state file exceeds its safety bound.");
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(this.stateFile, "utf8")); }
    catch { throw new Error("Reference state file is invalid JSON; refusing to start."); }
    validateState(parsed);
    validateAuditChain(audit, parsed.revision);
    return parsed;
  }

  snapshot() {
    if (this.failed) throw new Error("Reference state store is failed closed.");
    return clone(this.state);
  }

  appendAudit(entry) {
    validateAuditEntry(entry, "new");
    const line = JSON.stringify(entry) + "\n";
    if (Buffer.byteLength(line, "utf8") > 4096) throw new Error("Reference audit entry exceeds its safety bound.");
    const existing = assertSecureFile(this.auditFile, "Reference audit file");
    if (existing && existing.size + Buffer.byteLength(line) > MAX_AUDIT_BYTES) throw new Error("Reference audit file exceeds its safety bound.");
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    const descriptor = fs.openSync(this.auditFile, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | noFollow, 0o600);
    try {
      fs.writeFileSync(descriptor, line, { encoding: "utf8" });
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
    fs.chmodSync(this.auditFile, 0o600);
  }

  transact(metadata, mutate) {
    if (this.failed) throw new Error("Reference state store is failed closed.");
    assertPlainRecord(metadata, "transaction metadata");
    assertAllowedKeys(metadata, ["action", "actor", "targetType", "targetId", "detail"], "transaction metadata");
    if (typeof mutate !== "function") throw new TypeError("A transaction mutation function is required.");
    const next = clone(this.state);
    const result = mutate(next);
    next.revision = this.state.revision + 1;
    validateState(next);
    if (Buffer.byteLength(JSON.stringify(next), "utf8") + 1 > MAX_STATE_BYTES) {
      throw new Error("Reference state capacity is exhausted.");
    }
    const base = {
      schemaVersion: SCHEMA_VERSION,
      at: this.now(),
      revision: next.revision,
      action: assertString(metadata.action, "transaction metadata.action", 80, /^[a-z][a-z0-9.:-]*$/),
      actor: assertString(metadata.actor, "transaction metadata.actor", 100, /^[a-z][a-z0-9:._-]*$/),
      targetType: assertString(metadata.targetType, "transaction metadata.targetType", 40, /^[a-z][a-z0-9-]*$/),
      targetId: assertString(metadata.targetId, "transaction metadata.targetId", 128, /^[A-Za-z0-9._:-]+$/),
      detail: assertString(metadata.detail, "transaction metadata.detail", 300, /^[^\r\n\u0000]*$/u)
    };
    try {
      this.appendAudit({ ...base, phase: "intent" });
      atomicWriteJson(this.stateFile, next);
      this.appendAudit({ ...base, phase: "commit" });
      this.state = next;
      return { revision: next.revision, result };
    } catch (error) {
      try { this.appendAudit({ ...base, phase: "abort", detail: "transaction did not complete" }); } catch {}
      this.failed = true;
      throw error;
    }
  }
}

module.exports = {
  AUDIT_FILE, ID_PATTERNS, LOCK_FILE, MAX_RECORDS, MAX_RECEIPTS, ReferenceStateStore,
  SCHEMA_VERSION, STATE_FILE, assertAllowedKeys, assertId, assertPlainRecord, assertString,
  clone, emptyState, generateCredential, hashCredential, isPlainRecord, secureEqualHex, stableId,
  validateAuditChain, validateAuditEntry, validateState
};
