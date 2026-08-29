"use strict";

// This file contains only fixed, synthetic display data. It performs no
// requests, persistence, telemetry collection, or environment discovery.

const groups = [
  ["Monitor", [
    ["/", "Overview", "overview", "Current posture at a glance"],
    ["/health", "Console Health", "health", "Example source and service health"],
    ["/brief", "Daily Brief", "brief", "A synthetic operator handoff"],
    ["/analytics", "Analytics", "analytics", "Illustrative event trends"],
    ["/timeline", "Timeline", "timeline", "A chronological demo activity stream"]
  ]],
  ["Respond", [
    ["/triage", "Triage", "triage", "Prioritize and review synthetic findings"],
    ["/tuning", "Detection Tuning", "tuning", "Review example rule feedback"],
    ["/rules", "Rules", "rules", "A placeholder detection catalog"],
    ["/alerts", "Alert Communications", "alerts", "Illustrative notification status"],
    ["/honeypots", "Decoys", "decoys", "Synthetic decoy inventory"],
    ["/phishing", "Reported Messages", "reported", "Example user-reported messages"]
  ]],
  ["Investigate", [
    ["/logs", "Logs", "logs", "Search-interface placeholder"],
    ["/activity", "Activity", "activity", "Illustrative behavior summaries"],
    ["/ioc", "Indicator Parser", "ioc", "Disabled indicator-input concept"],
    ["/intel", "Threat Intelligence", "intel", "Synthetic intelligence summaries"],
    ["/known-ips", "Known Addresses", "known", "Example allowlisted addresses"]
  ]],
  ["Vulnerability Management", [
    ["/scans", "Scans", "scans", "Synthetic scan posture"],
    ["/remediation", "Remediation", "remediation", "Example remediation queue"]
  ]],
  ["Estate", [
    ["/systems", "Systems", "systems", "Reserved example systems"],
    ["/databases", "Databases", "databases", "Generic datastore inventory"],
    ["/backups", "Backups", "backups", "Illustrative backup posture"],
    ["/retention", "Retention", "retention", "Example retention controls"],
    ["/sources", "Sources", "sources", "Synthetic telemetry sources"]
  ]],
  ["Govern", [
    ["/attestations", "Attestations", "attestations", "Example attestation workflow"],
    ["/register", "Risk Register", "register", "Synthetic rolling risk register"],
    ["/access", "Access Reviews", "access", "Illustrative access review"]
  ]],
  ["Configure", [
    ["/onboard", "Onboarding", "onboard", "Disabled onboarding concept"],
    ["/settings", "Settings", "settings", "Read-only configuration example"]
  ]]
];

const pages = groups.flatMap(([group, entries]) => entries.map(([path, label, kind, summary]) => ({
  group, path, label, kind, summary
})));
const pageByPath = new Map(pages.map((page) => [page.path, page]));

const metrics = [
  ["Open findings", "7", "warn", "synthetic queue"],
  ["High priority", "2", "bad", "demo only"],
  ["Reporting sources", "8 / 9", "ok", "illustrative"],
  ["Overdue risks", "1", "warn", "sample register"]
];

const findings = [
  ["demo-104", { pill: "high", tone: "bad" }, "Unusual sign-in sequence", "app-demo-01", "12 min", { pill: "open", tone: "warn" }],
  ["demo-103", { pill: "medium", tone: "warn" }, "Configuration drift observed", "edge-demo-01", "37 min", { pill: "review", tone: "warn" }],
  ["demo-102", { pill: "low", tone: "neutral" }, "New service account activity", "data-demo-01", "2 hr", { pill: "open", tone: "warn" }],
  ["demo-101", { pill: "info", tone: "neutral" }, "Scheduled integrity check", "archive-demo-01", "4 hr", { pill: "closed", tone: "ok" }]
];

const timeline = [
  ["09:42", "High-priority demo finding opened", "app-demo-01 · demo-104"],
  ["09:17", "Example source check completed", "8 of 9 sources reporting"],
  ["08:55", "Synthetic configuration drift queued", "edge-demo-01 · demo-103"],
  ["08:10", "Daily brief generated", "Static fixture, no background job"]
];

