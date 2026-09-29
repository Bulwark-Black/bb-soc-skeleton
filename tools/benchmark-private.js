#!/usr/bin/env node
"use strict";

// Opt-in, synthetic measurements of the bounded storage/runtime used by the
// private starter. This does not start a listener or measure HTTP/auth/browser latency.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { ReferenceControlPlane } = require("../server/reference-runtime");
const { SqliteTelemetryStore, DEFAULT_RETENTION } = require("../server/sqlite-telemetry-store");
const { runAsOperator } = require("../server/operator-context");

const FIXTURE_TIME = "2026-09-01T12:00:00.000Z";
const DEFAULTS = Object.freeze({ records: 20_000, batchSize: 100, queries: 30 });

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function createSyntheticSource(runtime, at = FIXTURE_TIME) {
  let sequence = 0;
  function execute(command, input) {
    const request = { schemaVersion: "1", documentType: "connector-command-request",
      requestId: `synthetic-setup-${++sequence}`, command, requestedAt: at, input };
    const result = runAsOperator("synthetic-benchmark-operator", () => runtime.execute(request));
    assert.equal(result.status, "succeeded", `Synthetic ${command} must succeed.`);
    return { request, result };
  }
  const app = execute("app.register", { displayName: "Synthetic application", hosts: [], publicPages: [], environments: ["test"] }).result;
  const setup = execute("source.setup", { appId: app.output.appId, environment: "test", connectorType: "canonical-push",
    sourceKind: "log.event", displayName: "Synthetic application events", config: { "cadence-seconds": 300 }, credentialReferences: [] }).result;
  const tested = execute("source.test", { sourceId: setup.output.sourceId, connectorInstanceId: setup.output.connectorInstanceId,
    expectedRevision: setup.output.revision, sample: { message: "Synthetic validation sample", channel: "application" } }).result;
  const activated = execute("source.activate", { sourceId: tested.output.sourceId, connectorInstanceId: tested.output.connectorInstanceId,
    expectedRevision: tested.output.revision });
  return { appId: app.output.appId, sourceId: setup.output.sourceId, activationRequest: activated.request,
    credential: activated.result.output.oneTimeCredential.value };
}

function syntheticBatch(identity, start, count, at = FIXTURE_TIME) {
  return { schemaVersion: "1", documentType: "ingest-batch", sourceId: identity.sourceId,
    receiptId: `synthetic-receipt-${String(start).padStart(8, "0")}`, sentAt: at,
    records: Array.from({ length: count }, (_, offset) => ({ schemaVersion: "1", documentType: "normalized-record",
      recordId: `synthetic-event-${start + offset}`, sourceId: identity.sourceId, estateId: identity.appId,
      kind: "log.event", observedAt: at, payload: { title: "Synthetic application event", message: `Synthetic event ${start + offset}`,
        severity: "info", state: "open", channel: "application" } })) };
}

function optionsFromArgs(args) {
  const options = { ...DEFAULTS };
  const names = { "--records": "records", "--batch-size": "batchSize", "--queries": "queries" };
  const supplied = new Set();
  for (let index = 0; index < args.length; index += 2) {
    const name = names[args[index]];
    if (!name || supplied.has(name) || !/^[1-9][0-9]*$/.test(args[index + 1] || "")) {
      throw new TypeError("Use --records N --batch-size N --queries N with positive integers and no repeated options.");
    }
    supplied.add(name);
    options[name] = Number(args[index + 1]);
  }
  for (const [name, maximum] of [["records", DEFAULT_RETENTION.maxRecords], ["batchSize", 1000], ["queries", 200]]) {
    if (!Number.isSafeInteger(options[name]) || options[name] > maximum) throw new TypeError(`${name} must be from 1 through ${maximum}.`);
  }
  return options;
}

function round(value) { return Math.round(value * 1000) / 1000; }
function distribution(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (fraction) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
  return { samples: sorted.length, minimumMs: round(sorted[0]), p50Ms: round(percentile(0.5)),
    p95Ms: round(percentile(0.95)), maximumMs: round(sorted.at(-1)), totalMs: round(samples.reduce((a, b) => a + b, 0)) };
}
function memory() {
  const usage = process.memoryUsage();
  return { rssBytes: usage.rss, heapUsedBytes: usage.heapUsed, externalBytes: usage.external };
}

