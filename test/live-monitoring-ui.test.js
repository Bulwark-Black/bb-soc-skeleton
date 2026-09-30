"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class Element {
  constructor(tag, text = "") { this.tagName = tag.toUpperCase(); this.nodeType = tag === "#text" ? 3 : 1; this.childNodes = []; this.parentNode = null; this.dataset = {}; this.style = {}; this.attributes = {}; this.listeners = new Map(); this._value = ""; this._text = text; this.disabled = false; this.checked = false; }
  append(...children) { for (const child of children) { if (child.parentNode) child.parentNode.childNodes = child.parentNode.childNodes.filter(item => item !== child); child.parentNode = this; this.childNodes.push(child); } }
  replaceChildren(...children) { this.childNodes.forEach(child => { child.parentNode = null; }); this.childNodes = []; this._text = ""; if (this.tagName === "SELECT") this._value = ""; this.append(...children); }
  get value() { if (this.tagName !== "SELECT") return this._value; const options = this.childNodes.filter(child => child.tagName === "OPTION"); return options.some(child => child.value === this._value) ? this._value : options[0]?.value || ""; }
  set value(value) { this._value = String(value); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(type, listener) { const list = this.listeners.get(type) || []; list.push(listener); this.listeners.set(type, list); }
  dispatchEvent(event) { if (!event.target) event.target = this; event.preventDefault ||= () => { event.defaultPrevented = true; }; for (const listener of this.listeners.get(event.type) || []) listener(event); if (event.bubbles && this.parentNode) this.parentNode.dispatchEvent(event); }
  click() { if (!this.disabled) this.dispatchEvent({ type: "click", bubbles: true }); }
  matches(selector) { return selector.split(",").some(value => { const part = value.trim(), name = /^\[name="([^"]+)"\]$/.exec(part); return name ? this.name === name[1] : this.tagName === part.toUpperCase(); }); }
  querySelectorAll(selector) { const results = []; for (const child of this.childNodes) { if (child.matches(selector)) results.push(child); results.push(...child.querySelectorAll(selector)); } return results; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  get textContent() { return this._text + this.childNodes.map(child => child.textContent).join(""); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
}
const API = "/api/v1/monitoring", AT = "2026-09-29T12:00:00.000Z", SENTRY_ORIGIN = "https://sentry.io";
const connection = (extra = {}) => ({ id: "connection-1", sourceId: "source-1", appId: "app-1", displayName: "Synthetic application", environment: "production", region: "default", organization: "example-org", project: "example-project", enabled: true, revision: 4, health: "healthy", lastAttemptAt: AT, lastSuccessAt: AT, lastEventAt: null, nextPollAt: "2026-09-29T12:01:00.000Z", coverageStartAt: "2026-09-29T11:45:00.000Z", completedThrough: AT, totalEvents: 0, hasSlack: false, ...extra });
const alert = (extra = {}) => ({ id: "alert-1", connectionId: "connection-1", sourceId: "source-1", appId: "app-1", title: "New application error", body: "Inspect the linked event and recent application deployment.", kind: "application-error", createdAt: AT, acknowledgedAt: null, deliveryState: "in-app", evidence: { recordId: "record-1", vendorEventId: "test-event-id", observedAt: AT, url: new URL("/organizations/example-org/issues/123/", SENTRY_ORIGIN).href }, ...extra });
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise(setImmediate); };
function harness(t, options = {}) {
  const container = new Element("main"), requests = [], errors = [], confirmations = [], timers = new Map(); let nextTimer = 0;
  const snapshot = options.snapshot || { schemaVersion: "1", connections: [connection()], alerts: [] };
  const defaultFetch = (url, init) => {
    if (url === API) return response(snapshot);
    if (url.startsWith("/api/v1/control/snapshot")) return response({ apps: [{ appId: "app-1", displayName: "My application", environments: ["production", "staging"] }, { appId: "app-2", displayName: "Another application", environments: ["test"] }] });
    if (url === API + "/connections") return response({ connection: connection() });
    if (init.method === "POST") return response({});
    throw new Error("Unexpected synthetic request.");
  };
  const context = vm.createContext({ AbortController, TextDecoder, URL,
    setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id),
    SOC_PRIVATE_APPLICATION: options.private !== false,
    confirm: message => { confirmations.push(message); return options.confirm !== false; },
    document: { createElement: tag => new Element(tag), createTextNode: text => new Element("#text", String(text)) },
    fetch: async (url, init) => { requests.push({ url, init, body: init.body === undefined ? undefined : JSON.parse(init.body) }); return options.fetch ? options.fetch(url, init, defaultFetch) : defaultFetch(url, init); }
  }); context.window = context;
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "public/live-monitoring.js"), "utf8"), context, { filename: "live-monitoring.js" });
  const cleanup = context.SocLiveMonitoring.render({ container, query: options.query, onError: error => errors.push(error) }); t.after(cleanup);
  return { container, requests, errors, confirmations, timers, cleanup, snapshot,
    field: name => container.querySelector('[name="' + name + '"]'),
    button: label => container.querySelectorAll("button").find(item => item.textContent === label),
    link: label => container.querySelectorAll("a").find(item => item.textContent === label),
    tick: async () => { const entry = timers.entries().next().value; if (entry) { timers.delete(entry[0]); await entry[1](); } await settle(); }
  };
}
function change(node, value) { assert.ok(node); assert.equal(node.disabled, false); if (node.type === "checkbox") node.checked = value; else node.value = value; node.dispatchEvent({ type: "change", bubbles: true }); }
function fillSetup(h, includeSlack = false) {
  change(h.field("monitoringApp"), "app-1"); change(h.field("monitoringEnvironment"), "staging"); change(h.field("monitoringOrganization"), "my-org"); change(h.field("monitoringProject"), "my-project"); change(h.field("monitoringToken"), "synthetic-read-only-token");
  if (includeSlack) change(h.field("monitoringSlack"), "synthetic-private-webhook-value");
}

