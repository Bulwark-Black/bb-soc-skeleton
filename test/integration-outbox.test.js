"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");
const Database = require("better-sqlite3");
const { openOutbox, MAX_ENTRIES, MAX_BYTES, MAX_ATTEMPTS, MAX_AGE_MS } = require("../tools/integration-outbox");
const { prepareBatch } = require("../tools/integration-client");
const AT = "2026-09-29T12:00:00Z";
const digest = value => crypto.createHash("sha256").update(value).digest("hex");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "bb-soc-outbox-"));
  const queueDirectory = path.join(directory, "queue"), filename = path.join(queueDirectory, "outbox.sqlite");
  const tokenFile = path.join(directory, "source-credential"), sourceCredential = crypto.randomBytes(32).toString("base64url");
  fs.writeFileSync(tokenFile, sourceCredential + "\n", { mode: 0o600 });
  const opened = [];
  t.after(() => { for (const item of opened) { try { item.close(); } catch { /* Already closed for restart checks. */ } }
    fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, queueDirectory, filename, tokenFile, sourceCredential,
    open() { const item = openOutbox(queueDirectory); opened.push(item); return item; },
    sql(callback) { const db = new Database(filename); try { return callback(db); } finally { db.close(); } } };
}
function batch(number = 1, source = "synthetic-source") {
  return { schemaVersion: "1", documentType: "ingest-batch", sourceId: source, receiptId: "synthetic-receipt-" + number,
    sentAt: AT, records: [{ schemaVersion: "1", documentType: "normalized-record", recordId: "synthetic-record-" + number,
      sourceId: source, estateId: "synthetic-app", kind: "audit.event", observedAt: AT,
      payload: { title: "Synthetic imported event", state: "unknown", category: "synthetic" } }] };
}
function receipt(value, extra = {}) {
  return { schemaVersion: "1", documentType: "ingest-receipt", sourceId: value.sourceId, receiptId: value.receiptId,
    status: "accepted", accepted: value.records.length, duplicates: 0, receivedAt: AT, replay: false, ...extra };
}
function respond(response, value, status = 200, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json", ...headers }); response.end(JSON.stringify(value));
}
async function serve(t, handler) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    const entry = { body, batch: JSON.parse(body), headers: request.headers, url: request.url, method: request.method };
    requests.push(entry); handler(entry, response, requests.length, request);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { requests, baseUrl: "http://127.0.0.1:" + server.address().port };
}
function drain(queue, f, baseUrl, extra = {}) { return queue.drain({ baseUrl, sourceId: "synthetic-source", tokenFile: f.tokenFile, ...extra }); }

test("outbox persists exact canonical delivery bytes across restart and deduplicates immutable receipts", async t => {
  const f = fixture(t), remote = await serve(t, (entry, response) => respond(response, receipt(entry.batch)));
  let queue = f.open(); const value = batch(), expected = prepareBatch(value).body;
  const saved = queue.enqueue(value, remote.baseUrl);
  assert.equal(saved.state, "pending"); assert.equal(saved.duplicate, false);
  assert.deepEqual(queue.enqueue(value, remote.baseUrl), { ...saved, duplicate: true });
  const changed = batch(); changed.records[0].payload.title = "Different content";
  assert.throws(() => queue.enqueue(changed, remote.baseUrl), /different content/);
  assert.equal(f.sql(db => db.prepare("SELECT body FROM deliveries").get().body), expected);
  queue.close(); queue = f.open();
  const result = await drain(queue, f, remote.baseUrl);
  assert.equal(result.processed, 1); assert.equal(result.results[0].state, "delivered");
  assert.equal(remote.requests[0].body, expected); assert.equal(remote.requests[0].url, "/api/v1/ingest");
  assert.equal(remote.requests[0].headers.authorization, "Bearer " + f.sourceCredential);
  assert.equal(remote.requests[0].headers.cookie, undefined);
  assert.deepEqual(queue.enqueue(value, remote.baseUrl), { ...saved, state: "delivered", duplicate: true });
  const row = f.sql(db => db.prepare("SELECT * FROM deliveries").get());
  assert.equal(row.body, null); assert.equal(row.bytes, 0); assert.deepEqual(JSON.parse(row.receipt), receipt(value));
  queue.close(); queue = f.open(); assert.equal(queue.list().entries[0].state, "delivered");
  assert.equal((await drain(queue, f, remote.baseUrl)).processed, 0);
});

