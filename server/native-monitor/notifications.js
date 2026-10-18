"use strict";
// Server-owned, application-scoped email delivery. No source credential can send
// messages or select a destination. Provider acceptance is not inbox delivery.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { smtpConfiguration, compileSmtpMessage, sendSmtp, verifySmtp } = require("./smtp-transport");
const RETRY_WINDOW = 23 * 3600000, LEASE_MS = 60000, MAX_ATTEMPTS = 10000;
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const problem = (status, message) => Object.assign(new Error(message), { status });
const email = value => typeof value === "string" && value.length <= 254 && /^[A-Za-z0-9.!#$%&'*+/=?^_\x60{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/.test(value);
const plain = value => !!value && typeof value === "object" && !Array.isArray(value);
const iso = value => value === null ? null : new Date(value).toISOString();

function notificationConfiguration(value) {
  if (value === undefined) return Object.freeze({ enabled: false, provider: "resend", destinations: [], hourlySendCap: 100 });
  if (!plain(value) || Object.keys(value).some(key => !["enabled", "reviewed", "from", "destinations", "credentialFile", "hourlySendCap", "provider", "smtp"].includes(key))
      || typeof value.enabled !== "boolean" || (value.reviewed !== undefined && typeof value.reviewed !== "boolean"))
    throw new TypeError("Invalid native notification configuration.");
  if (value.enabled && value.reviewed !== true) throw new TypeError("Enabled notification destinations require an explicit reviewed configuration.");
  if (value.from !== undefined && !email(value.from)) throw new TypeError("Invalid notification sender.");
  if (value.destinations !== undefined && (!Array.isArray(value.destinations) || value.destinations.length > 20
      || value.destinations.some(destination => !email(destination)) || new Set(value.destinations).size !== value.destinations.length))
    throw new TypeError("Notification destinations must be at most 20 distinct email addresses.");
  if (value.credentialFile !== undefined && (typeof value.credentialFile !== "string" || !path.isAbsolute(value.credentialFile)
      || path.resolve(value.credentialFile) !== value.credentialFile)) throw new TypeError("An absolute external notification credential file is required.");
  if (value.enabled && (!value.from || !value.destinations?.length || !value.credentialFile)) throw new TypeError("Enabled notifications need a sender, destinations, and external credential file.");
  const provider = value.provider || "resend";
  if (!["resend", "smtp"].includes(provider) || provider !== "smtp" && value.smtp !== undefined) throw new TypeError("Unsupported notification provider configuration.");
  const smtp = value.smtp === undefined ? undefined : smtpConfiguration(value.smtp);
  if (provider === "smtp" && value.enabled && !smtp) throw new TypeError("Enabled SMTP requires reviewed server settings.");
  const cap = value.hourlySendCap === undefined ? 100 : value.hourlySendCap;
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > 1000) throw new TypeError("Notification hourlySendCap must be from 1 to 1000.");
  return Object.freeze({ ...value, provider, ...(smtp ? { smtp } : {}), destinations: Object.freeze([...(value.destinations || [])]), hourlySendCap: cap });
}

