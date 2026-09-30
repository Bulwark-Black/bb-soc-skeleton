# Live monitoring: connect, collect, understand, notify, verify

This guide covers the first complete built-in monitoring path: **Sentry Cloud
project error events → private SOC observations and actionable alerts → optional
Slack incoming-webhook notifications**. Open **Sources → Live monitoring** in
the signed-in private application. Technical Docs chapter 57 explains the same
workflow inside the app; agents can read this guide through the read-only
`soc://documentation/live-monitoring` MCP resource.

This is one narrow automatic collector, not ten automatic integrations. The
[vendor import pack](VENDOR-INTEGRATIONS.md) still provides ten mappings for
supplied exports/API pages. Other services use those import tools, an external
collector, or the [universal canonical path](INTEGRATION-REVIEW.md). Installing a
generic integration definition does not start network requests or grant it
access to vendor credentials.

The repository contains no connected account, telemetry, Sentry token, Slack
destination, or production settings. Automated tests use controlled responses
and disposable private state. They do not prove access to your actual Sentry
organization or Slack channel. Complete the commissioning checklist below with
your own authorized account before relying on this deployment.

## 1. Understand the scope before connecting

The collector reads the selected project's **error-event** API. It does not
install the Sentry SDK in your application, create a Sentry project, receive
public webhooks, execute scans, collect every Sentry product, resolve issues,
or change application code. Transactions, replay sessions, attachments and
general issue-management workflows are outside this path.

The selected SOC application/environment identifies where this source belongs
locally. **Environment is not an upstream filter.** This collector requests the
whole selected Sentry project's supported error feed. If production and staging
share that project, both may be associated with the selected SOC environment.
Use a dedicated Sentry project for each environment when that distinction is
required. Do not interpret the local label as evidence of upstream isolation.

Alerts describe newly observed error-event identities, not necessarily new
Sentry issues, unique bugs, confirmed compromises, regressions or outages. An
existing issue can produce another event and therefore another alert. Provider
error/fatal levels remain provider-reported application levels, not independent
security verdicts. Investigate the evidence in Sentry and your own deployment
history before taking action.

## 2. Prerequisites and private network posture

