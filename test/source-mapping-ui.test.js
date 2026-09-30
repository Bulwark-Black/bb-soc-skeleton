"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { mappingCatalog, inspectSourceMapping, previewSourceMapping } = require("../server/source-mapping");
class Element {
  constructor(tag, text = "") { this.tagName = tag.toUpperCase(); this.childNodes = []; this.parentNode = null; this.style = {}; this.attributes = {}; this.listeners = new Map(); this._value = ""; this._text = text; this.disabled = false; this.checked = false; }
  append(...children) { for (const child of children) { if (child.parentNode) child.parentNode.childNodes = child.parentNode.childNodes.filter(item => item !== child); child.parentNode = this; this.childNodes.push(child); } }
  replaceChildren(...children) { for (const child of this.childNodes) child.parentNode = null; this.childNodes = []; this._text = ""; if (this.tagName === "SELECT") this._value = ""; this.append(...children); }
  get value() { if (this.tagName !== "SELECT") return this._value; const options = this.childNodes.filter(child => child.tagName === "OPTION"); return options.some(child => child.value === this._value) ? this._value : options[0]?.value || ""; }
  set value(value) { this._value = String(value); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, listener) { const entries = this.listeners.get(type) || []; entries.push(listener); this.listeners.set(type, entries); }
  dispatchEvent(event) { event.target ||= this; event.preventDefault ||= () => {}; for (const listener of this.listeners.get(event.type) || []) listener(event); if (event.bubbles && this.parentNode) this.parentNode.dispatchEvent(event); }
  click() { if (!this.disabled) this.dispatchEvent({ type: "click", bubbles: true }); }
  matches(selector) { return selector.split(",").some(value => { const part = value.trim(), name = /^\[name="([^"]+)"\]$/.exec(part); return name ? this.name === name[1] : this.tagName === part.toUpperCase(); }); }
  querySelectorAll(selector) { const result = []; for (const child of this.childNodes) { if (child.matches(selector)) result.push(child); result.push(...child.querySelectorAll(selector)); } return result; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  get textContent() { return this._text + this.childNodes.map(child => child.textContent).join(""); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
}
const API = "/api/v1/source-mapping", AT = "2026-09-29T12:00:00.000Z";
const SAMPLE = JSON.stringify({ id: "synthetic-event", at: AT, title: "Synthetic title", message: "<img src=x onerror=synthetic>" });
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(setImmediate); };
function harness(t, options = {}) {
  const state = { apps: [{ appId: "app-synthetic", displayName: "Synthetic application", environments: ["test", "production"] }, { appId: "app-other", displayName: "Other application", environments: ["other"] }], integrationManifests: [],
    sources: [{ sourceId: "source-synthetic", appId: "app-synthetic", environment: "test", displayName: "Synthetic source", connectorType: "canonical-events", state: "configured" },
      { sourceId: "source-other", appId: "app-other", environment: "other", displayName: "Other source", connectorType: "canonical-events", state: "active" },
      { sourceId: "source-archived", appId: "app-synthetic", environment: "test", displayName: "Archived source", connectorType: "canonical-events", state: "archived" }] };
  const runtime = { controlState: () => structuredClone(state), connectorAvailable: () => true };
  const requests = [], errors = [], timers = new Map(), confirmations = []; let serial = 0;
  const fallback = (url, init) => {
    try {
      if (url === API) return response(mappingCatalog(runtime));
      if (url === API + "/inspect") return response(inspectSourceMapping(JSON.parse(init.body)));
      if (url === API + "/preview") return response(previewSourceMapping(runtime, JSON.parse(init.body), { clock: () => new Date(AT) }));
    } catch (error) { return response({ error: error.message }, error.status || 500); }
    throw new Error("Unexpected synthetic UI request.");
  };
  const container = new Element("main"), context = vm.createContext({ AbortController, TextEncoder, TextDecoder, URL, URLSearchParams,
    SOC_PRIVATE_APPLICATION: options.private !== false, document: { createElement: tag => new Element(tag) },
    setTimeout: callback => { const id = ++serial; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id),
    confirm: message => { confirmations.push(message); return options.confirm !== false; },
    fetch: async (url, init) => { requests.push({ url, init, body: init.body === undefined ? undefined : JSON.parse(init.body) }); return options.fetch ? options.fetch(url, init, fallback) : fallback(url, init); }
  }); context.window = context;
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "public/source-mapping.js"), "utf8"), context);
  const cleanup = context.SocSourceMapping.render({ container, query: options.query, onError: error => errors.push(error) }); t.after(cleanup);
  return { container, requests, errors, timers, confirmations, cleanup, state,
    field: name => container.querySelector('[name="' + name + '"]'), button: title => container.querySelectorAll("button").find(node => node.textContent === title),
    link: title => container.querySelectorAll("a").find(node => node.textContent === title) };
}
function change(node, value, event = "change") { assert.ok(node); assert.equal(node.disabled, false); node.value = value; node.dispatchEvent({ type: event, bubbles: true }); }
async function draft(h) {
  await settle(); change(h.field("mappingApp"), "app-synthetic"); change(h.field("mappingSource"), "source-synthetic"); change(h.field("mappingKind"), "log.event");
  change(h.field("mappingText"), SAMPLE, "input"); h.field("mappingReviewed").checked = true; h.field("mappingReviewed").dispatchEvent({ type: "change" });
  h.button("Inspect field paths").click(); await settle();
  for (const [name, pointer] of [["upstreamId", "/id"], ["observedAt", "/at"], ["title", "/title"], ["message", "/message"]]) change(h.field("mappingPath-" + name), pointer);
}