test("live monitoring static view does no network, schedules no refresh, and asks for private sign-in", async t => {
  const h = harness(t, { private: false }); await settle();
  assert.equal(h.requests.length, 0); assert.equal(h.timers.size, 0); assert.equal(h.cleanup.isDirty(), false);
  assert.match(h.container.textContent, /static skeleton performs no collection/); assert.equal(h.field("monitoringToken"), null);
});

test("live setup uses registered application environments and submits only explicit private session credentials", async t => {
  const h = harness(t); await settle();
  assert.equal(h.button("Test access and start monitoring").disabled, true);
  change(h.field("monitoringApp"), "app-2"); assert.deepEqual(h.field("monitoringEnvironment").childNodes.map(item => item.value), ["test"]);
  fillSetup(h, true); assert.equal(h.field("monitoringToken").type, "password"); assert.equal(h.field("monitoringSlack").type, "password");
  assert.equal(h.cleanup.isDirty(), true); h.button("Test access and start monitoring").click(); await settle();
  const sent = h.requests.find(item => item.url === API + "/connections");
  assert.deepEqual(sent.body, { appId: "app-1", environment: "staging", displayName: "Sentry application errors", region: "default", organization: "my-org", project: "my-project", token: ["synthetic", "read", "only", "token"].join("-"), slackWebhook: "synthetic-private-webhook-value" });
  assert.equal(sent.init.credentials, "same-origin"); assert.equal(sent.init.redirect, "error"); assert.equal(sent.init.headers.Authorization, undefined);
  assert.equal(h.field("monitoringToken").value, ""); assert.equal(h.field("monitoringSlack").value, ""); assert.equal(h.cleanup.isDirty(), false);
  assert.doesNotMatch(h.container.textContent, /synthetic-read-only-token|synthetic-private-webhook-value/);
  assert.match(h.container.textContent, /Verify the first completed poll/); assert.equal(h.errors.length, 0);
  assert.match(h.container.textContent, /does not filter Sentry events/); assert.equal(h.field("monitoringDisplayName").maxLength, 100);
});