const tables = {
  health: {
    title: "Component status",
    columns: ["Component", "State", "Last check", "Note"],
    rows: [
      ["Demo renderer", { pill: "available", tone: "ok" }, "just now", "Local static files"],
      ["Synthetic fixtures", { pill: "available", tone: "ok" }, "just now", "Fixed in the browser"],
      ["External connections", { pill: "disabled", tone: "neutral" }, "never", "Not implemented"],
      ["Persistent storage", { pill: "disabled", tone: "neutral" }, "never", "Not implemented"]
    ]
  },
  brief: {
    title: "Example handoff items",
    columns: ["Priority", "Item", "Owner", "Status"],
    rows: [
      [{ pill: "1", tone: "bad" }, "Review demo-104", "Example operator", { pill: "open", tone: "warn" }],
      [{ pill: "2", tone: "warn" }, "Confirm example source cadence", "Example operator", { pill: "planned", tone: "neutral" }],
      [{ pill: "3", tone: "neutral" }, "Read the public safety boundary", "Contributor", { pill: "informational", tone: "neutral" }]
    ]
  },
  triage: {
    title: "Synthetic findings",
    columns: ["ID", "Severity", "Finding", "System", "Age", "State"],
    rows: findings
  },
  tuning: {
    title: "Example feedback queue",
    columns: ["Rule", "Observation", "Suggested review", "State"],
    rows: [
      ["rule-demo-01", "Three synthetic matches", "Check example threshold", { pill: "review", tone: "warn" }],
      ["rule-demo-02", "No recent matches", "Keep as template", { pill: "stable", tone: "ok" }],
      ["rule-demo-03", "Draft only", "Add fixture coverage", { pill: "draft", tone: "neutral" }]
    ]
  },
  rules: {
    title: "Example rule catalog",
    columns: ["ID", "Name", "Source", "State", "Demo matches"],
    rows: [
      ["rule-demo-01", "Example sign-in anomaly", "Template", { pill: "enabled", tone: "ok" }, "3"],
      ["rule-demo-02", "Example configuration change", "Template", { pill: "enabled", tone: "ok" }, "1"],
      ["rule-demo-03", "Example integrity signal", "Template", { pill: "draft", tone: "neutral" }, "0"]
    ]
  },
  alerts: {
    title: "Illustrative notification log",
    columns: ["Finding", "Channel", "State", "When"],
    rows: [
      ["demo-104", "Demo channel", { pill: "not sent", tone: "neutral" }, "never"],
      ["demo-103", "Demo channel", { pill: "not sent", tone: "neutral" }, "never"]
    ]
  },
  decoys: {
    title: "Synthetic decoy inventory",
    columns: ["Name", "Type", "State", "Last event"],
    rows: [
      ["decoy-demo-01", "Example file", { pill: "illustrative", tone: "neutral" }, "none"],
      ["decoy-demo-02", "Example identity", { pill: "illustrative", tone: "neutral" }, "none"]
    ]
  },
  reported: {
    title: "Example reported messages",
    columns: ["ID", "Subject", "Assessment", "State"],
    rows: [
      ["message-demo-01", "Example account notice", { pill: "suspicious", tone: "warn" }, { pill: "open", tone: "warn" }],
      ["message-demo-02", "Example newsletter", { pill: "benign", tone: "ok" }, { pill: "closed", tone: "ok" }]
    ]
  },
  logs: {
    title: "Static search preview",
    columns: ["Time", "System", "Kind", "Summary"],
    rows: [
      ["09:42", "app-demo-01", "auth", "Synthetic sign-in event"],
      ["09:17", "edge-demo-01", "system", "Synthetic health event"],
      ["08:55", "data-demo-01", "change", "Synthetic configuration event"]
    ]
  },
  activity: {
    title: "Illustrative activity summaries",
    columns: ["Identity", "Observed behavior", "Window", "State"],
    rows: [
      ["user-a@example.invalid", "Normal demonstration pattern", "7 days", { pill: "baseline", tone: "ok" }],
      ["service-a@example.invalid", "New demonstration pattern", "24 hours", { pill: "review", tone: "warn" }]
    ]
  },
  ioc: {
    title: "Parsed indicator example",
    columns: ["Value", "Type", "Context", "State"],
    rows: [
      ["sample.example.invalid", "Domain", "Reserved example value", { pill: "synthetic", tone: "neutral" }],
      ["demo-file-hash", "Label", "Not a real fingerprint", { pill: "synthetic", tone: "neutral" }]
    ]
  },
  intel: {
    title: "Synthetic intelligence entries",
    columns: ["Entry", "Category", "Confidence", "Source"],
    rows: [
      ["intel-demo-01", "Example campaign", { pill: "medium", tone: "warn" }, "Synthetic fixture"],
      ["intel-demo-02", "Example infrastructure", { pill: "low", tone: "neutral" }, "Synthetic fixture"]
    ]
  },
  known: {
    title: "Reserved example addresses",
    columns: ["Label", "Address", "Purpose", "State"],
    rows: [
      ["Example gateway", "192.0.2.10", "Documentation range", { pill: "known", tone: "ok" }],
      ["Example service", "198.51.100.24", "Documentation range", { pill: "known", tone: "ok" }]
    ]
  },
  scans: {
    title: "Synthetic scan summaries",
    columns: ["System", "Profile", "Findings", "State"],
    rows: [
      ["app-demo-01", "Example dependency review", "2 medium", { pill: "complete", tone: "ok" }],
      ["edge-demo-01", "Example configuration review", "1 high", { pill: "review", tone: "warn" }],
      ["data-demo-01", "Example inventory review", "0", { pill: "complete", tone: "ok" }]
    ]
  },
  remediation: {
    title: "Example remediation queue",
    columns: ["ID", "Work item", "Target", "State"],
    rows: [
      ["fix-demo-01", "Review example configuration", "2030-04-15", { pill: "planned", tone: "warn" }],
      ["fix-demo-02", "Document example exception", "2030-04-22", { pill: "open", tone: "neutral" }]
    ]
  },
  systems: {
    title: "Synthetic systems",
    columns: ["Name", "Role", "Environment", "State", "Last seen"],
    rows: [
      ["app-demo-01", "Application", "Example", { pill: "healthy", tone: "ok" }, "2 min"],
      ["edge-demo-01", "Gateway", "Example", { pill: "review", tone: "warn" }, "5 min"],
      ["data-demo-01", "Datastore", "Example", { pill: "healthy", tone: "ok" }, "3 min"],
      ["archive-demo-01", "Archive", "Example", { pill: "quiet", tone: "neutral" }, "1 hr"]
    ]
  },
  databases: {
    title: "Generic datastores",
    columns: ["Name", "Purpose", "Protection", "State"],
    rows: [
      ["data-demo-01", "Synthetic application records", "Example encrypted label", { pill: "illustrative", tone: "neutral" }],
      ["archive-demo-01", "Synthetic history", "Example retention label", { pill: "illustrative", tone: "neutral" }]
    ]
  },
  backups: {
    title: "Illustrative backup posture",
    columns: ["Dataset", "Last copy", "Restore exercise", "State"],
    rows: [
      ["Example application", "today", "2030-02-01", { pill: "current", tone: "ok" }],
      ["Example archive", "yesterday", "not scheduled", { pill: "review", tone: "warn" }]
    ]
  },
  retention: {
    title: "Example retention controls",
    columns: ["Record class", "Window", "Review", "State"],
    rows: [
      ["Demo events", "30 days", "Quarterly", { pill: "example", tone: "neutral" }],
      ["Demo evidence", "90 days", "Quarterly", { pill: "example", tone: "neutral" }]
    ]
  },
  sources: {
    title: "Synthetic telemetry sources",
    columns: ["Source", "System", "State", "Cadence"],
    rows: [
      ["Authentication events", "app-demo-01", { pill: "reporting", tone: "ok" }, "5 min"],
      ["System events", "app-demo-01", { pill: "reporting", tone: "ok" }, "5 min"],
      ["Gateway events", "edge-demo-01", { pill: "reporting", tone: "ok" }, "10 min"],
      ["Integrity summaries", "data-demo-01", { pill: "reporting", tone: "ok" }, "1 hr"],
      ["Archive receipts", "archive-demo-01", { pill: "quiet", tone: "warn" }, "24 hr"]
    ]
  },
  access: {
    title: "Illustrative identities",
    columns: ["Identity", "Role", "Scope", "State"],
    rows: [
      ["operator@example.invalid", "Owner", "Demo console", { pill: "reviewed", tone: "ok" }],
      ["reviewer@example.invalid", "Reader", "Demo console", { pill: "review", tone: "warn" }]
    ]
  },
  onboard: {
    title: "Onboarding preview",
    columns: ["Step", "Purpose", "Availability"],
    rows: [
      ["1. Describe a source", "Define a generic presentation contract", { pill: "demo only", tone: "neutral" }],
      ["2. Validate a sample", "Review synthetic fields", { pill: "demo only", tone: "neutral" }],
      ["3. Approve connection", "Requires a real security design", { pill: "not implemented", tone: "neutral" }]
    ]
  },
  settings: {
    title: "Read-only example settings",
    columns: ["Setting", "Example value", "State"],
    rows: [
      ["Display timezone", "UTC", { pill: "static", tone: "neutral" }],
      ["Review window", "24 hours", { pill: "static", tone: "neutral" }],
      ["Notifications", "Disabled", { pill: "not connected", tone: "neutral" }]
    ]
  }
};

