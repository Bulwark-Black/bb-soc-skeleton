#!/usr/bin/env node
"use strict";

// Read an existing local report and send it to one explicitly selected private
// application. This command never invokes Trivy or obtains reports remotely.
const fs = require("node:fs");
const path = require("node:path");
const { validatePrivateOrigin } = require("../server/private-auth");
const { TRIVY_REPORT_LIMIT } = require("../server/scanner-ingest");
const RESPONSE_LIMIT = 64 * 1024;
class SenderError extends Error {}

const HELP = "Usage: node tools/import-trivy.js --file /absolute/report.json --source-id SOURCE_ID --credential-stdin [--base-url PRIVATE_ORIGIN]\n"
  + "Pipe the source-ingest credential on standard input from your credential manager. Do not pass it as a command argument.\n"
  + "The destination must be a loopback HTTP origin or private Tailnet HTTPS origin. The original report is not retained by the importer.\n";

function argumentsFor(argv) {
  const options = { baseURL: "http://127.0.0.1:8080" };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (seen.has(flag)) throw new SenderError("Duplicate argument."); seen.add(flag);
    if (flag === "--help") return { help: true };
    if (flag === "--credential-stdin") { options.credentialStdin = true; continue; }
    const key = { "--base-url": "baseURL", "--file": "file", "--source-id": "sourceId" }[flag];
    if (!key || !argv[index + 1] || argv[index + 1].startsWith("--")) throw new SenderError("Unsupported or incomplete argument. Use --help.");
    options[key] = argv[++index];
  }
  try { options.baseURL = validatePrivateOrigin(options.baseURL); }
  catch { throw new SenderError("Destination must be a loopback HTTP origin or private Tailnet HTTPS origin."); }
  if (!options.credentialStdin) throw new SenderError("Use --credential-stdin to supply a scoped source credential privately.");
  if (typeof options.file !== "string" || !path.isAbsolute(options.file)) throw new SenderError("--file must name an absolute local JSON report path.");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.sourceId || "")) throw new SenderError("--source-id must be a valid source identifier.");
  return options;
}

async function readCredential(stream) {
  if (stream.isTTY) throw new SenderError("Pipe a source credential on standard input; interactive credential echo is not supported.");
  let value = "";
  for await (const chunk of stream) {
    value += chunk.toString("utf8");
    if (value.length > 600) throw new SenderError("Source credential input exceeds its bound.");
  }
  value = value.trim();
  if (!/^[A-Za-z0-9_-]{32,512}$/.test(value)) throw new SenderError("Source credential input is invalid.");
  return value;
}

async function readResult(response) {
  if (!response.ok) {
    if (response.body) await response.body.cancel();
    throw new SenderError("Import rejected (HTTP " + response.status + "). Check the source state, scoped credential, report format, size and replay window.");
  }
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get("content-type") || "")) {
    if (response.body) await response.body.cancel();
    throw new SenderError("Import server returned an unsupported response format.");
  }
  const reader = response.body && response.body.getReader();
  if (!reader) throw new SenderError("Import server returned an empty response.");
  const chunks = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > RESPONSE_LIMIT) { await reader.cancel(); throw new SenderError("Import server response exceeds 64 KiB."); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let result;
  try { result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new SenderError("Import server returned invalid JSON."); }
  const receipt = result && result.receipt, summary = result && result.summary;
  const count = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 1000;
  if (!result || result.schemaVersion !== "1" || result.documentType !== "scanner-import-result" || result.scanner !== "trivy"
      || !receipt || receipt.schemaVersion !== "1" || receipt.documentType !== "ingest-receipt" || receipt.status !== "accepted"
      || !/^trivy:[a-f0-9]{64}$/.test(receipt.receiptId) || typeof receipt.replay !== "boolean" || !count(receipt.accepted)
      || !summary || !count(summary.packageCount) || !count(summary.vulnerabilityCount)) {
    throw new SenderError("Import server returned an invalid receipt.");
  }
  return { receiptId: receipt.receiptId, accepted: receipt.accepted, replay: receipt.replay,
    packageCount: summary.packageCount, vulnerabilityCount: summary.vulnerabilityCount };
}

async function main(argv = process.argv.slice(2)) {
  let descriptor;
  try {
    const options = argumentsFor(argv);
    if (options.help) { process.stdout.write(HELP); return; }
    descriptor = fs.openSync(options.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size < 1 || stat.size > TRIVY_REPORT_LIMIT) throw new SenderError("Report must be a regular nonempty file no larger than 8 MiB.");
    const body = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < body.length) {
      const read = fs.readSync(descriptor, body, offset, body.length - offset, offset);
      if (!read) throw new SenderError("Report changed while reading; retry with a stable completed file.");
      offset += read;
    }
    if (fs.fstatSync(descriptor).size !== stat.size) throw new SenderError("Report changed while reading; retry with a stable completed file.");
    fs.closeSync(descriptor); descriptor = undefined;
    const credential = await readCredential(process.stdin);
    const response = await fetch(options.baseURL + "/api/v1/scanners/trivy/import?sourceId=" + encodeURIComponent(options.sourceId), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(30000),
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + credential, Accept: "application/json" }, body
    });
    process.stdout.write(JSON.stringify(await readResult(response)) + "\n");
  } catch (error) {
    // Filesystem error messages can include local paths; do not echo report
    // content, credential values, or the selected destination on failures.
    process.stderr.write("Trivy import failed: " + (error instanceof SenderError ? error.message
      : error.code && /^(ENOENT|EACCES|ELOOP|EISDIR)$/.test(error.code)
        ? "The local report could not be opened as a readable regular file."
        : "The request could not be completed. Verify the private destination and network; retrying the same report is safe.") + "\n");
    process.exitCode = 1;
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

if (require.main === module) void main();
module.exports = { argumentsFor, readCredential, readResult, main };
