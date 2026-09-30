"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { adapters } = require("../tools/vendors/devops");
const { validateNormalizedRecord } = require("../tools/ingest-contract");
const AT = "2026-09-29T12:00:00.123Z";
const byId = Object.fromEntries(adapters.map(adapter => [adapter.id, adapter]));

function github(overrides = {}) {
  return { _document_id: "synthetic-github-audit", "@timestamp": Date.parse(AT), action: "team.add_member",
    org: "synthetic-org", actor: "synthetic-actor", repo: "synthetic-org/synthetic-repo", operation_type: "modify", ...overrides };
}
function gitlab(overrides = {}) {
  return { id: 1001, created_at: AT, entity_id: 2001, entity_type: "Project", author_id: 3001,
    event_type: "project_archived", details: { custom_message: "Synthetic event description" }, ...overrides };
}
function sentry(overrides = {}) {
  return { eventID: "a".repeat(32), dateCreated: "2026-09-29T12:00:00.123456Z", type: "error", platform: "javascript",
    projectID: "2001", groupID: "3001", tags: [{ key: "level", value: "error" }], ...overrides };
}
function datadog(overrides = {}) {
  return { id: "synthetic-datadog-event", type: "log", attributes: { timestamp: AT, status: "INFO", service: "synthetic-service", host: "synthetic-host" }, ...overrides };
}
const factories = { "github-audit": github, "gitlab-audit": gitlab, "sentry-events": sentry, "datadog-logs": datadog };
function canonical(item) {
  return validateNormalizedRecord({ schemaVersion: "1", documentType: "normalized-record", recordId: "synthetic-record",
    sourceId: "synthetic-source", estateId: "synthetic-app", kind: item.kind, observedAt: item.observedAt, payload: item.payload });
}

test("DevOps adapter catalog has four bounded documented formats and all outputs satisfy canonical contracts", () => {
  assert.deepEqual(adapters.map(adapter => adapter.id), Object.keys(factories));
  for (const adapter of adapters) {
    assert.ok(Object.isFrozen(adapter)); assert.ok(adapter.docs.length); assert.ok(adapter.formats.length);
    const sample = factories[adapter.id](), normalized = adapter.normalize(sample);
    assert.equal(normalized.length, 1); assert.equal(normalized[0].observedAt, AT);
    assert.ok(adapter.recordKinds.includes(normalized[0].kind)); assert.doesNotThrow(() => canonical(normalized[0]));
    assert.deepEqual(adapter.normalize([sample]), normalized);
    assert.deepEqual(adapter.normalize(sample), normalized, "normalization is deterministic");
    assert.deepEqual(adapter.normalize([]), [], "an empty page does not synthesize a heartbeat or success event");
  }
});

test("GitHub audit identity and epoch timestamps are required; actor/resource/action values become hashed references", () => {
  const adapter = byId["github-audit"], event = github(), output = adapter.normalize(event)[0];
  assert.equal(output.kind, "audit.event"); assert.equal(output.upstreamId, event._document_id);
  assert.equal(output.payload.fields.actionClass, "team"); assert.equal(output.payload.fields.operation, "modify");
  assert.match(output.payload.fields.actorRef, /^actor:[a-f0-9]{64}$/);
  assert.match(output.payload.fields.actionRef, /^action:[a-f0-9]{64}$/);
  assert.deepEqual(adapter.normalize(github({ "@timestamp": undefined, created_at: Date.parse(AT) })), [output]);
  assert.equal(adapter.normalize(github({ action: "new_feature.changed" }))[0].payload.fields.actionClass, "other");
  const keyed = adapter.normalize(github({ org_id: 11, actor_id: 22, repo_id: 33 }))[0];
  assert.notEqual(keyed.payload.fields.actorRef, output.payload.fields.actorRef);
  for (const mutation of [{ _document_id: undefined }, { _document_id: "person@example.invalid" }, { "@timestamp": undefined },
    { "@timestamp": "2026-09-29T12:00:00Z" }, { "@timestamp": 1.5 }, { action: undefined }, { action: "free form message" }]) {
    assert.throws(() => adapter.normalize(github(mutation)), /supported event format/);
  }
});

