#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

// This remains a positive manifest: a file is not publishable merely because it
// happens to live in the repository. New publication surfaces must be reviewed
// and added here deliberately.
const requiredTextFiles = new Set([
  "docs/NATIVE-TRIAGE.md",
  "server/triage-service.js",
  "public/triage.js",
  "public/triage.css",
  "test/triage-service.test.js",
  "test/triage-http.test.js",
  "test/triage-ui.test.js",
  "test/navigation.test.js",
  "deploy/Dockerfile",
  "deploy/integration-pack.schema.json",
  "docs/DEPLOYMENT-AUTOMATION.md",
  "docs/PROTOCOL-GATEWAYS.md",
  "docs/REVIEWED-RULE-PACKS.md",
  "docs/PLATFORM-COLLECTORS.md",
  "server/detection-packs.js",
  "server/finding-notifications.js",
  "server/native-monitor/smtp-transport.js",
  "test/deployment-generation.test.js",
  "test/detection-packs.test.js",
  "test/finding-notifications.test.js",
  "test/native-smtp.test.js",
  "test/platform-collectors.test.js",
  "test/platform-gateway.test.js",
  "tools/deployment/manifest.js",
  "tools/deployment/render.js",
  "tools/deployment/stage-private.js",
  "tools/deployment/worker.js",
  "tools/detection-pack.js",
  "tools/generate-deployment.js",
  "tools/platform-collectors/aws.js",
  "tools/platform-collectors/cli.js",
  "tools/platform-collectors/common.js",
  "tools/platform-collectors/engine.js",
  "tools/platform-collectors/http.js",
  "tools/platform-collectors/providers.js",
  "tools/platform-gateway.js",
  "tools/receive-platform.js",
  "tools/vendors/bridges.js",

  "docs/DETECTION-RULES.md",
  "docs/NATIVE-NOTIFICATIONS.md",
  "docs/PLATFORM-COVERAGE.md",
  "docs/PLATFORM-INGEST.md",
  "docs/WINDOWS-EVENTS.md",
  "server/detection-engine.js",
  "server/detection-rules.js",
  "server/platform-ingest.js",
  "server/native-monitor/notifications.js",
  "test/detection-engine.test.js",
  "test/native-notifications.test.js",
  "test/private-native-notifications.test.js",
  "test/platform-adapters.test.js",
  "test/platform-ingest.test.js",
  "test/windows-collector-test.py",
  "test/windows-events.test.js",
  "tools/collect-windows-events.py",
  "tools/vendors/windows.js",
  "tools/vendors/platforms.js",

  "docs/NATIVE-OPERATIONS.md",
  "public/operations.js",
  "public/operations.css",
  "server/operations-service.js",
  "server/native-monitor/employee-inbox.js",
  "server/native-monitor/history.js",
  "server/native-monitor/operations-runtime.js",
  "server/native-monitor/operations.js",
  "server/native-monitor/registry.js",
  "server/native-monitor/response.js",
  "server/native-monitor/store.js",
  "server/native-monitor/websites.js",
  "test/native-monitor-core.test.js",
  "test/native-operations.test.js",
  "test/native-websites.test.js",
  "test/private-operations.test.js",
  "test/operations-ui.test.js",
  "test/native-monitor-agent.py",
  "test/native-monitor-agent.test.js",
  "test/native-operations-sender.test.js",
  "test/native-website-probe.test.js",
  "tools/native-monitor/collector.py",
  "tools/native-monitor/send-operation.py",
  "tools/native-monitor/website-probe.py",

  ".github/workflows/ci.yml",
  ".gitignore",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "contracts/connector-manifest.v1.schema.json",
  "contracts/administration.v1.schema.json",
  "contracts/ingest-batch.v1.schema.json",
  "contracts/normalized-record.v1.schema.json",
  "contracts/page-model.v1.schema.json",
  "contracts/source-registration.v1.schema.json",
  "docs/ADAPTER-CONTRACT.md",
  "docs/ADOPTION.md",
  "docs/ARCHITECTURE.md",
  "docs/AUTHENTICATION.md",
  "docs/CONFIGURATION.md",
  "docs/CONNECTORS.md",
  "docs/DESIGN-SYSTEM.md",
  "docs/FEATURES.md",
  "docs/AGENTS.md",
  "docs/INTEGRATION-REVIEW.md",
  "docs/VENDOR-INTEGRATIONS.md",
  "docs/LIVE-MONITORING.md",
  "docs/GUIDED-SETUP.md",
  "docs/AI-SETUP.md",
  "docs/SERVER-LOGS.md",
  "public/server-logs.js",
  "tools/log-collection-contract.js",
  "tools/log-collector.js",
  "tools/collect-logs.js",
  "tools/events-cli.js",
  "test/server-log-health.test.js",
  "test/log-collector.test.js",
  "test/events-cli.test.js",
  "test/private-server-logs.test.js",
  "server/live-monitoring.js",
  "server/live-monitoring-transport.js",
  "public/live-monitoring.js",
  "test/live-monitoring.test.js",
  "test/live-monitoring-transport.test.js",
  "test/live-source-runtime.test.js",
  "test/live-monitoring-ui.test.js",
  "test/private-live-monitoring.test.js",
  "server/setup-guides.js",
  "public/setup-guides.js",
  "test/setup-guides.test.js",
  "test/setup-guides-ui.test.js",
  "test/private-setup-guides.test.js",
  "test/setup-agent.test.js",
  "server/source-mapping.js",
  "public/source-mapping.js",
  "tools/map-events.js",
  "test/source-mapping.test.js",
  "test/source-mapping-ui.test.js",
  "test/map-events.test.js",
  "server/document-bindings.js",
  "test/document-bindings.test.js",
  "test/document-library-ui.test.js",
  "test/agent-connection-ui.test.js",
  "server/setup-assistance.js",
  "public/setup-assistance.js",
  "test/setup-assistance.test.js",
  "test/setup-assistance-ui.test.js",
  "examples/better-auth-reference/README.md",
  "examples/better-auth-reference/better-auth-bridge.js",
  "examples/keycloak-reference/README.md",
  "examples/keycloak-reference/keycloak-client.template.json",
  "examples/keycloak-reference/relying-party-boundary.template.json",
  "examples/provider-template.js",
  "package.json",
  "package-lock.json",
  "public/sign-in.html",
  "public/private-sign-in.js",
  "public/document-library.js",
  "public/service-access.js",
  "public/integration-center.js",
  "public/vendor-import.js",
  "server/vendor-import.js",
  "tools/vendor-adapters.js",
  "tools/vendor-cli.js",
  "tools/integration-outbox.js",
  "tools/vendors/cloud.js",
  "tools/vendors/identity.js",
  "tools/vendors/devops.js",
  "test/vendor-cloud.test.js",
  "test/vendor-identity.test.js",
  "test/vendor-devops.test.js",
  "test/vendor-adapters.test.js",
  "test/vendor-cli.test.js",
  "test/vendor-import-ui.test.js",
  "test/integration-outbox.test.js",
  "test/private-vendor-import.test.js",
  "public/scanner-import.js",
  "server/service-access.js",
  "server/integration-catalog.js",
  "server/integration-coverage.js",
  "test/integration-runtime.test.js",
  "test/integration-projections.test.js",
  "test/integration-client.test.js",
  "test/integration-center.test.js",
  "test/private-integrations.test.js",
  "tools/integration-client.js",
  "tools/send-events.js",
  "server/scanner-ingest.js",
  "server/scanner-pages.js",
  "test/scanner-ingest.test.js",
  "test/private-scanner-import.test.js",
  "test/service-access.test.js",
  "tools/import-trivy.js",
  "server/sqlite-telemetry-store.js",
  "test/sqlite-telemetry-store.test.js",
  "server/private-application.js",
  "server/private-auth.js",
  "server/document-store.js",
  "server/operator-context.js",
  "tools/private-account.js",
  "test/private-auth.test.js",
  "test/private-application.test.js",
  "test/first-run-ui.test.js",
  "test/mfa-http.test.js",
  "test/first-run-http.test.js",
  "test/private-source-workflow.test.js",
  "test/private-recovery.test.js",
  "tools/benchmark-private.js",
  "test/document-store.test.js",
  "public/adapter-contract.js",
  "public/administration-contract.js",
  "public/active-ui.css",
  "public/app-config.js",
  "public/app.css",
  "public/app.js",
  "public/application-bridge.js",
  "public/auth-contract.js",
  "public/bootstrap.js",
  "public/connector-contract.js",
  "public/index.html",
  "public/technical-docs.js",
  "public/technical-reference.md",
  "public/ui-catalog.js",
  "server/reference-control-plane.js",
  "server/reference-administration-runtime.js",
  "server/reference-administration-store.js",
  "server/reference-manifest.js",
  "server/reference-pages.js",
  "server/reference-runtime.js",
  "server/reference-store.js",
  "test/public-boundary.test.js",
  "test/administration-contract.test.js",
  "test/agent-mcp.test.js",
  "test/reference-administration.test.js",
  "test/reference-connectors.test.js",
  "tools/ingest-contract.js",
  "tools/agent-mcp.js",
  "tools/validate-administration.js",
  "tools/build-technical-docs.js",
  "tools/public-audit.js",
  "tools/serve.js",
  "tools/validate-connector.js",
  "tools/validate-ingest.js",
  "tools/validate-provider.js"
]);

