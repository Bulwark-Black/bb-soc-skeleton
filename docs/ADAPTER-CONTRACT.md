# Page adapter contract version 1

The adapter contract is the only supported boundary between the console
renderer and adopter-supplied data. A provider receives a small route request
and returns a data-only page envelope. The console validates and normalizes both
sides of that exchange before rendering.

The contract is designed to prevent raw service responses, arbitrary HTML, and
implicit capabilities from becoming part of the UI API. It does not provide
authentication, authorization, transport security, storage, or command safety;
those remain adopter responsibilities.

The route-count invariant is **38 SOC routes plus one local `/docs` utility**.
Only the 38 SOC routes participate in this page-adapter contract. The
shell-owned `#/docs` route is not a `PageRequest` target and never calls
`readPage`, the connector provider's `getSnapshot`, or its `execute` method.

## Shipped page-contract resources

| Resource | Purpose |
| --- | --- |
| `public/adapter-contract.js` | Browser validator and provider resolver exposed as `window.SocConsoleAdapterRuntime` |
| `contracts/page-model.v1.schema.json` | Portable structural JSON Schema for a version-1 page envelope |
| `examples/provider-template.js` | Deterministic, empty provider template with no I/O or records |
| `tools/validate-provider.js` | Dependency-free command-line validation for JSON envelope documents |

Validate an envelope document before wiring it to a provider:

```sh
npm run validate:provider -- path/to/page-envelope.json
```

The command accepts multiple filenames. Each JSON document may be one envelope,
an envelope array, or an object whose `pages` field is an envelope array. Use
`-` as the filename to read one document from standard input. It exits nonzero
on JSON or contract failure and prints no validated page content.

The browser runtime remains authoritative for the object contract because it
also validates provider functions and safe JavaScript object shape. JSON Schema
validation is useful for server output, contract tests, and non-JavaScript
producers, but it is not a substitute for the runtime or
`npm run validate:provider`. Standard JSON Schema cannot express every
version-1 relationship used here: panel IDs, metric labels, chart-series labels,
and column keys must be unique within their respective collections; each table
row must have exactly one cell per declared column; a table's `disclosures`
array must align one-for-one with its rows; chart buckets must increase and each
series must have one value per bucket; and each bar value must not exceed its
sibling `max`. The command-line validator enforces those rules with the same
runtime used by the browser.

## Shell-owned technical documentation

The local `#/docs` utility renders the public-safe implementation manual from
[technical-reference.md](../public/technical-reference.md). `npm run build:docs`
turns that canonical Markdown into the generated
[technical-docs.js](../public/technical-docs.js) browser artifact, and
`npm run check:docs` fails when the two differ.

This source pipeline is not an adapter transport. The generated object is
loaded with the static shell, locally validated, and rendered as text, headings,
lists, code blocks, and tables. It carries no `PageEnvelope`, control snapshot,
command capability, provider reference, or operational data. An adopter or
agent should start with that manual for the end-to-end registration, ingest,
projection, authentication, MCP, and production-boundary guidance, then return
to this document for the exact page-model contract.

## Separate connector-control contract

The page adapter is intentionally read-only, but the repository now includes a
separate, equally strict connector-control boundary for the Onboarding and
Sources screens:

| Resource | Purpose |
| --- | --- |
| `public/connector-contract.js` | Browser/CommonJS manifest, source, health, snapshot, command, and provider validator exposed as `SocConsoleConnectorRuntime` |
| `contracts/connector-manifest.v1.schema.json` | Installed connector type, non-secret fields, credential-reference slots, output families, targets, and health policy |
| `contracts/source-registration.v1.schema.json` | Source/control snapshot and closed lifecycle command shapes |
| `contracts/normalized-record.v1.schema.json` | Bounded canonical record emitted after server-side normalization |
| `contracts/ingest-batch.v1.schema.json` | Idempotent, source-bound canonical batch |
| `tools/validate-connector.js` | Connector/control document validator |
| `tools/validate-ingest.js` | Canonical record or ingest-batch validator |

These contracts do not broaden `readPage`, and connector data cannot be placed
in a page envelope to trigger a mutation. Conversely, connector commands carry
no telemetry. See [CONNECTORS.md](CONNECTORS.md) for provider shape, lifecycle,
ingest, projection, reference workbench, and production boundaries.

