"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Database = require("better-sqlite3");
const { startPrivateApplication, browserFirstRunAllowed } = require("../server/private-application");

const ENDPOINT = "/api/v1/first-run";

function account(index = 1) {
  const password = crypto.randomBytes(24).toString("base64url");
  return { name: "First operator " + index, email: "first-operator-" + index + "@example.invalid", password, confirmPassword: password };
}

async function harness(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "bb-soc-first-run-http-"));
  let app;
  t.after(async () => {
    if (app) await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const start = (port) => startPrivateApplication({ stateDirectory: directory, port, monitoring: {
    autoStart: false, fetchImpl: async () => { throw new Error("Unexpected outbound request during first-run HTTP test."); }
  }, ...options });
  app = await start(0);
  return {
    directory,
    get app() { return app; },
    async restart() {
      const port = app.server.address().port;
      await app.close();
      app = null;
      app = await start(port);
    },
    request(endpoint = ENDPOINT, { method = "GET", body, headers = {}, chunks } = {}) {
      // Always connect to the disposable local listener, including Tailnet-origin
      // policy tests. No DNS, reverse proxy, or production account is involved.
      return new Promise((resolve, reject) => {
        const configured = new URL(app.url);
        const values = { host: configured.host, origin: configured.origin, connection: "close", ...headers };
        for (const name of Object.keys(values)) if (values[name] === undefined) delete values[name];
        if (body !== undefined && !chunks && values["content-length"] === undefined) values["content-length"] = String(Buffer.byteLength(body));
        const request = http.request({ hostname: "127.0.0.1", port: app.server.address().port,
          path: endpoint, method, headers: values }, (response) => {
          const bytes = [];
          response.on("data", (chunk) => bytes.push(chunk));
          response.on("error", reject);
          response.on("end", () => {
            const text = Buffer.concat(bytes).toString("utf8");
            resolve({ status: response.statusCode, headers: response.headers, text,
              json: () => JSON.parse(text) });
          });
        });
        request.on("error", reject);
        if (chunks) for (const chunk of chunks) request.write(chunk);
        request.end(body);
      });
    },
    create(value = account(), options = {}) {
      return this.request(ENDPOINT, { method: "POST", body: JSON.stringify(value), ...options,
        headers: { "content-type": "application/json", ...options.headers } });
    }
  };
}

function assertNoSession(response, forbidden = []) {
  assert.equal(response.headers["set-cookie"], undefined);
  assert.equal(response.headers["cache-control"], "no-store");
  for (const value of forbidden) assert.equal(response.text.includes(value), false, "must not echo supplied identity or secret");
  assert.doesNotMatch(response.text, /"(?:token|password|session|authSecret)"\s*:/i);
}

test("browser bootstrap eligibility requires a direct loopback peer and exact local origin class", () => {
  const request = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });
  for (const remoteAddress of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
    assert.equal(browserFirstRunAllowed(request(remoteAddress), "http://127.0.0.1:8080"), true);
  }
  for (const remoteAddress of [undefined, "192.0.2.1", [100, 64, 0, 1].join("."), "::ffff:192.0.2.1"]) {
    assert.equal(browserFirstRunAllowed(request(remoteAddress), "http://127.0.0.1:8080"), false);
  }
  assert.equal(browserFirstRunAllowed({ headers: {} }, "http://127.0.0.1:8080"), false);
  for (const origin of ["http://" + ["untrusted", "example", "invalid"].join(".") + ":8080", "https://" + [127, 0, 0, 1].join(".") + ":8080", "https://" + ["console", "example", "ts", "net"].join(".")]) {
    assert.equal(browserFirstRunAllowed(request("127.0.0.1"), origin), false);
  }
  for (const name of ["Forwarded", "X-Forwarded", "X-Forwarded-Unknown", "Via"]) {
    assert.equal(browserFirstRunAllowed(request("127.0.0.1", { [name]: "" }), "http://127.0.0.1:8080"), false);
  }
});

