"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { adapters } = require("../tools/vendors/platforms");
const { validateNormalizedRecord } = require("../tools/ingest-contract");
const byId = Object.fromEntries(adapters.map(value => [value.id, value]));
const AT = "2026-10-01T12:34:56.123Z";
const NS = "1790858096123456789";
const syslog = message => `<34>1 ${AT} synthetic-host synthetic-app 7 event - ${message || "Synthetic event"}`;
const cef = extension => `CEF:0|Synthetic Vendor|Synthetic Product|1|synthetic-class|Synthetic event|7|${extension || "rt=1790858096123 act=deny outcome=failure"}`;
function otlp(log = {}, resource = {}, scope = {}) {
  return { resourceLogs: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "synthetic-service" } }], ...resource },
    scopeLogs: [{ scope: { name: "synthetic-scope", version: "1", ...scope }, logRecords: [{ timeUnixNano: NS, body: { stringValue: "Synthetic event" }, ...log }] }] }] };
}
function m365(overrides = {}) {
  return { Id: "00000000-0000-4000-8000-000000000001", OrganizationId: "00000000-0000-4000-8000-000000000002",
    CreationTime: AT, Operation: "SyntheticOperation", Workload: "SyntheticWorkload", RecordType: 1, ...overrides };
}
function normalize(id, input) {
  const mapped = byId[id].normalize(input);
  for (const [index, item] of mapped.entries()) {
    assert.equal(item.kind, "log.event");
    assert.match(item.upstreamId, /^[a-z0-9-]+:[a-f0-9]{64}$/);
    validateNormalizedRecord({ schemaVersion: "1", documentType: "normalized-record", sourceId: "synthetic-source", estateId: "synthetic-app",
      recordId: "synthetic-" + index, kind: item.kind, observedAt: item.observedAt,
      payload: { ...item.payload, fields: { ...item.payload.fields, adapterId: id, adapterVersion: "1" } } });
  }
  return mapped;
}

test("platform catalog declares bounded supplied-log profiles with primary documentation", () => {
  assert.deepEqual(adapters.map(value => value.id), ["syslog-rfc5424", "cef", "otlp-logs", "microsoft365-audit"]);
  for (const value of adapters) {
    assert.deepEqual(value.recordKinds, ["log.event"]);
    assert.ok(value.docs.length); assert.ok(value.formats.length); assert.ok(value.description.length);
    assert.ok(value.docs.every(doc => new URL(doc.url).protocol === "https:"));
  }
});

test("RFC5424 maps facility/severity and source header facts without treating MSGID as unique", () => {
  const [first] = normalize("syslog-rfc5424", syslog());
  assert.equal(first.observedAt, AT); assert.equal(first.payload.state, "unknown");
  assert.equal(first.payload.severity, "critical"); assert.equal(first.payload.fields.facility, 4);
  assert.equal(first.payload.fields.originalSeverity, 2); assert.equal(first.payload.fields.hostname, "synthetic-host");
  assert.deepEqual([first], normalize("syslog-rfc5424", { message: syslog() }));
  assert.notEqual(first.upstreamId, normalize("syslog-rfc5424", syslog("Another synthetic event"))[0].upstreamId);
  const nil = normalize("syslog-rfc5424", `<165>1 ${AT} - - - - - Synthetic event`)[0];
  assert.equal(nil.payload.fields.hostname, undefined); assert.equal(nil.payload.fields.appName, undefined);
});

test("RFC5424 preserves structured data IDs, repeated params, required escapes and unknown escapes", () => {
  const raw = `<34>1 ${AT} h a p m [sample@32473 key="one" key="two" escaped="a\\]b\\\"c\\\\d\\q"] \uFEFFSynthetic event`;
  const [record] = normalize("syslog-rfc5424", raw);
  assert.equal(record.payload.message, "Synthetic event");
  const data = JSON.parse(record.payload.fields.structuredData);
  assert.equal(data[0].id, "sample@32473");
  assert.deepEqual(data[0].params, [["key", "one"], ["key", "two"], ["escaped", 'a]b"c\\d\\q']]);
});

