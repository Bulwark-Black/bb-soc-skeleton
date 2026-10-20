# Feature and route catalog

The shell registers 48 paths: 38 original adapter-addressable SOC routes, eight
private Operations/report pages, Documents and Technical Docs. Operations adds
Infrastructure, Services, Websites, Metrics, Incidents, Critical jobs, AI Employees
and Analyst reports. These pages use the dedicated private monitoring API rather
than canonical page envelopes. See [NATIVE-OPERATIONS.md](NATIVE-OPERATIONS.md)
for the deployed-runtime port, configuration and current boundaries. No records,
inventory, prompts or credentials are seeded.

The private application projects accepted records and registered state through
the versioned adapter and dedicated APIs. Custom hosts can supply their own
authorized models. Route paths are stable integration keys; labels and summaries
are presentation text.

The feature names, table schemas, filters, forms, and action labels below mirror
the active product's structural catalog. In static mode they contain no records
and perform no reads or mutations. The connector-control contract can activate
only the documented Onboarding and Sources lifecycle actions. A separately
validated administration contract can activate only its agent, prompt,
enrollment, attestation, and risk vocabulary on matching surfaces. Separate
private APIs implement document management, Operations, native Triage, scoped service access,
source import/setup, rule policy and mail controls. Other structural action labels
still need an authorized server workflow; neither imported facts nor page-panel
hydration enable them. The working Documents API does not activate attachment
controls elsewhere in the catalog.

`npm start` now installs the private Better Auth application and these shipped
source, administration, document, scoped service-access, Trivy import, native
monitoring/job/inbox, native Triage decisions/proposals, opt-in detection and reviewed notification workflows. `npm run start:static` preserves the dependency-free empty preview.
The eleven legacy scanner setup templates remain non-executing; the separate
private `trivy-report` importer processes reports but never runs a scanner.
An Agent Management record is not a running agent, and a service credential
authorizes only its granted API operations, not arbitrary agent execution.

Universal/custom canonical sources now support all 29 record kinds. In the
private app, Sources → Integrations manages immutable custom definitions and
shows actual route coverage; Sources → Received observations provides bounded
application/source/kind/time filtering, reported severity and payload inspection. Relevant category
pages display explicitly read-only imported facts. These fallback observation
views replace unsupported native workflow placeholders for that read; they do
not turn imported facts into native workflow authority. The separate bounded
detection engine evaluates opt-in original rules and reviewed JSON predicates;
it is not a general Sigma/YARA/Snort runtime or universal vendor analysis engine.
The static shell and adopter-supplied specialized page contracts remain intact.
See [the integration review](INTEGRATION-REVIEW.md) for exact boundaries.

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
| Brand/sidebar | Exact full mark, dark circuit field, deterministic pulses, seven grouped areas, current-route state | Preserve assets/tokens and route semantics when product parity is required |
| Estate selector | Empty “No estate selected” structure with an Onboarding route link | Supply an authorized estate/scope model only through an explicitly designed host integration |
| Compact navigation | Responsive route selector preserves the grouped SOC entry surfaces without exposing detail routes as duplicates | Keep all registered routes usable at narrow widths and retain the shell Docs entry |
| Authentication chip | Shows the closed auth projection; the private starter supplies Better Auth sign-in and sessions | Review deployment policy; custom hosts implement `SOC_CONSOLE_AUTH`; never place raw identity claims or tokens in the shell |
| Page filter | Browser-local filtering of the current page's rendered, safe text | Do not reinterpret it as a server query or authorization filter |
| Search-anything command palette | `/` or Cmd/Ctrl-K opens IP/CVE/host/case/rule/page/log dispatch; Enter uses `#/search`; `g` plus `o/a/r/s/l/y/d/b/u/f/t/p` performs the active board jumps; `?` shows help | Resolve host/case selectors through an authorized `search-dispatch` page panel; never make route search an authorization oracle |
| Timezone/refresh controls | Browser display preference, manual controller refresh, and a 300,000-ms refresh interval only while an injected page provider is mounted | Decide server timestamp semantics, freshness, caching, load controls, and authorization for every refresh read |
| Settings and Onboarding entry points | Top-level shell controls reach the two hidden primary surfaces; connector-backed onboarding remains disabled until a validated control snapshot is available | Use the closed connector contract for app/host/source lifecycle; implement settings changes through a separate authenticated/authorized command contract |
| Agent Management entry point | Shell and Estate navigation reach `#/agents`; registration/prompt controls require a validated administration provider; Service Access uses its separate private authenticated API | Use only the closed agent/prompt/enrollment vocabulary and keep runner execution, prompt authorization, and credential custody server-side |
| Technical documentation | The Docs control opens the local `#/docs` manual without calling the page, connector-control, or administration provider | Keep the public technical source accurate and regenerate its checked-in browser artifact when it changes |
| Connection/provider state | Explicitly reports page-adapter absence and independently fails connector-provider errors closed | Map provider/session failures honestly; never imply a live connection from presence of the shell |
| Breadcrumb/back context | Detail routes preserve understandable route context without becoming primary nav items | Validate every detail selector and safe return destination |
| Toast/notices | Accessible status regions with manual dismissal and reduced-motion behavior | Supply safe copy and explicit progress/success/denial/failure semantics for any downstream workflow |

