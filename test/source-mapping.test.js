"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { RECORD_KINDS, validateIngestBatch } = require("../tools/ingest-contract");
const { mappingCatalog, inspectSourceMapping, previewSourceMapping, mapSourceText, validateRecipe, LIMITS } = require("../server/source-mapping");
const AT = "2026-09-29T12:00:00.000Z", clock = () => new Date(AT);
const recipe = (extra = {}) => ({ schemaVersion: "1", documentType: "source-mapping-recipe", appId: "app-synthetic", environment: "test", sourceId: "source-synthetic", kind: "log.event",
  upstreamId: { path: "/event/id" }, observedAt: { path: "/event/time" }, payload: { title: { path: "/event/title" }, state: { value: "unknown" }, message: { path: "/event/message" } }, ...extra });
const item = (extra = {}) => ({ event: { id: "synthetic-event", time: AT, title: "Synthetic reported event", message: "Synthetic redacted message", ...extra } });
function fixture() {
  const state = { apps: [{ appId: "app-synthetic", displayName: "Synthetic application", environments: ["test", "other"] }], integrationManifests: [],
    sources: [{ sourceId: "source-synthetic", appId: "app-synthetic", environment: "test", displayName: "Synthetic push source", connectorType: "canonical-events", state: "configured" }] };
  const enabled = new Set(["canonical-events", "canonical-push", "trivy-report"]);
  const runtime = { controlState: () => structuredClone(state), connectorAvailable: type => enabled.has(type) };
  return { state, enabled, runtime, preview: (extra = {}) => previewSourceMapping(runtime, { appId: "app-synthetic", environment: "test", sourceId: "source-synthetic", recipe: recipe(), text: JSON.stringify(item()), ...extra }, { clock }) };
}

test("inspection returns only own scalar paths, types and per-record presence; JSON Pointer escapes and array indexes work", () => {
  const text = JSON.stringify([{ "a/b": { "x~y": "synthetic-value-never-returned" }, list: [{ number: 2 }], optional: null }, { "a/b": { "x~y": 5 }, list: [{ number: false }] }]);
  const result = inspectSourceMapping({ text });
  assert.equal(result.records, 2);
  assert.deepEqual(result.fields, [{ path: "/a~1b/x~0y", types: ["number", "string"], present: 2 }, { path: "/list/0/number", types: ["boolean", "number"], present: 2 }, { path: "/optional", types: ["null"], present: 1 }]);
  assert.ok(!JSON.stringify(result).includes("synthetic-value-never-returned")); assert.ok(!JSON.stringify(result).includes(text));
  assert.equal(inspectSourceMapping({ text: JSON.stringify(item()) + "\n\n" + JSON.stringify(item({ id: "second" })) + "\n" }).records, 2);
});

test("mapper emits deterministic source-bound IDs, preserves original timestamp instants, and collapses only identical duplicates", () => {
  const first = item({ id: "first", time: "2026-09-29T05:00:00-07:00" }), second = item({ id: "second" });
  const result = mapSourceText(JSON.stringify([first, second, first]), recipe(), { clock });
  assert.deepEqual(validateIngestBatch(result.batch), result.batch); assert.equal(result.batch.records.length, 2); assert.equal(result.summary.duplicatesWithinInput, 1);
  assert.equal(result.summary.imported, false); assert.equal(result.summary.rawInputPersisted, false);
  assert.ok(result.batch.records.every(record => record.observedAt === AT && record.sourceId === "source-synthetic" && record.estateId === "app-synthetic"));
  assert.deepEqual(result.batch, mapSourceText(JSON.stringify([second, first]), recipe(), { clock }).batch);
  assert.match(result.batch.receiptId, /^mapped:[a-f0-9]{64}$/); assert.equal(result.batch.sentAt, AT);
  const rebound = mapSourceText(JSON.stringify([second, first]), recipe({ sourceId: "source-other" }), { clock });
  assert.notEqual(rebound.batch.records[0].recordId, result.batch.records[0].recordId);
  assert.throws(() => mapSourceText(JSON.stringify([first, item({ id: "first", message: "Conflicting content" })]), recipe(), { clock }), /conflicting content/);
});

