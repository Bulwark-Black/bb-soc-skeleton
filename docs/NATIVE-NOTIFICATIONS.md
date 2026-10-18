# Native incident notifications

The private application includes a durable Resend email transport for native
monitoring incidents. Delivery is disabled by default. The static preview never
sends notifications. Host collectors, employee agents and source credentials
cannot choose recipients, configure the sender, or operate the delivery queue.

This implements the deployed native path's recipient snapshots, request
identities, uncertain-attempt recovery and operator decisions without copying
private recipients, domains, credentials or policies. No external provider was
contacted while validating this port.

## Commission an application

First configure the application and monitoring source using
[NATIVE-OPERATIONS.md](NATIVE-OPERATIONS.md). Add the following object to that
application's entry in the owner-only `operations-config.json` in its private
state directory. The domains below are synthetic; replace them with your
reviewed and verified sender and recipients.

~~~json
"notifications": {
  "enabled": true,
  "reviewed": true,
  "from": "monitor@example.invalid",
  "destinations": ["oncall@example.invalid"],
  "credentialFile": "/absolute/path/resend.token",
  "hourlySendCap": 100
}
~~~

The configuration accepts at most 20 distinct email addresses and an hourly
request limit from 1 to 1,000. The limit includes openings, recoveries, reminders,
all severities, and retries. It does not claim a provider-side rate-limit
reservation; a provider rate-limit response is retained and retried.

Use a Resend API credential permitted to send from the verified sender domain.
Store only its value in `credentialFile`, optionally followed by a newline.
The file must be outside the checkout, canonical and absolute, owned by the
application's operating-system user, mode `0600`, regular, with no symbolic or
hard links, and at most 1,024 bytes. Parent paths must resolve without links.
Keep its containing directory owner-controlled, for example mode `0700`.
Do not put the token in JSON, a command argument, the browser, or source
credentials. Configuration itself remains owner-only (`0600`) in the private
state directory.

Restart the private application after reviewing configuration. The server
polls its durable notification work every ten seconds. It sends only to the
fixed HTTPS endpoint `https://api.resend.com/emails`, verifies TLS through
Node's standard HTTPS implementation, refuses redirects, limits a response to
64 KiB, and bounds each request to fifteen seconds. No configurable provider
URL or shell command is accepted. The incident link uses the configured private
application origin and includes the application and incident IDs.

The configuration authorizes real mail. Enable it only after reviewing
recipients, the sender, provider account, and the monitoring conditions that can
open incidents. Incident summaries are included in plain-text mail. No separate
test-send API exists: validate wiring with the synthetic tests, then verify a
deliberately controlled incident through your own commissioning process.

`"notifications": {"enabled": false}` or omitting this object disables future
requests. Changing configuration requires restart. Existing attempts and
operator decisions remain retained.

## Sending and evidence

Every recipient has its own delivery record. Before network I/O, the worker
commits the exact message JSON, its digest, sender and destination, credential
fingerprint, provider idempotency key, request sequence and start time. Provider
credentials are read from the external file and never stored in the queue.

A successful response needs a provider email identity. A timeout or dropped
response is an uncertain provider outcome: the provider may already have
accepted it. Automatic retries use the same body and key. A malformed success
response, non-retryable error, changed credential/sender/destination, or elapsed
retry window requires reconciliation. Response bodies and credentials are not
copied into public errors or status pages.

The worker uses a durable sixty-second lease to exclude simultaneous workers.
An expired lease from an interrupted request can be replayed with the same
identity. Network errors, HTTP 408/429/5xx and Resend's concurrent-idempotent
request conflict use bounded backoff, including numeric `Retry-After`.
Other conflicts and client errors require an operator decision.

