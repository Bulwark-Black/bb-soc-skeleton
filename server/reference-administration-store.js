"use strict";

// Owner-only persistence for the opt-in loopback administration workbench.
// It is intentionally separate from connector state so enabling management
// workflows never migrates or weakens the connector registry.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SCHEMA_VERSION = "1";
const STATE_FILE = "administration-state.json";
const AUDIT_FILE = "administration-audit.jsonl";
const LOCK_FILE = "administration-runtime.lock";
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_AUDIT_BYTES = 25 * 1024 * 1024;
const RESOURCE_ID = /^(?:agent|prompt|enrollment|attestation|risk|change|tombstone)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const COMMANDS = new Set([
  "agent.create", "agent.update", "agent.pause", "agent.resume", "agent.archive", "agent.restore", "agent.remove",
  "prompt.revise", "prompt.activate", "prompt.archive",
  "enrollment.issue", "enrollment.revoke",
  "attestation.create", "attestation.update", "attestation.transition", "attestation.archive", "attestation.restore", "attestation.remove",
  "risk.create", "risk.update", "risk.transition", "risk.archive", "risk.restore", "risk.remove"
]);
const CHANGE_ACTIONS = new Set([
  "agent.created", "agent.updated", "agent.paused", "agent.resumed", "agent.archived", "agent.restored", "agent.removed",
  "prompt.revised", "prompt.activated", "prompt.archived",
  "enrollment.issued", "enrollment.revoked",
  "attestation.created", "attestation.updated", "attestation.transitioned", "attestation.archived", "attestation.restored", "attestation.removed",
  "risk.created", "risk.updated", "risk.transitioned", "risk.archived", "risk.restored", "risk.removed"
]);
const ERROR_CODES = new Set([
  "validation-failed", "not-authorized", "not-found", "already-exists",
  "revision-conflict", "transition-invalid", "dependency-conflict",
  "provider-unavailable", "internal-error"
]);
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exact(value, keys, label) {
  if (!isRecord(value)) throw new TypeError(label + " must be a plain object.");
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !keys.includes(key)) throw new TypeError(label + " contains an unsupported field.");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set) throw new TypeError(label + " must use data properties.");
  }
}

function text(value, label, maximum = 500, pattern) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
      || (pattern && !pattern.test(value))) throw new TypeError(label + " is invalid.");
  return value;
}

function optionalText(value, label, maximum = 500) {
  if (typeof value !== "string" || value.length > maximum
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new TypeError(label + " is invalid.");
  }
  return value;
}

function timestamp(value, label) {
  const match = typeof value === "string"
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value)
    : null;
  const year = match ? Number(match[1]) : NaN;
  const month = match ? Number(match[2]) : NaN;
  const day = match ? Number(match[3]) : NaN;
  const hour = match ? Number(match[4]) : NaN;
  const minute = match ? Number(match[5]) : NaN;
  const second = match ? Number(match[6]) : NaN;
  const offsetHour = match && match[7] !== undefined ? Number(match[7]) : 0;
  const offsetMinute = match && match[8] !== undefined ? Number(match[8]) : 0;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (!match || month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]
      || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59
      || Number.isNaN(Date.parse(value))) throw new TypeError(label + " must be an RFC 3339 date-time.");
  return value;
}

function nullableTimestamp(value, label) {
  return value === null ? null : timestamp(value, label);
}

function integer(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new TypeError(label + " is invalid.");
  return value;
}

function id(value, label, prefix) {
  const normalized = text(value, label, 128, RESOURCE_ID);
  if (prefix && !normalized.startsWith(prefix + "-")) throw new TypeError(label + " has the wrong resource type.");
  return normalized;
}

function opaqueId(value, label) {
  return text(value, label, 128, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
}

function array(value, label, maximum) {
  if (!Array.isArray(value) || value.length > maximum) throw new TypeError(label + " must be a bounded array.");
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || descriptor.get || descriptor.set) throw new TypeError(label + " must be a dense data array.");
  }
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) {
      throw new TypeError(label + " must not contain custom properties.");
    }
  }
  return value;
}

function unique(items, key, label) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item[key])) throw new TypeError(label + " contains duplicate " + key + " values.");
    seen.add(item[key]);
  }
}

