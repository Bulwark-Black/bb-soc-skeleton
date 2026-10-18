(function (root) {
  "use strict";
  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function link(text, href) {
    const node = el("a", text, "resource-action"); node.href = href;
    node.style.display = "inline-flex"; node.style.margin = "4px 6px 4px 0"; return node;
  }
  function section(title, ...children) {
    const node = el("section", undefined, "panel"); node.style.padding = "14px";
    node.append(el("h2", title), ...children); return node;
  }
  function render({ container } = {}) {
    if (!container) throw new TypeError("Server log guidance needs a container.");
    container.replaceChildren(
      section("Bring your server logs",
        el("p", "Collect reviewed plain-text, Docker JSON, or journald JSON lines from an explicit local file. The collector keeps a durable position and sends canonical records through a private delivery queue.", "muted"),
        el("p", "This page is setup guidance. Collection runs on your server through the CLI and your scheduler; opening this page does not read files or start monitoring.", "muted")),
      section("1 · Register the application and source",
        el("p", "Register your application and environment, then choose Server log collector when adding a source. Use one source and dedicated collector state per input file. A collector host enrollment is optional. Set the cadence to match your scheduler."),
        link("Register an application", "#/onboard"),
        link("Configure a server log source", "#/sources?stab=add&connectorType=server-log-push")),
      section("2 · Review the input and validate a sample",
        el("p", "Choose an absolute regular-file path and a supported format. Remove credentials, private request content, and other unwanted fields upstream. Messages are retained as supplied; this collector is not an automatic secret redactor."),
        el("p", "Run the collector's preview command with your registered application and source IDs. Review the resulting normalized record, then paste it into Validate sample on the source setup screen. Preview performs no writes or delivery."),
        el("pre", "npm run collect:logs -- --help"),
        el("p", "Activate the validated source and save its one-time source credential in an owner-only file outside the checkout. The collector uses a token-file path, never a credential pasted into a command.")),
      section("3 · Collect, queue, and schedule",
        el("p", "Run one bounded collection pass using a dedicated private state directory and a separate private outbox. Repeat from your process supervisor or scheduler. Keep the same state and outbox across restarts."),
        el("p", "The cursor advances after the exact batch is durably queued. Inspect delivery receipts separately. Incomplete lines, malformed records, file replacement, and truncation do not silently reset or skip input. Resolve the reported condition before continuing."),
        el("p", "Already have canonical batches or a mapping recipe? The events CLI can enqueue, inspect, drain, and retry those batches using the same durable queue."),
        el("pre", "npm run events -- --help"),
        link("Map structured application events", "#/sources?stab=mapping")),
      section("4 · Verify collection and event activity",
        el("p", "A successful read can contain zero events. Sources and Health distinguish the collector's completed read from the last delivery and the latest log event. A delivery receipt alone does not prove the reader completed."),
        el("p", "Inspect Received observations by application, source, kind, and event time. Use log.event for log messages and source.heartbeat for reader proof. Delayed or replayed proof does not make an old collection fresh."),
        link("Inspect received observations", "#/sources?stab=observations"),
        link("Collection health", "#/health"),
        link("Server log setup and recovery manual", "#/docs?section=65-server-logs-and-collector-health"))
    );
    const cleanup = () => {}; cleanup.isDirty = () => false; return cleanup;
  }
  root.SocServerLogs = Object.freeze({ render });
})(typeof window === "object" ? window : globalThis);
