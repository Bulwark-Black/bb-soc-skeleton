#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

// This remains a positive manifest: a file is not publishable merely because it
// happens to live in the repository. New publication surfaces must be reviewed
// and added here deliberately.
const requiredTextFiles = new Set([
  ".github/workflows/ci.yml",
  ".gitignore",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "contracts/connector-manifest.v1.schema.json",
  "contracts/administration.v1.schema.json",
  "contracts/ingest-batch.v1.schema.json",
  "contracts/normalized-record.v1.schema.json",
  "contracts/page-model.v1.schema.json",
  "contracts/source-registration.v1.schema.json",
  "docs/ADAPTER-CONTRACT.md",
  "docs/ADOPTION.md",
  "docs/ARCHITECTURE.md",
  "docs/AUTHENTICATION.md",
  "docs/CONFIGURATION.md",
  "docs/CONNECTORS.md",
  "docs/DESIGN-SYSTEM.md",
  "docs/FEATURES.md",
  "docs/AGENTS.md",
  "examples/better-auth-reference/README.md",
  "examples/better-auth-reference/better-auth-bridge.js",
  "examples/keycloak-reference/README.md",
  "examples/keycloak-reference/keycloak-client.template.json",
  "examples/keycloak-reference/relying-party-boundary.template.json",
  "examples/provider-template.js",
  "package.json",
  "public/adapter-contract.js",
  "public/administration-contract.js",
  "public/active-ui.css",
  "public/app-config.js",
  "public/app.css",
  "public/app.js",
  "public/application-bridge.js",
  "public/auth-contract.js",
  "public/bootstrap.js",
  "public/connector-contract.js",
  "public/index.html",
  "public/technical-docs.js",
  "public/technical-reference.md",
  "public/ui-catalog.js",
  "server/reference-control-plane.js",
  "server/reference-administration-runtime.js",
  "server/reference-administration-store.js",
  "server/reference-manifest.js",
  "server/reference-pages.js",
  "server/reference-runtime.js",
  "server/reference-store.js",
  "test/public-boundary.test.js",
  "test/administration-contract.test.js",
  "test/agent-mcp.test.js",
  "test/reference-administration.test.js",
  "test/reference-connectors.test.js",
  "tools/ingest-contract.js",
  "tools/agent-mcp.js",
  "tools/validate-administration.js",
  "tools/build-technical-docs.js",
  "tools/public-audit.js",
  "tools/serve.js",
  "tools/validate-connector.js",
  "tools/validate-ingest.js",
  "tools/validate-provider.js"
]);

const brandAssets = Object.freeze({
  "public/assets/favicon.ico": Object.freeze({
    bytes: 15342,
    mime: "image/vnd.microsoft.icon",
    sha256: "5d3f2311b5d6effd1b350935460da29f9e396854cf19745deb1b2b1cc508da1e"
  }),
  "public/assets/icon-180.png": Object.freeze({
    bytes: 37300,
    mime: "image/png",
    sha256: "fd2f1581967c48ab77f2ba73562eaf87e70bf1b330db1f85d15f58c634088e35"
  }),
  "public/assets/icon-32.png": Object.freeze({
    bytes: 1787,
    mime: "image/png",
    sha256: "8723ee9f23865e50d2df58d3f76957a77f9667636ed6959c14246c747ca7c3a5"
  }),
  "public/assets/mark.png": Object.freeze({
    bytes: 97382,
    mime: "image/png",
    sha256: "c5bfbdf248f6230b9288592283b8b90541f5e96717d023fdc2c1ac7f07d20979"
  }),
  "public/assets/triage-back-arrow.png": Object.freeze({
    bytes: 64946,
    mime: "image/png",
    sha256: "64c7101defb28677f3c0cf33927c2034da97bb75a7447f4a376766f5c0a0ddfb"
  })
});

const approvedDigests = new Set(Object.values(brandAssets).map((asset) => asset.sha256));
approvedDigests.add("2a2babdb4f431a4949aa4f6f8d074100f5f06e9cbda191ea9726296ac5816082");
const allowedTextFiles = new Set(requiredTextFiles);
const allowedFiles = new Set([...allowedTextFiles, ...Object.keys(brandAssets)]);

// Product, vendor, and feature names are structural public UI labels. This list
// is deliberately limited to private personal/project identities that must not
// enter the publication boundary.
const privateMarkers = [
  ["al", "bert"].join(""),
  ["la", "scola"].join(""),
  ["contractor", "codex"].join(" ")
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
  ["secret.assignment", /(?:api[_-]?key|client[_-]?secret|password|token)\s*[:=]\s*["'][^"']{12,}["']/i]
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
  ["capability.cache-storage", /\bcaches\s*\./],
  ["capability.cookie", /\bdocument\s*\.\s*cookie\b|\bcookieStore\b/],
  ["capability.service-worker", /\bserviceWorker\b/]
];

