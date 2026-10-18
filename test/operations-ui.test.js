"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
class Element {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.nodeType = 1; this.childNodes = []; this.parentNode = null; this.attributes = {}; this.listeners = new Map(); this._value = ""; this._text = ""; this.checked = false; }
  append(...children) { for (const child of children) { if (child.parentNode) child.parentNode.childNodes = child.parentNode.childNodes.filter(item => item !== child); child.parentNode = this; this.childNodes.push(child); } }
  replaceChildren(...children) { for (const child of this.childNodes) child.parentNode = null; this.childNodes = []; this._text = ""; this.append(...children); }
  insertBefore(child, before) { const index = this.childNodes.indexOf(before); if (index < 0) this.append(child); else { child.parentNode = this; this.childNodes.splice(index, 0, child); } }
  get value() { if (this.tagName !== "SELECT") return this._value; const opts = this.childNodes.filter(child => child.tagName === "OPTION"); return opts.some(item => item.value === this._value) ? this._value : opts[0]?.value || ""; }
  set value(value) { this._value = String(value); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(key, fn) { const fns = this.listeners.get(key) || []; fns.push(fn); this.listeners.set(key, fns); }
  dispatchEvent(event) { event.preventDefault ||= () => {}; event.target ||= this; for (const fn of this.listeners.get(event.type) || []) fn(event); if (event.bubbles && this.parentNode) this.parentNode.dispatchEvent(event); }
  click() { if (!this.disabled) this.dispatchEvent({ type: "click", bubbles: true }); }
  matches(selector) { return selector.split(",").some(value => { const part = value.trim(), name = /^\[name="([^"]+)"\]$/.exec(part); return name ? this.name === name[1] : this.tagName === part.toUpperCase(); }); }
  querySelectorAll(selector) { const result = []; for (const child of this.childNodes) { if (child.matches(selector)) result.push(child); result.push(...child.querySelectorAll(selector)); } return result; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  get textContent() { return this._text + this.childNodes.map(child => child.textContent).join(""); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
}
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(setImmediate); };
const AT = Date.parse("2026-10-18T12:00:00Z"), WINDOW = { range: "custom", from: String(AT - 3600000), to: String(AT), tz: "UTC" };
const page = { returned: 1, total: 2, snapshotAt: AT, currentCursor: "cursor_current", nextCursor: "cursor_next", hasNext: true, hasPrevious: false };
function harness(t, options = {}) {
  const requests = [], errors = [], timers = new Set(), confirmations = []; let serial = 0;
  const body = { resources: [{ id: "host-one", label: "Synthetic host", state: "unknown", quality: "unknown", sourceId: "source-one" }], checks: [{ id: "check-one", label: "Synthetic check", host: "host-one", status: "warning", summary: "Synthetic evidence" }], series: [{ id: "metric-one", label: "Synthetic CPU", host: "host-one", unit: "%", intervalSeconds: 60, policy: { warning: 80 } }], jobs: [{ id: "job-one", label: "Synthetic job", host: "host-one", executionState: "succeeded", outputState: "unverified", scheduleState: "unproven" }], employees: [{ id: "employee-one", name: "Synthetic employee", host: "host-one", role: "Reviewer", lastOutput: { summary: "Synthetic report", observedAt: AT, receivedAt: AT }, runs: [] }] };
  const fallback = (url, init) => { const u = new URL(url, "http://localhost"), endpoint = u.pathname.split("/").at(-1); if (u.pathname === "/api/v1/control/snapshot") return response({ apps: [{ appId: "app-one", displayName: "Synthetic app" }] });
    if (init.method === "POST") return response({ ok: true });
    if (endpoint === "resources") return response({ ok: true, at: AT, resources: body.resources });
    if (endpoint === "checks") return response({ ok: true, checks: body.checks });
    if (endpoint === "series") return response({ ok: true, series: body.series });
    if (endpoint === "query") return response({ ok: true, resolution: "raw", series: [{ ...body.series[0], points: [{ at: AT - 300000, value: 45, quality: "good" }, { at: AT - 240000, value: null, quality: "unknown" }, { at: AT - 180000, value: 51, quality: "good" }] }] });
    if (endpoint === "incidents") { const incident = { id: "incident-one", host: "host-one", checkId: "check-one", title: "Synthetic incident", status: "open", revision: "a".repeat(64), lifecycle: { episodeId: "episode-one", generation: 1 }, acknowledgedAt: AT, acknowledgedBy: "synthetic-operator", openedAt: AT, updatedAt: AT }; return response(u.searchParams.has("incidentId") ? { ok: true, incident } : { ok: true, incidents: [incident], page }); }
    if (endpoint === "jobs") return response(u.searchParams.has("history") ? { ok: true, jobId: "job-one", runs: [{ id: "run-one", executionState: "succeeded", startedAt: AT, finishedAt: AT, provenance: "Synthetic execution" }], page } : { ok: true, asOf: AT, jobs: body.jobs });
    if (endpoint === "employees") return response({ ok: true, asOf: AT, employees: body.employees, work: [] });
    if (endpoint === "employee-inbox") return response({ ok: true, available: true, recipients: body.employees, items: [], counts: { messages: 0, pendingAcknowledgments: 0 }, recipientSummary: { "employee-one": { waiting: 2, acknowledged: 1, replies: 1 } } });
    if (endpoint === "websites") return response({ ok: true, websites: [{ id: "endpoint-one", url: "https://example.invalid/", host: "host-one", state: "unknown", statusCode: null, checkId: "check-one" }] });
    if (endpoint === "website-history") return response({ ok: true, coverage: [], series: [] });
    return response({ ok: true, events: [], deliveries: [], dependencies: [] }); };
  const container = new Element("main"), context = vm.createContext({ AbortController, TextEncoder, TextDecoder, URL, URLSearchParams, Blob,
    SOC_PRIVATE_APPLICATION: options.private !== false, document: { createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag) }, location: { hash: "" },
    crypto: { randomUUID: () => "synthetic-key-" + (++serial) }, confirm: message => { confirmations.push(message); return true; },
    setTimeout: () => { const id = ++serial; timers.add(id); return id; }, clearTimeout: id => timers.delete(id),
    fetch: async (url, init) => { requests.push({ url, init, body: init.body ? JSON.parse(init.body) : null }); return options.fetch ? options.fetch(url, init, fallback) : fallback(url, init); }
  }); context.window = context; if (options.width) container.clientWidth = options.width;
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "public/operations.js"), "utf8"), context);
  const cleanup = context.SocOperations.render({ container, route: options.route || "/infrastructure", appId: options.noApp ? undefined : "app-one", applications: options.registry ? [] : options.applications || [{ appId: "app-one", displayName: "Synthetic app" }], displayTimezone: options.displayTimezone, query: new URLSearchParams(options.rawQuery || { ...WINDOW, ...options.query }), onError: error => errors.push(error) }); t.after(cleanup);
  return { container, context, cleanup, requests, errors, timers, body, confirmations, field: name => container.querySelector('[name="' + name + '"]'), link: label => container.querySelectorAll("a").find(item => item.textContent === label), form: title => container.querySelectorAll("form").find(item => item.textContent.startsWith(title)) };
}
function input(form, name, value) { const node = form.querySelector('[name="' + name + '"]'); assert.ok(node, name); node.value = value; node.dispatchEvent({ type: "input", bubbles: true }); }
function submit(form) { form.dispatchEvent({ type: "submit" }); }

