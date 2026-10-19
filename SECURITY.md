# Security Policy

## Scope and supported baseline

This repository contains a data-free static preview and a runnable private,
single-deployment SOC application. The private application implements Better
Auth password sessions, optional per-account TOTP, scoped service credentials,
source-authenticated ingestion, SQLite-backed telemetry and documents, native
monitoring and Operations workflows, opt-in detection, and durable email
notifications. These are executable features, not guarantees that an adopter's
sources, detections, mail or recovery procedures have been commissioned.

Security fixes target the current default-branch implementation. This policy
does not establish a response SLA, a supported historical-release matrix or a
certification of a particular deployment.

## Reporting

Use this repository's private GitHub security advisory reporting feature when
available. Do not publish credentials, operational telemetry, private topology,
personal data or exploit details in a public issue. Include the affected
revision, relevant mode and configuration, expected boundary, and a minimal
synthetic reproduction. This policy does not designate another reporting address
or external service.

## Deployment boundaries

- The private application listens on loopback. Shared access uses its exact
  configured HTTPS Tailnet origin behind ACL-restricted Tailscale Serve.
  Public ingress and Funnel are outside the supported deployment posture.
- Human accounts are full-access operators in one deployment. Application IDs
  organize and bind data; they do not create tenant isolation or human RBAC.
  Service credentials use exact installation-wide scopes. Source credentials
  are a separate, source-bound data-admission lane.
- The browser's closed session and page projections are presentation contracts,
  not authorization. Server routes enforce the appropriate session or machine
  credential, input scope and same-origin protections.
- Authentication requires no mail service. Notification sending is a separately
  reviewed opt-in configuration. SMTP uses certificate verification and TLS or
  required STARTTLS; unknown DATA acceptance requires reconciliation.
  Relay/provider acceptance never proves inbox delivery.
- Collector inputs, network targets, credentials, rule rollout and recipients
  require explicit adopter configuration. Generated deployment packs do not
  install themselves, activate sources, launch arbitrary jobs or commission an
  integration.

The static preview has no operational provider or authenticated API. The
separate loopback reference workbench uses a synthetic local-operator model and
is for disposable development only. Do not expose either as an authenticated
shared service or point the workbench at private application state.

## Data and secret custody

Keep private configuration, credentials, databases, WAL files, collector cursors
and outboxes outside the checkout with the required ownership and access modes.
Never commit live telemetry, identities, prompts, deployment inventories or
secrets. The public audit and input validators are guardrails, not a guarantee
that arbitrary text contains no sensitive material.

The application uses bounded local storage and explicit replay and retention
limits. Back up all related state consistently, preserve external credential
files through an appropriate secret-backup process, and test restoration.
Do not delete cursors, uncertain delivery attempts, receipts or databases to
bypass startup or capacity failures. Operator reconciliation records a decision;
it cannot establish an outcome without supporting evidence.

MCP is a narrow administrative client, not an arbitrary fetch, shell, telemetry
or secret transport. Managed-agent records and employee instructions do not run
processes. The operator owns any external runner and its permissions.

## Review invariants

Treat received telemetry, files, imported definitions, collector responses and
operator-authored text as untrusted input. They must not become executable page
markup, shell commands, arbitrary network destinations or authority to change
unrelated sources and applications. Credentials and enrollment values must not
leak through page models, status, errors, logs or retained public examples.

Admission must enforce the registered source/application binding before committing
records or replay results. Durable receipts, cursor advancement, queue state and
mail uncertainty must preserve their documented ordering across failures and
restart. A replay must not silently change its payload or cross an authorization
boundary. Missing observations must remain unknown rather than fabricate health.

Failures of those properties are meaningful review findings even on a private
network. Assess impact against the actual mode, required credentials and input
path. The documented absence of human RBAC is not a blanket exclusion for broken
session checks, source isolation, service scopes or secret custody.

## Adopter responsibilities

Review the actual deployment's threat model, private network controls, identity
provisioning, optional MFA policy, account revocation, source ownership, storage
capacity, updates, backup/recovery and audit monitoring. Fine-grained human
roles, tenant isolation, high availability, a managed secret service and an
external immutable audit ledger are not provided by this single-deployment
starter. OIDC is documented integration guidance, not enabled authentication in
the shipped application.

Repository tests use synthetic inputs and isolated fixtures. Passing them does
not attest real Windows permissions, cloud-provider coverage, SMTP delivery,
cluster compatibility, scan completeness or production resilience.

See [Authentication](docs/AUTHENTICATION.md),
[Configuration](docs/CONFIGURATION.md),
[Architecture](docs/ARCHITECTURE.md),
[Native Operations](docs/NATIVE-OPERATIONS.md), and
[Notifications](docs/NATIVE-NOTIFICATIONS.md) for the implemented boundaries.
