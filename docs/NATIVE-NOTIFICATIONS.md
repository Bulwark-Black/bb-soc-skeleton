# Native incident and finding email

The private application can send mail through your SMTP submission server or
Resend. Sending is disabled by default. Native monitoring incidents and canonical
findings have separate durable queues and separate application pause controls.
The static preview sends nothing. Source tokens, collectors and employee agents
cannot choose mail recipients or operate either queue.

## Use the SMTP service behind Roundcube

Roundcube is a webmail client. BB SOC connects to the SMTP submission service
that Roundcube uses, not its browser URL. Obtain that service's DNS hostname,
submission port, TLS mode, dedicated mail account and permitted sender from your
mail administrator. Roundcube's [configuration guide](https://github.com/roundcube/roundcubemail/wiki/Configuration)
describes its SMTP connection settings; do not copy a Roundcube session or browser
password into an application URL.

Add this object to the selected application's entry in the owner-only
operations-config.json, after configuring its monitoring registry using
[NATIVE-OPERATIONS.md](NATIVE-OPERATIONS.md):

~~~json
"notifications": {
  "enabled": false,
  "reviewed": true,
  "provider": "smtp",
  "smtp": {
    "host": "mail.example.invalid",
    "port": 587,
    "security": "starttls"
  },
  "from": "monitor@example.invalid",
  "destinations": ["oncall@example.invalid"],
  "credentialFile": "/absolute/path/smtp-credentials.json",
  "hourlySendCap": 100
}
~~~

All domains here are synthetic. Replace them with your reviewed mail service and
recipients. For implicit TLS use port 465 and security "tls". STARTTLS is required
when selected; a server without STARTTLS is rejected. Both modes verify the
certificate and hostname, with TLS 1.2 or later. An IP host requires an explicit
DNS servername for certificate verification. The application accepts no
certificate-bypass, arbitrary Nodemailer option, proxy or shell-command setting.

The SMTP credential file is JSON with exactly two string properties: user and
password. Provision the real account through your secret-management process.
The file must be outside the checkout, canonical and absolute, owned by the
application operating-system user, mode 0600, regular, with no symbolic or hard
links, and at most 16 KiB. Keep parent directories owner-controlled, for example
mode 0700; parent paths must resolve without links. Do not put credentials in
command arguments, source credentials, browser forms or committed files.

