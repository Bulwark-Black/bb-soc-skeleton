"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const AdministrationContract = require("../public/administration-contract");
const {
  AUDIT_FILE,
  ReferenceAdministrationStore,
  STATE_FILE,
  emptyState,
  stableId,
  validateState
} = require("../server/reference-administration-store");
const {
  ReferenceAdministrationError,
  ReferenceAdministrationRuntime
} = require("../server/reference-administration-runtime");

const START = Date.parse("2026-08-30T10:00:00.000Z");

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function createHarness(t) {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(temporaryRoot, "bb-soc-administration-test-"));
  let instant = START;
  let runtime = new ReferenceAdministrationRuntime({ stateDirectory: directory, clock: () => new Date(instant) });
  t.after(() => {
    if (runtime) runtime.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    get runtime() { return runtime; },
    set runtime(value) { runtime = value; },
    advance(milliseconds = 1000) { instant += milliseconds; return new Date(instant); },
    setTime(value) { instant = typeof value === "number" ? value : Date.parse(value); },
    now() { return new Date(instant); },
    request(requestId, command, input, expectedRevision = runtime.getState().revision, requestedAt = new Date(instant).toISOString()) {
      return {
        schemaVersion: "1",
        documentType: "administration-command-request",
        requestId,
        command,
        requestedAt,
        expectedRevision,
        input
      };
    },
    restart() {
      runtime.dispose();
      runtime = new ReferenceAdministrationRuntime({ stateDirectory: directory, clock: () => new Date(instant) });
      return runtime;
    }
  };
}

function createAgent(harness, requestId = "agent-create", overrides = {}) {
  const result = harness.runtime.execute(harness.request(requestId, "agent.create", {
    displayName: "Managed agent",
    kind: "service",
    capabilities: ["docs:read", "registry:read"],
    ...overrides
  }));
  assert.equal(result.status, "succeeded");
  return result.output.agentId;
}

function snapshotRequest(domain, knownRevision) {
  return {
    schemaVersion: "1",
    documentType: "administration-snapshot-request",
    domain,
    reason: "refresh",
    ...(knownRevision === undefined ? {} : { knownRevision })
  };
}

test("reference administration accepts the public contract's optional fields, limits, and RFC 3339 timestamps", (t) => {
  const harness = createHarness(t);
  const capabilities = Array.from({ length: 64 }, (_, index) => `capability:${index}`);
  const agentId = createAgent(harness, "agent-contract-limits", {
    description: "",
    model: "",
    capabilities
  });
  harness.advance();
  const attestation = harness.runtime.execute(harness.request("attestation-offset", "attestation.create", {
    title: "Offset due date",
    description: "",
    owner: "",
    dueAt: "2026-08-31T12:30:00-07:00"
  }));
  assert.equal(attestation.status, "succeeded");
  harness.advance();
  const risk = harness.runtime.execute(harness.request("risk-optional-description", "risk.create", {
    title: "Risk without a description",
    likelihood: "moderate",
    impact: "high",
    reviewAt: "2026-09-01T08:00:00Z"
  }));
  assert.equal(risk.status, "succeeded");

  const agents = harness.runtime.getSnapshot(snapshotRequest("agents"));
  assert.equal(agents.agents[0].agentId, agentId);
  assert.equal(agents.agents[0].description, "");
  assert.equal(agents.agents[0].model, "");
  assert.equal(agents.agents[0].capabilities.length, 64);
  const governance = harness.runtime.getSnapshot(snapshotRequest("governance"));
  assert.equal(governance.attestations[0].dueAt, "2026-08-31T12:30:00-07:00");
  assert.equal(Object.hasOwn(governance.risks[0], "description"), false);
  assert.equal(governance.risks[0].reviewAt, "2026-09-01T08:00:00Z");
  harness.restart();
  assert.equal(harness.runtime.getSnapshot(snapshotRequest("governance")).risks.length, 1);
});

