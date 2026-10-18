"use strict";
const https = require("node:https"), dns = require("node:dns"), net = require("node:net");
const { CollectorError, fail, readPrivate } = require("./common");
const MAX_BYTES = 8 * 1024 * 1024;
function privateAddress(ip) {
  if (net.isIP(ip) === 4) { const [a, b] = ip.split(".").map(Number); return a === 10 || a === 127 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127; }
  return net.isIP(ip) === 6 && (/^f[cd]/i.test(ip) || ip === "::1");
}
function privateLookup(hostname, options, cb) {
  dns.lookup(hostname, { all: true }, (error, addresses) => {
    if (error || !addresses.length || addresses.some(a => !privateAddress(a.address))) return cb(new Error("unapproved-address"));
    cb(null, options.all ? addresses : addresses[0].address, addresses[0].family);
  });
}
function transport(request) {
  return new Promise((resolve, reject) => {
    const url = new URL(request.url);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return reject(new CollectorError("invalid-origin"));
    if (request.privateNetwork && net.isIP(url.hostname.replace(/^\[|\]$/g, "")) && !privateAddress(url.hostname.replace(/^\[|\]$/g, ""))) return reject(new CollectorError("invalid-origin"));
    let timer;
    const req = https.request(url, { method: request.method || "GET", headers: request.headers, rejectUnauthorized: true,
      ...(request.ca ? { ca: request.ca } : {}), ...(request.privateNetwork ? { lookup: privateLookup } : {}) }, res => {
      let size = 0; const chunks = [];
      res.on("data", chunk => { size += chunk.length; if (size > MAX_BYTES) req.destroy(new Error("too-large")); else chunks.push(chunk); });
      res.on("end", () => { clearTimeout(timer); resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }); });
      res.on("error", () => { clearTimeout(timer); reject(new CollectorError("network-unavailable", 30000)); });
    });
    timer = setTimeout(() => req.destroy(new Error("timeout")), 30000);
    req.on("error", () => { clearTimeout(timer); reject(new CollectorError("network-unavailable", 30000)); });
    req.end(request.body);
  });
}
function headers(response) { return Object.fromEntries(Object.entries(response.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)])); }
async function jsonRequest(send, request, now) {
  let r; try { r = await send(request); } catch (e) { if (e instanceof CollectorError) throw e; throw new CollectorError("network-unavailable", 30000); }
  const h = headers(r);
  if (r.status !== 200) {
    const retry = [429, 500, 502, 503, 504].includes(r.status);
    const raw = h["retry-after"]; let delay = raw && /^\d+$/.test(raw) ? Number(raw) * 1000 : raw ? Date.parse(raw) - now : 30000;
    if (!Number.isFinite(delay) || delay < 1000) delay = 30000;
    if (delay > 7 * 86400000) fail("retry-window-exceeded");
    throw new CollectorError(retry ? "provider-throttled" : r.status === 401 || r.status === 403 ? "provider-unauthorized" : "provider-http-failure", retry ? delay : 0);
  }
  // Injected transports use the same byte and UTF-8 checks as real HTTPS.
  const raw = Buffer.isBuffer(r.body) ? r.body : Buffer.from(typeof r.body === "string" ? r.body : JSON.stringify(r.body));
  if (raw.length > MAX_BYTES) fail("provider-response-too-large");
  let body; try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); } catch { fail("provider-invalid-json"); }
  return { body, headers: h };
}
function safeNext(value, origin, pathname) {
  if (typeof value !== "string" || value.length > 16384 || /[\x00-\x20\x7f]/.test(value)) fail("unsafe-pagination-url");
  let u; try { u = new URL(value); } catch { fail("unsafe-pagination-url"); }
  if (u.origin !== origin || u.pathname !== pathname || u.username || u.password || u.hash) fail("unsafe-pagination-url");
  return u.href;
}
async function credentials(config, send, now) {
  let c; try { c = JSON.parse(readPrivate(config.providerCredentialFile)); } catch { fail("invalid-provider-credential"); }
  const scalar = v => typeof v === "string" && v.length >= 1 && v.length <= 8192 && !/[^\x21-\x7e]/.test(v);
  if (config.provider === "checkmk") {
    if (!c || Object.keys(c).some(k => !["username", "secret"].includes(k)) || !scalar(c.username) || !scalar(c.secret)) fail("invalid-provider-credential");
    return "Bearer " + c.username + " " + c.secret;
  }
  if (config.provider === "okta") {
    if (!c || Object.keys(c).length !== 1 || !scalar(c.token)) fail("invalid-provider-credential");
    return config.options.authScheme + " " + c.token;
  }
  if (c && Object.keys(c).length === 1 && scalar(c.accessToken)) return "Bearer " + c.accessToken;
  if (!c || Object.keys(c).some(k => !["clientId", "clientSecret"].includes(k)) || !scalar(c.clientId) || !scalar(c.clientSecret)) fail("invalid-provider-credential");
  const scope = config.provider === "microsoft365" ? "https://manage.office.com/.default" : "https://graph.microsoft.com/.default";
  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: c.clientId, client_secret: c.clientSecret, scope }).toString();
  const r = await jsonRequest(send, { url: `https://login.microsoftonline.com/${config.options.tenantId}/oauth2/v2.0/token`, method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body }, now);
  if (!r.body || r.body.token_type !== "Bearer" || !scalar(r.body.access_token)) fail("provider-invalid-credential-response");
  return "Bearer " + r.body.access_token;
}
module.exports = { transport, jsonRequest, safeNext, credentials, privateAddress };
