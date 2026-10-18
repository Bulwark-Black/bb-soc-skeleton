# Reviewed rule packs and rollout

The private detection engine supports versioned, explicitly reviewed JSON packs
in addition to its 25 original MIT rules. It does not download or execute Sigma
YAML, Elastic queries, arbitrary expressions or code. A pack is a bounded
translation into this engine's supported fields and operators, with fixtures
that must pass before installation. Importing a pack never enables its rules.

Each pack has schemaVersion 1, a unique lowercase id, positive integer version,
author, license, notice, HTTPS source provenance, licenseReviewed true, and
1–100 rules. At most five packs are installed. Supported declared licenses are
MIT, Apache-2.0 and DRL-1.1; the operator must review the actual upstream license
and preserve all notices. The SPDX-like name alone is not a license grant.

Each rule contains id prefixed by its pack ID, version, title, severity,
kind, prerequisite, conditions and fixtures. The engine accepts log.event,
audit.event, authentication.event, endpoint.event and network.event.
Conditions are an AND of 1–16 comparisons on message, title, state, severity,
assetRef, identityRef or fields.NAME. Operators are equals, contains, startsWith,
endsWith and in. Membership accepts up to 20 scalar choices. String matching is
case-sensitive; regex, script evaluation, arbitrary nesting and unsupported
operators fail validation.

Each fixture is a complete canonical normalized record. Every rule requires
1–20 positive fixtures that match and 1–20 negative fixtures that do not.
Fixtures test the predicate, not an entire threshold scenario. A threshold rule
also requires mode threshold, groupBy, threshold and windowSeconds. Its runtime
uses the existing fixed UTC buckets and complete string grouping identities.
Run integration replay tests for correlation, source scope and late arrival.

## Review, install and rollback

Use external owner-only canonical absolute JSON file paths. Commands are:

    npm run detection:pack -- check --file /absolute/private/pack.json
    npm run detection:pack -- install --file /absolute/private/pack.json --state-dir /absolute/private/state --expected-sha absent
    npm run detection:pack -- policy --file /absolute/private/policy.json --state-dir /absolute/private/state --expected-sha absent
    npm run detection:pack -- restore --kind pack --state-dir /absolute/private/state --expected-sha CURRENT_SHA256

The first install uses expected-sha absent. For existing files, inspect and pass
their current SHA-256 digest. Updates refuse stale digests and require increasing
pack versions. Each successful change writes atomically, fsyncs, and retains one
previous version. Restore validates compatibility with the current policy.
Restore policy with --kind policy before restoring an older pack if enabled rule
IDs changed. An exclusive update lock prevents overlapping writers. A stale lock
after a crash requires checking that its recorded process is gone before an
operator removes it.

The files are detection-packs.json and detection-config.json in the private
state directory. Successful changes explicitly report written-restart-required.
Review and restart the private app using your deployment procedure. The updater
does not restart services or silently reload rules. Keep approved pack sources,
license notices and an independent configuration backup.

## Shadow, selected-source rollout and suppression

Each enabled policy rule can include:

    {
      "id": "windows.audit-log-cleared",
      "stage": "shadow",
      "sourceIds": ["YOUR_SOURCE_ID"],
      "suppressions": [{
        "sourceId": "YOUR_SOURCE_ID",
        "fields": {"computer": "server.example.invalid"},
        "expiresAt": "2026-11-01T00:00:00.000Z",
        "reason": "Reviewed maintenance window"
      }]
    }

Replace the example expiry with a reviewed future UTC timestamp; startup refuses
expiries more than 30 days away. A suppression needs a source or nonempty exact
field scope. When both are present they must both match. Expired suppressions
stop suppressing automatically. Suppression does not delete original evidence.

Stage shadow records matching decisions without producing findings or mail.
Stage active produces findings; sourceIds can restrict the initial trial to
explicit sources in that application. An omitted or empty sourceIds array means
all application sources. Do not confuse an active limited-source trial with
shadow evaluation: eligible active findings can send configured mail.

The catalog and Rules page expose pack attribution, version/digest, policy,
suppression and decision counts. Findings display author and license attribution,
notices, original evidence, rule version and policy revision. Policy/pack changes
partition new correlation state; they do not rescan old stored logs.
Shadow/suppressed decisions share the telemetry transaction, so a rejected
delivery cannot leave a phantom decision or notification.

Correlation evidence is bounded and aged out after 24 hours; the match/decision
ledger remains retained to prevent duplicate findings. Its 250,000-match limit
fails closed. Plan capacity and archival with your retention requirements;
do not delete replay protection merely to clear a capacity alarm.

See [original rules](DETECTION-RULES.md), [notification delivery](NATIVE-NOTIFICATIONS.md)
and [platform coverage](PLATFORM-COVERAGE.md).
