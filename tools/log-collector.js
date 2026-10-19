"use strict";

// Bounded, externally scheduled file reader. Durable queue acceptance, not an
// HTTP response, is the checkpoint boundary; the queue remains operator-owned.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");
const { openOutbox } = require("./integration-outbox");
const { prepareBatch, readSourceTokenFile } = require("./integration-client");
const { validateBaseUrl } = require("./agent-mcp");
const { validateNormalizedRecord, validateTimestamp } = require("./ingest-contract");
const { createCollectionRecord } = require("./log-collection-contract");
const ROOT = fs.realpathSync(path.resolve(__dirname, ".."));
const MAX_READ_BYTES = 1024 * 1024, MAX_LINE_BYTES = 16384, MAX_RECORDS = 100, ANCHOR_BYTES = 512;
const FORMATS = Object.freeze(["plain", "docker-json", "journald-json"]);
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const uid = () => typeof process.getuid !== "function" ? null : process.getuid();
const integer = value => Number.isSafeInteger(value) && value >= 0;
class CollectorError extends Error {
  constructor(code, message = "Collection could not complete safely; inspect the private input and collector state.") {
    super(message); this.name = "CollectorError"; this.code = code;
  }
}
const fail = (code, message) => { throw new CollectorError(code, message); };
function absolute(filename) {
  if (typeof filename !== "string" || !path.isAbsolute(filename) || filename !== path.resolve(filename)
      || filename === path.parse(filename).root) fail("invalid-options", "Use canonical absolute file and directory paths.");
  return filename;
}
function noLinks(filename, create = false) {
  absolute(filename); let current = path.parse(filename).root;
  for (const part of filename.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    let stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat && create) { fs.mkdirSync(current, { mode: 0o700 }); stat = fs.lstatSync(current); }
    if (!stat || stat.isSymbolicLink()) fail("unsafe-path", "Input and state paths cannot contain symbolic links.");
  }
}
function privateFile(filename, allowMissing = false) {
  const stat = fs.lstatSync(filename, { throwIfNoEntry: false });
  if (!stat && allowMissing) return null;
  if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077)
      || (uid() !== null && stat.uid !== uid())) fail("unsafe-state", "Collector files must be owner-only regular files without links.");
  return stat;
}
function privateDirectory(directory) {
  absolute(directory);
  if (directory === ROOT || directory.startsWith(ROOT + path.sep)) fail("unsafe-state", "Collector state must be outside the checkout.");
  noLinks(directory, true); const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.mode & 0o077 || (uid() !== null && stat.uid !== uid())) fail("unsafe-state", "Collector state directory must be owned by this user with mode 0700.");
  const allowed = new Set(["collector.sqlite", "collector.sqlite-wal", "collector.sqlite-shm", "collector.sqlite-journal", "identity"]);
  if (fs.readdirSync(directory).some(name => !allowed.has(name))) fail("unsafe-state", "Use a dedicated collector state directory separate from inputs, tokens and outbox.");
}
function validateOptions(value, preview = false) {
  const allowed = ["file", "format", "sourceId", "estateId", "reviewedInput", "maxRecords", ...(preview ? [] : ["stateDirectory", "outboxDirectory", "tokenFile", "baseUrl"])];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) fail("invalid-options");
  if (value.reviewedInput !== true) fail("input-review-required", "Review and redact the input first, then supply --reviewed-input; content is retained and no automatic redaction is performed.");
  for (const key of ["sourceId", "estateId"]) if (typeof value[key] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value[key])) fail("invalid-options", "Source and application identifiers are required.");
  if (!FORMATS.includes(value.format)) fail("invalid-options", "Format must be plain, docker-json or journald-json.");
  const options = { ...value, file: absolute(value.file), maxRecords: value.maxRecords === undefined ? MAX_RECORDS : value.maxRecords };
  if (!Number.isSafeInteger(options.maxRecords) || options.maxRecords < 1 || options.maxRecords > MAX_RECORDS) fail("invalid-options", "Maximum records must be from 1 through 100.");
  if (!preview) {
    for (const key of ["stateDirectory", "outboxDirectory", "tokenFile"]) absolute(options[key]);
    const paths = [options.stateDirectory, options.outboxDirectory];
    if (paths.some((directory, index) => paths.some((other, otherIndex) => index !== otherIndex && (directory === other || directory.startsWith(other + path.sep)))
        || [options.file, options.tokenFile].some(file => file === directory || file.startsWith(directory + path.sep)))) fail("invalid-options", "Input, token, collector state and outbox must use separate locations.");
    try { options.baseUrl = validateBaseUrl(options.baseUrl || "http://127.0.0.1:8080"); readSourceTokenFile(options.tokenFile); }
    catch { fail("invalid-options", "Use a supported private destination and an owner-only external source token file."); }
  }
  return options;
}
function readAt(fd, offset, length) {
  const buffer = Buffer.alloc(length); let used = 0;
  while (used < length) { const count = fs.readSync(fd, buffer, used, length - used, offset + used); if (!count) fail("input-changed"); used += count; }
  return buffer;
}
function cursorAt(fd, stat, offset) {
  const length = Math.min(offset, ANCHOR_BYTES);
  return { dev: String(stat.dev), ino: String(stat.ino), offset,
    anchor: hash(readAt(fd, offset - length, length)), prefix: hash(readAt(fd, 0, length)) };
}
function validCursor(cursor) {
  return cursor && Object.keys(cursor).sort().join() === "anchor,dev,ino,offset,prefix" && integer(cursor.offset)
    && [cursor.dev, cursor.ino].every(value => typeof value === "string" && /^\d{1,30}$/.test(value))
    && [cursor.anchor, cursor.prefix].every(value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value));
}
function sameCursor(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function openInput(filename) {
  let fd;
  try {
    noLinks(filename); const named = fs.lstatSync(filename);
    // O_NONBLOCK prevents a replacement FIFO from blocking between lstat/open.
    fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== named.dev || stat.ino !== named.ino || !integer(stat.size)) fail("input-unavailable");
    return { fd, stat };
  } catch (error) { if (fd !== undefined) fs.closeSync(fd); if (error instanceof CollectorError && error.code === "input-changed") throw error; fail("input-unavailable", "Input must be an accessible regular file without links."); }
}
function structuredTime(value) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(value)) fail("invalid-line");
  const normalized = value.replace(/\.(\d{3})\d+(Z|[+-]\d\d:\d\d)$/, ".$1$2");
  try { validateTimestamp(normalized, "source timestamp"); return new Date(normalized).toISOString(); } catch { fail("invalid-line"); }
}
function normalizeLine(bytes, options, identity, offset, observedAt) {
  let line; try { line = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { fail("invalid-line"); }
  if (line.endsWith("\r")) line = line.slice(0, -1);
  let message = line, timestamp = observedAt;
  const fields = { format: options.format, timestampOrigin: options.format === "plain" ? "collection-time" : "source-time" };
  if (options.format !== "plain") {
    let value; try { value = JSON.parse(line); } catch { fail("invalid-line"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid-line");
    if (options.format === "docker-json") {
      if (typeof value.log !== "string" || !["stdout", "stderr"].includes(value.stream)) fail("invalid-line");
      message = value.log; timestamp = structuredTime(value.time); fields.stream = value.stream;
      fields.sourceTimestamp = value.time;
    } else {
      if (typeof value.MESSAGE !== "string" || typeof value.__REALTIME_TIMESTAMP !== "string" || !/^\d{1,20}$/.test(value.__REALTIME_TIMESTAMP)) fail("invalid-line");
      const millis = BigInt(value.__REALTIME_TIMESTAMP) / 1000n;
      if (millis > 253402300799999n) fail("invalid-line");
      timestamp = new Date(Number(millis)).toISOString(); message = value.MESSAGE;
      fields.sourceTimestamp = value.__REALTIME_TIMESTAMP;
    }
  }
  if (typeof message !== "string" || !message.trim() || message.includes("\u0000")) fail("invalid-line");
  if (message.length > 4000) fail("line-too-long");
  try {
    return validateNormalizedRecord({ schemaVersion: "1", documentType: "normalized-record", recordId: "log-" + hash(JSON.stringify([options.sourceId, identity.dev, identity.ino, offset, hash(bytes)])),
      sourceId: options.sourceId, estateId: options.estateId, kind: "log.event", observedAt: timestamp,
      payload: { title: "Server log event", state: "unknown", category: "server-log", message, fields } });
  } catch { fail("invalid-line"); }
}
function readChunk(options, cursor) {
  const { fd, stat } = openInput(options.file);
  try {
    const start = cursor || cursorAt(fd, stat, 0);
    if (!validCursor(start) || start.dev !== String(stat.dev) || start.ino !== String(stat.ino) || stat.size < start.offset
        || !sameCursor(start, cursorAt(fd, stat, start.offset))) fail("input-changed", "Input was truncated, replaced or changed before its checkpoint; automatic rotation recovery is not supported.");
    const length = Math.min(MAX_READ_BYTES, stat.size - start.offset), bytes = readAt(fd, start.offset, length);
    const records = []; let consumed = 0, encodedBytes = 0;
    const observedAt = new Date().toISOString();
    while (consumed < length && records.length < options.maxRecords) {
      const end = bytes.indexOf(10, consumed);
      if (end === -1) {
        if (length - consumed > MAX_LINE_BYTES) fail("line-too-long");
        if (start.offset + length < stat.size && records.length) break;
        fail("invalid-line", "The input contains an incomplete line; append its newline and retry without resetting state.");
      }
      if (end - consumed > MAX_LINE_BYTES) fail("line-too-long");
      const record = normalizeLine(bytes.subarray(consumed, end), options, start, start.offset + consumed, observedAt);
      const size = Buffer.byteLength(JSON.stringify(record));
      if (encodedBytes + size > 850000 && records.length) break;
      records.push(record); encodedBytes += size; consumed = end + 1;
    }
    const after = fs.fstatSync(fd), named = fs.lstatSync(options.file, { throwIfNoEntry: false });
    if (!named || !named.isFile() || named.isSymbolicLink() || after.nlink !== 1 || named.dev !== stat.dev || named.ino !== stat.ino || after.size < stat.size
        || (after.size === stat.size && (after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs))
        || !bytes.equals(readAt(fd, start.offset, length)) || !sameCursor(start, cursorAt(fd, after, start.offset))) fail("input-changed");
    const nextCursor = cursorAt(fd, after, start.offset + consumed);
    return { records, nextCursor, complete: start.offset + consumed === after.size, snapshotBytes: stat.size, readBytes: consumed };
  } finally { fs.closeSync(fd); }
}
function collectionProof(options, { ok, linesRead = 0, error = null }) {
  return createCollectionRecord({ sourceId: options.sourceId, estateId: options.estateId, recordId: "collection-" + crypto.randomUUID(), observedAt: new Date().toISOString(),
    inputsPlanned: 1, inputsRead: ok ? 1 : 0, linesRead, linesDropped: 0, ok, error });
}
function previewLog(options) {
  options = validateOptions(options, true);
  const chunk = readChunk({ ...options, maxRecords: 1 }, null);
  return chunk.records[0] || collectionProof(options, { ok: true });
}
function syncDirectory(directory) { const fd = fs.openSync(directory, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function openState(options) {
  privateDirectory(options.stateDirectory);
  const filename = path.join(options.stateDirectory, "collector.sqlite"), marker = path.join(options.stateDirectory, "identity");
  const known = privateFile(filename, true), markerStat = privateFile(marker, true);
  for (const suffix of ["-wal", "-shm", "-journal"]) privateFile(filename + suffix, true);
  let identity;
  if (!!known !== !!markerStat) fail("state-lost", "Collector state is incomplete; preserve it for operator recovery instead of resetting the checkpoint.");
  if (!known) {
    identity = crypto.randomUUID(); const fd = fs.openSync(marker, "wx", 0o600);
    try { fs.writeFileSync(fd, identity); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    syncDirectory(options.stateDirectory);
    const dbfd = fs.openSync(filename, "wx", 0o600); fs.closeSync(dbfd);
  } else {
    if (markerStat.size !== 36) fail("invalid-state");
    identity = fs.readFileSync(marker, "utf8"); if (!/^[a-f0-9-]{36}$/.test(identity)) fail("invalid-state");
  }
  const db = new Database(filename);
  try {
    db.pragma("trusted_schema=OFF"); db.pragma("busy_timeout=1000"); db.pragma("synchronous=FULL");
    if (!known) {
      db.exec("CREATE TABLE collector (id INTEGER PRIMARY KEY CHECK(id=1), identity TEXT NOT NULL, config TEXT NOT NULL, cursor TEXT, cursor_hash TEXT, pending TEXT, pending_hash TEXT, lock_pid INTEGER, lock_token TEXT) STRICT");
      db.prepare("INSERT INTO collector VALUES(1,?,?,NULL,NULL,NULL,NULL,NULL,NULL)").run(identity, JSON.stringify({ file: options.file, format: options.format, sourceId: options.sourceId,
        estateId: options.estateId, baseUrl: options.baseUrl, outboxDirectory: options.outboxDirectory, queue: null }));
      syncDirectory(options.stateDirectory);
    }
    const schema = db.prepare("SELECT type,name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
    if (schema.length !== 1 || schema[0].type !== "table" || schema[0].name !== "collector" || db.pragma("quick_check", { simple: true }) !== "ok"
        || db.prepare("SELECT count(*) AS count FROM collector").get().count !== 1) fail("invalid-state");
    const row = db.prepare("SELECT * FROM collector WHERE id=1").get();
    if (!row || row.identity !== identity || Object.keys(row).sort().join() !== "config,cursor,cursor_hash,id,identity,lock_pid,lock_token,pending,pending_hash") fail("invalid-state");
    return db;
  } catch (error) { db.close(); if (error instanceof CollectorError) throw error; fail("invalid-state"); }
}
function binding(options) { return { file: options.file, format: options.format, sourceId: options.sourceId, estateId: options.estateId, baseUrl: options.baseUrl, outboxDirectory: options.outboxDirectory }; }
function decodeState(row, options) {
  try {
    const config = JSON.parse(row.config);
    if (Object.keys(config).sort().join() !== "baseUrl,estateId,file,format,outboxDirectory,queue,sourceId" || Object.entries(binding(options)).some(([key, value]) => config[key] !== value)) fail("binding-changed", "Use the same input, format, source, application, destination and outbox for this checkpoint.");
    if (config.queue !== null && (!config.queue || Object.keys(config.queue).sort().join() !== "dev,ino" || ![config.queue.dev, config.queue.ino].every(value => /^\d{1,30}$/.test(value)))) fail("invalid-state");
    let cursor = null, pending = null;
    if (row.cursor !== null) { if (hash(row.cursor) !== row.cursor_hash) fail("invalid-state"); cursor = JSON.parse(row.cursor); if (!validCursor(cursor)) fail("invalid-state"); }
    else if (row.cursor_hash !== null) fail("invalid-state");
    if (row.pending !== null) {
      if (typeof row.pending !== "string" || row.pending.length > 2 * 1024 * 1024 || hash(row.pending) !== row.pending_hash) fail("invalid-state");
      pending = JSON.parse(row.pending);
      if (Object.keys(pending).sort().join() !== "batch,complete,cursor,error,lines" || (pending.cursor !== null && !validCursor(pending.cursor)) || typeof pending.complete !== "boolean"
          || !integer(pending.lines) || (pending.error !== null && !["input-unavailable", "input-changed", "invalid-line", "line-too-long", "collection-failed"].includes(pending.error))) fail("invalid-state");
      const batch = prepareBatch(pending.batch).batch;
      if (batch.sourceId !== options.sourceId || batch.records.some(record => record.estateId !== options.estateId)) fail("invalid-state");
    } else if (row.pending_hash !== null) fail("invalid-state");
    if ((row.lock_pid === null) !== (row.lock_token === null) || (row.lock_pid !== null && (!Number.isSafeInteger(row.lock_pid) || row.lock_pid < 1 || !/^[a-f0-9-]{36}$/.test(row.lock_token)))) fail("invalid-state");
    return { config, cursor, pending };
  } catch (error) { if (error instanceof CollectorError) throw error; fail("invalid-state"); }
}
function lockState(db, options) {
  const token = crypto.randomUUID();
  db.transaction(() => {
    const row = db.prepare("SELECT * FROM collector WHERE id=1").get(); decodeState(row, options);
    if (row.lock_pid !== null) {
      let alive = true; try { process.kill(row.lock_pid, 0); } catch (error) { if (error.code === "ESRCH") alive = false; }
      if (alive) fail("collector-busy", "Another collector owns this checkpoint; do not run overlapping schedules.");
    }
    db.prepare("UPDATE collector SET lock_pid=?,lock_token=? WHERE id=1").run(process.pid, token);
  }).immediate();
  return token;
}
function queueStatus(queue, options) {
  let offset = 0, outstanding = 0;
  do {
    const page = queue.list({ offset, limit: 100 });
    for (const entry of page.entries) {
      if (entry.sourceId !== options.sourceId || entry.baseUrl !== options.baseUrl) {
        fail("outbox-binding-changed", "Use a dedicated outbox for exactly this source and destination.");
      }
      if (entry.state !== "delivered") outstanding++;
    }
    if (!page.page.hasMore) return outstanding;
    offset = page.page.nextOffset;
  } while (offset <= 10000);
  fail("invalid-state");
}
function collectLogChunk(input) {
  const options = validateOptions(input); const db = openState(options); let queue, lock;
  try {
    lock = lockState(db, options);
    let state = decodeState(db.prepare("SELECT * FROM collector WHERE id=1").get(), options);
    const queueFile = path.join(options.outboxDirectory, "outbox.sqlite");
    if (state.config.queue) {
      noLinks(queueFile); const existing = privateFile(queueFile);
      if (String(existing.dev) !== state.config.queue.dev || String(existing.ino) !== state.config.queue.ino) fail("outbox-changed", "The checkpoint's durable outbox is missing or replaced; restore it before collecting again.");
    }
    queue = openOutbox(options.outboxDirectory);
    const outstanding = queueStatus(queue, options);
    if (!state.config.queue) {
      const stat = privateFile(queueFile); state.config.queue = { dev: String(stat.dev), ino: String(stat.ino) };
      db.prepare("UPDATE collector SET config=? WHERE id=1").run(JSON.stringify(state.config));
    }
    // Drain prior deliveries before reading farther. The shared outbox permits
    // explicitly blocked entries; a later success proof must never overtake
    // an undelivered log chunk and paint incomplete delivery green.
    if (!state.pending && outstanding > 0) {
      return { complete: false, error: null, lines: 0, recovered: false, queued: null,
        queueState: "pending", offset: state.cursor?.offset || 0 };
    }
    const recovered = !!state.pending;
    if (!state.pending) {
      let chunk, error = null;
      try { chunk = readChunk(options, state.cursor); }
      catch (cause) {
        error = cause instanceof CollectorError && ["input-unavailable", "input-changed", "invalid-line", "line-too-long"].includes(cause.code) ? cause.code : "collection-failed";
        chunk = { records: [], nextCursor: state.cursor, complete: false };
      }
      const records = [...chunk.records];
      if (chunk.complete || error) records.push(collectionProof(options, { ok: chunk.complete, linesRead: chunk.records.length, error }));
      if (!records.length) return { complete: false, error: null, lines: 0, recovered: false,
        queued: null, queueState: "pending", offset: state.cursor?.offset || 0 };
      const batch = prepareBatch({ schemaVersion: "1", documentType: "ingest-batch", sourceId: options.sourceId,
        receiptId: "log-collection-" + crypto.randomUUID(), sentAt: new Date().toISOString(), records }).batch;
      state.pending = { batch, cursor: chunk.nextCursor, complete: chunk.complete, error, lines: chunk.records.length };
      const pending = JSON.stringify(state.pending);
      db.prepare("UPDATE collector SET pending=?,pending_hash=? WHERE id=1").run(pending, hash(pending));
    }
    // A crash on either side of enqueue replays this exact persisted batch.
    // enqueue is idempotent and fsync-backed. Never read new bytes first.
    const queued = queue.enqueue(state.pending.batch, options.baseUrl);
    const cursor = state.pending.cursor === null ? null : JSON.stringify(state.pending.cursor);
    db.prepare("UPDATE collector SET cursor=?,cursor_hash=?,pending=NULL,pending_hash=NULL WHERE id=1").run(cursor, cursor === null ? null : hash(cursor));
    return { complete: state.pending.complete, error: state.pending.error, lines: state.pending.lines, recovered,
      queued: queued.id, queueState: queued.state, offset: state.pending.cursor?.offset || 0 };
  } catch (error) { if (error instanceof CollectorError) throw error; fail("state-or-queue-failed", "Collection state or durable enqueue failed; the saved batch and checkpoint were retained for retry."); }
  finally {
    if (queue) queue.close();
    if (lock) { try { db.prepare("UPDATE collector SET lock_pid=NULL,lock_token=NULL WHERE id=1 AND lock_token=?").run(lock); } catch { /* A dead process lock can be recovered on restart. */ } }
    db.close();
  }
}
async function runLogCollector(input) {
  const options = validateOptions(input), collection = collectLogChunk(options);
  const queue = openOutbox(options.outboxDirectory);
  try {
    queueStatus(queue, options);
    const delivery = await queue.drain({ baseUrl: options.baseUrl, sourceId: options.sourceId, tokenFile: options.tokenFile, limit: 100 });
    const pending = queueStatus(queue, options);
    return { ...collection, delivered: delivery.results.filter(row => row.state === "delivered").length, pendingDeliveries: pending };
  } finally { queue.close(); }
}
module.exports = { CollectorError, FORMATS, MAX_READ_BYTES, MAX_LINE_BYTES, MAX_RECORDS, previewLog, collectLogChunk, runLogCollector };
