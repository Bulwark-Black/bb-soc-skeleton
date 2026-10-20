# Native Security Triage

The private **Respond → Triage** page provides local decisions, explicit case
groups, proposals and durable approval runs over retained canonical findings.
The static shell and custom version-1 page-provider projection remain read-only.
No production data, analyst prompts, account identities or deployment settings
are included.

## Scope and authority

This workflow reads `finding` and `vulnerability.finding` records. A canonical
alert is identified by its source and record ID; its application comes from the
source registry. Imported `payload.state` is shown as **reported upstream state**.
A new local decision starts **open / unclassified**, even when the producer
reported a closed state. Imported `case.record` observations do not create local
groups, decisions or proposals.

Private Triage uses the existing Better Auth operator session, exact Host and
Origin checks, and existing full operator authority. Bearer/source/service
credentials and MCP gain no Triage permission. A proposal's author label is
operator-entered provenance text; the authenticated actor is recorded separately.
This update does not launch Claude routines, schedule employees, call a model,
send a notification, execute remediation or prove that a fix worked.

## Reading the board

Select a registered application, a view and optional source, rule, severity,
category, literal search or explicit group filters. All counters come from the
server over retained matching findings, before page limits. An alert counts once
regardless of its imported occurrence count.

The lanes are exclusive, in this order:

1. **Closed:** local state is resolved or closed.
2. **Cases:** local state is investigating or category is real-threat.
3. **Awaiting approval:** a current pending proposal remains.
4. **Queue:** remaining open alerts.

**All = Queue + Awaiting approval + Cases + Closed.** These are alert counts.
Display groups count explicit cases plus each ungrouped individual alert.
Neither number is the number of currently rendered rows.

Pagination is by alerts. A large group can span pages. Its header distinguishes
shown members, members matching the complete current filters, and all stored
case members. Stored membership can outlive retained evidence; it is not a claim
that every original payload is still available. Each expanded alert has its own
number, identity, evidence and action. The header represents the case and has no
individual disposition control.

The header checkbox selects only its **shown matching alerts**. It does not
silently select unloaded members. The group-browse link preserves other filters.
Severity, workflow and pending-proposal badges have separate meanings and text
labels; an investigation is not automatically a confirmed threat.

Server search is a literal, case-insensitive substring across title, summary,
source ID, record ID, rule and asset. The shell's page search only filters loaded
case groups; it keeps a represented group together. Clear shell page search
before requesting all server-matching proposals.

## Inspector and full investigation

The five-column board separates case disclosure, alert inspection and checkbox
selection. Each alert has one canonical evidence leaf and an adjacent **Open
investigation** link. Modified clicks retain browser behavior.

Summary, Evidence and History stay mounted for the selected alert. Switching
tabs performs no fetch and preserves drafts, validation and save uncertainty.
Changing alert reads the bounded inspection aggregate once; a failed, expired,
stale-session or stale-version read leaves the previous panel visible.
Left/Right, Home/End and Enter/Space operate the tabs. Escape closes the
inspector when no dialog owns that key.

Full investigation uses the same exact alert/version with case membership and
selected-alert recorded notes. Its return link preserves application, filters,
pagination, disclosure, timezone and saved approval context. A retained alert
outside the current filters or page is explicitly labeled. Returning to a saved
approval performs GETs only; approval processing never restarts implicitly.

A confirmed save refreshes current evidence. An uncertain write freezes its
submitted intent and blocks departure or another mutation until an explicit
identical retry or saved-operation reconciliation. Submitting a different form
requires confirming discard of its neighboring draft; canceling sends no POST.

## Select, preview, approve

Selections are exact alert identities, deduplicated across child and group
checkboxes. They remain scoped to the current application and filters across
pagination and expansion while the tab is open. The toolbar separates visible,
hidden-by-search-or-folding and other-page selections. Reload or an explicit refresh clears an unreviewed selection; automatic refresh
is deferred while a selection is active. These actions do not delete saved
approval operations.

Use **Review selected proposals** for selected identities or **Review all
matching proposals** for the complete filtered scope across retained pages.
Preview saves an inert snapshot. It does not consume a proposal or change any
decision. Review its application, filters, snapshot time, eligible and excluded
counts, proposed outcomes, source totals and paginated frozen member list.

There is no 100-alert selection limit. Approval processes internal transactions
of at most 100 eligible items while the browser advances the run. This bounds
each write; it does not require the operator to select another 100 manually.
Pause stops after the current request settles. Reload retrieves saved progress
without sending an approval step. Resume is explicit and restricted to the
original operator and application.

A run freezes each alert's admission identity, body hash, proposal revision,
decision revision and group identity. Every step rechecks them. Revised or
withdrawn proposals, intervening human decisions, expired evidence and recreated
record identities are skipped and reported. New arrivals never enter an existing
preview. Critical alerts, groups with critical members, and groups with missing
or changed evidence are excluded from bulk approval. An explicit individual
human decision remains available with a reason.

Counts have distinct denominators:

- **Candidates = eligible + excluded before approval.**
- **Eligible = approved + skipped after recheck + remaining.**
- Proposed outcomes describe the eligible snapshot; result outcomes describe
  what the operation actually committed.
- Exclusions are not counted a second time as skipped results.

## Local authoring

Open an alert title and its **Summary** pane to record or replace a proposal, withdraw a pending
proposal, or record a human decision. Proposal and decision writes use the exact
displayed revision. A human decision supersedes the pending proposal for that
alert only. Closed/resolved alerts must be explicitly reopened before another
proposal is recorded. Recording a resolved state is a local assessment, not
measured incident recovery or independent remediation verification.