function credential(filename, provider = "resend") {
  // No path, file contents, or provider response body belongs in public errors.
  let descriptor;
  try {
    const sourceTree = path.resolve(__dirname, "../..");
    if (!filename || filename === sourceTree || filename.startsWith(sourceTree + path.sep)
        || fs.realpathSync(filename) !== filename) throw new Error();
    const check = stat => stat.isFile() && stat.nlink === 1 && stat.size > 0 && stat.size <= (provider === "smtp" ? 16384 : 1024)
      && !(stat.mode & 0o077) && (!process.getuid || stat.uid === process.getuid());
    const before = fs.lstatSync(filename);
    if (!check(before)) throw new Error();
    descriptor = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const opened = fs.fstatSync(descriptor);
    if (!check(opened) || before.dev !== opened.dev || before.ino !== opened.ino) throw new Error();
    const buffer = Buffer.alloc((provider === "smtp" ? 16384 : 1024) + 1);
    const length = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    if (length !== opened.size) throw new Error();
    const token = buffer.subarray(0, length).toString("utf8").trim();
    const after = fs.fstatSync(descriptor);
    if (!check(after) || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs) throw new Error();
    if (provider === "smtp") {
      const value = JSON.parse(token);
      if (!plain(value) || Object.keys(value).sort().join(",") !== "password,user" || typeof value.user !== "string"
          || !value.user || value.user.length > 320 || /[\r\n\0]/.test(value.user) || typeof value.password !== "string"
          || !value.password || value.password.length > 4096 || /[\r\n\0]/.test(value.password)) throw new Error();
      return { credentials: { user: value.user, pass: value.password }, fingerprint: hash(JSON.stringify([value.user, value.password])) };
    }
    if (!/^[A-Za-z0-9_-]{12,512}$/.test(token)) throw new Error();
    return { token, fingerprint: hash(token) };
  } catch { throw problem(503, "Notification credential is unavailable or does not meet file requirements."); }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

async function sendResend({ token, body, key }) {
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 15000);
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST", redirect: "error", signal: abort.signal,
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", "Idempotency-Key": key }, body
    });
    let bytes = 0, chunks = [];
    if (response.body) for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > 65536) { abort.abort(); return { status: response.status, invalid: true }; }
      chunks.push(Buffer.from(chunk));
    }
    let value;
    try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { value = null; }
    return { status: response.status, id: value?.id, code: value?.name, retryAfter: response.headers.get("retry-after") };
  } catch { return { status: null, networkError: true }; }
  finally { clearTimeout(timer); }
}

