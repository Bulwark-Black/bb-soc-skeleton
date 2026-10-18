"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { startPrivateApplication } = require("../server/private-application");
const { normalizeVendorPayload, vendorManifest } = require("../tools/vendor-adapters");
const { validateDocument } = require("../tools/validate-provider");

test("platform HTTP gateway binds credentials, atomically derives findings, indexes evidence and replays after restart", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bb-platform-http-"));
  const credentialFile=directory+"-mail-token", calls=[];
  fs.writeFileSync(credentialFile,crypto.randomBytes(24).toString("base64url"),{mode:0o600});
  const launch=()=>startPrivateApplication({stateDirectory:directory,port:0,findingNotifications:{transports:{resend:async request=>{calls.push(request);return {status:200,id:"synthetic-mail-accepted"};}}}});
  let app = await launch(), serial = 0, cookie = "";
  t.after(async () => { if (app) await app.close(); fs.rmSync(directory, { recursive: true, force: true }); fs.rmSync(credentialFile,{force:true}); });
  const password = crypto.randomBytes(30).toString("base64url"), email = "platform-owner@example.invalid";
  await app.authentication.createOperator({ email, password, name: "Synthetic platform owner" });
  const request = (route, body, headers = {}, machine = false) => fetch(app.url + route, {
    method: body === undefined ? "GET" : "POST", headers: { Connection: "close", ...(machine ? {} : { Origin: app.url, Cookie: cookie }),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const expect = async (promise, status = 200) => { const response = await promise, body = await response.json(); assert.equal(response.status, status, JSON.stringify(body)); return body; };
  const login = await request("/api/auth/sign-in/email", { email, password });
  assert.equal(login.status, 200); cookie = login.headers.getSetCookie().map(item => item.split(";")[0]).join("; "); await login.arrayBuffer();
  const command = async (command, input) => {
    const body = await expect(request("/api/v1/control/commands", { schemaVersion: "1", documentType: "connector-command-request",
      requestId: "platform-command-" + (++serial), command, requestedAt: new Date().toISOString(), input }));
    assert.equal(body.status, "succeeded", JSON.stringify(body)); return body.output;
  };
  const revision = sourceId => { const s = app.runtime.controlState().sources.find(s => s.sourceId === sourceId);
    return { sourceId, connectorInstanceId: s.connectorInstanceId, expectedRevision: s.revision }; };
  const integrations = await expect(request("/api/v1/integrations"));
  await expect(request("/api/v1/integrations", { manifest: vendorManifest("windows-eventlog"), expectedRevision: integrations.revision }), 201);
  const registered = await command("app.register", { displayName: "Synthetic Windows estate", environments: ["test"], publicPages: [] });
  const source = await command("source.setup", { appId: registered.appId, environment: "test", connectorType: "vendor.windows-eventlog",
    sourceKind: "windows-eventlog", displayName: "Synthetic domain audit", config: { "cadence-seconds": 300 }, credentialReferences: [] });
  const raw = { computer: "dc.example.invalid", channel: "Security", collectionChannel: "ForwardedEvents", logEpoch: "synthetic-epoch",
    eventRecordId: "9007199254740993", eventId: 1102, eventVersion: 0, providerName: "Microsoft-Windows-Eventlog",
    timeCreated: new Date(Date.now() - 1000).toISOString(), userData: { SubjectUserName: "synthetic-operator" } };
  const sample = normalizeVendorPayload("windows-eventlog", [raw], { sourceId: source.sourceId, estateId: registered.appId }).batch.records[0];
  await command("source.test", { ...revision(source.sourceId), recordSample: sample });
  const activated = await command("source.activate", revision(source.sourceId)), token = activated.oneTimeCredential.value;
  const body = { sourceId: source.sourceId, adapterId: "windows-eventlog", payload: [raw] }, endpoint = "/api/v1/ingest/platform";
  const machine = (value = body, headers = {}) => request(endpoint, value, { Authorization: "Bearer " + token, ...headers }, true);
  await expect(request(endpoint, body, {}, true), 401);
  await expect(machine(body, { Cookie: cookie }), 401);
  await expect(machine({ ...body, sourceId: "some-other-source" }), 403);
  await expect(machine({ ...body, adapterId: "cef" }), 403);
  await expect(machine({ ...body, unexpected: true }), 400);
  await expect(machine(body, { "Content-Encoding": "gzip" }), 415);
  await expect(machine(body, { Origin: "https://example.invalid" }), 403);
  assert.equal(app.runtime.store.stats().records, 0);
  // Enable only the reviewed rule after the application exists; config is read at startup.
  await app.close(); app = null;
  fs.writeFileSync(path.join(directory, "detection-config.json"), JSON.stringify({ schemaVersion: 1,
    applications: [{ appId: registered.appId, rules: [{ id: "windows.audit-log-cleared" }] }] }), { mode: 0o600 });
  fs.writeFileSync(path.join(directory,"finding-notifications.json"),JSON.stringify({schemaVersion:1,applications:[{appId:registered.appId,
    notifications:{provider:"resend",enabled:true,reviewed:true,from:"monitor@example.invalid",destinations:["operator@example.invalid"],credentialFile},severities:["high","critical"]}]}),{mode:0o600});
  app = await launch();
  const received = await expect(machine());
  assert.equal(received.receipt.accepted, 1, "sender receipt counts only original inputs");
  assert.equal(app.runtime.store.stats().records, 2, "one log and one finding commit together");
  const replay = await expect(machine()); assert.equal(replay.receipt.replay, true);
  const notificationUrl="/api/v1/finding-notifications?appId="+registered.appId;
  await expect(request(notificationUrl,undefined,{},true),401);
  await expect(request(notificationUrl,undefined,{Authorization:"Bearer "+token}),401);
  const mailStatus=await expect(request(notificationUrl));assert.equal(mailStatus.attempts.length,1);
  const pauseBody={paused:true,expectedRevision:mailStatus.revision,reason:"Synthetic hold",idempotencyKey:"hold"};
  await expect(request("/api/v1/finding-notifications/pause?appId="+registered.appId,{...pauseBody,actor:"forged"}),400);
  await expect(request("/api/v1/finding-notifications/pause?appId="+registered.appId,pauseBody));
  await app.findingNotifications.tick();assert.equal(calls.length,0);
  await expect(request("/api/v1/finding-notifications/pause?appId="+registered.appId,{...pauseBody,paused:false,expectedRevision:mailStatus.revision+1,idempotencyKey:"resume"}));
  await app.findingNotifications.tick();assert.equal(calls.length,1);
  assert.equal((await expect(request(notificationUrl))).attempts[0].state,"accepted");
  await expect(request("/api/v1/finding-notifications/test-send?appId="+registered.appId,{recipient:"unconfigured@example.invalid",reason:"Synthetic check",idempotencyKey:"test"}),400);

  const observations = await expect(request("/api/v1/integrations/observations?sourceId=" + source.sourceId));
  assert.equal(observations.records.length, 2);
  const finding = observations.records.find(r => r.kind === "finding");
  assert.equal(finding.payload.ruleRef, "windows.audit-log-cleared");
  assert.equal(finding.payload.fields.evidenceRecordId, sample.recordId);
  const filtered = app.runtime.store.logQuery({ sourceId: source.sourceId, search: "9007199254740993" });
  assert.ok(filtered.records.some(r => r.recordId === sample.recordId), "exact structured event evidence is searchable");
  const rules = await expect(request("/api/v1/detection/rules?appId=" + registered.appId));
  assert.equal(rules.rules.find(r => r.id === "windows.audit-log-cleared").enabled, true);
  const page = await expect(request("/api/v1/pages?route=/rules&appId=" + registered.appId));
  validateDocument(page); assert.ok(page.panels.some(p => p.id === "portable-detection-rules"));
  await expect(request("/api/v1/pages?route=/rules&appId=missing-application"), 404);
  await expect(request("/api/v1/pages?route=/rules&appId=" + registered.appId + "&appId=missing-application"), 400);
  const triage = await expect(request("/api/v1/pages?route=/triage&appId=" + registered.appId));
  validateDocument(triage); assert.match(JSON.stringify(triage), /Windows Security audit log was cleared/);
  await expect(machine({ ...body, payload: [raw, { ...raw, eventRecordId: "2", timeCreated: "invalid" }] }), 400);
  assert.equal(app.runtime.store.stats().records, 2, "one malformed member prevents partial acceptance");
  const db = app.runtime.store.db;
  db.exec("CREATE TRIGGER synthetic_reject_finding BEFORE INSERT ON telemetry_records WHEN NEW.kind='finding' BEGIN SELECT RAISE(ABORT,'synthetic transaction refusal'); END;");
  const next = { ...body, payload: [{ ...raw, eventRecordId: "9007199254740994" }] };
  const failed = await machine(next); assert.ok(failed.status >= 400); await failed.arrayBuffer();
  assert.equal(app.runtime.store.stats().records, 2);
  assert.equal(db.prepare("SELECT count(*) n FROM detection_matches").get().n, 1, "failed admission rolls back detection ledger");
  assert.equal(db.prepare("SELECT count(*) n FROM finding_mail_notices").get().n,1,"failed admission rolls back notification queue");
  db.exec("DROP TRIGGER synthetic_reject_finding");
  await expect(machine(next)); assert.equal(app.runtime.store.stats().records, 4);
  await app.close(); app = null; app = await launch();
  assert.equal((await expect(machine())).receipt.replay, true);
  assert.equal(app.runtime.store.stats().records, 4);
  await command("source.pause", revision(source.sourceId));
  await expect(machine(next), 409);
});
