# Architecture

## Purpose

The repository provides a data-free Bulwark Black SOC interface and a runnable
private starter. It preserves product design and the 38-route SOC topology,
plus local technical documentation and a private document library. Narrow
browser contracts separate page data, identity projection, source management,
and agent/governance administration.

`npm start` runs the private Better Auth application with SQLite identity and
versioned document stores, application/environment registration, optional
collectors, canonical log push, Trivy report import and agent/governance lifecycle
management. Private telemetry and scoped service credentials use dedicated
SQLite stores; administration retains the bounded JSON reference core. All
operators have full access, while service identities have exact installation-
wide scopes. Granular resource authorization and multitenancy remain adopter
work. There is no scheduler, durable queue, vendor polling, agent runner or
remote MCP listener. The stdio MCP client uses scoped private service access.

`npm run start:static` retains the dependency-free static preview. A separate
opt-in development workbench (`start:connectors`) exercises source and
administration contracts without real operator authentication; never expose it
remotely. Only the private starter requires the installed runtime dependencies.

## System view

```text
                         PUBLIC / BROWSER BOUNDARY
┌──────────────────────────────────────────────────────────────────┐
│ index.html + exact brand assets + active-ui.css + app.css        │
│                              │                                   │
│              frozen public configuration                         │
│                              │                                   │
│ page + browser-auth + connector + administration contracts       │
│                              │                                   │
│ 38 SOC routes + Docs + Documents -> controller -> safe renderers│
│                              │                                   │
│ page/control providers absent OR explicit/injected providers     │
└──────────────────────────────┬───────────────────────────────────┘
                               │ closed session/page/control models
                  ADOPTER APPLICATION TRUST BOUNDARY
                               │
┌──────────────────────────────▼───────────────────────────────────┐
│ private starter: Better Auth sessions + validation + audit       │
│                              │                                   │
│ connector registry + administration + identity/workflow services │
│                              │                                   │
│ telemetry admission -> canonical records -> page projectors      │
│ SQLite identity/documents/telemetry/services + JSON admin state   │
└──────────────────────────────────────────────────────────────────┘
```

The adopter operates and reviews this application boundary. The starter now
implements real sessions and document persistence but does not remove capacity,
authorization, deployment, backup, or integration responsibilities. Browser
contracts and the development workbench do not confer server privileges.

The recommended deployment places this entire application boundary on a
Tailscale tailnet or equivalent private overlay. Expose no UI/BFF,
administration, connector, MCP, enrollment, ingest, or callback endpoint through
public ingress or public DNS. Use loopback for development and explicit private
reverse proxies for shared service; the starter itself remains on loopback and
uses its configured exact private HTTPS origin behind Tailnet Serve, never
Funnel. Tailnet ACLs, tagged
service identities, device approval, private TLS/mTLS, and key rotation limit
reachability. Application authentication, action/resource authorization, CSRF,
validation, rate limits, audit, and secret management remain mandatory because
private reachability is not authorization.

## Runtime composition

The default document uses ordered classic scripts:

```text
public/index.html
  |
  +-- public/app-config.js       validate/freeze public config
  +-- public/adapter-contract.js install page-provider/envelope v1
  +-- public/auth-contract.js    install browser-auth integration v1
  +-- public/connector-contract.js
  |                              install connector-control v1
  +-- public/administration-contract.js
  |                              install agent/governance administration v1
  +-- public/application-bridge.js
  |                              inert static integration hook
  +-- public/technical-docs.js   generated frozen technical manual
  +-- public/ui-catalog.js       define 38 SOC routes, /docs, /documents
  +-- public/document-library.js private document UI/API client
  +-- public/app.js              empty states, renderers, factory/controller
  +-- public/bootstrap.js        resolve integrations and mount once
  |
  +-- public/active-ui.css       sanitized exact active component styles
  +-- public/app.css             portable renderer mappings and layout
  +-- public/assets/*            exact product mark and favicon set
```

`app-config.js` exposes `window.SocConsoleConfig`.
`adapter-contract.js` exposes `window.SocConsoleAdapterRuntime`.
`auth-contract.js` exposes `window.SocConsoleAuthRuntime`.
`connector-contract.js` exposes `window.SocConsoleConnectorRuntime`,
`administration-contract.js` exposes `window.SocConsoleAdministrationRuntime`,
`technical-docs.js` exposes the frozen `window.SocConsoleTechnicalDocs`, and
`app.js` exposes the frozen `window.SocConsole` namespace. The checked-in
`application-bridge.js` installs nothing in static mode. The private application
serves authenticated page/control/auth providers at that hook before bootstrap;
the separate development workbench serves its explicitly non-production bridge.
`document-library.js` remains inactive without the private application marker.

