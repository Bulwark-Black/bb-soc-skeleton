"use strict";

const crypto = require("node:crypto");
const ConnectorContract = require("../public/connector-contract");
const { validateIngestBatch, validateTimestamp } = require("../tools/ingest-contract");
const {
  REFERENCE_CONNECTOR_MANIFESTS,
  getReferenceManifest,
  scaledHealthThresholds
} = require("./reference-manifest");
const { createPageEnvelope } = require("./reference-pages");
const {
  MAX_RECORDS, MAX_RECEIPTS, ReferenceStateStore, clone, generateCredential,
  hashCredential, secureEqualHex, stableId
} = require("./reference-store");

const ENROLLMENT_TTL_MS = 10 * 60 * 1000;
const INGEST_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const CONNECTION_STALE_MS = 15 * 60 * 1000;
const CONNECTION_OFFLINE_MS = 60 * 60 * 1000;
const REQUEST_FUTURE_SKEW_MS = 5 * 60 * 1000;

class ReferenceControlError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "ReferenceControlError";
    this.code = code;
    this.status = options.status || 400;
    this.field = options.field;
    this.retryable = options.retryable === true;
  }
}

function canonicalHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function dateAt(clock) {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError("Reference clock returned an invalid date.");
  return value;
}

function laterTimestamp(clock, requestedAt) {
  const now = dateAt(clock);
  const requested = new Date(requestedAt);
  return new Date(Math.max(now.getTime(), requested.getTime())).toISOString();
}

function credentialExpiry(now, ttlMs) {
  return new Date(now.getTime() + ttlMs).toISOString();
}

function trimBounded(array, maximum) {
  if (array.length > maximum) array.splice(0, array.length - maximum);
}

function makeHealth(source, now, state, reason, updates = {}) {
  const previous = source.health && source.health.counters
    ? source.health.counters
    : { attempts: 0, successfulAttempts: 0, receivedRecords: 0, acceptedRecords: 0, rejectedRecords: 0 };
  return {
    schemaVersion: "1",
    documentType: "source-health-snapshot",
    sourceId: source.sourceId,
    connectorInstanceId: source.connectorInstanceId,
    revision: source.revision,
    observedAt: now,
    state,
    reason,
    lastAttemptAt: updates.lastAttemptAt === undefined ? (source.health ? source.health.lastAttemptAt : null) : updates.lastAttemptAt,
    lastSuccessAt: updates.lastSuccessAt === undefined ? (source.health ? source.health.lastSuccessAt : null) : updates.lastSuccessAt,
    nextExpectedAt: updates.nextExpectedAt === undefined ? (source.health ? source.health.nextExpectedAt : null) : updates.nextExpectedAt,
    counters: {
      attempts: previous.attempts + (updates.attempts || 0),
      successfulAttempts: previous.successfulAttempts + (updates.successfulAttempts || 0),
      receivedRecords: previous.receivedRecords + (updates.receivedRecords || 0),
      acceptedRecords: previous.acceptedRecords + (updates.acceptedRecords || 0),
      rejectedRecords: previous.rejectedRecords + (updates.rejectedRecords || 0)
    },
    message: updates.message || (state === "healthy" ? "A canonical delivery was durably accepted." : "Awaiting the first canonical delivery.")
  };
}

function addChange(state, resourceType, resourceId, action, status, at, message) {
  const change = { changeId: stableId("change"), resourceType, resourceId, action, status, at };
  if (message) change.message = message;
  state.changes.push(change);
  trimBounded(state.changes, 200);
}

function resultWithoutCredential(result) {
  const safe = clone(result);
  if (safe.output) delete safe.output.oneTimeCredential;
  return safe;
}

function cacheCommand(state, request, requestHash, result, revision, at) {
  state.commandResults.push({
    requestId: request.requestId,
    requestHash,
    command: request.command,
    result: resultWithoutCredential(result),
    revision,
    at
  });
  trimBounded(state.commandResults, 1000);
}

function commandErrorStatus(code) {
  if (code === "revision-conflict" || code === "already-exists") return "conflict";
  if (["validation-failed", "not-authorized", "activation-blocked", "credential-reference-unavailable"].includes(code)) return "rejected";
  return "failed";
}

