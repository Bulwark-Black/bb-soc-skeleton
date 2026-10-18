"use strict";
const crypto = require("node:crypto");
const { validateTimestamp } = require("../ingest-contract");
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
function obj(v) { if (!v || typeof v !== "object" || Array.isArray(v)) throw new TypeError("Expected an object."); return v; }
function text(v, max = 1000) { if (typeof v !== "string" || !v.trim() || v.length > max || !v.isWellFormed() || /\x00/.test(v)) throw new TypeError("Invalid bounded text."); return v; }
function time(v) {
  text(v, 40); const t = v.replace(/([+-]\d{2})(\d{2})$/, "$1:$2").replace(/\.(\d{3})\d+(?=Z|[+-])/, ".$1");
  validateTimestamp(t); return new Date(t).toISOString();
}
function rows(input) { const a = Array.isArray(input) ? input : [input]; if (!a.length || a.length > 1000) throw new TypeError("Expected 1–1000 records."); return a.map(obj); }
function wazuh(input) {
  return rows(input).map(e => {
    const rule = obj(e.rule), agent = obj(e.agent), manager = obj(e.manager);
    const id = text(e.id), managerName = text(manager.name), agentId = text(agent.id), ruleId = text(rule.id);
    if (!Number.isSafeInteger(rule.level) || rule.level < 0 || rule.level > 16) throw new TypeError("Invalid Wazuh level.");
    const description = text(rule.description, 1000), observedAt = time(e.timestamp);
    const fields = { provider: "wazuh", upstreamDetection: true, upstreamRuleId: ruleId, originalSeverity: rule.level,
      managerName, agentRef: "wazuh-agent:" + hash([managerName, agentId]), originalTimestamp: e.timestamp };
    if (agent.name !== undefined) fields.agentName = text(agent.name);
    if (e.location !== undefined) fields.location = text(e.location);
    if (rule.groups !== undefined) { if (!Array.isArray(rule.groups) || rule.groups.length > 40) throw new TypeError("Invalid groups."); fields.ruleGroups = text(JSON.stringify(rule.groups.map(g => text(g, 100)))); }
    if (rule.mitre?.id !== undefined) { if (!Array.isArray(rule.mitre.id) || rule.mitre.id.length > 40) throw new TypeError("Invalid techniques."); fields.mitreTechniqueIds = text(JSON.stringify(rule.mitre.id.map(g => text(g, 32)))); }
    return { upstreamId: "wazuh:" + hash([managerName, agentId, id]), observedAt, kind: "log.event", payload: {
      title: "Wazuh upstream alert", state: "unknown", category: "wazuh.alert", message: e.full_log === undefined ? description : text(e.full_log, 4000), fields: { ...fields, ruleDescription: description } } };
  });
}
function checkmk(input) {
  return rows(input).map(e => {
    if (!["host", "service"].includes(e.dataset)) throw new TypeError("Invalid Checkmk dataset.");
    const x = obj(e.extensions), host = text(e.dataset === "host" ? x.name : x.host_name), site = text(e.site, 64);
    const service = e.dataset === "service" ? text(x.description) : null;
    if (![0, 1].includes(x.has_been_checked) || !Number.isSafeInteger(x.state) || x.state < 0 || x.state > (e.dataset === "host" ? 2 : 3)) throw new TypeError("Invalid Checkmk status.");
    if (typeof x.last_check !== "number" || !Number.isFinite(x.last_check) || x.last_check < 0 || !Number.isSafeInteger(Math.trunc(x.last_check * 1000))) throw new TypeError("Invalid Checkmk time.");
    const checked = x.has_been_checked === 1;
    if (checked && x.last_check === 0) throw new TypeError("A checked status requires original check time.");
    const observedAt = checked ? new Date(Math.trunc(x.last_check * 1000)).toISOString() : time(e.collectedAt);
    validateTimestamp(observedAt);
    const names = e.dataset === "host" ? ["UP", "DOWN", "UNREACHABLE"] : ["OK", "WARN", "CRIT", "UNKNOWN"];
    const fields = { provider: "checkmk", dataset: e.dataset, site, hostname: host, hasBeenChecked: checked,
      originalState: x.state, upstreamState: checked ? names[x.state] : "PENDING", originalLastCheck: x.last_check,
      timeBasis: checked ? "last_check" : "collection-time-no-check" };
    if (service) fields.service = service;
    const message = x.plugin_output === "" ? "Checkmk returned an empty check summary." : text(x.plugin_output, 4000);
    const state = !checked || e.dataset === "service" && x.state === 3 ? "unknown" : x.state === 0 ? "ok" : e.dataset === "service" && x.state === 1 ? "degraded" : "failed";
    const payload = { title: "Checkmk " + e.dataset + " status", state, category: "checkmk.status", message, fields };
    return { upstreamId: "checkmk:" + hash([observedAt, payload]), observedAt, kind: "log.event", payload };
  });
}
function entraAudit(input) {
  return rows(input).map(e => {
    const upstreamId = text(e.id), observedAt = time(e.activityDateTime);
    const fields = { provider: "microsoft-entra", dataset: "directory-audit", action: text(e.activityDisplayName), category: text(e.category), outcome: text(e.result) };
    if (e.correlationId) fields.correlationRef = "entra-correlation:" + hash(text(e.correlationId));
    if (e.initiatedBy) { obj(e.initiatedBy); const actor = e.initiatedBy.user?.id || e.initiatedBy.app?.servicePrincipalId || e.initiatedBy.app?.appId; if (actor) fields.actorRef = "entra-actor:" + hash(text(actor)); }
    if (e.targetResources !== undefined) {
      if (!Array.isArray(e.targetResources) || e.targetResources.length > 20) throw new TypeError("Too many target resources.");
      fields.targetRefs = text(JSON.stringify(e.targetResources.map(v => "entra-target:" + hash(text(obj(v).id)))));
    }
    return { upstreamId, observedAt, kind: "audit.event", payload: { title: "Microsoft Entra directory audit", state: "unknown", category: "entra.directory-audit", fields } };
  });
}
module.exports = { adapters: [
  { id: "checkmk-status", title: "Checkmk host and service status", description: "Selected Checkmk REST status facts; separate from Event Console and raw logs.", formats: ["JSON selected status wrappers"], docs: [{ title: "Checkmk REST API", url: "https://docs.checkmk.com/latest/en/rest_api.html" }], recordKinds: ["log.event"], normalize: checkmk },
  { id: "wazuh-alerts", title: "Wazuh upstream alerts", description: "Wazuh alerts.json records with upstream rule and severity provenance; no local rule execution.", formats: ["JSON", "NDJSON"], docs: [{ title: "Wazuh alert management", url: "https://documentation.wazuh.com/current/user-manual/manager/alert-management.html" }], recordKinds: ["log.event"], normalize: wazuh },
  { id: "entra-directory-audit", title: "Microsoft Entra directory audit", description: "Selected Graph directoryAudits records preserving operation, result and hashed actor/target references.", formats: ["JSON array", "NDJSON"], docs: [{ title: "Microsoft Graph directory audits", url: "https://learn.microsoft.com/en-us/graph/api/directoryaudit-list?view=graph-rest-1.0" }], recordKinds: ["audit.event"], normalize: entraAudit }
] };
