"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { adapters } = require("../tools/vendors/cloud");
const { validateNormalizedRecord } = require("../tools/ingest-contract");
const aws = adapters.find(adapter => adapter.id === "aws-cloudtrail");
const gcp = adapters.find(adapter => adapter.id === "gcp-audit");
const cf = adapters.find(adapter => adapter.id === "cloudflare-firewall");
const AT = "2026-09-29T10:20:30Z";

function cloudTrail(overrides = {}) {
  return { eventID: "synthetic-cloudtrail-event-1", eventTime: AT, eventName: "CreateBucket", eventSource: "s3.amazonaws.com",
    awsRegion: "us-east-1", eventType: "AwsApiCall", recipientAccountId: "000000000001", readOnly: false,
    userIdentity: { arn: "arn:aws:iam::000000000001:user/synthetic-operator" }, ...overrides };
}
function cloudAudit(overrides = {}) {
  return { insertId: "synthetic-google-entry-1", timestamp: AT,
    logName: "projects/synthetic-project/logs/cloudaudit.googleapis.com%2Factivity",
    protoPayload: { "@type": "type.googleapis.com/google.cloud.audit.AuditLog", serviceName: "storage.googleapis.com",
      methodName: "storage.buckets.create", resourceName: "projects/_/buckets/synthetic-bucket",
      authenticationInfo: { principalEmail: "synthetic-reader@example.invalid" } }, ...overrides };
}
function firewall(overrides = {}) {
  return { RayID: "synthetic-ray-1", Datetime: AT, Action: "block", Source: "waf", RuleID: "synthetic-rule-1", MatchIndex: 0, ...overrides };
}
function validate(records) {
  for (const [index, record] of records.entries()) {
    assert.deepEqual(Object.keys(record).sort(), ["kind", "observedAt", "payload", "upstreamId"]);
    assert.match(record.upstreamId, /^[a-z-]+:[0-9a-f]{64}$/);
    validateNormalizedRecord({ schemaVersion: "1", documentType: "normalized-record", recordId: "synthetic-record-" + index,
      sourceId: "synthetic-source", estateId: "synthetic-app", kind: record.kind, observedAt: record.observedAt, payload: record.payload });
  }
  return records;
}

test("CloudTrail known S3 and LookupEvents envelopes normalize to stable canonical audit facts", () => {
  const event = cloudTrail();
  const expected = validate(aws.normalize({ Records: [event] }));
  assert.deepEqual(expected, aws.normalize(event));
  assert.deepEqual(expected, aws.normalize([event]));
  assert.deepEqual(expected, aws.normalize({ Events: [{ EventId: event.eventID, CloudTrailEvent: JSON.stringify(event) }], NextToken: "page-2" }));
  assert.equal(expected[0].kind, "audit.event"); assert.equal(expected[0].payload.state, "unknown");
  assert.equal(expected[0].observedAt, "2026-09-29T10:20:30.000Z");
  assert.notEqual(expected[0].upstreamId, aws.normalize(cloudTrail({ recipientAccountId: "000000000002" }))[0].upstreamId);
  assert.notEqual(expected[0].upstreamId, aws.normalize(cloudTrail({ eventID: "synthetic-cloudtrail-event-2" }))[0].upstreamId);
  assert.deepEqual(aws.normalize({ Records: [] }), []);
});

test("CloudTrail console outcome is authentication only with an actual principal", () => {
  const event = cloudTrail({ eventSource: "signin.amazonaws.com", eventName: "ConsoleLogin", responseElements: { ConsoleLogin: "Success" } });
  const [success] = validate(aws.normalize(event));
  assert.equal(success.kind, "authentication.event"); assert.equal(success.payload.state, "ok");
  const [failure] = validate(aws.normalize({ ...event, responseElements: { ConsoleLogin: "Failure" } }));
  assert.equal(failure.payload.state, "failed");
  assert.equal(aws.normalize({ ...event, userIdentity: undefined })[0].kind, "audit.event");
  assert.equal(aws.normalize(cloudTrail({ errorCode: "AccessDenied" }))[0].payload.state, "failed");
  assert.throws(() => aws.normalize({ ...event, responseElements: { ConsoleLogin: "Maybe" } }), /outcome/);
});

