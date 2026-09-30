"use strict";

const crypto = require("node:crypto");
const { validateTimestamp } = require("../ingest-contract");

// These adapters read a supplied export/page. They never fetch a next link,
// resolve a user, accept a vendor credential, or retain a raw vendor object.
function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`${label} must be a JSON object.`);
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !descriptor || descriptor.get || descriptor.set) {
      throw new TypeError(`${label} must contain JSON data properties.`);
    }
  }
  return value;
}

function text(value, label, maximum = 512) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${label} must be bounded text.`);
  }
  return value;
}

function optionalId(value, label) {
  return value === undefined || value === null || value === "" ? null : text(value, label);
}

function hash(namespace, value) {
  return namespace + ":" + crypto.createHash("sha256").update(namespace + "\0" + value).digest("hex");
}

function eventTime(value, label) {
  // Graph can return finer precision than the canonical millisecond contract.
  // Validate the calendar and explicit offset before converting to UTC.
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new TypeError(`${label} must be an explicit RFC 3339 timestamp.`);
  }
  const millisecondTime = value.replace(/\.(\d{3})\d+(?=Z|[+-])/, ".$1");
  validateTimestamp(millisecondTime, label);
  return new Date(millisecondTime).toISOString();
}

function page(input, wrapperKey, wrapperMetadata = [], singleRequired = []) {
  let records = input;
  if (!Array.isArray(input)) {
    object(input, "Identity export");
    if ((!wrapperKey || !Object.hasOwn(input, wrapperKey))
        && singleRequired.every(key => Object.hasOwn(input, key))
        && !["error", "errors", "errorCode", "statusCode"].some(key => Object.hasOwn(input, key))) {
      return [input];
    }
    const allowed = new Set([wrapperKey, ...wrapperMetadata]);
    if (!wrapperKey || !Object.hasOwn(input, wrapperKey)
        || Reflect.ownKeys(input).some(key => !allowed.has(key))) {
      throw new TypeError("Identity export is not a supported successful response envelope.");
    }
    records = input[wrapperKey];
  }
  if (!Array.isArray(records) || records.length < 1 || records.length > 1000) {
    throw new TypeError("Identity export must contain 1 through 1000 events; empty pages are not health signals.");
  }
  return records;
}

function normalizePage(records, convert) {
  const ids = new Set();
  return records.map(value => {
    const result = convert(object(value, "Identity event"));
    if (ids.has(result.upstreamId)) throw new TypeError("Identity export contains duplicate event IDs.");
    ids.add(result.upstreamId);
    return result;
  });
}

function identity(provider, rawId, upstreamId, fields) {
  fields.identityReferenceSource = rawId ? "provider-id" : "event-unresolved";
  return hash(provider + (rawId ? "-identity" : "-unresolved"), rawId || upstreamId);
}

function normalizedEntra(input) {
  return normalizePage(page(input, "value", ["@odata.context", "@odata.nextLink", "@odata.count"], ["id", "createdDateTime"]), event => {
    const upstreamId = text(event.id, "Entra event ID");
    const observedAt = eventTime(event.createdDateTime, "Entra event timestamp");
    const userId = optionalId(event.userId, "Entra user ID");
    const fields = { provider: "microsoft-entra" };
    let state = "unknown";
    if (event.status !== undefined && event.status !== null) {
      object(event.status, "Entra status");
      const code = event.status.errorCode;
      if (code !== undefined && code !== null) {
        if (!Number.isSafeInteger(code) || code < 0 || code > 2147483647) {
          throw new TypeError("Entra error code must be a non-negative Int32.");
        }
        fields.errorCode = code;
        state = code === 0 ? "ok" : "failed";
      }
    }
    if (event.isInteractive !== undefined && event.isInteractive !== null) {
      if (typeof event.isInteractive !== "boolean") throw new TypeError("Entra interactive status must be boolean.");
      fields.interactive = event.isInteractive;
    }
    if (event.conditionalAccessStatus !== undefined && event.conditionalAccessStatus !== null) {
      text(event.conditionalAccessStatus, "Entra conditional access status", 128);
      fields.conditionalAccessStatus = ["success", "failure", "notApplied", "unknownFutureValue"].includes(event.conditionalAccessStatus)
        ? event.conditionalAccessStatus : "unknownFutureValue";
    }
    const appId = optionalId(event.appId, "Entra application ID");
    if (appId) fields.providerApplicationRef = hash("entra-application", appId);
    const payload = { title: "Microsoft Entra sign-in", state, category: "entra.signin", fields };
    payload.identityRef = identity("entra", userId, upstreamId, fields);
    return { upstreamId, observedAt, kind: "authentication.event", payload };
  });
}

// Closed authentication classification: a policy ALLOW is not a successful
// login, and lifecycle/provisioning/admin events are not authentication events.
const OKTA_AUTHENTICATION = new Set([
  "user.session.start", "user.authentication.sso", "user.authentication.auth_via_mfa",
  "user.authentication.auth_via_AD_agent", "user.authentication.auth_via_LDAP_agent",
  "user.authentication.auth_via_IDP", "user.authentication.auth_via_radius",
  "user.authentication.auth_via_inbound_SAML", "user.authentication.auth_via_inbound_delauth",
  "user.authentication.auth_via_iwa", "user.authentication.auth_via_richclient",
  "user.authentication.auth_via_social", "user.authentication.authenticate", "user.authentication.verify"
]);
const OKTA_AUDIT_TYPES = new Set([
  "user.session.end", "user.lifecycle.create", "user.lifecycle.activate", "user.lifecycle.deactivate",
  "user.lifecycle.suspend", "user.lifecycle.unsuspend", "user.lifecycle.delete.initiated",
  "user.account.update_profile", "user.account.update_password", "user.account.privilege.grant",
  "user.account.privilege.revoke", "application.lifecycle.activate", "application.lifecycle.create",
  "application.lifecycle.deactivate", "application.lifecycle.delete", "application.lifecycle.update",
  "application.user_membership.add", "application.user_membership.remove", "group.user_membership.add",
  "group.user_membership.remove", "policy.evaluate_sign_on", "system.api_token.create", "system.api_token.revoke"
]);
const OKTA_OUTCOMES = new Set(["SUCCESS", "FAILURE", "SKIPPED", "ALLOW", "DENY", "CHALLENGE", "UNKNOWN", "RATE_LIMIT", "UNANSWERED", "ABANDONED"]);

function normalizedOkta(input) {
  return normalizePage(page(input, null, [], ["uuid", "published", "eventType"]), event => {
    const upstreamId = text(event.uuid, "Okta event ID");
    const observedAt = eventTime(event.published, "Okta event timestamp");
    const eventType = text(event.eventType, "Okta event type", 256);
    const authentication = OKTA_AUTHENTICATION.has(eventType);
    const mapped = authentication || OKTA_AUDIT_TYPES.has(eventType);
    const fields = { provider: "okta", eventType: mapped ? eventType : "unmapped", outcomeScope: "provider-event-only" };
    if (!mapped) fields.eventTypeRef = hash("okta-event-type", eventType);
    let state = "unknown";
    if (event.outcome !== undefined && event.outcome !== null) {
      object(event.outcome, "Okta outcome");
      if (event.outcome.result !== undefined && event.outcome.result !== null) {
        const outcome = text(event.outcome.result, "Okta outcome result", 128);
        fields.outcome = OKTA_OUTCOMES.has(outcome) ? outcome : "UNKNOWN";
        state = outcome === "SUCCESS" ? "ok" : outcome === "FAILURE" ? "failed" : "unknown";
      }
    }
    const payload = { title: authentication ? "Okta authentication event" : "Okta audit event", state,
      category: authentication ? "okta.authentication" : "okta.audit", fields };
    let actorId = null;
    if (event.actor !== undefined && event.actor !== null) {
      object(event.actor, "Okta actor");
      actorId = optionalId(event.actor.id, "Okta actor ID");
    }
    if (authentication) payload.identityRef = identity("okta", actorId, upstreamId, fields);
    else if (actorId) fields.actorRef = hash("okta-actor", actorId);
    return { upstreamId, observedAt, kind: authentication ? "authentication.event" : "audit.event", payload };
  });
}

// Keep code-to-outcome mappings explicit. Prefix matching would incorrectly
// call a signup, logout, provisioning action, or unknown future code a login.
const AUTH0_AUTHENTICATION = Object.freeze({
  s: "ok", scoa: "ok", sens: "ok", ssa: "ok",
  f: "failed", fc: "failed", fco: "failed", fcoa: "failed", fens: "failed", fp: "failed", fu: "failed", fsa: "failed", w: "unknown"
});
const AUTH0_AUDIT = Object.freeze({
  sapi: "ok", mgmt_api_read: "ok", ss: "ok", fs: "failed", slo: "ok", flo: "failed",
  oidc_backchannel_logout_succeeded: "ok", oidc_backchannel_logout_failed: "failed",
  actions_execution_failed: "failed", api_limit: "unknown", cs: "unknown",
  gd_enrollment_complete: "ok", gd_start_enroll: "unknown", gd_unenroll: "unknown", gd_update_device_account: "unknown"
});

function normalizedAuth0(input) {
  return normalizePage(page(input, "logs", ["start", "limit", "length", "total"], ["log_id", "date", "type"]), event => {
    const upstreamId = text(event.log_id, "Auth0 log ID");
    const observedAt = eventTime(event.date, "Auth0 event timestamp");
    const eventType = text(event.type, "Auth0 event type", 256);
    const authentication = Object.hasOwn(AUTH0_AUTHENTICATION, eventType);
    const mapped = authentication || Object.hasOwn(AUTH0_AUDIT, eventType);
    const fields = { provider: "auth0", eventType: mapped ? eventType : "unmapped" };
    if (!mapped) fields.eventTypeRef = hash("auth0-event-type", eventType);
    const payload = { title: authentication ? "Auth0 authentication event" : "Auth0 audit event",
      state: authentication ? AUTH0_AUTHENTICATION[eventType] : Object.hasOwn(AUTH0_AUDIT, eventType) ? AUTH0_AUDIT[eventType] : "unknown",
      category: authentication ? "auth0.authentication" : "auth0.audit", fields };
    const userId = optionalId(event.user_id, "Auth0 user ID");
    if (authentication) payload.identityRef = identity("auth0", userId, upstreamId, fields);
    else if (userId) fields.actorRef = hash("auth0-actor", userId);
    const clientId = optionalId(event.client_id, "Auth0 client ID");
    if (clientId) fields.providerApplicationRef = hash("auth0-application", clientId);
    return { upstreamId, observedAt, kind: authentication ? "authentication.event" : "audit.event", payload };
  });
}

const adapters = [
  {
    id: "entra-signin", title: "Microsoft Entra sign-ins",
    description: "Microsoft Graph v1.0 sign-in JSON pages; outcome and hashed identity references only. No directory audit or risk verdict inference.",
    recordKinds: ["authentication.event"], formats: ["JSON array of Graph signIn records", "Graph collection object with value array", "One exported signIn record with id and createdDateTime"],
    docs: [
      { title: "List Microsoft Graph sign-ins", url: "https://learn.microsoft.com/en-us/graph/api/signin-list?view=graph-rest-1.0" },
      { title: "Microsoft Graph signIn schema", url: "https://learn.microsoft.com/en-us/graph/api/resources/signin?view=graph-rest-1.0" }
    ], normalize: normalizedEntra
  },
  {
    id: "okta-system-log", title: "Okta System Log",
    description: "System Log API JSON arrays; selected authentication types and general audit observations. Policy decisions are not login success.",
    recordKinds: ["authentication.event", "audit.event"], formats: ["JSON array from the System Log API", "One exported System Log event with uuid, published and eventType"],
    docs: [
      { title: "Okta System Log query and pagination", url: "https://developer.okta.com/docs/reference/system-log-query/" },
      { title: "Okta event types", url: "https://developer.okta.com/docs/reference/api/event-types/" },
      { title: "Okta OAuth scopes", url: "https://developer.okta.com/docs/api/oauth2/" }
    ], normalize: normalizedOkta
  },
  {
    id: "auth0-logs", title: "Auth0 tenant logs",
    description: "Management API tenant log pages; explicit login codes and general audit observations. Unknown codes have unknown state, not an inferred verdict.",
    recordKinds: ["authentication.event", "audit.event"], formats: ["JSON array of Management API logs", "include_totals object with logs array", "One exported tenant log with log_id, date and type"],
    docs: [
      { title: "Retrieve Auth0 logs and checkpoint pagination", url: "https://auth0.com/docs/deploy-monitor/logs/retrieve-log-events-using-mgmt-api" },
      { title: "Auth0 event categories and codes", url: "https://auth0.com/docs/customize/log-streams/event-filters" },
      { title: "Auth0 tenant log catalog", url: "https://auth0.com/docs/tenant-logs" }
    ], normalize: normalizedAuth0
  }
];

module.exports = { adapters };
