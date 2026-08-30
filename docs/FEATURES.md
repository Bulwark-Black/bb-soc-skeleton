# Feature and route catalog

The interface skeleton registers all 38 active SOC paths: 29 primary routes and
nine linked detail/utility routes. It also exposes one shell-owned technical
documentation utility at `#/docs`. The invariant is **38 SOC routes plus one
local `/docs` utility**. SOC-route registration provides stable routing, product
labels, navigation relationships, titles, focus behavior, empty/error states,
and an adapter request boundary. It does not include records, counts, events,
identities, timestamps, findings, policies, evidence, or other page data.

An adopter supplies authorized content through the versioned adapter. Route
paths are stable integration keys; labels and summaries are presentation text.

The feature names, table schemas, filters, forms, and action labels below mirror
the active product's structural catalog. In static mode they contain no records
and perform no reads or mutations. The connector-control contract can activate
only the documented Onboarding and Sources lifecycle actions. A separately
validated administration contract can activate only its agent, prompt,
enrollment, attestation, and risk vocabulary on matching surfaces; every other
visible action label is an integration requirement requiring its own authorized
server workflow.

When an adopter injects version-1 page panels, a stable panel-ID match hydrates
the corresponding catalog slot. Unmatched panels appear in a distinct
**Additional authorized data** region. Titles, labels, and array positions are
never used for matching. This makes all read routes integrable without
pretending that the catalog's write/action controls have a versioned protocol.

## Global shell features

These product-level features surround every route and must be considered when
embedding the interface. They are present when the committed `public/index.html`
shell hooks are retained; a root-only `createApp` embed deliberately omits them
while keeping route content and tabs:

| Feature | Checked-in behavior | Adopter responsibility |
| --- | --- | --- |
| Brand/sidebar | Exact full mark, dark circuit field, deterministic pulses, six grouped areas, current-route state | Preserve assets/tokens and route semantics when product parity is required |
| Estate selector | Empty “No estate selected” structure with an Onboarding route link | Supply an authorized estate/scope model only through an explicitly designed host integration |
| Compact navigation | Responsive route selector preserves the grouped SOC entry surfaces without exposing detail routes as duplicates | Keep all 38 SOC routes usable at narrow widths and retain the shell Docs entry |
| Authentication chip | Shows the closed auth projection or an unauthenticated/optional state | Implement `SOC_CONSOLE_AUTH`; do not place raw identity claims or tokens in the shell |
| Page filter | Browser-local filtering of the current page's rendered, safe text | Do not reinterpret it as a server query or authorization filter |
| Search-anything command palette | `/` or Cmd/Ctrl-K opens IP/CVE/host/case/rule/page/log dispatch; Enter uses `#/search`; `g` plus `o/a/r/s/l/y/d/b/u/f/t/p` performs the active board jumps; `?` shows help | Resolve host/case selectors through an authorized `search-dispatch` page panel; never make route search an authorization oracle |
| Timezone/refresh controls | Browser display preference, manual controller refresh, and a 300,000-ms refresh interval only while an injected page provider is mounted | Decide server timestamp semantics, freshness, caching, load controls, and authorization for every refresh read |
| Settings and Onboarding entry points | Top-level shell controls reach the two hidden primary surfaces; connector-backed onboarding remains disabled until a validated control snapshot is available | Use the closed connector contract for app/host/source lifecycle; implement settings changes through a separate authenticated/authorized command contract |
| Agent Management entry point | Shell and Estate navigation reach `#/agents`; all controls remain disabled without a validated administration provider | Use only the closed agent/prompt/enrollment vocabulary and keep runner execution, prompt authorization, and credentials server-side |
| Technical documentation | The Docs control opens the local `#/docs` manual without calling the page, connector-control, or administration provider | Keep the public technical source accurate and regenerate its checked-in browser artifact when it changes |
| Connection/provider state | Explicitly reports page-adapter absence and independently fails connector-provider errors closed | Map provider/session failures honestly; never imply a live connection from presence of the shell |
| Breadcrumb/back context | Detail routes preserve understandable route context without becoming primary nav items | Validate every detail selector and safe return destination |
| Toast/notices | Accessible status regions with manual dismissal and reduced-motion behavior | Supply safe copy and explicit progress/success/denial/failure semantics for any downstream workflow |

