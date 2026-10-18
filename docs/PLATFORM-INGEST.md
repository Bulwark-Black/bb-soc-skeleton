# Authenticated platform delivery

Use **Sources → Vendor imports** to select one of the 15 checked-in adapters,
install its immutable preset, register an application-scoped source, preview
representative input, test that sample and activate the source. Activation
returns a one-time source-ingest credential. Store it outside the checkout.

Automated bridges may POST JSON to **/api/v1/ingest/platform** with:

    {
      "sourceId": "replace-with-active-source",
      "adapterId": "windows-eventlog",
      "payload": {
        "schemaVersion": 1,
        "events": []
      }
    }

The empty array illustrates the envelope only and is intentionally not
admissible telemetry. Supply actual reviewed events following the selected
adapter contract. Send Content-Type: application/json and the active source's
Bearer credential. Browser cookies are rejected. The credential determines the
application; clients cannot choose another estate. Both adapter and source must
match the registered preset. Paused, revoked and expired sources are refused.

This is the BB SOC gateway protocol. It is not an OTLP /v1/logs endpoint,
syslog socket, CEF network receiver, Microsoft cloud subscription or Checkmk
API. An external bridge must wrap the selected format in this envelope.
Windows' bundled collector normalizes on the host and uses the existing
canonical /api/v1/ingest endpoint instead.

## Durable delivery contract

The entire request is at most 8 MiB of uncompressed JSON, producing at most
1,000 canonical records and 1 MiB of canonical delivery. Splitting and retry
must happen before sending; the gateway never silently drops oversized members.
Only two uploads can be in flight. Authentication precedes reading the body;
the active source binding is rechecked at durable admission.

Success is HTTP 200 with a platform-ingest-result containing the canonical
receipt and mapping summary. Receipt and event identities are deterministic.
A retry of the exact same upstream events receives the same receipt.
Advance a bridge checkpoint only after validating the receipt's source and
receipt ID against its locally normalized batch, accepted status and counts.
The bridge can use normalizeVendorPayload to derive that expectation.

Persist the exact input and destination binding before sending. On timeout,
retry the same bytes; never advance a cloud cursor or discard an event because
the response was lost. Treat credential/source failures as blocked work.
Split export pages before checkpointing if they exceed limits; persist all
chunks until acknowledged. Unsupported/invalid records reject the whole batch
with a bounded error. Operator preview/import remains available for manual work.

The gateway supplies neither polling schedules nor source-side durability.
Delivery proves only receipt of supplied records, not complete collection.
Monitor source-to-forwarder, forwarder queue and forwarder-to-SOC health
separately. Canonical admission's retention/replay window still applies;
an indefinitely delayed queue is not guaranteed admissible. Original raw bytes
are not archived by the SOC. Use a separate encrypted archive when required.
Read [platform coverage](PLATFORM-COVERAGE.md) for exact format support and
[Windows events](WINDOWS-EVENTS.md) for bookmark recovery.