test("GitLab accepts API single/list shapes and drops free-form details while retaining hashed entity/event references", () => {
  const adapter = byId["gitlab-audit"], output = adapter.normalize(gitlab())[0];
  assert.equal(output.kind, "audit.event"); assert.equal(output.upstreamId, "1001");
  assert.equal(output.payload.fields.entityType, "Project"); assert.match(output.payload.fields.entityRef, /^entity:[a-f0-9]{64}$/);
  assert.match(output.payload.fields.eventTypeRef, /^event-type:[a-f0-9]{64}$/);
  assert.deepEqual(adapter.normalize(gitlab({ id: "1001" })), [output]);
  assert.doesNotThrow(() => adapter.normalize(gitlab({ event_type: undefined, details: {} })));
  assert.equal(adapter.normalize(gitlab({ entity_type: "NewKind" }))[0].payload.fields.entityType, "other");
  for (const mutation of [{ id: undefined }, { id: 0 }, { id: Number.MAX_SAFE_INTEGER + 1 }, { created_at: undefined },
    { created_at: "2026-02-30T12:00:00Z" }, { entity_type: undefined }, { entity_id: "email@example.invalid" }, { details: null }]) {
    assert.throws(() => adapter.normalize(gitlab(mutation)), /supported event format/);
  }
});

test("Sentry API error events map to logs without copying titles, user data, requests or stack traces", () => {
  const adapter = byId["sentry-events"], output = adapter.normalize(sentry())[0];
  assert.equal(output.kind, "log.event"); assert.equal(output.payload.state, "unknown"); assert.equal(output.payload.severity, "unknown");
  assert.equal(output.payload.fields.reportedLevel, "error"); assert.equal(output.payload.fields.platform, "javascript");
  assert.equal(output.observedAt, AT); assert.match(output.payload.fields.issueRef, /^issue:[a-f0-9]{64}$/);
  assert.deepEqual(adapter.normalize(sentry({ type: undefined, "event.type": "error" })), [output]);
  assert.deepEqual(adapter.normalize(sentry({ eventID: "A".repeat(32) })), [output]);
  assert.equal(adapter.normalize(sentry({ tags: [], platform: "new-language" }))[0].payload.fields.platform, "other");
  assert.doesNotThrow(() => adapter.normalize(sentry({ errors: [{ message: "Synthetic upstream symbolication warning" }] })), "Sentry event errors are not an API error envelope");
  for (const mutation of [{ eventID: undefined }, { eventID: "not-an-event-id" }, { dateCreated: undefined }, { dateCreated: "yesterday" },
    { dateCreated: "2025-02-29T12:00:00Z" }, { dateCreated: "2026-09-29T12:00:00.1234567890Z" }, { type: "transaction" },
    { type: "error", "event.type": "transaction" }, { tags: [{ key: "level", value: "error" }, { key: "level", value: "fatal" }] }]) {
    assert.throws(() => adapter.normalize(sentry(mutation)), /supported event format/);
  }
});

test("Datadog Logs v2 accepts page/log shapes, never fetches pagination, and refuses explicit partial/error results", () => {
  const adapter = byId["datadog-logs"], event = datadog(), output = adapter.normalize(event)[0];
  assert.equal(output.kind, "log.event"); assert.equal(output.payload.fields.reportedLevel, "info");
  assert.match(output.payload.fields.serviceRef, /^service:[a-f0-9]{64}$/);
  assert.deepEqual(adapter.normalize({ data: [event], meta: { status: "done", warnings: [], page: { after: "synthetic-cursor" } }, links: { next: "https://example.invalid/next-page" } }), [output]);
  assert.deepEqual(adapter.normalize({ data: [event] }), [output]);
  assert.deepEqual(adapter.normalize({ data: [] }), []);
  for (const envelope of [
    { data: [event], errors: [] }, { data: [event], error: "Upstream rejected request" }, { data: [event], meta: { status: "timeout" } },
    { data: [event], meta: { warnings: [{ code: "unknown_index" }] } }, { data: [event], meta: { warnings: "warning" } },
    { data: event }, { data: [event], meta: null }, { data: [event], links: [] }
  ]) assert.throws(() => adapter.normalize(envelope), /supported event format/);
  for (const mutation of [{ id: undefined }, { id: "person@example.invalid" }, { type: "metric" }, { attributes: {} },
    { attributes: { timestamp: "2026-04-31T12:00:00Z" } }, { attributes: { timestamp: AT, status: {} } }]) {
    assert.throws(() => adapter.normalize(datadog(mutation)), /supported event format/);
  }
});

