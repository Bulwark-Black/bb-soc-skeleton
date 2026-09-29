"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fork } = require("node:child_process");
const { once } = require("node:events");
const test = require("node:test");
const { ReferenceControlPlane } = require("../server/reference-runtime");
const { ReferenceAdministrationRuntime } = require("../server/reference-administration-runtime");
const { LOCK_FILE: CONNECTOR_LOCK } = require("../server/reference-store");
const { LOCK_FILE: ADMINISTRATION_LOCK } = require("../server/reference-administration-store");
const { createDocumentStore } = require("../server/document-store");
const { runAsOperator, operatorId } = require("../server/operator-context");
const { FIXTURE_TIME, createSyntheticSource, syntheticBatch, digest } = require("../tools/benchmark-private");

const clock = () => new Date(FIXTURE_TIME);
const WORKER = "--private-recovery-worker";
const OPERATOR = "synthetic-recovery-operator";

function commitFixture(directory) {
  const runtime = new ReferenceControlPlane({ stateDirectory: directory, clock });
  const administration = new ReferenceAdministrationRuntime({ stateDirectory: directory, clock });
  const documents = createDocumentStore({ stateDir: directory });
  const identity = createSyntheticSource(runtime);
  const batch = syntheticBatch(identity, 0, 3);
  assert.equal(runtime.ingest(batch, identity.credential, digest(batch)).accepted, 3);
  const agentRequest = { schemaVersion: "1", documentType: "administration-command-request", requestId: "synthetic-recovery-agent",
    command: "agent.create", requestedAt: FIXTURE_TIME, expectedRevision: 0,
    input: { displayName: "Synthetic recovery agent", kind: "service", capabilities: ["docs:read"] } };
  const agent = runAsOperator(OPERATOR, () => administration.execute(agentRequest));
  assert.equal(agent.status, "succeeded");
  const document = documents.upload({ expectedRevision: 0, metadata: { title: "Synthetic recovery document", appId: identity.appId,
    owner: "Fixture owner", status: "draft" }, filename: "synthetic.md", mime: "text/markdown", bytes: Buffer.from("# Synthetic version one\n"), actor: operatorId(OPERATOR) });
  documents.update({ id: document.document.id, expectedRevision: 1, patch: { status: "current" }, actor: operatorId(OPERATOR) });
  documents.upload({ documentId: document.document.id, expectedRevision: 2, filename: "synthetic-v2.md", mime: "text/markdown",
    bytes: Buffer.from("# Synthetic version two\n"), actor: operatorId(OPERATOR) });
  // Only the IPC channel carries the ephemeral ingest credential. It is never
  // written to a fixture file, stdout, a test report, or the parent console.
  process.send({ boundary: "all-operations-returned-committed", identity, batch, agentRequest,
    agentId: agent.output.agentId, documentId: document.document.id, connectorRevision: runtime.getState().revision }, (error) => {
    if (error) process.exit(2);
  });
  // Leave every store open so the parent can terminate a live process after
  // the commit boundary. No transaction or power-loss failure is simulated.
  setInterval(() => {}, 1000);
}