test("incomplete setup fails locally before a mutation and omitted Slack stays omitted", async t => {
  const h = harness(t); await settle(); change(h.field("monitoringApp"), "app-1");
  h.button("Test access and start monitoring").click(); await settle(); assert.equal(h.requests.filter(item => item.init.method === "POST").length, 0);
  fillSetup(h); h.button("Test access and start monitoring").click(); await settle();
  assert.equal(Object.hasOwn(h.requests.find(item => item.url === API + "/connections").body, "slackWebhook"), false);
});

test("saved setup links preselect only a registered application/environment without overriding later choices", async t => {
  const h = harness(t, { query: new URLSearchParams({ appId: "app-1", environment: "staging" }) }); await settle();
  assert.equal(h.field("monitoringApp").value, "app-1"); assert.equal(h.field("monitoringEnvironment").value, "staging");
  assert.equal(h.cleanup.isDirty(), false);
  change(h.field("monitoringApp"), "app-2"); h.button("Refresh monitoring status").click(); await settle();
  assert.equal(h.field("monitoringApp").value, "app-2"); assert.equal(h.field("monitoringEnvironment").value, "test");
  const unknown = harness(t, { query: new URLSearchParams({ appId: "unregistered", environment: "staging" }) }); await settle();
  assert.equal(unknown.field("monitoringApp").value, "");
  const wrong = harness(t, { query: new URLSearchParams({ appId: "app-2", environment: "staging" }) }); await settle();
  assert.equal(wrong.field("monitoringEnvironment").value, "test");
});

test("health separates completed collection from activity and shows incomplete windows and notification state", async t => {
  const h = harness(t, { snapshot: { connections: [connection({ health: "degraded", pendingWindow: { start: AT }, hasSlack: true, notificationStatus: "failed", lastError: "Provider access denied" }), connection({ id: "connection-2", health: "healthy" })], alerts: [] } }); await settle();
  assert.match(h.container.textContent, /Degraded — collection needs attention/); assert.match(h.container.textContent, /Healthy — collection is succeeding/);
  assert.match(h.container.textContent, /Last successful completed poll: 2026-09-29T12:00:00.000Z/); assert.match(h.container.textContent, /Last event activity: Not yet available · Events accepted: 0/);
  assert.match(h.container.textContent, /collection window is incomplete/); assert.match(h.container.textContent, /delivery status: failed/); assert.match(h.container.textContent, /Provider access denied/);
  assert.match(h.container.textContent, /Verify collection health above before interpreting silence/);
});

test("connection lifecycle and explicit notification tests use expected revision and removal confirmation", async t => {
  const h = harness(t, { snapshot: { connections: [connection({ hasSlack: true })], alerts: [] } }); await settle();
  for (const [label, suffix] of [["Poll now", "poll"], ["Pause collection", "pause"], ["Send Slack test", "test-notification"], ["Retry blocked Slack notifications", "retry-notifications"], ["Remove connection", "remove"]]) {
    h.button(label).click(); await settle(); const sent = h.requests.find(item => item.url.endsWith("/" + suffix)); assert.deepEqual(sent.body, { expectedRevision: 4 });
  }
  assert.equal(h.confirmations.length, 1); assert.match(h.confirmations[0], /telemetry and alerts are not deleted/);
  const paused = harness(t, { snapshot: { connections: [connection({ enabled: false, health: "paused" })], alerts: [] } }); await settle();
  assert.equal(paused.button("Poll now").disabled, true); assert.equal(paused.button("Send Slack test").disabled, true);
  paused.button("Resume collection").click(); await settle(); assert.deepEqual(paused.requests.find(item => item.url.endsWith("/resume")).body, { expectedRevision: 4 });
});

