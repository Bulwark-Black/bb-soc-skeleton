# Connector, source, and ingest integration

This is the adopter contract for making Onboarding and Sources operational and
then filling the console from real, authorized sources. It distinguishes three
planes that must stay separate:

```text
browser UI ─┐
CLI         ├─> authenticated control service -> registry, commands, audit
MCP tools ──┘

push | webhook | pull worker | OTLP | syslog | agent
                         └─> telemetry admission -> canonical records
                                                       └─> page projectors
                                                               └─> readPage
```

The page adapter reads authorized presentation models. The connector provider
administers source lifecycle. Data-plane receivers/workers admit telemetry.
MCP, when an adopter chooses to expose it, is only another administrative
client of the same control service. It must never be a log/telemetry transport
or accept, retrieve, or return plaintext credentials.

## What is implemented here

The repository provides:

- strict browser/CommonJS validation for connector manifests, registrations,
  health, control snapshots, five lifecycle commands, and provider objects;
- portable JSON Schemas for connector/source/control documents and canonical
  record/ingest documents;
- Onboarding and Sources UI bindings that remain disabled without a validated
  connector provider;
- local validators for connector and ingest documents;
- a loopback-only reference server with a persistent local registry, bounded
  command/ingest endpoints, hashed one-time credentials, a crash-detecting
  audit journal, and page projection; and
- one reference connector type: canonical `log.event` push projected into
  Overview, Sources, Security Logs, Analytics, and SOC Health.

It does not provide production authentication/authorization, CSRF/session
handling, a transactional database, managed secret storage, a durable queue,
multi-process coordination, vendor connectors, pull scheduling, webhook
signature handlers, OTLP/syslog listeners, an agent runner, or a production MCP
service. A separate narrow reference MCP process exposes public resources and
scoped calls into the same loopback connector/administration API boundary.

## Current version-1 vocabulary

The checked-in contract intentionally uses the active product's `app` naming.
These identifiers are opaque, stable, server-issued identities:

| Entity | Current v1 fields and relationship |
| --- | --- |
| App | `appId`, display name, declared `hostId` list, optional HTTPS public pages, lifecycle/revision/timestamps |
| Host | `hostId`, owning `appId`, display name, enrollment state, independent connection state, last proof, revision/timestamps |
| Connector manifest | Stable `connectorType` and `connectorVersion`; data-only description of one installed connector type |
| Connector instance | `connectorInstanceId`, owning `appId`, `connectorType`, non-secret config, credential references, lifecycle/revision/timestamps |
| Source | `sourceId`, `connectorInstanceId`, `appId`, optional `hostId`, `connectorType`, manifest-owned `sourceKind`, config/references, health, lifecycle/revision/timestamps |
| Change | Stable change ID, typed resource/action/status, timestamp, and bounded safe message |

Never derive source identity from `(host, sourceKind)`. Multiple instances of
the same connector and multiple same-kind sources on one host are valid.
Changing a display label must not replace a stable ID.

A production model may add a tenant/estate above `appId`, publishers,
manifest-package identity, operation records, collection runs, tombstones, and
retention metadata. Those are versioned extensions, not fields that may be
silently added to the closed v1 browser documents. In canonical record v1,
`estateId` is the source-scope field; the reference runtime requires it to equal
the source's `appId`.

## Connector manifest v1

`contracts/connector-manifest.v1.schema.json` and
`SocConsoleConnectorRuntime.validateConnectorManifest` define the same closed
shape:

- exact `schemaVersion: "1"` and `documentType: "connector-manifest"`;
- `connectorType`, `connectorVersion`, display name/description, and scope
  (`application`, `host`, or `service`);
- one or more `supportedSourceKinds` selected by the UI;
- a pinned payload schema ID/version, controlled output `recordKinds`, and
  required/optional/forbidden line/content modes;
- one or more target routes with stable catalog surface IDs and output kinds;
- non-secret `configFields` with a closed value type, required flag, enforceable
  numeric bounds, and enum choices when applicable;