test("CloudTrail drops raw parameters, response details, email, addresses, and arbitrary messages", () => {
  const sensitive = crypto.randomBytes(24).toString("hex");
  const event = cloudTrail({ userIdentity: { arn: sensitive, userName: sensitive, accessKeyId: sensitive },
    sourceIPAddress: "203.0.113.12", userAgent: sensitive, requestParameters: { value: sensitive },
    responseElements: { value: sensitive }, errorMessage: sensitive, additionalEventData: { value: sensitive } });
  const output = JSON.stringify(validate(aws.normalize(event)));
  assert.ok(!output.includes(sensitive)); assert.ok(!output.includes("203.0.113.12"));
  assert.ok(!output.includes("requestParameters")); assert.ok(!output.includes("errorMessage"));
});

test("CloudTrail rejects malformed envelopes, partial batches, ambiguous IDs, and impossible timestamps", () => {
  for (const input of [{ error: "synthetic error" }, { Records: [cloudTrail()], errors: [] }, { Records: [cloudTrail()], unexpected: true },
    { Events: [{ EventId: "different", CloudTrailEvent: JSON.stringify(cloudTrail()) }] },
    { Events: [{ CloudTrailEvent: "not JSON" }] }, { Records: [cloudTrail(), { eventID: "missing-time" }] },
    cloudTrail({ eventTime: "2026-02-30T00:00:00Z" }), cloudTrail({ eventTime: "2026-09-29" }), cloudTrail({ eventID: "" }),
    cloudTrail({ readOnly: "false" }), { Records: Array(1001).fill(cloudTrail()) }]) assert.throws(() => aws.normalize(input));
});

test("Google AuditLog supports documented LogEntry and entries.list pages without losing scoped identity", () => {
  const event = cloudAudit();
  const expected = validate(gcp.normalize({ entries: [event], nextPageToken: "page-2" }));
  assert.deepEqual(expected, gcp.normalize(event)); assert.deepEqual(expected, gcp.normalize([event]));
  assert.equal(expected[0].kind, "audit.event"); assert.equal(expected[0].payload.state, "ok");
  assert.notEqual(expected[0].upstreamId, gcp.normalize(cloudAudit({ logName: "projects/another-project/logs/cloudaudit.googleapis.com%2Factivity" }))[0].upstreamId);
  assert.notEqual(expected[0].upstreamId, gcp.normalize(cloudAudit({ timestamp: "2026-09-29T10:20:31Z" }))[0].upstreamId);
  assert.deepEqual(gcp.normalize({ entries: [], nextPageToken: "page-2" }), []);
  assert.deepEqual(gcp.normalize({ nextPageToken: "page-2" }), []);
  assert.deepEqual(gcp.normalize({}), []);
});

test("Google nanosecond and offset timestamps normalize without collapsing distinct submillisecond entries", () => {
  const first = validate(gcp.normalize(cloudAudit({ timestamp: "2026-09-29T10:20:30.123456789Z" })))[0];
  const later = gcp.normalize(cloudAudit({ timestamp: "2026-09-29T10:20:30.123456790Z" }))[0];
  const offset = gcp.normalize(cloudAudit({ timestamp: "2026-09-29T12:20:30.123456789+02:00" }))[0];
  assert.equal(first.observedAt, "2026-09-29T10:20:30.123Z");
  assert.equal(first.observedAt, later.observedAt); assert.notEqual(first.upstreamId, later.upstreamId);
  assert.deepEqual(first, offset);
});

test("Google audit statuses retain failure semantics but never become invented vulnerabilities", () => {
  const event = cloudAudit(); event.protoPayload.status = { code: 7, message: "raw error not retained" };
  const [result] = validate(gcp.normalize(event));
  assert.equal(result.kind, "audit.event"); assert.equal(result.payload.state, "failed");
  assert.equal(result.payload.fields.statusCode, 7); assert.equal(result.payload.severity, undefined);
  assert.ok(!JSON.stringify(result).includes("raw error"));
});

