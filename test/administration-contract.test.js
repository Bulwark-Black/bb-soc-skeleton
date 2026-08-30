"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const AdministrationRuntime = require("../public/administration-contract");
const AdministrationValidator = require("../tools/validate-administration");

const NOW = "2026-08-30T10:00:00.000Z";
const LATER = "2026-08-30T10:01:00.000Z";
const EXPIRES = "2026-08-30T10:10:00.000Z";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function snapshotRequest(domain, knownRevision) {
  const request = {
    schemaVersion: "1",
    documentType: "administration-snapshot-request",
    domain,
    reason: "refresh"
  };
  if (knownRevision !== undefined) request.knownRevision = knownRevision;
  return request;
}

function promptRequest() {
  return {
    schemaVersion: "1",
    documentType: "agent-prompt-request",
    promptId: "prompt-1"
  };
}

function commandRequest(command, input, overrides = {}) {
  return {
    schemaVersion: "1",
    documentType: "administration-command-request",
    requestId: `request-${command.replace(".", "-")}`,
    command,
    requestedAt: NOW,
    expectedRevision: 2,
    input,
    ...overrides
  };
}

function agentSnapshot() {
  return {
    schemaVersion: "1",
    documentType: "agent-administration-snapshot",
    domain: "agents",
    revision: 4,
    agents: [{
      agentId: "agent-1",
      displayName: "Triage agent",
      description: "Assists an authorized operator.",
      kind: "interactive",
      provider: "adopter-provider",
      model: "adopter-model",
      capabilities: ["alerts:read", "cases:write"],
      state: "active",
      activePromptId: "prompt-1",
      lastSeenAt: NOW,
      revision: 3,
      createdAt: NOW,
      updatedAt: NOW
    }],
    prompts: [{
      promptId: "prompt-1",
      agentId: "agent-1",
      version: 1,
      title: "Initial operating prompt",
      state: "active",
      revision: 2,
      createdAt: NOW,
      updatedAt: NOW
    }],
    enrollments: [{
      enrollmentId: "enrollment-1",
      agentId: "agent-1",
      state: "issued",
      issuedAt: NOW,
      expiresAt: EXPIRES,
      connectedAt: null,
      revokedAt: null,
      revision: 1
    }],
    changes: [{
      changeId: "change-1",
      resourceType: "agent",
      resourceId: "agent-1",
      action: "agent.created",
      status: "succeeded",
      at: NOW
    }]
  };
}

function governanceSnapshot() {
  return {
    schemaVersion: "1",
    documentType: "governance-administration-snapshot",
    domain: "governance",
    revision: 7,
    attestations: [{
      attestationId: "attestation-1",
      title: "Recovery exercise",
      description: "Operator-authored evidence statement.",
      owner: "Platform team",
      status: "pending",
      dueAt: EXPIRES,
      revision: 2,
      createdAt: NOW,
      updatedAt: LATER
    }],
    risks: [{
      riskId: "risk-1",
      title: "Availability dependency",
      description: "Operator-authored risk statement.",
      owner: "Service team",
      status: "mitigating",
      likelihood: "moderate",
      impact: "high",
      reviewAt: EXPIRES,
      revision: 3,
      createdAt: NOW,
      updatedAt: LATER
    }],
    changes: [{
      changeId: "change-2",
      resourceType: "risk",
      resourceId: "risk-1",
      action: "risk.updated",
      status: "succeeded",
      at: LATER
    }]
  };
}

function agentPrompt() {
  return {
    schemaVersion: "1",
    documentType: "agent-prompt",
    promptId: "prompt-1",
    agentId: "agent-1",
    version: 1,
    title: "Initial operating prompt",
    state: "active",
    body: "Use only the explicitly granted capabilities. Ask an operator before taking an external action.",
    revision: 2,
    createdAt: NOW,
    updatedAt: NOW
  };
}

