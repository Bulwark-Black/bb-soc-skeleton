# Security Policy

## Scope

This repository is a data-free interface skeleton. It implements strict
browser-side page, authentication, and connector-control contracts plus an
opt-in loopback reference workbench for local connector/ingest testing. It has
no OIDC/token/session implementation, external vendor integrations, production
authorization layer, or production data model.

Please report vulnerabilities through the repository's private GitHub security
advisory feature. Do not place sensitive details in a public issue.

## Supported versions

Only the latest commit on the default branch is maintained.

## Deployment warning

Do not present the checked-in interface skeleton as a production security
console. A production implementation requires an adopter-owned server/BFF, a
separate threat model, and controls for identity, authorization, auditability,
availability, data integrity, and secret custody.

The reference workbench must remain bound to loopback. It uses local file state,
a single local-operator model, and one reference canonical push connector; it is
not hardened for untrusted networks, tenants, production credentials, or
production telemetry. Use an explicit disposable state directory, do not expose
its port remotely, and remove that directory after testing when its contents are
no longer needed.

For production, replace the reference runtime with an authenticated BFF,
transactional database, managed secret store, durable admission/queue/projector
pipeline, resource/action authorization, CSRF protection, rate limits,
retention/deletion controls, and monitored audit writes. MCP, if enabled, is an
administrative client of that same command service; never use it to move
telemetry or plaintext credentials.
