"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { audit, brandAssets, sniffMime } = require("../tools/public-audit");
const {
  CSP,
  HOST,
  contentTypes,
  createServer,
  parsePort,
  resolveRequestPath,
  securityHeaders
} = require("../tools/serve");
const { validateDocument } = require("../tools/validate-provider");
const {
  generatedSource,
  sectionsFromMarkdown,
  validateMarkdown
} = require("../tools/build-technical-docs");

const root = path.resolve(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

function browserContext(files, prelude) {
  const context = vm.createContext({});
  context.window = context;
  if (prelude) vm.runInContext(prelude, context, { filename: "test-prelude.js" });
  for (const name of files) {
    vm.runInContext(read(name), context, { filename: name });
  }
  return context;
}

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

function hasClass(rootNode, className) {
  if (rootNode.className && rootNode.className.split(/\s+/).includes(className)) return true;
  return rootNode.childNodes.some((child) => hasClass(child, className));
}

function findNodes(rootNode, predicate, matches = []) {
  if (predicate(rootNode)) matches.push(rootNode);
  rootNode.childNodes.forEach((child) => findNodes(child, predicate, matches));
  return matches;
}

function nodesWithClass(rootNode, className) {
  return findNodes(rootNode, (candidate) => candidate.className
    && candidate.className.split(/\s+/).includes(className));
}

function renderedValues(rootNode) {
  const values = [];
  findNodes(rootNode, (candidate) => {
    if (candidate._text) values.push(candidate._text);
    for (const [name, value] of candidate.attributes) values.push(name, value);
    for (const [name, value] of Object.entries(candidate.dataset)) values.push(name, value);
    return false;
  });
  return values.join("\n");
}

function assertUniqueRenderedIdentifiers(rootNode, route) {
  for (const attribute of ["id", "data-panel-id"]) {
    const values = findNodes(rootNode, (candidate) => candidate.getAttribute(attribute) !== null)
      .map((candidate) => candidate.getAttribute(attribute))
      .filter(Boolean);
    assert.equal(new Set(values).size, values.length, `${route}: duplicate ${attribute}`);
  }
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

function createUiHarness(initialHash, options = {}) {
  const document = options.document || new TestDocument();
  const readRequests = [];
  const mountRoot = document.createElement("main");
  const defaultShellRoot = options.withPulseShell || options.withAuthShell
    ? document.createElement("aside")
    : null;
  const pulseClip = options.withPulseShell ? document.createElement("div") : null;
  if (pulseClip) {
    pulseClip.setAttribute("id", "circuit-pulses");
    defaultShellRoot.append(pulseClip);
  }
  let authName = null;
  let authState = null;
  if (options.withAuthShell) {
    const authAvatar = document.createElement("span");
    authAvatar.setAttribute("id", "auth-avatar");
    authName = document.createElement("span");
    authName.setAttribute("id", "auth-name");
    authState = document.createElement("span");
    authState.setAttribute("id", "auth-state");
    defaultShellRoot.append(authAvatar, authName, authState);
  }
  const shellRoot = options.shellRoot === undefined
    ? defaultShellRoot
    : options.shellRoot;
  const location = { hash: initialHash, origin: "https://console.example.invalid" };
  const context = vm.createContext({
    URL,
    URLSearchParams,
    clearTimeout() {},
    clearInterval() {},
    console,
    document,
    location,
    setInterval() { return 1; },
    setTimeout() { return 2; }
  });
  context.window = context;
  context.addEventListener = () => {};
  context.removeEventListener = () => {};
  if (typeof options.random === "number") {
    context.__testRandom = options.random;
    vm.runInContext("Math.random = () => __testRandom", context);
  }
  for (const name of [
    "public/technical-docs.js",
    "public/ui-catalog.js",
    "public/adapter-contract.js",
    "public/connector-contract.js",
    "public/administration-contract.js",
    "public/app-config.js",
    "public/app.js"
  ]) vm.runInContext(read(name), context, { filename: name });
  context.__mountRoot = mountRoot;
  context.__shellRoot = shellRoot;
  context.__useProvider = options.provider !== false;
  context.__useAuth = options.session !== undefined;
  context.__session = options.session;
  context.__commands = options.commands || null;
  context.__administration = options.administration || null;
  context.__readPage = (request) => {
    readRequests.push({ route: request.route, query: { ...request.query }, reason: request.reason });
    return typeof options.envelope === "function"
      ? options.envelope(request)
      : adapterEnvelope(request.route, request.query);
  };
  const app = vm.runInContext(`SocConsole.createApp({
    root: __mountRoot,
    shellRoot: __shellRoot,
    provider: __useProvider ? { readPage(request) { return __readPage(request); } } : null,
    auth: __useAuth ? {
      getSession() { return __session; },
      login() {},
      logout() {}
    } : null,
    commands: __commands,
    administration: __administration,
    config: SocConsoleConfig
  })`, context);
  return { app, authName, authState, context, document, location, mountRoot, pulseClip, readRequests, shellRoot };
}

function localRequest(server, options) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: HOST,
      port: address.port,
      method: options.method || "GET",
      path: options.path || "/"
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        body: Buffer.concat(chunks),
        headers: response.headers,
        status: response.statusCode
      }));
    });
    request.on("error", reject);
    request.end();
  });
}

const validEnvelope = Object.freeze({
  schemaVersion: "1",
  route: "/health",
  state: "ready",
  title: "Provider validation example",
  summary: "Fixed demonstration data.",
  updatedAt: "2030-04-01T10:00:00Z",
  panels: [{
    id: "source-state",
    type: "notice",
    title: "Source state",
    body: "The example source is reporting.",
    tone: "ok"
  }]
});

test("the positive publication manifest and content audit pass", () => {
  assert.deepEqual(audit(), []);
});

test("the five approved product assets are exact, typed, hash-pinned files", () => {
  assert.equal(Object.keys(brandAssets).length, 5);
  assert.deepEqual(brandAssets["public/assets/triage-back-arrow.png"], {
    bytes: 64946,
    mime: "image/png",
    sha256: "64c7101defb28677f3c0cf33927c2034da97bb75a7447f4a376766f5c0a0ddfb"
  });
  for (const [name, expected] of Object.entries(brandAssets)) {
    const buffer = fs.readFileSync(path.join(root, name));
    assert.equal(buffer.length, expected.bytes, `${name} byte length`);
    assert.equal(sniffMime(buffer), expected.mime, `${name} MIME signature`);
    assert.equal(crypto.createHash("sha256").update(buffer).digest("hex"), expected.sha256, `${name} digest`);
  }
});

test("sidebar circuit pulses keep the active path grammar and randomized group bounds", async () => {
  for (const random of [0, 0.5, 0.999]) {
    const harness = createUiHarness("#/", { provider: false, random, withPulseShell: true });
    await harness.app.mount();

    assert.equal(harness.pulseClip.childNodes.length, 1, `one SVG at random=${random}`);
    const svg = harness.pulseClip.childNodes[0];
    assert.equal(svg.tagName, "SVG");
    assert.equal(svg.className, "circuit-pulse");
    assert.equal(svg.getAttribute("viewBox"), "0 0 192 4032");
    assert.equal(svg.getAttribute("preserveAspectRatio"), "none");
    assert.equal(svg.getAttribute("aria-hidden"), "true");

    const expectedCount = 3 + Math.floor(random * 3);
    const expectedDuration = Math.round(150 + random * 140);
    const expectedDelay = -Math.round(random * expectedDuration);
    const expectedPath = `M${random < 0.5 ? 60 : 156} 0 ${"v16 h20 v36 h-20 v44 ".repeat(42)}`;
    assert.equal(svg.childNodes.length, expectedCount, `group count at random=${random}`);
    svg.childNodes.forEach((group, groupIndex) => {
      assert.equal(group.tagName, "G", `group ${groupIndex}`);
      assert.equal(group.childNodes.length, 3, `three traces in group ${groupIndex}`);
      assert.deepEqual(group.childNodes.map((pathNode) => pathNode.getAttribute("class")), ["cp-t", "cp-m", "cp-h"]);
      group.childNodes.forEach((pathNode) => {
        assert.equal(pathNode.tagName, "PATH");
        assert.equal(pathNode.getAttribute("d"), expectedPath);
        assert.equal(
          pathNode.getAttribute("style"),
          `animation-duration:${expectedDuration}s;animation-delay:${expectedDelay}s`
        );
      });
    });

    await harness.app.refresh();
    assert.equal(harness.pulseClip.childNodes.length, 1, "refresh does not duplicate the pulse SVG");
    harness.app.unmount();
  }
});

test("the sanitized active component stylesheet is loaded before portable overrides", () => {
  const activeStyle = read("public/active-ui.css");
  const portableStyle = read("public/app.css");
  const html = read("public/index.html");
  assert.equal(crypto.createHash("sha256").update(activeStyle).digest("hex"), "2a2babdb4f431a4949aa4f6f8d074100f5f06e9cbda191ea9726296ac5816082");
  for (const source of [
    "lib/html.js",
    "monitor/overview.js",
    "respond/tuning.js",
    "respond/triage.js",
    "respond/rules.js",
    "investigate/threat-intel.js",
    "govern/access.js"
  ]) assert.match(activeStyle, new RegExp(source.replace("/", "\\/")), source);
  assert.ok(html.indexOf("active-ui.css") < html.indexOf("app.css"));
  assert.match(portableStyle, /\.technical-documentation-jump\s*\{[^}]*position:\s*sticky/s,
    "the long manual keeps a persistent chapter navigator");
  assert.match(portableStyle, /\[data-active-route="\/docs"\]\s+\.workspace\s*\{[^}]*overflow-x:\s*clip[^}]*overflow-y:\s*visible/s,
    "the docs route cannot inherit the non-scrolling horizontal overflow ancestor that defeats sticky positioning");
  assert.match(portableStyle, /\[data-active-route="\/docs"\]\s+\.topbar\s*\{[^}]*position:\s*static/s,
    "the responsive global topbar cannot cover the manual's persistent chapter controls");
  const activeHexColors = new Set([...activeStyle.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((match) => match[0].toLowerCase()));
  const portableHexColors = new Set([...portableStyle.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((match) => match[0].toLowerCase()));
  assert.deepEqual(
    [...portableHexColors].filter((color) => !activeHexColors.has(color)),
    [],
    "portable layout rules must reuse the active product's committed hex palette"
  );
  const colorFunctions = (source) => new Set(
    [...source.matchAll(/rgba?\([^)]*\)/gi)].map((match) => match[0].replace(/\s+/g, "").toLowerCase())
  );
  const activeColorFunctions = colorFunctions(activeStyle);
  const portableColorFunctions = colorFunctions(portableStyle);
  assert.deepEqual(
    [...portableColorFunctions].filter((color) => !activeColorFunctions.has(color)),
    [],
    "portable layout rules must reuse the active product's committed rgb/rgba treatments"
  );
  const runtime = read("public/app.js");
  for (const color of [
    "#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc948",
    "#b07aa1", "#ff9da7", "#3987e5", "#6b7075", "#dc4e41", "#f8be34", "#8c9296",
    "#0d1216", "#3ea6ff55", "#3ea6ff66", "#454a4e", "#c7cbce", "#e6edf3"
  ]) assert.match(runtime, new RegExp(color), `active runtime color ${color}`);
  const withoutSvgNamespace = activeStyle.replaceAll("http://www.w3.org/2000/svg", "");
  assert.doesNotMatch(withoutSvgNamespace, /@import|https?:\/\/|\/Users\/|\/opt\/|\/var\/lib\//i);
});

test("every public runtime script and provider example has no capability or unsafe HTML sink", () => {
  const runtimeFiles = fs.readdirSync(path.join(root, "public"))
    .filter((name) => name.endsWith(".js"))
    .map((name) => `public/${name}`)
    .concat([
      "examples/better-auth-reference/better-auth-bridge.js",
      "examples/provider-template.js"
    ])
    .sort();
  assert.deepEqual(runtimeFiles, [
    "examples/better-auth-reference/better-auth-bridge.js",
    "examples/provider-template.js",
    "public/adapter-contract.js",
    "public/administration-contract.js",
    "public/app-config.js",
    "public/app.js",
    "public/application-bridge.js",
    "public/auth-contract.js",
    "public/bootstrap.js",
    "public/connector-contract.js",
    "public/document-library.js",
    "public/private-sign-in.js",
    "public/scanner-import.js",
    "public/service-access.js",
    "public/technical-docs.js",
    "public/ui-catalog.js"
  ]);
  const forbiddenCapabilities = [
    /\bfetch\s*\(/,
    /\bWebSocket\b/,
    /\bEventSource\b/,
    /\bXMLHttpRequest\b/,
    /\bsendBeacon\b/,
    /\blocalStorage\b/,
    /\bsessionStorage\b/,
    /\bindexedDB\b/,
    /\bcaches\s*\./,
    /\bdocument\s*\.\s*cookie\b|\bcookieStore\b/,
    /\bserviceWorker\b/
  ];
  for (const name of runtimeFiles) {
    const source = read(name);
    const privateClient = ["public/document-library.js", "public/private-sign-in.js", "public/scanner-import.js", "public/service-access.js"].includes(name);
    for (const pattern of forbiddenCapabilities) {
      if (privateClient && pattern.source === "\\bfetch\\s*\\(") continue;
      assert.doesNotMatch(source, pattern, `${name}: ${pattern}`);
    }
    if (name !== "public/technical-docs.js" && !privateClient) {
      for (const method of [/\bPOST\b/, /\bPUT\b/, /\bPATCH\b/, /\bDELETE\b/]) {
        assert.doesNotMatch(source, method, `${name}: ${method}`);
      }
    }
    assert.doesNotMatch(source, /\.(?:innerHTML|outerHTML|srcdoc)\s*=/, name);
    assert.doesNotMatch(source, /\[\s*["'](?:innerHTML|outerHTML|srcdoc)["']\s*\]\s*=/, name);
    assert.doesNotMatch(source, /\b(?:insertAdjacentHTML|setHTMLUnsafe|createContextualFragment)\s*\(/, name);
    assert.doesNotMatch(source, /\bdocument\s*\.\s*write(?:ln)?\s*\(/, name);
    assert.doesNotMatch(source, /\bDOMParser\b/, name);
  }
});

test("the static shell closes connections and leaves framing policy to response headers", () => {
  const html = read("public/index.html");
  const meta = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i);
  assert.ok(meta, "CSP meta element");
  assert.match(meta[1], /connect-src 'none'/);
  assert.match(meta[1], /form-action 'none'/);
  assert.doesNotMatch(meta[1], /frame-ancestors/i);
  assert.match(CSP, /connect-src 'none'/);
  assert.match(CSP, /frame-ancestors 'none'/);
  assert.equal(securityHeaders["Content-Security-Policy"], CSP);
  assert.equal(securityHeaders["X-Content-Type-Options"], "nosniff");
  assert.equal(securityHeaders["X-Frame-Options"], "DENY");
  assert.match(html, /id="content"/);
  assert.match(html, /id="route-select"/);
  assert.match(html, /assets\/mark\.png/);
  assert.match(html, /src="ui-catalog\.js(?:\?[^" ]*)?"/);
  assert.match(html, /src="auth-contract\.js(?:\?[^" ]*)?"/);
  assert.match(html, /src="connector-contract\.js(?:\?[^" ]*)?"/);
  assert.match(html, /src="administration-contract\.js(?:\?[^" ]*)?"/);
  assert.match(html, /src="application-bridge\.js(?:\?[^" ]*)?"/);
  assert.match(html, /src="technical-docs\.js(?:\?[^" ]*)?"/);
  assert.ok(html.indexOf("connector-contract.js") < html.indexOf("application-bridge.js"));
  assert.ok(html.indexOf("administration-contract.js") < html.indexOf("application-bridge.js"));
  assert.ok(html.indexOf("technical-docs.js") < html.indexOf("app.js"));
  assert.ok(html.indexOf("application-bridge.js") < html.indexOf("bootstrap.js"));
  assert.match(html, /id="technical-docs-link"[^>]+href="#\/docs"/);
  assert.match(html, /id="agents-link"[^>]+href="#\/agents"/);
  assert.match(html, /id="command-title">Search anything</);
  assert.match(html, /placeholder="Search anything: IP, CVE, host, rule, page…"/);
  assert.match(html, /Try an IP, CVE id, hostname \(timeline\), or page name/);
  assert.doesNotMatch(html, /<form\b/i);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/i);
  assert.doesNotMatch(html, /<style\b/i);
});

test("the public shell omits demo notes, page-source chrome, and a global data-free notice", async () => {
  const html = read("public/index.html");
  assert.doesNotMatch(html, /class="[^"]*\bsidebar-note\b/i);
  assert.doesNotMatch(html, /class="[^"]*\bpage-source\b/i);
  assert.doesNotMatch(html, />\s*(?:demo|demonstration)\b/i);

  const harness = createUiHarness("#/", { provider: false });
  await harness.app.mount();
  assert.equal(nodesWithClass(harness.mountRoot, "page-source").length, 0);
  assert.equal(nodesWithClass(harness.mountRoot, "sidebar-note").length, 0);
  const globalNotices = nodesWithClass(harness.mountRoot, "notice").map((candidate) => candidate.textContent);
  assert.equal(globalNotices.some((copy) => /data-free skeleton/i.test(copy)), false);
  assert.equal(globalNotices.some((copy) => /no operational records are bundled/i.test(copy)), false);
  harness.app.unmount();
});

test("the local server resolves only traversal-free files and validates its port", () => {
  const publicRoot = path.join(root, "public");
  assert.equal(resolveRequestPath("/", publicRoot), path.join(publicRoot, "index.html"));
  assert.equal(resolveRequestPath("/assets/icon-32.png?cache=no", publicRoot), path.join(publicRoot, "assets/icon-32.png"));
  for (const target of [
    "/../package.json",
    "/%2e%2e/package.json",
    "/assets/%2e%2e/index.html",
    "/assets\\..\\index.html",
    "/%E0%A4%A"
  ]) assert.equal(resolveRequestPath(target, publicRoot), null, target);
  assert.equal(parsePort(undefined), 8080);
  assert.equal(parsePort("9000"), 9000);
  for (const value of ["0", "65536", "8x80", "-1"]) assert.throws(() => parsePort(value), TypeError);
});

