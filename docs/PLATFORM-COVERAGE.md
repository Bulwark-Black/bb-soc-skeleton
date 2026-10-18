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
| `otlp-logs` | JSON `ExportLogsServiceRequest` with `resourceLogs`, `scopeLogs`, `logRecords`; arrays/NDJSON of complete requests | Resource/scope/log attributes, scope/schema metadata, body, event name, severity, trace/span IDs, dropped-attribute counts, original nanoseconds. This is a bounded **JSON export importer**, not a conforming `/v1/logs` HTTP or gRPC receiver. Binary protobuf, metrics, traces, legacy `instrumentationLibraryLogs`, missing/empty bodies, and unsupported fields reject. |
| `microsoft365-audit` | Management Activity **content records** as JSON array, single object, or NDJSON | Selected common fields: ID, tenant reference, creation time, workload, record type, operation, result, user type, client address, logon error and hashed actor reference when present. Content-listing blobs/URLs and CSV `AuditData` wrappers are not audit records. Unselected workload-specific payloads are not retained. No subscriptions or background API polling. |

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
envelope. No native OTLP or syslog protocol receiver is installed by the mapper.

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

## Collection coverage beyond an import mapper

The following are integration designs and commissioning requirements, not
installed collectors or guaranteed vendor coverage.

| Platform | Recommended collection path | What still needs implementation or adopter configuration |
| --- | --- | --- |
| Windows and Active Directory | Fluent Bit WinEvtLog or an existing Windows Event Forwarding/Collector deployment; normalize exported events through an explicit mapping or the OTLP profile | Channel/bookmark persistence, audit policy, Sysmon/PowerShell/Defender selections, domain-controller profile, permissions, installer and recovery tests. WEF does not enable missing audit policy or disabled channels. [WEF](https://learn.microsoft.com/en-us/windows/security/operating-system-security/device-management/use-windows-event-forwarding-to-assist-in-intrusion-detection), [WinEvtLog](https://docs.fluentbit.io/manual/data-pipeline/inputs/windows-event-log-winevtlog) |
| Linux and application servers | Existing bounded file collector for reviewed plain, Docker JSON or journald-export files; mature continuous collector for native journals/files | Per-service parser packs, multiline/rotation/backfill tests and least-privilege file access. Generic text availability is not proof that audit/security fields exist. [OTel file receiver](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/receiver/filelogreceiver/README.md) |
| Microsoft 365 and Entra | Management Activity content worker plus independent Graph sign-in/audit workers | Subscriptions, pagination, permissions, tenant prerequisites, throttling, overlap windows, content-ID deduplication and durable cursors. M365 blobs can arrive out of order. [Activity API](https://learn.microsoft.com/en-us/office/office-365-management-api/office-365-management-activity-api-reference), [Graph sign-ins](https://learn.microsoft.com/en-us/graph/api/signin-list?view=graph-rest-1.0) |
| AWS | Existing CloudTrail export mapper; future S3/SQS worker and independent CloudWatch/Flow Log adapters | IAM role/workload identity, object/event deduplication, queue acknowledgment after durable admission and pagination/backfill. CloudTrail can duplicate records. GuardDuty findings require a separate upstream-detection mapping. [CloudTrail](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/get-and-view-cloudtrail-log-files.html), [GuardDuty](https://docs.aws.amazon.com/guardduty/latest/ug/guardduty_findings_eventbridge.html) |
| Firewalls and network | Private syslog/CEF gateway feeding these message profiles; versioned vendor body parsers | Actual listener/framing/TLS service, sender binding, device templates, timezone/firmware tests. Generic CEF parsing is not a FortiGate/PAN-OS/Cisco rules pack. SNMP polling metrics remain separate; UDP silence cannot prove health. [Syslog/CEF forwarding](https://learn.microsoft.com/en-us/azure/sentinel/connect-cef-ama) |
| Containers and Kubernetes | Node log agent as DaemonSet; separate gateway and singleton cluster collectors | Persistent queue volumes, CRI metadata, rotation, host logs, control-plane/audit sources, RBAC and duplicate avoidance. Container stdout is not Kubernetes audit telemetry. [Kubernetes logging](https://kubernetes.io/docs/concepts/cluster-administration/logging/), [OTel Helm](https://opentelemetry.io/docs/platforms/kubernetes/helm/collector/) |
| Databases | Version-specific PostgreSQL JSON/CSV/error log mapping; separate read-only metrics collector | Explicit audit/query logging choices, sensitive-value handling, MySQL/MSSQL parser fixtures and credentials. Error logs are not automatically audit logs. [PostgreSQL logging](https://www.postgresql.org/docs/current/runtime-config-logging.html) |
| Existing Wazuh or Elastic | Future adapter importing upstream alerts with rule ID/version, severity, evidence, and source link | Exact versioned alert export/API schema, cursor/retention semantics and provenance. Raw event archives require a separate path. Importing their alerts does not run their rule engines locally. [Wazuh collection](https://documentation.wazuh.com/current/user-manual/capabilities/log-data-collection/index.html), [Elastic rule repository](https://github.com/elastic/detection-rules) |

A transport receipt, collection completion, metric coverage and detection
eligibility are four separate facts. A functioning queue does not prove all
channels were read. A healthy CPU metric does not prove security audit coverage.
A parser accepting JSON does not prove a rule's required fields were collected.

## Checkmk bridge contract

If "Checkmark" refers to another product, do not apply this design to it.
For Checkmk, a future adapter should select an installed-version interface and
report exactly which datasets it reads. REST covers the supported site
operations; Livestatus retrieves host/service status; Event Console has its own
status interface using a Unix socket and a Livestatus subset. A local read-only
bridge can transform those into explicitly classified observations. Inventory,
service checks, numerical metrics and EC events should retain separate identity,
time, state and provenance. Do not infer that every dataset is exported by one
REST route or invoke an upstream acknowledgment/mutation merely by importing.
[Checkmk interface overview](https://docs.checkmk.com/latest/en/apis_intro.html)

Event Console filters/correlates relevant messages and is not a full raw log
archive. Forward full logs through a separate approved collection path when
that is the goal. There is no built-in Checkmk executable bridge in this pack.
[Event Console](https://docs.checkmk.com/latest/en/ec.html)

## Rule portability and distribution

A rule pack needs a versioned manifest: upstream rule/version/author/license,
required logsource/fields and audit settings, normalization version, target
execution backend, supported operators/correlations, fixtures, performance
bounds, and rollback instructions. Publish per-source eligibility such as
"tested", "missing telemetry", "requires external backend" and "unsupported".
Do not equate YAML import or query conversion with running a detection engine.
Sigma pipelines map fields/logsources, and backends have different capabilities.
[Sigma pipelines](https://sigmahq.io/docs/digging-deeper/pipelines.html),
[Sigma backends](https://sigmahq.io/docs/digging-deeper/backends)

This mapper pack copies no third-party detection rules or vendor code. Keep
license/provenance review at the exact upstream release and component boundary:

- SigmaHQ rules use DRL-1.1, including author attribution in displayed matches.
  Preserve notices, authors and source links in rule and alert views.
  [DRL-1.1](https://github.com/SigmaHQ/Detection-Rule-License/blob/main/LICENSE.Detection.Rules.md)
- Elastic's detection-rules repository uses ELv2. Its rules are not an MIT or
  Apache rule library; runtime/source licensing is a separate question.
  [Elastic rules](https://github.com/elastic/detection-rules),
  [ELv2 terms](https://www.elastic.co/licensing/elastic-license/)
- Current Wazuh installation guidance identifies GPLv2 and Apache-2.0
  components. Its manager license also covers rules/decoders unless stated
  otherwise. Keep initial integration external; do not relabel copied rules.
  [Wazuh licensing](https://documentation.wazuh.com/current/installation-guide/index.html)
- Checkmk open-source portions and commercial components have different
  licensing boundaries. Use documented interfaces rather than copying
  commercial extensions. [Checkmk policy](https://github.com/Checkmk/checkmk/blob/master/CONTRIBUTING.md)
- OpenTelemetry Collector and Fluent Bit use Apache-2.0; preserve applicable
  notices when redistributing their components.
  [OTel license](https://github.com/open-telemetry/opentelemetry-collector/blob/main/LICENSE),
  [Fluent Bit license](https://github.com/fluent/fluent-bit/blob/master/LICENSE)

## Deployment automation phases

These are concrete next implementation stages, not shipped installers.

1. **Integration-pack and commissioning contract.** Publish selected platform,
   collector version, explicit inputs/channels, parser version, rule prerequisites,
   private destination, persistent-state location, capacity limits and recovery
   behavior. Preview representative reviewed input, then verify real collection,
   delivery, parse success and rule eligibility separately. Pin checksums/images;
   credentials remain external, never embedded in generated repository files.
2. **Windows and Linux bundles.** Windows continuous collection uses a service
   with recovery policy and restricted ProgramData state; Fluent Bit has native
   Windows service support and OTel offers MSI service installation. Use Task
   Scheduler only for bounded workers with overlap protection. Linux uses a
   dedicated service account and systemd service/timer with persistent state and
   reviewed log access. Produce uninstall/rollback and token-revocation steps.
   [Fluent Bit Windows](https://docs.fluentbit.io/manual/installation/windows),
   [OTel Windows](https://opentelemetry.io/docs/collector/install/binary/windows/)
3. **Containers, Helm and fleet management.** Pin container image digests; mount
   logs read-only; persist only queue/cursor state; use a DaemonSet per node and
   separate gateway/cluster collectors. Supply explicit Helm values and Ansible
   roles for adopter-provided SSH/WinRM inventory. Avoid overlapping subscriptions
   and repeated singleton collection. [Ansible Windows service](https://docs.ansible.com/projects/ansible/latest/collections/ansible/windows/win_service_module.html),
   [Scheduled task](https://docs.ansible.com/projects/ansible/latest/collections/community/windows/win_scheduled_task_module.html)
4. **Cloud workers and existing-tool bridges.** Implement provider-specific
   pagination, durable object/content ledgers, overlap/backfill, rate limits,
   clock/lag reporting and permission probes. Never advance a checkpoint before
   durable admission or treat a partial/error page as complete collection.
5. **Tested detection rollout.** Start with explicit portable original rules or
   a curated, licensed subset in a supported backend. Require positive/negative
   replay tests, source prerequisites, bounded correlation state, suppression
   expiry, attribution, canary rollout and rollback. Unsupported operators fail
   visibly; importing a pack does not automatically activate it everywhere.

Collector maturity and buffering behavior need their own acceptance tests.
OpenTelemetry currently labels its file receiver beta and Windows Event Log
receiver alpha. Fluent Bit filesystem output capacity can discard oldest chunks
when full; enabling disk buffering alone is not a losslessness guarantee. Test
restart, rotation, duplicate replay, full disk, unavailable destination,
backpressure, oversized records, clock skew, malformed input and quiet reads.
[Windows receiver maturity](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/receiver/windowseventlogreceiver/README.md),
[Fluent Bit buffering](https://docs.fluentbit.io/manual/data-pipeline/buffering.md)
