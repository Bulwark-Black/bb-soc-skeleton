(function (root) {
  "use strict";
  const API = "/api/v1/setup", RESPONSE_LIMIT = 4 * 1024 * 1024;
  const PATHS = Object.freeze({
    live: { title: "Live Sentry connection", href: "#/sources?stab=live", action: "Connect live Sentry monitoring", detail: "The private server reads a Sentry Cloud project's error events automatically while it is running. Access, collection, retained events and optional Slack delivery are separate checks. The selected environment labels the whole project feed; it is not an upstream filter." },
    vendor: { title: "Vendor export / API-page import", href: "#/sources?stab=vendors", action: "Choose a vendor import", detail: "Use a reviewed vendor preset and your own exported JSON or NDJSON. Imports are one-time deliveries. Ongoing acquisition and scheduling require your own collector; installing a preset does not start polling." },
    custom: { title: "Custom / canonical source", href: "#/sources?stab=add&connectorType=canonical-events", action: "Configure a custom source", detail: "Configure an existing compatible integration or a canonical-events source, validate a sample and activate it. Your application or collector sends normalized records. Registration alone does not collect data, and custom mappings must follow the integration contract." },
    trivy: { title: "Trivy scan-report import", href: "#/sources?stab=add&connectorType=trivy-report", action: "Configure a Trivy report source", detail: "Configure and activate a Trivy report source, then import a report in Scans → Trivy. This application does not run scans; your scanner or scheduled worker must produce and deliver each report." }
  });
  const STATES = Object.freeze({ pass: "Pass", waiting: "Waiting for evidence", attention: "Needs attention", "not-applicable": "Not applicable" });
  function el(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = String(text); if (className) node.className = className; return node; }
  function panel(title) { const node = el("section", undefined, "panel"); node.style.padding = "14px"; node.append(el("h2", title)); return node; }
  function button(label, action) { const node = el("button", label, "resource-action"); node.type = "button"; node.addEventListener("click", action); return node; }
  function link(label, href) { const node = el("a", label, "resource-action"); node.href = href; node.style.display = "inline-flex"; node.style.margin = "4px 6px 4px 0"; return node; }
  function form() { const node = el("form", undefined, "administration-form"); node.style.display = "grid"; node.style.gap = "12px"; node.addEventListener("submit", event => event.preventDefault()); return node; }
  function field(parent, label, name, tag = "select") { const wrapper = el("label", label, "form-field"), input = el(tag); input.name = name; if (tag === "input") input.type = "text"; wrapper.append(input); parent.append(wrapper); return input; }
  function option(select, label, value) { const node = el("option", label); node.value = value; select.append(node); }
  function internalHref(value) { return typeof value === "string" && value.length <= 2048 && /^#\/(?!\/)[a-z0-9/-]*(?:\?[^#\s\\<>]*)?$/.test(value) ? value : null; }
  function timestamp(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : "Not available"; }
  function render({ container, onError, onSelection, query } = {}) {
    if (!container) throw new TypeError("Setup guides need a container.");
    let disposed = false, busy = false, bindingDirty = false, registerDirty = false, selectedId = null, loaded = false, sequence = 0, registrationCommand = null;
    let setup = { revision: 0, plans: [], choices: [] }, apps = [], diagnostic = null;
    const controllers = new Set();
    const requestedId = query && typeof query.get === "function" ? query.get("setupId") : query?.setupId;
    const intro = panel("Monitor my application");
    intro.append(el("p", "Register or choose your application, choose how data will arrive, connect a source, then check the evidence. Saved guides are resumable on this private server; they store application and source references, never credentials or sample data.", "muted"),
      el("p", "A saved guide is not proof of monitoring. Check my setup reads current local evidence without polling a vendor, sending a notification, importing data or changing source state. Keep this SOC private on your tailnet.", "muted"),
      link("Detailed setup and diagnostics guide", "#/docs?section=58-guided-setup-monitor-my-application-and-check-my-setup"));
    const status = el("p", "Loading application setup…", "muted"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
    container.replaceChildren(intro, status);
    if (!root.SOC_PRIVATE_APPLICATION) {
      status.textContent = "Start the private application and sign in to save a setup guide and check your own sources. The static skeleton makes no requests, stores no guide and contains no monitoring evidence.";
      const cleanup = () => {}; cleanup.isDirty = () => false; return cleanup;
    }
    const savedPanel = panel("Resume a saved guide"), appPanel = panel("1 · Choose your application"), pathPanel = panel("2 · Choose how data arrives"), sourcePanel = panel("3 · Connect and bind your source"), checkPanel = panel("4 · Check my setup");
    const bindingForm = form(), app = field(bindingForm, "Registered application", "setupApp"), environment = field(bindingForm, "Environment", "setupEnvironment");
    appPanel.append(bindingForm);
    const registration = el("details"); registration.append(el("summary", "Register a new web application"));
    const registerForm = form(), name = field(registerForm, "Application display name", "setupApplicationName", "input"), newEnvironment = field(registerForm, "Initial environment", "setupNewEnvironment", "input");
    name.required = true; name.maxLength = 120; newEnvironment.required = true; newEnvironment.maxLength = 80; newEnvironment.value = "production";
    registerForm.append(el("p", "No host or server enrollment is required for application-scoped sources. Use a lowercase environment such as production, staging or test. Additional application details can be managed in Onboarding.", "muted"));
    const registerButton = button("Register application", () => { void perform(registerApplication); });
    const discardRegistration = button("Discard application draft", () => { clearRegistration(); drawConfiguration(); notice("Application draft discarded. No registered application was removed."); sync(); });
    registerForm.append(registerButton, discardRegistration, link("Open full application onboarding", "#/onboard")); registration.append(registerForm); appPanel.append(registration);
    const pathForm = form(), path = field(pathForm, "Collection path", "setupPath");
    Object.entries(PATHS).forEach(([value, item]) => option(path, item.title, value));
    const pathDetail = el("p", undefined, "muted"); pathPanel.append(pathForm, pathDetail);
    const sourceForm = form(), source = field(sourceForm, "Compatible configured source (optional until connected)", "setupSource");
    const target = el("p", undefined, "muted"), configuration = el("div"), selectedNotice = el("p", undefined, "muted");
    const save = button("Save setup guide", () => { void perform(saveGuide); });
    const discardBinding = button("Discard guide edits", () => { applySelection(selectedId); notice("Unsaved guide edits discarded. Connected sources were not changed."); });
    sourceForm.append(save, discardBinding); sourcePanel.append(target, configuration, sourceForm, selectedNotice);
    const runCheck = button("Check my setup", () => { void perform(checkSetup); });
    const results = el("div"); checkPanel.append(el("p", "Read-only diagnostics separate access, source activation, accepted records, collection, screen coverage and notification evidence. A healthy empty poll can prove collection without proving that an event or notification has arrived.", "muted"), runCheck, results);
    container.append(savedPanel, appPanel, pathPanel, sourcePanel, checkPanel);
    function notice(text, error = false) { if (!disposed) { status.textContent = text; status.setAttribute("role", error ? "alert" : "status"); } }
    function clearRegistration() { name.value = ""; newEnvironment.value = "production"; registerDirty = false; registrationCommand = null; }
    function currentPlan() { return setup.plans.find(item => item.id === selectedId) || null; }
    function bindings() { return { appId: app.value, environment: environment.value, path: path.value, sourceId: source.value || null }; }
    function compatibleChoices() { return setup.choices.filter(item => item.appId === app.value && item.environment === environment.value && item.path === path.value); }
    function validBinding() { return apps.some(item => item.appId === app.value && (item.environments || ["default"]).includes(environment.value)) && Object.hasOwn(PATHS, path.value); }
    function dirty() { bindingDirty = true; diagnostic = null; drawDiagnostic(); sync(); }
    function sync() {
      container.querySelectorAll("button,input,select").forEach(node => { node.disabled = busy || (!loaded && node.dataset.canRetry !== "true"); });
      [app, environment, path, source, save, discardBinding].forEach(node => { node.disabled ||= registerDirty; });
      [name, newEnvironment, registerButton].forEach(node => { node.disabled ||= bindingDirty; });
      if (selectedId) { app.disabled = true; environment.disabled = true; }
      save.disabled ||= !validBinding() || Boolean(selectedId && !bindingDirty);
      runCheck.disabled ||= !selectedId || bindingDirty || registerDirty;
      bindingForm.dataset.dirty = String(bindingDirty); pathForm.dataset.dirty = String(bindingDirty); sourceForm.dataset.dirty = String(bindingDirty); registerForm.dataset.dirty = String(registerDirty);
    }
    function fillEnvironments(preferred) {
      environment.replaceChildren(); const selected = apps.find(item => item.appId === app.value);
      const environments = selected ? selected.environments || ["default"] : [];
      for (const value of environments) option(environment, value, value);
      if (environments.includes(preferred)) environment.value = preferred;
    }
    function fillSources(preferred, keepMissing = false) {
      source.replaceChildren(); option(source, "Not connected yet — choose a source after configuration", "");
      const choices = compatibleChoices();
      for (const item of choices) option(source, item.displayName + " · " + item.state + " · " + item.sourceId, item.sourceId);
      if (choices.some(item => item.sourceId === preferred)) source.value = preferred;
      else if (preferred && keepMissing) { option(source, "Previously saved source is unavailable — choose a replacement or clear it", preferred); source.value = preferred; }
      pathDetail.textContent = PATHS[path.value]?.detail || "Choose a collection path.";
      target.textContent = "Target: " + (apps.find(item => item.appId === app.value)?.displayName || "Choose an application") + " · environment: " + (environment.value || "not selected") + ". Confirm this same application and environment in the connection tool.";
      selectedNotice.textContent = preferred && keepMissing && !choices.some(item => item.sourceId === preferred)
        ? "The saved source no longer matches the current available sources. Check the guide for a precise diagnosis, or choose a compatible replacement and save. No different source has been selected automatically."
        : choices.length ? "Only sources matching this application, environment and collection path are listed. Configured or paused does not mean collecting." : "No matching source is configured yet. Save this guide, follow the connection link, then return and refresh to bind the new source.";
      drawConfiguration();
    }
    function drawConfiguration() {
      configuration.replaceChildren(); const choice = PATHS[path.value]; if (!choice) return;
      if (!selectedId || bindingDirty || registerDirty) { configuration.append(el("p", "Save or discard your guide edits before leaving to configure a source. You can return through Resume a saved guide.", "muted")); return; }
      configuration.append(link(choice.action, scopedHref(choice.href)));
      if (path.value === "trivy") configuration.append(document.createTextNode(" · "), link("Import a Trivy report", scopedHref("#/scans?tab=trivy")));
      if (path.value === "custom") configuration.append(document.createTextNode(" · "), link("Map a redacted custom-source sample", scopedHref("#/sources?stab=mapping")));
      if (path.value === "live") configuration.append(el("p", "Polling and optional Slack tests are explicit actions in Live monitoring. Check my setup will never trigger either action.", "muted"));
      configuration.append(el("p", "After connecting, return here and use Refresh guides and sources. Select the new source and save before checking its evidence.", "muted"));
    }
    function scopedHref(href) {
      const selected = currentPlan(); if (!selected) return href;
      const values = { appId: selected.appId, environment: selected.environment, setupId: selected.id, ...(selected.sourceId ? { sourceId: selected.sourceId } : {}) };
      return href + (href.includes("?") ? "&" : "?") + Object.entries(values).map(([key, value]) => encodeURIComponent(key) + "=" + encodeURIComponent(value)).join("&");
    }
    function applySelection(id, preferredApp, preferredEnvironment) {
      selectedId = id && setup.plans.some(item => item.id === id) ? id : null;
      const selected = currentPlan(); app.replaceChildren(); option(app, "Choose your application…", "");
      for (const item of apps) option(app, item.displayName, item.appId);
      const wantedApp = selected?.appId || preferredApp;
      if (wantedApp && !apps.some(item => item.appId === wantedApp) && selected) option(app, "Saved application unavailable · " + wantedApp, wantedApp);
      if (wantedApp) app.value = wantedApp;
      fillEnvironments(selected?.environment || preferredEnvironment);
      if (selected && environment.value !== selected.environment) { option(environment, "Saved environment unavailable · " + selected.environment, selected.environment); environment.value = selected.environment; }
      path.value = selected?.path || "live"; bindingDirty = false; diagnostic = null;
      fillSources(selected?.sourceId, true); drawDiagnostic(); drawSaved(); sync();
      // The host owns navigation/history. Report only a loaded, validated plan
      // selection so it can preserve the bookmark without remounting this view.
      if (typeof onSelection === "function") onSelection(selectedId);
    }
    app.addEventListener("change", () => { fillEnvironments(); dirty(); fillSources(); });
    environment.addEventListener("change", () => { dirty(); fillSources(); });
    path.addEventListener("change", () => { dirty(); fillSources(); });
    source.addEventListener("change", () => { dirty(); drawConfiguration(); });
    registerForm.addEventListener("input", () => { registerDirty = true; registrationCommand = null; drawConfiguration(); sync(); });
    registerForm.addEventListener("change", () => { registerDirty = true; registrationCommand = null; drawConfiguration(); sync(); });
    function approveDiscard() { return !(bindingDirty || registerDirty) || root.confirm("Discard unsaved application or guide edits? Saved guides, sources and monitoring data will remain unchanged."); }
    function drawSaved() {
      savedPanel.replaceChildren(el("h2", "Resume a saved guide"), el("p", "Guides remember your choices, not a completion score. App and environment are fixed for each saved guide; start another guide to monitor a different target.", "muted"));
      if (!setup.plans.length) savedPanel.append(el("p", "No saved guides yet. Start with your application below.", "muted"));
      for (const item of setup.plans) {
        const card = el("article", undefined, "panel"); card.style.padding = "12px";
        const appName = apps.find(entry => entry.appId === item.appId)?.displayName || item.appId;
        card.append(el("h3", appName + " · " + item.environment), el("p", (PATHS[item.path]?.title || "Unsupported path") + (item.id === selectedId ? " · Open guide" : "") + " · Updated: " + timestamp(item.updatedAt)),
          button("Resume " + appName + " / " + item.environment + " / " + (PATHS[item.path]?.title || item.path), () => { if (!approveDiscard()) return; clearRegistration(); applySelection(item.id); notice("Saved guide resumed. Run Check my setup for current evidence."); }),
          link("Bookmark this guide", "#/sources?stab=setup&setupId=" + encodeURIComponent(item.id)),
          button("Remove guide for " + appName + " / " + item.environment + " / " + (PATHS[item.path]?.title || item.path), () => {
            if (!approveDiscard() || !root.confirm("Remove only this saved setup guide? Its application, sources, credentials, telemetry and notifications will not be changed.")) return;
            void perform(async () => { await request(API + "/plans/" + encodeURIComponent(item.id), "DELETE", { expectedRevision: setup.revision }); if (disposed) return; clearRegistration(); bindingDirty = false; if (selectedId === item.id) selectedId = null; await load(); notice("Saved guide removed. Its application, sources and monitoring data were not changed."); });
          })); savedPanel.append(card);
      }
      savedPanel.append(button("Start another setup guide", () => { if (!approveDiscard()) return; clearRegistration(); applySelection(null); notice("New guide started. Existing guides and sources remain unchanged."); }));
    }
    async function request(url, method = "GET", body) {
      if (disposed) throw new Error("Setup view is closed.");
      const controller = new AbortController(); controllers.add(controller); const timeout = root.setTimeout(() => controller.abort(), 30000);
      try {
        const response = await root.fetch(url, { method, credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal,
          headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const reader = response.body.getReader(), chunks = []; let size = 0;
        while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > RESPONSE_LIMIT) { await reader.cancel(); throw new Error("Setup response exceeds its limit."); } chunks.push(part.value); }
        if (!response.ok) {
          const messages = { 400: "The setup choices were refused. Refresh sources and verify the application, environment and collection path.", 401: "Your session ended. Sign in again.", 403: "This setup action is not permitted. Confirm your private sign-in and access.", 404: "The guide or selected resource no longer exists. Refresh guides and sources.", 409: "Setup changed, a matching guide already exists, or a source is incompatible. Refresh guides and sources, then resume the existing guide or review its binding.", 413: "The setup request exceeded its limit.", 503: "Setup diagnostics are unavailable. Check the private server and refresh." };
          throw new Error(messages[response.status] || "Setup request failed. Refresh the saved state before retrying; a write may already have completed.");
        }
        const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch (error) {
        if (error.name === "AbortError") throw new Error("Setup request timed out. Refresh the saved state before retrying; the server may have completed the action.");
        if (error instanceof TypeError || error instanceof SyntaxError) throw new Error("Setup response could not be read. Displayed values may be stale; check the private server and refresh.");
        throw error;
      } finally { root.clearTimeout(timeout); controllers.delete(controller); }
    }
    async function perform(action) {
      if (busy || disposed) return; busy = true; sync();
      try { await action(); } catch (error) { if (!disposed) { notice(error.message || "Setup operation failed. Displayed values may be stale.", true); if (onError) onError(error); } }
      finally { busy = false; if (!disposed) sync(); }
    }
    async function load(preferredApp, preferredEnvironment) {
      const [next, snapshot] = await Promise.all([request(API), request("/api/v1/control/snapshot?reason=refresh")]); if (disposed) return;
      if (!Array.isArray(next.plans) || !Array.isArray(next.choices) || !Number.isSafeInteger(next.revision) || !Array.isArray(snapshot.apps)) throw new Error("Setup service returned an invalid snapshot.");
      setup = next; apps = snapshot.apps; if (!loaded && requestedId) selectedId = requestedId;
      const missing = selectedId && !setup.plans.some(item => item.id === selectedId); loaded = true;
      applySelection(selectedId, preferredApp, preferredEnvironment);
      notice(missing ? "The requested guide is no longer available. Choose a saved guide or start another; no resource was changed." : "Guides and source choices refreshed. Save a binding and run Check my setup for current evidence.");
    }
    async function registerApplication() {
      const displayName = name.value.trim(), environmentName = newEnvironment.value.trim();
      if (!displayName || displayName.length > 120 || !/^[a-z][a-z0-9.-]{0,79}$/.test(environmentName)) throw new Error("Enter an application name up to 120 characters and a lowercase environment using letters, digits, dots or hyphens.");
      registrationCommand ||= { schemaVersion: "1", documentType: "connector-command-request", requestId: "setup-ui-" + Date.now().toString(36) + "-" + (++sequence), command: "app.register", requestedAt: new Date().toISOString(), input: { displayName, hosts: [], environments: [environmentName], publicPages: [] } };
      const result = await request("/api/v1/control/commands", "POST", registrationCommand); if (disposed) return;
      if (result.status !== "succeeded" || typeof result.output?.appId !== "string") throw new Error("Application registration was not confirmed. Refresh applications before retrying; no monitoring has been configured.");
      selectedId = null; clearRegistration(); await load(result.output.appId, environmentName); if (disposed) return;
      bindingDirty = true; drawConfiguration(); notice("Application registered without hosts. Choose how data arrives, then save this setup guide.");
    }
    async function saveGuide() {
      if (!validBinding()) throw new Error("Choose a registered application, its environment and a collection path.");
      const choice = bindings();
      if (choice.sourceId && !compatibleChoices().some(item => item.sourceId === choice.sourceId)) throw new Error("The selected source is no longer compatible. Choose a listed source or clear the selection before saving.");
      const result = selectedId
        ? await request(API + "/plans/" + encodeURIComponent(selectedId), "PATCH", { expectedRevision: setup.revision, path: choice.path, sourceId: choice.sourceId })
        : await request(API + "/plans", "POST", { expectedRevision: setup.revision, ...choice });
      if (disposed) return;
      if (typeof result.plan?.id !== "string") throw new Error("The saved guide could not be confirmed. Refresh guides before retrying.");
      selectedId = result.plan.id; bindingDirty = false; await load(); if (disposed) return;
      notice("Setup guide saved. Connect your source using the link below, or run Check my setup to inspect current evidence. Saving does not activate collection.");
    }
    async function checkSetup() {
      const selected = currentPlan(); if (!selected || bindingDirty || registerDirty) throw new Error("Save or discard guide edits before checking the saved setup.");
      const values = { appId: selected.appId, environment: selected.environment, path: selected.path, ...(selected.sourceId ? { sourceId: selected.sourceId } : {}) };
      const suffix = Object.entries(values).map(([key, value]) => encodeURIComponent(key) + "=" + encodeURIComponent(value)).join("&");
      diagnostic = null; drawDiagnostic();
      const result = await request(API + "/check?" + suffix); if (disposed) return;
      if (!Array.isArray(result.checks) || !Array.isArray(result.destinations) || result.checks.some(item => !Object.hasOwn(STATES, item.state)) || result.appId !== selected.appId || result.environment !== selected.environment || result.path !== selected.path || (result.sourceId || null) !== (selected.sourceId || null)) throw new Error("Setup service returned an invalid or mismatched diagnostic. No result has been treated as proof.");
      diagnostic = result; drawDiagnostic(); notice("Read-only setup check finished. Review each result and its scope; this is a point-in-time check, not continuous supervision.");
    }
    function drawDiagnostic() {
      results.replaceChildren();
      if (!diagnostic) { results.append(el("p", selectedId ? "No current diagnostic is displayed. Save any edits, then run Check my setup. Earlier results are cleared whenever choices or source lists change." : "Save a setup guide to check the selected application and source. You can check before connecting; missing evidence will be shown as waiting, never as success.", "muted")); return; }
      results.append(el("h3", "Results checked at " + timestamp(diagnostic.checkedAt)), el("p", diagnostic.summary || "Review the individual checks below."), el("p", "Evidence is read from this private server at the time shown. This check does not prove vendor-wide coverage, a healthy application, future delivery or human receipt of a notification.", "muted"));
      for (const item of diagnostic.checks) {
        const card = el("article", undefined, "panel"); card.style.padding = "12px";
        card.append(el("h4", STATES[item.state] + " · " + item.title), el("p", item.detail));
        const href = internalHref(item.href);
        if (href) card.append(link("Open " + item.title, ["binding", "activation", "collection", "notification-provider", "notification-human"].includes(item.id) ? scopedHref(href) : href));
        results.append(card);
      }
      if (diagnostic.destinations.length) results.append(el("h3", "Where this source's records appear"));
      for (const item of diagnostic.destinations) {
        const entry = el("p"), href = internalHref(item.href); entry.append(href ? link(item.title, href) : el("span", item.title));
        if (item.detail) entry.append(document.createTextNode(" — " + item.detail)); results.append(entry);
      }
      if (currentPlan()?.sourceId) results.append(link("Open this source's retained observations", "#/sources?stab=observations&sourceId=" + encodeURIComponent(currentPlan().sourceId)));
      if (currentPlan()?.path === "live") results.append(link("Open live connection actions and Slack test", scopedHref("#/sources?stab=live")));
    }
    const refreshButton = button("Refresh guides and sources", () => { if (!approveDiscard()) return; clearRegistration(); applySelection(selectedId); void perform(() => load()); });
    refreshButton.dataset.canRetry = "true"; intro.append(refreshButton);
    void perform(() => load());
    const cleanup = () => { disposed = true; controllers.forEach(controller => controller.abort()); controllers.clear(); clearRegistration(); diagnostic = null; };
    cleanup.isDirty = () => bindingDirty || registerDirty || busy;
    return cleanup;
  }
  root.SocSetupGuides = Object.freeze({ render });
}(window));
