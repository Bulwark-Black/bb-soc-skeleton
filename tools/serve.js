#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const HOST = "127.0.0.1";
const DEFAULT_PORT = 8080;
const PUBLIC_ROOT = path.resolve(__dirname, "..", "public");
const CSP = [
  "default-src 'none'",
  "style-src 'self'",
  "script-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join("; ");

const securityHeaders = Object.freeze({
  "Cache-Control": "no-store",
  "Content-Security-Policy": CSP,
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY"
});

const contentTypes = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png"
});

function addSecurityHeaders(response) {
  for (const [name, value] of Object.entries(securityHeaders)) response.setHeader(name, value);
}

function parsePort(value) {
  if (value === undefined || value === "") return DEFAULT_PORT;
  if (!/^\d{1,5}$/.test(value)) throw new TypeError("PORT must be an integer from 1 through 65535");
  const port = Number(value);
  if (port < 1 || port > 65535) throw new TypeError("PORT must be an integer from 1 through 65535");
  return port;
}

function resolveRequestPath(requestTarget, publicRoot = PUBLIC_ROOT) {
  if (typeof requestTarget !== "string") return null;
  const rawPath = requestTarget.split("?", 1)[0];
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (!decoded.startsWith("/") || decoded.includes("\0") || decoded.includes("\\")) return null;
  const segments = decoded.split("/");
  if (segments.some((segment) => segment === "..")) return null;

  const pathname = decoded === "/" ? "/index.html" : decoded;
  const candidate = path.resolve(publicRoot, `.${pathname}`);
  const prefix = `${path.resolve(publicRoot)}${path.sep}`;
  return candidate.startsWith(prefix) ? candidate : null;
}

async function getSafeFile(requestTarget, publicRoot) {
  const candidate = resolveRequestPath(requestTarget, publicRoot);
  if (!candidate) return null;
  try {
    const [rootRealPath, candidateRealPath] = await Promise.all([
      fs.promises.realpath(publicRoot),
      fs.promises.realpath(candidate)
    ]);
    const prefix = `${rootRealPath}${path.sep}`;
    if (!candidateRealPath.startsWith(prefix)) return null;
    const stat = await fs.promises.stat(candidateRealPath);
    return stat.isFile() ? { file: candidateRealPath, stat } : null;
  } catch {
    return null;
  }
}

function sendText(response, status, message, includeBody = true) {
  const body = Buffer.from(`${message}\n`, "utf8");
  response.statusCode = status;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.setHeader("Content-Length", body.length);
  response.end(includeBody ? body : undefined);
}

function createServer(options = {}) {
  const publicRoot = path.resolve(options.publicRoot || PUBLIC_ROOT);
  return http.createServer(async (request, response) => {
    addSecurityHeaders(response);
    const isHead = request.method === "HEAD";
    if (request.method !== "GET" && !isHead) {
      response.setHeader("Allow", "GET, HEAD");
      sendText(response, 405, "Method not allowed", !isHead);
      return;
    }

    const resolved = await getSafeFile(request.url || "/", publicRoot);
    if (!resolved) {
      sendText(response, 404, "Not found", !isHead);
      return;
    }

    response.statusCode = 200;
    response.setHeader("Content-Type", contentTypes[path.extname(resolved.file).toLowerCase()] || "application/octet-stream");
    response.setHeader("Content-Length", resolved.stat.size);
    if (isHead) {
      response.end();
      return;
    }
    const stream = fs.createReadStream(resolved.file);
    stream.on("error", () => {
      if (!response.headersSent) sendText(response, 500, "Unable to read file");
      else response.destroy();
    });
    stream.pipe(response);
  });
}

function main() {
  let port;
  try {
    port = parsePort(process.env.PORT);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  const server = createServer();
  server.once("error", (error) => {
    console.error(`Unable to start local server: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, HOST, () => {
    console.log("Bulwark Black SOC skeleton: http://" + HOST + ":" + port);
  });
}

if (require.main === module) main();

module.exports = {
  CSP,
  DEFAULT_PORT,
  HOST,
  PUBLIC_ROOT,
  contentTypes,
  createServer,
  parsePort,
  resolveRequestPath,
  securityHeaders
};