const content = document.getElementById("content");
const sideNavigation = document.getElementById("side-navigation");
const routeSelect = document.getElementById("route-select");
const navFilter = document.getElementById("nav-filter");
const toast = document.getElementById("toast");
let toastTimer;
let attestationView = "active";
let registerView = "active";
let documentView = "view";

function node(tag, options = {}, children = []) {
  const result = document.createElement(tag);
  if (options.className) result.className = options.className;
  if (options.text !== undefined) result.textContent = String(options.text);
  if (options.href) result.setAttribute("href", options.href);
  if (options.type) result.setAttribute("type", options.type);
  if (options.name) result.setAttribute("name", options.name);
  if (options.value !== undefined) result.value = String(options.value);
  if (options.placeholder) result.setAttribute("placeholder", options.placeholder);
  if (options.disabled) result.disabled = true;
  if (options.hidden) result.hidden = true;
  for (const [name, value] of Object.entries(options.attrs || {})) {
    result.setAttribute(name, String(value));
  }
  for (const [name, value] of Object.entries(options.data || {})) {
    result.dataset[name] = String(value);
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child) result.append(child);
  }
  return result;
}

function showToast(message = "This control is demonstrative only; no action was taken.") {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3600);
}

function demoButton(label) {
  const button = node("button", { className: "demo-action", text: label, type: "button" });
  button.addEventListener("click", () => showToast());
  return button;
}

