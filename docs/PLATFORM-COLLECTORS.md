# External platform collection workers

These are executable, externally scheduled workers, not catalog-only import
mappings. Each worker reads one reviewed upstream profile, maps selected fields,
stages canonical batches, and checkpoints only after the existing integration
outbox accepts every batch durably. They run outside the BB server, with separate
provider and source-ingest credentials. No live account, private Checkmk site,
or production Wazuh manager was used during development; injectable HTTP/S3
fixtures verify the documented request and recovery contracts. Commission with
representative real records before enabling unattended schedules.

## Shipped profiles

| `provider` | Actual acquisition | Install source adapter | Boundaries |
| --- | --- | --- | --- |
| `checkmk` | Checkmk REST `POST /{site}/check_mk/api/1.0/domain-types/host/collections/all` and `/service/collections/all`, fixed status columns and equality filters for an explicit host list | `checkmk-status` | These POST operations **read status**, not host configuration. Selected site/host access only. No Event Console, metric history, acknowledgment or upstream mutation. |
| `wazuh` | Local reviewed `alerts.json` JSONL or an append-only export of it | `wazuh-alerts` | Upstream alert rule ID, level and evidence are retained as log observations. This does not execute Wazuh rules or collect its raw archive. Rotation/replacement stops safely; see recovery below. |
| `microsoft365` | Management Activity content listing, `NextPageUri`, then content blobs, one configured content type | `microsoft365-audit` | Existing enabled subscription required. Commercial cloud only. Content-ID ledger, availability-time windows and tenant checks; no webhook/subscription changes. |
| `entra` | Graph `/v1.0/auditLogs/signIns` or `/directoryAudits`, bounded date filter and `@odata.nextLink` | `entra-signin` or `entra-directory-audit` | Separate source/config/state for each dataset. Commercial cloud only. Retention and late-arrival overlap must match the tenant. |
| `okta` | `/api/v1/logs` ascending polling, following its opaque `next` link after every page including empty pages | `okta-system-log` | Approved `*.okta.com`, `*.oktapreview.com`, `*.okta-emea.com` tenant origins. No arbitrary custom domain, filters, query text or mutations. |
| `aws-cloudtrail-s3` | S3 `ListObjectsV2` and conditional `GetObject`, immutable CloudTrail JSON/gzip objects under a reviewed prefix | `aws-cloudtrail` | General-purpose commercial AWS buckets, explicit region and expected bucket owner. No SQS acknowledgment, CloudWatch, GuardDuty, historical object-version enumeration or directory buckets. |

