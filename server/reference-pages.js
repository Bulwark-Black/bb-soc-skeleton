"use strict";

// Read-only projections for the loopback reference control plane. This module
// deliberately emits the public adapter's data-only page envelopes; it does
// not manufacture operational records or expose stored credentials.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { validateNormalizedRecord } = require("../tools/ingest-contract.js");
const { scaledHealthThresholds } = require("./reference-manifest.js");

const SUPPORTED_PAGE_ROUTES = Object.freeze(["/", "/sources", "/logs", "/analytics", "/health"]);
const SUPPORTED_ROUTE_SET = new Set(SUPPORTED_PAGE_ROUTES);
const MAX_TABLE_ROWS = 200;
const HOUR_MS = 60 * 60 * 1000;

let cachedAdapterRuntime;

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Reflect.ownKeys(value).forEach((key) => deepFreeze(value[key]));
  return Object.freeze(value);
}

function loadAdapterRuntime() {
  if (cachedAdapterRuntime) return cachedAdapterRuntime;
  const filename = path.resolve(__dirname, "..", "public", "adapter-contract.js");
  const context = vm.createContext({});
  context.window = context;
  vm.runInContext(fs.readFileSync(filename, "utf8"), context, { filename });
  if (!context.SocConsoleAdapterRuntime
      || typeof context.SocConsoleAdapterRuntime.validateRequest !== "function"
      || typeof context.SocConsoleAdapterRuntime.validateEnvelope !== "function") {
    throw new TypeError("The public adapter contract did not expose its validation runtime.");
  }

  function invoke(expression, document, expectedRoute) {
    context.__referenceDocument = JSON.stringify(document);
    context.__referenceRoute = expectedRoute;
    try {
      const serialized = vm.runInContext(`JSON.stringify(${expression})`, context);
      return deepFreeze(JSON.parse(serialized));
    } finally {
      delete context.__referenceDocument;
      delete context.__referenceRoute;
    }
  }

  cachedAdapterRuntime = Object.freeze({
    validateRequest(value) {
      return invoke(
        "SocConsoleAdapterRuntime.validateRequest(JSON.parse(__referenceDocument))",
        value
      );
    },
    validateEnvelope(value, expectedRoute) {
      return invoke(
        "SocConsoleAdapterRuntime.validateEnvelope(JSON.parse(__referenceDocument), __referenceRoute)",
        value,
        expectedRoute
      );
    }
  });
  return cachedAdapterRuntime;
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainRecord(value, label) {
  if (!isPlainRecord(value)) throw new TypeError(`${label} must be a plain object.`);
}

function assertDataArray(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  value.forEach((item, index) => assertPlainRecord(item, `${label}[${index}]`));
  return value;
}

function boundedText(value, label, maximum = 300) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\u0000")) {
    throw new TypeError(`${label} must be non-empty bounded text.`);
  }
  return value;
}