test("outbox transient failures persist backoff and Retry-After without sleeping or hammering later entries", async t => {
  for (const status of [429, 503]) await t.test(String(status), async child => {
    const f = fixture(child); let queue = f.open();
    const remote = await serve(child, (entry, response, count) => count === 1
      ? respond(response, { message: "upstream text is discarded" }, status, { "Retry-After": "12" }) : respond(response, receipt(entry.batch)));
    const other = await serve(child, (entry, response) => respond(response, receipt(entry.batch)));
    queue.enqueue(batch(1), remote.baseUrl); queue.enqueue(batch(2), remote.baseUrl);
    const before = Date.now(), first = await drain(queue, f, remote.baseUrl);
    assert.equal(first.processed, 1); assert.equal(first.results[0].state, "pending"); assert.equal(remote.requests.length, 1);
    const row = f.sql(db => db.prepare("SELECT * FROM deliveries WHERE id=?").get(first.results[0].id));
    assert.ok(row.next_at >= before + 12000); assert.equal(row.error_code, "ingest-rejected"); assert.equal(row.status, status);
    assert.equal(row.attempts, 1); assert.equal(row.claim, null);
    assert.equal((await drain(queue, f, remote.baseUrl)).processed, 0); assert.equal(remote.requests.length, 1);
    queue.close(); queue = f.open(); queue.enqueue(batch(3), remote.baseUrl);
    assert.equal((await drain(queue, f, remote.baseUrl)).processed, 0, "Restart and new deliveries cannot bypass cooldown.");
    assert.equal(remote.requests.length, 1);
    queue.enqueue(batch(4, "other-source"), remote.baseUrl);
    assert.equal((await drain(queue, f, remote.baseUrl, { sourceId: "other-source" })).processed, 1, "Other sources remain independent.");
    queue.enqueue(batch(5), other.baseUrl);
    assert.equal((await drain(queue, f, other.baseUrl)).processed, 1, "Other destinations remain independent.");
    assert.equal((await drain(queue, f, remote.baseUrl)).processed, 0);
    f.sql(db => db.prepare("UPDATE deliveries SET next_at=0").run());
    const finished = await drain(queue, f, remote.baseUrl); assert.equal(finished.processed, 3);
    assert.ok(finished.results.every(item => item.state === "delivered"));
  });
});

test("network backoff persists across entries and a retry cannot erase an active server cooldown", async t => {
  const f = fixture(t); let queue = f.open();
  const remote = await serve(t, (entry, response, count, request) => {
    if (count === 1) request.socket.destroy();
    else respond(response, {}, 429, { "Retry-After": "700000" });
  });
  queue.enqueue(batch(1), remote.baseUrl); queue.enqueue(batch(2), remote.baseUrl);
  const first = await drain(queue, f, remote.baseUrl);
  assert.equal(first.results[0].code, "network-unavailable");
  queue.close(); queue = f.open();
  assert.equal((await drain(queue, f, remote.baseUrl)).processed, 0); assert.equal(remote.requests.length, 1);
  f.sql(db => db.prepare("UPDATE deliveries SET next_at=0").run());
  const before = Date.now(), limited = await drain(queue, f, remote.baseUrl);
  assert.equal(limited.results[0].state, "blocked"); assert.equal(remote.requests.length, 2);
  const saved = f.sql(db => db.prepare("SELECT * FROM deliveries WHERE id=?").get(limited.results[0].id));
  assert.ok(saved.next_at >= before + 700000000, "Even an excessive Retry-After is not shortened for newer entries.");
  queue.retry(saved.id);
  const retried = f.sql(db => db.prepare("SELECT * FROM deliveries WHERE id=?").get(saved.id));
  assert.equal(retried.attempts, 0); assert.equal(retried.next_at, saved.next_at); assert.equal(retried.status, 429);
  queue.enqueue(batch(3), remote.baseUrl); queue.close(); queue = f.open();
  assert.equal((await drain(queue, f, remote.baseUrl)).processed, 0); assert.equal(remote.requests.length, 2);
});