test("all DevOps adapters reject malformed members, missing schemas, duplicated IDs and oversized pages atomically", () => {
  for (const adapter of adapters) {
    const good = factories[adapter.id]();
    for (const input of [null, undefined, "raw log text", { error: "Synthetic API error" }, { message: "Forbidden" },
      [good, {}], [good, null], [good, good], Array(1), Array(1001).fill(good)]) {
      assert.throws(() => adapter.normalize(input), /supported event format/);
    }
    const original = JSON.stringify(good); adapter.normalize(good);
    assert.equal(JSON.stringify(good), original, "input is not mutated");
    const getter = { ...good }; Object.defineProperty(getter, "title", { get() { throw new Error("Getter must not execute"); } });
    assert.throws(() => adapter.normalize(getter), /supported event format/);
  }
});

test("all DevOps adapters handle exactly 1000 distinct events with stable IDs and no silent truncation", () => {
  const samplePages = {
    "github-audit": Array.from({ length: 1000 }, (_, index) => github({ _document_id: "synthetic-github-" + index })),
    "gitlab-audit": Array.from({ length: 1000 }, (_, index) => gitlab({ id: index + 1 })),
    "sentry-events": Array.from({ length: 1000 }, (_, index) => sentry({ eventID: index.toString(16).padStart(32, "0") })),
    "datadog-logs": Array.from({ length: 1000 }, (_, index) => datadog({ id: "synthetic-datadog-" + index }))
  };
  for (const adapter of adapters) {
    const result = adapter.normalize(samplePages[adapter.id]); assert.equal(result.length, 1000);
    assert.equal(new Set(result.map(item => item.upstreamId)).size, 1000);
    result.forEach(canonical);
  }
});

test("unselected sensitive fields and unknown code-like values never leak into DevOps output", () => {
  const hidden = crypto.randomBytes(24).toString("hex"), email = "private-person@example.invalid";
  const sensitive = { title: hidden, message: hidden, user: { email, id: hidden }, request: { headers: { authorization: hidden }, url: "https://example.invalid/" + hidden },
    stacktrace: hidden, context: { privateValue: hidden }, arbitrary: hidden };
  const samples = {
    "github-audit": github({ ...sensitive, actor: email, org: hidden, repo: hidden, action: "repo.private_" + hidden, operation_type: hidden }),
    "gitlab-audit": gitlab({ ...sensitive, entity_type: hidden, event_type: hidden, details: { ...sensitive, author_name: hidden, author_email: email, target_details: hidden, custom_message: hidden } }),
    "sentry-events": sentry({ ...sensitive, platform: hidden, tags: [{ key: "level", value: hidden }, { key: "email", value: email }], entries: [{ type: "request", data: sensitive }] }),
    "datadog-logs": datadog({ attributes: { ...sensitive, timestamp: AT, service: hidden, host: hidden, status: hidden, tags: [email], attributes: sensitive } })
  };
  for (const adapter of adapters) {
    const result = adapter.normalize(samples[adapter.id]), rendered = JSON.stringify(result);
    assert.ok(!rendered.includes(hidden), adapter.id + " must not expose the private marker");
    assert.ok(!rendered.includes(email), adapter.id + " must not expose email");
    assert.ok(!rendered.includes("https:"), adapter.id + " must not expose raw request URLs");
    result.forEach(canonical);
  }
});
