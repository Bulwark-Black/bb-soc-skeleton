"use strict";

// Mountable, data-free SOC interface. Route, tab, panel, and control structure
// comes from ui-catalog.js; authorized records can only enter through the
// versioned adapter boundary.
(function installSocConsole(global) {
  const VERSION = "1";
  const catalog = global.SocConsoleUiCatalog;
  const adapterRuntime = global.SocConsoleAdapterRuntime;
  const connectorRuntime = global.SocConsoleConnectorRuntime || null;
  const administrationRuntime = global.SocConsoleAdministrationRuntime || null;
  const technicalDocs = global.SocConsoleTechnicalDocs || null;
  if (!catalog || catalog.schemaVersion !== VERSION) throw new Error("SocConsoleUiCatalog version 1 is required.");
  if (!adapterRuntime || adapterRuntime.VERSION !== VERSION) throw new Error("SocConsoleAdapterRuntime version 1 is required.");

  const pages = catalog.pages.slice();
  const pageByPath = new Map(pages.map((page) => [page.path, page]));
  const groupedRoutes = catalog.groups.flatMap(([, entries]) => entries.map(([path]) => path));
  const utilityRoutes = ["/onboard", "/settings"];
  const localUtilityRoutes = ["/docs"];
  const primaryRoutes = groupedRoutes.concat(utilityRoutes);
  const selectableRoutes = primaryRoutes.concat(localUtilityRoutes);
  const routes = pages.map((page) => page.path);
  const scanTabset = (pageByPath.get("/scans").tabsets || []).find((tabset) => tabset.param === "tab");
  const scanProfilesByTab = new Map((scanTabset ? scanTabset.items : [])
    .filter((item) => item.connectionProfile)
    .map((item) => [item.id, item.connectionProfile]));
  const scanProfilesBySetupFor = new Map(Array.from(scanProfilesByTab.values())
    .map((profile) => [profile.setupFor, profile]));
  const detailBack = Object.freeze({
    "/analyst": "/brief",
    "/event": "/triage",
    "/ip": "/logs",
    "/search": "/",
    "/host-scan": "/scans",
    "/kev": "/systems",
    "/source": "/sources",
    "/attestation": "/attestations",
    "/risk": "/register"
  });
  const ACTIVE_ANALYTICS_PALETTE = Object.freeze([
    "#4e79a7", "#f28e2b", "#e15759", "#76b7b2",
    "#59a14f", "#edc948", "#b07aa1", "#ff9da7"
  ]);
  const ACTIVE_ANALYTICS_SEQUENCE = "#3987e5";
  const ACTIVE_ANALYTICS_EXHAUSTED = "#6b7075";
  const ACTIVE_SEVERITY_COLORS = Object.freeze({
    critical: "#dc4e41", high: "#f8be34", info: "#8c9296"
  });
  const GO_SHORTCUTS = Object.freeze({
    o: "/", a: "/attestations", r: "/register", s: "/scans",
    l: "/logs", y: "/systems", d: "/databases", b: "/backups",
    u: "/sources", f: "/brief", t: "/timeline", p: "/phishing"
  });

  function append(parent, children) {
    const values = Array.isArray(children) ? children : [children];
    for (const child of values) {
      if (child === undefined || child === null || child === false) continue;
      parent.append(child && child.nodeType ? child : global.document.createTextNode(String(child)));
    }
    return parent;
  }

  function node(tagName, options = {}, children = []) {
    const element = global.document.createElement(tagName);
    if (options.className) element.className = options.className;
    if (options.text !== undefined) element.textContent = String(options.text);
    if (options.attrs) {
      for (const [name, value] of Object.entries(options.attrs)) {
        if (value !== undefined && value !== null && value !== false) element.setAttribute(name, value === true ? "" : String(value));
      }
    }
    if (options.dataset) {
      for (const [name, value] of Object.entries(options.dataset)) element.dataset[name] = String(value);
    }
    return append(element, children);
  }

  function svgNode(tagName, attrs = {}, children = []) {
    const element = global.document.createElementNS("http://www.w3.org/2000/svg", tagName);
    for (const [name, value] of Object.entries(attrs)) {
      if (value !== undefined && value !== null && value !== false) element.setAttribute(name, value === true ? "" : String(value));
    }
    return append(element, children);
  }

  function slug(value) {
    return String(value || "panel").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 72) || "panel";
  }

  function queryObject(params) {
    const result = {};
    params.forEach((value, key) => {
      if (!Object.prototype.hasOwnProperty.call(result, key)) result[key] = value;
    });
    return result;
  }

  function providerQuery(route, params) {
    const result = queryObject(params);
    delete result.setupId; // Local guided-navigation context is never a page-provider filter.
    if (route === "/sources" || (route === "/scans" && (!result.tab || result.tab === "trivy"))) delete result.environment;
    if (route === "/sources") delete result.setupFor;
    if (route === "/access" && result.atab === "offboarding" && result.id) {
      result.oview = "records";
    }
    return result;
  }

  function routeHash(path, query) {
    const params = new URLSearchParams();
    if (query) {
      Object.entries(query).forEach(([key, value]) => {
        if (value !== undefined && value !== null && String(value) !== "") params.set(key, String(value));
      });
    }
    const serialized = params.toString();
    return `#${path}${serialized ? `?${serialized}` : ""}`;
  }

  function parseLocation(defaultRoute) {
    const raw = global.location && global.location.hash ? global.location.hash.slice(1) : defaultRoute;
    const question = raw.indexOf("?");
    const path = question < 0 ? raw : raw.slice(0, question);
    const query = new URLSearchParams(question < 0 ? "" : raw.slice(question + 1));
    return { path: path || defaultRoute, query };
  }

  function whenMatches(when, values) {
    if (!when) return true;
    return Object.entries(when).every(([key, expected]) => {
      const actual = values[key];
      return Array.isArray(expected) ? expected.includes(actual) : expected === actual;
    });
  }

  function queryMatches(whenQuery, query) {
    if (!whenQuery) return true;
    return Object.entries(whenQuery).every(([key, expected]) => {
      const actual = query.get(key);
      if (expected === "present") return actual !== null && actual !== "";
      if (expected === "absent") return actual === null || actual === "";
      if (expected && typeof expected === "object" && !Array.isArray(expected)) {
        const normalized = String(actual || "").toLowerCase();
        if (expected.contains !== undefined) return normalized.includes(String(expected.contains).toLowerCase());
        if (expected.notContains !== undefined) return !normalized.includes(String(expected.notContains).toLowerCase());
      }
      return Array.isArray(expected) ? expected.includes(actual) : expected === actual;
    });
  }

    function activeTabsets(page, query) {
      const effectiveQuery = new URLSearchParams(query.toString());
      if (page.path === "/access" && effectiveQuery.get("atab") === "offboarding" && effectiveQuery.get("id")) {
        effectiveQuery.set("oview", "records");
      }
      for (const [parameter, aliases] of Object.entries(page.tabAliases || {})) {
      const requested = effectiveQuery.get(parameter);
      const replacement = requested && aliases[requested];
      if (!replacement) continue;
      Object.entries(replacement).forEach(([key, value]) => {
        if (key === parameter || !effectiveQuery.has(key)) effectiveQuery.set(key, value);
      });
    }
    const values = {};
    const result = [];
    for (const tabset of page.tabsets || []) {
      if (!whenMatches(tabset.when, values)) continue;
      const requested = effectiveQuery.get(tabset.param);
      const active = tabset.items.some((item) => item.id === requested) ? requested : tabset.default;
      values[tabset.param] = active;
      result.push({ tabset, active, invalid: requested !== null && requested !== active });
    }
    return { values, tabsets: result };
  }

  function createApp(options) {
    if (!options || !options.root || typeof options.root.replaceChildren !== "function") {
      throw new TypeError("createApp requires a DOM mount root.");
    }
    const root = options.root;
    const provider = options.provider || null;
    const auth = options.auth || null;
    const commands = options.commands || null;
    const administration = options.administration || null;
    if (commands && (!connectorRuntime || connectorRuntime.VERSION !== VERSION)) {
      throw new TypeError("A version 1 connector runtime is required when a command provider is supplied.");
    }
    if (administration && (!administrationRuntime || administrationRuntime.VERSION !== VERSION)) {
      throw new TypeError("A version 1 administration runtime is required when an administration provider is supplied.");
    }
    const config = options.config || {
      schemaVersion: VERSION,
      mode: "skeleton",
      brand: { name: "Bulwark Black SOC", product: "bulwark>soc", logoPath: "assets/mark.png" },
      routing: { defaultRoute: "/" },
      connectors: { globalName: "SOC_CONSOLE_CONNECTORS" },
      administration: { globalName: "SOC_CONSOLE_ADMINISTRATION" },
      auth: { required: false }
    };
    if (!pageByPath.has(config.routing.defaultRoute)) {
      throw new TypeError("config.routing.defaultRoute must be a registered SOC interface route.");
    }
    const documentRef = root.ownerDocument || global.document;
    const inferredShellRoot = typeof root.closest === "function" ? root.closest("[data-soc-console]") : null;
    const shellRoot = Object.prototype.hasOwnProperty.call(options, "shellRoot") ? options.shellRoot : inferredShellRoot;
    if (shellRoot !== null && shellRoot !== undefined && typeof shellRoot.querySelector !== "function") {
      throw new TypeError("createApp shellRoot must support querySelector when supplied.");
    }
    const shellHook = (selector) => shellRoot ? shellRoot.querySelector(selector) : null;
    const hooks = {
      sideNavigation: shellHook("#side-navigation"),
      routeSelect: shellHook("#route-select"),
      pageFilter: shellHook("#page-filter"),
      pageFilterStatus: shellHook("#page-filter-status"),
      refreshButton: shellHook("#refresh-view"),
      timezoneToggle: shellHook("#timezone-toggle"),
      autoRefreshState: shellHook("#auto-refresh-state"),
      connectionState: shellHook("#connection-state"),
      interfaceState: shellHook("#interface-state"),
      authChip: shellHook("#auth-chip"),
      authAvatar: shellHook("#auth-avatar"),
      authName: shellHook("#auth-name"),
      authState: shellHook("#auth-state"),
      commandDialog: shellHook("#command-dialog"),
      commandInput: shellHook("#command-input"),
      commandResults: shellHook("#command-results"),
      commandClose: shellHook("#command-close"),
      pulseClip: shellHook("#circuit-pulses"),
      toast: shellHook("#toast"),
      toastMessage: shellHook("#toast-message"),
      toastDismiss: shellHook("#toast-dismiss"),
      brandLink: shellHook(".brand"),
      brandImage: shellHook(".brand img"),
      technicalDocsLink: shellHook("#technical-docs-link"),
      agentsLink: shellHook("#agents-link")
    };
    const state = {
      started: false,
      terminal: false,
      mounted: false,
      route: config.routing.defaultRoute,
      query: new URLSearchParams(),
      envelope: null,
      providerState: provider ? "idle" : "absent",
      providerError: false,
      controlState: commands ? "idle" : "absent",
      controlError: false,
      controlSnapshot: null,
      commandPending: false,
      commandResult: null,
      administrationState: administration ? "idle" : "absent",
      administrationError: false,
      administrationSnapshot: null,
      administrationPrompt: null,
      administrationPending: false,
      administrationResult: null,
      administrationDraft: null,
      authState: auth ? "idle" : "absent",
      authError: false,
      session: Object.freeze({ authenticated: false }),
      timezone: "UTC",
      requestSerial: 0
    };
    const pageFilters = new Map();
    let autoRefreshId = null;
    let refreshPromise = null;
    let privateViewCleanup = null;
    let assistanceCleanup = null;
    let privateViewRoute = null;
    let commandSequence = 0;
    let goShortcutPending = false;
    let goShortcutTimer = null;

    function showToast(message) {
      if (!hooks.toast || !hooks.toastMessage) return;
      hooks.toastMessage.textContent = message;
      hooks.toast.hidden = false;
    }

    function hideToast() {
      if (hooks.toast) hooks.toast.hidden = true;
    }

    function installCircuitPulses() {
      if (!hooks.pulseClip || hooks.pulseClip.childNodes.length) return;
      const namespace = "http://www.w3.org/2000/svg";
      const paths = [
        `M60 0 ${"v16 h20 v36 h-20 v44 ".repeat(42)}`,
        `M156 0 ${"v16 h20 v36 h-20 v44 ".repeat(42)}`
      ];
      const svg = documentRef.createElementNS(namespace, "svg");
      svg.setAttribute("viewBox", "0 0 192 4032");
      svg.setAttribute("preserveAspectRatio", "none");
      svg.setAttribute("aria-hidden", "true");
      svg.classList.add("circuit-pulse");
      const count = 3 + Math.floor(Math.random() * 3);
      for (let index = 0; index < count; index += 1) {
        const group = documentRef.createElementNS(namespace, "g");
        const duration = Math.round(150 + Math.random() * 140);
        const delay = -Math.round(Math.random() * duration);
        const pathData = paths[Math.random() < 0.5 ? 0 : 1];
        for (const className of ["cp-t", "cp-m", "cp-h"]) {
          const path = documentRef.createElementNS(namespace, "path");
          path.setAttribute("d", pathData);
          path.setAttribute("class", className);
          path.setAttribute("style", `animation-duration:${duration}s;animation-delay:${delay}s`);
          group.append(path);
        }
        svg.append(group);
      }
      hooks.pulseClip.append(svg);
    }

    function renderNavigation() {
      if (hooks.sideNavigation) {
        const fragments = catalog.groups.map(([group, entries]) => {
          const list = node("ul", { className: "nav-list" });
          entries.forEach(([path, label]) => {
            const link = node("a", {
              className: "nav-link tab",
              text: label,
              attrs: { href: routeHash(path), "data-route": path }
            });
            list.append(node("li", {}, link));
          });
          return node("section", { className: "nav-group navgroup", attrs: { "aria-labelledby": `nav-${slug(group)}` } }, [
            node("h2", { className: "nav-heading navhead", text: group, attrs: { id: `nav-${slug(group)}` } }),
            list
          ]);
        });
        hooks.sideNavigation.replaceChildren(...fragments);
      }
      if (hooks.routeSelect) {
        const children = catalog.groups.map(([group, entries]) => {
          const optionGroup = node("optgroup", { attrs: { label: group } });
          entries.forEach(([path, label]) => optionGroup.append(node("option", { text: label, attrs: { value: path } })));
          return optionGroup;
        });
        const utilities = node("optgroup", { attrs: { label: "Utilities" } }, utilityRoutes.concat(localUtilityRoutes).map((path) => {
          const page = pageByPath.get(path);
          return node("option", { text: page.label, attrs: { value: path } });
        }));
        hooks.routeSelect.replaceChildren(...children, utilities);
      }
    }

    function updateNavigation() {
      const navigationRoute = detailBack[state.route] || state.route;
      if (shellRoot && typeof shellRoot.setAttribute === "function") {
        shellRoot.setAttribute("data-active-route", state.route);
      }
      if (hooks.sideNavigation) {
        hooks.sideNavigation.querySelectorAll("[data-route]").forEach((link) => {
          if (link.getAttribute("data-route") === navigationRoute) {
            link.setAttribute("aria-current", "page");
            link.classList.add("active");
          } else {
            link.removeAttribute("aria-current");
            link.classList.remove("active");
          }
        });
      }
      if (hooks.routeSelect) {
        hooks.routeSelect.value = selectableRoutes.includes(navigationRoute) ? navigationRoute : "";
      }
      if (hooks.technicalDocsLink) {
        if (state.route === "/docs") hooks.technicalDocsLink.setAttribute("aria-current", "page");
        else hooks.technicalDocsLink.removeAttribute("aria-current");
      }
      if (hooks.agentsLink) {
        if (state.route === "/agents") hooks.agentsLink.setAttribute("aria-current", "page");
        else hooks.agentsLink.removeAttribute("aria-current");
      }
    }

    function updateShellState() {
      if (hooks.brandImage) {
        hooks.brandImage.src = config.brand.logoPath;
        hooks.brandImage.alt = config.brand.name;
      }
      if (hooks.brandLink) hooks.brandLink.setAttribute("aria-label", `${config.brand.name} overview`);
      if (hooks.interfaceState) {
        hooks.interfaceState.lastChild.textContent = config.mode === "application" ? "Application interface" : "Interface skeleton";
      }
      if (hooks.connectionState) {
        const providerLabels = {
          loading: "Reading data adapter",
          error: "Data adapter error",
          unavailable: "Data adapter unavailable",
          forbidden: "Data access forbidden",
          gated: "Data adapter gated",
          disposed: "Data adapter unmounted"
        };
        hooks.connectionState.textContent = provider
          ? (providerLabels[state.providerState] || "Data adapter connected")
          : "No data adapter";
      }
      if (hooks.timezoneToggle) hooks.timezoneToggle.textContent = state.timezone;
      if (hooks.autoRefreshState) {
        hooks.autoRefreshState.dataset.active = String(Boolean(provider && state.mounted));
        hooks.autoRefreshState.lastChild.textContent = provider && state.mounted ? "Auto 5m" : "Auto off";
      }
      if (hooks.authAvatar) hooks.authAvatar.textContent = state.session.display ? state.session.display.initials : "—";
      if (hooks.authName) {
        hooks.authName.textContent = state.session.display
          ? state.session.display.name
          : state.session.authenticated
            ? "Signed in"
            : auth ? "Sign in" : "Not signed in";
      }
      if (hooks.authState) {
        hooks.authState.textContent = state.authState === "loading"
          ? "checking"
          : state.authState === "error"
            ? "authentication error"
          : state.authState === "unmounted"
            ? "unmounted"
          : state.session.authenticated
            ? "authenticated"
            : auth ? "authentication available" : "auth not connected";
      }
    }

    function pageDisplayTitle(page) {
      const intelNames = {
        otx: "AlienVault OTX",
        threatfox: "ThreatFox",
        urlhaus: "URLhaus",
        malwarebazaar: "MalwareBazaar",
        feeds: "Feeds"
      };
      const requestedIntel = state.query.get("itab");
      const analystHubViews = new Set(["cases", "rules", "vuln", "affected", "retention"]);
      const honeypotTitles = {
        decoys: "Honeypots — Decoy Files",
        canaries: "Honeypots — Canaries",
        users: "Honeypots — Trap Usernames",
        hits: "Honeypots — Trip Log",
        clerk: "Honeypots — Clerk Honey Account"
      };
      const sourceTitles = {
        setup: "Sources — Guided Setup",
        mapping: "Sources — Map a Custom Source",
        operations: "Sources — Private Deployment",
        expected: "Sources — Dead-man Board",
        add: "Sources — Add",
        integrations: "Sources — Integrations",
        live: "Sources — Live Monitoring",
        vendors: "Sources — Vendor Imports",
        observations: "Sources — Received Observations",
        changes: "Sources — Registry Changes"
      };
      return page.path === "/phishing" && state.query.get("id")
        ? "Phishing — Report"
        : page.path === "/brief" && state.query.get("btab") === "turnover"
          ? "Turnover Board"
          : page.path === "/analyst" && analystHubViews.has(state.query.get("atab"))
            ? "Analyst Hub"
        : page.path === "/access" && state.query.get("atab") === "offboarding" && state.query.get("id")
          ? "Access — Offboarding record"
          : page.path === "/access" && state.query.get("atab") === "offboarding" && state.query.get("oview") === "guide"
            ? "Access — How to use offboard.sh"
        : page.path === "/intel" && intelNames[requestedIntel]
          ? `Threat Intel · ${intelNames[requestedIntel]}`
          : page.path === "/sources"
            ? sourceTitles[state.query.get("stab")] || sourceTitles.expected
          : page.path === "/honeypots"
            ? honeypotTitles[state.query.get("htab")] || honeypotTitles.decoys
          : page.path === "/event"
            ? (state.envelope ? state.envelope.title : "Event")
            : page.displayTitle || page.label;
    }

    function pageHeader(page) {
      const fragment = documentRef.createDocumentFragment();
      const adapterLabel = page.path === "/sources" && ["setup", "mapping", "operations", "integrations", "live", "vendors", "observations"].includes(state.query.get("stab"))
        ? global.SOC_PRIVATE_APPLICATION ? "private integration services" : "integration services unavailable"
        : page.localOnly
        ? page.variant === "document-library" ? "private document library" : "built-in technical reference"
        : provider
          ? `adapter · ${state.providerState}`
          : "no data adapter";
      const title = pageDisplayTitle(page);
      fragment.append(node("h1", { className: "dash-title", attrs: { id: "page-title" } }, [
        title,
        node("small", { text: adapterLabel })
      ]));
      if (page.path === "/phishing" && state.query.get("id")) {
        fragment.append(detailBackLink("/phishing", "Back to Phishing"));
      }
      if (detailBack[page.path] && page.path !== "/event") {
        fragment.append(detailBackLink(detailBack[page.path], `Back to ${pageByPath.get(detailBack[page.path]).label}`));
      }
      return fragment;
    }

    function breadcrumbs(page) {
      let items = [["/", "Overview"]];
      if (page.path === "/event") items.push(["/triage", "Triage"], [null, "Event"]);
      else if (page.path === "/phishing" && state.query.get("id")) items.push(["/phishing", "Phishing"], [null, "Report"]);
      else if (page.path === "/access" && state.query.get("atab") === "offboarding" && state.query.get("id")) {
        items.push(["/access", "Access"], [{ path: "/access", query: { atab: "offboarding" } }, "Offboarding"], [null, "Record"]);
      } else if (page.path === "/tuning") items = [["/triage", "Triage"], ["/tuning", "Detection Tuning"], [null, "Draft or record"]];
      else if (page.path === "/rules" && state.query.get("ruleView")) items.push(["/rules", "Rules"], [null, "Definition"]);
      else if (detailBack[page.path]) items.push([detailBack[page.path], pageByPath.get(detailBack[page.path]).label], [null, page.label]);
      else items.push([null, page.label]);
      const children = [];
      items.forEach(([target, label], index) => {
        if (index) children.push(node("span", { className: "crumb-sep", text: "›", attrs: { "aria-hidden": "true" } }));
        if (!target) children.push(node("span", { text: label, attrs: { "aria-current": "page" } }));
        else if (typeof target === "string") children.push(node("a", { text: label, attrs: { href: routeHash(target) } }));
        else children.push(node("a", { text: label, attrs: { href: routeHash(target.path, target.query) } }));
      });
      return node("nav", { className: "crumbs", attrs: { "aria-label": "Breadcrumb" } }, children);
    }

    function panelShell(title, body, meta, tone, options = {}) {
      const panel = node("section", {
        className: `panel${options.className ? ` ${options.className}` : ""}`,
        attrs: { "data-filterable": "", "data-tone": tone || "neutral", "data-panel-id": options.id }
      }, [
        node("header", { className: "panel-header panel-hd" }, [
          node("span", { className: "panel-title", text: title, attrs: { role: "heading", "aria-level": "2" } }),
          meta ? node("span", { className: "panel-meta panel-right", text: meta }) : null
        ]),
        body
      ]);
      return panel;
    }

    function emptyCopy(label) {
      return node("div", { className: "empty-inline" }, [
        node("span", { className: "empty-glyph", text: "◇", attrs: { "aria-hidden": "true" } }),
        node("div", {}, [
          node("strong", { text: `No ${label.toLowerCase()} supplied` }),
          node("p", { text: "This public skeleton contains no operational records." })
        ])
      ]);
    }

    function alertPathPanel(items, panelId, description) {
      const supplied = new Map((items || []).map((item) => [item.label, item]));
      const labels = ["Reachable people", "Sent (24h)", "Failed (24h)", "Highs waiting to batch", "Durable overflow"];
      return panelShell("Alert path", node("div", { className: "alert-path-body" }, [
        node("div", { className: "alert-path-health" }, [
          node("span", { className: "badge b-muted", text: "unconfigured" }),
          node("span", { className: "muted", text: description || "No application-authorized alert delivery state was supplied." })
        ]),
        node("div", { className: "alert-path-facts" }, labels.map((label) => {
          const item = supplied.get(label);
          return node("article", { attrs: { "data-tone": item ? item.tone : "neutral", "data-filterable": "" } }, [
            node("span", { text: label }),
            node("strong", { text: item ? item.value : "—" }),
            item && item.detail ? node("small", { text: item.detail }) : null
          ]);
        })),
        node("p", { className: "muted alert-path-copy", text: "Critical detections, high-severity batching, durable overflow, provider reconciliation, suppression windows, and delivery proof remain application-owned controls. This public UI does not infer that a configured address is reachable." })
      ]), "whether a detection can actually reach a person", undefined, { id: panelId });
    }

    function tuningSummary(items, panelId, description) {
      const hints = {
        "Active Tunes": "Enabled definitions",
        Drafts: "Inert until activated",
        Disabled: "History only",
        "Authorized Findings": "Delivery authorization audit"
      };
      return node("section", { className: "panel tune-card tune-summary-card", attrs: { "aria-label": "Active tuning status", "data-panel-id": panelId } }, [
        node("div", { className: "tune-eyebrow" }, [
          node("span", { text: "Active tuning status" }),
          node("span", { className: "tune-eyebrow-note", text: description || "authorized counts" })
        ]),
        node("div", { className: "tune-kpis" }, items.map((item) => node("article", { className: "tune-kpi", attrs: { "data-tone": item.tone, "data-filterable": "" } }, [
          node("div", { className: "value", text: item.value }),
          node("div", { className: "label", text: item.label }),
          node("div", { className: "hint", text: item.detail || hints[item.label] || "Awaiting authorized context" })
        ])))
      ]);
    }

    function phishingSummary(items, panelId, description) {
      const tones = {
        "Likely phishing": "bad",
        Suspicious: "warn",
        Clean: "ok",
        "Scorer faults": "bad"
      };
      return node("section", { className: "panel phishing-statebar", attrs: { "data-panel-id": panelId, "data-filterable": "" } }, [
        node("header", { className: "panel-header panel-hd" }, [
          node("span", { className: "panel-title", text: "Phishing reports", attrs: { role: "heading", "aria-level": "2" } }),
          node("span", { className: "panel-meta panel-right", text: description || "Reports are evidence; Triage owns disposition" })
        ]),
        node("div", { className: "phishing-statebar-body" }, [
          node("div", { className: "phishing-statebar-stats" }, items.map((item) => node("article", {
            className: "phishing-inline-stat",
            attrs: { "data-tone": item.tone || tones[item.label] || "neutral" }
          }, [
            node("span", { text: item.label }),
            node("strong", { text: item.value })
          ]))),
          node("p", { className: "muted phishing-statebar-note", text: "Reported messages remain evidence. The corresponding detection and decision workflow live in Triage; this board adds no second disposition state." })
        ])
      ]);
    }

    function phishingCardPanel(panel) {
      if (panel.title === "Verdict") {
        const facts = panel.labels.filter((label) => label !== "Verdict");
        return panelShell("Verdict", node("div", { className: "phishing-verdict" }, [
          node("div", { className: "phishing-verdict-primary" }, [
            node("span", { className: "badge b-muted", text: "Awaiting authorized verdict" }),
            node("strong", { text: "—" }),
            node("small", { text: "No message score supplied" })
          ]),
          node("div", { className: "phishing-verdict-facts" }, facts.map((label) => node("article", {}, [
            node("span", { text: label }), node("strong", { text: "—" })
          ])))
        ]), "Data-free report", undefined, { id: panel.id });
      }
      if (panel.title === "Passive intel") {
        return panelShell(panel.title, node("div", { className: "phishing-intel-grid" }, panel.labels.map((label) => node("section", { className: "phishing-intel-source" }, [
          node("h3", { text: label }),
          node("p", { className: "muted", text: "No authorized passive lookup result supplied." })
        ]))), "Passive only", undefined, { id: panel.id });
      }
      if (panel.title === "Message body") {
        return panelShell(panel.title, node("div", { className: "phishing-body-grid" }, panel.labels.map((label) => node("section", {}, [
          node("h3", { text: label }),
          node("pre", { className: "md-pre phishing-message-source", text: "No authorized message body supplied." })
        ]))), "Source text is never rendered as HTML", undefined, { id: panel.id });
      }
      return null;
    }

    function eventBackHref() {
      const raw = state.query.get("back");
      if (!raw || !raw.startsWith("/") || raw.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(raw)) {
        return routeHash("/triage");
      }
      if (raw.includes("#")) return routeHash("/triage");
      const question = raw.indexOf("?");
      const path = question < 0 ? raw : raw.slice(0, question);
      if (path !== "/triage") return routeHash("/triage");
      const query = new URLSearchParams(question < 0 ? "" : raw.slice(question + 1));
      return routeHash("/triage", queryObject(query));
    }

    function eventStatusPanel(items, panelId, description) {
      const values = new Map(items.map((item) => [item.label, item]));
      const valueOf = (label) => values.get(label) || { value: "—", tone: "neutral" };
      const status = valueOf("Status");
      const severity = valueOf("Severity");
      const dispositionTitle = "Connect a separately versioned, server-authorized command adapter to change this disposition.";
      const selectOptions = (values, selected) => values.map((value) => node("option", {
        text: value,
        attrs: { value, selected: value === selected ? true : undefined }
      }));
      return node("div", { className: "detail-head-row event-detail-head" }, [
        node("a", {
          className: "detail-back event-back-image",
          attrs: { href: eventBackHref(), "aria-label": "Back to Triage", title: "Back to Triage" }
        }, node("img", { attrs: { src: "assets/triage-back-arrow.png", alt: "", "aria-hidden": "true", width: "28", height: "28" } })),
        node("section", { className: "panel statusbar event-statusbar", attrs: { "data-panel-id": panelId, "data-tone": status.tone || "neutral" } }, [
          node("div", { className: "event-statusbar-body" }, [
            node("strong", { className: "event-status", text: status.value }),
            node("span", { className: "badge", text: severity.value, attrs: { "data-tone": severity.tone || "neutral" } }),
            node("span", { className: "muted", text: `owner ${valueOf("Owner").value}` }),
            node("span", { className: "badge b-muted", text: valueOf("Activity").value }),
            node("span", { className: "muted event-tune-state", text: `Tune · ${valueOf("Tune").value}` }),
            node("button", { className: "searchbtn event-tune-action", text: "Tune", attrs: { type: "button", disabled: true, title: "Requires an application-authorized finding" } })
          ]),
          node("form", { className: "event-disposition-form", attrs: { "aria-label": "Event disposition" } }, [
            node("label", {}, [
              node("span", { text: "State" }),
              node("select", { attrs: { name: "state", disabled: true, title: dispositionTitle } }, selectOptions([
                "new", "in-progress", "pending", "resolved", "closed"
              ], "in-progress"))
            ]),
            node("label", {}, [
              node("span", { text: "Owner" }),
              node("input", { attrs: { name: "owner", type: "text", disabled: true, placeholder: "owner", title: dispositionTitle } })
            ]),
            node("label", {}, [
              node("span", { text: "Activity" }),
              node("select", { attrs: { name: "category", disabled: true, title: dispositionTitle } }, selectOptions([
                "my-activity", "deploy", "scanner-noise", "misconfiguration", "real-threat", "drill", "other"
              ], "my-activity"))
            ]),
            node("label", { className: "event-disposition-note" }, [
              node("span", { text: "Note" }),
              node("input", { attrs: { name: "note", type: "text", disabled: true, placeholder: "what you found / what you did", title: dispositionTitle } })
            ]),
            node("label", {}, [
              node("span", { text: "Tags" }),
              node("input", { attrs: { name: "tags", type: "text", disabled: true, placeholder: "tags · '-' clears", title: dispositionTitle } })
            ]),
            node("button", { className: "searchbtn", text: "Save", attrs: { type: "button", disabled: true, title: dispositionTitle } })
          ]),
          description ? node("p", { className: "muted event-status-description", text: description }) : null
        ])
      ]);
    }

    function eventAnalystPanel(panel) {
      return panelShell(panel.title, node("div", { className: "event-analyst-empty" }, [
        node("div", {}, [
          node("span", { className: "badge b-muted", text: "not analysed" }),
          node("p", { className: "muted", text: "No application-authorized analyst finding was supplied. The analyst may read retained case evidence, but it never decides or changes the disposition." })
        ]),
        node("button", {
          className: "searchbtn",
          text: "Run analyst",
          attrs: { type: "button", disabled: true, title: "Requires an authenticated, server-authorized analyst workflow." }
        })
      ]), "On demand · reads the case, decides nothing", undefined, { id: panel.id });
    }

    function eventAccordion(title, body, open) {
      const summaries = {
        "Associated logs ± 15 min": "Show surrounding log lines",
        "Related detections in this case": "Show related detections",
        "Other recent detections on this host": "Show other detections on this host"
      };
      return node("details", { className: "assoc", attrs: { open: open ? true : undefined } }, [
        node("summary", { text: summaries[title] || `Show ${title.toLowerCase()}` }),
        body
      ]);
    }

    function isEventAccordion(title) {
      return [
        "Associated logs ± 15 min",
        "Related detections in this case",
        "Other recent detections on this host"
      ].includes(title);
    }

    const triageColumnIds = Object.freeze([
      "pick", "case", "when", "host", "sev", "rule", "alert", "status", "owner", "activity", "actions"
    ]);
    const triageColumnDefaults = Object.freeze({
      pick: 32, case: 96, when: 80, host: 78, sev: 50, rule: 104,
      alert: 160, status: 108, owner: 128, activity: 90, actions: 94
    });
    const triageColumnLimits = Object.freeze({
      pick: [28, 46], case: [88, 180], when: [72, 150], host: [64, 180], sev: [48, 90],
      rule: [88, 260], alert: [150, 520], status: [86, 220], owner: [116, 260],
      activity: [88, 360], actions: [82, 220]
    });
    let triageColumnWidths = { ...triageColumnDefaults };
    let triageResize = null;

    function isTuningSurface() {
      return state.route === "/tuning" || (state.route === "/rules" && state.query.get("rtab") === "tuning");
    }

    function tablePresentation(slotPanel) {
      const title = slotPanel && slotPanel.title ? slotPanel.title : "";
      const triageBoard = state.route === "/triage" && title === "Alerts";
      const tuningTable = isTuningSurface();
      const intelTable = state.route === "/intel" && /indicator|address|source|famil/i.test(title);
      const tableClasses = [
        triageBoard ? "triage-table" : "",
        tuningTable ? `tune-table${title === "Detection tune definitions" ? " tune-definitions" : ""}` : "",
        intelTable ? "intel-browse" : ""
      ].filter(Boolean).join(" ");
      const panelClasses = [
        triageBoard ? "triage-board" : "",
        tuningTable ? "tune-card" : "",
        state.route === "/" && title === "Detections" ? "soc-overview-detections" : ""
      ].filter(Boolean).join(" ");
      return Object.freeze({
        intelTable,
        panelClasses,
        tableClasses,
        tableScrollClass: triageBoard
          ? "table-scroll triage-table-shell"
          : tuningTable ? "table-scroll tune-table-scroll" : "table-scroll",
        triageBoard,
        tuningTable
      });
    }

    function triageColumnId(column, index) {
      const label = typeof column === "string" ? column : column.label;
      return triageColumnIds[index] || slug(label);
    }

    function triageBoardHeading() {
      const view = ["queue", "approvals", "cases", "closed", "all"].includes(state.query.get("view"))
        ? state.query.get("view") : "queue";
      const titles = {
        queue: "Queue — open alerts without a proposal",
        approvals: "Awaiting approval — a disposition was proposed and nothing closes until you decide",
        cases: "Cases — alerts promoted as real threats",
        closed: "Closed — resolved and closed alerts",
        all: "All triage alerts"
      };
      return `${titles[view]} · —`;
    }

    function boundedTriageWidth(columnId, value) {
      const fallback = triageColumnDefaults[columnId] || 96;
      const [minimum, maximum] = triageColumnLimits[columnId] || [48, 520];
      const numeric = Number(value);
      return Math.max(minimum, Math.min(maximum, Math.round(Number.isFinite(numeric) ? numeric : fallback)));
    }

    function applyTriageColumnWidths(table) {
      if (!table) return;
      let total = 0;
      table.querySelectorAll("col[data-col]").forEach((column) => {
        const columnId = column.dataset.col;
        const width = boundedTriageWidth(columnId, triageColumnWidths[columnId]);
        triageColumnWidths[columnId] = width;
        column.setAttribute("style", `width:${width}px`);
        total += width;
      });
      table.setAttribute("style", `min-width:${total}px`);
    }

    function appendTableColumns(table, columns, presentation, labelFor) {
      if (presentation.triageBoard) {
        table.append(node("colgroup", {}, columns.map((column, index) => node("col", {
          attrs: {
            "data-col": triageColumnId(column, index),
            style: `width:${boundedTriageWidth(triageColumnId(column, index), triageColumnWidths[triageColumnId(column, index)])}px`
          }
        }))));
      }
      table.append(node("thead", {}, node("tr", {}, columns.map((column, index) => {
        const label = labelFor(column);
        return node("th", {
          attrs: {
            scope: "col",
            "data-align": typeof column === "object" ? column.align : undefined,
            "data-col": presentation.triageBoard ? triageColumnId(column, index) : undefined
          }
        }, [
          presentation.triageBoard && index === 0
            ? node("input", { attrs: { type: "checkbox", disabled: true, title: "Select every case shown", "aria-label": "Select every case shown" } })
            : node("span", { text: label }),
          presentation.triageBoard ? node("button", {
            className: "triage-resizer",
            attrs: {
              type: "button", "data-col": triageColumnId(column, index), role: "separator",
              "aria-orientation": "vertical", "aria-label": `Resize ${label || "selection"} column`, tabindex: "0"
            }
          }) : null
        ]);
      }))));
      if (presentation.triageBoard) applyTriageColumnWidths(table);
    }

    function tableBody(table, presentation, rowCount) {
      const tableScroll = node("div", { className: presentation.tableScrollClass }, table);
      if (!presentation.triageBoard) return tableScroll;
      const hasRows = typeof rowCount === "number";
      return node("div", { className: "triage-board-body" }, [
        node("div", { className: "triage-table-tools" }, [
          node("span", { text: hasRows ? `${rowCount} authorized alert row${rowCount === 1 ? "" : "s"} in this view` : "— cases · — alerts in this view" }),
          node("button", { className: "triage-col-reset", text: "Reset columns", attrs: { type: "button" } })
        ]),
        tableScroll,
        node("div", { className: "triage-pager" }, node("span", { text: hasRows ? "Server-bounded result set" : "No result pages" }))
      ]);
    }

    function logStatisticsFields(rawQuery) {
      const match = String(rawQuery || "").match(/\|\s*stats\s+count(?:\s+by\s+([a-z, ]+))?\s*$/i);
      if (!match) return null;
      const allowed = new Set(["src", "dst", "port", "user", "status", "host", "chan", "ua"]);
      const requested = String(match[1] || "").toLowerCase().split(",").map((value) => value.trim()).filter(Boolean);
      return {
        fields: requested.filter((value, index) => allowed.has(value) && requested.indexOf(value) === index),
        invalid: requested.find((value) => !allowed.has(value)) || ""
      };
    }

    function logResultsPanel(panel) {
      const statistics = logStatisticsFields(state.query.get("q"));
      if (statistics && statistics.invalid) {
        return panelShell("stats", node("div", { className: "panel-body logs-stats-state" }, [
          node("span", { className: "badge b-warn", text: "unknown field" }),
          node("p", { className: "muted", text: "Statistics fields are limited to src, dst, port, user, status, host, chan, and ua." })
        ]), "Query not run", undefined, { id: panel.id });
      }
      if (statistics && !statistics.fields.length) {
        return panelShell("stats count", node("div", { className: "panel-body logs-count-result" }, [
          node("span", { className: "stat-value", text: "—" }),
          node("span", { className: "muted", text: "matching events" })
        ]), "No authorized count supplied", undefined, { id: panel.id });
      }

      const columns = statistics
        ? [...statistics.fields, "count", "% of total", "vs top"]
        : ["Time", "Host", "Chan", "Source", "Destination", "Port", "Event (full line)"];
      const title = statistics ? `stats count by ${statistics.fields.join(", ")}` : panel.title;
      const table = node("table", { className: statistics ? "logs-statistics" : "logs-events" });
      table.append(node("caption", { className: "sr-only", text: title }));
      table.append(node("thead", {}, node("tr", {}, columns.map((column) => node("th", { text: column, attrs: { scope: "col" } })))));
      table.append(node("tbody", {}, node("tr", {}, node("td", {
        className: "table-empty muted", text: "No operational records supplied", attrs: { colspan: String(columns.length) }
      }))));
      return panelShell(title, node("div", { className: "table-scroll" }, table), statistics ? "No aggregate supplied" : "Newest first · bounded by the application adapter", undefined, { id: panel.id });
    }

    function lookupStatePanel(panel) {
      const stateRow = node("div", { className: "panel-body lookup-state" }, [
        node("div", { className: "lookup-state-copy" }, [
          node("span", { className: "badge b-muted", text: "lookup state unavailable" }),
          node("p", { className: "muted", text: "No application-authorized enrichment result or provider state was supplied." })
        ]),
        node("div", { className: "form-actions lookup-actions" }, panel.actions.map((action) => node("button", {
          className: "searchbtn", text: action,
          attrs: { type: "button", disabled: true, title: "Connect a separately authorized enrichment command to enable this state-dependent action." }
        })))
      ]);
      const resultTable = panel.resultLabels && panel.resultLabels.length
        ? node("div", { className: "table-scroll lookup-result-structure" }, node("table", { className: "fact-table" }, node("tbody", {},
            panel.resultLabels.map((label) => node("tr", {}, [
              node("th", { className: "nb muted", text: label, attrs: { scope: "row" } }),
              node("td", {}, node("span", { className: "muted", text: "Awaiting authorized lookup data" }))
            ])))))
        : null;
      return panelShell(panel.title, node("div", {}, [stateRow, resultTable]), "Explicit, cached lookup", undefined, { id: panel.id });
    }

    function searchDestination(rawQuery) {
      const query = String(rawQuery || "").trim().slice(0, 240);
      if (!query) return null;
      if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(query)) return { path: "/ip", query: { addr: query }, label: "Open IP investigation" };
      if (/^CVE-\d{4}-\d+$/i.test(query)) return { path: "/kev", query: { cve: query.toUpperCase() }, label: "Open vulnerability detail" };
      if (/^SOC-\d{4}-\d+$/i.test(query)) return { unresolvedCase: true };
      const pageDestinations = [
        [/(?:attest)/i, "/attestations", "Open Attestations"],
        [/(?:register|risk)/i, "/register", "Open Risk Register"],
        [/(?:scan|vuln|trivy|eol)/i, "/scans", "Open Scans"],
        [/(?:system|inventory)/i, "/systems", "Open Systems"],
        [/(?:database|schema)/i, "/databases", "Open Databases"],
        [/(?:backup|s3)/i, "/backups", "Open Backups"],
        [/(?:source|dead)/i, "/sources", "Open Sources"],
        [/(?:brief)/i, "/brief", "Open Daily Brief"],
        [/(?:timeline|chronology)/i, "/timeline", "Open Timeline"],
        [/(?:overview|alert|detection)/i, "/", "Open Overview"],
        [/(?:log)/i, "/logs", "Open Logs"]
      ];
      const page = pageDestinations.find(([pattern]) => pattern.test(query));
      if (page) return { path: page[1], label: page[2] };
      return { path: "/logs", query: { q: query }, label: "Search Security Logs" };
    }

    function searchDispatchPanel(panel) {
      const destination = searchDestination(state.query.get("q"));
      if (!destination) {
        return panelShell(panel.title, node("div", { className: "panel-body search-dispatch-state" }, [
          node("span", { className: "badge b-muted", text: "no query" }),
          node("p", { className: "muted", text: "The application search shell supplies a bounded query before this dispatcher selects a destination." })
        ]), "Navigation only", undefined, { id: panel.id });
      }
      if (destination.unresolvedCase) {
        return panelShell("Case lookup", node("div", { className: "panel-body search-dispatch-state" }, [
          node("span", { className: "badge b-warn", text: "adapter resolution required" }),
          node("p", { className: "muted", text: "Case numbers require an authorized case-index lookup; the public skeleton cannot infer or enumerate cases." })
        ]), "No case record requested", undefined, { id: panel.id });
      }
      return panelShell(panel.title, node("div", { className: "panel-body search-dispatch-state" }, [
        node("span", { className: "badge b-ok", text: "destination selected" }),
        node("a", { className: "resource-action", text: destination.label, attrs: { href: routeHash(destination.path, destination.query) } })
      ]), "Navigation only · no result data rendered here", undefined, { id: panel.id });
    }

    function actionDefinition(action) {
      if (typeof action === "string") return { id: "", label: action };
      if (!action || typeof action !== "object") return { id: "", label: "Unavailable action" };
      return { id: String(action.id || ""), label: String(action.label || action.id || "Action") };
    }

    function scanSetupHash(setupFor) {
      const profile = scanProfilesBySetupFor.get(setupFor);
      return routeHash("/sources", profile ? { stab: "add", setupFor: profile.setupFor } : { stab: "add" });
    }

    function matchingScanManifests(profile) {
      if (!profile || state.controlState !== "ready" || !state.controlSnapshot) return [];
      return state.controlSnapshot.connectorTypes.filter((manifest) => {
        const target = manifest.targets.find((candidate) => candidate.route === "/scans");
        if (!target) return false;
        const surfaces = new Set(target.surfaces);
        const targetKinds = new Set(target.recordKinds);
        const payloadKinds = new Set(manifest.payload.recordKinds);
        return profile.surfaceIds.every((surfaceId) => surfaces.has(surfaceId))
          && profile.requiredRecordKinds.every((recordKind) => targetKinds.has(recordKind) && payloadKinds.has(recordKind));
      });
    }

    function scanProfileTokens(label, values) {
      return node("div", { className: "scan-connection-requirement" }, [
        node("span", { className: "muted", text: label }),
        node("div", { className: "scan-connection-tokens" }, values.map((value) => node("code", { text: value })))
      ]);
    }

    function scanConnectionPrelude(profile) {
      const matches = matchingScanManifests(profile);
      const matchingTypes = new Set(matches.map((manifest) => manifest.connectorType));
      const activeSources = state.controlSnapshot && state.controlState === "ready"
        ? state.controlSnapshot.sources.filter((source) => matchingTypes.has(source.connectorType)) : [];
      const pendingSetups = state.controlSnapshot && state.controlState === "ready"
        ? state.controlSnapshot.setups.filter((source) => matchingTypes.has(source.connectorType)) : [];
      let status = { label: "registry not connected", tone: "b-muted" };
      let detail = "Connect a validated connector control provider to inspect installed manifests.";
      if (state.controlState === "loading") {
        status = { label: "reading registry", tone: "b-muted" };
        detail = "The connector registry is being read.";
      } else if (state.controlState === "error") {
        status = { label: "registry unavailable", tone: "b-warn" };
        detail = "Installed connector coverage cannot be confirmed right now.";
      } else if (state.controlState === "ready" && !matches.length) {
        status = { label: "no installed match", tone: "b-warn" };
        detail = "No installed connector matches this view's exact route, surfaces, and required record kinds.";
      } else if (activeSources.length) {
        status = { label: "connected", tone: "b-ok" };
        detail = `${activeSources.length} active source${activeSources.length === 1 ? "" : "s"} use${activeSources.length === 1 ? "s" : ""} a matching installed manifest.`;
      } else if (pendingSetups.length) {
        status = { label: "setup in progress", tone: "b-warn" };
        detail = `${pendingSetups.length} matching source setup${pendingSetups.length === 1 ? " is" : "s are"} awaiting test or activation.`;
      } else if (matches.length) {
        status = { label: "installed · not configured", tone: "b-muted" };
        detail = `${matches.map((manifest) => manifest.displayName).join(" · ")} matches this view but has no active source.`;
      }
      return node("section", {
        className: "panel scan-connection-profile",
        attrs: { "data-scan-setup-profile": profile.setupFor, "aria-labelledby": "scan-connection-profile-title" }
      }, [
        node("header", { className: "panel-header panel-hd" }, [
          node("span", {
            className: "panel-title",
            text: `Connect · ${profile.title}`,
            attrs: { id: "scan-connection-profile-title", role: "heading", "aria-level": "2" }
          }),
          node("span", { className: `badge ${status.tone}`, text: status.label })
        ]),
        node("div", { className: "panel-body scan-connection-body" }, [
          node("div", { className: "scan-connection-summary" }, [
            node("p", { text: profile.description }),
            node("p", { className: "muted", text: detail })
          ]),
          node("div", { className: "scan-connection-grid" }, [
            scanProfileTokens("Exact /scans target surfaces", profile.surfaceIds),
            scanProfileTokens("Required canonical record kinds", profile.requiredRecordKinds),
            scanProfileTokens("Recommended record kinds", profile.recommendedRecordKinds)
          ]),
          node("div", { className: "scan-connection-actions" }, [
            node("a", {
              className: "resource-action",
              text: "Set up this scan source",
              attrs: { href: scanSetupHash(profile.setupFor), "data-scan-setup-link": profile.setupFor }
            }),
            node("span", { className: "muted", text: "Configuration happens in Sources. This scan view never executes connector commands or accepts credential values." })
          ])
        ])
      ]);
    }

    function scanSetupGuidance() {
      const requested = state.query.get("setupFor");
      const profile = requested ? scanProfilesBySetupFor.get(requested) : null;
      if (!profile) return null;
      const matches = matchingScanManifests(profile);
      const matchCopy = matches.length
        ? `Installed match${matches.length === 1 ? "" : "es"}: ${matches.map((manifest) => `${manifest.displayName} (${manifest.connectorType})`).join(" · ")}. Select one of those connector types and a manifest-declared source kind below.`
        : "No installed manifest currently matches the exact /scans surfaces and required record kinds. Install or implement that connector before source setup can succeed.";
      return node("section", {
        className: "notice scan-setup-guidance",
        attrs: {
          "data-tone": matches.length ? "ok" : "warn",
          "data-scan-setup-guidance": profile.setupFor,
          "aria-labelledby": "scan-setup-guidance-title"
        }
      }, [
        node("div", {}, [
          node("strong", { text: `Scan source setup · ${profile.title}`, attrs: { id: "scan-setup-guidance-title" } }),
          node("span", { text: matchCopy }),
          node("span", { className: "muted", text: `Required: ${profile.requiredRecordKinds.join(", ")}. Credential fields below accept opaque server-side references only, never API keys or secret values.` })
        ])
      ]);
    }

    function controlOptions(field) {
      const snapshot = state.controlSnapshot;
      if (!snapshot || !field.optionsFrom) return [];
      if (field.optionsFrom === "apps") {
        return snapshot.apps.map((item) => ({ value: item.appId, label: item.displayName }));
      }
      if (field.optionsFrom === "hosts") {
        return snapshot.hosts.map((item) => ({
          value: item.hostId,
          appId: item.appId,
          label: item.displayName || item.hostId
        }));
      }
      if (field.optionsFrom === "environments") {
        return snapshot.apps.flatMap((app) => (app.environments || ["default"]).map((environment) => ({
          value: `${app.appId}:${environment}`, appId: app.appId, label: environment
        })));
      }
      if (field.optionsFrom === "connectorTypes") {
        return snapshot.connectorTypes.map((item) => ({
          value: item.connectorType,
          label: item.displayName
        }));
      }
      if (field.optionsFrom === "sourceKinds") {
        const seen = new Set();
        return snapshot.connectorTypes.flatMap((item) => {
          const connectorType = item.connectorType;
          const kinds = item.supportedSourceKinds || [];
          return kinds.map((kind) => {
            const id = typeof kind === "string" ? kind : kind.id || kind.sourceKind;
            const key = `${connectorType}:${id}`;
            if (!id || seen.has(key)) return null;
            seen.add(key);
            return {
              value: key,
              label: `${typeof kind === "string" ? kind : kind.displayName || kind.label || id} · ${item.displayName}`,
              connectorType
            };
          }).filter(Boolean);
        });
      }
      return [];
    }

    function structuralControl(field, inputId, interactive = false) {
      const baseAttributes = { id: inputId, name: field.id || slug(field.label) };
      if (!interactive) baseAttributes.disabled = true;
      if (field.required) baseAttributes.required = true;
      if (field.maxLength !== undefined) baseAttributes.maxlength = String(field.maxLength);
      if (field.min !== undefined) baseAttributes.min = String(field.min);
      if (field.max !== undefined) baseAttributes.max = String(field.max);
      if (field.step !== undefined) baseAttributes.step = String(field.step);
      if (field.type === "textarea") {
        return node("textarea", { attrs: { ...baseAttributes, rows: String(field.lines || 4) } });
      }
      if (field.type === "select") {
        const options = controlOptions(field);
        return node("select", { attrs: baseAttributes }, [
          node("option", { text: interactive && options.length ? "Choose…" : "Awaiting application options", attrs: { value: "" } }),
          ...options.map((option) => node("option", { text: option.label, attrs: {
            value: option.value,
            "data-connector-type": option.connectorType,
            "data-app-id": option.appId
          } }))
        ]);
      }
      const attributes = { ...baseAttributes, type: field.type || "text" };
      if (field.accept) attributes.accept = field.accept;
      return node("input", { attrs: attributes });
    }

    function structuralTable(title, columns, emptyLabel = "No operational records supplied") {
      const table = node("table");
      table.append(node("caption", { className: "sr-only", text: title }));
      table.append(node("thead", {}, node("tr", {}, columns.map((column) => node("th", { text: column, attrs: { scope: "col" } })))));
      table.append(node("tbody", {}, node("tr", {}, node("td", {
        className: "table-empty muted", text: emptyLabel, attrs: { colspan: String(Math.max(columns.length, 1)) }
      }))));
      return node("div", { className: "table-scroll" }, table);
    }

    function factsPanel(panel) {
      const table = node("table", { className: "fact-table" });
      table.append(node("tbody", {}, panel.labels.map((label) => node("tr", {}, [
        node("th", { className: "nb muted", text: label, attrs: { scope: "row" } }),
        node("td", {}, node("span", { className: "muted", text: "Awaiting authorized data" }))
      ]))));
      return panelShell(panel.title, node("div", { className: "table-scroll" }, table), panel.meta || "Data-free structure", undefined, { id: panel.id });
    }

    function analyticsSeriesColor(series, index) {
      const label = String(typeof series === "string" ? series : series.label || "").toLowerCase();
      const tone = typeof series === "string" ? "neutral" : series.tone;
      if (tone === "bad" || label === "critical") return ACTIVE_SEVERITY_COLORS.critical;
      if (tone === "warn" || label === "high") return ACTIVE_SEVERITY_COLORS.high;
      if (tone === "info" || label === "info") return ACTIVE_SEVERITY_COLORS.info;
      return ACTIVE_ANALYTICS_PALETTE[index] || ACTIVE_ANALYTICS_EXHAUSTED;
    }

    function chartLegend(series, includeTotals) {
      return node("div", { className: "chart-legend" }, series.map((entry, index) => {
        const label = typeof entry === "string" ? entry : entry.label;
        const total = typeof entry === "string" ? null : entry.values.reduce((sum, value) => sum + value, 0);
        return node("span", {}, [
          node("i", { attrs: { "aria-hidden": "true", style: `background:${analyticsSeriesColor(entry, index)}` } }),
          label,
          includeTotals ? node("small", { className: "muted", text: String(total) }) : null
        ]);
      }));
    }

    function connectorManifestEditor(manifest, index) {
      const connectorType = manifest.connectorType;
      const fields = [];
      manifest.configFields.forEach((field, fieldIndex) => {
        // The active Sources workflow already owns cadence in hours. The
        // command mapper converts that value for manifests that declare the
        // canonical cadence-seconds field, avoiding two conflicting inputs.
        if (field.key === "cadence-seconds") return;
        const inputId = `connector-${index}-config-${fieldIndex}-${slug(field.key)}`;
        let control;
        const name = `config::${connectorType}::${field.key}`;
        // A required boolean means the property must be present, not that its
        // value must be true. commandValues() always supplies checkbox state,
        // so applying HTML `required` to a checkbox would incorrectly reject
        // a valid false value.
        const required = field.required && field.valueType !== "boolean" ? true : undefined;
        if (field.valueType === "enum") {
          control = node("select", { attrs: { id: inputId, name, required } }, [
            node("option", { text: "Choose…", attrs: { value: "" } }),
            ...field.options.map((option) => node("option", { text: option.label, attrs: { value: option.value } }))
          ]);
        } else {
          const type = field.valueType === "boolean" ? "checkbox"
            : ["integer", "number", "duration-seconds"].includes(field.valueType) ? "number"
              : field.valueType === "endpoint-url" ? "url" : "text";
          control = node("input", { attrs: {
            id: inputId,
            name,
            type,
            required,
            min: field.minimum === undefined ? (field.valueType === "duration-seconds" ? "1" : undefined) : String(field.minimum),
            max: field.maximum === undefined ? undefined : String(field.maximum),
            step: field.valueType === "number" ? "any" : undefined
          } });
        }
        fields.push(node("label", { className: "workflow-field", attrs: { for: inputId } }, [
          node("span", { text: `${field.label}${field.required ? " · required" : ""}` }),
          control,
          field.description ? node("small", { className: "muted", text: field.description }) : null
        ]));
      });
      manifest.credentialSlots.forEach((slot, slotIndex) => {
        const referenceId = `connector-${index}-credential-${slotIndex}-${slug(slot.key)}`;
        const storeId = `${referenceId}-store`;
        fields.push(node("label", { className: "workflow-field", attrs: { for: referenceId } }, [
          node("span", { text: `${slot.label} reference${slot.required ? " · required" : ""}` }),
          node("input", { attrs: {
            id: referenceId,
            name: `credential-ref::${connectorType}::${slot.key}`,
            type: "text",
            required: slot.required ? true : undefined
          } }),
          node("select", { attrs: {
            id: storeId,
            name: `credential-store::${connectorType}::${slot.key}`,
            "aria-label": `${slot.label} credential store`,
            required: slot.required ? true : undefined
          } }, [
            node("option", { text: "Secret manager", attrs: { value: "secret-manager" } }),
            node("option", { text: "Vault", attrs: { value: "vault" } }),
            node("option", { text: "Environment", attrs: { value: "environment" } }),
            node("option", { text: "Host managed", attrs: { value: "host-managed" } })
          ]),
          node("small", { className: "muted", text: slot.description || "Enter a server-side reference, never the credential value." })
        ]));
      });
      const coverage = manifest.targets.map((target) => target.route).join(" · ");
      const editor = node("details", {
        className: "connector-manifest-editor",
        attrs: { hidden: true, "aria-hidden": "true", "data-connector-manifest": connectorType }
      }, [
        node("summary", { text: `${manifest.displayName} configuration` }),
        node("p", { className: "muted", text: manifest.description || "Installed connector manifest" }),
        node("p", { className: "muted", text: `Allows ${manifest.payload.recordKinds.join(", ")} · declared target routes ${coverage}. See Sources → Integrations for actual screen coverage; targets alone do not implement a workflow.` }),
        fields.length ? node("div", { className: "workflow-fields connector-manifest-fields" }, fields)
          : node("p", { className: "muted", text: "This connector needs no additional configuration or credential reference." })
      ]);
      // Every installed manifest is rendered so a connector switch preserves
      // the operator's non-secret draft values in the DOM. Only the selected
      // manifest is enabled, preventing unrelated required fields from taking
      // part in native validation or command serialization.
      editor.hidden = true;
      editor.querySelectorAll("[name]").forEach((control) => {
        control.disabled = true;
        control.setAttribute("disabled", "");
      });
      return editor;
    }

    function syncSourceSetupForm(form, preferredConnectorType) {
      if (!form) return;
      const connector = form.querySelector('[name="connectorType"]');
      const sourceKind = form.querySelector('[name="sourceKind"]');
      if (!connector || !sourceKind) return;
      if (!connector.value && preferredConnectorType) connector.value = preferredConnectorType;
      const connectorType = String(connector.value || "");
      const app = form.querySelector('[name="appId"]');
      if (app && !app.value && state.controlSnapshot.apps.length === 1) app.value = state.controlSnapshot.apps[0].appId;
      for (const name of ["environment", "hostId"]) {
        const select = form.querySelector(`[name="${name}"]`);
        if (!select) continue;
        const matching = [];
        select.querySelectorAll("option").forEach((option) => {
          const owner = option.getAttribute("data-app-id");
          if (!owner) return;
          option.hidden = option.disabled = owner !== (app && app.value);
          if (!option.disabled) matching.push(option);
        });
        if (!matching.some((option) => option.value === select.value)) select.value = name === "environment" && matching.length ? matching[0].value : "";
        if (name === "hostId") {
          const manifest = state.controlSnapshot.connectorTypes.find((item) => item.connectorType === connectorType);
          select.required = Boolean(manifest && manifest.scope === "host");
        }
      }
      form.querySelectorAll("[data-connector-manifest]").forEach((editor) => {
        const active = Boolean(connectorType) && editor.getAttribute("data-connector-manifest") === connectorType;
        editor.hidden = !active;
        editor.open = active;
        if (active) {
          editor.removeAttribute("hidden");
          editor.removeAttribute("aria-hidden");
        } else {
          editor.setAttribute("hidden", "");
          editor.setAttribute("aria-hidden", "true");
        }
        editor.querySelectorAll("[name]").forEach((control) => {
          control.disabled = !active;
          if (active) control.removeAttribute("disabled");
          else control.setAttribute("disabled", "");
        });
      });
      const matchingKinds = [];
      sourceKind.querySelectorAll("option").forEach((option) => {
        const optionConnector = option.getAttribute("data-connector-type");
        if (!optionConnector) {
          option.disabled = false;
          option.removeAttribute("disabled");
          return;
        }
        const active = optionConnector === connectorType;
        option.hidden = !active;
        option.disabled = !active;
        if (active) {
          option.removeAttribute("hidden");
          option.removeAttribute("disabled");
          matchingKinds.push(option);
        } else {
          option.setAttribute("hidden", "");
          option.setAttribute("disabled", "");
        }
      });
      const current = Array.from(sourceKind.querySelectorAll("option"))
        .find((option) => option.value === sourceKind.value);
      const currentConnector = current && current.getAttribute("data-connector-type");
      if (!current || current.disabled || (connectorType && currentConnector !== connectorType)) {
        sourceKind.value = matchingKinds.length === 1 ? matchingKinds[0].value : "";
      }
    }

    function workflowPanel(panel, index) {
      const actions = panel.actions.map(actionDefinition);
      const interactive = Boolean(commands && state.controlState === "ready" && actions.some((action) => action.id));
      const fields = node("div", { className: "workflow-fields" }, panel.fields.map((field, fieldIndex) => {
        const inputId = `workflow-${index}-${fieldIndex}-${slug(field.label)}`;
        return node("label", { className: `workflow-field${field.wide ? " wide" : ""}`, attrs: { for: inputId } }, [
          node("span", { text: field.label }), structuralControl(field, inputId, interactive)
        ]);
      }));
      if (interactive && panel.id === "declare-source") {
        fields.append(node("div", { className: "connector-manifest-editors wide" }, state.controlSnapshot.connectorTypes.map(connectorManifestEditor)));
      }
      const actionNodes = node("div", { className: "workflow-actions" }, actions.map((action) => node("button", {
        className: "searchbtn", text: state.commandPending && action.id ? "Working…" : action.label,
        attrs: {
          type: action.id ? "submit" : "button",
          disabled: !interactive || state.commandPending || !action.id,
          title: interactive ? "The server will authorize and audit this action." : "Connect a server-authorized connector command provider to enable this action.",
          "data-command-action": action.id || undefined
        }
      })));
      const controls = node(interactive ? "form" : "div", {
        className: "workflow-controls",
        attrs: interactive ? { "data-command-form": "" } : {}
      }, [fields, actionNodes]);
      if (interactive && panel.id === "declare-source") {
        const requestedApp = state.controlSnapshot.apps.find(item => item.appId === state.query.get("appId"));
        if (requestedApp) {
          controls.querySelector('[name="appId"]').value = requestedApp.appId;
          if ((requestedApp.environments || ["default"]).includes(state.query.get("environment"))) controls.querySelector('[name="environment"]').value = requestedApp.appId + ":" + state.query.get("environment");
        }
        const profile = scanProfilesBySetupFor.get(state.query.get("setupFor"));
        const matches = profile ? matchingScanManifests(profile) : [];
        const reportImporter = matches.find((manifest) => manifest.connectorType === "trivy-report");
        const requestedType = state.query.get("connectorType");
        const configuredType = state.controlSnapshot.connectorTypes.some((item) => item.connectorType === requestedType) ? requestedType : "";
        syncSourceSetupForm(controls, configuredType || (reportImporter ? reportImporter.connectorType : matches.length === 1 ? matches[0].connectorType : ""));
      }
      const table = panel.columns.length ? structuralTable(panel.title, panel.columns) : null;
      const meta = interactive ? "Server-authorized connector workflow" : panel.meta || "Command boundary";
      return panelShell(panel.title, node("div", { className: "workflow-body" }, panel.tableBefore ? [table, controls] : [controls, table]), meta, undefined, { id: panel.id });
    }

    function settingsPanel(panel, index) {
      if (!panel.fields.length) {
        return panelShell(panel.title, node("div", { className: "settings-empty muted", text: "This board has no portable in-console setting. Its behavior remains owned by the integrating application." }), "No in-console controls", undefined, { id: panel.id });
      }
      const table = node("table", { className: "settings-table" });
      table.append(node("tbody", {}, panel.fields.map((field, fieldIndex) => {
        const inputId = `setting-${index}-${fieldIndex}-${slug(field.label)}`;
        return node("tr", {}, [
          node("th", { className: "nb", attrs: { scope: "row" } }, node("label", { text: field.label, attrs: { for: inputId } })),
          node("td", { className: "nb settings-value" }, structuralControl(field, inputId)),
          node("td", {}, node("span", { className: "muted settings-help", text: "Application-owned value; no environment default is published in this skeleton." }))
        ]);
      })));
      const controls = node("div", { className: "settings-actions" }, [
        node("button", {
          className: "searchbtn", text: `Save ${panel.title}`,
          attrs: { type: "button", disabled: true, title: "Connect a server-authorized settings command to enable this action." }
        }),
        node("span", { className: "muted", text: "No values are bundled with the public skeleton." })
      ]);
      return panelShell(panel.title, node("div", { className: "settings-board" }, [
        node("div", { className: "table-scroll" }, table), controls
      ]), `${panel.fields.length} setting${panel.fields.length === 1 ? "" : "s"}`, undefined, { id: panel.id });
    }

    function sourceHistoryPanel(panel) {
      const searchableKinds = new Set(["log.event", "seclog", "fwlog", "weblog", "dblog", "stripelog", "netlog", "avscan", "execlog"]);
      const lineSource = searchableKinds.has(String(state.query.get("kind") || "").toLowerCase());
      const title = lineSource ? "Recent events" : "Recent pushes";
      const table = node("table", { className: "source-history-table" });
      table.append(node("tbody", {}, node("tr", {}, node("td", {
        className: "table-empty muted", text: lineSource ? "No recent events are stored." : "No recent pushes are stored.", attrs: { colspan: "2" }
      }))));
      return panelShell(title, node("div", { className: "table-scroll" }, table), "Newest first", undefined, { id: panel.id });
    }

    function controlActionButton(action, label, attributes = {}) {
      return node("button", {
        className: "resource-action",
        text: label,
        attrs: {
          type: "button",
          disabled: state.commandPending,
          "data-command-action": action,
          ...attributes
        }
      });
    }

    function snapshotTable(panel, columns, rows, emptyLabel) {
      const table = node("table");
      table.append(node("caption", { className: "sr-only", text: panel.title }));
      table.append(node("thead", {}, node("tr", {}, columns.map((column) => node("th", { text: column, attrs: { scope: "col" } })) )));
      const body = node("tbody");
      if (!rows.length) {
        body.append(node("tr", {}, node("td", { className: "table-empty muted", text: emptyLabel, attrs: { colspan: String(columns.length) } })));
      } else {
        rows.forEach((cells) => body.append(node("tr", { attrs: { "data-filterable": "" } }, cells.map((cell) => node("td", {}, cell)))));
      }
      table.append(body);
      return panelShell(panel.title, node("div", { className: "table-scroll" }, table), `Connector registry · revision ${state.controlSnapshot.revision}`, undefined, { id: panel.id });
    }

    function controlSnapshotPanel(panel) {
      const snapshot = state.controlSnapshot;
      if (!snapshot || state.controlState !== "ready") return null;
      if (panel.id === "registered-apps") {
        const rows = [];
        snapshot.apps.forEach((app) => {
          const appHosts = snapshot.hosts.filter((host) => host.appId === app.appId);
          if (!appHosts.length) rows.push([app.displayName, (app.environments || ["default"]).join(", "), "collector optional", "ready for source setup", node("a", { text: "Add source", attrs: { href: "#/sources?stab=add" } })]);
          appHosts.forEach((host) => rows.push([
            app.displayName,
            `${(app.environments || ["default"]).join(", ")} · ${host.displayName || host.hostId}`,
            host.state,
            host.connectionState,
            host.state === "enrolled" || host.state === "disabled" ? "" : controlActionButton("host.enroll", "Mint token", {
              "data-app-id": app.appId,
              "data-host-id": host.hostId
            })
          ]));
        });
        return snapshotTable(panel, panel.columns, rows, "No applications have been registered.");
      }
      if (panel.id === "pending-source-setups") {
        const rows = snapshot.setups.map((setup) => {
          const manifest = snapshot.connectorTypes.find((item) => item.connectorType === setup.connectorType);
          const canonicalSample = setup.connectorType === "canonical-events" || (manifest && manifest.scope === "application" && manifest.healthPolicy.deliveryMode === "push" && !["canonical-push", "trivy-report"].includes(setup.connectorType));
          const actions = [];
          if (["draft", "configured"].includes(setup.state)) actions.push(node("form", { attrs: { "data-command-form": "" } }, [
            setup.connectorType === "canonical-push" ? node("label", {}, [
              node("span", { text: "Paste a real redacted log message" }),
              node("textarea", { attrs: { name: "sampleMessage", rows: "3", maxlength: "2000", required: !setup.hostId, disabled: state.commandPending } })
            ]) : canonicalSample ? node("label", {}, [
              node("span", { text: "Paste one real redacted normalized record (JSON)" }),
              node("small", { className: "muted", text: "Use sourceId " + setup.sourceId + ", estateId " + setup.appId + ", and an allowed record kind. Keep the redacted sample below 60 KiB. This validates shape without storing the sample or claiming live delivery." }),
              node("textarea", { attrs: { name: "recordSample", rows: "6", maxlength: "60000", required: true, disabled: state.commandPending } })
            ]) : null,
            controlActionButton("source.test", setup.connectorType === "canonical-push" || canonicalSample ? "Validate sample" : "Test connector", {
            type: "submit",
            "data-source-id": setup.sourceId,
            "data-connector-instance-id": setup.connectorInstanceId,
            "data-expected-revision": setup.revision
          })]));
          if (setup.state === "tested") actions.push(controlActionButton("source.activate", "Activate", {
            "data-source-id": setup.sourceId,
            "data-connector-instance-id": setup.connectorInstanceId,
            "data-expected-revision": setup.revision
          }));
          return [setup.displayName, manifest ? manifest.displayName : setup.connectorType, setup.state === "tested" ? "passed" : "required", setup.state, node("div", { className: "form-actions" }, actions)];
        });
        return snapshotTable(panel, panel.columns, rows, "No source setup is waiting for testing or activation.");
      }
      if (panel.id === "configured-sources") {
        const rows = snapshot.sources.map((source) => {
          const manifest = snapshot.connectorTypes.find((item) => item.connectorType === source.connectorType);
          const host = source.hostId && snapshot.hosts.find((item) => item.hostId === source.hostId);
          const recordKinds = manifest && manifest.payload.recordKinds;
          const routes = manifest && manifest.targets.map((target) => target.route);
          const app = snapshot.apps.find((item) => item.appId === source.appId);
          const attributes = { "data-source-id": source.sourceId, "data-connector-instance-id": source.connectorInstanceId, "data-expected-revision": source.revision };
          const actions = [];
          actions.push(node("details", {}, [node("summary", { text: "Sender instructions" }),
            node("p", { text: source.connectorType === "trivy-report"
              ? "Import an existing Trivy JSON report in Scans → Trivy, or submit it from your scanner worker to /api/v1/scanners/trivy/import?sourceId=" + source.sourceId + ". Keep the source credential in that worker's secret store. This service does not launch scans."
              : "Send canonical JSON batches from your application's server or worker to /api/v1/ingest over the private connection. Keep the ingest credential in that sender's secret store." }),
            node("p", {}, [node("strong", { text: "Source ID: " }), node("code", { text: source.sourceId })]),
            node("p", {}, [node("strong", { text: "Application scope (estateId): " }), node("code", { text: source.appId })]),
            node("p", {}, [node("strong", { text: "Environment: " }), node("code", { text: source.environment || "default" })]),
            node("p", { text: "Use a stable recordId for each event and a stable receiptId when retrying the same exact batch. A sample validation checks shape; only accepted live delivery marks collection healthy." }),
            node("a", { text: "Exact event and batch schema", attrs: { href: "#/docs" } })
          ]));
          actions.push(node("a", { className: "resource-action", text: "Received observations", attrs: { href: "#/sources?stab=observations&sourceId=" + encodeURIComponent(source.sourceId) } }));
          if (source.state === "active") actions.push(controlActionButton("source.pause", "Pause", attributes));
          if (source.state === "paused") actions.push(controlActionButton("source.resume", "Resume", attributes));
          if (["active", "paused"].includes(source.state)) {
            actions.push(controlActionButton("source.rotate", "Rotate credential", attributes), controlActionButton("source.revoke", "Revoke access", attributes), controlActionButton("source.archive", "Archive", attributes));
            actions.push(node("details", {}, [node("summary", { text: "Edit source" }),
              node("form", { attrs: { "data-command-form": "" } }, [
                node("label", {}, [node("span", { text: "Name" }), node("input", { attrs: { name: "displayName", value: source.displayName, required: true, maxlength: "120" } })]),
                node("label", {}, [node("span", { text: "Cadence (seconds)" }), node("input", { attrs: { name: "cadenceSeconds", type: "number", min: "60", max: "31536000", value: source.config["cadence-seconds"], required: true } })]),
                node("p", { className: "muted", text: "Saving pauses collection, revokes existing credentials, and requires sample validation and activation again." }),
                controlActionButton("source.update", "Save and revalidate", { ...attributes, type: "submit" })
              ])
            ]));
          }
          if (source.state === "archived") actions.push(controlActionButton("source.remove", "Remove (retain history)", attributes));
          return [
            source.displayName,
            `${app ? app.displayName : source.appId} / ${source.environment || "default"}${host ? ` · ${host.displayName}` : ""}`,
            manifest ? manifest.displayName : source.connectorType,
            Array.isArray(recordKinds) ? recordKinds.map((item) => typeof item === "string" ? item : item.kind || item.id).filter(Boolean).join(", ") : "declared by manifest",
            Array.isArray(routes) ? routes.join(", ") : "declared by manifest",
            source.state,
            node("div", { className: "form-actions" }, actions)
          ];
        });
        return snapshotTable(panel, panel.columns, rows, "No source has been activated.");
      }
      if (panel.id === "source-registry-changes") {
        const rows = snapshot.changes.slice().reverse().map((change) => [
          node("time", {
            text: new Intl.DateTimeFormat(undefined, {
              dateStyle: "medium", timeStyle: "short", timeZone: state.timezone === "UTC" ? "UTC" : undefined
            }).format(new Date(change.at)),
            attrs: { datetime: change.at }
          }),
          change.action,
          change.resourceId,
          change.message || change.status,
          "connector service"
        ]);
        return snapshotTable(panel, panel.columns, rows, "No connector registry changes have been recorded.");
      }
      return null;
    }

    function renderCatalogPanel(panel, index) {
      if (panel.id === "connect-host") return node("details", { className: "connector-collector-tools" }, [
        node("summary", { text: "Optional collector setup for host-based integrations" }), workflowPanel(panel, index)
      ]);
      if (["application-source-start", "connect-each-host"].includes(panel.id)) {
        return panelShell(panel.title, node("div", { className: "panel-body" }, [
          node("p", { text: "Register your application and its environments, then choose a source. Application log push works without an enrolled host; scanners may require a collector." }),
          node("a", { className: "resource-action", text: panel.id === "connect-each-host" ? "Add a source" : "Add an application", attrs: { href: panel.id === "connect-each-host" ? "#/sources?stab=add" : "#/onboard" } }),
          node("a", { className: "resource-action", text: "Monitor my application — guided setup", attrs: { href: "#/sources?stab=setup" } })
        ]), "Application setup", undefined, { id: panel.id });
      }
      if (panel.type === "log-results") return logResultsPanel(panel);
      if (panel.type === "search-dispatch") return searchDispatchPanel(panel);
      if (panel.type === "lookup") return lookupStatePanel(panel);
      if (panel.type === "facts") return factsPanel(panel);
      if (panel.type === "workflow") return workflowPanel(panel, index);
      if (panel.type === "settings") return settingsPanel(panel, index);
      if (panel.type === "source-history") return sourceHistoryPanel(panel);
      const controlPanel = controlSnapshotPanel(panel);
      if (controlPanel) return controlPanel;
      if (panel.type === "metrics") {
        if (isTuningSurface()) {
          return tuningSummary(panel.labels.map((label) => ({ label, value: "—" })), panel.id);
        }
        if (state.route === "/phishing" && !state.query.get("id")) {
          return phishingSummary(panel.labels.map((label) => ({ label, value: "—" })), panel.id);
        }
        return node("section", { className: `metric-grid statrow${state.route === "/" ? " soc-overview-kpis" : ""}`, attrs: { "aria-label": "Summary metrics", "data-panel-id": panel.id } }, panel.labels.map((label) => node("article", {
          className: "metric-card tile stat",
          attrs: { "data-filterable": "" }
        }, [
          node("div", { className: "metric-label stat-label", text: label }),
          node("div", { className: "metric-value stat-value", text: "—" }),
          node("div", { className: "metric-note stat-sub", text: "Awaiting authorized data" })
        ])));
      }
      if (panel.type === "table") {
        const presentation = tablePresentation(panel);
        const panelTitle = presentation.triageBoard ? triageBoardHeading() : panel.title;
        const table = node("table", { className: presentation.tableClasses, attrs: { id: presentation.triageBoard ? "triage-table" : undefined } });
        table.append(node("caption", { className: "sr-only", text: panelTitle }));
        appendTableColumns(table, panel.columns, presentation, (column) => column);
        table.append(node("tbody", {}, node("tr", { attrs: { "data-filterable": "" } }, node("td", {
          className: presentation.triageBoard ? "table-empty muted" : "table-empty",
          text: presentation.triageBoard ? "Nothing in this view." : "No operational records supplied",
          attrs: { colspan: String(Math.max(panel.columns.length, 1)) }
        }))));
        const body = tableBody(table, presentation);
        const panelBody = state.route === "/event" && isEventAccordion(panel.title)
          ? eventAccordion(panel.title, body, panel.title === "Related detections in this case")
          : body;
        const panelMeta = presentation.triageBoard
          ? "— cases · 25 cases per page · drag a header edge to resize"
          : panel.meta || (panel.rowDisclosures && panel.rowDisclosures.length
            ? `Row disclosure · ${panel.rowDisclosures.join(" · ")}`
            : "Empty structure");
        return panelShell(panelTitle, panelBody, panelMeta, undefined, { id: panel.id, className: presentation.panelClasses });
      }
      if (panel.type === "form") {
        const formActions = panel.actions.map(actionDefinition);
        const interactive = Boolean(commands && state.controlState === "ready" && formActions.some((action) => action.id));
        const fields = node("div", { className: "form-grid" });
        const reconciliationStyle = panel.id === "provider-reconciliation-actions"
          ? "background:#171d21;border:1px solid #454a4e;color:#e5e8ea;padding:6px 8px;border-radius:3px"
          : undefined;
        panel.fields.forEach((field, fieldIndex) => {
          const inputId = `field-${index}-${fieldIndex}-${slug(field.label)}`;
          const common = { id: inputId, name: field.id || slug(field.label) };
          if (!interactive) common.disabled = true;
          if (field.required) common.required = true;
          if (field.maxLength !== undefined) common.maxlength = String(field.maxLength);
          if (field.min !== undefined) common.min = String(field.min);
          if (field.max !== undefined) common.max = String(field.max);
          if (field.step !== undefined) common.step = String(field.step);
          let control;
          if (field.type === "textarea") {
            control = node("textarea", { attrs: { ...common, rows: String(field.lines || 4), style: reconciliationStyle } });
          } else if (field.type === "select") {
            const options = controlOptions(field);
            control = node("select", { attrs: common }, [
              node("option", { text: interactive && options.length ? "Choose…" : "Awaiting application options", attrs: { value: "" } }),
              ...options.map((option) => node("option", { text: option.label, attrs: { value: option.value } }))
            ]);
          } else {
            const attributes = { ...common, type: field.type || "text" };
            if (field.accept) attributes.accept = field.accept;
            if (reconciliationStyle && field.type !== "checkbox") attributes.style = reconciliationStyle;
            control = node("input", { attrs: attributes });
          }
          fields.append(node("label", { className: `form-field${field.wide ? " wide" : ""}`, attrs: {
            for: inputId,
            style: reconciliationStyle && field.type === "checkbox" ? "color:#c7cbce" : undefined
          } }, [
            node("span", { text: field.label }), control
          ]));
        });
        const actions = node("div", { className: "form-actions" }, formActions.map((action) => node("button", {
          className: "resource-action",
          text: state.commandPending && action.id ? "Working…" : action.label,
          attrs: {
            type: action.id ? "submit" : "button",
            disabled: !interactive || state.commandPending || !action.id,
            title: interactive ? "The server will authorize and audit this action." : "Connect a server-authorized command adapter to enable this action.",
            "data-command-action": action.id || undefined
          }
        })));
        const formClasses = [
          state.route === "/tuning" ? "tune-card" : "",
          state.route === "/triage" && panel.title === "Bulk disposition" ? "triage-bulk" : ""
        ].filter(Boolean).join(" ");
        const body = node(interactive ? "form" : "div", {
          className: "panel-body skeleton-form",
          attrs: interactive ? { "data-command-form": "" } : {}
        }, [fields, actions]);
        return panelShell(panel.title, body, interactive ? "Server-authorized connector workflow" : panel.meta || "Command boundary", undefined, { id: panel.id, className: formClasses });
      }
      if (panel.type === "chart") {
        const legend = chartLegend(panel.series || [], false);
        return panelShell(panel.title, node("div", { className: "panel-body chart-shell stacked-bars" }, [
          node("div", { className: "empty-chart", attrs: { "aria-label": "No chart data supplied" } }, node("span", { text: "No measured series" })),
          legend
        ]), "No measurements", undefined, { id: panel.id });
      }
      if (panel.type === "bars") {
        return panelShell(panel.title, node("div", { className: "panel-body" }, emptyCopy("ranked measurements")), "No measurements", undefined, { id: panel.id });
      }
      if (panel.type === "timeline") {
        return panelShell(panel.title, node("div", { className: "panel-body" }, emptyCopy("timeline events")), "No events", undefined, { id: panel.id });
      }
      if (panel.type === "cards") {
        if (state.route === "/event" && panel.title === "Decision status") {
          return eventStatusPanel(panel.labels.map((label) => ({ label, value: "—", tone: "neutral" })), panel.id);
        }
        if (state.route === "/phishing" && state.query.get("id")) {
          const specialized = phishingCardPanel(panel);
          if (specialized) return specialized;
        }
        if (state.route === "/alerts" && panel.title === "Alert path") {
          return alertPathPanel([], panel.id);
        }
        return panelShell(panel.title, node("div", { className: "panel-body structure-cards" }, panel.labels.map((label) => node("article", {
          className: "structure-card",
          attrs: { "data-filterable": "" }
        }, [node("span", { text: label }), node("strong", { text: "—" })]))), "Structure", undefined, { id: panel.id });
      }
      if (state.route === "/event" && panel.title === "Analyst findings") {
        return eventAnalystPanel(panel);
      }
      if (state.route === "/intel" && ["ThreatFox", "URLhaus", "MalwareBazaar"].includes(panel.title)) {
        return panelShell(panel.title, node("div", { className: "intel-source-status" }, [
          node("span", { className: "badge b-muted", text: "awaiting source" }),
          node("span", { className: "muted", text: "No authorized source-health or freshness record was supplied." })
        ]), "Indicator source", undefined, { id: panel.id });
      }
      if (state.route === "/access" && state.query.get("atab") === "offboarding" && state.query.get("id") && panel.title === "Manual steps") {
        return offboardingManualStepsPanel(panel);
      }
      return panelShell(panel.title, node("div", { className: "panel-body" }, [
        node("p", { className: "muted", text: "This explanatory surface is present without environment-specific copy or evidence." })
      ]), "Data-free", undefined, { id: panel.id });
    }

    function renderCell(value) {
      if (value === null || value === undefined) return node("span", { className: "muted", text: "—" });
      if (typeof value !== "object") return node("span", { text: String(value) });
      if (value.type === "badge") return node("span", { className: "pill", text: value.label, attrs: { "data-tone": value.tone } });
      if (value.type === "time") {
        const display = value.display || new Intl.DateTimeFormat(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: state.timezone === "UTC" ? "UTC" : undefined
        }).format(new Date(value.value));
        return node("time", { text: display, attrs: { datetime: value.value } });
      }
      if (value.type === "number") return node("span", { className: "mono", text: `${value.value}${value.unit ? ` ${value.unit}` : ""}` });
      if (value.type === "link") return node("a", { text: value.label, attrs: { href: routeHash(value.route, value.query) } });
      return node("span", { text: value.text });
    }

    function adapterTableNode(panel, className = "") {
      const table = node("table", { className });
      table.append(node("caption", { className: "sr-only", text: panel.caption || panel.title || "Authorized table" }));
      table.append(node("thead", {}, node("tr", {}, panel.columns.map((column) => node("th", {
        text: column.label,
        attrs: { scope: "col", "data-align": column.align }
      })))));
      const body = node("tbody");
      if (!panel.rows.length) {
        body.append(node("tr", {}, node("td", {
          className: "table-empty",
          text: "No rows returned",
          attrs: { colspan: String(panel.columns.length) }
        })));
      } else {
        panel.rows.forEach((row) => body.append(node("tr", { attrs: { "data-filterable": "" } },
          row.map((cell, index) => node("td", {
            attrs: { "data-align": panel.columns[index].align }
          }, renderCell(cell))))));
      }
      table.append(body);
      return table;
    }

    function adapterTimelineList(panel) {
      if (!panel.items.length) return emptyCopy("timeline events");
      return node("ol", { className: "timeline-list" }, panel.items.map((item) => {
        const time = new Intl.DateTimeFormat(undefined, {
          dateStyle: "medium", timeStyle: "short", timeZone: state.timezone === "UTC" ? "UTC" : undefined
        }).format(new Date(item.at));
        return node("li", { className: "timeline-item", attrs: { "data-tone": item.tone, "data-filterable": "" } }, [
          node("time", { className: "timeline-time", text: time, attrs: { datetime: item.at } }),
          node("span", { className: "timeline-rail" }, node("i", { className: "timeline-dot" })),
          node("span", { className: "timeline-copy" }, [
            node("strong", { text: item.label }),
            item.detail ? node("span", { text: item.detail }) : null
          ])
        ]);
      }));
    }

    function metricItemsByLabel(panel) {
      return new Map(panel && panel.type === "metrics"
        ? panel.items.map((item) => [item.label, item])
        : []);
    }

    function metricValue(item, fallback = "—") {
      return item ? String(item.value) : fallback;
    }

    function detailSlot(catalogPanels, takeSupplied, id) {
      const slot = catalogPanels.find((panel) => panel.id === id) || null;
      return { slot, supplied: slot ? takeSupplied(slot) : null };
    }

    function specializedSlotId(detail, expectedTypes) {
      const allowed = Array.isArray(expectedTypes) ? expectedTypes : [expectedTypes];
      return detail.slot && (!detail.supplied || allowed.includes(detail.supplied.type))
        ? detail.slot.id
        : undefined;
    }

    function phishingVerdictMetrics(panel, slotPanel) {
      const items = metricItemsByLabel(panel);
      const verdict = items.get("Verdict");
      const score = items.get("Score");
      const reserved = new Set(["Verdict", "Score"]);
      const labels = (slotPanel.labels || []).filter((label) => !reserved.has(label));
      panel.items.forEach((item) => {
        if (!reserved.has(item.label) && !labels.includes(item.label)) labels.push(item.label);
      });
      return panelShell("Verdict", withPanelDescription(panel, node("div", { className: "phishing-verdict" }, [
        node("div", { className: "phishing-verdict-primary" }, [
          node("span", {
            className: "badge",
            text: metricValue(verdict, "Awaiting authorized verdict"),
            attrs: { "data-tone": verdict ? verdict.tone : "neutral" }
          }),
          node("strong", { text: metricValue(score) }),
          node("small", { text: (verdict && verdict.detail) || (score && score.detail) || "No message score supplied" })
        ]),
        node("div", { className: "phishing-verdict-facts" }, labels.map((label) => {
          const item = items.get(label);
          return node("article", { attrs: { "data-tone": item ? item.tone : "neutral" } }, [
            node("span", { text: label }), node("strong", { text: metricValue(item) }),
            item && item.detail ? node("small", { text: item.detail }) : null
          ]);
        }))
      ])), panel.description || "Authorized report", undefined, { id: panel.id });
    }

    function phishingPassiveMetrics(panel, slotPanel) {
      const items = metricItemsByLabel(panel);
      const labels = (slotPanel.labels || []).slice();
      panel.items.forEach((item) => { if (!labels.includes(item.label)) labels.push(item.label); });
      return panelShell(slotPanel.title, withPanelDescription(panel, node("div", { className: "phishing-intel-grid" },
        labels.map((label) => {
          const item = items.get(label);
          return node("section", { className: "phishing-intel-source", attrs: { "data-tone": item ? item.tone : "neutral" } }, [
            node("h3", { text: label }),
            node("strong", { text: metricValue(item) }),
            item && item.detail ? node("p", { className: "muted", text: item.detail }) : null
          ]);
        }))), "Passive only", undefined, { id: panel.id });
    }

    function phishingMessageBody(panel) {
      if (panel.type === "text") {
        return panelShell(panel.title || "Message body", node("div", { className: "phishing-body-grid" },
          node("section", {}, [
            node("h3", { text: panel.title || "Message source" }),
            node("pre", { className: "md-pre phishing-message-source", text: panel.body })
          ])), "Source text is never rendered as HTML", panel.tone, { id: panel.id });
      }
      const body = panel.rows.length
        ? panel.rows.map((row) => node("section", {}, [
            node("h3", {}, renderCell(row[0])),
            node("pre", { className: "md-pre phishing-message-source" }, row.slice(1).flatMap((cell, index) => [
              index ? "\n" : "", renderCell(cell)
            ]))
          ]))
        : node("p", { className: "muted", text: "No authorized message body rows returned." });
      return panelShell(panel.title || "Message body", node("div", { className: "phishing-body-grid" }, body),
        "Source text is never rendered as HTML", undefined, { id: panel.id });
    }

    function withPanelDescription(panel, content) {
      if (!panel.description) return content;
      return node("div", { className: "adapter-panel-content" }, [
        node("p", { className: "panel-description", text: panel.description }),
        content
      ]);
    }

    function stackedChartPanel(panel, slotPanel) {
      const title = panel.title || (slotPanel && slotPanel.title) || "Time series";
      if (!panel.buckets.length || !panel.series.length) {
        return panelShell(title, withPanelDescription(panel, node("div", { className: "panel-body chart-shell" }, [
          node("div", { className: "empty-chart", attrs: { "aria-label": "No chart data supplied" } }, node("span", { text: "No measured series" })),
          chartLegend(panel.series, true)
        ])), "No measurements", undefined, { id: panel.id });
      }
      const width = 1200;
      const height = /detections per hour/i.test(title) ? 150 : 190;
      const padLeft = 44;
      const padRight = 8;
      const padTop = 10;
      const padBottom = 22;
      const plotWidth = width - padLeft - padRight;
      const plotHeight = height - padTop - padBottom;
      const totals = panel.buckets.map((_bucket, bucketIndex) => panel.series.reduce(
        (sum, series) => sum + series.values[bucketIndex], 0
      ));
      const maximum = Math.max(1, ...totals);
      const magnitude = 10 ** Math.floor(Math.log10(maximum));
      const step = magnitude * (maximum / magnitude > 5 ? 2 : 1);
      const top = Math.ceil(maximum / step) * step || 1;
      const barWidth = plotWidth / panel.buckets.length;
      const y = (value) => padTop + plotHeight - (value / top) * plotHeight;
      const svg = svgNode("svg", {
        viewBox: `0 0 ${width} ${height}`,
        width: "100%",
        height: String(height),
        role: "img",
        "aria-label": `${title}, ${panel.buckets.length} time buckets`,
        class: "stacked-chart"
      });
      for (let gridIndex = 0; gridIndex <= 2; gridIndex += 1) {
        const value = (top / 2) * gridIndex;
        const gridY = y(value).toFixed(1);
        svg.append(svgNode("line", {
          x1: padLeft, x2: width - padRight, y1: gridY, y2: gridY,
          stroke: "#33373b", "stroke-width": "1"
        }));
        svg.append(svgNode("text", {
          x: padLeft - 6, y: (y(value) + 3.5).toFixed(1),
          "text-anchor": "end", "font-size": "10", fill: "#8c9296"
        }, value >= 1000 ? `${value / 1000}k` : String(value)));
      }
      panel.buckets.forEach((bucket, bucketIndex) => {
        let accumulated = 0;
        panel.series.forEach((series, seriesIndex) => {
          const value = series.values[bucketIndex];
          if (!value) return;
          const yTop = y(accumulated + value);
          const yBottom = y(accumulated);
          const segmentHeight = Math.max(1, yBottom - yTop - (accumulated > 0 ? 2 : 0));
          svg.append(svgNode("rect", {
            x: (padLeft + bucketIndex * barWidth + 0.5).toFixed(1),
            y: yTop.toFixed(1),
            width: Math.max(1, barWidth - 1.5).toFixed(1),
            height: segmentHeight.toFixed(1),
            fill: analyticsSeriesColor(series, seriesIndex),
            rx: "1"
          }, svgNode("title", {}, `${series.label} — ${value} ${panel.unit || "events"}\n${bucket}`)));
          accumulated += value;
        });
      });
      const tickStep = Math.max(1, Math.round(panel.buckets.length / 8));
      panel.buckets.forEach((bucket, bucketIndex) => {
        if (bucketIndex % tickStep) return;
        const when = new Date(bucket);
        svg.append(svgNode("text", {
          x: (padLeft + bucketIndex * barWidth + barWidth / 2).toFixed(1),
          y: height - 6,
          "text-anchor": "middle", "font-size": "10", fill: "#8c9296"
        }, String(when.getUTCHours()).padStart(2, "0")));
      });
      const dataTable = node("table", {}, [
        node("thead", {}, node("tr", {}, [
          node("th", { text: "Bucket", attrs: { scope: "col" } }),
          ...panel.series.map((series) => node("th", { text: series.label, attrs: { scope: "col" } }))
        ])),
        node("tbody", {}, panel.buckets.map((bucket, bucketIndex) => node("tr", {}, [
          node("th", { className: "nb", attrs: { scope: "row" } }, node("time", { text: bucket, attrs: { datetime: bucket } })),
          ...panel.series.map((series) => node("td", { className: "nb", text: String(series.values[bucketIndex]) }))
        ])))
      ]);
      const exhausted = panel.series.filter((series, index) => !["bad", "warn", "info"].includes(series.tone)
        && !["critical", "high", "info"].includes(series.label.toLowerCase()) && index >= ACTIVE_ANALYTICS_PALETTE.length);
      const content = node("div", { className: "panel-body chart-shell" }, [
        exhausted.length ? node("div", { className: "chart-palette-warning" }, [
          node("span", { className: "badge b-bad", text: "palette exhausted" }),
          node("span", { className: "muted", text: " Additional series are drawn grey; labels and the data table remain authoritative." })
        ]) : null,
        chartLegend(panel.series, true),
        svg,
        node("details", { className: "chart-data" }, [
          node("summary", { text: "View chart data" }),
          node("div", { className: "table-scroll" }, dataTable)
        ])
      ]);
      return panelShell(title, withPanelDescription(panel, content),
        `${panel.buckets.length} buckets · ${panel.series.length} series`, undefined, { id: panel.id });
    }

    function renderAdapterPanel(panel, slotPanel) {
      if (state.route === "/phishing" && state.query.get("id") && slotPanel) {
        if (slotPanel.id === "verdict" && panel.type === "metrics") {
          return phishingVerdictMetrics(panel, slotPanel);
        }
        if (slotPanel.id === "passive-intel" && panel.type === "metrics") {
          return phishingPassiveMetrics(panel, slotPanel);
        }
        if (slotPanel.id === "message-body" && ["table", "text"].includes(panel.type)) {
          return phishingMessageBody(panel);
        }
      }
      if (panel.type === "notice") {
        return node("section", { className: "notice", attrs: { "data-tone": panel.tone, "data-filterable": "", "data-panel-id": panel.id } }, [
          node("strong", { text: panel.title }), node("span", { text: panel.body })
        ]);
      }
      if (panel.type === "metrics") {
        if (isTuningSurface() && slotPanel && slotPanel.type === "metrics") {
          return tuningSummary(panel.items, panel.id, panel.description);
        }
        if (state.route === "/phishing" && !state.query.get("id") && slotPanel && slotPanel.type === "metrics") {
          return phishingSummary(panel.items, panel.id, panel.description);
        }
        if (state.route === "/event" && slotPanel && slotPanel.title === "Decision status") {
          return eventStatusPanel(panel.items, panel.id, panel.description);
        }
        if (state.route === "/alerts" && slotPanel && slotPanel.title === "Alert path") {
          return alertPathPanel(panel.items, panel.id, panel.description);
        }
        const metrics = node("section", { className: `metric-grid statrow${state.route === "/" ? " soc-overview-kpis" : ""}`, attrs: { "aria-label": panel.title || "Authorized metrics", "data-panel-id": panel.description ? undefined : panel.id } }, panel.items.map((item) => node("article", {
          className: "metric-card tile stat",
          attrs: { "data-tone": item.tone, "data-filterable": "" }
        }, [
          node("div", { className: "metric-label stat-label", text: item.label }),
          node("div", { className: "metric-value stat-value", text: item.value }),
          item.detail ? node("div", { className: "metric-note stat-sub", text: item.detail }) : null
        ])));
        if (!panel.description) return metrics;
        return node("div", { className: "adapter-panel-group", attrs: { "data-panel-id": panel.id } }, withPanelDescription(panel, metrics));
      }
      if (panel.type === "table") {
        const presentation = tablePresentation(slotPanel);
        const panelTitle = presentation.triageBoard ? triageBoardHeading() : panel.title || panel.caption;
        const table = node("table", { className: presentation.tableClasses, attrs: { id: presentation.triageBoard ? "triage-table" : undefined } });
        table.append(node("caption", { className: "sr-only", text: presentation.triageBoard ? panelTitle : panel.caption }));
        appendTableColumns(table, panel.columns, presentation, (column) => column.label);
        const body = node("tbody");
        if (!panel.rows.length) {
          body.append(node("tr", {}, node("td", { className: "table-empty", text: "No rows returned", attrs: { colspan: panel.columns.length } })));
        } else {
          panel.rows.forEach((row, rowIndex) => {
            const disclosure = panel.disclosures ? panel.disclosures[rowIndex] : null;
            const sourceDisclosure = disclosure && slotPanel && slotPanel.id === "expected-sources";
            const drillDisclosure = disclosure && slotPanel && slotPanel.id === "detection-drills-last-proven-fire-per-layer";
            const disclosureId = `${panel.id}-row-${rowIndex}-details`;
            const tableRow = node("tr", {
              className: presentation.triageBoard ? "triage-parent" : "",
              attrs: { "data-filterable": "" }
            });
            row.forEach((cell, index) => {
              const content = renderCell(cell);
              const cellNode = node("td", {
                className: presentation.triageBoard ? ["", "", "muted", "muted", "", "", "triage-alert", "triage-status", "triage-owner", "triage-activity", "triage-agent-action"][index] : "",
                attrs: { "data-align": panel.columns[index].align }
              });
              if (sourceDisclosure && index === 0) {
                append(cellNode, [node("button", {
                  className: "grptoggle srctoggle", text: "?",
                  attrs: { type: "button", "aria-expanded": "false", "aria-controls": disclosureId, title: "explain this source" }
                }), " ", content]);
              } else {
                cellNode.append(content);
              }
              if (drillDisclosure && index === 1) {
                cellNode.append(node("details", { className: "drill-how" }, [
                  node("summary", { text: disclosure.label || "How to drill" }),
                  node("div", { className: "adapter-disclosure-items" }, disclosure.items.map((item) => node("section", {}, [
                    disclosure.items.length > 1 ? node("b", { text: item.label }) : null,
                    node("pre", { text: item.text })
                  ])))
                ]));
              }
              tableRow.append(cellNode);
            });
            body.append(tableRow);
            if (sourceDisclosure) {
              body.append(node("tr", { className: "srcinfo", attrs: { id: disclosureId, style: "display:none" } }, node("td", {
                attrs: { colspan: String(panel.columns.length) }
              }, node("div", { className: "adapter-disclosure-items" }, disclosure.items.map((item) => node("p", {}, [
                node("b", { text: `${item.label}.` }), " ", item.text
              ]))))));
            } else if (disclosure && !drillDisclosure) {
              body.append(node("tr", { className: "adapter-disclosure-row" }, node("td", {
                attrs: { colspan: String(panel.columns.length) }
              }, node("details", {}, [
                node("summary", { text: disclosure.label }),
                node("div", { className: "adapter-disclosure-items" }, disclosure.items.map((item) => node("p", {}, [
                  node("b", { text: `${item.label}.` }), " ", item.text
                ])))
              ]))));
            }
          });
        }
        table.append(body);
        const content = withPanelDescription(panel, tableBody(table, presentation, panel.rows.length));
        const panelBody = state.route === "/event" && slotPanel && isEventAccordion(slotPanel.title)
          ? eventAccordion(slotPanel.title, content, slotPanel.title === "Related detections in this case")
          : content;
        return panelShell(
          panelTitle,
          panelBody,
          presentation.triageBoard
            ? `${panel.rows.length} authorized alerts · 25 cases per page · drag a header edge to resize`
            : `${panel.rows.length} rows`,
          undefined,
          { id: panel.id, className: presentation.panelClasses }
        );
      }
      if (panel.type === "timeline") {
        const list = node("ol", { className: "timeline-list" });
        panel.items.forEach((item) => {
          const time = new Intl.DateTimeFormat(undefined, {
            hour: "2-digit", minute: "2-digit", timeZone: state.timezone === "UTC" ? "UTC" : undefined
          }).format(new Date(item.at));
          list.append(node("li", { className: "timeline-item", attrs: { "data-tone": item.tone, "data-filterable": "" } }, [
            node("time", { className: "timeline-time", text: time, attrs: { datetime: item.at } }),
            node("span", { className: "timeline-rail" }, node("i", { className: "timeline-dot" })),
            node("span", { className: "timeline-copy" }, [node("strong", { text: item.label }), item.detail ? node("span", { text: item.detail }) : null])
          ]));
        });
        return panelShell(panel.title || "Timeline", withPanelDescription(panel, node("div", { className: "panel-body" }, panel.items.length ? list : emptyCopy("timeline events"))), `${panel.items.length} events`, undefined, { id: panel.id });
      }
      if (panel.type === "chart") return stackedChartPanel(panel, slotPanel);
      if (panel.type === "bars") {
        const rankedColor = slotPanel && /Most-blocked source addresses/i.test(slotPanel.title)
          ? ACTIVE_ANALYTICS_PALETTE[1] : ACTIVE_ANALYTICS_SEQUENCE;
        const list = node("ul", { className: "adapter-bars" }, panel.items.map((item) => node("li", {
          attrs: { "data-tone": item.tone, "data-filterable": "" }
        }, [node("span", { text: item.label }), node("meter", { attrs: { min: "0", max: item.max, value: item.value, style: `accent-color:${rankedColor}` } }), node("span", { className: "mono", text: item.value })])));
        return panelShell(panel.title || "Distribution", withPanelDescription(panel, node("div", { className: "panel-body" }, list)), `${panel.items.length} series`, undefined, { id: panel.id });
      }
      if (panel.type === "empty") return panelShell(panel.title, node("div", { className: "panel-body empty-inline" }, [
        node("span", { className: "empty-glyph", text: "◇", attrs: { "aria-hidden": "true" } }),
        node("p", { text: panel.body })
      ]), "Empty", undefined, { id: panel.id });
      return panelShell(panel.title || "Authorized copy", withPanelDescription(panel, node("div", { className: "panel-body" }, node("p", { text: panel.body }))), "Adapter", panel.tone, { id: panel.id });
    }

    function tabTargetQuery(page, tabset, item) {
      if (item.path) return item.query || {};
      const targetQuery = queryObject(state.query);
      const tabsetsByParameter = new Map((page.tabsets || []).map((candidate) => [candidate.param, candidate]));
      const ancestorParameters = new Set();
      const pendingAncestors = Object.keys(tabset.when || {});
      while (pendingAncestors.length) {
        const parameter = pendingAncestors.shift();
        if (ancestorParameters.has(parameter)) continue;
        ancestorParameters.add(parameter);
        const ancestor = tabsetsByParameter.get(parameter);
        if (ancestor) pendingAncestors.push(...Object.keys(ancestor.when || {}));
      }
      (page.tabsets || []).forEach((candidate) => {
        if (!ancestorParameters.has(candidate.param)) delete targetQuery[candidate.param];
      });
      [tabset, ...Array.from(ancestorParameters).map((parameter) => tabsetsByParameter.get(parameter)).filter(Boolean)]
        .forEach((candidate) => Object.entries(candidate.when || {}).forEach(([key, expected]) => {
          if (targetQuery[key] === undefined && !Array.isArray(expected)) targetQuery[key] = expected;
        }));
      if (page.path === "/rules") {
        delete targetQuery.ruleView;
        const preserveTuneFilter = state.query.get("rtab") === "tuning" && ["tview", "tstatus"].includes(tabset.param);
        if (!preserveTuneFilter) ["detectorSet", "detectorId"].forEach((key) => delete targetQuery[key]);
      }
      if (page.path === "/tuning") {
        ["id", "choose", "host", "ts", "finding", "preset", "presetField", "presetValue"].forEach((key) => delete targetQuery[key]);
      }
      if (page.path === "/intel") {
        if (tabset.param === "itab") ["q", "list", "f", "p", "sq", "skind", "spage", "oq"].forEach((key) => delete targetQuery[key]);
        if (tabset.param === "skind") delete targetQuery.spage;
      }
      if (page.path === "/sources" && tabset.param === "stab"
        && (item.id !== "add" || !scanProfilesBySetupFor.has(targetQuery.setupFor))) {
        delete targetQuery.setupFor;
      }
      if (page.path === "/access" && tabset.param === "atab") delete targetQuery.id;
      if (page.path === "/access" && tabset.param === "oview") delete targetQuery.id;
      if (page.path === "/intel" && tabset.param === "skind" && item.id === "all") delete targetQuery.skind;
      else targetQuery[tabset.param] = item.id;
      return targetQuery;
    }

    function renderTabset(page, entry) {
      const { tabset, active } = entry;
      const tuneTabs = isTuningSurface();
      const routeTabClass = page.variant === "triage" && tabset.param === "view"
        ? " triage-tabs"
        : tuneTabs && tabset.param === "tview"
          ? " tune-top-tabs"
          : tuneTabs && ["status", "tstatus"].includes(tabset.param)
            ? " tune-sub-tabs"
            : page.variant === "intel" && tabset.param === "skind"
              ? " tune-tabs"
              : " viewtabs";
      const tabList = node("div", { className: `tabs${routeTabClass}`, attrs: { role: "tablist", "aria-label": `${page.label} ${tabset.param} views` } });
      tabset.items.forEach((item) => {
        const targetPath = item.path || page.path;
        const selected = item.path ? state.route === item.path : active === item.id;
        const label = node("span", { text: item.label });
        const count = (tuneTabs && ["status", "tstatus"].includes(tabset.param))
          || (page.variant === "triage" && tabset.param === "view")
          || (page.variant === "intel" && tabset.param === "skind")
          ? node("span", { className: "muted", text: "—" }) : null;
        tabList.append(node("a", {
          className: `tab-button viewtab${selected ? " active" : ""}`,
          attrs: {
            href: routeHash(targetPath, tabTargetQuery(page, tabset, item)),
            role: "tab",
            "aria-selected": String(selected),
            "aria-controls": "active-page-panels",
            tabindex: selected ? "0" : "-1"
          }
        }, [label, count]));
      });
      return tabList;
    }

    function renderTabs(page, tabState, predicate = () => true) {
      const fragment = documentRef.createDocumentFragment();
      tabState.tabsets.filter(predicate).forEach((entry) => fragment.append(renderTabset(page, entry)));
      return fragment;
    }

    function collectPanels(page, tabState, query) {
      const queryBranch = (page.queryBranches || []).find((branch) => branch.panels
        && queryMatches(branch.whenQuery, query));
      if (queryBranch) {
        return queryBranch.panels.filter((panel) => queryMatches(panel.whenQuery, query));
      }
      const selectedPanels = [];
      tabState.tabsets.forEach(({ tabset, active }) => {
        const item = tabset.items.find((candidate) => candidate.id === active);
        if (item && item.panels) selectedPanels.push(...item.panels.filter((panel) => queryMatches(panel.whenQuery, query)));
      });
      selectedPanels.push(...(page.panels || []).filter((panel) => queryMatches(panel.whenQuery, query)));
      return selectedPanels;
    }

    function overviewPrelude(summaryMetrics) {
      const legendRows = [
        ["reporting", "Reporting", ""],
        ["overdue", "Overdue", ""],
        ["never", "Never reported", ""],
        ["broken", "Broken", "No collection detail supplied"]
      ];
      const legend = node("dl", { className: "soc-overview-legend" }, legendRows.map(([tone, label, detail]) => node("div", {}, [
        node("dt", {}, [node("span", { className: `soc-overview-dot overview-dot ${tone}`, attrs: { "aria-hidden": "true" } }), label]),
        node("dd", { text: "—" }),
        detail ? node("small", { text: detail }) : null
      ])));
      const collection = node("section", { className: "soc-overview-card", attrs: { "aria-labelledby": "collection-health-title" } }, [
        node("div", { className: "soc-overview-card-hd" }, [
          node("div", {}, [
            node("span", { className: "soc-overview-kicker", text: "Telemetry" }),
            node("h2", { text: "Collection health", attrs: { id: "collection-health-title" } })
          ]),
          node("span", { text: "Awaiting authorized data" })
        ]),
        node("div", { className: "soc-overview-card-body soc-overview-source-body" }, [
          node("div", { className: "soc-overview-ring", attrs: { "data-empty": "true", role: "img", "aria-label": "No collection measurements supplied" } }, [
            node("div", { className: "soc-overview-ring-copy" }, [node("strong", { text: "—" }), node("span", { text: "reporting" })])
          ]),
          legend
        ])
      ]);
      const meter = (label, description) => node("div", { className: "soc-overview-meter" }, [
        node("div", { className: "soc-overview-meter-top" }, [node("span", { text: label }), node("strong", { text: "—/—" })]),
        node("div", { className: "soc-overview-meter-track" }, node("span", { className: "soc-overview-meter-fill", attrs: { "data-empty": "true" } })),
        node("span", { className: "soc-overview-meter-sub", text: description })
      ]);
      const facts = node("div", { className: "soc-overview-facts" }, [
        ["Attestation deadline", "No deadline supplied"],
        ["Oldest untriaged", "No queue age supplied"],
        ["Noise concentration", "No detection share supplied"]
      ].map(([label, detail]) => node("article", { className: "soc-overview-fact" }, [
        node("span", { text: label }), node("strong", { text: "—" }), node("small", { text: detail })
      ])));
      const readiness = node("section", { className: "soc-overview-card", attrs: { "aria-labelledby": "control-readiness-title" } }, [
        node("div", { className: "soc-overview-card-hd" }, [
          node("div", {}, [
            node("span", { className: "soc-overview-kicker", text: "Assurance" }),
            node("h2", { text: "Control readiness", attrs: { id: "control-readiness-title" } })
          ]),
          node("span", { text: "Data-free" })
        ]),
        node("div", { className: "soc-overview-card-body soc-overview-readiness" }, [
          meter("Attestable today", "Remediation evidence readiness"),
          meter("Rules exercised", "Detection coverage readiness"),
          facts
        ])
      ]);
      return node("div", { className: "overview-command-view" }, [
        node("div", { className: "soc-overview-lede" }, [
          node("div", {}, [
            node("span", { className: "soc-overview-kicker", text: "Posture command view" }),
            node("p", { text: "Collection coverage, review pressure, control readiness and current detections." })
          ]),
          node("span", { className: "soc-overview-window", text: "Review window · —" })
        ]),
        summaryMetrics,
        node("div", { className: "soc-overview-insights" }, [collection, readiness])
      ]);
    }

    function tuningPrelude() {
      return node("div", { className: "tune-route-intro" },
        node("div", { className: "tune-page-header" }, [
          node("p", { className: "tune-subtitle", text: "Reasoned, previewed, expiring exact-match exceptions for non-critical Triage matches. Raw evidence and rule-fire history never change." }),
          node("div", { className: "tune-header-actions" }, node("button", {
            className: "tune-primary-btn", text: "+ Create Tune", attrs: { type: "button" }, dataset: { tuneCreateOpen: "" }
          }))
        ])
      );
    }

    function tuningQueryMode(query) {
      if (query.get("id")) return "detail";
      if (query.get("choose")) return "occurrence-chooser";
      if (query.get("host") && query.get("ts")) return query.get("finding") ? "draft-builder" : "finding-chooser";
      return "registry";
    }

    function detailBackLink(path, label, query) {
      return node("a", { className: "detail-back", attrs: { href: routeHash(path, query) } }, [
        node("span", { className: "detail-back-arrow", text: "←", attrs: { "aria-hidden": "true" } }),
        node("span", { text: label })
      ]);
    }

    function tuningEmptyRow(columnCount, heading, copy) {
      return node("tr", { className: "tune-empty-row", attrs: { "data-filterable": "" } }, node("td", {
        attrs: { colspan: String(columnCount) }
      }, node("div", { className: "tune-empty-state" }, node("div", {}, [
        node("div", { className: "tune-empty-icon", text: "◎", attrs: { "aria-hidden": "true" } }),
        node("h3", { text: heading }),
        node("p", { className: "muted", text: copy })
      ]))));
    }

    function tuningTableCompatible(catalogPanel, suppliedPanel) {
      return Boolean(suppliedPanel && suppliedPanel.type === "table"
        && suppliedPanel.columns.length === catalogPanel.columns.length
        && suppliedPanel.columns.every((column, index) => column.label === catalogPanel.columns[index]));
    }

    function tuningTable(catalogPanel, suppliedPanel, view) {
      const columns = catalogPanel.columns;
      const suppliedRows = tuningTableCompatible(catalogPanel, suppliedPanel) ? suppliedPanel.rows : [];
      const table = node("table", { className: `tune-table${view === "definitions" ? " tune-definitions" : ""}` });
      table.append(node("caption", { className: "sr-only", text: catalogPanel.title }));
      table.append(node("thead", {}, node("tr", {}, columns.map((column) => node("th", {
        text: column, attrs: { scope: "col" }
      })))));
      const body = node("tbody");
      suppliedRows.forEach((row) => body.append(node("tr", { attrs: { "data-tune-row": "", "data-filterable": "" } },
        row.map((cell, index) => node("td", {
          attrs: { "data-align": suppliedPanel.columns[index].align }
        }, renderCell(cell))))));
      if (!suppliedRows.length) {
        const definitionView = view === "definitions";
        body.append(tuningEmptyRow(columns.length,
          definitionView ? "No tuning definitions in this view" : "Nothing to show in this view",
          definitionView
            ? "No authorized definition records were supplied. Create a draft only from a retained finding."
            : "No authorized occurrence evidence was supplied for this inventory view."));
      }
      table.append(body);
      return node("div", { className: "tune-table-scroll" }, table);
    }

    const tuningViewCopy = Object.freeze({
      definitions: ["Tune definitions", "Configured scopes and their lifecycle: draft, active, disabled, or expired. Each scope is bound to an exact detector revision, host, and severity."],
      applied: ["Applied alerts", "Immutable occurrences that an active tune actually auto-closed in Triage. Raw detections and rule-fire history are retained."],
      held: ["Matched but held", "Scope matches that stayed open because a protected condition or another finding prevented automatic closure."]
    });

    function renderTuningRegistry(page, tabState, catalogPanels, renderPanelSlot, takeSupplied) {
      const fragment = documentRef.createDocumentFragment();
      const metricIndex = catalogPanels.findIndex((panel) => panel.type === "metrics");
      if (metricIndex >= 0) fragment.append(renderPanelSlot(catalogPanels[metricIndex], metricIndex));
      const view = tabState.values.tview || "definitions";
      const topTabs = tabState.tabsets.find(({ tabset }) => tabset.param === "tview");
      const statusTabs = tabState.tabsets.find(({ tabset }) => ["status", "tstatus"].includes(tabset.param));
      const tablePanelIds = {
        definitions: "detection-tune-definitions",
        applied: "applied-alerts",
        held: "matched-but-held"
      };
      const tablePanel = catalogPanels.find((panel) => panel.id === tablePanelIds[view]);
      const suppliedTable = tablePanel ? takeSupplied(tablePanel) : null;
      const tableContent = tablePanel
        ? suppliedTable && !tuningTableCompatible(tablePanel, suppliedTable)
          ? renderAdapterPanel(suppliedTable, tablePanel)
          : tuningTable(tablePanel, suppliedTable, view)
        : null;
      const [heading, copy] = tuningViewCopy[view];
      const toolbarLeft = view === "definitions" && statusTabs
        ? renderTabset(page, statusTabs)
        : node("div", { className: "tune-toolbar-left" }, [
          node("span", { className: "tune-count", text: "— authorized records" }),
          node("span", { className: "muted", text: "Occurrence evidence is supplied by the integrating application." })
        ]);
      const workspace = node("section", { className: "panel tune-card tune-workspace", attrs: { id: "active-page-panels", role: "tabpanel", tabindex: "0" } }, [
        topTabs ? renderTabset(page, topTabs) : null,
        node("div", { className: "tune-workspace-copy" }, [node("h2", { text: heading }), node("p", { text: copy })]),
        node("div", { className: "tune-toolbar" }, [
          toolbarLeft,
          node("div", { className: "tune-toolbar-right" }, [
            view === "definitions" ? node("span", { className: "tune-count", text: "— authorized records" }) : null,
            node("input", { className: "tune-search", attrs: {
              type: "search", disabled: true, placeholder: `Search ${view === "definitions" ? "tunes" : heading.toLowerCase()}…`,
              "aria-label": `Filter the ${heading.toLowerCase()} table in this browser`
            } })
          ])
        ]),
        tableContent,
        node("div", { className: "tune-pad muted tune-search-none", attrs: { hidden: true } }),
        node("div", { className: "tune-pad muted tune-workspace-foot", text: view === "definitions"
          ? "Create a draft from an Event, a Triage finding, or Tune on a rule."
          : "Occurrence evidence is estate-scoped and is never inferred from preview totals." })
      ]);
      fragment.append(workspace);
      return fragment;
    }

    function triageTargetQuery(overrides = {}) {
      const allowed = ["view", "cat", "rule", "sort", "page", "expand"];
      const next = {};
      allowed.forEach((key) => {
        const value = state.query.get(key);
        if (value !== null && value !== "") next[key] = value;
      });
      Object.entries(overrides).forEach(([key, value]) => {
        if (value === undefined || value === null || value === "") delete next[key];
        else next[key] = value;
      });
      if (next.view === "queue") delete next.view;
      if (next.sort === "ts") delete next.sort;
      if (String(next.page || "") === "1") delete next.page;
      return next;
    }

    function triageFilterChip(label, active, query) {
      return node("a", {
        className: `badge ${active ? "b-ok" : "b-muted"}`,
        text: label,
        attrs: { href: routeHash("/triage", query) }
      });
    }

    function triageBulkUi() {
      const disabledTitle = "Connect an application-authorized command adapter to enable this action.";
      const bar = node("section", { className: "panel triage-bulk", attrs: { "aria-label": "Bulk alert controls" } }, [
        node("div", { className: "triage-bulk-row" }, [
          node("span", {}, [node("b", { text: "0" }), " alerts selected"]),
          node("div", { className: "triage-bulk-actions" }, [
            node("button", { className: "searchbtn", text: "Change selected", attrs: { type: "button", disabled: true, title: disabledTitle } }),
            node("button", { className: "refreshbtn", text: "Approve selected proposals", attrs: { type: "button", disabled: true, title: disabledTitle } })
          ])
        ]),
        node("div", { className: "triage-bulk-links" }, [
          node("span", { className: "muted", text: "select all shown" }),
          node("span", { className: "muted", text: "select alerts with proposals" }),
          node("span", { className: "muted", text: "clear" }),
          node("span", { className: "muted", text: "Choose exact alerts first. Related alerts are included only when explicitly requested." })
        ])
      ]);
      const field = (label, control, wide) => node("label", { className: wide ? "triage-wide" : "" }, [label, control]);
      const disabledOptions = (labels) => node("select", { attrs: { disabled: true } }, labels.map((label) => node("option", { text: label })));
      const dialog = node("dialog", { className: "triage-dialog triage-bulk-dialog", attrs: { id: "triage-bulk-dialog", "aria-labelledby": "triage-bulk-title" } }, [
        node("div", { className: "triage-dialog-hd" }, [
          node("div", {}, [
            node("b", { text: "Update 0 alerts", attrs: { id: "triage-bulk-title" } }),
            node("div", { className: "muted triage-dialog-subtitle", text: "Progress, owner, activity and note are applied together by the integrating application." })
          ]),
          node("button", { className: "triage-dialog-close", text: "×", attrs: { type: "button", disabled: true, "aria-label": "Cancel bulk update" } })
        ]),
        node("form", { className: "triage-bulk-form" }, [
          field("Progress", disabledOptions(["working", "pending", "resolved", "closed"])),
          field("Assigned to", node("input", { attrs: { type: "text", disabled: true } })),
          field("Activity / reason", disabledOptions(["my-activity", "deploy", "scanner-noise", "misconfiguration", "real-threat", "drill", "other"])),
          field("Shared note", node("textarea", { attrs: { rows: "4", disabled: true, placeholder: "What happened, what you checked, and why this disposition is correct" } }), true),
          node("div", { className: "triage-wide triage-bulk-scope" }, node("label", {}, [
            node("input", { attrs: { type: "checkbox", disabled: true } }),
            " Include related alerts in each selected case"
          ])),
          node("div", { className: "triage-wide triage-bulk-warnings", text: "No alerts selected.", attrs: { role: "status", "aria-live": "polite" } }),
          node("div", { className: "triage-dialog-actions triage-wide" }, [
            node("button", { className: "refreshbtn", text: "Cancel", attrs: { type: "button", disabled: true } }),
            node("button", { className: "searchbtn", text: "Update 0 Alerts", attrs: { type: "button", disabled: true, title: disabledTitle } })
          ])
        ])
      ]);
      return [bar, dialog];
    }

    function triageEditorDialog() {
      const field = (label, control, wide) => node("label", { className: wide ? "triage-wide" : "" }, [label, control]);
      const disabledSelect = (labels) => node("select", { attrs: { disabled: true } }, labels.map((label) => node("option", { text: label })));
      return node("dialog", { className: "triage-dialog", attrs: { id: "triage-editor", "aria-labelledby": "triage-editor-case" } }, [
        node("div", { className: "triage-dialog-hd" }, [
          node("div", {}, [
            node("b", { text: "Alert", attrs: { id: "triage-editor-case" } }),
            node("div", { className: "muted triage-dialog-subtitle", text: "Status, activity and ownership are saved together." })
          ]),
          node("button", { className: "triage-dialog-close", text: "×", attrs: { type: "button", disabled: true, "aria-label": "Close" } })
        ]),
        node("section", { className: "triage-proposal-review", attrs: { hidden: true } }, [
          node("span", { className: "badge b-warn", text: "awaiting approval" }),
          node("p", { className: "muted", text: "An authorized proposal and precedent would be shown here." })
        ]),
        node("form", { className: "triage-edit-form" }, [
          field("Status", disabledSelect(["new", "working", "pending", "resolved", "closed"])),
          field("Owner", node("input", { attrs: { type: "text", disabled: true } })),
          field("Activity", disabledSelect(["my-activity", "deploy", "scanner-noise", "misconfiguration", "real-threat", "drill", "other"])),
          field("What happened / what you did", node("input", { attrs: { type: "text", disabled: true } }), true),
          field("Tags", node("input", { attrs: { type: "text", disabled: true } }), true),
          node("div", { className: "triage-dialog-actions triage-wide" }, [
            node("button", { className: "searchbtn", text: "Save disposition", attrs: { type: "button", disabled: true } }),
            node("span", { className: "muted", text: "Open full alert" })
          ])
        ])
      ]);
    }

    function intelSourceBrowse(page, tabState, catalogPanel, suppliedPanel) {
      const sourceId = tabState.values.itab;
      const sourceNames = {
        threatfox: "ThreatFox",
        urlhaus: "URLhaus",
        malwarebazaar: "MalwareBazaar"
      };
      const sourceName = sourceNames[sourceId] || "Threat intelligence source";
      const kindTabs = tabState.tabsets.find(({ tabset }) => tabset.param === "skind");
      const queryValue = String(state.query.get("sq") || "").slice(0, 200);
      const search = node("form", { className: "intel-source-search", attrs: { "data-intel-search-form": "", role: "search" } }, [
        node("input", {
          attrs: {
            type: "search", name: "sq", value: queryValue,
            placeholder: "indicator, family or tag", "aria-label": `Search ${sourceName}`,
            maxlength: "200", autocomplete: "off",
            style: "min-width:240px;background:#10161a;color:#e6edf3;border:1px solid #2b3033;border-radius:4px;padding:6px 8px;font-size:12px"
          }
        }),
        node("button", { className: "searchbtn", text: "Search", attrs: { type: "submit" } }),
        queryValue ? node("a", {
          className: "refreshbtn intel-search-clear", text: "Clear",
          attrs: { href: routeHash("/intel", { itab: sourceId, skind: state.query.get("skind") || undefined }) }
        }) : null
      ]);
      const table = node("table", { className: "intel-browse" });
      const hydrated = suppliedPanel && suppliedPanel.type === "table";
      const columns = hydrated ? suppliedPanel.columns : catalogPanel.columns.map((label) => ({ label }));
      table.append(node("colgroup", { className: "intel-source-columns" }, [27, 8, 11, 5, 16, 8, 8, 10, 7].slice(0, columns.length).map((width) => node("col", {
        attrs: { style: `width:${width}%` }
      }))));
      table.append(node("thead", {}, node("tr", {}, columns.map((column) => node("th", {
        text: column.label, attrs: { scope: "col", "data-align": column.align }
      })))));
      const body = node("tbody");
      if (hydrated && suppliedPanel.rows.length) {
        suppliedPanel.rows.forEach((row) => body.append(node("tr", { attrs: { "data-filterable": "" } }, row.map((cell, index) => node("td", {
          attrs: { "data-align": columns[index].align }
        }, renderCell(cell))))));
      } else {
        body.append(node("tr", { attrs: { "data-filterable": "" } }, node("td", {
          className: "table-empty muted", text: `No authorized ${sourceName} indicators supplied.`,
          attrs: { colspan: String(Math.max(columns.length, 1)) }
        })));
      }
      table.append(body);
      const range = hydrated ? `${suppliedPanel.rows.length} authorized row${suppliedPanel.rows.length === 1 ? "" : "s"}` : "none";
      return panelShell(
        `${sourceName} indicators · ${range}`,
        node("div", { className: "intel-source-browser" }, [
          node("div", { className: "intel-source-search-wrap" }, search),
          kindTabs ? node("div", { className: "tune-tabs intel-kind-tabs" }, renderTabset(page, kindTabs)) : null,
          node("div", { className: "table-scroll" }, table),
          node("div", { className: "intel-source-pager" }, [
            node("span", { className: "refreshbtn disabled", text: "← newer", attrs: { "aria-disabled": "true" } }),
            node("span", { className: "muted", text: "page 1 of 1 · newest first" }),
            node("span", { className: "refreshbtn disabled", text: "older →", attrs: { "aria-disabled": "true" } })
          ])
        ]),
        hydrated ? suppliedPanel.description || "Newest first" : "Newest first · no source records",
        undefined,
        { id: catalogPanel.id, className: "intel-source-panel" }
      );
    }

    function offboardingManualStepsPanel(panel) {
      return panelShell(panel.title, node("div", { className: "offboarding-manual-steps" }, [
        node("span", { className: "badge b-muted", text: "— recorded open" }),
        node("p", { className: "muted", text: "The integrating application supplies the retained run-time obligation. This read-only skeleton neither revokes access nor claims that a manual step has been completed." })
      ]), "Recorded by the offboarding tool", undefined, { id: panel.id });
    }

    function logsTargetQuery(changes) {
      const target = queryObject(state.query);
      Object.entries(changes || {}).forEach(([key, value]) => {
        if (value === undefined || value === null || value === "") delete target[key];
        else target[key] = value;
      });
      return target;
    }

    function logQueryWithoutTime(value) {
      return String(value || "").replace(/\b(?:earliest|latest)=\S+\s*/gi, " ").replace(/\s+/g, " ").trim();
    }

    function logsPrelude() {
      const rawQuery = String(state.query.get("q") || "").slice(0, 240);
      const queryInput = node("input", {
        className: "logs-query-input",
        attrs: {
          type: "search", name: "q", value: rawQuery,
          placeholder: "search — index=<channel> host=<name> src=<address> \"phrase\" NOT term | stats count by src",
          autocomplete: "off", "aria-label": "Log query",
          style: "flex:1;background:#0d1216;border:1px solid #3ea6ff55;color:#e5e8ea;padding:10px 12px;font:13px/1.4 Menlo,monospace;border-radius:4px"
        }
      });
      const searchForm = node("form", { className: "logs-search-form", attrs: { role: "search" } }, [
        queryInput,
        node("button", { className: "searchbtn", text: "Search", attrs: { type: "submit" } })
      ]);
      searchForm.addEventListener("submit", (event) => {
        event.preventDefault();
        global.location.hash = routeHash("/logs", logsTargetQuery({ q: String(queryInput.value || "").trim() || null, all: null }));
      });

      const timeRanges = [["15m", "-15m"], ["1h", "-1h"], ["6h", "-6h"], ["24h", "-24h"], ["2d", "-2d"], ["7d", "-7d"], ["all time", null]];
      const currentRange = (rawQuery.match(/\bearliest=(-\d+[mhd])/i) || [])[1] || null;
      const timeChips = timeRanges.map(([label, value]) => {
        const base = logQueryWithoutTime(rawQuery);
        const nextQuery = value ? `${base ? `${base} ` : ""}earliest=${value}` : base;
        const target = logsTargetQuery({ q: nextQuery || null, all: value ? null : "1", from: null, to: null });
        const active = value ? currentRange === value : state.query.get("all") === "1";
        return node("a", { className: `badge ${active ? "b-ok" : "b-muted"}`, text: label, attrs: { href: routeHash("/logs", target) } });
      });

      const fromValue = (rawQuery.match(/\bearliest=(\d{4}-\d\d-\d\dT\d\d:\d\d)/) || [])[1] || "";
      const toValue = (rawQuery.match(/\blatest=(\d{4}-\d\d-\d\dT\d\d:\d\d)/) || [])[1] || "";
      const windowInputStyle = "background:#171d21;border:1px solid #3ea6ff66;color:#c3cbd1;padding:3px 6px;border-radius:3px;font-size:11px";
      const fromInput = node("input", { attrs: { type: "datetime-local", name: "from", value: fromValue, "aria-label": "Window start in UTC", style: windowInputStyle } });
      const toInput = node("input", { attrs: { type: "datetime-local", name: "to", value: toValue, "aria-label": "Window end in UTC", style: windowInputStyle } });
      const absoluteForm = node("form", { className: "logs-window-form" }, [
        node("span", { className: "muted", text: "or window (UTC):" }), fromInput,
        node("span", { className: "muted", text: "→" }), toInput,
        node("button", { className: "searchbtn", text: "Apply", attrs: { type: "submit" } })
      ]);
      absoluteForm.addEventListener("submit", (event) => {
        event.preventDefault();
        const parts = [logQueryWithoutTime(rawQuery)];
        if (fromInput.value) parts.push(`earliest=${String(fromInput.value).slice(0, 20)}`);
        if (toInput.value) parts.push(`latest=${String(toInput.value).slice(0, 20)}`);
        global.location.hash = routeHash("/logs", logsTargetQuery({ q: parts.filter(Boolean).join(" ") || null, all: null, from: null, to: null }));
      });

      const filterPanel = node("section", { className: "panel logs-query-panel" }, [
        searchForm,
        node("div", { className: "logs-time-row" }, [node("span", { className: "muted", text: "Time:" }), ...timeChips, absoluteForm]),
        node("p", { className: "muted logs-query-hint", text: "index/chan selects a source · fields: src dst port user status ua · earliest accepts relative or absolute UTC · pipe: | stats count by <field>" }),
        node("div", { className: "logs-secondary-filters" }, [
          node("select", { attrs: { disabled: true, "aria-label": "Host" } }, node("option", { text: "all hosts · application options" })),
          node("select", { attrs: { disabled: true, "aria-label": "Channel or index" } }, node("option", { text: "all indexes · application options" })),
          node("input", { attrs: { type: "search", placeholder: "highlight words in results (display only, no filtering)", "aria-label": "Highlight words" } })
        ])
      ]);

      const syntaxRows = [
        ["index=<channel>", "Select the searchable channel or index."],
        ["host=<name>", "Select one application-authorized host."],
        ["src= dst= port= user= status= ua=", "Match parsed fields."],
        ["\"exact phrase\" · word", "Bare terms combine with AND; quotes keep spaces."],
        ["NOT x · -x", "Exclude a term or field-shaped token."],
        ["term*", "Use a wildcard inside a term or field value."],
        ["a OR b", "Match either term inside a flat group."],
        ["re=\"pattern\"", "Apply a case-insensitive regular expression to the raw line."],
        ["earliest=-6h · latest=<UTC>", "Bound the search to a relative or absolute window."],
        ["| stats count by <field>", "Return a bounded aggregate instead of event rows."]
      ];
      const queryShortcuts = [
        ["Who scanned which ports, last 6h", "index=fw earliest=-6h | stats count by src,port", "the sweep matrix with attribution"],
        ["Most-hunted ports, last day", "index=fw earliest=-24h | stats count by port", ""],
        ["Every successful login", "index=sec accepted", "each should be an authorized operator, tailnet, or deployment identity"],
        ["Where root logins come from", "index=sec user=root | stats count by src", ""],
        ["Web requests that failed, last day", "index=web NOT 200 NOT 304 earliest=-24h", ""],
        ["Probes at admin paths", "index=web \"GET /admin\"", ""],
        ["Everything we connect out to", "index=net | stats count by dst,port", "the outbound-destination hunt view"],
        ["Database errors and warnings only", "index=db NOT LOG:", ""],
        ["Usernames attackers guessed today", "index=sec \"invalid user\" earliest=-24h | stats count by user", "their wordlist, visible"],
        ["Who is bruteforcing SSH, last day", "index=sec failed earliest=-24h | stats count by src", ""],
        ["RDP hunts against Linux boxes", "index=fw DPT=3389 earliest=-24h", ""],
        ["Scanner families by user-agent", "index=web earliest=-24h | stats count by ua", ""],
        ["Loudest 404 generators", "index=web status=404 earliest=-24h | stats count by src", "path guessers rank themselves"],
        ["Which processes talk out", "index=net | stats count by user", "a new name can be a finding"],
        ["Stripe account activity, last 2 days", "index=stripe earliest=-2d", ""],
        ["Everything on the DB host today", "index=sec host=db earliest=-24h", "use an application-authorized host name in a real deployment"]
      ];
      const cheatSheet = node("details", { className: "panel logs-cheat-sheet" }, [
        node("summary", { text: "Search cheat sheet — syntax, fields, and click-to-run examples" }),
        node("div", { className: "table-scroll" }, node("table", {}, node("tbody", {}, syntaxRows.map(([syntax, description]) => node("tr", {}, [
          node("td", { className: "nb" }, node("code", { text: syntax })), node("td", { className: "muted", text: description })
        ]))))),
        node("div", { className: "logs-cheat-copy muted" }, [
          node("p", {}, [
            node("b", { text: "Reading raw firewall lines:" }), " ",
            node("code", { text: "SRC" }), "=who knocked · ",
            node("code", { text: "DST" }), "=us · ",
            node("code", { text: "DPT" }), "=the port they aimed at (23 telnet, 22 SSH, 3389 RDP, 5900 VNC) · ",
            node("code", { text: "SPT" }), "=their throwaway port, ignore it."
          ]),
          node("p", {}, node("b", { text: "Click to run:" })),
          node("ul", {}, queryShortcuts.map(([label, query, description]) => node("li", {}, [
            node("a", { text: label, attrs: { href: routeHash("/logs", { q: query }) } }),
            description ? ` — ${description}` : null
          ])))
        ])
      ]);

      const sortable = { ts: "Time", host: "Host", chan: "Chan", src: "Source", dst: "Destination", port: "Port" };
      const chain = String(state.query.get("sort") || "ts:d").split(",").map((entry) => entry.split(":"))
        .filter(([fieldName]) => sortable[fieldName]).slice(0, 3);
      if (!chain.length) chain.push(["ts", "d"]);
      const sortLinks = Object.entries(sortable).map(([fieldName, label]) => {
        const current = chain[0];
        const direction = current && current[0] === fieldName && current[1] === "d" ? "a" : "d";
        const next = [[fieldName, direction], ...chain.filter(([name]) => name !== fieldName)].slice(0, 3);
        return node("a", {
          text: `${label}${current && current[0] === fieldName ? (current[1] === "d" ? " ▾" : " ▴") : ""}`,
          attrs: { href: routeHash("/logs", logsTargetQuery({ sort: next.map((entry) => entry.join(":")).join(",") })) }
        });
      });
      const sortBar = node("section", { className: "panel logs-sort-bar" }, [
        node("span", { className: "muted", text: "Sort by:" }),
        ...sortLinks.flatMap((link, index) => index ? [node("span", { className: "muted", text: "·" }), link] : [link])
      ]);
      const scanState = node("section", { className: "panel logs-scan-state" }, [
        node("span", { className: "muted", text: "Scan:" }),
        node("span", { className: "badge b-muted", text: "no authorized scan measurement supplied" })
      ]);
      return node("div", { className: "logs-query-structure" }, [filterPanel, cheatSheet, sortBar, scanState]);
    }

    function routeTabs(page, tabState) {
      const tabs = renderTabs(page, tabState);
      if (page.variant === "timeline") {
        const rangeTabs = tabState.tabsets.find(({ tabset }) => tabset.param === "range");
        return node("section", { className: "panel timeline-controls" }, [
          node("span", { className: "badge b-muted", text: "Hosts supplied by the application adapter" }),
          node("span", { className: "timeline-control-separator", text: "|", attrs: { "aria-hidden": "true" } }),
          rangeTabs ? renderTabset(page, rangeTabs) : null
        ]);
      }
      if (["/health", "/brief", "/analyst", "/analytics"].includes(page.path)) {
        const fragment = documentRef.createDocumentFragment();
        tabState.tabsets.forEach((entry) => fragment.append(node("section", { className: "panel route-view-tabs" }, renderTabset(page, entry))));
        return fragment;
      }
      if (page.variant === "triage") {
        const activity = state.query.get("cat") || "";
        const rule = String(state.query.get("rule") || "").slice(0, 100);
        const sort = ["ts", "sev", "rule", "host", "state"].includes(state.query.get("sort")) ? state.query.get("sort") : "ts";
        const activities = ["my-activity", "deploy", "scanner-noise", "misconfiguration", "real-threat", "drill", "other"];
        return node("section", { className: "panel triage-statebar" }, [
          tabs,
          node("p", { className: "triage-lanes" }, [
            node("b", { text: "—" }), " Queue + ", node("b", { text: "—" }), " Awaiting approval = ", node("b", { text: "—" }),
            " open alerts. Filing a proposal moves that alert out of Queue automatically; analyst findings without a proposed action stay in Queue. A case can span both lanes, but an alert never appears in both."
          ]),
          node("div", { className: "triage-filters" }, [
            node("span", { className: "muted", text: "Activity:" }),
            triageFilterChip("all", !activity, triageTargetQuery({ cat: null, page: null, expand: null })),
            ...activities.map((category) => triageFilterChip(`${category} —`, activity === category, triageTargetQuery({ cat: category, page: null, expand: null }))),
            rule ? node("span", { className: "muted triage-filter-label", text: "Rule:" }) : null,
            rule ? triageFilterChip(`${rule} ×`, true, triageTargetQuery({ rule: null, page: null, expand: null })) : null,
            node("span", { className: "muted triage-filter-label", text: "Sort:" }),
            ...["ts", "sev", "rule", "host", "state"].map((key) => triageFilterChip(
              key === "ts" ? "newest" : key,
              sort === key,
              triageTargetQuery({ sort: key, page: null, expand: null })
            ))
          ])
        ]);
      }
      if (page.variant === "rules") {
        const fragment = documentRef.createDocumentFragment();
        tabState.tabsets.forEach((entry) => fragment.append(node("section", { className: "panel route-view-tabs" }, renderTabset(page, entry))));
        return fragment;
      }
      if (page.variant === "intel") {
        return node("section", { className: "panel route-view-tabs" }, renderTabs(page, tabState, ({ tabset }) => tabset.param === "itab"));
      }
      if (page.path === "/access" && state.query.get("atab") === "offboarding" && state.query.get("id")) {
        return node("section", { className: "panel route-view-tabs" }, renderTabs(page, tabState, ({ tabset }) => tabset.param === "atab"));
      }
      return tabs;
    }

    function tuningSafetyCard() {
      const guarantees = [
        ["Future matches only", "Existing alerts are not silently changed."],
        ["Non-critical Triage only", "Eligible matches may be automatically closed only after explicit activation."],
        ["Raw evidence stays", "Every raw detection remains recorded."],
        ["Delivery retained by default", "Email and page delivery continues unless a separately authorized policy permits otherwise."],
        ["Narrow suppression opt-in", "Only eligible high, non-Sigma, all-exact internal scopes can request suppression."],
        ["Whole decision or nothing", "A critical, mixed, incomplete, invalid, or unaudited decision retains normal delivery."],
        ["Critical always breaks through", "A critical detection is never auto-closed."],
        ["Explicit AND conditions", "Exact, CIDR, literal phrase, or whole-word matching; no regex or fuzzy matching."]
      ];
      return node("details", { className: "tune-safety panel tune-card", attrs: { open: true } }, [
        node("summary", {}, [
          node("span", { text: "How Detection Tuning Works" }),
          node("span", { className: "tune-detail-count", text: `what an active tune does · ${guarantees.length} guarantees` })
        ]),
        node("div", { className: "tune-details-body" }, [
          node("div", { className: "tune-rules-grid" }, guarantees.map(([title, copy]) => node("div", { className: "tune-rule" }, [
            node("strong", { text: title }), node("span", { text: copy })
          ]))),
          node("div", { className: "tune-safety-limit", text: "Historical previews are bounded to retained, application-authorized detection history." })
        ])
      ]);
    }

    function tuningFooter(catalogPanels, takeSupplied) {
      const recommendationSlot = catalogPanels.find((panel) => panel.id === "tune-recommendations") || null;
      const suppliedRecommendation = recommendationSlot ? takeSupplied(recommendationSlot) : null;
      const recommendationContent = suppliedRecommendation && suppliedRecommendation.type === "table"
        ? withPanelDescription(suppliedRecommendation, node("div", { className: "tune-table-scroll" }, adapterTableNode(suppliedRecommendation, "tune-table")))
        : suppliedRecommendation
          ? renderAdapterPanel(suppliedRecommendation, recommendationSlot)
          : recommendationSlot
            ? structuralTable(recommendationSlot.title, recommendationSlot.columns, "No authorized recommendation candidates were supplied")
            : node("div", { className: "tune-details-body tune-pad muted", text: "No authorized recommendation candidates were supplied." });
      return node("div", { className: "tune-route-footer" }, [
        node("section", {
          className: "panel tune-card tune-recommendation-card",
          attrs: { "data-panel-id": suppliedRecommendation && suppliedRecommendation.type !== "table" ? undefined : "tune-recommendations" }
        }, [
          node("div", { className: "tune-recommendation" }, [
            node("span", { className: "tune-ai-badge", text: "AI", attrs: { "aria-hidden": "true" } }),
            node("div", {}, [node("h3", { text: "Detection Rules Analyst" }), node("p", { text: "Application-authorized recommendations and recorded decision context appear here when supplied." })]),
            node("a", { className: "tune-ghost-btn", text: "View Analyst Brief", attrs: { href: routeHash("/analyst", { btab: "analyst", atab: "rules" }) } })
          ]),
          node("details", { className: "tune-recommendation-details" }, [
            node("summary", {}, [node("span", { text: "Recommendations · Internal noise candidates" }), node("span", { className: "tune-detail-count", text: "review only" })]),
            node("div", { className: "tune-details-body tune-pad" }, recommendationContent)
          ])
        ]),
        node("div", { className: "tune-lower-grid" }, [
          tuningSafetyCard(),
          panelShell("Delivery authorization audit", node("div", { className: "tune-details-body" }, [
            node("p", { className: "tune-auth-line", text: "No authorized delivery decisions were supplied. An empty audit is not proof that notification delivery was omitted." }),
            node("span", { className: "tune-auth-pill warn", text: "Authorization history unavailable" })
          ]), "No records", undefined, { className: "tune-card" })
        ]),
        tuningCreateDialog()
      ]);
    }

    function tuningCreateDialog() {
      return node("dialog", { className: "tune-create-dialog", attrs: { id: "tune-create-dialog" } }, [
        node("div", { className: "tune-create-hd" }, [
          node("b", { text: "Create a tune from a real finding" }),
          node("button", { className: "tune-create-close", text: "×", attrs: { type: "button", "aria-label": "Close" }, dataset: { tuneCreateClose: "" } })
        ]),
        node("div", { className: "tune-create-body" }, [
          node("p", { className: "muted", text: "Every tune is anchored to a retained finding so its detector revision, host, severity, and evidence can be previewed before activation." }),
          node("div", { className: "tune-create-options" }, [
            ["Detection rule", "Open Rules, select a rule, then choose Tune to pick a real occurrence.", "/rules"],
            ["Triage finding", "Open Triage and use the Tune action on the exact finding.", "/triage"],
            ["Event", "Open an Event from Triage and use its finding-level Tune action.", "/triage"]
          ].map(([title, copy, path]) => node("a", { className: "tune-create-option", attrs: { href: routeHash(path) } }, [
            node("b", { text: title }), node("span", { text: copy })
          ]))),
          node("p", { className: "muted tune-create-manual", text: "Manual definition is unavailable because an unanchored scope has no revision-bound evidence." })
        ])
      ]);
    }

    function tuningDetailBranch(catalogPanels, takeSupplied) {
      const recordDetail = detailSlot(catalogPanels, takeSupplied, "tune-detail-record");
      const previewSummaryDetail = detailSlot(catalogPanels, takeSupplied, "tune-detail-preview-summary");
      const previewMatchesDetail = detailSlot(catalogPanels, takeSupplied, "tune-detail-preview-matches");
      const lineageDetail = detailSlot(catalogPanels, takeSupplied, "tune-detail-lineage");
      const deliveryDetail = detailSlot(catalogPanels, takeSupplied, "tune-detail-delivery-audit");
      const recordPanel = recordDetail.supplied && recordDetail.supplied.type === "metrics" ? recordDetail.supplied : null;
      const previewSummaryPanel = previewSummaryDetail.supplied && previewSummaryDetail.supplied.type === "metrics"
        ? previewSummaryDetail.supplied : null;
      const previewMatchesPanel = previewMatchesDetail.supplied && previewMatchesDetail.supplied.type === "table"
        ? previewMatchesDetail.supplied : null;
      const lineagePanel = lineageDetail.supplied && lineageDetail.supplied.type === "timeline" ? lineageDetail.supplied : null;
      const deliveryPanel = deliveryDetail.supplied && deliveryDetail.supplied.type === "timeline" ? deliveryDetail.supplied : null;
      const recordItems = metricItemsByLabel(recordPanel);
      const previewItems = metricItemsByLabel(previewSummaryPanel);
      const factLabels = ["Status", "Detector revision", "Notifications", "Owner", "Created", "Duration", "Expires"];
      if (state.query.get("detectorSet") === "yara" || recordItems.has("YARA definition environment")) {
        factLabels.splice(2, 0, "YARA definition environment");
      }
      const scopeLabels = ["Detector", "Host", "Severity"];
      const reasons = ["Reason", "Evidence / precedent", "Revisit this if", "Activity"];
      const previewLabels = [
        "Scanned", "Scope matches", "Eligible findings", "Closable decisions", "Mixed / stays open",
        "Critical bypass", "Protected", "Decisions", "Cases", "Open", "Closed", "Proposed"
      ];
      if (previewSummaryPanel) {
        previewSummaryPanel.items.forEach((item) => {
          if (!previewLabels.includes(item.label)) previewLabels.push(item.label);
        });
      }
      const previewColumns = ["When", "Host", "Sev", "Rule", "Alert", "Case", "Status", "Prior reason"];
      let previewTable;
      if (previewMatchesPanel) {
        previewTable = adapterTableNode(previewMatchesPanel, "tune-table tune-preview-table");
      } else {
        previewTable = node("table", { className: "tune-table tune-preview-table" });
        previewTable.append(node("caption", { className: "sr-only", text: "Representative historical matches" }));
        previewTable.append(node("thead", {}, node("tr", {}, previewColumns.map((column) => node("th", { text: column, attrs: { scope: "col" } })))));
        previewTable.append(node("tbody", {}, node("tr", {}, node("td", {
          className: "muted", text: "No representative historical matches.", attrs: { colspan: String(previewColumns.length) }
        }))));
      }
      const lifecycleControls = [
        ["Activate this exact version", "Activation uses the stored preview; editing creates another immutable draft.", "Activate tune"],
        ["Cancel this draft", "The canceled draft remains available as lifecycle history.", "Cancel draft"],
        ["Disable for future detections", "Historical automatic dispositions remain attributed to this version.", "Disable"],
        ["Revise as new draft", "Copies the immutable scope and accountability fields into a separately reviewed revision.", "Create revised draft"]
      ];
      return node("div", { className: "tune-branch tune-detail-branch" }, [
        detailBackLink("/tuning", "Back to Detection Tuning"),
        tuningSafetyCard(),
        panelShell("Detection tune", withPanelDescription(recordPanel || {}, node("div", { className: "tune-pad" }, [
          node("div", { className: "tune-detail-grid" }, [
            ...factLabels.map((label) => {
              const item = recordItems.get(label);
              return node("div", { attrs: { "data-tone": item ? item.tone : "neutral" } }, [
                node("span", { text: label }), node("b", { text: metricValue(item) }),
                node("small", { text: item && item.detail ? item.detail : "Awaiting authorized record" })
              ]);
            }),
            ...(recordPanel ? recordPanel.items.filter((item) => !factLabels.includes(item.label)
              && !scopeLabels.includes(item.label) && !reasons.includes(item.label) && item.label !== "Source occurrence") : [])
              .map((item) => node("div", { attrs: { "data-tone": item.tone } }, [
                node("span", { text: item.label }), node("b", { text: metricValue(item) }),
                item.detail ? node("small", { text: item.detail }) : null
              ]))
          ]),
          node("div", { className: "tune-scope" }, scopeLabels.map((label) => {
            const item = recordItems.get(label);
            return node("span", {
              className: `badge${item ? "" : " b-muted"}`,
              text: `${label} · ${metricValue(item)}`,
              attrs: { "data-tone": item ? item.tone : "neutral", title: item && item.detail }
            });
          })),
          node("div", { className: "tune-reason" }, reasons.map((label) => node("div", {}, [
            node("span", { text: label }),
            node("p", { className: recordItems.has(label) ? "" : "muted", text: metricValue(recordItems.get(label), "No authorized value supplied.") }),
            recordItems.get(label) && recordItems.get(label).detail
              ? node("small", { className: "muted", text: recordItems.get(label).detail }) : null
          ]))),
          node("div", { className: "tune-pad tune-lineage" }, [
            node("b", { text: "Source occurrence" }),
            node("div", {
              className: recordItems.has("Source occurrence") ? "" : "muted tune-source-builder-unavailable",
              text: metricValue(recordItems.get("Source occurrence"), "No application-authorized source occurrence was supplied.")
            }),
            recordItems.get("Source occurrence") && recordItems.get("Source occurrence").detail
              ? node("small", { className: "muted", text: recordItems.get("Source occurrence").detail }) : null
          ]),
          node("div", {
            className: "tune-pad tune-lineage tune-immutable-lineage",
            attrs: { "data-panel-id": specializedSlotId(lineageDetail, "timeline") }
          }, [
            node("b", { text: "Immutable tune lineage" }),
            lineagePanel
              ? adapterTimelineList(lineagePanel)
              : node("div", { className: "muted", text: "Lineage, revision, and supersession history are supplied only by the integrating application." })
          ])
        ])), recordPanel ? "Authorized detail" : "Data-free detail", undefined, {
          id: specializedSlotId(recordDetail, "metrics"), className: "tune-card"
        }),
        recordDetail.supplied && !recordPanel ? renderAdapterPanel(recordDetail.supplied, recordDetail.slot) : null,
        lineageDetail.supplied && !lineagePanel ? renderAdapterPanel(lineageDetail.supplied, lineageDetail.slot) : null,
        panelShell("Historical preview", node("div", { className: "tune-pad" }, [
          node("div", { className: "tune-metrics" }, previewLabels.map((label) => {
            const item = previewItems.get(label);
            return node("div", { className: "tune-metric", attrs: { "data-tone": item ? item.tone : "neutral", title: item && item.detail } }, [
              node("span", { text: label }), node("b", { text: metricValue(item) })
            ]);
          })),
          node("div", { className: "tune-preview-note", text: previewSummaryPanel
            ? (previewSummaryPanel.description || "Authorized historical preview supplied. Activation remains unavailable without a separately authorized command.")
            : "No authorized historical preview was supplied. Activation remains unavailable without a current, bounded preview." }),
          node("div", {
            className: "tune-table-scroll",
            attrs: { "data-panel-id": specializedSlotId(previewMatchesDetail, "table") }
          }, previewTable),
          node("p", { className: "muted tune-preview-boundary", text: "The integrating application must state the exact retained-history bound used for this preview; this public skeleton does not publish an operational retention value." })
        ]), previewSummaryPanel ? "Authorized bounded history" : "Bounded retained history", undefined, {
          id: specializedSlotId(previewSummaryDetail, "metrics"), className: "tune-card"
        }),
        previewSummaryDetail.supplied && !previewSummaryPanel
          ? renderAdapterPanel(previewSummaryDetail.supplied, previewSummaryDetail.slot) : null,
        previewMatchesDetail.supplied && !previewMatchesPanel
          ? renderAdapterPanel(previewMatchesDetail.supplied, previewMatchesDetail.slot) : null,
        panelShell("Delivery authorization audit", node("div", { className: "tune-details-body" }, deliveryPanel
          ? adapterTimelineList(deliveryPanel)
          : [
              node("p", { className: "tune-auth-line", text: "No authorized delivery decisions were supplied for this tuning version." }),
              node("span", { className: "tune-auth-pill warn", text: "Authorization history unavailable" })
            ]), deliveryPanel ? `${deliveryPanel.items.length} events` : "No records", undefined, {
          id: specializedSlotId(deliveryDetail, "timeline"), className: "tune-card"
        }),
        deliveryDetail.supplied && !deliveryPanel ? renderAdapterPanel(deliveryDetail.supplied, deliveryDetail.slot) : null,
        node("details", { className: "panel tune-card tune-lifecycle-deck" }, [
          node("summary", {}, [node("span", { text: "Lifecycle controls" }), node("span", { className: "tune-detail-count", text: "state-selected · unavailable in skeleton" })]),
          node("div", { className: "tune-lifecycle-options" }, lifecycleControls.map(([title, copy, action], index) => node("section", {
            className: `tune-control${index === 3 ? " tune-clone-revision" : ""}`
          }, [
            node("div", {}, [node("b", { text: title }), node("div", { className: "muted", text: copy })]),
            node("button", { className: index === 0 || index === 3 ? "searchbtn" : "refreshbtn", text: action, attrs: { type: "button", disabled: true } })
          ])))
        ])
      ]);
    }

    function tuningChooserBranch(mode, catalogPanels, takeSupplied) {
      const ruleFirst = mode === "occurrence-chooser";
      const chooserDetail = detailSlot(catalogPanels, takeSupplied,
        ruleFirst ? "tune-occurrence-options" : "tune-finding-options");
      const chooserPanel = chooserDetail.supplied && chooserDetail.supplied.type === "table"
        ? chooserDetail.supplied : null;
      const columns = ruleFirst
        ? ["When", "Host", "Case", "Sev", "Alert", "Definition", "Prior decision / activity", ""]
        : ["Set", "Detection", "Sev", ""];
      const heading = ruleFirst ? "Choose a real historical occurrence" : "Choose the exact finding";
      const copy = ruleFirst
        ? "Rule-first tuning still starts from retained evidence. Pick the exact finding that should anchor the draft."
        : "If several findings share one alert identity, the integrating application must identify the exact retained finding.";
      let table;
      if (chooserPanel) {
        table = adapterTableNode(chooserPanel);
      } else {
        table = node("table");
        table.append(node("caption", { className: "sr-only", text: heading }));
        table.append(node("thead", {}, node("tr", {}, columns.map((column) => node("th", { text: column, attrs: { scope: "col" } })))));
        table.append(node("tbody", {}, node("tr", {}, node("td", {
          className: ruleFirst ? "muted tune-rule-first-empty" : "muted",
          text: "No authorized retained occurrence was supplied.", attrs: { colspan: String(columns.length) }
        }))));
      }
      return node("div", { className: `tune-branch tune-${mode}` }, [
        detailBackLink(ruleFirst ? "/rules" : "/triage", ruleFirst ? "Back to Rules" : "Back to Triage"),
        tuningSafetyCard(),
        panelShell(heading, node("div", {}, [
          node("div", { className: "tune-pad muted", text: copy }),
          node("div", { className: "tune-table-scroll" }, table)
        ]), chooserPanel ? `${chooserPanel.rows.length} authorized rows · no draft was created` : "No draft was created", undefined, {
          id: specializedSlotId(chooserDetail, "table"), className: "tune-card"
        }),
        chooserDetail.supplied && !chooserPanel ? renderAdapterPanel(chooserDetail.supplied, chooserDetail.slot) : null
      ]);
    }

    function disabledTuneField(label, control) {
      return node("label", {}, [node("span", { text: label }), control]);
    }

    function tuningBuilderBranch(catalogPanels, takeSupplied) {
      const sourceDetail = detailSlot(catalogPanels, takeSupplied, "tune-builder-source");
      const evidenceDetail = detailSlot(catalogPanels, takeSupplied, "tune-builder-evidence");
      const sourcePanel = sourceDetail.supplied && sourceDetail.supplied.type === "metrics"
        ? sourceDetail.supplied : null;
      const evidencePanel = evidenceDetail.supplied && evidenceDetail.supplied.type === "table"
        ? evidenceDetail.supplied : null;
      const sourceItems = metricItemsByLabel(sourcePanel);
      const selector = node("div", { className: "tune-selector-row" }, [
        node("label", { className: "tune-selector-enable" }, [
          node("input", { attrs: { type: "checkbox", disabled: true, "aria-label": "Use retained finding condition" } }),
          node("span", {}, [node("b", { text: "Retained finding field" }), node("small", { text: "field path · —" })])
        ]),
        node("select", { attrs: { disabled: true, "aria-label": "Match operator" } }, node("option", { text: "Exact value" })),
        node("input", { attrs: { type: "text", disabled: true, placeholder: "Authorized source value" } }),
        node("button", { className: "tune-selector-copy", text: "+ another", attrs: { type: "button", disabled: true } }),
        node("div", { className: "tune-selector-sample", text: "source: awaiting authorized finding" })
      ]);
      return node("div", { className: "tune-branch tune-draft-builder" }, [
        detailBackLink("/triage", "Back to Triage"),
        tuningSafetyCard(),
        sourceDetail.supplied && !sourcePanel ? renderAdapterPanel(sourceDetail.supplied, sourceDetail.slot) : null,
        evidenceDetail.supplied && !evidencePanel
          ? renderAdapterPanel(evidenceDetail.supplied, evidenceDetail.slot) : null,
        panelShell("Create a tuning draft", node("div", {}, [
          node("div", {
            className: "tune-pad tune-source",
            attrs: { "data-panel-id": specializedSlotId(sourceDetail, "metrics") }
          }, [
            node("span", {
              className: `badge${sourceItems.has("Detector") ? "" : " b-muted"}`,
              text: `Detector · ${metricValue(sourceItems.get("Detector"))}`,
              attrs: { "data-tone": sourceItems.get("Detector") ? sourceItems.get("Detector").tone : "neutral" }
            }),
            node("span", {
              className: `badge${sourceItems.has("Severity") ? "" : " b-muted"}`,
              text: `Severity · ${metricValue(sourceItems.get("Severity"))}`,
              attrs: { "data-tone": sourceItems.get("Severity") ? sourceItems.get("Severity").tone : "neutral" }
            }),
            node("span", {
              className: sourceItems.has("Host") ? "" : "muted",
              text: sourceItems.has("Host") ? `Host · ${metricValue(sourceItems.get("Host"))}` : "Host and time supplied only by the authorized application"
            }),
            sourcePanel ? node("div", { className: "tune-builder-context" }, sourcePanel.items.map((item) => node("span", {
              className: "badge",
              text: `${item.label} · ${metricValue(item)}`,
              attrs: { "data-tone": item.tone, title: item.detail }
            }))) : node("p", { className: "muted", text: "No alert text is bundled in the public skeleton." })
          ]),
          node("div", { className: "tune-form" }, [
            node("fieldset", {}, [
              node("legend", { text: "Match scope" }),
              node("div", { className: "tune-fixed-scope" }, ["Detector", "Host", "Severity"].map((label) => node("span", {}, [
                node("small", { text: label }), node("b", { text: metricValue(sourceItems.get(label)) })
              ]))),
              node("div", { className: "muted tune-help", text: "Detector, host, and severity are fixed by the retained finding. Enable one or more explicit AND conditions supplied by the application." }),
              node("div", {
                className: "tune-fields",
                attrs: { "data-panel-id": specializedSlotId(evidenceDetail, "table") }
              }, [
                selector,
                evidencePanel ? node("div", { className: "tune-table-scroll" }, adapterTableNode(evidencePanel)) : null
              ])
            ]),
            node("fieldset", {}, [
              node("legend", { text: "Reason and accountability" }),
              node("div", { className: "tune-form-grid" }, [
                disabledTuneField("Activity", node("select", { attrs: { disabled: true } }, node("option", { text: "Awaiting options" }))),
                disabledTuneField("Owner", node("input", { attrs: { type: "text", disabled: true } })),
                disabledTuneField("Expires", node("select", { attrs: { disabled: true } }, node("option", { text: "Awaiting policy" })))
              ]),
              disabledTuneField("Why is this expected?", node("textarea", { attrs: { rows: "3", disabled: true } })),
              disabledTuneField("Evidence / precedent", node("textarea", { attrs: { rows: "3", disabled: true } })),
              disabledTuneField("Revisit this if", node("textarea", { attrs: { rows: "2", disabled: true } }))
            ]),
            node("fieldset", { className: "tune-notification-policy" }, [
              node("legend", { text: "Notification delivery" }),
              node("div", { className: "tune-policy-options" }, [
                node("label", { className: "tune-policy-option tune-policy-retain" }, [node("input", { attrs: { type: "radio", checked: true, disabled: true } }), node("span", {}, [node("b", { text: "Retain delivery · default" }), node("small", { text: "Email and page notifications continue normally." })])]),
                node("div", { className: "tune-policy-option tune-policy-unavailable" }, [node("b", { text: "Suppression unavailable" }), node("small", { text: "Eligibility requires application-authorized source and decision evidence." })])
              ]),
              node("div", { className: "tune-policy-eligibility muted", text: "Retain delivery is selected." })
            ]),
            node("div", { className: "tune-submit" }, [
              node("button", { className: "searchbtn", text: "Create and preview draft", attrs: { type: "button", disabled: true } }),
              node("span", { className: "muted", text: "Nothing activates from this form." })
            ])
          ])
        ]), "Source finding; no state changes", undefined, { className: "tune-card" })
      ]);
    }

    function tuningBranch(mode, catalogPanels, takeSupplied) {
      if (mode === "detail") return tuningDetailBranch(catalogPanels, takeSupplied);
      if (mode === "draft-builder") return tuningBuilderBranch(catalogPanels, takeSupplied);
      return tuningChooserBranch(mode, catalogPanels, takeSupplied);
    }

    function rulesDetailBranch(page, tabState, catalogPanels, takeSupplied) {
      const summaryDetail = detailSlot(catalogPanels, takeSupplied, "rule-detail-summary");
      const sourceDetail = detailSlot(catalogPanels, takeSupplied, "rule-source-definition");
      const effectiveDetail = detailSlot(catalogPanels, takeSupplied, "rule-effective-definition");
      const occurrencesDetail = detailSlot(catalogPanels, takeSupplied, "rule-detail-occurrences");
      const summaryPanel = summaryDetail.supplied && summaryDetail.supplied.type === "metrics"
        ? summaryDetail.supplied : null;
      const sourcePanel = sourceDetail.supplied && sourceDetail.supplied.type === "text" ? sourceDetail.supplied : null;
      const effectivePanel = effectiveDetail.supplied && effectiveDetail.supplied.type === "text" ? effectiveDetail.supplied : null;
      const occurrencesPanel = occurrencesDetail.supplied && occurrencesDetail.supplied.type === "table"
        ? occurrencesDetail.supplied : null;
      const summaryItems = metricItemsByLabel(summaryPanel);
      const isYara = state.query.get("detectorSet") === "yara";
      const facts = ["Detector", "Definition state"];
      if (isYara || summaryItems.has("Published ruleset")) facts.push("Published ruleset");
      facts.push("Enabled", "Severity / level", "Channel", "Fires · this estate");
      if (summaryPanel) {
        summaryPanel.items.forEach((item) => {
          if (item.label !== "Provenance" && !facts.includes(item.label)) facts.push(item.label);
        });
      }
      const sourceBlock = (label, detail) => node("div", {
        attrs: { "data-panel-id": specializedSlotId(detail, "text"), "data-tone": detail.supplied ? detail.supplied.tone : "neutral" }
      }, [
        node("div", { className: "muted rule-detail-source-label", text: label }),
        node("pre", { className: "md-pre", text: detail.supplied && detail.supplied.type === "text"
          ? detail.supplied.body : "No authorized definition text supplied." })
      ]);
      const occurrenceColumns = ["When", "Host", "Case", "Sev", "Alert", "Definition"];
      if (isYara) occurrenceColumns.push("Host ruleset");
      occurrenceColumns.push("");
      let occurrenceTable;
      if (occurrencesPanel) {
        occurrenceTable = adapterTableNode(occurrencesPanel);
      } else {
        occurrenceTable = node("table");
        occurrenceTable.append(node("caption", { className: "sr-only", text: "Sample occurrences" }));
        occurrenceTable.append(node("thead", {}, node("tr", {}, occurrenceColumns.map((column) => node("th", { text: column, attrs: { scope: "col" } })))));
        occurrenceTable.append(node("tbody", {}, node("tr", {}, node("td", { className: "muted", text: "No authorized occurrence records supplied.", attrs: { colspan: String(occurrenceColumns.length) } }))));
      }
      const rtab = tabState.tabsets.find(({ tabset }) => tabset.param === "rtab");
      return node("div", { className: "rule-detail-view", attrs: { id: "active-page-panels", role: "tabpanel", tabindex: "0" } }, [
        detailBackLink("/rules", "Back to Rules"),
        rtab ? node("section", { className: "panel route-view-tabs" }, renderTabset(page, rtab)) : null,
        panelShell("Rule definition", withPanelDescription(summaryPanel || {}, node("div", { className: "rule-detail-pad" }, [
          node("div", { className: "rule-detail-head" }, [
            node("div", {}, [
              node("span", {
                className: `badge${summaryItems.has("Provenance") ? "" : " b-muted"}`,
                text: metricValue(summaryItems.get("Provenance"), "provenance unavailable"),
                attrs: { "data-tone": summaryItems.get("Provenance") ? summaryItems.get("Provenance").tone : "neutral" }
              }),
              node("span", { className: "muted", text: summaryItems.get("Provenance") && summaryItems.get("Provenance").detail
                ? ` ${summaryItems.get("Provenance").detail}` : " Source supplied by the integrating application" })
            ]),
            node("div", { className: "rule-detail-actions" }, [
              node("button", { className: "triage-action rule-tune-action", text: "Tune from occurrence", attrs: { type: "button", disabled: true } }),
              node("button", { className: "triage-action", text: "Tune history", attrs: { type: "button", disabled: true } })
            ])
          ]),
          node("div", { className: "rule-detail-facts" }, facts.map((label) => {
            const item = summaryItems.get(label);
            return node("div", { attrs: { "data-tone": item ? item.tone : "neutral" } }, [
              node("span", { text: label }), node("b", { text: metricValue(item) }),
              node("small", { text: item && item.detail ? item.detail : "Awaiting authorized definition" })
            ]);
          }))
        ])), summaryPanel ? "Authorized detail" : "Data-free detail", undefined, {
          id: specializedSlotId(summaryDetail, "metrics")
        }),
        summaryDetail.supplied && !summaryPanel ? renderAdapterPanel(summaryDetail.supplied, summaryDetail.slot) : null,
        node("section", { className: "panel rule-code-readonly" }, node("div", { className: "rule-detail-pad muted", text: "This definition is read-only in the public skeleton. Creating a local revision requires an application-authorized command workflow." })),
        node("details", { className: "panel rule-revision-deck" }, [
          node("summary", {}, [node("span", { text: "Local definition workflows" }), node("span", { className: "muted", text: "immutable revision or fork" })]),
          node("div", { className: "rule-revision-options" }, [
            ["Edit as a new local version", "rule-local-revision", "Validate & create new version"],
            ["Fork & customize", "rule-upstream-readonly", "Validate & create local fork"]
          ].map(([title, marker, action]) => node("section", { className: marker }, [
            node("div", { className: "panel-hd" }, [node("span", { text: title }), node("span", { className: "panel-right", text: "immutable local identity" })]),
            node("div", { className: "rule-detail-pad rule-revision-form" }, [
              node("p", { className: "muted", text: "The original definition and every existing alert, tune, and historical revision remain unchanged." }),
              node("label", {}, [node("span", { text: "New definition" }), node("textarea", { attrs: { rows: "10", disabled: true } })]),
              node("label", {}, [node("span", { text: "Why create this version?" }), node("textarea", { attrs: { rows: "3", disabled: true } })]),
              node("div", { className: "rule-revision-submit" }, [
                node("button", { className: "searchbtn", text: action, attrs: { type: "button", disabled: true } }),
                node("span", { className: "muted", text: "Requires a current definition digest and a server-authorized command." })
              ])
            ])
          ])))
        ]),
        panelShell("Source and effective definition", node("div", { className: "rule-detail-source" }, [
          sourceBlock("Source / provenance definition", sourceDetail),
          sourceBlock("Effective definition evaluated now", effectiveDetail)
        ]), "Digest unavailable"),
        sourceDetail.supplied && !sourcePanel ? renderAdapterPanel(sourceDetail.supplied, sourceDetail.slot) : null,
        effectiveDetail.supplied && !effectivePanel ? renderAdapterPanel(effectiveDetail.supplied, effectiveDetail.slot) : null,
        panelShell("Sample occurrences", node("div", { className: "tune-table-scroll" }, occurrenceTable),
          occurrencesPanel ? `${occurrencesPanel.rows.length} authorized fires` : "Newest retained exact fires", undefined, {
            id: specializedSlotId(occurrencesDetail, "table")
          }),
        occurrencesDetail.supplied && !occurrencesPanel
          ? renderAdapterPanel(occurrencesDetail.supplied, occurrencesDetail.slot) : null
      ]);
    }

    function authPanel() {
      const authenticated = state.session.authenticated;
      const action = authenticated ? "logout" : "login";
      const label = authenticated ? "Sign out" : "Sign in";
      return panelShell("Authentication", node("div", { className: "panel-body auth-summary" }, [
        node("div", {}, [
          node("strong", { text: authenticated ? "Authenticated session" : "No authenticated session" }),
          node("p", { className: "muted", text: auth
            ? "Identity and access decisions remain owned by the integrating server."
            : "Install a validated authentication adapter to connect sign-in and sign-out." })
        ]),
        node("button", {
          className: "resource-action",
          text: label,
          attrs: { type: "button", disabled: !auth },
          dataset: { authAction: action }
        }),
        authenticated && global.SOC_PRIVATE_APPLICATION ? node("a", {
          className: "resource-action", text: "Change password", attrs: { href: "/sign-in?mode=password" }
        }) : null
      ]), auth ? "Application auth boundary" : "Not connected");
    }

    function authGate(page) {
      return node("section", { className: "panel auth-gate", attrs: { role: "region", "aria-labelledby": "auth-required-title" } }, [
        node("div", { className: "panel-body" }, [
          node("span", { className: "auth-lock", text: "◈", attrs: { "aria-hidden": "true" } }),
          node("h2", { text: "Authentication required", attrs: { id: "auth-required-title" } }),
          node("p", { text: auth
            ? `Sign in through the application-owned identity provider to open ${page.label}.`
            : "This deployment requires authentication, but no browser authentication adapter is installed." }),
          node("button", {
            className: "resource-action",
            text: "Sign in",
            attrs: { type: "button", disabled: !auth },
            dataset: { authAction: "login" }
          })
        ])
      ]);
    }

    function adapterContext() {
      if (!state.envelope) return null;
      let updated = null;
      if (state.envelope.updatedAt) {
        const display = new Intl.DateTimeFormat(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: state.timezone === "UTC" ? "UTC" : undefined
        }).format(new Date(state.envelope.updatedAt));
        updated = node("span", { className: "adapter-updated" }, [
          "Updated ", node("time", { text: display, attrs: { datetime: state.envelope.updatedAt } })
        ]);
      }
      return node("section", { className: "authorized-context", attrs: { "aria-labelledby": "adapter-context-title" } }, [
        node("div", { className: "authorized-heading" }, [
          node("div", {}, [
            node("p", { className: "eyebrow", text: "Application adapter" }),
            node("h2", { text: state.envelope.title, attrs: { id: "adapter-context-title" } })
          ]),
          node("div", { className: "adapter-context-state" }, [
            updated,
            node("span", { className: "pill badge", text: state.envelope.state, attrs: { "data-tone": state.envelope.state === "error" ? "bad" : "neutral" } })
          ])
        ]),
        state.envelope.summary ? node("p", { className: "authorized-summary", text: state.envelope.summary }) : null
      ]);
    }

    function commandResultPanel() {
      if (!state.commandResult) return null;
      const result = state.commandResult;
      const succeeded = result.status === "succeeded" || result.status === "accepted";
      const output = result.output || {};
      const oneTime = output.oneTimeCredential || output.enrollmentCredential || null;
      const oneTimePurpose = oneTime && oneTime.purpose === "source-ingest" ? "source ingest" : "host connection-check";
      const credentialSource = state.controlSnapshot && [...state.controlSnapshot.sources, ...state.controlSnapshot.setups].find(item => item.sourceId === output.sourceId);
      const credentialManifest = credentialSource && state.controlSnapshot.connectorTypes.find(item => item.connectorType === credentialSource.connectorType);
      const ingestInstructions = credentialSource && credentialSource.connectorType === "trivy-report"
        ? `Use Scans → Trivy or the validated /api/v1/scanners/trivy/import endpoint with this source credential. Source ID: ${output.sourceId}. Do not send generic canonical batches to a Trivy report source.`
        : `Send JSON batches to /api/v1/ingest using this credential in the Authorization: Bearer header. Source ID: ${output.sourceId}. Each batch needs schemaVersion 1, documentType ingest-batch, sourceId, a stable receiptId, original sentAt, and normalized records allowed by this source: ${credentialManifest ? credentialManifest.payload.recordKinds.join(", ") : "consult the installed manifest"}. Vendor presets also support Sources → Vendor imports. Do not put the credential in JSON or browser code.`;
      return node("section", { className: "notice command-result-notice", attrs: {
        role: succeeded ? "status" : "alert",
        "data-tone": succeeded ? "ok" : "bad"
      } }, [
        node("div", {}, [
          node("strong", { text: succeeded ? "Connector action completed" : "Connector action was not completed" }),
          node("span", { text: succeeded
            ? "The registry has been refreshed."
            : (result.error && result.error.message) || "The server refused or could not complete this action." }),
          oneTime ? node("div", { className: "one-time-credential" }, [
            node("strong", { text: `One-time ${oneTimePurpose} credential` }),
            node("code", { text: oneTime.value || oneTime }),
            oneTime.expiresAt ? node("small", { className: "muted", text: `Expires ${oneTime.expiresAt}` }) : null,
            node("small", { className: "muted", text: "Store this in the application sender's secret store now. It will not appear in the registry or audit trail again." }),
            oneTime.purpose === "source-ingest" ? node("p", { text: ingestInstructions }) : null,
            oneTime.purpose === "source-ingest" ? node("a", { text: "Read the exact ingest contract", attrs: { href: "#/docs" } }) : null
          ]) : null
        ]),
        node("button", { className: "resource-action", text: "Dismiss", attrs: { type: "button", "data-command-dismiss": "" } })
      ]);
    }

    function administrationReady() {
      return Boolean(administration && state.session.authenticated
        && state.administrationState === "ready" && state.administrationSnapshot);
    }

    function administrationNotice() {
      if (!administration) {
        return node("section", { className: "notice", attrs: { "data-tone": "warn" } }, [
          node("strong", { text: "Administration provider not connected" }),
          node("span", { text: "The complete management structure is visible, but writes stay disabled until a version 1 SOC_CONSOLE_ADMINISTRATION provider is installed." })
        ]);
      }
      if (!state.session.authenticated) {
        return node("section", { className: "notice", attrs: { "data-tone": "warn" } }, [
          node("strong", { text: "Authentication required" }),
          node("span", { text: "Agent prompts and managed governance records are never read or changed for an anonymous browser session." })
        ]);
      }
      if (state.administrationState === "loading") {
        return node("section", { className: "notice", attrs: { role: "status", "data-tone": "info" } }, [
          node("span", { className: "state-spinner", attrs: { "aria-hidden": "true" } }),
          node("span", { text: "Reading the authorized administration registry…" })
        ]);
      }
      if (state.administrationState === "error") {
        return node("section", { className: "notice", attrs: { role: "alert", "data-tone": "bad" } }, [
          node("strong", { text: "Administration registry unavailable" }),
          node("span", { text: "Management controls remain disabled. No page-adapter data can enable them." })
        ]);
      }
      return node("section", { className: "notice administration-boundary", attrs: { "data-tone": "ok" } }, [
        node("strong", { text: "Server-authorized management" }),
        node("span", { text: `Validated administration snapshot · revision ${state.administrationSnapshot.revision}. Every write uses optimistic concurrency and the server reauthorizes it.` })
      ]);
    }

    function administrationResultPanel() {
      const result = state.administrationResult;
      if (!result) return null;
      const succeeded = result.status === "succeeded";
      const oneTime = result.output && result.output.oneTimeCredential;
      return node("section", { className: "notice command-result-notice", attrs: {
        role: succeeded ? "status" : "alert",
        "data-tone": succeeded ? "ok" : "bad"
      } }, [
        node("div", {}, [
          node("strong", { text: succeeded ? "Administration action completed" : "Administration action was not completed" }),
          node("span", { text: succeeded
            ? "The managed registry has been refreshed."
            : (result.error && result.error.message) || "The server refused or could not complete this action." }),
          oneTime ? node("div", { className: "one-time-credential" }, [
            node("strong", { text: "One-time agent enrollment credential" }),
            node("code", { text: oneTime.value }),
            node("small", { className: "muted", text: `Expires ${oneTime.expiresAt}. Deliver it only to the intended agent; it will not be shown on replay.` })
          ]) : null
        ]),
        node("button", { className: "resource-action", text: "Dismiss", attrs: {
          type: "button", "data-administration-dismiss": ""
        } })
      ]);
    }

    function administrationOptions(values) {
      return values.map((entry) => typeof entry === "string"
        ? { value: entry, label: entry }
        : entry);
    }

    function administrationControl(field, inputId, interactive, draftValues) {
      const value = draftValues && Object.prototype.hasOwnProperty.call(draftValues, field.name)
        ? draftValues[field.name]
        : field.value;
      const attributes = {
        id: inputId,
        name: field.name,
        disabled: interactive ? undefined : true,
        required: field.required ? true : undefined,
        placeholder: field.placeholder,
        min: field.min,
        max: field.max,
        step: field.step,
        autocomplete: "off"
      };
      if (field.type === "textarea") {
        const control = node("textarea", { attrs: { ...attributes, rows: String(field.rows || 6) } });
        control.value = value === undefined || value === null ? "" : String(value);
        return control;
      }
      if (field.type === "select") {
        const control = node("select", { attrs: attributes }, [
          node("option", { text: field.emptyLabel || "Choose…", attrs: { value: "" } }),
          ...administrationOptions(field.options || []).map((option) => node("option", {
            text: option.label,
            attrs: { value: option.value, selected: String(value || "") === String(option.value) ? true : undefined }
          }))
        ]);
        control.value = value === undefined || value === null ? "" : String(value);
        return control;
      }
      const control = node("input", { attrs: { ...attributes, type: field.type || "text" } });
      control.value = value === undefined || value === null ? "" : String(value);
      return control;
    }

    function administrationForm(title, action, fields, submitLabel, options = {}) {
      const interactive = administrationReady();
      const draft = state.administrationDraft && state.administrationDraft.action === action
        ? state.administrationDraft.values : null;
      const controls = node("div", { className: "form-grid" }, fields.map((field, index) => {
        const inputId = `administration-${slug(action)}-${index}-${slug(field.name)}`;
        return node("label", { className: `form-field${field.wide ? " wide" : ""}`, attrs: { for: inputId } }, [
          node("span", { text: `${field.label}${field.required ? " · required" : ""}` }),
          administrationControl(field, inputId, interactive, draft),
          field.help ? node("small", { className: "muted", text: field.help }) : null
        ]);
      }));
      const form = node(interactive ? "form" : "div", {
        className: "panel-body skeleton-form administration-form",
        attrs: interactive ? { "data-administration-form": "", "data-administration-action": action } : {}
      }, [
        controls,
        node("div", { className: "form-actions" }, node("button", {
          className: "resource-action",
          text: state.administrationPending ? "Working…" : submitLabel,
          attrs: {
            type: interactive ? "submit" : "button",
            disabled: !interactive || state.administrationPending,
            title: interactive ? "The server will authorize, revision-check, and audit this action." : "Connect an authenticated administration provider to enable this action."
          }
        }))
      ]);
      return panelShell(title, form, options.meta || "Administration contract v1", undefined, { id: options.id || slug(title), className: "administration-panel" });
    }

    function administrationAction(action, label, attributes = {}) {
      const interactive = administrationReady();
      return node("button", {
        className: "resource-action administration-action",
        text: state.administrationPending ? "Working…" : label,
        attrs: {
          type: "button",
          disabled: !interactive || state.administrationPending,
          title: interactive ? "The server will authorize, revision-check, and audit this action." : "Authenticated administration provider required.",
          "data-administration-action": action,
          ...attributes
        }
      });
    }

    function administrationTable(title, columns, rows, emptyLabel, id) {
      const table = node("table");
      table.append(node("caption", { className: "sr-only", text: title }));
      table.append(node("thead", {}, node("tr", {}, columns.map((column) => node("th", { text: column, attrs: { scope: "col" } })) )));
      const body = node("tbody");
      if (!rows.length) {
        body.append(node("tr", {}, node("td", { className: "table-empty muted", text: emptyLabel, attrs: { colspan: String(columns.length) } })));
      } else {
        rows.forEach((cells) => body.append(node("tr", { attrs: { "data-filterable": "" } }, cells.map((cell) => node("td", {}, cell)))));
      }
      table.append(body);
      const revision = state.administrationSnapshot ? state.administrationSnapshot.revision : "—";
      return panelShell(title, node("div", { className: "table-scroll" }, table), `Managed registry · revision ${revision}`, undefined, { id, className: "administration-panel" });
    }

    function administrationTime(value) {
      if (!value) return "—";
      return node("time", { text: new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium", timeStyle: "short", timeZone: state.timezone === "UTC" ? "UTC" : undefined
      }).format(new Date(value)), attrs: { datetime: value } });
    }

    function administrationChanges(domain) {
      const snapshot = state.administrationSnapshot;
      const rows = snapshot && snapshot.domain === domain
        ? snapshot.changes.slice().reverse().map((change) => [
          administrationTime(change.at), change.action, change.resourceType, change.resourceId, change.status, change.message || "—"
        ]) : [];
      return administrationTable("Administration change history", ["When", "Action", "Type", "Resource", "Outcome", "Summary"], rows,
        "No managed changes have been recorded.", "administration-change-history");
    }

    function agentOptions(includeArchived = false, allowedStates = null) {
      const snapshot = state.administrationSnapshot;
      if (!snapshot || snapshot.domain !== "agents") return [];
      return snapshot.agents.filter((agent) => (includeArchived || agent.state !== "archived")
          && (!allowedStates || allowedStates.includes(agent.state)))
        .map((agent) => ({ value: agent.agentId, label: `${agent.displayName} · ${agent.state}` }));
    }

    function agentRows(agents) {
      return agents.map((agent) => {
        const actions = [];
        if (agent.state === "active") actions.push(administrationAction("agent.pause", "Pause", { "data-agent-id": agent.agentId }));
        if (agent.state === "paused") actions.push(administrationAction("agent.resume", "Resume", { "data-agent-id": agent.agentId }));
        if (agent.state !== "archived") actions.push(administrationAction("agent.archive", "Archive", { "data-agent-id": agent.agentId }));
        if (agent.state === "archived") {
          actions.push(administrationAction("agent.restore", "Restore", { "data-agent-id": agent.agentId }));
          actions.push(administrationAction("agent.remove", "Remove", { "data-agent-id": agent.agentId }));
        }
        return [
          node("a", { text: agent.displayName, attrs: { href: routeHash("/agents", { atab: "agents", agent: agent.agentId }) } }),
          agent.kind,
          agent.provider || "application",
          agent.model || "—",
          agent.activePromptId || "No active prompt",
          node("span", { className: "badge b-muted", text: agent.state }),
          administrationTime(agent.lastSeenAt),
          node("div", { className: "administration-row-actions" }, actions)
        ];
      });
    }

    function selectedAgentPanel(agent) {
      if (!agent) return null;
      return node("div", { className: "administration-detail-stack" }, [
        panelShell("Selected agent", node("dl", { className: "administration-facts" }, [
          node("div", {}, [node("dt", { text: "Agent ID" }), node("dd", { text: agent.agentId })]),
          node("div", {}, [node("dt", { text: "State" }), node("dd", { text: agent.state })]),
          node("div", {}, [node("dt", { text: "Capabilities" }), node("dd", { text: agent.capabilities.join(", ") || "None declared" })]),
          node("div", {}, [node("dt", { text: "Active prompt" }), node("dd", { text: agent.activePromptId || "None" })])
        ]), "Managed metadata", undefined, { id: "selected-agent", className: "administration-panel" }),
        agent.state !== "archived" ? administrationForm("Update agent metadata", "agent.update", [
          { name: "agentId", label: "Agent", type: "select", options: [{ value: agent.agentId, label: agent.displayName }], value: agent.agentId, required: true },
          { name: "displayName", label: "Display name", value: agent.displayName, required: true },
          { name: "description", label: "Description", value: agent.description || "", wide: true },
          { name: "kind", label: "Kind", type: "select", options: ["interactive", "automation", "service"], value: agent.kind, required: true },
          { name: "provider", label: "Provider type", value: agent.provider || "" },
          { name: "model", label: "Model", value: agent.model || "" },
          { name: "capabilities", label: "Capabilities · comma separated", value: agent.capabilities.join(", "), wide: true,
            help: "Capability names are inventory metadata; the server permission policy remains authoritative." }
        ], "Save agent metadata", { id: "agent-update" }) : node("section", { className: "notice", attrs: { "data-tone": "info" } }, [
          node("strong", { text: "Archived agent is read-only" }),
          node("span", { text: "Restore this agent before changing metadata or creating prompt revisions." })
        ])
      ]);
    }

    function agentsAdministrationView(tabState) {
      const snapshot = state.administrationSnapshot && state.administrationSnapshot.domain === "agents"
        ? state.administrationSnapshot : { agents: [], prompts: [], enrollments: [], changes: [], revision: 0 };
      const activeTab = tabState.values.atab || "agents";
      if (activeTab === "add") {
        return administrationForm("Add an agent", "agent.create", [
          { name: "displayName", label: "Display name", required: true },
          { name: "description", label: "Purpose / description", type: "textarea", rows: 3, wide: true },
          { name: "kind", label: "Kind", type: "select", options: ["interactive", "automation", "service"], value: "automation", required: true },
          { name: "provider", label: "Provider type", placeholder: "local, mcp, api…" },
          { name: "model", label: "Model identifier" },
          { name: "capabilities", label: "Capabilities · comma separated", wide: true,
            help: "These are bounded declarations, never permissions. Effective tool access is assigned and enforced server-side." }
        ], "Create agent", { id: "agent-create", meta: "Create → prompt revision → enrollment → activation policy" });
      }
      if (activeTab === "prompts") {
        const promptRows = snapshot.prompts.slice().sort((left, right) => right.version - left.version).map((prompt) => [
          snapshot.agents.find((agent) => agent.agentId === prompt.agentId)?.displayName || prompt.agentId,
          node("a", { text: prompt.title, attrs: { href: routeHash("/agents", { atab: "prompts", prompt: prompt.promptId }) } }),
          prompt.version,
          prompt.state,
          administrationTime(prompt.updatedAt),
          node("div", { className: "administration-row-actions" }, [
            prompt.state === "draft" ? administrationAction("prompt.activate", "Activate", { "data-prompt-id": prompt.promptId }) : null,
            prompt.state !== "archived" ? administrationAction("prompt.archive", "Archive", { "data-prompt-id": prompt.promptId }) : null
          ])
        ]);
        const loadedPrompt = state.administrationPrompt;
        return node("div", { className: "administration-detail-stack" }, [
          loadedPrompt ? panelShell("Loaded prompt revision", node("div", { className: "panel-body" }, [
            node("p", { className: "muted", text: `${loadedPrompt.title} · v${loadedPrompt.version} · ${loadedPrompt.state}` }),
            node("pre", { className: "technical-documentation-code administration-prompt-body", attrs: { tabindex: "0" } }, node("code", { text: loadedPrompt.body }))
          ]), "Authorized single-revision read", undefined, { id: "loaded-agent-prompt", className: "administration-panel" }) : null,
          administrationForm("Create an immutable prompt revision", "prompt.revise", [
            { name: "agentId", label: "Agent", type: "select", options: agentOptions(false, ["active"]), required: true },
            { name: "title", label: "Revision title", required: true },
            { name: "basePromptId", label: "Base prompt ID", value: loadedPrompt ? loadedPrompt.promptId : "",
              help: "Optional concurrency lineage reference; it must belong to the selected agent." },
            { name: "body", label: "Prompt body", type: "textarea", rows: 14, wide: true, required: true,
              value: loadedPrompt ? loadedPrompt.body : "", help: "Stored as untrusted plain text. Prompt text never grants tools or permissions." }
          ], "Create draft revision", { id: "agent-prompt-editor" }),
          administrationTable("Prompt revision history", ["Agent", "Revision", "Version", "State", "Updated", "Actions"], promptRows,
            "No prompt revisions have been created.", "agent-prompt-history")
        ]);
      }
      if (activeTab === "enrollment") {
        const enrollmentRows = snapshot.enrollments.slice().reverse().map((entry) => [
          snapshot.agents.find((agent) => agent.agentId === entry.agentId)?.displayName || entry.agentId,
          entry.enrollmentId,
          entry.state,
          administrationTime(entry.expiresAt),
          administrationTime(entry.connectedAt),
          !["revoked", "expired"].includes(entry.state)
            ? administrationAction("enrollment.revoke", "Revoke", { "data-enrollment-id": entry.enrollmentId }) : "—"
        ]);
        return node("div", { className: "administration-detail-stack" }, [
          administrationForm("Issue one-time agent enrollment", "enrollment.issue", [
            { name: "agentId", label: "Agent", type: "select", options: agentOptions(), required: true },
            { name: "expiresInSeconds", label: "Expires in seconds", type: "number", min: "60", max: "86400", value: "600", required: true,
              help: "The reference is displayed exactly once. Prefer Tailnet identity, mTLS, or public-key binding in production." }
          ], "Issue enrollment", { id: "agent-enrollment" }),
          administrationTable("Enrollment and connection state", ["Agent", "Enrollment", "State", "Expires", "Connected", "Action"],
            enrollmentRows, "No enrollment has been issued.", "agent-enrollment-history")
        ]);
      }
      if (activeTab === "audit") return administrationChanges("agents");
      const selectedId = state.query.get("agent");
      const selected = selectedId ? snapshot.agents.find((agent) => agent.agentId === selectedId) : null;
      return node("div", { className: "administration-detail-stack" }, [
        selectedAgentPanel(selected),
        administrationTable("Agent inventory", ["Agent", "Kind", "Provider", "Model", "Active prompt", "State", "Last seen", "Actions"],
          agentRows(snapshot.agents), "No agents have been registered.", "agent-inventory")
      ]);
    }

    function attestationRows(items) {
      return items.map((item) => [
        node("a", { text: item.title, attrs: { href: routeHash("/attestation", { id: item.attestationId }) } }),
        item.owner || "Unassigned",
        node("span", { className: "badge b-muted", text: item.status }),
        administrationTime(item.dueAt),
        item.revision,
        node("a", { className: "resource-action", text: "Manage", attrs: { href: routeHash("/attestation", { id: item.attestationId }) } })
      ]);
    }

    function attestationsAdministrationView(tabState) {
      const snapshot = state.administrationSnapshot && state.administrationSnapshot.domain === "governance"
        ? state.administrationSnapshot : { attestations: [], risks: [], changes: [], revision: 0 };
      const activeTab = tabState.values.gtab || "active";
      if (activeTab === "create") {
        return administrationForm("Add an attestation", "attestation.create", [
          { name: "title", label: "Title", required: true },
          { name: "description", label: "Attestation statement", type: "textarea", rows: 7, wide: true },
          { name: "owner", label: "Owner reference" },
          { name: "dueAt", label: "Due date", type: "datetime-local" }
        ], "Create attestation", { id: "create-attestation" });
      }
      if (activeTab === "history") return administrationChanges("governance");
      const archived = activeTab === "archived";
      const items = snapshot.attestations.filter((item) => (item.status === "archived") === archived);
      return administrationTable(archived ? "Archived attestations" : "Managed attestations",
        ["Attestation", "Owner", "Status", "Due", "Revision", ""], attestationRows(items),
        archived ? "No attestations are archived." : "No active attestations have been created.",
        archived ? "archived-attestations" : "remediation-attestations");
    }

    function attestationDetailView() {
      const snapshot = state.administrationSnapshot && state.administrationSnapshot.domain === "governance"
        ? state.administrationSnapshot : { attestations: [] };
      const item = snapshot.attestations.find((entry) => entry.attestationId === state.query.get("id"));
      if (!item) return panelShell("Attestation not selected", node("div", { className: "panel-body" }, [
        node("p", { className: "muted", text: "Choose a managed attestation from the index. The skeleton never invents a record." }),
        node("a", { className: "resource-action", text: "Back to Attestations", attrs: { href: routeHash("/attestations") } })
      ]), "No record", undefined, { id: "attestation-missing" });
      const lifecycle = node("div", { className: "administration-row-actions" }, [
        item.status !== "archived" ? administrationAction("attestation.archive", "Archive", { "data-attestation-id": item.attestationId }) : null,
        item.status === "archived" ? administrationAction("attestation.restore", "Restore", { "data-attestation-id": item.attestationId }) : null,
        item.status === "archived" ? administrationAction("attestation.remove", "Remove", { "data-attestation-id": item.attestationId }) : null
      ]);
      return node("div", { className: "administration-detail-stack" }, [
        panelShell(item.title, node("div", { className: "panel-body" }, [
          node("p", { text: item.description || "No statement supplied." }),
          node("p", { className: "muted", text: `${item.attestationId} · ${item.status} · revision ${item.revision}` }), lifecycle
        ]), "Authoritative managed record", undefined, { id: "attestation-detail", className: "administration-panel" }),
        item.status !== "archived" ? administrationForm("Update attestation", "attestation.update", [
          { name: "attestationId", label: "Attestation", type: "select", options: [{ value: item.attestationId, label: item.title }], value: item.attestationId, required: true },
          { name: "title", label: "Title", value: item.title, required: true },
          { name: "description", label: "Statement", type: "textarea", rows: 7, wide: true, value: item.description || "" },
          { name: "owner", label: "Owner reference", value: item.owner || "" },
          { name: "dueAt", label: "Due date", type: "datetime-local", value: item.dueAt ? item.dueAt.slice(0, 16) : "" }
        ], "Save attestation", { id: "edit-attestation" }) : node("section", { className: "notice", attrs: { "data-tone": "info" } }, [
          node("strong", { text: "Archived attestation is read-only" }),
          node("span", { text: "Restore it before editing the statement or changing its workflow status." })
        ]),
        item.status !== "archived" ? administrationForm("Change attestation status", "attestation.transition", [
          { name: "attestationId", label: "Attestation", type: "select", options: [{ value: item.attestationId, label: item.title }], value: item.attestationId, required: true },
          { name: "status", label: "New status", type: "select", options: ["draft", "pending", "attested", "expired"], required: true },
          { name: "note", label: "Review note", type: "textarea", rows: 4, wide: true,
            help: "Production policy should require opaque evidence references and a separate approval for attested state." }
        ], "Apply status", { id: "transition-attestation" }) : null
      ]);
    }

    function riskRows(items) {
      return items.map((item) => [
        node("a", { text: item.title, attrs: { href: routeHash("/risk", { id: item.riskId }) } }),
        item.owner || "Unassigned",
        item.likelihood,
        item.impact,
        node("span", { className: "badge b-muted", text: item.status }),
        administrationTime(item.reviewAt),
        node("a", { className: "resource-action", text: "Manage", attrs: { href: routeHash("/risk", { id: item.riskId }) } })
      ]);
    }

    function risksAdministrationView(tabState) {
      const snapshot = state.administrationSnapshot && state.administrationSnapshot.domain === "governance"
        ? state.administrationSnapshot : { attestations: [], risks: [], changes: [], revision: 0 };
      const activeTab = tabState.values.riskTab || "active";
      if (activeTab === "create") {
        return administrationForm("Add a risk", "risk.create", [
          { name: "title", label: "Risk title", required: true },
          { name: "description", label: "Description", type: "textarea", rows: 7, wide: true },
          { name: "owner", label: "Owner reference" },
          { name: "likelihood", label: "Likelihood", type: "select", options: ["low", "moderate", "high", "critical"], required: true },
          { name: "impact", label: "Impact", type: "select", options: ["low", "moderate", "high", "critical"], required: true },
          { name: "reviewAt", label: "Review date", type: "datetime-local" }
        ], "Create risk", { id: "create-risk" });
      }
      if (activeTab === "history") return administrationChanges("governance");
      const archived = activeTab === "archived";
      const items = snapshot.risks.filter((item) => (item.status === "archived") === archived);
      return administrationTable(archived ? "Archived risks" : "Risk register",
        ["Risk", "Owner", "Likelihood", "Impact", "Status", "Review", ""], riskRows(items),
        archived ? "No risks are archived." : "No active risks have been created.",
        archived ? "archived-risks" : "managed-risks");
    }

    function riskDetailView() {
      const snapshot = state.administrationSnapshot && state.administrationSnapshot.domain === "governance"
        ? state.administrationSnapshot : { risks: [] };
      const item = snapshot.risks.find((entry) => entry.riskId === state.query.get("id"));
      if (!item) return panelShell("Risk not selected", node("div", { className: "panel-body" }, [
        node("p", { className: "muted", text: "Choose a managed risk from the register. The skeleton never invents a record." }),
        node("a", { className: "resource-action", text: "Back to Risk Register", attrs: { href: routeHash("/register") } })
      ]), "No record", undefined, { id: "risk-missing" });
      const lifecycle = node("div", { className: "administration-row-actions" }, [
        item.status !== "archived" ? administrationAction("risk.archive", "Archive", { "data-risk-id": item.riskId }) : null,
        item.status === "archived" ? administrationAction("risk.restore", "Restore", { "data-risk-id": item.riskId }) : null,
        item.status === "archived" ? administrationAction("risk.remove", "Remove", { "data-risk-id": item.riskId }) : null
      ]);
      return node("div", { className: "administration-detail-stack" }, [
        panelShell(item.title, node("div", { className: "panel-body" }, [
          node("p", { text: item.description || "No description supplied." }),
          node("p", { className: "muted", text: `${item.riskId} · ${item.status} · ${item.likelihood} likelihood · ${item.impact} impact` }), lifecycle
        ]), "Authoritative managed record", undefined, { id: "risk-detail", className: "administration-panel" }),
        item.status !== "archived" ? administrationForm("Update risk", "risk.update", [
          { name: "riskId", label: "Risk", type: "select", options: [{ value: item.riskId, label: item.title }], value: item.riskId, required: true },
          { name: "title", label: "Title", value: item.title, required: true },
          { name: "description", label: "Description", type: "textarea", rows: 7, wide: true, value: item.description || "" },
          { name: "owner", label: "Owner reference", value: item.owner || "" },
          { name: "likelihood", label: "Likelihood", type: "select", options: ["low", "moderate", "high", "critical"], value: item.likelihood, required: true },
          { name: "impact", label: "Impact", type: "select", options: ["low", "moderate", "high", "critical"], value: item.impact, required: true },
          { name: "reviewAt", label: "Review date", type: "datetime-local", value: item.reviewAt ? item.reviewAt.slice(0, 16) : "" }
        ], "Save risk", { id: "edit-risk" }) : node("section", { className: "notice", attrs: { "data-tone": "info" } }, [
          node("strong", { text: "Archived risk is read-only" }),
          node("span", { text: "Restore it before editing the record or changing its workflow status." })
        ]),
        item.status !== "archived" ? administrationForm("Change risk status", "risk.transition", [
          { name: "riskId", label: "Risk", type: "select", options: [{ value: item.riskId, label: item.title }], value: item.riskId, required: true },
          { name: "status", label: "New status", type: "select", options: ["open", "mitigating", "accepted", "closed"], required: true },
          { name: "note", label: "Review / closure note", type: "textarea", rows: 4, wide: true,
            help: "The reference runtime requires a note for closure. Production should also require opaque evidence and independent authorization." }
        ], "Apply status", { id: "transition-risk" }) : null
      ]);
    }

    function administrationView(page, tabState) {
      if (page.variant === "administration-agents") return agentsAdministrationView(tabState);
      if (page.variant === "administration-attestations") return attestationsAdministrationView(tabState);
      if (page.variant === "administration-attestation") return attestationDetailView();
      if (page.variant === "administration-risks") return risksAdministrationView(tabState);
      if (page.variant === "administration-risk") return riskDetailView();
      return null;
    }

    function validatedTechnicalDocs() {
      if (!technicalDocs || typeof technicalDocs !== "object" || Array.isArray(technicalDocs)) return null;
      if (technicalDocs.schemaVersion !== VERSION || technicalDocs.documentType !== "technical-manual") return null;
      if (typeof technicalDocs.title !== "string" || technicalDocs.title.length < 1 || technicalDocs.title.length > 200) return null;
      if (technicalDocs.source !== "technical-reference.md") return null;
      if (typeof technicalDocs.markdown !== "string" || technicalDocs.markdown.length < 20000 || technicalDocs.markdown.length > 300000) return null;
      if (!Array.isArray(technicalDocs.sections) || technicalDocs.sections.length < 20 || technicalDocs.sections.length > 100) return null;
      const ids = new Set();
      let priorLine = 0;
      for (const section of technicalDocs.sections) {
        if (!section || typeof section !== "object" || Array.isArray(section)) return null;
        if (typeof section.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(section.id) || ids.has(section.id)) return null;
        if (typeof section.title !== "string" || section.title.length < 1 || section.title.length > 200) return null;
        if (!Number.isSafeInteger(section.line) || section.line <= priorLine) return null;
        ids.add(section.id);
        priorLine = section.line;
      }
      return technicalDocs;
    }

    function documentationInline(value) {
      const fragment = documentRef.createDocumentFragment();
      const source = String(value || "");
      const pattern = /\*\*([^*]+)\*\*/g;
      let cursor = 0;
      let match;
      while ((match = pattern.exec(source)) !== null) {
        if (match.index > cursor) fragment.append(documentRef.createTextNode(source.slice(cursor, match.index)));
        fragment.append(node("strong", { text: match[1] }));
        cursor = pattern.lastIndex;
      }
      if (cursor < source.length) fragment.append(documentRef.createTextNode(source.slice(cursor)));
      return fragment;
    }

    function documentationTableCells(line) {
      let normalized = String(line || "").trim();
      if (normalized.startsWith("|")) normalized = normalized.slice(1);
      if (normalized.endsWith("|")) normalized = normalized.slice(0, -1);
      return normalized.split("|").map((cell) => cell.trim());
    }

    function documentationBoundary(lines, index) {
      const line = lines[index] || "";
      const trimmed = line.trim();
      if (!trimmed) return true;
      if (/^#{1,4}\s+/.test(trimmed) || /^~~~/.test(trimmed)) return true;
      if (/^-\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) return true;
      return trimmed.includes("|")
        && index + 1 < lines.length
        && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1] || "");
    }

    function documentationBlocks(lines, captionPrefix) {
      const fragment = documentRef.createDocumentFragment();
      let index = 0;
      while (index < lines.length) {
        const line = lines[index] || "";
        const trimmed = line.trim();
        if (!trimmed) {
          index += 1;
          continue;
        }
        if (/^#\s+/.test(trimmed)) {
          index += 1;
          continue;
        }
        const heading = /^(#{3,4})\s+(.+)$/.exec(trimmed);
        if (heading) {
          const level = heading[1].length;
          fragment.append(node("h" + level, { className: "technical-documentation-subheading" }, documentationInline(heading[2])));
          index += 1;
          continue;
        }
        const fence = /^~~~([a-z0-9-]*)$/i.exec(trimmed);
        if (fence) {
          const codeLines = [];
          index += 1;
          while (index < lines.length && !/^~~~\s*$/.test(lines[index].trim())) {
            codeLines.push(lines[index]);
            index += 1;
          }
          if (index < lines.length) index += 1;
          fragment.append(node("pre", { className: "technical-documentation-code", attrs: {
            tabindex: "0",
            "aria-label": (fence[1] ? fence[1] + " " : "") + "code example"
          } }, node("code", { text: codeLines.join("\n"), attrs: fence[1] ? { "data-language": fence[1] } : {} })));
          continue;
        }
        const isTable = trimmed.includes("|")
          && index + 1 < lines.length
          && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1] || "");
        if (isTable) {
          const headers = documentationTableCells(line);
          index += 2;
          const bodyRows = [];
          while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
            bodyRows.push(documentationTableCells(lines[index]));
            index += 1;
          }
          const tableBody = node("tbody");
          bodyRows.forEach((row) => {
            const cells = headers.map((_header, cellIndex) =>
              node("td", {}, documentationInline(row[cellIndex] || "")));
            tableBody.append(node("tr", {}, cells));
          });
          const table = node("table", { className: "technical-documentation-table" }, [
            node("caption", { className: "sr-only", text: captionPrefix + " reference table" }),
            node("thead", {}, node("tr", {}, headers.map((header) => node("th", { attrs: { scope: "col" } }, documentationInline(header))))),
            tableBody
          ]);
          fragment.append(node("div", { className: "technical-documentation-table-wrap", attrs: { tabindex: "0" } }, table));
          continue;
        }
        const unordered = /^-\s+(.+)$/.exec(trimmed);
        const ordered = /^\d+\.\s+(.+)$/.exec(trimmed);
        if (unordered || ordered) {
          const orderedList = Boolean(ordered);
          const items = [];
          while (index < lines.length) {
            const current = lines[index].trim();
            const itemMatch = orderedList ? /^\d+\.\s+(.+)$/.exec(current) : /^-\s+(.+)$/.exec(current);
            if (!itemMatch) break;
            const parts = [itemMatch[1]];
            index += 1;
            while (index < lines.length && lines[index].trim()
                && !documentationBoundary(lines, index)
                && !/^\d+\.\s+/.test(lines[index].trim())
                && !/^-\s+/.test(lines[index].trim())) {
              parts.push(lines[index].trim());
              index += 1;
            }
            let itemText = parts.join(" ");
            if (itemText.startsWith("[ ] ")) itemText = "☐ " + itemText.slice(4);
            else if (/^\[[xX]\]\s+/.test(itemText)) itemText = "☑ " + itemText.slice(4);
            items.push(node("li", {}, documentationInline(itemText)));
            while (index < lines.length && !lines[index].trim()) index += 1;
          }
          fragment.append(node(orderedList ? "ol" : "ul", { className: "technical-documentation-list" }, items));
          continue;
        }
        const paragraphLines = [trimmed];
        index += 1;
        while (index < lines.length && lines[index].trim() && !documentationBoundary(lines, index)) {
          paragraphLines.push(lines[index].trim());
          index += 1;
        }
        fragment.append(node("p", {}, documentationInline(paragraphLines.join(" "))));
      }
      return fragment;
    }

    function renderTechnicalDocumentation() {
      const documentValue = validatedTechnicalDocs();
      if (!documentValue) {
        return node("section", { className: "notice", attrs: { role: "alert", "data-tone": "bad" } }, [
          node("strong", { text: "Technical reference unavailable" }),
          node("span", { text: "The checked-in technical documentation did not pass its local integrity checks." })
        ]);
      }
      const lines = documentValue.markdown.split("\n");
      const sectionIds = new Set(documentValue.sections.map((section) => section.id));
      const requestedSection = String(state.query.get("section") || "");
      const selectedSection = sectionIds.has(requestedSection) ? requestedSection : "";
      const invalidSection = requestedSection && !selectedSection;
      const selectedSectionIndex = selectedSection
        ? documentValue.sections.findIndex((section) => section.id === selectedSection)
        : -1;
      const previousSection = selectedSectionIndex > 0
        ? documentValue.sections[selectedSectionIndex - 1]
        : null;
      const nextSection = selectedSectionIndex >= 0 && selectedSectionIndex < documentValue.sections.length - 1
        ? documentValue.sections[selectedSectionIndex + 1]
        : documentValue.sections[0];
      const firstSectionLine = documentValue.sections[0].line - 1;
      const commandCount = connectorRuntime && Array.isArray(connectorRuntime.COMMANDS)
        ? connectorRuntime.COMMANDS.length : 0;
      const recordKindCount = connectorRuntime && Array.isArray(connectorRuntime.RECORD_KINDS)
        ? connectorRuntime.RECORD_KINDS.length : 0;
      const introduction = node("section", { className: "technical-documentation-introduction" }, [
        node("p", { className: "eyebrow", text: "Implementation manual · contract version 1" }),
        node("div", { className: "technical-documentation-statuses", attrs: { "aria-label": "Implementation status categories" } }, [
          node("span", { className: "badge b-info", text: "Shipped browser contract" }),
          node("span", { className: "badge b-muted", text: "Loopback reference behavior" }),
          node("span", { className: "badge b-warn", text: "Adopter-required production work" }),
          node("span", { className: "badge b-muted", text: "Proposed MCP boundary" })
        ]),
        node("div", { className: "technical-documentation-summary" }, [
          node("article", {}, [node("strong", { text: String(documentValue.sections.length) }), node("span", { text: "Detailed chapters" })]),
          node("article", {}, [node("strong", { text: String(recordKindCount) }), node("span", { text: "Canonical record kinds" })]),
          node("article", {}, [node("strong", { text: String(commandCount) }), node("span", { text: "Lifecycle commands" })])
        ]),
        node("div", { className: "technical-documentation-actions" }, [
          node("a", { className: "resource-action", text: "Open raw agent-readable Markdown", attrs: {
            href: documentValue.source,
            target: "_blank",
            rel: "noopener",
            type: "text/markdown"
          } }),
          node("code", { text: "public/" + documentValue.source })
        ]),
        documentationBlocks(lines.slice(0, firstSectionLine), "Technical documentation introduction")
      ]);
      const tableOfContents = node("nav", {
        className: "technical-documentation-toc",
        attrs: { "aria-label": "Technical documentation sections" }
      }, [
        node("div", { className: "technical-documentation-toc-heading" }, [
          node("strong", { text: "Contents" }),
          node("a", { text: "Top", attrs: { href: routeHash("/docs") } })
        ]),
        node("label", { className: "technical-documentation-filter" }, [
          node("span", { className: "sr-only", text: "Filter technical documentation chapters" }),
          node("input", { attrs: {
            type: "search",
            autocomplete: "off",
            placeholder: "Filter chapters…",
            value: pageFilters.get("/docs") || "",
            "data-documentation-filter": "",
            "aria-controls": "technical-documentation-article"
          } })
        ]),
        node("ol", {}, documentValue.sections.map((section) => node("li", {}, node("a", {
          text: section.title,
          attrs: {
            href: routeHash("/docs", { section: section.id }),
            "data-documentation-section-link": section.id,
            "aria-current": selectedSection === section.id ? "location" : null
          }
        }))))
      ]);
      const chapterJump = node("nav", {
        className: "technical-documentation-jump",
        attrs: { "aria-label": "Jump between technical documentation chapters" }
      }, [
        node("label", { className: "technical-documentation-jump-select" }, [
          node("span", { text: "Jump to chapter" }),
          node("select", { attrs: { "data-documentation-jump": "", "aria-label": "Jump to technical documentation chapter" } }, [
            node("option", { text: "Manual introduction", attrs: { value: "", selected: selectedSection ? undefined : true } }),
            ...documentValue.sections.map((section) => node("option", {
              text: section.title,
              attrs: { value: section.id, selected: selectedSection === section.id ? true : undefined }
            }))
          ])
        ]),
        node("div", { className: "technical-documentation-jump-actions" }, [
          previousSection ? node("a", {
            className: "resource-action",
            text: "Previous",
            attrs: { href: routeHash("/docs", { section: previousSection.id }) }
          }) : node("a", { className: "resource-action", text: "Top", attrs: { href: routeHash("/docs") } }),
          node("a", {
            className: "resource-action",
            text: selectedSectionIndex >= 0 ? "Next" : "First chapter",
            attrs: { href: routeHash("/docs", { section: nextSection.id }) }
          })
        ])
      ]);
      const article = node("article", {
        className: "technical-documentation-article",
        attrs: { id: "technical-documentation-article", "aria-label": documentValue.title }
      });
      if (invalidSection) {
        article.append(node("section", { className: "notice", attrs: { "data-tone": "warn" } }, [
          node("strong", { text: "Unknown documentation section" }),
          node("span", { text: "The complete manual is shown. Choose a section from the contents list." })
        ]));
      }
      article.append(introduction);
      documentValue.sections.forEach((section, sectionIndex) => {
        const start = section.line;
        const end = sectionIndex + 1 < documentValue.sections.length
          ? documentValue.sections[sectionIndex + 1].line - 1
          : lines.length;
        article.append(node("section", {
          className: "technical-documentation-section" + (selectedSection === section.id ? " is-targeted" : ""),
          attrs: { "data-filterable": "", "data-documentation-section": section.id }
        }, [
          node("h2", {
            text: section.title,
            attrs: { id: "docs-" + section.id, tabindex: "-1" }
          }),
          documentationBlocks(lines.slice(start, end), section.title)
        ]));
      });
      article.append(node("section", {
        className: "technical-documentation-no-results notice",
        attrs: { "data-tone": "warn", hidden: true, role: "status" }
      }, [
        node("strong", { text: "No matching chapters" }),
        node("span", { text: "Clear the documentation filter to restore the complete manual." })
      ]));
      return node("div", { className: "technical-documentation" }, [
        chapterJump,
        node("div", { className: "technical-documentation-layout" }, [tableOfContents, article])
      ]);
    }

    function renderPage() {
      // A read may have started before the user selected a file or received a
      // one-time credential. Recheck at the actual DOM replacement boundary.
      const routeKey = routeHash(state.route, queryObject(state.query));
      if (privateViewCleanup && privateViewRoute === routeKey && privateViewCleanup.isDirty && privateViewCleanup.isDirty()
          && (!(config.auth && config.auth.required) || state.session.authenticated)) {
        updateShellState();
        return;
      }
      if (privateViewCleanup) { privateViewCleanup(); privateViewCleanup = null; }
      if (assistanceCleanup) { assistanceCleanup(); assistanceCleanup = null; }
      privateViewRoute = null;
      updateNavigation();
      updateShellState();
      const page = pageByPath.get(state.route);
      if (!page) {
        documentRef.title = `${config.brand.product} · Page not found`;
        root.replaceChildren(node("section", { className: "panel empty-state", attrs: { role: "alert", "aria-labelledby": "not-found-title" } }, [
          node("h1", { text: "Page not found", attrs: { id: "not-found-title" } }),
          node("p", { text: "That route is not part of the public SOC interface catalog." }),
          node("a", { className: "resource-action", text: "Return to Overview", attrs: { href: routeHash("/") } })
        ]));
        return;
      }
      documentRef.title = `${config.brand.product} · ${pageDisplayTitle(page)}`;

      const tabState = activeTabsets(page, state.query);
      const tuningMode = page.variant === "tuning" ? tuningQueryMode(state.query) : "registry";
      const embeddedTuning = page.variant === "rules" && tabState.values.rtab === "tuning";
      const routeClass = `${slug(page.path === "/" ? "overview" : page.path)}-page`;
      const variantClass = page.variant === "overview"
        ? " soc-overview"
        : page.variant === "tuning" || embeddedTuning
          ? ` tune-page${embeddedTuning ? " tune-page-embedded" : ""}`
          : "";
      const wrapper = node("div", { className: `page wrap ${routeClass}${variantClass}` });
      const queryDetail = (page.path === "/phishing" && state.query.get("id"))
        || (page.path === "/access" && state.query.get("atab") === "offboarding" && state.query.get("id"))
        || (page.variant === "tuning" && tuningMode !== "registry")
        || (page.variant === "rules" && state.query.get("ruleView"));
      if (page.hidden || queryDetail) wrapper.append(breadcrumbs(page));
      wrapper.append(pageHeader(page));

      const setupId = state.query.get("setupId");
      if (page.path !== "/sources" || state.query.get("stab") !== "setup") {
        if (typeof setupId === "string" && /^setup-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(setupId)) wrapper.append(node("section", { className: "notice", attrs: { role: "note" } }, [
          node("p", { text: "Complete this connection step, then return to your saved setup guide to select the source and check real delivery. These instructions do not grant access or prove readiness." }),
          node("a", { className: "resource-action", text: "Return to saved setup guide", attrs: { href: "#/sources?stab=setup&setupId=" + encodeURIComponent(setupId) } })
        ]));
      }

      if (config.auth && config.auth.required && !state.session.authenticated) {
        wrapper.append(authGate(page));
        root.replaceChildren(wrapper);
        return;
      }

      if (global.SOC_PRIVATE_APPLICATION && global.SocSetupAssistance && !page.hidden) {
        const screenNeedsHelp = !page.localOnly
          && (state.providerError || ["empty", "error"].includes(state.envelope && state.envelope.state));
        const emptyUnfilteredView = !state.providerError && state.providerState === "empty"
          && state.envelope && state.envelope.state === "empty"
          && !["appId", "sourceId", "q", "sq", "id"].some(key => state.query.has(key));
        const help = node("section", { className: "setup-assistance" });
        wrapper.append(help);
        assistanceCleanup = global.SocSetupAssistance.render({ container: help, controlsContainer: wrapper.querySelector("#page-title"),
          mode: screenNeedsHelp ? "screen" : "checklist", offerChecklist: Boolean(emptyUnfilteredView), route: page.path, query: state.query }) || null;
      }

      if (page.localOnly && page.variant === "technical-documentation") {
        wrapper.append(renderTechnicalDocumentation());
        root.replaceChildren(wrapper);
        applyPageFilter();
        return;
      }

      if (page.localOnly && page.variant === "document-library") {
        const container = node("section", { className: "document-library" });
        wrapper.append(container);
        root.replaceChildren(wrapper);
        if (global.SOC_PRIVATE_APPLICATION && global.SocDocumentLibrary) {
          privateViewCleanup = global.SocDocumentLibrary.render({ container, apiBase: "/api/v1/documents", onError: showToast }) || null;
          privateViewRoute = routeKey;
        } else {
          container.append(node("section", { className: "panel empty-state" }, [
            node("h2", { text: "Document storage is not connected" }),
            node("p", { text: "Start the private application and sign in to upload, version, download, and track your own documents. No documents are included in the skeleton." })
          ]));
        }
        return;
      }

      if (page.path === "/sources" && ["setup", "mapping", "operations", "integrations", "live", "vendors", "observations"].includes(tabState.values.stab)) {
        wrapper.append(routeTabs(page, tabState));
        const container = node("section", { className: "administration-workspace", attrs: { id: "active-page-panels", role: "tabpanel", "aria-labelledby": "page-title" } });
        wrapper.append(container);
        root.replaceChildren(wrapper);
        const integrationView = tabState.values.stab === "setup" ? global.SocSetupGuides : tabState.values.stab === "mapping" ? global.SocSourceMapping : tabState.values.stab === "operations" ? global.SocSetupAssistance : tabState.values.stab === "live" ? global.SocLiveMonitoring : tabState.values.stab === "vendors" ? global.SocVendorImport : global.SocIntegrationCenter;
        if (integrationView && (global.SOC_PRIVATE_APPLICATION || ["setup", "mapping", "operations", "live"].includes(tabState.values.stab))) {
          privateViewCleanup = integrationView.render({ container, mode: tabState.values.stab, query: state.query, sourceId: state.query.get("sourceId") || "", onError: showToast,
            onSelection(id) {
              if (!state.mounted || state.route !== "/sources" || state.query.get("stab") !== "setup" || !global.history?.replaceState) return;
              if (id !== null && (typeof id !== "string" || !/^setup-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))) return;
              if (id) state.query.set("setupId", id); else state.query.delete("setupId");
              const selectedRoute = routeHash(state.route, queryObject(state.query));
              global.history.replaceState(null, "", selectedRoute);
              privateViewRoute = selectedRoute;
            }
          }) || null;
          privateViewRoute = routeKey;
        } else {
          container.append(node("section", { className: "panel empty-state" }, [
            node("h2", { text: "Integration services are not connected" }),
            node("p", { text: "Start the private application and sign in to register your own integration definitions, inspect source-to-screen coverage, and browse received canonical observations. No records are included in the static shell." })
          ]));
        }
        return;
      }

      if (page.path === "/agents" && tabState.values.atab === "access") {
        wrapper.append(routeTabs(page, tabState));
        const container = node("section", { className: "administration-workspace", attrs: { id: "active-page-panels", role: "tabpanel", "aria-labelledby": "page-title" } });
        wrapper.append(container);
        root.replaceChildren(wrapper);
        if (global.SOC_PRIVATE_APPLICATION && global.SocServiceAccess) {
          privateViewCleanup = global.SocServiceAccess.render({ container, onError: showToast }) || null;
          privateViewRoute = routeKey;
        } else {
          container.append(node("section", { className: "panel empty-state" }, [
            node("h2", { text: "Private agent access is not connected" }),
            node("p", { text: "Start the private application and sign in to issue scoped, expiring service credentials. Agent registrations and prompts do not grant API access." })
          ]));
        }
        return;
      }

      if (provider && state.providerState === "loading") {
        wrapper.append(node("section", { className: "notice", attrs: { "data-tone": "info", role: "status" } }, [
          node("span", { className: "state-spinner", attrs: { "aria-hidden": "true" } }),
          node("span", { text: "Reading the application adapter…" })
        ]));
      } else if (state.providerError) {
        wrapper.append(node("section", { className: "notice", attrs: { "data-tone": "bad", role: "alert" } }, [
          node("strong", { text: "Adapter unavailable" }),
          node("span", { text: "The page structure remains available, but authorized data could not be read." })
        ]));
      }

      if (commands && state.controlState === "loading" && ["/sources", "/onboard", "/scans"].includes(state.route)) {
        wrapper.append(node("section", { className: "notice", attrs: { "data-tone": "info", role: "status" } }, [
          node("span", { className: "state-spinner", attrs: { "aria-hidden": "true" } }),
          node("span", { text: "Reading the connector registry…" })
        ]));
      } else if (state.controlError && ["/sources", "/onboard", "/scans"].includes(state.route)) {
        wrapper.append(node("section", { className: "notice", attrs: { "data-tone": "bad", role: "alert" } }, [
          node("strong", { text: "Connector registry unavailable" }),
          node("span", { text: "Connector status and source-management controls remain unavailable until the command provider recovers." })
        ]));
      }

      const commandResult = commandResultPanel();
      if (commandResult) wrapper.append(commandResult);

      const isAdministrationPage = page.variant && page.variant.startsWith("administration-");
      if (isAdministrationPage) {
        wrapper.append(administrationNotice());
        const result = administrationResultPanel();
        if (result) wrapper.append(result);
      }

      if (state.envelope) wrapper.append(adapterContext());

      const catalogPanels = collectPanels(page, tabState, state.query);
      const suppliedPanels = new Map(state.envelope ? state.envelope.panels.map((panel) => [panel.id, panel]) : []);
      const hydratedPanelIds = new Set();
      const takeSupplied = (panel) => {
        const supplied = suppliedPanels.get(panel.id);
        if (!supplied || hydratedPanelIds.has(panel.id)) return null;
        hydratedPanelIds.add(panel.id);
        return supplied;
      };
      const renderPanelSlot = (panel, index) => {
        const supplied = takeSupplied(panel);
        if (supplied) return renderAdapterPanel(supplied, panel);
        return renderCatalogPanel(panel, index);
      };
      const invalidTabs = () => tabState.tabsets.some((entry) => entry.invalid)
        ? node("section", { className: "notice", attrs: { "data-tone": "warn" } }, [
          node("strong", { text: "Unknown view" }), node("span", { text: "The requested tab was not recognized; the default view is shown." })
        ]) : documentRef.createDocumentFragment();

      if (!isAdministrationPage && suppliedPanels.has("imported-observation-scope") && suppliedPanels.has("imported-observations")) {
        // Keep navigation, but do not advertise native workflow counters,
        // filters, or actions that an imported fact list cannot implement.
        wrapper.append(renderTabs(page, tabState), invalidTabs());
        const observations = node("div", { className: "tab-panel", attrs: { id: "active-page-panels", role: "tabpanel", "aria-labelledby": "page-title" } });
        for (const panel of state.envelope.panels) observations.append(renderAdapterPanel(panel));
        observations.append(node("p", { className: "muted" }, [
          node("a", { text: "Filter all received observations", attrs: { href: "#/sources?stab=observations" } }),
          documentRef.createTextNode(" · "), node("a", { text: "Connect a canonical source", attrs: { href: "#/sources?stab=add&connectorType=canonical-events" } })
        ]));
        wrapper.append(observations);
        root.replaceChildren(wrapper);
        applyPageFilter();
        return;
      }

      if (isAdministrationPage) {
        wrapper.append(routeTabs(page, tabState), invalidTabs());
        const managed = administrationView(page, tabState);
        if (managed) wrapper.append(node("div", { className: "tab-panel administration-workspace", attrs: {
          id: "active-page-panels", role: "tabpanel", tabindex: "0", "aria-labelledby": "page-title"
        } }, managed));
        root.replaceChildren(wrapper);
        applyPageFilter();
        return;
      }

      if (page.variant === "tuning" && tuningMode !== "registry") {
        wrapper.append(tuningBranch(tuningMode, catalogPanels, takeSupplied));
      } else if (page.variant === "rules" && state.query.get("ruleView")) {
        wrapper.append(rulesDetailBranch(page, tabState, catalogPanels, takeSupplied));
      } else if (page.variant === "tuning" || embeddedTuning) {
        if (page.variant === "tuning") wrapper.append(tuningPrelude());
        if (embeddedTuning) {
          const rtab = tabState.tabsets.find(({ tabset }) => tabset.param === "rtab");
          if (rtab) wrapper.append(node("section", { className: "panel route-view-tabs" }, renderTabset(page, rtab)));
        }
        wrapper.append(renderTuningRegistry(page, tabState, catalogPanels, renderPanelSlot, takeSupplied));
        wrapper.append(invalidTabs(), tuningFooter(catalogPanels, takeSupplied));
      } else {
        let remainingCatalogPanels = catalogPanels;
        if (page.variant === "overview") {
          const metricIndex = catalogPanels.findIndex((panel) => panel.type === "metrics");
          const metricPanel = metricIndex >= 0 ? catalogPanels[metricIndex] : null;
          wrapper.append(overviewPrelude(metricPanel ? renderPanelSlot(metricPanel, metricIndex) : null));
          remainingCatalogPanels = catalogPanels.filter((panel, index) => index !== metricIndex);
        }
        const beforeTabIds = new Set(page.panelsBeforeTabs || []);
        if (beforeTabIds.size) {
          remainingCatalogPanels.filter((panel) => beforeTabIds.has(panel.id)).forEach((panel) => {
            wrapper.append(renderPanelSlot(panel, catalogPanels.indexOf(panel)));
          });
          remainingCatalogPanels = remainingCatalogPanels.filter((panel) => !beforeTabIds.has(panel.id));
        }
        if (page.variant === "logs") wrapper.append(logsPrelude());
        wrapper.append(routeTabs(page, tabState));
        if (page.path === "/scans") {
          const profile = scanProfilesByTab.get(tabState.values.tab || "trivy");
          if (profile) wrapper.append(scanConnectionPrelude(profile));
        }
        if (page.path === "/sources" && (tabState.values.stab || "expected") === "add") {
          const guidance = scanSetupGuidance();
          if (guidance) wrapper.append(guidance);
        }
        if (page.path === "/access" && state.query.get("atab") === "offboarding" && state.query.get("id")) {
          wrapper.append(detailBackLink("/access", "Back to Offboarding", { atab: "offboarding" }));
        }
        wrapper.append(invalidTabs());
        const panelRegion = node("div", { className: "tab-panel", attrs: { id: "active-page-panels", role: "tabpanel", tabindex: "0", "aria-labelledby": "page-title", "aria-live": "polite" } });
        const sourceBrowse = page.variant === "intel" && ["threatfox", "urlhaus", "malwarebazaar"].includes(tabState.values.itab);
        remainingCatalogPanels.forEach((panel, index) => {
          if (sourceBrowse && panel.type === "form" && panel.title.startsWith("Search ")) return;
          if (sourceBrowse && panel.type === "table" && panel.title.endsWith(" indicators")) {
            const supplied = takeSupplied(panel);
            panelRegion.append(supplied && supplied.type !== "table"
              ? renderAdapterPanel(supplied, panel)
              : intelSourceBrowse(page, tabState, panel, supplied));
            return;
          }
          if (page.variant === "triage" && panel.title === "Alerts") panelRegion.append(...triageBulkUi());
          panelRegion.append(renderPanelSlot(panel, index));
          if (page.variant === "triage" && panel.title === "Alerts") panelRegion.append(triageEditorDialog());
        });
        if (page.path === "/access" && (tabState.values.atab || "who") === "who") panelRegion.append(authPanel());
        wrapper.append(panelRegion);
      }

      if (state.envelope) {
        const unmatchedPanels = state.envelope.panels.filter((panel) => !hydratedPanelIds.has(panel.id));
        if (unmatchedPanels.length) {
        const authorized = node("section", { className: "authorized-data", attrs: { "aria-labelledby": "authorized-data-title" } }, [
          node("header", { className: "authorized-heading" }, [
            node("div", {}, [
              node("p", { className: "eyebrow", text: "Application adapter" }),
              node("h2", { text: "Additional authorized data", attrs: { id: "authorized-data-title" } })
            ]),
            node("span", { className: "pill", text: state.envelope.state, attrs: { "data-tone": state.envelope.state === "error" ? "bad" : "neutral" } })
          ])
        ]);
        unmatchedPanels.forEach((panel) => authorized.append(renderAdapterPanel(panel)));
        wrapper.append(authorized);
        }
      }

      root.replaceChildren(wrapper);
      if (page.path === "/scans" && (tabState.values.tab || "trivy") === "trivy"
          && global.SOC_PRIVATE_APPLICATION && global.SocScannerImport) {
        const container = node("section", { className: "scanner-import" });
        wrapper.append(container);
        privateViewCleanup = global.SocScannerImport.render({
          container, sources: state.controlSnapshot ? state.controlSnapshot.sources : [], query: state.query, onError: showToast,
          onImported: () => refresh("manual")
        }) || null;
        privateViewRoute = routeKey;
      }
      applyPageFilter();
    }

    async function loadSession() {
      state.authError = false;
      if (!auth) {
        state.authState = "absent";
        state.session = Object.freeze({ authenticated: false });
        return;
      }
      state.authState = "loading";
      updateShellState();
      try {
        state.session = await auth.getSession();
        state.authState = state.session.authenticated ? "authenticated" : "anonymous";
      } catch (error) {
        state.authState = "error";
        state.authError = true;
        state.session = Object.freeze({ authenticated: false });
        if (global.console && typeof global.console.error === "function") global.console.error("Authentication adapter failed.");
      }
    }

    async function loadControlSnapshot(reason) {
      const requestSerial = state.requestSerial;
      if (!commands || !["/sources", "/onboard", "/scans"].includes(state.route)) {
        state.controlState = commands ? "idle" : "absent";
        state.controlError = false;
        state.controlSnapshot = null;
        return;
      }
      state.controlState = "loading";
      state.controlError = false;
      try {
        const request = {
          schemaVersion: VERSION,
          reason: reason === "initial" ? "initial" : reason === "command" ? "command" : "refresh"
        };
        if (state.controlSnapshot) request.knownRevision = state.controlSnapshot.revision;
        const snapshot = connectorRuntime.validateControlSnapshot(await commands.getSnapshot(request));
        if (!state.mounted || requestSerial !== state.requestSerial) return;
        state.controlSnapshot = snapshot;
        state.controlState = "ready";
      } catch (error) {
        if (!state.mounted || requestSerial !== state.requestSerial) return;
        state.controlSnapshot = null;
        state.controlState = "error";
        state.controlError = true;
        if (global.console && typeof global.console.error === "function") global.console.error("Connector command provider failed.");
      }
    }

    function administrationDomainForPage(page) {
      if (!page || !page.variant || !page.variant.startsWith("administration-")) return null;
      return page.variant === "administration-agents" ? "agents" : "governance";
    }

    async function loadAdministrationSnapshot(page, reason) {
      const serial = state.requestSerial;
      const domain = administrationDomainForPage(page);
      state.administrationPrompt = null;
      if (!domain || !administration) {
        state.administrationState = administration ? "idle" : "absent";
        state.administrationError = false;
        state.administrationSnapshot = null;
        return;
      }
      if (!state.session.authenticated) {
        state.administrationState = "gated";
        state.administrationError = false;
        state.administrationSnapshot = null;
        return;
      }
      state.administrationState = "loading";
      state.administrationError = false;
      try {
        const request = {
          schemaVersion: VERSION,
          documentType: "administration-snapshot-request",
          domain,
          reason: reason === "initial" ? "initial" : reason === "command" ? "command" : "refresh"
        };
        if (state.administrationSnapshot && state.administrationSnapshot.domain === domain) {
          request.knownRevision = state.administrationSnapshot.revision;
        }
        const snapshot = await administration.getSnapshot(request);
        if (!state.mounted || serial !== state.requestSerial) return;
        state.administrationSnapshot = snapshot;
        if (domain === "agents" && state.query.get("prompt")) {
          const prompt = await administration.getPrompt({
            schemaVersion: VERSION,
            documentType: "agent-prompt-request",
            promptId: state.query.get("prompt")
          });
          if (!state.mounted || serial !== state.requestSerial) return;
          state.administrationPrompt = prompt;
        }
        state.administrationState = "ready";
      } catch (error) {
        if (!state.mounted || serial !== state.requestSerial) return;
        state.administrationSnapshot = null;
        state.administrationPrompt = null;
        state.administrationState = "error";
        state.administrationError = true;
        if (global.console && typeof global.console.error === "function") global.console.error("Administration provider failed.");
      }
    }

    function restoreRouteFocus(reason, routeChanged, previousTabLabel) {
      if (state.route === "/docs" && ["initial", "navigation"].includes(reason)) {
        const section = String(state.query.get("section") || "");
        const heading = section && root.querySelector("#docs-" + section);
        if (heading && typeof heading.focus === "function") {
          heading.focus({ preventScroll: false });
          return;
        }
      }
      if (reason !== "navigation") return;
      if (!routeChanged) {
        const selectedTabs = Array.from(root.querySelectorAll('[role="tab"][aria-selected="true"]'));
        const selectedTab = selectedTabs.find((tab) => tab.textContent === previousTabLabel)
          || selectedTabs[selectedTabs.length - 1];
        if (selectedTab && typeof selectedTab.focus === "function") {
          selectedTab.focus({ preventScroll: true });
          return;
        }
      }
      if (typeof root.focus === "function") root.focus({ preventScroll: true });
    }

    function finishRouteRender(reason, routeChanged, previousTabLabel) {
      renderPage();
      restoreRouteFocus(reason, routeChanged, previousTabLabel);
    }

    async function renderRoute(reason) {
      const focusedElement = documentRef.activeElement;
      const previousTabLabel = focusedElement && focusedElement.getAttribute && focusedElement.getAttribute("role") === "tab"
        ? focusedElement.textContent : "";
      const location = parseLocation(config.routing.defaultRoute);
      const routeChanged = location.path !== state.route;
      state.route = location.path;
      state.query = location.query;
      const serial = ++state.requestSerial;
      state.envelope = null;
      state.providerError = false;
      if (reason === "refresh" && state.administrationResult
          && state.administrationResult.output && state.administrationResult.output.oneTimeCredential) {
        state.administrationResult = null;
      }
      if (routeChanged) {
        state.commandResult = null;
        state.administrationResult = null;
      }
      if (hooks.pageFilter) hooks.pageFilter.value = pageFilters.get(state.route) || "";
      const page = pageByPath.get(state.route);
      if (!page) {
        finishRouteRender(reason, routeChanged, previousTabLabel);
        return;
      }
      if (config.auth && config.auth.required && !state.session.authenticated) {
        state.providerState = provider ? "gated" : "absent";
        finishRouteRender(reason, routeChanged, previousTabLabel);
        return;
      }
      if (administrationDomainForPage(page)) {
        state.providerState = provider ? "idle" : "absent";
        state.controlState = commands ? "idle" : "absent";
        state.controlError = false;
        state.controlSnapshot = null;
        await loadAdministrationSnapshot(page, reason);
        if (!state.mounted || serial !== state.requestSerial) return;
        finishRouteRender(reason, routeChanged, previousTabLabel);
        return;
      }
      if (page.localOnly || (page.path === "/sources" && ["setup", "mapping", "operations", "integrations", "live", "vendors", "observations"].includes(state.query.get("stab")))) {
        state.providerState = provider ? "idle" : "absent";
        state.controlState = commands ? "idle" : "absent";
        state.controlError = false;
        state.controlSnapshot = null;
        state.administrationState = administration ? "idle" : "absent";
        state.administrationSnapshot = null;
        state.administrationPrompt = null;
        finishRouteRender(reason, routeChanged, previousTabLabel);
        return;
      }
      await loadControlSnapshot(reason);
      if (!state.mounted || serial !== state.requestSerial) return;
      if (!provider) {
        state.providerState = "absent";
        finishRouteRender(reason, routeChanged, previousTabLabel);
        return;
      }
      state.providerState = "loading";
      renderPage();
      restoreRouteFocus(reason, routeChanged, previousTabLabel);
      try {
        const request = adapterRuntime.validateRequest({
          schemaVersion: VERSION,
          route: state.route,
          query: providerQuery(state.route, state.query),
          reason
        });
        const envelope = adapterRuntime.validateEnvelope(await provider.readPage(request), request.route);
        if (!state.mounted || serial !== state.requestSerial) return;
        state.envelope = envelope;
        state.providerState = envelope.state;
      } catch (error) {
        if (!state.mounted || serial !== state.requestSerial) return;
        state.providerState = "error";
        state.providerError = true;
        if (global.console && typeof global.console.error === "function") global.console.error("Data adapter failed.");
      }
      finishRouteRender(reason, routeChanged, previousTabLabel);
    }

    function applyPageFilter(event) {
      const localFilter = state.route === "/docs" ? root.querySelector("[data-documentation-filter]") : null;
      const eventTarget = event && event.target;
      const value = eventTarget === localFilter
        ? String(localFilter.value || "")
        : hooks.pageFilter
          ? String(hooks.pageFilter.value || "")
          : localFilter
            ? String(localFilter.value || "")
            : "";
      if (eventTarget === localFilter && hooks.pageFilter) hooks.pageFilter.value = value;
      if (eventTarget === hooks.pageFilter && localFilter) localFilter.value = value;
      const query = value.trim().toLocaleLowerCase();
      pageFilters.set(state.route, value);
      const candidates = Array.from(root.querySelectorAll("[data-filterable]"));
      let visible = 0;
      candidates.forEach((element) => {
        const match = !query || element.textContent.toLocaleLowerCase().includes(query);
        element.hidden = !match;
        if (match) visible += 1;
      });
      if (hooks.pageFilterStatus) {
        hooks.pageFilterStatus.hidden = !query;
        hooks.pageFilterStatus.textContent = query
          ? visible + " of " + candidates.length + (state.route === "/docs" ? " chapters shown" : " interface items shown")
          : "";
      }
      const noResults = root.querySelector(".technical-documentation-no-results");
      if (noResults) noResults.hidden = !(query && visible === 0);
    }

    function renderCommandResults() {
      if (!hooks.commandResults) return;
      const rawQuery = hooks.commandInput ? hooks.commandInput.value.trim().slice(0, 240) : "";
      const query = rawQuery.toLocaleLowerCase();
      const matches = pages.filter((page) => !query
        || [page.group, page.label, page.displayTitle || "", page.path, page.searchTerms || ""]
          .join(" ").toLocaleLowerCase().includes(query));
      const searchAction = rawQuery ? node("a", {
        className: "command-result command-search-anything",
        attrs: { href: routeHash("/search", { q: rawQuery }), role: "option" }
      }, [node("span", { text: `Investigate “${rawQuery}”` }), node("small", { text: "IP · CVE · case · hostname · rule · log query" })]) : null;
      hooks.commandResults.replaceChildren(searchAction, ...matches.map((page) => node("a", {
        className: "command-result",
        attrs: { href: routeHash(page.path), role: "option" }
      }, [node("span", { text: page.label }), node("small", { text: `${page.group} · ${page.path}` })])));
      if (!matches.length && !searchAction) hooks.commandResults.append(node("p", { className: "command-empty", text: "Type an indicator, host, rule, case, or page." }));
    }

    function openCommand() {
      if (!hooks.commandDialog) return;
      if (hooks.commandInput) hooks.commandInput.value = "";
      renderCommandResults();
      if (typeof hooks.commandDialog.showModal === "function") hooks.commandDialog.showModal();
      else hooks.commandDialog.setAttribute("open", "");
      if (hooks.commandInput) {
        hooks.commandInput.focus();
      }
    }

    function closeCommand() {
      if (!hooks.commandDialog) return;
      if (typeof hooks.commandDialog.close === "function" && hooks.commandDialog.open) hooks.commandDialog.close();
      else hooks.commandDialog.removeAttribute("open");
    }

    function clearGoShortcut() {
      goShortcutPending = false;
      if (goShortcutTimer !== null) global.clearTimeout(goShortcutTimer);
      goShortcutTimer = null;
    }

    function onCommandInputKeydown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeCommand();
        return;
      }
      if (event.key !== "Enter") return;
      const query = String(hooks.commandInput && hooks.commandInput.value || "").trim().slice(0, 240);
      if (!query) return;
      event.preventDefault();
      closeCommand();
      navigate("/search", { q: query });
    }

    async function performAuth(action) {
      if (!auth) {
        showToast("No authentication adapter is connected.");
        return;
      }
      try {
        const returnTo = routeHash(state.route, queryObject(state.query));
        if (action === "logout") await auth.logout({ returnTo: "#/" });
        else await auth.login({ returnTo });
        if (!state.mounted) return;
        await loadSession();
        if (!state.mounted) return;
        await renderRoute("refresh");
      } catch (error) {
        showToast("Authentication could not be completed.");
        if (global.console && typeof global.console.error === "function") global.console.error("Authentication action failed.");
      }
    }

    function commandValues(form) {
      const values = {};
      if (!form) return values;
      Array.from(form.querySelectorAll("[name]")).forEach((control) => {
        if (!control.name || control.disabled) return;
        if (control.type === "checkbox") values[control.name] = Boolean(control.checked);
        else values[control.name] = String(control.value || "").trim();
      });
      return values;
    }

    function commaList(value, maximum) {
      return String(value || "").split(",").map((item) => item.trim()).filter(Boolean).slice(0, maximum);
    }

    function commandInput(action, values, trigger) {
      if (action === "app.register") {
        return {
          displayName: values.appName,
          hosts: commaList(values.hosts, 12),
          environments: commaList(values.environments, 32).length ? commaList(values.environments, 32) : ["default"],
          publicPages: commaList(values.publicPages, 6)
        };
      }
      if (action === "host.enroll") {
        return {
          appId: values.appId || trigger && trigger.dataset.appId,
          hostId: values.hostId || trigger && trigger.dataset.hostId
        };
      }
      if (action === "source.setup") {
        const selectedKind = String(values.sourceKind || "");
        const separator = selectedKind.indexOf(":");
        const kindConnector = separator > 0 ? selectedKind.slice(0, separator) : "";
        const sourceKind = separator > 0 ? selectedKind.slice(separator + 1) : selectedKind;
        if (kindConnector && values.connectorType && kindConnector !== values.connectorType) {
          throw new TypeError("The selected source kind does not belong to the selected connector type.");
        }
        const connectorType = kindConnector || values.connectorType;
        const manifest = state.controlSnapshot && state.controlSnapshot.connectorTypes.find((item) => item.connectorType === connectorType);
        const config = {};
        if (manifest) {
          manifest.configFields.forEach((field) => {
            const raw = values[`config::${connectorType}::${field.key}`];
            if (raw === undefined || raw === "") return;
            if (field.valueType === "boolean") config[field.key] = Boolean(raw);
            else if (["integer", "duration-seconds"].includes(field.valueType)) config[field.key] = Number.parseInt(raw, 10);
            else if (field.valueType === "number") config[field.key] = Number(raw);
            else config[field.key] = raw;
          });
        }
        if (values.cadenceHours !== "" && manifest && manifest.configFields.some((field) => field.key === "cadence-seconds")
            && config["cadence-seconds"] === undefined) {
          config["cadence-seconds"] = Math.round(Number(values.cadenceHours) * 3600);
        }
        const credentialReferences = [];
        if (manifest) manifest.credentialSlots.forEach((slot) => {
          const referenceId = values[`credential-ref::${connectorType}::${slot.key}`];
          if (!referenceId) return;
          credentialReferences.push({
            slot: slot.key,
            store: values[`credential-store::${connectorType}::${slot.key}`] || "secret-manager",
            referenceId
          });
        });
        return {
          appId: values.appId,
          environment: values.environment ? values.environment.slice(values.environment.indexOf(":") + 1) : undefined,
          hostId: values.hostId || undefined,
          connectorType,
          sourceKind,
          displayName: values.displayName,
          config,
          credentialReferences
        };
      }
      if (action.startsWith("source.") && connectorRuntime.COMMANDS.includes(action)) {
        const input = {
          sourceId: trigger && trigger.dataset.sourceId,
          connectorInstanceId: trigger && trigger.dataset.connectorInstanceId,
          expectedRevision: Number(trigger && trigger.dataset.expectedRevision)
        };
        if (action === "source.test" && values.sampleMessage) input.sample = { message: values.sampleMessage };
        if (action === "source.test" && values.recordSample) {
          if (new TextEncoder().encode(values.recordSample).length > 60 * 1024) throw new TypeError("Use a smaller redacted validation sample (at most 60 KiB). Live batches have their own separate limits.");
          try { input.recordSample = JSON.parse(values.recordSample); }
          catch { throw new TypeError("The record sample must be valid JSON. No data was submitted."); }
        }
        if (action === "source.update") {
          const source = state.controlSnapshot.sources.find((item) => item.sourceId === input.sourceId);
          input.displayName = values.displayName;
          input.config = { ...source.config, "cadence-seconds": Number(values.cadenceSeconds) };
        }
        return input;
      }
      throw new TypeError("That connector action is not supported by this interface version.");
    }

    function nextCommandRequestId() {
      commandSequence += 1;
      return `ui-${Date.now().toString(36)}-${commandSequence.toString(36)}`;
    }

    async function performCommand(action, form, trigger) {
      if (!commands || state.commandPending) return;
      if (["source.remove", "source.archive", "source.revoke", "source.rotate"].includes(action)
          && typeof global.confirm === "function" && !global.confirm(`Confirm ${action.slice(7)} for this source? Existing sender access may stop immediately.`)) return;
      let request;
      try {
        request = {
          schemaVersion: VERSION,
          documentType: "connector-command-request",
          requestId: nextCommandRequestId(),
          command: action,
          requestedAt: new Date().toISOString(),
          input: commandInput(action, commandValues(form), trigger)
        };
      } catch (error) {
        showToast(error instanceof TypeError && typeof error.message === "string"
          ? error.message.slice(0, 240) : "The connector action could not be prepared.");
        return;
      }
      state.commandPending = true;
      renderPage();
      try {
        state.commandResult = await commands.execute(request);
      } catch (error) {
        state.commandResult = {
          schemaVersion: VERSION,
          documentType: "connector-command-result",
          requestId: request.requestId,
          command: action,
          status: "failed",
          completedAt: new Date().toISOString(),
          error: { code: "provider-unavailable", message: "The connector command provider is unavailable.", retryable: true }
        };
      }
      state.commandPending = false;
      if (!state.mounted) return;
      await renderRoute("refresh");
    }

    function optionalAdministrationText(value) {
      const normalized = String(value === undefined || value === null ? "" : value).trim();
      return normalized || undefined;
    }

    function administrationDateTime(value, clearWhenBlank) {
      const normalized = optionalAdministrationText(value);
      if (!normalized) return clearWhenBlank ? null : undefined;
      const parsed = new Date(normalized);
      if (Number.isNaN(parsed.valueOf())) throw new TypeError("Date and time values must be valid.");
      return parsed.toISOString();
    }

    function administrationInput(action, values, trigger) {
      const dataset = trigger && trigger.dataset ? trigger.dataset : {};
      const text = (name) => optionalAdministrationText(values[name]);
      const lifecycleId = (name) => text(name) || optionalAdministrationText(dataset[name]);
      if (action === "agent.create" || action === "agent.update") {
        const input = {
          displayName: text("displayName"),
          kind: text("kind"),
          capabilities: commaList(values.capabilities, 64).map((entry) => entry.toLocaleLowerCase())
        };
        if (action === "agent.update") input.agentId = lifecycleId("agentId");
        const description = text("description");
        const providerType = text("provider");
        const model = text("model");
        if (description !== undefined) input.description = description;
        if (providerType !== undefined) input.provider = providerType.toLocaleLowerCase();
        if (model !== undefined) input.model = model;
        return input;
      }
      if (["agent.pause", "agent.resume", "agent.archive", "agent.restore", "agent.remove"].includes(action)) {
        return { agentId: lifecycleId("agentId") };
      }
      if (action === "prompt.revise") {
        const input = { agentId: text("agentId"), title: text("title"), body: text("body") };
        const basePromptId = text("basePromptId");
        if (basePromptId !== undefined) input.basePromptId = basePromptId;
        return input;
      }
      if (["prompt.activate", "prompt.archive"].includes(action)) {
        return { promptId: lifecycleId("promptId") };
      }
      if (action === "enrollment.issue") {
        return { agentId: text("agentId"), expiresInSeconds: Number.parseInt(values.expiresInSeconds, 10) };
      }
      if (action === "enrollment.revoke") return { enrollmentId: lifecycleId("enrollmentId") };
      if (action === "attestation.create" || action === "attestation.update") {
        const input = { title: text("title") };
        if (action === "attestation.update") input.attestationId = lifecycleId("attestationId");
        const description = text("description");
        const owner = text("owner");
        if (description !== undefined) input.description = description;
        if (owner !== undefined) input.owner = owner;
        const dueAt = administrationDateTime(values.dueAt, action === "attestation.update");
        if (dueAt !== undefined) input.dueAt = dueAt;
        return input;
      }
      if (action === "attestation.transition") {
        const input = { attestationId: lifecycleId("attestationId"), status: text("status") };
        const note = text("note");
        if (note !== undefined) input.note = note;
        return input;
      }
      if (["attestation.archive", "attestation.restore", "attestation.remove"].includes(action)) {
        return { attestationId: lifecycleId("attestationId") };
      }
      if (action === "risk.create" || action === "risk.update") {
        const input = {
          title: text("title"),
          likelihood: text("likelihood"),
          impact: text("impact")
        };
        if (action === "risk.update") input.riskId = lifecycleId("riskId");
        const description = text("description");
        const owner = text("owner");
        if (description !== undefined) input.description = description;
        if (owner !== undefined) input.owner = owner;
        const reviewAt = administrationDateTime(values.reviewAt, action === "risk.update");
        if (reviewAt !== undefined) input.reviewAt = reviewAt;
        return input;
      }
      if (action === "risk.transition") {
        const input = { riskId: lifecycleId("riskId"), status: text("status") };
        const note = text("note");
        if (note !== undefined) input.note = note;
        return input;
      }
      if (["risk.archive", "risk.restore", "risk.remove"].includes(action)) {
        return { riskId: lifecycleId("riskId") };
      }
      throw new TypeError("That administration action is not supported by this interface version.");
    }

    async function performAdministrationCommand(action, form, trigger) {
      if (!administrationReady() || state.administrationPending) return;
      if (action.endsWith(".remove") && typeof global.confirm === "function"
          && !global.confirm("Permanently remove this archived record? The server will retain an audit tombstone, but the managed record cannot be restored.")) {
        return;
      }
      const values = commandValues(form);
      if (form) state.administrationDraft = { action, values };
      let request;
      try {
        request = administrationRuntime.validateCommandRequest({
          schemaVersion: VERSION,
          documentType: "administration-command-request",
          requestId: `admin-${nextCommandRequestId()}`,
          command: action,
          requestedAt: new Date().toISOString(),
          expectedRevision: state.administrationSnapshot.revision,
          input: administrationInput(action, values, trigger)
        });
      } catch (error) {
        showToast(error && error.message ? error.message : "The administration action could not be prepared.");
        return;
      }
      state.administrationPending = true;
      renderPage();
      try {
        state.administrationResult = await administration.execute(request);
        if (state.administrationResult.status === "succeeded") state.administrationDraft = null;
      } catch (error) {
        state.administrationResult = {
          schemaVersion: VERSION,
          documentType: "administration-command-result",
          requestId: request.requestId,
          command: action,
          status: "failed",
          completedAt: new Date().toISOString(),
          error: { code: "provider-unavailable", message: "The administration provider is unavailable.", retryable: true }
        };
      }
      state.administrationPending = false;
      if (!state.mounted) return;
      await renderRoute("command");
    }

    function onRootClick(event) {
      const dismissAdministration = event.target.closest("[data-administration-dismiss]");
      if (dismissAdministration) {
        event.preventDefault();
        state.administrationResult = null;
        renderPage();
        return;
      }
      const administrationActionTrigger = event.target.closest("[data-administration-action]");
      if (administrationActionTrigger && !administrationActionTrigger.closest("[data-administration-form]")) {
        event.preventDefault();
        performAdministrationCommand(administrationActionTrigger.dataset.administrationAction, null, administrationActionTrigger);
        return;
      }
      const dismissCommand = event.target.closest("[data-command-dismiss]");
      if (dismissCommand) {
        event.preventDefault();
        state.commandResult = null;
        renderPage();
        return;
      }
      const commandAction = event.target.closest("[data-command-action]");
      if (commandAction && !commandAction.closest("[data-command-form]")) {
        event.preventDefault();
        performCommand(commandAction.dataset.commandAction, null, commandAction);
        return;
      }
      const sourceToggle = event.target.closest(".srctoggle");
      if (sourceToggle) {
        event.preventDefault();
        const detail = root.querySelector(`#${sourceToggle.getAttribute("aria-controls")}`);
        if (!detail) return;
        const open = sourceToggle.getAttribute("aria-expanded") === "true";
        detail.setAttribute("style", open ? "display:none" : "display:table-row");
        sourceToggle.setAttribute("aria-expanded", open ? "false" : "true");
        sourceToggle.textContent = open ? "?" : "×";
        return;
      }
      const columnReset = event.target.closest(".triage-col-reset");
      if (columnReset) {
        event.preventDefault();
        triageColumnWidths = { ...triageColumnDefaults };
        applyTriageColumnWidths(root.querySelector("#triage-table"));
        return;
      }
      const createOpen = event.target.closest("[data-tune-create-open]");
      if (createOpen) {
        event.preventDefault();
        const dialog = root.querySelector("#tune-create-dialog");
        if (dialog && typeof dialog.showModal === "function") dialog.showModal();
        else if (dialog) dialog.setAttribute("open", "");
        return;
      }
      const createClose = event.target.closest("[data-tune-create-close]");
      if (createClose) {
        event.preventDefault();
        const dialog = createClose.closest("dialog");
        if (dialog && typeof dialog.close === "function") dialog.close();
        else if (dialog) dialog.removeAttribute("open");
        return;
      }
      const action = event.target.closest("[data-auth-action]");
      if (!action || action.disabled) return;
      event.preventDefault();
      performAuth(action.dataset.authAction);
    }

    function onRootPointerDown(event) {
      const handle = event.target.closest(".triage-resizer");
      if (!handle || event.button > 0) return;
      const table = handle.closest("table");
      const columnId = handle.dataset.col;
      if (!table || !columnId) return;
      event.preventDefault();
      triageResize = {
        table,
        columnId,
        startX: Number(event.clientX) || 0,
        startWidth: boundedTriageWidth(columnId, triageColumnWidths[columnId])
      };
      if (documentRef.body) documentRef.body.classList.add("triage-resizing");
      if (typeof handle.setPointerCapture === "function" && event.pointerId !== undefined) {
        try { handle.setPointerCapture(event.pointerId); } catch {}
      }
    }

    function onRootInput(event) {
      markFormDirty(event);
      if (event.target && event.target.closest && event.target.closest("[data-documentation-filter]")) {
        applyPageFilter(event);
      }
    }

    function onRootChange(event) {
      markFormDirty(event);
      const connector = event.target && event.target.closest
        ? event.target.closest('[name="connectorType"]') || event.target.closest('[name="appId"]')
        : null;
      if (connector) {
        syncSourceSetupForm(connector.closest("[data-command-form]"));
        return;
      }
      const jump = event.target && event.target.closest
        ? event.target.closest("[data-documentation-jump]")
        : null;
      if (!jump) return;
      navigate("/docs", jump.value ? { section: jump.value } : {});
    }

    function onDocumentPointerMove(event) {
      if (!triageResize) return;
      triageColumnWidths[triageResize.columnId] = boundedTriageWidth(
        triageResize.columnId,
        triageResize.startWidth + (Number(event.clientX) || 0) - triageResize.startX
      );
      applyTriageColumnWidths(triageResize.table);
    }

    function onDocumentPointerUp() {
      if (!triageResize) return;
      triageResize = null;
      if (documentRef.body) documentRef.body.classList.remove("triage-resizing");
    }

    function onRootDoubleClick(event) {
      const handle = event.target.closest(".triage-resizer");
      if (!handle || !handle.dataset.col) return;
      event.preventDefault();
      triageColumnWidths[handle.dataset.col] = triageColumnDefaults[handle.dataset.col];
      applyTriageColumnWidths(handle.closest("table"));
    }

    function onRootSubmit(event) {
      const administrationFormElement = event.target.closest("[data-administration-form]");
      if (administrationFormElement) {
        event.preventDefault();
        performAdministrationCommand(
          administrationFormElement.dataset.administrationAction,
          administrationFormElement,
          event.submitter || administrationFormElement.querySelector('[type="submit"]')
        );
        return;
      }
      const commandForm = event.target.closest("[data-command-form]");
      if (commandForm) {
        event.preventDefault();
        const submitter = event.submitter && event.submitter.dataset && event.submitter.dataset.commandAction
          ? event.submitter
          : commandForm.querySelector("[data-command-action]");
        if (submitter && submitter.dataset.commandAction) performCommand(submitter.dataset.commandAction, commandForm, submitter);
        return;
      }
      const form = event.target.closest("[data-intel-search-form]");
      if (!form) return;
      event.preventDefault();
      const input = form.querySelector('input[name="sq"]');
      const search = input ? String(input.value || "").trim().slice(0, 200) : "";
      const query = {
        itab: state.query.get("itab") || "threatfox",
        skind: state.query.get("skind") || undefined,
        sq: search || undefined
      };
      global.location.hash = routeHash("/intel", query);
    }

    function onAuthChipClick(event) {
      if (!auth || state.session.authenticated) return;
      event.preventDefault();
      performAuth("login");
    }

    function onTabKeydown(event) {
      if (event.target.matches(".triage-resizer") && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
        event.preventDefault();
        const columnId = event.target.dataset.col;
        const delta = event.key === "ArrowRight" ? 8 : -8;
        triageColumnWidths[columnId] = boundedTriageWidth(columnId, (triageColumnWidths[columnId] || triageColumnDefaults[columnId]) + delta);
        applyTriageColumnWidths(event.target.closest("table"));
        return;
      }
      if (!event.target.matches('[role="tab"]')) return;
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      const tabs = Array.from(event.target.closest('[role="tablist"]').querySelectorAll('[role="tab"]'));
      const current = tabs.indexOf(event.target);
      let next = current;
      if (event.key === "ArrowLeft") next = (current - 1 + tabs.length) % tabs.length;
      if (event.key === "ArrowRight") next = (current + 1) % tabs.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = tabs.length - 1;
      event.preventDefault();
      tabs[next].focus();
      tabs[next].click();
    }

    function onDocumentKeydown(event) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        openCommand();
        return;
      }
      const activeElement = documentRef.activeElement;
      const editing = ["INPUT", "TEXTAREA", "SELECT"].includes(activeElement && activeElement.tagName)
        || Boolean(activeElement && activeElement.isContentEditable);
      if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey
        && !editing) {
        event.preventDefault();
        clearGoShortcut();
        openCommand();
        return;
      }
      if (editing || event.metaKey || event.ctrlKey || event.altKey) return;
      const key = String(event.key || "").toLocaleLowerCase();
      if (goShortcutPending) {
        const destination = GO_SHORTCUTS[key];
        clearGoShortcut();
        if (destination) {
          event.preventDefault();
          navigate(destination);
        }
        return;
      }
      if (key === "g") {
        event.preventDefault();
        goShortcutPending = true;
        goShortcutTimer = global.setTimeout(clearGoShortcut, 1200);
        return;
      }
      if (event.key === "?") {
        event.preventDefault();
        showToast("Shortcuts: / or ⌘/Ctrl+K search · g then o/a/r/s/l/y/d/b/u/f/t/p jumps to a board · Esc closes search.");
      }
    }

    function onHashChange() {
      const previous = routeHash(state.route, queryObject(state.query));
      if (global.location.hash === previous) return;
      if (privateViewCleanup && privateViewCleanup.isDirty && privateViewCleanup.isDirty()
          && typeof global.confirm === "function" && !global.confirm("Leave this page and discard your unsaved changes, selected upload, or one-time credential?")) {
        global.location.hash = previous;
        return;
      }
      renderRoute("navigation");
    }
    function onRouteSelect() { if (hooks.routeSelect && hooks.routeSelect.value) navigate(hooks.routeSelect.value); }
    function onTimezone() {
      if (privateViewCleanup && privateViewCleanup.isDirty && privateViewCleanup.isDirty()) {
        showToast("Save or discard your pending work before changing the time display.");
        return;
      }
      state.timezone = state.timezone === "UTC" ? "Local" : "UTC";
      renderPage();
      showToast(`Times are displayed in ${state.timezone}.`);
    }
    function onCommandResultClick(event) { if (event.target.closest("a")) closeCommand(); }

    async function mount() {
      if (state.terminal) throw new Error("This application controller has been unmounted and cannot be mounted again.");
      if (state.mounted) return api;
      state.started = true;
      state.mounted = true;
      installCircuitPulses();
      renderNavigation();
      root.addEventListener("click", onRootClick);
      root.addEventListener("input", onRootInput);
      root.addEventListener("change", onRootChange);
      root.addEventListener("keydown", onTabKeydown);
      root.addEventListener("submit", onRootSubmit);
      root.addEventListener("pointerdown", onRootPointerDown);
      root.addEventListener("dblclick", onRootDoubleClick);
      global.addEventListener("hashchange", onHashChange);
      documentRef.addEventListener("keydown", onDocumentKeydown);
      documentRef.addEventListener("pointermove", onDocumentPointerMove);
      documentRef.addEventListener("pointerup", onDocumentPointerUp);
      if (hooks.routeSelect) hooks.routeSelect.addEventListener("change", onRouteSelect);
      if (hooks.pageFilter) hooks.pageFilter.addEventListener("input", applyPageFilter);
      if (hooks.refreshButton) hooks.refreshButton.addEventListener("click", refresh);
      if (hooks.timezoneToggle) hooks.timezoneToggle.addEventListener("click", onTimezone);
      if (hooks.authChip) hooks.authChip.addEventListener("click", onAuthChipClick);
      if (hooks.commandInput) hooks.commandInput.addEventListener("input", renderCommandResults);
      if (hooks.commandInput) hooks.commandInput.addEventListener("keydown", onCommandInputKeydown);
      if (hooks.commandResults) hooks.commandResults.addEventListener("click", onCommandResultClick);
      if (hooks.commandClose) hooks.commandClose.addEventListener("click", closeCommand);
      if (hooks.toastDismiss) hooks.toastDismiss.addEventListener("click", hideToast);
      await loadSession();
      if (!state.mounted) return api;
      await renderRoute("initial");
      if (state.mounted && provider) autoRefreshId = global.setInterval(() => { refresh("automatic"); }, 300000);
      return api;
    }

    function unmount() {
      if (state.terminal) return;
      state.terminal = true;
      state.mounted = false;
      state.requestSerial += 1;
      if (privateViewCleanup) { privateViewCleanup(); privateViewCleanup = null; }
      if (assistanceCleanup) { assistanceCleanup(); assistanceCleanup = null; }
      if (autoRefreshId !== null) global.clearInterval(autoRefreshId);
      autoRefreshId = null;
      clearGoShortcut();
      root.removeEventListener("click", onRootClick);
      root.removeEventListener("input", onRootInput);
      root.removeEventListener("change", onRootChange);
      root.removeEventListener("keydown", onTabKeydown);
      root.removeEventListener("submit", onRootSubmit);
      root.removeEventListener("pointerdown", onRootPointerDown);
      root.removeEventListener("dblclick", onRootDoubleClick);
      global.removeEventListener("hashchange", onHashChange);
      documentRef.removeEventListener("keydown", onDocumentKeydown);
      documentRef.removeEventListener("pointermove", onDocumentPointerMove);
      documentRef.removeEventListener("pointerup", onDocumentPointerUp);
      onDocumentPointerUp();
      if (hooks.routeSelect) hooks.routeSelect.removeEventListener("change", onRouteSelect);
      if (hooks.pageFilter) hooks.pageFilter.removeEventListener("input", applyPageFilter);
      if (hooks.refreshButton) hooks.refreshButton.removeEventListener("click", refresh);
      if (hooks.timezoneToggle) hooks.timezoneToggle.removeEventListener("click", onTimezone);
      if (hooks.authChip) hooks.authChip.removeEventListener("click", onAuthChipClick);
      if (hooks.commandInput) hooks.commandInput.removeEventListener("input", renderCommandResults);
      if (hooks.commandInput) hooks.commandInput.removeEventListener("keydown", onCommandInputKeydown);
      if (hooks.commandResults) hooks.commandResults.removeEventListener("click", onCommandResultClick);
      if (hooks.commandClose) hooks.commandClose.removeEventListener("click", closeCommand);
      if (hooks.toastDismiss) hooks.toastDismiss.removeEventListener("click", hideToast);
      closeCommand();
      hideToast();
      if (shellRoot && typeof shellRoot.removeAttribute === "function") {
        shellRoot.removeAttribute("data-active-route");
      }
      root.replaceChildren();
      state.providerState = provider ? "disposed" : "absent";
      state.controlState = commands ? "disposed" : "absent";
      state.controlSnapshot = null;
      state.commandResult = null;
      state.administrationState = administration ? "disposed" : "absent";
      state.administrationSnapshot = null;
      state.administrationPrompt = null;
      state.administrationResult = null;
      state.administrationDraft = null;
      state.authState = auth ? "unmounted" : "absent";
      state.session = Object.freeze({ authenticated: false });
      updateShellState();
      if (state.started && provider && typeof provider.dispose === "function") {
        try {
          const disposal = provider.dispose();
          if (disposal && typeof disposal.then === "function") {
            disposal.catch(() => {
              if (global.console && typeof global.console.error === "function") global.console.error("Data adapter disposal failed.");
            });
          }
        } catch {
          if (global.console && typeof global.console.error === "function") global.console.error("Data adapter disposal failed.");
        }
      }
      if (state.started && commands && typeof commands.dispose === "function") {
        try {
          const disposal = commands.dispose();
          if (disposal && typeof disposal.then === "function") {
            disposal.catch(() => {
              if (global.console && typeof global.console.error === "function") global.console.error("Connector command provider disposal failed.");
            });
          }
        } catch {
          if (global.console && typeof global.console.error === "function") global.console.error("Connector command provider disposal failed.");
        }
      }
      if (state.started && administration && typeof administration.dispose === "function") {
        try {
          const disposal = administration.dispose();
          if (disposal && typeof disposal.then === "function") {
            disposal.catch(() => {
              if (global.console && typeof global.console.error === "function") global.console.error("Administration provider disposal failed.");
            });
          }
        } catch {
          if (global.console && typeof global.console.error === "function") global.console.error("Administration provider disposal failed.");
        }
      }
    }

    function navigate(path, query) {
      if (state.terminal) throw new Error("This application controller has been unmounted.");
      if (!pageByPath.has(path)) throw new TypeError("navigate path is not in the SOC interface catalog.");
      const target = routeHash(path, query);
      if (target === global.location.hash && privateViewCleanup && privateViewCleanup.isDirty && privateViewCleanup.isDirty()) return undefined;
      if (global.location.hash === target) return renderRoute("navigation");
      global.location.hash = target;
      return undefined;
    }

    function markFormDirty(event) {
      const form = event.target && event.target.closest ? event.target.closest("form") : null;
      if (form && form.dataset) form.dataset.dirty = "true";
    }

    function refresh(reason) {
      if (!state.mounted) return Promise.resolve();
      if (refreshPromise) return refreshPromise;
      if (state.commandPending || state.administrationPending || (privateViewCleanup && privateViewCleanup.isDirty && privateViewCleanup.isDirty()) || root.querySelector('form[data-dirty="true"]')
          || root.querySelector('dialog[open]') || (hooks.commandDialog && hooks.commandDialog.open)) {
        if (reason !== "automatic") showToast("Refresh paused to preserve your edits or pending action. Save or leave this page first.");
        return Promise.resolve();
      }
      refreshPromise = (async () => {
        await loadSession();
        if (!state.mounted) return;
        await renderRoute("refresh");
      })().finally(() => { refreshPromise = null; });
      return refreshPromise;
    }

    function getState() {
      return Object.freeze({
        mounted: state.mounted,
        terminal: state.terminal,
        route: state.route,
        query: Object.freeze(queryObject(state.query)),
        providerState: state.providerState,
        controlState: state.controlState,
        commandPending: state.commandPending,
        administrationState: state.administrationState,
        administrationPending: state.administrationPending,
        authenticated: state.session.authenticated,
        timezone: state.timezone
      });
    }

    const api = Object.freeze({ mount, unmount, navigate, refresh, getState });
    return api;
  }

  global.SocConsole = Object.freeze({
    VERSION,
    routes: Object.freeze(routes),
    primaryRoutes: Object.freeze(primaryRoutes),
    uiCatalog: catalog,
    technicalDocumentation: technicalDocs,
    createApp
  });
}(window));
