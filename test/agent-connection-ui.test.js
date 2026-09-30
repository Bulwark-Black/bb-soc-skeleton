"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
class Element {
  constructor(tag, text = "") { this.tagName = tag.toUpperCase(); this.childNodes = []; this.parentNode = null; this.dataset = {}; this.style = {}; this.attributes = {}; this.listeners = new Map(); this._value = ""; this._text = text; this.disabled = false; this.checked = false; this.defaultChecked = false; }
  append(...children) { for (const child of children) { if (child.parentNode) child.parentNode.childNodes = child.parentNode.childNodes.filter(item => item !== child); child.parentNode = this; this.childNodes.push(child); } }
  replaceChildren(...children) { this.childNodes.forEach(child => { child.parentNode = null; }); this.childNodes = []; this._text = ""; if (this.tagName === "SELECT") this._value = ""; this.append(...children); }
  get value() { if (this.tagName !== "SELECT") return this._value; const options = this.childNodes.filter(child => child.tagName === "OPTION"); return options.some(child => child.value === this._value) ? this._value : options[0]?.value || ""; }
  set value(value) { this._value = String(value); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(type, listener) { const list = this.listeners.get(type) || []; list.push(listener); this.listeners.set(type, list); }
  dispatchEvent(event) { if (!event.target) event.target = this; event.preventDefault ||= () => { event.defaultPrevented = true; }; for (const listener of this.listeners.get(event.type) || []) listener(event); if (event.bubbles && this.parentNode) this.parentNode.dispatchEvent(event); }
  click() { if (!this.disabled) this.dispatchEvent({ type: "click", bubbles: true }); }
  matches(selector) { return selector.split(",").some(value => { const part = value.trim(), name = /^(?:input)?\[name="([^"]+)"\](:checked)?$/.exec(part); return name ? this.name === name[1] && (!name[2] || this.checked) : this.tagName === part.toUpperCase(); }); }
  querySelectorAll(selector) { const result = []; for (const child of this.childNodes) { if (child.matches(selector)) result.push(child); result.push(...child.querySelectorAll(selector)); } return result; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  reset() { for (const child of this.querySelectorAll("input,select,textarea")) { child.value = ""; child.checked = child.defaultChecked; } }
  focus() {} select() {}
  get textContent() { return this._text + this.childNodes.map(child => child.textContent).join(""); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
}
const AT = "2026-09-29T12:00:00.000Z", AFTER = "2026-09-29T12:05:00.000Z", ID = "service-11111111-1111-4111-8111-111111111111", API = "/api/v1/service-access";
const defaults = ["connector:read", "agents:read", "governance:read"], scopes = [...defaults, "prompts:read", "setup:read", "connector:app.register", "administration:prompt.revise"];
const token = ["synthetic", "one-time", "service-value"].join("-");
const service = (extra = {}) => ({ id: ID, name: "Read-only helper", scopes: defaults, revision: 1, createdAt: AT, expiresAt: "2026-09-30T12:00:00.000Z", lastUsedAt: null, rotatedAt: null, revokedAt: null, status: "active", ...extra });
const auditEvent = (extra = {}) => ({ serviceId: ID, action: "connector.snapshot", actor: "service:" + ID, outcome: "authorized", occurredAt: AFTER, ...extra });
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise(setImmediate); };
function harness(t, options = {}) {
  const container = new Element("main"), requests = [], errors = [], confirmations = [], timers = new Map(), windowEvents = new Map(); let nextTimer = 0;
  const data = { services: options.services || [service()], audit: options.audit || [], availableScopes: options.scopes || scopes, defaultScopes: defaults, total: 1, offset: 0, nextOffset: null, ratePerMinute: 120, auditRetention: 10000, ...options.data };
  const fallback = (url, init) => {
    if (url.startsWith(API + "?")) return response(data);
    if (url === API && init.method === "POST") { const body = JSON.parse(init.body), created = service({ name: body.name, scopes: body.scopes }); data.services = [created]; return response({ service: created, oneTimeCredential: token }, 201); }
    if (url.endsWith("/rotate")) { const rotated = service({ revision: 2, rotatedAt: AFTER }); data.services = [rotated]; return response({ service: rotated, oneTimeCredential: token }); }
    if (url.endsWith("/revoke")) { const revoked = service({ revision: 2, revokedAt: AFTER, status: "revoked" }); data.services = [revoked]; return response({ service: revoked }); }
    throw new Error("Unexpected synthetic request.");
  };
  const context = vm.createContext({ AbortController, TextDecoder, URL,
    setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id), SOC_PRIVATE_APPLICATION: options.private !== false,
    addEventListener: (type, action) => windowEvents.set(type, action), removeEventListener: type => windowEvents.delete(type),
    confirm: message => { confirmations.push(message); return options.confirm !== false; },
    document: { createElement: tag => new Element(tag), createTextNode: text => new Element("#text", String(text)) },
    fetch: async (url, init) => { requests.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined }); return options.fetch ? options.fetch(url, init, fallback) : fallback(url, init); }
  }); context.window = context;
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "public/service-access.js"), "utf8"), context, { filename: "service-access.js" });
  const cleanup = context.SocServiceAccess.render({ container, onError: error => errors.push(error) }); t.after(cleanup);
  return { container, requests, errors, confirmations, timers, cleanup, data, windowEvents,
    field: name => container.querySelector('[name="' + name + '"]'), scope: name => container.querySelectorAll("input").find(item => item.name === "scope" && item.value === name),
    button: label => container.querySelectorAll("button").find(item => item.textContent === label),
    selectIdentity: () => container.querySelectorAll("button").find(item => item.textContent.startsWith("Guide this identity")).click(),
    submit: () => container.querySelectorAll("form")[0].dispatchEvent({ type: "submit", bubbles: true }),
    output: () => container.querySelectorAll("pre").map(item => item.textContent)
  };
}
function change(node, value) { assert.ok(node); assert.equal(node.disabled, false); if (node.type === "checkbox") node.checked = value; else node.value = value; node.dispatchEvent({ type: "change", bubbles: true }); }
function fillConfig(h, extra = {}) { change(h.field("agentCheckout"), extra.checkout || "/workspace/bb-soc"); change(h.field("agentTokenFile"), extra.tokenFile || "/private/agent/service-token"); change(h.field("agentBaseUrl"), extra.baseUrl || "http://127.0.0.1:8080"); }