The shell's route search, page filter, timezone preference, disclosures, and tab
selection are presentation interactions. They do not broaden provider
capabilities or authorize data.

## Primary routes

Twenty-seven primary routes appear in the six grouped navigation areas.
Onboarding and Settings are also primary, top-level surfaces, but are opened
through shell controls instead of appearing as sidebar destinations. Together
they make the 29 primary routes.

### Monitor

| Route | Structural surface | Provider responsibility |
| --- | --- | --- |
| `#/` | **Overview:** posture KPIs, collection-health ring/legend, control-readiness meters/facts, detections, register-overdue, and dated-obligation structures | Authorized posture, collection, readiness, finding, risk, and obligation projections |
| `#/health` | **SOC Health:** seven persistent health measures above Feeds, Rules never fired, What is firing, Drills (including per-row `How to drill` disclosures), and How to read this views | Safe component, feed, rule, drill, queue-persistence, and failure projections without unrestricted diagnostics |
| `#/brief` | **Daily Brief:** Do today, Security brief, and affected-review structures; Turnover has untouched, in-work, real-threat, recently dispositioned, retention, and affected-review sections; Analyst briefings links to the full Analyst Hub | Prioritized, scoped handoff and review models |
| `#/analytics` | **Analytics:** 24h/48h/7-day ranges with 48h default; collection/detection/history measures, true stacked hourly event/detection series using the exact active palette, ranked firing/blocked-address structures, and accessible data tables | Pre-aggregated series, ranges, measurement caveats, and accessible values through `chart`/`bars` panels |
| `#/timeline` | **Timeline:** application-supplied host selectors, 15m/1h/24h/7d ranges, and the unified When/Kind/Event view | Bounded event summaries with stable identifiers and RFC 3339 times |

### Respond

| Route | Structural surface | Provider responsibility |
| --- | --- | --- |
| `#/triage` | **Triage:** Queue, Awaiting approval, Cases, Closed, and All views; filters, alerts, bulk disposition, and guidance | Authorized findings, grouping, filters, ownership, and separately authorized commands |
| `#/tuning` | **Detection Tuning:** Definitions, Applied alerts, and Matched but held views with definition status filters; query-selected tune detail, retained-occurrence and exact-finding choosers, read-only draft builder, and exact eight-column Detection Rules Analyst recommendation slot | Versioned definitions, occurrences, recommendations, safety state, and approval workflow; panel hydration never enables lifecycle controls |
| `#/rules` | **Detection Rules:** Palisade proposed/built-in/inline/custom rules, tested rule creation, recorded negative-space decisions, Sigma browse/import/subset guidance, YARA status/browse/manage, the deliberate Snort boundary, the embedded Tune registry, and stable read-only definition-detail slots | Rule metadata, provenance, source/effective definition text, scope, lifecycle, occurrence, and change-control state |
| `#/alerts` | **Alert Comms:** exact reachability/delivery/overflow status, Who gets paged, Delivery log, and per-attempt Reconciliation views | Redacted delivery/recipient models and separately authorized send/retry/confirmation commands |
| `#/honeypots` | **Honeypots:** tamper decoys, read/tamper canaries plus the system canary, estate-wide trap usernames, Trip log, and Clerk honey-account setup/proof views | Minimal inventory and trip projections; no control-plane credentials in the browser |
| `#/phishing` | **Phishing:** queue metrics/report list without `id`; verdict, reported message, signal evidence, weights legend, extracted links, attachments, passive intel, and literal message-source body for non-empty `id`; detail sections expose stable metrics/table/text slots | Redacted message metadata and safe evidence/link/attachment projections; message source is never rendered as markup |

### Investigate

