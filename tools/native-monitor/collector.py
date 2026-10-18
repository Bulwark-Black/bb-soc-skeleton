#!/usr/bin/env python3
"""Native deterministic Linux/service/PostgreSQL observations; independent bounded transport.

collect writes a durable local outbox. send posts its exact observations to the
configured private console and retires them only after a matching durable receipt.
"""
import argparse
import datetime as dt
import fcntl
import hashlib
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import sys
import time
import urllib.request
import urllib.error
from urllib.parse import urlsplit
import uuid

VERSION = "native-monitor-1.0.0"
MAX_BODY = 64 * 1024
MAX_OUTBOX = 63 * 1024 * 1024
MAX_AGE = 86400
MAX_BATCHES = 1440
MAX_SEND_BATCHES = 16
SEND_BUDGET_SECONDS = 80
BATCH_NAME = re.compile(r"^\d{16}-[a-f0-9-]{36}\.json$")
UNIT = re.compile(r"^[A-Za-z0-9_.@:-]{1,100}\.service$")
HOST = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$")
PG_SUFFIXES = ("connections", "active_connections", "waiting_connections",
               "longest_transaction_seconds", "deadlocks_total", "commits_total", "rollbacks_total",
               "connections_used_pct", "usable_max_connections")

SOURCE_ROOT = next((p for p in Path(__file__).resolve().parents
                    if (p / "package.json").is_file() and (p / "tools/native-monitor/collector.py").is_file()), None)

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

# Credential-bearing delivery and configured readiness probes never inherit
# proxy environment variables or follow redirects.
PRIVATE_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

def outside_source_tree(path):
    if not path.is_absolute() or path != path.resolve() or path == Path(path.anchor):
        raise ValueError("use a canonical absolute private path without links")
    if SOURCE_ROOT is not None and (path == SOURCE_ROOT or SOURCE_ROOT in path.parents):
        raise ValueError("private collector files must be outside the source checkout")

def private_origin(value):
    if not isinstance(value, str) or len(value) > 2048 or re.search(r"[\x00-\x20\x7f%\\]", value):
        raise ValueError("invalid private console origin")
    parsed = urlsplit(value)
    host = parsed.hostname or ""
    if parsed.scheme not in ("http", "https") or parsed.username is not None or parsed.password is not None or parsed.path not in ("", "/") or parsed.query or parsed.fragment or parsed.port == 0:
        raise ValueError("console URL must be an origin without credentials, path, query or fragment")
    loopback = host in ("localhost", "127.0.0.1", "::1")
    private = loopback
    try:
        address = ipaddress.ip_address(host)
        # RFC 1918 private IPv4, RFC 6598 shared space, and RFC 4193 IPv6 ULA.
        networks = tuple(ipaddress.IPv4Network(n) for n in ((0x0A000000, 8), (0xAC100000, 12),
                         (0xC0A80000, 16), (0x64400000, 10))) if address.version == 4 else (ipaddress.IPv6Network((0xFC << 120, 7)),)
        private = private or any(address in network for network in networks)
    except ValueError:
        labels = host.split(".")
        private = private or (host.endswith(".ts.net") and len(labels) >= 3 and len(host) <= 253 and
                              all(re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in labels))
    if (parsed.scheme == "http" and not loopback) or (parsed.scheme == "https" and not private):
        raise ValueError("use exact loopback HTTP or an approved private HTTPS console origin")
    return parsed.scheme + "://" + parsed.netloc.lower()

def stamp():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

def read_regular(path, limit=MAX_BODY):
    path = Path(path)
    if not path.is_absolute() or path != path.resolve(strict=True):
        raise ValueError("file must use a canonical absolute path without links")
    named = path.lstat()
    if not stat.S_ISREG(named.st_mode) or named.st_size > limit:
        raise ValueError("not a bounded regular file")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit or info.st_nlink != 1 or info.st_uid != os.geteuid() or info.st_mode & 0o077 or (named.st_ino, named.st_dev) != (info.st_ino, info.st_dev):
            raise ValueError("not a bounded regular file: " + str(path))
        body = os.read(fd, limit + 1)
        if len(body) > limit:
            raise ValueError("oversize file")
        after = os.fstat(fd)
        if (after.st_size, after.st_mtime_ns, after.st_ctime_ns) != (info.st_size, info.st_mtime_ns, info.st_ctime_ns) or len(body) != info.st_size:
            raise ValueError("file changed while reading")
        return body
    finally:
        os.close(fd)

