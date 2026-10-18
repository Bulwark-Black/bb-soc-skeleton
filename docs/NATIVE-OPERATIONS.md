# Native monitoring and Operations

This port was compared with the **deployed October 18, 2026 BB SOC source**,
including its incident/job pagination update. The stale private local checkout
was not used as the baseline for this port. The public implementation contains
no deployed host list, employee instructions, credentials or operational data.

The seven Operations boards are Infrastructure, Services, Websites, Metrics,
Incidents, Critical jobs and AI Employees. Analyst reports is a separate read
view; Agent Management still administers agents and service credentials.
Existing server-log collection is documented in [SERVER-LOGS.md](SERVER-LOGS.md).
Native numeric monitoring uses a dedicated protocol, not a fabricated log event.

## Configure an application and source

1. Start the private application, sign in and register your application through
   Onboarding. No monitoring targets are inferred from its name or URL.
2. In Sources, configure **Native host and operations monitoring**, source kind
   `monitor.batch`, with a 60-second cadence. Test and activate the source. The
   structural source test proves configuration shape only. Save its issued
   source credential in an owner-only file outside the checkout.
3. Write `operations-config.json` in the private application state directory,
   mode `0600`. Restart the application after reviewing it. Use the actual
   registered application/source IDs. One source maps to one observer host;
   source IDs and host IDs are distinct. The following is a synthetic schema
   example, not a seeded inventory:

```json
{
  "schemaVersion": 1,
  "applications": [{
    "appId": "REPLACE_WITH_REGISTERED_APP_ID",
    "hosts": [{
      "id": "observer-example",
      "appId": "REPLACE_WITH_REGISTERED_APP_ID",
      "sourceId": "REPLACE_WITH_ACTIVATED_SOURCE_ID",
      "label": "Your reviewed Linux observer",
      "services": ["example.service"]
    }],
    "employees": [],
    "websites": []
  }]
}
```

`hosts` expands the generic Linux CPU, memory, root filesystem, load and swap
definitions, with explicitly listed systemd services. `postgres: true` adds the
fixed PostgreSQL measurements. Review the generic thresholds in
`server/native-monitor/registry.js`; alternatively supply a complete validated
`registry` with `VERSION`, `HOSTS`, `SERIES` and `CHECKS` instead of `hosts`.
Every host needs a collection check. Metric checks must match their series and
threshold policy. Maximums are 100 hosts, 600 series and 1,200 checks per app.
Native metric cadence is fixed at 60 seconds to preserve coverage accounting.

An optional employee entry is `{id,name,role,host,sourceId,cadenceSeconds?}`.
It records an externally operated employee, not a running process, permission
grant or prompt. An optional website entry is `{id,host,label,url}`; URLs must
be reviewed, unique HTTPS targets without credentials, query or fragment.
The server does not request these URLs. Website probes come from the configured
external observer. Configuration changes require a restart and do not erase
old evidence; preserve stable identities and back up state before changing them.

## Host collector

Run `python3 tools/native-monitor/collector.py --help` for the explicit config
and state-directory arguments. `check-config` validates without collecting or
sending. `collect` takes local Linux measurements and commits an immutable
batch to private disk. `send` delivers pending batches to the configured private
origin and requires a matching durable receipt before retiring them. Schedule
collection every minute and delivery externally. Keep the collector's config,
token and dedicated state outside the repository, with restrictive permissions.
The first CPU delta may be unknown until a second measurement is available.

The collector configuration requires `schemaVersion:1`, `host`, `sourceId`,
`consoleUrl` and `tokenFile`; optional `services` and `postgres` must agree with
the reviewed registry. Services are fixed systemd units. Readiness probes are
explicit local HTTP checks. PostgreSQL uses fixed read-only local queries;
review the required account/socket access before enabling it. The collector
does not install services, alter database permissions or discover a host fleet.

Use Python 3 on the observer host. Keep `collector.py`, `send-operation.py` and
`website-probe.py` together: the senders import their adjacent shared helpers.
The following examples use a synthetic Linux home directory. Replace it with
your account's canonical absolute path outside the checkout; linked paths are
refused. Do not put a credential value in commands, shell history or config JSON.
Save the issued source credential, with at most one trailing newline, in
`source-credential` using a private editor or your credential provisioning process.

