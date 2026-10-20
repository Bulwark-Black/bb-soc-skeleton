"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { SqliteTelemetryStore } = require("../server/sqlite-telemetry-store");
const { ReferenceControlPlane } = require("../server/reference-runtime");
const { runAsOperator } = require("../server/operator-context");
const { validateNormalizedRecord } = require("../tools/ingest-contract");
const { digest } = require("../tools/benchmark-private");
const { createTriageService } = require("../server/triage-service");

const AT = "2030-01-02T03:04:05.000Z", ACTOR = "operator:synthetic-reviewer";
const keyOf = (source, recordId) => Buffer.from(JSON.stringify([source.sourceId, recordId])).toString("base64url");
function fixture(t, retention) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "synthetic-triage-test-"));
  let time = Date.parse(AT), sequence = 0, store, runtime, service;
  const clock = () => new Date(time);
  function open(fault) {
    store = new SqliteTelemetryStore({ directory, clock, ...(retention ? { retention } : {}) });
    runtime = new ReferenceControlPlane({ store, clock, enabledConnectorTypes: ["canonical-events"] });
    service = createTriageService({ store, now: () => time, fault });
  }
  open();
  t.after(() => { runtime?.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  function execute(command, input) {
    const result = runAsOperator("synthetic-triage-reviewer", () => runtime.execute({
      schemaVersion: "1", documentType: "connector-command-request",
      requestId: "synthetic-triage-command-" + ++sequence, requestedAt: clock().toISOString(), command, input
    }));
    assert.equal(result.status, "succeeded", JSON.stringify(result)); return result.output;
  }
  function record(identity, recordId, payload = {}, kind = "finding") {
    return validateNormalizedRecord({ schemaVersion: "1", documentType: "normalized-record", recordId,
      sourceId: identity.sourceId, estateId: identity.appId, kind, observedAt: clock().toISOString(),
      payload: { title: "Synthetic finding " + recordId, state: "open", severity: "medium",
        ruleRef: "synthetic-rule", category: "synthetic-category", ...payload } });
  }
  function source(name = "Synthetic application", appId) {
    appId ||= execute("app.register", { displayName: name, hosts: [], publicPages: [], environments: ["test"] }).appId;
    const setup = execute("source.setup", { appId, environment: "test", connectorType: "canonical-events",
      sourceKind: "log.event", displayName: name + " observations", config: { "cadence-seconds": 300 }, credentialReferences: [] });
    const identity = { appId, sourceId: setup.sourceId, connectorInstanceId: setup.connectorInstanceId };
    const tested = execute("source.test", { sourceId: identity.sourceId, connectorInstanceId: identity.connectorInstanceId, expectedRevision: setup.revision,
      recordSample: record(identity, "synthetic-sample", { message: "Synthetic source validation" }, "log.event") });
    const activated = execute("source.activate", { sourceId: identity.sourceId,
      connectorInstanceId: identity.connectorInstanceId, expectedRevision: tested.revision });
    return { ...identity, credential: activated.oneTimeCredential.value };
  }
  function ingest(identity, records) {
    const batch = { schemaVersion: "1", documentType: "ingest-batch", sourceId: identity.sourceId,
      receiptId: "synthetic-triage-receipt-" + ++sequence, sentAt: clock().toISOString(), records };
    return runtime.ingest(batch, identity.credential, digest(batch));
  }
  function propose(identity, recordId, extra = {}, actor = ACTOR) {
    return service.propose({ appId: identity.appId, key: keyOf(identity, recordId), expectedRevision: 0,
      idempotencyKey: "synthetic-proposal-" + ++sequence, state: "resolved", category: "benign",
      note: "Synthetic recommendation; an authenticated reviewer decides.", authorLabel: "Synthetic analyst", ...extra }, actor);
  }
  return { get store() { return store; }, get runtime() { return runtime; }, get service() { return service; },
    directory, execute, source, record, ingest, propose, now: () => time, advance: ms => { time += ms; },
    reopen(fault) { runtime.dispose(); open(fault); }, serviceWithFault: fault => createTriageService({ store, now: () => time, fault }) };
}

const operation = result => result.operation;
const fails = (status, code) => error => error.status === status && (!code || error.code === code);
function snapshotWorkflow(store) {
  return Object.fromEntries(["triage_rows", "triage_items", "triage_members", "triage_meta"].map(name =>
    [name, store.db.prepare("SELECT * FROM " + name + " ORDER BY rowid").all()]));
}
function preview(f, source, input = {}) {
  return operation(f.service.preview({ appId: source.appId, scope: "matching", filters: { view: "approvals" },
    idempotencyKey: "synthetic-preview", ...input }, ACTOR));
}
function finish(f, source, saved) {
  let op = saved, batches = 0;
  while (op.canResume) {
    const before = op.approved + op.skipped;
    op = operation(f.service.step(op.id, { appId: source.appId, revision: op.revision }, ACTOR));
    assert.ok(op.approved + op.skipped - before <= 100, "one internal step is bounded to 100 candidates");
    assert.equal(op.approved + op.skipped + op.remaining, op.eligible);
    assert.ok(++batches <= Math.ceil(saved.eligible / 100), "every step must make progress");
  }
  return { op, batches };
}

test("canonical reported state never authors local workflow; reads leave canonical and workflow state unchanged", t => {
  const f = fixture(t), s = f.source();
  f.ingest(s, [f.record(s, "reported-closed", { state: "closed", category: "real-threat" }),
    f.record(s, "reported-open"), f.record(s, "case-import", { findingRef: "reported-open" }, "case.record")]);
  const before = snapshotWorkflow(f.store), raw = f.store.db.prepare("SELECT json FROM telemetry_records ORDER BY id").all();
  const page = f.service.list({ appId: s.appId, view: "all", limit: 1 });
  assert.deepEqual(page.counts, { all: 2, queue: 2, approvals: 0, cases: 0, closed: 0 });
  assert.equal(page.filteredCount, 2); assert.equal(page.alerts.length, 1); assert.equal(page.page.hasMore, true);
  const detail = f.service.detail(s.appId, keyOf(s, "reported-closed")).alert;
  assert.equal(detail.reportedState, "closed"); assert.equal(detail.decision.state, "open");
  assert.equal(detail.decision.category, "unclassified"); assert.equal(detail.proposal, null);
  assert.deepEqual(snapshotWorkflow(f.store), before, "GET-style reads create no local decisions, proposals or receipts");
  f.propose(s, "reported-closed");
  assert.equal(f.service.detail(s.appId, keyOf(s, "reported-closed")).alert.decision.state, "open");
  assert.deepEqual(f.store.db.prepare("SELECT json FROM telemetry_records ORDER BY id").all(), raw);
});

test("source-scoped identities, explicit groups and filtered counts stay exact across partial pages", t => {
  const f = fixture(t), a = f.source("Synthetic first"), sameApp = f.source("Synthetic second source", a.appId), other = f.source("Synthetic other");
  f.ingest(a, [f.record(a, "same-id"), f.record(a, "second", { ruleRef: "other-rule" }), f.record(a, "third")]);
  f.ingest(a, [f.record(a, "same-id")]);
  f.ingest(sameApp, [f.record(sameApp, "same-id")]); f.ingest(other, [f.record(other, "same-id")]);
  const keys = ["same-id", "second", "third"].map(id => keyOf(a, id));
  const g = f.service.group({ appId: a.appId, label: "Synthetic grouped evidence", keys, idempotencyKey: "group-once" }, ACTOR).group;
  const p = f.service.list({ appId: a.appId, view: "all", limit: 1 });
  assert.equal(p.filteredCount, 4); assert.equal(p.groupCount, 2);
  const scoped = f.service.list({ appId: a.appId, sourceId: a.sourceId, rule: "synthetic-rule", view: "all", limit: 1 });
  assert.equal(scoped.filteredCount, 2); assert.equal(scoped.counts.all, 2); assert.equal(scoped.alerts.length, 1);
  assert.deepEqual(scoped.groups.map(x => [x.id, x.matchedCount, x.shownCount, x.totalMembers]), [[g.id, 2, 1, 3]]);
  assert.equal(f.service.list({ appId: other.appId, view: "all" }).filteredCount, 1);
  assert.equal(f.service.list({ appId: a.appId, sourceId: other.sourceId, view: "all" }).filteredCount, 0);
  assert.throws(() => f.service.detail(a.appId, keyOf(other, "same-id")), fails(404));
  assert.throws(() => f.service.group({ appId: a.appId, keys: [keys[0], keys[0]], label: "Duplicate", idempotencyKey: "bad-group" }, ACTOR), fails(400));
  f.propose(a, "same-id"); f.propose(sameApp, "same-id");
  const selected = preview(f, a, { scope: "selected", keys: [keys[0], keys[0], keyOf(sameApp, "same-id")], filters: { view: "approvals" } });
  assert.equal(selected.total, 2); assert.equal(selected.eligible, 2, "overlapping header/member keys cannot double count");
  assert.throws(() => preview(f, a, { idempotencyKey: "cross-scope", scope: "selected", keys: [keyOf(other, "same-id")] }), fails(403));
  assert.throws(() => preview(f, a, { idempotencyKey: "cross-filter", scope: "selected", keys: [keys[0]], filters: { view: "approvals", rule: "other-rule" } }), fails(403));
});

test("selected approval exceeds 100, remains actor/app bound and retries stale revisions without another batch", t => {
  const f = fixture(t), s = f.source(), other = f.source("Other synthetic scope");
  f.ingest(s, Array.from({ length: 125 }, (_, i) => f.record(s, "selected-" + i)));
  f.store.db.transaction(() => { for (let i = 0; i < 125; i++) f.propose(s, "selected-" + i); })();
  const input = { appId: s.appId, idempotencyKey: "selected-preview", scope: "selected",
    filters: { view: "approvals" }, keys: Array.from({ length: 125 }, (_, i) => keyOf(s, "selected-" + i)) };
  const original = f.service.preview(input, ACTOR), op = operation(original);
  assert.equal(op.total, 125); assert.equal(op.eligible, 125); assert.equal(op.approved, 0);
  const readState = snapshotWorkflow(f.store);
  assert.deepEqual(f.service.status(op.id, s.appId, ACTOR), original);
  assert.deepEqual(f.service.preview(input, ACTOR), original);
  assert.deepEqual(snapshotWorkflow(f.store), readState);
  assert.throws(() => f.service.preview({ ...input, keys: input.keys.slice(1) }, ACTOR), fails(409, "idempotency-conflict"));
  assert.throws(() => f.service.status(op.id, s.appId, "operator:other"), fails(403));
  assert.throws(() => f.service.step(op.id, { appId: other.appId, revision: 0 }, ACTOR), fails(403));
  const first = operation(f.service.step(op.id, { appId: s.appId, revision: 0 }, ACTOR));
  assert.equal(first.approved, 100); assert.equal(first.remaining, 25); assert.equal(first.status, "running");
  const afterFirst = snapshotWorkflow(f.store);
  assert.deepEqual(operation(f.service.step(op.id, { appId: s.appId, revision: 0 }, ACTOR)), first);
  assert.deepEqual(snapshotWorkflow(f.store), afterFirst);
  f.reopen();
  assert.deepEqual(operation(f.service.status(op.id, s.appId, ACTOR)), first, "pause/restart preserves the exact next checkpoint");
  const done = finish(f, s, first).op;
  assert.equal(done.approved, 125); assert.equal(done.remaining, 0); assert.equal(done.status, "completed");
  assert.throws(() => f.service.step(op.id, { appId: s.appId, revision: done.revision + 1 }, ACTOR), fails(409));
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM triage_rows WHERE kind='decision'").get().n, 125);
});

test("all matching approvals include more than 4000 retained findings before display limits", t => {
  const f = fixture(t), s = f.source(), total = 4101;
  for (let start = 0; start < total; start += 1000) f.ingest(s, Array.from({ length: Math.min(1000, total - start) }, (_, i) => f.record(s, "bulk-" + String(start + i).padStart(5, "0"))));
  f.ingest(s, [f.record(s, "filtered-out", { ruleRef: "different-rule" })]);
  f.store.db.transaction(() => { for (let i = 0; i < total; i++) f.propose(s, "bulk-" + String(i).padStart(5, "0")); f.propose(s, "filtered-out"); })();
  f.store.snapshot = () => { throw new Error("Unbounded diagnostic snapshot is not a Triage query."); };
  const page = f.service.list({ appId: s.appId, view: "approvals", rule: "synthetic-rule", limit: 20, offset: 4000 });
  assert.equal(page.filteredCount, total); assert.equal(page.counts.approvals, total); assert.equal(page.alerts.length, 20);
  const saved = preview(f, s, { filters: { view: "approvals", rule: "synthetic-rule" } });
  assert.equal(saved.total, total); assert.equal(saved.eligible, total);
  f.ingest(s, [f.record(s, "arrived-later")]); f.propose(s, "arrived-later");
  const { op, batches } = finish(f, s, saved);
  assert.equal(batches, 42); assert.equal(op.approved, total); assert.equal(op.skipped, 0);
  assert.equal(f.service.detail(s.appId, keyOf(s, "filtered-out")).alert.proposal.status, "pending");
  assert.equal(f.service.detail(s.appId, keyOf(s, "arrived-later")).alert.proposal.status, "pending", "later arrivals do not expand a reviewed snapshot");
});

test("changed proposals, human decisions, withdrawal and changed grouping are skipped without overwriting newer intent", t => {
  const f = fixture(t), s = f.source(), ids = ["replace", "human", "withdraw", "grouped", "group-peer", "unchanged", "critical"];
  f.ingest(s, ids.map(id => f.record(s, id, id === "critical" ? { severity: "critical" } : {})));
  ids.forEach(id => f.propose(s, id));
  const saved = preview(f, s);
  assert.equal(saved.eligible, 6); assert.equal(saved.excluded.critical, 1);
  f.propose(s, "replace", { expectedRevision: 1, state: "investigating", note: "Newer recommendation" });
  f.service.decide({ appId: s.appId, key: keyOf(s, "human"), expectedRevision: 0, idempotencyKey: "human-choice",
    state: "investigating", category: "real-threat", owner: "Synthetic human", note: "Independent human decision" }, ACTOR);
  f.service.withdraw({ appId: s.appId, key: keyOf(s, "withdraw"), expectedRevision: 1, idempotencyKey: "withdraw-choice", reason: "Evidence changed" }, ACTOR);
  f.service.group({ appId: s.appId, keys: [keyOf(s, "grouped"), keyOf(s, "group-peer")], label: "New grouping", idempotencyKey: "group-change" }, ACTOR);
  const done = finish(f, s, saved).op;
  assert.equal(done.approved, 1); assert.equal(done.skipped, 5); assert.equal(done.byOutcome.changed, 5);
  assert.equal(f.service.detail(s.appId, keyOf(s, "replace")).alert.proposal.revision, 2);
  assert.equal(f.service.detail(s.appId, keyOf(s, "human")).alert.decision.owner, "Synthetic human");
  assert.throws(() => f.service.decide({ appId: s.appId, key: keyOf(s, "critical"), expectedRevision: 0,
    idempotencyKey: "critical-no-reason", state: "closed", category: "benign", note: "" }, ACTOR), fails(400));
  const critical = f.service.decide({ appId: s.appId, key: keyOf(s, "critical"), expectedRevision: 0,
    idempotencyKey: "critical-with-reason", state: "investigating", category: "real-threat", note: "Human examined critical evidence" }, ACTOR);
  assert.equal(critical.alert.decision.state, "investigating");
});

test("critical and unavailable retained group evidence exclude exact selections conservatively", t => {
  const f = fixture(t), s = f.source();
  f.ingest(s, [f.record(s, "ordinary"), f.record(s, "critical-peer", { severity: "critical" })]);
  f.propose(s, "ordinary");
  f.service.group({ appId: s.appId, keys: ["ordinary", "critical-peer"].map(id => keyOf(s, id)), label: "Critical group", idempotencyKey: "critical-group" }, ACTOR);
  const op = preview(f, s, { scope: "selected", keys: [keyOf(s, "ordinary")] });
  assert.equal(op.eligible, 0); assert.equal(op.excluded.critical, 1); assert.equal(op.canResume, false);
  f.store.db.prepare("UPDATE telemetry_records SET json=NULL,bytes=0 WHERE source_id=? AND record_id=?").run(s.sourceId, "critical-peer");
  const unavailable = preview(f, s, { scope: "selected", keys: [keyOf(s, "ordinary")], idempotencyKey: "missing-group" });
  assert.equal(unavailable.eligible, 0); assert.equal(unavailable.excluded.unavailable, 1);
});

test("expired and recreated telemetry never inherits a reviewed operation or old local closed state", t => {
  const f = fixture(t, { recordDays: 1, replayDays: 1 }), s = f.source();
  const old = f.record(s, "recreated");
  f.ingest(s, [old, f.record(s, "expires")]); f.propose(s, "recreated"); f.propose(s, "expires");
  const saved = preview(f, s);
  f.service.decide({ appId: s.appId, key: keyOf(s, "recreated"), expectedRevision: 0, idempotencyKey: "old-decision",
    state: "closed", category: "benign", note: "Old incarnation decision" }, ACTOR);
  f.advance(2 * 86400000);
  f.ingest(s, [f.record(s, "fresh")]);
  assert.throws(() => f.service.detail(s.appId, keyOf(s, "expires")), fails(404));
  f.ingest(s, [old]);
  const current = f.service.detail(s.appId, keyOf(s, "recreated")).alert;
  assert.equal(current.decision.state, "open"); assert.notEqual(current.proposal?.status, "pending");
  const done = finish(f, s, saved).op;
  assert.equal(done.approved, 0); assert.equal(done.skipped, 2); assert.equal(done.byOutcome.missing, 2);
});

test("step state, decisions, proposal histories, receipts and audit roll back together; lost response replays safely after restart", t => {
  const f = fixture(t), s = f.source();
  f.ingest(s, [f.record(s, "atomic-one"), f.record(s, "atomic-two")]);
  f.propose(s, "atomic-one"); f.propose(s, "atomic-two");
  const saved = preview(f, s), before = snapshotWorkflow(f.store);
  const beforeFault = f.serviceWithFault(phase => { if (phase === "before-step-commit") throw new Error("Synthetic pre-commit failure"); });
  assert.throws(() => beforeFault.step(saved.id, { appId: s.appId, revision: 0 }, ACTOR), /Synthetic pre-commit failure/);
  assert.deepEqual(snapshotWorkflow(f.store), before);
  f.reopen();
  assert.equal(operation(f.service.status(saved.id, s.appId, ACTOR)).approved, 0);
  const afterFault = f.serviceWithFault(phase => { if (phase === "after-step-commit") throw new Error("Synthetic lost response"); });
  assert.throws(() => afterFault.step(saved.id, { appId: s.appId, revision: 0 }, ACTOR), /Synthetic lost response/);
  const committed = snapshotWorkflow(f.store);
  f.reopen();
  const replay = operation(f.service.step(saved.id, { appId: s.appId, revision: 0 }, ACTOR));
  assert.equal(replay.approved, 2); assert.equal(replay.status, "completed");
  assert.deepEqual(snapshotWorkflow(f.store), committed);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM triage_rows WHERE kind='decision-history'").get().n, 2);
});

test("state quota failure cannot partially author a proposal, audit record or idempotency receipt", t => {
  const f = fixture(t), s = f.source(); f.ingest(s, [f.record(s, "capacity")]);
  const actual = f.service.capacity().bytes;
  f.store.db.prepare("UPDATE triage_meta SET value=? WHERE key='bytes'").run(String(f.service.capacity().maxBytes));
  const before = snapshotWorkflow(f.store);
  assert.throws(() => f.propose(s, "capacity"), fails(507, "triage-capacity"));
  assert.deepEqual(snapshotWorkflow(f.store), before);
  f.store.db.prepare("UPDATE triage_meta SET value=? WHERE key='bytes'").run(String(actual));
  assert.equal(f.propose(s, "capacity").alert.proposal.status, "pending");
});

test("frozen operation membership is paged exactly, read-only, actor-bound and does not change after proposal edits", t => {
  const f = fixture(t), s = f.source();
  f.ingest(s, Array.from({ length: 205 }, (_, i) => f.record(s, "item-" + String(i).padStart(3, "0"))));
  f.store.db.transaction(() => { for (let i = 0; i < 205; i++) f.propose(s, "item-" + String(i).padStart(3, "0")); })();
  const op = preview(f, s), before = snapshotWorkflow(f.store), keys = [];
  for (let offset = 0; offset < 205; offset += 100) {
    const result = f.service.items(op.id, { appId: s.appId, limit: 100, offset }, ACTOR);
    assert.equal(result.operationId, op.id); assert.equal(result.page.total, 205);
    assert.equal(result.items.length, Math.min(100, 205 - offset));
    assert.equal(result.page.hasMore, offset < 200);
    result.items.forEach((item, index) => {
      assert.equal(item.position, offset + index); assert.equal(item.proposalRevision, 1); assert.equal(item.decisionRevision, 0);
      assert.equal(item.state, "resolved"); assert.equal(item.outcome, "pending"); keys.push(item.key);
    });
  }
  assert.equal(new Set(keys).size, 205); assert.deepEqual(snapshotWorkflow(f.store), before);
  assert.throws(() => f.service.items(op.id, { appId: s.appId }, "operator:another"), fails(403));
  assert.throws(() => f.service.items(op.id, { appId: s.appId, limit: 201 }, ACTOR), fails(400));
  f.propose(s, "item-000", { expectedRevision: 1, note: "New proposal after snapshot", state: "investigating" });
  const frozen = f.service.items(op.id, { appId: s.appId, limit: 1 }, ACTOR).items[0];
  assert.equal(frozen.state, "resolved"); assert.notEqual(frozen.note, "New proposal after snapshot");
});

test("new incarnations can form a new explicit group without deleting prior group evidence", t => {
  const f = fixture(t, { recordDays: 1, replayDays: 1 }), s = f.source();
  const old = [f.record(s, "old-one"), f.record(s, "old-two")];
  f.ingest(s, old);
  const first = f.service.group({ appId: s.appId, keys: old.map(r => keyOf(s, r.recordId)),
    label: "Original synthetic case", idempotencyKey: "original-case" }, ACTOR).group;
  f.propose(s, "old-one");
  f.advance(2 * 86400000);
  f.ingest(s, [f.record(s, "new-peer")]); f.ingest(s, [old[0]]);
  const current = f.service.detail(s.appId, keyOf(s, "old-one")).alert;
  assert.equal(current.group, null); assert.equal(current.proposal.status, "expired");
  assert.equal(current.decision.state, "open");
  const second = f.service.group({ appId: s.appId, keys: [keyOf(s, "old-one"), keyOf(s, "new-peer")],
    label: "New synthetic case", idempotencyKey: "new-case" }, ACTOR).group;
  assert.notEqual(second.id, first.id);
  assert.equal(f.service.detail(s.appId, keyOf(s, "old-one")).alert.group.id, second.id);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM triage_members WHERE group_id=?").get(first.id).n, 2);
  assert.equal(f.propose(s, "old-one", { expectedRevision: 1 }).alert.proposal.revision, 2);
});

test("record body version changes and step quota exhaustion fail closed without partial approval", t => {
  const f = fixture(t), s = f.source(); f.ingest(s, [f.record(s, "body-version"), f.record(s, "quota-step")]);
  f.propose(s, "body-version"); f.propose(s, "quota-step");
  const op = preview(f, s);
  const bytes = f.service.capacity().bytes;
  f.store.db.prepare("UPDATE triage_meta SET value=? WHERE key='bytes'").run(String(f.service.capacity().maxBytes));
  const before = snapshotWorkflow(f.store);
  assert.throws(() => f.service.step(op.id, { appId: s.appId, revision: 0 }, ACTOR), fails(507, "triage-capacity"));
  assert.deepEqual(snapshotWorkflow(f.store), before);
  f.store.db.prepare("UPDATE triage_meta SET value=? WHERE key='bytes'").run(String(bytes));
  // Deliberately corrupt a version in this isolated fixture to prove fail-closed revalidation.
  f.store.db.prepare("UPDATE telemetry_records SET body_hash=? WHERE source_id=? AND record_id=?").run("b".repeat(64), s.sourceId, "body-version");
  const done = finish(f, s, op).op;
  assert.equal(done.approved, 1); assert.equal(done.skipped, 1); assert.equal(done.byOutcome.missing, 1);
  assert.equal(f.service.detail(s.appId, keyOf(s, "body-version")).alert.decision.state, "open");
});

function readQuery(f, source, id) {
  const key=keyOf(source,id);
  return {appId:source.appId,key,expectedVersion:f.service.detail(source.appId,key).alert.evidenceVersion};
}
test("inspection returns one exact canonical admission, local notes and bounded scoped case members without any read writes", t=>{
  const f=fixture(t),s=f.source(),other=f.source("Other inspected application");
  f.ingest(s,Array.from({length:33},(_,i)=>f.record(s,"inspect-"+i,{summary:"Exact synthetic evidence",fields:{literal:"<script>synthetic</script>"}})));
  f.ingest(other,[f.record(other,"inspect-0",{summary:"Other application material"})]);
  const keys=Array.from({length:33},(_,i)=>keyOf(s,"inspect-"+i));
  f.service.group({appId:s.appId,keys,label:"Synthetic retained case",idempotencyKey:"inspection-case"},ACTOR);
  f.propose(s,"inspect-0",{note:"Only selected alert note",authorLabel:"Claimed analyst name"});
  f.propose(s,"inspect-1",{note:"Different member confidential note"});
  f.store.db.prepare("UPDATE telemetry_records SET json=NULL,bytes=0 WHERE source_id=? AND record_id=?").run(s.sourceId,"inspect-32");
  const q=readQuery(f,s,"inspect-0"),before=snapshotWorkflow(f.store);
  const canonical=f.store.db.prepare("SELECT * FROM telemetry_records ORDER BY id").all();
  const result=f.service.inspection(q);
  assert.equal(result.evidenceVersion,q.expectedVersion);assert.equal(result.alert.evidenceVersion,q.expectedVersion);
  assert.equal(result.evidence.record.sourceId,s.sourceId);assert.equal(result.evidence.record.payload.fields.literal,"<script>synthetic</script>");
  assert.equal(result.evidence.record.receivedAt,undefined,"admission metadata is separate from the canonical evidence");
  assert.equal(result.evidence.complete,true);assert.equal(result.evidence.clipped,false);
  assert.deepEqual(result.caseContext && [result.caseContext.totalMembers,result.caseContext.availableMembers,result.caseContext.unavailableMembers,result.caseContext.members.length,result.caseContext.hasMore],[33,32,1,30,true]);
  assert.equal(result.caseContext.attachments,"unsupported");assert.equal(result.caseContext.independentNotes,"unsupported");
  assert.equal(result.history.events[0].actor,ACTOR);assert.equal(result.history.events[0].authorLabel,"Claimed analyst name");
  assert.equal(JSON.stringify(result).includes("Different member confidential note"),false);
  assert.equal(JSON.stringify(result).includes("Other application material"),false);
  for(const method of ["evidence","history","inspection"])assert.throws(()=>f.service[method]({...q,appId:other.appId}),fails(404));
  assert.deepEqual(snapshotWorkflow(f.store),before);assert.deepEqual(f.store.db.prepare("SELECT * FROM telemetry_records ORDER BY id").all(),canonical);
  assert.ok(Buffer.byteLength(JSON.stringify(result))<=640*1024);
});
test("evidence versions and history cursors refuse stale or recreated identities without old-incarnation notes",t=>{
  const f=fixture(t,{recordDays:1,replayDays:1}),s=f.source(),old=f.record(s,"same-record");
  f.ingest(s,[old]);f.propose(s,"same-record",{note:"Previous incarnation proposal"});
  f.propose(s,"same-record",{expectedRevision:1,note:"Previous incarnation second proposal"});
  const q=readQuery(f,s,"same-record"),cursor=f.service.history({...q,limit:1}).page.olderCursor;
  f.service.decide({appId:s.appId,key:q.key,expectedRevision:0,idempotencyKey:"old-incarnation-decision",state:"closed",category:"benign",note:"Previous incarnation decision"},ACTOR);
  f.advance(2*86400000);f.ingest(s,[f.record(s,"fresh-current")]);
  assert.throws(()=>f.service.inspection(q),fails(404,"triage-evidence-unavailable"));
  f.ingest(s,[old]);const current=readQuery(f,s,"same-record");
  assert.notEqual(current.expectedVersion,q.expectedVersion);
  for(const method of ["inspection","evidence","history"])assert.throws(()=>f.service[method](q),fails(409,"evidence-version-conflict"));
  const newRead=f.service.inspection(current);
  assert.equal(newRead.alert.decision.state,"open");assert.deepEqual(newRead.alert.proposal,{revision:2,status:"expired"});
  assert.equal(JSON.stringify(newRead).includes("Previous incarnation"),false);assert.equal(newRead.history.events.length,0);
  assert.throws(()=>f.service.history({...current,limit:1,cursor}),fails(400,"triage-cursor-invalid"));
});
test("history high-water keyset pages are deterministic, bidirectional, signed and restart-stable",t=>{
  const f=fixture(t),s=f.source();f.ingest(s,[f.record(s,"history"),f.record(s,"peer")]);
  f.store.db.transaction(()=>{for(let i=0;i<107;i++)f.propose(s,"history",{expectedRevision:i,note:"Recorded proposal "+i});})();
  f.propose(s,"peer");
  const q=readQuery(f,s,"history"),first=f.service.history({...q,limit:30});
  assert.equal(first.events.length,30);assert.equal(first.page.total,107);assert.equal(first.page.hasNewer,false);assert.equal(first.page.hasOlder,true);
  assert.ok(first.events.every((event,i,events)=>!i||event.sequence<events[i-1].sequence));
  f.propose(s,"history",{expectedRevision:107,note:"Arrived after high-water"});
  const second=f.service.history({...q,cursor:first.page.olderCursor});
  assert.equal(second.page.total,107);assert.equal(second.page.highWater,first.page.highWater);assert.equal(second.events.length,30);
  assert.deepEqual(f.service.history({...q,cursor:second.page.newerCursor}).events,first.events);
  f.reopen();
  assert.deepEqual(f.service.history({...q,cursor:first.page.olderCursor}),second);
  const seen=[...first.events,...second.events];let page=second;
  while(page.page.olderCursor){page=f.service.history({...q,cursor:page.page.olderCursor});seen.push(...page.events);}
  assert.equal(seen.length,107);assert.equal(new Set(seen.map(x=>x.id)).size,107);
  assert.equal(JSON.stringify(seen).includes("Arrived after high-water"),false);
  assert.equal(f.service.history(q).page.total,108);
  const peer=readQuery(f,s,"peer");
  assert.throws(()=>f.service.history({...peer,cursor:first.page.olderCursor}),fails(400,"triage-cursor-invalid"));
  assert.throws(()=>f.service.history({...q,limit:31,cursor:first.page.olderCursor}),fails(400,"triage-cursor-invalid"));
  const [body,mac]=first.page.olderCursor.split("."),tampered=JSON.parse(Buffer.from(body,"base64url"));
  tampered.highWater+=100;
  assert.throws(()=>f.service.history({...q,cursor:Buffer.from(JSON.stringify(tampered)).toString("base64url")+"."+mac}),fails(400,"triage-cursor-invalid"));
  for(const limit of [0,101,-1,1.2,"30"])assert.throws(()=>f.service.history({...q,limit}),fails(400));
  for(const expectedVersion of [undefined,"","x".repeat(64),q.expectedVersion.slice(1)])assert.throws(()=>f.service.evidence({...q,expectedVersion}),fails(400));
  assert.throws(()=>f.service.inspection({...q,cursor:first.page.olderCursor}),fails(400));
});
test("large multibyte evidence reports omitted values and bounded JSON; corrupt stored bodies fail unavailable",t=>{
  const f=fixture(t),s=f.source();
  const fields=Object.fromEntries(Array.from({length:64},(_,i)=>["field"+i,"界".repeat(1000)]));
  f.ingest(s,[f.record(s,"large-evidence",{fields,message:"Message retained independently",summary:"Summary retained independently"})]);
  const q=readQuery(f,s,"large-evidence"),before=snapshotWorkflow(f.store),result=f.service.evidence(q);
  assert.equal(result.complete,false);assert.equal(result.clipped,true);assert.equal(result.fullRecordAvailable,false);
  assert.ok(result.omittedPaths.length>0);assert.ok(result.originalBytes>result.returnedBytes);
  assert.ok(result.returnedBytes<=48000);assert.ok(Buffer.byteLength(JSON.stringify(result))<=65536);
  assert.equal(result.record.payload.summary,"Summary retained independently");
  assert.deepEqual(snapshotWorkflow(f.store),before);
  const stored=f.store.db.prepare("SELECT json FROM telemetry_records WHERE source_id=? AND record_id=?").get(s.sourceId,"large-evidence");
  const corrupt=JSON.parse(stored.json);corrupt.payload.summary="Uncommitted corrupted body";
  f.store.db.prepare("UPDATE telemetry_records SET json=? WHERE source_id=? AND record_id=?").run(JSON.stringify(corrupt),s.sourceId,"large-evidence");
  for(const method of ["evidence","history","inspection"])assert.throws(()=>f.service[method](q),fails(503,"triage-evidence-unavailable"));
});
test("history scopes approval skips to the frozen admission and never claims a skipped disposition was committed",t=>{
  const f=fixture(t),s=f.source();f.ingest(s,[f.record(s,"skipped"),f.record(s,"approved")]);
  f.propose(s,"skipped",{note:"First exact skipped recommendation"});f.propose(s,"approved",{note:"Other member recommendation"});
  const op=preview(f,s);
  f.propose(s,"skipped",{expectedRevision:1,note:"New exact recommendation"});
  finish(f,s,op);
  const q=readQuery(f,s,"skipped"),history=f.service.history(q);
  const skip=history.events.find(x=>x.type==="approval-skipped");
  assert.equal(skip.outcome,"changed");assert.equal(skip.operationId,op.id);assert.equal(skip.actor,ACTOR);
  assert.equal(skip.state,null);assert.equal(history.events.some(x=>x.type==="decision-recorded"),false);
  assert.equal(JSON.stringify(history).includes("Other member recommendation"),false);
  assert.equal(f.service.detail(s.appId,q.key).alert.decision.state,"open");
  const approved=f.service.history(readQuery(f,s,"approved"));
  assert.equal(approved.events.some(x=>x.type==="decision-recorded"&&x.state==="resolved"),true);
  assert.equal(approved.events.some(x=>x.type==="approval-skipped"),false);
});
test("legacy exact proposal and decision history stays readable with explicit unavailable per-item outcome provenance",t=>{
  const f=fixture(t),s=f.source();f.ingest(s,[f.record(s,"legacy")]);f.propose(s,"legacy",{note:"Existing proposal history"});
  const op=preview(f,s);finish(f,s,op);
  // Simulate upgrade from the baseline, which did not have history read metadata.
  f.store.db.prepare("DELETE FROM triage_meta WHERE key IN ('history-start-row','history-cursor-key')").run();
  f.reopen();
  const result=f.service.history(readQuery(f,s,"legacy"));
  assert.equal(result.complete,false);assert.deepEqual(result.notices,["legacy-approval-outcomes-unavailable"]);
  assert.equal(result.events.some(x=>x.type==="decision-recorded"),true);
  assert.equal(result.events.some(x=>x.type==="proposal-recorded"&&x.note==="Existing proposal history"),true);
  const before=snapshotWorkflow(f.store);f.service.inspection(readQuery(f,s,"legacy"));assert.deepEqual(snapshotWorkflow(f.store),before);
});
test("corrupt or over-budget history is unavailable, never an invented empty history",t=>{
  const f=fixture(t),s=f.source();f.ingest(s,[f.record(s,"broken-history")]);f.propose(s,"broken-history");
  const q=readQuery(f,s,"broken-history"),saved=f.store.db.prepare("SELECT id,json FROM triage_rows WHERE kind='proposal-history'").get();
  const h=JSON.parse(saved.json);h.note="x".repeat(9000);
  f.store.db.prepare("UPDATE triage_rows SET json=? WHERE kind='proposal-history' AND id=?").run(JSON.stringify(h),saved.id);
  assert.throws(()=>f.service.history(q),fails(503,"triage-history-unavailable"));
  f.store.db.prepare("UPDATE triage_rows SET json=? WHERE kind='proposal-history' AND id=?").run("{",saved.id);
  assert.throws(()=>f.service.inspection(q),fails(503,"triage-history-unavailable"));
  assert.throws(()=>f.service.history(q),fails(503,"triage-history-unavailable"));
});

test("history byte-limited pages retain every valid large-note event and correct bidirectional cursors",t=>{
  const f=fixture(t),s=f.source();f.ingest(s,[f.record(s,"large-history")]);
  f.store.db.transaction(()=>{
    for(let i=0;i<60;i++){
      f.propose(s,"large-history",{expectedRevision:i,note:"n"+"\n".repeat(1999)});
      f.service.withdraw({appId:s.appId,key:keyOf(s,"large-history"),expectedRevision:i+1,idempotencyKey:"large-withdraw-"+i,reason:"r"+"\n".repeat(1999)},ACTOR);
    }
  })();
  const q=readQuery(f,s,"large-history"),first=f.service.history({...q,limit:100});
  assert.equal(first.page.total,120);assert.ok(first.events.length>0&&first.events.length<100);
  assert.ok(Buffer.byteLength(JSON.stringify(first))<=512*1024);
  const seen=[...first.events];let page=first;
  while(page.page.olderCursor){
    page=f.service.history({...q,cursor:page.page.olderCursor});
    assert.ok(Buffer.byteLength(JSON.stringify(page))<=512*1024);seen.push(...page.events);
  }
  assert.equal(seen.length,120);assert.equal(new Set(seen.map(x=>x.id)).size,120);
  const newer=f.service.history({...q,cursor:page.page.newerCursor});
  assert.equal(newer.events[newer.events.length-1].sequence,first.events[first.events.length-1].sequence);
});
