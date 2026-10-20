# Server logs and collector health

Use **Sources → Server logs** to connect your own server or application log
file. This ports the private SOC's reader-proof monitoring approach into a
reusable source, without copying its hosts, watch paths, credentials, detection
signatures or operational data.

The private application accepts the built-in **Server log collector** source
(`server-log-push`, source kind `server.log`). The external CLI reads one
explicit file, persists a canonical batch in a dedicated outbox, and sends it
to the existing authenticated private ingest endpoint. A successful quiet read
emits a collection proof, not an invented log event. The static shell provides
guidance only; the disposable reference workbench does not enable this source.

## Supported input

| Format | Input and timestamp behavior |
| --- | --- |
| `plain` | UTF-8, newline-terminated lines. The complete message is retained. `observedAt` is collection time, explicitly marked `timestampOrigin: collection-time`; embedded timestamps are not guessed. Suitable for reviewed application, web-server, syslog or database text exports. |
| `docker-json` | One object per line with `log`, `stream` (`stdout` or `stderr`), and RFC 3339 `time`. The original timestamp is retained as `sourceTimestamp`; canonical time has millisecond precision. |
| `journald-json` | One JSON object per line with string `MESSAGE` and decimal-string `__REALTIME_TIMESTAMP` in epoch microseconds. The original timestamp is retained; canonical time has millisecond precision. Binary/array messages are refused. This is JSON output, not the binary journal or Journal Export Format. |