```sh
umask 077
monitor_dir=/home/example/.local/state/native-observer
mkdir -p "$monitor_dir"
chmod 700 "$monitor_dir"
```

Save this as `$monitor_dir/host-config.json`, mode `0600`. Unlike the server's
`hosts[].services` string list, **collector services are objects**. Replace the
synthetic unit and readiness assertion with the exact reviewed service. Remove
`readiness` when none is configured; the result then proves process state only.

```json
{
  "schemaVersion": 1,
  "host": "observer-example",
  "sourceId": "REPLACE_WITH_ACTIVATED_SOURCE_ID",
  "consoleUrl": "http://127.0.0.1:8080",
  "tokenFile": "/home/example/.local/state/native-observer/source-credential",
  "services": [{
    "unit": "example.service",
    "healthySubStates": ["running"],
    "readiness": {
      "url": "http://127.0.0.1:9000/health",
      "statuses": [200],
      "jsonEquals": {"status": "ok"},
      "description": "Reviewed local readiness assertion"
    }
  }],
  "postgres": {"enabled": false}
}
```

The loopback console example works when the private console runs on this same
machine. A remote observer needs its reviewed private HTTPS console origin;
the clients accept private IP origins and supported private network hostnames,
never a public HTTPS console or non-loopback HTTP origin. No proxy environment
settings or console redirects are used. A separately configured readiness URL
is a service probe, not the credential-bearing console destination.

```sh
chmod 600 "$monitor_dir/source-credential" "$monitor_dir/host-config.json"
python3 tools/native-monitor/collector.py check-config --config "$monitor_dir/host-config.json" --state-dir "$monitor_dir/host-state"
python3 tools/native-monitor/collector.py collect --config "$monitor_dir/host-config.json" --state-dir "$monitor_dir/host-state"
python3 tools/native-monitor/collector.py send --config "$monitor_dir/host-config.json" --state-dir "$monitor_dir/host-state"
```

Metrics are a bounded sampling stream. The native collector records gaps when
its age/capacity policy removes samples. This differs from the server-log
reader's no-skip checkpoint behavior. Monitor collector exit status, pending
delivery and gap evidence; a successful send cannot prove complete collection.

## Job and employee evidence sender

Register the job before sending observations. For example, an authenticated
operator can submit this body to
`POST /api/v1/operations/jobs?appId=REPLACE_WITH_REGISTERED_APP_ID`.
The server supplies the actor. An observed schedule records that its external
timing is unproven; registration does not create a scheduler or launch the job.

```json
{
  "idempotencyKey": "register-example-job",
  "id": "example-job",
  "host": "observer-example",
  "label": "Your externally operated job",
  "schedule": {"kind": "observed", "timeZone": "UTC"},
  "maxRuntimeSeconds": 3600,
  "progressTimeoutSeconds": 180,
  "observationTimeoutSeconds": 300
}
```

Save `$monitor_dir/operation-config.json`, mode `0600`, with exactly these
fields. Use the source bound to that job's host. Employee evidence instead
requires an employee registered with that same host/source in the server config.

```json
{
  "schemaVersion": 1,
  "host": "observer-example",
  "sourceId": "REPLACE_WITH_ACTIVATED_SOURCE_ID",
  "consoleUrl": "http://127.0.0.1:8080",
  "tokenFile": "/home/example/.local/state/native-observer/source-credential"
}
```

Your existing job wrapper or observer writes the event after observing the
corresponding execution. This synthetic `$monitor_dir/job-start.json` shows the
shape; replace its timestamp and IDs with the actual occurrence. Keep one
stable `runId` across that run, and a different stable `eventId` for each event.
An uncertain delivery reuses the same event file and ID. Omit `scheduledFor`
when no specific scheduled slot is proven.

```json
{
  "schemaVersion": 1,
  "eventId": "example-run-001-start",
  "observedAt": "2026-10-18T12:00:00.000Z",
  "jobId": "example-job",
  "runId": "example-run-001",
  "kind": "start",
  "evidence": {"basis": "Execution start observed by your existing wrapper"}
}
```

