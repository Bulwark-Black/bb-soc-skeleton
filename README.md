# Bulwark Black SOC interface skeleton Beta

## Still a work in progress, I am trying to take what I built privately and make it so that anyone can ingest sources as efficiently and monitor things as I do.

A data-free, self-hosted private application starter for the Bulwark Black SOC
interface. It preserves the committed product mark and visual system, includes
the 38 SOC paths, a Documents library, and Technical Docs, and gives adopters
versioned integration contracts for monitoring their own web applications.

> `npm start` runs the private application with real Better Auth sign-in and
> persistent operator-created data. No accounts, demo records, telemetry, or
> documents are seeded. This is a bounded single-tenant starter, not a complete
> detection platform or a claim of production readiness. Keep it private.

## What is included

- The exact Bulwark Black SOC mark, favicon set, dark circuit shell, palette,
  typography, component density, and responsive behavior.
- A 38-route SOC registry: 29 primary surfaces (27 grouped navigation pages
  plus Onboarding and Settings) and nine linked detail paths, plus a separate
  shell-owned `/docs` implementation manual that is never adapter-hydrated.
- An additional `/documents` library for file upload, immutable versions,
  hashes, metadata, review status, history, downloads, and archive/restore.
- A synchronized in-app and raw Markdown technical reference for
  operators, connector authors, platform engineers, and automation agents.
- Honest loading, empty, unavailable, forbidden, error, and not-found states.
- A version-1 request/page-envelope contract with strict data-only validation.
- A mountable application factory plus default browser bootstrap.
- A browser-side authentication integration contract that exposes only a closed
  session projection and login/logout entry points.
- A runnable Better Auth + SQLite private session backend, closed public
  registration, locally provisioned operators, and password/session recovery CLI.
- A connector manifest, source registry, health snapshot, and closed lifecycle
  command contract for the Onboarding and Sources screens.
- A separate domain-scoped administration contract for managed agents, prompt
  revisions/enrollment, attestations, and risks, plus local reference modules;
  production authorization, prompt/evidence custody, and durability remain
  adopter responsibilities.
- A narrow stdio agent MCP reference that exposes checked-in documentation/
  contracts plus five fixed connector/administration tools. It rejects
  credential issuance, arbitrary URLs, shell/SQL/filesystem access, telemetry,
  and secret retrieval.
- Private service access with expiring, scoped credentials, human-only issuance,
  rotation/revocation, audit history, and a token-file-backed MCP client.
- Indexed SQLite telemetry admission and bounded page reads in the private app,
  with explicit record retention and replay limits rather than whole-history
  JSON rewrites.
- An application-scoped Trivy JSON report importer and populated Trivy scan
  summaries. It accepts reports from your scanner; it does not execute scans.
- A bounded canonical-record and idempotent ingest-batch contract, plus a
  loopback-only reference workbench for exercising one honest push-to-screen
  path without external integrations.
- An empty provider template, portable page-model JSON Schema, and local
  validators for page, connector, and ingest documents.
- Separate static inspection and disposable integration-test modes,
  route/contract/boundary tests, and a strict
  public-content audit.

## Data-free public boundary

The checked-in static baseline contains structural labels and explanatory copy,
but no operational records or page data. Specifically, it contains:

- no findings, events, counts, timestamps, identities, systems, addresses,
  policies, evidence, configuration values, or operational verdicts;
- no credentials, customer records, real host inventory, private policy,
  detection logic, or deployment configuration;
- no committed runtime databases, document bytes, operational secrets, or
  deployment-specific values; private application state lives outside the checkout;
- no external queue, scheduler, collector, webhook, notification
  client, vendor client, or infrastructure client;
- no OIDC token processing or browser token storage.

Static inspection has no providers or writes. The private application installs
authenticated providers and stores only operator-supplied information in the
external state directory. A visible screen does not imply that its external
connector or projector is implemented; see the capability matrix below.

## Run locally

Requirements: Node.js 22.13 or newer and npm. Install the pinned dependencies:

```sh
npm ci
```

Choose a persistent, owner-only directory **outside this checkout**, using its
absolute canonical path. For example, replace `/absolute/private/bb-soc-state`
with a location owned by your account. The application creates it with mode
0700 and stores authentication/database files with mode 0600. Symbolic-link
ancestors are rejected: on macOS, resolve `/tmp` or `/var` aliases before use.
Do not use a temporary directory for a deployment you intend to keep.

