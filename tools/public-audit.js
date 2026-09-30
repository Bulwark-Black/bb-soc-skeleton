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
  "docs/INTEGRATION-REVIEW.md",
  "docs/VENDOR-INTEGRATIONS.md",
  "docs/LIVE-MONITORING.md",
  "docs/GUIDED-SETUP.md",
  "docs/AI-SETUP.md",
  "server/live-monitoring.js",
  "server/live-monitoring-transport.js",
  "public/live-monitoring.js",
  "test/live-monitoring.test.js",
  "test/live-monitoring-transport.test.js",
  "test/live-source-runtime.test.js",
  "test/live-monitoring-ui.test.js",
  "test/private-live-monitoring.test.js",
  "server/setup-guides.js",
  "public/setup-guides.js",
  "test/setup-guides.test.js",
  "test/setup-guides-ui.test.js",
  "test/private-setup-guides.test.js",
  "test/setup-agent.test.js",
  "server/source-mapping.js",
  "public/source-mapping.js",
  "tools/map-events.js",
  "test/source-mapping.test.js",
  "test/source-mapping-ui.test.js",
  "test/map-events.test.js",
  "server/document-bindings.js",
  "test/document-bindings.test.js",
  "test/document-library-ui.test.js",
  "test/agent-connection-ui.test.js",
  "server/setup-assistance.js",
  "public/setup-assistance.js",
  "test/setup-assistance.test.js",
  "test/setup-assistance-ui.test.js",
  "examples/better-auth-reference/README.md",
  "examples/better-auth-reference/better-auth-bridge.js",
  "examples/keycloak-reference/README.md",
  "examples/keycloak-reference/keycloak-client.template.json",
  "examples/keycloak-reference/relying-party-boundary.template.json",
  "examples/provider-template.js",
  "package.json",
  "package-lock.json",
  "public/sign-in.html",
  "public/private-sign-in.js",
  "public/document-library.js",
  "public/service-access.js",
  "public/integration-center.js",
  "public/vendor-import.js",
  "server/vendor-import.js",
  "tools/vendor-adapters.js",
  "tools/vendor-cli.js",
  "tools/integration-outbox.js",
  "tools/vendors/cloud.js",
  "tools/vendors/identity.js",
  "tools/vendors/devops.js",
  "test/vendor-cloud.test.js",
  "test/vendor-identity.test.js",
  "test/vendor-devops.test.js",
  "test/vendor-adapters.test.js",
  "test/vendor-cli.test.js",
  "test/vendor-import-ui.test.js",
  "test/integration-outbox.test.js",
  "test/private-vendor-import.test.js",
  "public/scanner-import.js",
  "server/service-access.js",
  "server/integration-catalog.js",
  "server/integration-coverage.js",
  "test/integration-runtime.test.js",
  "test/integration-projections.test.js",
  "test/integration-client.test.js",
  "test/integration-center.test.js",
  "test/private-integrations.test.js",
  "tools/integration-client.js",
  "tools/send-events.js",
  "server/scanner-ingest.js",
  "server/scanner-pages.js",
  "test/scanner-ingest.test.js",
  "test/private-scanner-import.test.js",
  "test/service-access.test.js",
  "tools/import-trivy.js",
  "server/sqlite-telemetry-store.js",
  "test/sqlite-telemetry-store.test.js",
  "server/private-application.js",
  "server/private-auth.js",
  "server/document-store.js",
  "server/operator-context.js",
  "tools/private-account.js",
  "test/private-auth.test.js",
  "test/private-application.test.js",
  "test/first-run-ui.test.js",
  "test/mfa-http.test.js",
  "test/first-run-http.test.js",
  "test/private-source-workflow.test.js",
  "test/private-recovery.test.js",
  "tools/benchmark-private.js",
  "test/document-store.test.js",
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
  ["secret.assignment", /(?:api[_-]?key|client[_-]?secret|password|token)\s*[:=]\s*["'][^"'\r\n]{12,}["']/i]
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
// These opt-in private application modules may issue same-origin HTTP requests.
// The empty static shell still has connect-src 'none'; all other browser
// restrictions (storage, sockets, unsafe HTML, and tokens) remain in force.
const privateApplicationClients = new Set(["public/private-sign-in.js", "public/document-library.js", "public/service-access.js", "public/scanner-import.js", "public/integration-center.js", "public/vendor-import.js", "public/live-monitoring.js", "public/setup-guides.js", "public/source-mapping.js", "public/setup-assistance.js"]);

