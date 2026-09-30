# Bulwark Black SOC technical implementation manual

This manual is the implementation contract for engineers and automation agents
that need to turn the public, data-free Bulwark Black SOC interface into an
operational application. It explains what the repository already implements,
what the adopting stack must provide, how applications, hosts, connector
instances, and sources are registered, how telemetry becomes canonical records,
and how those records populate every screen. Section 55 describes the current
universal/custom canonical integration path, sender, received-observation views
and exact boundaries. Section 56 covers ten vendor import mappings and the
durable sender queue; section 57 covers the built-in Sentry collector, encrypted
credential onboarding, collection health and optional Slack delivery.
Sections 58 through 63 explain the guided setup center, custom sample mapping,
scoped agent connections, document intake, empty-screen help and private
deployment/recovery responsibilities.
Earlier per-screen recipes describe the richer native
integrations to build; they are not claims that every native workflow runs.

The checked-in JSON Schemas and executable validators remain authoritative when
this prose and executable behavior disagree. Treat a disagreement as a defect:
stop, identify the exact version and file, and correct either the
implementation or this manual before deployment.

Implementation status language is deliberate throughout this manual:

| Label | Meaning |
| --- | --- |
| Shipped browser contract | Checked-in, validated interface that an adopter can integrate now |
| Shipped private starter | Runnable single-tenant application with real sign-in and durable operator-created state; bounded and not a complete production SOC |
| Loopback reference behavior | Executable local example for contract testing; never a production service |
| Adopter-required production work | Capability the integrating stack must design, secure, operate, and test |
| Proposed | Recommended future boundary or vocabulary that is not shipped or callable |

## 01. Agent contract and required reading order

An implementation agent should use this manual in the following order:

1. Read sections 02 through 06 to understand the product boundary, trust
   planes, stable identities, and end-to-end sequence.
2. Read sections 07 through 16 before implementing any registration,
   lifecycle, registry, or secret-management work.
3. Read sections 17 through 24 before admitting telemetry or writing a page
   projector.
4. Read sections 25 through 31 before connecting authentication, MCP,
   production storage, or external networks.
5. Run every check in sections 32 through 34 before calling an integration
   complete.
6. Read sections 37 through 54 before deploying privately, enabling agent or
   governance administration, connecting a scanner, or operating any route.
7. Read sections 55 through 57 for the currently shipped integration registry,
   import tooling and live-monitoring workflow before proposing new plumbing.
8. Read sections 58 through 63 for resumable application setup, read-only
   diagnostics, custom field mapping, agent connection assistance, document
   intake, empty-screen explanations, and private operating responsibilities.

**Non-negotiable invariants**

- Never put operational records, customer identifiers, real infrastructure
  names, credentials, tokens, cookies, provider claims, or private endpoints in
  the public repository.
- Never infer authorization from browser state. The server authorizes the
  current identity, application or estate, resource, field, and action.
- Never use MCP as a telemetry transport or a second registry database.
- Never expose the console or its BFF/control/ingest surfaces through public
  Internet ingress or public DNS; prefer loopback or an ACL-restricted tailnet.
- Never put plaintext credentials in a connector manifest, source
  registration, command snapshot, page envelope, canonical record, audit
  message, URL, or browser storage.
- Never derive source identity from a host name and source kind. Multiple
  connector instances and multiple same-kind sources on one host are valid.
- Never scrape rendered HTML to produce detections, analytics, or downstream
  state. Consumers read canonical records or server-owned projections.
- Never acknowledge an ingest batch before the deployment's documented durable
  boundary.
- Never silently add fields to a closed version-1 document. Version the
  contract or keep the field in a server-private model.

**Agent entry points**

| Purpose | Authoritative file |
| --- | --- |
| In-app and raw technical manual | public/technical-reference.md |
| Focused agent entry point | docs/AGENTS.md |
| Browser connector runtime | public/connector-contract.js |
| Connector manifest schema | contracts/connector-manifest.v1.schema.json |
| Source registration schema | contracts/source-registration.v1.schema.json |
| Canonical record schema | contracts/normalized-record.v1.schema.json |
| Ingest batch schema | contracts/ingest-batch.v1.schema.json |
| Page envelope schema | contracts/page-model.v1.schema.json |
| Canonical ingest validator | tools/ingest-contract.js |
| Reference manifest | server/reference-manifest.js |
| Reference lifecycle runtime | server/reference-runtime.js |
| Reference page projectors | server/reference-pages.js |
| Reference persistence | server/reference-store.js |
| Reference HTTP boundary | server/reference-control-plane.js |
| Administration runtime | public/administration-contract.js |
| Administration schema | contracts/administration.v1.schema.json |
| Reference administration modules | server/reference-administration-runtime.js and server/reference-administration-store.js |
| Private application host | server/private-application.js |
| Private authentication and account CLI | server/private-auth.js and tools/private-account.js |
| Versioned document storage | server/document-store.js |
| Private indexed telemetry | server/sqlite-telemetry-store.js |
| Scoped service access | server/service-access.js and public/service-access.js |
| Trivy report import and projection | server/scanner-ingest.js and server/scanner-pages.js |

When an agent changes a contract, it must update the executable validator, JSON
Schema, this manual, any narrower UI constraint, provider examples, and tests in
the same change.

## 02. What the repository implements and what it deliberately omits

The repository implements a data-free product shell and version-1 integration
boundaries. It includes:

- the complete structural route and panel catalog;
- the active Bulwark Black product styling and assets;
- a closed page-provider contract for authorized read models;
- a closed authentication projection and provider boundary, plus a runnable
  private Better Auth/SQLite service with locally provisioned operators;
- a SQLite document library with immutable file versions, checksums, metadata,
  review status, history, and archive/restore;
- a closed connector manifest, source, health, command, snapshot, and provider
  contract;
- a closed, domain-separated agent/governance administration contract and
  local reference runtime/store modules;
- a narrow stdio reference MCP exposing public documentation/contracts and seven
  fixed connector/administration/setup tools with credential-issuing commands
  refused;
- JSON Schemas and command-line validators;
- UI workflows for application registration, host enrollment, source setup,
  source testing, activation, update, pause/resume, archive/remove, and
  credential revoke/rotate;
- a loopback-only reference control plane;
- hashed one-time host and source credentials in reference mode;
- bounded canonical log, universal canonical-event and Trivy report admission,
  with human-installed immutable custom definitions and ten vendor mappings;
- one supervised Sentry Cloud collector with guided secret onboarding,
  durable checkpoints, verified quiet-poll health, local alerts and optional Slack;
- resumable application/source setup and read-only local evidence checks,
  including optional scoped service/MCP access to those same setup reads;
- bounded custom JSON/NDJSON field mapping with offline recipe reuse, plus
  guided agent credentials/configuration, document-link pickers, empty-screen
  explanations and private operations guidance;
- local persistence, audit intent and completion records, idempotent receipts,
  record deduplication, and several page projectors; and
- tests for the public boundary and the complete reference lifecycle.

The repository does **not** provide the following production systems:

- multi-tenant, per-resource operator roles, enforced MFA policy, passkeys, SMTP recovery, or
  configured enterprise SSO; all private starter operators have full access;
- an executable connector-package marketplace; the private Integrations UI
  installs only reviewed, data-only canonical declarations (section 55);
- general vendor acquisition, webhook signature receivers, OTLP/syslog listeners,
  or a deployable host agent; Sentry Cloud is the narrow built-in poller (57);
- a general-purpose managed secret vault; the Sentry/Slack workflow has its own
  write-only encrypted credential input, not arbitrary driver secret resolution;
- a distributed high-volume telemetry/queue system or multi-process collector
  coordination; indexed SQLite, the external sender outbox (56) and the bounded
  live-monitoring recovery/delivery journal (57) are shipped local implementations;
- projectors for every canonical record kind and every screen;
- a production MCP server;
- automatically configured Tailnet TLS/ACLs, managed observability, automated
  backups, retention deletion, or disaster recovery; or
- connector package installation, reinstall, upgrade, rollback, or sync-now
  commands in the browser command vocabulary.

The current UI can create applications, hosts, connector instances, and sources
only from connector types already installed in the server-owned manifest
registry. The private registry has fourteen built-ins (three admission drivers
and eleven non-executing scan templates), plus up to 86 installed custom
canonical definitions. Vendor presets occupy normal custom slots. Section 55
documents the implemented catalog; section 10 also discusses the unshipped
executable-package lifecycle. Do not imply that the
current browser can download or execute an arbitrary third-party connector.

There are 40 registered paths: the original 38 SOC routes plus Documents and
Technical Docs. Of the 39 non-docs routes, 30 are primary and nine are linked
details. The private service populates five canonical-log read surfaces plus
its source, agent/governance, and document management workflows. Other screens
remain structural until their real record producers and projectors are built.
See section 48 for the capability matrix and sections 49–52 for setup,
documents, web-app sources, and remaining performance/parity work.

## 03. Architecture and trust planes

Keep the control, telemetry, and presentation planes separate:

~~~text
operator UI ----\
CLI -------------+--> authenticated control service
optional MCP ----/       | registry, commands, revisions, audit
                          |
                          +--> server-owned connector drivers

push endpoint ----\
signed webhook ----\
pull worker --------+--> telemetry admission --> canonical record store
OTLP receiver ------/                              |
syslog receiver ---/                               +--> detection and analytics
host agent --------/                               |
                                                     +--> idempotent projectors
                                                               |
                                                               +--> page provider
                                                                        |
                                                                        +--> SOC UI
~~~

**Control plane**

The control service owns connector manifests, application and host records,
connector instances, source lifecycle, credential references, revisions,
authorization, and audit. UI, CLI, and optional MCP clients call this same
service. They must not write the registry directly.

**Telemetry plane**

Receivers and workers authenticate a source, preserve bounded raw bytes long
enough to verify the transport, normalize vendor data, validate canonical
records, enforce scope, deduplicate, persist, and acknowledge. Telemetry does
not travel through page envelopes or MCP tool results.

**Presentation plane**

Projectors build bounded read models for stable route and panel identifiers.
The browser receives only authorized page envelopes. It does not receive
database handles, provider credentials, raw secret material, or unrestricted
query access.

**Secret plane**

Secret creation and rotation are write-only server operations. Connector
registrations contain only an opaque store plus reference identifier. Drivers
resolve a reference at execution time under least privilege. Secret values
never return through a control snapshot.

## 04. Stable identities and ownership model

Version 1 uses four primary opaque identities:

| Identity | Owner and purpose |
| --- | --- |
| appId | Server-issued identity for one registered application boundary |
| hostId | Server-issued identity for a declared host owned by exactly one app |
| connectorInstanceId | Server-issued identity for one configured instance of an installed connector type |
| sourceId | Server-issued identity for one independently testable, activatable, and observable source |

The relationship is:

~~~text
app
  +-- one or more declared environments
  +-- zero or more declared hosts
  +-- zero or more connector instances
          +-- one or more independently identified sources
~~~

The current reference slice creates one source per connector instance, but the
identity model does not require that limitation in a future version.

**Identity rules**

- IDs are immutable and opaque. Display names are mutable presentation values.
- A host belongs to one app. A source and its connector instance must belong to
  the same app.
- A host-scoped connector source must reference a host owned by that app.
- A source selects an environment declared by its app. The default environment
  is `default`; environment is a source configuration selector, not a tenant
  isolation boundary or a mandatory host.
- sourceId and connectorInstanceId must be different values.
- IDs use 1 through 128 characters and the contract identifier alphabet.
- Names, URLs, kinds, or provider event content must not be used as database
  primary keys.
- Deduplication is source-scoped. The same provider event identifier from two
  sources is not automatically the same record.
- In the reference implementation, canonical estateId must equal the source
  appId. A production multi-tenant model may add a tenant or estate above appId
  only through a versioned extension.

**Revision rules**

Every mutable registry resource has a non-negative integer revision. Test and
activate commands carry expectedRevision. A stale revision fails with
revision-conflict; the client refreshes the snapshot, reassesses state, and
retries with a new request identifier when appropriate.

Administration commands carry the exact current **administration registry
revision** on every request, including creates. This is intentionally different
from connector test/activate entity revision semantics. Refresh the matching
domain snapshot after a conflict and never substitute a row's displayed
revision for the current administration registry revision.

## 05. Repository map and extension points

| Area | Responsibility | Adopter action |
| --- | --- | --- |
| public/ui-catalog.js | Stable routes, tabs, panels, fields, labels | Preserve IDs; add versioned structure deliberately |
| public/app.js | Safe DOM renderer and UI lifecycle bindings | Mount through the documented adapter boundaries |
| public/app-config.js | Public, non-secret bootstrap configuration | Set application mode and provider global names before load |
| public/adapter-contract.js | Page request, envelope, panel, and provider validation | Wrap the application read service |
| public/auth-contract.js | Closed session projection and login/logout provider | Bridge Better Auth or another server session |
| public/connector-contract.js | Connector manifests, sources, commands, snapshots | Validate all control documents at trust boundaries |
| public/administration-contract.js | Agent/governance snapshots, prompt reads, and closed lifecycle commands | Wrap one authenticated administration service |
| public/application-bridge.js | Empty application-owned integration seam | Replace or precede with reviewed provider installation |
| public/technical-reference.md | Human- and agent-readable source for this manual | Edit this file when contracts, workflows, or production guidance change |
| public/technical-docs.js | Generated frozen browser copy of the manual | Never hand-edit; regenerate with npm run build:docs |
| contracts | Portable JSON Schemas | Validate non-JavaScript producers and generated documents |
| tools/build-technical-docs.js | Manual validator and deterministic browser-artifact generator | Run build:docs after editing the Markdown and check:docs in verification |
| tools | Local validators, public audit, local static server | Include in developer and release checks |
| tools/agent-mcp.js | Narrow stdio documentation/control client with private service authentication | Configure an owner-only token file and least-privilege scopes; tokenless mode is loopback workbench-only |
| server/reference-manifest.js | Canonical log and Trivy import manifests plus eleven data-only templates | Use shipped importers or implement reviewed drivers for templates |
| server/reference-runtime.js | Shared source lifecycle and ingest behavior | Private host injects indexed storage and installed driver policy; the reference host remains disposable |
| server/reference-store.js | Single-process bounded local state | Replace with transactional durable storage |
| server/reference-pages.js | Canonical log and registry projections | Add production projectors per kind and screen |
| server/reference-control-plane.js | Loopback HTTP workbench | Replace entirely in production |
| server/private-application.js | Authenticated private starter wrapping current services | Keep loopback listener; configure exact Tailnet HTTPS origin for sharing |
| server/private-auth.js | Better Auth and SQLite sessions, private secret, local operator operations | Protect and back up the external state directory |
| server/document-store.js | Immutable document versions and audited lifecycle in SQLite | Honor quotas, backup/integrity, and untrusted-file limits |
| server/sqlite-telemetry-store.js | Private indexed admission, replay, audit, retention and bounded queries | Preserve pinned policy, migration inputs and backups; measure real workload capacity |
| server/service-access.js | Scoped service identity and fixed private machine endpoints | Issue only needed installation-wide scopes and rotate/revoke deliberately |
| server/scanner-ingest.js and server/scanner-pages.js | Trivy JSON normalization and scan projection | Supply an approved bounded report from your scanner; do not imply scan execution |
| server/reference-administration-runtime.js and store.js | Local agent/governance lifecycle and owner-only persistence modules | Exercise the contract locally; replace for production |
| examples | Provider and authentication integration examples | Copy into the adopter application and pin dependencies |

Do not place adopter-only secrets, hostnames, deployment paths, customer data,
or private configuration in any public file.

## 06. End-to-end implementation sequence

Implement in this order so later layers depend on validated earlier layers:

1. **Choose the application boundary.** Define app or estate ownership and the
   authorization model.
2. **Establish authentication.** Use the shipped private service for one
   all-operator deployment, or add the custom resource/tenant roles required by
   the adopting stack. Sections 48–49 give the runnable path.
3. **Create the manifest registry.** Accept only reviewed, signed or
   administrator-approved connector packages from a controlled source.
4. **Implement the control database.** Persist apps, hosts, manifests,
   instances, sources, commands, revisions, changes, and audit atomically.
5. **Implement secret references.** Provision values through a write-only
   server flow and persist only references in connector documents.
6. **Expose the connector provider.** Map getSnapshot and execute to the
   authenticated control service and validate both directions.
7. **Implement each driver or receiver.** Bind it to one installed manifest,
   connector instance, and active source.
8. **Implement canonical normalization.** Produce only the controlled record
   kinds and exact payload fields.
9. **Implement durable admission.** Authenticate, validate, deduplicate,
   transact, enqueue, and acknowledge.
10. **Implement projectors.** Map canonical records to stable page panel IDs.
11. **Expose the page provider.** Return authorized, bounded page envelopes.
12. **Connect Better Auth or the selected identity system.**
13. **Implement administration.** Persist agent/prompt/enrollment and
    attestation/risk domains with protected prompt bodies, global registry
    revision, lifecycle/audit/tombstones, and the validated provider.
14. **Optionally expose MCP.** Mirror narrow control operations after the
    canonical service is secure; never create another source of truth.
15. **Run abuse, replay, authorization, failure, restore, and upgrade tests.**

The UI can be integrated before every vendor connector exists. It remains
honestly empty for record kinds and panels that have no installed source and
projector.

## 07. Operator workflow in the application

The visible source workflow uses Onboarding and Sources; Agent Management,
Attestations, and Risk Register use the independent administration provider.

**Onboarding**

Open Technical Docs from the top-bar **Docs** link or the **Utilities** group in
the compact route chooser when implementation guidance is needed. Open
Onboarding through the estate picker or the route chooser to register an
application:

1. Enter the application display name.
2. Select the application's environments; host display labels are optional.
3. Optionally enter public HTTPS pages separated by commas. This is not
   permission for a scan and does not create a scanner.
4. Submit Register app.
5. Record the returned appId and the server-issued hostIds from the refreshed
   registry.

The UI has convenience limits that may be narrower than the portable contract.
The server contract remains authoritative and must enforce its own bounds.

**Sources**

For guided Sentry Cloud collection, open Sources → Live monitoring and follow
chapter 57. For supplied vendor exports, use Vendor imports and chapter 56.
Application-scoped integrations need an app/environment but no enrolled host;
follow the installed manifest's scope and the setup path in chapter 55.

For a host-scoped connector, open Sources, then Add a source:

1. Select the owning app and host.
2. Select Mint token to enroll the host.
3. Store the one-time connection-check value on the intended host immediately.
4. Have that host submit the connection-check document within the replay and
   expiry windows.
5. Refresh the registry until the host connection state is proven.
6. Select the installed connector type and one of its manifest-owned source
   kinds.
7. Enter a display label and manifest-generated configuration.
8. Enter only credential references for declared credential slots.
9. Begin source setup.
10. Run Test after the host proof is current.
11. Activate only after the test succeeds.
12. Store the one-time source-ingest value on the intended sender.
13. Send the first real batch. Activation alone leaves health pending.

The Expected sources tab displays collection and activity health. Registry
changes displays safe lifecycle events. Neither screen is a secret store.

**Agent Management**

Open Agent Management under Estate. Refresh the agents-domain snapshot, add an
agent with reviewed kind/provider/model/capabilities, create a prompt revision,
review its separately retrieved body, activate it, then issue a short-lived
enrollment. Store the one-time output only on the intended agent and complete
the private connection proof. Use Pause/Resume for operation and Archive before
Remove. Every command carries a new request ID and the current administration
registry revision; refresh on conflict. History shows safe changes, not prompt
bodies or credentials.

**Attestations and Risk Register**

Open the Create tab, submit the bounded version-1 fields, and use the matching
record/detail lifecycle controls. Transitions are server-enforced. Archived
records remain in their tab and must be restored before editing; the loopback
reference requires archive before removal and retains a tombstone. Production
adds evidence, approvals, dependency, retention, and authorization policy
without silently changing the closed browser documents.

## 08. Browser connector provider interface

The browser resolves the configured connector provider global and validates this
closed interface:

~~~js
{
  schemaVersion: "1",
  id: "application-connectors",
  getSnapshot(request) { /* returns a Promise */ },
  execute(request) { /* returns a Promise */ },
  dispose() { /* optional */ }
}
~~~

getSnapshot accepts:

~~~json
{
  "schemaVersion": "1",
  "reason": "initial",
  "knownRevision": 12
}
~~~

reason is initial, refresh, or command. knownRevision is optional and does not
authorize the request. The server still resolves the current session and
allowed app scope.

execute accepts one connector-command-request and returns the correlated
connector-command-result. The wrapper validates input before calling the
adopter provider and validates output before the UI sees it.

**Provider requirements**

- Use same-origin requests unless a separately reviewed architecture requires
  another origin.
- Include CSRF protection for cookie-authenticated mutations.
- Do not accept caller-supplied authorization scope.
- Correlate requestId and command exactly.
- Return a fresh server snapshot after success; do not let the browser invent
  optimistic registry state.
- Convert internal errors to one controlled error code and a bounded,
  non-sensitive message.
- Abort or ignore stale browser responses when navigation or refresh supersedes
  them.
- dispose must release only provider-owned browser resources; it does not
  disable server sources.

The page provider's runCommands capability does not activate connector
lifecycle controls. Only a validated connector provider does.

## 09. Connector manifest version 1 field reference

A connector manifest is reviewed data describing an installed server-owned
driver. It is not executable browser code.

| Field | Required rule |
| --- | --- |
| schemaVersion | Exact string 1 |
| documentType | Exact string connector-manifest |
| connectorType | Stable type identifier |
| connectorVersion | Reviewed version identifier |
| displayName | Human label, at most 120 characters |
| description | Optional bounded explanation |
| scope | application, host, or service |
| supportedSourceKinds | One through 32 manifest-owned kinds |
| payload.schemaId | Pinned canonical or vendor-normalization schema identity |
| payload.schemaVersion | Pinned schema version |
| payload.recordKinds | One or more of the 29 canonical kinds |
| payload.lines | required, optional, or forbidden |
| payload.content | required, optional, or forbidden |
| targets | One through 64 unique routes |
| targets[].surfaces | One through 32 stable panel IDs on that route |
| targets[].recordKinds | Subset of payload.recordKinds |
| configFields | Zero through 40 non-secret declarations |
| credentialSlots | Zero through 32 credential-reference declarations |
| healthPolicy | Delivery mode and ordered expected, stale, and offline bounds |

Configuration value types are string, integer, number, boolean,
duration-seconds, endpoint-url, and enum. Numeric fields may declare minimum and
maximum. Enum fields declare unique value and label pairs. Endpoint URLs must
be absolute HTTP or HTTPS URLs with no embedded credentials, query, or
fragment.

Credential kinds are api-key, bearer-token, basic-auth, certificate,
oauth-client, service-account, ssh-key, and custom. A slot declares what the
driver needs, not the value.

Health policy must satisfy:

~~~text
expectedIntervalSeconds <= staleAfterSeconds <= offlineAfterSeconds
~~~

Example preinstalled manifest:

~~~json
{
  "schemaVersion": "1",
  "documentType": "connector-manifest",
  "connectorType": "canonical-push",
  "connectorVersion": "1.0.0",
  "displayName": "Canonical log push",
  "description": "Admission for normalized log events.",
  "scope": "host",
  "supportedSourceKinds": ["log.event"],
  "payload": {
    "schemaId": "normalized-record.log-event",
    "schemaVersion": "1",
    "recordKinds": ["log.event"],
    "lines": "forbidden",
    "content": "required"
  },
  "targets": [
    {
      "route": "/",
      "surfaces": ["summary-metrics", "detections"],
      "recordKinds": ["log.event"]
    },
    {
      "route": "/sources",
      "surfaces": ["expected-sources"],
      "recordKinds": ["log.event"]
    },
    {
      "route": "/logs",
      "surfaces": ["log-results"],
      "recordKinds": ["log.event"]
    },
    {
      "route": "/analytics",
      "surfaces": ["summary-metrics", "events-collected-per-hour"],
      "recordKinds": ["log.event"]
    },
    {
      "route": "/health",
      "surfaces": ["summary-metrics", "is-the-collection-working"],
      "recordKinds": ["log.event"]
    }
  ],
  "configFields": [
    {
      "key": "cadence-seconds",
      "label": "Expected delivery cadence",
      "valueType": "duration-seconds",
      "required": true,
      "minimum": 60,
      "maximum": 31536000
    }
  ],
  "credentialSlots": [],
  "healthPolicy": {
    "deliveryMode": "push",
    "expectedIntervalSeconds": 300,
    "staleAfterSeconds": 450,
    "offlineAfterSeconds": 900,
    "emptyPayloadIsHealthy": false
  }
}
~~~

Manifests must not contain HTML, callbacks, scripts, shell commands, secret
values, arbitrary form actions, token endpoints selected by untrusted input, or
unreviewed projector identifiers.

## 10. Installing connector types and building a connector catalog

The private application ships a human-only Integrations UI for immutable,
data-only canonical declarations; see section 55 for the exact installation API.
The separate reference workbench retains its fixed registry. Neither downloads
or executes an arbitrary connector package. The following is a proposed
administrator-controlled lifecycle for executable packages, not a prerequisite
to using the shipped registry, importers or Sentry live-monitoring workflow.

Recommended installation sequence:

1. Acquire a connector package from a controlled registry or repository.
2. Verify publisher identity, package signature or digest, provenance, license,
   supported application versions, and dependency policy.
3. Extract into an isolated review area with archive traversal and size limits.
4. Validate the manifest with both the JSON Schema and executable validator.
5. Confirm every target route and surface exists in the exact UI catalog
   version.
6. Confirm every declared record kind has a complete normalizer and projector.
7. Review the driver for network destinations, redirect behavior, proxy use,
   TLS validation, credential access, subprocess use, file access, rate limits,
   and data classification.
8. Run contract, malicious-input, replay, timeout, pagination, rate-limit, and
   upgrade tests.
9. Install the manifest and driver as one atomic, versioned registry operation.
10. Record publisher, version, compatibility, review evidence, installer
    identity, timestamp, and rollback target in protected audit.
11. Make the connector type selectable only after the server marks that exact
    version available.

Recommended additional production operations include describe, install,
upgrade, rollback, disable, uninstall, and compatibility-check. These are
administrator operations, not source lifecycle operations. Do not accept
arbitrary manifest JSON from a normal source-setup user and immediately execute
code described by it.

For a built-in deployment, connector installation may be a reviewed source
change plus application deployment. For a plugin registry, use signed immutable
packages, isolated drivers, explicit capabilities, and an allowlisted egress
policy.

## 11. Command envelope and idempotency rules

Every command request has exactly:

~~~json
{
  "schemaVersion": "1",
  "documentType": "connector-command-request",
  "requestId": "req-register-0001",
  "command": "app.register",
  "requestedAt": "2030-01-02T03:04:05Z",
  "input": {}
}
~~~

The command is one of app.register, host.enroll, source.setup, source.test,
source.activate, source.update, source.pause, source.resume, source.archive,
source.remove, source.revoke, or source.rotate. Input is command-specific and
closed; section 51 gives the additional lifecycle transitions.

Every result has the same requestId and command, a completedAt timestamp, and
one status: succeeded, failed, rejected, or conflict. A succeeded result has
output and no error. Every other status has error and no output.

~~~json
{
  "schemaVersion": "1",
  "documentType": "connector-command-result",
  "requestId": "req-register-0001",
  "command": "app.register",
  "status": "succeeded",
  "completedAt": "2030-01-02T03:04:06Z",
  "output": {
    "appId": "app-0001",
    "state": "registered"
  }
}
~~~

~~~json
{
  "schemaVersion": "1",
  "documentType": "connector-command-result",
  "requestId": "req-source-test-0001",
  "command": "source.test",
  "status": "conflict",
  "completedAt": "2030-01-02T03:06:31Z",
  "error": {
    "code": "revision-conflict",
    "message": "Source revision changed; refresh and retry.",
    "retryable": true
  }
}
~~~

Error codes are:

- validation-failed
- not-authorized
- not-found
- already-exists
- revision-conflict
- credential-reference-unavailable
- connector-unavailable
- provider-unavailable
- test-failed
- activation-blocked
- internal-error

An error contains code, a bounded safe message, optional normalized field path,
and retryable. Internal stack traces, SQL errors, provider response bodies,
credential material, and policy internals stay server-side.

**Idempotency**

- The server binds requestId to the canonical command body and actor scope.
- Exact replay returns the prior safe result.
- Reuse with different content returns a conflict.
- An HTTP retry does not create a second app, host enrollment, instance, source,
  or credential.
- One-time credential output needs special care: a production server normally
  cannot redisplay it on replay. Return an operation receipt and require an
  explicit rotate or re-enroll action instead of persisting plaintext output.

## 12. Application registration

app.register input contains:

| Field | Rule |
| --- | --- |
| displayName | Non-empty text, at most 120 characters |
| hosts | Optional; zero through 64 unique host labels or identifiers |
| environments | Optional; one through 32 unique normalized identifiers, default `["default"]` |
| publicPages | Zero through 64 unique absolute HTTPS URLs |

~~~json
{
  "schemaVersion": "1",
  "documentType": "connector-command-request",
  "requestId": "req-register-0001",
  "command": "app.register",
  "requestedAt": "2030-01-02T03:04:05Z",
  "input": {
    "displayName": "Example application",
    "hosts": ["web-01", "worker-01"],
    "publicPages": ["https://status.example.invalid/"]
  }
}
~~~

A successful result contains the new appId and state registered. The next
snapshot contains the app and every server-issued hostId.

The production server must:

- authorize application creation for the current tenant or estate;
- normalize and compare host display labels according to documented rules;
- prevent cross-tenant collisions where required;
- validate public URLs against SSRF and ownership policy before any later
  scanner uses them;
- create the app and declared hosts atomically;
- start hosts in pending enrollment and unknown connection state; and
- write safe app.registered changes and protected audit.

Registration does not install software, prove host possession, activate a
source, or make a public page safe to scan.

## 13. Host enrollment and connection proof

host.enroll input contains existing owning appId and hostId. The server checks
ownership and issues a short-lived host-bound connection-check value once.

~~~json
{
  "schemaVersion": "1",
  "documentType": "connector-command-request",
  "requestId": "req-enroll-0001",
  "command": "host.enroll",
  "requestedAt": "2030-01-02T03:05:00Z",
  "input": {
    "appId": "app-0001",
    "hostId": "host-0001"
  }
}
~~~