test("static assistant has no requests, credentials, timers or mutation forms", async t => {
  const h = harness(t, { private: false }); await settle(); assert.equal(h.requests.length, 0); assert.equal(h.timers.size, 0); assert.equal(h.field("serviceName"), null); assert.equal(h.cleanup.isDirty(), false);
  assert.match(h.container.textContent, /separate from agent enrollment/); assert.match(h.container.textContent, /do not issue service credentials/);
});

test("purpose presets are read-only, prompt bodies are explicit and changing purpose removes writes", async t => {
  const h = harness(t); await settle(); assert.deepEqual(h.container.querySelectorAll('input[name="scope"]:checked').map(item => item.value), defaults);
  change(h.scope("prompts:read"), true); change(h.scope("connector:app.register"), true); change(h.field("servicePurpose"), "setup");
  assert.deepEqual(h.container.querySelectorAll('input[name="scope"]:checked').map(item => item.value), ["connector:read", "setup:read"]);
  change(h.field("servicePurpose"), "agents"); assert.deepEqual(h.container.querySelectorAll('input[name="scope"]:checked').map(item => item.value), ["agents:read"]);
  change(h.field("servicePurpose"), "governance"); assert.deepEqual(h.container.querySelectorAll('input[name="scope"]:checked').map(item => item.value), ["governance:read"]);
  change(h.field("servicePurpose"), "custom"); assert.equal(h.container.querySelectorAll('input[name="scope"]:checked').length, 0);
  assert.equal(h.requests.length, 1); assert.match(h.container.textContent, /whole single-tenant installation/);
});

test("missing optional setup scope is explained without inventing permission", async t => {
  const h = harness(t, { scopes: scopes.filter(scope => scope !== "setup:read") }); await settle(); change(h.field("servicePurpose"), "setup");
  assert.match(h.container.textContent, /does not offer setup:read/); assert.deepEqual(h.container.querySelectorAll('input[name="scope"]:checked').map(item => item.value), ["connector:read"]);
});

