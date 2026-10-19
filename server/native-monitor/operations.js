"use strict";
const crypto = require("node:crypto");
const {validateTimestamp}=require("../../tools/ingest-contract");
const ID=/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/;
function fail(message,status=400){throw Object.assign(new Error(message),{status});}
function text(v,name,max=1000){if(typeof v!=="string"||!v.trim()||v.length>max)fail(name+" is required and must be bounded");return v;}
function identifier(v,name){if(typeof v!=="string"||!ID.test(v))fail("invalid "+name);return v;}
function stamp(v,name){try{return Date.parse(validateTimestamp(v,name));}catch{fail("invalid "+name);}}
function digest(v){return crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex");}
function validateEmployees(employees,registry){
 if(!Array.isArray(employees)||employees.length>128||!registry||!Array.isArray(registry.HOSTS))fail("bounded employee and resource registries required");
 const seen=new Set();
 return employees.map(value=>{
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).some(key=>!["id","name","role","host","sourceId","cadenceSeconds"].includes(key)))fail("invalid employee registration");
  const id=identifier(value.id,"employee id"),host=identifier(value.host,"employee host"),sourceId=identifier(value.sourceId,"employee sourceId");
  const resource=registry.HOSTS.find(row=>row.id===host);
  if(seen.has(id)||!resource||resource.sourceId!==sourceId||id.length+host.length>178)fail("employee identity must be unique, bounded and bound to a registered resource source");
  seen.add(id);
  const cadenceSeconds=value.cadenceSeconds===undefined?86400:value.cadenceSeconds;
  if(!Number.isSafeInteger(cadenceSeconds)||cadenceSeconds<60||cadenceSeconds>31536000)fail("invalid employee cadence");
  return Object.freeze({id,host,sourceId,name:text(value.name,"employee name",120),role:text(value.role,"employee role",240),cadenceSeconds});
 });
}
function createOperations(db,{now=()=>Date.now(),registry={HOSTS:[],SERIES:[],CHECKS:[]},employees=[],beforeMutation=()=>{}}={}){
 if(typeof beforeMutation!=="function")fail("beforeMutation must be a function");
 const EMPLOYEES=validateEmployees(employees,registry);
 db.exec(`
 CREATE TABLE IF NOT EXISTS ops_work(id TEXT PRIMARY KEY,host TEXT NOT NULL,employee_id TEXT,body TEXT NOT NULL,revision INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS ops_jobs(id TEXT PRIMARY KEY,host TEXT NOT NULL,body TEXT NOT NULL,revision INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS ops_runs(id TEXT PRIMARY KEY,job_id TEXT NOT NULL,scheduled_for TEXT NOT NULL,attempt INTEGER NOT NULL DEFAULT 1,body TEXT NOT NULL,UNIQUE(job_id,scheduled_for,attempt));
 CREATE TABLE IF NOT EXISTS ops_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,entity_id TEXT NOT NULL,at TEXT NOT NULL,actor TEXT NOT NULL,body TEXT NOT NULL,prior_hash TEXT NOT NULL,hash TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS ops_actions(id TEXT PRIMARY KEY,work_id TEXT NOT NULL,host TEXT NOT NULL,body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS ops_receipts(id TEXT PRIMARY KEY,digest TEXT NOT NULL,response TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS ops_employee_registry(id TEXT PRIMARY KEY,host TEXT NOT NULL,source_id TEXT NOT NULL);
 `);
 db.exec("BEGIN IMMEDIATE");
 try {
  for(const employee of EMPLOYEES){
   const prior=db.prepare("SELECT host,source_id FROM ops_employee_registry WHERE id=?").get(employee.id);
   if(prior&&(prior.host!==employee.host||prior.source_id!==employee.sourceId))fail("employee resource/source identity is immutable; register a new employee identity",409);
   db.prepare("INSERT OR IGNORE INTO ops_employee_registry VALUES(?,?,?)").run(employee.id,employee.host,employee.sourceId);
  }
  db.exec("COMMIT");
 }catch(error){db.exec("ROLLBACK");throw error;}
 const scope=(host,hosts)=>{if(!registry.HOSTS.some(r=>r.id===host))fail("unknown resource",400);if(hosts && !hosts.includes(host))fail("resource outside selected estate",403);};
 const rows=(table,hosts)=>{
  const where=hosts?(hosts.length?" WHERE host IN ("+hosts.map(()=>"?").join(",")+")":" WHERE 0"):"";
  const raw=db.prepare("SELECT * FROM "+table+where+" ORDER BY json_extract(body,'$.updatedAt') DESC,id DESC LIMIT 1001").all(...(hosts||[]));
  const out=raw.slice(0,1000).map(r=>JSON.parse(r.body));out.truncated=raw.length>1000;return out;
 };
 const get=(table,id,hosts)=>{const r=db.prepare("SELECT * FROM "+table+" WHERE id=?").get(id);if(!r)fail("record not found",404);scope(r.host,hosts);return JSON.parse(r.body);};
 const save=(table,row)=>{db.prepare("INSERT INTO "+table+"(id,host,body,revision) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,revision=excluded.revision").run(row.id,row.host,JSON.stringify(row),row.revision);};
 const event=(entity,body)=>{const prior=db.prepare("SELECT hash FROM ops_events ORDER BY seq DESC LIMIT 1").get();const at=new Date(now()).toISOString(),id=crypto.randomUUID(),actor=body.actor||"unknown";const p=prior?prior.hash:"";const content=JSON.stringify({id,entity,at,actor,body});db.prepare("INSERT INTO ops_events(id,entity_id,at,actor,body,prior_hash,hash) VALUES(?,?,?,?,?,?,?)").run(id,entity,at,actor,content,p,digest(p+content));};
 const tx=(body,action)=>{
   const key=identifier(body.idempotencyKey,"idempotencyKey");
   const hash=digest(body);db.exec("BEGIN IMMEDIATE");
   try{const prior=db.prepare("SELECT * FROM ops_receipts WHERE id=?").get(key);if(prior){if(prior.digest!==hash)fail("idempotency key reused with different content",409);db.exec("COMMIT");return JSON.parse(prior.response);}
    beforeMutation();
    if(db.prepare("SELECT count(*) n FROM ops_receipts").get().n>=100000||db.prepare("SELECT count(*) n FROM ops_events").get().n>=200000)fail("operations evidence capacity reached; retained evidence is unchanged",507);
    const result=action();db.prepare("INSERT INTO ops_receipts VALUES(?,?,?)").run(key,hash,JSON.stringify(result));db.exec("COMMIT");return result;
   }catch(e){db.exec("ROLLBACK");throw e;}
 };
 function viewWork(row){
  const result={...row}; delete result.leaseToken;
  if(row.leaseUntil && Date.parse(row.leaseUntil)<now() && !["finished","cancelled"].includes(row.status)){
    result.leaseExpired=true;result.status=row.action && ["intent","running","uncertain"].includes(row.action.status)?"execution_uncertain":"lease_expired";
  }
  return result;
 }
 function checks(body,row){if(Number(body.expectedRevision)!==row.revision)fail("record revision changed",409);}
 function lease(body,row){if(body.leaseToken!==row.leaseToken||!row.leaseUntil||Date.parse(row.leaseUntil)<now())fail("valid current lease required",409);}
 const runtime=require("./operations-runtime").createRuntime(db,{now,scope,rows,get,save,event,fail,text,identifier,stamp,registry,employees:EMPLOYEES});
 const inbox=require("./employee-inbox").createEmployeeInbox(db,{now,employees:EMPLOYEES,scope,event,tx});
 return {conditions:runtime.conditions,conditionDefinitions:runtime.conditionDefinitions,route({method,path,query,body={},hosts=null}){

  const at=new Date(now()).toISOString();
  if(path.startsWith("/employee-inbox"))return inbox.route({method,path,query,body,hosts});
  if(method==="GET"&&["/employees","/jobs"].includes(path)&&query?.get("runId"))return {status:200,body:runtime.runDetail(path==="/employees"?"employee":"job",query.get("runId"),query.get("employeeId"),hosts)};
  if(method==="GET"&&path==="/employees"){
   const sourceWork=rows("ops_work",hosts),work=sourceWork.slice(0,100).map(viewWork).map(w=>({...w,reason:String(w.reason||"").slice(0,800),assessment:runtime.compact(w.assessment),action:runtime.compact(w.action,2000),verification:runtime.compact(w.verification,2000)}));
   return {status:200,body:{ok:true,asOf:at,truncated:sourceWork.truncated||sourceWork.length>100,limit:100,employees:EMPLOYEES.filter(e=>!hosts||hosts.includes(e.host)).map(e=>({...e,assignments:work.filter(w=>w.employeeId===e.id).map(w=>({id:w.id,host:w.host,status:w.status,updatedAt:w.updatedAt})),...runtime.employeeView(e,hosts),latestAssessment:work.filter(w=>w.employeeId===e.id&&w.assessment).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0]?.assessment||null,operatorInstructions:inbox.operatorInstructions(e.id,hosts)})),work,integration:{externalScheduler:"unverified; explicit runtime observations required",reports:"Durable report receipts with separate execution evidence",runtime:"Configured employee lifecycle observations; no execution is launched here"},note:"Assessments and command results do not set measured service health."}};
  }
  if(method==="GET"&&path==="/work"){const source=rows("ops_work",hosts);return {status:200,body:{ok:true,asOf:at,truncated:source.truncated,limit:1000,work:source.map(viewWork)}};}
  if(method==="GET"&&path==="/jobs"&&query?.has("history"))return {status:200,body:runtime.jobHistory(hosts,Object.fromEntries(query))};
  if(method==="GET"&&path==="/jobs")return {status:200,body:{ok:true,asOf:at,jobs:runtime.listJobs(hosts,{detail:query?.get("detail")||null})}};
  if(method==="POST"&&path==="/operations/ingest"){
   const host=identifier(body.host,"authenticated host");scope(host,hosts);
   const sourceId=identifier(body.sourceId,"authenticated sourceId");
   if(registry.HOSTS.find(row=>row.id===host)?.sourceId!==sourceId)fail("authenticated source does not own resource",403);
   const e=body.event;if(!e||typeof e!=="object"||e.schemaVersion!==1)fail("invalid operations envelope");
   if(Buffer.byteLength(JSON.stringify(e))>65536)fail("operations event exceeds limit",413);
   identifier(e.eventId,"eventId");if(e.eventId.length>96)fail("eventId exceeds96 characters");
   if((e.host&&e.host!==host)||(e.sourceId&&e.sourceId!==sourceId))fail("event identity differs from authenticated source",403);
   stamp(e.observedAt,"observedAt");
   if(e.employeeId){const employee=EMPLOYEES.find(row=>row.id===e.employeeId);if(e.jobId||!employee||employee.host!==host||employee.sourceId!==sourceId)fail("employee outside authenticated source",403);}
   else {const job=get("ops_jobs",identifier(e.jobId,"jobId"),[host]);if(job.host!==host)fail("job outside authenticated source",403);}
   const normalized={...e,host,actor:"source:"+sourceId,idempotencyKey:"host:"+host+":"+e.eventId};
   return {status:200,body:tx({idempotencyKey:normalized.idempotencyKey,operation:path,host,sourceId,event:e},()=>{if(e.employeeId)runtime.employeeEvent(normalized,[host],at);else runtime.jobEvent(normalized,[host],at);return {ok:true,eventId:e.eventId,receiptId:normalized.idempotencyKey};})};
  }
  if(method!=="POST"||!["/work","/work/claim","/work/events","/jobs","/jobs/events","/employees/events","/employees/import"].includes(path))return null;
  text(body.actor,"actor",200);
  const response=tx({...body,operation:path,scopeHosts:hosts?[...hosts].sort():null},()=>{
   if(path==="/work"){
    const id=identifier(body.id||crypto.randomUUID(),"id"),host=identifier(body.host,"host");scope(host,hosts);
    if(db.prepare("SELECT id FROM ops_work WHERE id=?").get(id))fail("assignment already exists",409);
    if(body.employeeId&&!EMPLOYEES.some(e=>e.id===body.employeeId&&e.host===host))fail("employee does not belong to assignment resource");
    if(db.prepare("SELECT count(*) n FROM ops_work").get().n>=10000)fail("assignment capacity reached",507);
    if(body.incidentId){
      const incident=db.prepare("SELECT id,host,status FROM incidents WHERE id=?").get(identifier(body.incidentId,"incidentId"));
      if(!incident||incident.host!==host)fail("incident does not belong to assignment host",400);
      if(body.incidentGeneration&&body.incidentGeneration!==incident.id)fail("incident generation changed",409);
      if(incident.status==="resolved")fail("incident is already resolved",409);
    }
    const row={id,host,incidentGeneration:body.incidentId||null,employeeId:body.employeeId||null,title:text(body.title,"title",240),reason:text(body.reason,"reason"),incidentId:body.incidentId||null,status:"queued",revision:1,createdAt:at,updatedAt:at,action:null,assessment:null,verification:null};
    save("ops_work",row);event(id,body);return {ok:true,work:row};
   }
   if(path==="/work/claim"){
    const row=get("ops_work",identifier(body.id,"id"),hosts);checks(body,row);
    if(["finished","cancelled"].includes(row.status))fail("assignment is terminal",409);
    if(row.action&&["intent","running","uncertain"].includes(row.action.status))fail("execution ownership unresolved; inspect the action before redispatch",409);
    if(row.leaseUntil&&Date.parse(row.leaseUntil)>=now())fail("assignment already leased",409);
    if(!EMPLOYEES.some(e=>e.id===body.employeeId&&e.host===row.host))fail("employee does not belong to assignment resource");
    row.employeeId=body.employeeId;row.leaseToken=crypto.randomUUID();row.leaseUntil=new Date(now()+120000).toISOString();row.status="investigating";row.updatedAt=at;row.revision++;
    save("ops_work",row);event(row.id,{...body,leaseToken:undefined});return {ok:true,work:row};
   }
   if(path==="/work/events"){
    const row=get("ops_work",identifier(body.id,"id"),hosts);checks(body,row);const kind=body.kind;
    // Reconciliation records what happened to an already issued command;
    // it never executes or silently repeats it.
    if(kind==="reconcile_action"){
      if(!row.action||!["intent","running","uncertain"].includes(row.action.status))fail("no unresolved action",409);
      if(!["succeeded","failed","not_started","still_running"].includes(body.outcome))fail("invalid action outcome");
      row.action={...row.action,status:body.outcome==="still_running"?"uncertain":body.outcome,evidence:text(body.evidence,"evidence",4000),reconciledAt:at};
      row.status=body.outcome==="still_running"?"execution_uncertain":"verifying";
    }else{
      lease(body,row);
      if(kind==="heartbeat"){row.leaseUntil=new Date(now()+120000).toISOString();}
      else if(kind==="assessment"){row.assessment={at,summary:text(body.summary,"summary",4000),evidence:text(body.evidence,"evidence",4000),author:row.employeeId};}
      else if(kind==="action_intent"){
       if(row.action&&["intent","running","uncertain"].includes(row.action.status))fail("action already unresolved",409);
       const actionId=identifier(body.actionId,"actionId");
       if(db.prepare("SELECT id FROM ops_actions WHERE id=?").get(actionId))fail("action identity has already been used",409);
       row.verification=null;
       row.action={id:actionId,status:"intent",intent:text(body.intent,"intent",2000),target:row.host,recordedAt:at};row.status="acting";
       db.prepare("INSERT INTO ops_actions(id,work_id,host,body) VALUES(?,?,?,?)").run(actionId,row.id,row.host,JSON.stringify(row.action));
      }else if(kind==="action_started"){
       if(!row.action||row.action.id!==body.actionId||row.action.status!=="intent")fail("matching action intent required",409);
       row.action={...row.action,status:"running",startedAt:at,executionRef:text(body.executionRef,"executionRef",500)};
      }else if(kind==="action_finished"){
       if(!row.action||row.action.id!==body.actionId||row.action.status!=="running")fail("matching running action required",409);
       if(!["succeeded","failed"].includes(body.outcome))fail("invalid command outcome");
       row.action={...row.action,status:body.outcome,finishedAt:at,evidence:text(body.evidence,"evidence",4000)};row.status="verifying";
      }else if(kind==="verification"){
       if(row.action&&["intent","running","uncertain"].includes(row.action.status))fail("resolve action execution before verification",409);
       if(body.outcome!==undefined&&!["verified","failed","unknown"].includes(body.outcome))fail("invalid verification outcome");
       row.verification={at,eventId:body.idempotencyKey,outcome:body.outcome||"unknown",actionId:row.action?row.action.id:null,evidence:text(body.evidence,"evidence",4000),result:text(body.result,"result",1000)};
      }else if(kind==="finish"){
       if(!row.verification)fail("verification evidence required",409);
       if(row.verification.outcome==="failed")fail("failed verification cannot finish assignment",409);
       if(row.action && (row.verification.actionId!==row.action.id || Date.parse(row.verification.at)<Date.parse(row.action.finishedAt||row.action.reconciledAt||row.action.recordedAt)))fail("verification after the latest action is required",409);
       if(row.action&&["intent","running","uncertain"].includes(row.action.status))fail("action remains unresolved",409);
       row.status="finished";row.leaseUntil=null;row.leaseToken=null;
      }else if(kind==="cancel"){
       if(row.action&&["intent","running","uncertain"].includes(row.action.status))fail("cancel does not stop an executing command; reconcile first",409);
       row.status="cancelled";row.leaseUntil=null;row.leaseToken=null;
      }else fail("unknown work event");
    }
    if(row.action)db.prepare("UPDATE ops_actions SET body=? WHERE id=? AND work_id=?").run(JSON.stringify(row.action),row.action.id,row.id);
    row.updatedAt=at;row.revision++;save("ops_work",row);event(row.id,{...body,leaseToken:undefined});return {ok:true,work:viewWork(row)};
   }
   if(path==="/jobs")return runtime.registerJob(body,hosts,at);
   if(path==="/employees/events"||path==="/employees/import")return runtime.employeeEvent(body,hosts,at);
   if(body.kind==="reconcile")return runtime.reconcileJob(body,hosts,at);
   return runtime.jobEvent(body,hosts,at);
  });
  return {status:200,body:response};
 }};
}
module.exports={createOperations,validateEmployees};