The intended host submits:

~~~json
{
  "schemaVersion": "1",
  "documentType": "connection-check",
  "appId": "app-0001",
  "hostId": "host-0001",
  "observedAt": "2030-01-02T03:05:30Z",
  "nonce": "connection-0001"
}
~~~

The reference transport uses an Enrollment authorization scheme. The credential
is a transport property and is not placed in the JSON document.

Required production behavior:

- hash or otherwise one-way protect a short-lived one-time value at rest;
- bind it to appId, hostId, purpose, issuer operation, expiration, and
  revocation state;
- compare presented proof without timing leaks;
- enforce strict RFC 3339 timestamps and a small replay window;
- consume the value atomically with the accepted proof;
- reject expired, consumed, revoked, wrong-host, wrong-app, or wrong-purpose
  values;
- record safe proof metadata without recording the value; and
- age the host connection state independently of source collection health.

Host proof establishes possession of the enrollment path. It does not prove
that a vendor API is reachable or that telemetry is arriving.

## 14. Source setup, test, and activation

source.setup input contains appId, optional hostId, optional environment, connectorType, sourceKind,
displayName, non-secret config, and credentialReferences.

~~~json
{
  "schemaVersion": "1",
  "documentType": "connector-command-request",
  "requestId": "req-source-0001",
  "command": "source.setup",
  "requestedAt": "2030-01-02T03:06:00Z",
  "input": {
    "appId": "app-0001",
    "hostId": "host-0001",
    "connectorType": "canonical-push",
    "sourceKind": "log.event",
    "displayName": "Primary application log",
    "config": {
      "cadence-seconds": 300
    },
    "credentialReferences": []
  }
}
~~~

The server validates the exact installed manifest version, ownership, scope,
source kind, every configuration key and value, and every required credential
slot. It creates independent sourceId and connectorInstanceId values in
configured state.

source.test input contains sourceId, connectorInstanceId, expectedRevision, and
an optional sample object. Hostless canonical-push requires sample.message
(1–2,000 characters); optional channel is at most 120 characters and severity
is critical, high, medium, low, info, or unknown. The sample is shape-checked,
not persisted as telemetry, and does not make source health healthy.
A production test is server-side and bounded. Depending on the connector it may
resolve credential references, validate permissions, inspect a schema, perform
a narrow health call, or verify local receiver configuration. It must not
create placeholder telemetry or mark collection healthy.

~~~json
{
  "schemaVersion": "1",
  "documentType": "connector-command-request",
  "requestId": "req-source-test-0001",
  "command": "source.test",
  "requestedAt": "2030-01-02T03:06:30Z",
  "input": {
    "sourceId": "source-0001",
    "connectorInstanceId": "connector-0001",
    "expectedRevision": 1
  }
}
~~~

source.activate uses the same identity and revision input. It succeeds only
from tested state and pins the active connector version and configuration. A
push source may receive a source-bound ingest identity once. A pull source may
be scheduled. Health remains pending with awaiting-first-delivery until a real
admission succeeds.

~~~json
{
  "schemaVersion": "1",
  "documentType": "connector-command-request",
  "requestId": "req-source-activate-0001",
  "command": "source.activate",
  "requestedAt": "2030-01-02T03:07:00Z",
  "input": {
    "sourceId": "source-0001",
    "connectorInstanceId": "connector-0001",
    "expectedRevision": 2
  }
}
~~~

The revision numbers above are illustrative, not values to guess. Read the
configured source revision before test, then use the tested source revision
returned by the refreshed snapshot before activation. A revision conflict
means another operation won; refresh and reassess instead of incrementing a
number locally.

State sequence:

~~~text
draft -> configured -> tested -> active <-> paused
             |            |        |          |
             +------------+--------+----------+--> archived -> removed
~~~

The expanded version-1 contract also exposes paused, archived, and removed
states and the lifecycle commands in section 51. Source update invalidates old
testing/credentials and requires retest/activation. Removed is a retained
tombstone, not deletion of admitted evidence. Resync and connector-package
upgrade/rollback remain unimplemented.

## 15. Control snapshot and registry invariants

A connector-control-snapshot contains:

- installed connectorTypes;
- apps;
- hosts;
- connectorInstances;
- setups in draft, configured, or tested state;
- sources in active, disabled, paused, archived, or removed state;
- recent safe changes; and
- a monotonically increasing registry revision.

Validation enforces:

- unique connectorType values;
- unique appId, hostId, connectorInstanceId, sourceId, and changeId values in
  their scopes;
- every host is declared by and owned by its app;
- every connector instance references an installed manifest and existing app;
- every source references an existing instance of the same app and connector
  type;
- an optional source host belongs to the same app;
- setup and active collections contain only allowed lifecycle states;
- config and credential references satisfy the installed manifest; and
- one-time credential values are absent.

Snapshots are presentation-safe registry views, not database backups. They
should be scoped to the authenticated operator, paginated or bounded in large
deployments, and protected against enumeration across tenants.

Changes contain changeId, resourceType, resourceId, action, status, timestamp,
and optional safe message. Protected audit should additionally retain actor,
authorization decision, correlation, before and after revision, and operation
evidence according to policy.

## 16. Credentials, references, rotation, and revocation

Connector documents accept references shaped by slot, store, and referenceId.
Supported store labels are environment, host-managed, secret-manager, and
vault. These labels describe resolution policy; they do not grant access.

Recommended write-only provisioning:

1. The authorized operator chooses a manifest credential slot.
2. The browser sends the value to a dedicated same-origin server endpoint over
   TLS.
3. The server validates size and type without logging the body.
4. The server writes the value directly to the managed secret backend.
5. The server returns only an opaque referenceId.
6. source.setup includes that reference.
7. The driver identity resolves only the exact allowed reference at execution
   time.
8. Rotation creates a new secret version, tests it, atomically switches the
   active reference, and revokes the old version after a controlled overlap.

Never place a secret value in:

- SOC_CONSOLE_PUBLIC_CONFIG;
- connector manifest configFields;
- credentialReferences.referenceId when the backend URI itself embeds a value;
- command request logs;
- control snapshots;
- canonical records or fields;
- page envelopes;
- query strings;
- MCP arguments or results;
- browser storage;
- source-control history; or
- crash reports and metrics labels.

Production secret metadata should include purpose, owner scope, backend,
created and rotated times, expiry, status, and last successful use without
revealing the value.

## 17. Canonical normalized record version 1

Every admitted record has exactly:

| Field | Rule |
| --- | --- |
| schemaVersion | Exact string 1 |
| documentType | Exact string normalized-record |
| recordId | Stable source-scoped deduplication identity |
| sourceId | Authenticated active source identity |
| estateId | Authorized application or estate scope |
| kind | One controlled canonical kind |
| observedAt | Strict RFC 3339 producer observation timestamp |
| payload | Closed, kind-aware bounded payload |

Every payload requires title and state. state is open, closed, active,
inactive, ok, warn, failed, or unknown.

Optional common fields include severity, assetRef, identityRef, ruleRef,
findingRef, indicatorType, indicator, message, summary, channel, category,
count, startedAt, completedAt, dueAt, and fields.

Severity is critical, high, medium, low, info, or unknown. indicatorType is ip,
domain, url, hash, email, or other. count is a non-negative safe integer.
fields is a bounded scalar-only map: no arrays, nested objects, markup, or
secret-bearing key names.

~~~json
{
  "schemaVersion": "1",
  "documentType": "normalized-record",
  "recordId": "event-0000000001",
  "sourceId": "source-0001",
  "estateId": "app-0001",
  "kind": "log.event",
  "observedAt": "2030-01-02T03:07:00Z",
  "payload": {
    "title": "Application request completed",
    "state": "ok",
    "message": "HTTP request completed",
    "channel": "application",
    "fields": {
      "status_code": 200,
      "duration_ms": 18
    }
  }
}
~~~

Canonical records are not arbitrary JSON. Put vendor-specific bounded scalar
facts in fields only when a named canonical field is not appropriate. Promote
frequently used semantics through a versioned schema change rather than
teaching each projector a private field convention.

## 18. Canonical record kind matrix

The required payload fields for every version-1 kind are:

| Kind | Additional required payload fields | Primary consumers |
| --- | --- | --- |
| alert.delivery | findingRef | Alert communications, triage, audit |
| asset.snapshot | assetRef | Systems, known assets, exposure |
| audit.event | category | Access, refusals, evidence integrity, registry history |
| authentication.event | identityRef | Access, activity, timeline, detections |
| backup.status | assetRef | Backups, health, daily brief |
| case.record | findingRef | Triage, event detail, daily brief |
| compliance.record | category | Attestations, risk register, brief |
| database.schema | assetRef | Databases, change timeline |
| endpoint.event | assetRef | Logs, activity, timeline, detections |
| evidence.receipt | category | Evidence integrity, event detail, attestations |
| file.integrity | assetRef and category | Scans, honeypots, triage |
| finding | severity | Overview, triage, event detail, analytics |
| governance.attestation | category | Attestations, risk register |
| governance.risk | category | Risk register, overview, obligations |
| honeypot.event | assetRef | Honeypots, triage, timeline |
| identity.access | identityRef | Access, offboarding, activity |
| intel.indicator | indicatorType and indicator | Threat Intel, IOC, Known IPs |
| intel.sync | category | Threat Intel source status, health |
| log.event | message | Logs, overview, analytics, timeline |
| network.event | category | Logs, analytics, known IPs, detections |
| offboarding.record | identityRef | Access offboarding |
| phishing.report | findingRef | Phishing, triage, event detail |
| remediation.record | findingRef | Remediation, scans, attestations |
| retention.snapshot | category | Retention, health, analyst review |
| rule.definition | ruleRef | Rules, tuning, detections |
| scan.result | assetRef | Scans, host scan, systems |
| software.package | assetRef | Systems, scans, vulnerability matching |
| source.heartbeat | category | Sources and SOC Health |
| vulnerability.finding | assetRef and severity | Scans, systems, remediation |

One vendor input may produce more than one canonical record when it contains
independent facts. For example, a vulnerability scanner may emit
asset.snapshot, software.package, scan.result, and vulnerability.finding
records. Keep their recordIds stable and preserve causation through safe
references in fields or a future versioned correlation model.

## 19. Ingest batch, receipts, deduplication, and replay

An ingest-batch has exactly schemaVersion, documentType, sourceId, receiptId,
sentAt, and records. It contains 1 through 1,000 records. receiptId contains 16
through 128 identifier characters. Every record sourceId equals the batch
sourceId and recordIds are unique inside the batch.

~~~json
{
  "schemaVersion": "1",
  "documentType": "ingest-batch",
  "sourceId": "source-0001",
  "receiptId": "receipt-0000000001",
  "sentAt": "2030-01-02T03:07:10Z",
  "records": [
    {
      "schemaVersion": "1",
      "documentType": "normalized-record",
      "recordId": "event-0000000001",
      "sourceId": "source-0001",
      "estateId": "app-0001",
      "kind": "log.event",
      "observedAt": "2030-01-02T03:07:00Z",
      "payload": {
        "title": "Application request completed",
        "state": "ok",
        "message": "HTTP request completed"
      }
    }
  ]
}
~~~

Admission order:

1. Apply connection, header, body-size, decompression, and timeout limits.
2. Preserve exact bounded raw bytes for signature and receipt hashing.
3. Authenticate the transport identity.
4. Resolve the active source and pinned connector instance.
5. Verify provider signature, certificate, or source-bound proof.
6. Enforce app or estate scope and source lifecycle.
7. Parse strict UTF-8 and the expected media type.
8. Normalize vendor data into complete canonical records.
9. Validate the entire batch and kind-aware payloads.
10. Reject timestamps outside the documented skew or replay policy.
11. Bind receiptId to sourceId and exact body content.
12. Bind recordId to sourceId and canonical record content.
13. Atomically persist receipt and new records.
14. Enqueue projector work or update projections within the same documented
    durable boundary.
15. Acknowledge with accepted and duplicate counts.

Exact replay of the same source, receipt, and body returns the prior receipt.
Receipt reuse with different content is a conflict. Existing recordId with
identical canonical content is a duplicate; the same ID with different content
is a conflict.

## 20. Acquisition transport patterns

**Canonical push**

Use a source-bound credential or mTLS identity, strict body limits,
idempotency, backoff, and a durable sender spool. Rotate credentials without
changing sourceId.

**Signed webhook**

Verify the provider signature over exact raw bytes before parsing. Bind the
provider account to one connector instance. Enforce timestamp and event-ID
replay controls. Return quickly after the durable boundary and project
asynchronously.

**Pull worker**

Resolve credential references server-side. Use scheduler leases so only one
worker owns a source partition. Persist cursor and watermark independently from
projector checkpoints. Bound pages, dates, redirects, response sizes, and
backoff. Do not advance the cursor before durable admission.

**OTLP**

Authenticate exporters, map resource attributes to the authorized source,
bound attribute count and cardinality, reject untrusted tenant selectors, and
translate logs or signals into canonical records before projection.

**Syslog**

Prefer authenticated TLS over TCP or RELP. Treat UDP as explicitly lossy and
surface loss in health. Bound message length, framing, facility, hostname
claims, and parser ambiguity. Do not trust a message hostname as sourceId.

**Host agent**

Use least privilege and a stable enrolled host identity. Maintain a bounded
durable local spool, monotonic sequence or receipt IDs, exponential backoff
with jitter, safe upgrades and rollback, health reporting, and explicit
collection allowlists. Never grant general shell execution merely to collect
logs.

All modes converge on the same canonical validator and admission semantics.

## 21. Page provider and envelope contract

The page provider is separate from the connector provider:

~~~js
{
  schemaVersion: "1",
  id: "application-pages",
  capabilities: {
    readPages: true,
    runCommands: false,
    uploads: false,
    subscriptions: false,
    persistence: false
  },
  readPage(request) { /* returns a Promise */ }
}
~~~

A request contains schemaVersion, route, query, and reason. The server treats
route and query as requested presentation, not authorization.

A page envelope contains schemaVersion, route, state, title, optional summary
and updatedAt, and bounded panels. Supported panel types include metrics,
table, notice, timeline, chart, bars, text, and empty. Cells are plain safe
values or closed link and badge objects. Markup is never interpreted.

Projection rules:

- Match supplied data to the exact stable panel ID.
- Return a contract-valid type compatible with that slot.
- Keep every envelope inside row, series, bucket, text, and cell limits.
- Apply authorization before aggregation so counts do not leak hidden records.
- Use internal hash routes for console links and allowlisted HTTPS destinations
  only where the contract permits them.
- Return honest empty, unavailable, forbidden, or error states.
- Do not enable unrelated UI commands through a read envelope.

The structural catalog is the screen contract. A projector may populate a
declared panel or add a separately documented authorized panel, but connector
manifest targets, projector output, and this manual must agree.

## 22. Screen coverage matrix

The following matrix tells a connector author which canonical inputs normally
feed each screen. Exact business logic remains server-owned.

| Route | Main canonical inputs | Stable projection targets |
| --- | --- | --- |
| / | finding, log.event, governance.risk, compliance.record | summary-metrics, detections, needs-attention-register-overdue, next-dated-obligations |
| /health | source.heartbeat, intel.sync, retention.snapshot, alert.delivery | summary-metrics, is-the-collection-working, rules-that-have-never-fired, what-is-actually-firing, detection-drills-last-proven-fire-per-layer |
| /brief | finding, case.record, governance.risk, vulnerability.finding, retention.snapshot | do-today, security-brief, to-turn-over-untouched, in-work, investigations-tagged-real-threat, dispositioned-in-the-last-24h |
| /analyst | case.record, rule.definition, vulnerability.finding, governance.risk, retention.snapshot | latest-briefing, previous-briefings, case-analyst-every-analysis-on-record, latest review panels |
| /analytics | log.event, network.event, endpoint.event, authentication.event, finding | summary-metrics, events-collected-per-hour, detections-per-hour, what-is-firing, most-blocked-source-addresses |
| /timeline | all event-like kinds | unified-timeline |
| /triage | finding, case.record, phishing.report, honeypot.event, file.integrity | alerts, detection-tuning |
| /event | finding, case.record, evidence.receipt, log.event, intel.indicator | decision-status, findings-in-this-decision, finding-context, event-evidence, associated-logs-15-min |
| /tuning | rule.definition, finding, case.record, audit.event | summary-metrics, tune-recommendations, detection-tune-definitions, applied-alerts, matched-but-held, tune detail panels |
| /rules | rule.definition, finding, audit.event | built-in-rules, inline-rules, custom-rules, sigma-rules, yara-status, rule detail panels |
| /alerts | alert.delivery, finding, audit.event | alert-path, who-gets-paged, delivery-log, provider-reconciliation |
| /honeypots | honeypot.event, file.integrity, identity.access | decoy-files, canaries, trap-usernames, trip-log, honey-account-proof |
| /phishing | phishing.report, finding, intel.indicator, evidence.receipt | summary-metrics, report-queue, verdict, signal-evidence, extracted-links, attachment-ledger, passive-intel, message-body |
| /logs | log.event, network.event, endpoint.event, authentication.event | log-results |
| /search | authorized indexes over canonical records | search-dispatch |
| /activity | endpoint.event, authentication.event, identity.access, network.event | baseline-maturity, what-is-different-first-seen-today, elevated-above-their-own-baseline, trending-up-ewma-climbing, long-tail-rarest-in-30-days |
| /ioc | intel.indicator | extracted-indicators |
| /intel | intel.indicator, intel.sync, network.event | source-specific indicator tables, outbound-destinations-checked-against-otx, otx-synchronization, newest-merged-indicators |
| /known-ips | asset.snapshot, network.event, intel.indicator | operator-egress-your-isp-addresses-tracked-automatically, tailnet-devices, estate, manual-entries |
| /ip | network.event, intel.indicator, finding | investigate-address, shodan, alienvault-otx, related-detections, log-events |
| /scans | scan.result, vulnerability.finding, software.package, file.integrity, remediation.record | trivy-operating-system-packages, patch-first, file-integrity-critical-files-and-canaries, dependency-advisories, remediation-log |
| /host-scan | scan.result, vulnerability.finding, software.package | trivy-scan, trivy-findings |
| /kev | vulnerability.finding, software.package, intel.indicator | known-exploited-vulnerability-detail |
| /remediation | remediation.record, vulnerability.finding | vm-analyst-latest-review, remediation-log |
| /systems | asset.snapshot, software.package, vulnerability.finding, network.event | external-attack-surface-what-the-internet-sees, estate-inventory, are-we-affected-known-exploited-vulnerabilities-vs-our-software |
| /databases | database.schema, audit.event | schema-drift-watch, schema-changes-detected |
| /backups | backup.status, evidence.receipt | push-side-the-backup-chain-reporting-in, pull-side-independent-verification-from-the-watchtower, soc-evidence-off-box-object-lock-copy |
| /retention | retention.snapshot, compliance.record | declared-policy, summary-metrics, measured-horizon, per-source, archived-baselines |
| /sources | source.heartbeat plus control registry | expected-sources, pending-source-setups, configured-sources, source-registry-changes |
| /source | source.heartbeat plus collection metadata | source-declaration, latest-collection, source-history |
| /agents | agents-domain administration snapshot plus separately authorized prompt document | agent registry, add, prompt metadata/body, enrollment, history management views |
| /attestations | governance.attestation, remediation.record, evidence.receipt | remediation-attestations |
| /attestation | governance.attestation, evidence.receipt | attestation |
| /register | governance.risk, compliance.record, remediation.record | overdue, closures-awaiting-the-document-edit, next-dated-obligations |
| /risk | governance risk administration record | authoritative risk detail and lifecycle controls |
| /access | identity.access, authentication.event, offboarding.record, audit.event, evidence.receipt | who-has-full-access, refused-writes, evidence-integrity, offboarding-records, offboarding detail panels |

/onboard and /settings are control and configuration surfaces, not canonical
telemetry projections. /docs is repository-local implementation guidance and
must never receive operational page, connector-control, or administration data. A deployment
with required authentication continues to gate /docs with the rest of the
console.

A connector manifest declares only the routes and surfaces its driver and
projectors actually support. Do not claim the entire matrix for a connector
that emits one kind.

## 23. Projector design, checkpoints, and rebuilds

A projector consumes canonical records and registry state and writes page read
models.

Required properties:

- **Idempotent:** replaying the same canonical record does not double-count.
- **Deterministic:** the same authorized input and projector version produce
  the same output.
- **Scoped:** tenant or app scope is part of every key and query.
- **Versioned:** projector code and read-model schema versions are recorded.
- **Checkpointed:** progress is stored independently from acquisition cursor.
- **Rebuildable:** a new projection can be built alongside the old one and
  atomically promoted.
- **Bounded:** high-cardinality fields, time buckets, tables, and timelines have
  explicit limits.
- **Late-data aware:** event observation time and admission time are distinct.
- **Deletion aware:** retention, source disable, legal deletion, and corrected
  records propagate according to policy.

One record may fan out to multiple projections. For example, log.event may
update source health, an hourly analytics bucket, a searchable log index, and a
timeline. Detection logic consumes canonical records, emits finding or related
records, and does not inspect rendered rows.

Keep:

- receiver cursor separate from admission receipt;
- admission receipt separate from record identity;
- record identity separate from projection key;
- projector checkpoint separate from page updatedAt; and
- page cache invalidation separate from source health.

## 24. Health, cadence, and honest empty states

Source health states are unknown, pending, healthy, degraded, stale, offline,
error, and disabled. Reasons are none, awaiting-first-delivery, late,
connector-error, authentication-required, configuration-invalid,
permission-denied, rate-limited, and disabled.

Health tracks observedAt, revision, lastAttemptAt, lastSuccessAt,
nextExpectedAt, bounded counters, and optional safe message.

Rules:

- New configured and tested sources are pending.
- Activation leaves a source pending until a real accepted delivery.
- A successful connection proof does not make a source healthy.
- A successful source test does not make a source healthy.
- Empty data counts as success only when the installed manifest explicitly says
  emptyPayloadIsHealthy and the receiver can prove a successful collection.
- Stale and offline transitions are evaluated by a scheduler or read-time
  projection using the pinned health policy and source cadence.
- An old success cannot hide the latest failed attempt.
- Authentication, permission, rate-limit, parse, capacity, and projector
  failures must remain distinguishable without exposing secrets.
- Disabled is an administrative state, not a network failure.

The reference connector scales its declared 300/450/900-second
expected/stale/offline relationship to the source cadence. At the default
300-second cadence, a delivered source is healthy through 450 seconds, stale
after 450 seconds through 900 seconds, and offline after 900 seconds. A
600-second cadence scales those thresholds to 900 and 1,800 seconds. The
control snapshot and page projector call the same threshold function.

Page envelopes use empty when the authorized query has no records, unavailable
when a dependency is unavailable, forbidden when the current identity may not
read it, and error for a safe failure state. Do not fabricate records to make a
screen appear populated.

## 25. Authentication, Better Auth, and authorization

For a single TypeScript or Node application, Better Auth is the recommended
direct application-session integration. The private starter installs pinned
Better Auth + SQLite with closed signup and locally provisioned operators.
It includes real sign-in/session enforcement; the optional client-side bridge
is for embedding the UI into a separately configured application. Section 49
documents the shipped authentication behavior and limitations.

Production shape:

~~~text
browser -> same-origin application server -> Better Auth handler and session
                                      |
                                      +-> app/resource/action authorization
                                      +-> connector control service
                                      +-> page read service
~~~

The browser auth provider exposes getSession, login, and logout. getSession returns only:

~~~json
{
  "authenticated": true,
  "display": {
    "name": "Operator",
    "initials": "OP"
  },
  "capabilities": ["console:read"]
}
~~~

This projection is display data, not proof of authorization. Never return user
IDs, email addresses unless explicitly required for display, session IDs,
cookies, provider tokens, raw claims, full group lists, or policy internals.

The production server must:

- use secure, HTTP-only, host-only cookies;
- rotate session identity at login and privilege change;
- enforce idle and absolute expiration;
- protect every state-changing cookie request from CSRF;
- set exact trusted origins and redirect allowlists;
- authorize every page, app, host, source, command, secret slot, and record
  query against current server policy;
- invalidate or refresh authorization after membership changes;
- distinguish local application logout from upstream provider logout; and
- log only safe correlation and coarse failure categories.

For centralized identity across independent products, use a server-side OIDC
relying party such as Keycloak or authentik with authorization code, PKCE,
exact issuer and audience validation, server-side tokens, and explicit role
mapping. Do not place OAuth tokens in browser storage.

## 26. Narrow reference MCP facade

The repository ships an optional stdio MCP reference client in
`tools/agent-mcp.js`. It publishes checked-in public documentation/contracts and
calls fixed connector/administration/setup endpoints on the same canonical API/RBAC
boundary as the browser. It is not a second registry, an agent runner, a secret
broker, or a telemetry transport.

For the private starter, issue an expiring scoped credential in Agents → Service
Access and configure an owner-only external token file as described in section
53. Tokenless mode is only for the disposable loopback workbench. Do not extract
browser cookies, weaken private authentication, or expose that workbench
through Serve.

Start the loopback reference workbench, then run:

~~~sh
npm run --silent start:agent-mcp
~~~

The default API origin is `http://127.0.0.1:8787`. Override it with
`SOC_AGENT_MCP_BASE_URL` or `--base-url`. HTTP is accepted only for exact
loopback. HTTPS is restricted to loopback, private RFC 1918, CGNAT, ULA, or a
validated private-overlay DNS suffix. Tool arguments accept no URL. Redirects
are refused, and fixed request/response/time limits and remote-error redaction
apply.

The exact seven tools are:

| Tool | Arguments | Safety boundary |
| --- | --- | --- |
| connector_snapshot | `{ reason?: "initial"/"refresh"/"command", knownRevision?: integer >= 0 }` | Fixed connector snapshot endpoint and validated result |
| connector_command | `{ request: connector-command-request }` | Refuses credential-issuing host.enroll, source.activate, and source.rotate before HTTP |
| administration_snapshot | `{ domain: "agents"/"governance", reason?: "initial"/"refresh"/"command", knownRevision?: integer >= 0 }` | Fixed administration snapshot endpoint and validated result |
| administration_prompt | `{ promptId: stable-id }` | One separately authorized literal prompt; no bulk export |
| administration_command | `{ request: administration-command-request }` | Refuses credential-issuing enrollment.issue before HTTP |
| setup_guides | `{}` | Private service token with optional setup:read; saved guide bindings and compatible choices only; unavailable in tokenless workbench mode |
| setup_check | `{ appId, environment, path: "live"/"vendor"/"custom"/"trivy", sourceId?: stable-id }` | Private service token with setup:read; timestamped local evidence only; no vendor poll, notification, scan, mutation or readiness certification |

Credential-issuing `host.enroll`, `source.activate`, `source.rotate`, and `enrollment.issue`
must use the protected operator UI or an equivalently reviewed non-MCP
ceremony. The reference facade has no fallback that returns those one-time
values.

Documentation resource URIs are `soc://documentation/technical-manual`,
`soc://documentation/agent-guide`, `soc://documentation/connectors`,
`soc://documentation/architecture`, `soc://documentation/configuration`,
`soc://documentation/features`, `soc://documentation/integration-review`,
`soc://documentation/vendor-integrations`, `soc://documentation/live-monitoring`,
and `soc://documentation/guided-setup`.
Contract resource URIs under `soc://contracts/` are
`administration-v1-schema`, `connector-manifest-v1`,
`source-registration-v1`, `normalized-record-v1`, `ingest-batch-v1`,
`page-model-v1`, `connector-runtime-v1`, `administration-runtime-v1`,
`page-runtime-v1`, and `ingest-runtime-v1`.

The process supports the 2026-07-28 discovery/meta flow and legacy initialize-
era clients. It has no generic fetch, arbitrary URL, shell, SQL, filesystem-path,
secret retrieval/echo, credential resource, raw log, or telemetry tool.
Credential issuance is deliberately unavailable through the reference facade.
Private service authentication and exact operation scopes are shipped; these
scopes cover the single installation, not a tenant, individual app or record.
More granular tenant/resource/field authorization remains adopter work.
Human approval remains required
for destructive, privilege-expanding, prompt-activation, and production-impact
commands even when the tool schema accepts them.

Production agents continue to use purpose-built authenticated ingestion for
telemetry and private workload identity for runtime connections. A production
MCP replacement may retain these narrow resources/tools but must use private
TLS, real service identity/RBAC, durable audit, rate limits, and the canonical
command services.

## 27. Loopback reference workbench

The reference workbench is for local contract testing only. It binds to
127.0.0.1, requires an explicit state directory, and defaults to port 8787.

~~~sh
soc_reference_state="$(node -e 'const fs=require("node:fs"),os=require("node:os"),path=require("node:path"); process.stdout.write(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),"bb-soc-workbench-")))')"
npm run start:connectors -- --state-dir "$soc_reference_state"
~~~

Equivalent supported launch forms are:

~~~sh
npm run start:connectors -- --state-dir <state-directory> --port <1-through-65535>
npm run start:connectors -- --state-dir <state-directory> --no-static
SOC_REFERENCE_STATE_DIR=<state-directory> SOC_REFERENCE_PORT=<port> npm run start:connectors
~~~

--no-static exposes only the reference API/bridge boundary; serve the browser
shell separately only when the resulting same-origin integration is deliberate
and tested. Command-line flags override their environment counterparts. The
server refuses an omitted state directory, any non-loopback bind, an unknown
flag, or an out-of-range port.

HTTP surface:

| Method and path | Purpose |
| --- | --- |
| GET /api/v1/control/snapshot | Read validated registry snapshot |
| POST /api/v1/control/commands | Execute one closed lifecycle command; 64 KiB maximum |
| GET /api/v1/administration/snapshot | Read one validated agents/governance snapshot |
| GET /api/v1/administration/prompts | Read one separately selected/authorized prompt body |
| POST /api/v1/administration/commands | Execute one closed administration command; 64 KiB maximum |
| GET /api/v1/pages | Read one projected page envelope |
| POST /api/v1/connection-check | Consume one host connection-check value |
| POST /api/v1/agents/connection | Consume one agent enrollment value and bounded proof |
| POST /api/v1/ingest | Admit one canonical batch; 1 MiB maximum |
| GET or HEAD /application-bridge.js | Generated same-origin browser providers |
| GET or HEAD /api/v1/browser-provider.js | Alias for the generated browser provider |
| Static GET or HEAD below public/ | Checked-in shell files, with an 8 MiB per-file ceiling |

