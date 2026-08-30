"use strict";

// Versioned, data-only administration boundary for agent and governance
// management. This module validates adopter-supplied providers; it performs no
// requests, persistence, prompt execution, enrollment, or authorization itself.
(function installAdministrationContract(root, factory) {
  const runtime = factory(root);
  if (root) root.SocConsoleAdministrationRuntime = runtime;
  if (typeof module === "object" && module && module.exports) module.exports = runtime;
}(
  typeof window === "object" && window ? window :
    (typeof globalThis === "object" ? globalThis : null),
  function createAdministrationContract(global) {
    const VERSION = "1";
    const DOMAINS = Object.freeze(["agents", "governance"]);
    const DOCUMENT_TYPES = Object.freeze([
      "administration-snapshot-request",
      "agent-administration-snapshot",
      "governance-administration-snapshot",
      "agent-prompt-request",
      "agent-prompt",
      "administration-command-request",
      "administration-command-result"
    ]);
    const SNAPSHOT_REASONS = Object.freeze(["initial", "refresh", "command"]);
    const AGENT_STATES = Object.freeze(["active", "paused", "archived"]);
    const AGENT_KINDS = Object.freeze(["interactive", "automation", "service"]);
    const PROMPT_STATES = Object.freeze(["draft", "active", "archived"]);
    const ENROLLMENT_STATES = Object.freeze(["issued", "connected", "revoked", "expired"]);
    const ATTESTATION_STATUSES = Object.freeze(["draft", "pending", "attested", "expired", "archived"]);
    const RISK_STATUSES = Object.freeze(["open", "mitigating", "accepted", "closed", "archived"]);
    const RISK_LEVELS = Object.freeze(["low", "moderate", "high", "critical"]);
    const COMMAND_STATUSES = Object.freeze(["succeeded", "failed", "rejected", "conflict"]);
    const COMMANDS = Object.freeze([
      "agent.create", "agent.update", "agent.pause", "agent.resume", "agent.archive", "agent.restore", "agent.remove",
      "prompt.revise", "prompt.activate", "prompt.archive",
      "enrollment.issue", "enrollment.revoke",
      "attestation.create", "attestation.update", "attestation.transition", "attestation.archive", "attestation.restore", "attestation.remove",
      "risk.create", "risk.update", "risk.transition", "risk.archive", "risk.restore", "risk.remove"
    ]);
    const ERROR_CODES = Object.freeze([
      "validation-failed", "not-authorized", "not-found", "already-exists",
      "revision-conflict", "transition-invalid", "dependency-conflict",
      "provider-unavailable", "internal-error"
    ]);
    const CHANGE_STATUSES = COMMAND_STATUSES;
    const CHANGE_ACTIONS = Object.freeze([
      "agent.created", "agent.updated", "agent.paused", "agent.resumed", "agent.archived", "agent.restored", "agent.removed",
      "prompt.revised", "prompt.activated", "prompt.archived",
      "enrollment.issued", "enrollment.revoked",
      "attestation.created", "attestation.updated", "attestation.transitioned", "attestation.archived", "attestation.restored", "attestation.removed",
      "risk.created", "risk.updated", "risk.transitioned", "risk.archived", "risk.restored", "risk.removed"
    ]);
    const RESOURCE_TYPES = Object.freeze(["agent", "prompt", "enrollment", "attestation", "risk"]);
    const MARKUP_KEYS = new Set(["html", "innerhtml", "outerhtml", "srcdoc"]);
    const SENSITIVE_KEY_SUFFIXES = Object.freeze([
      "secret", "password", "passwd", "token", "apikey", "privatekey",
      "credential", "credentials", "authorization", "cookie", "sessionid",
      "clientsecret", "accesskey"
    ]);

    function isRecord(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const prototype = Object.getPrototypeOf(value);
      return prototype === null || Object.getPrototypeOf(prototype) === null;
    }

    function assertRecord(value, label) {
      if (!isRecord(value)) throw new TypeError(`${label} must be a plain object.`);
    }

    function normalizedKey(key) {
      return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    }

    function assertAllowedKeys(value, allowed, label, sensitiveExceptions = []) {
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string" || !allowed.includes(key)) {
          throw new TypeError(`${label} contains an unsupported key.`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || descriptor.get || descriptor.set) {
          throw new TypeError(`${label} must use data properties.`);
        }
        const normalized = normalizedKey(key);
        if (MARKUP_KEYS.has(normalized)) throw new TypeError(`${label} must contain data, not markup.`);
        if (!sensitiveExceptions.includes(key) && SENSITIVE_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) {
          throw new TypeError(`${label} must not contain secret-looking fields.`);
        }
      }
    }

    function assertArray(value, label, minimum, maximum) {
      if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
        const range = minimum === 0 ? `at most ${maximum}` : `between ${minimum} and ${maximum}`;
        throw new TypeError(`${label} must be an array containing ${range} entries.`);
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || descriptor.get || descriptor.set) {
          throw new TypeError(`${label} must be a dense array of data values.`);
        }
      }
      for (const key of Reflect.ownKeys(value)) {
        if (key === "length") continue;
        if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) {
          throw new TypeError(`${label} must not contain custom properties.`);
        }
      }
    }

    function deepFreeze(value) {
      if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
      Reflect.ownKeys(value).forEach((key) => deepFreeze(value[key]));
      return Object.freeze(value);
    }

    function requiredText(value, label, maximum) {
      if (typeof value !== "string" || !value.trim() || value.length > maximum
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
        throw new TypeError(`${label} must be non-empty plain text of at most ${maximum} characters without control characters.`);
      }
      return value;
    }

    function optionalText(value, label, maximum) {
      if (value === undefined) return undefined;
      if (typeof value !== "string" || value.length > maximum
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
        throw new TypeError(`${label} must be plain text of at most ${maximum} characters without control characters.`);
      }
      return value;
    }

    function enumValue(value, values, label) {
      if (!values.includes(value)) throw new TypeError(`${label} must be one of: ${values.join(", ")}.`);
      return value;
    }

    function unsignedInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
      if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
        throw new TypeError(`${label} must be an integer between 0 and ${maximum}.`);
      }
      return value;
    }

    function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
        throw new TypeError(`${label} must be an integer between 1 and ${maximum}.`);
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
        || Number.isNaN(Date.parse(value))) {
        throw new TypeError(`${label} must be an RFC 3339 date-time.`);
      }
      return value;
    }

    function nullableTimestamp(value, label) {
      return value === null ? null : timestamp(value, label);
    }

    function resourceId(value, label) {
      const candidate = requiredText(value, label, 128);
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(candidate)) {
        throw new TypeError(`${label} must be an opaque identifier without whitespace, path separators, or query syntax.`);
      }
      return candidate;
    }

    function identifier(value, label) {
      const candidate = requiredText(value, label, 80);
      if (!/^[a-z][a-z0-9-]*$/.test(candidate)) {
        throw new TypeError(`${label} must start with a lowercase letter and contain lowercase letters, digits, or hyphens.`);
      }
      return candidate;
    }

    function typeName(value, label) {
      const candidate = requiredText(value, label, 100);
      if (!/^[a-z][a-z0-9._-]*$/.test(candidate)) {
        throw new TypeError(`${label} must be a normalized lowercase type name.`);
      }
      return candidate;
    }

    function uniqueTextArray(value, label, minimum, maximum, validator) {
      assertArray(value, label, minimum, maximum);
      const seen = new Set();
      return value.map((entry, index) => {
        const normalized = validator(entry, `${label}[${index}]`);
        if (seen.has(normalized)) throw new TypeError(`${label} must contain unique values.`);
        seen.add(normalized);
        return normalized;
      });
    }

    function capability(value, label) {
      const candidate = requiredText(value, label, 100);
      if (!/^[a-z][a-z0-9:._-]*$/.test(candidate)) {
        throw new TypeError(`${label} must be a normalized capability name.`);
      }
      return candidate;
    }

    function setOptionalText(result, source, key, label, maximum) {
      const value = optionalText(source[key], `${label}.${key}`, maximum);
      if (value !== undefined) result[key] = value;
    }

    function validateOrderedTimestamps(result, label) {
      if (Date.parse(result.updatedAt) < Date.parse(result.createdAt)) {
        throw new TypeError(`${label}.updatedAt must not precede createdAt.`);
      }
    }

    function normalizeAgent(value, label) {
      assertRecord(value, label);
      assertAllowedKeys(value, [
        "agentId", "displayName", "description", "kind", "provider", "model", "capabilities",
        "state", "activePromptId", "lastSeenAt", "revision", "createdAt", "updatedAt"
      ], label);
      const result = {
        agentId: resourceId(value.agentId, `${label}.agentId`),
        displayName: requiredText(value.displayName, `${label}.displayName`, 120),
        kind: enumValue(value.kind, AGENT_KINDS, `${label}.kind`),
        capabilities: uniqueTextArray(value.capabilities, `${label}.capabilities`, 0, 64, capability),
        state: enumValue(value.state, AGENT_STATES, `${label}.state`),
        activePromptId: value.activePromptId === null ? null : resourceId(value.activePromptId, `${label}.activePromptId`),
        lastSeenAt: nullableTimestamp(value.lastSeenAt, `${label}.lastSeenAt`),
        revision: unsignedInteger(value.revision, `${label}.revision`),
        createdAt: timestamp(value.createdAt, `${label}.createdAt`),
        updatedAt: timestamp(value.updatedAt, `${label}.updatedAt`)
      };
      setOptionalText(result, value, "description", label, 1000);
      if (value.provider !== undefined) result.provider = typeName(value.provider, `${label}.provider`);
      setOptionalText(result, value, "model", label, 120);
      validateOrderedTimestamps(result, label);
      if (result.lastSeenAt !== null && Date.parse(result.lastSeenAt) > Date.parse(result.updatedAt)) {
        throw new TypeError(`${label}.lastSeenAt must not be later than updatedAt.`);
      }
      return result;
    }

    function normalizePromptMetadata(value, label) {
      assertRecord(value, label);
      assertAllowedKeys(value, [
        "promptId", "agentId", "version", "title", "state", "revision", "createdAt", "updatedAt"
      ], label);
      const result = {
        promptId: resourceId(value.promptId, `${label}.promptId`),
        agentId: resourceId(value.agentId, `${label}.agentId`),
        version: positiveInteger(value.version, `${label}.version`, 1000000),
        title: requiredText(value.title, `${label}.title`, 160),
        state: enumValue(value.state, PROMPT_STATES, `${label}.state`),
        revision: unsignedInteger(value.revision, `${label}.revision`),
        createdAt: timestamp(value.createdAt, `${label}.createdAt`),
        updatedAt: timestamp(value.updatedAt, `${label}.updatedAt`)
      };
      validateOrderedTimestamps(result, label);
      return result;
    }

    function normalizeEnrollment(value, label) {
      assertRecord(value, label);
      assertAllowedKeys(value, [
        "enrollmentId", "agentId", "state", "issuedAt", "expiresAt", "connectedAt", "revokedAt", "revision"
      ], label);
      const result = {
        enrollmentId: resourceId(value.enrollmentId, `${label}.enrollmentId`),
        agentId: resourceId(value.agentId, `${label}.agentId`),
        state: enumValue(value.state, ENROLLMENT_STATES, `${label}.state`),
        issuedAt: timestamp(value.issuedAt, `${label}.issuedAt`),
        expiresAt: timestamp(value.expiresAt, `${label}.expiresAt`),
        connectedAt: nullableTimestamp(value.connectedAt, `${label}.connectedAt`),
        revokedAt: nullableTimestamp(value.revokedAt, `${label}.revokedAt`),
        revision: unsignedInteger(value.revision, `${label}.revision`)
      };
      if (Date.parse(result.expiresAt) <= Date.parse(result.issuedAt)) {
        throw new TypeError(`${label}.expiresAt must be later than issuedAt.`);
      }
      if (result.connectedAt !== null && Date.parse(result.connectedAt) < Date.parse(result.issuedAt)) {
        throw new TypeError(`${label}.connectedAt must not precede issuedAt.`);
      }
      if (result.revokedAt !== null && Date.parse(result.revokedAt) < Date.parse(result.issuedAt)) {
        throw new TypeError(`${label}.revokedAt must not precede issuedAt.`);
      }
      if (result.state === "connected" && result.connectedAt === null) {
        throw new TypeError(`${label}.connectedAt is required when state is connected.`);
      }
      if (result.state === "revoked" && result.revokedAt === null) {
        throw new TypeError(`${label}.revokedAt is required when state is revoked.`);
      }
      return result;
    }

    function normalizeAttestation(value, label) {
      assertRecord(value, label);
      assertAllowedKeys(value, [
        "attestationId", "title", "description", "owner", "status", "dueAt",
        "revision", "createdAt", "updatedAt"
      ], label);
      const result = {
        attestationId: resourceId(value.attestationId, `${label}.attestationId`),
        title: requiredText(value.title, `${label}.title`, 200),
        status: enumValue(value.status, ATTESTATION_STATUSES, `${label}.status`),
        dueAt: nullableTimestamp(value.dueAt, `${label}.dueAt`),
        revision: unsignedInteger(value.revision, `${label}.revision`),
        createdAt: timestamp(value.createdAt, `${label}.createdAt`),
        updatedAt: timestamp(value.updatedAt, `${label}.updatedAt`)
      };
      setOptionalText(result, value, "description", label, 4000);
      setOptionalText(result, value, "owner", label, 160);
      validateOrderedTimestamps(result, label);
      return result;
    }

    function normalizeRisk(value, label) {
      assertRecord(value, label);
      assertAllowedKeys(value, [
        "riskId", "title", "description", "owner", "status", "likelihood", "impact", "reviewAt",
        "revision", "createdAt", "updatedAt"
      ], label);
      const result = {
        riskId: resourceId(value.riskId, `${label}.riskId`),
        title: requiredText(value.title, `${label}.title`, 200),
        status: enumValue(value.status, RISK_STATUSES, `${label}.status`),
        likelihood: enumValue(value.likelihood, RISK_LEVELS, `${label}.likelihood`),
        impact: enumValue(value.impact, RISK_LEVELS, `${label}.impact`),
        reviewAt: nullableTimestamp(value.reviewAt, `${label}.reviewAt`),
        revision: unsignedInteger(value.revision, `${label}.revision`),
        createdAt: timestamp(value.createdAt, `${label}.createdAt`),
        updatedAt: timestamp(value.updatedAt, `${label}.updatedAt`)
      };
      setOptionalText(result, value, "description", label, 4000);
      setOptionalText(result, value, "owner", label, 160);
      validateOrderedTimestamps(result, label);
      return result;
    }

    function resourceTypeForAction(action) {
      return action.slice(0, action.indexOf("."));
    }

    function normalizeChange(value, label, domain) {
      assertRecord(value, label);
      assertAllowedKeys(value, ["changeId", "resourceType", "resourceId", "action", "status", "at", "message"], label);
      const result = {
        changeId: resourceId(value.changeId, `${label}.changeId`),
        resourceType: enumValue(value.resourceType, RESOURCE_TYPES, `${label}.resourceType`),
        resourceId: resourceId(value.resourceId, `${label}.resourceId`),
        action: enumValue(value.action, CHANGE_ACTIONS, `${label}.action`),
        status: enumValue(value.status, CHANGE_STATUSES, `${label}.status`),
        at: timestamp(value.at, `${label}.at`)
      };
      setOptionalText(result, value, "message", label, 500);
      if (resourceTypeForAction(result.action) !== result.resourceType) {
        throw new TypeError(`${label}.action must match resourceType.`);
      }
      const allowedTypes = domain === "agents"
        ? ["agent", "prompt", "enrollment"]
        : ["attestation", "risk"];
      if (!allowedTypes.includes(result.resourceType)) {
        throw new TypeError(`${label}.resourceType does not belong to the ${domain} domain.`);
      }
      return result;
    }

    function normalizeUniqueCollection(value, label, maximum, normalize, idKey) {
      assertArray(value, label, 0, maximum);
      const seen = new Set();
      return value.map((entry, index) => {
        const normalized = normalize(entry, `${label}[${index}]`);
        if (seen.has(normalized[idKey])) throw new TypeError(`${label} must use unique ${idKey} values.`);
        seen.add(normalized[idKey]);
        return normalized;
      });
    }

    function validateSnapshotRequest(value) {
      const label = "administration snapshot request";
      assertRecord(value, label);
      assertAllowedKeys(value, ["schemaVersion", "documentType", "domain", "reason", "knownRevision"], label);
      if (value.schemaVersion !== VERSION) throw new TypeError(`${label}.schemaVersion must be ${VERSION}.`);
      if (value.documentType !== "administration-snapshot-request") {
        throw new TypeError(`${label}.documentType must be administration-snapshot-request.`);
      }
      const result = {
        schemaVersion: VERSION,
        documentType: "administration-snapshot-request",
        domain: enumValue(value.domain, DOMAINS, `${label}.domain`),
        reason: enumValue(value.reason, SNAPSHOT_REASONS, `${label}.reason`)
      };
      if (value.knownRevision !== undefined) {
        result.knownRevision = unsignedInteger(value.knownRevision, `${label}.knownRevision`);
      }
      return deepFreeze(result);
    }

    function validateSnapshot(value, requestValue) {
      const label = "administration snapshot";
      assertRecord(value, label);
      const domain = enumValue(value.domain, DOMAINS, `${label}.domain`);
      const expectedDocumentType = domain === "agents"
        ? "agent-administration-snapshot"
        : "governance-administration-snapshot";
      if (domain === "agents") {
        assertAllowedKeys(value, [
          "schemaVersion", "documentType", "domain", "revision", "agents", "prompts", "enrollments", "changes"
        ], label);
      } else {
        assertAllowedKeys(value, [
          "schemaVersion", "documentType", "domain", "revision", "attestations", "risks", "changes"
        ], label);
      }
      if (value.schemaVersion !== VERSION) throw new TypeError(`${label}.schemaVersion must be ${VERSION}.`);
      if (value.documentType !== expectedDocumentType) {
        throw new TypeError(`${label}.documentType must be ${expectedDocumentType} for domain ${domain}.`);
      }
      const revision = unsignedInteger(value.revision, `${label}.revision`);
      const changeIds = new Set();
      assertArray(value.changes, `${label}.changes`, 0, 500);
      const changes = value.changes.map((entry, index) => {
        const normalized = normalizeChange(entry, `${label}.changes[${index}]`, domain);
        if (changeIds.has(normalized.changeId)) throw new TypeError(`${label}.changes must use unique changeId values.`);
        changeIds.add(normalized.changeId);
        return normalized;
      });
      let result;
      if (domain === "agents") {
        const agents = normalizeUniqueCollection(value.agents, `${label}.agents`, 1000, normalizeAgent, "agentId");
        const agentMap = new Map(agents.map((agent) => [agent.agentId, agent]));
        const prompts = normalizeUniqueCollection(value.prompts, `${label}.prompts`, 5000, normalizePromptMetadata, "promptId");
        const promptMap = new Map();
        const activeByAgent = new Set();
        prompts.forEach((prompt, index) => {
          if (!agentMap.has(prompt.agentId)) throw new TypeError(`${label}.prompts[${index}] references an unknown agentId.`);
          promptMap.set(prompt.promptId, prompt);
          if (prompt.state === "active") {
            if (activeByAgent.has(prompt.agentId)) throw new TypeError(`${label}.prompts may contain only one active prompt per agent.`);
            activeByAgent.add(prompt.agentId);
          }
        });
        agents.forEach((agent, index) => {
          if (agent.activePromptId === null) {
            if (activeByAgent.has(agent.agentId)) throw new TypeError(`${label}.agents[${index}].activePromptId must identify its active prompt.`);
            return;
          }
          const prompt = promptMap.get(agent.activePromptId);
          if (!prompt || prompt.agentId !== agent.agentId || prompt.state !== "active") {
            throw new TypeError(`${label}.agents[${index}].activePromptId must reference its active prompt metadata.`);
          }
        });
        const enrollments = normalizeUniqueCollection(
          value.enrollments, `${label}.enrollments`, 5000, normalizeEnrollment, "enrollmentId"
        );
        enrollments.forEach((enrollment, index) => {
          if (!agentMap.has(enrollment.agentId)) throw new TypeError(`${label}.enrollments[${index}] references an unknown agentId.`);
        });
        result = {
          schemaVersion: VERSION,
          documentType: expectedDocumentType,
          domain,
          revision,
          agents,
          prompts,
          enrollments,
          changes
        };
      } else {
        result = {
          schemaVersion: VERSION,
          documentType: expectedDocumentType,
          domain,
          revision,
          attestations: normalizeUniqueCollection(
            value.attestations, `${label}.attestations`, 5000, normalizeAttestation, "attestationId"
          ),
          risks: normalizeUniqueCollection(value.risks, `${label}.risks`, 5000, normalizeRisk, "riskId"),
          changes
        };
      }
      if (requestValue !== undefined) {
        const request = validateSnapshotRequest(requestValue);
        if (request.domain !== domain) throw new TypeError(`${label}.domain must match its request.`);
        if (request.knownRevision !== undefined && revision < request.knownRevision) {
          throw new TypeError(`${label}.revision must not precede request.knownRevision.`);
        }
      }
      return deepFreeze(result);
    }

    function validatePromptRequest(value) {
      const label = "agent prompt request";
      assertRecord(value, label);
      assertAllowedKeys(value, ["schemaVersion", "documentType", "promptId"], label);
      if (value.schemaVersion !== VERSION) throw new TypeError(`${label}.schemaVersion must be ${VERSION}.`);
      if (value.documentType !== "agent-prompt-request") throw new TypeError(`${label}.documentType must be agent-prompt-request.`);
      return deepFreeze({
        schemaVersion: VERSION,
        documentType: "agent-prompt-request",
        promptId: resourceId(value.promptId, `${label}.promptId`)
      });
    }

    function validatePrompt(value, requestValue) {
      const label = "agent prompt";
      assertRecord(value, label);
      assertAllowedKeys(value, [
        "schemaVersion", "documentType", "promptId", "agentId", "version", "title", "state",
        "body", "revision", "createdAt", "updatedAt"
      ], label);
      if (value.schemaVersion !== VERSION) throw new TypeError(`${label}.schemaVersion must be ${VERSION}.`);
      if (value.documentType !== "agent-prompt") throw new TypeError(`${label}.documentType must be agent-prompt.`);
      const metadata = normalizePromptMetadata({
        promptId: value.promptId,
        agentId: value.agentId,
        version: value.version,
        title: value.title,
        state: value.state,
        revision: value.revision,
        createdAt: value.createdAt,
        updatedAt: value.updatedAt
      }, label);
      const result = {
        schemaVersion: VERSION,
        documentType: "agent-prompt",
        ...metadata,
        body: requiredText(value.body, `${label}.body`, 32768)
      };
      if (requestValue !== undefined) {
        const request = validatePromptRequest(requestValue);
        if (request.promptId !== result.promptId) throw new TypeError(`${label}.promptId must match its request.`);
      }
      return deepFreeze(result);
    }

    function commandDomain(command) {
      return command.startsWith("agent.") || command.startsWith("prompt.") || command.startsWith("enrollment.")
        ? "agents"
        : "governance";
    }

    function mutableAgentFields(input, label, requireAll) {
      const result = {};
      if (requireAll || input.displayName !== undefined) result.displayName = requiredText(input.displayName, `${label}.displayName`, 120);
      setOptionalText(result, input, "description", label, 1000);
      if (requireAll || input.kind !== undefined) result.kind = enumValue(input.kind, AGENT_KINDS, `${label}.kind`);
      if (input.provider !== undefined) result.provider = typeName(input.provider, `${label}.provider`);
      setOptionalText(result, input, "model", label, 120);
      if (requireAll || input.capabilities !== undefined) {
        result.capabilities = uniqueTextArray(input.capabilities, `${label}.capabilities`, 0, 64, capability);
      }
      return result;
    }

    function normalizeLifecycleInput(input, label, idKey) {
      assertRecord(input, label);
      assertAllowedKeys(input, [idKey], label);
      return { [idKey]: resourceId(input[idKey], `${label}.${idKey}`) };
    }

    function normalizeCommandInput(command, input, label) {
      assertRecord(input, label);
      if (command === "agent.create") {
        assertAllowedKeys(input, ["displayName", "description", "kind", "provider", "model", "capabilities"], label);
        return mutableAgentFields(input, label, true);
      }
      if (command === "agent.update") {
        assertAllowedKeys(input, ["agentId", "displayName", "description", "kind", "provider", "model", "capabilities"], label);
        const result = { agentId: resourceId(input.agentId, `${label}.agentId`), ...mutableAgentFields(input, label, false) };
        if (Reflect.ownKeys(result).length === 1) throw new TypeError(`${label} must contain at least one mutable field.`);
        return result;
      }
      if (["agent.pause", "agent.resume", "agent.archive", "agent.restore", "agent.remove"].includes(command)) {
        return normalizeLifecycleInput(input, label, "agentId");
      }
      if (command === "prompt.revise") {
        assertAllowedKeys(input, ["agentId", "title", "body", "basePromptId"], label);
        const result = {
          agentId: resourceId(input.agentId, `${label}.agentId`),
          title: requiredText(input.title, `${label}.title`, 160),
          body: requiredText(input.body, `${label}.body`, 32768)
        };
        if (input.basePromptId !== undefined) result.basePromptId = resourceId(input.basePromptId, `${label}.basePromptId`);
        return result;
      }
      if (["prompt.activate", "prompt.archive"].includes(command)) {
        return normalizeLifecycleInput(input, label, "promptId");
      }
      if (command === "enrollment.issue") {
        assertAllowedKeys(input, ["agentId", "expiresInSeconds"], label);
        return {
          agentId: resourceId(input.agentId, `${label}.agentId`),
          expiresInSeconds: positiveInteger(input.expiresInSeconds, `${label}.expiresInSeconds`, 86400)
        };
      }
      if (command === "enrollment.revoke") return normalizeLifecycleInput(input, label, "enrollmentId");
      if (command === "attestation.create") {
        assertAllowedKeys(input, ["title", "description", "owner", "dueAt"], label);
        const result = { title: requiredText(input.title, `${label}.title`, 200) };
        setOptionalText(result, input, "description", label, 4000);
        setOptionalText(result, input, "owner", label, 160);
        if (input.dueAt !== undefined) result.dueAt = nullableTimestamp(input.dueAt, `${label}.dueAt`);
        return result;
      }
      if (command === "attestation.update") {
        assertAllowedKeys(input, ["attestationId", "title", "description", "owner", "dueAt"], label);
        const result = { attestationId: resourceId(input.attestationId, `${label}.attestationId`) };
        if (input.title !== undefined) result.title = requiredText(input.title, `${label}.title`, 200);
        setOptionalText(result, input, "description", label, 4000);
        setOptionalText(result, input, "owner", label, 160);
        if (input.dueAt !== undefined) result.dueAt = nullableTimestamp(input.dueAt, `${label}.dueAt`);
        if (Reflect.ownKeys(result).length === 1) throw new TypeError(`${label} must contain at least one mutable field.`);
        return result;
      }
      if (command === "attestation.transition") {
        assertAllowedKeys(input, ["attestationId", "status", "note"], label);
        const status = enumValue(input.status, ATTESTATION_STATUSES, `${label}.status`);
        if (status === "archived") throw new TypeError(`${label}.status must use attestation.archive for archived transitions.`);
        const result = { attestationId: resourceId(input.attestationId, `${label}.attestationId`), status };
        setOptionalText(result, input, "note", label, 1000);
        return result;
      }
      if (["attestation.archive", "attestation.restore", "attestation.remove"].includes(command)) {
        return normalizeLifecycleInput(input, label, "attestationId");
      }
      if (command === "risk.create") {
        assertAllowedKeys(input, ["title", "description", "owner", "likelihood", "impact", "reviewAt"], label);
        const result = {
          title: requiredText(input.title, `${label}.title`, 200),
          likelihood: enumValue(input.likelihood, RISK_LEVELS, `${label}.likelihood`),
          impact: enumValue(input.impact, RISK_LEVELS, `${label}.impact`)
        };
        setOptionalText(result, input, "description", label, 4000);
        setOptionalText(result, input, "owner", label, 160);
        if (input.reviewAt !== undefined) result.reviewAt = nullableTimestamp(input.reviewAt, `${label}.reviewAt`);
        return result;
      }
      if (command === "risk.update") {
        assertAllowedKeys(input, ["riskId", "title", "description", "owner", "likelihood", "impact", "reviewAt"], label);
        const result = { riskId: resourceId(input.riskId, `${label}.riskId`) };
        if (input.title !== undefined) result.title = requiredText(input.title, `${label}.title`, 200);
        setOptionalText(result, input, "description", label, 4000);
        setOptionalText(result, input, "owner", label, 160);
        if (input.likelihood !== undefined) result.likelihood = enumValue(input.likelihood, RISK_LEVELS, `${label}.likelihood`);
        if (input.impact !== undefined) result.impact = enumValue(input.impact, RISK_LEVELS, `${label}.impact`);
        if (input.reviewAt !== undefined) result.reviewAt = nullableTimestamp(input.reviewAt, `${label}.reviewAt`);
        if (Reflect.ownKeys(result).length === 1) throw new TypeError(`${label} must contain at least one mutable field.`);
        return result;
      }
      if (command === "risk.transition") {
        assertAllowedKeys(input, ["riskId", "status", "note"], label);
        const status = enumValue(input.status, RISK_STATUSES, `${label}.status`);
        if (status === "archived") throw new TypeError(`${label}.status must use risk.archive for archived transitions.`);
        const result = { riskId: resourceId(input.riskId, `${label}.riskId`), status };
        setOptionalText(result, input, "note", label, 1000);
        return result;
      }
      return normalizeLifecycleInput(input, label, "riskId");
    }

    function validateCommandRequest(value) {
      const label = "administration command request";
      assertRecord(value, label);
      assertAllowedKeys(value, [
        "schemaVersion", "documentType", "requestId", "command", "requestedAt", "expectedRevision", "input"
      ], label);
      if (value.schemaVersion !== VERSION) throw new TypeError(`${label}.schemaVersion must be ${VERSION}.`);
      if (value.documentType !== "administration-command-request") {
        throw new TypeError(`${label}.documentType must be administration-command-request.`);
      }
      const command = enumValue(value.command, COMMANDS, `${label}.command`);
      return deepFreeze({
        schemaVersion: VERSION,
        documentType: "administration-command-request",
        requestId: resourceId(value.requestId, `${label}.requestId`),
        command,
        requestedAt: timestamp(value.requestedAt, `${label}.requestedAt`),
        expectedRevision: unsignedInteger(value.expectedRevision, `${label}.expectedRevision`),
        input: normalizeCommandInput(command, value.input, `${label}.input`)
      });
    }

    function normalizeCommandError(value, label) {
      assertRecord(value, label);
      assertAllowedKeys(value, ["code", "message", "field", "retryable"], label);
      const result = {
        code: enumValue(value.code, ERROR_CODES, `${label}.code`),
        message: requiredText(value.message, `${label}.message`, 500),
        retryable: value.retryable
      };
      if (typeof result.retryable !== "boolean") throw new TypeError(`${label}.retryable must be a boolean.`);
      if (value.field !== undefined) {
        const field = requiredText(value.field, `${label}.field`, 160);
        if (!/^[A-Za-z][A-Za-z0-9.-]*$/.test(field)) throw new TypeError(`${label}.field must be a normalized field path.`);
        result.field = field;
      }
      return result;
    }

    function normalizeOneTimeCredential(value, label) {
      assertRecord(value, label);
      assertAllowedKeys(value, ["value", "expiresAt", "purpose"], label);
      if (value.purpose !== "agent-enrollment") throw new TypeError(`${label}.purpose must be agent-enrollment.`);
      return {
        value: requiredText(value.value, `${label}.value`, 1024),
        expiresAt: timestamp(value.expiresAt, `${label}.expiresAt`),
        purpose: "agent-enrollment"
      };
    }

    function outputStateFor(command, input, state) {
      const fixed = {
        "agent.create": "active", "agent.pause": "paused", "agent.resume": "active",
        "agent.archive": "archived", "agent.restore": "active", "agent.remove": "removed",
        "prompt.revise": "draft", "prompt.activate": "active", "prompt.archive": "archived",
        "enrollment.issue": "issued", "enrollment.revoke": "revoked",
        "attestation.create": "draft", "attestation.archive": "archived", "attestation.remove": "removed",
        "risk.create": "open", "risk.archive": "archived", "risk.remove": "removed"
      };
      if (fixed[command] !== undefined && state !== fixed[command]) {
        throw new TypeError(`administration command result.output.state must be ${fixed[command]}.`);
      }
      if (command === "attestation.transition" && state !== input.status) {
        throw new TypeError("administration command result.output.state must match the requested attestation status.");
      }
      if (command === "risk.transition" && state !== input.status) {
        throw new TypeError("administration command result.output.state must match the requested risk status.");
      }
      return state;
    }

    function normalizeCommandOutput(command, value, request, label) {
      assertRecord(value, label);
      if (command.startsWith("agent.")) {
        assertAllowedKeys(value, ["agentId", "state", "revision"], label);
        const state = outputStateFor(command, request.input, requiredText(value.state, `${label}.state`, 32));
        if (command === "agent.update" && !AGENT_STATES.includes(state)) throw new TypeError(`${label}.state must be an agent state.`);
        return { agentId: resourceId(value.agentId, `${label}.agentId`), state, revision: unsignedInteger(value.revision, `${label}.revision`) };
      }
      if (command.startsWith("prompt.")) {
        assertAllowedKeys(value, ["promptId", "agentId", "version", "state", "revision"], label);
        return {
          promptId: resourceId(value.promptId, `${label}.promptId`),
          agentId: resourceId(value.agentId, `${label}.agentId`),
          version: positiveInteger(value.version, `${label}.version`, 1000000),
          state: outputStateFor(command, request.input, enumValue(value.state, PROMPT_STATES, `${label}.state`)),
          revision: unsignedInteger(value.revision, `${label}.revision`)
        };
      }
      if (command.startsWith("enrollment.")) {
        const allowed = command === "enrollment.issue"
          ? ["enrollmentId", "agentId", "state", "revision", "oneTimeCredential"]
          : ["enrollmentId", "agentId", "state", "revision"];
        assertAllowedKeys(value, allowed, label, command === "enrollment.issue" ? ["oneTimeCredential"] : []);
        const result = {
          enrollmentId: resourceId(value.enrollmentId, `${label}.enrollmentId`),
          agentId: resourceId(value.agentId, `${label}.agentId`),
          state: outputStateFor(command, request.input, enumValue(value.state, ENROLLMENT_STATES, `${label}.state`)),
          revision: unsignedInteger(value.revision, `${label}.revision`)
        };
        if (value.oneTimeCredential !== undefined) {
          result.oneTimeCredential = normalizeOneTimeCredential(value.oneTimeCredential, `${label}.oneTimeCredential`);
        }
        return result;
      }
      if (command.startsWith("attestation.")) {
        assertAllowedKeys(value, ["attestationId", "state", "revision"], label);
        const state = outputStateFor(command, request.input, requiredText(value.state, `${label}.state`, 32));
        if (![...ATTESTATION_STATUSES, "removed"].includes(state)) throw new TypeError(`${label}.state must be an attestation state.`);
        if (command === "attestation.restore" && (state === "archived" || state === "removed")) {
          throw new TypeError(`${label}.state must be a restored attestation state.`);
        }
        return {
          attestationId: resourceId(value.attestationId, `${label}.attestationId`),
          state,
          revision: unsignedInteger(value.revision, `${label}.revision`)
        };
      }
      assertAllowedKeys(value, ["riskId", "state", "revision"], label);
      const state = outputStateFor(command, request.input, requiredText(value.state, `${label}.state`, 32));
      if (![...RISK_STATUSES, "removed"].includes(state)) throw new TypeError(`${label}.state must be a risk state.`);
      if (command === "risk.restore" && (state === "archived" || state === "removed")) {
        throw new TypeError(`${label}.state must be a restored risk state.`);
      }
      return { riskId: resourceId(value.riskId, `${label}.riskId`), state, revision: unsignedInteger(value.revision, `${label}.revision`) };
    }

    function validateCommandResult(value, requestValue) {
      const label = "administration command result";
      assertRecord(value, label);
      assertAllowedKeys(value, [
        "schemaVersion", "documentType", "requestId", "command", "status", "completedAt", "output", "error"
      ], label);
      if (value.schemaVersion !== VERSION) throw new TypeError(`${label}.schemaVersion must be ${VERSION}.`);
      if (value.documentType !== "administration-command-result") {
        throw new TypeError(`${label}.documentType must be administration-command-result.`);
      }
      const request = requestValue === undefined ? null : validateCommandRequest(requestValue);
      const command = enumValue(value.command, COMMANDS, `${label}.command`);
      if (!request) throw new TypeError(`${label} validation requires its command request.`);
      const result = {
        schemaVersion: VERSION,
        documentType: "administration-command-result",
        requestId: resourceId(value.requestId, `${label}.requestId`),
        command,
        status: enumValue(value.status, COMMAND_STATUSES, `${label}.status`),
        completedAt: timestamp(value.completedAt, `${label}.completedAt`)
      };
      if (result.requestId !== request.requestId || command !== request.command) {
        throw new TypeError(`${label} must match the requestId and command of its request.`);
      }
      if (Date.parse(result.completedAt) < Date.parse(request.requestedAt)) {
        throw new TypeError(`${label}.completedAt must not precede the request timestamp.`);
      }
      if (result.status === "succeeded") {
        if (value.error !== undefined) throw new TypeError(`${label}.error must be absent when status is succeeded.`);
        result.output = normalizeCommandOutput(command, value.output, request, `${label}.output`);
        if (result.output.revision <= request.expectedRevision) {
          throw new TypeError(`${label}.output.revision must advance expectedRevision.`);
        }
        if (result.output.oneTimeCredential
          && Date.parse(result.output.oneTimeCredential.expiresAt) <= Date.parse(result.completedAt)) {
          throw new TypeError(`${label}.output.oneTimeCredential.expiresAt must be later than completedAt.`);
        }
        for (const key of ["agentId", "promptId", "enrollmentId", "attestationId", "riskId"] ) {
          if (request.input[key] !== undefined && result.output[key] !== undefined && request.input[key] !== result.output[key]) {
            throw new TypeError(`${label}.output.${key} must match its request.`);
          }
        }
      } else {
        if (value.output !== undefined) throw new TypeError(`${label}.output must be absent unless status is succeeded.`);
        result.error = normalizeCommandError(value.error, `${label}.error`);
      }
      return deepFreeze(result);
    }

    function validateProvider(value) {
      const label = "administration provider";
      assertRecord(value, label);
      assertAllowedKeys(value, ["schemaVersion", "id", "getSnapshot", "getPrompt", "execute", "dispose"], label);
      if (value.schemaVersion !== VERSION) throw new TypeError(`${label}.schemaVersion must be ${VERSION}.`);
      for (const method of ["getSnapshot", "getPrompt", "execute"]) {
        if (typeof value[method] !== "function") throw new TypeError(`${label}.${method} must be a function.`);
      }
      if (value.dispose !== undefined && typeof value.dispose !== "function") {
        throw new TypeError(`${label}.dispose must be a function when supplied.`);
      }
      const source = value;
      const getSnapshot = source.getSnapshot.bind(source);
      const getPrompt = source.getPrompt.bind(source);
      const execute = source.execute.bind(source);
      const dispose = source.dispose === undefined ? null : source.dispose.bind(source);
      const result = {
        schemaVersion: VERSION,
        id: identifier(source.id, `${label}.id`),
        getSnapshot(request) {
          const normalized = validateSnapshotRequest(request);
          return Promise.resolve().then(() => getSnapshot(normalized)).then((response) => validateSnapshot(response, normalized));
        },
        getPrompt(request) {
          const normalized = validatePromptRequest(request);
          return Promise.resolve().then(() => getPrompt(normalized)).then((response) => validatePrompt(response, normalized));
        },
        execute(request) {
          const normalized = validateCommandRequest(request);
          return Promise.resolve().then(() => execute(normalized)).then((response) => validateCommandResult(response, normalized));
        }
      };
      if (dispose) {
        result.dispose = function disposeProvider() {
          return Promise.resolve().then(() => dispose()).then(() => undefined);
        };
      }
      return Object.freeze(result);
    }

    function resolveProvider(globalName = "SOC_CONSOLE_ADMINISTRATION") {
      if (typeof globalName !== "string" || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(globalName)) {
        throw new TypeError("Administration provider global name must be a JavaScript global identifier.");
      }
      const candidate = global ? global[globalName] : undefined;
      return candidate === undefined || candidate === null ? null : validateProvider(candidate);
    }

    function validateDocument(value, options) {
      assertRecord(value, "administration document");
      const settings = options === undefined ? {} : options;
      assertRecord(settings, "administration document options");
      assertAllowedKeys(settings, ["request"], "administration document options");
      switch (value.documentType) {
        case "administration-snapshot-request": return validateSnapshotRequest(value);
        case "agent-administration-snapshot":
        case "governance-administration-snapshot": return validateSnapshot(value, settings.request);
        case "agent-prompt-request": return validatePromptRequest(value);
        case "agent-prompt": return validatePrompt(value, settings.request);
        case "administration-command-request": return validateCommandRequest(value);
        case "administration-command-result": return validateCommandResult(value, settings.request);
        default: throw new TypeError(`administration document.documentType must be one of: ${DOCUMENT_TYPES.join(", ")}.`);
      }
    }

    return Object.freeze({
      VERSION,
      DOMAINS,
      DOCUMENT_TYPES,
      SNAPSHOT_REASONS,
      AGENT_STATES,
      AGENT_KINDS,
      PROMPT_STATES,
      ENROLLMENT_STATES,
      ATTESTATION_STATUSES,
      RISK_STATUSES,
      RISK_LEVELS,
      COMMANDS,
      COMMAND_STATUSES,
      ERROR_CODES,
      CHANGE_ACTIONS,
      CHANGE_STATUSES,
      validateSnapshotRequest,
      validateSnapshot,
      validatePromptRequest,
      validatePrompt,
      validateCommandRequest,
      validateCommandResult,
      validateProvider,
      resolveProvider,
      validateDocument,
      commandDomain
    });
  }
));
