"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { startPrivateApplication } = require("../server/private-application");
const { runAsOperator } = require("../server/operator-context");
const { digest } = require("../tools/benchmark-private");
const keyOf = (identity, recordId) => Buffer.from(JSON.stringify([identity.sourceId, recordId])).toString("base64url");
async function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "synthetic-triage-http-"));
  const app = await startPrivateApplication({ stateDirectory: path.join(directory, "state"), port: 0, ...options });
  t.after(async () => { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  let cookie = "", sequence = 0;
  const operatorPasswords = new Map();
  const request = (route, body, options = {}) => fetch(app.url + route, {
    method: options.method || (body === undefined ? "GET" : "POST"), headers: { Connection: "close", Origin: app.url,
      ...(cookie && !options.anonymous ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...options.headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const expect = async (promise, status = 200) => {
    const response = await promise, value = await response.json();
    assert.equal(response.status, status, JSON.stringify(value)); return { response, value };
  };
  async function signIn(name) {
    const email = name + "@example.invalid";
    if (!operatorPasswords.has(name)) {
      const password = crypto.randomBytes(30).toString("base64url");
      await app.authentication.createOperator({ name: "Synthetic " + name, email, password });
      operatorPasswords.set(name, password);
    }
    const password = operatorPasswords.get(name);
    const { response } = await expect(request("/api/auth/sign-in/email", { email, password }, { anonymous: true }));
    cookie = response.headers.getSetCookie().map(item => item.split(";")[0]).join("; "); return cookie;
  }
  const execute = (command, input) => {
    const result = runAsOperator("synthetic-http-setup", () => app.runtime.execute({ schemaVersion: "1",
      documentType: "connector-command-request", requestId: "synthetic-http-command-" + ++sequence,
      requestedAt: new Date().toISOString(), command, input }));
    assert.equal(result.status, "succeeded", JSON.stringify(result)); return result.output;
  };
  function source(name = "Synthetic HTTP application", appId) {
    const application = appId ? { appId } : execute("app.register", { displayName: name, environments: ["test"], publicPages: [] });
    const setup = execute("source.setup", { appId: application.appId, environment: "test", connectorType: "canonical-events",
      sourceKind: "log.event", displayName: name + " observations", config: { "cadence-seconds": 300 }, credentialReferences: [] });
    const identity = { appId: application.appId, sourceId: setup.sourceId };
    const sample = { schemaVersion: "1", documentType: "normalized-record", recordId: "sample", sourceId: identity.sourceId,
      estateId: identity.appId, kind: "log.event", observedAt: new Date().toISOString(),
      payload: { title: "Synthetic source test", state: "ok", message: "Synthetic HTTP fixture" } };
    const tested = execute("source.test", { sourceId: setup.sourceId, connectorInstanceId: setup.connectorInstanceId,
      expectedRevision: setup.revision, recordSample: sample });
    const active = execute("source.activate", { sourceId: setup.sourceId, connectorInstanceId: setup.connectorInstanceId, expectedRevision: tested.revision });
    return { ...identity, credential: active.oneTimeCredential.value };
  }
  function ingest(identity, recordId, payload = {}) {
    const batch = { schemaVersion: "1", documentType: "ingest-batch", sourceId: identity.sourceId,
      receiptId: "synthetic-http-receipt-" + ++sequence, sentAt: new Date().toISOString(),
      records: [{ schemaVersion: "1", documentType: "normalized-record", recordId, sourceId: identity.sourceId, estateId: identity.appId,
        kind: "finding", observedAt: new Date().toISOString(), payload: { title: "Synthetic HTTP finding", state: "open", severity: "medium", ...payload } }] };
    return app.runtime.ingest(batch, identity.credential, digest(batch));
  }
  const stateHash = () => {
    const tables = ["triage_meta", "triage_rows", "triage_members", "triage_items", "telemetry_records"];
    return digest(tables.map(table => [table, app.runtime.store.db.prepare("SELECT * FROM " + table + " ORDER BY rowid").all()]));
  };
  return { app, request, expect, signIn, source, ingest, stateHash, get cookie() { return cookie; }, set cookie(value) { cookie = value; } };
}

test("native Triage uses real browser-session authorization, exact Origin and actor-bound durable operations", async t => {
  const f = await fixture(t);
  await f.expect(f.request("/api/v1/triage?appId=missing", undefined, { anonymous: true }), 401);
  await f.expect(f.request("/api/v1/triage/approvals/preview", { appId: "missing", scope: "matching" }, { anonymous: true }), 401);
  await f.signIn("triage-reviewer");
  const firstCookie = f.cookie, s = f.source(), other = f.source("Separate synthetic application");
  f.ingest(s, "upstream-closed", { state: "closed" });
  const key = keyOf(s, "upstream-closed"), route = "/api/v1/triage?appId=" + s.appId;
  const proposal = { appId: s.appId, key, expectedRevision: 0, idempotencyKey: "http-proposal",
    state: "resolved", category: "benign", note: "Synthetic authenticated review", authorLabel: "Claimed synthetic analyst" };
  const list = await f.expect(f.request(route));
  assert.match(list.response.headers.get("cache-control"), /no-store/);
  assert.equal(list.value.filteredCount, 1); assert.equal(list.value.alerts[0].decision.state, "open");
  await f.expect(f.request(route, undefined, { headers: { Authorization: "Bearer " + s.credential } }), 401);
  await f.expect(f.request("/api/v1/triage/proposals", proposal, { headers: { Authorization: "Bearer " + s.credential } }), 401);
  await f.expect(f.request("/api/v1/triage/proposals", proposal, { headers: { Origin: "https://example.invalid" } }), 403);
  await f.expect(f.request("/api/v1/triage/proposals", proposal, { headers: { "Sec-Fetch-Site": "cross-site" } }), 403);
  const noOrigin = await fetch(f.app.url + "/api/v1/triage/proposals", { method: "POST",
    headers: { Cookie: f.cookie, "Content-Type": "application/json", Connection: "close" }, body: JSON.stringify(proposal) });
  assert.equal(noOrigin.status, 403); await noOrigin.arrayBuffer();
  await f.expect(f.request("/api/v1/triage/proposals", { ...proposal, actor: "forged-operator" }), 400);
  const authored = (await f.expect(f.request("/api/v1/triage/proposals", proposal))).value;
  assert.match(authored.alert.proposal.actor, /^operator:/);
  assert.notEqual(authored.alert.proposal.actor, proposal.authorLabel, "claimed analyst label is not the authenticated actor");
  assert.deepEqual((await f.expect(f.request("/api/v1/triage/proposals", proposal))).value, authored);
  await f.expect(f.request("/api/v1/triage/proposals", { ...proposal, note: "changed body" }), 409);
  const preview = { appId: s.appId, idempotencyKey: "http-preview", scope: "selected", keys: [key], filters: { view: "approvals" } };
  const saved = (await f.expect(f.request("/api/v1/triage/approvals/preview", preview))).value.operation;
  assert.equal(saved.approved, 0); assert.equal(saved.eligible, 1);
  const endpoint = "/api/v1/triage/approvals/" + saved.id;
  const audit = () => f.app.runtime.store.db.prepare("SELECT COUNT(*) n FROM triage_rows WHERE kind='audit'").get().n;
  const before = audit();
  const members = (await f.expect(f.request(endpoint + "/items?appId=" + s.appId))).value;
  assert.equal(members.items.length, 1); assert.equal(members.items[0].key, key); assert.equal(members.page.total, 1);
  const status = (await f.expect(f.request(endpoint + "?appId=" + s.appId))).value;
  assert.equal(status.operation.revision, 0);
  await f.expect(f.request(endpoint + "?appId=" + s.appId));
  assert.equal(audit(), before, "status GET never approves, acknowledges or advances checkpoints");
  await f.expect(f.request(endpoint + "?appId=" + other.appId), 403);
  await f.expect(f.request(endpoint + "/step", { appId: s.appId, revision: 1 }), 409);
  await f.expect(f.request(endpoint + "/step", { appId: s.appId, revision: 0, actor: "forged" }), 400);
  await f.signIn("separate-reviewer");
  await f.expect(f.request(endpoint + "?appId=" + s.appId), 403);
  await f.expect(f.request(endpoint + "/items?appId=" + s.appId), 403);
  await f.expect(f.request(endpoint + "/step", { appId: s.appId, revision: 0 }), 403);
  f.cookie = firstCookie;
  const done = (await f.expect(f.request(endpoint + "/step", { appId: s.appId, revision: 0 }))).value;
  assert.equal(done.operation.approved, 1); assert.equal(done.operation.remaining, 0);
  const after = audit();
  assert.deepEqual((await f.expect(f.request(endpoint + "/step", { appId: s.appId, revision: 0 }))).value, done);
  assert.equal(audit(), after);
  await f.expect(f.request(route + "&appId=" + s.appId), 400);
  await f.expect(f.request(route + "&limit=201"), 400);
  await f.expect(f.request(route + "&view=unsupported"), 400);
  await f.expect(f.request("/api/v1/triage/alert?appId=" + other.appId + "&key=" + key), 404);
  await f.expect(f.request("/api/v1/triage/proposals?appId=" + s.appId, proposal), 400);
  assert.equal((await f.expect(f.request(route + "&view=closed"))).value.filteredCount, 1);
});

function inspectionRoute(kind, source, key, expectedVersion, extra = {}) {
  return "/api/v1/triage/alert/" + kind + "?" + new URLSearchParams({ appId: source.appId, key, expectedVersion, ...extra });
}
async function currentAlert(f, source, key) {
  return (await f.expect(f.request("/api/v1/triage/alert?" + new URLSearchParams({ appId: source.appId, key })))).value.alert;
}

test("inspection HTTP reads bind evidence incarnations, reject every machine lane, and leave workflow state unchanged", async t => {
  const f = await fixture(t); await f.signIn("inspection-reviewer");
  const source = f.source(), sameApp = f.source("Synthetic second source", source.appId), other = f.source("Synthetic separate application");
  const recordId = "same-record-identity", key = keyOf(source, recordId), otherKey = keyOf(sameApp, recordId);
  f.ingest(source, recordId, { title: "Synthetic selected evidence", summary: "Only selected source evidence", state: "closed" });
  f.ingest(sameApp, recordId, { title: "Synthetic other source evidence", summary: "Other source must not be substituted" });
  f.ingest(other, recordId, { title: "Synthetic foreign application evidence" });
  const alert = await currentAlert(f, source, key), otherAlert = await currentAlert(f, sameApp, otherKey);
  assert.match(alert.evidenceVersion, /^[a-f0-9]{64}$/);
  assert.notEqual(alert.evidenceVersion, otherAlert.evidenceVersion);
  const listed = (await f.expect(f.request("/api/v1/triage?" + new URLSearchParams({ appId: source.appId, view: "all" })))).value;
  assert.equal(listed.alerts.find(value => value.key === key).evidenceVersion, alert.evidenceVersion);
  const service = (await f.expect(f.request("/api/v1/service-access", { name: "Synthetic inspection-denied MCP client" }), 201)).value;
  const machineHeaders = ["Bearer " + source.credential, "Bearer " + service.oneTimeCredential,
    "Enrollment " + crypto.randomBytes(24).toString("base64url")];
  const before = f.stateHash();
  let inspection;
  for (const kind of ["inspection", "evidence", "history"]) {
    const route = inspectionRoute(kind, source, key, alert.evidenceVersion);
    const success = await f.expect(f.request(route));
    assert.match(success.response.headers.get("cache-control"), /no-store/);
    assert.equal(success.value.appId, source.appId); assert.equal(success.value.key, key);
    assert.equal(success.value.evidenceVersion, alert.evidenceVersion);
    assert.match(success.value.viewerId, /^[a-f0-9]{64}$/);
    assert.ok(Buffer.byteLength(JSON.stringify(success.value)) <= 1024 * 1024);
    if (kind === "inspection") inspection = success.value;
    await f.expect(f.request(route, undefined, { anonymous: true }), 401);
    for (const authorization of machineHeaders) {
      await f.expect(f.request(route, undefined, { headers: { Authorization: authorization } }), 401);
      await f.expect(f.request(route, undefined, { anonymous: true, headers: { Authorization: authorization } }), 401);
    }
    await f.expect(f.request(route, undefined, { headers: { Origin: "https://example.invalid" } }), 403);
    await f.expect(f.request(route, undefined, { headers: { "Sec-Fetch-Site": "cross-site" } }), 403);
    await f.expect(f.request(route, undefined, { method: "DELETE" }), 405);
    await f.expect(f.request(route + "&unexpected=value"), 400);
    await f.expect(f.request(route + "&key=" + key), 400);
    await f.expect(f.request(inspectionRoute(kind, source, key, "invalid")), 400);
    await f.expect(f.request(inspectionRoute(kind, source, key, alert.evidenceVersion, { expectedVersion: "" })), 400);
    await f.expect(f.request(inspectionRoute(kind, other, key, alert.evidenceVersion)), 404);
    await f.expect(f.request(inspectionRoute(kind, source, otherKey, alert.evidenceVersion)), 409);
    assert.equal(f.stateHash(), before, kind + " reads and refused requests must not change any triage or canonical row");
  }
  assert.equal(inspection.alert.key, key); assert.equal(inspection.alert.sourceId, source.sourceId);
  assert.equal(inspection.alert.reportedState, "closed"); assert.equal(inspection.alert.decision.state, "open");
  assert.ok(inspection.evidence && inspection.history, "one aggregate GET supplies all three inspector panes");
  assert.equal(JSON.stringify(inspection).includes("Other source must not be substituted"), false);
  assert.equal(JSON.stringify(inspection).includes("Synthetic foreign application evidence"), false);
  for (const kind of ["inspection", "evidence"]) {
    await f.expect(f.request(inspectionRoute(kind, source, key, alert.evidenceVersion, { limit: "1" })), 400);
  }
  for (const limit of ["0", "101", "1.5", "01", "-1"]) {
    await f.expect(f.request(inspectionRoute("history", source, key, alert.evidenceVersion, { limit })), 400);
  }
  await f.expect(f.request(inspectionRoute("history", source, key, alert.evidenceVersion, { cursor: "invalid" })), 400);
  await f.expect(f.request(inspectionRoute("inspection", source, keyOf(source, "missing"), alert.evidenceVersion)), 404);
  assert.equal(f.stateHash(), before);

  const firstViewer = inspection.viewerId;
  const session = await f.app.authentication.getSession(new Headers({ Cookie: f.cookie }));
  assert.equal(typeof session.session.id, "string");
  assert.equal(firstViewer, digest(["triage-viewer-v1", session.user.id, session.session.id]));
  await f.signIn("inspection-reviewer");
  const newSession = (await f.expect(f.request(inspectionRoute("inspection", source, key, alert.evidenceVersion)))).value;
  assert.notEqual(newSession.viewerId, firstViewer, "another login by the same operator must be distinguishable to retained views");
  assert.equal(f.stateHash(), before);
});

test("expired or recreated evidence never substitutes a new admission or inherits old inspection notes", async t => {
  const f = await fixture(t); await f.signIn("incarnation-reviewer");
  const source = f.source(), key = keyOf(source, "recreated-evidence");
  f.ingest(source, "recreated-evidence", { summary: "Synthetic original admission" });
  f.ingest(source, "retained-anchor", { summary: "Synthetic admission anchor" });
  await f.expect(f.request("/api/v1/triage/proposals", { appId: source.appId, key, expectedRevision: 0,
    idempotencyKey: "incarnation-proposal", state: "resolved", category: "benign", note: "Synthetic old proposal must not attach", authorLabel: "Claimed prior analyst" }));
  await f.expect(f.request("/api/v1/triage/decisions", { appId: source.appId, key, expectedRevision: 0,
    idempotencyKey: "incarnation-decision", state: "closed", category: "benign", note: "Synthetic old decision must not attach" }));
  const old = await currentAlert(f, source, key);
  assert.equal(old.decision.state, "closed");
  const db = f.app.runtime.store.db;
  // Model canonical payload retention in this isolated fixture, preserving workflow history.
  db.prepare("UPDATE telemetry_records SET json=NULL,bytes=0 WHERE source_id=? AND record_id=?").run(source.sourceId, "recreated-evidence");
  const expiredState = f.stateHash();
  for (const kind of ["inspection", "evidence", "history"]) {
    await f.expect(f.request(inspectionRoute(kind, source, key, old.evidenceVersion)), 404);
  }
  assert.equal(f.stateHash(), expiredState);
  // Model later tombstone expiry followed by a newly admitted event with the same upstream ID.
  db.prepare("DELETE FROM telemetry_records WHERE source_id=? AND record_id=?").run(source.sourceId, "recreated-evidence");
  f.ingest(source, "recreated-evidence", { summary: "Synthetic new admission with a reused upstream identity" });
  const current = await currentAlert(f, source, key), beforeRead = f.stateHash();
  assert.notEqual(current.evidenceVersion, old.evidenceVersion);
  assert.equal(current.decision.state, "open"); assert.equal(current.decision.note, "");
  assert.equal(current.decision.revision, old.decision.revision, "workflow revisions remain monotone across incarnations");
  for (const kind of ["inspection", "evidence", "history"]) {
    const stale = await f.expect(f.request(inspectionRoute(kind, source, key, old.evidenceVersion)), 409);
    assert.equal(stale.value.code, "evidence-version-conflict");
    const fresh = await f.expect(f.request(inspectionRoute(kind, source, key, current.evidenceVersion)));
    assert.equal(fresh.value.evidenceVersion, current.evidenceVersion);
    assert.doesNotMatch(JSON.stringify(fresh.value), /Synthetic old (?:proposal|decision) must not attach/);
    assert.equal(f.stateHash(), beforeRead);
  }
});

test("history HTTP cursors freeze the read window and isolate exact-alert notes and approval outcomes", async t => {
  const f = await fixture(t); await f.signIn("history-reviewer");
  const source = f.source(), selected = keyOf(source, "history-selected"), peer = keyOf(source, "history-peer");
  f.ingest(source, "history-selected"); f.ingest(source, "history-peer");
  const proposal = (key, idempotencyKey, note, expectedRevision = 0) => f.request("/api/v1/triage/proposals", {
    appId: source.appId, key, expectedRevision, idempotencyKey, state: "resolved", category: "benign", note, authorLabel: "Claimed synthetic analyst" });
  await f.expect(proposal(selected, "history-selected-proposal", "Synthetic selected recommendation"));
  await f.expect(proposal(peer, "history-peer-proposal", "Synthetic peer-only confidential note"));
  const operation = (await f.expect(f.request("/api/v1/triage/approvals/preview", { appId: source.appId,
    idempotencyKey: "history-preview", scope: "selected", filters: { view: "approvals" }, keys: [selected, peer] }))).value.operation;
  await f.expect(proposal(peer, "history-peer-revision", "Synthetic revised peer-only confidential note", 1));
  const done = (await f.expect(f.request("/api/v1/triage/approvals/" + operation.id + "/step", { appId: source.appId, revision: operation.revision }))).value.operation;
  assert.equal(done.approved, 1); assert.equal(done.skipped, 1);
  const alert = await currentAlert(f, source, selected), peerAlert = await currentAlert(f, source, peer);
  const read = (key, version, extra = {}) => f.request(inspectionRoute("history", source, key, version, extra));
  const before = f.stateHash();
  const first = (await f.expect(read(selected, alert.evidenceVersion, { limit: "1" }))).value;
  assert.equal(first.scope, "exact-admission-local-workflow"); assert.equal(first.page.limit, 1);
  assert.equal(first.events.length, 1); assert.equal(first.page.hasOlder, true); assert.ok(first.page.olderCursor);
  const full = (await f.expect(read(selected, alert.evidenceVersion, { limit: "100" }))).value;
  assert.ok(full.events.some(event => event.outcome === "approved" || event.type === "proposal-approved"));
  assert.ok(full.events.some(event => event.authorLabel === "Claimed synthetic analyst" && event.actor !== event.authorLabel));
  assert.doesNotMatch(JSON.stringify(full), /peer-only confidential note/);
  const peerHistory = (await f.expect(read(peer, peerAlert.evidenceVersion, { limit: "100" }))).value;
  assert.ok(peerHistory.events.some(event => event.outcome === "changed"), "an approval skip is visible as an outcome, not a disposition");
  assert.doesNotMatch(JSON.stringify(peerHistory), /Synthetic selected recommendation/);
  assert.equal(f.stateHash(), before);

  await f.expect(f.request("/api/v1/triage/decisions", { appId: source.appId, key: selected,
    expectedRevision: alert.decision.revision, idempotencyKey: "history-later-decision", state: "open",
    category: "unclassified", note: "Synthetic arrival after frozen history" }));
  const afterMutation = f.stateHash(), seen = [...first.events]; let current = first;
  for (let pages = 0; current.page.hasOlder; pages++) {
    assert.ok(pages < 30, "bounded history fixture must terminate");
    current = (await f.expect(read(selected, alert.evidenceVersion, { limit: "1", cursor: current.page.olderCursor }))).value;
    assert.equal(current.page.highWater, first.page.highWater); assert.equal(current.page.total, first.page.total);
    assert.ok(current.events.length <= 1); seen.push(...current.events);
    assert.doesNotMatch(JSON.stringify(current.events), /Synthetic arrival after frozen history/);
  }
  assert.equal(seen.length, first.page.total); assert.equal(new Set(seen.map(event => event.id)).size, seen.length);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i].sequence < seen[i - 1].sequence);
  assert.ok(current.page.hasNewer); assert.ok(current.page.newerCursor);
  const newer = (await f.expect(read(selected, alert.evidenceVersion, { limit: "1", cursor: current.page.newerCursor }))).value;
  assert.equal(newer.page.highWater, first.page.highWater);
  const fresh = (await f.expect(read(selected, alert.evidenceVersion, { limit: "100" }))).value;
  assert.ok(fresh.page.highWater > first.page.highWater); assert.match(JSON.stringify(fresh.events), /Synthetic arrival after frozen history/);
  const wrongKey = await f.expect(read(peer, peerAlert.evidenceVersion, { limit: "1", cursor: first.page.olderCursor }), 400);
  assert.equal(wrongKey.value.code, "triage-cursor-invalid");
  await f.expect(read(selected, alert.evidenceVersion, { limit: "2", cursor: first.page.olderCursor }), 400);
  const damaged = first.page.olderCursor.slice(0, -1) + (first.page.olderCursor.endsWith("A") ? "B" : "A");
  await f.expect(read(selected, alert.evidenceVersion, { limit: "1", cursor: damaged }), 400);
  assert.equal(f.stateHash(), afterMutation, "paging and rejected cursors cannot write history or decisions");
});

test("bounded inspection evidence labels clipping and never implies associated case files or independent analysis", async t => {
  const f = await fixture(t); await f.signIn("bounded-evidence-reviewer");
  const source = f.source(), key = keyOf(source, "large-evidence"), peer = keyOf(source, "case-peer");
  const fields = Object.fromEntries(Array.from({ length: 64 }, (_, index) => ["detail" + index, "界".repeat(1000)]));
  f.ingest(source, "large-evidence", { fields, summary: "Synthetic structured evidence exceeding the display budget" });
  f.ingest(source, "case-peer", { summary: "Synthetic case peer evidence" });
  await f.expect(f.request("/api/v1/triage/groups", { appId: source.appId, keys: [key, peer], label: "Synthetic evidence case", idempotencyKey: "bounded-evidence-group" }));
  const alert = await currentAlert(f, source, key), before = f.stateHash();
  const { value: envelope, response } = await f.expect(f.request(inspectionRoute("inspection", source, key, alert.evidenceVersion)));
  const context = envelope.caseContext;
  assert.equal(context.label, "Synthetic evidence case");
  assert.equal(context.totalMembers, 2); assert.equal(context.availableMembers, 2); assert.equal(context.unavailableMembers, 0);
  assert.equal(context.limit, 30); assert.equal(context.hasMore, false);
  assert.equal(context.attachments, "unsupported"); assert.equal(context.independentNotes, "unsupported");
  assert.deepEqual(new Set(context.members.map(member => member.key)), new Set([key, peer]));
  for (const member of context.members) {
    assert.equal(member.sourceId, source.sourceId); assert.match(member.evidenceVersion, /^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(member).sort(), ["evidenceVersion", "key", "recordId", "sourceId", "title"]);
  }
  const evidence = envelope.evidence;
  assert.equal(evidence.scope, "exact-retained-admission"); assert.equal(evidence.clipped, true);
  assert.equal(evidence.complete, false); assert.equal(evidence.fullRecordAvailable, false);
  assert.equal(evidence.maxRecordBytes, 48000); assert.ok(evidence.returnedBytes <= evidence.maxRecordBytes);
  assert.ok(evidence.originalBytes > evidence.returnedBytes); assert.ok(evidence.omittedPaths.length > 0);
  assert.equal(evidence.record.recordId, "large-evidence"); assert.equal(evidence.record.sourceId, source.sourceId);
  assert.equal(evidence.provenance.sourceId, source.sourceId); assert.equal(evidence.provenance.recordId, "large-evidence");
  assert.match(evidence.provenance.bodyHash, /^[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(evidence.provenance.admissionId));
  assert.ok(Buffer.byteLength(JSON.stringify(envelope)) <= 655360);
  assert.match(response.headers.get("cache-control"), /no-store/);
  const separate = (await f.expect(f.request(inspectionRoute("evidence", source, key, alert.evidenceVersion)))).value;
  assert.ok(Buffer.byteLength(JSON.stringify(separate)) <= 65536);
  assert.deepEqual(separate.record, evidence.record); assert.deepEqual(separate.omittedPaths, evidence.omittedPaths);
  assert.equal(f.stateHash(), before);
});