const brandAssets = Object.freeze({
  "public/assets/favicon.ico": Object.freeze({
    bytes: 15342,
    mime: "image/vnd.microsoft.icon",
    sha256: "5d3f2311b5d6effd1b350935460da29f9e396854cf19745deb1b2b1cc508da1e"
  }),
  "public/assets/icon-180.png": Object.freeze({
    bytes: 37300,
    mime: "image/png",
    sha256: "fd2f1581967c48ab77f2ba73562eaf87e70bf1b330db1f85d15f58c634088e35"
  }),
  "public/assets/icon-32.png": Object.freeze({
    bytes: 1787,
    mime: "image/png",
    sha256: "8723ee9f23865e50d2df58d3f76957a77f9667636ed6959c14246c747ca7c3a5"
  }),
  "public/assets/mark.png": Object.freeze({
    bytes: 97382,
    mime: "image/png",
    sha256: "c5bfbdf248f6230b9288592283b8b90541f5e96717d023fdc2c1ac7f07d20979"
  }),
  "public/assets/triage-back-arrow.png": Object.freeze({
    bytes: 64946,
    mime: "image/png",
    sha256: "64c7101defb28677f3c0cf33927c2034da97bb75a7447f4a376766f5c0a0ddfb"
  })
});

const approvedDigests = new Set(Object.values(brandAssets).map((asset) => asset.sha256));
approvedDigests.add("2a2babdb4f431a4949aa4f6f8d074100f5f06e9cbda191ea9726296ac5816082");
const allowedTextFiles = new Set(requiredTextFiles);
const allowedFiles = new Set([...allowedTextFiles, ...Object.keys(brandAssets)]);

