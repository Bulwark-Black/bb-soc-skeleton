(function (root) {
  "use strict";
  const API = "/api/v1/integrations";
  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  }
  function button(label, action) {
    const node = el("button", label, "resource-action"); node.type = "button";
    if (action) node.addEventListener("click", action);
    return node;
  }
  function panel(title) {
    const node = el("section", undefined, "panel"); node.style.padding = "14px";
    node.append(el("h2", title)); return node;
  }
  function link(label, href) { const node = el("a", label, "resource-action"); node.href = href; return node; }
  function table(title, headers, rows) {
    const wrapper = el("div", undefined, "table-scroll"), node = el("table");
    node.append(el("caption", title, "sr-only"));
    const head = el("thead"), tr = el("tr");
    headers.forEach((title) => { const th = el("th", title); th.scope = "col"; tr.append(th); });
    head.append(tr); node.append(head);
    const body = el("tbody");
    for (const row of rows) {
      const line = el("tr");
      row.forEach((value) => { const td = el("td"); td.append(value && value.nodeType ? value : document.createTextNode(String(value === undefined ? "" : value))); line.append(td); });
      body.append(line);
    }
    if (!rows.length) { const line = el("tr"), cell = el("td", "No matching records.", "muted"); cell.colSpan = headers.length; line.append(cell); body.append(line); }
    node.append(body); wrapper.append(node); return wrapper;
  }
  function render({ container, mode = "integrations", sourceId = "", onError } = {}) {
    if (!container) throw new TypeError("Integration center needs a container.");
    let disposed = false, busy = false, dirty = false, catalog = null, offset = 0, nextOffset = 0;
    let populateKindChoices = () => {};
    const controllers = new Set();
    const intro = panel(mode === "observations" ? "Received observations" : "Connect your own sources");
    intro.append(el("p", "Bring records from any vendor or your own application through an external adapter. The SOC validates canonical events; it does not install arbitrary code, poll vendor APIs, run scanners or store vendor secrets from an integration definition.", "muted"),
      link("Add a source", "#/sources?stab=add"), document.createTextNode(" · "), link("Integration documentation", "#/docs?section=55-vendor-independent-integration-registry-sender-and-observation-coverage"));
    const status = el("p", "Loading integration services…", "muted"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
    container.replaceChildren(intro, status);
    if (!root.SOC_PRIVATE_APPLICATION) {
      status.textContent = "Start the private application and sign in. The static shell has no integration registry or operational records.";
      const cleanup = () => {}; cleanup.isDirty = () => false; return cleanup;
    }
    const content = panel(mode === "observations" ? "Stored canonical facts" : "Installed integration types");
    const editor = panel("Register a custom integration type");
    const form = el("form", undefined, "administration-form"); form.style.display = "grid"; form.style.gap = "12px";
    container.append(content);
    function notice(text, error = false) { if (!disposed) { status.textContent = text; status.setAttribute("role", error ? "alert" : "status"); } }
    function setDirty(value) { dirty = value; form.dataset.dirty = String(value); sync(); }
    function sync() {
      container.querySelectorAll("input,textarea,select,button").forEach((field) => {
        field.disabled = busy || field.dataset.unavailable === "true" || field.dataset.overridden === "true"
          || (dirty && field.dataset.pagination === "true");
      });
    }
    async function request(endpoint, options = {}) {
      const controller = new AbortController(); controllers.add(controller);
      const timeout = root.setTimeout(() => controller.abort(), 20000);
      try {
        const responseLimit = endpoint === API ? 12 * 1024 * 1024 : 4 * 1024 * 1024;
        const response = await root.fetch(endpoint, { ...options, credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal,
          headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}) } });
        if (Number(response.headers.get("content-length")) > responseLimit) { await response.body.cancel(); throw new Error("Integration response is too large."); }
        const reader = response.body.getReader(), chunks = []; let size = 0;
        while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > responseLimit) { await reader.cancel(); throw new Error("Integration response is too large."); } chunks.push(part.value); }
        const bytes = new Uint8Array(size); let at = 0; for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
        const body = JSON.parse(new TextDecoder().decode(bytes));
        if (!response.ok) throw new Error(response.status === 401 ? "Your session ended. Sign in again." : typeof body.message === "string" ? body.message : "Integration request was refused.");
        return body;
      } catch (error) {
        if (error.name === "AbortError") throw new Error("Integration request timed out. Refresh the catalog to check the outcome before resubmitting a change.");
        throw error;
      } finally { root.clearTimeout(timeout); controllers.delete(controller); }
    }
    async function perform(action) {
      if (busy || disposed) return;
      busy = true; sync();
      try { await action(); } catch (error) { if (!disposed) { notice(error.message || "Integration request failed.", true); if (typeof onError === "function") onError(error); } }
      finally { busy = false; if (!disposed) sync(); }
    }
    function field(label, name, type = "text", required = true) {
      const wrapper = el("label", label, "form-field"), input = el(type === "textarea" ? "textarea" : "input");
      input.name = name; input.required = required; if (type !== "textarea") input.type = type;
      wrapper.append(input); form.append(wrapper); return input;
    }
    function coverageTable(data) {
      return table("Implemented source-to-screen coverage", ["Screen", "Canonical kinds", "Behavior", "Boundary"], data.coverage.map((entry) => {
        const query = new URLSearchParams(entry.query || {}).toString();
        return [link(entry.title, "#" + entry.route + (query ? "?" + query : "")), entry.recordKinds.join(", ") || "Local application state", entry.status, entry.limitation];
      }));
    }
    async function readCatalog() {
      const data = await request(API); if (disposed) return;
      catalog = data;
      populateKindChoices(data.recordKinds);
      content.replaceChildren(el("h2", "Installed integration types"), el("p", data.capacity.installed + " of " + data.capacity.maximum + " type slots; " + data.capacity.customInstalled + " custom declarations. Sources, telemetry and request size retain explicit safety limits.", "muted"));
      const rows = data.integrations.map((item) => {
        const manifest = item.manifest, details = el("details");
        details.append(el("summary", "Contract and coverage"), el("p", "Allowed records: " + manifest.payload.recordKinds.join(", ")),
          el("p", "Source categories: " + manifest.supportedSourceKinds.join(", ")),
          el("p", "Declared targets are integration intent, not proof of an implemented screen. The coverage matrix below is the actual shipped read behavior.", "muted"));
        const definition = el("pre", JSON.stringify(manifest, null, 2)); details.append(definition);
        const actions = el("div", undefined, "form-actions");
        if (item.available) actions.append(link("Configure source", "#/sources?stab=add&connectorType=" + encodeURIComponent(manifest.connectorType)));
        if (item.origin === "custom") {
          const remove = button("Remove unused definition", () => {
            if (!root.confirm("Remove this unused integration definition? Source history is never deleted by this action.")) return;
            void perform(async () => { await request(API + "/" + encodeURIComponent(manifest.connectorType), { method: "DELETE", body: JSON.stringify({ expectedRevision: catalog.revision }) }); await readCatalog(); notice("Unused definition removed. Source history is unchanged."); });
          });
          remove.dataset.unavailable = String(!item.removable); remove.disabled = !item.removable;
          actions.append(remove); if (!item.removable) actions.append(el("small", "Referenced by source history; cannot remove.", "muted"));
        }
        return [manifest.displayName, manifest.connectorType, item.origin, item.available ? "Admission available" : "Template — driver missing", details, actions];
      });
      const coverage = el("details");
      coverage.append(el("summary", "Source-to-screen coverage — " + data.coverage.length + " implemented views"), coverageTable(data));
      content.append(table("Integration types", ["Name", "Type", "Origin", "Availability", "Contract", "Actions"], rows), coverage);
      notice("Catalog revision " + data.revision + ". Admission means validated delivery is supported, not that a vendor collector or automated workflow is installed.");
    }
    if (mode === "integrations") {
      editor.append(el("p", "For most sources, choose Universal canonical events in Add a source. Register a custom type when you want a named reusable contract with a narrower allowed-kind list. New declarations are immutable; use a new type ID for incompatible changes.", "muted"));
      const id = field("Integration type ID", "integrationType"); id.maxLength = 80; id.pattern = "[a-z][a-z0-9.-]{0,79}";
      const name = field("Display name", "integrationName"); name.maxLength = 120;
      const kind = field("Source category", "sourceCategory"); kind.maxLength = 80; kind.pattern = "[a-z][a-z0-9.-]{0,79}";
      const cadence = field("Expected cadence (seconds)", "integrationCadence", "number"); cadence.min = "60"; cadence.max = "31536000"; cadence.value = "300";
      const kinds = el("fieldset"); kinds.append(el("legend", "Allowed canonical record kinds — choose only what this adapter produces")); form.append(kinds);
      const advanced = el("details"), rawLabel = el("label", "Complete manifest JSON (optional)", "form-field"), raw = el("textarea");
      raw.name = "manifestJson"; raw.rows = 10; raw.maxLength = 65536;
      rawLabel.append(raw); advanced.append(el("summary", "Advanced: import a declarative manifest"), el("p", "When supplied, this replaces the simple fields above. Only application-scoped canonical push definitions are accepted. No executable modules, vendor secrets or polling configuration."), rawLabel); form.append(advanced);
      function syncManifestMode() {
        const overridden = Boolean(raw.value.trim());
        for (const input of [id, name, kind, cadence]) { input.required = !overridden; input.dataset.overridden = String(overridden); }
        kinds.querySelectorAll("input").forEach((input) => { input.dataset.overridden = String(overridden); });
        sync();
      }
      populateKindChoices = (values) => {
        const existing = new Set(Array.from(kinds.querySelectorAll("input")).map((input) => input.value));
        for (const value of values) {
          if (existing.has(value)) continue;
          const label = el("label"), input = el("input"); input.type = "checkbox"; input.name = "allowedKind"; input.value = value;
          label.style.display = "block"; label.append(input, document.createTextNode(" " + value)); kinds.append(label);
        }
        syncManifestMode();
      };
      raw.addEventListener("input", syncManifestMode);
      const submit = button("Register integration type"); submit.type = "submit";
      form.append(submit, button("Discard draft", () => {
        if (dirty && !root.confirm("Discard the integration definition draft?")) return;
        form.reset(); cadence.value = "300"; syncManifestMode(); setDirty(false);
      }));
      form.addEventListener("input", () => setDirty(true)); form.addEventListener("change", () => setDirty(true));
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        void perform(async () => {
          if (!catalog) throw new Error("Load the integration catalog before registering a definition.");
          const selected = Array.from(kinds.querySelectorAll("input")).filter((input) => input.checked).map((input) => input.value);
          const interval = Number(cadence.value);
          let manifest;
          if (raw.value.trim()) { try { manifest = JSON.parse(raw.value); } catch { throw new Error("Manifest JSON is invalid. Nothing was submitted."); } }
          else {
            if (!selected.length) throw new Error("Select at least one canonical record kind.");
            manifest = { schemaVersion: "1", documentType: "connector-manifest", connectorType: id.value.trim(), connectorVersion: "1.0.0", displayName: name.value.trim(), scope: "application",
              supportedSourceKinds: [kind.value.trim()], payload: { schemaId: "soc.canonical-records", schemaVersion: "1", recordKinds: selected, lines: "forbidden", content: "required" },
              targets: [{ route: "/sources", surfaces: ["expected-sources"], recordKinds: selected }],
              configFields: [{ key: "cadence-seconds", label: "Expected collection cadence", valueType: "duration-seconds", required: true, minimum: 60, maximum: 31536000 }], credentialSlots: [],
              healthPolicy: { deliveryMode: "push", expectedIntervalSeconds: interval, staleAfterSeconds: Math.min(31536000, interval * 2), offlineAfterSeconds: Math.min(31536000, interval * 3), emptyPayloadIsHealthy: false } };
          }
          manifest = root.SocConsoleConnectorRuntime.validateConnectorManifest(manifest);
          await request(API, { method: "POST", body: JSON.stringify({ expectedRevision: catalog.revision, manifest }) });
          form.reset(); cadence.value = "300"; syncManifestMode(); setDirty(false);
          await readCatalog(); notice("Integration definition registered. Add an application source, validate a redacted sample, activate it, and deliver a real batch to prove collection.");
        });
      });
      editor.append(form); container.append(editor);
      intro.append(document.createTextNode(" · "), button("Refresh catalog", () => { void perform(readCatalog); }));
      void perform(readCatalog);
    } else {
      const filters = panel("Filter retained observations");
      filters.append(form); container.insertBefore(filters, content);
      function choice(label, name) { const wrapper = el("label", label, "form-field"), select = el("select"); select.name = name; const all = el("option", "All"); all.value = ""; select.append(all); wrapper.append(select); form.append(wrapper); return select; }
      const app = choice("Application", "appFilter"), source = choice("Source", "sourceFilter"), kind = choice("Record kind", "kindFilter");
      const apply = button("Apply filters"); apply.type = "submit"; form.append(apply);
      let previousOffsets = [];
      const previous = button("Previous page", () => {
        if (dirty || busy || !previousOffsets.length) return;
        void perform(() => readObservations(previousOffsets[previousOffsets.length - 1], previousOffsets.slice(0, -1)));
      });
      const next = button("Next page", () => {
        if (dirty || busy || next.dataset.unavailable === "true") return;
        void perform(() => readObservations(nextOffset, [...previousOffsets, offset]));
      });
      previous.dataset.pagination = next.dataset.pagination = "true";
      form.addEventListener("input", () => setDirty(true)); form.addEventListener("change", () => setDirty(true));
      form.addEventListener("submit", (event) => { event.preventDefault(); void perform(() => readObservations(0, [])); });
      async function readObservations(requestedOffset = offset, history = previousOffsets) {
        const query = new URLSearchParams({ limit: "25", offset: String(requestedOffset) });
        if (app.value) query.set("appId", app.value); if (source.value) query.set("sourceId", source.value); if (kind.value) query.set("kinds", kind.value);
        const data = await request(API + "/observations?" + query); if (disposed) return;
        offset = requestedOffset; previousOffsets = history;
        setDirty(false); nextOffset = offset + data.records.length;
        const context = new Map(data.sourceContexts.map((item) => [item.sourceId, item]));
        const rows = data.records.map((record) => {
          const source = context.get(record.sourceId), detail = el("details");
          detail.append(el("summary", record.payload.title), el("p", "Record ID: " + record.recordId), el("pre", JSON.stringify(record.payload, null, 2)));
          return [record.observedAt, source ? source.application + " / " + source.environment : record.estateId, source ? source.displayName + " (" + source.state + ")" : record.sourceId, record.kind, record.payload.state, detail];
        });
        content.replaceChildren(el("h2", "Stored canonical facts"), el("p", "These are upstream observations, not independently verified verdicts or locally approved workflow records. No uploaded text can run scripts, fetch links, or issue commands here.", "muted"),
          table("Received canonical observations", ["Observed", "Application / environment", "Source / lifecycle", "Kind", "Reported state", "Details"], rows), previous, document.createTextNode(" "), next);
        previous.dataset.unavailable = String(!previousOffsets.length); next.dataset.unavailable = String(!data.hasMore || !data.records.length);
        notice(data.matched + " matching retained records; showing " + data.records.length + " from offset " + offset + ". Retention may remove older data; this is not a complete historical archive.");
      }
      void perform(async () => {
        const [data, snapshot] = await Promise.all([request(API), request("/api/v1/control/snapshot?reason=refresh")]); if (disposed) return;
        for (const item of snapshot.apps) { const option = el("option", item.displayName); option.value = item.appId; app.append(option); }
        const sources = [...snapshot.setups, ...snapshot.sources];
        for (const item of sources) { const option = el("option", item.displayName + " / " + (item.environment || "default")); option.value = item.sourceId; source.append(option); }
        if (sourceId && !sources.some((item) => item.sourceId === sourceId)) { const option = el("option", sourceId); option.value = sourceId; source.append(option); }
        source.value = sourceId;
        for (const value of data.recordKinds) { const option = el("option", value); option.value = value; kind.append(option); }
        await readObservations();
      });
    }
    const cleanup = () => { disposed = true; controllers.forEach((controller) => controller.abort()); controllers.clear(); };
    cleanup.isDirty = () => dirty || busy;
    return cleanup;
  }
  root.SocIntegrationCenter = Object.freeze({ render });
}(window));
