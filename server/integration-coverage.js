"use strict";

// This is an allowlisted description of implemented reads, not a connector's
// requested UI targets. Imported facts never become locally authored actions.
const { RECORD_KINDS, validateTimestamp } = require("../tools/ingest-contract");

const OBSERVATION_LIMIT = 200;
const OBSERVATION_OFFSET_LIMIT = 1_000_000;
// Native selectors are navigation compatibility only. These facts do not have
// the authoritative queue/vendor/engine state needed to implement those views.
const PRESENTATION_SELECTORS = Object.freeze({
  "/brief": { btab: ["brief", "turnover", "analyst"] },
  "/triage": { view: ["queue", "approvals", "cases", "closed", "all"] },
  "/tuning": { tview: ["definitions", "applied", "held"], status: ["active", "draft", "disabled"] },
  "/rules": { rtab: ["palisade", "sigma", "yara", "snort", "tuning", "active", "add", "help"],
    tview: ["definitions", "applied", "held"], tstatus: ["all", "active", "draft", "disabled"],
    ptab: ["active", "add", "help", "decisions"], stab: ["rules", "add", "about"], ytab: ["about", "rules", "manage"] },
  "/alerts": { atab: ["path", "paged", "log", "reconcile"] },
  "/honeypots": { htab: ["decoys", "canaries", "users", "hits", "clerk"] },
  "/intel": { itab: ["bb", "otx", "threatfox", "urlhaus", "malwarebazaar", "feeds"], skind: ["all", "ip", "domain", "url", "sha256", "md5", "sha1"] },
  "/systems": { stab: ["estate", "affected"] },
  "/access": { atab: ["who", "refusals", "chain", "offboarding", "observations"], oview: ["records", "guide"] }
});
const observations = (route, title, recordKinds, query = {}, limitation = "Imported facts only; no local workflow or automation is executed.") =>
  ({ route, title, query, recordKinds, status: "observations", limitation });
const specialized = (route, title, recordKinds, query = {}, limitation = "Only the implemented read projection is populated.") =>
  ({ route, title, query, recordKinds, status: "specialized", limitation });

