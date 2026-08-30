#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const contractFile = path.join(root, "public", "connector-contract.js");
const TYPES = Object.freeze([
  "auto", "manifest", "registration", "health", "command-request", "command-result", "snapshot"
]);

function loadRuntime(filename = contractFile) {
  const runtime = require(filename);
  const required = [
    "validateConnectorManifest",
    "validateSourceRegistration",
    "validateSourceHealthSnapshot",
    "validateCommandRequest",
    "validateCommandResult",
    "validateControlSnapshot",
    "validateDocument"
  ];
  if (!runtime || required.some((name) => typeof runtime[name] !== "function")) {
    throw new TypeError("connector-contract.js did not expose the complete SocConsoleConnectorRuntime validator API");
  }
  return runtime;
}

function documentsFrom(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray(value.documents)) return value.documents;
  return [value];
}

function readJson(filename) {
  const source = filename === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(filename, "utf8");
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new SyntaxError(`${filename}: invalid JSON (${error.message})`);
  }
}

function parseArguments(argv) {
  const options = { type: "auto", manifest: null, request: null, files: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { ...options, help: true };
    if (argument === "--type") {
      const type = argv[index + 1];
      if (!TYPES.includes(type)) throw new TypeError(`--type must be one of: ${TYPES.join(", ")}`);
      options.type = type;
      index += 1;
      continue;
    }
    if (argument === "--manifest" || argument === "--request") {
      const filename = argv[index + 1];
      if (!filename || filename.startsWith("--")) throw new TypeError(`${argument} requires a filename`);
      const key = argument === "--manifest" ? "manifest" : "request";
      if (options[key] !== null) throw new TypeError(`${argument} may be supplied only once`);
      options[key] = filename;
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) throw new TypeError(`unknown option: ${argument}`);
    options.files.push(argument);
  }
  if (options.files.filter((name) => name === "-").length > 1
    || (options.files.includes("-") && [options.manifest, options.request].includes("-"))) {
    throw new TypeError("standard input may be consumed only once");
  }
  return options;
}

function loadSupportDocument(name, type, runtime) {
  if (name === null) return undefined;
  const filename = name === "-" ? name : path.resolve(process.cwd(), name);
  const value = readJson(filename);
  if (Array.isArray(value) || (value && typeof value === "object" && Array.isArray(value.documents))) {
    throw new TypeError(`${type} support document must contain exactly one object`);
  }
  return type === "manifest"
    ? runtime.validateConnectorManifest(value)
    : runtime.validateCommandRequest(value);
}

function validateByType(value, type, runtime, support) {
  if (type === "manifest") return runtime.validateConnectorManifest(value);
  if (type === "registration") return runtime.validateSourceRegistration(value, support.manifest);
  if (type === "health") return runtime.validateSourceHealthSnapshot(value);
  if (type === "command-request") return runtime.validateCommandRequest(value, support.manifest);
  if (type === "command-result") return runtime.validateCommandResult(value, support.request);
  if (type === "snapshot") return runtime.validateControlSnapshot(value);
  return runtime.validateDocument(value, support);
}

function validateDocuments(value, options = {}, runtime = loadRuntime()) {
  const type = options.type === undefined ? "auto" : options.type;
  if (!TYPES.includes(type)) throw new TypeError(`type must be one of: ${TYPES.join(", ")}`);
  const documents = documentsFrom(value);
  if (documents.length === 0) throw new TypeError("connector document collection must contain at least one document");
  const support = { manifest: options.manifest, request: options.request };
  return documents.map((document) => validateByType(document, type, runtime, support));
}

function usage() {
  return [
    "Usage: node tools/validate-connector.js [options] <connector-document.json> [...]",
    "       use - to read one JSON document from standard input",
    "",
    "Options:",
    `  --type ${TYPES.join("|")}`,
    "  --manifest <connector-manifest.json>   cross-check registration or setup input",
    "  --request <command-request.json>       correlate a command result",
    "  -h, --help"
  ].join("\n");
}

function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArguments(argv);
    if (options.help || options.files.length === 0) {
      console.log(usage());
      return options.help ? 0 : 2;
    }
    const runtime = loadRuntime();
    const support = {
      manifest: loadSupportDocument(options.manifest, "manifest", runtime),
      request: loadSupportDocument(options.request, "request", runtime)
    };
    let total = 0;
    const counts = new Map();
    for (const name of options.files) {
      const filename = name === "-" ? name : path.resolve(process.cwd(), name);
      const validated = validateDocuments(readJson(filename), { type: options.type, ...support }, runtime);
      total += validated.length;
      validated.forEach((document) => {
        const type = document.documentType || options.type;
        counts.set(type, (counts.get(type) || 0) + 1);
      });
    }
    const summary = [...counts].map(([type, count]) => `${type}:${count}`).join(", ");
    console.log(`connector validation passed: ${total} document${total === 1 ? "" : "s"}${summary ? ` (${summary})` : ""}`);
    return 0;
  } catch (error) {
    console.error(`connector validation failed: ${error.message}`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  TYPES,
  documentsFrom,
  loadRuntime,
  main,
  parseArguments,
  readJson,
  usage,
  validateDocuments
};
