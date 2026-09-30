"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class Element {
  constructor(tag, text = "") { this.tagName = tag.toUpperCase(); this.nodeType = tag === "#text" ? 3 : 1; this.childNodes = []; this.parentNode = null; this.dataset = {}; this.style = {}; this.attributes = {}; this.listeners = new Map(); this._value = ""; this._text = text; this.disabled = false; }
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
const API = "/api/v1/setup", AT = "2026-09-29T12:00:00.000Z", ID = "setup-11111111-1111-4111-8111-111111111111";
const plan = (extra = {}) => ({ id: ID, appId: "app-1", environment: "production", path: "live", sourceId: null, createdAt: AT, updatedAt: AT, ...extra });
const choice = (extra = {}) => ({ appId: "app-1", environment: "production", path: "live", sourceId: "source-live", displayName: "Sentry errors", state: "active", ...extra });
const diagnostic = (extra = {}) => ({ schemaVersion: "1", checkedAt: AT, appId: "app-1", environment: "production", path: "live", sourceId: null,
  summary: "No source is bound. Collection and retained events have not been proved.", checks: [
    { id: "binding", title: "Source binding", state: "waiting", detail: "Connect and select a compatible source.", href: "#/sources?stab=live" },
    { id: "notification-human", title: "Human receipt", state: "not-applicable", detail: "A provider response does not prove human receipt." }
  ], destinations: [], ...extra });
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise(setImmediate); };
function harness(t, options = {}) {
  const container = new Element("main"), requests = [], errors = [], confirmations = [], selections = [], timers = new Map(); let nextTimer = 0;
  const setup = { schemaVersion: "1", revision: 2, plans: options.plans || [], choices: options.choices || [choice(), choice({ sourceId: "source-vendor", displayName: "Imported audit events", path: "vendor", state: "configured" }), choice({ sourceId: "source-other-app", appId: "app-2" }), choice({ sourceId: "source-other-env", environment: "staging" })] };
  const snapshot = { apps: [{ appId: "app-1", displayName: "My application", environments: ["production", "staging"] }, { appId: "app-2", displayName: "Another application", environments: ["test"] }] };
  const fallback = (url, init) => {
    if (url === API) return response(setup);
    if (url.startsWith("/api/v1/control/snapshot")) return response(snapshot);
    if (url.startsWith(API + "/check?")) return response(options.diagnostic || diagnostic());
    const body = init.body && JSON.parse(init.body);
    if (url === "/api/v1/control/commands") { snapshot.apps.push({ appId: "registered-app", displayName: body.input.displayName, environments: body.input.environments }); return response({ status: "succeeded", output: { appId: "registered-app" } }); }
    if (url === API + "/plans" && init.method === "POST") { const saved = plan(body); delete saved.expectedRevision; setup.plans.push(saved); setup.revision += 1; return response({ schemaVersion: "1", revision: setup.revision, plan: saved }); }
    if (url === API + "/plans/" + ID && init.method === "PATCH") { const saved = setup.plans.find(item => item.id === ID); Object.assign(saved, { path: body.path, sourceId: body.sourceId }); setup.revision += 1; return response({ revision: setup.revision, plan: saved }); }
    if (url === API + "/plans/" + ID && init.method === "DELETE") { setup.plans = setup.plans.filter(item => item.id !== ID); setup.revision += 1; return response({ revision: setup.revision, removed: true }); }
    throw new Error("Unexpected synthetic request.");
  };
  const context = vm.createContext({ AbortController, TextDecoder, URL,
    setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id),
    SOC_PRIVATE_APPLICATION: options.private !== false,
    confirm: message => { confirmations.push(message); return options.confirm !== false; },
    document: { createElement: tag => new Element(tag), createTextNode: text => new Element("#text", String(text)) },
    fetch: async (url, init) => { requests.push({ url, init, body: init.body === undefined ? undefined : JSON.parse(init.body) }); return options.fetch ? options.fetch(url, init, fallback) : fallback(url, init); }
  }); context.window = context;
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "public/setup-guides.js"), "utf8"), context, { filename: "setup-guides.js" });
  const cleanup = context.SocSetupGuides.render({ container, query: options.query, onError: error => errors.push(error), onSelection: value => selections.push(value) }); t.after(cleanup);
  return { container, requests, errors, confirmations, selections, timers, cleanup, setup, snapshot,
    field: name => container.querySelector('[name="' + name + '"]'),
    button: label => container.querySelectorAll("button").find(item => item.textContent === label),
    link: label => container.querySelectorAll("a").find(item => item.textContent === label)
  };
}
function change(node, value) { assert.ok(node); assert.equal(node.disabled, false); node.value = value; node.dispatchEvent({ type: "change", bubbles: true }); }
function chooseApp(h) { change(h.field("setupApp"), "app-1"); }
const resumeLabel = "Resume My application / production / Live Sentry connection";