test("issuance sends exact reviewed scopes and displays one-time value without transmitting generator inputs", async t => {
  const h = harness(t); await settle(); change(h.field("serviceName"), "Setup observer"); change(h.field("servicePurpose"), "setup"); h.submit(); await settle();
  const sent = h.requests.find(item => item.init.method === "POST"); assert.deepEqual(sent.body, { name: "Setup observer", scopes: ["connector:read", "setup:read"], expiresInSeconds: 86400 });
  assert.equal(sent.init.credentials, "same-origin"); assert.equal(sent.init.redirect, "error"); assert.equal(sent.init.headers.Authorization, undefined);
  const secret = h.container.querySelector("textarea"); assert.equal(secret.value, token); assert.equal(h.cleanup.isDirty(), true); assert.equal(h.field("agentCheckout").disabled, true);
  h.button("I saved it — clear credential").click(); assert.equal(secret.value, ""); assert.equal(h.cleanup.isDirty(), false); assert.equal(h.field("agentCheckout").disabled, false);
  assert.match(h.container.textContent, /no retained authorized request/); assert.doesNotMatch(h.container.textContent, /Authorization observed —/);
});

test("write scopes require confirmation and empty or malformed issuance inputs are refused locally", async t => {
  const h = harness(t, { confirm: false }); await settle(); h.submit(); await settle(); assert.match(h.container.textContent, /Enter a service identity name/);
  change(h.field("serviceName"), "Reviewed writer"); change(h.field("servicePurpose"), "custom"); h.submit(); assert.match(h.container.textContent, /Choose at least one permission/);
  change(h.scope("connector:app.register"), true); h.submit(); await settle(); assert.equal(h.confirmations.length, 1); assert.equal(h.requests.filter(item => item.init.method === "POST").length, 0);
});

