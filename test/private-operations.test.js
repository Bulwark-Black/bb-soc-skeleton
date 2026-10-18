"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { startPrivateApplication } = require("../server/private-application");
const { validateDocument } = require("../tools/validate-provider");

test("native private HTTP scopes collectors, persists monitoring and instructions, rejects cookie/token crossover and revocation", async t => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "native-private-test-"));
  const stateDirectory = path.join(directory, "state");
  let app, cookie = "", serial = 0;
  let now = Date.now();
  const launch = async port => {
    const started = await startPrivateApplication({ stateDirectory, port, operations: { now: () => now, minFreeBytes: 0 } });
    started.runtime.clock = () => new Date(now);
    return started;
  };
  t.after(async () => { await app?.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  app = await launch(0);
  const password = crypto.randomBytes(30).toString("base64url"), email = "operations@example.invalid";
  await app.authentication.createOperator({ name: "Synthetic operations operator", email, password });
  const request = (url, body, options = {}) => fetch(app.url + url, { method: body === undefined ? "GET" : "POST",
    headers: { Connection: "close", ...(options.machine ? {} : { Origin: app.url, ...(cookie ? { Cookie: cookie } : {}) }),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...options.headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const expect = async (promise, status = 200) => { const response = await promise, value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value; };
  const signIn = async () => { const response = await request("/api/auth/sign-in/email", { email, password }); assert.equal(response.status, 200); cookie = response.headers.getSetCookie().map(item => item.split(";")[0]).join("; "); await response.arrayBuffer(); };
  await expect(request("/api/v1/operations/resources?appId=missing"), 401); await signIn();
  async function command(name, input) {
    const result = await expect(request("/api/v1/control/commands", { schemaVersion: "1", documentType: "connector-command-request", requestId: "native-http-" + (++serial), command: name, requestedAt: new Date().toISOString(), input }));
    assert.equal(result.status, "succeeded", JSON.stringify(result)); return result.output;
  }
  const application = await command("app.register", { displayName: "Synthetic native application", environments: ["test"], publicPages: [] });
  const other = await command("app.register", { displayName: "Separate application", environments: ["test"], publicPages: [] });
  const setup = await command("source.setup", { appId: application.appId, environment: "test", connectorType: "native-monitor", sourceKind: "monitor.batch", displayName: "Synthetic native collector", config: { "cadence-seconds": 60 }, credentialReferences: [] });
  const revision = () => ({ sourceId: setup.sourceId, connectorInstanceId: setup.connectorInstanceId, expectedRevision: app.runtime.controlState().sources.find(source => source.sourceId === setup.sourceId).revision });
  await command("source.test", revision());
  const { oneTimeCredential } = await command("source.activate", revision());
  const config = { schemaVersion: 1, applications: [{ appId: application.appId, hosts: [{ id: "host-example", appId: application.appId, sourceId: setup.sourceId, label: "Synthetic host" }],
    employees: [{ id: "analyst-example", name: "Synthetic analyst", role: "Review", host: "host-example", sourceId: setup.sourceId }],
    websites: [{ id: "site-example", host: "host-example", label: "Synthetic website", url: "https://example.invalid/" }] }] };
  fs.writeFileSync(path.join(stateDirectory, "operations-config.json"), JSON.stringify(config), { mode: 0o600 });
  let port = Number(new URL(app.url).port); await app.close(); app = await launch(port); await signIn();
  const op = (suffix, body, extra = "") => request("/api/v1/operations/" + suffix + "?appId=" + application.appId + extra, body);
  const machine = (suffix, body, headers = {}) => request("/api/v1/monitor/" + suffix, body, { machine: true, headers: { Authorization: "Bearer " + oneTimeCredential.value, ...headers } });
  const registry = app.operations.instance(application.appId).registry;
  const defaults = { "cpu.utilization_pct": 10, "memory.available_pct": 50, "filesystem.root.used_pct": 40,
    "filesystem.root.free_bytes": 50 * 1024 ** 3, "load.1": 0.5, "swap.used_bytes": 0 };
  const batch = { schemaVersion: 1, sourceId: setup.sourceId, streamId: "stream-example", sequence: 1, batchId: "batch-example", bootId: "boot-example", collectorVersion: "test-1", configRevision: "a".repeat(64), observedAt: new Date(now).toISOString(), monotonicNs: "123456789", collection: { ok: true, durationMs: 10 },
    samples: registry.SERIES.map(series => ({ seriesId: series.id, quality: "good", value: defaults[series.suffix] })), checks: [] };
  const envelope = { sourceId: setup.sourceId, batch };
  async function collectionProjection(state, lastAttemptAt, lastSuccessAt) {
    const storedHealth = structuredClone(app.runtime.controlState().sources.find(source => source.sourceId === setup.sourceId).health);
    const fullSnapshot = app.runtime.store.snapshot;
    app.runtime.store.snapshot = () => { throw new Error("Page projections must retain indexed telemetry queries"); };
    try {
      for (const route of ["/", "/health", "/sources"]) {
        const page = await expect(request("/api/v1/pages?route=" + encodeURIComponent(route)));
        validateDocument(page);
        assert.equal(page.panels.find(panel => panel.id === "native-infrastructure-health").rows[0][1], "Synthetic host");
        if (route === "/") {
          assert.equal(page.panels.find(panel => panel.id === "summary-metrics").items.find(item => item.label === "Sources needing attention").value, state === "healthy" ? 0 : 1);
        } else {
          const table = page.panels.find(panel => panel.id === (route === "/sources" ? "expected-sources" : "is-the-collection-working"));
          assert.equal(table.rows[0][table.columns.findIndex(column => column.key === "collection")].label, state);
          assert.deepEqual(table.rows[0][table.columns.findIndex(column => column.key === "last-collection")], lastAttemptAt ? { type: "time", value: lastAttemptAt } : "Never");
        }
      }
      const snapshot = await expect(request("/api/v1/control/snapshot?reason=refresh"));
      const health = snapshot.sources.find(source => source.sourceId === setup.sourceId).health;
      assert.equal(health.state, state); assert.equal(health.lastAttemptAt, lastAttemptAt); assert.equal(health.lastSuccessAt, lastSuccessAt);
      assert.deepEqual(app.runtime.controlState().sources.find(source => source.sourceId === setup.sourceId).health, storedHealth, "native projection does not write canonical health");
    } finally { app.runtime.store.snapshot = fullSnapshot; }
  }
  await collectionProjection("pending", null, null);
  await expect(machine("batches", envelope, { Cookie: cookie }), 401);
  await expect(machine("batches", { ...envelope, host: "foreign-host" }), 403);
  await expect(machine("batches", { ...envelope, batch: { ...batch, sourceId: "wrong-source" } }), 400);
  const receipt = await expect(machine("batches", envelope)); assert.equal(receipt.accepted, true);
  assert.equal((await expect(machine("batches", envelope))).replay, true);
  await expect(machine("batches", { ...envelope, batch: { ...batch, collection: { ok: false, durationMs: 10 } } }), 409);
  const resources = await expect(op("resources")); assert.equal(resources.resources.length, 1); assert.ok(resources.resources[0].lastObservedAt);
  await collectionProjection("healthy", batch.observedAt, batch.observedAt);
  const freshAt = now;
  try {
    now = freshAt + 181000;
    await collectionProjection("stale", batch.observedAt, null);
    now = freshAt + 361000;
    await collectionProjection("offline", batch.observedAt, null);
  } finally { now = freshAt; }
  now += 1;
  const failedBatch = { ...batch, batchId: "incomplete-collection", sequence: 2, observedAt: new Date(now).toISOString(), collection: { ok: false, durationMs: 10 } };
  await expect(machine("batches", { sourceId: setup.sourceId, batch: failedBatch }));
  await collectionProjection("degraded", failedBatch.observedAt, null);
  assert.equal((await expect(request("/api/v1/operations/resources?appId=" + other.appId))).resources.length, 0);
  await expect(op("resources", undefined, "&hosts=foreign-host"), 400);
  await expect(request("/api/v1/operations/resources?appId=" + application.appId, undefined, { machine: true, headers: { Authorization: "Bearer " + oneTimeCredential.value } }), 401);
  await expect(op("maintenance", { host: "host-example", reason: "Synthetic planned test", durationMinutes: 5, actor: "forged", idempotencyKey: "forged" }), 400);
  await expect(op("maintenance", { host: "host-example", reason: "Synthetic planned test", durationMinutes: 5, idempotencyKey: "planned-test" }));
  const note = await expect(op("employee-inbox/create", { recipient: "analyst-example", title: "Review collection", body: "Review the synthetic service evidence on your next visit.", idempotencyKey: "note-one" }));
  const next = "instructions?sourceId=" + setup.sourceId + "&employeeId=analyst-example";
  const pending = await expect(machine(next)); assert.equal(pending.pendingCount, 1);
  assert.equal((await expect(machine(next))).pendingCount, 1, "GET does not acknowledge instructions");
  await expect(machine("instructions/ack", { sourceId: setup.sourceId, employeeId: "foreign-employee", messageId: note.messageId, idempotencyKey: "bad-ack" }), 403);
  const ack = { sourceId: setup.sourceId, employeeId: "analyst-example", messageId: note.messageId, idempotencyKey: "read-note", reply: "Read for review." };
  assert.match((await expect(machine("instructions/ack", ack))).meaning, /not task completion/);
  await expect(machine("instructions/ack", ack)); assert.equal((await expect(machine(next))).pendingCount, 0);
  const inbox = await expect(op("employee-inbox")); assert.equal(inbox.items.length, 1); assert.equal(inbox.completion, "not tracked by inbox");
  const web = { schemaVersion: 1, batchId: "website-one", observedAt: new Date(now).toISOString(), checks: [{ url: "https://example.invalid/", at: new Date(now).toISOString(), status: 200, ms: 20, error: null, redirect: null, certNotAfter: new Date(now + 90 * 86400000).toISOString() }] };
  await expect(machine("websites", { sourceId: setup.sourceId, batch: web }));
  assert.equal((await expect(op("websites"))).websites[0].state, "healthy");
  const execution = { schemaVersion: 1, eventId: "execution-before-pressure", employeeId: "analyst-example",
    runId: "capacity-run", kind: "start", observedAt: new Date(now).toISOString() };
  const operationReceipt = await expect(machine("operations", { sourceId: setup.sourceId, event: execution }));
  const store = app.operations.instance(application.appId).store, originalCapacity = store.capacity;
  store.capacity = () => { throw Object.assign(new Error("Synthetic monitoring storage pressure"), { status: 503 }); };
  try {
    // Committed receipts remain recoverable even when a subsequent write would
    // be refused. This is how an uncertain sender safely retires its outbox.
    assert.equal((await expect(machine("batches", envelope))).replay, true);
    assert.equal((await expect(machine("websites", { sourceId: setup.sourceId, batch: web }))).replay, true);
    assert.deepEqual(await expect(machine("operations", { sourceId: setup.sourceId, event: execution })), operationReceipt);
    assert.equal((await expect(machine(next))).pendingCount, 0, "instruction reads do not consume write capacity");
    await expect(machine("instructions/ack", ack));
    assert.equal((await expect(op("employee-inbox/create", { recipient: "analyst-example", title: "Review collection", body: "Review the synthetic service evidence on your next visit.", idempotencyKey: "note-one" }))).messageId, note.messageId);
    await expect(op("maintenance", { host: "host-example", reason: "Synthetic planned test", durationMinutes: 5, idempotencyKey: "planned-test" }));
    assert.equal((await expect(op("streams/activate", { host: "host-example", streamId: "stream-example" }))).unchanged, true);
    // New admission and mutations still fail before changing their records.
    await expect(machine("batches", { sourceId: setup.sourceId, batch: { ...batch, sequence: 3, batchId: "pressure-batch" } }), 503);
    await expect(machine("websites", { sourceId: setup.sourceId, batch: { ...web, batchId: "pressure-website" } }), 503);
    await expect(machine("operations", { sourceId: setup.sourceId, event: { ...execution, eventId: "pressure-progress", kind: "progress" } }), 503);
    await expect(op("employee-inbox/create", { recipient: "analyst-example", title: "New instruction", body: "Must remain uncommitted.", idempotencyKey: "pressure-note" }), 503);
    await expect(op("maintenance", { host: "host-example", reason: "Must remain uncommitted", durationMinutes: 5, idempotencyKey: "pressure-maintenance" }), 503);
    await expect(op("streams/activate", { host: "host-example", streamId: "pressure-stream" }), 503);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM ops_receipts WHERE id='pressure-note'").get().n, 0);
    assert.equal(store.db.prepare("SELECT stream_id FROM streams WHERE host='host-example'").get().stream_id, "stream-example");
  } finally { store.capacity = originalCapacity; }
  port = Number(new URL(app.url).port); await app.close(); app = await launch(port); await signIn();
  assert.equal((await expect(machine("batches", envelope))).replay, true);
  assert.equal((await expect(machine(next))).pendingCount, 0);
  assert.equal((await expect(op("websites"))).websites[0].statusCode, 200);
  await command("source.pause", revision());
  await collectionProjection("disabled", null, null);
  await expect(machine("batches", envelope), 409); await expect(machine(next), 409);
});