test("static setup guide performs no network or timers and contains no private form", async t => {
  const h = harness(t, { private: false }); await settle();
  assert.equal(h.requests.length, 0); assert.equal(h.timers.size, 0); assert.equal(h.cleanup.isDirty(), false); assert.equal(h.field("setupApp"), null);
  assert.match(h.container.textContent, /static skeleton makes no requests/);
});

test("application selection constrains environments and server-compatible source choices", async t => {
  const h = harness(t); await settle(); assert.equal(h.button("Save setup guide").disabled, true);
  chooseApp(h); assert.deepEqual(h.field("setupEnvironment").childNodes.map(item => item.value), ["production", "staging"]);
  assert.deepEqual(h.field("setupSource").childNodes.map(item => item.value), ["", "source-live"]);
  change(h.field("setupSource"), "source-live"); change(h.field("setupPath"), "vendor");
  assert.equal(h.field("setupSource").value, ""); assert.deepEqual(h.field("setupSource").childNodes.map(item => item.value), ["", "source-vendor"]);
  change(h.field("setupSource"), "source-vendor"); change(h.field("setupEnvironment"), "staging"); assert.equal(h.field("setupSource").value, "");
  change(h.field("setupApp"), "app-2"); assert.deepEqual(h.field("setupEnvironment").childNodes.map(item => item.value), ["test"]);
  assert.match(h.container.textContent, /Imports are one-time deliveries/); assert.equal(h.cleanup.isDirty(), true);
});

test("older applications without an environments field use the contract default", async t => {
  const h = harness(t, { fetch: (url, init, fallback) => url.startsWith("/api/v1/control/snapshot") ? response({ apps: [{ appId: "app-1", displayName: "Older app" }] }) : fallback(url, init) }); await settle();
  chooseApp(h); assert.deepEqual(h.field("setupEnvironment").childNodes.map(item => item.value), ["default"]);
  assert.equal(h.button("Save setup guide").disabled, false);
});

test("guide creation persists only selected references with current revision and session transport", async t => {
  const h = harness(t); await settle(); chooseApp(h); change(h.field("setupSource"), "source-live");
  assert.equal(h.link("Connect live Sentry monitoring"), undefined); h.button("Save setup guide").click(); await settle();
  const saved = h.requests.find(item => item.url === API + "/plans");
  assert.deepEqual(saved.body, { expectedRevision: 2, appId: "app-1", environment: "production", path: "live", sourceId: "source-live" });
  assert.equal(saved.init.credentials, "same-origin"); assert.equal(saved.init.redirect, "error"); assert.equal(saved.init.cache, "no-store"); assert.equal(saved.init.headers.Authorization, undefined);
  assert.equal(h.cleanup.isDirty(), false); assert.equal(h.field("setupApp").disabled, true); assert.equal(h.field("setupEnvironment").disabled, true);
  assert.equal(h.link("Connect live Sentry monitoring").href, "#/sources?stab=live&appId=app-1&environment=production&setupId=" + ID + "&sourceId=source-live");
  assert.equal(h.link("Bookmark this guide").href, "#/sources?stab=setup&setupId=" + ID);
  assert.match(h.container.textContent, /Saving does not activate collection/); assert.equal(h.requests.some(item => item.url.includes("/check?")), false);
});

test("saved guide resumes from URL without checking or mutating and unavailable sources are not replaced", async t => {
  const h = harness(t, { plans: [plan({ sourceId: "source-gone" })], query: new URLSearchParams({ setupId: ID }) }); await settle();
  assert.equal(h.field("setupApp").value, "app-1"); assert.equal(h.field("setupSource").value, "source-gone");
  assert.match(h.container.textContent, /No different source has been selected automatically/); assert.equal(h.button("Check my setup").disabled, false);
  assert.equal(h.requests.length, 2); assert.ok(h.requests.every(item => item.init.method === "GET"));
  change(h.field("setupPath"), "vendor"); assert.equal(h.field("setupSource").value, ""); h.button("Discard guide edits").click();
  assert.equal(h.field("setupSource").value, "source-gone"); assert.equal(h.cleanup.isDirty(), false);
});

