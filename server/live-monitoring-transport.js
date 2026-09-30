"use strict";

// Deliberately narrow outbound boundary: Sentry Cloud project error reads and
// one Slack incoming webhook. No caller-selected API origins, redirects,
// vendor response logging, credential discovery, or automatic retries here.
const { adapters } = require("../tools/vendors/devops");
const { retryAfterMs } = require("../tools/integration-client");

const ORIGINS = Object.freeze({ default: "https://sentry.io", us: "https://us.sentry.io", eu: "https://de.sentry.io" });
const MAX_SENTRY_BYTES = 2 * 1024 * 1024;
const MAX_SLACK_BYTES = 1024;
const TIMEOUT_MS = 10_000;
const MAX_PAGE_EVENTS = 100;
const sentryAdapter = adapters.find(adapter => adapter.id === "sentry-events");

class LiveTransportError extends Error {
  constructor(code, message, retryable = false, metadata = {}) {
    super(message); this.name = "LiveTransportError"; this.code = code; this.retryable = retryable;
    for (const key of ["status", "retryAfterMs"]) {
      if (Number.isSafeInteger(metadata[key]) && metadata[key] >= 0) this[key] = metadata[key];
    }
  }
}

function fail(code, message, retryable, metadata) { throw new LiveTransportError(code, message, retryable, metadata); }
function plain(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  return Reflect.ownKeys(value).every(key => typeof key === "string" && keys.includes(key)
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"));
}

function validateSentryConfig(value) {
  if (!plain(value, ["region", "organization", "project"])) fail("invalid-config", "Choose a supported Sentry Cloud region and organization/project slugs.");
  const region = value.region === undefined ? "default" : value.region;
  if (typeof region !== "string" || !Object.hasOwn(ORIGINS, region)
      || ![value.organization, value.project].every(slug => typeof slug === "string" && /^[a-z0-9](?:[a-z0-9_-]{0,198}[a-z0-9])?$/.test(slug))) {
    fail("invalid-config", "Choose a supported Sentry Cloud region and organization/project slugs.");
  }
  return Object.freeze({ region, organization: value.organization, project: value.project });
}

function validateToken(token) {
  if (typeof token !== "string" || !/^[A-Za-z0-9._~+/=-]{16,2048}$/.test(token)) {
    fail("invalid-token", "Provide a Sentry API bearer token with read access to the selected project.");
  }
  return token;
}

function validateSlackWebhook(webhook) {
  // Match the whole original string as well as the parsed destination: URL
  // normalization must not turn credentials, dot segments or escapes into an
  // accepted destination. GovSlack and Workflow Builder are not this protocol.
  if (typeof webhook !== "string" || webhook.length > 512
      || !/^https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]{2,63}\/B[A-Z0-9]{2,63}\/[A-Za-z0-9_-]{10,256}$/.test(webhook)) {
    fail("invalid-webhook", "Provide a standard Slack incoming webhook on hooks.slack.com; other destinations are not supported.");
  }
  return webhook;
}

function timestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
      || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail("invalid-window", "Collection windows must use valid UTC ISO timestamps with millisecond precision.");
  }
  return value;
}

function cursorValue(value) {
  if (typeof value !== "string" || !/^\d{1,20}:\d{1,12}:[01]$/.test(value)) {
    fail("invalid-pagination", "Sentry returned an unsupported pagination cursor; the collection window is not complete.");
  }
  return value;
}

