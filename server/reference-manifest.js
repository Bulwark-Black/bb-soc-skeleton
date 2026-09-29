"use strict";

// Manifests are declarative data, never executable connector modules. The
// reference server enables canonical-push; the private application additionally
// enables the bundled trivy-report importer. The eleven *-template scan entries
// still require adopter-reviewed drivers. Nothing here resolves credential
// references, follows target URLs, executes scans, or makes vendor requests.

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Reflect.ownKeys(value).forEach((key) => deepFreeze(value[key]));
  return Object.freeze(value);
}

function cadenceField(description = "Expected seconds between successful observations.") {
  return {
    key: "cadence-seconds",
    label: "Expected collection cadence",
    valueType: "duration-seconds",
    required: true,
    minimum: 60,
    maximum: 31536000,
    description
  };
}

function enumField(key, label, values, description, required = true) {
  return {
    key,
    label,
    valueType: "enum",
    required,
    options: values.map(([value, optionLabel]) => ({ value, label: optionLabel })),
    description
  };
}

function configField(key, label, valueType, description, options = {}) {
  return { key, label, valueType, required: options.required !== false, description, ...options };
}

function credentialSlot(key, label, kind, description, required = false) {
  return { key, label, kind, required, description };
}

function scanManifest(specification) {
  const recordKinds = [...specification.requiredRecordKinds, ...(specification.recommendedRecordKinds || [])];
  return deepFreeze({
    schemaVersion: "1",
    documentType: "connector-manifest",
    connectorType: specification.connectorType,
    connectorVersion: "1.0.0",
    displayName: specification.displayName,
    description: `${specification.description} Data-only setup template; install an adopter-reviewed server driver before testing or activation.`,
    // A host is the enrolled collector/runner identity. Service APIs may still
    // be reached only by the adopter's server-side driver from that runner.
    scope: "host",
    supportedSourceKinds: [specification.sourceKind],
    payload: {
      schemaId: "soc.canonical-records",
      schemaVersion: "1",
      recordKinds,
      lines: "forbidden",
      content: "optional"
    },
    targets: [{
      route: "/scans",
      surfaces: specification.surfaces,
      recordKinds
    }],
    configFields: [cadenceField(specification.cadenceDescription), ...specification.configFields],
    credentialSlots: specification.credentialSlots,
    healthPolicy: {
      deliveryMode: specification.deliveryMode || "poll",
      expectedIntervalSeconds: specification.expectedIntervalSeconds || 3600,
      staleAfterSeconds: specification.staleAfterSeconds || 7200,
      offlineAfterSeconds: specification.offlineAfterSeconds || 14400,
      emptyPayloadIsHealthy: specification.emptyPayloadIsHealthy === true
    }
  });
}

const REFERENCE_CONNECTOR_MANIFEST = deepFreeze({
  schemaVersion: "1",
  documentType: "connector-manifest",
  connectorType: "canonical-push",
  connectorVersion: "1.0.0",
  displayName: "Canonical log push",
  description: "Application-scoped admission for normalized log.event batches. A collector host is optional.",
  scope: "application",
  supportedSourceKinds: ["log.event"],
  payload: {
    schemaId: "normalized-record.log-event",
    schemaVersion: "1",
    recordKinds: ["log.event"],
    lines: "forbidden",
    content: "required"
  },
  targets: [
    { route: "/", surfaces: ["summary-metrics", "detections"], recordKinds: ["log.event"] },
    { route: "/sources", surfaces: ["expected-sources"], recordKinds: ["log.event"] },
    { route: "/logs", surfaces: ["log-results"], recordKinds: ["log.event"] },
    { route: "/analytics", surfaces: ["summary-metrics", "events-collected-per-hour"], recordKinds: ["log.event"] },
    { route: "/health", surfaces: ["summary-metrics", "is-the-collection-working"], recordKinds: ["log.event"] }
  ],
  configFields: [cadenceField("Expected seconds between successful pushes (60 through 31,536,000).")],
  credentialSlots: [],
  healthPolicy: {
    deliveryMode: "push",
    expectedIntervalSeconds: 300,
    staleAfterSeconds: 450,
    offlineAfterSeconds: 900,
    emptyPayloadIsHealthy: false
  }
});