function commandTarget(request) {
  const input = request.input || {};
  if (request.command === "app.register") return { type: "app", id: request.requestId, action: "app.registered" };
  if (request.command === "host.enroll") return { type: "host", id: input.hostId, action: "host.enrolled" };
  if (request.command === "source.test") return { type: "source", id: input.sourceId, action: "source.tested" };
  if (request.command === "source.activate") return { type: "source", id: input.sourceId, action: "source.activated" };
  return { type: "source", id: request.requestId, action: "source.configured" };
}

function validateConnectionCheck(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ReferenceControlError("validation-failed", "Connection check must be an object.");
  const allowed = ["schemaVersion", "documentType", "appId", "hostId", "observedAt", "nonce"];
  if (Object.keys(value).some((key) => !allowed.includes(key)) || Object.keys(value).length !== allowed.length) {
    throw new ReferenceControlError("validation-failed", "Connection check fields are invalid.");
  }
  if (value.schemaVersion !== "1" || value.documentType !== "connection-check") {
    throw new ReferenceControlError("validation-failed", "Connection check contract version is unsupported.");
  }
  for (const key of ["appId", "hostId", "nonce"]) {
    if (typeof value[key] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value[key])) {
      throw new ReferenceControlError("validation-failed", "Connection check identity is invalid.", { field: key });
    }
  }
  let observedAt;
  try {
    observedAt = validateTimestamp(value.observedAt, "connection check observedAt");
  } catch {
    throw new ReferenceControlError("validation-failed", "Connection check observedAt is invalid.", { field: "observedAt" });
  }
  return {
    schemaVersion: "1",
    documentType: "connection-check",
    appId: value.appId,
    hostId: value.hostId,
    observedAt: new Date(observedAt).toISOString(),
    nonce: value.nonce
  };
}

class ReferenceControlPlane {
  constructor(options) {
    if (!options || typeof options !== "object") throw new TypeError("ReferenceControlPlane options are required.");
    this.clock = typeof options.clock === "function" ? options.clock : () => new Date();
    this.enrollmentTtlMs = options.enrollmentTtlMs || ENROLLMENT_TTL_MS;
    this.ingestTtlMs = options.ingestTtlMs || INGEST_TTL_MS;
    if (!Number.isSafeInteger(this.enrollmentTtlMs) || this.enrollmentTtlMs < 60_000 || this.enrollmentTtlMs > 60 * 60 * 1000) {
      throw new TypeError("Reference enrollment TTL must be from one minute through one hour.");
    }
    if (!Number.isSafeInteger(this.ingestTtlMs) || this.ingestTtlMs < 60_000 || this.ingestTtlMs > INGEST_TTL_MS) {
      throw new TypeError("Reference ingest TTL must be from one minute through one year.");
    }
    this.manifests = REFERENCE_CONNECTOR_MANIFESTS.map(ConnectorContract.validateConnectorManifest);
    this.store = options.store || new ReferenceStateStore({ directory: options.stateDirectory, clock: this.clock });
  }

  dispose() {
    if (this.store && typeof this.store.close === "function") this.store.close();
  }

  getState() {
    return this.store.snapshot();
  }