test("permanent errors block until explicit retry, preserving bytes while rotating source credentials", async t => {
  const f = fixture(t), queue = f.open(), privateError = crypto.randomBytes(24).toString("hex");
  const remote = await serve(t, (entry, response, count) => count === 1
    ? respond(response, { message: privateError }, 401) : respond(response, receipt(entry.batch)));
  const saved = queue.enqueue(batch(), remote.baseUrl);
  assert.equal((await drain(queue, f, remote.baseUrl)).results[0].state, "blocked");
  assert.equal((await drain(queue, f, remote.baseUrl)).processed, 0);
  const rotated = crypto.randomBytes(32).toString("base64url"); fs.writeFileSync(f.tokenFile, rotated + "\n", { mode: 0o600 });
  assert.deepEqual(queue.retry(saved.id), { id: saved.id, state: "pending" });
  assert.equal((await drain(queue, f, remote.baseUrl)).results[0].state, "delivered");
  assert.equal(remote.requests[0].body, remote.requests[1].body); assert.equal(remote.requests[1].headers.authorization, "Bearer " + rotated);
  assert.throws(() => queue.retry(saved.id), /Only a blocked/);
  const serialized = JSON.stringify(queue.list()) + f.sql(db => JSON.stringify(db.prepare("SELECT * FROM deliveries").all()));
  for (const marker of [privateError, f.sourceCredential, rotated, f.tokenFile]) assert.ok(!serialized.includes(marker));
  for (const filename of fs.readdirSync(f.queueDirectory)) {
    const bytes = fs.readFileSync(path.join(f.queueDirectory, filename));
    for (const marker of [privateError, f.sourceCredential, rotated]) assert.equal(bytes.includes(Buffer.from(marker)), false);
  }
});

test("lost acknowledgement safely replays one identical receipt after restart", async t => {
  const f = fixture(t), committed = new Set();
  const remote = await serve(t, (entry, response, count, request) => {
    const replay = committed.has(entry.batch.receiptId); committed.add(entry.batch.receiptId);
    if (count === 1) request.socket.destroy(); else respond(response, receipt(entry.batch, { replay }));
  });
  let queue = f.open(); queue.enqueue(batch(), remote.baseUrl);
  const first = await drain(queue, f, remote.baseUrl); assert.equal(first.results[0].code, "network-unavailable");
  queue.close(); queue = f.open(); f.sql(db => db.prepare("UPDATE deliveries SET next_at=0").run());
  const second = await drain(queue, f, remote.baseUrl);
  assert.equal(second.results[0].receipt.replay, true); assert.equal(committed.size, 1);
  assert.equal(remote.requests[0].body, remote.requests[1].body);
});

test("concurrent workers cannot claim an active lease twice", async t => {
  const f = fixture(t), first = f.open(), second = f.open();
  let finish, seen;
  const seenRequest = new Promise(resolve => { seen = resolve; });
  const remote = await serve(t, (entry, response) => { finish = () => respond(response, receipt(entry.batch)); seen(); });
  first.enqueue(batch(), remote.baseUrl);
  const pending = drain(first, f, remote.baseUrl); await seenRequest;
  assert.equal((await drain(second, f, remote.baseUrl)).processed, 0); assert.equal(remote.requests.length, 1);
  finish(); assert.equal((await pending).results[0].state, "delivered");
});

test("expired leases are reclaimable and a stale worker cannot overwrite a newer acknowledgement", async t => {
  const f = fixture(t), first = f.open(), second = f.open();
  let finish, seen; const seenRequest = new Promise(resolve => { seen = resolve; });
  const remote = await serve(t, (entry, response, count) => {
    if (count === 1) { finish = () => respond(response, {}, 503); seen(); }
    else respond(response, receipt(entry.batch, { replay: true }));
  });
  first.enqueue(batch(), remote.baseUrl);
  const stale = drain(first, f, remote.baseUrl); await seenRequest;
  f.sql(db => db.prepare("UPDATE deliveries SET lease_until=0").run());
  assert.equal((await drain(second, f, remote.baseUrl)).results[0].state, "delivered");
  finish(); assert.equal((await stale).results[0].state, "lease-lost");
  assert.equal(first.list().entries[0].state, "delivered");
  assert.equal(remote.requests[0].body, remote.requests[1].body);
});

test("attempt exhaustion, expiration and excessive retry delay stop automatic delivery", async t => {
  const f = fixture(t), queue = f.open(), remote = await serve(t, (_entry, response) => respond(response, {}, 429, { "Retry-After": "700000" }));
  const first = queue.enqueue(batch(1), remote.baseUrl);
  assert.equal((await drain(queue, f, remote.baseUrl)).results[0].state, "blocked");
  // Simulate elapsed cooldown before testing the separate lifecycle limits.
  f.sql(db => db.prepare("UPDATE deliveries SET next_at=0").run());
  const second = queue.enqueue(batch(2), remote.baseUrl);
  f.sql(db => db.prepare("UPDATE deliveries SET state='inflight',attempts=?,claim=?,lease_until=0 WHERE id=?").run(MAX_ATTEMPTS, crypto.randomUUID(), second.id));
  assert.equal((await drain(queue, f, remote.baseUrl)).processed, 0);
  assert.equal(queue.list().entries.find(item => item.id === second.id).errorCode, "attempts-exhausted");
  queue.retry(second.id); assert.equal(queue.list().entries.find(item => item.id === second.id).attempts, 0);
  f.sql(db => db.prepare("UPDATE deliveries SET created_at=? WHERE id=?").run(Date.now() - MAX_AGE_MS - 1000, second.id));
  assert.equal((await drain(queue, f, remote.baseUrl)).processed, 0);
  assert.equal(queue.list().entries.find(item => item.id === second.id).errorCode, "delivery-expired");
  assert.throws(() => queue.retry(second.id), /unexpired/); assert.equal(remote.requests.length, 1);
  assert.equal(queue.list().entries.find(item => item.id === first.id).state, "blocked");
});