- `credentialSlots` describing required references, never values; and
- a health policy declaring push/poll mode, expected/stale/offline intervals,
  and empty-payload behavior.

The manifest registry is the only source of connector/source choices, rendered
configuration fields, credential-reference slots, outputs, search/log behavior,
and “Lands on” targets. The UI must not offer a free-form new source kind or a
user-controlled “Searchable in Logs” switch. A kind is installable only when it
has a validated schema, canonical mapping, health policy, and at least one
compatible projector.

Manifests are data, not browser plugins. They cannot contain markup, callbacks,
scripts, shell fragments, credential values, or arbitrary form actions. A
server-owned reviewed driver implements each production connector.

Manifest `payload.recordKinds` and normalized-record `kind` use the same closed,
dot-qualified canonical vocabulary. This removes a second mapping table that
could drift between connector admission and page projection. A server-owned
normalizer still converts vendor payloads into those canonical records, but a
manifest that declares `log.event` emits `log.event`; clients never guess or
rename the kind.

## Browser connector provider

Bootstrap resolves the configured `SOC_CONSOLE_CONNECTORS` global and validates
this exact interface:

```js
{
  schemaVersion: "1",
  id: "application-connectors",
  getSnapshot(request),
  execute(request),
  dispose // optional
}
```

`getSnapshot` accepts only:

```js
{ schemaVersion: "1", reason: "initial" | "refresh" | "command", knownRevision? }
```

It returns a `connector-control-snapshot` containing installed connector types,
apps, hosts, connector instances, staged setups, active/disabled sources,
changes, and the registry revision. The runtime validates all identity and
ownership relationships and forbids one-time credentials anywhere in a
snapshot.

`execute` accepts and returns correlated version-1 command documents. The
closed command set is:

| Command | Input purpose | Successful state |
| --- | --- | --- |
| `app.register` | Display name, normalized host labels, optional HTTPS public pages | `registered` app |
| `host.enroll` | Existing owning `appId` and `hostId` | `enrolled`; may return one connection-check credential once |
| `source.setup` | App/optional host, installed connector/source kind, display name, non-secret config, credential references | independent source and connector instance in `configured` |
| `source.test` | Stable source/instance IDs plus `expectedRevision` | `tested` |
| `source.activate` | Stable source/instance IDs plus `expectedRevision` | `active`; may return one source-ingest credential once |

Results are `succeeded`, `failed`, `rejected`, or `conflict` and carry either a
typed output or a bounded safe error. Reusing a request ID with different input
is a conflict. A successful control command is followed by a fresh snapshot and
page read; the browser does not invent optimistic state.

This provider activates only the corresponding controls on `/onboard` and
`/sources`. Page-provider `runCommands` capability flags do not activate them,
and the connector provider does not activate remediation, triage, rule,
settings, upload, or other structural actions.

## UI onboarding flow

The implemented UI guides an operator through these gates:

1. **Register app.** `/onboard` collects an app name, a bounded list of hosts,
   and optional HTTPS public pages. The server creates stable app/host IDs.
2. **Enroll host.** Mint a host-bound connection-check credential. Display it
   only in that successful result and store only a digest/reference server-side.
3. **Prove connection.** An enrolled host submits the reserved, fresh
   connection-check document with that credential. This proves only the local
   admission path and never creates a searchable source or event.
4. **Configure source.** `/sources?stab=add` selects the app, host, installed
   connector type, and one supported kind. The form is generated from manifest
   config fields and credential-reference slots. Reference mode allows this
   after enrollment, but the next test remains blocked until connection proof.
5. **Test.** Run a bounded server-side connection/structure test. A test changes
   lifecycle state but does not create telemetry or mark collection healthy.
6. **Activate.** Pin the source/instance and issue any source-bound ingest
   identity. Collection health remains pending until a real batch is accepted.
7. **Observe.** Project accepted records and source health into existing panel
   IDs. An old successful test or delivery cannot mask a current failure.

Production secret entry/provisioning is a separate write-only server flow that
returns an opaque credential reference. The browser connector contract accepts
reference objects using the supported stores (`environment`, `host-managed`,
`secret-manager`, or `vault`); it never accepts a plaintext connector secret in
configuration.