  getSnapshot(request) {
    ConnectorContract.validateControlRequest(request);
    const state = this.store.snapshot();
    const now = dateAt(this.clock);
    const hosts = state.hosts.map((host) => {
      const projected = clone(host);
      if (host.connectionState === "proven" && host.lastProvenAt) {
        const age = now.getTime() - Date.parse(host.lastProvenAt);
        if (age > CONNECTION_OFFLINE_MS) projected.connectionState = "offline";
        else if (age > CONNECTION_STALE_MS) projected.connectionState = "stale";
      }
      return projected;
    });
    const projectedSources = state.sources.map((source) => {
      const projected = clone(source);
      const cadence = source.config["cadence-seconds"];
      const thresholds = scaledHealthThresholds(source.connectorType, cadence);
      if (source.state === "active" && source.health.lastSuccessAt) {
        const ageSeconds = Math.max(0, (now.getTime() - Date.parse(source.health.lastSuccessAt)) / 1000);
        if (ageSeconds > thresholds.offlineAfterSeconds) {
          projected.health = makeHealth(projected, now.toISOString(), "offline", "late", { message: "No successful delivery within the manifest-scaled offline threshold." });
        } else if (ageSeconds > thresholds.staleAfterSeconds) {
          projected.health = makeHealth(projected, now.toISOString(), "stale", "late", { message: "The latest delivery exceeds the manifest-scaled stale threshold." });
        } else {
          projected.health.observedAt = now.toISOString();
        }
      } else {
        projected.health.observedAt = now.toISOString();
      }
      return projected;
    });
    const document = {
      schemaVersion: "1",
      documentType: "connector-control-snapshot",
      connectorTypes: this.manifests,
      apps: state.apps,
      hosts,
      connectorInstances: state.connectorInstances,
      setups: projectedSources.filter((source) => source.state === "configured" || source.state === "tested"),
      sources: projectedSources.filter((source) => source.state === "active"),
      changes: state.changes,
      revision: state.revision
    };
    return ConnectorContract.validateControlSnapshot(document);
  }

  readPage(route, query) {
    return createPageEnvelope(route, query || {}, this.store.snapshot(), dateAt(this.clock));
  }

  execute(requestValue) {
    let request = ConnectorContract.validateCommandRequest(requestValue);
    if (request.command === "source.setup") {
      const manifest = getReferenceManifest(request.input.connectorType);
      if (!manifest) throw new TypeError("connector command request.input.connectorType is unavailable in reference mode.");
      request = ConnectorContract.validateCommandRequest(requestValue, manifest);
    }
    if (Date.parse(request.requestedAt) > dateAt(this.clock).getTime() + REQUEST_FUTURE_SKEW_MS) {
      throw new TypeError("connector command request.requestedAt may not be more than five minutes in the future.");
    }
    const requestHash = canonicalHash(request);
    const prior = this.store.snapshot().commandResults.find((entry) => entry.requestId === request.requestId);
    if (prior) {
      if (prior.requestHash !== requestHash) {
        return this.failureResult(request, new ReferenceControlError("already-exists", "requestId was already used for a different command.", { status: 409 }), false);
      }
      return ConnectorContract.validateCommandResult(prior.result, request);
    }

    try {
      let result;
      if (request.command === "app.register") result = this.registerApp(request, requestHash);
      else if (request.command === "host.enroll") result = this.enrollHost(request, requestHash);
      else if (request.command === "source.setup") result = this.setupSource(request, requestHash);
      else if (request.command === "source.test") result = this.testSource(request, requestHash);
      else result = this.activateSource(request, requestHash);
      return ConnectorContract.validateCommandResult(result, request);
    } catch (error) {
      if (!(error instanceof ReferenceControlError)) throw error;
      return this.failureResult(request, error, true, requestHash);
    }
  }

  failureResult(request, error, persist, requestHash) {
    const completedAt = laterTimestamp(this.clock, request.requestedAt);
    const problem = {
      code: error.code,
      message: error.message,
      retryable: error.retryable === true
    };
    if (error.field) problem.field = error.field;
    const result = {
      schemaVersion: "1",
      documentType: "connector-command-result",
      requestId: request.requestId,
      command: request.command,
      status: commandErrorStatus(error.code),
      completedAt,
      error: problem
    };
    if (persist) {
      const target = commandTarget(request);
      this.store.transact({
        action: request.command,
        actor: "loopback:operator",
        targetType: target.type,
        targetId: target.id,
        detail: "command completed with " + error.code
      }, (state) => {
        addChange(state, target.type, target.id, target.action, result.status, completedAt, error.message);
        cacheCommand(state, request, requestHash, result, state.revision + 1, completedAt);
      });
    }
    return ConnectorContract.validateCommandResult(result, request);
  }