def read_json(path, default=None):
    try:
        return json.loads(read_regular(path, 1024 * 1024))
    except FileNotFoundError:
        return default

def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

def atomic_json(path, value):
    body = json.dumps(value, separators=(",", ":"), allow_nan=False).encode()
    temp = path.parent / (".tmp-" + secrets.token_hex(16))
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        view = memoryview(body)
        while view:
            n = os.write(fd, view)
            if n <= 0:
                raise OSError("short write")
            view = view[n:]
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(temp, path)
    sync_dir(path.parent)

def secure_dir(path):
    outside_source_tree(path)
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or path != path.resolve() or path.is_symlink() or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise ValueError("unsafe private directory: " + str(path))

def lock_file(path, deadline=None):
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077 or info.st_nlink != 1:
        os.close(fd)
        raise ValueError("unsafe lock")
    try:
        if deadline is None:
            fcntl.flock(fd, fcntl.LOCK_EX)
        else:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("native sender deadline reached waiting for " + path.name)
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    time.sleep(min(0.05, remaining))
        return fd
    except BaseException:
        os.close(fd)
        raise

def load_config(path):
    outside_source_tree(path)
    raw = read_regular(path)
    cfg = json.loads(raw)
    if not isinstance(cfg, dict) or set(cfg) - {"schemaVersion", "host", "sourceId", "consoleUrl", "tokenFile", "services", "postgres"}:
        raise ValueError("invalid collector configuration fields")
    if type(cfg.get("schemaVersion")) is not int or cfg["schemaVersion"] != 1 or not HOST.fullmatch(str(cfg.get("host", ""))) or not HOST.fullmatch(str(cfg.get("sourceId", ""))):
        raise ValueError("invalid schemaVersion, host or sourceId")
    cfg["consoleUrl"] = private_origin(cfg.get("consoleUrl"))
    if not isinstance(cfg.get("tokenFile"), str):
        raise ValueError("explicit tokenFile is required")
    outside_source_tree(Path(cfg["tokenFile"]))
    services = cfg.get("services", [])
    if not isinstance(services, list) or len(services) > 32:
        raise ValueError("invalid services")
    seen = set()
    for item in services:
        if not isinstance(item, dict) or set(item) - {"unit", "healthySubStates", "readiness"} or not UNIT.fullmatch(str(item.get("unit", ""))) or item["unit"] in seen:
            raise ValueError("invalid or duplicate service")
        substates = item.get("healthySubStates", ["running"])
        if not isinstance(substates, list) or not substates or len(substates) > 8 or any(not isinstance(v, str) or not re.fullmatch(r"[a-z-]{1,40}", v) for v in substates):
            raise ValueError("invalid healthy service substates")
        seen.add(item["unit"])
        ready = item.get("readiness")
        if ready is not None:
            if not isinstance(ready, dict) or set(ready) - {"url", "statuses", "jsonEquals", "contains", "description"} or not isinstance(ready.get("url"), str) or len(ready["url"]) > 2048:
                raise ValueError("invalid readiness URL")
            parsed = urlsplit(ready["url"])
            if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username is not None or parsed.password is not None or parsed.fragment or re.search(r"[\x00-\x20\x7f]", ready["url"]):
                raise ValueError("invalid readiness URL")
            codes = ready.get("statuses", [200])
            if not isinstance(codes, list) or not codes or len(codes) > 10 or any(type(x) is not int or x < 100 or x > 599 for x in codes):
                raise ValueError("invalid readiness statuses")
            equals = ready.get("jsonEquals", {})
            if not isinstance(equals, dict) or len(equals) > 8 or any(not isinstance(k,str) or len(k)>60 or type(v) not in (str,int,bool) for k,v in equals.items()):
                raise ValueError("invalid readiness JSON assertion")
            if not isinstance(ready.get("contains", ""), str) or len(ready.get("contains", "")) > 200 or not isinstance(ready.get("description", ""), str) or len(ready.get("description", "")) > 300:
                raise ValueError("readiness match too long")
    pg = cfg.get("postgres", {})
    if not isinstance(pg, dict) or set(pg) - {"enabled", "database", "user", "runAs", "socket"} or type(pg.get("enabled", False)) is not bool:
        raise ValueError("invalid postgres config")
    for key in ("database", "user", "runAs"):
        if key in pg and not re.fullmatch(r"[A-Za-z0-9_-]{1,63}", pg[key]):
            raise ValueError("invalid postgres " + key)
    if "socket" in pg and (not str(pg["socket"]).startswith("/") or ".." in Path(pg["socket"]).parts):
        raise ValueError("PostgreSQL socket must be an absolute local path")
    cfg["configRevision"] = hashlib.sha256(raw).hexdigest()
    return cfg

