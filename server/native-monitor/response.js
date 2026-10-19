"use strict";
const crypto = require("node:crypto");
const sha = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const decode = (value, fallback = {}) => { try { return JSON.parse(value); } catch { return fallback; } };
const MINUTE = 60000, RECURRENCE_MS = 30 * MINUTE;
function problem(status, message) { const error = new Error(message); error.status = status; return error; }
const plain = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const bounded = (value, size) => typeof value === "string" && value.length > 0 && value.length <= size;
const NOTICE_TYPES = new Set(["opened", "updated", "reminder", "prolonged", "dependency-released",
  "maintenance-ended", "action-failed", "verification-failed", "resolved"]);
class IncidentResponse {
  constructor(store) {
    this.store = store; this.db = store.db;
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS incident_lifecycle (incident_id TEXT PRIMARY KEY,episode_id TEXT NOT NULL,generation INTEGER NOT NULL,previous_incident_id TEXT,metadata TEXT NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS operational_checks (id TEXT PRIMARY KEY,host TEXT NOT NULL,definition TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1);" +
      "CREATE TABLE IF NOT EXISTS notification_snapshots (event_id TEXT PRIMARY KEY,incident_id TEXT NOT NULL,generation TEXT NOT NULL,created_at INTEGER NOT NULL,value TEXT NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS notification_deliveries (id TEXT PRIMARY KEY,event_id TEXT NOT NULL,incident_id TEXT NOT NULL,generation TEXT NOT NULL,host TEXT NOT NULL,destination TEXT NOT NULL,role TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,admitted_at INTEGER,attempted_at INTEGER,accepted_at INTEGER,provider_id TEXT,provider_attempt_id TEXT,provider_key TEXT,value TEXT NOT NULL,UNIQUE(event_id,destination));" +
      "CREATE INDEX IF NOT EXISTS notification_incident_destination ON notification_deliveries(incident_id,destination,state);"
    );
    for (const row of this.db.prepare("SELECT definition FROM operational_checks WHERE active=1").all()) {
      const def = decode(row.definition, null); if (def && this.store.hostMap.has(def.host)) this.installDefinition(def);
    }
    // Older incidents retain their original identity. Existing forwarded events
    // are never reconstructed into recipient claims that were not recorded.
    for (const row of this.db.prepare("SELECT * FROM incidents WHERE id NOT IN (SELECT incident_id FROM incident_lifecycle)").all()) {
      this.db.prepare("INSERT INTO incident_lifecycle VALUES(?,?,?,?,?)").run(row.id, row.id, 1, null,
        JSON.stringify({ legacy: true, reminderStage: -1, prolongedEmitted: false, parentIncidentId: null, maintenance: false }));
    }
  }
  installDefinition(definition) {
    const old = this.store.checkMap.get(definition.id);
    if (old) this.store.checks = this.store.checks.filter((row) => row.id !== definition.id);
    this.store.checks.push(definition); this.store.checkMap.set(definition.id, definition);
  }
  lifecycle(id) {
    const row = this.db.prepare("SELECT * FROM incident_lifecycle WHERE incident_id=?").get(id);
    return row ? Object.assign({ episodeId: row.episode_id, generation: row.generation,
      previousIncidentId: row.previous_incident_id }, decode(row.metadata)) : null;
  }
  save(id, lifecycle) {
    const { episodeId, generation, previousIncidentId, ...metadata } = lifecycle;
    this.db.prepare("UPDATE incident_lifecycle SET metadata=? WHERE incident_id=?").run(JSON.stringify(metadata), id);
  }
  opened(row) {
    const prior = this.db.prepare("SELECT * FROM incidents WHERE check_id=? AND status='resolved' AND id<>? ORDER BY resolved_at DESC,opened_at DESC LIMIT 1").get(row.check_id, row.id);
    const recurs = !!(prior && row.opened_at >= prior.resolved_at && row.opened_at - prior.resolved_at <= RECURRENCE_MS);
    const previous = recurs ? this.lifecycle(prior.id) : null;
    this.db.prepare("INSERT INTO incident_lifecycle VALUES(?,?,?,?,?)").run(row.id,
      previous ? previous.episodeId : row.id, previous ? previous.generation + 1 : 1,
      recurs ? prior.id : null, JSON.stringify({ legacy: false, recurrence: recurs,
        recurrenceWindowMs: RECURRENCE_MS, reminderStage: -1, prolongedEmitted: false,
        parentIncidentId: null, maintenance: false }));
  }
  parent(row) {
    const definition = this.store.checkMap.get(row.check_id) || decode(row.evidence).definition;
    for (const dependency of definition && definition.dependencies || []) {
      const parent = this.db.prepare("SELECT id,check_id,severity FROM incidents WHERE check_id=? AND status='open' AND id<>?").get(dependency.checkId, row.id);
      if (parent) return { incidentId: parent.id, checkId: parent.check_id, reason: dependency.reason,
        relationship: "declared dependency; correlation does not establish causation" };
    }
    return null;
  }
  eligibility(event) {
    const row = event.incidentId && this.db.prepare("SELECT * FROM incidents WHERE id=?").get(event.incidentId);
    if (!row) return { eligible: false, reason: "incident-unavailable" };
    if (!NOTICE_TYPES.has(event.type)) return { eligible: false, reason: "evidence-only" };
    if (event.type !== "resolved" && row.status !== "open") return { eligible: false, reason: "incident-resolved" };
    if (event.type === "resolved" && row.status !== "resolved") return { eligible: false, reason: "recovery-not-confirmed" };
    if (!this.store.checkMap.has(row.check_id)) return { eligible:false, reason:"configuration-inactive" };
    if (event.type === "reminder" && row.acknowledged_at) return { eligible: false, reason: "generation-acknowledged" };
    if (this.store.isMaintenance(row.host, row.check_id)) return { eligible: false, reason: "maintenance" };
    const parent = event.type === "resolved" ? null : this.parent(row);
    if (parent) return { eligible: false, reason: "dependency-correlated", parent };
    return { eligible: true, reason: this.store.notifications ? "eligible" : "shadow-mode" };
  }
  eventMetadata(event) {
    const lifecycle = event.incidentId && this.lifecycle(event.incidentId);
    const decision = this.eligibility(event);
    return { responseVersion: 1, generation: event.incidentId, episodeId: lifecycle && lifecycle.episodeId,
      generationNumber: lifecycle && lifecycle.generation, previousIncidentId: lifecycle && lifecycle.previousIncidentId,
      notificationIntent: NOTICE_TYPES.has(event.type), notificationDecision: decision,
      notify: this.store.notifications && decision.eligible };
  }
  tickInsideTransaction() {
    const now = this.store.now();
    for (const row of this.db.prepare("SELECT * FROM incidents WHERE status='open' ORDER BY opened_at,id").all()) {
      const meta = this.lifecycle(row.id); if (!meta) continue;
      if(!this.store.checkMap.has(row.check_id)) continue;
      const parent = this.parent(row), parentId = parent && parent.incidentId;
      if ((meta.parentIncidentId || null) !== (parentId || null)) {
        const old = meta.parentIncidentId; meta.parentIncidentId = parentId || null;
        this.store.queueEvent(row.id,row.host,parent ? "correlated" : "dependency-released",row.severity,now,
          parent ? "Operational notification correlated with declared prerequisite: " + parent.checkId
            : "Declared prerequisite incident cleared; this condition remains open",
          { parent, previousParentIncidentId: old || null, measuredStateUnchanged: true });
      }
      const maintenance = this.store.isMaintenance(row.host,row.check_id);
      if (meta.maintenance && !maintenance) this.store.queueEvent(row.id,row.host,"maintenance-ended",row.severity,now,
        "Maintenance ended; this measured condition remains open", { checkId: row.check_id });
      meta.maintenance = maintenance;
      if (!parent && !maintenance) {
        const def = this.store.checkMap.get(row.check_id) || {};
        const policy = def.notificationPolicy || { reminderSeconds: [900,3600,14400], prolongedAfterSeconds:14400 };
        const age = now - row.opened_at;
        const due = (policy.reminderSeconds || []).reduce((last, seconds, i) => age >= seconds * 1000 ? i : last,-1);
        const prolonged = Number.isFinite(policy.prolongedAfterSeconds) && age >= policy.prolongedAfterSeconds * 1000;
        // Emit one latest due notice after a pause, never a burst of catch-up reminders.
        if (prolonged && !meta.prolongedEmitted) {
          meta.prolongedEmitted = true; meta.reminderStage = Math.max(meta.reminderStage,due);
          this.store.queueEvent(row.id,row.host,"prolonged",row.severity,now,
            "Configured prolonged-outage notice: " + row.summary,
            { openedAt:row.opened_at,ageMs:age,acknowledgedAt:row.acknowledged_at,policy });
        } else if (!row.acknowledged_at && due > meta.reminderStage) {
          meta.reminderStage = due;
          this.store.queueEvent(row.id,row.host,"reminder",row.severity,now,
            "Unacknowledged operational condition remains open: " + row.summary,
            { openedAt:row.opened_at,ageMs:age,reminderSeconds:policy.reminderSeconds[due] });
        }
      }
      this.save(row.id,meta);
    }
  }
  tick() { return this.store.transaction(() => this.tickInsideTransaction()); }