  registerApp(request, requestHash) {
    const now = laterTimestamp(this.clock, request.requestedAt);
    const appId = stableId("app");
    const hostIds = request.input.hosts.map(() => stableId("host"));
    const normalizedHosts = request.input.hosts.map((name) => name.toLocaleLowerCase());
    if (new Set(normalizedHosts).size !== normalizedHosts.length) {
      throw new ReferenceControlError("already-exists", "Host display names must be unique without regard to case.", { status: 409, field: "input.hosts" });
    }
    const duplicateHost = this.store.snapshot().hosts.find((host) =>
      request.input.hosts.some((name) => name.toLocaleLowerCase() === host.displayName.toLocaleLowerCase()));
    if (duplicateHost) throw new ReferenceControlError("already-exists", "A host with that display name is already registered.", { status: 409, field: "input.hosts" });
    const result = {
      schemaVersion: "1", documentType: "connector-command-result", requestId: request.requestId,
      command: request.command, status: "succeeded", completedAt: now,
      output: { appId, state: "registered" }
    };
    this.store.transact({
      action: "app.register", actor: "loopback:operator", targetType: "app", targetId: appId,
      detail: "registered application and declared hosts"
    }, (state) => {
      state.apps.push({
        appId, displayName: request.input.displayName, hosts: hostIds, publicPages: request.input.publicPages,
        state: "registered", revision: 1, createdAt: now, updatedAt: now
      });
      request.input.hosts.forEach((displayName, index) => state.hosts.push({
        hostId: hostIds[index], appId, displayName, state: "pending", connectionState: "unknown",
        lastProvenAt: null, revision: 1, createdAt: now, updatedAt: now
      }));
      addChange(state, "app", appId, "app.registered", "succeeded", now, "Application and host declarations registered.");
      cacheCommand(state, request, requestHash, result, state.revision + 1, now);
    });
    return result;
  }

  enrollHost(request, requestHash) {
    const snapshot = this.store.snapshot();
    const app = snapshot.apps.find((entry) => entry.appId === request.input.appId);
    const host = snapshot.hosts.find((entry) => entry.hostId === request.input.hostId);
    if (!app || !host || host.appId !== app.appId) throw new ReferenceControlError("not-found", "The requested host was not found.", { status: 404 });
    const nowDate = dateAt(this.clock);
    const now = new Date(Math.max(nowDate.getTime(), Date.parse(request.requestedAt))).toISOString();
    const expiresAt = credentialExpiry(new Date(now), this.enrollmentTtlMs);
    const credential = generateCredential();
    const credentialId = stableId("credential");
    const result = {
      schemaVersion: "1", documentType: "connector-command-result", requestId: request.requestId,
      command: request.command, status: "succeeded", completedAt: now,
      output: {
        appId: app.appId, hostId: host.hostId, state: "enrolled",
        oneTimeCredential: { value: credential, expiresAt, purpose: "connection-check" }
      }
    };
    this.store.transact({
      action: "host.enroll", actor: "loopback:operator", targetType: "host", targetId: host.hostId,
      detail: "issued one-time connection-check credential"
    }, (state) => {
      state.enrollments.forEach((entry) => {
        if (entry.hostId === host.hostId && entry.consumedAt === null && entry.revokedAt === null) entry.revokedAt = now;
      });
      state.enrollments.push({
        credentialId, appId: app.appId, hostId: host.hostId, hash: hashCredential(credential),
        createdAt: now, expiresAt, consumedAt: null, revokedAt: null
      });
      const mutableHost = state.hosts.find((entry) => entry.hostId === host.hostId);
      mutableHost.state = "enrolled";
      mutableHost.connectionState = "pending";
      mutableHost.revision += 1;
      mutableHost.updatedAt = now;
      addChange(state, "host", host.hostId, "host.enrolled", "succeeded", now, "One-time connection check is pending.");
      cacheCommand(state, request, requestHash, result, state.revision + 1, now);
    });
    return result;
  }