// Product, vendor, and feature names are structural public UI labels. This list
// is deliberately limited to private personal/project identities that must not
// enter the publication boundary.
const privateMarkers = [
  ["al", "bert"].join(""),
  ["la", "scola"].join(""),
  ["contractor", "codex"].join(" ")
];

const operationalFragments = [
  ["/", "opt", "/"].join(""),
  ["/", "var", "/", "lib", "/"].join(""),
  ["/", "Users", "/"].join(""),
  ["root", "@"].join(""),
  ["system", "ctl"].join(""),
  ["journal", "ctl"].join("")
];

const secretPatterns = [
  ["secret.private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/i],
  ["secret.ssh-key", /ssh-(?:rsa|ed25519)\s+[A-Za-z0-9+/]{40,}/i],
  ["secret.github-token", /gh[pousr]_[A-Za-z0-9_]{20,}/],
  ["secret.aws-access-key", /AKIA[0-9A-Z]{16}/],
  ["secret.jwt", /eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/],
  ["secret.bearer", /bearer\s+[A-Za-z0-9._~+/=-]{20,}/i],
  ["secret.assignment", /(?:api[_-]?key|client[_-]?secret|password|token)\s*[:=]\s*["'][^"'\r\n]{12,}["']/i]
];

const browserCapabilities = [
  ["capability.fetch", /\bfetch\s*\(/],
  ["capability.websocket", /\bWebSocket\b/],
  ["capability.eventsource", /\bEventSource\b/],
  ["capability.xhr", /\bXMLHttpRequest\b/],
  ["capability.beacon", /\bsendBeacon\b/],
  ["capability.local-storage", /\blocalStorage\b/],
  ["capability.session-storage", /\bsessionStorage\b/],
  ["capability.indexed-db", /\bindexedDB\b/],
  ["capability.cache-storage", /\bcaches\s*\./],
  ["capability.cookie", /\bdocument\s*\.\s*cookie\b|\bcookieStore\b/],
  ["capability.service-worker", /\bserviceWorker\b/]
];

const mutationMethods = [/\bPOST\b/, /\bPUT\b/, /\bPATCH\b/, /\bDELETE\b/];
const unsafeHtmlPattern = [
  /\.(?:innerHTML|outerHTML|srcdoc)\s*=/,
  /\[\s*["'](?:innerHTML|outerHTML|srcdoc)["']\s*\]\s*=/,
  /\b(?:insertAdjacentHTML|setHTMLUnsafe|createContextualFragment)\s*\(/,
  /\bdocument\s*\.\s*write(?:ln)?\s*\(/,
  /\bDOMParser\b/
];
const selfReferential = new Set(["tools/public-audit.js", "test/public-boundary.test.js"]);
const browserDocumentationFiles = new Set(["public/technical-docs.js"]);
// These opt-in private application modules may issue same-origin HTTP requests.
// The empty static shell still has connect-src 'none'; all other browser
// restrictions (storage, sockets, unsafe HTML, and tokens) remain in force.
const privateApplicationClients = new Set(["public/private-sign-in.js", "public/document-library.js", "public/service-access.js", "public/scanner-import.js", "public/integration-center.js", "public/vendor-import.js", "public/live-monitoring.js", "public/operations.js", "public/triage.js", "public/setup-guides.js", "public/source-mapping.js", "public/setup-assistance.js"]);

// Exact public reference pages, not general vendor hosts or deployment URLs.
const publicReferenceUrls = new Set([
  "https://learn.microsoft.com/en-us/defender-endpoint/troubleshoot-microsoft-defender-antivirus",
  "https://learn.microsoft.com/en-us/windows/win32/taskschd/security-contexts-for-running-tasks",
  "https://learn.microsoft.com/en-us/windows/win32/api/taskschd/ne-taskschd-task_logon_type",

  "https://checkmk.com/werk/17512",
  "https://github.com/Checkmk/checkmk/blob/master/cmk/gui/openapi/api_endpoints/host/list_hosts.py",
  "https://github.com/Checkmk/checkmk/blob/master/cmk/gui/openapi/endpoints/service/__init__.py",
  "https://YOUR_TENANT.okta.com",
  "https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html",
  "https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html",
  "https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html",
  "https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-log-file-examples.html",

  "https://learn.microsoft.com/en-us/windows/win32/taskschd/task-scheduler-schema",
  "https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html",
  "https://kubernetes.io/docs/concepts/workloads/controllers/daemonset/",
  "https://kubernetes.io/docs/tasks/configure-pod-container/security-context/",
  "https://docs.ansible.com/ansible/latest/playbook_guide/playbooks_checkmode.html",
  "https://github.com/roundcube/roundcubemail/wiki/Configuration",
  "https://nodemailer.com/extras/smtp-connection",
  "https://www.rfc-editor.org/rfc/rfc5425",
  "http://schemas.microsoft.com/windows/2004/02/mit/task",
  "https://docs.checkmk.com/latest/en/rest_api.html",
  "https://documentation.wazuh.com/current/user-manual/manager/alert-management.html",
  "https://learn.microsoft.com/en-us/graph/api/directoryaudit-list?view=graph-rest-1.0",
  "https://s3.${options.region}.amazonaws.com",
  "https://graph.microsoft.com/.default",
  "https://login.microsoftonline.com/${config.options.tenantId}/oauth2/v2.0/token",
  "https://manage.office.com/.default",
  "https://graph.microsoft.com",
  "https://manage.office.com",
  "https://fixture.okta.com",
  "https://fixture.okta.com/api/v1/logs?sortOrder=ASCENDING&after=opaque-fixture&limit=100",
  "https://graph.microsoft.com/v1.0/auditLogs/signIns?$skiptoken=fixture",
  "https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token",
  "https://manage.office.com/api/v1.0/${TENANT}/activity/feed/audit/${id}",

  "https://developer.okta.com/docs/reference/api/system-log/",
  "https://docs.ansible.com/projects/ansible/latest/collections/ansible/windows/win_service_module.html",
  "https://docs.ansible.com/projects/ansible/latest/collections/community/windows/win_scheduled_task_module.html",
  "https://docs.aws.amazon.com/awscloudtrail/latest/APIReference/API_StopLogging.html",
  "https://docs.aws.amazon.com/awscloudtrail/latest/userguide/best-practices-security.html",
  "https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-event-reference-aws-console-sign-in-events.html",
  "https://docs.aws.amazon.com/awscloudtrail/latest/userguide/get-and-view-cloudtrail-log-files.html",
  "https://docs.aws.amazon.com/guardduty/latest/ug/guardduty_findings_eventbridge.html",
  "https://docs.checkmk.com/latest/en/apis_intro.html",
  "https://docs.checkmk.com/latest/en/ec.html",
  "https://docs.fluentbit.io/manual/data-pipeline/buffering.md",
  "https://docs.fluentbit.io/manual/data-pipeline/inputs/windows-event-log-winevtlog",
  "https://docs.fluentbit.io/manual/installation/windows",
  "https://docs.microfocus.com/doc/2097/25.4/siemcefimplementationstandard",
  "https://documentation.wazuh.com/current/installation-guide/index.html",
  "https://documentation.wazuh.com/current/user-manual/capabilities/log-data-collection/index.html",
  "https://github.com/Checkmk/checkmk/blob/master/CONTRIBUTING.md",
  "https://github.com/SigmaHQ/Detection-Rule-License/blob/main/LICENSE.Detection.Rules.md",
  "https://github.com/elastic/detection-rules",
  "https://github.com/fluent/fluent-bit/blob/master/LICENSE",
  "https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/receiver/filelogreceiver/README.md",
  "https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/receiver/windowseventlogreceiver/README.md",
  "https://github.com/open-telemetry/opentelemetry-collector/blob/main/LICENSE",
  "https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/logs/v1/logs.proto",
  "https://kubernetes.io/docs/concepts/cluster-administration/logging/",
  "https://learn.microsoft.com/dotnet/api/System.Diagnostics.Eventing.Reader.EventLogReader",
  "https://learn.microsoft.com/en-us/azure/sentinel/connect-cef-ama",
  "https://learn.microsoft.com/en-us/graph/api/signin-list?view=graph-rest-1.0",
  "https://learn.microsoft.com/en-us/office/office-365-management-api/office-365-management-activity-api-reference",
  "https://learn.microsoft.com/en-us/office/office-365-management-api/office-365-management-activity-api-schema",
  "https://learn.microsoft.com/en-us/powershell/module/exchangepowershell/set-adminauditlogconfig?view=exchange-ps",
  "https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-10/security/threat-protection/auditing/event-1102",
  "https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-10/security/threat-protection/auditing/event-4688",
  "https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-10/security/threat-protection/auditing/event-4769",
  "https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-10/security/threat-protection/auditing/event-4776",
  "https://learn.microsoft.com/en-us/windows-server/identity/ad-ds/plan/Appendix-L--Events-to-Monitor",
  "https://learn.microsoft.com/en-us/windows-server/identity/ad-ds/plan/security-best-practices/advanced-audit-policy-configuration",
  "https://learn.microsoft.com/en-us/windows/security/operating-system-security/device-management/use-windows-event-forwarding-to-assist-in-intrusion-detection",
  "https://learn.microsoft.com/en-us/windows/win32/wes/bookmarking-events",
  "https://learn.microsoft.com/en-us/windows/win32/wes/eventschema-systempropertiestype-complextype",
  "https://opentelemetry.io/docs/collector/install/binary/windows/",
  "https://opentelemetry.io/docs/platforms/kubernetes/helm/collector/",
  "https://opentelemetry.io/docs/specs/otlp/",
  "https://resend.com/changelog/idempotency-keys",
  "https://sigmahq.io/docs/digging-deeper/backends",
  "https://sigmahq.io/docs/digging-deeper/pipelines.html",
  "https://www.elastic.co/licensing/elastic-license/",
  "https://www.microfocus.com/documentation/arcsight/arcsight-smartconnectors-8.3/cef-implementation-standard/Content/CEF/Chapter%202%20ArcSight%20Extension.htm",
  "https://www.postgresql.org/docs/current/runtime-config-logging.html",
  "https://www.rfc-editor.org/rfc/rfc5424",
  "https://www.rfc-editor.org/rfc/rfc5424.html",

  "https://code.claude.com/docs/en/mcp",
  "https://learn.chatgpt.com/docs/extend/mcp?surface=cli",
  "https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference",
  "https://docs.openclaw.ai/tools/mcp",
  "https://www.perplexity.ai/help-center/en/articles/11502712-local-and-remote-mcps-for-perplexity",
  "https://docs.x.ai/grok/connectors/custom-mcp-tunneling",
  "https://sentry.io",
  "https://us.sentry.io",
  "https://de.sentry.io",
  "https://docs.sentry.io/api/",
  "https://docs.sentry.io/api/pagination/",
  "https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/",
  "https://survey.stackoverflow.co/2025/technology",
  "https://www.okta.com/reports/businesses-at-work-archive/businesses-at-work-2025/",
  "https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-event-reference-record-contents.html",
  "https://docs.aws.amazon.com/awscloudtrail/latest/userguide/view-cloudtrail-events-cli.html",
  "https://docs.aws.amazon.com/awscloudtrail/latest/APIReference/API_LookupEvents.html",
  "https://docs.cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry",
  "https://docs.cloud.google.com/logging/docs/reference/v2/rest/v2/entries/list",
  "https://docs.cloud.google.com/logging/docs/reference/audit/auditlog/rest/Shared.Types/AuditLog",
  "https://docs.cloud.google.com/logging/docs/audit",
  "https://docs.cloud.google.com/logging/docs/audit/configure-data-access",
  "https://developers.cloudflare.com/logs/logpush/logpush-job/datasets/zone/firewall_events/",
  "https://developers.cloudflare.com/logs/logpush/logpush-job/log-output-options/",
  "https://developers.cloudflare.com/logs/logpush/permissions/",
  "https://learn.microsoft.com/en-us/graph/api/signin-list?view=graph-rest-1.0",
  "https://learn.microsoft.com/en-us/graph/api/resources/signin?view=graph-rest-1.0",
  "https://developer.okta.com/docs/reference/system-log-query/",
  "https://developer.okta.com/docs/reference/api/event-types/",
  "https://developer.okta.com/docs/api/oauth2/",
  "https://auth0.com/docs/deploy-monitor/logs/retrieve-log-events-using-mgmt-api",
  "https://auth0.com/docs/customize/log-streams/event-filters",
  "https://auth0.com/docs/tenant-logs",
  "https://docs.github.com/en/enterprise-cloud%40latest/rest/orgs/orgs#get-the-audit-log-for-an-organization",
  "https://docs.gitlab.com/api/audit_events/",
  "https://docs.gitlab.com/user/compliance/audit_event_schema/",
  "https://docs.gitlab.com/security/tokens/access_token_scopes/",
  "https://docs.sentry.io/api/events/list-a-projects-error-events/",
  "https://docs.sentry.io/api/events/retrieve-an-event-for-a-project/",
  "https://docs.sentry.io/api/events/list-an-issues-events/",
  "https://docs.docker.com/engine/logging/drivers/json-file/",
  "https://www.freedesktop.org/software/systemd/man/latest/systemd.journal-fields.html",
  "https://docs.datadoghq.com/api/latest/logs/search-logs-post/",
  "https://docs.datadoghq.com/logs/guide/access-your-log-data-programmatically/"
]);

function relative(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function listFiles(directory, results = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || (directory === root && entry.name === "node_modules")) continue;
    const full = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) results.push({ file: full, kind: "symlink" });
    else if (entry.isDirectory()) listFiles(full, results);
    else if (entry.isFile()) results.push({ file: full, kind: "file" });
    else results.push({ file: full, kind: "special" });
  }
  return results;
}

function lineNumber(text, index) {
  return text.slice(0, index).split("\n").length;
}

function report(findings, rule, file, text, index = 0) {
  findings.push({ rule, file: relative(file), line: lineNumber(text, index) });
}

function isAllowedAddress(value) {
  // Loopback and the all-zero missing-address sentinel contain no private host identity.
  if (value === "127.0.0.1" || value === "0.0.0.0") return true;
  const match = /^(192\.0\.2|198\.51\.100|203\.0\.113)\.(\d{1,3})$/.exec(value);
  return Boolean(match && Number(match[2]) <= 255);
}

function isAllowedUrl(value) {
  const normalized = value.replace(/[.,;:]$/, "");
  if (normalized === "http://" || normalized === "https://") return true; // Scheme literal, not an endpoint.
  if (normalized === "http://www.w3.org/2000/svg") return true;
  if (normalized === "https://json-schema.org/draft/2020-12/schema") return true;
  if (publicReferenceUrls.has(normalized)) return true;
  // Fixed provider endpoint and XML namespace, not deployment-specific hosts.
  if (normalized === "https://api.resend.com/emails") return true;
  if (["http://schemas.microsoft.com/win/2004/08/events/event",
       "http://schemas.microsoft.com/win/2004/08/events/event}",
       "http://manifests.microsoft.com/win/2004/08/windows/eventlog"].includes(normalized)) return true;
  try {
    const candidate = new URL(normalized);
    if (["http:", "https:"].includes(candidate.protocol)
        && ["127.0.0.1", "localhost", "[::1]"].includes(candidate.hostname)
        && (!candidate.port || (Number(candidate.port) >= 1 && Number(candidate.port) <= 65535))) {
      return true;
    }
    return candidate.protocol === "https:"
      && (candidate.hostname === "example.invalid" || candidate.hostname.endsWith(".example.invalid"));
  } catch {
    return false;
  }
}

function entropy(value) {
  const counts = new Map();
  for (const char of value) counts.set(char, (counts.get(char) || 0) + 1);
  let result = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    result -= probability * Math.log2(probability);
  }
  return result;
}

function sniffMime(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return "image/png";
  }
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from("00000100", "hex"))) {
    return "image/vnd.microsoft.icon";
  }
  return "application/octet-stream";
}

