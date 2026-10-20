"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const test = require("node:test");
const root = path.resolve(__dirname, "..");
const read = name => fs.readFileSync(path.join(root, name), "utf8");

class TestDomNode {
  constructor(ownerDocument, nodeType, tagName = "") {
    this.ownerDocument = ownerDocument;
    this.nodeType = nodeType;
    this.tagName = tagName.toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.className = "";
    this.dataset = {};
    this.hidden = false;
    this._text = "";
    this._listeners = new Map();
    this.classList = {
      add: (...names) => {
        const classes = new Set(this.className.split(/\s+/).filter(Boolean));
        names.forEach((name) => classes.add(name));
        this.className = Array.from(classes).join(" ");
      },
      remove: (...names) => {
        const removed = new Set(names);
        this.className = this.className.split(/\s+/).filter((name) => name && !removed.has(name)).join(" ");
      }
    };
  }

  append(...children) {
    for (const child of children) {
      if (!child) continue;
      if (child.nodeType === 11) {
        this.append(...child.childNodes.slice());
        child.childNodes = [];
        continue;
      }
      child.parentNode = this;
      this.childNodes.push(child);
    }
  }

  replaceChildren(...children) {
    this.childNodes = [];
    this._text = "";
    this.append(...children);
  }

  setAttribute(name, value) {
    const normalized = String(value);
    this.attributes.set(name, normalized);
    if (name === "class") this.className = normalized;
    if (name === "value") this.value = normalized;
    if (name === "name") this.name = normalized;
    if (name === "type") this.type = normalized;
    if (name === "disabled") this.disabled = true;
    if (name.startsWith("data-")) {
      const key = name.slice(5).replace(/-([a-z])/g, (_match, character) => character.toUpperCase());
      this.dataset[key] = normalized;
    }
  }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === "class") this.className = "";
    if (name === "name") this.name = "";
    if (name === "type") this.type = "";
    if (name === "disabled") this.disabled = false;
    if (name.startsWith("data-")) {
      const key = name.slice(5).replace(/-([a-z])/g, (_match, character) => character.toUpperCase());
      delete this.dataset[key];
    }
  }
  addEventListener(type, listener) {
    const listeners = this._listeners.get(type) || new Set();
    listeners.add(listener);
    this._listeners.set(type, listeners);
  }
  removeEventListener(type, listener) {
    const listeners = this._listeners.get(type);
    if (listeners) listeners.delete(listener);
  }
  dispatchEvent(event) {
    if (!event.target) event.target = this;
    if (!event.preventDefault) event.preventDefault = () => { event.defaultPrevented = true; };
    for (const listener of this._listeners.get(event.type) || []) listener.call(this, event);
    return !event.defaultPrevented;
  }
  querySelectorAll(selector) {
    const matches = [];
    this.childNodes.forEach((child) => findNodes(child, (candidate) => candidate.matches(selector), matches));
    return matches;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) {
    let candidate = this;
    while (candidate) {
      if (candidate.matches(selector)) return candidate;
      candidate = candidate.parentNode;
    }
    return null;
  }
  matches(selector) {
    if (selector.startsWith(".")) return this.className.split(/\s+/).includes(selector.slice(1));
    if (selector.startsWith("#")) return this.getAttribute("id") === selector.slice(1);
    const attribute = /^([a-z][a-z0-9-]*)?\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]$/i.exec(selector);
    if (attribute) {
      const [, tagName, name, expected] = attribute;
      if (tagName && this.tagName !== tagName.toUpperCase()) return false;
      const actual = this.getAttribute(name);
      return actual !== null && (expected === undefined || actual === expected);
    }
    return /^[a-z][a-z0-9-]*$/i.test(selector) && this.tagName === selector.toUpperCase();
  }

  focus() {
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }

  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get textContent() { return this._text + this.childNodes.map((child) => child.textContent).join(""); }
  set textContent(value) {
    this._text = String(value);
    this.childNodes = [];
  }
}

