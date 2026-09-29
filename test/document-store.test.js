"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Database = require("better-sqlite3");
const { createDocumentStore, MAX_FILE_BYTES } = require("../server/document-store");

function harness(t) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "bb-soc-document-test-"));
  let store = createDocumentStore({ stateDir: directory });
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, get store() { return store; }, restart() { store.close(); store = createDocumentStore({ stateDir: directory }); return store; },
    sql(run) { const db = new Database(path.join(directory, "documents.sqlite")); try { return run(db); } finally { db.close(); } } };
}
function upload(store, overrides = {}) {
  return store.upload({ expectedRevision: 0, metadata: { title: "Review record", owner: "Document owner", status: "draft", appId: "app-example", reviewAt: "2026-12-01", linkKind: "policy", linkId: "policy-review" },
    filename: "review.md", mime: "text/markdown", bytes: Buffer.from("# Review\n"), actor: "operator:test", ...overrides });
}
const errorCode = (code) => (error) => error.code === code;

test("documents retain immutable versions, review metadata and audited lifecycle across restarts", (t) => {
  const h = harness(t);
  let saved = upload(h.store);
  const id = saved.document.id;
  assert.equal(saved.document.revision, 1);
  assert.equal(saved.document.reviewAt, "2026-12-01");
  assert.equal(saved.versions[0].sha256, crypto.createHash("sha256").update("# Review\n").digest("hex"));
  assert.equal(saved.history[0].actor, "operator:test");
  saved = h.store.update({ id, expectedRevision: 1, patch: { status: "current", owner: "Review owner", linkKind: "risk", linkId: "risk-example" }, actor: "operator:reviewer" });
  saved = h.store.upload({ documentId: id, expectedRevision: 2, filename: "review-v2.md", mime: "text/markdown", bytes: Buffer.from("# Updated review\n"), actor: "operator:reviewer" });
  assert.equal(saved.document.versionCount, 2);
  assert.equal(saved.document.status, "current");
  assert.deepEqual(saved.versions.map((v) => v.version), [2, 1]);
  h.restart();
  assert.equal(h.store.download({ id, version: 1 }).bytes.toString(), "# Review\n");
  assert.equal(h.store.download({ id, version: 2 }).bytes.toString(), "# Updated review\n");
  saved = h.store.archive({ id, expectedRevision: 3, reason: "Superseded", actor: "operator:reviewer" });
  assert.ok(saved.document.archivedAt);
  assert.equal(h.store.list().total, 0);
  assert.equal(h.store.list({ archived: "archived" }).total, 1);
  assert.equal(h.store.download({ id, version: 1 }).bytes.toString(), "# Review\n");
  assert.throws(() => h.store.update({ id, expectedRevision: 4, patch: { title: "Changed" }, actor: "operator:reviewer" }), errorCode("document-archived"));
  saved = h.store.restore({ id, expectedRevision: 4, actor: "operator:reviewer" });
  assert.equal(saved.document.archivedAt, null);
  assert.deepEqual(saved.history.map((entry) => entry.action), ["document.restored", "document.archived", "version.uploaded", "metadata.updated", "document.created"]);
  assert.equal(saved.history.find((entry) => entry.action === "document.archived").detail.reason, "Superseded");
  h.restart();
  assert.equal(h.store.get(id).document.revision, 5);
  for (const suffix of ["", "-wal", "-shm"]) if (fs.existsSync(path.join(h.directory, "documents.sqlite" + suffix))) assert.equal(fs.statSync(path.join(h.directory, "documents.sqlite" + suffix)).mode & 0o077, 0);
});

test("optimistic revision prevents stale concurrent writers and preserves files and history", (t) => {
  const h = harness(t), saved = upload(h.store), id = saved.document.id;
  const second = createDocumentStore({ stateDir: h.directory });
  try {
    second.update({ id, expectedRevision: 1, patch: { status: "needs-review" }, actor: "operator:second" });
    assert.throws(() => h.store.upload({ documentId: id, expectedRevision: 1, filename: "rejected.md", bytes: Buffer.from("stale"), actor: "operator:first" }), errorCode("revision-conflict"));
    assert.throws(() => h.store.update({ id, expectedRevision: 1, patch: { title: "stale" }, actor: "operator:first" }), errorCode("revision-conflict"));
    assert.throws(() => h.store.archive({ id, expectedRevision: 1, actor: "operator:first" }), errorCode("revision-conflict"));
    assert.equal(h.store.get(id).document.status, "needs-review");
    assert.equal(h.store.get(id).versions.length, 1);
    assert.equal(h.store.get(id).history.length, 2);
    assert.equal(h.store.get(id).document.archivedAt, null);
  } finally { second.close(); }
});

test("an audit failure rolls back document metadata, version bytes and creation together", (t) => {
  const h = harness(t), saved = upload(h.store), id = saved.document.id;
  h.sql((db) => db.exec("CREATE TRIGGER reject_test_audit BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT,'test audit unavailable'); END;"));
  assert.throws(() => h.store.update({ id, expectedRevision: 1, patch: { status: "current" }, actor: "operator:test" }), /test audit unavailable/);
  assert.throws(() => h.store.upload({ documentId: id, expectedRevision: 1, filename: "new.md", bytes: Buffer.from("new"), actor: "operator:test" }), /test audit unavailable/);
  assert.throws(() => upload(h.store, { metadata: { title: "Never committed" } }), /test audit unavailable/);
  assert.equal(h.store.list().total, 1);
  assert.equal(h.store.get(id).document.revision, 1);
  assert.equal(h.store.get(id).document.status, "draft");
  assert.equal(h.store.get(id).versions.length, 1);
  assert.equal(h.store.get(id).history.length, 1);
  h.restart();
  assert.equal(h.store.get(id).document.revision, 1);
});