test("saved guide changes path and binding with PATCH, not application identity", async t => {
  const h = harness(t, { plans: [plan()], query: { setupId: ID } }); await settle();
  change(h.field("setupPath"), "vendor"); change(h.field("setupSource"), "source-vendor");
  assert.equal(h.button("Check my setup").disabled, true); h.button("Save setup guide").click(); await settle();
  const saved = h.requests.find(item => item.init.method === "PATCH");
  assert.equal(saved.url, API + "/plans/" + ID); assert.deepEqual(saved.body, { expectedRevision: 2, path: "vendor", sourceId: "source-vendor" });
  assert.match(h.link("Choose a vendor import").href, /^#\/sources\?stab=vendors&appId=app-1/);
});

test("check is a GET with saved binding, renders independent evidence and never sends tests or polls", async t => {
  const h = harness(t, { plans: [plan({ sourceId: "source-live" })], query: { setupId: ID }, diagnostic: diagnostic({ sourceId: "source-live", summary: "Collection is current; notification receipt is not proved.", checks: [
    { id: "binding", title: "Source binding", state: "pass", detail: "Matches the selected application." },
    { id: "collection", title: "Collection", state: "pass", detail: "A complete zero-event window was collected." },
    { id: "admission", title: "Accepted records", state: "waiting", detail: "No retained records yet." },
    { id: "notification-provider", title: "Slack delivery", state: "attention", detail: "A pending message has not been acknowledged by Slack.", href: "#/sources?stab=live" },
    { id: "notification-human", title: "Human receipt", state: "not-applicable", detail: "Human receipt is never inferred from a provider response." }
  ], destinations: [{ title: "Received observations", href: "#/sources?stab=observations&sourceId=source-live", detail: "Retained source records." }] }) });
  await settle(); h.button("Check my setup").click(); await settle();
  assert.equal(h.requests.at(-1).url, API + "/check?appId=app-1&environment=production&path=live&sourceId=source-live");
  assert.ok(h.requests.every(item => item.init.method === "GET")); assert.equal(h.requests.length, 3);
  assert.match(h.container.textContent, /Pass · Collection/); assert.match(h.container.textContent, /Waiting for evidence · Accepted records/);
  assert.match(h.container.textContent, /Needs attention · Slack delivery/); assert.match(h.container.textContent, /Not applicable · Human receipt/);
  assert.match(h.container.textContent, /Results checked at 2026-09-29T12:00:00.000Z/); assert.match(h.container.textContent, /point-in-time check/);
  assert.equal(h.link("Open this source's retained observations").href, "#/sources?stab=observations&sourceId=source-live");
  assert.ok(h.link("Open live connection actions and Slack test")); assert.equal(h.timers.size, 0);
});

test("editing or refreshing a guide clears stale diagnostic proof and requires explicit recheck", async t => {
  const h = harness(t, { plans: [plan()], query: { setupId: ID } }); await settle(); h.button("Check my setup").click(); await settle();
  assert.match(h.container.textContent, /Results checked at/); change(h.field("setupSource"), "source-live");
  assert.doesNotMatch(h.container.textContent, /Results checked at/); assert.equal(h.button("Check my setup").disabled, true);
  h.button("Discard guide edits").click(); h.button("Check my setup").click(); await settle();
  h.button("Refresh guides and sources").click(); await settle(); assert.doesNotMatch(h.container.textContent, /Results checked at/);
  assert.equal(h.requests.filter(item => item.url.includes("/check?")).length, 2);
});

test("unbound guide can be checked without manufactured completion records", async t => {
  const h = harness(t, { plans: [plan()], query: { setupId: ID } }); await settle(); h.button("Check my setup").click(); await settle();
  assert.equal(h.requests.at(-1).url, API + "/check?appId=app-1&environment=production&path=live");
  assert.match(h.container.textContent, /Waiting for evidence · Source binding/); assert.match(h.container.textContent, /Collection and retained events have not been proved/);
  assert.equal(h.link("Open this source's retained observations"), undefined); assert.equal(h.requests.filter(item => item.init.method !== "GET").length, 0);
});

test("inline application registration sends no hosts, reuses uncertain command ID and selects new app", async t => {
  let attempts = 0;
  const h = harness(t, { fetch: (url, init, fallback) => url === "/api/v1/control/commands" && ++attempts === 1 ? response({ secret: "must-not-be-rendered" }, 503) : fallback(url, init) }); await settle();
  change(h.field("setupApplicationName"), "New web app"); change(h.field("setupNewEnvironment"), "staging"); assert.equal(h.field("setupApp").disabled, true);
  h.button("Register application").click(); await settle(); h.button("Register application").click(); await settle();
  const commands = h.requests.filter(item => item.url === "/api/v1/control/commands"); assert.equal(commands.length, 2); assert.equal(commands[0].body.requestId, commands[1].body.requestId);
  assert.deepEqual(commands[1].body.input, { displayName: "New web app", hosts: [], environments: ["staging"], publicPages: [] });
  assert.equal(commands[1].body.command, "app.register"); assert.equal(h.field("setupApp").value, "registered-app"); assert.equal(h.field("setupEnvironment").value, "staging");
  assert.equal(h.field("setupApplicationName").value, ""); assert.equal(h.cleanup.isDirty(), true);
  assert.doesNotMatch(h.container.textContent, /must-not-be-rendered/); assert.match(h.container.textContent, /Application registered without hosts/);
});

test("registration validates display name and normalized environment before making a write", async t => {
  const h = harness(t); await settle(); change(h.field("setupApplicationName"), "New web app"); change(h.field("setupNewEnvironment"), "Production");
  h.button("Register application").click(); await settle(); assert.match(h.container.textContent, /lowercase environment/);
  assert.equal(h.requests.filter(item => item.init.method !== "GET").length, 0); assert.equal(h.cleanup.isDirty(), true);
  h.button("Discard application draft").click(); assert.equal(h.cleanup.isDirty(), false); assert.equal(h.field("setupApp").disabled, false);
});

test("discarding an application draft restores saved guide connection links", async t => {
  const h = harness(t, { plans: [plan()], query: { setupId: ID } }); await settle();
  assert.ok(h.link("Connect live Sentry monitoring")); change(h.field("setupApplicationName"), "Unsaved app");
  assert.equal(h.link("Connect live Sentry monitoring"), undefined); h.button("Discard application draft").click();
  assert.ok(h.link("Connect live Sentry monitoring")); assert.equal(h.cleanup.isDirty(), false);
});

test("refused refresh or resume preserves unsaved selections and suppresses requests", async t => {
  const h = harness(t, { plans: [plan()], confirm: false }); await settle(); chooseApp(h); change(h.field("setupEnvironment"), "staging"); const before = h.requests.length;
  h.button("Refresh guides and sources").click(); h.button(resumeLabel).click(); await settle();
  assert.equal(h.requests.length, before); assert.equal(h.field("setupEnvironment").value, "staging"); assert.equal(h.cleanup.isDirty(), true); assert.equal(h.confirmations.length, 2);
});

test("approved refresh discards binding draft even if subsequent network refresh fails", async t => {
  let reads = 0;
  const h = harness(t, { plans: [plan()], query: { setupId: ID }, fetch: (url, init, fallback) => url === API && ++reads > 1 ? response({}, 503) : fallback(url, init) }); await settle();
  change(h.field("setupPath"), "vendor"); h.button("Refresh guides and sources").click(); await settle();
  assert.equal(h.field("setupPath").value, "live"); assert.equal(h.cleanup.isDirty(), false); assert.match(h.container.textContent, /Setup diagnostics are unavailable/);
});

test("guide removal is explicit and only deletes guide with expected revision", async t => {
  const h = harness(t, { plans: [plan()], query: { setupId: ID } }); await settle();
  h.button("Remove guide for My application / production / Live Sentry connection").click(); await settle();
  const removed = h.requests.find(item => item.init.method === "DELETE"); assert.equal(removed.url, API + "/plans/" + ID); assert.deepEqual(removed.body, { expectedRevision: 2 });
  assert.equal(h.requests.filter(item => item.init.method !== "GET").length, 1); assert.match(h.confirmations[0], /Remove only this saved setup guide/);
  assert.match(h.container.textContent, /sources and monitoring data were not changed/); assert.equal(h.field("setupApp").disabled, false);
});

test("rejected setup write preserves draft and never displays remote error body", async t => {
  const h = harness(t, { fetch: (url, init, fallback) => url === API + "/plans" ? response({ message: "private-remote-payload" }, 409) : fallback(url, init) }); await settle(); chooseApp(h);
  h.button("Save setup guide").click(); await settle(); assert.equal(h.cleanup.isDirty(), true); assert.equal(h.field("setupApp").value, "app-1");
  assert.match(h.container.textContent, /matching guide already exists/); assert.doesNotMatch(h.container.textContent, /private-remote-payload/);
});

test("diagnostics reject mismatched binding and do not render arbitrary external links", async t => {
  const bad = harness(t, { plans: [plan()], query: { setupId: ID }, diagnostic: diagnostic({ appId: "app-2" }) }); await settle(); bad.button("Check my setup").click(); await settle();
  assert.match(bad.container.textContent, /invalid or mismatched diagnostic/); assert.doesNotMatch(bad.container.textContent, /Results checked at/);
  const h = harness(t, { plans: [plan()], query: { setupId: ID }, diagnostic: diagnostic({ checks: [{ id: "binding", title: "Unsafe destination", state: "waiting", detail: "Details stay plain text.", href: "javascript:alert(1)" }], destinations: [{ title: "External destination", href: "https://example.invalid/", detail: "Not linked." }, { title: "Protocol-relative fragment", href: "#//example.invalid/" }] }) }); await settle(); h.button("Check my setup").click(); await settle();
  assert.equal(h.link("Open Unsafe destination"), undefined); assert.equal(h.link("External destination"), undefined); assert.equal(h.link("Protocol-relative fragment"), undefined);
  assert.match(h.container.textContent, /External destination/);
});

test("Trivy and custom paths describe external acquisition with scoped actions", async t => {
  const h = harness(t, { plans: [plan({ path: "trivy" })], query: { setupId: ID } }); await settle();
  assert.match(h.container.textContent, /This application does not run scans/); assert.match(h.link("Import a Trivy report").href, /^#\/scans\?tab=trivy&appId=app-1/);
  change(h.field("setupPath"), "custom"); h.button("Save setup guide").click(); await settle();
  assert.match(h.container.textContent, /Registration alone does not collect data/); assert.match(h.link("Configure a custom source").href, /connectorType=canonical-events&appId=app-1/);
});

test("cleanup aborts pending requests and suppresses late DOM updates and errors", async t => {
  const signals = []; const h = harness(t, { fetch: (_url, init) => new Promise((_resolve, reject) => { signals.push(init.signal); init.signal.addEventListener("abort", () => reject(Object.assign(new Error("Stopped"), { name: "AbortError" })), { once: true }); }) });
  const before = h.container.textContent; h.cleanup(); await settle(); assert.equal(signals.length, 2); assert.ok(signals.every(signal => signal.aborted));
  assert.equal(h.container.textContent, before); assert.equal(h.errors.length, 0); assert.equal(h.timers.size, 0);
});

test("setup responses are bounded before parsing and invalid snapshots do not enable controls", async t => {
  const h = harness(t, { fetch: (url, init, fallback) => url === API ? new Response("x".repeat(4 * 1024 * 1024 + 1)) : fallback(url, init) }); await settle();
  assert.match(h.container.textContent, /Setup response exceeds its limit/); assert.equal(h.button("Save setup guide").disabled, true);
  const bad = harness(t, { fetch: (url, init, fallback) => url === API ? response({ revision: 0, plans: [] }) : fallback(url, init) }); await settle();
  assert.match(bad.container.textContent, /invalid snapshot/); assert.equal(bad.button("Register application").disabled, true);
});

test("failed initial load leaves a working explicit retry action", async t => {
  let reads = 0;
  const h = harness(t, { fetch: (url, init, fallback) => url === API && ++reads === 1 ? response({}, 503) : fallback(url, init) }); await settle();
  assert.equal(h.button("Refresh guides and sources").disabled, false); assert.equal(h.button("Register application").disabled, true);
  h.button("Refresh guides and sources").click(); await settle(); assert.equal(h.button("Register application").disabled, false);
  assert.equal(h.field("setupApp").childNodes.length, 3); assert.equal(h.cleanup.isDirty(), false);
});

test("selection callback reports only loaded saved guides so host can preserve bookmarks without navigation", async t => {
  const h = harness(t, { plans: [plan()], query: { setupId: "setup-missing" } }); await settle();
  assert.deepEqual(h.selections, [null]); h.button(resumeLabel).click(); assert.equal(h.selections.at(-1), ID);
  const before = h.selections.length; change(h.field("setupPath"), "vendor"); assert.equal(h.selections.length, before);
  h.button("Discard guide edits").click(); assert.equal(h.selections.at(-1), ID);
  h.button("Start another setup guide").click(); assert.equal(h.selections.at(-1), null);
  chooseApp(h); h.button("Save setup guide").click(); await settle(); assert.equal(h.selections.at(-1), ID);
});