class TestDocument {
  constructor() {
    this.activeElement = null;
    this.title = "";
    this.querySelectorCalls = 0;
    this._listeners = new Map();
    this.hostBrand = this.createElement("a");
    this.hostBrand.className = "brand";
    this.hostBrand.setAttribute("aria-label", "Host application brand");
    this.hostBrandImage = this.createElement("img");
    this.hostBrandImage.setAttribute("src", "host-product.png");
    this.hostBrand.append(this.hostBrandImage);
  }

  createElement(tagName) { return new TestDomNode(this, 1, tagName); }
  createElementNS(_namespace, tagName) { return this.createElement(tagName); }
  createDocumentFragment() { return new TestDomNode(this, 11); }
  createTextNode(value) {
    const textNode = new TestDomNode(this, 3);
    textNode._text = String(value);
    return textNode;
  }
  addEventListener(type, listener) {
    const listeners = this._listeners.get(type) || new Set();
    listeners.add(listener);
    this._listeners.set(type, listeners);
  }
  removeEventListener(type, listener) {
    const listeners = this._listeners.get(type);
    if (listeners) listeners.delete(listener);
  }
  dispatchEvent(event) {
    if (!event.preventDefault) event.preventDefault = () => { event.defaultPrevented = true; };
    for (const listener of this._listeners.get(event.type) || []) listener.call(this, event);
    return !event.defaultPrevented;
  }

  querySelector(selector) {
    this.querySelectorCalls += 1;
    if (selector === ".brand") return this.hostBrand;
    if (selector === ".brand img") return this.hostBrandImage;
    return null;
  }
}

function findNodes(rootNode, predicate, matches = []) {
  if (predicate(rootNode)) matches.push(rootNode);
  rootNode.childNodes.forEach((child) => findNodes(child, predicate, matches));
  return matches;
}

function adapterTable(id, title, labels) {
  return {
    id,
    type: "table",
    title,
    caption: `${title} authorized rows`,
    columns: labels.map((label, index) => ({ key: `c${index}`, label })),
    rows: [labels.map((_label, index) => `${id}-${index}`)]
  };
}

function adapterEnvelope(route, query = {}) {
  const sourceNames = {
    threatfox: "ThreatFox",
    urlhaus: "URLHaus",
    malwarebazaar: "MalwareBazaar"
  };
  const sourceName = sourceNames[query.itab];
  const panelsByRoute = {
    "/": [
      { id: "summary-metrics", type: "metrics", title: "Summary", items: [{ label: "Needs review", value: "1" }] },
      adapterTable("detections", "Detections", ["Time", "Host", "Severity", "Rule", "Event"])
    ],
    "/triage": [adapterTable("alerts", "Alerts", ["Select", "Case", "When", "Host", "Severity", "Rule", "Alert", "Status", "Owner", "Activity", "Actions"])],
    "/tuning": [
      { id: "summary-metrics", type: "metrics", title: "Active tuning status", items: [{ label: "Active Tunes", value: "1" }] },
      adapterTable("detection-tune-definitions", "Detection tune definitions", ["Detection", "Match scope", "Status", "Revision", "Owner", "Expires", "Actions"])
    ],
    "/rules": [
      { id: "summary-metrics", type: "metrics", title: "Active tuning status", items: [{ label: "Active Tunes", value: "1" }] },
      adapterTable("detection-tune-definitions", "Detection tune definitions", ["Detection", "Match scope", "Status", "Revision", "Owner", "Expires", "Actions"])
    ],
    "/intel": sourceName
      ? [adapterTable(`${query.itab}-indicators`, `${sourceName} indicators`, [
          "Indicator", "Kind", "Family", "Conf", "Tags", "First seen", "Last seen", "Also in", "Actions"
        ])]
      : [adapterTable("indicators", "Indicators", ["Indicator", "Type", "Named in", "Actions"])],
    "/event": [{
      id: "decision-status",
      type: "metrics",
      title: "Decision status",
      description: "Authorized decision projection",
      items: [
        { label: "Status", value: "Review", tone: "neutral" },
        { label: "Severity", value: "High", tone: "warn" },
        { label: "Owner", value: "Unassigned", tone: "neutral" },
        { label: "Activity", value: "Investigation", tone: "neutral" },
        { label: "Tune", value: "Not applied", tone: "neutral" }
      ]
    }]
  };
  return {
    schemaVersion: "1",
    route,
    state: "ready",
    title: `Authorized ${route}`,
    panels: panelsByRoute[route] || []
  };
}