function pill(label, tone = "neutral") {
  return node("span", { className: "pill", text: label, data: { tone } });
}

function renderCell(value) {
  if (value && typeof value === "object" && value.pill) return pill(value.pill, value.tone);
  const className = typeof value === "string" && /^(demo-|rule-demo|fix-demo|message-demo|decoy-demo)/.test(value)
    ? "mono" : "";
  return node("span", { className, text: value });
}

function panel(title, body, meta = "synthetic data") {
  return node("section", { className: "panel" }, [
    node("header", { className: "panel-header" }, [
      node("h2", { text: title }),
      node("span", { className: "panel-meta", text: meta })
    ]),
    body
  ]);
}

function dataTable(columns, rows, caption) {
  const table = node("table");
  table.append(node("caption", { className: "sr-only", text: caption || "Synthetic demonstration data" }));
  const headerRow = node("tr");
  columns.forEach((column) => headerRow.append(node("th", { text: column, attrs: { scope: "col" } })));
  table.append(node("thead", {}, headerRow));
  const body = node("tbody");
  rows.forEach((row) => {
    const tr = node("tr");
    row.forEach((value) => tr.append(node("td", {}, renderCell(value))));
    body.append(tr);
  });
  table.append(body);
  return node("div", { className: "table-scroll", attrs: { tabindex: "0", role: "region", "aria-label": caption || "Synthetic data table" } }, table);
}

function heading(page) {
  return node("header", { className: "page-heading" }, [
    node("div", {}, [
      node("p", { className: "eyebrow", text: page.group }),
      node("h1", { text: page.label }),
      node("p", { className: "lede", text: page.summary })
    ]),
    demoButton("Demo action")
  ]);
}

