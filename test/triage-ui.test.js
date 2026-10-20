"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.nodeType = 1; this.childNodes = []; this.parentNode = null;
    this.attributes = {}; this.listeners = new Map(); this._text = ""; this._value = ""; this.checked = false;
    this.hidden = false; this.disabled = false; this.indeterminate = false; this.style = {};
    this.dataset = new Proxy({}, { set: (o, k, v) => { o[k] = String(v); this.attributes["data-" + k.replace(/[A-Z]/g, m => "-" + m.toLowerCase())] = String(v); return true; } });
    this.classList = { contains: name => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(" "); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(" "); },
      toggle: (name, force) => { const next = force === undefined ? !this.classList.contains(name) : force; this.classList[next ? "add" : "remove"](name); return next; } };
  }
  get parentElement() { return this.parentNode; }
  get lastChild() { return this.childNodes.at(-1) || null; }
  get className() { return this.attributes.class || ""; } set className(value) { this.attributes.class = String(value); }
  append(...children) { for (const child of children) { if (child.parentNode) child.parentNode.removeChild(child); child.parentNode = this; this.childNodes.push(child); } }
  appendChild(child) { this.append(child); return child; }
  removeChild(child) { this.childNodes = this.childNodes.filter(item => item !== child); child.parentNode = null; return child; }
  remove() { this.parentNode?.removeChild(this); }
  replaceChildren(...children) { for (const child of this.childNodes) child.parentNode = null; this.childNodes = []; this._text = ""; this.append(...children); }
  insertBefore(child, before) { const index = this.childNodes.indexOf(before); if (index < 0) this.append(child); else { child.parentNode = this; this.childNodes.splice(index, 0, child); } }
  get value() { if (this.tagName !== "SELECT") return this._value; const opts = this.childNodes.filter(child => child.tagName === "OPTION"); return opts.some(item => item.value === this._value) ? this._value : opts[0]?.value || ""; }
  set value(value) { this._value = String(value); }
  setAttribute(key, value) {
    this.attributes[key] = String(value);
    if (key.startsWith("data-")) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value);
    else if (["name", "type", "id", "href", "title", "role"].includes(key)) this[key] = String(value);
    else if (key === "hidden") this.hidden = true;
    else if (key === "disabled") this.disabled = true;
  }
  getAttribute(key) { return Object.hasOwn(this.attributes, key) ? this.attributes[key] : null; }
  removeAttribute(key) { delete this.attributes[key]; if (key === "hidden") this.hidden = false; if (key === "disabled") this.disabled = false; }
  addEventListener(key, fn) { const fns = this.listeners.get(key) || []; fns.push(fn); this.listeners.set(key, fns); }
  removeEventListener(key, fn) { this.listeners.set(key, (this.listeners.get(key) || []).filter(item => item !== fn)); }
  dispatchEvent(event) { event.preventDefault ||= () => { event.defaultPrevented = true; }; event.target ||= this; event.currentTarget = this; for (const fn of this.listeners.get(event.type) || []) fn(event); if (event.bubbles && this.parentNode) this.parentNode.dispatchEvent(event); }
  click() { if (!this.disabled) this.dispatchEvent({ type: "click", bubbles: true }); }
  matches(selector) {
    return selector.split(",").some(value => {
      const part = value.trim(); if (!part) return false;
      const tag = /^[A-Za-z][\w-]*/.exec(part);
      if (tag && this.tagName !== tag[0].toUpperCase()) return false;
      for (const match of part.matchAll(/\.([\w-]+)/g)) if (!this.classList.contains(match[1])) return false;
      for (const match of part.matchAll(/\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]/g)) {
        const actual = this.getAttribute(match[1]) ?? this[match[1]];
        if (match[2] === undefined ? actual === undefined || actual === null : String(actual) !== match[2]) return false;
      }
      return true;
    });
  }
  closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector) || null; }
  querySelectorAll(selector) { const result = []; for (const child of this.childNodes) { if (child.matches(selector)) result.push(child); result.push(...child.querySelectorAll(selector)); } return result; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  get textContent() { return this._text + this.childNodes.map(child => child.textContent).join(""); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  contains(node) { return node === this || this.childNodes.some(child => child.contains(node)); }
  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; }
  scrollIntoView() {}
}
const response = (value, status = 200) => new Response(JSON.stringify(value?.schemaVersion === "1" ? {viewerId:"a".repeat(64),...value} : value), { status, headers: { "content-type": "application/json" } });
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(setImmediate); };
const classes = (node, name) => node.querySelectorAll("*").filter(item => item.classList.contains(name));
function change(node, value) { node.value = value; node.dispatchEvent({ type: "input", bubbles: true }); node.dispatchEvent({ type: "change", bubbles: true }); }

