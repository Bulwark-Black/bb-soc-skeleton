# Platform ingestion coverage and deployment plan

This page separates working import mappings from collection services and
possible future integrations. A platform name in a catalog does not mean its
account is connected, its audit policy is configured, or every detection works.
All deployments remain private, authenticated, and bound to adopter-owned
applications and sources. No private inventory or telemetry is included.

See [vendor imports](VENDOR-INTEGRATIONS.md), [server log collection](SERVER-LOGS.md),
and [native monitoring](NATIVE-OPERATIONS.md) for the existing operating paths.

## Four additional supplied-log import profiles

`tools/vendors/platforms.js` exports four bounded, synchronous mappers. They
consume supplied JSON or NDJSON and emit `log.event` records for Logs. They do
not fetch URLs, follow API pagination, execute scripts, start listeners, poll
cloud accounts, or provide collection-completion proofs. The existing vendor
registry supplies source/application binding, canonical validation, stable
batch identities, preview, import, and durable outbox delivery.

| Adapter ID | Accepted input | Preserved facts and explicit limitations |
| --- | --- | --- |
| `syslog-rfc5424` | A JSON string containing one RFC 5424 version-1 message; `{ "message": "..." }`; array or NDJSON of message wrappers | Explicit known-offset timestamp, PRI facility/severity, available header fields, nonempty MSG and structured data. NILVALUE hostname/app/process/message IDs remain absent. No RFC 3164, inferred year, missing timestamp, unknown `-00:00` offset, byte-level non-UTF-8 payload, network framing or listener. |
| `cef` | A JSON string containing CEF 0/1; `{ "message": "...", "timestamp": "..." }`; arrays/NDJSON; optional RFC 5424 envelope | Escaped header, extension key/value fields, vendor/product/class, original severity, action/outcome when supplied. Time must be explicit in `end`, `start`, `rt`, wrapper timestamp, or RFC 5424 header. No legacy syslog time inference or vendor-specific semantic guarantees. |
| `otlp-logs` | JSON `ExportLogsServiceRequest` with `resourceLogs`, `scopeLogs`, `logRecords`; arrays/NDJSON of complete requests | Resource/scope/log attributes, scope/schema metadata, body, event name, severity, trace/span IDs, dropped-attribute counts, original nanoseconds. The mapper is shared by the bounded HTTP JSON receiver; gRPC is unsupported. Binary protobuf, metrics, traces, legacy `instrumentationLibraryLogs`, missing/empty bodies, and unsupported fields reject. |
| `microsoft365-audit` | Management Activity **content records** as JSON array, single object, or NDJSON | Selected common fields: ID, tenant reference, creation time, workload, record type, operation, result, user type, client address, logon error and hashed actor reference when present. Content-listing blobs/URLs and CSV `AuditData` wrappers are not audit records. Unselected workload-specific payloads are not retained. The separate worker polls existing subscriptions. |

The vendor CLI accepts JSON, not unquoted raw syslog/CEF text. Wrap each raw
message in a JSON object before using NDJSON. Preview a reviewed export with:

```sh
npm run vendor -- list
npm run vendor -- normalize --adapter syslog-rfc5424 \
  --file /absolute/path/reviewed-export.ndjson \
  --source-id YOUR_SOURCE_ID --app-id YOUR_APP_ID
```

A bridge can also send the BB gateway envelope
`{sourceId, adapterId, payload}` to authenticated
`POST /api/v1/ingest/platform` using that source's Bearer credential. The server
binds the credential to the selected installed adapter and application. It
bounds input at 8 MiB, canonical output at 1 MiB and 1,000 events, and admits the
batch atomically. This is the **BB gateway protocol**: existing OTLP exporters
and syslog senders cannot point at it without a bridge that constructs this
envelope. The separate protocol gateway supplies native HTTP JSON and syslog TLS listeners; see [receivers](PROTOCOL-GATEWAYS.md).

