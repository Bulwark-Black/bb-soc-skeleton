# Bulwark Black SOC interface skeleton

A dependency-free, data-free browser skeleton for the Bulwark Black SOC
interface. It preserves the exact committed product mark and visual system,
registers all 38 active SOC paths plus a shell-owned Technical Docs utility, supplies responsive/accessibility behavior,
and defines versioned page, browser-authentication, connector-control, and
canonical-ingest contracts for an adopter-owned stack.

> The default static mode is an empty presentation layer and does not collect
> telemetry. The opt-in loopback workbench accepts only local canonical test
> records; neither mode detects threats, delivers alerts, administers
> infrastructure, or provides a production security control.

## What is included

- The exact Bulwark Black SOC mark, favicon set, dark circuit shell, palette,
  typography, component density, and responsive behavior.
- A 38-route SOC registry: 29 primary surfaces (27 grouped navigation pages
  plus Onboarding and Settings) and nine linked detail paths, plus a separate
  shell-owned `/docs` implementation manual that is never adapter-hydrated.
- A synchronized 47-chapter in-app and raw Markdown technical reference for
  operators, connector authors, platform engineers, and automation agents.
- Honest loading, empty, unavailable, forbidden, error, and not-found states.
- A version-1 request/page-envelope contract with strict data-only validation.
- A mountable application factory plus default browser bootstrap.
- A browser-side authentication integration contract that exposes only a closed
  session projection and login/logout entry points.
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
- A bounded canonical-record and idempotent ingest-batch contract, plus a
  loopback-only reference workbench for exercising one honest push-to-screen
  path without external integrations.
- An empty provider template, portable page-model JSON Schema, and local
  validators for page, connector, and ingest documents.
- Dependency-free local serving, route/contract/boundary tests, and a strict
  public-content audit.

## Data-free public boundary

The checked-in static baseline contains structural labels and explanatory copy,
but no operational records or page data. Specifically, it contains:

- no findings, events, counts, timestamps, identities, systems, addresses,
  policies, evidence, configuration values, or operational verdicts;
- no credentials, customer records, real host inventory, private policy,
  detection logic, or deployment configuration;
- no active browser network client, persistent writes, uploads, subscriptions,
  command provider, telemetry collection, or environment discovery;
- no external database, queue, scheduler, collector, webhook, notification
  client, vendor client, or infrastructure client;
- no OIDC token processing, browser token storage, or server session
  implementation.

Without injected page/connector providers, known routes render an explicit empty
skeleton. Visible controls expose product structure only and do not submit or
mutate. The opt-in reference workbench stores only data entered during that
local run; no operational values are committed to the repository.

## Run locally

Requirements: Node.js 20 or newer. There is no dependency-install or build step.

```sh
npm start
```

Open `http://127.0.0.1:8080`. The dependency-free server binds to loopback only
and sends the empty-skeleton security headers. `npm run dev` starts the same
server. This starts the data-free interface only: the server mounts no auth/API
handler, accepts no state-changing requests, and its `connect-src 'none'` policy
intentionally blocks live browser integrations.

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
soc_reference_state="$(mktemp -d)"
npm run start:connectors -- --state-dir "$soc_reference_state"
```

Open the printed loopback address, use Ctrl-C to stop the server, and remove the
disposable state directory yourself when finished.

With that loopback workbench running, an MCP-capable local agent can start the
separate reference process:

```sh
npm run start:agent-mcp
```

It connects to `http://127.0.0.1:8787` by default. Use
`SOC_AGENT_MCP_BASE_URL` or `--base-url` only for an explicitly approved private
HTTPS IP or the validated private-overlay DNS suffix. It is a narrow client of
the same API/RBAC boundary, not a
server deployment or credential/telemetry channel. See
[the agent guide](docs/AGENTS.md#optional-mcp-facade) for exact resources,
tools, and refusal rules.

### Recommended deployed network posture

Keep an adopted SOC private. The recommended shared deployment is reachable
only over a Tailscale tailnet (or an equivalently controlled private overlay),
with no public Internet ingress and no public DNS record. Local services bind to
loopback; shared services bind to an explicitly selected private interface or
sit behind a private reverse proxy. Apply tailnet ACLs/grants and tagged service
identities so operator browsers, agents, scanners, and administrators can reach
only their required private endpoints. Use private TLS/mTLS and rotate service
identities.

A tailnet reduces reachability; it does not replace application authentication,
resource/action authorization, CSRF protection, request validation, audit,
rate limits, tenant binding, or managed secrets. Never make the checked-in
static server or loopback reference workbench remotely reachable. See
[Agent integration and administration](docs/AGENTS.md#network-posture-tailnet-first-and-private-only)
and the deployment chapter in the technical manual before standing up an
application deployment.

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
6. Implement the validated browser auth object described in
   [the authentication boundary](docs/AUTHENTICATION.md). Authentication
   protocol, tokens, session storage, cookies, and resource authorization belong
   to the application server/BFF; OIDC deployments use Authorization Code +
   PKCE there. For one TypeScript/Node application, start with the dependency-free
   [Better Auth bridge](examples/better-auth-reference/README.md); use the
   Keycloak reference when identity is centralized across multiple products.
   The bridge adapts an adopter-installed client; it does not install or
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
| Govern | Attestations, Risk Register, Access |
| Shell utilities (primary, not sidebar destinations) | Onboarding, Settings |
| Local implementation reference | Technical Docs (`/docs`) |

The nine linked detail/utility paths are `/analyst`, `/event`, `/ip`, `/search`,
`/host-scan`, `/kev`, `/source`, `/attestation`, and `/risk`. They are adapter-addressable
without being duplicated as primary navigation items. The 29-primary count
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
server/                         loopback-only disposable connector workbench core
test/                           route, behavior, contract, and safety tests
tools/                          local servers, validators, and public audit
docs/                           adopter, auth, design, and architecture guidance
```

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before changing the runtime or
trust boundary.

## Production boundary

A real deployment needs an adopter-owned BFF between the browser, identity
provider, and operational services. That server must authenticate the operator,
hold session state and any OIDC tokens, authorize each resource/action, validate
and bound requests, reduce/redact output to the versioned presentation model,
manage secrets, and produce durable audit records.

The browser contracts validate and narrow object shape, but they are not a
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