Mutations require the exact loopback Host and matching Origin. Cross-site
requests and preflights are rejected. JSON is uncompressed UTF-8 with the
supported media type. Request targets, query keys, query values, headers, and
bodies are bounded.

Exact request boundary rules:

- a request target is at most 2,048 characters, starts with one slash, and has
  no second leading slash, backslash, NUL, or fragment;
- Host is exactly 127.0.0.1 or localhost with the active listener port;
- every POST has an Origin equal to that loopback origin; an optional
  Sec-Fetch-Site header must be same-origin;
- content type is application/json with an optional UTF-8 charset, content
  encoding is absent or identity, decoding is fatal UTF-8, and duplicate
  relevant headers are rejected;
- Enrollment and Bearer credentials use the exact declared scheme and a
  bounded 32-through-512-character value;
- snapshot queries accept only reason and one optional knownRevision; page
  queries allow at most 21 unique keys including route, a 64-character key,
  and a 256-character value; and
- administration snapshot queries accept domain, reason, and optional
  knownRevision; prompt reads accept one promptId;
- command and connection-check bodies are at most 64 KiB, while ingest bodies
  are at most 1 MiB.

Every response is no-store and receives the shipped CSP, same-origin opener
and resource policies, restrictive permissions policy, no-referrer policy,
nosniff, and denial of framing. Boundary failures use a closed version-1
reference-problem with only schemaVersion, documentType, code, and message.
Expected status categories are 400 malformed input, 401 missing or invalid
proof, 403 wrong authority or scope, 404 missing resource, 405 unsupported
preflight, 409 identity/revision/replay conflict, 413 body too large, 415 media
or encoding refusal, 422 a valid document blocked by lifecycle/admission
policy, 507 bounded local capacity exhausted, and a generic 500 response for
unexpected internal failure.

Minimal command-line lifecycle, using the JSON documents from sections 12
through 19 and placeholder-only credentials:

~~~sh
reference_origin="http://127.0.0.1:8787"

curl --fail-with-body --silent --show-error \
  "$reference_origin/api/v1/control/snapshot?reason=initial"

curl --fail-with-body --silent --show-error \
  -H "Origin: $reference_origin" \
  -H "Content-Type: application/json; charset=utf-8" \
  --data-binary @register-command.json \
  "$reference_origin/api/v1/control/commands"

curl --fail-with-body --silent --show-error \
  -H "Origin: $reference_origin" \
  -H "Content-Type: application/json; charset=utf-8" \
  --data-binary @enroll-command.json \
  "$reference_origin/api/v1/control/commands"

curl --fail-with-body --silent --show-error \
  -H "Origin: $reference_origin" \
  -H "Content-Type: application/json; charset=utf-8" \
  -H "Authorization: Enrollment <one-time-connection-credential>" \
  --data-binary @connection-check.json \
  "$reference_origin/api/v1/connection-check"

curl --fail-with-body --silent --show-error \
  -H "Origin: $reference_origin" \
  -H "Content-Type: application/json; charset=utf-8" \
  --data-binary @source-setup-command.json \
  "$reference_origin/api/v1/control/commands"

curl --fail-with-body --silent --show-error \
  -H "Origin: $reference_origin" \
  -H "Content-Type: application/json; charset=utf-8" \
  --data-binary @source-test-command.json \
  "$reference_origin/api/v1/control/commands"

curl --fail-with-body --silent --show-error \
  -H "Origin: $reference_origin" \
  -H "Content-Type: application/json; charset=utf-8" \
  --data-binary @source-activate-command.json \
  "$reference_origin/api/v1/control/commands"

npm run validate:ingest -- ingest-batch.json
curl --fail-with-body --silent --show-error \
  -H "Origin: $reference_origin" \
  -H "Content-Type: application/json; charset=utf-8" \
  -H "Authorization: Bearer <one-time-source-ingest-credential>" \
  --data-binary @ingest-batch.json \
  "$reference_origin/api/v1/ingest"

curl --fail-with-body --silent --show-error \
  "$reference_origin/api/v1/pages?route=%2Flogs&limit=50"
~~~

After each control command, read a fresh snapshot and copy only the returned
stable IDs and current revision into the next request. Capture each one-time
credential directly into the intended host or secret facility; never paste it
into a repository file, issue, transcript, agent response, log, or command
history. For an ingest retry, resend the exact bytes of ingest-batch.json with
the same source and receipt identity. Changing whitespace changes the raw body
hash and is not an exact receipt replay.

Reference state:

- the directory must be real, owner-only, and not a symbolic link;
- state and audit files are owner read/write;
- one runtime lock prevents simultaneous use;
- state is atomically replaced;
- audit records intent, commit, and abort;
- detected inconsistency fails closed;
- state and audit sizes are bounded;
- record and receipt capacity are each bounded at 10,000;
- credentials persist only as digests and safe metadata; and
- exact body hashes bind receipt replay.

The workbench lacks production auth, TLS, KMS, database transactions across
processes, queues, schedulers, vendor egress, and operational hardening. Never
expose it remotely or put customer telemetry or production credentials in its
state directory.

## 28. Production storage, transactions, and concurrency

Recommended logical tables:

- tenants or estates
- applications
- hosts
- connector_manifest_packages
- connector_manifest_versions
- connector_instances
- sources
- source_health
- credential_references
- control_operations
- registry_changes
- protected_audit
- ingest_receipts
- canonical_records
- acquisition_cursors
- projector_versions
- projector_checkpoints
- read_model tables or indexes
- dead_letter_items

Use unique constraints for stable IDs, source plus receiptId, source plus
recordId, installed connector type plus version, and any provider event
identity used for deduplication.

Control mutation transaction:

1. Resolve current session and authorization.
2. Lock or compare the current resource revision.
3. Validate the installed manifest and command.
4. Write resource changes and next revision.
5. Write registry change and protected audit intent or completion.
6. Commit atomically.
7. Publish an outbox event for workers after commit.

Ingest transaction:

1. Resolve and lock source receipt scope.
2. Detect exact replay or conflicting reuse.
3. Insert new canonical records with unique constraints.
4. Insert receipt and counts.
5. Update source attempt and success health.
6. Insert projector outbox work.
7. Commit, then acknowledge.

Use an outbox or equivalent durable handoff so a database commit cannot be lost
between admission and queue publication. Workers use leases, bounded retries,
exponential backoff, dead letters, and idempotent handlers. Test crash points
before and after every durable boundary.

## 29. Security and abuse-resistance checklist

**Network**

- TLS everywhere outside loopback.
- Exact origin, host, proxy, and forwarded-header policy.
- Egress allowlists per connector driver.
- Redirect limits and destination revalidation.
- DNS rebinding and SSRF defenses for operator-entered endpoints.
- Connection, read, total, and idle timeouts.
- Request, response, decompression, page, and cardinality limits.

**Identity and authorization**

- Same-origin secure sessions.
- CSRF protection.
- Current app or estate resource/action authorization.
- Separate installer, operator, secret manager, and auditor roles.
- Step-up or approval for activation, credential rotation, destructive
  operations, and connector installation.
- Deny missing, stale, or unrecognized policy inputs.

**Input and execution**

- Closed schemas and exact keys.
- Strict date, URL, identifier, and numeric validation.
- No markup execution from manifests or records.
- No shell construction from source data.
- Sandboxed or isolated vendor drivers where practical.
- Dependency pinning, provenance, scanning, and minimum-age policy.

**Secrets and privacy**

- Write-only provisioning and least-privilege resolution.
- Encryption at rest and managed key rotation.
- No secrets in logs, metrics, traces, errors, URLs, browser data, or MCP.
- Classification, minimization, redaction, retention, and deletion per data
  store.
- Protected audit access and retention.

**Availability and integrity**

- Idempotency and replay protection.
- Rate and quota policy by actor, source, and tenant.
- Queue backpressure and capacity alarms.
- Audit write failure fails closed for protected mutations.
- Tested backups, restores, migration rollback, and disaster recovery.
- Projector rebuild and reconciliation.

## 30. Failure modes and operator troubleshooting

| Symptom | Likely cause | Required check |
| --- | --- | --- |
| Register app is disabled | No validated connector command provider | Check configured global, load order, and provider validation |
| Connector list is empty | No installed manifest is authorized or registry read failed | Inspect server registry and snapshot error |
| Host list does not match app | Client filtering or ownership projection defect | Verify host.appId and UI filtering |
| Host remains pending | Connection check not submitted, expired, consumed, or rejected | Re-enroll and inspect safe audit |
| Source setup rejected | Wrong scope, kind, config, credential reference, or host state | Validate request with exact installed manifest |
| Test fails | Connection proof stale, credential reference unavailable, permission denied, or driver check failed | Read controlled error and server correlation |
| Revision conflict | Another mutation changed the source | Refresh snapshot and reassess |
| Activation blocked | Source is not tested or policy approval missing | Complete current test and authorization |
| Source stays pending | No real accepted delivery | Inspect transport, admission receipt, and sender retry |
| Source becomes stale | Delivery later than cadence or pull worker delayed | Compare last attempt, last success, next expected, scheduler |
| Ingest unauthorized | Wrong, expired, revoked, or cross-source proof | Rotate or re-enroll; never log the presented value |
| Receipt conflict | Same source and receiptId used with different body | Fix sender idempotency; do not overwrite |
| Record conflict | Same source and recordId changed content | Fix normalizer identity stability |
| Page remains empty | No projector, wrong panel ID, lagging checkpoint, or authorization scope | Trace record to projector to envelope |
| Extra authorized panel appears | Projector emitted an undeclared panel | Align catalog, manifest targets, projector, and docs |
| Browser shows adapter error | Invalid envelope or provider failure | Validate exact route, panel type, IDs, and bounds |
| Login works but commands fail | Browser display session is not server authorization | Inspect resource/action policy and CSRF |

Troubleshooting must use correlation IDs and safe resource IDs. Do not ask an
operator to paste credentials, cookies, full provider payloads, or customer
logs into a public issue.

## 31. Versioning, compatibility, upgrades, and rollback

Version every boundary independently:

- UI catalog and stable panel IDs
- page envelope contract
- connector manifest contract
- source registration and health contract
- command vocabulary
- canonical record and payload vocabulary
- ingest batch and receipt semantics
- driver package and vendor API version
- projector code and read-model schema

Compatibility procedure:

1. Declare supported application and contract versions in the connector
   package.
2. Validate the new manifest without replacing the active version.
3. Run the old and new normalizer against retained safe test vectors.
4. Build the new projection beside the old projection.
5. Compare counts, identities, authorization, and representative output.
6. Test credential and cursor migration.
7. Activate for a limited source set.
8. Monitor admission, lag, health, and error rates.
9. Promote atomically.
10. Retain a tested rollback path until the migration window closes.

Never reinterpret an existing record kind or field silently. Add an optional
field when backward compatible, or create a new schema version and migration
when semantics change. Preserve stable source and record identities across a
driver upgrade whenever the underlying source and event identity are unchanged.

## 32. Validation commands and test layers

Local document validation:

~~~sh
npm run build:docs
npm run check:docs
npm run validate:connector -- path/to/connector-document.json
npm run validate:connector -- --manifest path/to/manifest.json path/to/source.json
npm run validate:ingest -- path/to/ingest-batch.json
npm run validate:administration -- path/to/administration-document.json
npm run validate:provider -- path/to/page-envelope.json
~~~

Edit public/technical-reference.md, not the generated JavaScript. build:docs
validates the title, size, section identifiers, language-tagged and balanced
code fences, every fenced JSON example, and unsafe embedded markup, then
rebuilds public/technical-docs.js deterministically. check:docs fails when the
two artifacts differ. The browser validates the local document metadata again
before rendering it and never accepts documentation from either application
provider.

Repository verification:

~~~sh
npm run check
~~~

Required production test layers:

- unit tests for every validator and normalizer;
- contract tests for manifest, source, command, snapshot, record, batch, and
  envelope producers;
- state-machine tests for allowed and refused transitions;
- administration snapshot/prompt separation, command correlation, global
  revision conflict, replay, archive/restore/remove, and tombstone tests;
- authorization tests for cross-app, cross-host, cross-source, field, and
  action isolation;
- one-time credential expiry, replay, revocation, wrong-purpose, and concurrent
  consumption tests;
- receipt and record idempotency tests;
- malformed UTF-8, compression bomb, oversized body, date, URL, and
  high-cardinality tests;
- vendor pagination, timeout, redirect, rate-limit, partial response, and
  schema-drift tests;
- crash consistency at every transaction and outbox boundary;
- projector replay, rebuild, late data, deletion, and duplicate tests;
- browser keyboard, focus, responsive, empty, error, and provider-failure
  tests;
- backup restore and migration rollback tests; and
- load tests for the selected source count, event rate, retention, and query
  windows.

A green browser rendering test does not replace server authorization,
idempotency, or recovery tests.

## 33. Worked connector implementation recipes

**Push log source**

1. Install a manifest declaring host scope, log.event, cadence, and exact
   /logs, /sources, /health, /analytics, and optional overview targets.
2. Enroll and prove the host.
3. Configure and activate a source.
4. Store the returned source proof in the sender's secret store.
5. Normalize each durable local event into a stable log.event record.
6. Batch with a durable receipt ID and retry exact bytes until acknowledged.
7. Project logs, hourly counts, and source health idempotently.

**Threat-intelligence pull source**

1. Install a service or application scoped manifest producing intel.indicator
   and intel.sync.
2. Declare API credential slots and poll-window configuration.
3. Provision credential references through the server.
4. Test a bounded identity or status call.
5. Schedule with a lease and persist provider cursor.
6. Normalize indicator type, value, first and last seen facts.
7. Emit intel.sync for collection outcome independently of indicator count.
8. Project source-specific and merged Threat Intel panels.

**Vulnerability scanner**

1. Install a host or application scoped pull or webhook connector.
2. Normalize assets and packages before vulnerability findings.
3. Preserve scan identity and finding identity across pagination and retry.
4. Emit scan.result, software.package, vulnerability.finding, and optional
   remediation.record facts.
5. Project Scans, Systems, host detail, remediation, brief, and analytics.

**Signed webhook**

1. Map the provider installation or account to one connector instance.
2. Preserve raw bytes, verify signature and timestamp, then parse.
3. Bind provider event ID to source receipt identity.
4. Normalize and admit before acknowledging.
5. Reject unknown account, source, signature, replay, content type, or schema.

**Host agent**

1. Package only the approved collectors.
2. Enroll one host and provision one or more source identities.
3. Store proofs using the operating system's protected facility.
4. Spool bounded batches durably.
5. Retry exact batch bytes with backoff.
6. Report safe health and capacity indicators.
7. Support signed upgrades and rollback without changing source identity.

## 34. Definition of done for one connector

A connector is complete only when:

- [ ] Its manifest passes both schema and executable validation.
- [ ] The connector type and version were reviewed and installed through the
      controlled registry process.
- [ ] Every target route and surface exists in the supported UI catalog.
- [ ] Every declared record kind has a complete normalizer.
- [ ] Every declared target has an idempotent authorized projector.
- [ ] Configuration contains no secret-shaped keys or values.
- [ ] Required credential slots use opaque references.
- [ ] Setup, test, activation, disable or recovery policy, rotation, and upgrade
      behavior are documented.
- [ ] The driver enforces destination, TLS, redirect, timeout, size, pagination,
      rate, and cardinality policy.
- [ ] Source, receipt, and record identities remain stable under retry.
- [ ] Health reflects attempts, successes, empty collections, late delivery,
      auth failure, permission failure, rate limits, and disablement honestly.
- [ ] The connector cannot cross app or estate boundaries.
- [ ] Secrets do not appear in browser, snapshots, logs, metrics, traces,
      errors, canonical records, page envelopes, or MCP.
- [ ] Projector lag, admission failure, credential expiry, and capacity are
      observable.
- [ ] Contract, abuse, replay, authorization, crash, restore, load, upgrade,
      and rollback tests pass.
- [ ] The screen coverage matrix and operator instructions are updated.

## 35. Deployment acceptance checklist

Before making the full application operational:

- [ ] UI/BFF, control planes, MCP, enrollment, callbacks, and ingest bind only
      to loopback or approved tailnet/private interfaces; public ingress and
      public DNS are absent and tested.
- [ ] Tailnet ACLs/grants, tagged service identities, private TLS/mTLS, device
      approval, expiry, and revocation are tested without treating the tailnet
      as application authorization.
- [ ] Better Auth or the selected server identity system is configured with
      production storage, exact origins, secure cookies, expiry, revocation,
      and CSRF controls.
- [ ] Server authorization is tested for every route and connector operation.
- [ ] Connector package installation is controlled and audited.
- [ ] Managed secret storage and rotation are operational.
- [ ] The control database has migrations, backups, restore tests, unique
      constraints, revisions, and protected audit.
- [ ] Every ingestion mode has authentication, limits, replay protection,
      durable acknowledgment, and backpressure.
- [ ] Canonical storage has classification, retention, deletion, and capacity
      policy.
- [ ] Queues, workers, leases, retries, dead letters, and projector checkpoints
      are monitored.
- [ ] Every visible screen either has an authorized projector or an honest
      empty state.
- [ ] MCP, if enabled, mirrors only authorized control operations.
- [ ] Production TLS, headers, CSP, proxy, origin, and egress policy are
      reviewed.
- [ ] Security, privacy, incident response, disaster recovery, and key rotation
      procedures are tested.
- [ ] The reference workbench is not reachable in production.
- [ ] No operational data or secret material exists in the public package.

## 36. Glossary

| Term | Meaning |
| --- | --- |
| Application | Registered ownership boundary represented by appId |
| Host | Declared machine identity owned by one application |
| Connector type | Reviewed installed manifest plus compatible server driver |
| Connector instance | Configured use of one connector type |
| Source | Independently identified lifecycle and health boundary |
| Manifest | Data-only declaration of inputs, outputs, config, credentials, targets, and health |
| Driver | Server-owned code that communicates with a source or vendor |
| Receiver | Network or local admission endpoint for pushed telemetry |
| Normalizer | Code that turns verified vendor input into canonical records |
| Canonical record | Closed versioned security fact used by downstream services |
| Receipt | Source-scoped idempotency identity for one ingest batch |
| Projector | Idempotent consumer that builds authorized page read models |
| Page envelope | Bounded presentation document returned to the UI |
| Control snapshot | Bounded presentation-safe view of connector registry state |
| Administration snapshot | Domain-scoped safe metadata for agents or governance; prompt bodies require a separate read |
| Managed agent | Registered automation/interactive/service identity; registration does not itself run code or grant undeclared authority |
| Prompt revision | Immutable versioned literal prompt text with metadata; body retrieval is separately authorized |
| Credential reference | Opaque pointer to a secret in an approved backend |
| Connection proof | One-time evidence that the intended host owns the enrollment path |
| Health | Independent collection state derived from current attempts and policy |
| MCP facade | Shipped narrow local reference/proposed production client of the same canonical connector/administration services |
| Reference workbench | Loopback-only local contract implementation, never a production server |

## 37. Private Tailnet deployment model

The safest default for a self-hosted SOC is a **private-only tailnet
deployment**. Do not expose the UI, BFF, connector control service,
administration service, MCP facade, agent enrollment endpoint, scanner callback,
or telemetry receiver through public Internet ingress or public DNS. The
console concentrates sensitive security context even when every individual
projection is redacted; minimizing reachability is a primary control.

Use this topology:

~~~text
operator browser -- private TLS over tailnet --> UI/BFF
agent/collector  -- mTLS/service identity ----> enrollment + ingest
scanner worker   -- service identity ---------> job/result receiver
UI, CLI, MCP     -- authenticated principal --> canonical control services
control services -----------------------------> private database/queue/secrets
~~~

For one-machine development, bind to `127.0.0.1` or `::1`. For shared use,
bind the application to an explicitly selected private interface or keep it on
loopback behind a reverse proxy that is itself reachable only on the tailnet.
Do not use a wildcard listener unless host firewall and proxy rules make the
private restriction independently enforceable and tested. Do not turn the
checked-in static server or reference workbench into a remote server. Use the
private starter behind Tailscale Serve (never Funnel) with the exact Tailnet
HTTPS origin, or deploy an independently reviewed custom BFF. The starter
listener remains `127.0.0.1`; it has no public/wildcard bind flag.

Apply tailnet ACLs or grants by role and service identity. Normal operator
devices should reach the UI/BFF, not databases, queues, secret stores, or raw
collector ports. Agents reach only their enrollment, heartbeat, and assigned
ingest destinations. Scanner workers reach only the approved target set and
result receiver. Administrative identities reach administration endpoints;
read-only users do not. Use tagged, non-human service identities, device
approval, key expiry, posture policy, and rapid device/credential revocation.

Use HTTPS inside the tailnet and verify names. Use private certificates and
prefer mTLS or an equivalent rotated workload identity for non-browser
connections. Pin audiences and purposes so an enrollment credential cannot be
used for ingest and an ingest credential cannot call administration. Keep
server egress allowlisted: private ingress does not prevent an SSRF-capable
connector or scanner from reaching metadata/control-plane destinations.

A tailnet is a reachability boundary, not an authorization system. The BFF must
still authenticate sessions, authorize every route/resource/action, protect
cookie commands against CSRF, validate origin and request shape, enforce tenant
and stable-ID ownership, rate-limit, redact, and audit. Service endpoints still
authenticate the source/agent, validate scope, enforce replay windows and size
limits, and rotate/revoke proof. Assume a joined device, browser extension, or
operator workstation can be compromised.

Deployment acceptance evidence should include: listener enumeration; tailnet
ACL/grant tests for allowed and refused role pairs; proof that public DNS has no
record and public ingress cannot connect; private certificate validation;
cross-tenant/action authorization tests; credential revocation; backup/restore;
and an explicit check that reference-mode endpoints are absent. Record evidence
references, not secrets or raw production output, in the governance system.

## 38. Agent management and optional MCP facade

The raw Markdown manual at `public/technical-reference.md` and the focused
`docs/AGENTS.md` entry point are the authoritative agent-readable documentation.
The generated `public/technical-docs.js` exists only to render the same text in
the browser. An agent should read the raw files, contract schemas/runtimes, and
installed manifest registry; it should not infer behavior from screenshots or
visible disabled controls.

Application builds use a separate `SOC_CONSOLE_ADMINISTRATION` boundary for
managed agents and governance records. It is not the page adapter and not the
connector provider. It returns domain-separated snapshots and accepts only the
installed closed command vocabulary. The version-1 agent commands are:

- `agent.create`, `agent.update`, `agent.pause`, `agent.resume`,
  `agent.archive`, `agent.restore`, and dependency-aware `agent.remove`;
- `prompt.revise`, `prompt.activate`, and `prompt.archive`; and
- `enrollment.issue` and `enrollment.revoke`.

The provider has `getSnapshot`, `getPrompt`, and `execute` plus optional
`dispose`. Agent snapshots contain prompt metadata but no bodies. `getPrompt`
retrieves one separately authorized literal-text prompt document by stable ID;
it is not a bulk export and snapshot permission alone does not authorize it.

An agent lifecycle state is `active`, `paused`, or `archived`.
`agent.create` returns active, and `agent.restore` returns an archived record to
active. Create a stable server-issued agent ID; do not derive identity from the
display name. Assign only explicit, least-privilege capabilities. Version 1
does not carry separate assignment/scope entities; a production assignment
model is a versioned extension. Updating metadata/capabilities requires the
exact current administration snapshot revision. Pausing stops new work and revokes/terminates
active leases as production policy requires; resuming rechecks capability and
credential validity. Archive stops operation without erasing retained history.
Hard remove is exceptional and must refuse while prompts, enrollments, records,
evidence, jobs, or retained audit depend on the agent.

Prompt text is versioned operational configuration. `prompt.revise` accepts an
agent ID, title, literal body, and optional base prompt ID and creates a new
immutable version; it never edits an active revision in place. The browser
metadata snapshot omits bodies, while separately authorized `getPrompt` returns
one. A production store should add server-private content digest and safe
actor/reason audit without adding undeclared snapshot fields. `prompt.activate`
moves the agent's prompt head after authorization/review. `prompt.archive` removes
an unused revision from active selection without erasing retention-required
history. Prompt content cannot grant tools, scopes, budget, network access, or
approval authority: the service authorizes every requested operation
independently. Treat prompts as potentially sensitive; do not commit production
prompts to the public skeleton or emit them in general logs/search results.

Enrollment is one-time and purpose-bound. `enrollment.issue` may return a
short-lived value once in the correlated successful result. Persist only a
digest/reference and safe issue/expiry/revocation metadata. Bind the subsequent
proof to the intended agent, runner type, audience, nonce, private endpoint, and
expiry. `enrollment.revoke` invalidates unused issuance and any associated
bootstrap path. After proof, provision a separately scoped, rotated workload
identity in the adopter secret facility. Never put enrollment or runtime values
in a snapshot, browser config, prompt, canonical record, page envelope, or MCP
resource.

The reference workbench accepts the proof at loopback
`POST /api/v1/agents/connection` with the `Enrollment` authorization scheme.
Its document contains exactly
`schemaVersion: "1"`, the issued `agentId`, the issued `enrollmentId`, and a
fresh RFC 3339 `observedAt`; the one-time value is supplied separately as a
transport credential. Successful proof marks that enrollment connected and
updates safe last-seen metadata. It does not open a task, log, or arbitrary
execution channel. A production private endpoint adds workload identity,
purpose/audience binding, replay protection, rate limits, and durable audit.

The shipped narrow reference MCP process publishes this raw manual and public
contract/catalog descriptions as resources. Its seven tools are connector
snapshot/command, administration snapshot/prompt/command, and read-only
setup_guides/setup_check; they call the same
API/RBAC boundary as UI or CLI clients and refuse credential-issuing commands.
The setup pair requires a private service token with optional setup:read and
does not operate in the tokenless workbench. It reads saved guide choices and
local evidence; it does not configure sources or perform an external test.
A production adopter replaces the loopback identity/transport assumptions while
retaining the same service policy. The MCP process must not be a
telemetry transport, secret-entry/readback surface, raw-log search service,
arbitrary HTTP/shell/SQL tunnel, direct database writer, or bypass for human
approval. Tool arguments are untrusted. Apply the same action authorization,
scope binding, idempotency, expected-revision, audit, redaction, and rate/size
policy as UI and CLI clients.

An honest no-provider state says agent management is unavailable. It does not
show sample agents or claim that visible agents are connected. A registered
agent is not necessarily enrolled; enrolled is not necessarily healthy;
healthy does not expand authorization; and a successful task does not prove the
current prompt or permissions are safe.

## 39. Human operating guide: Monitor

Monitor answers what is happening now and whether the observation system can
be trusted. These routes are read projections. Operators do not add or delete
dashboard rows directly; upstream connector, detection, risk, and workflow
services own the records, while route projectors aggregate authorized state.

**Overview (`#/`).** Use this as the posture landing page: collection health,
control readiness, detections, overdue register items, and dated obligations.
It consumes current source-health snapshots, detection/finding state,
control/evidence projections, risks, and obligations. Populate each stable
panel independently so a failed risk projector cannot make collection health
look empty. Add/update/remove data in the owning source: configure sources in
Sources, manage risks/attestations through governance commands, and disposition
findings through their workflow. Archival should remove an item from active
counts while retaining history. With no authorized inputs, show the structural
empty panels and provider absence; never display zero-risk or healthy posture.

**SOC Health (`#/health`).** Feeds shows current acquisition health; Rules never
fired and What is firing use detection execution/correlation telemetry; Drills
uses reviewed drill definitions/results; How to read explains the model. Inputs
include source attempts/accepted deliveries, queue/projector lag, detection run
facts, bounded component failures, and drill state. A source is added through a
manifest-backed setup/test/activate flow, but only accepted observations can
make it healthy. Update cadence/health policy in the source/manifest service,
not in a page row. Use the shipped source pause/archive/remove lifecycle in
section 51; these preserve retained records and do not create detection data.
Empty feeds mean no authorized feed rows, not healthy collection. Unavailable
diagnostics remain unavailable rather than being converted to empty.

**Daily Brief (`#/brief`).** The Brief view prioritizes Do today, Security
brief, and affected review. Turnover groups untouched, in-work, real-threat,
recently dispositioned, retention, and affected review. Analyst briefings links
to the Analyst Hub. Populate it with a server-side, estate-scoped prioritizer
over findings, cases, affected reviews, retention reviews, and explicit handoff
notes. Do not let a client calculate priority from hidden data. Add or update
source records in their owning workflow; create handoff notes through a separate
audited command if implemented. Closing/archive transitions move records out of
active groups without erasing history. With no current work, render an
authorized empty brief; with no provider, say it is not connected.

**Analytics (`#/analytics`).** The 24-hour, 48-hour, and seven-day ranges show
pre-aggregated collection/detection/history measures, a true stacked hourly
series, ranked firing rules, and blocked addresses. A server validates the
range, scope, timezone semantics, binning, late-arrival policy, cardinality, and
redaction before returning `metrics`, `chart`, or `bars` panels with an
accessible table equivalent. Canonical records and projector checkpoints
populate analytics; operators do not add chart points. Rebuild aggregates from
canonical data using a new projector version, then atomically promote it.
Retention removes underlying detail according to policy while preserving only
approved aggregates. Empty series means an authorized window had no values;
missing collection must be shown through Health rather than graphed as zero.

**Timeline (`#/timeline`).** Timeline is the bounded chronological join across
an application-supplied host selector and 15-minute, one-hour, 24-hour, or
seven-day range. Inputs are redacted event/finding/configuration/scan/workflow
summaries with stable IDs and RFC 3339 times. The BFF allowlists the host and
range, enforces estate ownership, caps rows, paginates, and prevents selectors
from becoming authorization oracles. Records are added/updated in source
systems and projected idempotently; correction events supersede rather than
silently rewriting audit history. Retention/archive policy removes detail from
active queries. An empty authorized window is valid; an unknown or forbidden
host returns unavailable/forbidden, never an empty timeline.

