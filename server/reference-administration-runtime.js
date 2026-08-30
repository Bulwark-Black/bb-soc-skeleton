"use strict";

// REFERENCE LOOPBACK MODE ONLY. This provides a concrete, auditable example of
// the closed administration contract; production deployments must replace its
// loopback identity with application authentication and per-action RBAC.

const crypto = require("node:crypto");
const AdministrationContract = require("../public/administration-contract");
const {
  ReferenceAdministrationStore,
  clone,
  hashCredential,
  stableId
} = require("./reference-administration-store");

const FUTURE_SKEW_MS = 5 * 60 * 1000;
const INTERNAL_ID = /^(?:agent|enrollment)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

class ReferenceAdministrationError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "ReferenceAdministrationError";
    this.code = code;
    this.status = options.status || 400;
    this.field = options.field;
    this.retryable = options.retryable === true;
  }
}

function at(clock) {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError("Administration clock is invalid.");
  return value;
}

function latestMutationTime(state) {
  if (!state) return Number.NEGATIVE_INFINITY;
  let latest = Number.NEGATIVE_INFINITY;
  const consider = (value) => {
    if (typeof value !== "string") return;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) latest = Math.max(latest, parsed);
  };
  for (const agent of state.agents || []) {
    consider(agent.createdAt); consider(agent.updatedAt); consider(agent.lastSeenAt);
  }
  for (const prompt of state.prompts || []) { consider(prompt.createdAt); consider(prompt.updatedAt); }
  for (const enrollment of state.enrollments || []) {
    consider(enrollment.issuedAt); consider(enrollment.connectedAt); consider(enrollment.revokedAt);
  }
  for (const item of [...(state.attestations || []), ...(state.risks || [])]) {
    consider(item.createdAt); consider(item.updatedAt);
  }
  for (const change of state.changes || []) consider(change.at);
  for (const tombstone of state.tombstones || []) consider(tombstone.removedAt);
  for (const cached of state.commandResults || []) consider(cached.at);
  return latest;
}

function completedAt(clock, requestedAt, state) {
  return new Date(Math.max(at(clock).getTime(), Date.parse(requestedAt), latestMutationTime(state))).toISOString();
}

function hash(value) { return crypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex"); }
function credential() { return crypto.randomBytes(32).toString("base64url"); }
function trim(items, maximum) { if (items.length > maximum) items.splice(0, items.length - maximum); }

function isPlainDataRecord(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) return false;
  return ownKeys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return Boolean(descriptor) && !descriptor.get && !descriptor.set;
  });
}

function isRfc3339(value) {
  const match = typeof value === "string"
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value)
    : null;
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1]
    && hour <= 23 && minute <= 59 && second <= 59 && offsetHour <= 23 && offsetMinute <= 59
    && !Number.isNaN(Date.parse(value));
}

function credentialMatches(expectedHash, rawCredential) {
  const candidate = typeof rawCredential === "string" && /^[A-Za-z0-9_-]{43}$/.test(rawCredential)
    ? hashCredential(rawCredential)
    : "0".repeat(64);
  return crypto.timingSafeEqual(Buffer.from(expectedHash, "hex"), Buffer.from(candidate, "hex"));
}

function resourceFor(request) {
  const input = request.input;
  if (request.command.startsWith("agent.")) return { type: "agent", id: input.agentId || request.requestId };
  if (request.command.startsWith("prompt.")) return { type: "prompt", id: input.promptId || request.requestId };
  if (request.command.startsWith("enrollment.")) return { type: "enrollment", id: input.enrollmentId || request.requestId };
  if (request.command.startsWith("attestation.")) return { type: "attestation", id: input.attestationId || request.requestId };
  return { type: "risk", id: input.riskId || request.requestId };
}

function actionFor(command) {
  const verb = command.slice(command.indexOf(".") + 1);
  const past = {
    create: "created", update: "updated", pause: "paused", resume: "resumed", archive: "archived",
    restore: "restored", remove: "removed", revise: "revised", activate: "activated",
    issue: "issued", revoke: "revoked", transition: "transitioned"
  };
  return command.slice(0, command.indexOf(".")) + "." + past[verb];
}

function errorStatus(code) {
  if (["revision-conflict", "already-exists", "dependency-conflict"].includes(code)) return "conflict";
  if (["validation-failed", "not-authorized", "transition-invalid"].includes(code)) return "rejected";
  return "failed";
}

function safeCachedResult(result) {
  const safe = clone(result);
  if (safe.output) delete safe.output.oneTimeCredential;
  return safe;
}

