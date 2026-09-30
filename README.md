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

**Integration is the main adoption path.** You are not limited to a fixed vendor
list: send normalized records from your own application, collector or worker,
or register a custom data-only integration definition in **Sources →
Integrations** without editing the core. Vendor payloads still need an adapter;
installing a definition does not install a collector, scanner or workflow.
Start with the [complete integration review and implementation map](docs/INTEGRATION-REVIEW.md).

The first [vendor integration pack](docs/VENDOR-INTEGRATIONS.md) now supports
AWS CloudTrail, Microsoft Entra, Google Cloud Audit Logs, Cloudflare, GitHub,
GitLab, Okta, Auth0, Sentry and Datadog. **Sources → Vendor imports** installs
presets and previews/imports your exported events or API pages. The `vendor`
CLI adds a private persistent delivery queue. These are tested data mappings,
not automatically connected vendor accounts or background polling services.

For the first complete automatic path, use **Sources → Live monitoring**:
connect a Sentry Cloud project with a read-only token, automatically collect its
error events, inspect collection health and actionable evidence, and optionally
send alerts to Slack. This is one built-in collector, separate from the ten
import mappings. Follow the [detailed live monitoring guide](docs/LIVE-MONITORING.md)
and complete its real-account commissioning checklist before relying on it.

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
- Compact contextual help, a dismissible beginner checklist, and resumable
  application/source setup with read-only checks of actual delivery evidence.
- A version-1 request/page-envelope contract with strict data-only validation.
- A mountable application factory plus default browser bootstrap.
- A browser-side authentication integration contract that exposes only a closed
  session projection and login/logout entry points.
- A runnable Better Auth + SQLite private session backend, one-time local
  administrator setup, closed public registration, optional authenticator 2FA
  with single-use backup codes, and a password/session recovery CLI.
- A connector manifest, source registry, health snapshot, and closed lifecycle
  command contract for the Onboarding and Sources screens.
- A separate domain-scoped administration contract for managed agents, prompt
  revisions/enrollment, attestations, and risks, plus local reference modules;
  production authorization, prompt/evidence custody, and durability remain
  adopter responsibilities.
- A narrow stdio agent MCP reference that exposes checked-in documentation/
  contracts plus seven fixed connector/administration/setup tools. It rejects
  credential issuance, arbitrary URLs, shell/SQL/filesystem access, telemetry,
  and secret retrieval.
- Private service access with expiring, scoped credentials, human-only issuance,
  rotation/revocation, audit history, and a token-file-backed MCP client.
- Client-specific AI connection guidance, secret-free configuration generation,
  and a reusable `setup_application` MCP prompt backed by the detailed
  [AI setup runbook](docs/AI-SETUP.md). Agent preparation does not bypass human
  credential or activation checkpoints.
- Indexed SQLite telemetry admission and bounded page reads in the private app,
  with explicit record retention and replay limits rather than whole-history
  JSON rewrites.
- An application-scoped Trivy JSON report importer and populated Trivy scan
  summaries. It accepts reports from your scanner; it does not execute scans.
- Universal canonical ingestion for all 29 supported record kinds, human-managed
  custom integration definitions, and a source-to-screen coverage catalog.
- A private **Received observations** browser with application/source/kind
  filters, payload inspection, bounded pagination and retained source history.
- Read-only imported-observation views across the relevant SOC categories,
  separated from native scanner results and locally authorized workflows.
- A dependency-free Node sender and CLI with source-token files, validated
  receipts, stable retry bodies, bounded backoff and private-origin enforcement.
- Ten vendor normalizers with reviewed field selection, source-bound previews,
  sample validation, authenticated atomic imports, stable event IDs and receipts.
- An external SQLite outbox with persistent canonical bodies, delivery leases,
  restart/replay, backoff, blocked-delivery inspection and explicit retry.
- A guided Sentry Cloud live collector with server-side encrypted credentials,
  durable pagination/checkpoints, honest empty-poll health, deduplicated
  application-error evidence and optional durable Slack notification delivery.
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
- no preconfigured third-party queue, scheduler, collector, public webhook, notification
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
npm start -- --state-dir /absolute/private/bb-soc-state
```

Open `http://127.0.0.1:8080` and choose Sign in. On a new installation, the page
shows **Create your administrator account**: enter your name, email, and a
15–128 character password twice. Creation permanently closes this one-time
setup; then sign in with the account you created. There are no default
credentials and no public signup. Setup is direct-localhost only, not available
through a Tailnet origin or forwarded request. Complete it before enabling your
private proxy, or provision the first account through the local CLI:

```sh
npm run account -- create --state-dir /absolute/private/bb-soc-state --email operator@example.invalid --name "SOC operator"
```

Replace the example email/name locally; the CLI prompts privately for a password
and confirmation. It also closes browser setup. Use the CLI for additional
accounts, not the one-time form. Then use Onboarding, Sources, Documents, and Docs. All provisioned
operators have full access to this one deployment; there are no read-only roles,
tenant isolation or email reset service in this starter. Optional authenticator
2FA is available at **Account security** (`/sign-in?mode=security`); enroll each
account deliberately and save its one-time recovery codes. Stop with Ctrl-C.
Restart with the **same** directory to retain accounts, sessions, registry,
documents, histories, and ingest receipts. After an unclean shutdown, a remaining
state lock intentionally blocks restart; follow the verified stale-lock recovery
steps in [the live-monitoring guide](docs/LIVE-MONITORING.md#12-secret-storage-retained-data-and-backups)
before resuming. Automatic stale-lock recovery is not implemented.

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

## Guided application setup and diagnostics

Start in **Sources → Guided setup** to **Monitor my application**. Register or
select an app/environment, choose Sentry live collection, vendor import, custom
canonical push, or Trivy report import, and save a resumable guide. Follow the
scoped setup links, then select the actual source you created.

**Check my setup** reads committed local evidence for source activation,
accepted records, collection freshness, screen population, and optional Slack
delivery. It never sends a notification, polls a vendor, runs a scan, or inserts
sample events. It distinguishes a healthy quiet poll from missing telemetry,
historical imports from ongoing collection, and provider acknowledgment from
human receipt. Saved choices survive a clean restart; readiness is checked
afresh. Read the [guided setup and diagnostics guide](docs/GUIDED-SETUP.md).

The other guided paths are available in the same private app:

- **Sources → Map a custom source:** inspect redacted JSON/NDJSON, explicitly map
  fields, preview a canonical batch, and export a reusable offline recipe. It
  supports the selected source's declared kinds without running code or ingesting
  the sample; use the existing sender for actual delivery.
- **+ beside an empty page title:** expand its explanation and inspect
  compatible producers and retained-record evidence without a vendor request.
- **Setup checklist:** a dismissible beginner guide on empty private views,
  reopenable from the page header. Personal checkmarks are not readiness evidence.
- **Agents → Service Access:** choose least-privilege access, generate secret-free
  client configuration, and inspect actual authorization evidence. Optional
  `setup:read` enables `setup_guides` and `setup_check`, not guide writes or secrets.
- **Documents:** searchable app/risk/attestation choices, ownership/review guidance,
  and an immutable version/hash receipt. Governance records remain deployment-wide.
- **Sources → Private deployment:** read local deployment facts and follow the
  private-access, supervision, backup, and recovery checklist. Network isolation
  and successful restoration still require independent operator verification.

### Set up with your AI agent

In **Agents → Service Access**, choose Claude, Codex, Hermes, OpenClaw or the
relevant client guidance. Generate its configuration and a scope-aware setup
prompt using only your private origin and absolute file paths—never paste a
credential into the chat. Start read-only; explicitly approve the narrow
registration/configuration/test scopes if you want the agent to prepare a source.
Activation and one-time credentials remain human checkpoints.

The supplied connector is local **stdio MCP**, not a public remote MCP URL.
Hosted assistants need a supported private/local connection path; selecting a
model such as Grok does not make it a compatible MCP client. Keep the SOC on
your tailnet, never expose it to make a client work, and review what tool results
the client sends to its model provider. Use the MCP prompt `setup_application`
or read [the detailed AI setup runbook](docs/AI-SETUP.md), also available as
`soc://documentation/ai-setup`. Generated configurations are not a claim of
live interoperability testing with each vendor's product.

## First automatic monitoring connection

1. Instrument your own application with Sentry and verify its project receives
   errors. This SOC does not install that SDK or create your vendor account.
2. Register the application and environment in SOC Onboarding, then open
   **Sources → Live monitoring**. No collector host or manual preset setup is needed.
3. Choose your application, region and Sentry organization/project slugs. Enter
   an authorized token with **`project:read`** in the private password field.
   Optionally add an approved Slack incoming webhook in its password field.
4. Select **Test access and start monitoring**. The server validates a real
   vendor page, provisions a managed source and begins a 15-minute lookback.
5. Verify **Last successful completed poll** and **Completed through** advance.
   A complete empty window is healthy collection; an old last-event timestamp
   alone does not mean collection failed. Normally it polls every 60 seconds
   with a 30-second settling delay; this is not a latency guarantee.
6. Check **Received observations**, review an alert's Sentry evidence, and, if
   configured, explicitly **Send Slack test** and verify its delivery state/channel.

The SOC environment is a local label, **not a Sentry environment filter**. Use
a dedicated Sentry project per environment when isolation is required. Alerts
describe application error events, not verified security findings. The built-in
reader is Sentry Cloud only; other services still use the universal/import paths.

Keep the SOC on loopback/private tailnet; no public inbound webhook is needed.
Credentials are encrypted in the private state directory, with the encryption
key stored beside the database: protect and back up the entire directory as
sensitive data. Collection runs while the private server runs, independently
of the browser. An external process supervisor/watchdog remains your responsibility;
a stopped SOC cannot send its own outage alert. Review
[limits, backup/restore, failures and commissioning](docs/LIVE-MONITORING.md).

## Connect your own application or source

1. Register your application and environment in Onboarding. A host is optional.
2. In **Sources → Add a source**, choose **Canonical log push** for logs,
   **Universal canonical events** for the broader canonical contract, or an
   installed custom integration type. Give each independently operated feed
   its own source so credentials, health, pause and revocation remain separate.
3. For a reusable, narrower vendor/application contract, open **Sources →
   Integrations** and register its type, source category and allowed record
   kinds, or import a validated manifest JSON document. No executable plugin or
   vendor secret is accepted. Then configure a source using that type.
4. Validate a real, redacted sample. Universal/custom sources use a complete
   normalized record bound to the displayed `sourceId` and application
   `estateId`. Validation does not store the sample or prove live collection.
5. Activate the source and save its one-time ingest credential in your sender's
   approved secret store or owner-only file **outside the checkout and the
   application's managed state directory**. Never use a browser cookie, agent
   service token or vendor API key as the ingest credential.
6. Convert your producer's data into a canonical batch and send it over your
   private connection. The supplied sender accepts an already-normalized batch:

```sh
npm run --silent send:events -- --file /absolute/private/batch.json --token-file /absolute/private/source-ingest-key --base-url http://127.0.0.1:8080
```

The batch uses the source's displayed IDs, producer-stable `recordId` values,
a stable `receiptId` of 16–128 characters, and original RFC 3339 timestamps.
The sender validates up to 1,000 records and 1 MiB, verifies the receipt, and
retries only selected transient failures with the **same exact body**. It is
not a durable queue: retain unsent batches in your own worker. Supported kinds
and payload requirements are in the
[canonical schema](contracts/normalized-record.v1.schema.json),
[batch schema](contracts/ingest-batch.v1.schema.json), and
[sender guide](docs/INTEGRATION-REVIEW.md#sender-cli-and-node-api).

7. Confirm actual records in **Sources → Received observations**, then check
   the source's delivery health and the **Integrations** coverage matrix.
   Matching screens show imported facts; they do not silently run rules, send
   notifications, launch scans, activate prompts or close risks.

For Trivy, use **Trivy JSON report import** and the Scans upload or `import:trivy`
CLI instead. Generic `scan.result` events cannot masquerade as a validated
Trivy report. For these general push/import paths, vendor credentials stay in
your external adapter; the generic registry does not resolve them. Only the
separate Live monitoring path stores credentials for its fixed Sentry/Slack clients.

For the ten vendor formats, start in **Sources → Vendor imports** and follow
the [step-by-step vendor guide](docs/VENDOR-INTEGRATIONS.md). For an external
collector, use the source/app IDs from the corresponding installed preset:

```sh
npm run --silent vendor -- enqueue --adapter github-audit --file /absolute/private/audit-page.json --source-id YOUR_SOURCE_ID --app-id YOUR_APP_ID --outbox-dir /absolute/private/soc-outbox --base-url http://127.0.0.1:8080
npm run --silent vendor -- drain --outbox-dir /absolute/private/soc-outbox --source-id YOUR_SOURCE_ID --token-file /absolute/private/source-ingest-key --base-url http://127.0.0.1:8080
```

Use a dedicated owner-only outbox directory outside the checkout and separate
from application state/token files. The queue persists before sending; `status`
and `retry` support inspection/recovery. Schedule drain externally. Vendor
acquisition, pagination and credentials remain in your collector. Original
timestamps and server replay limits still apply; exports are not silently
re-dated. Raw free-form messages, stacks, requests and secrets are excluded by
the default mappings. This import/outbox path does not verify live accounts or
poll them automatically; the separate Sentry live collector does.

“Bring any source” means vendor-independent integration, **not unbounded
storage or arbitrary event schemas**. The starter has 29 canonical kinds,
100 total integration-type slots (86 custom), bounded registry snapshots,
1 MiB ingestion requests and explicit retention limits. A source's category is
a label; the selected manifest's allowed-kind list controls admission. Extend
the versioned contracts and capacity design deliberately when those bounds no
longer fit. See the review for remaining integration work and acceptance checks.

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
| Private sign-in | Better Auth + SQLite; one-time local administrator setup; optional TOTP and single-use recovery codes; fixed eight-hour sessions; sign-out and local password/session recovery |
| Application/source setup | App/environment registration, optional hosts, manifest-driven setup, tests, activation, and source lifecycle controls |
| Canonical log push | Authenticated indexed SQLite admission with transactional receipts; bounded projections to Overview, Sources, Logs, Analytics, and Health |
| Universal/custom sources | All 29 canonical kinds; UI-managed immutable definitions; source-bound credentials; ten bundled vendor export/API-page mappings; other vendor mappings remain external |
| Integration inspection | Actual source-to-screen coverage plus indexed application/source/kind/time observation reads; UI pagination and payload details |
| Live application monitoring | Sentry Cloud project error polling, encrypted credentials, durable checkpoint/recovery, application-error and collector-health alerts, optional Slack delivery; local environment is attribution, not upstream filtering |
| Documents | Upload/download, immutable file versions, hashes, metadata/status/review dates, audit history, archive/restore |
| Agents/governance | Agent/prompt/enrollment and attestation/risk record management; no agent execution or observed-job scheduler |
| Trivy | Actual JSON report normalization/import, source-scoped admission and scan summaries; no scanner execution |
| Other scan integrations | Eleven legacy acquisition templates remain data-only; matching imported observations can appear without claiming a scanner ran |
| Other SOC screens | Relevant main views show read-only canonical observations; native actions, specialized analysis, and detail workflows still need dedicated implementations |
| MCP | Seven narrow tools, public documentation resources and a user-invoked setup prompt; scoped private service authentication, expiry, rotation/revocation and audit; no credential issuance or telemetry transport |

The private app uses an indexed telemetry database; the disposable reference
workbench retains its 10,000-record JSON store. Administration remains bounded
and single-writer. Telemetry retention and replay guarantees have explicit
limits described in the technical manual; this is not an unlimited SIEM.
Documents are capped
at 10 MiB per file, 512 MiB total bytes, 1,000 documents, and 10,000 versions.
Do not hide a capacity failure by deleting evidence or resetting state.

The next integration work is commissioning the complete Sentry experience with
real authorized accounts, supported process supervision/restore tooling, and
additional reviewed collectors. Raw webhook/signature handling, broader field
mapping, OTLP/syslog translation, general vendor-secret resolution and native
workflow projectors remain separate work. Also still
needed: turnkey availability/TLS collection, observed agent jobs, evidence
verification, richer attestation checklists, risk-document import/export,
least-privilege human roles, deployment/restore tooling and mixed-load tests.
The [integration review](docs/INTEGRATION-REVIEW.md) prioritizes these and gives
acceptance criteria; a populated observation table does not complete them.

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
- [Guided application setup, diagnostics and beginner help](docs/GUIDED-SETUP.md)
- [AI client connection and agent-assisted setup runbook](docs/AI-SETUP.md)
- [Live Sentry monitoring, Slack delivery and operations](docs/LIVE-MONITORING.md)
- [Vendor export/import adapters and durable delivery](docs/VENDOR-INTEGRATIONS.md)
- [Integration review and remaining adoption work](docs/INTEGRATION-REVIEW.md)
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