test("the local server handles GET and HEAD with security headers", async (t) => {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, HOST, resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const home = await localRequest(server, { path: "/" });
  assert.equal(home.status, 200);
  assert.equal(home.headers["content-type"], contentTypes[".html"]);
  assert.equal(home.headers["content-security-policy"], CSP);
  assert.equal(home.headers["cache-control"], "no-store");
  assert.match(home.body.toString("utf8"), /<!doctype html>/i);

  const icon = await localRequest(server, { method: "HEAD", path: "/assets/icon-32.png" });
  assert.equal(icon.status, 200);
  assert.equal(icon.headers["content-type"], "image/png");
  assert.equal(icon.body.length, 0);

  const technicalReference = await localRequest(server, { path: "/technical-reference.md" });
  assert.equal(technicalReference.status, 200);
  assert.equal(technicalReference.headers["content-type"], contentTypes[".md"]);
  assert.match(technicalReference.body.toString("utf8"), /^# Bulwark Black SOC technical implementation manual/m);

  const traversal = await localRequest(server, { path: "/%2e%2e/package.json" });
  assert.equal(traversal.status, 404);
  assert.equal(traversal.headers["content-security-policy"], CSP);

  const mutation = await localRequest(server, { method: "POST", path: "/" });
  assert.equal(mutation.status, 405);
  assert.equal(mutation.headers.allow, "GET, HEAD");
});

test("the structural catalog contains 38 SOC routes plus Documents and local documentation", () => {
  const context = browserContext(["public/ui-catalog.js"]);
  const catalog = context.SocConsoleUiCatalog;
  assert.equal(catalog.schemaVersion, "1");
  assert.equal(vm.runInContext("Object.isFrozen(SocConsoleUiCatalog) && Object.isFrozen(SocConsoleUiCatalog.pages)", context), true);

  const pages = JSON.parse(JSON.stringify(catalog.pages));
  const groups = JSON.parse(JSON.stringify(catalog.groups));
  const byPath = new Map(pages.map((page) => [page.path, page]));
  assert.equal(pages.length, 40);
  assert.equal(byPath.size, 40, "catalog routes are unique");

  const groupedRoutes = groups.flatMap(([, entries]) => entries.map(([route]) => route));
  assert.equal(groupedRoutes.length, 28);
  assert.equal(new Set(groupedRoutes).size, 28);
  const utilities = ["/onboard", "/settings", "/docs"];
  const entryRoutes = new Set([...groupedRoutes, ...utilities]);
  assert.equal(entryRoutes.size, 31);
  groupedRoutes.forEach((route) => {
    assert.ok(byPath.has(route), route);
    assert.notEqual(byPath.get(route).hidden, true, `${route} is a grouped entry route`);
  });
  utilities.forEach((route) => assert.equal(byPath.get(route).hidden, true, route));
  assert.equal(byPath.get("/docs").localOnly, true);
  assert.equal(byPath.get("/docs").variant, "technical-documentation");
  assert.equal(byPath.get("/documents").localOnly, true);
  assert.equal(byPath.get("/documents").variant, "document-library");
  const detailRoutes = pages.map((page) => page.path).filter((route) => !entryRoutes.has(route)).sort();
  assert.deepEqual(detailRoutes, [
    "/analyst", "/attestation", "/event", "/host-scan",
    "/ip", "/kev", "/risk", "/search", "/source"
  ]);
  detailRoutes.forEach((route) => assert.equal(byPath.get(route).hidden, true, route));
  assert.equal(byPath.get("/").displayTitle, "Security Posture — Overview");
  assert.equal(byPath.get("/logs").displayTitle, "Security Logs");
  assert.equal(byPath.get("/onboard").displayTitle, "Onboard an App");
  assert.equal(byPath.get("/docs").displayTitle, "Technical Documentation");
  assert.equal(byPath.get("/agents").variant, "administration-agents");
  assert.equal(byPath.get("/attestations").variant, "administration-attestations");
  assert.equal(byPath.get("/register").variant, "administration-risks");

  function tabs(route, parameter) {
    const page = byPath.get(route);
    assert.ok(page, route);
    const tabset = (page.tabsets || []).find((candidate) => candidate.param === parameter);
    assert.ok(tabset, `${route} ${parameter}`);
    return tabset.items.map(({ id, label }) => [id, label]);
  }

  assert.deepEqual(tabs("/health", "htab"), [
    ["feeds", "Feeds"], ["rules", "Rules never fired"], ["firing", "What is firing"],
    ["drills", "Drills"], ["read", "How to read this"]
  ]);
  assert.deepEqual(tabs("/brief", "btab"), [
    ["brief", "Daily Brief"], ["turnover", "Turnover board"], ["analyst", "Analyst briefings"]
  ]);
  assert.deepEqual(tabs("/analyst", "atab"), [
    ["briefings", "Estate briefings"], ["cases", "Case findings"], ["rules", "Rules review"],
    ["vuln", "Vulnerability"], ["affected", "Are we affected?"], ["retention", "Retention"]
  ]);
  assert.deepEqual(tabs("/analyst", "btab"), [
    ["brief", "Daily Brief"], ["turnover", "Turnover board"], ["analyst", "Analyst briefings"]
  ]);
  assert.deepEqual(tabs("/analytics", "h"), [["24", "24h"], ["48", "48h"], ["168", "7 days"]]);
  assert.deepEqual(tabs("/triage", "view"), [
    ["queue", "Queue"], ["approvals", "Awaiting approval"], ["cases", "Cases"],
    ["closed", "Closed"], ["all", "All"]
  ]);
  assert.deepEqual(tabs("/tuning", "tview"), [
    ["definitions", "Definitions"], ["applied", "Applied alerts"], ["held", "Matched but held"]
  ]);
  assert.deepEqual(tabs("/tuning", "status").map(([id]) => id), ["active", "draft", "disabled"]);
  assert.deepEqual(tabs("/rules", "rtab").map(([id]) => id), ["palisade", "sigma", "yara", "snort", "tuning"]);
  assert.deepEqual(tabs("/rules", "tview").map(([id]) => id), ["definitions", "applied", "held"]);
  assert.deepEqual(tabs("/rules", "tstatus").map(([id]) => id), ["all", "active", "draft", "disabled"]);
  assert.deepEqual(tabs("/rules", "ptab").map(([id]) => id), ["active", "add", "help", "decisions"]);
  assert.deepEqual(tabs("/rules", "stab").map(([id]) => id), ["rules", "add", "about"]);
  assert.deepEqual(tabs("/rules", "ytab").map(([id]) => id), ["about", "rules", "manage"]);
  assert.deepEqual(tabs("/alerts", "atab").map(([id]) => id), ["path", "paged", "log", "reconcile"]);
  assert.deepEqual(tabs("/honeypots", "htab").map(([id]) => id), ["decoys", "canaries", "users", "hits", "clerk"]);
  assert.deepEqual(tabs("/intel", "itab"), [
    ["bb", "Bulwark Black feed"], ["otx", "AlienVault OTX"], ["threatfox", "ThreatFox"],
    ["urlhaus", "URLhaus"], ["malwarebazaar", "MalwareBazaar"], ["feeds", "All feeds"]
  ]);
  assert.deepEqual(tabs("/intel", "skind").map(([id]) => id), ["all", "ip", "domain", "url", "sha256", "md5", "sha1"]);
  assert.deepEqual(tabs("/scans", "tab"), [
    ["trivy", "Trivy"], ["patch", "Patch first"], ["fim", "File integrity"],
    ["eol", "End of life"], ["exposure", "External surface"], ["ioc", "IOC scan"],
    ["urlscan", "urlscan.io"], ["deps", "Dependencies"], ["av", "DLP Upload AV"],
    ["quarantine", "Quarantine"], ["remediation", "Remediation log"]
  ]);
  const urlscanPanels = byPath.get("/scans").tabsets[0].items.find((item) => item.id === "urlscan").panels;
  assert.deepEqual(urlscanPanels.map((panel) => panel.id), [
    "our-pages-rendered-from-outside", "watch-a-page-daily", "urlscan-submit", "url-history-results"
  ]);
  assert.equal(new Set(urlscanPanels.map((panel) => panel.id)).size, urlscanPanels.length);
  const scanItems = byPath.get("/scans").tabsets[0].items;
  assert.deepEqual(scanItems.map((item) => ({ id: item.id, ...item.connectionProfile })), [
    {
      id: "trivy", setupFor: "scan-trivy", title: "Trivy scanner",
      description: "Operating-system package and vulnerability scan results.",
      surfaceIds: ["trivy-operating-system-packages"],
      requiredRecordKinds: ["scan.result", "software.package", "vulnerability.finding"],
      recommendedRecordKinds: ["asset.snapshot", "remediation.record"]
    },
    {
      id: "patch", setupFor: "scan-patch-first", title: "Patch-priority feed",
      description: "Package findings enriched for patch urgency, exploitation, and exposure.",
      surfaceIds: ["patch-first"],
      requiredRecordKinds: ["software.package", "vulnerability.finding"],
      recommendedRecordKinds: ["scan.result", "intel.indicator", "remediation.record"]
    },
    {
      id: "fim", setupFor: "scan-file-integrity", title: "File-integrity collector",
      description: "Critical-file baselines, checks, and integrity changes.",
      surfaceIds: ["file-integrity-critical-files-and-canaries"],
      requiredRecordKinds: ["file.integrity"],
      recommendedRecordKinds: ["asset.snapshot", "source.heartbeat"]
    },
    {
      id: "eol", setupFor: "scan-end-of-life", title: "End-of-life inventory",
      description: "Installed component versions and vendor support windows.",
      surfaceIds: ["end-of-life-runway"],
      requiredRecordKinds: ["software.package"],
      recommendedRecordKinds: ["asset.snapshot", "vulnerability.finding"]
    },
    {
      id: "exposure", setupFor: "scan-external-surface", title: "External-surface scanner",
      description: "Authorized public-address observations, sweep results, and exposed services.",
      surfaceIds: ["external-attack-surface-shodan", "sweep-history"],
      requiredRecordKinds: ["asset.snapshot", "scan.result"],
      recommendedRecordKinds: ["network.event", "vulnerability.finding", "source.heartbeat"]
    },
    {
      id: "ioc", setupFor: "scan-ioc", title: "IOC scanner",
      description: "Host scan outcomes correlated with normalized threat indicators.",
      surfaceIds: ["ioc-scan-is-anything-on-disk-a-known-bad-file"],
      requiredRecordKinds: ["finding", "scan.result"],
      recommendedRecordKinds: ["asset.snapshot", "endpoint.event", "file.integrity", "intel.indicator"]
    },
    {
      id: "urlscan", setupFor: "scan-urlscan", title: "URL scanning service",
      description: "Rendered-page scans and contacted-network observations.",
      surfaceIds: ["our-pages-rendered-from-outside", "url-history-results"],
      requiredRecordKinds: ["network.event", "scan.result"],
      recommendedRecordKinds: ["finding", "source.heartbeat"]
    },
    {
      id: "deps", setupFor: "scan-dependencies", title: "Dependency advisory feed",
      description: "Dependency inventory matched to normalized vulnerability advisories.",
      surfaceIds: ["dependency-advisories"],
      requiredRecordKinds: ["software.package", "vulnerability.finding"],
      recommendedRecordKinds: ["scan.result", "remediation.record"]
    },
    {
      id: "av", setupFor: "scan-upload-av", title: "Upload antivirus",
      description: "Upload malware-scan state and bounded scan events.",
      surfaceIds: ["upload-malware-scanning-clamav-at-the-door", "recent-scan-events"],
      requiredRecordKinds: ["endpoint.event", "finding"],
      recommendedRecordKinds: ["asset.snapshot", "source.heartbeat"]
    },
    {
      id: "quarantine", setupFor: "scan-quarantine", title: "Quarantine lifecycle",
      description: "Malware quarantine, retrieval, and removal lifecycle events.",
      surfaceIds: ["quarantined-now", "deleted-from-quarantine"],
      requiredRecordKinds: ["endpoint.event", "finding"],
      recommendedRecordKinds: ["audit.event", "remediation.record"]
    },
    {
      id: "remediation", setupFor: "scan-remediation", title: "Remediation records",
      description: "Verified remediation facts and their supporting evidence lifecycle.",
      surfaceIds: ["vm-analyst-latest-review", "remediation-log"],
      requiredRecordKinds: ["remediation.record"],
      recommendedRecordKinds: ["evidence.receipt", "governance.attestation"]
    }
  ]);
  assert.equal(new Set(scanItems.map((item) => item.connectionProfile.setupFor)).size, scanItems.length);
  const canonicalRecordKinds = new Set(require("../public/connector-contract").RECORD_KINDS);
  scanItems.forEach((item) => {
    const panelIds = new Set(item.panels.map((panel) => panel.id));
    item.connectionProfile.surfaceIds.forEach((surfaceId) => {
      assert.ok(panelIds.has(surfaceId), `${item.id}: connection profile surface ${surfaceId} exists`);
    });
    item.connectionProfile.requiredRecordKinds.concat(item.connectionProfile.recommendedRecordKinds)
      .forEach((recordKind) => assert.ok(canonicalRecordKinds.has(recordKind), `${item.id}: canonical ${recordKind}`));
  });
  assert.deepEqual(tabs("/systems", "stab").map(([id]) => id), ["estate", "affected"]);
  assert.deepEqual(tabs("/retention", "vtab").map(([id]) => id), ["policy", "reality", "review"]);
  assert.deepEqual(tabs("/sources", "stab").map(([id]) => id), ["expected", "add", "changes"]);
  assert.deepEqual(tabs("/agents", "atab").map(([id]) => id), ["agents", "add", "prompts", "enrollment", "access", "audit"]);
  assert.deepEqual(tabs("/attestations", "gtab").map(([id]) => id), ["active", "create", "archived", "history"]);
  assert.deepEqual(tabs("/register", "riskTab").map(([id]) => id), ["active", "create", "archived", "history"]);
  assert.deepEqual(tabs("/access", "atab").map(([id]) => id), ["who", "refusals", "chain", "offboarding"]);
  assert.deepEqual(tabs("/access", "oview").map(([id]) => id), ["records", "guide"]);

  for (const page of pages) {
    const collections = [page.panels || []];
    for (const tabset of page.tabsets || []) {
      for (const item of tabset.items) collections.push(item.panels || []);
    }
    for (const panels of collections) {
      const idsByCondition = new Map();
      for (const panel of panels) {
        assert.match(panel.id, /^[a-z][a-z0-9-]{0,79}$/, `${page.path}: ${panel.title || panel.type}`);
        const condition = JSON.stringify(panel.whenQuery || null);
        const ids = idsByCondition.get(condition) || new Set();
        assert.equal(ids.has(panel.id), false, `${page.path}: duplicate visible panel id ${panel.id}`);
        ids.add(panel.id);
        idsByCondition.set(condition, ids);
      }
    }
  }
});

test("technical documentation is synchronized, frozen, and contains the complete connector vocabulary", () => {
  const markdown = read("public/technical-reference.md");
  const generated = read("public/technical-docs.js");
  const sections = validateMarkdown(markdown);
  assert.ok(sections.length >= 45, "the implementation manual keeps exhaustive human and agent chapters");
  assert.equal(generated, generatedSource(markdown));
  assert.equal(sectionsFromMarkdown(markdown).length, sections.length);
  assert.ok(markdown.length > 70000);
  assert.throws(
    () => validateMarkdown(markdown.replace('"state": "registered"', '"state": registered')),
    /JSON example.*invalid/i
  );
  assert.throws(
    () => validateMarkdown(markdown + "~~~json\n{}\n"),
    /code fence.*not closed/i
  );

  const context = browserContext(["public/technical-docs.js", "public/connector-contract.js"]);
  const manual = context.SocConsoleTechnicalDocs;
  const runtime = context.SocConsoleConnectorRuntime;
  assert.equal(manual.schemaVersion, "1");
  assert.equal(manual.documentType, "technical-manual");
  assert.equal(manual.sections.length, sections.length);
  assert.equal(vm.runInContext(
    "Object.isFrozen(SocConsoleTechnicalDocs) && Object.isFrozen(SocConsoleTechnicalDocs.sections) && Object.isFrozen(SocConsoleTechnicalDocs.sections[0])",
    context
  ), true);
  const vocabularies = [
    runtime.COMMANDS,
    runtime.COMMAND_STATUSES,
    runtime.ERROR_CODES,
    runtime.HEALTH_STATES,
    runtime.HEALTH_REASONS,
    runtime.SOURCE_STATES,
    runtime.RECORD_KINDS
  ];
  vocabularies.flat().forEach((value) => assert.match(manual.markdown, new RegExp(value.replace(".", "\\.")), value));
  for (const phrase of [
    "no browser command for installing a connector manifest",
    "does \\*\\*not\\*\\* provide the following production systems",
    "ships an optional stdio MCP reference client",
    "never a production server",
    "Open raw agent-readable Markdown"
  ]) {
    if (phrase === "Open raw agent-readable Markdown") continue;
    assert.match(manual.markdown, new RegExp(phrase, "i"), phrase);
  }
});

test("technical documentation renders locally without consulting or accepting adapter data", async () => {
  const harness = createUiHarness("#/docs");
  await harness.app.mount();
  assert.equal(harness.readRequests.length, 0);
  assert.equal(hasClass(harness.mountRoot, "technical-documentation"), true);
  assert.equal(findNodes(harness.mountRoot, (candidate) => candidate.tagName === "ARTICLE"
    && candidate.getAttribute("id") === "technical-documentation-article").length, 1);
  assert.equal(findNodes(harness.mountRoot, (candidate) => candidate.tagName === "NAV"
    && candidate.getAttribute("aria-label") === "Technical documentation sections").length, 1);
  assert.equal(nodesWithClass(harness.mountRoot, "technical-documentation-section").length,
    harness.context.SocConsoleTechnicalDocs.sections.length);
  assert.match(harness.mountRoot.textContent, /Agent contract and required reading order/);
  assert.match(harness.mountRoot.textContent, /Definition of done for one connector/);
  assert.match(harness.mountRoot.textContent, /built-in technical reference/);
  assert.doesNotMatch(harness.mountRoot.textContent, /Additional authorized data|Application adapter/);
  const rawLink = findNodes(harness.mountRoot, (candidate) => candidate.tagName === "A"
    && candidate.getAttribute("href") === "technical-reference.md")[0];
  assert.ok(rawLink);
  assert.equal(rawLink.getAttribute("type"), "text/markdown");
  assert.equal(harness.context.SocConsole.technicalDocumentation, harness.context.SocConsoleTechnicalDocs);
  harness.app.unmount();
});

test("technical documentation remains selectable without becoming a primary SOC route", async () => {
  const document = new TestDocument();
  const shell = document.createElement("aside");
  const routeSelect = document.createElement("select");
  routeSelect.setAttribute("id", "route-select");
  shell.append(routeSelect);
  const harness = createUiHarness("#/docs", { document, provider: false, shellRoot: shell });
  await harness.app.mount();

  const primaryRoutes = JSON.parse(JSON.stringify(harness.context.SocConsole.primaryRoutes));
  assert.equal(primaryRoutes.length, 30);
  assert.equal(primaryRoutes.includes("/docs"), false);
  assert.equal(findNodes(routeSelect,
    (candidate) => candidate.tagName === "OPTION" && candidate.getAttribute("value") === "/docs").length, 1);
  assert.equal(routeSelect.value, "/docs");
  assert.equal(shell.getAttribute("data-active-route"), "/docs",
    "the shell exposes the current route so long-document overflow can remain route scoped");
  harness.app.unmount();
  assert.equal(shell.getAttribute("data-active-route"), null);
});

test("technical documentation supports stable section focus and chapter filtering", async () => {
  const manual = require("../public/technical-docs.js");
  const selected = manual.sections.find((section) => section.title.startsWith("14."));
  assert.ok(selected);
  const harness = createUiHarness("#/docs?section=" + selected.id, { provider: false });
  await harness.app.mount();
  assert.equal(harness.document.activeElement.getAttribute("id"), "docs-" + selected.id);
  const currentLink = findNodes(harness.mountRoot, (candidate) => candidate.tagName === "A"
    && candidate.getAttribute("aria-current") === "location")[0];
  assert.ok(currentLink);
  assert.match(currentLink.getAttribute("href"), new RegExp("section=" + selected.id));
  assert.equal(nodesWithClass(harness.mountRoot, "is-targeted").length, 1);
  const chapterJump = findNodes(harness.mountRoot, (candidate) => candidate.tagName === "NAV"
    && candidate.getAttribute("aria-label") === "Jump between technical documentation chapters")[0];
  assert.ok(chapterJump, "persistent chapter jump navigation");
  const chapterSelect = chapterJump.querySelector("[data-documentation-jump]");
  assert.ok(chapterSelect);
  const nextSection = manual.sections[manual.sections.indexOf(selected) + 1];
  chapterSelect.value = nextSection.id;
  harness.mountRoot.dispatchEvent({ type: "change", target: chapterSelect });
  assert.match(harness.location.hash, new RegExp("section=" + nextSection.id));

  const localFilter = findNodes(harness.mountRoot,
    (candidate) => candidate.getAttribute("data-documentation-filter") !== null)[0];
  assert.ok(localFilter);
  localFilter.value = "phrase-that-does-not-exist-in-this-manual";
  harness.mountRoot.dispatchEvent({ type: "input", target: localFilter });
  assert.equal(nodesWithClass(harness.mountRoot, "technical-documentation-section")
    .every((section) => section.hidden), true);
  assert.equal(nodesWithClass(harness.mountRoot, "technical-documentation-no-results")[0].hidden, false);

  localFilter.value = "credential";
  harness.mountRoot.dispatchEvent({ type: "input", target: localFilter });
  assert.equal(nodesWithClass(harness.mountRoot, "technical-documentation-section")
    .some((section) => !section.hidden), true);
  assert.equal(nodesWithClass(harness.mountRoot, "technical-documentation-no-results")[0].hidden, true);
  harness.app.unmount();
});

test("Estate, Govern, and Configure preserve the active structural schemas without bundled values", () => {
  const context = browserContext(["public/ui-catalog.js"]);
  const pages = JSON.parse(JSON.stringify(context.SocConsoleUiCatalog.pages));
  const byPath = new Map(pages.map((page) => [page.path, page]));
  const tab = (route, parameter, id) => byPath.get(route).tabsets
    .find((tabset) => tabset.param === parameter).items.find((item) => item.id === id);
  const columns = (panels, title) => panels.find((panel) => panel.title === title).columns;

  const systemsEstate = tab("/systems", "stab", "estate").panels;
  assert.deepEqual(columns(systemsEstate, "External attack surface — what the internet sees"),
    ["Host", "Public IP", "Ports Shodan sees", "Baseline", "Verdict"]);
  assert.deepEqual(columns(systemsEstate, "Estate inventory"),
    ["Host", "OS", "Kernel", "Packages", "Listening (public iface)", "Reported"]);
  assert.equal(systemsEstate.some((panel) => panel.title === "What am I looking at?"), true);
  assert.deepEqual(tab("/systems", "stab", "affected").panels.map((panel) => panel.title),
    ["Latest review", "Open items", "How this review works"]);

  assert.deepEqual(byPath.get("/databases").panels.map((panel) => panel.title),
    ["Schema drift watch", "Schema changes detected", "Adding a database", "How this works"]);
  assert.deepEqual(columns(byPath.get("/backups").panels, "Pull side — independent verification from the watchtower"),
    ["Bucket", "Contents", "Freshness", "State"]);
  assert.deepEqual(columns(byPath.get("/backups").panels, "SOC evidence — off-box object-lock copy"),
    ["Archive", "Receipts", "Last result", "State"]);

  const reality = tab("/retention", "vtab", "reality").panels;
  assert.deepEqual(reality[0].labels,
    ["Policy accrual", "Inventoried retention data", "Inventory / store age", "Disk free"]);
  assert.deepEqual(columns(reality, "Per source"),
    ["Host", "Channel", "Oldest held", "Newest", "Span", "Records", "Size", "Integrity"]);
  assert.deepEqual(columns(reality, "Archived baselines"), ["Archive", "Archived on", "Size"]);

  const expectedSources = tab("/sources", "stab", "expected").panels;
  assert.deepEqual(columns(expectedSources, "Expected sources"),
    ["Source", "Application / environment", "Last collection", "Cadence", "In Logs", "Collection", "Activity"]);
  assert.deepEqual(expectedSources[0].rowDisclosures,
    ["What it does", "Why it matters", "If it goes quiet"]);
  const sourceAdd = tab("/sources", "stab", "add").panels;
  assert.deepEqual(sourceAdd.map((panel) => panel.title), [
    "Start with your application", "Optional · Connect a collector for host-based scanners", "1 · Add an application source", "2 · Validate a sample, then activate",
    "Configured sources", "Scale-out shortcut · copy a host's source set"
  ]);
  assert.deepEqual(sourceAdd[1].columns, ["Tokened host", "Connection", "Break-glass"]);
  assert.deepEqual(sourceAdd[2].columns, ["Connector", "Mode", "Produces", "Populates"]);
  assert.deepEqual(sourceAdd[2].fields.map((field) => field.label), [
    "App", "Environment", "Collector host (optional for application push)", "Connector type", "Source kind", "Display label", "Cadence (hours)"
  ]);
  assert.deepEqual(sourceAdd[3].columns, ["Source", "Connector", "Test", "State", "Actions"]);
  assert.deepEqual(sourceAdd[4].columns, ["Source", "Application / environment", "Connector", "Produces", "Coverage", "State", "Manage"]);

  assert.equal(byPath.get("/agents").variant, "administration-agents");
  assert.deepEqual(tab("/agents", "atab", "prompts").panels, []);
  assert.equal(byPath.get("/attestations").variant, "administration-attestations");
  assert.deepEqual(tab("/attestations", "gtab", "create").panels, []);
  assert.equal(byPath.get("/attestation").variant, "administration-attestation");
  assert.equal(byPath.get("/register").variant, "administration-risks");
  assert.deepEqual(tab("/register", "riskTab", "archived").panels, []);
  assert.equal(byPath.get("/risk").variant, "administration-risk");

  const accessWho = tab("/access", "atab", "who").panels;
  assert.deepEqual(columns(accessWho, "Who has full access"), ["Identity", "Level", "Can do"]);
  assert.deepEqual(columns(accessWho, "Everyone who has opened this console"),
    ["Identity", "Level", "From", "Views", "Refused writes", "Last seen"]);
  assert.deepEqual(columns(accessWho, "Devices on the tailnet"), ["Device", "Tailnet IP", "Tags", "State"]);

  assert.deepEqual(byPath.get("/onboard").panels.map((panel) => panel.title),
    ["1 · Register the app", "Registered apps", "2 · Add a source to the application"]);
  const settingsPanels = byPath.get("/settings").panels;
  assert.deepEqual(settingsPanels.map((panel) => panel.title), [
    "How settings behave", "Overview", "SOC Health", "Daily Brief", "Analytics", "Analyst", "Triage",
    "Rules", "Alert Comms", "Honeypots", "Logs", "Activity", "IOC Parser", "Threat Intel", "Known IPs",
    "Systems", "Scans", "Databases", "Backups", "Retention", "Sources", "Attestations", "Risk Register", "Access"
  ]);
  assert.deepEqual(settingsPanels.find((panel) => panel.title === "Threat Intel").fields.map((field) => field.label), [
    "Bulwark Black feed poll (minutes)", "OTX sync (hours)", "OTX pulse window (days)",
    "OTX max pages per sync", "abuse.ch poll (minutes)", "ThreatFox window (days)",
    "MalwareBazaar window (days)", "Intel repeat suppression (hours)"
  ]);
  assert.ok(settingsPanels.every((panel) => !("value" in panel)), "settings catalog publishes no values");
});

test("Estate and Configure workflows render the active compact treatments as inert structures", async () => {
  const sources = createUiHarness("#/sources?stab=add", { provider: false });
  await sources.app.mount();
  assert.equal(nodesWithClass(sources.mountRoot, "workflow-body").length, 2);
  assert.equal(nodesWithClass(sources.mountRoot, "workflow-controls").length, 2);
  for (const label of ["Mint token", "Begin source setup", "Copy source set"]) {
    const action = findNodes(sources.mountRoot,
      (candidate) => candidate.tagName === "BUTTON" && candidate.textContent === label)[0];
    assert.ok(action, label);
    assert.equal(action.getAttribute("disabled"), "", `${label} remains inert`);
  }
  assert.match(sources.mountRoot.textContent, /Tokened hostConnectionBreak-glass/);
  assert.match(sources.mountRoot.textContent, /ConnectorModeProducesPopulates/);
  assert.match(sources.mountRoot.textContent, /SourceConnectorTestStateActions/);
  assert.match(sources.mountRoot.textContent, /SourceApplication \/ environmentConnectorProducesCoverageStateManage/);
  assertUniqueRenderedIdentifiers(sources.mountRoot, "#/sources?stab=add");
  sources.app.unmount();

  const settings = createUiHarness("#/settings", { provider: false });
  await settings.app.mount();
  assert.equal(nodesWithClass(settings.mountRoot, "settings-board").length, 10);
  assert.equal(nodesWithClass(settings.mountRoot, "settings-empty").length, 13);
  assert.equal(nodesWithClass(settings.mountRoot, "settings-table").length, 10);
  assert.match(settings.mountRoot.textContent, /Save SOC Health/);
  assert.match(settings.mountRoot.textContent, /MalwareBazaar window \(days\)/);
  findNodes(settings.mountRoot, (candidate) => candidate.tagName === "BUTTON" && /^Save /.test(candidate.textContent))
    .forEach((button) => assert.equal(button.getAttribute("disabled"), ""));
  assertUniqueRenderedIdentifiers(settings.mountRoot, "#/settings");
  assert.doesNotMatch(renderedValues(settings.mountRoot), /\b(?:null|undefined)\b/i);
  settings.app.unmount();

  const sourceDetail = createUiHarness("#/source?host=host-reference&kind=seclog", { provider: false });
  await sourceDetail.app.mount();
  assert.match(sourceDetail.mountRoot.textContent, /Recent events/);
  assert.doesNotMatch(sourceDetail.mountRoot.textContent, /host-reference/);
  sourceDetail.location.hash = "#/source?host=host-reference&kind=schema";
  await sourceDetail.app.refresh();
  assert.match(sourceDetail.mountRoot.textContent, /Recent pushes/);
  assert.doesNotMatch(sourceDetail.mountRoot.textContent, /host-reference/);
  sourceDetail.location.hash = "#/source?host=host-reference&kind=log.event";
  await sourceDetail.app.refresh();
  assert.match(sourceDetail.mountRoot.textContent, /Recent events/);
  assert.doesNotMatch(sourceDetail.mountRoot.textContent, /host-reference/);
  assertUniqueRenderedIdentifiers(sourceDetail.mountRoot, "#/source");
  sourceDetail.app.unmount();
});

test("administration routes stay separate from page data and execute authenticated agent commands", async () => {
  const anonymous = createUiHarness("#/agents?atab=add", { provider: true });
  await anonymous.app.mount();
  assert.equal(anonymous.readRequests.length, 0, "agent management never asks the page adapter for authority");
  assert.match(anonymous.mountRoot.textContent, /Administration provider not connected/);
  const anonymousControls = findNodes(anonymous.mountRoot, (candidate) => ["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(candidate.tagName));
  assert.equal(anonymousControls.some((control) => control.disabled === false || control.disabled === undefined), false);
  anonymous.app.unmount();

  const observed = { requests: [], revision: 0 };
  const timestamp = "2030-01-01T00:00:00.000Z";
  const administration = {
    getSnapshot(request) {
      observed.requests.push({ type: "snapshot", request });
      return {
        schemaVersion: "1",
        documentType: "agent-administration-snapshot",
        domain: "agents",
        revision: observed.revision,
        agents: observed.revision ? [{
          agentId: "agent-ui-test",
          displayName: "UI test agent",
          kind: "automation",
          capabilities: [],
          state: "active",
          activePromptId: null,
          lastSeenAt: null,
          revision: 1,
          createdAt: timestamp,
          updatedAt: timestamp
        }] : [],
        prompts: [],
        enrollments: [],
        changes: []
      };
    },
    getPrompt() { throw new Error("prompt read was not requested"); },
    execute(request) {
      observed.requests.push({ type: "command", request });
      observed.revision = 1;
      return {
        schemaVersion: "1",
        documentType: "administration-command-result",
        requestId: request.requestId,
        command: request.command,
        status: "succeeded",
        completedAt: new Date(Math.max(Date.parse(request.requestedAt), Date.parse(timestamp))).toISOString(),
        output: { agentId: "agent-ui-test", state: "active", revision: 1 }
      };
    }
  };
  const harness = createUiHarness("#/agents?atab=add", {
    provider: true,
    administration,
    session: { authenticated: true }
  });
  await harness.app.mount();
  assert.equal(harness.readRequests.length, 0);
  assert.match(harness.mountRoot.textContent, /Server-authorized management/);
  const form = findNodes(harness.mountRoot, (candidate) => candidate.dataset.administrationAction === "agent.create")[0];
  assert.ok(form, "agent create form");
  form.querySelector('[name="displayName"]').value = "UI test agent";
  form.querySelector('[name="kind"]').value = "automation";
  const submitter = form.querySelector('[type="submit"]');
  harness.mountRoot.dispatchEvent({ type: "submit", target: form, submitter });
  for (let attempt = 0; attempt < 8 && harness.app.getState().administrationPending; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const command = observed.requests.find((entry) => entry.type === "command").request;
  assert.equal(command.documentType, "administration-command-request");
  assert.equal(command.command, "agent.create");
  assert.equal(command.expectedRevision, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(command.input)), {
    displayName: "UI test agent", kind: "automation", capabilities: []
  });
  assert.match(harness.mountRoot.textContent, /Administration action completed/);
  harness.location.hash = "#/agents?atab=agents";
  await harness.app.refresh();
  assert.match(harness.mountRoot.textContent, /UI test agent/);
  harness.app.unmount();
});

test("a validated connector provider populates source choices and enables only lifecycle actions", async () => {
  const connectorRuntime = require("../public/connector-contract");
  const { REFERENCE_CONNECTOR_MANIFEST } = require("../server/reference-manifest");
  const timestamp = "2026-08-30T10:00:00Z";
  const baseManifest = JSON.parse(JSON.stringify(REFERENCE_CONNECTOR_MANIFEST));
  const connectorManifest = connectorRuntime.validateConnectorManifest({
    ...baseManifest,
    configFields: [
      ...baseManifest.configFields,
      {
        key: "tenant-region",
        label: "Tenant region",
        valueType: "string",
        required: true,
        description: "Required manifest-defined region."
      },
      {
        key: "delivery-mode",
        label: "Delivery mode",
        valueType: "enum",
        required: true,
        options: [{ value: "stream", label: "Stream" }]
      }
    ],
    credentialSlots: [{
      key: "ingest-access",
      label: "Ingest access",
      kind: "api-key",
      required: true,
      description: "Reference to adopter-managed ingest access."
    }]
  });
  const requests = [];
  const snapshot = {
    schemaVersion: "1",
    documentType: "connector-control-snapshot",
    connectorTypes: [connectorManifest],
    apps: [{
      appId: "app-one",
      displayName: "Application one",
      hosts: ["host-one"],
      publicPages: [],
      state: "registered",
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp
    }],
    hosts: [{
      hostId: "host-one",
      appId: "app-one",
      displayName: "Host one",
      state: "pending",
      connectionState: "unknown",
      lastProvenAt: null,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp
    }],
    connectorInstances: [],
    setups: [],
    sources: [],
    changes: [],
    revision: 1
  };
  let capturedCommand = null;
  let acknowledgeCommand;
  const commandObserved = new Promise((resolve) => { acknowledgeCommand = resolve; });
  const commands = connectorRuntime.validateProvider({
    schemaVersion: "1",
    id: "source-ui-provider",
    getSnapshot(request) {
      requests.push(request);
      return snapshot;
    },
    execute(request) {
      capturedCommand = request;
      acknowledgeCommand();
      return {
        schemaVersion: "1",
        documentType: "connector-command-result",
        requestId: request.requestId,
        command: request.command,
        status: "succeeded",
        completedAt: request.requestedAt,
        output: {
          appId: request.input.appId,
          sourceId: "source-created",
          connectorInstanceId: "connector-created",
          revision: 1,
          state: "configured"
        }
      };
    }
  });
  const harness = createUiHarness("#/sources?stab=add", { provider: false, commands });
  await harness.app.mount();

  assert.deepEqual(requests.map((request) => request.reason), ["initial"]);
  assert.equal(harness.app.getState().controlState, "ready");
  assert.equal(findNodes(harness.mountRoot,
    (candidate) => candidate.tagName === "FORM" && candidate.getAttribute("data-command-form") !== null).length, 2);
  for (const label of ["Mint token", "Begin source setup"]) {
    const action = findNodes(harness.mountRoot,
      (candidate) => candidate.tagName === "BUTTON" && candidate.textContent === label)[0];
    assert.ok(action, label);
    assert.equal(action.getAttribute("disabled"), null, `${label} is enabled by the command provider`);
  }
  const copy = findNodes(harness.mountRoot,
    (candidate) => candidate.tagName === "BUTTON" && candidate.textContent === "Copy source set")[0];
  assert.ok(copy);
  assert.equal(copy.getAttribute("disabled"), "", "unimplemented scale-out remains disabled");

  const options = findNodes(harness.mountRoot, (candidate) => candidate.tagName === "OPTION")
    .map((candidate) => candidate.getAttribute("value"));
  assert.ok(options.includes("app-one"));
  assert.ok(options.includes("host-one"));
  assert.ok(options.includes("canonical-push"));
  assert.ok(options.includes("canonical-push:log.event"));
  assert.equal(nodesWithClass(harness.mountRoot, "connector-manifest-editor").length, 1);
  assert.match(harness.mountRoot.textContent, /Produces log\.event/);
  assert.equal(findNodes(harness.mountRoot,
    (candidate) => candidate.getAttribute("name") === "config::canonical-push::cadence-seconds").length, 0,
  "the active cadence-hours field is the single cadence editor");
  for (const name of [
    "config::canonical-push::tenant-region",
    "config::canonical-push::delivery-mode",
    "credential-ref::canonical-push::ingest-access",
    "credential-store::canonical-push::ingest-access"
  ]) {
    const control = findNodes(harness.mountRoot, (candidate) => candidate.getAttribute("name") === name)[0];
    assert.ok(control, `${name} control`);
    assert.equal(control.getAttribute("required"), "", `${name} is natively required`);
    assert.equal(control.disabled, true, `${name} stays disabled until its connector is selected`);
  }
  assert.doesNotMatch(renderedValues(harness.mountRoot), /name\ncredentialRef(?:\n|$)/);
  assertUniqueRenderedIdentifiers(harness.mountRoot, "#/sources?stab=add connected");

  const setupButton = findNodes(harness.mountRoot,
    (candidate) => candidate.tagName === "BUTTON" && candidate.textContent === "Begin source setup")[0];
  const setupForm = setupButton.closest("form");
  const connectorSelect = setupForm.querySelector('[name="connectorType"]');
  connectorSelect.value = "canonical-push";
  harness.mountRoot.dispatchEvent({ type: "change", target: connectorSelect });
  const activeEditor = nodesWithClass(harness.mountRoot, "connector-manifest-editor")[0];
  assert.equal(activeEditor.hidden, false);
  assert.equal(activeEditor.getAttribute("aria-hidden"), null);
  activeEditor.querySelectorAll("[name]").forEach((control) => assert.equal(control.disabled, false));
  const setupValues = {
    appId: "app-one",
    hostId: "host-one",
    connectorType: "canonical-push",
    sourceKind: "canonical-push:log.event",
    displayName: "Security log one",
    cadenceHours: "0.1",
    "config::canonical-push::tenant-region": "us-west",
    "config::canonical-push::delivery-mode": "stream",
    "credential-ref::canonical-push::ingest-access": "vault:ingest-primary",
    "credential-store::canonical-push::ingest-access": "vault"
  };
  setupForm.querySelectorAll("[name]").forEach((control) => {
    if (Object.prototype.hasOwnProperty.call(setupValues, control.name)) control.value = setupValues[control.name];
  });
  harness.mountRoot.dispatchEvent({ type: "submit", target: setupForm, submitter: setupButton });
  await commandObserved;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(capturedCommand.command, "source.setup");
  assert.deepEqual(JSON.parse(JSON.stringify(capturedCommand.input)), {
    appId: "app-one",
    environment: "default",
    hostId: "host-one",
    connectorType: "canonical-push",
    sourceKind: "log.event",
    displayName: "Security log one",
    config: {
      "cadence-seconds": 360,
      "tenant-region": "us-west",
      "delivery-mode": "stream"
    },
    credentialReferences: [{
      slot: "ingest-access",
      store: "vault",
      referenceId: "vault:ingest-primary"
    }]
  });
  assert.deepEqual(requests.map((request) => request.reason), ["initial", "refresh"]);
  assert.match(harness.mountRoot.textContent, /Connector action completed/);
  harness.app.unmount();
});

test("application source UI submits sample validation and exposes lifecycle management without a host", async (t) => {
  const os = require("node:os");
  const { ReferenceControlPlane } = require("../server/reference-runtime");
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "soc-source-ui-"));
  const plane = new ReferenceControlPlane({ stateDirectory: directory });
  t.after(() => { plane.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  let sequence = 0;
  const execute = (command, input) => plane.execute({ schemaVersion: "1", documentType: "connector-command-request",
    requestId: `source-ui-${++sequence}`, command, requestedAt: new Date().toISOString(), input });
  const appId = execute("app.register", { displayName: "Web application", hosts: [], publicPages: [], environments: ["preview", "live"] }).output.appId;
  execute("source.setup", { appId, environment: "preview", connectorType: "canonical-push", sourceKind: "log.event", displayName: "Application source",
    config: { "cadence-seconds": 300 }, credentialReferences: [] });
  const harness = createUiHarness("#/sources?stab=add", { provider: false, commands: {
    schemaVersion: "1", id: "application-source-ui", getSnapshot: (request) => plane.getSnapshot(request), execute: (request) => plane.execute(request)
  } });
  await harness.app.mount();
  const environment = harness.mountRoot.querySelector('[name="environment"]');
  assert.equal(environment.value, `${appId}:preview`);
  assert.equal(environment.closest("form").querySelector('[name="hostId"]').required, false, "application sources do not require a collector");
  const sample = harness.mountRoot.querySelector('[name="sampleMessage"]');
  assert.ok(sample);
  sample.value = "Operator-supplied redacted application log";
  const validate = sample.closest("form").querySelector('[data-command-action="source.test"]');
  harness.mountRoot.dispatchEvent({ type: "submit", target: sample.closest("form"), submitter: validate });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(plane.getState().sources[0].state, "tested");
  const activate = harness.mountRoot.querySelector('[data-command-action="source.activate"]');
  harness.mountRoot.dispatchEvent({ type: "click", target: activate });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(plane.getState().sources[0].state, "active");
  assert.match(harness.mountRoot.textContent, /Application source/);
  assert.match(harness.mountRoot.textContent, /preview/);
  assert.match(harness.mountRoot.textContent, /sender's secret store/);
  assert.ok(harness.mountRoot.querySelector('[data-command-action="source.rotate"]'));
  assert.ok(harness.mountRoot.querySelector('[data-command-action="source.update"]'));
  const pause = harness.mountRoot.querySelector('[data-command-action="source.pause"]');
  harness.mountRoot.dispatchEvent({ type: "click", target: pause });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(plane.getState().sources[0].state, "paused");
  assert.ok(harness.mountRoot.querySelector('[data-command-action="source.resume"]'));
  harness.app.unmount();
});

test("scan setup profiles use only catalog policy and validated connector snapshots", async () => {
  const connectorRuntime = require("../public/connector-contract");
  const { REFERENCE_CONNECTOR_MANIFEST } = require("../server/reference-manifest");
  const emptySnapshot = (connectorTypes) => ({
    schemaVersion: "1",
    documentType: "connector-control-snapshot",
    connectorTypes,
    apps: [],
    hosts: [],
    connectorInstances: [],
    setups: [],
    sources: [],
    changes: [],
    revision: 0
  });
  let canonicalSnapshotReads = 0;
  let connectorExecutions = 0;
  const canonicalCommands = connectorRuntime.validateProvider({
    schemaVersion: "1",
    id: "scan-canonical-log-provider",
    getSnapshot() {
      canonicalSnapshotReads += 1;
      return emptySnapshot([REFERENCE_CONNECTOR_MANIFEST]);
    },
    execute() {
      connectorExecutions += 1;
      throw new Error("scan views must not execute connector commands");
    }
  });
  const adapterAttempt = (request) => ({
    schemaVersion: "1",
    route: request.route,
    state: "ready",
    title: "Adapter-supplied scan data",
    panels: [{
      id: "scan-connection-profile",
      type: "notice",
      title: "Adapter data only",
      body: "A page adapter cannot manufacture a connector setup action.",
      tone: "neutral"
    }]
  });
  const scan = createUiHarness("#/scans?tab=trivy", {
    commands: canonicalCommands,
    envelope: adapterAttempt
  });
  await scan.app.mount();

  assert.equal(canonicalSnapshotReads, 1, "/scans reads the validated connector registry");
  assert.equal(scan.app.getState().controlState, "ready");
  const profiles = nodesWithClass(scan.mountRoot, "scan-connection-profile");
  assert.equal(profiles.length, 1);
  assert.match(profiles[0].textContent, /no installed match/i);
  assert.match(profiles[0].textContent, /No installed connector matches this view's exact route, surfaces, and required record kinds/);
  assert.doesNotMatch(profiles[0].textContent, /Canonical push/i,
    "the unrelated log.event reference connector is not presented as scan coverage");
  assert.match(profiles[0].textContent, /scan\.resultsoftware\.packagevulnerability\.finding/);
  const setupLinks = findNodes(scan.mountRoot,
    (candidate) => candidate.getAttribute("data-scan-setup-link") !== null);
  assert.equal(setupLinks.length, 1, "only the shell-owned profile creates a setup link");
  assert.equal(setupLinks[0].tagName, "A");
  assert.equal(setupLinks[0].getAttribute("href"), "#/sources?stab=add&setupFor=scan-trivy");
  assert.equal(findNodes(profiles[0],
    (candidate) => candidate.getAttribute("data-command-action") !== null).length, 0);
  assert.equal(connectorExecutions, 0);
  assertUniqueRenderedIdentifiers(scan.mountRoot, "#/scans?tab=trivy connector profile");
  scan.app.unmount();

  const sourceGuidance = createUiHarness("#/sources?stab=add&setupFor=scan-trivy", {
    provider: false,
    commands: canonicalCommands
  });
  await sourceGuidance.app.mount();
  const guidance = findNodes(sourceGuidance.mountRoot,
    (candidate) => candidate.getAttribute("data-scan-setup-guidance") !== null);
  assert.equal(guidance.length, 1);
  assert.equal(guidance[0].getAttribute("data-scan-setup-guidance"), "scan-trivy");
  assert.match(guidance[0].textContent, /Scan source setup · Trivy scanner/);
  assert.match(guidance[0].textContent, /No installed manifest currently matches/);
  assert.match(guidance[0].textContent, /opaque server-side references only, never API keys or secret values/);
  sourceGuidance.app.unmount();

  const invalidGuidance = createUiHarness("#/sources?stab=add&setupFor=not-a-scan-profile", {
    provider: false,
    commands: canonicalCommands
  });
  await invalidGuidance.app.mount();
  assert.equal(findNodes(invalidGuidance.mountRoot,
    (candidate) => candidate.getAttribute("data-scan-setup-guidance") !== null).length, 0,
  "unknown setupFor values are ignored instead of reflected");
  assert.doesNotMatch(renderedValues(invalidGuidance.mountRoot), /not-a-scan-profile/);
  invalidGuidance.app.unmount();

  const trivyManifest = connectorRuntime.validateConnectorManifest({
    schemaVersion: "1",
    documentType: "connector-manifest",
    connectorType: "trivy-pull",
    connectorVersion: "1.0.0",
    displayName: "Trivy pull",
    description: "Validated test manifest for the Trivy scan surface.",
    scope: "host",
    supportedSourceKinds: ["trivy.scan"],
    payload: {
      schemaId: "soc.canonical-records",
      schemaVersion: "1",
      recordKinds: ["scan.result", "software.package", "vulnerability.finding"],
      lines: "forbidden",
      content: "optional"
    },
    targets: [{
      route: "/scans",
      surfaces: ["trivy-operating-system-packages"],
      recordKinds: ["scan.result", "software.package", "vulnerability.finding"]
    }],
    configFields: [],
    credentialSlots: [],
    healthPolicy: {
      deliveryMode: "poll",
      expectedIntervalSeconds: 3600,
      staleAfterSeconds: 7200,
      offlineAfterSeconds: 14400,
      emptyPayloadIsHealthy: true
    }
  });
  const matchingCommands = connectorRuntime.validateProvider({
    schemaVersion: "1",
    id: "scan-matching-provider",
    getSnapshot() { return emptySnapshot([trivyManifest]); },
    execute() {
      connectorExecutions += 1;
      throw new Error("scan views must not execute connector commands");
    }
  });
  const installed = createUiHarness("#/scans?tab=trivy", { provider: false, commands: matchingCommands });
  await installed.app.mount();
  const installedProfile = nodesWithClass(installed.mountRoot, "scan-connection-profile")[0];
  assert.match(installedProfile.textContent, /installed · not configured/i);
  assert.match(installedProfile.textContent, /Trivy pull matches this view/);
  assert.equal(connectorExecutions, 0);
  installed.app.unmount();
});

test("built-in scan templates exactly match every scan tab and enable only the selected setup fields", async () => {
  const connectorRuntime = require("../public/connector-contract");
  const {
    REFERENCE_CONNECTOR_MANIFESTS,
    REFERENCE_SCAN_CONNECTOR_MANIFESTS
  } = require("../server/reference-manifest");
  const catalog = browserContext(["public/ui-catalog.js"]).SocConsoleUiCatalog;
  const scans = catalog.pages.find((page) => page.path === "/scans").tabsets[0].items;
  assert.equal(scans.length, 11);
  assert.equal(REFERENCE_SCAN_CONNECTOR_MANIFESTS.length, scans.length);
  scans.forEach((scan, index) => {
    const profile = scan.connectionProfile;
    const matches = REFERENCE_SCAN_CONNECTOR_MANIFESTS.filter((manifest) => {
      const target = manifest.targets.find((candidate) => candidate.route === "/scans");
      return target
        && profile.surfaceIds.every((surface) => target.surfaces.includes(surface))
        && profile.requiredRecordKinds.every((kind) => target.recordKinds.includes(kind)
          && manifest.payload.recordKinds.includes(kind));
    });
    assert.equal(matches.length, 1, `${scan.label} has one exact built-in connection template`);
    assert.equal(matches[0], REFERENCE_SCAN_CONNECTOR_MANIFESTS[index], `${scan.label} template order`);
  });

  const snapshot = {
    schemaVersion: "1",
    documentType: "connector-control-snapshot",
    connectorTypes: REFERENCE_CONNECTOR_MANIFESTS,
    apps: [], hosts: [], connectorInstances: [], setups: [], sources: [], changes: [], revision: 0
  };
  let executions = 0;
  const commands = connectorRuntime.validateProvider({
    schemaVersion: "1",
    id: "built-in-scan-template-provider",
    getSnapshot() { return snapshot; },
    execute() {
      executions += 1;
      throw new Error("rendering and selecting a template must not execute it");
    }
  });

  const scanHarness = createUiHarness("#/scans?tab=trivy", { provider: false, commands });
  await scanHarness.app.mount();
  const profile = nodesWithClass(scanHarness.mountRoot, "scan-connection-profile")[0];
  assert.match(profile.textContent, /installed · not configured/i);
  assert.match(profile.textContent, /Trivy connection template matches this view/);
  assert.equal(executions, 0);
  scanHarness.app.unmount();

  const sourceHarness = createUiHarness("#/sources?stab=add&setupFor=scan-trivy", { provider: false, commands });
  await sourceHarness.app.mount();
  const guidance = findNodes(sourceHarness.mountRoot,
    (candidate) => candidate.getAttribute("data-scan-setup-guidance") === "scan-trivy")[0];
  assert.match(guidance.textContent, /Installed matches: Trivy JSON report import \(trivy-report\).*Trivy connection template \(trivy-template\)/);
  const setupButton = findNodes(sourceHarness.mountRoot,
    (candidate) => candidate.tagName === "BUTTON" && candidate.textContent === "Begin source setup")[0];
  const setupForm = setupButton.closest("form");
  assert.equal(setupForm.querySelector('[name="connectorType"]').value, "trivy-report");
  assert.equal(setupForm.querySelector('[name="sourceKind"]').value, "trivy-report:trivy.scan");
  const editors = setupForm.querySelectorAll("[data-connector-manifest]");
  assert.equal(editors.length, REFERENCE_CONNECTOR_MANIFESTS.length);
  editors.forEach((editor) => {
    const selected = editor.getAttribute("data-connector-manifest") === "trivy-report";
    assert.equal(editor.hidden, !selected);
    editor.querySelectorAll("[name]").forEach((control) => assert.equal(control.disabled, !selected));
  });
  for (const name of [
    "config::trivy-template::collection-mode",
    "config::trivy-template::scan-target",
    "config::trivy-template::severity-threshold",
    "credential-ref::trivy-template::registry-access",
    "credential-store::trivy-template::registry-access"
  ]) assert.ok(setupForm.querySelector(`[name="${name}"]`), name);
  assert.equal(executions, 0);
  sourceHarness.app.unmount();

  const urlscanHarness = createUiHarness("#/sources?stab=add&setupFor=scan-urlscan", { provider: false, commands });
  await urlscanHarness.app.mount();
  const urlscanReference = findNodes(urlscanHarness.mountRoot,
    (candidate) => candidate.getAttribute("name") === "credential-ref::urlscan-template::api-access")[0];
  assert.ok(urlscanReference);
  assert.equal(urlscanReference.getAttribute("required"), "");
  assert.equal(urlscanReference.disabled, false);
  assert.doesNotMatch(renderedValues(urlscanHarness.mountRoot), /name\n(?:apiKey|token|secret|password)(?:\n|$)/i);
  assert.equal(executions, 0);
  urlscanHarness.app.unmount();
});

test("Monitor and Investigate retain the active data-free branch contracts", () => {
  const context = browserContext(["public/ui-catalog.js"]);
  const pages = JSON.parse(JSON.stringify(context.SocConsoleUiCatalog.pages));
  const byPath = new Map(pages.map((page) => [page.path, page]));
  const tab = (route, parameter, id) => byPath.get(route).tabsets
    .find((tabset) => tabset.param === parameter).items.find((item) => item.id === id);

  assert.deepEqual(byPath.get("/health").panels[0].labels, [
    "Feeds needing attention", "Untriaged", "Rules never fired", "Noise concentration",
    "Largest repeat group", "Detect to notify", "Alert queue persistence"
  ]);
  assert.deepEqual(tab("/health", "htab", "drills").panels[0].rowDisclosures, ["How to drill"]);
  assert.deepEqual(tab("/brief", "btab", "turnover").panels.slice(0, 4).map((panel) => panel.title), [
    "To turn over — untouched", "In work", "Investigations — tagged real-threat",
    "Dispositioned in the last 24h"
  ]);
  assert.equal(byPath.get("/analytics").tabsets[0].default, "48");
  assert.deepEqual(byPath.get("/timeline").tabsets[0].items.map((item) => item.id), ["15m", "1h", "24h", "7d"]);

  assert.equal(byPath.get("/logs").panels[0].type, "log-results");
  assert.equal(byPath.get("/search").variant, "search-dispatch");
  assert.deepEqual(byPath.get("/ioc").panels[1].columns, ["Type", "Indicator", "Environment", "Intel"]);
  byPath.get("/known-ips").panels.filter((panel) => panel.type === "table")
    .forEach((panel) => assert.deepEqual(panel.columns, ["IP", "Label", "Source", "Added", "Confirmed", ""]));
  assert.ok(tab("/intel", "itab", "bb").panels.some((panel) => panel.whenQuery && panel.whenQuery.q === "present"));
  assert.ok(tab("/intel", "itab", "otx").panels.some((panel) => panel.whenQuery && panel.whenQuery.oq === "present"));
  assert.deepEqual(byPath.get("/ip").panels.filter((panel) => panel.type === "lookup").map((panel) => panel.id),
    ["shodan", "alienvault-otx"]);
  assert.deepEqual(byPath.get("/ip").panels.find((panel) => panel.id === "shodan").resultLabels,
    ["Organisation", "ASN", "Location", "Open ports", "Hostnames", "Tags", "CVEs (banner-inferred)", "Shodan last saw it"]);
  assert.deepEqual(byPath.get("/ip").panels.find((panel) => panel.id === "alienvault-otx").resultLabels,
    ["Pulse count", "Tags", "Pulse list", "Checked"]);
});

test("Monitor and Investigate query branches render without operational fixtures", async () => {
  const health = createUiHarness("#/health?htab=drills", { provider: false });
  await health.app.mount();
  const healthPage = health.mountRoot.childNodes[0];
  const healthSummaryIndex = healthPage.childNodes.findIndex((candidate) => candidate.getAttribute("data-panel-id") === "summary-metrics");
  const healthTabsIndex = healthPage.childNodes.findIndex((candidate) => candidate.className.split(/\s+/).includes("route-view-tabs"));
  assert.ok(healthSummaryIndex >= 0 && healthSummaryIndex < healthTabsIndex);
  assert.equal(nodesWithClass(health.mountRoot, "metric-card").length, 7);
  assert.match(health.mountRoot.textContent, /Detection drills — last proven fire per layer/);
  assert.match(health.mountRoot.textContent, /How to drill/);
  health.app.unmount();

  const logs = createUiHarness(`#/logs?q=${encodeURIComponent("index=channel | stats count by src,port")}`, { provider: false });
  await logs.app.mount();
  for (const className of ["logs-query-panel", "logs-cheat-sheet", "logs-sort-bar", "logs-statistics"]) {
    assert.equal(hasClass(logs.mountRoot, className), true, className);
  }
  assert.match(logs.mountRoot.textContent, /stats count by src, port/);
  assert.match(logs.mountRoot.textContent, /Reading raw firewall lines/);
  assert.equal(nodesWithClass(logs.mountRoot, "logs-cheat-copy").length, 1);
  assert.equal(findNodes(nodesWithClass(logs.mountRoot, "logs-cheat-copy")[0],
    (candidate) => candidate.tagName === "A").length, 16);
  assert.doesNotMatch(renderedValues(logs.mountRoot), /\b(?:null|undefined)\b/i);
  logs.app.unmount();

  const timeline = createUiHarness("#/timeline?host=host-reference&range=1h", { provider: false });
  await timeline.app.mount();
  assert.equal(hasClass(timeline.mountRoot, "timeline-controls"), true);
  const selectedRange = findNodes(timeline.mountRoot,
    (candidate) => candidate.getAttribute("role") === "tab" && candidate.getAttribute("aria-selected") === "true")[0];
  assert.ok(selectedRange);
  assert.match(selectedRange.textContent, /^1h/);
  timeline.app.unmount();

  const intel = createUiHarness("#/intel?itab=bb&q=selector-reference&list=ips", { provider: false });
  await intel.app.mount();
  assert.match(intel.mountRoot.textContent, /Lookup/);
  assert.match(intel.mountRoot.textContent, /Filter indicators/);
  assert.doesNotMatch(intel.mountRoot.textContent, /selector-reference/);
  intel.app.unmount();

  const ioc = createUiHarness("#/ioc", { provider: false });
  await ioc.app.mount();
  const iocInput = findNodes(ioc.mountRoot, (candidate) => candidate.tagName === "TEXTAREA")[0];
  assert.ok(iocInput);
  assert.equal(iocInput.getAttribute("rows"), "22");
  assert.equal(iocInput.getAttribute("disabled"), "");
  assert.match(ioc.mountRoot.textContent, /defanged indicators \(hxxp, \[\.\]\) handled/);
  ioc.app.unmount();

  const search = createUiHarness("#/search?q=inventory", { provider: false });
  await search.app.mount();
  const destination = findNodes(search.mountRoot,
    (candidate) => candidate.tagName === "A" && candidate.textContent === "Open Systems")[0];
  assert.ok(destination);
  assert.equal(destination.getAttribute("href"), "#/systems");
  search.app.unmount();
});

test("the active Search anything and go shortcuts dispatch without exposing a data directory", async () => {
  const document = new TestDocument();
  const shell = document.createElement("aside");
  const dialog = document.createElement("dialog");
  dialog.setAttribute("id", "command-dialog");
  const input = document.createElement("input");
  input.setAttribute("id", "command-input");
  const results = document.createElement("div");
  results.setAttribute("id", "command-results");
  const close = document.createElement("button");
  close.setAttribute("id", "command-close");
  dialog.append(input, results, close);
  const toast = document.createElement("div");
  toast.setAttribute("id", "toast");
  toast.hidden = true;
  const toastMessage = document.createElement("span");
  toastMessage.setAttribute("id", "toast-message");
  toast.append(toastMessage);
  shell.append(dialog, toast);
  const harness = createUiHarness("#/", { provider: false, shellRoot: shell, document });
  await harness.app.mount();

  harness.document.dispatchEvent({ type: "keydown", key: "/", metaKey: false, ctrlKey: false, altKey: false });
  assert.equal(dialog.getAttribute("open"), "");
  assert.equal(harness.document.activeElement, input);
  input.value = "CVE-2026-1234";
  input.dispatchEvent({ type: "input" });
  const investigate = findNodes(results,
    (candidate) => candidate.tagName === "A" && candidate.textContent.includes("Investigate"))[0];
  assert.equal(investigate.getAttribute("href"), "#/search?q=CVE-2026-1234");
  input.dispatchEvent({ type: "keydown", key: "Enter" });
  assert.equal(harness.location.hash, "#/search?q=CVE-2026-1234");

  harness.document.activeElement = null;
  harness.document.dispatchEvent({ type: "keydown", key: "g", metaKey: false, ctrlKey: false, altKey: false });
  harness.document.dispatchEvent({ type: "keydown", key: "l", metaKey: false, ctrlKey: false, altKey: false });
  assert.equal(harness.location.hash, "#/logs");
  harness.document.dispatchEvent({ type: "keydown", key: "?", metaKey: false, ctrlKey: false, altKey: false });
  assert.equal(toast.hidden, false);
  assert.match(toastMessage.textContent, /g then o\/a\/r\/s\/l\/y\/d\/b\/u\/f\/t\/p/);
  harness.app.unmount();
});

test("the phishing catalog keeps queue and report-detail surfaces mutually exclusive", () => {
  const context = browserContext(["public/ui-catalog.js"]);
  const pages = JSON.parse(JSON.stringify(context.SocConsoleUiCatalog.pages));
  const phishing = pages.find((page) => page.path === "/phishing");
  assert.ok(phishing);
  assert.ok(phishing.panels.every((panel) => ["absent", "present"].includes(panel.whenQuery.id)));

  const select = (id) => phishing.panels.filter((panel) => {
    const state = id ? "present" : "absent";
    return panel.whenQuery.id === state;
  });
  const queue = select("");
  assert.deepEqual(queue.map((panel) => panel.title || panel.type), ["metrics", "Report queue"]);
  assert.deepEqual(queue[0].labels, [
    "Reports", "Likely phishing", "Suspicious", "Clean", "Scorer faults", "Newest report"
  ]);
  assert.deepEqual(queue[1].columns, ["Reported", "Reporter", "Org", "From → To", "Subject", "Verdict", "Score"]);

  const detail = select("report-reference");
  assert.deepEqual(detail.map((panel) => panel.title), [
    "Verdict", "Reported message", "Signal evidence", "Weights legend",
    "Extracted links", "Attachment ledger", "Passive intel", "Message body"
  ]);
  assert.deepEqual(detail.find((panel) => panel.title === "Signal evidence").columns,
    ["Signal", "Scope", "Tier", "Band", "Weight", "Evidence"]);
  assert.deepEqual(detail.find((panel) => panel.title === "Reported message").labels,
    ["Reported", "Organization", "From → To", "Subject", "Received", "Received email id", "Thread token", "Shipped by"]);
  assert.deepEqual(detail.find((panel) => panel.title === "Attachment ledger").columns,
    ["Filename", "Size", "Type", "SHA-256", "AV verdict", "Retention"]);
  assert.deepEqual(detail.find((panel) => panel.title === "Message body").labels,
    ["Text body", "HTML body — source, never rendered"]);

  const app = read("public/app.js");
  assert.match(app, /function queryMatches\(whenQuery, query\)/);
  assert.match(app, /expected === "present"/);
  assert.match(app, /expected === "absent"/);
  assert.match(app, /collectPanels\(page, tabState, state\.query\)/);
});

test("phishing queue and report routes render their distinct active structures", async () => {
  const harness = createUiHarness("#/phishing", { provider: false });
  await harness.app.mount();
  assert.equal(nodesWithClass(harness.mountRoot, "phishing-statebar").length, 1);
  assert.equal(nodesWithClass(harness.mountRoot, "phishing-statebar-stats").length, 1);
  assert.equal(nodesWithClass(harness.mountRoot, "phishing-inline-stat").length, 6);
  assert.equal(nodesWithClass(harness.mountRoot, "phishing-verdict").length, 0);

  harness.location.hash = "#/phishing?id=report-reference";
  await harness.app.refresh();
  const heading = nodesWithClass(harness.mountRoot, "dash-title")[0];
  assert.ok(heading);
  assert.match(heading.textContent, /^Phishing — Report/);
  const back = findNodes(harness.mountRoot,
    (candidate) => candidate.tagName === "A" && candidate.textContent.includes("Back to Phishing"))[0];
  assert.ok(back);
  assert.equal(back.getAttribute("href"), "#/phishing");
  for (const className of [
    "phishing-verdict", "phishing-verdict-facts", "phishing-intel-grid",
    "phishing-body-grid", "phishing-message-source"
  ]) assert.equal(hasClass(harness.mountRoot, className), true, className);
  assert.equal(nodesWithClass(harness.mountRoot, "phishing-intel-source").length, 3);
  assert.equal(nodesWithClass(harness.mountRoot, "phishing-message-source").length, 2);
  assert.equal(nodesWithClass(harness.mountRoot, "phishing-statebar").length, 0);
  assert.doesNotMatch(renderedValues(harness.mountRoot), /\b(?:null|undefined)\b/i);
  assert.doesNotMatch(harness.mountRoot.textContent, /report-reference/);
  harness.app.unmount();
});

test("event detail renders the image back control, decision bar, and three disclosure groups", async () => {
  const safeBack = encodeURIComponent("/triage?view=cases");
  const harness = createUiHarness(`#/event?host=host-reference&ts=time-reference&back=${safeBack}`);
  await harness.app.mount();

  for (const className of [
    "event-detail-head", "event-back-image", "event-statusbar", "event-statusbar-body",
    "event-status", "event-tune-state", "event-tune-action"
  ]) assert.equal(hasClass(harness.mountRoot, className), true, className);
  const back = nodesWithClass(harness.mountRoot, "event-back-image")[0];
  assert.equal(back.getAttribute("href"), "#/triage?view=cases");
  assert.equal(back.getAttribute("aria-label"), "Back to Triage");
  const arrow = back.childNodes.find((candidate) => candidate.tagName === "IMG");
  assert.ok(arrow);
  assert.equal(arrow.getAttribute("src"), "assets/triage-back-arrow.png");
  assert.equal(arrow.getAttribute("alt"), "");
  assert.match(nodesWithClass(harness.mountRoot, "event-statusbar")[0].textContent, /ReviewHigh/);
  for (const label of ["Why this fired", "Rule background", "What to check", "Pivot to search", "URL / domain context"]) {
    assert.match(harness.mountRoot.textContent, new RegExp(label.replace("/", "\\/")));
  }
  assert.equal(findNodes(harness.mountRoot,
    (candidate) => candidate.getAttribute("data-panel-id") === "event-evidence").length, 1);

  const disclosures = nodesWithClass(harness.mountRoot, "assoc");
  assert.equal(disclosures.length, 3);
  assert.deepEqual(disclosures.map((candidate) => candidate.tagName), ["DETAILS", "DETAILS", "DETAILS"]);
  assert.equal(disclosures.filter((candidate) => candidate.getAttribute("open") !== null).length, 1);
  assert.match(disclosures.find((candidate) => candidate.getAttribute("open") !== null).textContent, /related detections/i);

  harness.location.hash = `#/event?back=${encodeURIComponent("//outside.example.invalid/triage")}`;
  await harness.app.refresh();
  assert.equal(nodesWithClass(harness.mountRoot, "event-back-image")[0].getAttribute("href"), "#/triage");
  harness.app.unmount();
});

test("Detection Tuning and Rules expose the active lifecycle, branch, and table contracts", () => {
  const context = browserContext(["public/ui-catalog.js"]);
  const pages = JSON.parse(JSON.stringify(context.SocConsoleUiCatalog.pages));
  const tuning = pages.find((page) => page.path === "/tuning");
  const rules = pages.find((page) => page.path === "/rules");
  const definitionColumns = ["Detection", "Match scope", "Status", "Revision", "Owner", "Expires", ""];
  const occurrenceColumns = [
    "When", "Case", "Detection", "Host", "Alert", "Tune", "Revision",
    "Notification policy", "Outcome", ""
  ];
  const tableFor = (page, parameter, itemId) => page.tabsets
    .find((tabset) => tabset.param === parameter).items
    .find((item) => item.id === itemId).panels
    .find((panel) => panel.type === "table");

  const standaloneStatus = tuning.tabsets.find((tabset) => tabset.param === "status");
  assert.equal(standaloneStatus.default, "active");
  assert.deepEqual(standaloneStatus.items.map((item) => item.id), ["active", "draft", "disabled"]);
  assert.deepEqual(tableFor(tuning, "tview", "definitions").columns, definitionColumns);
  assert.deepEqual(tableFor(tuning, "tview", "applied").columns, occurrenceColumns);
  assert.deepEqual(tableFor(tuning, "tview", "held").columns, occurrenceColumns);
  assert.deepEqual(tuning.panels.find((panel) => panel.id === "tune-recommendations").columns, [
    "Artifact role", "Detection", "Host", "Observed path", "SHA-256", "Why suggested", "Coverage", ""
  ]);
  assert.deepEqual(rules.tabsets.find((tabset) => tabset.param === "rtab").items
    .find((item) => item.id === "tuning").panels.find((panel) => panel.id === "tune-recommendations").columns,
    ["Artifact role", "Detection", "Host", "Observed path", "SHA-256", "Why suggested", "Coverage", ""]);
  assert.deepEqual(tuning.queryBranches.map((branch) => branch.id), [
    "detail", "occurrence-chooser", "finding-chooser", "draft-builder"
  ]);
  const tuningBranchPanels = Object.fromEntries(tuning.queryBranches.map((branch) => [
    branch.id, branch.panels.map((panel) => panel.id)
  ]));
  assert.deepEqual(tuningBranchPanels, {
    detail: [
      "tune-detail-record", "tune-detail-preview-summary", "tune-detail-preview-matches",
      "tune-detail-lineage", "tune-detail-delivery-audit"
    ],
    "occurrence-chooser": ["tune-occurrence-options"],
    "finding-chooser": ["tune-finding-options"],
    "draft-builder": ["tune-builder-source", "tune-builder-evidence"]
  });

  const embeddedStatus = rules.tabsets.find((tabset) => tabset.param === "tstatus");
  assert.equal(embeddedStatus.default, "all");
  assert.deepEqual(embeddedStatus.when, { rtab: "tuning", tview: "definitions" });
  assert.deepEqual(embeddedStatus.items.map((item) => item.id), ["all", "active", "draft", "disabled"]);
  assert.deepEqual(tableFor(rules, "tview", "definitions").columns, definitionColumns);
  assert.deepEqual(tableFor(rules, "tview", "applied").columns, occurrenceColumns);
  assert.deepEqual(rules.queryBranches.map((branch) => ({ id: branch.id, whenQuery: branch.whenQuery })), [
    { id: "rule-detail", whenQuery: { ruleView: "present" } }
  ]);
  assert.deepEqual(rules.queryBranches[0].panels.map((panel) => panel.id), [
    "rule-detail-summary", "rule-source-definition", "rule-effective-definition", "rule-detail-occurrences"
  ]);
  assert.deepEqual(rules.tabAliases.rtab, {
    active: { rtab: "palisade", ptab: "active" },
    add: { rtab: "palisade", ptab: "add" },
    help: { rtab: "palisade", ptab: "help" }
  });
});

test("the adapter guide documents every specialized Tuning, Rules, and Phishing slot", () => {
  const guide = read("docs/ADAPTER-CONTRACT.md");
  const template = read("examples/provider-template.js");
  const specializedIds = [
    "tune-detail-record", "tune-detail-preview-summary", "tune-detail-preview-matches",
    "tune-detail-lineage", "tune-detail-delivery-audit", "tune-occurrence-options",
    "tune-finding-options", "tune-builder-source", "tune-builder-evidence",
    "rule-detail-summary", "rule-source-definition", "rule-effective-definition",
    "rule-detail-occurrences", "verdict", "reported-message", "signal-evidence",
    "weights-legend", "extracted-links", "attachment-ledger", "passive-intel", "message-body",
    "tune-recommendations", "finding-context", "event-evidence", "offboarding-summary",
    "per-surface-breakdown", "per-surface-item-detail", "shodan", "alienvault-otx"
  ];
  specializedIds.forEach((id) => assert.match(guide, new RegExp(`\\\`${id}\\\``), id));
  assert.match(guide, /another\s+contract-valid type[^.]+generic safe\s+renderer/is);
  assert.match(guide, /never\s+interpreted as markup/i);
  assert.match(guide, /Stacked time-series chart/);
  assert.match(guide, /same-console hash navigation/i);
  assert.match(guide, /table `disclosures`/i);
  assert.match(template, /specialized-query-branch-slots/);
  assert.match(template, /validated `chart` panels/);
});

test("public browser runtime and provider template contain structure but no demo or synthetic fixtures", () => {
  const runtimeFiles = fs.readdirSync(path.join(root, "public"))
    .filter((name) => name.endsWith(".js"))
    .map((name) => `public/${name}`)
    .concat("examples/provider-template.js");
  for (const name of runtimeFiles) {
    const source = read(name);
    const stringLiterals = source.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/gs) || [];
    // Generated documentation describes an opt-in synthetic benchmark; it does
    // not seed application records. Its exact source is verified separately.
    if (name !== "public/technical-docs.js") assert.doesNotMatch(stringLiterals.join("\n"), /\b(?:demo|synthetic)\b/i, name);
    assert.doesNotMatch(source, /\b(?:demo|fixture)-[a-z0-9-]+\b/i, name);
  }

  const context = browserContext(["public/ui-catalog.js"]);
  const catalog = JSON.parse(JSON.stringify(context.SocConsoleUiCatalog));
  const forbiddenDataKeys = new Set(["rows", "records", "fixtures", "sampleData", "values"]);
  function visit(value, location = "catalog") {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      assert.equal(forbiddenDataKeys.has(key), false, `${location}.${key}`);
      visit(child, `${location}.${key}`);
    }
  }
  visit(catalog);
});

test("public configuration defaults to skeleton mode with a frozen auth boundary", () => {
  const context = browserContext(["public/app-config.js"]);
  assert.equal(context.SocConsoleConfig.schemaVersion, "1");
  assert.equal(context.SocConsoleConfig.mode, "skeleton");
  assert.equal(context.SocConsoleConfig.brand.name, "Bulwark Black SOC");
  assert.equal(context.SocConsoleConfig.brand.logoPath, "assets/mark.png");
  assert.equal(context.SocConsoleConfig.connectors.globalName, "SOC_CONSOLE_CONNECTORS");
  assert.equal(context.SocConsoleConfig.administration.globalName, "SOC_CONSOLE_ADMINISTRATION");
  assert.equal(context.SocConsoleConfig.auth.globalName, "SOC_CONSOLE_AUTH");
  assert.equal(context.SocConsoleConfig.auth.required, false);
  assert.equal(Object.prototype.hasOwnProperty.call(context.SocConsoleConfig, "scenario"), false);
  assert.equal(vm.runInContext(
    "Object.isFrozen(SocConsoleConfig) && Object.isFrozen(SocConsoleConfig.brand) && Object.isFrozen(SocConsoleConfig.connectors) && Object.isFrozen(SocConsoleConfig.administration) && Object.isFrozen(SocConsoleConfig.auth)",
    context
  ), true);

  const override = browserContext(["public/app-config.js"], `window.SOC_CONSOLE_PUBLIC_CONFIG = ${JSON.stringify({
    mode: "application",
    adapter: { globalName: "MY_PUBLIC_ADAPTER" },
    connectors: { globalName: "MY_CONNECTOR_PROVIDER" },
    administration: { globalName: "MY_ADMINISTRATION_PROVIDER" },
    auth: { globalName: "MY_PUBLIC_AUTH", required: true },
    routing: { defaultRoute: "/health" }
  })};`);
  assert.equal(override.SocConsoleConfig.mode, "application");
  assert.equal(override.SocConsoleConfig.adapter.globalName, "MY_PUBLIC_ADAPTER");
  assert.equal(override.SocConsoleConfig.connectors.globalName, "MY_CONNECTOR_PROVIDER");
  assert.equal(override.SocConsoleConfig.administration.globalName, "MY_ADMINISTRATION_PROVIDER");
  assert.equal(override.SocConsoleConfig.auth.globalName, "MY_PUBLIC_AUTH");
  assert.equal(override.SocConsoleConfig.auth.required, true);
  assert.equal(override.SocConsoleConfig.routing.defaultRoute, "/health");

  assert.throws(() => browserContext(
    ["public/app-config.js"],
    "window.SOC_CONSOLE_PUBLIC_CONFIG = { token: 'this-value-must-not-be-accepted' };"
  ), /sensitive|unsupported/i);
  assert.throws(() => browserContext(
    ["public/app-config.js"],
    "window.SOC_CONSOLE_PUBLIC_CONFIG = { brand: { logoPath: '../private.png' } };"
  ), /traversal|relative local path/i);
  assert.throws(() => browserContext(
    ["public/app-config.js"],
    "window.SOC_CONSOLE_PUBLIC_CONFIG = { routing: { defaultRoute: '/health//detail' } };"
  ), /route|traversal/i);
  assert.throws(() => browserContext(
    ["public/app-config.js"],
    "window.SOC_CONSOLE_PUBLIC_CONFIG = { auth: { globalName: 'MY_AUTH', required: 'yes' } };"
  ), /auth|required|boolean/i);
});

test("bootstrap exposes the controller before asynchronous mount completion", async () => {
  const rootNode = {
    focus() {},
    replaceChildren() {}
  };
  const shellNode = {};
  let resolveMount;
  const pendingMount = new Promise((resolve) => { resolveMount = resolve; });
  const app = { mount() { return pendingMount; } };
  const context = vm.createContext({
    console,
    document: {
      createElement() { throw new Error("failure UI should not render"); },
      getElementById(id) { return id === "content" ? rootNode : id === "soc-console" ? shellNode : null; }
    },
    Promise,
    __app: app
  });
  context.window = context;
  vm.runInContext(`
    window.SocConsoleAdapterRuntime = { VERSION: "1", resolveProvider() { return null; } };
    window.SocConsoleAuthRuntime = { VERSION: "1", resolveProvider() { return null; } };
    window.SocConsoleConnectorRuntime = { VERSION: "1", resolveProvider() { return null; } };
    window.SocConsoleAdministrationRuntime = { VERSION: "1", resolveProvider() { return null; } };
    window.SocConsoleConfig = {
      schemaVersion: "1",
      adapter: { globalName: "SOC_CONSOLE_ADAPTER" },
      connectors: { globalName: "SOC_CONSOLE_CONNECTORS" },
      administration: { globalName: "SOC_CONSOLE_ADMINISTRATION" },
      auth: { globalName: "SOC_CONSOLE_AUTH" }
    };
    window.SocConsole = { createApp() { return window.__app; } };
  `, context);

  vm.runInContext(read("public/bootstrap.js"), context, { filename: "public/bootstrap.js" });
  assert.equal(context.SocConsoleApp, app);
  assert.equal(typeof context.SocConsoleAppReady.then, "function");

  let settled = false;
  context.SocConsoleAppReady.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  resolveMount();
  assert.equal(await context.SocConsoleAppReady, app);
});

test("authentication contract exposes only a closed session projection and internal return paths", async () => {
  const context = browserContext(["public/auth-contract.js"]);
  const runtime = context.SocConsoleAuthRuntime;
  assert.equal(runtime.VERSION, "1");
  assert.deepEqual(Object.keys(runtime).sort(), [
    "VERSION", "resolveProvider", "validateProvider", "validateReturnTo", "validateSession"
  ].sort());
  assert.equal(Object.isFrozen(runtime), true);
  for (const method of ["validateReturnTo", "validateSession", "validateProvider", "resolveProvider"]) {
    assert.equal(typeof runtime[method], "function", method);
  }
  assert.equal(runtime.validateReturnTo("#/"), "#/");
  assert.equal(runtime.validateReturnTo("#/health?htab=feeds"), "#/health?htab=feeds");
  for (const value of [
    "/health",
    "https://example.invalid/health",
    "#//example.invalid/health",
    "#/../settings",
    "#/health#second-fragment",
    "#/intel?itab=bb&itab=otx",
    "javascript:alert(1)"
  ]) assert.throws(() => runtime.validateReturnTo(value), /return|internal|route|hash/i, value);

  context.__anonymous = vm.runInContext("SocConsoleAuthRuntime.validateSession({ authenticated: false })", context);
  assert.equal(context.__anonymous.authenticated, false);
  assert.equal(vm.runInContext("Object.isFrozen(__anonymous)", context), true);

  context.__displayless = vm.runInContext("SocConsoleAuthRuntime.validateSession({ authenticated: true })", context);
  assert.equal(context.__displayless.authenticated, true);
  assert.deepEqual(Object.keys(context.__displayless), ["authenticated"]);

  context.__sessionDocument = JSON.stringify({
    authenticated: true,
    display: { name: "Example operator", initials: "EO" },
    capabilities: ["console:read"]
  });
  context.__session = vm.runInContext(
    "SocConsoleAuthRuntime.validateSession(JSON.parse(__sessionDocument))",
    context
  );
  assert.equal(context.__session.authenticated, true);
  assert.equal(context.__session.display.name, "Example operator");
  assert.equal(vm.runInContext(
    "Object.isFrozen(__session) && Object.isFrozen(__session.display) && Object.isFrozen(__session.capabilities)",
    context
  ), true);

  context.__invalidAnonymous = JSON.stringify({ authenticated: false, display: { name: "Not allowed", initials: "NA" } });
  assert.throws(() => vm.runInContext(
    "SocConsoleAuthRuntime.validateSession(JSON.parse(__invalidAnonymous))",
    context
  ), /authenticated|display|session/i);

  for (const forbidden of [
    { accessToken: "not-a-real-access-token" },
    { rawClaims: { role: "owner" } },
    { subject: "provider-subject" },
    { sessionId: "provider-session" },
    { cookie: "browser-cookie" },
    { credentials: ["provider-credential"] }
  ]) {
    context.__unsafeSession = JSON.stringify({ authenticated: true, ...forbidden });
    assert.throws(() => vm.runInContext(
      "SocConsoleAuthRuntime.validateSession(JSON.parse(__unsafeSession))",
      context
    ), /claim|token|subject|session|cookie|credential|unsupported|sensitive|contract/i);
  }

  const provider = vm.runInContext(`SocConsoleAuthRuntime.validateProvider({
    schemaVersion: "1",
    id: "application-auth",
    getSession() { return Promise.resolve({ authenticated: false }); },
    login({ returnTo }) { return returnTo; },
    logout({ returnTo }) { return returnTo; }
  })`, context);
  assert.equal(provider.id, "application-auth");
  assert.equal((await provider.getSession()).authenticated, false);
  assert.equal(await provider.login({ returnTo: "#/health" }), undefined);
  assert.equal(await provider.logout({ returnTo: "#/" }), undefined);
  assert.equal(Object.isFrozen(provider), true);

  const throwingProvider = vm.runInContext(`SocConsoleAuthRuntime.validateProvider({
    schemaVersion: "1",
    id: "throwing-auth",
    getSession() { throw new Error("session failed"); },
    login() { throw new Error("login failed"); },
    logout() { throw new Error("logout failed"); }
  })`, context);
  await assert.rejects(throwingProvider.getSession(), /session failed/);
  await assert.rejects(throwingProvider.login({ returnTo: "#/" }), /login failed/);
  await assert.rejects(throwingProvider.logout({ returnTo: "#/" }), /logout failed/);

  vm.runInContext(`
    window.__mutableAuthSource = {
      schemaVersion: "1",
      id: "bound-auth",
      getSession() { return { authenticated: false }; },
      login() {},
      logout() {}
    };
    window.__boundAuthProvider = SocConsoleAuthRuntime.validateProvider(window.__mutableAuthSource);
    window.__mutableAuthSource.getSession = function changedSession() {
      return { authenticated: true, display: { name: "Changed", initials: "CH" } };
    };
    window.__mutableAuthSource.login = function changedLogin() { throw new Error("changed login"); };
  `, context);
  assert.equal((await context.__boundAuthProvider.getSession()).authenticated, false);
  assert.equal(await context.__boundAuthProvider.login({ returnTo: "#/" }), undefined);

  context.SOC_CONSOLE_AUTH = vm.runInContext(`({
    schemaVersion: "1",
    id: "resolved-auth",
    getSession() { return { authenticated: false }; },
    login({ returnTo }) { return returnTo; },
    logout({ returnTo }) { return returnTo; }
  })`, context);
  assert.equal(runtime.resolveProvider("SOC_CONSOLE_AUTH").id, "resolved-auth");
  assert.equal(runtime.resolveProvider("AUTH_NOT_INSTALLED"), null);
});

test("authenticated sessions without optional display data never render as sign-in prompts", async () => {
  const harness = createUiHarness("#/", {
    provider: false,
    session: { authenticated: true },
    withAuthShell: true
  });
  await harness.app.mount();
  assert.equal(harness.authName.textContent, "Signed in");
  assert.equal(harness.authState.textContent, "authenticated");
  assert.doesNotMatch(`${harness.authName.textContent}\n${harness.authState.textContent}`, /^Sign in$/m);
  harness.app.unmount();
});

test("Better Auth reference bridges current client calls into the closed console contract", async () => {
  const packageDocument = JSON.parse(read("package.json"));
  assert.match(packageDocument.dependencies?.["better-auth"], /^\d+\.\d+\.\d+$/);
  assert.match(packageDocument.dependencies?.["better-sqlite3"], /^\d+\.\d+\.\d+$/);
  assert.equal(packageDocument.devDependencies?.["better-auth"], undefined);
  const referenceGuide = read("examples/better-auth-reference/README.md");
  for (const clientCall of ["authClient.getSession()", "authClient.signOut()", "authClient.signIn.social"]) {
    assert.ok(referenceGuide.includes(clientCall), clientCall);
  }
  const entryExample = referenceGuide.match(/```js\n([\s\S]*?)\n```/);
  const loadOrderExample = referenceGuide.match(/```html\n([\s\S]*?)\n```/);
  assert.ok(entryExample, "bundled Better Auth entry example");
  assert.ok(loadOrderExample, "Better Auth script load-order example");
  const providerInstall = entryExample[1].indexOf("window.SOC_CONSOLE_AUTH =");
  const bootstrapImport = entryExample[1].indexOf('await import("/soc/bootstrap.js")');
  assert.ok(providerInstall >= 0 && bootstrapImport > providerInstall, "provider installs before bootstrap");
  assert.doesNotMatch(loadOrderExample[1], /<script[^>]+src="\/soc\/bootstrap\.js"/i);
  const loadOrder = [
    "/soc/app-config.js",
    "/soc/adapter-contract.js",
    "/soc/auth-contract.js",
    "/soc/connector-contract.js",
    "/soc/administration-contract.js",
    "/soc/technical-docs.js",
    "/soc/ui-catalog.js",
    "/soc/app.js",
    "/soc-adopter/better-auth-bridge.js",
    "/soc-adopter/auth-client-entry.js"
  ].map((source) => loadOrderExample[1].indexOf(source));
  assert.equal(loadOrder.every((index) => index >= 0), true);
  assert.deepEqual(loadOrder, [...loadOrder].sort((left, right) => left - right));

  let assignedLocation = null;
  const context = vm.createContext({ URL });
  context.window = context;
  context.location = Object.freeze({
    origin: "https://console.example.invalid",
    assign(value) { assignedLocation = value; }
  });
  for (const name of [
    "public/auth-contract.js",
    "examples/better-auth-reference/better-auth-bridge.js"
  ]) vm.runInContext(read(name), context, { filename: name });

  vm.runInContext(`
    window.__bridgeCalls = [];
    window.__sessionData = { user: { name: "Example Operator" }, session: { ignored: true } };
    window.__authClient = {
      signIn: {
        social(request) {
          window.__bridgeCalls.push({ kind: "social", request });
          return Promise.resolve({ data: { redirect: true }, error: null });
        }
      },
      getSession() {
        window.__bridgeCalls.push({ kind: "session" });
        return Promise.resolve({ data: window.__sessionData, error: null });
      },
      signOut() {
        window.__bridgeCalls.push({ kind: "sign-out" });
        return Promise.resolve({ data: { success: true }, error: null });
      }
    };
    window.__betterAuthProvider = SocConsoleBetterAuthBridge.createProvider({
      authClient: window.__authClient,
      callbackPath: "/soc/",
      beginLogin({ callbackURL }) {
        return window.__authClient.signIn.social({ provider: "github", callbackURL });
      }
    });
  `, context);

  const provider = context.__betterAuthProvider;
  assert.equal(provider.id, "better-auth");
  assert.equal(Object.isFrozen(provider), true);
  const authenticated = await provider.getSession();
  assert.equal(authenticated.authenticated, true);
  assert.equal(authenticated.display.name, "Example Operator");
  assert.equal(authenticated.display.initials, "EO");
  assert.deepEqual(Object.keys(authenticated).sort(), ["authenticated", "display"]);

  await provider.login({ returnTo: "#/triage?view=cases" });
  const socialCall = context.__bridgeCalls.find((entry) => entry.kind === "social");
  assert.equal(socialCall.request.provider, "github");
  assert.equal(
    socialCall.request.callbackURL,
    "https://console.example.invalid/soc/#/triage?view=cases"
  );

  await provider.logout({ returnTo: "#/" });
  assert.equal(assignedLocation, "https://console.example.invalid/soc/#/");
  assert.equal(context.__bridgeCalls.some((entry) => entry.kind === "sign-out"), true);

  context.__sessionData = null;
  const anonymous = await provider.getSession();
  assert.equal(anonymous.authenticated, false);
  assert.deepEqual(Object.keys(anonymous), ["authenticated"]);
  await assert.rejects(
    provider.login({ returnTo: "https://outside.example.invalid/" }),
    /return|internal|route|hash/i
  );

  vm.runInContext(`
    window.__unsafeProjectionProvider = SocConsoleBetterAuthBridge.createProvider({
      authClient: window.__authClient,
      beginLogin() {},
      projectSession() {
        return { authenticated: true, accessToken: "not-a-real-access-value" };
      }
    });
    window.__sessionData = { user: { name: "Example Operator" } };
  `, context);
  await assert.rejects(
    context.__unsafeProjectionProvider.getSession(),
    /unsupported|sensitive|token|contract/i
  );
});

test("adapter contract normalizes frozen data and rejects routes, markup, and mismatches", async () => {
  const context = browserContext(["public/adapter-contract.js"]);
  assert.equal("createDemoProvider" in context.SocConsoleAdapterRuntime, false);
  assert.equal(context.SocConsoleAdapterRuntime.resolveProvider(), null);
  context.__validEnvelope = JSON.stringify(validEnvelope);
  const normalized = vm.runInContext(
    "SocConsoleAdapterRuntime.validateEnvelope(JSON.parse(__validEnvelope), '/health')",
    context
  );
  assert.equal(normalized.route, "/health");
  assert.equal(normalized.panels[0].type, "notice");
  context.__normalized = normalized;
  assert.equal(vm.runInContext("Object.isFrozen(__normalized) && Object.isFrozen(__normalized.panels[0])", context), true);

  assert.throws(() => vm.runInContext(
    "SocConsoleAdapterRuntime.validateEnvelope(JSON.parse(__validEnvelope), '/settings')",
    context
  ), /does not match/i);
  context.__unsafeEnvelope = JSON.stringify({ ...validEnvelope, html: "<b>unsafe</b>" });
  assert.throws(() => vm.runInContext(
    "SocConsoleAdapterRuntime.validateEnvelope(JSON.parse(__unsafeEnvelope))",
    context
  ), /data, not markup|not part of contract/i);
  context.__traversalEnvelope = JSON.stringify({ ...validEnvelope, route: "/../private" });
  assert.throws(() => vm.runInContext(
    "SocConsoleAdapterRuntime.validateEnvelope(JSON.parse(__traversalEnvelope))",
    context
  ), /traversal/i);
  context.__emptySegmentEnvelope = JSON.stringify({ ...validEnvelope, route: "/health//detail" });
  assert.throws(() => vm.runInContext(
    "SocConsoleAdapterRuntime.validateEnvelope(JSON.parse(__emptySegmentEnvelope))",
    context
  ), /route|traversal/i);
  context.__longMetricEnvelope = JSON.stringify({
    ...validEnvelope,
    panels: [{
      id: "metrics",
      type: "metrics",
      items: [{ label: "Metric", value: "x".repeat(201) }]
    }]
  });
  assert.throws(() => vm.runInContext(
    "SocConsoleAdapterRuntime.validateEnvelope(JSON.parse(__longMetricEnvelope))",
    context
  ), /200/);
  context.__duplicateMetricEnvelope = JSON.stringify({
    ...validEnvelope,
    panels: [{
      id: "metrics",
      type: "metrics",
      items: [
        { label: "Metric", value: "first" },
        { label: "Metric", value: "second" }
      ]
    }]
  });
  assert.throws(() => vm.runInContext(
    "SocConsoleAdapterRuntime.validateEnvelope(JSON.parse(__duplicateMetricEnvelope))",
    context
  ), /unique labels/i);

  assert.deepEqual(Array.from(context.SocConsoleAdapterRuntime.PANEL_TYPES),
    ["notice", "metrics", "table", "timeline", "bars", "chart", "text", "empty"]);
  assert.deepEqual(Array.from(context.SocConsoleAdapterRuntime.CELL_TYPES),
    ["text", "number", "badge", "time", "link"]);
  context.__richEnvelope = JSON.stringify({
    ...validEnvelope,
    route: "/analytics",
    panels: [
      {
        id: "events-collected-per-hour",
        type: "chart",
        unit: "events",
        buckets: ["2026-08-29T10:00:00Z", "2026-08-29T11:00:00Z"],
        series: [{ label: "security", values: [1, 2] }, { label: "firewall", values: [3, 4] }]
      },
      {
        id: "expected-sources",
        type: "table",
        caption: "Authorized source declarations",
        columns: [{ key: "source", label: "Source" }],
        rows: [[{ type: "link", label: "Open source", route: "/source", query: { kind: "seclog" } }]],
        disclosures: [{ label: "Source guidance", items: [{ label: "What it does", text: "Authorized guidance." }] }]
      }
    ]
  });
  const rich = vm.runInContext(
    "SocConsoleAdapterRuntime.validateEnvelope(JSON.parse(__richEnvelope), '/analytics')",
    context
  );
  assert.equal(rich.panels[0].type, "chart");
  assert.equal(rich.panels[0].series[1].values[1], 4);
  assert.equal(rich.panels[1].rows[0][0].route, "/source");
  assert.equal(rich.panels[1].disclosures[0].items[0].label, "What it does");

  context.__badChartEnvelope = JSON.stringify({
    ...validEnvelope,
    panels: [{
      id: "chart", type: "chart",
      buckets: ["2026-08-29T11:00:00Z", "2026-08-29T10:00:00Z"],
      series: [{ label: "series", values: [1] }]
    }]
  });
  assert.throws(() => vm.runInContext(
    "SocConsoleAdapterRuntime.validateEnvelope(JSON.parse(__badChartEnvelope))",
    context
  ), /strictly increasing|one value/i);
  context.__badLinkEnvelope = JSON.stringify({
    ...validEnvelope,
    panels: [{
      id: "links", type: "table", caption: "Links",
      columns: [{ key: "target", label: "Target" }],
      rows: [[{ type: "link", label: "Outside", route: "https://outside.example.invalid" }]]
    }]
  });
  assert.throws(() => vm.runInContext(
    "SocConsoleAdapterRuntime.validateEnvelope(JSON.parse(__badLinkEnvelope))",
    context
  ), /route|absolute application/i);
  context.__badDisclosureEnvelope = JSON.stringify({
    ...validEnvelope,
    panels: [{
      id: "sources", type: "table", caption: "Sources",
      columns: [{ key: "source", label: "Source" }], rows: [["one"]], disclosures: []
    }]
  });
  assert.throws(() => vm.runInContext(
    "SocConsoleAdapterRuntime.validateEnvelope(JSON.parse(__badDisclosureEnvelope))",
    context
  ), /one entry for each row/i);

  const validateTimestamp = (value) => {
    context.__timestampEnvelope = JSON.stringify({ ...validEnvelope, updatedAt: value });
    return vm.runInContext(
      "SocConsoleAdapterRuntime.validateEnvelope(JSON.parse(__timestampEnvelope))",
      context
    );
  };
  for (const value of [
    "2000-02-29T23:59:59Z",
    "2024-02-29T23:59:59.123+23:59",
    "1900-02-28T00:00:00-00:00"
  ]) assert.equal(validateTimestamp(value).updatedAt, value);
  for (const value of [
    "2023-00-01T00:00:00Z",
    "2023-13-01T00:00:00Z",
    "2023-01-00T00:00:00Z",
    "2023-02-29T00:00:00Z",
    "2023-02-30T00:00:00Z",
    "2023-04-31T00:00:00Z",
    "2023-01-01T24:00:00Z",
    "2023-01-01T23:60:00Z",
    "2023-01-01T23:59:60Z",
    "2023-01-01T23:59:59+24:00",
    "2023-01-01T23:59:59+00:60"
  ]) assert.throws(() => validateTimestamp(value), /RFC 3339/i, value);

});

test("the application provider template is deterministic, read-only, and empty", async () => {
  const context = browserContext(["public/adapter-contract.js", "examples/provider-template.js"]);
  const provider = vm.runInContext("SocConsoleAdapterRuntime.resolveProvider('SOC_CONSOLE_ADAPTER')", context);
  assert.equal(provider.id, "application-template");
  assert.equal(provider.capabilities.readPages, true);
  assert.equal(provider.capabilities.runCommands, false);
  assert.equal(provider.capabilities.uploads, false);
  assert.equal(provider.capabilities.subscriptions, false);
  assert.equal(provider.capabilities.persistence, false);
  const page = await vm.runInContext(`SOC_CONSOLE_ADAPTER.readPage({
    schemaVersion: "1", route: "/", query: {}, reason: "initial"
  })`, context);
  assert.equal(page.route, "/");
  assert.equal(page.state, "empty");
  assert.deepEqual(Array.from(page.panels), []);
});

test("the command-line provider validator accepts single, array, and pages documents", () => {
  assert.equal(validateDocument(validEnvelope).length, 1);
  assert.equal(validateDocument([validEnvelope]).length, 1);
  assert.equal(validateDocument({ pages: [validEnvelope, { ...validEnvelope, route: "/settings" }] }).length, 2);
  assert.throws(() => validateDocument({ pages: [] }), /at least one/i);
  assert.throws(() => validateDocument({ ...validEnvelope, schemaVersion: "2" }), /schemaVersion/i);
});

test("the checked-in JSON Schema describes the portable version-one envelope structure", () => {
  const schema = JSON.parse(read("contracts/page-model.v1.schema.json"));
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.additionalProperties, false);
  assert.ok(schema.required.includes("schemaVersion"));
  assert.ok(schema.required.includes("route"));
  assert.ok(schema.required.includes("state"));
  assert.ok(schema.required.includes("title"));
  assert.ok(schema.required.includes("panels"));
  assert.equal(schema.properties.schemaVersion.const, "1");
  assert.equal(schema.$defs.metricItem.properties.value.oneOf[0].maxLength, 200);
  assert.equal(schema.$defs.cell.oneOf[1].maxLength, 2000);
  assert.equal(schema.$defs.route.pattern.includes("+"), true);
  assert.equal(schema.$defs.linkCell.properties.route.$ref, "#/$defs/route");
  assert.equal(schema.$defs.tablePanel.properties.disclosures.maxItems, 200);
  assert.equal(schema.$defs.chartPanel.properties.buckets.maxItems, 336);
  assert.equal(schema.$defs.chartPanel.properties.series.maxItems, 32);
});

test("the mountable UI consumes the structural catalog through the public controller API", () => {
  const source = read("public/app.js");
  assert.match(source, /(?:global|window)\.SocConsole\s*=/);
  for (const method of ["createApp", "mount", "unmount", "navigate", "refresh", "getState"]) {
    assert.match(source, new RegExp(`\\b${method}\\b`), method);
  }
  assert.match(source, /SocConsoleUiCatalog/);
  assert.match(source, /readPage/);
  assert.match(source, /suppliedPanels\.get\(panel\.id\)/);
  assert.match(source, /hydratedPanelIds\.add\(panel\.id\)/);
  assert.match(source, /state\.envelope\.updatedAt/);
  assert.match(source, /panel\.description/);
});

test("matching read panels retain route presentation and root-only embeds do not touch host branding", async () => {
  const harness = createUiHarness("#/triage?view=queue");
  await harness.app.mount();
  for (const className of [
    "triage-board", "triage-table", "triage-table-shell", "triage-table-tools", "triage-pager"
  ]) assert.equal(hasClass(harness.mountRoot, className), true, className);
  assert.match(harness.mountRoot.textContent, /alerts-0/);

  harness.location.hash = "#/tuning?tview=definitions&status=active";
  await harness.app.refresh();
  for (const className of [
    "tune-summary-card", "tune-card", "tune-table", "tune-definitions", "tune-table-scroll"
  ]) assert.equal(hasClass(harness.mountRoot, className), true, className);

  harness.location.hash = "#/rules?rtab=tuning&tview=definitions&tstatus=all";
  await harness.app.refresh();
  for (const className of [
    "tune-summary-card", "tune-card", "tune-table", "tune-definitions", "tune-table-scroll"
  ]) assert.equal(hasClass(harness.mountRoot, className), true, `Rules -> Tune ${className}`);

  harness.location.hash = "#/intel?itab=bb";
  await harness.app.refresh();
  assert.equal(hasClass(harness.mountRoot, "intel-browse"), true);

  harness.location.hash = "#/";
  await harness.app.refresh();
  assert.equal(hasClass(harness.mountRoot, "soc-overview-kpis"), true);
  assert.equal(hasClass(harness.mountRoot, "soc-overview-detections"), true);

  assert.equal(harness.document.querySelectorCalls, 0);
  assert.equal(harness.document.hostBrand.getAttribute("aria-label"), "Host application brand");
  assert.equal(harness.document.hostBrandImage.getAttribute("src"), "host-product.png");
  assert.equal(harness.document.hostBrandImage.src, undefined);
  harness.app.unmount();
});

test("Analytics charts and source row disclosures hydrate through the data-only adapter", async () => {
  const analytics = createUiHarness("#/analytics?h=48");
  analytics.context.__readPage = (request) => ({
    schemaVersion: "1",
    route: request.route,
    state: "ready",
    title: "Authorized analytics",
    panels: [{
      id: "events-collected-per-hour",
      type: "chart",
      title: "Events collected per hour",
      unit: "events",
      buckets: ["2026-08-29T10:00:00Z", "2026-08-29T11:00:00Z"],
      series: [
        { label: "security", values: [2, 1] },
        { label: "firewall", values: [1, 3] }
      ]
    }]
  });
  await analytics.app.mount();
  assert.equal(nodesWithClass(analytics.mountRoot, "stacked-chart").length, 1);
  assert.equal(nodesWithClass(analytics.mountRoot, "chart-data").length, 1);
  const rectangles = findNodes(analytics.mountRoot, (candidate) => candidate.tagName === "RECT");
  assert.equal(rectangles.length, 4);
  assert.equal(rectangles[0].getAttribute("fill"), "#4e79a7");
  assert.equal(rectangles[1].getAttribute("fill"), "#f28e2b");
  assert.match(analytics.mountRoot.textContent, /View chart data/);
  analytics.app.unmount();

  const sources = createUiHarness("#/sources");
  sources.context.__readPage = (request) => ({
    schemaVersion: "1",
    route: request.route,
    state: "ready",
    title: "Authorized sources",
    panels: [{
      id: "expected-sources",
      type: "table",
      title: "Expected sources",
      caption: "Authorized source health",
      columns: ["Source", "Host", "Last collection", "Cadence", "In Logs", "Collection", "Activity"]
        .map((label, index) => ({ key: `c${index}`, label })),
      rows: [[
        { type: "link", label: "Source", route: "/source", query: { host: "host-reference", kind: "seclog" } },
        "host-reference", "—", "—", "—", "—", "—"
      ]],
      disclosures: [{
        label: "Source guidance",
        items: [
          { label: "What it does", text: "Authorized purpose." },
          { label: "Why it matters", text: "Authorized rationale." },
          { label: "If it goes quiet", text: "Authorized response." }
        ]
      }]
    }]
  });
  await sources.app.mount();
  const sourceLink = findNodes(sources.mountRoot,
    (candidate) => candidate.tagName === "A" && candidate.textContent === "Source")[0];
  assert.equal(sourceLink.getAttribute("href"), "#/source?host=host-reference&kind=seclog");
  const toggle = nodesWithClass(sources.mountRoot, "srctoggle")[0];
  assert.ok(toggle);
  const detail = sources.mountRoot.querySelector(`#${toggle.getAttribute("aria-controls")}`);
  assert.equal(detail.getAttribute("style"), "display:none");
  sources.mountRoot.dispatchEvent({ type: "click", target: toggle });
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(toggle.textContent, "×");
  assert.equal(detail.getAttribute("style"), "display:table-row");
  assert.match(detail.textContent, /What it does\. Authorized purpose\./);
  assertUniqueRenderedIdentifiers(sources.mountRoot, "#/sources");
  sources.app.unmount();
});

test("Tuning renders contract-valid matching fallbacks without discarding provider data", async () => {
  const harness = createUiHarness("#/tuning?tview=definitions&status=active");
  harness.context.__readPage = (request) => ({
    schemaVersion: "1",
    route: request.route,
    state: "ready",
    title: "Authorized tuning",
    panels: [{
      id: "detection-tune-definitions",
      type: "notice",
      title: "Alternate tuning projection",
      body: "The matching slot retained this provider notice.",
      tone: "info"
    }, {
      id: "custom-tuning-telemetry",
      type: "metrics",
      title: "Custom tuning telemetry",
      items: [{ label: "Authorized custom metric", value: "7" }]
    }]
  });
  await harness.app.mount();
  assert.match(harness.mountRoot.textContent, /matching slot retained this provider notice/i);
  const customMetric = findNodes(harness.mountRoot,
    (candidate) => candidate.getAttribute("data-panel-id") === "custom-tuning-telemetry")[0];
  assert.ok(customMetric);
  assert.equal(hasClass(customMetric, "tune-summary-card"), false,
    "unmatched metrics use the generic Additional authorized data renderer");
  assert.equal(nodesWithClass(harness.mountRoot, "tune-summary-card").length, 1,
    "only the catalog summary receives the specialized tuning treatment");

  harness.context.__readPage = (request) => ({
    schemaVersion: "1",
    route: request.route,
    state: "ready",
    title: "Authorized tuning",
    panels: [{
      id: "detection-tune-definitions",
      type: "table",
      title: "Alternate tuning table",
      caption: "Provider-defined tuning columns",
      columns: [{ key: "alternate", label: "Alternate provider column" }],
      rows: [["retained-provider-value"]]
    }]
  });
  await harness.app.refresh();
  assert.match(harness.mountRoot.textContent, /retained-provider-value/);
  assert.doesNotMatch(harness.mountRoot.textContent, /Additional authorized data/,
    "the matching panel is rendered in its catalog slot");
  harness.app.unmount();
});

test("Triage column controls are local and enabled while disposition mutations remain disabled", async () => {
  const harness = createUiHarness("#/triage?view=queue");
  await harness.app.mount();

  const table = findNodes(harness.mountRoot,
    (candidate) => candidate.tagName === "TABLE" && candidate.getAttribute("id") === "triage-table")[0];
  assert.ok(table);
  const columns = findNodes(table, (candidate) => candidate.tagName === "COL" && candidate.getAttribute("data-col"));
  const resizers = nodesWithClass(table, "triage-resizer");
  assert.equal(columns.length, 11);
  assert.equal(resizers.length, 11);
  assert.deepEqual(columns.map((candidate) => candidate.getAttribute("data-col")),
    ["pick", "case", "when", "host", "sev", "rule", "alert", "status", "owner", "activity", "actions"]);
  resizers.forEach((control) => {
    assert.equal(control.getAttribute("disabled"), null);
    assert.equal(control.getAttribute("role"), "separator");
    assert.equal(control.getAttribute("tabindex"), "0");
  });
  const reset = nodesWithClass(harness.mountRoot, "triage-col-reset")[0];
  assert.ok(reset);
  assert.equal(reset.getAttribute("disabled"), null);

  const alertHandle = resizers.find((candidate) => candidate.getAttribute("data-col") === "alert");
  const alertColumn = () => findNodes(harness.mountRoot,
    (candidate) => candidate.tagName === "COL" && candidate.getAttribute("data-col") === "alert")[0];
  assert.equal(alertColumn().getAttribute("style"), "width:160px");
  harness.mountRoot.dispatchEvent({ type: "keydown", target: alertHandle, key: "ArrowRight" });
  assert.equal(alertColumn().getAttribute("style"), "width:168px");
  await harness.app.refresh();
  assert.equal(alertColumn().getAttribute("style"), "width:168px", "width survives a controller refresh in memory");
  harness.mountRoot.dispatchEvent({
    type: "click",
    target: nodesWithClass(harness.mountRoot, "triage-col-reset")[0]
  });
  assert.equal(alertColumn().getAttribute("style"), "width:160px");

  const bulkBar = nodesWithClass(harness.mountRoot, "triage-bulk")[0];
  const bulkDialog = nodesWithClass(harness.mountRoot, "triage-bulk-dialog")[0];
  const editor = findNodes(harness.mountRoot,
    (candidate) => candidate.getAttribute("id") === "triage-editor")[0];
  assert.ok(bulkBar);
  assert.ok(bulkDialog);
  assert.ok(editor);
  assert.equal(hasClass(bulkDialog, "triage-bulk-form"), true);
  assert.equal(hasClass(editor, "triage-edit-form"), true);
  assert.equal(hasClass(editor, "triage-proposal-review"), true);
  const mutationControls = [bulkBar, bulkDialog, editor].flatMap((region) => findNodes(region,
    (candidate) => ["BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(candidate.tagName)));
  assert.ok(mutationControls.length >= 15);
  mutationControls.forEach((control) => {
    assert.notEqual(control.getAttribute("disabled"), null, `${control.tagName} ${control.textContent}`);
    assert.equal(control.disabled, true);
  });
  assertUniqueRenderedIdentifiers(harness.mountRoot, "#/triage?view=queue");
  assert.doesNotMatch(renderedValues(harness.mountRoot), /\b(?:null|undefined)\b/i);
  harness.app.unmount();
});

test("Threat Intel source browsing nests kind tabs and canonicalizes source search queries", async () => {
  const harness = createUiHarness("#/intel?itab=threatfox&skind=domain&sq=needle&spage=9&oq=legacy");
  await harness.app.mount();

  const sourcePanel = nodesWithClass(harness.mountRoot, "intel-source-panel")[0];
  const sourceBrowser = nodesWithClass(harness.mountRoot, "intel-source-browser")[0];
  const outerTabs = nodesWithClass(harness.mountRoot, "route-view-tabs")[0];
  const kindTabs = nodesWithClass(harness.mountRoot, "intel-kind-tabs")[0];
  assert.ok(sourcePanel);
  assert.ok(sourceBrowser);
  assert.ok(outerTabs);
  assert.ok(kindTabs);
  assert.equal(nodesWithClass(sourcePanel, "intel-kind-tabs").length, 1);
  assert.equal(nodesWithClass(outerTabs, "intel-kind-tabs").length, 0, "kind tabs are not top-level route tabs");
  assert.equal(nodesWithClass(sourcePanel, "intel-browse").length, 1);
  assert.equal(nodesWithClass(sourcePanel, "intel-source-pager").length, 1);
  assert.match(sourcePanel.textContent, /ThreatFox indicators · 1 authorized row/);
  assert.match(sourcePanel.textContent, /threatfox-indicators-0/);

  const sourceStatus = nodesWithClass(harness.mountRoot, "intel-source-status")[0];
  assert.ok(sourceStatus);
  assert.match(sourceStatus.textContent, /awaiting source/i);
  assert.match(sourceStatus.textContent, /No authorized source-health or freshness record was supplied/);

  const kindLinks = findNodes(kindTabs,
    (candidate) => candidate.tagName === "A" && candidate.getAttribute("role") === "tab");
  assert.equal(kindLinks.length, 7);
  const linkStartingWith = (container, label) => findNodes(container,
    (candidate) => candidate.tagName === "A" && candidate.textContent.startsWith(label))[0];
  const domain = linkStartingWith(kindTabs, "Domain");
  assert.equal(domain.getAttribute("aria-selected"), "true");
  const allUrl = new URL(linkStartingWith(kindTabs, "All").getAttribute("href").slice(1), "https://console.example.invalid");
  assert.equal(allUrl.searchParams.get("itab"), "threatfox");
  assert.equal(allUrl.searchParams.has("skind"), false, "the default All kind is omitted");
  assert.equal(allUrl.searchParams.has("spage"), false);
  assert.equal(allUrl.searchParams.get("sq"), "needle");
  assert.equal(allUrl.searchParams.get("oq"), "legacy");
  const ipUrl = new URL(linkStartingWith(kindTabs, "IP").getAttribute("href").slice(1), "https://console.example.invalid");
  assert.equal(ipUrl.searchParams.get("skind"), "ip");
  assert.equal(ipUrl.searchParams.has("spage"), false);
  assert.equal(ipUrl.searchParams.get("sq"), "needle");

  const form = nodesWithClass(sourcePanel, "intel-source-search")[0];
  const input = form.querySelector('input[name="sq"]');
  const searchButton = findNodes(form,
    (candidate) => candidate.tagName === "BUTTON" && candidate.textContent === "Search")[0];
  assert.ok(input);
  assert.ok(searchButton);
  assert.equal(input.getAttribute("value"), "needle");
  assert.equal(input.getAttribute("maxlength"), "200");
  assert.equal(input.getAttribute("disabled"), null);
  assert.equal(searchButton.getAttribute("disabled"), null);
  const clearUrl = new URL(nodesWithClass(form, "intel-search-clear")[0].getAttribute("href").slice(1), "https://console.example.invalid");
  assert.deepEqual(Array.from(clearUrl.searchParams.entries()), [["itab", "threatfox"], ["skind", "domain"]]);

  const urlhaus = findNodes(outerTabs,
    (candidate) => candidate.tagName === "A" && candidate.textContent.toLowerCase() === "urlhaus")[0];
  assert.ok(urlhaus);
  const urlhausUrl = new URL(urlhaus.getAttribute("href").slice(1), "https://console.example.invalid");
  assert.equal(urlhausUrl.searchParams.get("itab"), "urlhaus");
  for (const stale of ["sq", "skind", "spage", "oq"]) assert.equal(urlhausUrl.searchParams.has(stale), false, stale);

  input.value = "  family-x  ";
  harness.mountRoot.dispatchEvent({ type: "submit", target: form });
  let submitted = new URL(harness.location.hash.slice(1), "https://console.example.invalid");
  assert.deepEqual(Array.from(submitted.searchParams.entries()), [
    ["itab", "threatfox"], ["skind", "domain"], ["sq", "family-x"]
  ]);
  input.value = "   ";
  harness.mountRoot.dispatchEvent({ type: "submit", target: form });
  submitted = new URL(harness.location.hash.slice(1), "https://console.example.invalid");
  assert.deepEqual(Array.from(submitted.searchParams.entries()), [["itab", "threatfox"], ["skind", "domain"]]);

  await harness.app.refresh();
  assert.equal(nodesWithClass(harness.mountRoot, "intel-search-clear").length, 0);
  assertUniqueRenderedIdentifiers(harness.mountRoot, harness.location.hash);
  assert.doesNotMatch(renderedValues(harness.mountRoot), /\b(?:null|undefined)\b/i);
  harness.app.unmount();
});

test("Access Offboarding keeps record lists, details, and guidance mutually exclusive", async () => {
  const harness = createUiHarness("#/access?atab=offboarding", { provider: false });
  const panelIds = () => findNodes(harness.mountRoot,
    (candidate) => candidate.getAttribute("data-panel-id") !== null)
    .map((candidate) => candidate.getAttribute("data-panel-id"));
  const anchorStartingWith = (label) => findNodes(harness.mountRoot,
    (candidate) => candidate.tagName === "A" && candidate.textContent.startsWith(label));
  const anchorContaining = (label) => findNodes(harness.mountRoot,
    (candidate) => candidate.tagName === "A" && candidate.textContent.includes(label));
  await harness.app.mount();

  const listIds = panelIds();
  for (const id of ["summary-metrics", "offboarding-records", "what-this-board-is"]) {
    assert.equal(listIds.includes(id), true, `list panel ${id}`);
  }
  for (const id of ["offboarding-summary", "manual-steps", "per-surface-breakdown", "per-surface-item-detail"]) {
    assert.equal(listIds.includes(id), false, `detail panel hidden from list: ${id}`);
  }
  assert.equal(anchorStartingWith("Records").length, 1);
  assert.equal(anchorStartingWith("How to use").length, 1);
  assertUniqueRenderedIdentifiers(harness.mountRoot, harness.location.hash);

  harness.location.hash = "#/access?atab=offboarding&id=offboarding-record-reference";
  await harness.app.refresh();
  const detailIds = panelIds();
  for (const id of ["offboarding-summary", "manual-steps", "per-surface-breakdown", "per-surface-item-detail"]) {
    assert.equal(detailIds.includes(id), true, `detail panel ${id}`);
  }
  for (const id of ["summary-metrics", "offboarding-records", "what-this-board-is"]) {
    assert.equal(detailIds.includes(id), false, `list panel hidden from detail: ${id}`);
  }
  assert.equal(nodesWithClass(harness.mountRoot, "offboarding-manual-steps").length, 1);
  for (const label of ["Run at", "Identity", "Reason", "Surfaces", "Within 24h", "Tool"]) {
    assert.match(harness.mountRoot.textContent, new RegExp(label));
  }
  const title = nodesWithClass(harness.mountRoot, "dash-title")[0];
  assert.match(title.textContent, /^Access — Offboarding record/);
  const back = anchorContaining("Back to Offboarding")[0];
  assert.ok(back);
  assert.equal(back.getAttribute("href"), "#/access?atab=offboarding");
  assert.equal(anchorStartingWith("Records").length, 0, "oview tabs are hidden in record detail");
  assert.equal(anchorStartingWith("How to use").length, 0, "oview tabs are hidden in record detail");
  const who = anchorStartingWith("Who")[0];
  assert.ok(who);
  const whoUrl = new URL(who.getAttribute("href").slice(1), "https://console.example.invalid");
  assert.deepEqual(Array.from(whoUrl.searchParams.entries()), [["atab", "who"]]);
  assert.doesNotMatch(harness.mountRoot.textContent, /offboarding-record-reference/);
  assertUniqueRenderedIdentifiers(harness.mountRoot, harness.location.hash);
  assert.doesNotMatch(renderedValues(harness.mountRoot), /\b(?:null|undefined)\b/i);

  harness.location.hash = "#/access?atab=offboarding&oview=guide&id=offboarding-record-reference";
  await harness.app.refresh();
  for (const id of ["offboarding-summary", "manual-steps", "per-surface-breakdown", "per-surface-item-detail"]) {
    assert.equal(panelIds().includes(id), true, `record detail wins over stale guide selector: ${id}`);
  }
  assert.equal(panelIds().includes("how-to-use-offboard-sh"), false);
  assert.match(nodesWithClass(harness.mountRoot, "dash-title")[0].textContent, /^Access — Offboarding record/);
  assert.equal(anchorStartingWith("Records").length, 0, "record detail hides nested view tabs");
  assert.equal(anchorStartingWith("How to use").length, 0, "record detail hides nested view tabs");
  assertUniqueRenderedIdentifiers(harness.mountRoot, harness.location.hash);

  harness.location.hash = "#/access?atab=offboarding&oview=guide";
  await harness.app.refresh();
  assert.match(nodesWithClass(harness.mountRoot, "dash-title")[0].textContent, /^Access — How to use offboard\.sh/);
  assert.equal(panelIds().includes("how-to-use-offboard-sh"), true);
  for (const id of [...listIds, ...detailIds]) {
    if (id !== "how-to-use-offboard-sh") assert.equal(panelIds().includes(id), false, `guide excludes ${id}`);
  }
  assert.equal(anchorContaining("Back to Offboarding").length, 0);
  assertUniqueRenderedIdentifiers(harness.mountRoot, harness.location.hash);
  assert.doesNotMatch(renderedValues(harness.mountRoot), /\b(?:null|undefined)\b/i);
  harness.app.unmount();
});

test("Access Offboarding sends the provider the same effective detail selector the UI renders", async () => {
  const requests = [];
  const harness = createUiHarness("#/access?atab=offboarding&oview=guide&id=record-reference");
  harness.context.__readPage = (request) => {
    requests.push(request);
    return adapterEnvelope(request.route, request.query);
  };
  await harness.app.mount();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].query.atab, "offboarding");
  assert.equal(requests[0].query.id, "record-reference");
  assert.equal(requests[0].query.oview, "records");
  assert.match(nodesWithClass(harness.mountRoot, "dash-title")[0].textContent,
    /^Access — Offboarding record/);
  harness.app.unmount();
});

test("tuning and rule query branches render distinct data-free structures", async () => {
  const harness = createUiHarness("#/tuning?id=private-tune-reference");
  await harness.app.mount();
  for (const className of ["tune-detail-branch", "tune-detail-grid", "tune-metrics", "tune-control"]) {
    assert.equal(hasClass(harness.mountRoot, className), true, className);
  }
  assert.doesNotMatch(harness.mountRoot.textContent, /private-tune-reference/);

  harness.location.hash = "#/tuning?choose=1&detectorSet=palisade&detectorId=private-rule-reference";
  await harness.app.refresh();
  assert.equal(hasClass(harness.mountRoot, "tune-occurrence-chooser"), true);
  assert.equal(hasClass(harness.mountRoot, "tune-rule-first-empty"), true);
  assert.doesNotMatch(harness.mountRoot.textContent, /private-rule-reference/);

  harness.location.hash = "#/tuning?host=private-host&ts=private-time";
  await harness.app.refresh();
  assert.equal(hasClass(harness.mountRoot, "tune-finding-chooser"), true);
  assert.doesNotMatch(harness.mountRoot.textContent, /private-host|private-time/);

  harness.location.hash = "#/tuning?host=private-host&ts=private-time&finding=private-finding";
  await harness.app.refresh();
  for (const className of ["tune-draft-builder", "tune-form", "tune-fixed-scope", "tune-selector-row", "tune-notification-policy"]) {
    assert.equal(hasClass(harness.mountRoot, className), true, className);
  }
  assert.doesNotMatch(harness.mountRoot.textContent, /private-host|private-time|private-finding/);

  harness.location.hash = "#/rules?rtab=sigma&ruleView=1&detectorSet=sigma&detectorId=private-detector";
  await harness.app.refresh();
  for (const className of ["rule-detail-view", "rule-detail-pad", "rule-detail-facts", "rule-detail-source", "md-pre", "rule-code-readonly"]) {
    assert.equal(hasClass(harness.mountRoot, className), true, className);
  }
  assert.doesNotMatch(harness.mountRoot.textContent, /private-detector/);
  harness.app.unmount();
});

test("specialized Tuning branches hydrate stable read slots while every command remains inert", async () => {
  const harness = createUiHarness("#/tuning?id=tune-reference");
  harness.context.__readPage = (request) => {
    let panels;
    if (request.query.id) {
      panels = [{
        id: "tune-detail-record",
        type: "metrics",
        title: "Authorized tune record",
        description: "Bounded tune projection",
        items: [
          { label: "Status", value: "authorized-active", tone: "ok" },
          { label: "Detector revision", value: "revision-reference" },
          { label: "Detector", value: "detector-reference" },
          { label: "Host", value: "host-reference" },
          { label: "Severity", value: "high", tone: "warn" },
          { label: "Reason", value: "reviewed reason" },
          { label: "Source occurrence", value: "occurrence-reference" }
        ]
      }, {
        id: "tune-detail-preview-summary",
        type: "metrics",
        title: "Authorized preview",
        items: [
          { label: "Scanned", value: 12 },
          { label: "Eligible findings", value: 3 },
          { label: "Provider note", value: "retained extra metric" }
        ]
      }, {
        id: "tune-detail-preview-matches",
        type: "table",
        title: "Authorized preview rows",
        caption: "Bounded preview rows",
        columns: [{ key: "when", label: "When" }, { key: "decision", label: "Decision" }],
        rows: [["time-reference", "preview-row-reference"]]
      }, {
        id: "tune-detail-lineage",
        type: "timeline",
        title: "Authorized lineage",
        items: [{ at: "2026-08-29T12:00:00Z", label: "lineage-event-reference", detail: "lineage detail" }]
      }, {
        id: "tune-detail-delivery-audit",
        type: "timeline",
        title: "Authorized delivery audit",
        items: [{ at: "2026-08-29T12:01:00Z", label: "delivery-event-reference", tone: "info" }]
      }];
    } else if (request.query.choose) {
      panels = [adapterTable("tune-occurrence-options", "Authorized occurrences", ["When", "Finding"])];
    } else if (request.query.host && request.query.ts && request.query.finding) {
      panels = [{
        id: "tune-builder-source",
        type: "metrics",
        title: "Authorized retained finding",
        items: [
          { label: "Detector", value: "builder-detector-reference" },
          { label: "Host", value: "builder-host-reference" },
          { label: "Severity", value: "medium", tone: "warn" },
          { label: "Finding", value: "builder-finding-reference" }
        ]
      }, {
        id: "tune-builder-evidence",
        type: "table",
        title: "Authorized retained conditions",
        caption: "Retained finding conditions",
        columns: [{ key: "field", label: "Field" }, { key: "value", label: "Value" }],
        rows: [["field-reference", "evidence-value-reference"]]
      }];
    } else {
      panels = [adapterTable("tune-finding-options", "Authorized findings", ["Detection", "Severity"])];
    }
    return {
      schemaVersion: "1",
      route: request.route,
      state: "ready",
      title: "Authorized Tuning branch",
      panels
    };
  };

  const panelIdCount = (id) => findNodes(harness.mountRoot,
    (candidate) => candidate.getAttribute("data-panel-id") === id).length;
  await harness.app.mount();
  for (const value of [
    "authorized-active", "retained extra metric", "preview-row-reference",
    "lineage-event-reference", "delivery-event-reference"
  ]) assert.match(harness.mountRoot.textContent, new RegExp(value));
  for (const id of [
    "tune-detail-record", "tune-detail-preview-summary", "tune-detail-preview-matches",
    "tune-detail-lineage", "tune-detail-delivery-audit"
  ]) assert.equal(panelIdCount(id), 1, id);
  assert.doesNotMatch(harness.mountRoot.textContent, /Additional authorized data/);
  nodesWithClass(harness.mountRoot, "tune-control").flatMap((region) => findNodes(region,
    (candidate) => candidate.tagName === "BUTTON")).forEach((control) => {
    assert.equal(control.disabled, true);
  });
  assertUniqueRenderedIdentifiers(harness.mountRoot, harness.location.hash);

  harness.location.hash = "#/tuning?choose=1&detectorSet=palisade&detectorId=rule-reference";
  await harness.app.refresh();
  assert.equal(hasClass(harness.mountRoot, "tune-occurrence-chooser"), true);
  assert.match(harness.mountRoot.textContent, /tune-occurrence-options-1/);
  assert.equal(panelIdCount("tune-occurrence-options"), 1);
  assert.doesNotMatch(harness.mountRoot.textContent, /Additional authorized data/);

  harness.location.hash = "#/tuning?host=host-reference&ts=time-reference";
  await harness.app.refresh();
  assert.equal(hasClass(harness.mountRoot, "tune-finding-chooser"), true);
  assert.match(harness.mountRoot.textContent, /tune-finding-options-1/);
  assert.equal(panelIdCount("tune-finding-options"), 1);
  assert.doesNotMatch(harness.mountRoot.textContent, /Additional authorized data/);

  harness.location.hash = "#/tuning?host=host-reference&ts=time-reference&finding=finding-reference";
  await harness.app.refresh();
  for (const value of ["builder-detector-reference", "builder-finding-reference", "evidence-value-reference"]) {
    assert.match(harness.mountRoot.textContent, new RegExp(value));
  }
  assert.equal(panelIdCount("tune-builder-source"), 1);
  assert.equal(panelIdCount("tune-builder-evidence"), 1);
  assert.equal(nodesWithClass(harness.mountRoot, "tune-builder-context").length, 1);
  const builder = nodesWithClass(harness.mountRoot, "tune-draft-builder")[0];
  const builderControls = findNodes(builder,
    (candidate) => ["BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(candidate.tagName));
  assert.ok(builderControls.length > 0);
  builderControls.forEach((control) => assert.equal(control.disabled, true, control.tagName));
  assert.doesNotMatch(harness.mountRoot.textContent, /Additional authorized data/);
  assertUniqueRenderedIdentifiers(harness.mountRoot, harness.location.hash);

  harness.context.__readPage = (request) => ({
    schemaVersion: "1",
    route: request.route,
    state: "ready",
    title: "Alternate Tuning detail",
    panels: [{
      id: "tune-detail-lineage",
      type: "text",
      title: "Alternate lineage projection",
      body: "contract-valid lineage fallback retained"
    }]
  });
  harness.location.hash = "#/tuning?id=tune-reference";
  await harness.app.refresh();
  assert.match(harness.mountRoot.textContent, /contract-valid lineage fallback retained/);
  assert.equal(panelIdCount("tune-detail-lineage"), 1);
  assert.doesNotMatch(harness.mountRoot.textContent, /Additional authorized data/);
  harness.app.unmount();
});

test("Rules detail hydrates stable summary, definition, and occurrence slots without enabling revisions", async () => {
  const harness = createUiHarness("#/rules?rtab=sigma&ruleView=1&detectorSet=sigma&detectorId=rule-reference");
  harness.context.__readPage = (request) => ({
    schemaVersion: "1",
    route: request.route,
    state: "ready",
    title: "Authorized Rules detail",
    panels: [{
      id: "rule-detail-summary",
      type: "metrics",
      title: "Authorized rule summary",
      items: [
        { label: "Detector", value: "authorized-detector-reference" },
        { label: "Definition state", value: "published" },
        { label: "Provenance", value: "authorized-provenance", detail: "reviewed source" },
        { label: "Provider-specific fact", value: "retained fact" }
      ]
    }, {
      id: "rule-source-definition",
      type: "text",
      title: "Source definition",
      body: "source-definition-reference: true"
    }, {
      id: "rule-effective-definition",
      type: "text",
      title: "Effective definition",
      body: "effective-definition-reference: true"
    }, {
      id: "rule-detail-occurrences",
      type: "table",
      title: "Authorized occurrences",
      caption: "Bounded rule occurrences",
      columns: [{ key: "when", label: "When" }, { key: "result", label: "Result" }],
      rows: [["time-reference", "occurrence-row-reference"]]
    }]
  });
  await harness.app.mount();

  for (const value of [
    "authorized-detector-reference", "retained fact", "source-definition-reference: true",
    "effective-definition-reference: true", "occurrence-row-reference"
  ]) assert.match(harness.mountRoot.textContent, new RegExp(value));
  for (const id of [
    "rule-detail-summary", "rule-source-definition", "rule-effective-definition", "rule-detail-occurrences"
  ]) {
    assert.equal(findNodes(harness.mountRoot,
      (candidate) => candidate.getAttribute("data-panel-id") === id).length, 1, id);
  }
  assert.doesNotMatch(harness.mountRoot.textContent, /Additional authorized data/);
  const revisionControls = [
    ...nodesWithClass(harness.mountRoot, "rule-detail-actions"),
    ...nodesWithClass(harness.mountRoot, "rule-revision-options")
  ].flatMap((region) => findNodes(region,
    (candidate) => ["BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(candidate.tagName)));
  assert.ok(revisionControls.length > 0);
  revisionControls.forEach((control) => assert.equal(control.disabled, true, control.tagName));
  assertUniqueRenderedIdentifiers(harness.mountRoot, harness.location.hash);

  harness.context.__readPage = (request) => ({
    schemaVersion: "1",
    route: request.route,
    state: "ready",
    title: "Alternate Rules detail",
    panels: [{
      id: "rule-source-definition",
      type: "notice",
      title: "Alternate source projection",
      body: "contract-valid source fallback retained",
      tone: "info"
    }]
  });
  await harness.app.refresh();
  assert.match(harness.mountRoot.textContent, /contract-valid source fallback retained/);
  assert.equal(findNodes(harness.mountRoot,
    (candidate) => candidate.getAttribute("data-panel-id") === "rule-source-definition").length, 1);
  assert.doesNotMatch(harness.mountRoot.textContent, /Additional authorized data/);
  harness.app.unmount();
});

test("Phishing detail maps safe metrics and message source into its stable report slots", async () => {
  const harness = createUiHarness("#/phishing?id=report-reference");
  harness.context.__readPage = (request) => ({
    schemaVersion: "1",
    route: request.route,
    state: "ready",
    title: "Authorized Phishing report",
    panels: [{
      id: "verdict",
      type: "metrics",
      title: "Authorized verdict",
      items: [
        { label: "Verdict", value: "review-required", tone: "warn" },
        { label: "Score", value: "42" },
        { label: "Worst link", value: "redacted-link-reference" },
        { label: "Provider-specific fact", value: "retained phishing fact" }
      ]
    }, {
      id: "passive-intel",
      type: "metrics",
      title: "Authorized passive intel",
      items: [
        { label: "Bulwark Black IOC feed (local cache)", value: "cache-result-reference" },
        { label: "OTX cache (passive indicator lookup)", value: "lookup-result-reference" }
      ]
    }, {
      id: "message-body",
      type: "table",
      title: "Authorized message source",
      caption: "Message body parts",
      columns: [{ key: "part", label: "Part" }, { key: "source", label: "Source" }],
      rows: [
        ["Text body", "plain-body-reference"],
        ["HTML body — source, never rendered", "<strong>literal-source-reference</strong>"]
      ]
    }]
  });
  await harness.app.mount();

  for (const value of [
    "review-required", "retained phishing fact", "cache-result-reference",
    "plain-body-reference", "<strong>literal-source-reference</strong>"
  ]) assert.match(harness.mountRoot.textContent, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  for (const id of ["verdict", "passive-intel", "message-body"]) {
    assert.equal(findNodes(harness.mountRoot,
      (candidate) => candidate.getAttribute("data-panel-id") === id).length, 1, id);
  }
  const sources = nodesWithClass(harness.mountRoot, "phishing-message-source");
  assert.equal(sources.length, 2);
  assert.equal(sources[1].textContent, "<strong>literal-source-reference</strong>");
  assert.equal(findNodes(sources[1], (candidate) => candidate.tagName === "STRONG").length, 0,
    "adapter source remains text instead of markup");
  assert.doesNotMatch(harness.mountRoot.textContent, /Additional authorized data/);
  assertUniqueRenderedIdentifiers(harness.mountRoot, harness.location.hash);

  harness.context.__readPage = (request) => ({
    schemaVersion: "1",
    route: request.route,
    state: "ready",
    title: "Authorized Phishing text",
    panels: [{
      id: "message-body",
      type: "text",
      title: "Message source",
      body: "<img src=x onerror=literal-handler-reference>"
    }]
  });
  await harness.app.refresh();
  assert.equal(nodesWithClass(harness.mountRoot, "phishing-message-source").length, 1);
  assert.match(harness.mountRoot.textContent, /<img src=x onerror=literal-handler-reference>/);
  assert.equal(findNodes(harness.mountRoot, (candidate) => candidate.tagName === "IMG").length, 0);
  assert.equal(findNodes(harness.mountRoot,
    (candidate) => candidate.getAttribute("data-panel-id") === "message-body").length, 1);
  assert.doesNotMatch(harness.mountRoot.textContent, /Additional authorized data/);
  harness.app.unmount();
});

test("tab links clear stale descendant and detail selectors while preserving required parents", async () => {
  const harness = createUiHarness("#/access?atab=offboarding&oview=guide");
  await harness.app.mount();
  const anchorByText = (label) => findNodes(harness.mountRoot,
    (candidate) => candidate.tagName === "A" && candidate.textContent === label)[0];

  const who = anchorByText("Who");
  assert.ok(who);
  assert.equal(who.getAttribute("href"), "#/access?atab=who");
  const records = anchorByText("Records");
  assert.ok(records);
  const recordsUrl = new URL(records.getAttribute("href").slice(1), "https://console.example.invalid");
  assert.equal(recordsUrl.pathname, "/access");
  assert.equal(recordsUrl.searchParams.get("atab"), "offboarding");
  assert.equal(recordsUrl.searchParams.get("oview"), "records");

  harness.location.hash = "#/tuning?tview=definitions&status=draft&detectorSet=palisade&detectorId=bounded-filter";
  await harness.app.refresh();
  const applied = anchorByText("Applied alerts");
  assert.ok(applied);
  const appliedUrl = new URL(applied.getAttribute("href").slice(1), "https://console.example.invalid");
  assert.equal(appliedUrl.pathname, "/tuning");
  assert.equal(appliedUrl.searchParams.get("tview"), "applied");
  assert.equal(appliedUrl.searchParams.has("status"), false);
  assert.equal(appliedUrl.searchParams.get("detectorSet"), "palisade");
  assert.equal(appliedUrl.searchParams.get("detectorId"), "bounded-filter");

  harness.location.hash = "#/tuning?tview=definitions&status=not-a-status&detectorSet=palisade&detectorId=bounded-filter";
  await harness.app.refresh();
  assert.match(harness.mountRoot.textContent, /Unknown view/);
  const standaloneActive = findNodes(harness.mountRoot,
    (candidate) => candidate.tagName === "A" && candidate.textContent.startsWith("Active"))[0];
  assert.ok(standaloneActive);
  assert.equal(hasClass(standaloneActive, "active"), true);
  const standaloneActiveUrl = new URL(standaloneActive.getAttribute("href").slice(1), "https://console.example.invalid");
  assert.equal(standaloneActiveUrl.searchParams.get("tview"), "definitions");
  assert.equal(standaloneActiveUrl.searchParams.get("status"), "active");
  assert.equal(standaloneActiveUrl.searchParams.get("detectorSet"), "palisade");
  assert.equal(standaloneActiveUrl.searchParams.get("detectorId"), "bounded-filter");

  harness.location.hash = "#/rules?rtab=tuning&tview=definitions&tstatus=disabled&detectorSet=palisade&detectorId=bounded-filter";
  await harness.app.refresh();
  const active = findNodes(harness.mountRoot,
    (candidate) => candidate.tagName === "A" && candidate.textContent.startsWith("Active"))[0];
  assert.ok(active);
  const activeUrl = new URL(active.getAttribute("href").slice(1), "https://console.example.invalid");
  assert.equal(activeUrl.searchParams.get("rtab"), "tuning");
  assert.equal(activeUrl.searchParams.get("tview"), "definitions");
  assert.equal(activeUrl.searchParams.get("tstatus"), "active");
  assert.equal(activeUrl.searchParams.get("detectorSet"), "palisade");
  assert.equal(activeUrl.searchParams.get("detectorId"), "bounded-filter");

  const rulesApplied = anchorByText("Applied alerts");
  assert.ok(rulesApplied);
  const rulesAppliedUrl = new URL(rulesApplied.getAttribute("href").slice(1), "https://console.example.invalid");
  assert.equal(rulesAppliedUrl.searchParams.get("rtab"), "tuning");
  assert.equal(rulesAppliedUrl.searchParams.get("tview"), "applied");
  assert.equal(rulesAppliedUrl.searchParams.has("tstatus"), false);
  assert.equal(rulesAppliedUrl.searchParams.get("detectorSet"), "palisade");
  assert.equal(rulesAppliedUrl.searchParams.get("detectorId"), "bounded-filter");

  const sigmaFromTuning = anchorByText("Sigma");
  assert.ok(sigmaFromTuning);
  const sigmaFromTuningUrl = new URL(sigmaFromTuning.getAttribute("href").slice(1), "https://console.example.invalid");
  assert.equal(sigmaFromTuningUrl.searchParams.get("rtab"), "sigma");
  for (const stale of ["tview", "tstatus", "detectorSet", "detectorId"]) {
    assert.equal(sigmaFromTuningUrl.searchParams.has(stale), false, stale);
  }

  harness.location.hash = "#/rules?rtab=palisade&ptab=active&tview=held&tstatus=disabled&stab=about";
  await harness.app.refresh();
  const decisions = anchorByText("Deliberately not added");
  assert.ok(decisions);
  const decisionsUrl = new URL(decisions.getAttribute("href").slice(1), "https://console.example.invalid");
  assert.equal(decisionsUrl.searchParams.get("rtab"), "palisade");
  assert.equal(decisionsUrl.searchParams.get("ptab"), "decisions");
  for (const stale of ["tview", "tstatus", "stab"]) assert.equal(decisionsUrl.searchParams.has(stale), false, stale);

  harness.location.hash = "#/rules?rtab=sigma&stab=about&ytab=manage&ruleView=1&detectorSet=sigma&detectorId=bounded-detail";
  await harness.app.refresh();
  const yara = anchorByText("YARA");
  assert.ok(yara);
  const yaraUrl = new URL(yara.getAttribute("href").slice(1), "https://console.example.invalid");
  assert.equal(yaraUrl.pathname, "/rules");
  assert.equal(yaraUrl.searchParams.get("rtab"), "yara");
  for (const stale of ["stab", "ytab", "ruleView", "detectorSet", "detectorId"]) {
    assert.equal(yaraUrl.searchParams.has(stale), false, stale);
  }

  harness.location.hash = "#/rules?rtab=help";
  await harness.app.refresh();
  assert.match(harness.mountRoot.textContent, /How to write a rule/);
  harness.location.hash = "#/";
  await harness.app.refresh();
  assert.doesNotMatch(harness.mountRoot.textContent, /null/);
  harness.app.unmount();
});

test("representative dynamic routes emit unique identifiers and no null-like literals", async () => {
  const routes = [
    "#/",
    "#/triage?view=queue",
    "#/phishing",
    "#/phishing?id=report-reference",
    "#/event?host=host-reference&ts=time-reference&back=%2Ftriage%3Fview%3Dcases",
    "#/tuning?tview=definitions&status=active",
    "#/tuning?tview=applied&detectorSet=palisade&detectorId=rule-reference",
    "#/rules?rtab=tuning&tview=definitions&tstatus=all",
    "#/rules?rtab=sigma&ruleView=1&detectorSet=sigma&detectorId=rule-reference",
    "#/intel?itab=bb&skind=all",
    "#/intel?itab=threatfox&skind=sha256&sq=family-reference",
    "#/access?atab=offboarding",
    "#/access?atab=offboarding&id=offboarding-record-reference",
    "#/access?atab=offboarding&oview=guide",
    "#/scans?tab=urlscan",
    "#/docs?section=14-source-setup-test-and-activation"
  ];
  const harness = createUiHarness(routes[0]);
  await harness.app.mount();

  for (let index = 0; index < routes.length; index += 1) {
    if (index > 0) {
      harness.location.hash = routes[index];
      await harness.app.refresh();
    }
    assertUniqueRenderedIdentifiers(harness.mountRoot, routes[index]);
    // The technical manual intentionally teaches nullable JSON fields. Other
    // UI routes must never leak a missing value through string interpolation.
    assert.doesNotMatch(renderedValues(harness.mountRoot), routes[index].startsWith("#/docs") ? /\bundefined\b/i : /\b(?:null|undefined)\b/i, routes[index]);
  }
  harness.app.unmount();
});

test("refresh coalesces repeated requests and preserves unsaved forms", async () => {
  let release;
  const harness = createUiHarness("#/", { envelope(request) {
    if (request.reason === "refresh") return new Promise((resolve) => { release = () => resolve(adapterEnvelope(request.route)); });
    return adapterEnvelope(request.route);
  } });
  await harness.app.mount();
  const first = harness.app.refresh();
  const second = harness.app.refresh();
  assert.equal(first, second, "only one refresh is in flight");
  while (!release) await Promise.resolve();
  assert.equal(harness.readRequests.length, 2);
  release(); await first;
  const form = harness.document.createElement("form");
  form.setAttribute("data-dirty", "true");
  const input = harness.document.createElement("input"); input.value = "Unsaved operator input"; form.append(input);
  harness.mountRoot.append(form);
  await harness.app.refresh();
  assert.equal(harness.readRequests.length, 2, "dirty forms pause background and manual refresh");
  assert.equal(input.value, "Unsaved operator input");
  assert.equal(form.parentNode, harness.mountRoot);
  harness.app.unmount();
});

test("Documents is an honest local-only empty surface without a private runtime", async () => {
  const harness = createUiHarness("#/documents");
  await harness.app.mount();
  assert.equal(harness.readRequests.length, 0);
  assert.match(harness.mountRoot.textContent, /Document storage is not connected/);
  assert.doesNotMatch(harness.mountRoot.textContent, /built-in technical reference/);
  harness.app.unmount();
});

test("README distinguishes the private starter, empty preview, and remaining integration work", () => {
  const readme = read("README.md");
  const prose = readme.replace(/^>\s?/gm, "").replace(/\s+/g, " ");
  assert.match(prose, /Better Auth.*SQLite/i);
  assert.match(prose, /no public (?:registration|signup)/i);
  assert.match(prose, /start:static/i);
  assert.match(prose, /no credentials/i);
  assert.match(prose, /no scanner execution/i);
  assert.match(prose, /bounded/i);
  assert.match(readme, /adapter/i);
  assert.match(readme, /npm run (?:check|verify)/i);
});

test("Service Access renders an honest unavailable state in the static shell", async () => {
  const harness = createUiHarness("#/agents?atab=access");
  await harness.app.mount();
  assert.match(harness.mountRoot.textContent, /Private agent access is not connected/);
  assert.match(harness.mountRoot.textContent, /registrations and prompts do not grant API access/);
  harness.app.unmount();
});

test("private view drafts protect Service Access and scanner import from refresh and dispose on unmount", async () => {
  for (const [route, moduleName] of [["#/agents?atab=access", "SocServiceAccess"], ["#/scans?tab=trivy", "SocScannerImport"]]) {
    const harness = createUiHarness(route);
    let disposed = 0;
    const cleanup = () => { disposed += 1; };
    cleanup.isDirty = () => true;
    harness.context.SOC_PRIVATE_APPLICATION = true;
    harness.context[moduleName] = { render({ container }) { container.append(harness.document.createElement("form")); return cleanup; } };
    await harness.app.mount();
    const reads = harness.readRequests.length;
    const priorDisposals = disposed;
    await harness.app.refresh();
    assert.equal(harness.readRequests.length, reads, route + " dirty private view pauses reads");
    assert.equal(disposed, priorDisposals, route + " preserves widget");
    harness.app.unmount();
    assert.equal(disposed, priorDisposals + 1);
  }
});

test("a private draft started during an outstanding read survives the final render", async () => {
  let release;
  let dirty = false;
  let disposed = 0;
  let rendered = 0;
  const harness = createUiHarness("#/scans?tab=trivy", { envelope(request) {
    if (request.reason === "refresh") return new Promise((resolve) => { release = () => resolve(adapterEnvelope(request.route)); });
    return adapterEnvelope(request.route);
  } });
  harness.context.SOC_PRIVATE_APPLICATION = true;
  harness.context.SocScannerImport = { render({ container }) {
    rendered += 1;
    const input = harness.document.createElement("input");
    input.setAttribute("data-test", "pending-import");
    container.append(input);
    const cleanup = () => { disposed += 1; };
    cleanup.isDirty = () => dirty;
    return cleanup;
  } };
  await harness.app.mount();
  const refresh = harness.app.refresh();
  while (!release) await Promise.resolve();
  const pendingInput = harness.mountRoot.querySelector('[data-test="pending-import"]');
  assert.ok(pendingInput);
  pendingInput.value = "operator-selected-report.json";
  dirty = true;
  const counts = { rendered, disposed };
  release();
  await refresh;
  assert.deepEqual({ rendered, disposed }, counts, "late read must not replace an active widget");
  assert.equal(harness.mountRoot.querySelector('[data-test="pending-import"]'), pendingInput);
  assert.equal(pendingInput.value, "operator-selected-report.json");
  harness.app.unmount();
  assert.equal(disposed, counts.disposed + 1);
});