test("prompt revisions are immutable, correlated, and cannot be changed while their agent is archived", (t) => {
  const harness = createHarness(t);
  const agentId = createAgent(harness);
  harness.advance();
  const revise = harness.runtime.execute(harness.request("prompt-revise", "prompt.revise", {
    agentId,
    title: "Reviewed prompt",
    body: "Read only authorized documentation."
  }));
  assert.equal(revise.status, "succeeded");
  harness.advance();
  const activate = harness.runtime.execute(harness.request("prompt-activate", "prompt.activate", {
    promptId: revise.output.promptId
  }));
  assert.equal(activate.status, "succeeded");
  const prompt = harness.runtime.getPrompt({
    schemaVersion: "1",
    documentType: "agent-prompt-request",
    promptId: revise.output.promptId
  });
  assert.equal(prompt.body, "Read only authorized documentation.");
  assert.equal(prompt.state, "active");
  harness.advance();
  assert.equal(harness.runtime.execute(harness.request("agent-archive", "agent.archive", { agentId })).status, "succeeded");
  harness.advance();
  const blocked = harness.runtime.execute(harness.request("prompt-archive-while-agent-archived", "prompt.archive", {
    promptId: revise.output.promptId
  }));
  assert.equal(blocked.status, "rejected");
  assert.equal(blocked.error.code, "transition-invalid");
  assert.equal(harness.runtime.getPrompt({
    schemaVersion: "1",
    documentType: "agent-prompt-request",
    promptId: revise.output.promptId
  }).state, "active");
});

test("pause revokes bootstrap paths and dependency-aware removal retains prompt and enrollment history", (t) => {
  const harness = createHarness(t);
  const agentId = createAgent(harness);
  harness.advance();
  const prompt = harness.runtime.execute(harness.request("dependency-prompt", "prompt.revise", {
    agentId,
    title: "Retained prompt",
    body: "Retain this revision."
  }));
  harness.advance();
  const enrollment = harness.runtime.execute(harness.request("dependency-enrollment", "enrollment.issue", {
    agentId,
    expiresInSeconds: 300
  }));
  assert.equal(enrollment.status, "succeeded");
  harness.advance();
  assert.equal(harness.runtime.execute(harness.request("agent-pause", "agent.pause", { agentId })).status, "succeeded");
  let agents = harness.runtime.getSnapshot(snapshotRequest("agents"));
  assert.equal(agents.enrollments[0].state, "revoked");
  harness.advance();
  const issueWhilePaused = harness.runtime.execute(harness.request("issue-while-paused", "enrollment.issue", {
    agentId,
    expiresInSeconds: 60
  }));
  assert.equal(issueWhilePaused.status, "rejected");
  assert.equal(issueWhilePaused.error.code, "transition-invalid");
  harness.advance();
  assert.equal(harness.runtime.execute(harness.request("agent-resume", "agent.resume", { agentId })).status, "succeeded");
  harness.advance();
  assert.equal(harness.runtime.execute(harness.request("agent-archive", "agent.archive", { agentId })).status, "succeeded");
  harness.advance();
  const remove = harness.runtime.execute(harness.request("agent-remove-with-dependencies", "agent.remove", { agentId }));
  assert.equal(remove.status, "conflict");
  assert.equal(remove.error.code, "dependency-conflict");
  agents = harness.runtime.getSnapshot(snapshotRequest("agents"));
  assert.equal(agents.agents.length, 1);
  assert.equal(agents.prompts[0].promptId, prompt.output.promptId);
  assert.equal(agents.enrollments[0].enrollmentId, enrollment.output.enrollmentId);
});

test("an archived dependency-free agent can be removed with a durable tombstone", (t) => {
  const harness = createHarness(t);
  const agentId = createAgent(harness);
  harness.advance();
  harness.runtime.execute(harness.request("archive-empty-agent", "agent.archive", { agentId }));
  harness.advance();
  const removed = harness.runtime.execute(harness.request("remove-empty-agent", "agent.remove", { agentId }));
  assert.equal(removed.status, "succeeded");
  assert.equal(removed.output.state, "removed");
  assert.equal(harness.runtime.getSnapshot(snapshotRequest("agents")).agents.length, 0);
  const state = harness.runtime.getState();
  assert.equal(state.tombstones.length, 1);
  assert.equal(state.tombstones[0].resourceId, agentId);
});

test("one-time enrollment material is returned once, never persisted, and never replayed across restart", (t) => {
  const harness = createHarness(t);
  const agentId = createAgent(harness);
  harness.advance();
  const request = harness.request("one-time-enrollment", "enrollment.issue", { agentId, expiresInSeconds: 120 });
  const issued = harness.runtime.execute(request);
  const oneTimeValue = issued.output.oneTimeCredential.value;
  assert.match(oneTimeValue, /^[A-Za-z0-9_-]{43}$/);
  const replay = harness.runtime.execute(request);
  assert.equal(replay.status, "succeeded");
  assert.equal(Object.hasOwn(replay.output, "oneTimeCredential"), false);
  assert.equal(fs.readFileSync(path.join(harness.directory, STATE_FILE), "utf8").includes(oneTimeValue), false);
  assert.equal(fs.readFileSync(path.join(harness.directory, AUDIT_FILE), "utf8").includes(oneTimeValue), false);
  harness.restart();
  const replayAfterRestart = harness.runtime.execute(request);
  assert.equal(replayAfterRestart.status, "succeeded");
  assert.equal(Object.hasOwn(replayAfterRestart.output, "oneTimeCredential"), false);
});