def parse_cpu(text):
    line = text.splitlines()[0].split()
    if len(line) < 9 or line[0] != "cpu":
        raise ValueError("invalid aggregate CPU counters")
    counters = [int(x) for x in line[1:9]]
    if any(x < 0 for x in counters):
        raise ValueError("negative CPU counter")
    return {"total": sum(counters), "idle": counters[3] + counters[4]}

def cpu_delta(current, previous):
    if not previous or previous.get("bootId") != current["bootId"]:
        return None, "counter baseline unavailable after first start or boot change"
    if current["monotonicNs"] <= previous.get("monotonicNs", -1):
        return None, "monotonic counter did not advance"
    total = current["total"] - previous.get("total", current["total"])
    idle = current["idle"] - previous.get("idle", current["idle"])
    if total <= 0 or idle < 0 or idle > total:
        return None, "CPU counters reset or did not advance"
    return round(100 * (total - idle) / total, 4), None

def parse_mem(text):
    values = {}
    for line in text.splitlines():
        match = re.fullmatch(r"([A-Za-z_()]+):\s+(\d+)\s+kB", line.strip())
        if match:
            values[match[1]] = int(match[2]) * 1024
    total, available = values["MemTotal"], values["MemAvailable"]
    swap, free = values["SwapTotal"], values["SwapFree"]
    if total <= 0 or available > total or free > swap:
        raise ValueError("invalid memory counters")
    return 100 * available / total, swap - free

def run(argv, timeout=5, env=None):
    out = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                         timeout=timeout, check=False, env=env)
    if len(out.stdout) > MAX_BODY:
        raise ValueError("command result exceeds limit")
    return out.returncode, out.stdout.decode("utf-8", errors="strict").strip()

def service_result(service, runner=run):
    unit = service["unit"]
    try:
        code, output = runner(["/usr/bin/systemctl", "show", "--no-pager",
            "--property=LoadState,ActiveState,SubState,Result", unit], timeout=4)
        fields = dict(line.split("=", 1) for line in output.splitlines() if "=" in line)
        if code or fields.get("LoadState") != "loaded":
            return "unknown", "Unit unavailable or systemd query failed"
        active, sub = fields.get("ActiveState"), fields.get("SubState")
        if active != "active":
            return "critical", "Unit is " + str(active) + "/" + str(sub)
        allowed = service.get("healthySubStates", ["running"])
        if sub not in allowed:
            return "critical", "Unit active but unexpected substate: " + str(sub)
        ready = service.get("readiness")
        if ready:
            req = urllib.request.Request(ready["url"], headers={"User-Agent": "BB-SOC-native-monitor/1"})
            try:
                answer = PRIVATE_OPENER.open(req, timeout=3)
            except urllib.error.HTTPError as error:
                if error.code not in ready.get("statuses", [200]):
                    raise
                answer = error
            with answer as res:
                body = res.read(MAX_BODY + 1)
                if len(body) > MAX_BODY:
                    return "unknown", "Readiness response exceeded bounded read"
                if res.status not in ready.get("statuses", [200]):
                    return "critical", "Readiness returned unexpected HTTP status"
                if ready.get("contains") and ready["contains"].encode() not in body:
                    return "critical", "Readiness content assertion failed"
            if ready.get("jsonEquals"):
                payload = json.loads(body)
                if not isinstance(payload, dict) or any(payload.get(k) != v for k,v in ready["jsonEquals"].items()):
                    return "critical", "Readiness JSON assertion failed"
            return "healthy", "Unit running; " + str(ready.get("description", "configured HTTP readiness assertion passed"))[:300]
        return "healthy", "Unit active/" + sub + "; application readiness not configured"
    except urllib.error.HTTPError as error:
        return "critical", "HTTP readiness returned " + str(error.code)
    except (urllib.error.URLError, TimeoutError):
        return "critical", "HTTP readiness request failed or timed out"
    except subprocess.TimeoutExpired:
        return "unknown", "Systemd query exceeded timeout"
    except Exception as error:
        return "unknown", "Service/readiness evaluation failed: " + type(error).__name__