test("all 29 canonical record kinds have complete required-field guidance and validate without manufactured verdicts", () => {
  const { runtime } = fixture(), catalog = mappingCatalog(runtime);
  assert.deepEqual(catalog.kinds.map(entry => entry.kind), [...RECORD_KINDS]);
  for (const spec of catalog.kinds) {
    const payload = {};
    for (const field of spec.requiredPayload) payload[field] = { value: field === "state" ? "unknown" : field === "severity" ? "unknown" : field === "indicatorType" ? "other" : "synthetic" };
    const result = mapSourceText(JSON.stringify(item()), recipe({ kind: spec.kind, payload }), { clock });
    assert.equal(result.batch.records[0].kind, spec.kind); assert.equal(result.batch.records[0].payload.state, "unknown"); validateIngestBatch(result.batch);
  }
});

test("strict parsing refuses malformed, wrapped, empty, huge, deep, broad and nonfinite input without reflecting values", () => {
  for (const text of ["", "[", "null", "123", "[]", "[[]]", JSON.stringify(Array.from({ length: 101 }, () => item())), "{\"number\":1e999}", JSON.stringify({ password: "DO-NOT-ECHO" })]) {
    assert.throws(() => inspectSourceMapping({ text }), error => error.code === "mapping-refused" && !error.message.includes("DO-NOT-ECHO"));
  }
  assert.throws(() => inspectSourceMapping({ text: " ".repeat(LIMITS.inputBytes + 1) }), error => error.status === 413);
  let nested = "value"; for (let i = 0; i < 11; i++) nested = { nested }; assert.throws(() => inspectSourceMapping({ text: JSON.stringify(nested) }), /depth/);
  assert.throws(() => inspectSourceMapping({ text: JSON.stringify(Object.fromEntries(Array.from({ length: 513 }, (_, i) => ["field" + i, 0]))) }), /512 distinct/);
  assert.equal(inspectSourceMapping({ text: JSON.stringify({ wrapper: [item()] }) }).records, 1, "Inspection does not silently unwrap a vendor page.");
  assert.throws(() => mapSourceText(JSON.stringify({ wrapper: [item()] }), recipe(), { clock }), /missing/);
});

test("secret-key and prototype fields are rejected even when not selected", () => {
  for (const name of ["api_key", "refresh-token", "myPassword", "authorization", "Cookie", "session_id", "__proto__", "constructor", "prototype"]) {
    const raw = JSON.stringify(item()).slice(0, -1) + "," + JSON.stringify(name) + ':"synthetic-never-echo"}';
    assert.throws(() => inspectSourceMapping({ text: raw }), error => error.code === "mapping-refused" && !error.message.includes("synthetic-never-echo"));
    assert.throws(() => validateRecipe(recipe({ upstreamId: { path: "/" + name } })), /Secret-bearing/);
    const draft = recipe(); draft.payload.fields = { [name]: { value: "synthetic" } }; assert.throws(() => validateRecipe(draft), /invalid or secret-bearing/);
  }
});

test("recipes contain no executable transforms, unknown keys, ambiguous selectors, constant IDs/timestamps or inherited reads", () => {
  for (const extra of [{ javascript: "synthetic-code" }, { transform: "synthetic-code" }, { schemaVersion: "2" }, { kind: "unsupported" },
    { upstreamId: { value: "invented-id" } }, { observedAt: { value: AT } }, { upstreamId: { path: "/event/id", value: "two" } },
    { upstreamId: { path: "/event/~2" } }, { upstreamId: { path: "event.id" } }]) assert.throws(() => validateRecipe(recipe(extra)), error => error.code === "mapping-refused");
  const draft = recipe(); draft.payload.title = Object.create({ path: "/event/title" }); assert.throws(() => validateRecipe(draft), /unsupported/);
  draft.payload.title = {}; Object.defineProperty(draft.payload.title, "path", { get() { throw new Error("Must not execute"); }, enumerable: true });
  assert.throws(() => validateRecipe(draft), /unsupported/);
});

