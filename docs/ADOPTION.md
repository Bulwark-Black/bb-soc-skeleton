# Adoption guide

This guide is for teams that want to take the public interface skeleton from a
source checkout, place it in an existing stack, and supply authorized SOC page
models, or run the included private Node application. The repository supplies
the browser shell, all 38 SOC route paths, a document library, one shell-owned
technical documentation route, the product's committed
visual language, empty/failure states, and versioned page, auth,
connector-control, administration, and canonical-ingest contracts. The
invariant is **38 SOC routes plus `/documents` plus local `/docs`: 40 paths**.
The private starter includes real sign-in, indexed telemetry, scoped service
access, Trivy report import, and durable document storage but no
committed operational data or all-purpose production security backend.

## Start with the private application

Use Node.js 22.13 or newer, run `npm ci`, choose a persistent owner-only
canonical directory outside the checkout, and follow this sequence:

```sh
npm run account -- create --state-dir /absolute/private/bb-soc-state --email operator@example.invalid --name "SOC operator"
npm start -- --state-dir /absolute/private/bb-soc-state
```

Replace the example identity locally. The password is entered with terminal
echo disabled and must be 15–128 characters. Open `http://127.0.0.1:8080`, sign
in, register an application/environment without inventing a host, configure a
canonical event source, test a bounded sample, activate it, and send a real
authorized event through the ingest contract. Then verify the event in Logs,
Overview, Analytics, Sources, and Health. Configuration alone does not create
health or data. The separate Trivy report importer accepts supported JSON from
a scanner you run yourself; the application does not execute scans.

Use Govern → Documents to upload a document, inspect its hash/version history,
change its review metadata, and archive/restore it. Restart with the same state
directory and verify the account, source state, document bytes, and history
remain. Authentication, documents, service credentials, and private telemetry
use SQLite. Private telemetry uses indexed queries, bounded retention, and
atomic record/receipt/control commits; agent/governance state remains a bounded
reference store. This is a single-process private starter, not an unbounded or
distributed SIEM, and it does not populate every SOC page.

