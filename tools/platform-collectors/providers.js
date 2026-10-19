"use strict";
const fs = require("node:fs");
const { fail, hash, noLinks, readPrivate, timestamp } = require("./common");
const { jsonRequest, safeNext } = require("./http");
const MAX_PAGES = 10000;
function array(v, max = 10000) { if (!Array.isArray(v) || v.length > max) fail("provider-invalid-page"); return v; }
function nextPage(c, next, current) {
  const seen = [...(c.seen || []), hash(current)];
  if (next && (seen.includes(hash(next)) || seen.length >= MAX_PAGES)) fail("pagination-loop-or-limit");
  return seen;
}
function closedWindow(config, cursor, now) {
  const o = config.options, watermark = cursor.watermark || o.startAt;
  const retention = config.provider === "microsoft365" ? 7 : o.retentionDays;
  const from = cursor.window?.from || new Date(Math.max(Date.parse(o.startAt), Date.parse(watermark) - o.overlapSeconds * 1000)).toISOString();
  if (Date.parse(from) < now - retention * 86400000) fail("upstream-retention-gap");
  if (cursor.window) return cursor.window;
  const to = new Date(Math.floor(Math.min(Date.parse(watermark) + o.windowSeconds * 1000, now - o.lagSeconds * 1000) / 1000) * 1000).toISOString();
  if (Date.parse(to) <= Date.parse(watermark)) return null;
  return { from, to, seen: [] };
}
function finishWindow(window) { return { watermark: window.to }; }
function headerRequest(url, authorization, extra = {}) { return { url, headers: { Authorization: authorization, Accept: "application/json" }, ...extra }; }
async function entra(ctx) {
  const { config, cursor, now, send, authorization } = ctx; const w = closedWindow(config, cursor, now);
  if (!w) return { cursor, complete: true, idle: true };
  const o = config.options, name = o.dataset === "signins" ? "signIns" : "directoryAudits", timeKey = o.dataset === "signins" ? "createdDateTime" : "activityDateTime";
  const path = `/v1.0/auditLogs/${name}`, origin = "https://graph.microsoft.com";
  const first = new URL(origin + path); first.searchParams.set("$filter", `${timeKey} ge ${w.from} and ${timeKey} le ${w.to}`); first.searchParams.set("$top", "100");
  const url = w.next ? safeNext(w.next, origin, path) : first.href;
  const r = await jsonRequest(send, headerRequest(url, authorization), now);
  const rows = array(r.body?.value, 1000);
  for (const row of rows) if (!row || typeof row[timeKey] !== "string" || !Number.isFinite(Date.parse(row[timeKey])) || Date.parse(row[timeKey]) < Date.parse(w.from) || Date.parse(row[timeKey]) > Date.parse(w.to)) fail("provider-event-outside-window");
  const next = r.body["@odata.nextLink"] ? safeNext(r.body["@odata.nextLink"], origin, path) : null;
  const seen = nextPage(w, next, url);
  return { adapterId: name === "signIns" ? "entra-signin" : "entra-directory-audit", rows,
    cursor: next ? { ...cursor, window: { ...w, next, seen } } : finishWindow(w), complete: !next };
}
async function okta(ctx) {
  const { config, cursor, now, send, authorization } = ctx, o = config.options;
  if (Date.parse(cursor.lastReadAt || o.startAt) < now - 90 * 86400000) fail("upstream-retention-gap");
  const first = new URL(o.origin + "/api/v1/logs"); first.searchParams.set("since", o.startAt); first.searchParams.set("sortOrder", "ASCENDING"); first.searchParams.set("limit", "100");
  const url = cursor.next ? safeNext(cursor.next, o.origin, "/api/v1/logs") : first.href;
  const r = await jsonRequest(send, headerRequest(url, authorization), now), rows = array(r.body, 1000);
  const matches = [...(r.headers.link || "").matchAll(/<([^>]+)>\s*;\s*rel="next"/g)];
  if (matches.length !== 1) fail("provider-missing-poll-cursor");
  const next = safeNext(matches[0][1], o.origin, "/api/v1/logs");
  const u = new URL(next);
  if (u.searchParams.get("until") || u.searchParams.get("sortOrder") !== "ASCENDING" || !u.searchParams.get("after")) fail("invalid-poll-cursor");
  const seen = rows.length ? nextPage(cursor, next, url).slice(-1000) : [];
  return { adapterId: "okta-system-log", rows, cursor: { next, seen, lastReadAt: new Date(now).toISOString() }, complete: rows.length === 0 };
}
async function microsoft365(ctx) {
  const { config, cursor, now, send, authorization, hasContent } = ctx, o = config.options;
  const w = closedWindow(config, cursor, now); if (!w) return { cursor, complete: true, idle: true };
  const origin = "https://manage.office.com", base = `/api/v1.0/${o.tenantId}/activity/feed`, listPath = base + "/subscriptions/content";
  if (w.items?.length) {
    const [item, ...rest] = w.items;
    const ledger = { key: "m365:" + hash([o.contentType, item.contentId]), fingerprint: hash([item.contentType, item.contentId, item.contentCreated]), at: Date.parse(item.contentCreated) };
    const nextCursor = rest.length || w.next ? { ...cursor, window: { ...w, items: rest } } : finishWindow(w);
    if (hasContent(ledger)) return { cursor: nextCursor, complete: !rest.length && !w.next };
    if (Date.parse(item.contentExpiration) <= now) fail("upstream-content-expired");
    const u = new URL(item.contentUri); u.searchParams.set("PublisherIdentifier", o.publisherId);
    const r = await jsonRequest(send, headerRequest(u.href, authorization), now), rows = array(r.body);
    if (!rows.length) fail("provider-empty-content");
    for (const row of rows) if (typeof row?.OrganizationId !== "string" || row.OrganizationId.toLowerCase() !== o.tenantId) fail("provider-tenant-mismatch");
    return { adapterId: "microsoft365-audit", rows, cursor: nextCursor, content: ledger, complete: !rest.length && !w.next };
  }
  const first = new URL(origin + listPath);
  first.searchParams.set("contentType", o.contentType); first.searchParams.set("PublisherIdentifier", o.publisherId);
  first.searchParams.set("startTime", w.from.slice(0, 19)); first.searchParams.set("endTime", w.to.slice(0, 19));
  function listingNext(value) {
    let u; try { u = new URL(value); } catch { fail("unsafe-pagination-url"); }
    const alternate = listPath.replace("/api/v1.0/", "/api/v1/");
    safeNext(value, origin, u.pathname === alternate ? alternate : listPath);
    const publisher = u.searchParams.get("PublisherIdentifier");
    if (publisher && publisher !== o.publisherId) fail("pagination-scope-changed");
    u.searchParams.set("PublisherIdentifier", o.publisherId); return u.href;
  }
  const url = w.next ? listingNext(w.next) : first.href;
  const r = await jsonRequest(send, headerRequest(url, authorization), now); const seenIds = new Set();
  const items = array(r.body, 1000).map(item => {
    if (!item || typeof item.contentId !== "string" || !item.contentId || item.contentId.length > 2048 || seenIds.has(item.contentId) || item.contentType !== o.contentType) fail("provider-invalid-content");
    seenIds.add(item.contentId);
    const created = timestamp(item.contentCreated), expiration = timestamp(item.contentExpiration);
    if (Date.parse(created) < Date.parse(w.from) || Date.parse(created) >= Date.parse(w.to) || Date.parse(expiration) <= Date.parse(created)) fail("provider-content-outside-window");
    let u; try { u = new URL(item.contentUri); } catch { fail("unsafe-content-url"); }
    if (u.origin !== origin || !u.pathname.startsWith(base + "/audit/") || u.pathname.slice((base + "/audit/").length).includes("/") || !u.pathname.slice((base + "/audit/").length) || u.username || u.password || u.hash || u.search) fail("unsafe-content-url");
    return { contentId: item.contentId, contentType: item.contentType, contentCreated: created, contentExpiration: expiration, contentUri: u.href };
  });
  const next = r.headers.nextpageuri ? listingNext(r.headers.nextpageuri) : null;
  if (next) {
    const n = new URL(next); if (n.searchParams.get("contentType") !== o.contentType || n.searchParams.get("startTime") !== first.searchParams.get("startTime") || n.searchParams.get("endTime") !== first.searchParams.get("endTime")) fail("pagination-scope-changed");
  }
  const seen = nextPage(w, next, url);
  return { cursor: items.length || next ? { ...cursor, window: { ...w, items, next, seen } } : finishWindow(w), complete: !items.length && !next };
}
async function checkmk(ctx) {
  const { config, cursor, now, send, authorization } = ctx, o = config.options;
  const index = cursor.index || 0, dataset = cursor.dataset || "host", hostname = o.hosts[index];
  if (!hostname) fail("invalid-saved-cursor");
  const names = dataset === "host" ? ["name"] : ["host_name", "description"];
  const body = JSON.stringify({ columns: [...names, "state", "has_been_checked", "last_check", "plugin_output"], sites: [o.site], query: { op: "=", left: dataset === "host" ? "name" : "host_name", right: hostname } });
  const url = `${o.origin}/${o.site}/check_mk/api/${o.apiVersion}/domain-types/${dataset}/collections/all`;
  const r = await jsonRequest(send, headerRequest(url, authorization, { method: "POST", body, headers: { Authorization: authorization, Accept: "application/json", "Content-Type": "application/json" }, privateNetwork: true, ...(o.caFile ? { ca: readPrivate(o.caFile, 1024 * 1024) } : {}) }), now);
  if (r.body?.domainType !== dataset) fail("provider-invalid-page");
  const values = array(r.body.value, 1000); if (dataset === "host" && values.length !== 1) fail("configured-host-unavailable");
  const collectedAt = new Date(now).toISOString();
  const rows = values.map(v => {
    if (!v?.extensions || (dataset === "host" ? v.extensions.name : v.extensions.host_name) !== hostname) fail("provider-host-mismatch");
    return { dataset, site: o.site, extensions: v.extensions, collectedAt };
  });
  const complete = dataset === "service" && index + 1 === o.hosts.length;
  return { adapterId: "checkmk-status", rows, cursor: complete ? {} : { index: dataset === "host" ? index : index + 1, dataset: dataset === "host" ? "service" : "host" }, complete };
}
function anchor(fd, offset) { const bytes = Buffer.alloc(Math.min(offset, 512)); if (fs.readSync(fd, bytes, 0, bytes.length, offset - bytes.length) !== bytes.length) fail("input-changed"); return hash(bytes); }
function wazuh(ctx) {
  const { config, cursor } = ctx, filename = config.options.file; noLinks(filename);
  const s = fs.lstatSync(filename); if (!s.isFile() || s.nlink !== 1) fail("unsafe-input");
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const start = fs.fstatSync(fd); const offset = cursor.offset || 0;
    if (start.dev !== s.dev || start.ino !== s.ino || cursor.dev !== undefined && (cursor.dev !== start.dev || cursor.ino !== start.ino || offset > start.size || anchor(fd, offset) !== cursor.anchor)) fail("input-changed");
    const bytes = Buffer.alloc(Math.min(1024 * 1024, start.size - offset)); const count = fs.readSync(fd, bytes, 0, bytes.length, offset);
    if (count !== bytes.length) fail("input-changed");
    let consumed = 0; const rows = [];
    while (rows.length < 100 && consumed < bytes.length) {
      const newline = bytes.indexOf(10, consumed);
      if (newline < 0) { if (bytes.length - consumed >= 256 * 1024) fail("line-too-long"); break; }
      if (newline - consumed > 256 * 1024) fail("line-too-long");
      let row; try { row = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(consumed, newline))); } catch { fail("invalid-line"); }
      if (!row || typeof row !== "object" || Array.isArray(row)) fail("invalid-line"); rows.push(row); consumed = newline + 1;
    }
    const end = fs.fstatSync(fd), current = fs.lstatSync(filename);
    if (end.dev !== start.dev || end.ino !== start.ino || current.dev !== start.dev || current.ino !== start.ino || end.size < start.size || (cursor.anchor !== undefined && anchor(fd, offset) !== cursor.anchor)) fail("input-changed");
    const confirmation = Buffer.alloc(consumed);
    if (fs.readSync(fd, confirmation, 0, confirmation.length, offset) !== confirmation.length || !confirmation.equals(bytes.subarray(0, consumed))) fail("input-changed");
    const nextOffset = offset + consumed, cursorOut = { dev: start.dev, ino: start.ino, offset: nextOffset, anchor: anchor(fd, nextOffset) };
    return { adapterId: "wazuh-alerts", rows, cursor: cursorOut, complete: nextOffset === start.size, partialLine: nextOffset < start.size && rows.length < 100 };
  } finally { fs.closeSync(fd); }
}
module.exports = { step: ctx => ctx.config.provider === "aws-cloudtrail-s3" ? require("./aws").aws(ctx) : ({ checkmk, wazuh, microsoft365, entra, okta })[ctx.config.provider](ctx), closedWindow };
