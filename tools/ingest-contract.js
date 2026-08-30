"use strict";

const RECORD_KINDS = Object.freeze([
  "alert.delivery", "asset.snapshot", "audit.event", "authentication.event",
  "backup.status", "case.record", "compliance.record", "database.schema",
  "endpoint.event", "evidence.receipt", "file.integrity", "finding",
  "governance.attestation", "governance.risk", "honeypot.event", "identity.access",
  "intel.indicator", "intel.sync", "log.event", "network.event",
  "offboarding.record", "phishing.report", "remediation.record", "retention.snapshot",
  "rule.definition", "scan.result", "software.package", "source.heartbeat",
  "vulnerability.finding"
]);
const SEVERITIES = Object.freeze(["critical", "high", "medium", "low", "info", "unknown"]);
const STATES = Object.freeze(["open", "closed", "active", "inactive", "ok", "warn", "failed", "unknown"]);
const INDICATOR_TYPES = Object.freeze(["ip", "domain", "url", "hash", "email", "other"]);
const RECORD_KEYS = Object.freeze(["schemaVersion", "documentType", "recordId", "sourceId", "estateId", "kind", "observedAt", "payload"]);
const PAYLOAD_KEYS = Object.freeze([
  "title", "state", "severity", "assetRef", "identityRef", "ruleRef", "findingRef",
  "indicatorType", "indicator", "message", "summary", "channel", "category", "count",
  "startedAt", "completedAt", "dueAt", "fields"
]);
const SENSITIVE_SUFFIXES = Object.freeze([
  "secret", "password", "passwd", "token", "apikey", "privatekey",
  "credential", "authorization", "cookie", "sessionid"
]);
const REQUIRED_PAYLOAD = Object.freeze({
  "alert.delivery": ["findingRef"],
  "asset.snapshot": ["assetRef"],
  "audit.event": ["category"],
  "authentication.event": ["identityRef"],
  "backup.status": ["assetRef"],
  "case.record": ["findingRef"],
  "compliance.record": ["category"],
  "database.schema": ["assetRef"],
  "endpoint.event": ["assetRef"],
  "evidence.receipt": ["category"],
  "file.integrity": ["assetRef", "category"],
  finding: ["severity"],
  "governance.attestation": ["category"],
  "governance.risk": ["category"],
  "honeypot.event": ["assetRef"],
  "identity.access": ["identityRef"],
  "intel.indicator": ["indicatorType", "indicator"],
  "intel.sync": ["category"],
  "log.event": ["message"],
  "network.event": ["category"],
  "offboarding.record": ["identityRef"],
  "phishing.report": ["findingRef"],
  "remediation.record": ["findingRef"],
  "retention.snapshot": ["category"],
  "rule.definition": ["ruleRef"],
  "scan.result": ["assetRef"],
  "software.package": ["assetRef"],
  "source.heartbeat": ["category"],
  "vulnerability.finding": ["assetRef", "severity"]
});

function plainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertRecord(value, label) {
  if (!plainRecord(value)) throw new TypeError(`${label} must be a plain object.`);
}

function exactKeys(value, allowed, required, label) {
  const allowedSet = new Set(allowed);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowedSet.has(key)) throw new TypeError(`${label} contains an unsupported field.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set) throw new TypeError(`${label} must use data properties.`);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) throw new TypeError(`${label}.${key} is required.`);
  }
}

function boundedString(value, label, minimum, maximum) {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || (minimum > 0 && !value.trim())) {
    throw new TypeError(`${label} must be a string from ${minimum} through ${maximum} characters.`);
  }
  return value;
}

function identifier(value, label) {
  const candidate = boundedString(value, label, 1, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(candidate)) throw new TypeError(`${label} is not a valid identifier.`);
  return candidate;
}

function timestamp(value, label) {
  const candidate = boundedString(value, label, 20, 35);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(candidate);
  const year = match ? Number(match[1]) : NaN;
  const month = match ? Number(match[2]) : NaN;
  const day = match ? Number(match[3]) : NaN;
  const hour = match ? Number(match[4]) : NaN;
  const minute = match ? Number(match[5]) : NaN;
  const second = match ? Number(match[6]) : NaN;
  const offsetHour = match && match[7] !== undefined ? Number(match[7]) : 0;
  const offsetMinute = match && match[8] !== undefined ? Number(match[8]) : 0;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (!match || month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]
      || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59
      || Number.isNaN(Date.parse(candidate))) {
    throw new TypeError(`${label} must be an RFC 3339 date-time.`);
  }
  return candidate;
}

function sensitiveKey(value) {
  const normalized = value.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return SENSITIVE_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function normalizeFields(value, label) {
  assertRecord(value, label);
  const keys = Reflect.ownKeys(value);
  if (keys.length > 64) throw new TypeError(`${label} must contain at most 64 fields.`);
  const result = {};
  for (const key of keys) {
    if (typeof key !== "string" || !/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(key) || sensitiveKey(key)) {
      throw new TypeError(`${label} contains an invalid or secret-bearing field name.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set) throw new TypeError(`${label} must use data properties.`);
    const item = value[key];
    if (item === null || typeof item === "boolean") result[key] = item;
    else if (typeof item === "number" && Number.isFinite(item)) result[key] = item;
    else if (typeof item === "string" && item.length <= 1000) result[key] = item;
    else throw new TypeError(`${label}.${key} must be a bounded scalar.`);
  }
  return result;
}

