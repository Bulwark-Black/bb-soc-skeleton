"use strict";

// Private deployment storage. Only bounded registry metadata is cloned; event
// payloads, receipt identities, searches and time-window aggregates stay in SQL.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const { ReferenceStateStore, clone, validateState, validateAuditEntry } = require("./reference-store");
const { validateNormalizedRecord } = require("../tools/ingest-contract");
const { normalizeObservationQuery } = require("./integration-coverage");
const { selectScannerSources } = require("./scanner-pages");

const DAY_MS = 86_400_000;
const DEFAULT_RETENTION = Object.freeze({ maxRecords: 100_000, maxRecordBytes: 256 * 1024 * 1024,
  maxReceipts: 100_000, maxRecordIdentities: 1_000_000, recordDays: 30, replayDays: 7, maxAuditRows: 1_000_000 });

function retentionOptions(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Telemetry retention must be an object.");
  const limits = { maxRecords: [1, 1_000_000], maxRecordBytes: [1024, 4 * 1024 * 1024 * 1024],
    maxReceipts: [1, 1_000_000], maxRecordIdentities: [1, 2_000_000], recordDays: [1, 365], replayDays: [1, 30], maxAuditRows: [1, 5_000_000] };
  const result = { ...DEFAULT_RETENTION };
  for (const [key, number] of Object.entries(value)) {
    if (!Object.hasOwn(limits, key) || !Number.isSafeInteger(number) || number < limits[key][0] || number > limits[key][1]) {
      throw new TypeError("Invalid telemetry retention option: " + key);
    }
    result[key] = number;
  }
  if (result.maxRecordIdentities < result.maxRecords) throw new TypeError("maxRecordIdentities must cover maxRecords.");
  return Object.freeze(result);
}

