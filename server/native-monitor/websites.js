"use strict";
const { digest } = require("./store");
const MAX_HISTORY_POINTS = 1200;
function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function plain(value) { return !!value && typeof value === "object" && !Array.isArray(value); }
function createWebsites(store, definitions = []) {
  if (!Array.isArray(definitions) || definitions.length > 20) fail("At most 20 configured website targets are supported.");
  const targets = new Map(), urls = new Set();
  for (const item of definitions) {
    if (!plain(item) || Object.keys(item).some(key => !["id", "host", "url", "label"].includes(key))
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,100}$/.test(item.id) || targets.has(item.id) || !store.hostMap.has(item.host)
        || typeof item.label !== "string" || !item.label.trim() || item.label.length > 200 || typeof item.url !== "string" || item.url.length > 300) fail("Invalid configured website target.");
    let url; try { url = new URL(item.url); } catch { fail("Invalid website URL."); }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || urls.has(item.url)) fail("Website targets require unique credential-free HTTPS URLs without query or fragment.");
    targets.set(item.id, { ...item }); urls.add(item.url);
  }
  const db = store.db;
  db.exec("CREATE TABLE IF NOT EXISTS website_targets(id TEXT PRIMARY KEY,host TEXT NOT NULL,url TEXT NOT NULL);" +
    "CREATE TABLE IF NOT EXISTS website_receipts(host TEXT NOT NULL,id TEXT NOT NULL,digest TEXT NOT NULL,response TEXT NOT NULL,PRIMARY KEY(host,id));" +
    "CREATE TABLE IF NOT EXISTS website_current(id TEXT PRIMARY KEY,body TEXT NOT NULL);" +
    "CREATE TABLE IF NOT EXISTS website_points(id TEXT NOT NULL,at INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(id,at));" +
    "CREATE INDEX IF NOT EXISTS website_points_expiry ON website_points(at);");
  store.transaction(() => {
    for (const target of targets.values()) {
      const prior = db.prepare("SELECT host,url FROM website_targets WHERE id=?").get(target.id);
      if (prior && (prior.host !== target.host || prior.url !== target.url)) fail("A website identity cannot be rebound to another host or URL. Register a new identity.", 409);
      db.prepare("INSERT OR IGNORE INTO website_targets VALUES(?,?,?)").run(target.id, target.host, target.url);
    }
  });
  function ingest(host, sourceId, batch) {
    if (!plain(batch) || Object.keys(batch).some(key => !["schemaVersion", "batchId", "observedAt", "checks"].includes(key)) || batch.schemaVersion !== 1
        || typeof batch.batchId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(batch.batchId)
        || !Array.isArray(batch.checks) || !batch.checks.length || batch.checks.length > 20) fail("Invalid website batch.");
    const now = store.now(), observed = Date.parse(batch.observedAt), hash = digest(batch);
    if (!Number.isFinite(observed)) fail("Invalid website batch time.");
    if (store.hostMap.get(host)?.sourceId !== sourceId) fail("Website source mismatch.", 403);
    const prior = db.prepare("SELECT * FROM website_receipts WHERE host=? AND id=?").get(host, batch.batchId);
    if (prior) { if (prior.digest !== hash) fail("Website batch identity conflict.", 409); return { ...JSON.parse(prior.response), replay: true }; }
    if (observed < now - 48 * 3600000 || observed > now + 30000) fail("Website batch time is outside the admitted interval.");
    const seen = new Set(), checks = batch.checks.map(check => {
      const item = [...targets.values()].find(target => target.host === host && target.url === check?.url);
      if (!item || !plain(check) || seen.has(item.id) || Object.keys(check).sort().join(",") !== "at,certNotAfter,error,ms,redirect,status,url") fail("Website observation is duplicate, unregistered, or malformed.");
      seen.add(item.id);
      const at = Date.parse(check.at);
      if (!Number.isFinite(at) || at > observed || at < observed - 600000 || !Number.isSafeInteger(check.status) || check.status < 0 || check.status > 599
          || !Number.isSafeInteger(check.ms) || check.ms < 0 || check.ms > 600000 || !(check.error === null || typeof check.error === "string" && check.error.length > 0 && check.error.length <= 300)
          || (check.status === 0 && check.error === null) || !(check.redirect === null || typeof check.redirect === "string" && check.redirect.length <= 500)
          || !(check.certNotAfter === null || typeof check.certNotAfter === "string" && Number.isFinite(Date.parse(check.certNotAfter)))) fail("Invalid website measurement.");
      if (check.redirect !== null) {
        let redirected; try { redirected = new URL(check.redirect, item.url); } catch { fail("Invalid redirect evidence."); }
        if (redirected.origin !== new URL(item.url).origin && check.error === null) fail("A cross-origin redirect cannot be reported as a successful configured probe.");
      }
      return { ...check, id: item.id, atMs: at };
    });
    store.capacity();
    return store.transaction(() => {
      for (const check of checks) {
        const existing = db.prepare("SELECT body FROM website_points WHERE id=? AND at=?").get(check.id, check.atMs);
        if (existing && existing.body !== JSON.stringify(check)) fail("Website observation time conflicts with retained evidence.", 409);
        db.prepare("INSERT OR IGNORE INTO website_points VALUES(?,?,?)").run(check.id, check.atMs, JSON.stringify(check));
        const row = db.prepare("SELECT body FROM website_current WHERE id=?").get(check.id), previous = row ? JSON.parse(row.body) : null;
        if (previous && previous.atMs >= check.atMs || now - check.atMs > 900000) continue;
        const success = check.error === null && check.status >= 200 && check.status < 400;
        const failStreak = success ? 0 : (previous?.failStreak || 0) + 1;
        db.prepare("INSERT INTO website_current VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body").run(check.id, JSON.stringify({ ...check, success, failStreak, receivedAt: now }));
      }
      const result = { ok: true, accepted: true, batchId: batch.batchId, digest: hash, observedAt: observed, receiptId: digest([host, batch.batchId, hash]), receivedAt: now, replay: false };
      db.prepare("INSERT INTO website_receipts VALUES(?,?,?,?)").run(host, batch.batchId, hash, JSON.stringify(result));
      db.prepare("DELETE FROM website_points WHERE at<?").run(now - 90 * 86400000);
      return result;
    });
  }
  function list(hosts = null) {
    return { ok: true, at: store.now(), websites: [...targets.values()].filter(target => !hosts || hosts.includes(target.host)).map(target => {
      const row = db.prepare("SELECT body FROM website_current WHERE id=?").get(target.id), current = row ? JSON.parse(row.body) : null;
      const fresh = current && store.now() - current.atMs <= 900000;
      const tlsDays = current?.certNotAfter ? Math.floor((Date.parse(current.certNotAfter) - current.atMs) / 86400000) : null;
      const state = !fresh ? "unknown" : current.failStreak >= 2 ? "critical" : !current.success || tlsDays !== null && tlsDays < 14 ? "warning" : "healthy";
      return { ...target, state, statusCode: current?.status ?? null, responseMs: current?.ms ?? null, certificateExpiresAt: current?.certNotAfter ?? null,
        lastObservedAt: current?.at ?? null, receivedAt: current?.receivedAt ?? null, failStreak: current?.failStreak ?? null, quality: fresh ? "good" : "stale", checks: [],
        source: "Configured external five-minute website observer", summary: !fresh ? "No fresh website observation" : current.failStreak >= 2 ? "Two or more consecutive probes failed" : !current.success ? "Failure awaiting confirmation" : tlsDays !== null && tlsDays < 14 ? "Certificate expires in fewer than fourteen days" : "HTTP probe succeeded", checkId: "operations.website." + target.id };
    }), note: "Two failed observations confirm an outage. Missing evidence is unknown. Probe success is not elapsed-time availability." };
  }
  function history(hosts, query = {}) {
    const now = store.now(), from = query.from === undefined ? now - 86400000 : Number(query.from), to = query.to === undefined ? now : Number(query.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from || to - from > 90 * 86400000 || to > now + 300000) fail("Website history requires an interval of up to 90 days.");
    const series = [], coverage = [];
    for (const target of targets.values()) {
      if (hosts && !hosts.includes(target.host) || query.endpoint && query.endpoint !== target.id) continue;
      const raw = db.prepare("SELECT body FROM website_points WHERE id=? AND at>=? AND at<=? ORDER BY at LIMIT 30001").all(target.id, from, to);
      if (raw.length > 30000) fail("Website history exceeds its evidence bound; choose a shorter interval.", 413);
      const rows = raw.map(row => { const check = JSON.parse(row.body); return { at: check.atMs, ms: check.ms, success: check.error === null && check.status >= 200 && check.status < 400, timingObserved: check.status > 0 && check.error === null }; });
      const sampled = historyPoints(rows, from, to), successes = rows.filter(row => row.success).length;
      series.push({ id: "website.response." + target.id, host: target.host, label: target.label + " response time", unit: "ms", type: "gauge", intervalSeconds: sampled.aggregated ? Math.max(300, (to - from) / MAX_HISTORY_POINTS / 1000) : 300, points: sampled.points, aggregated: sampled.aggregated, url: target.url });
      coverage.push({ id: target.id, host: target.host, url: target.url, observations: rows.length, successes, failures: rows.length - successes, ...cadenceCoverage(rows, from, to), observedSuccessPercent: rows.length ? successes / rows.length * 100 : null,
        firstObservedAt: rows.length ? new Date(rows[0].at).toISOString() : null, lastObservedAt: rows.length ? new Date(rows.at(-1).at).toISOString() : null });
    }
    return { ok: true, at: now, from, to, series, coverage, resolution: series.some(item => item.aggregated) ? "bounded min/max" : "raw", note: "Received five-minute UTC bins measure coverage; missing probes never count as successes. Raw website evidence is retained for 90 days." };
  }
  function conditions() { return list().websites.map(target => ({ checkId: target.checkId, host: target.host,
    status: target.state === "warning" && target.failStreak === 1 ? "unknown" : target.state,
    summary: target.label + ": " + target.summary, observedAt: store.now(), evidence: { endpoint: target.id, observedAt: target.lastObservedAt, statusCode: target.statusCode, responseMs: target.responseMs, certificateExpiresAt: target.certificateExpiresAt } })); }
  function conditionDefinitions() { return [...targets.values()].map(target => ({ id: "operations.website." + target.id, host: target.host, label: target.label, type: "operation", intervalSeconds: 60, policy: { failCount: 1, recoverCount: 1 }, dependencies: [] })); }
  return { ingest, list, history, conditions, conditionDefinitions };
}

