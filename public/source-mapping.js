(function (root) {
  "use strict";
  const API = "/api/v1/source-mapping", INPUT_LIMIT = 512 * 1024, RESPONSE_LIMIT = 4 * 1024 * 1024;
  function el(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = String(text); if (className) node.className = className; return node; }
  function panel(title) { const node = el("section", undefined, "panel"); node.style.padding = "14px"; node.append(el("h2", title)); return node; }
  function field(parent, label, name, tag = "select") { const wrapper = el("label", label, "form-field"), node = el(tag); node.name = name; wrapper.append(node); parent.append(wrapper); return node; }
  function option(select, text, value) { const node = el("option", text); node.value = value; select.append(node); }
  function button(text, action) { const node = el("button", text, "resource-action"); node.type = "button"; node.addEventListener("click", action); return node; }
  function link(text, href) { const node = el("a", text, "resource-action"); node.href = href; node.style.display = "inline-flex"; node.style.margin = "4px 6px 4px 0"; return node; }
  function render({ container, onError, query } = {}) {
    if (!container) throw new TypeError("Source mapping needs a container.");
    let disposed = false, busy = false, dirty = false, catalog = null, inspection = null, preview = null;
    const controllers = new Set(), rows = new Map();
    const intro = panel("Connect a source we do not list");
    intro.append(el("p", "Map your own redacted JSON or NDJSON into canonical records. Choose an existing custom or canonical source, inspect field paths, explicitly select the original event ID and timestamp, then preview exactly what would be retained.", "muted"),
      el("p", "This is a one-time, read-only mapping preview. It does not install a collector, schedule exports, test or activate a source, send records, or decide whether a finding is true. No JavaScript, templates, transforms or remote URLs are executed. Raw sample text and draft mappings are not saved.", "muted"),
      el("p", "Remove credentials and private content before pasting. Secret-bearing key names are rejected, but this is not an automatic redactor: secrets can still hide in messages, URLs, IDs and free text. Keep this SOC private on your tailnet.", "muted"));
    const status = el("p", "Loading compatible sources…", "muted"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
    container.replaceChildren(intro, status);
    if (!root.SOC_PRIVATE_APPLICATION) {
      status.textContent = "Start the private application and sign in to inspect your redacted samples. The static skeleton makes no requests and contains no example security data.";
      const cleanup = () => {}; cleanup.isDirty = () => false; return cleanup;
    }
    const binding = panel("1 · Choose the exact application and source"), sample = panel("2 · Inspect a redacted sample"), mapping = panel("3 · Explicitly map retained fields"), output = panel("4 · Review the canonical preview");
    const app = field(binding, "Application", "mappingApp"), environment = field(binding, "Environment", "mappingEnvironment"), source = field(binding, "Custom or canonical source", "mappingSource");
    const kind = field(binding, "Canonical record kind", "mappingKind");
    const configure = link("Configure a canonical source", "#/sources?stab=add&connectorType=canonical-events");
    binding.append(el("p", "Only enabled custom or canonical admission drivers are listed. Vendor imports and Trivy use their reviewed importers. Previewing a configured or paused source is allowed; delivery still requires an active source and its own source credential.", "muted"), configure);
    const text = field(sample, "Redacted JSON or NDJSON (1–100 records, at most 512 KiB)", "mappingText", "textarea"); text.rows = 10; text.spellcheck = false; text.autocomplete = "off";
    const review = field(sample, "I reviewed this sample for credentials, private identifiers and free-text secrets before sending it to the private server", "mappingReviewed", "input"); review.type = "checkbox";
    const inspect = button("Inspect field paths", () => { void perform(inspectSample); });
    const fieldList = el("div"); sample.append(inspect, fieldList);
    const mappingRows = el("div"), fields = field(mapping, "Optional extra scalar fields (JSON object of named path/value mappings; leave empty to omit)", "mappingFields", "textarea"); fields.rows = 4; fields.spellcheck = false; fields.autocomplete = "off";
    mapping.append(el("p", "A JSON Pointer selects an own scalar leaf, including numeric array indexes. No wildcards, coercion, concatenation or date parsing transforms are supported. Every selected path must exist in every record. IDs and timestamps cannot be constants. State/severity constants are your explicit reported claims, not console verdicts.", "muted"), mappingRows);
    const build = button("Preview canonical batch — do not import", () => { void perform(previewMapping); }); mapping.append(build);
    const result = el("div"); output.append(result);
    const reset = button("Discard sample and mapping", () => {
      if (dirty && !root.confirm("Discard the unsaved sample, mapping and preview? No source or imported record will be changed.")) return;
      clearDraft(); notice("Sample and mapping discarded. No source or records were changed.");
    });
    const refresh = button("Refresh compatible sources", () => { if (dirty && !root.confirm("Discard the unsaved mapping and refresh source choices?")) return; clearDraft(); void perform(load); });
    container.append(binding, sample, mapping, output, refresh, reset);
    function notice(message, error = false) { if (!disposed) { status.textContent = message; status.className = error ? "muted error" : "muted"; } }
    function queryValue(key) { return query && typeof query.get === "function" ? query.get(key) : query?.[key]; }
    function currentSource() { return catalog?.sources.find(item => item.sourceId === source.value && item.appId === app.value && item.environment === environment.value); }
    function scopedHref(base, includeSource = true) {
      const selected = catalog?.apps.find(item => item.appId === app.value);
      if (!selected || !selected.environments.includes(environment.value)) return base;
      const values = { appId: app.value, environment: environment.value };
      if (includeSource && currentSource()) values.sourceId = source.value;
      const setupId = queryValue("setupId");
      if (typeof setupId === "string" && /^setup-[a-f0-9-]{36}$/.test(setupId)
          && queryValue("appId") === app.value && queryValue("environment") === environment.value) values.setupId = setupId;
      return base + (base.includes("?") ? "&" : "?") + Object.entries(values).map(([key, value]) => encodeURIComponent(key) + "=" + encodeURIComponent(value)).join("&");
    }
    function invalidate({ sampleChanged = false } = {}) {
      dirty = true; preview = null; result.replaceChildren();
      if (sampleChanged) { inspection = null; fieldList.replaceChildren(); review.checked = false; rows.clear(); mappingRows.replaceChildren(); }
      sync();
    }
    function clearDraft() { text.value = ""; fields.value = ""; review.checked = false; dirty = false; inspection = null; preview = null; rows.clear(); fieldList.replaceChildren(); mappingRows.replaceChildren(); result.replaceChildren(); sync(); }
    function fillEnvironments(preferred) {
      environment.replaceChildren(); const selected = catalog.apps.find(item => item.appId === app.value);
      for (const value of selected?.environments || []) option(environment, value, value);
      if (selected?.environments.includes(preferred)) environment.value = preferred;
    }
    function fillSources(preferred) {
      source.replaceChildren(); option(source, "Choose a source…", "");
      for (const item of catalog.sources.filter(item => item.appId === app.value && item.environment === environment.value && !["archived", "removed"].includes(item.state))) option(source, item.displayName + " · " + item.state, item.sourceId);
      if (catalog.sources.some(item => item.sourceId === preferred && item.appId === app.value && item.environment === environment.value && !["archived", "removed"].includes(item.state))) source.value = preferred;
      fillKinds();
      configure.href = scopedHref("#/sources?stab=add&connectorType=canonical-events", false);
    }
    function fillKinds() { kind.replaceChildren(); option(kind, "Choose the reported kind…", ""); for (const value of currentSource()?.recordKinds || []) option(kind, value, value); }
    function resetRows() { rows.clear(); mappingRows.replaceChildren(); if (!inspection || !kind.value) return;
      createRow("upstreamId", "Original stable event ID", true, true); createRow("observedAt", "Original RFC 3339 event timestamp", true, true);
      const spec = catalog.kinds.find(item => item.kind === kind.value); if (!spec) return;
      for (const name of spec.requiredPayload) createRow(name, name + " (required)", true);
      const optional = el("details"); optional.append(el("summary", "Optional retained fields"), el("p", "These fields are omitted unless you explicitly map one. Keeping them omitted minimizes retained data.", "muted")); mappingRows.append(optional);
      for (const name of spec.optionalPayload) createRow(name, name + " (optional)", false, false, optional);
    }
    function createRow(name, title, required, pathOnly = false, parent = mappingRows) {
      const row = el("div", undefined, "administration-form"); row.style.marginBottom = "12px"; row.append(el("h3", title));
      const mode = field(row, "Mapping mode for " + name, "mappingMode-" + name);
      if (!required) option(mode, "Do not retain this field", "omit");
      option(mode, "Select an original field path", "path"); if (!pathOnly) option(mode, "Use an explicit constant", "value");
      const selected = field(row, "Original field for " + name, "mappingPath-" + name); option(selected, "Choose an inspected scalar leaf…", "");
      for (const leaf of inspection.fields) option(selected, leaf.path + " · " + leaf.types.join("/") + " · " + leaf.present + "/" + inspection.records + " records", leaf.path);
      const constant = field(row, "Explicit constant for " + name, "mappingValue-" + name, catalog.enums[name] ? "select" : "input");
      if (catalog.enums[name]) for (const value of catalog.enums[name]) option(constant, value, value);
      else constant.type = name === "count" ? "number" : "text";
      if (name === "state") { mode.value = "value"; constant.value = "unknown"; }
      if (pathOnly) constant.hidden = true;
      const controls = { mode, selected, constant, pathOnly }; rows.set(name, controls);
      const changed = () => { invalidate(); rowState(controls); };
      for (const node of [mode, selected, constant]) { node.addEventListener("change", changed); node.addEventListener("input", changed); }
      rowState(controls); parent.append(row);
    }
    function rowState(row) { row.selected.disabled = busy || row.mode.value !== "path"; row.constant.disabled = busy || row.pathOnly || row.mode.value !== "value"; row.mode.disabled = busy; }
    app.addEventListener("change", () => { invalidate(); fillEnvironments(); fillSources(); resetRows(); });
    environment.addEventListener("change", () => { invalidate(); fillSources(); resetRows(); });
    source.addEventListener("change", () => { invalidate(); fillKinds(); resetRows(); });
    kind.addEventListener("change", () => { invalidate(); fields.value = ""; resetRows(); sync(); });
    text.addEventListener("input", () => invalidate({ sampleChanged: true }));
    fields.addEventListener("input", () => invalidate()); review.addEventListener("change", () => { dirty = true; sync(); });
    function sync() {
      if (disposed) return;
      configure.href = scopedHref("#/sources?stab=add&connectorType=canonical-events", false);
      for (const node of [app, environment, source, kind, text, review, fields, refresh, reset]) node.disabled = busy;
      inspect.disabled = busy || !text.value.trim() || !review.checked;
      build.disabled = busy || !inspection || !review.checked || !currentSource() || !kind.value;
      for (const row of rows.values()) rowState(row);
    }
    async function request(url, method = "GET", body) {
      const controller = new AbortController(); controllers.add(controller); const timer = root.setTimeout(() => controller.abort(), 30000);
      try {
        const response = await root.fetch(url, { method, credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal,
          headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const reader = response.body.getReader(), chunks = []; let bytes = 0;
        while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > RESPONSE_LIMIT) { await reader.cancel(); throw new Error("Mapping response exceeds the limit."); } chunks.push(part.value); }
        if (!response.ok) throw new Error(({ 400: "Mapping refused. Check required paths, source binding, original IDs/timestamps, secret-bearing key names and canonical value formats. Nothing was imported.", 401: "Sign in to the private application again.", 403: "This mapping action requires private operator access.", 413: "The sample, recipe or output exceeds its size limit. Use a smaller redacted batch." })[response.status] || "The mapping service is unavailable. No import was attempted.");
        const buffer = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
      } finally { root.clearTimeout(timer); controllers.delete(controller); }
    }
    async function perform(action) {
      if (busy || disposed) return; busy = true; sync();
      try { await action(); } catch (error) { if (!disposed) { const safe = error.name === "AbortError" ? new Error("Mapping request timed out; no import was attempted.") : error; notice(safe.message || "Mapping request failed.", true); if (onError) onError(safe); } }
      finally { busy = false; if (!disposed) sync(); }
    }
    async function load() {
      const next = await request(API); if (disposed) return;
      if (next.schemaVersion !== "1" || !Array.isArray(next.apps) || !Array.isArray(next.sources) || !Array.isArray(next.kinds) || !next.enums) throw new Error("The source catalog could not be validated.");
      catalog = next; app.replaceChildren(); option(app, "Choose an application…", ""); for (const item of catalog.apps) option(app, item.displayName, item.appId);
      if (catalog.apps.some(item => item.appId === queryValue("appId"))) app.value = queryValue("appId");
      fillEnvironments(queryValue("environment")); fillSources(queryValue("sourceId"));
      notice("Choose your source and reported kind. Inspect a redacted sample before mapping; nothing is saved or sent to ingestion.");
    }
    function checkedText() {
      if (!review.checked) throw new Error("Review the sample and confirm it has been redacted before continuing.");
      if (!text.value.trim() || new TextEncoder().encode(text.value).byteLength > INPUT_LIMIT) throw new Error("Supply redacted JSON or NDJSON up to 512 KiB.");
      return text.value;
    }
    async function inspectSample() {
      preview = null; result.replaceChildren(); inspection = null; rows.clear(); mappingRows.replaceChildren(); fieldList.replaceChildren();
      const response = await request(API + "/inspect", "POST", { text: checkedText() }); if (disposed) return;
      if (response.schemaVersion !== "1" || !Array.isArray(response.fields) || !Number.isInteger(response.records)) throw new Error("The inspection response could not be validated.");
      inspection = response; dirty = true;
      fieldList.append(el("h3", inspection.records + " records · " + inspection.fields.length + " distinct scalar paths"), el("p", response.notice, "muted"));
      for (const leaf of inspection.fields) fieldList.append(el("p", leaf.path + " · " + leaf.types.join("/") + " · present in " + leaf.present + "/" + inspection.records));
      resetRows(); notice("Paths inspected without returning sample values. Explicitly choose fields below; no source test, activation or ingestion occurred.");
    }
    function recipe() {
      if (!currentSource() || !inspection || !kind.value) throw new Error("Choose a compatible source and kind, then inspect your sample.");
      const value = { schemaVersion: "1", documentType: "source-mapping-recipe", appId: app.value, environment: environment.value, sourceId: source.value, kind: kind.value, payload: {} };
      for (const [name, row] of rows) {
        if (row.mode.value === "omit") continue;
        let selected;
        if (row.mode.value === "path") { if (!row.selected.value) throw new Error("Select an original field path for " + name + "."); selected = { path: row.selected.value }; }
        else { const constant = name === "count" ? (row.constant.value.trim() ? Number(row.constant.value) : NaN) : row.constant.value; if (typeof constant === "number" && !Number.isSafeInteger(constant)) throw new Error("The count constant must be a safe integer."); selected = { value: constant }; }
        if (["upstreamId", "observedAt"].includes(name)) value[name] = selected; else value.payload[name] = selected;
      }
      if (fields.value.trim()) { try { value.payload.fields = JSON.parse(fields.value); } catch { throw new Error("Additional scalar field mappings must be a JSON object, not executable code."); } }
      return value;
    }
    async function previewMapping() {
      preview = null; result.replaceChildren();
      const draft = recipe(), response = await request(API + "/preview", "POST", { appId: draft.appId, environment: draft.environment, sourceId: draft.sourceId, text: checkedText(), recipe: draft });
      if (disposed) return;
      if (response.schemaVersion !== "1" || response.recipe?.appId !== draft.appId || response.recipe?.sourceId !== draft.sourceId || response.recipe?.environment !== draft.environment
          || response.recipe?.kind !== draft.kind || response.batch?.sourceId !== draft.sourceId || !Array.isArray(response.batch?.records) || response.summary?.imported !== false) throw new Error("The preview is invalid or belongs to another source; no output is being offered.");
      preview = response; drawPreview(); notice("Preview ready. Review all retained values before exporting. No source was activated and no records were imported.");
    }
    function drawPreview() {
      result.replaceChildren(); if (!preview) return;
      result.append(el("p", preview.summary.records + " canonical records from " + preview.summary.inputRecords + " input records; " + preview.summary.duplicatesWithinInput + " identical duplicates collapsed. No import performed."), el("p", preview.summary.notice, "muted"));
      const recipeOutput = field(result, "Reviewed recipe — selectable JSON; save outside the repository in a private owner-only directory", "mappingRecipeOutput", "textarea"); recipeOutput.readOnly = true; recipeOutput.rows = 12; recipeOutput.value = JSON.stringify(preview.recipe, null, 2);
      const batchOutput = field(result, "Canonical batch — inspect every retained value before sending", "mappingBatchOutput", "textarea"); batchOutput.readOnly = true; batchOutput.rows = 16; batchOutput.value = JSON.stringify(preview.batch, null, 2);
      if (preview.batch.records.length) {
        const sampleOutput = field(result, "First normalized record — optional validation sample, not the whole batch", "mappingRecordOutput", "textarea"); sampleOutput.readOnly = true; sampleOutput.rows = 10; sampleOutput.value = JSON.stringify(preview.batch.records[0], null, 2);
        result.append(el("p", "For a canonical-events or custom source that is still configured, copy this one reviewed record into that source's Validate sample form (under 60 KiB), then activate it. Canonical log push instead asks for the reviewed message text. Sample validation is not telemetry and does not send this batch. Save your reviewed outputs before leaving; this page does not persist its draft.", "muted"));
      }
      result.append(el("p", "For subsequent exports, save this reviewed recipe as /absolute/private/recipe.json and your redacted export as /absolute/private/events.json. Use real absolute paths to owner-only files (0600) in an owner-only directory (0700), outside this repository. This mapper does not verify current server registration or source activation.", "muted"),
        el("pre", "node tools/map-events.js --recipe /absolute/private/recipe.json --file /absolute/private/events.json"),
        el("p", "The command prints only a canonical batch to stdout. Review and save it privately as /absolute/private/batch.json. After separately testing and activating this source, use its source-ingest credential file—not a vendor token or MCP token—with the existing sender:", "muted"),
        el("pre", "node tools/send-events.js --file /absolute/private/batch.json --token-file /absolute/private/source-token --base-url PRIVATE_ORIGIN"),
        el("p", "Replace PRIVATE_ORIGIN with your configured loopback or approved private HTTPS origin. Keep the original batch for retries; never regenerate IDs or timestamps. Scheduling your exports and running the sender remain your responsibility. No raw sample, credential or sender was persisted here.", "muted"),
        link("Source setup and activation", scopedHref("#/sources?stab=add")), link("Check my setup", scopedHref("#/sources?stab=setup")));
    }
    void perform(load);
    const cleanup = () => { if (disposed) return; disposed = true; for (const controller of controllers) controller.abort(); controllers.clear(); text.value = ""; fields.value = ""; inspection = null; preview = null; rows.clear(); mappingRows.replaceChildren(); fieldList.replaceChildren(); result.replaceChildren(); dirty = false; };
    cleanup.isDirty = () => !disposed && dirty; return cleanup;
  }
  root.SocSourceMapping = Object.freeze({ render });
})(typeof window === "object" ? window : globalThis);
