"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { spawnSync } = require("node:child_process");
const YAML = require("yaml");
const { VERSION, validateManifest, commandSteps, schema } = require("../tools/deployment/manifest");
const { renderBundle } = require("../tools/deployment/render");
const { generate, parseArguments } = require("../tools/generate-deployment");
const { acquire, cycle, checkBinding, runStep } = require("../tools/deployment/worker");
const { stage } = require("../tools/deployment/stage-private");
const fixture = changes => ({ schemaVersion: 1, packVersion: VERSION, name: "example-logs", role: "server-logs", targets: ["systemd", "ansible"], sourceId: "source-example", appId: "application-example", installDirectory: "/srv/bb soc", privateDirectory: "/etc/bb soc", storageDirectory: "/srv/state/bb soc", stateDirectory: "/srv/state/bb soc/state", outboxDirectory: "/srv/state/bb soc/outbox", configFile: "/etc/bb soc/collector.json", tokenFile: "/etc/bb soc/source-token", baseUrl: "http://localhost:8080", runtime: { node: "/usr/bin/node" }, account: { name: "bbcollector", uid: 10001, gid: 10001 }, schedule: { intervalSeconds: 60, timeoutSeconds: 180 }, settings: { file: "/var/log/example app.log", format: "plain", maxRecords: 100 }, ...changes });
const container = (role = "server-logs", targets = ["container", "helm"]) => fixture({ role, targets, installDirectory: "/srv/bb-soc", privateDirectory: "/etc/bb-soc", storageDirectory: "/srv/state/bb-soc", stateDirectory: "/srv/state/bb-soc/state", outboxDirectory: "/srv/state/bb-soc/outbox", configFile: "/etc/bb-soc/collector.json", tokenFile: "/etc/bb-soc/source-token", settings: role === "server-logs" ? { file: "/var/log/example.log", format: "docker-json", maxRecords: 20 } : {}, image: "registry.example.invalid/bb-soc@sha256:" + "a".repeat(64), kubernetes: { namespace: "monitoring", nodeName: "node-example", secretName: "reviewed-private-files", ...(role === "protocol-gateway" ? { storageClaim: "gateway-state" } : {}) } });
const windows = () => fixture({ role: "windows-events", targets: ["windows-task"], installDirectory: "C:\\Program Files\\BB SOC", privateDirectory: "C:\\BB SOC Private", storageDirectory: "C:\\BB SOC State", stateDirectory: "C:\\BB SOC State\\state", outboxDirectory: "C:\\BB SOC State\\outbox", configFile: "C:\\BB SOC Private\\collector.json", tokenFile: "C:\\BB SOC Private\\source-token", runtime: { node: "C:\\Program Files\\nodejs\\node.exe", python: "C:\\Python313\\python.exe" }, account: { name: "bbcollector" }, settings: { channels: ["Security", "ForwardedEvents", "Microsoft-Windows-Windows Defender/Operational"], computers: ["server.example.invalid"], maxEvents: 16 } });
function temporary(t) { const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "bb-deployment-test-")); fs.chmodSync(directory, 0o700); t.after(() => fs.rmSync(directory, { recursive: true, force: true })); return directory; }

test("versioned inventory rejects unsupported fields, roles, paths, privileges and unpinned images", () => {
  assert.deepEqual(validateManifest(fixture()), fixture());
  for (const changes of [{ schemaVersion: 2 }, { packVersion: "2.0.0" }, { sourceToken: "fixture" }, { role: "shell" }, { targets: ["systemd", "systemd"] }, { account: { name: "root", uid: 1000, gid: 1000 } }, { account: { name: "bbcollector", uid: 0, gid: 0 } }, { settings: { file: "/var/log/a", format: "plain", maxRecords: 101 } }, { installDirectory: "/srv/../unsafe" }, { installDirectory: "/srv/$(id)" }, { stateDirectory: "/etc/bb soc/state" }, { tokenFile: "/etc/bb soc/collector.json" }, { baseUrl: "https://example.invalid" }, { runtime: { node: "/usr/bin/node", command: "synthetic" } }]) assert.throws(() => validateManifest(fixture(changes)), JSON.stringify(changes));
  const m = container(); for (const image of ["registry.example.invalid/bb-soc:latest", "sha256:abc", "registry.example.invalid/bb-soc@sha256:" + "z".repeat(64)]) assert.throws(() => validateManifest({ ...m, image }));
  assert.throws(() => validateManifest({ ...m, role: "native-monitor", runtime: { ...m.runtime, python: "/usr/bin/python3" }, settings: {}, outboxDirectory: m.stateDirectory + "/outbox" }), /container/);
  assert.throws(() => validateManifest({ ...windows(), settings: { ...windows().settings, channels: ["invented-channel"] } }));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(__dirname, "../deploy/integration-pack.schema.json"))), schema);
});