test("invalid receipts block; a changed saved batch or source correlation never reaches HTTP", async t => {
  const f = fixture(t), queue = f.open(), remote = await serve(t, (entry, response) => respond(response, receipt(entry.batch, { receiptId: "synthetic-wrong-receipt" })));
  queue.enqueue(batch(1), remote.baseUrl);
  assert.equal((await drain(queue, f, remote.baseUrl)).results[0].code, "invalid-receipt");
  const modified = queue.enqueue(batch(2), remote.baseUrl), other = prepareBatch(batch(2, "different-source")).body;
  f.sql(db => db.prepare("UPDATE deliveries SET body=?,body_hash=?,bytes=? WHERE id=?").run(other, digest(other), Buffer.byteLength(other), modified.id));
  const refused = await drain(queue, f, remote.baseUrl);
  assert.equal(refused.results[0].code, "invalid-saved-batch"); assert.equal(remote.requests.length, 1);
  queue.close(); assert.throws(() => f.open(), /identity/);
});

test("outbox rejects public destinations, wrong-source drains, invalid limits and noncanonical batches", async t => {
  const f = fixture(t), queue = f.open(), remote = await serve(t, (entry, response) => respond(response, receipt(entry.batch)));
  assert.throws(() => queue.enqueue(batch(), ["https:", "", "example.com"].join("/")));
  const value = batch(); value.records[0].payload.fields = { apiToken: crypto.randomBytes(24).toString("hex") };
  assert.throws(() => queue.enqueue(value, remote.baseUrl));
  queue.enqueue(batch(), remote.baseUrl);
  assert.equal((await drain(queue, f, remote.baseUrl, { sourceId: "other-source" })).processed, 0);
  await assert.rejects(drain(queue, f, remote.baseUrl, { limit: 101 }));
  await assert.rejects(drain(queue, f, remote.baseUrl, { limit: 0 }));
  assert.equal(remote.requests.length, 0);
  assert.equal(queue.list().entries.length, 1);
});

test("outbox entry capacity includes delivered tombstones and never silently discards work", t => {
  const f = fixture(t), queue = f.open(); queue.enqueue(batch());
  f.sql(db => {
    const original = db.prepare("SELECT * FROM deliveries").get();
    const insert = db.prepare("INSERT INTO deliveries SELECT ?,base_url,source_id,?,body_hash,NULL,0,'delivered',1,created_at,updated_at,next_at,NULL,NULL,?,NULL,NULL FROM deliveries WHERE id=?");
    db.transaction(() => {
      for (let index = 2; index <= MAX_ENTRIES; index += 1) {
        const value = batch(index), key = digest(JSON.stringify([original.base_url, value.sourceId, value.receiptId]));
        insert.run(key, value.receiptId, JSON.stringify(receipt(value)), original.id);
      }
    })();
  });
  assert.throws(() => queue.enqueue(batch(MAX_ENTRIES + 1)), /capacity/);
  assert.equal(queue.list().totals.reduce((sum, row) => sum + row.entries, 0), MAX_ENTRIES);
  assert.equal(queue.list().entries.length, 100);
});

test("outbox status validates bounded filters and pages every retained blocked delivery", t => {
  const f = fixture(t), queue = f.open(), saved = [];
  for (let index = 0; index < 106; index += 1) saved.push(queue.enqueue(batch(index)).id);
  queue.enqueue(batch(106, "other-source"));
  f.sql(db => db.prepare("UPDATE deliveries SET state='blocked',error_code='ingest-rejected',status=401").run());
  queue.enqueue(batch(107));
  const options = { state: "blocked", sourceId: "synthetic-source" };
  const first = queue.list(options), last = queue.list({ ...options, offset: first.page.nextOffset });
  assert.deepEqual(first.filters, options);
  assert.deepEqual(first.page, { offset: 0, limit: 100, total: 106, returned: 100, hasMore: true, nextOffset: 100 });
  assert.deepEqual(last.page, { offset: 100, limit: 100, total: 106, returned: 6, hasMore: false, nextOffset: null });
  assert.deepEqual([...first.entries, ...last.entries].map(item => item.id).sort(), saved.sort());
  assert.ok([...first.entries, ...last.entries].every(item => item.state === "blocked" && item.baseUrl === "http://127.0.0.1:8080"));
  assert.equal(first.totals.reduce((sum, row) => sum + row.entries, 0), 108, "Totals describe the complete queue.");
  assert.equal(queue.list({ offset: MAX_ENTRIES, limit: 1 }).entries.length, 0);
  for (const value of [null, [], "blocked", { ignored: true }, { state: null }, { state: "unknown" },
    { sourceId: "bad source" }, { offset: -1 }, { offset: 10001 }, { offset: 0.5 }, { offset: "0" },
    { limit: 0 }, { limit: 101 }, { limit: "1" }, { limit: NaN }]) assert.throws(() => queue.list(value), TypeError);
});

