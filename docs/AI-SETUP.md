# Set up your private SOC with an AI agent

Use **Agents → Service Access** in the signed-in application. Choose a client,
review the permissions, issue a short-lived service identity, and generate a
configuration using your private origin and the absolute checkout/token-file
paths on the machine running that client. This is a connection to the SOC's
existing tools, not an agent hosting service or an automatic model subscription.

The recommended deployment is **Tailnet-only HTTPS**, with the SOC process
bound to loopback and access restricted by tailnet grants/ACLs. Never enable
Funnel, public port forwarding, or an Internet-facing MCP proxy to make an
agent connection work. Better Auth still protects human sessions; service
credentials independently authorize agent requests. Network membership is not
application authorization. See [authentication](AUTHENTICATION.md) and
[private deployment](GUIDED-SETUP.md#13-private-deployment-and-recovery-guide).

## 1. Decide where the client runs

The supplied MCP server uses **stdio**: the client starts a local Node process,
which calls fixed SOC service endpoints over loopback or approved private HTTPS.
It does not listen on a remote MCP port. A client elsewhere on your tailnet
needs its own checkout, supported Node runtime, private token file, and network
access to the exact configured SOC HTTPS origin. A path on the SOC host is not
automatically a path on the client host. Do not use localhost for a different
machine: localhost means the machine executing the MCP process.

| Client choice | Connection approach |
| --- | --- |
| Claude Code / compatible local Claude host | Local stdio command with an arguments array; use the UI's client-specific configuration and the client's own approval controls |
| Codex local CLI/app | TOML MCP server configuration or CLI registration; the local host launches the stdio process |
| Hermes | Local `mcp_servers` configuration; retain tool approval and disable unnecessary tools |
| OpenClaw | Local outbound MCP configuration under `mcp.servers`; a cloud-installed runner still needs private reachability and local token custody |
| Perplexity / Grok and other hosted assistants | Use only an explicitly documented local/private connection mode supported by the selected product/version; a hosted remote-MCP URL field cannot launch this stdio server |
| Other model or client | Verify the host's MCP stdio support and reachability first. Model choice alone does not confer MCP support |

These are configuration paths, not certifications that each client/version has
been tested against a real vendor account. The generated UI instructions state
the selected client's limitations. Keep existing client configuration; merge
only the named SOC entry, review it, and restart/reload the client as required.
Never replace an entire client configuration blindly. GUI clients may need an
absolute Node executable path if their PATH differs from your terminal.

The SOC contains no model API-key entry or model execution runtime. A compatible
local host may use a remote model such as Grok if that host supports it. The
model/provider choice and its credentials belong to that host, not the SOC.
**Private network access does not keep AI conversations local.** Registry
names, configuration, prompts and tool responses may be sent to the selected
model provider by the host. Review retention, training, region, classification
and organizational policy before granting access. Do not send raw telemetry,
documents, passwords, OTPs, backup codes or source credentials in prompts.

Official client references (review when upgrading):

- [Claude Code MCP](https://code.claude.com/docs/en/mcp)
- [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- [Hermes MCP configuration](https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference)
- [OpenClaw MCP](https://docs.openclaw.ai/tools/mcp)

## 2. Keep the three identities separate

1. **Your operator account:** Better Auth email/password and optional TOTP 2FA.
   This authorizes the browser. Never copy its cookies to an AI client.
2. **The agent's service identity:** expiring bearer credential created in
   Service Access, with exact read/command scopes. This authorizes MCP's fixed
   service calls. It is not a source ingestion credential.
3. **Each data source's credential:** one-time source token or protected vendor
   credential used by its collector/sender. Provision it in the relevant human
   workflow, not in the AI chat or MCP tool arguments.

A managed record in **Agents → Agents** is another concept: it describes an
agent and its prompt/lifecycle metadata. Creating that record does not launch
Claude, Codex, Hermes, OpenClaw, a scheduler or a collector, and does not issue
the service identity described here.

Store the service value in a canonical absolute owner-only regular file outside
the checkout. On supported Unix hosts, restrict the file to mode 0600 and its
parent directory to owner-only access; do not use symbolic links. The generator
accepts the **file path**, never the secret value. Only the server-issued value
belongs in that file, not a JSON object or an Authorization header. The MCP
process reads it before each request. Issuance/rotation reveals it once; if lost,
rotate again through the UI. Do not paste it into a transcript or ask the agent
to reconstruct it. Keep it out of Documents, source control and shared folders.

## 3. Start read-only; explicitly approve setup writes

For discovery and checking, select `connector:read` and optional `setup:read`.
The general default also includes `agents:read` and `governance:read`; remove
those if this task does not need them. Prompt bodies require separate
`prompts:read` and are not necessary to set up a data source.

To let an agent prepare a source, explicitly review these additional scopes:

| Scope | Authorized preparation |
| --- | --- |
| `connector:app.register` | Register an approved application and its environments |
| `connector:source.setup` | Create a manifest-backed source declaration |
| `connector:source.test` | Validate a configured source; sample validation does not ingest it |

Updating an existing source needs separately approved `connector:source.update`.
Pause, resume, archive, removal and revocation each have independent scopes and
are not prerequisites for new-source setup. Do not select every write permission
just to avoid a denial. All service grants cover the **whole deployment**, not
one selected application; an app name in the chat is not a server-side access
restriction. Do not grant these permissions if that authority is too broad.

The default expiry is 24 hours; choose a shorter task window when practical.
An existing identity's scopes cannot be silently expanded: issue a reviewed new
identity and revoke the old one. Rotation invalidates the old value immediately
but does not extend expiry or change permissions. Revoke setup access when done.

Credential issuance/rotation, host enrollment, source activation, agent
creation/capability expansion/resume/restore and prompt activation remain
unavailable to the shipped private MCP service. A prompt, approval checkbox or
client setting cannot override that server boundary. Stop for the human step.

## 4. Ask the agent to run the setup workflow

The MCP server publishes the user-invoked prompt **`setup_application`**, with
no arguments. Where the client exposes MCP prompts, choose it explicitly.
It returns this public runbook; choosing it performs no request to your SOC,
starts no collection and grants no permission. Clients without prompt support
can use the setup text generated by Service Access or ask:

> Read `soc://documentation/ai-setup`, `soc://documentation/agent-guide` and
> `soc://documentation/guided-setup`. Inspect my registry and setup evidence
> using only granted tools. Ask which application, environment, data source,
> destination screens and retention policy I intend. Propose a bounded setup
> plan and request approval before changes. Prepare only approved registrations
> and source tests. Stop for human credentials and activation. Check real
> delivery afterward and report verified facts, unknowns and remaining steps.

The agent should follow this sequence:

1. **Read contracts.** Read the above resources, connector manifest/runtime and
   relevant vendor/live guide. Discover the actual tools; do not invent methods,
   fields, source kinds or scanner drivers based on a menu label.
2. **Establish scope.** Ask for the web application and environment, what emits
   data, who owns it, desired screens, collection cadence, approved network
   targets, retention and acceptable provider disclosure. Never request secrets.
3. **Inspect first.** Use `connector_snapshot` to find existing apps, manifests,
   declarations and stable IDs. Use `setup_guides` and `setup_check` when
   `setup:read` is granted. A missing grant is not proof of missing data. Reuse
   valid existing registrations instead of creating duplicates.
4. **Choose a working path.** Sentry live collection, reviewed vendor export
   import, custom canonical push and Trivy report import are different paths.
   Eleven legacy scan templates are non-executing schemas, not working drivers.
   A requirement for an unimplemented collector is a design decision, not a
   reason to bypass source-test failure or pretend the screen is populated.
5. **Present the change.** State exact app/environment, manifest, configuration,
   optional credentials by reference only, destination support, permissions and
   human checkpoints. Wait for approval. Display proposed action names; do not
   treat reading this runbook as blanket mutation authority.
6. **Prepare approved declarations.** Use `connector_command` with the closed
   command request shape from the current contract, a unique request ID,
   timestamp and required revision fields. Refresh before editing. Preserve the
   request ID/body only for an uncertain retry of the *same* operation; a revised
   intent needs a new ID. On conflict, reread and reconcile, never force a write.
   Hostless web-app sources do not require inventing a collector host.
7. **Validate.** Run only the selected path's implemented test. A canonical
   source may need a bounded, reviewed, redacted canonical sample. Validation
   does not ingest that sample and does not prove vendor connectivity or ongoing
   delivery. Do not transmit raw log payloads or protected material through MCP.
8. **Hand off secrets and activation.** Direct the person to the matching
   protected source or live-monitoring UI. They handle vendor credentials,
   activation and one-time sender credentials. Live collection setup, vendor
   imports, mapping recipes, document upload and saved-guide mutations are not
   tools in this MCP facade. Explain these steps instead of calling a guessed
   endpoint or using browser cookies as a workaround.
9. **Commission real delivery.** The operator or approved external collector
   sends real authorized data through the existing ingest/import path. Source
   activation alone is not delivery. No fabricated event should be used to turn
   an empty SOC green. Installing/running a collector outside MCP needs a separate
   explicit host-level authorization and reviewed credentials/egress policy.
10. **Check and report.** Use `setup_check` for the exact app/environment/path
    and source, then have the person inspect the destination screen and filters.
    Distinguish retained records from current freshness, a quiet successful poll
    from missing delivery, and Slack acknowledgment from a person's receipt.
    State configured, verified, waiting, failed and unverified items separately.
11. **Close access.** Ask the operator to revoke task-only service access or
    deliberately reduce it by issuing a replacement read-only identity. Document
    ownership, restart, monitoring and backup responsibilities without secrets.

## 5. Diagnose connection problems without widening exposure

- **Client does not list the server:** check the configuration format for that
  client, Node executable, absolute paths and client restart. JSON is not TOML
  or YAML. A successful config preview is not proof that the file was installed.
- **Process starts but a tool fails:** inspect the client error, selected private
  origin and token-file permissions locally. Do not copy sensitive stderr or
  token-file contents into a public issue. MCP stdout must remain protocol-only.
- **401:** invalid, expired, rotated or revoked service credential. Reissue or
  rotate through the operator workflow; never retry with an operator cookie.
- **403:** missing exact scope or permanently disallowed action. Review the task
  with the human. Do not widen all scopes or change endpoints to get around it.
- **409:** stale revision, invalid lifecycle transition or conflicting change.
  Read current state and reconcile the intended operation before a new attempt.
- **429:** respect the rate limit and stop aggressive retries. Service identities
  permit at most 120 recognized operations per minute.
- **Empty data with a working connection:** check source/path support, activation,
  ingestion receipts, selected filters and retention. No connection assistant
  can create an upstream collector that has not been implemented.

Service Access shows retained authorization attempts for the selected identity.
A successful authorization is not proof the operation completed, the client
received the response, the model ran, or data arrived. Pair it with the actual
tool result, canonical command audit and source-specific evidence. The latest
100 visible audit entries are bounded history, not a complete forensic ledger.

Repository tests cover protocol discovery, prompt/resource retrieval, denied
and scoped requests, configuration generation and setup evidence. Live vendor
client interoperability and tailnet isolation must be verified in the adopter's
environment. Passing these tests does not approve a production deployment.
