# Private protocol receivers

The foreground gateway accepts a bounded OTLP JSON logs profile over HTTP(S),
or RFC 5424/CEF messages over mutually authenticated syslog TLS. It writes the
existing durable integration outbox before acknowledging an OTLP request.
It is a separate collector process, not another public listener on the SOC app.

Install and activate the matching vendor source first. Store its credential in
an external owner-only token file. Use a second independently generated bearer
token for OTLP senders. Create an owner-only gateway configuration outside the
checkout with the following structure:

    {
      "schemaVersion": 1,
      "baseUrl": "https://soc.example.invalid",
      "sourceId": "YOUR_SOURCE_ID",
      "appId": "YOUR_APP_ID",
      "tokenFile": "/absolute/private/source-token",
      "authTokenFile": "/absolute/private/gateway-token",
      "adapterId": "otlp-logs",
      "outboxDirectory": "/absolute/private/outbox",
      "stateDirectory": "/absolute/private/gateway-state",
      "listener": {
        "protocol": "otlp-http",
        "host": "127.0.0.1",
        "port": 4318
      }
    }

Run npm run receive:platform -- --config /absolute/private/gateway.json.
The state and outbox directories must be separate and outside the checkout.
The receiver pins the source, application, destination, adapter and listener.
Changing those bindings requires a reviewed new state/queue location; do not
point an old queued source at a different tenant.

Loopback HTTP is supported for a colocated exporter. A non-loopback private bind
requires listener.tls with keyFile and certFile. Public/wildcard binds are refused.
Use a certificate with a name the exporter verifies; no insecure TLS option
exists. The deployment generator can package this worker with persistent state.

## OTLP HTTP logs profile

Send POST /v1/logs with Content-Type: application/json and Authorization: Bearer
followed by the gateway token. Content-Encoding: gzip is supported. Both
compressed and expanded bodies are bounded at 8 MiB. The canonical result is
limited to 1 MiB and 1,000 records, with at most two active uploads. Empty exports
return an empty successful response without fabricating collection health.

The accepted JSON fields and tighter per-field limits are documented in
[platform coverage](PLATFORM-COVERAGE.md). This is a constrained logs receiver:
no protobuf, gRPC, metrics or traces. Unsupported fields, malformed members,
missing original event time and oversized canonical output reject the entire
export. Configure the upstream exporter to emit this profile and retain its
original logs separately when full fidelity is required.

HTTP 200 and an empty JSON response mean durable local queue admission.
They do not prove downstream SOC admission or inbox delivery. Queue/storage
failures return 503; oversized bodies return 413. The error body uses OTLP's
numeric status codes. Exporter retries preserve stable canonical event identity.
The frozen outbox receipt timestamp is independent of original observedAt,
allowing historical events to be delivered without falsifying their event time.

## Syslog over TLS

Use adapterId syslog-rfc5424 or cef and listener.protocol syslog-tls. Remove
authTokenFile. Supply listener.tls.keyFile, certFile and caFile, plus
listener.clientFingerprints containing approved lowercase SHA-256 certificate
fingerprints without colons. Certificates and private keys are owner-only files.
Both trusted client certificate authentication and fingerprint approval are
required; a shared CA alone does not authorize an arbitrary device.

The receiver implements RFC 5425 octet counting: decimal byte length, a space,
then that many UTF-8 message bytes. Frames may span TCP chunks or arrive together.
A frame is bounded at 65,536 bytes. Raw RFC 3164, newline framing and UDP are
unsupported. Device-specific CEF bodies still need the documented timestamp and
field profile. A generic CEF parser does not establish vendor-specific detection
coverage.

Syslog has no application-level durable acknowledgment. A TCP acknowledgment is
not proof that a message reached the queue. A rejected frame or a full queue
closes the connection; configure persistent sender buffering and explicitly test
its behavior on reconnect. Syslog cannot provide an exactly-once or lossless
delivery guarantee.

## Operations and acceptance

The gateway drains up to ten deliveries every five seconds. The durable outbox
retains retry/blocking states and its existing seven-day retry horizon and
capacity limits. Inspect it with the vendor outbox commands before retrying or
replacing state. health.json reports queue totals, last enqueue/delivery time,
and counters for this process lifetime. Restart resets those counters; it does
not erase the queue. Received messages alone never establish stream completeness.

Tests exercise actual loopback HTTP and TLS listeners, client certificates,
split UTF-8 framing, bounded gzip decompression, malformed requests, full-queue
refusal and restart/replay behavior. Commissioning on an adopter network must
also test upstream exporter compatibility, permission changes, full disk, expiry
of certificates/tokens, backpressure and recovery.

References: [OTLP](https://opentelemetry.io/docs/specs/otlp/),
[syslog TLS](https://www.rfc-editor.org/rfc/rfc5425).