The shell's route search, page filter, timezone preference, disclosures, and tab
selection are presentation interactions. They do not broaden provider
capabilities or authorize data.

## Primary routes

Thirty-five SOC primary routes appear in seven navigation groups,
alongside the local Documents page in Govern.
Onboarding and Settings are also primary, top-level surfaces, but are opened
through shell controls instead of appearing as sidebar destinations. Together
they make 37 SOC primary routes (38 primary destinations when Documents is
included). The eight Operations/report pages are included in those totals.

### Monitor

| Route | Structural surface | Provider responsibility |
| --- | --- | --- |
| `#/` | **Overview:** posture KPIs, collection-health ring/legend, control-readiness meters/facts, detections, register-overdue, and dated-obligation structures | Authorized posture, collection, readiness, finding, risk, and obligation projections |
| `#/health` | **SOC Health:** seven persistent health measures above Feeds, Rules never fired, What is firing, Drills (including per-row `How to drill` disclosures), and How to read this views | Safe component, feed, rule, drill, queue-persistence, and failure projections without unrestricted diagnostics |
| `#/brief` | **Daily Brief:** Do today, Security brief, and affected-review structures; Turnover has untouched, in-work, real-threat, recently dispositioned, retention, and affected-review sections; Analyst briefings links to the full Analyst Hub | Prioritized, scoped handoff and review models |
| `#/analytics` | **Analytics:** 24h/48h/7-day ranges with 48h default; collection/detection/history measures, true stacked hourly event/detection series using the exact active palette, ranked firing/blocked-address structures, and accessible data tables | Pre-aggregated series, ranges, measurement caveats, and accessible values through `chart`/`bars` panels |
| `#/timeline` | **Timeline:** application-supplied host selectors, 15m/1h/24h/7d ranges, and the unified When/Kind/Event view | Bounded event summaries with stable identifiers and RFC 3339 times |

### Operations

These eight pages use the shipped private API. They require reviewed inventory
and real collector or runner observations; no host, job or employee is seeded.

| Route | Working private surface | Adopter responsibility |
| --- | --- | --- |
| #/infrastructure | Host inventory, observed resource measurements and collection freshness | Configure source-bound hosts, run the external collector and validate coverage |
| #/services | Registered checks, observed results and dependency health | Define the checks and send trustworthy observations from the monitored host |
| #/websites | Registered target observations, status/latency, redirect and certificate evidence | Review each HTTPS target and commission the external probe; gaps remain unknown |
| #/metrics | Bounded series/history and export with explicit missing intervals | Select measured series, capacity and retention; a chart does not prove complete collection |
| #/incidents | Durable native incident episodes, acknowledgment/maintenance, native and finding mail status, pause and reconciliation | Review incident thresholds, recipients and transport config; SMTP verification sends no message, and explicit test-send needs a recipient |
| #/jobs | Registered critical jobs, durable runs, execution and output evidence/history | Register expected jobs and send observations; the SOC never starts a job |
| #/employees | Configured employee roster, work assignments and next-visit instructions with withdrawal and explicit acknowledgment | Connect a separately authorized runner and bound employee/source identity; an instruction is not proof of execution |
| #/analyst-reports | Received report/output and assessment evidence with execution status kept separate | Supply and review reports; completed output does not by itself prove successful execution |

