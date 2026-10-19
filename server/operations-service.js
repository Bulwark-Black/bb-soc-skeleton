"use strict";

// The portable monitoring engines run in an application-scoped SQLite store.
// No command execution or target fetching runs here. Reviewed notification delivery uses the native durable worker.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { MonitorStore } = require("./native-monitor/store");
const { validateRegistry, createHostRegistry } = require("./native-monitor/registry");
const { createOperations } = require("./native-monitor/operations");
const { createNotifications, notificationConfiguration } = require("./native-monitor/notifications");
const { readJsonBody, sendJson, distinctHeader } = require("./reference-control-plane");

const OPERATIONS_BASE = "/api/v1/operations";
const NATIVE_MACHINE_PATHS = new Set(["/api/v1/monitor/batches", "/api/v1/monitor/operations", "/api/v1/monitor/websites", "/api/v1/monitor/instructions", "/api/v1/monitor/instructions/ack"]);
const READS = new Set(["health", "overview", "resources", "checks", "series", "query", "incidents", "employees", "work", "jobs", "events", "notifications", "dependencies", "employee-inbox", "websites", "website-history", "configuration"]);
const WRITES = new Set(["incidents/ack", "maintenance", "work", "work/claim", "work/events", "jobs", "jobs/events", "employees/events", "employees/import", "streams/activate", "employee-inbox/create", "employee-inbox/withdraw", "notifications/pause", "notifications/reconcile"]);
function reject(status, message) { throw Object.assign(new Error(message), { status }); }
function identifier(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) reject(400, "Invalid " + label + ".");
  return value;
}
function readConfiguration(file) {
  if (!fs.existsSync(file)) return { schemaVersion: 1, applications: [] };
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024 * 1024
      || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077)) throw new TypeError("Operations configuration must be an owner-only regular file below 1 MiB.");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function configuration(value) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.applications) || value.applications.length > 100
      || Object.keys(value).some(key => !["schemaVersion", "applications"].includes(key))) throw new TypeError("Invalid Operations configuration.");
  const result = new Map();
  for (const app of value.applications) {
    identifier(app.appId, "configuration appId");
    if (result.has(app.appId) || Object.keys(app).some(key => !["appId", "registry", "hosts", "employees", "websites", "notifications"].includes(key))
        || (app.registry && app.hosts)) throw new TypeError("Duplicate or invalid Operations application configuration.");
    const registry = app.hosts ? createHostRegistry({ hosts: app.hosts }) : validateRegistry(app.registry);
    if (registry.HOSTS.some(host => host.appId !== app.appId)) throw new TypeError("Every monitoring host must belong to its configured application.");
    result.set(app.appId, { registry, employees: app.employees || [], websites: app.websites || [], notifications: notificationConfiguration(app.notifications) });
  }
  return result;
}

