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
  function render({ container, onError } = {}) {
    if (!container || typeof container.replaceChildren !== "function") throw new TypeError("Service access needs a container.");
    container.replaceChildren();
    const intro = element("section", undefined, "panel"); intro.style.padding = "14px";
    intro.append(element("h2", "Agent service access"), element("p", "Connect an external agent or MCP client to this private application with its own expiring, scoped identity. These credentials are separate from agent enrollment and source-ingest credentials.", "muted"));
    container.append(intro);
    if (!root.SOC_PRIVATE_APPLICATION) {
      intro.append(element("p", "Start the private application and sign in as an operator to manage service access. Static previews and the reference workbench do not issue service credentials.", "muted"));
      const cleanup = () => {}; cleanup.isDirty = () => false; cleanup.refresh = () => {}; return cleanup;
    }
    let disposed = false, busy = false, dirty = false, secretVisible = false, offset = 0;
    const pending = new Set();
    const status = element("p", "Loading service identities…", "muted"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
    const credentials = element("section", undefined, "panel"); credentials.style.padding = "14px"; credentials.hidden = true;
    const list = element("section", undefined, "panel"); list.style.padding = "14px";
    const create = element("section", undefined, "panel"); create.style.padding = "14px";
    const form = element("form", undefined, "administration-form"); form.style.display = "grid"; form.style.gap = "12px";
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
    form.append(nameLabel, expiryLabel, scopeFields, element("p", "Read-only registry access is selected by default. Prompt bodies and each write operation need a separate explicit grant. Credentials cannot issue other credentials, create or expand agent privileges, or activate prompts. Scopes cover the whole single-tenant installation, not one application.", "muted"), submit);
    create.append(element("h2", "Add an agent connection"), form);
    const audit = element("section", undefined, "panel"); audit.style.padding = "14px";
    container.append(status, credentials, list, create, audit);
    function notice(message, error = false) { if (!disposed) { status.textContent = message; status.setAttribute("role", error ? "alert" : "status"); } }
    function sync() {
      container.setAttribute("data-service-access-dirty", String(dirty || secretVisible));
      form.querySelectorAll("input,select,button").forEach(field => { field.disabled = busy || secretVisible; });
    }
    function clearSecret() { credentials.replaceChildren(); credentials.hidden = true; secretVisible = false; sync(); }
    function showSecret(result) {
      if (disposed) return;
      clearSecret(); secretVisible = true;
      const value = element("textarea"); value.readOnly = true; value.value = result.oneTimeCredential; value.rows = 3;
      value.setAttribute("aria-label", "One-time service credential"); value.autocomplete = "off"; value.spellcheck = false;
      credentials.hidden = false;
      credentials.append(element("h2", "Save this credential now"), element("p", "Shown only once. Save it outside the repository in an owner-only file (mode 0600), then pass that file path to MCP using --token-file or SOC_AGENT_MCP_TOKEN_FILE. Never paste it in a prompt, commit it, or place it in command arguments. Closing this panel clears the browser copy. Rotation invalidates the previous credential immediately.", "muted"), value,
        element("p", "Expires: " + result.service.expiresAt + ". Rotation preserves this expiry.", "muted"),
        button("I saved it — clear credential", clearSecret));
      sync(); value.focus(); value.select();
    }
    async function request(endpoint, options = {}) {
      const controller = new AbortController(); pending.add(controller);
      const timeout = root.setTimeout(() => controller.abort(), 20000);
      try {
        const response = await root.fetch(endpoint, { ...options, credentials: "same-origin", cache: "no-store", signal: controller.signal,
          headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}) } });
        const body = await response.json();
        if (!response.ok) throw new Error(typeof body.message === "string" ? body.message : "Service access request was refused.");
        return body;
      } catch (error) {
        if (error.name === "AbortError" && !disposed) throw new Error("Service access request timed out. Refresh to check the outcome. If an issued credential was not received, revoke that identity and issue another.");
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
        const box = element("input"); box.type = "checkbox"; box.name = "scope"; box.value = scope; box.defaultChecked = data.defaultScopes.includes(scope); box.checked = box.defaultChecked;
        label.append(box, document.createTextNode(" " + scope));
        (scope.endsWith(":read") ? read : writes).append(label);
      }
      scopeFields.append(read, writes);
    }
    async function change(service, action) {
      if (busy || dirty || secretVisible) { notice("Save or discard the draft and clear the one-time credential before changing an identity."); return; }
      if (!root.confirm((action === "rotate" ? "Rotate this credential? The current credential will immediately stop working." : "Revoke this credential? Its agent will immediately lose service access.") + "\n" + service.name)) return;
      await perform(async () => {
        const result = await request("/api/v1/service-access/" + encodeURIComponent(service.id) + "/" + action,
          { method: "POST", body: JSON.stringify({ expectedRevision: service.revision }) });
        if (result.oneTimeCredential) showSecret(result);
        await load();
        notice(action === "rotate" ? "Credential rotated. Save its one-time value." : "Service credential revoked.");
      });
    }
    async function load() {
      const data = await request("/api/v1/service-access?offset=" + offset + "&limit=50");
      if (disposed) return;
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
          element("p", "Last authenticated request: " + (service.lastUsedAt || "Never"), "muted"),
          element("p", service.scopes.join(" · "), "muted"));
        if (service.status === "active") card.append(button("Rotate credential", () => change(service, "rotate")));
        if (!service.revokedAt) card.append(button("Revoke access", () => change(service, "revoke")));
        list.append(card);
      }
      const paging = element("div", undefined, "administration-actions");
      function page(next) { if (busy || dirty || secretVisible) { notice("Clear the current draft and credential before changing pages."); return; } offset = next; perform(load); }
      if (offset > 0) paging.append(button("Previous", () => page(Math.max(0, offset - 50))));
      if (data.nextOffset !== null) paging.append(button("Next", () => page(data.nextOffset)));
      list.append(paging);
      audit.replaceChildren(); audit.append(element("h2", "Recent service access audit"), element("p", "Latest 100 events; the last " + data.auditRetention + " are retained locally. Authorization is recorded here; command completion is recorded in the connector or administration change history.", "muted"));
      for (const entry of data.audit) audit.append(element("p", entry.occurredAt + " · " + entry.action + " · " + entry.outcome + " · " + entry.actor, "muted"));
      notice("Service access ready.");
    }
    form.addEventListener("input", () => { dirty = true; sync(); });
    form.addEventListener("change", () => { dirty = true; sync(); });
    form.addEventListener("submit", event => {
      event.preventDefault();
      if (secretVisible) return;
      const scopes = Array.from(form.querySelectorAll('input[name="scope"]:checked')).map(field => field.value);
      if (!scopes.length) { notice("Choose at least one permission.", true); return; }
      if (scopes.some(scope => !scope.endsWith(":read")) && !root.confirm("This credential grants write operations across this installation. Issue it with the exact selected scopes?")) return;
      perform(async () => {
        const result = await request("/api/v1/service-access", { method: "POST", body: JSON.stringify({ name: name.value.trim(), scopes, expiresInSeconds: Number(expiry.value) }) });
        if (disposed) return;
        dirty = false; form.reset(); form.removeAttribute("data-dirty"); expiry.value = "86400";
        // Keep the one-time value visible even if the following list refresh fails.
        showSecret(result); await load(); notice("Credential issued. Save its one-time value before leaving this tab.");
      });
    });
    function beforeUnload(event) { if (dirty || busy || secretVisible) { event.preventDefault(); event.returnValue = ""; } }
    root.addEventListener("beforeunload", beforeUnload);
    function cleanup() { disposed = true; pending.forEach(controller => controller.abort()); pending.clear(); root.removeEventListener("beforeunload", beforeUnload); credentials.replaceChildren(); container.removeAttribute("data-service-access-dirty"); }
    cleanup.isDirty = () => dirty || busy || secretVisible;
    cleanup.refresh = () => { if (dirty || busy || secretVisible) { notice("Refresh paused to preserve the draft or one-time credential."); return; } return perform(load); };
    perform(load);
    return cleanup;
  }
  root.SocServiceAccess = Object.freeze({ render });
})(typeof window !== "undefined" ? window : globalThis);
