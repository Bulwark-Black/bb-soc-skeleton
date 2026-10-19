"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("portable native collector synthetic probe, queue, credential and receipt suite", () => {
  const result = spawnSync("python3", [path.join(__dirname, "native-monitor-agent.py")], {
    cwd: path.join(__dirname, ".."), encoding: "utf8", timeout: 30000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Ran 11 tests/);
});