test("credential edits preserve omitted fields, clear secrets on success, and explicitly remove Slack", async t => {
  const h = harness(t); await settle();
  change(h.field("replacementToken-connection-1"), "synthetic-replacement"); assert.equal(h.button("Poll now").disabled, true); assert.equal(h.field("monitoringToken").disabled, true);
  h.button("Save credential changes").click(); await settle();
  const first = h.requests.find(item => item.url.endsWith("/credentials")); assert.deepEqual(first.body, { expectedRevision: 4, token: ["synthetic", "replacement"].join("-") });
  assert.equal(h.field("replacementToken-connection-1").value, ""); assert.equal(h.cleanup.isDirty(), false);
  change(h.field("removeSlack-connection-1"), true); h.button("Save credential changes").click(); await settle();
  assert.deepEqual(h.requests.filter(item => item.url.endsWith("/credentials"))[1].body, { expectedRevision: 4, slackWebhook: "" });
  change(h.field("replacementSlack-connection-1"), "synthetic-replacement-webhook"); h.button("Save credential changes").click(); await settle();
  assert.deepEqual(h.requests.filter(item => item.url.endsWith("/credentials"))[2].body, { expectedRevision: 4, slackWebhook: "synthetic-replacement-webhook" });
});

test("dirty setup prevents background refresh and other form edits; refused refresh preserves secrets", async t => {
  const h = harness(t, { confirm: false }); await settle(); fillSetup(h); const before = h.requests.length;
  assert.equal(h.field("replacementToken-connection-1").disabled, true); assert.equal(h.button("Pause collection").disabled, true);
  await h.tick(); assert.equal(h.requests.length, before);
  h.button("Refresh monitoring status").click(); await settle(); assert.equal(h.requests.length, before); assert.equal(h.field("monitoringToken").value, "synthetic-read-only-token");
  assert.equal(h.confirmations.length, 1); assert.equal(h.cleanup.isDirty(), true);
});

test("approved manual refresh discards secrets and clean automatic refresh only reads monitoring status", async t => {
  const h = harness(t); await settle(); fillSetup(h); h.button("Refresh monitoring status").click(); await settle();
  assert.equal(h.field("monitoringToken").value, ""); assert.equal(h.cleanup.isDirty(), false);
  const before = h.requests.length; await h.tick(); assert.equal(h.requests.length, before + 1); assert.equal(h.requests.at(-1).url, API); assert.equal(h.requests.at(-1).init.method, "GET");
});

test("alert acknowledgment is local and Sentry evidence links are fixed HTTPS destinations", async t => {
  const userInfo = new URL(SENTRY_ORIGIN); userInfo.username = "test-user";
  const cleartext = new URL(SENTRY_ORIGIN); cleartext.protocol = "http:";
  const alternatePort = new URL(SENTRY_ORIGIN); alternatePort.port = "8443";
  const badUrls = ["javascript:alert(1)", "https://sentry.io.example.invalid/", "https://other.example.invalid/", userInfo.href, cleartext.href, alternatePort.href];
  const h = harness(t, { snapshot: { connections: [connection()], alerts: [alert(), ...badUrls.map((url, index) => alert({ id: "bad-" + index, evidence: { url } }))] } }); await settle();
  const links = h.container.querySelectorAll("a").filter(item => item.textContent === "Open evidence in Sentry"); assert.equal(links.length, 1); assert.equal(links[0].rel, "noopener noreferrer"); assert.equal(links[0].target, "_blank");
  h.button("Acknowledge alert").click(); await settle(); assert.deepEqual(h.requests.find(item => item.url.endsWith("/alerts/alert-1/ack")).body, {});
  assert.match(h.container.textContent, /No upstream issue or application state was changed/); assert.match(h.container.textContent, /record-1/);
  assert.match(h.container.textContent, /Sentry event ID: test-event-id/);
});