test("generator emits secret-free JSON and safely quoted POSIX arguments entirely locally", async t => {
  const h = harness(t); await settle(); h.selectIdentity();
  const checkout = "/workspace/owner's app/$(touch not-run)", tokenFile = "/private/owner's secrets/token";
  fillConfig(h, { checkout, tokenFile }); const before = h.requests.length; h.button("Generate secret-free MCP configuration").click();
  const output = h.output(), parsed = JSON.parse(output[0]);
  assert.deepEqual(parsed, { mcpServers: { "bb-soc": { command: "node", args: [checkout + "/tools/agent-mcp.js", "--base-url", "http://127.0.0.1:8080", "--token-file", tokenFile] } } });
  assert.match(output[1], /owner'"'"'s app/); assert.match(output[1], /'\/workspace\/owner'"'"'s app\/\$\(touch not-run\)\/tools\/agent-mcp.js'/);
  assert.ok(output[2].startsWith("chmod 600 '")); assert.equal(h.requests.length, before); assert.equal(h.cleanup.isDirty(), true);
  assert.doesNotMatch(output.join(""), new RegExp(token)); assert.match(h.container.textContent, /connector_snapshot with/); assert.match(h.container.textContent, /no network test was performed here/);
});

test("Windows absolute paths produce JSON arguments but no POSIX shell command", async t => {
  const h = harness(t); await settle(); h.selectIdentity(); fillConfig(h, { checkout: "C:\\Software Projects\\bb-soc", tokenFile: "D:\\Private\\token.txt" });
  h.button("Generate secret-free MCP configuration").click(); const output = h.output(); assert.equal(output.length, 1);
  assert.equal(JSON.parse(output[0]).mcpServers["bb-soc"].args[0], "C:\\Software Projects\\bb-soc\\tools\\agent-mcp.js"); assert.match(h.container.textContent, /no POSIX shell command is generated/);
});

test("generator refuses missing identity, checkout-contained tokens, ambiguous paths and controls", async t => {
  const h = harness(t); await settle(); fillConfig(h); h.button("Generate secret-free MCP configuration").click(); assert.match(h.container.textContent, /Select an active identity/);
  h.button("Discard configuration draft").click(); h.selectIdentity();
  const invalid = [
    { checkout: "relative/path" }, { checkout: "/workspace/../repo" }, { checkout: "/workspace//repo" }, { checkout: "/workspace/repo/" }, { checkout: "/" },
    { tokenFile: "/workspace/bb-soc/secret" }, { tokenFile: "/workspace/bb-soc" }, { tokenFile: "/private/token\nfile" },
    { checkout: "C:\\repo", tokenFile: "c:\\REPO\\secret" }, { checkout: "C:\\repo", tokenFile: "C:\\private\\file:stream" },
    { checkout: "C:\\repo", tokenFile: "/private/token" }
  ];
  for (const values of invalid) { fillConfig(h, values); h.button("Generate secret-free MCP configuration").click(); assert.equal(h.output().length, 0, JSON.stringify(values)); }
  assert.ok(h.requests.every(item => !item.init.method || item.init.method === "GET"));
});

test("remote origins require private HTTPS while exact loopback HTTP is allowed", async t => {
  const h = harness(t); await settle(); h.selectIdentity();
  // These synthetic destinations are parsed locally only; tests never contact them.
  const origin = (protocol, host, suffix = "") => protocol + "://" + host + suffix, ip = parts => parts.join("."), privateIp = ip([10, 1, 2, 3]);
  const allowed = [origin("http", "localhost", ":8080"), origin("http", ip([127, 0, 0, 1]), ":8080"), origin("http", "[::1]", ":8080"), origin("https", privateIp), ...[[172, 16, 0, 2], [192, 168, 1, 2], [100, 64, 1, 2]].map(parts => origin("https", ip(parts))), origin("https", "[fd00::1]"), origin("https", ["soc", "test", "ts", "net"].join("."))];
  for (const baseUrl of allowed) { fillConfig(h, { baseUrl }); h.button("Generate secret-free MCP configuration").click(); assert.ok(h.output().length, baseUrl); }
  const blocked = [origin("http", privateIp), origin("http", ip([127, 0, 0, 2])), origin("http", ip([127, 1])), origin("http", "2130706433"), origin("http", ["0177", 0, 0, 1].join(".")), origin("https", "example.invalid"), origin("https", "soc.example.invalid"), origin("https", "user:password@" + privateIp), ...["/path", "?q=1", "#fragment", ":0", "\n"].map(suffix => origin("https", privateIp, suffix)), origin("https", ip([10, 1, 2, "%33"])), "https:" + privateIp, "file:///private/token"];
  for (const baseUrl of blocked) { fillConfig(h, { baseUrl }); h.button("Generate secret-free MCP configuration").click(); assert.equal(h.output().length, 0, baseUrl); }
});

test("last-used timestamp and denied audit alone never certify authorization", async t => {
  const h = harness(t, { services: [service({ lastUsedAt: AFTER })], audit: [auditEvent({ outcome: "denied" })] }); await settle(); h.selectIdentity();
  assert.match(h.container.textContent, /Last authenticated attempt: 2026-09-29T12:05/); assert.match(h.container.textContent, /denied scope check can update this timestamp/);
  assert.match(h.container.textContent, /Waiting — no retained authorized request/); assert.match(h.container.textContent, /Needs attention — a request was denied for scope/); assert.doesNotMatch(h.container.textContent, /Authorization observed —/);
});

test("authorization evidence is identity-specific and never claims completion, delivery or agent health", async t => {
  const h = harness(t, { services: [service({ lastUsedAt: AFTER })], audit: [auditEvent(), auditEvent({ serviceId: "service-other" })] }); await settle(); h.selectIdentity();
  assert.match(h.container.textContent, /Authorization observed — connector.snapshot/); assert.match(h.container.textContent, /does not prove that the operation completed/);
  assert.match(h.container.textContent, /model execution, scheduling, continuous availability or agent health/); assert.match(h.container.textContent, /latest 100 events across the installation/);
  const before = h.requests.length; h.button("Refresh observed agent access").click(); await settle(); assert.equal(h.requests.length, before + 1); assert.ok(h.requests.every(item => item.url.startsWith(API + "?")));
});

test("pre-rotation and same-timestamp audit cannot prove a newly rotated credential", async t => {
  const h = harness(t, { services: [service({ rotatedAt: AFTER })], audit: [auditEvent(), auditEvent({ occurredAt: AT })] }); await settle(); h.selectIdentity();
  assert.doesNotMatch(h.container.textContent, /Authorization observed —/); assert.match(h.container.textContent, /same timestamp as rotation are conservatively excluded/);
  h.data.audit.unshift(auditEvent({ occurredAt: "2026-09-29T12:06:00.000Z" })); h.button("Refresh observed agent access").click(); await settle(); assert.match(h.container.textContent, /Authorization observed —/);
});

test("expired or revoked identity keeps historical evidence distinct from current usable access", async t => {
  const h = harness(t, { services: [service({ status: "expired" })], audit: [auditEvent()] }); await settle(); h.selectIdentity(); fillConfig(h); h.button("Generate secret-free MCP configuration").click();
  assert.equal(h.output().length, 0); assert.match(h.container.textContent, /expired or revoked/); assert.doesNotMatch(h.container.textContent, /Authorization observed —/);
});

test("config drafts block refresh, identity changes, mutations and pagination until generated or discarded", async t => {
  const h = harness(t, { data: { nextOffset: 50, total: 51 } }); await settle(); h.selectIdentity(); fillConfig(h); const before = h.requests.length;
  h.button("Refresh").click(); h.button("Next").click(); h.button("Rotate credential").click(); h.selectIdentity(); await settle();
  assert.equal(h.requests.length, before); assert.equal(h.cleanup.isDirty(), true); assert.equal(h.field("serviceName").disabled, true);
  const event = { preventDefault() { this.prevented = true; } }; h.windowEvents.get("beforeunload")(event); assert.equal(event.prevented, true);
  h.button("Discard configuration draft").click(); assert.equal(h.cleanup.isDirty(), false); assert.equal(h.field("agentCheckout").value, "");
  h.button("Next").click(); await settle(); assert.equal(h.requests.at(-1).url, API + "?offset=50&limit=50");
});

test("pagination does not treat a selected off-page identity's stale fields as current evidence", async t => {
  const h = harness(t, { data: { nextOffset: 50, total: 51 }, fetch: (url, init, fallback) => url.includes("offset=50") ? response({ services: [service({ id: "service-other", name: "Other" })], audit: [auditEvent()], availableScopes: scopes, defaultScopes: defaults, total: 51, nextOffset: null, ratePerMinute: 120, auditRetention: 10000 }) : fallback(url, init) });
  await settle(); h.selectIdentity(); fillConfig(h); h.button("Generate secret-free MCP configuration").click(); h.button("Next").click(); await settle();
  assert.equal(h.output().length, 0); assert.match(h.container.textContent, /not on the current page/); assert.doesNotMatch(h.container.textContent, /Authorization observed —/);
});

test("rotation and revocation preserve expected revisions, confirmation and secret clearing", async t => {
  const h = harness(t); await settle(); h.button("Rotate credential").click(); await settle(); const secret = h.container.querySelector("textarea"); assert.equal(secret.value, token);
  assert.deepEqual(h.requests.find(item => item.url.endsWith("/rotate")).body, { expectedRevision: 1 });
  h.button("Revoke access").click(); await settle(); assert.equal(h.requests.some(item => item.url.endsWith("/revoke")), false);
  h.button("I saved it — clear credential").click(); h.button("Revoke access").click(); await settle(); assert.deepEqual(h.requests.find(item => item.url.endsWith("/revoke")).body, { expectedRevision: 2 });
  assert.equal(h.confirmations.length, 2); assert.equal(secret.value, "");
});

test("one-time credential survives a failed following refresh, remains guarded and never leaks into errors", async t => {
  let reads = 0; const h = harness(t, { fetch: (url, init, fallback) => url.startsWith(API + "?") && ++reads > 1 ? response({ message: token }, 503) : fallback(url, init) }); await settle(); change(h.field("serviceName"), "Issued but refresh failed"); h.submit(); await settle();
  assert.equal(h.container.querySelector("textarea").value, token); assert.equal(h.cleanup.isDirty(), true); assert.doesNotMatch(h.container.textContent, new RegExp(token));
  assert.match(h.container.textContent, /request was refused/);
});

test("rotation immediately invalidates prior proof even if the following list refresh fails", async t => {
  let reads = 0;
  const h = harness(t, { audit: [auditEvent()], fetch: (url, init, fallback) => url.startsWith(API + "?") && ++reads > 1 ? response({}, 503) : fallback(url, init) });
  await settle(); h.selectIdentity(); assert.match(h.container.textContent, /Authorization observed —/);
  h.button("Rotate credential").click(); await settle();
  assert.equal(h.container.querySelector("textarea").value, token); assert.doesNotMatch(h.container.textContent, /Authorization observed —/);
  assert.match(h.container.textContent, /Credential rotated: 2026-09-29T12:05/);
});

test("revocation immediately invalidates current access even if the following list refresh fails", async t => {
  let reads = 0;
  const h = harness(t, { audit: [auditEvent()], fetch: (url, init, fallback) => url.startsWith(API + "?") && ++reads > 1 ? response({}, 503) : fallback(url, init) });
  await settle(); h.selectIdentity(); fillConfig(h); h.button("Generate secret-free MCP configuration").click();
  h.button("Revoke access").click(); await settle(); assert.equal(h.output().length, 0); assert.match(h.container.textContent, /expired or revoked/);
  assert.doesNotMatch(h.container.textContent, /Authorization observed —/);
});

test("setup-only identity gets a safe real-client setup read and write-only identity gets no write connectivity test", async t => {
  const h = harness(t, { services: [service({ scopes: ["setup:read"] })] }); await settle(); h.selectIdentity(); fillConfig(h); h.button("Generate secret-free MCP configuration").click(); assert.match(h.container.textContent, /setup_guides with \{\}/);
  const writer = harness(t, { services: [service({ scopes: ["connector:app.register"] })] }); await settle(); writer.selectIdentity(); fillConfig(writer); writer.button("Generate secret-free MCP configuration").click();
  assert.match(writer.container.textContent, /Do not use a write as a connectivity test/); assert.equal(writer.requests.filter(item => item.init.method === "POST").length, 0);
});

test("late issue response after cleanup cannot show secrets or schedule another refresh", async t => {
  let finish; const h = harness(t, { fetch: (url, init, fallback) => url === API && init.method === "POST" ? new Promise(resolve => { finish = resolve; }) : fallback(url, init) }); await settle(); change(h.field("serviceName"), "In flight"); h.submit(); await settle();
  const before = h.requests.length; h.cleanup(); finish(response({ service: service(), oneTimeCredential: token }, 201)); await settle();
  assert.equal(h.container.querySelector("textarea"), null); assert.equal(h.requests.length, before); assert.equal(h.errors.length, 0); assert.equal(h.timers.size, 0); assert.equal(h.windowEvents.size, 0);
});

test("late revoke response after cleanup cannot redraw stale access evidence or start a refresh", async t => {
  let finish;
  const h = harness(t, { fetch: (url, init, fallback) => url.endsWith("/revoke") ? new Promise(resolve => { finish = resolve; }) : fallback(url, init) });
  await settle(); h.selectIdentity(); h.button("Revoke access").click(); await settle(); h.cleanup();
  const before = h.container.textContent, requests = h.requests.length;
  finish(response({ service: service({ revokedAt: AFTER, status: "revoked" }) })); await settle();
  assert.equal(h.container.textContent, before); assert.equal(h.requests.length, requests); assert.equal(h.errors.length, 0);
});

test("cleanup clears retained secret element values and local configuration fields", async t => {
  const h = harness(t); await settle(); change(h.field("serviceName"), "Clean up"); h.submit(); await settle(); const secret = h.container.querySelector("textarea"), checkout = h.field("agentCheckout"); checkout.value = "/private/local-path";
  h.cleanup(); assert.equal(secret.value, ""); assert.equal(checkout.value, ""); assert.equal(h.container.querySelector("textarea"), null);
});

test("initial fetch failure can be retried and response bytes are bounded", async t => {
  let reads = 0; const h = harness(t, { fetch: (url, init, fallback) => ++reads === 1 ? response({}, 503) : fallback(url, init) }); await settle();
  assert.equal(h.field("serviceName").disabled, true); h.button("Reload service identities").click(); await settle(); assert.equal(h.field("serviceName").disabled, false);
  const big = harness(t, { fetch: () => new Response("x".repeat(4 * 1024 * 1024 + 1)) }); await settle(); assert.match(big.container.textContent, /response exceeds its limit/);
});

test("generated instructions survive widget refresh and remain protected from root remount until explicitly cleared", async t => {
  const h = harness(t); await settle(); h.selectIdentity(); fillConfig(h); h.button("Generate secret-free MCP configuration").click();
  const expected = h.output(); assert.equal(h.cleanup.isDirty(), true); assert.equal(h.container.querySelectorAll("form")[1].dataset.dirty, "true");
  h.button("Refresh observed agent access").click(); await settle(); assert.deepEqual(h.output(), expected);
  h.button("Discard configuration draft").click(); assert.equal(h.cleanup.isDirty(), false); assert.equal(h.container.querySelectorAll("form")[1].dataset.dirty, "false"); assert.equal(h.output().length, 0);
});

test("failed observed-access refresh invalidates earlier authorization proof while preserving generated instructions", async t => {
  let reads = 0;
  const h = harness(t, { audit: [auditEvent()], fetch: (url, init, fallback) => url.startsWith(API + "?") && ++reads > 1 ? response({}, 503) : fallback(url, init) }); await settle(); h.selectIdentity(); fillConfig(h); h.button("Generate secret-free MCP configuration").click();
  assert.match(h.container.textContent, /Authorization observed —/); const expected = h.output(); h.button("Refresh observed agent access").click(); await settle();
  assert.doesNotMatch(h.container.textContent, /Authorization observed —/); assert.match(h.container.textContent, /fresh service-access snapshot is unavailable/); assert.deepEqual(h.output(), expected);
});

test("client selector emits the documented Claude, Codex, Hermes and OpenClaw shapes without widening grants", async t => {
  const h = harness(t); await settle(); h.selectIdentity(); fillConfig(h);
  const before = h.requests.length, args = ["/workspace/bb-soc/tools/agent-mcp.js", "--base-url", "http://127.0.0.1:8080", "--token-file", "/private/agent/service-token"];
  for (const client of ["claude", "codex", "hermes", "openclaw"]) {
    change(h.field("agentClient"), client); h.button("Generate secret-free MCP configuration").click(); const output = h.output();
    if (client === "claude") {
      assert.deepEqual(JSON.parse(output[0]).mcpServers["bb-soc"], { command: "node", args });
      assert.match(output[3], /^claude mcp add --transport stdio --scope local bb-soc -- 'node'/);
    } else if (client === "codex") {
      assert.match(output[0], /^\[mcp_servers.bb-soc\]\ncommand = "node"\nargs = /);
      assert.deepEqual(JSON.parse(output[0].split("args = ")[1]), args);
    } else if (client === "hermes") {
      assert.match(output[0], /^mcp_servers:\n  bb-soc:\n    command: "node"\n    args: /);
      assert.deepEqual(JSON.parse(output[0].split("args: ")[1]), args);
    } else assert.deepEqual(JSON.parse(output[0]), { mcp: { servers: { "bb-soc": { command: "node", args, transport: "stdio", enabled: true } } } });
    assert.deepEqual(h.container.querySelectorAll('input[name="scope"]:checked').map(item => item.value), defaults);
    assert.doesNotMatch(output.join(""), new RegExp(token));
    assert.equal(h.requests.length, before);
  }
  assert.match(h.container.textContent, /model provider/); assert.match(h.container.textContent, /not a completed end-to-end test/);
});

test("client paths escape quotes, backslashes and Unicode while rejecting interpolated placeholders", async t => {
  const h = harness(t); await settle(); h.selectIdentity();
  const checkout = '/workspace/quoted "team" café', tokenFile = "/private/quoted \"token\"";
  fillConfig(h, { checkout, tokenFile });
  for (const client of ["claude", "codex", "hermes", "openclaw"]) {
    change(h.field("agentClient"), client); h.button("Generate secret-free MCP configuration").click(); const first = h.output()[0];
    const args = client === "codex" ? JSON.parse(first.split("args = ")[1]) : client === "hermes" ? JSON.parse(first.split("args: ")[1]) : client === "openclaw" ? JSON.parse(first).mcp.servers["bb-soc"].args : JSON.parse(first).mcpServers["bb-soc"].args;
    assert.equal(args[0], checkout + "/tools/agent-mcp.js"); assert.equal(args[4], tokenFile);
    fillConfig(h, { checkout: "/workspace/${REPLACED}/repo" }); h.button("Generate secret-free MCP configuration").click(); assert.equal(h.output().length, 0); assert.match(h.container.textContent, /may expand variable placeholders/);
    fillConfig(h, { checkout, tokenFile });
  }
  change(h.field("agentClient"), "codex"); fillConfig(h, { checkout: "C:\\Software Projects\\bb-soc", tokenFile: "D:\\Private\\token.txt" }); h.button("Generate secret-free MCP configuration").click();
  assert.equal(JSON.parse(h.output()[0].split("args = ")[1])[0], "C:\\Software Projects\\bb-soc\\tools\\agent-mcp.js"); assert.equal(h.output().length, 1);
});

test("Perplexity, Grok and unknown client selections never generate a public or unverified connector", async t => {
  const h = harness(t); await settle(); h.selectIdentity(); fillConfig(h); const before = h.requests.length;
  for (const client of ["perplexity", "grok"]) {
    change(h.field("agentClient"), client); h.button("Generate secret-free MCP configuration").click();
    assert.equal(h.output().length, 0); assert.match(h.container.textContent, /no verified direct private-stdio configuration/); assert.match(h.container.textContent, /Do not publish the SOC/);
    assert.equal(h.requests.length, before);
  }
  assert.match(h.container.textContent, /selecting a Grok model is different/i);
  change(h.field("agentClient"), "perplexity"); assert.match(h.container.textContent, /app, plan and administrator policy/); assert.match(h.container.textContent, /does not claim a verified Perplexity installation flow/);
  const invalid = new Element("option", "Unsupported client"); invalid.value = "unknown"; h.field("agentClient").append(invalid); change(h.field("agentClient"), "unknown"); h.button("Generate secret-free MCP configuration").click(); assert.equal(h.output().length, 0);
});

test("setup starter prompt is secret-free, scope-aware and explicit about human checkpoints and data egress", async t => {
  const h = harness(t, { services: [service({ scopes: ["connector:read", "setup:read", "connector:app.register"] })] }); await settle(); h.selectIdentity(); fillConfig(h); h.button("Generate secret-free MCP configuration").click();
  const prompt = h.container.querySelectorAll("textarea").find(node => node.getAttribute("aria-label") === "Secret-free AI setup prompt"); assert.ok(prompt); assert.equal(prompt.readOnly, true);
  for (const required of [/setup_application/, /soc:\/\/documentation\/ai-setup/, /connector:read, setup:read, connector:app.register/, /upper limit, not approval/, /explicit approval before each mutation/, /human checkpoints/, /model provider/, /never work around it/, /not writable through these MCP setup tools/, /revoking/i]) assert.match(prompt.value, required);
  assert.doesNotMatch(prompt.value, new RegExp(token)); assert.doesNotMatch(prompt.value, /\/private\/agent\/service-token/);
  const before = h.requests.length; h.button("Select setup prompt to copy").click(); assert.equal(h.requests.length, before); assert.match(h.container.textContent, /No prompt or credentials were sent/);
  assert.match(h.container.textContent, /None is selected automatically/); assert.match(h.container.textContent, /prompt asks for approval but is not a security control/);
});

test("selected client and prompt survive evidence refresh; changing client clears previous output and remains draft-protected", async t => {
  const h = harness(t); await settle(); h.selectIdentity(); fillConfig(h); change(h.field("agentClient"), "hermes"); h.button("Generate secret-free MCP configuration").click();
  const output = h.output(), prompt = h.container.querySelector("textarea").value; h.button("Refresh observed agent access").click(); await settle();
  assert.equal(h.field("agentClient").value, "hermes"); assert.deepEqual(h.output(), output); assert.equal(h.container.querySelector("textarea").value, prompt); assert.equal(h.cleanup.isDirty(), true);
  change(h.field("agentClient"), "codex"); assert.equal(h.output().length, 0); assert.equal(h.container.querySelector("textarea"), null); assert.equal(h.cleanup.isDirty(), true);
  const before = h.requests.length; h.button("Refresh observed agent access").click(); await settle(); assert.equal(h.requests.length, before);
  h.button("Discard configuration draft").click(); assert.equal(h.cleanup.isDirty(), false);
});

test("client selection is disabled while a one-time credential or issuance draft needs attention", async t => {
  const h = harness(t); await settle(); change(h.field("serviceName"), "Private setup helper"); assert.equal(h.field("agentClient").disabled, true); h.submit(); await settle();
  assert.equal(h.field("agentClient").disabled, true); h.button("I saved it — clear credential").click(); assert.equal(h.field("agentClient").disabled, false);
});
