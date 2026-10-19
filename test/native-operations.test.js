"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { MonitorStore } = require("../server/native-monitor/store");
const { createOperations, validateEmployees } = require("../server/native-monitor/operations");
const START = Date.parse("2026-10-18T12:00:00.000Z");
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "synthetic-operations-"));
  let now = START, sequence = 0;
  const registry = { VERSION: 1, HOSTS: ["one", "two"].map(id => ({ id: "resource-" + id, sourceId: "source-" + id,
    appId: "synthetic-app", label: "Synthetic resource " + id, intervalSeconds: 60 })), SERIES: [],
    CHECKS: ["one", "two"].map(id => ({ id: "resource-" + id + ".collection", host: "resource-" + id, label: "Collector " + id,
      type: "collection", intervalSeconds: 60, policy: { failCount: 1, recoverCount: 1 } })) };
  const employees = ["one", "two"].map(id => ({ id: "analyst-" + id, name: "Synthetic analyst " + id,
    role: "Review observed evidence", host: "resource-" + id, sourceId: "source-" + id, cadenceSeconds: 600 }));
  const f = { registry, employees, directory, advance(ms) { now += ms; }, at: () => new Date(now).toISOString() };
  f.open = () => { f.store = new MonitorStore({ data: directory, registry, now: () => now, minFreeBytes: 0 });
    f.ops = createOperations(f.store.db, { now: () => now, registry, employees }); };
  f.open(); t.after(() => { f.store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  f.restart = () => { f.store.close(); f.open(); };
  f.post = (route, body = {}, hosts = ["resource-one"]) => f.ops.route({ method: "POST", path: route, hosts,
    body: { actor: "operator:synthetic", idempotencyKey: "command-" + (++sequence), ...body } }).body;
  f.get = (route, query = {}, hosts = ["resource-one"], body = {}) => f.ops.route({ method: "GET", path: route, hosts, query: new URLSearchParams(query), body }).body;
  f.job = (id = "synthetic-job") => f.post("/jobs", { id, host: "resource-one", label: "Synthetic expected job", nextDueAt: f.at(), intervalSeconds: 60,
    graceSeconds: 5, maxRuntimeSeconds: 120, progressTimeoutSeconds: 30, observationTimeoutSeconds: 60 }).job;
  f.jobEvent = (kind, extra = {}) => f.post("/jobs/events", { jobId: "synthetic-job", runId: "synthetic-run", kind, observedAt: f.at(), scheduledFor: new Date(START).toISOString(), ...extra });
  f.observe = () => f.jobEvent("observation", { evidence: { sourceValid: true }, journalCoverage: { complete: true, from: new Date(START - 60000).toISOString(), to: f.at() } });
  f.machine = event => f.post("/operations/ingest", { host: "resource-one", sourceId: "source-one", event: { schemaVersion: 1, eventId: "machine-event-" + (++sequence), observedAt: f.at(), ...event } });
  return f;
}

test("operations starts with no configured employees, validates explicit source bindings and admits scoped machine receipts once", t => {
  const f = fixture(t), empty = createOperations(f.store.db, { registry: f.registry, now: () => START });
  assert.equal(empty.route({ method: "GET", path: "/employees" }).body.employees.length, 0);
  assert.throws(() => validateEmployees([{ ...f.employees[0], sourceId: "source-two" }], f.registry), /bound/);
  assert.throws(() => validateEmployees([f.employees[0], f.employees[0]], f.registry), /unique/);
  assert.throws(() => createOperations(f.store.db, { registry: f.registry, employees: [{ ...f.employees[0], host: "resource-two", sourceId: "source-two" }] }), /identity is immutable/);
  f.job();
  const event = { schemaVersion: 1, eventId: "stable-machine-event", observedAt: f.at(), jobId: "synthetic-job", runId: "machine-run", kind: "start", scheduledFor: f.at() };
  const receipt = f.machine(event); assert.equal(receipt.receiptId, "host:resource-one:stable-machine-event");
  f.restart(); assert.deepEqual(f.machine(event), receipt);
  assert.throws(() => f.machine({ ...event, kind: "progress" }), /different content/);
  assert.throws(() => f.post("/operations/ingest", { host: "resource-one", sourceId: "source-two", event }), error => error.status === 403);
  assert.throws(() => f.machine({ ...event, eventId: "other-source", sourceId: "source-two" }), error => error.status === 403);
  assert.throws(() => f.machine({ employeeId: "analyst-two", runId: "outside-run", kind: "start" }), error => error.status === 403);
  assert.throws(() => f.machine({ jobId: "unregistered-job", runId: "missing-run", kind: "start" }), error => error.status === 404);
  assert.throws(() => f.machine({ ...event, eventId: "invalid-clock", observedAt: "2026-02-31T10:00:00Z" }), /invalid observedAt/);
  assert.equal(f.get("/employees").employees.length, 1);
  assert.equal(f.get("/jobs", {}, ["resource-two"]).jobs.length, 0);
});

test("job execution, schedule proof, observer freshness and verified output independently drive persisted incidents", t => {
  const f = fixture(t); f.job(); f.observe(); f.jobEvent("start"); f.advance(1000);
  f.jobEvent("progress");
  assert.throws(() => f.jobEvent("succeeded", { observedAt: new Date(START).toISOString(), evidence: { verification: "verified" } }), /precedes observed execution progress/);
  f.jobEvent("succeeded", { evidence: { processExitCode: 0 } });
  let job = f.get("/jobs").jobs[0]; assert.equal(job.executionState, "succeeded"); assert.equal(job.outputState, "unknown"); assert.equal(job.health, "unknown");
  f.advance(59000); f.observe();
  f.jobEvent("start", { runId: "verified-run", scheduledFor: f.at() }); f.advance(1000);
  f.jobEvent("succeeded", { runId: "verified-run", scheduledFor: new Date(START + 60000).toISOString(), evidence: { verification: "verified", receiptHash: "synthetic-proof" } });
  assert.equal(f.get("/jobs").jobs[0].health, "healthy");
  f.advance(59000); f.observe(); const failedSlot = f.at();
  f.jobEvent("failed", { runId: "failed-run", scheduledFor: failedSlot, evidence: { processExitCode: 1 } });
  f.store.reconcileOperationalConditions(f.ops.conditions(), f.ops.conditionDefinitions());
  const incident = f.store.db.prepare("SELECT * FROM incidents WHERE check_id='operations.job.synthetic-job' AND status='open'").get();
  assert.ok(incident); assert.equal(f.get("/jobs").jobs[0].health, "critical");
  assert.ok(f.ops.conditionDefinitions().find(row => row.id === "operations.job.synthetic-job").dependencies.some(row => row.checkId === "resource-one.collection"));
  f.advance(61000); assert.equal(f.get("/jobs").jobs[0].health, "unknown");
  f.store.reconcileOperationalConditions(f.ops.conditions(), f.ops.conditionDefinitions());
  assert.equal(f.store.db.prepare("SELECT status FROM incidents WHERE id=?").get(incident.id).status, "open", "stale observer evidence cannot resolve a measured incident");
  f.restart(); assert.equal(f.get("/jobs").jobs[0].latestRun.id, "failed-run");
  assert.ok(f.store.db.prepare("SELECT id FROM incidents WHERE id=?").get(incident.id));
  f.observe(); const recoveredSlot = new Date(START + 180000).toISOString();
  f.jobEvent("start", { runId: "recovered-run", scheduledFor: recoveredSlot }); f.advance(1000);
  f.jobEvent("succeeded", { runId: "recovered-run", scheduledFor: recoveredSlot, evidence: { verification: "verified" } });
  f.store.reconcileOperationalConditions(f.ops.conditions(), f.ops.conditionDefinitions());
  assert.equal(f.store.db.prepare("SELECT status FROM incidents WHERE id=?").get(incident.id).status, "resolved");
  assert.equal(f.store.notifications, false);
});

test("missing schedules require complete fresh coverage and an unlinked run remains schedule-unproven", t => {
  const f = fixture(t); f.job(); f.advance(10000);
  assert.equal(f.get("/jobs").jobs[0].scheduleState, "unproven");
  f.observe(); assert.equal(f.get("/jobs").jobs[0].scheduleState, "overdue");
  f.jobEvent("succeeded", { scheduledFor: null, evidence: { verification: "unknown" } });
  const job = f.get("/jobs").jobs[0]; assert.equal(job.latestRun.startedAt, null); assert.equal(job.latestRun.executionEvidence, "terminal_only");
  assert.equal(job.scheduleState, "unproven"); assert.equal(job.health, "unknown");
  f.jobEvent("start", { scheduledFor: null, observedAt: new Date(START + 1000).toISOString() });
  assert.equal(f.get("/jobs").jobs[0].latestRun.executionEvidence, "start_and_terminal");
  assert.throws(() => f.jobEvent("failed", { scheduledFor: null, evidence: "cannot rewrite" }), /terminal/);
  assert.throws(() => f.jobEvent("start", { runId: "future", scheduledFor: null, observedAt: new Date(START + 60000).toISOString() }), /future/);
});

test("work ownership, uncertain actions and latest-action verification survive restart and never execute commands", t => {
  const f = fixture(t); let work = f.post("/work", { id: "synthetic-work", host: "resource-one", employeeId: "analyst-one", title: "Inspect reported condition", reason: "Synthetic condition evidence" }).work;
  assert.throws(() => f.post("/work", { host: "resource-one", employeeId: "analyst-two", title: "Wrong binding", reason: "Synthetic" }), /resource/);
  const claimed = f.post("/work/claim", { id: work.id, expectedRevision: work.revision, employeeId: "analyst-one" }).work; work = claimed;
  const update = (kind, extra = {}) => { work = f.post("/work/events", { id: work.id, expectedRevision: work.revision, leaseToken: claimed.leaseToken, kind, ...extra }).work; return work; };
  update("assessment", { summary: "Observed anomaly", evidence: "Synthetic receipt" });
  update("action_intent", { actionId: "action-one", intent: "Record externally authorized investigation" });
  update("action_started", { actionId: "action-one", executionRef: "external-run-reference" });
  f.advance(121000); f.restart();
  assert.equal(f.get("/work").work[0].status, "execution_uncertain"); assert.equal(f.get("/work").work[0].leaseToken, undefined);
  assert.throws(() => f.post("/work/claim", { id: work.id, expectedRevision: work.revision, employeeId: "analyst-one" }), /ownership unresolved/);
  update("reconcile_action", { outcome: "succeeded", evidence: "Inspected existing invocation; it finished" });
  work = f.post("/work/claim", { id: work.id, expectedRevision: work.revision, employeeId: "analyst-one" }).work; claimed.leaseToken = work.leaseToken;
  assert.throws(() => update("finish"), /verification/);
  update("verification", { outcome: "failed", result: "Condition persists", evidence: "Fresh synthetic measurement" });
  assert.throws(() => update("finish"), /failed verification/);
  update("action_intent", { actionId: "action-two", intent: "Record another external action" }); assert.equal(work.verification, null);
  update("action_started", { actionId: "action-two", executionRef: "external-second-run" });
  update("action_finished", { actionId: "action-two", outcome: "succeeded", evidence: "Observed exit" });
  update("verification", { outcome: "verified", result: "Observed result", evidence: "Independent fresh measurement after second action" });
  update("finish"); assert.equal(work.status, "finished");
  assert.equal(f.get("/work", {}, ["resource-two"]).work.length, 0);
});

test("employee runs and separately received report provenance preserve honest linkage and next-visit guidance", t => {
  const f = fixture(t), reportHash = "sha256:" + crypto.createHash("sha256").update("synthetic report").digest("hex");
  f.machine({ employeeId: "analyst-one", kind: "output", outputId: "synthetic-output", outputHash: reportHash, outputRef: "synthetic-report-reference", summary: "Synthetic report received" });
  let employee = f.get("/employees").employees[0]; assert.equal(employee.executionState, "unknown"); assert.equal(employee.lastOutput.linkage, "unlinked");
  f.machine({ employeeId: "analyst-one", runId: "employee-run", kind: "start" });
  f.advance(1000); f.machine({ employeeId: "analyst-one", runId: "employee-run", kind: "progress" });
  assert.throws(() => f.machine({ employeeId: "analyst-one", runId: "employee-run", kind: "succeeded", observedAt: new Date(START).toISOString(), evidence: "Contradicts newer observed progress" }), /precedes observed execution progress/);
  f.advance(1000); f.machine({ employeeId: "analyst-one", runId: "employee-run", kind: "succeeded", evidence: "Actual quiet-queue invocation completed" });
  f.machine({ employeeId: "analyst-one", runId: "employee-run", kind: "output", outputId: "linked-output", outputHash: reportHash, outputRef: "synthetic-second-report", summary: "Reported output" });
  employee = f.get("/employees").employees[0]; assert.equal(employee.executionState, "succeeded"); assert.equal(employee.lastOutput.linkage, "matched");
  assert.equal(employee.scheduleState, "unverified_external_schedule"); assert.equal(employee.operatorInstructions.pendingCount, 0);
  assert.ok(!JSON.stringify(employee).includes("administrator"));
  f.restart(); assert.equal(f.get("/employees").employees[0].lastOutput.outputHash, reportHash);
  f.advance(1000);
  f.machine({ employeeId: "analyst-one", runId: "offset-run", kind: "start", observedAt: "2026-10-18T05:00:03-07:00" });
  employee = f.get("/employees").employees[0]; assert.equal(employee.runs[0].runId, "offset-run");
  assert.equal(employee.runs[0].observedAt, "2026-10-18T12:00:03.000Z");
  assert.throws(() => f.machine({ employeeId: "analyst-one", runId: "employee-run", kind: "output", outputId: "linked-output", outputHash: reportHash, outputRef: "different-report", summary: "Reported output" }), /identity conflict/);
  assert.throws(() => f.machine({ employeeId: "analyst-one", runId: "employee-run", kind: "failed", evidence: "cannot rewrite terminal" }), /terminal/);
});

test("job history uses scoped stable cursors and job reconciliation records inspected evidence without fabricating output", t => {
  const f = fixture(t); f.job();
  for (let i = 0; i < 4; i++) { f.advance(1000); f.jobEvent("succeeded", { runId: "history-run-" + i, scheduledFor: null, evidence: "Reported exit; output unverified" }); }
  const first = f.get("/jobs", { history: "synthetic-job", limit: "2" }); assert.equal(first.runs.length, 2); assert.equal(first.page.total, 4);
  const last = f.get("/jobs", { history: "synthetic-job", limit: "2", cursor: first.page.nextCursor });
  assert.equal(new Set([...first.runs, ...last.runs].map(run => run.id)).size, 4);
  assert.throws(() => f.get("/jobs", { history: "synthetic-job", limit: "2", cursor: first.page.nextCursor }, ["resource-two"]), error => error.status === 403);
  const run = first.runs[0]; f.advance(1000);
  const reconciled = f.post("/jobs/events", { kind: "reconcile", jobId: "synthetic-job", runId: run.id, expectedRevision: run.revision,
    outcome: "succeeded", observedAt: f.at(), evidence: "Inspected actual invocation without rerunning it" }).run;
  assert.equal(reconciled.outputState, "unknown"); assert.equal(reconciled.reconciliations.length, 1);
  assert.equal(f.get("/jobs", { runId: run.id }).run.reconciliations.length, 1);
});

test("next-visit inbox persists owner guidance, explicit read receipts and withdrawals without implying completed work", t => {
  const f = fixture(t);
  const input = { idempotencyKey: "instruction-one", recipient: "analyst-one", title: "Inspect the next visit", body: "Review the supplied evidence and report the outcome." };
  const note = f.post("/employee-inbox/create", input); assert.deepEqual(f.post("/employee-inbox/create", input), note);
  assert.throws(() => f.post("/employee-inbox/create", { ...input, body: "Changed content" }), /different content/);
  const next = () => f.get("/employee-inbox/next", { employeeId: "analyst-one" }, ["resource-one"], { sourceId: "source-one" });
  assert.equal(next().pendingCount, 1); assert.equal(next().items[0].delivery, "unknown"); assert.equal(next().pendingCount, 1, "reading never acknowledges");
  assert.equal(next().inboxPath, "/api/v1/monitor/instructions?sourceId=source-one&employeeId=analyst-one");
  assert.equal(next().acknowledge.path, "/api/v1/monitor/instructions/ack");
  assert.equal(f.get("/employee-inbox", {}, ["resource-two"]).items.length, 0);
  f.post("/employee-inbox/create", { recipient: "analyst-two", title: "Other resource", body: "Independent next visit." }, ["resource-two"]);
  const filtered = f.get("/employee-inbox", { employeeId: "analyst-one" }, null);
  assert.equal(filtered.items.length, 1);
  assert.equal(filtered.recipientSummary["analyst-two"].waiting, 1, "roster counts remain complete when viewing one employee");
  assert.equal(f.get("/employee-inbox", {}, ["resource-one"]).recipientSummary["analyst-two"], undefined);
  assert.throws(() => f.get("/employee-inbox/next", { employeeId: "analyst-one" }, ["resource-one"], { sourceId: "source-two" }), error => error.status === 403);
  const acknowledgment = { idempotencyKey: "read-one", messageId: note.messageId, employeeId: "analyst-one", sourceId: "source-one", reply: "Read; investigation remains pending." };
  assert.throws(() => f.post("/employee-inbox/ack", { ...acknowledgment, sourceId: "source-two" }), error => error.status === 403);
  const receipt = f.post("/employee-inbox/ack", acknowledgment); assert.match(receipt.meaning, /not task completion/);
  f.restart(); assert.deepEqual(f.post("/employee-inbox/ack", acknowledgment), receipt); assert.equal(next().pendingCount, 0);
  assert.equal(f.get("/work").work.length, 0, "reading guidance does not fabricate an assignment");
  const withdraw = f.post("/employee-inbox/withdraw", { messageId: note.messageId }); assert.ok(withdraw.withdrawnAt);
  const retained = f.get("/employee-inbox", { employeeId: "analyst-one" });
  assert.equal(retained.items[0].delivery, "withdrawn"); assert.equal(retained.items[0].acknowledgments["analyst-one"].reply, acknowledgment.reply);
  assert.throws(() => f.post("/employee-inbox/ack", { ...acknowledgment, idempotencyKey: "second-read" }), /withdrawn/);
  assert.ok(f.store.db.prepare("SELECT count(*) AS n FROM ops_events").get().n >= 3);
});

test("operations and inbox audit failures roll back business state and replay receipts together", t => {
  const f = fixture(t);
  const before = table => Number(f.store.db.prepare("SELECT count(*) AS n FROM " + table).get().n);
  f.store.db.exec("CREATE TEMP TRIGGER synthetic_operations_rollback BEFORE INSERT ON ops_events BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
  const receipts = before("ops_receipts");
  assert.throws(() => f.post("/jobs", { idempotencyKey: "rollback-job", id: "rollback-job", host: "resource-one", label: "Synthetic job", nextDueAt: f.at(), intervalSeconds: 60 }), /synthetic audit failure/);
  assert.equal(before("ops_jobs"), 0); assert.equal(before("ops_receipts"), receipts);
  assert.throws(() => f.post("/employee-inbox/create", { idempotencyKey: "rollback-inbox", recipient: "analyst-one", title: "Synthetic note", body: "Retain atomically" }), /synthetic audit failure/);
  assert.equal(before("ops_inbox"), 0); assert.equal(before("ops_receipts"), receipts);
  f.store.db.exec("DROP TRIGGER synthetic_operations_rollback");
  assert.equal(f.post("/employee-inbox/create", { idempotencyKey: "rollback-inbox", recipient: "analyst-one", title: "Synthetic note", body: "Retain atomically" }).ok, true);
  assert.throws(() => f.get("/employee-inbox", { limit: "101" }), /pagination/);
  assert.throws(() => f.get("/employee-inbox", { offset: "1e2" }), /pagination/);
  assert.throws(() => f.get("/employee-inbox", { pendingOnly: "unknown" }), /filter/);
});