test("outbox pending-body capacity is 64 MiB, accepts exact replay at capacity and preserves every existing entry", t => {
  const f = fixture(t), queue = f.open();
  const value = batch(); value.records = Array.from({ length: 1000 }, (_, index) => ({ ...value.records[0], recordId: "synthetic-bulk-" + index,
    payload: { title: "Synthetic bulk record", state: "unknown", category: "synthetic", summary: "x".repeat(650) } }));
  let saved = 0, bytes = 0;
  while (true) {
    value.receiptId = "synthetic-bulk-receipt-" + saved;
    const size = Buffer.byteLength(prepareBatch(value).body);
    if (bytes + size > MAX_BYTES) break;
    queue.enqueue(value); bytes += size; saved += 1;
  }
  assert.throws(() => queue.enqueue(value), /capacity/);
  const totals = queue.list().totals; assert.equal(totals[0].entries, saved); assert.equal(totals[0].bytes, bytes);
  value.receiptId = "synthetic-bulk-receipt-0"; assert.equal(queue.enqueue(value).duplicate, true);
});

test("outbox private directory and files reject checkout paths, permissions, links and unrelated state", t => {
  const f = fixture(t);
  assert.throws(() => openOutbox("relative"));
  assert.throws(() => openOutbox(path.resolve(__dirname, "..")));
  fs.mkdirSync(f.queueDirectory, { mode: 0o755 }); assert.throws(() => f.open(), /0700/); fs.chmodSync(f.queueDirectory, 0o700);
  fs.writeFileSync(path.join(f.queueDirectory, "other-state"), "synthetic", { mode: 0o600 }); assert.throws(() => f.open(), /dedicated/);
  fs.unlinkSync(path.join(f.queueDirectory, "other-state"));
  const queue = f.open(); queue.close();
  fs.chmodSync(f.filename, 0o644); assert.throws(() => f.open(), /owner-only/); fs.chmodSync(f.filename, 0o600);
  const linked = path.join(f.directory, "hardlink"); fs.linkSync(f.filename, linked); assert.throws(() => f.open(), /without links/); fs.unlinkSync(linked);
  const symlink = path.join(f.directory, "symlink"); fs.symlinkSync(f.queueDirectory, symlink); assert.throws(() => openOutbox(symlink), /symbolic links/);
  fs.renameSync(f.filename, path.join(f.directory, "original")); fs.symlinkSync(path.join(f.directory, "original"), f.filename);
  assert.throws(() => f.open(), /without links/);
});

test("outbox refuses corrupt or foreign SQLite state without overwriting it", t => {
  for (const change of [
    db => db.exec("CREATE TABLE unrelated(value TEXT)"),
    db => db.prepare("UPDATE outbox_meta SET version=2").run(),
    db => db.exec("CREATE TRIGGER unrelated AFTER INSERT ON deliveries BEGIN SELECT 1; END"),
    db => db.prepare("UPDATE deliveries SET body_hash=?").run("a".repeat(64)),
    db => db.prepare("UPDATE deliveries SET bytes=-1").run(),
    db => db.prepare("UPDATE deliveries SET state='imaginary'").run(),
    db => db.prepare("UPDATE deliveries SET receipt_id='different-receipt-id'").run()
  ]) {
    const f = fixture(t), queue = f.open(); queue.enqueue(batch()); queue.close(); f.sql(change);
    const before = fs.readFileSync(f.filename); assert.throws(() => f.open()); assert.deepEqual(fs.readFileSync(f.filename), before);
  }
  const invalid = fixture(t); fs.mkdirSync(invalid.queueDirectory, { mode: 0o700 });
  fs.writeFileSync(invalid.filename, "not a database", { mode: 0o600 });
  assert.throws(() => invalid.open()); assert.equal(fs.readFileSync(invalid.filename, "utf8"), "not a database");
});