function createNotifications(store, { appId, configuration, consoleOrigin, send, smtpSend = sendSmtp } = {}) {
  const config = notificationConfiguration(configuration), db = store.db, now = store.now;
  if (config.enabled && (!consoleOrigin || !/^https?:\/\//.test(consoleOrigin))) throw new TypeError("A console origin is required for notifications.");
  const origin = consoleOrigin ? new URL(consoleOrigin).origin : null;
  const owner = crypto.randomUUID();
  let running = null, stopping = false, fault = null;
  db.exec("CREATE TABLE IF NOT EXISTS notification_provider_attempts (" +
    "id TEXT PRIMARY KEY,delivery_id TEXT NOT NULL,host TEXT NOT NULL,incident_id TEXT NOT NULL,active INTEGER NOT NULL," +
    "state TEXT NOT NULL,revision INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL," +
    "body TEXT NOT NULL,body_digest TEXT NOT NULL,credential_fingerprint TEXT NOT NULL,provider_key TEXT NOT NULL," +
    "first_request_at INTEGER,request_count INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL," +
    "lease_owner TEXT,lease_until INTEGER,provider_id TEXT,accepted_at INTEGER,http_status INTEGER,error_code TEXT);" +
    "CREATE UNIQUE INDEX IF NOT EXISTS notification_active_delivery ON notification_provider_attempts(delivery_id) WHERE active=1;" +
    "CREATE INDEX IF NOT EXISTS notification_due ON notification_provider_attempts(active,state,next_at);" +
    "CREATE TABLE IF NOT EXISTS notification_provider_requests(attempt_id TEXT NOT NULL,sequence INTEGER NOT NULL,started_at INTEGER NOT NULL,finished_at INTEGER,http_status INTEGER,outcome TEXT,provider_id TEXT,PRIMARY KEY(attempt_id,sequence));" +
    "CREATE INDEX IF NOT EXISTS notification_request_time ON notification_provider_requests(started_at);" +
    "CREATE INDEX IF NOT EXISTS notification_pending_state ON outbox(json_extract(event,'$.incidentId'),json_extract(event,'$.type')) WHERE delivered_at IS NULL AND superseded_at IS NULL;" +
    "CREATE TABLE IF NOT EXISTS notification_operator_decisions(id INTEGER PRIMARY KEY,at INTEGER NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,attempt_id TEXT,reason TEXT NOT NULL,value TEXT NOT NULL);");
  const columns = new Set(db.prepare("PRAGMA table_info(notification_provider_attempts)").all().map(row => row.name));
  for (const [name, type] of Object.entries({ provider: "TEXT NOT NULL DEFAULT 'resend'", transport_json: "TEXT", transport_digest: "TEXT",
    message_id: "TEXT", mime: "TEXT", mime_digest: "TEXT", smtp_data_at: "INTEGER", smtp_first_data_at: "INTEGER",
    smtp_retry_safe: "INTEGER NOT NULL DEFAULT 0", smtp_status: "INTEGER", response_digest: "TEXT" })) {
    if (!columns.has(name)) db.exec("ALTER TABLE notification_provider_attempts ADD COLUMN " + name + " " + type);
  }
  const requestColumns = new Set(db.prepare("PRAGMA table_info(notification_provider_requests)").all().map(row => row.name));
  for (const [name, type] of Object.entries({ smtp_data_at: "INTEGER", smtp_status: "INTEGER", response_digest: "TEXT" })) {
    if (!requestColumns.has(name)) db.exec("ALTER TABLE notification_provider_requests ADD COLUMN " + name + " " + type);
  }
  const transportJson = () => JSON.stringify(config.provider === "smtp" ? config.smtp : null);
  const transportDigest = () => hash(JSON.stringify([config.provider, transportJson()]));
  const boundaryAt = row => row.provider === "smtp" ? row.smtp_first_data_at : row.first_request_at;
  db.prepare("INSERT OR IGNORE INTO monitor_meta(key,value) VALUES('notification-control',?)").run(JSON.stringify({ paused: false, revision: 1 }));
  const control = () => JSON.parse(db.prepare("SELECT value FROM monitor_meta WHERE key='notification-control'").get().value);
  const enabled = () => config.enabled === true && !stopping && !control().paused;
  function receipt(row, phase, providerId, acceptedAt) {
    return store.recordNotificationReceipt({ deliveryId: row.delivery_id, phase: row.provider === "smtp" && boundaryAt(row) === null && ["in-flight", "retryable"].includes(phase) ? "ready" : phase, attemptId: row.id,
      providerKey: row.provider_key, firstRequestAt: iso(boundaryAt(row)), providerId: providerId || undefined,
      updatedAt: iso(acceptedAt ?? now()) });
  }
  function insertAttempt(delivery, body, fingerprint, previous = null) {
    if (db.prepare("SELECT count(*) AS n FROM notification_provider_attempts").get().n >= MAX_ATTEMPTS) throw problem(503, "Notification retained attempt capacity reached; preserve and archive evidence before increasing capacity.");
    const id = "provider-attempt-" + crypto.randomBytes(16).toString("hex");
    const key = "bb-soc-alert-v2-" + hash(id), at = now();
    db.prepare("INSERT INTO notification_provider_attempts(id,delivery_id,host,incident_id,active,state,revision,created_at,updated_at,body,body_digest,credential_fingerprint,provider_key,next_at) VALUES(?,?,?,?,1,'ready',1,?,?,?,?,?,?,?)")
      .run(id, delivery.id, delivery.host, delivery.incidentId, at, at, body, hash(body), fingerprint, key, at);
    const message = JSON.parse(body);
    const messageId = config.provider === "smtp" ? previous?.provider === "smtp" ? previous.message_id : "<bb-soc." + id.slice(17) + "@" + message.from.split("@")[1] + ">" : null;
    db.prepare("UPDATE notification_provider_attempts SET provider=?,transport_json=?,transport_digest=?,message_id=?,mime=?,mime_digest=? WHERE id=?")
      .run(config.provider, transportJson(), transportDigest(), messageId,
        config.provider === "smtp" && previous?.provider === "smtp" ? previous.mime : null,
        config.provider === "smtp" && previous?.provider === "smtp" ? previous.mime_digest : null, id);
    const row = db.prepare("SELECT * FROM notification_provider_attempts WHERE id=?").get(id);
    receipt(row, "ready");
    return row;
  }
  function prepare() {
    if (!enabled()) return;
    const key = credential(config.credentialFile, config.provider);
    // Scan notification intent, not its historical enabled flag: a recovery
    // observed while paused still belongs to the recipients of an attempted opening.
    const cursor = Number(db.prepare("SELECT value FROM monitor_meta WHERE key='notification-scan-row'").get()?.value || 0);
    let rows = db.prepare("SELECT rowid AS scan_row,id FROM outbox WHERE rowid>? AND delivered_at IS NULL AND superseded_at IS NULL AND json_extract(event,'$.notificationIntent')=1 ORDER BY rowid LIMIT 50").all(cursor);
    if (!rows.length) rows = db.prepare("SELECT rowid AS scan_row,id FROM outbox WHERE delivered_at IS NULL AND superseded_at IS NULL AND json_extract(event,'$.notificationIntent')=1 ORDER BY rowid LIMIT 50").all();
    for (const event of rows) {
      if (!enabled()) break;
      store.capacity();
      // Collapse accumulated state/reminder notices to the latest pending state
      // for a generation. Keep the events as evidence and preserve distinct
      // action/verification failure notices and already prepared deliveries.
      const coalesced = store.transaction(() => {
        const row = db.prepare("SELECT event,attempted_at FROM outbox WHERE id=?").get(event.id);
        const notice = JSON.parse(row.event);
        const types = ["opened", "updated", "reminder", "prolonged", "dependency-released", "maintenance-ended"];
        if (!types.includes(notice.type) || row.attempted_at || db.prepare("SELECT event_id FROM notification_snapshots WHERE event_id=?").get(event.id)) return false;
        const later = db.prepare("SELECT id FROM outbox WHERE rowid>? AND delivered_at IS NULL AND superseded_at IS NULL AND json_extract(event,'$.incidentId')=? AND json_extract(event,'$.type') IN ('opened','updated','reminder','prolonged','dependency-released','maintenance-ended') LIMIT 1").get(event.scan_row, notice.incidentId);
        if (!later) return false;
        db.prepare("UPDATE outbox SET superseded_at=?,outcome='notification-coalesced' WHERE id=?").run(now(), event.id);
        return true;
      });
      if (coalesced) continue;
      const prepared = store.prepareNotification(event.id, config.destinations);
      if (prepared.eligible) store.transaction(() => {
        store.capacity();
        for (const delivery of prepared.deliveries) {
          if (db.prepare("SELECT id FROM notification_provider_attempts WHERE delivery_id=?").get(delivery.id)) continue;
          const link = origin + "/#/incidents?appId=" + encodeURIComponent(appId) + "&incident=" + encodeURIComponent(delivery.incidentId);
          const body = JSON.stringify({ from: config.from, to: [delivery.destination], subject: delivery.subject,
            text: delivery.text.replace(/#\/incidents\?incident=[^\s]+/, link) });
          insertAttempt(delivery, body, key.fingerprint);
        }
        store.claimEvent(event.id); store.acknowledgeEvent(event.id);
      });
      db.prepare("INSERT INTO monitor_meta(key,value) VALUES('notification-scan-row',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(event.scan_row));
    }
  }
  function park(row, reason) {
    db.prepare("UPDATE notification_provider_attempts SET state='needs-reconciliation',error_code=?,updated_at=?,revision=revision+1,lease_owner=NULL,lease_until=NULL WHERE id=?").run(reason, now(), row.id);
    receipt(row, "needs-reconciliation");
  }
  function reserve(id) {
    return store.transaction(() => {
      if (!enabled()) return null;
      const row = db.prepare("SELECT * FROM notification_provider_attempts WHERE id=?").get(id);
      if (!row || !row.active || !["ready", "retryable", "in-flight"].includes(row.state) || row.next_at > now() || (row.lease_until && row.lease_until > now())) return null;
      store.capacity();
      if (row.provider !== config.provider || (row.transport_digest && row.transport_digest !== transportDigest())) { park(row, "provider-configuration-changed"); return null; }
      if (row.provider === "smtp" && row.state === "in-flight" && row.smtp_data_at !== null) { park(row, "smtp-data-outcome-unknown"); return null; }
      if (hash(row.body) !== row.body_digest) { park(row, "payload-integrity"); return null; }
      if (row.first_request_at !== null && (now() < row.first_request_at || now() - row.first_request_at >= RETRY_WINDOW)) { park(row, "idempotency-window-expired"); return null; }
      const decision = store.notificationEligibility(row.delivery_id);
      if (!decision.eligible) {
        if (decision.terminal && boundaryAt(row) === null) {
          db.prepare("UPDATE notification_provider_attempts SET state='cancelled',error_code=?,updated_at=?,revision=revision+1 WHERE id=?").run(decision.reason, now(), row.id);
          receipt(row, "cancelled");
        }
        db.prepare("UPDATE notification_provider_attempts SET next_at=? WHERE id=?").run(now() + 60000, row.id);
        return null;
      }
      let key;
      try { key = credential(config.credentialFile, config.provider); } catch { park(row, "credential-unavailable"); return null; }
      const body = JSON.parse(row.body);
      if (key.fingerprint !== row.credential_fingerprint || body.from !== config.from || !config.destinations.includes(body.to[0])) {
        park(row, "configuration-changed"); return null;
      }
      if (db.prepare("SELECT count(*) AS n FROM notification_provider_requests WHERE started_at>?").get(now() - 3600000).n >= config.hourlySendCap) return null;
      const first = row.first_request_at ?? now(), count = row.request_count + 1;
      db.prepare("UPDATE notification_provider_attempts SET state='in-flight',first_request_at=?,request_count=?,lease_owner=?,lease_until=?,updated_at=?,revision=revision+1,smtp_data_at=NULL,smtp_retry_safe=0 WHERE id=?")
        .run(first, count, owner, now() + LEASE_MS, now(), row.id);
      db.prepare("INSERT INTO notification_provider_requests(attempt_id,sequence,started_at) VALUES(?,?,?)").run(row.id, count, now());
      const reserved = db.prepare("SELECT * FROM notification_provider_attempts WHERE id=?").get(row.id);
      receipt(reserved, "in-flight");
      return { row: reserved, token: key.token, credentials: key.credentials };
    });
  }
  async function ensureSmtpMessage(id) {
    const row = db.prepare("SELECT * FROM notification_provider_attempts WHERE id=?").get(id);
    if (!row || row.provider !== "smtp" || row.mime !== null || !row.active) return;
    const mime = await compileSmtpMessage({ ...JSON.parse(row.body), messageId: row.message_id, date: new Date(row.created_at) });
    store.transaction(() => {
      store.capacity();
      db.prepare("UPDATE notification_provider_attempts SET mime=?,mime_digest=? WHERE id=? AND mime IS NULL AND body_digest=?")
        .run(mime, hash(mime), id, row.body_digest);
    });
  }
  function beforeSmtpData(row) {
    store.transaction(() => {
      const current = db.prepare("SELECT * FROM notification_provider_attempts WHERE id=?").get(row.id);
      if (!enabled() || !current?.active || current.lease_owner !== owner || current.request_count !== row.request_count || current.lease_until <= now()) throw problem(409, "SMTP delivery lease or enablement changed.");
      store.capacity();
      if (!current.mime || hash(current.mime) !== current.mime_digest) throw problem(409, "SMTP message integrity failed.");
      db.prepare("UPDATE notification_provider_attempts SET smtp_data_at=?,smtp_first_data_at=COALESCE(smtp_first_data_at,?),updated_at=? WHERE id=?").run(now(), now(), now(), row.id);
      db.prepare("UPDATE notification_provider_requests SET smtp_data_at=? WHERE attempt_id=? AND sequence=?").run(now(), row.id, row.request_count);
      receipt(db.prepare("SELECT * FROM notification_provider_attempts WHERE id=?").get(row.id), "in-flight");
    });
  }
  function finish(row, result) {
    store.transaction(() => {
      const current = db.prepare("SELECT * FROM notification_provider_attempts WHERE id=?").get(row.id);
      if (!current?.active || current.lease_owner !== owner || current.request_count !== row.request_count) return;
      const smtp = row.provider === "smtp";
      if (smtp) result = { ...result, id: result.receiptId };
      const accepted = smtp ? result.accepted === true && result.smtpStatus === 250 && current.smtp_data_at !== null && /^smtp-receipt-[a-f0-9]{64}$/.test(result.id || "")
        : result.status >= 200 && result.status < 300 && typeof result.id === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(result.id);
      const retryable = smtp ? result.retryable === true && result.ambiguous === false && result.safeToRetry === true
        : !result.status || [408, 429].includes(result.status) || result.status >= 500 || result.status === 409 && result.code === "concurrent_idempotent_requests";
      const retrySeconds = typeof result.retryAfter === "string" && /^\d{1,6}$/.test(result.retryAfter) ? Number(result.retryAfter) : 0;
      const delay = Math.max(1000 * Math.min(3600, 30 * 2 ** Math.min(row.request_count - 1, 7)), Math.min(retrySeconds, 3600) * 1000);
      const state = accepted ? "accepted" : retryable && now() - row.first_request_at < RETRY_WINDOW ? "retryable" : "needs-reconciliation";
      const code = accepted ? null : smtp ? result.errorCode || "smtp-data-outcome-unknown" : !result.status ? "provider-response-unknown" : result.status >= 200 && result.status < 300 ? "provider-acceptance-unproven" : "provider-http-" + result.status;
      db.prepare("UPDATE notification_provider_attempts SET state=?,updated_at=?,revision=revision+1,next_at=?,lease_owner=NULL,lease_until=NULL,provider_id=?,accepted_at=?,http_status=?,error_code=? WHERE id=?")
        .run(state, now(), now() + delay, accepted ? result.id : null, accepted ? now() : null, result.status || null, code, row.id);
      db.prepare("UPDATE notification_provider_requests SET finished_at=?,http_status=?,outcome=?,provider_id=? WHERE attempt_id=? AND sequence=?")
        .run(now(), result.status || null, state, accepted ? result.id : null, row.id, row.request_count);
      if (smtp) {
        const responseDigest = /^[a-f0-9]{64}$/.test(result.responseDigest || "") ? result.responseDigest : null;
        const status = Number.isInteger(result.smtpStatus) && result.smtpStatus >= 200 && result.smtpStatus <= 599 ? result.smtpStatus : null;
        db.prepare("UPDATE notification_provider_attempts SET smtp_retry_safe=?,smtp_status=?,response_digest=? WHERE id=?")
          .run(result.safeToRetry === true && result.ambiguous === false ? 1 : 0, status, responseDigest, row.id);
        db.prepare("UPDATE notification_provider_requests SET smtp_status=?,response_digest=? WHERE attempt_id=? AND sequence=?")
          .run(status, responseDigest, row.id, row.request_count);
      }
      receipt(current, state, accepted ? result.id : undefined);
    });
  }
  async function work() {
    try {
      // A recipient removed before any provider request can be parked while an
      // incident is open. Once resolved, cancel that proven-unattempted opening
      // so it cannot hold recovery for other recipients indefinitely.
      if (enabled()) store.transaction(() => {
        const cancelled = db.prepare("SELECT a.* FROM notification_provider_attempts a JOIN notification_deliveries d ON d.id=a.delivery_id JOIN incidents i ON i.id=a.incident_id WHERE a.active=1 AND a.state='needs-reconciliation' AND (a.first_request_at IS NULL OR (a.provider='smtp' AND a.smtp_first_data_at IS NULL)) AND d.attempted_at IS NULL AND i.status='resolved' ORDER BY a.created_at,a.id LIMIT 100").all();
        if (cancelled.length) store.capacity();
        for (const row of cancelled) {
          db.prepare("UPDATE notification_provider_attempts SET state='cancelled',error_code='incident-resolved-before-request',updated_at=?,revision=revision+1 WHERE id=?").run(now(), row.id);
          receipt(row, "cancelled");
        }
      });
      // Resume persisted attempts first, so recovery waits see boundary evidence.
      for (let pass = 0; pass < 2 && enabled(); pass++) {
        if (pass) prepare();
        const rows = db.prepare("SELECT id FROM notification_provider_attempts WHERE active=1 AND state IN ('ready','retryable','in-flight') AND next_at<=? AND (lease_until IS NULL OR lease_until<=?) ORDER BY next_at,created_at,id LIMIT 20").all(now(), now());
        let count = 0;
        for (const candidate of rows) {
          if (!enabled() || count >= 4) break;
          await ensureSmtpMessage(candidate.id);
          const reserved = reserve(candidate.id); if (!reserved) continue;
          count++;
          let response;
          try {
            if (reserved.row.provider === "smtp") {
              const body = JSON.parse(reserved.row.body);
              response = await smtpSend({ server: JSON.parse(reserved.row.transport_json), credentials: reserved.credentials,
                envelope: { from: body.from, to: body.to }, raw: reserved.row.mime, messageId: reserved.row.message_id,
                beforeData: () => beforeSmtpData(reserved.row) });
            } else response = await (send || sendResend)({ token: reserved.token, body: reserved.row.body, key: reserved.row.provider_key });
          } catch { response = { networkError: true, status: null, accepted: false, retryable: false, ambiguous: true, errorCode: "smtp-transport-outcome-unknown" }; }
          finish(reserved.row, response || { status: null });
        }
      }
      fault = null;
    } catch { fault = "Notification delivery maintenance failed; retained attempts require review."; }
  }
  function tick() {
    if (running) return running;
    if (!enabled()) return Promise.resolve();
    running = work().finally(() => { running = null; });
    return running;
  }
  function scopedAttempt(id, hosts) {
    if (typeof id !== "string" || !/^provider-attempt-[a-f0-9]{32}$/.test(id)) throw problem(400, "Invalid notification attempt identity.");
    const row = db.prepare("SELECT * FROM notification_provider_attempts WHERE id=?").get(id);
    if (!row) throw problem(404, "Notification attempt not found.");
    const selected = store.hostsFilter(hosts);
    if (selected && !selected.includes(row.host)) throw problem(403, "Notification attempt is outside the selected host scope.");
    return row;
  }
  function projection(row) {
    return { id: row.id, deliveryId: row.delivery_id, incidentId: row.incident_id, host: row.host,
      provider: row.provider, messageId: row.message_id, smtpDataStartedAt: row.smtp_first_data_at,
      smtpStatus: row.smtp_status, responseDigest: row.response_digest, server: row.provider === "smtp" ? JSON.parse(row.transport_json) : null,
      exactRetryAllowed: row.provider !== "smtp" || row.smtp_retry_safe === 1 || row.smtp_first_data_at === null,
      idempotencyGuaranteed: row.provider !== "smtp", destination: JSON.parse(row.body).to[0], active: !!row.active, state: row.state, revision: row.revision,
      createdAt: row.created_at, updatedAt: row.updated_at, firstRequestAt: row.first_request_at,
      requestCount: row.request_count, nextAttemptAt: row.next_at, providerId: row.provider_id,
      acceptedAt: row.accepted_at, httpStatus: row.http_status, errorCode: row.error_code,
      exactRetryBefore: row.first_request_at === null ? null : row.first_request_at + RETRY_WINDOW,
      requests: db.prepare("SELECT sequence,started_at AS startedAt,finished_at AS finishedAt,http_status AS httpStatus,smtp_status AS smtpStatus,smtp_data_at AS smtpDataStartedAt,response_digest AS responseDigest,outcome,provider_id AS providerId FROM notification_provider_requests WHERE attempt_id=? ORDER BY sequence DESC LIMIT 10").all(row.id) };
  }
  function status(hosts, options = {}) {
    const ledger = store.notificationLedger(hosts, options), scope = store.scope(hosts);
    const values = [...scope.values], incident = options.incidentId ? " AND incident_id=?" : "";
    if (options.incidentId) values.push(options.incidentId);
    const rows = db.prepare("SELECT * FROM notification_provider_attempts WHERE 1=1" + scope.sql + incident + " ORDER BY created_at DESC,id DESC LIMIT 101").all(...values);
    const counts = db.prepare("SELECT state,count(*) AS count FROM notification_provider_attempts WHERE active=1" + scope.sql + incident + " GROUP BY state").all(...values);
    return { ...ledger, transport: { provider: config.provider, idempotencyGuaranteed: config.provider === "resend", configured: config.enabled, enabled: enabled(),
      paused: control().paused, revision: control().revision, hourlySendCap: config.hourlySendCap, error: fault,
      retainedAttemptLimit: MAX_ATTEMPTS, automaticRetryWindowHours: 23, counts },
      attempts: rows.slice(0, 100).map(projection), attemptsTruncated: rows.length > 100,
      decisions: db.prepare("SELECT d.at,d.actor,d.action,d.attempt_id AS attemptId,d.reason,d.value FROM notification_operator_decisions d LEFT JOIN notification_provider_attempts a ON a.id=d.attempt_id WHERE 1=1" +
        store.scope(hosts, "a.host").sql + (options.incidentId ? " AND a.incident_id=?" : "") + " ORDER BY d.id DESC LIMIT 20").all(...values).map(row => ({ ...row, value: JSON.parse(row.value) })) };
  }
  function validateDecision(body) {
    if (!plain(body) || typeof body.actor !== "string" || !body.actor || body.actor.length > 160
      || typeof body.reason !== "string" || !body.reason.trim() || body.reason.length > 1000
      || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1) throw problem(400, "An actor, reason, and expected revision are required.");
  }
  function audit(body, action, attemptId, value) {
    db.prepare("INSERT INTO notification_operator_decisions(at,actor,action,attempt_id,reason,value) VALUES(?,?,?,?,?,?)")
      .run(now(), body.actor, action, attemptId || null, body.reason.trim(), JSON.stringify(value));
  }
  function pause(body, hosts) {
    validateDecision(body);
    if (hosts) throw problem(400, "Notification pause is application-wide; clear the host filter.");
    if (typeof body.paused !== "boolean") throw problem(400, "A boolean paused value is required.");
    return store.mutate("notifications-pause", { ...body, scope: null }, () => {
      const prior = control();
      if (body.expectedRevision !== prior.revision) throw problem(409, "Notification control revision changed.");
      const next = { paused: body.paused, revision: prior.revision + 1 };
      db.prepare("UPDATE monitor_meta SET value=? WHERE key='notification-control'").run(JSON.stringify(next));
      audit(body, body.paused ? "pause" : "resume", null, next);
      return { ok: true, ...next };
    });
  }
  function reconcile(body, hosts) {
    validateDecision(body); scopedAttempt(body.attemptId, hosts);
    if (!["retry-exact", "confirm-accepted", "requeue-fresh"].includes(body.action)) throw problem(400, "Unsupported notification reconciliation action.");
    return store.mutate("notifications-reconcile", { ...body, scope: store.hostsFilter(hosts) }, () => {
      const row = scopedAttempt(body.attemptId, hosts);
      if (row.revision !== body.expectedRevision || !row.active || row.state !== "needs-reconciliation") throw problem(409, "Only the current parked attempt at its expected revision can be reconciled.");
      let nextId = row.id;
      if (body.action === "confirm-accepted") {
        const at = typeof body.acceptedAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(body.acceptedAt) ? Date.parse(body.acceptedAt) : NaN;
        if (boundaryAt(row) === null || !Number.isFinite(at) || at < boundaryAt(row) || at > now()
            || typeof body.providerId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(body.providerId)) throw problem(400, "Verified provider identity and acceptance time within the attempted interval are required.");
        db.prepare("UPDATE notification_provider_attempts SET state='accepted',provider_id=?,accepted_at=?,updated_at=?,revision=revision+1,error_code=NULL WHERE id=?").run(body.providerId, at, now(), row.id);
        receipt(row, "accepted", body.providerId, at);
      } else {
        const key = credential(config.credentialFile, config.provider), frozen = JSON.parse(row.body);
        if (frozen.from !== config.from || !config.destinations.includes(frozen.to[0])) throw problem(409, "The frozen sender and destination must remain in reviewed configuration.");
        if (body.action === "retry-exact") {
          if (row.provider !== config.provider || row.transport_digest && row.transport_digest !== transportDigest()) throw problem(409, "The frozen provider and server configuration changed.");
          if (row.provider === "smtp" && row.smtp_retry_safe !== 1 && row.smtp_first_data_at !== null) throw problem(409, "SMTP has no idempotent replay after uncertain DATA acceptance; reconcile acceptance or explicitly requeue with duplicate risk.");
          if (key.fingerprint !== row.credential_fingerprint || row.first_request_at !== null && (now() < row.first_request_at || now() - row.first_request_at >= RETRY_WINDOW)) throw problem(409, "Exact replay is unavailable after credential change or the retry deadline.");
          db.prepare("UPDATE notification_provider_attempts SET state='retryable',next_at=?,updated_at=?,revision=revision+1,error_code=NULL WHERE id=?").run(now(), now(), row.id);
          db.prepare("UPDATE notification_deliveries SET state='retryable',updated_at=? WHERE id=?").run(now(), row.delivery_id);
        } else {
          if (body.duplicateRiskAccepted !== true) throw problem(400, "Fresh requeue requires explicit acknowledgment that prior acceptance is unknown and duplicate mail is possible.");
          db.prepare("UPDATE notification_provider_attempts SET active=0,state='superseded',updated_at=?,revision=revision+1 WHERE id=?").run(now(), row.id);
          db.prepare("UPDATE notification_deliveries SET state='ready',updated_at=? WHERE id=?").run(now(), row.delivery_id);
          nextId = insertAttempt({ id: row.delivery_id, host: row.host, incidentId: row.incident_id }, row.body, key.fingerprint, row).id;
        }
      }
      const result = { ok: true, attemptId: row.id, action: body.action, nextAttemptId: nextId };
      audit(body, body.action, row.id, { ...result, providerId: body.providerId || null, acceptedAt: body.acceptedAt || null });
      return result;
    });
  }
  return { enabled, tick, status, pause, reconcile, async close() { stopping = true; if (running) await running; } };
}
module.exports = { createNotifications, notificationConfiguration, sendResend, credential, RETRY_WINDOW };
