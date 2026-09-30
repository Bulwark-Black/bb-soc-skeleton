"use strict";

const { createHash } = require("node:crypto");
const { validateTimestamp } = require("../ingest-contract");

// These adapters consume exported JSON only. They neither fetch vendor APIs nor
// execute payloads. Unselected raw fields never cross into canonical records.
const MAX_RECORDS = 1000;
function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError(`${label} must be an object.`);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || descriptor.get || descriptor.set) throw new TypeError(`${label} must contain JSON data properties.`);
  }
  return value;
}
function string(value, label, maximum = 1024) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${label} must be a bounded nonempty string.`);
  }
  return value;
}
function token(value, label, maximum = 160) {
  const result = string(value, label, maximum);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(result)) throw new TypeError(`${label} is not a supported metadata name.`);
  return result;
}
function hash(prefix, ...values) { return `${prefix}:${createHash("sha256").update(JSON.stringify(values)).digest("hex")}`; }
function time(value, label) {
  const candidate = string(value, label, 35);
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(candidate);
  if (!match) throw new TypeError(`${label} must be an RFC 3339 timestamp with at most nine fractional digits.`);
  const fraction = (match[2] || "").padEnd(9, "0");
  const millis = `${match[1]}.${fraction.slice(0, 3)}${match[3]}`;
  validateTimestamp(millis, label);
  const observedAt = new Date(millis).toISOString();
  return { observedAt, precise: `${observedAt.slice(0, 19)}.${fraction}Z` };
}
function list(value, label) {
  if (!Array.isArray(value) || value.length > MAX_RECORDS) throw new TypeError(`${label} must be an array of at most 1000 records.`);
  return Array.from(value, item => object(item, `${label} entry`));
}
function envelope(value, allowed, label) {
  object(value, label);
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new TypeError(`${label} contains unsupported envelope fields.`);
}
function optionalObject(value, label) { return value === undefined || value === null ? {} : object(value, label); }
function optionalString(value, label) { return value === undefined || value === null || value === "" ? null : string(value, label); }
function optionalToken(value, label) { return value === undefined || value === null || value === "" ? null : token(value, label); }
function cursor(value, label) { if (value !== undefined && value !== null) string(value, label, 16384); }
function integer(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new TypeError(`${label} must be a bounded non-negative integer.`);
  return value;
}
function ensureNoError(value) {
  if (value.error !== undefined || value.errors !== undefined || value.Error !== undefined
      || value.__type !== undefined || value.success === false) throw new TypeError("A vendor error response is not an event export.");
}

function cloudTrailRows(input) {
  if (Array.isArray(input)) return list(input, "CloudTrail records");
  object(input, "CloudTrail input"); ensureNoError(input);
  if (input.Records !== undefined) {
    envelope(input, ["Records"], "CloudTrail log envelope");
    return list(input.Records, "CloudTrail Records");
  }
  if (input.Events !== undefined) {
    envelope(input, ["Events", "NextToken", "$metadata"], "CloudTrail lookup envelope");
    cursor(input.NextToken, "CloudTrail next-page cursor");
    return list(input.Events, "CloudTrail Events").map(item => {
      const raw = string(item.CloudTrailEvent, "CloudTrailEvent", 1048576);
      let event;
      try { event = JSON.parse(raw); } catch { throw new TypeError("CloudTrailEvent must contain one JSON event object."); }
      object(event, "CloudTrailEvent");
      if (item.EventId !== undefined && item.EventId !== event.eventID) throw new TypeError("CloudTrail lookup and event identities must agree.");
      return event;
    });
  }
  return [input];
}
function normalizeCloudTrail(input) {
  return cloudTrailRows(input).map(event => {
    ensureNoError(event);
    const eventId = string(event.eventID, "CloudTrail eventID", 128);
    const observedAt = time(event.eventTime, "CloudTrail eventTime").observedAt;
    const service = token(event.eventSource, "CloudTrail eventSource");
    const method = token(event.eventName, "CloudTrail eventName");
    const account = optionalString(event.recipientAccountId, "CloudTrail recipientAccountId");
    const identity = optionalObject(event.userIdentity, "CloudTrail userIdentity");
    const principal = optionalString(identity.arn, "CloudTrail principal ARN")
      || optionalString(identity.principalId, "CloudTrail principal ID");
    const errorCode = optionalToken(event.errorCode, "CloudTrail errorCode");
    const fields = { vendor: "aws", service, method };
    const region = optionalToken(event.awsRegion, "CloudTrail awsRegion");
    const eventType = optionalToken(event.eventType, "CloudTrail eventType");
    if (region) fields.region = region;
    if (eventType) fields.eventType = eventType;
    if (errorCode) fields.errorCode = errorCode;
    if (event.readOnly !== undefined) {
      if (typeof event.readOnly !== "boolean") throw new TypeError("CloudTrail readOnly must be boolean.");
      fields.readOnly = event.readOnly;
    }
    const isLogin = service === "signin.amazonaws.com" && method === "ConsoleLogin";
    const response = isLogin ? optionalObject(event.responseElements, "CloudTrail login response") : {};
    const outcome = response.ConsoleLogin;
    if (outcome !== undefined && !["Success", "Failure"].includes(outcome)) throw new TypeError("CloudTrail ConsoleLogin outcome is unsupported.");
    const payload = { title: isLogin ? "AWS console sign-in" : `AWS audit: ${method}`,
      state: errorCode || outcome === "Failure" ? "failed" : outcome === "Success" ? "ok" : "unknown",
      category: "aws.cloudtrail", fields };
    if (account) payload.assetRef = hash("aws-account", account);
    if (principal) payload.identityRef = hash("aws-principal", account || "", principal);
    // An anonymous/omitted principal is not invented merely to call it an auth event.
    return { upstreamId: hash("aws-cloudtrail", account || "", eventId), observedAt,
      kind: isLogin && principal ? "authentication.event" : "audit.event", payload };
  });
}

function gcpRows(input) {
  if (Array.isArray(input)) return list(input, "Google Cloud audit entries");
  object(input, "Google Cloud audit input"); ensureNoError(input);
  if (input.entries !== undefined) {
    envelope(input, ["entries", "nextPageToken"], "Google Cloud entries.list envelope");
    cursor(input.nextPageToken, "Google Cloud next-page cursor");
    return list(input.entries, "Google Cloud entries");
  }
  // entries.list can omit an empty repeated field; a cursor is still not success
  // or completeness evidence. The caller must continue retrieval independently.
  if (Object.keys(input).length === 0 || Object.keys(input).every(key => key === "nextPageToken")) {
    cursor(input.nextPageToken, "Google Cloud next-page cursor"); return [];
  }
  return [input];
}
function normalizeGcpAudit(input) {
  return gcpRows(input).map(entry => {
    ensureNoError(entry);
    const insertId = string(entry.insertId, "Google Cloud insertId");
    const logName = string(entry.logName, "Google Cloud logName", 2048);
    if (!/^(?:projects|organizations|billingAccounts|folders)\/[^/]+\/logs\/[^/]+$/.test(logName)) throw new TypeError("Google Cloud logName must be a fully scoped log resource name.");
    const at = time(entry.timestamp, "Google Cloud timestamp");
    const audit = object(entry.protoPayload, "Google Cloud protoPayload");
    if (audit["@type"] !== "type.googleapis.com/google.cloud.audit.AuditLog"
        || entry.jsonPayload !== undefined || entry.textPayload !== undefined) throw new TypeError("Only typed Google Cloud AuditLog entries are supported.");
    const service = token(audit.serviceName, "Google Cloud serviceName");
    const method = token(audit.methodName, "Google Cloud methodName");
    const status = optionalObject(audit.status, "Google Cloud audit status");
    const code = status.code === undefined ? 0 : integer(status.code, "Google Cloud status code", 16);
    const auth = optionalObject(audit.authenticationInfo, "Google Cloud authenticationInfo");
    const principal = optionalString(auth.principalSubject, "Google Cloud principal subject")
      || optionalString(auth.principalEmail, "Google Cloud principal email");
    const resourceName = optionalString(audit.resourceName, "Google Cloud resourceName");
    const payload = { title: `Google Cloud audit: ${method}`, state: code === 0 ? "ok" : "failed",
      category: "gcp.audit", fields: { vendor: "google-cloud", service, method, statusCode: code } };
    if (principal) payload.identityRef = hash("gcp-principal", principal);
    if (resourceName) payload.assetRef = hash("gcp-resource", service, resourceName);
    return { upstreamId: hash("gcp-audit", logName, insertId, at.precise), observedAt: at.observedAt, kind: "audit.event", payload };
  });
}

const CLOUDFLARE_ACTIONS = new Set(["unknown", "allow", "block", "challenge", "jschallenge", "log", "connectionclose",
  "challengesolved", "challengebypassed", "jschallengesolved", "jschallengebypassed", "bypass", "managedchallenge",
  "managedchallengenoninteractivesolved", "managedchallengeinteractivesolved", "managedchallengebypassed",
  "precursorinterstitialpageissued", "precursorinterstitialpagebypassed", "precursorinterstitialpagesolved"]);
function normalizeCloudflare(input) {
  const rows = Array.isArray(input) ? list(input, "Cloudflare firewall records") : [object(input, "Cloudflare firewall event")];
  return rows.map(event => {
    ensureNoError(event);
    const ray = string(event.RayID, "Cloudflare RayID", 128);
    const at = time(event.Datetime, "Cloudflare Datetime (configure RFC 3339 output)");
    const action = token(event.Action, "Cloudflare Action");
    if (!CLOUDFLARE_ACTIONS.has(action)) throw new TypeError("Cloudflare firewall Action is unsupported.");
    const source = token(event.Source, "Cloudflare Source");
    const rule = optionalString(event.RuleID, "Cloudflare RuleID");
    const matchIndex = event.MatchIndex === undefined ? null : integer(event.MatchIndex, "Cloudflare MatchIndex");
    const payload = { title: `Cloudflare firewall: ${action}`, state: "unknown", category: "cloudflare.firewall",
      fields: { vendor: "cloudflare", action, product: source } };
    if (rule) payload.ruleRef = hash("cloudflare-rule", rule);
    if (matchIndex !== null) payload.fields.matchIndex = matchIndex;
    if (event.EdgeResponseStatus !== undefined) payload.fields.edgeResponseStatus = integer(event.EdgeResponseStatus, "Cloudflare EdgeResponseStatus", 999);
    // A firewall block is an observation, not proof of a vulnerability or an incident.
    return { upstreamId: hash("cloudflare-firewall", ray, at.precise, action, source, rule || "", matchIndex),
      observedAt: at.observedAt, kind: "network.event", payload };
  });
}

const adapters = Object.freeze([
  Object.freeze({ id: "aws-cloudtrail", title: "AWS CloudTrail", description: "Management, data, and network audit exports; console sign-ins become authentication observations when a principal is present.",
    recordKinds: ["audit.event", "authentication.event"], formats: ["CloudTrail Records JSON", "LookupEvents Events page", "single event or event array"],
    docs: [{ title: "CloudTrail record contents", url: "https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-event-reference-record-contents.html" },
      { title: "AWS CLI event lookup", url: "https://docs.aws.amazon.com/awscloudtrail/latest/userguide/view-cloudtrail-events-cli.html" }], normalize: normalizeCloudTrail }),
  Object.freeze({ id: "gcp-audit", title: "Google Cloud Audit Logs", description: "Typed AuditLog exports with hashed principals/resources; scoped insert IDs and original timestamp precision preserve event identity.",
    recordKinds: ["audit.event"], formats: ["entries.list JSON page", "single AuditLog LogEntry or entry array"],
    docs: [{ title: "Cloud Logging LogEntry", url: "https://docs.cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry" },
      { title: "Cloud Logging entries.list", url: "https://docs.cloud.google.com/logging/docs/reference/v2/rest/v2/entries/list" },
      { title: "Cloud AuditLog schema", url: "https://docs.cloud.google.com/logging/docs/reference/audit/auditlog/rest/Shared.Types/AuditLog" }], normalize: normalizeGcpAudit }),
  Object.freeze({ id: "cloudflare-firewall", title: "Cloudflare Firewall Events", description: "Logpush firewall_events observations with RFC 3339 timestamps. Request bodies, addresses, URLs, headers, and metadata are discarded; not sampled GraphQL aggregates.",
    recordKinds: ["network.event"], formats: ["single firewall_events Logpush record or record array (RFC 3339 Datetime)"],
    docs: [{ title: "Firewall Events dataset", url: "https://developers.cloudflare.com/logs/logpush/logpush-job/datasets/zone/firewall_events/" },
      { title: "Logpush output formats", url: "https://developers.cloudflare.com/logs/logpush/logpush-job/log-output-options/" }], normalize: normalizeCloudflare })
]);

module.exports = { adapters };