// Exact public reference pages, not general vendor hosts or deployment URLs.
const publicReferenceUrls = new Set([
  "https://code.claude.com/docs/en/mcp",
  "https://learn.chatgpt.com/docs/extend/mcp?surface=cli",
  "https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference",
  "https://docs.openclaw.ai/tools/mcp",
  "https://www.perplexity.ai/help-center/en/articles/11502712-local-and-remote-mcps-for-perplexity",
  "https://docs.x.ai/grok/connectors/custom-mcp-tunneling",
  "https://sentry.io",
  "https://us.sentry.io",
  "https://de.sentry.io",
  "https://docs.sentry.io/api/",
  "https://docs.sentry.io/api/pagination/",
  "https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/",
  "https://survey.stackoverflow.co/2025/technology",
  "https://www.okta.com/reports/businesses-at-work-archive/businesses-at-work-2025/",
  "https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-event-reference-record-contents.html",
  "https://docs.aws.amazon.com/awscloudtrail/latest/userguide/view-cloudtrail-events-cli.html",
  "https://docs.aws.amazon.com/awscloudtrail/latest/APIReference/API_LookupEvents.html",
  "https://docs.cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry",
  "https://docs.cloud.google.com/logging/docs/reference/v2/rest/v2/entries/list",
  "https://docs.cloud.google.com/logging/docs/reference/audit/auditlog/rest/Shared.Types/AuditLog",
  "https://docs.cloud.google.com/logging/docs/audit",
  "https://docs.cloud.google.com/logging/docs/audit/configure-data-access",
  "https://developers.cloudflare.com/logs/logpush/logpush-job/datasets/zone/firewall_events/",
  "https://developers.cloudflare.com/logs/logpush/logpush-job/log-output-options/",
  "https://developers.cloudflare.com/logs/logpush/permissions/",
  "https://learn.microsoft.com/en-us/graph/api/signin-list?view=graph-rest-1.0",
  "https://learn.microsoft.com/en-us/graph/api/resources/signin?view=graph-rest-1.0",
  "https://developer.okta.com/docs/reference/system-log-query/",
  "https://developer.okta.com/docs/reference/api/event-types/",
  "https://developer.okta.com/docs/api/oauth2/",
  "https://auth0.com/docs/deploy-monitor/logs/retrieve-log-events-using-mgmt-api",
  "https://auth0.com/docs/customize/log-streams/event-filters",
  "https://auth0.com/docs/tenant-logs",
  "https://docs.github.com/en/enterprise-cloud%40latest/rest/orgs/orgs#get-the-audit-log-for-an-organization",
  "https://docs.gitlab.com/api/audit_events/",
  "https://docs.gitlab.com/user/compliance/audit_event_schema/",
  "https://docs.gitlab.com/security/tokens/access_token_scopes/",
  "https://docs.sentry.io/api/events/list-a-projects-error-events/",
  "https://docs.sentry.io/api/events/retrieve-an-event-for-a-project/",
  "https://docs.sentry.io/api/events/list-an-issues-events/",
  "https://docs.datadoghq.com/api/latest/logs/search-logs-post/",
  "https://docs.datadoghq.com/logs/guide/access-your-log-data-programmatically/"
]);

function relative(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function listFiles(directory, results = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || (directory === root && entry.name === "node_modules")) continue;
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
  if (normalized === "http://" || normalized === "https://") return true; // Scheme literal, not an endpoint.
  if (normalized === "http://www.w3.org/2000/svg") return true;
  if (normalized === "https://json-schema.org/draft/2020-12/schema") return true;
  if (publicReferenceUrls.has(normalized)) return true;
  try {
    const candidate = new URL(normalized);
    if (candidate.protocol === "http:"
        && ["127.0.0.1", "localhost", "[::1]"].includes(candidate.hostname)
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

    // A lockfile contains public registry URLs and SHA-512 package integrity
    // values, not application secrets. Validate those fields instead of treating
    // npm metadata as deployment endpoints or high-entropy credentials.
    if (rel === "package-lock.json") {
      try {
        const lock = JSON.parse(text);
        if (lock.lockfileVersion !== 3 || !lock.packages) throw new Error("lock format");
        const declared = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).dependencies;
        if (JSON.stringify(lock.packages[""].dependencies) !== JSON.stringify(declared)) throw new Error("dependencies differ");
        for (const [name, value] of Object.entries(lock.packages)) {
          if (!name) continue;
          if (!/^(?:node_modules\/(?:@[a-z0-9_-]+\/)?[a-z0-9_.-]+)(?:\/node_modules\/(?:@[a-z0-9_-]+\/)?[a-z0-9_.-]+)*$/.test(name)
              || !/^https:\/\/registry\.npmjs\.org\//.test(value.resolved || "")
              || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(value.integrity || "")
              || value.link === true) throw new Error("unapproved dependency");
        }
      } catch { findings.push({ rule: "dependency.invalid-lock", file: rel, line: 1 }); }
      continue;
    }

    for (const marker of privateMarkers) {
      const index = lower.indexOf(marker);
      if (index >= 0) report(findings, "identity.private-marker", entry.file, text, index);
    }
    for (const fragment of operationalFragments) {
      const index = text.indexOf(fragment);
      if (index >= 0) report(findings, "operations.private-fragment", entry.file, text, index);
    }
    const privateTailnetHost = /\b[a-z0-9][a-z0-9.-]+\.ts\.net\b/i.exec(text);
    if (privateTailnetHost) report(findings, "operations.private-tailnet-host", entry.file, text, privateTailnetHost.index);

    if (!selfReferential.has(rel)) {
      const reviewedReferences = [...text.matchAll(/https?:\/\/[^\s)`'"<>]+/gi)]
        .filter(match => publicReferenceUrls.has(match[0].replace(/[.,;:]$/, "")))
        .map(match => [match.index, match.index + match[0].length]);
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
        if (entropy(match[0]) >= 4.35 && !reviewedReferences.some(([start, end]) => match.index >= start && match.index + match[0].length <= end)) {
          report(findings, "secret.high-entropy-token", entry.file, text, match.index);
        }
      }
    }

    const isBrowserRuntime = rel.endsWith(".js")
      && (rel.startsWith("public/") || rel.startsWith("examples/"));
    if (isBrowserRuntime) {
      for (const [rule, pattern] of browserCapabilities) {
        if (rule === "capability.fetch" && privateApplicationClients.has(rel)) continue;
        const match = pattern.exec(text);
        if (match) report(findings, rule, entry.file, text, match.index);
      }
      if (!browserDocumentationFiles.has(rel) && !privateApplicationClients.has(rel)) {
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
