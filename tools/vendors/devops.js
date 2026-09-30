"use strict";

// Pure, conservative adapters for exported API response bodies. No network,
// secret storage, pagination, scanner execution or local-clock substitution.
const crypto = require("node:crypto");
const { validateTimestamp } = require("../ingest-contract");
const MAX_EVENTS = 1000;

function invalid() { throw new TypeError("Vendor export does not match the supported event format; no events were imported."); }
function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !descriptor || descriptor.get || descriptor.set) invalid();
  }
  return value;
}
function text(value, maximum = 512) {
  if (typeof value !== "string" || !value || value.length > maximum || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) invalid();
  return value;
}
function opaqueId(value, maximum = 512) {
  const result = text(value, maximum);
  if (!/^[A-Za-z0-9_-]+$/.test(result)) invalid();
  return result;
}
function numericId(value) {
  if (Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9][0-9]{0,39}$/.test(value)) return value;
  invalid();
}
function isoTime(value) {
  const input = text(value, 40);
  // Sentry reports microseconds. Keep valid calendar/offset semantics while
  // reducing finer-than-millisecond precision to the canonical contract.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(input)) invalid();
  const normalized = input.replace(/\.(\d{3})\d+(?=Z|[+-])/, ".$1");
  try { validateTimestamp(normalized, "Vendor event timestamp"); return new Date(normalized).toISOString(); }
  catch { invalid(); }
}
function epochMillis(value) {
  if (!Number.isSafeInteger(value) || value < 0) invalid();
  try { return isoTime(new Date(value).toISOString()); } catch { invalid(); }
}
function ref(provider, label, value) {
  return label + ":" + crypto.createHash("sha256").update(JSON.stringify([provider, label, text(value, 1024)])).digest("hex");
}
function optionalRef(fields, key, provider, label, value, numeric = false) {
  if (value !== undefined && value !== null) fields[key] = ref(provider, label, numeric ? numericId(value) : text(value, 1024));
}
function events(input, normalize) {
  const values = Array.isArray(input) ? input : [object(input)];
  if (values.length > MAX_EVENTS) invalid();
  const seen = new Set();
  return Array.from(values, value => {
    const result = normalize(object(value));
    if (seen.has(result.upstreamId)) invalid();
    seen.add(result.upstreamId);
    return result;
  });
}
function enumValue(value, allowed, fallback = "other") {
  if (value === undefined || value === null) return "unknown";
  text(value, 120);
  return allowed.includes(value) ? value : fallback;
}

const GITHUB_ACTION_CLASSES = Object.freeze(["org", "repo", "team", "git", "user", "business", "integration", "oauth_application", "personal_access_token"]);
function github(input) {
  return events(input, event => {
    const upstreamId = opaqueId(event._document_id, 256);
    const observedAt = epochMillis(event["@timestamp"] === undefined ? event.created_at : event["@timestamp"]);
    const action = text(event.action, 160);
    if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(action)) invalid();
    const actionClass = GITHUB_ACTION_CLASSES.includes(action.split(".")[0]) ? action.split(".")[0] : "other";
    const fields = { provider: "github", actionClass, actionRef: ref("github", "action", action) };
    optionalRef(fields, "organizationRef", "github", "organization", event.org_id === undefined ? event.org : event.org_id, event.org_id !== undefined);
    optionalRef(fields, "repositoryRef", "github", "repository", event.repo_id === undefined ? event.repo : event.repo_id, event.repo_id !== undefined);
    optionalRef(fields, "actorRef", "github", "actor", event.actor_id === undefined ? event.actor : event.actor_id, event.actor_id !== undefined);
    if (event.operation_type !== undefined) fields.operation = enumValue(event.operation_type, ["create", "modify", "remove", "access", "authentication"]);
    return { upstreamId, observedAt, kind: "audit.event", payload: {
      title: "GitHub organization audit observation", state: "unknown", severity: "unknown", category: "github.audit", fields
    } };
  });
}

