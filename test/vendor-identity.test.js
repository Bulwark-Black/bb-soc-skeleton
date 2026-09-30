"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { adapters } = require("../tools/vendors/identity");
const { validateNormalizedRecord } = require("../tools/ingest-contract");
const AT = "2026-09-29T12:00:00Z";
const byId = Object.fromEntries(adapters.map(adapter => [adapter.id, adapter]));
const entra = overrides => ({ id: "synthetic-entra-event", createdDateTime: AT, userId: "synthetic-entra-user", status: { errorCode: 0 }, ...overrides });
const okta = overrides => ({ uuid: "synthetic-okta-event", published: AT, eventType: "user.session.start", actor: { id: "synthetic-okta-user" }, outcome: { result: "SUCCESS" }, ...overrides });
const auth0 = overrides => ({ log_id: "synthetic-auth0-event", date: AT, type: "s", user_id: "synthetic-auth0-user", ...overrides });

function canonical(value) {
  return validateNormalizedRecord({ schemaVersion: "1", documentType: "normalized-record", recordId: "synthetic-event",
    sourceId: "synthetic-source", estateId: "synthetic-app", kind: value.kind, observedAt: value.observedAt, payload: value.payload });
}

test("identity adapter metadata is explicit and every mapper produces canonical records deterministically", () => {
  assert.deepEqual(adapters.map(adapter => adapter.id), ["entra-signin", "okta-system-log", "auth0-logs"]);
  for (const [id, event] of [["entra-signin", entra()], ["okta-system-log", okta()], ["auth0-logs", auth0()]]) {
    const adapter = byId[id];
    assert.ok(adapter.docs.every(doc => doc.url.startsWith("https://")));
    const values = adapter.normalize([event]);
    assert.deepEqual(values, adapter.normalize(event), "One exported event supports single-line NDJSON.");
    assert.deepEqual(values, adapter.normalize([event]));
    assert.equal(values.length, 1);
    assert.equal(values[0].kind, "authentication.event");
    assert.equal(values[0].payload.state, "ok");
    assert.equal(values[0].observedAt, "2026-09-29T12:00:00.000Z");
    assert.match(values[0].payload.identityRef, /^[a-z0-9-]+:[a-f0-9]{64}$/);
    assert.doesNotThrow(() => canonical(values[0]));
    assert.equal(values[0].payload.severity, undefined);
  }
});

test("Entra supports value pages, real timestamp precision, and status codes without inferring conditional-access or risk verdicts", () => {
  const normalize = byId["entra-signin"].normalize;
  const records = normalize({ "@odata.context": "ignored-context", "@odata.nextLink": "ignored-continuation", value: [
    entra({ createdDateTime: "2026-09-29T13:00:00.1234567+01:00", isInteractive: false, appId: "synthetic-application", conditionalAccessStatus: "failure", riskLevelAggregated: "high" }),
    entra({ id: "synthetic-failure", status: { errorCode: 50126 } }),
    entra({ id: "synthetic-unknown", status: { failureReason: "Not a verdict" } })
  ] });
  assert.deepEqual(records.map(record => record.payload.state), ["ok", "failed", "unknown"]);
  assert.equal(records[0].observedAt, "2026-09-29T12:00:00.123Z");
  assert.equal(records[0].payload.fields.interactive, false);
  assert.equal(records[0].payload.fields.conditionalAccessStatus, "failure");
  assert.equal(records[0].payload.fields.riskLevelAggregated, undefined);
  assert.equal(records[0].payload.severity, undefined);
  records.forEach(canonical);
  for (const status of [{ errorCode: "0" }, { errorCode: -1 }, { errorCode: 1.5 }, { errorCode: 2147483648 }, "SUCCESS"]) {
    assert.throws(() => normalize([entra({ status })]));
  }
  assert.throws(() => normalize([entra({ isInteractive: "false" })]));
});

test("Okta distinguishes authentication from non-auth audit and does not equate policy ALLOW or CHALLENGE with login success", () => {
  const normalize = byId["okta-system-log"].normalize;
  const events = [
    okta({ uuid: "synthetic-sso", eventType: "user.authentication.sso", outcome: { result: "FAILURE" } }),
    okta({ uuid: "synthetic-allow", eventType: "policy.evaluate_sign_on", outcome: { result: "ALLOW" } }),
    okta({ uuid: "synthetic-admin", eventType: "application.lifecycle.create" }),
    okta({ uuid: "synthetic-challenge", outcome: { result: "CHALLENGE" } }),
    okta({ uuid: "synthetic-unknown", eventType: "future.vendor.event", outcome: { result: "NEW_RESULT" } })
  ];
  const records = normalize(events);
  assert.deepEqual(records.map(record => record.kind), ["authentication.event", "audit.event", "audit.event", "authentication.event", "audit.event"]);
  assert.deepEqual(records.map(record => record.payload.state), ["failed", "unknown", "ok", "unknown", "unknown"]);
  assert.equal(records[1].payload.fields.outcome, "ALLOW");
  assert.equal(records[0].payload.fields.outcomeScope, "provider-event-only");
  assert.equal(records[4].payload.fields.eventType, "unmapped");
  assert.equal(records[4].payload.fields.outcome, "UNKNOWN");
  assert.match(records[4].payload.fields.eventTypeRef, /:[a-f0-9]{64}$/);
  records.forEach(canonical);
  for (const result of ["UNANSWERED", "ABANDONED"]) {
    const [record] = normalize([okta({ eventType: "user.authentication.auth_via_mfa", outcome: { result } })]);
    assert.equal(record.payload.state, "unknown");
    assert.equal(record.payload.fields.outcome, result);
  }
});