const COMMAND_INPUTS = Object.freeze({
  "agent.create": { displayName: "Triage agent", kind: "interactive", capabilities: ["alerts:read"] },
  "agent.update": { agentId: "agent-1", displayName: "Updated triage agent" },
  "agent.pause": { agentId: "agent-1" },
  "agent.resume": { agentId: "agent-1" },
  "agent.archive": { agentId: "agent-1" },
  "agent.restore": { agentId: "agent-1" },
  "agent.remove": { agentId: "agent-1" },
  "prompt.revise": { agentId: "agent-1", title: "Revision two", body: "Stay within the assigned scope.", basePromptId: "prompt-1" },
  "prompt.activate": { promptId: "prompt-2" },
  "prompt.archive": { promptId: "prompt-1" },
  "enrollment.issue": { agentId: "agent-1", expiresInSeconds: 600 },
  "enrollment.revoke": { enrollmentId: "enrollment-1" },
  "attestation.create": { title: "Recovery exercise", owner: "Platform team", dueAt: EXPIRES },
  "attestation.update": { attestationId: "attestation-1", owner: "Service team" },
  "attestation.transition": { attestationId: "attestation-1", status: "attested", note: "Reviewed by the assigned owner." },
  "attestation.archive": { attestationId: "attestation-1" },
  "attestation.restore": { attestationId: "attestation-1" },
  "attestation.remove": { attestationId: "attestation-1" },
  "risk.create": { title: "Availability dependency", likelihood: "moderate", impact: "high" },
  "risk.update": { riskId: "risk-1", reviewAt: EXPIRES },
  "risk.transition": { riskId: "risk-1", status: "accepted", note: "Accepted by the accountable owner." },
  "risk.archive": { riskId: "risk-1" },
  "risk.restore": { riskId: "risk-1" },
  "risk.remove": { riskId: "risk-1" }
});

test("administration runtime is UMD-compatible and the checked-in schema is parseable", () => {
  const schema = require("../contracts/administration.v1.schema.json");
  assert.equal(AdministrationRuntime.VERSION, "1");
  assert.equal(AdministrationRuntime.COMMANDS.length, 24);
  assert.deepEqual([...AdministrationRuntime.DOMAINS], ["agents", "governance"]);
  assert.equal(schema.$id, "administration.v1.schema.json");
  assert.equal(schema.$defs.promptMetadata.additionalProperties, false);
  assert.equal(schema.$defs.promptMetadata.properties.body, undefined);
  assert.equal(globalThis.SocConsoleAdministrationRuntime, AdministrationRuntime);
});

test("snapshots are strict, immutable, and separated by administration domain", () => {
  const agentRequest = snapshotRequest("agents", 3);
  const agents = AdministrationRuntime.validateSnapshot(agentSnapshot(), agentRequest);
  assert.equal(agents.domain, "agents");
  assert.equal(Object.isFrozen(agents), true);
  assert.equal(Object.isFrozen(agents.prompts[0]), true);
  assert.equal(Object.prototype.hasOwnProperty.call(agents.prompts[0], "body"), false);

  const leakedPrompt = agentSnapshot();
  leakedPrompt.prompts[0].body = "This must not be present in a snapshot.";
  assert.throws(() => AdministrationRuntime.validateSnapshot(leakedPrompt), /unsupported key/);

  const wrongAgentCollection = agentSnapshot();
  wrongAgentCollection.risks = [];
  assert.throws(() => AdministrationRuntime.validateSnapshot(wrongAgentCollection), /unsupported key/);

  const governance = AdministrationRuntime.validateSnapshot(governanceSnapshot(), snapshotRequest("governance"));
  assert.equal(governance.domain, "governance");
  assert.equal(governance.attestations[0].status, "pending");
  assert.equal(Object.prototype.hasOwnProperty.call(governance, "prompts"), false);

  const wrongGovernanceCollection = governanceSnapshot();
  wrongGovernanceCollection.prompts = [];
  assert.throws(() => AdministrationRuntime.validateSnapshot(wrongGovernanceCollection), /unsupported key/);
  assert.throws(
    () => AdministrationRuntime.validateSnapshot(governanceSnapshot(), snapshotRequest("agents")),
    /domain must match/
  );

  const orphaned = agentSnapshot();
  orphaned.prompts[0].agentId = "agent-missing";
  assert.throws(() => AdministrationRuntime.validateSnapshot(orphaned), /unknown agentId/);
});