Group at least two distinct retained alerts with an explicit label. Group
creation is application-scoped and rejects already-grouped current members.
Upstream case names do not determine membership. This release has no group
rename, ungroup or delete command; history remains available in the private
store.

## Private API

Base: `/api/v1/triage`. Responses carry `schemaVersion: "1"`; reads use
`Cache-Control: no-store`. This is a dedicated private API, not an extension of
the closed canonical, page, connector or administration version-1 schemas.

| Method and suffix | Purpose |
| --- | --- |
| GET base | Scoped alert list, lane counts, group counts and page metadata |
| GET `/alert?appId&key` | Exact retained alert with current local decision/proposal and opaque evidence version |
| GET `/alert/inspection?appId&key&expectedVersion` | One consistent read of current alert, bounded evidence, initial history and explicit case context |
| GET `/alert/evidence?appId&key&expectedVersion` | Bounded canonical evidence for exactly the displayed admission |
| GET `/alert/history?appId&key&expectedVersion&limit&cursor` | Exact-admission local history with signed, fixed-high-water pagination |
| POST `/proposals` | Create or revise a pending proposal |
| POST `/proposals/withdraw` | Withdraw the exact pending proposal |
| POST `/decisions` | Record an individual human decision |
| POST `/groups` | Create an explicit group from exact alert keys |
| POST `/approvals/preview` | Freeze selected or all-matching candidates without applying them |
| GET `/approvals/:id?appId` | Retrieve saved progress for the original actor/application |
| GET `/approvals/:id/items?appId&limit&offset` | Page through frozen members and saved per-item outcomes |
| POST `/approvals/:id/step` | Explicitly commit the next bounded step |

List requires `appId`. Filters are `view`, `sourceId`, `rule`, `severity`,
`category`, `q` and `groupId`. Views are `queue|approvals|cases|closed|all`.
Limits are 1–200, default 100; offset is 0–1,000,000. Search is at most 240 UTF-8
bytes. The browser defaults to 50 alerts per page. These bounds affect display,
not full-scope counts or matching approval coverage.

List returns `counts`, `filteredCount`, `groupCount`, `alerts`, `groups`
and `page`. Alert `key` values are opaque; clients reuse them rather than
constructing identity from a title or host. Groups expose `shownCount`,
`matchedCount`, `totalMembers` and `hasCritical`. Alert list/detail projections
also include an opaque `evidenceVersion`; use the returned value for private
evidence, history and inspection reads.

Authoring requests use `appId`, a fresh `idempotencyKey`, and:

- Proposal: `key, expectedRevision, state, category, note, authorLabel`.
- Withdrawal: `key, expectedRevision, reason`.
- Decision: `key, expectedRevision, state, category, note`, optional `owner`.
- Group: distinct `keys` and `label`.

Local states are `open|investigating|resolved|closed`; proposals cannot request
open. Categories are `unclassified|benign|expected-activity|real-threat`.
Notes/reasons are at most 2,000 UTF-8 bytes, owner/author labels 120, group labels
160. A withdrawal requires a reason; critical or incomplete-group manual
decisions require a nonempty note. Use revision zero only when no prior revision
exists. Recreated identities retain monotone revision numbers without inheriting
old workflow state.

Preview takes `{appId, idempotencyKey, scope, filters, keys?}`.
`scope: "selected"` requires keys and rejects the entire request if any selected
alert is outside the exact application/filter/view. Duplicate keys are
deduplicated. `scope: "matching"` forbids keys and freezes pending proposals in
the full filtered scope. Page offset and limit are not preview filters.

Step takes `{appId, revision}`. Current revision authorizes one step; a replay
with an older revision returns current saved progress without processing another
batch. A future revision returns conflict. Idempotency keys are actor-bound;
reuse with different content is a conflict. After a network ambiguity, retrieve
saved operation status or retry the identical submission. Never create a new
request key solely because the prior response was lost.

Malformed/unknown fields return 400; missing or machine-only authentication 401;
actor/application/Origin violations 403; missing resources 404; wrong methods
405; revision/idempotency conflicts 409; oversized bodies 413; unsupported media
415; exhausted Triage capacity 507. Errors do not imply a successful decision.

## Exact evidence, history and inspection reads

The three private read endpoints are implemented. Each requires the current
`appId`, opaque alert `key` and displayed `expectedVersion`. The evidence version
binds the canonical admission row, receipt time and body hash. It is not a
workflow revision. The server uses one SQLite read transaction for the aggregate
inspection and does not create decisions, proposals, approval progress, receipts
or audit entries on any GET. Reads keep the same operator-only authentication and
`Cache-Control: no-store` policy as the board. A returned `viewerId` is an opaque
session-bound fingerprint for client stale-response checks; it contains no raw
session credential and grants no authority.

`/alert/inspection` returns `schemaVersion`, `appId`, `key`, `evidenceVersion`,
`alert`, `evidence`, `history` and `caseContext` (plus the HTTP viewer fingerprint).
The aggregate body is bounded to 655,360 serialized UTF-8 bytes. Ordinary target
selection can use this one read; separate reads exist for explicit evidence
refresh and history pagination. A failed component fails the aggregate instead
of inventing an empty section.

