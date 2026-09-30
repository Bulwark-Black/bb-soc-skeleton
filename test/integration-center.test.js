"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { CANONICAL_EVENTS_MANIFEST } = require("../server/reference-manifest");

// Minimal DOM for this isolated widget: actual event bubbling, disabled controls
// and the native constraints used by its forms, without a browser dependency.
class Element {
  constructor(tagName, text = "") {
    this.tagName = tagName.toUpperCase(); this.nodeType = tagName === "#text" ? 3 : 1;
    this.childNodes = []; this.parentNode = null; this.dataset = {}; this.style = {}; this.attributes = {};
    this.listeners = new Map(); this.value = ""; this.checked = false; this.disabled = false; this.required = false; this._text = text;
  }
  append(...children) {
    for (const child of children) {
      if (child.parentNode) child.parentNode.childNodes = child.parentNode.childNodes.filter((item) => item !== child);
      child.parentNode = this; this.childNodes.push(child);
    }
  }
  replaceChildren(...children) { this.childNodes.forEach((child) => { child.parentNode = null; }); this.childNodes = []; this._text = ""; this.append(...children); }
  insertBefore(child, before) { child.parentNode = this; this.childNodes.splice(this.childNodes.indexOf(before), 0, child); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(type, listener) { const listeners = this.listeners.get(type) || []; listeners.push(listener); this.listeners.set(type, listeners); }
  dispatchEvent(event) {
    if (!event.target) event.target = this;
    if (!event.preventDefault) event.preventDefault = () => { event.defaultPrevented = true; };
    for (const listener of this.listeners.get(event.type) || []) listener(event);
    if (event.bubbles && this.parentNode) this.parentNode.dispatchEvent(event);
    return !event.defaultPrevented;
  }
  click() { if (!this.disabled) this.dispatchEvent({ type: "click", bubbles: true }); }
  matches(selector) {
    return selector.split(",").some((value) => {
      const part = value.trim();
      const named = /^\[name="([^"]+)"\]$/.exec(part);
      return named ? this.name === named[1] : this.tagName === part.toUpperCase();
    });
  }
  querySelectorAll(selector) {
    const result = [];
    for (const child of this.childNodes) { if (child.matches(selector)) result.push(child); result.push(...child.querySelectorAll(selector)); }
    return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  checkValidity() {
    if (this.tagName === "FORM") return this.querySelectorAll("input,textarea,select").every((input) => input.checkValidity());
    if (this.disabled) return true;
    if (this.required && !this.value) return false;
    if (this.value && this.pattern && !new RegExp("^(?:" + this.pattern + ")$").test(this.value)) return false;
    if (this.type === "number" && this.value && ((this.min !== undefined && Number(this.value) < Number(this.min)) || (this.max !== undefined && Number(this.value) > Number(this.max)))) return false;
    return true;
  }
  requestSubmit() { if (this.checkValidity()) this.dispatchEvent({ type: "submit", bubbles: true }); }
  reset() { for (const input of this.querySelectorAll("input,textarea,select")) { input.value = ""; input.checked = false; } }
  get textContent() { return this._text + this.childNodes.map((child) => child.textContent).join(""); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
}

const API = "/api/v1/integrations";
const catalog = () => ({ schemaVersion: "1", documentType: "integration-catalog", revision: 0,
  capacity: { installed: 14, maximum: 100, customInstalled: 0, customMaximum: 86 },
  integrations: [], recordKinds: ["log.event", "finding"], coverage: [] });
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const settle = async () => { for (let index = 0; index < 4; index += 1) await new Promise(setImmediate); };
function harness(t, options = {}) {
  const container = new Element("main"), requests = [], errors = [];
  const context = vm.createContext({ AbortController, TextDecoder, URLSearchParams, URL, setTimeout, clearTimeout,
    SOC_PRIVATE_APPLICATION: options.private !== false, confirm: () => true,
    document: { createElement: (tag) => new Element(tag), createTextNode: (text) => new Element("#text", String(text)) },
    fetch: async (url, init) => { requests.push({ url, init }); return options.fetch ? options.fetch(url, init) : response(catalog()); }
  });
  context.window = context;
  for (const filename of ["connector-contract.js", "integration-center.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "public", filename), "utf8"), context, { filename });
  }
  const cleanup = context.SocIntegrationCenter.render({ container, mode: options.mode || "integrations", onError: (error) => errors.push(error) });
  t.after(cleanup);
  return { container, requests, errors, cleanup,
    field: (name) => container.querySelector('[name="' + name + '"]'),
    button: (label) => container.querySelectorAll("button").find((button) => button.textContent === label),
    form: () => container.querySelector("form") };
}
function input(node, value, type = "input") { node.value = value; node.dispatchEvent({ type, bubbles: true }); }

test("integration catalog recovers from an initial failure without missing or duplicating kind choices", async (t) => {
  let calls = 0;
  const h = harness(t, { fetch: () => response(++calls === 1 ? { message: "Temporary catalog failure" } : catalog(), calls === 1 ? 503 : 200) });
  await settle();
  assert.equal(h.errors.length, 1);
  assert.equal(h.container.querySelectorAll('[name="allowedKind"]').length, 0);
  h.button("Refresh catalog").click(); await settle();
  const choices = h.container.querySelectorAll('[name="allowedKind"]');
  assert.deepEqual(choices.map((choice) => choice.value), ["log.event", "finding"]);
  choices[0].checked = true; choices[0].dispatchEvent({ type: "change", bubbles: true });
  h.button("Refresh catalog").click(); await settle();
  assert.equal(h.container.querySelectorAll('[name="allowedKind"]').length, 2);
  assert.equal(h.field("allowedKind").checked, true, "refresh preserves the operator's selection");
  assert.equal(h.cleanup.isDirty(), true);
});

test("advanced manifest override disables invalid simple fields across refresh and restores them after submission", async (t) => {
  const h = harness(t);
  await settle();
  input(h.field("integrationType"), "INVALID TYPE");
  input(h.field("integrationCadence"), "1");
  assert.equal(h.form().checkValidity(), false);
  const manifest = structuredClone(CANONICAL_EVENTS_MANIFEST); manifest.connectorType = "custom-review";
  input(h.field("manifestJson"), JSON.stringify(manifest));
  for (const name of ["integrationType", "integrationName", "sourceCategory", "integrationCadence", "allowedKind"]) assert.equal(h.field(name).disabled, true);
  assert.equal(h.form().checkValidity(), true, "disabled simple fields cannot block an advanced submission");
  h.button("Refresh catalog").click(); await settle();
  assert.equal(h.field("integrationType").disabled, true, "busy/idle synchronization preserves override mode");
  assert.equal(h.field("manifestJson").disabled, false);
  h.form().requestSubmit(); await settle();
  const posted = h.requests.find((request) => request.init.method === "POST");
  assert.ok(posted);
  assert.equal(JSON.parse(posted.init.body).manifest.connectorType, "custom-review");
  assert.equal(h.errors.length, 0);
  assert.equal(h.field("integrationType").disabled, false);
  assert.equal(h.field("integrationType").required, true);
  assert.equal(h.field("integrationCadence").value, "300");
  assert.equal(h.cleanup.isDirty(), false);
  input(h.field("manifestJson"), JSON.stringify(manifest));
  h.button("Discard draft").click();
  assert.equal(h.field("integrationType").disabled, false);
  assert.equal(h.field("manifestJson").value, "");
});

test("observations preserve visited offsets for short byte-limited pages and require applying changed filters", async (t) => {
  const observedQueries = [];
  const h = harness(t, { mode: "observations", fetch: (url) => {
    if (url === API) return response(catalog());
    if (url.startsWith("/api/v1/control/snapshot")) return response({ apps: [{ appId: "app-one", displayName: "One" }, { appId: "app-two", displayName: "Two" }], setups: [], sources: [] });
    const query = new URL(url, "http://127.0.0.1").searchParams;
    observedQueries.push(Object.fromEntries(query));
    const offset = Number(query.get("offset"));
    const length = offset === 0 ? 2 : offset === 2 ? 3 : 1;
    return response({ matched: 100, hasMore: true, bytesLimited: true, sourceContexts: [],
      records: Array.from({ length }, (_, index) => ({ sourceId: "source-one", estateId: "app-one", kind: "log.event",
        recordId: "record-" + (offset + index), observedAt: "2026-09-29T12:00:00.000Z", payload: { title: "Synthetic observation", state: "unknown" } })) });
  } });
  await settle();
  h.button("Next page").click(); await settle();
  h.button("Next page").click(); await settle();
  h.button("Previous page").click(); await settle();
  assert.deepEqual(observedQueries.map((query) => Number(query.offset)), [0, 2, 5, 2]);
  input(h.field("appFilter"), "app-two", "change");
  assert.equal(h.button("Next page").disabled, true);
  assert.equal(h.button("Previous page").disabled, true);
  const before = observedQueries.length;
  h.button("Next page").click(); await settle();
  assert.equal(observedQueries.length, before, "unapplied filters cannot skip into a different filtered result set");
  h.form().requestSubmit(); await settle();
  assert.equal(observedQueries.at(-1).offset, "0");
  assert.equal(observedQueries.at(-1).appId, "app-two");
  assert.equal(h.button("Previous page").disabled, true, "applying filters resets visited history");
  assert.equal(h.button("Next page").disabled, false);
  assert.equal(h.cleanup.isDirty(), false);
});

test("static integration center performs no requests and disposing an active widget aborts without replacing its DOM", async (t) => {
  const empty = harness(t, { private: false });
  await settle();
  assert.equal(empty.requests.length, 0);
  assert.equal(empty.cleanup.isDirty(), false);
  assert.match(empty.container.textContent, /static shell has no integration registry/);
  let requestSignal;
  const active = harness(t, { fetch: (_url, init) => new Promise((_resolve, reject) => {
    requestSignal = init.signal;
    requestSignal.addEventListener("abort", () => reject(Object.assign(new Error("Stopped"), { name: "AbortError" })), { once: true });
  }) });
  assert.equal(active.cleanup.isDirty(), true);
  const before = active.container.textContent;
  active.cleanup(); await settle();
  assert.equal(requestSignal.aborted, true);
  assert.equal(active.container.textContent, before);
  assert.equal(active.errors.length, 0);
});
