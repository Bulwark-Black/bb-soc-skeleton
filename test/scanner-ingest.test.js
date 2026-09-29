"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { normalizeTrivyReport, TRIVY_RECORD_LIMIT } = require("../server/scanner-ingest");
const { createScannerPageEnvelope } = require("../server/scanner-pages");
const { TRIVY_REPORT_MANIFEST, REFERENCE_SCAN_CONNECTOR_MANIFESTS } = require("../server/reference-manifest");
const ConnectorContract = require("../public/connector-contract");
const { argumentsFor, readCredential, readResult } = require("../tools/import-trivy");
const { Readable } = require("node:stream");

function report() {
  return { SchemaVersion: 2, CreatedAt: "2026-09-20T10:20:30.123456789Z", ArtifactName: "application-artifact",
    ArtifactType: "filesystem", Metadata: { ImageConfig: { Env: ["PRIVATE_VALUE=must-not-retain"] } }, Results: [{
      Target: "app/package-lock.json", Class: "lang-pkgs", Type: "npm", Packages: [{ Name: "example-package", Version: "1.0.0" }],
      Secrets: [{ Match: "must-not-retain" }], Vulnerabilities: [{ VulnerabilityID: "CVE-2026-0001", PkgName: "example-package",
        InstalledVersion: "1.0.0", FixedVersion: "1.0.1", Severity: "HIGH", Description: "must-not-retain",
        PrimaryURL: "https://example.invalid/private" }]
    }] };
}
const context = { sourceId: "source:trivy", estateId: "app:example" };

test("Trivy manifest is a real app-scoped importer separate from all data-only templates", () => {
  const checked = ConnectorContract.validateConnectorManifest(TRIVY_REPORT_MANIFEST);
  assert.equal(checked.connectorType, "trivy-report");
  assert.equal(checked.scope, "application");
  assert.deepEqual(checked.payload.recordKinds, ["scan.result", "software.package", "vulnerability.finding"]);
  assert.equal(REFERENCE_SCAN_CONNECTOR_MANIFESTS.length, 11);
  assert.ok(REFERENCE_SCAN_CONNECTOR_MANIFESTS.every((manifest) => manifest.description.includes("Data-only setup template")));
});

test("Trivy normalizer retains only allowed observations and creates stable atomic identities", () => {
  const first = normalizeTrivyReport(report(), context);
  assert.equal(first.batch.records.length, 3);
  assert.deepEqual(first.batch.records.map((record) => record.kind), ["scan.result", "software.package", "vulnerability.finding"]);
  assert.equal(first.batch.records[0].observedAt, "2026-09-20T10:20:30.123Z");
  assert.equal(first.batch.records[0].payload.state, "warn");
  assert.equal(first.batch.records[2].payload.severity, "high");
  assert.equal(first.summary.packageCount, 1);
  assert.equal(first.summary.vulnerabilityCount, 1);
  const retained = JSON.stringify(first);
  for (const excluded of ["must-not-retain", "ImageConfig", "Description", "PrimaryURL", "app/package-lock.json", "application-artifact", "example.invalid"]) assert.ok(!retained.includes(excluded), excluded);
  assert.deepEqual(normalizeTrivyReport(report(), context), first);
  const changedMetadata = report(); changedMetadata.Metadata = { arbitrary: "never retained" }; changedMetadata.Results[0].Secrets = [];
  assert.deepEqual(normalizeTrivyReport(changedMetadata, context), first, "excluded private fields do not affect public record or receipt identities");
  const otherSource = normalizeTrivyReport(report(), { ...context, sourceId: "source:other" });
  assert.notEqual(first.batch.receiptId, otherSource.batch.receiptId);
  const changedObservation = report(); changedObservation.Results[0].Vulnerabilities[0].Severity = "CRITICAL";
  assert.notEqual(first.batch.receiptId, normalizeTrivyReport(changedObservation, context).batch.receiptId);
});

test("Trivy report ordering and repeated duplicate package observations do not change replay", () => {
  const value = report();
  value.Results.push({ Target: "second-lock", Class: "lang-pkgs", Type: "npm", Packages: [{ Name: "other-package", Version: "2" }] });
  const first = normalizeTrivyReport(value, context);
  value.Results.reverse(); value.Results[1].Packages.push({ Name: "example-package", Version: "1.0.0" });
  assert.deepEqual(normalizeTrivyReport(value, context), first);
});

test("zero vulnerabilities are explicitly unknown coverage, not a clean scan claim", () => {
  const value = report(); delete value.Results[0].Vulnerabilities;
  const checked = normalizeTrivyReport(value, context);
  assert.equal(checked.summary.vulnerabilityCount, 0);
  assert.equal(checked.batch.records[0].payload.state, "unknown");
  assert.equal(checked.summary.coverage, "reported-only");
});