def pg_result(cfg, runner=run):
    env = {"PATH": "/usr/bin:/bin", "LANG": "C", "PGCONNECT_TIMEOUT": "3",
           "PGOPTIONS": "-c statement_timeout=3000 -c lock_timeout=1000 -c default_transaction_read_only=on"}
    prefix = ["/usr/sbin/runuser", "-u", cfg.get("runAs", "postgres"), "--",
              "/usr/bin/psql", "-X", "-w", "-A", "-t", "-v", "ON_ERROR_STOP=1",
              "-h", cfg.get("socket", "/var/run/postgresql"), "-U", cfg.get("user", "postgres"),
              "-d", cfg.get("database", "postgres"), "-c"]
    code, ver = runner(prefix + ["SHOW server_version_num"], timeout=5, env=env)
    if code or not ver.isdigit():
        raise ValueError("PostgreSQL local connection/version query failed")
    if int(ver) < 100000:
        raise ValueError("PostgreSQL version below supported fixed-query contract")
    sql = """SELECT json_build_object(
'connections',(SELECT count(*) FROM pg_stat_activity WHERE backend_type='client backend' AND pid<>pg_backend_pid()),
'connections_used_pct',(SELECT 100.0*count(*)/NULLIF(current_setting('max_connections')::int-current_setting('superuser_reserved_connections')::int-COALESCE(current_setting('reserved_connections',true),'0')::int,0) FROM pg_stat_activity WHERE backend_type='client backend' AND pid<>pg_backend_pid()),
'usable_max_connections',current_setting('max_connections')::int-current_setting('superuser_reserved_connections')::int-COALESCE(current_setting('reserved_connections',true),'0')::int,
'active_connections',(SELECT count(*) FROM pg_stat_activity WHERE state='active' AND pid<>pg_backend_pid()),
'waiting_connections',(SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock'),
'longest_transaction_seconds',(SELECT COALESCE(max(EXTRACT(EPOCH FROM clock_timestamp()-xact_start)),0) FROM pg_stat_activity WHERE xact_start IS NOT NULL AND pid<>pg_backend_pid()),
'deadlocks_total',(SELECT COALESCE(sum(deadlocks),0) FROM pg_stat_database),
'commits_total',(SELECT COALESCE(sum(xact_commit),0) FROM pg_stat_database),
'rollbacks_total',(SELECT COALESCE(sum(xact_rollback),0) FROM pg_stat_database));"""
    code, body = runner(prefix + [sql], timeout=5, env=env)
    if code:
        raise ValueError("PostgreSQL fixed read-only query failed")
    values = json.loads(body)
    if set(values) != set(PG_SUFFIXES) or any(type(v) not in (int, float) or not math.isfinite(v) or v < 0 for v in values.values()):
        raise ValueError("PostgreSQL query returned invalid statistics")
    return values, int(ver)