const TRIVY_REPORT_MANIFEST = deepFreeze({
  schemaVersion: "1", documentType: "connector-manifest", connectorType: "trivy-report", connectorVersion: "1.0.0",
  displayName: "Trivy JSON report import",
  description: "Installed bounded importer for existing Trivy SchemaVersion 2 vulnerability reports. Never runs Trivy, fetches a target, or stores embedded secrets. Application scoped; optional collector host.",
  scope: "application", supportedSourceKinds: ["trivy.scan"],
  payload: { schemaId: "soc.canonical-records", schemaVersion: "1",
    recordKinds: ["scan.result", "software.package", "vulnerability.finding"], lines: "forbidden", content: "required" },
  targets: [{ route: "/scans", surfaces: ["trivy-operating-system-packages"],
    recordKinds: ["scan.result", "software.package", "vulnerability.finding"] }],
  configFields: [cadenceField("Expected seconds between report imports. Uploading a report is not a scheduled scan.")],
  credentialSlots: [],
  healthPolicy: { deliveryMode: "push", expectedIntervalSeconds: 86400, staleAfterSeconds: 129600,
    offlineAfterSeconds: 259200, emptyPayloadIsHealthy: false }
});

const REFERENCE_SCAN_CONNECTOR_MANIFESTS = deepFreeze([
  scanManifest({
    connectorType: "trivy-template",
    displayName: "Trivy connection template",
    description: "Declares Trivy package, vulnerability, and scan-result normalization.",
    sourceKind: "trivy.scan",
    surfaces: ["trivy-operating-system-packages"],
    requiredRecordKinds: ["scan.result", "software.package", "vulnerability.finding"],
    recommendedRecordKinds: ["asset.snapshot", "remediation.record"],
    configFields: [
      enumField("collection-mode", "Collection mode", [
        ["local-json", "Signed local JSON report"], ["filesystem", "Filesystem scan"],
        ["container-image", "Container image scan"], ["sbom", "SBOM import"]
      ], "How the adopter driver obtains Trivy output."),
      configField("scan-target", "Authorized scan target", "string", "Allowlisted image, filesystem, repository, or SBOM identity; never a shell expression."),
      configField("scanner-endpoint", "Private scanner adapter endpoint", "endpoint-url", "Optional private HTTP(S) adapter endpoint without credentials, query, or fragment.", { required: false }),
      enumField("severity-threshold", "Severity threshold", [
        ["all", "All severities"], ["low", "Low and above"], ["medium", "Medium and above"],
        ["high", "High and above"], ["critical", "Critical only"]
      ], "Minimum normalized severity retained by the driver.")
    ],
    credentialSlots: [
      credentialSlot("registry-access", "Private registry access", "bearer-token", "Opaque reference for private image or artifact registry access."),
      credentialSlot("scanner-access", "Private scanner adapter access", "bearer-token", "Opaque reference used by an optional private scanner adapter.")
    ]
  }),
  scanManifest({
    connectorType: "patch-first-template",
    displayName: "Patch First connection template",
    description: "Declares patch-priority package and vulnerability enrichment.",
    sourceKind: "patch-first.feed",
    surfaces: ["patch-first"],
    requiredRecordKinds: ["software.package", "vulnerability.finding"],
    recommendedRecordKinds: ["scan.result", "intel.indicator", "remediation.record"],
    configFields: [
      configField("provider-endpoint", "Patch feed endpoint", "endpoint-url", "Private or approved HTTPS API endpoint without embedded credentials."),
      configField("platform-scope", "Platform scope", "string", "Comma-separated allowlisted operating-system or package ecosystems."),
      enumField("prioritization-mode", "Prioritization mode", [
        ["exposure-first", "Exposure first"], ["exploit-first", "Known exploitation first"],
        ["severity-first", "Severity first"], ["policy", "Organization policy"]
      ], "Server-side rule used to order normalized patch candidates."),
      configField("grace-period-seconds", "Patch grace period", "duration-seconds", "Time after a fix becomes available before it is overdue.", { minimum: 60, maximum: 31536000 })
    ],
    credentialSlots: [
      credentialSlot("provider-access", "Patch feed API access", "api-key", "Opaque reference to the reviewed patch-provider API credential.", true)
    ]
  }),
  scanManifest({
    connectorType: "file-integrity-template",
    displayName: "File Integrity connection template",
    description: "Declares critical-file baselines and integrity-change events.",
    sourceKind: "file-integrity.event",
    surfaces: ["file-integrity-critical-files-and-canaries"],
    requiredRecordKinds: ["file.integrity"],
    recommendedRecordKinds: ["asset.snapshot", "source.heartbeat"],
    deliveryMode: "push",
    expectedIntervalSeconds: 300,
    staleAfterSeconds: 600,
    offlineAfterSeconds: 1800,
    configFields: [
      configField("path-scope", "Tracked path scope", "string", "Comma-separated allowlisted absolute paths or adopter-defined path-set IDs."),
      configField("exclusion-patterns", "Exclusion patterns", "string", "Bounded comma-separated path patterns evaluated by the server driver.", { required: false }),
      enumField("digest-algorithm", "Digest algorithm", [["sha256", "SHA-256"], ["sha512", "SHA-512"]], "Digest required for new baselines and change events."),
      enumField("baseline-policy", "Baseline policy", [["approved", "Approved baseline only"], ["observe", "Observe before approval"]], "Whether a new baseline requires separate approval.")
    ],
    credentialSlots: [
      credentialSlot("collector-access", "Integrity collector access", "bearer-token", "Opaque reference for an authenticated host collector or private adapter.")
    ]
  }),
  scanManifest({
    connectorType: "end-of-life-template",
    displayName: "End of Life connection template",
    description: "Declares component lifecycle dates joined to installed inventory.",
    sourceKind: "end-of-life.inventory",
    surfaces: ["end-of-life-runway"],
    requiredRecordKinds: ["software.package"],
    recommendedRecordKinds: ["asset.snapshot", "vulnerability.finding"],
    emptyPayloadIsHealthy: true,
    configFields: [
      configField("catalog-endpoint", "Lifecycle catalog endpoint", "endpoint-url", "Approved lifecycle dataset or private catalog endpoint."),
      configField("product-scope", "Product scope", "string", "Comma-separated publisher/product mappings evaluated by the driver."),
      configField("warning-horizon-seconds", "Warning horizon", "duration-seconds", "How far before support end a component enters the runway.", { minimum: 86400, maximum: 31536000 })
    ],
    credentialSlots: [
      credentialSlot("catalog-access", "Lifecycle catalog access", "api-key", "Opaque reference for a commercial or private lifecycle catalog when required.")
    ]
  }),
  scanManifest({
    connectorType: "external-surface-template",
    displayName: "External Surface connection template",
    description: "Declares authorized outside-in address, service, and sweep observations.",
    sourceKind: "external-surface.scan",
    surfaces: ["external-attack-surface-shodan", "sweep-history"],
    requiredRecordKinds: ["asset.snapshot", "scan.result"],
    recommendedRecordKinds: ["network.event", "vulnerability.finding", "source.heartbeat"],
    configFields: [
      configField("scanner-endpoint", "External scanner endpoint", "endpoint-url", "Approved scanner or private broker endpoint without credential material."),
      configField("target-cidrs", "Authorized target addresses", "string", "Comma-separated public addresses or CIDRs proven to be in scope."),
      configField("allowed-ports", "Allowed ports", "string", "Comma-separated ports or ranges approved for the scan."),
      enumField("scan-profile", "Scan profile", [
        ["passive", "Passive provider observations"], ["balanced", "Balanced authorized sweep"],
        ["active-authorized", "Active scan with explicit authorization"]
      ], "Driver-side scan intensity and authorization profile.")
    ],
    credentialSlots: [
      credentialSlot("provider-access", "External scanner API access", "api-key", "Opaque reference to the approved scanner or broker API credential.", true)
    ]
  }),
  scanManifest({
    connectorType: "ioc-scan-template",
    displayName: "IOC Scan connection template",
    description: "Declares bounded host scans correlated with normalized threat indicators.",
    sourceKind: "ioc.scan",
    surfaces: ["ioc-scan-is-anything-on-disk-a-known-bad-file"],
    requiredRecordKinds: ["finding", "scan.result"],
    recommendedRecordKinds: ["asset.snapshot", "endpoint.event", "file.integrity", "intel.indicator"],
    configFields: [
      configField("indicator-endpoint", "Indicator feed endpoint", "endpoint-url", "Approved pinned indicator feed or private broker endpoint."),
      configField("scan-paths", "Authorized scan paths", "string", "Comma-separated host path-set IDs; never a shell expression."),
      configField("match-kinds", "Indicator kinds", "string", "Comma-separated allowlisted kinds such as sha256 or yara."),
      configField("ruleset-label", "Pinned ruleset label", "string", "Immutable or versioned ruleset identity used for the scan.")
    ],
    credentialSlots: [
      credentialSlot("feed-access", "Indicator feed access", "bearer-token", "Opaque reference for a private or commercial threat-intelligence feed.")
    ]
  }),
  scanManifest({
    connectorType: "urlscan-template",
    displayName: "urlscan.io connection template",
    description: "Declares watched and on-demand URL submission/result normalization.",
    sourceKind: "urlscan.result",
    surfaces: ["our-pages-rendered-from-outside", "url-history-results"],
    requiredRecordKinds: ["network.event", "scan.result"],
    recommendedRecordKinds: ["finding", "source.heartbeat"],
    configFields: [
      configField("api-endpoint", "urlscan.io API endpoint", "endpoint-url", "Approved API endpoint without credential, query, or fragment."),
      configField("url-scope", "Authorized URL scope", "string", "Comma-separated exact origins or adopter-managed watch-list identifier."),
      enumField("submission-visibility", "Submission visibility", [
        ["private", "Private"], ["unlisted", "Unlisted"], ["public", "Public (policy approval required)"]
      ], "Visibility sent by the server driver; private is recommended for internal pages."),
      enumField("watch-mode", "Watch mode", [["scheduled", "Scheduled watch"], ["on-demand", "On demand"], ["both", "Scheduled and on demand"]], "Allowed job modes for this source.")
    ],
    credentialSlots: [
      credentialSlot("api-access", "urlscan.io API key", "api-key", "Opaque server-side reference to the urlscan.io API key.", true)
    ]
  }),
  scanManifest({
    connectorType: "dependency-template",
    displayName: "Dependencies connection template",
    description: "Declares dependency inventories matched to vulnerability advisories.",
    sourceKind: "dependency.inventory",
    surfaces: ["dependency-advisories"],
    requiredRecordKinds: ["software.package", "vulnerability.finding"],
    recommendedRecordKinds: ["scan.result", "remediation.record"],
    configFields: [
      configField("inventory-source", "Inventory source", "string", "Signed SBOM, lockfile, build artifact, or repository identity; lifecycle scripts are never run."),
      configField("ecosystem-scope", "Ecosystem scope", "string", "Comma-separated allowlisted ecosystems such as npm, pypi, maven, or go."),
      configField("advisory-endpoint", "Advisory endpoint", "endpoint-url", "Optional approved advisory broker endpoint.", { required: false }),
      enumField("import-format", "Import format", [
        ["cyclonedx", "CycloneDX"], ["spdx", "SPDX"], ["lockfile", "Lockfile"],
        ["package-list", "Normalized package list"]
      ], "Format the adopter driver validates before normalization.")
    ],
    credentialSlots: [
      credentialSlot("source-access", "Repository or registry access", "oauth-client", "Opaque reference for a private repository or registry."),
      credentialSlot("advisory-access", "Advisory service access", "api-key", "Opaque reference for a private advisory service.")
    ]
  }),
  scanManifest({
    connectorType: "upload-av-template",
    displayName: "DLP / ClamAV connection template",
    description: "Declares bounded upload antivirus status and detection events.",
    sourceKind: "upload-av.event",
    surfaces: ["upload-malware-scanning-clamav-at-the-door", "recent-scan-events"],
    requiredRecordKinds: ["endpoint.event", "finding"],
    recommendedRecordKinds: ["asset.snapshot", "source.heartbeat"],
    deliveryMode: "push",
    expectedIntervalSeconds: 300,
    staleAfterSeconds: 600,
    offlineAfterSeconds: 1800,
    configFields: [
      configField("scanner-address", "Private scanner address", "string", "Allowlisted clamd socket/TCP address or private AV-broker identity."),
      configField("upload-scope", "Protected upload scope", "string", "Comma-separated application/upload policy identifiers."),
      configField("maximum-object-bytes", "Maximum object bytes", "integer", "Hard byte limit enforced before scanning.", { minimum: 1, maximum: 1073741824 }),
      enumField("detection-action", "Detection action", [["block", "Block"], ["quarantine", "Quarantine"], ["report", "Report only"]], "Server-side outcome for a positive scan.")
    ],
    credentialSlots: [
      credentialSlot("scanner-access", "AV broker access", "bearer-token", "Opaque reference used only when the private AV broker requires authentication.")
    ]
  }),
  scanManifest({
    connectorType: "quarantine-template",
    displayName: "Quarantine connection template",
    description: "Declares protected quarantine and deletion lifecycle events.",
    sourceKind: "quarantine.event",
    surfaces: ["quarantined-now", "deleted-from-quarantine"],
    requiredRecordKinds: ["endpoint.event", "finding"],
    recommendedRecordKinds: ["audit.event", "remediation.record"],
    deliveryMode: "push",
    expectedIntervalSeconds: 300,
    staleAfterSeconds: 600,
    offlineAfterSeconds: 1800,
    configFields: [
      configField("store-endpoint", "Private quarantine store endpoint", "endpoint-url", "Protected object/evidence service endpoint without embedded credentials."),
      configField("namespace", "Quarantine namespace", "string", "Bounded tenant or application namespace in the protected store."),
      configField("retention-seconds", "Quarantine retention", "duration-seconds", "Retention before a separately authorized disposition is allowed.", { minimum: 3600, maximum: 31536000 }),
      enumField("retrieval-policy", "Retrieval policy", [
        ["approval-required", "Human approval required"], ["admin-only", "Administrators only"], ["disabled", "Retrieval disabled"]
      ], "Policy enforced by the adopter driver, never by a table button alone.")
    ],
    credentialSlots: [
      credentialSlot("store-access", "Quarantine store access", "service-account", "Opaque reference for least-privilege protected-store access.", true),
      credentialSlot("encryption-access", "Encryption service access", "custom", "Opaque reference for the approved encryption/KMS workload identity.")
    ]
  }),
  scanManifest({
    connectorType: "remediation-template",
    displayName: "Remediation connection template",
    description: "Declares verified remediation records and supporting evidence references.",
    sourceKind: "remediation.record",
    surfaces: ["vm-analyst-latest-review", "remediation-log"],
    requiredRecordKinds: ["remediation.record"],
    recommendedRecordKinds: ["evidence.receipt", "governance.attestation"],
    deliveryMode: "push",
    expectedIntervalSeconds: 300,
    staleAfterSeconds: 900,
    offlineAfterSeconds: 3600,
    configFields: [
      configField("workflow-endpoint", "Remediation workflow endpoint", "endpoint-url", "Private ticket/workflow broker endpoint without embedded credentials."),
      configField("project-scope", "Project or queue scope", "string", "Allowlisted workflow project, queue, or tenant identifier."),
      enumField("synchronization-mode", "Synchronization mode", [
        ["import", "Import workflow state"], ["export", "Export approved records"], ["bidirectional", "Bidirectional with conflict policy"]
      ], "Direction implemented by the reviewed driver."),
      enumField("verification-policy", "Verification policy", [
        ["evidence-required", "Evidence required to close"], ["review-required", "Human review required"], ["external-authority", "External workflow is authoritative"]
      ], "Closure rule evaluated before projecting a fixed state.")
    ],
    credentialSlots: [
      credentialSlot("workflow-access", "Workflow service access", "oauth-client", "Opaque OAuth client or workload-identity reference.", true),
      credentialSlot("evidence-store-access", "Evidence store access", "service-account", "Opaque least-privilege evidence-store reference.")
    ]
  })
]);

