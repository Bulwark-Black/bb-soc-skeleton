#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const allowedFiles = new Set([
  ".github/workflows/ci.yml",
  ".gitignore",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "docs/ARCHITECTURE.md",
  "package.json",
  "public/app.css",
  "public/app.js",
  "public/index.html",
  "test/public-boundary.test.js",
  "tools/public-audit.js"
]);

const privateMarkers = [
  ["bb", "soc"].join("-"),
  ["bul", "wark"].join(""),
  ["al", "bert"].join(""),
  ["la", "scola"].join(""),
  ["contractor", "codex"].join(" "),
  ["tail", "scale"].join(""),
  ["hetz", "ner"].join(""),
  ["pl", "aid"].join(""),
  ["cl", "erk"].join(""),
  ["twi", "lio"].join(""),
  ["re", "send"].join(""),
  ["sho", "dan"].join(""),
  ["url", "scan"].join(""),
  ["threat", "fox"].join(""),
  ["malware", "bazaar"].join(""),
  ["alien", "vault"].join(""),
  ["tri", "vy"].join("")
];

const operationalFragments = [
  ["/", "opt", "/"].join(""),
  ["/", "var", "/", "lib", "/"].join(""),
  ["/", "Users", "/"].join(""),
  ["root", "@"].join(""),
  [".ts", ".net"].join(""),
  ["system", "ctl"].join(""),
  ["journal", "ctl"].join("")
];

const secretPatterns = [
  ["secret.private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/i],
  ["secret.ssh-key", /ssh-(?:rsa|ed25519)\s+[A-Za-z0-9+/]{40,}/i],
  ["secret.github-token", /gh[pousr]_[A-Za-z0-9_]{20,}/],
  ["secret.aws-access-key", /AKIA[0-9A-Z]{16}/],
  ["secret.jwt", /eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/],
  ["secret.bearer", /bearer\s+[A-Za-z0-9._~+/=-]{20,}/i],
  ["secret.assignment", /(?:api[_-]?key|client[_-]?secret|password|token)\s*[:=]\s*["'][^"']{12,}["']/i],
  ["secret.long-hex", /\b[a-f0-9]{32,}\b/i]
];

const browserCapabilities = [
  ["capability.fetch", /\bfetch\s*\(/],
  ["capability.websocket", /\bWebSocket\b/],
  ["capability.eventsource", /\bEventSource\b/],
  ["capability.xhr", /\bXMLHttpRequest\b/],
  ["capability.beacon", /\bsendBeacon\b/],
  ["capability.local-storage", /\blocalStorage\b/],
  ["capability.session-storage", /\bsessionStorage\b/],
  ["capability.indexed-db", /\bindexedDB\b/],
  ["capability.service-worker", /\bserviceWorker\b/]
];

const selfReferential = new Set(["tools/public-audit.js", "test/public-boundary.test.js"]);

function relative(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function listFiles(directory, results = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const full = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) results.push({ file: full, kind: "symlink" });
    else if (entry.isDirectory()) listFiles(full, results);
    else if (entry.isFile()) results.push({ file: full, kind: "file" });
    else results.push({ file: full, kind: "special" });
  }
  return results;
}

function lineNumber(text, index) {
  return text.slice(0, index).split("\n").length;
}

function report(findings, rule, file, text, index = 0) {
  findings.push({ rule, file: relative(file), line: lineNumber(text, index) });
}

function isAllowedAddress(value) {
  return value === "127.0.0.1"
    || value.startsWith("192.0.2.")
    || value.startsWith("198.51.100.")
    || value.startsWith("203.0.113.");
}

function entropy(value) {
  const counts = new Map();
  for (const char of value) counts.set(char, (counts.get(char) || 0) + 1);
  let result = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    result -= probability * Math.log2(probability);
  }
  return result;
}

function audit() {
  const findings = [];
  const entries = listFiles(root);
  const actualFiles = new Set();

  for (const entry of entries) {
    const rel = relative(entry.file);
    if (entry.kind !== "file") {
      findings.push({ rule: `manifest.${entry.kind}`, file: rel, line: 1 });
      continue;
    }
    actualFiles.add(rel);
    if (!allowedFiles.has(rel)) findings.push({ rule: "manifest.unexpected", file: rel, line: 1 });
    const stat = fs.statSync(entry.file);
    if (stat.size > 500_000) findings.push({ rule: "manifest.oversize", file: rel, line: 1 });
    if ((stat.mode & 0o111) !== 0) findings.push({ rule: "manifest.executable", file: rel, line: 1 });

    const buffer = fs.readFileSync(entry.file);
    if (buffer.includes(0)) {
      findings.push({ rule: "content.binary", file: rel, line: 1 });
      continue;
    }
    const text = buffer.toString("utf8").normalize("NFKC");
    const lower = text.toLowerCase();

    for (const marker of privateMarkers) {
      const index = lower.indexOf(marker);
      if (index >= 0) report(findings, "identity.private-marker", entry.file, text, index);
    }
    for (const fragment of operationalFragments) {
      const index = text.indexOf(fragment);
      if (index >= 0) report(findings, "operations.private-fragment", entry.file, text, index);
    }

    if (!selfReferential.has(rel)) {
      for (const [rule, pattern] of secretPatterns) {
        const match = pattern.exec(text);
        if (match) report(findings, rule, entry.file, text, match.index);
      }
      for (const match of text.matchAll(/\b[A-Za-z0-9_+/=-]{28,}\b/g)) {
        if (entropy(match[0]) >= 4.35) {
          report(findings, "secret.high-entropy-token", entry.file, text, match.index);
        }
      }
    }

    if (rel === "public/app.js") {
      for (const [rule, pattern] of browserCapabilities) {
        const match = pattern.exec(text);
        if (match) report(findings, rule, entry.file, text, match.index);
      }
      for (const forbidden of [/\bPOST\b/, /\bPUT\b/, /\bPATCH\b/, /\bDELETE\b/]) {
        const match = forbidden.exec(text);
        if (match) report(findings, "capability.mutation-method", entry.file, text, match.index);
      }
      const unsafeHtml = /\.(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML\s*\(/.exec(text);
      if (unsafeHtml) report(findings, "render.unsafe-html", entry.file, text, unsafeHtml.index);
    }

    for (const match of text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
      if (!isAllowedAddress(match[0])) report(findings, "identifier.nonreserved-ip", entry.file, text, match.index);
    }
    for (const match of text.matchAll(/[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/gi)) {
      if (!match[1].toLowerCase().endsWith("example.invalid")) {
        report(findings, "identifier.nonreserved-email", entry.file, text, match.index);
      }
    }
    for (const match of text.matchAll(/https?:\/\/[^\s)`'"<>]+/gi)) {
      if (match[0] !== "http://127.0.0.1:8080") {
        report(findings, "identifier.unapproved-url", entry.file, text, match.index);
      }
    }
  }

  for (const expected of allowedFiles) {
    if (!actualFiles.has(expected)) findings.push({ rule: "manifest.missing", file: expected, line: 1 });
  }
  return findings;
}

if (require.main === module) {
  const findings = audit();
  if (findings.length) {
    for (const finding of findings) {
      console.error(`${finding.rule}: ${finding.file}:${finding.line}`);
    }
    process.exitCode = 1;
  } else {
    console.log(`public audit passed: ${allowedFiles.size} allowlisted text files`);
  }
}

module.exports = { audit, allowedFiles };