test("static mapping guide makes no requests and provides no private sample form", async t => {
  const h = harness(t, { private: false }); await settle(); assert.equal(h.requests.length, 0); assert.equal(h.timers.size, 0); assert.equal(h.cleanup.isDirty(), false);
  assert.equal(h.field("mappingText"), null); assert.match(h.container.textContent, /static skeleton makes no requests/);
});
test("binding selection limits environments, sources and kinds; query context only preselects matching targets", async t => {
  const h = harness(t, { query: new URLSearchParams({ appId: "app-synthetic", environment: "test", sourceId: "source-synthetic" }) }); await settle();
  assert.equal(h.field("mappingApp").value, "app-synthetic"); assert.equal(h.field("mappingSource").value, "source-synthetic");
  assert.deepEqual(h.field("mappingSource").childNodes.map(node => node.value), ["", "source-synthetic"]); assert.equal(h.cleanup.isDirty(), false);
  assert.equal(h.field("mappingKind").childNodes.length, 30);
  change(h.field("mappingEnvironment"), "production"); assert.equal(h.field("mappingSource").value, ""); assert.equal(h.field("mappingKind").value, "");
  assert.equal(h.cleanup.isDirty(), true); assert.equal(h.button("Preview canonical batch — do not import").disabled, true);
});
test("mapping configuration links preserve valid application/environment/guide context and follow explicit selection changes", async t => {
  const setupId = "setup-11111111-1111-4111-8111-111111111111";
  const h = harness(t, { query: new URLSearchParams({ appId: "app-synthetic", environment: "test", sourceId: "source-synthetic", setupId }) }); await settle();
  const initial = h.link("Configure a canonical source").href;
  assert.equal(initial, "#/sources?stab=add&connectorType=canonical-events&appId=app-synthetic&environment=test&setupId=" + setupId);
  change(h.field("mappingEnvironment"), "production");
  assert.equal(h.link("Configure a canonical source").href, "#/sources?stab=add&connectorType=canonical-events&appId=app-synthetic&environment=production");
  change(h.field("mappingApp"), "app-other");
  assert.equal(h.link("Configure a canonical source").href, "#/sources?stab=add&connectorType=canonical-events&appId=app-other&environment=other");
});
test("explicit sample review gates inspection, which reveals paths instead of raw values", async t => {
  const h = harness(t); await settle(); change(h.field("mappingText"), SAMPLE, "input");
  assert.equal(h.button("Inspect field paths").disabled, true); assert.equal(h.requests.length, 1);
  h.field("mappingReviewed").checked = true; h.field("mappingReviewed").dispatchEvent({ type: "change" }); h.button("Inspect field paths").click(); await settle();
  assert.match(h.container.textContent, /4 distinct scalar paths/); assert.doesNotMatch(h.container.textContent, /<img src=x/);
  assert.equal(h.requests.at(-1).url, API + "/inspect"); assert.deepEqual(h.requests.at(-1).body, { text: SAMPLE });
  assert.equal(h.requests.at(-1).init.credentials, "same-origin"); assert.equal(h.requests.at(-1).init.redirect, "error"); assert.equal(h.requests.at(-1).init.headers.Authorization, undefined);
});
test("guided mapping previews exact source-bound retained fields and only offers selectable export data", async t => {
  const h = harness(t), before = JSON.stringify(h.state); await draft(h);
  assert.equal(h.field("mappingMode-state").value, "value"); assert.equal(h.field("mappingValue-state").value, "unknown");
  h.button("Preview canonical batch — do not import").click(); await settle();
  assert.equal(h.requests.length, 3); assert.ok(h.requests.every(item => item.url === API || item.url === API + "/inspect" || item.url === API + "/preview"));
  const sent = h.requests.at(-1).body; assert.equal(sent.appId, "app-synthetic"); assert.equal(sent.sourceId, "source-synthetic"); assert.deepEqual(sent.recipe.upstreamId, { path: "/id" });
  assert.equal(JSON.stringify(h.state), before); const exported = JSON.parse(h.field("mappingBatchOutput").value); assert.equal(exported.records[0].payload.message, "<img src=x onerror=synthetic>");
  assert.equal(h.field("mappingBatchOutput").readOnly, true); assert.equal(h.field("mappingRecipeOutput").readOnly, true);
  assert.deepEqual(JSON.parse(h.field("mappingRecordOutput").value), exported.records[0]);
  assert.equal(h.link("Source setup and activation").href, "#/sources?stab=add&appId=app-synthetic&environment=test&sourceId=source-synthetic");
  assert.match(h.container.textContent, /node tools\/map-events.js --recipe/); assert.match(h.container.textContent, /does not verify current server registration/);
  assert.equal(h.container.querySelectorAll("img").length, 0); assert.equal(h.cleanup.isDirty(), true); assert.equal(h.timers.size, 0);
});
test("editing sample, field selection or binding clears stale output and rechecks sample review", async t => {
  const h = harness(t); await draft(h); h.button("Preview canonical batch — do not import").click(); await settle(); assert.ok(h.field("mappingBatchOutput"));
  change(h.field("mappingValue-state"), "warn"); assert.equal(h.field("mappingBatchOutput"), null);
  h.button("Preview canonical batch — do not import").click(); await settle(); assert.ok(h.field("mappingBatchOutput"));
  change(h.field("mappingText"), SAMPLE + "\n", "input"); assert.equal(h.field("mappingBatchOutput"), null); assert.equal(h.field("mappingReviewed").checked, false);
  assert.equal(h.field("mappingPath-upstreamId"), null); assert.equal(h.button("Preview canonical batch — do not import").disabled, true);
});
test("discard protection retains rejected drafts, and explicit clearing removes sample and preview", async t => {
  const denied = harness(t, { confirm: false }); await draft(denied); const count = denied.requests.length;
  denied.button("Discard sample and mapping").click(); denied.button("Refresh compatible sources").click(); await settle();
  assert.equal(denied.requests.length, count); assert.equal(denied.field("mappingText").value, SAMPLE); assert.equal(denied.cleanup.isDirty(), true);
  const allowed = harness(t); await draft(allowed); allowed.button("Discard sample and mapping").click();
  assert.equal(allowed.field("mappingText").value, ""); assert.equal(allowed.cleanup.isDirty(), false); assert.equal(allowed.field("mappingPath-upstreamId"), null);
});
test("server failures and mismatched previews display no raw response body or selectable batch", async t => {
  const refused = harness(t, { fetch: (url, init, fallback) => url.endsWith("/preview") ? response({ secret: "must-not-render" }, 400) : fallback(url, init) });
  await draft(refused); refused.button("Preview canonical batch — do not import").click(); await settle();
  assert.equal(refused.field("mappingBatchOutput"), null); assert.doesNotMatch(refused.container.textContent, /must-not-render/); assert.match(refused.container.textContent, /Mapping refused/);
  const mismatch = harness(t, { fetch: async (url, init, fallback) => {
    const original = fallback(url, init); if (!url.endsWith("/preview")) return original;
    const value = await original.json(); value.recipe.sourceId = "another-source"; return response(value);
  } });
  await draft(mismatch); mismatch.button("Preview canonical batch — do not import").click(); await settle();
  assert.equal(mismatch.field("mappingBatchOutput"), null); assert.match(mismatch.container.textContent, /belongs to another source/);
});
test("disposal aborts pending reads, clears sensitive in-memory forms and ignores late responses", async t => {
  let resolve, signal;
  const h = harness(t, { fetch: (url, init, fallback) => { if (!url.endsWith("/preview")) return fallback(url, init); signal = init.signal; return new Promise(done => { resolve = () => done(fallback(url, init)); }); } });
  await draft(h); h.button("Preview canonical batch — do not import").click(); await settle(); assert.equal(signal.aborted, false);
  h.cleanup(); assert.equal(signal.aborted, true); assert.equal(h.field("mappingText").value, ""); assert.equal(h.cleanup.isDirty(), false);
  resolve(); await settle(); assert.equal(h.field("mappingBatchOutput"), null); assert.equal(h.timers.size, 0);
});
