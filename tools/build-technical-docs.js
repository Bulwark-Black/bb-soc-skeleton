#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SOURCE = path.join(ROOT, "public", "technical-reference.md");
const OUTPUT = path.join(ROOT, "public", "technical-docs.js");

function sectionId(title) {
  return String(title)
    .toLowerCase()
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function sectionsFromMarkdown(markdown) {
  const sections = [];
  const lines = markdown.split("\n");
  lines.forEach((line, index) => {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (!match) return;
    const title = match[1].trim();
    const id = sectionId(title);
    if (!id) throw new TypeError(`Technical manual heading on line ${index + 1} has no stable identifier.`);
    if (sections.some((section) => section.id === id)) {
      throw new TypeError(`Technical manual section identifier ${id} is duplicated.`);
    }
    sections.push(Object.freeze({ id, title, line: index + 1 }));
  });
  if (sections.length < 20) throw new TypeError("Technical manual must contain at least 20 level-two sections.");
  return Object.freeze(sections);
}

function validateCodeFences(markdown) {
  const lines = markdown.split("\n");
  let active = null;
  lines.forEach((line, index) => {
    const match = /^~~~([a-z0-9-]*)\s*$/i.exec(line);
    if (!match) {
      if (active) active.lines.push(line);
      return;
    }
    const language = match[1].toLowerCase();
    if (!active) {
      if (!language) throw new TypeError(`Technical manual code fence on line ${index + 1} must declare a language.`);
      active = { language, line: index + 1, lines: [] };
      return;
    }
    if (language) throw new TypeError(`Technical manual code fence opened on line ${active.line} is nested or not closed.`);
    if (active.language === "json") {
      try { JSON.parse(active.lines.join("\n")); }
      catch (error) {
        throw new TypeError(`Technical manual JSON example opened on line ${active.line} is invalid: ${error.message}`);
      }
    }
    active = null;
  });
  if (active) throw new TypeError(`Technical manual code fence opened on line ${active.line} is not closed.`);
}

function validateMarkdown(markdown) {
  if (typeof markdown !== "string" || markdown.length < 20_000) {
    throw new TypeError("Technical manual must contain at least 20,000 characters.");
  }
  if (!markdown.startsWith("# Bulwark Black SOC technical implementation manual\n")) {
    throw new TypeError("Technical manual title is missing or unexpected.");
  }
  if (/<\/?(?:script|style|iframe|object|embed)\b/i.test(markdown)) {
    throw new TypeError("Technical manual must not contain executable or embedded HTML.");
  }
  if (!markdown.endsWith("\n")) throw new TypeError("Technical manual must end with a newline.");
  validateCodeFences(markdown);
  return sectionsFromMarkdown(markdown);
}

function generatedSource(markdown) {
  const sections = validateMarkdown(markdown);
  const document = JSON.stringify({
    schemaVersion: "1",
    documentType: "technical-manual",
    title: "Bulwark Black SOC technical implementation manual",
    source: "technical-reference.md",
    sections,
    markdown
  }, null, 2);
  return `"use strict";\n\n// Generated from technical-reference.md by tools/build-technical-docs.js.\n// Edit the Markdown source, then run npm run build:docs.\n(function installTechnicalDocs(root, value) {\n  function deepFreeze(candidate) {\n    if (!candidate || typeof candidate !== "object" || Object.isFrozen(candidate)) return candidate;\n    Reflect.ownKeys(candidate).forEach((key) => deepFreeze(candidate[key]));\n    return Object.freeze(candidate);\n  }\n  const documentValue = deepFreeze(value);\n  if (root) root.SocConsoleTechnicalDocs = documentValue;\n  if (typeof module === "object" && module && module.exports) module.exports = documentValue;\n}(\n  typeof window === "object" && window ? window :\n    (typeof globalThis === "object" ? globalThis : null),\n  ${document}\n));\n`;
}

function build(options = {}) {
  const markdown = fs.readFileSync(SOURCE, "utf8");
  const expected = generatedSource(markdown);
  if (options.check) {
    const actual = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, "utf8") : "";
    if (actual !== expected) throw new Error("public/technical-docs.js is stale; run npm run build:docs.");
    return { sections: sectionsFromMarkdown(markdown).length, bytes: Buffer.byteLength(markdown) };
  }
  fs.writeFileSync(OUTPUT, expected, { encoding: "utf8", mode: 0o644 });
  return { sections: sectionsFromMarkdown(markdown).length, bytes: Buffer.byteLength(markdown) };
}

function main() {
  const check = process.argv.slice(2).includes("--check");
  try {
    const result = build({ check });
    console.log(`${check ? "technical documentation is current" : "technical documentation built"}: ${result.sections} sections; ${result.bytes} source bytes`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  OUTPUT,
  SOURCE,
  build,
  generatedSource,
  sectionId,
  sectionsFromMarkdown,
  validateCodeFences,
  validateMarkdown
};
