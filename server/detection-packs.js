"use strict";
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const {RULES,matches}=require("./detection-rules");
const {validateNormalizedRecord}=require("../tools/ingest-contract");
const sha=v=>crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex");
const plain=v=>v&&typeof v==="object"&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
function keys(v,n){if(!plain(v)||Object.keys(v).some(k=>!n.includes(k)))throw new TypeError("Unsupported detection pack fields.");}
function text(v,n){if(typeof v!=="string"||!v.trim()||v.length>n||/[\x00-\x1f\x7f]/.test(v))throw new TypeError("Invalid detection pack text.");}
function id(v){if(typeof v!=="string"||!/^[a-z][a-z0-9.-]{2,100}$/.test(v))throw new TypeError("Invalid rule or pack identity.");}
function field(v){if(typeof v!=="string"||!/^(?:message|title|state|severity|assetRef|identityRef|fields\.[A-Za-z][A-Za-z0-9_.:-]{0,70})$/.test(v))throw new TypeError("Unsupported rule field.");}
function scalar(v){if(!["string","number","boolean"].includes(typeof v)||typeof v==="string"&&(v.length>1000||/[\x00-\x1f\x7f]/.test(v))||typeof v==="number"&&!Number.isFinite(v))throw new TypeError("Rule values must be bounded scalars.");}
function condition(c){
 keys(c,["field","operator","value"]);field(c.field);
 if(!["equals","contains","startsWith","endsWith","in"].includes(c.operator))throw new TypeError("Unsupported rule operator; expressions and regular expressions are not executable.");
 if(c.operator==="in"){if(!Array.isArray(c.value)||!c.value.length||c.value.length>20)throw new TypeError("Invalid rule membership values.");c.value.forEach(scalar);}
 else{scalar(c.value);if(c.operator!=="equals"&&(typeof c.value!=="string"||!c.value))throw new TypeError("Text operators require nonempty strings.");}
 return c;
}
function validatePack(pack){
 keys(pack,["schemaVersion","id","version","author","license","notice","source","licenseReviewed","rules"]);
 if(pack.schemaVersion!==1||pack.licenseReviewed!==true)throw new TypeError("A version-1 pack requires explicit license review.");
 id(pack.id);if(!Number.isSafeInteger(pack.version)||pack.version<1)throw new TypeError("Pack version must be a positive integer.");
 text(pack.author,200);text(pack.notice,700);text(pack.source,500);
 if(!["MIT","Apache-2.0","DRL-1.1"].includes(pack.license))throw new TypeError("Unsupported pack license; review redistribution and use before importing.");
 const url=new URL(pack.source);if(url.protocol!=="https:"||url.username||url.password)throw new TypeError("Pack provenance requires a public HTTPS source reference.");
 if(!Array.isArray(pack.rules)||!pack.rules.length||pack.rules.length>100)throw new TypeError("A pack contains 1–100 rules.");
 const ids=new Set(),rules=[];
 for(const raw of pack.rules){
  keys(raw,["id","version","title","severity","kind","prerequisite","conditions","mode","groupBy","threshold","windowSeconds","fixtures"]);
  id(raw.id);if(!raw.id.startsWith(pack.id+".")||ids.has(raw.id)||RULES.some(r=>r.id===raw.id))throw new TypeError("Rule IDs require a unique pack namespace.");ids.add(raw.id);
  if(!Number.isSafeInteger(raw.version)||raw.version<1)throw new TypeError("Rule version must be a positive integer.");
  text(raw.title,300);text(raw.prerequisite,1000);
  if(!["low","medium","high","critical"].includes(raw.severity)||!["log.event","audit.event","authentication.event","endpoint.event","network.event"].includes(raw.kind))throw new TypeError("Unsupported rule severity or record kind.");
  if(!Array.isArray(raw.conditions)||!raw.conditions.length||raw.conditions.length>16)throw new TypeError("Rules require 1–16 explicit conditions.");
  raw.conditions.forEach(condition);
  const mode=raw.mode||"event";
  if(!["event","threshold"].includes(mode))throw new TypeError("Unsupported execution mode.");
  if(mode==="threshold"){
   if(!Array.isArray(raw.groupBy)||!raw.groupBy.length||raw.groupBy.length>4)throw new TypeError("Threshold rules require explicit grouping.");
   raw.groupBy.forEach(field);
   if(!Number.isInteger(raw.threshold)||raw.threshold<2||raw.threshold>1000||!Number.isInteger(raw.windowSeconds)||raw.windowSeconds<60||raw.windowSeconds>3600)throw new TypeError("Invalid threshold bounds.");
  }else if(["groupBy","threshold","windowSeconds"].some(k=>raw[k]!==undefined))throw new TypeError("Event rules cannot contain threshold settings.");
  const rule={...raw,mode,match:{},groupBy:raw.groupBy?.map(k=>k.startsWith("fields.")?k.slice(7):"$"+k),author:pack.author,license:pack.license,
   notice:pack.notice,references:[pack.source],packId:pack.id,packVersion:pack.version,family:"reviewed-pack"};
  delete rule.fixtures;
  keys(raw.fixtures,["positive","negative"]);
  for(const name of ["positive","negative"]){
   const examples=raw.fixtures[name];
   if(!Array.isArray(examples)||!examples.length||examples.length>20)throw new TypeError("Each rule requires 1–20 positive and negative canonical fixtures.");
   for(const example of examples){
    const record=validateNormalizedRecord(example);
    if(matches(rule,record)!==(name==="positive"))throw new TypeError("Detection fixture did not produce its declared result.");
   }
  }
  rule.ruleDigest=sha(rule);rules.push(Object.freeze(rule));
 }
 return {pack:JSON.parse(JSON.stringify(pack)),rules,digest:sha(pack)};
}
function readDocument(file){
 if(typeof file!=="string"||!path.isAbsolute(file)||path.resolve(file)!==file)throw new TypeError("Use an absolute canonical detection file path.");
 const info=fs.lstatSync(file);
 if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>2*1024*1024||info.mode&0o077||process.getuid&&info.uid!==process.getuid()||fs.realpathSync(file)!==file)throw new TypeError("Detection pack file must be owner-only, regular and at most 2 MiB.");
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const stat=fs.fstatSync(fd);if(stat.ino!==info.ino||stat.dev!==info.dev)throw new TypeError("Detection pack file changed.");return JSON.parse(fs.readFileSync(fd,"utf8"));}finally{fs.closeSync(fd);}
}
function loadPacks(stateDir,document){
 const file=stateDir?path.join(stateDir,"detection-packs.json"):null;
 const value=document===undefined?(file&&fs.existsSync(file)?readDocument(file):{schemaVersion:1,packs:[]}):document;
 keys(value,["schemaVersion","packs"]);
 if(value.schemaVersion!==1||!Array.isArray(value.packs)||value.packs.length>5)throw new TypeError("At most five versioned detection packs may be installed.");
 const results=value.packs.map(validatePack),ids=new Set(),ruleIds=new Set(RULES.map(rule=>rule.id));
 for(const result of results){
  if(ids.has(result.pack.id))throw new TypeError("Duplicate detection pack identity.");ids.add(result.pack.id);
  // Nested pack namespaces can share a prefix. Never let Map construction in
  // policy configuration silently replace an already installed rule identity.
  for(const rule of result.rules){if(ruleIds.has(rule.id))throw new TypeError("Duplicate detection rule identity across installed packs.");ruleIds.add(rule.id);}
 }
 return {document:value,packs:results,rules:[...RULES,...results.flatMap(r=>r.rules)]};
}
module.exports={validatePack,loadPacks,readDocument};