function fixtureData() {
  const alert = (key, recordId, extra = {}) => ({ key, evidenceVersion: Buffer.from(key).toString("hex").padEnd(64,"0"), recordId, sourceId: "source-one", title: "Synthetic " + recordId,
    observedAt: "2030-01-02T03:04:05.000Z", severity: "medium", rule: "synthetic-rule", asset: "synthetic-asset",
    summary: "Synthetic retained evidence", reportedState: "closed", decision: { revision: 0, state: "open", category: "unclassified", owner: "", note: "" },
    proposal: null, group: null, ...extra });
  return { schemaVersion: "1", appId: "app-one", viewerId: "a".repeat(64), asOf: "2030-01-02T03:04:05.000Z",
    counts: { all: 10, queue: 7, approvals: 2, cases: 0, closed: 1 }, filteredCount: 10, groupCount: 9,
    page: { limit: 3, offset: 0, total: 10, hasMore: true, nextOffset: 3 },
    alerts: [
      alert("key_one", "member-one", { group: { id: "group-one", label: "Synthetic grouped case" },
        proposal: { revision: 1, status: "pending", state: "resolved", category: "benign", note: "Synthetic recommendation", authorLabel: "Synthetic analyst" } }),
      alert("key_two", "member-two", { group: { id: "group-one", label: "Synthetic grouped case" }, severity: "critical",
        decision: { revision: 2, state: "investigating", category: "real-threat", owner: "Synthetic reviewer" } }),
      alert("key_single", "singleton")
    ],
    groups: [{ id: "group-one", label: "Synthetic grouped case", shownCount: 2, matchedCount: 4, totalMembers: 5, hasCritical: true }] };
}
function inspectionFixture(data,key) {
  const alert=data.alerts.find(item=>item.key===key), base={schemaVersion:"1",appId:data.appId,key,evidenceVersion:alert.evidenceVersion};
  return {...base,viewerId:data.viewerId,alert,caseContext:null,
    evidence:{...base,scope:"exact-retained-admission",provenance:{sourceId:alert.sourceId,recordId:alert.recordId,admissionId:1,receivedAt:alert.observedAt,bodyHash:"b".repeat(64)},
      record:{schemaVersion:"1",kind:"finding",appId:data.appId,sourceId:alert.sourceId,recordId:alert.recordId,observedAt:alert.observedAt,payload:{title:alert.title,summary:alert.summary,severity:alert.severity}},
      complete:true,clipped:false,omittedPaths:[],originalBytes:500,returnedBytes:500,maxRecordBytes:48000,fullRecordAvailable:true},
    history:{...base,scope:"exact-admission-local-workflow",complete:true,notices:[],retention:{canonicalEvidence:"retained",localHistory:"retained-no-automatic-eviction",priorIncarnations:"excluded",legacyApprovalOutcomes:"not-applicable"},
      events:[],page:{limit:30,total:0,highWater:0,hasOlder:false,hasNewer:false,olderCursor:null,newerCursor:null},maxBytes:524288}};
}
function savedOperation(extra = {}) {
  return { id: "approval_synthetic", appId: "app-one", status: "preview", revision: 0, snapshotAt: "2030-01-02T03:04:05.000Z",
    scope: "selected", filters: { view: "all" }, total: 2, eligible: 2, excluded: { critical: 0, notPending: 0, unavailable: 0 },
    approved: 0, skipped: 0, remaining: 2, byOutcome: { approved: 0, changed: 0 }, canResume: true,
    proposedOutcomes: [{ state: "resolved", category: "benign", count: 2 }], sources: [{ sourceId: "source-one", count: 2 }], ...extra };
}
function harness(t, options = {}) {
  const requests = [], errors = [], contexts = [], timers = new Map(); let serial = 0;
  const data = options.data || fixtureData();
  const container = new Element("main"), document = new Element("document");
  document.createElement = tag => { const element = new Element(tag); element.ownerDocument = document; return element; };
  container.ownerDocument = document; document.append(container);
  const fallback = (url, init) => {
    const u = new URL(url, "http://localhost");
    if (u.pathname.endsWith("/control/snapshot")) return response({ schemaVersion: "1", apps: [{ appId: "app-one", displayName: "Synthetic application" }] });
    if (u.pathname.endsWith("/approvals/preview")) return response({ schemaVersion: "1", operation: savedOperation() });
    if (u.pathname.endsWith("/items")) return response({ schemaVersion: "1", operationId: "approval_synthetic", items: [{ key: "key_one", recordId: "member-one", sourceId: "source-one", state: "resolved", category: "benign", outcome: "pending" }, { key: "key_two", recordId: "member-two", sourceId: "source-one", state: "resolved", category: "benign", outcome: "pending" }], page: { offset: 0, limit: 100, total: 2, hasMore: false, nextOffset: null } });
    if (u.pathname.endsWith("/step")) return response({ schemaVersion: "1", operation: savedOperation({ status: "completed", revision: 1, approved: 2, remaining: 0, canResume: false }) });
    if (/\/approvals\//.test(u.pathname)) return response({ schemaVersion: "1", operation: savedOperation() });
    if (/\/alert\/(inspection|evidence|history)$/.test(u.pathname)) {
      const value = inspectionFixture(data,u.searchParams.get("key"));
      return response(u.pathname.endsWith("/inspection") ? value : {...value[u.pathname.endsWith("/evidence") ? "evidence" : "history"],viewerId:data.viewerId});
    }
    if (u.pathname.endsWith("/alert")) return response({ schemaVersion: "1", alert: data.alerts.find(alert => alert.key === u.searchParams.get("key")) });
    if (init.method === "POST") return response({ schemaVersion: "1", alert: data.alerts[0] });
    return response({...data,appId:u.searchParams.get("appId") || data.appId});
  };
  const location = { hash: "#/triage?appId=app-one" };
  const context = vm.createContext({ AbortController, TextEncoder, TextDecoder, URL, URLSearchParams, Intl, Uint8Array,
    SOC_PRIVATE_APPLICATION: options.private !== false, document, location,
    history: { state: null, replaceState: (_, unused, url) => { location.hash = url; } },
    crypto: { randomUUID: () => "synthetic-request-" + ++serial }, confirm: options.confirm || (() => true),
    setTimeout: (fn, ms) => { const id = ++serial; if (ms < 100) timers.set(id, setImmediate(fn)); return id; },
    clearTimeout: id => { if (timers.has(id)) clearImmediate(timers.get(id)); timers.delete(id); },
    fetch: async (url, init) => {
      requests.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
      return options.fetch ? options.fetch(url, init, fallback) : fallback(url, init);
    }
  }); context.window = context;
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "public/triage.js"), "utf8"), context);
  let cleanup;
  const render = (extra = {}) => {
    cleanup?.(); cleanup = context.SocTriage.render({ container, appId: "app-one",
      applications: [{ appId: "app-one", displayName: "Synthetic application" }, { appId: "app-two", displayName: "Other synthetic application" }],
      scopeLoaded: true, query: { view: "all", tz: "UTC", ...options.query }, onError: error => errors.push(error),
      onContext: value => contexts.push(value), getPageFilter: options.getPageFilter || (() => ""), ...extra });
    return cleanup;
  };
  render();
  t.after(() => { cleanup?.(); timers.forEach(clearImmediate); });
  return { container, context, data, requests, errors, contexts, location, render, get cleanup() { return cleanup; },
    action: name => container.querySelector('[data-action="' + name + '"]'),
    rows: () => classes(container, "st-alert-row").filter(node => node.tagName === "TR"),
    group: () => classes(container, "st-group")[0], header: () => classes(container, "st-group-header")[0],
    selected: () => classes(container, "st-selection")[0]?.textContent || "",
    field: name => container.querySelector('[name="' + name + '"]') };
}
function toggle(box, checked) { box.checked = checked; box.dispatchEvent({ type: "change", bubbles: true }); }

