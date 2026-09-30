"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { listVendorAdapters } = require("../tools/vendor-adapters");

// Isolated DOM semantics needed here: native select defaults, file clearing,
// event bubbling, and disabled buttons. No browser library or real network.
class Element {
  constructor(tagName, text = "") {
    this.tagName = tagName.toUpperCase(); this.nodeType = tagName === "#text" ? 3 : 1;
    this.childNodes = []; this.parentNode = null; this.dataset = {}; this.style = {}; this.attributes = {};
    this.listeners = new Map(); this._value = ""; this.files = []; this.disabled = false; this._text = text;
  }
  append(...children) {
    for (const child of children) {
      if (child.parentNode) child.parentNode.childNodes = child.parentNode.childNodes.filter(item => item !== child);
      child.parentNode = this; this.childNodes.push(child);
    }
  }
  replaceChildren(...children) {
    this.childNodes.forEach(child => { child.parentNode = null; }); this.childNodes = []; this._text = "";
    if (this.tagName === "SELECT") this._value = "";
    this.append(...children);
  }
  get value() {
    if (this.tagName !== "SELECT") return this._value;
    const options = this.childNodes.filter(child => child.tagName === "OPTION");
    return options.some(option => option.value === this._value) ? this._value : options[0]?.value || "";
  }
  set value(value) { this._value = String(value); if (this.type === "file" && this._value === "") this.files = []; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(type, listener) { const list = this.listeners.get(type) || []; list.push(listener); this.listeners.set(type, list); }
  dispatchEvent(event) {
    if (!event.target) event.target = this;
    if (!event.preventDefault) event.preventDefault = () => { event.defaultPrevented = true; };
    for (const listener of this.listeners.get(event.type) || []) listener(event);
    if (event.bubbles && this.parentNode) this.parentNode.dispatchEvent(event);
  }
  click() { if (!this.disabled) this.dispatchEvent({ type: "click", bubbles: true }); }
  matches(selector) {
    return selector.split(",").some(value => {
      const part = value.trim(), name = /^\[name="([^"]+)"\]$/.exec(part);
      return name ? this.name === name[1] : this.tagName === part.toUpperCase();
    });
  }
  querySelectorAll(selector) {
    const result = [];
    for (const child of this.childNodes) { if (child.matches(selector)) result.push(child); result.push(...child.querySelectorAll(selector)); }
    return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  get textContent() { return this._text + this.childNodes.map(child => child.textContent).join(""); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
}

const VENDOR_API = "/api/v1/integrations/vendors", CATALOG_API = "/api/v1/integrations";
const ADAPTERS = listVendorAdapters().filter(item => ["entra-signin", "okta-system-log"].includes(item.id));
const AT = "2026-09-29T12:00:00.000Z";
const RAW = JSON.stringify([{ id: "synthetic-entra", createdDateTime: AT, userId: "synthetic-user", status: { errorCode: 0 } }]);
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise(setImmediate); };
const source = (state = "active", id = "synthetic-source", type = "vendor.entra-signin") => ({ sourceId: id, connectorType: type,
  connectorInstanceId: "synthetic-connector", displayName: "Synthetic source", environment: "test", state, revision: 4 });
const sample = () => ({ schemaVersion: "1", documentType: "normalized-record", recordId: "synthetic-record", sourceId: "synthetic-source",
  estateId: "synthetic-app", kind: "authentication.event", observedAt: AT, payload: { title: "Synthetic sign-in", state: "ok", identityRef: "synthetic-identity" } });
function preview(state = "active") { return { adapterId: "entra-signin", sourceId: "synthetic-source", connectorInstanceId: "synthetic-connector",
  sourceRevision: 4, state, previewHash: "a".repeat(64), totalRecords: 1, records: [sample()], recordSample: sample() }; }

function harness(t, options = {}) {
  const container = new Element("main"), requests = [], errors = [], confirmations = [];
  let installed = options.installed ?? true;
  const defaultFetch = (url, init) => {
    if (url === VENDOR_API) return response({ adapters: ADAPTERS });
    if (url === CATALOG_API && init.method === "POST") { installed = true; return response({}); }
    if (url === CATALOG_API) return response({ revision: 7, integrations: installed ? [{ manifest: ADAPTERS[0].manifest }] : [] });
    if (url.startsWith("/api/v1/control/snapshot")) return response(options.snapshot || { setups: [], sources: [source(options.state)] });
    if (url === VENDOR_API + "/preview") return response(preview(options.state));
    if (url === "/api/v1/control/commands") return response({ status: "succeeded" });
    if (url === VENDOR_API + "/import") return response({ receipt: { sourceId: "synthetic-source", accepted: 1, duplicates: 0, replay: false } });
    throw new Error("Unexpected synthetic request.");
  };
  const context = vm.createContext({ AbortController, TextDecoder, setTimeout, clearTimeout,
    SOC_PRIVATE_APPLICATION: options.private !== false,
    confirm: message => { confirmations.push(message); return options.confirm === undefined ? true : options.confirm; },
    document: { createElement: tag => new Element(tag), createTextNode: text => new Element("#text", String(text)) },
    fetch: async (url, init) => { requests.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined }); return options.fetch ? options.fetch(url, init, defaultFetch) : defaultFetch(url, init); }
  });
  context.window = context;
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "public/vendor-import.js"), "utf8"), context, { filename: "vendor-import.js" });
  const cleanup = context.SocVendorImport.render({ container, query: options.query, onError: error => errors.push(error) });
  t.after(cleanup);
  return { container, requests, errors, confirmations, cleanup,
    field: name => container.querySelector('[name="' + name + '"]'),
    button: label => container.querySelectorAll("button").find(button => button.textContent === label),
    link: label => container.querySelectorAll("a").find(link => link.textContent === label) };
}
function change(node, value) { node.value = value; node.dispatchEvent({ type: "change", bubbles: true }); }
function chooseFile(h, text = RAW, options = {}) {
  const bytes = Buffer.from(text), node = h.field("vendorFile");
  node.files = [{ name: "synthetic-events.json", size: bytes.length, arrayBuffer: async () => bytes, ...options }];
  node.dispatchEvent({ type: "change", bubbles: true });
}
async function prepare(h) {
  await settle(); change(h.field("vendorSource"), "synthetic-source"); chooseFile(h);
  h.button("Preview mapping").click(); await settle();
}