## 40. Human operating guide: Respond

Respond turns authorized findings into decisions and controlled actions. Page
envelopes hydrate read models only. Any create, disposition, approval, send,
rule, quarantine, or other action needs an explicit server command contract;
the skeleton never enables it merely because an action label is visible.

**Triage (`#/triage`).** Queue, Awaiting approval, Cases, Closed, and All are
views over stable finding/case identities, ownership, severity, evidence
references, and immutable transitions. Detectors and analysts add findings via
the finding service; an authorized command claims, groups, dispositions,
escalates, or closes them with expected revision and reason. Archive/retention
removes closed items from default views but preserves the case/audit chain.
Bulk operations authorize every selected ID and report partial denial safely;
the browser does not infer success. An empty Queue means no authorized open
items, not that detectors or sources are healthy.

**Detection Tuning (`#/tuning`).** Definitions, Applied alerts, and Matched but
held join versioned detection definitions, retained occurrences, exact finding
references, and analyst recommendations. Add a draft through a dedicated rule
or tuning service, test it against bounded retained data, and require review
before activation. Updates create new immutable definition/recommendation
revisions. Disable/archive removes a definition from active evaluation without
destroying provenance; hard removal is normally refused once occurrences or
decisions depend on it. The checked-in detail/chooser/draft controls are
read-only structure unless such a contract is installed. Empty means no
authorized definitions/occurrences for the selected state.

**Detection Rules (`#/rules`).** Palisade, Sigma, YARA, Snort, and embedded Tune
views catalog definition metadata, provenance, source/effective text, scope,
test status, lifecycle, negative-space decisions, and occurrences. Import is a
server-side parse/validation operation: treat uploaded/pasted definitions as
untrusted, bound size/complexity, prohibit executable/browser markup, and
compile/test in isolation. Add and updates create versioned drafts; activation
requires authorization and rollback; disable/archive preserves provenance and
references. Snort remains a deliberate boundary until a reviewed engine and
contract exist. An empty rules view must not imply the detection engine is
working; SOC Health carries execution health.

**Alert Comms (`#/alerts`).** Path, Paged, Delivery log, and Reconciliation show
who is eligible to receive what, per-attempt delivery state, overflow, and
confirmation reconciliation. Populate them from a redacted routing policy
projection and immutable provider attempts; never expose addresses, provider
tokens, or unrestricted recipient directories. Recipient/routing changes use a
separate privileged policy command. Send/retry/acknowledge commands are
idempotent, finding-bound, rate-limited, and audited. Archive affects display
retention only; it cannot erase evidence that a notification was attempted.
Empty delivery history does not prove reachability—display the configured-path
and connector health independently.

**Honeypots (`#/honeypots`).** Decoys, canaries, trap users, Trip log, and Clerk
honey-account proof are minimal projections of separately managed decoy
controls. A protected infrastructure workflow creates/rotates/disables decoys
and honey identities; the browser receives labels, state, proof/freshness, and
trip summaries only. Never expose seed values, credentials, exact secret
locations, or infrastructure control actions. Archive a retired decoy while
retaining trip evidence; removal is dependency/retention aware. An empty Trip
log means no authorized trip rows, not that decoys are installed or healthy.

**Phishing (`#/phishing`).** The queue shows report summaries; an `id` selects
verdict, redacted message metadata, signal evidence/weights, links,
attachments, passive intelligence, and literal source text. Populate from a
verified inbound report connector, isolated parsers/scanners, safe enrichment,
and an analyst-verdict workflow. Message HTML is never rendered as markup;
links are not automatically fetched or followed. Add reports through the
authorized intake channel, update via versioned verdict/disposition commands,
and archive/remove only under evidence and legal-retention policy. Empty queue
and unavailable mail integration are distinct states.

## 41. Human operating guide: Investigate

Investigate provides bounded views into already authorized data. Query and
selector values are untrusted; the application validates scope, time range,
syntax, cardinality, and resource ownership before reading. Investigation pages
are not alternate ingestion or administration paths.

**Security Logs (`#/logs`).** The query bar, relative/absolute time controls,
host/index selection, syntax help, shortcuts, sort chain, scan state, raw event
rows, and `stats count` structures form a constrained search interface. Sources
populate a canonical/indexed log store through authenticated ingestion; the BFF
compiles the allowed query subset and enforces window/row/field limits. Add logs
only through sources, never browser forms. Corrections and retention follow
source/index policy; operators cannot delete evidence through a search result.
An empty result means the authorized query matched none. Unknown index/host or
backend denial must not be masked as no matches.

**Activity Baseline (`#/activity`).** Go-live/relearn, maturity, first-seen,
elevated, trending, long-tail, normal, and methodology describe a privacy-
governed behavioral model. Populate from approved canonical features and a
versioned training epoch; exclude protected/high-cardinality data unless policy
permits it. Starting or relearning is a separate privileged job command with
scope, budget, approval, checkpoint, rollback, and audit. Archive superseded
epochs while retaining methodology and decision provenance. Empty/unavailable
means the model has no authorized mature output, not normal behavior.

**IOC Parser (`#/ioc`).** Paste anything is an explicit bounded request to
extract normalized IP/domain/URL/hash candidates and run approved internal or
external enrichment. Limit bytes, item count, parser complexity, outbound
providers, and result cardinality; treat all content as untrusted and avoid
retaining input unless policy says so. The request creates an ephemeral or
audited hunt job, not a new permanent IOC by default. Promotion into a watch
list needs a distinct command and provenance. Clear/expiry removes ephemeral
job data under policy. Empty extraction means no valid supported indicator was
found; provider failures remain visible.

**Threat Intel (`#/intel`).** Bulwark Black, OTX, ThreatFox, URLhaus,
MalwareBazaar, and all-feed views combine source-specific status/freshness,
lookups, sync state, indicator kinds, outbound destinations, and recent pulses.
Install one reviewed connector per feed/provider with license/distribution
policy, server-side credential references, cursors, rate limits, and canonical
indicator/sync records. Add/update through feed sync and governed manual intel
commands; expire/archive indicators based on provenance and TTL without erasing
history. Removing a connector stops future collection and revokes credentials
but follows dependency policy for retained records. Empty feed and stale/
failed sync are never conflated.

**Known IPs (`#/known-ips`).** Operator egress, tailnet, estate, and manual
registries use one address-class model with ownership, provenance, expiry, and
review state. Automated registries come from network/asset sources; the manual
two-field form requires an authorized command that validates canonical address,
class/scope, duplicate/overlap rules, reason, and expiry. Update creates a new
revision; archive expires or supersedes without erasing prior detection-use
decisions; hard removal is retention aware. The detection engine consumes a
versioned approved snapshot, never DOM rows. Empty means no authorized entries
in that registry class, not that observed addresses are safe.

## 42. Human operating guide: Vulnerability Management

Vulnerability Management combines scanner observations with asset identity,
policy, evidence, and remediation workflow. A scanner finding is an input, not
an automatically accepted risk or remediation decision. Every tab must show
its connector/run freshness and coverage separately from result counts.

**Scans (`#/scans`).** The route selects Trivy, Patch first, File integrity,
End of life, External surface, IOC scan, urlscan.io, Dependencies, DLP Upload
AV, Quarantine, or inline Remediation. Each connected tab needs an installed
manifest, a server-side driver/receiver, opaque credential references, typed
normalization, accepted-record storage, independent health, and one or more
idempotent projectors. Use Sources or an authorized agent/CLI control client to
configure/test/activate it. The checked-in registry now supplies one validated,
data-only manifest template for every scan tab. The templates make the exact
connector/source-kind choice, non-secret config fields, and opaque credential-
reference slots available in Sources; they make no network calls and ship no
scanner drivers. The loopback runtime permits a template-backed
`source.setup`, then fails `source.test` and `source.activate` closed with an
explicit driver-not-installed error. It never issues a scan-template ingest
credential or reports an active source. An adopter must review or replace the
template and install its server-side driver, normalizer, admission path, and
projector before testing can succeed. Update config with revisions and retest
before promotion.
Archive/disable/revoke behavior requires a reviewed source-lifecycle extension;
hard removal must account for records, evidence, jobs, and audit. With no
compatible source, show how to connect one and an honest no-source state—never
sample findings, a zero total, or a healthy badge.

**Remediation (`#/remediation` and the Scans Remediation tab).** Both locations
read the same remediation model: latest VM review, an append-only six-field
record form when an authorized command is installed, and record cards. Create
only from an authorized finding/review or explicit human assertion, with stable
record/finding/asset IDs, safe description, state, due/verified timestamps,
evidence references, and future concern. Updates are immutable transitions with
expected revision and reason; closing requires verification policy; archive
removes from active work while retaining history. Hard removal is exceptional
and refuses when risks, attestations, evidence, or retention depend on it. Page
envelopes never enable the form. Empty remediation does not mean scans are
clean.

## 43. Human operating guide: Estate

Estate describes what is owned, how it is observed, and whether evidence-
bearing controls are operating. Stable application, host, asset, database,
backup-chain, retention-source, connector-instance, and source IDs must survive
label changes. Avoid joining solely by hostname or display name.

**Systems (`#/systems`).** Estate combines external attack surface, inventory,
known-exploited/software-match data, and explanatory context. Are we affected?
adds latest review, open items, and methodology. Populate asset identity from
authoritative inventory/agent/cloud sources, then join normalized exposure,
software, vulnerability, and advisory records with confidence and freshness.
Register assets through their owning inventory service; merge/retire/archive
with immutable alias/history rules. Hard deletion follows retention and
dependency policy. Reviews use a separate governed workflow. Empty inventory
means no authorized systems data, not no systems or no exposure.

**Databases (`#/databases`).** Schema watch and change tables show structural
inventory and reviewed differences; adding-database/methodology panels explain
integration. A database connector should have least-privilege metadata-only
access, approved schema scope, cadence, baseline epoch, and a credential
reference—never connection secrets or record contents in page output. Add the
database as a manifest-backed source, take an authorized baseline, and project
changes. Update scope/credential by revision and retest. Disable/archive stops
watching and retains approved history; removal revokes access and obeys evidence
dependencies. Empty change history is not proof that the watcher is connected;
surface source health independently.

**Backups (`#/backups`).** Backup-chain push, independent bucket pull
verification, off-box receipts, adding-chain guidance, and rationale form a
two-sided evidence model. Backup systems emit signed/authorized job facts;
independent verification reads least-privilege object metadata or evidence,
never backup contents in the browser. Add each chain/verifier as its own source
with separate credentials and health. Update destinations/policy by version;
archive retired chains while preserving recovery evidence; remove only after
retention/legal dependencies and credential revocation. Empty receipts or
stale verification is not backup success.

**Retention (`#/retention`).** Policy shows approved declarations and gaps;
Reality shows measured source/store horizons and archived baselines; Review
shows the latest analyst assessment and methodology. Policy records come from a
governed configuration service; measurement workers calculate bounded facts
from inventories/stores; reviewers create immutable assessments. Add/update
policy through approval and effective dates, never by editing table cells.
Archive superseded declarations/baselines and preserve their effective periods.
Removal follows legal/records policy. Empty measurements mean not measured or
no authorized inputs, never compliant retention.

**Sources (`#/sources`).** Expected sources is the dead-man board with What it
does, Why it matters, and If it goes quiet context. Add selects a registered
app/host and installed connector/source kind, renders manifest-owned non-secret
config and credential-reference slots, and performs setup/test/activate.
Registry Changes is the safe audit ledger. Register the app and enroll/prove its
host first when required. Test does not ingest or establish health; activation
does not become healthy until an accepted observation. Use the shipped
update/pause/resume/archive/remove/revoke/rotate commands described in section
51. With no
connector provider or installed compatible manifest, controls stay disabled.

**Agent Management (`#/agents`).** Agents, Add Agent, Prompts, Enrollment, and
History show safe identity, lifecycle/connection, prompt-head, capability, and
revision metadata. Management controls are enabled only with a validated
administration provider. Use the exact `agent.*`, `prompt.*`, and
`enrollment.*` commands in chapter 38. Prompt metadata is in the snapshot;
prompt bodies require a separate authorized `getPrompt`. One-time enrollment
output appears once and credentials never appear in snapshots. Pausing and
archiving stop new work but do not erase retained history. Empty means no
authorized registrations; it does not imply no automation exists elsewhere.

## 44. Human operating guide: Govern

Govern holds decisions whose history and evidence matter. It uses the separate
administration provider for mutations and the page provider for authorized read
projections. Browser-visible rows are never the system of record.

**Attestations (`#/attestations` and `#/attestation`).** The index shows
attestation, lifecycle state, and path to its attestable subject; detail shows
the selected record and safe evidence references. Create through
`attestation.create`. Version 1 accepts bounded title, description, owner, and
due time; stable subject/control/remediation and evidence-reference fields are
an adopter production extension that must version the contract. Update mutable
metadata with the current governance snapshot revision. Transition only through the allowed contract
statuses and adopter policy in chapter 47, recording actor/reason/time and safe
evidence references server-side. Archive uses the explicit `archived` status.
Prefer archive; remove only when unreferenced or retention policy permits and
preserve the required tombstone/audit. Empty means no authorized attestations,
not that controls are attested.

**Risk Register (`#/register` and `#/risk`).** The
register groups overdue, closures awaiting documentation, and next dated
obligations. Create through `risk.create` with stable risk ID,
scope/asset/finding references, bounded title/description, likelihood/impact or
approved scoring inputs, owner, review/due policy, treatment, and evidence
references. Version 1 accepts title/description, owner, likelihood, impact, and
review time; richer scope/treatment/evidence relationships are adopter
extensions. Update mutable facts using the current governance snapshot revision;
transition through contract statuses with justification and production-required
approvals/evidence.
Archive moves the record to explicit `archived`; server history may retain the
previous operational status. Restore rechecks references and permissions. Hard
removal is exceptional and dependency aware. Empty register means no authorized
records, not zero risk.

**Access (`#/access`).** In the private starter, Who shows current-session
context, the exact provisioned-account count, and the first 200 operator display
names with full authority. It does not invent visitors, tailnet devices, or a
read-only auditor role. Observations (`?atab=observations`) displays imported
identity, authentication, audit and offboarding facts without granting access;
the remaining private-mode tabs show the same explicitly labeled facts, not
native certification or offboarding workflows. In a fuller
integration, Who projects identity/owner/visitor/device/auditor
access; Refusals and Chain preserve denied-request and certification evidence;
Offboarding shows summary/run records and selected detail; How to use explains
the workflow. Populate from identity, device, entitlement, application-owner,
and audited certification/offboarding services. Provisioning/revocation,
certification decisions, refusal, and offboarding steps require explicit,
resource-specific commands and current authorization. Page rows never grant or
revoke access. Archive completed certifications/offboarding runs under evidence
retention; removal cannot erase chain/refusal history. Empty Who or Offboarding
is not proof that there are no identities or outstanding access.

**Documents (`#/documents`).** Upload approved files to the private versioned
library, inspect hash/version/history, edit owner/status/review metadata, and
archive/restore while retaining evidence. Adding a version appends immutable
bytes; it does not overwrite the old version. App/risk/attestation/case/policy
links are metadata pointers, not evidence approval or imported governance rows.
All starter operators can access this library. The detailed human workflow,
HTTP API, quotas, and untrusted-file limitations are in section 50.

## 45. Human operating guide: shell and linked routes

**Onboarding (`#/onboard`).** Register application creates stable app/host IDs;
connect each host issues one-time enrollment material and requires a separate
connection proof. The connector provider enables only `app.register` and
`host.enroll` here. Optional public-page fields accept approved HTTPS pages,
not private endpoints or credentials. App/host update/archive/remove is not in
connector v1 and must not be simulated in the browser. Without a connector
provider, the route is a disabled guide and contains no sample registrations.

**Settings (`#/settings`).** The board sequence documents where application-
owned settings would appear. Browser-safe display preferences may be local;
security policy, connector configuration, detection state, routing, roles, and
secrets require separately versioned authorized server workflows. Add/update
settings only from an allowlisted schema with revision, validation, audit, and
rollback. Archive superseded policy versions; do not hard-delete history. A
disabled field means no integration, not a saved default.

**Technical Docs (`#/docs`).** This shell-owned route reads only the generated
copy of this checked-in manual. The chapter navigation/filter are local
presentation controls. No page, connector, or administration provider is
called. Agents should use the raw Markdown resource. Update the Markdown,
rebuild deterministically, and run `npm run check:docs`; do not hand-edit the
generated JavaScript. Documentation contains public structure and contracts,
never live values, secrets, internal topology, prompts, or security evidence.

**Analyst Hub (`#/analyst`).** Briefings, cases, rules, vulnerability, affected,
and retention views are scoped analyst work projections linked from Daily
Brief. Populate from the same underlying workflow read models, not duplicate
records. Actions use the owning workflow commands. Empty means no authorized
items for the analyst/scope.

**Event (`#/event`).** A stable event selector returns a redacted canonical
event projection plus authorized correlations. Validate ownership and selector;
literalize all fields. Events arrive and age out through source/retention
policy; the detail page does not edit/delete them. Unknown, expired, and
forbidden are distinct.

**IP (`#/ip`).** A validated address selector joins verdict, explicit
Shodan/OTX states, detections, and log events. Public enrichment runs through
server connectors under policy and rate limits; never fetch from the browser.
Manual classification uses the Known IPs command path. No matches, unavailable
provider, and forbidden address scope are distinct.

**Search (`#/search`).** Dispatch classifies a bounded IP, CVE, host, case,
rule, page, or fallback log query. The application-owned index authorizes every
candidate and must not leak hidden object existence through timing/count/error
differences. Search adds or removes no records; source/projector indexes own
their lifecycle. Empty means no authorized match.

**Host Scan (`#/host-scan`).** A host selector shows a bounded scan projection
from the installed scanner/asset services. Starting/canceling a scan needs a
separate job command with target allowlisting and concurrency policy. The page
does not turn a selector into arbitrary scan authority. Unknown/forbidden host,
never scanned, queued, partial, failed, and completed-empty are separate states.

**KEV (`#/kev`).** A selected vulnerability/advisory joins the pinned
known-exploited dataset to authorized assets/findings. Feed connectors own add/
update/expiry, while analyst risk/remediation decisions use governance/workflow
commands. Empty affected assets does not imply feed freshness or complete
inventory.

**Source (`#/source`).** A stable source selector projects safe manifest,
ownership, lifecycle, health, cadence, and change history. Configure/test/
activate from Sources; credentials remain references. Future disable/archive/
remove commands must preserve records/audit and revoke proof. Unknown,
forbidden, disabled, offline, and no-delivery states are distinct.

**Attestation detail (`#/attestation`) and Risk Detail (`#/risk`).** These
routes select one authorized governed record and immutable transition/evidence-
reference history. Mutations call administration commands, then reread; query
selectors never grant permission. Deleted-under-policy records return a safe
tombstone/unavailable state rather than silently resolving to another record.

## 46. Scan-by-scan connection and projection matrix

The skeleton ships one validated version-one **connection template** for every
row below. A template is a declarative manifest, not a vendor driver: it
declares one host-scoped enrolled runner, exact `/scans` panel IDs, canonical
record kinds, non-secret config schema, health policy, and opaque credential
slots. It performs no HTTP, process execution, filesystem scan, callback,
secret resolution, normalization, or ingestion. In the loopback workbench it
may be configured so an operator can inspect the intended registration, but
its test fails closed and it can never activate. Review or replace it and bind
an adopter-owned server implementation before claiming connectivity.

Following a scan tab's **Set up this scan source** link passes a closed
`setupFor` identifier. Sources selects the one exact matching template and
source kind. Only that manifest's controls are visible and enabled; required
fields belonging to other manifests do not participate in native validation or
command serialization. Switching connector types preserves non-secret draft
values only in the current DOM. The application stores no API key, bearer
token, certificate, password, or other credential value in browser state.

| Scans view | Shipped connector/source kind | Exact non-secret config fields after cadence | Opaque credential slots | Primary normalized projection |
| --- | --- | --- | --- | --- |
| Trivy | `trivy-template` / `trivy.scan` | `collection-mode`, `scan-target`, optional `scanner-endpoint`, `severity-threshold` | optional `registry-access`, `scanner-access` | `scan.result`, `software.package`, `vulnerability.finding` to `trivy-operating-system-packages`; optional asset/remediation correlation |
| Patch first | `patch-first-template` / `patch-first.feed` | `provider-endpoint`, `platform-scope`, `prioritization-mode`, `grace-period-seconds` | required `provider-access` API-key reference | package/finding facts to `patch-first`; optional scan/intel/remediation correlation |
| File integrity | `file-integrity-template` / `file-integrity.event` | `path-scope`, optional `exclusion-patterns`, `digest-algorithm`, `baseline-policy` | optional `collector-access` | `file.integrity` to `file-integrity-critical-files-and-canaries`; optional asset/heartbeat correlation |
| End of life | `end-of-life-template` / `end-of-life.inventory` | `catalog-endpoint`, `product-scope`, `warning-horizon-seconds` | optional `catalog-access` API-key reference | package lifecycle facts to `end-of-life-runway`; optional asset/vulnerability correlation |
| External surface | `external-surface-template` / `external-surface.scan` | `scanner-endpoint`, `target-cidrs`, `allowed-ports`, `scan-profile` | required `provider-access` API-key reference | asset/scan facts to `external-attack-surface-shodan` and `sweep-history`; optional network/vulnerability/heartbeat correlation |
| IOC scan | `ioc-scan-template` / `ioc.scan` | `indicator-endpoint`, `scan-paths`, `match-kinds`, `ruleset-label` | optional `feed-access` | finding/scan facts to `ioc-scan-is-anything-on-disk-a-known-bad-file`; optional asset/endpoint/integrity/intel correlation |
| urlscan.io | `urlscan-template` / `urlscan.result` | `api-endpoint`, `url-scope`, `submission-visibility`, `watch-mode` | required `api-access` API-key reference | network/scan facts to `our-pages-rendered-from-outside` and `url-history-results`; optional finding/heartbeat correlation |
| Dependencies | `dependency-template` / `dependency.inventory` | `inventory-source`, `ecosystem-scope`, optional `advisory-endpoint`, `import-format` | optional `source-access`, `advisory-access` | package/finding facts to `dependency-advisories`; optional scan/remediation correlation |
| DLP Upload AV | `upload-av-template` / `upload-av.event` | `scanner-address`, `upload-scope`, `maximum-object-bytes`, `detection-action` | optional `scanner-access` | endpoint/finding facts to `upload-malware-scanning-clamav-at-the-door` and `recent-scan-events`; optional asset/heartbeat correlation |
| Quarantine | `quarantine-template` / `quarantine.event` | `store-endpoint`, `namespace`, `retention-seconds`, `retrieval-policy` | required `store-access`, optional `encryption-access` | endpoint/finding facts to `quarantined-now` and `deleted-from-quarantine`; optional audit/remediation correlation |
| Remediation | `remediation-template` / `remediation.record` | `workflow-endpoint`, `project-scope`, `synchronization-mode`, `verification-policy` | required `workflow-access`, optional `evidence-store-access` | remediation facts to `vm-analyst-latest-review` and `remediation-log`; optional evidence/attestation correlation |

For API-key products, the browser should invoke a protected write-only
provisioning flow. The server validates the session/action, stores the value in
a managed secret backend, and returns only store/reference plus safe
version/expiry metadata. `source.setup` binds the reference; the driver resolves
it just in time under its workload identity. Rotation creates a new secret
version, tests it, atomically rebinds or rolls the connector, then revokes the
old value. Neither UI nor MCP offers readback.

Health must distinguish provider reachability, authentication failure, source
coverage, stale vendor/signature database, queued/running/partial/failed run,
accepted complete run, completed with zero findings, and projector lag. A
source test, activation, or empty results table is never sufficient evidence
that scanning works.

## 47. Attestation and risk lifecycle protocol

Governance writes use `SOC_CONSOLE_ADMINISTRATION`, not page panels. Every
request has a unique request ID, actor/session established by the server,
`requestedAt`, the exact current administration snapshot revision (including
create requests), and a typed payload with a bounded note where supported.
Every result is correlated and then followed by a fresh
domain snapshot/page read. The server atomically commits entity state,
transition history, outbox/projector work, and durable audit or commits none.

### Attestations

The version-1 statuses are exactly `draft`, `pending`, `attested`, `expired`,
and `archived`. Richer review labels such as blocked or attestable are not
version-1 enum values; an adopter must version the contract before adding them.

- `attestation.create` creates a stable draft with bounded title and optional
  description, owner, and due time. Version 1 intentionally has no evidence body,
  credential, signed URL, or unrestricted subject object.
- `attestation.update` changes only title, description, owner, or due time using
  the exact expected registry revision. It cannot rewrite identity or history.
- `attestation.transition` accepts a non-archived contract status and a bounded
  note. The loopback reference runtime demonstrates draft to pending; pending
  to attested or expired; attested to expired; and expired to pending. A
  production server may be stricter and should require evidence/reviewer policy
  before attested, but it cannot emit a new undeclared status.
- `attestation.archive` moves the version-1 status to archived.
  `attestation.restore` returns a reference-workbench record to draft after
  revalidating authorization. Production services may preserve the previous
  status in server history, but may not add it silently to the closed snapshot.
- `attestation.remove` is accepted by the reference runtime only after archive;
  it removes the active record and preserves an audit tombstone. Production
  policy should additionally refuse evidence-linked/retained records. Prefer
  archive.

Evidence references use stable IDs, approved store/type, content digest,
captured/valid-through time, classification, and verifier metadata. The BFF
authorizes dereference separately. Never store a signed URL, credential, raw
artifact body, or mutable path as the only evidence identity.

### Risks

The version-1 statuses are exactly `open`, `mitigating`, `accepted`, `closed`,
and `archived`. Monitoring or closure-requested may be production workflow
concepts, but they are not version-1 status values.

- `risk.create` creates a stable open record with bounded title, optional
  description/owner/review time, and required likelihood and impact selected
  from low, moderate, high, or critical. Asset/finding/control relationships,
  treatment, approvals, and evidence references require a versioned production
  extension. The server owns any official score.
- `risk.update` changes permitted title, description, owner, likelihood, impact,
  or review time using the exact expected registry revision. Production policy
  may require approval for material changes and keeps prior values in audit.
- `risk.transition` accepts a non-archived contract status and bounded note. The
  reference runtime demonstrates open to mitigating or accepted; mitigating to
  accepted or closed; accepted to mitigating or closed; and closed to open.
  Closing requires a note. A production implementation should require its
  evidence/approval policy but cannot let clients jump around server rules.
- `risk.archive` moves the version-1 status to archived. `risk.restore` returns
  a reference-workbench record to open after authorization. Production may
  retain the previous status in server history without exposing undeclared
  fields.
- `risk.remove` is accepted by the reference runtime only after archive and
  preserves an audit tombstone. Production must additionally refuse while
  findings, remediation, attestations, obligations, evidence, approvals,
  tickets, or retention depend on it.

Overdue, closures awaiting documentation, and next dated obligations are read
projectors over these records and their effective dates. A projector does not
transition a risk merely because a clock elapsed; a scheduled policy worker may
create an audited transition or due-state fact. Archive/remove must invalidate
and replay affected projectors. Empty groups mean no authorized matching
records, not zero organizational risk.

## 48. Runnable private starter and capability status

The default `npm start` is now a real private application, not the static visual
preview. It serves the original product UI behind Better Auth sign-in and
mounts the source, administration, document, and supported read services.
Everything starts empty. The operator supplies their own approved app records,
sources, logs, prompts, governance records, and documents; none are seeded or
committed to the public repository.

Choose the mode deliberately:

| Command | Purpose | Identity and state |
| --- | --- | --- |
| npm start -- --state-dir /absolute/private/bb-soc-state | Private single-tenant starter | Real operator accounts and sessions; persistent external state; full-access operators |
| npm run start:static | Empty UI inspection | No API, auth server, uploads, or persistent writes; loopback only |
| npm run start:connectors -- --state-dir /absolute/private/disposable-state | Disposable connector/administration contract workbench | Synthetic local operator; never expose remotely or use as a deployment |
| npm run --silent start:agent-mcp | Narrow stdio integration tooling | Private service client with --token-file and --base-url; tokenless loopback workbench mode |

The private service always binds to `127.0.0.1`. Its default local origin is
`http://127.0.0.1:8080`. For sharing, put private Tailscale Serve in front of the
listener and pass the exact HTTPS machine origin through `--origin`. That origin
must end in `.ts.net`. Never use Tailscale Funnel, public ingress, or a wildcard
bind. A successful HTTPS connection is not enough: verify ACL/grant denial and
failure to reach the service from outside the tailnet. Keep exact Host and
Origin values intact through the proxy.

**Current capability matrix**

| Area | Implemented now | Not implied |
| --- | --- | --- |
| Sign-in | Better Auth email/password, optional TOTP/backup-code 2FA, SQLite sessions, local account CLI, closed signup, sign-out and revocation | Enforced MFA policy, SSO, mail delivery, tenant isolation, operator-specific roles |
| Access → Who | Current-session explanation, exact account total, first 200 provisioned operator display names and full authority | Access-event telemetry, refused-write/device/offboarding feeds, or a read-only auditor role |
| Sources | Web-app/environment registration, optional hosts, canonical event setup/test/activation, lifecycle/credential maintenance | Arbitrary vendor installation, secret manager, pull scheduler, OTLP/syslog receiver |
| Telemetry | Indexed SQLite admission, transactional receipts/health/audit, bounded indexed reads and explicit retention | Unlimited SIEM scale, all record kinds/every screen, detection/notification engine |
| Documents | Upload/download, immutable versions, SHA-256 verification, metadata/status/review date, archive/restore and audit history | Antivirus, OCR, document search, automatic content classification, legal hold/purge, risk Markdown import |
| Agent management | Registrations, prompt versions, enrollment proof and lifecycle | Running agents, task scheduling, run leases, result queues, observed job health |
| Agent service access | Human-only credential issuance, exact scopes, expiry, rotate/revoke, durable rate windows and stdio MCP authentication | Per-app RBAC, tenant isolation, remote MCP/OAuth listener, agent execution |
| Governance | Flat attestation/risk records and audited lifecycle commands | Attestation programs/checklists, verified legal acknowledgement receipts, evidence approval automation |
| Scan surfaces | Working Trivy report import and projection plus eleven legacy setup templates | Scanner execution, vendor API polling; the legacy templates still fail test/activation closed |
| Other routes | Full structural navigation/design and page contracts | Actual source coverage or populated panels without an implemented projector |

