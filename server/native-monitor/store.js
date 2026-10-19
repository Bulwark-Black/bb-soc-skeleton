"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { validateRegistry } = require("./registry");
const HOUR = 3600000, DAY = 24 * HOUR, RAW_DAYS = 14, FIVE_MIN_DAYS = 90, HOURLY_DAYS = 400;
const QUALITY = new Set(["good", "unknown", "unsupported", "error"]);
const STATUS = new Set(["healthy", "warning", "critical", "unknown"]);
const rank = { unknown: 0, healthy: 1, warning: 2, critical: 3 };
function problem(status, message) { const e = new Error(message); e.status = status; return e; }
function plain(v) { return !!v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype; }
function canonical(v) {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (plain(v)) return "{" + Object.keys(v).sort().map(function(k) { return JSON.stringify(k) + ":" + canonical(v[k]); }).join(",") + "}";
  return JSON.stringify(v);
}
function digest(v) { return crypto.createHash("sha256").update(canonical(v)).digest("hex"); }
function bounded(v, max) { return typeof v === "string" && v.length > 0 && v.length <= max; }
function stamp(v) { return typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v) && /(?:Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v)); }
function json(v) { return JSON.stringify(v); }
function decode(v, fallback) { try { return JSON.parse(v); } catch { return fallback; } }
function safeKeys(v, allowed) { return Object.keys(v).every(function(k) { return allowed.includes(k); }); }