test("first-run creates one operator without signing in, closes durably, and permits normal sign-in", async (t) => {
  const h = await harness(t);
  const details = account();
  let response = await h.request();
  assert.equal(response.status, 200);
  assert.deepEqual(response.json(), { schemaVersion: "1", setupRequired: true, browserSetupAllowed: true });
  assertNoSession(response);
  assert.equal((await h.request("/api/v1/control/snapshot")).status, 401);
  assert.equal((await h.request("/api/v1/documents")).status, 401);
  response = await h.create(details);
  assert.equal(response.status, 201, response.text);
  assert.deepEqual(response.json(), { schemaVersion: "1", created: true });
  assertNoSession(response, [details.name, details.email, details.password]);
  assert.equal(h.app.authentication.countOperators(), 1);
  assert.deepEqual((await h.request("/api/v1/session")).json(), { authenticated: false });
  assert.equal((await h.request("/api/v1/control/snapshot")).status, 401);
  assert.deepEqual((await h.request()).json(), { schemaVersion: "1", setupRequired: false, browserSetupAllowed: false });
  response = await h.create(account(2));
  assert.equal(response.status, 409);
  assertNoSession(response);
  await h.restart();
  assert.deepEqual((await h.request()).json(), { schemaVersion: "1", setupRequired: false, browserSetupAllowed: false });
  assert.equal((await h.create(account(3))).status, 409);
  response = await h.request("/api/auth/sign-in/email", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: details.email, password: details.password }) });
  assert.equal(response.status, 200, response.text);
  assert.ok(response.headers["set-cookie"]?.length);
  const cookie = response.headers["set-cookie"].map((value) => value.split(";")[0]).join("; ");
  assert.equal((await h.request("/api/v1/session", { headers: { cookie } })).json().authenticated, true);
  assert.equal((await h.request("/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(account(4)) })).status, 404);
});

test("first-run authority checks reject foreign, missing, forged, and bearer authority without creating accounts", async (t) => {
  const h = await harness(t);
  const details = account();
  const badHeaders = [
    { origin: undefined },
    { origin: "null" },
    { origin: "https://untrusted.example.invalid" },
    { origin: h.app.url.replace("127.0.0.1", "localhost") },
    { host: "untrusted.example.invalid" },
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" }
  ];
  for (const headers of badHeaders) {
    const response = await h.create(details, { headers });
    assert.equal(response.status, 403, JSON.stringify(headers));
    assertNoSession(response, [details.password]);
  }
  for (const method of ["GET", "POST"]) {
    const response = await h.request(ENDPOINT, { method,
      headers: { authorization: "Bearer " + crypto.randomBytes(24).toString("base64url"), "content-type": "application/json", cookie: "untrusted-session=1" },
      ...(method === "POST" ? { body: JSON.stringify(details) } : {}) });
    assert.equal(response.status, 401);
    assertNoSession(response, [details.password]);
  }
  assert.equal(h.app.authentication.countOperators(), 0);
  assert.equal((await h.create(details)).status, 201, "rejected authority is not first-run hash work");
});

test("first-run refuses forwarded browser enrollment even when supplied headers claim loopback", async (t) => {
  const h = await harness(t);
  const details = account();
  for (const name of ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port", "x-real-ip", "via", "x-bb-soc-client-ip"]) {
    const headers = { [name]: "127.0.0.1" };
    const status = await h.request(ENDPOINT, { headers });
    assert.equal(status.status, 200, name);
    assert.deepEqual(status.json(), { schemaVersion: "1", setupRequired: true, browserSetupAllowed: false });
    const response = await h.create(details, { headers });
    assert.equal(response.status, 403, name);
    assertNoSession(response, [details.password]);
  }
  assert.equal(h.app.authentication.countOperators(), 0);
  assert.equal((await h.create(details)).status, 201);
});

test("Tailnet-origin installations cannot initialize accounts through browser bootstrap", async (t) => {
  const baseURL = "https://" + ["console", "first-run-example", "ts", "net"].join(".");
  const h = await harness(t, { baseURL });
  const details = account();
  let response = await h.request();
  assert.equal(response.status, 200);
  assert.deepEqual(response.json(), { schemaVersion: "1", setupRequired: true, browserSetupAllowed: false });
  response = await h.create(details);
  assert.equal(response.status, 403);
  assertNoSession(response, [details.password]);
  assert.equal(h.app.authentication.countOperators(), 0);
  await h.app.authentication.createOperator(details);
  assert.deepEqual((await h.request()).json(), { schemaVersion: "1", setupRequired: false, browserSetupAllowed: false });
});

test("first-run has a closed endpoint shape and validates input before writing", async (t) => {
  for (const [label, transform, status] of [
    ["missing field", (value) => { delete value.confirmPassword; return value; }, 400],
    ["unexpected field", (value) => ({ ...value, role: "admin" }), 400],
    ["password mismatch", (value) => ({ ...value, confirmPassword: value.password + "x" }), 400],
    ["invalid email", (value) => ({ ...value, email: "not-an-email" }), 400],
    ["empty name", (value) => ({ ...value, name: "  " }), 400],
    ["short password", (value) => ({ ...value, password: "short", confirmPassword: "short" }), 400],
    ["array", () => [], 400],
    ["null", () => null, 400]
  ]) {
    await t.test(label, async (subtest) => {
      const h = await harness(subtest);
      const details = account();
      const response = await h.create(transform({ ...details }));
      assert.equal(response.status, status, response.text);
      assertNoSession(response, [details.password]);
      assert.equal(h.app.authentication.countOperators(), 0);
      assert.equal((await h.request()).json().setupRequired, true);
    });
  }
  await t.test("unknown query and unsupported methods", async (subtest) => {
    const h = await harness(subtest);
    for (const method of ["GET", "POST"]) {
      const response = await h.request(ENDPOINT + "?create=true", { method, headers: { "content-type": "application/json" },
        ...(method === "POST" ? { body: JSON.stringify(account()) } : {}) });
      assert.equal(response.status, 400);
    }
    for (const method of ["PUT", "PATCH", "DELETE", "OPTIONS"]) {
      assert.equal((await h.request(ENDPOINT, { method, headers: { "content-type": "application/json" }, body: "{}" })).status, 405, method);
    }
    assert.equal(h.app.authentication.countOperators(), 0);
  });
});

test("first-run rejects malformed, over-limit, non-JSON, and compressed request bodies", async (t) => {
  for (const [label, options, expected] of [
    ["malformed", { body: "{bad-json" }, 400],
    ["empty", { body: "" }, 400],
    ["invalid UTF-8", { body: Buffer.from([0x7b, 0xff, 0x7d]) }, 400],
    ["wrong content type", { body: "{}", headers: { "content-type": "text/plain" } }, 415],
    ["compression", { body: "{}", headers: { "content-encoding": "gzip" } }, 415],
    ["declared too large", { body: "x".repeat(16385), headers: { "content-length": "16385" } }, 413],
    ["streamed too large", { chunks: ["x".repeat(10000), "x".repeat(6385)] }, 413]
  ]) {
    await t.test(label, async (subtest) => {
      const h = await harness(subtest);
      const response = await h.request(ENDPOINT, { method: "POST", ...options,
        headers: { "content-type": "application/json", ...options.headers } });
      assert.equal(response.status, expected, response.text);
      assertNoSession(response);
      assert.equal(h.app.authentication.countOperators(), 0);
    });
  }
});

test("concurrent bootstrap requests create at most one account and reject repeated attempts", async (t) => {
  const h = await harness(t);
  const values = [account(1), account(2), account(3)];
  const responses = await Promise.all(values.map((value) => h.create(value)));
  assert.equal(responses.filter((response) => response.status === 201).length, 1);
  for (const response of responses.filter((response) => response.status !== 201)) {
    assert.ok([409, 429].includes(response.status), response.text);
    if (response.status === 429) assert.ok(Number(response.headers["retry-after"]) >= 1);
    assertNoSession(response, values.map((value) => value.password));
  }
  assert.equal(h.app.authentication.countOperators(), 1);
  const response = await h.create(account(4));
  assert.equal(response.status, 409);
  assert.equal((await h.request()).json().setupRequired, false);
});

test("malformed attempts have a bounded shared rate budget and status remains read-only", async (t) => {
  const h = await harness(t);
  for (let index = 0; index < 5; index += 1) {
    const response = await h.create({});
    assert.equal(response.status, 400, "attempt " + (index + 1));
    assertNoSession(response);
  }
  const details = account();
  const limited = await h.create(details);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers["retry-after"]) >= 1);
  assertNoSession(limited, [details.password]);
  assert.equal(h.app.authentication.countOperators(), 0);
  assert.deepEqual((await h.request()).json(), { schemaVersion: "1", setupRequired: true, browserSetupAllowed: true });
});

test("CLI-provisioned and previously initialized installations never reopen browser bootstrap", async (t) => {
  const h = await harness(t);
  const details = account();
  await h.app.authentication.createOperator(details);
  assert.deepEqual((await h.request()).json(), { schemaVersion: "1", setupRequired: false, browserSetupAllowed: false });
  assert.equal((await h.create(account(2))).status, 409);
  await h.restart();
  const database = new Database(path.join(h.directory, "auth.sqlite"));
  try {
    database.pragma("foreign_keys = ON");
    database.exec('DELETE FROM session; DELETE FROM account; DELETE FROM "user";');
  } finally { database.close(); }
  assert.equal(h.app.authentication.countOperators(), 0);
  assert.equal((await h.request()).json().setupRequired, false, "completion is not just the current account count");
  assert.equal((await h.create(account(3))).status, 409);
  await h.restart();
  assert.equal((await h.request()).json().setupRequired, false);
  assert.equal((await h.create(account(4))).status, 409);
});