def collect_batch(cfg, state, proc=Path("/proc"), statvfs=os.statvfs, runner=run):
    started = time.monotonic_ns()
    observed = stamp()
    samples, checks, faults = [], [], []
    host = cfg["host"]
    def bounded_runner(argv, timeout=5, env=None):
        remaining = 110 - (time.monotonic_ns() - started) / 1e9
        if remaining <= 0:
            raise subprocess.TimeoutExpired(argv, 0)
        return runner(argv, timeout=min(timeout, remaining), env=env)
    def sample(suffix, value=None, reason=None, quality=None):
        if value is not None and (type(value) not in (int, float) or not math.isfinite(value) or
                                  (suffix.endswith("_total") and (type(value) is not int or value > 9007199254740991))):
            value, reason, quality = None, "numeric observation is unavailable or exceeds exact counter capacity", "unknown"
        samples.append({"seriesId": host + "." + suffix, "value": value,
                        "quality": quality or ("good" if value is not None else "unknown"),
                        **({"reason": str(reason)[:300]} if reason else {})})
    try:
        boot = (proc / "sys/kernel/random/boot_id").read_text().strip()
        if not re.fullmatch(r"[a-f0-9-]{36}", boot):
            raise ValueError("invalid boot ID")
    except Exception:
        raise ValueError("kernel boot identity unavailable")
    cpu = None
    try:
        cpu = {**parse_cpu((proc / "stat").read_text()), "bootId": boot, "monotonicNs": started}
        value, why = cpu_delta(cpu, state.get("cpu"))
        sample("cpu.utilization_pct", value, why)
    except Exception as error:
        sample("cpu.utilization_pct", reason="CPU collection failed")
        faults.append("CPU:" + type(error).__name__)
    try:
        available, swap = parse_mem((proc / "meminfo").read_text())
        sample("memory.available_pct", available)
        sample("swap.used_bytes", swap)
    except Exception as error:
        sample("memory.available_pct", reason="MemAvailable collection failed")
        sample("swap.used_bytes", reason="swap counters unavailable")
        faults.append("memory:" + type(error).__name__)
    try:
        disk = statvfs("/")
        if disk.f_blocks <= 0 or disk.f_bfree > disk.f_blocks or disk.f_bavail < 0:
            raise ValueError("invalid filesystem counters")
        sample("filesystem.root.used_pct", 100 * (disk.f_blocks - disk.f_bfree) / disk.f_blocks)
        sample("filesystem.root.free_bytes", disk.f_bavail * disk.f_frsize)
    except Exception as error:
        sample("filesystem.root.used_pct", reason="root filesystem collection failed")
        sample("filesystem.root.free_bytes", reason="root filesystem collection failed")
        faults.append("filesystem:" + type(error).__name__)
    try:
        load = float((proc / "loadavg").read_text().split()[0])
        if not math.isfinite(load) or load < 0:
            raise ValueError("invalid load")
        sample("load.1", load)
    except Exception as error:
        sample("load.1", reason="load average unavailable")
        faults.append("load:" + type(error).__name__)
    for service in cfg.get("services", []):
        if (time.monotonic_ns() - started) / 1e9 >= 110:
            status, summary = "unknown", "Collection time budget exhausted before this service probe"
            faults.append("service:collection-budget")
        else:
            status, summary = service_result(service, bounded_runner)
        checks.append({"checkId": host + ".service." + service["unit"], "status": status, "summary": summary[:500]})
    if cfg.get("postgres", {}).get("enabled"):
        try:
            values, version = pg_result(cfg["postgres"], bounded_runner)
            for suffix, value in values.items():
                sample("postgres." + suffix, value)
            checks.append({"checkId": host + ".postgres.connection", "status": "healthy",
                           "summary": "Local read-only statistics query passed; server_version_num=" + str(version)})
        except Exception as error:
            for suffix in PG_SUFFIXES:
                sample("postgres." + suffix, reason="local PostgreSQL statistics unavailable")
            checks.append({"checkId": host + ".postgres.connection", "status": "unknown",
                           "summary": "PostgreSQL collection failed: " + str(error)[:200]})
            faults.append("postgres:" + type(error).__name__)
    batch = {"schemaVersion": 1, "sourceId": cfg["sourceId"], "streamId": state["streamId"],
             "sequence": state["sequence"] + 1, "batchId": str(uuid.uuid4()), "observedAt": observed,
             "bootId": boot, "monotonicNs": str(started), "configRevision": cfg["configRevision"],
             "collectorVersion": VERSION, "collection": {"ok": not faults,
             "durationMs": round((time.monotonic_ns() - started) / 1e6, 3)},
             "samples": samples, "checks": checks}
    if faults:
        batch["collection"]["error"] = ";".join(faults)[:500]
    if batch["collection"]["durationMs"] > 120000:
        raise TimeoutError("collection exceeded receiver duration bound; no completion proof emitted")
    return batch, cpu