test("RFC5424 rejects guessed/unknown times, malformed structure, empty bodies and oversize inputs atomically", () => {
  for (const input of [syslog().replace(AT, "-"), syslog().replace(AT, "Oct 1 12:34:56"), syslog().replace(AT, "2026-02-30T12:34:56Z"),
    syslog().replace(AT, "2026-10-01T12:34:56-00:00"), syslog().replace(AT, "2026-10-01T12:34:56.1234567Z"),
    syslog().replace("<34>", "<192>"), syslog().replace(">1 ", ">2 "), `<34>1 ${AT} h a p m [x a="bad]"] Synthetic`,
    `<34>1 ${AT} h a p m [x][x] Synthetic`, `<34>1 ${AT} h a p m -`, syslog("x".repeat(4001)),
    { message: syslog(), timestamp: AT }, [syslog(), "invalid"], []]) assert.throws(() => normalize("syslog-rfc5424", input));
});

test("syslog submillisecond timestamp identity is retained and secrets in structured fields are rejected", () => {
  const a = normalize("syslog-rfc5424", syslog().replace(AT, "2026-10-01T12:34:56.123001Z"))[0];
  const b = normalize("syslog-rfc5424", syslog().replace(AT, "2026-10-01T12:34:56.123002Z"))[0];
  assert.equal(a.observedAt, b.observedAt); assert.notEqual(a.upstreamId, b.upstreamId);
  assert.throws(() => normalize("syslog-rfc5424", `<34>1 ${AT} h a p m [x accessToken="redacted"] Synthetic`));
});

test("CEF parses escaped pipes/backslashes in headers and equals/newlines/spaces/pipes in extensions", () => {
  const raw = 'CEF:0|Synthetic \\| Vendor|Synthetic \\\\ Product|1|class|Name=One|High|rt=1790858096123 msg=First\\nsecond with \\= and \\\\ and | act=blocked two words outcome=failure';
  const [record] = normalize("cef", raw);
  assert.equal(record.observedAt, AT); assert.equal(record.payload.severity, "high");
  assert.equal(record.payload.fields.vendor, "Synthetic | Vendor"); assert.equal(record.payload.fields.product, "Synthetic \\ Product");
  assert.equal(record.payload.message, "First\nsecond with = and \\ and |");
  assert.equal(record.payload.fields.action, "blocked two words"); assert.equal(record.payload.fields.outcome, "failure");
  assert.equal(record.payload.fields["cef.msg"], record.payload.message);
  assert.equal(record.payload.state, "unknown");
});

test("CEF preserves extension spacing and empty values without splitting on escaped equals", () => {
  const [record] = normalize("cef", cef("rt=1790858096123 msg=one  act=two cs1= cs2=contains key\\=literal"));
  assert.equal(record.payload.message, "one "); assert.equal(record.payload.fields["cef.cs1"], "");
  assert.equal(record.payload.fields["cef.cs2"], "contains key=literal");
});

test("CEF explicit time precedence preserves receipt/header facts and never invents a year", () => {
  const original = cef("rt=1790858096123 start=1790858096000 end=1790858097000");
  const [record] = normalize("cef", { message: syslog(original), timestamp: "2026-10-01T13:00:00Z" });
  assert.equal(record.observedAt, "2026-10-01T12:34:57.000Z");
  assert.equal(record.payload.fields.timeBasis, "cef.end"); assert.equal(record.payload.fields["cef.rt"], "1790858096123");
  assert.equal(record.payload.fields["syslog.timestamp"], AT); assert.equal(record.payload.fields.wrapperTimestamp, "2026-10-01T13:00:00Z");
  assert.equal(normalize("cef", { message: cef("act=deny"), timestamp: AT })[0].observedAt, AT);
  assert.equal(normalize("cef", syslog(cef("act=deny")))[0].payload.fields.timeBasis, "syslog.timestamp");
  for (const input of [cef("act=deny"), cef("rt=Oct 01 2026 12:34:56"), cef("rt=2026-10-01T12:34:56"), `Oct 01 12:34:56 host ${cef()}`]) assert.throws(() => normalize("cef", input));
});