| Route | Structural surface | Provider responsibility |
| --- | --- | --- |
| `#/logs` | **Security Logs:** Splunk-shaped query bar, relative/absolute time controls, host/index selectors, display highlighting, full syntax reference, raw-firewall reading guide, all 16 click-to-run query shortcuts, sort chain, scan state, event rows, and query-driven `stats count` aggregate structures | Server-enforced scope, bounded windows, pagination, aggregation, and field redaction |
| `#/activity` | **Activity Baseline:** go-live/relearn control, maturity state, first-seen, elevated, trending, long-tail, normal, and methodology structures | Privacy-governed behavior summaries, states, epochs, and methodology |
| `#/ioc` | **IOC Parser:** “Paste anything” extraction/hunt input and Type/Indicator/Environment/Intel result structure | Size-limited parsing/enrichment with all submitted content treated as untrusted |
| `#/intel` | **Threat Intel:** Bulwark Black, OTX, ThreatFox, URLhaus, MalwareBazaar, and all-feed views with kind filtering; BB lookup/list/filter/page branches; OTX lookup/sync/freshness branches; per-source status surfaces; separate OTX outbound-destination and recent-pulse tables | Approved intelligence summaries, source health/freshness, confidence, attribution, and distribution controls |
| `#/known-ips` | **Known IPs:** operator egress, tailnet, estate, and manual registries sharing the active six-column schema, plus the two-field add-address and detection-use structures | Address classes, ownership, expiry, provenance, and review history |

### Vuln Mgmt

| Route | Structural surface | Provider responsibility |
| --- | --- | --- |
| `#/scans` | **Scans:** Trivy, Patch first, File integrity, End of life, External surface plus sweep history, IOC scan, watched/on-demand urlscan.io surfaces, Dependencies, DLP Upload AV plus recent events, active/deleted Quarantine ledgers, and an inline Remediation log view | Normalized scan, exploitation, integrity, EOL, exposure, dependency, and review models |
| `#/remediation` | **Remediation:** latest VM review, the exact six-field append-only remediation form, and remediation record cards | Authorized remediation records, evidence references, future-concern state, and commands |

### Estate

| Route | Structural surface | Provider responsibility |
| --- | --- | --- |
| `#/systems` | **Systems:** Estate opens with external attack surface, inventory, known-exploited/software-match structures, and the `What am I looking at?` disclosure; Are we affected? contains latest-review, open-item, and methodology surfaces | Scoped asset, outside-in exposure, vulnerability lead, and advisory-review projections with canonical IDs and freshness |
| `#/databases` | **Databases:** exact schema-watch and schema-change tables followed by adding-database and methodology panels | Structural inventory and change projections with records and connection fields removed |
| `#/backups` | **Backups:** backup-chain push state, independent bucket pull verification, off-box evidence receipts, adding-chain guidance, and the two-side rationale | Backup-control summaries and evidence references, never storage credentials or environment endpoints |
| `#/retention` | **Retention:** declared-policy fact table plus enforcement gap; measured-policy/inventory/store/disk measures, measured horizon, eight-column per-source table, and archived baselines; latest analyst review and methodology | Approved declarations, measured horizon, enforcement state, and review models without publishing the active environment's periods, dates, or measurements |
| `#/sources` | **Sources:** `Sources — Dead-man Board` has the seven-column Expected sources rows plus active `?` disclosures (`What it does`, `Why it matters`, `If it goes quiet`); `Sources — Add` selects a registered app/host and installed connector/source kind, renders manifest-owned non-secret configuration and credential-reference slots, then shows staged and active sources; `Sources — Registry Changes` has the five-column ledger | Supply the validated control snapshot and authorize `host.enroll`, `source.setup`, `source.test`, and `source.activate`; project source inventory, health, and records into stable page-panel IDs. Arbitrary kinds and user-selected searchability are not supported |
| `#/agents` | **Agent Management:** Agents, Add Agent, Prompts, Enrollment, and History tabs with safe lifecycle/capability metadata, separately authorized prompt-body reads, one-time enrollment output, pause/resume, archive/restore/remove, and audit views | Supply the validated `agents` administration snapshot plus `getPrompt`/closed command results; keep execution, authorization, prompt privacy, enrollment proof, service credentials, and production persistence server-side |

### Govern