test("static native Triage stays data-free and does not request or offer private mutations", async t => {
  const h = harness(t, { private: false }); await h.cleanup.ready;
  assert.equal(h.requests.length, 0); assert.match(h.container.textContent, /preview has no private Triage service/);
  assert.equal(h.container.querySelectorAll("form").length, 0); assert.equal(h.action("approve"), null);
});

test("mixed singleton and partial group have exact actionable members, honest counts and textual state/severity", async t => {
  const h = harness(t); await h.cleanup.ready;
  const header = h.header(), rows = h.rows();
  assert.equal(rows.length, 3); assert.equal(new Set(rows.map(row => row.dataset.alertKey)).size, 3);
  assert.equal(header.querySelectorAll('[data-action="review-alert"]').length, 0, "aggregate heading has no per-alert decision");
  assert.equal(header.querySelectorAll("form").length, 0);
  assert.match(header.textContent, /2 shown \/ 4 matching \/ 5 stored members/);
  assert.match(h.container.textContent, /10 matching alerts/);
  assert.match(h.container.textContent, /9 display groups/);
  assert.match(rows[0].textContent, /awaiting approval.*Current: open.*Proposed: resolved/);
  assert.match(rows[1].textContent, /critical.*investigating/);
  assert.ok(rows.slice(0, 2).every(row => row.hidden)); assert.equal(rows[2].hidden, false);
  h.action("toggle-group").click(); await settle();
  assert.ok(h.rows().every(row => !row.hidden));
  assert.equal(h.contexts.at(-1).expand, "group-one"); assert.equal(h.contexts.at(-1).tz, "UTC");
  assert.equal(h.rows().flatMap(row => row.querySelectorAll('[data-action="review-alert"]')).length, 3);
  h.action("toggle-group").click(); await settle(); assert.ok(h.rows().slice(0, 2).every(row => row.hidden));
  assert.match(header.textContent, /member-one/); assert.match(header.textContent, /open/, "folded search has actual current workflow");
});