if (process.argv[2] === WORKER) {
  try { commitFixture(process.argv[3]); }
  catch { process.exit(2); }
} else {
  test("committed private state survives process termination and verified stale-lock cleanup without duplicate replay", { timeout: 20000 }, async (t) => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "bb-soc-private-recovery-"));
    let runtime, administration, documents;
    const child = fork(__filename, [WORKER, directory], { execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const exited = once(child, "exit");
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
      if (documents) documents.close();
      if (administration) administration.dispose();
      if (runtime) runtime.dispose();
      fs.rmSync(directory, { recursive: true, force: true });
    });
    let deadline;
    const committed = await Promise.race([
      once(child, "message").then(([message]) => message),
      exited.then(() => { throw new Error("Recovery fixture exited before the commit boundary."); }),
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("Recovery fixture did not reach the commit boundary.")), 10000); })
    ]).finally(() => clearTimeout(deadline));
    assert.equal(committed.boundary, "all-operations-returned-committed");
    assert.equal(child.kill("SIGKILL"), true);
    const [exitCode, signal] = await exited;
    assert.equal(exitCode, null);
    assert.equal(signal, "SIGKILL");

    // These JSON stores intentionally require operator-assisted stale-lock
    // handling. First prove they refuse concurrent/ambiguous ownership; only
    // then remove exact test-fixture locks belonging to the reaped child.
    assert.throws(() => new ReferenceControlPlane({ stateDirectory: directory, clock }), /already in use/);
    assert.throws(() => new ReferenceAdministrationRuntime({ stateDirectory: directory, clock }), /already in use/);
    for (const filename of [CONNECTOR_LOCK, ADMINISTRATION_LOCK]) {
      const lock = path.join(directory, filename);
      assert.equal(fs.readFileSync(lock, "utf8"), `${child.pid}\n`);
      assert.equal(fs.lstatSync(lock).isFile(), true);
      fs.unlinkSync(lock);
    }

    runtime = new ReferenceControlPlane({ stateDirectory: directory, clock });
    administration = new ReferenceAdministrationRuntime({ stateDirectory: directory, clock });
    documents = createDocumentStore({ stateDir: directory });
    const state = runtime.getState();
    assert.equal(state.apps.length, 1);
    assert.equal(state.hosts.length, 0);
    assert.equal(state.sources[0].environment, "test");
    assert.equal(state.sources[0].state, "active");
    assert.equal(state.records.length, 3);
    assert.equal(state.receipts.length, 1);
    assert.equal(state.revision, committed.connectorRevision);
    assert.equal(runtime.readPage("/logs", {}).panels[0].rows.length, 3);
    const replay = runtime.ingest(committed.batch, committed.identity.credential, digest(committed.batch));
    assert.equal(replay.replay, true);
    assert.equal(runtime.getState().records.length, 3);
    assert.equal(runtime.getState().receipts.length, 1);
    assert.equal(runtime.getState().revision, state.revision);
    const conflict = JSON.parse(JSON.stringify(committed.batch));
    conflict.records[0].payload.message = "Different synthetic body with an existing receipt";
    assert.throws(() => runtime.ingest(conflict, committed.identity.credential, digest(conflict)), (error) => error.code === "already-exists");
    assert.equal(runtime.getState().revision, state.revision);
    const activationReplay = runtime.execute(committed.identity.activationRequest);
    assert.equal(activationReplay.status, "succeeded");
    assert.equal(Object.hasOwn(activationReplay.output, "oneTimeCredential"), false);
    assert.equal(fs.readFileSync(runtime.store.stateFile, "utf8").includes(committed.identity.credential), false);

    assert.equal(administration.getState().agents.length, 1);
    const agentReplay = runAsOperator(OPERATOR, () => administration.execute(committed.agentRequest));
    assert.equal(agentReplay.status, "succeeded");
    assert.equal(agentReplay.output.agentId, committed.agentId);
    assert.equal(administration.getState().agents.length, 1);
    assert.equal(administration.getState().revision, 1);

    const held = documents.get(committed.documentId);
    assert.equal(documents.list().total, 1);
    assert.equal(held.document.status, "current");
    assert.equal(held.document.revision, 3);
    assert.equal(held.document.versionCount, 2);
    assert.deepEqual(held.versions.map((version) => version.version), [2, 1]);
    assert.deepEqual(held.history.map((entry) => entry.action), ["version.uploaded", "metadata.updated", "document.created"]);
    assert.ok(held.history.every((entry) => entry.actor === operatorId(OPERATOR)));
    assert.equal(documents.download({ id: committed.documentId, version: 1 }).bytes.toString(), "# Synthetic version one\n");
    assert.equal(documents.download({ id: committed.documentId, version: 2 }).bytes.toString(), "# Synthetic version two\n");
    assert.throws(() => documents.update({ id: committed.documentId, expectedRevision: 1, patch: { status: "retired" }, actor: operatorId(OPERATOR) }),
      (error) => error.code === "revision-conflict");
    assert.equal(documents.get(committed.documentId).history.length, 3);
  });
}