const mutationMethods = [/\bPOST\b/, /\bPUT\b/, /\bPATCH\b/, /\bDELETE\b/];
const unsafeHtmlPattern = [
  /\.(?:innerHTML|outerHTML|srcdoc)\s*=/,
  /\[\s*["'](?:innerHTML|outerHTML|srcdoc)["']\s*\]\s*=/,
  /\b(?:insertAdjacentHTML|setHTMLUnsafe|createContextualFragment)\s*\(/,
  /\bdocument\s*\.\s*write(?:ln)?\s*\(/,
  /\bDOMParser\b/
];
const selfReferential = new Set(["tools/public-audit.js", "test/public-boundary.test.js"]);
const browserDocumentationFiles = new Set(["public/technical-docs.js"]);

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
  if (value === "127.0.0.1") return true;
  const match = /^(192\.0\.2|198\.51\.100|203\.0\.113)\.(\d{1,3})$/.exec(value);
  return Boolean(match && Number(match[2]) <= 255);
}

function isAllowedUrl(value) {
  const normalized = value.replace(/[.,;:]$/, "");
  if (normalized === "http://www.w3.org/2000/svg") return true;
  if (normalized === "https://json-schema.org/draft/2020-12/schema") return true;
  try {
    const candidate = new URL(normalized);
    if (candidate.protocol === "http:"
        && ["127.0.0.1", "localhost"].includes(candidate.hostname)
        && (!candidate.port || (Number(candidate.port) >= 1 && Number(candidate.port) <= 65535))) {
      return true;
    }
    return candidate.protocol === "https:"
      && (candidate.hostname === "example.invalid" || candidate.hostname.endsWith(".example.invalid"));
  } catch {
    return false;
  }
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

function sniffMime(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return "image/png";
  }
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from("00000100", "hex"))) {
    return "image/vnd.microsoft.icon";
  }
  return "application/octet-stream";
}

function auditBrandAsset(findings, entry, expected, buffer) {
  const rel = relative(entry.file);
  if (buffer.length !== expected.bytes) {
    findings.push({ rule: "asset.unapproved-size", file: rel, line: 1 });
  }
  if (sniffMime(buffer) !== expected.mime) {
    findings.push({ rule: "asset.unapproved-mime", file: rel, line: 1 });
  }
  const digest = crypto.createHash("sha256").update(buffer).digest("hex");
  if (digest !== expected.sha256) {
    findings.push({ rule: "asset.unapproved-digest", file: rel, line: 1 });
  }
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
    const expectedAsset = brandAssets[rel];
    if (expectedAsset) {
      auditBrandAsset(findings, entry, expectedAsset, buffer);
      continue;
    }
    if (buffer.includes(0)) {
      findings.push({ rule: "content.binary", file: rel, line: 1 });
      continue;
    }
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer).normalize("NFKC");
    } catch {
      findings.push({ rule: "content.invalid-utf8", file: rel, line: 1 });
      continue;
    }
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
      for (const match of text.matchAll(/\b[a-f0-9]{32,}\b/gi)) {
        if (!approvedDigests.has(match[0].toLowerCase())) {
          report(findings, "secret.long-hex", entry.file, text, match.index);
        }
      }
      for (const match of text.matchAll(/\b[A-Za-z0-9_+/=-]{28,}\b/g)) {
        if (entropy(match[0]) >= 4.35) {
          report(findings, "secret.high-entropy-token", entry.file, text, match.index);
        }
      }
    }

    const isBrowserRuntime = rel.endsWith(".js")
      && (rel.startsWith("public/") || rel.startsWith("examples/"));
    if (isBrowserRuntime) {
      for (const [rule, pattern] of browserCapabilities) {
        const match = pattern.exec(text);
        if (match) report(findings, rule, entry.file, text, match.index);
      }
      if (!browserDocumentationFiles.has(rel)) {
        for (const forbidden of mutationMethods) {
          const match = forbidden.exec(text);
          if (match) report(findings, "capability.mutation-method", entry.file, text, match.index);
        }
      }
      for (const pattern of unsafeHtmlPattern) {
        const unsafeHtml = pattern.exec(text);
        if (unsafeHtml) report(findings, "render.unsafe-html", entry.file, text, unsafeHtml.index);
      }
    }

    for (const match of text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
      if (!isAllowedAddress(match[0])) report(findings, "identifier.nonreserved-ip", entry.file, text, match.index);
    }
    for (const match of text.matchAll(/[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/gi)) {
      const domain = match[1].toLowerCase();
      if (domain !== "example.invalid" && !domain.endsWith(".example.invalid")) {
        report(findings, "identifier.nonreserved-email", entry.file, text, match.index);
      }
    }
    for (const match of text.matchAll(/https?:\/\/[^\s)`'"<>]+/gi)) {
      if (!isAllowedUrl(match[0])) report(findings, "identifier.unapproved-url", entry.file, text, match.index);
    }
  }

  for (const expected of requiredTextFiles) {
    if (!actualFiles.has(expected)) findings.push({ rule: "manifest.missing", file: expected, line: 1 });
  }
  for (const expected of Object.keys(brandAssets)) {
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
    console.log(`public audit passed: ${allowedFiles.size} approved paths; ${Object.keys(brandAssets).length} hash-pinned assets`);
  }
}

module.exports = {
  allowedFiles,
  allowedTextFiles,
  audit,
  brandAssets,
  requiredTextFiles,
  sniffMime
};
