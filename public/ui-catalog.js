"use strict";

// Structural catalog for the public interface. It contains labels, layouts,
// controls, and table schemas only. Records, counts, identities, indicators,
// hostnames, findings, policies, evidence, and operational configuration are
// intentionally absent.
(function installUiCatalog(global) {
  const panelId = (title) => String(title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 72);
  const table = (title, columns, meta = "", id = panelId(title)) => ({ id, type: "table", title, columns, meta });
  const metrics = (...labels) => ({ id: "summary-metrics", type: "metrics", labels });
  const chart = (title, series = []) => ({ id: panelId(title), type: "chart", title, series });
  const bars = (title) => ({ id: panelId(title), type: "bars", title });
  const timeline = (title) => ({ id: panelId(title), type: "timeline", title });
  const info = (title, id = panelId(title)) => ({ id, type: "info", title });
  const cards = (title, labels) => ({ id: panelId(title), type: "cards", title, labels });
  const facts = (title, labels, meta = "", id = panelId(title)) => ({ id, type: "facts", title, labels, meta });
  const settings = (title, fields, note = "", id = panelId(title)) => ({ id, type: "settings", title, fields, note });
  const workflow = (title, fields, actions, columns = [], options = {}) => ({
    id: options.id || panelId(title), type: "workflow", title, fields, actions, columns,
    meta: options.meta || "", tableBefore: options.tableBefore === true
  });
  const sourceHistory = () => ({ id: "source-history", type: "source-history", title: "Recent activity" });
  const form = (title, fields, actions, id = panelId(title)) => ({ id, type: "form", title, fields, actions });
  const lookup = (title, actions, id = panelId(title)) => ({ id, type: "lookup", title, actions });
  const logResults = () => ({ id: "log-results", type: "log-results", title: "Events" });
  const searchDispatch = () => ({ id: "search-dispatch", type: "search-dispatch", title: "Search dispatch" });
  const detailMetrics = (id, title, labels) => ({ id, type: "metrics", title, labels });
  const field = (label, type = "text", options = {}) => ({ label, type, ...options });
  const conditioned = (whenQuery, panels) => panels.map((panel) => ({ ...panel, whenQuery }));
  const scanConnectionProfile = (
    setupFor, title, description, surfaceIds, requiredRecordKinds, recommendedRecordKinds = []
  ) => ({
    setupFor, title, description, surfaceIds, requiredRecordKinds, recommendedRecordKinds
  });
  const tuningDefinitionTable = () => table("Detection tune definitions", [
    "Detection", "Match scope", "Status", "Revision", "Owner", "Expires", ""
  ]);
  const tuningOccurrenceTable = (title) => table(title, [
    "When", "Case", "Detection", "Host", "Alert", "Tune", "Revision",
    "Notification policy", "Outcome", ""
  ]);
  const tuningRecommendationTable = () => table("Recommendations · Internal noise candidates", [
    "Artifact role", "Detection", "Host", "Observed path", "SHA-256",
    "Why suggested", "Coverage", ""
  ], "Review only", "tune-recommendations");
  const tuningSummaryMetrics = () => metrics("Active Tunes", "Drafts", "Disabled", "Authorized Findings");
  const tuningDetailPanels = () => [
    detailMetrics("tune-detail-record", "Detection tune", [
      "Status", "Detector revision", "Notifications", "Owner", "Created", "Duration", "Expires",
      "YARA definition environment", "Detector", "Host", "Severity", "Reason", "Evidence / precedent",
      "Revisit this if", "Activity", "Source occurrence"
    ]),
    detailMetrics("tune-detail-preview-summary", "Historical preview", [
      "Scanned", "Scope matches", "Eligible findings", "Closable decisions", "Mixed / stays open",
      "Critical bypass", "Protected", "Decisions", "Cases", "Open", "Closed", "Proposed"
    ]),
    table("Representative historical matches", [
      "When", "Host", "Sev", "Rule", "Alert", "Case", "Status", "Prior reason"
    ], "", "tune-detail-preview-matches"),
    { id: "tune-detail-lineage", type: "timeline", title: "Immutable tune lineage" },
    { id: "tune-detail-delivery-audit", type: "timeline", title: "Delivery authorization audit" }
  ];
  const ruleDetailPanels = () => [
    detailMetrics("rule-detail-summary", "Rule definition", [
      "Detector", "Definition state", "Published ruleset", "Enabled", "Severity / level", "Channel",
      "Fires · this estate", "Provenance"
    ]),
    { id: "rule-source-definition", type: "info", title: "Source / provenance definition" },
    { id: "rule-effective-definition", type: "info", title: "Effective definition evaluated now" },
    table("Sample occurrences", [
      "When", "Host", "Case", "Sev", "Alert", "Definition", "Host ruleset", ""
    ], "", "rule-detail-occurrences")
  ];
  const remediationPanels = () => [
    info("VM analyst — latest review"),
    form("Record a remediation", [
      field("What was fixed"), field("Found by", "select"),
      field("Why it counts as fixed", "textarea", { wide: true }),
      field("How it was fixed", "textarea", { wide: true }),
      field("Future concerns", "textarea", { wide: true }), field("References")
    ], ["Record it"]),
    cards("Remediation log", ["What was fixed", "Found by", "Why it's fixed", "How we fixed it", "Future concerns", "References"])
  ];

  const groups = [
    ["Monitor", [
      ["/", "Overview"],
      ["/health", "SOC Health"],
      ["/brief", "Daily Brief"],
      ["/analytics", "Analytics"],
      ["/timeline", "Timeline"]
    ]],
    ["Respond", [
      ["/triage", "Triage"],
      ["/tuning", "Detection Tuning"],
      ["/rules", "Rules"],
      ["/alerts", "Alert Comms"],
      ["/honeypots", "Honeypots"],
      ["/phishing", "Phishing"]
    ]],
    ["Investigate", [
      ["/logs", "Logs"],
      ["/activity", "Activity Learner"],
      ["/ioc", "IOC Parser"],
      ["/intel", "Threat Intel"],
      ["/known-ips", "Known IPs"]
    ]],
    ["Vuln Mgmt", [
      ["/scans", "Scans"],
      ["/remediation", "Remediation"]
    ]],
    ["Estate", [
      ["/systems", "Systems"],
      ["/databases", "Databases"],
      ["/backups", "Backups"],
      ["/retention", "Retention"],
      ["/sources", "Sources"],
      ["/agents", "Agent Management"]
    ]],
    ["Govern", [
      ["/attestations", "Attestations"],
      ["/register", "Risk Register"],
      ["/access", "Access"]
    ]]
  ];

  const pages = [
    {
      path: "/", group: "Monitor", label: "Overview", displayTitle: "Security Posture — Overview", variant: "overview",
      panels: [
        metrics("Needs review", "Sources needing attention", "Register overdue", "Dependabot open"),
        table("Detections", ["Time", "Host", "Severity", "Rule", "Event"]),
        table("Needs attention — register overdue", ["ID", "Risk", "Status", "Close it out"]),
        table("Next dated obligations", ["Due", "What is due"])
      ]
    },
    {
      path: "/health", group: "Monitor", label: "SOC Health", panelsBeforeTabs: ["summary-metrics"],
      panels: [metrics(
        "Feeds needing attention", "Untriaged", "Rules never fired", "Noise concentration",
        "Largest repeat group", "Detect to notify", "Alert queue persistence"
      )],
      tabsets: [{ param: "htab", default: "feeds", items: [
        { id: "feeds", label: "Feeds", panels: [table("Is the collection working", ["Feed", "Expected", "Last collection", "Activity", "Collection"])] },
        { id: "rules", label: "Rules never fired", panels: [table("Rules that have never fired", ["Rule", "Severity", "Channel", "Is its input arriving?"])] },
        { id: "firing", label: "What is firing", panels: [bars("What is actually firing")] },
        { id: "drills", label: "Drills", panels: [{
          ...table("Detection drills — last proven fire per layer", ["Layer", "Drill signature", "Last proven fire", "Age", "Status"]),
          rowDisclosures: ["How to drill"]
        }] },
        { id: "read", label: "How to read this", panels: [info("How to read this")] }
      ]}]
    },
    {
      path: "/brief", group: "Monitor", label: "Daily Brief",
      tabsets: [{ param: "btab", default: "brief", items: [
        { id: "brief", label: "Daily Brief", panels: [info("Do today"), info("Security brief"), info("Are we affected? · latest review")] },
        { id: "turnover", label: "Turnover board", panels: [
          table("To turn over — untouched", ["Case", "When", "Host", "Sev", "Rule", "Event", "Analyst"]),
          table("In work", ["Case", "When", "Host", "Sev", "Rule", "Event", "Analyst"]),
          table("Investigations — tagged real-threat", ["Case", "When", "Host", "Sev", "Rule", "Event", "Analyst"]),
          table("Dispositioned in the last 24h", ["Case", "When", "Host", "Sev", "Rule", "Event", "Analyst"]),
          info("Retention watch"), info("Are we affected?")
        ] },
        { id: "analyst", label: "Analyst briefings", path: "/analyst" }
      ]}]
    },
    {
      path: "/analyst", group: "Monitor", label: "Analyst Briefings", hidden: true,
      tabsets: [
        { param: "btab", default: "analyst", items: [
          { id: "brief", label: "Daily Brief", path: "/brief" },
          { id: "turnover", label: "Turnover board", path: "/brief", query: { btab: "turnover" } },
          { id: "analyst", label: "Analyst briefings" }
        ]},
        { param: "atab", default: "briefings", when: { btab: "analyst" }, items: [
          { id: "briefings", label: "Estate briefings", panels: [
            form("Run an analyst briefing", [field("Optional question")], ["Run Gemini fallback"]),
            info("Latest briefing"), info("The digest — what the analyst reads"),
            table("Previous briefings", ["When", "Kind", "First line"]), info("How this works")
          ] },
          { id: "cases", label: "Case findings", panels: [table("Case analyst · every analysis on record", ["Case", "When", "Status", "First line"])] },
          { id: "rules", label: "Rules review", panels: [info("Rules analyst · latest weekly review"), info("Open rule challenges")] },
          { id: "vuln", label: "Vulnerability", panels: [info("VM analyst · latest weekly review")] },
          { id: "affected", label: "Are we affected?", panels: [info("Affected analyst · latest weekly review"), info("Open items")] },
          { id: "retention", label: "Retention", panels: [info("Retention analyst · latest weekly review")] }
        ]}
      ]
    },
    {
      path: "/analytics", group: "Monitor", label: "Analytics", panelsBeforeTabs: ["summary-metrics"],
      tabsets: [{ param: "h", default: "48", items: [
        { id: "24", label: "24h" }, { id: "48", label: "48h" }, { id: "168", label: "7 days" }
      ]}],
      panels: [metrics("Events collected", "Detections", "Channels reporting", "History held"), chart("Events collected per hour", ["Events by channel"]), chart("Detections per hour", ["Critical", "High", "Info"]), bars("What is firing"), bars("Most-blocked source addresses"), info("How to read this")]
    },
    {
      path: "/timeline", group: "Monitor", label: "Timeline", variant: "timeline",
      queryBranches: [{ id: "host-timeline", whenQuery: { host: "present" } }],
      tabsets: [{ param: "range", default: "24h", items: [
        { id: "15m", label: "15m" }, { id: "1h", label: "1h" },
        { id: "24h", label: "24h" }, { id: "7d", label: "7d" }
      ]}],
      panels: [table("Unified timeline", ["When", "Kind", "Event"])]
    },
    {
      path: "/triage", group: "Respond", label: "Triage", variant: "triage",
      tabsets: [{ param: "view", default: "queue", items: [
        { id: "queue", label: "Queue" }, { id: "approvals", label: "Awaiting approval" }, { id: "cases", label: "Cases" }, { id: "closed", label: "Closed" }, { id: "all", label: "All" }
      ]}],
      panels: [
        table("Alerts", ["Select", "Case", "When", "Host", "Sev", "Rule", "Alert", "Status", "Owner", "Activity", "Agent / action"]),
        info("Detection tuning"), info("How triage works")
      ]
    },
    {
      path: "/tuning", group: "Respond", label: "Detection Tuning", variant: "tuning",
      queryBranches: [
        { id: "detail", whenQuery: { id: "present" }, panels: tuningDetailPanels() },
        { id: "occurrence-chooser", whenQuery: { id: "absent", choose: "present" }, panels: [
          table("Historical occurrences", [
            "When", "Host", "Case", "Sev", "Alert", "Definition", "Prior decision / activity", ""
          ], "", "tune-occurrence-options")
        ] },
        { id: "finding-chooser", whenQuery: {
          id: "absent", choose: "absent", host: "present", ts: "present", finding: "absent"
        }, panels: [
          table("Exact findings", ["Set", "Detection", "Sev", ""], "", "tune-finding-options")
        ] },
        { id: "draft-builder", whenQuery: {
          id: "absent", choose: "absent", host: "present", ts: "present", finding: "present"
        }, panels: [
          detailMetrics("tune-builder-source", "Retained finding context", [
            "Detector", "Host", "Severity", "Finding", "Alert", "Case"
          ]),
          table("Retained finding conditions", ["Field", "Operator", "Value"], "", "tune-builder-evidence")
        ] }
      ],
      panels: [tuningSummaryMetrics(), tuningRecommendationTable()],
      tabsets: [
        { param: "tview", default: "definitions", items: [
          { id: "definitions", label: "Definitions", panels: [tuningDefinitionTable()] },
          { id: "applied", label: "Applied alerts", panels: [tuningOccurrenceTable("Applied alerts")] },
          { id: "held", label: "Matched but held", panels: [tuningOccurrenceTable("Matched but held")] }
        ]},
        { param: "status", default: "active", when: { tview: "definitions" }, items: [
          { id: "active", label: "Active" }, { id: "draft", label: "Draft" }, { id: "disabled", label: "Disabled" }
        ]}
      ]
    },
    {
      path: "/rules", group: "Respond", label: "Detection Rules", variant: "rules",
      queryBranches: [{ id: "rule-detail", whenQuery: { ruleView: "present" }, panels: ruleDetailPanels() }],
      tabAliases: {
        rtab: {
          active: { rtab: "palisade", ptab: "active" },
          add: { rtab: "palisade", ptab: "add" },
          help: { rtab: "palisade", ptab: "help" }
        }
      },
      tabsets: [
        { param: "rtab", default: "palisade", items: [
          { id: "palisade", label: "Palisade" },
          { id: "sigma", label: "Sigma" },
          { id: "yara", label: "YARA" },
          { id: "snort", label: "Snort", panels: [info("Snort — deliberately not an engine here") ] },
          { id: "tuning", label: "Tune", panels: [tuningSummaryMetrics(), tuningRecommendationTable()] }
        ]},
        { param: "tview", default: "definitions", when: { rtab: "tuning" }, items: [
          { id: "definitions", label: "Definitions", panels: [tuningDefinitionTable()] },
          { id: "applied", label: "Applied alerts", panels: [tuningOccurrenceTable("Applied alerts")] },
          { id: "held", label: "Matched but held", panels: [tuningOccurrenceTable("Matched but held")] }
        ]},
        { param: "tstatus", default: "all", when: { rtab: "tuning", tview: "definitions" }, items: [
          { id: "all", label: "All" }, { id: "active", label: "Active" },
          { id: "draft", label: "Draft" }, { id: "disabled", label: "Disabled" }
        ]},
        { param: "ptab", default: "active", when: { rtab: "palisade" }, items: [
          { id: "active", label: "Active rules", panels: [
            table("Rules proposed by the analyst", ["Name", "Channel", "Pattern", "Why", ""]),
            table("Built-in rules", ["Rule", "Channel", "What it catches", "Fired", "Severity"]),
            table("Inline rules", ["Rule", "Channel", "What it catches", "Fired", "Severity"]),
            table("Custom rules", ["Rule", "Channel", "Pattern", "Fired", ""])
          ] },
          { id: "add", label: "Add a rule", panels: [
            form("Build and test a rule", [
              field("Rule name"), field("Channel", "select"), field("Host", "select"), field("Severity", "select"),
              field("Match pattern"), field("Except pattern"), field("Description"), field("Threshold", "number")
            ], ["Test against past logs"]),
            ...conditioned({ pattern: "present" }, [
              cards("Test result", ["Matched", "Lines scanned", "Would have fired", "Hosts"]),
              table("What it matched", ["When", "Host", "Line"]),
              form("Create this rule", [], ["Create this rule"], "create-tested-rule")
            ])
          ] },
          { id: "help", label: "How to write one", panels: [info("How to write a rule")] },
          { id: "decisions", label: "Deliberately not added", panels: [
            form("Challenge a rule · the weekly rules analyst answers", [field("Rule"), field("Your case")], ["File for the next review"]),
            info("Latest rules review"),
            cards("The negative space", ["Kind", "What was considered", "Why", "Evidence", "This changes if"]),
            form("Record a decision", [
              field("Kind", "select"), field("What was considered"), field("Why"), field("Evidence"), field("This changes if")
            ], ["Record decision"])
          ] }
        ]},
        { param: "stab", default: "rules", when: { rtab: "sigma" }, items: [
          { id: "rules", label: "Rules", panels: [form("Sigma filters", [field("Filter by title, channel, level")], ["Filter"]), table("Sigma rules", ["Rule", "Level", "Channel", ""])] },
          { id: "add", label: "Add / import", panels: [
            form("Import from SigmaHQ", [field("Rule directory", "select")], ["Import"]),
            form("Paste one Sigma rule", [field("Rule YAML", "textarea", { wide: true })], ["Compile & add"])
          ] },
          { id: "about", label: "How it works", panels: [info("What this engine honestly supports")] }
        ]},
        { param: "ytab", default: "about", when: { rtab: "yara" }, items: [
          { id: "about", label: "Status", panels: [info("YARA"), table("YARA status", ["Host", "Rules loaded", "Last scan", "State", "Ruleset / process coverage"])] },
          { id: "rules", label: "Browse", panels: [form("Browse YARA rules", [field("Search"), field("Family", "select")], ["Search"]), table("Every rule in the published set", ["Rule", "Family", "Description", ""])] },
          { id: "manage", label: "Manage", panels: [
            info("Update the base set"), table("Disabled rules", ["Rule", ""]),
            table("Custom rules", ["Rule", "Description", ""]),
            form("Add a custom YARA rule", [field("Rule source", "textarea", { wide: true })], ["Validate & add"])
          ] }
        ]}
      ]
    },
    {
      path: "/alerts", group: "Respond", label: "Alert Comms",
      tabsets: [{ param: "atab", default: "path", items: [
        { id: "path", label: "Alert path", panels: [cards("Alert path", ["Reachable people", "Sent (24h)", "Failed (24h)", "Highs waiting to batch", "Durable overflow"])] },
        { id: "paged", label: "Who gets paged", panels: [table("Who gets paged", ["Person", "Address", "Added", "Sends on", ""]), form("Add a recipient", [field("Email address", "email"), field("Who is this?"), field("Minimum severity", "select")], ["Add"])] },
        { id: "log", label: "Delivery log", panels: [table("Delivery log", ["Time", "", "Kind", "Message"])] },
        { id: "reconcile", label: "Reconciliation", panels: [
          info("Provider reconciliation"),
          form("Reconcile an attempt", [field("Provider delivery ID"), field("Provider delivery time"), field("What you verified and why", "textarea", { wide: true }), field("I verified this exact attempt was delivered", "checkbox")], ["Retry exact", "Requeue fresh", "Confirm delivered"], "provider-reconciliation-actions")
        ] }
      ]}]
    },
    {
      path: "/honeypots", group: "Respond", label: "Honeypots",
      tabsets: [{ param: "htab", default: "decoys", items: [
        { id: "decoys", label: "Decoy files", panels: [info("Decoy files — catch tampering"), form("Plant a decoy file", [field("Host", "select"), field("Decoy type", "select"), field("Path")], ["Plant decoy"]), table("Decoy files", ["Host", "Path", "Decoy type", "State", ""])] },
        { id: "canaries", label: "Canaries", panels: [
          info("Canaries — catch reading (and tampering)"),
          form("Plant a canary", [field("Host", "select"), field("Decoy type", "select"), field("Path")], ["Plant canary"]),
          table("Canaries", ["Host", "Path", "Decoy type", "Tripwire token", "State", ""]),
          table("System canary — /root/.env.backup", ["Host", "Path", "Bait", "Tripwire", "State", ""])
        ] },
        { id: "users", label: "Trap usernames", panels: [info("Trap usernames — estate-wide tripwires"), form("Add a trap username", [field("Name")], ["Add trap username"]), table("Trap usernames", ["Name", "Added", "State", ""])] },
        { id: "hits", label: "Trip log", panels: [table("Trip log", ["When", "Host", "What", "Event"])] },
        { id: "clerk", label: "Clerk honey account", panels: [info("Clerk honey account — pending your setup"), table("Honey-account proof", ["When", "Host", "Event"])] }
      ]}]
    },
    {
      path: "/phishing", group: "Respond", label: "Phishing",
      panels: [
        ...conditioned({ id: "absent" }, [
          metrics("Reports", "Likely phishing", "Suspicious", "Clean", "Scorer faults", "Newest report"),
          table("Report queue", ["Reported", "Reporter", "Org", "From → To", "Subject", "Verdict", "Score"], "Newest first")
        ]),
        ...conditioned({ id: "present" }, [
          cards("Verdict", ["Verdict", "Score", "Worst link", "Headers", "Body", "Detection", "Triage case", "Report ref"]),
          facts("Reported message", ["Reported", "Organization", "From → To", "Subject", "Received", "Received email id", "Thread token", "Shipped by"], "As shipped by the portal — all fields are evidence, rendered escaped"),
          table("Signal evidence", ["Signal", "Scope", "Tier", "Band", "Weight", "Evidence"]),
          table("Weights legend", ["Signal", "Scope", "Tier", "Red", "Amber", "Notes"], "Includes verdict bands"),
          table("Extracted links", ["Link", "Score", "Worst link", "Allowlisted domain", "Signals"]),
          table("Attachment ledger", ["Filename", "Size", "Type", "SHA-256", "AV verdict", "Retention"]),
          cards("Passive intel", ["Bulwark Black IOC feed (local cache)", "OTX cache (passive indicator lookup)", "Known IPs registry"]),
          cards("Message body", ["Text body", "HTML body — source, never rendered"])
        ])
      ]
    },
    {
      path: "/logs", group: "Investigate", label: "Logs", displayTitle: "Security Logs", variant: "logs",
      queryBranches: [
        { id: "event-results", whenQuery: { q: { notContains: "| stats count" } } },
        { id: "statistics", whenQuery: { q: { contains: "| stats count" } } }
      ],
      panels: [logResults()]
    },
    {
      path: "/search", group: "Investigate", label: "Search", hidden: true, variant: "search-dispatch",
      queryBranches: [
        { id: "empty", whenQuery: { q: "absent" } },
        { id: "destination", whenQuery: { q: "present" } }
      ],
      panels: [searchDispatch()]
    },
    {
      path: "/activity", group: "Investigate", label: "Activity Learner", displayTitle: "Activity Baseline",
      panels: [
        form("Baseline go-live epoch", [field("Relearn label")], ["We’re live — restart baseline"]),
        info("Baseline maturity"),
        table("What is different — first seen today", ["Type", "Indicator", "Today", "Daily avg", "Status"]),
        table("Elevated — above their own baseline", ["Type", "Indicator", "Today", "Daily avg", "Status"]),
        table("Trending up — EWMA climbing", ["Type", "Indicator", "Today", "Daily avg", "Status"]),
        table("Long tail — rarest in 30 days", ["Type", "Indicator", "Today", "Daily avg", "Status"]),
        table("Normal — the regulars", ["Type", "Indicator", "Today", "Daily avg", "Status"]),
        info("How this works")
      ]
    },
    {
      path: "/ioc", group: "Investigate", label: "IOC Parser",
      panels: [
        {
          ...form("Paste anything — threat report, email, log dump", [field("Paste a threat advisory, suspicious email, or IOC list…", "textarea", { wide: true, lines: 22 })], ["Extract & hunt"]),
          meta: "defanged indicators (hxxp, [.]) handled"
        },
        table("Extracted indicators", ["Type", "Indicator", "Environment", "Intel"])
      ]
    },
    {
      path: "/intel", group: "Investigate", label: "Threat Intel", variant: "intel",
      queryBranches: [
        { id: "bb-lookup", whenQuery: { q: "present" } },
        { id: "bb-list", whenQuery: { list: ["ips", "domains", "all"] } },
        { id: "otx-lookup", whenQuery: { oq: "present" } }
      ],
      tabsets: [
        { param: "itab", default: "bb", items: [
          { id: "bb", label: "Bulwark Black feed", panels: [
            info("Bulwark Black threat intelligence"),
            metrics("Indicators", "Addresses", "Domains and URLs", "Checked", "Feed changed"),
            table("Estate addresses appearing in our own reporting", ["Address", "Type", "Named in"]),
            ...conditioned({ q: "present" }, [info("Lookup")]),
            ...conditioned({ list: ["ips", "domains", "all"] }, [
              form("Filter indicators", [field("Filter by value, type, or report title")], ["Filter", "Clear"], "bb-indicator-filter"),
              table("Indicators", ["Indicator", "Type", "Named in", ""], "", "bb-indicators")
            ]),
            form("Check an indicator", [field("IP, domain or URL — defanged forms are accepted")], ["Look up"]),
            info("What this is")
          ] },
          { id: "otx", label: "AlienVault OTX", panels: [
            info("AlienVault OTX"),
            form("Check an indicator against the synced pulses", [field("IP, domain, or SHA-256 — defanged forms are accepted")], ["Check"]),
            ...conditioned({ oq: "present" }, [info("OTX lookup")]),
            metrics("Pulses in window", "IPv4 indicators", "Domain indicators", "File hashes", "Last sync"),
            table("Outbound destinations, checked against OTX", ["Address", "Pulses"]),
            table("Recent pulses", ["Pulse", "Author", "Modified", "Net/all"]),
            form("OTX synchronization", [], ["Sync now"]),
            info("How OTX is used here")
          ] },
          { id: "threatfox", label: "ThreatFox", panels: [metrics("Indicators", "Last sync", "Sync period", "Window"), info("ThreatFox"), form("Search ThreatFox", [field("indicator, family or tag")], ["Search", "Clear"]), table("ThreatFox indicators", ["Indicator", "Kind", "Family", "Conf", "Tags", "First seen", "Last seen", "Also in", ""])] },
          { id: "urlhaus", label: "URLhaus", panels: [metrics("Indicators", "Last sync", "Sync period", "Window"), info("URLhaus"), form("Search URLhaus", [field("indicator, family or tag")], ["Search", "Clear"]), table("URLhaus indicators", ["Indicator", "Kind", "Family", "Conf", "Tags", "First seen", "Last seen", "Also in", ""])] },
          { id: "malwarebazaar", label: "MalwareBazaar", panels: [metrics("Indicators", "Last sync", "Sync period", "Window"), info("MalwareBazaar"), form("Search MalwareBazaar", [field("indicator, family or tag")], ["Search", "Clear"]), table("MalwareBazaar indicators", ["Indicator", "Kind", "Family", "Conf", "Tags", "First seen", "Last seen", "Also in", ""])] },
          { id: "feeds", label: "All feeds", panels: [metrics("Merged indicators", "Addresses", "Domains", "URLs", "File hashes", "Seen by 2+ sources", "Last rebuild", "Feed sync"), table("Sources", ["Source", "In index", "Unique to it", "Last fetched", "Window", "State", "Key"]), table("Estate addresses appearing in any feed", ["Address", "Sources", "Family", "Confidence"]), table("Top families across sources", ["Family", "Indicators", "Cited by"]), table("Newest merged indicators", ["Indicator", "Kind", "Sources", "Family", "Conf.", "Seen"]), info("What this is") ] }
        ]},
        { param: "skind", default: "all", when: { itab: ["threatfox", "urlhaus", "malwarebazaar"] }, items: [
          { id: "all", label: "All" }, { id: "ip", label: "IP" }, { id: "domain", label: "Domain" }, { id: "url", label: "URL" }, { id: "sha256", label: "SHA-256" }, { id: "md5", label: "MD5" }, { id: "sha1", label: "SHA-1" }
        ]}
      ]
    },
    {
      path: "/known-ips", group: "Investigate", label: "Known IPs",
      panels: [
        table("Operator egress — your ISP addresses, tracked automatically", ["IP", "Label", "Source", "Added", "Confirmed", ""]),
        table("Tailnet devices", ["IP", "Label", "Source", "Added", "Confirmed", ""]),
        table("Estate", ["IP", "Label", "Source", "Added", "Confirmed", ""]),
        table("Manual entries", ["IP", "Label", "Source", "Added", "Confirmed", ""]),
        form("Add a known IP", [field("IP address"), field("Label")], ["Add known IP"]),
        info("How detections use this")
      ]
    },
    {
      path: "/ip", group: "Investigate", label: "IP Investigation", hidden: true, variant: "ip-investigation",
      queryBranches: [
        { id: "no-address", whenQuery: { addr: "absent" } },
        { id: "address", whenQuery: { addr: "present" } }
      ],
      panels: [
        cards("Investigate address", ["Verdict", "Activity", "External lookups"]),
        { ...lookup("Shodan · what the internet knows about this address", ["Look up on Shodan", "Retry", "Refresh"], "shodan"),
          resultLabels: ["Organisation", "ASN", "Location", "Open ports", "Hostnames", "Tags", "CVEs (banner-inferred)", "Shodan last saw it"] },
        { ...lookup("AlienVault OTX · community reporting on this address", ["Look up on OTX", "Retry", "Refresh"], "alienvault-otx"),
          resultLabels: ["Pulse count", "Tags", "Pulse list", "Checked"] },
        table("Related detections", ["When", "Severity", "Finding"]),
        table("Log events", ["When", "Host", "Channel", "Event"])
      ]
    },
    {
      path: "/scans", group: "Vuln Mgmt", label: "Scans",
      tabsets: [{ param: "tab", default: "trivy", items: [
        {
          id: "trivy", label: "Trivy",
          connectionProfile: scanConnectionProfile(
            "scan-trivy", "Trivy scanner", "Operating-system package and vulnerability scan results.",
            ["trivy-operating-system-packages"],
            ["scan.result", "software.package", "vulnerability.finding"],
            ["asset.snapshot", "remediation.record"]
          ),
          panels: [table("Trivy — operating-system packages", ["Host", "Critical", "High", "Scanned", "State"])]
        },
        {
          id: "patch", label: "Patch first",
          connectionProfile: scanConnectionProfile(
            "scan-patch-first", "Patch-priority feed", "Package findings enriched for patch urgency, exploitation, and exposure.",
            ["patch-first"],
            ["software.package", "vulnerability.finding"],
            ["scan.result", "intel.indicator", "remediation.record"]
          ),
          panels: [table("Patch first", ["CVE", "Package", "Host", "CISA KEV", "EPSS"])]
        },
        {
          id: "fim", label: "File integrity",
          connectionProfile: scanConnectionProfile(
            "scan-file-integrity", "File-integrity collector", "Critical-file baselines, checks, and integrity changes.",
            ["file-integrity-critical-files-and-canaries"],
            ["file.integrity"],
            ["asset.snapshot", "source.heartbeat"]
          ),
          panels: [table("File integrity — critical files and canaries", ["Host", "Tracked", "Last check", "State"])]
        },
        {
          id: "eol", label: "End of life",
          connectionProfile: scanConnectionProfile(
            "scan-end-of-life", "End-of-life inventory", "Installed component versions and vendor support windows.",
            ["end-of-life-runway"],
            ["software.package"],
            ["asset.snapshot", "vulnerability.finding"]
          ),
          panels: [table("End-of-life runway", ["Component", "Version", "Latest patch", "Released", "Active support ends", "Security EOL", "Runway"])]
        },
        { id: "exposure", label: "External surface",
          connectionProfile: scanConnectionProfile(
            "scan-external-surface", "External-surface scanner", "Authorized public-address observations, sweep results, and exposed services.",
            ["external-attack-surface-shodan", "sweep-history"],
            ["asset.snapshot", "scan.result"],
            ["network.event", "vulnerability.finding", "source.heartbeat"]
          ),
          panels: [
          table("External attack surface · Shodan", ["Address", "Ports seen", "Baseline", "Verdict", "Network", "Banner CVEs", "Last swept", "Sweeps", ""]),
          form("Watch another public address", [field("IP address"), field("Which host"), field("Allowed ports")], ["Add address"]),
          table("Sweep history", ["When", "Host", "Address", "Result"])
        ] },
        {
          id: "ioc", label: "IOC scan",
          connectionProfile: scanConnectionProfile(
            "scan-ioc", "IOC scanner", "Host scan outcomes correlated with normalized threat indicators.",
            ["ioc-scan-is-anything-on-disk-a-known-bad-file"],
            ["finding", "scan.result"],
            ["asset.snapshot", "endpoint.event", "file.integrity", "intel.indicator"]
          ),
          panels: [table("IOC scan — is anything on disk a known-bad file", ["Host", "Processes", "Drop dirs", "Last scan", "Hashes", "YARA", "State"])]
        },
        { id: "urlscan", label: "urlscan.io",
          connectionProfile: scanConnectionProfile(
            "scan-urlscan", "URL scanning service", "Rendered-page scans and contacted-network observations.",
            ["our-pages-rendered-from-outside", "url-history-results"],
            ["network.event", "scan.result"],
            ["finding", "source.heartbeat"]
          ),
          panels: [
          table("Our pages, rendered from outside", ["Page", "Verdict", "Contacts", "Rendered", ""]),
          form("Watch a page daily", [field("URL")], ["Watch this page daily"]),
          form("Scan any URL", [field("URL")], ["Scan"], "urlscan-submit"),
          table("URL scan history", ["URL", "Verdict", "Contacted", "When", ""], "", "url-history-results")
        ] },
        {
          id: "deps", label: "Dependencies",
          connectionProfile: scanConnectionProfile(
            "scan-dependencies", "Dependency advisory feed", "Dependency inventory matched to normalized vulnerability advisories.",
            ["dependency-advisories"],
            ["software.package", "vulnerability.finding"],
            ["scan.result", "remediation.record"]
          ),
          panels: [info("Dependency advisories")]
        },
        { id: "av", label: "DLP Upload AV",
          connectionProfile: scanConnectionProfile(
            "scan-upload-av", "Upload antivirus", "Upload malware-scan state and bounded scan events.",
            ["upload-malware-scanning-clamav-at-the-door", "recent-scan-events"],
            ["endpoint.event", "finding"],
            ["asset.snapshot", "source.heartbeat"]
          ),
          panels: [
          table("Upload malware scanning — ClamAV at the door", ["Host", "Daemon", "Signatures", "Last 24h", "Last trail", "State"]),
          table("Recent scan events", ["When", "Host", "Event", "What"])
        ] },
        { id: "quarantine", label: "Quarantine",
          connectionProfile: scanConnectionProfile(
            "scan-quarantine", "Quarantine lifecycle", "Malware quarantine, retrieval, and removal lifecycle events.",
            ["quarantined-now", "deleted-from-quarantine"],
            ["endpoint.event", "finding"],
            ["audit.event", "remediation.record"]
          ),
          panels: [
          table("Quarantined now", ["Blocked", "Host", "File", "Signature", "Via", "Size", "Retrieve"]),
          table("Deleted from quarantine", ["Blocked", "Host", "File", "Signature", "Removed", "Reason"])
        ] },
        {
          id: "remediation", label: "Remediation log",
          connectionProfile: scanConnectionProfile(
            "scan-remediation", "Remediation records", "Verified remediation facts and their supporting evidence lifecycle.",
            ["vm-analyst-latest-review", "remediation-log"],
            ["remediation.record"],
            ["evidence.receipt", "governance.attestation"]
          ),
          panels: remediationPanels()
        }
      ]}]
    },
    {
      path: "/host-scan", group: "Vuln Mgmt", label: "Scan Detail", hidden: true, variant: "scan-detail",
      queryBranches: [{ id: "no-host", whenQuery: { host: "absent" } }, { id: "host", whenQuery: { host: "present" } }],
      panels: [info("Trivy scan"), table("Trivy findings", ["CVE", "Package", "Severity", "Exploited", "EPSS"])]
    },
    {
      path: "/kev", group: "Vuln Mgmt", label: "KEV Detail", hidden: true, variant: "kev-detail",
      queryBranches: [{ id: "no-cve", whenQuery: { cve: "absent" } }, { id: "cve", whenQuery: { cve: "present" } }],
      panels: [cards("Known Exploited Vulnerability detail", ["Product", "Catalog status", "Known ransomware use", "Why it is listed here", "References"])]
    },
    {
      path: "/remediation", group: "Vuln Mgmt", label: "Remediation",
      panels: remediationPanels()
    },
    {
      path: "/systems", group: "Estate", label: "Systems",
      tabsets: [{ param: "stab", default: "estate", items: [
        { id: "estate", label: "Estate", panels: [
          table("External attack surface — what the internet sees", ["Host", "Public IP", "Ports Shodan sees", "Baseline", "Verdict"]),
          table("Estate inventory", ["Host", "OS", "Kernel", "Packages", "Listening (public iface)", "Reported"]),
          table("Are we affected? — known-exploited vulnerabilities vs our software", ["CVE", "Product", "KEV added", "Status"]),
          info("What am I looking at?")
        ] },
        { id: "affected", label: "Are we affected?", panels: [
          info("Latest review"), info("Open items"), info("How this review works")
        ] }
      ]}]
    },
    {
      path: "/databases", group: "Estate", label: "Databases",
      panels: [
        table("Schema drift watch", ["Database", "Tables", "Tracked items", "Snapshot"]),
        table("Schema changes detected", ["When", "Database", "Changes"]),
        info("Adding a database"), info("How this works")
      ]
    },
    {
      path: "/backups", group: "Estate", label: "Backups",
      panels: [
        table("Push side — the backup chain reporting in", ["Chain", "What a green means", "Status", "State"]),
        table("Pull side — independent verification from the watchtower", ["Bucket", "Contents", "Freshness", "State"]),
        table("SOC evidence — off-box object-lock copy", ["Archive", "Receipts", "Last result", "State"]),
        info("Adding a backup chain"), info("Why two sides")
      ]
    },
    {
      path: "/retention", group: "Estate", label: "Retention",
      tabsets: [{ param: "vtab", default: "policy", items: [
        { id: "policy", label: "Policy · declared", panels: [
          facts("Declared policy", [
            "Searchable security log lines", "Console records", "Collection metadata",
            "Observation-window rationale", "Hot-window rationale", "SOC 2"
          ], "Policy declaration only"),
          info("Enforcement — the honest gap")
        ] },
        { id: "reality", label: "Reality · measured", panels: [
          metrics("Policy accrual", "Inventoried retention data", "Inventory / store age", "Disk free"),
          info("Measured horizon"),
          table("Per source", ["Host", "Channel", "Oldest held", "Newest", "Span", "Records", "Size", "Integrity"]),
          table("Archived baselines", ["Archive", "Archived on", "Size"])
        ] },
        { id: "review", label: "Review · analyst", panels: [info("Latest retention review"), info("How this review works")] }
      ]}]
    },
    {
      path: "/sources", group: "Estate", label: "Sources",
      tabsets: [{ param: "stab", default: "expected", items: [
        { id: "expected", label: "Expected sources", panels: [
          { ...table("Expected sources", ["Source", "Host", "Last collection", "Cadence", "In Logs", "Collection", "Activity"]),
            rowDisclosures: ["What it does", "Why it matters", "If it goes quiet"] }
        ] },
        { id: "add", label: "Add a source", panels: [
          workflow("1 · Connect the host", [
            field("App", "select", { id: "appId", required: true, optionsFrom: "apps" }),
            field("Host", "select", { id: "hostId", required: true, optionsFrom: "hosts" })
          ], [{ id: "host.enroll", label: "Mint token" }], ["Tokened host", "Connection", "Break-glass"], { id: "connect-host" }),
          workflow("2 · Declare what the host owes", [
            field("App", "select", { id: "appId", required: true, optionsFrom: "apps" }),
            field("Host", "select", { id: "hostId", optionsFrom: "hosts" }),
            field("Connector type", "select", { id: "connectorType", required: true, optionsFrom: "connectorTypes" }),
            field("Source kind", "select", { id: "sourceKind", required: true, optionsFrom: "sourceKinds" }),
            field("Display label", "text", { id: "displayName", required: true, maxLength: 120 }),
            field("Cadence (hours)", "number", { id: "cadenceHours", required: true, min: 0.1, max: 720, step: 0.05 })
          ], [{ id: "source.setup", label: "Begin source setup" }], ["Connector", "Mode", "Produces", "Populates"], { id: "declare-source", tableBefore: true }),
          table("Pending source setups", ["Source", "Connector", "Test", "State", "Actions"], "Setup → test → activate", "pending-source-setups"),
          table("Configured sources", ["Source", "Host", "Connector", "Produces", "Coverage", "State"], "Stable source identities", "configured-sources"),
          form("Scale-out shortcut · copy a host's source set", [field("Source host", "select"), field("New host")], ["Copy source set"])
        ] },
        { id: "changes", label: "Registry changes", panels: [table("Source registry changes", ["When", "Change", "Target", "Detail", "By"])] }
      ]}]
    },
    {
      path: "/source", group: "Estate", label: "Source Detail", hidden: true,
      panels: [
        facts("Source declaration", ["What it does", "Why it matters", "If it goes quiet", "State", "Activity", "How it is graded", "If the row is red"]),
        facts("Latest collection", ["Collection state", "Reader proof", "Inputs checked", "Activity", "Failure"]),
        sourceHistory()
      ]
    },
    {
      path: "/agents", group: "Estate", label: "Agent Management",
      variant: "administration-agents",
      searchTerms: "agents prompts enrollment credentials connection proof pause resume archive restore provider model capabilities",
      panels: [],
      tabsets: [{ param: "atab", default: "agents", items: [
        { id: "agents", label: "Agents", panels: [] },
        { id: "add", label: "Add Agent", panels: [] },
        { id: "prompts", label: "Prompts", panels: [] },
        { id: "enrollment", label: "Enrollment", panels: [] },
        { id: "audit", label: "History", panels: [] }
      ] }]
    },
    {
      path: "/attestations", group: "Govern", label: "Attestations",
      variant: "administration-attestations",
      searchTerms: "governance attestation evidence owner due status lifecycle archive restore remove",
      panels: [],
      tabsets: [{ param: "gtab", default: "active", items: [
        { id: "active", label: "Active", panels: [] },
        { id: "create", label: "Add Attestation", panels: [] },
        { id: "archived", label: "Archived", panels: [] },
        { id: "history", label: "History", panels: [] }
      ] }]
    },
    {
      path: "/attestation", group: "Govern", label: "Attestation Detail", hidden: true,
      variant: "administration-attestation", panels: []
    },
    {
      path: "/register", group: "Govern", label: "Risk Register",
      variant: "administration-risks",
      searchTerms: "risk register likelihood impact owner review status lifecycle archive restore remove",
      panels: [],
      tabsets: [{ param: "riskTab", default: "active", items: [
        { id: "active", label: "Active", panels: [] },
        { id: "create", label: "Add Risk", panels: [] },
        { id: "archived", label: "Archived", panels: [] },
        { id: "history", label: "History", panels: [] }
      ] }]
    },
    {
      path: "/risk", group: "Govern", label: "Risk Detail", hidden: true,
      variant: "administration-risk", panels: []
    },
    {
      path: "/access", group: "Govern", label: "Access",
      queryBranches: [{ id: "offboarding-detail", whenQuery: { atab: "offboarding", id: "present" } }],
      tabsets: [
        { param: "atab", default: "who", items: [
          { id: "who", label: "Who", panels: [
            info("You, right now"),
            table("Who has full access", ["Identity", "Level", "Can do"]),
            table("Everyone who has opened this console", ["Identity", "Level", "From", "Views", "Refused writes", "Last seen"]),
            info("How identity works here"),
            table("Devices on the tailnet", ["Device", "Tailnet IP", "Tags", "State"]),
            info("Giving an auditor access")
          ] },
          { id: "refusals", label: "Refusals", panels: [table("Refused writes", ["When", "Identity", "Route attempted", "From"]), info("What a refusal is")] },
          { id: "chain", label: "Chain", panels: [table("Evidence integrity", ["Log", "Records", "Chain", "State"]), info("How identity works here")] },
          { id: "offboarding", label: "Offboarding" }
        ]},
        { param: "oview", default: "records", when: { atab: "offboarding" }, items: [
          { id: "records", label: "Records", panels: [
            ...conditioned({ id: "absent" }, [
              metrics("Offboarding records", "Apply / enumerate", "Identities offboarded", "Manual steps open", "Median surfaces / record", "Last run"),
              table("Offboarding records", ["Run", "By", "Mode", "Identity", "Surfaces", "Manual", "Reason", ""]),
              info("What this board is")
            ]),
            ...conditioned({ id: "present" }, [
              facts("Offboarding summary", ["Run at", "Identity", "Reason", "Surfaces", "Within 24h", "Tool"]),
              info("Manual steps"),
              table("Per-surface breakdown", ["Surface", "Class", "Counts", "Items"]),
              table("Per-surface item detail", ["Surface", "Ref", "Action", "Note / instruction"])
            ])
          ] },
          { id: "guide", label: "How to use", panels: [info("How to use offboard.sh")] }
        ]}
      ]
    },
    {
      path: "/onboard", group: "Configure", label: "Onboarding", displayTitle: "Onboard an App", hidden: true,
      panels: [
        form("1 · Register the app", [
          field("App name", "text", { id: "appName", required: true, maxLength: 40 }),
          field("Hosts, comma-separated", "text", { id: "hosts", required: true, maxLength: 200 }),
          field("Public pages (optional, comma-separated URLs)", "text", { id: "publicPages", maxLength: 300 })
        ], [{ id: "app.register", label: "Register app" }], "register-app"),
        table("Registered apps", ["App", "Host", "Enrollment", "Connection", ""], "Application registry", "registered-apps"),
        info("2 · Connect each host", "connect-each-host")
      ]
    },
    {
      path: "/settings", group: "Configure", label: "Settings", hidden: true,
      panels: [
        info("How settings behave"),
        settings("Overview", [field("Recent detections shown", "number"), field("Needs-review window (hours)", "number")]),
        settings("SOC Health", [
          field("Analyst run stalled after (hours)", "number"), field("Backlog turns amber after (hours)", "number"),
          field("Noise concentration warning (%)", "number"), field("Repeat-group warning (%)", "number")
        ]),
        settings("Daily Brief", []),
        settings("Analytics", [field("Default time range", "select")]),
        settings("Analyst", [field("Case-analyst log window (± minutes)", "number")]),
        settings("Triage", [field("Default owner")]),
        settings("Rules", [field("Failed-SSH burst threshold", "number")]),
        settings("Alert Comms", [
          field("Critical repeat cooldown (minutes)", "number"), field("High repeat cooldown (minutes)", "number"),
          field("High batch window (minutes)", "number"), field("Hourly send cap", "number")
        ]),
        settings("Honeypots", []),
        settings("Logs", [field("Rows shown", "number")]),
        settings("Activity", []),
        settings("IOC Parser", []),
        settings("Threat Intel", [
          field("Bulwark Black feed poll (minutes)", "number"), field("OTX sync (hours)", "number"),
          field("OTX pulse window (days)", "number"), field("OTX max pages per sync", "number"),
          field("abuse.ch poll (minutes)", "number"), field("ThreatFox window (days)", "number"),
          field("MalwareBazaar window (days)", "number"), field("Intel repeat suppression (hours)", "number")
        ]),
        settings("Known IPs", []),
        settings("Systems", []),
        settings("Scans", []),
        settings("Databases", []),
        settings("Backups", []),
        settings("Retention", []),
        settings("Sources", [field("Staleness multiplier", "number")]),
        settings("Attestations", []),
        settings("Risk Register", []),
        settings("Access", [])
      ]
    },
    {
      path: "/docs", group: "Configure", label: "Technical Docs",
      displayTitle: "Technical Documentation", hidden: true, localOnly: true,
      variant: "technical-documentation",
      searchTerms: "agent connector manifest app register host enroll connection proof source setup test activate ingest canonical records projector health credentials authentication Better Auth MCP production troubleshooting",
      panels: []
    },
    {
      path: "/event", group: "Respond", label: "Event Detail", hidden: true, variant: "event",
      panels: [
        cards("Decision status", ["Status", "Severity", "Owner", "Activity", "Tune"]),
        table("Findings in this decision", ["Severity", "Detector", "Finding", "Action"]),
        facts("Finding context", ["Why this fired", "Rule background", "What to check", "Pivot to search", "URL / domain context"]),
        table("Evidence", ["Field", "Value"], "", "event-evidence"),
        info("Analyst findings"),
        table("Associated logs ± 15 min", ["When", "Log line"]),
        info("Proposed disposition"),
        form("Case notes", [field("Note", "textarea", { wide: true })], ["Add note"]),
        form("Evidence", [field("Files", "file", { accept: ".pdf,.docx,.xlsx,.txt,.csv,.png,.jpg,.jpeg,.json,.zip,.eml,.pcap" })], ["Attach selected"]),
        table("Related detections in this case", ["Case", "When", "Severity", "Finding"]),
        table("Other recent detections on this host", ["Case", "When", "Severity", "Rule", "Event"])
      ]
    }
  ];

  function deepFreeze(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    Reflect.ownKeys(value).forEach((key) => deepFreeze(value[key]));
    return Object.freeze(value);
  }

  global.SocConsoleUiCatalog = deepFreeze({ schemaVersion: "1", groups, pages });
}(window));
