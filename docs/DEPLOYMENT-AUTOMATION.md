# Deployment automation

The versioned integration-pack generator produces reviewable installation
bundles for existing BB SOC collectors and the protocol gateway. It performs
no remote installation, source activation, credential issuance, image build,
cluster write or production collection. Generated inventory and bundles stay
outside the checkout. No deployment inventory or credential values ship here.

## Supported roles and targets

| Role | Runtime command | Targets |
| --- | --- | --- |
| `windows-events` | Python Windows Event Log reader, bounded send/collect/send | Windows Task Scheduler |
| `server-logs` | Node file collector `--once` | systemd, Ansible, Compose, Helm DaemonSet |
| `native-monitor` | Python native host collector, bounded send/collect/send | systemd, Ansible |
| `cloud-events` | Node platform collector, bounded drain/collect/drain | systemd, Ansible, Compose, Helm DaemonSet |
| `protocol-gateway` | Node private receiver, foreground daemon | systemd, Ansible, Compose, Helm Deployment |

The worker calls the existing executable with argument arrays and `shell:false`.
It does not construct a shell command from event data or accept arbitrary
commands in a pack. Windows collection uses the existing `collect` and `send`
subcommands; the deployment worker supplies the bounded `--once` operation.
Cloud provider selection and permissions belong to the separately reviewed
provider configuration. The Wazuh alerts-file provider uses host systemd or
Ansible packs only: generated cloud containers have no host alerts-file mount,
and the worker rejects Wazuh configuration in a container/Helm pack before running.
Sources must already be configured, tested and activated
through their existing lifecycle. The generator does not bypass those gates.

A native host probe inside a container would observe different process,
filesystem and service namespaces. This pack therefore installs native probes
on the host. Containers support the supplied log-file, cloud and gateway roles
without privileged mode, host PID namespace or added capabilities.

## Inventory contract

`deploy/integration-pack.schema.json` documents the shape. The authoritative
cross-field validator is `tools/deployment/manifest.js`; always run the CLI's
`--check` operation. Version 1 requires `schemaVersion: 1` and
`packVersion: "1.0.0"`. Unknown fields, unsupported role/target combinations,
non-private console origins, ambiguous paths, privileged account IDs and
unpinned container images fail before any bundle is written.

One pack binds one source and application to one scheduled worker or receiver.
Create separate packs for separately activated source identities. In particular,
do not install one source-bound Kubernetes pack on every node: the generated
DaemonSet has an explicit `kubernetes.io/hostname` selector for one reviewed node.
A fleet inventory should generate a separate pack per host/source binding.

This synthetic Linux example contains paths and identifiers only:

```json
{
  "schemaVersion": 1,
  "packVersion": "1.0.0",
  "name": "example-logs",
  "role": "server-logs",
  "targets": ["systemd", "ansible"],
  "sourceId": "source-example",
  "appId": "application-example",
  "installDirectory": "/srv/bb-soc",
  "privateDirectory": "/etc/bb-soc-example",
  "storageDirectory": "/srv/state/bb-soc-example",
  "stateDirectory": "/srv/state/bb-soc-example/state",
  "outboxDirectory": "/srv/state/bb-soc-example/outbox",
  "configFile": "/etc/bb-soc-example/collector.json",
  "tokenFile": "/etc/bb-soc-example/source-token",
  "baseUrl": "http://localhost:8080",
  "runtime": { "node": "/usr/bin/node" },
  "account": { "name": "bbcollector", "uid": 10001, "gid": 10001 },
  "schedule": { "intervalSeconds": 60, "timeoutSeconds": 180 },
  "settings": {
    "file": "/var/log/example.log",
    "format": "plain",
    "maxRecords": 100
  }
}
```

Replace these with the explicitly reviewed deployment inventory. `baseUrl`
permits exact loopback HTTP or the private HTTPS origins accepted by the sender;
there is no public endpoint fallback. Paths must be canonical absolute paths
without links or shell interpolation syntax. Spaces are supported in host service
paths; container paths exclude spaces and reserved staging/temporary mounts.
The install tree, private configuration directory and durable storage directory
must be separate. Do not place secrets or state in the repository.

Every pack has distinct `configFile` and `tokenFile` direct children of
`privateDirectory`. `deployment-pack.json` is reserved for the generated pack.
The file-log role uses its explicit `settings` and does not read `configFile`.
Other roles read a separately reviewed config file, except Windows, whose config
is generated from the explicit channels/computers settings. The worker checks
source identity, application where the underlying format has one, destination
and credential path before starting a configured collector. The gateway's state
and outbox paths must also match its pack.

`stateDirectory` is a direct child of `storageDirectory`. The file-log, cloud and
gateway roles use a separate sibling `outboxDirectory`. Native monitoring uses
`stateDirectory/outbox`, matching its existing collector. Windows stores its
single pending batch in `stateDirectory`; the separate pack outbox directory is
reserved and is not presented as an additional Windows queue.

Role-specific additions:

