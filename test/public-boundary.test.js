"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { audit } = require("../tools/public-audit");

const root = path.resolve(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

test("the positive publication manifest and content audit pass", () => {
  assert.deepEqual(audit(), []);
});

test("the browser app has no network, persistence, or mutation capability", () => {
  const source = read("public/app.js");
  const forbidden = [
    ["fe", "tch"].join(""),
    ["Web", "Socket"].join(""),
    ["Event", "Source"].join(""),
    ["XMLHttp", "Request"].join(""),
    ["send", "Beacon"].join(""),
    ["local", "Storage"].join(""),
    ["session", "Storage"].join(""),
    ["indexed", "DB"].join(""),
    ["service", "Worker"].join("")
  ];
  for (const capability of forbidden) assert.equal(source.includes(capability), false, capability);
  for (const method of [["PO", "ST"], ["PU", "T"], ["PAT", "CH"], ["DEL", "ETE"]]) {
    assert.equal(source.includes(method.join("")), false, method.join(""));
  }
  assert.equal(source.includes("innerHTML"), false);
  assert.equal(source.includes("outerHTML"), false);
});

test("the static shell declares a closed connection policy", () => {
  const html = read("public/index.html");
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /form-action 'none'/);
  assert.match(html, /frame-ancestors 'none'/);
  assert.match(html, /id="content"/);
  assert.match(html, /id="route-select"/);
  assert.doesNotMatch(html, /<form\b/i);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/i);
  assert.doesNotMatch(html, /<style\b/i);
});

test("all expected demonstration pages are present in the fixed catalog", () => {
  const source = read("public/app.js");
  const routes = [
    "/", "/health", "/brief", "/analytics", "/timeline",
    "/triage", "/tuning", "/rules", "/alerts", "/honeypots", "/phishing",
    "/logs", "/activity", "/ioc", "/intel", "/known-ips",
    "/scans", "/remediation", "/systems", "/databases", "/backups",
    "/retention", "/sources", "/attestations", "/register", "/access",
    "/onboard", "/settings"
  ];
  for (const route of routes) {
    const literal = JSON.stringify(route);
    assert.ok(source.includes(literal), `missing ${route}`);
  }
  assert.equal(routes.length, 28);
});

test("fixtures use reserved identities and deterministic values", () => {
  const source = read("public/app.js");
  for (const match of source.matchAll(/[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/gi)) {
    assert.ok(match[1].endsWith("example.invalid"), match[0]);
  }
  for (const match of source.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
    assert.ok(match[0].startsWith("192.0.2.") || match[0].startsWith("198.51.100."), match[0]);
  }
  assert.equal(source.includes("Date.now"), false);
  assert.equal(source.includes("Math.random"), false);
});

test("README states the non-operational boundary", () => {
  const readme = read("README.md");
  assert.match(readme, /does not collect telemetry/i);
  assert.match(readme, /no credentials/i);
  assert.match(readme, /no outbound network clients/i);
  assert.match(readme, /not production-ready/i);
});