test("vendor importer static shell performs no network or draft work", async t => {
  const h = harness(t, { private: false }); await settle();
  assert.equal(h.requests.length, 0); assert.equal(h.cleanup.isDirty(), false);
  assert.match(h.container.textContent, /No vendor credentials, files or records are included in the static skeleton/);
  assert.equal(h.field("vendorFile"), null);
});

test("saved setup scope filters vendor sources and carries exact binding into configuration links", async t => {
  const selected = { ...source("active", "selected-source", "vendor.okta-system-log"), appId: "selected-app" };
  const wrongApp = { ...selected, sourceId: "wrong-app", appId: "other-app" };
  const wrongEnv = { ...selected, sourceId: "wrong-env", environment: "other" };
  const h = harness(t, { snapshot: { setups: [], sources: [selected, wrongApp, wrongEnv] },
    query: new URLSearchParams({ appId: "selected-app", environment: "test", sourceId: "selected-source", setupId: "setup-synthetic" }) });
  await settle();
  assert.equal(h.field("vendorAdapter").value, "okta-system-log");
  assert.deepEqual(h.field("vendorSource").querySelectorAll("option").map(item => item.value), ["", "selected-source"]);
  assert.equal(h.field("vendorSource").value, "selected-source");
  const links = h.container.querySelectorAll("a").filter(item => item.href.includes("stab=add"));
  assert.ok(links.length); for (const link of links) assert.match(link.href, /appId=selected-app&environment=test&setupId=setup-synthetic/);
});