test("static Operations boards are data-free and make no private requests", async t => {
  for (const route of ["/infrastructure", "/services", "/websites", "/metrics", "/incidents", "/jobs", "/employees", "/analyst-reports"]) { const h = harness(t, { private: false, route }); await h.cleanup.ready; assert.equal(h.requests.length, 0); assert.match(h.container.textContent, /data-free preview has no monitoring provider/); assert.equal(h.container.querySelectorAll("form").length, 0); }
});
test("private registry fallback selects the sole application and never sends source credentials", async t => {
  const h = harness(t, { registry: true, noApp: true }); await h.cleanup.ready; assert.equal(h.requests[0].url, "/api/v1/control/snapshot?reason=refresh"); assert.match(h.container.textContent, /Synthetic host/);
  assert.ok(h.requests.slice(1).every(item => new URL(item.url, "http://localhost").searchParams.get("appId") === "app-one")); assert.ok(h.requests.every(item => item.init.credentials === "same-origin" && item.init.redirect === "error" && !item.init.headers.Authorization)); assert.equal(h.timers.size, 0);
});
test("all boards render real portable evidence with text-only values", async t => {
  for (const route of ["/infrastructure", "/services", "/websites", "/metrics", "/incidents", "/jobs", "/employees", "/analyst-reports"]) { const h = harness(t, { route, query: { host: "host-one", check: "check-one", job: "job-one", incident: "incident-one", employee: "employee-one", endpoint: "endpoint-one" } }); h.body.resources[0].label = "<img src=x onerror=unsafe>"; await h.cleanup.ready; assert.deepEqual(h.errors, [], route); assert.equal(h.container.querySelectorAll("img").length, 0); assert.ok(h.requests.length > 0); assert.equal(h.timers.size, 0); }
});
test("metric graphs retain unknown gaps and exports preserve provenance and formula safety", async t => {
  const h = harness(t, { route: "/metrics" }); await h.cleanup.ready; const api = h.context.SocOperations;
  assert.equal(h.container.querySelectorAll("svg").length, 1); assert.equal(h.container.querySelectorAll("circle").length, 2); assert.match(h.container.textContent, /Unknown/); assert.match(h.requests.find(item => item.url.includes("/query?")).url, /series=metric-one/);
  const data = api.boundedPoints([{ at: AT - 3, value: 2 }, { at: AT - 2, value: null }, { at: AT - 1, value: 4 }], AT - 100, AT); assert.equal(api.segments(data.points, 10).length, 2);
  const csv = api.chartCsv({ id: "=unsafe()", label: "Synthetic", host: "host-one" }, data.points, { timezone: "UTC" }, "raw", false); assert.match(csv, /"'=unsafe\(\)"/); assert.match(csv, /"unknown"/);
  const bounded = api.boundedPoints(Array.from({ length: 3000 }, (_, i) => ({ at: AT - 3000 + i, value: i === 100 ? null : i })), AT - 3000, AT); assert.ok(bounded.points.length <= 1200); assert.equal(bounded.aggregated, true); assert.ok(bounded.points.some(point => point.value === null)); assert.equal(Math.max(...bounded.points.filter(point => point.value !== null).map(point => point.max)), 2999);
});
test("incident and job history use independent opaque cursors; filter changes reset history", async t => {
  const h = harness(t, { route: "/incidents", query: { incident: "incident-one", incidentCursor: "cursor_input", episodeCursor: "episode_input" } }); await h.cleanup.ready;
  const histories = h.container.querySelectorAll("nav").filter(item => item.attributes["aria-label"]?.endsWith(" pages")); assert.equal(histories.length, 2);
  const listNext = histories[0].querySelectorAll("a").find(item => item.textContent === "Older"); assert.match(listNext.href, /incidentCursor=cursor_next/); assert.doesNotMatch(listNext.href, /episodeCursor|incident=incident-one/);
  const episodeNext = histories[1].querySelectorAll("a").find(item => item.textContent === "Older"); assert.match(episodeNext.href, /incidentCursor=cursor_current/); assert.match(episodeNext.href, /episodeCursor=cursor_next/);
  const filter = h.container.querySelectorAll("form").find(item => item.querySelector('[name="state"]')); input(filter, "state", "all"); submit(filter); assert.doesNotMatch(h.context.location.hash, /Cursor|incident=/);
  const jobs = harness(t, { route: "/jobs", query: { job: "job-one", runCursor: "cursor_input" } }); await jobs.cleanup.ready; assert.match(jobs.link("Older").href, /runCursor=cursor_next/); assert.match(jobs.container.textContent, /Execution history/);
});
test("invalid cursor response is unavailable with explicit Latest, never a silent first page", async t => {
  const h = harness(t, { route: "/incidents", query: { incidentCursor: "stale_cursor" }, fetch: (url, init, fallback) => url.includes("/incidents?") ? response({ private: "not-visible" }, 409) : fallback(url, init) }); await h.cleanup.ready;
  assert.match(h.container.textContent, /history position cannot be used/); assert.doesNotMatch(h.container.textContent, /not-visible/); assert.doesNotMatch(h.link("Latest").href, /incidentCursor/); assert.equal(h.requests.filter(item => item.url.includes("/incidents?")).length, 1);
});
test("incident acknowledgment uses revision and stable idempotency on retry; actor stays server-owned", async t => {
  let attempts = 0; const h = harness(t, { route: "/incidents", query: { incident: "incident-one" }, fetch: (url, init, fallback) => init.method === "POST" && ++attempts === 1 ? response({}, 503) : fallback(url, init) }); await h.cleanup.ready;
  const form = h.form("Acknowledge incident"); input(form, "note", "Synthetic decision"); assert.equal(h.cleanup.isDirty(), true); submit(form); await settle(); submit(form); await settle();
  const sent = h.requests.filter(item => item.init.method === "POST"); assert.equal(sent.length, 2); assert.deepEqual(sent[0].body, sent[1].body); assert.equal(sent[0].body.expectedRevision, "a".repeat(64)); assert.equal(sent[0].body.actor, undefined); assert.equal(h.cleanup.isDirty(), false);
});
test("maintenance posts native numeric minutes and stable retry bodies", async t => {
  const h = harness(t, { route: "/incidents", query: { incident: "incident-one" }, fetch: (url, init, fallback) => init.method === "POST" ? response({}, 503) : fallback(url, init) }); await h.cleanup.ready;
  const form = h.form("Schedule maintenance"); input(form, "reason", "Synthetic planned work"); submit(form); await settle(); submit(form); await settle(); const sent = h.requests.filter(item => item.init.method === "POST"); assert.equal(sent.length, 2); assert.deepEqual(sent[0].body, sent[1].body); assert.equal(sent[0].body.durationMinutes, 60); assert.equal(sent[0].body.startsAt, undefined);
});
test("employee roster and context handoff use configured IDs, with no read-side acknowledgments", async t => {
  const h = harness(t, { route: "/employees", query: { employee: "employee-one", host: "host-one", incident: "incident-one", check: "check-one" } }); await h.cleanup.ready;
  assert.match(h.container.textContent, /Synthetic employee/); const form = h.form("Leave instructions"); assert.equal(form.querySelector('[name="recipient"]').value, "employee-one"); assert.match(form.querySelector('[name="body"]').value, /Incident: incident-one/); assert.match(form.querySelector('[name="body"]').value, /appId=app-one/); assert.ok(h.requests.every(item => item.init.method === "GET"));
  input(form, "title", "Synthetic instructions"); submit(form); await settle(); const sent = h.requests.find(item => item.init.method === "POST"); assert.match(sent.url, /employee-inbox\/create/); assert.equal(sent.body.recipient, "employee-one"); assert.equal(sent.body.actor, undefined);
});
test("unavailable inbox disables mutations and mismatched source context is not invented", async t => {
  const h = harness(t, { route: "/employees", query: { host: "wrong-host", incident: "incident-one" }, fetch: (url, init, fallback) => url.includes("/employee-inbox?") ? response({}, 503) : fallback(url, init) }); await h.cleanup.ready;
  assert.equal(h.form("Leave instructions"), undefined); assert.match(h.container.textContent, /could not be verified/); assert.match(h.container.textContent, /Adding and withdrawing instructions is disabled/); assert.equal(h.requests.filter(item => item.init.method === "POST").length, 0);
});
test("context links preserve interval and app scope but do not leak board cursors to logs", t => {
  const h = harness(t, { private: false }); const api = h.context.SocOperations, q = { ...WINDOW, appId: "app-one", host: "host-one", incidentCursor: "cursor_one", runCursor: "cursor_two" }, w = api.parseWindow(q, AT);
  const url = api.contextUrl("/logs", q, w); assert.match(url, /appId=app-one/); assert.match(url, /from=2026-10-18T/); assert.doesNotMatch(url, /Cursor|range=/); assert.equal(api.parseWindow({ range: "custom", from: "bad", to: "bad" }, AT).range, "24h");
});
test("DOM boards and human mutations integrate with the actual application-scoped SQLite service", async t => {
  const os = require("node:os"), { createOperationsService } = require("../server/operations-service");
  const stateDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "synthetic-operations-ui-"));
  const registry = { VERSION: 1, HOSTS: [{ id: "host-one", sourceId: "source-one", appId: "app-one", label: "Synthetic host", intervalSeconds: 60 }],
    SERIES: [{ id: "metric-one", host: "host-one", label: "Synthetic measurement", unit: "%", min: 0, max: 100, type: "gauge", intervalSeconds: 60 }],
    CHECKS: [{ id: "host-one.collection", host: "host-one", label: "Collection", type: "collection", intervalSeconds: 60, policy: { failCount: 1, recoverCount: 1 } }, { id: "check-one", host: "host-one", label: "Synthetic service", type: "service", intervalSeconds: 60, policy: { failCount: 1, recoverCount: 1 } }] };
  const service = createOperationsService({ stateDir, now: () => AT, minFreeBytes: 0, runtime: { controlState: () => ({ apps: [{ appId: "app-one" }] }) }, config: { schemaVersion: 1, applications: [{ appId: "app-one", registry, employees: [{ id: "employee-one", name: "Synthetic reviewer", role: "Reviewer", host: "host-one", sourceId: "source-one" }], websites: [{ id: "endpoint-one", host: "host-one", label: "Synthetic endpoint", url: "https://example.invalid/" }] }] } });
  t.after(() => { service.close(); fs.rmSync(stateDir, { recursive: true, force: true }); });
  const entry = service.instance("app-one");
  entry.store.ingest("host-one", { schemaVersion: 1, sourceId: "source-one", streamId: "stream-one", sequence: 1, batchId: "batch-one", observedAt: new Date(AT).toISOString(), bootId: "boot-one", monotonicNs: "60000000000", collectorVersion: "synthetic-v1", configRevision: "a".repeat(64), collection: { ok: true, durationMs: 1 }, samples: [{ seriesId: "metric-one", value: 24, quality: "good" }], checks: [{ checkId: "check-one", status: "critical", summary: "Synthetic failed service" }] });
  const appQuery = new URLSearchParams({ appId: "app-one" });
  await service.operator("POST", "jobs", appQuery, { idempotencyKey: "register-job", id: "job-one", host: "host-one", label: "Synthetic expected job", nextDueAt: new Date(AT).toISOString(), intervalSeconds: 60, graceSeconds: 5, maxRuntimeSeconds: 120, progressTimeoutSeconds: 30, observationTimeoutSeconds: 60 }, "operator:synthetic");
  const incident = entry.store.incidents(null, { openOnly: true }).incidents.find(item => item.checkId === "check-one"); assert.ok(incident);
  const fetch = async (url, init) => { try { const u = new URL(url, "http://localhost"), suffix = u.pathname.slice("/api/v1/operations/".length); return response(await service.operator(init.method, suffix, u.searchParams, init.body ? JSON.parse(init.body) : null, "operator:synthetic")); } catch (error) { return response({ error: error.message }, error.status || 500); } };
  for (const route of ["/infrastructure", "/services", "/websites", "/metrics", "/incidents", "/jobs", "/employees", "/analyst-reports"]) {
    const h = harness(t, { route, fetch, query: { host: "host-one", check: "check-one", job: "job-one", incident: incident.id, employee: "employee-one", endpoint: "endpoint-one" } }); await h.cleanup.ready;
    assert.deepEqual(h.errors, [], route); assert.doesNotMatch(h.container.textContent, /response could not|request failed|position cannot be used|could not be completed/, route);
    if (route === "/incidents") { assert.match(h.container.textContent, /Episode occurrences/); const form = h.form("Acknowledge incident"); input(form, "note", "Synthetic review decision"); submit(form); await settle(); assert.equal(h.cleanup.isDirty(), false); assert.ok(entry.store.incidentDetail(null, incident.id).incident.acknowledgedAt); assert.match(h.container.textContent, /operator:synthetic/); }
    if (route === "/employees") { const form = h.form("Leave instructions"); input(form, "title", "Synthetic follow-up"); submit(form); await settle(); assert.equal(h.cleanup.isDirty(), false); assert.match(h.container.textContent, /Synthetic follow-up/); assert.equal((await service.operator("GET", "employee-inbox", appQuery, null, "operator:synthetic")).items.length, 1); }
  }
});
test("prefilled and zero-field mutations preserve pending identity before any user edit", async t => {
  for (const withdraw of [false, true]) {
    let release, pendingSignal;
    const h = harness(t, { route: "/employees", query: { employee: "employee-one", host: "host-one", incident: "incident-one" }, fetch: async (url, init, fallback) => {
      if (init.method === "POST") { pendingSignal = init.signal; return new Promise(resolve => { release = () => resolve(response({ ok: true })); }); }
      const result = fallback(url, init); if (withdraw && url.includes("/employee-inbox?")) { const value = await result.json(); value.items = [{ id: "message-one", title: "Synthetic instruction", body: "Synthetic existing note", recipients: ["employee-one"], acknowledgments: {} }]; return response(value); } return result;
    } }); await h.cleanup.ready;
    assert.equal(h.cleanup.isDirty(), false); const form = h.form(withdraw ? "Withdraw instruction" : "Leave instructions"); submit(form); await settle();
    assert.equal(h.cleanup.isDirty(), true); assert.equal(pendingSignal.aborted, false); assert.ok(h.requests.find(item => item.init.method === "POST").body.idempotencyKey);
    h.cleanup(); assert.equal(pendingSignal.aborted, true); release(); await settle();
  }
});
test("saving or discarding one form preserves another draft in the same scoped view", async t => {
  const h = harness(t, { route: "/incidents", query: { incident: "incident-one" } }); await h.cleanup.ready;
  const ack = h.form("Acknowledge incident"), maintenance = h.form("Schedule maintenance"); input(ack, "note", "Keep this separate decision draft"); input(maintenance, "reason", "Synthetic maintenance"); const reads = h.requests.length;
  submit(maintenance); await settle(); assert.equal(h.form("Acknowledge incident"), ack); assert.equal(ack.querySelector('[name="note"]').value, "Keep this separate decision draft"); assert.equal(h.cleanup.isDirty(), true); assert.equal(h.requests.length, reads + 1); assert.match(maintenance.textContent, /Other drafts are preserved/);
  submit(maintenance); await settle(); assert.equal(h.requests.length, reads + 1, "saved form cannot submit a second action");
  submit(ack); await settle(); assert.equal(h.cleanup.isDirty(), false); assert.notEqual(h.form("Acknowledge incident"), ack); assert.equal(h.form("Acknowledge incident").querySelector('[name="note"]').value, "");
  const nextAck = h.form("Acknowledge incident"), nextMaintenance = h.form("Schedule maintenance"); input(nextAck, "note", "Second retained draft"); input(nextMaintenance, "reason", "Discard me"); nextMaintenance.querySelectorAll("button").find(item => item.textContent === "Discard this draft").click(); await settle(); assert.equal(nextAck.querySelector('[name="note"]').value, "Second retained draft"); assert.equal(nextMaintenance.querySelector('[name="reason"]').value, ""); assert.equal(h.cleanup.isDirty(), true);
});
test("application selector retains current display until shell navigation and never confirms twice", async t => {
  const h = harness(t, { route: "/incidents", applications: [{ appId: "app-one", displayName: "First app" }, { appId: "app-two", displayName: "Second app" }], query: { incident: "incident-one" } }); await h.cleanup.ready;
  input(h.form("Acknowledge incident"), "note", "Private draft from first scope"); const picker = h.field("operationsApp"); picker.value = "app-two"; picker.dispatchEvent({ type: "change" });
  assert.equal(picker.value, "app-one"); assert.equal(h.confirmations.length, 0); assert.match(h.context.location.hash, /appId=app-two/); assert.equal(h.cleanup.isDirty(), true);
  h.cleanup(); const replacement = h.context.SocOperations.render({ container: h.container, route: "/incidents", appId: "app-two", applications: [{ appId: "app-two", displayName: "Second app" }], query: new URLSearchParams({ ...WINDOW, incident: "incident-one" }) }); t.after(replacement); await replacement.ready;
  assert.equal(h.form("Acknowledge incident").querySelector('[name="note"]').value, ""); assert.equal(replacement.isDirty(), false); assert.doesNotMatch(h.container.textContent, /Private draft from first scope/);
});
test("exact incident detail refuses mismatched filters and metric events use the selected host scope", async t => {
  for (const query of [{ host: "host-other" }, { check: "check-other" }]) {
    const h = harness(t, { route: "/incidents", query: { incident: "incident-one", ...query } }); await h.cleanup.ready; assert.equal(h.form("Acknowledge incident"), undefined); assert.equal(h.form("Schedule maintenance"), undefined); assert.match(h.container.textContent, /does not match the selected host and check/);
    if (query.host) assert.equal(new URL(h.requests.find(item => item.url.includes("incidentId=")).url, "http://localhost").searchParams.get("host"), query.host);
  }
  const metrics = harness(t, { route: "/metrics", query: { host: "host-one" } }); await metrics.cleanup.ready; assert.equal(new URL(metrics.requests.find(item => item.url.includes("/events?")).url, "http://localhost").searchParams.get("host"), "host-one");
});
test("display timezone fallback preserves explicit route timezone and narrow charts use legible geometry", async t => {
  const { tz, ...withoutTimezone } = WINDOW;
  const fallback = harness(t, { route: "/metrics", rawQuery: withoutTimezone, displayTimezone: "America/Los_Angeles", width: 310 }); await fallback.cleanup.ready; assert.equal(fallback.field("tz").value, "America/Los_Angeles"); const svg = fallback.container.querySelector("svg"); assert.equal(svg.attributes.viewBox, "0 0 280 236"); assert.equal(svg.querySelectorAll("text").length, 7, "three ticks on each axis plus one threshold label");
  const explicit = harness(t, { route: "/metrics", displayTimezone: "America/Los_Angeles", query: { tz: "America/New_York" } }); await explicit.cleanup.ready; assert.equal(explicit.field("tz").value, "America/New_York"); assert.equal(explicit.container.querySelector("svg").attributes.viewBox, "0 0 760 236");
});

