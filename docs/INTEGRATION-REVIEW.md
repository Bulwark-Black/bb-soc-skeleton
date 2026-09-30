# Integration review and implementation map

This review describes the runnable private application, not the static preview
or a promise that the private production SOC has been completely reproduced.
It distinguishes a connector definition, a working transport, accepted data,
an observation view, and an operational workflow. Those are different levels
of implementation. A populated table is not proof that a detector, scan,
notification, attestation, or remediation action ran.

The review is based on the checked-in manifest/runtime, canonical contracts,
indexed store, private HTTP application, page projectors, administration
commands, document library, MCP client, and sender tests. It is a product and
adoption review, not a formal security assessment, deployment certification, or
benchmark result. CI, repository workflows, branch protections and release
automation are outside its scope.

**Vendor-pack update:** ten checked-in vendor export/API-page normalizers,
Sources → Vendor imports, and an external durable SQLite outbox now ship.
Read the [vendor setup and delivery guide](VENDOR-INTEGRATIONS.md) for exact
supported formats, permissions, queue behavior and limitations.

**Live-monitoring update:** one complete built-in path now connects a Sentry
Cloud project, polls error events with durable checkpoints, distinguishes empty
successful collection from failure, records actionable local alerts/evidence,
and optionally delivers them to Slack. See [Live monitoring](LIVE-MONITORING.md)
for setup, fixed bounds, encrypted-secret custody, restore and real-account
commissioning. It is not a general collector runtime or a claim that every
vendor/import mapping now polls automatically.

## Outcome: what an adopter can connect today

The application now has an extensible **canonical push** path. An adopter can
register an application/environment, select a built-in canonical source or
install a bounded data-only integration definition, test a normalized record,
activate the source, and push their own observations. The sender toolkit
validates batches, loads a source-bound credential from a private file, and
retries transient failures without inventing new delivery identities.

All 29 supported canonical record kinds can be retained and inspected through
Sources → Observations and Timeline. Related SOC routes show bounded read-only
observation tables where implemented. Existing specialized log summaries and
validated Trivy report views remain distinct. Imported governance, identity,
backup, and remediation claims do not authorize actions or change local
decisions.

This does **not** mean arbitrary vendor JSON is accepted. Mapping upstream
payloads to the canonical schema, running collectors, polling APIs, keeping
cursors, resolving vendor secrets, scheduling work, and performing operational
actions still require an external integration or further implementation outside
the specifically shipped Sentry live-monitoring/Slack path.

## Integration capability matrix

