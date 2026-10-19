"use strict";
const path = require("node:path");
const { validateBaseUrl } = require("../agent-mcp");
const VERSION = "1.0.0";
const ROLES = ["windows-events", "server-logs", "native-monitor", "cloud-events", "protocol-gateway"];
const TARGETS = ["windows-task", "systemd", "container", "helm", "ansible"];
const CHANNELS = ["Security", "System", "Application", "ForwardedEvents", "Microsoft-Windows-Sysmon/Operational", "Microsoft-Windows-PowerShell/Operational", "Microsoft-Windows-Windows Defender/Operational"];
const KEYS = ["schemaVersion", "packVersion", "name", "role", "targets", "sourceId", "appId", "installDirectory", "privateDirectory", "storageDirectory", "stateDirectory", "outboxDirectory", "configFile", "tokenFile", "baseUrl", "runtime", "account", "schedule", "settings", "image", "kubernetes"];
function fail(message) { throw new TypeError(message); }
function exact(value, allowed, label) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) fail("Unsupported " + label + " fields."); }
function identifier(value, label, expression = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/) { if (typeof value !== "string" || !expression.test(value)) fail("Invalid " + label + "."); return value; }
function integer(value, min, max, label) { if (!Number.isSafeInteger(value) || value < min || value > max) fail("Invalid " + label + "."); }
function validateManifest(input) {
  exact(input, KEYS, "integration pack");
  const m = JSON.parse(JSON.stringify(input));
  if (m.schemaVersion !== 1 || m.packVersion !== VERSION || !ROLES.includes(m.role)) fail("Unsupported integration pack version or role.");
  identifier(m.name, "pack name", /^[a-z][a-z0-9-]{0,38}[a-z0-9]$/);
  for (const key of ["sourceId", "appId"]) identifier(m[key], key);
  if (!Array.isArray(m.targets) || !m.targets.length || m.targets.length > TARGETS.length || new Set(m.targets).size !== m.targets.length || m.targets.some(target => !TARGETS.includes(target))) fail("Choose distinct supported deployment targets.");
  const windows = m.role === "windows-events", p = windows ? path.win32 : path.posix;
  const absolute = (value, label) => {
    // Deliberately narrower than OS filenames: spaces are supported; shell,
    // systemd specifier and PowerShell interpolation syntax is not inventory.
    if (typeof value !== "string" || value.length > 240 || !/^[A-Za-z0-9_.:\/\\ ()-]+$/.test(value) || !p.isAbsolute(value) || p.normalize(value) !== value || value === p.parse(value).root || windows && !/^[A-Za-z]:\\/.test(value)) fail("Use a canonical absolute " + label + " without shell syntax or links.");
    return value;
  };
  for (const key of ["installDirectory", "privateDirectory", "storageDirectory", "stateDirectory", "outboxDirectory", "configFile", "tokenFile"]) absolute(m[key], key);
  const within = (child, parent) => { const rel = p.relative(parent, child); return !!rel && !rel.startsWith("..") && !p.isAbsolute(rel); };
  if (within(m.privateDirectory, m.installDirectory) || within(m.storageDirectory, m.installDirectory) || within(m.installDirectory, m.privateDirectory) || within(m.installDirectory, m.storageDirectory) || m.privateDirectory === m.installDirectory || m.storageDirectory === m.installDirectory || m.privateDirectory === m.storageDirectory || within(m.privateDirectory, m.storageDirectory) || within(m.storageDirectory, m.privateDirectory)) fail("Private configuration and durable storage must be separate and outside the checkout.");
  if (p.dirname(m.configFile) !== m.privateDirectory || p.dirname(m.tokenFile) !== m.privateDirectory || m.configFile === m.tokenFile) fail("Config and token must be distinct direct children of privateDirectory.");
  if (p.dirname(m.stateDirectory) !== m.storageDirectory || m.stateDirectory === m.outboxDirectory || !within(m.outboxDirectory, m.storageDirectory)) fail("State and outbox must be distinct below storageDirectory.");
  if (m.role === "native-monitor" ? m.outboxDirectory !== p.join(m.stateDirectory, "outbox") : p.dirname(m.outboxDirectory) !== m.storageDirectory) fail("Outbox location does not match this collector role.");
  m.baseUrl = validateBaseUrl(m.baseUrl);
  exact(m.runtime, ["node", "python"], "runtime"); absolute(m.runtime.node, "Node executable");
  if (["windows-events", "native-monitor"].includes(m.role)) absolute(m.runtime.python, "Python executable");
  else if (m.runtime.python !== undefined) fail("Python is not used by this role.");
  exact(m.account, windows ? ["name"] : ["name", "uid", "gid"], "service account");
  identifier(m.account.name, "restricted account", windows ? /^[A-Za-z][A-Za-z0-9_.-]{1,39}$/ : /^[a-z_][a-z0-9_-]{1,30}$/);
  if (["root", "administrator", "system", "localsystem"].includes(m.account.name.toLowerCase())) fail("Use a dedicated restricted service account.");
  if (!windows) { integer(m.account.uid, 1000, 2147483647, "service UID"); integer(m.account.gid, 1000, 2147483647, "service GID"); }
  exact(m.schedule, ["intervalSeconds", "timeoutSeconds"], "schedule");
  integer(m.schedule.intervalSeconds, 60, 86400, "intervalSeconds"); integer(m.schedule.timeoutSeconds, 30, 3600, "timeoutSeconds");
  if (m.role === "windows-events" && m.schedule.intervalSeconds % 60) fail("Windows schedules require whole minutes.");
  const allowedSettings = m.role === "windows-events" ? ["channels", "computers", "maxEvents"] : m.role === "server-logs" ? ["file", "format", "maxRecords"] : [];
  exact(m.settings || {}, allowedSettings, "role settings"); m.settings = m.settings || {};
  if (windows) {
    for (const key of ["channels", "computers"]) if (!Array.isArray(m.settings[key]) || !m.settings[key].length || m.settings[key].length > (key === "channels" ? CHANNELS.length : 100) || new Set(m.settings[key]).size !== m.settings[key].length) fail("Invalid Windows " + key + ".");
    if (m.settings.channels.some(value => !CHANNELS.includes(value)) || m.settings.computers.some(value => typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,253}$/.test(value))) fail("Unsupported Windows channel or computer.");
    integer(m.settings.maxEvents, 1, 100, "maxEvents");
    if (m.targets.some(target => target !== "windows-task")) fail("Windows events support the Windows Task Scheduler target.");
  } else {
    if (m.targets.includes("windows-task")) fail("Linux roles cannot use Windows Task Scheduler.");
    if (m.role === "server-logs") { absolute(m.settings.file, "log input file"); if (!["plain", "docker-json", "journald-json"].includes(m.settings.format)) fail("Unsupported log format."); integer(m.settings.maxRecords, 1, 100, "maxRecords"); }
  }
  const container = m.targets.some(target => ["container", "helm"].includes(target));
  if (container && m.role === "native-monitor") fail("Host-native probes require host systemd/Ansible; container namespaces would measure a different host.");
  if (container) {
    if (m.role === "server-logs") {
      const logDirectory = p.dirname(m.settings.file);
      const reserved = [m.installDirectory, m.privateDirectory, m.storageDirectory, "/tmp", "/bb-soc-projected", "/bb-soc-private-volume"];
      const overlap = (a, b) => a === b || within(a, b) || within(b, a);
      if (logDirectory === "/" || reserved.some(directory => overlap(logDirectory, directory)))
        fail("Container log input parent must be separate from application, private, storage and reserved mounts.");
    }
    if (typeof m.image !== "string" || !/^[a-z0-9][a-z0-9./:_-]{1,220}@sha256:[a-f0-9]{64}$/.test(m.image)) fail("A reviewed image pinned by sha256 digest is required.");
    for (const value of [m.installDirectory, m.privateDirectory, m.storageDirectory, m.stateDirectory, m.outboxDirectory, m.configFile, m.tokenFile, m.runtime.node]) if (value.includes(" ") || value === "/tmp" || value.startsWith("/tmp/") || value === "/bb-soc-projected" || value.startsWith("/bb-soc-projected/") || value === "/bb-soc-private-volume" || value.startsWith("/bb-soc-private-volume/")) fail("Container paths must avoid spaces and reserved staging/temporary mounts.");
  } else if (m.image !== undefined) fail("Image applies only to container or Helm targets.");
  if (m.targets.includes("helm")) {
    exact(m.kubernetes, ["namespace", "nodeName", "secretName", "storageClaim"], "Kubernetes settings");
    for (const key of ["namespace", "secretName", "nodeName"]) identifier(m.kubernetes[key], "Kubernetes " + key, key === "namespace" ? /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/ : /^[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/);
    if (m.role === "protocol-gateway") identifier(m.kubernetes.storageClaim, "gateway storage claim", /^[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/);
    else if (m.kubernetes.storageClaim !== undefined) fail("Collectors use a prepared node-local durable directory; only the gateway uses storageClaim.");
  } else if (m.kubernetes !== undefined) fail("Kubernetes settings require a Helm target.");
  return m;
}
function commandSteps(m) {
  m = validateManifest(m); const p = m.role === "windows-events" ? path.win32 : path.posix;
  const script = relative => p.join(m.installDirectory, ...relative.split("/"));
  const config = ["--config", m.configFile, "--state-dir", m.stateDirectory];
  if (m.role === "windows-events") return ["send", "collect", "send"].map(command => ({ executable: m.runtime.python, args: [script("tools/collect-windows-events.py"), command, ...config] }));
  if (m.role === "native-monitor") return ["send", "collect", "send"].map(command => ({ executable: m.runtime.python, args: [script("tools/native-monitor/collector.py"), command, ...config] }));
  if (m.role === "cloud-events") return ["drain", "collect", "drain"].map(command => ({ executable: m.runtime.node, args: [script("tools/platform-collectors/cli.js"), command, ...config, "--outbox-dir", m.outboxDirectory] }));
  if (m.role === "protocol-gateway") return [{ executable: m.runtime.node, args: [script("tools/receive-platform.js"), "--config", m.configFile] }];
  return [{ executable: m.runtime.node, args: [script("tools/collect-logs.js"), "--once", "--reviewed-input", "--file", m.settings.file, "--format", m.settings.format, "--source-id", m.sourceId, "--app-id", m.appId, "--state-dir", m.stateDirectory, "--outbox-dir", m.outboxDirectory, "--token-file", m.tokenFile, "--base-url", m.baseUrl, "--max-records", String(m.settings.maxRecords)] }];
}
const schema = { $schema: "https://json-schema.org/draft/2020-12/schema", title: "BB SOC integration pack 1", type: "object", additionalProperties: false,
  required: KEYS.filter(key => !["image", "kubernetes", "settings"].includes(key)), properties: Object.fromEntries(KEYS.map(key => [key, {}])) };
Object.assign(schema.properties, { schemaVersion: { const: 1 }, packVersion: { const: VERSION }, role: { enum: ROLES }, targets: { type: "array", minItems: 1, uniqueItems: true, items: { enum: TARGETS } },
  runtime: { type: "object", additionalProperties: false, required: ["node"], properties: { node: { type: "string" }, python: { type: "string" } } },
  account: { type: "object", additionalProperties: false, required: ["name"], properties: { name: { type: "string" }, uid: { type: "integer", minimum: 1000 }, gid: { type: "integer", minimum: 1000 } } },
  schedule: { type: "object", additionalProperties: false, required: ["intervalSeconds", "timeoutSeconds"], properties: { intervalSeconds: { type: "integer", minimum: 60, maximum: 86400 }, timeoutSeconds: { type: "integer", minimum: 30, maximum: 3600 } } },
  settings: { type: "object", additionalProperties: false, properties: { channels: { type: "array", items: { enum: CHANNELS } }, computers: { type: "array", items: { type: "string" } }, maxEvents: { type: "integer", minimum: 1, maximum: 100 }, file: { type: "string" }, format: { enum: ["plain", "docker-json", "journald-json"] }, maxRecords: { type: "integer", minimum: 1, maximum: 100 } } },
  kubernetes: { type: "object", additionalProperties: false, required: ["namespace", "nodeName", "secretName"], properties: Object.fromEntries(["namespace", "nodeName", "secretName", "storageClaim"].map(key => [key, { type: "string" }])) } });
for (const key of ["name", "sourceId", "appId", "installDirectory", "privateDirectory", "storageDirectory", "stateDirectory", "outboxDirectory", "configFile", "tokenFile", "baseUrl", "image"]) schema.properties[key] = { type: "string", maxLength: 300 };
schema.description = "The shipped validateManifest additionally enforces role/target compatibility, private origin, canonical paths, scoped storage, dedicated accounts and digest pinning. Run generate-deployment --check; JSON Schema alone is not installation approval.";
module.exports = { VERSION, ROLES, TARGETS, CHANNELS, schema, validateManifest, commandSteps };