function nextCursor(header, requestUrl, currentCursor) {
  if (typeof header !== "string" || !header || header.length > 8192 || /[\u0000-\u001f\u007f]/.test(header)) {
    fail("invalid-pagination", "Sentry pagination metadata is missing or invalid; the collection window is not complete.");
  }
  const pieces = header.split(/,\s*(?=<)/);
  if (pieces.length > 2) fail("invalid-pagination", "Sentry pagination metadata is ambiguous; the collection window is not complete.");
  const links = new Map();
  for (const piece of pieces) {
    const match = /^\s*<([^<>\s\\]+)>((?:\s*;\s*[a-z]+="[^"\r\n]*")+)\s*$/.exec(piece);
    if (!match) fail("invalid-pagination", "Sentry pagination metadata is malformed; the collection window is not complete.");
    const attributes = Object.create(null);
    for (const attribute of match[2].matchAll(/;\s*([a-z]+)="([^"]*)"/g)) {
      if (!["rel", "results", "cursor"].includes(attribute[1]) || Object.hasOwn(attributes, attribute[1])) {
        fail("invalid-pagination", "Sentry pagination metadata is ambiguous; the collection window is not complete.");
      }
      attributes[attribute[1]] = attribute[2];
    }
    if (!["previous", "next"].includes(attributes.rel) || !["true", "false"].includes(attributes.results) || links.has(attributes.rel)) {
      fail("invalid-pagination", "Sentry pagination metadata is incomplete; the collection window is not complete.");
    }
    let url;
    try { url = new URL(match[1]); } catch { fail("invalid-pagination", "Sentry pagination destination is invalid."); }
    if (url.origin !== requestUrl.origin || url.pathname !== requestUrl.pathname || url.username || url.password || url.hash
        || !match[1].startsWith(requestUrl.origin + requestUrl.pathname + "?")) {
      fail("invalid-pagination", "Sentry pagination changed the selected destination; no supplied URL was followed.");
    }
    for (const key of new Set(url.searchParams.keys())) {
      if (!["start", "end", "full", "sample", "per_page", "cursor"].includes(key) || url.searchParams.getAll(key).length !== 1
          || (key !== "cursor" && url.searchParams.get(key) !== requestUrl.searchParams.get(key))) {
        fail("invalid-pagination", "Sentry pagination changed the collection window or query; no supplied URL was followed.");
      }
    }
    const value = cursorValue(url.searchParams.get("cursor"));
    if (attributes.cursor !== undefined && attributes.cursor !== value) fail("invalid-pagination", "Sentry pagination cursors disagree.");
    if (value.endsWith(attributes.rel === "next" ? ":1" : ":0")) fail("invalid-pagination", "Sentry pagination cursor direction is invalid.");
    links.set(attributes.rel, { value, hasResults: attributes.results === "true" });
  }
  const next = links.get("next");
  if (!next || (next.hasResults && next.value === currentCursor)) fail("invalid-pagination", "Sentry pagination did not advance; the collection window is not complete.");
  return next.hasResults ? next.value : null;
}

async function discard(response) {
  try { await response.body?.cancel(); } catch { /* Never retain vendor error bodies. */ }
}

async function boundedText(response, maximum, signal) {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    await discard(response); fail("response-too-large", "The remote response exceeds the supported size limit.");
  }
  const reader = response.body?.getReader();
  if (!reader) fail("invalid-response", "The remote service returned an empty response body.");
  const chunks = []; let length = 0;
  const abort = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) throw new Error();
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw new Error();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) {
        try { await reader.cancel(); } catch { /* Refuse oversized data even if cancellation fails. */ }
        fail("response-too-large", "The remote response exceeds the supported size limit.");
      }
      chunks.push(value);
    }
    try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
    catch { fail("invalid-response", "The remote service returned invalid UTF-8."); }
  } finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
}

async function boundedRequest(fetchImpl, callerSignal, perform) {
  if (typeof fetchImpl !== "function" || (callerSignal !== undefined && !(callerSignal instanceof AbortSignal))) {
    fail("invalid-options", "The transport requires a fetch function and an optional AbortSignal.");
  }
  const controller = new AbortController();
  let rejectAbort;
  const aborted = new Promise((resolve, reject) => { rejectAbort = reject; });
  const stop = () => {
    controller.abort();
    rejectAbort(new LiveTransportError("request-interrupted", "The remote request was interrupted or exceeded its 10-second limit.", true));
  };
  const timer = setTimeout(stop, TIMEOUT_MS);
  callerSignal?.addEventListener("abort", stop, { once: true });
  try {
    if (callerSignal?.aborted) { stop(); return await aborted; }
    return await Promise.race([perform(controller.signal), aborted]);
  } catch (error) {
    if (error instanceof LiveTransportError) throw error;
    fail("network-unavailable", "The remote request could not complete. No remote response or credential was retained in this error.", true);
  } finally { clearTimeout(timer); callerSignal?.removeEventListener("abort", stop); }
}