test("rendered systemd preserves argument boundaries and keeps schedules bounded and disabled until commissioning", () => {
  const m = fixture(), { files } = renderBundle(m), unit = files.get("systemd/bb-soc-example-logs.service");
  assert.match(unit, /ExecStart="\/usr\/bin\/node" "\/srv\/bb soc\/tools\/deployment\/worker.js" "--manifest" "\/etc\/bb soc\/deployment-pack.json" "--once"/);
  assert.match(unit, /User=bbcollector/); assert.match(unit, /UMask=0077/); assert.match(unit, /NoNewPrivileges=true/); assert.match(unit, /ProtectSystem=strict/); assert.match(unit, /KillMode=control-group/);
  assert.match(unit, /SuccessExitStatus=2/); assert.match(unit, /TimeoutStartSec=185/); assert.match(files.get("systemd/bb-soc-example-logs.timer"), /OnUnitInactiveSec=60s/);
  assert.doesNotMatch(files.get("systemd/install.sh"), /systemctl (enable|start)/);
  const argv = commandSteps(m)[0].args; assert.equal(argv[argv.indexOf("--file") + 1], m.settings.file); assert.equal(argv[argv.indexOf("--state-dir") + 1], m.stateDirectory);
  assert.equal(argv.includes("--reviewed-input"), true); assert.equal(argv.includes("--once"), true);
});

test("Windows XML is parseable, quotes executable arguments, stays least-privilege and prevents overlap", () => {
  const m = windows(), { files } = renderBundle(m), body = files.get("windows/bb-soc-example-logs.xml");
  const parsed = spawnSync("python3", ["-c", "import sys,json,xml.etree.ElementTree as E;r=E.fromstring(sys.stdin.read());n={'t':'http://schemas.microsoft.com/windows/2004/02/mit/task'};print(json.dumps({'command':r.find('.//t:Command',n).text,'arguments':r.find('.//t:Arguments',n).text,'enabled':r.find('./t:Settings/t:Enabled',n).text,'overlap':r.find('.//t:MultipleInstancesPolicy',n).text,'principal':r.find('.//t:RunLevel',n).text,'triggerChildren':[e.tag.split('}')[-1] for e in r.find('.//t:CalendarTrigger',n)]}))"], { input: body, encoding: "utf8" });
  assert.equal(parsed.status, 0, parsed.stderr); const data = JSON.parse(parsed.stdout);
  assert.equal(data.command, m.runtime.node); assert.equal(data.enabled, "false"); assert.equal(data.overlap, "IgnoreNew"); assert.equal(data.principal, "LeastPrivilege");
  assert.deepEqual(data.triggerChildren, ["Enabled", "StartBoundary", "Repetition", "ScheduleByDay"]);
  assert.equal(data.arguments, '"C:\\Program Files\\BB SOC\\tools\\deployment\\worker.js" "--manifest" "C:\\BB SOC Private\\deployment-pack.json" "--once"');
  assert.deepEqual(commandSteps(m).map(step => step.args[1]), ["send", "collect", "send"]);
  const cfg = JSON.parse(files.get("private/collector.json")); assert.deepEqual(cfg.channels, m.settings.channels); assert.equal(cfg.tokenFile, m.tokenFile); assert.equal(Object.hasOwn(cfg, "token"), false);
});