test("vendor preset installation posts exact reviewed manifest and revision then exposes its configure link", async t => {
  const h = harness(t, { installed: false }); await settle();
  h.button("Install Microsoft Entra sign-ins preset").click(); await settle();
  const posts = h.requests.filter(request => request.init.method === "POST");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, CATALOG_API);
  assert.deepEqual(posts[0].body, { manifest: ADAPTERS[0].manifest, expectedRevision: 7 });
  assert.equal(h.link("Configure source").href, "#/sources?stab=add&connectorType=vendor.entra-signin");
  assert.match(h.container.textContent, /Preset installed/);
  assert.equal(h.cleanup.isDirty(), false); assert.equal(h.errors.length, 0);
});

test("vendor preview binds selected file, adapter and compatible source without sending or storing vendor credentials", async t => {
  const h = harness(t, { snapshot: { setups: [source("configured", "setup-source")], sources: [source(), source("archived", "archived-source"),
    source("removed", "removed-source"), source("active", "okta-source", "vendor.okta-system-log")] } });
  await settle();
  assert.deepEqual(h.field("vendorSource").childNodes.map(option => option.value), ["", "setup-source", "synthetic-source"]);
  assert.equal(h.button("Preview mapping").disabled, true);
  change(h.field("vendorSource"), "synthetic-source"); chooseFile(h);
  assert.equal(h.cleanup.isDirty(), true); assert.equal(h.button("Preview mapping").disabled, false);
  h.button("Preview mapping").click(); await settle();
  const request = h.requests.find(item => item.url === VENDOR_API + "/preview");
  assert.deepEqual(request.body, { adapterId: "entra-signin", sourceId: "synthetic-source", text: RAW });
  assert.equal(request.init.credentials, "same-origin"); assert.equal(request.init.redirect, "error");
  assert.equal(request.init.headers.Authorization, undefined);
  assert.match(h.container.textContent, /Mapping preview — nothing stored/);
  assert.equal(h.button("Validate source with preview sample").disabled, true);
  assert.equal(h.button("Import reviewed events").disabled, false);
  assert.equal(h.requests.filter(item => item.url.endsWith("/import")).length, 0);
});

test("configured source preview permits source.test but not import, using the exact preview sample and source revision", async t => {
  const h = harness(t, { state: "configured" }); await prepare(h);
  assert.equal(h.button("Import reviewed events").disabled, true);
  h.button("Import reviewed events").click(); await settle();
  assert.equal(h.requests.filter(item => item.url.endsWith("/import")).length, 0);
  assert.equal(h.button("Validate source with preview sample").disabled, false);
  h.button("Validate source with preview sample").click(); await settle();
  const command = h.requests.find(item => item.url === "/api/v1/control/commands").body;
  assert.equal(command.command, "source.test");
  assert.deepEqual(command.input, { sourceId: "synthetic-source", connectorInstanceId: "synthetic-connector", expectedRevision: 4, recordSample: sample() });
  assert.equal(h.button("Validate source with preview sample").disabled, true);
  assert.equal(h.button("Import reviewed events").disabled, true);
  assert.equal(h.cleanup.isDirty(), true);
  assert.match(h.container.textContent, /validated without storage/);
  assert.ok(!h.requests.some(item => item.body?.command === "source.activate"));
});

test("vendor import commits exact preview hash and file, clears draft and shows the acknowledged observation link", async t => {
  const h = harness(t); await prepare(h);
  h.button("Import reviewed events").click(); await settle();
  const request = h.requests.find(item => item.url === VENDOR_API + "/import");
  assert.deepEqual(request.body, { adapterId: "entra-signin", sourceId: "synthetic-source", text: RAW, previewHash: "a".repeat(64) });
  assert.equal(h.field("vendorFile").files.length, 0);
  assert.equal(h.cleanup.isDirty(), false);
  assert.equal(h.button("Import reviewed events").disabled, true);
  assert.equal(h.link("View received observations").href, "#/sources?stab=observations&sourceId=synthetic-source");
  assert.match(h.container.textContent, /Delivery accepted: 1 new records/);
  assert.equal(h.errors.length, 0);
});