| Area | Shipped behavior | Remaining work or boundary |
| --- | --- | --- |
| Private deployment | Better Auth sign-in, closed signup, external private state, loopback listener, explicit private origin | Supported service/container packaging, automated setup verification, backup/restore tooling and operational monitoring |
| Application scope | Register application and environment; collector host optional for canonical push/report import | Human app-level authorization, tenant isolation, account ownership transfers and richer application lifecycle |
| Integration definitions | Built-in manifests plus human-installed immutable application-scoped canonical-push definitions | No uploaded executable plugins, runtime code loading, arbitrary network targets or vendor credential resolver |
| Source setup | Manifest-owned fields, test/activation, once-only source credential, ten reviewed vendor presets, file preview/import, revisions and history | Arbitrary mapping wizard and automatic credential acquisition at a vendor |
| Live monitoring | Guided Sentry Cloud project access, encrypted private credentials, managed source, bounded polling, pagination, overlap/checkpoints, empty-window proof and failure/recovery alerts | Real-account commissioning, additional vendor readers, upstream environment filtering, service supervisor/watchdog and supported deployment/restore tooling |
| Canonical ingestion | Authenticated source-bound JSON batches, 29 supported kinds through the general canonical driver, schema validation, receipts and deduplication | Raw webhook signatures, provider-specific schemas, streaming OTLP/syslog receivers and unlimited custom kinds |
| Sender toolkit | Node client/CLI, private destinations, token-file custody, bounded retry, matching receipts; external SQLite outbox with persistent leases, backoff, replay and blocked recovery | No automatic batch splitting, input tailer, installed scheduler, vendor polling or exactly-once guarantee |
| Observations | Bounded indexed app/source/kind/time reads and read-only route projections | Rich domain projectors, stable cursor pagination, native workflow commands, broader detail views and full SIEM query language |
| Log views | Canonical log events feed Logs, Overview, Analytics, Sources and SOC Health | A rules engine, correlation, anomaly modeling or a detector-generated alert count |
| Scanner ingestion | Trivy vulnerability-report upload/API/CLI with typed normalization and specialized display | Executing Trivy, polling scanner APIs, coverage verification and eleven legacy scan-template drivers |
| Other scanner tabs | Matching canonical observations can be displayed with explicit limitations | Their presence does not implement patch prioritization, integrity baselines, EOL matching, scanning, antivirus or quarantine |
| Notifications | Imported `alert.delivery` remains an upstream claim; Live monitoring has its own durable Slack queue, bounded retry/cooldown, explicit tests, delivery status and local acknowledgment | General routing/escalation policy, email/ticketing senders, exactly-once delivery, recipient read acknowledgment and upstream issue resolution |
| Agent access | Scoped service identities, expiry, rotation/revocation, audit, stdio MCP reading docs and fixed management tools | Agent runner, scheduler, job leases/results, observed execution health and approval workflow |
| Human access | Authenticated full-access operators, optional TOTP/backup-code 2FA, account recovery and session revocation | Read-only/analyst/admin roles, app scoping, enforced MFA policy/passkeys, SSO and per-action step-up approvals |
| Documents | Private uploads, immutable versions/hashes, metadata, review dates, download, history, archive/restore | Malware scanning, OCR/search, evidence approvals, retention/purge/legal hold and larger object storage |
| Governance | Authored attestation/risk records and audited lifecycle commands | Programs/checklists, verified evidence links, approval separation, import/export and independently verified closure |
| Persistence | Indexed SQLite telemetry, atomic admission/audit/receipt/health commit, bounded retention; other private stores separately persisted | Administration storage modernization, distributed operation, online consistent backups and configurable retention migrations |
| Reliability verification | Functional contract, lifecycle, restart/recovery and HTTP sender tests; opt-in direct-runtime benchmark | Mixed HTTP/browser concurrency, long soak, disk exhaustion, deployment restore and actual power-loss testing |

The executable route map is
[`server/integration-coverage.js`](../server/integration-coverage.js).
Treat it as an allowlist of implemented reads, not permission for a connector
to install its own UI logic. Manifest target declarations do not create new
projectors or enable buttons.

## Connector definitions: what installation actually does

There are three practical choices:

1. **Canonical log push** is the narrow `log.event` path.
2. **Canonical events** accepts all 29 canonical kinds. Its source-kind choice
   describes the source; it does not restrict admission to that one kind. The
   manifest's `payload.recordKinds` is the actual kind allowlist.
3. **An installed custom canonical definition** gives an integration its own
   type, display text, declared kinds, configuration and targets while using
   the same bounded server-side canonical admission driver. Select the narrow
   set of record kinds that integration actually needs.

The Trivy report importer is a separate fourth path for supported raw scanner
reports, not an alternative way to send arbitrary canonical records.

The Sentry live-monitoring workflow is a fifth, managed path: it creates and
activates its own narrowly scoped source after vendor access validation. It
does not require a user-issued source bearer token or an invented sample, and
only a complete successful API window proves collection, including empty windows.

Custom installation is human-authorized, revision-checked and audited. Each
manifest is at most 64 KiB; the registry supports at most 86 custom definitions
alongside 14 built-ins, respecting the 100-entry contract bound. Connector
types are lowercase identifiers beginning with a letter, using letters,
digits, periods or hyphens, at most 80 characters. An installed type cannot
replace a built-in or an existing type. Use a new type for a changed contract.

Custom definitions must be application-scoped push integrations using canonical
schema version 1, with raw lines forbidden, content required, explicit record
kinds, no credential slots, and a required cadence from 60 through 31,536,000
seconds. Empty delivery cannot claim health. They install data, not JavaScript,
commands, URLs to execute, scanners, or secret material. Removal is allowed only
before any source or connector instance refers to the type; retained lifecycle
tombstones count as references. This preserves the interpretation of history.