test("command failures are idempotently cached while stale global revisions do not mutate state", (t) => {
  const harness = createHarness(t);
  const agentId = createAgent(harness);
  const revision = harness.runtime.getState().revision;
  const stale = harness.request("stale-agent-pause", "agent.pause", { agentId }, 0);
  const staleResult = harness.runtime.execute(stale);
  assert.equal(staleResult.status, "conflict");
  assert.equal(staleResult.error.code, "revision-conflict");
  assert.equal(harness.runtime.getState().revision, revision);

  harness.advance();
  const invalid = harness.request("invalid-agent-resume", "agent.resume", { agentId });
  const first = harness.runtime.execute(invalid);
  assert.equal(first.status, "rejected");
  const afterFailure = harness.runtime.getState().revision;
  assert.equal(afterFailure, revision + 1);
  assert.deepEqual(harness.runtime.execute(invalid), first);
  assert.equal(harness.runtime.getState().revision, afterFailure);

  const reused = { ...invalid, command: "agent.archive" };
  const collision = harness.runtime.execute(reused);
  assert.equal(collision.status, "conflict");
  assert.equal(collision.error.code, "already-exists");
  assert.equal(harness.runtime.getState().revision, afterFailure);
});

test("connection proof validates exact data, binding, time, agent state, and one-time use", (t) => {
  const harness = createHarness(t);
  const agentId = createAgent(harness);
  harness.advance();
  const issued = harness.runtime.execute(harness.request("connection-enrollment", "enrollment.issue", {
    agentId,
    expiresInSeconds: 120
  }));
  const enrollmentId = issued.output.enrollmentId;
  const value = issued.output.oneTimeCredential.value;
  const base = { schemaVersion: "1", agentId, enrollmentId, observedAt: harness.now().toISOString() };
  assert.throws(() => harness.runtime.proveAgentConnection({ ...base, extra: true }, value), (error) =>
    error instanceof ReferenceAdministrationError && error.code === "validation-failed");
  assert.throws(() => harness.runtime.proveAgentConnection({ ...base, observedAt: "2026-02-31T00:00:00Z" }, value), (error) =>
    error instanceof ReferenceAdministrationError && error.code === "validation-failed");
  assert.throws(() => harness.runtime.proveAgentConnection(base, "x".repeat(43)), (error) =>
    error instanceof ReferenceAdministrationError && error.code === "not-authorized");
  assert.equal(harness.runtime.getState().revision, 2);
  harness.advance();
  const connected = harness.runtime.proveAgentConnection({ ...base, observedAt: harness.now().toISOString() }, value);
  assert.equal(connected.status, "connected");
  assert.equal(harness.runtime.getState().revision, 3);
  assert.throws(() => harness.runtime.proveAgentConnection({ ...base, observedAt: harness.now().toISOString() }, value), (error) =>
    error instanceof ReferenceAdministrationError && error.code === "not-authorized");
  const snapshot = harness.runtime.getSnapshot(snapshotRequest("agents"));
  assert.equal(snapshot.enrollments[0].state, "connected");
  assert.equal(snapshot.agents[0].lastSeenAt, connected.connectedAt);
});

test("expired enrollment state is honest and reissuance persists expiration instead of revocation", (t) => {
  const harness = createHarness(t);
  const agentId = createAgent(harness);
  harness.advance();
  const first = harness.runtime.execute(harness.request("short-enrollment", "enrollment.issue", {
    agentId,
    expiresInSeconds: 1
  }));
  harness.advance(2000);
  assert.equal(harness.runtime.getSnapshot(snapshotRequest("agents")).enrollments[0].state, "expired");
  const second = harness.runtime.execute(harness.request("replacement-enrollment", "enrollment.issue", {
    agentId,
    expiresInSeconds: 60
  }));
  assert.equal(second.status, "succeeded");
  const state = harness.runtime.getState();
  assert.equal(state.enrollments.find((entry) => entry.enrollmentId === first.output.enrollmentId).state, "expired");
  assert.equal(state.enrollments.find((entry) => entry.enrollmentId === first.output.enrollmentId).revokedAt, null);
});