## Canonical ingest v1

Transport-specific receivers and workers normalize vendor input before it
reaches the canonical contract. A normalized record contains exactly:

| Field | Rule |
| --- | --- |
| `schemaVersion`, `documentType` | Exact v1 normalized-record discriminator |
| `recordId` | Stable source-scoped deduplication ID |
| `sourceId` | Must identify the authenticated active source |
| `estateId` | Scope identity; equals `appId` in the reference runtime |
| `kind` | One of the controlled dot-qualified canonical kinds |
| `observedAt` | RFC 3339 producer observation time |
| `payload` | Bounded typed title/state plus kind-required and optional safe fields |

Payload fields are closed and bounded. The optional `fields` map is scalar-only,
has bounded key/value counts and lengths, and rejects secret-bearing field
names. Canonical records contain no markup or credential material.

An `ingest-batch` contains one `sourceId`, a 16-to-128-character `receiptId`, an
RFC 3339 `sentAt`, and 1 through 1,000 unique records whose `sourceId` values all
match the batch. Transport authorization is a header/connection property, never
a JSON field.

Every production acquisition mode should converge on one admission sequence:

1. retain bounded raw bytes long enough to authenticate and verify signatures;
2. resolve the tenant/app, connector instance, active source, and pinned schema;
3. reject cross-scope, inactive, expired, oversized, malformed, or unsupported
   input before mutation;
4. normalize and validate the complete typed record, not just an outer wrapper;
5. bind deduplication to source plus receipt/provider event identity and exact
   body content;
6. durably commit receipt and records, then enqueue projector work; and
7. acknowledge only after the chosen durable boundary.

Push endpoints use scoped bearer proof or mTLS. Webhooks additionally verify a
provider signature over exact raw bytes and enforce replay windows. Pull workers
resolve credential references server-side and persist cursors. OTLP receivers
bound resource attributes and cardinality. Syslog should prefer authenticated
TLS/TCP or RELP; UDP is explicitly lossy. Host agents need least privilege,
stable source IDs, a bounded durable local spool, retry/backoff, and safe
upgrade/rollback. None of these transports belongs in MCP.

## Health and page projection

Source health v1 is independent of event content. It carries one of `unknown`,
`pending`, `healthy`, `degraded`, `stale`, `offline`, `error`, or `disabled`, a
controlled reason, last attempt/success/next expected timestamps, and bounded
counters. A new active source remains `pending` with
`awaiting-first-delivery`; only accepted data can make it healthy. Stale/offline
decisions use manifest/source cadence and cannot be inferred from page refresh.
For the reference connector, configured cadence scales the manifest policy's
`300`/`450`/`900` expected/stale/offline relationship. A 300-second cadence is
healthy through 450 seconds, stale through 900 seconds, and offline after that;
the control snapshot and page projector use the same thresholds.

Projectors consume canonical records idempotently and build authorized read
models. Acquisition cursors and projector checkpoints are different state. One
record may fan out to several surfaces, but page output must remain within the
page-envelope limits and stable catalog panel IDs.

The checked-in reference integration maps canonical `log.event` and connector
registry state to:

| Route | Existing panel IDs populated by the reference projector |
| --- | --- |
| `/` | `summary-metrics`, `detections` |
| `/sources` | `expected-sources` from the page projector; `configured-sources` and `source-registry-changes` from the validated control snapshot |
| `/logs` | `log-results` |
| `/analytics` | `summary-metrics`, `events-collected-per-hour` |
| `/health` | `summary-metrics`, `is-the-collection-working` |

The broader production mapping for findings, assets, vulnerabilities, database
snapshots, backup/evidence status, intelligence, phishing, access/offboarding,
governance, and remediation must be implemented with installed manifests and
the stable panel IDs cataloged in [FEATURES.md](FEATURES.md). Detection and
analytics consume canonical records; they must not scrape page envelopes.

## Loopback reference workbench

The reference workbench is opt-in and never starts with the static shell. Start
it with an explicit disposable state directory:

```sh
soc_reference_state="$(mktemp -d)"
npm run start:connectors -- --state-dir "$soc_reference_state"
```

It binds only to `127.0.0.1`, defaults to port `8787`, serves the UI and a
same-origin bridge, and prints a conspicuous non-production warning. Use
`--port` or `SOC_REFERENCE_PORT` to select another loopback port;
`SOC_REFERENCE_STATE_DIR` is the environment alternative to `--state-dir`.
Stop it with Ctrl-C. The state directory remains until the operator removes it.

The bridge installs `SOC_CONSOLE_CONNECTORS`, `SOC_CONSOLE_ADMINISTRATION`,
`SOC_CONSOLE_AUTH`, `SOC_CONSOLE_ADAPTER`, and a local
`SOC_REFERENCE_WORKBENCH` helper for host/agent connection proof and ingest
calls. Its exact HTTP surface is:

| Method/path | Reference purpose |
| --- | --- |
| `GET /api/v1/control/snapshot` | Validated control snapshot; accepts `reason` and optional `knownRevision` only |
| `POST /api/v1/control/commands` | Closed connector command request; maximum 64 KiB |
| `GET /api/v1/administration/snapshot` | Validated agents/governance snapshot; exact `domain`, `reason`, optional `knownRevision` query |
| `GET /api/v1/administration/prompts` | One separately authorized prompt document selected by exact `promptId` |
| `POST /api/v1/administration/commands` | Closed administration command request; maximum 64 KiB |
| `GET /api/v1/pages` | Projected page envelope for a route/query |
| `POST /api/v1/connection-check` | One-time `Enrollment` authorization and bounded proof document |
| `POST /api/v1/agents/connection` | One-time agent `Enrollment` authorization and exact agent proof document |
| `POST /api/v1/ingest` | Source-bound `Bearer` authorization and canonical batch; maximum 1 MiB |
| `GET`/`HEAD /application-bridge.js` | Generated same-origin browser providers for reference mode |
| `GET`/`HEAD /api/v1/browser-provider.js` | API-namespaced alias for the same generated provider bridge |

To exercise the whole reference slice, register an app on `/onboard`, open the
Sources **Add a source** tab, and mint the selected host's connection-check
credential. The intended host submits a fresh version-1 connection-check
document with that one-time value; for local contract testing the generated
bridge exposes the same call as:

```js
await SOC_REFERENCE_WORKBENCH.connectionCheck(connectionCheckDocument, oneTimeCredential)
```

Refresh Sources, configure `canonical-push` / `log.event`, run **Test**, and
then **Activate**. Activation displays a different, source-bound ingest value
once. Submit a batch that already passes `npm run validate:ingest`; the local
helper calls the same bounded endpoint as an agent would:

```js
await SOC_REFERENCE_WORKBENCH.ingest(validatedIngestBatch, sourceIngestCredential)
```

The connection-check document needs the returned `appId` and `hostId`, a fresh
RFC 3339 `observedAt`, and a unique nonce. The ingest batch needs the activated
`sourceId`, the owning app in `estateId`, fresh send/observation timestamps,
and a unique receipt/record identity. The credential is a transport argument,
never a document field. These helpers exist only in loopback reference mode;
production agents call authenticated TLS endpoints instead of a browser
global.

To exercise Agent Management locally, create an active agent, revise/activate a
prompt if required, and issue an enrollment from `#/agents`. Submit the exact
agent connection document with the one-time output:

```js
await SOC_REFERENCE_WORKBENCH.agentConnection(agentConnectionDocument, oneTimeEnrollmentCredential)
```

The document contains only `schemaVersion`, `agentId`, `enrollmentId`, and a
fresh RFC 3339 `observedAt`; the credential is the `Enrollment` transport
argument. Successful proof marks the enrollment connected and updates safe
last-seen state. It is not a task, telemetry, secret, or remote-execution
channel.

Mutations require an exact loopback `Host` and matching `Origin`; cross-site
requests and CORS preflights are rejected. JSON must be uncompressed UTF-8 with
the exact supported content type. Ingest hashes the raw request body and binds
receipt reuse to source and body. An exact retry returns the prior receipt;
reusing a receipt or record ID with different content is rejected.

