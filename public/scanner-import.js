(function (root) {
  "use strict";
  const MAX_BYTES = 8 * 1024 * 1024;
  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  }
  function render({ container, sources = [], query, onImported, onError } = {}) {
    if (!container || typeof container.replaceChildren !== "function") throw new TypeError("Scanner import requires a container.");
    let dirty = false, busy = false, disposed = false, controller = null;
    container.replaceChildren();
    const panel = node("section", undefined, "panel"); panel.style.padding = "14px";
    panel.append(node("h2", "Import a Trivy report"), node("p", "Upload existing vulnerability-only Trivy JSON. This imports package and vulnerability observations; it never starts a scan or connects to your registry. Original report bytes, secret findings, image environment, descriptions and target paths are not stored.", "muted"));
    container.append(panel);
    const cleanup = () => { disposed = true; if (controller) controller.abort(); root.removeEventListener("beforeunload", beforeUnload); };
    cleanup.isDirty = () => dirty || busy;
    if (!root.SOC_PRIVATE_APPLICATION) {
      panel.append(node("p", "Start the private application and sign in to import reports.", "muted"));
      return cleanup;
    }
    const eligible = sources.filter((source) => source.connectorType === "trivy-report" && source.sourceKind === "trivy.scan" && source.state === "active"
      && (!query?.get?.("appId") || source.appId === query.get("appId"))
      && (!query?.get?.("environment") || source.environment === query.get("environment"))
      && (!query?.get?.("sourceId") || source.sourceId === query.get("sourceId")));
    if (!eligible.length) {
      panel.append(node("p", query?.get?.("sourceId")
        ? "The requested Trivy source is unavailable, inactive or outside the selected application/environment. No different source has been selected. Review that source and its scope, test its local importer, then activate it."
        : "Add an application source in Sources, choose Trivy JSON report import, test its local importer, then activate it. No collector host is required.", "muted"));
      const scope = ["appId", "environment", "sourceId", "setupId"].filter(key => query?.get?.(key))
        .map(key => encodeURIComponent(key) + "=" + encodeURIComponent(query.get(key))).join("&");
      const link = node("a", "Open Sources", "resource-action"); link.href = "#/sources?stab=add&connectorType=trivy-report" + (scope ? "&" + scope : ""); panel.append(link);
      return cleanup;
    }
    const form = node("form", undefined, "administration-form");
    form.style.display = "grid"; form.style.gap = "12px";
    const sourceLabel = node("label", "Active application source"), select = node("select", undefined, "form-field");
    select.name = "sourceId";
    eligible.forEach((source) => { const option = node("option", source.displayName + " · " + (source.environment || "default")); option.value = source.sourceId; select.append(option); });
    if (eligible.some(source => source.sourceId === query?.get?.("sourceId"))) select.value = query.get("sourceId");
    sourceLabel.append(select);
    const fileLabel = node("label", "Trivy JSON file (maximum 8 MiB)"), input = node("input", undefined, "form-field");
    input.type = "file"; input.name = "report"; input.accept = ".json,application/json"; input.required = true; fileLabel.append(input);
    const submit = node("button", "Import report", "resource-action"); submit.type = "submit";
    const discard = node("button", "Discard selection", "refreshbtn"); discard.type = "button";
    form.append(sourceLabel, fileLabel, node("p", "Supports SchemaVersion 2 package results only: at most 64 result groups and 1,000 normalized records per atomic import. A package record plus each vulnerability counts toward that limit. Reports must fall within the configured replay window (seven days by default). Zero reported findings does not prove complete coverage or a clean application.", "muted"), submit, discard);
    const status = node("p", "", "muted"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
    panel.append(form, status);
    function sync() { select.disabled = busy; input.disabled = busy; submit.disabled = busy; discard.disabled = busy; }
    function setDirty(value) { dirty = value; if (value) form.dataset.dirty = "true"; else delete form.dataset.dirty; }
    function clearFileSelection() { const selected = select.value; form.reset(); select.value = selected; setDirty(false); }
    function beforeUnload(event) { if (dirty || busy) { event.preventDefault(); event.returnValue = ""; } }
    root.addEventListener("beforeunload", beforeUnload);
    form.addEventListener("change", () => setDirty(Boolean(input.files && input.files.length)));
    discard.addEventListener("click", () => { if (busy) return; clearFileSelection(); status.textContent = "File selection discarded. The selected source is unchanged."; });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (busy || disposed) return;
      const file = input.files && input.files[0];
      if (!file || !file.size || file.size > MAX_BYTES) { status.textContent = "Choose a nonempty JSON report no larger than 8 MiB."; status.setAttribute("role", "alert"); return; }
      busy = true; sync(); controller = new AbortController();
      const timeout = root.setTimeout(() => controller.abort(), 30000);
      try {
        status.textContent = "Validating and importing report…"; status.setAttribute("role", "status");
        const response = await root.fetch("/api/v1/scanners/trivy/import?sourceId=" + encodeURIComponent(select.value), {
          method: "POST", credentials: "same-origin", signal: controller.signal,
          headers: { "Content-Type": "application/json", Accept: "application/json" }, body: file
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.message || "Report import failed.");
        if (disposed) return;
        clearFileSelection(); busy = false; sync();
        status.textContent = (result.receipt.replay ? "Report already imported; no duplicate records added. " : "Report imported. ")
          + result.summary.packageCount + " reported packages; " + result.summary.vulnerabilityCount + " reported vulnerabilities.";
        if (typeof onImported === "function") await onImported(result);
      } catch (error) {
        if (disposed) return;
        status.textContent = error.name === "AbortError" ? "Import timed out. Retrying the same file is safe; its deterministic receipt prevents duplicates." : error.message;
        status.setAttribute("role", "alert");
        if (typeof onError === "function") onError(error);
      } finally { root.clearTimeout(timeout); controller = null; busy = false; if (!disposed) sync(); }
    });
    return cleanup;
  }
  root.SocScannerImport = Object.freeze({ render });
})(window);
