# Windows Event Log and Active Directory ingestion

The `windows-eventlog` adapter turns explicitly supplied Windows events into
canonical `log.event` records. All admitted events appear in Logs. Recognized
Windows authentication/audit semantics are retained in fields; this is not a
claim of complete Active Directory coverage or automatic incident detection.

`tools/collect-windows-events.py` uses the native Windows `EventLogReader` and
`EventBookmark` APIs through a fixed Windows PowerShell helper. Python handles
XML parsing, the private outbox and HTTPS; Node runs the same reviewed mapper
and canonical validators as imports. No third-party Python package is needed.
**Live Windows commissioning is unverified.** Linux tests exercise XML parsing,
normalization and crash/replay recovery with mocked Windows/network boundaries.
Validate the Windows API, ACLs, restart recovery and an actual source receipt in
an isolated Windows environment before relying on collection coverage.

## Configure one private source

1. Run the private application and create an application/environment. In vendor
   import/setup, choose **Windows Event Log and Active Directory**. Use the
   generated `vendor.windows-eventlog` preset and source kind
   `windows-eventlog`; test and activate it. Record the application ID, source
   ID and one-time source-ingest credential. A browser session or service-access
   credential is not a collector credential.
2. On the Windows collector install Python 3 and the repository's supported
   Node.js version (22.13 or newer). Windows PowerShell and Windows Event Log
   must be available. Run under a dedicated identity with access only to the
   selected channels. Security-log read permissions must be commissioned by
   the Windows administrator; this collector does not change audit policy,
   install Sysmon, enable channels or grant permissions.
3. Create a canonical absolute private directory outside the checkout. Remove
   broad inherited access. Its owner and allowed ACL entries must be limited to
   the collector identity, SYSTEM and the built-in Administrators group. Apply
   the same restriction to the configuration and credential file. Symbolic
   links, junctions/reparse points and hard-linked files are rejected. Use a
   separate state directory per configured source; never share it between
   collectors.
4. Save the source credential in a private UTF-8 file. Save a JSON configuration
   following the synthetic example below, replacing identities and paths with
   values from your own deployment. The example loopback origin is only useful
   when the private application is on that same host. For another host, use an
   approved private HTTPS origin with a valid certificate. Proxies and HTTP
   redirects are not followed.

```json
{
  "schemaVersion": 1,
  "sourceId": "source-example",
  "estateId": "application-example",
  "consoleUrl": "http://localhost:3000",
  "tokenFile": "C:\\BB-SOC-Private\\source-credential.txt",
  "nodeExecutable": "C:\\Program Files\\nodejs\\node.exe",
  "channels": ["Security", "System", "Application"],
  "computers": ["server.example.invalid"],
  "maxEvents": 16
}
```

`estateId` is the application's ID in the canonical ingest contract. `computers`
is an explicit list of original Windows `System/Computer` names, compared
case-insensitively, not a DNS discovery list. The source/application/destination
and channel/computer scope are pinned in state. Changing that identity binding
is refused. Rotating the credential file or adjusting `maxEvents` does not
change the binding.

From the checkout, use actual absolute private paths:

```powershell
py -3 tools/collect-windows-events.py check-config --config C:\BB-SOC-Private\collector.json --state-dir C:\BB-SOC-Private\state
py -3 tools/collect-windows-events.py collect --config C:\BB-SOC-Private\collector.json --state-dir C:\BB-SOC-Private\state
py -3 tools/collect-windows-events.py send --config C:\BB-SOC-Private\collector.json --state-dir C:\BB-SOC-Private\state
py -3 tools/collect-windows-events.py status --config C:\BB-SOC-Private\collector.json --state-dir C:\BB-SOC-Private\state
```

`check-config` checks private paths/configuration without probing event channels
or contacting the application. `collect` reads at most `maxEvents` (1–100) from
one channel per invocation, rotating across configured channels after successful
completion. Initial collection starts with the oldest retained event. Each event
keeps its original time; the batch delivery time is frozen when the durable spool
is created, so old retained events can be imported without pretending they are
new observations. The delivery receipt identity includes that frozen time and
body; event record identities do not change when a new delivery is prepared.
`send` makes one bounded delivery attempt. Schedule bounded collect/send passes
externally, retry an existing pending delivery first, and inspect failures.
Throughput is not benchmarked: set cadence, batch size and Windows retention for
your actual volume; `atLimit` means that read may have more backlog. This is not
a service installer. Slow polling can let Windows overwrite unread events.

## Checkpoints, replay and gaps

There is one immutable `pending.json` batch. It contains canonical records,
their digest and the proposed next checkpoint. The committed bookmark is not
advanced while that delivery is pending. A source-scoped matching receipt from
`/api/v1/ingest`, accounting for every record, is required before committing the
new bookmark. Retries send identical records/receipt IDs. A crash after checkpoint
commit but before pending-file retirement is recognized on restart. State writes
flush files and replace atomically; Windows uses write-through replacement.
Concurrent processes cannot own the same state directory.

Before reading past an existing bookmark the Windows helper seeks back to its
anchor and verifies the event XML fingerprint. Missing, overwritten or changed
anchors and changed channel creation times block progress. The collector never
resets a checkpoint to now or drops an oversized/unmappable event automatically.
Normalization or channel failures leave the previous checkpoint unchanged and
write bounded local `failure.json` metadata. `status.lastFailure` is historical;
compare its timestamp with channel `lastReadAt`. Errors are generic and do not
print the credential or raw event XML.