test("CEF stable identities scope supplied event IDs by device and use a content digest otherwise", () => {
  const record = normalize("cef", cef("rt=1790858096123 externalId=synthetic-id dvchost=synthetic-host msg=first"))[0];
  assert.equal(record.upstreamId, normalize("cef", cef("msg=changed dvchost=synthetic-host externalId=synthetic-id rt=1790858096123"))[0].upstreamId);
  assert.notEqual(record.upstreamId, normalize("cef", cef("rt=1790858096123 externalId=synthetic-id dvchost=another-host msg=first"))[0].upstreamId);
  assert.equal(normalize("cef", cef("rt=1790858096123 act=deny"))[0].upstreamId, normalize("cef", cef("act=deny rt=1790858096123"))[0].upstreamId);
});

test("CEF refuses invalid escapes/duplicate keys, secret-bearing fields and canonical budget overflow", () => {
  for (const input of [cef("rt=1790858096123 msg=bad\\q"), cef("rt=1790858096123 msg=bad=equals"), cef("rt=1790858096123 msg=one msg=two"),
    cef("rt=1790858096123 accessToken=redacted"), cef("rt=1790858096123 msg=" + "a".repeat(1001)),
    cef("rt=1790858096123 " + Array.from({ length: 62 }, (_, i) => `cs${i}=x`).join(" ")), cef().replace("|7|", "|11|"),
    cef().replace("Synthetic Vendor", "Synthetic\\nVendor"), [cef(), "invalid"]]) assert.throws(() => normalize("cef", input));
});

test("OTLP preserves resource, scope and log attribute namespaces and scalar type metadata", () => {
  const log = { severityNumber: 17, severityText: "ERROR", eventName: "synthetic-event", attributes: [
    { key: "event.action", value: { stringValue: "deny" } }, { key: "event.outcome", value: { stringValue: "failure" } },
    { key: "counter", value: { intValue: "9223372036854775807" } }, { key: "enabled", value: { boolValue: false } }] };
  const [record] = normalize("otlp-logs", otlp(log, {}, { attributes: [{ key: "name", value: { stringValue: "scope-attribute" } }] }));
  const fields = record.payload.fields;
  assert.equal(fields["resource.service.name"], "synthetic-service"); assert.equal(fields["scope.name"], "scope-attribute");
  assert.equal(fields.scopeName, "synthetic-scope"); assert.equal(fields["log.counter"], "9223372036854775807");
  assert.equal(fields["log.enabled"], false); assert.equal(fields.action, "deny"); assert.equal(fields.outcome, "failure");
  assert.equal(fields.originalSeverity, "ERROR"); assert.equal(record.payload.severity, "high");
  assert.equal(JSON.parse(fields.attributeTypes)["log.counter"], "intValue"); assert.equal(fields.bodyType, "stringValue");
});

test("OTLP converts nanoseconds using integer division and keeps exact nanoseconds in identities", () => {
  const [first] = normalize("otlp-logs", otlp());
  const [second] = normalize("otlp-logs", otlp({ timeUnixNano: String(BigInt(NS) + 1n) }));
  assert.equal(first.observedAt, AT); assert.equal(first.payload.fields.timeUnixNano, NS);
  assert.equal(second.observedAt, first.observedAt); assert.notEqual(first.upstreamId, second.upstreamId);
  const [max] = normalize("otlp-logs", otlp({ timeUnixNano: "18446744073709551615" }));
  assert.equal(max.observedAt, "2554-07-21T23:34:33.709Z");
  assert.throws(() => normalize("otlp-logs", otlp({ timeUnixNano: Number(NS) })));
  assert.throws(() => normalize("otlp-logs", otlp({ timeUnixNano: "18446744073709551616" })));
});

