# SOC Console Skeleton

A dependency-free, static scaffold for a security operations console. It
demonstrates information architecture, responsive navigation, dashboard
components, governance views, and synthetic empty/demo states without
including an operational monitoring system.

> This is a UI and architecture example only. It does not collect telemetry,
> detect threats, deliver alerts, store evidence, administer infrastructure,
> or provide a security control.

## Public-safe boundary

This repository is deliberately history-free and self-contained. It contains:

- original scaffold code written for this public example;
- synthetic fixtures using reserved example identifiers;
- local-only navigation and static assets;
- no credentials, customer records, host inventory, internal policies,
  detection logic, deployment manifests, evidence, or service integrations;
- no outbound network clients and no persistent writes.

The disabled controls show where an application could add workflows. They do
not submit or mutate anything.

## Run locally

Requirements: Node.js 20 or newer.

```sh
npm test
npm run audit:public
python3 -m http.server 8080 --directory public
```

Then open `http://127.0.0.1:8080`. You may also open `public/index.html`
directly; the demo does not require a backend.

## Page map

| Area | Demonstration pages |
| --- | --- |
| Monitor | Overview, Console Health, Daily Brief, Analytics, Timeline |
| Respond | Triage, Detection Tuning, Rules, Alert Communications, Decoys, Reported Messages |
| Investigate | Logs, Activity, Indicator Parser, Threat Intelligence, Known Addresses |
| Vulnerability Management | Scans, Remediation |
| Estate | Systems, Databases, Backups, Retention, Sources |
| Govern | Attestations, Risk Register, Access Reviews |
| Configure | Onboarding, Settings |

Desktop navigation groups expand and collapse. On small screens the same route
catalog is available as a dropdown.

## Project structure

```text
public/             The complete static demo
test/               Route and safety-boundary tests
tools/              Public-content audit
docs/               Architecture and extension notes
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before extending the scaffold.

## Extending it safely

Keep presentation models separate from data adapters. A real implementation
should add authentication, authorization, durable audit trails, input
validation, rate limits, retention controls, secret management, and independent
security review before any mutation or integration is enabled. This scaffold is
not production-ready and must not be treated as a secure foundation for those
capabilities.

## License

MIT. See [LICENSE](LICENSE).
