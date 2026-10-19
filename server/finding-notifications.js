"use strict";
// Finding mail has its own durable identities. It never creates a native host,
// check or incident to make a canonical finding eligible for delivery.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { notificationConfiguration, credential, sendResend, RETRY_WINDOW } = require("./native-monitor/notifications");
const { compileSmtpMessage, sendSmtp, verifySmtp } = require("./native-monitor/smtp-transport");
const hash = value => crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const plain = value => value && typeof value === "object" && !Array.isArray(value);
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const parse = value => JSON.parse(value);
const MAX_ATTEMPTS = 10000, LEASE = 60000;
function readConfiguration(stateDir) {
  const file = path.join(stateDir, "finding-notifications.json");
  if (!fs.existsSync(file)) return { schemaVersion: 1, applications: [] };
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1048576 || stat.mode & 0o077
        || process.getuid && stat.uid !== process.getuid() || fs.realpathSync(file) !== file) throw new Error();
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch { fail(400, "Finding notification configuration must be valid owner-only external JSON."); }
}
function configuration(input) {
  if (!plain(input) || input.schemaVersion !== 1 || !Array.isArray(input.applications) || input.applications.length > 100
      || Object.keys(input).some(key => !["schemaVersion", "applications"].includes(key))) fail(400, "Invalid finding notification configuration.");
  const result = new Map();
  for (const app of input.applications) {
    if (!plain(app) || Object.keys(app).some(key => !["appId", "notifications", "severities", "ruleIds", "sourceIds"].includes(key))
        || typeof app.appId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(app.appId) || result.has(app.appId)) fail(400, "Invalid finding notification application.");
    const notifications = notificationConfiguration(app.notifications);
    const severities = app.severities === undefined ? ["high", "critical"] : app.severities;
    if (!Array.isArray(severities) || severities.length > 5 || new Set(severities).size !== severities.length
        || severities.some(value => !["info", "low", "medium", "high", "critical"].includes(value))) fail(400, "Invalid finding mail severity filter.");
    for (const name of ["ruleIds", "sourceIds"]) if (app[name] !== undefined && (!Array.isArray(app[name]) || app[name].length > 1000
        || new Set(app[name]).size !== app[name].length || app[name].some(value => typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)))) fail(400, "Invalid finding mail scope filter.");
    result.set(app.appId, Object.freeze({ notifications, severities: [...severities], ruleIds: app.ruleIds, sourceIds: app.sourceIds }));
  }
  return result;
}
function createFindingNotifications({ store, stateDir, consoleOrigin, config, transports = {}, now = Date.now, maxAttempts = MAX_ATTEMPTS }) {
  const db = store?.db;
  if (!db || typeof db.transaction !== "function") fail(400, "Finding notifications require the durable telemetry database.");
  const policies = configuration(config || readConfiguration(stateDir));
  const origin = new URL(consoleOrigin).origin;
  if (!/^https?:\/\//.test(origin) || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_ATTEMPTS) fail(400, "Invalid finding mail runtime configuration.");
  const knownApp = id => {
    if (!store.controlSnapshot().apps.some(app => app.appId === id)) fail(404, "Unknown notification application.");
    return policies.get(id);
  };
  for (const id of policies.keys()) knownApp(id);
  const tx = operation => db.inTransaction ? operation() : db.transaction(operation).immediate();
  const owner = crypto.randomUUID();
  let running = null, closing = false, fault = null;
  const verifications = new Set();
  db.exec("CREATE TABLE IF NOT EXISTS finding_mail_notices(id TEXT PRIMARY KEY,app_id TEXT NOT NULL,source_id TEXT,record_id TEXT,rule_id TEXT,kind TEXT NOT NULL,destination TEXT NOT NULL,created_at INTEGER NOT NULL);" +
    "CREATE TABLE IF NOT EXISTS finding_mail_attempts(id TEXT PRIMARY KEY,notice_id TEXT NOT NULL,app_id TEXT NOT NULL,active INTEGER NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,next_at INTEGER NOT NULL,first_at INTEGER,request_count INTEGER NOT NULL DEFAULT 0,lease_owner TEXT,lease_until INTEGER,provider TEXT NOT NULL,server TEXT NOT NULL,server_digest TEXT NOT NULL,body TEXT NOT NULL,body_digest TEXT NOT NULL,credential_fingerprint TEXT,message_id TEXT,mime TEXT,mime_digest TEXT,data_at INTEGER,first_data_at INTEGER,safe_retry INTEGER NOT NULL DEFAULT 0,provider_id TEXT,accepted_at INTEGER,protocol_status INTEGER,response_digest TEXT,error_code TEXT);" +
    "CREATE UNIQUE INDEX IF NOT EXISTS finding_mail_active ON finding_mail_attempts(notice_id) WHERE active=1;" +
    "CREATE INDEX IF NOT EXISTS finding_mail_due ON finding_mail_attempts(app_id,active,state,next_at);" +
    "CREATE TABLE IF NOT EXISTS finding_mail_requests(attempt_id TEXT NOT NULL,sequence INTEGER NOT NULL,app_id TEXT NOT NULL,started_at INTEGER NOT NULL,data_at INTEGER,finished_at INTEGER,outcome TEXT,protocol_status INTEGER,response_digest TEXT,PRIMARY KEY(attempt_id,sequence));" +
    "CREATE INDEX IF NOT EXISTS finding_mail_request_time ON finding_mail_requests(app_id,started_at);" +
    "CREATE TABLE IF NOT EXISTS finding_mail_control(app_id TEXT PRIMARY KEY,paused INTEGER NOT NULL,revision INTEGER NOT NULL);" +
    "CREATE TABLE IF NOT EXISTS finding_mail_decisions(id INTEGER PRIMARY KEY,app_id TEXT NOT NULL,at INTEGER NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,reason TEXT NOT NULL,attempt_id TEXT,value TEXT NOT NULL);" +
    "CREATE TABLE IF NOT EXISTS finding_mail_mutations(app_id TEXT NOT NULL,operation TEXT NOT NULL,idempotency_key TEXT NOT NULL,digest TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(app_id,operation,idempotency_key));");
  const control = appId => db.prepare("SELECT paused,revision FROM finding_mail_control WHERE app_id=?").get(appId) || { paused: 0, revision: 1 };
  const enabled = appId => !closing && policies.get(appId)?.notifications.enabled === true && !control(appId).paused;
  const server = cfg => JSON.stringify(cfg.provider === "smtp" ? cfg.smtp : null);
  const serverDigest = cfg => hash([cfg.provider, server(cfg)]);
  function capacity() {
    if (db.prepare("SELECT count(*) n FROM finding_mail_attempts").get().n >= maxAttempts) fail(507, "Finding mail retained attempt capacity reached; no finding batch was admitted.");
  }
  function addAttempt(notice, body, cfg, prior = null) {
    capacity();
    const id = "finding-mail-" + crypto.randomBytes(16).toString("hex"), at = now();
    const messageId = cfg.provider === "smtp" ? prior?.provider === "smtp" ? prior.message_id : "<" + id + "@" + parse(body).from.split("@")[1] + ">" : null;
    db.prepare("INSERT INTO finding_mail_attempts(id,notice_id,app_id,active,state,revision,created_at,updated_at,next_at,provider,server,server_digest,body,body_digest,message_id,mime,mime_digest) VALUES(?,?,?,1,'ready',1,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, notice.id, notice.appId, at, at, at, cfg.provider, server(cfg), serverDigest(cfg), body, hash(body), messageId,
        cfg.provider === "smtp" && prior?.provider === "smtp" ? prior.mime : null,
        cfg.provider === "smtp" && prior?.provider === "smtp" ? prior.mime_digest : null);
    return id;
  }
  function queue(notice, message, cfg) {
    const prior = db.prepare("SELECT id FROM finding_mail_notices WHERE id=?").get(notice.id);
    if (prior) return { queued: false, noticeId: prior.id };
    capacity();
    db.prepare("INSERT INTO finding_mail_notices VALUES(?,?,?,?,?,?,?,?)").run(notice.id, notice.appId, notice.sourceId || null, notice.recordId || null, notice.ruleId || null, notice.kind, notice.destination, now());
    return { queued: true, noticeId: notice.id, attemptId: addAttempt(notice, JSON.stringify(message), cfg) };
  }
  function admit(records) {
    if (!db.inTransaction) fail(500, "Finding notification admission must share the finding transaction.");
    if (!Array.isArray(records) || records.length > 4000) fail(400, "Bounded derived findings are required.");
    let queued = 0;
    for (const record of records) {
      if (record.kind !== "finding") continue;
      const policy = policies.get(record.estateId), payload = record.payload;
      if (!policy?.notifications.enabled || !policy.severities.includes(payload.severity)
          || policy.ruleIds && !policy.ruleIds.includes(payload.ruleRef) || policy.sourceIds && !policy.sourceIds.includes(record.sourceId)) continue;
      for (const destination of policy.notifications.destinations) {
        const id = hash(["canonical-finding-mail-v1", record.estateId, record.sourceId, record.recordId, destination]);
        const text = [payload.title, payload.summary, "", "Observed: " + record.observedAt, "Finding: " + record.recordId,
          "Source: " + record.sourceId, "Rule: " + (payload.ruleRef || "not supplied"),
          "Rule author: " + (payload.fields?.ruleAuthor || "not supplied"), "Rule license: " + (payload.fields?.ruleLicense || "not supplied"),
          "", "Review evidence: " + origin + "/#/triage?appId=" + encodeURIComponent(record.estateId),
          "A rule match is review evidence, not a confirmed compromise."].join("\n").slice(0, 16000);
        const result = queue({ id, appId: record.estateId, sourceId: record.sourceId, recordId: record.recordId, ruleId: payload.ruleRef, destination, kind: "finding" },
          { from: policy.notifications.from, to: [destination], subject: ("[BB SOC " + payload.severity + "] " + payload.title).slice(0, 450), text }, policy.notifications);
        queued += Number(result.queued);
      }
    }
    return { queued };
  }
  function park(row, reason) {
    db.prepare("UPDATE finding_mail_attempts SET state='needs-reconciliation',error_code=?,lease_owner=NULL,lease_until=NULL,updated_at=?,revision=revision+1 WHERE id=?").run(reason, now(), row.id);
  }
  async function mime(id) {
    const row = db.prepare("SELECT * FROM finding_mail_attempts WHERE id=?").get(id);
    if (row.provider !== "smtp" || row.mime !== null) return;
    const raw = await compileSmtpMessage({ ...parse(row.body), messageId: row.message_id, date: new Date(row.created_at) });
    tx(() => db.prepare("UPDATE finding_mail_attempts SET mime=?,mime_digest=? WHERE id=? AND mime IS NULL").run(raw, hash(raw), id));
  }
  function reserve(id) {
    return tx(() => {
      const row = db.prepare("SELECT * FROM finding_mail_attempts WHERE id=?").get(id), cfg = policies.get(row.app_id)?.notifications;
      if (!enabled(row.app_id) || !row.active || !["ready", "retryable", "in-flight"].includes(row.state)
          || row.next_at > now() || row.lease_until > now()) return null;
      if (row.state === "in-flight" && row.provider === "smtp" && row.data_at !== null) { park(row, "smtp-data-outcome-unknown"); return null; }
      if (row.first_at !== null && (now() < row.first_at || now() - row.first_at >= RETRY_WINDOW)) { park(row, "retry-window-expired"); return null; }
      const body = parse(row.body);
      if (hash(row.body) !== row.body_digest || row.provider === "smtp" && (!row.mime || hash(row.mime) !== row.mime_digest)) { park(row, "payload-integrity"); return null; }
      if (serverDigest(cfg) !== row.server_digest || cfg.from !== body.from || !cfg.destinations.includes(body.to[0])) { park(row, "provider-configuration-changed"); return null; }
      let key; try { key = credential(cfg.credentialFile, cfg.provider); } catch { park(row, "credential-unavailable"); return null; }
      if (row.credential_fingerprint && row.credential_fingerprint !== key.fingerprint) { park(row, "credential-changed"); return null; }
      const used = db.prepare("SELECT count(*) n FROM finding_mail_requests WHERE app_id=? AND started_at>?").get(row.app_id, now() - 3600000).n;
      if (used >= cfg.hourlySendCap) return null;
      const count = row.request_count + 1;
      db.prepare("UPDATE finding_mail_attempts SET state='in-flight',first_at=COALESCE(first_at,?),request_count=?,lease_owner=?,lease_until=?,credential_fingerprint=?,data_at=NULL,safe_retry=0,updated_at=?,revision=revision+1 WHERE id=?")
        .run(now(), count, owner, now() + LEASE, key.fingerprint, now(), id);
      db.prepare("INSERT INTO finding_mail_requests(attempt_id,sequence,app_id,started_at) VALUES(?,?,?,?)").run(id, count, row.app_id, now());
      return { row: db.prepare("SELECT * FROM finding_mail_attempts WHERE id=?").get(id), key };
    });
  }
  function beforeData(row) {
    tx(() => {
      const current = db.prepare("SELECT * FROM finding_mail_attempts WHERE id=?").get(row.id);
      if (!enabled(row.app_id) || !current.active || current.lease_owner !== owner || current.request_count !== row.request_count || current.lease_until <= now()) fail(409, "Finding SMTP lease changed.");
      db.prepare("UPDATE finding_mail_attempts SET data_at=?,first_data_at=COALESCE(first_data_at,?) WHERE id=?").run(now(), now(), row.id);
      db.prepare("UPDATE finding_mail_requests SET data_at=? WHERE attempt_id=? AND sequence=?").run(now(), row.id, row.request_count);
    });
  }
  function finish(row, result) {
    tx(() => {
      const current = db.prepare("SELECT * FROM finding_mail_attempts WHERE id=?").get(row.id);
      if (!current.active || current.lease_owner !== owner || current.request_count !== row.request_count) return;
      const smtp = row.provider === "smtp";
      const accepted = smtp ? result.accepted === true && result.smtpStatus === 250 && current.data_at !== null && /^smtp-receipt-[a-f0-9]{64}$/.test(result.receiptId || "")
        : result.status >= 200 && result.status < 300 && /^[A-Za-z0-9_-]{1,200}$/.test(result.id || "");
      const safe = smtp ? result.safeToRetry === true && result.ambiguous === false : true;
      const retry = smtp ? result.retryable === true && safe : !result.status || [408, 429].includes(result.status) || result.status >= 500 || result.status === 409 && result.code === "concurrent_idempotent_requests";
      const state = accepted ? "accepted" : retry && now() - row.first_at < RETRY_WINDOW ? "retryable" : "needs-reconciliation";
      const status = smtp ? result.smtpStatus || null : result.status || null;
      const error = accepted ? null : smtp ? result.errorCode || "smtp-data-outcome-unknown" : status ? "provider-http-" + status : "provider-response-unknown";
      const retryAfter = /^\d{1,6}$/.test(result.retryAfter || "") ? Math.min(3600, Number(result.retryAfter)) * 1000 : 0;
      const delay = Math.max(retryAfter, 1000 * Math.min(3600, 30 * 2 ** Math.min(7, row.request_count - 1)));
      const responseDigest = /^[a-f0-9]{64}$/.test(result.responseDigest || "") ? result.responseDigest : null;
      db.prepare("UPDATE finding_mail_attempts SET state=?,next_at=?,updated_at=?,revision=revision+1,lease_owner=NULL,lease_until=NULL,provider_id=?,accepted_at=?,protocol_status=?,response_digest=?,safe_retry=?,error_code=? WHERE id=?")
        .run(state, now() + delay, now(), accepted ? smtp ? result.receiptId : result.id : null, accepted ? now() : null, status, responseDigest, Number(safe), error, row.id);
      db.prepare("UPDATE finding_mail_requests SET finished_at=?,outcome=?,protocol_status=?,response_digest=? WHERE attempt_id=? AND sequence=?")
        .run(now(), state, status, responseDigest, row.id, row.request_count);
    });
  }
  async function work() {
    try {
      // Per-app selection prevents a paused or capped application starving others.
      for (const appId of policies.keys()) {
        if (!enabled(appId)) continue;
        const rows = db.prepare("SELECT id FROM finding_mail_attempts WHERE app_id=? AND active=1 AND state IN ('ready','retryable','in-flight') AND next_at<=? AND (lease_until IS NULL OR lease_until<=?) ORDER BY next_at,created_at,id LIMIT 4").all(appId, now(), now());
        for (const item of rows) {
          if (!enabled(appId)) break;
          await mime(item.id); const reserved = reserve(item.id); if (!reserved) continue;
          const { row, key } = reserved, body = parse(row.body);
          let result;
          try {
            result = row.provider === "smtp" ? await (transports.smtp || sendSmtp)({ server: parse(row.server), credentials: key.credentials,
              envelope: { from: body.from, to: body.to }, raw: row.mime, messageId: row.message_id, beforeData: () => beforeData(row) })
              : await (transports.resend || sendResend)({ token: key.token, body: row.body, key: "bb-soc-finding-v1-" + hash(row.id) });
          } catch { result = { accepted: false, retryable: false, ambiguous: true, errorCode: "smtp-transport-outcome-unknown" }; }
          finish(row, result || {});
        }
      }
      fault = null;
    } catch { fault = "Finding notification maintenance failed; retained attempts require review."; }
  }
  function tick() { if (running) return running; if (closing) return Promise.resolve(); running = work().finally(() => { running = null; }); return running; }
  function scoped(appId, id) {
    knownApp(appId);
    if (!/^finding-mail-[a-f0-9]{32}$/.test(id || "")) fail(400, "Invalid finding notification attempt.");
    const row = db.prepare("SELECT * FROM finding_mail_attempts WHERE id=? AND app_id=?").get(id, appId);
    if (!row) fail(404, "Finding notification attempt not found in this application.");
    return row;
  }
  function publicRow(row) {
    return { id: row.id, noticeId: row.notice_id, appId: row.app_id, provider: row.provider, state: row.state, active: !!row.active,
      revision: row.revision, destination: parse(row.body).to[0], createdAt: row.created_at, updatedAt: row.updated_at,
      firstRequestAt: row.first_at, dataStartedAt: row.first_data_at, requestCount: row.request_count, nextAttemptAt: row.next_at,
      providerId: row.provider_id, acceptedAt: row.accepted_at, protocolStatus: row.protocol_status, responseDigest: row.response_digest,
      errorCode: row.error_code, messageId: row.message_id, exactRetryBefore: row.first_at === null ? null : row.first_at + RETRY_WINDOW,
      exactRetryAllowed: row.provider !== "smtp" || row.safe_retry === 1 || row.first_data_at === null,
      sourceId: row.source_id, recordId: row.record_id, ruleId: row.rule_id, kind: row.kind,
      requests: db.prepare("SELECT sequence,started_at AS startedAt,data_at AS dataStartedAt,finished_at AS finishedAt,outcome,protocol_status AS protocolStatus,response_digest AS responseDigest FROM finding_mail_requests WHERE attempt_id=? ORDER BY sequence DESC LIMIT 10").all(row.id) };
  }
  function status(appId) {
    const policy = knownApp(appId), state = control(appId);
    const rows = db.prepare("SELECT a.*,n.source_id,n.record_id,n.rule_id,n.kind FROM finding_mail_attempts a JOIN finding_mail_notices n ON n.id=a.notice_id WHERE a.app_id=? ORDER BY a.created_at DESC,a.id DESC LIMIT 101").all(appId);
    return { ok: true, appId, provider: policy?.notifications.provider || null, configured: !!policy, testSendAvailable: !!policy?.notifications.enabled,
      verificationAvailable: policy?.notifications.provider === "smtp" && policy.notifications.reviewed === true && !!policy.notifications.smtp,
      enabled: enabled(appId), paused: !!state.paused, revision: state.revision, retainedAttemptLimit: maxAttempts,
      filters: policy ? { severities: policy.severities, ruleIds: policy.ruleIds || null, sourceIds: policy.sourceIds || null } : null,
      error: fault, attempts: rows.slice(0, 100).map(publicRow), truncated: rows.length > 100,
      verification: (() => { const row = db.prepare("SELECT value FROM finding_mail_mutations WHERE app_id=? AND operation='verify' ORDER BY COALESCE(json_extract(value,'$.at'),json_extract(value,'$.startedAt')) DESC LIMIT 1").get(appId); return row ? parse(row.value) : null; })(),
      counts: db.prepare("SELECT state,count(*) AS count FROM finding_mail_attempts WHERE app_id=? AND active=1 GROUP BY state").all(appId),
      decisions: db.prepare("SELECT at,actor,action,reason,attempt_id AS attemptId,value FROM finding_mail_decisions WHERE app_id=? ORDER BY id DESC LIMIT 20").all(appId).map(row => ({ ...row, value: parse(row.value) })) };
  }
  function mutation(appId, operation, body, fn) {
    knownApp(appId);
    if (!plain(body) || typeof body.actor !== "string" || !body.actor || body.actor.length > 160 || typeof body.reason !== "string"
        || !body.reason.trim() || body.reason.length > 1000 || !/^[A-Za-z0-9_.:-]{1,160}$/.test(body.idempotencyKey || "")) fail(400, "An operator, reason and stable idempotency key are required.");
    return tx(() => {
      const digest = hash(body), prior = db.prepare("SELECT * FROM finding_mail_mutations WHERE app_id=? AND operation=? AND idempotency_key=?").get(appId, operation, body.idempotencyKey);
      if (prior) { if (prior.digest !== digest) fail(409, "Finding mail decision identity conflicts with different content."); return parse(prior.value); }
      const result = fn();
      db.prepare("INSERT INTO finding_mail_mutations VALUES(?,?,?,?,?)").run(appId, operation, body.idempotencyKey, digest, JSON.stringify(result));
      db.prepare("INSERT INTO finding_mail_decisions(app_id,at,actor,action,reason,attempt_id,value) VALUES(?,?,?,?,?,?,?)").run(appId, now(), body.actor, operation, body.reason, body.attemptId || null, JSON.stringify(result));
      return result;
    });
  }
  function pause(appId, body) {
    return mutation(appId, "pause", body, () => {
      const state = control(appId);
      if (typeof body.paused !== "boolean" || body.expectedRevision !== state.revision) fail(409, "Finding mail control revision changed or paused value is invalid.");
      db.prepare("INSERT INTO finding_mail_control VALUES(?,?,?) ON CONFLICT(app_id) DO UPDATE SET paused=excluded.paused,revision=excluded.revision").run(appId, Number(body.paused), state.revision + 1);
      return { ok: true, appId, paused: body.paused, revision: state.revision + 1 };
    });
  }
  function reconcile(appId, body) {
    scoped(appId, body.attemptId);
    return mutation(appId, "reconcile", body, () => {
      const row = scoped(appId, body.attemptId), cfg = policies.get(appId)?.notifications;
      if (!row.active || row.state !== "needs-reconciliation" || row.revision !== body.expectedRevision) fail(409, "Finding mail attempt revision changed or is not parked.");
      let nextAttemptId = row.id;
      if (body.action === "confirm-accepted") {
        const start = row.provider === "smtp" ? row.first_data_at : row.first_at;
        const at = typeof body.acceptedAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(body.acceptedAt) ? Date.parse(body.acceptedAt) : NaN;
        if (start === null || !Number.isFinite(at) || at < start || at > now() || !/^[A-Za-z0-9_-]{1,200}$/.test(body.providerId || "")) fail(400, "Verified acceptance ID and timestamp within the attempted interval are required.");
        db.prepare("UPDATE finding_mail_attempts SET state='accepted',provider_id=?,accepted_at=?,updated_at=?,revision=revision+1,error_code=NULL WHERE id=?").run(body.providerId, at, now(), row.id);
      } else if (["retry-exact", "requeue-fresh"].includes(body.action)) {
        const message = parse(row.body);
        if (!cfg || cfg.from !== message.from || !cfg.destinations.includes(message.to[0])) fail(409, "Frozen sender and destination must remain reviewed.");
        const key = credential(cfg.credentialFile, cfg.provider);
        if (body.action === "retry-exact") {
          if (serverDigest(cfg) !== row.server_digest || row.credential_fingerprint && row.credential_fingerprint !== key.fingerprint
              || row.first_at !== null && (now() < row.first_at || now() - row.first_at >= RETRY_WINDOW)
              || row.provider === "smtp" && row.first_data_at !== null && row.safe_retry !== 1) fail(409, "Exact retry is unsafe after uncertainty, configuration change or expiry.");
          db.prepare("UPDATE finding_mail_attempts SET state='retryable',next_at=?,updated_at=?,revision=revision+1,error_code=NULL WHERE id=?").run(now(), now(), row.id);
        } else {
          if (body.duplicateRiskAccepted !== true) fail(400, "Fresh requeue requires explicit duplicate-mail risk acceptance.");
          db.prepare("UPDATE finding_mail_attempts SET active=0,state='superseded',updated_at=?,revision=revision+1 WHERE id=?").run(now(), row.id);
          nextAttemptId = addAttempt({ id: row.notice_id, appId }, row.body, cfg, row);
        }
      } else fail(400, "Unsupported finding mail decision.");
      return { ok: true, appId, attemptId: row.id, action: body.action, nextAttemptId };
    });
  }
  function testSend(appId, body) {
    return mutation(appId, "test-send", body, () => {
      const cfg = policies.get(appId)?.notifications;
      if (!cfg?.enabled || !cfg.destinations.includes(body.recipient)) fail(400, "Test mail requires enabled reviewed configuration and an explicit configured recipient.");
      const id = hash(["commissioning", appId, body.idempotencyKey]);
      return { ok: true, appId, ...queue({ id, appId, kind: "commissioning", destination: body.recipient }, {
        from: cfg.from, to: [body.recipient], subject: "[BB SOC] Requested mail commissioning check",
        text: "An authenticated operator explicitly requested this mail check.\nReason: " + body.reason + "\nRelay acceptance does not prove inbox delivery."
      }, cfg) };
    });
  }
  async function verifyWork(appId, body) {
    if (closing) fail(503, "Finding notification worker is closing.");
    const cfg = policies.get(appId)?.notifications;
    if (cfg?.provider !== "smtp" || !cfg.reviewed || !cfg.smtp) fail(400, "Connection verification requires reviewed SMTP configuration.");
    const start = mutation(appId, "verify", body, () => ({ ok: true, appId, pending: true, startedAt: now() }));
    if (!start.pending) return start;
    // Re-verification after an interrupted connection is safe: this never sends DATA.
    let result;
    try { result = await (transports.verifySmtp || verifySmtp)({ server: cfg.smtp, credentials: credential(cfg.credentialFile, "smtp").credentials }); }
    catch { result = { verified: false, errorCode: "smtp-verification-failed" }; }
    const value = { ok: true, appId, pending: false, at: now(), verified: result.verified === true,
      errorCode: result.verified ? null : result.errorCode || "smtp-verification-failed",
      evidence: "Connection, TLS and authentication only; no mail sent and no sender or inbox delivery proof." };
    tx(() => db.prepare("UPDATE finding_mail_mutations SET value=? WHERE app_id=? AND operation='verify' AND idempotency_key=?").run(JSON.stringify(value), appId, body.idempotencyKey));
    return value;
  }
  function verify(appId, body) {
    const task = verifyWork(appId, body); verifications.add(task);
    task.finally(() => verifications.delete(task)).catch(() => {});
    return task;
  }
  return { admit, tick, status, pause, reconcile, verify, testSend, async close() { closing = true; if (running) await running; await Promise.allSettled([...verifications]); } };
}
module.exports = { createFindingNotifications, configuration, MAX_ATTEMPTS };