```sh
chmod 600 "$monitor_dir/operation-config.json" "$monitor_dir/job-start.json"
python3 tools/native-monitor/send-operation.py enqueue --config "$monitor_dir/operation-config.json" --queue-dir "$monitor_dir/operation-queue" --event-file "$monitor_dir/job-start.json"
python3 tools/native-monitor/send-operation.py status --config "$monitor_dir/operation-config.json" --queue-dir "$monitor_dir/operation-queue"
python3 tools/native-monitor/send-operation.py send --config "$monitor_dir/operation-config.json" --queue-dir "$monitor_dir/operation-queue"
```

When the run actually finishes, enqueue another owner-only event file using its
original `runId`, a new `eventId`, the actual completion time, and
`kind:"succeeded"` or `kind:"failed"`. Terminal job events require `evidence`.
For an observed zero exit status without output validation, use evidence such
as `{"processExitCode":0,"verification":"unknown"}`. Report `"verified"` only
after an independent check establishes the intended output. A separate
`kind:"observation"` event can report genuine scheduler/process coverage; the
sender does not invent it. Employee events replace `jobId` with `employeeId`;
report events use `kind:"output"`, `outputId`, `outputRef`, a `sha256:` content
digest in `outputHash`, and optional run linkage/provenance.

Network failures and uncertain receipts keep the exact event pending. Run
`send` again after recovery. Rejected credentials, identities or payloads block
that entry and stop later lifecycle events overtaking it. `status` reports the
next retained ID, state, attempt count and HTTP status without event bodies.
After correcting the external cause, explicitly retry the retained event:

```sh
python3 tools/native-monitor/send-operation.py retry --config "$monitor_dir/operation-config.json" --queue-dir "$monitor_dir/operation-queue" --event-id example-run-001-start
python3 tools/native-monitor/send-operation.py send --config "$monitor_dir/operation-config.json" --queue-dir "$monitor_dir/operation-queue"
```

Neither enqueue, send nor retry executes a job, changes its schedule, or grants
an employee permission. Work claims/actions/verification use the authenticated
operator Operations API; they are not accepted through this source sender.

If inspection establishes that an unfinished entry cannot be delivered, an
operator can explicitly abandon that entry while retaining its original body,
identity, delivery outcome, reason and decision time. This releases later
entries; it does not deliver the abandoned event or prove the run succeeded.
The reason is bounded to 1,000 UTF-8 bytes. Review lifecycle continuity before
using this for a start/progress/terminal event that later entries depend on.

```sh
python3 tools/native-monitor/send-operation.py abandon --config "$monitor_dir/operation-config.json" --queue-dir "$monitor_dir/operation-queue" --event-id example-run-001-start --reason "Reviewed invalid source event; retain evidence and investigate the missing execution start."
```

The exact same abandon command is replayable. Its reason cannot later change;
delivered entries cannot be abandoned. Abandoned entries cannot be retried or
replaced with different content under the same ID.

## Website observer

Add a reviewed server target such as
`{"id":"example-site","host":"observer-example","label":"Your reviewed website","url":"https://example.invalid/"}`
to the application's `websites` array, then restart. Replace the synthetic URL
with your approved target. Its ID, host and URL remain bound to retained evidence.
The external observer's URL must exactly match this registration.

Save `$monitor_dir/website-config.json`, mode `0600`:

```json
{
  "schemaVersion": 1,
  "host": "observer-example",
  "sourceId": "REPLACE_WITH_ACTIVATED_SOURCE_ID",
  "consoleUrl": "http://127.0.0.1:8080",
  "tokenFile": "/home/example/.local/state/native-observer/source-credential",
  "targets": ["https://example.invalid/"]
}
```

`collect` requires the explicit `--reviewed-targets` flag and contacts only the
configured targets. Review them before running this command. Each probe makes
a GET with verified TLS, a five-second total deadline and at most three redirects
within the original origin. It sends no source credential or cookies to the
website and retains no response body. Evidence records HTTP status, elapsed
time, a bounded error code, redirect destination without query/fragment and
certificate expiry from the verified TLS connection. Probe failures are queued
observations; a successful `collect` exit means evidence was retained, not that
the website was healthy.