The local state directory is owner-only, files are forced to owner read/write,
symbolic links are rejected, and a runtime lock prevents simultaneous use. The
store bounds state/audit size and record/receipt counts, writes state through an
atomic replacement, journals intent/commit/abort, and fails closed on detected
inconsistency or write failure. One-time values are returned only at issuance;
only digests and safe metadata persist.

Those safeguards make the workbench useful for local contract testing. They do
not make it a production server. Do not expose it remotely or put production
credentials, customer data, or production telemetry in its state directory.

## Reference agent MCP

With the loopback workbench running, `npm run start:agent-mcp` starts a separate
stdio MCP process. It publishes checked-in documentation/contracts and calls the
same fixed control API through `connector_snapshot`, `connector_command`,
`administration_snapshot`, `administration_prompt`, and
`administration_command`. `host.enroll`, `source.activate`, and
`enrollment.issue` are refused before HTTP because their successful results may
contain one-time credentials. Run them through the protected operator UI or an
equivalently reviewed non-MCP ceremony.

The default API origin is `http://127.0.0.1:8787`; override it only through
`SOC_AGENT_MCP_BASE_URL` or `--base-url`. The destination validator permits
plain HTTP only on exact loopback and HTTPS only on loopback/private addresses
or the validated private-overlay DNS suffix. Tools accept no URL, redirects are refused, and
the process exposes no generic fetch, shell, SQL, filesystem path, telemetry,
secret retrieval/echo, or credential resource. It is a narrow client of the
same authenticated/authorized service, never another connector registry or
ingest path. Exact resources/arguments and agent-use rules are in
[AGENTS.md](AGENTS.md#optional-mcp-facade).

## Production replacement boundary

A production deployment replaces the entire reference server while retaining
compatible browser/page/ingest contracts or deliberately versioning them. The
replacement requires:

- TLS, authenticated browser sessions and service identities, CSRF protection,
  and app/resource/action authorization;
- a transactional database with migrations, unique constraints, tombstones,
  atomic state/audit changes, backups, restore tests, and multi-worker safety;
- managed secret storage/KMS with scoped runtime access, rotation, revocation,
  expiry, and secret-safe observability;
- hardened per-mode admission, rate/size/cardinality limits, backpressure,
  durable queues, retry/dead-letter policy, scheduler leases, and projector
  checkpoints/replay;
- explicit classification, redaction, retention, deletion, and legal handling
  for raw bytes, canonical records, indexes, receipts, audit, and rejection
  metadata; and
- monitoring for connection/collection health, credential expiry, admission
  failure, queue/projector lag, capacity, audit failure, and registry faults.

UI, CLI, and optional MCP tools call the same canonical authenticated command
service and receive identical authorization, validation, idempotency, revision,
and audit decisions. A production MCP facade should expose narrow list/describe,
begin/test/activate setup, enable/disable, health, and sync-now operations only
as policy permits. Do not expose raw secret entry, unrestricted deletion, raw
log streams, or a second direct registry-write path through MCP.

## Scan connector implementation guide

The Scans page is a structural catalog, not an installed scanner suite. The
checked-in reference registry ships only `canonical-push` for `log.event`; it
does not ship Trivy, Patch First, file-integrity, EOL, exposure, IOC,
urlscan.io, dependency, ClamAV, quarantine, or remediation drivers. An adopter
must install a reviewed manifest **and** implement its server-side acquisition,
normalizer, validation, health, persistence, and projector path before claiming
that a tab is connected.

Every scan connector follows the same control flow:

1. Install a manifest whose stable type, version, source kinds, configuration
   fields, credential-reference slots, output record kinds, health policy, and
   Scans target surface are reviewed together.
2. Provision any API key, token, certificate, SSH material, or cloud role
   through a write-only server/secret-manager flow. The UI stores only an opaque
   reference such as `{ store: "secret-manager", reference: "..." }`; never put
   the value in browser config, manifest data, source snapshots, command logs,
   MCP arguments, or canonical records.
3. Create the source from `/sources?stab=add` (or the equivalent authorized
   agent/CLI tool), run a non-mutating bounded test, then activate it. A
   successful test proves configuration/admission only; health stays pending
   until a real accepted observation arrives.
4. Acquire using the transport appropriate to that product, authenticate the
   stable source, normalize to a controlled record kind, validate the whole
   record, commit its receipt and records atomically, then enqueue projectors.
5. Project a redacted page model into the stable Scans tab panel IDs and any
   other declared target routes. Never scrape one rendered tab to populate
   another.
6. Track acquisition health separately from scan result state. Record last
   attempt, last accepted observation, expected next observation, bounded error
   reason, cursor/checkpoint, and stale/offline transitions.

The following recipes are adopter requirements, not claims about included
drivers.

### Trivy

- **Acquisition:** prefer signed CI/registry artifacts or an authenticated
  private webhook/push from a pinned Trivy version. For scheduled registry,
  image, filesystem, or SBOM scans, use a least-privilege worker and durable
  cursor/job identity. Do not let browser input become arbitrary image names,
  filesystem paths, registries, or command flags.
- **Configuration:** scan scope, approved target reference/pattern, schedule,
  severity threshold, scanner/database version policy, and maximum artifact
  size are non-secret. Registry credentials, private repository tokens, and
  signing material are opaque references.
- **Normalize/project:** emit controlled vulnerability/scan observations with
  stable artifact, package, advisory, severity, fixed-version, observation, and
  run identities. Project the Trivy results tab, Systems software-match/KEV
  views where authorized, and Remediation only through explicit correlation.
- **Health:** distinguish job failure, stale vulnerability database, no targets,
  completed scan with zero findings, and delayed/missing run. Zero findings is
  a ready empty result, not a broken feed.

### Patch First

- **Acquisition:** ingest a signed/exported patch posture report or query an
  approved patch-management API with a server-side worker. Treat vendor status
  fields as input; normalize against the application's patch policy and asset
  identity.
- **Configuration:** provider type, authorized tenant/project, scope, cadence,
  grace window, and platform mapping are non-secret. OAuth/API credentials and
  client certificates are references.
- **Normalize/project:** preserve stable asset/advisory/package IDs, installed
  and available versions, exploit/priority signals, due policy, and observed
  time. Project Patch first, affected Systems, Risk Register, and Remediation
  only when explicit projector rules and authorization permit the fan-out.
- **Health:** separate provider reachability, inventory coverage, data age,
  mapping failures, and zero overdue patches. Never infer patch success from a
  source test.

### File integrity

- **Acquisition:** use a least-privilege host agent or an authenticated event
  stream from an existing FIM product. A watcher should emit bounded metadata
  and approved hashes; it must not upload arbitrary file contents by default.
- **Configuration:** approved path sets, exclusions, hash algorithms, baseline
  epoch, event coalescing window, and cadence are non-secret. Agent identity,
  signing keys, and vendor API credentials are references.
- **Normalize/project:** stable host/path identities, change kind, baseline and
  observation time, approved digest, actor/process summary when policy allows,
  and correlation ID. Project the File integrity tab and optional Triage/
  Timeline signals; never render path or process text as markup.
- **Health:** distinguish watcher stopped, permission denied, overflow/lost
  events, baseline rebuilding, quiet-but-healthy, and a completed comparison
  with no changes.

### End of life

- **Acquisition:** periodically import a version-pinned vendor/platform
  lifecycle dataset, verify origin/signature or checksum, then join it to the
  authorized software inventory. Do not query public sites from the browser.
- **Configuration:** approved lifecycle publishers, product/version mapping,
  review cadence, warning horizons, and unknown-version policy are non-secret.
  Commercial-feed tokens are references.
- **Normalize/project:** publisher/product/version, support phase, announced and
  effective dates, confidence/mapping state, affected asset references, and
  source dataset version. Project End of life, affected Systems, Risk Register,
  and dated obligations where policy creates those records.
- **Health:** separately report dataset freshness, signature/parse failure,
  inventory join coverage, unmapped versions, and no EOL matches.

### External exposure and sweep history

- **Acquisition:** use an allowlisted external scanner with explicit written
  scope and safe rate/concurrency controls. Bind every job to a reviewed target
  set; block private/link-local/metadata/control-plane targets unless the job is
  expressly approved for them. Avoid arbitrary URL/host/port input.
- **Configuration:** target-set reference, ports/profile, cadence, source IP,
  concurrency, maintenance window, and evidence-retention class are non-secret.
  Scanner credentials and cloud/API keys are references.
- **Normalize/project:** stable target/service/finding and scan-run IDs,
  externally observed address/port/protocol, bounded banner summary, severity,
  first/last seen, verification state, and evidence reference. Project External
  surface, sweep history, Systems external attack surface, and authorized
  remediation correlations.
- **Health:** distinguish scan queued/running/partial/failed/completed, target
  unreachable, policy refusal, and completed with no exposure. Never treat a
  partial run as complete coverage.

### IOC scan

- **Acquisition:** run a bounded, approved match over normalized telemetry or
  endpoint inventory. Intel import and internal matching are separate jobs;
  record the exact feed/version and match window. Do not send internal data to a
  third party unless policy explicitly permits it.
- **Configuration:** allowed IOC kinds, feed/version references, time window,
  target scopes, match limits, and confidence threshold are non-secret. Paid
  feed credentials are references.
- **Normalize/project:** stable scan, indicator, observation, asset/source, match
  reason, confidence, and disposition identities. Project IOC scan, IOC Parser,
  Threat Intel, Timeline, and Triage only through bounded, redacted projectors.
- **Health:** separate feed freshness, indexing lag, skipped source coverage,
  run completion, and a completed scan with zero matches.

### urlscan.io watched and on-demand scans

- **Acquisition:** a server worker submits only policy-approved public URLs and
  polls or consumes verified callbacks. Internal, tailnet, credential-bearing,
  signed, tokenized, and customer-private URLs must be rejected or routed to an
  approved private analyzer instead. Respect provider rate and redistribution
  terms.
- **Configuration:** visibility mode, watch-list reference, cadence, safe
  submission policy, polling/backoff, and retention are non-secret. The
  urlscan.io API key is an opaque secret-manager reference.
- **Normalize/project:** stable submission/result IDs, normalized URL/domain,
  provider verdict/classification, observation time, status, bounded public
  artifact links, and error category. Project watched and on-demand urlscan.io
  surfaces and safe Threat Intel/Phishing correlations.
- **Health:** show rate-limited, pending, provider failure, policy-refused,
  expired result, and completed/no-signal states separately. A queued submission
  is not a completed verdict.

### Dependencies and SBOM

- **Acquisition:** prefer signed SBOMs and lockfile/build outputs from trusted CI
  or a read-only repository integration. Pin parser/ecosystem versions and bound
  archive/file size. Never execute package lifecycle scripts to inventory a
  dependency.
- **Configuration:** approved repositories/builds, ecosystem set, branch/release
  policy, SBOM format, cadence, and advisory publishers are non-secret. Source
  control, registry, and commercial advisory credentials are references.
- **Normalize/project:** stable project/artifact/component/purl, version,
  dependency relationship, license when in scope, advisory/fixed version,
  provenance, and observation/build identity. Project Dependencies, Trivy,
  Systems, and Remediation through explicit projector rules.
- **Health:** distinguish missing/stale SBOM, parser failure, unknown ecosystem,
  advisory feed lag, partial graph, and a complete graph with no findings.

### ClamAV / DLP Upload AV

- **Acquisition:** terminate uploads in an isolated server workflow, enforce
  type/size/count limits, stream to a least-privilege scanner with timeouts, and
  quarantine before any downstream processing. Do not scan in the browser or
  place uploaded bytes in connector control/MCP messages.
- **Configuration:** scanner socket/service reference, maximum sizes, approved
  types, timeout, signature-update policy, result retention, and fail-closed
  behavior are non-secret. Service authentication and encryption keys are
  references.
- **Normalize/project:** opaque upload/object ID, digest, bounded declared and
  detected type, engine/signature version, scan time, verdict category, and
  quarantine reference. Project DLP Upload AV/recent events; show no original
  contents or sensitive filename unless separately authorized.
- **Health:** distinguish engine unreachable, signatures stale, timeout,
  unscannable/encrypted, policy rejection, clean, and detected. Never treat an
  error as clean.

### Quarantine active/deleted ledgers

- **Acquisition/control:** quarantine is a protected object lifecycle, not just
  a scan feed. Creation, restore/release, expiry, and deletion need a separate
  authorized command service, malware-safe storage, immutable evidence/audit,
  and dual control where policy requires it. The connector can project ledger
  observations but must not grant object access.
- **Configuration:** protected store reference, encryption/KMS reference,
  retention/expiry policy, allowed object classes, approval policy, and scanner
  linkage. Store credentials and keys are references.
- **Normalize/project:** stable quarantine/object/event IDs, digest, safe object
  class, origin reference, verdict, lifecycle state, reason, actor reference,
  timestamps, and retention disposition. Project active and deleted ledgers;
  deleted means the governed object disposition, not erased audit history.
- **Health:** separate storage/scanner health, object state, policy hold, failed
  deletion, expired lease, and empty ledger.

### Remediation

- **Acquisition/control:** remediation records are governed workflow records
  created from authorized findings/reviews or the reviewed append form. They are
  not scanner output and must not be created merely because a source projected a
  vulnerability. Use a dedicated idempotent command with revision and audit.
- **Configuration:** workflow/status vocabulary, ownership/approval model,
  ticket-provider mapping, evidence-store classes, due policy, and correlation
  rules are non-secret. Ticketing credentials and evidence-store access are
  references.
- **Normalize/project:** stable remediation/finding/asset IDs, concise safe
  description, owner reference, state, due/verified times, evidence references,
  future concern, and immutable transition history. Project both the inline
  Scans Remediation tab and `#/remediation` from the same read model.
- **Health:** report command/integration health separately from each record's
  workflow state. Empty means no authorized remediation records; it never means
  scanners are connected or risk is absent.

## Opaque API-key and credential-reference workflow

Connector manifest credential slots describe **references**, not secret-entry
fields. A production UI may open a separate write-only provisioning dialog or
redirect to an adopter secret-management flow, but it should receive only safe
metadata after submission:

```text
operator enters secret into protected server flow
  -> server validates transport/session/action authorization
  -> secret manager stores/version-controls value
  -> server returns opaque store + reference + safe version/expiry metadata
  -> source.setup stores that reference
  -> driver resolves value just in time under its own least-privilege identity
```

The server must prevent readback, rotate by creating a new secret version and
then atomically rebinding or rolling the connector, revoke old material, and
audit safe metadata without values. Source snapshots may show that a required
reference is present, missing, expiring, or revoked; they must not show a value,
authorization header, signed URL, private key, or reversible encoding. An
optional MCP tool may select or bind an already authorized reference but should
not accept or return plaintext API keys.

## Validation and acceptance

Validate documents with the runtime-backed tools:

```sh
npm run validate:connector -- path/to/connector-document.json
npm run validate:connector -- --type registration --manifest path/to/manifest.json path/to/source.json
npm run validate:connector -- --type command-result --request path/to/request.json path/to/result.json
npm run validate:ingest -- path/to/record-or-batch.json
```

An adopter integration is complete only when an authorized operator can
register an app, enroll and prove a host, configure a manifest-backed source
with references, test without contaminating telemetry, activate, admit real
records through every advertised transport, and see them populate the declared
page targets. Tests must cover duplicate same-kind instances, stable IDs,
revision conflicts, lifecycle ordering, connector-provider failure, credential
redaction/rotation, source and tenant binding, body-bound replay, partial/crash
failure, stale/offline health, projector replay, capacity/backpressure,
dependency-aware removal, and the guarantee that MCP cannot become a telemetry
or plaintext-secret channel.
