# Agent integration and administration

This guide is the short, machine-oriented entry point for an automation agent
that must stand up, inspect, or administer a Bulwark Black SOC deployment. Read
it together with the canonical [technical implementation manual](../public/technical-reference.md).
The Markdown manual is intentionally checked in as a raw, stable, agent-readable
resource; `public/technical-docs.js` is only its generated browser rendering.

This repository ships a data-free interface, strict browser contracts, a
loopback connector workbench, and local reference modules for the closed
administration contract. The loopback workbench exposes one canonical-log
manifest and eleven data-only scan connection templates; those templates are
schemas, not scanner drivers. The default static bridge installs no provider
and the reference modules are never a production service. A narrow reference MCP
process publishes public documentation/contracts and scoped connector/
administration operations for local integration testing. The repository does
**not** ship a production agent runner, remote execution fabric, scanner fleet,
secret store, identity system, or production MCP service. A downstream
application may install
those services behind the documented contracts. Never infer that a visible form
or empty table is an active control.

## Required reading order for an agent

1. Read `README.md` for the shipped/reference/adopter-owned boundary.
2. Read this file and `docs/ARCHITECTURE.md` for trust planes.
3. Read `public/technical-reference.md` from the beginning; do not rely only on
   a search excerpt because invariants and lifecycle gates are cumulative.
4. Read `docs/CONNECTORS.md` before registering apps, hosts, sources, scanners,
   agents, or credential references.
5. Read `docs/ADAPTER-CONTRACT.md` before producing page envelopes.
6. Read `docs/AUTHENTICATION.md` and `docs/CONFIGURATION.md` before enabling any
   browser or administrative command.
7. Validate every document with the repository validators and run `npm run
   check` after an intentional implementation change.

An agent must preserve the exact product design assets and tokens unless the
operator explicitly requests a fork. It must also preserve the data-free
checked-in baseline: generated examples, screenshots, fixtures, tests, and
documentation must not contain real security telemetry, identities, topology,
evidence, prompts, credentials, or deployment values.

## Network posture: Tailnet first and private only

The recommended deployment is a private application reachable only through a
Tailscale tailnet or an equivalently controlled private overlay. Do not publish
the SOC UI, BFF, connector control plane, administration plane, MCP facade,
ingest receivers, callbacks, or agent enrollment endpoints to public DNS or the
public Internet.

For local development, bind to `127.0.0.1`/`::1`. For a shared deployment,
bind to an explicitly selected private interface or place a private reverse
proxy in front of a loopback service. Apply tailnet ACLs/grants, tagged service
identities, device approval, key expiry, and least-privilege access so that:

- operator browsers can reach only the UI/BFF operations their roles require;
- agents and collectors can reach only their enrollment, health, and ingest
  destinations;
- scanners can reach only their authorized targets and result receiver;
- administrators can reach the administration service, while normal operators
  cannot; and
- databases, queues, secret stores, and internal projectors are not reachable
  merely because a device joined the tailnet.

Use HTTPS even inside the tailnet. Issue and rotate private certificates, verify
hostnames, and prefer service identities or mTLS for non-browser clients. A
tailnet limits reachability; it does **not** replace application authentication,
resource/action authorization, CSRF protection, request validation, audit,
rate limits, tenant binding, secret management, or secure updates. Treat a lost
or compromised tailnet device as hostile.

The checked-in static server and reference connector workbench deliberately bind
to loopback. Do not change them into remote or production servers. A production
deployment is an adopter-owned service with an independently reviewed threat
model and response-header policy.

## The three browser boundaries

The application keeps reads, source control, and administration separate:

| Boundary | Default global | Authority |
| --- | --- | --- |
| Page provider | `SOC_CONSOLE_ADAPTER` | Read authorized presentation envelopes for registered routes |
| Connector provider | `SOC_CONSOLE_CONNECTORS` | Register apps, enroll hosts, and configure/test/activate manifest-backed sources |
| Administration provider | `SOC_CONSOLE_ADMINISTRATION` | Manage agents, prompt revisions/enrollment, attestations, and risks through its closed command vocabulary |

All three objects are narrow browser clients of adopter-owned server services.
They are not databases, authorization engines, secret stores, or places to put
endpoints and tokens. The browser runtime validates shape and correlation; the
server still authenticates the caller, authorizes the exact resource/action,
checks scope and revision, commits state and audit atomically, and returns a
redacted projection.