def state_for(base):
    value = read_json(base / "state.json")
    if value is None:
        return {"schemaVersion": 1, "streamId": str(uuid.uuid4()), "sequence": 0}
    if not isinstance(value, dict) or value.get("schemaVersion") != 1 or type(value.get("sequence")) is not int or value["sequence"] < 0:
        raise ValueError("invalid durable collector state; refusing stream reset")
    uuid.UUID(value["streamId"])
    return value

def recover_pending(base, state):
    pending = state.get("pending")
    if pending:
        name = pending["name"]
        if not BATCH_NAME.fullmatch(name):
            raise ValueError("invalid pending batch name")
        target = base / "outbox" / name
        existing = read_json(target)
        if existing is not None and existing != pending["batch"]:
            raise ValueError("pending batch conflicts with outbox")
        if existing is None:
            atomic_json(target, pending["batch"])
        del state["pending"]
        atomic_json(base / "state.json", state)

def prune(base, directory, pattern, max_bytes, max_count, now=None):
    """Commit loss evidence before unlink; crash recovery repeats exact deletions."""
    now = time.time() if now is None else now
    gap_path = base / ("gaps-" + directory.name + ".json")
    gap = read_json(gap_path, {"schemaVersion": 1, "discarded": 0, "bytes": 0, "recent": [], "pending": []})
    for item in gap.get("pending", []):
        target = directory / item["name"]
        if not pattern.fullmatch(item["name"]):
            raise ValueError("invalid gap deletion intent")
        if target.exists():
            if hashlib.sha256(read_regular(target)).hexdigest() != item["sha256"]:
                raise ValueError("gap deletion identity changed")
            target.unlink()
    if gap.get("pending"):
        sync_dir(directory)
        gap["pending"] = []
        atomic_json(gap_path, gap)
    rows = []
    for entry in directory.iterdir():
        if not pattern.fullmatch(entry.name):
            continue
        body = read_regular(entry)
        info = entry.lstat()
        if info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise ValueError("unsafe native queue entry")
        try:
            value = json.loads(body)
            observed = dt.datetime.fromisoformat(value["observedAt"].replace("Z", "+00:00")).timestamp()
        except (KeyError, ValueError, TypeError):
            observed = info.st_mtime
        rows.append((observed, entry, body))
    rows.sort(key=lambda row: (row[0], row[1].name))
    total, count = sum(len(row[2]) for row in rows), len(rows)
    removed = []
    for observed, entry, body in rows:
        old = now - observed > MAX_AGE
        if not old and total <= max_bytes and count <= max_count:
            continue
        removed.append({"name": entry.name, "sha256": hashlib.sha256(body).hexdigest(),
                        "bytes": len(body), "reason": "age" if old else "capacity", "at": stamp()})
        total -= len(body)
        count -= 1
    if removed:
        gap["discarded"] += len(removed)
        gap["bytes"] += sum(x["bytes"] for x in removed)
        gap["recent"] = (gap.get("recent", []) + removed)[-32:]
        gap["pending"] = removed
        atomic_json(gap_path, gap)
        for item in removed:
            (directory / item["name"]).unlink()
        sync_dir(directory)
        gap["pending"] = []
        atomic_json(gap_path, gap)
    return gap

def prepare(base):
    secure_dir(base)
    secure_dir(base / "outbox")

def bind_state(cfg, state):
    binding = {"host": cfg["host"], "sourceId": cfg["sourceId"], "consoleUrl": cfg["consoleUrl"]}
    if "binding" not in state and state.get("sequence", 0) != 0:
        raise ValueError("existing collector state has no source binding; use a separate registered collector state")
    if state.get("binding", binding) != binding:
        raise ValueError("collector state belongs to another host, source or console; do not reassign its outbox")
    state["binding"] = binding

