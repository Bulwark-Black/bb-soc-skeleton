"use strict";

const { createHash } = require("node:crypto");
const { validateTimestamp, validateNormalizedRecord } = require("../ingest-contract");

// Bounded, synchronous import profiles, not listeners or cloud polling workers.
// Nothing supplied by an event is evaluated, fetched, or used as tenant authority.
function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError(`${label} must be a JSON object.`);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !descriptor || descriptor.get || descriptor.set) throw new TypeError(`${label} must contain JSON data properties.`);
  }
  return value;
}
function text(value, label, max = 1000, empty = false) {
  if (typeof value !== "string" || value.length > max || (!empty && !value.trim()) || !value.isWellFormed() || /[\u0000]/.test(value)) throw new TypeError(`${label} must be bounded text.`);
  return value;
}
function exact(value, keys, label) {
  object(value, label);
  if (Object.keys(value).some(key => !keys.includes(key))) throw new TypeError(`${label} contains unsupported fields.`);
}
function sensitive(key) { return /(?:secret|password|passwd|token|apikey|privatekey|credential|authorization|cookie|sessionid)$/.test(key.replace(/[^a-z0-9]/gi, "").toLowerCase()); }
function safeKey(key) {
  if (typeof key !== "string" || !key || sensitive(key) || ["__proto__", "constructor", "prototype"].includes(key)) throw new TypeError("Review and remove secret-bearing or reserved keys before import.");
}
function stable(value, depth = 0) {
  if (depth > 12) throw new TypeError("Nested event data is too deep.");
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (value.length > 1000) throw new TypeError("Nested event array is too large.");
    return Array.from(value, item => stable(item, depth + 1));
  }
  object(value, "Nested event data");
  const result = Object.create(null);
  for (const key of Object.keys(value).sort()) { safeKey(key); result[key] = stable(value[key], depth + 1); }
  return result;
}
const digest = (namespace, value) => namespace + ":" + createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
function field(fields, key, value) {
  safeKey(key);
  if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(key) || Object.hasOwn(fields, key)) throw new TypeError("An event field name is unsupported or repeated.");
  if (value !== null && !["string", "boolean", "number"].includes(typeof value)) value = JSON.stringify(stable(value));
  if (typeof value === "string" && value.length > 1000 || typeof value === "number" && !Number.isFinite(value)) throw new TypeError("An event field exceeds canonical limits.");
  fields[key] = value;
  // The adapter registry adds adapterId and adapterVersion after mapping.
  if (Object.keys(fields).length > 62) throw new TypeError("An event exceeds the canonical 64-field budget.");
}
function eventTime(value, label, precision = 9) {
  text(value, label, 35);
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || (match[2] || "").length > precision || match[3] === "-00:00") throw new TypeError(`${label} requires an explicit known timezone and supported fractional precision.`);
  const ms = `${match[1]}.${(match[2] || "").padEnd(3, "0").slice(0, 3)}${match[3]}`;
  validateTimestamp(ms, label);
  return new Date(ms).toISOString();
}
function rows(input) {
  const list = Array.isArray(input) ? input : [input];
  if (!list.length || list.length > 1000) throw new TypeError("Supply 1 through 1000 events; an empty export is not a health proof.");
  return Array.from(list);
}
function finish(upstreamId, observedAt, payload) {
  const result = { upstreamId, observedAt, kind: "log.event", payload };
  // Fail atomically at mapper boundaries, including direct module callers.
  validateNormalizedRecord({ schemaVersion: "1", documentType: "normalized-record", recordId: "validation-only",
    sourceId: "validation-only", estateId: "validation-only", kind: result.kind, observedAt, payload });
  return result;
}
function wrappedMessage(value, allowed = ["message"]) {
  if (typeof value === "string") return { message: value };
  exact(value, allowed, "Exported message wrapper");
  return value;
}

