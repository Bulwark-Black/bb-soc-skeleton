"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), http = require("node:http"), crypto = require("node:crypto");
const { promisify } = require("node:util"), { execFile } = require("node:child_process");
const { MonitorStore } = require("../server/native-monitor/store");
const { createHostRegistry } = require("../server/native-monitor/registry");
const { createWebsites } = require("../server/native-monitor/websites");
const execute = promisify(execFile), script = path.join(__dirname, "../tools/native-monitor/website-probe.py");
const load = `import importlib.util, sys, os
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1]).parent))
spec=importlib.util.spec_from_file_location("website_probe",sys.argv[1])
w=importlib.util.module_from_spec(spec); spec.loader.exec_module(w)
os.umask(0o077)
`;
const env = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };

test("website probes use verified TLS, GET, a wall deadline and at most three same-origin redirects without reading bodies", async () => {
  const program = load + `
import ssl
seen=[]
expiry="2030-01-01T00:00:00.000Z"
def request(url,timeout):
    seen.append(url)
    assert 0<timeout<=5
    return {"status":302 if len(seen)<4 else 200,"location":"/next?secret=not-retained","certNotAfter":expiry}
result=w.probe("https://example.invalid/",request_fn=request)
assert result["status"]==200 and result["error"] is None and len(seen)==4
assert "secret" not in result["redirect"] and result["certNotAfter"]==expiry
seen.clear()
def escaped(url,timeout):
    seen.append(url)
    return {"status":302,"location":"https://foreign.example.invalid/","certNotAfter":expiry}
result=w.probe("https://example.invalid/",request_fn=escaped)
assert len(seen)==1 and result["error"]=="redirect-outside-configured-origin"
assert result["redirect"] is None
seen.clear()
def forever(url,timeout):
    seen.append(url)
    return {"status":302,"location":"/loop","certNotAfter":expiry}
assert w.probe("https://example.invalid/",request_fn=forever)["error"]=="redirect-limit-exceeded"
assert len(seen)==4
def denied(url,timeout): raise ssl.SSLCertVerificationError("private transport details")
assert w.probe("https://example.invalid/",request_fn=denied)["error"]=="tls-verification-failed"
def timedout(url,timeout): raise TimeoutError("private transport details")
assert w.probe("https://example.invalid/",request_fn=timedout)["error"]=="probe-timeout"
class Socket:
    def getpeercert(self): return {"notAfter":"Jan  1 00:00:00 2030 GMT"}
class Response:
    status=200
    def getheader(self,key): assert key=="Location"; return None
    def read(self,*args): raise AssertionError("body must never be read")
class Connection:
    def __init__(self,host,port,timeout,context):
        assert host=="example.invalid" and port==443 and context.check_hostname
        assert context.verify_mode==ssl.CERT_REQUIRED
        self.sock=Socket()
    def connect(self): pass
    def request(self,method,path,headers):
        assert method=="GET" and path=="/path"
        assert not any(k.lower() in ("authorization","cookie") for k in headers)
    def getresponse(self): return Response()
    def close(self): pass
w.http.client.HTTPSConnection=Connection
result=w.request_once("https://example.invalid/path",5)
assert result["status"]==200 and result["certNotAfter"]==expiry
print("ok")
`;
  const result = await execute("python3", ["-c", program, script], { env }); assert.equal(result.stdout.trim(), "ok");
});

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "website-sender-test-"));
  const token = crypto.randomBytes(32).toString("base64url"), tokenFile = path.join(directory, "credential");
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  const registry = createHostRegistry({ hosts: [{ id: "resource-test", sourceId: "source-test", appId: "app-test", label: "Synthetic observer" }] });
  let now = Date.now(), store, websites, drop = false, corrupt = false, forcedStatus = null;
  const open = () => { store = new MonitorStore({ data: path.join(directory, "monitor"), registry, minFreeBytes: 0, now: () => now }); websites = createWebsites(store, [{ id: "site-test", host: "resource-test", url: "https://example.invalid/", label: "Synthetic website" }]); };
  open();
  const received = [], server = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString(); received.push(raw);
    assert.equal(request.url, "/api/v1/monitor/websites"); assert.equal(request.headers.authorization, "Bearer " + token);
    if (forcedStatus) { response.writeHead(forcedStatus, { "Content-Type": "application/json" }); response.end("{}"); return; }
    const body = JSON.parse(raw);
    try {
      const receipt = websites.ingest(body.host, body.sourceId, body.batch);
      if (drop) { drop = false; request.socket.destroy(); return; }
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(corrupt ? { ...receipt, digest: "0".repeat(64) } : receipt));
    } catch (error) { response.writeHead(error.status || 500, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const config = { schemaVersion: 1, host: "resource-test", sourceId: "source-test", consoleUrl: "http://127.0.0.1:" + server.address().port, tokenFile, targets: ["https://example.invalid/"] };
  const configFile = path.join(directory, "configuration.json"), queueDir = path.join(directory, "queue");
  fs.writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
  async function command(mode, extra = []) {
    let result;
    try { result = { ...await execute("python3", [script, mode, "--config", configFile, "--queue-dir", queueDir, ...extra], { env, timeout: 15000 }), code: 0 }; }
    catch (error) { result = { code: error.code, stdout: error.stdout || "", stderr: error.stderr || "" }; }
    assert.ok(!(result.stdout + result.stderr).includes(token));
    return { ...result, value: result.stdout.trim() ? JSON.parse(result.stdout) : null };
  }
  async function collect(status = 503) {
    // No configured target is contacted. Only synthetic injected probe results
    // enter the actual durable queue; send uses the local test HTTP server.
    now = Date.now();
    const program = load + `
cfg=w.load_config(sys.argv[2]); queue=w.Queue(Path(sys.argv[3]),cfg,lane="websites",binding_extra=sorted(cfg["targets"]))
def synthetic(url): return {"url":url,"at":w.stamp(),"status":int(sys.argv[4]),"ms":23,"error":None,"redirect":None,"certNotAfter":"2030-01-01T00:00:00.000Z"}
try: print(w.encode(w.collect(queue,cfg,reviewed_targets=True,probe_fn=synthetic)))
finally: queue.close()
`;
    const result = await execute("python3", ["-c", program, script, configFile, queueDir, String(status)], { env });
    now = Date.now(); return JSON.parse(result.stdout);
  }
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, config, configFile, queueDir, command, collect, received,
    drop() { drop = true; }, corrupt(value) { corrupt = value; }, force(value) { forcedStatus = value; }, advance(ms) { now += ms; },
    restart() { store.close(); open(); }, stats() { return { receipts: store.db.prepare("SELECT count(*) n FROM website_receipts").get().n, points: store.db.prepare("SELECT count(*) n FROM website_points").get().n }; },
    current() { return websites.list().websites[0]; } };
}