function createOperationsService({ stateDir, runtime, config, now = Date.now, minFreeBytes, quotaBytes, consoleOrigin, notificationSend }) {
  const definitions = configuration(config || readConfiguration(path.join(stateDir, "operations-config.json")));
  const instances = new Map();
  function instance(appId) {
    identifier(appId, "appId");
    if (!runtime.controlState().apps.some(app => app.appId === appId)) reject(404, "Register this application before using Operations.");
    if (instances.has(appId)) return instances.get(appId);
    const definition = definitions.get(appId) || { registry: validateRegistry(), employees: [], websites: [] };
    const key = crypto.createHash("sha256").update(appId).digest("hex");
    let notifications;
    const store = new MonitorStore({ data: path.join(stateDir, "operations", key), registry: definition.registry, now, minFreeBytes, quotaBytes,
      notificationsEnabled: () => notifications?.enabled() === true });
    try {
      const operations = createOperations(store.db, { now, registry: definition.registry, employees: definition.employees,
        beforeMutation: () => store.capacity() });
      const websites = require("./native-monitor/websites").createWebsites(store, definition.websites);
      notifications = createNotifications(store, { appId, configuration: definition.notifications, consoleOrigin, send: notificationSend });
      const entry = { ...definition, store, operations, websites, notifications, fault: null };
      instances.set(appId, entry);
      return entry;
    } catch (error) { store.close(); throw error; }
  }
  function reconcile(entry) {
    try {
      entry.store.reconcileOperationalConditions([...entry.operations.conditions(), ...entry.websites.conditions()], [...entry.operations.conditionDefinitions(), ...entry.websites.conditionDefinitions()]);
      entry.fault = null;
    } catch { entry.fault = "Operations condition evaluation failed."; }
  }
  function scope(entry, query) {
    const host = query.get("hosts") || query.get("host");
    return entry.store.hostsFilter(host || null);
  }
  function sourceHealth(source) {
    const entry = instances.get(source.appId);
    const host = entry?.registry.HOSTS.find(item => item.sourceId === source.sourceId);
    if (!host) return null;
    const resource = entry.store.resources([host.id]).resources[0];
    if (!resource.lastObservedAt) return null;
    const age = now() - resource.lastObservedAt;
    const state = age > 360000 ? "offline" : age > 180000 ? "stale" : resource.quality === "good" ? "healthy" : "degraded";
    const at = new Date(resource.lastObservedAt).toISOString();
    return { state, reason: ["stale", "offline"].includes(state) ? "late" : state === "degraded" ? "connector-error" : "none",
      lastAttemptAt: at, lastSuccessAt: resource.quality === "good" ? at : null, nextExpectedAt: new Date(resource.lastObservedAt + 60000).toISOString(),
      message: "Native collection quality: " + resource.quality + ". Last receipt: " + new Date(resource.lastReceivedAt).toISOString() + ". Service health and incidents are evaluated separately in Operations." };
  }
  function overviewPanels(appId) {
    const apps = runtime.controlState().apps, rows = [];
    for (const [id, entry] of instances) {
      if (appId && appId !== id) continue;
      const name = apps.find(app => app.appId === id)?.displayName;
      if (!name) continue;
      for (const host of entry.store.resources().resources) rows.push([name, host.label, host.state, host.quality,
        host.lastObservedAt ? new Date(host.lastObservedAt).toISOString() : "Not observed",
        host.lastReceivedAt ? new Date(host.lastReceivedAt).toISOString() : "Not received",
        { type: "link", label: "Investigate", route: "/infrastructure", query: { appId: id, host: host.id } }]);
    }
    if (!rows.length) return [];
    return [{ id: "native-infrastructure-health", type: "table", title: "Native infrastructure and collection health",
      caption: "Measured host health, collection quality and delivery time are independent. Showing " + Math.min(rows.length, 200) + " of " + rows.length + " hosts. Open Operations for service checks, metric history and durable incidents.",
      columns: [{ key: "app", label: "Application" }, { key: "host", label: "Host" }, { key: "state", label: "Measured state" },
        { key: "quality", label: "Collection quality" }, { key: "observed", label: "Last observation (UTC)" }, { key: "received", label: "Last receipt (UTC)" }, { key: "investigate", label: "Operations" }], rows: rows.slice(0, 200) }];
  }
  async function operator(method, suffix, query, body, actor) {
    if (!(method === "GET" ? READS : method === "POST" ? WRITES : new Set()).has(suffix)) reject(405, "Operations endpoint or method is not supported.");
    const entry = instance(query.get("appId")), store = entry.store, hosts = scope(entry, query);
    if (method === "GET") {
      if (suffix === "configuration") return { ok: true, configured: definitions.has(query.get("appId")), hosts: entry.registry.HOSTS, employees: entry.employees,
        note: "Edit the owner-only operations-config.json in the private state directory and restart to apply a reviewed registry. No targets are inferred or scanned." };
      if (suffix === "health") return { ...store.health(), operations: { status: entry.fault ? "degraded" : "healthy", error: entry.fault } };
      if (suffix === "overview") return store.overview(hosts);
      if (suffix === "resources") return store.resources(hosts);
      if (suffix === "checks") return { ok: true, at: now(), checks: store.currentChecks(hosts) };
      if (suffix === "series") return { ok: true, series: entry.registry.SERIES.filter(series => !hosts || hosts.includes(series.host)), limit: 600 };
      if (suffix === "query") return store.query(query.get("series"), query.get("from"), query.get("to"), hosts);
      if (suffix === "incidents" && query.has("incidentId")) return store.incidentDetail(hosts, query.get("incidentId"));
      if (suffix === "incidents" && query.get("view") === "history") return store.incidentHistory(hosts, Object.fromEntries(query));
      if (suffix === "incidents") return store.incidents(hosts, { openOnly: query.get("open") === "1", episodeId: query.get("episodeId") || null });
      if (suffix === "events") return store.events(hosts, query.get("all") === "1", query.get("notify") === "1", Object.fromEntries(query));
      if (suffix === "dependencies") return store.dependencies(hosts);
      if (suffix === "notifications") return entry.notifications.status(hosts, { incidentId: query.get("incidentId") || null, limit: 100 });
      if (suffix === "websites") return entry.websites.list(hosts);
      if (suffix === "website-history") return entry.websites.history(hosts, Object.fromEntries(query));
    } else {
      if (!body || typeof body !== "object" || Array.isArray(body)) reject(400, "An Operations JSON object is required.");
      if (Object.hasOwn(body, "actor") || Object.hasOwn(body, "sourceId")) reject(400, "Operator identity is supplied by the session.");
      body = { ...body, actor };
      if (suffix === "notifications/pause") return entry.notifications.pause(body, hosts);
      if (suffix === "notifications/reconcile") return entry.notifications.reconcile(body, hosts);
      if (suffix === "incidents/ack") return store.acknowledge(body, hosts);
      if (suffix === "maintenance") return store.maintenance(body, hosts);
      if (suffix === "streams/activate") {
        if (hosts && !hosts.includes(body.host)) reject(403, "Stream is outside the selected host scope.");
        return store.activateStream(body.host, body.streamId, actor);
      }
    }
    const localQuery = new URLSearchParams(query);
    localQuery.delete("appId"); localQuery.delete("hosts");
    if (suffix === "employee-inbox") localQuery.delete("host");
    const result = await entry.operations.route({ method, path: "/" + suffix, query: localQuery, body: body || {}, hosts });
    if (!result) reject(404, "Operations endpoint is unavailable.");
    if (method === "POST") reconcile(entry);
    return result.body;
  }
  async function machine(method, endpoint, query, body, token) {
    const sourceId = identifier(method === "GET" ? query.get("sourceId") : body?.sourceId, "sourceId");
    const source = runtime.authorizeMonitoringSource(sourceId, token);
    const entry = instance(source.appId);
    const host = entry.registry.HOSTS.find(item => item.sourceId === sourceId);
    if (!host) reject(403, "This source has no registered monitoring host in its application.");
    if ((body?.host && body.host !== host.id) || (body?.appId && body.appId !== source.appId)) reject(403, "Source binding does not match the registered host/application.");
    if (endpoint === "/api/v1/monitor/batches" && method === "POST") return entry.store.ingest(host.id, body.batch);
    if (endpoint === "/api/v1/monitor/websites" && method === "POST") {
      const result = entry.websites.ingest(host.id, sourceId, body.batch); reconcile(entry); return result;
    }
    let result;
    if (endpoint === "/api/v1/monitor/operations" && method === "POST") {
      result = await entry.operations.route({ method, path: "/operations/ingest", query, body: { host: host.id, sourceId, event: body.event }, hosts: [host.id] });
    } else if (["/api/v1/monitor/instructions", "/api/v1/monitor/instructions/ack"].includes(endpoint)) {
      const employeeId = method === "GET" ? query.get("employeeId") : body.employeeId;
      if (!entry.employees.some(employee => employee.id === employeeId && employee.host === host.id && employee.sourceId === sourceId)) reject(403, "Employee is not bound to this source.");
      if ((endpoint.endsWith("/ack") && method !== "POST") || (!endpoint.endsWith("/ack") && method !== "GET")) reject(405, "Unsupported instructions method.");
      result = await entry.operations.route({ method, path: endpoint.endsWith("/ack") ? "/employee-inbox/ack" : "/employee-inbox/next", query,
        body: { ...body, employeeId, sourceId, actor: "source:" + sourceId }, hosts: [host.id], machine: { employeeId, sourceId, host: host.id } });
    } else reject(405, "Unsupported native collection method.");
    if (!result) reject(404, "Native observation endpoint is unavailable.");
    reconcile(entry); return result.body;
  }
  try {
    for (const appId of definitions.keys()) reconcile(instance(appId));
  } catch (error) { for (const entry of instances.values()) entry.store.close(); throw error; }
  const timer = setInterval(() => {
    for (const entry of instances.values()) {
      try { entry.store.maintenanceTick(); reconcile(entry); void entry.notifications.tick(); } catch { entry.fault = "Monitoring maintenance failed."; }
    }
  }, 10000);
  timer.unref();
  return { operator, machine, instance, sourceHealth, overviewPanels, async close() { clearInterval(timer); await Promise.all([...instances.values()].map(entry => entry.notifications.close())); for (const entry of instances.values()) entry.store.close(); instances.clear(); } };
}