function notice() {
  return node("div", { className: "notice", attrs: { role: "note" } }, [
    node("strong", { text: "Synthetic demo" }),
    node("span", { text: "All values are invented. No external systems, accounts, or data sources are connected." })
  ]);
}

function renderMetrics() {
  return node("div", { className: "metric-grid" }, metrics.map(([label, value, tone, note]) =>
    node("section", { className: "metric-card", data: { tone } }, [
      node("div", { className: "metric-label", text: label }),
      node("div", { className: "metric-value", text: value }),
      node("div", { className: "metric-note", text: note })
    ])
  ));
}

function timelineBody() {
  const list = node("ol", { className: "timeline-list" });
  timeline.forEach(([time, title, detail]) => {
    list.append(node("li", { className: "timeline-item" }, [
      node("time", { className: "timeline-time", text: time }),
      node("span", { className: "timeline-rail" }, node("span", { className: "timeline-dot" })),
      node("div", { className: "timeline-copy" }, [node("strong", { text: title }), node("span", { text: detail })])
    ]));
  });
  return node("div", { className: "panel-body" }, list);
}

function renderOverview() {
  return [
    renderMetrics(),
    node("div", { className: "two-column" }, [
      panel("Recent findings", dataTable(
        ["ID", "Severity", "Finding", "System", "Age", "State"], findings, "Recent synthetic findings"
      )),
      panel("Recent activity", timelineBody(), "fixed clock")
    ])
  ];
}

function renderAnalytics() {
  const heights = [36, 51, 44, 67, 58, 76, 62, 85, 71, 64, 80, 55];
  const bars = node("div", { className: "bars", attrs: { role: "img", "aria-label": "Illustrative event volume over twelve periods" } });
  heights.forEach((height, index) => bars.append(node("span", {
    className: `bar bar-h${height}`,
    attrs: { title: `Period ${index + 1}: synthetic value ${height}` }
  })));
  return [
    renderMetrics(),
    panel("Illustrative event volume", node("div", { className: "panel-body" }, [
      bars,
      node("div", { className: "chart-caption" }, [node("span", { text: "Earlier" }), node("span", { text: "Later" })])
    ]), "not measured data")
  ];
}

function tabBar(labels, selected, onSelect, ariaLabel) {
  const list = node("div", { className: "tabs", attrs: { role: "tablist", "aria-label": ariaLabel } });
  labels.forEach(([key, label]) => {
    const button = node("button", {
      className: "tab-button",
      text: label,
      type: "button",
      attrs: { role: "tab", "aria-selected": key === selected ? "true" : "false" }
    });
    button.addEventListener("click", () => onSelect(key));
    list.append(button);
  });
  return list;
}

function disabledField(label, kind = "input", placeholder = "Example value") {
  const control = node(kind, { disabled: true, placeholder, attrs: { "aria-label": label } });
  return node("label", { className: `demo-field${kind === "textarea" ? " wide" : ""}` }, [
    node("span", { text: label }), control
  ]);
}

function renderAttestations() {
  const wrap = node("div");
  wrap.append(tabBar([
    ["active", "Active"], ["add", "Add attestation"], ["archive", "Archive"]
  ], attestationView, (value) => { attestationView = value; renderCurrentPage(); }, "Attestation views"));

  if (attestationView === "add") {
    wrap.append(panel("Add attestation", node("div", { className: "panel-body" }, [
      node("div", { className: "demo-form-grid" }, [
        disabledField("Category", "input", "Example category"),
        disabledField("Item title", "input", "Example attestation"),
        disabledField("Review cadence", "select"),
        disabledField("Description", "textarea", "What should be reviewed?")
      ]),
      node("p", { className: "muted", text: "Inputs are disabled in the public scaffold. A real workflow needs authenticated ownership, validation, and an audit trail." })
    ]), "disabled concept"));
  } else if (attestationView === "archive") {
    wrap.append(node("section", { className: "panel empty-state" }, [
      node("h2", { text: "Archive is empty" }),
      node("p", { text: "This demonstrates the archived-state layout without retaining any records." })
    ]));
  } else {
    wrap.append(panel("Active attestations", dataTable(
      ["Category", "Attestation", "State", "Reviewed"],
      [
        ["Example API", "Data-use statement reviewed", { pill: "attested", tone: "ok" }, "2030-02-14"],
        ["Example API", "Access scope confirmed", { pill: "attested", tone: "ok" }, "2030-02-14"],
        ["Example vendor", "Annual questionnaire", { pill: "pending", tone: "warn" }, "Not yet"]
      ], "Synthetic attestations"
    )));
  }
  return [wrap];
}

