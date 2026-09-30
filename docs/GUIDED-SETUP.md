# Guided setup: monitor your application and check the evidence

The private application includes **Sources → Guided setup**, with two related
workflows: **Monitor my application** and **Check my setup**. They organize the
existing connection paths around a registered application and environment.
They do not install arbitrary code, invent telemetry, run a scanner, or grant
an automation agent access merely because a guide exists.

## 1. Before starting

Run the private application with its persistent private state directory and sign
in as an operator. Keep the listener private, with Tailnet HTTPS for remote
access. The static preview explains the workflow but makes no requests and
cannot save progress or inspect your systems. All human operators currently
have deployment-wide access; a selected application is a data binding, not a
new authorization boundary or tenant.

Have these decisions ready:

- The web application's name and registered environment.
- What you want to collect and who operates its producer.
- Whether the data already exists as a vendor export, a Trivy report, canonical
  events from your own application, or a Sentry Cloud project.
- Where the producer keeps its credentials. Never paste secrets into a guide,
  sample, source label, issue, prompt, or generated configuration.

The guide does not require a collector host for application-scoped ingestion.
Host-based scanner integrations retain their own enrollment requirements.

## 2. Monitor my application

1. Open Sources → Guided setup. Select an existing registered application and
   one of its environments, or use the registration form for a new application.
   Registration creates a registry entry, not a monitor or scan.
2. Choose the connection path below. Save the guide before leaving it for a
   connection panel. Saving retains only application/environment/path/source
   identifiers and lifecycle timestamps, not credentials, sample bytes, or
   an operator's claim that setup succeeded.
3. Follow the connection step. The linked panel carries the selected application
   and environment where supported, and offers a return link to the saved guide.
   Check the displayed binding before submitting any form. The server still
   validates every operation; URL preselection is not authority.
4. Return to the saved guide and select the source actually created for that
   application, environment, and path. A guide can be saved before a source
   exists. A configured source still needs its normal validation/activation.
5. Save the source selection, then run Check my setup. Read each result rather
   than treating a saved guide or registered source as proof of collection.
6. For a push or import path, send/import your first real, reviewed event or
   report. For Sentry, wait for a completed collection window. Quiet successful
   polling and having retained events are deliberately separate checks.
7. Open the suggested observation/screen links. Confirm the intended app and
   source. If notifications are configured, use the explicit test action in
   Live monitoring and independently inspect the destination channel.

Saved guides can be resumed from the list or their local bookmark. They survive
a clean application restart with the same private state directory. Selecting a
different path requires a compatible source. Deleting a guide removes only its
saved navigation choices; it does not pause, revoke, archive, or remove an app,
source, connection, credential, event, document, or notification.

## 3. Choose the right collection path

| Path | Use it when | What completes the connection | What it does not do |
| --- | --- | --- | --- |
| Sentry live monitoring | Your app already reports errors to Sentry Cloud | Private read-only access, managed source, completed collection window | No self-hosted Sentry origin, generic vendor poller, environment filter, or security verdict |
| Vendor export/import | You have a supported export or successful API response page | Install the reviewed preset, configure/test/activate its source, preview/import the file | No vendor login, automatic polling, signature receiver, or ongoing collection without an external producer |
| Custom/canonical push | Your app or collector can send normalized records | Choose/install a data-only definition, configure/test/activate, retain the one-time source credential, send a valid batch | No executable plugin installation or automatic mapping of every arbitrary upstream format |
| Trivy report import | You already ran an authorized Trivy package/vulnerability scan | Configure/test/activate the Trivy importer, upload its supported report | No scan execution; zero reported vulnerabilities does not prove complete coverage or a clean application |

See [live monitoring](LIVE-MONITORING.md), [vendor imports](VENDOR-INTEGRATIONS.md),
and the [integration contract and sender guide](INTEGRATION-REVIEW.md) for the
exact data, permission, capacity, and delivery boundaries of each path.

## 4. Check my setup is read-only

The check reads local registry, retained telemetry, coverage metadata, and live
monitoring status. It does **not** make a Sentry request, send a Slack message,
activate a source, issue a token, write sample events, or run a scan. A working
browser request proves the signed-in operator can reach this SOC endpoint; it
does not prove that a remote producer can reach the ingest endpoint.