async function handleOperations(request, response, url, service, actor) {
  const query = url.searchParams;
  if ([...query.keys()].some((key, index, keys) => keys.indexOf(key) !== index) || url.search.length > 8192) reject(400, "Duplicate or oversized Operations query.");
  const machine = NATIVE_MACHINE_PATHS.has(url.pathname);
  if (machine && distinctHeader(request, "cookie") !== undefined) reject(401, "Native collectors use source credentials without browser cookies.");
  if (distinctHeader(request, "content-encoding") !== undefined) reject(415, "Compressed Operations requests are not accepted.");
  const body = request.method === "POST" ? (await readJsonBody(request, 262144)).value : null;
  if (machine) {
    const header = distinctHeader(request, "authorization"), match = typeof header === "string" && /^Bearer ([A-Za-z0-9_-]+)$/.exec(header);
    if (!match) reject(401, "A source-bound Bearer credential is required.");
    sendJson(response, 200, await service.machine(request.method, url.pathname, query, body, match[1]));
  } else {
    const suffix = url.pathname.slice(OPERATIONS_BASE.length + 1);
    sendJson(response, 200, await service.operator(request.method, suffix, query, body, actor));
  }
}
module.exports = { createOperationsService, handleOperations, OPERATIONS_BASE, NATIVE_MACHINE_PATHS, configuration };
