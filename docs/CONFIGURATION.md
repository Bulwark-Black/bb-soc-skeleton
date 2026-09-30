# Public configuration

Browser configuration is intentionally small, versioned, data-free, and public.
It selects presentation/integration behavior; it is not a secret, identity, or
authorization-policy mechanism.

## Server launch configuration

`npm start` runs the private application, not the static preview. It requires
Node.js 22.13 or newer, `npm ci`, and an absolute persistent state directory
outside this checkout. On first local sign-in, create the first administrator
with the one-time localhost form, or provision an operator through `npm run account`.
Complete bootstrap before enabling the private Tailnet origin; browser setup
is not available through a proxy. Follow
[AUTHENTICATION.md](AUTHENTICATION.md) for the complete first-account procedure.

| Server setting | CLI alternative | Purpose |
| --- | --- | --- |
| `SOC_STATE_DIR` | `--state-dir` | Required external owner-only state directory; canonical paths without symlink ancestors |
| `SOC_PORT` | `--port` | Loopback listener port, default `8080` |
| `SOC_BASE_URL` | `--origin` | Exact application origin; defaults to the matching loopback URL; use the configured private HTTPS origin behind Tailnet Serve |

The listener remains on `127.0.0.1`. Prefer private tailnet access and never
Tailnet Funnel or public ingress. These server settings are not additions to
`SOC_CONSOLE_PUBLIC_CONFIG`. The private server supplies application mode,
required authentication, and the reviewed same-origin integration bridge.
All provisioned operators currently have full access; this is not per-role or
per-tenant authorization. State includes Better Auth, Documents, service-access,
and indexed telemetry SQLite stores, plus bounded administration JSON state and
audit. Back up the whole directory as a consistent stopped-service unit and test
restoration. Existing valid reference connector state is migrated atomically to
private telemetry; legacy files remain untouched and cannot be used to run the
reference writer against the migrated directory.