module.exports = { createWebsites };

function historyPoints(rows, from, to) {
  const points = rows.map((row) => ({ at: row.at, value: row.timingObserved ? row.ms : null, quality: row.timingObserved ? "good" : "unknown",
    min: row.timingObserved ? row.ms : null, max: row.timingObserved ? row.ms : null, count: 1 }));
  if (points.length <= MAX_HISTORY_POINTS) return { points, aggregated: false };
  const buckets = new Map();
  for (const point of points) {
    const id = Math.min(MAX_HISTORY_POINTS - 1, Math.floor((point.at - from) / (to - from) * MAX_HISTORY_POINTS));
    if (!buckets.has(id)) buckets.set(id, []);
    buckets.get(id).push(point);
  }
  return { aggregated: true, points: [...buckets.values()].map((group) => {
    const good = group.every((point) => point.value !== null);
    return { at: group[Math.floor(group.length / 2)].at, value: good ? group.reduce((n, p) => n + p.value, 0) / group.length : null,
      quality: good ? "good" : "unknown", min: good ? Math.min(...group.map((p) => p.min)) : null,
      max: good ? Math.max(...group.map((p) => p.max)) : null, count: group.length };
  }) };
}
// Cadence-bin coverage is anchored to UTC, never to arbitrary query seconds.
// Count only complete five-minute bins inside the requested interval. Probes in
// partial first/last bins remain visible in history but cannot prove a complete
// bin. Multiple receipts in one bin count once. Normal within-bin jitter is
// tolerated; a delay crossing a bin boundary can leave the earlier bin empty.
function cadenceCoverage(rows, from, to) {
  const cadence = 300000;
  const first = Math.ceil(from / cadence) * cadence;
  const end = Math.floor(to / cadence) * cadence;
  const expectedSlots = Math.max(0, Math.round((end - first) / cadence));
  const observed = new Set();
  let boundaryObservations = 0;
  for (const row of rows) {
    const slot = Math.floor(row.at / cadence) * cadence;
    if (slot >= first && slot < end) observed.add(slot);
    else boundaryObservations++;
  }
  return { expectedSlots, observedSlots: observed.size, coveragePercent: expectedSlots ? observed.size / expectedSlots * 100 : null,
    boundaryObservations, coverageBasis: "complete UTC five-minute bins; partial boundary bins excluded; duplicate probes in a bin count once" };
}