## Runtime API

After `public/adapter-contract.js` loads:

```js
const runtime = window.SocConsoleAdapterRuntime;
```

The object is frozen and exposes:

| Member | Meaning |
| --- | --- |
| `VERSION` | Exact contract version, `"1"` |
| `PAGE_STATES` | `loading`, `ready`, `empty`, `error`, `unavailable`, `forbidden` |
| `PANEL_TYPES` | `notice`, `metrics`, `table`, `timeline`, `bars`, `chart`, `text`, `empty` |
| `CELL_TYPES` | `text`, `number`, `badge`, `time`, `link` |
| `TONES` | `neutral`, `info`, `ok`, `warn`, `bad` |
| `CAPABILITY_KEYS` | `readPages`, `runCommands`, `uploads`, `subscriptions`, `persistence` |
| `REQUEST_REASONS` | `initial`, `navigation`, `refresh` |
| `validateRequest(value)` | Validates, copies, normalizes, and freezes a page request |
| `validateEnvelope(value, expectedRoute?)` | Validates, copies, normalizes, and deeply freezes a page envelope |
| `validateProvider(value)` | Validates provider metadata and returns a frozen wrapper with bound methods |
| `createEmptyProvider(envelopes?)` | Creates an in-memory read-only provider; unknown/unsupplied routes resolve to empty envelopes |
| `resolveProvider(globalName?)` | Finds and validates a provider global; returns `null` when absent |

Validation is strict. Values must be plain objects using data properties, extra
fields are rejected, numeric values must be finite, identifiers and routes have
narrow grammars, and keys representing `html`, `innerHTML`, `outerHTML`, or
`srcdoc` are rejected. Validation returns normalized copies; do not depend on
object identity.

`createEmptyProvider()` with no argument contains no records and returns a valid
version-1 `empty` envelope for every requested route. Tests may pass an optional
array of up to 100 envelopes; supplied envelopes are validated/indexed and all
other routes still resolve empty. The checked-in shell never manufactures a
ready page or fallback values.

## What version 1 does and does not integrate

The route catalog and page adapter have different jobs. The catalog owns the
active product's static route, tab, filter, form, table-column, and action
vocabulary. A version-1 page provider owns dynamic page state and the validated
data-only panels described below.

For the selected route/tab, the application resolves every catalog panel by its
stable `id`. A valid provider panel with the same ID hydrates that exact visual
slot. It is never matched by title, label, or array position. Provider panels
whose IDs are not present in the selected catalog state render in a distinct
**Additional authorized data** region. This keeps read composition deterministic
while letting adopters populate the product layout without duplicating empty
panels. Hydration replaces presentation only; it never activates a structural
form or action. A matching table or metric also retains the catalog slot's
route-specific presentation classes and structural wrappers, including the
Overview, Triage, Detection Tuning, and Threat Intel treatments.

| Surface | Version-1 status |
| --- | --- |
| Read a known route/query and return safe presentation data | Defined through `readPage(PageRequest) -> PageEnvelope`; matching IDs hydrate catalog slots |
| Empty/ready/loading/error/unavailable/forbidden page state | Defined |
| Notices, metrics, tables, timelines, ranked bars, stacked time-series charts, text, and empty panels | Defined |
| Text/number/badge/time/internal-link table cells | Defined |
| Route and tab navigation | Shell-owned; query remains untrusted provider input |
| Same-console GET navigation inside provider table cells | Defined by a validated `link` cell containing a registered-style route and bounded string query |
| Row guidance / drill disclosures | Defined as optional data-only table `disclosures`; no markup is accepted |
| External URLs or commands inside provider table cells | Not defined |
| Form submission or mutation through the page provider | Not defined; source onboarding uses the separate connector-control provider, while all other command surfaces remain unavailable |
| Uploads and persistent browser state | Capability flags only; no version-1 protocol or UI binding |
| Subscription event shape/reconnect/resume behavior | Not defined |
| Arbitrary HTML, Markdown, scripts, callbacks, or URLs | Intentionally rejected |