test("attestation and risk commands enforce update, transition, archive, restore, and removal protocols", (t) => {
  const harness = createHarness(t);
  let result = harness.runtime.execute(harness.request("att-create", "attestation.create", { title: "Control attestation" }));
  const attestationId = result.output.attestationId;
  harness.advance();
  result = harness.runtime.execute(harness.request("att-update", "attestation.update", {
    attestationId,
    owner: "",
    dueAt: null
  }));
  assert.equal(result.status, "succeeded");
  harness.advance();
  assert.equal(harness.runtime.execute(harness.request("att-pending", "attestation.transition", {
    attestationId,
    status: "pending",
    note: "Ready for review"
  })).output.state, "pending");
  harness.advance();
  assert.equal(harness.runtime.execute(harness.request("att-attested", "attestation.transition", {
    attestationId,
    status: "attested"
  })).output.state, "attested");
  harness.advance();
  assert.equal(harness.runtime.execute(harness.request("att-archive", "attestation.archive", { attestationId })).output.state, "archived");
  harness.advance();
  assert.equal(harness.runtime.execute(harness.request("att-restore", "attestation.restore", { attestationId })).output.state, "draft");
  harness.advance();
  harness.runtime.execute(harness.request("att-rearchive", "attestation.archive", { attestationId }));
  harness.advance();
  assert.equal(harness.runtime.execute(harness.request("att-remove", "attestation.remove", { attestationId })).output.state, "removed");

  harness.advance();
  result = harness.runtime.execute(harness.request("risk-create", "risk.create", {
    title: "Tracked risk",
    likelihood: "high",
    impact: "critical"
  }));
  const riskId = result.output.riskId;
  harness.advance();
  assert.equal(harness.runtime.execute(harness.request("risk-mitigating", "risk.transition", {
    riskId,
    status: "mitigating"
  })).output.state, "mitigating");
  harness.advance();
  const closeRequest = harness.request("risk-close-without-note", "risk.transition", { riskId, status: "closed" });
  const rejected = harness.runtime.execute(closeRequest);
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.error.field, "input.note");
  const failureRevision = harness.runtime.getState().revision;
  assert.deepEqual(harness.runtime.execute(closeRequest), rejected);
  assert.equal(harness.runtime.getState().revision, failureRevision);
  harness.advance();
  assert.equal(harness.runtime.execute(harness.request("risk-close", "risk.transition", {
    riskId,
    status: "closed",
    note: "Closure reviewed"
  })).output.state, "closed");
  harness.advance();
  harness.runtime.execute(harness.request("risk-archive", "risk.archive", { riskId }));
  harness.advance();
  assert.equal(harness.runtime.execute(harness.request("risk-restore", "risk.restore", { riskId })).output.state, "open");
  harness.advance();
  harness.runtime.execute(harness.request("risk-rearchive", "risk.archive", { riskId }));
  harness.advance();
  assert.equal(harness.runtime.execute(harness.request("risk-remove", "risk.remove", { riskId })).output.state, "removed");
  const governance = harness.runtime.getSnapshot(snapshotRequest("governance"));
  assert.equal(governance.attestations.length, 0);
  assert.equal(governance.risks.length, 0);
});

test("store locking, close behavior, and clean restart preserve validated state and audit", (t) => {
  const harness = createHarness(t);
  createAgent(harness);
  assert.throws(() => new ReferenceAdministrationStore({ directory: harness.directory }), /already in use/);
  const stateBefore = harness.runtime.getState();
  harness.restart();
  assert.deepEqual(harness.runtime.getState(), stateBefore);
  const store = new ReferenceAdministrationStore({
    directory: fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "bb-soc-administration-close-test-"))
  });
  const closeDirectory = store.directory;
  store.close();
  assert.throws(() => store.snapshot(), /unavailable/);
  assert.throws(() => store.transact({}, () => {}), /unavailable/);
  fs.rmSync(closeDirectory, { recursive: true, force: true });
});

