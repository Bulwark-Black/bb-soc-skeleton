"use strict";

// External single-host durable delivery queue. No vendor credentials, raw
// payloads, shell commands or timers are stored. Run drain from your scheduler.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");
const { validateBaseUrl } = require("./agent-mcp");
const { prepareBatch, createIntegrationClient, validateReceipt, SenderError } = require("./integration-client");
const MAX_ENTRIES = 10000, MAX_BYTES = 64 * 1024 * 1024, MAX_ATTEMPTS = 10;
const LEASE_MS = 60000, MAX_AGE_MS = 7 * 86400000;
const ROOT = fs.realpathSync(path.resolve(__dirname, ".."));

function secureDirectory(directory) {
  if (typeof directory !== "string" || !path.isAbsolute(directory) || directory !== path.resolve(directory)
      || directory === path.parse(directory).root || directory === ROOT || directory.startsWith(ROOT + path.sep)) throw new TypeError("Outbox needs a canonical absolute, owner-only directory outside the checkout.");
  let current = path.parse(directory).root;
  for (const part of directory.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TypeError("Outbox directories cannot contain symbolic links.");
  }
  const stat = fs.lstatSync(directory);
  if ((stat.mode & 0o077) || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new TypeError("Outbox directory must be owned by this user with mode 0700.");
  // A dedicated directory avoids sharing a deployment's managed state.
  if (fs.readdirSync(directory).some(name => !["outbox.sqlite", "outbox.sqlite-wal", "outbox.sqlite-shm", "outbox.sqlite-journal"].includes(name))) throw new TypeError("Use a dedicated outbox directory, separate from application state and token files.");
  return directory;
}
function checkFile(filename) {
  if (!fs.existsSync(filename) && !fs.lstatSync(filename, { throwIfNoEntry: false })) return;
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077)
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new TypeError("Outbox files must be owner-only regular files without links.");
}
function sourceId(value) { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new TypeError("A valid sourceId is required."); return value; }
function id(value) { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError("A valid outbox entry ID is required."); return value; }
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const DELIVERY_COLUMNS = ["id", "base_url", "source_id", "receipt_id", "body_hash", "body", "bytes", "state", "attempts",
  "created_at", "updated_at", "next_at", "claim", "lease_until", "receipt", "error_code", "status"];