const INTEGRATION_COVERAGE = Object.freeze([
  specialized("/", "Overview", ["log.event"], {}, "Registry and recent log events, not inferred risk or compliance posture."),
  specialized("/health", "SOC Health", ["log.event", "source.heartbeat"], {}, "Collection cadence is measured from committed source deliveries, not detection-engine health."),
  specialized("/analytics", "Analytics", ["log.event"], {}, "Log event counts only; no inferred detections or behavioral model."),
  specialized("/logs", "Logs", ["log.event"]),
  specialized("/sources", "Sources", RECORD_KINDS, {}, "Registry and delivery health; registration alone does not prove data arrived."),
  observations("/sources", "All imported observations", RECORD_KINDS, { stab: "observations" }),
  observations("/timeline", "Timeline", RECORD_KINDS),
  observations("/brief", "Daily Brief", ["finding", "case.record", "remediation.record", "evidence.receipt"], {}, "A fact list, not an automatically generated daily briefing or turnover workflow."),
  observations("/triage", "Triage", ["finding", "case.record", "vulnerability.finding"], {}, "Reported findings/cases, not a mutable local case queue or approval system."),
  observations("/tuning", "Detection Tuning", ["rule.definition", "finding"], {}, "Reported rule/finding facts; no detector is compiled, tuned, or enabled."),
  observations("/rules", "Detection Rules", ["rule.definition"], {}, "Imported rule descriptions do not install or execute a rule engine."),
  observations("/alerts", "Alert Comms", ["alert.delivery"], {}, "Upstream delivery reports, not a notification sender or a delivery guarantee."),
  observations("/honeypots", "Honeypots", ["honeypot.event"], {}, "Upstream honeypot observations; no canaries, accounts, or decoys are deployed."),
  observations("/phishing", "Phishing", ["phishing.report"], {}, "Upstream reports, not local email submission, scoring, or attachment inspection."),
  observations("/activity", "Activity Learner", ["authentication.event", "endpoint.event", "network.event"], {}, "Observed activity, not a computed or trained behavioral baseline."),
  observations("/ioc", "IOC Parser", ["intel.indicator"], {}, "Imported indicators; no pasted-text extraction or active hunting is executed."),
  observations("/intel", "Threat Intel", ["intel.indicator", "intel.sync"], {}, "All imported providers; vendor tab names do not attest provider provenance or run a sync."),
  observations("/known-ips", "Known IPs", ["intel.indicator"], {}, "All imported indicators, not an authoritative allowlist or trusted-address decision."),
  specialized("/scans", "Trivy report imports", ["scan.result", "software.package", "vulnerability.finding"], { tab: "trivy" }, "Only validated Trivy report imports from trivy-report sources populate this specialized view; generic records remain in Observations."),
  observations("/scans", "Patch first", ["software.package", "vulnerability.finding"], { tab: "patch" }, "Reported package/vulnerability facts only; no computed patch priority, KEV, or EPSS enrichment."),
  observations("/scans", "File integrity", ["file.integrity"], { tab: "fim" }, "Reported file-integrity facts; no baseline collection or filesystem scan is performed."),
  observations("/scans", "End of life", ["software.package"], { tab: "eol" }, "Reported packages only; support dates and end-of-life status are not inferred."),
  observations("/scans", "External surface", ["asset.snapshot", "scan.result", "network.event"], { tab: "exposure" }, "All matching canonical observations; no external sweep or Shodan lookup is performed."),
  observations("/scans", "IOC scan", ["finding", "scan.result", "intel.indicator"], { tab: "ioc" }, "Imported observations, not proof of an IOC scan or a clean filesystem."),
  observations("/scans", "URL scanning", ["network.event", "scan.result"], { tab: "urlscan" }, "All matching imported providers; no URL is submitted or rendered by this application."),
  observations("/scans", "Dependencies", ["software.package", "vulnerability.finding"], { tab: "deps" }, "Reported dependencies/advisories, not automatic advisory matching."),
  observations("/scans", "Upload AV", ["endpoint.event", "finding"], { tab: "av" }, "Reported endpoint/finding facts, not document malware scanning or proof that an upload is safe."),
  observations("/scans", "Quarantine", ["endpoint.event", "finding"], { tab: "quarantine" }, "Reported facts, not a live quarantine inventory; no files are retrieved or deleted."),
  observations("/scans", "Remediation log", ["remediation.record", "evidence.receipt"], { tab: "remediation" }, "Upstream remediation/evidence claims, not independent verification of a fix."),
  observations("/remediation", "Remediation", ["remediation.record", "evidence.receipt"], {}, "Imported remediation claims; no risk, case, or attestation is automatically closed."),
  observations("/systems", "Systems", ["asset.snapshot", "endpoint.event"]),
  observations("/databases", "Databases", ["database.schema"]),
  observations("/backups", "Backups", ["backup.status", "evidence.receipt"], {}, "Upstream backup claims, not an independently verified restore."),
  observations("/access", "Access observations", ["identity.access", "authentication.event", "audit.event", "offboarding.record"], { atab: "observations" }, "External identity facts never grant console permissions or offboard a user here. Use the Who tab for actual local application permissions."),
  specialized("/retention", "Local telemetry retention", [], {}, "Local configured retention and measured counters. Imported retention.snapshot claims are available in Sources → Observations only."),
  specialized("/attestations", "Authored attestations", [], {}, "Imported governance.attestation/compliance.record/evidence.receipt facts remain observations; use administration commands to author local records."),
  specialized("/register", "Authored risks", [], {}, "Imported governance.risk facts remain observations; use administration commands to author local risks."),
  specialized("/documents", "Document library", [], {}, "Document uploads/versioning are separate from canonical evidence.receipt observations."),
  specialized("/agents", "Agent management", [], {}, "Registration, prompts, and service access only; importing records never starts agent execution.")
].map((entry) => Object.freeze({ ...entry, query: Object.freeze(entry.query), recordKinds: Object.freeze([...entry.recordKinds]) })));

function identifier(value, label) {
  if (typeof value !== "string" || value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) throw new TypeError(label + " is invalid.");
  return value;
}

function normalizeObservationQuery(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError("Observation filters must be a plain object.");
  const allowed = ["kinds", "sourceId", "appId", "limit", "offset", "observedAfter", "observedBefore"];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!allowed.includes(key) || !descriptor || descriptor.get || descriptor.set) throw new TypeError("Unsupported observation filter.");
  }
  const result = { limit: value.limit === undefined ? OBSERVATION_LIMIT : value.limit, offset: value.offset === undefined ? 0 : value.offset };
  if (!Number.isSafeInteger(result.limit) || result.limit < 1 || result.limit > OBSERVATION_LIMIT) throw new TypeError("Observation limit must be an integer from 1 through 200.");
  if (!Number.isSafeInteger(result.offset) || result.offset < 0 || result.offset > OBSERVATION_OFFSET_LIMIT) throw new TypeError("Observation offset must be an integer from 0 through 1000000.");
  if (value.kinds !== undefined) {
    if (!Array.isArray(value.kinds) || !value.kinds.length || value.kinds.length > RECORD_KINDS.length
        || value.kinds.some((kind) => !RECORD_KINDS.includes(kind)) || new Set(value.kinds).size !== value.kinds.length) throw new TypeError("Observation kinds must be distinct supported canonical record kinds.");
    result.kinds = [...value.kinds].sort();
  }
  for (const key of ["sourceId", "appId"]) if (value[key] !== undefined) result[key] = identifier(value[key], "Observation " + key);
  for (const key of ["observedAfter", "observedBefore"]) if (value[key] !== undefined) result[key] = new Date(validateTimestamp(value[key], "Observation " + key)).toISOString();
  if (result.observedAfter && result.observedBefore && result.observedAfter >= result.observedBefore) throw new TypeError("Observation time range must be increasing.");
  return result;
}