  setupSource(request, requestHash) {
    const state = this.store.snapshot();
    const app = state.apps.find((entry) => entry.appId === request.input.appId);
    const host = state.hosts.find((entry) => entry.hostId === request.input.hostId);
    if (!app || !host || host.appId !== app.appId) throw new ReferenceControlError("not-found", "The requested application or host was not found.", { status: 404 });
    if (host.state !== "enrolled") throw new ReferenceControlError("activation-blocked", "Enroll the host before configuring a source.", { status: 422 });
    const connectorInstanceId = stableId("connector");
    const sourceId = stableId("source");
    const now = laterTimestamp(this.clock, request.requestedAt);
    const result = {
      schemaVersion: "1", documentType: "connector-command-result", requestId: request.requestId,
      command: request.command, status: "succeeded", completedAt: now,
      output: { appId: app.appId, sourceId, connectorInstanceId, revision: 1, state: "configured" }
    };
    this.store.transact({
      action: "source.setup", actor: "loopback:operator", targetType: "source", targetId: sourceId,
      detail: "configured manifest-backed source"
    }, (next) => {
      next.connectorInstances.push({
        connectorInstanceId, appId: app.appId, connectorType: request.input.connectorType,
        displayName: request.input.displayName, state: "configured", config: request.input.config,
        credentialReferences: request.input.credentialReferences, revision: 1, createdAt: now, updatedAt: now
      });
      const source = {
        schemaVersion: "1", documentType: "source-registration", sourceId, connectorInstanceId,
        appId: app.appId, hostId: host.hostId, connectorType: request.input.connectorType,
        sourceKind: request.input.sourceKind, displayName: request.input.displayName, state: "configured",
        config: request.input.config, credentialReferences: request.input.credentialReferences,
        revision: 1, createdAt: now, updatedAt: now
      };
      source.health = makeHealth(source, now, "pending", "awaiting-first-delivery");
      next.sources.push(source);
      addChange(next, "connector-instance", connectorInstanceId, "connector-instance.configured", "succeeded", now, "Connector instance configured.");
      addChange(next, "source", sourceId, "source.configured", "succeeded", now, "Source identity configured.");
      cacheCommand(next, request, requestHash, result, next.revision + 1, now);
    });
    return result;
  }

  testSource(request, requestHash) {
    const state = this.store.snapshot();
    const source = state.sources.find((entry) => entry.sourceId === request.input.sourceId);
    const connector = state.connectorInstances.find((entry) => entry.connectorInstanceId === request.input.connectorInstanceId);
    if (!source || !connector || source.connectorInstanceId !== connector.connectorInstanceId) {
      throw new ReferenceControlError("not-found", "The requested source and connector instance were not found.", { status: 404 });
    }
    if (source.revision !== request.input.expectedRevision) throw new ReferenceControlError("revision-conflict", "Source revision changed; refresh and retry.", { status: 409 });
    if (source.state !== "configured" || connector.state !== "configured") throw new ReferenceControlError("test-failed", "Only a configured source can be tested.", { status: 422 });
    if (source.connectorType !== "canonical-push") {
      throw new ReferenceControlError(
        "connector-unavailable",
        "This installed scan manifest is a data-only connection template. Install its reviewed server driver before testing or activation.",
        { status: 422 }
      );
    }
    const host = state.hosts.find((entry) => entry.hostId === source.hostId);
    const proofAge = host && host.lastProvenAt
      ? dateAt(this.clock).getTime() - Date.parse(host.lastProvenAt)
      : Number.POSITIVE_INFINITY;
    if (!host || host.connectionState !== "proven" || proofAge < 0 || proofAge > CONNECTION_STALE_MS) {
      throw new ReferenceControlError("test-failed", "Complete the one-time connection check before testing this source.", { status: 422 });
    }
    const revision = source.revision + 1;
    const now = laterTimestamp(this.clock, request.requestedAt);
    const result = {
      schemaVersion: "1", documentType: "connector-command-result", requestId: request.requestId,
      command: request.command, status: "succeeded", completedAt: now,
      output: { sourceId: source.sourceId, connectorInstanceId: connector.connectorInstanceId, revision, state: "tested" }
    };
    this.store.transact({
      action: "source.test", actor: "loopback:operator", targetType: "source", targetId: source.sourceId,
      detail: "completed local structural source test without vendor egress"
    }, (next) => {
      const mutableSource = next.sources.find((entry) => entry.sourceId === source.sourceId);
      const mutableConnector = next.connectorInstances.find((entry) => entry.connectorInstanceId === connector.connectorInstanceId);
      mutableSource.state = "tested";
      mutableSource.revision = revision;
      mutableSource.updatedAt = now;
      mutableSource.health.revision = revision;
      mutableSource.health.observedAt = now;
      mutableConnector.state = "tested";
      mutableConnector.revision += 1;
      mutableConnector.updatedAt = now;
      addChange(next, "connector-instance", connector.connectorInstanceId, "connector-instance.tested", "succeeded", now, "Local structural test passed.");
      addChange(next, "source", source.sourceId, "source.tested", "succeeded", now, "Source is ready for activation.");
      cacheCommand(next, request, requestHash, result, next.revision + 1, now);
    });
    return result;
  }