An administration provider should follow the same fail-closed pattern as the
connector provider: a versioned `getSnapshot` read, a separately authorized
`getPrompt` read for one prompt body, a versioned `execute` command, optional
`dispose`, correlated request IDs, idempotent retries, the exact current
administration snapshot revision, closed outputs, and bounded safe errors. Its precise
version-1 commands and documents are defined by the administration runtime in
the application build. The exact current commands are `agent.create`,
`agent.update`, `agent.pause`, `agent.resume`, `agent.archive`, `agent.restore`,
`agent.remove`, `prompt.revise`, `prompt.activate`, `prompt.archive`,
`enrollment.issue`, `enrollment.revoke`, and the create/update/transition/
archive/restore/remove families under `attestation.*` and `risk.*`. Never add
an undocumented command by passing arbitrary method names or payloads through
the provider.

## Shipped scan connection templates

`server/reference-manifest.js` includes one exact manifest template for each
Scans tab so a human or agent can select a connector/source kind and discover
the expected non-secret settings and opaque credential slots through the
version-one connector snapshot. All templates are host-scoped: the host is the
enrolled private collector/runner identity, even when the eventual driver calls
a service API. Register the app, enroll and prove the runner host, then issue
`source.setup` with the exact manifest-selected fields.

The templates contain no network or scanner implementation. The loopback
runtime accepts their setup registration for inspection but rejects
`source.test` with `connector-unavailable`; it also blocks activation and never
issues scan-template ingest credentials. An agent must not retry around that
failure, call a vendor directly, install an unreviewed package, or report the
source as connected. Stop and obtain an approved driver/receiver design,
normalizer, egress policy, secret-reference policy, admission path, and
projector. Canonical log push is the only executable connector driver in the
reference workbench.

| Scan | Connector/source kind | Config after required cadence | Credential-reference slots |
| --- | --- | --- | --- |
| Trivy | `trivy-template` / `trivy.scan` | collection mode, scan target, optional private endpoint, severity | optional registry and scanner access |
| Patch first | `patch-first-template` / `patch-first.feed` | provider endpoint, platform scope, prioritization, grace period | required provider API access |
| File integrity | `file-integrity-template` / `file-integrity.event` | paths, exclusions, digest, baseline policy | optional collector access |
| End of life | `end-of-life-template` / `end-of-life.inventory` | catalog endpoint, product scope, warning horizon | optional catalog API access |
| External surface | `external-surface-template` / `external-surface.scan` | scanner endpoint, authorized targets/ports, profile | required provider API access |
| IOC scan | `ioc-scan-template` / `ioc.scan` | indicator endpoint, paths, kinds, pinned ruleset | optional feed access |
| urlscan.io | `urlscan-template` / `urlscan.result` | API endpoint, URL scope, visibility, watch mode | required API access |
| Dependencies | `dependency-template` / `dependency.inventory` | inventory, ecosystems, optional advisory endpoint, format | optional source/advisory access |
| DLP / ClamAV | `upload-av-template` / `upload-av.event` | scanner address, upload scope, byte cap, detection action | optional scanner access |
| Quarantine | `quarantine-template` / `quarantine.event` | store endpoint, namespace, retention, retrieval policy | required store and optional encryption access |
| Remediation | `remediation-template` / `remediation.record` | workflow endpoint, project, sync, verification policy | required workflow and optional evidence-store access |

All credential fields accept only `{slot, store, referenceId}`. The
`referenceId` names a server-side secret-store entry and is never the secret
value. The browser exposes no credential readback, and the MCP facade blocks
credential-issuing connector commands. Following a scan's setup link selects
its exact template; the UI enables only that template's controls so unrelated
required fields cannot enter validation or a command. Switching templates may
retain non-secret draft text in the current DOM, but it does not persist draft
credentials or values in application state.

## Agent lifecycle

An **agent registration** describes a managed automation identity and safe
operational metadata. It is not a running process. Recommended fields include a
server-issued immutable ID, display name, provider/runner type, enabled
capabilities, lifecycle state, prompt-head revision, connection state,
timestamps, and entity revision. Version 1 uses agent states `active`, `paused`,
and `archived`; `agent.create` creates an active record and `agent.restore`
returns it to active. Do not use display names as identity.

Use this lifecycle:

1. **Create/register.** An authorized administrator defines the agent, selects a
   reviewed runner type, grants the minimum capability set, and assigns only
   reviewed capability list. The server issues the stable ID in active state.
2. **Draft prompt.** Store prompt text and metadata as an immutable prompt
   revision. Keep system policy separate from operator-authored task guidance;
   do not let a prompt grant a capability the server has not authorized.
3. **Review and activate.** A human reviews the exact revision and activates it
   as the agent's prompt head. The version-1 prompt metadata does not expose
   actor, reason, or content digest; a production service should keep those in
   its protected audit/history. Do not silently edit an active prompt in place.
4. **Enroll/connect.** Mint a one-time, short-lived enrollment value, display it
   once, store only a digest/reference, and bind the proof to the agent ID,
   intended runner, nonce, audience, expiry, and private endpoint. Successful
   enrollment proves a connection path, not broad authorization.