function stringList(value, label, maximum, entryMaximum = 120) {
  const items = array(value, label, maximum).map((entry, index) =>
    text(entry, label + "[" + index + "]", entryMaximum, /^[a-z][a-z0-9:._-]*$/));
  if (new Set(items).size !== items.length) throw new TypeError(label + " contains duplicates.");
  return items;
}

function validatePrompt(value, label) {
  exact(value, ["promptId", "agentId", "version", "title", "state", "body", "revision", "createdAt", "updatedAt"], label);
  id(value.promptId, label + ".promptId", "prompt");
  id(value.agentId, label + ".agentId", "agent");
  if (integer(value.version, label + ".version", 1000000) < 1) throw new TypeError(label + ".version is invalid.");
  text(value.title, label + ".title", 160);
  if (!["draft", "active", "archived"].includes(value.state)) throw new TypeError(label + ".state is invalid.");
  text(value.body, label + ".body", 32768);
  integer(value.revision, label + ".revision");
  timestamp(value.createdAt, label + ".createdAt");
  timestamp(value.updatedAt, label + ".updatedAt");
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) throw new TypeError(label + ".updatedAt precedes createdAt.");
}

function validateEnrollment(value, label) {
  exact(value, ["enrollmentId", "agentId", "state", "hash", "issuedAt", "expiresAt", "connectedAt", "revokedAt", "revision"], label);
  id(value.enrollmentId, label + ".enrollmentId", "enrollment");
  id(value.agentId, label + ".agentId", "agent");
  if (!["issued", "connected", "revoked", "expired"].includes(value.state)) throw new TypeError(label + ".state is invalid.");
  text(value.hash, label + ".hash", 64, /^[a-f0-9]{64}$/);
  timestamp(value.issuedAt, label + ".issuedAt");
  timestamp(value.expiresAt, label + ".expiresAt");
  nullableTimestamp(value.connectedAt, label + ".connectedAt");
  nullableTimestamp(value.revokedAt, label + ".revokedAt");
  integer(value.revision, label + ".revision");
  if (Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)) throw new TypeError(label + ".expiresAt must follow issuedAt.");
  if (value.connectedAt !== null && Date.parse(value.connectedAt) < Date.parse(value.issuedAt)) {
    throw new TypeError(label + ".connectedAt precedes issuedAt.");
  }
  if (value.revokedAt !== null && Date.parse(value.revokedAt) < Date.parse(value.issuedAt)) {
    throw new TypeError(label + ".revokedAt precedes issuedAt.");
  }
  if (value.state === "connected" && value.connectedAt === null) throw new TypeError(label + ".connectedAt is required.");
  if (value.state === "revoked" && value.revokedAt === null) throw new TypeError(label + ".revokedAt is required.");
}

function validateAgent(value, index) {
  const label = "administration.agents[" + index + "]";
  exact(value, [
    "agentId", "displayName", "description", "kind", "provider", "model", "capabilities",
    "state", "activePromptId", "lastSeenAt",
    "revision", "createdAt", "updatedAt"
  ], label);
  id(value.agentId, label + ".agentId", "agent");
  text(value.displayName, label + ".displayName", 120);
  if (value.description !== undefined) optionalText(value.description, label + ".description", 1000);
  if (!["interactive", "automation", "service"].includes(value.kind)) throw new TypeError(label + ".kind is invalid.");
  if (value.provider !== undefined) text(value.provider, label + ".provider", 100, /^[a-z][a-z0-9._-]*$/);
  if (value.model !== undefined) optionalText(value.model, label + ".model", 120);
  if (!["active", "paused", "archived"].includes(value.state)) throw new TypeError(label + ".state is invalid.");
  stringList(value.capabilities, label + ".capabilities", 64, 100);
  if (value.activePromptId !== null) id(value.activePromptId, label + ".activePromptId", "prompt");
  nullableTimestamp(value.lastSeenAt, label + ".lastSeenAt");
  integer(value.revision, label + ".revision");
  timestamp(value.createdAt, label + ".createdAt");
  timestamp(value.updatedAt, label + ".updatedAt");
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) throw new TypeError(label + ".updatedAt precedes createdAt.");
  if (value.lastSeenAt !== null && Date.parse(value.lastSeenAt) > Date.parse(value.updatedAt)) {
    throw new TypeError(label + ".lastSeenAt follows updatedAt.");
  }
}

