#!/usr/bin/env node
"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { renderBundle } = require("./deployment/render");
const ROOT = path.resolve(__dirname, "..");
function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index];
    if (option === "--check" && !result.check) result.check = true;
    else if (["--inventory", "--output"].includes(option) && !result[option.slice(2)] && argv[index + 1] && !argv[index + 1].startsWith("--")) result[option.slice(2)] = argv[++index];
    else throw new TypeError("Usage: generate-deployment.js --inventory ABSOLUTE_PRIVATE_JSON --check | --output NEW_EXTERNAL_DIRECTORY");
  }
  if (!result.inventory || (!!result.check === !!result.output)) throw new TypeError("Choose --check or a new --output directory.");
  return result;
}
function external(filename) {
  if (!path.isAbsolute(filename) || path.resolve(filename) !== filename || filename === ROOT || filename.startsWith(ROOT + path.sep)) throw new TypeError("Use canonical absolute paths outside the checkout.");
}
function generate({ inventory, output, check }) {
  external(inventory); if (fs.realpathSync(inventory) !== inventory) throw new TypeError("Inventory links are not supported.");
  const info = fs.lstatSync(inventory);
  if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024 || process.platform !== "win32" && ((info.mode & 0o077) || info.uid !== process.getuid())) throw new TypeError("Inventory must be a bounded owner-only regular file.");
  const result = renderBundle(JSON.parse(fs.readFileSync(inventory, "utf8")));
  if (check) return { valid: true, packVersion: result.manifest.packVersion, role: result.manifest.role, targets: result.manifest.targets, files: result.files.size, applied: false };
  external(output);
  if (fs.existsSync(output) || fs.realpathSync(path.dirname(output)) !== path.dirname(output)) throw new TypeError("Output must be a new directory below an existing canonical parent.");
  const parent = fs.statSync(path.dirname(output));
  if (process.platform !== "win32" && (parent.uid !== process.getuid() || parent.mode & 0o077)) throw new TypeError("Output parent must be owner-only before generation.");
  const stage = output + ".staging-" + crypto.randomBytes(8).toString("hex");
  fs.mkdirSync(stage, { mode: 0o700 });
  try {
    for (const [relative, content] of result.files) {
      const target = path.join(stage, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, content, { flag: "wx", mode: relative.endsWith(".sh") ? 0o700 : 0o600 });
    }
    fs.renameSync(stage, output);
  } catch (error) { fs.rmSync(stage, { recursive: true, force: true }); throw error; }
  return { generated: true, packVersion: result.manifest.packVersion, role: result.manifest.role, targets: result.manifest.targets, files: result.files.size, applied: false };
}
if (require.main === module) { try { process.stdout.write(JSON.stringify(generate(parseArguments(process.argv.slice(2)))) + "\n"); } catch (error) { process.stderr.write("Deployment generation failed: " + error.message + "\n"); process.exitCode = 1; } }
module.exports = { parseArguments, generate };