function observationCoverage(route, query = {}) {
  if (route === "/scans") {
    const tab = query.tab || "trivy";
    const entry = INTEGRATION_COVERAGE.find((item) => item.route === route && item.query.tab === tab);
    if (!entry) throw new TypeError("Unknown scanner tab.");
    return entry.status === "observations" ? entry : null;
  }
  if (route === "/sources") return query.stab === "observations" ? INTEGRATION_COVERAGE.find((item) => item.route === route && item.status === "observations") : null;
  return INTEGRATION_COVERAGE.find((item) => item.route === route && item.status === "observations") || null;
}

// UI tab selectors deliberately do not imply vendor/queue/engine filtering.
// Their existing native workflow is not implemented by these observation reads.
function pageObservationQuery(route, query, now) {
  const entry = observationCoverage(route, query);
  if (!entry) return null;
  const selectors = PRESENTATION_SELECTORS[route] || {};
  const actualKeys = ["sourceId", "appId", "limit", "offset", ...Object.keys(entry.query), ...(route === "/timeline" ? ["range"] : [])];
  for (const key of Object.keys(query)) {
    if (Object.hasOwn(selectors, key)) {
      if (!selectors[key].includes(query[key])) throw new TypeError("Unknown observation presentation selector: " + key + ".");
    } else if (!actualKeys.includes(key)) {
      throw new TypeError("Unsupported observation page filter: " + key + ". Native search/detail identifiers are not implemented; use Sources → Observations filters.");
    }
  }
  const integer = (key) => {
    if (query[key] === undefined) return undefined;
    if (!/^(0|[1-9][0-9]*)$/.test(query[key])) throw new TypeError("Invalid observation " + key + ".");
    return Number(query[key]);
  };
  const filter = { kinds: entry.recordKinds, limit: integer("limit"), offset: integer("offset") };
  for (const key of ["sourceId", "appId"]) if (query[key] !== undefined) filter[key] = query[key];
  if (route === "/timeline") {
    const ranges = { "15m": 900000, "1h": 3600000, "24h": 86400000, "7d": 604800000 };
    const range = query.range || "24h";
    if (!Object.hasOwn(ranges, range)) throw new TypeError("Unknown timeline range.");
    filter.observedAfter = new Date(new Date(now).getTime() - ranges[range]).toISOString();
    filter.observedBefore = new Date(new Date(now).getTime() + 1).toISOString();
  }
  return normalizeObservationQuery(filter);
}

function createObservationEnvelope(route, query, state, selection, now) {
  const entry = observationCoverage(route, query);
  if (!entry) throw new TypeError("This route has no generic observation projection.");
  const sources = new Map(state.sources.map((source) => [source.sourceId, source]));
  const apps = new Map(state.apps.map((app) => [app.appId, app]));
  const selectors = PRESENTATION_SELECTORS[route] || {};
  const presentation = Object.keys(query).filter((key) => Object.hasOwn(selectors, key)
    && (!Object.hasOwn(entry.query, key) || query[key] !== entry.query[key])).map((key) => key + "=" + query[key]);
  const presentationNotice = presentation.length ? " Presentation-only selectors (not applied as filters): " + presentation.join(", ") + "." : "";
  const summary = `${selection.count} retained observations matched; showing ${selection.records.length} at offset ${selection.offset}. ${selection.omitted} omitted from this page. Results are newest first and bounded to 200 rows and 2 MiB of stored records; pages can shift when new data arrives.`;
  return { schemaVersion: "1", route, state: selection.count ? "ready" : "empty", title: entry.title,
    summary, updatedAt: new Date(now === undefined ? Date.now() : now).toISOString(), panels: [
      { id: "imported-observation-scope", type: "notice", title: "Imported observations — read only", tone: "info",
        body: entry.limitation + " State and severity below are exactly what the producer reported, not a console verdict. Existing workflow/vendor tabs do not classify these facts." + presentationNotice + " Filter by application or source in Sources → Observations. Retained history includes removed and archived sources, labeled below." },
      { id: "imported-observations", type: "table", title: "Imported observations", caption: "Canonical facts as reported by your integrations",
        columns: [{ key: "when", label: "Observed at" }, { key: "application", label: "Application / environment" }, { key: "source", label: "Source" },
          { key: "lifecycle", label: "Source lifecycle" }, { key: "kind", label: "Kind" }, { key: "title", label: "Reported title" },
          { key: "state", label: "Reported state" }, { key: "severity", label: "Reported severity" }],
        rows: selection.records.map((record) => {
          const source = sources.get(record.sourceId), app = source && apps.get(source.appId);
          return [{ type: "time", value: new Date(record.observedAt).toISOString() }, source ? `${app?.displayName || source.appId} / ${source.environment || "default"}` : record.estateId,
            source?.displayName || record.sourceId, source?.state || "unregistered", record.kind, record.payload.title, record.payload.state, record.payload.severity || "Not reported"];
        }) }
    ] };
}

module.exports = { INTEGRATION_COVERAGE, OBSERVATION_LIMIT, OBSERVATION_OFFSET_LIMIT, normalizeObservationQuery, observationCoverage, pageObservationQuery, createObservationEnvelope };
