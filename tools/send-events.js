#!/usr/bin/env node
"use strict";

const { createIntegrationClient, readBatchFile, SenderError } = require("./integration-client");
const HELP = "Usage: node tools/send-events.js --file /absolute/batch.json --token-file /absolute/private/source-token [--base-url PRIVATE_ORIGIN] [--attempts 3] [--timeout-ms 10000]\n"
  + "Send one complete canonical ingest-batch JSON document, at most 1 MiB / 1000 records.\n"
  + "Use an owner-only external file containing the source-ingest credential, never an MCP service token.\n"
  + "Retries preserve the batch's IDs, timestamps and encoded bytes. Keep the original batch until a matching durable receipt is received.\n";

function parseArguments(argv) {
  if (!Array.isArray(argv)) throw new SenderError("invalid-options", "Arguments must be an array.");
  if (argv.length === 1 && argv[0] === "--help") return { help: true };
  const options = {}, seen = new Set();
  for (let index = 0; index < argv.length; index += 2) {
    const key = { "--file": "file", "--token-file": "tokenFile", "--base-url": "baseUrl", "--attempts": "attempts", "--timeout-ms": "timeoutMs" }[argv[index]];
    const value = argv[index + 1];
    if (!key || seen.has(key) || typeof value !== "string" || !value || value.startsWith("--")) throw new SenderError("invalid-options", "Unsupported, duplicate or incomplete argument. Use --help. Raw token arguments are not accepted.");
    seen.add(key);
    if (["attempts", "timeoutMs"].includes(key) && !/^[1-9]\d*$/.test(value)) throw new SenderError("invalid-options", "Attempts and timeout must be positive integers.");
    options[key] = ["attempts", "timeoutMs"].includes(key) ? Number(value) : value;
  }
  if (!options.file || !options.tokenFile) throw new SenderError("invalid-options", "Both --file and --token-file are required. Use --help.");
  return options;
}

async function main(argv = process.argv.slice(2), output = process) {
  try {
    const { help, file, ...options } = parseArguments(argv);
    if (help) { output.stdout.write(HELP); return 0; }
    const batch = readBatchFile(file);
    const client = createIntegrationClient(options);
    output.stdout.write(JSON.stringify(await client.sendBatch(batch)) + "\n");
    return 0;
  } catch (error) {
    const safe = error instanceof SenderError ? error.message : "The request could not be completed safely. Keep the original batch and inspect the private sender configuration.";
    const status = error instanceof SenderError && error.status ? " (HTTP " + error.status + ")" : "";
    const wait = error instanceof SenderError && error.retryAfterMs ? " Server retry delay: " + error.retryAfterMs + " ms; no earlier retry was made." : "";
    output.stderr.write("Event send failed" + status + ": " + safe + wait + "\n");
    return 1;
  }
}

if (require.main === module) void main().then(code => { process.exitCode = code; });
module.exports = { HELP, parseArguments, main };