function savedBatch(row) {
  if (row.id !== hash(JSON.stringify([row.base_url, row.source_id, row.receipt_id])) || typeof row.body !== "string"
      || Buffer.byteLength(row.body) !== row.bytes || hash(row.body) !== row.body_hash) throw new TypeError("Invalid saved delivery body.");
  const batch = JSON.parse(row.body);
  if (prepareBatch(batch).body !== row.body || batch.sourceId !== row.source_id || batch.receiptId !== row.receipt_id) throw new TypeError("Saved delivery identity does not match its body.");
  return batch;
}
function validateDatabase(db) {
  const schema = db.prepare("SELECT type,name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
  const expected = new Set(["table:outbox_meta", "table:deliveries", "index:delivery_due"]);
  if (schema.length !== expected.size || schema.some(item => !expected.has(`${item.type}:${item.name}`))
      || db.pragma("quick_check", { simple: true }) !== "ok") throw new TypeError("Invalid outbox database schema or integrity.");
  if (JSON.stringify(db.pragma("table_info(outbox_meta)").map(item => item.name)) !== JSON.stringify(["id", "version"])
      || JSON.stringify(db.pragma("table_info(deliveries)").map(item => item.name)) !== JSON.stringify(DELIVERY_COLUMNS)) throw new TypeError("Invalid outbox database columns.");
  const metadata = db.prepare("SELECT id,version FROM outbox_meta").all();
  if (metadata.length !== 1 || metadata[0].id !== 1 || metadata[0].version !== 1) throw new TypeError("Unsupported outbox schema version.");
  const totals = db.prepare("SELECT count(*) AS count,coalesce(sum(bytes),0) AS bytes FROM deliveries").get();
  if (totals.count > MAX_ENTRIES || totals.bytes > MAX_BYTES) throw new TypeError("Saved outbox exceeds its configured bounds.");
  for (const row of db.prepare("SELECT * FROM deliveries").iterate()) {
    if (validateBaseUrl(row.base_url) !== row.base_url || sourceId(row.source_id) !== row.source_id
        || typeof row.receipt_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(row.receipt_id)
        || row.id !== hash(JSON.stringify([row.base_url, row.source_id, row.receipt_id])) || !/^[a-f0-9]{64}$/.test(row.body_hash)
        || !["pending", "inflight", "blocked", "delivered"].includes(row.state)
        || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > 1024 * 1024
        || !Number.isSafeInteger(row.attempts) || row.attempts < 0 || row.attempts > MAX_ATTEMPTS
        || [row.created_at, row.updated_at, row.next_at].some(value => !Number.isSafeInteger(value) || value < 0)
        || (row.status !== null && (!Number.isSafeInteger(row.status) || row.status < 100 || row.status > 599))
        || (row.error_code !== null && (typeof row.error_code !== "string" || !/^[a-z-]{1,80}$/.test(row.error_code)))) throw new TypeError("Invalid saved outbox delivery metadata.");
    if (row.state === "inflight") {
      if (typeof row.claim !== "string" || !/^[a-f0-9-]{36}$/.test(row.claim) || !Number.isSafeInteger(row.lease_until) || row.lease_until < 0) throw new TypeError("Invalid saved outbox lease.");
    } else if (row.claim !== null || row.lease_until !== null) throw new TypeError("Unexpected saved outbox lease.");
    if (row.state === "delivered") {
      if (row.body !== null || row.bytes !== 0 || typeof row.receipt !== "string") throw new TypeError("Invalid completed outbox delivery.");
      const receipt = JSON.parse(row.receipt), count = receipt.accepted + receipt.duplicates;
      if (!Number.isSafeInteger(count) || count < 1 || count > 1000) throw new TypeError("Invalid completed outbox receipt.");
      validateReceipt(receipt, { sourceId: row.source_id, receiptId: row.receipt_id, records: { length: count } });
    } else {
      if (row.receipt !== null) throw new TypeError("Unexpected receipt for an unfinished delivery.");
      savedBatch(row);
    }
  }
}
function openOutbox(directory) {
  const filename = path.join(secureDirectory(directory), "outbox.sqlite");
  for (const suffix of ["", "-wal", "-shm", "-journal"]) checkFile(filename + suffix);
  // Create privately before SQLite opens the file (not chmod after exposure).
  if (!fs.existsSync(filename)) { const fd = fs.openSync(filename, "wx", 0o600); fs.closeSync(fd); }
  const db = new Database(filename);
  try {
    db.pragma("trusted_schema = OFF"); db.pragma("busy_timeout = 5000");
    const schema = db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
    if (schema.length) validateDatabase(db);
    db.pragma("journal_mode = WAL"); db.pragma("synchronous = FULL");
    db.exec(`CREATE TABLE IF NOT EXISTS outbox_meta (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL) STRICT;
      INSERT OR IGNORE INTO outbox_meta VALUES(1,1);
      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY, base_url TEXT NOT NULL, source_id TEXT NOT NULL, receipt_id TEXT NOT NULL,
        body_hash TEXT NOT NULL, body TEXT, bytes INTEGER NOT NULL, state TEXT NOT NULL,
        attempts INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, next_at INTEGER NOT NULL,
        claim TEXT, lease_until INTEGER, receipt TEXT, error_code TEXT, status INTEGER,
        UNIQUE(base_url,source_id,receipt_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS delivery_due ON deliveries(base_url,source_id,state,next_at,created_at);`);
    for (const suffix of ["-wal", "-shm"]) if (fs.existsSync(filename + suffix)) fs.chmodSync(filename + suffix, 0o600);
  } catch (error) { db.close(); throw error; }
  const enqueue = db.transaction((value, destination) => {
    const baseUrl = validateBaseUrl(destination), { batch, body } = prepareBatch(value), digest = hash(body);
    const previous = db.prepare("SELECT id,body_hash,state FROM deliveries WHERE base_url=? AND source_id=? AND receipt_id=?").get(baseUrl, batch.sourceId, batch.receiptId);
    if (previous) {
      if (previous.body_hash !== digest) throw new TypeError("The saved receipt ID has different content. Original delivery is unchanged.");
      return { id: previous.id, state: previous.state, duplicate: true };
    }
    const bytes = Buffer.byteLength(body), totals = db.prepare("SELECT count(*) AS count,coalesce(sum(bytes),0) AS bytes FROM deliveries").get();
    if (totals.count >= MAX_ENTRIES || totals.bytes + bytes > MAX_BYTES) throw new TypeError("Outbox capacity reached; no entry was discarded. Inspect deliveries and archive this dedicated queue after all pending work is resolved.");
    const key = hash(JSON.stringify([baseUrl, batch.sourceId, batch.receiptId])), now = Date.now();
    db.prepare("INSERT INTO deliveries VALUES(?,?,?,?,?,?,?,'pending',0,?,?,?,NULL,NULL,NULL,NULL,NULL)")
      .run(key, baseUrl, batch.sourceId, batch.receiptId, digest, body, bytes, now, now, now);
    return { id: key, state: "pending", duplicate: false };
  });
  const claim = db.transaction((baseUrl, source) => {
    const now = Date.now();
    // Failed rows are also the durable origin/source cooldown ledger. Keep the
    // existing v1 schema: newly queued work and another worker/restart must honor
    // the same backoff, including a Retry-After that blocked the original row.
    // Check before housekeeping can replace an expired row's error metadata.
    if (db.prepare("SELECT 1 FROM deliveries WHERE base_url=? AND source_id=? AND next_at>? AND (error_code='network-unavailable' OR status IN (429,502,503,504)) LIMIT 1").get(baseUrl, source, now)) return null;
    db.prepare("UPDATE deliveries SET state='blocked',claim=NULL,lease_until=NULL,error_code='delivery-expired',updated_at=? WHERE base_url=? AND source_id=? AND state IN ('pending','inflight') AND created_at<?").run(now, baseUrl, source, now - MAX_AGE_MS);
    db.prepare("UPDATE deliveries SET state='pending',claim=NULL,lease_until=NULL WHERE base_url=? AND source_id=? AND state='inflight' AND lease_until<=?").run(baseUrl, source, now);
    db.prepare("UPDATE deliveries SET state='blocked',error_code='attempts-exhausted',updated_at=? WHERE base_url=? AND source_id=? AND state='pending' AND attempts>=?").run(now, baseUrl, source, MAX_ATTEMPTS);
    const row = db.prepare("SELECT * FROM deliveries WHERE base_url=? AND source_id=? AND state='pending' AND next_at<=? ORDER BY created_at,id LIMIT 1").get(baseUrl, source, now);
    if (!row) return null;
    const key = crypto.randomUUID();
    db.prepare("UPDATE deliveries SET state='inflight',claim=?,lease_until=?,attempts=attempts+1,updated_at=? WHERE id=?").run(key, now + LEASE_MS, now, row.id);
    return { ...row, claim: key, attempts: row.attempts + 1 };
  });
  return Object.freeze({
    enqueue: (batch, baseUrl = "http://127.0.0.1:8080") => enqueue.immediate(batch, baseUrl),
    list(options = {}) {
      if (!options || typeof options !== "object" || Array.isArray(options)
          || Object.keys(options).some(key => !["state", "sourceId", "offset", "limit"].includes(key))) throw new TypeError("Use only state, sourceId, offset and limit for outbox status.");
      const { state, sourceId: source, offset = 0, limit = 100 } = options;
      if (state !== undefined && !["pending", "inflight", "blocked", "delivered"].includes(state)) throw new TypeError("Status state must be pending, inflight, blocked or delivered.");
      if (source !== undefined) sourceId(source);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_ENTRIES) throw new TypeError("Status offset must be an integer from 0 through 10000.");
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError("Status limit must be an integer from 1 through 100.");
      const clauses = [], values = [];
      if (state !== undefined) { clauses.push("state=?"); values.push(state); }
      if (source !== undefined) { clauses.push("source_id=?"); values.push(source); }
      const where = clauses.length ? " WHERE " + clauses.join(" AND ") : "";
      const total = db.prepare("SELECT count(*) AS count FROM deliveries" + where).get(...values).count;
      const entries = db.prepare("SELECT id,base_url AS baseUrl,source_id AS sourceId,state,attempts,created_at AS createdAt,next_at AS nextAttemptAt,error_code AS errorCode,status FROM deliveries" + where + " ORDER BY created_at DESC,id LIMIT ? OFFSET ?").all(...values, limit, offset);
      const hasMore = offset + entries.length < total;
      return { limits: { entries: MAX_ENTRIES, pendingBytes: MAX_BYTES, attempts: MAX_ATTEMPTS, ageDays: 7 },
        // Global totals remain available even when the entry page is filtered.
        totals: db.prepare("SELECT state,count(*) AS entries,coalesce(sum(bytes),0) AS bytes FROM deliveries GROUP BY state ORDER BY state").all(),
        filters: { state: state ?? null, sourceId: source ?? null },
        page: { offset, limit, total, returned: entries.length, hasMore, nextOffset: hasMore ? offset + entries.length : null }, entries };
    },
    retry(entryId) {
      const now = Date.now();
      // Explicitly retrying a blocked row does not cancel a server cooldown.
      // Keep the last failure metadata until acknowledgement so claim can see it.
      const result = db.prepare("UPDATE deliveries SET state='pending',attempts=0,next_at=CASE WHEN next_at>? AND (error_code='network-unavailable' OR status IN (429,502,503,504)) THEN next_at ELSE ? END,updated_at=? WHERE id=? AND state='blocked' AND created_at>=?").run(now, now, now, id(entryId), now - MAX_AGE_MS);
      if (!result.changes) throw new TypeError("Only a blocked, unexpired delivery can be retried. Delivered or expired entries are unchanged.");
      return { id: entryId, state: "pending" };
    },
    async drain({ baseUrl = "http://127.0.0.1:8080", sourceId: source, tokenFile, limit = 10 }) {
      baseUrl = validateBaseUrl(baseUrl); sourceId(source);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError("Drain limit must be 1–100 deliveries.");
      const client = createIntegrationClient({ baseUrl, tokenFile, attempts: 1, timeoutMs: 10000 });
      const results = [];
      for (let index = 0; index < limit; index += 1) {
        const row = claim.immediate(baseUrl, source); if (!row) break;
        let batch;
        try {
          batch = savedBatch(row);
        } catch {
          db.prepare("UPDATE deliveries SET state='blocked',error_code='invalid-saved-batch',claim=NULL,lease_until=NULL WHERE id=? AND claim=?").run(row.id, row.claim);
          results.push({ id: row.id, state: "blocked", code: "invalid-saved-batch" }); continue;
        }
        try {
          const receipt = validateReceipt(await client.sendBatch(batch), batch);
          const result = db.prepare("UPDATE deliveries SET state='delivered',body=NULL,bytes=0,receipt=?,claim=NULL,lease_until=NULL,error_code=NULL,status=NULL,updated_at=? WHERE id=? AND claim=?").run(JSON.stringify(receipt), Date.now(), row.id, row.claim);
          results.push({ id: row.id, state: result.changes ? "delivered" : "lease-lost", receipt });
        } catch (error) {
          const safe = error instanceof SenderError ? error : null;
          const retryable = safe && (safe.code === "network-unavailable" || [429, 502, 503, 504].includes(safe.status));
          const wait = Math.max(1000 * (2 ** Math.min(row.attempts - 1, 10)), safe?.retryAfterMs || 0);
          const state = retryable && row.attempts < MAX_ATTEMPTS && wait <= MAX_AGE_MS ? "pending" : "blocked";
          const code = safe?.code || "delivery-failed";
          const now = Date.now(), nextAt = now + Math.min(wait, Number.MAX_SAFE_INTEGER - now);
          const result = db.prepare("UPDATE deliveries SET state=?,next_at=?,claim=NULL,lease_until=NULL,error_code=?,status=?,updated_at=? WHERE id=? AND claim=?")
            .run(state, nextAt, code, safe?.status || null, now, row.id, row.claim);
          results.push({ id: row.id, state: result.changes ? state : "lease-lost", code });
          // A source/destination failure is not permission to hammer subsequent batches.
          break;
        }
      }
      return { processed: results.length, results };
    },
    close() { db.close(); }
  });
}
module.exports = { openOutbox, MAX_ENTRIES, MAX_BYTES, MAX_ATTEMPTS, MAX_AGE_MS, LEASE_MS };