For canonical-events and custom sources, **Test** requires a complete normalized
record with the new source's exact `sourceId` and application's `estateId`, a
permitted kind, and a valid observation timestamp. Testing validates the sample
without storing it. It does not prove network delivery. **Activate** issues the
source-ingest credential once; only a subsequently accepted batch establishes
delivery health. The disposable reference workbench does not enable these
custom drivers; use the private application.

## A complete first delivery

1. Start the private application with a persistent owner-only state directory
   outside the checkout. Provision an operator locally and sign in. Keep the
   listener private; for sharing use Tailnet HTTPS Serve, not public ingress.
2. Register the web application and its environment. Do not create a fake host
   merely to connect an app: canonical sources do not require a collector host.
3. Choose an installed integration, configure its cadence and allowed
   non-secret fields, and create a source. Record the returned application and
   source identifiers. Labels can change; integration joins should use IDs.
4. Map an approved upstream event to the
   [normalized-record schema](../contracts/normalized-record.v1.schema.json).
   Use the registered app ID as `estateId` and the exact source ID in each
   record. Remove credential/session material and unnecessary personal data
   before constructing the payload; field-name validation cannot recognize
   every secret hidden inside ordinary text.
5. Test the required normalized sample and activate the source. Transfer the
   once-only **source-ingest** credential directly to the approved secret
   facility, then materialize it as an owner-only external file for this
   sender. Do not paste it into agent prompts, command arguments, environment
   values, screenshots or committed files. An MCP service credential cannot be
   substituted for this source credential.
6. Persist a complete
   [ingest batch](../contracts/ingest-batch.v1.schema.json) outside the checkout.
   Choose stable record IDs and a unique receipt ID for this exact delivery.
   Preserve `observedAt` from the observation, and choose `sentAt` when the
   delivery is first prepared. Do not rewrite either timestamp on retries.
7. Send the file with the CLI below, or call the Node client from the collector.
   Keep the persisted batch until a matching accepted receipt is available.
8. Verify the source's accepted-delivery health and inspect its records under
   Sources → Observations. Filter by app, source and kind. Check the route
   coverage map before expecting a specialized screen to populate.
9. Retry the identical batch once as an acceptance test. Its receipt should
   report `replay: true` without increasing the retained record count. Then
   verify pause/revoke behavior using a disposable source before putting the
   integration into regular service.

## Sender CLI and Node API

From the repository root:

```sh
npm run send:events -- --file /absolute/private/batch.json --token-file /absolute/private/source-token --base-url http://127.0.0.1:8080
```

For another private destination, replace the origin explicitly. The shared
destination validator permits exact loopback HTTP, or HTTPS to loopback,
private IP ranges or private Tailnet DNS names. The shipped application's own
remote origin policy is narrower: its documented shared deployment is Tailnet
HTTPS. Sender URL acceptance alone does not configure TLS, access controls,
proxy rules, network reachability or the server's origin policy. Redirects are
never followed, and ordinary public HTTPS destinations are rejected.

`--file` and `--token-file` are mandatory; `--base-url` defaults to the local
private listener. `--attempts` defaults to 3 and accepts 1–5 total attempts.
`--timeout-ms` defaults to 10,000 and accepts 50–30,000 milliseconds per attempt,
covering the response body as well as initial headers. There are no raw-token
flags and no credential environment variable. `--help` prints only usage.

Both files require canonical absolute paths without symbolic-link ancestors.
The token file additionally must be outside the repository, owned by the
current user, inaccessible to group/other users, and not hard-linked. It
contains one issued unprefixed source credential and optionally one final
newline. The sender reopens it before each attempt so deliberate source-token
rotation can take effect without embedding the value in process arguments.
The batch file must be stable, nonempty UTF-8 JSON, at most 1 MiB. Keep real
event files outside the public repository even though the reader does not
require the batch itself to have token-file permissions.

The importable API adds no package dependencies:

```js
const { createIntegrationClient, readBatchFile } = require("./tools/integration-client");

const client = createIntegrationClient({
  baseUrl: "http://127.0.0.1:8080",
  tokenFile: "/absolute/private/source-token",
  attempts: 3,
  timeoutMs: 10000
});
const receipt = await client.sendBatch(readBatchFile("/absolute/private/batch.json"));
```