Private telemetry defaults to 100,000 retained records, 256 MiB of canonical
record JSON, and 30 days; the replay window is seven days. Count, byte, age,
receipt, identity, and audit limits are separate. A programmatic
`startPrivateApplication({ telemetryRetention: ... })` override is validated and
pinned when initialized; it is not a browser option, CLI flag, or live retention
editor. Retention pruning runs on successful state mutations, not a background
timer. Review actual counters in Retention → Policy/Reality and the detailed
limits and migration rules in [technical manual section 52](../public/technical-reference.md#52-storage-limits-reliability-acceptance-and-remaining-parity-work).

Private mode installs `canonical-push`, `canonical-events` and `trivy-report`,
plus custom canonical-push definitions registered by a human operator in
Sources → Integrations. Definitions live in the transactional telemetry control
state; no plugin directory or executable module is loaded. They are immutable,
with 86 custom/100 total slots and 64 KiB per definition. Use Sources → Received
observations for all supported kinds. See the
[integration review](INTEGRATION-REVIEW.md) for the sender, lifecycle and limits.
The eleven legacy
scanner setup templates remain non-executing. Trivy import is under Scans →
Trivy and `/api/v1/scanners/trivy/import?sourceId=...`, using an operator session
or source-bound bearer, never a service-agent credential. The importer does not
need a vendor API key or run a scan; it accepts an already-produced supported
report. See [technical manual section 54](../public/technical-reference.md#54-trivy-report-import-from-a-users-own-scanner).

`npm run start:static` serves the dependency-free, data-free preview without
authentication, document APIs, or installed source providers. The separate
`npm run start:connectors` workbench is for local development only.

## Load order

The deployment composes classic scripts in this order:

```text
optional adopter public configuration
  -> public/app-config.js
  -> public/adapter-contract.js
  -> public/auth-contract.js
  -> public/connector-contract.js
  -> public/administration-contract.js
  -> public/application-bridge.js or adopter integration bridge
  -> public/technical-docs.js
  -> public/ui-catalog.js
  -> public/document-library.js
  -> public/service-access.js
  -> public/scanner-import.js
  -> public/app.js
  -> public/bootstrap.js
```

Define `window.SOC_CONSOLE_PUBLIC_CONFIG` before `app-config.js` executes. The
module validates input, applies defaults, recursively freezes the result, and
exposes `window.SocConsoleConfig`.

For a deployed fork, use a same-origin external script rather than relaxing CSP
for inline JavaScript:

```html
<script src="deployment-config.js" defer></script>
<script src="app-config.js" defer></script>
```

`deployment-config.js` can contain:

```js
"use strict";

window.SOC_CONSOLE_PUBLIC_CONFIG = {
  schemaVersion: "1",
  mode: "application",
  brand: {
    name: "Bulwark Black SOC",
    product: "bulwark>soc",
    logoPath: "assets/mark.png"
  },
  adapter: {
    globalName: "SOC_CONSOLE_ADAPTER"
  },
  connectors: {
    globalName: "SOC_CONSOLE_CONNECTORS"
  },
  administration: {
    globalName: "SOC_CONSOLE_ADMINISTRATION"
  },
  auth: {
    globalName: "SOC_CONSOLE_AUTH",
    required: true
  },
  routing: {
    defaultRoute: "/"
  }
};
```

The object is read once. Changing input after `app-config.js` executes does not
reconfigure a mounted application.

## Configuration reference

| Key | Type and allowed value | Default | Purpose |
| --- | --- | --- | --- |
| `schemaVersion` | Exact string `"1"` | `"1"` | Version of the public configuration shape |
| `mode` | `"skeleton"` or `"application"` | `"skeleton"` | Declares empty inspection vs adopter integration; grants no capability |
| `brand.name` | Non-empty string, at most 100 characters | `"Bulwark Black SOC"` | Accessible/long-form brand name |
| `brand.product` | Non-empty string, at most 100 characters | `"bulwark>soc"` | Compact product label/title prefix |
| `brand.logoPath` | Relative traversal-free local asset path | `"assets/mark.png"` | Product mark loaded by the shell |
| `adapter.globalName` | JavaScript global identifier | `"SOC_CONSOLE_ADAPTER"` | Global from which bootstrap resolves a page provider |
| `connectors.globalName` | JavaScript global identifier | `"SOC_CONSOLE_CONNECTORS"` | Global from which bootstrap resolves the connector-control provider |
| `administration.globalName` | JavaScript global identifier | `"SOC_CONSOLE_ADMINISTRATION"` | Global from which bootstrap resolves the closed agent/governance administration provider |
| `auth.globalName` | JavaScript global identifier | `"SOC_CONSOLE_AUTH"` | Global from which bootstrap resolves browser auth integration |
| `auth.required` | Boolean | `false` | Whether page rendering requires a resolved authenticated session |
| `routing.defaultRoute` | Absolute known application route without query/fragment | `"/"` | Route used when no hash path is supplied |

Unknown keys and unsupported schema versions are errors. Nested values must be
plain objects. Logo paths reject absolute paths, traversal, backslashes, query,
and fragments. Default routes reject query/fragment/traversal and must match one
of the 40 registered paths when the application is created. Misspelled keys fail
visibly rather than being ignored. The catalog contains the 38 SOC paths plus
the application-owned `/documents` library and shell-owned `/docs` utility.
Neither local route calls the page adapter. `/docs` never reads control
providers; `/documents` uses its own authenticated document API in private mode.

The default brand values and `public/assets/mark.png` are product-matched. Keep
them unchanged when exact parity is required. See
[DESIGN-SYSTEM.md](DESIGN-SYSTEM.md).

## Mode behavior

`mode: "skeleton"` is the checked-in static configuration's data-free inspection mode. Known routes remain
registered and render empty without a page provider.

`mode: "application"` states that an adopter intends to inject page/auth/control
integrations. It does not enable networking, OIDC, commands, uploads,
subscriptions, persistence, or authorization by itself. Those capabilities
remain application-owned and server-enforced; a connector provider must still
be installed explicitly. The `npm start` private server installs these
integrations and overrides the static defaults with `mode: "application"` and
`auth.required: true` before validation; setting the mode alone does not do so.

Refresh cadence is not a version-1 public configuration key. The controller
uses the committed 300,000-ms interval only for an injected provider, plus
manual refresh. A downstream product that needs a different cadence should
make and test an intentional application/lifecycle change rather than add an
unknown config field.

## Page-provider injection

Bootstrap looks for a provider at:

```js
window.SOC_CONSOLE_ADAPTER
```

Set another safe global identifier only to avoid a host naming conflict. The
object must pass version-1 provider validation before use. When absent, no page
provider is called: the catalog renders its data-free structural state directly
and no refresh interval starts. Use `createEmptyProvider()` explicitly when a
host needs validated `empty` envelopes or provider-state semantics.

See [ADAPTER-CONTRACT.md](ADAPTER-CONTRACT.md).

## Administration-provider injection

Application builds with the administration runtime separately resolve:

```js
window.SOC_CONSOLE_ADMINISTRATION
```

This boundary is intentionally separate from page reads and connector/source
control. It supports domain-separated snapshots and a closed command vocabulary
for managed agents, prompt revisions/enrollment, attestations, and risk records.
Its validated provider shape is:

```js
{
  schemaVersion: "1",
  id: "application-administration",
  getSnapshot,
  getPrompt,
  execute,
  dispose // optional
}
```

Agent snapshots contain prompt metadata only. `getPrompt` takes a validated
stable prompt selector and returns one separately authorized literal-text prompt
document; it is not a bulk prompt export or a signal that every snapshot viewer
may see prompt bodies.
The current command families are `agent.create`, `agent.update`, `agent.pause`,
`agent.resume`, `agent.archive`, `agent.restore`, `agent.remove`,
`prompt.revise`, `prompt.activate`, `prompt.archive`, `enrollment.issue`,
`enrollment.revoke`, and
`<attestation|risk>.<create|update|transition|archive|restore|remove>`.
The installed runtime remains authoritative; clients must reject unknown or
version-mismatched commands rather than passing arbitrary operations through.

Provider methods are thin clients of one same-origin authenticated
administration service. The server authorizes every entity/action/scope,
requires the exact current administration snapshot revision for conflicting
writes, commits state and audit
atomically, and redacts snapshots. The browser provider does not store prompts,
credentials, API keys, evidence bodies, or authorization policy. One-time
enrollment values may appear only in the correlated successful issuance result
and must never appear in a snapshot or public configuration.

See [AGENTS.md](AGENTS.md) for lifecycle and MCP boundaries. The shipped MCP
facade calls the same runtime through scoped private service routes; it is not
configured through the public object and must not become a second authorization
or secret path.

## Connector-provider injection

Bootstrap separately looks for a source-management provider at:

```js
window.SOC_CONSOLE_CONNECTORS
```

Its exact shape is:

```js
{
  schemaVersion: "1",
  id: "application-connectors",
  getSnapshot,
  execute,
  dispose // optional
}
```

`getSnapshot({ schemaVersion, reason, knownRevision? })` returns the installed
connector manifests, apps/environments, optional hosts, connector instances,
staged setups, active/paused/archived sources, change entries, and registry
revision. `execute(request)` accepts only `app.register`, `host.enroll`,
`source.setup`, `source.test`, `source.activate`, `source.update`, `source.pause`,
`source.resume`, `source.revoke`, `source.rotate`, `source.archive`, and
`source.remove`. The connector runtime validates request and result shape and
correlation before the UI uses them.

The checked-in static bridge installs no provider, so preview Onboarding and
Sources controls stay disabled. The private application generates an installed
bridge instead. A custom host integration should make both provider methods thin clients of
one same-origin authenticated command service. Do not place endpoints,
credential values, transport tokens, or authorization policy in public config;
only the provider global name is configuration. See
[CONNECTORS.md](CONNECTORS.md).

## Authentication integration

Bootstrap looks for browser authentication integration at:

```js
window.SOC_CONSOLE_AUTH
```

The exact version-1 shape is:

```js
{
  schemaVersion: "1",
  id: "application-auth",
  getSession,
  login,
  logout
}
```

The runtime validates and binds those methods. `getSession()` resolves to one of
these closed projections:

```js
{ authenticated: false }
```

```js
{
  authenticated: true,
  display: { name: "Display name", initials: "DN" },
  capabilities: ["console:read"]
}
```

Display/capabilities are optional for an authenticated session. An
unauthenticated projection may contain neither. Raw provider claims,
subject/session identifiers, cookies, credentials, and access/refresh/ID token
material are rejected.

`login({ returnTo })` and `logout({ returnTo })` receive only an internal hash
route such as `#/triage`. The implementation belongs to the host application and
normally navigates through its BFF. It must never accept an absolute/open
redirect target.

When `auth.required` is `true`, missing integration or an unauthenticated session
gates page rendering. When `false`, the data-free route shell remains browseable;
that setting does not authorize adapter data or commands.

See [AUTHENTICATION.md](AUTHENTICATION.md) for the shared server-authentication
boundary and the separate Better Auth/OIDC requirements.

## Values that must never be configured here

Everything in this object is readable by operators, extensions, developer tools,
proxies, caches, and recipients of the static deployment. Do not include:

- API keys, OAuth client credentials, tokens, passwords, cookies, session IDs,
  signing/encryption keys, or authorization headers;
- database, queue, collector, cloud, email, scanner, ticketing, chat, or identity
  provider connection strings;
- private hostnames, topology, account inventory, customer data, page data, or
  evidence locations;
- server trust policy, privileged role mappings, or authorization decisions.

Sensitive-key-name rejection is a guardrail, not a secret scanner. Review values
as well as names. Load private material from server-side secret management and
expose only the closed browser integration objects.

The MCP process has separate server-side/CLI settings, never browser config:

| Setting | CLI | Purpose |
| --- | --- | --- |
| `SOC_AGENT_MCP_BASE_URL` | `--base-url` | Fixed origin; use the private app's matching origin with service access; defaults to the legacy loopback workbench at port 8787 |
| `SOC_AGENT_MCP_TOKEN_FILE` | `--token-file` | Canonical absolute path to an owner-only regular file outside the repository containing the issued service credential |

Issue the credential through Agents → Service Access, not MCP. The client reads
the file for every request so it can pick up rotation; neither the environment
nor arguments contain the raw credential. No token file means unauthenticated
legacy loopback workbench mode only; remote private origins require a token
file. The URL validator permits HTTP only for exact loopback and HTTPS only for
approved private destinations; the private server still requires its own exact
configured origin. Tool arguments never accept URLs or cookies. Service scopes,
expiry, rotation/revocation and limits are detailed in
[technical manual section 53](../public/technical-reference.md#53-private-service-identities-and-authenticated-mcp-setup)
and [AGENTS.md](AGENTS.md).

## Environment-specific public configuration

Prefer producing a small same-origin `deployment-config.js` from an explicit
allowlist. Do not serialize an entire server environment into the browser.

```text
server configuration (private, broad)
        |
        | explicit public allowlist
        v
SOC_CONSOLE_PUBLIC_CONFIG (public, narrow, data-free)
```

Validate generated configuration before serving it and version it with the
compatible application/contract runtime.

## Content Security Policy and host integrations

The empty skeleton declares `connect-src 'none'`, so browser connections are
blocked even if an injected object attempts them. This is the correct static
public baseline. The private application serves a reviewed same-origin bridge
and response CSP for its authenticated APIs; the opt-in development workbench
also serves a same-origin bridge with its own narrow policy.

The static baseline would block a same-origin Better Auth client. The
dependency-free `start:static` server accepts only static `GET`/`HEAD` requests
and mounts no auth handler. Use the private application for working sessions
rather than weakening the preview policy.

For an application-hosted integration:

1. Serve one reviewed CSP as an HTTP response header.
2. Replace the empty baseline policy with a policy listing only required BFF
   origins in `connect-src`; prefer same-origin page/control endpoints.
3. Keep scripts, styles, images, objects, bases, forms, and framing as narrow as
   possible.
4. Set `frame-ancestors` in the response header; browsers do not enforce it from
   a `<meta>` policy.
5. Do not retain a stricter meta policy while adding a looser response policy;
   multiple policies intersect and `connect-src 'none'` would still block the
   integration.
6. Verify effective policy on application, login, callback, logout, error, and
   asset responses.

Changing CSP permits a connection. It does not authenticate, authorize,
validate, or make cross-origin credentials safe.

## Cache and version behavior

- Cache fingerprinted product assets/application files per release policy.
- Avoid long-lived caching for environment public configuration unless coupled
  to an application version.
- Never shared-cache personalized session projections/page envelopes.
- Treat config, page-contract, auth-contract, and connector-contract version mismatch as
  incompatibility; do not guess/coerce.

## Configuration review checklist

- [ ] Only documented keys are present and `schemaVersion` is `"1"`.
- [ ] `mode` is intentionally `skeleton` or `application`.
- [ ] No value is a credential, token, internal locator, record, customer datum,
      or policy decision.
- [ ] Exact brand values/assets remain when product parity is required.
- [ ] Adapter/auth/connector global names match host-created objects.
- [ ] The administration global name matches the host object when the
      administration runtime is installed; its absence otherwise fails closed.
- [ ] `auth.required` matches the deployment's gating requirement.
- [ ] `routing.defaultRoute` is one of the 40 registered routes, including the
      local `/docs` or `/documents` page when intentionally selected.
- [ ] Effective response CSP permits only required BFF connections and denies
      framing.
- [ ] Config, UI, page adapter, browser auth, connector control, canonical
      ingest, and server contracts have a tested compatibility/rollback plan.