  activateSource(request, requestHash) {
    const state = this.store.snapshot();
    const source = state.sources.find((entry) => entry.sourceId === request.input.sourceId);
    const connector = state.connectorInstances.find((entry) => entry.connectorInstanceId === request.input.connectorInstanceId);
    if (!source || !connector || source.connectorInstanceId !== connector.connectorInstanceId) {
      throw new ReferenceControlError("not-found", "The requested source and connector instance were not found.", { status: 404 });
    }
    if (source.revision !== request.input.expectedRevision) throw new ReferenceControlError("revision-conflict", "Source revision changed; refresh and retry.", { status: 409 });
    if (source.state !== "tested" || connector.state !== "tested") throw new ReferenceControlError("activation-blocked", "Only a successfully tested source can be activated.", { status: 422 });
    if (source.connectorType !== "canonical-push") {
      throw new ReferenceControlError("connector-unavailable", "A data-only connection template cannot be activated without its reviewed server driver.", { status: 422 });
    }
    const revision = source.revision + 1;
    const nowDate = dateAt(this.clock);
    const now = new Date(Math.max(nowDate.getTime(), Date.parse(request.requestedAt))).toISOString();
    const expiresAt = credentialExpiry(new Date(now), this.ingestTtlMs);
    const credential = generateCredential();
    const credentialId = stableId("credential");
    const result = {
      schemaVersion: "1", documentType: "connector-command-result", requestId: request.requestId,
      command: request.command, status: "succeeded", completedAt: now,
      output: {
        sourceId: source.sourceId, connectorInstanceId: connector.connectorInstanceId,
        revision, state: "active",
        oneTimeCredential: { value: credential, expiresAt, purpose: "source-ingest" }
      }
    };
    this.store.transact({
      action: "source.activate", actor: "loopback:operator", targetType: "source", targetId: source.sourceId,
      detail: "activated source and issued source-bound ingest credential"
    }, (next) => {
      const mutableSource = next.sources.find((entry) => entry.sourceId === source.sourceId);
      const mutableConnector = next.connectorInstances.find((entry) => entry.connectorInstanceId === connector.connectorInstanceId);
      mutableSource.state = "active";
      mutableSource.revision = revision;
      mutableSource.updatedAt = now;
      mutableSource.health.revision = revision;
      mutableSource.health.observedAt = now;
      mutableConnector.state = "active";
      mutableConnector.revision += 1;
      mutableConnector.updatedAt = now;
      next.sourceCredentials.push({
        credentialId, sourceId: source.sourceId, hash: hashCredential(credential),
        createdAt: now, expiresAt, lastUsedAt: null, revokedAt: null
      });
      addChange(next, "connector-instance", connector.connectorInstanceId, "connector-instance.activated", "succeeded", now, "Connector instance activated.");
      addChange(next, "source", source.sourceId, "source.activated", "succeeded", now, "Source is awaiting its first real delivery.");
      cacheCommand(next, request, requestHash, result, next.revision + 1, now);
    });
    return result;
  }