test("Google audit allowlist discards payloads, arbitrary labels, caller addresses and principal text", () => {
  const sensitive = crypto.randomBytes(24).toString("hex"), event = cloudAudit();
  Object.assign(event, { labels: { value: sensitive }, httpRequest: { requestUrl: sensitive }, trace: sensitive });
  Object.assign(event.protoPayload, { request: { value: sensitive }, response: { value: sensitive }, metadata: { value: sensitive },
    authenticationInfo: { principalSubject: sensitive, principalEmail: sensitive }, requestMetadata: { callerIp: "203.0.113.42", callerSuppliedUserAgent: sensitive } });
  const output = JSON.stringify(validate(gcp.normalize(event)));
  assert.ok(!output.includes(sensitive)); assert.ok(!output.includes("203.0.113.42"));
  assert.ok(!output.includes("synthetic-bucket"));
});

test("Google adapter refuses ordinary app logs, partial API errors, missing identities, and oversized pages", () => {
  const event = cloudAudit();
  for (const input of [{ error: { code: 403 } }, { entries: [event], error: {} }, { entries: [event], unknown: true },
    { ...event, insertId: undefined }, { ...event, logName: "unscoped" }, { ...event, timestamp: "2026-02-30T00:00:00.000000001Z" },
    { ...event, protoPayload: { ...event.protoPayload, "@type": "type.googleapis.com/example.Other" } },
    { ...event, textPayload: "not an audit payload" }, { ...event, protoPayload: { ...event.protoPayload, status: { code: -1 } } },
    { entries: [event, {}] }, { entries: Array(1001).fill(event) }]) assert.throws(() => gcp.normalize(input));
});

test("Cloudflare raw Logpush observations use composite event identity instead of request-only RayID", () => {
  const expected = validate(cf.normalize(firewall()));
  assert.deepEqual(expected, cf.normalize([firewall()]));
  assert.equal(expected[0].kind, "network.event"); assert.equal(expected[0].payload.state, "unknown");
  assert.equal(expected[0].payload.severity, undefined);
  for (const change of [{ Action: "log" }, { MatchIndex: 1 }, { RuleID: "another-rule" }, { Source: "firewallcustom" },
    { Datetime: "2026-09-29T10:20:30.000000001Z" }]) assert.notEqual(expected[0].upstreamId, cf.normalize(firewall(change))[0].upstreamId);
  assert.deepEqual(cf.normalize([]), []);
});

test("Cloudflare discards client information, request/query text, rule refs and product metadata", () => {
  const sensitive = crypto.randomBytes(24).toString("hex");
  const event = firewall({ ClientIP: "203.0.113.14", ClientRequestQuery: sensitive, ClientRequestPath: sensitive,
    ClientRequestHost: sensitive, UserAgent: sensitive, Metadata: { value: sensitive }, RequestHeaders: { value: sensitive },
    Ref: sensitive, ZoneName: sensitive, RuleID: sensitive, EdgeResponseStatus: 403 });
  const [result] = validate(cf.normalize(event)), output = JSON.stringify(result);
  assert.equal(result.payload.fields.edgeResponseStatus, 403);
  assert.ok(!output.includes(sensitive)); assert.ok(!output.includes("203.0.113.14"));
});

test("Cloudflare requires precise supported export shape; rejects unsafe numeric nano time and GraphQL samples", () => {
  for (const input of [{ data: { viewer: { zones: [] } }, errors: null }, { success: false, result: [] },
    firewall({ Datetime: 1790677230123456789 }), firewall({ Datetime: "1790677230123456789" }), firewall({ Datetime: "2026-09-31T00:00:00Z" }),
    firewall({ RayID: undefined }), firewall({ Source: undefined }), firewall({ Action: "synthetic-unknown" }),
    firewall({ MatchIndex: -1 }), firewall({ EdgeResponseStatus: "403" }), [firewall(), {}], Array(1001).fill(firewall())]) {
    assert.throws(() => cf.normalize(input));
  }
});

test("cloud adapters reject accessors and non-JSON objects without executing getters", () => {
  for (const [adapter, fixture] of [[aws, cloudTrail], [gcp, cloudAudit], [cf, firewall]]) {
    let read = false;
    const event = fixture(); Object.defineProperty(event, "unselected", { enumerable: true, get() { read = true; return "ignored"; } });
    assert.throws(() => adapter.normalize(event)); assert.equal(read, false);
    assert.throws(() => adapter.normalize(new Date()));
  }
});
