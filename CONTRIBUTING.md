# Contributing

Contributions should preserve three things together: the repository's
public-safe boundary, the versioned integration contract, and exact default
product-design parity.

## Public-safe content rules

1. Keep the checked-in interface data-free. Do not add records, counts,
   identities, timestamps, findings, systems, evidence, or operational values;
   page content belongs behind an adopter-owned adapter.
2. Do not add logs, credentials, tokens, cookies, private keys, connection
   strings, internal hostnames, customer or employee names, account inventory,
   private policies, evidence, detection signatures, vendor configuration, or
   deployment detail.
3. Keep checked-in public JavaScript free of outbound network requests,
   persistence, uploads, subscriptions, command execution, telemetry
   collection, and environment discovery.
4. Keep contract examples empty and deterministic. Do not use the current clock,
   randomness, environment inspection, or machine-specific values.
5. Treat every file under `public/` as world-readable. Treat docs, examples,
   tests, and history as public too.
6. Keep `public/technical-reference.md` public-safe. Its examples may use only
   documented placeholders and must not include operational data, real
   infrastructure, credentials, identities, or private deployment detail.

Operational providers belong in an adopter-owned, independently reviewed
application boundary. The checked-in loopback workbench is a bounded reference
exception, not a relaxed production profile; it may not gain external vendor
connections or remote-default binding.

## Product-design rules

- Preserve the exact committed Bulwark Black SOC assets and default visual
  tokens documented in [docs/DESIGN-SYSTEM.md](docs/DESIGN-SYSTEM.md).
- Do not replace the full sidebar mark with text, a generic shield, a recolored
  image, or an icon-only treatment.
- Do not introduce a second near-duplicate palette. Reuse the documented text,
  accent, state, line, panel, and background values.
- New components must cover hover, focus-visible, active, disabled, narrow
  viewport, and reduced-motion behavior as applicable.
- Information conveyed by color, motion, a chart, or an icon must have a text or
  semantic equivalent.

An intentional rebrand or product redesign requires explicit product direction
and coordinated updates to assets, checksums, screenshots/tests, CSS, and the
design-system document.

## Adapter-contract rules

- Keep provider data within the explicit version-1 request, envelope, panel, and
  typed-cell schemas in
  [docs/ADAPTER-CONTRACT.md](docs/ADAPTER-CONTRACT.md).
- Never add provider-supplied HTML, Markdown pass-through, script, event handler,
  URL injection, or executable callback to a presentation model.
- Continue rejecting unknown object keys. Silent acceptance makes compatibility
  and security review ambiguous.
- Treat a new field, panel type, command shape, subscription event, or upload
  model as a contract-versioning decision, not a renderer shortcut.
- Keep `examples/provider-template.js` local, empty, read-only, and free of I/O.
- Add valid, boundary, and rejection tests whenever a validator changes.

## Connector-contract rules

- Keep page reads, source-management commands, and telemetry admission as three
  explicit boundaries. Do not tunnel commands through page envelopes or send
  records through the command provider or MCP.
- Keep `appId`, `hostId`, `connectorInstanceId`, and `sourceId` stable and
  independent. Never restore `(host, kind)` as source identity.
- Connector manifests own supported source kinds, non-secret configuration
  fields, credential-reference slots, canonical outputs, page targets, and
  health policy. Do not add a free-form kind or user-controlled searchability
  switch.
- Persistent contract objects may contain credential references only. A
  one-time connection-check/source-ingest value is valid only in its documented
  successful command result and must never enter a snapshot, audit event, page
  envelope, fixture, or repository file.
- Reject unknown keys and validate complete cross-object relationships. Update
  both JSON Schemas and `public/connector-contract.js` together.
- Keep the reference workbench loopback-only, dependency-free, fail-closed, and
  explicit about its state directory. Do not add production credentials,
  upstream API calls, background collectors, or claims of production safety.
- Add tests for duplicate same-kind instances, revision conflicts, lifecycle
  ordering, credential redaction, source binding, replay/body binding, atomic
  state/audit behavior, and the named page projections.

## Route and renderer changes

