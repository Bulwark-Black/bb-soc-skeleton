"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_DOCUMENTS = 1000;
const MAX_VERSIONS = 10000;
const MAX_AUDIT_ENTRIES = 100000;
const STATUSES = Object.freeze(["draft", "current", "needs-review", "retired"]);
const LINK_KINDS = Object.freeze(["risk", "attestation", "case", "policy"]);
const METADATA_KEYS = ["title", "appId", "owner", "status", "reviewAt", "linkKind", "linkId"];
const FILE_TYPES = /\.(?:pdf|txt|md|log|csv|tsv|xlsx|xls|docx|doc|pptx|ppt|png|jpg|jpeg|gif|webp|heic|json|zip|eml|pcap)$/i;
const DOCUMENT_ID = /^document-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

class DocumentStoreError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = "DocumentStoreError"; this.code = code; this.status = status; }
}
function fail(code, message, status) { throw new DocumentStoreError(code, message, status); }
function exact(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail("invalid-input", `${label} must be an object.`);
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !allowed.includes(key) || d.get || d.set) fail("invalid-input", `${label} contains an unsupported field.`);
  }
}
function text(value, label, maximum, empty = false) {
  if (typeof value !== "string" || value.length > maximum || (!empty && !value.trim())
      || /[\u0000-\u001f\u007f]/.test(value)) fail("invalid-input", `${label} is invalid.`);
  return value.trim();
}
function resource(value, label) {
  const result = text(value, label, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result)) fail("invalid-input", `${label} is invalid.`);
  return result;
}
function documentId(value) {
  if (typeof value !== "string" || !DOCUMENT_ID.test(value)) fail("invalid-input", "Document ID is invalid.");
  return value;
}
function integer(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail("invalid-input", `${label} is invalid.`);
  return value;
}
function date(value) {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)
      || !Number.isFinite(Date.parse(value + "T00:00:00Z"))
      || new Date(value + "T00:00:00Z").toISOString().slice(0, 10) !== value) fail("invalid-input", "Review date must be a real calendar date (YYYY-MM-DD).");
  return value;
}
function metadata(value, partial = false) {
  exact(value, METADATA_KEYS, "Document metadata");
  const result = partial ? {} : { title: "", appId: null, owner: "", status: "draft", reviewAt: null, linkKind: null, linkId: null };
  if (!partial || Object.hasOwn(value, "title")) result.title = text(value.title, "Title", 200);
  if (Object.hasOwn(value, "appId")) result.appId = value.appId === null || value.appId === "" ? null : resource(value.appId, "App ID");
  if (Object.hasOwn(value, "owner")) result.owner = text(value.owner, "Owner", 160, true);
  if (Object.hasOwn(value, "status")) {
    if (!STATUSES.includes(value.status)) fail("invalid-input", "Document status is invalid.");
    result.status = value.status;
  }
  if (Object.hasOwn(value, "reviewAt")) result.reviewAt = date(value.reviewAt);
  if (Object.hasOwn(value, "linkKind")) {
    result.linkKind = value.linkKind === "" ? null : value.linkKind;
    if (result.linkKind !== null && !LINK_KINDS.includes(result.linkKind)) fail("invalid-input", "Linked record type is invalid.");
  }
  if (Object.hasOwn(value, "linkId")) result.linkId = value.linkId === null || value.linkId === "" ? null : resource(value.linkId, "Linked record ID");
  if (!partial && Boolean(result.linkKind) !== Boolean(result.linkId)) fail("invalid-input", "Linked record type and ID must be supplied together.");
  return result;
}
function fileMetadata(filename, mime) {
  const name = text(filename, "Filename", 180);
  if (/[\\/:]/.test(name) || name === "." || name === ".." || !FILE_TYPES.test(name)) fail("invalid-input", "Choose a supported document, image, archive, email, or evidence file with a plain filename.");
  const contentType = mime || "application/octet-stream";
  if (typeof contentType !== "string" || contentType.length > 120 || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(contentType)) fail("invalid-input", "File content type is invalid.");
  return { filename: name, mime: contentType.toLowerCase() };
}
function secureDirectory(stateDir) {
  if (typeof stateDir !== "string" || !path.isAbsolute(stateDir) || stateDir !== path.resolve(stateDir)) fail("invalid-state-directory", "Document state requires an absolute normalized directory outside the repository.");
  const repository = path.resolve(__dirname, "..");
  if (stateDir === path.parse(stateDir).root || stateDir === repository || stateDir.startsWith(repository + path.sep)) fail("invalid-state-directory", "Document state must be outside the repository.");
  let cursor = path.parse(stateDir).root;
  for (const component of stateDir.slice(cursor.length).split(path.sep)) {
    cursor = path.join(cursor, component);
    if (!fs.existsSync(cursor)) fs.mkdirSync(cursor, { mode: 0o700 });
    const stat = fs.lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("invalid-state-directory", "Document state cannot use symbolic-link directories.");
  }
  const stat = fs.lstatSync(stateDir);
  if ((typeof process.getuid === "function" && stat.uid !== process.getuid()) || (stat.mode & 0o077)) fail("invalid-state-directory", "Document state directory must be private to its owner (mode 0700).");
  return path.join(stateDir, "documents.sqlite");
}
function inspectDatabaseFile(file) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077)
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())) fail("invalid-storage", "Document database files must be private regular files without links.", 503);
}