function parseSyslog(raw) {
  text(raw, "RFC 5424 message", 16000);
  const header = /^<(0|[1-9]\d{0,2})>1 ([^ ]+) ([!-~]+) ([!-~]+) ([!-~]+) ([!-~]+) /.exec(raw);
  if (!header || Number(header[1]) > 191) throw new TypeError("Only RFC 5424 version 1 messages with explicit timestamp are supported.");
  const [, priority, timestamp, hostname, appName, processId, messageId] = header;
  const observedAt = eventTime(timestamp, "Syslog timestamp", 6);
  if (hostname.length > 255 || appName.length > 48 || processId.length > 128 || messageId.length > 32) throw new TypeError("Syslog header length is invalid.");
  let index = header[0].length;
  const structuredData = [], ids = new Set();
  function name() {
    const start = index;
    while (index < raw.length && /[\x21-\x7e]/.test(raw[index]) && !/[=\]" ]/.test(raw[index])) index++;
    const value = raw.slice(start, index);
    if (!value || value.length > 32) throw new TypeError("Invalid syslog structured-data name.");
    safeKey(value);
    return value;
  }
  if (raw[index] === "-") index++;
  else {
    while (raw[index] === "[") {
      index++;
      const id = name(), params = [];
      if (ids.has(id)) throw new TypeError("Repeated syslog structured-data ID.");
      ids.add(id);
      while (raw[index] === " ") {
        index++;
        const key = name();
        if (raw.slice(index, index + 2) !== '=\"') throw new TypeError("Invalid syslog structured-data parameter.");
        index += 2;
        let value = "", closed = false;
        while (index < raw.length) {
          const ch = raw[index++];
          if (ch === '"') { closed = true; break; }
          if (ch === "]") throw new TypeError("Syslog structured-data closing brackets must be escaped.");
          if (ch === "\\" && ['"', "\\", "]"].includes(raw[index])) value += raw[index++];
          else value += ch; // RFC 5424 requires preserving unknown escape sequences.
        }
        if (!closed) throw new TypeError("Unterminated syslog structured data.");
        // Repeated parameter names are permitted by RFC 5424; retain the pairs.
        params.push([key, value]);
      }
      if (raw[index++] !== "]") throw new TypeError("Invalid syslog structured-data terminator.");
      structuredData.push({ id, params });
    }
    if (!structuredData.length) throw new TypeError("Syslog structured data is required (or NILVALUE).");
  }
  if (raw[index++] !== " ") throw new TypeError("This log import profile requires a nonempty syslog MSG.");
  let message = raw.slice(index);
  if (message.startsWith("\uFEFF")) message = message.slice(1);
  text(message, "Syslog MSG", 4000);
  return { priority: Number(priority), timestamp, observedAt, hostname, appName, processId, messageId, structuredData, message };
}
function syslogFields(parsed, fields) {
  field(fields, "originalTimestamp", parsed.timestamp);
  field(fields, "facility", Math.floor(parsed.priority / 8));
  field(fields, "severityCode", parsed.priority % 8);
  for (const key of ["hostname", "appName", "processId", "messageId"]) if (parsed[key] !== "-") field(fields, key, parsed[key]);
  if (parsed.structuredData.length) field(fields, "structuredData", parsed.structuredData);
}
function normalizeSyslog(input) {
  return rows(input).map(row => {
    const parsed = parseSyslog(wrappedMessage(row).message);
    const fields = { provider: "syslog", originalSeverity: parsed.priority % 8, timeBasis: "syslog.timestamp" };
    syslogFields(parsed, fields);
    return finish(digest("syslog", parsed), parsed.observedAt, { title: "Syslog event", state: "unknown", severity: ["critical", "critical", "critical", "high", "medium", "low", "info", "info"][parsed.priority % 8],
      category: "syslog.rfc5424", message: parsed.message, fields });
  });
}

function cefHeader(raw) {
  const parts = [];
  let value = "", i = 0;
  for (; i < raw.length && parts.length < 7; i++) {
    const ch = raw[i];
    if (ch === "|") { parts.push(value); value = ""; }
    else if (ch === "\\") {
      const next = raw[++i];
      if (!["|", "\\"].includes(next)) throw new TypeError("Unsupported CEF header escape.");
      value += next;
    } else {
      if (/[\r\n]/.test(ch)) throw new TypeError("CEF header must be one line.");
      value += ch;
    }
  }
  if (parts.length !== 7 || !/^CEF:[01]$/.test(parts[0])) throw new TypeError("Malformed CEF version 0/1 header.");
  for (const item of parts.slice(1)) text(item, "CEF header field");
  return { parts, extension: raw.slice(i) };
}
function cefExtensions(raw) {
  const result = Object.create(null);
  let index = 0;
  while (index < raw.length) {
    // Exactly one space delimits fields; additional spaces belong to the prior value.
    if (index === 0) while (raw[index] === " ") index++;
    if (index === raw.length) break;
    const keyMatch = /^[A-Za-z][A-Za-z0-9_.:-]*=/.exec(raw.slice(index));
    if (!keyMatch) throw new TypeError("Invalid CEF extension key.");
    const key = keyMatch[0].slice(0, -1);
    safeKey(key);
    if (Object.hasOwn(result, key)) throw new TypeError("Repeated CEF extension key.");
    index += keyMatch[0].length;
    let value = "";
    while (index < raw.length) {
      const ch = raw[index];
      if (ch === " " && /^[A-Za-z][A-Za-z0-9_.:-]*=/.test(raw.slice(index + 1))) { index++; break; }
      index++;
      if (ch === "\\") {
        const next = raw[index++];
        if (!["\\", "=", "n", "r"].includes(next)) throw new TypeError("Unsupported CEF extension escape.");
        value += next === "n" ? "\n" : next === "r" ? "\r" : next;
      } else {
        if (ch === "=" || /[\r\n]/.test(ch)) throw new TypeError("CEF equals and newlines must be escaped inside extension values.");
        value += ch;
      }
    }
    result[key] = value;
  }
  return result;
}
function cefTime(value) {
  if (/^(0|[1-9]\d{0,15})$/.test(value)) {
    const ms = Number(value);
    if (!Number.isSafeInteger(ms) || ms > 253402300799999) throw new TypeError("CEF epoch milliseconds exceed supported range.");
    return new Date(ms).toISOString();
  }
  return eventTime(value, "CEF timestamp");
}
function normalizeCef(input) {
  return rows(input).map(row => {
    const wrapper = wrappedMessage(row, ["message", "timestamp"]);
    let raw = text(wrapper.message, "CEF message", 16000), syslog;
    if (raw.startsWith("<")) { syslog = parseSyslog(raw); raw = syslog.message; }
    const { parts, extension } = cefHeader(raw), ext = cefExtensions(extension);
    const [, vendor, product, deviceVersion, eventClassId, eventName, originalSeverity] = parts;
    const fields = { provider: "cef", vendor, product, deviceVersion, eventClassId, eventName, originalSeverity };
    let severity;
    if (/^(?:[0-9]|10)$/.test(originalSeverity)) {
      const n = Number(originalSeverity); severity = n <= 3 ? "low" : n <= 6 ? "medium" : n <= 8 ? "high" : "critical";
    } else severity = ({ unknown: "unknown", low: "low", medium: "medium", high: "high", "very-high": "critical" })[originalSeverity.toLowerCase()];
    if (!severity) throw new TypeError("Unsupported CEF severity.");
    let observedAt;
    for (const key of ["end", "start", "rt"]) if (Object.hasOwn(ext, key)) {
      const at = cefTime(ext[key]);
      if (!observedAt) { observedAt = at; field(fields, "timeBasis", "cef." + key); field(fields, "originalTimestamp", ext[key]); }
    }
    if (wrapper.timestamp !== undefined) {
      const at = eventTime(wrapper.timestamp, "CEF wrapper timestamp");
      field(fields, "wrapperTimestamp", wrapper.timestamp);
      if (!observedAt) { observedAt = at; field(fields, "timeBasis", "wrapper.timestamp"); }
    }
    if (syslog) {
      // Keep transport-header facts separate from CEF event time and severity.
      for (const key of ["timestamp", "hostname", "appName", "processId", "messageId"]) if (syslog[key] !== "-") field(fields, "syslog." + key, syslog[key]);
      if (syslog.structuredData.length) field(fields, "syslog.structuredData", syslog.structuredData);
      field(fields, "syslog.priority", syslog.priority);
      if (!observedAt) { observedAt = syslog.observedAt; field(fields, "timeBasis", "syslog.timestamp"); }
    }
    if (!observedAt) throw new TypeError("CEF requires explicit end/start/rt time, a timestamp wrapper, or an RFC 5424 header.");
    for (const key of Object.keys(ext).sort()) field(fields, "cef." + key, ext[key]);
    if (ext.act !== undefined) field(fields, "action", ext.act);
    if (ext.outcome !== undefined) field(fields, "outcome", ext.outcome);
    const upstreamId = ext.externalId ? digest("cef-id", [vendor, product, ext.dvc || "", ext.dvchost || "", ext.externalId])
      : digest("cef", { parts, ext, observedAt, syslog: syslog || null, timestamp: wrapper.timestamp || null });
    return finish(upstreamId, observedAt, { title: "CEF event", state: "unknown", severity, category: "cef", message: text(ext.msg || eventName, "CEF message", 4000), fields });
  });
}

function unsigned(value, label, bits = 64) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must not lose integer precision.`);
    value = String(value);
  }
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value) || value.length > 20 || BigInt(value) >= (1n << BigInt(bits))) throw new TypeError(`${label} must be an unsigned ${bits}-bit integer.`);
  return value;
}
function nanoTime(value, label) {
  const exactValue = unsigned(value, label);
  if (exactValue === "0") return { exact: exactValue, observedAt: null };
  // Never convert nanoseconds to Number: division happens in integer space first.
  const ms = BigInt(exactValue) / 1000000n;
  return { exact: exactValue, observedAt: new Date(Number(ms)).toISOString() };
}
function anyValue(value, depth = 0) {
  object(value, "OTLP AnyValue");
  if (depth > 10 || Object.keys(value).length !== 1) throw new TypeError("OTLP AnyValue must select exactly one bounded value.");
  const key = Object.keys(value)[0], item = value[key];
  if (key === "stringValue") return text(item, "OTLP string", 4000, true);
  if (key === "boolValue" && typeof item === "boolean") return item;
  if (key === "doubleValue" && typeof item === "number" && Number.isFinite(item)) return item;
  if (key === "intValue") {
    if (!["string", "number"].includes(typeof item)) throw new TypeError("OTLP intValue must be a decimal integer.");
    if (typeof item === "number" && !Number.isSafeInteger(item)) throw new TypeError("OTLP intValue loses precision.");
    const str = String(item);
    if (!/^-?(0|[1-9]\d*)$/.test(str) || str.length > 20 || BigInt(str) < -(1n << 63n) || BigInt(str) >= (1n << 63n)) throw new TypeError("OTLP intValue must be signed 64-bit decimal.");
    return str;
  }
  if (key === "bytesValue" && typeof item === "string" && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item)) return stable(value);
  if (key === "arrayValue") { exact(item, ["values"], "OTLP arrayValue"); boundedList(item.values === undefined ? [] : item.values, "OTLP arrayValue").forEach(entry => anyValue(entry, depth + 1)); return stable(value); }
  if (key === "kvlistValue") { exact(item, ["values"], "OTLP kvlistValue"); attributes(item.values === undefined ? [] : item.values, depth + 1); return stable(value); }
  throw new TypeError("Unsupported OTLP AnyValue encoding.");
}
function boundedList(value, label) {
  if (!Array.isArray(value) || value.length > 1000) throw new TypeError(`${label} must be a bounded array.`);
  return Array.from(value);
}
function attributes(value, depth = 0) {
  const result = Object.create(null);
  for (const entry of boundedList(value, "OTLP attributes")) {
    exact(entry, ["key", "value"], "OTLP KeyValue");
    const key = text(entry.key, "OTLP attribute key", 256);
    safeKey(key);
    if (Object.hasOwn(result, key)) throw new TypeError("Duplicate OTLP attribute key.");
    result[key] = anyValue(entry.value, depth + 1);
  }
  return result;
}
function normalizeOtlp(input) {
  const results = [];
  for (const envelope of rows(input)) {
    exact(envelope, ["resourceLogs"], "OTLP ExportLogsServiceRequest");
    for (const resourceLog of boundedList(envelope.resourceLogs, "OTLP resourceLogs")) {
      exact(resourceLog, ["resource", "scopeLogs", "schemaUrl"], "OTLP ResourceLogs");
      const resource = resourceLog.resource === undefined ? {} : resourceLog.resource;
      exact(resource, ["attributes", "droppedAttributesCount"], "OTLP Resource");
      const resourceAttrs = attributes(resource.attributes === undefined ? [] : resource.attributes);
      for (const scopeLog of boundedList(resourceLog.scopeLogs === undefined ? [] : resourceLog.scopeLogs, "OTLP scopeLogs")) {
        exact(scopeLog, ["scope", "logRecords", "schemaUrl"], "OTLP ScopeLogs");
        const scope = scopeLog.scope === undefined ? {} : scopeLog.scope;
        exact(scope, ["name", "version", "attributes", "droppedAttributesCount"], "OTLP InstrumentationScope");
        const scopeAttrs = attributes(scope.attributes === undefined ? [] : scope.attributes);
        for (const log of boundedList(scopeLog.logRecords === undefined ? [] : scopeLog.logRecords, "OTLP logRecords")) {
          exact(log, ["timeUnixNano", "observedTimeUnixNano", "severityNumber", "severityText", "body", "attributes", "droppedAttributesCount", "flags", "traceId", "spanId", "eventName"], "OTLP LogRecord");
          const time = nanoTime(log.timeUnixNano === undefined ? "0" : log.timeUnixNano, "OTLP timeUnixNano");
          const observed = nanoTime(log.observedTimeUnixNano === undefined ? "0" : log.observedTimeUnixNano, "OTLP observedTimeUnixNano");
          if (!time.observedAt && !observed.observedAt) throw new TypeError("OTLP log needs original event or observed time; neither may be invented.");
          const attrs = attributes(log.attributes === undefined ? [] : log.attributes), fields = { provider: "opentelemetry", timeUnixNano: time.exact,
            observedTimeUnixNano: observed.exact, timeBasis: time.observedAt ? "timeUnixNano" : "observedTimeUnixNano" };
          const attributeTypes = Object.create(null);
          for (const [prefix, source] of [["resource", resource.attributes], ["scope", scope.attributes], ["log", log.attributes]]) {
            for (const entry of source || []) attributeTypes[prefix + "." + entry.key] = Object.keys(entry.value)[0];
          }
          if (Object.keys(attributeTypes).length) field(fields, "attributeTypes", attributeTypes);
          for (const [prefix, values] of [["resource", resourceAttrs], ["scope", scopeAttrs], ["log", attrs]]) {
            for (const key of Object.keys(values).sort()) field(fields, prefix + "." + key, values[key]);
          }
          for (const [key, value] of [["resourceSchemaUrl", resourceLog.schemaUrl], ["scopeSchemaUrl", scopeLog.schemaUrl],
            ["scopeName", scope.name], ["scopeVersion", scope.version], ["eventName", log.eventName]]) {
            if (value !== undefined) field(fields, key, text(value, "OTLP " + key, 1000, true));
          }
          for (const [key, value] of [["resourceDroppedAttributesCount", resource.droppedAttributesCount], ["scopeDroppedAttributesCount", scope.droppedAttributesCount], ["droppedAttributesCount", log.droppedAttributesCount], ["flags", log.flags]]) {
            if (value !== undefined) field(fields, key, Number(unsigned(value, key, 32)));
          }
          for (const [key, size] of [["traceId", 32], ["spanId", 16]]) if (log[key] !== undefined && log[key] !== "") {
            if (typeof log[key] !== "string" || !new RegExp("^[0-9a-fA-F]{" + size + "}$").test(log[key])) throw new TypeError("OTLP trace/span ID must be hexadecimal, not base64.");
            field(fields, key, log[key].toLowerCase());
          }
          const severityNumber = log.severityNumber === undefined ? 0 : log.severityNumber;
          if (!Number.isInteger(severityNumber) || severityNumber < 0 || severityNumber > 24) throw new TypeError("OTLP severityNumber must be 0 through 24.");
          field(fields, "severityNumber", severityNumber);
          if (log.severityText !== undefined) field(fields, "originalSeverity", text(log.severityText, "OTLP severityText", 1000, true));
          for (const key of ["action", "outcome"]) if (typeof attrs["event." + key] === "string") field(fields, key, attrs["event." + key]);
          const body = anyValue(log.body);
          field(fields, "bodyType", Object.keys(log.body)[0]);
          const message = typeof body === "string" ? body : JSON.stringify(stable(body));
          const observedAt = time.observedAt || observed.observedAt;
          const severity = severityNumber === 0 ? "unknown" : severityNumber <= 12 ? "info" : severityNumber <= 16 ? "medium" : severityNumber <= 20 ? "high" : "critical";
          const payload = { title: "OpenTelemetry log", state: "unknown", severity, category: "opentelemetry.log", message: text(message, "OTLP body", 4000), fields };
          // Exact times are in fields, so submillisecond events cannot collapse.
          results.push(finish(digest("otlp-log", payload), observedAt, payload));
          if (results.length > 1000) throw new TypeError("OTLP export exceeds 1000 log records.");
        }
      }
    }
  }
  if (!results.length) throw new TypeError("Empty OTLP export is not a health proof.");
  return results;
}

function normalizeMicrosoft365(input) {
  return rows(input).map(event => {
    object(event, "Microsoft 365 audit record");
    const id = text(event.Id, "Microsoft 365 Id", 128), organization = text(event.OrganizationId, "Microsoft 365 OrganizationId", 128);
    const action = text(event.Operation, "Microsoft 365 Operation", 300), workload = text(event.Workload, "Microsoft 365 Workload", 128);
    if (!Number.isSafeInteger(event.RecordType) || event.RecordType < 0) throw new TypeError("Microsoft 365 RecordType must be an integer.");
    let originalTimestamp = text(event.CreationTime, "Microsoft 365 CreationTime", 35);
    // The Management Activity common schema defines CreationTime as UTC, even
    // in exports which omit Z. This exception must never extend to generic logs.
    const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?$/.test(originalTimestamp) ? originalTimestamp + "Z" : originalTimestamp;
    const observedAt = eventTime(utc, "Microsoft 365 CreationTime");
    const fields = { provider: "microsoft365", workload, recordType: event.RecordType, action, originalTimestamp, timeBasis: "CreationTime.UTC",
      organizationRef: digest("m365-organization", organization), upstreamEventId: id, outcomeScope: "provider-operation-only" };
    if (event.ResultStatus !== undefined) {
      const outcome = event.ResultStatus;
      if (typeof outcome !== "string" && !Number.isSafeInteger(outcome)) throw new TypeError("Microsoft 365 ResultStatus must be text or an integer.");
      field(fields, "outcome", typeof outcome === "string" ? text(outcome, "Microsoft 365 ResultStatus") : outcome);
    }
    if (event.UserType !== undefined) field(fields, "userType", Number(unsigned(event.UserType, "Microsoft 365 UserType", 32)));
    for (const [from, to] of [["ClientIP", "sourceAddress"], ["LogonError", "logonError"]]) if (event[from] !== undefined && event[from] !== null && event[from] !== "") field(fields, to, text(event[from], "Microsoft 365 " + from));
    // One reviewed Exchange command parameter supports the original audit-change
    // rule. This is not arbitrary parameter flattening or a configuration verdict.
    if (action === "Set-AdminAuditLogConfig" && event.Parameters !== undefined) {
      let seen = false;
      for (const parameter of boundedList(event.Parameters, "Microsoft 365 Parameters")) {
        object(parameter, "Microsoft 365 command parameter");
        if (parameter.Name !== "UnifiedAuditLogIngestionEnabled") continue;
        if (seen) throw new TypeError("Repeated Microsoft 365 audit-ingestion parameter.");
        seen = true;
        const value = parameter.Value;
        if (typeof value !== "boolean" && (typeof value !== "string" || !/^(true|false)$/i.test(value))) {
          throw new TypeError("Audit-ingestion parameter must be a bounded boolean value.");
        }
        field(fields, "m365.UnifiedAuditLogIngestionEnabled", String(value).toLowerCase() === "true" ? "True" : "False");
      }
    }
    const payload = { title: "Microsoft 365 audit event", state: "unknown", category: "microsoft365.audit", message: `${workload}: ${action}`, fields };
    if (event.UserId !== undefined && event.UserId !== null && event.UserId !== "") payload.identityRef = digest("m365-user", [organization, text(event.UserId, "Microsoft 365 UserId")]);
    // ResultStatus can describe HTTP success while the sign-in failed. Preserve
    // it without inventing an authentication success or an incident verdict.
    return finish(digest("m365-audit", [organization, id]), observedAt, payload);
  });
}

const adapters = Object.freeze([
  { id: "syslog-rfc5424", title: "RFC 5424 syslog", description: "Version-1 RFC 5424 UTF-8 messages with explicit known timestamp and nonempty MSG. Preserves bounded structured data; no network listener or RFC 3164 year inference.", recordKinds: ["log.event"],
    formats: ["JSON string containing one RFC 5424 message", "object with message string; array or NDJSON of these objects"],
    docs: [{ title: "RFC 5424 syslog protocol", url: "https://www.rfc-editor.org/rfc/rfc5424.html" }], normalize: normalizeSyslog },
  { id: "cef", title: "Common Event Format", description: "CEF 0/1 export with parsed escaped header/extensions and explicit epoch-millisecond/RFC 3339 time. Optional RFC 5424 header; no legacy year or timezone inference.", recordKinds: ["log.event"],
    formats: ["JSON string containing CEF with end/start/rt timestamp", "object with message and optional original timestamp; array or NDJSON", "RFC 5424 message whose MSG is CEF"],
    docs: [{ title: "CEF implementation standard", url: "https://docs.microfocus.com/doc/2097/25.4/siemcefimplementationstandard" }, { title: "CEF extension dictionary", url: "https://www.microfocus.com/documentation/arcsight/arcsight-smartconnectors-8.3/cef-implementation-standard/Content/CEF/Chapter%202%20ArcSight%20Extension.htm" }], normalize: normalizeCef },
  { id: "otlp-logs", title: "OpenTelemetry JSON logs", description: "Bounded JSON ExportLogsServiceRequest import, preserving resource/scope/log attributes and exact nanosecond times. Not an OTLP HTTP/gRPC endpoint; no metrics or traces.", recordKinds: ["log.event"],
    formats: ["OTLP JSON object with resourceLogs/scopeLogs/logRecords", "array or NDJSON of complete OTLP JSON request objects"],
    docs: [{ title: "OTLP JSON specification", url: "https://opentelemetry.io/docs/specs/otlp/" }, { title: "OpenTelemetry logs protobuf schema", url: "https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/logs/v1/logs.proto" }], normalize: normalizeOtlp },
  { id: "microsoft365-audit", title: "Microsoft 365 audit", description: "Management Activity content records with selected common fields and hashed tenant/user references. No API polling; ResultStatus remains an operation fact, not inferred sign-in success.", recordKinds: ["log.event"],
    formats: ["Management Activity content JSON array", "single audit record or NDJSON with Id, OrganizationId, CreationTime, Workload, RecordType and Operation"],
    docs: [{ title: "Microsoft 365 Management Activity schema", url: "https://learn.microsoft.com/en-us/office/office-365-management-api/office-365-management-activity-api-schema" }, { title: "Microsoft 365 Management Activity API", url: "https://learn.microsoft.com/en-us/office/office-365-management-api/office-365-management-activity-api-reference" }], normalize: normalizeMicrosoft365 }
].map(Object.freeze));
module.exports = { adapters };