test("all supported Linux worker choices invoke actual fixed CLI contracts", () => {
  const native = fixture({ role: "native-monitor", settings: {}, runtime: { node: "/usr/bin/node", python: "/usr/bin/python3" }, outboxDirectory: "/srv/state/bb soc/state/outbox" });
  assert.deepEqual(commandSteps(native).map(step => step.args[1]), ["send", "collect", "send"]);
  const cloud = fixture({ role: "cloud-events", settings: {} }); assert.deepEqual(commandSteps(cloud).map(step => step.args[1]), ["drain", "collect", "drain"]);
  assert.ok(commandSteps(cloud).every(step => step.args.includes("--outbox-dir")));
  const gateway = fixture({ role: "protocol-gateway", settings: {} }), { files } = renderBundle(gateway);
  assert.equal(commandSteps(gateway)[0].args[0], "/srv/bb soc/tools/receive-platform.js");
  assert.equal(files.has("systemd/bb-soc-example-logs.timer"), false); assert.match(files.get("systemd/bb-soc-example-logs.service"), /Type=simple/);
});

test("Compose and Helm YAML parse and enforce non-root, persistent storage, role selection and one-node identity", () => {
  for (const role of ["server-logs", "cloud-events", "protocol-gateway"]) {
    const m = container(role), { files } = renderBundle(m);
    const compose = YAML.parse(files.get("container/compose.yaml")), service = compose.services.collector;
    assert.equal(service.image, m.image); assert.equal(service.read_only, true); assert.deepEqual(service.cap_drop, ["ALL"]); assert.equal(service.user, "10001:10001");
    assert.equal(service.network_mode, "host"); assert.equal(service.ports, undefined); assert.ok(service.volumes.some(volume => volume.target === m.storageDirectory && !volume.read_only));
    const workload = YAML.parse(files.get("helm/templates/workload.yaml")), pod = workload.spec.template.spec;
    assert.equal(workload.kind, role === "protocol-gateway" ? "Deployment" : "DaemonSet"); assert.deepEqual(workload.spec.selector.matchLabels, workload.spec.template.metadata.labels);
    assert.equal(pod.nodeSelector["kubernetes.io/hostname"], m.kubernetes.nodeName); assert.equal(pod.automountServiceAccountToken, false); assert.equal(pod.securityContext.runAsNonRoot, true); assert.equal(pod.securityContext.fsGroupChangePolicy, "OnRootMismatch");
    for (const c of [...pod.containers, ...pod.initContainers]) { assert.equal(c.image, m.image); assert.equal(c.securityContext.allowPrivilegeEscalation, false); assert.equal(c.securityContext.readOnlyRootFilesystem, true); assert.deepEqual(c.securityContext.capabilities.drop, ["ALL"]); }
    assert.equal(pod.initContainers[0].command[1], m.installDirectory + "/tools/deployment/stage-private.js");
    assert.equal(pod.initContainers[0].volumeMounts.find(v => v.name === "private").mountPath, "/bb-soc-private-volume");
    assert.equal(pod.initContainers[0].args[1], "/bb-soc-private-volume/private");
    assert.equal(pod.containers[0].volumeMounts.find(v => v.name === "private").subPath, "private");
    if (role === "protocol-gateway") { assert.equal(workload.spec.replicas, 1); assert.equal(workload.spec.strategy.type, "Recreate"); assert.equal(pod.volumes.find(v => v.name === "storage").persistentVolumeClaim.claimName, "gateway-state"); }
    else { assert.equal(workload.spec.updateStrategy.type, "OnDelete"); assert.equal(pod.volumes.find(v => v.name === "storage").hostPath.type, "Directory"); }
    if(role==="server-logs"){assert.ok(service.volumes.some(v=>v.target===path.posix.dirname(m.settings.file)&&v.read_only));assert.equal(pod.volumes.find(v=>v.name==="logs").hostPath.type,"Directory");assert.equal(pod.containers[0].volumeMounts.find(v=>v.name==="logs").mountPath,path.posix.dirname(m.settings.file));}
    const pack = YAML.parse(files.get("helm/templates/pack.yaml")); assert.deepEqual(JSON.parse(pack.data["deployment-pack.json"]), m);
  }
});