test("startup recovers a dangling audit intent according to the durable state revision", (t) => {
  const oldStateHarness = createHarness(t);
  oldStateHarness.runtime.dispose();
  oldStateHarness.runtime = null;
  const dangling = {
    schemaVersion: "1",
    at: "2026-08-30T10:00:00.000Z",
    phase: "intent",
    revision: 1,
    command: "agent.create",
    actor: "loopback:operator",
    resourceType: "agent",
    resourceId: stableId("agent"),
    requestId: "audit-recovery-old-state",
    changedFields: ["display-name"]
  };
  fs.writeFileSync(path.join(oldStateHarness.directory, AUDIT_FILE), JSON.stringify(dangling) + "\n", { mode: 0o600 });
  oldStateHarness.runtime = new ReferenceAdministrationRuntime({
    stateDirectory: oldStateHarness.directory,
    clock: () => oldStateHarness.now()
  });
  assert.equal(oldStateHarness.runtime.getState().revision, 0);
  let lines = fs.readFileSync(path.join(oldStateHarness.directory, AUDIT_FILE), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(lines.at(-1).phase, "abort");

  const newStateHarness = createHarness(t);
  createAgent(newStateHarness, "audit-recovery-committed-state");
  newStateHarness.runtime.dispose();
  newStateHarness.runtime = null;
  const auditPath = path.join(newStateHarness.directory, AUDIT_FILE);
  lines = fs.readFileSync(auditPath, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  fs.writeFileSync(auditPath, lines[0] + "\n", { mode: 0o600 });
  newStateHarness.runtime = new ReferenceAdministrationRuntime({
    stateDirectory: newStateHarness.directory,
    clock: () => newStateHarness.now()
  });
  assert.equal(newStateHarness.runtime.getState().revision, 1);
  const recovered = fs.readFileSync(auditPath, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(recovered.at(-1).phase, "commit");
});

test("state validation rejects malformed identities, future revisions, invalid lifecycle dates, actions, and cached secrets", () => {
  const state = emptyState();
  const agentId = stableId("agent");
  state.revision = 1;
  state.agents.push({
    agentId,
    displayName: "Agent",
    kind: "service",
    capabilities: [],
    state: "active",
    activePromptId: null,
    lastSeenAt: null,
    revision: 1,
    createdAt: "2026-08-30T10:00:00.000Z",
    updatedAt: "2026-08-30T10:00:00.000Z"
  });
  assert.doesNotThrow(() => validateState(clone(state)));

  const malformed = clone(state);
  malformed.agents[0].agentId = "agent-------------------------------------";
  assert.throws(() => validateState(malformed), /invalid/);
  const future = clone(state);
  future.agents[0].revision = 2;
  assert.throws(() => validateState(future), /future revision/);
  const backwards = clone(state);
  backwards.agents[0].updatedAt = "2026-08-30T09:59:59.000Z";
  assert.throws(() => validateState(backwards), /precedes/);

  const invalidChange = clone(state);
  invalidChange.changes.push({
    changeId: stableId("change"),
    domain: "agents",
    resourceType: "agent",
    resourceId: agentId,
    action: "agent.executed-arbitrary-command",
    status: "succeeded",
    at: "2026-08-30T10:00:00.000Z"
  });
  assert.throws(() => validateState(invalidChange), /action is invalid/);

  const secretCache = clone(state);
  secretCache.commandResults.push({
    requestId: "cached-secret",
    requestHash: "a".repeat(64),
    command: "enrollment.issue",
    result: {
      schemaVersion: "1",
      documentType: "administration-command-result",
      requestId: "cached-secret",
      command: "enrollment.issue",
      status: "succeeded",
      completedAt: "2026-08-30T10:00:00.000Z",
      output: {
        enrollmentId: stableId("enrollment"),
        agentId,
        state: "issued",
        revision: 1,
        oneTimeCredential: { value: "must-not-persist" }
      }
    },
    at: "2026-08-30T10:00:00.000Z"
  });
  assert.throws(() => validateState(secretCache), /unsupported field|safely cacheable/);
});

test("runtime snapshots and results remain accepted by the public administration contract", (t) => {
  const harness = createHarness(t);
  const request = harness.request("contract-round-trip", "agent.create", {
    displayName: "Contract agent",
    kind: "automation",
    capabilities: []
  });
  const result = harness.runtime.execute(request);
  assert.deepEqual(AdministrationContract.validateCommandResult(result, request), result);
  const snapshotRequestValue = snapshotRequest("agents", 0);
  const snapshot = harness.runtime.getSnapshot(snapshotRequestValue);
  assert.deepEqual(AdministrationContract.validateSnapshot(snapshot, snapshotRequestValue), snapshot);
});