- Windows: use drive-qualified Windows paths, `runtime.node`, `runtime.python`,
  a dedicated local `account.name`, and settings containing `channels`,
  `computers`, and `maxEvents` from 1 through 100. Channels must be explicitly
  selected from Security, System, Application, ForwardedEvents, Sysmon Operational
  and PowerShell Operational. The interval must be a whole number of minutes.
- File logs: `settings.file`, `settings.format` (`plain`, `docker-json`, or
  `journald-json`) and `settings.maxRecords` from 1 through 100 are required.
- Native monitoring: add `runtime.python` and use empty settings. Supply its
  existing host/service/PostgreSQL config separately. The application binding is
  enforced by the authenticated source and server registry.
- Cloud and gateway: use empty settings and provide their existing reviewed JSON
  config separately. Provider credential files, receiver auth token, certificates
  and keys remain external private files; their values are never pack fields.

## Generate and review

Create an owner-only external directory for inventory and output bundles. On
Windows, provision a private parent ACL first. The generator does not commission
Windows filesystem permissions on the operator's behalf.

```sh
node tools/generate-deployment.js --inventory /absolute/private/inventory.json --check
node tools/generate-deployment.js --inventory /absolute/private/inventory.json --output /absolute/private/bundles/example
```

`--check` performs no writes or network calls. Generation refuses existing output
and writes a new private directory. Review `commands.json`, `REVIEW.md`, the
versioned pack, generated platform files and any generated Windows config.
The output is deterministic for the same inventory. Treat it as private inventory
even though it contains no credentials. Copy the pack to
`privateDirectory/deployment-pack.json` with owner-only access before starting.

Install the reviewed checkout and dependencies at `installDirectory`. A dedicated
service account needs only access to its private files, durable storage and named
inputs. Grant individual log-file or event-channel access; do not run the worker
as root/Administrator or broaden audit policy automatically. Linux service units
hide home directories, so keep runtime, configuration and input paths outside
home directories. Host users/groups and numeric IDs must match the pack.

## Bounded scheduling and recovery

`tools/deployment/worker.js --manifest ABSOLUTE_PRIVATE_PACK --once` performs one
bounded cycle. `--loop` schedules the next bounded attempt after the previous
one completes. It uses one cycle deadline, fixed executable arguments and an
exclusive overlap lock below storageDirectory/.deployment-worker. A failed delivery stops that cycle;
retained batches remain unchanged for retry. The file collector's exit 2 means
backlog or pending delivery and is accepted by systemd as a completed bounded run.
The protocol gateway is a foreground daemon with its own bounded durable queue,
not a periodic collection job.

Systemd uses one service plus `OnUnitInactiveSec` timer. The unit has a dedicated
account, restrictive umask, read-only system tree, explicit writable storage,
no new privileges, no ambient capabilities and a process-group kill boundary.
The install script installs definitions without starting collection. Ansible
requires both an explicit inventory target and explicit enable choice.

Task Scheduler uses a least-privilege dedicated local account with Password
logon, IgnoreNew, a wall-time limit and a disabled task until commissioning.
Run the generated installer in an elevated interactive PowerShell session. It
checks that the reviewed local account exists, prompts with Get-Credential and
requires the exact machine-qualified account shown. The password is passed to
Task Scheduler through its registration API; it is never placed in inventory,
generated files, process arguments or console output. Windows stores the task
credential; follow your account rotation and task credential update procedure.

