"use strict";

// Original, review-oriented rules. These are not imported Sigma/Wazuh/Elastic
// signatures. Prerequisites and exact field mappings travel with each rule.
const WINDOWS = "https://learn.microsoft.com/en-us/windows-server/identity/ad-ds/plan/Appendix-L--Events-to-Monitor";
function windows(id, eventId, title, severity, options = {}) {
  return { id, version: 1, title, severity, license: "MIT", author: "BB SOC contributors",
    references: [WINDOWS], family: "windows", kind: "log.event",
    prerequisite: "Collect the named Windows channel/provider and enable the applicable audit subcategory; review authorized administrative activity.",
    match: { provider: "windows-eventlog", providerName: options.providerName || "Microsoft-Windows-Security-Auditing",
      channel: options.channel || "Security", eventId, versions: options.versions || [0] },
    ...options };
}
const RULES = [
  windows("windows.audit-log-cleared", 1102, "Windows Security audit log was cleared", "high", { providerName: "Microsoft-Windows-Eventlog" }),
  windows("windows.audit-policy-changed", 4719, "Windows system audit policy changed", "medium"),
  windows("windows.security-service-installed", 4697, "A Windows service was installed", "medium", { versions: [0, 1] }),
  windows("windows.scheduled-task-created", 4698, "A Windows scheduled task was created", "low", { versions: [0, 1] }),
  windows("windows.scheduled-task-updated", 4702, "A Windows scheduled task was updated", "low", { versions: [0, 1] }),
  windows("windows.account-created", 4720, "A Windows user account was created", "low"),
  windows("windows.account-enabled", 4722, "A Windows user account was enabled", "low"),
  windows("windows.account-deleted", 4726, "A Windows user account was deleted", "medium"),
  windows("windows.account-locked", 4740, "A Windows user account was locked out", "medium"),
  windows("windows.group-global-member-added", 4728, "A member was added to a global security group", "low"),
  windows("windows.group-local-member-added", 4732, "A member was added to a local security group", "low"),
  windows("windows.group-universal-member-added", 4756, "A member was added to a universal security group", "low"),
  windows("windows.sid-history-added", 4765, "SID history was added to an account", "high"),
  windows("windows.domain-trust-created", 4706, "A new domain trust was created", "medium"),
  windows("windows.dsrm-password-attempt", 4794, "Directory Services Restore Mode password change attempted", "high"),
  windows("windows.failed-logon-burst", 4625, "Repeated failed Windows logons", "medium",
    { mode: "threshold", groupBy: ["computer", "win.TargetUserName", "win.IpAddress"], threshold: 5, windowSeconds: 300 }),
  windows("windows.kerberos-preauth-burst", 4771, "Repeated Kerberos preauthentication failures", "medium",
    { mode: "threshold", groupBy: ["computer", "win.TargetUserName", "win.IpAddress"], threshold: 5, windowSeconds: 300 }),
  windows("windows.ntlm-validation-burst", 4776, "Repeated NTLM credential validation failures", "medium",
    { mode: "threshold", state: "failed", groupBy: ["computer", "win.TargetUserName", "win.Workstation"], threshold: 5, windowSeconds: 300 }),
  { id: "aws.cloudtrail-stop-logging", title: "AWS CloudTrail logging stop requested", severity: "high", kind: "audit.event",
    match: { vendor: "aws", service: "cloudtrail.amazonaws.com", method: "StopLogging" },
    prerequisite: "Collect AWS CloudTrail management events. This is an API request; review outcome and authorized changes.",
    references: ["https://docs.aws.amazon.com/awscloudtrail/latest/APIReference/API_StopLogging.html"] },
  { id: "aws.cloudtrail-delete-trail", title: "AWS CloudTrail deletion requested", severity: "high", kind: "audit.event",
    match: { vendor: "aws", service: "cloudtrail.amazonaws.com", method: "DeleteTrail" },
    prerequisite: "Collect AWS CloudTrail management events. This is an API request, not proof deletion succeeded.",
    references: ["https://docs.aws.amazon.com/awscloudtrail/latest/userguide/best-practices-security.html"] },
  { id: "aws.console-signin-failures", title: "Repeated AWS console sign-in failures", severity: "medium", kind: "authentication.event",
    match: { vendor: "aws", service: "signin.amazonaws.com", method: "ConsoleLogin" }, state: "failed",
    mode: "threshold", groupBy: ["$identityRef"], threshold: 5, windowSeconds: 300,
    prerequisite: "Collect CloudTrail sign-ins with a resolved principal. Missing identities are not grouped.",
    references: ["https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-event-reference-aws-console-sign-in-events.html"] },
  { id: "entra.signin-failures", title: "Repeated Microsoft Entra sign-in failures", severity: "medium", kind: "authentication.event",
    match: { provider: "microsoft-entra", identityReferenceSource: "provider-id" }, state: "failed",
    mode: "threshold", groupBy: ["$identityRef"], threshold: 5, windowSeconds: 300,
    prerequisite: "Collect Microsoft Graph sign-ins with provider-resolved user IDs and explicit failure codes.",
    references: ["https://learn.microsoft.com/en-us/graph/api/signin-list?view=graph-rest-1.0"] },
  { id: "okta.signin-failures", title: "Repeated Okta authentication failures", severity: "medium", kind: "authentication.event",
    match: { provider: "okta", identityReferenceSource: "provider-id" }, state: "failed",
    mode: "threshold", groupBy: ["$identityRef"], threshold: 5, windowSeconds: 300,
    prerequisite: "Collect mapped Okta authentication events with provider-resolved user IDs.",
    references: ["https://developer.okta.com/docs/reference/api/system-log/"] },
  { id: "microsoft365.audit-disabled", title: "Microsoft 365 organization audit disabling requested", severity: "high", kind: "log.event",
    match: { provider: "microsoft365", workload: "Exchange", recordType: 1, action: "Set-AdminAuditLogConfig", "m365.UnifiedAuditLogIngestionEnabled": "False" },
    prerequisite: "Management Activity API Exchange Admin (RecordType 1) data must include the named parameter. This is a recorded request; review outcome.",
    references: ["https://learn.microsoft.com/en-us/office/office-365-management-api/office-365-management-activity-api-schema"] },
  { id: "linux.ssh-failure-burst", title: "Repeated SSH password failures from one reported host", severity: "medium", kind: "log.event",
    match: { provider: "syslog", appName: "sshd" }, messageContains: "Failed password",
    mode: "threshold", groupBy: ["hostname"], threshold: 10, windowSeconds: 300,
    prerequisite: "Use RFC5424 syslog from a reviewed SSH source. Host-level aggregation is not a user/IP attribution.",
    references: ["https://www.rfc-editor.org/rfc/rfc5424"] }
].map(rule => Object.freeze({ version: 1, license: "MIT", author: "BB SOC contributors", mode: "event", ...rule }));
const BY_ID = new Map(RULES.map(rule => [rule.id, rule]));
function matches(rule, record) {
  if (record.kind !== rule.kind || (rule.state && record.payload.state !== rule.state)) return false;
  const fields = record.payload.fields || {};
  for (const [key, value] of Object.entries(rule.match)) {
    if (key === "versions") { if (!value.includes(fields.eventVersion)) return false; }
    else if (fields[key] !== value) return false;
  }
  return !rule.messageContains || (record.payload.message || "").includes(rule.messageContains);
}
module.exports = { RULES, BY_ID, matches };