Preserve the invariant **38 SOC routes plus one local `/docs` utility**. The 38
SOC routes are adapter-addressable. `#/docs` is shell-owned and must never call
`readPage`, `SOC_CONSOLE_CONNECTORS.getSnapshot`, or
`SOC_CONSOLE_CONNECTORS.execute`.

When adding or changing a SOC route:

1. Update the single route catalog.
2. Keep the route's checked-in page state empty; supply data only through an
   external validated provider.
3. Preserve desktop and compact navigation parity.
4. Define ready, empty, error/unavailable, forbidden, and unknown-route behavior
   where applicable.
5. Preserve focus management, keyboard behavior, semantic headings, labels,
   captions, machine-readable times, and accessible chart equivalents.
6. Update [docs/FEATURES.md](docs/FEATURES.md) and relevant adoption guidance.
7. Add or update route and behavior tests.

Treat a change to `#/docs` as a local shell/documentation change, not a page- or
connector-provider expansion. Preserve its local-only catalog flag, integrity
failure state, filter/focus behavior, and exact product styling.

Disabled concepts must remain honestly disabled. Only the five closed connector
commands may become active through `SOC_CONSOLE_CONNECTORS`; a visible unrelated
input or action must not imply that a production workflow, validation,
persistence, or authorization exists.

## Documentation changes

Documentation is part of the adopter interface. Examples must match exact
global names, script order, method signatures, schema versions, limits, and npm
commands in the current tree. Clearly distinguish:

- the built-in empty state from an injected provider;
- presentation validation from authorization;
- public browser configuration from private server configuration;
- a structural control placement from an operational control;
- repository verification from production readiness.

The canonical in-app/agent manual is
[`public/technical-reference.md`](public/technical-reference.md). Edit that
Markdown source rather than the generated
[`public/technical-docs.js`](public/technical-docs.js), then run:

```sh
npm run build:docs
npm run check:docs
```

Commit the regenerated artifact with its source. `check:docs` is a strict
source-to-artifact equality check; do not hand-edit the generated JavaScript.

Use relative repository links. Do not place a real environment URL, service
name, API response, customer example, or screenshot of operational data in the
documentation.

## Verification

Node.js 20 or newer is required. Run the complete baseline check:

```sh
npm run check
```

This executes:

```sh
npm run check:docs
npm test
npm run audit:public
```

After changing the technical manual, run `npm run build:docs` first. You can run
`npm run check:docs` independently while iterating; the complete `npm run check`
also includes it.

Use the same runtime validator for page-envelope documents:

```sh
npm run validate:provider -- path/to/page-envelope.json
```

Validate connector/control and canonical-ingest documents with:

```sh
npm run validate:connector -- path/to/connector-document.json
npm run validate:ingest -- path/to/ingest-batch.json
```

For visible changes, also run `npm start` and manually review every affected
route at wide and narrow widths. Exercise keyboard navigation, focus return,
tabs, disclosure controls, route filtering, transient notices, unknown routes,
loading/empty/failure states, zoom, and reduced motion. Automated checks do not
replace this review. For `#/docs`, also exercise its contents links, chapter
filter, target focus, wide tables, code regions, and local integrity-failure
state, and confirm that navigation causes no page or connector-provider call.

## Definition of done

A change is complete when:

- all checked-in routes/content remain data-free and public-safe;
- the documented design and adapter contracts match the implementation;
- route and compact-navigation parity is preserved;
- relevant success, absence, denial, and failure states are covered;
- relevant accessibility and responsive interactions were exercised;
- `npm run check` passes without weakening the audit;
- adopter documentation is updated for any changed behavior or boundary;
- `public/technical-docs.js` exactly matches the generated form of
  `public/technical-reference.md` when the manual changed;
- source/connector changes preserve lifecycle, identity, secret, ingest, and
  projector invariants documented in [docs/CONNECTORS.md](docs/CONNECTORS.md).

CI pipelines, GitHub workflows, branch protection, repository templates,
release automation, publishing, and marketplace readiness are intentionally out
of scope for this contribution guide. Do not add or modify them as part of
interface, adapter, documentation, or local-tooling work.
