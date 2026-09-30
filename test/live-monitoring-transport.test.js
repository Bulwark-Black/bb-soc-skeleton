"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { validateSentryConfig, validateToken, validateSlackWebhook, fetchSentryPage, sendSlack, LiveTransportError,
  MAX_SENTRY_BYTES, TIMEOUT_MS } = require("../server/live-monitoring-transport");

const CONFIG = { region: "us", organization: "synthetic-org", project: "synthetic-app" };
const START = "2026-09-29T12:00:00.000Z", END = "2026-09-29T12:05:00.000Z";
const TOKEN = "synthetic" + "-read-token-not-a-live-secret";
const SLACK_ORIGIN = "https://" + ["hooks", "slack", "com"].join(".");
const WEBHOOK = SLACK_ORIGIN + ["", "services", "TSYNTHETIC", "BSYNTHETIC", "synthetic-not-a-live-secret"].join("/");
function event(overrides = {}) { return { eventID: "a".repeat(32), dateCreated: "2026-09-29T12:02:00.000Z", "event.type": "error",
  platform: "javascript", groupID: "123", projectID: "456", tags: [{ key: "level", value: "error" }], ...overrides }; }
function requestUrl(region = "us") {
  const url = new URL(({ us: "https://us.sentry.io", eu: "https://de.sentry.io", default: "https://sentry.io" })[region]
    + "/api/0/projects/synthetic-org/synthetic-app/events/");
  for (const [key, value] of Object.entries({ start: START, end: END, full: "false", sample: "false", per_page: "100" })) url.searchParams.set(key, value);
  return url;
}
function link(url = requestUrl(), { next = "0:100:0", hasMore = false, omitWindow = false } = {}) {
  const previous = new URL(url), following = new URL(url);
  if (omitWindow) { previous.search = ""; following.search = ""; }
  previous.searchParams.set("cursor", "0:0:1"); following.searchParams.set("cursor", next);
  return `<${previous.href}>; rel="previous"; results="false"; cursor="0:0:1", <${following.href}>; rel="next"; results="${hasMore}"; cursor="${next}"`;
}
function response(events = [event()], options = {}) {
  return new Response(JSON.stringify(events), { status: 200, headers: { "content-type": "application/json", link: link(), ...options } });
}
function page(options = {}) { return fetchSentryPage({ config: CONFIG, token: TOKEN, start: START, end: END, fetchImpl: async () => response(), ...options }); }
function errorCode(code, extra = {}) {
  return error => {
    assert.ok(error instanceof LiveTransportError); assert.equal(error.code, code);
    for (const [key, value] of Object.entries(extra)) assert.equal(error[key], value);
    assert.ok(!error.message.includes(TOKEN)); assert.ok(!error.message.includes(WEBHOOK));
    return true;
  };
}

test("live transport accepts only bounded fixed-region Sentry and Slack configuration", () => {
  assert.deepEqual(validateSentryConfig({ organization: "synthetic-org", project: "synthetic-app" }), { ...CONFIG, region: "default" });
  assert.ok(Object.isFrozen(validateSentryConfig(CONFIG)));
  for (const mutation of [{ region: "https://other.example.invalid" }, { region: "toString" }, { organization: "../other" },
    { organization: "%2e%2e" }, { project: "an app" }, { baseUrl: "http://127.0.0.1" }, { token: TOKEN }]) {
    assert.throws(() => validateSentryConfig({ ...CONFIG, ...mutation }), errorCode("invalid-config"));
  }
  assert.throws(() => validateSentryConfig(Object.defineProperty({ ...CONFIG }, "region", { get() { throw new Error("must not read"); } })), errorCode("invalid-config"));
  assert.equal(validateToken(TOKEN), TOKEN);
  for (const token of ["", "short", TOKEN + "\r\n", "Bearer " + TOKEN, "x".repeat(2049)]) assert.throws(() => validateToken(token), errorCode("invalid-token"));
  assert.equal(validateSlackWebhook(WEBHOOK), WEBHOOK);
  for (const url of [WEBHOOK.replace("https:", "http:"), WEBHOOK.replace("hooks.slack.com", "hooks.slack.com.evil.invalid"),
    WEBHOOK.replace("hooks.slack.com", "127.0.0.1"), WEBHOOK.replace("hooks.slack.com", ["user", "hooks.slack.com"].join("@")),
    WEBHOOK + "?secret=no", WEBHOOK + "#fragment", WEBHOOK + "/../next", WEBHOOK.replace("/services/", "/%73ervices/"),
    WEBHOOK.replace("hooks.slack.com", "hooks.slack.com:443"), WEBHOOK.replace("hooks.slack.com", "hooks.slack-gov.com")]) {
    assert.throws(() => validateSlackWebhook(url), errorCode("invalid-webhook"));
  }
});