const riskRows = [
  ["r-demo-01", "Review coverage is incomplete", "Example owner", "2030-04-15", { pill: "medium", tone: "warn" }, "open"],
  ["r-demo-02", "Recovery exercise needs evidence", "Example owner", "2030-03-30", { pill: "high", tone: "bad" }, "overdue"],
  ["r-demo-03", "Inventory reconciliation", "Example owner", "2030-05-01", { pill: "low", tone: "neutral" }, "closed"]
];

function riskAction(state) {
  const verified = state === "closed";
  const details = node("details", { className: "action-details" });
  details.append(node("summary", {}, pill(verified ? "Actions taken and verified" : "Actions not verified", verified ? "ok" : "warn")));
  details.append(node("div", { className: "action-copy", text: verified
    ? "Synthetic closure: example review completed. Evidence: demonstration record only."
    : "Expand this pill to show where an authenticated closure workflow could collect what closed the risk, verification evidence, and a removal reason."
  }));
  return details;
}

function riskTable(rows) {
  const table = node("table");
  table.append(node("caption", { className: "sr-only", text: "Synthetic risk register" }));
  const head = node("tr");
  ["ID", "Risk", "Owner", "Due", "Severity", "Actions"].forEach((label) =>
    head.append(node("th", { text: label, attrs: { scope: "col" } })));
  table.append(node("thead", {}, head));
  const body = node("tbody");
  rows.forEach(([id, title, owner, due, severity, state]) => {
    const row = node("tr");
    [id, title, owner, due, severity].forEach((value) => row.append(node("td", {}, renderCell(value))));
    row.append(node("td", {}, riskAction(state)));
    body.append(row);
  });
  table.append(body);
  return node("div", { className: "table-scroll", attrs: { tabindex: "0", role: "region", "aria-label": "Synthetic risk register" } }, table);
}

function renderDocument() {
  const wrap = node("div");
  wrap.append(tabBar([
    ["view", "View"], ["replace", "Replace"], ["history", "History"], ["contract", "Contract"]
  ], documentView, (value) => { documentView = value; renderCurrentPage(); }, "Document views"));
  if (documentView === "replace") {
    wrap.append(panel("Replace rolling document", node("div", { className: "panel-body" }, [
      disabledField("Markdown file", "input", "File upload disabled"),
      node("p", { className: "muted", text: "The static demo neither reads nor retains files." })
    ]), "disabled concept"));
  } else if (documentView === "history") {
    wrap.append(panel("Document history", dataTable(
      ["Revision", "Date", "Author", "State"],
      [["demo-1", "2030-02-14", "Example author", { pill: "current", tone: "ok" }]],
      "Synthetic document history"
    )));
  } else if (documentView === "contract") {
    wrap.append(panel("Document contract", node("div", { className: "panel-body" }, [
      node("p", { text: "A real implementation should define a versioned schema, validation failures, ownership, audit records, and safe rendering rules before accepting documents." }),
      node("p", { className: "muted", text: "No parser or upload contract is implemented here." })
    ]), "design placeholder"));
  } else {
    wrap.append(panel("Rendered example document", node("div", { className: "panel-body" },
      node("article", { className: "document" }, [
        node("h2", { text: "Risk Register — Demonstration" }),
        node("p", { text: "This document is generated from fixed browser fixtures. It is not an assessment, policy, or system of record." }),
        node("h2", { text: "Open items" }),
        node("p", {}, [node("mark", { text: "r-demo-02 is overdue" }), document.createTextNode(" in the synthetic scenario and is highlighted for presentation testing.")]),
        node("h2", { text: "Review notes" }),
        node("p", { text: "Replace this section with a separately designed, authenticated document workflow in a real implementation." })
      ])
    ), "safe static rendering"));
  }
  return wrap;
}