test("Trivy imports reject unsupported or failed reports instead of manufacturing scan success", () => {
  const mutations = [
    (value) => { value.SchemaVersion = 1; }, (value) => { delete value.CreatedAt; },
    (value) => { value.CreatedAt = "2026-02-30T10:20:30Z"; }, (value) => { value.Results = []; },
    (value) => { delete value.Results; }, (value) => { value.Results = Array.from({ length: 65 }, () => report().Results[0]); },
    (value) => { value.Error = "scanner failed"; }, (value) => { value.Results[0].Errors = ["partial scan"]; },
    (value) => { value.Results[0].Class = "secret"; }, (value) => { value.Results[0].Packages = {}; },
    (value) => { value.Results[0].Vulnerabilities[0].Severity = "safe"; },
    (value) => { value.Results[0].Vulnerabilities[0].VulnerabilityID = "invalid advisory id"; },
    (value) => { value.Results[0].Vulnerabilities[0].InstalledVersion = ""; },
    (value) => { value.Results[0].Packages[0].Name = "https://example.invalid/private"; }
  ];
  for (const mutate of mutations) { const value = report(); mutate(value); assert.throws(() => normalizeTrivyReport(value, context)); }
  assert.throws(() => normalizeTrivyReport(report(), { sourceId: "invalid/source", estateId: context.estateId }));
});

test("Trivy atomic normalized record budget rejects the full report without truncation", () => {
  const value = report(); delete value.Results[0].Vulnerabilities;
  value.Results[0].Packages = Array.from({ length: TRIVY_RECORD_LIMIT - 1 }, (_, index) => ({ Name: "package-" + index, Version: "1" }));
  assert.equal(normalizeTrivyReport(value, context).batch.records.length, TRIVY_RECORD_LIMIT);
  value.Results[0].Packages.push({ Name: "one-too-many", Version: "1" });
  assert.throws(() => normalizeTrivyReport(value, context), /atomic import limit/);
});

test("Trivy projection uses latest report per source and never projects into other scanner tabs", () => {
  const first = normalizeTrivyReport(report(), context), cleanReport = report();
  cleanReport.CreatedAt = "2026-09-21T10:20:30Z"; cleanReport.Results[0].Vulnerabilities = [];
  const second = normalizeTrivyReport(cleanReport, context);
  const state = { apps: [{ appId: context.estateId, displayName: "Application" }],
    sources: [{ sourceId: context.sourceId, appId: context.estateId, connectorType: "trivy-report", environment: "production", displayName: "Package report", state: "active" }] };
  const envelope = createScannerPageEnvelope("/scans", {}, state, [...first.batch.records, ...second.batch.records], "2026-09-22T00:00:00Z");
  const vmContext = vm.createContext({}); vmContext.window = vmContext;
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../public/adapter-contract.js"), "utf8"), vmContext);
  const checked = vmContext.SocConsoleAdapterRuntime.validateEnvelope(envelope, "/scans");
  assert.equal(checked.state, "ready");
  assert.equal(checked.panels.find((panel) => panel.id === "trivy-vulnerabilities").rows.length, 0);
  assert.equal(checked.panels.find((panel) => panel.id === "trivy-import-metrics").items[2].value, 0);
  assert.equal(createScannerPageEnvelope("/scans", { tab: "fim" }, state, first.batch.records).state, "empty");
});

test("Trivy sender CLI accepts private destinations and bounded stdin credentials only", async () => {
  const base = ["--file", "/private/report.json", "--source-id", "source:example", "--credential-stdin"];
  assert.equal(argumentsFor(base).baseURL, "http://127.0.0.1:8080");
  assert.throws(() => argumentsFor([...base, "--base-url", "https://example.invalid"]));
  assert.throws(() => argumentsFor([...base, "--credential", "not-permitted"]));
  assert.throws(() => argumentsFor(["--file", "relative.json", "--source-id", "source:example", "--credential-stdin"]));
  assert.throws(() => argumentsFor(["--file", "/private/report.json", "--source-id", "source:example"]));
  const value = require("node:crypto").randomBytes(30).toString("base64url");
  assert.equal(await readCredential(Readable.from([value + "\n"])), value);
  await assert.rejects(readCredential(Readable.from(["x".repeat(601)])), /bound/);
  await assert.rejects(readCredential(Readable.from(["invalid"])), /invalid/);
});

test("Trivy sender bounds and validates responses without echoing arbitrary remote messages", async () => {
  const options = { headers: { "content-type": "application/json" } };
  const good = { schemaVersion: "1", documentType: "scanner-import-result", scanner: "trivy",
    receipt: { schemaVersion: "1", documentType: "ingest-receipt", status: "accepted", receiptId: "trivy:" + "a".repeat(64), accepted: 3, replay: false },
    summary: { packageCount: 1, vulnerabilityCount: 1 } };
  assert.equal((await readResult(new Response(JSON.stringify(good), options))).accepted, 3);
  await assert.rejects(readResult(new Response("not JSON", options)), /invalid JSON/);
  await assert.rejects(readResult(new Response("x".repeat(65537), options)), /64 KiB/);
  await assert.rejects(readResult(new Response("private body", { headers: { "content-type": "text/plain" } })), /unsupported response format/);
  const untrusted = "remote-secret-that-must-not-appear";
  await assert.rejects(readResult(new Response(JSON.stringify({ message: untrusted }), { ...options, status: 422 })), (error) => /HTTP 422/.test(error.message) && !error.message.includes(untrusted));
  good.receipt.receiptId = untrusted;
  await assert.rejects(readResult(new Response(JSON.stringify(good), options)), (error) => /invalid receipt/.test(error.message) && !error.message.includes(untrusted));
});