test("Ansible uses explicit inventory choice, restricted accounts, backups and no embedded credentials", () => {
  const { files } = renderBundle(fixture()), play = YAML.parse(files.get("ansible/install.yaml"))[0];
  assert.equal(play.hosts, "{{ bb_soc_target }}"); assert.equal(play.serial, 1);
  assert.ok(play.tasks.find(t => t["ansible.builtin.assert"]?.that.includes("bb_soc_enable is defined")));
  assert.equal(play.tasks.find(t => t["ansible.builtin.user"])["ansible.builtin.user"].shell, "/usr/sbin/nologin");
  assert.equal(play.tasks.find(t => t["ansible.builtin.copy"])["ansible.builtin.copy"].backup, true);
  const removed = YAML.parse(files.get("ansible/uninstall.yaml"))[0].tasks.find(t => t["ansible.builtin.file"]).loop;
  assert.ok(removed.every(file => file.startsWith("/etc/systemd/system/")));
  assert.doesNotMatch(files.get("systemd/uninstall.sh"), /rm[^\n]+(outbox|source-token|deployment-worker)/);
  assert.match(files.get("REVIEW.md"), /revoke the source credential/i);
});

test("generator check writes nothing and output is private, deterministic, atomic and never overwrites", t => {
  const directory = temporary(t), inventory = path.join(directory, "inventory.json"), output = path.join(directory, "bundle");
  fs.writeFileSync(inventory, JSON.stringify(fixture()), { mode: 0o600 });
  assert.equal(generate({ inventory, check: true }).applied, false); assert.deepEqual(fs.readdirSync(directory), ["inventory.json"]);
  assert.equal(generate({ inventory, output }).generated, true); assert.equal(fs.statSync(output).mode & 0o777, 0o700);
  const bundle = renderBundle(fixture()); for (const [name, body] of bundle.files) assert.equal(fs.readFileSync(path.join(output, name), "utf8"), body);
  assert.throws(() => generate({ inventory, output }), /new directory/);
  assert.throws(() => parseArguments(["--inventory", inventory, "--output", output, "--check"]));
  const linked = path.join(directory, "linked"); fs.symlinkSync(inventory, linked); assert.throws(() => generate({ inventory: linked, check: true }), /links/);
  assert.equal(fs.readdirSync(directory).some(name => name.includes("staging")), false);
});

test("worker source/config binding fails before a mismatched command can run", () => {
  const m = fixture({ role: "cloud-events", settings: {} }), cfg = { sourceId: m.sourceId, appId: m.appId, baseUrl: m.baseUrl, tokenFile: m.tokenFile };
  checkBinding(m, cfg);
  checkBinding(m, { ...cfg, provider: "wazuh" });
  const containerPack = container("cloud-events");
  assert.throws(() => checkBinding(containerPack, { sourceId: containerPack.sourceId, appId: containerPack.appId, baseUrl: containerPack.baseUrl, tokenFile: containerPack.tokenFile, provider: "wazuh" }), /host systemd\/Ansible/);
  for (const change of [{ sourceId: "foreign" }, { appId: "foreign" }, { baseUrl: "http://localhost:9999" }, { tokenFile: "/etc/another-token" }]) assert.throws(() => checkBinding(m, { ...cfg, ...change }));
  const gw = fixture({ role: "protocol-gateway", settings: {} }); assert.throws(() => checkBinding(gw, cfg), /storage/);
});

test("overlap lock excludes a second worker and leaves retained evidence untouched", t => {
  const directory = temporary(t), evidence = path.join(directory, "pending.json"); fs.writeFileSync(evidence, "retained", { mode: 0o600 });
  const release = acquire(directory); assert.throws(() => acquire(directory), error => error.code === "EEXIST");
  release(); const again = acquire(directory); again(); assert.equal(fs.readFileSync(evidence, "utf8"), "retained");
});

test("bounded cycles stop after failures, retain exact argv, and enforce the whole-cycle deadline", async () => {
  const m = fixture({ role: "cloud-events", settings: {} }), seen = [];
  assert.equal(await cycle(m, { execute: async step => { seen.push(step); return 1; } }), 1); assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], commandSteps(m)[0]);
  let time = 0, calls = 0; assert.equal(await cycle(m, { now: () => time, execute: async () => { calls++; time += 200000; return 0; } }), 1); assert.equal(calls, 1);
  assert.equal(await cycle(fixture(), { execute: async () => 2 }), 2);
  const abort = new AbortController(); abort.abort(); assert.equal(await cycle(m, { signal: abort.signal, execute: async () => assert.fail("must not spawn") }), 1);
});