The application factory is composed with validated dependencies:

```js
const app = window.SocConsole.createApp({
  root: document.getElementById("content"),
  shellRoot: document.getElementById("soc-console"), // omit for a root-only embed
  provider: validatedProviderOrNull,
  auth: validatedAuthIntegrationOrNull,
  commands: validatedConnectorProviderOrNull,
  administration: validatedAdministrationProviderOrNull,
  config: window.SocConsoleConfig
});
```

Only the supplied `root` element is required by `createApp`; every external
shell hook is null-checked. A root-only embed renders route content, tabs,
catalog structures, state, and provider panels. The full sidebar, grouped and
compact navigation, auth chip, page filter, timezone/refresh controls,
connection state, toast, and command palette require their committed
`public/index.html` hook IDs. Hook discovery is scoped to an explicit
`shellRoot` or the nearest `[data-soc-console]` ancestor and never searches the
whole host document. Default bootstrap requires `#content` and passes
`#soc-console` as its shell root.

The controller exposes:

```text
mount()                  install listeners and render the initial route
unmount()                remove listeners, invalidate results, clean up
navigate(path, query={}) serialize an absolute path/query into the hash router
refresh()                reread session/page with reason `refresh`
getState()               return the current frozen state snapshot
```

An injected page provider is refreshed every 300,000 milliseconds while
mounted; no interval runs for the adapter-absent baseline. Manual refresh
uses the same read lifecycle. Unmount clears controller-owned timing and
invalidates any late result.

Bootstrap resolves globals named by `config.adapter.globalName`,
`config.auth.globalName`, `config.connectors.globalName`, and
`config.administration.globalName`, validates them,
passes them to `createApp`, and exposes the controller as
`window.SocConsoleApp` before calling `mount`. The separate
`window.SocConsoleAppReady` promise settles when mounting finishes, so a host can
still inspect or unmount a controller while an integration read is pending. A
mount failure renders a safe accessible error panel.

An embedded host can omit `bootstrap.js`, own controller creation, and unmount
before removing/replacing the shell. Unmount is terminal for an injected
provider controller and disposes its provider at most once; create a new
provider/controller pair instead of remounting it.

## Empty baseline flow

```text
URL hash -> 38 SOC routes -> route heading + data-free structural panels
         -> adapter-absent state (no envelope, provider read, or refresh timer)
         -> /docs -> checked-in manual (no page/connector/admin provider read)
         -> /documents -> explicit private-service-required state in preview
```

No route renderer owns records, counts, identities, timestamps, events,
findings, systems, policy, evidence, or operational verdicts. Absence of an
adapter is visible as absence, not disguised as live/ready data.

## Injected page-provider flow

```text
URL hash
   -> { schemaVersion, route, query, reason }
   -> validateRequest
   -> provider.readPage
   -> validateEnvelope(expected route)
   -> hydrate matching catalog panel IDs + append unmatched typed panels
```

The UI catalog always owns the selected route/tab's structural panel IDs. A
valid provider panel with a matching ID hydrates that visual slot; unmatched
panels render in a distinct **Additional authorized data** region. Version 1
never matches by title, label, or position and never activates catalog forms or
actions. Compatible matching tables and metrics retain their catalog-owned
route presentation wrappers/classes while authorized values replace empty
content. The renderer creates elements and assigns safe text/attributes; it does
not accept adapter markup.
Request sequence tracking prevents an earlier asynchronous response from
replacing a later route. Contract v1 remains data-only and does not pass
`AbortSignal`; unmount or navigation invalidates stale results but may not
cancel provider-owned I/O.

See [ADAPTER-CONTRACT.md](ADAPTER-CONTRACT.md).

## Connector-control and ingest flow

The page adapter remains read-only. Source management uses a separate closed
provider:

```text
/onboard or /sources
   -> { schemaVersion, reason, knownRevision? }
   -> connectorProvider.getSnapshot
   -> validate connector-control snapshot
   -> render installed connector types, apps/environments, optional hosts,
      setups, sources, changes

operator action
   -> typed app.register | host.enroll | source.setup | source.test |
      source.activate | source.update | source.pause | source.resume |
      source.revoke | source.rotate | source.archive | source.remove request
   -> connectorProvider.execute
   -> validate correlated result
   -> reread the control snapshot and affected page envelope
```

The contract uses independent, stable `appId`, `hostId`,
`connectorInstanceId`, and `sourceId` values. Connector manifests own the
allowed source kinds, non-secret configuration fields, credential-reference
slots, canonical output families, page targets, and health policy. The UI does
not accept arbitrary kinds or let an operator declare whether output is
searchable.

