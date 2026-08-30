# Public configuration

Browser configuration is intentionally small, versioned, data-free, and public.
It selects presentation/integration behavior; it is not a secret, identity, or
authorization-policy mechanism.

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
of the 39 registered paths when the application is created. Misspelled keys fail
visibly rather than being ignored. The catalog contains the 38 SOC paths plus
the shell-owned `/docs` utility; `/docs` is a valid default route but never
causes a page-provider or connector-provider read.

The default brand values and `public/assets/mark.png` are product-matched. Keep
them unchanged when exact parity is required. See
[DESIGN-SYSTEM.md](DESIGN-SYSTEM.md).

## Mode behavior

`mode: "skeleton"` is the default data-free inspection mode. Known routes remain
registered and render empty without a page provider.

`mode: "application"` states that an adopter intends to inject page/auth/control
integrations. It does not enable networking, OIDC, commands, uploads,
subscriptions, persistence, or authorization by itself. Those capabilities
remain application-owned and server-enforced; a connector provider must still
be installed explicitly.

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

See [AGENTS.md](AGENTS.md) for lifecycle and optional MCP boundaries. An MCP
facade, when an adopter supplies one, calls this same service; it is not
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
connector manifests, apps, hosts, connector instances, staged setups, active
sources, change entries, and registry revision. `execute(request)` accepts only
`app.register`, `host.enroll`, `source.setup`, `source.test`, and
`source.activate`. The connector runtime validates request and result shape and
correlation before the UI uses them.

The default bridge installs no provider, so Onboarding and Sources controls stay
disabled. A host integration should make both provider methods thin clients of
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

The reference MCP process has a separate server-side/CLI setting,
`SOC_AGENT_MCP_BASE_URL` (or `--base-url`), for its fixed control origin. It is
not a browser public-config key. The reference validator permits plain HTTP only
for exact loopback and restricts HTTPS to loopback/private IPs or the validated
private-overlay DNS suffix; tool arguments never accept URLs. Production service identity and
authentication remain adopter-owned and must not be embedded in public config.

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
public baseline. The opt-in loopback workbench serves a reviewed same-origin
bridge and a correspondingly narrow response policy only for local testing.

That baseline also blocks a same-origin Better Auth client. The dependency-free
local server accepts only static `GET`/`HEAD` requests and does not mount an auth
handler. It is an inspection host, not a starting point for live authentication.

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
- [ ] `routing.defaultRoute` is one of the 39 registered routes, including the
      local `/docs` utility when intentionally selected.
- [ ] Effective response CSP permits only required BFF connections and denies
      framing.
- [ ] Config, UI, page adapter, browser auth, connector control, canonical
      ingest, and server contracts have a tested compatibility/rollback plan.
