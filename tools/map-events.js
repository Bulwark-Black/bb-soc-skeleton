#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { TextDecoder } = require("node:util");
const { LIMITS, mapSourceText } = require("../server/source-mapping");
const HELP = "Usage: node tools/map-events.js --recipe /absolute/private/recipe.json --file /absolute/private/events.json\n"
  + "Read a reviewed source-mapping-recipe v1 and 1–100 redacted JSON/NDJSON records (at most 512 KiB).\n"
  + "Files and their immediate private directory must be owner-only, outside this repository, regular and nonlinked.\n"
  + "Print only the validated canonical ingest-batch to stdout. This command never sends records or stores raw input.\n"
  + "Binding is the recipe's declared application/environment/source; this offline command does not verify current registration, activation or driver availability.\n"
  + "Review the output, validate/activate the source separately, then use the existing send-events tool with a source credential in a private token file.\n";
function refused() { const error = new Error("Use bounded owner-only regular input files in an owner-only directory outside the repository, without links, and a valid reviewed mapping recipe. No batch was emitted."); error.safeMappingFile = true; throw error; }
function parseArguments(argv) {
  if (!Array.isArray(argv)) refused();
  if (argv.length === 1 && argv[0] === "--help") return { help: true };
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = { "--recipe": "recipe", "--file": "file" }[argv[index]], value = argv[index + 1];
    if (!key || Object.hasOwn(options, key) || typeof value !== "string" || !value || value.startsWith("--")) refused();
    options[key] = value;
  }
  if (!options.recipe || !options.file) refused(); return options;
}
function readPrivateFile(filename, maximum) {
  if (typeof filename !== "string" || !path.isAbsolute(filename) || filename !== path.normalize(filename)) refused();
  const project = fs.realpathSync(path.join(__dirname, ".."));
  if (filename.startsWith(project + path.sep) || filename === project || fs.realpathSync(filename) !== filename) refused();
  let current = path.parse(filename).root;
  for (const component of path.dirname(filename).slice(current.length).split(path.sep)) {
    if (!component) continue; current = path.join(current, component); const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) refused();
  }
  const parent = fs.lstatSync(path.dirname(filename));
  if ((parent.mode & 0o077) || (typeof process.getuid === "function" && parent.uid !== process.getuid())) refused();
  const before = fs.lstatSync(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > maximum || (before.mode & 0o077)
      || (typeof process.getuid === "function" && before.uid !== process.getuid())) refused();
  const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1 || (opened.mode & 0o077) || opened.size > maximum) refused();
    const buffer = Buffer.alloc(maximum + 1); let count = 0;
    while (count < buffer.length) { const bytes = fs.readSync(descriptor, buffer, count, buffer.length - count, null); if (!bytes) break; count += bytes; }
    const after = fs.fstatSync(descriptor);
    if (count > maximum || count !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || after.nlink !== 1) refused();
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, count));
  } finally { fs.closeSync(descriptor); }
}
function main(argv = process.argv.slice(2), output = process) {
  try {
    const options = parseArguments(argv); if (options.help) { output.stdout.write(HELP); return 0; }
    const recipe = JSON.parse(readPrivateFile(options.recipe, LIMITS.recipeBytes));
    const result = mapSourceText(readPrivateFile(options.file, LIMITS.inputBytes), recipe);
    output.stdout.write(JSON.stringify(result.batch) + "\n"); return 0;
  } catch (error) {
    const message = error.code === "mapping-refused" || error.safeMappingFile ? error.message : "The private files could not be read or the recipe is not valid JSON. No batch was emitted.";
    output.stderr.write("Event mapping refused: " + message + "\n"); return 1;
  }
}
if (require.main === module) process.exitCode = main();
module.exports = { HELP, parseArguments, readPrivateFile, main };