Applications do not require hosts. Canonical push selects a registered app
environment and can be configured/tested/activated with no collector. A bounded
real sample validates shape only and is not ingested or evidence of delivery.
Selecting a collector adds enrollment/proof requirements. Scanner setup
templates require hosts and fail closed because no drivers are installed.
Pause refuses ingest; update/revoke/archive/remove/rotation invalidate the
appropriate old credentials. Removal retains a tombstone and historical data.

Telemetry does not travel through the command provider. Push, webhook, pull,
OTLP, syslog, and agent transports terminate in server-side admission logic,
which authenticates a stable source, validates a bounded payload, deduplicates
it, commits a receipt and canonical records, and drives idempotent page
projectors. The private app supports canonical `log.event` push and bounded
Trivy report normalization; the disposable workbench retains its reference
behavior. Webhook/pull/OTLP/syslog are extension guidance, not shipped receivers.
The private machine ingest endpoint uses scoped bearer proof
without a browser cookie/Origin; browser control endpoints require the operator
session and matching Origin. See [CONNECTORS.md](CONNECTORS.md).

## Document persistence flow

The local `/documents` page calls the private authenticated document API, never
the SOC page adapter or connector command provider. Uploads, metadata changes,
new immutable versions, archive/restore, and audit history commit in a dedicated
SQLite store. Each version retains its bytes, filename, MIME metadata, length,
and SHA-256 digest; downloads verify the digest and force attachment delivery.
Optional app/record references are metadata associations, not automatic changes
to risk or attestation state. No malware scanning or document-content execution
is provided. Current limits are 10 MiB per file, 512 MiB total version bytes,
1,000 documents, and 10,000 versions. There is no hard-delete UI or automatic
retention worker. Backups must include document bytes and identity/state stores.

Private telemetry uses indexed SQLite records and replay receipts, with control
metadata, source health and audit committed in the same transaction. Hot-path
reads do not clone all retained telemetry. Retention, capacity, replay windows
and legacy migration are explicit contracts; see the technical manual.
Administration and the disposable connector workbench still use single-writer
bounded JSON state and crash-detecting journals. The workbench's connector
limits remain 8 MiB state, 50 MiB audit and 10,000 records/receipts. Do not run
replicas against the same state directory. Successful small-workload tests do
not prove unrestricted ingestion scale or power-loss resilience.

## Administration flow

Agent and governance mutations do not belong in page envelopes or in the
connector provider. They use domain-separated snapshots and the closed
`SOC_CONSOLE_ADMINISTRATION` command boundary:

```text
/agents, /attestations, or /register
   -> administrationProvider.getSnapshot({ domain, reason, knownRevision? })
   -> validate domain-specific agents/prompts or attestations/risks projection

authorized prompt-body read
   -> administrationProvider.getPrompt(stable prompt selector)
   -> validate one literal-text prompt document; never bulk snapshot bodies

authorized action
   -> exact versioned agent.*, prompt.*, enrollment.*, attestation.*, or
      risk.* command + expected administration snapshot revision
   -> administrationProvider.execute
   -> validate correlated result
   -> reread the administration snapshot and affected page projection
```

The version-1 vocabulary supports `agent.*` create/update, pause/resume,
archive/restore/remove; `prompt.*` revise/activate/archive; and
`enrollment.*` issue/revoke. Governance uses `attestation.*` and `risk.*` with
create, update, transition, archive, restore, and dependency-aware remove
actions. `archived` is an explicit contract state/status; a production adopter
that preserves a separate previous state or archive timestamp does so as a
versioned server extension, not an undeclared browser field. Removal is
exceptional and must preserve retention-required audit/tombstone data.

An administration snapshot never carries a plaintext enrollment value, API
key, access token, credential, evidence body, or unrestricted prompt for an
unauthorized viewer. One-time enrollment values appear only in an authorized,
correlated issuance result. A production server owns authentication,
resource/action authorization, idempotency, optimistic concurrency,
transactions, retention, redaction, and durable audit. The static browser
contract does not grant any of them.

The shipped narrow stdio MCP facade exposes public documentation/contracts plus
five connector/admin operations. With an owner-only token file it calls the
private service API: digest-backed credentials, expiry/revocation and exact
command scopes are checked server-side. Without a token it targets the disposable
workbench. Service scopes are installation-wide, not resource-specific RBAC.
Browser cookies must not be exported to the client.
A production replacement uses the same canonical service/RBAC
decisions. It must not become another store, authorization engine, telemetry
transport, plaintext-secret channel, arbitrary URL client, or execution
tunnel. See [AGENTS.md](AGENTS.md).

