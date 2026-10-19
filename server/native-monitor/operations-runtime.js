"use strict";
function createRuntime(db,c){
 const {now,scope,rows,get,save,event,fail,text,identifier,stamp,registry,employees}=c;
 const META=Object.fromEntries(employees.map(employee=>[employee.id,employee]));
 db.exec("CREATE TABLE IF NOT EXISTS ops_employee_runs(id TEXT PRIMARY KEY,employee_id TEXT NOT NULL,host TEXT NOT NULL,observed_at TEXT NOT NULL,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS ops_employee_outputs(id TEXT PRIMARY KEY,employee_id TEXT NOT NULL,host TEXT NOT NULL,observed_at TEXT NOT NULL,body TEXT NOT NULL);");
 db.exec("CREATE INDEX IF NOT EXISTS ops_runs_job_recorded ON ops_runs(job_id); CREATE INDEX IF NOT EXISTS ops_runs_job_event ON ops_runs(job_id,json_extract(body,'$.lastEventAt')); CREATE INDEX IF NOT EXISTS ops_employee_runs_employee_time ON ops_employee_runs(employee_id,observed_at); CREATE INDEX IF NOT EXISTS ops_employee_outputs_employee_time ON ops_employee_outputs(employee_id,observed_at);");
 db.exec("CREATE INDEX IF NOT EXISTS ops_runs_unlinked_start ON ops_runs(job_id,CAST(strftime('%s',json_extract(body,'$.startedAt')) AS INTEGER)) WHERE json_extract(body,'$.scheduledFor') IS NULL; CREATE INDEX IF NOT EXISTS ops_runs_unlinked_finish ON ops_runs(job_id,CAST(strftime('%s',json_extract(body,'$.finishedAt')) AS INTEGER)) WHERE json_extract(body,'$.scheduledFor') IS NULL; CREATE INDEX IF NOT EXISTS ops_runs_active ON ops_runs(job_id,json_extract(body,'$.startedAt')) WHERE json_extract(body,'$.status')='running'; CREATE INDEX IF NOT EXISTS ops_employee_active ON ops_employee_runs(employee_id,host,observed_at) WHERE json_extract(body,'$.status')='running';");
 function bounded(v,name,max=16000){if(v===undefined)return null;if(Buffer.byteLength(JSON.stringify(v))>max)fail(name+" exceeds limit");return v;}
 function time(v,name,optional=false){if(optional&&v==null)return null;stamp(v,name);return new Date(v).toISOString();}
 function observed(body){const value=time(body.observedAt,"observedAt");if(Date.parse(value)>now()+30000)fail("event clock is in the future");return value;}
 function seconds(value,name,min,max,fallback){const n=Number(value??fallback);if(!Number.isSafeInteger(n)||n<min||n>max)fail("invalid "+name);return n;}
 function schedule(body,old){
  const raw=body.schedule||{kind:"interval",intervalSeconds:body.intervalSeconds,timeZone:"UTC",anchorAt:body.nextDueAt};
  if(!["calendar","interval","observed"].includes(raw.kind))fail("invalid schedule kind");
  const zone=raw.timeZone||"UTC";try{new Intl.DateTimeFormat("en-US",{timeZone:zone}).format();}catch{fail("invalid schedule timeZone");}
  const s={kind:raw.kind,timeZone:zone,source:text(raw.source||"owner-registration","schedule source",200)};
  if(raw.kind==="calendar")s.calendar=text(raw.calendar,"calendar",500);
  if(raw.kind==="interval"){s.intervalSeconds=seconds(raw.intervalSeconds,"intervalSeconds",60,366*86400);s.anchorAt=time(raw.anchorAt||body.nextDueAt||old?.schedule?.anchorAt,"anchorAt");}
  return s;
 }
 function registerJob(body,hosts,at){
  const id=identifier(body.id,"id"),host=identifier(body.host,"host");scope(host,hosts);
  const p=db.prepare("SELECT body FROM ops_jobs WHERE id=?").get(id),old=p?JSON.parse(p.body):null;
  if(old){scope(old.host,hosts);if(Number(body.expectedRevision)!==old.revision)fail("record revision changed",409);if(old.host!==host)fail("job resource identity is immutable");}
  if(!old&&db.prepare("SELECT count(*) n FROM ops_jobs").get().n>=128)fail("job registry capacity reached",409);
  const s=schedule(body,old);
  const row={...old,id,host,label:text(body.label,"label",240),schedule:s,intervalSeconds:s.intervalSeconds||null,timeZone:s.timeZone,
   nextDueAt:time(body.nextDueAt??old?.nextDueAt??null,"nextDueAt",true),
   graceSeconds:seconds(body.graceSeconds,"graceSeconds",0,86400,300),
   maxRuntimeSeconds:seconds(body.maxRuntimeSeconds,"maxRuntimeSeconds",30,30*86400,3600),
   progressTimeoutSeconds:seconds(body.progressTimeoutSeconds,"progressTimeoutSeconds",30,86400,180),
   observationTimeoutSeconds:seconds(body.observationTimeoutSeconds,"observationTimeoutSeconds",60,86400,300),
   schedulerRef:bounded(body.schedulerRef||null,"schedulerRef",2000),expectationConfigured:true,
   createdAt:old?.createdAt||at,expectedSlots:old?.expectedSlots||[],revision:old?old.revision+1:1,updatedAt:at};
  save("ops_jobs",row);event(id,body);return {ok:true,job:row};
 }
 function reconcileJob(body,hosts,at){
  const job=get("ops_jobs",identifier(body.jobId,"jobId"),hosts),runId=identifier(body.runId,"runId");
  const found=db.prepare("SELECT body FROM ops_runs WHERE id=?").get(runId);
  if(!found)fail("run not found",404);const run=JSON.parse(found.body);
  if(run.jobId!==job.id)fail("matching run required",409);
  if(Number(body.expectedRevision)!==run.revision)fail("run revision changed",409);
  if(!["succeeded","failed","still_running"].includes(body.outcome))fail("invalid reconciliation outcome");
  const o=observed(body);if(Date.parse(o)<Date.parse(run.lastEventAt))fail("reconciliation predates source evidence",409);
  const proof=text(body.evidence,"reconciliation evidence",4000);
  run.reconciliations=[...(run.reconciliations||[]),{observedAt:o,receivedAt:at,actor:body.actor,priorStatus:run.status,outcome:body.outcome,evidence:proof}].slice(-20);
  run.reportedStatus=run.reportedStatus||run.status;
  run.status=body.outcome==="still_running"?"running":body.outcome;
  if(body.outcome==="still_running"){run.finishedAt=null;run.lastProgressAt=o;}
  else {run.finishedAt=o;run.outputState=body.outcome==="failed"?"failed":"unknown";}
  run.lastEventAt=o;run.receivedAt=at;run.revision++;
  db.prepare("UPDATE ops_runs SET body=? WHERE id=?").run(JSON.stringify(run),runId);event(runId,body);
  return {ok:true,run,note:"Reconciliation records inspected execution evidence; it does not execute or retry the job or verify its output."};
 }
 function compact(value,max=800){
  if(value==null)return value;const encoded=JSON.stringify(value);
  return encoded.length>max?{truncated:true,preview:encoded.slice(0,max),retainedInRunRecord:true}:value;
 }
 function compactRun(run){if(!run)return null;return {...run,evidence:compact(run.evidence),startEvidence:compact(run.startEvidence),provenance:compact(run.provenance),scheduleEvidence:compact(run.scheduleEvidence),executionIdentity:compact(run.executionIdentity),schedulerRef:compact(run.schedulerRef),reconciliations:undefined,reconciliationCount:(run.reconciliations||[]).length};}
 function runDetail(kind,id,employeeId,hosts){
  identifier(id,"runId");const table=kind==="employee"?"ops_employee_runs":"ops_runs",key=kind==="employee"?identifier(employeeId,"employeeId")+":"+id:id;
  const found=db.prepare("SELECT body FROM "+table+" WHERE id=?").get(key);if(!found)fail("run not found",404);
  const run=JSON.parse(found.body);scope(run.host,hosts);return {ok:true,run};
 }
 function jobHistory(hosts,options={}){
  const jobId=identifier(options.history,"job history identity"),job=get("ops_jobs",jobId,hosts);
  const host=options.host||null;if(host&&host!==job.host)fail("job not found for selected host",404);
  const {paginate,compact:boundedRecord}=require("./history");
  const result=paginate({options,defaultLimit:30,kind:"job-runs",filters:{hosts:hosts?[...hosts].sort():null,jobId,host},
   now,top:()=>{const row=db.prepare("SELECT rowid AS n,id FROM ops_runs WHERE job_id=? ORDER BY rowid DESC LIMIT 1").get(jobId);return row?[row.n,row.id]:null;},
   anchor:n=>db.prepare("SELECT id FROM ops_runs WHERE job_id=? AND rowid=?").get(jobId,n)?.id,
   query:({highWater,boundary,direction,limit})=>{
    const where=" WHERE job_id=? AND rowid<=?",args=[jobId,highWater];
    const total=db.prepare("SELECT COUNT(*) AS n FROM ops_runs"+where).get(...args).n;
    const bound=boundary===null?"":" AND rowid"+(direction==="newer"?">":direction==="current"?"<=":"<")+"?",order=direction==="newer"?"ASC":"DESC";
    let rows=db.prepare("SELECT rowid AS history_rowid,id,body FROM ops_runs"+where+bound+" ORDER BY rowid "+order+" LIMIT ?").all(...args,...(boundary===null?[]:[boundary]),limit);
    if(direction==="newer")rows.reverse();
    const first=rows[0],last=rows[rows.length-1];
    const exists=(op,n)=>!!db.prepare("SELECT 1 FROM ops_runs"+where+" AND rowid"+op+"? LIMIT 1").get(...args,n);
    return {rows,total,hasPrevious:!!first&&exists(">",first.history_rowid),hasNext:!!last&&exists("<",last.history_rowid)};
   }});
  const runs=result.rows.map(r=>{const run=compactRun(JSON.parse(r.body));for(const key of Object.keys(run))if(run[key]&&typeof run[key]==="object")run[key]=boundedRecord(run[key],8000);return run;});
  return require("./history").boundedPage({ok:true,asOf:new Date(now()).toISOString(),jobId,runs,page:result.page});
 }
 function allRuns(jobId,limit=100){return db.prepare("SELECT body FROM ops_runs WHERE job_id=? ORDER BY json_extract(body,'$.lastEventAt') DESC,id DESC LIMIT ?").all(jobId,limit).map(r=>JSON.parse(r.body));}
 function jobEvent(body,hosts,at){
  const job=get("ops_jobs",identifier(body.jobId,"jobId"),hosts),o=observed({...body,observedAt:body.observedAt||at});
  if(body.kind==="observation"){
   const evidence=bounded(body.scheduleEvidence,"scheduleEvidence",4000);
   if(evidence&&typeof evidence!=="object")fail("scheduleEvidence must be an object");
   if(!job.observation||Date.parse(o)>=Date.parse(job.observation.observedAt)){
    const slots=new Set(job.expectedSlots||[]);
    if(job.nextDueAt&&Date.parse(job.nextDueAt)<=Date.parse(o))slots.add(job.nextDueAt);
    const next=time(evidence?.nextElapseAt??null,"nextElapseAt",true),last=time(evidence?.lastTriggerAt??null,"lastTriggerAt",true);
    if(next)job.nextDueAt=next;
    job.expectedSlots=[...slots].sort().slice(-256);
    job.observation={observedAt:o,receivedAt:at,scheduleEvidence:evidence?{...evidence,nextElapseAt:next,lastTriggerAt:last}:null,process:bounded(body.process,"process",4000),journalCoverage:bounded(body.journalCoverage,"journalCoverage",4000),evidence:bounded(body.evidence,"observation evidence",4000),quality:body.evidence?.sourceValid===false||body.evidence?.basis==="observer-read-failed"?"error":body.evidence?.sourceValid===true?"good":"unknown"};
    job.updatedAt=at;job.revision++;save("ops_jobs",job);
   }
   event(job.id,body);return {ok:true,job};
  }
  const runId=identifier(body.runId,"runId"),scheduledFor=time(body.scheduledFor??null,"scheduledFor",true),attempt=seconds(body.attempt,"attempt",1,20,1);
  const r=db.prepare("SELECT body FROM ops_runs WHERE id=?").get(runId);let run=r?JSON.parse(r.body):null;
  if(run&&(run.jobId!==job.id||run.scheduledFor!==scheduledFor||run.attempt!==attempt))fail("matching run identity required",409);
  if(!["start","progress","succeeded","failed","cancelled"].includes(body.kind))fail("unknown job event");
  if(!run){
   if(body.kind==="progress")fail("run start or terminal evidence required",409);
   const slot=scheduledFor||"unproven:"+runId;
   if(db.prepare("SELECT id FROM ops_runs WHERE job_id=? AND scheduled_for=? AND attempt=?").get(job.id,slot,attempt))fail("scheduled attempt already exists",409);
   run={id:runId,jobId:job.id,host:job.host,scheduledFor,attempt,startedAt:null,lastProgressAt:null,lastEventAt:o,receivedAt:at,status:"unknown",revision:0,scheduleProof:scheduledFor?"explicit":"unproven",executionEvidence:"terminal_only",overlap:allRuns(job.id).some(x=>x.status==="running")};
  }
  if(body.kind==="start"){
   if(run.startedAt)fail("run already exists",409);
   if(run.finishedAt&&Date.parse(o)>Date.parse(run.finishedAt))fail("start follows terminal event",409);
   run.startedAt=o;run.executionEvidence=run.finishedAt?"start_and_terminal":"start_observed";run.lastProgressAt=o;if(!run.finishedAt)run.status="running";
  }else if(body.kind==="progress"){
   if(run.status!=="running")fail("run is terminal",409);
   if(Date.parse(o)<Date.parse(run.lastEventAt))fail("job event precedes prior execution event",409);
   run.lastProgressAt=o;run.progress=text(body.progress||"Execution observed","progress",1000);
  }else{
   if(run.finishedAt)fail("run is terminal",409);
   if(run.startedAt&&Date.parse(o)<Date.parse(run.startedAt))fail("terminal precedes execution start",409);
   if(run.lastProgressAt&&Date.parse(o)<Date.parse(run.lastProgressAt))fail("terminal precedes observed execution progress",409);
   run.status=body.kind;run.finishedAt=o;run.evidence=bounded(body.evidence,"evidence");
   if(run.evidence==null)fail("terminal evidence required");
   if(typeof run.evidence!=="object"&&typeof run.evidence!=="string")fail("invalid terminal evidence");
   run.outputState=typeof run.evidence==="object"&&run.evidence.verification==="verified"?"verified":typeof run.evidence==="object"&&run.evidence.verification==="failed"?"failed":"unknown";
   if(body.kind==="failed")run.outputState="failed";run.executionEvidence=run.startedAt?"start_and_terminal":"terminal_only";
  }
  if(body.scheduleEvidence)run.scheduleEvidence=bounded(body.scheduleEvidence,"scheduleEvidence",4000);
  if(body.kind==="start"&&body.evidence)run.startEvidence=bounded(body.evidence,"startEvidence",4000);
  if(Date.parse(o)>=Date.parse(run.lastEventAt))run.lastEventAt=o;
  run.receivedAt=at;run.revision++;
  db.prepare("INSERT INTO ops_runs(id,job_id,scheduled_for,attempt,body) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body").run(run.id,job.id,scheduledFor||"unproven:"+runId,attempt,JSON.stringify(run));
  event(run.id,body);return {ok:true,run};
 }
 function jobView(job,detailJob=null){
  const history=allRuns(job.id),active=db.prepare("SELECT body FROM ops_runs WHERE job_id=? AND json_extract(body,'$.status')='running' ORDER BY json_extract(body,'$.startedAt') DESC LIMIT 129").all(job.id).map(r=>JSON.parse(r.body)),latestRun=history[0]||null;
  const observationState=job.observation?(now()-Date.parse(job.observation.observedAt)<=job.observationTimeoutSeconds*1000?"fresh":"stale"):"unobserved";
  const observationQuality=job.observation?.quality||"unknown",coverage=job.observation?.journalCoverage;
  const complete=observationQuality==="good"&&coverage?.complete===true&&Number.isFinite(Date.parse(coverage.from))&&Number.isFinite(Date.parse(coverage.to))&&Date.parse(coverage.to)>=Date.parse(job.observation.observedAt)-90000;
  let executionState=active.length>1?"overlap":active.length?"running":latestRun?latestRun.status:"never_observed";
  if(active.length===1){const r=active[0];if(now()-Date.parse(r.startedAt)>job.maxRuntimeSeconds*1000||now()-Date.parse(r.lastProgressAt||r.startedAt)>job.progressTimeoutSeconds*1000)executionState=observationState==="fresh"?"stalled":"unknown";}
  const slots=new Set(job.expectedSlots||[]);if(job.nextDueAt)slots.add(job.nextDueAt);
  const schedule=job.schedule||{kind:"interval",intervalSeconds:job.intervalSeconds,anchorAt:job.nextDueAt};
  if(schedule.kind==="interval"&&schedule.anchorAt&&schedule.intervalSeconds){
   const anchor=Date.parse(schedule.anchorAt),step=schedule.intervalSeconds*1000,index=Math.floor((now()-anchor)/step);
   for(let n=Math.max(0,index-255);n<=index;n++)slots.add(new Date(anchor+n*step).toISOString());
  }
  const missedSlots=[],unprovenSlots=[];
  for(const slot of [...slots].sort()){
   const due=Date.parse(slot);if(due+job.graceSeconds*1000>=now())continue;
   if(db.prepare("SELECT id FROM ops_runs WHERE job_id=? AND scheduled_for=? LIMIT 1").get(job.id,slot))continue;
   const nearStart=db.prepare("SELECT id FROM ops_runs WHERE job_id=? AND json_extract(body,'$.scheduledFor') IS NULL AND CAST(strftime('%s',json_extract(body,'$.startedAt')) AS INTEGER) BETWEEN ? AND ? LIMIT 1").get(job.id,Math.floor((due-job.graceSeconds*1000)/1000),Math.ceil((due+job.maxRuntimeSeconds*1000)/1000));
   const near=nearStart||db.prepare("SELECT id FROM ops_runs WHERE job_id=? AND json_extract(body,'$.scheduledFor') IS NULL AND CAST(strftime('%s',json_extract(body,'$.finishedAt')) AS INTEGER) BETWEEN ? AND ? LIMIT 1").get(job.id,Math.floor(due/1000),Math.ceil((due+job.maxRuntimeSeconds*1000)/1000));
   if(!near&&observationState==="fresh"&&complete&&Date.parse(coverage.from)<=due&&Date.parse(coverage.to)>=due+job.graceSeconds*1000)missedSlots.push(slot);
   else unprovenSlots.push(slot);
  }
  const latestVerifiedSlot=history.filter(r=>r.status==="succeeded"&&r.outputState==="verified"&&r.scheduledFor).map(r=>r.scheduledFor).sort().pop();
  const outstanding=missedSlots.filter(s=>!latestVerifiedSlot||Date.parse(s)>Date.parse(latestVerifiedSlot));
  const outstandingUnknown=unprovenSlots.filter(s=>!latestVerifiedSlot||Date.parse(s)>Date.parse(latestVerifiedSlot));
  if(!latestRun&&!active.length&&outstanding.length)executionState="never_started";
  const scheduleState=outstanding.length?"overdue":outstandingUnknown.length?"unproven":job.nextDueAt||schedule.kind==="interval"?"scheduled":"unproven",outputState=latestRun?.outputState||"unknown";
  let health=observationState==="fresh"&&observationQuality==="good"&&(["failed","stalled","overlap"].includes(executionState)||scheduleState==="overdue"||outputState==="failed")?"critical":"unknown";
  if(health!=="critical"&&executionState==="succeeded"&&outputState==="verified"&&observationState==="fresh"&&observationQuality==="good"&&scheduleState==="scheduled")health="healthy";
  return {...job,expectedSlots:undefined,expectedSlotCount:(job.expectedSlots||[]).length,latestRun:compactRun(latestRun),runs:detailJob===job.id?history.slice(0,30).map(compactRun):[],historyTruncated:history.length>30,activeRunsTruncated:active.length>128,executionState,scheduleState,outputState,observationState,observationQuality,missedSlots:missedSlots.slice(-50),unprovenSlots:unprovenSlots.slice(-50),missedSlotsTruncated:missedSlots.length>50,health};
 }
 function listJobs(hosts,{detail=null}={}){return rows("ops_jobs",hosts).map(job=>jobView(job,detail));}
 function employeeEvent(body,hosts,at){
  const employeeId=identifier(body.employeeId,"employeeId");if(!Object.hasOwn(META,employeeId))fail("unknown employee");
  const host=identifier(body.host,"host");scope(host,hosts);if(META[employeeId].host!==host)fail("employee is not bound to this resource",403);const o=observed(body);
  const runId=body.runId==null?null:identifier(body.runId,"runId"),id=runId?employeeId+":"+runId:null,provenance=bounded(body.provenance||{},"provenance",4000);
  if(!["start","progress","succeeded","failed","output","marker"].includes(body.kind))fail("unknown employee event");
  if(body.kind==="output"){
   const linked=runId?db.prepare("SELECT host FROM ops_employee_runs WHERE id=?").get(employeeId+":"+runId):null;
   if(linked&&linked.host!==host)fail("output run belongs to another host",409);
   const outputId=identifier(body.outputId||body.eventId||body.idempotencyKey,"outputId"),existing=db.prepare("SELECT body FROM ops_employee_outputs WHERE id=?").get(outputId);
   const row={id:outputId,employeeId,host,runId,observedAt:o,receivedAt:at,state:"received",summary:text(body.summary||"Report received","summary",1000),provenance,outputHash:text(body.outputHash,"outputHash",80),outputRef:text(body.outputRef,"outputRef",500),executionState:linked?"linked":"unknown",linkage:linked?"matched":runId?"declared_unmatched":"unlinked"};
   if(!/^sha256:[a-f0-9]{64}$/.test(row.outputHash))fail("outputHash must be a SHA-256 content digest");
   if(existing){const prior=JSON.parse(existing.body);const fields=["id","employeeId","host","runId","observedAt","summary","provenance","outputHash","outputRef"];if(fields.some(key=>JSON.stringify(prior[key])!==JSON.stringify(row[key])))fail("output identity conflict",409);return {ok:true,output:prior};}
   db.prepare("INSERT INTO ops_employee_outputs VALUES(?,?,?,?,?)").run(outputId,employeeId,host,o,JSON.stringify(row));event(outputId,body);return {ok:true,output:row};
  }
  if(!runId)fail("runId required for execution event");
  const found=db.prepare("SELECT body FROM ops_employee_runs WHERE id=?").get(id);let row=found?JSON.parse(found.body):null;
  if(row&&(row.host!==host||row.employeeId!==employeeId))fail("matching employee run identity required",409);
  if(!row)row={id,runId,employeeId,host,startedAt:null,finishedAt:null,lastProgressAt:null,status:"unknown",scheduledFor:time(body.scheduledFor??null,"scheduledFor",true),scheduleState:body.scheduledFor?"explicit":"unproven",provenance,executionIdentity:bounded(body.executionIdentity||null,"executionIdentity",1000),definitionRevision:bounded(body.definitionRevision||null,"definitionRevision",200),schedulerRef:bounded(body.schedulerRef||null,"schedulerRef",1000),revision:0};
  if(body.kind==="marker"&&(row.finishedAt||row.startedAt&&Date.parse(o)<Date.parse(row.startedAt))){event(id,{...body,ignoredBecause:"authoritative execution evidence retained"});return {ok:true,run:row,markerIgnored:true};}
  if(body.kind==="marker"){row.status="unknown";row.marker=text(body.marker,"marker",100);if(row.marker==="end")row.finishedAt=o;row.executionEvidence=row.startedAt?"start_and_unverified_end":"unlinked_legacy_marker";}
  else if(body.kind==="start"){
   if(row.startedAt)fail("employee run already started",409);
   if(row.finishedAt&&Date.parse(o)>Date.parse(row.finishedAt))fail("start follows finish",409);
   row.startedAt=o;row.lastProgressAt=o;row.executionEvidence=row.finishedAt?"start_and_terminal":"start_observed";if(!row.finishedAt)row.status="running";
  }else if(body.kind==="progress"){
   if(row.status!=="running")fail("matching running employee required",409);
   if(Date.parse(o)<Date.parse(row.lastProgressAt))fail("progress predates prior progress",409);
   row.lastProgressAt=o;
  }else{
   if(row.finishedAt)fail("employee run is terminal",409);
   if(row.startedAt&&Date.parse(o)<Date.parse(row.startedAt))fail("finish precedes start",409);
   if(row.lastProgressAt&&Date.parse(o)<Date.parse(row.lastProgressAt))fail("finish precedes observed execution progress",409);
   row.status=body.kind;row.finishedAt=o;row.evidence=bounded(body.evidence||"Reported terminal outcome","evidence",4000);row.executionEvidence=row.startedAt?"start_and_terminal":"terminal_only";
  }
  row.observedAt=!row.observedAt||Date.parse(o)>Date.parse(row.observedAt)?o:row.observedAt;row.receivedAt=at;row.revision++;
  db.prepare("INSERT INTO ops_employee_runs VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET observed_at=excluded.observed_at,body=excluded.body").run(id,employeeId,host,row.observedAt,JSON.stringify(row));event(id,body);return {ok:true,run:row};
 }
 function employeeView(employee,hosts){
  const where=hosts?(hosts.length?" AND host IN ("+hosts.map(()=>"?").join(",")+")":" AND 0"):"";
  const read=table=>db.prepare("SELECT body FROM "+table+" WHERE employee_id=?"+where+" ORDER BY observed_at DESC,id DESC LIMIT 31").all(employee.id,...(hosts||[])).map(r=>JSON.parse(r.body));
  const all=read("ops_employee_runs"),outputs=read("ops_employee_outputs").map(o=>{const match=o.runId?db.prepare("SELECT host FROM ops_employee_runs WHERE id=?").get(employee.id+":"+o.runId):null;return match&&match.host===o.host?{...o,executionState:"linked",linkage:"matched"}:o;}),runs=all.slice(0,30).map(r=>({...compactRun(r),executionState:r.status==="running"&&now()-Date.parse(r.lastProgressAt||r.startedAt)>180000?"stalled":r.status}));
  const live=db.prepare("SELECT body FROM ops_employee_runs WHERE employee_id=?"+where+" AND json_extract(body,'$.status')='running' ORDER BY observed_at DESC LIMIT 129").all(employee.id,...(hosts||[])).map(r=>{const v=JSON.parse(r.body);return {...v,executionState:now()-Date.parse(v.lastProgressAt||v.startedAt)>180000?"stalled":"running"};}),executionState=live.length>1?"overlap":live.length?live[0].executionState:runs[0]?.executionState||"unknown",lastOutput=outputs[0]||null;
  return {...employee,...META[employee.id],observedRuntimeAuthority:"unverified; registry metadata does not grant privileges",runs,outputs:outputs.slice(0,30).map(o=>({...o,provenance:compact(o.provenance)})),historyTruncated:all.length>30||outputs.length>30,executionState,scheduleState:"unverified_external_schedule",schedulerRef:"External schedule and runtime hooks remain unverified",outputState:lastOutput?"received":"not_observed",outputFreshness:lastOutput?(now()-Date.parse(lastOutput.observedAt)<((employee.cadenceSeconds||86400)*2000)?"recent":"stale"):"unknown",lastOutput:lastOutput?{...lastOutput,provenance:compact(lastOutput.provenance)}:null,definitionRevision:runs.find(r=>r.definitionRevision)?.definitionRevision||null,note:"Observed execution and report receipts are separate. Output alone never proves scheduler or measured service health."};
 }
 function employeeRuntimeConditions(){
  const out=[];
  for(const employeeId of Object.keys(META)){
   const activeRuns=registry.HOSTS.flatMap(h=>db.prepare("SELECT body FROM ops_employee_runs WHERE employee_id=? AND host=? AND json_extract(body,'$.status')='running' ORDER BY observed_at DESC LIMIT 129").all(employeeId,h.id).map(r=>JSON.parse(r.body)));
   const latest=registry.HOSTS.map(h=>db.prepare("SELECT body FROM ops_employee_runs WHERE employee_id=? AND host=? AND json_extract(body,'$.executionEvidence')!='unlinked_legacy_marker' ORDER BY observed_at DESC LIMIT 1").get(employeeId,h.id)).filter(Boolean).map(r=>JSON.parse(r.body));
   const runs=[...new Map(activeRuns.concat(latest).map(r=>[r.id,r])).values()].sort((a,b)=>b.observedAt.localeCompare(a.observedAt));
   for(const host of new Set(runs.map(r=>r.host))){
    const history=runs.filter(r=>r.host===host),active=history.filter(r=>r.status==="running"),latest=history[0];
    const status=active.length>1?"critical":active.length&&now()-Date.parse(active[0].lastProgressAt||active[0].startedAt)>180000?"critical":!active.length&&latest.status==="failed"?"critical":!active.length&&latest.status==="succeeded"&&latest.startedAt?"healthy":"unknown";
    const executionState=active.length>1?"overlap":active.length?(status==="critical"?"stalled":"running"):latest.status;
    out.push({checkId:"operations.employee."+employeeId+"."+host,host,status,summary:"Employee "+employeeId+": "+executionState+"; measured service health is independent",observedAt:now(),evidence:{employeeId,executionState,runId:latest.runId,sourceObservedAt:latest.observedAt,evaluationAt:new Date(now()).toISOString()}});
   }
  }
  return out;
 }
 function workConditions(){
  const source=rows("ops_work",null),groups=new Map();
  for(const w of source.filter(w=>w.action||w.verification)){
   const key=(w.employeeId||"unassigned")+"."+w.host;
   if(!groups.has(key))groups.set(key,[]);groups.get(key).push(w);
  }
  const out=[];
  for(const [key,work] of groups){
   const failures=[],uncertain=[],verified=[];
   for(const w of work){
    const unresolved=w.action&&["intent","running","uncertain"].includes(w.action.status);
    if(unresolved&&w.leaseUntil&&Date.parse(w.leaseUntil)<now())uncertain.push(w);
    const good=w.verification?.outcome==="verified"&&!unresolved&&(!w.action||w.verification.actionId===w.action.id);
    if(good)verified.push(w);
    else if(w.verification?.outcome==="failed")failures.push({work:w,type:"verification-failed",id:w.verification.eventId||w.id+":"+w.verification.at});
    else if(w.action?.status==="failed")failures.push({work:w,type:"action-failed",id:w.action.id+":failed"});
   }
   const affected=[...new Map(failures.map(f=>f.work).concat(uncertain).map(w=>[w.id,w])).values()];
   const notices=failures.slice(0,19).map(f=>({type:f.type,id:f.id}));
   if(failures.length>19)notices.push({type:"action-failed",id:"aggregate-"+require("node:crypto").createHash("sha256").update(JSON.stringify(failures.map(f=>f.id).sort())).digest("hex")});
   out.push({checkId:"operations.work."+key,host:work[0].host,status:affected.length?"critical":!source.truncated&&verified.length===work.length?"healthy":"unknown",
    summary:"Employee "+(work[0].employeeId||"unassigned")+": "+failures.length+" failed action/verification, "+uncertain.length+" uncertain actions",
    observedAt:now(),evidence:{employeeId:work[0].employeeId,affectedCount:affected.length,affectedWorkIds:affected.slice(0,20).map(w=>w.id),
     incidentIds:[...new Set(affected.map(w=>w.incidentId).filter(Boolean))].slice(0,20),
     affectedTruncated:affected.length>20,failureCount:failures.length,failureNotices:notices,failureNotice:notices[0]||null,
     aggregatedFailureNotices:Math.max(0,failures.length-19),sourceObservedAt:work[0].updatedAt,evaluationAt:new Date(now()).toISOString()}});
  }
  if(source.truncated)out.push({checkId:"operations.work.coverage",host:registry.HOSTS[0]?.id,status:"critical",summary:"Work-condition coverage exceeds the1000-record bound; inspect remaining assignments",observedAt:now(),evidence:{coverageComplete:false,limit:1000}});
  return out;
 }
 function observerConditions(){
  return rows("ops_jobs",null).map(j=>{
   const source=j.observation?.observedAt||null,reference=source||j.createdAt||j.updatedAt,late=now()-Date.parse(reference)>(j.observationTimeoutSeconds||300)*1000;
   return {checkId:"operations.observer."+j.id,host:j.host,status:late||j.observation?.quality==="error"?"critical":source&&j.observation?.quality==="good"?"healthy":"unknown",summary:j.label+": "+(late?"job observer overdue":j.observation?.quality==="error"?"job observation source failed":source?"job observer "+(j.observation?.quality||"unknown"):"awaiting initial job observer"),observedAt:now(),
    evidence:{jobId:j.id,sourceObservedAt:source,registeredAt:j.createdAt||j.updatedAt,evaluationAt:new Date(now()).toISOString(),observationTimeoutSeconds:j.observationTimeoutSeconds||300,sourceQuality:j.observation?.quality||"unknown",sourceEvidence:j.observation?.evidence||null,meaning:"Observer visibility only; no job execution failure is inferred."}};
  });
 }
 function conditions(){return listJobs(null).map(j=>({checkId:"operations.job."+j.id,host:j.host,status:j.health,summary:j.label+": "+j.executionState+"; schedule "+j.scheduleState+"; output "+j.outputState,observedAt:now(),evidence:{jobId:j.id,executionState:j.executionState,scheduleState:j.scheduleState,outputState:j.outputState,observationState:j.observationState,sourceObservedAt:j.observation?.observedAt||j.latestRun?.lastEventAt||null,evaluationAt:new Date(now()).toISOString(),runId:j.latestRun?.id||null,missedSlots:j.missedSlots,unprovenSlots:j.unprovenSlots}})).concat(employeeRuntimeConditions(),workConditions(),observerConditions());}
 function conditionDefinitions(){return rows("ops_jobs",null).map(j=>({id:"operations.job."+j.id,host:j.host,label:j.label.slice(0,200),type:"operation",intervalSeconds:60,policy:{failCount:1,recoverCount:1},dependencies:registry.CHECKS.filter(check=>check.host===j.host&&check.type==="collection").slice(0,1).map(check=>({checkId:check.id,reason:"Resource collector visibility"}))})).concat(employeeRuntimeConditions().concat(workConditions(),observerConditions()).map(c=>({id:c.checkId,host:c.host,label:c.summary.slice(0,200),type:"operation",intervalSeconds:60,policy:{failCount:1,recoverCount:1},dependencies:[]})));}
 return {compact,runDetail,jobHistory,registerJob,reconcileJob,jobEvent,listJobs,employeeEvent,employeeView,conditions,conditionDefinitions};
}
module.exports={createRuntime};