test("OTLP supplied observed time fallback is explicit; default zeros do not become current time", () => {
  const [record] = normalize("otlp-logs", otlp({ timeUnixNano: "0", observedTimeUnixNano: NS }));
  assert.equal(record.observedAt, AT); assert.equal(record.payload.fields.timeBasis, "observedTimeUnixNano");
  for (const input of [otlp({ timeUnixNano: undefined }), otlp({ timeUnixNano: "0", observedTimeUnixNano: "0" }), otlp({ timeUnixNano: "-1" }),
    otlp({ timeUnixNano: "1.5" })]) assert.throws(() => normalize("otlp-logs", input));
});

test("OTLP complex AnyValues preserve typed structure, IDs are hexadecimal, and body types cannot collapse", () => {
  const complex = { kvlistValue: { values: [{ key: "items", value: { arrayValue: { values: [{ intValue: "9007199254740993" }, { stringValue: "9007199254740993" }] } } }] } };
  const [record] = normalize("otlp-logs", otlp({ body: complex, traceId: "A".repeat(32), spanId: "B".repeat(16), flags: 1 }));
  assert.deepEqual(JSON.parse(record.payload.message), complex); assert.equal(record.payload.fields.traceId, "a".repeat(32));
  assert.notEqual(normalize("otlp-logs", otlp({ body: { intValue: "1" } }))[0].upstreamId,
    normalize("otlp-logs", otlp({ body: { stringValue: "1" } }))[0].upstreamId);
  assert.throws(() => normalize("otlp-logs", otlp({ traceId: "YWJjZA==" })));
});

test("OTLP malformed, secret-bearing, duplicate, oversized, and empty inputs fail without partial output", () => {
  for (const input of [{ resourceLogs: [] }, otlp({ body: { stringValue: "", intValue: "1" } }), otlp({ body: { stringValue: "" } }),
    otlp({ body: { doubleValue: Infinity } }), otlp({ severityNumber: 25 }), otlp({ attributes: [
      { key: "same", value: { stringValue: "a" } }, { key: "same", value: { stringValue: "b" } }] }),
    otlp({ attributes: [{ key: "accessToken", value: { stringValue: "redacted" } }] }),
    otlp({ body: { kvlistValue: { values: [{ key: "password", value: { stringValue: "redacted" } }] } } }),
    otlp({}, { attributes: [{ key: "service.name", value: { stringValue: "x".repeat(1001) } }] }),
    otlp({ attributes: [{ key: "not a canonical key", value: { stringValue: "x" } }] }),
    otlp({ attributes: Array.from({ length: 70 }, (_, i) => ({ key: "a" + i, value: { stringValue: "x" } })) }),
    otlp({ unknown: "do not silently drop" }), otlp({ attributes: null }), [otlp(), {}]]) assert.throws(() => normalize("otlp-logs", input));
});

test("OTLP multiple resources/scopes produce individual logs; dropped-attribute counts remain facts", () => {
  const input = otlp({ droppedAttributesCount: 2 }, { droppedAttributesCount: 3 }, { droppedAttributesCount: 4 });
  input.resourceLogs.push(otlp({ body: { stringValue: "Second synthetic event" } }).resourceLogs[0]);
  const records = normalize("otlp-logs", input);
  assert.equal(records.length, 2); assert.equal(records[0].payload.fields.droppedAttributesCount, 2);
  assert.equal(records[0].payload.fields.resourceDroppedAttributesCount, 3);
  assert.equal(records[0].payload.fields.scopeDroppedAttributesCount, 4);
  assert.equal(records[0].payload.state, "unknown");
  const tooMany = otlp(); tooMany.resourceLogs[0].scopeLogs[0].logRecords = Array(1001).fill(tooMany.resourceLogs[0].scopeLogs[0].logRecords[0]);
  assert.throws(() => normalize("otlp-logs", tooMany));
});