test("overlapping group/member selection deduplicates exact keys and partial header is indeterminate", async t => {
  const h = harness(t); await h.cleanup.ready;
  const headerBox = h.header().querySelector("input"), child = h.rows()[0].querySelector("input");
  toggle(child, true); assert.equal(headerBox.indeterminate, true); assert.match(h.selected(), /^1 selected alerts/);
  toggle(headerBox, true); assert.equal(headerBox.checked, true); assert.match(h.selected(), /^2 selected alerts/);
  toggle(child, false); assert.equal(headerBox.indeterminate, true); assert.match(h.selected(), /^1 selected alerts/);
  toggle(child, true); h.action("preview-selected").click(); await settle();
  const sent = h.requests.find(item => item.url.endsWith("/approvals/preview"));
  assert.deepEqual(new Set(sent.body.keys), new Set(["key_one", "key_two"]));
  assert.equal(sent.body.keys.length, 2); assert.equal(h.requests.filter(item => /\/step$/.test(item.url)).length, 0);
  assert.match(h.container.textContent, /Review before approving/);
});

test("page search excludes hidden groups and hidden ancestors from select-shown and all-matching actions", async t => {
  let search = ""; const h = harness(t, { getPageFilter: () => search }); await h.cleanup.ready;
  h.group().hidden = true; search = "synthetic"; h.cleanup.filterChanged();
  h.action("select-page").click(); assert.match(h.selected(), /^1 selected alerts/);
  assert.equal(h.action("preview-matching").disabled, true);
  h.action("clear-selection").click(); h.container.hidden = true; h.cleanup.filterChanged();
  h.action("select-page").click(); assert.match(h.selected(), /^0 selected alerts/);
});

test("selection scope preserves pagination, expansion and timezone but isolates changed applications and filters", async t => {
  const h = harness(t, { query: { offset: "0", approval: "approval_synthetic" } }); await h.cleanup.ready;
  toggle(h.rows()[0].querySelector("input"), true);
  await h.render({ query: { view: "all", tz: "America/Los_Angeles", offset: "3", expand: "group-one" } }).ready;
  assert.match(h.selected(), /^1 selected alerts/);
  await h.render({ query: { view: "all", rule: "different-rule", tz: "UTC" } }).ready;
  assert.match(h.selected(), /^0 selected alerts/);
  await h.render({ appId: "app-two", query: { view: "all", tz: "UTC" } }).ready;
  assert.match(h.selected(), /^0 selected alerts/);
  const api = h.context.SocTriage;
  const link = new URL(api.contextUrl({ appId: "app-one", view: "approvals", sourceId: "source-one", rule: "synthetic-rule", tz: "UTC", approval: "saved" }, { expand: "group-one" }).slice(1), "http://localhost");
  assert.equal(link.searchParams.get("approval"), "saved"); assert.equal(link.searchParams.get("sourceId"), "source-one");
  assert.equal(link.searchParams.get("tz"), "UTC"); assert.equal(link.searchParams.get("expand"), "group-one");
});