function cellText(value, maximum = 2000) {
  if (typeof value !== "string") return value;
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function identifier(value, label) {
  const candidate = boundedText(value, label, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(candidate)) throw new TypeError(`${label} is invalid.`);
  return candidate;
}

function optionalTimestamp(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${label} must be an RFC 3339 date-time or null.`);
  }
  const canonical = new Date(value).toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(canonical)) {
    throw new TypeError(`${label} must be an RFC 3339 date-time or null.`);
  }
  return canonical;
}

function normalizeNow(now) {
  const candidate = now === undefined ? new Date() : now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (Number.isNaN(candidate.getTime())) throw new TypeError("now must identify a valid date-time.");
  return candidate;
}

function validateState(state) {
  assertPlainRecord(state, "state");
  for (const key of ["apps", "hosts", "connectorInstances", "sources", "records"]) {
    if (!Object.prototype.hasOwnProperty.call(state, key)) throw new TypeError(`state.${key} is required.`);
    const descriptor = Object.getOwnPropertyDescriptor(state, key);
    if (!descriptor || descriptor.get || descriptor.set) throw new TypeError(`state.${key} must be a data property.`);
    assertDataArray(state[key], `state.${key}`);
  }
  if (!Number.isSafeInteger(state.revision) || state.revision < 0) {
    throw new TypeError("state.revision must be a non-negative safe integer.");
  }
  return state;
}

function canonicalLogRecords(state) {
  return state.records.flatMap((record, index) => {
    if (record.kind !== "log.event") return [];
    const normalized = validateNormalizedRecord({
      schemaVersion: record.schemaVersion,
      documentType: record.documentType,
      recordId: record.recordId,
      sourceId: record.sourceId,
      estateId: record.estateId,
      kind: record.kind,
      observedAt: record.observedAt,
      payload: record.payload
    });
    if (normalized.kind !== "log.event") {
      throw new TypeError(`state.records[${index}] is not a canonical log.event record.`);
    }
    const result = {
      schemaVersion: normalized.schemaVersion,
      documentType: normalized.documentType,
      recordId: normalized.recordId,
      sourceId: normalized.sourceId,
      estateId: normalized.estateId,
      kind: normalized.kind,
      observedAt: new Date(normalized.observedAt).toISOString(),
      payload: normalized.payload
    };
    if (record.hostId !== undefined && record.hostId !== null) {
      result.hostId = identifier(record.hostId, `state.records[${index}].hostId`);
    }
    return [result];
  });
}

function normalizeHosts(state) {
  return state.hosts.map((host, index) => ({
    hostId: identifier(host.hostId, `state.hosts[${index}].hostId`),
    name: boundedText(host.name === undefined ? host.displayName : host.name, `state.hosts[${index}].name`, 120)
  }));
}

function normalizeConnectors(state) {
  return state.connectorInstances.map((connector, index) => ({
    connectorInstanceId: identifier(
      connector.connectorInstanceId,
      `state.connectorInstances[${index}].connectorInstanceId`
    ),
    connectorType: identifier(connector.connectorType, `state.connectorInstances[${index}].connectorType`),
    state: boundedText(connector.state, `state.connectorInstances[${index}].state`, 40)
  }));
}

function normalizeSources(state, records, nowDate) {
  const hosts = new Map(normalizeHosts(state).map((host) => [host.hostId, host]));
  const connectors = new Map(normalizeConnectors(state).map((connector) => [connector.connectorInstanceId, connector]));
  const recordCounts = new Map();
  records.forEach((record) => recordCounts.set(record.sourceId, (recordCounts.get(record.sourceId) || 0) + 1));

  return state.sources.map((source, index) => {
    const label = `state.sources[${index}]`;
    const sourceId = identifier(source.sourceId, `${label}.sourceId`);
    const connectorInstanceId = identifier(source.connectorInstanceId, `${label}.connectorInstanceId`);
    const connector = connectors.get(connectorInstanceId);
    if (!connector) throw new TypeError(`${label}.connectorInstanceId does not reference a connector instance.`);
    const hostId = identifier(source.hostId, `${label}.hostId`);
    const host = hosts.get(hostId);
    if (!host) throw new TypeError(`${label}.hostId does not reference a host.`);
    const sourceKind = boundedText(source.sourceKind, `${label}.sourceKind`, 120);
    const displayName = boundedText(
      source.label === undefined ? (source.displayName === undefined ? sourceId : source.displayName) : source.label,
      `${label}.displayName`,
      120
    );
    const cadenceSeconds = source.cadenceSeconds === undefined && source.config
      ? source.config["cadence-seconds"]
      : source.cadenceSeconds;
    if (!Number.isSafeInteger(cadenceSeconds) || cadenceSeconds < 1 || cadenceSeconds > 31_536_000) {
      throw new TypeError(`${label}.cadenceSeconds must be a positive bounded integer.`);
    }
    const declaredLastSeen = source.lastSeenAt === undefined && source.health
      ? source.health.lastSuccessAt
      : source.lastSeenAt;
    const lastSeenAt = optionalTimestamp(declaredLastSeen, `${label}.lastSeenAt`);
    const declaredHealth = source.health && typeof source.health.state === "string" ? source.health.state : null;
    const thresholds = scaledHealthThresholds(connector.connectorType, cadenceSeconds);
    const health = sourceHealth(connector.state, declaredHealth, lastSeenAt, thresholds, nowDate);
    return {
      sourceId,
      connectorInstanceId,
      connectorType: connector.connectorType,
      sourceKind,
      displayName,
      hostId,
      hostName: host.name,
      cadenceSeconds,
      lastSeenAt,
      receivedRecords: recordCounts.get(sourceId) || 0,
      state: source.state === undefined ? connector.state : boundedText(source.state, `${label}.state`, 40),
      health
    };
  });
}

function sourceHealth(connectorState, declaredHealth, lastSeenAt, thresholds, nowDate) {
  if (["error", "degraded", "disabled"].includes(declaredHealth)) {
    const state = boundedText(declaredHealth, "source.health.state", 40);
    return { state, tone: healthTone(state), detail: healthDetail(state) };
  }
  if (connectorState === "disabled") return { state: "disabled", tone: "neutral", detail: "Source is disabled" };
  if (connectorState !== "active") return { state: "pending", tone: "warn", detail: "Connector is not active" };
  if (!lastSeenAt) return { state: "pending", tone: "warn", detail: "Awaiting first delivery" };
  const ageSeconds = Math.max(0, (nowDate.getTime() - Date.parse(lastSeenAt)) / 1000);
  if (ageSeconds <= thresholds.staleAfterSeconds) return { state: "healthy", tone: "ok", detail: "Reporting within policy" };
  if (ageSeconds <= thresholds.offlineAfterSeconds) return { state: "stale", tone: "warn", detail: "Delivery is late" };
  return { state: "offline", tone: "bad", detail: "Delivery is overdue" };
}

function healthTone(state) {
  if (state === "healthy") return "ok";
  if (["pending", "degraded", "stale"].includes(state)) return "warn";
  if (["offline", "error"].includes(state)) return "bad";
  return "neutral";
}

function healthDetail(state) {
  const descriptions = {
    healthy: "Reporting within its declared health policy",
    pending: "Awaiting a successful delivery",
    degraded: "Reporting with a degraded condition",
    stale: "Delivery is later than expected",
    offline: "No delivery within the offline threshold",
    error: "The connector reported an error",
    disabled: "Source is disabled",
    unknown: "No health observation is available"
  };
  return descriptions[state] || "Connector supplied this health state";
}

function severityTone(severity) {
  if (["critical", "high"].includes(severity)) return "bad";
  if (severity === "medium") return "warn";
  if (["low", "info"].includes(severity)) return "info";
  return "neutral";
}

function stateTone(state) {
  if (["failed", "open", "warn"].includes(state)) return state === "failed" ? "bad" : "warn";
  if (["closed", "ok", "active"].includes(state)) return "ok";
  return "neutral";
}

function formatCadence(seconds) {
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function formatAge(lastSeenAt, nowDate) {
  if (!lastSeenAt) return "Awaiting first delivery";
  const seconds = Math.max(0, Math.floor((nowDate.getTime() - Date.parse(lastSeenAt)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function emptyEnvelope(route, title, summary, panelId, panelTitle, body, updatedAt) {
  return {
    schemaVersion: "1",
    route,
    state: "empty",
    title,
    summary,
    updatedAt,
    panels: [{ id: panelId, type: "empty", title: panelTitle, body }]
  };
}

function summarySuffix(shown, total) {
  return shown < total ? ` Showing ${shown} of ${total}.` : "";
}

function sourceTable(sources) {
  const shown = sources.slice(0, MAX_TABLE_ROWS);
  return {
    id: "expected-sources",
    type: "table",
    title: "Expected sources",
    caption: "Configured source collection and activity",
    columns: [
      { key: "source", label: "Source" },
      { key: "host", label: "Host" },
      { key: "last-collection", label: "Last collection" },
      { key: "cadence", label: "Cadence" },
      { key: "in-logs", label: "In Logs", align: "right" },
      { key: "collection", label: "Collection" },
      { key: "activity", label: "Activity" }
    ],
    rows: shown.map((source) => [
      source.displayName,
      source.hostName,
      source.lastSeenAt ? { type: "time", value: source.lastSeenAt } : "Never",
      formatCadence(source.cadenceSeconds),
      { type: "number", value: source.receivedRecords, unit: "events" },
      { type: "badge", label: source.health.state, tone: source.health.tone },
      source.lastSeenAt ? formatAge(source.lastSeenAt, source.nowDate || new Date()) : source.health.detail
    ])
  };
}

function projectSources(state, records, sources, nowDate) {
  if (sources.length === 0) {
    return emptyEnvelope(
      "/sources",
      "Sources",
      `Registry revision ${state.revision} contains no configured sources.`,
      "no-sources-configured",
      "No sources connected",
      "Enroll a host and complete source setup, testing, and activation before events can arrive.",
      nowDate.toISOString()
    );
  }
  const ordered = sources.slice().sort((left, right) => left.displayName.localeCompare(right.displayName));
  const table = sourceTable(ordered.map((source) => ({ ...source, nowDate })));
  return {
    schemaVersion: "1",
    route: "/sources",
    state: "ready",
    title: "Sources",
    summary: `${sources.length} configured source${sources.length === 1 ? "" : "s"}; ${records.length} canonical log event${records.length === 1 ? "" : "s"} retained.${summarySuffix(table.rows.length, sources.length)}`,
    updatedAt: nowDate.toISOString(),
    panels: [table]
  };
}

function logTable(records, sources, hosts) {
  const sourceById = new Map(sources.map((source) => [source.sourceId, source]));
  const hostById = new Map(hosts.map((host) => [host.hostId, host]));
  return {
    id: "log-results",
    type: "table",
    title: "Events",
    caption: "Canonical normalized log events, newest first",
    columns: [
      { key: "when", label: "When" },
      { key: "source", label: "Source" },
      { key: "host", label: "Host" },
      { key: "severity", label: "Severity" },
      { key: "state", label: "State" },
      { key: "channel", label: "Channel" },
      { key: "event", label: "Event" },
      { key: "message", label: "Message" }
    ],
    rows: records.map((record) => {
      const source = sourceById.get(record.sourceId);
      const host = record.hostId ? hostById.get(record.hostId) : null;
      const severity = record.payload.severity || "unknown";
      return [
        { type: "time", value: record.observedAt },
        source ? source.displayName : record.sourceId,
        host ? host.name : (record.payload.assetRef || "—"),
        { type: "badge", label: severity, tone: severityTone(severity) },
        { type: "badge", label: record.payload.state, tone: stateTone(record.payload.state) },
        record.payload.channel || "—",
        record.payload.title,
        cellText(record.payload.message)
      ];
    })
  };
}

function logSearchText(record, source) {
  return [
    record.recordId,
    record.sourceId,
    record.estateId,
    record.hostId,
    source && source.displayName,
    record.payload.title,
    record.payload.message,
    record.payload.summary,
    record.payload.severity,
    record.payload.state,
    record.payload.channel,
    record.payload.category,
    record.payload.assetRef,
    record.payload.ruleRef
  ].filter((value) => typeof value === "string").join("\n").toLocaleLowerCase();
}

function requestedLogLimit(query) {
  if (query.limit === undefined) return MAX_TABLE_ROWS;
  if (!/^(?:[1-9]|[1-9][0-9]|1[0-9]{2}|200)$/.test(query.limit)) {
    throw new TypeError("query.limit must be an integer from 1 through 200.");
  }
  return Number(query.limit);
}

function projectLogs(state, query, records, sources, hosts, nowDate) {
  const sourceById = new Map(sources.map((source) => [source.sourceId, source]));
  let selected = records;
  if (query.sourceId !== undefined) {
    const sourceId = identifier(query.sourceId, "query.sourceId");
    selected = selected.filter((record) => record.sourceId === sourceId);
  }
  const search = (query.q || "").trim().toLocaleLowerCase();
  if (search) selected = selected.filter((record) => logSearchText(record, sourceById.get(record.sourceId)).includes(search));
  selected = selected.slice().sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt));
  const total = selected.length;
  selected = selected.slice(0, requestedLogLimit(query));
  if (selected.length === 0) {
    return emptyEnvelope(
      "/logs",
      "Security Logs",
      search || query.sourceId ? "No canonical log events matched the requested filters." : "No canonical log events have been received.",
      "no-log-events",
      search || query.sourceId ? "No matching log events" : "No log events received",
      search || query.sourceId
        ? "Adjust the source or text filter to inspect a different portion of retained log data."
        : "Activate a source and deliver a valid normalized log.event batch to populate this page.",
      nowDate.toISOString()
    );
  }
  return {
    schemaVersion: "1",
    route: "/logs",
    state: "ready",
    title: "Security Logs",
    summary: `${total} canonical event${total === 1 ? "" : "s"} matched.${summarySuffix(selected.length, total)}`,
    updatedAt: nowDate.toISOString(),
    panels: [logTable(selected, sources, hosts)]
  };
}

function requestedHours(query) {
  const candidate = query.h === undefined ? "48" : query.h;
  if (!["24", "48", "168"].includes(candidate)) throw new TypeError("query.h must be 24, 48, or 168.");
  return Number(candidate);
}

function projectAnalytics(state, query, records, nowDate) {
  const hours = requestedHours(query);
  const end = new Date(nowDate);
  end.setUTCMinutes(0, 0, 0);
  const startMs = end.getTime() - (hours - 1) * HOUR_MS;
  const selected = records.filter((record) => {
    const observed = Date.parse(record.observedAt);
    return observed >= startMs && observed < end.getTime() + HOUR_MS;
  });
  if (selected.length === 0) {
    return emptyEnvelope(
      "/analytics",
      "Analytics",
      `No canonical log events fall within the selected ${hours}-hour window.`,
      "no-analytics-events",
      "No events in this window",
      "Choose another supported time window or wait for an active source to deliver log events.",
      nowDate.toISOString()
    );
  }

  const buckets = Array.from({ length: hours }, (_, index) => new Date(startMs + index * HOUR_MS).toISOString());
  const values = Array(hours).fill(0);
  selected.forEach((record) => {
    const bucket = Math.floor((Date.parse(record.observedAt) - startMs) / HOUR_MS);
    if (bucket >= 0 && bucket < values.length) values[bucket] += 1;
  });
  const sourceCount = new Set(selected.map((record) => record.sourceId)).size;
  const channelCount = new Set(selected.map((record) => record.payload.channel).filter(Boolean)).size;
  const earliest = records.slice().sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt))[0];
  return {
    schemaVersion: "1",
    route: "/analytics",
    state: "ready",
    title: "Analytics",
    summary: `Aggregated from canonical normalized log events over the selected ${hours}-hour window.`,
    updatedAt: nowDate.toISOString(),
    panels: [{
      id: "summary-metrics",
      type: "metrics",
      title: "Collection summary",
      items: [
        { label: "Events collected", value: selected.length, tone: "info" },
        { label: "Sources reporting", value: sourceCount, tone: sourceCount > 0 ? "ok" : "neutral" },
        { label: "Channels reporting", value: channelCount, tone: "info" },
        { label: "History held", value: earliest ? earliest.observedAt : "None", tone: "neutral" }
      ]
    }, {
      id: "events-collected-per-hour",
      type: "chart",
      title: "Events collected per hour",
      unit: "events",
      buckets,
      series: [{ label: "Canonical log events", values, tone: "info" }]
    }]
  };
}

function projectHealth(state, records, sources, nowDate) {
  if (sources.length === 0) {
    return emptyEnvelope(
      "/health",
      "SOC Health",
      "Source health is unavailable until a source has been configured.",
      "no-source-health",
      "No sources to assess",
      "Enroll a host and activate a source to begin measuring collection health.",
      nowDate.toISOString()
    );
  }
  const healthy = sources.filter((source) => source.health.state === "healthy").length;
  const attention = sources.length - healthy;
  const active = sources.filter((source) => source.state === "active").length;
  const rows = sources.slice().sort((left, right) => left.displayName.localeCompare(right.displayName)).slice(0, MAX_TABLE_ROWS);
  return {
    schemaVersion: "1",
    route: "/health",
    state: "ready",
    title: "SOC Health",
    summary: `Collection health derived from ${sources.length} configured source${sources.length === 1 ? "" : "s"}.${summarySuffix(rows.length, sources.length)}`,
    updatedAt: nowDate.toISOString(),
    panels: [{
      id: "summary-metrics",
      type: "metrics",
      title: "Source health summary",
      items: [
        { label: "Feeds needing attention", value: attention, tone: attention > 0 ? "warn" : "ok" },
        { label: "Healthy feeds", value: healthy, tone: healthy > 0 ? "ok" : "neutral" },
        { label: "Active connectors", value: active, tone: active > 0 ? "ok" : "neutral" },
        { label: "Events retained", value: records.length, tone: "info" }
      ]
    }, {
      id: "is-the-collection-working",
      type: "table",
      title: "Is the collection working",
      caption: "Source cadence and most recent successful collection",
      columns: [
        { key: "feed", label: "Feed" },
        { key: "expected", label: "Expected" },
        { key: "last-collection", label: "Last collection" },
        { key: "activity", label: "Activity" },
        { key: "collection", label: "Collection" }
      ],
      rows: rows.map((source) => [
        source.displayName,
        formatCadence(source.cadenceSeconds),
        source.lastSeenAt ? { type: "time", value: source.lastSeenAt } : "Never",
        source.lastSeenAt ? formatAge(source.lastSeenAt, nowDate) : source.health.detail,
        { type: "badge", label: source.health.state, tone: source.health.tone }
      ])
    }]
  };
}

function projectOverview(state, records, sources, nowDate) {
  if (state.apps.length === 0 && state.hosts.length === 0 && sources.length === 0 && records.length === 0) {
    return emptyEnvelope(
      "/",
      "Security Posture — Overview",
      "The reference control plane has no registered applications, hosts, sources, or log events.",
      "no-operational-data",
      "No operational data",
      "Register an application, enroll a host, configure a source, and deliver canonical log events to populate the console.",
      nowDate.toISOString()
    );
  }
  const attention = sources.filter((source) => source.health.state !== "healthy").length;
  const panels = [{
    id: "summary-metrics",
    type: "metrics",
    title: "Connector estate",
    items: [
      { label: "Registered apps", value: state.apps.length, tone: "info" },
      { label: "Enrolled hosts", value: state.hosts.length, tone: "info" },
      { label: "Configured sources", value: sources.length, tone: sources.length > 0 ? "ok" : "neutral" },
      { label: "Sources needing attention", value: attention, tone: attention > 0 ? "warn" : "ok" },
      { label: "Log events retained", value: records.length, tone: "info" }
    ]
  }];
  if (records.length > 0) {
    const recent = records.slice().sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt)).slice(0, 20);
    panels.push({ ...logTable(recent, sources, normalizeHosts(state)), id: "detections", title: "Recent log events" });
  } else {
    panels.push({
      id: "detections",
      type: "empty",
      title: "No log events received",
      body: "The registry exists, but no active source has delivered a canonical normalized log event."
    });
  }
  return {
    schemaVersion: "1",
    route: "/",
    state: "ready",
    title: "Security Posture — Overview",
    summary: `Reference connector registry revision ${state.revision}.`,
    updatedAt: nowDate.toISOString(),
    panels
  };
}

function createPageEnvelope(route, query, state, now) {
  const runtime = loadAdapterRuntime();
  const request = runtime.validateRequest({
    schemaVersion: "1",
    route,
    query: query === undefined ? {} : query,
    reason: "navigation"
  });
  const checkedState = validateState(state);
  const nowDate = normalizeNow(now);
  if (!SUPPORTED_ROUTE_SET.has(route)) {
    return runtime.validateEnvelope({
      schemaVersion: "1",
      route: request.route,
      state: "empty",
      title: "No data supplied",
      summary: "The loopback reference projector does not populate this route.",
      updatedAt: nowDate.toISOString(),
      panels: []
    }, request.route);
  }
  const records = canonicalLogRecords(checkedState);
  const hosts = normalizeHosts(checkedState);
  const sources = normalizeSources(checkedState, records, nowDate);
  const projectors = {
    "/": () => projectOverview(checkedState, records, sources, nowDate),
    "/sources": () => projectSources(checkedState, records, sources, nowDate),
    "/logs": () => projectLogs(checkedState, request.query, records, sources, hosts, nowDate),
    "/analytics": () => projectAnalytics(checkedState, request.query, records, nowDate),
    "/health": () => projectHealth(checkedState, records, sources, nowDate)
  };
  return runtime.validateEnvelope(projectors[route](), route);
}

module.exports = { SUPPORTED_PAGE_ROUTES, createPageEnvelope };