Evidence has scope `exact-retained-admission`. It includes the canonical
allowlisted `record`, provenance (`sourceId`, `recordId`, `admissionId`,
`receivedAt`, `bodyHash`), `complete`, `clipped`, `omittedPaths`, `originalBytes`,
`returnedBytes`, `maxRecordBytes` and `fullRecordAvailable`. The record display
budget is 48,000 serialized UTF-8 bytes, not 48,000 characters; its complete
response is at most 65,536 bytes. Clipping omits whole fields and names their
paths. `fullRecordAvailable` is false when clipped: this API has no unbounded raw
record download. This is retained canonical evidence, not the original provider
file and not proof that all upstream evidence was collected.

History has scope `exact-admission-local-workflow`. Events are in descending
recorded `sequence` order and expose only the selected alert's local proposal,
decision and recorded per-item approval outcomes. The authenticated `actor` is
separate from a supplied `authorLabel`. A skipped approval item is an outcome,
not a committed decision. Sibling case notes and earlier admission incarnations
are excluded. Expired proposal projections preserve only their revision and
expired status, not a prior incarnation's note, author or body.

History defaults to 30 events, accepts a maximum limit of 100 and is bounded to
524,288 serialized bytes. A size-bounded page may contain fewer events than its
requested limit. Follow the returned `page.olderCursor` or `page.newerCursor`;
never construct cursors or assume a short page is the end. The signed cursor
binds application, alert, incarnation, page limit and a fixed `highWater`.
`page.total`, `hasOlder` and `hasNewer` describe that fixed window; later writes
appear only in a fresh history read. Changing the limit or target while reusing a
cursor is rejected. Retention, `complete` and `notices` describe the available
history. Legacy approval operations without exact retained per-item provenance
report `complete: false` and `legacy-approval-outcomes-unavailable`; the service
does not reconstruct or invent those outcomes. Local history is retained without
automatic eviction, while canonical evidence can expire independently.

`caseContext` is null for an ungrouped alert. An explicit case includes its
recorded ID/label, stored/available/unavailable member counts and at most 30
currently retained member identities, each with its own evidence version.
`hasMore` reports a longer case; the ordinary group-filtered board remains the
paginated member view. Case counts are computed over the complete stored scope,
not the 30 returned members. Case attachments and independent agent-note
associations are explicitly `unsupported`. The selected alert's recorded
proposal, decision and history notes remain available with their provenance;
they do not establish an independent agent identity or analysis-run status.

Unknown or duplicate query fields and invalid tokens return 400. A missing,
expired or cross-application target returns 404; a valid but stale evidence
version returns 409 `evidence-version-conflict` before cursor processing. A
wrong-target, changed-limit or tampered cursor returns 400
`triage-cursor-invalid`. Inconsistent/unavailable retained evidence or history
returns 503; it is not an empty result. An old admission is never silently
replaced with a newer record that happens to reuse the same source/record ID.

## Persistence, capacity and recovery

Additive `triage_meta`, `triage_rows`, `triage_members` and `triage_items`
tables live in the existing external `telemetry.sqlite`. Current heads,
immutable decision/proposal history, groups, operation snapshots and results,
receipts and audit are retained. Canonical records remain immutable. Each step
commits decisions, proposal consumption, per-item results, progress, revision
and audit in one SQLite IMMEDIATE transaction.

A 128 MiB logical Triage-owned state quota accounts for serialized rows,
snapshots, membership/identity overhead, receipts and audit. It is not total
SQLite, WAL or disk usage. Exceeding it fails and rolls back the whole mutation.
There is no silent history eviction, receipt expiry, automated purge or export
command. HTTP JSON bodies are bounded to 16 MiB. Large selected-key requests must
fit that bound; matching scope avoids uploading every key.

Existing canonical retention remains independent: default 30 days, 100,000
retained payloads and 256 MiB record bodies, with its documented replay policy.
Triage cannot approve a snapshot after its canonical evidence expires.
Old local decisions, proposals and membership cannot attach to a recreated
identity with another admission row/time/body.

Before upgrading an existing deployment, stop the writer and preserve a
consistent whole external-state backup, including SQLite state. Start the new
version against the same state to add Triage tables. Test an empty application,
an existing retained finding and authorization failures before enabling operator
use. Rollback restores the complete pre-upgrade state with the corresponding
code; reverting only code does not undo committed decisions. Do not delete a
database or operation history to clear an error or quota.

This starter has one application process and full-access operators. It does not
add multitenant/RBAC isolation, universal rule execution, an AI runner, a
production telemetry feed, a general ticketing workflow or automated response.
The existing source, employee, incident and notification lifecycles stay separate.

## Case, alert, evidence and inspector workspace

**Status: IMPLEMENTED.** The persistent three-pane inspector, nested evidence
rows, exact full investigation view and shared navigation use the bounded private
read contracts documented above. Summary form nodes stay mounted across tab
changes; pending and uncertain writes remain guarded. The requirements below
record the implemented mapping and interaction contract, including explicit
unsupported associations. Synthetic verification is recorded at the end of this
section; private reference results do not establish skeleton acceptance.

The reference is the operational Triage workspace: a compact queue on the left,
an alert inspector on the right, and a visible case → alert → finding hierarchy.
Port the behavior and complete visual treatment together. Do not copy private
records, case identifiers, hosts, accounts, screenshots, analyst instructions or
operational filesystem paths into this repository. Use synthetic fixtures for
all implementation, screenshots and acceptance evidence.

### Meaning and identity before appearance

The operational console groups related alerts into cases. Each alert is one
host-and-observation-time decision with one or more actual detector findings.
Its finding reference selects exact evidence, while the alert remains the
disposition and bulk-selection unit. Case headers are never an individual
alert, and finding rows are never separate approval targets.