test("Sentry GET is region-pinned, read-only, unsampled, bounded and keeps bearer auth off query strings", async () => {
  for (const region of ["us", "eu", "default"]) {
    let calls = 0;
    const result = await page({ config: { ...CONFIG, region }, fetchImpl: async (input, init) => {
      calls += 1;
      assert.equal(input, requestUrl(region).href); assert.equal(init.method, "GET"); assert.equal(init.redirect, "error");
      assert.equal(init.headers.Authorization, "Bearer " + TOKEN); assert.equal(init.headers.Accept, "application/json");
      assert.ok(init.signal instanceof AbortSignal); assert.equal(init.body, undefined); assert.ok(!input.includes(TOKEN));
      return response([event()], { link: link(requestUrl(region)) });
    } });
    assert.deepEqual(result, { events: [event()], nextCursor: null }); assert.equal(calls, 1);
  }
});

test("valid empty Sentry page confirms a completed read without manufacturing an observation", async () => {
  assert.deepEqual(await page({ fetchImpl: async () => response([]) }), { events: [], nextCursor: null });
});

test("Sentry next-page metadata yields only a cursor; subsequent request reconstructs the original fixed query", async () => {
  const first = await page({ fetchImpl: async () => response([event()], { link: link(requestUrl(), { hasMore: true, omitWindow: true }) }) });
  assert.equal(first.nextCursor, "0:100:0");
  const expected = requestUrl(); expected.searchParams.set("cursor", first.nextCursor);
  await page({ cursor: first.nextCursor, fetchImpl: async input => {
    assert.equal(input, expected.href); return response([event()], { link: link(expected, { next: "0:200:0" }) });
  } });
});

test("Sentry refuses missing, ambiguous, non-advancing or changed pagination without following supplied URLs", async () => {
  const valid = link();
  const malformed = ["", "not a link", valid.replace('rel="next"', 'rel="previous"'),
    valid.replace('results="false"', 'results="maybe"'), valid.replace('cursor="0:100:0"', 'cursor="0:200:0"'),
    valid.replaceAll("us.sentry.io", "evil.invalid"), valid.replaceAll("/synthetic-app/", "/other-app/"),
    valid.replaceAll("full=false", "full=true"), valid.replaceAll("sample=false", "sample=true"),
    valid.replaceAll("per_page=100", "per_page=1000"), valid.replaceAll("12%3A00%3A00", "11%3A00%3A00"),
    valid.replaceAll("?start=", "?statsPeriod=24h&start="), valid.replaceAll("?start=", "?cursor=0%3A0%3A0&start="),
    valid.replaceAll("https://us.sentry.io" + "/", "https://" + ["user", "us.sentry.io"].join("@") + "/"), valid + ", " + valid,
    valid.replaceAll("0:100:0", "0:100:1").replaceAll("0%3A100%3A0", "0%3A100%3A1")];
  for (const header of malformed) {
    let calls = 0;
    await assert.rejects(page({ fetchImpl: async () => { calls += 1; return response([event()], { link: header }); } }), errorCode("invalid-pagination", { retryable: false }));
    assert.equal(calls, 1);
  }
  await assert.rejects(page({ cursor: "0:100:0", fetchImpl: async () => response([event()], { link: link(requestUrl(), { hasMore: true }) }) }), errorCode("invalid-pagination"));
  await assert.rejects(page({ fetchImpl: async () => new Response("[]", { headers: { "content-type": "application/json" } }) }), errorCode("invalid-pagination"));
});

