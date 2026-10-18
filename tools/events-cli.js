#!/usr/bin/env node
"use strict";

const { readBatchFile, SenderError } = require("./integration-client");
const { openOutbox } = require("./integration-outbox");

const HELP = `Canonical events — durable delivery for your application and server logs
  events enqueue --file ABSOLUTE --outbox-dir ABSOLUTE [--base-url PRIVATE_ORIGIN]
  events status --outbox-dir ABSOLUTE [--state pending|inflight|blocked|delivered] [--source-id ID] [--offset 0..10000] [--limit 1..100]
  events drain --outbox-dir ABSOLUTE --source-id ID --token-file ABSOLUTE [--base-url PRIVATE_ORIGIN] [--limit 1..100]
  events retry --outbox-dir ABSOLUTE --id DELIVERY_ID
  events prune --outbox-dir ABSOLUTE --before RFC3339
Enqueue one complete canonical ingest-batch JSON document (at most 1 MiB / 1000 records).
Map raw logs to canonical records first with map:events; this command does not collect or map logs.
Use a dedicated owner-only outbox directory outside the checkout and application state.
Enqueue persists the validated batch before any network request; replay preserves its IDs and content.
Drain is one bounded pass. Schedule it externally and inspect pending/blocked results.
Use an owner-only source-ingest token file outside the checkout; no raw token or environment credential options.
Status returns metadata only, with global totals and filtered pages; follow page.nextOffset.
Prune explicitly removes delivered receipt metadata strictly older than the cutoff, which must be at least 24 hours ago.
Pending, inflight and blocked entries are retained. No automatic pruning is performed.
`;
const OPTIONS = {
  enqueue: ["file", "outbox-dir", "base-url"],
  status: ["outbox-dir", "state", "source-id", "offset", "limit"],
  drain: ["outbox-dir", "source-id", "token-file", "base-url", "limit"],
  retry: ["outbox-dir", "id"], prune: ["outbox-dir", "before"]
};
const REQUIRED = {
  enqueue: ["file", "outbox-dir"], status: ["outbox-dir"],
  drain: ["outbox-dir", "source-id", "token-file"], retry: ["outbox-dir", "id"], prune: ["outbox-dir", "before"]
};

function argumentsFor(argv) {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== "string")) throw new TypeError("Events arguments must be strings.");
  const [command, ...rest] = argv;
  if (!Object.hasOwn(OPTIONS, command)) throw new TypeError("Choose enqueue, status, drain, retry or prune; use --help for usage.");
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index].startsWith("--") ? rest[index].slice(2) : "";
    if (!OPTIONS[command].includes(key) || Object.hasOwn(options, key) || !rest[index + 1] || rest[index + 1].startsWith("--")) throw new TypeError("Unknown, duplicate or missing events command option. Raw token arguments are not accepted.");
    options[key] = rest[index + 1];
  }
  for (const key of REQUIRED[command]) if (!options[key]) throw new TypeError("A required events command option is missing; use --help.");
  if (options.limit !== undefined && (!/^[1-9][0-9]{0,2}$/.test(options.limit) || Number(options.limit) > 100)) throw new TypeError("Limit must be a decimal integer from 1 through 100.");
  if (options.offset !== undefined && (!/^(0|[1-9][0-9]{0,4})$/.test(options.offset) || Number(options.offset) > 10000)) throw new TypeError("Status offset must be a decimal integer from 0 through 10000.");
  return { command, options };
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) { process.stdout.write(HELP); return; }
  const { command, options } = argumentsFor(argv);
  // Validate before creating the queue. Input errors never persist a partial batch.
  const batch = command === "enqueue" ? readBatchFile(options.file) : null;
  const queue = openOutbox(options["outbox-dir"]);
  try {
    if (command === "enqueue") return queue.enqueue(batch, options["base-url"]);
    if (command === "status") return queue.list({ state: options.state, sourceId: options["source-id"],
      offset: options.offset === undefined ? 0 : Number(options.offset), limit: options.limit === undefined ? 100 : Number(options.limit) });
    if (command === "retry") return queue.retry(options.id);
    if (command === "prune") return queue.pruneDelivered(options.before);
    return await queue.drain({ baseUrl: options["base-url"], sourceId: options["source-id"], tokenFile: options["token-file"], limit: options.limit === undefined ? 10 : Number(options.limit) });
  } finally { queue.close(); }
}

if (require.main === module) main().then(result => {
  if (result !== undefined) process.stdout.write(JSON.stringify(result) + "\n");
  if (result?.results?.some(item => item.state !== "delivered")) process.exitCode = 1;
}).catch(error => {
  // These validation errors are authored locally. Filesystem, database and JSON
  // failures may contain private paths or contents and must never be reflected.
  process.stderr.write(error instanceof TypeError || error instanceof SenderError ? error.message.slice(0, 300) + "\n" : "Events operation failed. Check local input, private storage, source access and documented limits.\n");
  process.exitCode = 1;
});

module.exports = { HELP, main, argumentsFor };