test("application and filter controls clear stale descendant/operation context while keeping explicit timezone", async t => {
  const h = harness(t, { query: { sourceId: "source-one", rule: "synthetic-rule", expand: "group-one", alert: "key_one", approval: "approval_synthetic", offset: "3", tz: "UTC" } });
  await h.cleanup.ready;
  change(h.field("appId"), "app-two"); await settle();
  const url = new URL(h.location.hash.replace(/^#/, ""), "http://localhost");
  assert.equal(url.searchParams.get("appId"), "app-two"); assert.equal(url.searchParams.get("tz"), "UTC");
  for (const key of ["sourceId", "rule", "expand", "alert", "approval", "offset"]) assert.equal(url.searchParams.has(key), false, key);
});

test("restoring a saved approval retrieves evidence without silently continuing any step", async t => {
  const h = harness(t, { query: { approval: "approval_synthetic" }, fetch: (url, init, fallback) =>
    /\/approvals\/approval_synthetic(?:\?|$)/.test(url) ? response({ schemaVersion: "1", operation: savedOperation({ status: "running", revision: 1, approved: 1, remaining: 1 }) }) : fallback(url, init) });
  await h.cleanup.ready;
  assert.ok(h.requests.every(item => item.init.method === "GET"));
  assert.match(h.container.textContent, /Approval run paused/); assert.ok(h.action("resume"));
  assert.match(h.container.textContent, /1 approved.*1 remaining/);
});

test("explicit confirmed batch can pause in flight, then resume using only the saved revision", async t => {
  let release, steps = 0;
  const h = harness(t, { query: { approval: "approval_synthetic" }, fetch: (url, init, fallback) => {
    if (!url.endsWith("/step")) return fallback(url, init);
    steps++;
    if (steps === 1) return new Promise(resolve => { release = () => resolve(response({ schemaVersion: "1", operation: savedOperation({ status: "running", revision: 1, approved: 1, remaining: 1 }) })); });
    return response({ schemaVersion: "1", operation: savedOperation({ status: "completed", revision: 2, approved: 2, remaining: 0, canResume: false }) });
  } });
  await h.cleanup.ready; h.action("approve").click(); await settle(); assert.equal(steps, 1);
  h.action("pause").click(); release(); await settle();
  assert.equal(steps, 1); assert.match(h.container.textContent, /Approval run paused/);
  h.action("resume").click(); await settle(); assert.equal(steps, 2);
  assert.deepEqual(h.requests.filter(item => item.url.endsWith("/step")).map(item => item.body.revision), [0, 1]);
  assert.match(h.container.textContent, /Approval run completed/);
});

test("uncertain step response remains paused until a read reconciles actual saved progress", async t => {
  let failed = false;
  const h = harness(t, { query: { approval: "approval_synthetic" }, fetch: (url, init, fallback) => {
    if (url.endsWith("/step")) { failed = true; return response({ code: "unavailable", message: "Synthetic response uncertainty" }, 503); }
    if (failed && /\/approvals\/approval_synthetic(?:\?|$)/.test(url)) return response({ schemaVersion: "1", operation: savedOperation({ status: "completed", revision: 1, approved: 2, remaining: 0, canResume: false }) });
    return fallback(url, init);
  } });
  await h.cleanup.ready; h.action("approve").click(); await settle();
  assert.match(h.container.textContent, /Run paused/); assert.match(h.container.textContent, /0 approved/);
  h.action("refresh-operation").click(); await settle();
  assert.match(h.container.textContent, /2 approved/);
  assert.equal(h.requests.filter(item => item.url.endsWith("/step")).length, 1);
});

test("per-alert form retries identical immutable intent after a failed response with actor omitted", async t => {
  let attempt = 0;
  const h = harness(t, { fetch: (url, init, fallback) => url.endsWith("/proposals") && ++attempt === 1 ?
    response({ code: "unavailable", message: "Synthetic save uncertainty" }, 503) : fallback(url, init) });
  await h.cleanup.ready; h.action("review-alert").click(); await settle();
  const form = h.container.querySelectorAll("form").find(node => node.textContent.includes("Save proposal"));
  assert.ok(form); change(form.querySelector('[name="note"]'), "Synthetic reviewed evidence");
  form.dispatchEvent({ type: "submit" }); await settle();
  assert.equal(form.querySelector("fieldset").disabled, true);
  assert.match(form.textContent, /Retry same submission/);
  form.dispatchEvent({ type: "submit" }); await settle();
  const sent = h.requests.filter(item => item.url.endsWith("/proposals"));
  assert.equal(sent.length, 2); assert.deepEqual(sent[0].body, sent[1].body); assert.equal(sent[0].body.actor, undefined);
  assert.equal(sent[0].body.key, "key_one"); assert.equal(sent[0].body.expectedRevision, 1);
});

test("malformed list counts stay unavailable rather than fabricating an empty healthy board", async t => {
  const malformed = fixtureData(); delete malformed.counts.closed;
  const h = harness(t, { data: malformed }); await h.cleanup.ready;
  assert.match(h.container.textContent, /Triage unavailable.*incomplete counts/);
  assert.equal(h.action("preview-matching"), null); assert.equal(h.rows().length, 0);
});

test("lost preview response retries exact frozen membership and idempotency rather than preparing a new operation", async t => {
  let attempts = 0;
  const h = harness(t, { fetch: (url, init, fallback) => {
    if (url.endsWith("/approvals/preview") && ++attempts === 1) return response({ code: "unavailable", message: "Synthetic preview response lost" }, 503);
    return fallback(url, init);
  } });
  await h.cleanup.ready; toggle(h.rows()[0].querySelector("input"), true);
  h.action("preview-selected").click(); await settle();
  assert.match(h.container.textContent, /Review could not be prepared/);
  assert.equal(h.action("approve"), null);
  h.action("retry-preview").click(); await settle();
  const previews = h.requests.filter(item => item.url.endsWith("/approvals/preview"));
  assert.equal(previews.length, 2); assert.deepEqual(previews[0].body, previews[1].body);
  assert.equal(h.requests.filter(item => item.url.endsWith("/step")).length, 0);
  assert.equal(h.action("approve").disabled, false);
});

test("unavailable frozen membership disables approval and keeps failed inspection explicit", async t => {
  const h = harness(t, { query: { approval: "approval_synthetic" }, fetch: (url, init, fallback) =>
    /\/items\?/.test(url) ? response({ code: "unavailable", message: "Synthetic membership unavailable" }, 503) : fallback(url, init) });
  await h.cleanup.ready;
  assert.match(h.container.textContent, /Synthetic membership unavailable.*No membership has been assumed/);
  assert.equal(h.action("approve").disabled, true);
  h.action("approve").click(); await settle();
  assert.equal(h.requests.filter(item => item.url.endsWith("/step")).length, 0);
  assert.ok(h.action("retry-items"));
});

const tab = (h,name) => h.container.querySelector('[id=triage-tab-' + name + ']');
const proposalForm = h => h.container.querySelectorAll("form").find(form => form.textContent.includes("Save proposal"));
const navigateAlert = (h,key,extra={}) => h.cleanup.navigateLocal({path:"/triage",query:new URLSearchParams({appId:"app-one",view:"all",tz:"UTC",alert:key,version:h.data.alerts.find(a=>a.key===key).evidenceVersion,...extra})});

test("retained inspector uses one aggregate read and zero reads or form replacement across keyboard tabs", async t => {
  const h=harness(t); await h.cleanup.ready;
  toggle(h.rows()[0].querySelector("input"),true);
  h.action("review-alert").click(); await settle();
  assert.equal(h.requests.filter(r=>r.url.includes("/alert/inspection?")).length,1);
  assert.equal(h.requests.filter(r=>/\/alert\/(evidence|history)\?/.test(r.url)).length,0);
  const form=proposalForm(h), note=form.querySelector('[name=note]'), before=h.requests.length;
  assert.equal(h.cleanup.isDirty(),false);
  change(note,"Unsaved retained draft");
  tab(h,"evidence").click(); await settle();
  assert.equal(h.container.querySelector("[id=triage-pane-evidence]").hidden,false);
  tab(h,"evidence").dispatchEvent({type:"keydown",key:"ArrowRight"}); await settle();
  assert.equal(tab(h,"history").getAttribute("aria-selected"),"true");
  assert.equal(h.context.document.activeElement,tab(h,"history"));
  tab(h,"summary").click(); await settle();
  assert.equal(proposalForm(h),form); assert.equal(note.value,"Unsaved retained draft");
  assert.equal(h.requests.length,before); assert.match(h.selected(),/^1 selected alerts/);
  assert.equal(h.container.querySelector("thead").querySelectorAll("th").length,5);
  assert.ok(classes(h.container,"st-evidence-row").every(row=>row.querySelector("input")===null));
});

test("canceling cross-alert discard keeps exact inspector and sends no read or write", async t => {
  const h=harness(t,{confirm:()=>false});await h.cleanup.ready;await navigateAlert(h,"key_one");
  const form=proposalForm(h);change(form.querySelector("[name=note]"),"Keep this draft");
  const before=h.requests.length;
  assert.equal(await navigateAlert(h,"key_two"),false);
  assert.equal(proposalForm(h),form);assert.equal(h.requests.length,before);
});

test("cross-form discard cancellation prevents POST and accepted discard resets only the other draft", async t => {
  let accept=false;const h=harness(t,{confirm:()=>accept});await h.cleanup.ready;await navigateAlert(h,"key_one");
  const form=proposalForm(h), decision=h.container.querySelectorAll("form").find(f=>f.textContent.includes("Save human decision"));
  const note=form.querySelector("[name=note]");change(note,"Unsaved proposal");
  change(decision.querySelector("[name=note]"),"Reviewed decision");
  decision.dispatchEvent({type:"submit"});await settle();
  assert.equal(h.requests.filter(r=>r.init.method==="POST").length,0);assert.equal(note.value,"Unsaved proposal");
  accept=true;decision.dispatchEvent({type:"submit"});await settle();
  assert.equal(h.requests.filter(r=>r.url.endsWith("/decisions")).length,1);
});

test("failed and mismatched-session inspection retain previous DOM and URL context", async t => {
  let mode="okay";const h=harness(t,{fetch:(url,init,fallback)=>{
    if(url.includes("/alert/inspection?")&&mode!=="okay") {
      if(mode==="fail")return response({message:"Synthetic read failure"},503);
      const value=inspectionFixture(fixtureData(),new URL(url,"http://localhost").searchParams.get("key"));value.viewerId="f".repeat(64);return response(value);
    }return fallback(url,init);
  }});await h.cleanup.ready;await navigateAlert(h,"key_one");
  const form=proposalForm(h);
  mode="fail";assert.equal(await navigateAlert(h,"key_two"),false);assert.equal(proposalForm(h),form);
  mode="session";assert.equal(await navigateAlert(h,"key_two"),false);assert.equal(proposalForm(h),form);
  assert.match(h.container.textContent,/signed-in session changed/);
  assert.equal(h.requests.filter(r=>r.init.method==="POST").length,0);
});

test("out-of-order inspection and edits during reads cannot replace the newest retained panel", async t => {
  const pending=[];let defer=false;
  const h=harness(t,{fetch:(url,init,fallback)=>defer&&url.includes("/alert/inspection?")?new Promise(resolve=>pending.push(()=>resolve(fallback(url,init)))):fallback(url,init)});
  await h.cleanup.ready;await navigateAlert(h,"key_one");defer=true;
  const first=navigateAlert(h,"key_two");await settle();
  const second=navigateAlert(h,"key_single");await settle();
  pending[1]();assert.equal(await second,true);const latest=proposalForm(h);
  pending[0]();assert.equal(await first,false);assert.equal(proposalForm(h),latest);
  const third=navigateAlert(h,"key_two");await settle();
  change(latest.querySelector("[name=note]"),"Edit during pending read");
  pending[2]();assert.equal(await third,false);assert.equal(proposalForm(h),latest);
  assert.equal(latest.querySelector("[name=note]").value,"Edit during pending read");
});

test("uncertain mutation blocks target navigation but permits retained tabs and cleanup never aborts a submitted POST", async t => {
  let release,writeSignal;
  const h=harness(t,{fetch:(url,init,fallback)=>{if(url.endsWith("/proposals")) {writeSignal=init.signal;return new Promise(resolve=>release=()=>resolve(response({message:"Lost response"},503)));}return fallback(url,init);}});
  await h.cleanup.ready;await navigateAlert(h,"key_one");
  const form=proposalForm(h);change(form.querySelector("[name=note]"),"Frozen intent");form.dispatchEvent({type:"submit"});await settle();
  assert.equal(h.cleanup.isPending(),true);assert.equal(await navigateAlert(h,"key_two"),false);
  tab(h,"history").click();await settle();assert.equal(tab(h,"history").getAttribute("aria-selected"),"true");
  h.cleanup.cancelReads();assert.equal(writeSignal.aborted,false);
  release();await settle();assert.equal(h.cleanup.isPending(),true);
  assert.equal(await navigateAlert(h,"key_two"),false);h.cleanup();assert.equal(writeSignal.aborted,false);
});

test("history refresh keeps Summary draft mounted and only newest section read may commit", async t => {
  let defer=false;const pending=[];
  const h=harness(t,{fetch:(url,init,fallback)=>defer&&url.includes("/alert/history?")?new Promise(resolve=>pending.push(n=>{const v=inspectionFixture(fixtureData(),"key_one").history;v.page.highWater=n;resolve(response({...v,viewerId:fixtureData().viewerId}));})):fallback(url,init)});
  await h.cleanup.ready;await navigateAlert(h,"key_one");
  const form=proposalForm(h),note=form.querySelector("[name=note]");change(note,"Preserved through history");
  defer=true;h.action("history-refresh").click();h.action("history-refresh").click();await settle();
  pending[1](22);await settle();pending[0](11);await settle();
  assert.match(h.container.querySelector("[id=triage-pane-history]").textContent,/high-water sequence 22/);
  assert.equal(proposalForm(h),form);assert.equal(note.value,"Preserved through history");
});

test("direct investigation href preserves exact version and safe queue context with native modified clicks", async t => {
  const h=harness(t,{query:{sourceId:"source-one",expand:"group-one",approval:"approval_synthetic"}});await h.cleanup.ready;
  const link=h.action("open-investigation"),u=new URL(link.href.slice(1),"http://localhost");
  assert.equal(u.searchParams.get("mode"),"investigation");assert.equal(u.searchParams.get("version"),h.data.alerts[0].evidenceVersion);
  const back=new URL(u.searchParams.get("return").slice(1),"http://localhost");
  assert.equal(back.searchParams.get("approval"),"approval_synthetic");assert.equal(back.searchParams.get("expand"),"group-one");
  const event={type:"click",ctrlKey:true};const before=h.requests.length;link.dispatchEvent(event);await settle();
  assert.equal(Boolean(event.defaultPrevented),false);assert.equal(h.requests.length,before);
  link.click();await settle();assert.equal(classes(h.container,"st-queue")[0].hidden,true);
  assert.equal(h.container.querySelector("h1").textContent,"Alert investigation");
  h.action("return-to-queue").click();await settle();assert.equal(classes(h.container,"st-queue")[0].hidden,false);
  for(const bad of ["https://example.invalid","#/triage?appId=other","#/triage?appId=app-one&mode=investigation","#/triage?appId=app-one&unknown=x"])assert.equal(h.context.SocTriage.safeReturn(bad,"app-one"),null);
});

test("filter and pagination changes retain selected inspector, operation and timezone with explicit outside-page notice", async t=>{
  let omit=false;const h=harness(t,{fetch:(url,init,fallback)=>{if(omit&&new URL(url,"http://localhost").pathname==="/api/v1/triage"){const data=fixtureData();data.alerts=data.alerts.slice(1);return response(data);}return fallback(url,init);}});
  await h.cleanup.ready;await navigateAlert(h,"key_one");const form=proposalForm(h);change(form.querySelector("[name=note]"),"Draft across pages");
  omit=true;const before=h.requests.filter(r=>r.url.includes("/alert/inspection?")).length;
  assert.equal(await navigateAlert(h,"key_one",{offset:"3",approval:"approval_synthetic",tz:"America/Los_Angeles"}),true);
  assert.equal(proposalForm(h),form);assert.equal(h.requests.filter(r=>r.url.includes("/alert/inspection?")).length,before);
  assert.match(h.container.textContent,/outside the current filters or page/);
});

test("repeated mounts remove owned keyboard handlers and Escape respects an open dialog",async t=>{
  const h=harness(t);await h.cleanup.ready;
  assert.equal(h.context.document.listeners.get("keydown").length,1);
  await h.render().ready;assert.equal(h.context.document.listeners.get("keydown").length,1);
  await navigateAlert(h,"key_one");
  const dialog=h.context.document.createElement("dialog");dialog.setAttribute("open","");h.container.append(dialog);
  const e={type:"keydown",key:"Escape"};h.context.document.dispatchEvent(e);await settle();assert.equal(Boolean(e.defaultPrevented),false);
  h.cleanup();assert.equal(h.context.document.listeners.get("keydown").length,0);
});

test("local timezone changes reformat existing timestamps while retaining dirty input identity",async t=>{
  const h=harness(t);await h.cleanup.ready;await navigateAlert(h,"key_one");const form=proposalForm(h);
  change(form.querySelector("[name=note]"),"Timezone draft");
  const time=h.container.querySelector("[id=triage-pane-summary]").querySelector("time"),before=time.textContent;
  assert.equal(await navigateAlert(h,"key_one",{tz:"America/Los_Angeles"}),true);
  assert.equal(proposalForm(h),form);assert.notEqual(time.textContent,before);assert.match(time.title,/America\/Los_Angeles/);
});

test("local saved approval restoration validates and replaces context with GETs only",async t=>{
  const h=harness(t);await h.cleanup.ready;await navigateAlert(h,"key_one");
  assert.equal(await navigateAlert(h,"key_one",{approval:"approval_synthetic"}),true);
  assert.ok(h.action("approve"));assert.ok(h.requests.every(r=>r.init.method==="GET"));
  assert.equal(await navigateAlert(h,"key_one"),true);assert.equal(h.action("approve"),null);
});

test("session changes on saved approval reads preserve prior approval and inspector",async t=>{
  let changed=false;const h=harness(t,{fetch:(url,init,fallback)=>changed&&/\/approvals\/approval_synthetic(?:\?|$)/.test(url)?response({schemaVersion:"1",viewerId:"f".repeat(64),operation:savedOperation()}):fallback(url,init)});
  await h.cleanup.ready;await navigateAlert(h,"key_one");const form=proposalForm(h);changed=true;
  assert.equal(await navigateAlert(h,"key_one",{approval:"approval_synthetic"}),false);assert.equal(proposalForm(h),form);assert.equal(h.action("approve"),null);
});

test("real DOM absolute internal href reaches the shared hash router",async t=>{
  const h=harness(t);await h.cleanup.ready;
  const link=h.action("review-alert");link.href="http://localhost/"+link.href;link.click();await settle();
  assert.ok(proposalForm(h));assert.equal(h.requests.filter(r=>r.url.includes("/alert/inspection?")).length,1);
});

test("retained single-alert approval review uses disclosed exact key beyond queue filters",async t=>{
  const h=harness(t,{query:{view:"queue",sourceId:"source-one",rule:"synthetic-rule"}});await h.cleanup.ready;
  h.action("review-alert").click();await settle();h.action("review-proposal").click();await settle();
  const sent=h.requests.find(r=>r.url.endsWith("/approvals/preview"));
  assert.deepEqual(sent.body.filters,{view:"all"});assert.deepEqual(sent.body.keys,["key_one"]);
  assert.equal(h.requests.filter(r=>r.url.endsWith("/step")).length,0);
});

test("revisiting an already selected title restores inspector focus without another read",async t=>{
  const h=harness(t);await h.cleanup.ready;h.action("review-alert").click();await settle();
  const before=h.requests.length,form=proposalForm(h);h.context.document.activeElement=h.action("review-alert");
  h.action("review-alert").click();await settle();
  assert.equal(h.context.document.activeElement.id,"triage-inspector-title");assert.equal(h.requests.length,before);assert.equal(proposalForm(h),form);
});
