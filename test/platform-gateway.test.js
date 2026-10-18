"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),crypto=require("node:crypto"),tls=require("node:tls");
const {execFileSync}=require("node:child_process");
const {configuration,octetFramer,startGateway}=require("../tools/platform-gateway");
const {openOutbox}=require("../tools/integration-outbox");
function fixture(t){
 const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),"bb-gateway-")),token=crypto.randomBytes(32).toString("base64url");
 const tokenFile=path.join(dir,"source-token"),authTokenFile=path.join(dir,"gateway-token");
 fs.writeFileSync(tokenFile,token,{mode:0o600});fs.writeFileSync(authTokenFile,token,{mode:0o600});
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 return {dir,token,config:{schemaVersion:1,sourceId:"synthetic-source",appId:"synthetic-app",baseUrl:"http://127.0.0.1:9",
 tokenFile,authTokenFile,outboxDirectory:path.join(dir,"outbox"),stateDirectory:path.join(dir,"state"),adapterId:"otlp-logs",
 listener:{protocol:"otlp-http",host:"127.0.0.1",port:0}}};
}
function payload(at=Date.now()){return {resourceLogs:[{scopeLogs:[{logRecords:[{timeUnixNano:(BigInt(at)*1000000n).toString(),body:{stringValue:"Synthetic gateway evidence"}}]}]}]};}
test("gateway validates protocol, private binding, authentication and separate state locations",t=>{
 const f=fixture(t);assert.equal(configuration(f.config).sourceId,"synthetic-source");
 for(const value of [{...f.config,authTokenFile:undefined},{...f.config,outboxDirectory:f.config.stateDirectory},
 {...f.config,listener:{protocol:"otlp-http",host:"192.0.2.1",port:4318}},
 {...f.config,adapterId:"cef"},{...f.config,listener:{protocol:"syslog-tls",host:"127.0.0.1",port:0}}]){
  assert.throws(()=>configuration(value));
 }
});
test("RFC5425 framing preserves split UTF-8 frames, handles coalescing, and rejects unbounded/truncated input",()=>{
 const seen=[],f=octetFramer(x=>seen.push(x)),a=Buffer.from("hello é"),b=Buffer.from("second");
 const wire=Buffer.concat([Buffer.from(a.length+" "),a,Buffer.from(b.length+" "),b]);
 for(const byte of wire)f.feed(Buffer.from([byte]));f.finish();assert.deepEqual(seen,["hello é","second"]);
 for(const wire of ["0 ","01 x","999999 x","abc ","7 abc"]){const frame=octetFramer(()=>{});assert.throws(()=>{frame.feed(Buffer.from(wire));frame.finish();});}
 assert.throws(()=>octetFramer(()=>{}).feed(Buffer.from([49,32,255])));
});
test("OTLP HTTP acknowledges durable queueing, refuses bad authority/input and preserves queued batches across restart",async t=>{
 const f=fixture(t);let gateway=await startGateway(f.config);t.after(async()=>{if(gateway)await gateway.close();});
 const post=(body,headers={})=>fetch("http://127.0.0.1:"+gateway.address.port+"/v1/logs",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+f.token,...headers},body:typeof body==="string"?body:JSON.stringify(body)});
 const input=payload(),old=payload(Date.parse("2024-01-01T00:00:00Z"));
 let r=await post(input,{Authorization:"Bearer missing"});assert.equal(r.status,401);await r.arrayBuffer();
 r=await post(input,{Cookie:"synthetic=true"});assert.equal(r.status,401);await r.arrayBuffer();
 r=await post(input,{"Content-Type":"application/x-protobuf"});assert.equal(r.status,415);await r.arrayBuffer();
 r=await post("{broken}");assert.equal(r.status,400);await r.arrayBuffer();
 r=await post({resourceLogs:[]});assert.equal(r.status,200);assert.deepEqual(await r.json(),{});assert.equal(gateway.health().accepted,0);
 r=await post(old);assert.equal(r.status,200);assert.deepEqual(await r.json(),{});
 r=await post(input);assert.equal(r.status,200);await r.arrayBuffer();
 assert.equal(gateway.health().accepted,2);assert.equal(gateway.health().lastDeliveryAt,null);
 await gateway.close();gateway=null;
 const queue=openOutbox(f.config.outboxDirectory);assert.equal(queue.list().totals.find(x=>x.state==="pending").entries,2);queue.close();
 const Database=require("better-sqlite3"),db=new Database(path.join(f.config.outboxDirectory,"outbox.sqlite"),{readonly:true});
 const saved=db.prepare("SELECT body FROM deliveries").all().map(x=>JSON.parse(x.body));db.close();
 assert.ok(saved.every(x=>Date.parse(x.sentAt)>Date.now()-10000));
 assert.ok(saved.some(x=>x.records[0].observedAt.startsWith("2024-")));
 gateway=await startGateway(f.config);r=await post(input);assert.equal(r.status,200);await r.arrayBuffer();
 const db2=new Database(path.join(f.config.outboxDirectory,"outbox.sqlite"),{readonly:true});
 const batches=db2.prepare("SELECT body FROM deliveries").all().map(x=>JSON.parse(x.body));db2.close();
 assert.equal(new Set(batches.flatMap(x=>x.records.map(y=>y.recordId))).size,2,"retries retain event identity even with new queue receipt");
 await gateway.close();gateway=null;
 await assert.rejects(startGateway({...f.config,sourceId:"different-source"}),/binding changed/);
});
test("queue refusal is retryable and never returns a false OTLP success",async t=>{
 const f=fixture(t);const outbox={enqueue(){throw new Error("Outbox capacity reached");},list(){return {totals:[]};},close(){},async drain(){return{results:[]};}};
 const g=await startGateway(f.config,{outbox});t.after(()=>g.close());
 const r=await fetch("http://127.0.0.1:"+g.address.port+"/v1/logs",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+f.token},body:JSON.stringify(payload())});
 assert.equal(r.status,503);assert.equal(g.health().accepted,0);assert.equal(g.health().rejected,1);
});
test("syslog TLS authenticates certificate fingerprint before durably admitting frames",async t=>{
 const f=fixture(t),keyFile=path.join(f.dir,"tls.key"),certFile=path.join(f.dir,"tls.crt");
 execFileSync("openssl",["req","-x509","-newkey","rsa:2048","-nodes","-days","1","-subj","/CN=localhost","-addext","subjectAltName=DNS:localhost","-keyout",keyFile,"-out",certFile],{stdio:"ignore"});
 fs.chmodSync(keyFile,0o600);fs.chmodSync(certFile,0o600);
 const cert=fs.readFileSync(certFile),key=fs.readFileSync(keyFile),fingerprint=new crypto.X509Certificate(cert).fingerprint256.replaceAll(":","").toLowerCase();
 const config={...f.config,adapterId:"syslog-rfc5424",listener:{protocol:"syslog-tls",host:"127.0.0.1",port:0,tls:{keyFile,certFile,caFile:certFile},clientFingerprints:[fingerprint]}};
 delete config.authTokenFile;
 const g=await startGateway(config);t.after(()=>g.close());
 const message=Buffer.from("<34>1 "+new Date().toISOString()+" synthetic-host sshd 1 event - Synthetic TLS event");
 await new Promise((resolve,reject)=>{
  const socket=tls.connect({host:"127.0.0.1",port:g.address.port,servername:"localhost",ca:cert,cert,key},()=>{
   socket.end(Buffer.concat([Buffer.from(message.length+" "),message]));
  });socket.on("error",reject);socket.on("close",resolve);
 });
 assert.equal(g.health().accepted,1);
 await new Promise(resolve=>{
  const socket=tls.connect({host:"127.0.0.1",port:g.address.port,servername:"localhost",ca:cert},()=>socket.end(Buffer.concat([Buffer.from(message.length+" "),message])));
  socket.on("error",()=>{});socket.on("close",resolve);
 });
 assert.equal(g.health().accepted,1,"missing client certificate cannot submit an event");
});

test("OTLP gzip exports use bounded decompression and standard error codes",async t=>{
 const f=fixture(t),g=await startGateway(f.config);t.after(()=>g.close());
 const post=body=>fetch("http://127.0.0.1:"+g.address.port+"/v1/logs",{method:"POST",headers:{"Content-Type":"application/json","Content-Encoding":"gzip",Authorization:"Bearer "+f.token},body});
 const {gzipSync}=require("node:zlib");let r=await post(gzipSync(JSON.stringify(payload())));assert.equal(r.status,200);await r.arrayBuffer();assert.equal(g.health().accepted,1);
 r=await post(gzipSync(Buffer.alloc(8*1024*1024+1,32)));assert.equal(r.status,413);assert.equal((await r.json()).code,8);
 r=await post(Buffer.from("invalid compressed data"));assert.equal(r.status,400);assert.equal((await r.json()).code,3);
});