const GITLAB_ENTITY_TYPES = Object.freeze(["User", "Group", "Project", "Key", "Gitlab::Audit::InstanceScope"]);
function gitlab(input) {
  return events(input, event => {
    const upstreamId = numericId(event.id), observedAt = isoTime(event.created_at);
    const entityType = text(event.entity_type, 120), entityId = numericId(event.entity_id);
    const details = object(event.details);
    const fields = { provider: "gitlab", entityType: GITLAB_ENTITY_TYPES.includes(entityType) ? entityType : "other",
      entityRef: ref("gitlab", "entity", JSON.stringify([entityType, entityId])) };
    const eventType = event.event_type === undefined ? details.event_type : event.event_type;
    if (eventType !== undefined && eventType !== null) fields.eventTypeRef = ref("gitlab", "event-type", text(eventType, 160));
    optionalRef(fields, "actorRef", "gitlab", "actor", event.author_id, true);
    return { upstreamId, observedAt, kind: "audit.event", payload: {
      title: "GitLab audit observation", state: "unknown", severity: "unknown", category: "gitlab.audit", fields
    } };
  });
}

const SENTRY_LEVELS = Object.freeze(["debug", "info", "warning", "error", "fatal"]);
const SENTRY_PLATFORMS = Object.freeze(["javascript", "python", "node", "java", "php", "ruby", "go", "csharp", "dotnet", "native", "cocoa", "objc", "swift", "android", "kotlin", "react-native", "dart", "elixir", "rust", "other"]);
function sentry(input) {
  return events(input, event => {
    if (typeof event.eventID !== "string" || !/^[a-fA-F0-9]{32}$/.test(event.eventID)) invalid();
    const upstreamId = event.eventID.toLowerCase(), observedAt = isoTime(event.dateCreated);
    const eventType = event["event.type"] === undefined ? event.type : event["event.type"];
    if (eventType !== "error" || (event.type !== undefined && event.type !== "error")) invalid();
    let level;
    if (event.tags !== undefined) {
      if (!Array.isArray(event.tags) || event.tags.length > 1000) invalid();
      const levels = event.tags.map(object).filter(tag => tag.key === "level");
      if (levels.length > 1) invalid();
      if (levels.length) level = levels[0].value;
    }
    if (event.level !== undefined) {
      if (level !== undefined && event.level !== level) invalid();
      level = event.level;
    }
    const fields = { provider: "sentry", eventType: "error", reportedLevel: enumValue(level, SENTRY_LEVELS), platform: enumValue(event.platform, SENTRY_PLATFORMS) };
    optionalRef(fields, "projectRef", "sentry", "project", event.projectID, true);
    optionalRef(fields, "issueRef", "sentry", "issue", event.groupID, true);
    return { upstreamId, observedAt, kind: "log.event", payload: {
      title: "Sentry application error observation", state: "unknown", severity: "unknown", category: "application.error", channel: "sentry",
      message: "Imported application error metadata. This observation is not classified as a security finding.", fields
    } };
  });
}

const DATADOG_LEVELS = Object.freeze(["emergency", "emerg", "alert", "critical", "crit", "error", "err", "warning", "warn", "notice", "info", "informational", "debug", "ok"]);
function datadog(input) {
  let values = input;
  if (!Array.isArray(input)) {
    const envelope = object(input);
    if (Object.hasOwn(envelope, "data")) {
      if (Object.keys(envelope).some(key => !["data", "meta", "links"].includes(key)) || !Array.isArray(envelope.data)) invalid();
      if (envelope.meta !== undefined) {
        const meta = object(envelope.meta);
        if (meta.status !== undefined && meta.status !== "done") invalid();
        if (meta.warnings !== undefined && (!Array.isArray(meta.warnings) || meta.warnings.length)) invalid();
        if (meta.page !== undefined) object(meta.page);
      }
      if (envelope.links !== undefined) object(envelope.links);
      values = envelope.data;
    }
  }
  return events(values, event => {
    if (event.type !== "log") invalid();
    const upstreamId = opaqueId(event.id), attributes = object(event.attributes), observedAt = isoTime(attributes.timestamp);
    const fields = { provider: "datadog", reportedLevel: enumValue(attributes.status === undefined ? undefined : text(attributes.status, 120).toLowerCase(), DATADOG_LEVELS) };
    optionalRef(fields, "serviceRef", "datadog", "service", attributes.service);
    optionalRef(fields, "hostRef", "datadog", "host", attributes.host);
    return { upstreamId, observedAt, kind: "log.event", payload: {
      title: "Datadog log observation", state: "unknown", severity: "unknown", category: "application.log", channel: "datadog",
      message: "Imported log metadata. The original log message and arbitrary attributes are not retained.", fields
    } };
  });
}