test("Microsoft365 imports selected common audit facts, schema-defined UTC and scoped identities", () => {
  const [record] = normalize("microsoft365-audit", m365({ CreationTime: "2026-10-01T12:34:56.123", UserId: "synthetic-user@example.invalid", UserType: 0,
    ResultStatus: "Succeeded", ClientIP: "192.0.2.1", Parameters: [{ Name: "ignored", Value: "not retained" }] }));
  assert.equal(record.observedAt, AT); assert.equal(record.payload.fields.provider, "microsoft365");
  assert.equal(record.payload.fields.action, "SyntheticOperation"); assert.equal(record.payload.fields.outcome, "Succeeded");
  assert.equal(record.payload.fields.sourceAddress, "192.0.2.1"); assert.match(record.payload.identityRef, /^m365-user:/);
  assert.ok(!JSON.stringify(record).includes("synthetic-user@example.invalid")); assert.ok(!JSON.stringify(record).includes("not retained"));
  assert.notEqual(record.upstreamId, normalize("microsoft365-audit", m365({ OrganizationId: "another-synthetic-organization" }))[0].upstreamId);
});

test("Microsoft365 overloaded outcomes never fabricate authentication verdicts", () => {
  for (const ResultStatus of ["Succeeded", "PartiallySucceeded", "Failed", "True", "False", 2]) {
    const [record] = normalize("microsoft365-audit", m365({ Workload: "AzureActiveDirectory", ResultStatus, LogonError: "SyntheticFailure" }));
    assert.equal(record.payload.state, "unknown"); assert.equal(record.kind, "log.event");
    assert.equal(record.payload.fields.outcome, ResultStatus); assert.equal(record.payload.fields.logonError, "SyntheticFailure");
    assert.equal(record.payload.fields.outcomeScope, "provider-operation-only");
  }
});

test("Microsoft365 rejects listing blobs, missing original fields and invalid timestamps atomically", () => {
  for (const input of [{ contentUri: "https://example.invalid/content", contentId: "synthetic" }, m365({ Id: undefined }), m365({ OrganizationId: undefined }),
    m365({ CreationTime: "2026-02-30T00:00:00" }), m365({ CreationTime: "2026-10-01" }), m365({ Operation: "" }),
    m365({ RecordType: "1" }), m365({ ResultStatus: {} }), [m365(), {}], Array(1001).fill(m365())]) assert.throws(() => normalize("microsoft365-audit", input));
});

test("direct adapter callers cannot execute getter payloads or mutate input", () => {
  for (const [id, fixture] of [["syslog-rfc5424", () => ({ message: syslog() })], ["cef", () => ({ message: cef() })], ["otlp-logs", () => otlp()], ["microsoft365-audit", () => m365()]]) {
    const value = fixture(), before = JSON.stringify(value); normalize(id, value); assert.equal(JSON.stringify(value), before);
    let read = false; Object.defineProperty(value, "unselected", { enumerable: true, get() { read = true; throw new Error("must not run"); } });
    assert.throws(() => normalize(id, value)); assert.equal(read, false);
  }
});


