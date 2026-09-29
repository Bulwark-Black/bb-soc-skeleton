"use strict";

// A report importer, never a scanner runner. Only a small allowlist of package
// and vulnerability fields crosses into canonical storage. Original reports,
// target paths, image configuration, secrets, descriptions and URLs do not.
const crypto = require("node:crypto");
const { validateIngestBatch, validateTimestamp } = require("../tools/ingest-contract");
const { ReferenceControlError } = require("./reference-runtime");
const { readJsonBody, sendJson, distinctHeader } = require("./reference-control-plane");

const TRIVY_REPORT_LIMIT = 8 * 1024 * 1024;
const TRIVY_RESULT_LIMIT = 64;
const TRIVY_RECORD_LIMIT = 1000;
const TRIVY_IMPORT_PATH = "/api/v1/scanners/trivy/import";
const SEVERITY = Object.freeze({ CRITICAL: "critical", HIGH: "high", MEDIUM: "medium", LOW: "low", UNKNOWN: "unknown" });

function fail(message, status = 422) { throw new ReferenceControlError("validation-failed", message, { status }); }
function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(label + " must be a JSON object.");
  return value;
}
function string(value, label, limit = 1000) {
  if (typeof value !== "string" || !value.trim() || value.length > limit || /[\u0000-\u001f\u007f]/.test(value)) {
    fail(label + " must be nonempty bounded text without control characters.");
  }
  return value;
}
function identifier(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) fail(label + " must be a canonical identifier.");
  return value;
}
function hash(value) { return crypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex"); }
function list(value, label) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > TRIVY_RECORD_LIMIT) fail(label + " must be an array with at most 1,000 entries.");
  return value;
}
function rejectError(value, label) {
  for (const key of ["Error", "Errors", "error", "errors"]) {
    if (value[key] !== undefined && value[key] !== null && value[key] !== "" && !(Array.isArray(value[key]) && !value[key].length)) {
      fail(label + " reports a scanner error; failed or partial reports are not admitted as successful scans.");
    }
  }
}
function packageText(value, label) {
  const text = string(value, label, 300);
  if (/\s|:\/\/|[\\?#]/.test(text)) fail(label + " is not a supported package name or installed version.");
  return text;
}
function createdAt(value) {
  // Go emits RFC3339Nano while the canonical contract uses millisecond time.
  const raw = string(value, "CreatedAt", 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) fail("CreatedAt must be an RFC 3339 timestamp.");
  const millisecond = raw.replace(/\.(\d{3})\d+(?=Z|[+-])/, ".$1");
  try { validateTimestamp(millisecond, "CreatedAt"); } catch { fail("CreatedAt must be a valid RFC 3339 calendar timestamp."); }
  return new Date(millisecond).toISOString();
}

function normalizeTrivyReport(value, context) {
  const report = object(value, "Trivy report");
  const sourceId = identifier(context && context.sourceId, "sourceId");
  const estateId = identifier(context && context.estateId, "estateId");
  if (report.SchemaVersion !== 2) fail("Only Trivy JSON SchemaVersion 2 reports are supported; SARIF, SBOM and arbitrary JSON are not scan reports.");
  rejectError(report, "Trivy report");
  const observedAt = createdAt(report.CreatedAt);
  const artifactName = string(report.ArtifactName, "ArtifactName", 2000);
  const artifactType = string(report.ArtifactType, "ArtifactType", 100);
  if (!["container_image", "filesystem", "repository", "rootfs", "sbom"].includes(artifactType)) fail("This Trivy artifact type is not supported by the vulnerability report importer.");
  if (!Array.isArray(report.Results) || report.Results.length < 1 || report.Results.length > TRIVY_RESULT_LIMIT) {
    fail("Results must contain 1–64 package-scan results. Missing or empty Results cannot establish vulnerability-scan coverage; export an explicit package result.");
  }
  const artifacts = [], packages = new Map(), vulnerabilities = new Map();
  for (const resultValue of report.Results) {
    const result = object(resultValue, "Result");
    rejectError(result, "Result");
    if (!["os-pkgs", "lang-pkgs"].includes(result.Class)) fail("Only os-pkgs and lang-pkgs vulnerability results are supported. Export vulnerability-only JSON, not secret/configuration/license results.");
    const targetRef = "target:" + hash(string(result.Target, "Result.Target", 2000));
    const ecosystem = string(result.Type, "Result.Type", 80);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(ecosystem)) fail("Result.Type must be a package ecosystem identifier.");
    const base = { targetRef, ecosystem, packageClass: result.Class };
    artifacts.push(base);
    const addPackage = (name, version) => {
      const item = { ...base, packageName: packageText(name, "Package name"), installedVersion: packageText(version, "Installed version") };
      packages.set(hash(item), item);
      if (packages.size + vulnerabilities.size + 1 > TRIVY_RECORD_LIMIT) fail("The report exceeds the 1,000 canonical-record atomic import limit. Split scans by application artifact before exporting.");
      return item;
    };
    for (const packageValue of list(result.Packages, "Result.Packages")) {
      const item = object(packageValue, "Package");
      addPackage(item.Name, item.Version);
    }
    for (const vulnerabilityValue of list(result.Vulnerabilities, "Result.Vulnerabilities")) {
      const item = object(vulnerabilityValue, "Vulnerability");
      const packageItem = addPackage(item.PkgName, item.InstalledVersion);
      const vulnerabilityId = string(item.VulnerabilityID, "VulnerabilityID", 128);
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(vulnerabilityId)) fail("VulnerabilityID must be a bounded advisory identifier.");
      if (!Object.hasOwn(SEVERITY, item.Severity)) fail("Vulnerability.Severity is unsupported; use CRITICAL, HIGH, MEDIUM, LOW or UNKNOWN.");
      const fixedVersion = item.FixedVersion === undefined || item.FixedVersion === "" ? "" : string(item.FixedVersion, "FixedVersion", 300);
      if (/[:][\/]{2}|[\\?#]/.test(fixedVersion)) fail("FixedVersion must contain version information, not a URL or path.");
      const normalized = { ...packageItem, vulnerabilityId, severity: SEVERITY[item.Severity], fixedVersion };
      vulnerabilities.set(hash(normalized), normalized);
      if (packages.size + vulnerabilities.size + 1 > TRIVY_RECORD_LIMIT) fail("The report exceeds the 1,000 canonical-record atomic import limit. Split scans by application artifact before exporting.");
    }
  }
  const sorted = (items) => [...items].sort((a, b) => {
    const left = JSON.stringify(a), right = JSON.stringify(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const packageItems = sorted(packages.values()), vulnerabilityItems = sorted(vulnerabilities.values());
  const reportRef = "trivy:" + hash({ observedAt, artifactRef: hash(artifactName), artifactType,
    results: sorted(artifacts), packages: packageItems, vulnerabilities: vulnerabilityItems });
  const assetRef = "artifact:" + hash([estateId, artifactType, artifactName]);
  const common = { schemaVersion: "1", documentType: "normalized-record", sourceId, estateId, observedAt };
  const record = (kind, payload, identity) => ({ ...common, recordId: "trivy:" + hash([reportRef, kind, identity]), kind, payload });
  const records = [record("scan.result", {
    title: "Imported Trivy vulnerability report", state: vulnerabilities.size ? "warn" : "unknown", assetRef,
    category: "trivy", count: vulnerabilities.size, completedAt: observedAt,
    summary: "Imported reported package vulnerabilities only. Zero findings is not proof of complete coverage or a clean application.",
    fields: { scanner: "trivy", reportRef, artifactType, packageCount: packages.size,
      vulnerabilityCount: vulnerabilities.size, resultCount: report.Results.length, coverage: "reported-only" }
  }, "summary")];
  for (const item of packageItems) records.push(record("software.package", {
    title: item.packageName.slice(0, 300), state: "active", assetRef, category: "trivy", fields: { ...item, reportRef }
  }, item));
  for (const item of vulnerabilityItems) records.push(record("vulnerability.finding", {
    title: (item.vulnerabilityId + " · " + item.packageName).slice(0, 300), state: "open", assetRef,
    severity: item.severity, category: "trivy", fields: { ...item, reportRef }
  }, item));
  const batch = validateIngestBatch({ schemaVersion: "1", documentType: "ingest-batch", sourceId,
    receiptId: "trivy:" + hash([sourceId, reportRef]), sentAt: observedAt, records });
  return { batch, bodyHash: hash(batch), summary: { reportRef, packageCount: packages.size,
    vulnerabilityCount: vulnerabilities.size, resultCount: report.Results.length, coverage: "reported-only" } };
}

async function handleScannerImport({ request, response, url, runtime, actor }) {
  if (url.pathname !== TRIVY_IMPORT_PATH) return false;
  if (request.method !== "POST") { response.setHeader("Allow", "POST"); fail("Trivy import requires POST.", 405); }
  const entries = [...url.searchParams.entries()];
  if (entries.length !== 1 || entries[0][0] !== "sourceId") fail("Supply exactly one sourceId query parameter.", 400);
  const sourceId = identifier(entries[0][1], "sourceId");
  // Do not allow a browser session to turn an invalid presented machine token
  // into operator authority. Root chooses this mode before parsing the body.
  const authorization = distinctHeader(request, "authorization");
  if (actor && authorization !== undefined) fail("Use either an operator session or source authorization, not both.", 400);
  const match = typeof authorization === "string" && /^Bearer ([A-Za-z0-9_-]{32,512})$/.exec(authorization);
  if (!actor && !match) throw new ReferenceControlError("not-authorized", "A source-bound Bearer credential is required.", { status: 401 });
  const credential = actor ? null : match[1];
  const source = actor ? runtime.controlState().sources.find((item) => item.sourceId === sourceId)
    : runtime.authorizeScannerSource(sourceId, credential);
  if (!source || source.connectorType !== "trivy-report" || source.sourceKind !== "trivy.scan") fail("Choose a Trivy JSON report source.", 404);
  const { value } = await readJsonBody(request, TRIVY_REPORT_LIMIT);
  const normalized = normalizeTrivyReport(value, { sourceId, estateId: source.appId });
  const receipt = actor
    ? runtime.ingestAsOperator(normalized.batch, normalized.bodyHash)
    : runtime.ingestScanner(normalized.batch, credential, normalized.bodyHash);
  sendJson(response, 200, { schemaVersion: "1", documentType: "scanner-import-result", scanner: "trivy", receipt, summary: normalized.summary });
  return true;
}

module.exports = { TRIVY_IMPORT_PATH, TRIVY_REPORT_LIMIT, TRIVY_RESULT_LIMIT, TRIVY_RECORD_LIMIT, normalizeTrivyReport, handleScannerImport };