function adapter(definition) {
  return Object.freeze({ ...definition, recordKinds: Object.freeze(definition.recordKinds), formats: Object.freeze(definition.formats),
    docs: Object.freeze(definition.docs.map(Object.freeze)) });
}

const adapters = Object.freeze([
  adapter({ id: "github-audit", title: "GitHub organization audit log", recordKinds: ["audit.event"],
    description: "Normalize an exported organization audit API page or event using its document ID and epoch-millisecond timestamp. Hashed actor/resource/action references; no repository names, identities or raw event data. Does not fetch pages or establish collection completeness.",
    formats: ["Organization audit API response array (0–1000 events)", "One organization audit event with _document_id, action and @timestamp or created_at in epoch milliseconds"],
    docs: [{ title: "GitHub organization audit log API", url: "https://docs.github.com/en/enterprise-cloud%40latest/rest/orgs/orgs#get-the-audit-log-for-an-organization" }], normalize: github }),
  adapter({ id: "gitlab-audit", title: "GitLab audit events", recordKinds: ["audit.event"],
    description: "Normalize an exported instance, group or project audit API page/event. Event ID, created_at and entity metadata are required; actor/entity/event-type references are hashed. No author names, email, paths, IPs, change values or custom messages. Pagination and collector permissions remain external.",
    formats: ["Audit events API response array (0–1000 events)", "One API audit event with id, created_at, entity_id, entity_type and details"],
    docs: [{ title: "GitLab audit events API", url: "https://docs.gitlab.com/api/audit_events/" },
      { title: "GitLab audit event schema", url: "https://docs.gitlab.com/user/compliance/audit_event_schema/" }], normalize: gitlab }),
  adapter({ id: "sentry-events", title: "Sentry application error events", recordKinds: ["log.event"],
    description: "Normalize exported project/issue error-event API pages or one event. Requires eventID, dateCreated and type/event.type error. Application-error metadata only, not security findings; no raw messages, titles, stack traces, request data or user details. One supplied page is not full project history.",
    formats: ["Project or issue error-events API response array (0–1000 events)", "One retrieved error event with eventID and dateCreated; microsecond precision is normalized to milliseconds"],
    docs: [{ title: "Sentry project error events API", url: "https://docs.sentry.io/api/events/list-a-projects-error-events/" },
      { title: "Sentry retrieve project event API", url: "https://docs.sentry.io/api/events/retrieve-an-event-for-a-project/" },
      { title: "Sentry issue events API", url: "https://docs.sentry.io/api/events/list-an-issues-events/" }], normalize: sentry }),
  adapter({ id: "datadog-logs", title: "Datadog Logs v2", recordKinds: ["log.event"],
    description: "Normalize one exported Logs v2 page, event array or log event. Requires log ID and attributes.timestamp. Rejects timeout/partial-warning/error responses; ignores pagination links/cursors, without fetching more. No raw messages, tags or arbitrary attributes; service/host references are hashed.",
    formats: ["Logs v2 search response {data:[...], meta?, links?} (0–1000 events); only done/no-warning results", "Array of Logs v2 log objects or one {id,type:log,attributes:{timestamp,...}} object"],
    docs: [{ title: "Datadog Logs v2 search API", url: "https://docs.datadoghq.com/api/latest/logs/search-logs-post/" },
      { title: "Datadog programmatic log retrieval guide", url: "https://docs.datadoghq.com/logs/guide/access-your-log-data-programmatically/" }], normalize: datadog })
]);

module.exports = { adapters };