Results use four states:

- **Pass:** the explicitly described local evidence exists at the check time.
- **Waiting:** the next setup or delivery step has not been demonstrated.
- **Attention:** evidence indicates an inactive, incompatible, failed, stale,
  or otherwise incomplete condition that needs investigation.
- **Not applicable:** the selected path does not implement that capability.

There is intentionally no unconditional “production ready” badge. A successful
historical import is not ongoing collection, a poll with no errors is not a
security clearance, and Slack's acknowledgment is not proof that a person saw
the intended channel message.

## 5. What each check means

| Check | Evidence and limits | Next action when incomplete |
| --- | --- | --- |
| Application/source binding | The selected registered application, environment, source, and connection path agree | Choose the correct saved guide and compatible source; do not reuse another app's source/token |
| Source activation | The source is currently active, not merely configured or historically used | Complete the existing test/activation workflow, or investigate pause/archive/revocation |
| Accepted observations | Retained canonical records exist for this exact source/application | Deliver a real batch/report; a validation sample never counts as telemetry |
| Collection | For live Sentry, completed-window/checkpoint health; for push sources, declared cadence and local delivery evidence | Inspect current health and producer logs; a manual import cannot prove a scheduled collector exists |
| Screen population | Supported projections and retained record kinds, rather than manifest target labels alone | Open the matching destination and inspect its filters; unsupported native workflows remain unsupported |
| Notification provider | Only the supported live path's actual delivery state | Configure optional Slack, explicitly send a test, and inspect delivery state; the check sends nothing |
| Human notification confirmation | Not inferable from a successful outbound request | Independently open the intended channel and verify the expected message |

Checks are timestamped snapshots. Refresh after changing setup or delivering
events. Persisted selections are not cached “pass” results. Retention may remove
old records, a credential can later be revoked, and collection can become stale.
Opening or resuming a guide must not imply that an earlier successful state
still holds.

## 6. Data handling and collaboration

The new private file is `setup-guides.sqlite` with possible SQLite journal/WAL
companions. It belongs in the existing owner-only state directory outside the
checkout and is part of whole-directory backups. It holds at most 200 saved
guides. The catalog revision is checked on mutations, so two operators cannot
silently overwrite each other's saved selection. A conflict requires refreshing
and reviewing current choices before saving again.

Application/environment bindings are immutable for a saved guide. Create a new
guide for another binding. A path/source change is explicit and validated.
Duplicate guides for the same application/environment/path are refused; resume
the existing guide instead. Unknown fields, including attempts to store a token
or raw sample, are refused. Guides are shared with the deployment's human
operators, not private per-user notebooks.

No guide uses browser persistent storage for credentials or progress. Unsaved
forms are protected against accidental navigation/refresh; save choices or
discard the draft before leaving. Follow each connection panel's separate
one-time-secret instructions. Saving a guide does not save those secrets.

## 7. Human HTTP API

All endpoints are private same-origin browser-session endpoints. Machine bearer
credentials do not authorize them, even when combined with a browser cookie.
Mutations require the configured same origin. Payloads are bounded and exact;
do not add undocumented metadata or use these endpoints as generic storage.

- `GET /api/v1/setup` returns `schemaVersion`, global `revision`, `plans`, and
  compatible source `choices`.
- `POST /api/v1/setup/plans` accepts `expectedRevision`, `appId`, `environment`,
  `path`, and optional `sourceId`. Path is `live`, `vendor`, `custom`, or `trivy`.
  It returns the current revision and created plan.
- `PATCH /api/v1/setup/plans/:id` accepts `expectedRevision` and an explicit
  `path` and/or `sourceId` update. `sourceId: null` clears the binding.
- `DELETE /api/v1/setup/plans/:id` accepts `expectedRevision` and removes only
  that saved guide.
- `GET /api/v1/setup/check` accepts exactly one `appId`, `environment`, and
  `path`, plus optional `sourceId`. It returns `checkedAt`, binding fields,
  `checks`, `destinations`, and a qualified `summary`.

Each check contains `id`, `title`, `state`, `detail`, and optionally a local
`href`. Each destination contains `title`, `href`, and `detail`. Consumers must
show the qualified evidence rather than collapsing the response into a boolean
that hides waiting, unsupported capabilities, or unverified human confirmation.