In CommonJS, put the awaited call inside your async function. A caller that
already owns a validated mapping can pass an in-memory batch to `sendBatch`;
it receives the same validation and byte cap. Persist that delivery before
the call if it must survive a collector crash. `prepareBatch(value)` returns
the frozen validated batch and encoded body for integration tests or a
caller-owned spool. The SDK's optional `backoffMs` defaults to 250 and permits
25–5,000 milliseconds before exponential growth. The SDK does not accept a
raw credential option, arbitrary request headers, endpoint paths or a custom
network client.

### Admission and retry contract

- The only request is `POST /api/v1/ingest`, with `application/json`, a scoped
  source bearer credential and no browser cookies. This is not an MCP call.
- A batch contains 1–1,000 records and no more than 1 MiB after validation and
  encoding. Both limits apply. The sender never silently drops records or
  splits an oversized batch. Split upstream into separately persisted
  deliveries with their own receipt IDs before sending.
- The client validates once and retains the same encoded body for every
  attempt, including record IDs, receipt ID and timestamps. Restarted CLI
  invocations reproduce that encoding from the same file; do not edit the
  saved file or regenerate delivery identities between invocations.
- Only network/timeout failures and HTTP 429, 502, 503 or 504 are retried.
  Validation, wrong credentials, wrong source, conflicts, size/capacity
  failures and redirects are not retried. A failed connection can occur after
  the server committed the batch: it is not proof of rejection.
- Backoff grows exponentially. A valid `Retry-After` seconds value or HTTP-date
  is honored when it fits within the 30-second maximum delay. A longer delay
  stops the call and returns numeric retry metadata instead of retrying early.
  An invalid header does not override the bounded default backoff.
- Responses are capped at 64 KiB. A successful response must match version 1,
  document type, source ID, receipt ID, accepted status, valid timestamp and
  boolean replay flag; accepted plus duplicate counts must equal the submitted
  record count. Unsupported or malformed receipts are errors, not success.
- CLI stdout contains only the validated receipt. Failures go to stderr and
  exit nonzero. Remote error text, HTTP bodies, credentials and local input
  content are not echoed. The SDK rejects with a `SenderError` carrying a safe
  code/message and, where relevant, numeric status/attempts/retry-delay fields.