  dependencies(hosts) {
    const selected=this.store.hostsFilter(hosts);
    return {ok:true,at:this.store.now(),dependencies:this.store.checks
      .filter(d=>!selected||selected.includes(d.host)).flatMap(d=>(d.dependencies||[]).map(dep=>{
        const open=this.db.prepare("SELECT id FROM incidents WHERE check_id=? AND status='open'").get(dep.checkId);
        return {checkId:d.id,host:d.host,prerequisiteCheckId:dep.checkId,reason:dep.reason,
          parentIncidentId:open&&open.id||null,relationship:"declared dependency; not proof of causation"};
      }))};
  }
  delivery(row) {
    return Object.assign(decode(row.value),{id:row.id,eventId:row.event_id,incidentId:row.incident_id,
      generation:row.generation,host:row.host,destination:row.destination,role:row.role,state:row.state,
      createdAt:row.created_at,updatedAt:row.updated_at,admittedAt:row.admitted_at,
      attemptedAt:row.attempted_at,acceptedAt:row.accepted_at,providerId:row.provider_id,
      providerAttemptId:row.provider_attempt_id,providerKey:row.provider_key});
  }
  ledger(hosts,options={}) {
    const scope=this.store.scope(hosts),values=[...scope.values];
    let filter="WHERE 1=1"+scope.sql;
    if(options.incidentId) {if(!bounded(options.incidentId,100))throw problem(400,"invalid incidentId");filter+=" AND incident_id=?";values.push(options.incidentId);}
    const limit=Math.max(1,Math.min(500,Number(options.limit)||100));
    const rows=this.db.prepare("SELECT * FROM notification_deliveries "+filter+" ORDER BY created_at DESC,id DESC LIMIT ?").all(...values,limit+1);
    // Do not expose full frozen message bodies on list pages; delivery evidence
    // is available without repeating possibly sensitive incident details.
    const deliveries=rows.slice(0,limit).map(r=>{const d=this.delivery(r);delete d.text;delete d.subject;return d;});
    return {ok:true,at:this.store.now(),notificationEnabled:this.store.notifications,deliveries,truncated:rows.length>limit};
  }
  prepare(eventId,destinations,hosts) {
    const eventRow=this.store.scopedEvent(eventId,hosts),event=decode(eventRow.event);
    if(!Array.isArray(destinations)||destinations.length>500||destinations.some(d=>typeof d!=="string"||d.length>320||!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(d)))throw problem(400,"canonical notification destinations required");
    return this.store.transaction(()=>{
      const prior=this.db.prepare("SELECT value FROM notification_snapshots WHERE event_id=?").get(eventId);
      if(prior)return {...decode(prior.value),replay:true,deliveries:this.db.prepare("SELECT * FROM notification_deliveries WHERE event_id=? ORDER BY destination").all(eventId).map(r=>this.delivery(r))};
      if(!this.store.notifications)return {ok:true,eligible:false,reason:"shadow-mode",deliveries:[]};
      if(eventRow.delivered_at)return {ok:true,eligible:false,reason:"already-forwarded",deliveries:[]};
      if(eventRow.attempted_at&&event.responseVersion!==1) {
        // A legacy bridge may have committed console admission before crashing.
        // Its recipients are unproven; do not synthesize or repeat that send.
        this.db.prepare("UPDATE outbox SET delivered_at=?,outcome=? WHERE id=?").run(this.store.now(),"legacy-handoff-requires-reconciliation",eventId);
        return {ok:true,eligible:false,reason:"legacy-handoff-requires-reconciliation",deliveries:[]};
      }
      const decision=this.eligibility(event);
      if(!decision.eligible){
        if(event.type!=="resolved")this.db.prepare("UPDATE outbox SET superseded_at=COALESCE(superseded_at,?),outcome=COALESCE(outcome,?) WHERE id=?").run(this.store.now(),"notification-inhibited:"+decision.reason,eventId);
        return {ok:true,...decision,deliveries:[]};
      }
      let selected=[...new Set(destinations)].sort();
      if(event.type==="resolved") {
        const waiting=this.db.prepare("SELECT id FROM notification_deliveries WHERE incident_id=? AND role='opening' AND attempted_at IS NULL AND state NOT IN ('cancelled','accepted') LIMIT 1").get(event.incidentId);
        if(waiting)return {ok:true,eligible:false,reason:"opening-provider-state-pending",deliveries:[]};
        selected=this.db.prepare("SELECT DISTINCT destination FROM notification_deliveries WHERE incident_id=? AND role='opening' AND attempted_at IS NOT NULL ORDER BY destination").all(event.incidentId).map(r=>r.destination);
      }
      const snapshot={ok:true,eligible:true,reason:selected.length?"prepared":event.type==="resolved"?"no-opening-recipients":"no-configured-recipients",eventId,incidentId:event.incidentId,generation:event.incidentId,destinations:selected,createdAt:this.store.now()};
      this.db.prepare("INSERT INTO notification_snapshots VALUES(?,?,?,?,?)").run(eventId,event.incidentId,event.incidentId,this.store.now(),JSON.stringify(snapshot));
      for(const destination of selected) {
        const previous=this.db.prepare("SELECT id FROM notification_deliveries WHERE incident_id=? AND destination=? AND role='opening' AND attempted_at IS NOT NULL LIMIT 1").get(event.incidentId,destination);
        const role=event.type==="resolved"?"recovery":previous?"update":"opening";
        const id=sha(["native-notification",eventId,event.incidentId,destination]);
        const at=new Date(event.at).toISOString();
        const subject=("[BB SOC "+(event.type==="resolved"?"recovered":event.severity)+"] "+String(event.summary)).slice(0,450);
        const text=String(event.summary).slice(0,10000)+"\n\nObserved: "+at+"\nIncident generation: "+event.incidentId+
          "\nEvent: "+event.type+"\n\nMeasured operational evidence: #/incidents?incident="+encodeURIComponent(event.incidentId)+
          "\nThis records a monitoring observation; employee assessments are separate evidence.\n";
        const value={subject,text,severity:event.severity,at:event.at,type:event.type,openingDeliveryId:previous&&previous.id||null};
        this.db.prepare("INSERT INTO notification_deliveries(id,event_id,incident_id,generation,host,destination,role,state,created_at,updated_at,value) VALUES(?,?,?,?,?,?,?,'prepared',?,?,?)")
          .run(id,eventId,event.incidentId,event.incidentId,event.host,destination,role,this.store.now(),this.store.now(),JSON.stringify(value));
      }
      return {...snapshot,deliveries:this.db.prepare("SELECT * FROM notification_deliveries WHERE event_id=? ORDER BY destination").all(eventId).map(r=>this.delivery(r))};
    });
  }
  deliveryEligibility(id,hosts) {
    const row=this.db.prepare("SELECT * FROM notification_deliveries WHERE id=?").get(id);
    if(!row)throw problem(404,"notification delivery not found");
    const selected=this.store.hostsFilter(hosts);if(selected&&!selected.includes(row.host))throw problem(403,"notification outside host scope");
    if(row.attempted_at)return {ok:true,eligible:true,reason:"provider-obligation-already-attempted"};
    if(["cancelled","accepted"].includes(row.state))return {ok:true,eligible:false,terminal:true,reason:"delivery-"+row.state};
    const event=this.store.scopedEvent(row.event_id,hosts);
    const decision=this.eligibility(decode(event.event));
    if(!this.store.notifications)return {ok:true,eligible:false,terminal:false,reason:"shadow-mode"};
    const kind=decode(event.event).type;
    return {ok:true,...decision,terminal:!decision.eligible&&(
      ["incident-resolved","generation-acknowledged","configuration-inactive"].includes(decision.reason)||
      kind!=="resolved"&&["maintenance","dependency-correlated"].includes(decision.reason))};
  }
  receipt(input,hosts) {
    if(!plain(input)||!/^[a-f0-9]{64}$/.test(input.deliveryId||"")||!["admitted","ready","in-flight","retryable","accepted","needs-reconciliation","cancelled"].includes(input.phase))throw problem(400,"invalid notification receipt");
    const row=this.db.prepare("SELECT * FROM notification_deliveries WHERE id=?").get(input.deliveryId);
    if(!row)throw problem(404,"notification delivery not found");
    const selected=this.store.hostsFilter(hosts);if(selected&&!selected.includes(row.host))throw problem(403,"notification outside host scope");
    const attempted=input.firstRequestAt===null||input.firstRequestAt===undefined?null:Date.parse(input.firstRequestAt);
    const providerObservedAt=input.updatedAt===undefined?this.store.now():Date.parse(input.updatedAt);
    if(!Number.isFinite(providerObservedAt)||providerObservedAt>this.store.now()+30000)throw problem(400,"invalid provider receipt observation time");
    if(attempted!==null&&(!Number.isFinite(attempted)||attempted>this.store.now()+30000))throw problem(400,"invalid provider attempt time");
    if(input.attemptId!==undefined&&input.attemptId!==null&&!/^provider-attempt-[a-f0-9]{32}$/.test(input.attemptId))throw problem(400,"invalid provider attempt identity");
    if(input.providerKey!==undefined&&input.providerKey!==null&&!/^bb-soc-alert-v2-[a-f0-9]{64}$/.test(input.providerKey))throw problem(400,"invalid provider idempotency key");
    if(input.providerId!==undefined&&input.providerId!==null&&!bounded(input.providerId,200))throw problem(400,"invalid provider acceptance identity");
    if(["in-flight","retryable","accepted"].includes(input.phase)&&attempted===null)throw problem(400,"provider boundary evidence required");
    if(input.phase==="accepted"&&!input.providerId)throw problem(400,"provider acceptance identity required");
    if(input.phase==="cancelled"&&(row.attempted_at||attempted))throw problem(409,"uncertain provider obligation cannot be cancelled");
    const final=["accepted","cancelled"].includes(row.state);
    if(final&&input.phase!==row.state)return {ok:true,deliveryId:row.id,replay:true,state:row.state};
    // At-least-once bridge snapshots can arrive after a later phase. Never
    // erase provider-boundary evidence or downgrade a parked uncertain state.
    const rank={prepared:0,admitted:1,ready:2,"in-flight":3,retryable:3,"needs-reconciliation":4,accepted:5,cancelled:5};
    const state=rank[input.phase]<rank[row.state]?row.state:input.phase;
    this.db.prepare("UPDATE notification_deliveries SET state=?,updated_at=?,admitted_at=COALESCE(admitted_at,?),attempted_at=COALESCE(attempted_at,?),accepted_at=COALESCE(accepted_at,?),provider_id=COALESCE(?,provider_id),provider_attempt_id=COALESCE(?,provider_attempt_id),provider_key=COALESCE(?,provider_key) WHERE id=?")
      .run(state,this.store.now(),this.store.now(),attempted,input.phase==="accepted"?providerObservedAt:null,input.providerId||null,input.attemptId||null,input.providerKey||null,row.id);
    return {ok:true,deliveryId:row.id,state};
  }