Mail is disabled until configured. SMTP relay acceptance is not inbox delivery,
and ambiguous outcomes require reconciliation before a duplicate-risk requeue.
See [native Operations](NATIVE-OPERATIONS.md) and
[notifications](NATIVE-NOTIFICATIONS.md).

### Respond

| Route | Structural surface | Provider responsibility |
| --- | --- | --- |
| `#/triage` | **Security Triage:** private Queue, Awaiting approval, Cases, Closed and All; full scoped counts, explicit grouped alerts, local decisions/proposals, exact approval preview and resumable processing | The dedicated human-session API supplies local workflow authority over retained findings. Static/custom page-provider mode remains read-only. See [native Triage](NATIVE-TRIAGE.md); external AI execution and response actions require their own integration |
| `#/tuning` | **Detection Tuning:** Definitions, Applied alerts, and Matched but held views with definition status filters; query-selected tune detail, retained-occurrence and exact-finding choosers, read-only draft builder, and exact eight-column Detection Rules Analyst recommendation slot | Versioned definitions, occurrences, recommendations, safety state, and approval workflow; panel hydration never enables lifecycle controls |
| `#/rules` | **Detection Rules:** Palisade proposed/built-in/inline/custom rules, tested rule creation, recorded negative-space decisions, Sigma browse/import/subset guidance, YARA status/browse/manage, the deliberate Snort boundary, the embedded Tune registry, and stable read-only definition-detail slots | The private rule catalog exposes 25 opt-in original rules and reviewed JSON-pack policy/test/shadow/active/suppression controls. Imported definitions are read-only evidence; full Sigma/YARA/Snort execution and the remaining structural workflows need separate integrations |
| `#/alerts` | **Alert Comms:** exact reachability/delivery/overflow status, Who gets paged, Delivery log, and per-attempt Reconciliation views | This structural Alert Comms surface needs an adapter. Shipped native/finding email status and controls are on Operations → Incidents, with reviewed recipients and durable reconciliation |
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
| `#/scans` | **Scans:** Trivy, Patch first, File integrity, End of life, External surface plus sweep history, IOC scan, watched/on-demand urlscan.io surfaces, Dependencies, DLP Upload AV plus recent events, active/deleted Quarantine ledgers, and an inline Remediation log view; private Trivy adds a real report-upload form and projects accepted package/vulnerability observations into the Trivy view only | Supply additional scan, exploitation, integrity, EOL, exposure, dependency, Patch First, and review integrations; importer acceptance does not attest scan completeness, exploitation status, or patch execution |
| `#/remediation` | **Remediation:** latest VM review, the exact six-field append-only remediation form, and remediation record cards | Authorized remediation records, evidence references, future-concern state, and commands |

### Estate

| Route | Structural surface | Provider responsibility |
| --- | --- | --- |
| `#/systems` | **Systems:** Estate opens with external attack surface, inventory, known-exploited/software-match structures, and the `What am I looking at?` disclosure; Are we affected? contains latest-review, open-item, and methodology surfaces | Scoped asset, outside-in exposure, vulnerability lead, and advisory-review projections with canonical IDs and freshness |
| `#/databases` | **Databases:** exact schema-watch and schema-change tables followed by adding-database and methodology panels | Structural inventory and change projections with records and connection fields removed |
| `#/backups` | **Backups:** backup-chain push state, independent bucket pull verification, off-box evidence receipts, adding-chain guidance, and the two-side rationale | Backup-control summaries and evidence references, never storage credentials or environment endpoints |
| `#/retention` | **Retention:** structural policy/reality/review views; private Policy/Reality now show configured indexed-telemetry limits and real record/byte/receipt/identity/audit counters with explicit capacity and pruning behavior | Per-source measured horizons, filesystem/free-disk measurements, archived baselines and analyst review still need integrations; canonical record-byte totals are not total disk usage |
| `#/sources` | **Sources:** Expected sources shows application/environment and measured delivery health; **Add a source** configures, tests and activates a registered source; **Integrations** installs immutable data-only definitions and explains real screen coverage; **Received observations** filters retained records by app/source/kind; **Registry Changes** retains lifecycle history | Private mode supports canonical log push, all 29 canonical kinds through universal/custom definitions, and validated Trivy reports. Eleven legacy templates have no driver. Selected external collectors, protocol receivers and 18 bounded platform mappings are shipped; commission each supported provider shape. Arbitrary kinds, unbounded storage and a full query language are not supported |
| `#/agents` | **Agent Management:** Agents, Add Agent, Prompts, Enrollment, Service Access, and History tabs; lifecycle/capability metadata, separately authorized prompt-body reads, one-time enrollment output, pause/resume, archive/restore/remove, and audit; Service Access issues expiring scoped credentials with read-only defaults, rotation/revocation and its own audit | Keep runner execution, prompt privacy, enrollment proof and secrets server-side. Service Access is separate from managed-agent registration, does not schedule agents, and does not grant a credential permission to issue credentials or expand agent authority |