function validateAttestation(value, index) {
  const label = "administration.attestations[" + index + "]";
  exact(value, [
    "attestationId", "title", "description", "owner", "status", "dueAt", "revision", "createdAt", "updatedAt"
  ], label);
  id(value.attestationId, label + ".attestationId", "attestation");
  text(value.title, label + ".title", 200);
  if (value.description !== undefined) optionalText(value.description, label + ".description", 4000);
  if (value.owner !== undefined) optionalText(value.owner, label + ".owner", 160);
  nullableTimestamp(value.dueAt, label + ".dueAt");
  if (!["draft", "pending", "attested", "expired", "archived"].includes(value.status)) {
    throw new TypeError(label + ".status is invalid.");
  }
  integer(value.revision, label + ".revision");
  timestamp(value.createdAt, label + ".createdAt");
  timestamp(value.updatedAt, label + ".updatedAt");
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) throw new TypeError(label + ".updatedAt precedes createdAt.");
}

function validateRisk(value, index) {
  const label = "administration.risks[" + index + "]";
  exact(value, [
    "riskId", "title", "description", "owner", "status", "likelihood", "impact", "reviewAt",
    "revision", "createdAt", "updatedAt"
  ], label);
  id(value.riskId, label + ".riskId", "risk");
  text(value.title, label + ".title", 200);
  if (value.description !== undefined) optionalText(value.description, label + ".description", 4000);
  if (value.owner !== undefined) optionalText(value.owner, label + ".owner", 160);
  if (!["low", "moderate", "high", "critical"].includes(value.likelihood)) throw new TypeError(label + ".likelihood is invalid.");
  if (!["low", "moderate", "high", "critical"].includes(value.impact)) throw new TypeError(label + ".impact is invalid.");
  nullableTimestamp(value.reviewAt, label + ".reviewAt");
  if (!["open", "mitigating", "accepted", "closed", "archived"].includes(value.status)) {
    throw new TypeError(label + ".status is invalid.");
  }
  integer(value.revision, label + ".revision");
  timestamp(value.createdAt, label + ".createdAt");
  timestamp(value.updatedAt, label + ".updatedAt");
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) throw new TypeError(label + ".updatedAt precedes createdAt.");
}

function validateChange(value, index) {
  const label = "administration.changes[" + index + "]";
  exact(value, ["changeId", "domain", "resourceType", "resourceId", "action", "status", "at", "message"], label);
  id(value.changeId, label + ".changeId", "change");
  if (!["agents", "governance"].includes(value.domain)) throw new TypeError(label + ".domain is invalid.");
  if (!["agent", "prompt", "enrollment", "attestation", "risk"].includes(value.resourceType)) throw new TypeError(label + ".resourceType is invalid.");
  opaqueId(value.resourceId, label + ".resourceId");
  if (!CHANGE_ACTIONS.has(value.action)) throw new TypeError(label + ".action is invalid.");
  if (!["succeeded", "failed", "rejected", "conflict"].includes(value.status)) throw new TypeError(label + ".status is invalid.");
  timestamp(value.at, label + ".at");
  if (value.message !== undefined) text(value.message, label + ".message", 500);
  const actionType = value.action.slice(0, value.action.indexOf("."));
  if (actionType !== value.resourceType) throw new TypeError(label + ".action does not match resourceType.");
  const agentDomain = ["agent", "prompt", "enrollment"].includes(value.resourceType);
  if ((value.domain === "agents") !== agentDomain) throw new TypeError(label + ".resourceType does not match domain.");
}

function validateTombstone(value, index) {
  const label = "administration.tombstones[" + index + "]";
  exact(value, ["tombstoneId", "resourceType", "resourceId", "removedAt", "finalRevision"], label);
  id(value.tombstoneId, label + ".tombstoneId", "tombstone");
  if (!["agent", "attestation", "risk"].includes(value.resourceType)) throw new TypeError(label + ".resourceType is invalid.");
  id(value.resourceId, label + ".resourceId", value.resourceType);
  timestamp(value.removedAt, label + ".removedAt");
  integer(value.finalRevision, label + ".finalRevision");
}

