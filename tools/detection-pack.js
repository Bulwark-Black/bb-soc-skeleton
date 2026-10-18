#!/usr/bin/env node
"use strict";
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const {validatePack,loadPacks,readDocument}=require("../server/detection-packs");
const {configuration}=require("../server/detection-engine");
const ROOT=path.resolve(__dirname,"..");
const hash=bytes=>crypto.createHash("sha256").update(bytes).digest("hex");
function external(dir){
 if(typeof dir!=="string"||!path.isAbsolute(dir)||path.resolve(dir)!==dir||dir===ROOT||dir.startsWith(ROOT+path.sep)||fs.realpathSync(dir)!==dir)throw new TypeError("Use an existing canonical private state directory outside the checkout.");
 const stat=fs.lstatSync(dir);
 if(!stat.isDirectory()||stat.mode&0o077||process.getuid&&stat.uid!==process.getuid())throw new TypeError("State directory must be owned by this user and private.");
}
function writeAtomic(file,value){
 const temp=file+".new-"+crypto.randomUUID(),data=JSON.stringify(value,null,2)+"\n";
 let fd;
 try{fd=fs.openSync(temp,"wx",0o600);fs.writeFileSync(fd,data);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temp,file);
 const dir=fs.openSync(path.dirname(file),"r");try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}}
 finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(temp))fs.unlinkSync(temp);}
}
function update({stateDirectory,file,expectedSha,kind,restore=false}){
 external(stateDirectory);
 if(!["pack","policy"].includes(kind)||typeof expectedSha!=="string"||expectedSha!=="absent"&&!/^[a-f0-9]{64}$/.test(expectedSha))throw new TypeError("Supply --expected-sha with the inspected current digest or absent.");
 const name=kind==="pack"?"detection-packs":"detection-config",target=path.join(stateDirectory,name+".json"),backup=path.join(stateDirectory,name+".previous.json");
 const lock=path.join(stateDirectory,"detection-update.lock"),fd=fs.openSync(lock,"wx",0o600);
 try{
  fs.writeFileSync(fd,JSON.stringify({pid:process.pid,at:new Date().toISOString()}));fs.fsyncSync(fd);
  const current=fs.existsSync(target)?readDocument(target):null;
  if((current?hash(fs.readFileSync(target)):"absent")!==expectedSha)throw new TypeError("Configuration changed; inspect the current digest before retrying.");
  let next;
  if(restore){next=readDocument(backup);if(kind==="pack"){const loaded=loadPacks(stateDirectory,next),policy=path.join(stateDirectory,"detection-config.json");if(fs.existsSync(policy))configuration(readDocument(policy),loaded.rules);}else configuration(next,loadPacks(stateDirectory).rules);}
  else if(kind==="pack"){
   const validated=validatePack(readDocument(file)),installed=loadPacks(stateDirectory).document;
   const previous=installed.packs.find(p=>p.id===validated.pack.id);
   if(previous&&validated.pack.version<=previous.version)throw new TypeError("Pack upgrade requires a higher version; use restore for reviewed rollback.");
   next={schemaVersion:1,packs:[...installed.packs.filter(p=>p.id!==validated.pack.id),validated.pack]};
   const loaded=loadPacks(stateDirectory,next),policy=path.join(stateDirectory,"detection-config.json");
   if(fs.existsSync(policy))configuration(readDocument(policy),loaded.rules);
  }else{next=readDocument(file);configuration(next,loadPacks(stateDirectory).rules);}
  if(current)writeAtomic(backup,current);
  writeAtomic(target,next);
  return {state:"written-restart-required",kind,sha256:hash(fs.readFileSync(target)),backupAvailable:!!current};
 }finally{fs.closeSync(fd);fs.unlinkSync(lock);}
}
function main(args=process.argv.slice(2)){
 if(args.length===1&&args[0]==="--help"){process.stdout.write("Usage: detection-pack check --file ABS | install --file ABS --state-dir ABS --expected-sha DIGEST | policy --file ABS --state-dir ABS --expected-sha DIGEST | restore --kind pack|policy --state-dir ABS --expected-sha DIGEST\nFiles must be owner-only. Pack fixtures and license review are required. Writes preserve one rollback version; restart explicitly after review.\n");return;}
 const command=args.shift(),values={};
 while(args.length){const key=args.shift(),value=args.shift();if(!["--file","--state-dir","--expected-sha","--kind"].includes(key)||!value||Object.hasOwn(values,key))throw new TypeError("Unsupported or repeated option.");values[key]=value;}
 let result;
 if(command==="check"){
  if(Object.keys(values).length!==1||!values["--file"])throw new TypeError("check accepts only --file.");
  const p=validatePack(readDocument(values["--file"]));result={id:p.pack.id,version:p.pack.version,rules:p.rules.length,digest:p.digest,fixtures:"passed",license:p.pack.license};
 }else{
  if(!["install","policy","restore"].includes(command)||!values["--state-dir"]||!values["--expected-sha"]
    ||command!=="restore"&&!values["--file"]||command!=="restore"&&values["--kind"]||command==="restore"&&values["--file"])throw new TypeError("Use a documented pack command.");
  result=update({stateDirectory:values["--state-dir"],file:values["--file"],expectedSha:values["--expected-sha"],kind:command==="restore"?values["--kind"]:command==="install"?"pack":"policy",restore:command==="restore"});
 }
 process.stdout.write(JSON.stringify(result)+"\n");
}
if(require.main===module){try{main();}catch{process.stderr.write("Detection update refused. Check the private file, fixtures, license, expected digest and update lock; current policy was not silently replaced.\n");process.exitCode=1;}}
module.exports={update,main};
