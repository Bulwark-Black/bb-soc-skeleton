"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { validateBaseUrl } = require("../agent-mcp");
const { validateTimestamp } = require("../ingest-contract");
const ROOT = fs.realpathSync(path.resolve(__dirname, "../.."));
class CollectorError extends Error { constructor(code, retryAfterMs = 0) { super(code); this.name = "CollectorError"; this.code = code; this.retryAfterMs = retryAfterMs; } }
const fail = code => { throw new CollectorError(code); };
const hash = value => crypto.createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
function object(value) { if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid-config"); return value; }
function exact(value, keys) { object(value); if (Object.keys(value).some(k => !keys.includes(k))) fail("invalid-config"); }
function text(value, max = 1024) { if (typeof value !== "string" || !value || value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail("invalid-config"); return value; }
function absolute(value) { if (typeof value !== "string" || !path.isAbsolute(value) || path.resolve(value) !== value || value === path.parse(value).root) fail("unsafe-path"); return value; }
function external(value) { absolute(value); if (value === ROOT || value.startsWith(ROOT + path.sep)) fail("unsafe-path"); return value; }
function noLinks(value, create = false) {
  absolute(value); let current = path.parse(value).root;
  for (const part of value.slice(current.length).split(path.sep)) {
    current = path.join(current, part); let s = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!s && create) { fs.mkdirSync(current, { mode: 0o700 }); s = fs.lstatSync(current); }
    if (!s || s.isSymbolicLink()) fail("unsafe-path");
  }
}
function owned(stat) { return !(stat.mode & 0o077) && (typeof process.getuid !== "function" || stat.uid === process.getuid()); }
function privateFile(filename, missing = false) {
  const s = fs.lstatSync(filename, { throwIfNoEntry: false }); if (!s && missing) return;
  if (!s || !s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || !owned(s)) fail("unsafe-private-file"); return s;
}
function readPrivate(filename, max = 16384) {
  external(filename); noLinks(filename); const s = privateFile(filename); if (!s.size || s.size > max) fail("invalid-private-file");
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const start = fs.fstatSync(fd); if (start.dev !== s.dev || start.ino !== s.ino) fail("unsafe-private-file");
    const bytes = Buffer.alloc(s.size); const count = fs.readSync(fd, bytes, 0, bytes.length, 0); const end = fs.fstatSync(fd);
    if (count !== s.size || end.size !== s.size || end.mtimeMs !== start.mtimeMs || end.ctimeMs !== start.ctimeMs) fail("private-file-changed");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally { fs.closeSync(fd); }
}
function privateDirectory(directory) {
  external(directory); noLinks(directory, true); const s = fs.lstatSync(directory); if (!s.isDirectory() || !owned(s)) fail("unsafe-state");
  const allowed = new Set(["collector.sqlite", "collector.sqlite-wal", "collector.sqlite-shm", "collector.sqlite-journal", "identity"]);
  if (fs.readdirSync(directory).some(n => !allowed.has(n))) fail("state-not-dedicated");
  for (const name of allowed) privateFile(path.join(directory, name), true);
}
function timestamp(value) { try { validateTimestamp(value); return new Date(value).toISOString(); } catch { fail("invalid-time"); } }
function integer(v, min, max) { if (!Number.isSafeInteger(v) || v < min || v > max) fail("invalid-config"); return v; }
function uuid(v) { text(v, 36); if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v)) fail("invalid-config"); return v.toLowerCase(); }
function validateConfig(input) {
  exact(input, ["schemaVersion", "provider", "sourceId", "appId", "baseUrl", "tokenFile", "providerCredentialFile", "reviewedInput", "options", "maxSteps"]);
  if (input.schemaVersion !== 1 || input.reviewedInput !== true || !["checkmk", "wazuh", "microsoft365", "entra", "okta", "aws-cloudtrail-s3"].includes(input.provider)) fail("invalid-config");
  for (const key of ["sourceId", "appId"]) if (typeof input[key] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input[key])) fail("invalid-config");
  const c = JSON.parse(JSON.stringify(input)); c.baseUrl = validateBaseUrl(c.baseUrl); external(c.tokenFile);
  c.maxSteps = integer(c.maxSteps ?? 10, 1, 50); const o = object(c.options);
  if (!["wazuh", "aws-cloudtrail-s3"].includes(c.provider)) external(c.providerCredentialFile); else if (c.providerCredentialFile !== undefined) fail("invalid-config");
  if (c.provider === "checkmk") {
    exact(o, ["origin", "site", "apiVersion", "caFile", "hosts"]); o.origin = validateBaseUrl(o.origin);
    if (!o.origin.startsWith("https://") || !/^[A-Za-z0-9_-]{1,64}$/.test(o.site) || o.apiVersion !== "1.0") fail("invalid-config");
    if (o.caFile) external(o.caFile);
    if (!Array.isArray(o.hosts) || !o.hosts.length || o.hosts.length > 100 || new Set(o.hosts).size !== o.hosts.length) fail("invalid-config");
    o.hosts.forEach(h => text(h, 255));
  } else if (c.provider === "wazuh") {
    exact(o, ["file"]); external(o.file);
  } else if (c.provider === "aws-cloudtrail-s3") {
    exact(o, ["region", "bucket", "prefix", "expectedBucketOwner"]);
    if (typeof o.region !== "string" || !/^(?:us|eu|ap|sa|ca|me|af|il|mx)-(?:east|west|north|south|central|northeast|northwest|southeast|southwest)-[1-9]$/.test(o.region)) fail("invalid-config");
    if (typeof o.bucket !== "string" || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(o.bucket) || o.bucket.endsWith("--x-s3")) fail("invalid-config");
    text(o.prefix, 900); if (!o.prefix.endsWith("/") || o.prefix.startsWith("/") || o.prefix.split("/").includes("..") || !o.prefix.includes("/CloudTrail/")) fail("invalid-config");
    if (typeof o.expectedBucketOwner !== "string" || !/^[0-9]{12}$/.test(o.expectedBucketOwner)) fail("invalid-config");
  } else if (c.provider === "okta") {
    exact(o, ["origin", "startAt", "authScheme"]); const u = new URL(text(o.origin));
    if (u.protocol !== "https:" || u.port || u.username || u.password || u.pathname !== "/" || u.search || u.hash
        || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:okta\.com|oktapreview\.com|okta-emea\.com)$/.test(u.hostname)) fail("invalid-origin");
    o.origin = u.origin; o.startAt = timestamp(o.startAt); if (!["Bearer", "SSWS"].includes(o.authScheme)) fail("invalid-config");
  } else {
    exact(o, ["tenantId", "startAt", "windowSeconds", "lagSeconds", "overlapSeconds", ...(c.provider === "entra" ? ["dataset", "retentionDays"] : ["contentType", "publisherId"])]);
    o.tenantId = uuid(o.tenantId); o.startAt = timestamp(o.startAt);
    o.windowSeconds = integer(o.windowSeconds ?? 3600, 60, c.provider === "microsoft365" ? 86400 : 21600);
    o.lagSeconds = integer(o.lagSeconds ?? 120, 0, 86400); o.overlapSeconds = integer(o.overlapSeconds ?? 300, 0, o.windowSeconds - 1);
    if (c.provider === "microsoft365") {
      if (Date.parse(o.startAt) % 1000) fail("invalid-config");
      if (!["Audit.AzureActiveDirectory", "Audit.Exchange", "Audit.SharePoint", "Audit.General", "DLP.All"].includes(o.contentType)) fail("invalid-config");
      o.publisherId = uuid(o.publisherId);
    } else {
      if (!["signins", "directory-audits"].includes(o.dataset)) fail("invalid-config");
      o.retentionDays = integer(o.retentionDays, 1, 30);
    }
  }
  return c;
}
function readConfig(filename) { let v; try { v = JSON.parse(readPrivate(filename, 32768)); } catch (e) { if (e instanceof CollectorError) throw e; fail("invalid-config-file"); } return validateConfig(v); }
module.exports = { CollectorError, fail, hash, object, exact, text, absolute, external, noLinks, privateFile, readPrivate, privateDirectory, timestamp, validateConfig, readConfig };
