"use strict";

const SCANNER_PAGE_ROUTES = Object.freeze(["/scans"]);
const MAX_ROWS = 200;

function table(id, title, columns, rows, description) {
  return { id, type: "table", title, caption: title, description,
    columns: columns.map(([key, label]) => ({ key, label })), rows: rows.slice(0, MAX_ROWS).map((row) => columns.map(([key]) => row[key])) };
}

function createScannerPageEnvelope(route, query, state, records, now) {
  if (route !== "/scans") throw new TypeError("Scanner projector supports /scans only.");
  const envelope = { schemaVersion: "1", route, updatedAt: new Date(now === undefined ? Date.now() : now).toISOString(),
    state: "empty", title: "Trivy report imports", summary: "No Trivy vulnerability report has been imported.", panels: [] };
  if (query && query.tab && query.tab !== "trivy") {
    return { ...envelope, title: "No scanner provider supplied", summary: "This scanner tab still requires an adopter-supplied driver. Trivy imports do not populate other scanners." };
  }
  const sourceById = new Map(state.sources.filter((source) => source.connectorType === "trivy-report").map((source) => [source.sourceId, source]));
  const apps = new Map(state.apps.map((app) => [app.appId, app]));
  const label = (sourceId) => {
    const source = sourceById.get(sourceId), app = source && apps.get(source.appId);
    return source ? (app ? app.displayName : source.appId) + " / " + (source.environment || "default") : sourceId;
  };
  const latest = new Map();
  records.filter((record) => record.kind === "scan.result" && sourceById.has(record.sourceId)
    && record.payload.fields && record.payload.fields.scanner === "trivy").forEach((record) => {
    const previous = latest.get(record.sourceId);
    if (!previous || record.observedAt > previous.observedAt || (record.observedAt === previous.observedAt && record.recordId > previous.recordId)) latest.set(record.sourceId, record);
  });
  const findings = records.filter((record) => record.kind === "vulnerability.finding" && latest.has(record.sourceId)
    && record.payload.fields && record.payload.fields.reportRef === latest.get(record.sourceId).payload.fields.reportRef);
  const packages = records.filter((record) => record.kind === "software.package" && latest.has(record.sourceId)
    && record.payload.fields && record.payload.fields.reportRef === latest.get(record.sourceId).payload.fields.reportRef);
  const reports = [...latest.values()].sort((a, b) => b.observedAt.localeCompare(a.observedAt));
  const totalFindings = reports.reduce((sum, record) => sum + record.payload.fields.vulnerabilityCount, 0);
  const totalPackages = reports.reduce((sum, record) => sum + record.payload.fields.packageCount, 0);
  envelope.state = reports.length ? "ready" : "empty";
  envelope.summary = reports.length ? "Latest retained report per source; imported observations, not live scan execution or a clean-application guarantee." : envelope.summary;
  envelope.panels = [{ id: "trivy-import-scope", type: "notice", title: "Reported vulnerability coverage only", tone: "info",
    body: "This page uses the latest retained report timestamp per Trivy source. Zero findings does not prove complete coverage. Old reports remain historical records; importing a report does not close cases, attestations or remediation. Each table shows at most 200 retained rows. The totals come from report summaries and can exceed the visible rows." },
  { id: "trivy-import-metrics", type: "metrics", title: "Latest report observations", items: [
    { label: "Sources with imported reports", value: reports.length }, { label: "Reported packages", value: totalPackages },
    { label: "Reported vulnerabilities", value: totalFindings, tone: totalFindings ? "warn" : "neutral" }
  ] },
  table("trivy-operating-system-packages", "Trivy — application reports", [["application", "Application / environment"], ["source", "Source"],
    ["packages", "Packages"], ["findings", "Vulnerabilities"], ["scanned", "Report timestamp"], ["state", "Source state"]],
  reports.map((record) => ({ application: label(record.sourceId), source: sourceById.get(record.sourceId).displayName,
    packages: record.payload.fields.packageCount, findings: record.payload.fields.vulnerabilityCount,
    scanned: { type: "time", value: record.observedAt }, state: sourceById.get(record.sourceId).state })),
  "Application package observations include OS and language dependencies. Removed/archived source history remains visible and labeled."),
  table("trivy-vulnerabilities", "Reported vulnerabilities", [["application", "Application / environment"], ["advisory", "Advisory"],
    ["package", "Package"], ["installed", "Installed"], ["fixed", "Reported fixed version"], ["severity", "Severity"]],
  findings.sort((a, b) => ({ critical: 0, high: 1, medium: 2, low: 3, unknown: 4 }[a.payload.severity] - { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 }[b.payload.severity]) || a.recordId.localeCompare(b.recordId)).map((record) => {
    const fields = record.payload.fields;
    return { application: label(record.sourceId), advisory: fields.vulnerabilityId, package: fields.packageName,
      installed: fields.installedVersion, fixed: fields.fixedVersion || "Not reported", severity: { type: "badge", label: record.payload.severity,
        tone: ["critical", "high"].includes(record.payload.severity) ? "bad" : "warn" } };
  }), "Findings from latest retained reports only. A fixed-version field is an upstream recommendation, not evidence of an installed fix."),
  table("trivy-package-inventory", "Reported packages", [["application", "Application / environment"], ["package", "Package"],
    ["version", "Version"], ["ecosystem", "Ecosystem"]],
  packages.map((record) => ({ application: label(record.sourceId), package: record.payload.fields.packageName,
    version: record.payload.fields.installedVersion, ecosystem: record.payload.fields.ecosystem })),
  "Package inventory may be partial when the supplied Trivy report lists only vulnerable packages.")];
  return envelope;
}

module.exports = { SCANNER_PAGE_ROUTES, createScannerPageEnvelope };
