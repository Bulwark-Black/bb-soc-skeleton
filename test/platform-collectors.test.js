"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), zlib = require("node:zlib"), { Readable } = require("node:stream");
const Database = require("better-sqlite3");
const { runCollector, status, validateConfig } = require("../tools/platform-collectors/engine");
const { normalizeVendorPayload } = require("../tools/vendor-adapters");
const { openOutbox } = require("../tools/integration-outbox");
const { createS3Client } = require("../tools/platform-collectors/aws");
const ACCESS = require("node:crypto").randomBytes(32).toString("base64url");
const NOW = Date.parse("2026-10-18T12:00:00.000Z"), START = "2026-10-18T11:00:00.000Z", TENANT = "11111111-1111-4111-8111-111111111111";
const http = (body, headers = {}, status = 200) => ({ status, headers, body });
function setup(t, provider, options, maxSteps = 10) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "platform-worker-"))); fs.chmodSync(dir, 0o700); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const secret = path.join(dir, "provider.json"), token = path.join(dir, "source-token"); fs.writeFileSync(secret, JSON.stringify({ accessToken: ACCESS }), { mode: 0o600 }); fs.writeFileSync(token, ACCESS, { mode: 0o600 });
  const config = { schemaVersion: 1, provider, sourceId: "source-fixture", appId: "app-fixture", baseUrl: "https://127.0.0.1", tokenFile: token, reviewedInput: true, maxSteps, options };
  if (!["wazuh", "aws-cloudtrail-s3"].includes(provider)) config.providerCredentialFile = secret;
  return { config, dir, stateDirectory: path.join(dir, "state"), outboxDirectory: path.join(dir, "queue"), now: () => NOW, transport: async () => { throw new Error("unexpected network"); } };
}
function readState(f, name) { const db = new Database(path.join(f.stateDirectory, "collector.sqlite")); try { const row = db.prepare("SELECT value FROM documents WHERE name=?").get(name); return row ? JSON.parse(row.value) : null; } finally { db.close(); } }
function queued(f) { const db = new Database(path.join(f.outboxDirectory, "outbox.sqlite")); try { return db.prepare("SELECT body FROM deliveries ORDER BY rowid").all().map(r => JSON.parse(r.body)); } finally { db.close(); } }
const entra = id => ({ id, createdDateTime: "2026-10-18T11:30:00Z", userId: "actor", status: { errorCode: 0 } });
const graphOptions = { tenantId: TENANT, startAt: START, dataset: "signins", retentionDays: 7, lagSeconds: 0, overlapSeconds: 300, windowSeconds: 3600 };
const m365Options = { tenantId: TENANT, publisherId: TENANT, contentType: "Audit.Exchange", startAt: START, lagSeconds: 0, overlapSeconds: 300, windowSeconds: 3600 };
const audit = id => ({ Id: id, OrganizationId: TENANT, CreationTime: "2026-10-01T05:00:00", Workload: "Exchange", RecordType: 1, Operation: "Set-Mailbox", ResultStatus: "Succeeded" });
const content = (id = "content-one") => ({ contentType: "Audit.Exchange", contentId: id, contentCreated: "2026-10-18T11:20:00.000Z", contentExpiration: "2026-10-25T11:20:00.000Z", contentUri: `https://manage.office.com/api/v1.0/${TENANT}/activity/feed/audit/${id}` });
const wazuh = id => ({ id, timestamp: "2026-10-18T11:00:00.123+0000", rule: { id: "5001", level: 7, description: "Reviewed upstream fixture", groups: ["authentication"] }, agent: { id: "001", name: "fixture-host" }, manager: { name: "fixture-manager" }, full_log: "Reviewed fixture message" });
function wazuhSetup(t, text, maxSteps) { const f = setup(t, "wazuh", { file: "/tmp/temporary-placeholder" }, maxSteps); f.config.options.file = path.join(f.dir, "alerts.json"); fs.writeFileSync(f.config.options.file, text, { mode: 0o600 }); return f; }

