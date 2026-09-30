"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.style = {}; this.listeners = {}; this.attributes = {}; this.text = ""; this.disabled = false; this.hidden = false; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; this.text = ""; }
  set textContent(value) { this.text = value; this.children = []; }
  get textContent() { return this.text + this.children.map(item => item.textContent).join(""); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, callback) { this.listeners[type] = callback; }
  click() { if (!this.disabled) return this.listeners.click?.(); }
  all(tag) { return this.children.flatMap(item => [...(item.tagName === tag ? [item] : []), ...item.all(tag)]); }
}
function fixture(options = {}) {
  const container = new Element("main"), requests = [];
  const context = vm.createContext({ document: { createElement: tag => new Element(tag) }, SOC_PRIVATE_APPLICATION: options.private !== false,
    setTimeout, clearTimeout, AbortController, TextDecoder, fetch: async (url, init) => { requests.push({ url, init }); return options.fetch ? options.fetch(url, init) : new Response(JSON.stringify({ schemaVersion: "1", checkedAt: new Date().toISOString(), recordKinds: ["log.event"], sources: [], configuredSources: 0, activeSources: 0, retainedRecords: 0, detail: "No producer yet", limitation: "No invented monitoring" })); } });
  context.window = context; vm.runInContext(fs.readFileSync(path.join(__dirname, "../public/setup-assistance.js"), "utf8"), context);
  const render = extra => context.SocSetupAssistance.render({ container, mode: options.mode, route: "/logs", query: new URLSearchParams({ appId: "app-one" }), offerChecklist: options.offerChecklist, ...extra });
  const cleanup = render();
  return { container, requests, cleanup, render, button: container.all("button")[0] };
}
test("screen help is opt-in read-only and static guidance makes no requests", async () => {
  const preview = fixture({ private: false }); await preview.button.click(); assert.equal(preview.requests.length, 0); assert.match(preview.container.textContent, /No check has run/); preview.cleanup();
  const h = fixture(); assert.equal(h.requests.length, 0); await h.button.click();
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].url, "/api/v1/setup-assistance/screen?route=%2Flogs&appId=app-one");
  assert.equal(h.requests[0].init.redirect, "error"); assert.equal(h.requests[0].init.credentials, "same-origin");
  assert.match(h.container.textContent, /No producer yet/); assert.match(h.container.textContent, /No scan, notification/); assert.equal(h.cleanup.isDirty(), false);
  assert.equal(h.container.all("a").find(item => item.textContent === "Inspect retained observations and filters").href, "#/sources?stab=observations&appId=app-one");
  assert.equal(h.container.all("a").find(item => item.textContent === "Review source registry").href, "#/sources?stab=add&appId=app-one"); h.cleanup();
});
test("operations guide exposes manual recovery steps and distinguishes observed facts", async () => {
  const h = fixture({ mode: "operations", fetch: async () => new Response(JSON.stringify({ schemaVersion: "1", checkedAt: new Date().toISOString(), origin: "http://127.0.0.1:8080", checks: [{ title: "Restore", state: "manual", detail: "Not performed" }] })) });
  assert.match(h.container.textContent, /Do not enable public Funnel/); assert.match(h.container.textContent, /confirmed stale lock/);
  await h.button.click(); assert.equal(h.requests[0].url, "/api/v1/setup-assistance/operations"); assert.match(h.container.textContent, /Operator verification required/); h.cleanup();
});
test("failed and oversized responses clear old proof without exposing remote text", async () => {
  for (const fetch of [async () => new Response("remote-secret-marker", { status: 500 }), async () => new Response(" ".repeat(1024 * 1024 + 1))]) {
    const h = fixture({ fetch }); await h.button.click(); assert.match(h.container.textContent, /could not be verified/); assert.doesNotMatch(h.container.textContent, /remote-secret-marker/); h.cleanup();
  }
});
test("disposal aborts assistance reads and suppresses late DOM changes", async () => {
  let release; const h = fixture({ fetch: () => new Promise(resolve => { release = resolve; }) });
  const pending = h.button.click(), before = h.container.textContent; h.cleanup(); assert.equal(h.requests[0].init.signal.aborted, true);
  release(new Response("{}")); await pending; assert.equal(h.container.textContent, before);
});
test("the plus disclosure is accessible, compact by default and separated from the page controls", async () => {
  const h = fixture();
  assert.equal(h.button.textContent, "+"); assert.equal(h.button.attributes["aria-label"], "Explain this screen");
  assert.equal(h.button.attributes["aria-expanded"], "false");
  const panel = h.container.all("section").find(node => node.attributes.id === h.button.attributes["aria-controls"]);
  assert.equal(panel.hidden, true); assert.equal(h.requests.length, 0);
  await h.button.click(); assert.equal(panel.hidden, false); assert.equal(h.button.attributes["aria-expanded"], "true");
  await h.button.click(); assert.equal(panel.hidden, true); assert.equal(h.button.textContent, "+");
  await h.button.click(); assert.equal(h.requests.length, 1, "reopening retained, timestamped facts does not silently start another check");
  h.cleanup();
  const controls = new Element("h1"), another = new Element("main");
  const cleanup = h.render({ container: another, controlsContainer: controls });
  assert.equal(controls.all("button")[0].textContent, "+"); assert.equal(another.all("button")[0].textContent, "Refresh local facts"); cleanup();
});
test("beginner checklist offers once, dismisses and resumes without claiming readiness or sending requests", async () => {
  const h = fixture({ offerChecklist: true });
  const checklist = h.container.all("section").find(node => node.attributes.role === "region");
  const resume = h.container.all("button").find(node => node.textContent === "Setup checklist"), dismiss = h.container.all("button").find(node => node.textContent === "Dismiss checklist");
  assert.equal(checklist.hidden, false); assert.equal(h.requests.length, 0);
  assert.match(checklist.textContent, /not verified readiness/); assert.match(checklist.textContent, /reset on reload/);
  assert.match(checklist.textContent, /Never enable public Funnel/); assert.match(checklist.textContent, /human approval/);
  assert.equal(checklist.all("input").length, 7);
  const first = checklist.all("input")[0]; first.checked = true; first.listeners.change();
  await dismiss.click(); assert.equal(checklist.hidden, true); assert.equal(resume.attributes["aria-expanded"], "false");
  await resume.click(); assert.equal(checklist.hidden, false); assert.equal(h.requests.length, 0);
  let prevented = false; checklist.listeners.keydown({ key: "Escape", preventDefault() { prevented = true; } }); assert.equal(prevented, true); assert.equal(checklist.hidden, true);
  h.cleanup(); h.container.replaceChildren(); const cleanup = h.render();
  const next = h.container.all("section").find(node => node.attributes.role === "region");
  assert.equal(next.hidden, true, "automatic refresh or route rerender does not offer again");
  assert.equal(next.all("input")[0].checked, true, "personal checks survive rerender without being persisted");
  cleanup();
  const reloaded = fixture({ offerChecklist: true });
  const afterReload = reloaded.container.all("section").find(node => node.attributes.role === "region");
  assert.equal(afterReload.hidden, false); assert.equal(afterReload.all("input")[0].checked, false); reloaded.cleanup();
});
test("manual checklist remains available without empty-screen help and never uses browser storage", async () => {
  const h = fixture({ mode: "checklist", offerChecklist: true });
  assert.equal(h.container.all("button").some(node => node.attributes["aria-label"] === "Explain this screen"), false);
  assert.equal(h.container.all("section").find(node => node.attributes.role === "region").hidden, false);
  assert.equal(h.requests.length, 0); h.cleanup();
  const preview = fixture({ private: false, offerChecklist: true });
  assert.equal(preview.container.all("input").length, 0); assert.equal(preview.requests.length, 0); preview.cleanup();
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "../public/setup-assistance.js"), "utf8"), /\b(?:sessionStorage|localStorage|indexedDB)\b/);
});
