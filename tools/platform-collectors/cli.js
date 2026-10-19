#!/usr/bin/env node
"use strict";
const { readConfig, CollectorError, privateFile, noLinks, readPrivate, external, fail } = require("./common");
const { runCollector, status, drain } = require("./engine");
const HELP = `Usage: node tools/platform-collectors/cli.js <check-config|collect|drain|status> --config ABS --state-dir ABS --outbox-dir ABS

One bounded collection run. Schedule collect and drain separately. Configuration,
credentials, state and outbox stay outside the checkout. check-config performs no
network calls or state writes. status reports local queue/checkpoint metadata;
it does not claim an upstream account is connected. See docs/PLATFORM-COLLECTORS.md.
`;
async function main(argv) {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) { process.stdout.write(HELP); return; }
  const command = argv.shift(), flags = {};
  if (!["check-config", "collect", "drain", "status"].includes(command)) fail("invalid-command");
  while (argv.length) { const key = argv.shift(); if (!["--config", "--state-dir", "--outbox-dir"].includes(key) || flags[key] || !argv.length) fail("invalid-command"); flags[key] = argv.shift(); }
  if (!flags["--config"] || !flags["--state-dir"] || !flags["--outbox-dir"]) fail("invalid-command");
  external(flags["--state-dir"]); external(flags["--outbox-dir"]);
  if (flags["--state-dir"] === flags["--outbox-dir"]) fail("state-outbox-overlap");
  const config = readConfig(flags["--config"]), options = { config, stateDirectory: flags["--state-dir"], outboxDirectory: flags["--outbox-dir"] };
  let result;
  if (command === "check-config") {
    for (const file of [config.tokenFile, config.providerCredentialFile, config.options.caFile].filter(Boolean)) { noLinks(file); privateFile(file); readPrivate(file, 1024 * 1024); }
    result = { ok: true, provider: config.provider, configured: true, connected: false, networkChecked: false };
  } else result = await ({ collect: runCollector, drain, status })[command](options);
  process.stdout.write(JSON.stringify(result) + "\n");
  if (!result.ok || result.queue?.blocked || command === "collect" && (!result.complete || result.partialLine)) process.exitCode = 2;
}
if (require.main === module) main(process.argv.slice(2)).catch(error => { process.stderr.write(JSON.stringify({ ok: false, code: error instanceof CollectorError ? error.code : "collector-failed" }) + "\n"); process.exitCode = 1; });
module.exports = { main, HELP };
