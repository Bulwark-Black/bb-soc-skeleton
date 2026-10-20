(function (root) {
  "use strict";
  const API = "/api/v1/operations", MAX_RESPONSE = 8 * 1024 * 1024;
  const ROUTES = Object.freeze({ "/infrastructure": "Infrastructure", "/services": "Services", "/websites": "Websites", "/metrics": "Metrics", "/incidents": "Incidents", "/jobs": "Critical jobs", "/employees": "AI Employees", "/analyst-reports": "Analyst reports" });
  const RANGES = Object.freeze({ "15m": 900000, "1h": 3600000, "6h": 21600000, "24h": 86400000, "7d": 604800000, "30d": 2592000000, "90d": 7776000000 });
  const CURSORS = { "/incidents": ["incidentCursor", "episodeCursor"], "/jobs": ["runCursor"] };
  const KEYS = ["appId", "host", "check", "job", "incident", "endpoint", "series", "range", "from", "to", "tz", "state", "status", "filter", "jobSearch", "employee", "inboxOffset"];
  const list = value => Array.isArray(value) ? value : [];
  const finite = value => typeof value === "number" && Number.isFinite(value);
  const stamp = value => value === null || value === undefined || value === "" ? null : finite(value) ? value : Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
  const text = value => value === null || value === undefined ? "Not reported" : String(value);
  const validId = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/.test(value);
  const cursor = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,1024}$/.test(value);
  function zone(value) { try { const candidate = String(value || "UTC"); new Intl.DateTimeFormat("en", { timeZone: candidate }).format(); return candidate; } catch { return "UTC"; } }
  function parseWindow(query, now = Date.now()) {
    const range = Object.hasOwn(RANGES, query.range) ? query.range : "24h";
    let from = now - RANGES[range], to = now, warning = "";
    if (query.range === "custom") {
      const instant = value => /^\d{10,13}$/.test(value || "") ? Number(value) : typeof value === "string" && /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? stamp(value) : null;
      const a = instant(query.from), b = instant(query.to);
      if (a !== null && b !== null && a >= 0 && b > a && b - a <= RANGES["90d"] && b <= now + 300000) { from = a; to = b; }
      else warning = "Invalid custom interval. Showing the last 24 hours; use an interval up to 90 days with explicit UTC timestamps.";
    } else if (/^\d{10,13}$/.test(query.from || "") && /^\d{10,13}$/.test(query.to || "") && Number(query.to) > Number(query.from) && Number(query.to) - Number(query.from) <= RANGES["90d"] && Number(query.to) <= now + 300000) {
      from = Number(query.from); to = Number(query.to);
    }
    return { from, to, range: query.range === "custom" && !warning ? "custom" : range, timezone: zone(query.tz), warning };
  }
  function contextUrl(route, query = {}, window = parseWindow(query), overrides = {}) {
    if (!Object.hasOwn(ROUTES, route) && !["/logs", "/source", "/health", "/agents", "/sources", "/docs", "/onboard", "/analyst"].includes(route)) throw new TypeError("Unsupported operations destination.");
    const merged = { ...query, range: window.range, from: window.from, to: window.to, tz: window.timezone, ...overrides }, params = new URLSearchParams();
    for (const key of [...KEYS, ...(CURSORS[route] || []), "section", "stab", "atab", "sourceId"]) {
      const value = merged[key]; if (value === null || value === undefined || value === "") continue;
      if (key === "state" && route !== "/incidents" || ["status", "jobSearch"].includes(key) && route !== "/jobs" || ["employee", "inboxOffset"].includes(key) && !["/employees", "/analyst-reports"].includes(route)) continue;
      if (key === "filter" && (route === "/infrastructure" ? !["attention", "reporting", "unknown"].includes(value) : route === "/services" ? !["healthy", "warning", "critical", "unknown"].includes(value) : true)) continue;
      if (key.endsWith("Cursor") && !cursor(value)) continue;
      if ((typeof value !== "string" && !finite(value)) || String(value).length > (key === "series" ? 4000 : key.endsWith("Cursor") ? 1024 : 300) || /[\u0000-\u001f\u007f]/.test(String(value))) continue;
      if (["appId", "host", "check", "job", "incident", "employee", "sourceId"].includes(key) && !validId(value)) continue;
      if (route === "/logs" && !["appId", "host", "from", "to", "tz", "sourceId"].includes(key)) continue;
      params.set(key, route === "/logs" && ["from", "to"].includes(key) ? new Date(Number(value)).toISOString() : String(value));
    }
    return "#" + route + (params.size ? "?" + params : "");
  }
  function boundedPoints(input, from, to, maximum = 1200) {
    const seen = new Map();
    for (const raw of list(input).slice(0, 100000)) {
      const at = stamp(raw?.at); if (at === null || at < from || at > to) continue;
      const good = finite(raw.value) && (!raw.quality || raw.quality === "good");
      seen.set(at, { at, value: good ? raw.value : null, min: good ? finite(raw.min) ? raw.min : raw.value : null, max: good ? finite(raw.max) ? raw.max : raw.value : null,
        quality: good ? "good" : "unknown", count: finite(raw.count) && raw.count >= 0 ? raw.count : good ? 1 : 0 });
    }
    const points = [...seen.values()].sort((a, b) => a.at - b.at);
    const max = Math.max(1, Math.min(1200, Math.floor(maximum)));
    if (points.length <= max) return { points, aggregated: false, originalCount: points.length };
    const groups = new Map();
    for (const point of points) { const index = Math.min(max - 1, Math.floor((point.at - from) / Math.max(1, to - from) * max)); if (!groups.has(index)) groups.set(index, []); groups.get(index).push(point); }
    return { aggregated: true, originalCount: points.length, points: [...groups.values()].map(rows => {
      const good = rows.every(row => row.value !== null); return { at: rows[Math.floor(rows.length / 2)].at, value: good ? rows.reduce((n, row) => n + row.value, 0) / rows.length : null,
        min: good ? Math.min(...rows.map(row => row.min)) : null, max: good ? Math.max(...rows.map(row => row.max)) : null, quality: good ? "good" : "unknown", count: rows.reduce((n, row) => n + row.count, 0) };
    }) };
  }
  function segments(points, gapMs) {
    const runs = []; let run = [], previous = null;
    for (const point of points) {
      if (point.value === null || (previous !== null && point.at - previous > gapMs)) { if (run.length) runs.push(run); run = []; }
      if (point.value !== null) run.push(point);
      previous = point.value === null ? null : point.at;
    }
    if (run.length) runs.push(run); return runs;
  }
  function csvCell(value) { let valueText = value === null || value === undefined ? "" : String(value); if (/^[\s]*[=+\-@]/.test(valueText)) valueText = "'" + valueText; return '"' + valueText.replace(/"/g, '""') + '"'; }
  function chartCsv(series, points, window, resolution, aggregated) {
    return [["series", "label", "host", "timestamp_utc", "display_timezone", "unit", "value", "minimum", "maximum", "quality", "sample_count", "resolution", "display_aggregation"],
      ...points.map(point => [series.id, series.label, series.host, new Date(point.at).toISOString(), window.timezone, series.unit, point.value, point.min, point.max, point.quality, point.count, resolution, aggregated])]
      .map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
  }
  function render({ container, route = "/infrastructure", appId, query, applications = [], onError, scopeLoaded = false, displayTimezone } = {}) {
    if (!container || !Object.hasOwn(ROUTES, route)) throw new TypeError("Operations requires a container and supported route.");
    const document = container.ownerDocument || root.document;
    const navigationReads = new Set(), navigationWrites = new Set();
    let disposed = false, busy = false, dirty = false, delegated = null;
    const controllers = new Set(), chartInspectors = [], draftForms = new Set(), unresolvedForms = new Set();
    const q = query?.entries ? Object.fromEntries(query.entries()) : { ...(query || {}) };
    if (appId) q.appId = appId;
    if (!q.tz && displayTimezone) q.tz = zone(displayTimezone);
    const window = parseWindow(q);
    const el = (tag, value, className) => { const node = document.createElement(tag); if (value !== undefined) node.textContent = text(value); if (className) node.className = className; return node; };
    function append(parent, children) { children.flat().filter(value => value !== null && value !== undefined && value !== false).forEach(value => parent.append(value?.nodeType ? value : el("span", value))); return parent; }
    function panel(title, ...children) { return append(el("section", undefined, "ops-panel"), [el("h2", title), ...children]); }
    const p = value => el("p", value, "ops-muted");
    function notice(message, warning = false) { const node = el("p", message, "ops-notice" + (warning ? " ops-warning" : "")); node.setAttribute("role", warning ? "alert" : "status"); return node; }
    function link(label, target, overrides = {}) { const node = el("a", label); node.href = contextUrl(target, q, window, overrides); return node; }
    function button(label, action) { const node = el("button", label); node.type = "button"; node.addEventListener("click", action); return node; }
    function links(items) { const nav = el("nav", undefined, "ops-links"); nav.setAttribute("aria-label", "Related evidence"); items.filter(Boolean).forEach(item => nav.append(link(...item))); return nav; }
    function when(value) { const at = stamp(value); if (at === null) return el("span", "Not observed", "ops-muted"); const node = el("time", new Intl.DateTimeFormat("en", { timeZone: window.timezone, dateStyle: "medium", timeStyle: "medium" }).format(at)); node.setAttribute("datetime", new Date(at).toISOString()); node.title = new Date(at).toISOString(); return node; }
    function badge(value) {
      const label = text(value || "unknown").replace(/_/g, " ");
      const tone = ["healthy", "good", "verified", "succeeded", "fresh", "recent"].includes(value) ? "good" : ["critical", "failed", "error", "stalled", "overdue", "never_started"].includes(value) ? "bad" : ["warning", "partial", "overlap", "degraded", "needs-reconciliation", "retryable"].includes(value) ? "warning" : "neutral";
      return el("span", label, "ops-badge ops-" + tone);
    }
    function number(value, unit = "") { if (!finite(value)) return "Unknown"; if (unit === "bytes") { const units = ["B", "KiB", "MiB", "GiB", "TiB"]; let index = 0; while (Math.abs(value) >= 1024 && index < units.length - 1) { value /= 1024; index++; } unit = units[index]; } return new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(value) + (unit ? " " + unit : ""); }
    function details(value, label = "Recorded evidence") { const node = el("details"); append(node, [el("summary", label), el("pre", JSON.stringify(value ?? {}, null, 2).slice(0, 64000), "ops-evidence")]); return node; }
    function facts(rows) { const dl = el("dl", undefined, "ops-facts"); rows.forEach(([label, value]) => append(dl, [el("dt", label), append(el("dd"), [value])])); return dl; }
    function table(headers, rows, emptyText = "No observations are recorded in this view.") {
      const wrap = el("div", undefined, "ops-table-wrap"), node = el("table"), head = el("tr"); headers.forEach(label => { const th = el("th", label); th.setAttribute("scope", "col"); head.append(th); });
      node.append(append(el("thead"), [head])); const body = el("tbody");
      rows.slice(0, 1200).forEach(row => { const tr = el("tr"); row.forEach(value => tr.append(append(el("td"), [value]))); body.append(tr); });
      if (!rows.length) { const td = el("td", emptyText); td.setAttribute("colspan", String(headers.length)); body.append(append(el("tr"), [td])); }
      node.append(body); wrap.append(node); return wrap;
    }
    function cards(rows) { const parent = el("div", undefined, "ops-cards"); rows.forEach(([label, value, target, overrides, detail]) => { const a = link("", target, overrides); a.className = "ops-card"; append(a, [el("span", label), el("strong", value ?? "Unknown"), el("small", detail || "")]); parent.append(a); }); return parent; }
    function field(parent, label, name, type = "text", value = "", choices = []) {
      const wrapper = el("label", label), input = el(type === "textarea" || type === "select" ? type : "input"); input.name = name;
      if (!["textarea", "select"].includes(type)) input.type = type;
      if (type === "select") choices.forEach(item => { const opt = el("option", Array.isArray(item) ? item[1] : item); opt.value = Array.isArray(item) ? item[0] : item; input.append(opt); });
      input.value = value || ""; wrapper.append(input); parent.append(wrapper); return input;
    }
    const main = el("div", undefined, "ops"); const heading = el("header", undefined, "ops-heading"); append(heading, [el("small", "BB SOC / Operations"), el("h1", ROUTES[route]), p("Measurements, collection freshness, incident decisions and employee assessments remain separate evidence.")]); heading.querySelector("h1").id = "page-title"; main.append(heading);
    const status = p("Loading operations…"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite"); main.append(status); const content = el("div"); main.append(content); container.replaceChildren(main);
    const cleanup = () => { disposed = true; controllers.forEach(controller => controller.abort()); controllers.clear(); if (delegated) delegated(); }; cleanup.isPending = () => navigationWrites.size > 0 || unresolvedForms.size > 0 || !!delegated?.isPending();
    cleanup.cancelReads = () => { navigationReads.forEach(controller => controller.abort()); delegated?.cancelReads?.(); };
    cleanup.isDirty = () => dirty || cleanup.isPending() || !!delegated?.isDirty();
    if (!root.SOC_PRIVATE_APPLICATION) { status.textContent = "This data-free preview has no monitoring provider. Start the private application and configure Operations to receive your own observations."; content.append(link("Configure Operations", "/docs", { section: "66-native-monitoring-and-operations" })); return cleanup; }
    if (!scopeLoaded && !list(applications).length) {
      cleanup.ready = (async () => {
        try { const data = await request("__applications", { reason: "refresh" }); if (disposed) return;
          const appRows = data.apps || data.snapshot?.apps; if (!Array.isArray(appRows)) throw new Error("Application registry returned an incomplete response."); const apps = appRows; delegated = render({ container, route, appId: q.appId || (apps.length === 1 ? apps[0].appId : undefined), query: q, applications: apps, onError, scopeLoaded: true, displayTimezone }); await delegated.ready;
        } catch (error) { if (!disposed) { status.textContent = "Application registry unavailable. " + error.message; content.append(link("Configure Operations", "/docs", { section: "66-native-monitoring-and-operations" })); } }
      })(); return cleanup;
    }
    const scope = el("div", undefined, "ops-controls");
    if (list(applications).length) { const selected = field(scope, "Application", "operationsApp", "select", q.appId, [["", "Choose an application"], ...applications.map(app => [app.appId, app.displayName || app.appId])]); selected.addEventListener("change", () => { const next = selected.value; selected.value = q.appId || ""; root.location.hash = contextUrl(route, {}, window, { appId: next }).slice(1); }); main.insertBefore(scope, status); }
    if (!validId(q.appId)) { status.textContent = "Choose a registered application to inspect Operations. Configure its private monitoring registry and sources before collecting."; content.append(links([["Register an application", "/onboard"], ["Configure Operations", "/docs", { section: "66-native-monitoring-and-operations" }]])); return cleanup; }
    function navigate(overrides, reset = false) { const changes = reset ? { incidentCursor: undefined, episodeCursor: undefined, runCursor: undefined, inboxOffset: undefined, incident: undefined, job: undefined, ...overrides } : overrides; root.location.hash = contextUrl(route, q, window, changes).slice(1); }
    function intervalControls() {
      const form = el("form", undefined, "ops-controls"); const range = field(form, "Interval", "range", "select", window.range, [...Object.keys(RANGES), "custom"]);
      const timezone = field(form, "Display timezone", "tz", "select", window.timezone, [...new Set(["UTC", Intl.DateTimeFormat().resolvedOptions().timeZone, window.timezone])]);
      const from = field(form, "Custom start (UTC)", "from", "datetime-local", new Date(window.from).toISOString().slice(0, 19)); from.step = "1";
      const to = field(form, "Custom end (UTC)", "to", "datetime-local", new Date(window.to).toISOString().slice(0, 19)); to.step = "1";
      const apply = el("button", "Apply interval"); apply.type = "submit"; form.append(apply);
      form.addEventListener("submit", event => { event.preventDefault(); navigate({ range: range.value, tz: timezone.value, from: range.value === "custom" ? from.value + "Z" : undefined, to: range.value === "custom" ? to.value + "Z" : undefined }); });
      return form;
    }
    content.append(intervalControls()); if (window.warning) content.append(notice(window.warning, true));
    const board = el("div"); content.append(board);
    async function request(endpoint, params = {}, body) {
      if (disposed) throw new Error("View closed."); const controller = new AbortController(); controllers.add(controller);
      const navigationRead = body === undefined; (navigationRead ? navigationReads : navigationWrites).add(controller); const timer = root.setTimeout(() => controller.abort(), 30000);
      const search = new URLSearchParams({ ...Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== "").map(([key, value]) => [key, String(value)])), appId: q.appId });
      try {
        const response = await root.fetch(endpoint === "__applications" ? "/api/v1/control/snapshot?reason=refresh" : (endpoint === "finding-notifications" || endpoint.startsWith("finding-notifications/") ? "/api/v1/" : API + "/") + endpoint + "?" + search, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal,
          headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        if (!response.ok) { try { await response.body?.cancel(); } catch {} const error = new Error(({ 401: "Sign in again to view Operations.", 403: "This operation is not permitted for the current session and application.", 404: "This operations evidence or capability is not available.", 409: "The record or history position changed. Refresh the current view before making a new decision.", 422: "Review the supplied fields and configured monitoring policy.", 429: "Operations is temporarily rate limited. Retry later.", 503: "Operations is unavailable. Inspect the private monitoring configuration." })[response.status] || "Operations request failed. Existing evidence has not been treated as empty."); error.status = response.status; throw error; }
        if (!/^application\/json\b/i.test(response.headers.get("content-type") || "")) throw new Error("Operations returned an unsupported response.");
        const reader = response.body.getReader(), chunks = []; let length = 0;
        while (true) { const part = await reader.read(); if (part.done) break; length += part.value.byteLength; if (length > MAX_RESPONSE) { await reader.cancel(); throw new Error("Operations response exceeds its display limit."); } chunks.push(part.value); }
        const bytes = new Uint8Array(length); let offset = 0; chunks.forEach(chunk => { bytes.set(chunk, offset); offset += chunk.byteLength; });
        const result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); if (!result || typeof result !== "object" || result.ok === false) throw new Error("Operations evidence is unavailable."); return result;
      } catch (error) { if (error.name === "AbortError") throw new Error("Operations request timed out. Refresh before retrying; a submitted decision may already be saved."); if (error instanceof TypeError || error instanceof SyntaxError) throw new Error("Operations response could not be read safely."); throw error; }
      finally { root.clearTimeout(timer); controllers.delete(controller); navigationReads.delete(controller); navigationWrites.delete(controller); }
    }
    const read = async (endpoint, params) => {
      try {
        const data = await request(endpoint, params), properties = { resources: ["resources"], checks: ["checks"], series: ["series"], query: ["series"], websites: ["websites"], "website-history": ["coverage", "series"], employees: ["employees", "work"], events: ["events"], notifications: ["deliveries"], "finding-notifications": ["attempts"], dependencies: ["dependencies"] };
        if (properties[endpoint]?.some(key => !Array.isArray(data[key])) || endpoint === "incidents" && (params?.incidentId ? !data.incident || typeof data.incident !== "object" : !Array.isArray(data.incidents) || params?.view === "history" && !data.page) || endpoint === "jobs" && (params?.history ? !Array.isArray(data.runs) || !data.page || data.jobId !== params.history : !Array.isArray(data.jobs)) || endpoint === "employee-inbox" && (typeof data.available !== "boolean" || data.available && (!Array.isArray(data.items) || !Array.isArray(data.recipients)))) throw new Error("Operations returned incomplete evidence. No empty state has been assumed.");
        return data;
      } catch (error) { return { unavailable: true, status: error.status, message: error.message }; }
    };
    function unavailable(data, label) { return notice(label + " unavailable. " + (data.message || "No empty or healthy state has been assumed."), true); }
    function asOf(data) { return append(p("Snapshot as of "), [when(data.asOf || data.at), el("span", " · observed state is independent of employee assessments.")]); }
    function filterForm(fields, selected = q) {
      const form = el("form", undefined, "ops-controls"), values = {};
      fields.forEach(([label, name, choices]) => { values[name] = field(form, label, name, choices ? "select" : "search", selected[name] || "", choices || []); if (!choices) values[name].maxLength = 160; });
      const apply = el("button", "Apply filters"); apply.type = "submit"; form.append(apply);
      form.addEventListener("submit", event => { event.preventDefault(); navigate(Object.fromEntries(Object.entries(values).map(([key, input]) => [key, input.value || undefined])), true); });
      return form;
    }
    function history(data, key, label, overrides = {}) {
      if (data.unavailable || !data.page) return append(notice([400, 409].includes(data.status) ? "This history position cannot be used with these filters. Open Latest to restart this view." : label + " unavailable; retained history has not been treated as empty.", true), [link("Latest", route, { ...overrides, [key]: undefined })]);
      const page = data.page, nav = el("nav", undefined, "ops-history"); nav.setAttribute("aria-label", label + " pages");
      nav.append(p(text(page.returned ?? 0) + " records on this page" + (Number.isSafeInteger(page.total) ? " of " + page.total + " matching retained records" : "") + ". Newest recorded first. Interval controls do not limit retained history."));
      append(nav, [p("Records selected as of "), when(page.snapshotAt), p("Displayed status can include later updates. Latest includes newly recorded evidence.")]);
      for (const [name, value, allowed] of [["Newer", page.previousCursor, page.hasPrevious], ["Older", page.nextCursor, page.hasNext], ["Latest", undefined, true]]) nav.append(allowed && (name === "Latest" || cursor(value)) ? link(name, route, { ...overrides, [key]: value }) : el("span", name, "ops-muted"));
      return nav;
    }
    function mutation(title, endpoint, fixed, fields, label, explanation) {
      const form = el("form", undefined, "ops-mutation"), inputs = {};
      form.append(el("h3", title)); fields.forEach(spec => { const [name, caption, type, value, choices, max] = spec; const input = field(form, caption, name, type, value, choices); input.required = true; input.maxLength = max || 1000; inputs[name] = input; });
      if (explanation) form.append(p(explanation)); const feedback = p(""); feedback.setAttribute("role", "status");
      const submit = el("button", label); submit.type = "submit"; form.append(submit, feedback); let savedPayload = null, saved = false;
      const initialValues = Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value]));
      const updateDirty = () => { dirty = draftForms.size > 0 || unresolvedForms.size > 0; };
      const markDirty = () => { if (!saved) draftForms.add(form); updateDirty(); };
      form.addEventListener("input", markDirty); form.addEventListener("change", markDirty);
      const discard = button("Discard this draft", async () => {
        if (busy || disposed) return;
        const uncertain = unresolvedForms.has(form); draftForms.delete(form); unresolvedForms.delete(form); updateDirty();
        if (form.dataset) delete form.dataset.dirty;
        if (!dirty) { await load(); return; }
        if (uncertain || saved) { saved = true; submit.disabled = true; Object.values(inputs).forEach(input => { input.disabled = true; }); feedback.textContent = "Other drafts are preserved. Finish or discard them, then refresh to inspect the earlier request outcome before making another decision."; }
        else { Object.entries(inputs).forEach(([key, input]) => { input.value = initialValues[key]; }); feedback.textContent = "Draft discarded. Other drafts are preserved."; }
      }); form.append(discard);
      form.addEventListener("submit", async event => {
        event.preventDefault(); if (busy || disposed || saved) return;
        const values = Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value.trim()])); if (Object.values(values).some(value => !value)) { feedback.textContent = "Complete every field before submitting."; return; }
        if (endpoint === "maintenance") { values.durationMinutes = Number(values.durationMinutes); if (!Number.isFinite(values.durationMinutes) || values.durationMinutes < 1 || values.durationMinutes > 10080) { feedback.textContent = "Use a maintenance duration from 1 to 10,080 minutes."; return; } }
        const body = { ...fixed, ...values }, signature = JSON.stringify(body); if (savedPayload && savedPayload.signature !== signature) { feedback.textContent = "The earlier request is unresolved. Refresh and inspect its outcome before submitting changed content."; return; }
        if (!savedPayload) {
          let idempotencyKey;
          if (typeof root.crypto?.randomUUID === "function") idempotencyKey = root.crypto.randomUUID();
          else if (typeof root.crypto?.getRandomValues === "function") idempotencyKey = "operation-" + Array.from(root.crypto.getRandomValues(new Uint8Array(24)), byte => byte.toString(16).padStart(2, "0")).join("");
          else { feedback.textContent = "This browser cannot create a secure request identity. Use a supported browser before submitting."; return; }
          savedPayload = { signature, body: { ...body, idempotencyKey } };
        }
        busy = true; unresolvedForms.add(form); updateDirty(); submit.disabled = true; discard.disabled = true; Object.values(inputs).forEach(input => { input.disabled = true; }); feedback.textContent = "Saving…";
        try {
          await request(endpoint, {}, savedPayload.body);
          if (!disposed) {
            saved = true; draftForms.delete(form); unresolvedForms.delete(form); updateDirty(); if (form.dataset) delete form.dataset.dirty;
            if (dirty) feedback.textContent = "Saved. Other drafts are preserved. Finish or discard them to reload recorded evidence.";
            else { feedback.textContent = "Saved. Reloading recorded evidence…"; await load(); }
          }
        }
        catch (error) { if (!disposed) { feedback.textContent = error.message; if (onError) onError(error); } }
        finally { busy = false; if (!disposed) { submit.disabled = saved; discard.disabled = false; Object.values(inputs).forEach(input => { input.disabled = saved; }); } }
      });
      return form;
    }
    function exportFile(content, type, filename) { const blob = new Blob([content], { type }); const url = root.URL.createObjectURL(blob), a = el("a"); a.href = url; a.download = filename; document.body.append(a); a.click(); a.remove(); root.setTimeout(() => root.URL.revokeObjectURL(url), 1000); }
    function chart(series, resolution = "raw", events = []) {
      const bounded = boundedPoints(series.points, window.from, window.to), points = bounded.points, valid = points.filter(point => point.value !== null), policy = series.policy || {};
      const thresholds = ["warning", "critical"].filter(key => finite(policy[key])).map(key => ({ key, value: policy[key] }));
      const low = Math.min(0, ...valid.map(point => point.min), ...thresholds.map(item => item.value)), high = Math.max(series.unit === "%" ? 100 : 1, ...valid.map(point => point.max), ...thresholds.map(item => item.value));
      const measuredWidth = Number(board.clientWidth || container.clientWidth), cellWidth = measuredWidth >= 1100 ? (measuredWidth - 18) / 2 : measuredWidth;
      const width = Number.isFinite(cellWidth) && cellWidth > 0 ? Math.max(280, Math.min(760, Math.floor(cellWidth - 42))) : 760, right = width - 14, plotWidth = right - 58, ticks = width < 430 ? 2 : 4;
      const x = at => 58 + (at - window.from) / (window.to - window.from) * plotWidth, y = value => 20 + (high - value) / (high - low) * 178;
      const fmt = value => Number(value).toFixed(2);
      const sv = (name, attrs, value) => { const node = document.createElementNS("http://www.w3.org/2000/svg", name); Object.entries(attrs || {}).forEach(([key, item]) => node.setAttribute(key, String(item))); if (value !== undefined) node.textContent = value; return node; };
      const card = panel(series.label || series.id), svg = sv("svg", { viewBox: "0 0 " + width + " 236", role: "img", tabindex: "0", "aria-label": (series.label || series.id) + ". Unknown samples remain gaps; arrow keys inspect points.", class: "ops-chart" });
      card.className += " ops-chart-card"; card.setAttribute("data-page-filter-skip", "");
      card.append(p((series.host || "") + " · " + (series.unit || "units") + " · " + resolution + (bounded.aggregated ? " · display aggregation preserves min/max and unknowns" : "")));
      for (let i = 0; i <= ticks; i++) { const value = low + (high - low) * i / ticks; svg.append(sv("line", { x1: 58, x2: right, y1: y(value), y2: y(value), class: "ops-grid-line" }), sv("text", { x: 52, y: y(value) + 4, "text-anchor": "end" }, number(value))); const at = window.from + (window.to - window.from) * i / ticks; svg.append(sv("text", { x: x(at), y: 224, "text-anchor": i === 0 ? "start" : i === ticks ? "end" : "middle" }, new Intl.DateTimeFormat("en", { timeZone: window.timezone, hour: "2-digit", minute: "2-digit", ...(window.to - window.from > 86400000 ? { month: "short", day: "numeric" } : {}) }).format(at))); }
      const gap = Math.max(1000, resolution === "1h" ? 3600000 : resolution === "5m" ? 300000 : Number(series.intervalSeconds || 60) * 1000, bounded.aggregated ? (window.to - window.from) / 1200 : 0) * 2.5;
      for (const run of segments(points, gap)) {
        if (run.some(point => point.min !== point.max)) svg.append(sv("path", { class: "ops-range-band", d: run.map((point, index) => (index ? "L" : "M") + fmt(x(point.at)) + "," + fmt(y(point.max))).join(" ") + run.slice().reverse().map(point => "L" + fmt(x(point.at)) + "," + fmt(y(point.min))).join(" ") + "Z" }));
        if (run.length === 1) svg.append(sv("circle", { cx: x(run[0].at), cy: y(run[0].value), r: 3, class: "ops-metric-point" }));
        else svg.append(sv("path", { class: "ops-metric-line", d: run.map((point, index) => (index ? "L" : "M") + fmt(x(point.at)) + "," + fmt(y(point.value))).join(" ") }));
      }
      thresholds.forEach(item => { svg.append(sv("line", { x1: 58, x2: right, y1: y(item.value), y2: y(item.value), class: "ops-threshold ops-threshold-" + item.key }), sv("text", { x: right - 4, y: Math.max(28, y(item.value) - 6), "text-anchor": "end", class: "ops-threshold-label" }, item.key + " " + number(item.value, series.unit))); });
      list(events).filter(event => stamp(event.at) >= window.from && stamp(event.at) <= window.to && (!series.host || !event.host || event.host === series.host)).slice(-40).forEach(event => { const mark = sv("line", { x1: x(stamp(event.at)), x2: x(stamp(event.at)), y1: 20, y2: 198, class: "ops-event-line" }); mark.append(sv("title", {}, (event.type || "Event") + ": " + (event.summary || ""))); svg.append(mark); });
      if (!valid.length) svg.append(sv("text", { x: width / 2, y: 110, "text-anchor": "middle" }, "No valid measurements in this interval"));
      const cross = sv("line", { x1: 0, x2: 0, y1: 20, y2: 198, visibility: "hidden", class: "ops-crosshair" }); svg.append(cross); card.append(svg);
      const readout = p("Use the pointer or arrow keys to inspect. Drag across the chart to select an interval."); readout.setAttribute("aria-live", "polite"); card.append(readout);
      let index = Math.max(0, points.length - 1), start = null;
      const inspect = at => { if (!points.length) return; let lo = 0, hi = points.length - 1; while (lo < hi) { const middle = Math.floor((lo + hi) / 2); if (points[middle].at < at) lo = middle + 1; else hi = middle; } index = lo > 0 && Math.abs(points[lo - 1].at - at) < Math.abs(points[lo].at - at) ? lo - 1 : lo; const point = points[index]; cross.setAttribute("x1", x(at)); cross.setAttribute("x2", x(at)); cross.setAttribute("visibility", "visible"); readout.replaceChildren(when(point.at), el("span", " · " + number(point.value, series.unit) + " · min " + number(point.min, series.unit) + " / max " + number(point.max, series.unit) + " · " + point.quality + " · " + point.count + " samples")); };
      chartInspectors.push(inspect); const allInspect = at => chartInspectors.forEach(fn => fn(at));
      const pointerTime = event => { const box = svg.getBoundingClientRect(); return window.from + Math.max(0, Math.min(1, ((event.clientX - box.left) / box.width * width - 58) / plotWidth)) * (window.to - window.from); };
      svg.addEventListener("pointermove", event => allInspect(pointerTime(event)));
      svg.addEventListener("pointerdown", event => { if (event.button === 0 && event.pointerType !== "touch") { start = pointerTime(event); svg.setPointerCapture?.(event.pointerId); } });
      svg.addEventListener("pointerup", event => { const end = pointerTime(event); if (start !== null && Math.abs(end - start) >= 1000) navigate({ range: "custom", from: Math.round(Math.min(start, end)), to: Math.round(Math.max(start, end)) }); start = null; });
      svg.addEventListener("pointercancel", () => { start = null; });
      svg.addEventListener("keydown", event => { if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || !points.length) return; event.preventDefault(); index = event.key === "Home" ? 0 : event.key === "End" ? points.length - 1 : Math.max(0, Math.min(points.length - 1, index + (event.key === "ArrowRight" ? 1 : -1))); allInspect(points[index].at); });
      const actions = el("div", undefined, "ops-links"), filename = String(series.id || "metric").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100);
      actions.append(button("Export CSV", () => exportFile(chartCsv(series, points, window, resolution, bounded.aggregated), "text/csv;charset=utf-8", filename + ".csv")), button("Export SVG", () => { const clone = svg.cloneNode(true); clone.setAttribute("xmlns", "http://www.w3.org/2000/svg"); clone.setAttribute("width", String(width)); clone.setAttribute("height", "236"); const style = sv("style", {}, "svg{background:#0d141b}text{fill:#a9bbc8;font:12px Arial}.ops-grid-line{stroke:#29465b}.ops-metric-line{fill:none;stroke:#8fd6ff;stroke-width:2}.ops-metric-point{fill:#8fd6ff}.ops-range-band{fill:#8fd6ff;opacity:.18}.ops-threshold{stroke:#f6c177;stroke-dasharray:6 5}.ops-threshold-critical{stroke:#f39baf}.ops-event-line{stroke:#a9bbc8;stroke-dasharray:2 4}.ops-crosshair{display:none}"); clone.insertBefore(style, clone.firstChild); exportFile(new root.XMLSerializer().serializeToString(clone), "image/svg+xml", filename + ".svg"); })); card.append(actions);
      const data = el("details"); data.setAttribute("data-page-filter-skip", ""); data.append(el("summary", "Data table · " + points.length + " displayed points"), table(["Time", "Value", "Minimum", "Maximum", "Quality", "Samples"], points.map(point => [when(point.at), number(point.value, series.unit), number(point.min, series.unit), number(point.max, series.unit), point.quality, point.count]))); card.append(data);
      card.append(p(valid.length + " of " + points.length + " displayed points valid. Displayed validity is separate from complete collection coverage.")); return card;
    }
    async function charts(ids, catalog, events = []) {
      if (!ids.length) return notice("No metric series are configured for this application. Configure Operations before collecting.");
      const data = await read("query", { series: ids.slice(0, 8).join(","), from: window.from, to: window.to }); if (data.unavailable) return unavailable(data, "Metric history");
      const grid = el("div", undefined, "ops-chart-grid"); list(data.series).slice(0, 8).forEach(series => grid.append(chart({ ...catalog.find(item => item.id === series.id), ...series, intervalSeconds: Number(data.displayIntervalMs) > 0 ? data.displayIntervalMs / 1000 : series.intervalSeconds }, data.resolution, events))); if (!grid.childNodes.length) grid.append(notice("No metric observations exist in the selected interval.")); return grid;
    }
    const attention = item => ["critical", "warning", "failed", "error", "unknown", "stale"].includes(item.state || item.status);
    const hostChoices = rows => [["", "All hosts"], ...rows.map(item => [item.id, item.label || item.id])];
    function eventTable(data) { const result = data.unavailable ? unavailable(data, "Event timeline") : table(["Time", "Type", "Host", "Summary", "Evidence"], list(data.events).map(item => [when(item.at || item.observedAt), item.type, item.host, item.summary, details(item)])); if (data.truncated) return append(el("div"), [notice("Only the most recent 100 events in this interval are displayed. Narrow the interval to inspect additional evidence; this is not complete history.", true), result]); return result; }
    function incidentTable(items) { return table(["Incident", "Host / check", "State", "Updated", "Acknowledgment"], list(items).map(item => [link(item.title || item.id, "/incidents", { incident: item.id, episodeCursor: undefined }), append(el("div"), [link(item.host, "/infrastructure", { host: item.host }), el("br"), link(item.checkId, "/services", { host: item.host, check: item.checkId })]), badge(item.status), when(item.updatedAt || item.openedAt), item.acknowledgedAt ? append(el("div"), [when(item.acknowledgedAt), p(item.acknowledgedBy)]) : item.acknowledgment ? when(item.acknowledgment.at) : "Not acknowledged"])); }
    function runTable(rows) { return table(["Run", "Execution", "Started", "Progress", "Finished", "Provenance"], list(rows).map(item => [item.id || item.runId, badge(item.executionState || item.status), when(item.startedAt), when(item.lastProgressAt), when(item.finishedAt), details({ scheduledFor: item.scheduledFor, attempt: item.attempt, executionIdentity: item.executionIdentity, definitionRevision: item.definitionRevision, schedulerRef: item.schedulerRef, provenance: item.provenance, evidence: item.evidence, receivedAt: item.receivedAt })])); }
    async function infrastructure() {
      const [data, checks, catalog] = await Promise.all([read("resources"), read("checks"), read("series")]); if (data.unavailable) { board.append(unavailable(data, "Infrastructure")); return; }
      const all = list(data.resources), matches = item => q.filter === "attention" ? attention(item) : q.filter === "reporting" ? item.state !== "unknown" : q.filter === "unknown" ? item.state === "unknown" : true, rank = { critical: 0, unknown: 1, warning: 2, healthy: 3 }, visible = all.filter(item => (!q.host || item.id === q.host) && matches(item)).sort((a, b) => (rank[a.state] ?? 1) - (rank[b.state] ?? 1) || text(a.label || a.id).localeCompare(text(b.label || b.id)));
      board.append(asOf(data), cards([["Registered hosts", all.length, route, { filter: undefined, host: undefined }], ["Needs attention", all.filter(attention).length, route, { filter: "attention", host: undefined }], ["Reporting hosts", all.filter(item => item.state !== "unknown").length, route, { filter: "reporting", host: undefined }], ["Unknown hosts", all.filter(item => item.state === "unknown").length, route, { filter: "unknown", host: undefined }]]), filterForm([["Host", "host", hostChoices(all)], ["Show", "filter", [["", "All hosts"], ["attention", "Needs attention"], ["reporting", "Reporting"], ["unknown", "Unknown"]]]]));
      if (!all.length) board.append(notice("No hosts are registered. Configure the private Operations registry and connect an authenticated monitor source before collecting."), link("Configure Operations", "/docs", { section: "66-native-monitoring-and-operations" }));
      board.append(panel("Host inventory", table(["Host", "Measured state", "Collection quality", "Last observed", "Last received", "Evidence"], visible.map(item => [link(item.label || item.id, route, { host: item.id }), badge(item.state), badge(item.quality), when(item.lastObservedAt), when(item.lastReceivedAt), details({ collection: item.collection, metrics: item.metrics })]))));
      for (const item of visible) board.append(panel(item.label || item.id, table(["Metric", "Value", "Measured state", "Quality", "Observed"], list(item.metrics).map(metric => [link(metric.label || metric.id, "/metrics", { host: item.id, series: metric.id, check: undefined }), metric.quality && metric.quality !== "good" ? "Unknown" : number(metric.value, metric.unit), badge(metric.state), badge(metric.quality), when(metric.observedAt)]), "No capacity observations are recorded."), links([["Host services", "/services", { host: item.id, check: undefined }], ["Host source logs", "/logs", { host: item.id }], ["Leave employee instructions", "/employees", { host: item.id, incident: undefined, check: undefined, job: undefined, endpoint: undefined }]])));
      const visibleHosts = new Set(visible.map(item => item.id)), metrics = list(catalog.series).filter(item => visibleHosts.has(item.host));
      if (catalog.unavailable) board.append(unavailable(catalog, "Metric catalog")); else if (metrics.length) board.append(await charts(metrics.slice(0, 4).map(item => item.id), metrics));
      const selected = all.find(item => item.id === q.host);
      if (q.host && !selected) board.append(notice("That host is not registered in this application.", true));
      if (selected) board.append(panel(selected.label || selected.id, facts([["Measured condition", badge(selected.state)], ["Observation quality", badge(selected.quality)], ["Age", number(selected.ageSeconds, "seconds")], ["Source", selected.sourceId]]), links([["Service checks", "/services", { host: selected.id }], ["Metric history", "/metrics", { host: selected.id }], ["Incidents", "/incidents", { host: selected.id, incident: undefined, incidentCursor: undefined }], ["Source logs", "/logs", { host: selected.id }], ["Leave employee instructions", "/employees", { host: selected.id }]]), details(selected)));
      board.append(panel("Current checks", checks.unavailable ? unavailable(checks, "Checks") : table(["Check", "Host", "Measured state", "Summary", "Observed"], list(checks.checks).filter(item => !q.host || item.host === q.host).map(item => [link(item.label || item.id, "/services", { check: item.id, host: item.host }), item.host, badge(item.status), item.summary, when(item.lastObservedAt)]))));
    }
    async function services() {
      const [data, resources, dependencies, incidents, catalog] = await Promise.all([read("checks"), read("resources"), read("dependencies"), read("incidents", { host: q.host, limit: 100 }), read("series")]);
      if (data.unavailable) { board.append(unavailable(data, "Service checks")); return; }
      const all = list(data.checks), selected = all.find(item => item.id === q.check && (!q.host || item.host === q.host)), rows = all.filter(item => (!q.host || item.host === q.host) && (!q.check || item.id === q.check) && (!q.filter || item.status === q.filter));
      board.append(asOf(data), filterForm([["Host", "host", hostChoices(list(resources.resources))], ["Check", "check", [["", "All checks"], ...all.filter(item => !q.host || item.host === q.host).map(item => [item.id, item.label || item.id])]], ["State", "filter", [["", "All states"], ...["healthy", "warning", "critical", "unknown"].map(value => [value, value])]]]), panel("Service checks", table(["Check", "Host", "State", "Summary", "Observed"], rows.map(item => [link(item.label || item.id, route, { check: item.id, host: item.host }), item.host, badge(item.status), item.summary, when(item.lastObservedAt)]), "No configured checks match these filters.")));
      if (q.check && !selected) board.append(notice("That check is not registered within this host and application.", true));
      if (selected) {
        board.append(panel(selected.label || selected.id, p(selected.summary || "No observation received."), links([["Host infrastructure", "/infrastructure", { host: selected.host }], ["Matching incidents", "/incidents", { host: selected.host, check: selected.id, incident: undefined, incidentCursor: undefined }], ["Host source logs", "/logs", { host: selected.host }], ["Leave employee instructions", "/employees", { host: selected.host, check: selected.id, incident: undefined }]]), details(selected)));
        const series = list(catalog.series).filter(item => item.id === selected.id || item.id === selected.seriesId || item.checkId === selected.id); if (series.length) board.append(await charts(series.map(item => item.id), series));
      }
      board.append(panel("Dependency evidence", dependencies.unavailable ? unavailable(dependencies, "Dependencies") : table(["Dependent check", "Prerequisite", "Relationship", "Related incident"], list(dependencies.dependencies).filter(item => (!q.host || item.host === q.host) && (!q.check || item.checkId === q.check || item.prerequisiteCheckId === q.check)).map(item => [link(item.checkId, "/services", { host: item.host, check: item.checkId }), link(item.prerequisiteCheckId, "/services", { host: item.host, check: item.prerequisiteCheckId }), item.reason || item.relationship, item.parentIncidentId ? link("Prerequisite incident", "/incidents", { incident: item.parentIncidentId, host: undefined, check: undefined, state: "all", incidentCursor: undefined, episodeCursor: undefined }) : "No linked incident"]))), panel("Related incidents", incidents.unavailable ? unavailable(incidents, "Incidents") : incidentTable(list(incidents.incidents).filter(item => (!q.host || item.host === q.host) && (!q.check || item.checkId === q.check))), p("This related view is bounded. Open Incidents for retained history and pagination.")));
    }
    async function websites() {
      const [data, checks, historyData, incidents] = await Promise.all([read("websites"), read("checks"), read("website-history", { from: window.from, to: window.to }), read("incidents", { host: q.host, limit: 100 })]);
      if (data.unavailable) board.append(unavailable(data, "Website inventory"));
      const all = list(data.websites), selected = all.find(item => (item.id === q.endpoint || item.url === q.endpoint) && (!q.host || item.host === q.host)), visible = all.filter(item => (!q.host || item.host === q.host) && (!q.endpoint || item === selected));
      if (!data.unavailable) board.append(asOf(data), panel("Endpoint observations", table(["Endpoint", "State", "HTTP", "Response", "Certificate expires", "Observed"], visible.map(item => [append(el("div"), [link(item.label || item.id || item.url, route, { endpoint: item.id || item.url, host: item.host }), p(item.url), p(item.summary)]), badge(item.state), item.statusCode ?? item.status ?? "Unknown", number(item.responseMs ?? item.ms, "ms"), when(item.certificateExpiresAt || item.certNotAfter), when(item.lastObservedAt)]), "No endpoints are configured within this scope.")), links([["All endpoints", route, { endpoint: undefined, series: undefined }], ["Configure Operations", "/docs", { section: "66-native-monitoring-and-operations" }]]));
      if (q.endpoint && !selected && !data.unavailable) board.append(notice("That endpoint is not configured in this application.", true));
      if (selected) {
        const exact = list(checks.checks).filter(item => item.endpointId === selected.id || (list(selected.checkIds).includes(item.id)) || item.id === selected.checkId);
        board.append(panel("Endpoint evidence", details(selected), links([["Host source logs", "/logs", { host: selected.host, sourceId: selected.sourceId }], ["Leave employee instructions", "/employees", { host: selected.host, endpoint: selected.id || selected.url, check: exact[0]?.id, incident: undefined }]])));
        board.append(panel("Matching incidents", incidents.unavailable ? unavailable(incidents, "Endpoint incidents") : exact.length ? incidentTable(list(incidents.incidents).filter(item => exact.some(check => check.id === item.checkId))) : notice("This endpoint has no native check identifier. Incident associations cannot be inferred from its URL.")));
      }
      if (historyData.unavailable) { board.append(unavailable(historyData, "Probe history")); return; }
      const matches = item => (!q.host || item.host === q.host || selected?.url === item.url) && (!q.endpoint || selected?.url === item.url || selected?.id === item.endpointId);
      board.append(panel("Probe history and collection coverage", table(["Endpoint", "Received probes", "Succeeded / failed", "Observed success", "Observed / expected slots", "Coverage", "Observed history"], list(historyData.coverage).filter(matches).map(item => [item.url, item.observations, text(item.successes) + " / " + text(item.failures), number(item.observedSuccessPercent, "%"), text(item.observedSlots) + " / " + text(item.expectedSlots), number(item.coveragePercent, "%"), append(el("div"), [when(item.firstObservedAt), el("br"), when(item.lastObservedAt)])])), p("Observed success is conditional on received probes. Missing collection slots remain unknown; they are not successful uptime.")));
      const grid = el("div", undefined, "ops-chart-grid"); list(historyData.series).filter(item => matches(item) && (!q.series || item.id === q.series)).slice(0, 8).forEach(item => grid.append(chart(item, historyData.resolution || "raw"))); if (grid.childNodes.length) board.append(grid);
    }
    async function metrics() {
      const [data, resources, events] = await Promise.all([read("series"), read("resources"), read("events", { all: "1", host: q.host, from: window.from, to: window.to, limit: 100 })]); if (data.unavailable) { board.append(unavailable(data, "Metric catalog")); return; }
      const catalog = list(data.series).filter(item => !q.host || item.host === q.host), requested = String(q.series || "").split(",").filter(Boolean), selected = requested.length ? requested.filter(id => catalog.some(item => item.id === id)).slice(0, 8) : catalog.slice(0, 4).map(item => item.id);
      board.append(filterForm([["Host", "host", hostChoices(list(resources.resources))]]));
      const picker = el("form", undefined, "ops-picker"), inputs = [], feedback = p(""); picker.append(el("h2", "Select up to eight metrics"));
      catalog.forEach(item => { const label = el("label"), input = el("input"); input.type = "checkbox"; input.value = item.id; input.checked = selected.includes(item.id); input.addEventListener("change", () => { if (inputs.filter(node => node.checked).length > 8) { input.checked = false; feedback.textContent = "Select up to eight metrics."; } else feedback.textContent = ""; }); inputs.push(input); append(label, [input, el("span", (item.host ? item.host + " · " : "") + (item.label || item.id) + " · " + (item.unit || "units"))]); picker.append(label); });
      const submit = el("button", "Show selected metrics"); submit.type = "submit"; picker.append(submit, feedback); picker.addEventListener("submit", event => { event.preventDefault(); const ids = inputs.filter(input => input.checked).map(input => input.value); if (!ids.length) { feedback.textContent = "Choose at least one metric."; return; } navigate({ series: ids.join(",") }); }); board.append(picker);
      if (requested.some(id => !catalog.some(item => item.id === id))) board.append(notice("Some requested series are not registered in the selected host and application.", true));
      board.append(await charts(selected, catalog, events.events), panel("Events within the selected interval", eventTable(events)));
    }
    function notificationControls(data, selectedIncident = false) {
      if (data.unavailable) return unavailable(data, "Notification transport");
      if (!data.transport) return notice("Notification delivery status is unavailable; inspect the retained delivery evidence.");
      const transport = data.transport, node = panel("Notification transport",
        facts([["Provider", transport.provider], ["Sending", transport.enabled ? "Enabled" : transport.paused ? "Paused" : "Disabled in external configuration"],
          ["Request limit", text(transport.hourlySendCap) + " per hour"], ["Automatic retry limit", text(transport.automaticRetryWindowHours) + " hours"]]),
        p(transport.provider === "smtp" ? "SMTP relay acceptance does not prove inbox delivery. SMTP has no idempotency guarantee; uncertain DATA acceptance requires reconciliation." : "Resend retries preserve the original provider idempotency key."),
        p("Provider acceptance does not prove inbox delivery. A pause stops future requests, including retries; an already submitted request can still complete."),
        transport.error ? notice(transport.error, true) : null);
      if (transport.configured && Number.isSafeInteger(transport.revision) && !selectedIncident) node.append(mutation(
        transport.paused ? "Resume notification delivery" : "Pause notification delivery", "notifications/pause",
        { paused: !transport.paused, expectedRevision: transport.revision },
        [["reason", "Decision reason", "textarea", "", [], 1000]], transport.paused ? "Resume for this application" : "Pause for this application",
        "This control applies to every configured host and recipient in the selected application. The request and its reason are retained."));
      const attempts = list(data.attempts);
      node.append(table(["Destination", "State", "Requests", "Last update", "Incident", "Evidence"], attempts.map(item => [
        item.destination, badge(item.state), item.requestCount, when(item.updatedAt),
        link("Open incident", "/incidents", { incident: item.incidentId, host: item.host, check: undefined, state: "all", incidentCursor: undefined }), details(item)
      ]), "No provider attempts are retained for this view."));
      if (data.attemptsTruncated) node.append(notice("Showing the latest 100 attempts. Select an incident to narrow the retained evidence."));
      if (selectedIncident) for (const item of attempts.filter(item => item.active && item.state === "needs-reconciliation").slice(0, 20)) {
        const fixed = { attemptId: item.id, expectedRevision: item.revision };
        node.append(panel("Reconcile " + item.destination, p("Attempt " + item.id + ". Inspect the provider record before making a decision. Stored messages and destinations cannot be edited here."),
          item.exactRetryAllowed === false ? notice("Exact SMTP retry is blocked because DATA acceptance is uncertain. Verify the relay record or explicitly accept duplicate risk for a fresh request.", true) : mutation("Retry the exact request", "notifications/reconcile", { ...fixed, action: "retry-exact" },
            [["reason", "Evidence and retry reason", "textarea", "", [], 1000]], "Retry exact request",
            "Uses the same frozen message. SMTP retry requires proof of nonacceptance; Resend retains its provider key. The server rejects changed credentials or an expired retry limit."),
          mutation("Record verified provider acceptance", "notifications/reconcile", { ...fixed, action: "confirm-accepted" },
            [["providerId", "Verified provider email ID", "text", "", [], 200], ["acceptedAt", "Provider acceptance timestamp (RFC 3339)", "text", "", [], 50],
              ["reason", "Where acceptance was verified", "textarea", "", [], 1000]], "Record provider acceptance",
            "Use a provider acceptance record, not a guess or evidence that an API request started."),
          mutation("Create a fresh request", "notifications/reconcile", { ...fixed, action: "requeue-fresh", duplicateRiskAccepted: true },
            [["reason", "Evidence and reason accepting possible duplicate mail", "textarea", "", [], 1000]], "Requeue and accept duplicate-mail risk",
            "A fresh request may send duplicate mail if an earlier request was accepted. SMTP Message-ID is retained for evidence and does not guarantee deduplication. The message and earlier attempts remain retained.")));
      }
      if (list(data.decisions).length) node.append(details(data.decisions, "Recent operator decisions"));
      return node;
    }
    function findingNotificationControls(data) {
      if (data.unavailable) return unavailable(data, "Finding notification transport");
      const node = panel("Finding email",
        facts([["Provider", data.provider || "Not configured"], ["Sending", data.enabled ? "Enabled" : data.paused ? "Paused" : "Disabled in external configuration"]]),
        p("These notices reference canonical findings and their source. They use a separate queue and pause control from native incident mail. Relay acceptance does not prove inbox delivery."),
        data.error ? notice(data.error, true) : null, details(data.filters || {}, "Reviewed severity, rule and source filters"));
      if (data.configured && Number.isSafeInteger(data.revision)) node.append(mutation(
        data.paused ? "Resume finding email" : "Pause finding email", "finding-notifications/pause",
        { paused: !data.paused, expectedRevision: data.revision },
        [["reason", "Decision reason", "textarea", "", [], 1000]], data.paused ? "Resume finding email" : "Pause finding email",
        "Pausing stops new delivery requests. An in-flight request can still complete; all pending messages remain retained."));
      if (data.verificationAvailable) node.append(mutation("Verify SMTP connection", "finding-notifications/verify", {},
        [["reason", "Commissioning reason", "textarea", "", [], 1000]], "Verify connection without sending mail",
        "Checks connection, verified TLS and authentication only. It sends no DATA and does not prove sender authorization or inbox delivery."));
      if (data.verification) node.append(panel("Latest SMTP connection check", data.verification.pending ? notice("Connection check outcome is pending; retry the same decision to inspect an interrupted check.") :
        notice(data.verification.verified ? "Connection, TLS and authentication verified. No mail was sent." : "SMTP connection verification failed. Inspect the configured server and credential file.", !data.verification.verified),
        when(data.verification.at || data.verification.startedAt), details(data.verification)));
      if (data.testSendAvailable) node.append(mutation("Send a requested test email", "finding-notifications/test-send", {},
        [["recipient", "Explicit reviewed recipient", "email", "", [], 320], ["reason", "Why this real email is requested", "textarea", "", [], 1000]], "Queue real test email",
        "This sends real mail to the exact recipient you enter. The server requires membership in the reviewed destination list. A paused queue retains it until resumed."));
      node.append(table(["Destination", "Kind", "Finding", "State", "Requests", "Updated", "Evidence"], list(data.attempts).map(item => [
        item.destination, item.kind, item.recordId || "Commissioning check", badge(item.state), item.requestCount, when(item.updatedAt), details(item)
      ]), "No finding email attempts are retained for this application."));
      if (data.truncated) node.append(notice("Showing the latest 100 retained attempts. Earlier attempts remain in private storage."));
      for (const item of list(data.attempts).filter(item => item.active && item.state === "needs-reconciliation").slice(0, 20)) {
        const fixed = { attemptId: item.id, expectedRevision: item.revision };
        node.append(panel("Reconcile finding email to " + item.destination, p("Attempt " + item.id + ". Inspect the relay or provider record before deciding."),
          item.exactRetryAllowed === false ? notice("SMTP DATA acceptance is uncertain. Automatic and exact retries are blocked; verify acceptance or explicitly accept duplicate-mail risk.", true) :
            mutation("Retry exact finding email", "finding-notifications/reconcile", { ...fixed, action: "retry-exact" },
              [["reason", "Evidence that permits this retry", "textarea", "", [], 1000]], "Retry exact finding email",
              "Retains the frozen message and server identity. The server rejects unsafe SMTP replay, changed credentials and expired retry windows."),
          mutation("Record verified finding email acceptance", "finding-notifications/reconcile", { ...fixed, action: "confirm-accepted" },
            [["providerId", "Verified relay or provider acceptance ID", "text", "", [], 200], ["acceptedAt", "Acceptance timestamp (RFC 3339)", "text", "", [], 50],
              ["reason", "Where acceptance was verified", "textarea", "", [], 1000]], "Record verified acceptance",
            "Use an acceptance record. Connection success and a submitted DATA command alone do not prove acceptance."),
          mutation("Requeue finding email with duplicate risk", "finding-notifications/reconcile", { ...fixed, action: "requeue-fresh", duplicateRiskAccepted: true },
            [["reason", "Evidence and reason accepting duplicate mail", "textarea", "", [], 1000]], "Requeue and accept duplicate-mail risk",
            "This can send a duplicate if the earlier request was accepted. SMTP Message-ID is retained as evidence and cannot guarantee deduplication. Earlier attempts remain retained.")));
      }
      if (list(data.decisions).length) node.append(details(data.decisions, "Finding email operator decisions"));
      return node;
    }
    async function incidents() {
      const [historyData, resources, checks, notificationStatus, findingStatus] = await Promise.all([read("incidents", { view: "history", state: ["all", "open", "resolved"].includes(q.state) ? q.state : "open", host: q.host, checkId: q.check, limit: 50, cursor: q.incidentCursor }), read("resources"), read("checks"), read("notifications"), read("finding-notifications")]);
      if (cursor(historyData.page?.currentCursor)) q.incidentCursor = historyData.page.currentCursor;
      board.append(filterForm([["Host", "host", hostChoices(list(resources.resources))], ["Check", "check", [["", "All checks"], ...list(checks.checks).filter(item => !q.host || item.host === q.host).map(item => [item.id, item.label || item.id])]], ["State", "state", [["open", "Open"], ["resolved", "Resolved"], ["all", "All retained"]]]], { ...q, state: q.state || "open" }));
      board.append(panel("Retained incidents", historyData.unavailable ? unavailable(historyData, "Incident history") : incidentTable(historyData.incidents), history(historyData, "incidentCursor", "Incident history", { incident: undefined, episodeCursor: undefined })));
      board.append(notificationControls(notificationStatus), findingNotificationControls(findingStatus));
      if (!q.incident) return;
      const exact = await read("incidents", { incidentId: q.incident, host: q.host }); if (exact.unavailable || !exact.incident) { board.append(unavailable(exact, "Selected incident")); return; }
      if (q.host && exact.incident.host !== q.host || q.check && exact.incident.checkId !== q.check) { board.append(notice("That incident does not match the selected host and check filters. Its detail and actions have not been displayed.", true)); return; }
      const item = exact.incident, episodeId = item.lifecycle?.episodeId || item.episodeId;
      if (item.notificationEnabled === false) board.append(notice("Future notification requests are paused or disabled. Retained attempts may include earlier provider acceptance or an uncertain request."));
      const [events, deliveries, episode] = await Promise.all([read("events", { all: "1", ...(episodeId ? { episodeId } : { incidentId: item.id }), limit: 100, from: window.from, to: window.to }), read("notifications", { incidentId: item.id, limit: 100 }), episodeId ? read("incidents", { view: "history", state: "all", episodeId, cursor: q.episodeCursor, limit: 50 }) : Promise.resolve(null)]);
      if (cursor(episode?.page?.currentCursor)) q.episodeCursor = episode.page.currentCursor;
      board.append(panel(item.title || item.id, facts([["Lifecycle", badge(item.status)], ["Severity", badge(item.severity)], ["Opened", when(item.openedAt)], ["Resolved", when(item.resolvedAt)], ["Acknowledgment", item.acknowledgedAt ? append(el("div"), [when(item.acknowledgedAt), p(item.acknowledgedBy)]) : item.acknowledgment ? details(item.acknowledgment) : "Not acknowledged"], ["Latest evidence", when(item.updatedAt)]]), p("Acknowledgment records an operator decision. Measured recovery and notification delivery remain separate."), links([["Current check evidence", "/services", { host: item.host, check: item.checkId }], ["Host infrastructure", "/infrastructure", { host: item.host }], ["Source logs", "/logs", { host: item.host }], ["Leave employee instructions", "/employees", { incident: item.id, host: item.host, check: item.checkId }]]), details(item)));
      const lifecycle = item.lifecycle || {};
      board.append(panel("Operational context", facts([["Episode", episodeId || item.id], ["Occurrence", text(lifecycle.generation || 1) + (lifecycle.recurrence ? " · recurring condition" : "")], ["Condition", item.conditionKind], ["Maintenance", lifecycle.maintenance ? "Active maintenance window" : "No active maintenance window"]]), details(item.declaredDependencies || [], "Declared dependencies"), lifecycle.parentIncidentId ? links([["Prerequisite incident", "/incidents", { incident: lifecycle.parentIncidentId, host: undefined, check: undefined, state: "all", incidentCursor: undefined, episodeCursor: undefined }]]) : p("No prerequisite incident linked.")));
      const metricCheck = list(checks.checks).find(check => check.id === item.checkId && check.type === "metric");
      if (metricCheck) board.append(links([["Metric and recovery history", "/metrics", { host: item.host, check: item.checkId, series: item.checkId }]]));
      if (stamp(item.resolvedAt) !== null) board.append(links([["Recovery interval", "/incidents", { incident: item.id, range: "custom", from: Math.max(0, stamp(item.resolvedAt) - 3600000), to: Math.min(Date.now(), stamp(item.resolvedAt) + 3600000), state: "all", incidentCursor: undefined }]]));
      if (item.revision && item.status !== "resolved") board.append(mutation("Acknowledge incident", "incidents/ack", { incidentId: item.id, expectedRevision: item.revision }, [["note", "Decision note", "textarea", "", [], 1000]], "Record acknowledgment", "The revision protects this decision from silently overwriting a newer incident state."));
      if (item.host) board.append(mutation("Schedule maintenance", "maintenance", { host: item.host, ...(item.checkId ? { checkId: item.checkId } : {}) }, [["durationMinutes", "Duration in minutes", "number", "60"], ["reason", "Maintenance reason", "textarea", "", [], 1000]], "Record maintenance", "Maintenance does not remove measurements, resolve incidents, or prove recovery."));
      if (episode) board.append(panel("Episode occurrences", episode.unavailable ? unavailable(episode, "Episode history") : incidentTable(episode.incidents), history(episode, "episodeCursor", "Episode occurrences", { incident: item.id })));
      board.append(notificationControls(deliveries, true));
      board.append(panel("Incident timeline within the interval", eventTable(events)), panel("Notification delivery ledger", deliveries.unavailable ? unavailable(deliveries, "Notification deliveries") : table(["Event", "Destination", "Role", "State", "Provider accepted", "Evidence"], list(deliveries.deliveries).map(delivery => [delivery.eventId, delivery.destination, delivery.role, badge(delivery.status || delivery.state), when(delivery.acceptedAt), details(delivery)])), p("Provider acceptance does not prove inbox delivery. Notifications are tracked separately for each recipient.")));
    }
    const jobAttention = item => item.observationState === "stale" || ["error", "failed"].includes(item.observationQuality) || ["failed", "stalled", "overdue", "never_started", "overlap"].includes(item.executionState) || ["overdue", "missed", "never_started"].includes(item.scheduleState) || item.outputState === "failed";
    function jobReason(item) { if (item.observationState === "stale" || ["error", "failed"].includes(item.observationQuality)) return "Observer evidence needs review; earlier success cannot establish current health."; if (jobAttention(item)) return "Execution, schedule, or output verification needs review."; if (item.executionState === "succeeded" && item.outputState !== "verified") return "Command succeeded; its output is not verified."; if (item.health === "healthy") return "Recorded execution, output proof, and schedule observation meet configured checks."; return "Inspect execution, scheduler coverage, and output proof independently."; }
    async function jobs() {
      const data = await read("jobs"); if (data.unavailable) { board.append(unavailable(data, "Critical jobs")); return; }
      const all = list(data.jobs), hostFiltered = all.filter(item => (!q.host || item.host === q.host) && (!q.jobSearch || [item.id, item.label, item.host].join(" ").toLowerCase().includes(q.jobSearch.toLowerCase()))), rows = hostFiltered.filter(item => q.status === "attention" ? jobAttention(item) : q.status === "unverified" ? item.outputState !== "verified" : ["running", "failed"].includes(q.status) ? item.executionState === q.status : true);
      board.append(asOf(data), notice("Execution, schedule, and output verification are separate. A successful command does not prove a backup is restorable or a scan covered every target."), cards([["Registered jobs", hostFiltered.length, route, { status: "all", job: undefined, runCursor: undefined }], ["Needs attention", hostFiltered.filter(jobAttention).length, route, { status: "attention", job: undefined, runCursor: undefined }], ["Output unverified", hostFiltered.filter(item => item.outputState !== "verified").length, route, { status: "unverified", job: undefined, runCursor: undefined }]]), filterForm([["Host", "host", [["", "All hosts"], ...[...new Set(all.map(item => item.host))].map(host => [host, host])]], ["Show", "status", [["all", "All jobs"], ["attention", "Needs attention"], ["unverified", "Output unverified"], ["running", "Running"], ["failed", "Execution failed"]]], ["Find job", "jobSearch"]]));
      if (data.truncated) board.append(notice("Job inventory exceeds this bounded view; narrow the configured application inventory.", true));
      let selected = all.find(item => item.id === q.job && (!q.host || item.host === q.host));
      if (q.job && !selected) { const exact = await read("jobs", { detail: q.job }); selected = list(exact.jobs).find(item => item.id === q.job && (!q.host || item.host === q.host)); if (exact.unavailable) board.append(unavailable(exact, "Selected job")); }
      if (selected) {
        const item = selected, [runs, related] = await Promise.all([read("jobs", { history: item.id, limit: 30, cursor: q.runCursor }), read("incidents", { host: item.host, limit: 100 })]); if (cursor(runs.page?.currentCursor)) q.runCursor = runs.page.currentCursor;
        board.append(panel(item.label || item.id, p(jobReason(item)), facts([["Host", item.host], ["Execution", badge(item.executionState)], ["Schedule", badge(item.scheduleState)], ["Output", badge(item.outputState)], ["Observer", append(el("div"), [badge(item.observationState), badge(item.observationQuality)])], ["Timezone", item.schedule?.timeZone || item.timeZone], ["Next due", when(item.nextDueAt)]]), details(item, "Schedule, execution and observer evidence"), links([["Host infrastructure", "/infrastructure", { host: item.host }], ["Job condition", "/services", { host: item.host, check: "operations.job." + item.id }], ["Host source logs", "/logs", { host: item.host }], ["Leave employee instructions", "/employees", { host: item.host, job: item.id }]])), panel("Execution history", runs.unavailable || runs.jobId !== item.id ? unavailable(runs, "Execution history") : runTable(runs.runs), history(runs, "runCursor", "Job execution history", { job: item.id })), panel("Related job incidents", related.unavailable ? unavailable(related, "Related incidents") : incidentTable(list(related.incidents).filter(incident => ["operations.job." + item.id, "operations.observer." + item.id].includes(incident.checkId)))));
      } else if (q.job) board.append(notice("That job is not configured within the selected host and application.", true));
      board.append(panel("Critical jobs", table(["Job", "Host", "What needs review", "Execution", "Schedule", "Output proof", "Next due"], rows.map(item => [link(item.label || item.id, route, { job: item.id, runCursor: undefined }), link(item.host, "/infrastructure", { host: item.host }), jobReason(item), badge(item.executionState), badge(item.scheduleState), badge(item.outputState), when(item.nextDueAt)]), all.length ? "No jobs match the current filters." : "No critical jobs have been registered.")));
    }
    async function resolvedContext(resources) {
      const result = { host: null, check: null, job: null, incident: null, endpoint: null, invalid: false, references: [] };
      if (q.host) { result.host = list(resources.resources).find(item => item.id === q.host)?.id || null; if (!result.host) result.invalid = true; }
      const selectors = [["check", "checks", "checks"], ["job", "jobs", "jobs"], ["incident", "incidents", "incident"], ["endpoint", "websites", "websites"]];
      await Promise.all(selectors.map(async ([key, endpoint, property]) => { if (!q[key]) return; const data = await read(endpoint, key === "job" ? { detail: q.job } : key === "incident" ? { incidentId: q.incident } : {}); result[key] = (property === "incident" ? data.incident ? [data.incident] : [] : list(data[property])).find(item => item.id === q[key] || (key === "endpoint" && item.url === q[key])) || null; if (!result[key]) result.invalid = true; }));
      const records = [result.check, result.job, result.incident, result.endpoint].filter(Boolean), hosts = [...new Set(records.map(item => item.host).filter(Boolean))];
      if (hosts.length > 1 || (result.host && hosts.some(host => host !== result.host)) || (result.check && result.incident && result.incident.checkId !== result.check.id) || (q.host && !result.host)) { result.invalid = true; result.check = result.job = result.incident = result.endpoint = null; }
      else if (!result.host && hosts.length === 1 && list(resources.resources).some(item => item.id === hosts[0])) result.host = hosts[0];
      if (result.host) result.references.push(["Host", result.host, "/infrastructure", { host: result.host }]);
      for (const [key, target, label] of [["check", "/services", "Check"], ["job", "/jobs", "Job"], ["incident", "/incidents", "Incident"], ["endpoint", "/websites", "Endpoint"]]) if (result[key]) result.references.push([label, result[key].id || result[key].url, target, { host: result[key].host, [key]: result[key].id || result[key].url }]);
      return result;
    }
    function report(employee) {
      const output = employee.lastOutput, assessment = employee.latestAssessment;
      return panel(employee.name || employee.id, p(employee.role || "Registered employee"), facts([["Employee", employee.id], ["Execution", badge(employee.executionState)], ["Schedule", badge(employee.scheduleState)], ["Report freshness", badge(employee.outputFreshness)], ["Scheduler evidence", employee.schedulerRef || "Not verified"]]), el("h3", "Latest received report"), output ? append(el("div"), [p(output.summary || "A report was received. Inspect its recorded provenance."), facts([["Reported", when(output.observedAt)], ["Received", when(output.receivedAt)]]), details(output, "Report and provenance")]) : notice("No report has been observed in this integrated feed."), p("A received report does not establish an execution start, instruction completion, or measured recovery."), el("h3", "Latest assessment"), p(typeof assessment === "string" ? assessment : assessment?.summary || "No assessment recorded."), assessment ? details(assessment, "Assessment evidence") : null, runTable(employee.runs), employee.historyTruncated ? notice("Only the most recent execution records are shown; older retained evidence is not included here.", true) : null, links([["Employee instructions and assignments", "/employees", { employee: employee.id }], ["Source and credential administration", "/agents"]]));
    }
    async function employees() {
      const offset = /^\d{1,4}$/.test(q.inboxOffset || "") ? Math.min(500, Number(q.inboxOffset)) : 0;
      const [data, resources, inbox] = await Promise.all([read("employees"), read("resources"), read("employee-inbox", { employeeId: q.employee, limit: 100, offset })]);
      if (data.unavailable) board.append(unavailable(data, "Employee execution inventory")); else board.append(asOf(data));
      const observed = list(data.employees), catalog = list(inbox.recipients).length ? inbox.recipients : observed, names = new Map(catalog.map(item => [item.id, item.name || item.id])), selected = observed.find(item => item.id === q.employee), summary = inbox.recipientSummary || {};
      board.append(notice("Employee assessments, instruction receipts, execution events, and measured health are independent evidence. Saving instructions does not launch an existing routine."), p("The roster and instruction history cover this application. Host context is used only for evidence handoffs and assignment targets."), links([["Analyst reports", "/analyst-reports"], ["Scheduled jobs", "/jobs"], ["Agent administration", "/agents"]]));
      if (data.integration) board.append(details(data.integration, "Execution reporting sources and coverage"));
      if (data.integration && (data.integration.quarantinedCount > 0 || data.integration.historyTruncated || data.integration.pendingCount > 0 || ["unavailable", "partial"].includes(data.integration.coverage) || data.integration.lastError)) board.append(notice("Employee reporting coverage is incomplete. Inspect source coverage before inferring execution or report completeness.", true));
      board.append(panel("Employee roster", table(["Employee", "Waiting", "Acknowledged", "Replies", "Latest read receipt", "Latest report received"], catalog.map(item => { const runtime = observed.find(employee => employee.id === item.id), counts = !inbox.unavailable && inbox.available === true ? summary[item.id] : null; return [link((item.name || item.id) + " · " + item.id, route, { employee: item.id, inboxOffset: undefined }), counts?.waiting ?? "Unavailable", counts?.acknowledged ?? "Unavailable", counts?.replies ?? "Unavailable", when(counts?.lastAcknowledgment?.at), when(runtime?.lastOutput?.receivedAt)]; }), "No employees are configured. Add an adopter-owned roster to the private Operations registry."), p("Counts cover retained instructions and earlier receipts on withdrawn messages. A receipt proves the instruction was marked read by the attributed account; it does not prove completion."), links([["All employees", route, { employee: undefined, inboxOffset: undefined }]])));
      if (route === "/analyst-reports") { if (!data.unavailable) { const rows = q.employee ? selected ? [selected] : [] : observed; rows.forEach(item => board.append(report(item))); if (!rows.length) board.append(notice(q.employee ? "That employee is not in this reporting inventory." : "No reports or employee execution records have been received.")); } return; }
      if (selected) board.append(report(selected)); else if (q.employee) board.append(notice("That employee is not available in the execution inventory. Instruction receipts remain independently available.", true));
      const context = await resolvedContext(resources);
      const instructionPanel = panel("Instructions for the next visit"); board.append(instructionPanel);
      if (context.invalid) instructionPanel.append(notice("Some requested source context could not be verified. Only resolved, consistent references are included below; no other source association has been assumed.", true));
      if (context.references.length) instructionPanel.append(links(context.references.map(([label, id, target, params]) => [label + ": " + id, target, params])));
      if (inbox.unavailable || inbox.available !== true) instructionPanel.append(unavailable(inbox, "Employee instructions"), p("Adding and withdrawing instructions is disabled until retained messages can be loaded."));
      else {
        if (catalog.length) {
          const first = [...context.references].reverse()[0], initialTitle = first ? ("Review " + first[0].toLowerCase() + ": " + first[1]).slice(0, 160) : "", initialBody = context.references.length ? context.references.map(([label, id, target, params]) => label + ": " + id + "\nEvidence: " + contextUrl(target, { appId: q.appId }, window, params)).join("\n") + "\n\nInspect this evidence, record your assessment and any action taken, and identify verification evidence. A reply does not resolve the measured condition." : "";
          instructionPanel.append(mutation("Leave instructions", "employee-inbox/create", {}, [["recipient", "For", "select", names.has(q.employee) ? q.employee : "", [["", "Choose an employee"], ...catalog.map(item => [item.id, item.name || item.id]), ["all", "All configured employees"]]], ["title", "Subject", "text", initialTitle, [], 160], ["body", "Instructions or context", "textarea", initialBody, [], 8000]], "Save for next visit", "Visible to authorized SOC viewers. Instructions are picked up only when the existing routine reads its authenticated inbox. This does not start, reschedule, or execute the routine."));
        }
        instructionPanel.append(filterForm([["Employee", "employee", [["", "All employees"], ...catalog.map(item => [item.id, item.name || item.id])]]]), p(text(inbox.counts?.pendingAcknowledgments ?? "Unknown") + " waiting acknowledgments · " + text(inbox.counts?.messages ?? "Unknown") + " retained messages. Viewing this page does not acknowledge instructions."));
        list(inbox.items).forEach(item => {
          const acks = item.acknowledgments || {}, recipients = list(item.recipients), message = panel(item.title || "Instruction", badge(item.withdrawnAt ? "withdrawn" : recipients.length && recipients.every(id => acks[id]) ? "acknowledged" : "waiting"), facts([["Saved", when(item.createdAt)], ["Author", item.author]]), el("pre", item.body || "", "ops-message"), table(["Recipient", "State", "Read receipt", "Account", "Reply"], recipients.map(id => [names.get(id) || id, badge(item.withdrawnAt ? "withdrawn" : acks[id] ? "acknowledged" : "waiting"), when(acks[id]?.at), acks[id]?.actor || "No receipt", acks[id]?.reply || "No reply"])));
          if (item.withdrawnAt) message.append(facts([["Withdrawn", when(item.withdrawnAt)], ["By", item.withdrawnBy]]));
          else message.append(mutation("Withdraw instruction", "employee-inbox/withdraw", { messageId: item.id }, [], "Withdraw instruction", "Keeps the original content and earlier receipts in history.")); instructionPanel.append(message);
        });
        if (!list(inbox.items).length) instructionPanel.append(notice(offset ? "No instructions on this history page." : "No instructions have been recorded in this scope."));
        const pages = el("nav", undefined, "ops-links"); pages.setAttribute("aria-label", "Instruction history pages"); if (offset > 0) pages.append(link("Previous page", route, { inboxOffset: Math.max(0, offset - 100) })); if (Number.isInteger(inbox.nextOffset) && inbox.nextOffset > offset && inbox.nextOffset <= 500) pages.append(link("Next page", route, { inboxOffset: inbox.nextOffset })); instructionPanel.append(pages);
      }
      instructionPanel.append(links([["Configure employee runtime and authenticated inbox", "/docs", { section: "66-native-monitoring-and-operations" }]]));
      const hosts = list(resources.resources);
      if (!resources.unavailable && hosts.length && observed.length) board.append(mutation("Assign work", "work", context.incident ? { incidentId: context.incident.id } : {}, [["host", "Target host", "select", context.host || "", hostChoices(hosts).map(([id, name]) => [id, id ? name : "Choose a host"])], ["employeeId", "Employee", "select", selected?.id || "", [["", "Choose an employee"], ...observed.map(item => [item.id, item.name || item.id])]], ["title", "Assignment title", "text", "", [], 240], ["reason", "Reason and expected outcome", "textarea", "", [], 1000]], "Create assignment", "Creates queued work for an integrated runtime. Claims, actions and verification use the authenticated Operations API. Source credentials report job and employee lifecycle observations separately. Recording work neither runs a command nor changes measured health."));
      if (data.truncated) board.append(notice("Showing recent assignments. Older evidence remains retained.", true));
      board.append(panel("Assignments and administrative activity", data.unavailable ? unavailable(data, "Assignments") : table(["Assignment", "Host", "Employee", "State", "Updated", "Evidence"], list(data.work).filter(item => !selected || item.employeeId === selected.id).slice(0, 100).map(item => [item.incidentId ? link(item.title || item.id, "/incidents", { incident: item.incidentId }) : item.title || item.id, item.host, item.employeeId || "Unassigned", badge(item.status), when(item.updatedAt || item.createdAt), details({ reason: item.reason, assessment: item.assessment, action: item.action, verification: item.verification, incidentGeneration: item.incidentGeneration, leaseExpired: item.leaseExpired })]))));
    }
    async function load() {
      if (disposed) return; draftForms.clear(); unresolvedForms.clear(); dirty = false; board.replaceChildren(); chartInspectors.length = 0; status.textContent = "Loading operations…";
      try { await ({ "/infrastructure": infrastructure, "/services": services, "/websites": websites, "/metrics": metrics, "/incidents": incidents, "/jobs": jobs, "/employees": employees, "/analyst-reports": employees })[route](); if (!disposed) status.textContent = "Application: " + q.appId + " · " + window.timezone + " · private recorded evidence. Refresh to retrieve newer observations."; }
      catch (error) { if (!disposed) { status.textContent = "Operations view could not be completed. Existing evidence has not been treated as empty."; board.append(notice("Refresh the view or inspect the configured source. No successful monitoring state has been assumed.", true)); if (onError) onError(error); } }
    }
    cleanup.ready = load(); return cleanup;
  }
  root.SocOperations = Object.freeze({ render, routes: ROUTES, parseWindow, contextUrl, boundedPoints, segments, chartCsv });
}(window));
