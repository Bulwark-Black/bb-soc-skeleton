(function (root) {
  "use strict";
  const API = "/api/v1/integrations/vendors", MAX_BYTES = 8 * 1024 * 1024;
  function el(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = String(text); if (className) node.className = className; return node; }
  function panel(title) { const node = el("section", undefined, "panel"); node.style.padding = "14px"; node.append(el("h2", title)); return node; }
  function button(label, action) { const node = el("button", label, "resource-action"); node.type = "button"; if (action) node.addEventListener("click", action); return node; }
  function link(label, href) { const node = el("a", label, "resource-action"); node.href = href; return node; }
  function render({ container, onError, query } = {}) {
    if (!container) throw new TypeError("Vendor importer needs a container.");
    let disposed = false, busy = false, dirty = false, catalog, snapshot, adapters = [], preview = null, raw = "", sequence = 0;
    const controllers = new Set();
    const inScope = item => (!query?.get?.("appId") || item.appId === query.get("appId"))
      && (!query?.get?.("environment") || item.environment === query.get("environment"));
    const configureHref = type => "#/sources?stab=add&connectorType=" + encodeURIComponent(type || "")
      + ["appId", "environment", "setupId"].filter(key => query?.get?.(key)).map(key => "&" + key + "=" + encodeURIComponent(query.get(key))).join("");
    const intro = panel("Vendor imports — your application, your sources");
    intro.append(el("p", "Ten reviewed mappings for exported vendor events and API pages. Install a preset, add its source, preview a redacted file, validate and activate the source, then import. No vendor API key is needed here: acquisition and polling run in your own collector.", "muted"),
      link("Detailed setup and delivery guide", "#/docs?section=56-vendor-adapters-and-durable-delivery"));
    const status = el("p", "Loading vendor adapters…", "muted"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
    container.replaceChildren(intro, status);
    if (!root.SOC_PRIVATE_APPLICATION) { status.textContent = "Start the private application and sign in. No vendor credentials, files or records are included in the static skeleton."; const cleanup = () => {}; cleanup.isDirty = () => false; return cleanup; }
    const presets = panel("1 · Choose and install a source preset"), importer = panel("2 · Preview and import your own events");
    const form = el("form", undefined, "administration-form"); form.style.display = "grid"; form.style.gap = "12px";
    function field(label, tag, name) { const wrapper = el("label", label, "form-field"), input = el(tag); input.name = name; wrapper.append(input); form.append(wrapper); return input; }
    const vendor = field("Vendor adapter", "select", "vendorAdapter");
    const source = field("Configured source", "select", "vendorSource");
    const file = field("Redacted JSON or NDJSON file (up to 8 MiB / 1,000 events)", "input", "vendorFile"); file.type = "file"; file.accept = ".json,.ndjson,.jsonl";
    const configure = link("Add this vendor source", "#/sources?stab=add");
    const previewButton = button("Preview mapping", () => { void perform(previewFile); });
    const validateButton = button("Validate source with preview sample", () => { void perform(validateSource); });
    const importButton = button("Import reviewed events", () => { void perform(importFile); });
    const discard = button("Discard selected file", () => { if (dirty && !root.confirm("Discard the selected file and mapping preview?")) return; resetDraft(); notice("File selection discarded. No import was performed."); });
    const output = panel("Mapping preview and delivery receipt");
    form.append(configure, previewButton, validateButton, importButton, discard); importer.append(form); container.append(presets, importer, output);
    function notice(text, error = false) { if (!disposed) { status.textContent = text; status.setAttribute("role", error ? "alert" : "status"); } }
    function sync() {
      container.querySelectorAll("button,input,select").forEach(node => { node.disabled = busy || node.dataset.unavailable === "true"; });
      previewButton.disabled = busy || !source.value || !file.files?.length;
      validateButton.disabled = busy || !preview || !["configured", "tested"].includes(preview.state);
      importButton.disabled = busy || !preview || preview.state !== "active";
      form.dataset.dirty = String(dirty);
    }
    function resetDraft() { dirty = false; preview = null; raw = ""; file.value = ""; output.replaceChildren(el("h2", "Mapping preview and delivery receipt")); sync(); }
    function changed() { dirty = Boolean(file.files?.length); preview = null; raw = ""; output.replaceChildren(el("h2", "Mapping preview and delivery receipt")); sync(); }
    function selectSources() {
      const selected = adapters.find(item => item.id === vendor.value);
      const previousSource = source.value || query?.get?.("sourceId");
      source.replaceChildren(); const none = el("option", "Choose a configured source…"); none.value = ""; source.append(none);
      const unique = new Map([...(snapshot?.setups || []), ...(snapshot?.sources || [])].map(item => [item.sourceId, item]));
      for (const item of unique.values()) if (inScope(item) && item.connectorType === selected?.manifest.connectorType && !["archived", "removed"].includes(item.state)) {
        const option = el("option", item.displayName + " / " + (item.environment || "default") + " / " + item.state); option.value = item.sourceId; source.append(option);
      }
      if (Array.from(source.querySelectorAll("option")).some(item => item.value === previousSource)) source.value = previousSource;
      configure.href = configureHref(selected?.manifest.connectorType);
      changed();
    }
    vendor.addEventListener("change", selectSources); source.addEventListener("change", changed); file.addEventListener("change", changed);
    form.addEventListener("submit", event => event.preventDefault());
    async function request(url, body) {
      if (disposed) throw new Error("Vendor import view is closed.");
      const controller = new AbortController(); controllers.add(controller); const timer = root.setTimeout(() => controller.abort(), 20000);
      try {
        const response = await root.fetch(url, { method: body ? "POST" : "GET", credentials: "same-origin", redirect: "error", cache: "no-store", signal: controller.signal,
          headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
        const reader = response.body.getReader(), chunks = []; let size = 0;
        while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 12 * 1024 * 1024) { await reader.cancel(); throw new Error("Vendor service response exceeds its limit."); } chunks.push(part.value); }
        const bytes = new Uint8Array(size); let at = 0; for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
        const result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        if (!response.ok) throw new Error(response.status === 401 ? "Your session ended. Sign in again." : typeof result.message === "string" ? result.message.slice(0, 400) : "Vendor operation was refused.");
        return result;
      } finally { root.clearTimeout(timer); controllers.delete(controller); }
    }
    async function perform(action) {
      if (busy || disposed) return; busy = true; sync();
      try { await action(); } catch (error) { if (!disposed) { notice(error.name === "AbortError" ? "Request timed out. Keep the same file and retry; receipt identities are stable." : error.message || "Vendor operation failed.", true); if (onError) onError(error); } }
      finally { busy = false; if (!disposed) sync(); }
    }
    async function load() {
      const results = await Promise.all([request(API), request("/api/v1/integrations"), request("/api/v1/control/snapshot?reason=refresh")]); if (disposed) return;
      adapters = results[0].adapters; catalog = results[1]; snapshot = results[2];
      const previous = vendor.value; vendor.replaceChildren();
      for (const item of adapters) { const option = el("option", item.title); option.value = item.id; vendor.append(option); }
      if (adapters.some(item => item.id === previous)) vendor.value = previous;
      else {
        const requested = [...(snapshot.setups || []), ...(snapshot.sources || [])].find(item => item.sourceId === query?.get?.("sourceId") && inScope(item));
        const matched = adapters.find(item => item.manifest.connectorType === requested?.connectorType);
        if (matched) vendor.value = matched.id;
      }
      presets.replaceChildren(el("h2", "1 · Choose and install a source preset"), el("p", "Presets consume a custom integration-type slot. Installation does not create a source, issue access, poll an API or prove collection. Vendor scope and subscription requirements are documented in the guide.", "muted"));
      for (const item of adapters) {
        const details = el("details"), installed = catalog.integrations.some(entry => entry.manifest.connectorType === item.manifest.connectorType);
        details.append(el("summary", item.title + (installed ? " — preset installed" : " — preset available")), el("p", item.description), el("p", "Supported input: " + item.formats.join("; ")),
          el("p", "Produces: " + item.recordKinds.join(", ")));
        if (installed) details.append(link("Configure source", configureHref(item.manifest.connectorType)));
        else details.append(button("Install " + item.title + " preset", () => { void perform(async () => {
          await request("/api/v1/integrations", { manifest: item.manifest, expectedRevision: catalog.revision }); await load(); notice("Preset installed. Add its application source before previewing your events.");
        }); }));
        presets.append(details);
      }
      selectSources(); notice("Loaded " + adapters.length + " vendor mappings. No vendor network connection has been opened.");
    }
    async function previewFile() {
      const selected = file.files?.[0]; if (!selected || !source.value || selected.size < 1 || selected.size > MAX_BYTES) throw new Error("Select a source and a nonempty JSON/NDJSON file up to 8 MiB.");
      const bytes = await selected.arrayBuffer();
      if (disposed) return;
      raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const result = await request(API + "/preview", { adapterId: vendor.value, sourceId: source.value, text: raw }); if (disposed) return;
      preview = result; dirty = true;
      output.replaceChildren(el("h2", "Mapping preview — nothing stored"), el("p", result.totalRecords + " canonical records; first " + result.records.length + " shown. Review the mapping before importing. Original files are not retained."),
        el("pre", JSON.stringify(result.records, null, 2)), el("p", "A provider's reported outcome is not an independently verified SOC verdict. Hashed references are pseudonymous, not guaranteed anonymous.", "muted"));
      notice(result.state === "active" ? "Preview ready. Import reviewed events to commit this exact file to its source." : "Preview ready. Validate the source using this sample, then activate it in Add a source. Preview again after activation.");
    }
    async function validateSource() {
      if (!preview) return;
      const result = await request("/api/v1/control/commands", { schemaVersion: "1", documentType: "connector-command-request", requestId: "vendor-test-" + Date.now().toString(36) + "-" + (++sequence),
        command: "source.test", requestedAt: new Date().toISOString(), input: { sourceId: preview.sourceId, connectorInstanceId: preview.connectorInstanceId, expectedRevision: preview.sourceRevision, recordSample: preview.recordSample } });
      if (disposed) return;
      if (result.status !== "succeeded") throw new Error(result.error?.message || "Source sample validation was refused.");
      preview = null; notice("Source sample validated without storage. Activate the source in Add a source, save its one-time credential privately, then return and preview/import the file.");
    }
    async function importFile() {
      if (!preview || preview.state !== "active") return;
      const result = await request(API + "/import", { adapterId: vendor.value, sourceId: source.value, text: raw, previewHash: preview.previewHash }); if (disposed) return;
      resetDraft();
      output.append(el("pre", JSON.stringify(result.receipt, null, 2)), link("View received observations", "#/sources?stab=observations&sourceId=" + encodeURIComponent(result.receipt.sourceId)));
      notice(result.receipt.replay ? "This exact delivery was already accepted; no duplicate records were added." : "Delivery accepted: " + result.receipt.accepted + " new records, " + result.receipt.duplicates + " previously stored records.");
    }
    intro.append(document.createTextNode(" · "), button("Refresh vendor setup", () => {
      if (dirty && !root.confirm("Discard the selected file/preview and refresh source setup?")) return;
      resetDraft(); void perform(load);
    }));
    void perform(load);
    const cleanup = () => { disposed = true; raw = ""; preview = null; controllers.forEach(controller => controller.abort()); controllers.clear(); };
    cleanup.isDirty = () => dirty || busy;
    return cleanup;
  }
  root.SocVendorImport = Object.freeze({ render });
}(window));
