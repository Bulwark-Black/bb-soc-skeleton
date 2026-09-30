"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { validateDocumentBinding } = require("../server/document-bindings");

function fixture() {
  const applications = { apps: [{ appId: "app-current" }] };
  const governance = { risks: [{ riskId: "risk-current", status: "open" }, { riskId: "risk-archived", status: "archived" }],
    attestations: [{ attestationId: "attestation-current", status: "draft" }] };
  let reads = 0;
  const context = { runtime: { controlState() { reads += 1; return applications; } }, administrationRuntime: { getState() { reads += 1; return governance; } } };
  return { context, applications, governance, reads: () => reads };
}
const metadata = (changes = {}) => ({ title: "Synthetic supporting document", appId: "app-current", owner: "Synthetic owner", status: "draft",
  reviewAt: "2026-12-01", linkKind: "risk", linkId: "risk-current", ...changes });

test("document binding verifies registered application and an existing global governance record without mutation", () => {
  const f = fixture(), before = JSON.stringify([f.applications, f.governance]), value = metadata();
  assert.deepEqual(validateDocumentBinding(value, f.context), { appId: "app-current", linkKind: "risk", linkId: "risk-current" });
  assert.deepEqual(value, metadata()); assert.equal(JSON.stringify([f.applications, f.governance]), before);
  assert.equal(f.reads(), 2);
  assert.deepEqual(validateDocumentBinding(metadata({ appId: null, linkKind: "attestation", linkId: "attestation-current" }), f.context),
    { appId: null, linkKind: "attestation", linkId: "attestation-current" });
  assert.doesNotThrow(() => validateDocumentBinding(metadata({ linkId: "risk-archived" }), f.context), "archived existing records remain explicit selectable history");
});

test("new and changed document bindings reject missing apps, source IDs used as apps, and unknown governance IDs", () => {
  const f = fixture();
  for (const change of [{ appId: "source-current" }, { appId: "app-removed" }, { linkId: "risk-missing" },
    { linkKind: "attestation", linkId: "risk-current" }, { linkKind: "risk", linkId: "attestation-current" }]) {
    assert.throws(() => validateDocumentBinding(metadata(change), f.context), error => error.status === 400);
  }
  const previous = metadata({ linkId: "risk-old" });
  assert.throws(() => validateDocumentBinding({ appId: null }, { ...f.context, previous }), /existing risk/,
    "changing any part of a historical binding revalidates all of its references");
  assert.throws(() => validateDocumentBinding({ linkId: "risk-missing" }, { ...f.context, previous: metadata() }), /existing risk/);
});

test("historical missing references remain editable and versionable only while their whole binding is unchanged", () => {
  const previous = metadata({ appId: "app-removed", linkId: "risk-removed" });
  const unavailable = { previous, runtime: { controlState() { throw new Error("Must not read old app"); } }, administrationRuntime: { getState() { throw new Error("Must not read old risk"); } } };
  for (const patch of [{}, { owner: "New synthetic owner", status: "needs-review" }, metadata({ appId: "app-removed", linkId: "risk-removed" })]) {
    assert.deepEqual(validateDocumentBinding(patch, unavailable), { appId: "app-removed", linkKind: "risk", linkId: "risk-removed" });
  }
  const f = fixture();
  assert.doesNotThrow(() => validateDocumentBinding({ appId: null, linkKind: null, linkId: null }, { ...f.context, previous }));
  assert.doesNotThrow(() => validateDocumentBinding(metadata(), { ...f.context, previous }));
});

test("case and policy links remain explicitly unverified external references with validated application scope", () => {
  const f = fixture();
  for (const linkKind of ["case", "policy"]) {
    assert.deepEqual(validateDocumentBinding(metadata({ linkKind, linkId: "external-reference" }), f.context),
      { appId: "app-current", linkKind, linkId: "external-reference" });
    assert.throws(() => validateDocumentBinding(metadata({ appId: "not-registered", linkKind, linkId: "external-reference" }), f.context), /registered application/);
  }
  assert.equal(f.governance.risks.length, 2); assert.equal(f.governance.attestations.length, 1);
});

test("document binding validates exact safe input and paired references without reading accessor properties", () => {
  const f = fixture(); let invoked = false;
  const getter = { title: "Synthetic document" }; Object.defineProperty(getter, "appId", { enumerable: true, get() { invoked = true; return "app-current"; } });
  for (const value of [null, [], "bad", getter, { ...metadata(), unsupported: true }, { ...metadata(), linkKind: "source" },
    metadata({ linkId: null }), metadata({ linkKind: null }), metadata({ appId: "../escape" }), metadata({ linkId: "bad\nreference" }),
    metadata({ appId: "x".repeat(129) }), metadata({ linkKind: {} })]) {
    assert.throws(() => validateDocumentBinding(value, f.context), error => error.status === 400);
  }
  assert.equal(invoked, false);
});

test("binding fails closed when required registries are unavailable, but truly shared unlinked metadata needs no registry", () => {
  assert.deepEqual(validateDocumentBinding({ title: "Shared synthetic document" }), { appId: null, linkKind: null, linkId: null });
  assert.throws(() => validateDocumentBinding(metadata()), error => error.status === 503);
  assert.throws(() => validateDocumentBinding(metadata({ appId: null })), error => error.status === 503);
  assert.throws(() => validateDocumentBinding(metadata(), { runtime: { controlState: () => ({}) } }), error => error.status === 503);
  assert.throws(() => validateDocumentBinding(metadata({ appId: null }), { administrationRuntime: { getState: () => ({}) } }), error => error.status === 503);
  assert.throws(() => validateDocumentBinding({}, { previous: [] }), error => error.status === 503);
});