function normalizePayload(value, kind, label) {
  assertRecord(value, label);
  exactKeys(value, PAYLOAD_KEYS, ["title", "state"].concat(REQUIRED_PAYLOAD[kind] || []), label);
  const result = {
    title: boundedString(value.title, `${label}.title`, 1, 300),
    state: STATES.includes(value.state) ? value.state : (() => { throw new TypeError(`${label}.state is unsupported.`); })()
  };
  const textLimits = { indicator: 2048, message: 4000, summary: 4000 };
  const idFields = ["assetRef", "identityRef", "ruleRef", "findingRef", "channel", "category"];
  idFields.forEach((key) => { if (value[key] !== undefined) result[key] = identifier(value[key], `${label}.${key}`); });
  Object.entries(textLimits).forEach(([key, maximum]) => {
    if (value[key] !== undefined) result[key] = boundedString(value[key], `${label}.${key}`, 1, maximum);
  });
  if (value.severity !== undefined) {
    if (!SEVERITIES.includes(value.severity)) throw new TypeError(`${label}.severity is unsupported.`);
    result.severity = value.severity;
  }
  if (value.indicatorType !== undefined) {
    if (!INDICATOR_TYPES.includes(value.indicatorType)) throw new TypeError(`${label}.indicatorType is unsupported.`);
    result.indicatorType = value.indicatorType;
  }
  if (value.count !== undefined) {
    if (!Number.isSafeInteger(value.count) || value.count < 0) throw new TypeError(`${label}.count must be a non-negative safe integer.`);
    result.count = value.count;
  }
  ["startedAt", "completedAt", "dueAt"].forEach((key) => {
    if (value[key] !== undefined) result[key] = timestamp(value[key], `${label}.${key}`);
  });
  if (value.fields !== undefined) result.fields = normalizeFields(value.fields, `${label}.fields`);
  return result;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Reflect.ownKeys(value).forEach((key) => deepFreeze(value[key]));
  return Object.freeze(value);
}

function validateNormalizedRecord(value) {
  assertRecord(value, "record");
  exactKeys(value, RECORD_KEYS, RECORD_KEYS, "record");
  if (value.schemaVersion !== "1" || value.documentType !== "normalized-record") {
    throw new TypeError("record must declare normalized-record contract version 1.");
  }
  if (!RECORD_KINDS.includes(value.kind)) throw new TypeError("record.kind is unsupported.");
  return deepFreeze({
    schemaVersion: "1",
    documentType: "normalized-record",
    recordId: identifier(value.recordId, "record.recordId"),
    sourceId: identifier(value.sourceId, "record.sourceId"),
    estateId: identifier(value.estateId, "record.estateId"),
    kind: value.kind,
    observedAt: timestamp(value.observedAt, "record.observedAt"),
    payload: normalizePayload(value.payload, value.kind, "record.payload")
  });
}

function validateIngestBatch(value) {
  assertRecord(value, "batch");
  const keys = ["schemaVersion", "documentType", "sourceId", "receiptId", "sentAt", "records"];
  exactKeys(value, keys, keys, "batch");
  if (value.schemaVersion !== "1" || value.documentType !== "ingest-batch") {
    throw new TypeError("batch must declare ingest-batch contract version 1.");
  }
  if (!Array.isArray(value.records) || value.records.length < 1 || value.records.length > 1000) {
    throw new TypeError("batch.records must contain from 1 through 1000 records.");
  }
  const sourceId = identifier(value.sourceId, "batch.sourceId");
  const records = value.records.map(validateNormalizedRecord);
  if (records.some((record) => record.sourceId !== sourceId)) {
    throw new TypeError("Every record.sourceId must match batch.sourceId.");
  }
  const recordIds = new Set();
  records.forEach((record) => {
    if (recordIds.has(record.recordId)) throw new TypeError("batch.records must use unique recordId values.");
    recordIds.add(record.recordId);
  });
  return deepFreeze({
    schemaVersion: "1",
    documentType: "ingest-batch",
    sourceId,
    receiptId: (() => {
      const receiptId = identifier(value.receiptId, "batch.receiptId");
      if (receiptId.length < 16) throw new TypeError("batch.receiptId must contain from 16 through 128 characters.");
      return receiptId;
    })(),
    sentAt: timestamp(value.sentAt, "batch.sentAt"),
    records
  });
}

module.exports = {
  RECORD_KINDS,
  validateIngestBatch,
  validateNormalizedRecord,
  validateTimestamp: timestamp
};