// Private, owner-controlled files only; never follow links into another state tree.
function secureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error("Monitoring data must be an owner-controlled directory without symbolic links.");
  fs.chmodSync(directory, 0o700);
}
function secureFile(filename) {
  let stat;
  try { stat = fs.lstatSync(filename); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error("Monitoring database must be an owner-controlled regular file without links.");
  fs.chmodSync(filename, 0o600);
}

class MonitorStore {
  constructor(options = {}) {
    this.now = options.now || Date.now;
    // Only a trusted server-owned worker can enable delivery; a collector flag cannot.
    Object.defineProperty(this, "notifications", { get: () => typeof options.notificationsEnabled === "function" && options.notificationsEnabled() === true, enumerable: true });
    if (typeof options.data !== "string" || !path.isAbsolute(options.data) || path.resolve(options.data) === path.parse(options.data).root) {
      throw new TypeError("An explicit absolute private monitoring data directory is required.");
    }
    this.data = path.resolve(options.data);
    const registry = validateRegistry(options.registry);
    this.registry = registry;
    this.quotaBytes = options.quotaBytes === undefined ? 10 * 1024 ** 3 : options.quotaBytes;
    this.minFreeBytes = options.minFreeBytes === undefined ? null : options.minFreeBytes;
    if (!Number.isSafeInteger(this.quotaBytes) || this.quotaBytes < 1048576 ||
        (this.minFreeBytes !== null && (!Number.isSafeInteger(this.minFreeBytes) || this.minFreeBytes < 0))) {
      throw new TypeError("Invalid monitoring storage capacity limits.");
    }
    this.targets = registry.HOSTS;
    this.series = registry.SERIES;
    this.checks = registry.CHECKS.slice();
    this.hostMap = new Map(this.targets.map(function(t) { return [t.id, t]; }));
    this.seriesMap = new Map(this.series.map(function(t) { return [t.id, t]; }));
    this.checkMap = new Map(this.checks.map(function(t) { return [t.id, t]; }));
    this.fault = null;
    if (this.series.length > 600) throw new Error("initial series cap exceeded");
    secureDirectory(this.data);
    this.dbPath = path.join(this.data, "monitor.sqlite");
    for (const suffix of ["", "-wal", "-shm", "-journal"]) secureFile(this.dbPath + suffix);
    this.db = new DatabaseSync(this.dbPath);
    try {
    secureFile(this.dbPath);
    this.db.exec("PRAGMA trusted_schema=OFF; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1500; PRAGMA foreign_keys=ON; PRAGMA cache_size=-16384; PRAGMA wal_autocheckpoint=1000; PRAGMA journal_size_limit=67108864; PRAGMA temp_store=MEMORY;");
    const version = this.db.prepare("PRAGMA user_version").get().user_version;
    if (version > 1) throw new Error("monitor schema is newer than this runtime");
    const existingTables = this.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    if (existingTables.length && !existingTables.some(t => t.name === "monitor_meta")) throw new Error("Existing database is not a monitoring store; refusing to overwrite unknown state.");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS monitor_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS mutation_receipts (operation TEXT NOT NULL,idempotency_key TEXT NOT NULL,digest TEXT NOT NULL,response TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(operation,idempotency_key));" +
      "CREATE TABLE IF NOT EXISTS targets (id TEXT PRIMARY KEY,value TEXT NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS registry_identities (kind TEXT NOT NULL,id TEXT NOT NULL,host TEXT NOT NULL,PRIMARY KEY(kind,id));" +
      "CREATE TABLE IF NOT EXISTS streams (host TEXT PRIMARY KEY,stream_id TEXT NOT NULL,last_sequence INTEGER NOT NULL,last_observed INTEGER,received_at INTEGER,value TEXT);" +
      "CREATE TABLE IF NOT EXISTS receipts (host TEXT NOT NULL,batch_id TEXT NOT NULL,stream_id TEXT NOT NULL,sequence INTEGER NOT NULL,digest TEXT NOT NULL,semantic_digest TEXT,observed_at INTEGER NOT NULL,received_at INTEGER NOT NULL,receipt TEXT NOT NULL,PRIMARY KEY(host,batch_id),UNIQUE(host,stream_id,sequence));" +
      "CREATE TABLE IF NOT EXISTS receipt_aliases (host TEXT NOT NULL,batch_id TEXT NOT NULL,canonical_batch_id TEXT NOT NULL,digest TEXT NOT NULL,response TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(host,batch_id));" +
      "CREATE TABLE IF NOT EXISTS points (series_id TEXT NOT NULL,host TEXT NOT NULL,at INTEGER NOT NULL,value REAL,quality TEXT NOT NULL,reason TEXT,batch_id TEXT NOT NULL,PRIMARY KEY(series_id,batch_id));" +
      "CREATE INDEX IF NOT EXISTS points_series_time ON points(series_id,at);" +
      "CREATE INDEX IF NOT EXISTS points_expiry ON points(at);" +
      "CREATE TABLE IF NOT EXISTS current_points (series_id TEXT PRIMARY KEY,host TEXT NOT NULL,at INTEGER NOT NULL,value REAL,quality TEXT NOT NULL,reason TEXT);" +
      "CREATE TABLE IF NOT EXISTS check_state (id TEXT PRIMARY KEY,host TEXT NOT NULL,value TEXT NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS incidents (id TEXT PRIMARY KEY,host TEXT NOT NULL,check_id TEXT NOT NULL,title TEXT NOT NULL,status TEXT NOT NULL,severity TEXT NOT NULL,opened_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,resolved_at INTEGER,summary TEXT NOT NULL,evidence TEXT NOT NULL,acknowledged_at INTEGER,acknowledged_by TEXT);" +
      "CREATE INDEX IF NOT EXISTS incident_host_status ON incidents(host,status,updated_at);" +
      "CREATE INDEX IF NOT EXISTS incident_host_recorded ON incidents(host);" +
      "CREATE UNIQUE INDEX IF NOT EXISTS one_open_incident ON incidents(check_id) WHERE status='open';" +
      "CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY,host TEXT NOT NULL,at INTEGER NOT NULL,event TEXT NOT NULL,delivered_at INTEGER,attempted_at INTEGER,superseded_at INTEGER,outcome TEXT);" +
      "CREATE TABLE IF NOT EXISTS maintenance (id TEXT PRIMARY KEY,host TEXT NOT NULL,check_id TEXT,starts_at INTEGER NOT NULL,ends_at INTEGER NOT NULL,reason TEXT NOT NULL,actor TEXT NOT NULL,created_at INTEGER NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS rollups (resolution INTEGER NOT NULL,series_id TEXT NOT NULL,host TEXT NOT NULL,bucket INTEGER NOT NULL,count INTEGER NOT NULL,good_count INTEGER NOT NULL,covered_slots INTEGER NOT NULL DEFAULT 0,sum REAL,min REAL,max REAL,last_value REAL,last_at INTEGER,PRIMARY KEY(resolution,series_id,bucket));" +
      "CREATE INDEX IF NOT EXISTS rollup_expiry ON rollups(resolution,bucket);" +
      "PRAGMA user_version=1;"
    );
    const receiptColumns=this.db.prepare("PRAGMA table_info(receipts)").all().map(function(c){return c.name;});
    if(!receiptColumns.includes("semantic_digest"))this.db.exec("ALTER TABLE receipts ADD COLUMN semantic_digest TEXT");
    const rollupColumns=this.db.prepare("PRAGMA table_info(rollups)").all().map(function(c){return c.name;});
    if(!rollupColumns.includes("covered_slots"))this.db.exec("ALTER TABLE rollups ADD COLUMN covered_slots INTEGER NOT NULL DEFAULT 0");
    const outboxColumns=this.db.prepare("PRAGMA table_info(outbox)").all().map(function(c){return c.name;});
    for(const column of ["attempted_at","superseded_at","outcome"])if(!outboxColumns.includes(column))this.db.exec("ALTER TABLE outbox ADD COLUMN "+column+(column==="outcome" ? " TEXT" : " INTEGER"));
    const appId = this.targets[0]?.appId;
    const storedApp = this.db.prepare("SELECT value FROM monitor_meta WHERE key='applicationId'").get();
    if (storedApp && appId && storedApp.value !== appId) throw new Error("Monitoring application binding changed; use a separate store.");
    if (appId) this.db.prepare("INSERT OR IGNORE INTO monitor_meta VALUES('applicationId',?)").run(appId);
    // A stable host identity cannot be reassigned to another source or app.
    for (const host of this.targets) {
      const stored = this.db.prepare("SELECT value FROM targets WHERE id=?").get(host.id);
      const prior = stored && decode(stored.value, null);
      if (prior && (prior.sourceId !== host.sourceId || prior.appId !== host.appId)) throw new Error("Monitoring host source/application binding changed; use a new host identity.");
    }
    for (const [kind, definitions] of [["series", this.series], ["check", this.checks]]) {
      for (const definition of definitions) {
        const prior = this.db.prepare("SELECT host FROM registry_identities WHERE kind=? AND id=?").get(kind, definition.id);
        if (prior && prior.host !== definition.host) throw new Error("Monitoring series/check host binding changed; use a new identity.");
      }
    }
    for (const [kind, definitions] of [["series", this.series], ["check", this.checks]]) {
      for (const definition of definitions) this.db.prepare("INSERT OR IGNORE INTO registry_identities VALUES(?,?,?)").run(kind, definition.id, definition.host);
    }
    for (const host of this.targets) this.db.prepare("INSERT INTO targets(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(host.id, json(host));
    this.db.prepare("INSERT OR IGNORE INTO monitor_meta(key,value) VALUES('notificationEnabled','false')").run();
    this.db.prepare("INSERT OR IGNORE INTO monitor_meta(key,value) VALUES('createdAt',?)").run(String(this.now()));
    this.response = new (require("./response").IncidentResponse)(this);
    for (const suffix of ["", "-wal", "-shm", "-journal"]) secureFile(this.dbPath + suffix);
    } catch (error) { this.close(); throw error; }
  }
  close() { if (this.db) { this.db.close(); this.db = null; } }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }
  hostsFilter(hosts) {
    if (hosts === undefined || hosts === null) return null;
    if (hosts === "__none__" || (Array.isArray(hosts) && hosts.length===0)) return [];
    const list = Array.isArray(hosts) ? hosts : String(hosts).split(",");
    if (!list.length || list.length > this.targets.length || list.some((h) => !this.hostMap.has(h))) throw problem(400, "unknown or invalid host scope");
    return [...new Set(list)];
  }
  scope(hosts, column = "host") {
    const selected = this.hostsFilter(hosts);
    return { sql: selected ? selected.length ? " AND " + column + " IN (" + selected.map(function() { return "?"; }).join(",") + ")" : " AND 0" : "", values: selected || [] };
  }
  staleMs(host) { const interval = this.hostMap.get(host).intervalSeconds * 1000; return Math.max(interval * 3, interval + 10000 + 30000); }
  storage() {
    let bytes = 0;
    for (const suffix of ["", "-wal", "-shm"]) { try { bytes += fs.statSync(this.dbPath + suffix).size; } catch {} }
    let freeBytes = null,totalBytes = null;
    try { const s = fs.statfsSync(this.data); freeBytes = s.bavail * s.bsize; totalBytes=s.blocks*s.bsize; } catch {}
    const reserveBytes=this.minFreeBytes===null ? Math.max(10*1024**3,Math.floor((totalBytes || 0)*0.15)) : this.minFreeBytes;
    return { bytes, quotaBytes: this.quotaBytes, freeBytes,totalBytes,reserveBytes,warningBytes:Math.floor(this.quotaBytes*0.7) };
  }
  health() {
    const storage = this.storage();
    const pressure = storage.bytes >= storage.warningBytes || storage.freeBytes === null || storage.freeBytes < storage.reserveBytes;
    return { ok: true, service: "native-monitor", status: this.fault || pressure ? "degraded" : "healthy", now: this.now(), version: 1,
      storage, error: this.fault, notificationEnabled: this.notifications, createdAt:Number(this.db.prepare("SELECT value FROM monitor_meta WHERE key='createdAt'").get().value),lastIngestAt:this.db.prepare("SELECT MAX(received_at) AS at FROM receipts").get().at,lastEvaluationAt:Number((this.db.prepare("SELECT value FROM monitor_meta WHERE key='lastEvaluationAt'").get() || {}).value) || null,queue:{pendingNotifyEvents:this.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE delivered_at IS NULL AND superseded_at IS NULL AND json_extract(event,'$.notify')=1").get().n,pendingEvents:this.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE delivered_at IS NULL AND superseded_at IS NULL").get().n,dirtyBuckets:this.db.prepare("SELECT COUNT(*) AS n FROM monitor_meta WHERE key LIKE 'dirty:%'").get().n}, seriesCount: this.series.length, seriesLimit: 600 };
  }
  capacity() {
    const s = this.storage();
    if (s.bytes >= s.quotaBytes || s.freeBytes === null || s.freeBytes < s.reserveBytes) throw problem(503, "monitoring storage reserve or quota reached; batch not acknowledged");
  }
  validate(host, batch) {
    if (!this.hostMap.has(host)) throw problem(403, "unregistered host");
    if (!plain(batch) || !safeKeys(batch, ["schemaVersion", "sourceId", "host", "streamId", "sequence", "batchId", "observedAt", "bootId", "monotonicNs", "collectorVersion", "configRevision", "collection", "samples", "checks"]) || Buffer.byteLength(json(batch)) > 262144) throw problem(400, "invalid or oversized batch");
    if (batch.schemaVersion !== 1 || batch.sourceId !== this.hostMap.get(host).sourceId) throw problem(400, "schema or authenticated source mismatch");
    if (batch.host !== undefined && batch.host !== host) throw problem(400, "batch host differs from authenticated registration");
    for (const field of ["streamId", "batchId", "bootId", "collectorVersion", "configRevision"]) if (!bounded(batch[field], 160)) throw problem(400, "invalid " + field);
    if (!/^[a-zA-Z0-9_.:@-]+$/.test(batch.streamId) || !/^[a-zA-Z0-9_.:@-]+$/.test(batch.batchId)) throw problem(400, "invalid stream or batch identity");
    if (!/^(sha256:)?[a-f0-9]{64}$/.test(batch.configRevision)) throw problem(400, "configuration revision must be SHA-256");
    if (!Number.isSafeInteger(batch.sequence) || batch.sequence < 0) throw problem(400, "invalid sequence");
    if (typeof batch.monotonicNs !== "string" || !/^\d{1,24}$/.test(batch.monotonicNs)) throw problem(400, "invalid monotonic time");
    if (!stamp(batch.observedAt)) throw problem(400, "invalid observedAt");
    if (!plain(batch.collection) || !safeKeys(batch.collection, ["ok", "durationMs", "error", "gaps"]) || typeof batch.collection.ok !== "boolean" || !Number.isFinite(batch.collection.durationMs) || batch.collection.durationMs < 0 || batch.collection.durationMs > 120000) throw problem(400, "invalid collection proof");
    if (batch.collection.error !== undefined && batch.collection.error !== null && !bounded(batch.collection.error, 1000)) throw problem(400, "invalid collection error");
    if (batch.collection.gaps !== undefined && (!plain(batch.collection.gaps) || Buffer.byteLength(json(batch.collection.gaps)) > 4096)) throw problem(400, "invalid collection gap evidence");
    if (!Array.isArray(batch.samples) || batch.samples.length > 100 || !Array.isArray(batch.checks) || batch.checks.length > 100) throw problem(400, "bounded samples and checks arrays required");
    const sampleIds = new Set(), checkIds = new Set();
    for (const sample of batch.samples) {
      if (!plain(sample) || !safeKeys(sample, ["seriesId", "value", "quality", "reason"])) throw problem(400, "invalid sample fields");
      const definition = this.seriesMap.get(sample.seriesId);
      if (!definition || definition.host !== host || sampleIds.has(sample.seriesId)) throw problem(400, "unregistered, foreign or duplicate series");
      if (!QUALITY.has(sample.quality) || (sample.quality === "good" ? !Number.isFinite(sample.value) || sample.value < definition.min || sample.value > definition.max : sample.value !== null)) throw problem(400, "invalid sample value or quality");
      if (definition.type === "counter" && sample.quality === "good" && !Number.isSafeInteger(sample.value)) throw problem(400,"counter requires an exact safe integer; int64 decimal transport is not enabled");
      if (sample.reason !== undefined && !bounded(sample.reason, 500)) throw problem(400, "invalid sample reason");
      sampleIds.add(sample.seriesId);
    }
    for (const check of batch.checks) {
      if (!plain(check) || !safeKeys(check, ["checkId", "status", "summary"])) throw problem(400, "invalid check fields");
      const definition = this.checkMap.get(check.checkId);
      if (!definition || definition.host !== host || ["metric","collection","operation"].includes(definition.type) || checkIds.has(check.checkId)) throw problem(400, "unregistered, foreign or duplicate check");
      if (!STATUS.has(check.status) || !bounded(check.summary, 500)) throw problem(400, "invalid check result");
      checkIds.add(check.checkId);
    }
    const semantic=Object.assign({},batch);delete semantic.batchId;
    return { observed: Date.parse(batch.observedAt), hash: digest(batch),semanticHash:digest(semantic) };
  }
  activateStream(host, streamId, actor) {
    if (!this.hostMap.has(host) || !bounded(streamId, 160) || !/^[a-zA-Z0-9_.:@-]+$/.test(streamId) || !bounded(actor, 160)) throw problem(400, "valid host, stream and actor required");
    return this.transaction(() => {
      const prior = this.db.prepare("SELECT * FROM streams WHERE host=?").get(host);
      if (prior && prior.stream_id === streamId) return { ok: true, unchanged: true };
      this.capacity();
      this.db.prepare("INSERT INTO streams(host,stream_id,last_sequence,last_observed,received_at,value) VALUES(?,?,-1,NULL,NULL,?) ON CONFLICT(host) DO UPDATE SET stream_id=excluded.stream_id,last_sequence=-1,last_observed=NULL,received_at=NULL,value=excluded.value").run(host, streamId, json({ activatedBy: actor, activatedAt: this.now() }));
      const id = crypto.randomUUID();
      this.db.prepare("INSERT INTO outbox(id,host,at,event) VALUES(?,?,?,?)").run(id, host, this.now(), json({ id, host, type: "stream-activated", at: this.now(), actor, oldStreamId: prior ? prior.stream_id : null, streamId, notify: false }));
      this.db.prepare("DELETE FROM current_points WHERE host=?").run(host);
      this.db.prepare("DELETE FROM check_state WHERE host=?").run(host);
      return { ok: true, host, streamId };
    });
  }
  ingest(host, batch) {
    const validated = this.validate(host, batch), now = this.now();
    const byId=this.db.prepare("SELECT * FROM receipts WHERE host=? AND batch_id=?").get(host,batch.batchId);
    if(byId) {
      if(byId.digest!==validated.hash)throw problem(409,"batch identity conflicts with a durable receipt");
      return Object.assign({},decode(byId.receipt,{}),{replay:true});
    }
    const alias=this.db.prepare("SELECT * FROM receipt_aliases WHERE host=? AND batch_id=?").get(host,batch.batchId);
    if(alias) {
      if(alias.digest!==validated.hash)throw problem(409,"batch alias conflicts with a durable receipt");
      return decode(alias.response,{});
    }
    const bySequence=this.db.prepare("SELECT * FROM receipts WHERE host=? AND stream_id=? AND sequence=?").get(host,batch.streamId,batch.sequence);
    if(bySequence) {
      if(!bySequence.semantic_digest || bySequence.semantic_digest!==validated.semanticHash)throw problem(409,"stream sequence conflicts with a durable semantic receipt");
      const response=Object.assign({},decode(bySequence.receipt,{}),{batchId:batch.batchId,digest:validated.hash,semanticDigest:validated.semanticHash,canonicalBatchId:bySequence.batch_id,replay:true});
      return this.transaction(() => {
        this.db.prepare("INSERT INTO receipt_aliases(host,batch_id,canonical_batch_id,digest,response,created_at) VALUES(?,?,?,?,?,?)").run(host,batch.batchId,bySequence.batch_id,validated.hash,json(response),now);
        return response;
      });
    }
    const current = this.db.prepare("SELECT * FROM streams WHERE host=?").get(host);
    if (current && current.stream_id !== batch.streamId) throw problem(409, "stream replacement requires explicit activation");
    this.capacity();
    const observed = validated.observed;
    if (observed < now - 48 * HOUR || observed > now + DAY) throw problem(422, "timestamp is outside the accepted history window");
    const clockSkew = observed > now + 30000;
    const older = current && (batch.sequence <= current.last_sequence || (current.last_observed !== null && observed <= current.last_observed));
    const historyOnly = !!(clockSkew || older || observed < now - this.staleMs(host));
    const receipt = { ok: true, accepted: true, receiptId: crypto.createHash("sha256").update(host + "\0" + batch.batchId + "\0" + validated.hash).digest("hex"),
      batchId: batch.batchId, digest: validated.hash, semanticDigest:validated.semanticHash, receivedAt: now, observedAt: observed, historyOnly, clockSkew, replay: false };
    return this.transaction(() => {
      this.db.prepare("INSERT INTO receipts(host,batch_id,stream_id,sequence,digest,semantic_digest,observed_at,received_at,receipt) VALUES(?,?,?,?,?,?,?,?,?)").run(host,batch.batchId,batch.streamId,batch.sequence,validated.hash,validated.semanticHash,observed,now,json(receipt));
      if (!current) this.db.prepare("INSERT INTO streams(host,stream_id,last_sequence,last_observed,received_at,value) VALUES(?,?,-1,NULL,NULL,?)").run(host,batch.streamId,json({}));
      const samples = new Map(batch.samples.map(function(s) { return [s.seriesId,s]; }));
      const checks = new Map(batch.checks.map(function(s) { return [s.checkId,s]; }));
      const ins = this.db.prepare("INSERT INTO points(series_id,host,at,value,quality,reason,batch_id) VALUES(?,?,?,?,?,?,?)");
      for (const definition of this.series.filter(function(s) { return s.host === host; })) {
        let sample = samples.get(definition.id) || { value: null, quality: "unknown", reason: "collector omitted this declared series" };
        // Collection faults are partial: each validated probe carries its own
        // quality. An unrelated failed probe cannot erase a measured failure.
        // A future sample is retained as unknown, never a usable value in charts.
        if (clockSkew) sample = { value: null, quality: "unknown", reason: "host clock is ahead of the monitor" };
        ins.run(definition.id,host,observed,sample.value,sample.quality,sample.reason || null,batch.batchId);
        // Mark exact buckets dirty: aggregate recomputation is deterministic.
        for (const resolution of [300000,3600000]) this.db.prepare("INSERT OR REPLACE INTO monitor_meta(key,value) VALUES(?,?)").run("dirty:" + resolution + ":" + definition.id + ":" + Math.floor(observed / resolution) * resolution, json({ resolution, seriesId: definition.id, host, bucket: Math.floor(observed / resolution) * resolution }));
        if (!historyOnly) {
          this.db.prepare("INSERT INTO current_points(series_id,host,at,value,quality,reason) VALUES(?,?,?,?,?,?) ON CONFLICT(series_id) DO UPDATE SET at=excluded.at,value=excluded.value,quality=excluded.quality,reason=excluded.reason").run(definition.id,host,observed,sample.value,sample.quality,sample.reason || null);
          if (definition.policy) this.evaluate(this.checkMap.get(definition.id), this.metricResult(definition, sample), observed, batch, receipt);
        }
      }
      if (!historyOnly) {
        for (const definition of this.checks.filter(function(c) { return c.host === host && !["metric","collection","operation"].includes(c.type); })) {
          let check = checks.get(definition.id) || { status:"unknown",summary:"collector omitted this declared check" };
          this.evaluate(definition, check, observed, batch, receipt);
        }
        this.evaluate(this.checkMap.get(host + ".collection"),{status:batch.collection.ok ? "healthy" : "unknown",summary:batch.collection.ok ? "collector delivered a current observation" : batch.collection.error || "collector reported a failed collection"},observed,batch,receipt);
        this.db.prepare("UPDATE streams SET last_sequence=?,last_observed=?,received_at=?,value=? WHERE host=?").run(batch.sequence,observed,now,json({ bootId:batch.bootId,collection:batch.collection,configRevision:batch.configRevision,collectorVersion:batch.collectorVersion,clockSkew:false }),host);
      }
      if(this.response)this.response.tickInsideTransaction();
      this.db.prepare("INSERT OR REPLACE INTO monitor_meta(key,value) VALUES('lastEvaluationAt',?)").run(String(now));
      return receipt;
    });
  }
  metricResult(definition, sample) {
    if (sample.quality !== "good") return { status:"unknown",summary:sample.reason || sample.quality,value:null };
    const p = definition.policy, value=sample.value, above=p.direction === "above";
    const critical=Number.isFinite(p.critical) && (above ? value >= p.critical : value <= p.critical);
    const warning=above ? value >= p.warning : value <= p.warning;
    const recovered=above ? value <= p.recover : value >= p.recover;
    return { status: critical ? "critical" : warning ? "warning" : "healthy", summary:definition.label + ": " + value + " " + definition.unit, value,recovered };
  }
  isMaintenance(host, checkId, at=this.now()) {
    return !!this.db.prepare("SELECT id FROM maintenance WHERE host=? AND (check_id IS NULL OR check_id=?) AND starts_at<=? AND ends_at>? LIMIT 1").get(host,checkId,at,at);
  }
  evaluate(definition, result, at, batch, receipt) {
    const row=this.db.prepare("SELECT value FROM check_state WHERE id=?").get(definition.id);
    const previous=row ? decode(row.value,{}) : {};
    const gap=!previous.lastObservedAt || at-previous.lastObservedAt > this.staleMs(definition.host) || previous.bootId !== batch.bootId;
    const s=Object.assign({ status:"unknown",lastChangedAt:null,candidate:null,candidateSince:null,candidateCount:0,recoverySince:null,recoveryCount:0 },previous);
    if (gap) { s.candidate=null;s.candidateSince=null;s.candidateCount=0;s.recoverySince=null;s.recoveryCount=0; }
    s.lastObservedAt=at;s.bootId=batch.bootId;s.summary=result.summary;s.reportedStatus=result.status;s.maintenance=this.isMaintenance(definition.host,definition.id,at);
    let desired=s.status;
    if (result.status === "unknown") {
      desired="unknown";s.candidate=null;s.candidateSince=null;s.candidateCount=0;s.recoverySince=null;s.recoveryCount=0;
    } else if (result.status === "warning" || result.status === "critical") {
      s.recoveryCount=0;s.recoverySince=null;
      if (s.candidate !== result.status) { s.candidate=result.status;s.candidateSince=at;s.candidateCount=1; } else s.candidateCount++;
      const p=definition.policy;
      const due=definition.type === "metric" ? at-s.candidateSince >= (result.status === "critical" ? p.criticalForSeconds : p.warnForSeconds)*1000 : s.candidateCount >= p.failCount;
      if (due) desired=result.status;
      else if (desired === "unknown") desired="unknown"; // pending failure must not be labeled healthy
      if (rank[s.status] > rank[desired]) desired=s.status;
    } else {
      s.candidate=null;s.candidateCount=0;s.candidateSince=null;
      const open=this.db.prepare("SELECT id FROM incidents WHERE check_id=? AND status='open'").get(definition.id);
      if (!open && ["unknown","healthy"].includes(s.status)) desired="healthy";
      else if (definition.type === "metric" && !result.recovered) { s.recoverySince=null;s.recoveryCount=0; }
      else {
        if (s.recoverySince === null) s.recoverySince=at;
        s.recoveryCount++;
        const due=definition.type === "metric" ? at-s.recoverySince >= definition.policy.recoverForSeconds*1000 : s.recoveryCount >= definition.policy.recoverCount;
        if (due) desired="healthy";
      }
    }
    if (desired !== s.status) { s.status=desired;s.lastChangedAt=at; }
    s.pendingStatus=s.candidate && s.candidate !== s.status ? s.candidate : null;
    if (["warning","critical"].includes(s.status) && result.status !== "unknown") this.transition(definition,s,at,receipt,batch);
    if (s.status === "healthy" && result.status === "healthy") this.resolve(definition,s,at,receipt);
    this.db.prepare("INSERT INTO check_state(id,host,value) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(definition.id,definition.host,json(s));
  }
  transition(definition,state,at,receipt,batch) {
    const prior=this.db.prepare("SELECT * FROM incidents WHERE check_id=? AND status='open'").get(definition.id);
    const evidence={receiptId:receipt.receiptId,batchId:receipt.batchId,observedAt:at,configRevision:batch.configRevision,collectorVersion:batch.collectorVersion,definition:Object.assign({},definition,{notificationEnabled:this.notifications}),definitionRevision:digest(definition),summary:state.summary,operationalEvidence:receipt.operationalEvidence || null};
    if (!prior) {
      const id=crypto.randomUUID();
      this.db.prepare("INSERT INTO incidents(id,host,check_id,title,status,severity,opened_at,updated_at,summary,evidence) VALUES(?,?,?,?,'open',?,?,?,?,?)").run(id,definition.host,definition.id,definition.label,state.status,at,at,state.summary,json(evidence));
      this.response.opened(this.db.prepare("SELECT * FROM incidents WHERE id=?").get(id));
      this.queueEvent(id,definition.host,"opened",state.status,at,state.summary,evidence);
    } else {
      this.db.prepare("UPDATE incidents SET severity=?,updated_at=?,summary=? WHERE id=?").run(state.status,at,state.summary,prior.id);
      if (prior.severity !== state.status) this.queueEvent(prior.id,definition.host,"updated",state.status,at,state.summary,evidence);
    }
  }
  resolve(definition,state,at,receipt) {
    const prior=this.db.prepare("SELECT * FROM incidents WHERE check_id=? AND status='open'").get(definition.id);
    if (!prior) return;
    this.db.prepare("UPDATE incidents SET status='resolved',updated_at=?,resolved_at=?,summary=? WHERE id=?").run(at,at,state.summary,prior.id);
    this.queueEvent(prior.id,definition.host,"resolved",prior.severity,at,state.summary,{receiptId:receipt.receiptId,batchId:receipt.batchId});
  }
  queueEvent(incidentId,host,type,severity,at,summary,evidence) {
    const id=crypto.createHash("sha256").update([host,incidentId,type,at,severity,digest(evidence)].join("|")).digest("hex");
    let notify=this.notifications && ["opened","updated","resolved"].includes(type);
    if(type === "resolved") {
      const opening=this.db.prepare("SELECT event FROM outbox WHERE host=? AND json_extract(event,'$.incidentId')=? AND json_extract(event,'$.type')='opened'").get(host,incidentId);
      notify=notify && !!(opening && decode(opening.event,{}).notify);
      this.db.prepare("UPDATE outbox SET superseded_at=? WHERE host=? AND json_extract(event,'$.incidentId')=? AND json_extract(event,'$.type') IN ('opened','updated') AND attempted_at IS NULL AND delivered_at IS NULL").run(this.now(),host,incidentId);
      // No recovery notification for an outage that was never attempted.
      const attempted=this.db.prepare("SELECT id FROM outbox WHERE host=? AND json_extract(event,'$.incidentId')=? AND attempted_at IS NOT NULL AND json_extract(event,'$.type')='opened'").get(host,incidentId);
      notify=notify && !!attempted;
    }
    const event={id,eventId:id,incidentId,generation:incidentId,host,type,kind:type,at,timestamp:at,severity,summary,evidence,notify};
    if(this.response)Object.assign(event,this.response.eventMetadata(event));
    this.db.prepare("INSERT OR IGNORE INTO outbox(id,host,at,event) VALUES(?,?,?,?)").run(id,host,at,json(event));
  }
  currentChecks(hosts) {
    const selected=this.hostsFilter(hosts), now=this.now();
    return this.checks.filter(function(c) { return !selected || selected.includes(c.host); }).map((c) => {
      const row=this.db.prepare("SELECT value FROM check_state WHERE id=?").get(c.id), s=row ? decode(row.value,{}) : {};
      const stale=!s.lastObservedAt || now-s.lastObservedAt > (c.type==="operation"?Math.max(c.intervalSeconds*3000,60000):this.staleMs(c.host));
      return Object.assign({},c,s,{ status:stale ? "unknown" : s.status || "unknown", summary:stale ? s.lastObservedAt ? "last observation is stale" : "no observation received" : s.summary,
        lastObservedAt:s.lastObservedAt || null,lastChangedAt:s.lastChangedAt || null,maintenance:this.isMaintenance(c.host,c.id),notificationEnabled:this.notifications });
    });
  }
  resources(hosts) {
    const selected=this.hostsFilter(hosts), now=this.now(), checks=this.currentChecks(hosts);
    const resources=this.targets.filter(function(t) { return !selected || selected.includes(t.id); }).map((t) => {
      const stream=this.db.prepare("SELECT * FROM streams WHERE host=?").get(t.id);
      const last=stream ? stream.last_observed : null, stale=last === null || now-last > this.staleMs(t.id);
      const metrics=this.series.filter(function(s) { return s.host === t.id; }).map((s) => {
        const p=this.db.prepare("SELECT * FROM current_points WHERE series_id=?").get(s.id), check=checks.find(function(c) { return c.id === s.id; });
        return {id:s.id,label:s.label,unit:s.unit,type:s.type,value:!p || stale || p.quality !== "good" ? null : p.value,quality:!p || stale ? "unknown" : p.quality,
          observedAt:p ? p.at : null,ageSeconds:p ? Math.max(0,(now-p.at)/1000) : null,state:check ? check.status : !p || stale || p.quality !== "good" ? "unknown" : "healthy",reason:p ? p.reason : "no observation received"};
      });
      const own=checks.filter(function(c) { return c.host === t.id && c.type !== "operation"; });
      const collection=stream ? decode(stream.value,{}) : {};
      const incomplete=!!(collection.collection && !collection.collection.ok) || own.some(function(c) { return c.status === "unknown"; }) || metrics.some(function(m) { return m.quality !== "good"; });
      const quality=stale ? "unknown" : incomplete ? "partial" : "good";
      // Fresh confirmed failures dominate missing sibling observations. Overall
      // freshness still gates current health; open incidents survive staleness.
      const state=stale ? "unknown" : own.some(function(c) { return c.status === "critical"; }) ? "critical"
        : incomplete ? "unknown" : own.some(function(c) { return c.status === "warning"; }) ? "warning" : "healthy";
      return Object.assign({},t,{state,quality,lastObservedAt:last,lastReceivedAt:stream ? stream.received_at : null,ageSeconds:last === null ? null : Math.max(0,(now-last)/1000),collection,metrics});
    });
    return {ok:true,at:now,resources};
  }
  overview(hosts) {
    const {resources}=this.resources(hosts), incidents=this.incidents(hosts,{openOnly:true}).incidents;
    return {ok:true,at:this.now(),counts:{targets:resources.length,reporting:resources.filter(function(t) { return t.state !== "unknown"; }).length,
      unknown:resources.filter(function(t) { return t.state === "unknown"; }).length,warning:resources.filter(function(t) { return t.state === "warning"; }).length,
      critical:resources.filter(function(t) { return t.state === "critical"; }).length,openIncidents:incidents.length},
      targets:resources.map(function(t) { const out=Object.assign({},t);delete out.metrics;return out; }),incidents,notificationEnabled:this.notifications};
  }
  incidents(hosts,options={}) {
    const scope=this.scope(hosts);
    if(options.episodeId){if(!bounded(options.episodeId,100))throw problem(400,"invalid episode identity");scope.sql+=" AND id IN (SELECT incident_id FROM incident_lifecycle WHERE episode_id=?)";scope.values.push(options.episodeId);}
    const rows=this.db.prepare("SELECT * FROM incidents WHERE 1=1" + (options.openOnly ? " AND status='open'" : "") + scope.sql + " ORDER BY updated_at DESC LIMIT 500").all(...scope.values);
    return {ok:true,at:this.now(),notificationEnabled:this.notifications,incidents:rows.map((r) => { return {id:r.id,host:r.host,checkId:r.check_id,title:r.title,status:r.status,severity:r.severity,openedAt:r.opened_at,updatedAt:r.updated_at,resolvedAt:r.resolved_at,summary:r.summary,evidence:decode(r.evidence,{}),acknowledgedAt:r.acknowledged_at,acknowledgedBy:r.acknowledged_by,revision:digest([r.updated_at,r.resolved_at,r.acknowledged_at,r.acknowledged_by,r.status,r.severity]),lifecycle:this.response.lifecycle(r.id),conditionKind:(this.checkMap.get(r.check_id)||{}).type||"inactive",declaredDependencies:(this.checkMap.get(r.check_id)||{}).dependencies||[],notificationEnabled:this.notifications}; })};
  }
  incidentView(r,{compact=false}={}) {
    const value={id:r.id,host:r.host,checkId:r.check_id,title:r.title,status:r.status,severity:r.severity,
      openedAt:r.opened_at,updatedAt:r.updated_at,resolvedAt:r.resolved_at,summary:r.summary,evidence:decode(r.evidence,{}),
      acknowledgedAt:r.acknowledged_at,acknowledgedBy:r.acknowledged_by,
      revision:digest([r.updated_at,r.resolved_at,r.acknowledged_at,r.acknowledged_by,r.status,r.severity]),
      lifecycle:this.response.lifecycle(r.id),conditionKind:(this.checkMap.get(r.check_id)||{}).type||"inactive",
      declaredDependencies:(this.checkMap.get(r.check_id)||{}).dependencies||[],notificationEnabled:this.notifications};
    if(compact){
      value.evidence=require("./history").compact(value.evidence);
      value.lifecycle=require("./history").compact(value.lifecycle);
      value.declaredDependencies=require("./history").compact(value.declaredDependencies);
      for(const key of ["title","summary","acknowledgedBy"])if(typeof value[key]==="string"&&value[key].length>8000)value[key]=value[key].slice(0,8000)+" [truncated]";
    }
    return value;
  }
  incidentDetail(hosts,incidentId) {
    if(!bounded(incidentId,100))throw problem(400,"invalid incident identity");
    const scope=this.scope(hosts);
    const row=this.db.prepare("SELECT * FROM incidents WHERE id=?"+scope.sql).get(incidentId,...scope.values);
    if(!row)throw problem(404,"incident not found in selected estate");
    return {ok:true,at:this.now(),notificationEnabled:this.notifications,incident:this.incidentView(row)};
  }
  incidentHistory(hosts,options={}) {
    const selected=this.hostsFilter(hosts),scope=this.scope(selected,"i.host");
    const state=options.state||"all",host=options.host||null,checkId=options.checkId||null,episodeId=options.episodeId||null;
    if(!["all","open","resolved"].includes(state))throw problem(400,"invalid incident history state");
    if(host&&!this.hostMap.has(host))throw problem(400,"invalid history host");
    if(checkId&&!bounded(checkId,200))throw problem(400,"invalid check identity");
    if(episodeId&&!bounded(episodeId,100))throw problem(400,"invalid episode identity");
    if(host){scope.sql+=" AND i.host=?";scope.values.push(host);}
    const scoped="FROM incidents i WHERE 1=1"+scope.sql;
    const {paginate}=require("./history");
    const result=paginate({options,defaultLimit:50,kind:"incidents",filters:{hosts:selected?[...selected].sort():null,host,checkId,state,episodeId},
      now:this.now,
      top:()=>{const row=this.db.prepare("SELECT i.rowid AS n,i.id "+scoped+" ORDER BY i.rowid DESC LIMIT 1").get(...scope.values);return row?[row.n,row.id]:null;},
      anchor:(n)=>this.db.prepare("SELECT i.id "+scoped+" AND i.rowid=?").get(...scope.values,n)?.id,
      query:({highWater,snapshotAt,boundary,direction,limit})=>{
        // Select each episode's newest retained occurrence before applying state
        // or check filters, so an old resolved occurrence cannot resurrect an episode.
        const cte="WITH retained AS (SELECT i.rowid AS history_rowid,i.*,COALESCE(l.episode_id,i.id) AS episode_key FROM incidents i LEFT JOIN incident_lifecycle l ON l.incident_id=i.id WHERE i.rowid<=?"+scope.sql+"), selected AS (SELECT * FROM retained"+(episodeId?" WHERE episode_key=?":" WHERE history_rowid IN (SELECT MAX(history_rowid) FROM retained GROUP BY episode_key)")+") ";
        const args=[highWater,...scope.values,...(episodeId?[episodeId]:[])];
        let where=" WHERE 1=1";
        if(state==="open"){where+=" AND (resolved_at IS NULL OR resolved_at>?)";args.push(snapshotAt);}
        if(state==="resolved"){where+=" AND resolved_at IS NOT NULL AND resolved_at<=?";args.push(snapshotAt);}
        if(checkId){where+=" AND check_id=?";args.push(checkId);}
        let membership=null,total;
        if(state!=="all"){
          const fingerprint=crypto.createHash("sha256");total=0;
          for(const item of this.db.prepare(cte+"SELECT history_rowid,id FROM selected"+where+" ORDER BY history_rowid").iterate(...args)){fingerprint.update(json([item.history_rowid,item.id])+"\\n");total++;}
          membership=fingerprint.digest("hex");
        }else total=this.db.prepare(cte+"SELECT COUNT(*) AS n FROM selected"+where).get(...args).n;
        const ordered=direction==="newer"?"ASC":"DESC",bound=boundary===null?"":" AND history_rowid"+(direction==="newer"?">":direction==="current"?"<=":"<")+"?";
        let rows=this.db.prepare(cte+"SELECT * FROM selected"+where+bound+" ORDER BY history_rowid "+ordered+" LIMIT ?").all(...args,...(boundary===null?[]:[boundary]),limit);
        if(direction==="newer")rows.reverse();
        const first=rows[0],last=rows[rows.length-1];
        const exists=(op,n)=>!!this.db.prepare(cte+"SELECT 1 FROM selected"+where+" AND history_rowid"+op+"? LIMIT 1").get(...args,n);
        return {rows,total,membership,hasPrevious:!!first&&exists(">",first.history_rowid),hasNext:!!last&&exists("<",last.history_rowid)};
      }});
    return require("./history").boundedPage({ok:true,at:this.now(),notificationEnabled:this.notifications,incidents:result.rows.map(r=>this.incidentView(r,{compact:true})),page:result.page});
  }
  mutate(operation,body,fn) {
    if(!bounded(body.idempotencyKey,160)||!/^[a-zA-Z0-9_.:-]+$/.test(body.idempotencyKey))throw problem(400,"idempotencyKey required");
    const hash=digest(body);
    return this.transaction(() => {
      const prior=this.db.prepare("SELECT digest,response FROM mutation_receipts WHERE operation=? AND idempotency_key=?").get(operation,body.idempotencyKey);
      if(prior){if(prior.digest!==hash)throw problem(409,"idempotency key conflicts with a different mutation");return decode(prior.response,{});}
      this.capacity();
      const response=fn();
      this.db.prepare("INSERT INTO mutation_receipts(operation,idempotency_key,digest,response,created_at) VALUES(?,?,?,?,?)").run(operation,body.idempotencyKey,hash,json(response),this.now());
      return response;
    });
  }
  acknowledge(body,hosts) {
    if (!plain(body) || !bounded(body.incidentId,100) || !bounded(body.actor,160) || (body.note!==undefined && (typeof body.note!=="string" || body.note.length>2000))) throw problem(400,"incidentId, actor and bounded note required");
    const row=this.db.prepare("SELECT * FROM incidents WHERE id=?").get(body.incidentId);
    if (!row) throw problem(404,"incident not found");
    const allowed=this.hostsFilter(hosts);if (allowed && !allowed.includes(row.host)) throw problem(403,"incident outside host scope");
    return this.mutate("incident-ack",body,() => {
      const current=this.db.prepare("SELECT * FROM incidents WHERE id=?").get(body.incidentId);
      if (!body.expectedRevision || body.expectedRevision !== digest([current.updated_at,current.resolved_at,current.acknowledged_at,current.acknowledged_by,current.status,current.severity])) throw problem(409,"incident changed; refresh before acknowledging");
      this.db.prepare("UPDATE incidents SET acknowledged_at=?,acknowledged_by=? WHERE id=?").run(this.now(),body.actor,body.incidentId);
      this.queueEvent(body.incidentId,row.host,"acknowledged","info",this.now(),"Acknowledged by " + body.actor,{actor:body.actor,note:body.note || ""});
      return {ok:true,incidentId:body.incidentId,acknowledgedAt:this.now(),note:body.note || ""};
    });
  }
  maintenance(body,hosts) {
    if (!plain(body) || !this.hostMap.has(body.host) || !bounded(body.actor,160) || !bounded(body.reason,1000)) throw problem(400,"host, actor and reason required");
    const allowed=this.hostsFilter(hosts);if (allowed && !allowed.includes(body.host)) throw problem(403,"maintenance outside host scope");
    if (body.checkId && (!this.checkMap.has(body.checkId) || this.checkMap.get(body.checkId).host !== body.host)) throw problem(400,"invalid maintenance check");
    return this.mutate("maintenance",body,() => {
      const start=body.startsAt === undefined ? this.now() : Number(body.startsAt), end=body.endsAt === undefined ? start + Number(body.durationMinutes)*60000 : Number(body.endsAt);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start || end <= this.now() || end-start > 7*DAY || start < this.now()-60000) throw problem(400,"maintenance must have a bounded future end within seven days");
      const id=crypto.randomUUID();
      this.db.prepare("INSERT INTO maintenance(id,host,check_id,starts_at,ends_at,reason,actor,created_at) VALUES(?,?,?,?,?,?,?,?)").run(id,body.host,body.checkId || null,start,end,body.reason,body.actor,this.now());
      this.queueEvent(null,body.host,"maintenance","info",this.now(),body.reason,{id,actor:body.actor,startsAt:start,endsAt:end,checkId:body.checkId || null});
      return {ok:true,id,startsAt:start,endsAt:end};
    });
  }
  events(hosts,includeDelivered=false,notifyOnly=false,options={}) {
    const scope=this.scope(hosts), values=[...scope.values];
    let where="WHERE 1=1"+(includeDelivered?"":" AND delivered_at IS NULL AND superseded_at IS NULL")+(notifyOnly?" AND json_extract(event,'$.notify')=1":"")+scope.sql;
    for(const [key,op] of [["from",">="],["to","<="]])if(options[key]!==undefined&&options[key]!==null){const n=Number(options[key]);if(!Number.isSafeInteger(n))throw problem(400,"invalid event window");where+=" AND at"+op+"?";values.push(n);}
    if(options.incidentId){if(!bounded(options.incidentId,100))throw problem(400,"invalid incident identity");where+=" AND json_extract(event,'$.incidentId')=?";values.push(options.incidentId);}
    if(options.episodeId){if(!bounded(options.episodeId,100))throw problem(400,"invalid episode identity");where+=" AND json_extract(event,'$.incidentId') IN (SELECT incident_id FROM incident_lifecycle WHERE episode_id=?)";values.push(options.episodeId);}
    if(options.cursor){let cursor;try{if(options.cursor.length>500)throw new Error();cursor=JSON.parse(Buffer.from(options.cursor,"base64url"));}catch{throw problem(400,"invalid event cursor");}if(!Number.isSafeInteger(cursor.at)||!bounded(cursor.id,100))throw problem(400,"invalid event cursor");const op=includeDelivered?"<":">";where+=" AND (at"+op+"? OR (at=? AND id"+op+"?))";values.push(cursor.at,cursor.at,cursor.id);}
    const limit=Math.min(500,Math.max(1,Number(options.limit)||100));
    const order=includeDelivered?"DESC":"ASC";
    const rows=this.db.prepare("SELECT id,at,event,delivered_at,attempted_at,superseded_at,outcome FROM outbox "+where+" ORDER BY at "+order+",id "+order+" LIMIT ?").all(...values,limit+1);
    const truncated=rows.length>limit, page=rows.slice(0,limit), last=page[page.length-1];
    return {ok:true,pendingOnly:!includeDelivered,notificationEnabled:this.notifications,truncated,nextCursor:truncated?Buffer.from(json({at:last.at,id:last.id})).toString("base64url"):null,events:page.map(function(r){return Object.assign(decode(r.event,{}),{deliveredAt:r.delivered_at,forwardedAt:r.delivered_at,attemptedAt:r.attempted_at,supersededAt:r.superseded_at,outcome:r.outcome});})};
  }
  scopedEvent(eventId,hosts) {
    if (!bounded(eventId,100)) throw problem(400,"eventId required");
    const row=this.db.prepare("SELECT * FROM outbox WHERE id=?").get(eventId);if(!row)throw problem(404,"event not found");
    const selected=this.hostsFilter(hosts);if(selected&&!selected.includes(row.host))throw problem(403,"event outside host scope");
    return row;
  }
  claimEvent(eventId,hosts) {
    const row=this.scopedEvent(eventId,hosts);
    if(row.superseded_at)throw problem(409,"event superseded before delivery");
    if(row.delivered_at)return {ok:true,eventId,alreadyForwarded:true};
    this.db.prepare("UPDATE outbox SET attempted_at=COALESCE(attempted_at,?) WHERE id=?").run(this.now(),eventId);
    return {ok:true,eventId,event:decode(row.event,{}),attemptedAt:row.attempted_at || this.now()};
  }
  acknowledgeEvent(eventId,hosts,outcome="forwarded-to-console") {
    const row=this.scopedEvent(eventId,hosts);
    if(!["forwarded-to-console","shadow-recorded"].includes(outcome))throw problem(400,"invalid event outcome");
    if(!row.attempted_at&&outcome==="forwarded-to-console")throw problem(409,"claim event before forwarding");
    this.db.prepare("UPDATE outbox SET delivered_at=COALESCE(delivered_at,?),outcome=COALESCE(outcome,?) WHERE id=?").run(this.now(),outcome,eventId);
    return {ok:true,eventId,outcome};
  }
  dependencies(hosts) { return this.response.dependencies(hosts); }
  notificationLedger(hosts,options={}) { return this.response.ledger(hosts,options); }
  prepareNotification(eventId,destinations,hosts) { return this.response.prepare(eventId,destinations,hosts); }
  recordNotificationReceipt(input,hosts) { return this.response.receipt(input,hosts); }
  notificationEligibility(id,hosts) { return this.response.deliveryEligibility(id,hosts); }
  reconcileOperationalConditions(conditions,definitions) { return this.response.reconcileConditions(conditions,definitions); }
  evaluateFreshness() {
    const now=this.now();
    return this.transaction(() => {
      for(const host of this.targets) {
        const stream=this.db.prepare("SELECT * FROM streams WHERE host=?").get(host.id);
        // Newly installed collectors remain unknown until the first real observation.
        if(!stream||stream.last_observed===null||now-stream.last_observed<=this.staleMs(host.id))continue;
        const state=decode(stream.value,{});
        this.evaluate(this.checkMap.get(host.id+".collection"),{status:"critical",summary:"collector observation overdue by "+Math.floor((now-stream.last_observed)/1000)+" seconds"},now,
          {bootId:state.bootId || "unknown",configRevision:state.configRevision || "unknown",collectorVersion:state.collectorVersion || "unknown"},
          {receiptId:null,batchId:null});
      }
      if(this.response)this.response.tickInsideTransaction();
      this.db.prepare("INSERT OR REPLACE INTO monitor_meta(key,value) VALUES('lastEvaluationAt',?)").run(String(now));
    });
  }
  rollupBatch(limit=100) {
    const rows=this.db.prepare("SELECT key,value FROM monitor_meta WHERE key LIKE 'dirty:%' ORDER BY key LIMIT ?").all(Math.min(1000,Math.max(1,limit)));
    return this.transaction(() => {
      for (const row of rows) {
        const spec=decode(row.value,null);if(!spec) throw new Error("invalid rollup work item");
        const values=this.db.prepare("SELECT at,value,quality FROM points WHERE series_id=? AND at>=? AND at<? ORDER BY at").all(spec.seriesId,spec.bucket,spec.bucket+spec.resolution);
        const good=values.filter(function(p) { return p.quality === "good"; });
        if (values.length) {
          const last=values[values.length-1], nums=good.map(function(p) { return p.value; }), covered=new Set(good.map(function(p){return Math.floor(p.at/60000);})).size;
          this.db.prepare("INSERT INTO rollups(resolution,series_id,host,bucket,count,good_count,covered_slots,sum,min,max,last_value,last_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(resolution,series_id,bucket) DO UPDATE SET count=excluded.count,good_count=excluded.good_count,covered_slots=excluded.covered_slots,sum=excluded.sum,min=excluded.min,max=excluded.max,last_value=excluded.last_value,last_at=excluded.last_at").run(spec.resolution,spec.seriesId,spec.host,spec.bucket,values.length,good.length,covered,good.reduce(function(sum,p) {return sum+p.value;},0),nums.length ? Math.min(...nums) : null,nums.length ? Math.max(...nums) : null,last.quality === "good" ? last.value : null,last.at);
        }
        this.db.prepare("DELETE FROM monitor_meta WHERE key=?").run(row.key);
      }
      return rows.length;
    });
  }
  maintenanceTick() {
    try {
      this.evaluateFreshness();
      const rolled=this.rollupBatch(200);
      // Do not delete raw history while any bucket awaits deterministic aggregation.
      const dirty=this.db.prepare("SELECT COUNT(*) AS n FROM monitor_meta WHERE key LIKE 'dirty:%'").get().n;
      const now=this.now();
      this.transaction(() => {
        if (!dirty) this.db.prepare("DELETE FROM points WHERE rowid IN (SELECT rowid FROM points WHERE at<? LIMIT 5000)").run(now-RAW_DAYS*DAY);
        this.db.prepare("DELETE FROM rollups WHERE rowid IN (SELECT rowid FROM rollups WHERE (resolution=300000 AND bucket<?) OR (resolution=3600000 AND bucket<?) LIMIT 5000)").run(now-FIVE_MIN_DAYS*DAY,now-HOURLY_DAYS*DAY);
        // Receipt tombstones intentionally outlive raw data: no replay becomes new admission.
      });
      this.db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get();
      this.fault=null;return {rolled,dirty};
    } catch(error) { this.fault=String(error.message || error).slice(0,300);return {error:this.fault}; }
  }
  query(ids,from,to,hosts) {
    const selected=this.hostsFilter(hosts);
    const list=Array.isArray(ids) ? ids : String(ids || "").split(",");
    from=Number(from);to=Number(to);
    if (!list.length || list.length>8 || new Set(list).size !== list.length || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to<=from || to-from>HOURLY_DAYS*DAY || from<this.now()-HOURLY_DAYS*DAY || to>this.now()+60000) throw problem(400,"query requires 1-8 distinct series and a valid bounded time range");
    for(const id of list) {const s=this.seriesMap.get(id);if(!s)throw problem(400,"unknown series");if(selected&&!selected.includes(s.host))throw problem(403,"series outside host scope");}
    const span=to-from, tier=from<this.now()-FIVE_MIN_DAYS*DAY ? 3600000 : from<this.now()-RAW_DAYS*DAY || span/60000>1200 ? 300000 : 0;
    const displayStep=Math.max(tier || 60000,Math.ceil(span/1200/(tier || 60000))*(tier || 60000));
    const series=list.map((id) => {
      const definition=this.seriesMap.get(id), buckets=new Map();
      // Each query reads at most 1201 SQL aggregates, regardless of historical size.
      let rows;
      if (!tier) rows=this.db.prepare("SELECT CAST((at-?)/? AS INTEGER) AS b,COUNT(*) AS n,SUM(CASE WHEN quality='good' THEN 1 ELSE 0 END) AS good,COUNT(DISTINCT CASE WHEN quality='good' THEN CAST(at/60000 AS INTEGER) END) AS covered,SUM(CASE WHEN quality='good' THEN value ELSE 0 END) AS sum,MIN(CASE WHEN quality='good' THEN value END) AS min,MAX(CASE WHEN quality='good' THEN value END) AS max FROM points WHERE series_id=? AND at>=? AND at<? GROUP BY b ORDER BY b LIMIT 1201").all(from,displayStep,id,from,to);
      else rows=this.db.prepare("SELECT CAST((bucket-?)/? AS INTEGER) AS b,SUM(count) AS n,SUM(good_count) AS good,SUM(covered_slots) AS covered,SUM(sum) AS sum,MIN(min) AS min,MAX(max) AS max FROM rollups WHERE resolution=? AND series_id=? AND bucket>=? AND bucket<? GROUP BY b ORDER BY b LIMIT 1201").all(from,displayStep,tier,id,from,to);
      for(const row of rows)buckets.set(row.b,row);
      const points=[];
      for(let at=from,i=0;at<to&&i<1200;at+=displayStep,i++){
        const r=buckets.get(i),expected=Math.max(1,Math.floor(Math.min(displayStep,to-at)/60000));
        points.push({at,value:r&&r.good ? r.sum/r.good : null,quality:r&&r.covered>=expected&&r.good===r.n ? "good" : "unknown",min:r?r.min:null,max:r?r.max:null,count:r?r.n:0,goodCount:r?r.good:0,coveredCount:r?r.covered:0,expectedCount:expected});
      }
      return {id,label:definition.label,unit:definition.unit,type:definition.type,points};
    });
    return {ok:true,from,to,resolution:tier===3600000 ? "1h" : tier===300000 ? "5m" : "raw",displayIntervalMs:displayStep,coverageBasis:"minute slots containing a good observation, not proof of continuous uptime",series};
  }
}
module.exports={MonitorStore,problem,canonical,digest,RAW_DAYS,FIVE_MIN_DAYS,HOURLY_DAYS};
