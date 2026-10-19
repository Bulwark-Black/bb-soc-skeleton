"use strict";
const crypto = require("node:crypto");
function problem(status,message){return Object.assign(new Error(message),{status});}
function limitOf(value,fallback){
  if(value===undefined||value===null||value==="")return fallback;
  if(!/^[1-9][0-9]{0,2}$/.test(String(value))||Number(value)>100)throw problem(400,"history limit must be between 1 and 100");
  return Number(value);
}
function hash(value){return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");}
function pair(value){return Array.isArray(value)&&value.length===2&&Number.isSafeInteger(value[0])&&value[0]>0&&typeof value[1]==="string"&&value[1].length>0&&value[1].length<=160;}
function compact(value,max=8000){
  const encoded=JSON.stringify(value);
  if(encoded===undefined||Buffer.byteLength(encoded)<=max)return value;
  // The preview is JSON inside JSON; leave space for worst-case escaping.
  return {truncated:true,preview:encoded.slice(0,Math.floor((max-200)/6)),retainedInRecord:true};
}
// A cursor is a bounded keyset, not authorization. Every query and anchor lookup
// must independently apply the effective estate scope. These tables are append-only:
// rowid gives recorded insertion order. Anchor identity checks reject rowid rewrites
// (e.g. VACUUM/replacement) instead of silently continuing a different snapshot.
function paginate({options={},defaultLimit,kind,filters,now,top,anchor,query}){
  const limit=limitOf(options.limit,defaultLimit),fingerprint=hash([kind,filters,limit]);
  let snapshotAt=now(),highWater=top(),boundary=null,direction="older",expectedMembership=null,continued=false;
  if(options.cursor!==undefined&&options.cursor!==null&&options.cursor!==""){
    const token=options.cursor;let cursor;
    try{
      if(typeof token!=="string"||token.length>1024||!/^[A-Za-z0-9_-]+$/.test(token))throw Error();
      const decoded=Buffer.from(token,"base64url");
      if(decoded.toString("base64url")!==token)throw Error();
      cursor=JSON.parse(decoded.toString("utf8"));
      if(!cursor||Array.isArray(cursor)||Object.keys(cursor).sort().join(",")!=="b,d,f,h,m,s,v"||cursor.v!==1||!(pair(cursor.h)||cursor.h===null)||!(pair(cursor.b)||cursor.b===null)||
        (cursor.h===null&&cursor.b!==null)||(cursor.b===null&&cursor.d!=="current")||(cursor.b!==null&&cursor.b[0]>cursor.h[0])||!["older","newer","current"].includes(cursor.d)||!Number.isSafeInteger(cursor.s)||cursor.s<0||cursor.s>now()+1000||
        typeof cursor.f!=="string"||!/^[a-f0-9]{64}$/.test(cursor.f)||(cursor.m!==null&&(typeof cursor.m!=="string"||!/^[a-f0-9]{64}$/.test(cursor.m))))throw Error();
    }catch{throw problem(400,"invalid history cursor");}
    if(cursor.f!==fingerprint)throw problem(409,"history filters or estate changed; restart from latest");
    for(const key of [cursor.h,cursor.b].filter(Boolean))if(anchor(key[0])!==key[1])throw problem(409,"history ordering changed; restart from latest");
    continued=true;snapshotAt=cursor.s;highWater=cursor.h;boundary=cursor.b?cursor.b[0]:null;direction=cursor.d;expectedMembership=cursor.m;
  }
  const result=query({highWater:highWater?highWater[0]:0,snapshotAt,boundary,direction,limit});
  if(continued&&expectedMembership!==(result.membership||null))throw problem(409,"retained history membership changed; restart from latest");
  const rows=result.rows;
  const token=(row,d)=>Buffer.from(JSON.stringify({v:1,f:fingerprint,s:snapshotAt,h:highWater,b:row?[row.history_rowid,row.id]:null,d,m:result.membership||null})).toString("base64url");
  const first=rows[0],last=rows[rows.length-1];
  return {rows,page:{limit,returned:rows.length,total:result.total,order:"recorded-desc",snapshotAt,
    hasNext:!!result.hasNext,hasPrevious:!!result.hasPrevious,currentCursor:token(first,"current"),
    nextCursor:result.hasNext?token(last,"older"):null,
    previousCursor:result.hasPrevious?token(first,"newer"):null}};
}
function boundedPage(value){
  // Leave headroom below the console client's 4 MiB transport ceiling.
  if(Buffer.byteLength(JSON.stringify(value))>3*1024*1024)throw problem(413,"history page exceeds response budget; choose a smaller limit");
  return value;
}
module.exports={paginate,compact,boundedPage,problem};