In Scans → Trivy, configure an application/environment-scoped Trivy JSON source,
test and activate it, then upload a supported report. Accepted reports populate
Trivy and Patch first views; API automation uses that source's ingest credential,
not a service-agent credential. In Agents → Service Access, issue a read-only
service identity, save its one-time value to an owner-only external file, and
connect MCP with `--base-url` and `--token-file`. Add exact write scopes only when
needed. See technical manual [section 52](../public/technical-reference.md#52-storage-limits-reliability-acceptance-and-remaining-parity-work)
for storage, [section 53](../public/technical-reference.md#53-private-service-identities-and-authenticated-mcp-setup)
for service access, and [section 54](../public/technical-reference.md#54-trivy-report-import-from-a-users-own-scanner)
for Trivy's supported inputs and limits.

All operators have full access to this deployment. There is no per-app user
authorization or read-only role. For private sharing, keep the listener on
`127.0.0.1`, configure Tailscale Serve (not Funnel), restrict ACLs/grants, and
pass your exact Tailnet HTTPS origin through `--origin`. Account recovery,
consistent backups, session behavior, and restrictions are in
[AUTHENTICATION.md](AUTHENTICATION.md#shipped-private-application).

The remaining integration sections describe embedding/custom backends. They
are not prerequisites for merely starting this included application.

## What you are adopting

The repository has five deliberately separate browser layers:

1. **Presentation:** the Bulwark Black SOC shell, 30 primary routes including Documents, nine
   adapter-addressable detail/utility routes, the separate local `#/docs`
   utility, responsive behavior, accessibility behavior, and exact default
   brand assets/colors.
2. **Page adapter boundary:** a strict JavaScript contract through which an
   adopter supplies already-authorized presentation models.
3. **Authentication integration boundary:** a closed browser contract for
   session projection and login/logout entry points. Authentication protocol,
   cookies, session state, and any OIDC tokens remain on the adopter-owned
   server/BFF.
4. **Connector-control boundary:** a closed manifest/snapshot/command contract
   used only by Onboarding and Sources. It registers apps and hosts and stages,
   tests, and activates manifest-owned sources. It is not a telemetry channel.
5. **Administration boundary:** domain-separated snapshots and a closed command
   contract for managed agents, prompt revisions/enrollment, attestations, and
   risks. It is not the page adapter, connector registry, secret store, or an
   authorization engine.

With no injected page or connector adapter, every known SOC route renders an
empty state and source-management actions remain disabled. In the optional-auth
static inspection shell, the local `#/docs` manual remains available; under every
auth configuration it calls no page, connector, or administration provider
method (`readPage`, `getSnapshot`, `getPrompt`, or `execute`).
The checked-in bridge and empty provider/template perform no I/O and supply no
records, counts, identities, timestamps, or operational values.

## Prerequisites

- Node.js 22.13 or newer for the private runtime and verification commands.
- An HTTP origin for deployment so response headers, routing, and assets are
  exercised accurately.
- The included single-tenant private BFF, or an adopter-owned BFF for a custom deployment. It authenticates the operator,
  holds the server session and any OIDC tokens, enforces authorization, obtains
  operational data, and reduces it to the documented browser contracts.
- A Tailscale tailnet or equivalently controlled private overlay for shared
  deployment. Do not create public ingress or public DNS for the UI, BFF,
  control planes, MCP, agent enrollment, scans, or ingest.

For one TypeScript/Node application, Better Auth is the recommended starting
point because it can own the same-origin application session and server auth
handlers inside that stack. Use Keycloak when a separately administered identity
service must support several products or technology stacks. The console contract
stays provider-neutral in either case.

Run `npm ci` for pinned Better Auth and SQLite runtime dependencies. No
client-application bundler is required. The documentation generation step is required
when its Markdown source changes: `npm run build:docs` refreshes the committed
browser artifact.

## Inspect the empty skeleton

```sh
npm run start:static
```

Open `http://127.0.0.1:8080`. This inspection server binds to loopback only.

Open `http://127.0.0.1:8080/#/docs`, or use the shell's **Docs** control, for the
agent-readable technical implementation manual. Its canonical source is
[technical-reference.md](../public/technical-reference.md); the in-app page
loads generated [technical-docs.js](../public/technical-docs.js). Edit only the
Markdown source, run `npm run build:docs`, and use `npm run check:docs` to catch
a stale generated artifact.

That server is for inspecting the data-free shell. It accepts only static
`GET`/`HEAD` requests, mounts no auth or page API, and intentionally sends
`connect-src 'none'`; it cannot demonstrate a Better Auth deployment. A real
integration must be served by the adopter application with an intentionally
reviewed connection policy.

The repository also includes a separate loopback-only connector/administration
workbench. It accepts disposable local state changes and canonical records;
`npm start` instead runs the authenticated private application. Use the separate
workbench command and state-directory instructions in
[CONNECTORS.md](CONNECTORS.md#loopback-reference-workbench). The workbench is a
contract and UI integration aid, not a deployment base.

For a private MCP-capable implementation agent, issue a scoped credential from
Agents → Service Access and run `npm run --silent start:agent-mcp -- --base-url http://127.0.0.1:8080 --token-file /absolute/private/agent-credential` using its
protected external file. The stdio process exposes checked-in documentation/contracts and exactly five fixed
connector/administration tools; it refuses credential issuance, arbitrary URLs,
shell/SQL/filesystem access, telemetry, and secret retrieval. See
[AGENTS.md](AGENTS.md#optional-mcp-facade). Private service routes enforce the
issued scopes server-side and never accept browser cookies. Without a token
file, MCP retains only its legacy loopback workbench mode (default port 8787);
it cannot authorize private application requests. Never extract browser cookies
for an agent or expose the unauthenticated workbench through a private proxy.

Establish a clean boundary before integrating:

```sh
npm run check
```

That checks the generated technical documentation, runs the Node test suite,
and performs the strict public-content audit. `npm run verify` is an alias.

## Integration shapes

### 1. Empty shell inspection

Serve `public/` unchanged to review navigation, the 38 registered SOC routes,
the local documentation utility, product styling, accessibility, and
empty/failure behavior. No SOC route will imply that a system is connected or
that data exists.

### 2. Embedded interface

Serve the static assets from an existing application, provide a mount element,
and inject validated page/auth objects. The host owns session resolution and
server communication; the console owns route selection and safe rendering.

#### DOM integration contract

For exact shell parity, retain the checked-in `public/index.html` structure and
IDs. That enables the product sidebar, grouped and compact navigation, auth
chip, page filter, timezone/refresh controls, connection state, toast, and
command palette.

For a smaller embed, `SocConsole.createApp` requires only the `root` element
passed to it. It null-checks all external shell hooks. A root-only embed renders
the current route's heading, tabs, catalog structures, page state, and provider
panels, but intentionally omits the surrounding shell controls. The embedding
host can call `navigate`, `refresh`, and the other controller methods itself.
Shell hooks are scoped to an explicitly supplied `shellRoot` or the nearest
`[data-soc-console]` ancestor; `createApp` never searches the whole host document
for generic classes such as `.brand`.

Default `bootstrap.js` specifically locates `#content`; a host using a different
root must omit bootstrap and call `createApp` directly. Default bootstrap passes
`#soc-console` as the shell root. A custom full-shell integration may pass its
own `shellRoot`; optional elements are then discovered only inside it by their
committed IDs, so do not rename or duplicate those IDs unless the application
integration is changed and retested as a unit.

### 3. Server-backed deployment

Place an authenticated application service between the browser, identity
provider, and operational systems:

```text
operator browser
      |
      | opaque server-session cookie + page requests
      v
adopter application / BFF
      |  - server-side authentication/session (OIDC when selected)
      |  - resource/action authorization
      |  - validation, rate limiting, audit trail
      |  - field reduction and redaction
      |  - connector registry, command audit, secret references
      v
approved identity, data, and workflow services
      ^
      | authenticated, bounded telemetry admission
push / webhook / pull worker / OTLP / syslog / host agent
```

Place the complete topology on the private tailnet. Bind development to
loopback and shared services to explicit private listeners/private reverse
proxies. Use tailnet ACLs/grants, tagged service identities, private TLS/mTLS,
device approval, expiry, and revocation. Tailnet reachability never replaces
application authentication, resource/action authorization, CSRF, validation,
audit, rate limits, or managed secrets. Verify that public ingress and public
DNS are absent.

Never connect this browser directly to identity-provider token endpoints,
collectors, infrastructure APIs, credential stores, evidence stores, queues, or
administrative endpoints.

## Recommended adoption sequence

Before implementing an integration, open `#/docs` or read
[technical-reference.md](../public/technical-reference.md). It is the detailed
entry point for engineers and agents covering contracts, registration,
ingestion, projection, authentication, optional MCP administration, failure
modes, and verification. It is local reference content, not a 37th provider
surface. Documents is a separate private file service, not a generic telemetry
page projector.

### 1. Preserve the empty baseline

Start from a revision that passes `npm run check`. Keep the checked-in routes
data-free. Build/test application data in the adopter repository through
validated page envelopes, not by committing records into this skeleton.

### 2. Inventory all 38 SOC routes

Review [FEATURES.md](FEATURES.md). Map the original 29 primary SOC routes and nine
adapter-addressable detail/utility routes to an intentional provider result.
Do not include the local `/docs` utility in that provider map. A SOC route can
remain `empty`, `unavailable`, or `forbidden` until its server boundary is
ready; separately account for the Documents service and its upload/download
authorization. Do not silently redirect a missing route to Overview or manufacture placeholder
values.

### 3. Implement the page provider

Implement the read lifecycle first:

```text
navigate -> build PageRequest -> provider.readPage(request)
         -> validate PageEnvelope -> render state/panels
```

Return presentation values, not raw vendor responses. Normalize identifiers,
times, states, severity, tables, and summaries on the server/adapter boundary.
Keep one provider instance scoped to the mounted application and implement
every query/detail selector as untrusted input.

Use `chart` panels for the two Analytics hourly stacks, `bars` for ranked lists,
typed internal `link` cells for safe GET pivots, and table `disclosures` for the
Expected Sources and health-drill row guidance. These are data-only structures;
the renderer chooses the exact product palette and constructs links itself.
Never pass chart SVG, HTML, URLs, callbacks, or prebuilt controls through the
provider.

Catalog structures remain data-free for the selected route/tab. A version-1
provider panel hydrates the catalog slot with the same stable panel `id`;
unmatched IDs appear under **Additional authorized data**. Matching never uses
titles, labels, or array positions. Compatible table/metric hydration keeps the
slot's route-specific wrappers and classes while replacing its empty values; it
never activates a form or command. Use a separately versioned command contract
for mutation instead of treating visual hydration as authorization.

Query-selected Detection Tuning, Rules detail, and Phishing report layouts have
additional stable, data-only slots. Implement those branches by keying on the
validated route plus query and using the IDs and preferred types in the
[specialized query-branch slot table](ADAPTER-CONTRACT.md#specialized-query-branch-slots).
Do not infer authorization from `id`, `ruleView`, `host`, `ts`, `finding`, or
`choose`; they remain untrusted selectors.

The global Search anything dialog sends non-empty Enter searches to
`#/search?q=…`. IP and CVE shapes have shell-owned destinations. Case and host
resolution must be supplied by an authorized `/search` envelope, normally with
the stable `search-dispatch` ID and internal `link` cells; do not expose an
unscoped host or case directory merely to make command search convenient.

See [ADAPTER-CONTRACT.md](ADAPTER-CONTRACT.md) for the exact interface, lifecycle,
section types, validation rules, limits, and failure mapping.

### 4. Implement the browser authentication object

The host can inject `SOC_CONSOLE_AUTH`, whose validated surface is limited to:

```js
window.SOC_CONSOLE_AUTH = {
  schemaVersion: "1",
  id: "application-auth",
  getSession, // resolves to a closed authenticated/unauthenticated projection
  login,      // receives only { returnTo: "#/internal-route" }
  logout      // receives only { returnTo: "#/internal-route" }
};
```

Only internal hash routes are accepted as return destinations. The browser
object must not expose raw claims, subject/session identifiers, cookies,
credentials, or access/refresh/ID tokens.

Implement server-side sessions, CSRF controls, logout, and resource
authorization in the application-owned BFF. When that BFF uses OIDC, implement
Authorization Code + PKCE, issuer/audience validation, and confidential client
authentication there. See [AUTHENTICATION.md](AUTHENTICATION.md).

For a same-origin TypeScript/Node application, use the executable
[Better Auth reference bridge](../examples/better-auth-reference/README.md). It
adapts `authClient.getSession()`, `authClient.signOut()`, and an adopter-supplied
login function. This optional embedding bridge is separate from the included
private service, which already supplies Better Auth, sign-in UI and SQLite
sessions. The
[Keycloak reference](../examples/keycloak-reference/README.md) remains the
better fit for centralized multi-product identity.

Set `config.auth.required` to `true` when a resolved authenticated projection
must gate page reads. Leaving it `false` only makes the data-free shell
browseable; it does not authorize adapter data or commands.

### 5. Configure the browser-safe surface

Set only public presentation values: contract version, `skeleton` or
`application` mode, brand, provider/auth global names, auth gating, and a known
default route. Credentials, private origins, connection strings, internal
topology, tokens, and authorization policy may not appear in browser config.

For a protected integration, define `SOC_CONSOLE_PUBLIC_CONFIG` with
`mode: "application"` and `auth.required: true` before `app-config.js` executes.
Bootstrap resolves the auth object once, so install it before bootstrap runs.

See [CONFIGURATION.md](CONFIGURATION.md) for exact keys and Content Security
Policy changes required by a networked host integration.

### 6. Implement source onboarding and ingestion

Use `SOC_CONSOLE_CONNECTORS` for source-management control only. Its version-1
provider exposes `getSnapshot(request)` and `execute(request)`. The UI currently
supports this closed sequence:

1. `app.register` creates an `appId`, declared environments, and optional `hostId` values.
2. For a host-backed integration only, `host.enroll` issues a connection-check
   credential displayed once; after a valid proof, the host is eligible for
   source testing. Application-scoped canonical push needs no host enrollment.
3. `source.setup` selects an installed `connectorType` and one of that
   manifest's `supportedSourceKinds`, then creates independent stable
   `connectorInstanceId` and `sourceId` values.
4. `source.test` verifies the configured path without creating telemetry;
   hostless canonical push requires a bounded message sample.
5. `source.activate` enables the source and may return a distinct one-time
   source-ingest credential.
6. Maintain sources with `source.update`, `source.pause`, `source.resume`,
   `source.archive`, `source.remove`, `source.revoke`, and `source.rotate`, using
   the current expectedRevision. Update invalidates prior testing/credentials;
   remove requires archive and keeps a tombstone and admitted records. Section
   51 of the technical manual lists exact allowed transitions.

Manifest configuration fields and credential slots drive the form. Only
credential references belong in setup documents; plaintext secret values do
not. Source kinds, search/log behavior, canonical outputs, target routes, and
health policy are installed manifest/server decisions. Do not restore a free
text “new kind” or user-controlled “Searchable in Logs” switch.

Normalize transport-specific input on the server into
`normalized-record.v1.schema.json`, submit bounded source-bound batches using
`ingest-batch.v1.schema.json`, and build read-side page envelopes with
idempotent projectors. Telemetry must not be sent through the connector command
provider or an MCP tool.

Run the document validators while implementing:

```sh
npm run validate:connector -- path/to/connector-document.json
npm run validate:ingest -- path/to/ingest-batch.json
npm run validate:administration -- path/to/administration-document.json
```

See [CONNECTORS.md](CONNECTORS.md) for exact version-1 shapes, the local
workbench, projection targets, and production replacement requirements.

For every Scans tab, follow the scan-specific recipes in
[CONNECTORS.md](CONNECTORS.md#scan-connector-implementation-guide). Private mode
adds a working `trivy-report` importer, separate from the eleven legacy setup
templates. It projects Trivy and Patch first from supported vulnerability reports;
it does not run Trivy, patch packages, or activate the legacy `trivy-template`.
File integrity, EOL, exposure, IOC, urlscan.io, dependencies, ClamAV, quarantine,
remediation, and independent Patch First acquisition still require integrations.
Provide a reviewed manifest, server driver, opaque credential-
reference flow, normalizer, health policy, durable records, and idempotent
projector for each one you enable.

### 7. Implement agent and governance administration

Install `SOC_CONSOLE_ADMINISTRATION` only after the authenticated server
service and durable audit/state model exist. Use domain-separated snapshots and
the closed commands documented in [AGENTS.md](AGENTS.md): agent create/update,
pause/resume, archive/restore/remove, prompt revise/activate/archive,
enrollment issue/revoke, and attestation/risk create/update/transition/archive/
restore/remove. Require idempotent request IDs and the exact current
administration snapshot revision;
re-read after every command.

Keep prompt text, assignments, one-time enrollment output, evidence, risk
history, and removal policy on the server. One-time values are displayed once
and only digests/references persist. Prefer archive; hard removal is dependency-
and retention-aware. The shipped MCP facade calls these same runtimes through
separately scoped service identities, with attributable service actors. It cannot
carry telemetry, plaintext keys, arbitrary execution, direct database writes,
credential issuance, agent privilege expansion, or prompt activation. Those
human-only operations remain in the protected operator flow.

### 8. Preserve or intentionally fork the product design

The committed default is the product design, not a generic approximation. It
includes the exact Bulwark Black SOC mark, favicon set, dark shell, circuit
treatment, blue accents, state palette, typography, density, responsive
behavior, and detail-route relationships. See
[DESIGN-SYSTEM.md](DESIGN-SYSTEM.md).

### 9. Add server security before commands

A visible structural action is not authorization. Before enabling a command:

- authenticate and, where appropriate, reauthenticate the operator;
- authorize the exact action/resource using current server policy;
- validate/normalize all submitted values and enforce size/range limits;
- protect cookie-authenticated requests against CSRF;
- require idempotency/concurrency controls where replay matters;
- record an append-only, attributable audit event;
- return safe results without internal error detail;
- add rate limits, timeouts, cancellation, and abuse controls;
- test denial, retry, partial failure, stale data, and privilege change.

The loopback workbench implements bounded local contract checks and an audit
log, but it does not implement production identity, authorization, CSRF,
multi-user concurrency, managed secret custody, or distributed durability.

### 10. Exercise every state

For every implemented primary/detail SOC route, test:

- missing adapter, unauthenticated, loading, ready, empty, error, unavailable,
  forbidden, and not-found outcomes;
- wide/narrow viewports, keyboard navigation, focus order, and route changes;
- long labels, missing optional values, large counts, and paginated data;
- invalid/unauthorized detail selectors and query values;
- slow requests, out-of-order responses, retries, and unmount/disposal;
- the five-minute injected-provider interval, manual refresh, server load/caching,
  and absence of an interval in the data-free path;
- expired/revoked sessions and changed authorization;
- untrusted upstream/operator text;
- login/logout return-route validation.
- connector-provider absence/failure, duplicate same-kind instances, stale
  revisions, setup/test/activation ordering, credential-reference rejection,
  one-time credential handling, ingest replay, and source-bound projection.
- administration-provider absence/failure, cross-domain/cross-scope denial,
  stale revision, command replay, prompt activation, enrollment issue/revoke,
  lifecycle transition, archive/restore, dependency-aware removal, and secret/
  evidence redaction.
- `#/docs` source integrity, chapter filtering, section focus, wide/narrow
  layout, and the invariant that it calls no page-read, connector-control, or
  administration provider.

### 11. Deploy privately with response headers

Use HTTPS and deliver security policy as HTTP response headers. Maintain a
restrictive Content Security Policy, deny framing, disable MIME sniffing, set a
conservative referrer policy, and define appropriate cross-origin isolation.
The local server represents an empty/no-network posture; a deployed policy must
name only the origins actually needed by the BFF design.

The production listener must also be private-only. Record listener/firewall/
tailnet policy evidence showing that allowed roles can connect, denied roles
cannot, and the service is unreachable through public DNS or public ingress.

## Production checklist

- [ ] A server-side authentication/BFF implementation satisfies the shared
      requirements in [AUTHENTICATION.md](AUTHENTICATION.md), plus its direct
      Better Auth or OIDC-specific checklist as applicable.
- [ ] Route-, resource-, field-, and command-level authorization covers all 38
      SOC paths. `/docs` remains a local shell utility and is not mapped to an
      operational provider request.
- [ ] The browser receives an opaque session cookie, closed session projection,
      and reduced page envelopes—never OIDC tokens or raw claims.
- [ ] Secrets are server-managed with rotation/revocation.
- [ ] UI, BFF, control planes, MCP, enrollment, scan callbacks, and ingest are
      reachable only through loopback or the approved tailnet/private overlay;
      public ingress and public DNS are absent.
- [ ] Connector manifests are installed and reviewed server-side; each source
      kind has a pinned payload schema, canonical output, health policy, and at
      least one page projector.
- [ ] Stable app, host, connector-instance, and source IDs—not labels or a
      `(host, kind)` pair—enforce identity and duplicate-instance support.
- [ ] UI, CLI, and optional MCP administration use the same authenticated,
      authorized, revision-checked command service; MCP cannot carry telemetry
      or plaintext credentials.
- [ ] Agent, prompt, enrollment, attestation, and risk lifecycles use the
      domain-separated administration service with revision checks, immutable
      history, archive/restore policy, dependency-aware removal, and redacted
      evidence/credential references.
- [ ] Every enabled push, webhook, pull, OTLP, syslog, or agent path has bounded
      admission, source binding, replay/idempotency behavior, and durable
      acknowledgment semantics.
- [ ] Input/output schemas, size limits, pagination, and untrusted-text handling
      are enforced.
- [ ] Timeouts, bounded retries, cancellation, backpressure, and rate limits are
      defined.
- [ ] Data classification, minimization, redaction, retention, and deletion are
      approved.
- [ ] Sensitive reads and every attempted command have durable attributable
      audit records.
- [ ] Safe browser errors and separately protected diagnostics are implemented.
- [ ] All 38 SOC routes have intentional absence, denial, failure, and
      ready-state behavior; the separate `/docs` utility has verified local
      source, integrity-failure, filtering, and navigation behavior.
- [ ] Accessibility testing covers keyboard, screen reader, contrast, reduced
      motion, zoom, and responsive layouts.
- [ ] Effective CSP/security headers are verified on login, callback, logout,
      error, asset, and application responses.
- [ ] Threat model, abuse/privacy review, dependency review, penetration
      testing, and incident-response ownership are complete.
- [ ] Backup/restoration/disaster recovery covers adopter-owned session, policy,
      audit, and operational state.
- [ ] UI, page-envelope, auth-integration, connector-control, canonical-ingest,
      and server contract versions have a tested deployment/rollback order.

Passing this repository's tests or public audit does not satisfy the checklist.

## Deliberate non-goals

This work does not add or prescribe CI pipelines, GitHub workflows, branch
protections, issue templates, release automation, package publishing, or
repository marketplace readiness. Those concerns remain intentionally out of
scope and belong to the adopting organization's delivery/governance model.