The skeleton has a different canonical model. Each retained `finding` or
`vulnerability.finding` record is already one alert with an opaque key based
on source ID and record ID. Its current admission row, received time and body
hash distinguish its incarnation. Explicit local groups provide case
membership. A version-1 canonical finding has no nested `findings[]`
relationship, and imported `case.record` does not author local groups.

The implementation uses the following mapping:

| Workspace level | Skeleton meaning and authority |
| --- | --- |
| Case | An existing explicit local group. An ungrouped alert may have a one-alert visual wrapper, clearly labeled ungrouped; the wrapper must not create a group or claim a stored case ID. |
| Alert | Exactly one retained canonical record and its local decision/proposal. Reuse the server's opaque key and admission identity; never reconstruct it from a title, asset or timestamp. |
| Finding / evidence leaf | In the first port, the same single canonical finding record as evidence beneath its alert. It is a read-only evidence view, not a new child entity or independently selectable decision. |
| Inspector | Current local state plus exact scoped evidence for the selected alert. Inspection, case expansion and checkbox selection are independent. |

Do not split a summary into invented findings, treat occurrence counts as
children, or fabricate separate IDs to imitate a richer operational record.
If multiple findings per alert are required later, first design and version an
explicit relationship and retention contract. Do not silently widen the closed
canonical version-1 schema. Until then, describe evidence counts as retained
canonical records and explain why the alert and finding counts coincide.

Preserve shown / complete-matching / stored-member counts for split case pages.
The operational console pages cases; this skeleton pages alerts. A port must
not quietly change that API or let a header select unloaded group members.
Every shown selectable alert appears once in the decision set, even when its
header checkbox and member checkbox overlap. Stored members whose evidence
expired remain distinguishable from available evidence.

### Queue and inspector behavior

Use five columns: **selection, case / alert, severity, review, updated**.
Every displayed group, including a one-alert visual wrapper, has a distinct
header followed by its actual alert rows and their evidence rows. Keep
disclosure separate from the title link: the disclosure shows children; the
title inspects the exact alert or evidence. There is no group-level owner,
disposition form or implied cascade. Existing explicit group creation remains
a separate operator action.

Beside each actual alert title, provide a distinct, visible **Open investigation**
link. Keep the title as quick inspector access; the adjacent action opens the
full investigation directly, without requiring an inspector visit or changing
selection, disclosure or disposition. Use a real keyboard-accessible link with
an accessible name that identifies its alert; do not hide the action behind an
icon-only control or make a case header represent one member's investigation.
Preserve exact application, alert and any selected finding/evidence identity,
filters, page, timezone, expansion, approval and return-to-queue context in both
normal and modified-click navigation. Validate the return target and evidence
version using the skeleton's own contracts.

The operational reference prefers a recorded detector title (including Sigma
or a custom detector) or a code-owned rule label. When a case contains mixed
alert titles, label the chosen example **Latest alert** rather than implying
that one representative title describes every member. Use the skeleton's own
recorded available names and metadata; do not infer a verdict or invent an
explanation to fill a heading.

The shared bulk toolbar sits above the two-column workspace so the queue and
inspector start on the same horizontal line. Keep zero-selection guidance
compact; show the visible, page-search-hidden and other-page breakdown when
selection exists. Keep the all-matching review action available without
requiring selection. The case tree uses its own loaded-page search, synchronized
with the shell search, while complete scope counts remain unchanged.

Updated means the latest actual retained observation, human disposition or
proposal timestamp, with the timestamp source available to the operator.
Map that to the skeleton's real recorded timestamps; never use render time or
an absent provider timestamp as proof of fresh evidence. Long finding headings
may be visually clamped to two lines only when a keyboard-accessible full
summary disclosure and unabridged evidence text remain available.

Case folding hides all its alert/evidence descendants. Alert disclosure shows
only that alert's evidence. Update each disclosure's actual href when its
Show/Hide state changes, so keyboard activation, modified clicks and opening a
new tab agree with the visible action and preserve the current context. Keep stable row identities, escaped text, readable
severity and workflow labels, and meaningful `aria-expanded` states.
Inspection highlights must not look like checkbox selection. Page search
continues to hide complete loaded groups, including descendants; hidden
ancestors must exclude checkboxes from **Select this page**. Hidden selected
keys remain counted and explained, rather than silently removed. Server search
still covers the full retained matching scope.

The inspector has **Summary, Evidence, History**, a labeled close control and a
full-alert/evidence handoff where supported. Its empty state invites selection.
An expired, missing, stale-incarnation or out-of-application target stays
unavailable; never substitute the next alert or another finding. An exact
retained selection outside the current filters/page can remain open with an
explicit notice while the filters stay unchanged.

Summary shows current local disposition, owner, proposal provenance and reason,
plus rule/source facts that are actually available. The operational reference
also shows recorded analysis states (absent, queued, running, done or error);
recorded running is not proof that an external routine is active, and completed
analysis is not a completed disposition. The skeleton has no equivalent
per-alert analysis-status read contract, so do not infer one from a proposal
or a global employee status. Preserve the existing
proposal creation/replacement/withdrawal and human-decision capabilities.
Move their revision-bound forms into the inspector without changing endpoints
or semantics. Reviewing a proposal still creates an inert approval preview;
a visually prominent approval button must not bypass that review. Critical
and incomplete-group safety checks remain enforced by the server. Local
resolved/closed state remains an assessment, not independently measured recovery.

