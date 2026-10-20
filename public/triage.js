(function (root) {
  "use strict";
  const API = "/api/v1/triage", MAX_RESPONSE = 8 * 1024 * 1024;
  const VIEWS = { queue: "Queue", approvals: "Awaiting approval", cases: "Cases / in progress", closed: "Closed", all: "All alerts" };
  const FILTERS = ["view", "sourceId", "rule", "severity", "category", "q", "groupId"];
  const CONTEXT = ["appId", ...FILTERS, "offset", "limit", "expand", "alert", "approval", "tz", "tab", "evidence", "version", "mode", "return", "anchor"];
  const TABS = ["summary", "evidence", "history"];
  const validVersion = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  function safeReturn(value, appId) {
    if (typeof value !== "string" || value.length > 12000 || !value.startsWith("#/triage?")) return null;
    try {
      const url = new URL(value.slice(1), "https://triage.example.invalid");
      if (url.pathname !== "/triage" || url.hash || url.searchParams.get("appId") !== appId || url.searchParams.has("return") || url.searchParams.has("mode")) return null;
      if ([...url.searchParams.keys()].some(key => !CONTEXT.includes(key))) return null;
      return "#/triage?" + url.searchParams.toString();
    } catch { return null; }
  }
  const selections = new Map();
  const list = value => Array.isArray(value) ? value : [];
  const label = value => value === null || value === undefined || value === "" ? "Not reported" : String(value);
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const validKey = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,1600}$/.test(value);
  function filters(query = {}) {
    const q = query.entries ? Object.fromEntries(query.entries()) : query;
    const result = { view: Object.hasOwn(VIEWS, q.view) ? q.view : "queue" };
    FILTERS.slice(1).forEach(key => { if (typeof q[key] === "string" && q[key]) result[key] = q[key]; });
    return result;
  }
  function filterScope(appId, query) { return JSON.stringify([appId, ...FILTERS.map(key => filters(query)[key] || "")]); }
  function contextUrl(query = {}, changes = {}) {
    const result = { ...(query.entries ? Object.fromEntries(query.entries()) : query), ...changes }, search = new URLSearchParams();
    CONTEXT.forEach(key => {
      const value = result[key];
      if (key === "return" && !safeReturn(value, result.appId)) return;
      if (key === "mode" && value !== "investigation") return;
      if (key === "tab" && !TABS.includes(value)) return;
      if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
    });
    return "#/triage" + (search.size ? "?" + search : "");
  }
  function groupRows(alerts, groups) {
    const metadata = new Map(list(groups).map(group => [group.id, group])), byGroup = new Map(), rows = [];
    for (const alert of list(alerts)) {
      if (!alert.group?.id) { rows.push({ id: null, alerts: [alert] }); continue; }
      let group = byGroup.get(alert.group.id);
      if (!group) { group = { ...metadata.get(alert.group.id), id: alert.group.id, label: alert.group.label || metadata.get(alert.group.id)?.label || alert.group.id, alerts: [] }; byGroup.set(group.id, group); rows.push(group); }
      group.alerts.push(alert);
    }
    return rows;
  }
  function selectionSummary(chosen, alerts, visibleKeys) {
    const pageKeys = new Set(list(alerts).map(alert => alert.key)); let visible = 0, hidden = 0, elsewhere = 0;
    for (const key of chosen) { if (!pageKeys.has(key)) elsewhere++; else if (visibleKeys.has(key)) visible++; else hidden++; }
    return { total: chosen.size, visible, hidden, elsewhere };
  }
  function render({ container, appId, applications = [], query = {}, scopeLoaded = false, displayTimezone = "UTC", onError, onContext, onReady, navigate: navigateHost, getPageFilter = () => "", setPageFilter } = {}) {
    if (!container) throw new TypeError("Triage requires a container.");
    const document = container.ownerDocument || root.document;
    const q = { ...(query.entries ? Object.fromEntries(query.entries()) : query) };
    if (appId) q.appId = appId;
    let timezone = q.tz || displayTimezone; try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(); } catch { timezone = "UTC"; }
    q.tz = timezone;
    let disposed = false, busy = false, running = false, pause = false, dirty = false, delegated = null, data = null, operation = null, operationError = "", reviewedKeys = null, pendingPreview = null, operationItems = null, itemError = "", itemsBusy = false, itemsOpen = false;
    let currentDialog = null, selectionText, reviewSelected, reviewMatching, groupSelected, clearSelected;
    let chosen = new Set(), boxes = [], groupBodies = [], trackedLinks = [];
    const controllers = new Map(), expanded = new Set(String(q.expand || "").split(",").filter(Boolean));
    const leaves = new Set(String(q.evidence || "").split(",").filter(Boolean)), formStates = new Set();
    let inspector = null, inspectorHost = null, inspectorStatus = null, queueHost = null, workspace = null, treeSearch = null;
    let viewerId = null, listGeneration = 0, readGeneration = 0, editVersion = 0, inspectionController = null, listController = null, uncertainStep = false, uncertainPreview = false;
    let rowGroups = [], alertRows = [], panes = null, tabLinks = [], readError = "";
    const sectionReads = new Map();
    const isPending = () => busy || running || uncertainStep || uncertainPreview || [...formStates].some(state => state.uncertain || state.saving);
    const refreshDirty = () => { dirty = [...formStates].some(state => state.dirty); };
    const applyQuery = next => { Object.keys(q).forEach(key => delete q[key]); Object.assign(q, next); syncLinks(); };
    const syncLinks = () => trackedLinks.forEach(({ node, changes }) => { node.href = contextUrl(q, typeof changes === "function" ? changes() : changes); });
    const plainClick = event => !event.defaultPrevented && !(event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
    async function canDiscard() {
      if (isPending()) { if (inspectorStatus) inspectorStatus.replaceChildren(notice("A save or approval is pending or unconfirmed. Reconcile its result before leaving.", true)); return false; }
      return !dirty || Boolean(root.confirm?.("Discard unsaved Triage form changes?"));
    }
    function resetForms(host) {
      for (const state of [...formStates]) if (!host || host === state.host) formStates.delete(state);
      refreshDirty();
    }
    const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = String(text); if (className) node.className = className; return node; };
    const append = (parent, ...children) => { children.flat().filter(value => value !== undefined && value !== null).forEach(child => parent.append(child)); return parent; };
    const p = text => el("p", text, "st-muted");
    const btn = (text, action, name) => { const node = el("button", text); node.type = "button"; if (name) node.dataset.action = name; node.addEventListener("click", event => { if (!disposed) action(event); }); return node; };
    const link = (text, changes, focusAfter = false) => {
      const node = el("a", text); node.href = contextUrl(q, typeof changes === "function" ? changes() : changes); trackedLinks.push({ node, changes });
      node.addEventListener("click", async event => { if (!plainClick(event)) return; event.preventDefault(); const accepted = await routeTo(node.href); if (accepted && focusAfter) focusInspector(); });
      return node;
    };
    const notice = (text, error = false) => { const node = p(text); node.className = "st-notice" + (error ? " st-error" : ""); node.setAttribute("role", error ? "alert" : "status"); return node; };
    const when = value => { const ms = typeof value === "number" ? value : Date.parse(value); if (!Number.isFinite(ms)) return el("span", "Not reported", "st-muted"); const node = el("time", new Intl.DateTimeFormat("en", { timeZone: timezone, dateStyle: "medium", timeStyle: "short" }).format(ms)); node.dateTime = new Date(ms).toISOString(); node.title = node.dateTime + " · " + timezone; return node; };
    const badge = (value, kind = "workflow") => el("span", label(value).replace(/-/g, " "), "st-badge st-" + kind + "-" + String(value || "unknown").replace(/[^a-z-]/g, ""));
    const field = (form, text, name, type = "text", value = "", options = []) => {
      const wrapper = el("label", text), input = el(["textarea", "select"].includes(type) ? type : "input");
      input.name = name; if (!["textarea", "select"].includes(type)) input.type = type;
      if (type === "select") options.forEach(item => { const option = el("option", Array.isArray(item) ? item[1] : item); option.value = Array.isArray(item) ? item[0] : item; input.append(option); });
      input.value = value; input.defaultValue = value;
      if (type === "select") Array.from(input.options || input.childNodes || []).forEach(option => { option.defaultSelected = option.value === value; });
      wrapper.append(input); form.append(wrapper); return input;
    };
    const main = el("section", undefined, "st"), header = el("header", undefined, "st-heading"), status = notice("Loading Security Triage…"), content = el("div"), review = el("section", undefined, "st-approval-review");
    const title = el("h1", "Security Triage"); title.id = "page-title";
    append(header, el("small", "BB SOC / Security response"), title, p("Review retained findings, record human decisions, and approve exact proposals. Reported upstream state is evidence, not a local decision."));
    append(main, header, status, review, content); container.replaceChildren(main);
    const onEscape = event => {
      if (event.key !== "Escape" || event.defaultPrevented || currentDialog || !inspector || document.querySelector?.("dialog[open]")) return;
      event.preventDefault(); routeTo(contextUrl(q, { alert: null, version: null, tab: null, mode: null, return: null }));
    };
    document.addEventListener?.("keydown", onEscape);
    const cleanup = () => {
      disposed = true; pause = true; readGeneration++; controllers.forEach((write, controller) => { if (!write) controller.abort(); });
      document.removeEventListener?.("keydown", onEscape);
      if (delegated) delegated(); if (currentDialog) currentDialog.remove();
    };
    cleanup.isDirty = () => dirty || !!delegated?.isDirty();
    cleanup.isPending = () => isPending() || !!delegated?.isPending();
    cleanup.hasSelection = () => chosen.size > 0 || !!delegated?.hasSelection();
    cleanup.cancelReads = () => { readGeneration++; controllers.forEach((write, controller) => { if (!write) controller.abort(); }); delegated?.cancelReads?.(); };
    cleanup.filterChanged = () => {
      if (delegated?.filterChanged) return delegated.filterChanged();
      const value = String(getPageFilter() || ""); if (treeSearch && treeSearch.value !== value) treeSearch.value = value;
      applyPageSearch(value); syncSelection();
    };
    cleanup.navigateLocal = options => delegated?.navigateLocal ? delegated.navigateLocal(options) : localNavigation(options);
    if (!root.SOC_PRIVATE_APPLICATION) { status.textContent = "This preview has no private Triage service. No findings, proposals or decisions are included."; return cleanup; }
    function changeContext(changes) {
      if (disposed) return;
      Object.entries(changes).forEach(([key, value]) => { if (value === null || value === undefined || value === "") delete q[key]; else q[key] = String(value); });
      syncLinks();
      if (onContext) onContext({ ...q });
    }
    async function routeTo(href) {
      if (disposed) return false;
      const hash = String(href).indexOf("#"); if (hash > 0) href = String(href).slice(hash);
      if (navigateHost) return navigateHost(href);
      const next = new URL(href.replace(/^#/, ""), "https://triage.example.invalid");
      const handled = cleanup.navigateLocal({ path: next.pathname, query: next.searchParams, reason: "link", canLeave: canDiscard });
      const accepted = handled === false ? await canDiscard() : await handled;
      if (accepted) { root.location.hash = href; if (handled !== false) changeContext({}); }
      return Boolean(accepted);
    }
    function navigate(changes, reset = false) {
      const switchingApp = changes.appId !== undefined && changes.appId !== q.appId;
      const clear = switchingApp ? { offset: null, expand: null, evidence: null, alert: null, version: null, tab: null, approval: null, mode: null, return: null } : reset ? { offset: null } : {};
      return routeTo(contextUrl(q, { ...clear, ...changes }));
    }
    function idempotency() { return "triage-" + root.crypto.randomUUID(); }
    async function request(path = "", body, params = {}, options = {}) {
      if (disposed) throw new Error("View closed.");
      const controller = new AbortController(); controllers.set(controller, body !== undefined);
      const cancel = () => controller.abort(); if (options.signal?.aborted) controller.abort(); else options.signal?.addEventListener("abort", cancel, { once: true });
      const timer = root.setTimeout(() => controller.abort(), 30000);
      const search = new URLSearchParams(Object.entries({ ...(body === undefined ? { appId: q.appId } : {}), ...params }).filter(([, value]) => value !== undefined && value !== null && value !== "").map(([key, value]) => [key, String(value)]));
      try {
        const response = await root.fetch(path === "__applications" ? "/api/v1/control/snapshot?reason=refresh" : API + path + (search.size ? "?" + search : ""), {
          method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal,
          headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) })
        });
        if (!/^application\/json\b/i.test(response.headers.get("content-type") || "")) throw new Error("Triage returned an unsupported response.");
        const reader = response.body.getReader(), chunks = []; let size = 0;
        while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > (options.maxBytes || MAX_RESPONSE)) { await reader.cancel(); throw new Error("Triage response exceeded its display limit."); } chunks.push(next.value); }
        const bytes = new Uint8Array(size); let offset = 0; chunks.forEach(chunk => { bytes.set(chunk, offset); offset += chunk.byteLength; });
        const result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        if (!response.ok) { const error = new Error(typeof result.message === "string" ? result.message.slice(0, 500) : "Triage request failed. No successful action has been assumed."); error.status = response.status; error.code = result.code; throw error; }
        if (!result || typeof result !== "object" || result.schemaVersion !== "1") throw new Error("Triage returned incomplete evidence.");
        if (body === undefined && path !== "__applications" && viewerId && result.viewerId !== viewerId) throw new Error("The signed-in session changed. Refresh the authenticated view before continuing.");
        return result;
      } catch (error) { if (error.name === "AbortError") throw new Error(body === undefined ? "Read canceled or timed out. The prior view is retained; retry the read explicitly." : "Request timed out. A submitted action may already be saved. Retry the same submission or retrieve its saved status."); throw error; }
      finally { root.clearTimeout(timer); controllers.delete(controller); options.signal?.removeEventListener("abort", cancel); }
    }
    if (!scopeLoaded && !list(applications).length) {
      cleanup.ready = (async () => { try {
        const snapshot = await request("__applications"); if (disposed) return;
        const apps = snapshot.apps || snapshot.snapshot?.apps; if (!Array.isArray(apps)) throw new Error("Application registry is unavailable.");
        delegated = render({ container, query: q, appId: q.appId || (apps.length === 1 ? apps[0].appId : ""), applications: apps, scopeLoaded: true, displayTimezone, onError, onContext, onReady, navigate: navigateHost, getPageFilter, setPageFilter }); await delegated.ready;
      } catch (error) { if (!disposed) status.replaceChildren(notice("Application registry unavailable. " + error.message, true)); } })(); return cleanup;
    }
    const scope = el("form", undefined, "st-controls"), application = field(scope, "Application", "appId", "select", q.appId || "", [["", "Choose an application"], ...applications.map(app => [app.appId, app.displayName || app.appId])]);
    application.addEventListener("change", () => navigate({ appId: application.value, sourceId: null, rule: null, severity: null, category: null, q: null, groupId: null }, true));
    scope.addEventListener("submit", event => event.preventDefault()); main.insertBefore(scope, status);
    if (!q.appId || !applications.some(app => app.appId === q.appId)) { status.textContent = "Choose a registered application. No findings or case workflow data are seeded."; content.append(link("Register an application", {})); content.lastChild.href = "#/onboard"; return cleanup; }
    let scopeKey = filterScope(q.appId, q); if (!selections.has(scopeKey)) selections.set(scopeKey, new Set()); chosen = selections.get(scopeKey);
    function selectionBox(keys, text) {
      const input = el("input"); input.type = "checkbox"; input.dataset.triageSelection = ""; input.dataset.members = JSON.stringify(keys); input.setAttribute("aria-label", text);
      input.addEventListener("change", () => { if (busy || running) return syncSelection(); keys.forEach(key => input.checked ? chosen.add(key) : chosen.delete(key)); syncSelection(); });
      boxes.push({ input, keys }); return input;
    }
    function visibleKeys() {
      const result = new Set();
      alertRows.forEach(({ row, key }) => {
        let ancestor = row, visible = true;
        while (ancestor) { if (ancestor.hidden || ancestor.classList?.contains("page-filter-hidden")) { visible = false; break; } if (ancestor === container) break; ancestor = ancestor.parentElement; }
        if (visible) result.add(key);
      });
      return result;
    }
    function applyPageSearch(value) {
      const term = String(value || "").trim().toLocaleLowerCase();
      groupBodies.forEach(({ body, search }) => { body.classList.toggle("page-filter-hidden", Boolean(term) && !search.includes(term)); });
    }
    function syncSelection() {
      if (disposed || !selectionText) return;
      const visible = visibleKeys(), summary = selectionSummary(chosen, data?.alerts, visible);
      selectionText.textContent = summary.total + " selected alerts · " + summary.visible + " in visible groups · " + summary.hidden + " hidden by page search or folding · " + summary.elsewhere + " on other pages";
      boxes.forEach(({ input, keys }) => { const selected = keys.filter(key => chosen.has(key)).length; input.checked = selected === keys.length && keys.length > 0; input.indeterminate = selected > 0 && selected < keys.length; input.disabled = busy || running; });
      reviewSelected.disabled = busy || running || !chosen.size;
      reviewMatching.disabled = busy || running || Boolean(String(getPageFilter()).trim()) || !data?.filteredCount;
      reviewMatching.title = String(getPageFilter()).trim() ? "Clear the shell page search before reviewing all server-matching proposals." : "Review pending proposals across every page in the server filters.";
      groupSelected.disabled = busy || running || chosen.size < 2; clearSelected.disabled = busy || running || !chosen.size;
      main.querySelectorAll("[data-selection-page]").forEach(node => { node.disabled = busy || running; });
      alertRows.forEach(({ row, key, inspectedLabel }) => { row.classList.toggle("st-selected", chosen.has(key)); row.classList.toggle("st-inspected", inspector?.key === key); if (inspectedLabel) inspectedLabel.hidden = inspector?.key !== key; });
      rowGroups.forEach(({ header, keys }) => header.classList.toggle("st-selected", keys.length > 0 && keys.every(key => chosen.has(key))));
    }
    function selectionToolbar() {
      const bar = el("section", undefined, "st-selection"), actions = el("div", undefined, "st-actions");
      selectionText = el("strong"); selectionText.setAttribute("role", "status");
      const pick = (proposalsOnly) => { if (busy || running) return; const visible = visibleKeys(); list(data.alerts).forEach(alert => { if (visible.has(alert.key) && (!proposalsOnly || alert.proposal?.status === "pending")) chosen.add(alert.key); }); syncSelection(); };
      const page = btn("Select shown matching alerts", () => pick(false), "select-page"), proposals = btn("Select shown proposals", () => pick(true), "select-proposals");
      page.dataset.selectionPage = ""; proposals.dataset.selectionPage = "";
      clearSelected = btn("Clear selection", () => { chosen.clear(); syncSelection(); }, "clear-selection");
      reviewSelected = btn("Review selected proposals", () => preview("selected"), "preview-selected");
      reviewMatching = btn("Review all matching proposals", () => preview("matching"), "preview-matching");
      groupSelected = btn("Group selected alerts", showGroupForm, "group-selected");
      append(actions, page, proposals, clearSelected, reviewSelected, reviewMatching, groupSelected);
      append(bar, selectionText, actions, p("Select alert rows or a case’s shown matching members. Evidence leaves are read-only. All-matching review covers the complete server-filtered scope."));
      return bar;
    }
    function filterForm() {
      const form = el("form", undefined, "st-controls");
      const source = field(form, "Source ID", "sourceId", "text", q.sourceId || ""); source.maxLength = 128;
      const rule = field(form, "Rule ID (exact)", "rule", "text", q.rule || ""); rule.maxLength = 128;
      const severity = field(form, "Severity", "severity", "select", q.severity || "", [["", "All severities"], "critical", "high", "medium", "low", "info", "unknown"]);
      const category = field(form, "Decision category", "category", "select", q.category || "", [["", "All categories"], "unclassified", "benign", "expected-activity", "real-threat"]);
      const search = field(form, "Search retained findings", "q", "search", q.q || ""); search.maxLength = 240;
      const apply = el("button", "Apply filters"); apply.type = "submit"; form.append(apply);
      form.addEventListener("submit", event => { event.preventDefault(); navigate({ sourceId: source.value.trim(), rule: rule.value.trim(), severity: severity.value, category: category.value, q: search.value.trim() }, true); });
      if (q.groupId) form.append(link("Leave group filter", { groupId: null, offset: null }));
      return form;
    }
    function tabs() {
      const nav = el("nav", undefined, "st-tabs"); nav.setAttribute("aria-label", "Triage views");
      Object.entries(VIEWS).forEach(([view, name]) => { const a = link(name + " · " + label(data.counts[view]), { view, offset: null }); if (view === filters(q).view) a.setAttribute("aria-current", "page"); nav.append(a); });
      return nav;
    }
    function workflow(alert) { return alert.proposal?.status === "pending" ? "awaiting-approval" : alert.decision?.state || "open"; }
    function updated(alert) {
      const times = [[alert.updatedSource || "recorded update", alert.updatedAt], ["observation", alert.observedAt], ["human decision", alert.decision?.at], ["proposal", alert.proposal?.decidedAt || alert.proposal?.withdrawnAt || alert.proposal?.createdAt]];
      const sorted = times.filter(([, value]) => value && Number.isFinite(Date.parse(value))).sort((a,b) => Date.parse(b[1]) - Date.parse(a[1]));
      const value = sorted[0] || ["unavailable", null], node = when(value[1]); node.title = (node.title || "") + " · timestamp source: " + value[0]; return node;
    }
    function inspectionChanges(alert, tab = "summary") { return { alert: alert.key, version: alert.evidenceVersion, tab, anchor: "triage-inspector-title" }; }
    function investigationChanges(alert) {
      return { ...inspectionChanges(alert, q.tab || "summary"), mode: "investigation",
        return: safeReturn(q.return, q.appId) || contextUrl(q, { mode: null, return: null, anchor: null }) };
    }
    function disclosure(text, changes, name) {
      const node = link(text, changes); node.dataset.action = name; node.className = "st-disclosure";
      return node;
    }
    function renderAlert(alert, index, group) {
      const row = el("tr", undefined, "st-alert-row st-member"); row.dataset.alertKey = alert.key;
      const cell = (...children) => append(el("td"), ...children), titleCell = cell(), heading = el("div", undefined, "st-alert-title");
      const titleLink = link(label(alert.title), () => inspectionChanges(alert), true); titleLink.dataset.action = "review-alert"; titleLink.dataset.alertKey = alert.key; titleLink.title = label(alert.title);
      const investigation = link("Open investigation", () => investigationChanges(alert)); investigation.className = "st-investigation-link"; investigation.dataset.action = "open-investigation"; investigation.setAttribute("aria-label", "Open investigation for " + label(alert.title));
      const toggle = disclosure(leaves.has(alert.key) ? "Hide evidence" : "Show evidence", () => ({ evidence: [...(leaves.has(alert.key) ? new Set([...leaves].filter(key => key !== alert.key)) : new Set([...leaves, alert.key]))].join(",") }), "toggle-evidence");
      toggle.setAttribute("aria-expanded", String(leaves.has(alert.key)));
      append(heading, titleLink, investigation); append(titleCell, heading, el("small", "Alert " + (index + 1) + " · " + alert.sourceId + " / " + alert.recordId), toggle);
      const reviewCell = cell(badge(workflow(alert)));
      if (alert.proposal?.status === "pending") append(reviewCell, p("Current: " + label(alert.decision?.state || "open")), p("Proposed: " + label(alert.proposal.state)));
      append(row, cell(selectionBox([alert.key], "Select alert " + alert.recordId)), titleCell, cell(badge(alert.severity, "severity")), reviewCell, cell(updated(alert)));
      const inspectedLabel = el("span","Currently inspected","sr-only"); inspectedLabel.hidden = true; titleCell.append(inspectedLabel);
      alertRows.push({ row, key: alert.key, inspectedLabel });
      const evidence = el("tr", undefined, "st-evidence-row"); evidence.dataset.evidenceKey = alert.key;
      const leaf = el("td"); leaf.colSpan = 4;
      const evidenceLink = link("Finding evidence · " + label(alert.title), () => inspectionChanges(alert, "evidence"), true); evidenceLink.dataset.action = "inspect-evidence"; evidenceLink.className = "st-evidence-title";
      const full = el("details", undefined, "st-full-summary"); append(full, el("summary", "Read full finding summary"), p(label(alert.summary)));
      append(leaf, evidenceLink, el("small", "One retained canonical record · " + alert.recordId), full);
      append(evidence, el("td"), leaf);
      return { row, evidence, key: alert.key, toggle };
    }
    function updateDisclosure() {
      rowGroups.forEach(group => {
        const open = expanded.has(group.expansionKey) || (!group.id && !expanded.has("closed:" + group.expansionKey));
        group.toggle.textContent = open ? "Hide alerts" : "Show " + group.keys.length + " alerts";
        group.toggle.setAttribute("aria-expanded", String(open));
        group.members.forEach(member => {
          member.row.hidden = !open; member.evidence.hidden = !open || !leaves.has(member.key);
          member.toggle.textContent = leaves.has(member.key) ? "Hide evidence" : "Show evidence";
          member.toggle.setAttribute("aria-expanded", String(leaves.has(member.key)));
        });
      });
      syncLinks(); syncSelection();
    }
    function boardTable() {
      rowGroups = []; alertRows = [];
      const wrap = el("div", undefined, "st-table-wrap"), table = el("table", undefined, "st-table"), head = el("tr"), columns = el("colgroup");
      ["select", "title", "severity", "review", "updated"].forEach(name => columns.append(el("col", undefined, "st-col-" + name)));
      ["Select", "Case / alert", "Severity", "Review", "Updated"].forEach(title => { const th = el("th", title); th.scope = "col"; head.append(th); });
      append(table, el("caption", "Cases, alerts and their single retained evidence record. Only alert rows are decision targets.", "sr-only"), columns, append(el("thead"), head));
      groupRows(data.alerts, data.groups).forEach(group => {
        const body = el("tbody", undefined, group.id ? "st-group" : "st-individual"); body.dataset.filterable = ""; body.dataset.groupId = group.id || "";
        const keys = group.alerts.map(alert => alert.key), expansionKey = group.id || "single:" + keys[0];
        const search = group.alerts.map(alert => [alert.recordId, alert.title, alert.summary, alert.rule, alert.asset, alert.sourceId, alert.severity, workflow(alert), alert.decision?.state, alert.decision?.owner, alert.decision?.category].filter(Boolean).join(" ")).join(" ").toLocaleLowerCase();
        groupBodies.push({ body, keys, search });
        const header = el("tr", undefined, "st-group-header"), titleCell = el("td"), top = el("div", undefined, "st-group-top");
        const toggle = disclosure("", () => {
          const next = new Set(expanded), open = expanded.has(expansionKey) || (!group.id && !expanded.has("closed:" + expansionKey));
          if (group.id) { if (open) next.delete(expansionKey); else next.add(expansionKey); }
          else { if (open) next.add("closed:" + expansionKey); else next.delete("closed:" + expansionKey); }
          return { expand: [...next].join(",") };
        }, "toggle-group");
        append(top, toggle, el("strong", group.id ? group.label : "Ungrouped alert"));
        const total = group.id ? keys.length + " shown / " + label(group.matchedCount) + " matching / " + label(group.totalMembers) + " stored members" : "1 shown canonical alert · no stored case group";
        append(titleCell, top, el("small", total));
        if (group.id) {
          titleCell.append(link("Browse matching group members", { groupId: group.id, offset: null, expand: group.id }));
          const distinct = new Set(group.alerts.map(alert => alert.title));
          titleCell.append(el("small", (distinct.size > 1 ? "Latest alert: " : "Recorded title: ") + label(group.alerts[0].title)));
        }
        const hiddenSearch = el("span", search, "sr-only"); hiddenSearch.dataset.groupSearch = ""; titleCell.append(hiddenSearch);
        const workflowCell = el("td"), states = new Map();
        group.alerts.forEach(alert => states.set(workflow(alert), (states.get(workflow(alert)) || 0) + 1));
        states.forEach((amount, name) => append(workflowCell, badge(name), el("small", amount + " shown")));
        const severity = group.hasCritical ? "critical" : group.alerts[0].severity;
        append(header, append(el("td"), selectionBox(keys, "Select " + keys.length + " shown matching alerts in " + (group.label || "this ungrouped wrapper"))),
          titleCell, append(el("td"), badge(severity, "severity"), group.hasCritical ? el("small", "Bulk excluded") : null), workflowCell, append(el("td"), updated(group.alerts[0])));
        body.append(header);
        const members = group.alerts.map((alert,index) => renderAlert(alert,index,group));
        members.forEach(member => body.append(member.row, member.evidence));
        rowGroups.push({ id: group.id, expansionKey, keys, header, members, toggle }); table.append(body);
      });
      if (!data.alerts.length) { const td = el("td", "No retained alerts match these filters. No healthy or resolved status is inferred."); td.colSpan = 5; table.append(append(el("tbody"), append(el("tr"), td))); }
      wrap.tabIndex = 0; wrap.setAttribute("role", "region"); wrap.setAttribute("aria-label", "Triage case tree; scroll this table horizontally");
      wrap.append(table); return wrap;
    }
    function pager() {
      const nav = el("nav", undefined, "st-pages"); nav.setAttribute("aria-label", "Alert pages");
      const offset = data.page.offset, limit = data.page.limit;
      if (offset > 0) append(nav, link("First page", { offset: null }), link("Previous alerts", { offset: Math.max(0, offset - limit) }));
      nav.append(el("span", data.alerts.length ? "Alerts " + (offset + 1) + "–" + (offset + data.alerts.length) + " of " + data.filteredCount : "0 shown alerts"));
      if (data.page.hasMore) nav.append(link("Next alerts", { offset: data.page.nextOffset }));
      return nav;
    }
    function validList(result) {
      if (!Array.isArray(result.alerts) || !Array.isArray(result.groups) || !result.page || !result.counts || count(result.filteredCount) === null || count(result.groupCount) === null || result.alerts.some(alert => !validKey(alert.key)) || Object.keys(VIEWS).some(key => count(result.counts[key]) === null)) throw new Error("Triage returned incomplete counts or alert identities. No empty state is assumed.");
      return result;
    }
    function ensureWorkspace() {
      if (workspace) return;
      workspace = el("div", undefined, "st-workspace"); queueHost = el("section", undefined, "st-queue"); queueHost.id = "triage-queue";
      inspectorHost = el("aside", undefined, "st-inspector"); inspectorHost.setAttribute("aria-label", "Selected alert inspector");
      inspectorStatus = el("div", undefined, "st-inspector-status"); inspectorStatus.setAttribute("aria-live", "polite");
      append(workspace, queueHost, inspectorHost);
      emptyInspector();
    }
    function emptyInspector() {
      const heading = el("h2", "Select an alert"); heading.id = "triage-inspector-title"; heading.tabIndex = -1;
      inspectorHost.replaceChildren(heading, p("Inspect an alert or its evidence independently of checkbox selection."), inspectorStatus);
      panes = null; tabLinks = [];
    }
    function drawBoard() {
      ensureWorkspace(); boxes = []; groupBodies = [];
      // Keep inspector nodes and drafts mounted while list projections change.
      const inspectorLinks = trackedLinks.filter(item => inspectorHost.contains?.(item.node));
      trackedLinks = inspectorLinks;
      const searchBox = el("label", "Filter loaded case groups"); treeSearch = el("input"); treeSearch.type = "search"; treeSearch.value = String(getPageFilter() || ""); treeSearch.setAttribute("aria-label", "Filter loaded case groups");
      treeSearch.addEventListener("input", () => {
        const global = document.querySelector?.("#q"); if (setPageFilter) setPageFilter(treeSearch.value);
        else if (global) { global.value = treeSearch.value; global.dispatchEvent(new root.Event("input", { bubbles: true })); }
        applyPageSearch(treeSearch.value); syncSelection();
      }); searchBox.append(treeSearch); searchBox.className = "st-tree-search";
      queueHost.replaceChildren(searchBox, p(data.filteredCount + " matching alerts · " + data.groupCount + " display groups · " + data.alerts.length + " alerts on this page"), pager(), boardTable(), pager());
      content.replaceChildren(tabs(), filterForm(), selectionToolbar(), workspace);
      status.replaceChildren(el("span", "Application: " + q.appId + " · as of "), when(data.asOf), el("span", " · " + timezone));
      updateDisclosure(); applyPageSearch(getPageFilter()); updateInspectorContext();
      if (onReady) onReady(); syncSelection();
    }
    async function fetchBoard(query, signal) {
      const result = validList(await request("", undefined, { ...filters(query), limit: query.limit || 50, offset: query.offset || 0 }, { signal }));
      if (result.appId !== q.appId || result.alerts.some(alert => !validVersion(alert.evidenceVersion))) throw new Error("Triage returned a different application or incomplete evidence versions.");
      if (!validVersion(result.viewerId)) throw new Error("Triage session identity is unavailable.");
      if (viewerId && result.viewerId !== viewerId) throw new Error("The signed-in session changed. Refresh the authenticated view before continuing.");
      return result;
    }
    async function load() {
      const generation = ++listGeneration, captured = {...q}, controller = new AbortController();
      listController?.abort(); listController = controller;
      try {
        const next = await fetchBoard(captured,controller.signal);
        if (disposed || generation !== listGeneration || controller.signal.aborted) return;
        viewerId = next.viewerId; data = next; drawBoard();
      } catch (error) { if (!disposed && generation === listGeneration && !controller.signal.aborted) { status.replaceChildren(notice("Triage unavailable. " + error.message, true), btn("Retry read", load)); if (onError) onError(error); } }
    }
    function openDialog(title) {
      if (currentDialog) return null;
      const dialog = el("dialog", undefined, "st-dialog"), heading = el("h2", title);
      const close = async () => { if (!(await canDiscard())) return; resetForms(dialog); dialog.close?.(); dialog.remove(); currentDialog = null; };
      heading.id = "triage-dialog-title"; dialog.setAttribute("aria-labelledby", heading.id);
      append(dialog, append(el("header", undefined, "st-dialog-head"), heading, btn("Close", close))); main.append(dialog); currentDialog = dialog;
      dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
      if (dialog.showModal) dialog.showModal(); else dialog.setAttribute("open", "");
      return dialog;
    }
    function formValues(form) {
      return [...form.querySelectorAll("input,select,textarea")].map(input => [input.name, input.type === "checkbox" ? input.checked : input.value]);
    }
    function restoreForm(state) {
      const values = new Map(state.baseline);
      state.form.querySelectorAll("input,select,textarea").forEach(input => {
        if (values.has(input.name)) { if (input.type === "checkbox") input.checked = values.get(input.name); else input.value = values.get(input.name); }
      });
      state.dirty = false;
    }
    function discardOtherForms(current) {
      const others = [...formStates].filter(state => state !== current && state.dirty);
      if (others.some(state => state.uncertain || state.saving)) return false;
      if (others.length && !root.confirm?.("Discard edits in the other Triage form before submitting this action?")) return false;
      others.forEach(restoreForm); refreshDirty(); return true;
    }
    function mutationForm(host, title, path, initial, build, getValues, submitLabel) {
      const details = el("details", undefined, "st-editor"), form = el("form"), fields = el("fieldset"), result = el("div"), submit = el("button", submitLabel), inputs = build(fields);
      submit.type = "submit"; append(form, fields, submit, result); append(details, el("summary", title), form); host.append(details);
      const state = { host, form, fields, baseline: formValues(form), dirty: false, uncertain: false, saving: false, frozen: null };
      formStates.add(state);
      form.addEventListener("input", () => { state.dirty = JSON.stringify(formValues(form)) !== JSON.stringify(state.baseline); editVersion++; refreshDirty(); });
      form.addEventListener("change", () => { state.dirty = JSON.stringify(formValues(form)) !== JSON.stringify(state.baseline); editVersion++; refreshDirty(); });
      form.addEventListener("submit", async event => {
        event.preventDefault(); event.stopImmediatePropagation?.();
        if (busy || running || disposed || uncertainStep || uncertainPreview || [...formStates].some(other => other !== state && (other.uncertain || other.saving))) return;
        if (!discardOtherForms(state)) return;
        if (!state.frozen) state.frozen = { appId: q.appId, idempotencyKey: idempotency(), ...initial, ...getValues(inputs) };
        busy = true; state.saving = true; fields.disabled = true; submit.disabled = true; readGeneration++; inspectionController?.abort();
        syncSelection(); result.replaceChildren(notice("Saving…"));
        try {
          const saved = await request(path, state.frozen);
          if (disposed) return;
          state.uncertain = false; state.dirty = false; state.baseline = formValues(form); state.frozen = null; refreshDirty();
          result.replaceChildren(notice("Saved. Refreshing exact evidence…"));
          busy = false; state.saving = false;
          if (host === currentDialog) { resetForms(host); host.close?.(); host.remove(); currentDialog = null; await load(); }
          else {
            // The write is confirmed even if this read fails. Do not silently
            // reuse stale revisions or discard another form's later edits.
            const ok = await openAlert(initial.key, inspector?.evidenceVersion, { force: true, guarded: true });
            if (!ok && !disposed) result.replaceChildren(notice("Saved, but current evidence could not be refreshed. These old revisions are disabled.", true),
              btn("Refresh confirmed result", () => openAlert(initial.key, inspector?.evidenceVersion, { force: true }), "reconcile-save"));
          }
          if (!disposed) { await load(); status.append(notice("Action saved. No notification or external execution was started.")); }
        } catch (error) {
          if (!disposed) {
            state.dirty = true;
            if (error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
              state.frozen = null; state.uncertain = false; fields.disabled = false; submit.textContent = submitLabel;
              result.replaceChildren(notice(error.message + " The submission was rejected. Correct fields, or explicitly reload after a revision conflict.", true));
              result.append(btn("Reload current evidence", async () => {
                if (!(await canDiscard())) return;
                if (initial.key) await openAlert(initial.key, inspector?.evidenceVersion, { force: true, guarded: true });
                else { resetForms(host); host.close?.(); host.remove(); currentDialog = null; await load(); }
              }));
            } else {
              state.uncertain = true; submit.textContent = "Retry same submission";
              result.replaceChildren(notice(error.message + " Save outcome is unconfirmed. Only an explicit retry of this identical submission can reconcile it; other forms and navigation remain blocked.", true));
            }
            refreshDirty();
          }
        } finally { state.saving = false; busy = false; submit.disabled = false; syncSelection(); }
      });
      return details;
    }
    function decisionFields(fields, alert, proposal) {
      const existing = proposal ? alert.proposal || {} : alert.decision || {};
      const state = field(fields, "Local " + (proposal ? "proposed" : "decision") + " state", "state", "select", existing.state || (proposal ? "investigating" : "open"), proposal ? ["investigating", "resolved", "closed"] : ["open", "investigating", "resolved", "closed"]);
      const category = field(fields, "Category", "category", "select", existing.category || "unclassified", ["unclassified", "benign", "expected-activity", "real-threat"]);
      const owner = proposal ? field(fields, "Proposal author label (operator supplied)", "authorLabel", "text", "Operator proposal") : field(fields, "Owner", "owner", "text", existing.owner || ""); owner.maxLength = 120;
      const note = field(fields, "Reason / evidence", "note", "textarea", ""); note.maxLength = 2000; if (!proposal && alert.severity === "critical") note.required = true;
      return { state, category, owner, note };
    }
    function checkIdentity(value, key, version, withViewer = false) {
      if (!value || value.schemaVersion !== "1" || value.appId !== q.appId || value.key !== key || value.evidenceVersion !== version ||
        withViewer && value.viewerId !== viewerId) throw new Error("Exact alert, evidence version, or signed-in session changed. No replacement was made.");
      return value;
    }
    function closed(value, allowed) { return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key)); }
    function checkEvidence(value, key, version) {
      checkIdentity(value,key,version);
      if (!closed(value, ["schemaVersion","appId","key","evidenceVersion","viewerId","scope","provenance","record","complete","clipped","omittedPaths","originalBytes","returnedBytes","maxRecordBytes","fullRecordAvailable"]) ||
        value.scope !== "exact-retained-admission" || !closed(value.provenance,["sourceId","recordId","admissionId","receivedAt","bodyHash"]) ||
        typeof value.record !== "object" || !value.record || typeof value.complete !== "boolean" || typeof value.clipped !== "boolean" ||
        !Array.isArray(value.omittedPaths) || value.omittedPaths.some(path => typeof path !== "string") ||
        [value.originalBytes,value.returnedBytes,value.maxRecordBytes].some(n => count(n) === null) || value.maxRecordBytes > 48000)
        throw new Error("Evidence response is incomplete or unsupported. No complete raw record is assumed.");
      return value;
    }
    function checkHistory(value, key, version) {
      checkIdentity(value,key,version);
      const keys = ["id","sequence","type","at","actor","authorLabel","revision","state","category","owner","note","reason","operationId","outcome"];
      if (!closed(value,["schemaVersion","appId","key","evidenceVersion","viewerId","scope","complete","notices","retention","events","page","maxBytes"]) ||
        value.scope !== "exact-admission-local-workflow" || typeof value.complete !== "boolean" || !Array.isArray(value.notices) ||
        !Array.isArray(value.events) || value.events.length > 100 || value.events.some(event => !closed(event,keys) || typeof event.id !== "string" || count(event.sequence) === null || typeof event.type !== "string" || typeof event.note !== "string" || typeof event.reason !== "string") ||
        !closed(value.page,["limit","total","highWater","hasOlder","hasNewer","olderCursor","newerCursor"]) ||
        !value.page || count(value.page.total) === null || count(value.page.highWater) === null || value.page.limit < 1 || value.page.limit > 100 ||
        typeof value.page.hasOlder !== "boolean" || typeof value.page.hasNewer !== "boolean" ||
        [value.page.olderCursor,value.page.newerCursor].some(cursor => cursor !== null && (typeof cursor !== "string" || cursor.length > 12000)))
        throw new Error("Recorded history is unavailable or incomplete. No empty history is assumed.");
      return value;
    }
    function checkInspection(value,key,version) {
      checkIdentity(value,key,version,true);
      if (!closed(value,["schemaVersion","appId","key","evidenceVersion","viewerId","alert","evidence","history","caseContext"]) ||
        value.alert?.key !== key || value.alert?.evidenceVersion !== version) throw new Error("Inspection returned a different alert admission.");
      checkEvidence(value.evidence,key,version); checkHistory(value.history,key,version);
      const group = value.caseContext;
      if (group !== null && (!closed(group,["id","label","totalMembers","availableMembers","unavailableMembers","members","limit","hasMore","attachments","independentNotes"]) ||
        !Array.isArray(group.members) || group.members.length > 30 || group.members.some(member => !closed(member,["key","evidenceVersion","title","sourceId","recordId"]) || !validKey(member.key) || !validVersion(member.evidenceVersion)) ||
        [group.totalMembers,group.availableMembers,group.unavailableMembers].some(n => count(n) === null))) throw new Error("Case membership evidence is incomplete.");
      return value;
    }
    function contextNotice() {
      if (!inspector) return "";
      return data?.alerts.some(alert => alert.key === inspector.key && alert.evidenceVersion === inspector.evidenceVersion) ? "" :
        "This exact retained alert is outside the current filters or page. The queue filters are unchanged.";
    }
    function updateInspectorContext() {
      if (!workspace) return;
      const full = q.mode === "investigation";
      workspace.classList.toggle("st-full-investigation", full); main.classList.toggle("st-investigation-mode", full); queueHost.hidden = full;
      title.textContent = full ? "Alert investigation" : "Security Triage";
      if (inspector) {
        const target = TABS.includes(q.tab) ? q.tab : "summary";
        tabLinks.forEach(({name,node}) => { node.setAttribute("aria-selected",String(name === target)); node.tabIndex = name === target ? 0 : -1; });
        Object.entries(panes || {}).forEach(([name,node]) => { node.hidden = name !== target; });
        const context = inspectorHost.querySelector?.("[data-inspector-context]");
        if (context) { context.textContent = contextNotice(); context.hidden = !context.textContent; }
      }
      const back = inspectorHost.querySelector?.("[data-action=return-to-queue]");
      if (back) back.href = safeReturn(q.return,q.appId) || contextUrl(q,{mode:null,return:null,anchor:"triage-queue"});
      syncSelection(); syncLinks();
    }
    function focusInspector() {
      const heading = inspectorHost?.querySelector?.("[id=triage-inspector-title]");
      if (!heading) return;
      heading.scrollIntoView?.({ block: "nearest", inline: "nearest" }); heading.focus?.({ preventScroll: true });
    }
    function renderEvidence(pane, value) {
      pane.replaceChildren(el("h3","Exact retained canonical evidence"));
      append(pane, p("Reported upstream fields are evidence. They do not replace local decisions, proposals or approval history."),
        p("Source: " + value.provenance.sourceId + " · record: " + value.provenance.recordId),
        p("Admission: " + value.provenance.admissionId + " · received: " + value.provenance.receivedAt),
        p("Body SHA-256: " + value.provenance.bodyHash), p("Evidence version: " + value.evidenceVersion));
      if (value.clipped || !value.complete) pane.append(notice("This evidence display is clipped or incomplete. Omitted fields: " + value.omittedPaths.join(", ") + ". No complete raw record is claimed.",true));
      else pane.append(p("Complete allowlisted canonical record. This is the stored normalized record, not the original vendor archive."));
      const pre = el("pre",JSON.stringify(value.record,null,2),"st-evidence-json"); pre.tabIndex = 0; pre.setAttribute("aria-label","Stored canonical evidence JSON");
      const raw = el("a","Open bounded canonical evidence JSON"); raw.href = API + "/alert/evidence?" + new URLSearchParams({appId:q.appId,key:inspector.key,expectedVersion:inspector.evidenceVersion}); raw.target = "_blank"; raw.rel = "noopener";
      append(pane,pre,p(value.returnedBytes + " displayed bytes of " + value.originalBytes + " original canonical bytes."),raw,
        btn("Refresh evidence read",() => refreshSection("evidence"),"refresh-evidence"));
    }
    function renderHistory(pane,value) {
      pane.replaceChildren(el("h3","Recorded local workflow history"),
        p("Scope: this exact alert admission only. Recorded actor and an operator-supplied proposal author label are distinct."));
      if (!value.complete || value.notices.length) pane.append(notice("History is incomplete: " + (value.notices.join(", ") || "a recorded scope limit applies") + ". Missing events are not an empty history.",true));
      append(pane,p("Canonical evidence: " + label(value.retention?.canonicalEvidence) + " · local history: " + label(value.retention?.localHistory) +
        " · prior incarnations: " + label(value.retention?.priorIncarnations)),p("Snapshot high-water sequence " + value.page.highWater + " · " + value.page.total + " recorded events."));
      if (!value.events.length) pane.append(p("No recorded local workflow events in this scoped history snapshot."));
      const events = el("ol",undefined,"st-history");
      value.events.forEach(event => {
        const item = el("li"); item.dataset.historyId = event.id;
        append(item,el("strong",event.type.replace(/-/g," ")),when(event.at),p("Recorded actor: " + label(event.actor)));
        if (event.authorLabel) item.append(p("Supplied author label: " + event.authorLabel + " (not independent identity proof)"));
        if (event.state || event.category) item.append(p("Recorded outcome: " + label(event.state) + " / " + label(event.category)));
        if (event.outcome) item.append(p(event.type === "approval-skipped" ? "Approval skipped: " + event.outcome + ". No disposition was committed by this item." : "Operation outcome: " + event.outcome));
        if (event.owner) item.append(p("Owner: " + event.owner));
        if (event.note) item.append(p(event.note));
        if (event.reason) item.append(p("Reason: " + event.reason));
        if (event.operationId) item.append(p("Approval operation: " + event.operationId));
        events.append(item);
      }); pane.append(events);
      const pages = el("nav",undefined,"st-pages"); pages.setAttribute("aria-label","Recorded history pages");
      if (value.page.hasNewer && value.page.newerCursor) pages.append(btn("Newer recorded events",() => refreshSection("history",value.page.newerCursor),"history-newer"));
      if (value.page.hasOlder && value.page.olderCursor) pages.append(btn("Older recorded events",() => refreshSection("history",value.page.olderCursor),"history-older"));
      pages.append(btn("Start a fresh history snapshot",() => refreshSection("history"),"history-refresh")); pane.append(pages);
    }
    async function refreshSection(section,cursor) {
      if (!inspector || disposed) return;
      const selected = inspector, panel = panes?.[section];
      sectionReads.get(section)?.abort(); const controller = new AbortController(); sectionReads.set(section,controller);
      inspectorStatus.replaceChildren(notice("Reading exact " + section + "…"));
      try {
        const value = await request("/alert/" + section,undefined,{key:selected.key,expectedVersion:selected.evidenceVersion,...(section === "history" ? {limit:30,...(cursor ? {cursor} : {})} : {})},{signal:controller.signal,maxBytes:640 * 1024});
        if (disposed || inspector !== selected || sectionReads.get(section) !== controller || controller.signal.aborted) return;
        checkIdentity(value,selected.key,selected.evidenceVersion,true);
        if (section === "evidence") { selected.evidence = checkEvidence(value,selected.key,selected.evidenceVersion); renderEvidence(panel,value); }
        else { selected.history = checkHistory(value,selected.key,selected.evidenceVersion); renderHistory(panel,value); }
        inspectorStatus.replaceChildren(notice("Exact " + section + " read updated. No workflow state changed."));
      } catch(error) { if (!disposed && inspector === selected && sectionReads.get(section) === controller && !controller.signal.aborted) inspectorStatus.replaceChildren(notice(error.message + " The previous pane remains visible.",true)); }
    }
    function renderInspector(value) {
      sectionReads.forEach(controller => controller.abort()); sectionReads.clear();
      trackedLinks = trackedLinks.filter(item => !inspectorHost.contains?.(item.node));
      resetForms(panes?.summary); inspector = value;
      const alert = value.alert, header = el("header",undefined,"st-inspector-header"), heading = el("h2",label(alert.title)); heading.id = "triage-inspector-title"; heading.tabIndex = -1;
      const close = link("Close inspector",{alert:null,version:null,tab:null,mode:null,return:null,anchor:"triage-queue"}); close.dataset.action = "close-inspector"; close.setAttribute("aria-label","Close selected alert inspector");
      append(header,heading,close);
      const context = notice(contextNotice()); context.dataset.inspectorContext = ""; context.hidden = !context.textContent;
      const nav = el("nav",undefined,"st-inspector-tabs"); nav.setAttribute("role","tablist"); nav.setAttribute("aria-label","Selected alert details");
      panes = {}; tabLinks = [];
      TABS.forEach((name,index) => {
        const node = link(name[0].toUpperCase()+name.slice(1),{tab:name}); node.id = "triage-tab-" + name; node.setAttribute("role","tab"); node.setAttribute("aria-controls","triage-pane-" + name);
        node.addEventListener("keydown",event => {
          let target = null;
          if (event.key === "ArrowRight") target = (index+1)%3;
          if (event.key === "ArrowLeft") target = (index+2)%3;
          if (event.key === "Home") target = 0;
          if (event.key === "End") target = 2;
          if (event.key === " " || event.key === "Enter") target = index;
          if (target !== null) { event.preventDefault(); const item = tabLinks[target]; item.node.focus?.({preventScroll:true}); routeTo(contextUrl(q,{tab:item.name})); }
        });
        tabLinks.push({name,node}); nav.append(node);
        const pane = el("section",undefined,"st-pane"); pane.id = "triage-pane-" + name; pane.setAttribute("role","tabpanel"); pane.setAttribute("aria-labelledby",node.id); panes[name] = pane;
      });
      const summary = panes.summary, back = el("a","Return to queue"); back.href = safeReturn(q.return,q.appId) || contextUrl(q,{mode:null,return:null,anchor:"triage-queue"});
      back.dataset.action = "return-to-queue"; back.addEventListener("click",event => { if (plainClick(event)) {event.preventDefault();routeTo(back.href);} });
      append(summary,append(el("div",undefined,"st-actions"),badge(alert.severity,"severity"),badge(workflow(alert))),
        p("Source: " + alert.sourceId + " · record: " + alert.recordId),p(label(alert.summary)),p("Observed: "),when(alert.observedAt),
        p("Rule: " + label(alert.rule) + " · asset: " + label(alert.asset)),p("Reported upstream state: " + label(alert.reportedState) + ". Local workflow is independent."),
        el("h3","Local decision"),p(label(alert.decision?.state || "open") + " / " + label(alert.decision?.category || "unclassified")),
        p("Owner: " + label(alert.decision?.owner)),p(alert.decision?.note || "No local decision note recorded."));
      if (alert.proposal?.status === "pending") {
        const proposal = el("section",undefined,"st-proposal-card");
        append(proposal,el("h3","Pending proposal"),p(alert.proposal.state + " / " + alert.proposal.category),p(alert.proposal.note || "No proposal note"),
          p("Supplied author label: " + label(alert.proposal.authorLabel) + " · recorded provenance, not independent agent identity proof."),when(alert.proposal.updatedAt || alert.proposal.createdAt),
          p("Reviewing this exact alert uses its application-wide key, including when it is outside the current queue filters."),
          btn("Review this proposal for approval",async () => { if (isPending()) return; await preview("selected",[alert.key]); },"review-proposal"));
        summary.append(proposal);
        mutationForm(summary,"Withdraw pending proposal","/proposals/withdraw",{key:alert.key,expectedRevision:alert.proposal.revision},fields => {
          const reason = field(fields,"Withdrawal reason","reason","textarea"); reason.maxLength=2000;reason.required=true;return reason;
        },reason => ({reason:reason.value}),"Withdraw proposal");
      }
      if (["closed","resolved"].includes(alert.decision?.state)) summary.append(p("Reopen this alert with an explicit human decision before creating another proposal."));
      else mutationForm(summary,alert.proposal?.status === "pending" ? "Replace pending proposal" : "Create a proposal","/proposals",
        {key:alert.key,expectedRevision:alert.proposal?.revision || 0},fields => decisionFields(fields,alert,true),
        fields => ({state:fields.state.value,category:fields.category.value,note:fields.note.value,authorLabel:fields.owner.value}),"Save proposal");
      mutationForm(summary,"Record a human decision","/decisions",{key:alert.key,expectedRevision:alert.decision?.revision || 0},fields => {
        fields.append(p("Applies only to this alert and supersedes its pending proposal. Critical exceptions require a reason."));return decisionFields(fields,alert,false);
      },fields => ({state:fields.state.value,category:fields.category.value,owner:fields.owner.value,note:fields.note.value}),"Save human decision");
      const caseSection = el("section",undefined,"st-case-context"); caseSection.append(el("h3","Case context"));
      if (value.caseContext) {
        const group = value.caseContext;
        append(caseSection,p(group.label + " · " + group.totalMembers + " stored members · " + group.availableMembers + " retained · " + group.unavailableMembers + " unavailable"),
          p("These are case members, not additional findings or notes belonging to the selected alert."));
        group.members.forEach(member => caseSection.append(link(member.title || member.recordId,() => investigationChanges(member))));
        if (group.hasMore) caseSection.append(link("Browse remaining case members",{groupId:group.id,offset:null,mode:null,return:null}));
      } else caseSection.append(p("Ungrouped canonical alert. No stored case or shared case identity is inferred."));
      caseSection.append(p("Case-file attachments and independent agent-note associations are unsupported. The selected alert’s recorded proposal, decision and history notes remain available with their provenance."));
      append(summary,caseSection,link("Open full investigation",() => investigationChanges(alert)),back);
      renderEvidence(panes.evidence,value.evidence); renderHistory(panes.history,value.history);
      inspectorHost.replaceChildren(header,context,nav,inspectorStatus,panes.summary,panes.evidence,panes.history);
      inspectorStatus.replaceChildren(); updateInspectorContext();
    }
    async function fetchInspection(key,version,signal) {
      if (!validKey(key) || !validVersion(version)) throw new Error("An exact displayed evidence version is required. Return to the queue to select a retained alert.");
      return checkInspection(await request("/alert/inspection",undefined,{key,expectedVersion:version},{signal,maxBytes:640 * 1024}),key,version);
    }
    async function openAlert(key,version,options = {}) {
      if (!options.guarded && !(await canDiscard())) return false;
      const captured = ++readGeneration, edits = editVersion, session = viewerId;
      inspectionController?.abort(); const controller = new AbortController(); inspectionController = controller;
      const abort = () => controller.abort();
      options.signal?.addEventListener("abort",abort,{once:true});
      if (options.signal?.aborted) controller.abort();
      inspectorStatus?.replaceChildren(notice("Reading exact selected alert… The current panel stays available."));
      try {
        const value = await fetchInspection(key,version || data?.alerts.find(alert => alert.key === key)?.evidenceVersion,controller.signal);
        if (disposed || captured !== readGeneration || edits !== editVersion || session !== viewerId || isPending() || options.signal?.aborted) throw new Error("The selection, session or form changed while the read was pending. The previous panel was retained.");
        if (options.prepare) return value;
        renderInspector(value);
        if (!options.local) changeContext({alert:key,version:value.evidenceVersion,tab:q.tab || "summary"});
        return true;
      } catch(error) {
        if (!disposed && captured === readGeneration) {
          readError = error.message;
          inspectorStatus?.replaceChildren(notice(error.message + " No workflow change was made.",true),
            btn("Retry inspection read",() => routeTo(contextUrl(q,{alert:key,version,tab:q.tab || "summary"})),"retry-inspection"));
        }
        return false;
      } finally { options.signal?.removeEventListener("abort",abort); }
    }
    function localNavigation({path,query,reason,signal,canLeave = canDiscard} = {}) {
      if (path !== "/triage" || !data) return false;
      const next = Object.fromEntries(query?.entries ? query.entries() : Object.entries(query || {}));
      if ((next.appId || "") !== q.appId) return false;
      return (async () => {
        const nextKey = next.alert || null, nextVersion = next.version || (nextKey ? data.alerts.find(alert => alert.key === nextKey)?.evidenceVersion : null);
        const targetChanged = nextKey !== (inspector?.key || null) || Boolean(nextKey && nextVersion !== inspector?.evidenceVersion);
        const approvalChanged = (next.approval || "") !== (q.approval || "");
        if (approvalChanged && isPending()) return false;
        let nextTimezone = next.tz || displayTimezone;
        try { new Intl.DateTimeFormat("en",{timeZone:nextTimezone}).format(); } catch { return false; }
        const timezoneChanged = nextTimezone !== timezone;
        const boardChanged = filterScope(next.appId,next) !== filterScope(q.appId,q) || (next.offset || "0") !== (q.offset || "0") || (next.limit || "50") !== (q.limit || "50");
        if (targetChanged && !(await canLeave())) return false;
        let board = null, prepared = null, approval = null, approvalItems = null;
        const listToken = boardChanged ? ++listGeneration : listGeneration;
        try {
          if (boardChanged) { listController?.abort(); const controller = new AbortController(); listController = controller; const cancel=()=>controller.abort(); signal?.addEventListener("abort",cancel,{once:true});
            try { board=await fetchBoard(next,controller.signal); } finally {signal?.removeEventListener("abort",cancel);} }
          if (signal?.aborted || disposed || boardChanged && listToken !== listGeneration) return false;
          if (approvalChanged && next.approval) {
            const result = await request("/approvals/" + encodeURIComponent(next.approval),undefined,{}, {signal});
            approval = checkOperation(result.operation);
            if (approval.id !== next.approval) throw new Error("Saved approval identity changed.");
            approvalItems = await request("/approvals/" + encodeURIComponent(next.approval) + "/items",undefined,{limit:100,offset:0},{signal});
            if (approvalItems.operationId !== approval.id || !Array.isArray(approvalItems.items) || !approvalItems.page || approvalItems.page.total !== approval.total || approvalItems.items.some(item=>!validKey(item.key))) throw new Error("Exact snapshot membership is unavailable.");
          }
          if (targetChanged && nextKey) {
            prepared = await openAlert(nextKey,nextVersion,{local:true,guarded:true,signal,prepare:true}); if (!prepared) return false;
          }
          if (signal?.aborted || disposed || boardChanged && listToken !== listGeneration || approvalChanged && isPending()) return false;
          applyQuery(next); timezone = nextTimezone;
          if (approvalChanged) { operation = approval; operationItems = approvalItems; operationError = ""; itemError = ""; reviewedKeys = null; pendingPreview = null; uncertainPreview = false; uncertainStep = false; renderReview(); }
          if (prepared) renderInspector(prepared);
          else if (targetChanged) { resetForms(); inspector=null;emptyInspector(); }
          expanded.clear(); String(q.expand || "").split(",").filter(Boolean).forEach(key=>expanded.add(key));
          leaves.clear(); String(q.evidence || "").split(",").filter(Boolean).forEach(key=>leaves.add(key));
          if (board) {
            data=board;const newScope=filterScope(q.appId,q);
            if (newScope!==scopeKey) {scopeKey=newScope;if(!selections.has(scopeKey))selections.set(scopeKey,new Set());chosen=selections.get(scopeKey);}
            drawBoard();
          } else if (timezoneChanged) drawBoard();
          else {updateDisclosure();updateInspectorContext();}
          if (timezoneChanged) main.querySelectorAll("time").forEach(node => {
            if (!node.dateTime) return;
            const formatted = when(node.dateTime); node.textContent = formatted.textContent; node.title = formatted.title;
          });
          if (targetChanged && nextKey && reason !== "popstate") focusInspector();
          if (q.anchor === "triage-queue" && !nextKey) {queueHost.scrollIntoView?.({block:"nearest"});queueHost.tabIndex=-1;queueHost.focus?.({preventScroll:true});}
          return true;
        } catch(error) { if (!disposed) inspectorStatus?.replaceChildren(notice(error.message + " The prior view is retained.",true));return false; }
      })();
    }
    function showGroupForm() {
      if (isPending() || chosen.size < 2 || currentDialog) return;
      const keys = [...chosen], dialog = openDialog("Create an explicit case group");
      if (!dialog) return;
      dialog.append(p("Groups exactly " + keys.length + " selected alerts in this application. Imported case titles and reported state do not create local authority. Already-grouped members are rejected."));
      mutationForm(dialog, "Name this case group", "/groups", { keys }, fields => { const name = field(fields, "Group label", "label"); name.maxLength = 160; name.required = true; return name; }, name => ({ label: name.value }), "Create group").open = true;
    }
    function checkOperation(value) {
      if (!value || typeof value.id !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(value.id) || value.appId !== q.appId || !["preview", "running", "completed"].includes(value.status) || count(value.revision) === null || ["total", "eligible", "approved", "skipped", "remaining"].some(key => count(value[key]) === null) || value.approved + value.skipped + value.remaining !== value.eligible) throw new Error("Saved approval state is incomplete. No approval was started.");
      return value;
    }
    function mapCounts(map) { return Object.entries(map || {}).filter(([, amount]) => Number.isFinite(amount) && amount > 0).map(([name, amount]) => amount + " " + (name === "critical" ? "blocked by critical alert or case evidence" : name.replace(/([A-Z])/g, " $1").replace(/-/g, " ").toLowerCase())).join(" · ") || "None"; }
    async function readOperationItems(offset = 0, explicitNavigation = false) {
      if (!operation || disposed || itemsBusy) return;
      if (explicitNavigation) itemsOpen = true;
      const id = operation.id; itemsBusy = true; itemError = ""; renderReview();
      try {
        const result = await request("/approvals/" + encodeURIComponent(id) + "/items", undefined, { limit: 100, offset });
        if (disposed || operation?.id !== id) return;
        if (result.operationId !== id || !Array.isArray(result.items) || !result.page || count(result.page.total) === null || result.page.total !== operation.total || result.items.some(item => !validKey(item.key))) throw new Error("Exact snapshot membership is unavailable.");
        operationItems = result;
      } catch (error) { if (!disposed && operation?.id === id) { itemError = error.message; operationItems = null; } }
      finally {
        itemsBusy = false;
        if (!disposed) {
          renderReview();
          // A shorter candidate page must not strand the reader in the alert
          // list below. Background status/step reads never move focus.
          if (explicitNavigation && operation?.id === id) {
            const summary = review.querySelector(".st-snapshot-items")?.querySelector("summary");
            summary?.scrollIntoView?.({ block: "center", inline: "nearest" });
            summary?.focus?.({ preventScroll: true });
          }
        }
      }
    }
    function itemReview() {
      const details = el("details", undefined, "st-snapshot-items"); details.open = itemsOpen; details.addEventListener("toggle", () => { itemsOpen = details.open; });
      details.append(el("summary", "Inspect exact frozen candidates" + (operationItems ? " · " + operationItems.page.total : "")));
      if (itemsBusy) details.append(notice("Retrieving snapshot membership…"));
      if (itemError) details.append(notice(itemError + " No membership has been assumed.", true), btn("Retry snapshot items", () => readOperationItems(0, true), "retry-items"));
      if (!operationItems) return details;
      const page = operationItems.page;
      details.append(p("These are the exact saved candidates, including exclusions. Proposed state and reason are frozen at preview time. Outcomes reflect the latest item read."));
      const table = el("table", undefined, "st-item-table"), head = el("tr");
      ["Finding / exact ID", "Source", "Severity", "Frozen proposal", "Outcome"].forEach(title => { const th = el("th", title); th.scope = "col"; head.append(th); });
      table.append(append(el("thead"), head)); const body = el("tbody");
      operationItems.items.forEach(item => {
        const row = el("tr"); row.dataset.snapshotKey = item.key;
        const evidence = el("details"); append(evidence, el("summary", item.title || item.recordId), el("p", "Record: " + item.recordId), el("code", item.key), p(item.note || "No proposal reason recorded"), when(item.observedAt));
        append(row, append(el("td"), evidence), el("td", item.sourceId), append(el("td"), badge(item.severity, "severity")),
          el("td", item.state ? item.state + " / " + item.category + " · revision " + item.proposalRevision : "No pending proposal"), el("td", item.outcome));
        body.append(row);
      });
      table.append(body); details.append(append(el("div", undefined, "st-item-wrap"), table));
      const pages = el("nav", undefined, "st-pages"); pages.setAttribute("aria-label", "Frozen approval candidates");
      if (page.offset > 0) { const previous = btn("Previous candidates", () => readOperationItems(Math.max(0, page.offset - page.limit), true), "previous-items"); previous.disabled = itemsBusy || running; pages.append(previous); }
      pages.append(el("span", operationItems.items.length ? (page.offset + 1) + "–" + (page.offset + operationItems.items.length) + " of " + page.total + " candidates" : "No candidates"));
      if (page.hasMore) { const next = btn("Next candidates", () => readOperationItems(page.nextOffset, true), "next-items"); next.disabled = itemsBusy || running; pages.append(next); }
      details.append(pages); return details;
    }
    function renderReview() {
      review.replaceChildren(); if (!operation) {
        if (operationError) {
          review.append(notice(operationError, true));
          if (pendingPreview) { const retry = btn("Retry same preview", () => submitPreview(pendingPreview), "retry-preview"); retry.disabled = busy || running; review.append(retry); }
        }
        return;
      }
      const op = operation, headline = op.eligible === 0 ? "No eligible proposals; nothing approved" : op.status === "completed" ? "Approval run completed" : running ? "Applying confirmed proposals" : op.status === "preview" ? "Review before approving" : "Approval run paused";
      append(review, el("h2", headline), p("Application: " + op.appId + " · scope: " + op.scope + " · snapshot: "), when(op.snapshotAt),
        p("Saved filters: " + Object.entries(op.filters || {}).map(([key, value]) => key + "=" + value).join(" · ")),
        el("strong", op.eligible + " eligible of " + op.total + " snapshot candidates"), p("Excluded before approval: " + mapCounts(op.excluded)),
        p("Proposed outcomes: " + list(op.proposedOutcomes).map(item => item.count + " " + item.state + " / " + item.category).join(" · ")),
        p("Sources: " + list(op.sources).map(item => item.sourceId + " (" + item.count + ")").join(" · ")),
        el("p", op.approved + " approved · " + op.skipped + " skipped after recheck · " + op.remaining + " remaining", "st-progress"),
        p("Recheck outcomes: " + mapCounts(Object.fromEntries(Object.entries(op.byOutcome || {}).filter(([name]) => name !== "approved")))));
      if (operationError) review.append(notice(operationError, true));
      review.append(itemReview());
      const actions = el("div", undefined, "st-actions");
      if (running) actions.append(btn("Pause after this batch", () => { pause = true; renderReview(); }, "pause"));
      else if (op.canResume && op.remaining > 0) {
        const approve = btn(op.status === "preview" ? "Approve " + op.eligible + " proposals" : "Resume " + op.remaining + " remaining proposals", run, op.status === "preview" ? "approve" : "resume"); approve.disabled = busy || itemsBusy || !operationItems || Boolean(itemError); actions.append(approve);
      }
      const refresh = btn("Retrieve saved progress", restoreOperation, "refresh-operation"); refresh.disabled = busy || running; actions.append(refresh);
      append(review, actions, p(pause && running ? "Pausing after the in-flight batch is saved." : "Only the explicit Approve or Resume button applies decisions. Reload retrieves saved progress and never continues a run. Changed proposals are skipped; critical exceptions require manual review."));
    }
    async function preview(scope, exactKeys) {
      if (isPending()) return;
      operation = null; operationItems = null; itemError = ""; operationError = ""; reviewedKeys = scope === "selected" ? [...(exactKeys || chosen)] : null; changeContext({ approval: null }); renderReview();
      const payload = { appId: q.appId, scope, idempotencyKey: idempotency(), filters: exactKeys ? {view:"all"} : filters(q), ...(scope === "selected" ? { keys: reviewedKeys } : {}) };
      pendingPreview = payload; await submitPreview(payload);
    }
    async function submitPreview(payload) {
      if (busy || running) return;
      busy = true; operationError = ""; renderReview(); syncSelection(); review.append(notice("Preparing an exact proposal snapshot. No decisions are being applied."));
      try { const result = await request("/approvals/preview", payload); if (disposed) return; operation = checkOperation(result.operation); pendingPreview = null; uncertainPreview = false; changeContext({ approval: operation.id }); await readOperationItems(0); }
      catch (error) { uncertainPreview = !error.status || error.status >= 500 || [408,429].includes(error.status); operationError = "Review could not be prepared. " + error.message; }
      finally { busy = false; if (!disposed) { renderReview(); syncSelection(); review.scrollIntoView?.({ block: "nearest" }); } }
    }
    async function restoreOperation() {
      if (busy || running || !q.approval) return;
      busy = true; syncSelection();
      try { const result = await request("/approvals/" + encodeURIComponent(q.approval)); if (disposed) return; operation = checkOperation(result.operation); uncertainStep = false; operationError = ""; await readOperationItems(operationItems?.page.offset || 0); }
      catch (error) { operationError = "Saved approval progress is unavailable. " + error.message; }
      finally { busy = false; if (!disposed) { renderReview(); syncSelection(); } }
    }
    async function run() {
      if (busy || running || !operation?.canResume || !operationItems || itemsBusy || itemError) return;
      if (uncertainStep || [...formStates].some(state => state.uncertain) || !discardOtherForms(null)) return;
      running = true; pause = false; operationError = ""; renderReview(); syncSelection();
      try {
        while (!pause && !disposed && operation.canResume && operation.remaining > 0) {
          const prior = operation.revision, result = await request("/approvals/" + encodeURIComponent(operation.id) + "/step", { appId: q.appId, revision: prior });
          if (disposed) return; const next = checkOperation(result.operation);
          if (next.revision <= prior && next.remaining > 0) throw new Error("Saved progress did not advance. Retrieve progress before resuming.");
          operation = next; uncertainStep = false; renderReview();
          if (operation.remaining > 0) await new Promise(resolve => root.setTimeout(resolve, 25));
        }
        if (operation.remaining === 0 && reviewedKeys) { reviewedKeys.forEach(key => chosen.delete(key)); reviewedKeys = null; }
      } catch (error) { pause = true; uncertainStep = !error.status || error.status >= 500 || [408,429].includes(error.status); operationError = "Run paused. " + error.message + " Retrieve saved progress or resume to reconcile the saved step."; }
      finally { running = false; if (!disposed) { await readOperationItems(operationItems?.page.offset || 0); renderReview(); await load(); syncSelection(); } }
    }
    cleanup.ready = (async () => { await load(); if (disposed) return; if (q.approval) await restoreOperation(); if (q.alert && validKey(q.alert)) await openAlert(q.alert,q.version,{guarded:true}); })();
    return cleanup;
  }
  root.SocTriage = Object.freeze({ render, filters, filterScope, contextUrl, safeReturn, groupRows, selectionSummary, clearSelections: () => { selections.forEach(selected => selected.clear()); selections.clear(); } });
}(window));