### Govern

| Route | Structural surface | Provider responsibility |
| --- | --- | --- |
| `#/attestations` | **Attestations:** Active, Add Attestation, Archived, and History tabs with authoritative lifecycle rows and links to detail | Supply the governance snapshot and authorize the exact `attestation.*` create/update/transition/archive/restore/remove commands; production evidence/approval/retention policy remains server-owned |
| `#/register` | **Risk Register:** Active, Add Risk, Archived, and History tabs with likelihood/impact, owner/review state, and links to detail | Supply the governance snapshot and authorize exact `risk.*` commands; richer scope, treatment, evidence, approvals, dependencies, and retention remain production extensions |
| `#/access` | **Access:** Who shows the current session and actual local operator accounts (first 200 names plus total). **Observations** displays imported identity/authentication/audit/offboarding facts; the other tabs preserve native navigation and show the same explicitly labeled read-only facts in generic private mode | Starter accounts are all full-access operators. Imported identity claims never grant console access; entitlement certification, device, refusal, and offboarding workflows need separate implementations |
| `#/documents` | **Documents:** real private uploads, application/owner/status/review metadata, optional linked record references, immutable versions with SHA-256 hashes, downloads, history, archive/restore, and restart persistence | Private starter owns the authenticated document API and bounded SQLite store; adopters own retention/deletion policy, fine-grained access, scanning, and backup operations. This local page never uses SOC page envelopes |

### Shell utilities

| Route | Structural surface | Provider responsibility |
| --- | --- | --- |
| `#/onboard` | **Onboarding:** register an application and its environments, optionally declare collector hosts, then continue to source setup; optional host enrollment/connection controls remain available | Authenticate each command, validate environment/source ownership, return enrollment values only once, and require proof only for a selected host; canonical push works without any host |
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

### Local document library

`#/documents` is also outside the 38 SOC page-adapter routes. In private mode it
uses authenticated `/api/v1/documents` endpoints, not connector commands or
page envelopes. Files are stored as immutable versions with metadata/history;
downloads verify the stored hash and force attachment handling. Metadata statuses
are `draft`, `current`, `needs-review`, and `retired`; archive/restore is separate
from that status. Optional `risk`, `attestation`, `case`, or `policy` references
are metadata links, not automatic changes to those records or proof of approval.
There is no inline document execution, malware scan, hard-delete UI, or public
download link. Current bounds are 10 MiB per file, 512 MiB total version bytes,
1,000 documents, and 10,000 versions across the library. The static preview
shows that a private document service is required.

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
| `#/triage` | **Security Triage:** private Queue, Awaiting approval, Cases, Closed and All; full scoped counts, explicit grouped alerts, local decisions/proposals, exact approval preview and resumable processing | The dedicated human-session API supplies local workflow authority over retained findings. Static/custom page-provider mode remains read-only. See [native Triage](NATIVE-TRIAGE.md); external AI execution and response actions require their own integration |
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
| `#/sources` | `stab`: **`expected`**, `add`, `changes`; private mode also supplies setup, server-log guidance, source mapping, Operations setup, integrations, live collection, vendor import and received-observation views |
| `#/agents` | `atab`: **`agents`**, `add`, `prompts`, `enrollment`, `access`, `audit`; `agent` and `prompt` are application-validated stable selectors for management/detail within their matching tabs |
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
- The shell catalog contains those 38 SOC routes plus eight dedicated Operations/report pages,
  local `/docs` and `/documents`; these ten pages do not call the page adapter. `#/docs` never reaches a
  connector-control or administration provider either.