async function requireSuccess(response) {
  if (response.status === 200 && !response.redirected) return;
  const wait = retryAfterMs(response.headers.get("retry-after"));
  await discard(response);
  fail("remote-rejected", "The remote service rejected the request. Check credentials, permissions, destination and service availability.",
    [408, 429, 500, 502, 503, 504].includes(response.status), { status: response.status, ...(wait === null ? {} : { retryAfterMs: wait }) });
}

async function fetchSentryPage({ config, token, start, end, cursor = null, fetchImpl = fetch, signal } = {}) {
  const validated = validateSentryConfig(config);
  validateToken(token); timestamp(start); timestamp(end);
  if (Date.parse(start) >= Date.parse(end)) fail("invalid-window", "The collection window start must be before its end.");
  if (cursor !== null && cursorValue(cursor).endsWith(":1")) fail("invalid-pagination", "Only forward collection cursors are accepted.");
  const url = new URL(ORIGINS[validated.region] + "/api/0/projects/" + validated.organization + "/" + validated.project + "/events/");
  for (const [key, value] of Object.entries({ start, end, full: "false", sample: "false", per_page: "100" })) url.searchParams.set(key, value);
  if (cursor !== null) url.searchParams.set("cursor", cursor);
  return boundedRequest(fetchImpl, signal, async requestSignal => {
    const response = await fetchImpl(url.href, { method: "GET", redirect: "error", signal: requestSignal,
      headers: { Accept: "application/json", Authorization: "Bearer " + token } });
    await requireSuccess(response);
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get("content-type") || "")) {
      await discard(response); fail("invalid-response", "Sentry returned an unsupported response format.");
    }
    let next;
    try { next = nextCursor(response.headers.get("link"), url, cursor); }
    catch (error) { await discard(response); throw error; }
    const text = await boundedText(response, MAX_SENTRY_BYTES, requestSignal);
    let events;
    try { events = JSON.parse(text); } catch { fail("invalid-response", "Sentry returned invalid JSON."); }
    if (!Array.isArray(events) || events.length > MAX_PAGE_EVENTS || (!events.length && next !== null)) {
      fail("invalid-response", "Sentry returned an unsupported or inconsistent event page.");
    }
    try {
      const normalized = sentryAdapter.normalize(events);
      if (normalized.some(event => Date.parse(event.observedAt) < Date.parse(start) || Date.parse(event.observedAt) > Date.parse(end))) throw new Error();
    } catch { fail("invalid-response", "Sentry events do not match the supported format and requested collection window."); }
    return { events, nextCursor: next };
  });
}

async function sendSlack({ webhook, text, fetchImpl = fetch, signal } = {}) {
  validateSlackWebhook(webhook);
  if (typeof text !== "string" || !text.trim() || text.length > 2000 || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) {
    fail("invalid-notification", "Notification text must be nonempty plain text of at most 2,000 characters.");
  }
  // Block Kit plain_text prevents arbitrary <@user>, <!channel>, URLs and
  // markdown from acquiring notification/formatting semantics. The escaped
  // fallback is also non-parsing for accessibility/notification previews.
  const fallback = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = JSON.stringify({ text: fallback, mrkdwn: false, link_names: false, parse: "none", unfurl_links: false, unfurl_media: false,
    blocks: [{ type: "section", text: { type: "plain_text", text, emoji: false } }] });
  return boundedRequest(fetchImpl, signal, async requestSignal => {
    const response = await fetchImpl(webhook, { method: "POST", redirect: "error", signal: requestSignal,
      headers: { "Content-Type": "application/json", Accept: "text/plain" }, body });
    await requireSuccess(response);
    const acknowledgement = await boundedText(response, MAX_SLACK_BYTES, requestSignal);
    if (acknowledgement.trim() !== "ok") fail("invalid-acknowledgement", "Slack did not return its expected acknowledgement; delivery is unconfirmed.");
  });
}

module.exports = { validateSentryConfig, validateToken, validateSlackWebhook, fetchSentryPage, sendSlack, LiveTransportError,
  MAX_SENTRY_BYTES, MAX_SLACK_BYTES, MAX_PAGE_EVENTS, TIMEOUT_MS };