Use the matching vendor source manifest for admission. Follow the source test,
activation, token-file, enqueue and drain workflow in the vendor guide. A
successful import establishes receipt of the supplied events, not completeness
of an upstream stream. Empty exports are rejected instead of becoming healthy
heartbeats. Raw messages and selected attributes may contain sensitive content;
review/redact exports before preview, upload or enqueue. Mappers do not perform
content-based secret detection or automatic redaction inside message strings.

### Stable fields for portable rules

Every profile emits `payload.fields.provider`: `syslog`, `cef`,
`opentelemetry`, or `microsoft365`. Profiles preserve `originalSeverity` only
where a severity exists. Generic event state remains `unknown`; receiving a
log, a firewall denial, or an upstream error is not a health verdict or an
incident declaration.

- Syslog adds `facility`, `severityCode`, `hostname`, `appName`, `processId`,
  `messageId` where present, `originalTimestamp`, and `timeBasis`.
  `structuredData` is a JSON string containing `{id, params: [[name, value]]}`
  elements. This preserves enterprise IDs containing `@` and repeated
  parameters without key collisions. MSGID is not treated as a unique event ID.
- CEF adds `vendor`, `product`, `deviceVersion`, `eventClassId`, `eventName`,
  `cef.<extensionKey>`, and optional `action`/`outcome` from `act`/`outcome`.
  Header escapes `\|` and `\\` and extension escapes `\=`, `\\`, `\n`, `\r`
  are decoded. A pipe in the extension needs no escape. Duplicate extension
  keys and unsupported escapes reject. Multiple spaces retain value spacing;
  the final space before the next `key=` is the delimiter.
- OTLP uses `resource.<key>`, `scope.<key>` and `log.<key>` to prevent namespace
  collisions. `attributeTypes` preserves each AnyValue type. Int64 values remain
  exact decimal strings; array/kvlist/bytes values retain typed JSON strings.
  `bodyType` distinguishes otherwise identical scalar bodies. Optional
  `action`/`outcome` come only from string-valued `event.action`/`event.outcome`
  log attributes. Original `severityNumber` is retained; trace/span IDs must be
  hexadecimal, not base64. Supplied dropped-attribute counters remain facts.