test("file, source and adapter changes invalidate mapping previews and require review again", async t => {
  const h = harness(t); await prepare(h);
  chooseFile(h, RAW + "\n");
  assert.equal(h.button("Import reviewed events").disabled, true);
  assert.doesNotMatch(h.container.textContent, /Mapping preview — nothing stored/);
  h.button("Preview mapping").click(); await settle();
  change(h.field("vendorSource"), "");
  assert.equal(h.button("Preview mapping").disabled, true); assert.equal(h.button("Import reviewed events").disabled, true);
  change(h.field("vendorSource"), "synthetic-source"); h.button("Preview mapping").click(); await settle();
  change(h.field("vendorAdapter"), "okta-system-log");
  assert.equal(h.button("Import reviewed events").disabled, true);
  assert.equal(h.field("vendorSource").value, "");
  assert.equal(h.link("Add this vendor source").href, "#/sources?stab=add&connectorType=vendor.okta-system-log");
  assert.equal(h.cleanup.isDirty(), true);
});

test("vendor draft refresh and discard require confirmation; refusal preserves file and preview", async t => {
  const h = harness(t, { confirm: false }); await prepare(h);
  const before = h.requests.length;
  h.button("Refresh vendor setup").click(); h.button("Discard selected file").click(); await settle();
  assert.equal(h.confirmations.length, 2);
  assert.equal(h.requests.length, before);
  assert.equal(h.cleanup.isDirty(), true);
  assert.equal(h.button("Import reviewed events").disabled, false);
  const accept = harness(t); await prepare(accept);
  accept.button("Discard selected file").click(); await settle();
  assert.equal(accept.cleanup.isDirty(), false);
  assert.equal(accept.field("vendorFile").files.length, 0);
  assert.equal(accept.button("Import reviewed events").disabled, true);
});

test("invalid file size and UTF-8 are refused before a preview POST", async t => {
  const h = harness(t); await settle(); change(h.field("vendorSource"), "synthetic-source");
  for (const options of [{ size: 0 }, { size: 8 * 1024 * 1024 + 1 }, { arrayBuffer: async () => Uint8Array.from([255, 255]) }]) {
    chooseFile(h, RAW, options); h.button("Preview mapping").click(); await settle();
  }
  assert.equal(h.requests.filter(item => item.init.method === "POST").length, 0);
  assert.equal(h.errors.length, 3);
  assert.equal(h.button("Import reviewed events").disabled, true);
});

test("disposing vendor importer aborts in-flight requests and suppresses late DOM and error updates", async t => {
  const signals = [];
  const h = harness(t, { fetch: (_url, init) => new Promise((_resolve, reject) => {
    signals.push(init.signal); init.signal.addEventListener("abort", () => reject(Object.assign(new Error("Stopped"), { name: "AbortError" })), { once: true });
  }) });
  const before = h.container.textContent;
  assert.equal(h.cleanup.isDirty(), true);
  h.cleanup(); await settle();
  assert.equal(signals.length, 3);
  assert.ok(signals.every(signal => signal.aborted));
  assert.equal(h.container.textContent, before);
  assert.equal(h.errors.length, 0);
});

test("disposing during a file read cannot start a later preview request after unmount", async t => {
  let finishRead;
  const h = harness(t); await settle(); change(h.field("vendorSource"), "synthetic-source");
  chooseFile(h, RAW, { arrayBuffer: () => new Promise(resolve => { finishRead = resolve; }) });
  h.button("Preview mapping").click();
  const before = h.container.textContent;
  h.cleanup(); finishRead(Buffer.from(RAW)); await settle();
  assert.equal(h.requests.filter(item => item.init.method === "POST").length, 0, "Navigation cancels the pending file workflow before it sends anything.");
  assert.equal(h.container.textContent, before);
  assert.equal(h.errors.length, 0);
});
