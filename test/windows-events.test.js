"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { adapters } = require("../tools/vendors/windows");
const { validateNormalizedRecord } = require("../tools/ingest-contract");
const mapper = adapters[0];
const fixture = overrides => ({ computer: "server.example.invalid", channel: "Security", collectionChannel: "Security", logEpoch: "synthetic-epoch",
  eventRecordId: "18446744073709551615", eventId: 4625, eventVersion: 0, providerName: "Microsoft-Windows-Security-Auditing",
  timeCreated: "2026-10-18T12:00:00.1234567Z", eventData: { TargetUserName: "synthetic-user", Status: "0xc000006a", LogonType: "3" }, ...overrides });
const map = event => mapper.normalize({ schemaVersion: 1, events: [event] })[0];

test("Windows adapter preserves 64-bit identity, precise event time and named evidence in searchable logs", () => {
  const original = fixture(), mapped = map(original);
  assert.equal(mapped.kind, "log.event"); assert.equal(mapped.observedAt, "2026-10-18T12:00:00.123Z");
  assert.equal(mapped.payload.state, "failed"); assert.equal(mapped.payload.fields.eventTime, original.timeCreated);
  assert.equal(mapped.payload.fields.eventRecordId, original.eventRecordId); assert.equal(mapped.payload.fields["win.TargetUserName"], "synthetic-user");
  assert.equal(mapped.payload.fields.provider, "windows-eventlog"); assert.equal(mapped.payload.fields.eventCategory, "authentication");
  validateNormalizedRecord({ schemaVersion: "1", documentType: "normalized-record", recordId: mapped.upstreamId, sourceId: "source-example", estateId: "app-example", kind: mapped.kind, observedAt: mapped.observedAt, payload: mapped.payload });
  assert.deepEqual(mapped, map(original));
  for (const change of [{ computer: "another.example.invalid" }, { channel: "System" }, { logEpoch: "new-generation" }, { eventRecordId: "1" }, { timeCreated: "2026-10-18T12:00:00.1234568Z" }]) assert.notEqual(map(fixture(change)).upstreamId, mapped.upstreamId);
});

test("Windows classification requires supported provider/channel/version and never invents a credential outcome", () => {
  assert.equal(map(fixture({ eventId: 4624, eventVersion: 2 })).payload.state, "ok");
  for (const patch of [{ providerName: "Synthetic-Other-Provider" }, { eventVersion: 200 }, { channel: "Application" }]) {
    const event = map(fixture(patch)); assert.equal(event.payload.state, "unknown"); assert.equal(event.payload.fields.decodeStatus, "unclassified");
  }
  for (const eventId of [4776, 4768, 4769]) {
    assert.equal(map(fixture({ eventId, eventData: {} })).payload.state, "unknown");
    assert.equal(map(fixture({ eventId, eventData: { Status: "0x0" } })).payload.state, "ok");
    assert.equal(map(fixture({ eventId, eventData: { Status: "not-a-status" } })).payload.state, "unknown");
  }
  const cleared = map(fixture({ eventId: 1102, providerName: "Microsoft-Windows-Eventlog", eventData: {}, userData: { SubjectUserSid: "S-1-5-18", SubjectUserName: "synthetic-operator" } }));
  assert.equal(cleared.payload.fields.eventCategory, "audit"); assert.equal(cleared.payload.fields["win.SubjectUserName"], "synthetic-operator");
  assert.equal(cleared.payload.state, "unknown");
});

test("Windows fields are bounded, reject ambiguity and secret names, and unsupported input is never guessed", () => {
  for (const patch of [{ eventRecordId: 123 }, { eventRecordId: "18446744073709551616" }, { eventRecordId: "0001" },
    { eventId: -1 }, { eventVersion: 256 }, { timeCreated: "2026-02-30T00:00:00Z" }, { timeCreated: "2026-10-18T00:00:00" },
    { eventData: { secretToken: "synthetic" } }, { eventData: { Nested: {} } }, { eventData: { Field: "x".repeat(1001) } },
    { userData: { TargetUserName: "ambiguous" } }, { eventData: Object.fromEntries(Array.from({ length: 49 }, (_, i) => ["field" + i, "value"])) },
    { xml: "<Event/>" }]) assert.throws(() => map(fixture(patch)), JSON.stringify(patch));
  assert.throws(() => mapper.normalize([])); assert.throws(() => mapper.normalize("<Event/>"));
  assert.throws(() => mapper.normalize({ schemaVersion: 2, events: [fixture()] }));
});

test("Windows collector XML, platform gate, durable receipt recovery and private-state tests", () => {
  const result = spawnSync("python3", [path.join(__dirname, "windows-collector-test.py")], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, timeout: 120000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /OK/);
});