test("website sender durably replays lost receipts after restart and admission age without reprobes or double-counted failures", async t => {
  const f = await fixture(t), collected = await f.collect(); assert.equal(collected.state, "pending");
  f.drop(); assert.equal((await f.command("send")).code, 1); assert.deepEqual(f.stats(), { receipts: 1, points: 1 });
  assert.equal((await f.command("status")).value.counts.pending, 1); f.advance(3 * 86400000); f.restart();
  const replay = await f.command("send"); assert.equal(replay.code, 0, replay.stderr); assert.equal(replay.value.counts.delivered, 1);
  assert.equal(f.received.length, 2); assert.equal(f.received[0], f.received[1]); assert.deepEqual(f.stats(), { receipts: 1, points: 1 });
  assert.equal(f.current().failStreak, 1); assert.equal(f.current().state, "unknown", "old replay cannot renew health freshness");
  await f.collect(200); f.corrupt(true); assert.equal((await f.command("send")).code, 1);
  f.corrupt(false); assert.equal((await f.command("send")).code, 0);
  assert.deepEqual(f.stats(), { receipts: 2, points: 2 }); assert.equal((await f.command("status")).value.retained, 2);
});

test("website collection requires reviewed targets and an unchanged private source/destination/target queue binding", async t => {
  const f = await fixture(t);
  assert.equal((await f.command("collect")).code, 2); assert.equal(f.received.length, 0);
  await f.collect();
  for (const change of [{ targets: ["https://other.example.invalid/"] }, { host: "foreign-host" }, { consoleUrl: "http://127.0.0.1:9" }]) {
    fs.writeFileSync(f.configFile, JSON.stringify({ ...f.config, ...change })); assert.equal((await f.command("status")).code, 1);
  }
  for (const target of ["http" + "://example.invalid/", "https://user:pass@example.invalid/", "https://example.invalid/?secret=value"]) {
    fs.writeFileSync(f.configFile, JSON.stringify({ ...f.config, targets: [target] })); assert.equal((await f.command("status")).code, 1);
  }
  fs.writeFileSync(f.configFile, JSON.stringify(f.config)); fs.chmodSync(f.configFile, 0o644);
  assert.equal((await f.command("status")).code, 1); assert.equal(f.received.length, 0);
});

test("website abandonment requires an explicit reason, preserves original batch, and permits later receipts", async t => {
  const f = await fixture(t), original = await f.collect(503);
  f.force(400); assert.equal((await f.command("send")).code, 1);
  const next = await f.collect(200); f.force(null);
  assert.equal((await f.command("send")).code, 1, "blocked batch still prevents overtaking");
  assert.equal((await f.command("abandon", ["--batch-id", original.id])).code, 2);
  const reason = "Reviewed rejected observation; retain its original evidence and resume subsequent probes.";
  assert.equal((await f.command("abandon", ["--batch-id", original.id, "--reason", reason])).value.state, "abandoned");
  assert.equal((await f.command("retry", ["--batch-id", original.id])).code, 1);
  assert.equal((await f.command("send")).code, 0); assert.equal(f.stats().receipts, 1);
  assert.deepEqual((await f.command("status")).value.counts, { abandoned: 1, blocked: 0, delivered: 1, pending: 0 });
  const { DatabaseSync } = require("node:sqlite"), db = new DatabaseSync(path.join(f.queueDir, "websites.sqlite"));
  try { const row = db.prepare("SELECT * FROM events WHERE id=?").get(original.id);
    assert.equal(row.abandoned_reason, reason); assert.ok(Number.isFinite(Date.parse(row.abandoned_at)));
    assert.equal(JSON.parse(row.body).checks[0].status, 503); assert.equal(row.id, original.id);
    assert.equal(db.prepare("SELECT count(*) n FROM events").get().n, 2);
  } finally { db.close(); }
  assert.equal((await f.command("abandon", ["--batch-id", next.id, "--reason", reason])).code, 1);
});