1. Start the private application using the [README](../README.md#run-locally).
   Use the supported Node version and pinned dependencies, an operator account,
   and a persistent owner-only state directory outside the repository.
2. Keep the listener on loopback. For other devices, use explicitly configured
   private Tailnet HTTPS and a restricted tailnet access policy. **Do not expose
   this SOC to the public Internet.** Do not open an inbound port just to make
   Sentry or Slack work: these integrations use outbound HTTPS requests.
3. Keep private application sign-in enabled even behind the tailnet. Network
   membership is not a substitute for an authenticated SOC session. Current
   human operators have full access to this single deployment; this feature
   does not add per-application roles or multi-tenant isolation. Optional account
   TOTP is configured separately in Account security; see AUTHENTICATION.md.
4. Your application must already send approved error events to a Sentry Cloud
   project. Configure and verify your framework's Sentry SDK in that application
   separately. Confirm an event appears in Sentry before diagnosing an empty SOC.
5. The SOC host needs working DNS and outbound TLS access to the chosen fixed
   Sentry Cloud origin. Optional Slack delivery needs outbound access to the
   standard Slack incoming-webhook service. Preserve TLS validation; do not
   disable it or add an arbitrary proxy URL to this collector.
6. Keep the host clock synchronized. Collection windows, replay protection,
   credential expiry, cooldowns and health age all depend on meaningful time.
7. Choose who will supervise the process, watch disk capacity and verify backups.
   `npm start` runs the service; closing its terminal can stop collection. This
   feature does not install an operating-system daemon or external watchdog.

The browser makes only same-origin SOC requests. It never calls Sentry or Slack
directly. The private server supplies the outbound vendor credentials. Browser
navigation is not required for collection: closing the Live monitoring tab does
not stop a running private server.

## 3. Obtain the least-privilege Sentry credential

The shipped reader calls the project error-event endpoint with a bearer token.
Use **`project:read`**, not write or administrative scope, with access to the
specific project you intend to monitor. Scope names do not override the token
owner's or integration's project permissions. Select the narrowest vendor
identity/project access available to you and verify it through the connection
test. A Sentry SDK DSN is **not** this API token. See the official
[project error-event API](https://docs.sentry.io/api/events/list-a-projects-error-events/)
and [Sentry API documentation](https://docs.sentry.io/api/).

Collect these non-secret setup values from your own account:

| SOC field | What to supply |
| --- | --- |
| Application | An application registered in SOC Onboarding |
| Environment | One of that application's declared environments; local attribution only |
| Display name | A useful operator-facing name, 1–100 characters; avoid sensitive incident details |
| Region | `default`, `us`, or `eu`, matching the project's Sentry Cloud region |
| Organization | Organization URL slug, not a full URL or display name |
| Project | Project URL slug, not a full URL or SDK DSN |
| Token | The authorized Sentry API credential, entered only in the private password field |

Region `default` uses `sentry.io`, `us` uses `us.sentry.io`, and `eu` uses
`de.sentry.io`. Only these fixed API origins are supported. A self-hosted Sentry
instance, a custom API hostname, arbitrary headers, custom query strings and
uploaded collector code are not accepted by this built-in path. Use an external
reviewed collector for another destination rather than bypassing this boundary.

Treat the token as a secret. Do not paste it into an agent prompt, chat message,
issue, screenshot, repository file, shell argument or environment variable.
Provision it through your normal vendor/secret-management process, then enter
it directly in the signed-in private UI. The server does not return it in status
responses. The UI does not write it into browser storage; a successful save or
leaving the view clears the secret inputs. A failed save can retain the current
input for correction until you discard the draft or leave the page.

## 4. Optional Slack notifications and their data boundary

Create a standard Slack app incoming webhook for the channel authorized to
receive monitoring notices, using Slack's
[incoming-webhook instructions](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/).
Use a destination approved by your organization. The channel associated with
the webhook is the destination; this UI does not select arbitrary channels or
override webhook permissions. GovSlack and Workflow Builder webhook protocols
are not supported by this implementation.

The webhook URL is a credential. Enter it in **Optional Slack incoming webhook
URL**, which is a password field. Only the standard `hooks.slack.com` incoming
webhook shape is accepted. Do not paste the URL into logs, documentation, an
agent conversation or a repository setting. Leave the field blank to keep
alerts inside the SOC without third-party notification delivery.

Enabling Slack authorizes the server to send generated alert titles and bodies,
the connection display name, event counts and reported levels, the SOC source
and alert identifiers, and, when applicable, one canonical evidence record ID
and Sentry event ID. These identifiers and labels can still be sensitive. Do
not use a display name containing secrets. Raw exception messages, stack traces,
request bodies, headers, user objects and original event payloads are not part
of the generated notification. The sender uses plain-text formatting, disables
unfurling and does not give labels user/channel-mention semantics.

Slack delivery is a separate state machine from collection. A healthy collector
can have failed notifications. A successful Slack test proves that one test
was acknowledged by Slack, not that Sentry collection is complete or the whole
application is healthy. Inspect both collection health and individual delivery
states. A received message does not establish that a person read or acted on it.

## 5. First connection: a guided operator walkthrough

1. Sign in to the private SOC. Open **Onboarding**, register your web application
   and declare its environments. Do not create a fictional collector host:
   this application-scoped collector does not need one.
2. Open **Sources → Live monitoring**. Read the setup and environment-scope
   notices. The static preview cannot perform this workflow and makes no
   network calls.
3. Choose the registered application and one of its environments. Enter a
   meaningful display name, Sentry region, organization slug and project slug.
4. Enter the read-only Sentry API token in its password field. Optionally enter
   the approved Slack incoming webhook. This action does not create or upgrade
   the vendor credential; you remain responsible for its permissions and expiry.
5. Select **Test access and start monitoring** once. The server reads and
   validates the first real page before accepting the connection. No fake error
   is generated and no invented successful-delivery record is inserted.
6. On success the service installs/reuses the reviewed Sentry integration
   definition, creates its own source, activates that source for its narrowly
   scoped internal collector, stores encrypted credentials and starts collection.
   You do not need to install the preset manually, test a sample separately,
   mint an external source token or schedule the vendor CLI for this path.
7. The connection can initially say **Starting**. That is honest: successful
   access testing is not yet proof that all pages in the first window have been
   accepted. Wait for **Last successful completed poll** and **Completed through**
   to advance. A complete empty window is valid collection proof.
8. Use **View this source's observations** to inspect accepted canonical
   records. They are `log.event` records bound to this managed source and the
   selected application. If Sentry has no eligible events in the window, this
   view can remain empty while collection is healthy.
9. If Slack is configured, select **Send Slack test**. Check the recorded test
   alert's delivery state and then independently check the intended channel.
   Tests are explicit outbound messages, not silent validation. At most one
   test per connection per minute is accepted.
10. With permission, generate one harmless, recognizable test error in your
    own instrumented application. Confirm it in Sentry, then in SOC observations
    and an application-error alert. Follow the evidence link or use the displayed
    Sentry event ID to locate the exact event. Do not intentionally cause a
    production outage to test the integration.
11. Acknowledge the SOC alert after review. Acknowledgment is local bookkeeping;
    it does not resolve a Sentry issue, suppress future events or change code.
12. Complete the restart/failure checks below before leaving the service
    unattended. Record the application/source IDs, connection coverage start
    and owner in your private operations notes, not in this repository.

The new connection does not silently convert an existing manually imported
source. Creating the same Sentry project for the same SOC application and
environment is refused while that connection exists. Attaching one project to
different application/environment bindings is possible but creates separate
collection and alert histories; it is not upstream event filtering.

## 6. Collection, checkpoints and expected latency

The first coverage window starts 15 minutes before connection setup and ends
30 seconds behind the server clock. Subsequent windows overlap the completed
checkpoint by five minutes, to pick up a bounded amount of delayed arrival,
and end 30 seconds behind the clock. A catch-up window advances its end by at
most one hour. The overlap can make the requested span slightly longer than
an hour; it does not move the completed checkpoint backward.

The collector normally polls every 60 seconds after finishing its current
window. An unfinished multi-page window or older backlog is scheduled again
after five seconds. It performs at most five pages per pass, with at most 100
events per page. These are safety bounds, not a sustained throughput guarantee.
Requests ask for the compact event representation and disable sampling. The
collector validates next-page metadata and rebuilds the next request from its
fixed origin and saved cursor; it does not follow arbitrary vendor-supplied URLs.
See Sentry's [pagination protocol](https://docs.sentry.io/api/pagination/).

In ordinary low-volume operation, expect the 60-second poll cadence plus the
30-second settling delay and whatever ingestion delay Sentry itself incurs.
The browser refreshes status every 30 seconds while no draft is open, which can
add display lag. A multi-page backlog, provider rate limit, network failure or
notification queue can take longer. These timings are not an alerting SLO.

For each page the private server:

1. Validates the event schema, original times, requested window and pagination.
2. Maps only the supported fields to canonical records and saves a recovery
   journal containing the exact normalized batch and bounded evidence metadata.
3. Admits that batch through the same source/application validation, deduplication,
   receipt and retention path used by other supported vendor imports.
4. Records newly seen event identities and corresponding application-error alerts.
5. Advances to the next saved cursor. It advances **Completed through** only
   after the final page succeeds. A partial page sequence is never a completed
   window merely because some records have arrived.

If the process stops after admission but before checkpoint completion, the saved
batch is replayed unchanged on recovery. Stable record/receipt identities and
the retained seen-event table prevent ordinary duplicate ingestion/alerts from
the overlap. This is not a claim of exactly-once delivery across every process,
filesystem, upstream mutation, retention change or external notification.

Late arrivals beyond the five-minute overlap can be missed. Upstream sampling,
SDK outages, plan restrictions, deleted data, retention expiry and events never
received by Sentry cannot be recovered by this collector. **Completed through
means the requested API window completed under this bounded contract, not that
every event the application ever generated is present.**

A gap beyond six days stops catch-up without skipping the checkpoint. Preserve
and investigate the historical gap. If you decide to reconnect, remove the old
connection deliberately and establish a new one with a new 15-minute coverage
start; that begins a new monitoring period and does not fill the missing history.
Pausing for more than six days can lead to the same limit. Never edit a checkpoint
or re-date events to make an incomplete history look current.

## 7. Read collection health correctly

| Field/state | Meaning and operator interpretation |
| --- | --- |
| Starting | No complete successful window has been proved yet; access testing alone is insufficient |
| Healthy | Recent complete collection is succeeding and the completed checkpoint is current within the bounded health policy |
| Degraded | A collection error, incomplete window or lagging checkpoint needs attention; accepted earlier records do not cancel that condition |
| Offline | The managed source is not active, or the last complete success has aged past the five-minute freshness threshold |
| Paused | An operator intentionally stopped collection; absence of new events is expected but not proof of application health |
| Last attempted poll | When the collector most recently attempted work; an attempt can fail |
| Last successful completed poll | When every page of a collection window was successfully committed |
| Coverage starts | The beginning of this connection's explicitly declared monitoring period |
| Completed through | End of the last fully committed upstream window; the strongest bounded completeness indicator |
| Incomplete window | More pagination/recovery work remains; the displayed completed checkpoint has not advanced |
| Next attempt | Saved scheduling/backoff time, not a promise of execution if the process is stopped |
| Last event activity | Original timestamp of the newest accepted event; an old value can coexist with healthy empty polls |
| Events accepted | Unique event identities observed by this connection, not a count of bugs, incidents or retained records after telemetry retention |
| Slack configured | A destination exists; this is not delivery proof. Read each alert's delivery state |

Failure is currently displayed before age-based offline classification, so a
connection can remain **Degraded** with a clearly shown old checkpoint rather
than changing its label to Offline. Always inspect timestamps and error detail,
not only the color or health word. All timestamps in this widget are explicit
UTC. If refreshing fails, the last displayed snapshot may be stale.

The Sources board and source history receive managed collection-health updates,
including successful empty polls; the old generic convention that only a
nonempty push proves health is not used for this supervised reader. Canonical
observations also feed existing supported log/overview/analytics/timeline views.
The authoritative local alert and delivery lifecycle is in **Live monitoring**,
not an implied new rules engine or a completed native triage workflow.

## 8. Alerts, evidence and actionable investigation

The collector records four narrow alert families:

- **Application errors:** one alert for the newly seen events on a committed
  page, with a count, the number reported as error/fatal, a generated next-step
  explanation and one sample event's evidence identifiers. It is not one alert
  per bug and does not replace Sentry's issue grouping.
- **Collection failed:** the first failure in a continuing failure episode,
  identifying a denied credential, rate limit or other safe failure summary.
  Repeated retries do not create a fresh failure alert every time.
- **Collection recovered:** a full window succeeded after a failure episode.
  Investigate any coverage gap; recovery does not erase it or guarantee delayed
  events beyond the overlap were recovered.
- **Notification test:** an explicit operator request to verify Slack delivery.
  It is labeled as a test and does not claim healthy collection.

For an application-error alert, inspect its connection/application, creation
time, canonical record ID, original observation time and Sentry event ID. When
the returned event includes a supported issue identifier, the link points to
that issue's event. Otherwise the link opens the organization's issue browser
and you can locate the displayed event ID yourself. Links are restricted to
fixed HTTPS Sentry hosts; there is no arbitrary payload-provided destination.
Opening evidence still requires your separate Sentry authorization.

The alert list is newest-first and paginated in pages of up to 100. **Older
alerts** and **Newer alerts** change pages; an explicit refresh returns to the
beginning. New alerts can shift offset-based pages, so the list is not an
immutable investigation snapshot. Copy needed identifiers to your own approved
case process rather than treating a page position as evidence identity.

Acknowledgment changes only the SOC alert's reviewed state. It does not cancel
pending delivery, mutate Sentry, resolve a case or approve a remediation.
Acknowledged terminal-delivery alerts become eligible for bounded retention
eviction at capacity; acknowledgment is therefore not archival storage.

## 9. Operating and changing a connection

| UI action | Actual effect |
| --- | --- |
| Poll now | Requests a bounded collector job; returns promptly. It respects the saved next-attempt time and provider cooldown, so clicking it need not make an immediate request |
| Pause collection | Stops future collection and fences/aborts in-flight work. Already queued Slack delivery can still proceed; this does not revoke the upstream token |
| Resume collection | Re-enables the existing connection/cursor. Saved cooldown and catch-up limits still apply |
| Save credential changes | Replaces supplied secrets without returning existing ones. Blank token/webhook preserves the old value unless Remove Slack is checked |
| Remove Slack notifications | Deletes the configured webhook from active encrypted connection state and cancels pending/blocked deliveries for that connection |
| Send Slack test | Creates an explicit test alert, then attempts delivery under normal scheduling/cooldown rules; one accepted request per minute |
| Retry blocked Slack notifications | Resets the bounded attempt budget for blocked notifications but does not shorten their stored due time or the connection's cooldown |
| Remove connection | Stops the collector, archives its managed source, removes active connection credentials and cancels pending/blocked deliveries. Existing telemetry and alerts are retained under their own rules |
| Refresh monitoring status | Reads authoritative status. If a draft exists, asks before discarding its inputs; it never silently replaces typed credentials |

Secrets entered in a rotation form are never prefilled from server state. A new
token is used by later collection; saving it is not a fresh successful-collection
proof. Confirm the next completed window. Rotate the vendor credential itself
through Sentry/Slack when required; deleting the SOC copy does not revoke a
credential at its vendor. Removal is not a forensic secure-erasure guarantee:
SQLite pages, WAL, operating-system memory and backups may retain prior bytes.

Application, environment, region, organization, project and display name are
fixed for this connection revision model. To change those bindings, deliberately
remove and recreate the connection after recording the historical boundary.
Do not directly edit the state database. Mutations use `expectedRevision`; a
stale operation returns conflict rather than overwriting newer changes.

Treat the source as managed. Archiving/revoking it in generic source controls
can stop admission and make the connection unhealthy; the collector does not
silently revive independently disabled sources. Repair lifecycle deliberately
or recreate the connection. Do not issue an external ingest credential for this
internally managed source or reuse another application's source identity.

## 10. Notification delivery and retry semantics

Each alert is stored before notification delivery. Its `deliveryState` is:

- `in-app`: no Slack destination was configured when the alert was created;
- `pending`: waiting for a due delivery attempt or transient retry;
- `delivered`: Slack returned the expected successful acknowledgment;
- `blocked`: nonretryable response, exhausted attempts or unsupported cooldown;
- `cancelled`: pending/blocked delivery was cancelled by removing Slack or the
  connection; this does not retract a message already received by Slack.

Transient transport/server/rate-limit failures use persisted exponential backoff
and the provider's `Retry-After`, with at most ten attempts before an explicit
retry is needed. Permanent failures block instead of retrying indefinitely.
Connection-wide delivery cooldown applies to later alerts too; neither a new
test, token rotation, process restart nor manual retry is a rate-limit bypass.
An unrepresentable provider delay blocks rather than being silently shortened.

Slack is **at least once**, not exactly once: if Slack accepts a message and the
process stops before recording the acknowledgment, recovery may send it again.
The alert ID is included to make duplicates recognizable. There is no automated
read receipt, upstream message deletion, ticket sync, escalation policy or
recipient acknowledgment reconciliation. Adding Slack later does not retroactively
send alerts that were recorded as in-app only.

## 11. Capacity, retention and failure boundaries

| Bound | Current shipped value/behavior |
| --- | --- |
| Live connections | 20 per private deployment |
| Concurrent collector jobs | 2; one active job per connection |
| Poll cadence | 60 seconds normally; five-second continuation/catch-up scheduling |
| Initial lookback / overlap / settle delay | 15 minutes / five minutes / 30 seconds |
| Window-end advance | At most one hour per completed catch-up window |
| Pages per pass / events per page | 5 / 100 |
| Vendor request timeout / response size | 10 seconds / 2 MiB per Sentry page |
| Slack response size | 1 KiB; expected acknowledgment required |
| Monitoring mutation body | 16 KiB; no arbitrary fields or query parameters |
| Retained alerts | 10,000; bounded eviction only of old acknowledged alerts with delivered, in-app or cancelled delivery |
| Seen event identities | 100,000 across connections; identities older than seven days are pruned during successful page commit |
| Maximum catch-up gap | Six days; a larger gap fails closed and needs an explicit new coverage period |
| Notification attempts | 10 per attempt budget; manual retry preserves cooldown |
| Local monitoring audit entries | Most recent 10,000 lifecycle/acknowledgment entries |

If no eligible alerts can be evicted at capacity, new alert creation fails and
the checkpoint does not advance. Acknowledge reviewed old alerts and resolve
their pending/blocked notifications; do not mark unreviewed alerts acknowledged
merely to make a capacity warning disappear. Identity-capacity failure likewise
leaves the checkpoint incomplete. Canonical admission, telemetry retention,
registry size, receipt age and disk capacity have their own additional bounds.

These logical limits are not disk quotas. SQLite indexes/WAL, authentication,
administration data, documents and backups also need space. Monitor filesystem
capacity and permissions externally. Do not store the live SQLite state on a
shared or distributed filesystem or run several writers against one directory.

An in-process collector cannot notify you while the whole SOC process or host
is down. After restart, timestamps reveal aging and catch-up resumes within the
supported window, but there was no live alerting during the outage. Arrange an
independent private service supervisor, process/host watchdog and recovery owner.
No daemon installation or external watchdog is shipped by this feature.

## 12. Secret storage, retained data and backups

**Unclean shutdown and restart.** Restart uses the same private state directory,
but a hard crash can leave the existing reference store's `runtime.lock` (or
another component's state lock). Startup intentionally refuses an unexplained
lock; automatic stale-lock recovery is not implemented. Before removing a lock,
inspect its recorded process identity, confirm that process is no longer alive,
and independently confirm that no writer owns this state directory. Stop any
supervisor that could restart a competing writer during recovery. Remove only
the exact lock confirmed stale, retain all databases, keys, state and audit, then
start one writer with the same directory. If ownership cannot be established,
stop and investigate instead of deleting the lock or recreating state. Chapter
49 of the in-app technical manual describes this existing recovery boundary.
The forced-crash test exercises pending-page replay **after this explicit lock
recovery**, not an unattended crash restart or a power-loss guarantee.

The application stores `live-monitoring.sqlite` and `live-monitoring.key` inside
its existing private state directory. The directory must be canonical, outside
the checkout, owner-only (0700), and free of symlink ancestors. State files must
be owner-only regular files (0600), owned by the service account, without hard
links. SQLite WAL/SHM companions receive the same private mode.

Sentry tokens and Slack webhook URLs are encrypted with AES-256-GCM using a
random 32-byte key and connection-bound authenticated data. The key is stored
beside the database. This prevents casual plaintext credential disclosure in a
database inspection; **it does not protect against an attacker who can read the
whole directory, its backups, the process memory or the service account.** Use
appropriate operating-system access controls, encrypted storage and backup
custody. This is not an external KMS/HSM or a shipped key-rotation facility.

The state stores non-secret connection configuration, source/application binding,
health, windows/cursors, normalized pending batches, retained seen-event identities,
alerts, evidence IDs/links, delivery state and bounded audit history. Canonical
records are stored by the regular telemetry store. Raw Sentry event bodies exist
only in memory during mapping; arbitrary messages, stacks, request headers and
user objects are discarded. Generated summaries, hashes and upstream evidence
identifiers are still private telemetry, not guaranteed anonymous data. Ensure
your reverse proxy and diagnostics do not log credential request bodies.

Use this conservative consistent cold-backup/restore procedure:

1. Schedule a maintenance window and record the last completed checkpoint and
   pending-delivery state. Stop the private application cleanly, including its
   collector jobs. Confirm no process is writing that state directory.
2. Back up the **entire** private application state as one consistent set:
   monitoring database and key, any SQLite WAL/SHM files still present, authentication
   secrets/databases, telemetry, registry, administration, documents and service
   access state. Preserve ownership, modes and the compatible application version.
   Copying only a live main SQLite file can omit committed WAL data.
3. Protect the backup as highly sensitive. It contains usable credentials when
   combined with its key. Keep it outside the checkout and public artifacts.
4. Restore first to a separate canonical owner-only private directory on a
   compatible supported local filesystem. Do not overwrite the only working
   deployment or manually invent a replacement encryption key.
5. Keep the restored copy from polling or sending Slack while the original is
   active. Do not run two copies of the same restored identity/queue against
   vendors. A verification restore can use outbound network isolation until you
   intentionally transfer sole ownership to the restored instance.
6. Start exactly one intended writer, sign in privately, inspect source binding,
   decryptability, checkpoint age, pending pages, alert acknowledgments and
   notification delivery state. Only then permit collection/delivery under
   your recovery plan and complete a controlled successful poll.
7. Record the restoration time and any gap. A stale backup can replay events or
   notifications already processed after it was taken. Deduplication in a newer
   discarded state cannot protect a restore that no longer contains that state.

A missing key next to an existing database or an undecryptable credential causes
startup refusal. Restore the matching trusted database/key pair. Do not delete
state to bypass that error; doing so loses history and can hide monitoring gaps.
The application does not yet provide online consistent backup orchestration,
cross-version migration rollback or automatically verified restore tooling.

## 13. HTTP contract and automation-agent boundary

All routes below require the authenticated human private-application session.
Mutations require the same exact origin, accept JSON only and are bounded to
16 KiB. An `Authorization` header is refused even alongside a valid cookie.
Neither a source-ingest token nor an MCP service credential grants these routes.
Never copy a browser cookie into an external agent or collector.

| Method/path | Request and result |
| --- | --- |
| `GET /api/v1/monitoring` | Status snapshot: `schemaVersion`, `connections`, `alerts`, `totalAlerts`, `offset`, `nextOffset`, `limits`; optional integer `offset` 0–10,000 and `limit` 1–100 |
| `POST /api/v1/monitoring/connections` | `appId`, `environment`, `displayName`, `region`, `organization`, `project`, `token`, optional `slackWebhook`; checks access and returns `connection` |
| `POST /api/v1/monitoring/connections/:id/poll` | `expectedRevision`; requests due work and returns promptly with connection state and `queued: true`, not proof that a poll completed |
| `POST /api/v1/monitoring/connections/:id/pause` | `expectedRevision`; stops collection |
| `POST /api/v1/monitoring/connections/:id/resume` | `expectedRevision`; re-enables collection without resetting history or cooldown |
| `POST /api/v1/monitoring/connections/:id/credentials` | `expectedRevision`, optional replacement `token` and/or `slackWebhook`; omitted means preserve, an empty webhook means remove Slack |
| `POST /api/v1/monitoring/connections/:id/test-notification` | `expectedRevision`; creates an explicit rate-limited notification test |
| `POST /api/v1/monitoring/connections/:id/retry-notifications` | `expectedRevision`; retries blocked Slack deliveries under the saved cooldown |
| `POST /api/v1/monitoring/connections/:id/remove` | `expectedRevision`; removes connection secrets, stops jobs, archives source and preserves retained history |
| `POST /api/v1/monitoring/alerts/:id/ack` | Empty object; records a local acknowledgment and returns the alert |

Use identifiers returned by the service, not display names or guessed IDs.
Connection mutations reject unexpected fields. Read a fresh revision before
changing a connection. A conflict can mean stale state, duplicate setup, invalid
source lifecycle or a reached bound, not permission to bypass validation.
Status responses never include token or webhook values. Server-side error
messages do not retain raw vendor response bodies; the UI uses safe summaries.

Agents can read this guide, the canonical contracts and integration review,
explain how to register the application, inspect approved non-secret setup
details and prepare code changes within their authorized scope. The shipped MCP
facade does **not** collect vendor credentials, call these session-only routes,
start an arbitrary collector, execute shell/SQL, or receive a new monitoring
management permission. Have the human operator enter secrets and approve
connection/delivery changes through the private UI. A future machine management
surface needs its own scoped authority rather than borrowed browser sessions.

## 14. Troubleshooting without creating false confidence

| Symptom | Check and safe next action |
| --- | --- |
| No applications in setup | Register an application and at least one environment in Onboarding, then refresh after saving/discarding any draft |
| Cannot verify access | Check Cloud region, organization/project slugs, `project:read`, project access and token expiry. An SDK DSN is not an API token |
| Unsupported destination | This built-in reader supports only the fixed Sentry Cloud origins; use a reviewed external collector for self-hosted/custom endpoints |
| Starting persists | Inspect next attempt, source state and errors. Initial access is not a completed window; verify the private server is still running |
| Healthy but no events | Confirm the application sends errors to the selected project and that their original time is within coverage. A successful empty poll is legitimate |
| Unexpected environment events | The local environment is attribution, not upstream filtering. Separate Sentry projects when environment isolation is required |
| Records arrived but health is degraded | The current paginated window may be incomplete or the checkpoint behind; some accepted events do not prove complete collection |
| Unauthorized/forbidden vendor response | Rotate to a valid least-privilege token with project access, then verify a successful completed poll; do not raise privileges indiscriminately |
| Poll now seems inactive | Saved next-attempt/cooldown, concurrency or source pause may prevent immediate work. Read timing and health; repeated clicks cannot bypass them |
| Sentry pagination refused | Preserve state and investigate the exact supported API contract. Missing, repeated or altered next-page metadata must not be treated as end-of-data |
| Gap is more than six days | Preserve old history and explicitly create a new coverage period if appropriate; no automatic skip or historical-completeness claim is made |
| Slack configured but no message | Inspect the individual alert delivery state, expected channel, webhook validity, pending due time and provider rate limits; request one explicit test |
| Slack blocked after repair | Use Retry blocked Slack notifications; the attempt budget resets but saved cooldown remains. An unrepresentable delay stays blocked |
| Duplicate Slack message | An acknowledgment may have been lost after vendor acceptance. Compare the included alert ID; at-least-once delivery permits this |
| Status stops refreshing while typing | Draft protection intentionally pauses read refresh. Save/discard the draft or use confirmed manual refresh; server collection continues |
| Alert/identity capacity reached | Review and acknowledge appropriate old terminal-delivery alerts, fix outstanding delivery, inspect event volume/retention and preserve the incomplete checkpoint |
| Missing key/decryption failure on startup | Restore the trusted matching state and key. Do not delete databases, overwrite a key or start from an empty directory without acknowledging lost history |
| No notification during complete server outage | An in-process monitor cannot run when its host/process is down. Use an independent private watchdog and test its recovery procedure |

## 15. Deployment commissioning checklist

This is the real-account acceptance test to perform after the automated suite;
it has not been completed merely because repository tests pass:

- [ ] A new operator reaches private sign-in, registers the correct application
      and establishes a read-only connection without editing collector code.
- [ ] The selected Sentry project already receives approved application events;
      local environment labeling cannot mix unintended upstream environments.
- [ ] A complete empty window displays successful collection without fabricating
      events, counts or an application-security verdict.
- [ ] One harmless authorized application error produces a canonical observation,
      an actionable alert and an evidence identifier that resolves in Sentry.
- [ ] Optional Slack test and real-event notice reach the intended approved
      channel; configured, pending and delivered states are not conflated.
- [ ] Pausing stops collection; resuming retains coverage/cursor and cooldown.
      Closing the browser alone does not stop the server's collector.
- [ ] A controlled invalid/revoked credential in a disposable connection causes
      visible failure rather than healthy silence; replacement permits a full
      successful window and a recovery alert.
- [ ] Restart with the same private state preserves checkpoint, queued delivery
      and deduplication. No second writer is running against the state.
- [ ] A deliberate vendor/network interruption respects bounded retries and
      cooldown; a blocked notification needs explicit repair/retry.
- [ ] Removing a disposable connection stops work and removes active credentials
      without deleting retained telemetry or claiming vendor-side revocation.
- [ ] A consistent cold backup restores to an isolated private location with
      its matching key and complete application state; dual collection is avoided.
- [ ] An external supervisor/watchdog detects a stopped SOC process; disk and
      retention capacity are monitored, and an operator owns coverage-gap review.

Only after those checks should you set a deployment-specific latency/availability
expectation. More built-in collectors, environment-filtered upstream contracts,
native cases/routing, operator least-privilege roles, service packaging and longer
load/soak/restore testing remain separate work. None of those are implied by a
working Sentry connection or a successful Slack notification.