function validateCommandResult(value, index) {
  const label = "administration.commandResults[" + index + "]";
  exact(value, ["requestId", "requestHash", "command", "result", "at"], label);
  text(value.requestId, label + ".requestId", 128, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
  text(value.requestHash, label + ".requestHash", 64, /^[a-f0-9]{64}$/);
  if (!COMMANDS.has(value.command)) throw new TypeError(label + ".command is invalid.");
  exact(value.result, ["schemaVersion", "documentType", "requestId", "command", "status", "completedAt", "output", "error"], label + ".result");
  if (value.result.schemaVersion !== SCHEMA_VERSION || value.result.documentType !== "administration-command-result"
      || value.result.requestId !== value.requestId || value.result.command !== value.command
      || !["succeeded", "failed", "rejected", "conflict"].includes(value.result.status)) {
    throw new TypeError(label + ".result does not match its cache metadata.");
  }
  timestamp(value.result.completedAt, label + ".result.completedAt");
  if (value.result.status === "succeeded") {
    if (!isRecord(value.result.output) || value.result.error !== undefined) throw new TypeError(label + ".result success shape is invalid.");
    let allowedOutput;
    if (value.command.startsWith("agent.")) allowedOutput = ["agentId", "state", "revision"];
    else if (value.command.startsWith("prompt.")) allowedOutput = ["promptId", "agentId", "version", "state", "revision"];
    else if (value.command.startsWith("enrollment.")) allowedOutput = ["enrollmentId", "agentId", "state", "revision"];
    else if (value.command.startsWith("attestation.")) allowedOutput = ["attestationId", "state", "revision"];
    else allowedOutput = ["riskId", "state", "revision"];
    exact(value.result.output, allowedOutput, label + ".result.output");
    if (integer(value.result.output.revision, label + ".result.output.revision") < 1) {
      throw new TypeError(label + ".result.output.revision is invalid.");
    }
    if (value.command.startsWith("agent.")) {
      id(value.result.output.agentId, label + ".result.output.agentId", "agent");
      const allowedAgentStates = value.command === "agent.remove" ? ["removed"] : ["active", "paused", "archived"];
      if (!allowedAgentStates.includes(value.result.output.state)) {
        throw new TypeError(label + ".result.output.state is invalid.");
      }
    } else if (value.command.startsWith("prompt.")) {
      id(value.result.output.promptId, label + ".result.output.promptId", "prompt");
      id(value.result.output.agentId, label + ".result.output.agentId", "agent");
      if (integer(value.result.output.version, label + ".result.output.version", 1000000) < 1) {
        throw new TypeError(label + ".result.output.version is invalid.");
      }
      if (!["draft", "active", "archived"].includes(value.result.output.state)) throw new TypeError(label + ".result.output.state is invalid.");
    } else if (value.command.startsWith("enrollment.")) {
      id(value.result.output.enrollmentId, label + ".result.output.enrollmentId", "enrollment");
      id(value.result.output.agentId, label + ".result.output.agentId", "agent");
      if (!["issued", "connected", "revoked", "expired"].includes(value.result.output.state)) throw new TypeError(label + ".result.output.state is invalid.");
    } else if (value.command.startsWith("attestation.")) {
      id(value.result.output.attestationId, label + ".result.output.attestationId", "attestation");
      if (!["draft", "pending", "attested", "expired", "archived", "removed"].includes(value.result.output.state)) {
        throw new TypeError(label + ".result.output.state is invalid.");
      }
    } else {
      id(value.result.output.riskId, label + ".result.output.riskId", "risk");
      if (!["open", "mitigating", "accepted", "closed", "archived", "removed"].includes(value.result.output.state)) {
        throw new TypeError(label + ".result.output.state is invalid.");
      }
    }
    const fixedState = {
      "agent.create": "active", "agent.pause": "paused", "agent.resume": "active", "agent.archive": "archived",
      "agent.restore": "active", "agent.remove": "removed", "prompt.revise": "draft", "prompt.activate": "active",
      "prompt.archive": "archived", "enrollment.issue": "issued", "enrollment.revoke": "revoked",
      "attestation.create": "draft", "attestation.archive": "archived", "attestation.remove": "removed",
      "risk.create": "open", "risk.archive": "archived", "risk.remove": "removed"
    }[value.command];
    if (fixedState !== undefined && value.result.output.state !== fixedState) {
      throw new TypeError(label + ".result.output.state does not match command.");
    }
    if (value.command === "attestation.restore" && ["archived", "removed"].includes(value.result.output.state)) {
      throw new TypeError(label + ".result.output.state is not restored.");
    }
    if (value.command === "risk.restore" && ["archived", "removed"].includes(value.result.output.state)) {
      throw new TypeError(label + ".result.output.state is not restored.");
    }
  } else if (!isRecord(value.result.error) || value.result.output !== undefined) {
    throw new TypeError(label + ".result failure shape is invalid.");
  } else {
    exact(value.result.error, ["code", "message", "field", "retryable"], label + ".result.error");
    if (!ERROR_CODES.has(value.result.error.code)) throw new TypeError(label + ".result.error.code is invalid.");
    text(value.result.error.message, label + ".result.error.message", 500);
    if (typeof value.result.error.retryable !== "boolean") throw new TypeError(label + ".result.error.retryable is invalid.");
    if (value.result.error.field !== undefined) text(value.result.error.field, label + ".result.error.field", 160, /^[A-Za-z][A-Za-z0-9.-]*$/);
  }
  if (Date.parse(value.at) < Date.parse(value.result.completedAt)) throw new TypeError(label + ".at precedes result.completedAt.");
  if (containsSensitiveCacheField(value.result)) throw new TypeError(label + ".result is not safely cacheable.");
  const serialized = JSON.stringify(value.result);
  if (serialized.length > 8192) throw new TypeError(label + ".result is not safely cacheable.");
  timestamp(value.at, label + ".at");
}

function containsSensitiveCacheField(value, seen = new Set()) {
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return true;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return true;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set) return true;
    const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (normalized === "body" || normalized === "onetimecredential"
        || ["secret", "password", "passwd", "token", "apikey", "privatekey", "credential", "credentials",
          "authorization", "cookie", "sessionid", "clientsecret", "accesskey"].some((suffix) => normalized.endsWith(suffix))) {
      return true;
    }
    if (containsSensitiveCacheField(value[key], seen)) return true;
  }
  seen.delete(value);
  return false;
}