Canonical log push currently feeds Overview, Sources, Logs, Analytics, and SOC
Health. The document library and administration workflows use their own service
state rather than pretending a log entry is a document, prompt, attestation, or
risk. The 40-path catalog consists of 38 SOC paths, Documents, and Technical
Docs; 30 are primary destinations, nine are linked details, and Docs is local
implementation guidance.

**First-use acceptance sequence**

1. Install dependencies and provision the operator using section 49.
2. Start with a new persistent external directory and confirm there are no
   accounts other than the locally provisioned operator and no operational data.
3. Sign in, register a web application with an environment and no host, and
   configure canonical-push with the intended cadence.
4. Test the bounded sample, activate after approval, and transfer the one-time
   ingest credential to the approved sender without placing it in a transcript.
5. Submit one authorized real event through the ingest contract, confirm its
   receipt, and inspect the five supported projections. Do not fabricate a
   log merely to make a screen look populated.
6. Upload an approved document; inspect the saved hash and immutable version;
   change metadata and archive/restore without changing the file bytes.
7. Stop and restart with the same directory. Confirm account/session validity,
   source state, records, receipts, document bytes, versions, and audit history.
8. Verify anonymous denial, sign-out/revocation, stale revisions, source pause
   and revoked credentials, document quota handling, and a private backup restore.

## 49. Private account setup, authentication, and recovery

Use Node.js 22.13 or newer. Install exactly the dependency versions in the
lockfile. Better Auth and SQLite run inside this service; an external identity
server and SMTP provider are not required.

~~~sh
npm ci
npm run account -- create --state-dir /absolute/private/bb-soc-state --email operator@example.invalid --name "SOC operator"
npm start -- --state-dir /absolute/private/bb-soc-state
~~~

Replace the example identity and state path locally. The state path must be
absolute, outside the checkout, owned by the service account, and canonical
with no symbolic-link ancestors. The application creates/tightens the directory
to mode 0700 and private auth files to 0600. On macOS, `/tmp` and `/var` can be
aliases; use their resolved paths. For a deployment, choose persistent storage,
not a temporary workbench directory. Restart with the same path; pointing to a
new empty directory creates a different empty deployment, not a recovery.

On a new installation you may instead start the app without pre-provisioning,
visit its sign-in page directly at the configured localhost origin, and use
**Create your administrator account**. Enter your name, email, password and
confirmation. After creation, sign in normally; setup does not create a session
or return a credential. The normal public signup endpoint remains disabled.
The form closes permanently after the first account, including a CLI-created
account. Existing installations continue to show ordinary sign-in. There is no
shared default password or forced initial password replacement.

Browser bootstrap requires configured HTTP loopback, a direct loopback peer,
matching Host/Origin, no forwarding headers, and no machine Authorization.
It is unavailable at a configured Tailnet HTTPS origin. Complete it locally
before enabling the private proxy, or use the CLI on that host. On a shared
machine provision with the CLI before starting the listener: loopback access
does not authenticate an OS user, and another local process can reach it. Never
expose an uninitialized instance through a proxy that strips forwarding headers.

GET /api/v1/first-run returns schemaVersion, setupRequired and
browserSetupAllowed. POST accepts exactly name, email, password and
confirmPassword as JSON (16 KiB maximum); success is 201 with schemaVersion
and created=true only, no session cookie. Unknown keys, queries, compression,
mismatched passwords and invalid input fail. At most one attempt runs at once,
with five attempts/minute per server process; malformed form requests count.
Restart resets that throttle, not setup completion. Closed setup returns 409.

The privateBootstrapState singleton in auth.sqlite commits permanent completion
atomically with the user, password hash and account audit. The condition is
rechecked after hashing inside an immediate transaction. Existing operators or
historical account-create audit close bootstrap during upgrade. Completed setup
cannot reopen merely because all accounts are later removed. Missing/corrupt
completion state fails closed; use trusted backup or local account recovery,
never delete authentication state to regain setup. Restoring a pre-bootstrap
backup restores that earlier state; this is not an external tamper-proof ledger.
Additional operators and password recovery continue to use the local CLI.

The account command requests a hidden password and confirmation. Passwords must
contain 15–128 characters with no control characters. Generate a unique password
with a password manager. Email is the login identifier; the starter does not
send messages or verify mailbox ownership. There are no default credentials and
no public sign-up endpoint. Running create again adds another approved operator;
duplicate emails fail without overwriting an account.

The optional `--password-stdin` accepts one bounded password line for an
authorized password-manager pipe. It does not permit password arguments,
password environment variables, automatic password generation into logs, or
copying a person's browser cookies into an agent. Do not construct the pipe with
a shell command containing a literal password. An agent can arrange deployment,
but credential custody remains with the operator and their password facility.

All accounts have full operator authority over this one deployment. There are
no reader/administrator roles, app-specific memberships, or multiple tenants.
Do not invite a person who should see only part of the estate until that
authorization model is implemented. Private network membership also does not
grant app access: the browser still needs a current application session.

Access → Who shows the current-session explanation, total provisioned account
count, and the first 200 operator display names with full read/write authority.
Names are display labels and may not be unique. This bounded account projection
does not create access telemetry, tailnet devices, or offboarding records.
Sources can independently send identity/authentication/audit/offboarding facts
to Access → Observations; those claims never change Who or local permissions.
A structural auditor panel does not mean a read-only auditor role exists.

**Authentication mechanics**

Better Auth hashes passwords with scrypt. The application generates a 32-byte
secret and stores it in `auth-secret`; accounts, password hashes, sessions,
throttle state, and local account-management audit live in `auth.sqlite`.
SQLite uses WAL and `synchronous=FULL`. The secret is not in environment-facing
browser configuration. Existing auth data with a missing or corrupt secret
fails startup; the service does not silently replace its signing identity.

Sessions last a fixed eight hours without sliding refresh or a cookie-cache
authorization fallback. Cookies are host-only, HttpOnly, SameSite=Strict, and
Secure on Tailnet HTTPS. Local loopback HTTP omits Secure intentionally.
Successful browser auth JSON has its session token removed. The console auth
projection contains only authenticated state, approved display name/initials,
and presentation capability hints. Every protected API call rechecks the
server session, not a browser flag.

The auth HTTP allowlist contains POST sign-in/email, sign-out,
change-password, GET get-session, and the factor routes described below under `/api/auth/`. Other library routes,
including signup, reset-email, arbitrary user updates, and administrative user
creation, are not exposed. Auth JSON is capped at 16 KiB. Cookie-authenticated
mutations require the exact configured Origin; Host and Fetch Metadata are
checked too. The private application also offers GET `/api/v1/session` for the
closed console projection.

Persistent rate limits permit ten sign-in attempts per minute per connecting
socket address, five password changes, and a general auth limit of 100.
Forwarded IP headers are not trusted. A loopback proxy can cause multiple
operators to share a bucket; document this conservative behavior before a
larger deployment. This is not a per-user lockout or an MFA replacement.

**Optional account 2FA**

Open Account security at /sign-in?mode=security (linked from Setup checklist).
Better Auth protects both local and Tailnet access; TOTP is optional per account,
not enabled automatically or enforced across the deployment. Confirm your
password, manually add the displayed key/URI to a trusted authenticator, save
the ten one-time backup codes privately, then prove a six-digit authenticator
code. Only successful proof activates protection. Activation revokes all
sessions; sign in again. No external QR service or browser persistence is used.

Enrolled accounts must complete a five-minute factor challenge after password
verification; password success alone creates no application session. Use a
current authenticator code or one unused backup code. No trusted-device bypass,
SMS or email OTP is supported. To disable, sign in with your factor/recovery
code and confirm your password in Account security; sessions are revoked again.

GET /api/auth/two-factor/status returns only the current account's status.
POST enable/disable under /api/auth/two-factor/ accepts exactly password;
POST verify-totp/verify-backup-code accepts exactly code. Each factor POST has
a durable five-attempt/minute address limit; repeated invalid sign-in factors also use
the library's ten-failure/fifteen-minute account lockout. TOTP can be phished:
retain Tailnet-only reachability and never paste codes into an AI conversation.

The factor schema is added to auth.sqlite on upgrade without enabling existing
accounts. Protect the encrypted factor state and auth-secret together. Back up
the complete stopped state before upgrade. Password reset/session revoke clears
pending challenges but does not remove the factor. If both the authenticator
and backup codes are lost, there is no web reset bypass; the owner needs reviewed
local recovery or a separate CLI-provisioned operator. Do not erase auth state.
See docs/AUTHENTICATION.md for enrollment, limits and recovery details.

**Recovery and revocation**

~~~sh
npm run account -- reset-password --state-dir /absolute/private/bb-soc-state --email operator@example.invalid
npm run account -- revoke-sessions --state-dir /absolute/private/bb-soc-state --email operator@example.invalid
~~~

Reset changes the hash and revokes all sessions atomically. Revoke-sessions
leaves the password unchanged. Both require local state-directory authority and
write a transactionally linked account-management audit record. Web password
change requires the current password and revokes other sessions. Sign-out
revokes the current application session; there is no upstream SSO provider to
log out in this configuration.

For backup, stop the application and account CLI writers before copying the
whole external state directory securely. Include auth-secret, every SQLite
database and any WAL/SHM files, document versions, connector/administration state
and audit, and receipts. Copying a live main database alone can omit committed
WAL transactions. Encrypt backups and test restore under the same ownership and
restrictive modes in a separate private directory. Preserve the compatible code
and package-lock revision. Never fix corruption, a missing secret, an incomplete
audit operation, or a lock by deleting state. Inspect and recover deliberately.

## 50. Documents: human workflow and HTTP integration

Govern → Documents (`#/documents`) is the private file library. Use it for
policies, compliance evidence, case material, or other approved documents the
SOC must retain. It is separate from telemetry about files uploaded to a
monitored application. An application upload event, AV result, or quarantine
record remains telemetry and does not automatically copy that user's file into
this library.

**Human workflow**

1. Open Documents while signed in. Supply a title, choose the approved local
   file, and optionally add app ID, owner, status, review date, and a linked
   record kind/ID. Upload creates document revision 1 and immutable file version 1.
2. Open the saved document to inspect size, SHA-256, uploader identity, saved
   time, versions, and recent audit history. Download a specific version to
   retrieve its original bytes; no browser preview executes the file.
3. Edit metadata with the current document revision. Status is draft, current,
   needs-review, or retired. A review date is a real YYYY-MM-DD date. These are
   operator assertions, not automatic compliance or malware verdicts.
4. Upload a replacement as a new version of the same document. It appends bytes
   and history; old versions cannot be overwritten. Metadata updates are a
   separate operation, so a version upload cannot silently relabel the record.
5. Archive a document to remove it from the active view while retaining all
   bytes, versions, links, and history. Restore it before editing or adding a
   version. Archive state is separate from the review status retired.
6. Refresh after a revision conflict, inspect the intervening change, and make
   a deliberate new request. Never increment a revision blindly to overwrite
   another operator. There is no permanent-delete UI or automatic quota purge.

Document links accept risk, attestation, case, or policy plus an opaque stable
record ID. App and linked-record IDs are metadata pointers in this first slice:
the document store validates their shape but does not check another service's
foreign keys or enforce relationship-specific permissions. All operators can
access all documents. Linking a file to a risk does not close that risk, approve
its evidence, populate a case-attachment panel, or import a risk-register table.
Those richer cross-service workflows remain future integration work.

**Private HTTP surface**

All endpoints require a current operator session. Mutations require the exact
same-origin request controls; actor identity is derived on the server, never
accepted from an upload metadata field.

| Method and path | Request and result |
| --- | --- |
| GET /api/v1/documents | List with optional archived=active/archived/all, appId, offset, limit; default 50 and maximum 100 rows |
| GET /api/v1/documents/{id} | Document metadata, newest-first immutable versions, and up to 200 newest audit entries |
| POST /api/v1/documents/upload | Raw application/octet-stream bytes plus bounded X-Document-Metadata header; returns saved document/history |
| PATCH /api/v1/documents/{id} | JSON expectedRevision and patch of permitted metadata fields |
| POST /api/v1/documents/{id}/archive | JSON expectedRevision and optional reason |
| POST /api/v1/documents/{id}/restore | JSON expectedRevision and optional reason |
| GET /api/v1/documents/{id}/versions/{version}/download | Validated original bytes as an attachment plus X-Content-SHA256 |

The upload header is `encodeURIComponent(JSON.stringify(value))`, capped at
8 KiB. A new document uses this header shape:

~~~json
{
  "expectedRevision": 0,
  "filename": "policy.md",
  "mime": "text/markdown",
  "metadata": {
    "title": "Application policy",
    "appId": null,
    "owner": "",
    "status": "draft",
    "reviewAt": null,
    "linkKind": null,
    "linkId": null
  }
}
~~~

Supply the selected file bytes as the body, not a filesystem path, base64 JSON,
HTML form string, or multipart body. Empty files and compressed HTTP request
bodies are rejected. For a new immutable version, use documentId,
expectedRevision, filename, and mime, with no metadata field. Use the current
server-issued revision. A metadata PATCH uses
`{ expectedRevision, patch: { title, owner, status, reviewAt, appId, linkKind, linkId } }`
with only fields intentionally changing. Link kind and ID must be both present
or both cleared. Lifecycle reasons are optional bounded text.

Titles are at most 200 characters; owner 160; filenames 180 with no path
separators; IDs 128; review dates must be calendar-valid. Supported filename
extensions cover PDF, text/Markdown/log/CSV/TSV, Office files, common raster
images, JSON, ZIP, email and PCAP. MIME metadata and a permitted extension are
not proof that content is safe. Files are not parsed or executed by the service.
Treat downloaded files as untrusted. This starter has no antivirus scanner,
content disarm, OCR, indexing, full-text search, or automatic quarantine.

**Durability, integrity, and limits**

Document metadata, versions, bytes and audit commit together in
`documents.sqlite`, using WAL and full synchronization. Version and audit rows
are immutable through the service and protected against update/delete by SQLite
triggers. A download rechecks byte length and SHA-256; inconsistent bytes cause
a failure instead of returning a corrupt file. This detects corruption, not a
malicious administrator with unrestricted database/filesystem access. Retain
independent protected backups for that stronger threat model.

Limits are 10 MiB per nonempty file, 512 MiB total stored file bytes, 1,000
documents, 10,000 versions, and 100,000 audit entries. SQLite/WAL overhead means
disk needs more capacity than the file-byte budget. At most two upload requests
are admitted concurrently. Full capacity fails without saving the requested
mutation; archival does not reclaim bytes. Plan an approved export/retention
migration before these limits, rather than deleting files behind the service.
No high-volume document throughput or legal-records compliance guarantee is
claimed.

## 51. Web-app sources, environments, and lifecycle maintenance

The primary ownership model is application → environment → source. Host or
collector identity is optional for a web-app push integration and required only
when the installed connector manifest calls for it. Do not invent a server just
to register a SaaS app, containerless application, or hosted web frontend.

Register an app with displayName, optional hosts (zero through 64), optional
environments (one through 32 unique normalized identifiers), and publicPages.
Without environments, the server uses default. A source selects one declared
environment and remains bound to its immutable app/source/connector IDs. The
environment is configuration metadata, not separate tenant authorization.
Changing app/environment topology after registration is not a general editing
feature yet; plan it deliberately rather than rewriting private state files.

**Connect one web application**

1. Onboard the app with environments such as development or production that
   match your own deployment. Omit hosts if there is no host collector.
2. In Sources, select that app/environment and the application-scoped
   canonical-push manifest with log.event. Choose a descriptive source name and
   expected collection cadence. A public page URL is descriptive scope, not a
   scan authorization or an ingest endpoint.
3. Test using a bounded message sample with optional channel/severity. A
   hostless canonical source requires this sample. Testing validates shape and
   configuration; it never adds the sample to Logs or marks health healthy.
4. Activate from tested state using the current expectedRevision. Save the
   one-time source-ingest credential into the sender's approved secret facility.
   It cannot be recovered by replaying the command. Do not paste it into a
   document, prompt, Git file, screenshot, or technical support transcript.
5. Implement the sender's bounded canonical batches to POST /api/v1/ingest,
   using the issued source identity and separate Bearer transport credential.
   Validate against the ingest contract before sending. Retries keep receiptId
   and exact content unchanged; changed content needs a new receipt.
6. Verify the accepted receipt, source scope, first event and five supported
   projections. Healthy means a real admitted delivery within cadence, not that
   the whole application is secure or that every expected log source exists.

Keep the receiver private. An Internet-only SaaS webhook cannot reach a private
tailnet endpoint by wishful configuration. Use an approved tailnet-capable
sender, private relay, or a reviewed poller design. Do not enable public ingress
to make a vendor webhook work. The starter does not supply that relay/poller.

**Maintenance commands**

Every command below carries sourceId, connectorInstanceId, and the exact
current expectedRevision in the standard command envelope. The server checks
the lifecycle, commits audit/history, and increments revision. Browser labels
or cached rows are not authority. Refresh after each operation.

| Command | Allowed starting state | Outcome |
| --- | --- | --- |
| source.update | configured, tested, active, paused | Change displayName, config, or credentialReferences; revoke old credentials; return to configured; retest/activate |
| source.pause | active | Stop accepting ingest; retain credential/history for controlled resume |
| source.resume | paused with a live credential | Return active/pending; require a new accepted delivery for health |
| source.revoke | active or paused | Revoke all current ingest credentials and leave source paused |
| source.rotate | active or paused | Revoke prior credentials, issue one new one-time value, return active/pending |
| source.archive | configured, tested, active, paused | Stop collection, revoke credentials, retain record/history |
| source.remove | archived | Retain a removed tombstone and admitted records; no data purge |

source.update requires at least one permitted changed field and validates the
complete result against the installed manifest. A config object or credential
reference list replaces that whole field; do not send a partial object unless
the intended full value passes the manifest. App, environment, connector type,
source kind and ownership IDs are not freely reassigned by update. There is no
source restore command in this slice; archive only when intended. A replacement
source gets a new identity, and removal does not free record/receipt quotas.

Expired or revoked credentials prevent resume; rotate through the protected UI
and update the sender. The MCP reference refuses source.rotate along with other
credential-issuing actions. Pausing/stopping a source affects collection, not
the immutable truth of historical admitted records. Document that distinction
when interpreting old Logs/Analytics rows after removal.

The eleven legacy scan manifests remain host-scoped connection templates. Their fields
allow operators to describe Trivy, Patch First, File Integrity, End of Life and
the other scan integrations, including opaque credential references. They do
not execute scanners or resolve an API key. An agent must not bypass their
connector-unavailable test result or falsely claim success. See section 46 for
the per-template design and implement each reviewed driver/normalizer/projector
as a separate vertical integration.

The separate `trivy-report` application-scoped importer is implemented in the
private application. It has no vendor-key slot because the SOC never connects
to a registry or scanner vendor for this workflow. Section 54 describes its
actual upload, source authorization and Scans projection behavior.

## 52. Storage limits, reliability acceptance, and remaining parity work

The private application uses `SqliteTelemetryStore` for connector metadata,
canonical records, replay receipts, source health and connector audit. SQLite
WAL with synchronous FULL commits these changes in one transaction before an
admission receipt is returned. Only bounded control metadata is cloned; ingest
does not load or rewrite the retained event history. SQL indexes cover source,
kind, event time and retention time; triggers maintain exact retained counters.
The public static mode has no store. The disposable workbench retains its
8 MiB JSON state, 50 MiB audit and 10,000-record/receipt limits. Administration
still uses its bounded reference store. One runtime owns a state directory;
do not start replicas against it or infer multi-process coordination from WAL.

**Default private telemetry limits**

| Setting | Default | Meaning |
| --- | --- | --- |
| maxRecords | 100000 | Retained canonical payloads, across log and scan kinds |
| maxRecordBytes | 268435456 | 256 MiB of serialized record payloads, not total database size |
| recordDays | 30 | Payload age measured from server admission time |
| replayDays | 7 | Receipt/fingerprint replay protection and maximum batch sentAt age |
| maxReceipts | 100000 | Retained source/batch receipt identities |
| maxRecordIdentities | 1000000 | Retained source/record fingerprints, including pruned payloads |
| maxAuditRows | 1000000 | Connector audit commits; exhaustion refuses mutations |

After successful state mutations, payloads beyond the count/byte/age bounds
are pruned oldest-admitted first. There is no idle background purge. Pruning
does not erase source health's cumulative accepted counts, fabricate a fresh
scan, or remove an unexpired receipt/fingerprint. Payload eviction is not a
backup, legal hold, compliance guarantee or secure filesystem erasure. SQLite
pages/WAL, indexes, audit and other application stores require additional disk.
A new batch that alone exceeds the record-count or payload-byte capacity is
refused with 507 before any pruning, records, receipt, source-health, credential
usage or audit changes are committed. Split oversized deliveries upstream;
the Trivy importer never silently truncates or splits a report.

Receipts and pruned-payload fingerprints remain through the replay window.
Exhausting their capacities fails with 507 instead of silently shortening the
window. A batch whose original `sentAt` is older than that window is refused,
even if its payload or receipt previously existed. Retrying inside the window
must retain its exact receipt ID/body. Changing the timestamp and IDs is a new
delivery, not a retry. Stable record IDs with conflicting content are rejected.
There is no promise of global deduplication forever after identities expire.

Retention settings are pinned in `telemetry.sqlite`. An omitted configuration
reloads the stored policy; a changed explicit configuration is refused rather
than silently changing replay guarantees. Embedders may supply validated
`telemetryRetention` options to `startPrivateApplication` when creating a new
deployment. Existing-policy changes require a deliberate migration design.
The normal CLI uses the documented defaults or stored policy.

In **Retention → Policy**, operators can inspect this actual configured policy.
**Retention → Reality** shows retained record bytes/counts, receipt count and
fingerprint count from the database. It does not invent free disk, per-source
coverage, archive integrity or an analyst review. The same authenticated
read-only data is available from `GET /api/v1/telemetry/storage`.

Logs use bounded newest-first indexed selection (at most 200 rows), with the
matched count and omitted-row notice. Indexed text search requires at least
three characters and uses SQLite's trigram text search; this is not arbitrary
SQL or a full SIEM query language. Source IDs and application/environment labels
remain searchable/filterable. Analytics aggregate the selected bounded time
window in SQL instead of materializing all events in JavaScript. A diagnostic
`getState()` can still export retained history for tests; it is not a browser or
machine endpoint and is not used by hot request paths.

**Existing private state upgrade**

Stop the old process and take a consistent whole-directory backup first.
Startup acquires the existing writer lock, validates the old state and audit,
and transactionally imports them into the new database. The original
`state.json` and `audit.jsonl` remain as frozen migration inputs; their digest
must still match on restart. Never edit/delete them or restart the reference
workbench against an upgraded directory. Existing data exceeding configured
migration bounds, changed inputs, unknown schemas, corruption and ambiguous
locks cause explicit refusal. Do not delete the new database to downgrade:
restore the complete pre-upgrade backup to a separate stopped deployment if
rollback is required. Preserve both the SQLite state and frozen inputs in
future backups.

Capacity, corruption, an incomplete transaction, or a conflicting process lock
must surface as an actionable failure. Never label these failures empty or
healthy, acknowledge undurable data, discard evidence silently, or remove state
to restore a green indicator. Admission retries must preserve their idempotent
receipt contract. Whole-directory backup/restore is described in section 49.

**Next implementation steps, not current capabilities**

1. Extend beyond the shipped indexed store with workload-tested capacity,
   incremental projections and operational export/retention tooling.
2. Share cached read work and incremental projectors with explicit versions,
   generation checks, checkpoints, lag and completeness. Preserve last-known
   good data only with honest stale/partial labels.
3. Add worker claims, heartbeats, deadlines, safe retry/backoff, dead letters and
   crash recovery. Reject stale job completions and retain durable decisions.
4. Add web availability/TLS observations, independently verified evidence
   backups, legal acknowledgement receipts and retention coverage. These are
   separate normalized facts, not inferred from a successful upload or push.
5. Combine editable agent definitions/prompts with observed run state and
   freshness. A registered or enrolled agent is not a running healthy agent.
6. Add attestation program/checklist relationships, risk progress independent
   of verified closure, and versioned risk Markdown import/export. Storing a
   Markdown file in Documents does not parse or reconcile its risk records.
7. Extend the shipped scoped service access only when required with resource-
   specific authorization and richer identity policy. Keep credential issuance,
   arbitrary execution and telemetry outside MCP.

For each implementation slice, preserve the original brand/CSS and empty-state
truth while adding actual service behavior and tests. Do not copy private
prompts, real hosts, policies, inventory, records, credentials, source values,
or deployment configuration from an operational instance into this repository.

**Verification must distinguish correctness from performance**

Run `npm run check` to validate generated documentation, runtime contracts,
functional tests and the public-content boundary. Private auth tests exercise
real sign-in, wrong passwords, closed signup, sessions across restart, expiry,
revocation, bounded inputs, restrictive filesystem state and concurrent durable
rate limits. Document/source tests exercise their own transactions, revisions,
lifecycles and integrity. Passing those tests is not a throughput benchmark or
proof of deployment readiness.

Run the informational private-runtime benchmark separately:

~~~sh
npm run benchmark:private -- --records 20000 --batch-size 100 --queries 30
~~~

Its p50/p95 measurements concern direct runtime operations, not HTTP throughput,
browser latency, a pass/fail service-level objective, or production hardware.
Keep workload parameters and machine/runtime context with any comparison.
The benchmark uses private indexed telemetry, not the JSON workbench. The
workbench's 10,000-record bound remains unchanged.

The committed-state recovery test kills a child process after source, agent,
and document writes. The reference store locks intentionally refuse immediate
restart. Automatic stale-lock recovery is not implemented: first verify the
recorded process is no longer alive and no writer owns the directory, then
deliberately remove only the confirmed stale lock files under the documented
recovery procedure. Retain state and audit. The test verifies recovery of those
committed records after this explicit step; it is not actual power-loss testing,
automatic dangling-audit repair, or permission to remove an unexplained lock.

Before raising capacities, run reproducible workloads for concurrent ingest,
Logs queries, document operations, agent work and navigation. Record hardware,
dataset size, p50/p95 latency, event-loop delay, peak memory and storage work.
Test append/rotation during read, malformed or truncated input, retry after
lost acknowledgement, conflicting revisions, cancelled navigation, and crash
points around commits. Demonstrate bounded bytes/operations, not only one fast
timing. Distinguish a killed process from actual power-loss testing and state
which was exercised. No performance figure or resilience guarantee is implied
by importing a design pattern from another deployment.

CI, GitHub workflows, branch protections and release automation remain outside
this work. This manual concerns the runnable app and adopter integration path.

## 53. Private service identities and authenticated MCP setup

**What this is.** Service Access gives an external agent process its own
expiring permission to the private app's existing control services. An agent
registration/prompt describes a managed agent; it does not grant API access.
An enrollment proof proves a connection; it does not grant every tool. A source
credential admits telemetry for one source. A service credential grants selected
control operations across this single installation. These identities are not
interchangeable. Creating any of them does not start a model or agent process.

**Human setup through the app**

1. Sign in and open **Agents → Service Access**.
2. Give the connection a recognizable non-secret name. Choose its lifetime:
   the UI offers one hour, 24 hours, seven days or 30 days. The API accepts
   five minutes through 30 days; 24 hours is the default.
3. Keep the default `connector:read`, `agents:read`, `governance:read` scopes
   unless the job needs more. These expose installation metadata, not telemetry
   streams or document bytes. Prompt bodies need separate `prompts:read`.
   The setup-observer purpose explicitly selects `connector:read` and the
   optional `setup:read`; it is not a retroactive expansion of existing tokens.
4. Expand optional write grants only if required. Each grant is an exact
   command, never a wildcard. Read the prompt and approve impactful operations
   in the external agent host too; a token scope does not replace human review.
5. Issue once, save the one-time credential directly into an approved external
   secret file (owner-only mode 0600), and clear the credential panel. Do not
   put it in prompts, transcripts, command arguments, browser storage, Documents
   or source control. Neither list nor audit can retrieve it later.
6. Configure the agent's MCP host to launch the stdio client with a private
   origin and the file path. It does not need an operator password or cookie.

~~~sh
npm run --silent start:agent-mcp -- --base-url http://127.0.0.1:8080 --token-file /absolute/private/mcp-service-token
~~~

Set the MCP host's working directory to the repository. Keep `--silent`: npm's
ordinary startup banners would corrupt the stdout JSON-RPC stream. A direct
`node /absolute/path/to/repository/tools/agent-mcp.js` invocation with the same
client options is also supported.

For Tailnet use, select your deployment's exact private HTTPS origin instead
of loopback. The alternative environment setting `SOC_AGENT_MCP_TOKEN_FILE`
contains the path, never the token. `SOC_AGENT_MCP_BASE_URL` contains the
approved private origin. The token file must be a canonical absolute regular
file outside the repository, owned by the user, without symlinks/hardlinks or
group/world access. It contains one issued token with an optional trailing
newline. The MCP client rereads the file on each request, supporting rotation
without host restart. It refuses redirects and remote tokenless operation.

**Exact optional command grants**

Connector scope names use the prefix `connector:` followed by one of:
`app.register`, `source.setup`, `source.test`, `source.update`, `source.pause`,
`source.resume`, `source.archive`, `source.remove`, `source.revoke`.

Administration scope names use `administration:` followed by one of:
`agent.pause`, `agent.archive`, `agent.remove`, `prompt.revise`, `prompt.archive`,
`enrollment.revoke`, `attestation.create`, `attestation.update`,
`attestation.transition`, `attestation.archive`, `attestation.restore`,
`attestation.remove`, `risk.create`, `risk.update`, `risk.transition`,
`risk.archive`, `risk.restore`, `risk.remove`.

