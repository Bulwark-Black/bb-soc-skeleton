(function (root) {
  "use strict";
  const API = "/api/v1/setup-assistance";
  let offeredThisPage = false, viewSequence = 0;
  const personalChecks = new Set();
  function el(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
  function link(text, href) { const node = el("a", text, "resource-action"); node.href = href; node.style.display = "inline-flex"; node.style.margin = "4px 6px 4px 0"; return node; }
  function render({ container, controlsContainer, mode = "screen", route, query, offerChecklist = false } = {}) {
    let disposed = false, pending = null, busy = false, readFacts;
    const section = el("section", undefined, "panel"); section.style.padding = "14px";
    const operations = mode === "operations";
    const screen = mode === "screen";
    const identity = "setup-assistance-" + (++viewSequence);
    section.setAttribute("id", identity);
    let explain = null;
    function scopedHref(href) {
      for (const key of ["appId", "sourceId"]) {
        const value = query?.get?.(key);
        if (typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) href += (href.includes("?") ? "&" : "?") + key + "=" + encodeURIComponent(value);
      }
      return href;
    }
    section.append(el("h2", operations ? "Private deployment and recovery guide" : "About this screen"));
    const status = el("p", operations ? "Review each operating step. Local checks cannot certify network isolation or a successful restore." : "Inspect which sources feed this screen and whether matching data is retained.", "muted"); status.setAttribute("role", "status");
    const output = el("div"), button = el("button", operations ? "Check local deployment facts" : "Refresh local facts", "resource-action"); button.type = "button";
    section.append(status, button, output, link("Monitor my application / Check my setup", "#/sources?stab=setup"));
    if (operations) container.append(section);
    else {
      const controls = el("span"); controls.style.display = "inline-flex"; controls.style.gap = "6px"; controls.style.marginLeft = "10px"; controls.style.verticalAlign = "middle"; controls.style.fontSize = "12px"; controls.style.flexWrap = "wrap";
      (controlsContainer || container).append(controls);
      if (screen) {
        explain = el("button", "+", "resource-action"); explain.type = "button"; explain.style.minWidth = "35px"; explain.style.padding = "7px";
        explain.setAttribute("aria-label", "Explain this screen"); explain.setAttribute("title", "Explain this screen");
        explain.setAttribute("aria-expanded", "false"); explain.setAttribute("aria-controls", identity);
        controls.append(explain); section.hidden = true; container.append(section);
        explain.addEventListener("click", () => {
          if (disposed) return;
          section.hidden = !section.hidden; explain.textContent = section.hidden ? "+" : "−";
          explain.setAttribute("aria-expanded", String(!section.hidden));
          if (!section.hidden && !busy && !output.children.length) return readFacts();
        });
      }
      if (root.SOC_PRIVATE_APPLICATION) {
        const resume = el("button", "Setup checklist", "resource-action"); resume.type = "button";
        const checklist = el("section", undefined, "panel"); checklist.style.padding = "14px"; checklist.hidden = true;
        checklist.setAttribute("id", identity + "-checklist"); checklist.setAttribute("role", "region"); checklist.setAttribute("aria-labelledby", identity + "-checklist-title");
        resume.setAttribute("aria-controls", identity + "-checklist"); resume.setAttribute("aria-expanded", "false"); controls.append(resume);
        const title = el("h2", "Beginner setup checklist"); title.setAttribute("id", identity + "-checklist-title");
        const dismiss = el("button", "Dismiss checklist", "resource-action"); dismiss.type = "button";
        checklist.append(title, el("p", "Your own setup reminders, not verified readiness. Checkmarks stay only in this page's memory and reset on reload; they do not configure the SOC or certify security.", "muted"), dismiss);
        const steps = [
          ["private", "Keep access private", "Use a Tailnet with restrictive access rules and Tailscale Serve. Never enable public Funnel, public ingress or router port forwarding. Verify access from outside your Tailnet yourself.", "Private deployment guide", "#/sources?stab=operations"],
          ["account", "Protect your administrator account", "Use your own unique password and enroll an authenticator in account security. Better Auth sign-in and Tailnet access are separate protections; neither proves that collection is working.", "Account security / 2FA", "/sign-in?mode=security"],
          ["application", "Choose your application and first source", "Guided setup registers your web application, chooses an environment and explains a compatible path. Then configure your actual producer; registering a source alone sends no data.", "Monitor my application", "#/sources?stab=setup"],
          ["source", "Connect and verify real delivery", "Add the source you need, then check received observations and the destination screen. Supply secrets only through the intended private credential flow, never through a chat prompt.", "Add a source", "#/sources?stab=add"],
          ["documents", "Track your documents", "Upload and version your own documents, then assign ownership and review dates as appropriate. Uploads are not malware-scanned and do not automatically prove compliance.", "Open document library", "#/documents"],
          ["agent", "Connect an AI assistant if useful", "Give the agent a scoped, expiring service identity and a protected token file. Start read-only, review any setup-write permissions, and retain human approval for credentials and activation.", "Connect an AI agent", "#/agents?atab=access"],
          ["verify", "Check setup and recovery", "Use Check my setup for current local evidence. Verify external delivery yourself and practice an isolated restore of your persistent state. A checked box here is only your personal reminder.", "Check my setup", "#/sources?stab=setup"]
        ];
        for (const [key, label, detail, labelLink, href] of steps) {
          const row = el("div"), choice = el("label"), input = el("input"), instruction = el("details"); input.type = "checkbox"; input.checked = personalChecks.has(key);
          choice.append(input, el("span", " " + label)); instruction.append(el("summary", "How to complete this step"), el("p", detail, "muted"));
          const stepLink = link(labelLink, href); stepLink.style.marginLeft = "8px";
          row.append(choice, stepLink, instruction); row.style.margin = "8px 0"; checklist.append(row);
          input.addEventListener("change", () => { if (!disposed) { if (input.checked) personalChecks.add(key); else personalChecks.delete(key); } });
        }
        checklist.append(link("Full technical reference", "#/docs")); container.append(checklist);
        function showChecklist(show, restoreFocus = false) {
          if (disposed) return;
          checklist.hidden = !show; resume.setAttribute("aria-expanded", String(show));
          if (show) offeredThisPage = true;
          if (restoreFocus && typeof resume.focus === "function") resume.focus();
        }
        resume.addEventListener("click", () => showChecklist(checklist.hidden));
        dismiss.addEventListener("click", () => showChecklist(false, true));
        checklist.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); showChecklist(false, true); } });
        checklist.addEventListener("click", event => { if (event.target?.closest?.("a")) showChecklist(false); });
        if (offerChecklist && !offeredThisPage) showChecklist(true);
      }
    }
    if (operations) {
      const steps = [
        ["1 · Keep the SOC private", "Run the listener on loopback. For remote access, configure your actual Tailnet HTTPS origin and use Tailscale Serve with restrictive access rules. Do not enable public Funnel, router port forwarding, or a public reverse proxy. Verify from outside the tailnet; this page cannot prove public inaccessibility."],
        ["2 · Provision your operator and persistent state", "On a new installation, create the first administrator through the one-time localhost sign-in form, or use the documented account CLI. Setup closes permanently after the first account; use the CLI for additional accounts or recovery. Keep a dedicated owner-only state directory outside the checkout and reuse it after restart. There is no default account or public signup; never put keys in an agent prompt."],
        ["3 · Arrange continuous operation", "Choose an OS supervisor suitable for your host and an independent private outage monitor. Define who investigates a stopped process or delayed source. This guide does not install a service or claim that one exists."],
        ["4 · Check data and delivery", "Use Monitor my application to bind a source and Check my setup to inspect real records, freshness and destination screens. An explicit Slack test and human channel check are separate steps."],
        ["5 · Back up and prove restoration", "During an approved maintenance window, stop the app cleanly and back up the entire private state as one set, including all databases, any journal companions and the monitoring encryption key. Restore to an isolated private directory with outbound collection disabled until you intentionally transfer sole ownership. Keep the only known-good copy."],
        ["6 · Recover deliberately", "After a hard crash an existing state lock may block startup. Stop competing supervisors, inspect the recorded PID and verify no writer owns the directory. Remove only a confirmed stale lock, never state or keys to bypass an error. Record any coverage gap and recheck actual collection."]
      ];
      for (const [title, text] of steps) { const detail = el("details"); detail.append(el("summary", title), el("p", text)); section.append(detail); }
      section.append(link("Detailed private operations and recovery", "#/docs?section=57-live-monitoring-connect-collect-understand-notify-verify"), link("Retention and storage limits", "#/retention"));
    }
    if (!root.SOC_PRIVATE_APPLICATION) { status.textContent = "Static guidance only. Start the private application and sign in to inspect your own configuration. No check has run."; button.disabled = true; }
    readFacts = async () => {
      if (busy || disposed || !root.SOC_PRIVATE_APPLICATION) return;
      busy = true; button.disabled = true; output.replaceChildren(); status.textContent = "Reading current local facts…";
      pending = new AbortController(); const timeout = root.setTimeout(() => pending?.abort(), 20000);
      try {
        const args = operations ? "" : "?" + Object.entries({ route, ...(route === "/scans" ? { tab: query?.get?.("tab") || "trivy" } : {}),
          ...Object.fromEntries(["appId", "sourceId"].filter(key => query?.get?.(key)).map(key => [key, query.get(key)])) }).map(([key, value]) => key + "=" + encodeURIComponent(value)).join("&");
        const response = await root.fetch(API + (operations ? "/operations" : "/screen") + args, { credentials: "same-origin", cache: "no-store", redirect: "error", signal: pending.signal, headers: { Accept: "application/json" } });
        const reader = response.body.getReader(), parts = []; let size = 0;
        while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 1024 * 1024) { await reader.cancel(); throw new Error("limit"); } parts.push(part.value); }
        if (!response.ok) throw new Error("unavailable");
        const bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
        const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); if (disposed) return;
        if (data.schemaVersion !== "1" || !Number.isFinite(Date.parse(data.checkedAt))) throw new Error("invalid");
        status.textContent = "Read-only facts checked at " + new Date(data.checkedAt).toISOString() + ". No scan, notification, network exposure or configuration change was made.";
        if (operations) {
          if (!Array.isArray(data.checks) || data.checks.length > 20) throw new Error("invalid");
          output.append(el("p", "Configured origin: " + data.origin));
          for (const check of data.checks) { const card = el("div"); card.append(el("h3", ({ pass: "Observed", attention: "Needs attention", manual: "Operator verification required" }[check.state] || "Unknown") + " · " + check.title), el("p", check.detail)); output.append(card); }
        } else {
          if (!Array.isArray(data.recordKinds) || !Array.isArray(data.sources)) throw new Error("invalid");
          output.append(el("p", data.detail), el("p", "Feeds: " + (data.recordKinds.join(", ") || "Locally authored records")), el("p", "Compatible declarations: " + data.configuredSources + " · Active: " + data.activeSources + " · Retained matching records: " + (data.retainedRecords === null ? "not a telemetry workflow" : data.retainedRecords)), el("p", data.limitation));
          for (const source of data.sources) output.append(el("p", source.displayName + " · " + source.environment + " · " + source.state));
          if (data.omittedSources) output.append(el("p", data.omittedSources + " further compatible declarations omitted from this bounded view."));
          output.append(link("Review source registry", scopedHref("#/sources?stab=add")), link("Inspect retained observations and filters", scopedHref("#/sources?stab=observations")));
        }
      } catch { if (!disposed) { output.replaceChildren(); status.textContent = "Local facts could not be verified. Refresh your private session and retry; no success is inferred from this failure."; } }
      finally { root.clearTimeout(timeout); pending = null; busy = false; if (!disposed) button.disabled = false; }
    };
    button.addEventListener("click", readFacts);
    const cleanup = () => { disposed = true; pending?.abort(); }; cleanup.isDirty = () => false; return cleanup;
  }
  root.SocSetupAssistance = Object.freeze({ render });
}(window));