  proveConnection(documentValue, credentialValue) {
    const document = validateConnectionCheck(documentValue);
    const presentedHash = hashCredential(credentialValue);
    if (!presentedHash) throw new ReferenceControlError("not-authorized", "Connection-check credential is invalid.", { status: 401 });
    const state = this.store.snapshot();
    const enrollment = state.enrollments.find((entry) => secureEqualHex(entry.hash, presentedHash));
    const nowDate = dateAt(this.clock);
    if (!enrollment || enrollment.appId !== document.appId || enrollment.hostId !== document.hostId
        || enrollment.consumedAt !== null || enrollment.revokedAt !== null || Date.parse(enrollment.expiresAt) <= nowDate.getTime()) {
      throw new ReferenceControlError("not-authorized", "Connection-check credential is invalid, expired, or already used.", { status: 401 });
    }
    if (Math.abs(nowDate.getTime() - Date.parse(document.observedAt)) > 5 * 60 * 1000) {
      throw new ReferenceControlError("validation-failed", "Connection check is outside the five-minute replay window.", { status: 400, field: "observedAt" });
    }
    const host = state.hosts.find((entry) => entry.hostId === enrollment.hostId && entry.appId === enrollment.appId);
    if (!host) throw new ReferenceControlError("not-found", "Enrollment host was not found.", { status: 404 });
    const now = nowDate.toISOString();
    this.store.transact({
      action: "host.connection-proof", actor: "loopback:agent", targetType: "host", targetId: host.hostId,
      detail: "accepted reserved one-time connection check"
    }, (next) => {
      const mutableEnrollment = next.enrollments.find((entry) => entry.credentialId === enrollment.credentialId);
      const mutableHost = next.hosts.find((entry) => entry.hostId === host.hostId);
      mutableEnrollment.consumedAt = now;
      mutableHost.connectionState = "proven";
      mutableHost.lastProvenAt = now;
      mutableHost.revision += 1;
      mutableHost.updatedAt = now;
    });
    return {
      schemaVersion: "1", documentType: "connection-check-result", appId: host.appId,
      hostId: host.hostId, status: "accepted", acceptedAt: now
    };
  }

