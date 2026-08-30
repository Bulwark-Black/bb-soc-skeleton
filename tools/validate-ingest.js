#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const { validateIngestBatch, validateNormalizedRecord } = require("./ingest-contract");

function validateDocument(value) {
  if (value && value.documentType === "normalized-record") return validateNormalizedRecord(value);
  return validateIngestBatch(value);
}

function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1) {
    console.error("Usage: node tools/validate-ingest.js <normalized-record-or-ingest-batch.json>");
    return 2;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(argv[0], "utf8"));
    validateDocument(parsed);
    console.log("Ingest document is valid.");
    return 0;
  } catch (error) {
    console.error(`Invalid ingest document: ${error.message}`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { main, validateDocument };