function addChange(state, domain, resourceType, resourceId, action, status, now, message) {
  state.changes.push({
    changeId: stableId("change"), domain, resourceType, resourceId, action,
    status, at: now, message
  });
  trim(state.changes, 1000);
}

function cacheResult(state, request, requestHash, result, now) {
  state.commandResults.push({
    requestId: request.requestId,
    requestHash,
    command: request.command,
    result: safeCachedResult(result),
    at: now
  });
  trim(state.commandResults, 1000);
}

function changedFields(input, identityKeys) {
  return Object.keys(input).filter((key) => !identityKeys.includes(key)).map((key) => key.replace(/[A-Z]/g, (character) => "-" + character.toLowerCase()));
}

function mutationMessage(fallback, input) {
  if (!input || input.note === undefined || input.note === "") return fallback;
  const combined = `${fallback} Note: ${input.note}`;
  if (combined.length <= 500) return combined;
  const digest = crypto.createHash("sha256").update(input.note, "utf8").digest("hex");
  return `${fallback} Transition note retained by SHA-256 digest ${digest}.`;
}

function commandResult(request, completed, output) {
  return {
    schemaVersion: "1",
    documentType: "administration-command-result",
    requestId: request.requestId,
    command: request.command,
    status: "succeeded",
    completedAt: completed,
    output
  };
}

function publicChange(change) {
  const result = {
    changeId: change.changeId,
    resourceType: change.resourceType,
    resourceId: change.resourceId,
    action: change.action,
    status: change.status,
    at: change.at
  };
  if (change.message) result.message = change.message;
  return result;
}

function publicAgent(agent) {
  const result = {
    agentId: agent.agentId,
    displayName: agent.displayName,
    kind: agent.kind,
    capabilities: agent.capabilities,
    state: agent.state,
    activePromptId: agent.activePromptId,
    lastSeenAt: agent.lastSeenAt,
    revision: agent.revision,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt
  };
  if (agent.description !== undefined) result.description = agent.description;
  if (agent.provider !== undefined) result.provider = agent.provider;
  if (agent.model !== undefined) result.model = agent.model;
  return result;
}

function publicPrompt(prompt) {
  return {
    promptId: prompt.promptId,
    agentId: prompt.agentId,
    version: prompt.version,
    title: prompt.title,
    state: prompt.state,
    revision: prompt.revision,
    createdAt: prompt.createdAt,
    updatedAt: prompt.updatedAt
  };
}

function publicEnrollment(enrollment, now) {
  const state = effectiveEnrollmentState(enrollment, now);
  return {
    enrollmentId: enrollment.enrollmentId,
    agentId: enrollment.agentId,
    state,
    issuedAt: enrollment.issuedAt,
    expiresAt: enrollment.expiresAt,
    connectedAt: enrollment.connectedAt,
    revokedAt: enrollment.revokedAt,
    revision: enrollment.revision
  };
}

function effectiveEnrollmentState(enrollment, now) {
  return enrollment.state === "issued" && Date.parse(enrollment.expiresAt) <= now.getTime()
    ? "expired"
    : enrollment.state;
}

