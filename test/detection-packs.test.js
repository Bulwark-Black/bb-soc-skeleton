"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),crypto=require("node:crypto");
const {validatePack,loadPacks,readDocument}=require("../server/detection-packs");
const {update}=require("../tools/detection-pack");
const record=(message)=>({schemaVersion:"1",documentType:"normalized-record",sourceId:"synthetic-source",estateId:"synthetic-app",recordId:"synthetic-"+message,
 kind:"log.event",observedAt:"2026-10-18T12:00:00.000Z",payload:{title:"Synthetic pack fixture",state:"unknown",message,fields:{provider:"synthetic"}}});
function pack(version=1){return {schemaVersion:1,id:"example-pack",version,author:"Synthetic rule author",license:"MIT",notice:"Copyright synthetic example",source:"https://example.invalid/rules",licenseReviewed:true,
 rules:[{id:"example-pack.alert",version:1,title:"Synthetic rule",severity:"high",kind:"log.event",prerequisite:"Synthetic log feed",conditions:[{field:"message",operator:"contains",value:"alert"}],
 fixtures:{positive:[record("alert")],negative:[record("ordinary")]}}]};}
function fixture(t){const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),"bb-pack-"));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const save=(name,value)=>{const file=path.join(dir,name);fs.writeFileSync(file,JSON.stringify(value),{mode:0o600});return file;};
 return {dir,save,sha:name=>crypto.createHash("sha256").update(fs.readFileSync(path.join(dir,name))).digest("hex")};}
test("reviewed packs enforce fixture evidence, namespace, license and bounded executable operators",()=>{
 const p=pack(),result=validatePack(p);assert.equal(result.rules[0].author,p.author);assert.equal(result.rules[0].license,"MIT");assert.equal(result.rules[0].packVersion,1);
 assert.equal(loadPacks(undefined,{schemaVersion:1,packs:[p]}).rules.length,26);
 for(const mutate of [x=>x.licenseReviewed=false,x=>x.rules[0].conditions[0].operator="regex",x=>x.rules[0].fixtures.positive=[record("ordinary")],
 x=>x.rules[0].id="other.rule",x=>x.source="javascript:alert(1)",x=>x.license="unknown",x=>x.rules[0].conditions[0].field="__proto__"]){
  const x=structuredClone(p);mutate(x);assert.throws(()=>validatePack(x));
 }
 const threshold=pack();Object.assign(threshold.rules[0],{mode:"threshold",groupBy:["fields.provider"],threshold:2,windowSeconds:60});
 assert.equal(validatePack(threshold).rules[0].groupBy[0],"provider");
});
test("pack upgrades use compare-and-swap, retain rollback, and reject incompatible policy restoration",t=>{
 const f=fixture(t),first=f.save("input.json",pack());let result=update({stateDirectory:f.dir,file:first,expectedSha:"absent",kind:"pack"});
 assert.equal(result.state,"written-restart-required");assert.equal(result.backupAvailable,false);
 assert.throws(()=>update({stateDirectory:f.dir,file:first,expectedSha:"absent",kind:"pack"}),/changed/);
 assert.throws(()=>update({stateDirectory:f.dir,file:first,expectedSha:result.sha256,kind:"pack"}),/higher version/);
 const second=pack(2);second.rules[0].id="example-pack.new-alert";f.save("input.json",second);
 result=update({stateDirectory:f.dir,file:first,expectedSha:result.sha256,kind:"pack"});assert.equal(result.backupAvailable,true);
 const policy={schemaVersion:1,applications:[{appId:"synthetic-app",rules:[{id:"example-pack.new-alert",stage:"shadow"}]}]};
 const policyFile=f.save("policy-input.json",policy);const policyResult=update({stateDirectory:f.dir,file:policyFile,expectedSha:"absent",kind:"policy"});
 assert.throws(()=>update({stateDirectory:f.dir,expectedSha:result.sha256,kind:"pack",restore:true}),/Unknown/);
 assert.equal(readDocument(path.join(f.dir,"detection-packs.json")).packs[0].version,2);
 f.save("policy-input.json",{schemaVersion:1,applications:[]});
 update({stateDirectory:f.dir,file:policyFile,expectedSha:policyResult.sha256,kind:"policy"});
 const restored=update({stateDirectory:f.dir,expectedSha:result.sha256,kind:"pack",restore:true});
 assert.equal(restored.state,"written-restart-required");assert.equal(readDocument(path.join(f.dir,"detection-packs.json")).packs[0].version,1);
 assert.equal(fs.statSync(path.join(f.dir,"detection-packs.json")).mode&0o777,0o600);
 assert.equal(fs.existsSync(path.join(f.dir,"detection-update.lock")),false);
});
test("rule update refuses linked inputs, unrelated executable syntax and concurrent update locks",t=>{
 const f=fixture(t),file=f.save("input.json",pack());fs.symlinkSync(file,path.join(f.dir,"link.json"));assert.throws(()=>readDocument(path.join(f.dir,"link.json")));
 assert.throws(()=>readDocument("relative.json"),/absolute/);
 f.save("detection-update.lock",{});assert.throws(()=>update({stateDirectory:f.dir,file,expectedSha:"absent",kind:"pack"}),/EEXIST/);
 assert.equal(fs.existsSync(path.join(f.dir,"detection-packs.json")),false);
});

test("nested pack namespaces cannot replace an existing rule identity during install",t=>{
 const f=fixture(t),parent=pack(),child=pack();
 parent.rules[0].id="example-pack.child.alert";
 child.id="example-pack.child";child.rules[0].id=parent.rules[0].id;child.rules[0].severity="critical";
 assert.equal(validatePack(parent).rules[0].severity,"high");
 assert.equal(validatePack(child).rules[0].severity,"critical");
 assert.throws(()=>loadPacks(undefined,{schemaVersion:1,packs:[parent,child]}),/Duplicate detection rule identity/);
 const initial=update({stateDirectory:f.dir,file:f.save("parent.json",parent),expectedSha:"absent",kind:"pack"});
 const before=fs.readFileSync(path.join(f.dir,"detection-packs.json"),"utf8");
 assert.throws(()=>update({stateDirectory:f.dir,file:f.save("child.json",child),expectedSha:initial.sha256,kind:"pack"}),/Duplicate detection rule identity/);
 assert.equal(fs.readFileSync(path.join(f.dir,"detection-packs.json"),"utf8"),before);
 assert.equal(fs.existsSync(path.join(f.dir,"detection-packs.previous.json")),false);
 child.rules[0].id="example-pack.child.separate";
 assert.equal(loadPacks(undefined,{schemaVersion:1,packs:[parent,child]}).rules.length,27);
});