test("invalid windows and cursors fail before sending a request", async () => {
  let calls = 0; const fetchImpl = async () => { calls += 1; return response(); };
  for (const options of [{ start: "2026-02-30T12:00:00.000Z" }, { start: END }, { start: "2026-09-29" }, { end: START }]) {
    await assert.rejects(page({ ...options, fetchImpl }), errorCode("invalid-window"));
  }
  for (const cursor of ["https://other.example.invalid", "0:100:1", "0:100:0&scope=all", "0:100:0".repeat(100)]) {
    await assert.rejects(page({ cursor, fetchImpl }), errorCode("invalid-pagination"));
  }
  assert.equal(calls, 0);
});

test("Sentry rejects malformed, overfull, duplicate, out-of-window and partial/inconsistent pages", async () => {
  for (const events of [{ data: [event()] }, { detail: "remote credential detail" }, [event({ dateCreated: START.replace("12:00", "11:59") })],
    [event({ dateCreated: END.replace("12:05", "12:06") })], [event({ eventID: "bad" })], [event({ "event.type": "transaction" })],
    [event(), event()], Array.from({ length: 101 }, () => event())]) {
    await assert.rejects(page({ fetchImpl: async () => response(events) }), errorCode("invalid-response"));
  }
  await assert.rejects(page({ fetchImpl: async () => response([], { link: link(requestUrl(), { hasMore: true }) }) }), errorCode("invalid-response"));
  await assert.rejects(page({ fetchImpl: async () => new Response("not json", { headers: { "content-type": "application/json", link: link() } }) }), errorCode("invalid-response"));
  await assert.rejects(page({ fetchImpl: async () => response([], { "content-type": "text/html" }) }), errorCode("invalid-response"));
});

test("Sentry enforces content-length, streamed byte and strict UTF-8 bounds", async () => {
  for (const declared of [String(MAX_SENTRY_BYTES + 1), "not-a-number"]) {
    await assert.rejects(page({ fetchImpl: async () => response([], { "content-length": declared }) }), errorCode("response-too-large"));
  }
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_SENTRY_BYTES)); controller.enqueue(new Uint8Array(1)); }, cancel() { cancelled = true; } });
  await assert.rejects(page({ fetchImpl: async () => new Response(stream, { headers: { "content-type": "application/json", link: link() } }) }), errorCode("response-too-large"));
  assert.equal(cancelled, true);
  await assert.rejects(page({ fetchImpl: async () => new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json", link: link() } }) }), errorCode("invalid-response"));
});

test("remote HTTP errors have bounded safe metadata and preserve Retry-After without automatic retries", async () => {
  for (const [status, retryable] of [[400, false], [401, false], [403, false], [404, false], [429, true], [500, true], [502, true], [503, true], [504, true], [302, false]]) {
    let calls = 0;
    await assert.rejects(page({ fetchImpl: async () => { calls += 1; return new Response("sensitive remote body " + TOKEN, { status, headers: { "retry-after": "120" } }); } }),
      errorCode("remote-rejected", { status, retryable, retryAfterMs: 120_000 }));
    assert.equal(calls, 1);
  }
  const future = new Date(Date.now() + 60_000).toUTCString();
  await assert.rejects(page({ fetchImpl: async () => new Response("unavailable", { status: 429, headers: { "retry-after": future } }) }), error => {
    assert.equal(error.retryable, true); assert.ok(error.retryAfterMs >= 58_000 && error.retryAfterMs <= 60_000); return true;
  });
  await assert.rejects(page({ fetchImpl: async () => new Response("unavailable", { status: 429, headers: { "retry-after": "999999999999999999999999" } }) }),
    errorCode("remote-rejected", { retryAfterMs: Number.MAX_SAFE_INTEGER }));
});

test("network exceptions do not reveal thrown credentials or response text", async () => {
  await assert.rejects(page({ fetchImpl: async () => { throw new Error(TOKEN + " " + WEBHOOK); } }), errorCode("network-unavailable", { retryable: true }));
});

test("caller cancellation interrupts pending requests and body reads", async () => {
  const controller = new AbortController(); let requested;
  const pending = page({ signal: controller.signal, fetchImpl: async (url, init) => { requested = init.signal; return new Promise(() => {}); } });
  controller.abort(new Error(TOKEN));
  await assert.rejects(pending, errorCode("request-interrupted", { retryable: true })); assert.equal(requested.aborted, true);
  const preAborted = new AbortController(); preAborted.abort(); let calls = 0;
  await assert.rejects(page({ signal: preAborted.signal, fetchImpl: async () => { calls += 1; return response(); } }), errorCode("request-interrupted"));
  assert.equal(calls, 0);
  const bodyController = new AbortController(); let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  const reading = page({ signal: bodyController.signal, fetchImpl: async () => new Response(stream, { headers: { "content-type": "application/json", link: link() } }) });
  await new Promise(resolve => setImmediate(resolve)); bodyController.abort();
  await assert.rejects(reading, errorCode("request-interrupted")); assert.equal(cancelled, true);
});

test("the entire request has a fixed ten-second deadline even when an injected fetch ignores abort", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = page({ fetchImpl: async () => new Promise(() => {}) });
  context.mock.timers.tick(TIMEOUT_MS);
  await assert.rejects(pending, errorCode("request-interrupted", { retryable: true }));
});