  reconcileConditions(conditions, definitions) {
    if (!Array.isArray(conditions) || !Array.isArray(definitions) || conditions.length > 2000 || definitions.length > 2000) throw problem(400,"bounded registered operational conditions required");
    const defs = new Map();
    for (const raw of definitions) {
      if (!plain(raw) || !bounded(raw.id,200) || !raw.id.startsWith("operations.") || !this.store.hostMap.has(raw.host) ||
          !bounded(raw.label,200) || raw.type !== "operation" || !Number.isSafeInteger(raw.intervalSeconds) ||
          raw.intervalSeconds < 10 || raw.intervalSeconds > 86400 || defs.has(raw.id)) throw problem(400,"invalid registered operational definition");
      const dependencies = raw.dependencies || [];
      if (!Array.isArray(dependencies) || dependencies.length > 10 || dependencies.some((d) =>
          !plain(d) || !this.store.checkMap.has(d.checkId) || this.store.checkMap.get(d.checkId).host !== raw.host || this.store.checkMap.get(d.checkId).type === "operation" || !bounded(d.reason,300))) throw problem(400,"invalid operational dependency");
      defs.set(raw.id,Object.assign({},raw,{policy:{failCount:1,recoverCount:1},notificationEnabled:false}));
    }
    const found = new Map();
    for (const condition of conditions) {
      if (!plain(condition) || !defs.has(condition.checkId) || condition.host !== defs.get(condition.checkId).host ||
          !["healthy","warning","critical","unknown"].includes(condition.status) || !bounded(condition.summary,2000) ||
          !Number.isSafeInteger(condition.observedAt) || condition.observedAt > this.store.now()+30000 ||
          !plain(condition.evidence || {}) || Buffer.byteLength(JSON.stringify(condition.evidence || {})) > 24000 || found.has(condition.checkId)) throw problem(400,"invalid or unregistered operational condition");
      found.set(condition.checkId,condition);
    }
    const previousChecks=this.store.checks.slice(),previousMap=new Map(this.store.checkMap);
    try { return this.store.transaction(() => {
      const active = new Set(defs.keys());
      for (const old of this.db.prepare("SELECT id FROM operational_checks WHERE active=1").all()) if (!active.has(old.id)) {
        this.db.prepare("UPDATE operational_checks SET active=0 WHERE id=?").run(old.id);
        this.store.checks=this.store.checks.filter((d)=>d.id!==old.id);this.store.checkMap.delete(old.id);
      }
      for (const def of defs.values()) {
        this.db.prepare("INSERT INTO operational_checks VALUES(?,?,?,1) ON CONFLICT(id) DO UPDATE SET host=excluded.host,definition=excluded.definition,active=1").run(def.id,def.host,JSON.stringify(def));
        this.installDefinition(def);
        const value=found.get(def.id), now=this.store.now();
        const stale=!value || now-value.observedAt>Math.max(def.intervalSeconds*3000,60000);
        const result=stale ? {status:"unknown",summary:"Configured operational condition has no current observation"} : value;
        const at=value && !stale ? value.observedAt : now;
        const priorState=this.db.prepare("SELECT value FROM check_state WHERE id=?").get(def.id);
        if(priorState&&decode(priorState.value).lastObservedAt>at)continue;
        const priorIncident=this.db.prepare("SELECT id FROM incidents WHERE check_id=? AND status='open'").get(def.id);
        this.store.evaluate(def,result,at,{bootId:"configured-operation",configRevision:sha(def),collectorVersion:"operations-1"},
          {receiptId:null,batchId:null,operationalEvidence:value ? value.evidence : null});
        const evidence=value&&value.evidence||{};
        const failures=Array.isArray(evidence.failureNotices)?evidence.failureNotices.slice(0,20):[evidence.failureNotice].filter(Boolean);
        for(const failure of failures) if(priorIncident&&!stale&&failure&&["action-failed","verification-failed"].includes(failure.type)&&bounded(failure.id,200)) {
          const meta=this.lifecycle(priorIncident.id),key=sha([failure.type,failure.id]);
          meta.failureNotices=meta.failureNotices||{};
          if(!meta.failureNotices[key]){
            this.store.queueEvent(priorIncident.id,def.host,failure.type,result.status==="critical"?"critical":"warning",at,
              result.summary,{failureNotice:failure,operationalEvidence:value.evidence});
            meta.failureNotices[key]=at;
            // Each work condition has its own lifecycle; bound evidence indexing
            // without deleting the immutable events themselves.
            const keys=Object.keys(meta.failureNotices);
            if(keys.length>1000)delete meta.failureNotices[keys[0]];
            this.save(priorIncident.id,meta);
          }
        }
      }
      this.tickInsideTransaction();
      return {ok:true,definitions:defs.size,conditions:found.size,at:this.store.now()};
    }); } catch(error){this.store.checks=previousChecks;this.store.checkMap=previousMap;throw error;}
  }
}
module.exports={IncidentResponse,NOTICE_TYPES,RECURRENCE_MS};
