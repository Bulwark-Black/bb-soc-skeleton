# Vendor adapters and durable delivery

This is the executable first vendor pack: ten version-1 mappings for **supplied
exports and successful API response pages**, a human-authorized import UI, and
an external SQLite delivery outbox. It is not ten continuously connected vendor
accounts. No production data, accounts, API keys or demo feeds are included.

**Need automatic collection first?** The separate **Sources → Live monitoring**
workflow now runs one built-in Sentry Cloud project error collector with guided
read-only access, persisted checkpoints, collection-health alerts and optional
Slack delivery. Read [Live monitoring](LIVE-MONITORING.md). That does not turn
the other nine import mappings into background readers, or make this manual
file-import workflow acquire credentials.

## Why these ten

The selection covers cloud infrastructure, application identity, source control,
edge security and application observability: AWS CloudTrail, Microsoft Entra,
Google Cloud Audit Logs, Cloudflare, GitHub, GitLab, Okta, Auth0, Sentry and
Datadog. It is a practical coverage-based shortlist, not an independently
measured global top-ten ranking. The
[Stack Overflow technology survey](https://survey.stackoverflow.co/2025/technology)
and [Okta adoption report](https://www.okta.com/reports/businesses-at-work-archive/businesses-at-work-2025/)
inform the adoption context, not a promise of market rank or available licensing.

Additional vendors still use universal canonical events or custom definitions.
These presets consume normal custom-definition slots only when installed;
they do not replace the universal integration path or impose a vendor allowlist.
Trivy's existing validated report importer remains separate.

## What works now

| Layer | Implemented | Not implied |
| --- | --- | --- |
| Mapping | Ten pure checked-in normalizers, bounded JSON/NDJSON parsing, required IDs/time, allowlisted output | Arbitrary vendor payloads, executable uploaded plugins, all event families or API versions |
| UI | Preset installation, matching source selection, file preview, source sample validation, reviewed import, receipt and observation link | Credential provisioning at a vendor, automatic account discovery, polling or next-page retrieval |
| Transport | Private canonical source ingestion and authenticated same-origin human imports | Internet webhook listener or signature verification |
| Durability | External SQLite outbox, atomic enqueue, exact saved body replay, restart recovery, leases, bounded backoff, blocked-delivery inspection/retry | Hosted scheduler, vendor cursor ownership, exactly-once end-to-end delivery, automatic queue deletion |
| Observation | Source health after commit, typed read-only views, canonical record deduplication | Rule execution, security verdicts, local permissions or automated remediation |

The table describes this export/import/outbox pack. The separately documented
Sentry live reader owns its own scheduler, cursors, encrypted credential state
and notification lifecycle; it does not use the external outbox CLI.

## Human setup in the app

1. Start the private application using the README and sign in. Keep the listener
   on loopback behind an explicitly configured private HTTPS/tailnet origin.
   Do not expose the SOC to receive vendor webhooks on the public Internet.
2. Register the application/environment you want to monitor. No invented host
   is needed for these application-scoped sources.
3. Open **Sources → Vendor imports**. Expand a vendor and **Install preset**.
   Installation is a revision-checked, audited human operation. It installs a
   data-only `vendor.<adapter-id>` declaration, not a network client or secret.
4. Follow **Configure source**. Select your app/environment, label and expected
   cadence. The source kind belongs to that vendor preset. Begin source setup.
5. Return to Vendor imports, select that vendor and configured source, and
   choose your own redacted JSON/NDJSON file. **Preview mapping** shows up to ten
   normalized records and the total count without storing any observations.
   Preview output is the content that would be retained, not a raw-file viewer.
6. For a configured/tested source, choose **Validate source with preview sample**.
   The ordinary source-test command checks the displayed sample and binding;
   it does not import it. Activate in Add a source and save the one-time source
   credential in your collector's approved private secret facility/file.
7. Return, refresh setup, reselect the source/file and preview again. Only an
   active source enables **Import reviewed events**. Import recomputes the
   mapping and requires the exact preview hash. A changed file/source invalidates
   the preview; a paused/revoked source is refused server-side even if a button
   was previously enabled.
8. Confirm the committed receipt and inspect **Received observations**. Repeating
   the same normalized delivery replays its receipt rather than creating new
   records. Source lifecycle, retention, timestamp and schema limits still apply.

The browser sends the raw file to the private application for normalization.
The server does not retain that file or arbitrary discarded fields. This is
not permission to upload an unredacted secret: review sensitive exports before
selection, and ensure reverse proxies/collectors do not log request bodies.
No browser storage, vendor secret field or new service-token authority is added.

## Vendor-specific acquisition and mapping

Each importer reads one supplied export/page. Acquisition permissions, account
scope, complete pagination, sampling, vendor retention and plan restrictions
remain the collector/operator's responsibility. No normalizer follows a cursor,
next link, supplied URL, or remote reference. Requests to a vendor must happen
from your separately authorized collector, not from the public skeleton browser.

### 1. AWS CloudTrail — `aws-cloudtrail`

- Accepts CloudTrail `Records`, CLI/API LookupEvents `Events` containing JSON
  `CloudTrailEvent`, a single CloudTrail event, or an event array. Requires the
  real `eventID`, `eventTime`, `eventSource` and `eventName`.
- Emits `audit.event`; supported principal-bound console sign-ins can emit
  `authentication.event`. Identity/resource references are hashed. Request and
  response parameters, raw principal details, IPs and URLs are discarded.
- Use the existing AWS credential chain and a least-privilege role in your
  external collector. `LookupEvents` needs `cloudtrail:LookupEvents`; reading
  trail objects instead needs narrowly scoped object/decryption access.
- LookupEvents is regional, recent management/Insights history: at most 50
  results per page, a two-request/second account/region limit, and a 90-day
  history window. It does not substitute for collection of all trail data
  events. Follow `NextToken` externally and preserve original event times.
  [Event schema](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-event-reference-record-contents.html),
  [CLI retrieval](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/view-cloudtrail-events-cli.html),
  [LookupEvents limits](https://docs.aws.amazon.com/awscloudtrail/latest/APIReference/API_LookupEvents.html).

### 2. Microsoft Entra sign-ins — `entra-signin`

- Accepts Graph sign-in records, arrays, or the `value` response wrapper.
  Requires `id` and `createdDateTime`; reads provider user/app IDs and selected
  outcome enums, not user names, email, locations, addresses or arbitrary details.
- Emits `authentication.event`. Error code zero means Entra reported success;
  nonzero means a reported failure. Missing outcome remains unknown. Missing
  user IDs get an explicitly event-unresolved reference, not a fabricated user.
- Use Graph v1.0 `/auditLogs/signIns` with `AuditLog.Read.All`; delegated access
  also needs an appropriate supported reader role. Applicable Entra P1/P2
  licensing and retention govern availability. The API supports pages up to
  1,000 records. An external collector must follow `@odata.nextLink` safely.
  [Sign-in API and permissions](https://learn.microsoft.com/en-us/graph/api/signin-list?view=graph-rest-1.0),
  [Record fields](https://learn.microsoft.com/en-us/graph/api/resources/signin?view=graph-rest-1.0).

### 3. Google Cloud Audit Logs — `gcp-audit`

- Accepts `entries.list` responses, individual LogEntry records and arrays.
  Only typed `google.cloud.audit.AuditLog` protoPayloads are supported. Requires
  `insertId`, `logName`, timestamp, service and method identity.
- Emits `audit.event`. Log identity includes the log name, insert ID and full
  original time. Principal/resource references are hashed; request/response,
  authorization details and arbitrary metadata are not copied.
- External readers need `logging.logEntries.list`; Data Access additionally
  requires private-log access. Logs Viewer and Private Logs Viewer have
  different scope. Data Access often needs explicit enablement; absence of
  data does not prove absence of access. Use `logging.read` where appropriate,
  follow page tokens externally, and select the intended projects/log names.
  [List API](https://docs.cloud.google.com/logging/docs/reference/v2/rest/v2/entries/list),
  [Audit overview](https://docs.cloud.google.com/logging/docs/audit),
  [Data Access configuration](https://docs.cloud.google.com/logging/docs/audit/configure-data-access).

### 4. Cloudflare Firewall Events — `cloudflare-firewall`

- Accepts raw Logpush `firewall_events` records individually, in arrays or NDJSON.
  Select `RayID`, `Datetime`, `Action`, `Source`, `RuleID`, `MatchIndex`, and
  optionally `EdgeResponseStatus`. Not GraphQL sampled/aggregated results.
- Configure `timestamp_format` as `rfc3339ms` or `rfc3339ns`. Numeric Unix-nanosecond
  timestamps are refused because JavaScript JSON numbers can lose identity/time
  precision. Keep standard record output rather than a custom record template.
- Emits `network.event`; multiple matches for a request are distinguished using
  time/action/rule/source/match index. Raw IPs, URLs, headers and bodies are dropped.
- Deliver Logpush to adopter-owned storage and download from your collector.
  Managing jobs needs appropriate zone/account Logs:Write; reading the storage
  has its own permission. Prefer full sampling for the intended dataset, but
  importing a record never verifies upstream sampling or complete coverage.
  Keep the SOC private instead of choosing it as a public Logpush destination.
  [Dataset](https://developers.cloudflare.com/logs/logpush/logpush-job/datasets/zone/firewall_events/),
  [Output options](https://developers.cloudflare.com/logs/logpush/logpush-job/log-output-options/),
  [Job permissions](https://developers.cloudflare.com/logs/logpush/permissions/).

### 5. GitHub organization audit — `github-audit`

- Accepts organization audit events individually or in API/export arrays.
  Requires `_document_id`, `action` and an original millisecond timestamp
  (`@timestamp`, or the supported `created_at` fallback). Other GitHub webhook,
  Actions-log, Dependabot or code-scanning payloads are not this adapter.
- Emits `audit.event` with a generated title and controlled action metadata;
  actor/org/repository identities are pseudonymous references. Unknown actions
  do not become arbitrary retained free text or security findings.
- Organization audit API access requires applicable plan support and an
  authenticated organization owner. Classic/OAuth access uses `read:audit_log`;
  supported fine-grained access uses organization Administration read permission.
  Follow API pagination in your collector, with the intended event scope.
  [Official audit endpoint](https://docs.github.com/en/enterprise-cloud%40latest/rest/orgs/orgs#get-the-audit-log-for-an-organization).

### 6. GitLab audit — `gitlab-audit`

- Accepts individual events or arrays from supported instance/group/project
  audit endpoints. Requires `id`, `created_at`, and `entity_type`.
- Emits `audit.event`. Entity/actor identifiers are hashed; arbitrary details,
  author names, network addresses and free-form descriptions are not retained.
- Audit APIs require applicable Premium/Ultimate features. Instance-wide reads
  require Administrator; group Owners and project Maintainers have broader
  visibility than lower roles, which may see only their own actions. `read_api`
  is the read-only token scope, not a substitute for role and subscription checks.
  A successful page is not proof of full audit visibility.
  [Audit API](https://docs.gitlab.com/api/audit_events/),
  [Record schema](https://docs.gitlab.com/user/compliance/audit_event_schema/),
  [Token scopes](https://docs.gitlab.com/security/tokens/access_token_scopes/).

### 7. Okta System Log — `okta-system-log`

- Accepts System Log event arrays or individual exported records. Requires
  `uuid`, `published`, `eventType`; emits supported authentication types as
  `authentication.event`, other events as `audit.event`.
- `SUCCESS`/`FAILURE` are interpreted only in their supported provider context;
  policy allowance is not fabricated as a completed app sign-in. Unknown
  types/outcomes remain explicitly unknown. Actor references are hashed.
- Use scoped OAuth `okta.logs.read` in your collector. Pages default to 100;
  follow the server's Link relation and preserve polling/checkpoint semantics.
  Published time alone is not a safe lossless checkpoint: polling can be
  delivered out of published-time order. Okta's 90-day retention is separate
  from this starter's much shorter admission/replay and record-retention limits.
  [System Log query guidance](https://developer.okta.com/docs/reference/system-log-query/),
  [OAuth scopes](https://developer.okta.com/docs/api/oauth2/),
  [Event types](https://developer.okta.com/docs/reference/api/event-types/).

### 8. Auth0 tenant logs — `auth0-logs`

- Accepts Management API log arrays, the `logs`/include_totals wrapper, or an
  individual exported record. Requires `log_id`, `date` and `type`.
- Known login codes emit `authentication.event`; administrative/unknown codes
  emit `audit.event`. Unknown codes are represented by a hash, not copied
  arbitrary text. No details object, raw user email, IP, request or description
  crosses into canonical storage.
- The external Management API reader needs `read:logs`. Use checkpoint export
  with `from`/`take` and the next Link for ongoing collection. Requests return
  at most 100 logs; search-style retrieval has a 1,000-result ceiling and is
  unsuitable as an unlimited historical export. Retention is plan-dependent.
  [Retrieval and pagination](https://auth0.com/docs/deploy-monitor/logs/retrieve-log-events-using-mgmt-api),
  [Event code categories](https://auth0.com/docs/customize/log-streams/event-filters),
  [Log catalog](https://auth0.com/docs/tenant-logs).

### 9. Sentry error events — `sentry-events`

For automatic collection from Sentry Cloud, use [Live monitoring](LIVE-MONITORING.md)
instead of scheduling these file imports yourself. It uses the same minimized
mapping but provisions a separate managed source and owns pagination/checkpoints.
Its environment selection is local attribution, not an upstream filter.

- Accepts project/issue error-event arrays and supported individual event
  detail records. Requires the 32-hex `eventID`, `dateCreated`, and supported
  error-event type. Transactions, replay attachments and issue summaries are
  different contracts. Microsecond times normalize to milliseconds.
- Emits `log.event`, not a security finding. Titles/messages are generated;
  raw exception messages, stack traces, requests, headers and user objects are
  excluded. Provider level is separate from canonical security severity.
  Event-processing `errors` diagnostics may be present on a legitimate Sentry
  event; they are discarded, not mistaken for an HTTP error response.
- Project error/list/detail APIs use `project:read`; issue event listing uses
  `event:read`. Scope a collector to the intended organization/project and follow
  pagination externally. Filter to the supported error-event contract.
  [Project events](https://docs.sentry.io/api/events/list-a-projects-error-events/),
  [Event detail](https://docs.sentry.io/api/events/retrieve-an-event-for-a-project/),
  [Issue events](https://docs.sentry.io/api/events/list-an-issues-events/).

### 10. Datadog Logs v2 — `datadog-logs`

- Accepts Logs v2 `data` pages, arrays of log objects or individual log objects
  containing `type: log`, ID and `attributes.timestamp`. API errors, timed-out
  results and nonempty warnings are refused, not represented as complete success.
- Emits `log.event` with a generated summary, selected level and hashed service
  references. Raw log messages and arbitrary attributes are intentionally
  excluded; this default pack is not a full-fidelity searchable log archive.
- Your external reader needs `logs_read_data`; use the documented site-specific
  API credential/OAuth arrangement. API/application keys belong only in that
  collector's secret facility. Follow response pagination while keeping the
  same bounded query window, and inspect any partial-result warning.
  [Search API](https://docs.datadoghq.com/api/latest/logs/search-logs-post/),
  [Programmatic access guide](https://docs.datadoghq.com/logs/guide/access-your-log-data-programmatically/).

## Data identity, privacy and atomicity

The runner binds records to the operator-selected registered application and
source; raw vendor fields cannot select a different destination. Canonical
record IDs hash adapter version, adapter ID, source ID, application ID, kind,
and stable upstream event identity. Original vendor timestamps are required;
missing or invalid time is never replaced with now. Fractional precision beyond
milliseconds is normalized where documented; vendor-specific identity may retain
the full original timestamp to avoid collisions.

Canonical records are sorted before the receipt is hashed, so supported changes
to input record order do not create a new delivery. Reusing an upstream identity
with conflicting retained content is refused, not silently overwritten. Some
provider mappers reject duplicate IDs within an input; otherwise identical
records can be collapsed, but conflicting duplicates always reject the input.

Limits are 8 MiB raw input, 1–1,000 events and 1 MiB normalized atomic delivery.
One malformed record rejects the entire input. No automatic splitting or
truncation pretends the entire file was accepted. Split exports into deliberately
bounded pages/files before importing. Empty pages are not synthesized into
healthy heartbeats. Vendor subscription, inaccessible events, filtering and
sampling are not inferred from what a supplied file contains.

`sentAt` is the latest original event timestamp, ensuring repeated import of the
same file has the same body. The server's default seven-day admission/replay
window therefore refuses a file whose latest event is older; the UI does not
silently re-date historical evidence. Historical bulk migration needs a separate
reviewed procedure. Normal telemetry record retention remains independently
configured (30 days by default).

Output retains only allowlisted fields, generated summaries and bounded enums.
Hash references are pseudonymous, not guaranteed anonymous; dictionary matching
and cross-record correlation may remain possible. Raw log message suppression
is intentional. A future full-text mode needs explicit redaction, authorization,
retention and fixtures before enabling it. No supplied record proves upstream
authenticity: these are operator/collector-supplied observations, not signed
evidence or independently verified SOC decisions.

## Collector CLI and Node interface

List the installed mapper contracts without contacting a vendor:

```sh
npm run --silent vendor -- list
```

Normalize a private export into a canonical batch on stdout. Substitute actual
IDs shown by your source; the example does not supply a fixture or account:

```sh
npm run --silent vendor -- normalize --adapter github-audit --file /absolute/private/audit-page.json --source-id YOUR_SOURCE_ID --app-id YOUR_APP_ID
```

For delivery, enqueue first into a dedicated owner-only directory outside the
checkout **and separate from the SOC state and source-token files**:

```sh
npm run --silent vendor -- enqueue --adapter github-audit --file /absolute/private/audit-page.json --source-id YOUR_SOURCE_ID --app-id YOUR_APP_ID --outbox-dir /absolute/private/soc-outbox --base-url http://127.0.0.1:8080
npm run --silent vendor -- status --outbox-dir /absolute/private/soc-outbox
npm run --silent vendor -- drain --outbox-dir /absolute/private/soc-outbox --source-id YOUR_SOURCE_ID --token-file /absolute/private/source-ingest-key --base-url http://127.0.0.1:8080 --limit 10
```

Use your explicitly approved private HTTPS origin instead of loopback when the
collector is elsewhere on the tailnet. Destinations are pinned in each queued
entry; draining another origin or source does not reroute existing entries.
The token file holds the issued **source-ingest credential**, not the vendor
credential, a browser session or an agent service token. It is read again per
attempt, allowing controlled rotation without saving secrets in the queue.

The Node API uses the same code:

```js
const { parseVendorText, normalizeVendorPayload } = require('./tools/vendor-adapters');
const { openOutbox } = require('./tools/integration-outbox');
// collectorText comes from your already-authorized, bounded vendor reader.
const mapped = normalizeVendorPayload('github-audit', parseVendorText(collectorText), {
  sourceId: registeredSourceId, estateId: registeredApplicationId
});
const outbox = openOutbox(dedicatedPrivateOutboxDirectory);
try {
  const saved = outbox.enqueue(mapped.batch, configuredPrivateOrigin);
  // Persist the upstream cursor only after enqueue succeeds. A crash before
  // cursor persistence can replay the page; stable IDs prevent duplicate facts.
  console.log(saved.id);
} finally {
  outbox.close();
}
```

The mapping version and canonical serialization are part of replay identity.
Deploy a new adapter version deliberately; do not rewrite pending outbox bodies
after an upgrade. A provider API change should fail visibly until its contract
and fixtures are reviewed. This repository does not execute user-supplied code.

## Queue operation and recovery

Enqueue and queue transitions are SQLite transactions with WAL and FULL
synchronization. The queue admits at most 10,000 identities and 64 MiB of pending
canonical bodies. It never silently evicts unsent records. Successful delivery
removes the logical body while retaining the identity/hash and receipt, so the
10,000-entry lifetime bound includes delivered entries. This is not a physical
disk quota or forensic erasure guarantee; database/WAL overhead also needs space.

Drain is a bounded single pass, default ten deliveries, maximum 100. Schedule
repeated runs with your own private process supervisor/scheduler; no daemon or
Codex automation is created by this code. Each HTTP attempt has a ten-second
timeout. Entries are claimed with a 60-second lease, allowing expired leases
to be reclaimed after process loss; claim fencing prevents stale workers from
overwriting another worker's result. Correlated receipt verification precedes
delivered state. A lost acknowledgement may cause a replay, not invented success.

Network failures, 429, 502, 503 and 504 are retryable with persisted due time,
bounded backoff and Retry-After. The cooldown gates all entries for the same
source and destination, including new entries and workers restarted during the
cooldown; explicit retry cannot shorten it. Other refusals, malformed receipts, exhausted
attempts and expired deliveries become **blocked**. Each automatic cycle has a
ten-attempt budget. No transient retry sleeps inside the drain pass; a later
scheduled invocation processes due entries. Repeated process loss counts toward
the attempt limit. A failure stops the pass instead of hammering later batches.

Inspect `status` (global counts plus a bounded metadata page). Use state/source
filters and follow `page.nextOffset` while `page.hasMore` to find older entries:

```sh
npm run --silent vendor -- status --outbox-dir /absolute/private/soc-outbox --state blocked --source-id YOUR_SOURCE_ID --offset 0 --limit 100
```

The offset is 0–10,000 and each page has 1–100 rows. Filters affect the page;
the totals still describe the entire queue. Entries include their pinned origin
so a queue used for multiple private deployments can be inspected accurately.
After fixing the
source credential/state/capacity issue, explicitly retry a blocked unexpired
entry, then drain:

```sh
npm run --silent vendor -- retry --outbox-dir /absolute/private/soc-outbox --id DELIVERY_ID
```

Retry resets that entry's attempt budget, not its body, receipt, source,
destination or original timestamps. Queue eligibility expires after seven days
from enqueue; this is **not automatic deletion** of blocked payloads. The server
can refuse earlier because its replay window is based on the saved `sentAt`.
Delivered entries cannot be retried via this command. Do not manually clear a
lease while another worker may be active; wait for expiry and use one supported
SQLite-capable local filesystem, not a shared/distributed queue volume.

On capacity exhaustion, finish or investigate outstanding work before archiving
the entire dedicated queue and starting a new one. There is no destructive purge
command or automatic rollover. Preserve old queue evidence according to your
policy. Back up through a consistent SQLite-aware procedure; copying only the
main live database can omit WAL commits. Test restore to a separate private
directory. Unknown schemas, linked/permissive files, corrupt bodies and identity
mismatches fail closed instead of overwriting state. Do not treat SQLite
transactions as proof of resilience against every filesystem or power failure.

CLI stdout contains canonical output, metadata or validated receipts; it never
prints vendor credentials or raw error bodies. Treat canonical output as private
telemetry nevertheless. Failed processed deliveries return a nonzero exit code;
zero processed deliveries can mean none are due or entries are blocked, so an
operator/supervisor must inspect status rather than infer that all work completed.

## HTTP and agent boundaries

- `GET /api/v1/integrations/vendors`: the ten definitions, supported formats and
  bounds. Human session required, no network acquisition.
- `POST /api/v1/integrations/vendors/preview`: `{adapterId, sourceId, text}`.
  Returns the first ten normalized records, a source-test sample, source revision,
  receipt identity and preview hash; stores no raw file or canonical records.
- `POST /api/v1/integrations/vendors/import`: the same fields plus `previewHash`.
  Revalidates source state/binding and exact content, then atomically commits one
  normal canonical batch and returns its receipt.
- These are same-origin human endpoints. A supplied machine Authorization header
  is refused even if a valid browser cookie is present. External collectors use
  source-bound canonical `/api/v1/ingest` through the sender/outbox instead.
- At most two private uploads are in progress across document/scanner/vendor
  endpoints. The HTTP wrapper is bounded separately from its 8 MiB raw text.
- MCP exposes this guide as `soc://documentation/vendor-integrations`; it does
  not upload files, ingest events, install presets, issue credentials, or execute
  a collector. Agents still need operator approval for the relevant authority.

## What remains next

1. Commission the built-in Sentry live path with a real authorized project and
   optional approved Slack channel, then add reviewed readers for other services.
   External readers still need the scope, pagination, checkpoint, overlap,
   rate-limit and secret policies above. The ten mappers' automated tests use
   supplied pages; they are **not** evidence of live-account commissioning.
2. Add a supported private scheduling/deployment profile, queue metrics and
   operator alerts; measure mixed HTTP ingest/browser/queue load and restore drills.
3. Expand reviewed event families (for example GitHub security alerts or Cloudflare
   additional datasets) with separate versions rather than accepting arbitrary JSON.
4. Build broader authoritative detection/case/routing/remediation workflows behind
   their own permission, approval, revision and audit contracts. Importing an
   event never silently turns those controls on. The new local live-monitoring
   alert/Slack lifecycle is a narrow explicit workflow, not a general rules engine.

The public skeleton remains data-free. Product assets, styling, CI and release
automation are unchanged by this vendor-pack work.
