(function (root) {
  "use strict";
  const API = "/api/v1/monitoring", RESPONSE_LIMIT = 4 * 1024 * 1024;
  const HEALTH = { starting: "Starting — collection not yet proved", healthy: "Healthy — collection is succeeding", degraded: "Degraded — collection needs attention", offline: "Offline — collection is not current", paused: "Paused — collection is intentionally stopped" };
  function el(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = String(text); if (className) node.className = className; return node; }
  function panel(title) { const node = el("section", undefined, "panel"); node.style.padding = "14px"; node.append(el("h2", title)); return node; }
  function link(label, href) { const node = el("a", label, "resource-action"); node.href = href; return node; }
  function button(label, action) { const node = el("button", label, "resource-action"); node.type = "button"; node.addEventListener("click", action); return node; }
  function form() { const node = el("form", undefined, "administration-form"); node.style.display = "grid"; node.style.gap = "12px"; return node; }
  function field(parent, label, name, type = "text") {
    const wrapper = el("label", label, "form-field"), input = el(type === "select" ? "select" : "input"); input.name = name;
    if (type !== "select") input.type = type;
    if (type === "password") { input.autocomplete = "new-password"; input.spellcheck = false; input.maxLength = 2048; }
    wrapper.append(input); parent.append(wrapper); return input;
  }
  function option(select, label, value) { const node = el("option", label); node.value = value; select.append(node); }
  function time(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : "Not yet available"; }
  function evidenceLink(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || !["sentry.io", "us.sentry.io", "de.sentry.io"].includes(url.hostname) || url.port || url.username || url.password) return null;
      const node = link("Open evidence in Sentry", url.href); node.target = "_blank"; node.rel = "noopener noreferrer"; return node;
    } catch (_) { return null; }
  }
  function render({ container, onError, query } = {}) {
    if (!container) throw new TypeError("Live monitoring needs a container.");
    let disposed = false, busy = false, timer = null, apps = [], credentialForms = [], snapshot = null, alertOffset = 0, initialScopeApplied = false;
    const controllers = new Set(), dirtyForms = new Set(), fieldOwners = new WeakMap();
    const intro = panel("Live monitoring — connect, collect, understand");
    intro.append(el("p", "Connect a Sentry project to a registered web application. The private server checks access, starts a 15-minute initial lookback, and polls every 60 seconds while running. These are application errors, not independently verified security findings.", "muted"),
      el("p", "Collection health is separate from event activity: no new errors can be healthy; a failed collector is not. Keep this SOC private on your tailnet. Vendor requests and optional Slack delivery are outbound only.", "muted"),
      link("Live monitoring setup and operations guide", "#/docs?section=57-live-monitoring-connect-collect-understand-notify-verify"));
    const status = el("p", "Loading live monitoring…", "muted"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
    container.replaceChildren(intro, status);
    if (!root.SOC_PRIVATE_APPLICATION) {
      status.textContent = "Start the private application and sign in to connect Sentry. The static skeleton performs no collection, stores no credentials, and contains no monitoring records.";
      const cleanup = () => {}; cleanup.isDirty = () => false; return cleanup;
    }
    const setup = panel("1 · Connect a Sentry project"), connectionPanel = panel("2 · Verify collection"), alertPanel = panel("3 · Understand and act");
    const setupForm = form();
    setup.append(el("p", "Your application must already send errors to Sentry. Create a Sentry token with project:read access to this project; do not grant write scopes. Slugs are the organization and project URL names, not full URLs. Credentials are encrypted on the private server and never returned by this view.", "muted"),
      link("Register an application first", "#/onboard"), setupForm);
    const app = field(setupForm, "Registered application", "monitoringApp", "select"); app.required = true;
    const environment = field(setupForm, "Environment", "monitoringEnvironment", "select"); environment.required = true;
    setupForm.append(el("p", "The selected environment labels this SOC source; it does not filter Sentry events. This connector reads the whole selected project's error feed. Use a dedicated Sentry project per environment when you need isolation.", "muted"));
    const displayName = field(setupForm, "Connection display name", "monitoringDisplayName"); displayName.required = true; displayName.maxLength = 100; displayName.value = "Sentry application errors";
    const region = field(setupForm, "Sentry region", "monitoringRegion", "select");
    option(region, "Default — sentry.io", "default"); option(region, "United States — us.sentry.io", "us"); option(region, "Europe — de.sentry.io", "eu");
    const organization = field(setupForm, "Organization slug", "monitoringOrganization"); organization.required = true; organization.maxLength = 100;
    const project = field(setupForm, "Project slug", "monitoringProject"); project.required = true; project.maxLength = 100;
    const token = field(setupForm, "Sentry read-only token", "monitoringToken", "password"); token.required = true;
    const slack = field(setupForm, "Optional Slack incoming webhook URL", "monitoringSlack", "password");
    setupForm.append(el("p", "Optional Slack notifications send a concise monitoring alert to the channel attached to your webhook. Leave this blank for in-app alerts only. After connection, send an explicit test to confirm channel delivery.", "muted"));
    const connect = button("Test access and start monitoring", () => { void perform(createConnection); });
    const discard = button("Discard setup draft", () => { if (!dirtyForms.has(setupForm) || root.confirm("Discard this unsaved connection setup?")) { clearSetup(); notice("Setup draft discarded. No connection was changed."); } });
    setupForm.append(connect, discard); container.append(setup, connectionPanel, alertPanel);

    function notice(text, error = false) { if (!disposed) { status.textContent = text; status.setAttribute("role", error ? "alert" : "status"); } }
    function dirty(parent) { dirtyForms.add(parent); parent.dataset.dirty = "true"; sync(); }
    function clean(parent) { dirtyForms.delete(parent); parent.dataset.dirty = "false"; }
    function track(parent) {
      parent.querySelectorAll("button,input,select").forEach(node => fieldOwners.set(node, parent));
      parent.addEventListener("input", () => dirty(parent)); parent.addEventListener("change", () => dirty(parent)); parent.addEventListener("submit", event => event.preventDefault());
    }
    function sync() {
      container.querySelectorAll("button,input,select").forEach(node => {
        const owner = fieldOwners.get(node), anotherDraft = owner && [...dirtyForms].some(parent => parent !== owner);
        node.disabled = busy || node.dataset.unavailable === "true" || Boolean(anotherDraft) || (dirtyForms.size > 0 && node.dataset.requiresClean === "true");
      });
      connect.disabled = connect.disabled || !app.value || !environment.value;
    }
    function selectEnvironments() {
      const previous = environment.value; environment.replaceChildren();
      const selected = apps.find(item => item.appId === app.value);
      for (const name of selected?.environments || []) option(environment, name, name);
      if (selected?.environments?.includes(previous)) environment.value = previous;
      sync();
    }
    app.addEventListener("change", selectEnvironments); track(setupForm);
    function clearSetup() { token.value = ""; slack.value = ""; organization.value = ""; project.value = ""; displayName.value = "Sentry application errors"; clean(setupForm); sync(); }
    function clearCredentials() { credentialForms.forEach(entry => { entry.token.value = ""; entry.slack.value = ""; clean(entry.form); }); }
    async function request(url, body) {
      if (disposed) throw new Error("Monitoring view is closed.");
      const controller = new AbortController(); controllers.add(controller); const timeout = root.setTimeout(() => controller.abort(), 30000);
      try {
        const response = await root.fetch(url, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal,
          headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const reader = response.body.getReader(), chunks = []; let size = 0;
        while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > RESPONSE_LIMIT) { await reader.cancel(); throw new Error("Monitoring response exceeds its limit."); } chunks.push(part.value); }
        const bytes = new Uint8Array(size); let at = 0; for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
        if (!response.ok) {
          // Never echo a failed credential request or a vendor response body into the UI.
          const messages = { 400: "Check the application, slugs, region and credential fields. The request was refused.", 401: "Your session ended. Sign in again.", 403: "This action is not permitted. Confirm your session and access.", 409: "The connection changed or cannot accept this action. Discard unsaved edits and refresh; check source state, connection limits and coverage age before retrying.", 422: "Sentry access could not be verified. Check your region, organization and project slugs, and a token with project:read access to this project.", 429: "Collection or delivery is cooling down. Wait until the next permitted attempt.", 502: "The provider could not confirm access or complete the request. Check the read-only credential, project and region.", 503: "Monitoring is unavailable. Check the private server configuration and monitoring guide." };
          throw new Error(messages[response.status] || "Monitoring request failed. Check connection health and the private server configuration.");
        }
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch (error) {
        if (error.name === "AbortError") throw new Error("Monitoring request timed out. Refresh status before retrying; the server may have completed the action.");
        if (error instanceof TypeError || error instanceof SyntaxError) throw new Error("Monitoring response could not be read. Displayed values may be stale; check the server and refresh.");
        throw error;
      } finally { root.clearTimeout(timeout); controllers.delete(controller); }
    }
    async function perform(action) {
      if (busy || disposed) return; busy = true; sync();
      try { await action(); } catch (error) { if (!disposed) { notice(error.message || "Monitoring operation failed. Displayed values may be stale.", true); if (onError) onError(error); } }
      finally { busy = false; if (!disposed) sync(); }
    }
    async function load(includeApps = false) {
      const results = await Promise.all([request(API + (alertOffset ? "?offset=" + alertOffset + "&limit=100" : "")), ...(includeApps ? [request("/api/v1/control/snapshot?reason=refresh")] : [])]);
      if (disposed) return;
      if (!Array.isArray(results[0].connections) || !Array.isArray(results[0].alerts)) throw new Error("Monitoring service returned an invalid status snapshot.");
      if (includeApps) {
        apps = results[1].apps || []; const previous = app.value; app.replaceChildren(); option(app, "Choose your application…", "");
        apps.forEach(item => option(app, item.displayName, item.appId));
        if (apps.some(item => item.appId === previous)) app.value = previous;
        selectEnvironments();
        if (!initialScopeApplied) {
          initialScopeApplied = true;
          const requestedApp = query?.get?.("appId"), requestedEnvironment = query?.get?.("environment");
          const registered = apps.find(item => item.appId === requestedApp);
          if (registered) { app.value = registered.appId; selectEnvironments(); if (registered.environments.includes(requestedEnvironment)) environment.value = requestedEnvironment; }
        }
      }
      snapshot = results[0]; drawConnections(); drawAlerts();
      notice("Monitoring status refreshed at " + new Date().toISOString() + ". This view refreshes every 30 seconds while no unsaved draft is open; server collection continues independently.");
    }
    function action(connection, label, suffix, options = {}) {
      const node = button(label, () => {
        if (options.confirm && !root.confirm(options.confirm)) return;
        void perform(async () => {
          await request(API + "/connections/" + encodeURIComponent(connection.id) + "/" + suffix, { expectedRevision: connection.revision });
          if (disposed) return;
          await load(); notice(options.notice || "Connection updated. Review its collection and delivery status below.");
        });
      });
      node.dataset.requiresClean = "true"; if (options.unavailable) node.dataset.unavailable = "true"; return node;
    }
    function drawConnections() {
      clearCredentials(); credentialForms = [];
      connectionPanel.replaceChildren(el("h2", "2 · Verify collection"), el("p", "A successful completed poll proves collection even when it finds zero events. Last event time only describes application activity. Paused, degraded or offline collection must not be treated as a clean bill of health.", "muted"));
      if (!snapshot.connections.length) connectionPanel.append(el("p", "No live connections yet. Connect a project above; only events from your connected project will appear.", "muted"));
      for (const item of snapshot.connections) {
        const card = el("article", undefined, "panel"); card.style.padding = "14px";
        card.append(el("h3", item.displayName), el("p", HEALTH[item.health] || "Unknown — collection has not been proved"),
          el("p", "Application: " + item.appId + " · environment: " + item.environment + " · Sentry: " + item.organization + "/" + item.project + " (" + item.region + ")"),
          el("p", "Last successful completed poll: " + time(item.lastSuccessAt)), el("p", "Coverage starts: " + time(item.coverageStartAt) + " · Completed through: " + time(item.completedThrough)),
          el("p", "Last attempted poll: " + time(item.lastAttemptAt) + " · Next attempt: " + time(item.nextPollAt)),
          el("p", "Last event activity: " + time(item.lastEventAt) + " · Events accepted: " + (Number.isSafeInteger(item.totalEvents) ? item.totalEvents : 0)),
          el("p", item.hasSlack ? "Slack configured · delivery status: " + (item.notificationStatus || "not yet proved; send a test") : "In-app alerts enabled · Slack not configured"));
        if (item.pendingWindow) card.append(el("p", "A collection window is incomplete. The completed-through checkpoint advances only after every page is accepted.", "muted"));
        if (item.lastError) card.append(el("p", "Collector status: " + String(item.lastError).slice(0, 400), "muted"));
        card.append(link("View this source's observations", "#/sources?stab=observations&sourceId=" + encodeURIComponent(item.sourceId)),
          action(item, "Poll now", "poll", { unavailable: !item.enabled, notice: "Poll requested. Provider cooldowns still apply; verify the completed-through checkpoint and next attempt." }),
          item.enabled ? action(item, "Pause collection", "pause") : action(item, "Resume collection", "resume"),
          action(item, "Send Slack test", "test-notification", { unavailable: !item.hasSlack, notice: "Slack test requested. Review delivery status; configured is not the same as delivered." }),
          action(item, "Retry blocked Slack notifications", "retry-notifications", { unavailable: !item.hasSlack, notice: "Blocked notifications queued for another bounded delivery attempt. Existing provider cooldowns still apply." }),
          action(item, "Remove connection", "remove", { confirm: "Remove this live connection and its stored credentials? Collection stops. Existing telemetry and alerts are not deleted.", notice: "Connection removed and stored credentials deleted. Existing telemetry and alerts remain subject to retention." }));
        const details = el("details"); details.append(el("summary", "Rotate credentials or update Slack delivery"));
        const edit = form(), replacement = field(edit, "New Sentry token (blank preserves existing token)", "replacementToken-" + item.id, "password");
        const replacementSlack = field(edit, "New Slack webhook (blank preserves existing webhook)", "replacementSlack-" + item.id, "password");
        const removeSlack = field(edit, "Remove Slack notifications", "removeSlack-" + item.id, "checkbox");
        const save = button("Save credential changes", () => { void perform(async () => {
          const body = { expectedRevision: item.revision };
          if (replacement.value) body.token = replacement.value;
          if (removeSlack.checked) body.slackWebhook = ""; else if (replacementSlack.value) body.slackWebhook = replacementSlack.value;
          if (Object.keys(body).length === 1) throw new Error("Enter a replacement credential or choose to remove Slack notifications.");
          await request(API + "/connections/" + encodeURIComponent(item.id) + "/credentials", body);
          if (disposed) return;
          replacement.value = ""; replacementSlack.value = ""; clean(edit); await load(); notice("Credential changes saved. Review collection health and send a Slack test if delivery changed.");
        }); });
        const discardEdit = button("Discard credential edits", () => { replacement.value = ""; replacementSlack.value = ""; removeSlack.checked = false; clean(edit); sync(); });
        edit.append(save, discardEdit); track(edit); credentialForms.push({ form: edit, token: replacement, slack: replacementSlack }); details.append(edit); card.append(details); connectionPanel.append(card);
      }
    }
    function drawAlerts() {
      alertPanel.replaceChildren(el("h2", "3 · Understand and act"), el("p", "Application-error alerts point to the affected connection and retained evidence. Collection failures are separate alerts. Acknowledging an alert here does not resolve an issue in Sentry or change the underlying application.", "muted"));
      const total = Number.isSafeInteger(snapshot.totalAlerts) ? snapshot.totalAlerts : snapshot.alerts.length;
      alertPanel.append(el("p", "Showing " + snapshot.alerts.length + " of " + total + " retained alerts, starting at " + (total ? alertOffset + 1 : 0) + ". Newest first; incoming alerts can shift pages.", "muted"));
      const newer = button("Newer alerts", () => { alertOffset = Math.max(0, alertOffset - 100); void perform(() => load()); });
      const older = button("Older alerts", () => { if (Number.isSafeInteger(snapshot.nextOffset) && snapshot.nextOffset > alertOffset && snapshot.nextOffset <= 10000) { alertOffset = snapshot.nextOffset; void perform(() => load()); } });
      newer.dataset.requiresClean = "true"; older.dataset.requiresClean = "true";
      if (!alertOffset) newer.dataset.unavailable = "true";
      if (!Number.isSafeInteger(snapshot.nextOffset) || snapshot.nextOffset <= alertOffset || snapshot.nextOffset > 10000) older.dataset.unavailable = "true";
      alertPanel.append(newer, older);
      if (!snapshot.alerts.length) alertPanel.append(el("p", total ? "No alerts on this page. Return to newer alerts or refresh from the beginning." : "No monitoring alerts have been recorded. Verify collection health above before interpreting silence.", "muted"));
      for (const item of snapshot.alerts) {
        const card = el("article", undefined, "panel"); card.style.padding = "14px";
        card.append(el("h3", item.title), el("p", item.body), el("p", "Kind: " + item.kind + " · Application: " + item.appId + " · Created: " + time(item.createdAt)),
          el("p", "Notification: " + (item.deliveryState || "in-app only") + " · Acknowledged: " + (item.acknowledgedAt ? time(item.acknowledgedAt) : "No")),
          link("View related observations", "#/sources?stab=observations&sourceId=" + encodeURIComponent(item.sourceId)));
        if (item.evidence) {
          card.append(el("p", "Evidence record: " + (item.evidence.recordId || "Not supplied") + " · Observed: " + time(item.evidence.observedAt)),
            el("p", "Sentry event ID: " + (item.evidence.vendorEventId || "Not supplied") + ". Use this identifier in Sentry if a direct event link is unavailable."));
          const external = evidenceLink(item.evidence.url); if (external) card.append(external);
        }
        if (!item.acknowledgedAt) {
          const acknowledge = button("Acknowledge alert", () => { void perform(async () => { await request(API + "/alerts/" + encodeURIComponent(item.id) + "/ack", {}); if (!disposed) { await load(); notice("Alert acknowledged locally. No upstream issue or application state was changed."); } }); });
          acknowledge.dataset.requiresClean = "true"; card.append(acknowledge);
        }
        alertPanel.append(card);
      }
    }
    async function createConnection() {
      const body = { appId: app.value, environment: environment.value, displayName: displayName.value.trim(), region: region.value, organization: organization.value.trim(), project: project.value.trim(), token: token.value };
      if (!body.appId || !body.environment || !body.displayName || !body.organization || !body.project || !body.token) throw new Error("Choose an application and environment, then enter the connection name, organization, project and read-only token.");
      if (slack.value) body.slackWebhook = slack.value;
      await request(API + "/connections", body);
      if (disposed) return;
      clearSetup(); await load(); notice("Sentry access verified and monitoring started. Verify the first completed poll below; send a Slack test if configured.");
    }
    const refresh = button("Refresh monitoring status", () => {
      if (dirtyForms.size && !root.confirm("Discard unsaved setup and credential edits, then refresh monitoring status?")) return;
      clearSetup(); clearCredentials(); alertOffset = 0; void perform(() => load(true));
    });
    intro.append(document.createTextNode(" · "), refresh);
    function schedule() { timer = root.setTimeout(async () => { if (disposed) return; if (!busy && !dirtyForms.size) await perform(() => load()); if (!disposed) schedule(); }, 30000); }
    void perform(() => load(true)); schedule();
    const cleanup = () => { disposed = true; root.clearTimeout(timer); token.value = ""; slack.value = ""; clearCredentials(); controllers.forEach(controller => controller.abort()); controllers.clear(); dirtyForms.clear(); };
    cleanup.isDirty = () => busy || dirtyForms.size > 0;
    return cleanup;
  }
  root.SocLiveMonitoring = Object.freeze({ render });
}(window));