```sh
chmod 600 "$monitor_dir/website-config.json"
python3 tools/native-monitor/website-probe.py collect --reviewed-targets --config "$monitor_dir/website-config.json" --queue-dir "$monitor_dir/website-queue"
python3 tools/native-monitor/website-probe.py status --config "$monitor_dir/website-config.json" --queue-dir "$monitor_dir/website-queue"
python3 tools/native-monitor/website-probe.py send --config "$monitor_dir/website-config.json" --queue-dir "$monitor_dir/website-queue"
```

Schedule collection every five minutes and delivery separately using your
existing scheduler. `send` posts already retained observations to the private
console; it never probes again to repair a failed delivery. It verifies the
batch identity, canonical digest, timestamp and durable receipt before marking
delivery complete. After fixing a blocked delivery's cause, use its ID from
`status.next.id`:

```sh
python3 tools/native-monitor/website-probe.py retry --config "$monitor_dir/website-config.json" --queue-dir "$monitor_dir/website-queue" --batch-id REPLACE_WITH_RETAINED_BATCH_ID
python3 tools/native-monitor/website-probe.py send --config "$monitor_dir/website-config.json" --queue-dir "$monitor_dir/website-queue"
```

Both evidence senders preserve their owner-only SQLite queues across restarts,
pin the source/host/console binding, and refuse silent reassignment. Website
queues also pin the target set. They send at most sixteen entries per invocation,
stop starting further requests after a 45-second budget, and use request timeouts
of at most ten seconds. Pending or blocked work produces a nonzero
send exit status. Queues retain delivered evidence too, with limits of 10,000
entries and 64 MiB of event bodies; no automatic deletion or purge command is
provided. Monitor capacity and preserve completed queues when planning an
operator-controlled queue replacement. Do not delete unfinished evidence.

A first website delivery older than 48 hours is refused; an identical batch
already accepted by the server remains replayable after that interval. Retrying
an invalid payload or an expired first delivery cannot correct its original
evidence. After inspecting the cause, an operator can abandon that retained
batch explicitly, leaving its evidence and reason on disk while later queued
batches become eligible for delivery:

```sh
python3 tools/native-monitor/website-probe.py abandon --config "$monitor_dir/website-config.json" --queue-dir "$monitor_dir/website-queue" --batch-id REPLACE_WITH_RETAINED_BATCH_ID --reason "First delivery expired during the reviewed outage; retain this collection gap for investigation."
python3 tools/native-monitor/website-probe.py send --config "$monitor_dir/website-config.json" --queue-dir "$monitor_dir/website-queue"
```

Abandonment does not establish whether the server accepted an earlier attempt;
its response may have been lost. Inspect server evidence and reconcile uncertain
attempts. Missing observations remain collection gaps. `status` reports abandoned
entries separately. Abandonment does not free queue capacity, permit ID reuse,
or remove any evidence. Never change old timestamps or reuse an ID for different
content to force acceptance.

## Protocol and authorization

Machine endpoints require an active `native-monitor` source credential in an
Authorization Bearer header, without browser cookies. Paused, expired, revoked,
foreign-application or unregistered sources are rejected on every request.
Operator endpoints require a Better Auth session and same-origin writes. The
server supplies the actor; callers cannot impersonate one in request bodies.
The stdio MCP facade does not acquire these native observation/write powers.

| Endpoint | Request |
| --- | --- |
| `POST /api/v1/monitor/batches` | `{sourceId,batch}` with numeric schema version 1, immutable batch/stream/sequence identity, original timestamps, collection quality, registered samples/checks |
| `POST /api/v1/monitor/operations` | `{sourceId,event}` for a registered job or source-bound employee; event has `schemaVersion:1,eventId,observedAt` plus the typed lifecycle fields |
| `POST /api/v1/monitor/websites` | `{sourceId,batch}` containing `schemaVersion:1,batchId,observedAt,checks`; each check has exactly `url,at,status,ms,error,redirect,certNotAfter` |
| `GET /api/v1/monitor/instructions?sourceId=…&employeeId=…` | Pending next-visit guidance for that bound employee; reads never acknowledge |
| `POST /api/v1/monitor/instructions/ack` | `{sourceId,employeeId,messageId,idempotencyKey,reply?}`; explicit read receipt, never completion |