Consequently, declaring `runCommands`, `uploads`, `subscriptions`, or
`persistence` on a page provider does not activate any structural control.
Adopters may integrate all read surfaces through page envelopes. The distinct
version-1 connector provider activates only its five validated source-management
commands on Onboarding and Sources. Activating any other write/action surface
requires a separately versioned request/result contract, server-side
authentication and resource/action authorization, CSRF and replay controls,
audit behavior, failure semantics, and matching safe UI implementation. Do not
encode an action as text, a URL, or an extra provider field to bypass a
contract.

## Provider interface

A minimum provider has this shape:

```js
const provider = {
  schemaVersion: "1",
  id: "adopter-console",
  capabilities: {
    readPages: true,
    runCommands: false,
    uploads: false,
    subscriptions: false,
    persistence: false
  },

  async readPage(request) {
    const normalizedRequest =
      window.SocConsoleAdapterRuntime.validateRequest(request);

    return readAuthorizedPageEnvelope(normalizedRequest);
  },

  dispose() {
    // Optional: cancel provider-owned work and release provider-owned resources.
  }
};

window.SOC_CONSOLE_ADAPTER = provider;
```

Provider fields are:

| Field | Contract |
| --- | --- |
| `schemaVersion` | Required exact string `"1"` |
| `id` | Required; starts with a lowercase letter and contains only lowercase letters, digits, and hyphens; at most 80 characters |
| `capabilities` | Required plain object containing only the five documented Boolean keys |
| `readPage(request)` | Required function; may return a page envelope or a promise for one |
| `runCommand` | Must exist exactly when `capabilities.runCommands` is `true` |
| `subscribe` | Must exist exactly when `capabilities.subscriptions` is `true` |
| `dispose` | Optional function for provider-owned cleanup |

`readPages` must be `true`. All five capability values are required and must be
Boolean.