function renderRegister() {
  const wrap = node("div");
  wrap.append(tabBar([
    ["active", "Active"], ["closed", "Closed"], ["archive", "Archive"], ["document", "Document"]
  ], registerView, (value) => { registerView = value; renderCurrentPage(); }, "Risk register views"));
  if (registerView === "document") {
    wrap.append(renderDocument());
  } else if (registerView === "archive") {
    wrap.append(node("section", { className: "panel empty-state" }, [
      node("h2", { text: "Archive is empty" }),
      node("p", { text: "Archived entries would remain available here in an operational design." })
    ]));
  } else {
    const filtered = riskRows.filter((row) => registerView === "closed" ? row[5] === "closed" : row[5] !== "closed");
    wrap.append(panel(registerView === "closed" ? "Closed risks" : "Active risks", riskTable(filtered)));
  }
  return [wrap];
}

function renderGeneric(page) {
  const config = tables[page.kind];
  if (!config) {
    return [node("section", { className: "panel empty-state" }, [
      node("h2", { text: "Demonstration state" }),
      node("p", { text: "This route intentionally contains no operational implementation." })
    ])];
  }
  const extras = [];
  if (["logs", "ioc", "onboard", "settings"].includes(page.kind)) {
    extras.push(node("div", { className: "notice", attrs: { role: "note" } }, [
      node("strong", { text: "Interaction disabled" }),
      node("span", { text: "The interface is present to demonstrate layout only; no input is submitted or retained." })
    ]));
  }
  extras.push(panel(config.title, dataTable(config.columns, config.rows, config.title)));
  return extras;
}

function currentPath() {
  const raw = location.hash.startsWith("#/") ? location.hash.slice(1).split("?")[0] : "/";
  return pageByPath.has(raw) ? raw : "/";
}

function updateNavigation(path) {
  document.querySelectorAll(".nav-link").forEach((link) => {
    if (link.dataset.path === path) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  routeSelect.value = path;
}

function renderCurrentPage() {
  const path = currentPath();
  const page = pageByPath.get(path);
  document.title = `${page.label} · SOC Console Skeleton`;
  updateNavigation(path);
  const fragment = document.createDocumentFragment();
  fragment.append(heading(page), notice());
  let sections;
  if (page.kind === "overview") sections = renderOverview();
  else if (page.kind === "analytics") sections = renderAnalytics();
  else if (page.kind === "timeline") sections = [panel("Example activity", timelineBody(), "fixed clock")];
  else if (page.kind === "attestations") sections = renderAttestations();
  else if (page.kind === "register") sections = renderRegister();
  else sections = renderGeneric(page);
  sections.forEach((section) => fragment.append(section));
  content.replaceChildren(fragment);
  content.focus({ preventScroll: true });
}

function buildNavigation() {
  groups.forEach(([title, entries], groupIndex) => {
    const details = node("details", { className: "nav-group" });
    details.open = true;
    details.append(node("summary", { text: title }));
    const list = node("ul", { className: "nav-list" });
    entries.forEach(([path, label]) => {
      const link = node("a", { className: "nav-link", href: `#${path}`, data: { path } }, [
        node("span", { className: "nav-icon", text: label.slice(0, 2).toUpperCase(), attrs: { "aria-hidden": "true" } }),
        node("span", { text: label })
      ]);
      list.append(node("li", {}, link));
    });
    details.append(list);
    sideNavigation.append(details);

    const optionGroup = node("optgroup", { attrs: { label: title } });
    entries.forEach(([path, label]) => optionGroup.append(node("option", { text: label, value: path })));
    routeSelect.append(optionGroup);
    if (groupIndex === 0) details.open = true;
  });
}

routeSelect.addEventListener("change", () => { location.hash = routeSelect.value; });
navFilter.addEventListener("input", () => {
  const wanted = navFilter.value.trim().toLowerCase();
  document.querySelectorAll(".nav-link").forEach((link) => {
    link.closest("li").hidden = wanted && !link.textContent.toLowerCase().includes(wanted);
  });
  document.querySelectorAll(".nav-group").forEach((details) => {
    const visible = [...details.querySelectorAll("li")].some((item) => !item.hidden);
    details.hidden = !visible;
    if (wanted && visible) details.open = true;
  });
});

window.addEventListener("hashchange", renderCurrentPage);
buildNavigation();
renderCurrentPage();