function publicAttestation(item) {
  const result = {
    attestationId: item.attestationId,
    title: item.title,
    status: item.status,
    dueAt: item.dueAt,
    revision: item.revision,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
  if (item.description !== undefined) result.description = item.description;
  if (item.owner !== undefined) result.owner = item.owner;
  return result;
}

function publicRisk(item) {
  const result = {
    riskId: item.riskId,
    title: item.title,
    status: item.status,
    likelihood: item.likelihood,
    impact: item.impact,
    reviewAt: item.reviewAt,
    revision: item.revision,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
  if (item.description !== undefined) result.description = item.description;
  if (item.owner !== undefined) result.owner = item.owner;
  return result;
}

class ReferenceAdministrationRuntime {
  constructor(options) {
    if (!options || typeof options !== "object") throw new TypeError("ReferenceAdministrationRuntime options are required.");
    this.clock = typeof options.clock === "function" ? options.clock : () => new Date();
    this.store = options.store || new ReferenceAdministrationStore({ directory: options.stateDirectory, clock: this.clock });
  }

  dispose() { if (this.store && typeof this.store.close === "function") this.store.close(); }
  getState() { return this.store.snapshot(); }

  getSnapshot(value) {
    const request = AdministrationContract.validateSnapshotRequest(value);
    const state = this.store.snapshot();
    const now = at(this.clock);
    const domainChanges = state.changes.filter((change) => change.domain === request.domain).slice(-500).map(publicChange);
    const document = request.domain === "agents" ? {
      schemaVersion: "1",
      documentType: "agent-administration-snapshot",
      domain: "agents",
      revision: state.revision,
      agents: state.agents.map(publicAgent),
      prompts: state.prompts.map(publicPrompt),
      enrollments: state.enrollments.map((item) => publicEnrollment(item, now)),
      changes: domainChanges
    } : {
      schemaVersion: "1",
      documentType: "governance-administration-snapshot",
      domain: "governance",
      revision: state.revision,
      attestations: state.attestations.map(publicAttestation),
      risks: state.risks.map(publicRisk),
      changes: domainChanges
    };
    return AdministrationContract.validateSnapshot(document, request);
  }

  getPrompt(value) {
    const request = AdministrationContract.validatePromptRequest(value);
    const prompt = this.store.snapshot().prompts.find((entry) => entry.promptId === request.promptId);
    if (!prompt) throw new ReferenceAdministrationError("not-found", "The requested prompt revision was not found.", { status: 404 });
    return AdministrationContract.validatePrompt({
      schemaVersion: "1",
      documentType: "agent-prompt",
      ...publicPrompt(prompt),
      body: prompt.body
    }, request);
  }

  execute(value) {
    const request = AdministrationContract.validateCommandRequest(value);
    const requestHash = hash(request);
    const snapshot = this.store.snapshot();
    const prior = snapshot.commandResults.find((entry) => entry.requestId === request.requestId);
    if (prior) {
      if (prior.requestHash !== requestHash) return this.failure(request, "already-exists", "requestId was already used for a different command.");
      return AdministrationContract.validateCommandResult(prior.result, request);
    }
    if (Date.parse(request.requestedAt) > at(this.clock).getTime() + FUTURE_SKEW_MS) {
      throw new TypeError("Administration command requestedAt is too far in the future.");
    }
    if (request.expectedRevision !== snapshot.revision) {
      return this.failure(request, "revision-conflict", "Administration revision changed; refresh and review before retrying.");
    }
    try {
      const result = this.dispatch(request, requestHash);
      return AdministrationContract.validateCommandResult(result, request);
    } catch (error) {
      if (!(error instanceof ReferenceAdministrationError)) throw error;
      return this.failure(request, error.code, error.message, error, requestHash);
    }
  }

  failure(request, code, message, source = {}, requestHash) {
    const snapshot = this.store.snapshot();
    const completed = completedAt(this.clock, request.requestedAt, snapshot);
    const result = {
      schemaVersion: "1",
      documentType: "administration-command-result",
      requestId: request.requestId,
      command: request.command,
      status: errorStatus(code),
      completedAt: completed,
      error: { code, message, retryable: source.retryable === true }
    };
    if (source.field) result.error.field = source.field;
    const validated = AdministrationContract.validateCommandResult(result, request);
    if (requestHash !== undefined) {
      const target = resourceFor(request);
      this.store.transact({
        command: request.command,
        actor: "loopback:operator",
        resourceType: target.type,
        resourceId: target.id,
        requestId: request.requestId,
        changedFields: []
      }, (state) => {
        addChange(state, AdministrationContract.commandDomain(request.command), target.type, target.id,
          actionFor(request.command), validated.status, completed, message);
        cacheResult(state, request, requestHash, validated, completed);
      });
    }
    return validated;
  }

  dispatch(request, requestHash) {
    if (request.command === "agent.create") return this.createAgent(request, requestHash);
    if (request.command === "agent.update") return this.updateAgent(request, requestHash);
    if (["agent.pause", "agent.resume", "agent.archive", "agent.restore", "agent.remove"].includes(request.command)) {
      return this.agentLifecycle(request, requestHash);
    }
    if (request.command === "prompt.revise") return this.revisePrompt(request, requestHash);
    if (["prompt.activate", "prompt.archive"].includes(request.command)) return this.promptLifecycle(request, requestHash);
    if (request.command === "enrollment.issue") return this.issueEnrollment(request, requestHash);
    if (request.command === "enrollment.revoke") return this.revokeEnrollment(request, requestHash);
    if (request.command === "attestation.create") return this.createAttestation(request, requestHash);
    if (request.command.startsWith("attestation.")) return this.attestationMutation(request, requestHash);
    if (request.command === "risk.create") return this.createRisk(request, requestHash);
    return this.riskMutation(request, requestHash);
  }

  commit(request, requestHash, metadata, mutate) {
    const snapshot = this.store.snapshot();
    const now = completedAt(this.clock, request.requestedAt, snapshot);
    let result;
    const transaction = this.store.transact({
      command: request.command,
      actor: "loopback:operator",
      resourceType: metadata.resourceType,
      resourceId: metadata.resourceId,
      requestId: request.requestId,
      changedFields: metadata.changedFields
    }, (state, nextRevision) => {
      const output = mutate(state, now, nextRevision);
      result = AdministrationContract.validateCommandResult(commandResult(request, now, output), request);
      addChange(state, AdministrationContract.commandDomain(request.command), metadata.resourceType,
        metadata.resourceId, actionFor(request.command), "succeeded", now, metadata.message);
      cacheResult(state, request, requestHash, result, now);
    });
    if (!result || result.output.revision !== transaction.revision) {
      throw new Error("Administration transaction revision did not match its command result.");
    }
    return result;
  }

  createAgent(request, requestHash) {
    const agentId = stableId("agent");
    return this.commit(request, requestHash, {
      resourceType: "agent", resourceId: agentId,
      changedFields: changedFields(request.input, []), message: "Agent registration created."
    }, (state, now, revision) => {
      state.agents.push({
        agentId,
        displayName: request.input.displayName,
        ...(request.input.description !== undefined ? { description: request.input.description } : {}),
        kind: request.input.kind,
        ...(request.input.provider !== undefined ? { provider: request.input.provider } : {}),
        ...(request.input.model !== undefined ? { model: request.input.model } : {}),
        capabilities: request.input.capabilities,
        state: "active",
        activePromptId: null,
        lastSeenAt: null,
        revision,
        createdAt: now,
        updatedAt: now
      });
      return { agentId, state: "active", revision };
    });
  }

  updateAgent(request, requestHash) {
    const current = this.store.snapshot().agents.find((entry) => entry.agentId === request.input.agentId);
    if (!current) throw new ReferenceAdministrationError("not-found", "Agent was not found.", { status: 404 });
    if (current.state === "archived") throw new ReferenceAdministrationError("transition-invalid", "Restore the agent before editing it.", { status: 422 });
    return this.commit(request, requestHash, {
      resourceType: "agent", resourceId: current.agentId,
      changedFields: changedFields(request.input, ["agentId"]), message: "Agent metadata updated."
    }, (state, now, revision) => {
      const agent = state.agents.find((entry) => entry.agentId === current.agentId);
      for (const key of ["displayName", "description", "kind", "provider", "model", "capabilities"]) {
        if (request.input[key] !== undefined) agent[key] = clone(request.input[key]);
      }
      agent.revision = revision;
      agent.updatedAt = now;
      return { agentId: agent.agentId, state: agent.state, revision };
    });
  }

  agentLifecycle(request, requestHash) {
    const snapshot = this.store.snapshot();
    const current = snapshot.agents.find((entry) => entry.agentId === request.input.agentId);
    if (!current) throw new ReferenceAdministrationError("not-found", "Agent was not found.", { status: 404 });
    const desired = { "agent.pause": "paused", "agent.resume": "active", "agent.archive": "archived", "agent.restore": "active" }[request.command];
    const allowed = {
      "agent.pause": current.state === "active",
      "agent.resume": current.state === "paused",
      "agent.archive": current.state !== "archived",
      "agent.restore": current.state === "archived",
      "agent.remove": current.state === "archived"
    }[request.command];
    if (!allowed) throw new ReferenceAdministrationError("transition-invalid", "Agent lifecycle transition is not allowed from its current state.", { status: 422 });
    if (request.command === "agent.remove"
        && (snapshot.prompts.some((entry) => entry.agentId === current.agentId)
          || snapshot.enrollments.some((entry) => entry.agentId === current.agentId))) {
      throw new ReferenceAdministrationError(
        "dependency-conflict",
        "Agent removal is blocked while retained prompt or enrollment records depend on it.",
        { status: 409 }
      );
    }
    return this.commit(request, requestHash, {
      resourceType: "agent", resourceId: current.agentId,
      changedFields: request.command === "agent.remove" ? ["removed"]
        : ["agent.pause", "agent.archive"].includes(request.command) ? ["state", "enrollments"] : ["state"],
      message: request.command === "agent.remove" ? "Archived agent removed; audit tombstone retained." : "Agent lifecycle updated."
    }, (state, now, revision) => {
      const index = state.agents.findIndex((entry) => entry.agentId === current.agentId);
      if (request.command === "agent.remove") {
        state.agents.splice(index, 1);
        state.tombstones.push({
          tombstoneId: stableId("tombstone"), resourceType: "agent", resourceId: current.agentId,
          removedAt: now, finalRevision: revision
        });
        return { agentId: current.agentId, state: "removed", revision };
      }
      const agent = state.agents[index];
      agent.state = desired;
      agent.revision = revision;
      agent.updatedAt = now;
      if (["agent.pause", "agent.archive"].includes(request.command)) {
        state.enrollments.filter((entry) => entry.agentId === agent.agentId && !["revoked", "expired"].includes(entry.state)).forEach((entry) => {
          if (effectiveEnrollmentState(entry, new Date(now)) === "expired") entry.state = "expired";
          else {
            entry.state = "revoked";
            entry.revokedAt = now;
            addChange(state, "agents", "enrollment", entry.enrollmentId, "enrollment.revoked", "succeeded", now,
              "Agent lifecycle invalidated the enrollment bootstrap path.");
          }
          entry.revision = revision;
        });
      }
      return { agentId: agent.agentId, state: agent.state, revision };
    });
  }

  revisePrompt(request, requestHash) {
    const snapshot = this.store.snapshot();
    const agent = snapshot.agents.find((entry) => entry.agentId === request.input.agentId);
    if (!agent) throw new ReferenceAdministrationError("not-found", "Agent was not found.", { status: 404 });
    if (agent.state === "archived") {
      throw new ReferenceAdministrationError("transition-invalid", "Restore the agent before creating a prompt revision.", { status: 422 });
    }
    if (request.input.basePromptId !== undefined) {
      const base = snapshot.prompts.find((entry) => entry.promptId === request.input.basePromptId);
      if (!base || base.agentId !== agent.agentId) throw new ReferenceAdministrationError("dependency-conflict", "Base prompt does not belong to this agent.", { status: 409 });
    }
    const promptId = stableId("prompt");
    const version = snapshot.prompts.filter((entry) => entry.agentId === agent.agentId).reduce((maximum, entry) => Math.max(maximum, entry.version), 0) + 1;
    return this.commit(request, requestHash, {
      resourceType: "prompt", resourceId: promptId,
      changedFields: ["title", "body"], message: "Immutable prompt draft created."
    }, (state, now, revision) => {
      state.prompts.push({
        promptId, agentId: agent.agentId, version, title: request.input.title, state: "draft",
        body: request.input.body, revision, createdAt: now, updatedAt: now
      });
      return { promptId, agentId: agent.agentId, version, state: "draft", revision };
    });
  }

  promptLifecycle(request, requestHash) {
    const snapshot = this.store.snapshot();
    const current = snapshot.prompts.find((entry) => entry.promptId === request.input.promptId);
    if (!current) throw new ReferenceAdministrationError("not-found", "Prompt revision was not found.", { status: 404 });
    const owningAgent = snapshot.agents.find((entry) => entry.agentId === current.agentId);
    if (!owningAgent || owningAgent.state === "archived") {
      throw new ReferenceAdministrationError("transition-invalid", "Restore the owning agent before changing prompt state.", { status: 422 });
    }
    if (request.command === "prompt.activate" && current.state !== "draft") {
      throw new ReferenceAdministrationError("transition-invalid", "Only a draft prompt can be activated.", { status: 422 });
    }
    if (request.command === "prompt.archive" && current.state === "archived") {
      throw new ReferenceAdministrationError("transition-invalid", "Prompt revision is already archived.", { status: 422 });
    }
    return this.commit(request, requestHash, {
      resourceType: "prompt", resourceId: current.promptId,
      changedFields: ["state", "agent-prompt-head"], message: request.command === "prompt.activate" ? "Prompt revision activated." : "Prompt revision archived."
    }, (state, now, revision) => {
      const prompt = state.prompts.find((entry) => entry.promptId === current.promptId);
      const agent = state.agents.find((entry) => entry.agentId === current.agentId);
      if (request.command === "prompt.activate") {
        state.prompts.filter((entry) => entry.agentId === current.agentId && entry.state === "active").forEach((entry) => {
          entry.state = "archived";
          entry.revision = revision;
          entry.updatedAt = now;
          addChange(state, "agents", "prompt", entry.promptId, "prompt.archived", "succeeded", now,
            "Prompt revision was superseded by an activated revision.");
        });
        prompt.state = "active";
        agent.activePromptId = prompt.promptId;
      } else {
        prompt.state = "archived";
        if (agent.activePromptId === prompt.promptId) agent.activePromptId = null;
      }
      prompt.revision = revision;
      prompt.updatedAt = now;
      agent.revision = revision;
      agent.updatedAt = now;
      return { promptId: prompt.promptId, agentId: prompt.agentId, version: prompt.version, state: prompt.state, revision };
    });
  }

  issueEnrollment(request, requestHash) {
    const snapshot = this.store.snapshot();
    const agent = snapshot.agents.find((entry) => entry.agentId === request.input.agentId);
    if (!agent) throw new ReferenceAdministrationError("not-found", "Agent was not found.", { status: 404 });
    if (agent.state !== "active") {
      throw new ReferenceAdministrationError("transition-invalid", "Only an active agent can receive a new enrollment.", { status: 422 });
    }
    const enrollmentId = stableId("enrollment");
    const rawCredential = credential();
    const requestedSeconds = request.input.expiresInSeconds;
    return this.commit(request, requestHash, {
      resourceType: "enrollment", resourceId: enrollmentId,
      changedFields: ["state", "expires-at"], message: "One-time agent enrollment issued."
    }, (state, now, revision) => {
      state.enrollments.filter((entry) => entry.agentId === agent.agentId && !["revoked", "expired"].includes(entry.state)).forEach((entry) => {
        if (effectiveEnrollmentState(entry, new Date(now)) === "expired") entry.state = "expired";
        else {
          entry.state = "revoked";
          entry.revokedAt = now;
          addChange(state, "agents", "enrollment", entry.enrollmentId, "enrollment.revoked", "succeeded", now,
            "A replacement enrollment invalidated the prior bootstrap path.");
        }
        entry.revision = revision;
      });
      const expiresAt = new Date(Date.parse(now) + requestedSeconds * 1000).toISOString();
      state.enrollments.push({
        enrollmentId, agentId: agent.agentId, state: "issued", hash: hashCredential(rawCredential),
        issuedAt: now, expiresAt, connectedAt: null, revokedAt: null, revision
      });
      return {
        enrollmentId, agentId: agent.agentId, state: "issued", revision,
        oneTimeCredential: { value: rawCredential, expiresAt, purpose: "agent-enrollment" }
      };
    });
  }

  revokeEnrollment(request, requestHash) {
    const current = this.store.snapshot().enrollments.find((entry) => entry.enrollmentId === request.input.enrollmentId);
    if (!current) throw new ReferenceAdministrationError("not-found", "Enrollment was not found.", { status: 404 });
    if (["revoked", "expired"].includes(effectiveEnrollmentState(current, at(this.clock)))) {
      throw new ReferenceAdministrationError("transition-invalid", "Enrollment is no longer active.", { status: 422 });
    }
    return this.commit(request, requestHash, {
      resourceType: "enrollment", resourceId: current.enrollmentId,
      changedFields: ["state", "revoked-at"], message: "Agent enrollment revoked."
    }, (state, now, revision) => {
      const enrollment = state.enrollments.find((entry) => entry.enrollmentId === current.enrollmentId);
      enrollment.state = "revoked";
      enrollment.revokedAt = now;
      enrollment.revision = revision;
      return { enrollmentId: enrollment.enrollmentId, agentId: enrollment.agentId, state: "revoked", revision };
    });
  }

  createAttestation(request, requestHash) {
    const attestationId = stableId("attestation");
    return this.commit(request, requestHash, {
      resourceType: "attestation", resourceId: attestationId,
      changedFields: changedFields(request.input, []), message: "Attestation created."
    }, (state, now, revision) => {
      state.attestations.push({
        attestationId, title: request.input.title,
        ...(request.input.description !== undefined ? { description: request.input.description } : {}),
        ...(request.input.owner !== undefined ? { owner: request.input.owner } : {}),
        status: "draft", dueAt: request.input.dueAt === undefined ? null : request.input.dueAt,
        revision, createdAt: now, updatedAt: now
      });
      return { attestationId, state: "draft", revision };
    });
  }

  attestationMutation(request, requestHash) {
    const snapshot = this.store.snapshot();
    const current = snapshot.attestations.find((entry) => entry.attestationId === request.input.attestationId);
    if (!current) throw new ReferenceAdministrationError("not-found", "Attestation was not found.", { status: 404 });
    let state = current.status;
    if (request.command === "attestation.transition") {
      const transitions = { draft: ["pending"], pending: ["attested", "expired"], attested: ["expired"], expired: ["pending"] };
      if (!transitions[current.status] || !transitions[current.status].includes(request.input.status)) {
        throw new ReferenceAdministrationError("transition-invalid", "Attestation status transition is not allowed.", { status: 422 });
      }
      state = request.input.status;
    } else if (request.command === "attestation.archive") {
      if (current.status === "archived") throw new ReferenceAdministrationError("transition-invalid", "Attestation is already archived.", { status: 422 });
      state = "archived";
    } else if (request.command === "attestation.restore") {
      if (current.status !== "archived") throw new ReferenceAdministrationError("transition-invalid", "Only an archived attestation can be restored.", { status: 422 });
      state = "draft";
    } else if (request.command === "attestation.remove" && current.status !== "archived") {
      throw new ReferenceAdministrationError("transition-invalid", "Archive the attestation before removal.", { status: 422 });
    } else if (request.command === "attestation.update" && current.status === "archived") {
      throw new ReferenceAdministrationError("transition-invalid", "Restore the attestation before editing it.", { status: 422 });
    }
    return this.commit(request, requestHash, {
      resourceType: "attestation", resourceId: current.attestationId,
      changedFields: request.command === "attestation.update" ? changedFields(request.input, ["attestationId"])
        : request.command === "attestation.remove" ? ["removed"]
          : request.command === "attestation.transition" && request.input.note !== undefined ? ["status", "transition-note"] : ["status"],
      message: request.command === "attestation.remove" ? "Archived attestation removed; audit tombstone retained."
        : mutationMessage("Attestation updated.", request.input)
    }, (next, now, revision) => {
      const index = next.attestations.findIndex((entry) => entry.attestationId === current.attestationId);
      if (request.command === "attestation.remove") {
        next.attestations.splice(index, 1);
        next.tombstones.push({ tombstoneId: stableId("tombstone"), resourceType: "attestation", resourceId: current.attestationId, removedAt: now, finalRevision: revision });
        return { attestationId: current.attestationId, state: "removed", revision };
      }
      const item = next.attestations[index];
      if (request.command === "attestation.update") for (const key of ["title", "description", "owner", "dueAt"]) {
        if (request.input[key] !== undefined) item[key] = request.input[key];
      }
      else item.status = state;
      item.revision = revision;
      item.updatedAt = now;
      return { attestationId: item.attestationId, state: item.status, revision };
    });
  }

  createRisk(request, requestHash) {
    const riskId = stableId("risk");
    return this.commit(request, requestHash, {
      resourceType: "risk", resourceId: riskId,
      changedFields: changedFields(request.input, []), message: "Risk created."
    }, (state, now, revision) => {
      state.risks.push({
        riskId, title: request.input.title,
        ...(request.input.description !== undefined ? { description: request.input.description } : {}),
        ...(request.input.owner !== undefined ? { owner: request.input.owner } : {}),
        status: "open", likelihood: request.input.likelihood, impact: request.input.impact,
        reviewAt: request.input.reviewAt === undefined ? null : request.input.reviewAt,
        revision, createdAt: now, updatedAt: now
      });
      return { riskId, state: "open", revision };
    });
  }

  riskMutation(request, requestHash) {
    const snapshot = this.store.snapshot();
    const current = snapshot.risks.find((entry) => entry.riskId === request.input.riskId);
    if (!current) throw new ReferenceAdministrationError("not-found", "Risk was not found.", { status: 404 });
    let state = current.status;
    if (request.command === "risk.transition") {
      const transitions = { open: ["mitigating", "accepted"], mitigating: ["accepted", "closed"], accepted: ["mitigating", "closed"], closed: ["open"] };
      if (!transitions[current.status] || !transitions[current.status].includes(request.input.status)) {
        throw new ReferenceAdministrationError("transition-invalid", "Risk status transition is not allowed.", { status: 422 });
      }
      if (request.input.status === "closed" && !request.input.note) {
        throw new ReferenceAdministrationError("validation-failed", "Closing a risk requires a review note.", { status: 422, field: "input.note" });
      }
      state = request.input.status;
    } else if (request.command === "risk.archive") {
      if (current.status === "archived") throw new ReferenceAdministrationError("transition-invalid", "Risk is already archived.", { status: 422 });
      state = "archived";
    } else if (request.command === "risk.restore") {
      if (current.status !== "archived") throw new ReferenceAdministrationError("transition-invalid", "Only an archived risk can be restored.", { status: 422 });
      state = "open";
    } else if (request.command === "risk.remove" && current.status !== "archived") {
      throw new ReferenceAdministrationError("transition-invalid", "Archive the risk before removal.", { status: 422 });
    } else if (request.command === "risk.update" && current.status === "archived") {
      throw new ReferenceAdministrationError("transition-invalid", "Restore the risk before editing it.", { status: 422 });
    }
    return this.commit(request, requestHash, {
      resourceType: "risk", resourceId: current.riskId,
      changedFields: request.command === "risk.update" ? changedFields(request.input, ["riskId"])
        : request.command === "risk.remove" ? ["removed"]
          : request.command === "risk.transition" && request.input.note !== undefined ? ["status", "transition-note"] : ["status"],
      message: request.command === "risk.remove" ? "Archived risk removed; audit tombstone retained."
        : mutationMessage("Risk updated.", request.input)
    }, (next, now, revision) => {
      const index = next.risks.findIndex((entry) => entry.riskId === current.riskId);
      if (request.command === "risk.remove") {
        next.risks.splice(index, 1);
        next.tombstones.push({ tombstoneId: stableId("tombstone"), resourceType: "risk", resourceId: current.riskId, removedAt: now, finalRevision: revision });
        return { riskId: current.riskId, state: "removed", revision };
      }
      const item = next.risks[index];
      if (request.command === "risk.update") for (const key of ["title", "description", "owner", "likelihood", "impact", "reviewAt"]) {
        if (request.input[key] !== undefined) item[key] = request.input[key];
      }
      else item.status = state;
      item.revision = revision;
      item.updatedAt = now;
      return { riskId: item.riskId, state: item.status, revision };
    });
  }

  proveAgentConnection(value, rawCredential) {
    if (!isPlainDataRecord(value, ["schemaVersion", "agentId", "enrollmentId", "observedAt"])) {
      throw new ReferenceAdministrationError("validation-failed", "Agent connection proof has invalid fields.", { status: 400 });
    }
    if (value.schemaVersion !== "1" || !INTERNAL_ID.test(value.agentId) || !value.agentId.startsWith("agent-")
        || !INTERNAL_ID.test(value.enrollmentId) || !value.enrollmentId.startsWith("enrollment-")
        || !isRfc3339(value.observedAt)) {
      throw new ReferenceAdministrationError("validation-failed", "Agent connection proof is invalid.", { status: 400 });
    }
    const snapshot = this.store.snapshot();
    const current = snapshot.enrollments.find((entry) => entry.enrollmentId === value.enrollmentId && entry.agentId === value.agentId);
    const agent = snapshot.agents.find((entry) => entry.agentId === value.agentId);
    const nowDate = at(this.clock);
    const observed = Date.parse(value.observedAt);
    const expectedHash = current && /^[a-f0-9]{64}$/.test(current.hash) ? current.hash : "0".repeat(64);
    const matches = credentialMatches(expectedHash, rawCredential);
    if (!current || !agent || agent.state !== "active" || current.state !== "issued" || !matches
        || Date.parse(current.expiresAt) <= nowDate.getTime() || observed < Date.parse(current.issuedAt)
        || observed >= Date.parse(current.expiresAt) || Math.abs(nowDate.getTime() - observed) > FUTURE_SKEW_MS) {
      throw new ReferenceAdministrationError("not-authorized", "Agent enrollment is invalid, expired, or already used.", { status: 401 });
    }
    const now = new Date(Math.max(nowDate.getTime(), observed, latestMutationTime(snapshot))).toISOString();
    this.store.transact({
      command: "enrollment.connect", actor: "loopback:agent", resourceType: "enrollment",
      resourceId: current.enrollmentId, requestId: current.enrollmentId, changedFields: ["state", "connected-at"]
    }, (state, revision) => {
      const enrollment = state.enrollments.find((entry) => entry.enrollmentId === current.enrollmentId);
      const connectedAgent = state.agents.find((entry) => entry.agentId === current.agentId);
      enrollment.state = "connected";
      enrollment.connectedAt = now;
      enrollment.revision = revision;
      connectedAgent.lastSeenAt = now;
      connectedAgent.updatedAt = now;
      connectedAgent.revision = revision;
    });
    return { schemaVersion: "1", documentType: "agent-connection-result", agentId: current.agentId, enrollmentId: current.enrollmentId, status: "connected", connectedAt: now };
  }
}

module.exports = {
  FUTURE_SKEW_MS,
  ReferenceAdministrationError,
  ReferenceAdministrationRuntime
};
