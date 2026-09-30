#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { listVendorAdapters, normalizeVendorPayload, parseVendorText, MAX_VENDOR_BYTES } = require("./vendor-adapters");
const { openOutbox } = require("./integration-outbox");

const HELP = `Vendor adapters v1 — exports/API pages, not automatic vendor polling
  vendor list
  vendor normalize --adapter ID --file ABSOLUTE --source-id ID --app-id ID
  vendor enqueue --adapter ID --file ABSOLUTE --source-id ID --app-id ID --outbox-dir ABSOLUTE [--base-url PRIVATE_ORIGIN]
  vendor status --outbox-dir ABSOLUTE [--state pending|inflight|blocked|delivered] [--source-id ID] [--offset 0..10000] [--limit 1..100]
  vendor drain --outbox-dir ABSOLUTE --source-id ID --token-file ABSOLUTE [--base-url PRIVATE_ORIGIN] [--limit 1..100]
  vendor retry --outbox-dir ABSOLUTE --id DELIVERY_ID
Use a dedicated owner-only outbox directory outside the checkout and app state.
No raw token, vendor key, arbitrary URL, executable mapping or credential environment option.
Normalize prints only canonical records; enqueue stores them before any network request.
Drain is one bounded pass. Schedule it externally; inspect pending/blocked results.
Status returns filtered metadata pages plus global queue totals; follow page.nextOffset.
`;
const OPTIONS = {
  list: [], normalize: ["adapter", "file", "source-id", "app-id"],
  enqueue: ["adapter", "file", "source-id", "app-id", "outbox-dir", "base-url"],
  status: ["outbox-dir", "state", "source-id", "offset", "limit"], drain: ["outbox-dir", "source-id", "token-file", "base-url", "limit"], retry: ["outbox-dir", "id"]
};
const REQUIRED = {
  list: [], normalize: ["adapter", "file", "source-id", "app-id"],
  enqueue: ["adapter", "file", "source-id", "app-id", "outbox-dir"],
  status: ["outbox-dir"], drain: ["outbox-dir", "source-id", "token-file"], retry: ["outbox-dir", "id"]
};
function argumentsFor(argv) {
  const [command, ...rest] = argv;
  if (!Object.hasOwn(OPTIONS, command)) throw new TypeError("Choose list, normalize, enqueue, status, drain or retry; use --help for usage.");
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index].startsWith("--") ? rest[index].slice(2) : "";
    if (!OPTIONS[command].includes(key) || Object.hasOwn(options, key) || !rest[index + 1] || rest[index + 1].startsWith("--")) throw new TypeError("Unknown, duplicate or missing vendor command option.");
    options[key] = rest[index + 1];
  }
  for (const key of REQUIRED[command]) if (!options[key]) throw new TypeError("A required vendor command option is missing; use --help.");
  return { command, options };
}
function readVendorFile(filename) {
  let fd;
  try {
    if (typeof filename !== "string" || !path.isAbsolute(filename) || filename !== path.resolve(filename)) throw new TypeError();
    let current = path.parse(filename).root;
    for (const part of filename.slice(current.length).split(path.sep)) {
      current = path.join(current, part); if (fs.lstatSync(current).isSymbolicLink()) throw new TypeError();
    }
    const named = fs.lstatSync(filename);
    if (!named.isFile() || named.size < 1 || named.size > MAX_VENDOR_BYTES) throw new TypeError();
    fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_VENDOR_BYTES || stat.ino !== named.ino || stat.dev !== named.dev) throw new TypeError();
    const buffer = Buffer.alloc(stat.size + 1); let count = 0;
    while (count < buffer.length) { const read = fs.readSync(fd, buffer, count, buffer.length - count, count); if (!read) break; count += read; }
    const after = fs.fstatSync(fd);
    if (count !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new TypeError();
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, count));
  } catch { throw new TypeError("Input must be stable UTF-8 JSON/NDJSON at a canonical absolute regular-file path without symbolic links, from 1 byte through 8 MiB."); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) { process.stdout.write(HELP); return; }
  const { command, options } = argumentsFor(argv);
  if (command === "list") return listVendorAdapters();
  let normalized;
  if (["normalize", "enqueue"].includes(command)) normalized = normalizeVendorPayload(options.adapter, parseVendorText(readVendorFile(options.file)), { sourceId: options["source-id"], estateId: options["app-id"] });
  if (command === "normalize") return normalized.batch;
  const queue = openOutbox(options["outbox-dir"]);
  try {
    if (command === "enqueue") return { ...queue.enqueue(normalized.batch, options["base-url"]), summary: normalized.summary };
    if (command === "status") {
      if (options.offset !== undefined && !/^(0|[1-9][0-9]{0,4})$/.test(options.offset)) throw new TypeError("Status offset must be a decimal integer from 0 through 10000.");
      if (options.limit !== undefined && !/^[1-9][0-9]{0,2}$/.test(options.limit)) throw new TypeError("Status limit must be a decimal integer from 1 through 100.");
      return queue.list({ state: options.state, sourceId: options["source-id"],
        offset: options.offset === undefined ? 0 : Number(options.offset), limit: options.limit === undefined ? 100 : Number(options.limit) });
    }
    if (command === "retry") return queue.retry(options.id);
    if (options.limit !== undefined && !/^[1-9][0-9]{0,2}$/.test(options.limit)) throw new TypeError("Drain limit must be a decimal integer from 1 through 100.");
    return await queue.drain({ baseUrl: options["base-url"], sourceId: options["source-id"], tokenFile: options["token-file"], limit: options.limit === undefined ? 10 : Number(options.limit) });
  } finally { queue.close(); }
}
if (require.main === module) main().then(result => {
  if (result !== undefined) process.stdout.write(JSON.stringify(result) + "\n");
  if (result?.results?.some(item => item.state !== "delivered")) process.exitCode = 1;
}).catch(error => {
  // JSON/SQLite/filesystem errors can include payloads or paths; never echo them.
  process.stderr.write(error instanceof TypeError ? error.message.slice(0, 300) + "\n" : "Vendor operation failed. Check local input, private storage, source access and documented limits.\n");
  process.exitCode = 1;
});
module.exports = { main, argumentsFor, readVendorFile };