```sh
npm run account -- create --state-dir /absolute/private/bb-soc-state --email operator@example.invalid --name "SOC operator"
npm start -- --state-dir /absolute/private/bb-soc-state
```

Replace the example email/name locally. Password entry is hidden and confirmed;
there is no default account and no public signup. Open `http://127.0.0.1:8080`,
sign in, and use Onboarding, Sources, Documents, and Docs. All provisioned
operators have full access to this one deployment; there are no read-only roles,
tenant isolation, MFA, or email reset service in this starter. Stop with Ctrl-C.
Restart with the **same** directory to retain accounts, sessions, registry,
documents, histories, and ingest receipts.

For recovery, use `reset-password` or `revoke-sessions` with the same `--state-dir`
and `--email`. The account CLI accepts an explicit `--password-stdin` for a
password-manager pipe, never a password argument or password environment value.
See [authentication and recovery](docs/AUTHENTICATION.md#shipped-private-application).

To inspect only the empty interface, use `npm run start:static`. It binds to
loopback, mounts no API, accepts no writes, and uses `connect-src 'none'`.

Verify the complete checked-in boundary:

```sh
npm run check
```

`npm run check` verifies the generated in-app manual, runs the Node tests, and
then runs the strict public audit.
`npm run verify` is an alias.

The optional connector/administration workbench has a separate start command and explicit
state directory because it accepts local writes. See
[the connector guide](docs/CONNECTORS.md#loopback-reference-workbench) before
running it. It must remain bound to loopback and must not receive production
credentials or telemetry.

```sh
soc_reference_state="$(node -e 'const fs=require("node:fs"),os=require("node:os"),path=require("node:path"); process.stdout.write(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),"bb-soc-workbench-")))')"
npm run start:connectors -- --state-dir "$soc_reference_state"
```

Open the printed loopback address, use Ctrl-C to stop the server, and remove the
disposable state directory yourself when finished.

With that loopback workbench running, an MCP-capable local agent can start the
separate reference process:

```sh
npm run --silent start:agent-mcp
```

Without a token file it connects to the disposable workbench at
`http://127.0.0.1:8787`. To use your private application, sign in and open
**Agents → Service Access**, issue a least-privilege credential, and place its
one-time value in an owner-only external file using your approved secret tool.
Then configure the MCP process with `--base-url` and `--token-file`:

```sh
npm run --silent start:agent-mcp -- --base-url http://127.0.0.1:8080 --token-file /absolute/private/mcp-service-token
```

The file is a secret, not a report attachment or source-controlled setting.
Never copy browser cookies into the client or expose the workbench. Private
service requests use separate authenticated, server-scoped endpoints; a source
ingest key is not a service access credential. Remote origins must be approved
private HTTPS destinations. This client is not an agent runner or telemetry
channel. See
[the agent guide](docs/AGENTS.md#optional-mcp-facade) for exact resources,
tools, and refusal rules.

### Recommended deployed network posture

Keep an adopted SOC private. The recommended shared deployment is reachable
only over a Tailscale tailnet (or an equivalently controlled private overlay),
with no public Internet ingress. The private starter always binds to
`127.0.0.1`; put Tailscale **Serve**, never **Funnel**, in front of it for shared
private HTTPS access. Start it with `--origin` set to your exact HTTPS machine
origin ending in `.ts.net`. Apply tailnet ACLs/grants and tagged service
identities so operator browsers, agents, scanners, and administrators can reach
only their required private endpoints. Use private TLS/mTLS and rotate service
identities.

A tailnet reduces reachability; it does not replace application authentication,
resource/action authorization, CSRF protection, request validation, audit,
rate limits, tenant binding, or managed secrets. Never make the checked-in
static server or loopback reference workbench remotely reachable. See
[Agent integration and administration](docs/AGENTS.md#network-posture-tailnet-first-and-private-only)
and the deployment chapter in the technical manual before standing up an
application deployment. MagicDNS/certificate naming is not permission to create
public ingress; independently verify that devices outside your tailnet cannot
connect.

## What works now and what still needs an integration

| Capability | Shipped behavior |
| --- | --- |
| Private sign-in | Better Auth + SQLite; local operator provisioning; fixed eight-hour sessions; sign-out and local password/session recovery |
| Application/source setup | App/environment registration, optional hosts, manifest-driven setup, tests, activation, and source lifecycle controls |
| Canonical log push | Authenticated indexed SQLite admission with transactional receipts; bounded projections to Overview, Sources, Logs, Analytics, and Health |
| Documents | Upload/download, immutable file versions, hashes, metadata/status/review dates, audit history, archive/restore |
| Agents/governance | Agent/prompt/enrollment and attestation/risk record management; no agent execution or observed-job scheduler |
| Trivy | Actual JSON report normalization/import, source-scoped admission and scan summaries; no scanner execution |
| Other scan integrations | Eleven legacy connection templates remain data-only; their test/activation still fails closed |
| Other SOC screens | Product UI/contracts remain available; require their own records and projectors |
| MCP | Five narrow tools with scoped private service authentication, expiry, rotation/revocation and audit; no credential issuance or telemetry transport |

The private app uses an indexed telemetry database; the disposable reference
workbench retains its 10,000-record JSON store. Administration remains bounded
and single-writer. Telemetry retention and replay guarantees have explicit
limits described in the technical manual; this is not an unlimited SIEM.
Documents are capped
at 10 MiB per file, 512 MiB total bytes, 1,000 documents, and 10,000 versions.
Do not hide a capacity failure by deleting evidence or resetting state.

Next parity work includes more connector drivers and incremental projectors,
durable worker retries/dead letters, web availability/TLS observations, legal
acknowledgement receipts, observed agent jobs, richer attestation checklists,
and risk-document import/export. Those are not implied by this starter.

## Adopt it into another stack

1. Start with [the adoption guide](docs/ADOPTION.md) and decide whether the shell
   will be embedded or served by an application-owned BFF.
2. Read the [in-app and agent-readable technical manual](public/technical-reference.md),
   then review the [38-route catalog](docs/FEATURES.md) and map every route to an
   intentional ready, empty, unavailable, or forbidden provider result.
3. Implement `readPage` using [the adapter contract](docs/ADAPTER-CONTRACT.md).
   Begin with `examples/provider-template.js`, whose checked-in behavior remains
   empty and I/O-free.
4. Implement the validated connector provider described in
   [the connector guide](docs/CONNECTORS.md) when operators must register apps,
   enroll hosts, configure/test/activate sources, or ingest canonical records.
   The provider controls only those source-management screens; projected records
   still reach all read surfaces through page envelopes.
5. When the deployment needs managed agents, prompt revisions, attestations, or
   risk-record mutations, implement the separate authenticated administration
   service described in [the agent guide](docs/AGENTS.md). Its browser provider,
   `SOC_CONSOLE_ADMINISTRATION`, is not a substitute for authorization or a
   secret store; use only the closed commands supported by the installed
   administration contract.
6. Reuse the shipped private authentication service, or implement the validated browser auth object described in
   [the authentication boundary](docs/AUTHENTICATION.md). Authentication
   protocol, tokens, session storage, cookies, and resource authorization belong
   to the application server/BFF; OIDC deployments use Authorization Code +
   PKCE there. For one TypeScript/Node application, start with the dependency-free
   [Better Auth bridge](examples/better-auth-reference/README.md); use the
   Keycloak reference when identity is centralized across multiple products.
   That optional embedding bridge adapts an adopter-installed client; it does not install or
   configure the Better Auth server, database/session layer, login methods, or
   authorization policy.
7. Supply only browser-safe values described in
   [configuration](docs/CONFIGURATION.md). Secrets and authorization policy stay
   on the server.
8. Preserve [the exact product design system](docs/DESIGN-SYSTEM.md) when product
   parity is required.
9. Complete the production checklist, including identity, authorization,
   validation, audit, retention, availability, accessibility, threat modeling,
   and independent security review.

Validate one or more JSON page envelopes with:

```sh
npm run validate:provider -- path/to/page-envelope.json
```

Validate connector/control or canonical-ingest documents with:

```sh
npm run validate:connector -- path/to/connector-document.json
npm run validate:ingest -- path/to/ingest-batch.json
npm run validate:administration -- path/to/administration-document.json
```

The interface discovers an injected page provider from
`window.SOC_CONSOLE_ADAPTER` and an injected browser authentication integration
from `window.SOC_CONSOLE_AUTH` by default. Source-management controls discover a
separate `window.SOC_CONSOLE_CONNECTORS` provider. Agent/governance controls
discover `window.SOC_CONSOLE_ADMINISTRATION`. Without those providers, all
38 SOC routes remain deliberately empty and source/administration actions remain
disabled. `/docs` remains a trusted local reference and never calls the page,
connector, or administration provider.

## Route map

| Area | Primary routes |
| --- | --- |
| Monitor | Overview, SOC Health, Daily Brief, Analytics, Timeline |
| Respond | Triage, Detection Tuning, Rules, Alert Comms, Honeypots, Phishing |
| Investigate | Logs, Activity Learner, IOC Parser, Threat Intel, Known IPs |
| Vuln Mgmt | Scans, Remediation |
| Estate | Systems, Databases, Backups, Retention, Sources, Agent Management |
| Govern | Attestations, Risk Register, Documents, Access |
| Shell utilities (primary, not sidebar destinations) | Onboarding, Settings |
| Local implementation reference | Technical Docs (`/docs`) |

There are 40 registered paths: the original 38 SOC paths, `/documents`, and
`/docs`. Documents raises the primary count to 30; `/docs` remains local guidance.
The nine linked detail/utility paths are `/analyst`, `/event`, `/ip`, `/search`,
`/host-scan`, `/kev`, `/source`, `/attestation`, and `/risk`. They are adapter-addressable
without being duplicated as primary navigation items. The 30-primary count
includes Onboarding and Settings; those two top-level surfaces are opened from
shell controls rather than repeated in the six grouped sidebar sections. The
Technical Docs utility is additional to those counts and is excluded from the
page-provider contract.

See [docs/FEATURES.md](docs/FEATURES.md) for exact paths, parent relationships,
and adopter responsibilities.

## Project structure

```text
public/                         empty static UI, assets, browser contracts, technical manual
contracts/                      page, connector, source, record, and ingest schemas
examples/provider-template.js  deterministic empty provider example
examples/better-auth-reference/ dependency-free bridge for one Better Auth app
examples/keycloak-reference/   placeholder-only server auth review templates
server/                         private application/auth/documents and reference integration core
test/                           route, behavior, contract, and safety tests
tools/                          local servers, validators, and public audit
docs/                           adopter, auth, design, and architecture guidance
```

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before changing the runtime or
trust boundary.

## Production boundary

A larger or multi-tenant deployment needs an adopter-owned BFF between the browser, identity
provider, and operational services. That server must authenticate the operator,
hold session state and any OIDC tokens, authorize each resource/action, validate
and bound requests, reduce/redact output to the versioned presentation model,
manage secrets, and produce durable audit records.

The included private application is a single-tenant BFF with real authentication;
it does not implement resource-specific operator roles. The browser contracts
validate and narrow object shape, but they are not a
semantic secret scanner and cannot decide whether an operator may see a valid
page/control model. The loopback reference store is not a transactional
multi-user database or managed secret store. The interface is not
production-ready, and passing this repository's tests/audit does not make a
downstream integration production-ready.

CI pipelines, GitHub workflows, branch protections, release automation, and
other repository-readiness work are intentionally outside the current scope.

## Documentation

- [In-app and agent-readable technical implementation manual](public/technical-reference.md)
- [Adoption guide](docs/ADOPTION.md)
- [Adapter contract v1](docs/ADAPTER-CONTRACT.md)
- [Authentication integration boundary](docs/AUTHENTICATION.md)
- [Connector, source, and ingest integration](docs/CONNECTORS.md)
- [Agent integration and administration](docs/AGENTS.md)
- [Configuration](docs/CONFIGURATION.md)
- [Feature and route catalog](docs/FEATURES.md)
- [Product design system](docs/DESIGN-SYSTEM.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Contributing](CONTRIBUTING.md)

## License

MIT. See [LICENSE](LICENSE). The software license should not be interpreted as a
grant of rights to Bulwark Black trademarks or product identity.
