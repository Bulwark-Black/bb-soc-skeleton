#!/usr/bin/env node
"use strict";
const fs = require("node:fs"), path = require("node:path"), { spawn } = require("node:child_process");
const { validateManifest, commandSteps } = require("./manifest");
const ROOT = path.resolve(__dirname, "../..");
function readPrivate(filename) {
  if (!path.isAbsolute(filename) || path.resolve(filename) !== filename || filename.startsWith(ROOT + path.sep) || fs.realpathSync(filename) !== filename) throw new Error("Use an external canonical private path.");
  const info = fs.lstatSync(filename);
  if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024 || process.platform !== "win32" && ((info.mode & 0o077) || info.uid !== process.getuid())) throw new Error("Private configuration file ownership or mode is invalid.");
  return JSON.parse(fs.readFileSync(filename, "utf8"));
}
function checkBinding(m, cfg) {
  if (m.role === "server-logs") return;
  if (m.role === "cloud-events" && cfg.provider === "wazuh" && m.targets.some(target => ["container", "helm"].includes(target)))
    throw new Error("Wazuh file collection requires a host systemd/Ansible pack; generated containers do not mount alerts input.");
  const app = m.role === "windows-events" ? cfg.estateId : cfg.appId;
  const origin = cfg.consoleUrl || cfg.baseUrl;
  if (cfg.sourceId !== m.sourceId || origin !== m.baseUrl || cfg.tokenFile !== m.tokenFile || m.role !== "native-monitor" && app !== m.appId) throw new Error("Collector configuration differs from the reviewed source, application, origin or credential path.");
  if (m.role === "protocol-gateway" && (cfg.stateDirectory !== m.stateDirectory || cfg.outboxDirectory !== m.outboxDirectory)) throw new Error("Gateway storage differs from the reviewed pack.");
  if (m.role === "windows-events" && (JSON.stringify(cfg.channels) !== JSON.stringify(m.settings.channels) || JSON.stringify(cfg.computers) !== JSON.stringify(m.settings.computers) || cfg.maxEvents !== m.settings.maxEvents || cfg.nodeExecutable !== m.runtime.node)) throw new Error("Windows scope differs from the reviewed pack.");
}
function acquire(directory) {
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || fs.realpathSync(directory) !== directory || process.platform !== "win32" && ((info.mode & 0o077) || info.uid !== process.getuid())) throw new Error("Existing owner-only state directory required.");
  const lock = path.join(directory, "deployment-worker.lock"), fd = fs.openSync(lock, "wx", 0o600);
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); fs.fsyncSync(fd);
  return () => { fs.closeSync(fd); fs.unlinkSync(lock); };
}
function runStep(step, { timeoutMs, signal, spawnProcess = spawn } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return resolve(1);
    const child = spawnProcess(step.executable, step.args, { shell: false, stdio: "inherit", windowsHide: true, detached: process.platform !== "win32" });
    let expired = false, killTimer, settled = false, closed = false, closeCode;
    const finish = (error, code) => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener("abort", terminate); error ? reject(error) : resolve(expired ? 1 : code); };
    const killTree = kind => {
      try { if (process.platform !== "win32") process.kill(-child.pid, kind); else child.kill(kind); } catch { /* Already exited. */ }
    };
    const terminate = () => {
      if (expired) return;
      expired = true;
      if (process.platform === "win32" && Number.isSafeInteger(child.pid)) {
        // Fixed executable and numeric PID stop the native reader descendants.
        const killer = spawn(path.join(process.env.SystemRoot, "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { shell: false, stdio: "ignore", windowsHide: true });
        killer.on("error", () => killTree("SIGKILL"));
      } else killTree("SIGTERM");
      // A parent can exit while its descendants ignore SIGTERM. Keep the group
      // kill scheduled and do not release the overlap lock before that boundary.
      killTimer = setTimeout(() => { killTree("SIGKILL"); killTimer = null; if (closed) finish(null, closeCode); }, 2000);
    };
    const timer = timeoutMs === null ? null : setTimeout(terminate, timeoutMs);
    signal?.addEventListener("abort", terminate, { once: true });
    child.once("error", error => finish(error));
    child.once("close", code => { closed = true; closeCode = Number.isInteger(code) ? code : 1; if (!expired || !killTimer) finish(null, closeCode); });
  });
}
async function cycle(m, { signal, execute = runStep, now = Date.now } = {}) {
  const deadline = now() + m.schedule.timeoutSeconds * 1000;
  let result = 0;
  for (const step of commandSteps(m)) {
    if (signal?.aborted || now() >= deadline) return 1;
    const code = await execute(step, { signal, timeoutMs: m.role === "protocol-gateway" ? null : deadline - now() });
    if (code !== 0 && !(m.role === "server-logs" && code === 2)) return code || 1;
    result = Math.max(result, code);
  }
  return result;
}
async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 3 || argv[0] !== "--manifest" || !["--once", "--loop"].includes(argv[2])) throw new Error("Usage: worker.js --manifest ABSOLUTE_PRIVATE_PACK --once|--loop");
  const m = validateManifest(readPrivate(argv[1]));
  if ((process.platform === "win32") !== (m.role === "windows-events")) throw new Error("Deployment platform does not match this worker.");
  if (m.role !== "server-logs") checkBinding(m, readPrivate(m.configFile));
  const workerDirectory = path.join(m.storageDirectory, ".deployment-worker");
  try { fs.mkdirSync(workerDirectory, { mode: 0o700 }); } catch(error) { if(error.code !== "EEXIST") throw error; }
  const release = acquire(workerDirectory), stop = new AbortController();
  const stopping = () => stop.abort(); process.once("SIGTERM", stopping); process.once("SIGINT", stopping);
  try {
    do {
      const code = await cycle(m, { signal: stop.signal });
      if (argv[2] === "--once" || m.role === "protocol-gateway" || stop.signal.aborted) return code;
      // One completed bounded attempt before each interval; no overlapping runs.
      await new Promise(resolve => { const finish = () => { clearTimeout(timer); stop.signal.removeEventListener("abort", finish); resolve(); }; const timer = setTimeout(finish, m.schedule.intervalSeconds * 1000); stop.signal.addEventListener("abort", finish, { once: true }); });
    } while (!stop.signal.aborted);
    return 0;
  } finally { release(); process.removeListener("SIGTERM", stopping); process.removeListener("SIGINT", stopping); }
}
if (require.main === module) main().then(code => { process.exitCode = code; }).catch(() => { process.stderr.write("Deployment worker stopped. Inspect private configuration, retained state and overlap lock; no automatic reset was performed.\n"); process.exitCode = 1; });
module.exports = { readPrivate, checkBinding, acquire, runStep, cycle, main };
