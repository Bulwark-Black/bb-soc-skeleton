# Portable detection rules

The private application includes 25 original MIT-licensed review rules. They
cover selected Windows Security/AD audit changes and authentication bursts,
AWS CloudTrail logging changes and sign-in failures, Entra and Okta failures,
Microsoft 365 audit disabling requests, and host-level SSH password failures.
The catalog is deliberately bounded. It is not universal coverage, a Sigma
runtime, or a third-party rule subscription.

## Enable a reviewed application policy

Register the application and commission its sources first. In the private state
directory, create an owner-only regular file named **detection-config.json**:

    {
      "schemaVersion": 1,
      "applications": [{
        "appId": "replace-with-registered-application",
        "rules": [
          {"id": "windows.audit-log-cleared"},
          {"id": "windows.failed-logon-burst", "threshold": 5, "windowSeconds": 300}
        ]
      }]
    }

Replace the application ID with the actual registered ID; this example contains
no deployment configuration. Restart the private application after reviewing the
file. An absent file enables no rules. Invalid, duplicate or unknown rules and
unregistered applications fail startup rather than silently falling back.
Threshold overrides accept 2–1,000 events and 60–3,600 seconds. Event rules do
not accept threshold settings. The Rules page shows prerequisites and the selected
application's policy. Authenticated operators can inspect the same catalog at
GET /api/v1/detection/rules?appId=... .

## Evidence and execution

Only newly admitted canonical records are evaluated. Native monitoring has its
own state machines; this engine handles canonical log, audit and authentication
records. Windows rules bind provider, channel, event ID and supported version.
A service installation or group membership change is a review signal, not proof
of persistence or privileged access. API logging changes are requests whose
outcome requires investigation. Missing grouping identities are skipped; they
are never merged into a shared unknown user.

A match adds a canonical finding to Triage with rule ID/version, MIT license,
policy revision, original evidence record ID, bounded evidence digest/count and
evaluation mode. Original input remains in Logs or its existing projection.
Inputs, derived findings, match identities and the delivery receipt commit in
one SQLite transaction. A rejected batch cannot leave a detection behind.
Sender receipts count original inputs, preserving the existing delivery contract.
Exact event replays and receipt retries do not generate another finding.

Thresholds use fixed UTC event-time buckets per application, source, rule,
policy and grouping key. Five failures crossing a bucket boundary may not match;
this is not a sliding-window engine. Out-of-order arrivals within the retained
24-hour correlation horizon can complete a bucket. Older imports remain
searchable but do not participate in threshold evaluation. Single-event rules
can evaluate older newly admitted events within the receiver replay policy.
Changing policy does not reevaluate already retained records.

Evaluation is bounded at 4,000 derived findings per input batch, 250,000 retained
correlation observations and 250,000 match identities. Correlation observations
expire after 24 hours. Match identities are durable and not automatically
pruned; reaching capacity refuses admission atomically. Monitor capacity and
plan an archive/migration before exhaustion. Splitting a batch helps only the
per-batch bound; it does not fix a full ledger. This release does not include
a match-ledger archive command. Active derived findings can enter their own
durable email queue when finding notifications are explicitly configured.
Native monitoring incidents use a separate notification lifecycle; importing an
arbitrary finding does not automatically send either kind of email.

## Grow coverage without importing assumptions

The checked-in catalog is in server/detection-rules.js; additions require
a documented normalized field contract, original/publicly licensed rule logic,
positive and negative fixtures, and a representative commissioning event.
No arbitrary expressions, scripts, regex rules or downloadable code execute.
Third-party Sigma/Wazuh/Elastic content requires source-specific license review,
translation into the supported bounded JSON format, field mapping, fixtures,
and an update policy before using the shipped reviewed-pack pipeline. Their
native formats do not execute directly. Copying signatures without their
required fields and data sources would misrepresent coverage.

Read [Windows events](WINDOWS-EVENTS.md) and [platform coverage](PLATFORM-COVERAGE.md)
for source prerequisites and deployment phases. Enable a small reviewed set,
verify expected matches and authorized-change false positives, then expand.

## Reviewed packs and staged rollout

See [reviewed rule packs](REVIEWED-RULE-PACKS.md) for the executable pack installer,
license and fixture checks, shadow/active source scope, expiring suppressions,
version rollback and catalog attribution. Active derived findings may enter the
separate durable email queue when [notifications](NATIVE-NOTIFICATIONS.md) are
configured; shadow and suppressed decisions do not produce notices.