SMTP uses the maintained [Nodemailer SMTP implementation](https://nodemailer.com/extras/smtp-connection).
Connections are bounded: ten seconds to connect, five for the greeting, ten for
socket inactivity and twenty for the full session. No production plaintext SMTP
mode exists. The test suite's exact-loopback plaintext option cannot be enabled
through application configuration.

## Configure canonical finding mail

Create owner-only finding-notifications.json in the private state directory.
The application IDs must already exist. This file is independent of native
monitoring configuration, so applications receiving only logs and findings
need no invented host, native incident or check.

~~~json
{
  "schemaVersion": 1,
  "applications": [{
    "appId": "app-example",
    "notifications": {
      "enabled": false,
      "reviewed": true,
      "provider": "smtp",
      "smtp": {
        "host": "mail.example.invalid",
        "port": 587,
        "security": "starttls"
      },
      "from": "monitor@example.invalid",
      "destinations": ["oncall@example.invalid"],
      "credentialFile": "/absolute/path/smtp-credentials.json",
      "hourlySendCap": 100
    },
    "severities": ["high", "critical"],
    "ruleIds": ["rule-example"],
    "sourceIds": ["source-example"]
  }]
}
~~~

Omitting severities defaults to high and critical. Omit ruleIds or sourceIds
to accept all eligible values; an explicit empty filter array matches none.
Only newly admitted production findings are considered. Shadow rule evaluation
records decisions without generating production findings or email. An active
policy restricted to selected sources, including an active canary rollout,
does generate production findings and can send mail when these notification
filters match. Suppressed detections do not become mail notices.

Queue admission shares the canonical telemetry transaction. Replaying a finding
does not create another notice for the same application, source, finding and
recipient. Mail preserves the finding reference, source, rule and supplied rule
author/license attribution. It does not claim that a rule match proves compromise.
Enabling a policy does not backfill older findings.

## Commission without an accidental send

Restart after changing external configuration; changes are not hot-reloaded.
In Operations → Incidents, the Finding email panel provides:

1. Verify SMTP connection: checks connection, verified TLS and authentication
   without sending DATA or an email. A successful check does not prove sender
   authorization or inbox delivery. Its result is retained and visible after reload.
   Reviewed SMTP settings can be verified while enabled remains false.
2. After reviewing recipients and policy, set enabled to true in the applicable
   external configuration and restart. This authorizes actual queue delivery,
   including eligible incoming findings. Native incident sending is enabled
   separately in operations-config.json.
3. Send a requested test email: explicitly enter one configured recipient and
   a reason. This queues real mail. It uses the finding queue and its pause
   state; a paused queue holds the test until resumed. Inspect the attempt and
   verify actual receipt in that mailbox independently.

The test-send facility requires the finding mail configuration, even when the
same SMTP account is used for native incidents. It cannot send to an arbitrary
address. No production connection verification or email was performed by the
synthetic regression tests.

Omitting a notification object/file or setting enabled false stops future
requests. Per-check notificationEnabled flags cannot enable sending; reviewed
server-owned configuration controls it. Both queues accept at most twenty
distinct destinations, and a request cap from one to 1,000 per hour. The cap
includes retries. Each queue has its own per-application cap; when both queues
share a provider account, plan their combined quota.

## Resend alternative

Use provider "resend" and omit smtp. Keep the same reviewed sender, destination
and enablement fields, and point credentialFile to an external owner-only file
containing only the API credential, optionally followed by a newline. Its limit
is 1,024 bytes. Resend sends only to the fixed HTTPS endpoint
https://api.resend.com/emails, refuses redirects, verifies TLS, limits responses
to 64 KiB and bounds each request to fifteen seconds.

Resend retries preserve the exact body and provider idempotency key. Network
errors, HTTP 408/429/5xx and the concurrent-idempotent-request conflict use bounded
backoff, including numeric Retry-After. Automatic replay stops at 23 hours after
the first request, within [Resend's documented 24-hour idempotency window](https://resend.com/changelog/idempotency-keys).
Malformed success, other client errors, configuration or credential changes and
expired attempts require reconciliation. A new key is never silently generated.

## SMTP evidence and uncertainty

Before SMTP I/O, the worker persists the frozen server settings, envelope,
Message-ID, exact MIME body and hashes, credential fingerprint, request identity
and lease. Credentials are read from the external file and are never persisted
in delivery records. Before the first message byte is handed to SMTP DATA,
a second durable transaction records that boundary. If that transaction fails,
no message bytes are sent.

A validated final 250 response for the one intended recipient means the relay
accepted the message. It does not establish inbox delivery, bounce status or a
read receipt. The recorded smtp-receipt identity is a local hash of the protocol
evidence, not a fabricated relay queue ID. Public evidence contains a response
digest and status, never raw SMTP responses or credentials.

SMTP offers no idempotency guarantee. A stable Message-ID supports investigation
but does not guarantee deduplication. A timeout, disconnect, malformed acceptance
or expired worker lease after the DATA boundary parks the attempt for operator
reconciliation. It is never automatically replayed. Known failures before DATA
and explicit 4xx rejections can retry with bounded backoff; permanent rejection
requires review. Safe retries preserve the exact MIME and Message-ID. They stop
after the same 23-hour operational retry limit; that limit does not imply an
SMTP deduplication window.

Workers hold durable sixty-second leases. Late workers cannot overwrite a newer
attempt owner. The native timer checks work every ten seconds and the finding
timer every five seconds. Neither timer overrides a pause, external disablement,
capacity failure or uncertain SMTP boundary.

## Pause and reconcile

Operations → Incidents shows the native Notification transport panel and the
independent Finding email panel. Pause and resume affect only their corresponding
queue in the selected application, including retries. Pending work remains
retained. An in-flight request can still complete. Resume cannot override disabled
external configuration.

For native mail, open an incident to inspect its recipient ledger and
reconciliation forms. Finding attempts are inspected directly in the finding
panel. A parked active attempt supports:

- Retry the exact request: allowed only while its transport, credential and retry
  limit remain valid. Unknown SMTP DATA acceptance blocks this action.
- Record verified acceptance: supply the relay/provider acceptance ID, RFC 3339
  timestamp and where it was verified. The timestamp must fall between the first
  provider boundary and now. An API or SMTP connection start is not acceptance.
- Requeue with duplicate risk: explicitly accept possible duplicate mail. The
  frozen content and destination remain, earlier attempts are retained, and a new
  attempt is created. SMTP-to-SMTP requeue preserves MIME and Message-ID without
  promising deduplication. Resend uses a new key.

Every decision needs a reason and stable idempotency key. Attempt or control
revisions prevent stale decisions. Operator identity comes from the authenticated
session. Repeating identical content under a key returns its original receipt;
changed content is rejected. A lost browser response retains the same request
identity for retry. No source-token notification administration endpoint exists.

~~~text
GET  /api/v1/operations/notifications?appId=REGISTERED_APP_ID
POST /api/v1/operations/notifications/pause?appId=REGISTERED_APP_ID
POST /api/v1/operations/notifications/reconcile?appId=REGISTERED_APP_ID

GET  /api/v1/finding-notifications?appId=REGISTERED_APP_ID
POST /api/v1/finding-notifications/pause?appId=REGISTERED_APP_ID
POST /api/v1/finding-notifications/reconcile?appId=REGISTERED_APP_ID
POST /api/v1/finding-notifications/verify?appId=REGISTERED_APP_ID
POST /api/v1/finding-notifications/test-send?appId=REGISTERED_APP_ID
~~~

Pause input is {paused,expectedRevision,reason,idempotencyKey}. Reconcile input
is {attemptId,expectedRevision,action,reason,idempotencyKey}, with action
retry-exact, confirm-accepted (also providerId and acceptedAt), or requeue-fresh
(also duplicateRiskAccepted:true). Verify input is {reason,idempotencyKey};
test-send also requires recipient. These are authenticated, same-origin browser
operations; do not include actor or credentials in their bodies.

Native incident recovery is independent of mail delivery. Recovery goes only
to recipients whose opening crossed the provider boundary (SMTP DATA, or the
Resend request). An unattempted opening is cancelled when the incident has
already resolved. Paused recovery is reconsidered after resume. Stale or missing
monitoring evidence does not resolve an incident. Pending state/reminder notices
can coalesce while their earlier evidence remains; distinct action and
verification failures remain separate notices.

## Capacity, backups and validation

Native mail lives in each application's private monitoring SQLite database.
Finding mail lives in the canonical telemetry database, separate from native
host and incident identities. Back up private state with a consistent SQLite
backup method, including required WAL contents. Exact messages can contain
sensitive evidence; protect backups accordingly.

Native attempts are limited to 10,000 per application, alongside monitoring disk
quota/free-space controls. Finding attempts are limited to 10,000 across the
canonical telemetry database. Delivered and superseded attempts still count.
Nothing is automatically deleted. Reaching the finding limit rejects and rolls
back a qualifying canonical batch instead of silently losing a notice. Preserve
and archive the database, then review a capacity migration; deleting receipts
can reintroduce duplicate delivery. UI views show the newest 100 attempts and
ten requests per attempt, without deleting older evidence.

Run synthetic tests without real provider credentials or network delivery:

~~~sh
node --test --test-concurrency=1 test/native-notifications.test.js test/native-smtp.test.js test/finding-notifications.test.js test/private-native-notifications.test.js test/operations-ui.test.js
~~~

Tests use temporary owner-only credentials, injected transports and an exact
loopback scripted SMTP relay. They cover transaction rollback, restart, unknown
DATA outcomes, exact replay, verified TLS requirements, lease expiry, scoped
operator decisions, pause/recovery, explicit commissioning and browser retry
identity. Slack transport and inbox-delivery tracking are not implemented.