  ingest(batchValue, credentialValue, bodyHash) {
    const batch = validateIngestBatch(batchValue);
    if (batch.records.some((record) => record.kind !== "log.event")) {
      throw new ReferenceControlError("validation-failed", "Reference mode accepts only canonical log.event records.", { status: 422, field: "records.kind" });
    }
    if (typeof bodyHash !== "string" || !/^[a-f0-9]{64}$/.test(bodyHash)) throw new TypeError("A SHA-256 body hash is required.");
    const presentedHash = hashCredential(credentialValue);
    if (!presentedHash) throw new ReferenceControlError("not-authorized", "Source ingest credential is invalid.", { status: 401 });
    const state = this.store.snapshot();
    const sourceCredential = state.sourceCredentials.find((entry) => secureEqualHex(entry.hash, presentedHash));
    const nowDate = dateAt(this.clock);
    const latestAllowedEventTime = nowDate.getTime() + 5 * 60 * 1000;
    if (Date.parse(batch.sentAt) > latestAllowedEventTime
        || batch.records.some((record) => Date.parse(record.observedAt) > latestAllowedEventTime)) {
      throw new ReferenceControlError("validation-failed", "Batch and record timestamps may not be more than five minutes in the future.", { status: 422, field: "sentAt" });
    }
    if (!sourceCredential || sourceCredential.revokedAt !== null || Date.parse(sourceCredential.expiresAt) <= nowDate.getTime()) {
      throw new ReferenceControlError("not-authorized", "Source ingest credential is invalid or expired.", { status: 401 });
    }
    if (sourceCredential.sourceId !== batch.sourceId) throw new ReferenceControlError("not-authorized", "Credential is not bound to this source.", { status: 403 });
    const source = state.sources.find((entry) => entry.sourceId === batch.sourceId);
    if (!source || source.state !== "active") throw new ReferenceControlError("activation-blocked", "Source is not active.", { status: 409 });
    if (source.connectorType !== "canonical-push" || source.sourceKind !== "log.event") {
      throw new ReferenceControlError("connector-unavailable", "Reference ingest is available only to the canonical log push driver.", { status: 422 });
    }
    if (batch.records.some((record) => record.estateId !== source.appId)) {
      throw new ReferenceControlError("not-authorized", "Record estateId does not match the source application.", { status: 403, field: "records.estateId" });
    }
    const priorReceipt = state.receipts.find((entry) => entry.sourceId === source.sourceId && entry.receiptId === batch.receiptId);
    if (priorReceipt) {
      if (priorReceipt.bodyHash !== bodyHash) throw new ReferenceControlError("already-exists", "receiptId was already used for a different body.", { status: 409 });
      return {
        schemaVersion: "1", documentType: "ingest-receipt", sourceId: source.sourceId,
        receiptId: priorReceipt.receiptId, status: "accepted", accepted: priorReceipt.accepted,
        duplicates: priorReceipt.duplicates, receivedAt: priorReceipt.receivedAt, replay: true
      };
    }
    if (state.receipts.length >= MAX_RECEIPTS) throw new ReferenceControlError("connector-unavailable", "Reference receipt capacity is exhausted.", { status: 507 });
    const existingRecords = new Map(state.records.filter((record) => record.sourceId === source.sourceId).map((record) => [record.recordId, record]));
    const newRecords = [];
    let duplicates = 0;
    batch.records.forEach((record) => {
      const existing = existingRecords.get(record.recordId);
      if (!existing) {
        newRecords.push(record);
        return;
      }
      const externalExisting = {
        schemaVersion: existing.schemaVersion, documentType: existing.documentType, recordId: existing.recordId,
        sourceId: existing.sourceId, estateId: existing.estateId, kind: existing.kind,
        observedAt: existing.observedAt, payload: existing.payload
      };
      if (canonicalHash(externalExisting) !== canonicalHash(record)) {
        throw new ReferenceControlError("already-exists", "recordId was already used with different content.", { status: 409, field: "records.recordId" });
      }
      duplicates += 1;
    });
    if (state.records.length + newRecords.length > MAX_RECORDS) throw new ReferenceControlError("connector-unavailable", "Reference record capacity is exhausted.", { status: 507 });
    const now = nowDate.toISOString();
    const nextExpectedAt = new Date(nowDate.getTime() + source.config["cadence-seconds"] * 1000).toISOString();
    this.store.transact({
      action: "ingest.accept", actor: "loopback:source", targetType: "source", targetId: source.sourceId,
      detail: "durably accepted bounded canonical log event batch"
    }, (next) => {
      newRecords.forEach((record) => next.records.push({
        ...clone(record), connectorInstanceId: source.connectorInstanceId, hostId: source.hostId, receivedAt: now
      }));
      next.receipts.push({
        sourceId: source.sourceId, receiptId: batch.receiptId, bodyHash, receivedAt: now,
        accepted: newRecords.length, duplicates
      });
      const mutableCredential = next.sourceCredentials.find((entry) => entry.credentialId === sourceCredential.credentialId);
      mutableCredential.lastUsedAt = now;
      const mutableSource = next.sources.find((entry) => entry.sourceId === source.sourceId);
      mutableSource.revision += 1;
      mutableSource.updatedAt = now;
      mutableSource.health = makeHealth(mutableSource, now, "healthy", "none", {
        lastAttemptAt: now, lastSuccessAt: now, nextExpectedAt,
        attempts: 1, successfulAttempts: 1, receivedRecords: batch.records.length,
        acceptedRecords: newRecords.length, message: "A canonical log.event batch was durably accepted."
      });
    });
    return {
      schemaVersion: "1", documentType: "ingest-receipt", sourceId: source.sourceId,
      receiptId: batch.receiptId, status: "accepted", accepted: newRecords.length,
      duplicates, receivedAt: now, replay: false
    };
  }
}

module.exports = {
  CONNECTION_OFFLINE_MS,
  CONNECTION_STALE_MS,
  ENROLLMENT_TTL_MS,
  INGEST_TTL_MS,
  REQUEST_FUTURE_SKEW_MS,
  ReferenceControlError,
  ReferenceControlPlane,
  validateConnectionCheck
};