The collector separately uses its private HTTPS source credential. Provision
batch-logon permission, private ACLs and the required Event Log Readers or
channel access before enabling. Domain/gMSA task provisioning is not automated.
S4U is not used because its documented network restrictions and different-account
registration requirements do not fit this unattended sender. See Microsoft's
[task security contexts](https://learn.microsoft.com/en-us/windows/win32/taskschd/security-contexts-for-running-tasks)
and [task logon types](https://learn.microsoft.com/en-us/windows/win32/api/taskschd/ne-taskschd-task_logon_type).
Registration and real Windows execution still require Windows commissioning;
Linux XML and mocked collector tests do not establish live Windows compatibility.

A forced kill can leave `deployment-worker.lock`. Inspect its recorded PID,
stop every related task/service/container and confirm the process is gone before
removing only that wrapper lock. Never delete collector cursors, pending batches
or outbox files to clear a blocked state. Follow the collector's replay/gap
recovery procedure. Node termination kills the child process tree; systemd and
Task Scheduler provide an additional execution boundary.

## Containers and Helm

For `container` or `helm`, supply an approved `image` with an actual
`@sha256:` digest. Mutable tags and missing digests are rejected. The repository
does not invent a digest, publish an image or pull one during generation.
`deploy/Dockerfile` is a build recipe requiring an explicit digest-pinned
`BASE_IMAGE` with Node 22 and the compiler prerequisites for better-sqlite3.
Its runtime defaults to UID/GID 10001. The generated workload uses the explicit
inventory UID/GID, read-only root, dropped capabilities and no privilege
escalation. Review and scan the image you build, record its real digest, and use
that digest in the pack. The recipe installs at `/srv/bb-soc`; keep that path and
the image's actual Node executable path in matching inventory.

Compose bind-mounts already provisioned private configuration read-only and durable
storage read/write. A file-log input parent mounts read-only so file replacement
remains visible. The input parent must not overlap the checkout, private files,
durable storage, /tmp, the projected-file mount or the private-volume staging mount. These overlaps are
rejected during generation to prevent masked or duplicate mounts. Both Compose and Helm use
host networking to retain the explicitly configured private-interface binding
and overlay routing. No public port mapping, Service, Ingress or automatic
firewall change is generated. Restrict host routing, listener access and egress
through the deployment's private-network controls. Use unprivileged listener
ports; the workload receives no bind-service capability.

Helm additionally requires `kubernetes.namespace`, `nodeName`, `secretName`, and,
for the gateway, an existing `storageClaim`. Namespace creation, private Secret
creation, PVC provisioning and host-directory preparation are separate reviewed
steps. A collector uses a pre-existing node-local durable directory; a gateway
uses one Deployment replica with Recreate strategy and the explicit PVC.

The pod uses fsGroupChangePolicy OnRootMismatch. Before first use or reuse, the
gateway PVC root must already have the configured group and group read/write/execute
permission (including the setgid directory bit), while retained child directories
and files keep their owner-only permissions. Inspect those properties before
mounting retained evidence: a mismatched root can still trigger kubelet's recursive
permission adjustment. Do not use recursive chmod/chown to repair a live or retained
queue. Stop workers, preserve a consistent backup and commission the volume root
separately. The collector's hostPath storage is likewise prepared for its explicit
worker UID/GID; the pack does not automatically change host ownership. The
collector DaemonSet uses OnDelete updates to avoid overlapping a source's state
writer. The generated chart is deliberately immutable: regenerate from reviewed
inventory to change it; arbitrary Helm value overrides do not change the pack.

The existing Secret must contain files with the exact basenames referenced by
the runtime configuration: source token, collector config when applicable, and
any provider credentials or TLS material. Keep those references directly below
`privateDirectory`. The pack itself comes from a generated ConfigMap. No secret
value appears in that ConfigMap. Kubernetes projects files as root; an unprivileged
init container creates an owner-only child directory under the mounted memory
volume at /bb-soc-private-volume/private and copies bounded private files there.
It does not chmod the root-owned volume root: fsGroup grants group access, not
user ownership. The main container mounts only the owned child using subPath at
the configured privateDirectory. This satisfies owner-only checks without
making either container root. The init step also prepares state
subdirectories in the already authorized writable volume. It does not alter host
log permissions, create a host directory or chown someone else's storage.

## Ansible and rollback

The generated playbook requires the adopter's own inventory and variables. It
creates a restricted account and private directories, verifies required inputs,
backs up existing service definitions and copies the reviewed pack. It does not
copy credential values, install an arbitrary checkout, change audit policy or
activate sources. An explicit `bb_soc_target` selects the adopter inventory group
or host; `bb_soc_enable` must be explicitly true or false. Review with Ansible's
check/diff workflow before an authorized application.

Stop the schedule or workload before upgrading or rolling back. Save the previous
service/task/Helm revision, record its image digest and back up private durable
state while stopped. Restore a compatible reviewed release; do not downgrade a
state schema without a supported migration. Re-run source/config checks and one
bounded cycle before re-enabling the schedule.

Uninstall scripts and playbooks stop and remove generated scheduling definitions.
Compose teardown must retain volumes; Helm uninstall retains adopter-managed
Secret, PVC and host data. State, outbox, configuration and accounts remain for
reconciliation. Disable/revoke the source credential through the private app and
revoke provider access separately if retiring the integration. Neither uninstall
nor rollback erases evidence or silently issues a replacement credential.

## Validation and commissioning limits

Automated tests parse rendered YAML using the maintained `yaml` library and
Windows XML using a real XML parser; they check argument boundaries, role and
node selectors, restricted security context, durable mounts, explicit activation,
rollback retention, source binding, overlap locks and process-tree timeouts.
Those tests do not apply a playbook, register a Windows task, build/publish an
image, create a cluster workload or prove production collection. Commission the
chosen platform with its real log permissions and private network before
reporting it as collecting.

Official references:

- [Microsoft Task Scheduler XML schema](https://learn.microsoft.com/en-us/windows/win32/taskschd/task-scheduler-schema)
- [systemd execution settings](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)
- [Kubernetes DaemonSet behavior](https://kubernetes.io/docs/concepts/workloads/controllers/daemonset/)
- [Kubernetes security context](https://kubernetes.io/docs/tasks/configure-pod-container/security-context/)
- [Ansible check and diff modes](https://docs.ansible.com/ansible/latest/playbook_guide/playbooks_checkmode.html)

The wrapper overlap lock lives in an owner-only .deployment-worker directory
below storageDirectory, outside collector-owned state and outbox directories.
For container log files, the parent directory is mounted read-only so replacement
rotation remains visible; review that directory-wide read grant. The file
collector still refuses unreviewed rotation or truncation instead of silently
resetting its checkpoint.
