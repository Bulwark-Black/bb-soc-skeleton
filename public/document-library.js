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
    let catalogReady = false, catalog = { apps: [], risks: [], attestations: [] }, lastSavedVersion = null;
    const requests = new Set();
    const status = node("p", "Loading documents…", "muted"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
    const intro = panel("Documents & evidence");
    intro.append(node("p", "Keep versioned documents and case evidence with ownership, review dates, and links to your application, risks, attestations, or policies. Each saved version keeps its original bytes, SHA-256 hash, uploader, and upload time.", "muted"));
    intro.append(node("p", "Files are downloaded as attachments. Uploads are not malware-scanned by this library; apply your own scanning policy before opening them.", "muted"));
    intro.append(node("p", "Guided intake: choose an application, assign an owner and review date, select an existing risk or attestation, then upload and inspect the immutable version receipt. Uploading or linking evidence never changes an obligation's status or proves compliance. Governance records are installation-wide; the application choice scopes this document only.", "muted"));
    function optionsFor(select, entries, preferred, missingLabel) {
      select.replaceChildren();
      for (const entry of entries) { const option = node("option", entry.label); option.value = entry.value; select.append(option); }
      if (preferred && !entries.some(entry => entry.value === preferred)) {
        const option = node("option", missingLabel + " · " + preferred); option.value = preferred; select.append(option);
      }
      select.value = preferred || "";
    }
    function metadataFields(form, value = {}) {
      form.append(node("h3", "1 · Identify and scope the document"));
      inputField(form, "Title", "title", value.title, { required: true, maxLength: 200 });
      const appSearch = inputField(form, "Search registered applications", "applicationSearch", "", { maxLength: 120 });
      const appSelect = inputField(form, "Application", "appId", value.appId, { options: [], help: "Choose a registered application or Shared. An unavailable historical reference is retained unless you explicitly change it." });
      function drawApplications(preferred = appSelect.value) {
        const selected = preferred || "", search = appSearch.value.trim().toLowerCase();
        optionsFor(appSelect, [{ value: "", label: "Shared document — no application" }, ...catalog.apps
          .filter(item => item.appId === selected || (item.displayName + " " + item.appId).toLowerCase().includes(search))
          .map(item => ({ value: item.appId, label: item.displayName + " · " + item.appId }))], selected, "Historical application unavailable; preserved");
      }
      drawApplications(value.appId); appSearch.addEventListener("input", () => drawApplications());
      form.append(node("h3", "2 · Assign responsibility and review"));
      inputField(form, "Owner (optional)", "owner", value.owner, { maxLength: 160, help: "A tracking label, not an account permission or an automatic notification recipient." });
      inputField(form, "Status", "status", value.status || "draft", { options: statuses });
      inputField(form, "Review date (optional)", "reviewAt", value.reviewAt, { type: "date", help: "A tracked calendar date; this library does not schedule reminders." });
      form.append(node("h3", "3 · Attach supporting evidence"));
      const kind = inputField(form, "Linked record type", "linkKind", value.linkKind, { options: [{ value: "", label: "No linked record" }, ...linkKinds] });
      const links = node("div"); form.append(links);
      function drawLinks(preferred) {
        links.replaceChildren();
        if (["risk", "attestation"].includes(kind.value)) {
          const records = kind.value === "risk" ? catalog.risks : catalog.attestations, key = kind.value === "risk" ? "riskId" : "attestationId";
          const search = inputField(links, "Search existing " + kind.value + " records", "recordSearch", "", { maxLength: 120 });
          const select = inputField(links, "Existing " + kind.value, "linkId", preferred, { options: [], help: "Choose an existing local record. Archived records are labeled. This association does not satisfy or update the record." });
          const draw = (wanted = select.value) => {
            const selected = wanted || "", term = search.value.trim().toLowerCase();
            optionsFor(select, [{ value: "", label: "Choose a " + kind.value + "…" }, ...records
              .filter(item => item[key] === selected || (item.title + " " + item[key] + " " + item.status).toLowerCase().includes(term))
              .map(item => ({ value: item[key], label: item.title + " · " + item.status + " · " + item[key] }))], selected, "Historical record unavailable; preserved");
          };
          draw(preferred); search.addEventListener("input", () => draw());
        } else {
          inputField(links, kind.value ? "External " + kind.value + " reference (not verified)" : "No linked record", "linkId", preferred || "", {
            type: kind.value ? "text" : "hidden", maxLength: 128,
            help: kind.value ? "An operator-supplied external reference only. There is no local case or policy registry to verify it, and no upstream record is created or changed." : "This document will not be associated with a governance record." });
        }
      }
      drawLinks(value.linkId); kind.addEventListener("change", () => { drawLinks(""); syncFields(); });
      form.bindingBefore = value;
    }
    function selectedMetadata(form) {
      if (!catalogReady) throw new Error("Refresh the application and governance choices before saving document metadata.");
      const value = formMetadata(form), previous = form.bindingBefore || {};
      const unchanged = Boolean(previous.id) && ["appId", "linkKind", "linkId"].every(key => (value[key] || null) === (previous[key] || null));
      if (!unchanged) {
        if (value.appId && !catalog.apps.some(item => item.appId === value.appId)) throw new Error("Choose a current registered application or Shared. Historical missing references can only be preserved unchanged.");
        if (value.linkKind === "risk" && !catalog.risks.some(item => item.riskId === value.linkId)) throw new Error("Choose an existing risk from the list.");
        if (value.linkKind === "attestation" && !catalog.attestations.some(item => item.attestationId === value.linkId)) throw new Error("Choose an existing attestation from the list.");
      }
      return value;
    }
    const controls = node("div", null, "administration-actions"); controls.style.display = "flex"; controls.style.gap = "8px"; controls.style.flexWrap = "wrap";
    const filter = node("select"); filter.setAttribute("aria-label", "Document archive filter");
    for (const [value, label] of [["active", "Active documents"], ["archived", "Archive"], ["all", "All documents"]]) { const opt = node("option", label); opt.value = value; filter.append(opt); }
    controls.append(filter, button("Refresh", () => { if (dirty) { message("Refresh paused while a form has unsaved changes."); return; } perform(() => load()); }, "refreshbtn"),
      button("Discard draft", () => { if (busy || !canDiscard()) return; setDirty(false); drawCreateForm(); renderDetail(); message("Unsaved draft discarded. No saved file or binding was changed."); }, "refreshbtn"));
    const library = panel("Library"), selected = node("div"), create = panel("Upload a document");
    library.append(controls);
    const rows = node("div"); library.append(rows);
    const createDetails = node("details"), summary = node("summary", "Add a document or evidence file"); createDetails.append(summary);
    const createForm = newForm();
    function drawCreateForm() {
      createForm.replaceChildren(); metadataFields(createForm);
      createForm.append(node("h3", "4 · Upload and verify the saved version"));
      inputField(createForm, "File (maximum 10 MiB)", "file", "", { type: "file", required: true, accept: accepted });
      const upload = button("Upload document"); upload.type = "submit"; createForm.append(upload);
    }
    drawCreateForm(); createDetails.append(createForm); create.append(createDetails);
    container.append(intro, status, library, selected, create);
    function setDirty(value, form) {
      dirty = value; dirtyForm = value ? form : null; container.setAttribute("data-document-dirty", String(value));
      // One editor at a time: saving a version must never discard a different upload or metadata draft.
      container.querySelectorAll("form").forEach((entry) => {
        if (!value) entry.removeAttribute("data-dirty");
      });
      syncFields();
    }
    function syncFields() { container.querySelectorAll("form").forEach((entry) => entry.querySelectorAll("input,select,button").forEach((field) => { field.disabled = busy || (!catalogReady && Boolean(entry.bindingBefore)) || (dirty && entry !== dirtyForm); })); }
    function observe(form) { form.addEventListener("input", () => setDirty(true, form)); form.addEventListener("change", () => setDirty(true, form)); }
    observe(createForm);
    function message(text, error = false) { if (disposed) return; status.textContent = text; status.setAttribute("role", error ? "alert" : "status"); }
    function report(error) { message(error.message || "Document request failed.", true); if (typeof onError === "function") onError(error); }
    function canDiscard() { return !dirty || root.confirm("Discard unsaved document form changes?"); }
    async function request(url, options = {}) {
      if (disposed) throw new Error("Document view is closed.");
      const controller = new AbortController(); requests.add(controller);
      const timeout = root.setTimeout(() => controller.abort(), 30000);
      try {
        const response = await root.fetch(url, { ...options, credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal, headers: { Accept: "application/json", ...options.headers } });
        let body;
        try {
          const reader = response.body.getReader(), chunks = []; let size = 0;
          while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 8 * 1024 * 1024) { await reader.cancel(); throw new Error("Response too large."); } chunks.push(part.value); }
          const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
          body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        } catch { throw new Error("The document service returned an unreadable or oversized response. Refresh saved state before retrying a write."); }
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
      catalogReady = false;
      const [listing, applications, governance] = await Promise.all([
        request(apiBase + "?archived=" + archiveFilter + "&offset=" + offset + "&limit=50"),
        request("/api/v1/control/snapshot?reason=refresh"),
        request("/api/v1/administration/snapshot?domain=governance&reason=refresh")
      ]);
      if (disposed) return;
      if (!Array.isArray(listing.documents) || !Array.isArray(applications.apps) || !Array.isArray(governance.risks) || !Array.isArray(governance.attestations)) throw new Error("Document choices could not be loaded. Refresh to retry; no references were changed.");
      catalog = { apps: applications.apps, risks: governance.risks, attestations: governance.attestations }; catalogReady = true;
      if (!dirty) drawCreateForm();
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
            setDirty(false); drawCreateForm();
            perform(async () => { const loaded = await request(apiBase + "/" + encodeURIComponent(doc.id)); if (disposed) return; detail = loaded; selectedId = doc.id; renderDetail(); message("Document loaded."); });
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
      selectedId = result.document.id; detail = result; setDirty(false); drawCreateForm(); renderDetail();
      await load(); message(text);
    }
    async function uploadFile(form, current) {
      const file = form.elements.namedItem("file").files[0];
      if (!file || !file.size || file.size > 10 * 1024 * 1024) throw new Error("Choose a non-empty file no larger than 10 MiB.");
      const header = { expectedRevision: current ? current.revision : 0, filename: file.name, mime: file.type || "application/octet-stream" };
      if (current) header.documentId = current.id; else header.metadata = selectedMetadata(form);
      const result = await request(apiBase + "/upload", { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Document-Metadata": encodeURIComponent(JSON.stringify(header)) }, body: file });
      if (disposed) return;
      const version = result.versions?.find(item => item.version === result.document?.versionCount);
      if (!version || !/^[a-f0-9]{64}$/.test(version.sha256)) throw new Error("Upload response did not identify its saved version and hash. Discard the draft and refresh saved state before retrying.");
      lastSavedVersion = { documentId: result.document.id, ...version };
      await saveResult(result, current ? "New immutable version saved." : "Document and its first version saved.");
    }
    createForm.addEventListener("submit", (event) => { event.preventDefault(); if (!busy && createForm.reportValidity()) { setDirty(true, createForm); perform(() => uploadFile(createForm)); } });
    filter.addEventListener("change", () => {
      if (busy || !canDiscard()) { filter.value = archiveFilter; return; }
      archiveFilter = filter.value; offset = 0; selectedId = null; detail = null; selected.replaceChildren(); setDirty(false); drawCreateForm(); perform(load);
    });
    function renderDetail() {
      if (disposed || !detail) return;
      const doc = detail.document, section = panel(doc.title);
      selected.replaceChildren(section);
      section.append(node("p", "ID: " + doc.id + " · revision " + doc.revision + (doc.archivedAt ? " · archived " + doc.archivedAt : ""), "muted"));
      if (lastSavedVersion?.documentId === doc.id) {
        const receipt = panel("Saved immutable version receipt");
        receipt.append(node("p", "Document " + doc.id + " · version " + lastSavedVersion.version + " · " + lastSavedVersion.filename),
          node("p", "SHA-256: " + lastSavedVersion.sha256), node("p", "Saved " + lastSavedVersion.createdAt + " · " + displayBytes(lastSavedVersion.byteLength)),
          node("p", "This hash identifies the uploaded bytes. It does not prove the document is safe, authentic, accurate, or sufficient evidence, and does not change the linked risk or attestation.", "muted"));
        section.append(receipt);
      }
      if (!doc.archivedAt) {
        const metadataDetails = node("details"); metadataDetails.append(node("summary", "Edit ownership, review status, and links"));
        const editForm = newForm(); metadataFields(editForm, doc); observe(editForm);
        const submit = button("Save metadata"); submit.type = "submit"; editForm.append(submit);
        editForm.addEventListener("submit", (event) => { event.preventDefault(); if (busy || !editForm.reportValidity()) return; setDirty(true, editForm); perform(async () => {
          const result = await request(apiBase + "/" + encodeURIComponent(doc.id), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision: doc.revision, patch: selectedMetadata(editForm) }) });
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
    function beforeUnload(event) { if (dirty || busy) { event.preventDefault(); event.returnValue = ""; } }
    root.addEventListener("beforeunload", beforeUnload);
    perform(load);
    const cleanup = () => { disposed = true; for (const controller of requests) controller.abort(); root.removeEventListener("beforeunload", beforeUnload); container.removeAttribute("data-document-dirty"); };
    cleanup.isDirty = () => dirty || busy;
    cleanup.refresh = () => { if (dirty || busy) return false; perform(load); return true; };
    return cleanup;
  }
  root.SocDocumentLibrary = Object.freeze({ render });
})(typeof window !== "undefined" ? window : globalThis);
