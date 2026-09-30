(function (root) {
  "use strict";

  function element(tag, text, className) {
    const result = document.createElement(tag);
    if (text !== undefined) result.textContent = String(text);
    if (className) result.className = className;
    return result;
  }
  function button(label, action) {
    const result = element("button", label, "resource-action"); result.type = "button";
    if (action) result.addEventListener("click", action);
    return result;
  }
  function link(label, href) { const result = element("a", label, "resource-action"); result.href = href; result.style.display = "inline-flex"; result.style.margin = "4px 6px 4px 0"; return result; }
  const CLIENTS = Object.freeze({
    generic: { label: "Other local stdio MCP client", format: "json", docs: null, instructions: "Merge the bb-soc entry into a client that explicitly supports launching local stdio MCP servers. mcpServers JSON is a common format, not a universal standard; check your client's schema before saving." },
    claude: { label: "Claude Code — local MCP", format: "json", docs: "https://code.claude.com/docs/en/mcp", instructions: "Use the generated claude mcp add command from the intended project directory (local scope), or merge the JSON into that project's .mcp.json and approve the server. Check /mcp in Claude Code. This is not a claude.ai web connector URL." },
    codex: { label: "Codex — local MCP", format: "toml", docs: "https://learn.chatgpt.com/docs/extend/mcp?surface=cli", instructions: "Merge this TOML table into your user Codex config.toml, or a trusted project's .codex/config.toml. Do not create a second table if bb-soc already exists. Reload the client and inspect its MCP server list. This is a local process configuration, not a hosted connector." },
    hermes: { label: "Hermes — local MCP", format: "yaml", docs: "https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference", instructions: "Merge bb-soc under mcp_servers in the active Hermes profile's config.yaml (the default is ~/.hermes/config.yaml). Keep existing entries. Start Hermes or use /reload-mcp, then inspect the discovered tools." },
    openclaw: { label: "OpenClaw — local MCP", format: "openclaw", docs: "https://docs.openclaw.ai/tools/mcp", instructions: "Merge bb-soc under mcp.servers in the active OpenClaw config, or use Settings → MCP → Add server → Stdio. The process runs on the Gateway host, so that host needs this checkout, Node and the private token file. Reload the runtime that owns the connection and use openclaw mcp doctor bb-soc --probe for protocol discovery." },
    perplexity: { label: "Perplexity — check local connector support", format: null, docs: "https://www.perplexity.ai/help-center/en/articles/11502712-local-and-remote-mcps-for-perplexity", instructions: "Check Perplexity's current local-connector availability for your app, plan and administrator policy. This page does not claim a verified Perplexity installation flow. A compatible local bridge must launch the stdio process on a host inside your private network; a custom remote-URL connector cannot consume this bridge. Use a verified local MCP client below if local support is unavailable." },
    grok: { label: "Grok web — no direct private connection", format: null, docs: "https://docs.x.ai/grok/connectors/custom-mcp-tunneling", instructions: "Grok's documented custom web connector requires an internet-reachable MCP endpoint. This application intentionally provides no public MCP listener or tunnel. Use a local MCP-capable agent that supports your chosen model provider instead; selecting a Grok model is different from connecting the Grok website. Confirm that host's model and tool support separately." }
  });
  function setupPrompt(scopes) {
    return [
      "Help me set up my private Bulwark Black SOC using the bb-soc MCP connection. Start with the setup_application MCP prompt if your client supports it; otherwise read soc://documentation/ai-setup, soc://documentation/agent-guide and soc://documentation/guided-setup.",
      "Keep the SOC private: loopback for local use, or Tailnet HTTPS with access controls. Never publish it, enable Funnel, open router ports or create a public tunnel. Private networking does not stop the model provider from receiving tool results: ask me what data may leave this network, then read only the approved minimum.",
      "This selected identity currently has these exact scopes: " + scopes.join(", ") + ". Treat scopes as an upper limit, not approval for every possible action. Never ask me to paste service credentials, passwords, MFA codes, vendor keys or document contents into chat. Do not read the token file with another tool.",
      "Discover available tools and resource contracts. Use connector_snapshot when connector:read is granted and setup_guides when setup:read is granted. Ask which web application, environment and real data source I want to monitor. Reuse matching existing records; do not duplicate them or invent events, source IDs, credentials, successful tests or monitoring coverage.",
      "Explain which integration path is actually implemented: live Sentry collection, reviewed vendor export/import, custom canonical events, or a Trivy report import. A source registration is not a running collector. Ask for a sanitized representative event only when mapping is needed; explain which screens its record kinds can populate and which remain unsupported.",
      "Propose exact app.register, source.setup, source.update or source.test requests from the published connector contract, including current revisions, configuration, retained-data effect and required scopes. Wait for my explicit approval before each mutation. If a required scope is missing, stop and ask me to review that exact grant in Agents → Service access; never work around it with browser cookies, shell, direct database edits or another credential.",
      "Use connector_command only for the approved request and only if its exact scope is granted. Re-read state after a successful change and inspect command history. Source activation, source-ingest credentials, vendor secrets and enrollment remain human checkpoints in the signed-in UI. Saved setup guides and live collector configuration are not writable through these MCP setup tools; guide me through their UI steps.",
      "Run setup_check for the exact application, environment, integration path and source when authorized. Report observed evidence, waiting items and limitations separately. A protocol connection, authorization audit, validation test or quiet poll is not proof that every screen has data or that a human received an alert. Tell me what real upstream action or import is needed next, then recommend revoking temporary write access after setup."
    ].join("\n\n");
  }
  function privateOrigin(value) {
    if (typeof value !== "string" || !/^https?:\/\//i.test(value) || value.length > 2048 || /[\u0000-\u0020\u007f%\\]/.test(value)) throw new Error("Enter a private server origin without spaces, credentials, a path, query or fragment.");
    let url; try { url = new URL(value); } catch (_) { throw new Error("Enter a valid private server origin."); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.port === "0") throw new Error("Use only the private server origin, without credentials, a path, query or fragment.");
    const host = url.hostname.toLowerCase(), raw = value.slice(value.indexOf("://") + 3).split("/")[0], rawHost = raw.startsWith("[") ? raw.slice(0, raw.indexOf("]") + 1) : raw.split(":")[0];
    const ipv4 = /^\d+\.\d+\.\d+\.\d+$/.test(host), octets = host.split(".").map(Number);
    if (ipv4 && rawHost.toLowerCase() !== host) throw new Error("Use canonical dotted-decimal IPv4 notation.");
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(host);
    const private4 = ipv4 && (octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168) || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127));
    const private6 = /^\[f[cd][0-9a-f:]+\]$/.test(host);
    const labels = host.split("."), tailnet = labels.length >= 3 && host.length <= 253 && host.endsWith("." + ["ts", "net"].join(".")) && labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
    if (url.protocol === "http:" && !loopback) throw new Error("Plain HTTP is accepted only for exact loopback hosts. Use private HTTPS for a remote agent.");
    if (url.protocol === "https:" && !(loopback || private4 || private6 || tailnet)) throw new Error("Use private HTTPS on loopback, private address space or a tailnet hostname. Public destinations are not accepted.");
    return url.origin;
  }
  function absolutePath(value, label) {
    if (typeof value !== "string" || !value || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(label + " must be a canonical absolute local path without control characters.");
    const windows = /^[a-z]:\\/i.test(value), separator = windows ? "\\" : "/";
    if ((!windows && (!value.startsWith("/") || value.includes("\\"))) || (windows && value.includes("/"))) throw new Error(label + " must be an absolute POSIX path or Windows drive path, without mixed separators.");
    const parts = value.slice(windows ? 3 : 1).split(separator);
    if (parts.some(part => !part || part === "." || part === ".." || (windows && (/[<>:"|?*]/.test(part) || /[. ]$/.test(part))))) throw new Error(label + " cannot be a filesystem root, end in a separator, or contain invalid, empty, dot or parent segments.");
    return { value, windows, separator, comparison: windows ? value.toLowerCase() : value };
  }
  function launchConfiguration(checkout, tokenFile, baseUrl) {
    const repository = absolutePath(checkout, "Checkout path"), token = absolutePath(tokenFile, "Token-file path"), origin = privateOrigin(baseUrl);
    if (repository.windows !== token.windows) throw new Error("Checkout and token-file paths must use the same host platform.");
    if (token.comparison === repository.comparison || token.comparison.startsWith(repository.comparison + repository.separator)) throw new Error("The token file must be outside the checkout. Store credentials in a private directory, never the repository.");
    const script = repository.value + repository.separator + ["tools", "agent-mcp.js"].join(repository.separator);
    const args = [script, "--base-url", origin, "--token-file", token.value];
    const quote = text => "'" + text.replace(/'/g, "'\"'\"'") + "'";
    return { args, json: JSON.stringify({ mcpServers: { "bb-soc": { command: "node", args } } }, null, 2), command: repository.windows ? null : ["node", ...args].map(quote).join(" "), permissions: repository.windows ? null : "chmod 600 " + quote(token.value) };
  }
  function render({ container, onError } = {}) {
    if (!container || typeof container.replaceChildren !== "function") throw new TypeError("Service access needs a container.");
    container.replaceChildren();
    const intro = element("section", undefined, "panel"); intro.style.padding = "14px";
    intro.append(element("h2", "Connect an agent — purpose, permission, configuration, evidence"), element("p", "Connect an external agent or MCP client to this private application with its own expiring, scoped identity. These credentials are separate from agent enrollment and source-ingest credentials.", "muted"),
      element("p", "An agent registry entry describes an agent; enrollment establishes that registry identity's connection proof. Service access separately authorizes API and MCP operations. None of these runs a model, schedules a worker, or proves agent health. Start read-only and expand only the specific permissions you reviewed.", "muted"),
      element("p", "Recommended: run the SOC and the agent bridge on your private Tailnet, with Tailnet HTTPS and access controls for remote use. Do not expose this application to the public internet or enable Funnel. A private connection protects access, not model-provider data handling: tool results can still be sent to the agent's model provider. Review that provider and your data policy before connecting.", "muted"),
      link("Register an agent", "#/agents?atab=add"), document.createTextNode(" · "), link("Manage prompts", "#/agents?atab=prompts"), document.createTextNode(" · "), link("Agent enrollment", "#/agents?atab=enrollment"));
    container.append(intro);
    if (!root.SOC_PRIVATE_APPLICATION) {
      intro.append(element("p", "Start the private application and sign in as an operator to manage service access. Static previews and the reference workbench do not issue service credentials.", "muted"));
      const cleanup = () => {}; cleanup.isDirty = () => false; cleanup.refresh = () => {}; return cleanup;
    }
    let disposed = false, busy = false, dirty = false, configDirty = false, configVisible = false, evidenceFresh = false, secretVisible = false, offset = 0, selectedId = null, latest = null, loaded = false;
    const pending = new Set();
    const status = element("p", "Loading service identities…", "muted"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
    const credentials = element("section", undefined, "panel"); credentials.style.padding = "14px"; credentials.hidden = true;
    const list = element("section", undefined, "panel"); list.style.padding = "14px";
    const create = element("section", undefined, "panel"); create.style.padding = "14px";
    const form = element("form", undefined, "administration-form"); form.style.display = "grid"; form.style.gap = "12px";
    const purposeLabel = element("label", "Agent purpose", "form-field"), purpose = element("select"); purpose.name = "servicePurpose";
    for (const [value, label] of [["registry", "Read-only registry review (default)"], ["setup", "Observe application setup and diagnostics"], ["agents", "Read agent registry metadata"], ["governance", "Read governance registry"], ["custom", "Choose exact permissions manually"]]) { const option = element("option", label); option.value = value; purpose.append(option); }
    purposeLabel.append(purpose);
    const nameLabel = element("label", "Service identity name"); nameLabel.className = "form-field";
    const name = element("input"); name.name = "serviceName"; name.required = true; name.maxLength = 120; name.autocomplete = "off"; nameLabel.append(name);
    const expiryLabel = element("label", "Credential lifetime"); expiryLabel.className = "form-field";
    const expiry = element("select"); expiry.name = "expiry";
    for (const [seconds, label] of [[3600, "1 hour"], [86400, "24 hours (recommended)"], [604800, "7 days"], [2592000, "30 days"]]) {
      const option = element("option", label); option.value = String(seconds); expiry.append(option);
    }
    expiry.value = "86400"; expiryLabel.append(expiry);
    const scopeFields = element("fieldset"); scopeFields.append(element("legend", "Exact permissions"));
    const submit = button("Issue service credential"); submit.type = "submit";
    form.append(purposeLabel, nameLabel, expiryLabel, scopeFields, element("p", "Read-only registry access is selected by default. Prompt bodies and each write operation need a separate explicit grant. Purpose presets never grant prompt bodies or writes. Credentials cannot issue other credentials, create or expand agent privileges, or activate prompts. Scopes cover the whole single-tenant installation, not one application. Purpose is a local selection aid, not a stored or enforced restriction beyond the selected scopes.", "muted"), submit);
    create.append(element("h2", "1 · Choose a purpose and issue least-privilege access"), form);
    const configuration = element("section", undefined, "panel"); configuration.style.padding = "14px";
    const configForm = element("form", undefined, "administration-form"); configForm.style.display = "grid"; configForm.style.gap = "12px";
    function configField(label, fieldName) { const wrapper = element("label", label, "form-field"), input = element("input"); input.type = "text"; input.name = fieldName; input.autocomplete = "off"; input.spellcheck = false; wrapper.append(input); configForm.append(wrapper); return input; }
    const clientLabel = element("label", "AI agent or MCP client", "form-field"), client = element("select"), clientHelp = element("div"); client.name = "agentClient";
    for (const [value, profile] of Object.entries(CLIENTS)) { const option = element("option", profile.label); option.value = value; client.append(option); }
    clientLabel.append(client); configForm.append(clientLabel, clientHelp);
    function drawClientHelp() {
      const profile = CLIENTS[client.value] || CLIENTS.generic;
      clientHelp.replaceChildren(element("p", profile.instructions, "muted"));
      if (profile.docs) clientHelp.append(link("Official client instructions", profile.docs));
      clientHelp.append(element("p", "Client formats were checked against official documentation. This is configuration guidance, not a completed end-to-end test in your installed client. An AI model name alone does not establish MCP client support.", "muted"));
    }
    drawClientHelp(); client.addEventListener("change", drawClientHelp);
    const checkout = configField("Absolute checkout path on the agent's host", "agentCheckout"), tokenFile = configField("Absolute private token-file path on the agent's host", "agentTokenFile"), baseUrl = configField("Private SOC origin reachable from the agent", "agentBaseUrl");
    checkout.maxLength = 4096; tokenFile.maxLength = 4096; baseUrl.maxLength = 2048;
    try { if (root.location?.origin) baseUrl.value = privateOrigin(root.location.origin); } catch (_) { /* A public-looking origin must be supplied and reviewed explicitly. */ }
    const configIdentity = element("p", "Choose an existing service identity below or issue one above.", "muted"), configOutput = element("div");
    configForm.append(button("Generate secret-free MCP configuration", generateConfiguration), button("Discard configuration draft", () => { if (busy || secretVisible) return; clearConfiguration(); notice("Local configuration draft cleared. No service identity or credential was changed."); sync(); }));
    configuration.append(element("h2", "3 · Configure the external agent or MCP client"), configIdentity,
      element("p", "Install this checkout and its dependencies on the agent host, with Node.js 22.13 or newer available as node. Save the one-time credential in a private regular file outside the checkout, owned by the launching user with mode 0600 and no symbolic or hard links. Create that file with a secure editor or secret manager; do not put the credential in command arguments, chat, generated configuration, or the repository.", "muted"),
      element("p", "These fields and generated instructions stay only in this page's memory. They are not uploaded or persisted. Paths refer to the agent host, which may differ from the browser or SOC server. The generator checks syntax and placement, not filesystem permissions, symlinks, DNS resolution, TLS or connectivity; the MCP runtime performs its own checks.", "muted"), configForm, configOutput);
    const verification = element("section", undefined, "panel"); verification.style.padding = "14px";
    const audit = element("section", undefined, "panel"); audit.style.padding = "14px";
    container.append(status, create, credentials, configuration, verification, list, audit);
    function notice(message, error = false) { if (!disposed) { status.textContent = message; status.setAttribute("role", error ? "alert" : "status"); } }
    function sync() {
      container.setAttribute("data-service-access-dirty", String(dirty || configDirty || configVisible || secretVisible));
      form.dataset.dirty = String(dirty); configForm.dataset.dirty = String(configDirty || configVisible);
      form.querySelectorAll("input,select,button").forEach(field => { field.disabled = busy || secretVisible || configDirty || !loaded; });
      configForm.querySelectorAll("input,select,button").forEach(field => { field.disabled = busy || secretVisible || dirty || !loaded; });
    }
    function clearSecret() { credentials.querySelectorAll("textarea").forEach(field => { field.value = ""; }); credentials.replaceChildren(); credentials.hidden = true; secretVisible = false; sync(); }
    function receiveService(service) {
      if (disposed || !latest) return;
      latest = { ...latest, services: [service, ...latest.services.filter(item => item.id !== service.id)] };
      evidenceFresh = false;
      if (service.status !== "active") { configOutput.replaceChildren(); configVisible = false; }
      drawVerification();
    }
    function showSecret(result) {
      if (disposed) return;
      clearSecret(); secretVisible = true; selectedId = result.service.id; clearConfiguration(false); receiveService(result.service);
      const value = element("textarea"); value.readOnly = true; value.value = result.oneTimeCredential; value.rows = 3;
      value.setAttribute("aria-label", "One-time service credential"); value.autocomplete = "off"; value.spellcheck = false;
      credentials.hidden = false;
      credentials.append(element("h2", "2 · Save this credential now"), element("p", "Shown only once. Save it outside the repository in an owner-only file (mode 0600), then pass that file path to MCP using --token-file or SOC_AGENT_MCP_TOKEN_FILE. Never paste it in a prompt, commit it, or place it in command arguments. Closing this panel clears the browser copy. Rotation invalidates the previous credential immediately. Clearing this panel records no proof that the file was saved correctly.", "muted"), value,
        element("p", "Expires: " + result.service.expiresAt + ". Rotation preserves this expiry.", "muted"),
        button("I saved it — clear credential", clearSecret));
      sync(); value.focus(); value.select();
    }
    function identity() { return latest?.services.find(service => service.id === selectedId) || null; }
    function clearConfiguration(clearFields = true) {
      configDirty = false; configVisible = false; configOutput.replaceChildren();
      if (clearFields) { checkout.value = ""; tokenFile.value = ""; baseUrl.value = ""; }
    }
    function generateConfiguration() {
      if (disposed || busy || dirty || secretVisible) return;
      try {
        const service = identity(); if (!service || service.status !== "active" || !evidenceFresh) throw new Error("Select an active identity on the current page before generating configuration. Refresh to confirm its current status.");
        const profile = CLIENTS[client.value];
        if (!profile || !profile.format) throw new Error("This client has no verified direct private-stdio configuration here. Follow its compatibility note or select a supported local MCP client. Do not publish the SOC to make a remote connector work.");
        const result = launchConfiguration(checkout.value, tokenFile.value, baseUrl.value);
        if (client.value !== "generic" && result.args.some(value => value.includes("${"))) throw new Error("Client configurations may expand variable placeholders. Use literal paths without ${...} so the reviewed path cannot resolve to a different file.");
        const config = profile.format === "toml" ? '[mcp_servers.bb-soc]\ncommand = "node"\nargs = ' + JSON.stringify(result.args)
          : profile.format === "yaml" ? 'mcp_servers:\n  bb-soc:\n    command: "node"\n    args: ' + JSON.stringify(result.args)
          : profile.format === "openclaw" ? JSON.stringify({ mcp: { servers: { "bb-soc": { command: "node", args: result.args, transport: "stdio", enabled: true } } } }, null, 2) : result.json;
        configOutput.replaceChildren(element("h3", "Secret-free stdio MCP configuration"),
          element("p", "Merge this server entry into your MCP client's supported configuration; do not overwrite unrelated entries. Client configuration formats differ. The argument array avoids shell interpolation and contains a token-file path, never the credential itself.", "muted"), element("pre", config));
        if (result.command) configOutput.append(element("h3", "Equivalent POSIX launch command"), element("pre", result.command), element("p", "The server speaks MCP over standard input/output. Launch it through your MCP client; a plain terminal launch waits for protocol input and is not a connectivity test.", "muted"), element("h3", "After securely saving the file: owner-only permissions"), element("pre", result.permissions));
        else configOutput.append(element("p", "Windows drive paths are encoded in the JSON argument array. Configure owner-only file access on the agent host; no POSIX shell command is generated for Windows paths.", "muted"));
        if (client.value === "claude" && result.command) configOutput.append(element("h3", "Claude Code registration — POSIX shell"), element("pre", "claude mcp add --transport stdio --scope local bb-soc -- " + result.command), element("p", "Run only after reviewing the paths. Registration writes client configuration; it does not prove a permitted SOC request succeeded. If bb-soc already exists, review and update it instead of overwriting another connection.", "muted"));
        let call = service.scopes.includes("connector:read") ? 'connector_snapshot with {"reason":"refresh"}' : service.scopes.includes("setup:read") ? "setup_guides with {}" : service.scopes.includes("agents:read") ? 'administration_snapshot with {"domain":"agents","reason":"refresh"}' : service.scopes.includes("governance:read") ? 'administration_snapshot with {"domain":"governance","reason":"refresh"}' : null;
        configOutput.append(element("h3", "Read-only verification from the real client"), element("p", call ? "In the external MCP client, call " + call + ". Inspect the returned result there, then return here and refresh observed access. Tool discovery or reading bundled documentation alone does not prove authentication to the private server." : "This identity has no general read-only verification scope. Do not use a write as a connectivity test. Issue a separately reviewed read-only identity or use an explicitly permitted prompt read with a known prompt ID.", "muted"),
          element("p", "The agent may read soc://documentation/guided-setup. With the optional setup:read scope, setup_guides lists saved guides and setup_check reads current local evidence for an exact application/environment/path/source selection. These are read-only; they do not create a guide, configure credentials, poll a vendor or send a notification.", "muted"));
        const prompt = element("textarea"); prompt.readOnly = true; prompt.rows = 12; prompt.value = setupPrompt(service.scopes); prompt.setAttribute("aria-label", "Secret-free AI setup prompt"); prompt.spellcheck = false;
        configOutput.append(element("h3", "5 · Ask the agent to walk through setup"),
          element("p", "Use the setup_application MCP prompt, or copy this starter prompt into the connected agent. It contains no credential. Read it before sharing; the scope list describes installation-wide authority. The prompt asks for approval but is not a security control — exact service scopes remain the enforced boundary.", "muted"), prompt,
          button("Select setup prompt to copy", () => { prompt.focus(); prompt.select(); notice("Setup prompt selected. Copy it into your connected agent after reviewing the data-sharing policy. No prompt or credentials were sent from this page."); }),
          element("p", "To let an agent register and prepare a source, explicitly review connector:app.register, connector:source.setup, connector:source.update and connector:source.test as needed under Optional write grants. None is selected automatically. Issue only the subset needed, preferably for one hour, and revoke it after the setup task. Activation and credential issuance stay in your signed-in UI.", "muted"),
          link("Human guided setup", "#/sources?stab=setup"), link("AI setup documentation", "#/docs"));
        configDirty = false; configVisible = true; sync(); notice("Secret-free configuration generated locally. Launch it in the real MCP client and verify its returned read result; no network test was performed here. Instructions remain protected from automatic refresh until you clear them or leave this page.");
      } catch (error) { configVisible = false; configOutput.replaceChildren(); sync(); notice(error.message || "Configuration could not be generated.", true); if (onError) onError(error); }
    }
    function drawVerification() {
      const service = identity();
      configIdentity.textContent = service ? "Selected identity: " + service.name + " · " + service.id + " · " + service.status + " · exact scopes: " + service.scopes.join(", ") : selectedId ? "Selected identity is not on the current page. Return to its identity-list page and refresh before generating configuration or interpreting access evidence." : "Choose an existing service identity below or issue one above.";
      verification.replaceChildren(element("h2", "4 · Verify observed agent access"),
        element("p", "Use the real MCP client to perform one permitted read and inspect its result. This page only reads the server's retained audit; it never sends a test bearer request, starts the agent or uses its credential. Local tool discovery and documentation reads are not server-authentication tests.", "muted"),
        button("Refresh observed agent access", () => cleanup.refresh()));
      if (!service) { verification.append(element("p", "Waiting — select an identity on the current page. No access has been certified.", "muted")); return; }
      const boundary = Date.parse(service.rotatedAt || service.createdAt), events = (latest.audit || []).filter(entry => entry.serviceId === service.id && Date.parse(entry.occurredAt) > boundary);
      const authorized = events.find(entry => entry.outcome === "authorized"), denied = events.find(entry => entry.outcome === "denied");
      verification.append(element("p", "Identity status: " + service.status + ". Expires: " + service.expiresAt + ". Credential " + (service.rotatedAt ? "rotated" : "issued") + ": " + (service.rotatedAt || service.createdAt) + ".", "muted"),
        element("p", "Last authenticated attempt: " + (service.lastUsedAt || "Never") + ". A denied scope check can update this timestamp; it is not authorization or completion proof.", "muted"));
      if (service.status !== "active") verification.append(element("p", "Needs attention — this identity is expired or revoked. Historical access is not usable current access."));
      else if (!evidenceFresh) verification.append(element("p", "Waiting — a fresh service-access snapshot is unavailable or still loading. Earlier authorization evidence is not presented as a current check; refresh again before relying on this identity's status."));
      else if (authorized) verification.append(element("p", "Authorization observed — " + authorized.action + " at " + authorized.occurredAt + ". The server allowed this request for the current credential. This does not prove that the operation completed or that the client received its response."));
      else verification.append(element("p", "Waiting — no retained authorized request newer than this credential's issue or rotation was found. An issued token or last-used timestamp alone is not connection proof. Events at the same timestamp as rotation are conservatively excluded."));
      if (denied && evidenceFresh) verification.append(element("p", "Needs attention — a request was denied for scope: " + denied.action + " at " + denied.occurredAt + ". Check the requested action and selected permissions; do not grant broad write access merely to remove an error."));
      verification.append(element("p", "Audit evidence is limited to the latest 100 events across the installation, so missing evidence may have aged out. Re-run an authorized read from the client if needed. An audit authorization is not proof of successful command completion, model execution, scheduling, continuous availability or agent health. Check the real client's returned result and the relevant command history separately.", "muted"));
    }
    async function request(endpoint, options = {}) {
      if (disposed) throw new Error("Service access view is closed.");
      const controller = new AbortController(); pending.add(controller);
      const timeout = root.setTimeout(() => controller.abort(), 20000);
      try {
        const response = await root.fetch(endpoint, { ...options, credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal,
          headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}) } });
        const reader = response.body.getReader(), chunks = []; let size = 0;
        while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 4 * 1024 * 1024) { await reader.cancel(); throw new Error("Service access response exceeds its limit."); } chunks.push(part.value); }
        if (!response.ok) throw new Error(response.status === 401 ? "Your session ended. Sign in again." : response.status === 409 ? "The service identity changed. Refresh before retrying." : "Service access request was refused. Check private operator access and refresh the saved state before retrying.");
        const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch (error) {
        if (error.name === "AbortError" && !disposed) throw new Error("Service access request timed out. Refresh to check the outcome. If an issued credential was not received, revoke that identity and issue another.");
        if (error instanceof TypeError || error instanceof SyntaxError) throw new Error("Service access response could not be read. Refresh to check the saved state before retrying; an issued credential may need to be revoked and replaced.");
        throw error;
      } finally { root.clearTimeout(timeout); pending.delete(controller); }
    }
    async function perform(action) {
      if (busy || disposed) return;
      busy = true; sync();
      try { await action(); } catch (error) { if (!disposed) { notice(error.message || "Service request failed.", true); if (typeof onError === "function") onError(error); } }
      finally { busy = false; if (!disposed) sync(); }
    }
    function scopeChoices(data) {
      if (scopeFields.querySelector("input")) return;
      const read = element("div"), writes = element("details"); writes.append(element("summary", "Optional write grants — review each before selecting"));
      for (const scope of data.availableScopes) {
        const label = element("label"); label.style.display = "block";
        const box = element("input"); box.type = "checkbox"; box.name = "scope"; box.value = scope; box.defaultChecked = data.defaultScopes.includes(scope) && scope.endsWith(":read") && scope !== "prompts:read"; box.checked = box.defaultChecked;
        const description = scope === "prompts:read" ? " — includes literal prompt bodies; grant only after reviewing their sensitivity" : scope === "setup:read" ? " — read saved setup bindings and local diagnostics; no configuration or credential writes" : scope.endsWith(":read") ? " — registry metadata only" : " — permits this exact write operation installation-wide";
        label.append(box, document.createTextNode(" " + scope + description));
        (scope.endsWith(":read") ? read : writes).append(label);
      }
      scopeFields.append(read, writes);
    }
    async function change(service, action) {
      if (busy || dirty || configDirty || secretVisible) { notice("Save or discard the draft and clear the one-time credential before changing an identity."); return; }
      if (!root.confirm((action === "rotate" ? "Rotate this credential? The current credential will immediately stop working." : "Revoke this credential? Its agent will immediately lose service access.") + "\n" + service.name)) return;
      await perform(async () => {
        const result = await request("/api/v1/service-access/" + encodeURIComponent(service.id) + "/" + action,
          { method: "POST", body: JSON.stringify({ expectedRevision: service.revision }) });
        if (result.oneTimeCredential) showSecret(result); else receiveService(result.service);
        await load();
        notice(action === "rotate" ? "Credential rotated. Save its one-time value." : "Service credential revoked.");
      });
    }
    async function load() {
      if (disposed) return;
      evidenceFresh = false; drawVerification();
      const data = await request("/api/v1/service-access?offset=" + offset + "&limit=50");
      if (disposed) return;
      if (!Array.isArray(data.services) || !Array.isArray(data.audit) || !Array.isArray(data.availableScopes) || !Array.isArray(data.defaultScopes)) throw new Error("Service access returned an invalid snapshot.");
      latest = data; loaded = true; evidenceFresh = true;
      scopeChoices(data); list.replaceChildren(); list.append(element("h2", "Service identities"), element("p", data.total + " retained identities · " + data.ratePerMinute + " requests per identity per minute · list includes expired and revoked identities.", "muted"));
      const controls = element("div", undefined, "administration-actions");
      controls.append(button("Refresh", () => cleanup.refresh()), button("Discard unsaved form", () => {
        if (busy || secretVisible || (dirty && !root.confirm("Discard the unsaved service access form?"))) return;
        form.reset(); form.removeAttribute("data-dirty"); expiry.value = "86400"; dirty = false; sync(); notice("Draft cleared.");
      })); list.append(controls);
      if (!data.services.length) list.append(element("p", "No service identities have been issued. Start with a read-only identity below.", "muted"));
      for (const service of data.services) {
        const card = element("article", undefined, "empty-card");
        card.append(element("h3", service.name), element("p", service.id, "muted"),
          element("p", service.status + " · expires " + service.expiresAt + " · revision " + service.revision),
          element("p", "Last authenticated attempt (including scope denials): " + (service.lastUsedAt || "Never"), "muted"),
          element("p", service.scopes.join(" · "), "muted"));
        card.append(button("Guide this identity — " + service.name, () => {
          if (busy || dirty || configDirty || secretVisible) { notice("Save or discard the draft and clear the one-time credential before choosing another identity."); return; }
          selectedId = service.id; clearConfiguration(false); drawVerification(); notice("Identity selected. Configure its real MCP client, then refresh observed access after a permitted read.");
        }));
        if (service.status === "active") card.append(button("Rotate credential", () => change(service, "rotate")));
        if (!service.revokedAt) card.append(button("Revoke access", () => change(service, "revoke")));
        list.append(card);
      }
      const paging = element("div", undefined, "administration-actions");
      function page(next) { if (busy || dirty || configDirty || secretVisible) { notice("Clear the current draft and credential before changing pages."); return; } offset = next; perform(load); }
      if (offset > 0) paging.append(button("Previous", () => page(Math.max(0, offset - 50))));
      if (data.nextOffset !== null) paging.append(button("Next", () => page(data.nextOffset)));
      list.append(paging);
      audit.replaceChildren(); audit.append(element("h2", "Recent service access audit"), element("p", "Latest 100 events; the last " + data.auditRetention + " are retained locally. Authorization is recorded here; command completion is recorded in the connector or administration change history.", "muted"));
      for (const entry of data.audit) audit.append(element("p", entry.occurredAt + " · " + entry.action + " · " + entry.outcome + " · " + entry.actor, "muted"));
      if (!identity() || identity().status !== "active") { configOutput.replaceChildren(); configVisible = false; }
      drawVerification();
      notice("Service access ready.");
    }
    purpose.addEventListener("change", () => {
      const wanted = purpose.value === "registry" ? (latest?.defaultScopes || []).filter(scope => scope.endsWith(":read") && scope !== "prompts:read")
        : purpose.value === "setup" ? ["connector:read", "setup:read"] : purpose.value === "agents" ? ["agents:read"] : purpose.value === "governance" ? ["governance:read"] : [];
      scopeFields.querySelectorAll("input").forEach(box => { box.checked = wanted.includes(box.value); });
      notice(purpose.value === "setup" && !latest?.availableScopes.includes("setup:read") ? "This server does not offer setup:read. Only available read scopes were selected; update the private server before expecting setup tools to work." : "Purpose preset applied. Review exact permissions; no prompt bodies or write grants were added.");
    });
    configForm.addEventListener("submit", event => event.preventDefault());
    for (const eventName of ["input", "change"]) configForm.addEventListener(eventName, () => { configDirty = true; configVisible = false; configOutput.replaceChildren(); sync(); });
    form.addEventListener("input", () => { dirty = true; sync(); });
    form.addEventListener("change", () => { dirty = true; sync(); });
    form.addEventListener("submit", event => {
      event.preventDefault();
      if (secretVisible || configDirty || busy || !loaded) return;
      const scopes = Array.from(form.querySelectorAll('input[name="scope"]:checked')).map(field => field.value);
      if (!name.value.trim() || name.value.trim().length > 120 || /[\u0000-\u001f\u007f]/.test(name.value)) { notice("Enter a service identity name up to 120 characters without control characters.", true); return; }
      if (!scopes.length) { notice("Choose at least one permission.", true); return; }
      if (scopes.some(scope => !scope.endsWith(":read")) && !root.confirm("This credential grants write operations across this installation. Issue it with the exact selected scopes?")) return;
      perform(async () => {
        const result = await request("/api/v1/service-access", { method: "POST", body: JSON.stringify({ name: name.value.trim(), scopes, expiresInSeconds: Number(expiry.value) }) });
        if (disposed) return;
        dirty = false; form.reset(); form.removeAttribute("data-dirty"); expiry.value = "86400"; offset = 0;
        // Keep the one-time value visible even if the following list refresh fails.
        showSecret(result); await load(); notice("Credential issued. Save its one-time value before leaving this tab.");
      });
    });
    function beforeUnload(event) { if (dirty || configDirty || configVisible || busy || secretVisible) { event.preventDefault(); event.returnValue = ""; } }
    root.addEventListener("beforeunload", beforeUnload);
    function cleanup() { disposed = true; pending.forEach(controller => controller.abort()); pending.clear(); root.removeEventListener("beforeunload", beforeUnload); clearSecret(); clearConfiguration(); name.value = ""; container.removeAttribute("data-service-access-dirty"); }
    cleanup.isDirty = () => dirty || configDirty || configVisible || busy || secretVisible;
    cleanup.refresh = () => { if (dirty || configDirty || busy || secretVisible) { notice("Refresh paused to preserve the draft or one-time credential."); return; } return perform(load); };
    intro.append(document.createTextNode(" · "), button("Reload service identities", () => cleanup.refresh()));
    perform(load);
    return cleanup;
  }
  root.SocServiceAccess = Object.freeze({ render });
})(typeof window !== "undefined" ? window : globalThis);
