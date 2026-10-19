"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), Database = require("better-sqlite3");
const { openOutbox } = require("../integration-outbox");
const { prepareBatch } = require("../integration-client");
const { normalizeVendorPayload } = require("../vendor-adapters");
const { CollectorError, fail, hash, privateDirectory, validateConfig } = require("./common");
const { transport: defaultTransport, credentials } = require("./http");
const { step } = require("./providers");
const MAX_LEDGER = 200000, MAX_PENDING_BYTES = 16 * 1024 * 1024;
const encode = JSON.stringify;
function readJson(row) {
  if (!row || typeof row.value !== "string" || row.value.length > MAX_PENDING_BYTES || hash(row.value) !== row.digest) fail("invalid-state");
  try { return JSON.parse(row.value); } catch { fail("invalid-state"); }
}
function openState(directory, config, outboxDirectory) {
  privateDirectory(directory); const filename = path.join(directory, "collector.sqlite"), identityPath = path.join(directory, "identity");
  const exists = fs.existsSync(filename), identityExists = fs.existsSync(identityPath);
  if (identityExists && !exists || exists && !identityExists) fail("state-identity-missing");
  if (!exists) { const fd = fs.openSync(filename, "wx", 0o600); fs.closeSync(fd); }
  const db = new Database(filename);
  try {
    db.pragma("trusted_schema=OFF"); db.pragma("busy_timeout=1000");
    if (exists) {
      const expected = new Set(["table:meta", "table:documents", "table:ledger"]);
      const schema = db.prepare("SELECT type,name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
      if (schema.length !== expected.size || schema.some(v => !expected.has(v.type + ":" + v.name)) || db.pragma("quick_check", { simple: true }) !== "ok") fail("invalid-state");
      const columns = { meta: ["id", "version", "pin", "identity", "lease", "lease_until"], documents: ["name", "value", "digest"], ledger: ["key", "fingerprint", "at"] };
      for (const [table, names] of Object.entries(columns)) if (encode(db.pragma(`table_info(${table})`).map(v => v.name)) !== encode(names)) fail("invalid-state");
    }
    db.pragma("journal_mode=WAL"); db.pragma("synchronous=FULL");
    db.exec(`CREATE TABLE IF NOT EXISTS meta(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,pin TEXT NOT NULL,identity TEXT NOT NULL,lease TEXT,lease_until INTEGER) STRICT;
      CREATE TABLE IF NOT EXISTS documents(name TEXT PRIMARY KEY,value TEXT NOT NULL,digest TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS ledger(key TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,at INTEGER NOT NULL) STRICT;`);
    for (const suffix of ["-wal", "-shm"]) if (fs.existsSync(filename + suffix)) fs.chmodSync(filename + suffix, 0o600);
    const queueStat = fs.statSync(path.join(outboxDirectory, "outbox.sqlite"), { bigint: true });
    const pin = hash({ config, outboxDirectory, queueDevice: queueStat.dev.toString(), queueInode: queueStat.ino.toString(), queueBirthtimeNs: queueStat.birthtimeNs?.toString() || null });
    if (!exists) {
      const identity = crypto.randomUUID(); db.prepare("INSERT INTO meta VALUES(1,1,?,?,NULL,NULL)").run(pin, identity);
      const fd = fs.openSync(identityPath, "wx", 0o600); try { fs.writeFileSync(fd, identity); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    const m = db.prepare("SELECT * FROM meta").get();
    if (!m || m.version !== 1 || m.pin !== pin || fs.readFileSync(identityPath, "utf8") !== m.identity || db.prepare("SELECT count(*) AS n FROM meta").get().n !== 1) fail("collector-config-or-queue-changed");
    if (db.prepare("SELECT count(*) AS n FROM ledger").get().n > MAX_LEDGER || db.prepare("SELECT count(*) AS n FROM documents").get().n > 3) fail("invalid-state");
    for (const row of db.prepare("SELECT * FROM documents").all()) { if (!["cursor", "pending", "status"].includes(row.name)) fail("invalid-state"); readJson(row); }
    return db;
  } catch (e) { db.close(); throw e; }
}
function get(db, name, fallback = {}) { const row = db.prepare("SELECT * FROM documents WHERE name=?").get(name); return row ? readJson(row) : fallback; }
function put(db, name, value) { const json = encode(value); if (Buffer.byteLength(json) > MAX_PENDING_BYTES) fail("pending-capacity"); db.prepare("INSERT INTO documents VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value,digest=excluded.digest").run(name, json, hash(json)); }
function checkQueue(queue, config) {
  const totals = { pending: 0, inflight: 0, blocked: 0, delivered: 0 }; let offset = 0;
  do {
    const page = queue.list({ offset, limit: 100 });
    for (const row of page.entries) { if (row.sourceId !== config.sourceId || row.baseUrl !== config.baseUrl) fail("outbox-not-dedicated"); totals[row.state]++; }
    offset = page.page.nextOffset;
  } while (offset !== null);
  return totals;
}
function withStores(options, work) {
  const config = validateConfig(options.config), { stateDirectory, outboxDirectory } = options;
  if (typeof stateDirectory !== "string" || typeof outboxDirectory !== "string" || stateDirectory === outboxDirectory || stateDirectory.startsWith(outboxDirectory + path.sep) || outboxDirectory.startsWith(stateDirectory + path.sep)) fail("state-outbox-overlap");
  const queue = openOutbox(outboxDirectory); let db;
  try { checkQueue(queue, config); db = openState(stateDirectory, config, outboxDirectory); }
  catch (e) { queue.close(); throw e; }
  return Promise.resolve().then(() => work({ config, db, queue })).finally(() => { db.close(); queue.close(); });
}
function acquire(db) {
  const owner = crypto.randomUUID();
  db.transaction(() => {
    const meta = db.prepare("SELECT lease,lease_until FROM meta WHERE id=1").get();
    if (meta.lease && meta.lease_until > Date.now()) fail("collector-busy");
    db.prepare("UPDATE meta SET lease=?,lease_until=? WHERE id=1").run(owner, Date.now() + 120000);
  }).immediate();
  return owner;
}
function renew(db, owner) { if (!db.prepare("UPDATE meta SET lease_until=? WHERE id=1 AND lease=? AND lease_until>=?").run(Date.now() + 120000, owner, Date.now()).changes) fail("collector-lease-lost"); }
function ledgerCheck(db, entry) {
  if (!entry || typeof entry.key !== "string" || entry.key.length > 200 || !/^[a-f0-9]{64}$/.test(entry.fingerprint) || !Number.isSafeInteger(entry.at)) fail("invalid-state");
  const old = db.prepare("SELECT fingerprint FROM ledger WHERE key=?").get(entry.key);
  if (old && old.fingerprint !== entry.fingerprint) fail("upstream-identity-conflict");
  return Boolean(old);
}
function stage(db, owner, result, config, now) {
  const records = new Map(), additions = [];
  if (result.rows?.length) for (let i = 0; i < result.rows.length; i += 10) {
    const normalized = normalizeVendorPayload(result.adapterId, result.rows.slice(i, i + 10), { sourceId: config.sourceId, estateId: config.appId });
    for (const record of normalized.batch.records) {
      const entry = { key: "record:" + hash(record.recordId), fingerprint: hash(record), at: now };
      const existing = records.get(record.recordId); if (existing && hash(existing) !== entry.fingerprint) fail("upstream-identity-conflict");
      if (!ledgerCheck(db, entry) && !existing) { records.set(record.recordId, record); additions.push(entry); }
    }
  }
  if (result.content && !ledgerCheck(db, result.content)) additions.push(result.content);
  if (db.prepare("SELECT count(*) AS n FROM ledger").get().n + additions.length > MAX_LEDGER) fail("ledger-capacity");
  const batches = [], list = [...records.values()].sort((a, b) => a.recordId.localeCompare(b.recordId));
  for (let i = 0; i < list.length; i += 10) {
    const body = { schemaVersion: "1", documentType: "ingest-batch", sourceId: config.sourceId, sentAt: new Date(now).toISOString(), records: list.slice(i, i + 10) };
    body.receiptId = "collector:" + hash(body); batches.push(prepareBatch(body).batch);
  }
  const pending = { batches, cursor: result.cursor, additions, complete: Boolean(result.complete), partialLine: Boolean(result.partialLine), at: now, records: list.length };
  db.transaction(() => { renew(db, owner); put(db, "pending", pending); }).immediate();
  return pending;
}
async function finishPending(db, queue, owner, config, fault) {
  const pending = get(db, "pending", null); if (!pending) return null;
  if (!Array.isArray(pending.batches) || !Array.isArray(pending.additions) || typeof pending.cursor !== "object" || !Number.isSafeInteger(pending.at)) fail("invalid-state");
  renew(db, owner);
  for (const batch of pending.batches) {
    if (batch.sourceId !== config.sourceId || batch.records.some(r => r.estateId !== config.appId)) fail("invalid-state");
    try { queue.enqueue(prepareBatch(batch).batch, config.baseUrl); }
    catch { fail("outbox-admission-failed"); }
  }
  if (fault) await fault("after-enqueue");
  db.transaction(() => {
    renew(db, owner);
    for (const entry of pending.additions) { ledgerCheck(db, entry); db.prepare("INSERT OR IGNORE INTO ledger VALUES(?,?,?)").run(entry.key, entry.fingerprint, entry.at); }
    put(db, "cursor", pending.cursor);
    const old = get(db, "status");
    put(db, "status", { lastAttemptAt: new Date(pending.at).toISOString(), lastCompletedAt: pending.complete ? new Date(pending.at).toISOString() : old.lastCompletedAt || null,
      error: null, nextAttemptAt: null, partialLine: pending.partialLine,
      checkpointAt: pending.cursor.watermark || null,
      lagSeconds: pending.cursor.watermark ? Math.max(0, Math.floor((pending.at - Date.parse(pending.cursor.watermark)) / 1000)) : null,
      completionScope: config.provider === "okta" ? "poll-drained-at-read" : config.provider === "checkmk" ? "configured-host-status-snapshot" : config.provider === "wazuh" ? "file-snapshot" : config.provider === "aws-cloudtrail-s3" ? "object-listing-cycle" : "provider-window" });
    db.prepare("DELETE FROM documents WHERE name='pending'").run();
  }).immediate();
  return pending;
}
async function runCollector(options) {
  return withStores(options, async ({ config, db, queue }) => {
    const owner = acquire(db), nowFn = options.now || Date.now, send = options.transport || defaultTransport;
    let steps = 0, records = 0, complete = false, partialLine = false;
    try {
      const resumed = await finishPending(db, queue, owner, config, options.fault); if (resumed) { records += resumed.records; complete = resumed.complete; }
      const initialStatus = get(db, "status"), currentNow = nowFn();
      if (initialStatus.nextAttemptAt && Date.parse(initialStatus.nextAttemptAt) > currentNow) return { ok: false, code: "provider-cooldown", status: initialStatus, queue: checkQueue(queue, config) };
      const authorization = ["wazuh", "aws-cloudtrail-s3"].includes(config.provider) || complete ? null : await credentials(config, send, currentNow);
      for (; steps < config.maxSteps && !complete; steps++) {
        renew(db, owner); const now = nowFn();
        const result = await step({ config, cursor: get(db, "cursor"), now, send, authorization, hasContent: entry => ledgerCheck(db, entry), s3Client: options.s3Client });
        if (result.idle) { complete = true; steps++; break; }
        const pending = stage(db, owner, result, config, now);
        await finishPending(db, queue, owner, config, options.fault);
        records += pending.records; complete = pending.complete; partialLine = pending.partialLine;
        if (partialLine || result.idle) { steps++; break; }
      }
      return { ok: true, steps, records, complete, partialLine, status: get(db, "status"), queue: checkQueue(queue, config) };
    } catch (e) {
      const safe = e instanceof CollectorError ? e : new CollectorError("collection-failed"), now = nowFn();
      try { db.transaction(() => { renew(db, owner); put(db, "status", { ...get(db, "status"), lastAttemptAt: new Date(now).toISOString(), error: safe.code, nextAttemptAt: safe.retryAfterMs ? new Date(now + safe.retryAfterMs).toISOString() : null }); }).immediate(); } catch { /* Preserve state if another worker owns it. */ }
      throw safe;
    } finally { db.prepare("UPDATE meta SET lease=NULL,lease_until=NULL WHERE id=1 AND lease=?").run(owner); }
  });
}
async function status(options) { return withStores(options, ({ config, db, queue }) => ({ ok: true, status: get(db, "status"), pendingCheckpoint: Boolean(get(db, "pending", null)), ledgerEntries: db.prepare("SELECT count(*) AS n FROM ledger").get().n, queue: checkQueue(queue, config) })); }
async function drain(options) { return withStores(options, async ({ config, queue }) => ({ ok: true, delivery: await queue.drain({ baseUrl: config.baseUrl, sourceId: config.sourceId, tokenFile: config.tokenFile, limit: 100 }), queue: checkQueue(queue, config) })); }
module.exports = { runCollector, status, drain, validateConfig, MAX_LEDGER };