test("prompt bodies require the dedicated retrieval contract", () => {
  const request = AdministrationRuntime.validatePromptRequest(promptRequest());
  const prompt = AdministrationRuntime.validatePrompt(agentPrompt(), request);
  assert.equal(prompt.body.startsWith("Use only"), true);
  assert.equal(Object.isFrozen(prompt), true);

  const mismatch = agentPrompt();
  mismatch.promptId = "prompt-2";
  assert.throws(() => AdministrationRuntime.validatePrompt(mismatch, request), /must match its request/);

  const markupField = agentPrompt();
  markupField.innerHTML = "<p>unsafe</p>";
  assert.throws(() => AdministrationRuntime.validatePrompt(markupField), /unsupported key/);
  assert.throws(
    () => AdministrationRuntime.validatePrompt({ ...agentPrompt(), body: "value\u0000with-control" }),
    /plain text/
  );
});

test("the command vocabulary is closed and every input carries an optimistic domain revision", () => {
  assert.deepEqual([...AdministrationRuntime.COMMANDS].sort(), Object.keys(COMMAND_INPUTS).sort());
  for (const [command, input] of Object.entries(COMMAND_INPUTS)) {
    const request = AdministrationRuntime.validateCommandRequest(commandRequest(command, input));
    assert.equal(request.command, command);
    assert.equal(request.expectedRevision, 2);
    assert.equal(Object.isFrozen(request.input), true);
    assert.equal(AdministrationRuntime.commandDomain(command), command.startsWith("agent.")
      || command.startsWith("prompt.") || command.startsWith("enrollment.") ? "agents" : "governance");
  }

  assert.throws(
    () => AdministrationRuntime.validateCommandRequest(commandRequest("agent.delete-everything", { agentId: "agent-1" })),
    /must be one of/
  );
  assert.throws(
    () => AdministrationRuntime.validateCommandRequest(commandRequest("agent.update", { agentId: "agent-1" })),
    /at least one mutable field/
  );
  assert.throws(
    () => AdministrationRuntime.validateCommandRequest({
      ...commandRequest("agent.create", COMMAND_INPUTS["agent.create"]),
      expectedRevision: undefined
    }),
    /expectedRevision/
  );
  const secretShapedInput = { ...COMMAND_INPUTS["agent.create"] };
  secretShapedInput[["api", "Token"].join("")] = "must-never-enter-the-contract";
  assert.throws(
    () => AdministrationRuntime.validateCommandRequest(commandRequest("agent.create", secretShapedInput)),
    /unsupported key/
  );
});

test("one-time material is accepted only for enrollment issue and can be omitted on replay", () => {
  const request = commandRequest("enrollment.issue", COMMAND_INPUTS["enrollment.issue"]);
  const result = {
    schemaVersion: "1",
    documentType: "administration-command-result",
    requestId: request.requestId,
    command: request.command,
    status: "succeeded",
    completedAt: LATER,
    output: {
      enrollmentId: "enrollment-2",
      agentId: "agent-1",
      state: "issued",
      revision: 3,
      oneTimeCredential: {
        value: "display-exactly-once-to-the-authorized-operator",
        expiresAt: EXPIRES,
        purpose: "agent-enrollment"
      }
    }
  };
  const normalized = AdministrationRuntime.validateCommandResult(result, request);
  assert.equal(normalized.output.oneTimeCredential.purpose, "agent-enrollment");

  const replay = clone(result);
  delete replay.output.oneTimeCredential;
  assert.equal(AdministrationRuntime.validateCommandResult(replay, request).output.state, "issued");

  const agentCreate = commandRequest("agent.create", COMMAND_INPUTS["agent.create"]);
  const leaked = {
    ...result,
    requestId: agentCreate.requestId,
    command: agentCreate.command,
    output: {
      agentId: "agent-2",
      state: "active",
      revision: 3,
      oneTimeCredential: result.output.oneTimeCredential
    }
  };
  assert.throws(() => AdministrationRuntime.validateCommandResult(leaked, agentCreate), /unsupported key/);

  const persistedLeak = agentSnapshot();
  persistedLeak.enrollments[0].oneTimeCredential = result.output.oneTimeCredential;
  assert.throws(() => AdministrationRuntime.validateSnapshot(persistedLeak), /unsupported key/);

  const stale = clone(result);
  stale.output.revision = request.expectedRevision;
  assert.throws(() => AdministrationRuntime.validateCommandResult(stale, request), /must advance expectedRevision/);
});