function createDocumentStore({ stateDir } = {}) {
  const databaseFile = secureDirectory(stateDir);
  for (const suffix of ["", "-wal", "-shm", "-journal"]) inspectDatabaseFile(databaseFile + suffix);
  let db;
  try {
    db = new Database(databaseFile, { timeout: 5000 });
    fs.chmodSync(databaseFile, 0o600);
    db.pragma("foreign_keys = ON");
    db.pragma("trusted_schema = OFF");
    const version = db.pragma("user_version", { simple: true });
    if (version !== 0 && version !== 1) fail("invalid-storage", "Document database version is unsupported.", 503);
    if (version === 0) {
      if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().length) fail("invalid-storage", "Unrecognized document database; no changes were made.", 503);
      db.transaction(() => {
        db.exec(`
          CREATE TABLE documents (id TEXT PRIMARY KEY, metadata TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), version_count INTEGER NOT NULL CHECK(version_count>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT);
          CREATE TABLE versions (document_id TEXT NOT NULL REFERENCES documents(id), version INTEGER NOT NULL CHECK(version>0), filename TEXT NOT NULL, mime TEXT NOT NULL, byte_length INTEGER NOT NULL CHECK(byte_length>0), sha256 TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(document_id,version));
          CREATE TABLE audit (sequence INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL REFERENCES documents(id), revision INTEGER NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL, detail TEXT NOT NULL);
          CREATE INDEX audit_document ON audit(document_id,sequence);
          CREATE TRIGGER immutable_version_update BEFORE UPDATE ON versions BEGIN SELECT RAISE(ABORT,'document versions are immutable'); END;
          CREATE TRIGGER immutable_version_delete BEFORE DELETE ON versions BEGIN SELECT RAISE(ABORT,'document versions are immutable'); END;
          CREATE TRIGGER immutable_audit_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'document audit is immutable'); END;
          CREATE TRIGGER immutable_audit_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'document audit is immutable'); END;
          PRAGMA user_version=1;
        `);
      }).immediate();
    }
    if (db.pragma("quick_check", { simple: true }) !== "ok") fail("invalid-storage", "Document database integrity check failed.", 503);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = FULL");
    for (const suffix of ["-wal", "-shm"]) if (fs.existsSync(databaseFile + suffix)) fs.chmodSync(databaseFile + suffix, 0o600);
  } catch (error) {
    if (db) db.close();
    if (error instanceof DocumentStoreError) throw error;
    fail("invalid-storage", "Document storage could not be opened safely.", 503);
  }
  let closed = false;
  const limits = Object.freeze({ maxFileBytes: MAX_FILE_BYTES, maxTotalBytes: MAX_TOTAL_BYTES, maxDocuments: MAX_DOCUMENTS, maxVersions: MAX_VERSIONS, maxList: 100 });
  function ready() { if (closed) fail("store-closed", "Document storage is closed.", 503); }
  function publicDocument(row) {
    if (!row) fail("not-found", "Document was not found.", 404);
    try {
      documentId(row.id);
      const m = metadata(JSON.parse(row.metadata));
      integer(row.revision, "Stored revision", 1, Number.MAX_SAFE_INTEGER);
      integer(row.version_count, "Stored version count", 1, MAX_VERSIONS);
      for (const at of [row.created_at, row.updated_at, row.archived_at].filter(Boolean)) if (!/^\d{4}-\d{2}-\d{2}T/.test(at) || !Number.isFinite(Date.parse(at))) throw new Error("Invalid timestamp");
      return { id: row.id, ...m, revision: row.revision, versionCount: row.version_count, createdAt: row.created_at, updatedAt: row.updated_at, archivedAt: row.archived_at };
    } catch { fail("invalid-storage", "Stored document metadata is invalid; it was not replaced.", 503); }
  }
  function load(id) { return publicDocument(db.prepare("SELECT * FROM documents WHERE id=?").get(documentId(id))); }
  function revision(current, expected) {
    integer(expected, "Expected revision", 0, Number.MAX_SAFE_INTEGER);
    if (current.revision !== expected) fail("revision-conflict", "This document changed. Reload it before saving.", 409);
  }
  function writable(current) { if (current.archivedAt) fail("document-archived", "Restore this document before changing it.", 409); }
  function audit(id, rev, action, actor, at, detail) {
    if (db.prepare("SELECT COUNT(*) AS count FROM audit").get().count >= MAX_AUDIT_ENTRIES) fail("capacity-exceeded", "Document audit capacity is reached; no change was made.", 413);
    db.prepare("INSERT INTO audit(document_id,revision,action,actor,at,detail) VALUES(?,?,?,?,?,?)").run(id, rev, action, actor, at, JSON.stringify(detail));
  }
  function versionMetadata(row) {
    try {
      if (!row) throw new Error("missing");
      const file = fileMetadata(row.filename, row.mime);
      integer(row.version, "Stored version", 1, MAX_VERSIONS);
      integer(row.byte_length, "Stored byte length", 1, MAX_FILE_BYTES);
      if (!/^[a-f0-9]{64}$/.test(row.sha256)) throw new Error("digest");
      text(row.actor, "Stored actor", 160);
      if (!Number.isFinite(Date.parse(row.created_at))) throw new Error("time");
      return { version: row.version, ...file, byteLength: row.byte_length, sha256: row.sha256, actor: row.actor, createdAt: row.created_at };
    } catch { fail("invalid-storage", "Stored document version metadata is invalid.", 503); }
  }
  function list(options = {}) {
    ready(); exact(options, ["archived", "appId", "offset", "limit"], "List options");
    const archived = options.archived || "active";
    if (!["active", "archived", "all"].includes(archived)) fail("invalid-input", "Document archive filter is invalid.");
    const offset = integer(options.offset === undefined ? 0 : options.offset, "List offset", 0, MAX_DOCUMENTS);
    const limit = integer(options.limit === undefined ? 50 : options.limit, "List limit", 1, 100);
    const appId = options.appId === undefined ? undefined : resource(options.appId, "App ID");
    // Metadata validation precedes filtering so corruption cannot masquerade as an empty app.
    const all = db.prepare("SELECT * FROM documents ORDER BY updated_at DESC,id LIMIT ?").all(MAX_DOCUMENTS + 1);
    if (all.length > MAX_DOCUMENTS) fail("invalid-storage", "Document count exceeds the storage limit.", 503);
    const filtered = all.map(publicDocument).filter((d) => (archived === "all" || Boolean(d.archivedAt) === (archived === "archived")) && (appId === undefined || d.appId === appId));
    return { documents: filtered.slice(offset, offset + limit), total: filtered.length, nextOffset: offset + limit < filtered.length ? offset + limit : null, limits };
  }
  function get(id) {
    ready();
    return db.transaction(() => {
      const document = load(id);
      const rows = db.prepare("SELECT version,filename,mime,byte_length,sha256,actor,created_at FROM versions WHERE document_id=? ORDER BY version DESC LIMIT ?").all(id, MAX_VERSIONS + 1);
      if (rows.length !== document.versionCount || rows.some((v, i) => v.version !== document.versionCount - i)) fail("invalid-storage", "Document version history is incomplete.", 503);
      const history = db.prepare("SELECT sequence,revision,action,actor,at,detail FROM audit WHERE document_id=? ORDER BY sequence DESC LIMIT 200").all(id).map((row) => {
        let detail; try { detail = JSON.parse(row.detail); } catch { fail("invalid-storage", "Document audit is unreadable.", 503); }
        return { sequence: row.sequence, revision: row.revision, action: row.action, actor: row.actor, at: row.at, detail };
      });
      return { document, versions: rows.map(versionMetadata), history, historyLimit: 200 };
    })();
  }
  function upload(input) {
    ready(); exact(input, ["documentId", "expectedRevision", "metadata", "filename", "mime", "bytes", "actor"], "Upload");
    if (!Buffer.isBuffer(input.bytes) || !input.bytes.length || input.bytes.length > MAX_FILE_BYTES) fail("invalid-file", "Upload a non-empty file no larger than 10 MiB.", 413);
    const bytes = Buffer.from(input.bytes), file = fileMetadata(input.filename, input.mime);
    const actor = text(input.actor, "Actor", 160), expected = integer(input.expectedRevision, "Expected revision", 0, Number.MAX_SAFE_INTEGER);
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    return db.transaction(() => {
      const existing = input.documentId !== undefined;
      const current = existing ? load(input.documentId) : null;
      if (current) { revision(current, expected); writable(current); if (input.metadata !== undefined) fail("invalid-input", "Update metadata separately before uploading a new version."); }
      else if (expected !== 0) fail("revision-conflict", "A new document must use revision zero.", 409);
      const m = current ? metadata(Object.fromEntries(METADATA_KEYS.map((key) => [key, current[key]]))) : metadata(input.metadata);
      const totals = db.prepare("SELECT COUNT(*) AS count,COALESCE(SUM(byte_length),0) AS bytes FROM versions").get();
      if (totals.count >= MAX_VERSIONS || totals.bytes + bytes.length > MAX_TOTAL_BYTES
          || (!current && db.prepare("SELECT COUNT(*) AS count FROM documents").get().count >= MAX_DOCUMENTS)) fail("capacity-exceeded", "Document storage capacity is reached; no file was saved.", 413);
      const id = current ? current.id : "document-" + crypto.randomUUID();
      const version = current ? current.versionCount + 1 : 1, rev = expected + 1, at = new Date().toISOString();
      if (current) db.prepare("UPDATE documents SET revision=?,version_count=?,updated_at=? WHERE id=?").run(rev, version, at, id);
      else db.prepare("INSERT INTO documents(id,metadata,revision,version_count,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(id, JSON.stringify(m), rev, version, at, at);
      db.prepare("INSERT INTO versions(document_id,version,filename,mime,byte_length,sha256,actor,created_at,bytes) VALUES(?,?,?,?,?,?,?,?,?)").run(id, version, file.filename, file.mime, bytes.length, sha256, actor, at, bytes);
      audit(id, rev, current ? "version.uploaded" : "document.created", actor, at, { version, ...file, byteLength: bytes.length, sha256, ...(current ? {} : { metadata: m }) });
      return get(id);
    }).immediate();
  }
  function update(input) {
    ready(); exact(input, ["id", "expectedRevision", "patch", "actor"], "Metadata update");
    const patch = metadata(input.patch, true), actor = text(input.actor, "Actor", 160);
    if (!Object.keys(patch).length) fail("invalid-input", "Choose metadata to update.");
    return db.transaction(() => {
      const current = load(input.id); revision(current, input.expectedRevision); writable(current);
      const before = Object.fromEntries(METADATA_KEYS.map((key) => [key, current[key]]));
      const after = metadata({ ...before, ...patch });
      const rev = current.revision + 1, at = new Date().toISOString();
      db.prepare("UPDATE documents SET metadata=?,revision=?,updated_at=? WHERE id=?").run(JSON.stringify(after), rev, at, current.id);
      audit(current.id, rev, "metadata.updated", actor, at, { before, after });
      return get(current.id);
    }).immediate();
  }
  function lifecycle(input, archived) {
    ready(); exact(input, ["id", "expectedRevision", "reason", "actor"], "Document lifecycle change");
    const actor = text(input.actor, "Actor", 160), reason = input.reason === undefined ? "" : text(input.reason, "Reason", 500, true);
    return db.transaction(() => {
      const current = load(input.id); revision(current, input.expectedRevision);
      if (Boolean(current.archivedAt) === archived) fail("invalid-transition", archived ? "Document is already archived." : "Document is already active.", 409);
      const rev = current.revision + 1, at = new Date().toISOString();
      db.prepare("UPDATE documents SET archived_at=?,revision=?,updated_at=? WHERE id=?").run(archived ? at : null, rev, at, current.id);
      audit(current.id, rev, archived ? "document.archived" : "document.restored", actor, at, { reason });
      return get(current.id);
    }).immediate();
  }
  function download({ id, version } = {}) {
    ready(); documentId(id); integer(version, "Version", 1, MAX_VERSIONS); load(id);
    const row = db.prepare("SELECT version,filename,mime,byte_length,sha256,actor,created_at,length(bytes) AS stored_byte_length,substr(bytes,1,?) AS bytes FROM versions WHERE document_id=? AND version=?").get(MAX_FILE_BYTES + 1, id, version);
    if (!row) fail("not-found", "Document version was not found.", 404);
    const v = versionMetadata(row);
    if (!Buffer.isBuffer(row.bytes) || row.stored_byte_length !== v.byteLength || row.bytes.length !== v.byteLength || crypto.createHash("sha256").update(row.bytes).digest("hex") !== v.sha256) fail("integrity-failed", "Document bytes do not match their saved hash; download was refused.", 503);
    return { ...v, bytes: row.bytes };
  }
  return Object.freeze({ list, get, upload, update, archive: (input) => lifecycle(input, true), restore: (input) => lifecycle(input, false), download, limits,
    close() { if (!closed) { db.close(); closed = true; } } });
}

module.exports = { createDocumentStore, DocumentStoreError, MAX_FILE_BYTES, MAX_TOTAL_BYTES, MAX_DOCUMENTS, MAX_VERSIONS, STATUSES, LINK_KINDS };
