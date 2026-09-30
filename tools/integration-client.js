"use strict";

// Node-only sender for already-normalized records. No vendor SDK, collector,
// scheduler, raw-event mapper, secret resolver, or telemetry transport over MCP.
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { validateBaseUrl } = require("./agent-mcp");
const { validateIngestBatch, validateTimestamp } = require("./ingest-contract");

const MAX_BATCH_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_RETRY_DELAY_MS = 30_000;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const ROOT = path.resolve(__dirname, "..");

class SenderError extends Error {
  constructor(code, message, metadata = {}) {
    super(message); this.name = "SenderError"; this.code = code;
    for (const key of ["status", "attempts", "retryAfterMs"]) {
      if (Number.isSafeInteger(metadata[key]) && metadata[key] >= 0) this[key] = metadata[key];
    }
  }
}

function fail(code, message, metadata) { throw new SenderError(code, message, metadata); }
function integer(value, fallback, minimum, maximum) {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) fail("invalid-options", "Sender numeric options are outside their documented bounds.");
  return result;
}

function readBoundedFile(filename, maximum, token = false) {
  let fd;
  try {
    if (typeof filename !== "string" || !path.isAbsolute(filename) || filename !== path.resolve(filename)) throw new Error();
    if (token) {
      const repository = fs.realpathSync(ROOT);
      if (filename === repository || filename.startsWith(repository + path.sep)) throw new Error();
    }
    let cursor = path.parse(filename).root;
    for (const part of filename.slice(cursor.length).split(path.sep)) {
      cursor = path.join(cursor, part);
      if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error();
    }
    const named = fs.lstatSync(filename);
    fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > maximum || named.ino !== stat.ino || named.dev !== stat.dev
        || (token && (stat.nlink !== 1 || (stat.mode & 0o077) || (typeof process.getuid === "function" && stat.uid !== process.getuid())))) throw new Error();
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    const after = fs.fstatSync(fd);
    if (offset !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error();
    return bytes.subarray(0, offset);
  } catch {
    fail(token ? "invalid-token-file" : "invalid-batch-file", token
      ? "Source token file must be an owner-only regular file without links, outside the repository at a canonical absolute path."
      : "Batch file must be stable, regular, nonempty, at a canonical absolute path without symbolic links, and no larger than 1 MiB.");
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function readSourceTokenFile(filename) {
  const bytes = readBoundedFile(filename, 514, true);
  try {
    const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r?\n$/, "");
    // The source plane issues unprefixed base64url credentials. A service token
    // is a different identity and must not accidentally be used for ingestion.
    if (!/^[A-Za-z0-9_-]{32,512}$/.test(value) || value.startsWith("bbsvc_")) throw new Error();
    return value;
  } catch { fail("invalid-token-file", "Token file must contain one issued source-ingest credential, not a service credential or browser session."); }
  finally { bytes.fill(0); }
}

function prepareBatch(value) {
  let batch, body;
  try { batch = validateIngestBatch(value); body = JSON.stringify(batch); }
  catch { fail("invalid-batch", "Batch does not satisfy the version-1 canonical ingest contract. Validate it locally before sending."); }
  if (Buffer.byteLength(body, "utf8") > MAX_BATCH_BYTES) fail("batch-too-large", "Encoded batch exceeds the 1 MiB ingress limit; split records into separately persisted batches before sending.");
  return Object.freeze({ batch, body });
}

function readBatchFile(filename) {
  const bytes = readBoundedFile(filename, MAX_BATCH_BYTES);
  let value;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { fail("invalid-batch", "Batch file must contain one complete UTF-8 JSON ingest-batch document."); }
  return prepareBatch(value).batch;
}

function validateReceipt(value, batch) {
  const keys = ["schemaVersion", "documentType", "sourceId", "receiptId", "status", "accepted", "duplicates", "receivedAt", "replay"];
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length
        || Object.keys(value).some(key => !keys.includes(key)) || value.schemaVersion !== "1"
        || value.documentType !== "ingest-receipt" || value.sourceId !== batch.sourceId || value.receiptId !== batch.receiptId
        || value.status !== "accepted" || typeof value.replay !== "boolean"
        || !Number.isSafeInteger(value.accepted) || value.accepted < 0
        || !Number.isSafeInteger(value.duplicates) || value.duplicates < 0
        || value.accepted + value.duplicates !== batch.records.length) throw new Error();
    validateTimestamp(value.receivedAt, "receipt.receivedAt");
    return Object.freeze(Object.fromEntries(keys.map(key => [key, value[key]])));
  } catch { fail("invalid-receipt", "Ingest server did not return a valid matching receipt. Keep the original batch for investigation or replay."); }
}