test("Slack sends bounded plain-text content without link unfurling, mentions or parsed fallback markup", async () => {
  const text = "Application error count: 2. <!channel> <@USYNTHETIC> & evidence.\nCheck the private SOC.";
  let calls = 0;
  await sendSlack({ webhook: WEBHOOK, text, fetchImpl: async (url, init) => {
    calls += 1; assert.equal(url, WEBHOOK); assert.equal(init.method, "POST"); assert.equal(init.redirect, "error");
    assert.equal(init.headers.Authorization, undefined); assert.equal(init.headers["Content-Type"], "application/json");
    const body = JSON.parse(init.body);
    assert.equal(body.mrkdwn, false); assert.equal(body.link_names, false); assert.equal(body.parse, "none");
    assert.equal(body.unfurl_links, false); assert.equal(body.unfurl_media, false);
    assert.ok(!body.text.includes("<!channel>")); assert.ok(!body.text.includes("<@"));
    assert.deepEqual(body.blocks, [{ type: "section", text: { type: "plain_text", text, emoji: false } }]);
    assert.equal(body.channel, undefined); return new Response("ok\n");
  } });
  assert.equal(calls, 1);
});

test("Slack validates before sending and only accepts a bounded successful acknowledgement", async () => {
  let calls = 0; const fetchImpl = async () => { calls += 1; return new Response("ok"); };
  for (const text of ["", "   ", "x".repeat(2001), "control\u0000character"]) {
    await assert.rejects(sendSlack({ webhook: WEBHOOK, text, fetchImpl }), errorCode("invalid-notification"));
  }
  await assert.rejects(sendSlack({ webhook: "http://127.0.0.1", text: "test", fetchImpl }), errorCode("invalid-webhook"));
  assert.equal(calls, 0);
  for (const text of ["not_ok", "ok with details", '{"ok":true}']) {
    await assert.rejects(sendSlack({ webhook: WEBHOOK, text: "test", fetchImpl: async () => new Response(text) }), errorCode("invalid-acknowledgement"));
  }
  await assert.rejects(sendSlack({ webhook: WEBHOOK, text: "test", fetchImpl: async () => new Response("x".repeat(1025)) }), errorCode("response-too-large"));
  await assert.rejects(sendSlack({ webhook: WEBHOOK, text: "test", fetchImpl: async () => new Response(TOKEN, { status: 429, headers: { "retry-after": "5" } }) }),
    errorCode("remote-rejected", { status: 429, retryable: true, retryAfterMs: 5000 }));
});
