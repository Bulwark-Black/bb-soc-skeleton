"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const zlib = require("node:zlib"), { promisify } = require("node:util");
const gunzip = promisify(zlib.gunzip);
const http = require("node:http"), https = require("node:https"), tls = require("node:tls"), net = require("node:net");
const { openOutbox } = require("./integration-outbox");
const { readSourceTokenFile } = require("./integration-client");
const { normalizeVendorPayload } = require("./vendor-adapters");
const { validateBaseUrl } = require("./agent-mcp");
const ROOT = path.resolve(__dirname, ".."), MAX_BODY = 8 * 1024 * 1024, MAX_FRAME = 65536;
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const plain = v => v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
function keys(v, names) { if (!plain(v) || Object.keys(v).some(k => !names.includes(k))) throw new TypeError("Unsupported gateway configuration fields."); }
function absolute(v) {
  if (typeof v !== "string" || !path.isAbsolute(v) || path.resolve(v) !== v || v === path.parse(v).root || v === ROOT || v.startsWith(ROOT + path.sep)) throw new TypeError("Use a canonical external absolute path.");
  return v;
}
function privateFile(filename, max = 1048576) {
  absolute(filename);
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > max || stat.mode & 0o077
      || process.getuid && stat.uid !== process.getuid() || fs.realpathSync(filename) !== filename) throw new TypeError("Use an owner-only regular external file without links.");
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw new TypeError("Private file changed.");
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}
function privateBind(host) {
  if (host === "localhost" || host === "::1") return true;
  if (net.isIP(host) === 6) return /^(?:fc|fd)[0-9a-f:]+$/i.test(host);
  if (net.isIP(host) !== 4) return false;
  const [a,b] = host.split(".").map(Number);
  return a === 127 || a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127;
}
function configuration(v) {
  keys(v, ["schemaVersion", "baseUrl", "sourceId", "appId", "tokenFile", "outboxDirectory", "stateDirectory", "listener", "adapterId", "authTokenFile"]);
  if (v.schemaVersion !== 1) throw new TypeError("Gateway schemaVersion must be 1.");
  for (const k of ["sourceId","appId"]) if (typeof v[k] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v[k])) throw new TypeError("Source and application IDs are required.");
  for (const k of ["tokenFile","outboxDirectory","stateDirectory"]) absolute(v[k]);
  const roots = [v.outboxDirectory, v.stateDirectory];
  if (roots[0] === roots[1] || roots.some((p,i) => roots[1-i].startsWith(p+path.sep) || v.tokenFile.startsWith(p+path.sep))) throw new TypeError("Gateway state, outbox and token locations must be separate.");
  keys(v.listener, ["protocol","host","port","tls","clientFingerprints"]);
  const l = v.listener;
  if (!["otlp-http","syslog-tls"].includes(l.protocol) || !privateBind(l.host) || !Number.isInteger(l.port) || l.port < 0 || l.port > 65535) throw new TypeError("Select a supported protocol and explicit private bind address/port.");
  if (l.port === 0 && !["127.0.0.1","::1","localhost"].includes(l.host)) throw new TypeError("Ephemeral ports are only for loopback.");
  if (l.tls !== undefined) {
    keys(l.tls, ["keyFile","certFile","caFile"]);
    for (const k of ["keyFile","certFile"]) absolute(l.tls[k]);
    if (l.tls.caFile !== undefined) absolute(l.tls.caFile);
  }
  if (!l.tls && !["127.0.0.1","::1","localhost"].includes(l.host)) throw new TypeError("Private remote listeners require verified TLS.");
  if (l.protocol === "otlp-http") {
    if (v.adapterId !== "otlp-logs" || l.clientFingerprints !== undefined) throw new TypeError("OTLP HTTP requires its exact adapter.");
    absolute(v.authTokenFile);
    if (roots.some(p => v.authTokenFile.startsWith(p+path.sep))) throw new TypeError("Keep the gateway token outside state directories.");
  } else {
    if (!["syslog-rfc5424","cef"].includes(v.adapterId) || !l.tls?.caFile || v.authTokenFile !== undefined
        || !Array.isArray(l.clientFingerprints) || !l.clientFingerprints.length || l.clientFingerprints.length > 100
        || l.clientFingerprints.some(x => typeof x !== "string" || !/^[a-f0-9]{64}$/.test(x))
        || new Set(l.clientFingerprints).size !== l.clientFingerprints.length) throw new TypeError("Syslog requires TLS, a client CA and explicit SHA-256 client certificate fingerprints.");
  }
  return { ...v, baseUrl: validateBaseUrl(v.baseUrl) };
}
function stateDirectory(dir) {
  absolute(dir); fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const st=fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || fs.realpathSync(dir)!==dir || st.mode&0o077 || process.getuid&&st.uid!==process.getuid()) throw new TypeError("Gateway state directory must be private and owned by this user.");
  if (fs.readdirSync(dir).some(n=>!["binding.json","health.json","health.tmp"].includes(n))) throw new TypeError("Use a dedicated gateway state directory.");
}
function bindState(dir, v) {
  stateDirectory(dir);
  const file=path.join(dir,"binding.json"), value=JSON.stringify(v);
  if (fs.existsSync(file)) { if (privateFile(file).toString()!==value) throw new TypeError("Gateway destination or listener binding changed; preserve the old queue and use a new state directory."); }
  else fs.writeFileSync(file,value,{flag:"wx",mode:0o600});
}
function octetFramer(onFrame) {
  let buffer=Buffer.alloc(0), length=null;
  return {
    feed(chunk) {
      if (!Buffer.isBuffer(chunk)) chunk=Buffer.from(chunk);
      // Process bounded chunks; a peer cannot allocate a single unbounded frame.
      for(let pos=0;pos<chunk.length;pos+=MAX_FRAME) {
        buffer=Buffer.concat([buffer,chunk.subarray(pos,pos+MAX_FRAME)]);
        for (;;) {
          if(length===null) {
            const at=buffer.indexOf(32);
            if(at===-1) { if(buffer.length>6 || !/^[1-9][0-9]*$/.test(buffer.toString())) throw new TypeError("Invalid syslog octet count."); break; }
            const text=buffer.subarray(0,at).toString("ascii");
            if(!/^[1-9][0-9]{0,5}$/.test(text) || Number(text)>MAX_FRAME) throw new TypeError("Invalid syslog octet count.");
            length=Number(text);buffer=buffer.subarray(at+1);
          }
          if(buffer.length<length)break;
          const frame=buffer.subarray(0,length);buffer=buffer.subarray(length);length=null;
          onFrame(new TextDecoder("utf-8",{fatal:true}).decode(frame));
          if(!buffer.length)break;
        }
      }
    },
    finish() { if(buffer.length || length!==null) throw new TypeError("Incomplete syslog frame."); }
  };
}
function response(res,status,message) {
  res.writeHead(status,{"Content-Type":"application/json","Cache-Control":"no-store"});
  res.end(JSON.stringify(status===200?{}:{code:({400:3,401:16,403:7,404:12,413:8,415:3,503:14})[status]||13,message}));
}
async function startGateway(value, options={}) {
  const v=configuration(value);
  readSourceTokenFile(v.tokenFile);
  const gatewayToken=v.authTokenFile?readSourceTokenFile(v.authTokenFile):null;
  const tlsOptions=v.listener.tls?{ key:privateFile(v.listener.tls.keyFile),cert:privateFile(v.listener.tls.certFile),
    ...(v.listener.tls.caFile?{ca:privateFile(v.listener.tls.caFile)}:{}),minVersion:"TLSv1.2"}:null;
  bindState(v.stateDirectory,{schemaVersion:1,baseUrl:v.baseUrl,sourceId:v.sourceId,appId:v.appId,adapterId:v.adapterId,
    outboxDirectory:v.outboxDirectory,listener:v.listener});
  const outbox=options.outbox||openOutbox(v.outboxDirectory);
  let accepted=0,rejected=0,active=0,closed=false,lastEnqueuedAt=null,lastDeliveryAt=null,draining=null;
  const sockets=new Set();
  function health() {
    const status={schemaVersion:1,sourceId:v.sourceId,adapterId:v.adapterId,accepted,rejected,lastEnqueuedAt,lastDeliveryAt,
      collectionCoverage:"received-messages-only",queue:outbox.list({limit:1}).totals};
    const tmp=path.join(v.stateDirectory,"health.tmp"),file=path.join(v.stateDirectory,"health.json");
    // The directory is owned by this process user; never follow a leftover symlink.
    for(const p of [tmp,file]) if(fs.existsSync(p))privateFile(p);
    fs.writeFileSync(tmp,JSON.stringify(status),{mode:0o600,flag:"w"});fs.renameSync(tmp,file);return status;
  }
  function enqueue(payload) {
    const mapped=normalizeVendorPayload(v.adapterId,payload,{sourceId:v.sourceId,estateId:v.appId});
    const batch={...mapped.batch,sentAt:new Date().toISOString()};
    batch.receiptId="gateway:"+hash(JSON.stringify(batch));
    const result=outbox.enqueue(batch,v.baseUrl);
    accepted+=batch.records.length;lastEnqueuedAt=batch.sentAt;
    // If health reporting fails after enqueue, the client may retry; stable
    // canonical record identities still prevent duplicate retained events.
    try { health(); } catch { /* Queue acceptance remains authoritative. */ } return result;
  }
  async function drain() {
    if(draining || closed)return draining;
    draining=(async()=>{
      const r=await outbox.drain({baseUrl:v.baseUrl,sourceId:v.sourceId,tokenFile:v.tokenFile,limit:10});
      if(r.results.some(x=>x.state==="delivered"))lastDeliveryAt=new Date().toISOString();
      health();
    })().catch(()=>{rejected++;try{health();}catch{}}).finally(()=>{draining=null;});
    return draining;
  }
  let server;
  if(v.listener.protocol==="otlp-http") {
    const handler=async(req,res)=>{
      if(active>=2) {req.resume();response(res,503,"Receiver is busy; retry.");return;}
      active++;
      try {
        if(req.method!=="POST" || req.url!=="/v1/logs") {req.resume();response(res,404,"Use POST /v1/logs.");return;}
        const count=name=>req.rawHeaders.filter((_,i)=>i%2===0&&req.rawHeaders[i].toLowerCase()===name).length;
        const auth=req.headers.authorization,expected="Bearer "+gatewayToken;
        if(count("authorization")!==1 || typeof auth!=="string" || Buffer.byteLength(auth)!==Buffer.byteLength(expected)
            || !crypto.timingSafeEqual(Buffer.from(auth),Buffer.from(expected)) || req.headers.cookie!==undefined) {
          req.resume();response(res,401,"Gateway credential required.");return;
        }
        if(count("content-type")!==1 || req.headers["content-type"]?.split(";")[0].trim().toLowerCase()!=="application/json"
            || count("content-encoding")>1 || ![undefined,"gzip"].includes(req.headers["content-encoding"])) {req.resume();response(res,415,"Only OTLP JSON logs, optionally gzip-compressed, are supported.");return;}
        const declared=req.headers["content-length"];
        if(declared!==undefined && (!/^[0-9]+$/.test(declared)||Number(declared)>MAX_BODY)) {req.resume();response(res,413,"Request too large.");return;}
        let size=0;const chunks=[];
        for await(const chunk of req) {
          size+=chunk.length;
          if(size>MAX_BODY) {response(res,413,"Request too large.");req.destroy();return;}
          chunks.push(chunk);
        }
        const raw=Buffer.concat(chunks);
        const decoded=req.headers["content-encoding"]==="gzip"?await gunzip(raw,{maxOutputLength:MAX_BODY}):raw;
        const payload=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(decoded));
        // OTLP allows a keepalive export with no records; it must not become
        // a source-health proof or synthetic log. Reject unknown root keys.
        if(plain(payload)&&Object.keys(payload).every(k=>k==="resourceLogs")&&(!payload.resourceLogs||Array.isArray(payload.resourceLogs)&&payload.resourceLogs.length===0)) {response(res,200);return;}
        enqueue(payload);response(res,200);
      } catch(error) {
        rejected++;
        if(!res.headersSent)response(res,error.code==="ERR_BUFFER_TOO_LARGE"?413:/capacity|database|SQLITE|readonly|disk/i.test(error.message||"")?503:400,"Export was not acknowledged; inspect receiver status and retry only retryable errors.");
        try{health();}catch{}
      } finally {active--;}
    };
    server=tlsOptions?https.createServer(tlsOptions,handler):http.createServer(handler);
    server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=5000;
  } else {
    server=tls.createServer({...tlsOptions,requestCert:true,rejectUnauthorized:true},socket=>{
      const cert=socket.getPeerCertificate(),fingerprint=cert.raw?hash(cert.raw):"";
      if(!socket.authorized || !v.listener.clientFingerprints.includes(fingerprint)){rejected++;socket.destroy();return;}
      const framer=octetFramer(message=>enqueue(message));socket.setTimeout(15000,()=>socket.destroy());
      socket.on("data",chunk=>{try{framer.feed(chunk);}catch{rejected++;socket.destroy();try{health();}catch{}}});
      socket.on("end",()=>{try{framer.finish();}catch{rejected++;try{health();}catch{}}});
      socket.on("error",()=>{});
    });
    server.on("tlsClientError",()=>{rejected++;});
  }
  server.maxConnections=32;
  server.on("connection",socket=>{sockets.add(socket);socket.on("close",()=>sockets.delete(socket));});
  try {
    await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(v.listener.port,v.listener.host,resolve);});
    health();
  } catch(error) { for(const socket of sockets)socket.destroy();server.close();outbox.close();throw error; }
  const timer=setInterval(drain,5000);timer.unref();
  return {address:server.address(),health,drain,async close(){
    closed=true;clearInterval(timer);for(const socket of sockets)socket.destroy();
    await new Promise(resolve=>server.close(resolve));if(draining)await draining;outbox.close();
  }};
}
module.exports={configuration,privateFile,privateBind,octetFramer,startGateway,MAX_BODY,MAX_FRAME};