## Browser authentication flow

Bootstrap can resolve a version-1 auth integration:

```text
SOC_CONSOLE_AUTH
   -> validate/bind { getSession, login, logout }
   -> getSession() returns closed session projection
   -> auth.required gates page rendering when configured
```

The projection contains only `authenticated` and optional display/capability
fields. The validator rejects raw claims, subject/session IDs, cookies,
credentials, and access/refresh/ID tokens. Login/logout receive only an internal
hash return route.

The browser contract does not implement OIDC. The private starter implements
Better Auth sessions and disables public account registration; account creation
is an operator CLI action. SQLite session storage, mutation-origin checks, and
the full-access operator gate live on the server, not in browser capabilities.
The private-only Access → Who projection reports that real session and operator
inventory, bounded to 200 displayed names plus the total. It does not manufacture
roles or populate the other Access tabs and is separate from telemetry projectors.
For an OIDC replacement, Authorization Code + PKCE, token
validation, confidential client credentials, server session/cookies, CSRF,
logout-token validation, and resource authorization belong to the BFF. See
[AUTHENTICATION.md](AUTHENTICATION.md).

## Routing

The UI catalog is the source for route lookup, primary navigation, compact
selection, detail-parent relationships, titles, focus behavior, and tests.

- **Twenty-seven SOC primary paths** populate the six grouped navigation areas;
  the local `/documents` library adds a twenty-eighth grouped destination.
- **Two additional primary paths**, `/onboard` and `/settings`, are reached
  through shell controls instead of sidebar destinations. These complete the
  29-SOC-primary-route set (30 primary destinations including Documents).
- **Nine detail/utility paths**—`/analyst`, `/event`, `/ip`, `/search`,
  `/host-scan`, `/kev`, `/source`, `/attestation`, `/risk`—remain directly addressable and
  adapter-readable without being duplicated as primary navigation.
- **One shell-owned local utility**, `/docs`, renders the checked-in technical
  manual and is deliberately excluded from the page, connector, and
  administration providers.
- **One application-owned local page**, `/documents`, uses the private document
  API instead of SOC page envelopes. The catalog therefore registers 40 paths.
- Unknown paths render not found; they are not normalized to Overview.
- Query values remain untrusted and are validated/authorized by the host.

Hash routing keeps the static shell independent of server rewrite rules.

## Rendering model

The catalog renderer composes the product's data-free forms, table headers,
tabs, cards, metrics labels, charts, timelines, and explanatory slots. It never
adds rows, counts, identities, timestamps, or operational status.

Separately, the version-1 provider renderer accepts data-only `notice`,
`metrics`, `table`, `timeline`, `bars`, stacked time-series `chart`, `text`, and `empty` panels for catalog
slots or the Additional authorized data region. Typed cells provide text,
number, badge, and
machine-readable time semantics. Supplied tables receive captions/header scope,
may carry bounded text-only row disclosures and renderer-built internal route
links, dates use machine-readable values, charts retain a literal data-table
equivalent, and provider values never become markup or executable content.

## State model

Application state separates lifecycle, route, provider, and authentication.
Page envelopes carry one of:

```text
loading | ready | empty | error | unavailable | forbidden
```

`empty` means a completed authorized request with no content; it must not hide
denial/failure. `error`/`unavailable` copy is safe for operators, while protected
diagnostics belong to the adopter service. Missing/unauthenticated auth
integration becomes a gate when `auth.required` is true.

## Configuration ownership

Browser configuration contains only public contract version,
skeleton/application mode, brand, page/auth/connector/administration global names,
auth-gating Boolean, and known default route. It is validated and frozen before
mount.

Endpoints, credentials, roles, policies, private names, page data, and topology
are not browser config. See [CONFIGURATION.md](CONFIGURATION.md).

## Properties of the static public baseline

- Static preview resources have no external runtime dependency chain; the
  private server uses pinned installed dependencies.
- The default document policy denies browser connections, objects, base changes,
  form submission, and child resources outside the allowlist.
- The static preview server sends framing and related response-header policies.
- The static bridge installs no browser network client or command provider;
  preview JavaScript performs no persistence, upload, telemetry collection, or
  environment discovery on its own. The private server deliberately installs
  authenticated providers and enables the separate document upload client.
- All 38 SOC routes are empty without an injected provider; `/docs` remains
  readable from trusted checked-in content.
- Page/auth objects are strictly allowlisted, normalized, and frozen/bound.
- Provider-supplied markup, raw auth artifacts, and executable values are
  rejected.