test("Auth0 maps exact login codes and keeps management, signup, logout, and future events as audit observations", () => {
  const normalize = byId["auth0-logs"].normalize;
  const types = ["s", "f", "fp", "fsa", "ssa", "w", "sapi", "ss", "slo", "future_success"];
  const records = normalize({ start: 0, limit: 100, length: types.length, total: 100,
    logs: types.map((type, index) => auth0({ type, log_id: "synthetic-auth0-" + index })) });
  assert.deepEqual(records.map(record => record.payload.state), ["ok", "failed", "failed", "failed", "ok", "unknown", "ok", "ok", "ok", "unknown"]);
  assert.ok(records.slice(0, 6).every(record => record.kind === "authentication.event"));
  assert.ok(records.slice(6).every(record => record.kind === "audit.event"));
  assert.equal(records.at(-1).payload.fields.eventType, "unmapped");
  records.forEach(canonical);
});

test("failed authentication without a provider user ID preserves an explicitly unresolved event identity, never an invented account", () => {
  for (const [id, first, second] of [
    ["entra-signin", entra({ userId: null, status: { errorCode: 50126 } }), entra({ id: "synthetic-other", userId: "", status: { errorCode: 50126 } })],
    ["okta-system-log", okta({ actor: null, outcome: { result: "FAILURE" } }), okta({ uuid: "synthetic-other", actor: {}, outcome: { result: "FAILURE" } })],
    ["auth0-logs", auth0({ user_id: undefined, type: "fu" }), auth0({ log_id: "synthetic-other", user_id: "", type: "fu" })]
  ]) {
    const records = byId[id].normalize([first, second]);
    assert.ok(records.every(record => record.payload.state === "failed"));
    assert.ok(records.every(record => record.payload.fields.identityReferenceSource === "event-unresolved"));
    assert.notEqual(records[0].payload.identityRef, records[1].payload.identityRef);
    records.forEach(canonical);
  }
});

test("identity output drops PII, credentials, free text, requests, location, session IDs, and unrecognized field values", () => {
  const marker = crypto.randomBytes(24).toString("hex");
  const rawUser = "synthetic-user-" + marker;
  const sensitive = { userPrincipalName: marker, userDisplayName: marker, user_name: marker, ipAddress: marker, ip: marker,
    displayMessage: marker, description: marker, details: { arbitrary: marker }, client: { ipAddress: marker },
    request: { headers: { authorization: marker } }, debugContext: { debugData: { url: marker } },
    authenticationContext: { externalSessionId: marker }, password: marker, token: marker, location: { city: marker } };
  const cases = [
    ["entra-signin", entra({ ...sensitive, userId: rawUser, appId: marker, status: { errorCode: 0, additionalDetails: marker }, conditionalAccessStatus: marker })],
    ["okta-system-log", okta({ ...sensitive, actor: { id: rawUser, alternateId: marker, displayName: marker }, outcome: { result: "SUCCESS", reason: marker } })],
    ["auth0-logs", auth0({ ...sensitive, user_id: rawUser, client_id: marker })],
    ["okta-system-log", okta({ eventType: marker, outcome: { result: marker } })],
    ["auth0-logs", auth0({ type: marker })]
  ];
  for (const [id, input] of cases) {
    const output = byId[id].normalize([input]);
    const serialized = JSON.stringify(output);
    assert.ok(!serialized.includes(marker), id);
    assert.ok(!serialized.includes(rawUser), id);
    output.forEach(canonical);
    assert.equal(JSON.stringify(input).includes(marker), true, "The mapper must not mutate its input.");
  }
});

test("identity parsers reject malformed/error envelopes and any invalid event atomically, without reflecting supplied data", () => {
  for (const [id, valid, idField, timeField] of [
    ["entra-signin", entra(), "id", "createdDateTime"], ["okta-system-log", okta(), "uuid", "published"], ["auth0-logs", auth0(), "log_id", "date"]
  ]) {
    const normalize = byId[id].normalize;
    const marker = crypto.randomBytes(24).toString("hex");
    for (const input of [null, {}, [], [valid, null], [valid, valid], { error: marker }, { error: marker, value: [valid], logs: [valid] }, { ...valid, error: marker },
      [{ ...valid, [idField]: undefined }], [{ ...valid, [idField]: "" }], [{ ...valid, [idField]: marker.repeat(30) }],
      [{ ...valid, [timeField]: "2026-02-30T12:00:00Z" }], [{ ...valid, [timeField]: "2026-09-29T12:00:00" }],
      [{ ...valid, [timeField]: marker }]]) {
      assert.throws(() => normalize(input), error => error instanceof TypeError && !error.message.includes(marker));
    }
    const withGetter = { ...valid };
    Object.defineProperty(withGetter, idField, { get() { throw new Error(marker); } });
    assert.throws(() => normalize([withGetter]), error => error instanceof TypeError && !error.message.includes(marker));
    const inherited = Object.create({ [idField]: "inherited" });
    Object.assign(inherited, valid);
    assert.throws(() => normalize([inherited]), TypeError);
  }
});

test("identity page limits reject oversize inputs without truncation and accept 1000 unique records", () => {
  for (const [id, sample, idField] of [["entra-signin", entra(), "id"], ["okta-system-log", okta(), "uuid"], ["auth0-logs", auth0(), "log_id"]]) {
    const records = Array.from({ length: 1001 }, (_, index) => ({ ...sample, [idField]: "synthetic-" + index }));
    assert.throws(() => byId[id].normalize(records), /1000/);
    assert.equal(byId[id].normalize(records.slice(0, 1000)).length, 1000);
  }
});