Checkmk status routes and their read-only POST semantics are documented in its
[endpoint change](https://checkmk.com/werk/17512) and official
[host endpoint](https://github.com/Checkmk/checkmk/blob/master/cmk/gui/openapi/api_endpoints/host/list_hosts.py)
and [service endpoint](https://github.com/Checkmk/checkmk/blob/master/cmk/gui/openapi/endpoints/service/__init__.py).
Confirm these operations in the installed site's REST documentation. Old GET
variants are not silently substituted. Checkmk Event Console is a separate
interface and filtered event store, not a complete raw log archive.
[Checkmk interfaces](https://docs.checkmk.com/latest/en/apis_intro.html)

## Source setup and one bounded run

Use the vendor source test, activation and source-token procedure from
[VENDOR-INTEGRATIONS.md](VENDOR-INTEGRATIONS.md). The adapter must match the table
above. The BB destination is the existing authenticated canonical ingest route,
via IntegrationOutbox; a provider OAuth token is never sent to BB.

Create an owner-only config and credential files outside the repository. State
and outbox directories must be separate, dedicated, canonical absolute paths;
no symbolic links, shared application-state directories or token files inside
them. Example common config, with adopter-owned values to replace:

```json
{
  "schemaVersion": 1,
  "provider": "entra",
  "sourceId": "YOUR_SOURCE_ID",
  "appId": "YOUR_APP_ID",
  "baseUrl": "https://127.0.0.1",
  "tokenFile": "/etc/bb-collector/source-token",
  "providerCredentialFile": "/etc/bb-collector/provider.json",
  "reviewedInput": true,
  "maxSteps": 10,
  "options": {
    "tenantId": "11111111-1111-4111-8111-111111111111",
    "dataset": "signins",
    "startAt": "2026-10-18T00:00:00Z",
    "retentionDays": 7,
    "windowSeconds": 3600,
    "overlapSeconds": 300,
    "lagSeconds": 120
  }
}
```

The UUID, date and private address above are placeholders. Choose a real start
within upstream retention. `reviewedInput: true` acknowledges that the chosen
fields/message content have been reviewed for authorized retention; it does not
invoke automatic redaction. Unknown config keys reject. `maxSteps` is 1–50;
a step is one page, one content/object retrieval, or one bounded file read.

```sh
node tools/platform-collectors/cli.js check-config \
  --config /etc/bb-collector/config.json \
  --state-dir /srv/state/bb-collector/cursor \
  --outbox-dir /srv/state/bb-collector/outbox

node tools/platform-collectors/cli.js collect \
  --config /etc/bb-collector/config.json \
  --state-dir /srv/state/bb-collector/cursor \
  --outbox-dir /srv/state/bb-collector/outbox

node tools/platform-collectors/cli.js drain \
  --config /etc/bb-collector/config.json \
  --state-dir /srv/state/bb-collector/cursor \
  --outbox-dir /srv/state/bb-collector/outbox
```

`check-config` reads private local files without network or state writes. It does
not verify permissions at a vendor or report a connection. `status` takes the
same arguments and reports local checkpoint/queue metadata without event bodies,
credentials, URL cursors or content IDs. `collect` exits 2 for incomplete bounded
work or a partial file line; invoke again through the supervisor. Errors exit 1
with a fixed error code, never provider response bodies. An active SQLite lease
prevents overlapping collectors; an interrupted worker's lease expires after
120 seconds. Schedule `drain`, `collect`, `drain` with the generated deployment
worker, or equivalent fixed executable invocations. There is no command-string
or arbitrary-script option in collector configuration.

## Provider options and credentials

Replace only the `provider` and `options` sections of the common config for each
profile. Use one source, state directory and outbox per profile. Keep configuration
and secret files mode 0600, owned by the worker; use mode 0700 directories. The
POSIX ownership checks are intended for Linux/container workers. The dedicated
Windows event collector has a separate Windows ACL-aware runtime.

### Checkmk

```json
{
  "origin": "https://127.0.0.1",
  "site": "YOUR_SITE",
  "apiVersion": "1.0",
  "hosts": ["YOUR_EXPLICIT_HOST"],
  "caFile": "/etc/bb-collector/private-ca.pem"
}
```

`caFile` is optional when the site certificate chains to the system trust store.
It is an owner-only external PEM file. Certificate and hostname verification
remain enabled, including for private CAs. Origin validation uses the skeleton's
approved private origin rules; DNS results must remain private. Plain HTTP,
public origins and redirects are rejected. The host list is 1–100 names. Each
host response must contain the requested host; an inaccessible/missing host is
an error, not a healthy empty snapshot. One host's service response is bounded
to 1,000 rows. Larger sites can use separately scoped profiles.

Provider credential JSON is `{ "username": "YOUR_AUTOMATION_USER", "secret":
"YOUR_AUTOMATION_SECRET" }`. Give that user read-only monitoring permissions for
the selected site and hosts. Checked rows retain `last_check` and native state
codes; unchecked rows explicitly use collection time with
`timeBasis=collection-time-no-check` and state `unknown`. Source check summaries
can contain sensitive content; review them. Polling status does not prove that
all host logs or metrics were collected.

### Wazuh

```json
{ "file": "/absolute/path/reviewed-alerts.json" }
```

Omit `providerCredentialFile`. Grant read access only to the selected regular
file. Wazuh's normal manager alert file is `/var/ossec/logs/alerts/alerts.json`;
alert-generation thresholds affect which events exist there. Generated Wazuh
wrappers are restricted to systemd/Ansible with reviewed host file access;
the container/Helm cloud-worker profiles do not mount a Wazuh alerts input. The mapper retains
selected upstream rule/severity/evidence facts and marks `upstreamDetection=true`.
It copies no Wazuh rules or engine code.
[Wazuh alert management](https://documentation.wazuh.com/current/user-manual/manager/alert-management.html)

A run reads at most 1 MiB and 100 complete lines per step. Lines over 256 KiB,
invalid UTF-8/JSON, oversized canonical fields, or unsupported alert shapes reject
the entire step. A partial final line stays at its old byte offset until its
newline arrives. Device/inode, offset and the preceding 512-byte content anchor
are checked on every read. Append-only input is required; the anchor is not a
full-file authenticity guarantee. Copy-truncate, replacement and rename rotation
are **not automatically followed**. Use a controlled append-only export for
unattended operation, or supervised rotation recovery that preserves and fully
admits the old file before starting a new checkpoint. Never delete an old input
or reset the cursor merely to make a health indicator green.

### Microsoft 365

```json
{
  "tenantId": "YOUR_TENANT_GUID",
  "publisherId": "YOUR_API_PUBLISHER_TENANT_GUID",
  "contentType": "Audit.Exchange",
  "startAt": "YOUR_START_RFC3339",
  "windowSeconds": 3600,
  "overlapSeconds": 300,
  "lagSeconds": 120
}
```

Content type is one of `Audit.AzureActiveDirectory`, `Audit.Exchange`,
`Audit.SharePoint`, `Audit.General`, `DLP.All`. Enable auditing, grant the required
`ActivityFeed.Read` application permission and start the chosen subscription
through an authorized administrative workflow before scheduling collection.
`publisherId` identifies the API publisher's tenant; it is not the application's
client ID. Configure the correct value instead of borrowing a placeholder.

Windows use **content availability**, not the newest event time. They are at most
24 hours, with starts within seven days and whole-second precision. Content IDs
are durably deduplicated; blobs may contain much older events. All blobs and pages
must complete before that window checkpoint advances. Expiration/retention gaps
stop with an error instead of silently resetting to now. Follow every returned
same-tenant `NextPageUri` and reject scope changes.
[Management Activity API](https://learn.microsoft.com/en-us/office/office-365-management-api/office-365-management-activity-api-reference)

Credential JSON can contain an externally rotated `{ "accessToken": "..." }`,
or `{ "clientId": "...", "clientSecret": "..." }` for the worker's client
credentials grant. The latter requests `https://manage.office.com/.default`
from the fixed tenant endpoint at `login.microsoftonline.com`. Tokens are held in
memory for one bounded run. No OAuth credential is stored in cursor/outbox state.

### Entra

Use the common example with `dataset: "signins"` or `"directory-audits"`.
`retentionDays` is an explicit integer 1–30 matching the tenant's available
retention, not a promise that the tenant owns the necessary license. Application
`AuditLog.Read.All` and applicable tenant prerequisites are required. Tokens use
the same external credential shapes as Microsoft 365 with the Graph `.default`
scope. Graph hosts and v1.0 audit endpoints are fixed.
[Graph sign-ins](https://learn.microsoft.com/en-us/graph/api/signin-list?view=graph-rest-1.0),
[Graph directory audits](https://learn.microsoft.com/en-us/graph/api/directoryaudit-list?view=graph-rest-1.0)

The worker follows each next link within a frozen filtered time window. A later
window rereads the configured overlap; stable event IDs suppress duplicates and
conflicting repeats stop. An overlap bounds late-arrival recovery; it cannot
promise discovery of arbitrarily late events. `windowSeconds` is 60–21,600,
`lagSeconds` is 0–86,400, and overlap is below window size. Inspect checkpoint lag
and maintain an upstream archive/backfill procedure where completeness matters.

### Okta

```json
{
  "origin": "https://YOUR_TENANT.okta.com",
  "startAt": "YOUR_START_RFC3339",
  "authScheme": "Bearer"
}
```

Credential JSON is `{ "token": "..." }`. Prefer an externally refreshed OAuth
token with the `okta.logs.read` scope; `SSWS` is also an explicit supported scheme
for an appropriately scoped read-only API token. The worker does not implement
Okta OAuth private-key grants. Origin tenant domains are pinned; no credentials
follow another origin, redirects, path changes or bounded-query substitutions.
The initial start must be within 90 days. Thereafter the worker stores the exact
ascending polling cursor; an empty response still commits its returned next
link. This follows insertion order and supports delayed events without inventing
an event-time watermark. No next link, a nonempty repeated cursor, or an expired
retention horizon is an error.
[Okta System Log polling](https://developer.okta.com/docs/reference/system-log-query/)

### AWS S3 CloudTrail

```json
{
  "region": "us-east-1",
  "bucket": "YOUR_GENERAL_PURPOSE_BUCKET",
  "prefix": "example/CloudTrail/",
  "expectedBucketOwner": "123456789012"
}
```

Omit `providerCredentialFile`. Use the AWS SDK's maintained default credential
provider chain: IAM role/workload identity is preferred. Environment/shared-file
credentials and `credential_process` are operator-controlled trust inputs, not
collector config fields; provision and review them outside the repository.
Grant `s3:ListBucket` restricted to the prefix, `s3:GetObject` for its objects,
and only necessary KMS decrypt access. No bucket writes or object deletion occur.
The expected bucket owner is sent on both operations.
[AWS credential chain](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html),
[S3 list](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html),
[S3 read](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html)

The client pins the regional HTTPS endpoint, enforces TLS verification, ignores
configured endpoint URL overrides, disables region redirects and validates the
actual request host. Commercial regional, general-purpose buckets only; no ARNs,
custom endpoints, FIPS, dual-stack, S3 Express or sovereign partitions. Bucket
names in this profile use letters/digits/hyphens, not dots.

List pages and pending object metadata survive restarts. Conditional `IfMatch`
and a key/ETag/size ledger stop changed objects. Every completed prefix scan
starts again from the beginning on the next schedule so later objects whose keys
sort earlier are discoverable. Select a manageable CloudTrail-only prefix; no
unrelated object is silently ignored. Only `.json` and `.json.gz` are accepted,
with 8 MiB compressed and uncompressed limits and at most 10,000 records per
object. CloudTrail's `Records` are mapped through the existing AWS profile; raw
objects are not written to disk. This is not CloudTrail digest-signature
verification or a completeness guarantee for trails that were never enabled.
[CloudTrail file format](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-log-file-examples.html)

## Durability, limits and recovery

Each step first validates/maps its entire response, then persists its canonical
pending batches and proposed checkpoint in SQLite with FULL synchronous mode.
It enqueues the frozen batches into IntegrationOutbox, then commits the cursor
and ID/content ledger in one collector transaction. A crash in between retries
the same receipt IDs. A later retry never substitutes the current time into an
already staged batch. New deliveries use collection `sentAt`; event `observedAt`
remains the upstream original time, so historical imports remain admissible.

The config, source, application, destination, outbox location and outbox file
identity (device, inode and filesystem birth time when available) are pinned. A mixed-source queue, changed config, swapped outbox, missing
state identity or corrupted journal stops. Rotate credential **contents** at the
same paths; changing scope requires a separately reviewed collector state. Back
up state and outbox consistently and stop workers before restore/migration.
SQLite leases protect collection; outbox leases independently protect delivery.

Bounds are deliberate and fail closed: 8 MiB HTTP/object bodies, 1 MiB canonical
batches, 16 MiB staged checkpoint, 200,000 ledger entries, 10,000 pages per cloud
window/scan, and the existing 10,000-entry/64 MiB outbox. No pending records or
object keys are silently evicted. A full queue retains the proposed checkpoint
without advancing. Drain and repair delivery, explicitly prune old **delivered**
outbox metadata with the existing `events prune` command, then retry. Ledger
capacity requires a reviewed new partition/state/archive plan; there is no
unsafe automatic eviction of immutable object identities. Partition large AWS
prefixes and high-volume tenants before reaching the bound.

Provider 429/5xx/network failures persist a cooldown; `Retry-After` is honored up
to seven days. Permanent permission/shape/content errors require operator repair.
Do not reset a cursor to hide an expired blob, missed retention window, changed
object or malformed line. Keep the original upstream archive available and
explicitly backfill the missed scope. Fixed field projection is not a full-fidelity
archive; canonical size limits may require a reviewed reduction upstream.

`complete` and `lastCompletedAt` describe only the stated completion scope: one
configured Checkmk snapshot, one file snapshot, one cloud availability window,
one S3 prefix scan (`object-listing-cycle`), or a drained Okta poll. They do not mean every past event was
available or delivered. An idle future window does not create a read proof.
`checkpointAt`/`lagSeconds` expose window backlog; queue states separately show
delivery. Empty successful reads advance local checkpoints without synthesizing
healthy telemetry. These workers currently do not emit server log collection
heartbeats; monitor worker exit/status and queue state through the supervisor.

The focused tests exercise next links, scope/credential boundaries, historical
time, throttling, quiet reads, partial append, replacement/truncation, immutable
ID conflicts, S3 compressed-size limits, interrupted admission, full queue,
configuration/state pins and overlapping schedules. Live vendor commissioning,
Windows ACL behavior, cloud IAM policy deployment and production throughput remain
adopter acceptance tasks.