Credential issuance and privilege expansion are permanently unavailable:
`host.enroll`, `source.activate`, `source.rotate`, `enrollment.issue`,
`agent.create`, `agent.update`, `agent.resume`, `agent.restore`, and
`prompt.activate`. The server denies these before idempotency lookup, even if
a modified MCP client sends them. A human operator performs those steps in the
protected UI. An approved setup agent can register/configure/test a source;
activation and transfer of its ingest credential remain explicit human steps.

All grants are **installation-wide**. They are not per-app, per-agent, per-record
or per-tenant restrictions. Do not grant a scope if its installation-wide reach
is broader than the job should have. RBAC for human operator accounts remains
out of this slice: every locally provisioned operator still has full access.

**Management and machine HTTP contracts**

Human management requires the same-origin operator session and rejects a bearer
header, even when a valid cookie is also present:

| Endpoint | Input and output |
| --- | --- |
| GET /api/v1/service-access | Optional offset and limit (1–100); identities, scope catalog, limits and last 100 audit entries; no secret or digest |
| POST /api/v1/service-access | name, optional scopes and expiresInSeconds; returns safe service metadata plus oneTimeCredential once |
| POST /api/v1/service-access/:id/rotate | expectedRevision; new one-time credential, immediate invalidation of previous token, unchanged expiry |
| POST /api/v1/service-access/:id/revoke | expectedRevision; permanent revocation with incremented revision |

Machine calls require `Authorization: Bearer …`, reject cookies and retain
Host/Origin checks. Origin is optional for non-browser clients; a supplied
Origin must match. Endpoint paths are fixed:

| Service path | Required authority |
| --- | --- |
| GET /api/v1/service/control/snapshot | connector:read |
| GET /api/v1/service/administration/snapshot?domain=agents | agents:read |
| GET /api/v1/service/administration/snapshot?domain=governance | governance:read |
| GET /api/v1/service/administration/prompts?promptId=ID | prompts:read |
| GET /api/v1/service/setup | setup:read; saved guide choices and compatible source declarations |
| GET /api/v1/service/setup/check?appId=ID&environment=NAME&path=PATH | setup:read; optional sourceId; read-only local diagnostic evidence |
| POST /api/v1/service/control/commands | Exact permitted connector command scope |
| POST /api/v1/service/administration/commands | Exact permitted administration command scope |

Command bodies remain the existing version-1 contracts, including request ID,
timestamps and expected revisions. The service path calls the same runtime,
not a second registry. The separate operator, document, storage and telemetry
endpoints do not accept service tokens. MCP continues to expose exactly the
seven tools in section 26; it gains scoped setup reads, not arbitrary HTTP
access. There are no machine guide writes, source-mapping uploads, private
operations checks, document transfer, or live-monitoring management tools.

**Rotation, failure and custody**

Rotation invalidates the old token immediately; update the external file using
an approved secure operation before expecting the agent to reconnect. It does
not extend expiry or modify scopes. To change scopes or renew expiry, issue a
new identity, switch the client and revoke the old identity. Revocation is not
undoable. Lost issue/rotation responses cannot be read back; use the management
list to identify the outcome, then rotate again or revoke and replace it.
401 indicates invalid/expired/revoked authentication; 403 indicates a denied
scope; 409 indicates a revision/lifecycle conflict; 429 indicates the identity's
durable 120-request/minute fixed window. Refresh after a revision conflict and
review the current state instead of retrying with a guessed revision.
The rate counter runs only after endpoint/input validation. Malformed requests,
unknown endpoints and invalid credentials do not reach that counter; rate-limit
refusals are not audit entries. This is not comprehensive ingress throttling or
failure logging.

`service-access.sqlite` stores only token digests, safe lifecycle metadata and
audits. Its local limits are 1,000 retained identities (including revoked and
expired), 10,000 recent audit events and 100 displayed recent events. List
pagination is 50 by default and at most 100. Identity capacity fails explicitly;
there is no destructive purge button. Authorization/lifecycle audit and actual
connector/administration commit audit are separate transactions. A service
authorization entry alone is not proof that its command committed.

## 54. Trivy report import from a user's own scanner

This is a working importer, not scanner execution or vendor API polling. Run
Trivy in your own approved build, deployment or scanner environment; export its
vulnerability-only JSON report. The SOC never starts a shell, downloads an image,
reads your scanner API key or retrieves an arbitrary URL in this workflow.
The separate `trivy-template` remains design-only; select **Trivy JSON report
import** (`trivy-report`) for the implemented path.

**UI sequence and population**

1. Register the application and environment in Onboarding/Sources. No host is
   required. An explicitly attached collector still needs its connection proof.
2. In Sources → Add a source choose `trivy-report`, source kind `trivy.scan`,
   a display name and expected cadence. There are no API-key fields because the
   importer does not make vendor requests.
3. Test the installed local importer and activate the source. This verifies
   configuration, not scanner execution or live coverage. Health remains
   awaiting-first-delivery until a valid report is admitted.
4. Open Scans → Trivy, select the active source, choose the completed JSON file
   and import. The signed-in operator may upload without exposing the source's
   one-time ingest credential to the form. For an automated sender, transfer
   that credential to the sender's secret store instead.
5. Inspect the report timestamp, application/environment, reported package and
   vulnerability counts, advisories and fixed-version information. The page
   selects the latest retained report per source, not the last upload time.
6. Retry an uncertain upload with the same file. Canonical identities and its
   receipt are deterministic; replay does not add duplicate records or pretend
   a new scan happened. Correct a source's cadence/name through normal source
   lifecycle actions; pause/revoke/archive stops machine admission.

**Accepted report shape and bounds**

- Trivy JSON `SchemaVersion: 2`, a valid original `CreatedAt`, an `ArtifactName`
  and an allowed artifact type: container_image, filesystem, repository,
  rootfs or sbom. SBOM means a Trivy vulnerability report of an SBOM, not a raw
  CycloneDX/SPDX document.
- One through 64 Results groups, each with Target, Type and Class equal to
  os-pkgs or lang-pkgs. Missing/empty Results, explicit scanner errors,
  unsupported secret/config/license-only results and malformed fields fail
  before admission. Export a supported vulnerability-only report, not SARIF.
- At most 8 MiB of HTTP JSON and 1,000 total normalized records per report.
  The summary, each unique package and each unique vulnerability count toward
  that bound. Imports are atomic, never silently truncated or split. Divide
  scans by application artifact upstream when a report is too large.
- Original CreatedAt maps to observedAt and batch sentAt, normalized to UTC
  milliseconds. It must fit the deployment's replay window (seven days by
  default) and cannot be more than five minutes in the future. Historical
  out-of-window import is not implemented. Never change an old timestamp just
  to make stale findings appear fresh.

Only bounded package/version/advisory/severity/fixed-version fields and scan
summary metadata are retained. Original report bytes, artifact/target names and
paths, image environment, secret findings, descriptions and external links are
not stored. Artifact and target identities are hashes, not reversible labels;
hashing is minimization, not anonymization of guessable values. Package names
and versions can themselves be sensitive, so keep the deployment private.

Normalization produces one `scan.result`, zero or more `software.package` and
zero or more `vulnerability.finding` records. The exact source/application
binding is enforced server-side; callers cannot select a different estate.
Generic `/api/v1/ingest` refuses records for this scanner source so arbitrary
canonical JSON cannot skip the report normalizer. The report endpoint validates
the source credential before reading the report; human uploads require the
operator session and matching Origin. A service/MCP credential is not accepted.

**Automated source sender**

`POST /api/v1/scanners/trivy/import?sourceId=ID` accepts `application/json` raw
Trivy JSON with the source-bound Bearer credential. It returns a
`scanner-import-result` containing the canonical ingest receipt and safe report
counts. The helper CLI sends an existing local file, takes the source credential
only from stdin, refuses redirects and limits destinations to loopback HTTP or
private Tailnet HTTPS:

~~~sh
npm run import:trivy -- --file /absolute/private/trivy-report.json --source-id SOURCE_ID --credential-stdin --base-url http://127.0.0.1:8080
~~~

Pipe stdin from an approved credential manager; this command deliberately has
no plaintext credential argument or interactive echoing password prompt. Replace
SOURCE_ID with the source identifier from Sources. The report file is input,
never committed to this repository. The CLI prints only safe receipt/count
metadata and does not execute Trivy. A scheduled sender remains your own worker;
setting cadence in the SOC does not create a schedule.

**Interpretation and failure handling**

Zero reported vulnerabilities is not proof of complete coverage or a clean app.
Without complete package inventory, the package table may list only vulnerable
packages. A fixed-version value is an upstream recommendation, not verified
remediation. Imports do not close cases, risks or attestations automatically.
Collection health means report delivery, not an absence of vulnerabilities.
The view retains source lifecycle labels, including archived/removed histories.
At most 200 latest source summaries and bounded detail rows are selected; every
table displays at most 200 rows, with totals and omission notices. Record
retention may evict detail while a summary remains, so report totals can exceed
currently visible rows. No finding disappearance should be treated as a fix.

For a rejected report, inspect its safe error reason, correct the report shape,
reduce its scope or correct the source identity. No partial findings or success
health are committed on failed admission. For timeouts, retry unchanged within
the replay window. For expired/revoked source credentials, rotate through the
human source flow and update the sender; do not substitute an operator cookie or
service credential. Patch First, File Integrity, End of Life and the other
legacy templates still require their own reviewed driver and projector.

## 55. Vendor-independent integration registry, sender, and observation coverage

**Goal and boundary.** An adopter can bring a source from any vendor or their
own stack without adding a vendor name to the application's core code. That
does not mean accepting arbitrary raw payloads or removing storage and request
limits. External adapters convert their provider's data into the version-one
canonical contract. The private app verifies source credentials, application
binding, allowed kinds, schemas, timestamps and replay identities before
transactionally storing records and returning a receipt.

There are three built-in admission drivers: narrow `canonical-push` for
`log.event`, `canonical-events` for all 29 canonical kinds, and `trivy-report`
for normalized observations from a validated raw Trivy report. The private app
also supports human-installed custom canonical-push declarations. Eleven older
scanner setup templates remain non-executing; a registered template alone is
not an acquisition driver. The separate loopback workbench still enables only
its original narrow log admission path.

**Human setup, step by step**

1. Register the application and environment in Onboarding. Host enrollment is
   optional for these application-scoped sources.
2. Choose **Sources → Add a source → Universal canonical events**, or select a
   narrower integration type. Use a separate source per independently operated
   feed, environment or trust boundary so its credential can be revoked alone.
3. For reusable custom types, visit **Sources → Integrations**. Enter a unique
   type ID, display name, source category, expected cadence and allowed record
   kinds, or import complete manifest JSON. Registration does not fetch a URL,
   download a module, execute a command or receive vendor credentials.
4. Configure the source, then paste one real redacted normalized record for
   validation. Supply the displayed `sourceId` and application `estateId`, a
   stable record ID, a declared canonical kind, original RFC 3339 observation
   time, and that kind's required payload fields. Keep this UI sample below
   60 KiB. A full control-command body is limited to 64 KiB. No sample is stored
   as telemetry, and validation does not report collection as healthy.
5. Activate through the human workflow. Save the one-time source credential
   directly into the external sender's secret manager or an owner-only file.
   Keep it outside the checkout **and outside the application's managed state
   directory**. The state directory rejects unrelated files on restart.
6. Translate and send real batches using the sender below. Credential values
   never belong in browser configuration, prompts, documents, command arguments
   or source control. Vendor API credentials remain separate in the external
   adapter; the SOC source credential authorizes only canonical admission.
7. Open **Sources → Received observations** and inspect actual records. Filter
   application, source and kind; inspect reported payloads and lifecycle labels.
   The source's collection health changes only after durable admission. Cadence
   is an expectation, not a polling schedule.
8. Use **Sources → Integrations** to see which read surfaces accept those kinds.
   A manifest's target routes describe intent. The actual coverage matrix is
   owned by `server/integration-coverage.js`, independently of imported metadata.

The source-category field is descriptive. The source's manifest
`payload.recordKinds` is its admission allowlist. The universal driver permits
all 29 kinds; use a custom definition with fewer kinds when that is the correct
trust boundary. Neither kind nor payload data can grant console permissions,
activate prompts/rules, send notifications, approve evidence or close risks.

**Custom definitions and lifecycle**

Custom manifests reuse the existing manifest schema with these stricter
requirements: application scope; push delivery; `soc.canonical-records` schema
version 1; `lines: forbidden`; `content: required`; no credential slots; no
empty-payload health claim; and a required duration `cadence-seconds` field
bounded within 60–31,536,000 seconds. Kind names come from the closed canonical
schema, not arbitrary custom event types. Provider-specific facts fit within
the allowed bounded scalar `payload.fields`, after upstream redaction.

Type IDs begin with a lowercase letter and contain lowercase letters, digits,
dots or hyphens, at most 80 characters. Built-in types cannot be replaced.
Definitions are immutable. Create a new versioned type ID for an incompatible
change and migrate sources deliberately; do not rewrite the meaning of stored
history. Unused custom definitions may be removed. A source/connector reference,
including an archived or removed tombstone, blocks removal of its definition.
Pause, resume, update, archive, remove, revoke and rotate remain source-lifecycle
operations; updating a source requires revalidation and fresh activation.

The registry is saved in the same control-state transaction as its audit entry.
Concurrent changes use the telemetry control revision and return 409 on a stale
revision. Refresh and review before resubmitting. The registry is bounded to
100 types: 14 built-ins and at most 86 custom definitions. Each custom manifest
is at most 64 KiB; the installation request allows 66 KiB including its envelope.
These are implementation bounds, not an allowlist of vendors or a claim of
unlimited sources. Existing bounded control snapshots and telemetry capacity
still apply. Do not increase those bounds without migration and workload tests.

**Operator HTTP interfaces**

These require a human browser session and the private same-origin policy.
Bearer credentials, including service identities, are not accepted here. MCP
can inspect the resulting connector snapshot but cannot install/remove types.

| Interface | Input and result |
| --- | --- |
| GET /api/v1/integrations | No query. Catalog revision, capacity, manifests, built-in/custom origin, admission availability, removability, supported record kinds and actual coverage |
| POST /api/v1/integrations | JSON `{manifest, expectedRevision}`. Human-only immutable installation; 201 and updated catalog |
| DELETE /api/v1/integrations/TYPE | JSON `{expectedRevision}`. Remove an unused custom type; history references cause 409 |
| GET /api/v1/integrations/observations | Optional sourceId, appId, comma-separated kinds, observedAfter, observedBefore, limit and offset. Canonical records plus source/application/lifecycle context and honest count/omission metadata |

Observation timestamps are RFC 3339; `observedAfter` is inclusive and
`observedBefore` exclusive. Invalid, repeated or unknown filters fail rather
than silently broadening a query. Syntactically valid but unknown source/app
IDs return zero matches. Results are newest first, at most 200 records and
2 MiB of serialized stored records; the UI requests 25 rows per page. Offset is
bounded to 1,000,000. A byte limit may make a page shorter. Offset pages can move
when new records arrive or retention runs; this is not a stable export cursor.
Retention counters describe retained data, not every event ever sent.

**Canonical sender CLI and Node client**

The sender uses the established `/api/v1/ingest` machine endpoint, never a human
cookie or service-agent credential. Prepare a version-one batch with a stable
receipt ID of 16–128 characters, original `sentAt`, source-bound records and
producer-stable record IDs. It accepts at most 1,000 records and 1 MiB including
JSON serialization. Oversized work is refused, not silently split or truncated.

~~~sh
npm run --silent send:events -- --file /absolute/private/batch.json --token-file /absolute/private/source-ingest-key --base-url http://127.0.0.1:8080
~~~

For remote private use, select the exact approved private HTTPS origin. The
client rejects public destinations and redirects. Source-token files must be
canonical absolute owner-only regular files outside the checkout, without
symlinks/hardlinks. Use mode 0600; no raw-token argument or environment variable
is accepted. The file is reread on each attempt to support rotation. Keep it
outside the application's state directory too.

Node integrations can import `createIntegrationClient` from
`tools/integration-client.js`, create it with `{baseUrl, tokenFile}`, and call
`sendBatch(batch)`. The returned value is a validated, correlated receipt, not
untrusted remote text. The CLI prints the safe receipt on stdout and sanitized
failures on stderr. Keep provider credentials and raw provider payloads inside
your external adapter; this library starts at already-normalized batches.

Default attempts are three, at most five. Timeouts, selected transport failures,
429 and 502/503/504 may retry with a bounded delay and identical serialized body.
Other 4xx responses do not retry. `Retry-After` greater than the client's bounded
wait stops with retry-delay metadata rather than retrying early. The default
request timeout is ten seconds. A timeout may occur after the server committed:
retrying the unchanged batch is therefore essential. The sender is not a durable
queue, tailer or scheduler; persist pending batches in your own worker. Retries
beyond the seven-day default replay window fail. Never restamp old data to make
it appear fresh, and never equate a receipt with exactly-once external actions.

**Screen coverage and truthful interpretation**

The Logs/Overview/Analytics path remains specifically `log.event`. Other typed
records populate clearly labeled imported-observation views on relevant
monitoring, response, investigation, scanner and estate categories. Examples:
findings appear in Triage; rule descriptions in Rules; package/finding facts in
Patch first and Dependencies; file-integrity facts in File integrity; identity
facts in Access → Observations (`#/access?atab=observations`); backup claims in
Backups. Access → Who remains the real local-account inventory. These are direct facts,
not computed priorities, running detectors, verified backups or activated
workflows. Generic scanner records never enter the specialized Trivy report
summary; only the real report importer has that provenance.

Native vendor/queue tabs are presentation selectors for these fallback views,
not implied data classifiers. Their effective selectors are printed in the
scope notice. Unsupported native detail/search parameters fail explicitly,
rather than showing unrelated records as a requested case, event or rule.
Use Received observations for real application/source/kind filtering. The
static product layouts and specialized adapter slots remain available for
adopters who implement full native projectors and authorized workflow commands.

Imported governance, compliance, evidence and retention records remain
observations. They cannot overwrite authored risks, attestations, document
versions, local retention policy or agent configuration. Administration and
Documents continue to own those mutation workflows.

**Full integration review and remaining work**

The repository's `docs/INTEGRATION-REVIEW.md` is the detailed implementation/gap
matrix and adoption checklist. Agents may read it through
`soc://documentation/integration-review`. The main remaining layers are:

- Raw webhook signature verification and payload mapping; native OTLP/syslog
  translation; practical framework/vendor presets and first-event diagnostics.
- Additional reviewed pollers and vendor-secret resolution beyond the narrow
  Sentry Cloud collector in chapter 57; generalized scheduling, job claims,
  retry/dead-letter handling and incremental checkpoints.
- Real detectors, case transitions, notification outboxes, remediation review,
  native scanner acquisition and independently verified evidence.
- Agent execution/run history, human least-privilege roles, stronger identity
  policy, governed document links and risk import/export.
- Reproducible private deployment, backup/restore/export tooling, upgrade
  rollback, disk-pressure monitoring and realistic mixed HTTP/browser workloads.

The source system is now extensible without core vendor edits, but those
integration layers are not completed by registering metadata. For every new
adapter prove denied access, exact source/application binding, schema failures,
first delivery, duplicates, lost acknowledgements, rotation/revocation, stale
health, retention, restart recovery and the actual intended screen behavior.
No live production data, user credentials, demo feeds or private prompts are
included in the public baseline. CI and release automation remain out of scope.

## 56. Vendor adapters and durable delivery

**Shipped implementation.** Ten checked-in v1 vendor mappings now support
supplied exports and successful API response pages. Sources → Vendor imports
provides human-managed preset installation, source-bound file preview, source
sample validation and reviewed import. A separate Node CLI and SQLite outbox
persist canonical deliveries before network submission. These are not ten
automatically connected vendor accounts. This import pack adds no vendor
credentials, account discovery, polling daemon or publicly exposed webhook.
The separate, opt-in Sentry live collector is documented in chapter 57.

This set covers cloud, identity, edge security, source control and application
observability; it is not a claimed measured global popularity ranking. Sources
not listed still use custom definitions or universal canonical events. Vendor
presets are ordinary immutable custom definitions named `vendor.<adapter-id>`;
installing all ten consumes ten of the existing 86 custom slots, not a new cap
on vendors. Trivy report import remains a separate specialized path.

**Setup for humans**

1. Keep the application private on loopback or its explicitly configured
   private HTTPS/tailnet origin; never expose it publicly to collect webhooks.
2. Register your application/environment. Open Sources → Vendor imports,
   expand the appropriate vendor and install its preset. Installation changes
   only the data-only registry and is revision-checked/audited.
3. Follow Configure source. Choose app/environment, display name and expected
   cadence, then begin setup. An enrolled host is not required.
4. Return to Vendor imports; select that vendor and its configured source.
   Choose your own redacted JSON/NDJSON file and click Preview mapping. Up to
   ten mapped records and the full accepted count appear. Nothing is stored.
5. Click Validate source with preview sample. This uses the standard source
   test contract, binding record IDs to the selected source and registered app.
   Activate in Add a source, retaining the one-time credential privately.
6. Refresh vendor setup and preview the file again. Active sources enable
   Import reviewed events. The server requires the exact preview hash and
   rechecks the source's state; selecting another file/source invalidates it.
7. Inspect the committed receipt and Received observations. Repeating an
   identical delivery returns a replay receipt. Imported claims never grant
   local access, become verified security verdicts or trigger operational actions.

The browser sends the selected raw file to the private server for mapping.
Neither stores the original in durable application storage. Redact exports
before selection and keep request bodies out of proxy/collector logs. The file
selection is guarded against refresh/navigation loss and cleared after success.
The Vendor imports panel adds no vendor API-key field, local storage or machine
authority. The separate Live monitoring panel has a narrowly scoped private
credential form for its reviewed Sentry collector and optional Slack delivery.

**Supported inputs and source contracts**

| Adapter ID | Supported event/page input | Canonical result | Acquisition requirements and caveats |
| --- | --- | --- | --- |
| aws-cloudtrail | CloudTrail Records; LookupEvents Events containing CloudTrailEvent JSON; single events/arrays | audit.event; supported principal-bound console authentication.event | External least-privilege AWS role. LookupEvents needs cloudtrail:LookupEvents, is regional, limited to recent management/Insights history, 50/page, two requests/sec/account/region, 90-day vendor window. Trail/data-event collection needs the appropriate object/log reader instead; follow NextToken externally |
| entra-signin | Graph sign-in value pages, arrays or individual exported records | authentication.event | Graph v1.0 signIns, AuditLog.Read.All, applicable delegated reader role and P1/P2 licensing. Up to 1,000/page; collector follows nextLink. Missing user is event-unresolved; no fabricated identity or success |
| gcp-audit | entries.list responses, typed AuditLog LogEntry arrays or individual entries | audit.event | logging.logEntries.list; Data Access additionally requires private log access and often explicit enablement. Intended projects/logs, pagination and completeness are collector responsibilities |
| cloudflare-firewall | firewall_events Logpush records/arrays/NDJSON, not GraphQL aggregates | network.event | Select RayID, Datetime, Action, Source, RuleID, MatchIndex; use RFC3339ms/ns output. Numeric nanoseconds are refused to avoid precision loss. Logpush to adopter storage; collector downloads privately. Logs:Write manages jobs, separate storage read permission obtains files |
| github-audit | Organization audit API/export events and arrays with _document_id | audit.event | Applicable plan and organization-owner visibility; classic/OAuth read:audit_log or supported fine-grained Administration read. No GitHub Actions, Dependabot, code scanning or webhook formats in this adapter |
| gitlab-audit | Instance/group/project audit events or arrays | audit.event | Applicable Premium/Ultimate feature, read_api and appropriate role. Instance Administrator/group Owner/project Maintainer have broader visibility than lower roles; a successful page is not full coverage |
| okta-system-log | System Log arrays or individual exports | authentication.event for closed known login types, otherwise audit.event | okta.logs.read. Follow server Link pagination/polling semantics; default 100/page, 90-day vendor retention. Published time alone is not a safe lossless cursor. Okta outcome is not proof that a third-party app completed sign-in |
| auth0-logs | Management API arrays, logs/include_totals wrapper or individual exports | known login authentication.event, otherwise audit.event | read:logs; checkpoint export from/take and next Link; at most 100/request. Search retrieval's 1,000-result ceiling is not an unlimited export. Retention is plan-dependent |
| sentry-events | Project/issue error-event arrays or supported event details | log.event, not a security finding | project:read for project list/details, event:read for issue event listing. Requires eventID and original dateCreated; transactions/replay/issue summaries are different contracts |
| datadog-logs | Successful Logs v2 data pages, log-object arrays or individual log objects | log.event, not a security finding | logs_read_data and documented site-specific API/OAuth access in external collector. Follow cursors in a bounded query window; error, timeout or nonempty-warning results are refused |

CloudTrail requires stable eventID/time/service/action. Google requires
insertId/logName/time and typed audit payload with service/method; the log name
and full original time participate in identity. Cloudflare RayID alone is not
a unique rule-match event, so time/action/rule/source/match index are included.
Entra requires id/createdDateTime; Okta uuid/published/eventType; Auth0
log_id/date/type; GitHub _document_id/action/@timestamp (supported created_at
fallback); GitLab id/created_at/entity_type; Sentry 32-hex eventID/dateCreated and
supported error type; Datadog id/type:log/attributes.timestamp. Missing or
invalid identity/time rejects the whole input, never substitutes current time.

Vendor response cursors are not followed by these mappers. Event families,
plan-specific visibility, filtering and sampling are not discovered or inferred.
Source permissions belong to the external collector's least-privilege identity.
Never paste vendor credentials into a source label, manifest, canonical event,
documentation, prompt or generic source-registration form. Use only the reviewed
Live monitoring credential form for the built-in collector described in chapter
57; external import collectors keep their credentials outside this application.

**Privacy and interpretation**

Mappers use generated titles/messages, allowlisted enums and hashed identity/
resource references. Unknown types/outcomes remain unknown; a failed application
operation is not automatically a malicious event. Raw log messages, user emails,
addresses, request bodies, credentials, headers, URLs, stack traces and arbitrary
attributes are not copied into canonical records. This is deliberately not a
full-fidelity log archive. Hash references are pseudonymous, not guaranteed
anonymous or resistant to dictionary/correlation analysis. Provider level and
reported outcome are not independent SOC severity or verified success.

The source/application comes from the selected local registration, not vendor
payload fields. Canonical IDs hash mapper version, vendor, source, application,
kind and upstream identity. Records are sorted for deterministic receipt/body
identity. Changed retained content for an existing upstream identity is refused,
not overwritten. Some vendor mappers reject duplicate input IDs; otherwise
identical duplicates may collapse but conflicting duplicates always reject.

Inputs are bounded to 8 MiB and 1–1,000 events; normalized atomic delivery is
bounded to 1 MiB. JSON arrays/wrappers and one-object-per-line NDJSON are accepted
only where their constituent records match the chosen adapter. No automatic
splitting, truncation or partial acceptance. Empty pages do not manufacture
health. Preview shows the first ten records, not the entire raw document.

Batch sentAt is the latest original event timestamp. This makes replay stable
but means files whose latest event is outside the server's configured replay
window (seven days by default) are refused. Do not replace timestamps with now
to smuggle historical data past this boundary. A historical migration needs a
separate reviewed process. Record retention (30 days default) is independent.

**External collector CLI**

~~~sh
npm run --silent vendor -- list
npm run --silent vendor -- normalize --adapter github-audit --file /absolute/private/audit-page.json --source-id YOUR_SOURCE_ID --app-id YOUR_APP_ID
npm run --silent vendor -- enqueue --adapter github-audit --file /absolute/private/audit-page.json --source-id YOUR_SOURCE_ID --app-id YOUR_APP_ID --outbox-dir /absolute/private/soc-outbox --base-url http://127.0.0.1:8080
npm run --silent vendor -- status --outbox-dir /absolute/private/soc-outbox
npm run --silent vendor -- drain --outbox-dir /absolute/private/soc-outbox --source-id YOUR_SOURCE_ID --token-file /absolute/private/source-ingest-key --base-url http://127.0.0.1:8080 --limit 10
~~~

All paths above are placeholders. Use canonical absolute paths; macOS symlinked
aliases must be resolved. The queue directory must be owner-only, outside the
checkout, dedicated to this queue, and separate from the application state and
token files. The source token file must be owner-only and outside the checkout.
It contains the issued source-ingest credential, not vendor credentials, agent
service access or browser cookies. The same private-origin enforcement as the
canonical sender applies. Pending entries are pinned to their original origin
and source; a drain invocation for another origin/source cannot reroute them.

The Node API is normalizeVendorPayload/parseVendorText in tools/vendor-adapters.js
and openOutbox in tools/integration-outbox.js. First persist the canonical batch
with enqueue; advance your vendor cursor only after that succeeds. A crash before
cursor persistence may replay the page, but stable identities make it detectable.
Never rewrite pending bodies on an adapter upgrade. Store vendor secrets and
cursor state in your external collector's approved facilities, not this outbox.

**Durability, retries and recovery**

The queue uses SQLite WAL/FULL transactions and keeps canonical bodies until
a matching receipt is verified. It admits 10,000 identities and 64 MiB of pending
bodies; acknowledged identities still count toward the lifetime entry bound.
Delivered bodies are logically released while hashes/receipts remain. That is
not a physical disk quota or guaranteed forensic erasure from the DB/WAL.

Drain performs one bounded pass (10 deliveries default, 100 maximum). Your
private scheduler/supervisor invokes it repeatedly; no background service is
installed. Each attempt has a ten-second HTTP timeout, a 60-second claim lease,
and claim fencing. Restart may reclaim expired leases; a stale worker cannot
overwrite another claim's result. Lost acknowledgements preserve exact body,
receipt ID and original times for replay.

Network/timeout failures, 429, 502, 503 and 504 schedule another due time with
backoff and Retry-After. That persisted cooldown gates all entries for the same
source/destination, including new entries and restarted workers; manual retry
does not shorten it. Permanent refusals, invalid receipts, ten-attempt
exhaustion and expiry block a delivery for operator review. A failed delivery
stops the current pass rather than flooding later batches. The worker does not
sleep inside a retry loop: the next invocation processes due entries.

