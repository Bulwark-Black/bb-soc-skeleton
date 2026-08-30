#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const contractFile = path.join(root, "public", "administration-contract.js");
const TYPES = Object.freeze([
  "auto", "snapshot-request", "snapshot", "prompt-request", "prompt", "command-request", "command-result"
]);

function loadRuntime(filename = contractFile) {
  const runtime = require(filename);
  const required = [
    "validateSnapshotRequest", "validateSnapshot", "validatePromptRequest", "validatePrompt",
    "validateCommandRequest", "validateCommandResult", "validateProvider", "validateDocument"
  ];
  if (!runtime || required.some((name) => typeof runtime[name] !== "function")) {
    throw new TypeError("administration-contract.js did not expose the complete SocConsoleAdministrationRuntime validator API");
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
  const options = { type: "auto", request: null, files: [] };
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
    if (argument === "--request") {
      const filename = argv[index + 1];
      if (!filename || filename.startsWith("--")) throw new TypeError("--request requires a filename");
      if (options.request !== null) throw new TypeError("--request may be supplied only once");
      options.request = filename;
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) throw new TypeError(`unknown option: ${argument}`);
    options.files.push(argument);
  }
  if (options.files.filter((name) => name === "-").length > 1
    || (options.files.includes("-") && options.request === "-")) {
    throw new TypeError("standard input may be consumed only once");
  }
  return options;
}

function loadSupportRequest(name, runtime) {
  if (name === null) return undefined;
  const filename = name === "-" ? name : path.resolve(process.cwd(), name);
  const value = readJson(filename);
  if (Array.isArray(value) || (value && typeof value === "object" && Array.isArray(value.documents))) {
    throw new TypeError("support request must contain exactly one object");
  }
  if (!value || typeof value !== "object") throw new TypeError("support request must be an object");
  if (value.documentType === "administration-snapshot-request") return runtime.validateSnapshotRequest(value);
  if (value.documentType === "agent-prompt-request") return runtime.validatePromptRequest(value);
  if (value.documentType === "administration-command-request") return runtime.validateCommandRequest(value);
  throw new TypeError("support request must be a snapshot, prompt, or command request");
}

function validateByType(value, type, runtime, request) {
  if (type === "snapshot-request") return runtime.validateSnapshotRequest(value);
  if (type === "snapshot") return runtime.validateSnapshot(value, request);
  if (type === "prompt-request") return runtime.validatePromptRequest(value);
  if (type === "prompt") return runtime.validatePrompt(value, request);
  if (type === "command-request") return runtime.validateCommandRequest(value);
  if (type === "command-result") return runtime.validateCommandResult(value, request);
  return runtime.validateDocument(value, { request });
}

function validateDocuments(value, options = {}, runtime = loadRuntime()) {
  const type = options.type === undefined ? "auto" : options.type;
  if (!TYPES.includes(type)) throw new TypeError(`type must be one of: ${TYPES.join(", ")}`);
  const documents = documentsFrom(value);
  if (documents.length === 0) throw new TypeError("administration document collection must contain at least one document");
  return documents.map((document) => validateByType(document, type, runtime, options.request));
}

function usage() {
  return [
    "Usage: node tools/validate-administration.js [options] <administration-document.json> [...]",
    "       use - to read one JSON document from standard input",
    "",
    "Options:",
    `  --type ${TYPES.join("|")}`,
    "  --request <request.json>   correlate a snapshot, prompt, or command result",
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
    const request = loadSupportRequest(options.request, runtime);
    let total = 0;
    const counts = new Map();
    for (const name of options.files) {
      const filename = name === "-" ? name : path.resolve(process.cwd(), name);
      const validated = validateDocuments(readJson(filename), { type: options.type, request }, runtime);
      total += validated.length;
      validated.forEach((document) => {
        const type = document.documentType || options.type;
        counts.set(type, (counts.get(type) || 0) + 1);
      });
    }
    const summary = [...counts].map(([type, count]) => `${type}:${count}`).join(", ");
    console.log(`administration validation passed: ${total} document${total === 1 ? "" : "s"}${summary ? ` (${summary})` : ""}`);
    return 0;
  } catch (error) {
    console.error(`administration validation failed: ${error.message}`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  TYPES,
  documentsFrom,
  loadRuntime,
  loadSupportRequest,
  main,
  parseArguments,
  readJson,
  usage,
  validateDocuments
};
