#!/usr/bin/env node
"use strict";
// Non-root Kubernetes init step: projected Secret files are root-owned. Copy
// reviewed private files into a pod-local volume owned by the worker UID.
const fs = require("node:fs"), path = require("node:path");
function stage(source, destination, state, outbox) {
  if ([source, destination, state, outbox].some(value => !path.posix.isAbsolute(value) || path.posix.normalize(value) !== value) || destination === "/" || state === "/" || outbox === "/") throw new Error("Canonical absolute staging directories required.");
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 }); fs.chmodSync(destination, 0o700);
  const names = fs.readdirSync(source).filter(name => !name.startsWith(".."));
  if (!names.length || names.length > 32) throw new Error("Supply 1–32 reviewed private files.");
  for (const name of names) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(name)) throw new Error("Invalid private filename.");
    // Kubernetes projected volumes intentionally use internal symlinks.
    const resolved = fs.realpathSync(path.join(source, name));
    if (!resolved.startsWith(fs.realpathSync(source) + path.sep)) throw new Error("Projected file leaves its mounted volume.");
    const info = fs.statSync(resolved); if (!info.isFile() || info.size > 1024 * 1024) throw new Error("Invalid bounded private file.");
    const target = path.join(destination, name);
    if (fs.existsSync(target)) {
      const prior = fs.lstatSync(target);
      if (!prior.isFile() || prior.isSymbolicLink() || prior.nlink !== 1 || prior.uid !== process.getuid() || prior.mode & 0o077) throw new Error("Unexpected existing private file.");
    }
    // Init runs before the main container; replacing a partial prior staging
    // write is safe and lets Kubernetes retry an interrupted init container.
    const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, fs.readFileSync(resolved)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  for (const directory of [state, outbox]) { fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); fs.chmodSync(directory, 0o700); }
}
if (require.main === module) { try { if (process.argv.length !== 6) throw new Error(); stage(...process.argv.slice(2)); } catch { process.stderr.write("Private-volume staging failed; inspect reviewed Secret keys and storage ownership.\n"); process.exitCode = 1; } }
module.exports = { stage };
