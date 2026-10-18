"use strict";

// Definitions are supplied by the deployment. No host, service, endpoint or
// application is registered until an operator explicitly supplies it.
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,159}$/;
const MAX_HOSTS = 100, MAX_SERIES = 600, MAX_CHECKS = 1200;
const plain = (v) => !!v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;
function fail(message) { throw Object.assign(new TypeError(message), { status: 400 }); }
function keys(v, allowed, label) {
  if (!plain(v) || Object.keys(v).some(k => !allowed.includes(k))) fail("Invalid " + label + " fields.");
}
function id(v, label) { if (typeof v !== "string" || !ID.test(v)) fail("Invalid " + label + "."); }
function text(v, max, label) { if (typeof v !== "string" || !v.trim() || v.length > max || /[\u0000-\u001f]/.test(v)) fail("Invalid " + label + "."); }
function number(v, min, max, label, integer = false) { if (!Number.isFinite(v) || v < min || v > max || (integer && !Number.isSafeInteger(v))) fail("Invalid " + label + "."); }
function freeze(value) { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function policy(value, metric, range) {
  if (metric) {
    keys(value, ["direction", "warning", "critical", "warnForSeconds", "criticalForSeconds", "recover", "recoverForSeconds"], "metric policy");
    if (!["above", "below"].includes(value.direction)) fail("Invalid metric direction.");
    for (const name of ["warning", "recover"]) number(value[name], range.min, range.max, name);
    for (const name of ["warnForSeconds", "recoverForSeconds"]) number(value[name], 0, 604800, name, true);
    if (value.critical !== undefined) {
      number(value.critical, range.min, range.max, "critical");
      number(value.criticalForSeconds, 0, 604800, "criticalForSeconds", true);
    } else if (value.criticalForSeconds !== undefined) fail("Critical dwell requires a critical threshold.");
    if (value.direction === "above" ? value.recover >= value.warning || (value.critical !== undefined && value.critical < value.warning)
      : value.recover <= value.warning || (value.critical !== undefined && value.critical > value.warning)) fail("Metric thresholds must preserve recovery hysteresis.");
  } else {
    keys(value, ["failCount", "recoverCount"], "check policy");
    number(value.failCount, 1, 1000, "failure count", true);
    number(value.recoverCount, 1, 1000, "recovery count", true);
  }
}

function validateRegistry(input = { VERSION: 1, HOSTS: [], SERIES: [], CHECKS: [] }) {
  keys(input, ["VERSION", "HOSTS", "SERIES", "CHECKS"], "monitoring registry");
  if (input.VERSION !== 1 || !Array.isArray(input.HOSTS) || input.HOSTS.length > MAX_HOSTS ||
      !Array.isArray(input.SERIES) || input.SERIES.length > MAX_SERIES || !Array.isArray(input.CHECKS) || input.CHECKS.length > MAX_CHECKS) fail("Invalid monitoring registry version or bounds.");
  const hosts = new Map(), sources = new Set(), apps = new Set(), series = new Map(), checks = new Map();
  for (const host of input.HOSTS) {
    keys(host, ["id", "sourceId", "appId", "label", "role", "intervalSeconds"], "host");
    for (const name of ["id", "sourceId", "appId"]) id(host[name], "host " + name);
    text(host.label, 200, "host label");
    if (host.role !== undefined) text(host.role, 100, "host role");
    if (host.intervalSeconds !== 60) fail("Native monitoring currently requires a 60-second collection interval.");
    if (hosts.has(host.id) || sources.has(host.sourceId)) fail("Host and source identities must be unique.");
    hosts.set(host.id, host); sources.add(host.sourceId); apps.add(host.appId);
  }
  if (apps.size > 1) fail("A monitoring store belongs to one application.");
  for (const item of input.SERIES) {
    keys(item, ["id", "host", "label", "unit", "type", "min", "max", "intervalSeconds", "policy", "suffix"], "series");
    id(item.id, "series identity");
    if (series.has(item.id) || !hosts.has(item.host)) fail("Unknown series host or duplicate identity.");
    text(item.label, 200, "series label"); text(item.unit, 40, "series unit");
    if (item.suffix !== undefined) id(item.suffix, "series suffix");
    if (!["gauge", "counter"].includes(item.type) || item.intervalSeconds !== 60) fail("Invalid series type or interval.");
    number(item.min, -Number.MAX_VALUE, Number.MAX_VALUE, "series minimum");
    number(item.max, item.min, Number.MAX_VALUE, "series maximum");
    if (item.type === "counter" && item.min < 0) fail("Counters cannot be negative.");
    if (item.policy !== undefined) policy(item.policy, true, item);
    series.set(item.id, item);
  }
  for (const check of input.CHECKS) {
    keys(check, ["id", "host", "label", "type", "intervalSeconds", "policy", "dependencies", "notificationPolicy", "notificationEnabled"], "check");
    id(check.id, "check identity");
    if (check.id.startsWith("operations.")) fail("The operations check namespace is reserved for registered execution conditions.");
    if (checks.has(check.id) || !hosts.has(check.host)) fail("Unknown check host or duplicate identity.");
    text(check.label, 200, "check label");
    if (!["metric", "service", "database", "uptime", "collection"].includes(check.type) || check.intervalSeconds !== 60) fail("Invalid check type or interval.");
    if (check.notificationEnabled !== undefined && check.notificationEnabled !== false) fail("Native notifications are shadow-only.");
    const metric = series.get(check.id);
    if (check.type === "metric" && (!metric || !metric.policy || metric.host !== check.host)) fail("Metric check must match a registered metric policy.");
    if (check.type !== "metric" && metric) fail("A series identity can only be shared with its metric check.");
    policy(check.policy, check.type === "metric", metric);
    if (check.type === "metric" && JSON.stringify(Object.entries(check.policy).sort()) !== JSON.stringify(Object.entries(metric.policy).sort())) fail("Metric and check policies must agree.");
    if (check.type === "collection" && check.id !== check.host + ".collection") fail("Collection check must use its host's collection identity.");
    if (check.dependencies !== undefined && (!Array.isArray(check.dependencies) || check.dependencies.length > 10)) fail("Invalid dependency bounds.");
    if (check.notificationPolicy !== undefined) {
      keys(check.notificationPolicy, ["reminderSeconds", "prolongedAfterSeconds"], "notification policy");
      const reminders = check.notificationPolicy.reminderSeconds;
      if (!Array.isArray(reminders) || reminders.length > 10 || reminders.some((n, i) => !Number.isSafeInteger(n) || n < 1 || n > 604800 || (i && reminders[i - 1] >= n))) fail("Invalid reminder schedule.");
      if (check.notificationPolicy.prolongedAfterSeconds !== undefined) number(check.notificationPolicy.prolongedAfterSeconds, 1, 604800, "prolonged notice", true);
    }
    checks.set(check.id, check);
  }
  for (const host of hosts.values()) {
    if (checks.get(host.id + ".collection")?.type !== "collection") fail("Every host requires its collection freshness check.");
    if (input.SERIES.filter(s => s.host === host.id).length > 100 || input.CHECKS.filter(c => c.host === host.id && !["metric", "collection"].includes(c.type)).length > 100) fail("Host exceeds collector envelope bounds.");
  }
  for (const item of series.values()) if (item.policy && checks.get(item.id)?.type !== "metric") fail("Every metric policy requires its matching check.");
  for (const check of checks.values()) {
    const seen = new Set();
    for (const dependency of check.dependencies || []) {
      keys(dependency, ["checkId", "reason"], "dependency");
      const target = checks.get(dependency.checkId);
      if (!target || target.host !== check.host || target.id === check.id || seen.has(target.id)) fail("Dependencies must reference distinct checks on the same host.");
      text(dependency.reason, 300, "dependency reason"); seen.add(target.id);
    }
  }
  const visited = new Set(), visiting = new Set();
  function visit(check) {
    if (visiting.has(check.id)) fail("Monitoring dependencies cannot contain cycles.");
    if (visited.has(check.id)) return;
    visiting.add(check.id); for (const dependency of check.dependencies || []) visit(checks.get(dependency.checkId));
    visiting.delete(check.id); visited.add(check.id);
  }
  for (const check of checks.values()) visit(check);
  return freeze(JSON.parse(JSON.stringify(input)));
}

const METRICS = freeze([
  { suffix: "cpu.utilization_pct", label: "CPU utilization", unit: "%", min: 0, max: 100, policy: { direction: "above", warning: 85, warnForSeconds: 900, recover: 75, recoverForSeconds: 300 } },
  { suffix: "memory.available_pct", label: "Memory available", unit: "%", min: 0, max: 100, policy: { direction: "below", warning: 10, critical: 3, warnForSeconds: 300, criticalForSeconds: 300, recover: 15, recoverForSeconds: 180 } },
  { suffix: "filesystem.root.used_pct", label: "Root filesystem used", unit: "%", min: 0, max: 100, policy: { direction: "above", warning: 80, critical: 90, warnForSeconds: 600, criticalForSeconds: 600, recover: 75, recoverForSeconds: 180 } },
  { suffix: "filesystem.root.free_bytes", label: "Root filesystem free", unit: "bytes", min: 0, max: 1e18, policy: { direction: "below", warning: 1073741824, critical: 536870912, warnForSeconds: 300, criticalForSeconds: 120, recover: 1610612736, recoverForSeconds: 180 } },
  { suffix: "load.1", label: "One minute load", unit: "load", min: 0, max: 100000 },
  { suffix: "swap.used_bytes", label: "Swap used", unit: "bytes", min: 0, max: 1e18 }
]);
const PG_METRICS = freeze([
  { suffix: "postgres.connections_used_pct", label: "PostgreSQL client connection capacity used", unit: "%", max: 100000, policy: { direction: "above", warning: 80, critical: 90, warnForSeconds: 300, criticalForSeconds: 300, recover: 70, recoverForSeconds: 180 } },
  { suffix: "postgres.usable_max_connections", label: "PostgreSQL usable connection capacity", unit: "connections" },
  { suffix: "postgres.connections", label: "PostgreSQL connections", unit: "connections" },
  { suffix: "postgres.active_connections", label: "PostgreSQL active connections", unit: "connections" },
  { suffix: "postgres.waiting_connections", label: "PostgreSQL waiting connections", unit: "connections" },
  { suffix: "postgres.longest_transaction_seconds", label: "Oldest transaction", unit: "seconds", policy: { direction: "above", warning: 300, critical: 900, warnForSeconds: 120, criticalForSeconds: 120, recover: 120, recoverForSeconds: 120 } },
  { suffix: "postgres.deadlocks_total", label: "PostgreSQL deadlocks total", unit: "events", type: "counter" },
  { suffix: "postgres.commits_total", label: "PostgreSQL commits total", unit: "events", type: "counter" },
  { suffix: "postgres.rollbacks_total", label: "PostgreSQL rollbacks total", unit: "events", type: "counter" }
]);

// Explicit preset builder: standard measurement definitions, never seeded hosts.
function createHostRegistry({ hosts = [] } = {}) {
  if (!Array.isArray(hosts) || hosts.length > MAX_HOSTS) fail("Invalid host preset list.");
  const result = { VERSION: 1, HOSTS: [], SERIES: [], CHECKS: [] };
  for (const raw of hosts) {
    keys(raw, ["id", "sourceId", "appId", "label", "role", "services", "postgres"], "host preset");
    if (raw.postgres !== undefined && typeof raw.postgres !== "boolean") fail("PostgreSQL preset must be boolean.");
    const services = raw.services || [];
    if (!Array.isArray(services) || services.length > 32 || new Set(services).size !== services.length || services.some(s => typeof s !== "string" || !/^[A-Za-z0-9_.@:-]{1,100}\.service$/.test(s))) fail("Invalid explicit service unit list.");
    const { services: ignoredServices, postgres, ...host } = raw;
    host.intervalSeconds = 60; result.HOSTS.push(host);
    for (const metric of METRICS.concat(postgres ? PG_METRICS : [])) {
      const item = { type: "gauge", min: 0, max: 1e18, ...metric, id: host.id + "." + metric.suffix, host: host.id, intervalSeconds: 60 };
      result.SERIES.push(item);
      if (item.policy) result.CHECKS.push({ id: item.id, host: host.id, label: item.label, type: "metric", intervalSeconds: 60, policy: item.policy });
    }
    for (const unit of services) result.CHECKS.push({ id: host.id + ".service." + unit, host: host.id, label: unit, type: "service", intervalSeconds: 60, policy: { failCount: 3, recoverCount: 2 } });
    if (postgres) result.CHECKS.push({ id: host.id + ".postgres.connection", host: host.id, label: "PostgreSQL connection and SELECT", type: "database", intervalSeconds: 60, policy: { failCount: 3, recoverCount: 2 } });
    result.CHECKS.push({ id: host.id + ".collection", host: host.id, label: "Collector freshness", type: "collection", intervalSeconds: 60, policy: { failCount: 1, recoverCount: 2 } });
  }
  for (const check of result.CHECKS) {
    check.notificationEnabled = false;
    check.dependencies = check.type === "collection" ? [] : [{ checkId: check.host + ".collection", reason: "Host collector visibility" }];
    if (check.type === "metric" && check.id.includes(".postgres.")) check.dependencies.push({ checkId: check.host + ".postgres.connection", reason: "Local PostgreSQL observation" });
    check.notificationPolicy = { reminderSeconds: [900, 3600, 14400], prolongedAfterSeconds: 14400 };
  }
  return validateRegistry(result);
}

module.exports = { validateRegistry, createHostRegistry, METRICS, PG_METRICS, MAX_HOSTS, MAX_SERIES, MAX_CHECKS };