5. **Operate.** The runner authenticates with a rotated service identity and can
   call only the tools allowed by current assignments and capabilities. Each
   command is re-authorized server-side. Record health and last proof separately
   from lifecycle state.
6. **Update.** Change metadata or capabilities with the exact current
   administration snapshot revision. Material privilege expansion requires explicit
   review. Concurrent/stale writes conflict instead of overwriting.
7. **Pause/archive.** `agent.pause` stops operation while retaining the record;
   `agent.archive` moves the record to archived. Revoke live credentials and
   leases as production policy requires. Neither erases prompt/enrollment/audit
   history.
8. **Restore.** `agent.restore` returns an archived record to active through an
   authorized command and a new revision. It does not automatically reissue an
   enrollment or validate an old runtime credential; re-review both.
9. **Remove.** Prefer archival. Hard removal is exceptional, dependency-aware,
   retention-policy controlled, and must preserve a tombstone and audit chain.
   Refuse removal while assignments, attestations, risks, evidence, active jobs,
   or unexpired credentials still depend on the agent.

Prompt revisions are operational configuration and may contain sensitive
instructions. Do not commit production prompts to this public repository, emit
them in logs, include them in page/search indexes, or expose them to roles that
cannot administer the agent. Prompt rendering is literal text, never markup.
Prompt input is not trusted policy: tool authorization, scope, approval gates,
budgets, and forbidden operations remain server-enforced.

## Agent assignments and credentials

The checked-in version-1 agent document exposes a bounded capability list; it
does not define a separate assignment entity. If a production extension adds
assignments, they must reference stable IDs and describe one bounded
relationship, such as an estate, app, source, scanner, route capability, or
review queue. The server must verify that the administrator and agent are both
authorized for the target. Removing an assignment takes effect for new commands
immediately and invalidates cached authorization decisions. Do not silently add
assignment fields to a version-1 snapshot; version the contract first.

Never persist or replay plaintext enrollment or API-key material. A browser may
receive a one-time value only in the successful issuance result. Long-lived
runtime credentials belong in an adopter-owned secret manager and are resolved
by the runner; records and snapshots carry only opaque references, store type,
version, and safe rotation/expiry metadata. Revocation must terminate leases,
invalidate tokens/certificates, and be visible as a separate audited result.

The local reference administration runtime demonstrates one connection proof.
After `enrollment.issue`, the intended agent submits the returned one-time value
to loopback `POST /api/v1/agents/connection` using the `Enrollment` authorization
scheme and a separate data document containing exactly
`schemaVersion: "1"`, the issued `agentId`, the issued `enrollmentId`, and a
fresh RFC 3339 `observedAt`. The credential is not a JSON field. A successful
proof marks that enrollment connected and updates safe last-seen metadata; it
does not create a general command, telemetry, or remote-execution channel.
Exact endpoint/bind behavior belongs to the application or loopback host that
mounts the runtime. Production replaces the proof with authenticated private
TLS and a rotated workload identity while retaining purpose, audience, expiry,
replay, and revocation checks.

## Optional MCP facade

The shipped reference MCP process is an additional local client of the same
connector and administration boundaries. It is optional and not required to use
the UI. It exposes documentation/contract resources and five narrow tools
covering connector and administration snapshots/commands and one authorized
prompt read. A production adopter may implement an equivalent private service, but
must replace the loopback reference assumptions with real identity and policy.
The facade calls the same canonical API/RBAC decision boundary as UI or CLI
clients; it must never maintain a parallel registry or weaker policy.

Start the loopback reference workbench first, then start the stdio MCP process:

```sh
npm run start:agent-mcp
```

The default control origin is `http://127.0.0.1:8787`. Override it only with
`SOC_AGENT_MCP_BASE_URL` or `--base-url`. Plain HTTP is accepted only for exact
loopback. HTTPS is restricted to loopback, private RFC 1918/CGNAT/ULA addresses,
or the validated private-overlay DNS suffix. No tool argument accepts a URL and
redirects are refused.

The exact reference tools are:

| Tool | Arguments | Boundary |
| --- | --- | --- |
| `connector_snapshot` | `{ reason?: "initial"/"refresh"/"command", knownRevision?: integer >= 0 }` | Fixed connector snapshot endpoint and validated response |
| `connector_command` | `{ request: connector-command-request }` | Fixed connector command endpoint; refuses `host.enroll` and `source.activate` because they issue credentials |
| `administration_snapshot` | `{ domain: "agents"/"governance", reason?: "initial"/"refresh"/"command", knownRevision?: integer >= 0 }` | Fixed administration snapshot endpoint |
| `administration_prompt` | `{ promptId: stable-id }` | One separately authorized prompt document; no bulk prompt export |
| `administration_command` | `{ request: administration-command-request }` | Fixed administration command endpoint; refuses credential-issuing `enrollment.issue` |