Automatic replay stops after 23 hours from the first request, within
[Resend's documented 24-hour idempotency window](https://resend.com/changelog/idempotency-keys).
The public status reports each attempt's exact-retry deadline. A new key is
never silently generated to bypass that deadline. Provider acceptance is
distinct from inbox delivery; this transport does not claim delivery, bounce,
complaint or read tracking.

Accumulated unattempted state and reminder notices for a generation are coalesced
to its latest pending state, with earlier events retained as evidence. Distinct
action and verification failures remain separate notices.

Recovery goes only to recipients whose opening crossed the provider boundary.
An unattempted opening is cancelled when the condition has already resolved;
its recipient receives no invented recovery. Unknown, stale or missing
monitoring evidence does not resolve an incident. A recovery observed during a
notification pause is retained and reconsidered after resume.

## Pause and reconcile

In **Operations → Incidents**, inspect **Notification transport** for sending
state, recent attempts, errors and operator decisions. Open an incident to see
its per-recipient ledger and reconciliation forms.

Pause and resume apply to the selected application's entire notification
worker, including automatic retries. A request already in flight may complete
after pause. Pause does not cancel an uncertain provider obligation or erase
its evidence. Resuming cannot override disabled external configuration.

A parked active attempt supports three explicit decisions:

- **Retry the exact request:** retain its message, credential fingerprint and
  provider key. The server rejects this after the replay deadline or a
  credential change.
- **Record verified provider acceptance:** supply the provider email ID,
  acceptance timestamp in RFC 3339, and where that acceptance was verified.
  Acceptance must fall between the first attempted request and the current
  time. An API request start alone is not acceptance proof.
- **Create a fresh request:** explicitly accept possible duplicate mail.
  This preserves the exact message and recipient, creates a new provider key,
  and retains the earlier attempt as superseded. This is available for
  credential rotation after reviewing the unknown earlier outcome.

Reconciliation requires the attempt's current revision, a reason, and a stable
idempotency key. Operator identity comes from the authenticated session.
Repeating the same decision after a lost response returns its original receipt;
changing its content under the same key is rejected. Inspect the provider and
retained request evidence before making a fresh decision.

The authenticated browser API uses these application-scoped routes:

~~~text
GET  /api/v1/operations/notifications?appId=REGISTERED_APP_ID
POST /api/v1/operations/notifications/pause?appId=REGISTERED_APP_ID
POST /api/v1/operations/notifications/reconcile?appId=REGISTERED_APP_ID
~~~

Pause input is `{paused,expectedRevision,reason,idempotencyKey}`. Reconcile input
is `{attemptId,expectedRevision,action,reason,idempotencyKey}` with action
`retry-exact`, `confirm-accepted` (also `providerId` and `acceptedAt`), or
`requeue-fresh` (also `duplicateRiskAccepted:true`). There is no source-token
notification endpoint. Host filters restrict incident/attempt views and
reconciliation; pause requires the application-wide view.

## Capacity, backups and validation

Attempts, exact messages, request history, acceptance IDs and operator decisions
live in the application's private monitoring SQLite database and WAL. Back up
the private state using a consistent SQLite backup method. Protect it like
the log and incident evidence it contains. No automatic deletion is performed.

The retained provider-attempt limit is 10,000 per application, in addition to
the monitoring store's disk quota and free-space reserve. Reaching the attempt limit
stops creating new attempts; existing attempts can finish subject to storage
capacity. A storage limit stops new provider requests and leaves work retained. Archive and preserve the database,
then review a capacity change or migration; removing a receipt can cause
duplicate delivery. The UI/API list the latest 100 attempts and ten request
observations per attempt; narrow by incident to inspect older related evidence.
The limits on displayed history do not delete stored records.

Run the synthetic regression suites without real credentials or provider access:

~~~sh
node --test --test-concurrency=1 test/native-notifications.test.js test/private-native-notifications.test.js test/operations-ui.test.js
~~~

The tests inject a provider implementation and use temporary owner-only files.
They cover restart and exact replay, partial recipients, pause and recovery,
capacity, concurrent leases, credential changes, uncertain outcomes, operator
scope, authenticated HTTP controls, and replay-safe UI decisions. They do not
send email. Slack, SMTP, provider webhooks and inbox-delivery confirmation are
not implemented in this transport.