function validateRevisionBounds(items, stateRevision, label) {
  for (const item of items) {
    if (item.revision > stateRevision) throw new TypeError(label + " contains a future revision.");
  }
}

function validateState(value) {
  exact(value, ["schemaVersion", "revision", "agents", "prompts", "enrollments", "attestations", "risks", "changes", "tombstones", "commandResults"], "administration");
  if (value.schemaVersion !== SCHEMA_VERSION) throw new TypeError("administration.schemaVersion is unsupported.");
  integer(value.revision, "administration.revision");
  const agents = array(value.agents, "administration.agents", 1000);
  agents.forEach(validateAgent);
  unique(agents, "agentId", "administration.agents");
  const agentIds = new Set(agents.map((agent) => agent.agentId));
  const prompts = array(value.prompts, "administration.prompts", 5000);
  prompts.forEach((prompt, index) => validatePrompt(prompt, "administration.prompts[" + index + "]"));
  unique(prompts, "promptId", "administration.prompts");
  const promptIds = new Set(prompts.map((prompt) => prompt.promptId));
  for (const prompt of prompts) if (!agentIds.has(prompt.agentId)) throw new TypeError("administration.prompts references an unknown agent.");
  for (const agent of agents) {
    if (agent.activePromptId !== null && !promptIds.has(agent.activePromptId)) throw new TypeError("administration.agents references an unknown active prompt.");
    const active = prompts.filter((prompt) => prompt.agentId === agent.agentId && prompt.state === "active");
    if (active.length > 1 || (active[0] && active[0].promptId !== agent.activePromptId)
        || (!active.length && agent.activePromptId !== null)) throw new TypeError("administration prompt activation is inconsistent.");
  }
  const enrollments = array(value.enrollments, "administration.enrollments", 5000);
  enrollments.forEach((enrollment, index) => validateEnrollment(enrollment, "administration.enrollments[" + index + "]"));
  unique(enrollments, "enrollmentId", "administration.enrollments");
  for (const enrollment of enrollments) if (!agentIds.has(enrollment.agentId)) throw new TypeError("administration.enrollments references an unknown agent.");
  const attestations = array(value.attestations, "administration.attestations", 5000);
  attestations.forEach(validateAttestation);
  unique(attestations, "attestationId", "administration.attestations");
  const risks = array(value.risks, "administration.risks", 5000);
  risks.forEach(validateRisk);
  unique(risks, "riskId", "administration.risks");
  const changes = array(value.changes, "administration.changes", 1000);
  changes.forEach(validateChange);
  unique(changes, "changeId", "administration.changes");
  const tombstones = array(value.tombstones, "administration.tombstones", 4000);
  tombstones.forEach(validateTombstone);
  unique(tombstones, "tombstoneId", "administration.tombstones");
  const cached = array(value.commandResults, "administration.commandResults", 1000);
  cached.forEach(validateCommandResult);
  unique(cached, "requestId", "administration.commandResults");
  validateRevisionBounds(agents, value.revision, "administration.agents");
  validateRevisionBounds(prompts, value.revision, "administration.prompts");
  validateRevisionBounds(enrollments, value.revision, "administration.enrollments");
  validateRevisionBounds(attestations, value.revision, "administration.attestations");
  validateRevisionBounds(risks, value.revision, "administration.risks");
  for (const tombstone of tombstones) {
    if (tombstone.finalRevision > value.revision) throw new TypeError("administration.tombstones contains a future revision.");
  }
  for (const item of cached) {
    if (item.result.status === "succeeded" && item.result.output.revision > value.revision) {
      throw new TypeError("administration.commandResults contains a future revision.");
    }
  }
  return value;
}

function emptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    agents: [],
    prompts: [],
    enrollments: [],
    attestations: [],
    risks: [],
    changes: [],
    tombstones: [],
    commandResults: []
  };
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function stableId(prefix) {
  if (!["agent", "prompt", "enrollment", "attestation", "risk", "change", "tombstone"].includes(prefix)) {
    throw new TypeError("Administration resource prefix is invalid.");
  }
  return prefix + "-" + crypto.randomUUID();
}
function hashCredential(value) {
  if (typeof value !== "string") throw new TypeError("Administration credential must be text.");
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function secureDirectory(directory) {
  if (typeof directory !== "string" || !directory.trim()) throw new TypeError("An explicit administration state directory is required.");
  const resolved = path.resolve(directory);
  if (resolved === path.parse(resolved).root) throw new TypeError("Administration state may not use a filesystem root.");
  let stat;
  try { stat = fs.lstatSync(resolved); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw new Error("Administration state directory is unsafe.");
  if (!stat) fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(resolved) !== resolved) throw new Error("Administration state directory may not traverse symbolic links.");
  fs.chmodSync(resolved, 0o700);
  return resolved;
}

function secureFile(filename, label) {
  let stat;
  try { stat = fs.lstatSync(filename); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(label + " is unsafe.");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error(label + " has the wrong owner.");
  fs.chmodSync(filename, 0o600);
  return stat;
}

function atomicWrite(filename, value) {
  const directory = path.dirname(filename);
  const temporary = path.join(directory, "." + path.basename(filename) + "." + process.pid + "." + crypto.randomUUID() + ".tmp");
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value) + "\n", "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, filename);
    fs.chmodSync(filename, 0o600);
    let directoryDescriptor;
    try {
      directoryDescriptor = fs.openSync(directory, fs.constants.O_RDONLY);
      fs.fsyncSync(directoryDescriptor);
    } catch (error) {
      if (!error || !["EINVAL", "ENOTSUP"].includes(error.code)) throw error;
    } finally {
      if (directoryDescriptor !== undefined) try { fs.closeSync(directoryDescriptor); } catch {}
    }
  } catch (error) {
    if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch {}
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function validateAudit(value, label) {
  exact(value, ["schemaVersion", "at", "phase", "revision", "command", "actor", "resourceType", "resourceId", "requestId", "changedFields"], label);
  if (value.schemaVersion !== SCHEMA_VERSION) throw new TypeError(label + ".schemaVersion is unsupported.");
  timestamp(value.at, label + ".at");
  if (!["intent", "commit", "abort"].includes(value.phase)) throw new TypeError(label + ".phase is invalid.");
  integer(value.revision, label + ".revision");
  text(value.command, label + ".command", 100, /^[a-z][a-z0-9.-]*$/);
  text(value.actor, label + ".actor", 100, /^[a-z][a-z0-9:._-]*$/);
  text(value.resourceType, label + ".resourceType", 40, /^[a-z][a-z0-9-]*$/);
  text(value.resourceId, label + ".resourceId", 128, /^[A-Za-z0-9._:-]+$/);
  text(value.requestId, label + ".requestId", 128, /^[A-Za-z0-9._:-]+$/);
  stringList(value.changedFields, label + ".changedFields", 32);
  return value;
}

function sameAuditTransaction(left, right) {
  return ["at", "revision", "command", "actor", "resourceType", "resourceId", "requestId"].every((key) => left[key] === right[key])
    && JSON.stringify(left.changedFields) === JSON.stringify(right.changedFields);
}

class ReferenceAdministrationStore {
  constructor(options) {
    if (!isRecord(options)) throw new TypeError("ReferenceAdministrationStore options are required.");
    this.directory = secureDirectory(options.directory);
    this.clock = typeof options.clock === "function" ? options.clock : () => new Date();
    this.stateFile = path.join(this.directory, STATE_FILE);
    this.auditFile = path.join(this.directory, AUDIT_FILE);
    this.lockFile = path.join(this.directory, LOCK_FILE);
    this.failed = false;
    this.closed = false;
    this.lockDescriptor = null;
    try {
      this.lockDescriptor = fs.openSync(this.lockFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      fs.writeFileSync(this.lockDescriptor, String(process.pid) + "\n", "utf8");
      fs.fsyncSync(this.lockDescriptor);
    } catch (error) {
      if (this.lockDescriptor !== null) {
        try { fs.closeSync(this.lockDescriptor); } catch {}
        this.lockDescriptor = null;
        try { fs.unlinkSync(this.lockFile); } catch {}
      }
      if (error.code === "EEXIST") throw new Error("Administration state is already in use.");
      throw error;
    }
    try { this.state = this.load(); } catch (error) { this.close(); throw error; }
  }

  now() {
    const value = this.clock();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError("Administration clock is invalid.");
    return value.toISOString();
  }

  loadAudit() {
    const stat = secureFile(this.auditFile, "Administration audit file");
    if (!stat) return [];
    if (stat.size > MAX_AUDIT_BYTES) throw new Error("Administration audit capacity is exhausted.");
    const raw = fs.readFileSync(this.auditFile, "utf8");
    if (raw && !raw.endsWith("\n")) throw new Error("Administration audit has an incomplete line.");
    return raw.split("\n").filter(Boolean).map((line, index) => {
      if (Buffer.byteLength(line, "utf8") > 4096) throw new Error("Administration audit line exceeds its safety bound.");
      let parsed;
      try { parsed = JSON.parse(line); } catch { throw new Error("Administration audit line is invalid JSON."); }
      return validateAudit(parsed, "administration audit line " + (index + 1));
    });
  }

  validateAuditChain(entries, revision, recover = false) {
    const pending = new Map();
    let commits = 0;
    for (const entry of entries) {
      if (entry.phase === "intent") {
        if (pending.has(entry.revision)) throw new Error("Administration audit contains duplicate intent.");
        if (entry.revision !== commits + 1) throw new Error("Administration audit intent revision is not contiguous.");
        pending.set(entry.revision, entry);
        continue;
      }
      const intent = pending.get(entry.revision);
      if (!intent) throw new Error("Administration audit outcome has no intent.");
      if (!sameAuditTransaction(entry, intent)) throw new Error("Administration audit outcome does not match intent.");
      if (entry.phase === "commit") {
        commits += 1;
        if (entry.revision !== commits) throw new Error("Administration audit revisions are not contiguous.");
      }
      pending.delete(entry.revision);
    }
    if (recover && pending.size === 1) {
      const intent = pending.values().next().value;
      if (intent.revision !== commits + 1 || ![commits, commits + 1].includes(revision)) {
        throw new Error("Administration audit recovery is ambiguous.");
      }
      const phase = revision === commits + 1 ? "commit" : "abort";
      const outcome = { ...intent, phase };
      this.appendAudit(outcome);
      entries.push(outcome);
      pending.delete(intent.revision);
      if (phase === "commit") commits += 1;
    }
    if (pending.size || commits !== revision) throw new Error("Administration audit and state revisions do not match.");
  }

  load() {
    const audit = this.loadAudit();
    const stat = secureFile(this.stateFile, "Administration state file");
    if (!stat) {
      if (audit.length) throw new Error("Administration state is missing while audit exists.");
      const initial = emptyState();
      atomicWrite(this.stateFile, initial);
      return initial;
    }
    if (stat.size > MAX_STATE_BYTES) throw new Error("Administration state capacity is exhausted.");
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(this.stateFile, "utf8")); }
    catch { throw new Error("Administration state is invalid JSON."); }
    validateState(parsed);
    this.validateAuditChain(audit, parsed.revision, true);
    return parsed;
  }

  appendAudit(entry) {
    validateAudit(entry, "new administration audit entry");
    const line = JSON.stringify(entry) + "\n";
    const stat = secureFile(this.auditFile, "Administration audit file");
    if (Buffer.byteLength(line) > 4096 || stat && stat.size + Buffer.byteLength(line) > MAX_AUDIT_BYTES) {
      throw new Error("Administration audit capacity is exhausted.");
    }
    const descriptor = fs.openSync(this.auditFile, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0), 0o600);
    try { fs.writeFileSync(descriptor, line, "utf8"); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
  }

  snapshot() {
    if (this.failed || this.closed) throw new Error("Administration store is unavailable.");
    return clone(this.state);
  }

  transact(metadata, mutate) {
    if (this.failed || this.closed) throw new Error("Administration store is unavailable.");
    exact(metadata, ["command", "actor", "resourceType", "resourceId", "requestId", "changedFields"], "administration transaction metadata");
    if (typeof mutate !== "function") throw new TypeError("Administration mutation function is required.");
    const next = clone(this.state);
    const targetRevision = this.state.revision + 1;
    const result = mutate(next, targetRevision);
    next.revision = targetRevision;
    validateState(next);
    if (Buffer.byteLength(JSON.stringify(next)) + 1 > MAX_STATE_BYTES) throw new Error("Administration state capacity is exhausted.");
    const at = this.now();
    const base = {
      schemaVersion: SCHEMA_VERSION,
      at,
      revision: next.revision,
      command: text(metadata.command, "administration transaction command", 100, /^[a-z][a-z0-9.-]*$/),
      actor: text(metadata.actor, "administration transaction actor", 100, /^[a-z][a-z0-9:._-]*$/),
      resourceType: text(metadata.resourceType, "administration transaction resource type", 40, /^[a-z][a-z0-9-]*$/),
      resourceId: text(metadata.resourceId, "administration transaction resource id", 128, /^[A-Za-z0-9._:-]+$/),
      requestId: text(metadata.requestId, "administration transaction request id", 128, /^[A-Za-z0-9._:-]+$/),
      changedFields: stringList(metadata.changedFields, "administration transaction changed fields", 32)
    };
    let intentWritten = false;
    try {
      this.appendAudit({ ...base, phase: "intent" });
      intentWritten = true;
      atomicWrite(this.stateFile, next);
      this.appendAudit({ ...base, phase: "commit" });
      this.state = next;
      return { revision: next.revision, result };
    } catch (error) {
      if (intentWritten) {
        let stateRemainedAtPriorRevision = false;
        try {
          const diskState = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
          validateState(diskState);
          stateRemainedAtPriorRevision = diskState.revision === this.state.revision;
        } catch {}
        if (stateRemainedAtPriorRevision) try { this.appendAudit({ ...base, phase: "abort" }); } catch {}
      }
      this.failed = true;
      throw error;
    }
  }

  close() {
    if (this.lockDescriptor !== null) {
      try { fs.closeSync(this.lockDescriptor); } catch {}
      this.lockDescriptor = null;
      try { fs.unlinkSync(this.lockFile); } catch {}
    }
    this.closed = true;
  }
}

module.exports = {
  AUDIT_FILE,
  LOCK_FILE,
  ReferenceAdministrationStore,
  SCHEMA_VERSION,
  STATE_FILE,
  clone,
  emptyState,
  hashCredential,
  stableId,
  validateState
};
