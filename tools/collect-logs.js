#!/usr/bin/env node
"use strict";
const { CollectorError, previewLog, runLogCollector } = require("./log-collector");
const HELP = `Usage:
  node tools/collect-logs.js --preview --reviewed-input --file /absolute/server.log --format plain --source-id SOURCE --app-id APP
  node tools/collect-logs.js --once --reviewed-input --file /absolute/server.log --format plain --source-id SOURCE --app-id APP --state-dir /absolute/private/collector --outbox-dir /absolute/private/outbox --token-file /absolute/private/source-token [--base-url PRIVATE_ORIGIN] [--max-records 100]

Formats: plain, docker-json, journald-json. Preview prints one real canonical
record for source testing; it performs no writes or network requests. An empty
file previews a completed-read proof. Review/redact input before either mode.
Once durably queues at most 100 logs and drains queued deliveries. Schedule it
externally, without overlapping runs. Re-run while backlog remains. Only a
complete newline-terminated snapshot produces successful collection proof.
Plain logs use collection time, labeled timestampOrigin=collection-time.
Structured logs require their original timestamps. No automatic redaction.
Input must be a regular file with no links. State and outbox require separate
owner-only directories outside the checkout; token remains in its private file.
Rotation, replacement, truncation and changed checkpoint anchors are refused.
Do not delete state or the outbox to clear a failure: preserve both for recovery.
Exit 0 means read completed and queued deliveries finished; exit 2 means backlog
or pending delivery; exit 1 means collection or configuration failure.
`;
function parseArguments(argv) {
  if (argv.length === 1 && argv[0] === "--help") return { help: true };
  const flags = { "--once": "once", "--preview": "preview", "--reviewed-input": "reviewedInput" };
  const names = { "--file": "file", "--format": "format", "--source-id": "sourceId", "--app-id": "estateId", "--state-dir": "stateDirectory", "--outbox-dir": "outboxDirectory", "--token-file": "tokenFile", "--base-url": "baseUrl", "--max-records": "maxRecords" };
  const result = {}, seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index], key = flags[arg] || names[arg];
    if (!key || seen.has(key)) throw new CollectorError("invalid-options", "Unsupported or repeated option. Use --help.");
    seen.add(key);
    if (flags[arg]) result[key] = true;
    else {
      const value = argv[++index];
      if (!value || value.startsWith("--") || (key === "maxRecords" && !/^[1-9]\d*$/.test(value))) throw new CollectorError("invalid-options", "Incomplete or invalid option. Use --help.");
      result[key] = key === "maxRecords" ? Number(value) : value;
    }
  }
  if (!!result.once === !!result.preview) throw new CollectorError("invalid-options", "Choose exactly one of --once or --preview.");
  return result;
}
async function main(argv = process.argv.slice(2), output = process) {
  try {
    const { help, once, preview, ...options } = parseArguments(argv);
    if (help) { output.stdout.write(HELP); return 0; }
    if (preview) { output.stdout.write(JSON.stringify(previewLog(options), null, 2) + "\n"); return 0; }
    const result = await runLogCollector(options);
    output.stdout.write(JSON.stringify(result) + "\n");
    return result.error ? 1 : (!result.complete || result.pendingDeliveries ? 2 : 0);
  } catch (error) {
    output.stderr.write("Log collection failed: " + (error instanceof CollectorError ? `${error.code}: ${error.message}` : "operation-failed; private details were omitted.") + "\n");
    return 1;
  }
}
if (require.main === module) void main().then(code => { process.exitCode = code; });
module.exports = { HELP, parseArguments, main };
