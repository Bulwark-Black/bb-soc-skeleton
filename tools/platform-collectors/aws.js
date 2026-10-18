"use strict";
const zlib = require("node:zlib"), https = require("node:https");
const { S3Client, ListObjectsV2Command, GetObjectCommand } = require("@aws-sdk/client-s3");
const { CollectorError, fail, hash } = require("./common");
const MAX_BYTES = 8 * 1024 * 1024;
function createS3Client(options) {
  const endpoint = `https://s3.${options.region}.amazonaws.com`;
  const client = new S3Client({ region: options.region, endpoint, ignoreConfiguredEndpointUrls: true, forcePathStyle: true,
    followRegionRedirects: false, useArnRegion: false, useAccelerateEndpoint: false, useDualstackEndpoint: false, useFipsEndpoint: false,
    disableS3ExpressSessionAuth: true, maxAttempts: 1, requestHandler: { httpsAgent: new https.Agent({ rejectUnauthorized: true }), connectionTimeout: 5000, requestTimeout: 30000, socketTimeout: 30000 } });
  // Defend even if the SDK endpoint configuration behavior changes.
  client.middlewareStack.add(next => args => {
    if (args.request.protocol !== "https:" || args.request.hostname !== new URL(endpoint).hostname || args.request.port) fail("unapproved-aws-endpoint");
    return next(args);
  }, { step: "finalizeRequest", name: "approvedS3Endpoint", priority: "high" });
  return client;
}
async function request(client, command) {
  try { return await client.send(command, { abortSignal: AbortSignal.timeout(30000) }); }
  catch (e) {
    if (e instanceof CollectorError) throw e;
    const status = e?.$metadata?.httpStatusCode;
    throw new CollectorError(status === 401 || status === 403 ? "provider-unauthorized" : status === 412 ? "upstream-object-changed" : "aws-request-failed", !status || [429, 500, 502, 503, 504].includes(status) ? 30000 : 0);
  }
}
async function boundedBody(body) {
  if (!body || typeof body[Symbol.asyncIterator] !== "function") fail("aws-invalid-body");
  let total = 0; const chunks = [];
  try {
    for await (const chunk of body) { const bytes = Buffer.from(chunk); total += bytes.length; if (total > MAX_BYTES) { body.destroy?.(); fail("aws-object-too-large"); } chunks.push(bytes); }
  } catch (e) { body.destroy?.(); if (e instanceof CollectorError) throw e; throw new CollectorError("aws-body-unavailable", 30000); }
  return Buffer.concat(chunks);
}
async function aws(ctx) {
  const { config, cursor, hasContent, now } = ctx, o = config.options;
  const owned = !ctx.s3Client, client = ctx.s3Client || createS3Client(o);
  try {
    if (cursor.items?.length) {
      const [item, ...rest] = cursor.items;
      const content = { key: "s3:" + hash([o.bucket, item.key]), fingerprint: hash([item.etag, item.size]), at: item.modified };
      const next = rest.length || cursor.next ? { ...cursor, items: rest } : {};
      if (hasContent(content)) return { cursor: next, complete: !rest.length && !cursor.next };
      const response = await request(client, new GetObjectCommand({ Bucket: o.bucket, Key: item.key, ExpectedBucketOwner: o.expectedBucketOwner, IfMatch: item.etag }));
      if (response.ETag !== item.etag || response.ContentLength !== item.size) { response.Body?.destroy?.(); fail("upstream-object-changed"); }
      const compressed = await boundedBody(response.Body); if (compressed.length !== item.size) fail("aws-body-truncated");
      let bytes;
      try { bytes = item.key.endsWith(".gz") ? zlib.gunzipSync(compressed, { maxOutputLength: MAX_BYTES }) : compressed; } catch { fail("aws-invalid-or-oversize-gzip"); }
      let value; try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { fail("aws-invalid-cloudtrail-json"); }
      if (!value || !Array.isArray(value.Records) || value.Records.length < 1 || value.Records.length > 10000) fail("aws-invalid-cloudtrail-json");
      return { adapterId: "aws-cloudtrail", rows: value.Records, content, cursor: next, complete: !rest.length && !cursor.next };
    }
    const response = await request(client, new ListObjectsV2Command({ Bucket: o.bucket, Prefix: o.prefix, ExpectedBucketOwner: o.expectedBucketOwner,
      MaxKeys: 100, ...(cursor.next ? { ContinuationToken: cursor.next } : {}) }));
    if (response.Name !== o.bucket || response.Prefix !== o.prefix || typeof response.IsTruncated !== "boolean" || !Array.isArray(response.Contents || []) || (response.Contents || []).length > 100) fail("aws-invalid-list");
    const seenKeys = new Set();
    const items = (response.Contents || []).map(item => {
      const key = item.Key, etag = item.ETag, modified = new Date(item.LastModified).getTime();
      if (typeof key !== "string" || !key.startsWith(o.prefix) || key.length > 1024 || !/\.json(?:\.gz)?$/.test(key) || seenKeys.has(key)
          || typeof etag !== "string" || !etag || etag.length > 200 || !Number.isSafeInteger(item.Size) || item.Size <= 0 || item.Size > MAX_BYTES || !Number.isSafeInteger(modified) || modified > now + 300000) fail("aws-invalid-object-metadata");
      seenKeys.add(key); return { key, etag, size: item.Size, modified };
    });
    const next = response.IsTruncated ? response.NextContinuationToken : null;
    if (response.IsTruncated && (typeof next !== "string" || !next || next.length > 16384)) fail("aws-missing-page-cursor");
    const seen = [...(cursor.seen || []), hash(cursor.next || "first")];
    if (next && (seen.includes(hash(next)) || seen.length >= 10000)) fail("pagination-loop-or-limit");
    return { cursor: items.length || next ? { items, next, seen } : {}, complete: !items.length && !next };
  } finally { if (owned) client.destroy(); }
}
module.exports = { aws, createS3Client, boundedBody };