test("Microsoft365 maps only the reviewed audit-ingestion parameter as a canonical boolean", () => {
  for (const Value of [false, "False", "false", "FALSE", true, "True"]) {
    const [record] = normalize("microsoft365-audit", m365({ Operation: "Set-AdminAuditLogConfig", Workload: "Exchange", Parameters: [
      { Name: "UnifiedAuditLogIngestionEnabled", Value }, { Name: "Unselected", Value: "not retained" }] }));
    assert.equal(record.payload.fields["m365.UnifiedAuditLogIngestionEnabled"], String(Value).toLowerCase() === "true" ? "True" : "False");
    assert.equal(record.payload.state, "unknown"); assert.ok(!JSON.stringify(record).includes("not retained"));
  }
  assert.equal(normalize("microsoft365-audit", m365({ Parameters: [{ Name: "UnifiedAuditLogIngestionEnabled", Value: "False" }] }))[0]
    .payload.fields["m365.UnifiedAuditLogIngestionEnabled"], undefined);
  for (const Parameters of [[{ Name: "UnifiedAuditLogIngestionEnabled", Value: "invalid" }],
    [{ Name: "UnifiedAuditLogIngestionEnabled", Value: "False" }, { Name: "UnifiedAuditLogIngestionEnabled", Value: "True" }],
    [{ Name: "UnifiedAuditLogIngestionEnabled", Value: 0 }], "unparsed parameters"]) {
    assert.throws(() => normalize("microsoft365-audit", m365({ Operation: "Set-AdminAuditLogConfig", Parameters })));
  }
});

test("registered platform batches keep stable source-bound identity and reject conflicting upstream event IDs", () => {
  const { normalizeVendorPayload, parseVendorText } = require("../tools/vendor-adapters");
  const context = { sourceId: "synthetic-source", estateId: "synthetic-app" };
  const inputs = { "syslog-rfc5424": { message: syslog() }, cef: { message: cef() }, "otlp-logs": otlp(), "microsoft365-audit": m365() };
  for (const [id, input] of Object.entries(inputs)) {
    const first = normalizeVendorPayload(id, input, context);
    assert.equal(first.bodyHash, normalizeVendorPayload(id, parseVendorText(JSON.stringify(input)), context).bodyHash);
    assert.equal(first.batch.records.length, 1); assert.equal(first.summary.coverage, "supplied-events-only");
    assert.equal(first.summary.automaticPolling, false);
    assert.equal(first.batch.records[0].payload.fields.adapterId, id);
    assert.notEqual(first.bodyHash, normalizeVendorPayload(id, input, { ...context, estateId: "another-synthetic-app" }).bodyHash);
    assert.notEqual(first.bodyHash, normalizeVendorPayload(id, input, { ...context, sourceId: "another-synthetic-source" }).bodyHash);
  }
  const duplicate = normalizeVendorPayload("microsoft365-audit", [m365(), m365()], context);
  assert.equal(duplicate.batch.records.length, 1); assert.equal(duplicate.summary.duplicatesWithinInput, 1);
  assert.throws(() => normalizeVendorPayload("microsoft365-audit", [m365(), m365({ Operation: "ChangedOperation" })], context), /conflicting content/);
  assert.throws(() => normalizeVendorPayload("cef", [cef("rt=1790858096123 externalId=synthetic-id msg=one"),
    cef("rt=1790858096123 externalId=synthetic-id msg=two")], context), /conflicting content/);
});

test("actual platform normalization satisfies SSH and Exchange rule selectors, with scoped near-miss negatives", () => {
  const { BY_ID, matches } = require("../server/detection-rules");
  const { normalizeVendorPayload } = require("../tools/vendor-adapters");
  const context = { sourceId: "synthetic-source", estateId: "synthetic-app" };
  const mapped = (id, input) => normalizeVendorPayload(id, input, context).batch.records[0];
  const ssh = BY_ID.get("linux.ssh-failure-burst");
  const sshMessage = syslog("Failed password for synthetic user from 192.0.2.1 port 12345 ssh2").replace("synthetic-app", "sshd");
  assert.equal(matches(ssh, mapped("syslog-rfc5424", { message: sshMessage })), true);
  assert.equal(matches(ssh, mapped("syslog-rfc5424", { message: sshMessage.replace("sshd", "another-app") })), false);
  assert.equal(matches(ssh, mapped("syslog-rfc5424", { message: sshMessage.replace("Failed password", "Accepted password") })), false);
  const audit = BY_ID.get("microsoft365.audit-disabled");
  const change = m365({ Workload: "Exchange", Operation: "Set-AdminAuditLogConfig", Parameters: [{ Name: "UnifiedAuditLogIngestionEnabled", Value: "False" }] });
  assert.equal(matches(audit, mapped("microsoft365-audit", change)), true);
  for (const patch of [{ Workload: "AnotherWorkload" }, { RecordType: 2 }, { Operation: "AnotherOperation" }, { Parameters: [] },
    { Parameters: [{ Name: "UnifiedAuditLogIngestionEnabled", Value: "True" }] }]) {
    assert.equal(matches(audit, mapped("microsoft365-audit", { ...change, ...patch })), false);
  }
});