## 8. Recovery and verification

Use the same private directory after clean restart. Follow the existing
[unclean-shutdown recovery procedure](LIVE-MONITORING.md#12-secret-storage-retained-data-and-backups)
if a confirmed stale runtime lock blocks startup; never blindly delete a lock,
database, encryption key, or application state to make a check turn green.

The setup layer does not replace process supervision, independent outage
monitoring, a tested backup/restore process, source-specific credential rotation,
or a first real-account commissioning test. Test bad bindings, paused sources,
quiet successful polls, failed polls, duplicate delivery, missing notifications,
saved-guide restart, stale-revision conflicts, and refresh during an unsaved
draft before relying on the workflow operationally.

## 9. Map a source that is not in the vendor list

Open **Sources → Map a custom source**. This is a bounded, explicit field mapper,
not a generic collector or an executable plugin system. It supports all 29
canonical record kinds when the selected source's installed manifest permits
them. Vendor presets and Trivy retain their dedicated reviewed importers.

1. Register your application/environment and configure a canonical source or
   an installed data-only custom definition. Select that exact binding in the
   mapper. A configured or paused source can be previewed; delivery still needs
   an active source and its own ingest credential.
2. Remove credentials, private identifiers, and unnecessary content from a
   real representative JSON/NDJSON sample. Acknowledge that review before
   inspecting it. Secret-bearing key names are rejected, but messages, URLs,
   IDs, and arbitrary free text can still contain secrets. There is no automatic
   redactor or malware scanner. Samples and recipes are not persisted here.
3. Inspect field paths. The response contains JSON Pointer paths, observed
   scalar types, and presence counts, not a copy of the raw values.
4. Select one canonical kind. Map the original upstream event identifier and
   original observation timestamp from paths, then map each required payload
   field. Other payload mappings may use a path or a literal constant. Optional
   extra fields must be explicitly named scalar mappings; unmapped input is
   omitted. Optional retained fields are collapsed until needed. Supported
   values/enums are shown in the catalog.
5. Preview and inspect the recipe, complete canonical batch, and separate first
   normalized record for the source's existing sample-validation form. Missing
   fields, invalid values/times, conflicting duplicate identities, secret-key
   paths, unsupported kinds, and size/depth overruns reject the whole preview.
   No partial records are imported. Identity and ordering are deterministic;
   repeated records do not become new incidents just because preview ran again.
6. Export the reviewed text into your own owner-only external files. Reapply a
   recipe offline with the command below. The CLI does not contact the SOC or
   verify that its bound source still exists, is active, or has the same driver.
7. Inspect the output, then use the existing canonical sender/outbox with the
   source credential in a separate private token file. Return to Check my setup
   and inspect the ingest receipt and retained observations. Scheduling upstream
   acquisition and reacting to format changes remain the producer's job.

```sh
npm run --silent map:events -- --recipe /absolute/private/recipe.json --file /absolute/private/events.json
```

This prints only the batch to stdout; it does not send or persist it. Both input
files and their immediate parent directory must be owner-only, outside the
checkout, canonical absolute paths, and free of symlinks/hardlinks. Do not use
shell command substitution to pass credentials or copy sensitive output into
an agent transcript. Recipe changes can change retained facts; review them
against known inputs and keep operational versions privately.

Limits: UTF-8 JSON/NDJSON, 1–100 object records, 512 KiB input, nesting depth 10,
20,000 nodes, 512 scalar field paths, 64 KiB recipe, and 1 MiB canonical batch.
Pointers select own scalar leaves (including numeric array indexes); there are
no wildcards, templates, expressions, coercion scripts, enrichment calls, or
network destinations. Split larger exports before processing and preserve the
original stable event identity/time.

The same-origin human API is:

- `GET /api/v1/source-mapping`: registered bindings, compatible sources,
  kinds with required/optional payload fields, enums, and limits.
- `POST /api/v1/source-mapping/inspect`: `{text}`; returns field metadata.
- `POST /api/v1/source-mapping/preview`: `{appId,environment,sourceId,text,recipe}`;
  returns normalized `recipe`, `batch`, and `summary` with `imported: false`.

A v1 recipe has `schemaVersion: "1"`,
`documentType: "source-mapping-recipe"`, `appId`, `environment`, `sourceId`,
`kind`, `upstreamId: {path: "/original-id"}`,
`observedAt: {path: "/original-time"}`, and `payload` mappings. Each payload
mapping is exactly `{path: "/field"}` or `{value: scalar}`. Optional
`payload.fields` maps explicit names to the same selector shape. The request
binding and recipe binding must agree. Preview validates current registered
scope and driver eligibility; it never activates, ingests, or contacts a vendor.

## 10. Connect an implementation agent

For a complete client-specific walkthrough, permission checklist and agentic
setup sequence, read [AI-assisted private setup](AI-SETUP.md), available over MCP
as `soc://documentation/ai-setup` and the fixed user-invoked `setup_application`
prompt. Reading the prompt performs no operation. Use the Service Access client
selector to generate the supported format; hosted-only clients cannot launch
the supplied local stdio process. Do not make the SOC public to work around this.

Open **Agents → Service Access**. The four-step assistant helps you choose a
purpose, issue a credential, generate local connection instructions, and inspect
authorization evidence. Registering an agent, enrolling its heartbeat, revising
its prompt, and authorizing a service client are separate operations. None
launches a model, installs a scheduler, or grants credentials to an external host.

1. Choose read-only registry inspection or setup observation. The latter adds
   `setup:read` explicitly; it is not part of the normal default scopes. Prompt
   bodies require a separate deliberate `prompts:read` grant. Optional command
   writes need explicit review and approval in the external agent host as well.
2. Issue a named expiring identity. Secure its one-time token in an owner-only
   regular file outside the checkout, then clear the displayed token. Do not
   put it in the agent prompt, configuration JSON, arguments, environment value,
   Documents, logs, or source control. Lost issuance responses require rotation;
   there is no token readback.
3. Select the identity and enter the actual private origin, absolute checkout
   location, and absolute token-file path. Generate secret-free MCP client JSON
   and launch instructions. Generation is local only: the browser cannot inspect
   the agent host's filesystem, verify a token file, or install/configure a client.
   Windows paths receive JSON arguments, not a misleading POSIX shell command.
4. Configure your MCP-capable host, start the shipped stdio client, and request a
   permitted read. Refresh evidence for that identity. A retained successful
   authorization newer than issuance/rotation proves a server authorization
   event, not completed tool execution, response receipt, model health, or a
   continuously running agent. `lastUsedAt` alone is not success: denied calls
   also update it. Bounded audit history may no longer contain old evidence.

`setup_guides` takes `{}` and reads saved selections/compatible source choices.
`setup_check` takes `{appId,environment,path,sourceId?}` and returns the same
qualified local diagnostic evidence as the operator check. Both require the
optional installation-wide `setup:read` scope and a private service token file;
neither works in tokenless workbench mode. They call only:

- `GET /api/v1/service/setup`
- `GET /api/v1/service/setup/check?appId=…&environment=…&path=…&sourceId=…`

There are no machine guide mutations, source-mapping uploads, private operations
checks, document uploads/downloads, credential reads, or live-monitoring
management added to MCP. Public instructions are available at
`soc://documentation/guided-setup`. All seven tool contracts and lifecycle rules
are in [the agent guide](AGENTS.md#optional-mcp-facade). Every scope is
deployment-wide, not per-app tenancy. Rotation invalidates the old credential
immediately without extending expiry; changing scopes requires a new identity.

## 11. Guided document and evidence intake

Open **Documents** to upload supported files, assign ownership/review status,
and maintain immutable versions. Select an existing application from the
searchable registry, or leave the document shared. An owner is a tracking
label, not a permission assignment. A review date does not schedule a reminder.

Choose a registered risk or attestation from its searchable picker when
appropriate. New or changed bindings are checked by the server. Risks and
attestations are currently **deployment-wide**, without application ownership;
selecting an app for the document does not scope or reassign the linked record.
Case and policy references are explicitly unverified external labels, not
validated local objects. A link does not prove that a claim is supported or
automatically transition a risk/attestation.

After upload, inspect the exact document ID, immutable version, filename, byte
count, SHA-256, uploader, and saved timestamp. The digest establishes byte
identity, not authenticity, safety, compliance, or independent verification.
Use metadata editing for owner/review/status/link changes; use **Upload a new
version** to retain replacement bytes without removing old versions. Downloads
remain authenticated attachments. Do not upload credentials or trust an upload
as malware-scanned evidence.

If a historically linked app or governance record disappears, the old tuple is
shown as missing and retained. An unrelated metadata edit or new file version
must not silently clear/reassign it. Explicitly changing any part of the binding
requires a currently valid new tuple; clearing a link is a deliberate edit.
Normal document revision checks, archive/restore, retention limits, and download
rules still apply. Mapping a canonical `evidence.receipt` never uploads a file
or creates an authored attestation; those remain separate workflows.

## 12. Explain an empty screen

Supported private empty/error screens expose a compact **+** beside the page
heading. Expand **Explain this screen** to read the coverage contract, compatible source
declarations, active-source count, and matching retained-record count. This is
opt-in and read-only: opening the panel never polls a vendor or fabricates data.

No producer configured, configured but inactive, no retained matching data, and
data present but not suitable for this particular projection are different
situations. Counts are scoped to supplied application/source filters, but are
not the full view query: time windows, native detail selectors, and specialized
projector requirements can still leave a view empty. Only validated Trivy report
imports populate its latest-report view; guided links scope the actual report
query and importer to the selected application/source. Governance, documents, and agents use
their own authored-management workflows, not generic telemetry imports.

At most 50 compatible declarations are listed; the omitted count is explicit.
Historical retained records can outlive a source. Active configuration is not
freshness proof, and record-kind overlap is not proof of a native engine or
vendor-specific workflow. Use Check my setup for source-specific delivery
evidence and Sources → Observations to inspect retained facts and filters.

The human-only endpoint is `GET /api/v1/setup-assistance/screen` with exact
`route`, optional `tab` for `/scans`, and optional `appId`/`sourceId`. Unsupported
views, duplicate/unknown query fields, and invalid scope are rejected. There is
no diagnostic mutation or external connectivity test.

The **Setup checklist** in the page header can be reopened after dismissal.
On an unfiltered empty private view it offers a beginner path through private
access, account security, an application/environment, sources, real delivery,
documents and optional AI assistance. Its personal checkmarks record what you
marked in this loaded page (a reload resets them); they do not prove authentication strength,
tailnet isolation, data delivery or production readiness. Provider failures and
filtered empty results must not be interpreted as a brand-new installation.
Use **Check my setup** and independent network/backup checks for real evidence.

## 13. Private deployment and recovery guide

On a brand-new installation, open Sign in directly on localhost and complete
the one-time **Create your administrator account** form first. It permanently
closes after initial provisioning. Use the local account CLI if the server is
already configured for a private Tailnet origin; there are no default credentials.

Open **Sources → Private deployment**. Work through the six steps: private
access, account/persistent state, continuous operation, real data/delivery,
backup/restore, and deliberate crash recovery. **Check local deployment facts**
reads only local configuration, state-entry metadata, filesystem free space,
and telemetry counters. Its human-only endpoint is
`GET /api/v1/setup-assistance/operations` with no query parameters.

The UI labels observed facts separately from manual verification. Loopback
binding and a configured HTTPS origin do not prove valid certificates, tailnet
ACLs, lack of public proxies/forwarding, or internet inaccessibility. Keep this
SOC inside your tailnet; do not expose it with public Funnel, router forwarding,
or a public proxy. Independently verify isolation from outside the tailnet.

Current owner-only state files do not prove encrypted disks/backups. Available
bytes are a point-in-time measurement, not disk monitoring or a growth forecast;
under 100 MiB raises attention, not a promise that any larger volume is sufficient.
Telemetry limits exclude separate auth/document storage. No secret file contents
or private directory paths are returned by this diagnostic.

Configure process supervision and a separate private watchdog: the SOC cannot
alert while its own process is down. Stop cleanly before taking a coordinated
whole-state backup, retain the matching monitoring encryption key and databases,
and test restoration in isolation. Keep the only known-good backup. Prevent a
restored instance from polling/notifying until collection ownership is deliberately
transferred. Read the live-monitoring operations guide for exact current startup
and lock recovery behavior; this assistant does not install a daemon, modify
the tailnet, stop processes, delete locks, back up files, restore state, or certify
that an independent restore was successful.