- Thirty-five SOC primary paths plus Documents populate the seven grouped areas.
- `#/onboard` and `#/settings` remain primary surfaces reached through shell
  controls rather than sidebar destinations.
- Detail/utility paths remain directly addressable and can receive page models.
- The selected route is reflected in the URL, page title, navigation state, and
  focus behavior.
- Unknown paths render a not-found state; they are not represented as Overview.
- Page titles follow the product pattern `bulwark>soc · Page`.

### Adapter states and presentation primitives

- Without an injected adapter, the original 38 SOC routes render an honest
  empty skeleton state. Documents and Operations require their private APIs. The local `/docs` utility renders its checked-in public
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
- The private starter supplies Better Auth sessions and CSRF protections with
  full-access operators; OIDC and fine-grained authorization are separate
  adopter integrations. See
  [AUTHENTICATION.md](AUTHENTICATION.md).

### Connector-control and ingest integration

- The browser can resolve a validated `SOC_CONSOLE_CONNECTORS` provider with
  `getSnapshot`, `execute`, and optional `dispose` methods.
- Its command vocabulary is exactly `app.register`, `host.enroll`,
  `source.setup`, `source.test`, `source.activate`, `source.update`,
  `source.pause`, `source.resume`, `source.revoke`, `source.rotate`,
  `source.archive`, and `source.remove`; it does not activate
  unrelated product forms or actions.
- Installed manifests own connector types, source kinds, configuration fields,
  credential-reference slots, canonical outputs, page targets, and health
  policy. The UI cannot invent a kind or toggle searchability.
- Stable `appId`, `hostId`, `connectorInstanceId`, and `sourceId` values preserve
  identity and allow multiple same-kind sources. Hosts are optional for
  canonical push; each source selects a registered application environment.
- Canonical records populate screens through page-envelope projectors. MCP may
  optionally mirror administrative commands through the same service, but it
  is never a telemetry or plaintext-secret transport.
- The workbench implements one `log.event` push path. The private application
  additionally supports all 29 canonical kinds, the source-bound platform and
  native monitoring receivers, and reader-proof server-log health. Sample
  validation proves shape, not delivery. A delivery receipt and a completed
  reader observation are separate evidence; stale or failed reads cannot become
  healthy just because queued bytes arrive. Eleven legacy scanner setup
  templates have no drivers and cannot activate. The private `trivy-report`
  importer accepts supported JSON
  imports produce scan summaries, package inventory and vulnerability records,
  with Trivy-only projections. Patch First and other acquisition modes remain adopter
  implementations; no server-side scanner execution is implied.

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
  The connector provider enables only its twelve source-management commands. An
  independently validated administration provider enables only its closed
  agent/prompt/enrollment/attestation/risk commands on matching management
  surfaces. Dedicated private API clients enable their own documented workflows;
  none is activated merely by a page envelope.

## Human operating and population guide

The in-app technical manual contains the detailed, human-readable purpose,
inputs, population path, mutation ownership, archive/removal policy, and honest
no-source state for every category and subcategory:

- Monitor: Overview, SOC Health, Daily Brief, Analytics, and Timeline in
  [chapter 39](../public/technical-reference.md#39-human-operating-guide-monitor);
- Operations: Infrastructure, Services, Websites, Metrics, Incidents, Critical
  jobs, AI Employees and Analyst reports in [native Operations](NATIVE-OPERATIONS.md);
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
- Govern: Attestations, Risk Register, Access, and Documents
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
| 48 catalog paths: 38 original adapter routes, eight Operations/report pages, Documents and Docs | Route metadata, navigation and private clients | Intentional extensions and authorized data sources |
| Exact product styling and brand assets | Yes | Asset hosting and approved brand changes |
| Versioned page/session/control validation | Closed contracts and private API implementations | Valid custom integrations and policy for extensions |
| Canonical admission and read projections | Source authentication, 29 kinds, replay receipts, normalization and bounded projectors | Commissioning, source quality, unsupported mappings and coverage |
| Empty/failure-state rendering | Explicit absence, unavailable, denied and error states | Investigating deployment faults and missing observations |
| Human authentication and CSRF | Better Auth, optional account TOTP, fixed sessions and same-origin mutation checks | Account custody, deployment policy, external identity/OIDC if needed |
| Authorization | Full-access human operators; exact installation-wide service scopes and source-bound machine receivers | Fine-grained human roles, tenant isolation and step-up approval |
| Collection, search, storage and retention | Indexed SQLite, bounded search/retention, checkpointed log and Windows collection, selected cloud workers and private protocol receivers | Capacity, deployment, provider commissioning and distributed/high-availability storage |
| Source onboarding | Private UI/API, immutable integration definitions, sample validation and lifecycle | Reviewed configuration, managed secrets and coverage verification |
| Agent/prompt/enrollment and governance lifecycle | Private administration state/audit and closed commands | Runner execution, evidence/retention policy and fine-grained authorization |
| Agent-readable MCP | Public resources and seven scoped control/setup tools; owner-only token-file client | Client installation, disclosure policy, permission selection and operations |
| Documents | Authenticated uploads, immutable versions, metadata, history and archive/restore | Scanning, deletion policy, access policy and backups |
| Native monitoring and Operations | Durable measurements, incidents, jobs/runs/output, work and employee inbox | Reviewed inventory, collector/runner observations and incident response |
| Detection | 25 opt-in original rules, reviewed JSON packs, testing, shadow/active rollout, expiring suppression and rollback | Rule review, source coverage, tuning and response; no general Sigma/YARA/Snort engine |
| Native and finding email | Durable Resend/TLS SMTP queues, pause, bounded retry, test and reconciliation controls | Mail relay/provider, external credentials, reviewed recipients and delivery commissioning |
| Trivy report import | Supported JSON normalization, authenticated admission and Trivy-only projections | Run the scanner, supply fresh reports and assess coverage/remediation |
| Deployment packs | Reviewed Windows Task Scheduler, systemd, Compose, Helm and Ansible generation | Apply, configure, commission, upgrade, back up and operate each supported target |
| Other catalog commands, approvals, chat/ticketing integrations and attachment controls | Structural only unless a documented private workflow supplies them | Implement separate authorized services |
| Production availability, recovery, privacy and incident response | Bounded tested mechanisms, not a managed service | Deployment-specific validation and operations |

For the shipped private paths and their exact limits, see technical manual
[section 52](../public/technical-reference.md#52-storage-limits-reliability-acceptance-and-remaining-parity-work),
[section 53](../public/technical-reference.md#53-private-service-identities-and-authenticated-mcp-setup),
and [section 54](../public/technical-reference.md#54-trivy-report-import-from-a-users-own-scanner).

## Portable server-log monitoring

Sources → Server logs provides local setup guidance for `server-log-push`.
The external `collect:logs` CLI reads plain-text, Docker JSON and journald JSON
files with a persisted cursor and queues exact canonical bodies before cursor
advancement. `events` exposes the same outbox for arbitrary canonical batches.
Sources and Health distinguish reader completion, delivery receipt, and log
activity; failed or delayed reads cannot be made fresh merely by delivery.
See [SERVER-LOGS.md](SERVER-LOGS.md) for limits, scheduling, recovery, and the
boundary between this reusable port and deployment-specific monitoring.

## Platform monitoring expansion

The private application includes source-authenticated platform delivery, a
Windows/WEF collector, 18 supplied-log adapters, executable cloud/Checkmk/Wazuh
workers, private OTLP JSON/syslog TLS receivers and 25 opt-in original rules.
Reviewed JSON packs add tested predicates, shadow/source rollout, expiring
suppressions and version rollback. Native incidents and derived findings can
send through Resend or authenticated TLS SMTP using the mail service behind
Roundcube. Durable delivery includes pause, bounded retries and reconciliation.
Deployment generation produces Windows Task Scheduler, systemd, Compose, Helm
and Ansible bundles without applying them.

Read [platform ingestion](PLATFORM-INGEST.md), [coverage](PLATFORM-COVERAGE.md),
[collectors](PLATFORM-COLLECTORS.md), [protocol receivers](PROTOCOL-GATEWAYS.md),
[deployment automation](DEPLOYMENT-AUTOMATION.md),
[reviewed rule packs](REVIEWED-RULE-PACKS.md) and
[notifications](NATIVE-NOTIFICATIONS.md). Configure and commission each
integration in its actual environment; supplied adapters are not universal
provider coverage.