Default server replay protection is seven days, not forever. An old `sentAt`
is refused after the replay window. A long-delayed spool needs an explicit
operator-approved reconciliation policy; blindly restamping it converts a
retry into a new delivery. Payload retention can remove old rows while receipt
and fingerprint protection continues inside its window. See the detailed
[storage chapter](../public/technical-reference.md#52-storage-limits-reliability-acceptance-and-remaining-parity-work).

## What each screen family gains—and what it still needs

| Screen family | Accepted source facts visible now | Native behavior still absent |
| --- | --- | --- |
| Monitor: Overview, Health, Analytics, Logs | Existing log projections and committed source delivery metadata | Detector evaluation, correlation and all-domain aggregate posture |
| Monitor: Timeline, Daily Brief | Timeline observes all supported kinds; Brief lists finding/case/remediation/evidence facts | Generated briefing, summarization, handover signoff and durable briefing editions |
| Respond: Triage, Tuning, Rules | Finding/case/vulnerability and rule observations on corresponding routes | Mutable local case queue, dispositions, rule compiler/evaluation, tuning approvals and retrospective replay |
| Respond: Alert Comms, Honeypots, Phishing | Upstream delivery, honeypot and phishing report observations | Message senders, honeypot deployment, mailbox ingestion, scoring and attachment inspection |
| Investigate: Activity, IOC, Threat Intel, Known IPs | Relevant activity and indicator/sync observations | Learned baseline, pasted-text extraction, polling feeds, enrichment, hunting and authoritative trusted-address registry |
| Scans: Trivy | Specialized validated report summaries, package inventory and reported findings | Scanner execution, complete scan coverage, automatic scheduling and verified fixes |
| Scans: Patch first, Dependencies, EOL | Matching package/vulnerability observations | Exploit/priority enrichment, advisory matching and lifecycle catalog joins |
| Scans: Integrity, External surface, IOC scan, URL scan | Matching file/asset/network/indicator/scan observations | Integrity baseline collector, authorized scan workers and provider-specific result normalization |
| Scans: Upload AV, Quarantine | Matching endpoint/finding observations with explicit limitations | Malware scan of Documents, file custody, actual quarantine and authorized deletion |
| Remediation | Upstream remediation/evidence observations | Fix execution, independent verification, approvals and automatic governed closure |
| Estate: Systems, Databases, Backups | Asset/endpoint, schema and backup/evidence observations | Authoritative inventory joins, baseline comparison, independent backup verification and restore execution |
| Estate: Retention | Actual local telemetry policy and counters | Per-source verified horizons, archive integrity, configurable policy migration and secure erasure |
| Govern: Access | Default / Who shows actual local operator permissions; Observations (`atab=observations`) shows imported identity/auth/audit/offboarding facts without granting or revoking permissions | Per-user entitlements, device inventory, certification and automated offboarding |
| Govern: Risks, Attestations, Documents | Local authored lifecycles and document versions remain separate from imported claims | Evidence approval relationships, policy/program/checklist semantics, legal acknowledgement and verified closure |
| Agents | Management metadata, prompts, enrollment and scoped service access | Actual executing workers, scheduling, observed runs/results and job health |

Generic projections intentionally show only observation time, app/environment,
source and its lifecycle, kind, reported title/state/severity. They do not
interpret arbitrary payload fields as HTML, links, authority or a verdict.
Sources → Observations provides the central bounded inspection path. Imported
records retain provenance and may remain visible after their source is archived
or removed; the lifecycle label explains that history.

Existing vendor, queue or workflow tabs do not by themselves filter canonical
facts into that vendor or queue. Generic observations are identified as such;
use explicit app/source/kind filters. In particular, an imported `scan.result`
does not become a trusted Trivy report, and a software package does not acquire
an EOL or exploitable verdict merely because the corresponding tab exists.
Only the dedicated validated Trivy source populates the specialized Trivy view.

## Remaining implementation work, ranked for adoption

### 1. Turn canonical integration into a genuinely easy connector experience

The extension path removes the hard-coded single-kind bottleneck. Ten tested
web-app-first vendor mappings and UI presets now handle supplied exports/API
pages, with fixture tests, field minimization, stable IDs and time semantics.
The first automatic vertical slice now adds Sentry read-only access, collection,
actionable event evidence, optional Slack delivery and explicit collection-health
proof. Next commission that full experience with authorized accounts and users
unfamiliar with the repository, before broadening the catalog. Review additional
event families and improve diagnostics without leaking sensitive content.
An export mapper still does not itself collect a live account's data.

For a pull connector, define an external secret reference/resolver, pinned
provider API version, cursor/checkpoint, pagination, quotas, least-privilege
access, retry/backoff and delete/revocation behavior. Do not accept a URL or
API-key form and imply those pieces already exist. Vendor secrets belong in a
server-side secret facility, never a public manifest or canonical payload.

### 2. Add collectors, scheduling and durable delivery deliberately

The standalone sender has bounded in-process retries. The new external SQLite
outbox adds persisted delivery, byte/entry/age bounds, leases, backoff and blocked
recovery. Sentry's built-in reader now owns its bounded windows/cursors, recovery
journal and in-process schedule. Other collectors still need that ownership;
all deployments still need a supported process supervisor, independent watchdog,
capacity monitoring and rehearsed backup/restore procedures. A stopped SOC
cannot deliver its own outage alert. The co-located encryption key/database
must be protected and restored together with the complete application state.
Webhook receivers additionally need vendor signature/replay verification and
acknowledgement ordering. OTLP and syslog need their own parsers and admission
policies; pointing them at the JSON endpoint will not work.

An agent runner similarly needs durable jobs, claims/leases, heartbeat,
deadlines, cancellation, retry policy and rejection of stale completions.
Bind each run to a reviewed prompt/capability revision, retain observed results
and distinguish registered, connected, queued, running, stale and failed states.
MCP remains management/documentation access, not a shell or telemetry tunnel.

### 3. Implement native operational workflows behind their own commands

Observation projections make data accessible but do not implement triage,
rule evaluation, general notification routing, remediation, quarantine, evidence
approval or local risk decisions. The explicit live-monitoring alert/Slack
lifecycle is a limited exception, not permission for imported facts to execute
arbitrary actions. For each additional workflow, specify the authoritative record,
allowed transitions, permission/approval policy, expected revision,
idempotency key, evidence requirements and audit before enabling UI actions.
The shipped Slack path has durable bounded delivery state; queued/configured
and delivered remain distinct. Broader destinations still need their own
durability/reconciliation; an imported success label is not independent proof.

### 4. Add team authorization and governed evidence

Before inviting analysts or auditors, implement server-enforced human roles
and application scope with negative permission tests. Current service scopes
are installation-wide, not per-app grants. Enforced MFA policy/passkeys, SSO and per-action step-up
approval require explicit policy and account recovery handling.

Document links currently associate metadata; they do not verify that a risk
exists, approve evidence, parse a Markdown register or attest a control.
Add version-pinned evidence references, validity/dependency checks, reviewer
separation, retention/legal hold and import/export reconciliation. Keep
imported governance claims distinct from locally authored decisions.

### 5. Make private operation reproducible and recoverable

Provide one supported deployment profile with service restart behavior,
owner-only external storage, exact origin/Tailnet configuration and
preflight checks. Add consistent backup/export, restore-to-a-copy verification,
upgrade/migration rollback, capacity warnings and actionable process-lock
recovery. Do not turn an unexplained lock refusal into automatic data deletion.

Telemetry is now indexed, but administration still has bounded JSON state and
audit. SQLite payload quotas are not disk-space quotas: indexes, WAL, receipts,
audits, identity and document stores also consume space. Retention runs on
successful mutations, not on an idle timer, and changing a stored retention
policy requires a deliberate migration. These constraints need operating
tooling before advertising unattended or high-volume deployments.

### 6. Validate the complete experience, not only the fastest code path

The sender suite exercises real local HTTP, credential custody, body stability
after a lost acknowledgement, transient/permanent response handling, bounded
Retry-After, timeouts, response limits and the actual CLI process. Canonical
runtime and projection tests cover their own admission/read boundaries.
These prove specific behavior; they do not establish a production SLO.

The existing benchmark calls the runtime directly. Next measure authenticated
HTTP ingest mixed with search, observation pagination, document operations,
source changes and browser navigation. Record hardware, dataset/cardinality,
concurrency, p50/p95/p99 latency, errors, event-loop delay, memory, DB/WAL growth
and retention work. Include long soaks, network interruption, acknowledgement
loss, capacity exhaustion, restart and restore drills. A killed-process test is
not actual power-loss validation. A fast 20,000-record run is not proof of
unlimited history, multi-process safety or a distributed SIEM.

## Adoption acceptance checklist

- [ ] A new operator can follow the README from an empty checkout to private
      sign-in without any production-specific value committed to the repo.
- [ ] An app/environment and source can be created without inventing a host.
- [ ] The installed definition truthfully identifies admitted kinds and
      implemented screens; unsupported drivers never claim ready status.
- [ ] Mapping tests reject missing required fields, wrong app/source IDs,
      unexpected kinds and secret-bearing field names before sending.
- [ ] A matching durable receipt, observed record and source delivery health
      are visible after a real authorized delivery.
- [ ] Replaying the saved batch does not duplicate data; conflicts, expiry and
      permanent failures stop clearly rather than being retried indefinitely.
- [ ] Pause, revocation, rotation, archive/remove and restart preserve the
      documented authorization/history behavior.
- [ ] Imported state is visibly distinguished from locally verified decisions
      and does not activate controls or grant access.
- [ ] Backup restore succeeds in a separate private location with compatible
      app version, ownership and file modes; no live database is copied alone.
- [ ] Realistic end-to-end load and failure tests meet declared, bounded
      deployment targets before capacity or readiness claims are expanded.
- [ ] Sentry live monitoring completes a real authorized window, reports empty
      success honestly, alerts on a harmless application error with resolvable
      evidence, detects collection failure, and recovers after credential repair.
- [ ] Optional Slack messages reach the intended channel with explicit delivery
      proof; operators understand at-least-once duplicates and local-only ACK.
- [ ] Monitoring state/key and complete SOC state survive a consistent isolated
      restore, and an independent watchdog detects complete SOC process outage.

No step above requires copying production records, prompts, topology, hosts,
credentials or vendor configuration into the public skeleton. Keep the
product's visual system and honest empty/unavailable states while extending
the service behavior.