function hash(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function externalRecord(record) {
  const { schemaVersion, documentType, recordId, sourceId, estateId, kind, observedAt, payload } = record;
  return { schemaVersion, documentType, recordId, sourceId, estateId, kind, observedAt, payload };
}
function recordSearch(record) {
  return [record.recordId, record.sourceId, record.estateId, record.hostId, ...Object.values(record.payload)]
    .filter((value) => typeof value === "string").join("\n");
}
function secureSqliteFile(filename) {
  let stat;
  try { stat = fs.lstatSync(filename); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw new Error("Telemetry database must be an owner-controlled regular file without links.");
  }
  fs.chmodSync(filename, 0o600);
}
function capacity(message) {
  const error = new Error(message);
  error.name = "TelemetryStoreError";
  error.code = "connector-unavailable";
  error.status = 507;
  return error;
}

class SqliteTelemetryStore {
  constructor(options = {}) {
    this.retention = retentionOptions(options.retention);
    this.clock = options.clock || (() => new Date());
    this.closed = false;
    this.statements = new Map();
    // The original writer lock also prevents the reference runtime and a second
    // private process from diverging. Never automatically remove a stale lock.
    this.legacy = new ReferenceStateStore({ directory: options.directory, clock: this.clock, allowIndexedStore: true });
    this.directory = this.legacy.directory;
    this.stateFile = this.legacy.stateFile;
    this.auditFile = this.legacy.auditFile;
    this.databaseFile = path.join(this.directory, "telemetry.sqlite");
    try {
      for (const suffix of ["", "-wal", "-shm", "-journal"]) secureSqliteFile(this.databaseFile + suffix);
      this.db = new Database(this.databaseFile);
      fs.chmodSync(this.databaseFile, 0o600);
      const tables = this.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
      const hasMetadata = tables.some((table) => table.name === "telemetry_meta");
      const version = hasMetadata ? this.prepare("SELECT value FROM telemetry_meta WHERE key = 'schema-version'").get() : null;
      if (tables.length && !version) throw new Error("Existing database is not a committed telemetry store; refusing to initialize over unknown state.");
      if (version && version.value !== "1") throw new Error("Unsupported telemetry schema version.");
      if (version) {
        const stored = this.prepare("SELECT value FROM telemetry_meta WHERE key = 'retention'").get();
        if (!stored) throw new Error("Telemetry retention configuration is missing.");
        const previous = retentionOptions(JSON.parse(stored.value));
        if (options.retention !== undefined && JSON.stringify(previous) !== JSON.stringify(this.retention)) {
          throw new Error("Telemetry retention settings are pinned at initialization. Changing replay or capacity policy requires a deliberate state migration.");
        }
        this.retention = previous;
      } else {
        const legacy = this.legacy.snapshot();
        const bytes = legacy.records.reduce((total, record) => total + Buffer.byteLength(JSON.stringify(record)), 0);
        if (legacy.records.length > this.retention.maxRecords || bytes > this.retention.maxRecordBytes
            || legacy.receipts.length > this.retention.maxReceipts || legacy.revision > this.retention.maxAuditRows) {
          throw new Error("Existing reference state exceeds the requested telemetry retention limits; migration will not silently discard it.");
        }
      }
      this.db.pragma("trusted_schema = OFF");
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = FULL");
      this.db.pragma("busy_timeout = 5000");
      this.db.pragma("foreign_keys = ON");
      if (!version) {
        this.db.exec("BEGIN IMMEDIATE");
        this.db.exec(`
        CREATE TABLE IF NOT EXISTS telemetry_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS telemetry_control (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS telemetry_records (
          id INTEGER PRIMARY KEY, source_id TEXT NOT NULL, record_id TEXT NOT NULL, kind TEXT NOT NULL,
          observed_at TEXT NOT NULL, received_at TEXT NOT NULL, channel TEXT, body_hash TEXT NOT NULL,
          json TEXT, bytes INTEGER NOT NULL, UNIQUE(source_id, record_id)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS telemetry_log_time ON telemetry_records(kind, observed_at DESC, id DESC) WHERE json IS NOT NULL;
        CREATE INDEX IF NOT EXISTS telemetry_source_time ON telemetry_records(source_id, kind, observed_at DESC, id DESC) WHERE json IS NOT NULL;
        CREATE INDEX IF NOT EXISTS telemetry_retention ON telemetry_records(received_at, id) WHERE json IS NOT NULL;
        CREATE INDEX IF NOT EXISTS telemetry_tombstones ON telemetry_records(received_at) WHERE json IS NULL;
        CREATE INDEX IF NOT EXISTS telemetry_report_details ON telemetry_records(source_id, json_extract(json, '$.payload.fields.reportRef'), kind, observed_at DESC) WHERE json IS NOT NULL;
        CREATE VIRTUAL TABLE IF NOT EXISTS telemetry_search USING fts5(text, tokenize='trigram');
        CREATE TABLE IF NOT EXISTS telemetry_receipts (
          source_id TEXT NOT NULL, receipt_id TEXT NOT NULL, received_at TEXT NOT NULL, json TEXT NOT NULL,
          PRIMARY KEY(source_id, receipt_id)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS telemetry_receipt_age ON telemetry_receipts(received_at);
        CREATE TABLE IF NOT EXISTS telemetry_audit (revision INTEGER PRIMARY KEY, json TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS telemetry_counts (id INTEGER PRIMARY KEY CHECK(id = 1), records INTEGER NOT NULL,
          bytes INTEGER NOT NULL, identities INTEGER NOT NULL, receipts INTEGER NOT NULL, audit INTEGER NOT NULL, logs INTEGER NOT NULL) STRICT;
        INSERT OR IGNORE INTO telemetry_counts VALUES (1, 0, 0, 0, 0, 0, 0);
        CREATE TABLE IF NOT EXISTS telemetry_source_counts (source_id TEXT PRIMARY KEY, logs INTEGER NOT NULL) STRICT;
        CREATE TRIGGER IF NOT EXISTS telemetry_record_insert AFTER INSERT ON telemetry_records BEGIN
          UPDATE telemetry_counts SET identities = identities + 1, records = records + (NEW.json IS NOT NULL),
            bytes = bytes + NEW.bytes, logs = logs + (NEW.json IS NOT NULL AND NEW.kind = 'log.event') WHERE id = 1;
          INSERT INTO telemetry_source_counts VALUES (NEW.source_id, NEW.json IS NOT NULL AND NEW.kind = 'log.event')
            ON CONFLICT(source_id) DO UPDATE SET logs = logs + excluded.logs;
        END;
        CREATE TRIGGER IF NOT EXISTS telemetry_record_update AFTER UPDATE OF json, bytes ON telemetry_records BEGIN
          UPDATE telemetry_counts SET records = records + (NEW.json IS NOT NULL) - (OLD.json IS NOT NULL), bytes = bytes + NEW.bytes - OLD.bytes,
            logs = logs + ((NEW.json IS NOT NULL) - (OLD.json IS NOT NULL)) * (NEW.kind = 'log.event') WHERE id = 1;
          UPDATE telemetry_source_counts SET logs = logs + ((NEW.json IS NOT NULL) - (OLD.json IS NOT NULL)) * (NEW.kind = 'log.event') WHERE source_id = NEW.source_id;
        END;
        CREATE TRIGGER IF NOT EXISTS telemetry_record_delete AFTER DELETE ON telemetry_records BEGIN
          UPDATE telemetry_counts SET identities = identities - 1, records = records - (OLD.json IS NOT NULL), bytes = bytes - OLD.bytes,
            logs = logs - (OLD.json IS NOT NULL AND OLD.kind = 'log.event') WHERE id = 1;
          UPDATE telemetry_source_counts SET logs = logs - (OLD.json IS NOT NULL AND OLD.kind = 'log.event') WHERE source_id = OLD.source_id;
        END;
        CREATE TRIGGER IF NOT EXISTS telemetry_receipt_insert AFTER INSERT ON telemetry_receipts BEGIN UPDATE telemetry_counts SET receipts = receipts + 1 WHERE id = 1; END;
        CREATE TRIGGER IF NOT EXISTS telemetry_receipt_delete AFTER DELETE ON telemetry_receipts BEGIN UPDATE telemetry_counts SET receipts = receipts - 1 WHERE id = 1; END;
        CREATE TRIGGER IF NOT EXISTS telemetry_audit_insert AFTER INSERT ON telemetry_audit BEGIN UPDATE telemetry_counts SET audit = audit + 1 WHERE id = 1; END;
        `);
      }
      const fingerprint = hash(fs.readFileSync(this.stateFile)) + ":" + hash(fs.existsSync(this.auditFile) ? fs.readFileSync(this.auditFile) : "");
      if (!version) { this.migrate(fingerprint); this.db.exec("COMMIT"); }
      else {
        const migration = this.prepare("SELECT value FROM telemetry_meta WHERE key = 'legacy-fingerprint'").get();
        if (!migration || migration.value !== fingerprint) throw new Error("Frozen reference migration inputs changed; refusing to open divergent telemetry state.");
      }
      // Additive read indexes support existing schema-1 deployments without
      // rewriting records, changing their retention, or altering replay data.
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS telemetry_observation_time ON telemetry_records(observed_at DESC, id DESC) WHERE json IS NOT NULL;
        CREATE INDEX IF NOT EXISTS telemetry_observation_source ON telemetry_records(source_id, observed_at DESC, id DESC) WHERE json IS NOT NULL;
      `);
      const control = this.controlSnapshot();
      const check = this.db.pragma("quick_check");
      if (check.length !== 1 || check[0].quick_check !== "ok") throw new Error("Telemetry database consistency check failed.");
      const audit = this.prepare("SELECT COUNT(*) AS count, COALESCE(MAX(revision), 0) AS maximum, COALESCE(MIN(revision), 0) AS minimum FROM telemetry_audit").get();
      if (audit.count !== control.revision || audit.maximum !== control.revision || (audit.count && audit.minimum !== 1)) {
        throw new Error("Telemetry registry and committed audit revisions do not agree.");
      }
      const counters = this.prepare("SELECT * FROM telemetry_counts WHERE id = 1").get();
      const actual = this.prepare("SELECT COUNT(*) AS identities, COALESCE(SUM(json IS NOT NULL), 0) AS records, COALESCE(SUM(bytes), 0) AS bytes, COALESCE(SUM(json IS NOT NULL AND kind = 'log.event'), 0) AS logs FROM telemetry_records").get();
      actual.receipts = this.prepare("SELECT COUNT(*) AS count FROM telemetry_receipts").get().count;
      actual.audit = audit.count;
      if (!counters || Object.entries(actual).some(([key, value]) => counters[key] !== value)) throw new Error("Telemetry counters do not agree with committed records.");
      // A one-time startup consistency pass is intentional; normal request and
      // admission paths never deserialize or rescan the complete event history.
      this.db.exec("INSERT INTO telemetry_search(telemetry_search) VALUES ('integrity-check')");
      if (this.prepare("SELECT COUNT(*) AS count FROM telemetry_search").get().count !== actual.records) throw new Error("Telemetry search index does not agree with retained records.");
      for (const suffix of ["", "-wal", "-shm", "-journal"]) secureSqliteFile(this.databaseFile + suffix);
    } catch (error) {
      if (this.db?.inTransaction) this.db.exec("ROLLBACK");
      this.close(); throw error;
    }
  }

  migrate(fingerprint) {
    const state = this.legacy.snapshot();
    const audit = this.legacy.loadAudit().filter((entry) => entry.phase === "commit");
    // A validated, unchanged legacy snapshot is retained beside the new database.
    // Schema + all records + receipts + control + audit marker commit together.
    this.db.transaction(() => {
      const control = { ...state, records: [], receipts: [] };
      this.prepare("INSERT INTO telemetry_control(id, json) VALUES (1, ?)").run(JSON.stringify(control));
      for (const record of state.records) this.insertRecord(record);
      const insertReceipt = this.prepare("INSERT INTO telemetry_receipts VALUES (?, ?, ?, ?)");
      for (const receipt of state.receipts) insertReceipt.run(receipt.sourceId, receipt.receiptId, receipt.receivedAt, JSON.stringify(receipt));
      const insertAudit = this.prepare("INSERT INTO telemetry_audit VALUES (?, ?)");
      for (const entry of audit) insertAudit.run(entry.revision, JSON.stringify(entry));
      const insertMeta = this.prepare("INSERT INTO telemetry_meta VALUES (?, ?)");
      insertMeta.run("schema-version", "1");
      insertMeta.run("legacy-fingerprint", fingerprint);
      insertMeta.run("migrated-at", this.now());
      insertMeta.run("retention", JSON.stringify(this.retention));
    }).immediate();
  }

  now() {
    const now = this.clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError("Telemetry clock is invalid.");
    return now.toISOString();
  }
  assertOpen() { if (this.closed) throw new Error("Telemetry store is closed."); }
  prepare(sql) {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      // Queries vary only by bounded filter placeholder counts. Keep a small
      // native statement cache, rather than allocating a statement per event.
      if (this.statements.size >= 128) this.statements.delete(this.statements.keys().next().value);
      this.statements.set(sql, statement);
    }
    return statement;
  }
  controlSnapshot() {
    this.assertOpen();
    const row = this.prepare("SELECT json FROM telemetry_control WHERE id = 1").get();
    if (!row) throw new Error("Telemetry registry is missing.");
    return validateState(JSON.parse(row.json));
  }
  // Explicit diagnostics/export only. Request and ingest paths use controlSnapshot,
  // lookup methods, and bounded projections rather than materializing all history.
  snapshot() {
    const state = this.controlSnapshot();
    state.records = this.prepare("SELECT json FROM telemetry_records WHERE json IS NOT NULL ORDER BY id").all().map((row) => JSON.parse(row.json));
    state.receipts = this.prepare("SELECT json FROM telemetry_receipts ORDER BY received_at, receipt_id").all().map((row) => JSON.parse(row.json));
    return state;
  }
  findReceipt(sourceId, receiptId) {
    this.assertOpen();
    const row = this.prepare("SELECT json FROM telemetry_receipts WHERE source_id = ? AND receipt_id = ?").get(sourceId, receiptId);
    return row ? JSON.parse(row.json) : null;
  }
  findRecordHash(sourceId, recordId) {
    this.assertOpen();
    return this.prepare("SELECT body_hash FROM telemetry_records WHERE source_id = ? AND record_id = ?").get(sourceId, recordId)?.body_hash || null;
  }
  assertReplayWindow(sentAt, now) {
    if (Date.parse(sentAt) < Date.parse(now) - this.retention.replayDays * DAY_MS) {
      const error = new Error("Batch sentAt is outside the configured replay window; old batches cannot be re-admitted after receipt expiry.");
      error.name = "TelemetryStoreError";
      error.code = "validation-failed"; error.status = 422; throw error;
    }
  }
  insertRecord(record) {
    validateNormalizedRecord(externalRecord(record));
    const json = JSON.stringify(record);
    const result = this.prepare(`INSERT INTO telemetry_records
      (source_id, record_id, kind, observed_at, received_at, channel, body_hash, json, bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.sourceId, record.recordId, record.kind, new Date(record.observedAt).toISOString(), record.receivedAt,
        record.payload.channel || null, hash(JSON.stringify(externalRecord(record))), json, Buffer.byteLength(json));
    this.prepare("INSERT INTO telemetry_search(rowid, text) VALUES (?, ?)").run(result.lastInsertRowid, recordSearch(record));
  }
  prune(now) {
    const receiptCutoff = new Date(Date.parse(now) - this.retention.replayDays * DAY_MS).toISOString();
    const recordCutoff = new Date(Date.parse(now) - this.retention.recordDays * DAY_MS).toISOString();
    this.prepare("DELETE FROM telemetry_receipts WHERE received_at < ?").run(receiptCutoff);
    this.prepare("DELETE FROM telemetry_records WHERE json IS NULL AND received_at < ?").run(receiptCutoff);
    const expire = (ids) => {
      const removeSearch = this.prepare("DELETE FROM telemetry_search WHERE rowid = ?");
      const removePayload = this.prepare("UPDATE telemetry_records SET json = NULL, bytes = 0 WHERE id = ?");
      for (const { id } of ids) { removeSearch.run(id); removePayload.run(id); }
    };
    expire(this.prepare("SELECT id FROM telemetry_records WHERE json IS NOT NULL AND received_at < ?").all(recordCutoff));
    let totals = this.prepare("SELECT records AS count, bytes FROM telemetry_counts WHERE id = 1").get();
    while (totals.count > this.retention.maxRecords || totals.bytes > this.retention.maxRecordBytes) {
      const rows = this.prepare("SELECT id, bytes FROM telemetry_records WHERE json IS NOT NULL ORDER BY received_at, id LIMIT 1000").all();
      const remove = [];
      for (const row of rows) {
        if (totals.count <= this.retention.maxRecords && totals.bytes <= this.retention.maxRecordBytes) break;
        remove.push(row); totals.count -= 1; totals.bytes -= row.bytes;
      }
      expire(remove);
    }
  }
  transact(metadata, mutate) {
    this.assertOpen();
    if (typeof mutate !== "function") throw new TypeError("A telemetry mutation function is required.");
    return this.db.transaction(() => {
      const next = this.controlSnapshot();
      const result = mutate(next);
      next.revision += 1;
      // The temporary arrays contain this transaction's rows only, never history.
      const records = next.records; const receipts = next.receipts;
      validateState({ ...next, records: [], receipts: [] });
      if (records.length > 1000 || receipts.length > 1) throw new TypeError("Telemetry transaction exceeds the ingest batch bound.");
      const admittedBytes = records.reduce((total, record) => total + Buffer.byteLength(JSON.stringify(record)), 0);
      if (records.length > this.retention.maxRecords || admittedBytes > this.retention.maxRecordBytes) {
        throw capacity("The newly admitted batch exceeds telemetry payload capacity; split the batch before retrying.");
      }
      const now = this.now();
      const entry = validateAuditEntry({ schemaVersion: "1", at: now, phase: "commit", revision: next.revision, ...metadata }, "new");
      this.prune(now);
      const counts = this.prepare("SELECT * FROM telemetry_counts WHERE id = 1").get();
      if (counts.identities + records.length > this.retention.maxRecordIdentities) throw capacity("Telemetry record identity capacity is exhausted inside its replay window.");
      if (counts.receipts + receipts.length > this.retention.maxReceipts) throw capacity("Telemetry receipt capacity is exhausted inside its replay window.");
      if (counts.audit >= this.retention.maxAuditRows) throw capacity("Telemetry audit capacity is exhausted; export and rotate the deployment state deliberately.");
      for (const record of records) this.insertRecord(record);
      const insertReceipt = this.prepare("INSERT INTO telemetry_receipts VALUES (?, ?, ?, ?)");
      for (const receipt of receipts) insertReceipt.run(receipt.sourceId, receipt.receiptId, receipt.receivedAt, JSON.stringify(receipt));
      this.prune(now);
      next.records = []; next.receipts = [];
      const json = JSON.stringify(next);
      if (Buffer.byteLength(json) > 8 * 1024 * 1024) throw capacity("Telemetry registry metadata capacity is exhausted.");
      this.prepare("UPDATE telemetry_control SET json = ? WHERE id = 1").run(json);
      this.prepare("INSERT INTO telemetry_audit VALUES (?, ?)").run(next.revision, JSON.stringify(entry));
      return { revision: next.revision, result };
    }).immediate();
  }
  stats() {
    this.assertOpen();
    const total = this.prepare("SELECT records, bytes AS recordBytes, receipts, identities, audit AS auditRows FROM telemetry_counts WHERE id = 1").get();
    return { ...total,
      revision: this.controlSnapshot().revision, retention: this.retention };
  }
  logSummary() {
    const totals = this.prepare("SELECT logs AS count FROM telemetry_counts WHERE id = 1").get();
    totals.earliest = this.prepare("SELECT observed_at FROM telemetry_records WHERE kind = 'log.event' AND json IS NOT NULL ORDER BY observed_at ASC LIMIT 1").get()?.observed_at || null;
    const sources = this.prepare("SELECT source_id, logs AS count FROM telemetry_source_counts").all();
    return { ...totals, counts: new Map(sources.map((row) => [row.source_id, row.count])) };
  }
  logQuery({ sourceId, search = "", sourceMatches = [], limit = 200 } = {}) {
    const conditions = ["kind = 'log.event'", "json IS NOT NULL"];
    const params = [];
    if (sourceId) { conditions.push("source_id = ?"); params.push(sourceId); }
    if (search) {
      if ([...search].length < 3) throw new TypeError("Indexed log search requires at least three characters.");
      const sourceClause = sourceMatches.length ? ` OR source_id IN (${sourceMatches.map(() => "?").join(",")})` : "";
      conditions.push(`(id IN (SELECT rowid FROM telemetry_search WHERE telemetry_search MATCH ?)${sourceClause})`);
      params.push('"' + search.replace(/"/g, '""') + '"', ...sourceMatches);
    }
    const where = conditions.join(" AND ");
    const count = this.prepare("SELECT COUNT(*) AS count FROM telemetry_records WHERE " + where).get(...params).count;
    const records = this.prepare("SELECT json FROM telemetry_records WHERE " + where + " ORDER BY observed_at DESC, id DESC LIMIT ?").all(...params, limit).map((row) => JSON.parse(row.json));
    return { count, records };
  }
  analytics(start, end) {
    const rows = this.prepare(`SELECT substr(observed_at, 1, 13) AS hour, COUNT(*) AS count
      FROM telemetry_records WHERE kind = 'log.event' AND json IS NOT NULL AND observed_at >= ? AND observed_at < ? GROUP BY hour`).all(start, end);
    const totals = this.prepare(`SELECT COUNT(*) AS count, COUNT(DISTINCT source_id) AS sources, COUNT(DISTINCT channel) AS channels
      FROM telemetry_records WHERE kind = 'log.event' AND json IS NOT NULL AND observed_at >= ? AND observed_at < ?`).get(start, end);
    return { rows, ...totals };
  }
  latestRecords(kinds, limit = 200) {
    if (!Array.isArray(kinds) || !kinds.length || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError("Bounded record query is required.");
    const where = `kind IN (${kinds.map(() => "?").join(",")}) AND json IS NOT NULL`;
    return { total: this.prepare("SELECT COUNT(*) AS count FROM telemetry_records WHERE " + where).get(...kinds).count,
      records: this.prepare("SELECT json FROM telemetry_records WHERE " + where + " ORDER BY observed_at DESC, id DESC LIMIT ?").all(...kinds, limit).map((row) => JSON.parse(row.json)) };
  }
  queryObservations(filters = {}) {
    this.assertOpen();
    const query = normalizeObservationQuery(filters);
    const clauses = ["json IS NOT NULL"];
    const params = [];
    if (query.kinds) { clauses.push(`kind IN (${query.kinds.map(() => "?").join(",")})`); params.push(...query.kinds); }
    if (query.sourceId) { clauses.push("source_id = ?"); params.push(query.sourceId); }
    if (query.appId) {
      // Application association belongs to the source registry, not untrusted
      // payload fields. Use SQL membership to avoid an unbounded placeholder list.
      clauses.push("source_id IN (SELECT json_extract(value, '$.sourceId') FROM json_each((SELECT json FROM telemetry_control WHERE id = 1), '$.sources') WHERE json_extract(value, '$.appId') = ?)");
      params.push(query.appId);
    }
    if (query.observedAfter) { clauses.push("observed_at >= ?"); params.push(query.observedAfter); }
    if (query.observedBefore) { clauses.push("observed_at < ?"); params.push(query.observedBefore); }
    const where = clauses.join(" AND ");
    const count = this.prepare("SELECT COUNT(*) AS count FROM telemetry_records WHERE " + where).get(...params).count;
    const records = [];
    let returnedBytes = 0;
    let bytesLimited = false;
    for (const row of this.prepare("SELECT json FROM telemetry_records WHERE " + where + " ORDER BY observed_at DESC, id DESC LIMIT ? OFFSET ?")
      .iterate(...params, query.limit, query.offset)) {
      const bytes = Buffer.byteLength(row.json);
      if (returnedBytes + bytes > 2 * 1024 * 1024) { bytesLimited = true; break; }
      returnedBytes += bytes;
      records.push(JSON.parse(row.json));
    }
    return { records, count, matched: count, omitted: count - records.length, limit: query.limit, offset: query.offset,
      returnedBytes, bytesLimited, hasMore: query.offset + records.length < count };
  }
  latestScannerRecords(query = {}) {
    // Scope the source registry before selecting the latest 200 reporting
    // sources. Filtering a global capped result could hide a selected source.
    const sources = selectScannerSources(this.controlSnapshot(), query);
    const latest = this.prepare("SELECT json FROM telemetry_records WHERE source_id = ? AND kind = 'scan.result' AND json IS NOT NULL AND json_extract(json, '$.payload.fields.scanner') = 'trivy' AND json_type(json, '$.payload.fields.reportRef') = 'text' AND json_type(json, '$.payload.fields.packageCount') = 'integer' AND json_type(json, '$.payload.fields.vulnerabilityCount') = 'integer' ORDER BY observed_at DESC, id DESC LIMIT 1");
    const summaries = sources.flatMap((source) => {
      const row = latest.get(source.sourceId); return row ? [JSON.parse(row.json)] : [];
    }).sort((left, right) => right.observedAt.localeCompare(left.observedAt)).slice(0, 200);
    const records = [...summaries];
    let detailCount = 0;
    const count = this.prepare("SELECT COUNT(*) AS count FROM telemetry_records WHERE source_id = ? AND json IS NOT NULL AND json_extract(json, '$.payload.fields.reportRef') = ? AND kind IN ('vulnerability.finding', 'software.package')");
    const detail = this.prepare("SELECT json FROM telemetry_records WHERE source_id = ? AND json IS NOT NULL AND json_extract(json, '$.payload.fields.reportRef') = ? AND kind IN ('vulnerability.finding', 'software.package') ORDER BY kind DESC, observed_at DESC, id DESC LIMIT ?");
    for (const summary of summaries) {
      const ref = summary.payload.fields?.reportRef;
      if (typeof ref !== "string") continue;
      detailCount += count.get(summary.sourceId, ref).count;
      if (records.length < 1000) records.push(...detail.all(summary.sourceId, ref, 1000 - records.length).map((row) => JSON.parse(row.json)));
    }
    return { records, total: summaries.length + detailCount, sourceLimit: sources.length > 200 };
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    if (this.db) { try { this.db.close(); } finally { this.db = null; } }
    if (this.legacy) this.legacy.close();
  }
}

module.exports = { SqliteTelemetryStore, DEFAULT_RETENTION, retentionOptions };