| Route | Structural surface | Provider responsibility |
| --- | --- | --- |
| `#/attestations` | **Attestations:** Active, Add Attestation, Archived, and History tabs with authoritative lifecycle rows and links to detail | Supply the governance snapshot and authorize the exact `attestation.*` create/update/transition/archive/restore/remove commands; production evidence/approval/retention policy remains server-owned |
| `#/register` | **Risk Register:** Active, Add Risk, Archived, and History tabs with likelihood/impact, owner/review state, and links to detail | Supply the governance snapshot and authorize exact `risk.*` commands; richer scope, treatment, evidence, approvals, dependencies, and retention remain production extensions |
| `#/access` | **Access:** Who includes current-identity, owners, visitor, identity-model, device, and auditor-access panels with the active table schemas; Refusals and Chain preserve their evidence tables; Offboarding has six summary measures and its run list, while non-empty `id` selects six fixed header facts, manual steps, per-surface summary, and flattened child item detail; How to use retains the guide surface | Entitlement projections and audited, resource-specific certification decisions |

### Shell utilities

| Route | Structural surface | Provider responsibility |
| --- | --- | --- |
| `#/onboard` | **Onboarding:** numbered register-app and connect-each-host stages plus the per-app Host/Enrollment/Connection structure; a validated connector provider enables `app.register` and host token minting | Authenticate/authorize each command, enforce server-side validation, return one-time enrollment material only on issuance, store only a digest/reference, and require a real connection proof |
| `#/settings` | **Settings:** How settings behave plus the full board sequence: Overview, SOC Health, Daily Brief, Analytics, Analyst, Triage, Rules, Alert Comms, Honeypots, Logs, Activity, IOC Parser, Threat Intel, Known IPs, Systems, Scans, Databases, Backups, Retention, Sources, Attestations, Risk Register, and Access; only boards with real settings expose disabled field rows | Public display settings and separately protected administrative configuration; values and defaults remain application-owned |

### Local technical documentation utility

`#/docs` is a shell-owned, hidden catalog entry reached through the Docs
control. It is deliberately outside the 38 adapter-addressable SOC routes and
never calls page `readPage`, connector/administration `getSnapshot`,
administration `getPrompt`, or either `execute`. The page renders the
public-safe manual from [technical-reference.md](../public/technical-reference.md),
which `npm run build:docs` converts into the generated
[technical-docs.js](../public/technical-docs.js) browser artifact. Run
`npm run check:docs` to prove the generated artifact still exactly matches its
Markdown source.

The local page supplies a table of contents, chapter filtering, section links,
safe code blocks, and accessible tables. It is an implementation aid for human
adopters and agents, not a page model, control-plane snapshot, authorization
oracle, or source of operational state.

## Registered view and tab state

The following query keys are part of the checked-in structural catalog. Bold
values are defaults. Items marked “link” navigate to another registered route
instead of representing another data source. An adapter receives the selected
query as strings and must still allowlist and authorize it.