Status provides global counts and a paginated metadata view. Use optional
--state blocked, --source-id YOUR_SOURCE_ID, --offset 0 and --limit 100 to locate
older blocked entries. Follow page.nextOffset while page.hasMore; offsets are
bounded to 0–10,000 and pages to 1–100. Totals remain global even when the page
is filtered. Each entry identifies its pinned private origin.

Inspect status, correct source/credential/capacity issues and explicitly retry
an unexpired blocked delivery:

~~~sh
npm run --silent vendor -- retry --outbox-dir /absolute/private/soc-outbox --id DELIVERY_ID
~~~

Retry resets its attempt budget, not body/origin/source/receipt/timestamps. The
queue's seven-day age eligibility is measured from enqueue; the server can
refuse sooner based on saved sentAt. Expired/blocked bodies are retained for
investigation, not automatically deleted. Delivered entries cannot be retried.
There is no purge command; resolve pending work before archiving the dedicated
queue and starting a new one at capacity. Back up consistently with SQLite-aware
handling; copying only a live main DB can omit WAL commits. Test restore to a
separate private directory. Unknown/corrupt schemas, body/identity mismatch,
linked or permissive files fail closed. Use a supported local filesystem, not
a shared/distributed queue volume. Process-kill tests are not power-loss proof.

CLI stdout contains canonical output, metadata or validated receipts, all still
private telemetry. No vendor secret or remote error body is printed. Failed
processed deliveries return nonzero; zero processed deliveries may mean nothing
is due or work is blocked. Check status instead of treating that as completion.

**HTTP and agent contract**

GET /api/v1/integrations/vendors returns definitions and bounds. POST to
/api/v1/integrations/vendors/preview takes adapterId, sourceId and text and
returns normalized preview, sample, source revision and previewHash without
storing records. POST to /api/v1/integrations/vendors/import takes the same
fields plus previewHash and commits the exact reviewed delivery. At most two
private uploads share the application's upload concurrency limit. All three
endpoints require a human browser session; mutations require exact same origin.
A machine Authorization header is refused even with a valid session cookie.

An external collector sends canonical batches through /api/v1/ingest with the
source's own credential. MCP remains documentation/management only. Agents can
read the full vendor guide using soc://documentation/vendor-integrations and
the review using soc://documentation/integration-review; no MCP file-upload,
vendor-key storage, ingestion or execution tool was added.

The checked-in docs/VENDOR-INTEGRATIONS.md contains provider-by-provider official
references and detailed acquisition requirements. The next chapter adds one
built-in Sentry Cloud collector with its own pagination/checkpoints, schedule
and optional Slack delivery. Other vendor readers, real tenant commissioning,
queue monitoring, restore/load drills and broader native workflows remain work.
Tests use disposable synthetic data; no live-account commissioning or universal
complete-collection claim has been made.

## 57. Live monitoring: connect, collect, understand, notify, verify

**Purpose and honest scope**

Sources → Live monitoring is the first complete built-in automatic path: a
Sentry Cloud project supplies error events, the private SOC retains minimized
canonical observations and actionable local alerts, and an optional Slack
incoming webhook delivers generated notifications. It is one managed collector,
not ten automatically connected vendor accounts. The ten import mappings in
chapter 56 still process supplied exports/API pages, and the universal/custom
paths remain available for any other reviewed source.

The private server owns collection. Closing the browser does not stop it;
stopping the server does. The static preview makes no monitoring requests,
stores no credentials and cannot connect a vendor. No account, event or secret
is shipped. Controlled automated tests are not proof of access to your actual
Sentry organization or Slack channel. Commission those yourself using an
authorized project and the acceptance checks below.

This collector does not instrument your application, install a Sentry SDK,
create a Sentry project, execute a scanner, receive Internet webhooks, resolve
upstream issues or modify code. It reads project error events, not transactions,
replays, attachments or every Sentry product. Application errors are not verified
security incidents, and a new event is not necessarily a new bug or issue.

The selected SOC environment is local source attribution, not an upstream
filter. The selected Sentry project's supported error feed is read as a whole.
If production and staging share one Sentry project, both can populate the chosen
SOC environment. Use a dedicated Sentry project per environment when isolation
is needed. Do not infer upstream filtering from a local environment label.

**Prerequisites and network setup**

Run the private application with a locally provisioned operator and a persistent
owner-only state directory outside the repository. Register the web application
and its environments in Onboarding; no collector host is required. Your own
application must already send approved errors to its Sentry Cloud project.
Confirm an event in Sentry before troubleshooting empty SOC observations.

Keep the SOC listener on loopback. Share it only through explicitly configured
private Tailnet HTTPS with a restricted tailnet policy and normal private SOC
sign-in. Do not expose this application to the public Internet. No inbound
vendor webhook is needed: Sentry reads and optional Slack messages are outbound
HTTPS from the private server. Do not disable TLS verification. Maintain a
synchronized host clock and enough disk space for all private state.

The browser calls only same-origin SOC endpoints, never Sentry or Slack directly.
Current human operators have full deployment access; this feature does not add
application-scoped human permissions or multi-tenant isolation. Optional TOTP
is configured separately in Account security. An agent
registration or service-access credential is not permission to read vendor keys.

The operator must arrange process supervision and an independent private
watchdog. The server does not install a daemon. If its process/host is stopped,
the in-process collector cannot fetch events or send its own outage notification.
Restart can show stale checkpoints and resume bounded catch-up, but cannot
retroactively deliver a real-time outage warning during downtime.

**Read-only vendor access and field meanings**