Host batches have `sourceId,streamId,sequence,batchId,bootId,monotonicNs,
collectorVersion,configRevision,observedAt,collection,samples,checks`.
`configRevision` is SHA-256. Samples have `seriesId,value,quality,reason?`;
non-good values must be null. Checks have `checkId,status,summary`.
Unknown series, checks, fields, duplicate identities and out-of-range numbers
are refused. Exact retries return the original receipt; conflicting identities
fail. Replacement streams require an operator action. Delayed samples may be
retained as history, but cannot overwrite newer current health.

Operator APIs live under `/api/v1/operations/` and always require `appId`.
Read routes include `configuration,health,overview,resources,checks,series,
query,incidents,events,notifications,dependencies,jobs,employees,work,
employee-inbox,websites,website-history`. Metric queries take `series` (up to
eight CSV IDs), `from` and `to` in epoch milliseconds. Writes include
`incidents/ack,maintenance,streams/activate,jobs,jobs/events,employees/events,
employees/import,work,work/claim,work/events,employee-inbox/create,
employee-inbox/withdraw`. Writes requiring replay protection take a stable
`idempotencyKey`; revision-sensitive changes also take `expectedRevision`.
Retry the original body after an uncertain result. Do not regenerate identity.

## Monitoring and operational meaning

- Host/service health retains probe quality, freshness, dwell, hysteresis and
  failure/recovery counts. Missing, future or stale observations are unknown.
  A measured critical failure remains visible despite an unrelated probe fault.
- Incidents are durable occurrences with episode recurrence, history cursors,
  acknowledgments, maintenance and event history. Unknown evidence cannot
  resolve an incident. Acknowledgment and maintenance never change measured
  health. Maintenance expires and does not stop collection.
- Metric history is gap-aware, with min/max bands, threshold/incident context,
  bounded selections, tables and CSV/SVG export. Raw metric retention is 14
  days, five-minute rollups 90 days and hourly rollups 400 days. Queries are
  bounded to eight series and 1,200 points per series.
- Website outages require two distinct failed observations. Explicit fresh
  success recovers them; stale evidence does not. Certificate warnings use a
  fourteen-day horizon. Observed success and expected five-minute coverage are
  separate measurements. Ninety days of website probes are retained.
- Jobs separate execution, schedule evidence, output verification and observer
  freshness. A zero exit status alone cannot establish verified output or
  complete scheduler coverage. Job registration does not schedule execution.
- Employee execution and report receipts remain separate. Reports carry hashes
  and provenance; importing a report does not invent an execution start.
- Work assignments preserve optimistic revisions, two-minute leases, action
  intent/start/finish, reconciliation and verification after the latest action.
  Lease expiry never proves a command stopped. SOC records these events and
  does not execute commands or silently retry an uncertain action.
- Next-visit notes have explicit per-recipient receipts and retained withdrawal
  history. Reading a note, replying, or marking it received never completes a
  task or changes a service's health.

## Storage, commissioning and port boundary

Each application has a separate `operations/<app-id-hash>/monitor.sqlite`
database under private state. Native receipts, samples, evaluation and native
incident changes commit together. Operations records and their receipts commit
together; condition reconciliation follows and repeats in the maintenance loop.
This is not an atomic transaction across the canonical-log/auth/document stores.
The monitor enforces a disk quota and free-space reserve. Full capacity refuses
admission. Retained receipt/audit history is not silently discarded to make room.
Use a SQLite-aware backup process for all application state; copying an active
database without its WAL is not a consistent backup.

Commission with your own redacted data: verify source binding, collector quality,
expected services, chart gaps, delivery interruption/retry, stale observations,
incident recovery and restore from backup. The test suite uses synthetic data;
it does not attest an adopter's operating system, network or scheduler.

The deployed monitoring state machines and Operations UI are portable here.
Production inventories, private analyst definitions/prompts, scheduler units,
provider credentials, source-specific detection policy and personal workflows
are intentionally not copied. Native incident notifications now have an opt-in Resend email sender with
durable retries and explicit reconciliation; read [notifications](NATIVE-NOTIFICATIONS.md).
No production watchdog or recipient configuration is installed.
The existing separate Sentry/Slack integration retains its documented behavior.
The original detection-tuning, phishing, scanner and other adapter-owned
workflows still require their documented adopters' implementations; this port
does not claim the entire private deployment is reproduced.