function runBenchmark(options) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "bb-soc-private-benchmark-"));
  let runtime;
  let report;
  try {
    const clock = () => new Date(FIXTURE_TIME);
    runtime = new ReferenceControlPlane({ store: new SqliteTelemetryStore({ directory, clock }), clock });
    const identity = createSyntheticSource(runtime);
    const before = memory();
    const ingestSamples = [];
    let firstBatch;
    for (let start = 0; start < options.records; start += options.batchSize) {
      const batch = syntheticBatch(identity, start, Math.min(options.batchSize, options.records - start));
      const hash = digest(batch);
      if (!firstBatch) firstBatch = batch;
      const began = performance.now();
      const receipt = runtime.ingest(batch, identity.credential, hash);
      ingestSamples.push(performance.now() - began);
      assert.equal(receipt.accepted, batch.records.length);
      assert.equal(receipt.replay, false);
    }
    const state = runtime.store.stats();
    assert.equal(state.records, options.records);
    const query = { q: "synthetic", sourceId: identity.sourceId, limit: "50" };
    for (let i = 0; i < 3; i++) runtime.readPage("/logs", query);
    const querySamples = [];
    for (let i = 0; i < options.queries; i++) {
      const began = performance.now();
      const page = runtime.readPage("/logs", query);
      querySamples.push(performance.now() - began);
      assert.equal(page.state, "ready");
      assert.equal(page.panels[0].rows.length, Math.min(50, options.records));
    }
    const replayBegan = performance.now();
    const replay = runtime.ingest(firstBatch, identity.credential, digest(firstBatch));
    const replayMs = performance.now() - replayBegan;
    assert.equal(replay.replay, true);
    assert.equal(runtime.store.stats().revision, state.revision, "Receipt replay must not create another transaction.");
    assert.equal(runtime.store.stats().records, options.records, "Receipt replay must not duplicate events.");
    report = {
      measurement: "private-indexed-telemetry-direct-runtime", generatedAt: new Date().toISOString(),
      scope: "Single-process synthetic ingest and Logs projection; excludes HTTP, authentication, browser rendering, network, concurrency, and power-loss behavior.",
      environment: { node: process.version, platform: process.platform, architecture: process.arch, logicalCpus: os.cpus().length },
      fixture: { eventCount: options.records, batchSize: options.batchSize, ingestBatches: ingestSamples.length,
        logQueries: options.queries, queryWarmups: 3, rowsPerQuery: Math.min(50, options.records) },
      ingestBatch: distribution(ingestSamples), logsProjection: distribution(querySamples),
      duplicateReceipt: { elapsedMs: round(replayMs), replay: true, eventCountUnchanged: true, revisionUnchanged: true },
      memory: { beforeWorkload: before, afterWorkload: memory(), processLifetimePeakRssBytes: process.resourceUsage().maxRSS * 1024 },
      persisted: { databaseBytes: fs.statSync(runtime.store.databaseFile).size,
        walBytes: fs.existsSync(runtime.store.databaseFile + "-wal") ? fs.statSync(runtime.store.databaseFile + "-wal").size : 0,
        retainedPayloadBytes: runtime.store.stats().recordBytes },
      limits: { ...runtime.store.retention,
        storage: "SQLite WAL/FULL: indexed identities, receipt replay, trigram log search and bounded page results; bounded registry JSON only." },
      interpretation: "Informational baseline on this machine, with nearest-rank percentiles. No latency pass/fail threshold or production-scale claim. Peak RSS covers this process lifetime."
    };
  } finally {
    if (runtime) runtime.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
  return { ...report, temporaryFixtureRemoved: true };
}

if (require.main === module) {
  if (process.argv.length === 3 && process.argv[2] === "--help") {
    process.stdout.write("Usage: node tools/benchmark-private.js [--records 20000] [--batch-size 100] [--queries 30]\nSynthetic direct-runtime timings only. Temporary state is removed when the run completes.\n");
  } else {
    try { process.stdout.write(JSON.stringify(runBenchmark(optionsFromArgs(process.argv.slice(2))), null, 2) + "\n"); }
    catch (error) { process.stderr.write(`Private benchmark failed: ${error.message}\n`); process.exitCode = 1; }
  }
}

module.exports = { FIXTURE_TIME, createSyntheticSource, syntheticBatch, digest };