Run `host.enroll`, `source.activate`, and `enrollment.issue` only through the
protected operator UI (or an equivalently reviewed non-MCP ceremony) so their
one-time results are deliberately presented and stored. The reference MCP has
no credential-issuance fallback.

Resources are read-only checked-in public files. Documentation URIs are
`soc://documentation/technical-manual`, `soc://documentation/agent-guide`,
`soc://documentation/connectors`, `soc://documentation/architecture`,
`soc://documentation/configuration`, and `soc://documentation/features`.
Contract/runtime URIs under `soc://contracts/` are
`administration-v1-schema`, `connector-manifest-v1`,
`source-registration-v1`, `normalized-record-v1`, `ingest-batch-v1`,
`page-model-v1`, `connector-runtime-v1`, `administration-runtime-v1`,
`page-runtime-v1`, and `ingest-runtime-v1`.

The stdio process supports the 2026-07-28 JSON-RPC discovery/meta flow and legacy
initialize-era clients. It applies request/response/time bounds, refuses
redirects, uses fixed canonical endpoints, and redacts remote errors. It exposes
no generic fetch, shell, SQL, filesystem-path, telemetry, credential resource,
secret echo, or arbitrary URL capability. Service identity and authentication
remain adopter-owned. Human approval remains required for destructive,
privilege-expanding, prompt-activation, or production-impacting calls even when
the tool contract accepts the request.

A safe facade may expose:

- public documentation resources such as this file and the raw implementation
  manual;
- list/describe operations for installed connector manifests and safe registry
  projections;
- narrow, schema-validated begin/test/activate or agent-management tools when
  the authenticated principal is authorized;
- health reads and deterministic dry-run/validation tools; and
- command results that match the UI/CLI service's idempotency, revision, audit,
  and redaction semantics.

It must not expose raw log streams, unrestricted search, plaintext secret entry
or retrieval, arbitrary shell/SQL/HTTP execution, unreviewed prompt activation,
direct database writes, public network tunneling, or a second authorization
path. Telemetry uses authenticated bounded ingest transports, never MCP. Treat
MCP tool descriptions and arguments as untrusted input, protect against confused
deputy/cross-scope requests, and require human approval for destructive or
privilege-expanding operations.

## Standing up the application with an agent

An authorized implementation agent can perform the mechanical integration, but
it cannot invent deployment policy. Give it an explicit target application,
private network, identity/BFF choice, approved connector inventory, secret-store
reference scheme, tenant/estate model, data classification/retention rules, and
human approvers.

The safe sequence is:

1. Run the unmodified static shell on loopback and verify the empty states.
2. Inventory every registered route and decide `ready`, `empty`, `unavailable`,
   or `forbidden` behavior; do not fabricate sample records.
3. Implement server authentication and resource/action authorization.
4. Implement and validate the page provider using redacted projections.
5. Review or replace the shipped data-only scan templates, then install their
   server-side drivers, normalizers, admission controls, and projectors. A
   template alone must continue failing test/activation closed.
6. Integrate a write-only secret provisioning flow that returns opaque
   references; never ask the agent to paste secrets into source code or public
   config.
7. Implement the administration provider and its durable audit/lifecycle store
   before enabling agent, attestation, or risk mutations.
8. Bind the resulting services to loopback/private tailnet addresses, apply
   private TLS and ACLs, and verify there is no public ingress or public DNS.
9. Exercise absence, denial, conflict, stale revision, replay, partial failure,
   archive/restore, credential rotation, and recovery paths.
10. Run repository checks plus deployment-specific integration, security,
    accessibility, backup/restore, and disaster-recovery tests.

An agent should stop and request a human decision when a step requires a new
public endpoint, privilege expansion, destructive removal, retention exception,
credential disclosure, security-policy change, or interpretation of real
operational evidence. Passing local repository tests is not deployment
approval.

## Agent completion report

For any implementation, report:

- changed contracts, routes, manifests, projectors, and lifecycle commands;
- which capabilities are shipped, reference-only, proposed, or adopter-owned;
- private bind addresses and verified absence of public exposure;
- data stores and secret-reference schemes used, without secret values;
- migration, rollback, backup/restore, and credential-revocation procedures;
- tests run and the empty/denied/conflict/failure cases covered; and
- remaining human decisions or controls.

Never claim that a source is collecting because setup/test succeeded, that an
agent is safe because it connected, or that a scan/governance screen is managed
because its structural UI is visible. State must come from an authenticated
result and the corresponding authorized read projection.