- Microsoft 365 exposes `workload`, `recordType`, `action` from `Operation`,
  `outcome` from `ResultStatus`, `outcomeScope=provider-operation-only`, and
  optional `userType`, `sourceAddress` and `logonError`. Tenant and user
  references are digests; user names are not retained. This is a selected-field
  projection, not a full-fidelity archive of every workload's audit schema.
  For `Set-AdminAuditLogConfig` only, the exact `Parameters` entry named
  `UnifiedAuditLogIngestionEnabled` maps to
  `m365.UnifiedAuditLogIngestionEnabled`. Boolean or case-insensitive `True`/
  `False` input becomes canonical `True`/`False` text; duplicate or invalid values
  reject. Other command parameters remain unselected. This records the requested
  operation, not proof that the tenant's effective configuration changed.
  [Exchange command parameter](https://learn.microsoft.com/en-us/powershell/module/exchangepowershell/set-adminauditlogconfig?view=exchange-ps)

Microsoft's common schema warns that `ResultStatus=Succeeded` can describe HTTP
success even when an Entra sign-in failed. Rules must use workload-specific
semantics rather than treating the common outcome as authentication success.
[Management Activity common schema](https://learn.microsoft.com/en-us/office/office-365-management-api/office-365-management-activity-api-schema)

### Time, identity and bounds

Canonical `observedAt` has millisecond precision. Original timestamp text or
nanoseconds remain in fields, and digest identity includes finer precision.
OTLP nanoseconds are divided as `BigInt` before conversion to milliseconds;
unsafe JSON numeric integers reject. Decimal strings are recommended for int64
and fixed64 values. If OTLP event time is missing/zero but its original observed
time is supplied, the importer uses that with `timeBasis=observedTimeUnixNano`.
Neither time present means rejection. No mapper falls back to the import clock.

CEF time precedence is `end`, `start`, `rt`, explicit wrapper `timestamp`, then
RFC 5424 header timestamp. All supplied CEF timestamp extensions are validated.
Only epoch milliseconds or RFC 3339 with a known timezone are accepted; CEF's
other human-readable time encodings are outside this profile. Receipt time is
labelled `cef.rt`, never silently presented as activity-start time. Header and
wrapper times remain separate facts. Microsoft 365 alone accepts an unzoned
`CreationTime`, because that API's common schema explicitly defines it as UTC.

CEF `externalId`, when present, is scoped by vendor/product/device facts for
upstream identity. Microsoft 365 IDs are scoped by tenant. Other events use a
stable content digest. Exact repeated events without a producer-unique ID can
coalesce; this is not an exactly-once ingestion or original event-count promise.
The vendor registry rejects conflicting content for a repeated upstream ID.

The canonical contract permits at most 64 scalar fields (including the two
registry fields), 1,000 characters per field value, and 4,000 characters per
message. A structured value is bounded JSON stored as a scalar string.
Unsupported keys, secret-bearing key suffixes, duplicate/conflicting keys,
oversized values/attribute sets, malformed records, and missing original time
reject the supplied batch rather than silently truncating/dropping events.
OTLP and syslog structured data may therefore need upstream reviewed reduction.
Keep the original export in the adopter's approved archive if full fidelity is
required; the skeleton does not silently retain it elsewhere.

Grammar references: [RFC 5424](https://www.rfc-editor.org/rfc/rfc5424.html),
[CEF standard](https://docs.microfocus.com/doc/2097/25.4/siemcefimplementationstandard),
[CEF extension dictionary](https://www.microfocus.com/documentation/arcsight/arcsight-smartconnectors-8.3/cef-implementation-standard/Content/CEF/Chapter%202%20ArcSight%20Extension.htm),
[OTLP JSON](https://opentelemetry.io/docs/specs/otlp/).

## Executable collection and deployment coverage

The repository now includes the following collection paths. Configuration,
source activation, credentials, audit policies and live commissioning still
belong to each adopter.

| Platform | Shipped path | Boundaries |
| --- | --- | --- |
| Windows Server and Active Directory | Native EventLogReader worker, durable bookmarks and spool, WEF ForwardedEvents, generated restricted Task Scheduler bundle | Commission Windows channel permissions and auditing; selected Security/System/Application/Sysmon/PowerShell/Defender channels. Linux tests cannot establish a live domain-controller acceptance result. |
| Linux and application servers | Bounded file worker for plain, Docker JSON and journald-export files; systemd/Ansible/container bundles | Explicit file selection; rotation and replay safeguards. Native journal streaming, arbitrary multiline parsing and every service-specific audit schema are not implied. |
| Microsoft 365 | Management Activity content polling and durable content-ID ledger | Existing subscriptions and bearer credential lifecycle must be configured; polling does not silently create tenant subscriptions. |
| Entra | Graph sign-in and directory-audit workers | Permissions, tenant licensing/retention and token renewal are external. |
| Okta | System Log ascending poll cursor and next-link handling | Reviewed organization endpoint and credential; quiet pages preserve the polling cursor. |
| AWS | CloudTrail S3 object polling, bounded gzip, key/ETag ledger and repeated listing cycles | IAM/default credential chain, approved regional bucket/prefix. No SQS acknowledgment worker, CloudWatch metrics, Flow Log or GuardDuty inference. |
| Checkmk | REST host/service status worker | Keeps upstream status/time provenance; does not claim raw logs, Livestatus metrics or Event Console stream coverage. |
| Wazuh | Bounded alerts JSONL file bridge | Keeps upstream detection identity and severity; does not copy/run the Wazuh engine or raw archives. |
| Network devices | Authenticated syslog TLS RFC5424/CEF receiver with durable outbox | Explicit timestamp, UTF-8 and framing profile; firmware-specific body semantics still require reviewed mappings/rules. |
| OpenTelemetry | Authenticated /v1/logs HTTP(S) JSON receiver with gzip | Bounded JSON profile only, no protobuf/gRPC/metrics/traces; upstream transformation may be required. |
| Containers/Kubernetes | Digest-pinned Compose and Helm generation, source-bound collector DaemonSet and separate gateway Deployment | Explicit named node/storage/private Secret; no cluster API token or automatic control-plane audit collection. |
| Other supported exports | Existing GCP, Cloudflare, Auth0, GitHub/GitLab, Sentry, Datadog and other catalog mappings | Export/import support does not imply a scheduled provider worker. Database-specific audit parsers and Elastic alert import remain separate work. |

Read [cloud workers and bridges](PLATFORM-COLLECTORS.md),
[protocol receivers](PROTOCOL-GATEWAYS.md),
[deployment automation](DEPLOYMENT-AUTOMATION.md),
[Windows collection](WINDOWS-EVENTS.md) and
[reviewed rule packs](REVIEWED-RULE-PACKS.md).

The vendor catalog has 18 supplied-input adapters. Collection workers call those
same reviewed normalization contracts rather than bypassing canonical validation.
A transport receipt, collection completion, metric coverage and detection
eligibility remain separate facts. A queue does not prove every channel was
read; CPU metrics do not prove security audit coverage.

## Checkmk integration

“Checkmark” has been interpreted as Checkmk. The executable bridge reads the
documented REST host/service status datasets. It does not acknowledge events or
mutate monitoring state. It preserves upstream state as evidence; it does not
turn a status export into raw log completeness. Checkmk Event Console remains a
separate filtering/correlation system with its own interface.
[Checkmk interfaces](https://docs.checkmk.com/latest/en/apis_intro.html),
[Event Console](https://docs.checkmk.com/latest/en/ec.html)

## Rule distribution and licensing

The engine ships 25 original MIT rules plus an explicit reviewed JSON-pack
installer. Packs require namespace/version, author, license, notices,
prerequisites, supported operators and positive/negative fixtures. Shadow mode,
source-scoped active rollout, expiring suppressions, compare-and-swap policy
updates and one-version rollback are implemented. There is no automatic download
or generic Sigma/Elastic execution.

Upstream rules retain their own licenses. SigmaHQ rules use DRL-1.1; preserve
attribution and notices in rule and alert views. Elastic detection rules use
ELv2 and are not accepted by this bounded pack installer. Wazuh remains an
external alert producer, and Checkmk remains an interface integration.
No third-party rules or commercial extensions are copied into this repository.
[Sigma license](https://github.com/SigmaHQ/Detection-Rule-License/blob/main/LICENSE.Detection.Rules.md),
[Elastic rules](https://github.com/elastic/detection-rules),
[Wazuh components](https://documentation.wazuh.com/current/installation-guide/index.html),
[Checkmk contribution policy](https://github.com/Checkmk/checkmk/blob/master/CONTRIBUTING.md)

## Commissioning and acceptance

Generated bundles are reviewable artifacts; generation never applies them.
Pin the reviewed image, install the exact collector dependencies, prepare private
persistent storage, activate the correct source, then prove collection, durable
delivery, parsing and rule eligibility separately. SMTP uses the mail service
behind Roundcube and requires its own TLS/authentication check and explicit
recipient test. Relay acceptance does not prove inbox delivery.

Tests cover simulated provider pages, real loopback HTTP/TLS, crash/restart,
rotation, duplicate replay, backpressure, malformed input, quiet reads, time
bounds and transactional rollback. Credentials and real tenant/device access
are not present in the repository. Perform live Windows, provider, container,
Helm and Ansible acceptance in the adopter's environment before broad rollout.