async function discardResponse(response) {
  // An unread rejected body is not evidence of a transient admission failure.
  // Cancellation errors must not turn a definite 4xx/redirect into a retry.
  try { await response.body?.cancel(); } catch { /* No remote body retained. */ }
}

async function readReceipt(response, batch) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get("content-type") || "")) {
    await discardResponse(response); fail("invalid-receipt", "Ingest server returned an unsupported receipt format.");
  }
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    await discardResponse(response); fail("response-too-large", "Ingest receipt exceeds the 64 KiB response limit.");
  }
  const reader = response.body?.getReader();
  if (!reader) fail("invalid-receipt", "Ingest server returned an empty receipt.");
  const chunks = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch { /* Refuse oversized data even if cancellation fails. */ }
        fail("response-too-large", "Ingest receipt exceeds the 64 KiB response limit.");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let document;
  try { document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { fail("invalid-receipt", "Ingest server returned an invalid JSON receipt."); }
  return validateReceipt(document, batch);
}

function retryAfterMs(value, now = Date.now()) {
  if (typeof value !== "string" || !value.trim() || value.length > 128) return null;
  const seconds = /^\d+$/.test(value) ? Number(value) : null;
  if (seconds !== null) return Number.isSafeInteger(seconds * 1000) ? seconds * 1000 : Number.MAX_SAFE_INTEGER;
  // Only accept an HTTP-date, not Date.parse's permissive numeric/year syntax.
  if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : null;
}

function createIntegrationClient(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)
      || Object.keys(options).some(key => !["baseUrl", "tokenFile", "attempts", "timeoutMs", "backoffMs"].includes(key))) fail("invalid-options", "Use only baseUrl, tokenFile, attempts, timeoutMs and backoffMs sender options; raw credentials are not accepted.");
  let baseUrl;
  try { baseUrl = validateBaseUrl(options.baseUrl || "http://127.0.0.1:8080"); }
  catch { fail("invalid-origin", "Destination must be an exact loopback origin or approved private HTTPS origin, without credentials, path, query or fragment."); }
  const tokenFile = options.tokenFile;
  const attempts = integer(options.attempts, 3, 1, 5);
  const timeoutMs = integer(options.timeoutMs, 10_000, 50, 30_000);
  const backoffMs = integer(options.backoffMs, 250, 25, 5000);
  // Validate custody before returning the client, but do not cache the secret.
  readSourceTokenFile(tokenFile);
  return Object.freeze({
    async sendBatch(value) {
      const { batch, body } = prepareBatch(value);
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const token = readSourceTokenFile(tokenFile);
        let failure, waitMs = Math.min(backoffMs * (2 ** (attempt - 1)), MAX_RETRY_DELAY_MS);
        try {
          const response = await fetch(baseUrl + "/api/v1/ingest", {
            method: "POST", redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
            headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: "Bearer " + token }, body
          });
          if (response.status === 200) return await readReceipt(response, batch);
          const requestedWait = retryAfterMs(response.headers.get("retry-after"));
          await discardResponse(response);
          failure = new SenderError("ingest-rejected", "Ingest request was rejected; check source state, credential, schema, capacity and replay window. Remote response content was not retained.", { status: response.status, attempts: attempt, ...(requestedWait !== null ? { retryAfterMs: requestedWait } : {}) });
          if (!RETRYABLE_STATUS.has(response.status) || requestedWait > MAX_RETRY_DELAY_MS) throw failure;
          waitMs = Math.max(waitMs, requestedWait || 0);
        } catch (error) {
          if (error instanceof SenderError) throw error;
          // Network failures include a lost acknowledgement after a commit.
          // Never regenerate receipt IDs, timestamps, or bytes before retrying.
          failure = new SenderError("network-unavailable", "Private ingest request could not complete. Keep the unchanged batch; the server may have committed it before the connection failed.", { attempts: attempt });
        }
        if (attempt === attempts) throw failure;
        await delay(waitMs);
      }
    }
  });
}

module.exports = { createIntegrationClient, prepareBatch, readBatchFile, readSourceTokenFile,
  validateReceipt, retryAfterMs, SenderError, MAX_BATCH_BYTES, MAX_RESPONSE_BYTES, MAX_RETRY_DELAY_MS };