test("Graph pages resume after durable queue, freeze sentAt and preserve original event time", async t => {
  const f = setup(t, "entra", graphOptions, 1), next = "https://graph.microsoft.com/v1.0/auditLogs/signIns?$skiptoken=fixture";
  let calls = 0; f.transport = async req => { assert.equal(req.headers.Authorization, "Bearer " + ACCESS); return ++calls === 1 ? http({ value: [entra("one")], "@odata.nextLink": next }) : http({ value: [entra("two")] }); };
  const first = await runCollector(f); assert.equal(first.complete, false); assert.equal(readState(f, "cursor").window.next, next);
  const second = await runCollector(f); assert.equal(second.complete, true); assert.equal(calls, 2);
  const batches = queued(f); assert.equal(batches.length, 2); assert.equal(batches[0].sentAt, new Date(NOW).toISOString()); assert.equal(batches[0].records[0].observedAt, "2026-10-18T11:30:00.000Z");
});
test("crash after enqueue reuses frozen batch and advances checkpoint without refetch", async t => {
  const f = setup(t, "entra", graphOptions), page = http({ value: [entra("one")] }); f.transport = async () => page;
  await assert.rejects(runCollector({ ...f, fault: () => { throw new Error("simulated interruption"); } }), /collection-failed/);
  assert.equal(queued(f).length, 1); assert.equal(readState(f, "cursor"), null); assert.ok(readState(f, "pending"));
  f.transport = async () => { throw new Error("must not refetch"); };
  const resumed = await runCollector({ ...f, now: () => NOW + 10000 }); assert.equal(resumed.complete, true); assert.equal(queued(f).length, 1); assert.equal(readState(f, "pending"), null); assert.equal(readState(f, "cursor").watermark, new Date(NOW).toISOString());
});
test("Graph rejects redirecting next URL before queue or cursor movement", async t => {
  const f = setup(t, "entra", graphOptions); f.transport = async () => http({ value: [entra("one")], "@odata.nextLink": "https://attacker.example.invalid/steal" });
  await assert.rejects(runCollector(f), /unsafe-pagination-url/); assert.equal(queued(f).length, 0); assert.equal(readState(f, "cursor"), null);
});
test("Graph replay duplicates collapse and conflicting immutable IDs fail", async t => {
  const f = setup(t, "entra", graphOptions); f.transport = async () => http({ value: [entra("one")] }); await runCollector(f);
  const now = () => NOW + 60000; f.transport = async () => http({ value: [{ ...entra("one"), createdDateTime: "2026-10-18T11:59:00Z" }] });
  await assert.rejects(runCollector({ ...f, now }), /upstream-identity-conflict/); assert.equal(queued(f).length, 1);
});
test("quiet successful Graph page commits window without invented heartbeat", async t => {
  const f = setup(t, "entra", graphOptions); f.transport = async () => http({ value: [] });
  const r = await runCollector(f); assert.equal(r.complete, true); assert.equal(r.records, 0); assert.equal(queued(f).length, 0); assert.equal(readState(f, "cursor").watermark, new Date(NOW).toISOString());
});
test("provider retry-after persists cooldown across process restart", async t => {
  const f = setup(t, "entra", graphOptions); let calls = 0; f.transport = async () => { calls++; return http({ secret: "never print me" }, { "Retry-After": "120" }, 429); };
  await assert.rejects(runCollector(f), /provider-throttled/); const r = await runCollector(f); assert.equal(r.code, "provider-cooldown"); assert.equal(calls, 1); assert.equal(JSON.stringify(await status(f)).includes("never print"), false);
});
test("Microsoft client credentials use fixed tenant token endpoint and correct scope", async t => {
  const f = setup(t, "entra", graphOptions); fs.writeFileSync(f.config.providerCredentialFile, JSON.stringify({ clientId: TENANT, clientSecret: ACCESS }));
  f.transport = async req => { if (req.method === "POST") { assert.equal(req.url, `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`); assert.equal(new URLSearchParams(req.body).get("scope"), "https://graph.microsoft.com/.default"); return http({ token_type: "Bearer", access_token: ACCESS }); } assert.equal(req.headers.Authorization, "Bearer " + ACCESS); return http({ value: [] }); };
  assert.equal((await runCollector(f)).complete, true);
});
test("Microsoft365 listing and content ledger preserve old audit times and tenant binding", async t => {
  const f = setup(t, "microsoft365", m365Options, 1); let requests = 0;
  f.transport = async req => { requests++; return req.url.includes("/subscriptions/content") ? http([content()]) : http([audit("record-one")]); };
  assert.equal((await runCollector(f)).complete, false); assert.equal(queued(f).length, 0);
  assert.equal((await runCollector(f)).complete, true); assert.equal(requests, 2); assert.equal(queued(f)[0].records[0].observedAt, "2026-10-01T05:00:00.000Z");
  assert.equal((await status(f)).ledgerEntries, 2);
});
test("Microsoft365 refuses foreign tenant and unsafe content origin", async t => {
  const f = setup(t, "microsoft365", m365Options); f.transport = async () => http([{ ...content(), contentUri: "https://attacker.example.invalid/audit/one" }]);
  await assert.rejects(runCollector(f), /unsafe-content-url/); assert.equal(readState(f, "cursor"), null);
  f.transport = async req => req.url.includes("/subscriptions/content") ? http([content()]) : http([{ ...audit("record-one"), OrganizationId: "22222222-2222-4222-8222-222222222222" }]);
  await assert.rejects(runCollector(f), /provider-tenant-mismatch/); assert.equal(queued(f).length, 0); assert.equal((await status(f)).ledgerEntries, 0);
});
test("Microsoft365 follows same-window NextPageUri and rejects loops", async t => {
  const f = setup(t, "microsoft365", m365Options); let next;
  f.transport = async req => { if (!next) { const u = new URL(req.url); u.searchParams.set("nextPage", "one"); next = u.href; } return http([], { NextPageUri: next }); };
  await assert.rejects(runCollector(f), /pagination-loop-or-limit/); assert.equal(readState(f, "cursor").window.next, next); assert.equal((await status(f)).status.lastCompletedAt, null);
});
test("Okta polling keeps next link including quiet read and resumes after restart", async t => {
  const f = setup(t, "okta", { origin: "https://fixture.okta.com", startAt: START, authScheme: "SSWS" }, 1);
  const next = "https://fixture.okta.com/api/v1/logs?sortOrder=ASCENDING&after=opaque-fixture&limit=100";
  f.transport = async req => { assert.equal(req.headers.Authorization, "SSWS " + ACCESS); return http([], { Link: `<${next}>; rel="next"` }); }; fs.writeFileSync(f.config.providerCredentialFile, JSON.stringify({ token: ACCESS }));
  assert.equal((await runCollector(f)).complete, true); assert.equal(readState(f, "cursor").next, next);
  f.transport = async req => { assert.equal(req.url, next); return http([{ uuid: "late-event", published: "2026-10-17T01:00:00Z", eventType: "user.session.start", outcome: { result: "SUCCESS" } }], { link: `<${next.replace("opaque-fixture", "next-fixture")}>; rel="next"` }); };
  assert.equal((await runCollector(f)).records, 1); assert.equal(queued(f)[0].records[0].observedAt, "2026-10-17T01:00:00.000Z");
});
test("Checkmk only reads selected host/service status and retains source state/time", async t => {
  const f = setup(t, "checkmk", { origin: "https://127.0.0.1", site: "fixture", apiVersion: "1.0", hosts: ["host-one"] }); fs.writeFileSync(f.config.providerCredentialFile, JSON.stringify({ username: "readonly", secret: ACCESS }));
  let count = 0; f.transport = async req => { count++; assert.equal(req.method, "POST"); assert.equal(req.privateNetwork, true); const b = JSON.parse(req.body); assert.equal(b.query.right, "host-one"); const host = req.url.includes("/host/"); return http({ domainType: host ? "host" : "service", value: [{ extensions: { ...(host ? { name: "host-one" } : { host_name: "host-one", description: "CPU" }), state: host ? 0 : 2, has_been_checked: 1, last_check: (NOW - 60000) / 1000, plugin_output: "Reviewed check fixture" } }] }); };
  const r = await runCollector(f); assert.equal(r.complete, true); assert.equal(count, 2); assert.equal(queued(f)[1].records[0].payload.fields.upstreamState, "CRIT"); assert.equal(queued(f)[1].records[0].observedAt, new Date(NOW - 60000).toISOString());
});
test("Wazuh partial append retains offset, then completes without dropping or duplicating", async t => {
  const line = JSON.stringify(wazuh("one")); const f = wazuhSetup(t, line.slice(0, 30));
  const first = await runCollector(f); assert.equal(first.partialLine, true); assert.equal(first.complete, false); assert.equal(readState(f, "cursor").offset, 0);
  fs.appendFileSync(f.config.options.file, line.slice(30) + "\n"); const second = await runCollector(f); assert.equal(second.records, 1); assert.equal(second.complete, true);
  assert.equal((await runCollector(f)).records, 0); assert.equal(queued(f).length, 1);
});
test("Wazuh truncation, replacement and changed pre-offset content fail closed", async t => {
  for (const change of ["truncate", "replace", "anchor"]) {
    const f = wazuhSetup(t, JSON.stringify(wazuh("one")) + "\n"); await runCollector(f);
    if (change === "truncate") fs.truncateSync(f.config.options.file, 0);
    else if (change === "replace") { fs.renameSync(f.config.options.file, f.config.options.file + ".old"); fs.writeFileSync(f.config.options.file, JSON.stringify(wazuh("two")) + "\n"); }
    else { const fd = fs.openSync(f.config.options.file, "r+"); fs.writeSync(fd, "X", 0, "utf8"); fs.closeSync(fd); }
    await assert.rejects(runCollector(f), /input-changed/); assert.equal(queued(f).length, 1);
  }
});
test("Wazuh malformed/oversize lines reject whole read, quiet file does not invent events", async t => {
  const f = wazuhSetup(t, JSON.stringify(wazuh("one")) + "\ninvalid\n"); await assert.rejects(runCollector(f), /invalid-line/); assert.equal(queued(f).length, 0); assert.equal(readState(f, "cursor"), null);
  const empty = wazuhSetup(t, ""); assert.equal((await runCollector(empty)).complete, true); assert.equal(queued(empty).length, 0);
  const large = wazuhSetup(t, "X".repeat(256 * 1024)); await assert.rejects(runCollector(large), /line-too-long/);
});
test("state/config/source/queue identity are pinned; unsafe credentials and symlinks reject", async t => {
  const f = setup(t, "entra", graphOptions); f.transport = async () => http({ value: [] }); await runCollector(f);
  await assert.rejects(runCollector({ ...f, config: { ...f.config, appId: "another-app" } }), /collector-config-or-queue-changed/);
  fs.chmodSync(f.config.providerCredentialFile, 0o644); await assert.rejects(runCollector(f), /invalid-provider-credential/); fs.chmodSync(f.config.providerCredentialFile, 0o600);
  const stateDb = path.join(f.stateDirectory, "collector.sqlite"), db = new Database(stateDb); db.prepare("UPDATE documents SET value=? WHERE name='cursor'").run("{}"); db.close(); await assert.rejects(runCollector(f), /invalid-state/);
  const other = setup(t, "entra", graphOptions); fs.symlinkSync(f.config.providerCredentialFile, path.join(other.dir, "linked")); other.config.providerCredentialFile = path.join(other.dir, "linked"); await assert.rejects(runCollector(other), /invalid-provider-credential/);
});
test("new worker refuses a mixed-source outbox", async t => {
  const f = setup(t, "entra", graphOptions), q = openOutbox(f.outboxDirectory);
  const b = normalizeVendorPayload("entra-signin", [entra("foreign")], { sourceId: "foreign-source", estateId: "foreign-app" }).batch; q.enqueue(b, f.config.baseUrl); q.close();
  await assert.rejects(runCollector(f), /outbox-not-dedicated/); assert.equal(fs.existsSync(f.stateDirectory), false);
});
test("configuration rejects arbitrary public/credential endpoints and excessive windows", t => {
  const f = setup(t, "entra", graphOptions); assert.throws(() => validateConfig({ ...f.config, options: { ...graphOptions, endpoint: "https://attacker.example.invalid" } }), /invalid-config/);
  const ok = setup(t, "okta", { origin: "https://fixture.okta.com.attacker.example.invalid", startAt: START, authScheme: "SSWS" }); assert.throws(() => validateConfig(ok.config), /invalid-origin/);
  const cm = setup(t, "checkmk", { origin: "https://public.example.invalid", site: "fixture", apiVersion: "1.0", hosts: ["one"] }); assert.throws(() => validateConfig(cm.config));
});
const s3Options = { region: "us-east-1", bucket: "fixture-cloudtrail-bucket", prefix: "AWSLogs/111111111111/CloudTrail/us-east-1/", expectedBucketOwner: "111111111111" };
const trail = id => ({ eventID: id, eventTime: "2026-10-18T10:00:00Z", eventSource: "iam.amazonaws.com", eventName: "CreateUser", recipientAccountId: "111111111111", awsRegion: "us-east-1" });
function s3Fixture(t) {
  const f = setup(t, "aws-cloudtrail-s3", s3Options), bytes = zlib.gzipSync(JSON.stringify({ Records: [trail("one")] }));
  const key = s3Options.prefix + "2026/10/18/fixture.json.gz", item = { Key: key, ETag: '"fixture-etag"', Size: bytes.length, LastModified: new Date(NOW - 10000) };
  const list = { Name: s3Options.bucket, Prefix: s3Options.prefix, IsTruncated: false, Contents: [item] };
  let calls = 0; f.s3Client = { send: async command => { calls++; assert.equal(command.input.ExpectedBucketOwner, s3Options.expectedBucketOwner); if (command.constructor.name === "ListObjectsV2Command") return list; assert.equal(command.input.IfMatch, item.ETag); return { ETag: item.ETag, ContentLength: bytes.length, Body: Readable.from([bytes]) }; } };
  return { f, item, bytes, list, calls: () => calls };
}
test("S3 CloudTrail lists, bounds gzip, queues before ledger, and rescans for late objects", async t => {
  const { f, item, calls } = s3Fixture(t); const first = await runCollector(f); assert.equal(first.complete, true); assert.equal(first.records, 1); assert.equal(first.status.completionScope, "object-listing-cycle"); assert.equal(calls(), 2);
  const second = await runCollector(f); assert.equal(second.records, 0); assert.equal(calls(), 3); assert.equal((await status(f)).ledgerEntries, 2);
  item.ETag = '"changed"'; await assert.rejects(runCollector(f), /upstream-identity-conflict/); assert.equal(queued(f).length, 1);
});
test("S3 pagination and get failure preserve pending object and continuation", async t => {
  const { f, list, item, bytes } = s3Fixture(t); f.config.maxSteps = 1; list.IsTruncated = true; list.NextContinuationToken = "page-two";
  await runCollector(f); const cursor = readState(f, "cursor"); assert.equal(cursor.next, "page-two"); assert.equal(cursor.items.length, 1);
  f.s3Client = { send: async () => { throw Object.assign(new Error("private AWS error text"), { $metadata: { httpStatusCode: 403 } }); } };
  await assert.rejects(runCollector(f), /provider-unauthorized/); assert.deepEqual(readState(f, "cursor"), cursor); assert.equal(queued(f).length, 0);
  f.s3Client = { send: async command => { assert.equal(command.constructor.name, "GetObjectCommand"); return { ETag: item.ETag, ContentLength: bytes.length, Body: Readable.from([bytes]) }; } };
  assert.equal((await runCollector(f)).records, 1); assert.equal(readState(f, "cursor").next, "page-two");
});
test("S3 gzip bomb and changed GET object fail without ledger/cursor advancement", async t => {
  const { f, list, item } = s3Fixture(t), bomb = zlib.gzipSync("x".repeat(8 * 1024 * 1024 + 1)); item.Size = bomb.length;
  f.s3Client = { send: async command => command.constructor.name === "ListObjectsV2Command" ? list : { ETag: item.ETag, ContentLength: bomb.length, Body: Readable.from([bomb]) } };
  await assert.rejects(runCollector(f), /aws-invalid-or-oversize-gzip/); assert.equal((await status(f)).ledgerEntries, 0); assert.equal(readState(f, "cursor").items.length, 1);
});
test("S3 SDK ignores environment endpoint overrides and uses fixed regional TLS host", async () => {
  const saved = process.env.AWS_ENDPOINT_URL_S3; process.env.AWS_ENDPOINT_URL_S3 = "https://attacker.example.invalid";
  const client = createS3Client(s3Options);
  try { assert.equal((await client.config.endpoint()).hostname, "s3.us-east-1.amazonaws.com"); assert.equal(client.config.ignoreConfiguredEndpointUrls, true); }
  finally { client.destroy(); if (saved === undefined) delete process.env.AWS_ENDPOINT_URL_S3; else process.env.AWS_ENDPOINT_URL_S3 = saved; }
});
test("new bridge adapters preserve explicit classification and reject unknown timestamps", () => {
  const w = normalizeVendorPayload("wazuh-alerts", [wazuh("one")], { sourceId: "s", estateId: "a" }).batch.records[0]; assert.equal(w.kind, "log.event"); assert.equal(w.payload.fields.upstreamDetection, true); assert.equal(w.observedAt, "2026-10-18T11:00:00.123Z");
  assert.throws(() => normalizeVendorPayload("wazuh-alerts", [{ ...wazuh("one"), timestamp: "2026-10-18 11:00" }], { sourceId: "s", estateId: "a" }));
  const a = normalizeVendorPayload("entra-directory-audit", [{ id: "a", activityDateTime: START, activityDisplayName: "Add member to group", category: "GroupManagement", result: "success" }], { sourceId: "s", estateId: "a" }).batch.records[0]; assert.equal(a.payload.fields.action, "Add member to group"); assert.equal(a.kind, "audit.event");
});
test("overlapping schedules cannot read or advance the same checkpoint", async t => {
  const f = setup(t, "entra", graphOptions); let release, entered;
  const arrived = new Promise(r => { entered = r; }); f.transport = async () => { entered(); return new Promise(r => { release = () => r(http({ value: [] })); }); };
  const first = runCollector(f); await arrived;
  await assert.rejects(runCollector(f), /collector-busy/); release(); assert.equal((await first).complete, true);
});
test("full outbox preserves staged batch and cursor until capacity is explicitly available", async t => {
  const f = setup(t, "entra", graphOptions), q = openOutbox(f.outboxDirectory);
  const b = normalizeVendorPayload("entra-signin", [entra("seed")], { sourceId: f.config.sourceId, estateId: f.config.appId }).batch; q.enqueue(b, f.config.baseUrl); q.close();
  const db = new Database(path.join(f.outboxDirectory, "outbox.sqlite"));
  const template = db.prepare("SELECT * FROM deliveries").get(), cols = Object.keys(template);
  const insert = db.prepare(`INSERT INTO deliveries(${cols.join(",")}) VALUES(${cols.map(() => "?").join(",")})`), digest = v => require("node:crypto").createHash("sha256").update(v).digest("hex");
  db.transaction(() => {
    for (let i = 1; i < 10000; i++) {
      const receipt = "capacity-fixture:" + i, body = JSON.stringify({ ...b, receiptId: receipt });
      const row = { ...template, id: digest(JSON.stringify([f.config.baseUrl, f.config.sourceId, receipt])), receipt_id: receipt, body, body_hash: digest(body), bytes: Buffer.byteLength(body) };
      insert.run(...cols.map(c => row[c]));
    }
  })(); db.close();
  f.transport = async () => http({ value: [entra("new-record")] });
  await assert.rejects(runCollector(f), /outbox-admission-failed/); assert.equal(readState(f, "cursor"), null); const pending = readState(f, "pending"); assert.equal(pending.batches.length, 1);
  // Test-only removal simulates capacity becoming available after operator repair;
  // the shipping CLI never deletes pending deliveries.
  const repair = new Database(path.join(f.outboxDirectory, "outbox.sqlite")); repair.prepare("DELETE FROM deliveries WHERE id=?").run(template.id); repair.close();
  f.transport = async () => { throw new Error("must use pending data"); };
  assert.equal((await runCollector(f)).complete, true); assert.equal(readState(f, "pending"), null); assert.equal(queued(f).some(v => v.receiptId === pending.batches[0].receiptId), true);
});
test("idle future window does not invent a successful upstream collection time", async t => {
  const f = setup(t, "entra", { ...graphOptions, startAt: new Date(NOW).toISOString() });
  const r = await runCollector(f); assert.equal(r.complete, true); assert.equal(r.steps, 1); assert.equal(readState(f, "status"), null); assert.equal(readState(f, "cursor"), null);
});
test("retention gaps fail before fetching and original operator checkpoint remains", async t => {
  const f = setup(t, "microsoft365", { ...m365Options, startAt: "2026-10-01T00:00:00Z" });
  await assert.rejects(runCollector(f), /upstream-retention-gap/); assert.equal(readState(f, "cursor"), null); assert.equal(queued(f).length, 0);
});
test("Wazuh maxSteps bounds backlog without pretending the file is complete", async t => {
  const f = wazuhSetup(t, Array.from({ length: 101 }, (_, i) => JSON.stringify(wazuh("row-" + i))).join("\n") + "\n", 1);
  const first = await runCollector(f); assert.equal(first.records, 100); assert.equal(first.complete, false); assert.equal(first.status.lastCompletedAt, null);
  const second = await runCollector(f); assert.equal(second.records, 1); assert.equal(second.complete, true); assert.equal(queued(f).flatMap(b => b.records).length, 101);
});
test("invalid header construction rejects without leaving an armed timeout", async () => {
  const { transport } = require("../tools/platform-collectors/http");
  await assert.rejects(transport({ url: "https://127.0.0.1", headers: { Authorization: "invalid\nheader" } }));
});
test("outbox replacement and changed birth time invalidate the pinned checkpoint", async t => {
  const f = setup(t, "entra", graphOptions); f.transport = async () => http({ value: [] }); await runCollector(f);
  const filename = path.join(f.outboxDirectory, "outbox.sqlite"), originalStat = fs.statSync;
  fs.statSync = function(file, options) {
    const value = originalStat.apply(this, arguments);
    return file === filename && options?.bigint ? Object.assign(Object.create(Object.getPrototypeOf(value)), value, { birthtimeNs: value.birthtimeNs + 1n }) : value;
  };
  try { await assert.rejects(status(f), /collector-config-or-queue-changed/); } finally { fs.statSync = originalStat; }
  assert.equal((await status(f)).ok, true);
  fs.renameSync(filename, path.join(f.dir, "saved-outbox.sqlite"));
  const q = openOutbox(f.outboxDirectory); q.close();
  await assert.rejects(runCollector(f), /collector-config-or-queue-changed/); assert.equal(readState(f, "cursor").watermark, new Date(NOW).toISOString());
});
