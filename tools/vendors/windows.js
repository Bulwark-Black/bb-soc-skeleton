"use strict";

const crypto = require("node:crypto");
const { validateTimestamp, validateNormalizedRecord } = require("../ingest-contract");
const AUTH_VERSIONS = new Map([[4624, [0, 1, 2]], [4625, [0]], [4768, [0, 2]], [4769, [0, 2]], [4771, [0]], [4776, [0]]]);
const AUDIT_IDS = new Set([4719, 4720, 4722, 4723, 4724, 4725, 4726, 4728, 4729, 4732, 4733, 4738, 4740, 4756, 4757]);
const KEYS = new Set(["computer", "channel", "collectionChannel", "logEpoch", "eventRecordId", "eventId", "eventVersion", "providerName", "providerGuid", "timeCreated", "eventData", "userData"]);
function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError("Expected a plain Windows event object.");
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !d || d.get || d.set) throw new TypeError("Windows events must contain only data properties.");
  }
  return value;
}
function text(value, name, max = 256) {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new TypeError("Invalid Windows " + name + ".");
  return value;
}
function normalize(input) {
  if (!Array.isArray(input)) {
    object(input);
    if (input.schemaVersion !== 1 || Object.keys(input).some(key => !["schemaVersion", "events"].includes(key))) throw new TypeError("Expected windows-eventlog schemaVersion 1 events envelope.");
    input = input.events;
  }
  if (!Array.isArray(input) || !input.length || input.length > 1000) throw new TypeError("Supply 1–1000 named-field Windows events.");
  return input.map(event => {
    object(event);
    if (Object.keys(event).some(key => !KEYS.has(key))) throw new TypeError("Unknown Windows event field.");
    const computer = text(event.computer, "computer"), channel = text(event.channel, "channel");
    const collectionChannel = text(event.collectionChannel, "collection channel");
    const logEpoch = text(event.logEpoch, "log epoch", 128), providerName = text(event.providerName, "provider", 200);
    if (typeof event.eventRecordId !== "string" || !/^[1-9][0-9]{0,19}$/.test(event.eventRecordId) || BigInt(event.eventRecordId) > 18446744073709551615n) throw new TypeError("eventRecordId must be a positive UInt64 decimal string.");
    if (!Number.isInteger(event.eventId) || event.eventId < 0 || event.eventId > 65535 || !Number.isInteger(event.eventVersion) || event.eventVersion < 0 || event.eventVersion > 255) throw new TypeError("Invalid event ID or version.");
    const originalTime = text(event.timeCreated, "original timestamp", 48);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(originalTime)) throw new TypeError("Original Windows timestamp requires an explicit offset.");
    const reducedTime = originalTime.replace(/\.(\d{3})\d+(?=Z|[+-])/, ".$1");
    validateTimestamp(reducedTime, "Windows timestamp");
    const observedAt = new Date(reducedTime).toISOString();
    const fields = { provider: "windows-eventlog", providerName, eventId: event.eventId, eventVersion: event.eventVersion,
      channel, collectionChannel, computer, eventRecordId: event.eventRecordId, eventTime: originalTime, logEpoch };
    if (event.providerGuid !== undefined) {
      if (!/^\{?[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\}?$/i.test(event.providerGuid)) throw new TypeError("Invalid provider GUID.");
      fields.providerGuid = event.providerGuid.toLowerCase();
    }
    let count = 0;
    for (const data of [event.eventData, event.userData]) {
      if (data === undefined) continue;
      object(data);
      for (const key of Object.keys(data).sort()) {
        if (++count > 48 || !/^[A-Za-z][A-Za-z0-9_.:-]{0,59}$/.test(key) || Object.hasOwn(fields, "win." + key)) throw new TypeError("Ambiguous or excessive named Windows event fields.");
        fields["win." + key] = data[key];
      }
    }
    let state = "unknown", category = "event", supported = false;
    if (providerName === "Microsoft-Windows-Security-Auditing") {
      const versions = AUTH_VERSIONS.get(event.eventId);
      if (versions?.includes(event.eventVersion) && channel === "Security") {
        category = "authentication"; supported = true;
        if (event.eventId === 4624) state = "ok";
        else if ([4625, 4771].includes(event.eventId)) state = "failed";
        else if (typeof fields["win.Status"] === "string" && /^(?:0x[0-9a-f]{1,8}|[0-9]{1,10})$/i.test(fields["win.Status"])) {
          const status = Number(fields["win.Status"]);
          if (status <= 4294967295) state = status === 0 ? "ok" : "failed";
        }
      } else if (channel === "Security" && AUDIT_IDS.has(event.eventId) && event.eventVersion === 0) { category = "audit"; supported = true; }
    } else if (providerName === "Microsoft-Windows-Eventlog" && channel === "Security" && event.eventId === 1102 && event.eventVersion === 0) { category = "audit"; supported = true; }
    fields.eventCategory = category; fields.decodeStatus = supported ? "supported" : "unclassified";
    // A timestamp component distinguishes reused origin record IDs in forwarded
    // logs, where the remote channel generation is not available to the WEC reader.
    const upstreamId = "windows:" + crypto.createHash("sha256").update(JSON.stringify([computer.toLowerCase(), channel, logEpoch, event.eventRecordId, originalTime])).digest("hex");
    const title = "Windows event " + event.eventId;
    const payload = { title, state, category: "windows." + category,
      message: providerName + " event " + event.eventId + " in " + channel + " on " + computer + ". Named event fields retain the original evidence.", fields };
    // Enforce exactly the same scalar, secret-field and size rules as ingress,
    // reserving two field slots for the vendor framework's adapter metadata.
    if (Object.keys(fields).length > 62) throw new TypeError("Windows event exceeds canonical field capacity.");
    validateNormalizedRecord({ schemaVersion: "1", documentType: "normalized-record", recordId: upstreamId,
      sourceId: "validation-source", estateId: "validation-application", kind: "log.event", observedAt, payload });
    return { upstreamId, observedAt, kind: "log.event", payload };
  });
}
const adapters = [{ id: "windows-eventlog", title: "Windows Event Log and Active Directory",
  description: "Named-field native Windows event exports, including forwarded origins. Every event remains a searchable log; selected authentication and audit semantics retain provider/version evidence.",
  recordKinds: ["log.event"], formats: ["Version-1 named-field Windows events envelope", "Array of named-field Windows events; XML is parsed by the native collector"],
  docs: [{ title: "Windows event schema", url: "https://learn.microsoft.com/en-us/windows/win32/wes/eventschema-systempropertiestype-complextype" },
    { title: "Windows event bookmarks", url: "https://learn.microsoft.com/en-us/windows/win32/wes/bookmarking-events" }], normalize }];
module.exports = { adapters };

// Private collector subprocess: input/output only on pipes, never command-line
// telemetry or credential values. Registry registration is owned by the host.
if (require.main === module) {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => { data += chunk; if (Buffer.byteLength(data) > 1024 * 1024) { process.stderr.write("Windows input exceeds bound.\n"); process.exit(1); } });
  process.stdin.on("end", () => {
    try {
      const input = JSON.parse(data);
      const { normalizeVendorPayload } = require("../vendor-adapters");
      const result = normalizeVendorPayload("windows-eventlog", input.input, { sourceId: input.sourceId, estateId: input.estateId });
      process.stdout.write(JSON.stringify(result.batch));
    } catch { process.stderr.write("Windows mapping failed; keep the original batch and checkpoint.\n"); process.exitCode = 1; }
  });
}