function harness(hash = "#/", options = {}) {
  const document = new TestDocument(), mountRoot = document.createElement("main"), shell = document.createElement("aside");
  const toast = document.createElement("div"), message = document.createElement("span");
  toast.setAttribute("id", "toast"); message.setAttribute("id", "toast-message"); toast.append(message); shell.append(toast);
  const observers = new Set();
  const listeners = new Map(), timers = new Map(), intervals = new Map(), entries = [{ hash, state: null }];
  let position = 0, timerId = 0;
  const location = { hash, origin: "https://console.example.invalid" }, reads = [], confirms = [];
  function emit(type) { for (const callback of listeners.get(type) || []) callback({ type }); }
  const history = { scrollRestoration: "auto", get state() { return entries[position].state; },
    replaceState(state, title, hash) { entries[position] = { hash, state: structuredClone(state) }; location.hash = hash; },
    pushState(state, title, hash) { entries.splice(++position); entries.push({ hash, state: structuredClone(state) }); location.hash = hash; },
    go(delta) { if (position + delta < 0 || position + delta >= entries.length) return;
      position += delta; location.hash = entries[position].hash; emit("popstate"); emit("hashchange"); }
  };
  const context = vm.createContext({ document, location, history, URL, URLSearchParams, TextEncoder, AbortController, console,
    MutationObserver: class { constructor(callback) { this.callback = callback; } observe() { observers.add(this); } disconnect() { observers.delete(this); } },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); }, setInterval(callback) { const id = ++timerId; intervals.set(id, callback); return id; }, clearInterval(id) { intervals.delete(id); },
    scrollX: 0, scrollY: 0, scrollTo(x,y) { context.scrollX = x; context.scrollY = y; },
    confirm(message) { confirms.push(message); return options.confirm !== false; },
    addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(callback); },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); }
  }); context.window = context;
  for (const name of ["technical-docs", "ui-catalog", "adapter-contract", "connector-contract", "administration-contract", "app-config", "app"]) vm.runInContext(read("public/" + name + ".js"), context, { filename: name });
  if (options.triage) { context.SOC_PRIVATE_APPLICATION = true; context.SocTriage = { render: options.triage, clearSelections() {} }; }
  const provider = { readPage(request, controls) { reads.push({ request, signal: controls.signal });
    return options.read ? options.read(request, controls) : adapterEnvelope(request.route, request.query); } };
  const app = context.SocConsole.createApp({ root: mountRoot, shellRoot: shell, provider, config: context.SocConsoleConfig });
  return { app, context, mountRoot, document, location, history, entries, reads, confirms, timers, intervals, listeners, message,
    emit, flushMutations() { for (const observer of observers) observer.callback(); }, scroll(y) { context.scrollY = y; emit("scroll"); },
    nativeFragment(hash) { history.pushState(history.state, "", hash); context.scrollY = 999; emit("hashchange"); },
    click(href, extra = {}) { const link = document.createElement("a"); link.setAttribute("href", href); if (extra.download) link.setAttribute("download", "");
      const event = { type: "click", target: link, button: 0, ...extra }; document.dispatchEvent(event); return event; },
    expire(delay) { for (const [id, timer] of timers) if (timer.delay === delay) { timers.delete(id); timer.callback(); } }
  };
}
const tick = async () => { for (let n=0; n<20; n++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };

function retained(options = {}) {
  const metrics = { renders: 0, disposals: 0, reads: 0, dirty: false, pending: false, cancelReads: 0, reasons: [] };
  function render(renderOptions) {
    metrics.renders++; metrics.options = renderOptions;
    const form = renderOptions.container.ownerDocument.createElement("form"), input = renderOptions.container.ownerDocument.createElement("input");
    input.setAttribute("name", "draft"); input.value = "initial"; form.append(input); renderOptions.container.append(form); metrics.input = input;
    const cleanup = () => { metrics.disposals++; };
    cleanup.isDirty = () => metrics.dirty; cleanup.isPending = () => metrics.pending;
    cleanup.cancelReads = () => { metrics.cancelReads++; };
    cleanup.navigateLocal = request => {
      metrics.lastSignal = request.signal; metrics.reasons.push(request.reason);
      if (request.path !== "/triage") return false;
      if (request.query.get("alert") === renderOptions.query.get("alert")) return true;
      return (async () => { if (!(await request.canLeave())) return false; metrics.reads++; return options.local ? options.local(request) : true; })();
    };
    return cleanup;
  }
  return { metrics, render };
}

test("retained tabs are zero-read and pending writes cannot be discarded by route navigation", async () => {
  const view = retained(), h = harness("#/triage?alert=a", { triage: view.render }); await h.app.mount();
  const input = view.metrics.input; input.value = "draft"; view.metrics.dirty = true; view.metrics.pending = true;
  assert.equal(await view.metrics.options.navigate("#/triage?alert=a&tab=evidence"), true);
  assert.equal(view.metrics.input, input); assert.equal(input.value, "draft"); assert.equal(view.metrics.renders,1); assert.equal(view.metrics.reads,0);
  assert.equal(await h.app.navigate("/logs"), false); assert.equal(h.confirms.length,0); assert.equal(h.reads.length,0);
  await h.app.refresh(); assert.equal(view.metrics.disposals,0); h.app.unmount(); assert.equal(view.metrics.disposals,1);
});

test("handled async cancellation and rejection never fall through to the page provider", async () => {
  for (const local of [() => false, () => { throw new Error("read failed"); }]) {
    const view = retained({ local }), h = harness("#/triage?alert=a", { triage:view.render }); await h.app.mount();
    const dom = h.mountRoot.childNodes[0]; assert.equal(await view.metrics.options.navigate("#/triage?alert=b"),false);
    assert.equal(h.mountRoot.childNodes[0],dom); assert.equal(h.reads.length,0); assert.equal(view.metrics.disposals,0); assert.equal(h.location.hash,"#/triage?alert=a"); h.app.unmount();
  }
});

test("local context replacement preserves history identity and dirty cancellation preserves the draft", async () => {
  const view = retained(), h = harness("#/triage?alert=a", { triage:view.render, confirm:false }); await h.app.mount();
  const id = h.history.state.socNavigation.id; view.metrics.options.onContext(new URLSearchParams("alert=a&approval=review"));
  assert.equal(h.history.state.socNavigation.id,id); assert.equal(h.entries.length,1);
  view.metrics.dirty=true; assert.equal(await view.metrics.options.navigate("#/triage?alert=b"),false);
  assert.equal(view.metrics.reads,0); assert.equal(h.confirms.length,1); assert.equal(h.location.hash,"#/triage?alert=a&approval=review"); h.app.unmount();
});

test("failed page reads retain visible DOM, query and history; successful navigation disposes once", async () => {
  const view = retained(), h = harness("#/triage?alert=a", { triage:view.render, read() { throw new Error("offline"); } }); await h.app.mount();
  const dom = h.mountRoot.childNodes[0]; assert.equal(await h.app.navigate("/logs"),false); assert.equal(h.mountRoot.childNodes[0],dom);
  assert.equal(h.app.getState().route,"/triage"); assert.equal(h.entries.length,1); assert.equal(view.metrics.disposals,0); assert.match(h.message.textContent,/preserved/);
  h.app.unmount(); assert.equal(view.metrics.disposals,1);
});

test("superseded reads are aborted and a provider ignoring abort cannot replace a newer route", async () => {
  const waiting = deferred(); const h = harness("#/", { read(request) { return request.route === "/logs" ? waiting.promise : adapterEnvelope(request.route); } }); await h.app.mount();
  const dom = h.mountRoot.childNodes[0], first = h.app.navigate("/logs"); await tick(); assert.equal(h.mountRoot.childNodes[0],dom);
  const signal = h.reads.at(-1).signal; assert.equal(await h.app.navigate("/health"),true); assert.equal(signal.aborted,true);
  waiting.resolve(adapterEnvelope("/logs")); assert.equal(await first,false); assert.equal(h.app.getState().route,"/health"); assert.equal(h.entries.length,2); h.app.unmount();
});

test("bounded reads preserve the current screen on timeout and cleanup all navigation timers", async () => {
  const waiting = deferred(), h = harness("#/", { read(request) { return request.route === "/logs" ? waiting.promise : adapterEnvelope(request.route); } }); await h.app.mount();
  const dom=h.mountRoot.childNodes[0], navigation=h.app.navigate("/logs"); await tick(); h.expire(60000); assert.equal(await navigation,false);
  assert.equal(h.mountRoot.childNodes[0],dom); assert.equal(h.reads.at(-1).signal.aborted,true); h.app.unmount();
  assert.equal(h.timers.size,0); assert.equal(h.intervals.size,0); assert.equal(h.history.scrollRestoration,"auto"); assert.ok([...h.listeners.values()].every(set=>set.size===0));
});

test("Back cancellation restores the previous entry without pushing a replacement or destroying drafts", async () => {
  const view=retained(), h=harness("#/",{triage:view.render,confirm:false}); await h.app.mount(); await h.app.navigate("/triage",{alert:"a"});
  h.scroll(214); view.metrics.input.focus(); h.document.dispatchEvent({type:"focusin",target:view.metrics.input}); view.metrics.dirty=true;
  const id=h.history.state.socNavigation.id, dom=h.mountRoot.childNodes[0]; h.history.go(-1); await tick();
  assert.equal(h.location.hash,"#/triage?alert=a"); assert.equal(h.history.state.socNavigation.id,id); assert.equal(h.entries.length,2);
  assert.equal(h.mountRoot.childNodes[0],dom); assert.equal(h.context.scrollY,214); assert.equal(h.document.activeElement,view.metrics.input); h.app.unmount();
});

test("native fragment entries retain DOM with zero reads and unique indexes after history branching", async () => {
  const h=harness("#/docs"); await h.app.mount(); const dom=h.mountRoot.childNodes[0], count=h.reads.length, first=h.history.state.socNavigation.id;
  h.scroll(85); h.nativeFragment("#chapter-one"); await tick(); const second=h.history.state.socNavigation.id;
  assert.notEqual(second,first); assert.equal(h.entries.length,2); assert.equal(h.mountRoot.childNodes[0],dom); assert.equal(h.reads.length,count);
  h.scroll(193); h.history.go(-1); await tick(); assert.equal(h.location.hash,"#/docs"); assert.equal(h.context.scrollY,85); assert.equal(h.mountRoot.childNodes[0],dom);
  h.nativeFragment("#chapter-two"); await tick(); const third=h.history.state.socNavigation.id; assert.ok(third>second); assert.equal(h.entries.length,2);
  h.history.go(-1); await tick(); h.history.go(1); await tick(); assert.equal(h.location.hash,"#chapter-two"); assert.equal(h.reads.length,count); h.app.unmount();
});

test("fragment history remembers its underlying route when returning from another page", async () => {
  const h=harness("#/docs"); await h.app.mount(); h.nativeFragment("#chapter-one"); await tick(); await h.app.navigate("/logs"); h.history.go(-1); await tick();
  assert.equal(h.app.getState().route,"/docs"); assert.equal(h.location.hash,"#chapter-one"); h.app.unmount();
});

test("normal links use navigation while modified clicks, downloads and external links stay native", async () => {
  const h=harness(); await h.app.mount();
  for(const [href, extra] of [["#/logs",{ctrlKey:true}],["#/logs",{download:true}],["https://example.invalid",{}],["/api/v1/documents/file",{}]]) {
    const event=h.click(href,extra); assert.notEqual(event.defaultPrevented,true); }
  const event=h.click("#/logs"); assert.equal(event.defaultPrevented,true); await tick(); assert.equal(h.app.getState().route,"/logs"); h.app.unmount();
});

test("programmatically initialized forms are clean; edits and late edits protect the visible DOM", async () => {
  const waiting=deferred(), h=harness("#/onboard",{read(request){return request.route==="/logs" ? waiting.promise : adapterEnvelope(request.route);}}); await h.app.mount();
  const form=h.document.createElement("form"), input=h.document.createElement("input"); input.setAttribute("name","review");
  input.value="initialized default"; form.append(input); h.mountRoot.append(form); h.flushMutations();
  assert.equal(input.defaultValue,"initialized default");
  const baseline=input.value; input.value="operator edit"; h.mountRoot.dispatchEvent({type:"input",target:input});
  assert.equal(form.dataset.dirty,"true"); const count=h.reads.length; await h.app.refresh(); assert.equal(h.reads.length,count);
  input.value=baseline; h.mountRoot.dispatchEvent({type:"input",target:input}); assert.equal(form.dataset.dirty,undefined);
  const navigation=h.app.navigate("/logs"); await tick(); input.value="new draft"; h.mountRoot.dispatchEvent({type:"input",target:input});
  waiting.resolve(adapterEnvelope("/logs")); assert.equal(await navigation,false); assert.equal(h.app.getState().route,"/onboard"); assert.equal(input.value,"new draft"); h.app.unmount();
});


test("replace navigation preserves the entry index and a completed route replacement cleans up exactly once", async () => {
  const view=retained(), h=harness("#/triage?alert=a",{triage:view.render}); await h.app.mount();
  const identity=h.history.state.socNavigation.id, position=h.history.state.socNavigation.position;
  assert.equal(await view.metrics.options.navigate("#/triage?alert=a&tab=history",{replace:true}),true);
  assert.equal(h.history.state.socNavigation.id,identity); assert.equal(h.history.state.socNavigation.position,position); assert.equal(h.entries.length,1);
  assert.equal(await h.app.navigate("/logs"),true); assert.equal(view.metrics.disposals,1); h.app.unmount(); assert.equal(view.metrics.disposals,1);
});

test("mount retains browser history position across controller replacement", async () => {
  const h=harness(); await h.app.mount(); await h.app.navigate("/logs"); const id=h.history.state.socNavigation.id;
  h.app.unmount(); const replacement=h.context.SocConsole.createApp({root:h.mountRoot,provider:null,config:h.context.SocConsoleConfig});
  await replacement.mount(); assert.equal(h.history.state.socNavigation.id,id); assert.equal(h.history.state.socNavigation.position,1);
  h.history.go(-1); await tick(); assert.equal(replacement.getState().route,"/"); assert.equal(h.history.state.socNavigation.position,0);
  await replacement.navigate("/health"); assert.ok(h.history.state.socNavigation.id>id); assert.equal(h.entries.length,2); replacement.unmount();
});


test("slow successful historical page reads remain allowed within their longer deadline", async () => {
  const waiting=deferred(), h=harness("#/",{read(request){return request.route==="/analytics" ? waiting.promise : adapterEnvelope(request.route);}});
  await h.app.mount(); const navigation=h.app.navigate("/analytics"); await tick(); h.expire(30000);
  assert.equal(h.mountRoot.getAttribute("aria-busy"),"true"); assert.equal(h.reads.at(-1).signal.aborted,false);
  waiting.resolve(adapterEnvelope("/analytics")); assert.equal(await navigation,true); assert.equal(h.app.getState().route,"/analytics");
  assert.equal(h.mountRoot.getAttribute("aria-busy"),null); h.app.unmount();
});


test("normalized read providers forward cancellation outside their closed request documents", async () => {
  const h=harness(), signal=new AbortController().signal, received=[], stopped=new Error("stopped before transport");
  const capture=function(request,options){received.push({request,options});throw stopped;};
  const connectors=h.context.SocConsoleConnectorRuntime.validateProvider({schemaVersion:"1",id:"connector-test",getSnapshot:capture,execute(){}});
  const administration=h.context.SocConsoleAdministrationRuntime.validateProvider({schemaVersion:"1",id:"admin-test",getSnapshot:capture,getPrompt:capture,execute(){}});
  const control={schemaVersion:"1",reason:"refresh"};
  const snapshot={schemaVersion:"1",documentType:"administration-snapshot-request",domain:"agents",reason:"refresh"};
  const prompt={schemaVersion:"1",documentType:"agent-prompt-request",promptId:"prompt-test"};
  await assert.rejects(connectors.getSnapshot(control,{signal}),error=>error===stopped);
  await assert.rejects(administration.getSnapshot(snapshot,{signal}),error=>error===stopped);
  await assert.rejects(administration.getPrompt(prompt,{signal}),error=>error===stopped);
  assert.deepEqual(received.map(item=>JSON.parse(JSON.stringify(item.request))),[control,snapshot,prompt]);
  received.forEach(item=>{assert.equal(item.options.signal,signal);assert.equal("signal" in item.request,false);});
  assert.throws(()=>connectors.getSnapshot({...control,signal}),/not allowed|unknown|unsupported/i);
});

test("injected browser read bridges abort transport without changing write behavior", async () => {
  const {buildBrowserProviderSource}=require("../server/reference-control-plane");
  const requests=[], stopped=new Error("transport stopped"), context=vm.createContext({URLSearchParams,fetch(url,options){requests.push({url,options});return Promise.reject(stopped);}});
  context.window=context; vm.runInContext(buildBrowserProviderSource(),context);
  const signal=new AbortController().signal;
  const calls=[()=>context.SOC_CONSOLE_ADAPTER.readPage({route:"/logs",query:{}},{signal}),
    ()=>context.SOC_CONSOLE_CONNECTORS.getSnapshot({reason:"refresh"},{signal}),
    ()=>context.SOC_CONSOLE_ADMINISTRATION.getSnapshot({domain:"agents",reason:"refresh"},{signal}),
    ()=>context.SOC_CONSOLE_ADMINISTRATION.getPrompt({promptId:"prompt-test"},{signal})];
  for(const call of calls) await assert.rejects(call(),error=>error===stopped);
  assert.equal(requests.length,4); requests.forEach(({url,options})=>{assert.equal(options.signal,signal);assert.equal(options.credentials,"same-origin");assert.equal(options.method,undefined);assert.doesNotMatch(url,/signal/);});
  await assert.rejects(context.SOC_CONSOLE_CONNECTORS.execute({requestId:"write-test"},{signal}),error=>error===stopped);
  assert.equal(requests.at(-1).options.method,"POST"); assert.equal(requests.at(-1).options.signal,undefined);
});


test("local Back and Forward use popstate and the shared owner restores focus and scroll", async () => {
  const view=retained(), h=harness("#/triage?alert=a",{triage:view.render}); await h.app.mount();
  view.metrics.input.focus(); h.scroll(42);
  assert.equal(await view.metrics.options.navigate("#/triage?alert=b"),true); assert.equal(view.metrics.reasons.at(-1),"navigation");
  h.scroll(173); h.history.go(-1); await tick();
  assert.equal(view.metrics.reasons.at(-1),"popstate"); assert.equal(h.location.hash,"#/triage?alert=a");
  assert.equal(h.context.scrollY,42); assert.equal(h.document.activeElement,view.metrics.input);
  h.history.go(1); await tick(); assert.equal(view.metrics.reasons.at(-1),"popstate"); assert.equal(h.context.scrollY,173);
  assert.equal(h.document.activeElement,view.metrics.input); assert.equal(view.metrics.renders,1); assert.equal(view.metrics.disposals,0); h.app.unmount();
});

test("unmount aborts local navigation and late handled success cannot rewrite history", async () => {
  const waiting=deferred(), view=retained({local:()=>waiting.promise}), h=harness("#/triage?alert=a",{triage:view.render}); await h.app.mount();
  const navigation=view.metrics.options.navigate("#/triage?alert=b"); await tick(); const signal=view.metrics.lastSignal;
  h.app.unmount(); assert.equal(signal.aborted,true); waiting.resolve(true); assert.equal(await navigation,false);
  assert.equal(h.location.hash,"#/triage?alert=a"); assert.equal(h.entries.length,1); assert.equal(view.metrics.disposals,1);
  assert.ok([...h.listeners.values()].every(set=>set.size===0));
});