test("uploads reject traversal, executable markup, invalid typed metadata and oversize bytes before persistence", (t) => {
  const h = harness(t);
  for (const filename of ["../file.md", "folder/file.md", "folder\\file.md", "file:stream.md", "page.html", "vector.svg", "script.js", "file\n.md"]) {
    assert.throws(() => upload(h.store, { filename }), errorCode("invalid-input"), filename);
  }
  for (const meta of [{ title: "" }, { title: "Review", reviewAt: "2026-02-30" }, { title: "Review", status: "approved" },
    { title: "Review", linkKind: "risk" }, { title: "Review", linkId: "risk-example" }, { title: "Review", appId: "../app" }, { title: "Review", extra: true }]) {
    assert.throws(() => upload(h.store, { metadata: meta }), errorCode("invalid-input"));
  }
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(MAX_FILE_BYTES + 1), "not a buffer"]) assert.throws(() => upload(h.store, { bytes }), errorCode("invalid-file"));
  assert.throws(() => upload(h.store, { mime: "text/plain\r\nX-Header: value" }), errorCode("invalid-input"));
  assert.throws(() => upload(h.store, { actor: "" }), errorCode("invalid-input"));
  assert.equal(h.store.list().total, 0);
});

test("stored content is immutable through SQL and a corrupted blob is refused on download", (t) => {
  const h = harness(t), saved = upload(h.store), id = saved.document.id;
  h.sql((db) => {
    assert.throws(() => db.prepare("UPDATE versions SET bytes=? WHERE document_id=?").run(Buffer.from("corruption"), id), /immutable/);
    assert.throws(() => db.prepare("DELETE FROM versions WHERE document_id=?").run(id), /immutable/);
    assert.throws(() => db.prepare("UPDATE audit SET actor='changed'").run(), /immutable/);
    db.exec("DROP TRIGGER immutable_version_update");
    db.prepare("UPDATE versions SET bytes=? WHERE document_id=?").run(Buffer.from("corruption"), id);
  });
  assert.throws(() => h.store.download({ id, version: 1 }), errorCode("integrity-failed"));
  assert.equal(h.store.get(id).versions[0].filename, "review.md");
});

test("malformed persisted metadata is reported instead of becoming empty or overwritten", (t) => {
  const h = harness(t), saved = upload(h.store), id = saved.document.id;
  h.sql((db) => db.prepare("UPDATE documents SET metadata=? WHERE id=?").run('{"title":', id));
  h.restart();
  assert.throws(() => h.store.list({ appId: "another-app" }), errorCode("invalid-storage"));
  assert.throws(() => h.store.get(id), errorCode("invalid-storage"));
  assert.throws(() => h.store.update({ id, expectedRevision: 1, patch: { title: "Repair by accident" }, actor: "operator:test" }), errorCode("invalid-storage"));
  assert.equal(h.sql((db) => db.prepare("SELECT metadata FROM documents WHERE id=?").get(id).metadata), '{"title":');
});

test("list pagination and app/archive scope are bounded and do not expose file bytes", (t) => {
  const h = harness(t);
  const a = upload(h.store), b = upload(h.store, { metadata: { title: "Shared record" } });
  upload(h.store, { metadata: { title: "Another application", appId: "app-other" } });
  assert.equal(h.store.list({ appId: "app-example" }).documents[0].id, a.document.id);
  const first = h.store.list({ limit: 1 });
  assert.equal(first.documents.length, 1); assert.equal(first.nextOffset, 1); assert.equal(first.total, 3);
  const second = h.store.list({ limit: 1, offset: 1 });
  assert.notEqual(second.documents[0].id, first.documents[0].id);
  assert.equal(JSON.stringify(first).includes("# Review"), false);
  assert.equal(JSON.stringify(h.store.get(a.document.id)).includes('"bytes"'), false);
  h.store.archive({ id: b.document.id, expectedRevision: 1, actor: "operator:test" });
  assert.equal(h.store.list({ archived: "archived" }).total, 1);
  assert.equal(h.store.list({ archived: "all" }).total, 3);
  for (const options of [{ limit: 101 }, { limit: 0 }, { offset: -1 }, { archived: "unknown" }, { limit: "10" }]) assert.throws(() => h.store.list(options), errorCode("invalid-input"));
});

test("document storage rejects repository locations, permissive directories and symlinked databases", (t) => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "bb-soc-document-boundary-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.throws(() => createDocumentStore({ stateDir: path.resolve(__dirname, "..") }), errorCode("invalid-state-directory"));
  assert.throws(() => createDocumentStore({ stateDir: directory + "/../other" }), errorCode("invalid-state-directory"));
  const openDir = path.join(directory, "open"); fs.mkdirSync(openDir, { mode: 0o755 });
  assert.throws(() => createDocumentStore({ stateDir: openDir }), errorCode("invalid-state-directory"));
  const privateDir = path.join(directory, "private"); fs.mkdirSync(privateDir, { mode: 0o700 });
  const linkedDir = path.join(directory, "linked"); fs.symlinkSync(privateDir, linkedDir);
  assert.throws(() => createDocumentStore({ stateDir: linkedDir }), errorCode("invalid-state-directory"));
  const target = path.join(directory, "unrelated"); fs.writeFileSync(target, "untouched", { mode: 0o600 });
  fs.symlinkSync(target, path.join(privateDir, "documents.sqlite"));
  assert.throws(() => createDocumentStore({ stateDir: privateDir }), errorCode("invalid-storage"));
  assert.equal(fs.readFileSync(target, "utf8"), "untouched");
});
