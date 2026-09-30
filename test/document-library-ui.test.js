"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
class Element {
  constructor(tag, text = "") { this.tagName = tag.toUpperCase(); this.childNodes = []; this.parentNode = null; this.dataset = {}; this.style = {}; this.attributes = {}; this.listeners = new Map(); this._value = ""; this._text = text; this.disabled = false; this.files = []; }
  append(...children) { for (const child of children) { if (child.parentNode) child.parentNode.childNodes = child.parentNode.childNodes.filter(item => item !== child); child.parentNode = this; this.childNodes.push(child); } }
  replaceChildren(...children) { this.childNodes.forEach(child => { child.parentNode = null; }); this.childNodes = []; this._text = ""; if (this.tagName === "SELECT") this._value = ""; this.append(...children); }
  get value() { if (this.tagName !== "SELECT") return this._value; const options = this.childNodes.filter(child => child.tagName === "OPTION"); return options.some(child => child.value === this._value) ? this._value : options[0]?.value || ""; }
  set value(value) { this._value = String(value); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(type, listener) { const list = this.listeners.get(type) || []; list.push(listener); this.listeners.set(type, list); }
  dispatchEvent(event) { if (!event.target) event.target = this; event.preventDefault ||= () => { event.defaultPrevented = true; }; for (const listener of this.listeners.get(event.type) || []) listener(event); if (event.bubbles && this.parentNode) this.parentNode.dispatchEvent(event); }
  click() { if (!this.disabled) this.dispatchEvent({ type: "click", bubbles: true }); }
  matches(selector) { return selector.split(",").some(value => { const part = value.trim(), name = /^\[name="([^"]+)"\]$/.exec(part); return name ? this.name === name[1] : this.tagName === part.toUpperCase(); }); }
  querySelectorAll(selector) { const results = []; for (const child of this.childNodes) { if (child.matches(selector)) results.push(child); results.push(...child.querySelectorAll(selector)); } return results; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  get elements() { return { namedItem: name => this.querySelector('[name="' + name + '"]') }; }
  reportValidity() { return this.querySelectorAll("input,select").every(item => !item.required || (item.type === "file" ? item.files.length : item.value)); }
  get textContent() { return this._text + this.childNodes.map(child => child.textContent).join(""); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
}
const API = "/api/v1/documents", ID = "document-11111111-1111-4111-8111-111111111111", AT = "2026-09-29T12:00:00.000Z";
const version = (number = 1) => ({ version: number, filename: "synthetic-evidence.txt", byteLength: 25, mime: "text/plain", sha256: String(number).repeat(64), actor: "operator-synthetic", createdAt: AT });
const existing = (changes = {}) => ({ document: { id: ID, title: "Existing synthetic evidence", appId: "app-1", owner: "Synthetic owner", status: "draft", reviewAt: "2026-12-01", linkKind: "risk", linkId: "risk-1", revision: 1, versionCount: 1, createdAt: AT, updatedAt: AT, archivedAt: null, ...changes }, versions: [version()], history: [] });
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise(setImmediate); };
function harness(t, options = {}) {
  const container = new Element("main"), requests = [], errors = [], timers = new Map(), listeners = new Map(), confirmations = []; let serial = 0, saved = options.detail || null;
  const apps = [{ appId: "app-1", displayName: "First web application" }, { appId: "app-2", displayName: "Second web application" }];
  const governance = { risks: [{ riskId: "risk-1", title: "Current application risk", status: "open" }, { riskId: "risk-2", title: "Historical risk", status: "archived" }], attestations: [{ attestationId: "attestation-1", title: "Review control", status: "draft" }] };
  function fallback(url, init) {
    if (url === "/api/v1/control/snapshot?reason=refresh") return response({ apps });
    if (url === "/api/v1/administration/snapshot?domain=governance&reason=refresh") return response(governance);
    if (url.startsWith(API + "?")) return response({ documents: saved ? [saved.document] : [], total: saved ? 1 : 0, nextOffset: null });
    if (url === API + "/upload") {
      const meta = JSON.parse(decodeURIComponent(init.headers["X-Document-Metadata"]));
      if (!meta.documentId) saved = existing({ ...meta.metadata, title: meta.metadata.title });
      else { saved.document.revision += 1; saved.document.versionCount += 1; saved.versions.unshift(version(saved.document.versionCount)); }
      return response(saved, 201);
    }
    if (url === API + "/" + ID && init.method === "PATCH") { Object.assign(saved.document, JSON.parse(init.body).patch); saved.document.revision += 1; return response(saved); }
    if ([API + "/" + ID + "/archive", API + "/" + ID + "/restore"].includes(url)) { saved.document.archivedAt = url.endsWith("/archive") ? AT : null; saved.document.revision += 1; return response(saved); }
    if (url === API + "/" + ID) return response(saved);
    throw new Error("Unexpected isolated document request: " + url);
  }
  const context = vm.createContext({ AbortController, TextDecoder, SOC_PRIVATE_APPLICATION: options.private !== false,
    document: { createElement: tag => new Element(tag) },
    setTimeout: callback => { const id = ++serial; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id),
    addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: name => listeners.delete(name),
    confirm: message => { confirmations.push(message); return options.confirm !== false; },
    fetch: async (url, init) => { requests.push({ url, init }); return options.fetch ? options.fetch(url, init, fallback) : fallback(url, init); }
  }); context.window = context;
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../public/document-library.js"), "utf8"), context, { filename: "document-library.js" });
  const cleanup = context.SocDocumentLibrary.render({ container, onError: error => errors.push(error) }); t.after(cleanup);
  const button = label => container.querySelectorAll("button").find(item => item.textContent === label);
  const form = label => { let current = button(label); while (current && current.tagName !== "FORM") current = current.parentNode; assert.ok(current, label); return current; };
  return { container, requests, errors, timers, listeners, confirmations, cleanup, apps, governance, button, form, saved: () => saved };
}
function change(form, name, value, type = "change") { const field = form.elements.namedItem(name); assert.ok(field, name); assert.equal(field.disabled, false, name); field.value = value; field.dispatchEvent({ type, bubbles: true }); return field; }
function file(form, size = 25) { const field = form.elements.namedItem("file"); field.files = [{ name: "synthetic-evidence.txt", type: "text/plain", size }]; field.dispatchEvent({ type: "change", bubbles: true }); }
function submit(form) { form.dispatchEvent({ type: "submit", bubbles: true }); }
function mutations(h) { return h.requests.filter(item => item.init.method && item.init.method !== "GET"); }

test("static document guide performs no private requests and opens no draft", async t => {
  const h = harness(t, { private: false }); await settle(); assert.equal(h.requests.length, 0); assert.equal(h.cleanup.isDirty(), false);
  assert.equal(h.container.querySelectorAll("form").length, 0);
});

test("document intake uses searchable registered application and governance selectors without silently selecting records", async t => {
  const h = harness(t); await settle(); const form = h.form("Upload document");
  assert.equal(h.requests.length, 3); assert.equal(form.elements.namedItem("appId").tagName, "SELECT");
  change(form, "applicationSearch", "Second", "input");
  assert.deepEqual(form.elements.namedItem("appId").childNodes.map(item => item.value), ["", "app-2"]);
  assert.equal(form.elements.namedItem("appId").value, "");
  change(form, "appId", "app-2"); change(form, "applicationSearch", "First", "input");
  assert.equal(form.elements.namedItem("appId").value, "app-2", "search preserves an explicit choice");
  change(form, "appId", ""); change(form, "applicationSearch", "Second", "input");
  assert.equal(form.elements.namedItem("appId").value, "", "search cannot resurrect an explicitly cleared application");
  change(form, "linkKind", "risk"); assert.equal(form.elements.namedItem("linkId").tagName, "SELECT");
  change(form, "recordSearch", "Historical", "input");
  assert.deepEqual(form.elements.namedItem("linkId").childNodes.map(item => item.value), ["", "risk-2"]);
  change(form, "linkId", "risk-2"); change(form, "linkId", ""); change(form, "recordSearch", "Current", "input");
  assert.equal(form.elements.namedItem("linkId").value, "", "search cannot resurrect an explicitly cleared record");
  change(form, "linkId", "risk-1"); change(form, "linkKind", "attestation");
  assert.equal(form.elements.namedItem("linkId").value, "", "changing kind clears the old binding instead of choosing the first record");
  assert.match(h.container.textContent, /Governance records are installation-wide/);
  assert.equal(mutations(h).length, 0);
});

test("guided upload sends only reviewed metadata and original file then displays its exact immutable version and hash", async t => {
  const h = harness(t); await settle(); const form = h.form("Upload document");
  change(form, "title", "Synthetic reviewed evidence"); change(form, "appId", "app-1"); change(form, "owner", "Document reviewer");
  change(form, "reviewAt", "2026-12-01"); change(form, "linkKind", "risk"); change(form, "linkId", "risk-1"); file(form); submit(form); await settle();
  const writes = mutations(h); assert.equal(writes.length, 1); assert.equal(writes[0].url, API + "/upload");
  const metadata = JSON.parse(decodeURIComponent(writes[0].init.headers["X-Document-Metadata"]));
  assert.deepEqual(metadata.metadata, { title: "Synthetic reviewed evidence", appId: "app-1", owner: "Document reviewer", status: "draft", reviewAt: "2026-12-01", linkKind: "risk", linkId: "risk-1" });
  assert.equal(metadata.expectedRevision, 0); assert.equal(h.cleanup.isDirty(), false);
  assert.match(h.container.textContent, /Saved immutable version receipt/); assert.ok(h.container.textContent.includes("SHA-256: " + "1".repeat(64)));
  assert.match(h.container.textContent, /does not change the linked risk or attestation/);
  assert.ok(h.requests.every(item => item.init.credentials === "same-origin" && item.init.redirect === "error" && item.init.cache === "no-store"));
  assert.ok(h.requests.every(item => item.init.headers.Authorization === undefined));
  assert.equal(h.governance.risks[0].status, "open");
});

test("a governance type with no selected record and oversized files are refused before upload", async t => {
  const h = harness(t); await settle(); const form = h.form("Upload document");
  change(form, "title", "Synthetic evidence"); change(form, "linkKind", "risk"); file(form); submit(form); await settle();
  assert.equal(mutations(h).length, 0); assert.match(h.container.textContent, /Choose both/);
  change(form, "linkId", "risk-1"); file(form, 10 * 1024 * 1024 + 1); submit(form); await settle();
  assert.equal(mutations(h).length, 0); assert.match(h.container.textContent, /no larger than 10 MiB/);
});

test("external case and policy references are labeled unverified and remain explicit operator input", async t => {
  const h = harness(t); await settle(); const form = h.form("Upload document");
  for (const kind of ["case", "policy"]) {
    change(form, "linkKind", kind); assert.equal(form.elements.namedItem("linkId").tagName, "INPUT");
    assert.match(h.container.textContent, /not verified/); assert.match(h.container.textContent, /no local case or policy registry/);
    change(form, "linkId", "external-reference");
  }
  change(form, "linkKind", ""); assert.equal(form.elements.namedItem("linkId").value, "");
});

test("historical unavailable application and risk bindings remain selected and survive unrelated metadata editing", async t => {
  const h = harness(t, { detail: existing({ appId: "app-removed", linkId: "risk-removed" }) }); await settle();
  h.button("Existing synthetic evidence").click(); await settle(); const form = h.form("Save metadata");
  assert.equal(form.elements.namedItem("appId").value, "app-removed"); assert.equal(form.elements.namedItem("linkId").value, "risk-removed");
  assert.match(h.container.textContent, /Historical application unavailable; preserved/); assert.match(h.container.textContent, /Historical record unavailable; preserved/);
  change(form, "owner", "New owner"); submit(form); await settle();
  const write = mutations(h)[0], body = JSON.parse(write.init.body); assert.equal(write.init.method, "PATCH");
  assert.equal(body.patch.appId, "app-removed"); assert.equal(body.patch.linkId, "risk-removed"); assert.equal(body.expectedRevision, 1);
  assert.equal(h.saved().document.owner, "New owner");
});

test("changing an orphan binding requires explicitly selecting every currently valid reference", async t => {
  const h = harness(t, { detail: existing({ appId: "app-removed", linkId: "risk-removed" }) }); await settle();
  h.button("Existing synthetic evidence").click(); await settle(); const form = h.form("Save metadata");
  change(form, "appId", "app-1"); submit(form); await settle(); assert.equal(mutations(h).length, 0);
  assert.match(h.container.textContent, /existing risk from the list/);
  change(form, "linkId", "risk-1"); submit(form); await settle(); assert.equal(mutations(h).length, 1);
});

test("new versions preserve bindings and expose a new exact hash without overwriting older versions", async t => {
  const h = harness(t, { detail: existing({ appId: "app-removed", linkId: "risk-removed" }) }); await settle();
  h.button("Existing synthetic evidence").click(); await settle(); const form = h.form("Save new version"); file(form); submit(form); await settle();
  const meta = JSON.parse(decodeURIComponent(mutations(h)[0].init.headers["X-Document-Metadata"]));
  assert.equal(meta.documentId, ID); assert.equal(meta.expectedRevision, 1); assert.equal(meta.metadata, undefined);
  assert.equal(h.saved().document.linkId, "risk-removed"); assert.equal(h.saved().versions.length, 2);
  assert.ok(h.container.textContent.includes("SHA-256: " + "2".repeat(64))); assert.ok(h.container.textContent.includes("1".repeat(64)));
});

test("only one document draft can be edited and discard restores saved selections rather than browser defaults", async t => {
  const h = harness(t, { detail: existing() }); await settle(); h.button("Existing synthetic evidence").click(); await settle();
  const form = h.form("Save metadata"); change(form, "appId", "app-2"); change(form, "owner", "Unsaved owner");
  assert.equal(h.form("Upload document").elements.namedItem("title").disabled, true);
  h.button("Refresh").click(); await settle(); assert.match(h.container.textContent, /unsaved changes/);
  h.button("Discard draft").click(); assert.equal(h.form("Save metadata").elements.namedItem("appId").value, "app-1");
  assert.equal(h.form("Save metadata").elements.namedItem("owner").value, "Synthetic owner"); assert.equal(h.cleanup.isDirty(), false);
  assert.equal(mutations(h).length, 0);
});

test("initial registry read failure blocks metadata writes but leaves explicit refresh available", async t => {
  let fail = true;
  const h = harness(t, { fetch: (url, init, fallback) => fail && url.includes("/administration/snapshot") ? response({ message: "Synthetic unavailable registry" }, 503) : fallback(url, init) }); await settle();
  assert.equal(h.form("Upload document").elements.namedItem("title").disabled, true); assert.equal(h.button("Refresh").disabled, false);
  fail = false; h.button("Refresh").click(); await settle(); assert.equal(h.form("Upload document").elements.namedItem("title").disabled, false);
  assert.equal(mutations(h).length, 0);
});

test("failed upload retains the draft and never claims success or creates a compliance mutation", async t => {
  const h = harness(t, { fetch: (url, init, fallback) => url === API + "/upload" ? response({ message: "Choose an existing risk record." }, 400) : fallback(url, init) }); await settle();
  const form = h.form("Upload document"); change(form, "title", "Draft survives refusal"); file(form); submit(form); await settle();
  assert.equal(h.cleanup.isDirty(), true); assert.equal(form.elements.namedItem("title").value, "Draft survives refusal");
  assert.doesNotMatch(h.container.textContent, /Saved immutable version receipt/); assert.equal(mutations(h).length, 1);
});

test("disposal aborts in-flight requests and prevents late detail responses from replacing the view", async t => {
  let release;
  const h = harness(t, { detail: existing(), fetch: (url, init, fallback) => url === API + "/" + ID ? new Promise(resolve => { release = () => resolve(fallback(url, init)); }) : fallback(url, init) }); await settle();
  h.button("Existing synthetic evidence").click(); await settle(); assert.equal(h.cleanup.isDirty(), true);
  const request = h.requests.at(-1); h.cleanup(); const before = h.container.textContent;
  assert.equal(request.init.signal.aborted, true); release(); await settle(); assert.equal(h.container.textContent, before); assert.equal(h.errors.length, 0);
  assert.equal(h.listeners.has("beforeunload"), false);
});

test("archive and restore preserve evidence and use explicit revision-checked document actions only", async t => {
  const h = harness(t, { detail: existing() }); await settle(); h.button("Existing synthetic evidence").click(); await settle();
  submit(h.form("Archive document")); await settle(); assert.equal(h.saved().document.archivedAt, AT); assert.equal(h.saved().versions.length, 1);
  submit(h.form("Restore document")); await settle(); assert.equal(h.saved().document.archivedAt, null);
  assert.deepEqual(mutations(h).map(item => item.url), [API + "/" + ID + "/archive", API + "/" + ID + "/restore"]);
});