test("notification controls show uncertainty and retain exact decision identity after an unknown response", async t => {
  let posts = 0;
  const attemptId = "provider-attempt-" + "a".repeat(32);
  const h = harness(t, { route: "/incidents", query: { incident: "incident-one" }, fetch: async (url, init, fallback) => {
    if (new URL(url, "http://localhost").pathname.endsWith("/notifications") && init.method === "GET")
      return response({ ok: true, deliveries: [], transport: { provider: "resend", configured: true, enabled: true, paused: false, revision: 3, hourlySendCap: 100, automaticRetryWindowHours: 23 },
        attempts: [{ id: attemptId, incidentId: "incident-one", host: "host-one", destination: "team@example.invalid", active: true, state: "needs-reconciliation", revision: 4, requestCount: 1, updatedAt: AT }], decisions: [] });
    if (init.method === "POST" && url.includes("/notifications/reconcile?")) { posts++; if (posts === 1) throw new TypeError("Synthetic lost response"); }
    return fallback(url, init);
  } });
  await h.cleanup.ready;
  assert.match(h.container.textContent, /already submitted request can still complete/);
  assert.match(h.container.textContent, /duplicate mail/);
  assert.ok(h.form("Pause notification delivery"));
  const form = h.form("Retry the exact request"); assert.ok(form);
  input(form, "reason", "Verified provider state; retry the frozen request"); submit(form); await settle();
  assert.equal(h.cleanup.isDirty(), true); submit(form); await settle();
  const requests = h.requests.filter(row => row.init.method === "POST");
  assert.equal(requests.length, 2); assert.deepEqual(requests[0].body, requests[1].body);
  assert.equal(requests[0].body.attemptId, attemptId); assert.equal(requests[0].body.expectedRevision, 4);
  assert.equal(requests[0].body.action, "retry-exact"); assert.equal(requests[0].body.actor, undefined);
});