Use an application-managed file or reviewed export. Docker cautions against
external tools accessing its daemon-managed JSON log files; do not modify or
collect directly from those internal files. See the
[Docker JSON logging documentation](https://docs.docker.com/engine/logging/drivers/json-file/)
and [systemd journal fields](https://www.freedesktop.org/software/systemd/man/latest/systemd.journal-fields.html).

Only the documented structured fields are retained. Plain messages and the
selected structured message are **not automatically redacted**. Remove secrets,
request bodies, identifiers and other unwanted content upstream before using
`--reviewed-input`. No field-name filter can guarantee message privacy.

## Register, preview, and activate

1. Install the repository dependencies on the collector machine using the same
   supported Node version as the application. Keep both machines on your private
   network; the SOC listener stays on loopback behind private HTTPS when remote.
2. Register an application and environment in Onboarding. Add a **Server log
   collector** source. Use one source per input file, with a cadence matching
   your external schedule. Host enrollment is optional. Record its actual
   source ID and application ID; the canonical `estateId` equals that app ID.
3. Preview a reviewed input. Replace every uppercase placeholder and absolute
   example path below with your local values:

   ```sh
   npm run collect:logs -- --preview --reviewed-input --file /absolute/reviewed/server.log --format plain --source-id SOURCE_ID --app-id APP_ID
   ```

   Preview prints one normalized record for inspection and source validation.
   It performs no state writes or network requests. Avoid recording that output
   in shared terminal logs. A complete empty file yields an honest reader proof.
4. Paste the reviewed normalized record into **Validate sample** on the source
   setup screen. Validate, activate, and save the one-time source-ingest
   credential into an owner-only regular file (0600), outside the checkout.
   A service/MCP token or vendor credential cannot replace this source token.

## Collect and schedule

Choose two separate canonical absolute directories outside the checkout,
application state, input and credential locations. The collector requires its
outbox to contain only this source and destination; sharing a queue across
collectors is refused. Each must be owned by the
collector account with mode 0700. They are created privately when absent;
symlink ancestors are rejected. On macOS use canonical paths rather than
`/tmp` or `/var` aliases.

```sh
npm run collect:logs -- --once --reviewed-input --file /absolute/reviewed/server.log --format plain --source-id SOURCE_ID --app-id APP_ID --state-dir /absolute/private/log-reader --outbox-dir /absolute/private/log-outbox --token-file /absolute/private/source-token --base-url PRIVATE_ORIGIN
```

`PRIVATE_ORIGIN` is your configured loopback HTTP or approved private HTTPS
origin. HTTP to non-loopback addresses, arbitrary public origins and redirects
are refused. Credentials are read from a file, not argv or an environment value.

One pass reads at most 1 MiB and 100 log records (`--max-records` may lower the
record cap). Input lines are bounded to 16 KiB and retained messages to 4,000
characters. Empty/invalid UTF-8 messages, invalid structured timestamps, oversized
lines and unfinished lines fail explicitly. No line is silently truncated or
dropped. A success proof is added only when the bounded pass reaches the
newline-complete end of its input snapshot. Backlog requires more passes.

Run repeated passes with your own supervisor or scheduler. Watch exit status
and structured results, including `complete`, `error` and `pendingDeliveries`.
An unfinished backlog or pending delivery is not a completed successful run.
The browser and private SOC do not start or schedule this external process.
For throughput beyond this bounded reader, implement an external collector
against the same admission and proof contracts rather than dropping input.

The cursor advances **after durable enqueue**, not after server acknowledgment.
The outbox then owns delivery. A saved pending batch bridges a crash between
enqueue and checkpoint: restart re-enqueues the exact persisted body and
receipt identity. Do not recreate IDs or timestamps to retry. Previously
unfinished delivery is resolved before reading further, so a success proof
cannot overtake an undelivered earlier chunk from this collector.

## Check records and collection independently

- **Received observations:** select your app, source and `log.event`; apply
  event-time start/end filters and inspect messages. Input times are interpreted
  in the browser's local timezone. Start is inclusive and end is exclusive.
  Reported severity is shown when the producer supplied it; the file reader
  makes no severity or detection verdict from free text.
- **Reader proof:** filter `source.heartbeat`. Its exact fields record schema
  version, planned/read input counts, lines read/dropped, success and a safe
  failure code. Counts describe that bounded pass, not lifetime totals.
- **Sources / Health:** inspect the last completed read, last durable delivery
  and latest retained log event separately. The collection timestamp comes
  from the original proof; delayed delivery and replay cannot freshen it.
  A complete quiet read is healthy. A partial, dropped or failed read is not.
- **Guided setup:** select the custom canonical path and this source. Diagnostics
  recognize reader proof and do not treat transport receipt as read completion.

Proof is a validated, authenticated producer claim. Possession of the source
credential permits such claims; the server does not independently inspect the
host, verify every log path or prove complete upstream coverage. Heartbeats do
not count as log events in Logs or Analytics. A stopped collector eventually
becomes stale/offline according to the configured cadence. Arrange an external
watchdog for the SOC itself; a stopped SOC cannot report its own outage.

## Deliver already-normalized application events

The generic queue accepts any complete canonical batch supported by its source,
including output from **Map a custom source**. It performs no mapping itself:

```sh
npm run events -- enqueue --file /absolute/private/batch.json --outbox-dir /absolute/private/event-outbox --base-url PRIVATE_ORIGIN
npm run events -- status --outbox-dir /absolute/private/event-outbox
npm run events -- drain --outbox-dir /absolute/private/event-outbox --source-id SOURCE_ID --token-file /absolute/private/source-token --base-url PRIVATE_ORIGIN
```

Status contains metadata, not log bodies or credentials. Follow its pagination
when inspecting a full queue. An explicit retry of an unexpired blocked entry
uses `events retry --outbox-dir ABSOLUTE --id DELIVERY_ID`; it keeps the original
batch and honors existing destination cooldowns. Fix authorization, lifecycle,
schema or transport problems before retrying.

## Recovery and limits

Keep collector state and outbox together in a consistent backup with writers
stopped. Collector state binds input path, format, source, application,
destination and outbox; the token file may be rotated separately. State contains
checkpoint metadata and possibly an exact pending canonical body; protect it
as sensitive telemetry even after queue delivery.

The reader verifies file device/inode, byte position, prefix and pre-position
anchors. File replacement, rename rotation and copy-truncation are refused;
automatic rotation recovery is **not implemented**. Keep the old input and
checkpoint for recovery. Drain its queue and arrange an explicit new source
and reader state for a new file once the old data is accounted for. Deleting
state to bypass an error can duplicate or lose input and is not a repair.
An unfinished final line can be completed by the producer and retried. An
invalid historical line requires a reviewed export or a deliberate new stream;
there is no skip-bad-line switch.

The marker detects a missing checkpoint database; outbox identity binding
detects a missing/replaced queue. Neither can prove that an entire state
directory was deleted or that a backup is complete. Restoring onto new filesystem
identities requires deliberate operator reconciliation; do not claim seamless
restore of an inode-bound cursor.

The shared outbox is bounded to 10,000 entries, 64 MiB of pending canonical
bodies, ten attempts and seven days of pending-delivery age. Capacity is a hard
failure; it does not evict unfinished work. Delivered receipt rows also consume
entry capacity. Periodically inspect the queue and explicitly prune old delivered
receipts with `npm run events -- prune --outbox-dir ABSOLUTE --before RFC3339`.
Choose a cutoff at least 24 hours in the past. Only delivered rows strictly
older than that cutoff are removed; pending, in-flight and blocked batches stay
intact. Pruning keeps the queue file identity, so collector checkpoints remain
bound. No automatic pruning runs. Preserve any receipt history required for
your own audit before pruning; re-enqueueing a pruned receipt relies on the
server replay window rather than local receipt history.

Keep source records and replay
retention on the SOC adequate for your actual delay and recovery needs. SQLite
telemetry retention, authentication and document stores have independent limits.

## Scope of this port

The public starter already includes private sign-in, documents, scoped service
access, vendor imports, Sentry monitoring, Trivy import, source lifecycle and
indexed telemetry. This update carries over reader-completion health,
checkpointed file ingestion, durable canonical delivery and easier log review.
It adds no seeded data or private deployment configuration.

The separate [native Triage](NATIVE-TRIAGE.md) API now supplies local decisions
and atomic approval steps for retained findings. Log-reader completion and
imported observation state do not authorize those decisions. Private detection
tuning, phishing/intel adapters, scanner execution and estate-specific rules
still require their own reviewed runtime workflows.