Evidence must distinguish reported upstream fields from local workflow. Show
exact source/record identity, observation time, body/admission provenance where
safe, and bounded available evidence. Do not present the current projected
`/alert` summary as a full raw record. The operational reference clips
structured detail at 48,000 characters and labels clipping; adopt an explicit
bounded display with a truthful full-record handoff only when that read exists.

Operational attachments are case-shared files, not proof that a file describes
the selected finding. The skeleton's document library currently has no
Triage-case association contract. Do not infer attachments from filenames or
reuse a local operational evidence directory. Omit this section or mark it
unsupported until an explicit scoped association/read contract exists.

The planned full investigation must make permitted case evidence and recorded
agent-authored notes available alongside exact-alert evidence. Clearly separate
case-shared material from evidence and notes bound to the selected alert/finding;
retain recorded authorship and provenance without treating an author label as
independent agent identity proof. Existing authentication, scope and read/write
permissions remain authoritative. Reading the investigation must not acknowledge,
approve or execute anything. Implement the page and any missing associations or
note reads against reviewed skeleton contracts before enabling this action;
there is no existing equivalent full investigation endpoint to assume or copy.
Bound and paginate retained material, and disclose unavailable or incomplete
reads rather than claiming a complete case file.

History shows recorded actor separately from a supplied proposal author label.
Show applied decisions, proposal changes and approval skips without presenting
a skipped item as a committed disposition. Filter each event to the exact alert;
never expose another member's note from a multi-alert transaction. Include
scope, retention, pagination, incomplete/corrupt-read and unavailable notices.
The operational reference scans a bounded active audit ring (newest 8 MiB /
4,000 lines, at most 100 matching decision rows, and 30 exact-alert notes);
it explicitly does not verify the audit hash chain or claim lifetime history.
The skeleton must use its own SQLite history, not pretend it has those rings.

### Visual specification and responsive behavior

Implement within the existing shell and `public/triage.css` boundary. Preserve
the product mark, shell fonts, navigation, control conventions and
[design-system](DESIGN-SYSTEM.md) invariants. The following are reference
workspace roles, not authorization to weaken palette/snapshot tests. If the
current approved palette lacks a reference color, review an intentional token
and boundary-fixture update together; do not bypass the public audit or
silently substitute an approximate theme.

| Role | Reference treatment |
| --- | --- |
| Workspace / panel / border | `#101820` / `#131e29` / `#2a3745`; primary text `#e4eaf3`, muted text `#9aaabd`. |
| Active navigation and focus | Cyan `#75d9f1`; 2 px focus outline with 3 px offset; active tab has a 2 px underline. |
| Case / alert / evidence rows | `#15212d` / `#101a24` / `#0e1720`; connected hierarchy guides `#34516b`. |
| Inspected / checkbox-selected | Inspected `#153045` with `#61d0f4` edge; selected alert `#16334a`, selected header `#1c3042`. Keep the states independently recognizable. |
| Critical severity | Background `#3c222b`, border `#954658`, text `#ffb5c5`, plus the literal severity. |
| High / medium severity | Background `#392e1b`, border `#8b6f3f`, text `#efd18a`; labels distinguish high from medium. |
| Low / informational severity | Background `#23333e`, border `#465c6c`, text `#b5c9d8`. |
| Pending proposal workflow | Background `#302644`, border `#6b5596`, text `#dbc3ff`; never a completed-state signal. |
| Working / neutral / completed workflow | Blue `#17354b/#376e98/#a8d8ff`; neutral `#24313d/#435466/#c3cfdf`; muted green `#1c3129/#486c5a/#a8cdb8` (background/border/text). |
| Inspector | Surface `#131e29`, border `#2b3540`, 10 px radius. The proposal card repeats the purple proposal role `#302644/#6b5596/#dbc3ff` and explicit proposal text; active inspector tabs use cyan. |
| Uncertainty / incomplete history | Warning surface `#332b1c`, text `#e7c27c`, 3 px `#c39851` edge; never hide it behind a healthy-state color. |

Reference desktop geometry is a `minmax(0,1.63fr) minmax(0,1fr)` queue/inspector
grid with an 18 px gap. The inspector is sticky 14 px from the top above
1,100 px viewport width and becomes a normal stacked panel at or below that
breakpoint. At 700 px and below, filters and bulk actions wrap; preserve the
inspector and every action rather than hiding columns. The table has a 610 px
minimum width inside its own horizontal scroller, not document-wide overflow.

On mobile or other stacked layouts, opening an alert or finding must navigate
or scroll to the inspector target so the selected content is immediately
reachable. Preserve the exact selected alert/finding, filters, page, timezone,
expansion state, approval operation and return-to-queue context. Use a real
fragment/navigation fallback and a focusable inspector heading or target;
keyboard activation must leave focus visibly at the inspector without a second
unexpected scroll. Returning to the queue must retain the same page and context.

Use 12 px row text with 1.4 line height, 10 px uppercase column labels,
13 px case titles, and 10–11 px secondary/evidence metadata. Standard cell
padding is 11 px by 8 px; case rows use 14 px vertical padding and evidence
rows 9 px. Fixed columns are selection 32 px, severity 72 px, review 115 px,
updated 76 px; the title column uses remaining width. Alert and evidence
indentation are 22 px and 58 px. Inspector sections use 20 px horizontal
padding, 12 px body text at 1.6 line height, and bounded wrapping evidence
blocks. Preserve 32 px filter controls, explicit labels and visible focus.
Validate the actual rendered density rather than treating CSS numbers alone
as proof of screenshot parity.