test("command results correlate IDs, transitions, timestamps, and errors with their request", () => {
  const transition = commandRequest("risk.transition", COMMAND_INPUTS["risk.transition"]);
  const result = {
    schemaVersion: "1",
    documentType: "administration-command-result",
    requestId: transition.requestId,
    command: transition.command,
    status: "succeeded",
    completedAt: LATER,
    output: { riskId: "risk-1", state: "accepted", revision: 3 }
  };
  assert.equal(AdministrationRuntime.validateCommandResult(result, transition).output.state, "accepted");
  assert.throws(
    () => AdministrationRuntime.validateCommandResult({ ...result, output: { ...result.output, state: "closed" } }, transition),
    /match the requested risk status/
  );

  const failed = {
    schemaVersion: "1",
    documentType: "administration-command-result",
    requestId: transition.requestId,
    command: transition.command,
    status: "conflict",
    completedAt: LATER,
    error: {
      code: "revision-conflict",
      message: "The administration snapshot changed.",
      field: "expectedRevision",
      retryable: true
    }
  };
  assert.equal(AdministrationRuntime.validateCommandResult(failed, transition).error.code, "revision-conflict");
  assert.throws(() => AdministrationRuntime.validateCommandResult(result), /requires its command request/);
});

test("provider wrappers validate all requests and responses without widening the host boundary", async () => {
  const calls = [];
  let disposed = false;
  const source = {
    schemaVersion: "1",
    id: "reference-administration",
    getSnapshot(request) {
      calls.push(request);
      return request.domain === "agents" ? agentSnapshot() : governanceSnapshot();
    },
    getPrompt(request) {
      calls.push(request);
      return agentPrompt();
    },
    execute(request) {
      calls.push(request);
      return {
        schemaVersion: "1",
        documentType: "administration-command-result",
        requestId: request.requestId,
        command: request.command,
        status: "succeeded",
        completedAt: LATER,
        output: { riskId: request.input.riskId, state: request.input.status, revision: request.expectedRevision + 1 }
      };
    },
    dispose() { disposed = true; }
  };
  const provider = AdministrationRuntime.validateProvider(source);
  assert.equal(Object.isFrozen(provider), true);
  assert.equal((await provider.getSnapshot(snapshotRequest("governance"))).domain, "governance");
  assert.equal((await provider.getPrompt(promptRequest())).promptId, "prompt-1");
  const transition = commandRequest("risk.transition", COMMAND_INPUTS["risk.transition"]);
  assert.equal((await provider.execute(transition)).output.state, "accepted");
  assert.equal(calls.every(Object.isFrozen), true);
  await provider.dispose();
  assert.equal(disposed, true);

  globalThis.SOC_CONSOLE_ADMINISTRATION = source;
  try {
    assert.equal(AdministrationRuntime.resolveProvider().id, "reference-administration");
  } finally {
    delete globalThis.SOC_CONSOLE_ADMINISTRATION;
  }
  assert.equal(AdministrationRuntime.resolveProvider(), null);
  assert.throws(() => AdministrationRuntime.resolveProvider("invalid-name!"), /global name/);
});

test("administration CLI validates collections and correlated results", () => {
  const documents = [agentSnapshot(), governanceSnapshot(), agentPrompt()];
  assert.equal(AdministrationValidator.validateDocuments(documents).length, 3);
  assert.deepEqual(
    AdministrationValidator.parseArguments(["--type", "snapshot", "--request", "request.json", "snapshot.json"]),
    { type: "snapshot", request: "request.json", files: ["snapshot.json"] }
  );

  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(temporaryRoot, "bb-soc-administration-contract-"));
  try {
    const snapshotFile = path.join(directory, "snapshot.json");
    fs.writeFileSync(snapshotFile, JSON.stringify(agentSnapshot()), "utf8");
    const run = spawnSync(process.execPath, [path.resolve(__dirname, "../tools/validate-administration.js"), snapshotFile], {
      encoding: "utf8"
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /administration validation passed: 1 document/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
