"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { parseArguments, readPrivateFile, main } = require("../tools/map-events");
const { validateIngestBatch } = require("../tools/ingest-contract");
const { LIMITS } = require("../server/source-mapping");
const AT = "2026-09-29T12:00:00.000Z";
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "bb-map-events-")); fs.chmodSync(directory, 0o700);
  const recipe = path.join(directory, "recipe.json"), file = path.join(directory, "events.json");
  const draft = { schemaVersion: "1", documentType: "source-mapping-recipe", appId: "app-synthetic", environment: "test", sourceId: "source-synthetic", kind: "log.event",
    upstreamId: { path: "/id" }, observedAt: { path: "/at" }, payload: { title: { value: "Synthetic event" }, state: { value: "unknown" }, message: { path: "/message" } } };
  fs.writeFileSync(recipe, JSON.stringify(draft), { mode: 0o600 });
  fs.writeFileSync(file, JSON.stringify({ id: "one", at: AT, message: "Synthetic redacted message" }), { mode: 0o600 });
  const run = (args = ["--recipe", recipe, "--file", file]) => { const chunks = { stdout: [], stderr: [] }; const output = Object.fromEntries(Object.keys(chunks).map(key => [key, { write: value => chunks[key].push(value) }]));
    const code = main(args, output); return { code, stdout: chunks.stdout.join(""), stderr: chunks.stderr.join("") }; };
  t.after(() => fs.rmSync(directory, { recursive: true, force: true })); return { directory, recipe, file, draft, run };
}
test("offline mapper prints only one deterministic validated canonical batch and never sends it", t => {
  const f = fixture(t), first = f.run(), second = f.run(); assert.equal(first.code, 0); assert.equal(first.stderr, ""); assert.equal(first.stdout, second.stdout);
  const batch = JSON.parse(first.stdout); validateIngestBatch(batch); assert.equal(batch.records.length, 1); assert.equal(batch.records[0].observedAt, AT);
  assert.equal(batch.records[0].sourceId, "source-synthetic"); assert.ok(!first.stdout.includes("source-mapping-recipe"));
  assert.equal(fs.readdirSync(f.directory).length, 2);
  const processResult = spawnSync(process.execPath, [path.join(__dirname, "..", "tools", "map-events.js"), "--recipe", f.recipe, "--file", f.file], { encoding: "utf8" });
  assert.equal(processResult.status, 0); assert.equal(processResult.stdout, first.stdout); assert.equal(processResult.stderr, "");
});
test("CLI help discloses offline binding limits and never accepts secrets, targets or output file options", t => {
  const f = fixture(t); const help = f.run(["--help"]); assert.equal(help.code, 0); assert.match(help.stdout, /does not verify current registration/);
  for (const argv of [[], ["--recipe", f.recipe], ["--file", f.file, "--token", "do-not-echo"], ["--recipe", f.recipe, "--file", f.file, "--output", "/private/x"],
    ["--recipe", f.recipe, "--file", f.file, "--file", f.file], ["--help", "--file", f.file]]) {
    assert.throws(() => parseArguments(argv)); const result = f.run(argv); assert.equal(result.code, 1); assert.equal(result.stdout, ""); assert.ok(!result.stderr.includes("do-not-echo"));
  }
});
test("CLI refuses public permissions, links, nonregular files, repository paths and invalid UTF-8", async t => {
  for (const kind of ["file-mode", "parent-mode", "symlink", "hardlink", "directory", "relative", "repository", "invalid-utf8", "oversize"]) await t.test(kind, sub => {
    const f = fixture(sub); let file = f.file;
    if (kind === "file-mode") fs.chmodSync(file, 0o644);
    if (kind === "parent-mode") fs.chmodSync(f.directory, 0o755);
    if (kind === "symlink") { fs.renameSync(file, file + ".original"); fs.symlinkSync(file + ".original", file); }
    if (kind === "hardlink") fs.linkSync(file, file + ".copy");
    if (kind === "directory") file = f.directory;
    if (kind === "relative") file = "relative-events.json";
    if (kind === "repository") file = path.join(__dirname, "map-events.test.js");
    if (kind === "invalid-utf8") fs.writeFileSync(file, Buffer.from([0xff, 0xfe]));
    if (kind === "oversize") fs.writeFileSync(file, "x".repeat(LIMITS.inputBytes + 1));
    assert.throws(() => readPrivateFile(file, LIMITS.inputBytes)); const result = f.run(["--recipe", f.recipe, "--file", file]); assert.equal(result.code, 1); assert.equal(result.stdout, "");
  });
});
test("invalid recipes and partially invalid records never emit a partial batch or raw errors", t => {
  const f = fixture(t); fs.writeFileSync(f.file, JSON.stringify([{ id: "one", at: AT, message: "Valid synthetic" }, { id: "two", at: "private-invalid-value-never-echo", message: "Invalid" }]));
  let result = f.run(); assert.equal(result.code, 1); assert.equal(result.stdout, ""); assert.ok(!result.stderr.includes("private-invalid-value-never-echo"));
  fs.writeFileSync(f.recipe, "{private-malformed-json-never-echo"); result = f.run(); assert.equal(result.code, 1); assert.equal(result.stdout, ""); assert.ok(!result.stderr.includes("private-malformed-json-never-echo"));
});