test("mapping enforces canonical types, original identity and time without coercion or partial acceptance", () => {
  for (const data of [item({ id: null }), item({ id: "" }), item({ id: 9007199254740992 }), item({ time: "2026-02-30T00:00:00.000Z" }), item({ time: 123 }),
    item({ time: "2026-09-29T12:05:00.001Z" }), item({ title: { nested: "not scalar" } }), item({ title: true }), item({ message: "x".repeat(4001) })]) {
    assert.throws(() => mapSourceText(JSON.stringify([item(), data]), recipe(), { clock }), error => error.code === "mapping-refused");
  }
  const draft = recipe(); draft.payload.state = { value: "success" }; assert.throws(() => mapSourceText(JSON.stringify(item()), draft, { clock }), /canonical/);
  draft.payload.state = { value: "unknown" }; draft.payload.count = { value: "3" }; assert.throws(() => mapSourceText(JSON.stringify(item()), draft, { clock }), /canonical/);
  const missing = item(); delete missing.event.message; assert.throws(() => mapSourceText(JSON.stringify([item(), missing]), recipe(), { clock }), /missing/);
});

test("selected scalar fields and escaped nested paths work while unselected raw values are omitted", () => {
  const data = { ...item(), "original/id": [{ "time~stamp": AT }], unselected: "never-retain-this-text", num: 2, yes: true, nil: null };
  const draft = recipe({ observedAt: { path: "/original~1id/0/time~0stamp" } });
  draft.payload.fields = { number: { path: "/num" }, boolean: { path: "/yes" }, absent: { path: "/nil" }, reviewed: { value: "constant" } };
  const result = mapSourceText(JSON.stringify(data), draft, { clock });
  assert.deepEqual(result.batch.records[0].payload.fields, { absent: null, boolean: true, number: 2, reviewed: "constant" });
  assert.ok(!JSON.stringify(result).includes("never-retain-this-text"));
  assert.equal(mapSourceText(JSON.stringify(item({ id: 4 })), recipe(), { clock }).batch.records.length, 1);
});

test("server preview checks exact app/environment/source/driver/kind binding without source writes or acquisition", () => {
  const f = fixture(), before = JSON.stringify(f.state); const result = f.preview(); assert.equal(result.summary.imported, false); assert.equal(JSON.stringify(f.state), before);
  for (const extra of [{ appId: "other" }, { environment: "other" }, { sourceId: "other" }, { recipe: recipe({ appId: "other" }) }, { token: "synthetic" }]) assert.throws(() => f.preview(extra), error => error.status === 400);
  f.enabled.clear(); assert.throws(() => f.preview(), /enabled driver/); assert.equal(mappingCatalog(f.runtime).sources.length, 0); f.enabled.add("canonical-events");
  f.state.sources[0].state = "archived"; assert.throws(() => f.preview(), /nonarchived/); f.state.sources[0].state = "configured";
  f.state.sources[0].connectorType = "canonical-push"; f.enabled.add("canonical-push");
  assert.throws(() => f.preview({ recipe: recipe({ kind: "finding", payload: { title: { value: "x" }, state: { value: "unknown" }, severity: { value: "info" } } }) }), /supports this kind/);
  f.state.sources[0].connectorType = "trivy-report"; f.enabled.add("trivy-report"); assert.throws(() => f.preview(), /custom or canonical/);
});

test("expanded constants cannot exceed the canonical sender output limit", () => {
  const draft = recipe(); draft.payload.fields = Object.fromEntries(Array.from({ length: 20 }, (_, i) => ["field" + i, { value: "x".repeat(1000) }]));
  const input = Array.from({ length: 100 }, (_, i) => item({ id: "event-" + i }));
  assert.throws(() => mapSourceText(JSON.stringify(input), draft, { clock }), error => error.status === 413 && /1 MiB/.test(error.message));
});