test("failed credential requests never echo vendor response secrets and preserve retry draft", async t => {
  const h = harness(t, { fetch: (url, init, fallback) => url === API + "/connections" ? response({ message: "synthetic-secret-leaked-by-remote", token: ["synthetic", "read", "only", "token"].join("-") }, 502) : fallback(url, init) });
  await settle(); fillSetup(h); h.button("Test access and start monitoring").click(); await settle();
  assert.match(h.container.textContent, /provider could not confirm access/); assert.doesNotMatch(h.container.textContent, /synthetic-secret-leaked-by-remote|synthetic-read-only-token/);
  assert.equal(h.field("monitoringToken").value, "synthetic-read-only-token"); assert.equal(h.cleanup.isDirty(), true); assert.equal(h.errors.length, 1);
});

test("unmount erases all secret input values and cancels refresh without deleting remote connections", async t => {
  const h = harness(t); await settle(); const setupToken = h.field("monitoringToken"), editToken = h.field("replacementToken-connection-1"), editSlack = h.field("replacementSlack-connection-1");
  setupToken.value = "synthetic-setup"; editToken.value = "synthetic-edit"; editSlack.value = "synthetic-webhook";
  const before = h.requests.length; h.cleanup(); await h.tick();
  assert.equal(setupToken.value, ""); assert.equal(editToken.value, ""); assert.equal(editSlack.value, ""); assert.equal(h.timers.size, 0); assert.equal(h.requests.length, before);
  assert.equal(h.requests.filter(item => item.init.method === "POST").length, 0);
});

test("unmount aborts pending requests and suppresses late errors and DOM updates", async t => {
  const signals = [];
  const h = harness(t, { fetch: (_url, init) => new Promise((_resolve, reject) => { signals.push(init.signal); init.signal.addEventListener("abort", () => reject(Object.assign(new Error("Stopped"), { name: "AbortError" })), { once: true }); }) });
  const before = h.container.textContent; h.cleanup(); await settle();
  assert.equal(signals.length, 2); assert.ok(signals.every(signal => signal.aborted)); assert.equal(h.container.textContent, before); assert.equal(h.errors.length, 0); assert.equal(h.timers.size, 0);
});

test("monitoring responses are bounded before parsing", async t => {
  const h = harness(t, { fetch: (url, init, fallback) => url === API ? new Response("x".repeat(4 * 1024 * 1024 + 1)) : fallback(url, init) }); await settle();
  assert.match(h.container.textContent, /response exceeds its limit/); assert.equal(h.errors.length, 1);
});

test("alert pagination shows retained totals, preserves clean refresh page, and refuses to discard a draft", async t => {
  const h = harness(t, { fetch: (url, init, fallback) => {
    if (url.startsWith(API) && init.method === "GET") { const offset = Number(new URL(url, "https://console.example.invalid").searchParams.get("offset")); return response({ connections: [connection()], alerts: [alert()], totalAlerts: 101, offset, nextOffset: offset ? null : 100 }); }
    return fallback(url, init);
  } }); await settle();
  assert.match(h.container.textContent, /Showing 1 of 101 retained alerts, starting at 1/); assert.equal(h.button("Newer alerts").disabled, true);
  h.button("Older alerts").click(); await settle();
  assert.equal(h.requests.at(-1).url, API + "?offset=100&limit=100"); assert.equal(h.button("Older alerts").disabled, true);
  assert.match(h.container.textContent, /starting at 101/); await h.tick(); assert.equal(h.requests.at(-1).url, API + "?offset=100&limit=100");
  change(h.field("replacementToken-connection-1"), "test-only"); assert.equal(h.button("Newer alerts").disabled, true);
  h.button("Discard credential edits").click(); h.button("Newer alerts").click(); await settle(); assert.equal(h.requests.at(-1).url, API);
});