| Route | Query-backed views |
| --- | --- |
| `#/health` | `htab`: **`feeds`**, `rules`, `firing`, `drills`, `read` |
| `#/brief` | `btab`: **`brief`**, `turnover`; Analyst briefings links to `#/analyst` |
| `#/analyst` | `btab`: **`analyst`**; `atab`: **`briefings`**, `cases`, `rules`, `vuln`, `affected`, `retention`; Daily Brief/Turnover board link back to `#/brief` |
| `#/analytics` | `h`: `24`, **`48`**, `168` |
| `#/timeline` | `host`: application-validated host selector; `range`: `15m`, `1h`, **`24h`**, `7d` |
| `#/triage` | `view`: **`queue`**, `approvals`, `cases`, `closed`, `all` |
| `#/tuning` | `tview`: **`definitions`**, `applied`, `held`; for Definitions, standalone `status`: **`active`**, `draft`, `disabled` |
| `#/rules` | `rtab`: **`palisade`**, `sigma`, `yara`, `snort`, `tuning`; for Tune, `tview`: **`definitions`**, `applied`, `held` and Definitions retains nested `tstatus`: **`all`**, `active`, `draft`, `disabled`; for Palisade, `ptab`: **`active`**, `add`, `help`, `decisions`; for Sigma, `stab`: **`rules`**, `add`, `about`; for YARA, `ytab`: **`about`**, `rules`, `manage` |
| `#/alerts` | `atab`: **`path`**, `paged`, `log`, `reconcile` |
| `#/honeypots` | `htab`: **`decoys`**, `canaries`, `users`, `hits`, `clerk` |
| `#/logs` | `q`: bounded search or `| stats count [by field]`; `host`, `chan`, `all`, and a maximum-three-key `sort` chain; `from`/`to` are folded into canonical `earliest`/`latest` tokens |
| `#/search` | `q`: dispatches an IP, CVE, case reference, page keyword, or fallback log search; case/host resolution requires an authorized application index |
| `#/intel` | `itab`: **`bb`**, `otx`, `threatfox`, `urlhaus`, `malwarebazaar`, `feeds`; BB uses `q` for lookup and `list=ips|domains|all` with bounded `f` and `p`; OTX uses `oq`; for the three public-feed views, `skind`: **`all`**, `ip`, `domain`, `url`, `sha256`, `md5`, `sha1` |
| `#/ip` | `addr`: validated address selector for verdict, explicit Shodan/OTX states, related detections, and log events |
| `#/scans` | `tab`: **`trivy`**, `patch`, `fim`, `eol`, `exposure`, `ioc`, `urlscan`, `deps`, `av`, `quarantine`, `remediation`; the Remediation tab renders the same structure as `#/remediation` without leaving Scans |
| `#/systems` | `stab`: **`estate`**, `affected` |
| `#/retention` | `vtab`: **`policy`**, `reality`, `review` |
| `#/sources` | `stab`: **`expected`**, `add`, `changes` |
| `#/agents` | `atab`: **`agents`**, `add`, `prompts`, `enrollment`, `audit`; `agent` and `prompt` are application-validated stable selectors for management/detail within their matching tabs |
| `#/attestations` | `gtab`: **`active`**, `create`, `archived`, `history` |
| `#/register` | `riskTab`: **`active`**, `create`, `archived`, `history` |
| `#/access` | `atab`: **`who`**, `refusals`, `chain`, `offboarding`; for Offboarding, `oview`: **`records`**, `guide`; a non-empty `id` forces the Records state and selects the offboarding-detail structure |