test("CloudTrail, Entra and Okta rules match real mapper fields and reject unrelated or unresolved events", () => {
  const { BY_ID, matches } = require("../server/detection-rules");
  const { normalizeVendorPayload } = require("../tools/vendor-adapters");
  const context = { sourceId: "synthetic-source", estateId: "synthetic-app" };
  const mapped = (id, input) => normalizeVendorPayload(id, input, context).batch.records[0];
  const aws = { eventID: "synthetic-cloud-event", eventTime: AT, eventName: "StopLogging", eventSource: "cloudtrail.amazonaws.com",
    recipientAccountId: "000000000001", userIdentity: { principalId: "synthetic-principal" } };
  for (const [ruleId, method] of [["aws.cloudtrail-stop-logging", "StopLogging"], ["aws.cloudtrail-delete-trail", "DeleteTrail"]]) {
    const rule = BY_ID.get(ruleId), event = { ...aws, eventName: method };
    assert.equal(matches(rule, mapped("aws-cloudtrail", event)), true);
    assert.equal(matches(rule, mapped("aws-cloudtrail", { ...event, eventSource: "another.amazonaws.com" })), false);
    assert.equal(matches(rule, mapped("aws-cloudtrail", { ...event, eventName: "DescribeTrails" })), false);
  }
  const consoleRule = BY_ID.get("aws.console-signin-failures"), login = { ...aws, eventSource: "signin.amazonaws.com", eventName: "ConsoleLogin", responseElements: { ConsoleLogin: "Failure" } };
  assert.equal(matches(consoleRule, mapped("aws-cloudtrail", login)), true);
  assert.equal(matches(consoleRule, mapped("aws-cloudtrail", { ...login, responseElements: { ConsoleLogin: "Success" } })), false);
  assert.equal(matches(consoleRule, mapped("aws-cloudtrail", { ...login, userIdentity: {} })), false);
  const entraRule = BY_ID.get("entra.signin-failures"), entra = { id: "synthetic-entra-event", createdDateTime: AT, userId: "synthetic-user-id", status: { errorCode: 50126 } };
  assert.equal(matches(entraRule, mapped("entra-signin", entra)), true);
  assert.equal(matches(entraRule, mapped("entra-signin", { ...entra, userId: "" })), false);
  assert.equal(matches(entraRule, mapped("entra-signin", { ...entra, status: { errorCode: 0 } })), false);
  const oktaRule = BY_ID.get("okta.signin-failures"), okta = { uuid: "synthetic-okta-event", published: AT, eventType: "user.session.start",
    actor: { id: "synthetic-user-id" }, outcome: { result: "FAILURE" } };
  assert.equal(matches(oktaRule, mapped("okta-system-log", okta)), true);
  assert.equal(matches(oktaRule, mapped("okta-system-log", { ...okta, actor: {} })), false);
  assert.equal(matches(oktaRule, mapped("okta-system-log", { ...okta, outcome: { result: "SUCCESS" } })), false);
  assert.equal(matches(oktaRule, mapped("okta-system-log", { ...okta, eventType: "user.lifecycle.create" })), false);
});
