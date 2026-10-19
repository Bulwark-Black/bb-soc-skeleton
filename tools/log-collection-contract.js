"use strict";

const { validateNormalizedRecord } = require("./ingest-contract");

const COLLECTION_ERRORS = Object.freeze(["input-unavailable", "input-changed", "invalid-line", "line-too-long", "collection-failed"]);
const FIELD_KEYS = Object.freeze(["collectorSchemaVersion", "inputsPlanned", "inputsRead", "linesRead", "linesDropped", "ok", "error"]);
function exact(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
      || Reflect.ownKeys(value).length !== keys.length
      || Reflect.ownKeys(value).some(key => !keys.includes(key)
        || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"))) {
    throw new TypeError("Server log collection proof contains unsupported or missing fields.");
  }
}

function validateCollectionRecord(value) {
  // Validate the original payload before canonical normalization can omit an
  // explicitly undefined optional property. This protocol has exact keys.
  const record = validateNormalizedRecord(value);
  exact(value.payload, ["title", "state", "category", "fields"]);
  exact(value.payload.fields, FIELD_KEYS);
  const { payload } = record, fields = payload.fields;
  if (record.kind !== "source.heartbeat" || payload.title !== "Server log collection"
      || payload.category !== "log-collection" || fields.collectorSchemaVersion !== 1
      || !Number.isSafeInteger(fields.inputsPlanned) || fields.inputsPlanned < 1 || fields.inputsPlanned > 100000
      || !Number.isSafeInteger(fields.inputsRead) || fields.inputsRead < 0 || fields.inputsRead > fields.inputsPlanned
      || !Number.isSafeInteger(fields.linesRead) || fields.linesRead < 0
      || !Number.isSafeInteger(fields.linesDropped) || fields.linesDropped < 0
      || typeof fields.ok !== "boolean" || !(fields.error === null || COLLECTION_ERRORS.includes(fields.error))) {
    throw new TypeError("Server log collection proof has invalid counters, version or outcome.");
  }
  const complete = fields.inputsRead === fields.inputsPlanned && fields.linesDropped === 0 && fields.error === null;
  if (fields.ok !== complete || (!fields.ok && fields.error === null) || payload.state !== (fields.ok ? "ok" : "failed")) {
    throw new TypeError("Server log collection proof outcome does not match its read results.");
  }
  return record;
}

function createCollectionRecord({ sourceId, estateId, recordId, observedAt, inputsPlanned, inputsRead, linesRead, linesDropped, ok, error }) {
  return validateCollectionRecord({ schemaVersion: "1", documentType: "normalized-record", recordId, sourceId, estateId,
    kind: "source.heartbeat", observedAt,
    payload: { title: "Server log collection", state: ok ? "ok" : "failed", category: "log-collection",
      fields: { collectorSchemaVersion: 1, inputsPlanned, inputsRead, linesRead, linesDropped, ok, error } } });
}

module.exports = { COLLECTION_ERRORS, createCollectionRecord, validateCollectionRecord };