test("private HTTP mapping enforces operator session, exact contracts and binding without collection or runtime mutation", async t => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
  const { startPrivateApplication } = require("../server/private-application");
  const { runAsOperator } = require("../server/operator-context");
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "bb-mapping-http-review-"));
  let app, cookie = "", outbound = 0, serial = 0;
  t.after(async () => { await app?.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  app = await startPrivateApplication({ stateDirectory: directory, port: 0, monitoring: { autoStart: false, fetchImpl: async () => { outbound++; throw new Error("No vendor calls allowed in mapping."); } } });
  const password = crypto.randomBytes(30).toString("base64url");
  await app.authentication.createOperator({ email: "mapping-owner@example.invalid", name: "Synthetic mapping owner", password });
  const request = (endpoint, body, { anonymous = false, headers = {}, method = body === undefined ? "GET" : "POST" } = {}) => fetch(app.url + endpoint, {
    method, headers: { Origin: app.url, Connection: "close", ...(cookie && !anonymous ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const expect = async (pending, status) => { const response = await pending, value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value; };
  const base = "/api/v1/source-mapping";
  await expect(request(base), 401); await expect(request(base + "/inspect", { text: JSON.stringify(item()) }), 401);
  const signed = await request("/api/auth/sign-in/email", { email: "mapping-owner@example.invalid", password }); assert.equal(signed.status, 200);
  cookie = signed.headers.getSetCookie().map(value => value.split(";")[0]).join("; "); await signed.arrayBuffer();
  const command = (name, input) => runAsOperator("mapping-test-owner", () => app.runtime.execute({ schemaVersion: "1", documentType: "connector-command-request", requestId: "mapping-review-" + (++serial), requestedAt: new Date().toISOString(), command: name, input }));
  const registered = command("app.register", { displayName: "Synthetic mapping app", environments: ["test"], publicPages: [] }); assert.equal(registered.status, "succeeded");
  const source = command("source.setup", { appId: registered.output.appId, environment: "test", connectorType: "canonical-events", sourceKind: "log.event", displayName: "Synthetic mapping source", config: { "cadence-seconds": 300 }, credentialReferences: [] }); assert.equal(source.status, "succeeded");
  const bound = recipe({ appId: registered.output.appId, sourceId: source.output.sourceId });
  const body = { appId: bound.appId, environment: "test", sourceId: bound.sourceId, recipe: bound, text: JSON.stringify(item({ time: new Date().toISOString() })) };
  for (const [endpoint, input] of [[base, undefined], [base + "/inspect", { text: body.text }], [base + "/preview", body]]) {
    await expect(request(endpoint, input, { anonymous: true }), 401);
    await expect(request(endpoint, input, { headers: { Authorization: "Bearer " + ["synthetic", "not-a-service-token"].join("-") } }), 401);
    await expect(request(endpoint, input, { headers: { Origin: "https://example.invalid" } }), 403);
  }
  await expect(request(base + "?extra=1"), 400);
  await expect(request(base + "/inspect?extra=1", { text: body.text }), 400);
  await expect(request(base + "/inspect", { text: body.text, token: ["synthetic", "unused-secret"].join("-") }), 400);
  await expect(request(base + "/preview", { ...body, sourceId: "another-source" }), 400);
  await expect(request(base + "/preview", { ...body, environment: "other" }), 400);
  await expect(request(base + "/preview", body, { method: "PUT" }), 405);
  await expect(request(base + "/inspect", { text: body.text }, { headers: { "Content-Encoding": "gzip" } }), 415);
  const stateBefore = JSON.stringify(app.runtime.controlState()), statsBefore = app.runtime.store.stats();
  const catalog = await expect(request(base), 200); assert.ok(catalog.sources.some(value => value.sourceId === bound.sourceId));
  const inspection = await expect(request(base + "/inspect", { text: body.text }), 200); assert.ok(inspection.fields.every(value => !Object.hasOwn(value, "value")));
  const preview = await expect(request(base + "/preview", body), 200); validateIngestBatch(preview.batch); assert.equal(preview.summary.imported, false);
  assert.equal(JSON.stringify(app.runtime.controlState()), stateBefore); assert.deepEqual(app.runtime.store.stats(), statsBefore); assert.equal(outbound, 0);
});