const REFERENCE_CONNECTOR_MANIFESTS = deepFreeze([
  REFERENCE_CONNECTOR_MANIFEST,
  TRIVY_REPORT_MANIFEST,
  ...REFERENCE_SCAN_CONNECTOR_MANIFESTS
]);

function getReferenceManifest(connectorType) {
  return REFERENCE_CONNECTOR_MANIFESTS.find((manifest) => manifest.connectorType === connectorType) || null;
}

function scaledHealthThresholds(connectorType, cadenceSeconds) {
  const manifest = getReferenceManifest(connectorType);
  if (!manifest) throw new TypeError("Reference connector type is unavailable.");
  if (!Number.isSafeInteger(cadenceSeconds) || cadenceSeconds < 1 || cadenceSeconds > 31_536_000) {
    throw new TypeError("Reference source cadence must be a positive bounded integer.");
  }
  const policy = manifest.healthPolicy;
  const expected = policy.expectedIntervalSeconds;
  return Object.freeze({
    staleAfterSeconds: Math.ceil(cadenceSeconds * policy.staleAfterSeconds / expected),
    offlineAfterSeconds: Math.ceil(cadenceSeconds * policy.offlineAfterSeconds / expected)
  });
}

module.exports = {
  TRIVY_REPORT_MANIFEST,
  REFERENCE_CONNECTOR_MANIFEST,
  REFERENCE_CONNECTOR_MANIFESTS,
  REFERENCE_SCAN_CONNECTOR_MANIFESTS,
  getReferenceManifest,
  scaledHealthThresholds
};
