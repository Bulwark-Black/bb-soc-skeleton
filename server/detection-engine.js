"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { validateNormalizedRecord } = require("../tools/ingest-contract");
const { RULES, matches } = require("./detection-rules");
const { loadPacks } = require("./detection-packs");
const MAX_DERIVED = 4000, MAX_OBSERVATIONS = 250000, HORIZON = 86400000;
const digest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const plain = value => value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
function fail(message, status = 400) { throw Object.assign(new TypeError(message), { status }); }
function keys(value, allowed) { if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key))) fail("Unsupported detection configuration fields."); }
function readConfig(stateDir) {
  const file = path.join(stateDir, "detection-config.json");
  if (!fs.existsSync(file)) return { schemaVersion: 1, applications: [] };
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024 * 1024
      || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077)) fail("Detection configuration must be an owner-only regular file below 1 MiB.");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function configuration(value, allRules = RULES) {
  const byId = new Map(allRules.map(rule => [rule.id, rule]));
  keys(value, ["schemaVersion", "applications"]);
  if (value.schemaVersion !== 1 || !Array.isArray(value.applications) || value.applications.length > 100) fail("Invalid detection configuration.");
  const result = new Map();
  for (const app of value.applications) {
    keys(app, ["appId", "rules"]);
    if (typeof app.appId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(app.appId) || result.has(app.appId)
        || !Array.isArray(app.rules) || app.rules.length > allRules.length) fail("Invalid detection application policy.");
    const rules = new Map();
    for (const choice of app.rules) {
      keys(choice, ["id", "threshold", "windowSeconds", "stage", "sourceIds", "suppressions"]);
      const rule = byId.get(choice.id);
      if (!rule || rules.has(rule.id)) fail("Unknown or duplicate detection rule.");
      if (rule.mode !== "threshold" && (choice.threshold !== undefined || choice.windowSeconds !== undefined)) fail("Only threshold rules accept threshold settings.");
      const settings = { ...rule, stage: choice.stage === undefined ? "active" : choice.stage, sourceIds: choice.sourceIds === undefined ? [] : choice.sourceIds, suppressions: choice.suppressions === undefined ? [] : choice.suppressions, threshold: choice.threshold === undefined ? rule.threshold : choice.threshold,
        windowSeconds: choice.windowSeconds === undefined ? rule.windowSeconds : choice.windowSeconds };
      if (rule.mode === "threshold" && (!Number.isSafeInteger(settings.threshold) || settings.threshold < 2 || settings.threshold > 1000
          || !Number.isSafeInteger(settings.windowSeconds) || settings.windowSeconds < 60 || settings.windowSeconds > 3600)) fail("Threshold policy requires 2–1000 events in 60–3600 seconds.");
      if (!["active", "shadow"].includes(settings.stage) || !Array.isArray(settings.sourceIds) || settings.sourceIds.length > 100
          || new Set(settings.sourceIds).size !== settings.sourceIds.length || settings.sourceIds.some(id => typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id))) fail("Invalid detection rollout scope.");
      if (!Array.isArray(settings.suppressions) || settings.suppressions.length > 20) fail("Invalid suppression bounds.");
      for (const suppression of settings.suppressions) {
        keys(suppression, ["sourceId", "fields", "expiresAt", "reason"]);
        if (suppression.sourceId !== undefined && (typeof suppression.sourceId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(suppression.sourceId))) fail("Invalid suppression source.");
        if (suppression.fields !== undefined && (!plain(suppression.fields) || Object.keys(suppression.fields).length > 8
            || Object.entries(suppression.fields).some(([key,value]) => !/^[A-Za-z][A-Za-z0-9_.:-]{0,70}$/.test(key)
              || !["string","number","boolean"].includes(typeof value) || typeof value === "string" && value.length > 1000
              || typeof value === "number" && !Number.isFinite(value)))) fail("Invalid exact suppression fields.");
        if (!suppression.sourceId && !Object.keys(suppression.fields || {}).length) fail("A suppression requires explicit source or exact field scope.");
        if (typeof suppression.expiresAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(suppression.expiresAt)
            || !Number.isFinite(Date.parse(suppression.expiresAt)) || new Date(suppression.expiresAt).toISOString() !== suppression.expiresAt
            || typeof suppression.reason !== "string" || !suppression.reason.trim() || suppression.reason.length > 300) fail("Suppression needs an exact UTC expiry and reason.");
      }
      settings.policyRevision = digest([settings.id, settings.version, settings.ruleDigest || null, settings.threshold || null,
        settings.windowSeconds || null, settings.stage, settings.sourceIds, settings.suppressions]);
      rules.set(rule.id, settings);
    }
    result.set(app.appId, rules);
  }
  return result;
}
function createDetectionEngine({ store, stateDir, config, packs, now = Date.now }) {
  if (!store?.db || typeof store.transact !== "function") fail("Detections require the indexed private telemetry store.");
  const installed = loadPacks(stateDir, packs), allRules = installed.rules;
  const policies = configuration(config || readConfig(stateDir), allRules), db = store.db;
  const apps = store.controlSnapshot().apps;
  if ([...policies.keys()].some(id => !apps.some(app => app.appId === id))) fail("Register each application before enabling its detection policy.");
  for (const [appId, rules] of policies) for (const rule of rules.values()) {
    for (const sourceId of [...rule.sourceIds, ...rule.suppressions.map(s => s.sourceId).filter(Boolean)]) {
      if (!store.controlSnapshot().sources.some(s => s.sourceId === sourceId && s.appId === appId)) fail("Rollout and suppression sources must belong to the selected application.");
    }
    if (rule.suppressions.some(s => Date.parse(s.expiresAt) > now() + 30 * HORIZON)) fail("Suppressions may expire at most 30 days from startup.");
  }
  db.exec("CREATE TABLE IF NOT EXISTS detection_decisions(id TEXT PRIMARY KEY,app_id TEXT NOT NULL,source_id TEXT NOT NULL,rule_id TEXT NOT NULL,policy_revision TEXT NOT NULL,disposition TEXT NOT NULL,reason TEXT NOT NULL,created_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS detection_decision_app ON detection_decisions(app_id,disposition);");
  db.exec("CREATE TABLE IF NOT EXISTS detection_observations (app_id TEXT NOT NULL,source_id TEXT NOT NULL,rule_id TEXT NOT NULL,policy_revision TEXT NOT NULL,group_hash TEXT NOT NULL,record_id TEXT NOT NULL,event_at INTEGER NOT NULL,bucket INTEGER NOT NULL,PRIMARY KEY(source_id,rule_id,policy_revision,record_id)); CREATE INDEX IF NOT EXISTS detection_window ON detection_observations(app_id,source_id,rule_id,policy_revision,group_hash,bucket,event_at); CREATE TABLE IF NOT EXISTS detection_matches (id TEXT PRIMARY KEY,app_id TEXT NOT NULL,source_id TEXT NOT NULL,rule_id TEXT NOT NULL,policy_revision TEXT NOT NULL,created_at INTEGER NOT NULL);");
  function derive(records) {
    if (!db.inTransaction) fail("Detection evaluation must share the telemetry admission transaction.", 500);
    const findings = [], at = now();
    db.prepare("DELETE FROM detection_observations WHERE event_at < ?").run(at - HORIZON);
    const counts = db.prepare("SELECT count(*) n FROM detection_observations").get().n;
    if (counts > MAX_OBSERVATIONS) fail("Detection observation capacity reached; no input was admitted.", 507);
    for (const record of [...records].sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.recordId.localeCompare(b.recordId))) {
      if (record.kind === "finding" || !policies.has(record.estateId)) continue;
      for (const rule of policies.get(record.estateId).values()) {
        if (rule.sourceIds.length && !rule.sourceIds.includes(record.sourceId) || !matches(rule, record)) continue;
        let identity = record.recordId, count = 1, evidence = [record.recordId];
        if (rule.mode === "threshold") {
          const eventAt = Date.parse(record.observedAt);
          // Historical imports remain searchable; only the last 24h enters bounded correlation.
          if (eventAt < at - HORIZON || eventAt > at + 300000) continue;
          const fields = record.payload.fields || {};
          const group = rule.groupBy.map(key => key.startsWith("$") ? record.payload[key.slice(1)] : fields[key]);
          if (group.some(value => typeof value !== "string" || !value.trim() || value === "-" || value === "::" || value === "0.0.0.0")) continue;
          const groupHash = digest(group), bucket = Math.floor(eventAt / (rule.windowSeconds * 1000));
          db.prepare("INSERT OR IGNORE INTO detection_observations VALUES(?,?,?,?,?,?,?,?)").run(record.estateId, record.sourceId, rule.id, rule.policyRevision, groupHash, record.recordId, eventAt, bucket);
          const rows = db.prepare("SELECT record_id FROM detection_observations WHERE app_id=? AND source_id=? AND rule_id=? AND policy_revision=? AND group_hash=? AND bucket=? ORDER BY event_at,record_id LIMIT 1001")
            .all(record.estateId, record.sourceId, rule.id, rule.policyRevision, groupHash, bucket);
          count = rows.length; if (count < rule.threshold) continue;
          identity = digest([groupHash, bucket]); evidence = rows.slice(0, rule.threshold).map(row => row.record_id);
        }
        const suppressed = rule.suppressions.find(s => Date.parse(s.expiresAt) > at
          && (!s.sourceId || s.sourceId === record.sourceId)
          && Object.entries(s.fields || {}).every(([key,value]) => record.payload.fields?.[key] === value));
        const disposition = suppressed ? "suppressed" : rule.stage === "shadow" ? "shadow" : "active";
        const id = "detection:" + digest([record.estateId, record.sourceId, rule.id, rule.policyRevision, identity, disposition]);
        if (db.prepare("SELECT id FROM detection_matches WHERE id=?").get(id)) continue;
        if (findings.length >= MAX_DERIVED || db.prepare("SELECT count(*) n FROM detection_matches").get().n >= 250000) fail("Detection match capacity reached; split input or archive state before retrying.", 507);
        db.prepare("INSERT INTO detection_matches VALUES(?,?,?,?,?,?)").run(id, record.estateId, record.sourceId, rule.id, rule.policyRevision, at);
        db.prepare("INSERT INTO detection_decisions VALUES(?,?,?,?,?,?,?,?)").run(id, record.estateId, record.sourceId, rule.id, rule.policyRevision, disposition, suppressed?.reason || "", at);
        if (disposition !== "active") continue;
        findings.push(validateNormalizedRecord({ schemaVersion: "1", documentType: "normalized-record", recordId: id,
          sourceId: record.sourceId, estateId: record.estateId, kind: "finding", observedAt: record.observedAt,
          payload: { title: rule.title, state: "open", severity: rule.severity, ruleRef: rule.id,
            summary: "Recorded evidence matched a configured review rule. Authorized activity is possible; this is not a confirmed compromise. Rule by " + rule.author + " (" + rule.license + ").",
            ...(record.payload.assetRef ? { assetRef: record.payload.assetRef } : {}),
            ...(record.payload.identityRef ? { identityRef: record.payload.identityRef } : {}),
            count, fields: { detector: rule.packId ? "bb-soc-reviewed-pack" : "bb-soc-original", rulePack: rule.packId || "builtin", rulePackVersion: rule.packVersion || 1,
              licenseNotice: rule.notice || "Original BB SOC rules; MIT license.", ruleVersion: rule.version, policyRevision: rule.policyRevision,
              ruleAuthor: rule.author, ruleLicense: rule.license, evidenceRecordId: record.recordId,
              evidenceDigest: digest(evidence), evidenceCount: evidence.length, reference: rule.references[0],
              evaluationMode: rule.mode === "threshold" ? "fixed-event-time-window" : "single-event",
              threshold: rule.threshold || 1, windowSeconds: rule.windowSeconds || 0 } } }));
      }
    }
    if (db.prepare("SELECT count(*) n FROM detection_observations").get().n > MAX_OBSERVATIONS) fail("Detection observation capacity reached; no input was admitted.", 507);
    return findings;
  }
  function catalog(appId) {
    const selected = policies.get(appId) || new Map();
    return { schemaVersion: 1, rules: allRules.map(rule => ({ ...rule, enabled: selected.has(rule.id),
      policy: selected.has(rule.id) ? { stage: selected.get(rule.id).stage, sourceIds: selected.get(rule.id).sourceIds,
        suppressions: selected.get(rule.id).suppressions, threshold: selected.get(rule.id).threshold || null, windowSeconds: selected.get(rule.id).windowSeconds || null, revision: selected.get(rule.id).policyRevision } : null })),
      evidence: "Configured policy is not collection coverage. Review prerequisites and commission each source.",
      backend: "reviewed-bounded-v1", installedPacks: installed.packs.map(p => ({id:p.pack.id,version:p.pack.version,digest:p.digest,license:p.pack.license})),
      decisions: appId ? db.prepare("SELECT disposition,count(*) count FROM detection_decisions WHERE app_id=? GROUP BY disposition").all(appId) : [],
      sigmaExecution: false, automaticRuleDownloads: false };
  }
  function panels(appId) {
    const selection = catalog(appId);
    return [{ id: "portable-detection-rules", type: "table", title: "Portable detection rules",
      caption: "Built-in and fixture-validated licensed packs. Enable reviewed per-application policy in detection-config.json; select source IDs for canary rollout, use shadow evaluation or expiring exact suppressions. Active matches appear in Triage.",
      columns: [{ key: "rule", label: "Rule" }, { key: "title", label: "Signal" }, { key: "severity", label: "Severity" }, { key: "enabled", label: "Enabled for selected application" }, { key: "prerequisite", label: "Prerequisites" }],
      rows: selection.rules.map(rule => [rule.id, rule.title, rule.severity, rule.enabled ? rule.policy.stage === "shadow" ? "Shadow" : "Enabled" : "Disabled", rule.prerequisite]) }];
  }
  return { derive, catalog, panels, policies };
}
module.exports = { createDetectionEngine, configuration, MAX_DERIVED };
