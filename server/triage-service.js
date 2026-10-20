"use strict";
const crypto = require("node:crypto");
const { validateNormalizedRecord } = require("../tools/ingest-contract");
const { readJsonBody, sendJson } = require("./reference-control-plane");
const BASE = "/api/v1/triage";
const MAX_BYTES = 128 * 1024 * 1024;
const READ_LIMITS = Object.freeze({ evidence: 64 * 1024, history: 512 * 1024, inspection: 640 * 1024, record: 48000, historyEvent: 16 * 1024, caseMembers: 30 });
const VIEWS = ["queue", "approvals", "cases", "closed", "all"];
const STATES = ["open", "investigating", "resolved", "closed"];
const CATEGORIES = ["unclassified", "benign", "expected-activity", "real-threat"];
const SEVERITIES = ["critical", "high", "medium", "low", "info", "unknown"];
const FILTERS = ["view", "sourceId", "rule", "severity", "category", "q", "groupId"];
function fail(status, message, code = "triage-rejected") { const e = new Error(message); e.status = status; e.code = code; throw e; }
function plain(v, allowed, required = []) {
  if (!v || typeof v !== "object" || Array.isArray(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))
      || Object.keys(v).some(k => !allowed.includes(k)) || required.some(k => !Object.hasOwn(v, k))) fail(400, "Supply only documented triage fields.");
  return v;
}
function text(v, max, label, empty = false) {
  if (typeof v !== "string" || (!empty && !v.trim()) || Buffer.byteLength(v) > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)) fail(400, "Invalid " + label + ".");
  return v;
}
function identifier(v, label = "identifier") {
  if (typeof v !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v)) fail(400, "Invalid " + label + ".");
  return v;
}
function integer(v, label, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(v) || v < 0 || v > max) fail(400, "Invalid " + label + ".");
  return v;
}
function digest(v) { return crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex"); }
function keyOf(sourceId, recordId) { return Buffer.from(JSON.stringify([sourceId, recordId])).toString("base64url"); }
function keyParts(key) {
  if (typeof key !== "string" || key.length > 720 || !/^[A-Za-z0-9_-]+$/.test(key)) fail(400, "Invalid alert key.");
  let p; try { p = JSON.parse(Buffer.from(key, "base64url").toString("utf8")); } catch { fail(400, "Invalid alert key."); }
  if (!Array.isArray(p) || p.length !== 2) fail(400, "Invalid alert key.");
  p.forEach(v => identifier(v));
  if (keyOf(...p) !== key) fail(400, "Alert key is not canonical.");
  return p;
}
function filters(value = {}) {
  plain(value, FILTERS); const f = { view: value.view === undefined ? "queue" : value.view };
  if (!VIEWS.includes(f.view)) fail(400, "Unknown triage view.");
  for (const k of ["sourceId", "rule", "groupId"]) if (value[k] !== undefined && value[k] !== "") f[k] = identifier(value[k], k);
  for (const [k, values] of [["severity", SEVERITIES], ["category", CATEGORIES]]) if (value[k] !== undefined && value[k] !== "") {
    if (!values.includes(value[k])) fail(400, "Unknown " + k + "."); f[k] = value[k];
  }
  if (value.q !== undefined && value.q !== "") f.q = text(value.q, 240, "search").trim();
  return f;
}
function createTriageService({ store, now = Date.now, fault } = {}) {
  if (!store?.db || typeof store.controlSnapshot !== "function") throw new TypeError("Triage requires the indexed private telemetry store.");
  const db = store.db;
  // Separate local workflow authority; never overwrite immutable canonical observations.
  db.exec([
    "CREATE TABLE IF NOT EXISTS triage_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;",
    "CREATE TABLE IF NOT EXISTS triage_rows(kind TEXT NOT NULL,id TEXT NOT NULL,app_id TEXT NOT NULL,source_id TEXT,record_id TEXT,revision INTEGER NOT NULL,status TEXT NOT NULL,json TEXT NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(kind,id)) STRICT;",
    "CREATE INDEX IF NOT EXISTS triage_rows_app ON triage_rows(kind,app_id,status);",
    "CREATE INDEX IF NOT EXISTS triage_rows_alert ON triage_rows(kind,source_id,record_id);",
    "CREATE TABLE IF NOT EXISTS triage_members(group_id TEXT NOT NULL,app_id TEXT NOT NULL,source_id TEXT NOT NULL,record_id TEXT NOT NULL,body_hash TEXT NOT NULL,admission_id INTEGER NOT NULL,received_at TEXT NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(group_id,source_id,record_id)) STRICT;",
    "CREATE INDEX IF NOT EXISTS triage_members_group ON triage_members(group_id);",
    "CREATE UNIQUE INDEX IF NOT EXISTS triage_members_admission ON triage_members(source_id,record_id,admission_id,received_at,body_hash);",
    "CREATE TABLE IF NOT EXISTS triage_items(operation_id TEXT NOT NULL,position INTEGER NOT NULL,source_id TEXT NOT NULL,record_id TEXT NOT NULL,snapshot TEXT NOT NULL,outcome TEXT NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(operation_id,position)) STRICT;",
    "CREATE INDEX IF NOT EXISTS triage_items_pending ON triage_items(operation_id,outcome,position);",
    "CREATE INDEX IF NOT EXISTS triage_items_alert ON triage_items(source_id,record_id,operation_id);",
    "INSERT OR IGNORE INTO triage_meta VALUES('schema-version','1');",
    "INSERT OR IGNORE INTO triage_meta VALUES('bytes','0');",
    "CREATE TRIGGER IF NOT EXISTS triage_rows_add AFTER INSERT ON triage_rows BEGIN UPDATE triage_meta SET value=CAST(value AS INTEGER)+NEW.bytes WHERE key='bytes'; END;",
    "CREATE TRIGGER IF NOT EXISTS triage_rows_change AFTER UPDATE ON triage_rows BEGIN UPDATE triage_meta SET value=CAST(value AS INTEGER)+NEW.bytes-OLD.bytes WHERE key='bytes'; END;",
    "CREATE TRIGGER IF NOT EXISTS triage_members_add AFTER INSERT ON triage_members BEGIN UPDATE triage_meta SET value=CAST(value AS INTEGER)+NEW.bytes WHERE key='bytes'; END;",
    "CREATE TRIGGER IF NOT EXISTS triage_items_add AFTER INSERT ON triage_items BEGIN UPDATE triage_meta SET value=CAST(value AS INTEGER)+NEW.bytes WHERE key='bytes'; END;"
  ].join("\n"));
  if (db.prepare("SELECT value FROM triage_meta WHERE key='schema-version'").get().value !== "1") throw new Error("Unsupported triage state version.");
  // Initialize cursor identity only at startup; GETs must never write workflow state.
  db.transaction(() => {
    const highest=db.prepare("SELECT COALESCE(MAX(rowid),0) n FROM triage_rows").get().n;
    db.prepare("INSERT OR IGNORE INTO triage_meta VALUES('history-start-row',?)").run(String(highest));
    db.prepare("INSERT OR IGNORE INTO triage_meta VALUES('history-cursor-key',?)").run(crypto.randomBytes(32).toString("hex"));
  }).immediate();
  const cursorKey=db.prepare("SELECT value FROM triage_meta WHERE key='history-cursor-key'").get().value;
  const historyStartRow=Number(db.prepare("SELECT value FROM triage_meta WHERE key='history-start-row'").get().value);
  if(!/^[a-f0-9]{64}$/.test(cursorKey)||!Number.isSafeInteger(historyStartRow)||historyStartRow<0)throw new Error("Invalid Triage history metadata.");
  db.exec("CREATE INDEX IF NOT EXISTS triage_history_scope ON triage_rows(app_id,kind,json_extract(CASE WHEN json_valid(json) THEN json ELSE '{}' END,'$.key'));");
  function stamp() { const n = now(); const d = n instanceof Date ? n : new Date(n); if (!Number.isFinite(d.getTime())) throw new TypeError("Invalid triage clock."); return d.toISOString(); }
  function app(appId) { identifier(appId, "application"); if (!store.controlSnapshot().apps.some(a => a.appId === appId)) fail(404, "Unknown application."); return appId; }
  function actorId(actor) { return text(actor, 256, "authenticated actor"); }
  function row(kind, id) { const r = db.prepare("SELECT json FROM triage_rows WHERE kind=? AND id=?").get(kind, id); return r ? JSON.parse(r.json) : null; }
  function put(kind, id, appId, value, sourceId = null, recordId = null) {
    const json = JSON.stringify(value), bytes = Buffer.byteLength(json) + Buffer.byteLength(id) + 128;
    db.prepare("INSERT INTO triage_rows VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision,status=excluded.status,json=excluded.json,bytes=excluded.bytes")
      .run(kind,id,appId,sourceId,recordId,value.revision || 0,value.status || "",json,bytes);
  }
  function audit(appId, actor, action, details) {
    const id = crypto.randomUUID(); put("audit", id, appId, { id, at: stamp(), actor, action, ...details });
  }
  function capacity() {
    if (Number(db.prepare("SELECT value FROM triage_meta WHERE key='bytes'").get().value) > MAX_BYTES) fail(507, "Triage state capacity is exhausted. Preserve and export state before a reviewed migration; history is never silently evicted.", "triage-capacity");
  }
  function transaction(fn) { return db.transaction(() => { const result = fn(); capacity(); return result; }).immediate(); }
  function receipt(action, input, actor, mutate) {
    actorId(actor); identifier(input.idempotencyKey, "idempotency key");
    const id = digest([actor, input.idempotencyKey]), bodyHash = digest({ action, input });
    return transaction(() => {
      const previous = row("receipt", id);
      if (previous) { if (previous.bodyHash !== bodyHash) fail(409, "Idempotency key was reused with different content.", "idempotency-conflict"); return previous.result; }
      const result = mutate();
      put("receipt", id, input.appId, { actor, bodyHash, result, at: stamp() });
      return result;
    });
  }
  const BASE_SQL = [
    "SELECT json_extract(scoped_source.value,'$.appId') AS app_id,t.id AS admission_id,t.received_at,t.source_id,t.record_id,t.body_hash,t.json,",
    "d.json AS decision_json,p.json AS proposal_json,g.id AS group_id,g.json AS group_json,",
    "COALESCE(json_extract(d.json,'$.state'),'open') AS local_state,",
    "COALESCE(json_extract(d.json,'$.category'),'unclassified') AS local_category,",
    "CASE WHEN COALESCE(json_extract(d.json,'$.state'),'open') IN ('closed','resolved') THEN 'closed'",
    "WHEN COALESCE(json_extract(d.json,'$.state'),'open')='investigating' OR json_extract(d.json,'$.category')='real-threat' THEN 'cases'",
    "WHEN p.status='pending' AND json_extract(p.json,'$.admissionId')=t.id AND json_extract(p.json,'$.receivedAt')=t.received_at AND json_extract(p.json,'$.bodyHash')=t.body_hash THEN 'approvals' ELSE 'queue' END AS lane",
    "FROM telemetry_records t JOIN json_each((SELECT json FROM telemetry_control WHERE id=1),'$.sources') scoped_source ON json_extract(scoped_source.value,'$.sourceId')=t.source_id",
    "LEFT JOIN triage_rows d ON d.kind='decision' AND d.source_id=t.source_id AND d.record_id=t.record_id AND json_extract(d.json,'$.admissionId')=t.id AND json_extract(d.json,'$.receivedAt')=t.received_at AND json_extract(d.json,'$.bodyHash')=t.body_hash",
    "LEFT JOIN triage_rows p ON p.kind='proposal' AND p.source_id=t.source_id AND p.record_id=t.record_id",
    "LEFT JOIN triage_members m ON m.app_id=json_extract(scoped_source.value,'$.appId') AND m.source_id=t.source_id AND m.record_id=t.record_id AND m.admission_id=t.id AND m.received_at=t.received_at AND m.body_hash=t.body_hash",
    "LEFT JOIN triage_rows g ON g.kind='group' AND g.id=m.group_id",
    "WHERE t.json IS NOT NULL AND t.kind IN ('finding','vulnerability.finding') AND json_extract(scoped_source.value,'$.appId')=?"
  ].join(" ");
  function selection(appId, f, includeView = true) {
    const clauses=[], args=[appId];
    if (f.sourceId) { clauses.push("source_id=?"); args.push(f.sourceId); }
    if (f.rule) { clauses.push("json_extract(json,'$.payload.ruleRef')=?"); args.push(f.rule); }
    if (f.severity) { clauses.push("COALESCE(json_extract(json,'$.payload.severity'),'unknown')=?"); args.push(f.severity); }
    if (f.category) { clauses.push("COALESCE(CASE WHEN json_extract(proposal_json,'$.status')='pending' AND lane='approvals' THEN json_extract(proposal_json,'$.category') ELSE local_category END,'unclassified')=?"); args.push(f.category); }
    if (f.groupId) { clauses.push("group_id=?"); args.push(f.groupId); }
    if (f.q) { clauses.push("instr(lower(json_extract(json,'$.payload.title') || char(10) || COALESCE(json_extract(json,'$.payload.summary'),'') || char(10) || source_id || char(10) || record_id || char(10) || COALESCE(json_extract(json,'$.payload.ruleRef'),'') || char(10) || COALESCE(json_extract(json,'$.payload.assetRef'),'')),lower(?))>0"); args.push(f.q); }
    if (includeView && f.view !== "all") { clauses.push("lane=?"); args.push(f.view); }
    return { sql: "SELECT * FROM ("+BASE_SQL+")"+(clauses.length ? " WHERE "+clauses.join(" AND ") : ""), args };
  }
  function rawAlert(appId, key) {
    const [sourceId,recordId] = keyParts(key);
    return db.prepare("SELECT * FROM ("+BASE_SQL+") WHERE source_id=? AND record_id=?").get(appId,sourceId,recordId) || null;
  }
  function sameAdmission(r, saved) { return r.body_hash===saved.bodyHash && r.admission_id===saved.admissionId && r.received_at===saved.receivedAt; }
  function projected(r) {
    const record=JSON.parse(r.json); let p=r.proposal_json ? JSON.parse(r.proposal_json) : null;
    const priorDecision=r.decision_json ? null : row("decision",keyOf(r.source_id,r.record_id));
    const decision=r.decision_json ? JSON.parse(r.decision_json) : { revision:priorDecision?.revision || 0,state:"open",category:"unclassified",owner:"",note:"" };
    if(p && !sameAdmission(r,p))p={revision:p.revision,status:"expired"};
    const updates=[{at:record.observedAt,source:"observation"},{at:decision.at,source:"decision"},...["createdAt","withdrawnAt","decidedAt"].map(field=>({at:p?.[field],source:"proposal"}))]
      .filter(v=>typeof v.at==="string" && Number.isFinite(Date.parse(v.at))).sort((a,b)=>Date.parse(b.at)-Date.parse(a.at));
    return { key:keyOf(r.source_id,r.record_id),evidenceVersion:evidenceVersion(r),updatedAt:updates[0]?.at || null,updatedSource:updates[0]?.source || null,sourceId:r.source_id,recordId:r.record_id,title:record.payload.title,observedAt:record.observedAt,
      severity:record.payload.severity || "unknown",rule:record.payload.ruleRef || "",asset:record.payload.assetRef || "",
      reportedState:record.payload.state,summary:record.payload.summary || "",decision,proposal:p,view:r.lane,
      group:r.group_id ? {id:r.group_id,label:JSON.parse(r.group_json).label} : null };
  }
  function groupSafety(groupId) {
    if (!groupId) return null;
    const members=db.prepare("SELECT m.body_hash AS expected,m.admission_id AS expected_id,m.received_at AS expected_at,t.id,t.received_at,t.body_hash,t.json FROM triage_members m LEFT JOIN telemetry_records t ON t.source_id=m.source_id AND t.record_id=m.record_id WHERE m.group_id=?").all(groupId);
    if (members.some(m => !m.json || m.expected !== m.body_hash || m.expected_id!==m.id || m.expected_at!==m.received_at)) return "unavailable";
    if (members.some(m => JSON.parse(m.json).payload.severity === "critical")) return "critical";
    return null;
  }
  function eligibility(r, cache = new Map()) {
    const a=projected(r);
    if(a.proposal?.status==="expired")return "unavailable";
    if (!a.proposal || a.proposal.status !== "pending" || ["closed","resolved"].includes(a.decision.state)) return "notPending";
    if (!sameAdmission(r,a.proposal)) return "unavailable";
    if (a.severity === "critical") return "critical";
    if(r.group_id && !cache.has(r.group_id))cache.set(r.group_id,groupSafety(r.group_id));
    return r.group_id ? cache.get(r.group_id) : null;
  }
  function list(query) {
    plain(query, ["appId",...FILTERS,"limit","offset"],["appId"]); const appId=app(query.appId);
    const f=filters(Object.fromEntries(FILTERS.filter(k=>query[k]!==undefined).map(k=>[k,query[k]])));
    const limit=query.limit===undefined ? 100 : integer(query.limit,"limit",200); if (!limit) fail(400,"Limit must be positive.");
    const offset=query.offset===undefined ? 0 : integer(query.offset,"offset",1000000);
    return db.transaction(() => {
      const all=selection(appId,f,false), selected=selection(appId,f);
      const counts={all:0,queue:0,approvals:0,cases:0,closed:0};
      for (const x of db.prepare("SELECT lane,COUNT(*) n FROM ("+all.sql+") GROUP BY lane").all(...all.args)) { counts[x.lane]=x.n; counts.all+=x.n; }
      const filteredCount=db.prepare("SELECT COUNT(*) n FROM ("+selected.sql+")").get(...selected.args).n;
      const raws=db.prepare(selected.sql+" ORDER BY json_extract(json,'$.observedAt') DESC,source_id,record_id LIMIT ? OFFSET ?").all(...selected.args,limit,offset);
      const alerts=raws.map(projected), groups=[];
      for (const id of new Set(raws.map(r=>r.group_id).filter(Boolean))) {
        const g=row("group",id), matchedCount=db.prepare("SELECT COUNT(*) n FROM ("+selected.sql+") WHERE group_id=?").get(...selected.args,id).n;
        groups.push({id,label:g.label,matchedCount,shownCount:raws.filter(r=>r.group_id===id).length,totalMembers:db.prepare("SELECT COUNT(*) n FROM triage_members WHERE group_id=?").get(id).n,hasCritical:groupSafety(id)==="critical"});
      }
      const groupCount=db.prepare("SELECT COUNT(*) n FROM (SELECT group_id,CASE WHEN group_id IS NULL THEN source_id END s,CASE WHEN group_id IS NULL THEN record_id END r FROM ("+selected.sql+") GROUP BY 1,2,3)").get(...selected.args).n;
      return {schemaVersion:"1",appId,filters:f,asOf:stamp(),counts,filteredCount,groupCount,alerts,groups,page:{limit,offset,total:filteredCount,hasMore:offset+alerts.length<filteredCount,nextOffset:offset+alerts.length<filteredCount?offset+alerts.length:null}};
    })();
  }
  function detail(appId,key) { return db.transaction(() => { app(appId); const r=rawAlert(appId,key); if (!r) fail(404,"Retained alert evidence was not found."); return {schemaVersion:"1",alert:projected(r)}; })(); }
  function evidenceVersion(r) {
    return digest(["triage-evidence-v1",r.app_id,keyOf(r.source_id,r.record_id),r.admission_id,r.received_at,r.body_hash]);
  }
  function checkedRead(query, allowed, build) {
    plain(query,["appId","key","expectedVersion",...allowed],["appId","key","expectedVersion"]);
    if(typeof query.expectedVersion!=="string"||!/^[a-f0-9]{64}$/.test(query.expectedVersion))fail(400,"Invalid evidence version.");
    keyParts(query.key);
    try{return db.transaction(()=>{
      app(query.appId);const r=rawAlert(query.appId,query.key);
      if(!r)fail(404,"Retained alert evidence was not found.","triage-evidence-unavailable");
      if(evidenceVersion(r)!==query.expectedVersion)fail(409,"The retained alert admission changed. Refresh and review its new evidence.","evidence-version-conflict");
      return build(r,canonicalEvidence(r));
    })();}catch(error){if(error.status)throw error;fail(503,"The retained inspection is inconsistent or unavailable.","triage-inspection-unavailable");}
  }
  function canonicalEvidence(r) {
    try {
      const stored=JSON.parse(r.json);
      const {schemaVersion,documentType,recordId,sourceId,estateId,kind,observedAt,payload}=stored;
      const external={schemaVersion,documentType,recordId,sourceId,estateId,kind,observedAt,payload};
      if(recordId!==r.record_id||sourceId!==r.source_id||!["finding","vulnerability.finding"].includes(kind)
          ||stored.receivedAt!==r.received_at||digest(external)!==r.body_hash)throw new Error("invalid");
      return validateNormalizedRecord(external);
    }catch{fail(503,"Retained alert evidence is inconsistent or unavailable.","triage-evidence-unavailable");}
  }
  function bounded(value,maximum,code) {
    if(Buffer.byteLength(JSON.stringify(value))>maximum)fail(503,"The retained projection exceeds its documented read budget.",code);
    return value;
  }
  function readScope(r){return{appId:r.app_id,key:keyOf(r.source_id,r.record_id),evidenceVersion:evidenceVersion(r)};}
  function evidenceView(r,record) {
    const output=JSON.parse(JSON.stringify(record)),omittedPaths=[],originalBytes=Buffer.byteLength(JSON.stringify(record));
    // Omit whole optional values; never cut JSON or represent a prefix as complete.
    if(output.payload.fields)for(const field of Object.keys(output.payload.fields).reverse()){
      if(Buffer.byteLength(JSON.stringify(output))<=READ_LIMITS.record)break;
      delete output.payload.fields[field];omittedPaths.push("payload.fields."+field);
    }
    for(const field of ["message","summary","indicator"])if(Buffer.byteLength(JSON.stringify(output))>READ_LIMITS.record&&Object.hasOwn(output.payload,field)){
      delete output.payload[field];omittedPaths.push("payload."+field);
    }
    const clipped=omittedPaths.length>0;
    return bounded({schemaVersion:"1",...readScope(r),scope:"exact-retained-admission",
      provenance:{sourceId:r.source_id,recordId:r.record_id,admissionId:r.admission_id,receivedAt:r.received_at,bodyHash:r.body_hash},
      record:output,complete:!clipped,clipped,omittedPaths,originalBytes,returnedBytes:Buffer.byteLength(JSON.stringify(output)),
      maxRecordBytes:READ_LIMITS.record,fullRecordAvailable:!clipped},READ_LIMITS.evidence,"triage-evidence-unavailable");
  }
  function encodeCursor(value) {
    const body=Buffer.from(JSON.stringify(value)).toString("base64url");
    return body+"."+crypto.createHmac("sha256",cursorKey).update(body).digest("base64url");
  }
  function decodeCursor(token,scope,limit) {
    if(typeof token!=="string"||token.length>2048||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))fail(400,"Invalid history cursor.","triage-cursor-invalid");
    const[body,mac]=token.split("."),expected=crypto.createHmac("sha256",cursorKey).update(body).digest("base64url");
    if(mac.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(mac),Buffer.from(expected)))fail(400,"Invalid history cursor.","triage-cursor-invalid");
    let c;try{c=JSON.parse(Buffer.from(body,"base64url").toString("utf8"));}catch{fail(400,"Invalid history cursor.","triage-cursor-invalid");}
    plain(c,["v","appId","key","evidenceVersion","highWater","boundary","direction","limit"],["v","appId","key","evidenceVersion","highWater","boundary","direction","limit"]);
    if(c.v!==1||!["older","newer"].includes(c.direction)||c.appId!==scope.appId||c.key!==scope.key||c.evidenceVersion!==scope.evidenceVersion
        ||(limit!==undefined&&c.limit!==limit))fail(400,"History cursor does not match this exact read.","triage-cursor-invalid");
    integer(c.highWater,"history high-water");integer(c.boundary,"history boundary");integer(c.limit,"history limit",100);
    if(!c.limit||c.boundary>c.highWater)fail(400,"Invalid history cursor.","triage-cursor-invalid");
    return c;
  }
  function historyEvent(row) {
    let h;try{h=JSON.parse(row.json);}catch{fail(503,"Local history is unavailable.","triage-history-unavailable");}
    let type,at,actor;
    if(row.kind==="decision-history"){type="decision-recorded";at=h.at;actor=h.actor;}
    else if(row.kind==="approval-item-history"){type="approval-skipped";at=h.at;actor=h.actor;}
    else {
      type={pending:"proposal-recorded",withdrawn:"proposal-withdrawn",approved:"proposal-approved",superseded:"proposal-superseded"}[h.status];
      at=h.status==="withdrawn"?h.withdrawnAt:["approved","superseded"].includes(h.status)?h.decidedAt:h.createdAt;
      actor=h.status==="withdrawn"?h.withdrawnBy:["approved","superseded"].includes(h.status)?h.decidedBy:h.actor;
    }
    if(!type||typeof at!=="string"||!Number.isFinite(Date.parse(at))||typeof actor!=="string"||!actor)fail(503,"Local history is inconsistent or unavailable.","triage-history-unavailable");
    try {
      text(actor,256,"history actor");text(at,64,"history timestamp");
      if(h.authorLabel!==undefined)text(h.authorLabel,120,"history author");
      if(h.note!==undefined)text(h.note,2000,"history note",true);
      if(h.owner!==undefined)text(h.owner,120,"history owner",true);
      if(h.withdrawalReason!==undefined)text(h.withdrawalReason,2000,"history reason");
      if(h.state!==undefined && !STATES.includes(h.state))throw new Error("state");
      if(h.category!==undefined && !CATEGORIES.includes(h.category))throw new Error("category");
      if(h.operationId!==undefined && h.operationId!==null)identifier(h.operationId,"history operation");
      if(h.revision!==undefined)integer(h.revision,"history revision");
      if(row.kind==="approval-item-history" && !["changed","missing","critical","notPending","unavailable"].includes(h.outcome))throw new Error("outcome");
    }catch{fail(503,"Local history is inconsistent or unavailable.","triage-history-unavailable");}
    const event={id:row.id,sequence:row.sequence,type,at,actor,authorLabel:h.authorLabel||null,
      revision:Number.isSafeInteger(h.revision)?h.revision:null,state:h.state||null,category:h.category||null,
      owner:h.owner||null,note:h.note||"",reason:h.withdrawalReason||"",operationId:h.operationId||null,outcome:h.outcome||null};
    return bounded(event,READ_LIMITS.historyEvent,"triage-history-unavailable");
  }
  function historyView(r,query) {
    const scope=readScope(r),requestedLimit=query.limit===undefined?undefined:integer(query.limit,"history limit",100);
    if(requestedLimit===0)fail(400,"History limit must be positive.");
    const c=query.cursor===undefined?null:decodeCursor(query.cursor,scope,requestedLimit);
    const limit=c?.limit||requestedLimit||30,highWater=c?.highWater??db.prepare("SELECT COALESCE(MAX(rowid),0) n FROM triage_rows").get().n;
    if(db.prepare("SELECT 1 FROM triage_rows WHERE app_id=? AND kind IN ('decision-history','proposal-history','approval-item-history') AND rowid<=? AND (NOT json_valid(json) OR CASE WHEN json_valid(json) THEN json_type(json) ELSE NULL END IS NOT 'object' OR CASE WHEN json_valid(json) THEN json_type(json,'$.key') ELSE NULL END IS NOT 'text' OR CASE WHEN json_valid(json) THEN json_type(json,'$.admissionId') ELSE NULL END IS NOT 'integer' OR CASE WHEN json_valid(json) THEN json_type(json,'$.receivedAt') ELSE NULL END IS NOT 'text' OR CASE WHEN json_valid(json) THEN json_type(json,'$.bodyHash') ELSE NULL END IS NOT 'text') LIMIT 1").get(scope.appId,highWater))
      fail(503,"Local history is inconsistent or unavailable.","triage-history-unavailable");
    const where="app_id=? AND kind IN ('decision-history','proposal-history','approval-item-history') AND rowid<=? AND json_extract(CASE WHEN json_valid(json) THEN json ELSE '{}' END,'$.key')=? AND json_extract(json,'$.admissionId')=? AND json_extract(json,'$.receivedAt')=? AND json_extract(json,'$.bodyHash')=?";
    const args=[scope.appId,highWater,scope.key,r.admission_id,r.received_at,r.body_hash];
    const total=db.prepare("SELECT COUNT(*) n FROM triage_rows WHERE "+where).get(...args).n;
    const direction=c?.direction||"older",compare=direction==="newer"?">":"<",ordering=direction==="newer"?"ASC":"DESC";
    const rows=db.prepare("SELECT rowid AS sequence,id,kind,json FROM triage_rows WHERE "+where+(c?" AND rowid"+compare+"?":"")+" ORDER BY rowid "+ordering+" LIMIT ?")
      .all(...args,...(c?[c.boundary]:[]),limit+1);
    if(rows.length>limit)rows.pop();
    const chosen=[],events=[];let eventBytes=0;
    for(const historyRow of rows){
      const event=historyEvent(historyRow),bytes=Buffer.byteLength(JSON.stringify(event))+1;
      if(eventBytes+bytes>READ_LIMITS.history-16*1024)break;
      chosen.push(historyRow);events.push(event);eventBytes+=bytes;
    }
    if(direction==="newer"){chosen.reverse();events.reverse();}
    const first=chosen[0]?.sequence,last=chosen[chosen.length-1]?.sequence;
    const hasNewer=first!==undefined&&!!db.prepare("SELECT 1 FROM triage_rows WHERE "+where+" AND rowid>? LIMIT 1").get(...args,first);
    const hasOlder=last!==undefined&&!!db.prepare("SELECT 1 FROM triage_rows WHERE "+where+" AND rowid<? LIMIT 1").get(...args,last);
    const cursor=(boundary,direction)=>encodeCursor({v:1,...scope,highWater,boundary,direction,limit});
    const legacy=!!db.prepare("SELECT 1 FROM triage_items i JOIN triage_rows o ON o.kind='operation' AND o.id=i.operation_id WHERE o.app_id=? AND o.rowid<=? AND i.source_id=? AND i.record_id=? AND json_extract(i.snapshot,'$.admissionId')=? AND json_extract(i.snapshot,'$.receivedAt')=? AND json_extract(i.snapshot,'$.bodyHash')=? LIMIT 1")
      .get(scope.appId,historyStartRow,r.source_id,r.record_id,r.admission_id,r.received_at,r.body_hash);
    return bounded({schemaVersion:"1",...scope,scope:"exact-admission-local-workflow",complete:!legacy,
      notices:legacy?["legacy-approval-outcomes-unavailable"]:[],
      retention:{canonicalEvidence:"retained",localHistory:"retained-no-automatic-eviction",priorIncarnations:"excluded",legacyApprovalOutcomes:legacy?"unavailable":"not-applicable"},
      events,page:{limit,total,highWater,hasOlder,hasNewer,olderCursor:hasOlder?cursor(last,"older"):null,newerCursor:hasNewer?cursor(first,"newer"):null},
      maxBytes:READ_LIMITS.history},READ_LIMITS.history,"triage-history-unavailable");
  }
  function caseContext(r) {
    if(!r.group_id)return null;
    const g=row("group",r.group_id);
    const totalMembers=db.prepare("SELECT COUNT(*) n FROM triage_members WHERE group_id=? AND app_id=?").get(r.group_id,r.app_id).n;
    const currentSql="SELECT * FROM ("+BASE_SQL+") WHERE group_id=?";
    const availableMembers=db.prepare("SELECT COUNT(*) n FROM ("+currentSql+")").get(r.app_id,r.group_id).n;
    const members=db.prepare(currentSql+" ORDER BY source_id,record_id LIMIT ?").all(r.app_id,r.group_id,READ_LIMITS.caseMembers)
      .map(current=>{const a=projected(current);return{key:a.key,evidenceVersion:a.evidenceVersion,title:a.title,sourceId:a.sourceId,recordId:a.recordId};});
    return{id:r.group_id,label:g.label,totalMembers,availableMembers,unavailableMembers:totalMembers-availableMembers,
      members,limit:READ_LIMITS.caseMembers,hasMore:availableMembers>members.length,attachments:"unsupported",independentNotes:"unsupported"};
  }
  function evidence(query){return checkedRead(query,[],(r,record)=>evidenceView(r,record));}
  function history(query){return checkedRead(query,["limit","cursor"],r=>historyView(r,query));}
  function inspection(query){return checkedRead(query,[],(r,record)=>bounded({schemaVersion:"1",...readScope(r),alert:projected(r),
    evidence:evidenceView(r,record),history:historyView(r,{}),caseContext:caseContext(r)},READ_LIMITS.inspection,"triage-inspection-unavailable"));}
  function requireAlert(input) { app(input.appId); const r=rawAlert(input.appId,input.key); if (!r) fail(404,"Retained alert evidence was not found."); return r; }
  function disposition(input, proposal) {
    if (!STATES.includes(input.state) || (proposal && input.state==="open") || !CATEGORIES.includes(input.category)) fail(400,"Invalid local disposition.");
    text(input.note,2000,"decision note",true);
  }
  function propose(input, actor) {
    plain(input,["appId","key","expectedRevision","idempotencyKey","state","category","note","authorLabel"],["appId","key","expectedRevision","idempotencyKey","state","category","note","authorLabel"]);
    disposition(input,true);text(input.authorLabel,120,"claimed recommendation author");integer(input.expectedRevision,"proposal revision");app(input.appId);
    return receipt("proposal",input,actor,()=>{
      const r=requireAlert(input), current=row("proposal",input.key);
      if ((current?.revision || 0)!==input.expectedRevision) fail(409,"Proposal revision changed.","revision-conflict");
      if (["closed","resolved"].includes(projected(r).decision.state)) fail(409,"Reopen the alert explicitly before proposing another disposition.");
      const p={revision:input.expectedRevision+1,state:input.state,category:input.category,note:input.note,authorLabel:input.authorLabel,
        actor,status:"pending",createdAt:stamp(),bodyHash:r.body_hash,admissionId:r.admission_id,receivedAt:r.received_at};
      put("proposal",input.key,input.appId,p,r.source_id,r.record_id);put("proposal-history",crypto.randomUUID(),input.appId,{key:input.key,...p});
      audit(input.appId,actor,"proposal-recorded",{key:input.key,revision:p.revision});return detail(input.appId,input.key);
    });
  }
  function withdraw(input,actor) {
    plain(input,["appId","key","expectedRevision","idempotencyKey","reason"],["appId","key","expectedRevision","idempotencyKey","reason"]);
    app(input.appId);keyParts(input.key);integer(input.expectedRevision,"proposal revision");text(input.reason,2000,"withdrawal reason");
    return receipt("proposal-withdraw",input,actor,()=>{
      const stored=db.prepare("SELECT app_id FROM triage_rows WHERE kind='proposal' AND id=?").get(input.key);
      const p=row("proposal",input.key);
      if(stored && stored.app_id!==input.appId)fail(403,"Proposal belongs to another application.");
      if (!p || p.revision!==input.expectedRevision || p.status!=="pending") fail(409,"Pending proposal changed.","revision-conflict");
      p.status="withdrawn";p.withdrawnAt=stamp();p.withdrawnBy=actor;p.withdrawalReason=input.reason;
      const [s,r]=keyParts(input.key);put("proposal",input.key,input.appId,p,s,r);put("proposal-history",crypto.randomUUID(),input.appId,{key:input.key,...p});
      audit(input.appId,actor,"proposal-withdrawn",{key:input.key,revision:p.revision});return {schemaVersion:"1",proposal:p};
    });
  }
  function setDecision(r,appId,actor,value,operationId=null) {
    const key=keyOf(r.source_id,r.record_id),old=projected(r).decision;
    const d={revision:old.revision+1,state:value.state,category:value.category,owner:value.owner===undefined?old.owner:value.owner,note:value.note,actor,at:stamp(),operationId,
      bodyHash:r.body_hash,admissionId:r.admission_id,receivedAt:r.received_at};
    put("decision",key,appId,d,r.source_id,r.record_id);put("decision-history",crypto.randomUUID(),appId,{key,...d});
    const p=row("proposal",key);
    if (p?.status==="pending") { p.status=operationId?"approved":"superseded";p.decidedAt=d.at;p.decidedBy=actor;put("proposal",key,appId,p,r.source_id,r.record_id);put("proposal-history",crypto.randomUUID(),appId,{key,...p}); }
    audit(appId,actor,operationId?"proposal-approved":"manual-decision",{key,revision:d.revision,operationId});
  }
  function decide(input,actor) {
    plain(input,["appId","key","expectedRevision","idempotencyKey","state","category","owner","note"],["appId","key","expectedRevision","idempotencyKey","state","category","note"]);
    disposition(input,false);integer(input.expectedRevision,"decision revision");if(input.owner!==undefined)text(input.owner,120,"owner",true);app(input.appId);
    return receipt("decision",input,actor,()=>{
      const r=requireAlert(input),a=projected(r);if(a.decision.revision!==input.expectedRevision)fail(409,"Decision revision changed.","revision-conflict");
      if ((a.severity==="critical" || groupSafety(r.group_id)) && !input.note.trim()) fail(400,"A reason is required for an explicit decision on critical or incomplete group evidence.");
      setDecision(r,input.appId,actor,input);return detail(input.appId,input.key);
    });
  }
  function group(input,actor) {
    plain(input,["appId","keys","label","idempotencyKey"],["appId","keys","label","idempotencyKey"]);app(input.appId);text(input.label,160,"group label");
    if(!Array.isArray(input.keys)||input.keys.length<2)fail(400,"A group needs at least two exact alert keys.");
    const keys=[...new Set(input.keys)];keys.forEach(keyParts);if(keys.length!==input.keys.length)fail(400,"Group keys must be distinct.");
    return receipt("group",input,actor,()=>{
      const id="group-"+crypto.randomUUID(),g={id,label:input.label,actor,createdAt:stamp(),revision:1};
      for(const key of keys){const r=requireAlert({appId:input.appId,key});if(r.group_id)fail(409,"An alert already belongs to a group.");
        db.prepare("INSERT INTO triage_members VALUES(?,?,?,?,?,?,?,?)").run(id,input.appId,r.source_id,r.record_id,r.body_hash,r.admission_id,r.received_at,Buffer.byteLength(key)+256);}
      put("group",id,input.appId,g);audit(input.appId,actor,"group-created",{groupId:id,members:keys.length});return {schemaVersion:"1",group:{...g,totalMembers:keys.length}};
    });
  }
  function operationView(op) { const {actor,...visible}=op;return {schemaVersion:"1",operation:{...visible,remaining:op.eligible-op.processed,canResume:op.status!=="completed" && op.eligible>op.processed}}; }
  function preview(input,actor) {
    plain(input,["appId","scope","keys","filters","idempotencyKey"],["appId","scope","filters","idempotencyKey"]);app(input.appId);actorId(actor);
    if(!["selected","matching"].includes(input.scope))fail(400,"Unknown approval scope.");
    const f=filters(input.filters);if(input.scope==="matching" && input.keys!==undefined)fail(400,"Matching approval does not accept selected keys.");
    let keys;if(input.scope==="selected"){if(!Array.isArray(input.keys)||!input.keys.length)fail(400,"Select at least one alert.");keys=[...new Set(input.keys)];keys.forEach(keyParts);}
    return receipt("preview",input,actor,()=>{
      const selected=selection(input.appId,f),id="approval-"+crypto.randomUUID();
      const op={id,appId:input.appId,actor,status:"preview",revision:0,snapshotAt:stamp(),scope:input.scope,filters:f,total:0,eligible:0,excluded:{critical:0,notPending:0,unavailable:0},
        approved:0,skipped:0,processed:0,byOutcome:{approved:0,changed:0,missing:0,critical:0,notPending:0,unavailable:0},proposedOutcomes:[],sources:[]};
      const outcomes=new Map(),sources=new Map(),groupResults=new Map();
      const add=r=>{
        const a=projected(r);let reason;
        if(a.proposal?.status==="expired")reason="unavailable";
        else if(!a.proposal||a.proposal.status!=="pending"||["closed","resolved"].includes(a.decision.state))reason="notPending";
        else if(!sameAdmission(r,a.proposal))reason="unavailable";
        else if(a.severity==="critical")reason="critical";
        else if(r.group_id){if(!groupResults.has(r.group_id))groupResults.set(r.group_id,groupSafety(r.group_id));reason=groupResults.get(r.group_id);}
        const frozen={key:a.key,bodyHash:r.body_hash,admissionId:r.admission_id,receivedAt:r.received_at,proposalRevision:a.proposal?.revision||0,decisionRevision:a.decision.revision,groupId:r.group_id,
          title:a.title,severity:a.severity,rule:a.rule,observedAt:a.observedAt,state:a.proposal?.state,category:a.proposal?.category,note:a.proposal?.note};
        const json=JSON.stringify(frozen);db.prepare("INSERT INTO triage_items VALUES(?,?,?,?,?,?,?)").run(id,op.total,r.source_id,r.record_id,json,reason||"pending",Buffer.byteLength(json)+256);
        op.total++;if(reason){op.excluded[reason]++;return;}op.eligible++;
        const code=JSON.stringify([a.proposal.state,a.proposal.category]);outcomes.set(code,(outcomes.get(code)||0)+1);sources.set(a.sourceId,(sources.get(a.sourceId)||0)+1);
      };
      if(keys){const lookup=db.prepare("SELECT * FROM ("+selected.sql+") WHERE source_id=? AND record_id=?");
        for(const key of keys){const r=lookup.get(...selected.args,...keyParts(key));if(!r)fail(403,"Every selected alert must belong to the exact application and filtered view.");add(r);}}
      else {
        // Do not keep a live SQLite iterator while mutating the same connection.
        // Keyset pages remain inside this snapshot transaction, so arrivals cannot join it.
        let cursor=null;
        while(true){
          const after=cursor ? " AND (source_id>? OR (source_id=? AND record_id>?))" : "";
          const args=cursor ? [...selected.args,cursor.source_id,cursor.source_id,cursor.record_id] : selected.args;
          const batch=db.prepare("SELECT * FROM ("+selected.sql+") WHERE json_extract(proposal_json,'$.status')='pending'"+after+" ORDER BY source_id,record_id LIMIT 250").all(...args);
          if(!batch.length)break;
          for(const r of batch)add(r);
          capacity();cursor=batch[batch.length-1];
        }
      }
      op.proposedOutcomes=[...outcomes].map(([k,count])=>{const[state,category]=JSON.parse(k);return{state,category,count};});op.sources=[...sources].map(([sourceId,count])=>({sourceId,count}));
      if(!op.eligible)op.status="completed";
      put("operation",id,input.appId,op);audit(input.appId,actor,"approval-preview",{operationId:id,total:op.total,eligible:op.eligible});return operationView(op);
    });
  }
  function ownedOperation(id,appId,actor){identifier(id,"operation");app(appId);actorId(actor);const op=row("operation",id);if(!op)fail(404,"Approval operation not found.");
    if(op.appId!==appId||op.actor!==actor)fail(403,"This operation belongs to a different application or operator.");return op;}
  function status(id,appId,actor){return operationView(ownedOperation(id,appId,actor));}
  function items(id,query,actor){
    plain(query,["appId","limit","offset"],["appId"]);const op=ownedOperation(id,query.appId,actor);
    const limit=query.limit===undefined?100:integer(query.limit,"limit",200),offset=query.offset===undefined?0:integer(query.offset,"offset",1000000);
    if(!limit)fail(400,"Limit must be positive.");
    const values=db.prepare("SELECT position,source_id,record_id,snapshot,outcome FROM triage_items WHERE operation_id=? ORDER BY position LIMIT ? OFFSET ?").all(id,limit,offset)
      .map(r=>({position:r.position,sourceId:r.source_id,recordId:r.record_id,...JSON.parse(r.snapshot),outcome:r.outcome}));
    return {schemaVersion:"1",operationId:id,items:values,page:{limit,offset,total:op.total,hasMore:offset+values.length<op.total,nextOffset:offset+values.length<op.total?offset+values.length:null}};
  }
  function step(id,input,actor){
    plain(input,["appId","revision"],["appId","revision"]);integer(input.revision,"operation revision");let committed=false;
    const result=transaction(()=>{
      const op=ownedOperation(id,input.appId,actor);
      if(input.revision>op.revision)fail(409,"Operation revision is ahead of saved progress.","revision-conflict");
      if(input.revision<op.revision||op.status==="completed")return operationView(op);
      const groupCache=new Map();
      for(const item of db.prepare("SELECT * FROM triage_items WHERE operation_id=? AND outcome='pending' ORDER BY position LIMIT 100").all(id)){
        const frozen=JSON.parse(item.snapshot),r=rawAlert(op.appId,frozen.key);let outcome;
        if(!r||!sameAdmission(r,frozen))outcome="missing";
        else {const a=projected(r);
          if(a.decision.revision!==frozen.decisionRevision||a.proposal?.revision!==frozen.proposalRevision||a.proposal?.status!=="pending"||r.group_id!==frozen.groupId)outcome="changed";
          else outcome=eligibility(r,groupCache);
        }
        if(!outcome){setDecision(r,op.appId,actor,frozen,id);outcome="approved";op.approved++;}else {
          op.skipped++;
          put("approval-item-history",crypto.randomUUID(),op.appId,{key:frozen.key,admissionId:frozen.admissionId,receivedAt:frozen.receivedAt,bodyHash:frozen.bodyHash,
            at:stamp(),actor,operationId:id,outcome},item.source_id,item.record_id);
        }
        db.prepare("UPDATE triage_items SET outcome=? WHERE operation_id=? AND position=?").run(outcome,id,item.position);op.byOutcome[outcome]++;op.processed++;
      }
      op.revision++;op.status=op.processed===op.eligible?"completed":"running";op.updatedAt=stamp();
      put("operation",id,op.appId,op);audit(op.appId,actor,"approval-step",{operationId:id,revision:op.revision,approved:op.approved,skipped:op.skipped,remaining:op.eligible-op.processed});
      fault?.("before-step-commit",{operationId:id,revision:op.revision});committed=true;return operationView(op);
    });
    if(committed)fault?.("after-step-commit",{operationId:id,revision:result.operation.revision});return result;
  }
  return {list,detail,evidence,history,inspection,propose,withdraw,decide,group,preview,status,items,step,capacity:()=>({bytes:Number(db.prepare("SELECT value FROM triage_meta WHERE key='bytes'").get().value),maxBytes:MAX_BYTES})};
}
async function handleTriage(request,response,url,service,actor,viewerId=null){
  response.setHeader("Cache-Control","no-store");const suffix=url.pathname.slice(BASE.length);
  function query(allowed){const q={};for(const[k,v]of url.searchParams){if(!allowed.includes(k)||Object.hasOwn(q,k))fail(400,"Invalid triage query.");q[k]=["limit","offset"].includes(k)?(/^(0|[1-9][0-9]*)$/.test(v)?Number(v):NaN):v;}return q;}
  if(request.method==="GET"){
    function read(result,maximum){const body={...result,viewerId};if(maximum&&Buffer.byteLength(JSON.stringify(body))>maximum)fail(503,"Triage read exceeds its response budget.","triage-read-unavailable");sendJson(response,200,body);}
    const inspectionReads={"/alert/evidence":["evidence",READ_LIMITS.evidence],"/alert/history":["history",READ_LIMITS.history],"/alert/inspection":["inspection",READ_LIMITS.inspection]};
    if(inspectionReads[suffix]){const[method,maximum]=inspectionReads[suffix];read(service[method](query(["appId","key","expectedVersion",...(method==="history"?["limit","cursor"]:[])])),maximum);return;}
    if(!suffix){read(service.list(query(["appId",...FILTERS,"limit","offset"])));return;}
    if(suffix==="/alert"){const q=query(["appId","key"]);read(service.detail(q.appId,q.key));return;}
    const detailMatch=/^\/approvals\/([A-Za-z0-9._:-]+)\/items$/.exec(suffix);
    if(detailMatch){read(service.items(detailMatch[1],query(["appId","limit","offset"]),actor));return;}
    const m=/^\/approvals\/([A-Za-z0-9._:-]+)$/.exec(suffix);
    if(m){const q=query(["appId"]);read(service.status(m[1],q.appId,actor));return;}fail(404,"Triage read endpoint not found.");
  }
  if(request.method!=="POST")fail(405,"Use GET or POST for triage.");if(url.search)fail(400,"Triage writes do not accept a query.");
  const {value}=await readJsonBody(request,16*1024*1024);
  const methods={"/proposals":"propose","/proposals/withdraw":"withdraw","/decisions":"decide","/groups":"group","/approvals/preview":"preview"};
  if(methods[suffix]){sendJson(response,200,service[methods[suffix]](value,actor));return;}
  const m=/^\/approvals\/([A-Za-z0-9._:-]+)\/step$/.exec(suffix);
  if(m){sendJson(response,200,service.step(m[1],value,actor));return;}fail(404,"Triage write endpoint not found.");
}
module.exports={createTriageService,handleTriage,TRIAGE_BASE:BASE,keyOf,MAX_TRIAGE_BYTES:MAX_BYTES,TRIAGE_READ_LIMITS:READ_LIMITS};
