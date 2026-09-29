(function (root) {
  "use strict";

  const statuses = ["draft", "current", "needs-review", "retired"];
  const linkKinds = ["risk", "attestation", "case", "policy"];
  const accepted = ".pdf,.txt,.md,.log,.csv,.tsv,.xlsx,.xls,.docx,.doc,.pptx,.ppt,.png,.jpg,.jpeg,.gif,.webp,.heic,.json,.zip,.eml,.pcap";
  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined && text !== null) element.textContent = String(text);
    if (className) element.className = className;
    return element;
  }
  function button(text, action, className = "searchbtn") {
    const result = node("button", text, className); result.type = "button";
    if (action) result.addEventListener("click", action);
    return result;
  }
  function panel(title) {
    const result = node("section", null, "panel");
    result.style.padding = "14px";
    result.append(node("h2", title));
    return result;
  }
  function inputField(form, label, name, value, options = {}) {
    const wrap = node("label", label);
    wrap.style.display = "grid"; wrap.style.gap = "5px";
    const input = options.options ? node("select") : node("input");
    input.name = name;
    if (options.options) options.options.forEach((entry) => {
      const option = node("option", entry.label === undefined ? entry : entry.label);
      option.value = entry.value === undefined ? entry : entry.value;
      input.append(option);
    });
    else input.type = options.type || "text";
    input.value = value === undefined || value === null ? "" : value;
    input.required = Boolean(options.required);
    if (options.maxLength) input.maxLength = options.maxLength;
    if (options.accept) input.accept = options.accept;
    input.style.minWidth = "0";
    if (options.help) {
      const help = node("span", options.help, "muted");
      help.style.fontSize = "11px"; wrap.append(input, help);
    } else wrap.append(input);
    form.append(wrap);
    return input;
  }
  function metadataFields(form, value = {}) {
    inputField(form, "Title", "title", value.title, { required: true, maxLength: 200 });
    inputField(form, "Application ID (optional)", "appId", value.appId, { maxLength: 128, help: "Use the application ID from Sources. Leave blank for shared governance documents." });
    inputField(form, "Owner", "owner", value.owner, { maxLength: 160 });
    inputField(form, "Status", "status", value.status || "draft", { options: statuses });
    inputField(form, "Review date", "reviewAt", value.reviewAt, { type: "date" });
    inputField(form, "Linked record type", "linkKind", value.linkKind, { options: [{ value: "", label: "No linked record" }, ...linkKinds] });
    inputField(form, "Linked record ID", "linkId", value.linkId, { maxLength: 128, help: "Add the risk, attestation, case, or policy ID together with its type." });
  }
  function formMetadata(form) {
    const value = {};
    for (const name of ["title", "appId", "owner", "status", "reviewAt", "linkKind", "linkId"]) {
      const raw = form.elements.namedItem(name).value.trim();
      value[name] = raw || (["appId", "reviewAt", "linkKind", "linkId"].includes(name) ? null : "");
    }
    if (Boolean(value.linkKind) !== Boolean(value.linkId)) throw new Error("Choose both a linked record type and its ID, or leave both empty.");
    return value;
  }
  function newForm() {
    const form = node("form", null, "administration-form");
    form.style.display = "grid"; form.style.gap = "12px";
    return form;
  }
  function displayBytes(bytes) { return bytes < 1024 ? bytes + " B" : bytes < 1048576 ? (bytes / 1024).toFixed(1) + " KiB" : (bytes / 1048576).toFixed(1) + " MiB"; }

  function render({ container, apiBase = "/api/v1/documents", onError } = {}) {
    if (!container || typeof container.replaceChildren !== "function") throw new TypeError("Document Library needs a container element.");
    container.replaceChildren();
    if (!root.SOC_PRIVATE_APPLICATION) {
      const unavailable = panel("Documents & evidence");
      unavailable.append(node("p", "Document storage is available when the application server is running. Start the private application to upload files, retain versions, and track review status.", "muted"));
      container.append(unavailable);
      const cleanup = () => {}; cleanup.isDirty = () => false;
      return cleanup;
    }
    if (typeof apiBase !== "string" || !/^\/api\/[A-Za-z0-9/_-]+$/.test(apiBase)) throw new TypeError("Document API must be a same-origin API path.");
    let disposed = false, busy = false, selectedId = null, detail = null, dirty = false, dirtyForm = null, archiveFilter = "active", offset = 0;
    const requests = new Set();
    const status = node("p", "Loading documents…", "muted"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
    const intro = panel("Documents & evidence");
    intro.append(node("p", "Keep versioned documents and case evidence with ownership, review dates, and links to your application, risks, attestations, or policies. Each saved version keeps its original bytes, SHA-256 hash, uploader, and upload time.", "muted"));
    intro.append(node("p", "Files are downloaded as attachments. Uploads are not malware-scanned by this library; apply your own scanning policy before opening them.", "muted"));
    const controls = node("div", null, "administration-actions"); controls.style.display = "flex"; controls.style.gap = "8px"; controls.style.flexWrap = "wrap";
    const filter = node("select"); filter.setAttribute("aria-label", "Document archive filter");
    for (const [value, label] of [["active", "Active documents"], ["archived", "Archive"], ["all", "All documents"]]) { const opt = node("option", label); opt.value = value; filter.append(opt); }
    controls.append(filter, button("Refresh", () => { if (dirty) { message("Refresh paused while a form has unsaved changes."); return; } perform(() => load()); }, "refreshbtn"),
      button("Discard draft", () => { if (busy || !canDiscard()) return; container.querySelectorAll("form").forEach((form) => form.reset()); setDirty(false); renderDetail(); message("Unsaved draft discarded."); }, "refreshbtn"));
    const library = panel("Library"), selected = node("div"), create = panel("Upload a document");
    library.append(controls);
    const rows = node("div"); library.append(rows);
    const createDetails = node("details"), summary = node("summary", "Add a document or evidence file"); createDetails.append(summary);
    const createForm = newForm(); metadataFields(createForm);
    inputField(createForm, "File (maximum 10 MiB)", "file", "", { type: "file", required: true, accept: accepted });
    const upload = button("Upload document"); upload.type = "submit"; createForm.append(upload); createDetails.append(createForm); create.append(createDetails);
    container.append(intro, status, library, selected, create);
    function setDirty(value, form) {
      dirty = value; dirtyForm = value ? form : null; container.setAttribute("data-document-dirty", String(value));
      // One editor at a time: saving a version must never discard a different upload or metadata draft.
      container.querySelectorAll("form").forEach((entry) => {
        if (!value) entry.removeAttribute("data-dirty");
      });
      syncFields();
    }
    function syncFields() { container.querySelectorAll("form").forEach((entry) => entry.querySelectorAll("input,select,button").forEach((field) => { field.disabled = busy || (dirty && entry !== dirtyForm); })); }
    function observe(form) { form.addEventListener("input", () => setDirty(true, form)); form.addEventListener("change", () => setDirty(true, form)); }
    observe(createForm);
    function message(text, error = false) { if (disposed) return; status.textContent = text; status.setAttribute("role", error ? "alert" : "status"); }
    function report(error) { message(error.message || "Document request failed.", true); if (typeof onError === "function") onError(error); }
    function canDiscard() { return !dirty || root.confirm("Discard unsaved document form changes?"); }
    async function request(url, options = {}) {
      const controller = new AbortController(); requests.add(controller);
      const timeout = root.setTimeout(() => controller.abort(), 30000);
      try {
        const response = await root.fetch(url, { ...options, credentials: "same-origin", signal: controller.signal, headers: { Accept: "application/json", ...options.headers } });
        let body; try { body = await response.json(); } catch { throw new Error("The document service returned an unreadable response."); }
        if (!response.ok) {
          const error = new Error(body && (typeof body.error === "string" ? body.error : body.error && body.error.message) || body.message || "The document request was refused.");
          error.status = response.status; throw error;
        }
        return body;
      } catch (error) {
        if (error.name === "AbortError" && !disposed) throw new Error("The document request timed out. Refresh to check whether the last save completed before retrying.");
        throw error;
      } finally { root.clearTimeout(timeout); requests.delete(controller); }
    }
    async function perform(action) {
      if (disposed || busy) return;
      busy = true; container.setAttribute("aria-busy", "true"); syncFields();
      try { await action(); } catch (error) { if (!disposed && error.name !== "AbortError") report(error); }
      finally { busy = false; if (!disposed) { container.removeAttribute("aria-busy"); syncFields(); } }
    }
    async function load() {
      const listing = await request(apiBase + "?archived=" + archiveFilter + "&offset=" + offset + "&limit=50");
      if (disposed) return;
      rows.replaceChildren();
      const count = node("p", listing.total + " document(s) · " + (archiveFilter === "archived" ? "archived files remain downloadable" : "50 per page"), "muted"); rows.append(count);
      if (!listing.documents.length) rows.append(node("p", "No documents in this view.", "muted"));
      else {
        const scroll = node("div"); scroll.style.overflowX = "auto";
        const table = node("table"), head = node("thead"), tr = node("tr");
        ["Document", "Application / link", "Owner", "Status", "Review", "Versions"].forEach((label) => tr.append(node("th", label)));
        head.append(tr); table.append(head); const body = node("tbody");
        for (const doc of listing.documents) {
          const line = node("tr"), title = node("td");
          title.append(button(doc.title, () => {
            if (busy || !canDiscard()) return;
            createForm.reset(); setDirty(false);
            perform(async () => { detail = await request(apiBase + "/" + encodeURIComponent(doc.id)); selectedId = doc.id; renderDetail(); message("Document loaded."); });
          }, "refreshbtn"));
          line.append(title, node("td", [doc.appId, doc.linkKind && doc.linkKind + ": " + doc.linkId].filter(Boolean).join(" · ") || "Shared"), node("td", doc.owner || "—"), node("td", doc.archivedAt ? "archived · " + doc.status : doc.status), node("td", doc.reviewAt || "—"), node("td", doc.versionCount));
          body.append(line);
        }
        table.append(body); scroll.append(table); rows.append(scroll);
      }
      const paging = node("div", null, "administration-actions");
      if (offset > 0) paging.append(button("Previous page", () => { if (busy || !canDiscard()) return; setDirty(false); offset = Math.max(0, offset - 50); perform(load); }, "refreshbtn"));
      if (listing.nextOffset !== null) paging.append(button("Next page", () => { if (busy || !canDiscard()) return; setDirty(false); offset = listing.nextOffset; perform(load); }, "refreshbtn"));
      rows.append(paging);
      if (selectedId && !dirty) { detail = await request(apiBase + "/" + encodeURIComponent(selectedId)); if (!disposed) renderDetail(); }
      message("Document library ready.");
    }
    async function saveResult(result, text) {
      if (disposed) return;
      selectedId = result.document.id; detail = result; setDirty(false); createForm.reset();
      await load(); message(text);
    }
    async function uploadFile(form, current) {
      const file = form.elements.namedItem("file").files[0];
      if (!file || !file.size || file.size > 10 * 1024 * 1024) throw new Error("Choose a non-empty file no larger than 10 MiB.");
      const header = { expectedRevision: current ? current.revision : 0, filename: file.name, mime: file.type || "application/octet-stream" };
      if (current) header.documentId = current.id; else header.metadata = formMetadata(form);
      const result = await request(apiBase + "/upload", { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Document-Metadata": encodeURIComponent(JSON.stringify(header)) }, body: file });
      await saveResult(result, current ? "New immutable version saved." : "Document and its first version saved.");
    }
    createForm.addEventListener("submit", (event) => { event.preventDefault(); if (!busy && createForm.reportValidity()) { setDirty(true, createForm); perform(() => uploadFile(createForm)); } });
    filter.addEventListener("change", () => {
      if (busy || !canDiscard()) { filter.value = archiveFilter; return; }
      archiveFilter = filter.value; offset = 0; selectedId = null; detail = null; selected.replaceChildren(); createForm.reset(); setDirty(false); perform(load);
    });
    function renderDetail() {
      if (disposed || !detail) return;
      const doc = detail.document, section = panel(doc.title);
      selected.replaceChildren(section);
      section.append(node("p", "ID: " + doc.id + " · revision " + doc.revision + (doc.archivedAt ? " · archived " + doc.archivedAt : ""), "muted"));
      if (!doc.archivedAt) {
        const metadataDetails = node("details"); metadataDetails.append(node("summary", "Edit ownership, review status, and links"));
        const editForm = newForm(); metadataFields(editForm, doc); observe(editForm);
        const submit = button("Save metadata"); submit.type = "submit"; editForm.append(submit);
        editForm.addEventListener("submit", (event) => { event.preventDefault(); if (busy || !editForm.reportValidity()) return; setDirty(true, editForm); perform(async () => {
          const result = await request(apiBase + "/" + encodeURIComponent(doc.id), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision: doc.revision, patch: formMetadata(editForm) }) });
          await saveResult(result, "Document metadata updated.");
        }); });
        metadataDetails.append(editForm); section.append(metadataDetails);
        const versionDetails = node("details"); versionDetails.append(node("summary", "Upload a new version"));
        const versionForm = newForm(); inputField(versionForm, "Replacement file (prior versions are retained)", "file", "", { type: "file", required: true, accept: accepted }); observe(versionForm);
        const save = button("Save new version"); save.type = "submit"; versionForm.append(save);
        versionForm.addEventListener("submit", (event) => { event.preventDefault(); if (!busy && versionForm.reportValidity()) { setDirty(true, versionForm); perform(() => uploadFile(versionForm, doc)); } });
        versionDetails.append(versionForm); section.append(versionDetails);
      }
      const change = newForm(); inputField(change, doc.archivedAt ? "Restore note (optional)" : "Archive reason (optional)", "reason", "", { maxLength: 500 }); observe(change);
      const lifecycle = button(doc.archivedAt ? "Restore document" : "Archive document", null, "refreshbtn"); lifecycle.type = "submit"; change.append(lifecycle);
      change.addEventListener("submit", (event) => { event.preventDefault(); if (busy) return; setDirty(true, change); perform(async () => {
        const result = await request(apiBase + "/" + encodeURIComponent(doc.id) + (doc.archivedAt ? "/restore" : "/archive"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision: doc.revision, reason: change.elements.namedItem("reason").value }) });
        await saveResult(result, doc.archivedAt ? "Document restored." : "Document archived. Its files and history are retained.");
      }); }); section.append(change);
      section.append(node("h3", "Immutable versions"));
      const versions = node("div"); versions.style.overflowX = "auto";
      const table = node("table"), head = node("tr"); ["Version / file", "Size", "Uploaded", "SHA-256"].forEach((label) => head.append(node("th", label))); const thead = node("thead"); thead.append(head); table.append(thead);
      const body = node("tbody");
      detail.versions.forEach((v) => {
        const tr = node("tr"), file = node("td"), link = node("a", "v" + v.version + " · " + v.filename);
        link.href = apiBase + "/" + encodeURIComponent(doc.id) + "/versions/" + v.version + "/download";
        link.setAttribute("download", v.filename); file.append(link);
        const hash = node("td", v.sha256); hash.style.overflowWrap = "anywhere"; hash.style.maxWidth = "260px";
        tr.append(file, node("td", displayBytes(v.byteLength)), node("td", v.createdAt + " · " + v.actor), hash); body.append(tr);
      }); table.append(body); versions.append(table); section.append(versions);
      const history = node("details"); history.append(node("summary", "Change history (latest " + detail.history.length + ")"));
      const entries = node("ol"); detail.history.forEach((entry) => {
        const li = node("li", entry.at + " · " + entry.actor + " · " + entry.action + " · revision " + entry.revision);
        const facts = node("pre", JSON.stringify(entry.detail, null, 2), "md-pre"); facts.style.whiteSpace = "pre-wrap"; facts.style.overflowWrap = "anywhere"; li.append(facts); entries.append(li);
      }); history.append(entries); section.append(history); syncFields();
    }
    function beforeUnload(event) { if (dirty) { event.preventDefault(); event.returnValue = ""; } }
    root.addEventListener("beforeunload", beforeUnload);
    perform(load);
    const cleanup = () => { disposed = true; for (const controller of requests) controller.abort(); root.removeEventListener("beforeunload", beforeUnload); container.removeAttribute("data-document-dirty"); };
    cleanup.isDirty = () => dirty;
    cleanup.refresh = () => { if (dirty || busy) return false; perform(load); return true; };
    return cleanup;
  }
  root.SocDocumentLibrary = Object.freeze({ render });
})(typeof window !== "undefined" ? window : globalThis);