Detection Tuning also preserves the active product's bounded branch contract:
`id` selects the tune-detail structure; `choose` opens the rule-occurrence
chooser; `host` plus `ts` opens the exact-finding chooser; adding `finding`
opens the draft-builder structure. Rules uses `ruleView` with an
application-validated `detectorSet` and `detectorId` to open its read-only
definition detail. The public renderer never prints these selectors as record
content. Selecting a parent or sibling tab clears stale descendant tab and
detail selectors; this includes Rules subviews and Access Offboarding's
`oview` state. The stable branch panel IDs and preferred data-only types are
listed in [ADAPTER-CONTRACT.md](ADAPTER-CONTRACT.md#specialized-query-branch-slots).

Routes not listed here have no catalog-defined tab query. Their route/detail
selectors may still use documented, bounded query values supplied by the host.
Unknown or malformed keys are never proof of permission.

## Detail and utility routes

These nine routes are registered and adapter-addressable but are normally
reached from a primary page rather than repeated as sidebar destinations.

| Route | Parent surface | Structural purpose | Expected query context |
| --- | --- | --- | --- |
| `#/analyst` | Daily Brief | **Analyst Briefings:** estate briefing/history plus case, rule, vulnerability, affected-product, and retention analyst views | Selected briefing, domain, or review view |
| `#/event` | Triage | **Event Detail:** decision/finding state, fixed Why fired / Rule background / What to check / Search pivot / URL-domain context, evidence, associated logs, analyst findings, disposition, notes/uploads, and related-detection structures | Stable event/finding reference and safe back context |
| `#/ip` | Logs, IOC Parser, Known IPs | **IP Investigation:** verdict/activity/external-link summary; exact Shodan Organisation/ASN/location/ports/hostnames/tags/CVE/last-seen fields; OTX pulse/tag/list structure; related detections; and log events | Validated address selector |
| `#/search` | Investigation shell | **Search dispatcher:** selects IP, CVE, case, host/page, or fallback Logs destinations without inventing a second results surface | Bounded query and application-authorized case/host resolution |
| `#/host-scan` | Scans | **Scan Detail:** CVE/package/severity/exploited/EPSS structure | Canonical system reference |
| `#/kev` | Scans, Systems | **KEV Detail:** Known Exploited Vulnerability structure | Validated vulnerability identifier |
| `#/source` | Sources, Backups, Databases | **Source Detail:** declaration facts, latest collection/readiness facts, and a source-kind-sensitive Recent events or Recent pushes panel | Canonical system and source-kind references |
| `#/attestation` | Attestations | **Attestation Detail:** authoritative title, state, owner, due time, revision, lifecycle actions, and safe metadata | Stable attestation reference |
| `#/risk` | Risk Register | **Risk Detail:** authoritative title, status, likelihood/impact, owner, review time, lifecycle actions, and safe revision metadata | Stable risk reference |

Query values are untrusted navigation inputs. The adapter and application
server must allowlist supported keys/values and enforce operator scope. A detail
route is not authorization to read the referenced resource.

## Cross-route interface contracts

### Navigation and routing

- The adapter-addressable SOC route set contains exactly 38 paths.
- The shell catalog contains those 38 SOC routes plus one local `/docs`
  utility; `#/docs` never reaches a page, connector-control, or administration
  provider.
- Twenty-seven primary paths populate the six grouped navigation areas.
- `#/onboard` and `#/settings` remain primary surfaces reached through shell
  controls rather than sidebar destinations.
- Detail/utility paths remain directly addressable and can receive page models.
- The selected route is reflected in the URL, page title, navigation state, and
  focus behavior.
- Unknown paths render a not-found state; they are not represented as Overview.
- Page titles follow the product pattern `bulwark>soc · Page`.

### Adapter states and presentation primitives

- Without an injected adapter, every known SOC route renders an honest empty
  skeleton state. The local `/docs` utility renders its checked-in public
  technical manual independently of adapter state.
- An adapter can return `loading`, `ready`, `empty`, `error`, `unavailable`, or
  `forbidden` page states.
- Version 1 supports data-only notice, metrics, table, timeline, bars, stacked
  time-series chart, text, and empty panels plus typed text, number, badge, time,
  and internal-route link table cells. Tables may carry bounded text-only row
  disclosures for source guidance and drill instructions.
- Provider content is assigned to safe DOM text/attributes; arbitrary adapter
  markup and executable values are rejected.
- Tables, time values, charts, and state treatments retain their semantic and
  accessible equivalents when an adopter supplies them.

### Browser authentication integration

- The browser can resolve a validated `SOC_CONSOLE_AUTH` integration object.
- The integration exposes a closed session projection and login/logout entry
  points without exposing OIDC tokens, cookies, raw claims, or subject/session
  identifiers.
- `auth.required: true` gates page rendering when authentication integration is
  absent or its session is unauthenticated.
- The application-owned server/BFF performs OIDC, token validation, session
  storage, CSRF protection, and authorization. See
  [AUTHENTICATION.md](AUTHENTICATION.md).

### Connector-control and ingest integration

- The browser can resolve a validated `SOC_CONSOLE_CONNECTORS` provider with
  `getSnapshot`, `execute`, and optional `dispose` methods.
- Its command vocabulary is exactly `app.register`, `host.enroll`,
  `source.setup`, `source.test`, and `source.activate`; it does not activate
  unrelated product forms or actions.
- Installed manifests own connector types, source kinds, configuration fields,
  credential-reference slots, canonical outputs, page targets, and health
  policy. The UI cannot invent a kind or toggle searchability.
- Stable `appId`, `hostId`, `connectorInstanceId`, and `sourceId` values preserve
  identity and allow multiple same-kind sources on one host.
- Canonical records populate screens through page-envelope projectors. MCP may
  optionally mirror administrative commands through the same service, but it
  is never a telemetry or plaintext-secret transport.
- The loopback reference workbench proves only one `log.event` push path into
  Overview, Sources, Logs, Analytics, and SOC Health. All other connector kinds
  and acquisition modes remain adopter implementations.

See [CONNECTORS.md](CONNECTORS.md).

### Data-free baseline

- No SOC route contains a built-in record, count, identity, timestamp, event,
  finding, system, policy, evidence item, or operational verdict.
- The local `/docs` utility contains public implementation prose and
  placeholder examples only; it contains no operational page data.
- Empty route structure is not a loading success and is not presented as live
  system state.
- The checked-in empty provider template declares commands, uploads,
  subscriptions, and persistence unavailable; bootstrap does not install that
  template implicitly.
- Controls are structural and inert until a matching provider is installed.
  The connector provider enables only its five source-management commands. An
  independently validated administration provider enables only its closed
  agent/prompt/enrollment/attestation/risk commands on matching management
  surfaces.

## Human operating and population guide

The in-app technical manual contains the detailed, human-readable purpose,
inputs, population path, mutation ownership, archive/removal policy, and honest
no-source state for every category and subcategory:

- Monitor: Overview, SOC Health, Daily Brief, Analytics, and Timeline in
  [chapter 39](../public/technical-reference.md#39-human-operating-guide-monitor);
- Respond: Triage, Detection Tuning, Rules, Alert Comms, Honeypots, and Phishing
  in [chapter 40](../public/technical-reference.md#40-human-operating-guide-respond);
- Investigate: Security Logs, Activity Baseline, IOC Parser, Threat Intel, and
  Known IPs in [chapter 41](../public/technical-reference.md#41-human-operating-guide-investigate);
- Vulnerability Management: every Scans tab and Remediation in
  [chapter 42](../public/technical-reference.md#42-human-operating-guide-vulnerability-management)
  and the connector matrix in
  [chapter 46](../public/technical-reference.md#46-scan-by-scan-connection-and-projection-matrix);
- Estate: Systems, Databases, Backups, Retention, Sources, and Agent Management in
  [chapter 43](../public/technical-reference.md#43-human-operating-guide-estate);
- Govern: Attestations, Risk Register, and Access
  in [chapter 44](../public/technical-reference.md#44-human-operating-guide-govern);
  and
- Onboarding, Settings, Technical Docs, and every linked detail/utility route in
  [chapter 45](../public/technical-reference.md#45-human-operating-guide-shell-and-linked-routes).

The common rule is that page envelopes populate authorized reads, while records
are added/updated/transitioned/archived/removed only through their owning
versioned command service. An empty authorized projection means no matching
records; provider absence/unavailability/forbidden state remains explicit. A
blank table or zero-row result must never be interpreted as connected, healthy,
compliant, or risk-free.

## Capability ownership

| Capability | Skeleton owns | Adopter owns |
| --- | --- | --- |
| Thirty-eight adapter-addressable SOC routes plus one local `/docs` utility and navigation relationships | Yes | Optional intentional extension; keep `/docs` outside provider/control routing |
| Exact default product styling and brand assets | Yes | Asset hosting and approved brand changes |
| Versioned request/envelope/session validation | Yes | Producing authorized valid models/session projections |
| Versioned connector manifest/snapshot/command validation | Yes | Authenticated service, manifest installation, authorization, and production persistence |
| Versioned agent/governance administration validation | Browser contract | Authenticated service, authorization, durable state/audit, evidence policy, and production secret custody |
| Canonical record and ingest-batch validation | Yes | Transport authentication, normalization, durable admission, and projectors |
| Empty and failure-state rendering | Yes | Operational status and recovery behavior |
| Page data and records | No | Yes |
| OIDC protocol, tokens, server session, and CSRF controls | No | Yes |
| Authentication integration object | Browser contract only | Secure BFF implementation |
| Resource/action authorization | No | Yes |
| Collection, search, storage, and retention | Reference slice only | Production implementation |
| Source onboarding commands | Browser contract and loopback reference only | Production authorization, durability, secrets, and audit |
| Agent, prompt, enrollment, attestation, and risk lifecycle commands | Browser contract and local reference modules where explicitly started | Production authorization, prompt/evidence privacy, dependencies, durability, secrets, and audit |
| Agent-readable MCP resources and five fixed control tools | Narrow stdio reference only; credential issuance, URLs, shell, telemetry, and secrets refused | Production service identity, private TLS, RBAC, approval, audit, availability, and operations |
| Other commands, approvals, uploads, and audit trail | No | Yes |
| Email, chat, ticketing, scanner, SIEM, cloud, or estate integrations | No | Yes |
| Production availability, recovery, privacy, and incident response | No | Yes |
