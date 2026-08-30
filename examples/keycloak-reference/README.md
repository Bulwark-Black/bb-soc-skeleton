# Keycloak reference templates

These files describe a confidential, server-side OpenID Connect relying party
for review. They do not add OIDC, token, or server-session handling to the
data-free browser skeleton and are not a complete Keycloak realm export or
application-server implementation. The repository's browser auth contract is
only the narrow bridge to the BFF described below.

## Files

- `keycloak-client.template.json` is a placeholder Keycloak client
  representation. It enables Authorization Code flow, requires PKCE `S256`,
  uses exact example redirect/logout URIs, and disables unrelated grants.
- `relying-party-boundary.template.json` records the matching server-side OIDC,
  session, claim-input, and browser-boundary decisions in provider-neutral
  terms. No code in this repository consumes it.

All hostnames use the reserved `example.invalid` domain. The files contain no
client secret, signing key, user, group, realm export, product record, customer
record, or operational identifier.

## Review before use

1. Read [the authentication boundary](../../docs/AUTHENTICATION.md) and select a
   maintained server-side OIDC client library for the adopter's application
   language/framework.
2. Replace the placeholder issuer and application origin with exact HTTPS
   deployment values in the adopter's private deployment configuration.
3. Create or import the client into a non-production Keycloak realm whose exact
   version matches the intended production version.
4. In the Keycloak Admin Console, confirm:

   - Client authentication is on (confidential client).
   - Standard Flow is on.
   - PKCE method is `S256`.
   - Implicit Flow, Direct Access Grants, service accounts, device flow, CIBA,
     and authorization services are off.
   - Valid redirect URI is the one exact callback URI.
   - Valid post-logout redirect URI is the one exact logged-out URI.
   - Web Origins is empty because browser JavaScript does not call Keycloak.
   - Front-channel logout is off.
   - Back-channel logout is retained only when the application server has a
     conformant, reachable logout-token endpoint.
   - Full Scope Allowed is off and requested scopes/mappers expose only reviewed
     claim inputs.

5. Let Keycloak generate the confidential client credential after client
   creation. Transfer it directly to the application server's secret manager.
   Do not add it to either template, a static configuration file, source
   history, a container image, or browser configuration.
6. Configure credential and signing-key rotation, realm login protections, MFA,
   session lifetimes, administrative roles, backups, and protected audit events
   in the deployment's private infrastructure.
7. Exercise login, callback rejection, local logout, RP-initiated logout,
   optional back-channel logout, key rotation, provider outage, and application
   authorization denial before production use.

Keycloak client representation fields can change across versions. A parseable
JSON file is not proof that the target Keycloak release will accept every field.
Export a newly created non-production client from the target version, compare
it field by field, and preserve the secure decisions above rather than blindly
copying version-specific output.

## Role and claim boundary

The reference lists Keycloak realm roles and client roles only as candidate
inputs:

```text
realm_access.roles
resource_access.soc-console-server.roles
```

The application server must allowlist recognized values, map them to its own
internal identity/role model, and evaluate the requested resource and action.
Unknown, missing, or malformed values deny by default. Neither Keycloak nor a
claim named `admin` makes the final application authorization decision.

Use exact issuer plus `sub` as the external identity key. Treat email, username,
name, and group labels as changeable attributes.

## Syntax check

From the repository root:

```sh
node -e 'for (const f of process.argv.slice(1)) JSON.parse(require("node:fs").readFileSync(f, "utf8"))' \
  examples/keycloak-reference/keycloak-client.template.json \
  examples/keycloak-reference/relying-party-boundary.template.json
```

This checks JSON syntax only. Protocol conformance, Keycloak-version
compatibility, server implementation, and security approval require separate
tests and review.