test("worker executes argument arrays without shell interpretation and bounds a real child", async () => {
  assert.equal(await runStep({ executable: process.execPath, args: ["-e", "process.exit(process.argv[1] === 'a b;$(example)' ? 0 : 9)", "a b;$(example)"] }, { timeoutMs: 1000 }), 0);
  const at = Date.now(); assert.equal(await runStep({ executable: process.execPath, args: ["-e", "setTimeout(() => {}, 30000)"] }, { timeoutMs: 50 }), 1); assert.ok(Date.now() - at < 5000);
});

test("timed-out child descendants are stopped before the worker releases its cycle", async t => {
  if (process.platform === "win32") return t.skip("POSIX process-group test; Task Scheduler requires Windows commissioning");
  const directory = temporary(t), pidFile = path.join(directory, "child.pid");
  const childProgram = "process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)";
  const program = "require('node:child_process').spawn(process.execPath,['-e'," + JSON.stringify(childProgram) + ",process.argv[1]],{stdio:'ignore'});setInterval(()=>{},1000)";
  assert.equal(await runStep({ executable: process.execPath, args: ["-e", program, pidFile] }, { timeoutMs: 400 }), 1);
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  // A dead adopted child may briefly remain a zombie until the host reaps it.
  let alive = true;
  for (let tries = 0; tries < 100 && alive; tries++) {
    try { alive = !fs.readFileSync("/proc/" + pid + "/stat", "utf8").includes(") Z "); } catch { alive = false; }
    if (alive) await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(alive, false, "descendant must be killed, not left running after the wrapper timeout");
});

test("Kubernetes private-file staging preserves contents with owner-only files and supports restart", t => {
  const directory = temporary(t), source = path.join(directory, "projected"), privateDir = path.join(directory, "private"), state = path.join(directory, "storage/state"), outbox = path.join(directory, "storage/outbox");
  fs.mkdirSync(source); fs.mkdirSync(path.join(source, "..revision")); fs.writeFileSync(path.join(source, "..revision", "source-token"), "synthetic-value"); fs.symlinkSync("..revision/source-token", path.join(source, "source-token"));
  stage(source, privateDir, state, outbox); stage(source, privateDir, state, outbox);
  assert.equal(fs.readFileSync(path.join(privateDir, "source-token"), "utf8"), "synthetic-value"); assert.equal(fs.statSync(path.join(privateDir, "source-token")).mode & 0o777, 0o600); assert.equal(fs.statSync(state).mode & 0o777, 0o700);
  fs.symlinkSync(path.join(directory, "private/source-token"), path.join(source, "foreign")); assert.throws(() => stage(source, privateDir, state, outbox), /leaves/);
});

test("generated wrapper runs the actual log collector without polluting its dedicated state directory",t=>{
 const directory=temporary(t),privateDirectory=path.join(directory,"private"),storageDirectory=path.join(directory,"storage");
 fs.mkdirSync(privateDirectory,{mode:0o700});fs.mkdirSync(storageDirectory,{mode:0o700});
 const m=fixture({targets:["systemd"],installDirectory:path.resolve(__dirname,".."),privateDirectory,storageDirectory,stateDirectory:path.join(storageDirectory,"state"),outboxDirectory:path.join(storageDirectory,"outbox"),
 configFile:path.join(privateDirectory,"unused.json"),tokenFile:path.join(privateDirectory,"source-token"),runtime:{node:process.execPath},baseUrl:"http://127.0.0.1:9",
 settings:{file:path.join(directory,"server.log"),format:"plain",maxRecords:10}});
 fs.mkdirSync(m.stateDirectory,{mode:0o700});fs.mkdirSync(m.outboxDirectory,{mode:0o700});
 fs.writeFileSync(m.tokenFile,require("node:crypto").randomBytes(32).toString("base64url"),{mode:0o600});
 fs.writeFileSync(m.settings.file,"Synthetic wrapper evidence\n",{mode:0o600});
 const pack=path.join(privateDirectory,"deployment-pack.json");fs.writeFileSync(pack,JSON.stringify(m),{mode:0o600});
 const child=spawnSync(process.execPath,[path.join(m.installDirectory,"tools/deployment/worker.js"),"--manifest",pack,"--once"],{encoding:"utf8",timeout:20000});
 assert.equal(child.status,2,child.stderr+child.stdout);
 assert.ok(fs.existsSync(path.join(m.stateDirectory,"collector.sqlite")));
 assert.equal(fs.existsSync(path.join(m.stateDirectory,"deployment-worker.lock")),false);
 assert.equal(fs.existsSync(path.join(storageDirectory,".deployment-worker","deployment-worker.lock")),false);
 assert.equal(fs.statSync(path.join(storageDirectory,".deployment-worker")).mode&0o777,0o700);
});

test("container input directory cannot mask code, credentials, durable state or reserved mounts", () => {
  const m = container();
  for (const directory of [m.installDirectory, m.privateDirectory, m.storageDirectory, "/tmp", "/bb-soc-projected", "/bb-soc-private-volume"]) {
    for (const file of [directory + "/example.log", directory + "/nested/example.log", path.posix.join(path.posix.dirname(directory), "example.log")]) {
      assert.throws(() => validateManifest({ ...m, settings: { ...m.settings, file } }), /separate|filesystem root/, file);
    }
  }
  assert.equal(validateManifest({ ...m, settings: { ...m.settings, file: "/srv/evidence/logs/example.log" } }).settings.file, "/srv/evidence/logs/example.log");
});
test("Windows registration prompts for the exact local account without embedding a password", () => {
  const m = windows(), bundle = renderBundle(m), script = bundle.files.get("windows/install.ps1");
  assert.match(bundle.files.get("windows/bb-soc-example-logs.xml"), /<LogonType>Password<\/LogonType>/);
  assert.match(script, /Get-LocalUser -Name \$account/);
  assert.ok(script.includes("$localAccount = [Environment]::MachineName + '\\' + $account"));
  assert.match(script, /Get-Credential -UserName \$localAccount/);
  assert.match(script, /Equals\(\$credential.UserName, \$localAccount, \[StringComparison\]::OrdinalIgnoreCase\)/);
  assert.match(script, /Register-ScheduledTask .* -User \$localAccount -Password \$credential.GetNetworkCredential\(\).Password/);
  assert.match(script, /finally \{\s+\$credential = \$null/);
  assert.doesNotMatch(script, /ConvertTo-SecureString|Write-Host.*credential|Write-Output.*credential|Out-File.*credential/);
  assert.equal(Object.hasOwn(JSON.parse(bundle.files.get("private/deployment-pack.json")).account, "password"), false);
});

test("non-root staging creates owned private children without chmod of a root-owned volume", t => {
  if (process.platform === "win32" || process.getuid?.() !== 0) return t.skip("Requires POSIX root to model Kubernetes fsGroup volume ownership");
  const directory = temporary(t), source = path.join(directory, "projected"), volume = path.join(directory, "private-volume"), storage = path.join(directory, "storage");
  fs.chmodSync(directory, 0o755); fs.mkdirSync(source, { mode: 0o755 });
  fs.writeFileSync(path.join(source, "source-token"), "synthetic", { mode: 0o444 });
  for (const location of [volume, storage]) { fs.mkdirSync(location, { mode: 0o770 }); fs.chownSync(location, 0, 10001); fs.chmodSync(location, 0o770); }
  const privateDir = path.join(volume, "private"), state = path.join(storage, "state"), outbox = path.join(storage, "outbox");
  const child = spawnSync(process.execPath, [path.join(__dirname, "../tools/deployment/stage-private.js"), source, privateDir, state, outbox], { uid: 10001, gid: 10001, encoding: "utf8", timeout: 5000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(fs.statSync(volume).uid, 0); assert.equal(fs.statSync(volume).mode & 0o777, 0o770);
  assert.equal(fs.statSync(privateDir).uid, 10001); assert.equal(fs.statSync(privateDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(privateDir, "source-token")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(state).uid, 10001); assert.equal(fs.statSync(outbox).mode & 0o777, 0o700);
});