def collect(cfg, base):
    fd = lock_file(base / "collect.lock")
    try:
        state = state_for(base)
        bind_state(cfg, state)
        recover_pending(base, state)
        gap = prune(base, base / "outbox", BATCH_NAME, MAX_OUTBOX - MAX_BODY, MAX_BATCHES - 1)
        batch, cpu = collect_batch(cfg, state)
        batch["collection"]["gaps"] = {"outboxDiscarded": gap["discarded"],
            "transportDiscarded": 0,
            "recent": [{k: v for k, v in row.items() if k != "sha256"} for row in gap["recent"][-8:]]}
        if len(json.dumps(batch).encode()) > MAX_BODY:
            raise ValueError("native batch exceeds limit")
        name = str(batch["sequence"]).zfill(16) + "-" + batch["batchId"] + ".json"
        state.update(sequence=batch["sequence"], cpu=cpu, pending={"name": name, "batch": batch})
        atomic_json(base / "state.json", state)
        recover_pending(base, state)
        print(json.dumps({"collected": batch["sequence"], "ok": batch["collection"]["ok"],
                          "samples": len(batch["samples"]), "checks": len(batch["checks"])}))
    finally:
        os.close(fd)

def canonical_number(value):
    # Match the ECMAScript JSON number representation used by the receiver's
    # digest. Ambiguous/non-finite representations fail closed at receipt check.
    if type(value) is int and abs(value) <= 9007199254740991:
        return str(value)
    value = float(value)
    if not math.isfinite(value):
        raise ValueError("non-finite monitoring value")
    if value == 0:
        return "0"
    sign = "-" if value < 0 else ""
    text = repr(abs(value)).lower()
    head, marker, exponent = text.partition("e")
    exponent = int(exponent) if marker else 0
    whole, dot, fraction = head.partition(".")
    digits = (whole + fraction).rstrip("0")
    decimal = len(whole) + exponent
    if 1e-6 <= abs(value) < 1e21:
        if decimal <= 0:
            body = "0." + "0" * (-decimal) + digits
        elif decimal >= len(digits):
            body = digits + "0" * (decimal - len(digits))
        else:
            body = digits[:decimal] + "." + digits[decimal:]
        return sign + body
    power = decimal - 1
    body = digits[0] + ("." + digits[1:] if len(digits) > 1 else "")
    return sign + body + "e" + ("+" if power >= 0 else "") + str(power)

def canonical(value):
    if value is None:
        return "null"
    if type(value) is bool:
        return "true" if value else "false"
    if type(value) in (int, float):
        return canonical_number(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, list):
        return "[" + ",".join(canonical(v) for v in value) + "]"
    if isinstance(value, dict) and all(isinstance(k, str) for k in value):
        return "{" + ",".join(canonical(k) + ":" + canonical(value[k]) for k in sorted(value, key=lambda k: k.encode("utf-16be"))) + "}"
    raise ValueError("unsupported monitoring value")

def validate_receipt(receipt, batch):
    expected = hashlib.sha256(canonical(batch).encode("utf-8")).hexdigest()
    observed = round(dt.datetime.fromisoformat(batch["observedAt"].replace("Z", "+00:00")).timestamp() * 1000)
    if not isinstance(receipt, dict) or receipt.get("ok") is not True or receipt.get("accepted") is not True or receipt.get("batchId") != batch["batchId"] or receipt.get("digest") != expected or not re.fullmatch(r"[a-f0-9]{64}", str(receipt.get("receiptId", ""))) or type(receipt.get("replay")) is not bool or receipt.get("observedAt") != observed:
        raise ValueError("server returned no matching durable monitoring receipt; exact batch retained")
    return receipt

def read_token(cfg):
    path = Path(cfg["tokenFile"])
    outside_source_tree(path)
    token = read_regular(path, 514).decode("utf-8")
    token = token[:-2] if token.endswith("\r\n") else token[:-1] if token.endswith("\n") else token
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,512}", token) or token.startswith("bbsvc_"):
        raise ValueError("tokenFile must contain one issued source credential")
    return token

