#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const contractFile = path.join(root, "public", "adapter-contract.js");

function loadRuntime(filename = contractFile) {
  const source = fs.readFileSync(filename, "utf8");
  const context = vm.createContext({});
  context.window = context;
  vm.runInContext(source, context, { filename });
  const runtime = context.SocConsoleAdapterRuntime;
  if (!runtime || typeof runtime.validateEnvelope !== "function") {
    throw new TypeError("adapter-contract.js did not expose SocConsoleAdapterRuntime.validateEnvelope");
  }
  // JSON is parsed in the contract's realm so its plain-object checks remain
  // meaningful even though this command-line tool runs the browser script in a
  // VM context.
  return Object.freeze({
    VERSION: runtime.VERSION,
    validateEnvelope(value, expectedRoute) {
      context.__providerDocument = JSON.stringify(value);
      context.__expectedRoute = expectedRoute;
      return vm.runInContext(
        "SocConsoleAdapterRuntime.validateEnvelope(JSON.parse(__providerDocument), __expectedRoute)",
        context
      );
    }
  });
}

function envelopesFrom(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray(value.pages)) return value.pages;
  return [value];
}

function validateDocument(value, runtime = loadRuntime()) {
  const pages = envelopesFrom(value);
  if (pages.length === 0) throw new TypeError("provider document must contain at least one page envelope");
  return pages.map((page) => runtime.validateEnvelope(page, page && page.route));
}

function readJson(filename) {
  const source = filename === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(filename, "utf8");
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new SyntaxError(`${filename}: invalid JSON (${error.message})`);
  }
}

function usage() {
  return "Usage: node tools/validate-provider.js <page-envelope.json> [...]\n       use - to read one document from standard input";
}

function main(argv = process.argv.slice(2)) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    return argv.length === 0 ? 2 : 0;
  }
  try {
    const runtime = loadRuntime();
    let total = 0;
    for (const name of argv) {
      const filename = name === "-" ? name : path.resolve(process.cwd(), name);
      total += validateDocument(readJson(filename), runtime).length;
    }
    console.log(`provider validation passed: ${total} page envelope${total === 1 ? "" : "s"}`);
    return 0;
  } catch (error) {
    console.error(`provider validation failed: ${error.message}`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { envelopesFrom, loadRuntime, main, readJson, usage, validateDocument };
