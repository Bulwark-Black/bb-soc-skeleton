#!/usr/bin/env python3
"""Native Windows event reader with one durable, receipt-confirmed pending batch.
Python 3 + Node 22 + Windows PowerShell; no external Python packages. See guide.
"""
import argparse
import base64
import contextlib
import datetime as dt
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import urllib.request
import uuid
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
MAX_BATCH = 1024 * 1024
MAX_STATE = 2 * MAX_BATCH
CHANNELS = {"Security", "System", "Application", "ForwardedEvents", "Microsoft-Windows-Sysmon/Operational", "Microsoft-Windows-PowerShell/Operational", "Microsoft-Windows-Windows Defender/Operational"}
NS = "{http://schemas.microsoft.com/win/2004/08/events/event}"
IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\Z")
# This fixed script uses EventLogReader, not command output or event message parsing.
# Before continuing, seek back to the exact anchor and compare its XML fingerprint.
# A missing/replaced bookmark must fail, even if the API can seek to a nearby event.
NATIVE_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
 $p = [Console]::In.ReadToEnd() | ConvertFrom-Json
 if ($p.mode -eq 'acl') {
  $allowed = @([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')
  foreach ($name in $p.paths) {
   $acl = Get-Acl -LiteralPath $name
   if ($allowed -notcontains $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value) { throw 'Unsafe owner' }
   foreach ($ace in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) {
    if ($ace.AccessControlType -eq 'Allow' -and $allowed -notcontains $ace.IdentityReference.Value) { throw 'Unsafe ACL' }
   }
  }
  [Console]::Write('{"ok":true}')
  exit 0
 }
 $channel = [string]$p.channel
 $session = [System.Diagnostics.Eventing.Reader.EventLogSession]::GlobalSession
 $before = $session.GetLogInformation($channel, [System.Diagnostics.Eventing.Reader.PathType]::LogName)
 $creation = if ($null -eq $before.CreationTime) { '' } else { $before.CreationTime.ToUniversalTime().ToString('o') }
 if ($p.creationTime -and $creation -ne $p.creationTime) { throw 'Channel generation changed' }
 $query = New-Object System.Diagnostics.Eventing.Reader.EventLogQuery($channel,[System.Diagnostics.Eventing.Reader.PathType]::LogName,'*')
 $query.TolerateQueryErrors = $false
 $reader = New-Object System.Diagnostics.Eventing.Reader.EventLogReader($query)
 $events = New-Object System.Collections.Generic.List[string]
 $ending = $p.bookmark
 try {
  if ($p.bookmark) {
   $bookmark = New-Object System.Diagnostics.Eventing.Reader.EventBookmark([string]$p.bookmark)
   # Offset zero validates the exact anchor. Continue this reader after consuming
   # it: the bookmark constructor's offset-one seek can clamp at a quiet log end.
   $reader.Seek($bookmark, 0)
   $anchor = $reader.ReadEvent()
   if ($null -eq $anchor) { throw 'Missing checkpoint anchor' }
   try {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $actual = -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($anchor.ToXml())) | ForEach-Object { $_.ToString('x2') }) } finally { $sha.Dispose() }
    if ($actual -ne $p.anchorHash) { throw 'Checkpoint anchor changed or overwritten' }
   } finally { $anchor.Dispose() }
  }
  for ($i=0; $i -lt [int]$p.limit; $i++) {
   $record = $reader.ReadEvent()
   if ($null -eq $record) { break }
   try {
    $xml = $record.ToXml()
    if ($xml.Length -gt 65536) { throw 'Event exceeds bound' }
    $events.Add($xml)
    $ending = $record.Bookmark.BookmarkXml
   } finally { $record.Dispose() }
  }
 } finally { $reader.Dispose() }
 $after = $session.GetLogInformation($channel,[System.Diagnostics.Eventing.Reader.PathType]::LogName)
 $afterCreation = if ($null -eq $after.CreationTime) { '' } else { $after.CreationTime.ToUniversalTime().ToString('o') }
 if ($creation -ne $afterCreation) { throw 'Channel changed during read' }
 [Console]::Write((@{ events=@($events.ToArray()); bookmark=$ending; creationTime=$creation; atLimit=($events.Count -eq [int]$p.limit) } | ConvertTo-Json -Depth 5 -Compress))
} catch {
 [Console]::Error.WriteLine('Windows event access, checkpoint, or private-file validation failed; no checkpoint was advanced.')
 exit 1
}
"""

def stamp():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

def powershell(value):
    if os.name != "nt":
        raise ValueError("Native Windows collection requires Windows; no probes were run")
    executable = Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    command = base64.b64encode(NATIVE_SCRIPT.encode("utf-16le")).decode("ascii")
    result = subprocess.run([str(executable), "-NoProfile", "-NonInteractive", "-EncodedCommand", command],
                            input=encoded(value), capture_output=True, timeout=60, check=False)
    if result.returncode or len(result.stdout) > 4 * MAX_BATCH:
        raise ValueError("Windows access or checkpoint failed; inspect channel access, retention and the local gap status")
    return json.loads(result.stdout.decode("utf-8-sig"))

def path_check(value, directory=False, private=True):
    path = Path(value)
    if not path.is_absolute() or path != path.resolve(strict=True) or path == ROOT or ROOT in path.parents:
        raise ValueError("Use canonical absolute paths outside the checkout")
    for item in [path, *path.parents]:
        info = item.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400):
            raise ValueError("Links and Windows reparse points are forbidden")
    info = path.stat()
    if (directory and not path.is_dir()) or (not directory and (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1)):
        raise ValueError("Expected private regular file or directory")
    if private:
        if os.name == "nt":
            if powershell({"mode": "acl", "paths": [str(path)]}) != {"ok": True}:
                raise ValueError("Private Windows ACL check failed")
        elif info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise ValueError("Private state must be owner-only")
    return path

def read_private(path, maximum=MAX_STATE):
    path = path_check(path)
    with path.open("rb") as file:
        before = os.fstat(file.fileno())
        data = file.read(maximum + 1)
        after = os.fstat(file.fileno())
    if len(data) > maximum or before.st_size != len(data) or (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise ValueError("Private file changed or exceeds bound")
    return data

def atomic_json(path, value):
    data = encoded(value)
    if len(data) > MAX_STATE:
        raise ValueError("Private state exceeds bound")
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(data); output.flush(); os.fsync(output.fileno())
        path_check(temporary)
        if os.name == "nt":
            import ctypes
            move = ctypes.WinDLL("kernel32", use_last_error=True).MoveFileExW
            move.argtypes = (ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint32)
            move.restype = ctypes.c_int
            if not move(str(temporary), str(path), 0x1 | 0x8):
                raise ctypes.WinError(ctypes.get_last_error())
        else:
            os.replace(temporary, path)
        if os.name != "nt":
            fd = os.open(path.parent, os.O_RDONLY)
            try: os.fsync(fd)
            finally: os.close(fd)
    finally:
        if temporary.exists(): temporary.unlink()

@contextlib.contextmanager
def locked(directory):
    name = directory / "collector.lock"
    if name.exists(): path_check(name)
    fd = os.open(name, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        path_check(name)
        if os.fstat(fd).st_size == 0: os.write(fd, b"0")
        os.lseek(fd, 0, os.SEEK_SET)
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)

def private_origin(value):
    from urllib.parse import urlsplit
    if not isinstance(value, str) or len(value) > 2048 or re.search(r"[\x00-\x20\x7f%\\]", value): raise ValueError("Invalid private console origin")
    parsed = urlsplit(value); host = parsed.hostname or ""
    if parsed.scheme not in ("http", "https") or parsed.username is not None or parsed.password is not None or parsed.path not in ("", "/") or parsed.query or parsed.fragment or parsed.port == 0: raise ValueError("Supply a private console origin without credentials, path, query or fragment")
    loopback = host in ("localhost", "127.0.0.1", "::1"); private = loopback
    try:
        address = ipaddress.ip_address(host)
        # RFC 1918, RFC 6598 and RFC 4193; numeric forms keep examples non-deployment-specific.
        networks = tuple(ipaddress.IPv4Network(n) for n in ((0x0A000000, 8), (0xAC100000, 12), (0xC0A80000, 16), (0x64400000, 10))) if address.version == 4 else (ipaddress.IPv6Network((0xFC << 120, 7)),)
        private = private or any(address in network for network in networks)
    except ValueError:
        private = private or (host.endswith(".ts.net") and len(host.split(".")) >= 3 and all(re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", part) for part in host.split(".")))
    if (parsed.scheme == "http" and not loopback) or (parsed.scheme == "https" and not private): raise ValueError("Use exact loopback HTTP or approved private HTTPS")
    return parsed.scheme + "://" + parsed.netloc.lower()

def config_file(path):
    cfg = json.loads(read_private(path, 65536))
    required = {"schemaVersion", "sourceId", "estateId", "consoleUrl", "tokenFile", "nodeExecutable", "channels", "computers"}
    if not isinstance(cfg, dict) or not required <= set(cfg) or set(cfg) - required - {"maxEvents"} or type(cfg["schemaVersion"]) is not int or cfg["schemaVersion"] != 1: raise ValueError("Invalid Windows collector configuration")
    for key in ("sourceId", "estateId"):
        if not isinstance(cfg[key], str) or not IDENTIFIER.fullmatch(cfg[key]): raise ValueError("Invalid source/application identity")
    cfg["consoleUrl"] = private_origin(cfg["consoleUrl"])
    path_check(cfg["tokenFile"]); path_check(cfg["nodeExecutable"], private=False)
    if not isinstance(cfg["channels"], list) or not 1 <= len(cfg["channels"]) <= len(CHANNELS) or any(not isinstance(c, str) or c not in CHANNELS for c in cfg["channels"]) or len(set(cfg["channels"])) != len(cfg["channels"]): raise ValueError("Choose explicit unique supported channels")
    if not isinstance(cfg["computers"], list) or not 1 <= len(cfg["computers"]) <= 1000 or any(not isinstance(c, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,255}", c) for c in cfg["computers"]): raise ValueError("Configure the exact original computer names allowed through this source")
    if len(set(c.lower() for c in cfg["computers"])) != len(cfg["computers"]): raise ValueError("Duplicate computer")
    cfg.setdefault("maxEvents", 16)
    if type(cfg["maxEvents"]) is not int or not 1 <= cfg["maxEvents"] <= 100: raise ValueError("maxEvents must be 1–100")
    return cfg

def xml_event(raw, channel, epoch, computers):
    if not isinstance(raw, str) or len(raw.encode("utf-8")) > 65536 or "<!DOCTYPE" in raw.upper() or "<!ENTITY" in raw.upper(): raise ValueError("Invalid or oversized event XML")
    root = ET.fromstring(raw)
    if root.tag != NS + "Event" or len(list(root.iter())) > 256: raise ValueError("Invalid Windows Event schema")
    systems = root.findall(NS + "System")
    if len(systems) != 1: raise ValueError("Missing or ambiguous Windows System fields")
    system = systems[0]
    def one(name):
        items = system.findall(NS + name)
        if len(items) != 1: raise ValueError("Missing or ambiguous Windows System field")
        return items[0]
    computer = one("Computer").text
    if computer is None or computer.lower() not in {c.lower() for c in computers}: raise ValueError("Unapproved original computer; checkpoint retained")
    provider = one("Provider")
    event = {"computer": computer, "channel": one("Channel").text, "collectionChannel": channel, "logEpoch": epoch,
             "eventRecordId": one("EventRecordID").text, "eventId": int(one("EventID").text), "eventVersion": int(one("Version").text),
             "providerName": provider.attrib.get("Name"), "timeCreated": one("TimeCreated").attrib.get("SystemTime"), "eventData": {}, "userData": {}}
    if provider.attrib.get("Guid"): event["providerGuid"] = provider.attrib["Guid"]
    if channel != "ForwardedEvents" and event["channel"] != channel: raise ValueError("Original channel differs from local read channel")
    data = root.findall(NS + "EventData")
    users = root.findall(NS + "UserData")
    if len(data) > 1 or len(users) > 1: raise ValueError("Ambiguous event data")
    for index, element in enumerate(list(data[0]) if data else []):
        if element.tag != NS + "Data" or list(element): raise ValueError("Unsupported structured EventData")
        key = element.attrib.get("Name", "param" + str(index + 1))
        if key in event["eventData"]: raise ValueError("Duplicate named EventData")
        event["eventData"][key] = element.text or ""
    if users:
        for element in users[0].iter():
            if element is users[0] or list(element): continue
            key = element.tag.rsplit("}", 1)[-1]
            if key in event["userData"] or key in event["eventData"]: raise ValueError("Ambiguous UserData leaf")
            event["userData"][key] = element.text or ""
    return event

def normalize(cfg, events):
    value = {"sourceId": cfg["sourceId"], "estateId": cfg["estateId"], "input": {"schemaVersion": 1, "events": events}}
    result = subprocess.run([cfg["nodeExecutable"], str(ROOT / "tools/vendors/windows.js")], input=encoded(value), capture_output=True, timeout=30, check=False)
    if result.returncode or len(result.stdout) > MAX_BATCH: raise ValueError("Windows normalization failed; no event or checkpoint was discarded")
    return json.loads(result.stdout)

def binding(cfg):
    return {key: cfg[key] for key in ("sourceId", "estateId", "consoleUrl", "channels", "computers")}

def load_state(directory, cfg):
    filename = directory / "state.json"
    if not filename.exists(): return {"schemaVersion": 1, "binding": binding(cfg), "revision": 0, "nextChannel": 0, "channels": {}, "lastReceiptId": None}
    state = json.loads(read_private(filename))
    if state.get("schemaVersion") != 1 or state.get("binding") != binding(cfg): raise ValueError("Collector state belongs to a different source, destination or collection scope")
    return state

def collect(directory, cfg, reader=powershell, mapper=normalize):
    state = load_state(directory, cfg)
    pending = directory / "pending.json"
    if pending.exists():
        read_private(pending)
        return {"state": "pending-delivery", "checkpointAdvanced": False}
    channel = cfg["channels"][state["nextChannel"]]
    prior = state["channels"].get(channel, {})
    try:
        result = reader({"mode": "read", "channel": channel, "limit": cfg["maxEvents"], "bookmark": prior.get("bookmark"), "anchorHash": prior.get("anchorHash"), "creationTime": prior.get("creationTime")})
        if not isinstance(result, dict) or not isinstance(result.get("events"), list) or len(result["events"]) > cfg["maxEvents"] or not isinstance(result.get("creationTime"), str) or type(result.get("atLimit")) is not bool: raise ValueError("Invalid native reader output")
        if prior.get("creationTime") and prior["creationTime"] != result["creationTime"]: raise ValueError("Log generation changed; explicit gap recovery required")
        next_state = json.loads(json.dumps(state)); next_state["revision"] += 1
        next_state["nextChannel"] = (state["nextChannel"] + 1) % len(cfg["channels"])
        details = dict(prior, logEpoch=prior.get("logEpoch", uuid.uuid4().hex), creationTime=result["creationTime"], lastReadAt=stamp(), atLimit=result["atLimit"])
        next_state["channels"][channel] = details
        if not result["events"]:
            # Quiet reads are local status only. They do not manufacture events
            # or advertise upstream WEF source completeness to the server.
            atomic_json(directory / "state.json", next_state)
            return {"state": "quiet", "channel": channel, "events": 0, "serverHealthProof": False}
        if not isinstance(result.get("bookmark"), str) or not result["bookmark"] or len(result["bookmark"]) > 65536: raise ValueError("Missing native ending bookmark")
        events = [xml_event(raw, channel, details["logEpoch"], cfg["computers"]) for raw in result["events"]]
        batch = mapper(cfg, events)
        # Delivery age and event age are different. Historical retained events
        # keep observedAt; freeze sentAt once when their durable spool is made.
        batch["sentAt"] = stamp()
        # A newly collected delivery has a new body if sentAt changed. Keep the
        # canonical event identities, but bind its receipt to this frozen body.
        batch.pop("receiptId", None)
        batch["receiptId"] = "windows:" + hashlib.sha256(encoded(batch)).hexdigest()
        if len(encoded(batch)) > MAX_BATCH: raise ValueError("Batch exceeds ingress limit; lower maxEvents")
        details.update(bookmark=result["bookmark"], anchorHash=hashlib.sha256(result["events"][-1].encode("utf-8")).hexdigest())
        next_state["lastReceiptId"] = batch["receiptId"]
        atomic_json(pending, {"schemaVersion": 1, "baseRevision": state["revision"], "binding": binding(cfg), "batch": batch,
                              "digest": hashlib.sha256(encoded(batch)).hexdigest(), "nextState": next_state})
        return {"state": "pending-delivery", "channel": channel, "events": len(events), "checkpointAdvanced": False}
    except Exception:
        atomic_json(directory / "failure.json", {"at": stamp(), "channel": channel, "state": "blocked", "reason": "read-checkpoint-or-normalization-failed", "checkpointAdvanced": False})
        raise

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs): return None

def post_batch(cfg, batch):
    token = read_private(cfg["tokenFile"], 514).decode("utf-8").rstrip("\r\n")
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,512}", token) or token.startswith("bbsvc_"): raise ValueError("Expected source-ingest credential")
    request = urllib.request.Request(cfg["consoleUrl"] + "/api/v1/ingest", data=encoded(batch), headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"}, method="POST")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(request, timeout=30) as response:
        if response.status != 200 or response.headers.get_content_type() != "application/json": raise ValueError("Ingest did not return a JSON receipt")
        raw = response.read(65537)
        if len(raw) > 65536: raise ValueError("Ingest receipt too large")
        return json.loads(raw)

def validate_receipt(value, batch):
    keys = {"schemaVersion", "documentType", "sourceId", "receiptId", "status", "accepted", "duplicates", "receivedAt", "replay"}
    if not isinstance(value, dict) or set(value) != keys or value["schemaVersion"] != "1" or value["documentType"] != "ingest-receipt" or value["sourceId"] != batch["sourceId"] or value["receiptId"] != batch["receiptId"] or value["status"] != "accepted" or type(value["replay"]) is not bool: raise ValueError("Invalid matching ingest receipt")
    if any(type(value[k]) is not int or value[k] < 0 for k in ("accepted", "duplicates")) or value["accepted"] + value["duplicates"] != len(batch["records"]): raise ValueError("Incomplete ingest receipt")
    if not isinstance(value["receivedAt"], str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})", value["receivedAt"]): raise ValueError("Invalid receipt timestamp")
    dt.datetime.fromisoformat(value["receivedAt"].replace("Z", "+00:00"))

def send(directory, cfg, transport=post_batch):
    state = load_state(directory, cfg); pending = directory / "pending.json"
    if not pending.exists(): return {"state": "empty"}
    value = json.loads(read_private(pending))
    if value.get("schemaVersion") != 1 or value.get("binding") != binding(cfg) or value.get("digest") != hashlib.sha256(encoded(value["batch"])).hexdigest(): raise ValueError("Pending batch binding or digest mismatch")
    if state["revision"] == value["baseRevision"] + 1 and state["lastReceiptId"] == value["batch"]["receiptId"]:
        # Receipt was already validated and checkpoint committed before a crash.
        pending.unlink(); return {"state": "delivered", "recovered": True}
    if state["revision"] != value["baseRevision"]: raise ValueError("Pending checkpoint revision mismatch")
    receipt = transport(cfg, value["batch"])
    validate_receipt(receipt, value["batch"])
    atomic_json(directory / "state.json", value["nextState"])
    pending.unlink()
    return {"state": "delivered", "receiptId": receipt["receiptId"], "replay": receipt["replay"]}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("check-config", "collect", "send", "status"))
    parser.add_argument("--config", required=True); parser.add_argument("--state-dir", required=True)
    args = parser.parse_args()
    try:
        # Commission the directory and ACL explicitly. Never create a broadly
        # readable Windows directory and briefly place credentials or events in it.
        directory = path_check(args.state_dir, directory=True)
        cfg = config_file(args.config)
        with locked(directory):
            state = load_state(directory, cfg)
            if args.command == "check-config": result = {"state": "configured", "nativeCollectionAvailable": os.name == "nt", "networkRequests": 0}
            elif args.command == "status": result = {"pending": (directory / "pending.json").exists(), "channels": state["channels"], "lastFailure": json.loads(read_private(directory / "failure.json")) if (directory / "failure.json").exists() else None}
            elif args.command == "collect": result = collect(directory, cfg)
            else: result = send(directory, cfg)
        print(json.dumps(result))
    except Exception:
        print("Windows collector failed; retain state and pending data. Check channel permissions, checkpoint continuity, configured scope, field limits and the matching receipt. No automatic reset or skip was performed.", file=sys.stderr)
        return 1
    return 0

if __name__ == "__main__":
    sys.exit(main())