Version 1 validates the presence of optional `runCommand` and `subscribe`
functions, but it does **not** define their request, event, authorization, or
result schemas. The public interface does not make those workflows safe. A team
that enables either capability must define a separately versioned, server-
enforced protocol and complete the command controls in
[ADOPTION.md](ADOPTION.md#8-add-server-security-before-commands).
Likewise, `uploads` and `persistence` are declarations, not implementations.

## Page request

The console calls `readPage` with:

```js
{
  schemaVersion: "1",
  route: "/analytics",
  query: {
    range: "24h"
  },
  reason: "navigation"
}
```

| Field | Rules |
| --- | --- |
| `schemaVersion` | Exact string `"1"` |
| `route` | Absolute application route, at most 180 characters, no query/fragment/backslash/traversal |
| `query` | Plain object with at most 20 string entries; keys begin with a letter and are at most 64 characters; values are at most 256 characters |
| `reason` | `initial`, `navigation`, or `refresh`; defaults to `navigation` during direct validation |

The route and query are navigation input, not authorization input. Validate
supported query values and enforce the operator's scope on the server. Never
turn an arbitrary route, table name, field name, or sort expression directly
into a datastore query.

The low-level route grammar is reusable, while the mounted skeleton forwards
only its 36 registered SOC paths. The eight adapter-addressable detail/utility
paths are subject to the same request/envelope validation as the 29 primary SOC
paths. The separate local `/docs` utility is resolved before provider loading
and is never forwarded.

## Page envelope

Every response has this top-level shape:

```js
{
  schemaVersion: "1",
  route: "/analytics",
  state: "empty",
  title: "Analytics",
  summary: "No page model has been supplied for this route.",
  panels: []
}
```

| Field | Rules |
| --- | --- |
| `schemaVersion` | Required exact string `"1"` |
| `route` | Required normalized route; must equal the requested route when `expectedRoute` is supplied |
| `state` | Required page state listed below |
| `title` | Required non-empty text, at most 200 characters |
| `summary` | Optional text, at most 1,000 characters |
| `updatedAt` | Optional RFC 3339 date-time; `null` is normalized to omission |
| `panels` | Required array of at most 64 panels with unique IDs |

Panel IDs start with a lowercase letter, contain only lowercase letters, digits,
and hyphens, and are at most 80 characters. The UI catalog publishes the stable
ID for every structural panel. Metrics use `summary-metrics`; other catalog IDs
are normally normalized from their structural title. Repeated display titles use
explicit IDs; for example, the urlscan submission form and result table publish
`urlscan-submit` and `url-history-results`. Read the selected page/tab entry
in `public/ui-catalog.js` rather than recreating normalization in an adapter.

When a returned panel ID matches a currently visible catalog ID, the returned
panel renders in that slot. The provider panel type controls the safe renderer,
so an application can hydrate a chart placeholder with a true `chart` panel,
deliberately use `bars` for a ranked view, or replace an explanatory placeholder
with `text`. An ID that does not match the
current route/query state remains visible under **Additional authorized data**;
it is not silently discarded. Duplicate provider IDs are rejected by envelope
validation.

### Specialized query-branch slots

Detection Tuning, Rules detail, and Phishing report detail have product-specific
layouts that cannot be selected from the route name alone. The catalog publishes
the following IDs for those query branches. Return them only for the matching
authorized request. The preferred type preserves the specialized layout; another
contract-valid type with the same ID still renders through the generic safe
renderer inside the selected branch and is not discarded.

| Request state | Stable panel ID | Preferred provider type | Specialized use |
| --- | --- | --- | --- |
| `/tuning` with non-empty `id` | `tune-detail-record` | `metrics` | Tune facts, bound scope, accountability, and source occurrence |
| `/tuning` with non-empty `id` | `tune-detail-preview-summary` | `metrics` | Bounded historical-preview measures |
| `/tuning` with non-empty `id` | `tune-detail-preview-matches` | `table` | Representative retained matches |
| `/tuning` with non-empty `id` | `tune-detail-lineage` | `timeline` | Immutable revision and supersession history |
| `/tuning` with non-empty `id` | `tune-detail-delivery-audit` | `timeline` | Delivery-authorization decisions |
| `/tuning` with non-empty `choose` and no `id` | `tune-occurrence-options` | `table` | Rule-first retained-occurrence chooser |
| `/tuning` with `host` and `ts`, but no `id`, `choose`, or `finding` | `tune-finding-options` | `table` | Exact-finding chooser |
| `/tuning` with `host`, `ts`, and `finding`, but no `id` or `choose` | `tune-builder-source` | `metrics` | Read-only retained-finding context |
| Same draft-builder request | `tune-builder-evidence` | `table` | Read-only retained matching conditions |
| `/rules` with non-empty `ruleView` | `rule-detail-summary` | `metrics` | Rule provenance and definition facts |
| `/rules` with non-empty `ruleView` | `rule-source-definition` | `text` | Source/provenance definition shown as text |
| `/rules` with non-empty `ruleView` | `rule-effective-definition` | `text` | Effective definition shown as text |
| `/rules` with non-empty `ruleView` | `rule-detail-occurrences` | `table` | Bounded exact occurrences |
| `/phishing` with non-empty `id` | `verdict` | `metrics` | Verdict, score, and report facts |
| Detection Tuning registry | `tune-recommendations` | `table` | Detection Rules Analyst candidates with `Artifact role`, `Detection`, `Host`, `Observed path`, `SHA-256`, `Why suggested`, `Coverage`, and action columns |
| `/phishing` with non-empty `id` | `reported-message` | `table` | Two-column `Field` / `Value` rows for `Reported`, `Organization`, `From → To`, `Subject`, `Received`, `Received email id`, `Thread token`, and `Shipped by` |
| `/phishing` with non-empty `id` | `signal-evidence`, `weights-legend`, `extracted-links`, `attachment-ledger` | `table` | Existing report-detail tables |
| `/phishing` with non-empty `id` | `passive-intel` | `metrics` | Passive cache/source results |
| `/phishing` with non-empty `id` | `message-body` | `table` or `text` | Message source displayed literally, never interpreted as markup |
| `/event` detail | `finding-context` | `table` or `metrics` | Why fired, rule background, checks, search pivot, and URL/domain context |
| `/event` detail | `event-evidence` | `table` | Field/value evidence ledger |
| `/access?atab=offboarding&id=…` | `offboarding-summary` | `table` or `metrics` | `Run at`, `Identity`, `Reason`, `Surfaces`, `Within 24h`, and `Tool` |
| Same offboarding request | `per-surface-breakdown` | `table` | Surface/class/count summary |
| Same offboarding request | `per-surface-item-detail` | `table` | Flattened `Surface`, `Ref`, `Action`, `Note / instruction` child rows |
| `/ip?addr=…` | `shodan` | `table` | Two-column result rows for Organisation, ASN, Location, ports, hostnames, tags, banner-inferred CVEs, and last-seen time |
| `/ip?addr=…` | `alienvault-otx` | `table` | Pulse count, tags, bounded pulse list, and checked time |

Metric labels are unique, case-sensitive presentation keys within these
specialized slots. The catalog's labels document the preferred vocabulary;
extra metric items remain visible rather than being silently dropped. For
`message-body`, a table's first cell labels the body part and the remaining cells
are displayed as literal source lines. A `text` panel displays one literal source
block.

For example, a branch-aware provider can return server-reduced values without
introducing any command surface:

```js
if (request.route === "/rules" && request.query.ruleView) {
  return {
    schemaVersion: "1",
    route: "/rules",
    state: "ready",
    title: "Detection Rules",
    panels: [
      {
        id: "rule-detail-summary",
        type: "metrics",
        title: "Rule definition",
        items: projectAuthorizedRuleFacts(request.query)
      },
      {
        id: "rule-source-definition",
        type: "text",
        title: "Source / provenance definition",
        body: projectAuthorizedDefinitionText(request.query)
      }
    ]
  };
}
```

Both projection functions in this example belong to the adopter and must return
only already-authorized, browser-safe presentation values. Matching a slot never
enables the disabled lifecycle, revision, chooser, or builder controls and does
not create a command protocol.

### Page states

| State | Use |
| --- | --- |
| `loading` | A deliberate interim projection when a host/provider supplies one; do not present stale values as current |
| `ready` | The route was authorized and its intended presentation is available |
| `empty` | The request succeeded but has no records or configured content |
| `error` | An unexpected failure represented with safe operator-facing copy |
| `unavailable` | A known dependency or capability is temporarily unavailable |
| `forbidden` | The session is known but may not read the requested route/resource |

Do not use `empty` to conceal an error or `forbidden` response. Do not include
stack traces, raw upstream errors, query text, internal locations, or policy
details in an error panel. Authentication expiry usually belongs to the host's
session flow rather than a fabricated `forbidden` page.

## Panel schemas

Every panel contains `id` and `type`. Only the fields listed for its type are
accepted.

### Notice

```js
{
  id: "data-boundary",
  type: "notice",
  title: "Authorized projection",
  body: "Values are reduced to the fields required by this page.",
  tone: "info"
}
```

- `title`: required, 1–200 characters
- `body`: required, 1–2,000 characters
- `tone`: optional; defaults to `info`

### Metrics

```js
{
  id: "metrics-slot",
  type: "metrics",
  title: "Metrics",
  description: "The adopter supplies authorized metric items.",
  items: []
}
```

- Optional `title` (up to 200) and `description` (up to 1,000)
- `items`: required array, at most 32 entries
- Each item has a required `label` (up to 120) that is unique within the panel,
  string `value` (up to 200) or a finite-number `value`, optional `detail` (up to
  300), and optional `tone` (default `neutral`)

### Table

```js
{
  id: "table-slot",
  type: "table",
  title: "Records",
  caption: "Authorized records in the selected scope",
  columns: [
    { key: "record", label: "Record", align: "left" }
  ],
  rows: []
}
```

- Optional `title` (up to 200) and `description` (up to 1,000)
- Required `caption` (up to 300)
- `columns`: 1–30 entries with unique identifier `key`, required `label` (up
  to 120), and optional `align` of `left`, `center`, or `right`
- `rows`: at most 200; each row must have exactly one cell per column
- Optional `disclosures`: exactly one entry for every row. Each entry is `null`
  or an object with optional `label` and one to eight `{ label, text }` items.
  Text is rendered as text. The Expected Sources slot uses the active `?`
  expander for `What it does`, `Why it matters`, and `If it goes quiet`; the
  health-drill slot nests `How to drill` under the drill signature.

Two hundred rows is a rendering bound, not a recommendation to discard data.
Use server-side pagination, cursoring, or aggregation and state the result
window to the operator.

### Timeline

```js
{
  id: "timeline-slot",
  type: "timeline",
  title: "Timeline",
  items: []
}
```

- Optional `title` (up to 200) and `description` (up to 1,000)
- `items`: at most 100
- Each item has RFC 3339 `at`, `label` (up to 300), optional `detail` (up to
  1,000), and optional `tone` (default `neutral`)

### Bars

```js
{
  id: "bars-slot",
  type: "bars",
  title: "Series",
  description: "The adopter supplies authorized values.",
  items: []
}
```

- Optional `title` (up to 200) and `description` (up to 1,000)
- `items`: at most 100
- Each item has `label` (up to 120), finite numeric `value`, optional finite
  `max` (default 100), and optional `tone` (default `info`)
- Values must satisfy `0 <= value <= max` and `max > 0`

### Stacked time-series chart

```js
{
  id: "events-collected-per-hour",
  type: "chart",
  title: "Events collected per hour",
  unit: "events",
  buckets: ["2026-08-29T10:00:00Z", "2026-08-29T11:00:00Z"],
  series: [
    { label: "security", values: [12, 9] },
    { label: "firewall", values: [31, 27] }
  ]
}
```

- Optional `title` (up to 200), `description` (up to 1,000), and `unit` (up to 40)
- `buckets`: at most 336 strictly increasing RFC 3339 date-times
- `series`: at most 32 uniquely labeled series; every `values` array has exactly
  one finite non-negative number per bucket; optional `tone` defaults to `neutral`
- The renderer uses the active product's fixed eight-color, color-blind-aware
  categorical palette without cycling. Extra categorical series render in the
  active grey fallback and trigger a visible warning. `critical`, `high`, and
  `info` labels (or `bad`, `warn`, and `info` tones) use the product severity
  colors. A literal data table accompanies every populated chart.

### Text

```js
{
  id: "review-notes",
  type: "text",
  title: "Review notes",
  body: "Plain text only.",
  tone: "neutral"
}
```

- Optional `title` (up to 200)
- Required `body` (up to 4,000)
- Optional `tone` (default `neutral`)

Text panels are not Markdown or HTML. If an adopter needs structured documents,
define a separate safe AST contract and renderer; never pass through upstream
markup.

### Empty

```js
{
  id: "no-findings",
  type: "empty",
  title: "No findings",
  body: "No findings matched the selected scope."
}
```

- Required `title` (up to 200)
- Required `body` (up to 2,000)

## Table cell values

A table cell may be `null`, a string, a Boolean, a finite number, or one of the
following typed objects:

| Type | Fields |
| --- | --- |
| `text` | Required non-empty `text`, at most 1,000 characters |
| `number` | Required finite `value`; optional `unit`, at most 32 characters |
| `badge` | Required `label`, at most 80 characters; optional `tone`, default `neutral` |
| `time` | Required RFC 3339 `value`; optional operator-facing `display`, at most 100 characters |
| `link` | Required `label` and normalized internal `route`; optional query object with at most 20 string entries, 64-character keys, and 256-character values |

Prefer typed cells when semantics affect rendering or accessibility. Primitive
string cells are accepted up to 2,000 characters; tighter server-side output
limits are still recommended for the meaning and layout of each column.
`link` is deliberately limited to same-console hash navigation assembled by the
renderer. It cannot express an external origin, fragment, callback, JavaScript
URL, form action, or mutation. External references and every write remain a
separately reviewed application concern.

## Lifecycle

The expected read lifecycle is:

```text
host defines public config and optional provider global
        |
scripts validate config and install contract/runtime
        |
bootstrap resolves and validates the provider
        |
application mount -> readPage(reason: initial)
        |
navigation/refresh -> validate request -> readPage
        |
validate envelope against requested route -> render text/data nodes
        |
application unmount -> invalidate results -> provider.dispose(), when supplied
```

While an injected provider is mounted, the controller performs a refresh read
every 300,000 milliseconds (five minutes); the manual refresh control triggers
the same `reason: "refresh"` lifecycle immediately. The adapter-absent baseline
does not start an interval. Providers must budget, cache, authorize, and
bound every refresh as a real read rather than assuming the UI timer makes it
safe or inexpensive.

A provider should:

- be deterministic for the same authorized request or communicate freshness
  through `updatedAt`;
- tolerate a route change while a previous promise is pending;
- never allow a late response for route A to replace the visible route B;
- map known denial and dependency conditions to explicit page states;
- reject unknown routes and query values instead of defaulting to broader data;
- release provider-owned subscriptions, timers, and resources in `dispose`.

Version 1 deliberately keeps the request data-only and does not include an
`AbortSignal`. The application uses sequence/abort guards to ignore a response
that became stale after navigation or unmount; this does not necessarily stop
the provider's underlying work. A networked provider may implement cancellation
inside its own client/closure and use `dispose` for final cleanup, but it must
not add a signal or callback field to a version-1 request.

Unmount is terminal for a controller with an injected provider, whether or not
that provider implements `dispose`. The controller invokes `dispose` at most
once when it exists. Create a new provider/controller pair to mount again; do
not reuse a disposed provider instance.

The console validates returned envelopes, but the provider and its server must
validate upstream input before building them.

## Bootstrap and mounting

The default config names `SOC_CONSOLE_ADAPTER` as the page-provider global and
`SOC_CONSOLE_CONNECTORS` as the separate connector-provider global.
`public/bootstrap.js` resolves and validates both, plus the auth integration,
creates the console in `#content`, and immediately exposes its controller as:

```js
window.SocConsoleApp
```

Mount completion is exposed separately as `window.SocConsoleAppReady`, a promise
that fulfills with the same controller or rejects when initial session/page
resolution fails. This lets a host inspect or unmount the controller even while
an integration read is pending.

Without an injected provider, the application takes the adapter-absent catalog
path and renders no records on any of the 36 known SOC routes; it does not
synthesize or validate an empty envelope. The local `/docs` utility instead
renders its checked-in generated manual and does not change provider state.
`createEmptyProvider()` and the checked-in provider template remain explicit
options for adopters that want provider-state semantics. To inject a provider,
define its global before bootstrap executes. To embed the application in a
host-controlled lifecycle, omit the default bootstrap script and use the
application factory documented in
[ARCHITECTURE.md](ARCHITECTURE.md) after the config, page/auth contract, UI
catalog, and application scripts have loaded.

## Failure handling

Contract functions throw `TypeError` for invalid local objects. A production
host should log a correlation identifier to a protected diagnostic service and
show safe, actionable page copy. It must not insert the thrown value, upstream
response body, or stack trace into the DOM.

Recommended mapping:

| Condition | Page result |
| --- | --- |
| Valid request, no matching records | `empty` |
| Valid session lacks resource permission | `forbidden` |
| Known dependency outage or timeout | `unavailable` |
| Invalid provider output or unexpected exception | safe `error` page plus protected diagnostic event |
| Unsupported route | not-found route state, not Overview |
| Contract version mismatch | `unavailable`/upgrade-required state; never best-effort coercion |

## Versioning policy

Version `"1"` is exact, not a semver range. Because validators reject unknown
keys, adding a field to a version-1 object is breaking for a version-1 consumer.
Contract evolution therefore requires:

1. a new schema/runtime version;
2. compatibility contract documents for old and new producers;
3. an explicit UI/API deployment order;
4. a rollback path that preserves the last compatible pair;
5. removal only after all producers and cached clients have aged out.

Do not infer a contract from the DOM or CSS. The versioned request and envelope
are the integration surface.

## Security boundary

Validation prevents several accidental rendering hazards, but it does not make
data trustworthy. A conforming provider can still disclose data the operator
should not see. Enforce authentication, authorization, classification,
redaction, query bounds, rate limits, audit, and retention before constructing
an envelope.

The strict `npm run audit:public` policy proves that checked-in public JavaScript
does not install browser networking, persistence, upload, telemetry, or command
providers on its own. It has no relaxed “application” profile. The checked-in
`application-bridge.js` is inert; the optional loopback workbench or an adopter
host serves the actual bridge under a separately reviewed policy. Keep a
production operational provider behind the adopter's authenticated BFF and
independently review that downstream boundary.