- Source-management controls remain disabled unless a validated connector
  provider is explicitly installed.
- The public audit allowlists committed files and exact product-asset hashes.

These properties describe the static preview, not the live private server.
Neither the empty catalog nor the limited starter is evidence that a scanner,
detector, approval process, or production security control is operational.

## Repository map

```text
public/                         deployable empty interface/browser contracts
  assets/                       exact product mark and icons
contracts/                      page, connector, source, record, ingest schemas
examples/provider-template.js  deterministic empty provider
examples/keycloak-reference/   placeholder-only OIDC/BFF review templates
docs/                           adoption, auth, contract, feature, design guidance
test/                           route, behavior, contract, and boundary tests
tools/serve.js                  loopback-only static preview server
tools/private-account.js        private operator provisioning/recovery CLI
tools/validate-provider.js      page-envelope document validator
tools/validate-connector.js     connector/control document validator
tools/validate-ingest.js        canonical record/batch validator
tools/agent-mcp.js              narrow stdio docs/control reference client
tools/public-audit.js           strict checked-in public-boundary audit
server/private-application.js    default private application / authenticated APIs
server/private-auth.js           Better Auth and SQLite identity/session store
server/document-store.js         SQLite metadata, immutable versions, audit
server/reference-*.js            bounded connector/admin core and development host
```

## Extension points

### Supply page data

Implement a provider that returns authorized version-1 envelopes for known
routes. Prefer existing panel types, normalize upstream responses before output,
and return explicit absence/denial/failure states.

### Supply authentication integration

Use the shipped private authentication bridge, or implement `SOC_CONSOLE_AUTH`
as a thin browser bridge to a replacement BFF. Return
only the closed session projection and use internal-hash login/logout return
routes. Do not put OIDC/token/session implementation in the static shell.

### Supply sources and connectors

Implement `SOC_CONSOLE_CONNECTORS` as a thin browser client of the same
authenticated, authorized command service used by CLI or optional MCP tooling.
Return only validated snapshots/results, keep credential values out of all
persistent objects, and use connector manifests as the source of UI fields,
source kinds, health policy, and projector targets. Keep telemetry on dedicated
data-plane transports; MCP and the browser command provider are control-plane
clients, never log transports.

### Supply agent and governance administration

Implement `SOC_CONSOLE_ADMINISTRATION` as a thin browser client of one
authenticated administration service. Keep agent prompts/version history,
assignments, enrollment identities, attestation evidence references, risk
history, and deletion policy server-side. Return only domain-authorized
snapshots and correlated results for the closed command vocabulary. Re-read
after every mutation; never let the browser manufacture optimistic lifecycle
state. Optional MCP tools call this same service under the same principal and
policy.

### Add a route

1. Add metadata/parent relationships to the UI catalog.
2. Keep its checked-in content empty.
3. Preserve primary/detail navigation semantics.
4. Add route, unknown-route, auth-gate, keyboard, and state tests.
5. Update [FEATURES.md](FEATURES.md) and run `npm run check`.

Adding a route to an external provider does not automatically register it in
the browser catalog.

### Add a presentation type

Prefer composition from existing panels. A new contract type is a versioning
decision requiring schema/runtime changes, safe renderer coverage, contract
documents, tests, and documentation.

### Enable other networking or commands

The connector contract activates only its closed source-management vocabulary.
Keep every other operational integration outside the strict empty-skeleton
audit boundary unless a downstream repository establishes a reviewed policy.
Replace the baseline CSP with one reviewed response-header policy. Define
versioned command contracts, server authorization, idempotency/concurrency,
audit, failure, and abuse controls before activating any other structural
action.

## Architectural invariants

1. The checked-in shell and all 38 SOC routes remain data-free; the additional
   documentation route contains public implementation guidance only.
2. Operational authority stays outside the static renderer; injected providers
   are clients of an application-owned server boundary.
3. Browser configuration contains no secret, record, or policy decision.
4. Page output is narrow, versioned, authorized presentation data.
5. Browser auth output is a closed projection, never raw OIDC/session material.
6. The renderer accepts no provider markup or executable value.
7. Route/auth/state failures are explicit rather than silently falling back.
8. Exact product theme/brand remain the default.
9. Desktop, compact, keyboard, and reduced-motion experiences expose the same
   route/state information.
10. Shared deployments are private-tailnet services with no public ingress;
    tailnet reachability never replaces application security controls.
11. The strict public audit remains meaningful; the inert static mode and
    opt-in loopback reference workbench remain explicitly distinguishable.

CI and GitHub repository-readiness work is intentionally outside this
architecture. The adopter owns delivery/repository governance.