Use a Sentry API bearer token with project:read and access to the intended
project. Do not grant write/admin scope merely to make setup work. A Sentry SDK
DSN is not an API token. Vendor identity/project permissions still apply in
addition to the scope name. See the official
[project error-event API reference](https://docs.sentry.io/api/events/list-a-projects-error-events/).

Select the registered application and environment. Give the connection a useful
name of 1–100 characters without sensitive incident detail. Supply the Sentry
organization and project URL slugs, not full URLs or display names. Region
default uses sentry.io, us uses us.sentry.io, and eu uses de.sentry.io. No custom
or self-hosted API origin, arbitrary headers or uploaded collector code is
accepted by this fixed built-in reader. Use a reviewed external collector for
a different destination rather than weakening the origin boundary.

Enter the API token only in the private password field. Do not paste it into
agent prompts, chat, screenshots, shell arguments, environment values, issues
or source-controlled configuration. Status never returns existing credentials.
The browser writes no key to browser storage and clears secret inputs after a
successful save or leaving the view. Failed saves can retain the current draft
for correction; discard it explicitly when finished.

Slack is optional. To enable it, provision a standard app incoming webhook for
the approved channel and enter its secret URL in the private password field.
The webhook's channel is the destination; this UI does not override its scope.
Only the standard hooks.slack.com incoming-webhook protocol is supported, not
GovSlack, Workflow Builder or an arbitrary HTTP callback. Use Slack's
[incoming webhook guide](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/).
Leave the field blank for in-app alerts only.

Enabling Slack sends generated alert titles/bodies, the connection display name,
counts/reported levels, SOC source/alert identifiers and, when present, a sample
canonical record ID and Sentry event ID. Those labels and IDs can be sensitive.
It does not send raw exception messages, stacks, request bodies, headers or
user objects. Plain-text formatting prevents label text becoming channel/user
mentions; URL/media unfurling is disabled. Approve this data transfer before
adding a destination. A webhook URL is a credential, not a public configuration
value to include in documentation or an agent conversation.

**First-run walkthrough**

1. Sign in privately, register your application and its environments in
   Onboarding, then open Sources → Live monitoring.
2. Select the application/environment and enter the connection name, region,
   organization slug and project slug. Recheck the environment-scope notice.
3. Enter the read-only Sentry token. Optionally enter the approved Slack webhook.
4. Select Test access and start monitoring. The server reads and validates the
   first actual event page before accepting the connection. It generates no
   application error and does not create a fabricated success record.
5. The service installs/reuses the reviewed Sentry preset, creates a managed
   source and activates only its narrow internal collector. There is no manual
   source-test sample, host setup, one-time external ingest token or CLI drain
   job to configure for this path. Existing manually imported sources are not
   silently converted.
6. Starting is expected until an entire initial window is committed. Verify
   Last successful completed poll and Completed through advance; access testing
   alone is not complete collection. An empty completed window is healthy.
7. Open View this source's observations. Accepted records are canonical log.event
   observations bound to the managed source and selected application. Matching
   log/overview/analytics/timeline projectors can show them; empty source data
   stays empty rather than being filled with invented records.
8. If Slack is configured, explicitly Send Slack test. Inspect the test alert's
   delivery state and independently check the intended channel. This sends a
   real test message; at most one accepted test per connection per minute.
9. With authorization, generate one harmless recognizable error in your own
   instrumented app. Confirm it in Sentry and then in the SOC observation/alert.
   Do not disrupt production merely to exercise monitoring.
10. Follow the alert evidence or displayed Sentry event ID. Acknowledge the SOC
    alert after review. Local acknowledgment does not resolve the upstream issue,
    cancel queued notifications, suppress future events or change application code.
11. Perform controlled failure/restart/restore checks before relying on unattended
    operation. Record connection/source ownership and coverage start privately.

The same project/application/environment combination cannot be connected twice
while that connection exists. A different local binding creates an independent
collector/history, not an upstream filter. Keep one clear ownership model for
each source rather than multiplying credentials and alerts accidentally.

**Windows, durable checkpoints and latency**

Initial lookback is 15 minutes, ending 30 seconds behind the server clock.
Subsequent collection overlaps the completed checkpoint by five minutes and
keeps the same 30-second settling delay. A catch-up window advances its end by
at most one hour; the overlap can make the requested span slightly longer.
Normal polling resumes after 60 seconds. Unfinished pagination or older backlog
continues after five seconds. Each pass reads at most five pages of at most 100
events; these are bounds, not a guaranteed throughput rate.

Low-volume display latency includes the 60-second schedule, 30-second settling
delay, upstream ingestion delay and up to 30 seconds for the browser refresh.
Backlogs, rate limits or failures add delay. Do not treat these timings as a
production alerting SLO. The UI pauses automatic refresh while a draft is open,
but the private server continues collection.

The collector requests compact events with sampling disabled. It checks
pagination destinations, query/window consistency and cursor direction before
building another fixed-origin request. Missing/repeated/changed pagination is
a failure, never silently interpreted as the end of a window. Sentry's protocol
is documented in the official [pagination reference](https://docs.sentry.io/api/pagination/).

After validation the collector maps a page, persists its exact normalized batch
and bounded recovery metadata, admits it through normal source/application
validation and receipts, records new identities/alerts, then saves the next
cursor. Completed through advances only after the final page commits. Accepted
partial records do not prove complete coverage. A restart after admission but
before checkpoint commit replays the identical saved body. Stable identities
and retained seen-event state handle ordinary replay/overlap without duplicate
observations or repeated event alerts.

This replay starts only after the private application can open its state.
A hard crash can leave an existing state lock, which intentionally blocks
restart. Automatic stale-lock recovery is not implemented. Follow chapter 49:
verify the recorded process is dead and no writer owns the directory, prevent
a supervisor from starting a competing writer, and remove only the exact lock
confirmed stale. Preserve all databases, keys, state and audit. If ownership
is uncertain, investigate rather than deleting a lock or recreating state.
The SIGKILL test proves replay after that explicit recovery, not unattended
crash restart or power-loss durability.

Late arrivals beyond the five-minute overlap can be missed. Sentry/SDK sampling,
missing upstream data, plan limitations, deletions and retention expiry are not
fixed by this collector. Completed through means the requested API window
finished under the bounded contract, not that every error the application ever
generated is present. No full-fidelity archive or universal exactly-once claim
is made.

Catch-up stops if the gap exceeds six days. Preserve and investigate the old
history. If an operator deliberately removes/reconnects the project, the new
connection begins a new 15-minute coverage period; it does not backfill the gap.
A long pause can reach the same bound. Never re-date events or edit checkpoints
to make an incomplete period look current.

**Collection health is not event activity**

Starting means no fully successful window yet. Healthy means recent complete
collection and a current checkpoint. Degraded means a saved failure, incomplete
window or lagging checkpoint needs attention. Offline means an inactive managed
source or a complete success older than the five-minute freshness threshold.
Paused is an intentional collection stop. Failure classification takes priority
over age, so a connection may remain Degraded with old timestamps rather than
changing to Offline. Inspect the times, not only the label/color.

Last attempted poll can describe a failed request. Last successful completed
poll describes a finished window. Coverage starts marks this connection's
declared beginning; Completed through is its last fully committed upstream end.
Next attempt is scheduling/backoff, not a promise if the process stops. Last
event activity is the newest original event timestamp: an old value can be
healthy when successful polls find no new errors. Events accepted counts unique
event identities for the connection, not bugs, incidents or current retained
records after telemetry expiry. Timestamps in this widget are UTC.

Managed source health/history also record successful empty polls. That is a
specialized verified reader result, not permission for generic empty canonical
pushes to claim health. The dedicated Live monitoring alert/delivery state is
authoritative for this workflow; it does not activate native triage/rules or
general incident/remediation actions elsewhere in the SOC.

**Alerts and evidence**

Application-error alerts summarize newly seen events on a committed page, report
how many were error/fatal, and point to one sample canonical record and Sentry
event ID. This is new event identity detection, not a new-issue classifier or
independent security analysis. Investigate the event, application behavior and
recent deployments before deciding what to change.

Collection-failed alerts mark the start of a continuing failure episode rather
than sending one alert for every retry. Collection-recovered means a complete
window succeeded afterward; review any historical gap. Notification-test is
explicitly an operator-requested delivery check, not collection proof.

When a supported Sentry issue identifier is available, the evidence link opens
that issue's event. Otherwise it opens the organization's issue browser; use
the displayed Sentry event ID to locate it. The link is fixed-host HTTPS and
still requires separate vendor authorization. Raw event-provided links are not
followed. The retained evidence identifiers are private, not anonymous data.

The alert list is newest-first, up to 100 per page with Older/Newer controls.
New alerts can shift offset pages. An explicit status refresh returns to the
first page. Acknowledgment is local review bookkeeping, not an upstream action
or indefinite archive; acknowledged alerts with terminal delivery can become
eligible for capacity eviction.

**Controls, secret rotation and removal**

Poll now queues a bounded job and returns promptly; it does not bypass the saved
next-attempt time, two-job concurrency or a provider cooldown. Pause stops
collection and fences in-flight results, but queued Slack delivery can continue.
Resume preserves cursor/history and cooldown. It does not erase a six-day gap.

Rotate credentials in the connection's disclosure. Blank replacement fields
preserve their existing values; explicitly check Remove Slack notifications to
remove that destination. Saving a Sentry token is not collection proof: verify
the next completed poll. Removing Slack cancels pending/blocked deliveries but
cannot retract messages already delivered. Adding Slack later does not send old
in-app-only alerts retroactively.

Send Slack test creates an explicit delivery record; configured is not delivered.
Retry blocked Slack notifications resets a bounded attempt budget, not due times
or a connection-wide cooldown. Mutations use the current expectedRevision and
refuse stale updates. Refresh after saving/discarding a stale draft; do not
overwrite newer state blindly.

Remove connection stops jobs, archives its managed source, deletes its active
credential record and cancels pending/blocked notifications. Existing telemetry
and alerts remain under their own retention rules. This does not revoke the
upstream credential, erase backups, guarantee forensic deletion of SQLite/WAL
bytes or delete Sentry events. Revoke unwanted vendor access at the vendor too.
To change application/environment/project/region/name binding, deliberately
remove and recreate a connection with a new historical boundary.

Treat the source as managed. Independently disabling/archiving/revoking it in
generic controls can stop admission. The collector does not silently revive
that lifecycle. Repair it deliberately or reconnect; do not assign an external
writer to this managed source.

**Durable Slack semantics**

Alerts are saved before delivery. In-app means no Slack destination was present
when the alert was created. Pending means waiting for an attempt or retry.
Delivered means Slack acknowledged the message, not that a person read it.
Blocked means a permanent failure, exhausted attempt budget or unsupported retry
delay. Cancelled means local delivery was stopped after removing Slack/connection.

Transient failures persist exponential backoff and Retry-After. A maximum of ten
attempts is allowed per budget; permanent errors stop sooner. Connection-wide
cooldown applies across later alerts, tests, restart and manual retry. A vendor
delay beyond the representable calendar blocks rather than being shortened.
There is no exactly-once external delivery: a crash after Slack acceptance but
before saving its receipt can cause a duplicate. The alert ID helps identify it.
There is no recipient read receipt, escalation policy, general routing engine,
message retraction, ticket synchronization or upstream issue resolution.

**Fixed limits and capacity behavior**

Twenty live connections and two concurrent jobs are supported. A pass has at
most five pages, each with 100 events and a 2 MiB response cap; a vendor request
has a ten-second timeout. Slack acknowledgment is bounded to 1 KiB. Monitoring
mutations are capped at 16 KiB. There are at most 10,000 retained alerts and
100,000 seen-event identities across connections. Seen identities older than
seven days are pruned on page commit. Audit history retains the last 10,000
lifecycle/acknowledgment entries. The six-day catch-up bound is separate from
those retention and regular canonical admission/replay limits.

At alert capacity, only old acknowledged alerts whose delivery is delivered,
in-app or cancelled may be evicted in bounded batches. If none are eligible,
new alert creation fails without advancing the collection checkpoint. Review
old alerts and repair outstanding delivery; do not acknowledge unread items just
to hide capacity pressure. Seen-identity exhaustion also preserves the incomplete
checkpoint. Logical bounds are not disk quotas: DB indexes/WAL, authentication,
documents, telemetry, administration, audit and backups consume additional space.

Use a supported local filesystem, one writer per state directory and external
capacity monitoring. Shared/distributed SQLite storage and distributed collector
coordination are not supported by this feature. Do not treat process-restart
tests as proof against all power/filesystem failures or unlimited load.

**Encrypted state and consistent backup/restore**

The existing private directory contains live-monitoring.sqlite and
live-monitoring.key. The directory must be canonical, owner-only 0700 and outside
the checkout without symlink ancestors. Regular state/key files are 0600,
owner-controlled and not hard-linked; WAL/SHM receive private modes too.

Secrets use AES-256-GCM with a random 32-byte key and connection-bound authenticated
data. The key is beside the database: someone who can read the entire directory,
backup or process memory can recover credentials. This is not an external KMS,
HSM, shipped key-rotation system or substitute for OS security and encrypted
backup custody. A missing/wrong key refuses startup rather than inventing new
credentials. Restore its matching trusted state; never delete history to bypass
the error.

Retained monitoring state includes connection binding, encrypted secrets,
windows/cursors, health, exact normalized pending batches, seen IDs, alert/evidence
metadata, delivery attempts and audit. Canonical records are in the normal
telemetry store. Raw event bodies are only in memory during mapping; discarded
messages, stacks, headers and user objects are not saved. Normalized hashes,
labels, evidence IDs and links remain private telemetry. Ensure reverse proxies
and diagnostics do not log credential request bodies.

For a conservative backup, stop the complete private app cleanly and confirm
no writer remains. Save all SOC state as one consistent set: monitoring DB/key,
remaining SQLite companions, authentication/database secrets, telemetry, registry,
administration, documents and service access. Preserve ownership/modes and the
compatible application version. Copying a live main DB alone can omit WAL commits.
Keep backups secret and outside the repository.

Restore first into an isolated canonical private directory on a supported local
filesystem. Avoid dual collection/delivery: keep a restored copy's outbound
network isolated while the original is active, and transfer ownership deliberately
to exactly one writer. Inspect decryptability, source bindings, checkpoint age,
pending pages and delivery state before approving collection. Test one complete
poll and record any gap. An older restored state can resend events/messages that
were processed after the backup; newer discarded deduplication state cannot
protect it. Online consistent backup automation and restore tooling remain
adopter responsibilities.

**HTTP and agent-readable contract**

GET /api/v1/monitoring returns schemaVersion, connections, alerts, totalAlerts,
offset, nextOffset and limits. Optional offset is 0–10,000; limit is 1–100.
Connection status includes IDs, local binding, vendor slugs/region, enabled,
revision, health, attempt/success/activity times, next attempt, safe error,
coverage start, completed checkpoint, pending-window summary, totalEvents,
hasSlack and notificationStatus. It never returns the token/webhook.

POST /api/v1/monitoring/connections takes appId, environment, displayName, region,
organization, project, token and optional slackWebhook. Access validation returns
a connection, not a completed-window guarantee. POST to that connection's
/poll, /pause, /resume, /remove, /test-notification or /retry-notifications path
takes expectedRevision. Poll returns promptly with queued true; cooldown still
applies. POST /credentials takes expectedRevision and a replacement token and/or
slackWebhook; omitted preserves, empty webhook removes. POST
/api/v1/monitoring/alerts/:id/ack takes an empty object and acknowledges locally.
Use returned identifiers and fresh revisions; unexpected fields/query parameters
are refused on mutations.

All monitoring endpoints require an authenticated human browser session; writes
require exact same origin. An Authorization header is refused even alongside a
valid cookie. MCP service tokens and source-ingest credentials do not grant this
API. Never copy browser cookies into an external automation client.

Agents can read soc://documentation/live-monitoring and the checked-in
docs/LIVE-MONITORING.md to explain setup, plan approved integration work and
understand the safety/retention contract. No new MCP secret-acquisition, monitoring
mutation, execution, shell or telemetry tool is granted. Let the human enter
credentials and approve connection/outbound-delivery changes in the private UI.
A future machine management surface requires explicit scoped authorization.

**Failure diagnosis and deployment acceptance**

If no applications appear, register one and refresh after resolving drafts.
If access testing fails, check region/slugs, token expiry/project permissions
and project:read; do not substitute a DSN or arbitrarily grant admin. If healthy
but empty, verify the application's SDK, selected project and original event
times. If some records arrived but health is degraded, inspect pending pagination
and the completed checkpoint. If Poll now does nothing immediately, inspect
saved cooldown, source lifecycle and process state before clicking again.

For denied credentials, rotate to a valid narrow token and verify a completed
window. For invalid pagination, preserve state and investigate the supported API
contract instead of discarding the window. For a gap over six days, preserve the
historical boundary and reconnect only as an explicit new coverage period.
For Slack problems, inspect each alert's delivery/due state and intended channel;
repair the webhook, then explicitly retry blocked delivery under its cooldown.
For a missing/wrong key, restore the matched backup. For total process outage,
use the independent watchdog: this process cannot alert while stopped.

Before relying on a deployment, a new operator should prove private sign-in and
code-free connection setup, honest empty-window success, one harmless real
application event with resolvable evidence, optional Slack test plus event delivery,
local-only acknowledgment, pause/resume, controlled credential failure and recovery,
same-state restart without ordinary replay duplication, cooldown-aware retry,
history-preserving removal, an isolated consistent restore and an independent
watchdog detecting a stopped SOC. Use disposable authorized connections for
failure tests. Repository tests exercise controlled responses, not live tenant
permissions or your operating environment. Record those real commissioning
results privately before assigning a latency/availability expectation.

## 58. Guided setup: Monitor my application and Check my setup

Open Sources → Guided setup to assemble a complete application-monitoring path.
This is a resumable guide over the existing connection services, not an arbitrary
plugin installer or a second source registry. The static skeleton explains the
workflow but performs no requests. Private sign-in and persistent private state
are required to save choices or inspect evidence. Human operators retain full
deployment access; choosing an application does not create tenant isolation.

**Monitor my application**

1. Register a new application and initial environment in the guide, or choose
   an existing app and one of its declared environments. No host is needed for
   application-scoped ingestion. Registration alone does not start monitoring.
2. Choose a connection path: Sentry live collection, reviewed vendor imports,
   custom/canonical push, or Trivy report import. Save the guide before leaving
   for the connection panel. Saving stores only IDs, environment, path and
   timestamps; never keys, file bytes, sample payloads, or a claimed pass state.
3. Follow the guided connection link. App/environment choices carry into the
   corresponding forms or source selectors. Inspect the actual displayed
   binding before submitting. URL preselection is convenience, not authority.
4. Complete that path's own access or source test and activation. Live Sentry
   uses reviewed project access and a managed source; generic push/import paths
   retain their sample validation and one-time source credential workflow.
5. Use Return to saved setup guide, choose the source actually created, and
   save its binding. The server rejects a source from another app, environment,
   or incompatible path. A guide may be saved before any source exists.
6. Run Check my setup. Deliver/import your first real reviewed event/report
   when appropriate. A quiet successful Sentry poll can prove collection while
   event admission and screen population correctly remain waiting.
7. Open the matching destinations and inspect actual records. Optional Slack
   testing is a separate explicit action in Live monitoring; independently
   verify that the expected message reached the intended channel.

Saved guides appear in the list and have local bookmark links. Resume after
navigation or a clean restart with the same state directory. Unsaved edits are
protected against accidental refresh/navigation. A stale revision conflicts
instead of overwriting another operator's saved choices. Guide bindings to app
and environment are immutable; use a separate guide for another binding.
Changing path/source is explicit. Duplicate app/environment/path guides are
refused; resume the existing one. Delete guide removes only the bookmark, not
its source, collector, credential, events, alerts, or application.

**Which path should I choose?**

- Live: your web app already sends errors to Sentry Cloud. Follow chapter 57.
  This is the only built-in automatic vendor reader; local environment labels
  do not filter the Sentry project's upstream feed.
- Vendor: you already have a supported vendor export or successful API response
  page. Follow chapter 56. Importing a file does not install a scheduled collector.
- Custom: your app or collector can produce normalized events. Follow chapter
  55 for definitions and source registration, sample validation, activation,
  exact source credentials, and a first real canonical batch. A data-only
  manifest never installs executable third-party code.
- Trivy: you already have an authorized supported package/vulnerability report.
  Configure/test/activate its importer, then use the Trivy upload. The SOC does
  not run a scan; zero reported vulnerabilities is not a coverage guarantee.

**Check my setup: evidence, not completion checkboxes**

Checks read local registry, retained canonical telemetry, implemented coverage,
and live-monitoring status. They do not issue tokens, activate sources, call
vendors, send Slack messages, launch scans, or create test events. A successful
browser read proves this signed-in session reaches the SOC, not that a remote
producer reaches its ingest endpoint.

Each result has a timestamped state: Pass means the described local evidence
exists now; Waiting means a step has not been demonstrated; Attention indicates
an inactive, failed, stale, incompatible, or incomplete state; Not applicable
means this selected path does not implement that capability. No overall badge
certifies the application secure, production ready, or completely monitored.

| Check | What it proves and what to do next |
| --- | --- |
| Application and source | Exact registered app/environment/source/path association. If waiting, configure and select the right source; never borrow another app's token |
| Source activation | Active source with an enabled admission driver. If incomplete, finish sample/access validation and activation, or investigate lifecycle state |
| Accepted canonical records | Records actually retained for this source, not a sample-validation result. Send/import a real event if needed; retention can remove older evidence |
| Collection status | A recent complete live window or recent canonical delivery under its declared cadence. A successful empty live window is healthy; file import does not prove scheduling |
| Screen population | Observations contain retained records; suggested destinations list actual matching counts and their limitations. Manifest target names alone do not implement a screen |
| Notification provider | A retained Slack acknowledgment or an explicit pending/failed condition. Historical delivery does not retest current credentials; use an explicit Slack test |
| Human receipt confirmation | Cannot be inferred automatically. Open the intended channel yourself; acknowledgment is not proof that a person saw the message |

Destination links preserve actual source/application filters where supported.
Time-limited screens can show fewer records than the retained source total.
The specialized Trivy latest-report surface retains its separate semantics;
generic scan records cannot impersonate a validated Trivy report. Imported
observations do not enable detectors, approve remediation, close risks, or
declare compliance.

Recheck after delivery, source changes, or a restart. Read the check timestamp;
saved guide choices are not persisted readiness results. A previously passing
source can become stale or paused. Keep source ownership, upstream coverage,
producer scheduling, notification channel membership, supervision and recovery
as explicit operating responsibilities.

**Storage and HTTP contract**

The owner-only external state directory contains setup-guides.sqlite and any
SQLite companions. Back it up with the whole private state. The bound is 200
guides and mutations use a global optimistic revision. Startup rejects an
unsupported/corrupt state file; never delete state or an unexplained runtime
lock just to make setup appear successful. Unclean shutdown retains the manual
verified-stale-lock recovery boundary in chapter 49 and chapter 57.

- GET /api/v1/setup: schemaVersion, revision, plans, and compatible source choices.
- POST /api/v1/setup/plans: expectedRevision, appId, environment, path and optional
  sourceId. Path is live, vendor, custom or trivy; returns revision and plan.
- PATCH /api/v1/setup/plans/:id: expectedRevision plus path and/or sourceId.
  sourceId null clears selection. App/environment cannot be changed in place.
- DELETE /api/v1/setup/plans/:id: expectedRevision; removes only saved choices.
- GET /api/v1/setup/check: exact appId, environment, path and optional sourceId
  query parameters; returns checkedAt, binding, checks, destinations and a
  qualified summary. Repeated/unknown query keys and unknown body fields fail.

These human endpoints require private browser sessions without machine bearer
authorization. Mutations require the configured same origin. Responses contain
no stored vendor keys or source-ingest credentials. The guide API is not a raw
file store or a general execution interface. Agents can read the full public
guide through the MCP resource soc://documentation/guided-setup; reading a
resource alone grants no private runtime authority. Separately, an explicitly
issued service identity with setup:read may use setup_guides and setup_check
through the two fixed /api/v1/service/setup read endpoints. Browser cookies do
not authorize those machine calls. The scope is deployment-wide, not per-app;
see chapters 53 and 60. No machine guide mutations or access-granting steps are
added, and a diagnostic result never certifies production readiness.

## 59. Map a custom source: from reviewed sample to canonical delivery

Open **Sources → Map a custom source**. Use this when your application or
external collector already produces JSON but does not use one of the reviewed
vendor importers. The mapper is a bounded field-selection tool, not a generic
collector, executable plugin, automatic redactor, or source-discovery service.
It can describe all 29 canonical record kinds, but the selected source's
installed manifest must permit the particular kind you choose. Vendor presets
and Trivy reports retain their own dedicated reviewed importers.

**Prepare the application and source first**

Register the web application and its environment. Configure a canonical-events,
canonical-push, or eligible installed data-only custom source. The mapper lists
registered bindings and compatible definitions; it cannot make an unavailable
driver available. Select the exact app, environment and source rather than
reusing another application's source identifier. Follow the source's host
requirement only if that manifest is host-scoped; an application-scoped source
does not need an invented server or host enrollment.

A configured, tested or paused compatible source can be used to preview a
mapping. That permission does not authorize delivery. Actual admission still
requires an active source and its separate source-ingest credential. Archived,
removed, mismatched or incompatible bindings cannot be used to make a new
preview pass. The browser's selected values are not authority: preview checks
the current registered binding and enabled driver again on the private server.

**Inspect a real, redacted representative sample**

Use UTF-8 JSON or NDJSON containing one object, an array of objects, or object
records separated by newlines. Unwrap vendor response envelopes before using
this general mapper; selecting an arbitrary wrapper is not a substitute for a
reviewed vendor adapter. Do not use a manufactured event merely to make a
monitoring screen look populated.

Before inspection, remove credentials, authorization headers, cookies, private
identifiers, unnecessary message content and anything your deployment should
not retain. Review both field names and values. The acknowledgment in the form
is an operator review step, not a security scan or automatic sanitization.
Secret-bearing key names and unsafe paths are rejected, but a free-text
message, URL, identifier, title or literal value can still contain sensitive
material. Do not paste secrets into an otherwise innocently named field.

The Inspect operation returns field metadata: JSON Pointer paths, observed
scalar types and presence counts. It does not return a second copy of all raw
sample values. Presence counts help identify paths that are absent from some
records. A field that exists once is not necessarily safe to require in every
record. Sample text is handled in browser/server memory for the request; this
tool does not persist raw input or save a recipe into the source registry.

**Choose the canonical meaning and map each field deliberately**

1. Select one permitted canonical record kind for this recipe. Read its
   required payload keys and supported enums in the catalog. Required title,
   state and kind-specific fields must all be supplied with valid values.
2. Map upstreamId from the original upstream event identity. It must be a
   nonempty bounded string or safe integer. Do not use array position, a random
   value generated during mapping, or the current time as the identity.
3. Map observedAt from the original RFC 3339 event timestamp. There is no
   automatic number-to-date conversion or replacement with now. A timestamp
   more than five minutes in the future is rejected. The eventual ingest
   endpoint also enforces its own replay/retention window; preview does not
   override that policy for older records.
4. Map each payload field from one own scalar leaf or a deliberate scalar
   constant. Constants are useful for a stable category or reviewed state;
   they must not invent a verdict or claim that a workflow was performed.
5. Include only additional scalar fields you explicitly need. Optional
   payload.fields names are explicit mappings, not permission to retain the
   entire upstream object. Unmapped input is omitted from the canonical batch.

Pointers use JSON Pointer escaping, including escaped slashes or tildes in
field names, and may address numeric array indexes. They select own scalar
leaves only. There are no wildcard queries, expressions, scripts, templates,
implicit coercions, nested-object pass-through, network destinations or
enrichment calls. If data needs parsing, coercion, enrichment or several
different record kinds, perform those reviewed steps in your producer or build
a dedicated adapter. Do not force incompatible values into a permissive kind
simply to get a green preview.

**Preview is not ingestion**

Inspect the complete normalized recipe and canonical batch before exporting
them. The whole preview fails if a required path is missing, a selected value
is invalid, a type/enum is unsupported, a timestamp is invalid, duplicate
identities disagree, or a structural/size limit is exceeded. No partial subset
is silently imported. The response explicitly says imported is false and raw
input is not persisted.

Record identities are deterministic for the recipe's version, application,
environment, source, kind and original event identity. Records are emitted in
deterministic order; identical repeats inside the sample collapse. Reusing an
upstream identity with conflicting normalized content fails rather than
creating a fresh incident. The receipt identity depends on the resulting
record set. Re-previewing does not make the same input new data, and editing a
recipe after records were admitted may create an identity/content conflict.
Review producer migrations and historical changes rather than rewriting time
or identity to bypass deduplication.

**Export, run offline and deliver through the existing sender**

Copy the reviewed recipe and representative input into owner-only private files
outside the checkout. Do not save operational samples in this public repository.
The offline mapper is:

~~~sh
npm run --silent map:events -- --recipe /absolute/private/recipe.json --file /absolute/private/events.json
~~~

The command prints only the canonical batch to stdout. It neither sends that
batch nor saves it. Both files and their immediate parent directory must be
owner-only, use canonical absolute external paths, and be free of symbolic and
hard links. The offline command cannot check whether the source still exists,
is active, retains the same binding, or still has an enabled admission driver.
Its structural success is not live registry validation.

Inspect the batch, then use the canonical sender and durable outbox described
in chapter 55. Keep the source credential in a separate approved private token
file, not in the recipe, generated JSON, shell arguments or agent transcript.
Configure upstream acquisition, scheduling, failure handling and format-change
alerts in the external producer. This mapper does not supply those services.
Return to the saved application guide, run Check my setup and inspect the
actual ingest receipt and source-filtered retained observations. Only those
later steps establish admission evidence.

**Limits and human API**

The current limits are 512 KiB input, 1–100 object records, depth 10, 20,000
nodes, 512 distinct scalar paths, a 64 KiB recipe and a 1 MiB canonical batch.
Split larger exports before processing, keeping original event identities and
timestamps. An over-limit response is a refusal, not permission to drop fields
or rows without telling the operator.

| Human endpoint | Meaning |
| --- | --- |
| GET /api/v1/source-mapping | Registered application/source choices, eligible kinds, required/optional payload fields, enums and limits |
| POST /api/v1/source-mapping/inspect | Exact body `{ text }`; inspect scalar paths/types/presence without storing sample records |
| POST /api/v1/source-mapping/preview | Exact body `{ appId, environment, sourceId, text, recipe }`; recheck current scope and return recipe, batch and qualified summary |

A recipe uses schemaVersion "1", documentType "source-mapping-recipe",
appId, environment, sourceId, kind, upstreamId `{ path: "/original-id" }`,
observedAt `{ path: "/original-time" }`, and payload mappings. Each mapping
is exactly `{ path: "/field" }` or `{ value: scalar }`. Optional payload.fields
uses explicit names with the same selector shape. The outer request and recipe
bindings must agree. These endpoints require the private human session; neither
the service-token API nor MCP exposes sample uploads or mapper mutations.

## 60. Guided agent connection: purpose, credentials, configuration, evidence

Open **Agents → Service Access**. The assistant makes the service-connection
workflow explicit without pretending that an entry in the agent registry is a
running agent. For related tasks, use its links to Add Agent, Prompts and
Enrollment. Those management surfaces have different contracts and authority.

**Separate the four concepts**

- An agent registration records metadata, declared capabilities and lifecycle.
  It does not provision an external machine or launch a model.
- A prompt revision is literal managed configuration. Reading or activating a
  prompt does not authorize arbitrary tools or start execution.
- Enrollment issues and proves a purpose-bound bootstrap relationship for
  the managed agent. It is not a general service API credential.
- Service Access issues an expiring scoped identity for an external API/MCP
  client. It is separate from enrollment values and source-ingest credentials.

The shipped stdio facade is a client of canonical server APIs. It is not an
agent scheduler, remote shell, generic network relay, raw-log search system,
credential broker or telemetry collector. The adopter supplies and operates
the actual MCP-capable host, model process, approval policy and scheduling.

**Step 1: select the narrow purpose and review its exact permissions**

The default registry-review purpose selects connector:read, agents:read and
governance:read. Agent-registry-only and governance-only purposes select their
respective read scope. The setup-observer purpose selects connector:read and
the optional setup:read. Selecting a purpose clears earlier optional grants;
it never adds writes or literal prompt bodies. Manual selection starts with no
scopes so the operator can choose the exact set.

Purpose is a local selection aid, not a stored authorization constraint.
Enforcement comes from the scopes actually submitted and issued. All scopes
are installation-wide, not restricted to the named agent, one application or
one record. A friendly name or application mentioned in a prompt cannot narrow
a token's authority. If installation-wide access is too broad for the job, do
not issue the token and assume the prompt will provide tenant isolation.

Prompt bodies require a deliberate prompts:read checkbox. Optional write
grants remain individually listed and require a confirmation before issuance.
Review the exact command and its production impact; the external agent host
must still enforce human approval for destructive or impactful operations.
The existing service boundary permanently blocks credential issuance and
privilege-expanding commands described in chapter 53. A source-registration
scope does not let an agent activate that source and retrieve its credential.

Choose a recognizable non-secret identity name and short practical lifetime.
The UI offers one hour, 24 hours, seven days or 30 days, with 24 hours selected
initially. The server's permitted range is five minutes through 30 days.
Changing scopes or renewing expiry requires a new identity; rotation changes
the token but preserves its scopes and original expiry.

**Step 2: save the one-time credential privately**

Issue the identity only after reviewing its scopes. Save the one-time value in
an owner-only regular file outside the checkout on the actual agent host.
Use mode 0600, the launching user's ownership, and no symbolic/hard links.
Create it with an approved secure editor or secret manager. The credential
must not appear in an agent prompt, MCP configuration JSON, command arguments,
an environment value, Document upload, log, transcript or source-control file.
Environment variables may identify the file path, not carry the token itself.

The one-time panel remains visible if a subsequent identity-list refresh fails.
Save the value before navigating away, then use I saved it — clear credential.
Clearing removes the browser copy; it does not verify the file's existence,
permissions or contents. There is no readback endpoint. If a write response is
lost, inspect the identity list to identify the outcome, then rotate the issued
identity or revoke and replace it. Do not repeatedly mint new identities while
assuming a timed-out request never completed.

**Step 3: generate a secret-free client configuration**

Select the active identity and enter three reviewed values: the absolute
checkout path on the agent host, the absolute external token-file path on that
same host, and the private SOC origin reachable from that host. The paths need
not refer to the browser's computer or the SOC server. Install the checkout's
dependencies and provide Node.js 22.13 or newer as node on the host's PATH.

Generate the JSON server entry and merge it into the MCP client's supported
configuration without replacing unrelated entries. The generated mcpServers
entry invokes node with an argument array containing the absolute
tools/agent-mcp.js path, --base-url, the private origin, --token-file and the
file path. No credential value is embedded. MCP host configuration schemas
vary; use the equivalent stdio command/arguments if that host uses another
wrapper format.

For POSIX paths, the assistant also provides a safely quoted equivalent launch
command and a permissions command for the already securely created token file.
Shell metacharacters in reviewed paths remain literal quoted arguments; the
JSON argument array does not invoke a shell. Windows drive paths receive JSON
arguments, not a misleading POSIX launch command. Set appropriate owner-only
file access on that host. Starting a stdio MCP process in a plain terminal can
wait silently for protocol input; silence is not proof of connectivity.

The generator rejects relative paths, parent/dot segments, invalid separators,
control characters and a token file lexically inside the checkout. It accepts
plain HTTP only for exact loopback hosts and otherwise requires HTTPS on
approved private address space or a validated tailnet hostname. Origins cannot
contain user credentials, paths, query strings or fragments. For a remote host,
its own loopback address points to itself, not to the SOC server: enter the
actual private HTTPS origin instead.

Generation is local to the browser. It does not inspect files, resolve DNS,
verify TLS, inspect tailnet policy, transfer a credential, install an MCP host
or connect the agent. The runtime independently checks the real token file and
transport. Inputs and generated instructions remain only in page memory and
are protected from automatic refresh until explicitly cleared or navigation is
approved. The assistant's own evidence refresh retains generated instructions;
leaving the page still discards them. Never treat a generated config as proof
that it was saved, installed or launched elsewhere.

**Step 4: verify a permitted read from the real external client**

Start the shipped stdio client through the actual MCP host. Use a granted
read-only operation: connector_snapshot for connector:read,
administration_snapshot with the appropriate domain for agents:read or
governance:read, or setup_guides for setup:read. Inspect the returned result
inside that host, then refresh observed agent access in the SOC. Tool discovery
and public documentation reads do not authenticate to the private server. A
write-only token must not be tested by making an unnecessary write.

The assistant distinguishes retained authorization from token issuance. It
looks for an authorized audit event for the selected identity, newer than its
issuance or rotation. Same-timestamp events at rotation are conservatively
excluded. lastUsedAt alone is not success: a valid credential denied an
operation for insufficient scope also updates that field. A denied request is
shown separately; do not fix it by blindly granting every write permission.

An authorization event says only that the server allowed that request. It does
not prove that the command committed, a response reached the client, a model
ran, a task succeeded, a schedule exists or the agent remains healthy. Inspect
the client's actual response and the relevant connector/administration history
for completion. Audit is bounded to the latest 100 displayed events across the
installation; absence may mean old evidence aged out. Re-run an appropriate
read when needed instead of manufacturing a pass flag.

Expired/revoked identities cannot be described as current usable access.
Rotation/revocation updates the displayed identity immediately even if the
following list request fails. A failed evidence refresh invalidates earlier
authorization proof rather than showing it as a newly successful check. An
identity outside the current paginated list is not certified using a stale
cached card. No browser/server test sends the one-time bearer value on the
operator's behalf.

**Seven MCP tools and the optional setup scope**

The complete tool inventory is connector_snapshot, connector_command,
administration_snapshot, administration_prompt, administration_command,
setup_guides and setup_check. Chapter 26 lists their exact argument contracts;
chapter 53 lists human management and service API permissions. New read tools
do not widen old tokens: setup:read is optional and is absent from the normal
default scope set.

setup_guides takes an empty object and returns saved application/environment/
source choices, compatible source declarations and the setup revision.
setup_check takes appId, environment, path and optional sourceId, with path
restricted to live, vendor, custom or trivy. It returns the same timestamped
local evidence checks, destinations and limitations shown to a human operator.
Both require a private service token file with setup:read and are unavailable
in tokenless workbench mode. Their only HTTP destinations are:

- GET /api/v1/service/setup
- GET /api/v1/service/setup/check with the exact supported binding query

There are no machine guide writes, source-mapping uploads, document transfers,
private deployment checks, credential reads or live-monitoring management
added to the facade. Read the public resource
soc://documentation/guided-setup for instructions, then use authenticated setup
reads for runtime evidence. Reading documentation by itself grants no authority.

## 61. Guided document intake and supporting evidence

Open **Documents** to add supported private files, assign tracking metadata and
maintain immutable versions. The workflow is document management, not a scanner
or a compliance decision engine. File bytes and document records remain in the
private document store; they are not packaged into the public skeleton and are
not sent through canonical telemetry merely because the document has a link.
Chapter 50 describes the byte/metadata HTTP contracts and supported limits.

**Choose scope and responsibility without inventing authorization**

Select a registered application from the searchable application picker, or
leave the document shared. Search narrows real registered choices rather than
guessing an identifier. The selected application is useful for organization
and filtering; it is not a tenant permission boundary. All provisioned human
operators still have full access in this starter.

Enter the owner, review date and appropriate document status deliberately. An
owner is a tracking label, not an account grant or a routing rule. A review
date does not install a scheduler or promise an email reminder. Assign someone
responsible for reviewing due dates and stale evidence in the operating process.
Do not imply the upload was reviewed merely because its metadata was filled in.

**Attach a real risk or attestation when appropriate**

Use the searchable risk/attestation picker for an existing local governance
record. New or changed bindings are checked on the server; browser text is not
sufficient to establish that a local target exists. Risks and attestations are
currently deployment-wide and do not have application ownership. Selecting an
application for the document does not rescope, reassign or isolate the linked
governance record.

Case and policy references are explicitly unverified external labels. They
are not proof that a matching local case/policy exists, and no undocumented
resolver is invoked to create one. Label them honestly and keep any external
system-of-record responsibility clear. Do not use an arbitrary typed ID when
the workflow offers a validated local governance picker.

A document link expresses association, not sufficiency. It does not establish
that a claim is supported, reduce a risk, change an attestation status, close a
case, certify compliance or approve remediation. Review the bytes and their
relevance, then use the separate governed status/lifecycle commands if a human
decision warrants a change. Uploading or mapping an evidence.receipt canonical
record never uploads a document or creates an authored attestation.

**Inspect the receipt and preserve versions**

After upload, inspect the actual document ID, immutable version number,
filename, byte count, SHA-256 digest, uploader and saved timestamp. These are
receipt facts. The hash identifies bytes; it does not prove authorship,
authenticity, malware safety, legal sufficiency or independent verification.
Do not upload credentials and do not treat accepted content as malware-scanned.

Edit metadata to change owner, review date, status or links. Use Upload a new
version for replacement bytes so prior versions remain available with their
own identity and history. A new version is not an in-place overwrite. Downloads
remain authenticated attachments under the document service's limits. Use
archive/restore for lifecycle organization and observe the retained-capacity
policy; archiving is not secure deletion and does not erase old versions.

Revision checks prevent an old form from silently overwriting another
operator's changes. On conflict, reload current metadata and review the new
state rather than guessing a revision. Clear an association only when the
operator explicitly intends to remove it. Changing links and uploading bytes
are related operations but do not implicitly authorize each other's side
effects.

**Handle historical missing references honestly**

A linked application, risk or attestation may later disappear. The document's
historical tuple remains visible as missing. An unrelated metadata edit or new
file version must not silently clear it or attach a different record that
happens to occupy the first picker option. Preserve the unchanged historical
tuple until an operator deliberately changes or clears the binding.

When any part of the binding is explicitly changed, the new tuple must be valid
under the current registry rules. Refresh the picker if a target changed
concurrently. A missing label is actionable maintenance information, not a
reason to fabricate a target or call the evidence current. Re-review document
relevance and governance status independently after fixing a reference.

## 62. Explain an empty screen without inventing data

Supported private empty/error views display a compact **+** beside the page
heading. Expand Explain this screen to read the implemented coverage contract, compatible
source declarations, active-source count and matching retained-record count.
This is an explicit opt-in local read. Merely opening an empty screen does not
start a vendor connection, import a sample, create a source or fill a board with
demonstration records.

Use Setup checklist in the header to reopen the beginner guide after dismissal.
It is offered once per loaded page on an unfiltered empty private view,
not on a provider error. Its personal checkmarks are not automated readiness
results. A filtered empty view does not prove a deployment has no sources.

The helper does not replace the screen's query or conceal its original error.
It answers a narrower question: what kinds or authored workflow feed this
route, and what relevant local configuration/retained data exists in the
supplied application/source scope? Its checkedAt timestamp belongs to that
read, not to the last successful collection event.

**Interpret configuration, data and projection separately**

| Observed situation | Interpretation and next action |
| --- | --- |
| No compatible source declaration | Choose the appropriate collection path and configure a producer for the stated record kinds; do not assume a panel title is an installed adapter |
| Compatible but inactive declarations | Review source lifecycle, required validation and activation; a declared integration does not prove delivery |
| Active declaration without retained matching records | Inspect source-specific checks, sender receipts and retention; deliver a real reviewed event/report if the integration has not yet sent one |
| Retained matching records but this screen is empty | Inspect time range, filters, supported projector and specialized workflow semantics; generic kind overlap may not satisfy this particular view |
| Locally authored workflow | Use its native document, agent, governance or other record-management controls; generic telemetry does not create authored management records |
| Local facts cannot be read | Re-establish the private session or investigate server availability; failure is not an empty successful result or proof the system is healthy |

The counts apply supplied appId/sourceId filters but are not the full native
view query. Time windows, detail selectors, latest-report selection and
specialized projector requirements may produce fewer visible rows than the
retained matching count. The helper does not reproduce every panel's filtering
algorithm or assert that all compatible records are currently rendered.

Only validated Trivy report imports populate the specialized latest-report
surface. Generic scan.result or vulnerability.finding records cannot impersonate
a Trivy import receipt. Conversely, a historical record can remain after its
source was removed or reconfigured. Retained data without a current producer
is historical evidence, not proof of a fresh collector.

The helper lists at most 50 compatible source declarations and explicitly
reports the omitted count. Do not infer that an unlisted declaration does not
exist. Source state active is a lifecycle fact, not a freshness, authentication,
cadence or upstream-coverage proof. Use Check my setup for source-specific
delivery evidence and Sources → Observations for actual retained facts.

**Human-only endpoint and failure boundary**

GET /api/v1/setup-assistance/screen accepts an exact route, optional tab only
for /scans, and optional appId/sourceId. Unknown or duplicate keys, unsupported
views and invalid or mismatched scope are rejected. Both filters must refer to
a coherent current binding when supplied together. A human operator session is
required; this is not an unauthenticated inventory or a service-token API.

The response identifies the route's title, recordKinds, implementation
limitation, configuredSources, activeSources, retainedRecords, bounded sources
list and omittedSources count. An authored workflow may use no telemetry kinds
and report retainedRecords as not applicable rather than zero. Zero, unknown,
not applicable and failed reads are not interchangeable.

Every run clears the prior explanation before requesting fresh facts. A failed
or invalid response must not leave an earlier result presented as a new pass.
The helper offers links to source setup and retained observations with supported
scope filters. Those links do not grant access, activate a producer, execute a
scan or remedy the underlying condition by themselves.

## 63. Private deployment, supervision, backup and recovery guidance

Open **Sources → Private deployment**. This assistant organizes six operating
responsibilities: private access, operator/persistent-state setup, continuous
operation, real data and delivery, backup/restore, and deliberate crash
recovery. It is a guide with local observations, not an installer or automated
infrastructure controller. The preferred model is a tailnet-only deployment
with no public internet exposure.

**1. Keep the service private and verify the actual exposure**

The private application listens on IPv4 loopback. For authorized remote access,
configure the real private HTTPS origin and use Tailscale Serve with restrictive
tailnet access rules. Do not use public Funnel, router port forwarding or a
public reverse proxy for this SOC. Keep operators and approved service clients
inside the intended private access boundary; configure the server origin to
match the actual route they use.

A loopback listener alone does not prove internet inaccessibility. A reverse
proxy, shared node, forwarding rule or separate tunnel could expose it. Likewise,
a configured HTTPS origin does not prove certificate validity, correct DNS,
tailnet membership, device policy or restrictive ACLs. Independently test the
intended permitted path and verify absence of public reachability from outside
the tailnet. This page does not probe public addresses or change network rules.

**2. Provision the operator and keep persistent state outside the checkout**

Use the one-time localhost administrator form on a new installation, or the
documented local account CLI, to provision the human operator; there is
no default password or public signup. Use a dedicated owner-only private state
directory outside the repository and retain that directory across restarts.
Do not put credentials or encryption keys in public bootstrap configuration,
prompts, documentation or the repository. Follow chapter 49 for precise private
account and origin setup.

The local check examines current state-entry metadata: directory/file type,
ownership, permissions and unexpected links. It does not read or return secret
file contents or the private state-directory path. Owner-only entries are not
proof that the disk, swap, snapshots or backup media are encrypted, or that a
compromised operating-system account cannot read them. Review those protections
at the host/storage layer.

**3. Arrange continuous operation and independent failure detection**

Choose an OS supervisor appropriate to the deployment. Define who owns start,
stop, restart and upgrade operations, and ensure only one writer uses a private
state directory. The guide does not install a daemon, change supervisor policy
or certify that automatic restart is configured correctly.

Use a separate private watchdog for process or host outage. The SOC cannot
collect, report its own health or send Slack alerts while its process is down.
A live source showing healthy before shutdown is historical information, not
proof that the process is still running. Have the watchdog and operator process
cover delayed collection, repeated restarts, disk pressure and upstream failure
without treating a stopped collector as a clean application.

**4. Prove the real data path and optional delivery separately**

Use Monitor my application to bind a real source and Check my setup to inspect
activation, retained records, collection checkpoints and supported destinations.
Use the first real reviewed event/report appropriate to that integration;
registration and sample validation are not admitted telemetry. A completed
empty live poll can prove collection without proving event activity.

If Slack is configured, request an explicit test in Live monitoring and then
inspect the actual destination channel. Provider acknowledgment, client receipt
and human attention are separate facts. Private deployment checks do not send a
test, rotate credentials, poll a vendor, advance a checkpoint or start Trivy.
Keep application-source ownership and upstream coverage explicit after upgrades.

**5. Back up a coordinated state set and test restoration in isolation**

Use an approved maintenance window and stop the application cleanly before
taking a coordinated whole-state backup. Include all private databases, any
SQLite journal companions and the matching monitoring encryption key. A copy of
an encrypted credential database without its corresponding key is not a usable
monitoring backup. Account, document, telemetry, service-access, setup-guide and
monitoring state have related but distinct stores; do not assume one database
contains the whole application.

Preserve the only known-good copy. Restore into an isolated private directory
with correct ownership and permissions, using the documented recovery process.
Prevent the restored copy from polling or notifying until collection ownership
is deliberately transferred. Starting two copies against upstream services can
create duplicate collection or notifications even when they use separate local
directories. Do not use a supposed verification step to mutate the original
state or contact production vendors unintentionally.

Independently test that operators can sign in, document versions can be read,
source identities/receipts remain coherent and monitoring recovery uses the
matching key and checkpoints. Record what was tested and any coverage gaps.
This assistant never performs a backup/restore or certifies its success; a local
permissions check and a present file are not recovery proof.

**6. Recover a crashed instance deliberately**

After an unclean shutdown, an existing runtime lock may block startup. Stop
competing supervisors and investigate the recorded process ownership before
changing anything. Only remove a lock confirmed stale after verifying no live
writer owns that state directory. A process ID alone can be reused; investigate
the actual process and directory ownership, not just whether a number exists.

Do not delete databases, encryption keys, journals or an unexplained lock to
make a startup error disappear. Preserve evidence of corruption, restore a
trusted state set if required and follow the exact startup/recovery guidance in
chapter 57. Restart recovery can replay a pending local batch safely but cannot
reconstruct events that the upstream service never retained or that have aged
past its collection/replay policy. Recheck actual collection and record gaps.
This page does not stop processes, remove locks or reset a blocked collector.

**Interpret local deployment facts with their stated limits**

Choose Check local deployment facts to request a point-in-time local read.
Observed means the particular reported fact was read; Operator verification
required means the server cannot establish the responsibility; Needs attention
means a detected condition needs review. There is no deployment-ready or
internet-isolated certification badge.

| Local result | Actual evidence and limitation |
| --- | --- |
| Local listener | Application configuration uses IPv4 loopback; proxies, forwarding and remote reachability are not inspected |
| Configured origin | Reports the configured origin and whether HTTPS is selected; not a certificate, DNS or ACL test |
| Private state file permissions | Current directory/entry metadata matches owner-only expectations; not disk or backup encryption proof |
| Available filesystem space | Available bytes now; under 100 MiB raises attention, but a larger value is not a capacity guarantee or growth forecast |
| Retention and capacity | Current retained telemetry count against configured capacity; auth and document storage are separate and need their own capacity review |
| Supervision and watchdog | Explicit manual responsibility; this diagnostic neither discovers nor installs a working supervisor |
| Backup and restore proof | Explicit manual responsibility; no file copy, recovery attempt or verification has occurred |

Free-space read failure is unknown, not zero and not a pass. Record/count/age/
byte/deduplication limits described in Retention still apply independently of
filesystem free space. Plan growth, alerts and cleanup policy; do not infer
that the presence of space guarantees future durable admission.

The human-only endpoint is GET /api/v1/setup-assistance/operations with no query
parameters. It reads local configuration, state-entry metadata, filesystem free
space and telemetry counters. Responses contain a checkedAt timestamp, origin,
listener/port facts and bounded explanatory checks; they do not expose secret
contents or private directory paths. Repeated/unknown query parameters and
mutation methods are refused. A failed read clears the prior result and leaves
verification incomplete. No MCP operation is added for these private host facts.

## 64. AI-assisted setup and beginner checklist

The header's Setup checklist is a resumable beginner guide, not a certification.
Start with private access and account security, then register your web app and
environment, choose a supported source path, verify real delivery, add approved
documents, and optionally connect an AI client. Personal checkmarks do not
validate these tasks; use source-specific checks and independent network and
recovery tests. The compact + beside an empty page heading opens contextual
help without keeping a large explanation above every empty screen.

Open **Agents → Service Access** to connect an external AI host. The client
selector provides appropriate configuration/instructions for Claude, Codex,
Hermes and OpenClaw, and explains limitations for Perplexity/Grok. Formats and
local capabilities differ; generated configuration is not a claim that every
vendor/version has been commissioned. A model name is not an MCP transport.

The shipped bridge is local stdio: the host launches Node with this checkout's
tools/agent-mcp.js, the private SOC origin, and an absolute token-file path.
It is not a hosted remote MCP listener. Paths belong to the client machine;
localhost also refers to that machine. A client on another tailnet device needs
private HTTPS reachability and its own reviewed installation. Keep the SOC
private; never use Funnel/public tunneling to satisfy a hosted client's URL
field. Tool results may still leave the tailnet through the host's model API.
Review provider disclosure and retention; do not send secrets or raw telemetry.

Generate configuration using file paths, never token values. Store the one-time
service credential owner-only outside the checkout. Better Auth human sessions,
service identities and source credentials are separate. A managed agent record
does not start an external agent or grant MCP access. Default read scopes do not
allow writes. Optional setup:read enables qualified setup evidence. To prepare
new declarations, explicitly approve connector:app.register,
connector:source.setup and connector:source.test. These grants cover the whole
deployment, not only an app named in a prompt. Existing-source changes require
their own exact scopes. Do not grant every mutation to avoid a denial.

Read **docs/AI-SETUP.md**, also published as soc://documentation/ai-setup, for the
complete connection, preparation, commissioning and troubleshooting runbook.
Clients supporting MCP prompts can select **setup_application**, which takes
no arguments and returns that public runbook as a user message. Retrieval makes
no private API call and grants no authority. This fixed setup prompt is not a
private managed-agent prompt revision and does not require prompts:read.
Clients without prompt UI can use the Service Access generated setup text.

The workflow is discover, ask scope, propose, obtain approval, prepare and test,
pause for human credentials/activation, observe real delivery, and report known
facts and gaps. Agents must read actual manifests/contracts, reuse stable IDs,
respect revisions and idempotency, and stop on unavailable drivers. Source
activation, credential issuance, agent privilege expansion and prompt activation
remain blocked through private MCP. Live collector creation, vendor imports,
document upload, guide writes and generic filesystem/shell access are not tools
in this bridge. Human or separately approved external-host work is required.

End of version-1 technical implementation manual.