If blocked, preserve state and pending data. Repair permissions, destination or
field-limit/configuration problems and retry. For actual channel loss/reset,
record the coverage gap and reconcile/export any surviving evidence before
commissioning a new source/state generation. Deleting state is not routine
recovery: it loses the original continuity/identity and can reimport retained
history under new event IDs. Windows log retention and independent backups are
still required; an outbox cannot recover records already overwritten upstream.

Quiet successful reads update local status but send no invented log or collection
proof. Vendor source health describes delivery recency, so a quiet source may
be stale on the standard pages. Event delivery, collection completeness and
Windows/AD security state are distinct. A pending replay cannot prove a fresh
read. The collector never labels all expected WEF clients healthy merely because
it can read the collector's local queue.

## Named-field envelope and bounds

The adapter accepts an array or `{ "schemaVersion": 1, "events": [...] }`, with
1–1000 events. Each event has exactly the following required metadata:

- `computer`, `channel` (original channel), `collectionChannel`, `logEpoch`;
- `eventRecordId`: positive UInt64 **decimal string**, preserving all 64 bits;
- `eventId`: integer 0–65535; `eventVersion`: integer 0–255;
- `providerName`, optional `providerGuid`, and original `timeCreated` with offset;
- optional `eventData` and `userData`: maps of named scalar fields.

The collector parses native XML with a real XML parser; DTD/entity declarations,
ambiguous names, unapproved computers and unexpected local channels are rejected.
It supports scalar EventData elements and UserData leaf elements. Native XML is
not accepted directly by the JavaScript adapter. Unnamed EventData uses `param1`,
`param2`, and so on; those fields have no inferred semantics.

Canonical fields are `provider: "windows-eventlog"`, `providerName`, optional
`providerGuid`, `eventId`, `eventVersion`, `channel`, `collectionChannel`,
`computer`, `eventRecordId`, `eventTime`, `logEpoch`, `eventCategory`,
`decodeStatus`, and `win.<original named field>`. The vendor framework adds
`adapterId` and `adapterVersion`. At most 48 event-data fields are accepted;
canonical total is at most 64 scalar fields, each string at most 1000 characters.
Oversized values, nested data, secret-bearing field names and batches over the
1 MiB ingress limit are rejected atomically, not silently truncated. Reduce
`maxEvents` when only the batch size is excessive. Raw XML is not retained by the
adapter or sent to the server; preserve original logs separately when required.

The upstream event key includes original computer, channel, declared log epoch,
record ID and precise original timestamp. The latter protects reused forwarded
origin record IDs after a clear. The wrapper further binds record identity to
source/application. `observedAt` uses canonical millisecond precision; the full
original timestamp remains in `eventTime`. The WEC reader's opaque bookmark is
separate from origin record identity. This does not guarantee deduplication
across independent WEC collectors, lost state or separately enrolled sources.

## Windows and AD interpretation

Security events from `Microsoft-Windows-Security-Auditing` with supported versions
classify 4624 as successful logon, 4625/4771 as failed authentication, and
4768/4769/4776 only from a valid `Status` value. Missing/unrecognized status stays
unknown. Selected account/group/policy events are audit observations without an
invented security verdict. Unknown providers/versions remain searchable,
unclassified logs; provider event IDs are not globally unique.

Security 1102 uses **Microsoft-Windows-Eventlog** and actor fields beneath
**UserData/LogFileCleared**. The parser preserves these as `win.SubjectUserSid`,
`win.SubjectUserName`, etc. 4776 does not identify the destination computer.
4769 has newer versioned fields after January 2025 updates: parsing is by name,
not positional arrays. 4688 command lines require separate policy enablement and
may contain sensitive arguments; absent fields do not satisfy command-line rules.

For AD, configure collection on relevant domain controllers as well as member
servers: they record different authentication evidence. Enable the required
Advanced Audit Policy subcategories separately and verify generated events.
This guide does not change GPOs or claim that collecting a Security channel alone
covers every AD authentication, directory change or file-share operation.

For WEF, configure source-initiated subscriptions and original-source permissions
with Windows administration tools, then select `ForwardedEvents` and list the
allowed original computers. Track WEC subscription heartbeat/runtime errors
separately. Optional supported channels are
`Microsoft-Windows-Sysmon/Operational` and
`Microsoft-Windows-PowerShell/Operational`; they must already exist and be enabled.
No third-party detection pack is copied into this adapter.

Official references:

- [Windows bookmarks](https://learn.microsoft.com/en-us/windows/win32/wes/bookmarking-events)
- [.NET EventLogReader](https://learn.microsoft.com/dotnet/api/System.Diagnostics.Eventing.Reader.EventLogReader)
- [Windows event schema](https://learn.microsoft.com/en-us/windows/win32/wes/eventschema-systempropertiestype-complextype)
- [WEF deployment and collection boundaries](https://learn.microsoft.com/en-us/windows/security/operating-system-security/device-management/use-windows-event-forwarding-to-assist-in-intrusion-detection)
- [Advanced Audit Policy](https://learn.microsoft.com/en-us/windows-server/identity/ad-ds/plan/security-best-practices/advanced-audit-policy-configuration)
- [Security event 1102](https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-10/security/threat-protection/auditing/event-1102)
- [Credential validation 4776](https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-10/security/threat-protection/auditing/event-4776)
- [Versioned ticket event 4769](https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-10/security/threat-protection/auditing/event-4769)
- [Process creation 4688](https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-10/security/threat-protection/auditing/event-4688)