function auditBrandAsset(findings, entry, expected, buffer) {
  const rel = relative(entry.file);
  if (buffer.length !== expected.bytes) {
    findings.push({ rule: "asset.unapproved-size", file: rel, line: 1 });
  }
  if (sniffMime(buffer) !== expected.mime) {
    findings.push({ rule: "asset.unapproved-mime", file: rel, line: 1 });
  }
  const digest = crypto.createHash("sha256").update(buffer).digest("hex");
  if (digest !== expected.sha256) {
    findings.push({ rule: "asset.unapproved-digest", file: rel, line: 1 });
  }
}

function audit() {
  const findings = [];
  const entries = listFiles(root);
  const actualFiles = new Set();

  for (const entry of entries) {
    const rel = relative(entry.file);
    if (entry.kind !== "file") {
      findings.push({ rule: `manifest.${entry.kind}`, file: rel, line: 1 });
      continue;
    }
    actualFiles.add(rel);
    if (!allowedFiles.has(rel)) findings.push({ rule: "manifest.unexpected", file: rel, line: 1 });
    const stat = fs.statSync(entry.file);
    if (stat.size > 500_000) findings.push({ rule: "manifest.oversize", file: rel, line: 1 });
    if ((stat.mode & 0o111) !== 0) findings.push({ rule: "manifest.executable", file: rel, line: 1 });

    const buffer = fs.readFileSync(entry.file);
    const expectedAsset = brandAssets[rel];
    if (expectedAsset) {
      auditBrandAsset(findings, entry, expectedAsset, buffer);
      continue;
    }
    if (buffer.includes(0)) {
      findings.push({ rule: "content.binary", file: rel, line: 1 });
      continue;
    }
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer).normalize("NFKC");
    } catch {
      findings.push({ rule: "content.invalid-utf8", file: rel, line: 1 });
      continue;
    }
    const lower = text.toLowerCase();

    // A lockfile contains public registry URLs and SHA-512 package integrity
    // values, not application secrets. Validate those fields instead of treating
    // npm metadata as deployment endpoints or high-entropy credentials.
    if (rel === "package-lock.json") {
      try {
        const lock = JSON.parse(text);
        if (lock.lockfileVersion !== 3 || !lock.packages) throw new Error("lock format");
        const declared = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).dependencies;
        if (JSON.stringify(lock.packages[""].dependencies) !== JSON.stringify(declared)) throw new Error("dependencies differ");
        for (const [name, value] of Object.entries(lock.packages)) {
          if (!name) continue;
          if (!/^(?:node_modules\/(?:@[a-z0-9_-]+\/)?[a-z0-9_.-]+)(?:\/node_modules\/(?:@[a-z0-9_-]+\/)?[a-z0-9_.-]+)*$/.test(name)
              || !/^https:\/\/registry\.npmjs\.org\//.test(value.resolved || "")
              || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(value.integrity || "")
              || value.link === true) throw new Error("unapproved dependency");
        }
      } catch { findings.push({ rule: "dependency.invalid-lock", file: rel, line: 1 }); }
      continue;
    }

    for (const marker of privateMarkers) {
      const index = lower.indexOf(marker);
      if (index >= 0) report(findings, "identity.private-marker", entry.file, text, index);
    }
    for (const fragment of operationalFragments) {
      // The portable Linux collector intentionally calls this one fixed,
      // read-only binary. This does not allow shell commands or deployment
      // paths in any other publication surface.
      let index = text.indexOf(fragment);
      while (index >= 0) {
        const fixedCollectorBinary = rel === "tools/native-monitor/collector.py"
          && fragment === ["system", "ctl"].join("")
          && text.slice(index - 10, index + fragment.length + 1) === '"/usr/bin/' + fragment + '"';
        const reviewedServiceTemplate = ["tools/deployment/render.js", "test/deployment-generation.test.js"].includes(rel)
          && fragment === ["system", "ctl"].join("");
        if (!fixedCollectorBinary && !reviewedServiceTemplate) report(findings, "operations.private-fragment", entry.file, text, index);
        index = text.indexOf(fragment, index + fragment.length);
      }
    }
    const privateTailnetHost = /\b[a-z0-9][a-z0-9.-]+\.ts\.net\b/i.exec(text);
    if (privateTailnetHost) report(findings, "operations.private-tailnet-host", entry.file, text, privateTailnetHost.index);

    if (!selfReferential.has(rel)) {
      const reviewedReferences = [...text.matchAll(/https?:\/\/[^\s)`'"<>]+/gi)]
        .filter(match => publicReferenceUrls.has(match[0].replace(/[.,;:]$/, "")))
        .map(match => [match.index, match.index + match[0].length]);
      for (const [rule, pattern] of secretPatterns) {
        const match = pattern.exec(text);
        if (match) report(findings, rule, entry.file, text, match.index);
      }
      for (const match of text.matchAll(/\b[a-f0-9]{32,}\b/gi)) {
        if (!approvedDigests.has(match[0].toLowerCase())) {
          report(findings, "secret.long-hex", entry.file, text, match.index);
        }
      }
      for (const match of text.matchAll(/\b[A-Za-z0-9_+/=-]{28,}\b/g)) {
        if (entropy(match[0]) >= 4.35 && !reviewedReferences.some(([start, end]) => match.index >= start && match.index + match[0].length <= end)) {
          report(findings, "secret.high-entropy-token", entry.file, text, match.index);
        }
      }
    }

    const isBrowserRuntime = rel.endsWith(".js")
      && (rel.startsWith("public/") || rel.startsWith("examples/"));
    if (isBrowserRuntime) {
      for (const [rule, pattern] of browserCapabilities) {
        if (rule === "capability.fetch" && privateApplicationClients.has(rel)) continue;
        const match = pattern.exec(text);
        if (match) report(findings, rule, entry.file, text, match.index);
      }
      if (!browserDocumentationFiles.has(rel) && !privateApplicationClients.has(rel)) {
        for (const forbidden of mutationMethods) {
          const match = forbidden.exec(text);
          if (match) report(findings, "capability.mutation-method", entry.file, text, match.index);
        }
      }
      for (const pattern of unsafeHtmlPattern) {
        const unsafeHtml = pattern.exec(text);
        if (unsafeHtml) report(findings, "render.unsafe-html", entry.file, text, unsafeHtml.index);
      }
    }

    for (const match of text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
      if (!isAllowedAddress(match[0])) report(findings, "identifier.nonreserved-ip", entry.file, text, match.index);
    }
    for (const match of text.matchAll(/[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/gi)) {
      const domain = match[1].toLowerCase();
      if (domain !== "example.invalid" && !domain.endsWith(".example.invalid")) {
        report(findings, "identifier.nonreserved-email", entry.file, text, match.index);
      }
    }
    for (const match of text.matchAll(/https?:\/\/[^\s)`'"<>]+/gi)) {
      if (!isAllowedUrl(match[0])) report(findings, "identifier.unapproved-url", entry.file, text, match.index);
    }
  }

  for (const expected of requiredTextFiles) {
    if (!actualFiles.has(expected)) findings.push({ rule: "manifest.missing", file: expected, line: 1 });
  }
  for (const expected of Object.keys(brandAssets)) {
    if (!actualFiles.has(expected)) findings.push({ rule: "manifest.missing", file: expected, line: 1 });
  }
  return findings;
}

if (require.main === module) {
  const findings = audit();
  if (findings.length) {
    for (const finding of findings) {
      console.error(`${finding.rule}: ${finding.file}:${finding.line}`);
    }
    process.exitCode = 1;
  } else {
    console.log(`public audit passed: ${allowedFiles.size} approved paths; ${Object.keys(brandAssets).length} hash-pinned assets`);
  }
}

module.exports = {
  allowedFiles,
  allowedTextFiles,
  audit,
  brandAssets,
  requiredTextFiles,
  sniffMime
};