def deliver(cfg, body, timeout):
    batch = json.loads(body)
    if batch.get("sourceId") != cfg["sourceId"]:
        raise ValueError("queued batch does not belong to configured source")
    envelope = json.dumps({"sourceId": cfg["sourceId"], "host": cfg["host"], "batch": batch},
                          separators=(",", ":"), allow_nan=False).encode("utf-8")
    req = urllib.request.Request(private_origin(cfg["consoleUrl"]) + "/api/v1/monitor/batches", data=envelope, method="POST",
                                 headers={"Authorization": "Bearer " + read_token(cfg), "Content-Type": "application/json", "Accept": "application/json"})
    with PRIVATE_OPENER.open(req, timeout=min(15, timeout)) as response:
        if response.status != 200 or response.headers.get_content_type() != "application/json":
            raise ValueError("monitoring delivery returned an unsupported receipt response")
        encoded = response.read(MAX_BODY + 1)
        if len(encoded) > MAX_BODY:
            raise ValueError("monitoring receipt exceeded bounded read")
        return validate_receipt(json.loads(encoded), batch)

def send(cfg, base, deliver_fn=deliver):
    # One run drains at most sixteen oldest batches; every failure retains the
    # exact body and stops. Scheduled retries reuse the original batch identity.
    deadline = time.monotonic() + SEND_BUDGET_SECONDS
    fd = lock_file(base / "send.lock", deadline)
    try:
        collector_fd = lock_file(base / "collect.lock", deadline)
        try:
            state = state_for(base)
            bind_state(cfg, state)
            recover_pending(base, state)
            prune(base, base / "outbox", BATCH_NAME, MAX_OUTBOX, MAX_BATCHES)
        finally:
            os.close(collector_fd)
        for unused in range(MAX_SEND_BATCHES):
            if time.monotonic() >= deadline:
                return
            collector_fd = lock_file(base / "collect.lock", deadline)
            try:
                names = sorted(x.name for x in (base / "outbox").iterdir() if BATCH_NAME.fullmatch(x.name))
                if not names:
                    return
                target = base / "outbox" / names[0]
                body = read_regular(target)
                batch = json.loads(body)
                if batch.get("sourceId") != cfg["sourceId"] or batch.get("streamId") != state["streamId"]:
                    raise ValueError("outbox batch differs from registered collector state")
            finally:
                os.close(collector_fd)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            receipt = validate_receipt(deliver_fn(cfg, body, remaining), batch)
            collector_fd = lock_file(base / "collect.lock", deadline)
            try:
                if not target.exists() or read_regular(target) != body:
                    raise ValueError("outbox changed during delivery; inspect retained gap evidence")
                atomic_json(base / "last-delivery.json", {"schemaVersion": 1, "sourceId": cfg["sourceId"],
                    "batchId": batch["batchId"], "receiptId": receipt["receiptId"], "digest": receipt["digest"], "recordedAt": stamp()})
                target.unlink()
                sync_dir(target.parent)
            finally:
                os.close(collector_fd)
    finally:
        os.close(fd)

def main():
    parser = argparse.ArgumentParser(description="Collect native Linux observations and deliver a bounded private outbox.")
    parser.add_argument("mode", choices=["collect", "send", "check-config"])
    parser.add_argument("--config", required=True)
    parser.add_argument("--state-dir", required=True)
    args = parser.parse_args()
    os.umask(0o077)
    cfg = load_config(Path(args.config))
    base = Path(args.state_dir)
    outside_source_tree(base)
    if args.mode == "check-config":
        print(json.dumps({"host": cfg["host"], "sourceId": cfg["sourceId"], "services": len(cfg.get("services", [])),
                          "postgres": bool(cfg.get("postgres", {}).get("enabled")), "configRevision": cfg["configRevision"]}))
        return
    prepare(base)
    (collect if args.mode == "collect" else send)(cfg, base)

if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Exception bodies from transports/config decoders may contain private
        # response content. Report only the failure class; queued data is retained.
        print("Native monitor " + type(error).__name__ + ": collection or delivery could not complete; inspect private configuration and retained outbox.", file=sys.stderr)
        sys.exit(1)
