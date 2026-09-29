# Better Auth reference bridge

This reference is the practical default for an adopter that already runs one
TypeScript/Node application and wants that application to own authentication.
It adapts an adopter-installed Better Auth browser client to the console's
provider-neutral `SOC_CONSOLE_AUTH` contract. This optional embedding example is
separate from the repository's runnable private application, which installs
pinned Better Auth + SQLite and supplies email/password sign-in. To use that
application directly, follow [the private quickstart](../../docs/AUTHENTICATION.md#shipped-private-application)
instead of integrating this bridge. No provider credentials or deployment
secrets are committed in either path.

The private runtime also includes indexed SQLite telemetry, Documents, scoped
service-agent access, and a Trivy JSON report importer. Those are server features,
not capabilities conferred by this browser bridge. Agents → Service Access
issues separate expiring credentials for the five-tool MCP client; never turn a
Better Auth browser cookie into an agent credential. Scans → Trivy accepts a
supported report from an operator or its source-bound ingest credential, not an
MCP credential, and does not run the scanner. Eleven legacy scanner templates
remain non-executing. See technical manual
[section 52](../../public/technical-reference.md#52-storage-limits-reliability-acceptance-and-remaining-parity-work),
[section 53](../../public/technical-reference.md#53-private-service-identities-and-authenticated-mcp-setup),
and [section 54](../../public/technical-reference.md#54-trivy-report-import-from-a-users-own-scanner)
for the concrete private implementation and its limits.

Use the Keycloak reference instead when one centrally administered identity
service must serve several products, languages, or independently deployed
applications. Both choices present the same closed browser contract to the
console.

## What the bridge calls

`better-auth-bridge.js` uses the current Better Auth client surface through an
injected client:

- `authClient.getSession()` reads the same-origin application session;
- `authClient.signOut()` ends it; and
- an adopter-supplied `beginLogin` starts the chosen sign-in method, commonly
  `authClient.signIn.social(...)`.

The bridge captures `getSession`, `signOut`, `beginLogin`, and the optional
projector when the provider is created. The adopter remains responsible for the
code inside `beginLogin`, including any client method it calls.

## Install it in the adopter application

Install and configure Better Auth in the application that will serve the SOC
console. Mount its handler on the same origin as the console and create the
framework-appropriate client in that application's normal client bundle. With a
same-origin Better Auth handler, the client does not need a separate `baseURL`.

Load the console auth contract before this bridge, then install the provider
before `public/bootstrap.js` mounts the application. A bundled client entry can
use this shape:

```js
import { createAuthClient } from "better-auth/client";

const authClient = createAuthClient();

window.SOC_CONSOLE_AUTH = window.SocConsoleBetterAuthBridge.createProvider({
  authClient,
  callbackPath: "/soc/",
  beginLogin({ callbackURL }) {
    return authClient.signIn.social({
      provider: "github",
      callbackURL
    });
  }
});

// Bootstrap reads SOC_CONSOLE_AUTH during evaluation, so load it only after
// the provider assignment above has completed.
await import("/soc/bootstrap.js");
```

Create a public, same-origin `deployment-config.js` that selects application
mode and enables the presentation gate. This file contains no secret:

```js
"use strict";

window.SOC_CONSOLE_PUBLIC_CONFIG = {
  schemaVersion: "1",
  mode: "application",
  auth: {
    globalName: "SOC_CONSOLE_AUTH",
    required: true
  }
};
```

`deployment-config.js` must execute before `app-config.js`; configuration is
read and frozen once. Setting `SOC_CONSOLE_PUBLIC_CONFIG` afterward has no
effect. `auth.required` suppresses page-provider reads and renders the browser
gate while the projected session is anonymous. It is not server authorization.

Load the static console dependencies and bridge as classic scripts, then load
only the adopter entry as a module:

```html
<script src="/soc-adopter/deployment-config.js"></script>
<script src="/soc/app-config.js"></script>
<script src="/soc/adapter-contract.js"></script>
<script src="/soc/auth-contract.js"></script>
<script src="/soc/connector-contract.js"></script>
<script src="/soc/administration-contract.js"></script>
<script src="/soc/technical-docs.js"></script>
<script src="/soc/ui-catalog.js"></script>
<script src="/soc/app.js"></script>
<script src="/soc-adopter/better-auth-bridge.js"></script>
<script src="/soc-adopter/auth-client-entry.js" type="module"></script>
```

Do not add a separate classic `<script src="/soc/bootstrap.js">` after the
module entry. Classic scripts run while the document is being parsed, whereas
module scripts are deferred; that sequence can mount the console before
`SOC_CONSOLE_AUTH` exists. The awaited module import in the adopter entry makes
provider installation the explicit happens-before boundary. This is especially
important with `auth.required: true`, because bootstrap resolves the auth
provider once when it creates the application.

Copy `better-auth-bridge.js` into the adopter-owned asset pipeline. Do not edit
the checked-in skeleton to contain provider credentials or environment-specific
origins. Enable application mode and the auth gate only after the bridge and a
server-protected page provider are wired together.

## Replace the inspection-only host policy

`npm run start:static` serves the data-free inspection shell only. Its server accepts only
asset `GET`/`HEAD` requests, does not mount a Better Auth handler, and sends
`connect-src 'none'`. The checked-in HTML contains the same restrictive
`connect-src` directive in a meta policy. Consequently, the default local server
cannot execute `getSession`, sign-in, or sign-out against Better Auth. `npm start`
is the separate authenticated private runtime and already installs its own
same-origin bridge, sign-in page, response policy, and auth handler.

Serve the adopted console from the application that mounts Better Auth. Replace
both the response policy and the checked-in meta policy with one reviewed
application policy that permits only the required same-origin auth/page
connections (normally `connect-src 'self'`). Do not leave the stricter meta
policy in place: multiple Content Security Policies intersect, so its
`connect-src 'none'` would continue blocking the client. See
[the configuration guide](../../docs/CONFIGURATION.md#content-security-policy-and-host-integrations).

## Same-origin callback and hash route

`callbackPath` is an application path, not an identity-provider callback. It
must begin with one `/`, remain on the current browser origin, and contain no
hash. The bridge combines it with the validated console `returnTo` value. For
example, a console at `https://console.example.invalid/soc/` and a return route
of `#/triage?view=cases` produce this Better Auth `callbackURL`:

```text
https://console.example.invalid/soc/#/triage?view=cases
```

Better Auth receives the complete `callbackURL` so it can preserve the post-login
destination. When the browser later navigates to that URL, its fragment is not
included in the destination HTTP request; it remains available to the console
router. Absolute, scheme-relative, traversal, duplicate-query-key, and
second-fragment return values are rejected by `SocConsoleAuthRuntime`.

This browser check is defense in depth. Configure Better Auth with an exact
production base URL and an explicit `trustedOrigins` allowlist, and validate
callback destinations on the server. Do not treat the bridge's same-origin URL
construction as the server's CSRF or open-redirect control.

For a local, nonredirecting Better Auth sign-out, the bridge navigates to the
same validated callback URL after `authClient.signOut()` succeeds. Some upstream
provider/plugin configurations initiate their own provider logout redirect. In
that case, use and test a deployment-specific logout integration; do not assume
the bridge's follow-up navigation will run or that the upstream SSO session was
ended. A failed session read, sign-in start, or sign-out produces a fixed error
and does not expose provider response details.

## Closed session projection

Better Auth's client session is an input to this bridge, not the console's
public session shape. The default projection emits only:

```js
{ authenticated: false }
```

or an authenticated result with an optional display name and initials:

```js
{
  authenticated: true,
  display: { name: "Example operator", initials: "EO" }
}
```

It deliberately discards user IDs, email addresses, session identifiers,
provider data, and every other Better Auth session field. If an application
needs browser-visible capability hints, supply `projectSession(sessionData)` and
return only the closed shape accepted by `SocConsoleAuthRuntime.validateSession`:

```js
window.SOC_CONSOLE_AUTH = window.SocConsoleBetterAuthBridge.createProvider({
  authClient,
  callbackPath: "/soc/",
  beginLogin: ({ callbackURL }) => authClient.signIn.social({
    provider: "github",
    callbackURL
  }),
  projectSession(sessionData) {
    return {
      authenticated: true,
      display: {
        name: sessionData.user.name,
        initials: "EO"
      },
      capabilities: ["console:read"]
    };
  }
});
```

The contract rejects unknown fields and dedicated fields for sensitive auth
material. It cannot recognize a secret deliberately encoded inside an allowed
display or capability string. Keep a custom projector small, deterministic,
explicitly data-minimizing, and covered by tests. Browser capabilities are
display hints only and must never authorize a server read or command.

## Server-side authorization is still required

The Better Auth server integration must authenticate every protected request
from its cookie, load the current session through the framework's server API
(for example, `auth.api.getSession({ headers })`), and authorize the exact
tenant, route, resource, field, and action. Page models must be reduced on the
server before the adapter returns them. Deny missing or stale permissions by
default.

Do not trust the console's authenticated flag, display object, capability list,
hash route, or disabled controls as proof of permission. Preserve Better Auth's
origin and request protections, add application CSRF controls wherever the
chosen framework or endpoint requires them, and keep provider credentials and
session internals out of browser-readable configuration and logs.

Test at least anonymous, authenticated, expired, revoked, denied, upstream
failure, sign-out failure, and post-login return-route behavior in the adopter
application. The bridge test in this repository verifies only the public
contract and reduction boundary with an injected test client. Separate private
runtime tests exercise the pinned Better Auth implementation; neither test
suite approves a differently configured downstream Better Auth deployment.