Use native keyboard-accessible controls and real navigation fallbacks.
Enter activates links/disclosures; Space toggles checkboxes. Escape closes the
inspector only when another dialog does not own that key. Closing, switching
alerts/tabs or navigating away must protect unsaved note/owner drafts.
A successful owner save may synchronize untouched fields only; it must not
overwrite a draft decision. A different form submission must explicitly
confirm discarding another form's edits, and cancellation must stop downstream
mutation handlers. Announce confirmed save/error results, retain focus sensibly,
and never report an unconfirmed write as saved.

Any autosave added during the port must stop after an ambiguous network result
or unconfirmed rollback. Subsequent blur/change events must not retry it.
Retain the dirty draft and require explicit status reconciliation or reload
before another attempt. Existing revision/idempotency semantics still govern
that recovery; a new request key is not a substitute for knowing the outcome.

### Private API and route mapping

All mappings retain the existing Better Auth operator, exact Host/Origin,
application/source, revision, idempotency and actor-bound operation checks.
Machine credentials gain no read or write grant. These are private extensions;
the static preview and imported version-1 page projection remain read-only.

| Workspace need | Implemented contract or remaining requirement |
| --- | --- |
| Queue, lanes, matching counts, split group metadata | Existing `GET /api/v1/triage?appId&view&sourceId&rule&severity&category&q&groupId&limit&offset`. |
| Exact Summary and current form revisions | Existing `GET /api/v1/triage/alert?appId&key`. Its current response is a projection, not complete raw evidence or historical audit. |
| Proposal create/replace/withdraw, direct decision, explicit group creation | Existing POST `/proposals`, `/proposals/withdraw`, `/decisions`, `/groups`, with unchanged expected revisions and idempotency semantics. |
| Review one selected proposal, many selected proposals, or all matching | Existing POST `/approvals/preview`, GET status/items, and explicit POST `/approvals/:id/step`. No direct unreviewed approval shortcut. |
| Full investigation action | Implemented as `#/triage?appId=…&alert=…&version=…&mode=investigation` with a validated queue return context. It uses the exact aggregate inspection and explicit case context, with selected-alert proposal/decision/history notes. Case attachments and independent agent-note associations remain unsupported. |
| Exact Evidence | Implemented private `GET /api/v1/triage/alert/evidence?appId&key&expectedVersion`; exact admission, 48,000-byte record display budget and 65,536-byte response budget, with explicit clipping and provenance. |
| Exact local History | Implemented private `GET /api/v1/triage/alert/history?appId&key&expectedVersion&limit&cursor`; default 30, maximum 100 events within 524,288 bytes, with signed fixed-high-water cursors and explicit completeness/retention notices. |
| Aggregate inspection | Implemented private `GET /api/v1/triage/alert/inspection?appId&key&expectedVersion`; current alert, exact evidence, initial history and case context in one read transaction, bounded to 655,360 bytes. |
| Case files / independent notes / expanded rule catalog / per-alert analysis status | No equivalent association/read API currently exists. Specify and test each separately before exposing a functioning control. |

Evidence, history and aggregate inspection use the implemented closed schemas
and bounds above. List/detail evidence versions bind admission row, receipt time
and body hash. A concurrent expiration or recreation returns unavailable/conflict
rather than substituting another admission. History excludes prior incarnations;
a separately labeled historical-incarnation browser is not supplied.

Extend the private client context helper to preserve `appId`, canonical
filters, `offset`, `limit`, `expand`, `alert`, `approval` and `tz`,
plus an allowlisted `tab=summary|evidence|history` and an evidence-disclosure
key. The existing opaque alert key suffices for the first single-evidence-leaf
port; do not accept an operational host/time key or 20-hex finding reference.
Changing application must clear incompatible inspection/selection context.
Changing filters must retain the current scoped-selection policy and explicitly
label a retained inspector target outside the new filters. Links, forms and
history navigation must not lose the durable approval operation or timezone.

### Smooth navigation and retained inspector

The operational reference now retains the selected inspector's Summary,
Evidence and History panes and navigates eligible console views without
replacing the whole document. Its implementation files include
`respond/triage-inspector.js`, `respond/triage.js`, `lib/navigation.js`,
`lib/html.js`, `core/endpoints.js` and the initial-default correction in
`respond/honeypots.js`. These names describe the reference, not files to copy
into this skeleton.

The operational reference informed the interaction design. Its private deployment
identifiers, store details and verification captures are not public artifacts.
Its results do not establish that the skeleton has implemented or verified this
port. Skeleton acceptance requires the synthetic checks below.

The skeleton already has a client-side hash router in `public/app.js` and a
private Triage renderer in `public/triage.js`. Extend that architecture rather
than installing a second router or copying the operational HTML-fragment/body
replacement mechanism. Keep the existing public page-provider, authentication,
source, administration and private Triage boundaries separate.

For one exact selected alert, construct all three inspector panes once from
reviewed scoped reads. Summary form elements remain the same DOM objects when
the operator switches to Evidence or History and back. Tab changes must perform
zero network requests, preserve field values, validation and save uncertainty,
and change only pane visibility, active styling, ARIA selection and navigation
context. Use a tablist with labeled tabpanels and roving focus; Left/Right,
Home/End and Enter/Space must agree with pointer activation. Real links preserve
modified-click and full-navigation fallback. Escape closes the inspector only
when another open dialog does not own the key.

An alert or evidence-target change may replace only the selected inspector after
one bounded authenticated read for that target. Do not fetch three full pages,
remount the worklist, clear selected approval candidates or discard the current
panel while loading. Use the implemented
`GET /api/v1/triage/alert/inspection?appId&key&expectedVersion` contract above for
current Summary, bounded exact Evidence, initial bounded History and explicit
case context under one incarnation-bound transaction. Preserve its serialized
size budget, provenance, clipping, history high-water and error semantics.
Separate evidence/history reads are for deliberate refresh and pagination;
their existence must not cause background three-request fan-out on an ordinary
alert click. An incomplete section must be labeled unavailable,
not silently replaced with a different admission or an invented empty history.

Before changing targets, protect unsaved drafts with an explicit discard
choice. Block replacement while a mutation or approval step is pending, or an
owner save is unconfirmed; switching local tabs remains available because it
does not destroy the form. Do not create a cross-alert draft cache in the first
port. Capture a request generation, application/key/incarnation and edit version
when a read starts. Abort superseded reads and bound their deadlines. A late
response must not replace a newer target, a newly edited draft, another
application, a changed session or a disposed view. Failure keeps the prior panel
and draft with an announced retry/full-view option. Retrying a read is distinct
from retrying a mutation; never replay a POST because a view failed to load.

Read deadlines must fit the existing read workload rather than impose a new
failure threshold on legitimate historical views. The operational reference
uses a bounded 30-second page-navigation deadline and permits 60 seconds for
Analytics and queried Logs, whose retained-history reads can take longer; its
selected-inspector read remains separately bounded. These are reference
measurements and policies, not automatic skeleton route defaults. Measure the
skeleton's actual projections, specify appropriate finite limits and test a
slow successful read as well as a timed-out one. Timeout or cancellation keeps
the prior view, draft and honest loading/error status, aborts the pending read,
and never retries a write or claims that missing data is empty.

One shared navigation owner must coordinate route changes, local inspector
transitions, Back/Forward, explicit refresh and automatic refresh. Extend the
existing private renderer cleanup contract with an optional local navigation
handler and explicit pending-read cancellation, rather than adding competing
hash/history listeners. A synchronous unhandled result may delegate to the
normal router; a handled asynchronous cancellation or failure must preserve the
current view and must not fall through to destructive full navigation. Restore
the prior history entry when a back/forward transition is canceled. Local tab
history restores the existing panes without another read, while returning to a
different alert uses the exact scoped read and the same draft guards.

Same-document anchor changes must preserve the mounted view and all drafts,
perform no fetch and avoid a discard prompt because no form is being destroyed.
Distinguish an anchor within the unchanged view from the skeleton's existing
hash-route syntax, where a changed route can legitimately replace the view.
Handle both intercepted anchor links and native fragment navigation. When the
browser has already created a fragment history entry, annotate that entry with
its own history index; do not push a duplicate entry or overwrite the previous
entry's identity. Back/Forward must distinguish each retained entry, recover its
saved scroll position and keep unsaved text and input DOM intact. Preserve the
outgoing position before the browser's anchor scroll; canceled view-changing
history navigation must still restore the correct prior entry. A new branch
must discard stale forward-position mappings without aliasing retained entries.

Retain the shared shell, stable scroll positions, timezone and appropriate
keyboard focus across eligible page navigation. Preserve application, filters,
page offset/limit, expansion, selected evidence, durable approval operation and
safe return context. Different applications clear incompatible inspection and
selection according to the existing policy. Global/page search must continue to
leave form drafts alone. Search, refresh, inspector close and route changes must
not silently restart approval processing; saved operation restoration stays
GET-only and Resume remains explicit.

Programmatically populated initial form values must establish the same clean
baseline as server-rendered defaults. The operational `respond/honeypots.js`
file-creation initializer is a concrete example: assigning a suggested filename
must also establish its initial default value, so untouched setup does not look
like an unsaved edit. Later user changes must still become dirty. Apply this
principle to the skeleton's own form initializers; do not suppress dirty checks
or globally reset defaults after a user has edited a form.

Every private view must clean up its own timers, observers, pending reads and
event listeners when it is replaced. Repeated mount/cleanup must not duplicate
keyboard, save or approval-loop handlers. Owner/form initialization must be
idempotent for a newly mounted inspector and synchronize only untouched fields
after a confirmed save. Do not abort an already submitted write and claim it was
canceled; retain its uncertainty and reconcile through existing receipts and
revision/idempotency rules. Downloads, external links, sign-in transitions and
all audited write actions retain their existing native/API semantics. The
adjacent Open investigation action and quick inspector remain distinct, with
exact identity and return context in both paths.

This is a navigation improvement, not a new execution or authorization layer.
Preserve full existing operator authority and separately authorized external AI
administrator capabilities. Existing Claude Desktop routines, their prompts,
schedulers and credentials remain external and unchanged; opening a panel or
following a link neither launches a routine nor proves one ran. Do not add a
new per-action approval gate or narrow an external administrator's privileges
as part of this port. Existing authentication, Origin checks, audit and explicit
approval-preview/step semantics continue to govern the actions they already
protect. Source, service-token and MCP authority is not expanded.

The intended implementation ownership and verification targets are:

| Skeleton file | Implementation and acceptance responsibility |
| --- | --- |
| `public/app.js` | Extend the existing hash-route/view lifecycle with local inspector delegation, cancelable reads, shared dirty/pending guards, history/scroll/focus restoration and deterministic cleanup. |
| `public/triage.js` | Retained three-pane inspector, exact-target request generation and edit guards, keyboard tabs, contextual links, idempotent form mounting and the existing approval/selection lifecycle. |
| `public/triage.css` | Pane visibility, focus, loading/error and responsive workspace treatment; preserve the approved hierarchy and palette requirements. |
| `server/triage-service.js` | Implemented bounded inspection/evidence/history projections with application and admission-version binding; no GET mutation or imported workflow authority. |
| `server/private-application.js` | Implemented authenticated private read routes and opaque session viewer fingerprint; preserve response bounds, no-store, session/Host/Origin and machine-token denial. |
| `test/triage-ui.test.js` | Same-DOM draft preservation, zero-fetch tabs, exact single-read target switching, stale/edit/session failures, selection and approval preservation, and repeated cleanup/mount. |
| `test/triage-service.test.js`, `test/triage-http.test.js` | Exact scope/incarnation/history projection, limits, conflicts, unavailable reads, authentication and byte-for-byte unchanged decision/audit state after reads. |
| `test/navigation.test.js` | Shared router local delegation, cancellation, pending operations, Back/Forward, focus/scroll, failure fallback and cleanup across representative private views. |
| `docs/NATIVE-TRIAGE.md`, `public/technical-reference.md`, generated `public/technical-docs.js` | Keep shipped behavior, API vocabulary and evidence of verification synchronized. |

Before calling this refinement complete, use synthetic browser fixtures to
verify zero requests for repeated Summary/Evidence/History switches; unchanged
Summary input nodes and unsaved text; one bounded read on alert change; newest
response wins; late edits and pending/uncertain writes are preserved; failed,
wrong-session and wrong-incarnation reads keep the prior panel; and canceled
Back/Forward returns to the prior URL without a decision or duplicate prompt.
Exercise repeated cross-page navigation and inspect listener/timer/read cleanup,
active approval loops, downloads, native/API POST behavior, full investigation
return links, computed clean form defaults versus later edits, slow successful
historical reads, bounded read timeouts, same-document and native fragment
Back/Forward with unique entry indices and restored scroll, explicit refresh,
keyboard navigation and 390 px layout. Record
actual network request counts and retained decision/audit hashes, not just a
smooth-looking screenshot. Run the existing tests and complete repository
checks after implementation; documentation parity alone is not runtime proof.

### Implementation order and acceptance

1. **Contract fixtures first.** Add only synthetic mixed singleton/group,
   partial-page, critical, expired/recreated, unavailable and empty-application
   fixtures. Pin the mapping above and evidence/history schemas. Keep original
   closed version-1 and public-boundary tests intact.
2. **Read-only hierarchy and layout.** Port the five-column case/alert/evidence
   display, independent inspection/selection, controls, counts, disclosures,
   page search and responsive treatment. Keep existing authoring available
   until the new inspector preserves every action.
3. **Summary and safe authoring.** Move existing revision-bound forms into the
   inspector; preserve dirty-draft guards, truthful receipts and exact return
   context. Keep preview inert and reload/status restoration GET-only.
4. **Evidence and history.** Implement the reviewed private reads, explicit
   bounds/unknown states and exact-incarnation tests. Do not fill a tab with
   synthetic production-looking content while the contract is absent.
5. **Retained inspector and shared navigation.** Implement the planned view
   lifecycle, zero-fetch tabs, one-read target switching, draft/history guards
   and cleanup above. Keep full investigation and audited writes intact.
6. **Acceptance and release.** Run serial repository checks, public audit and
   docs parity, then browser checks at 1,280, 768 and 390 px. Use a synthetic
   private operator fixture; record no real customer data or credentials.
   Confirm static mode performs no new network access and no inspection,
   disclosure, search, selection or page-load action commits a decision.

Required behavioral coverage includes exact class-token mixed cases, one
actionable occurrence of every alert, zero finding checkboxes, deduplicated
header/member selection, partial and hidden-ancestor selection, and exact
shown/matching/stored counts. Exercise more than 100 selected candidates and
more than 4,000 retained matching candidates without a user-selection cap;
internal writes remain bounded at 100. Test frozen item review, changed/expired/
missing/recreated skips, actor/application binding, atomic rollback, lost-response
replay, pause, explicit resume and reload without a step.

Verify source/record collisions across applications, stale evidence references,
malformed/unavailable reads, exact audit projection from multi-alert operations,
new-arrival history stability, safe read-only status errors and no GET
acknowledgment. Confirm full filters, page, timezone and operation context across
case expansion, evidence disclosure, inspector tabs, close, form results and
full-alert handoffs. Verify that each adjacent **Open investigation** link targets
its own alert, keeps any selected evidence and a safe exact return context in
normal, keyboard and modified-click navigation, and remains separate from quick
inspection. Case evidence and agent-authored notes must respect existing scopes
and permissions, with no mutation caused by opening either view. Check text labels
as well as color, no document overflow, keyboard focus, unsaved edits, and independence of severity, workflow and
measured incident health.

The workspace implementation preserves the canonical single-record alert model.
Case-file attachments, independent agent-note associations, a new rule engine
and autonomous AI execution remain outside this implementation.

Synthetic acceptance uses the skeleton private server, with no production
records or credentials. It checks responsive layouts at 1280, 768 and 390 CSS
pixels, retained Summary input identity and unsaved text, zero requests across
tab changes, one aggregate read on alert selection, exact investigation return
context, and unchanged canonical/workflow state during browsing. Automated
coverage exercises read races, stale versions/sessions, fixed history snapshots,
uncertain writes, explicit replay, cross-form discard cancellation, browser
history/focus/scroll, bounded reads, selection and approval recovery.
