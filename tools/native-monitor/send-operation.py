#!/usr/bin/env python3
"""Queue stable job/employee evidence and replay it to the private console.

This sender never starts a job. Its owner-only SQLite queue retains every event
and receipt. A lost response leaves the exact event pending for the next send.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys
import time
import urllib.error
import urllib.request

from collector import (PRIVATE_OPENER, outside_source_tree, private_origin,
                       read_regular, read_token, secure_dir, lock_file)

MAX_EVENT = 65536
MAX_ENTRIES = 10000
MAX_BYTES = 64 * 1024 * 1024
MAX_SEND = 16
ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$")
STAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$")
FIELDS = {"schemaVersion", "eventId", "observedAt", "jobId", "employeeId", "host", "sourceId",
          "kind", "runId", "scheduledFor", "attempt", "evidence", "scheduleEvidence", "process",
          "journalCoverage", "progress", "provenance", "executionIdentity", "definitionRevision",
          "schedulerRef", "marker", "outputId", "summary", "outputHash", "outputRef"}


class Arguments(argparse.ArgumentParser):
    def error(self, message):
        # argparse's normal diagnostic echoes arbitrary argv, including a token
        # accidentally supplied in place of a file path.
        self.exit(2, "Invalid sender arguments; use --help. Credentials belong only in tokenFile.\n")


def decode(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate JSON member")
            result[key] = value
        return result
    def invalid(value):
        raise ValueError("non-finite JSON value")
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid)


def encode(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"), sort_keys=True)


def load_config(filename):
    path = Path(filename)
    outside_source_tree(path)
    cfg = decode(read_regular(path))
    if not isinstance(cfg, dict) or set(cfg) != {"schemaVersion", "sourceId", "host", "consoleUrl", "tokenFile"}:
        raise ValueError("invalid operation sender configuration")
    if type(cfg["schemaVersion"]) is not int or cfg["schemaVersion"] != 1 or any(not isinstance(cfg[k], str) or not ID.fullmatch(cfg[k]) for k in ("host", "sourceId")):
        raise ValueError("invalid operation sender identity")
    cfg["consoleUrl"] = private_origin(cfg["consoleUrl"])
    if not isinstance(cfg["tokenFile"], str):
        raise ValueError("explicit tokenFile required")
    outside_source_tree(Path(cfg["tokenFile"]))
    return cfg


def validate_event(value, cfg):
    if not isinstance(value, dict) or set(value) - FIELDS or type(value.get("schemaVersion")) is not int or value["schemaVersion"] != 1:
        raise ValueError("invalid event envelope")
    event_id = value.get("eventId")
    if not isinstance(event_id, str) or not ID.fullmatch(event_id) or len(event_id) > 96:
        raise ValueError("stable eventId required")
    # The server receipt key includes the host. Stay within its bounded key.
    if len("host:" + cfg["host"] + ":" + event_id) > 160:
        raise ValueError("combined host/event identity exceeds receipt bound")
    identity = "employeeId" if "employeeId" in value else "jobId"
    if ("employeeId" in value) == ("jobId" in value) or not isinstance(value.get(identity), str) or not ID.fullmatch(value[identity]):
        raise ValueError("exactly one pre-registered job or employee is required")
    kinds = {"start", "progress", "succeeded", "failed", "output", "marker"} if identity == "employeeId" else {"start", "progress", "succeeded", "failed", "cancelled", "observation"}
    if value.get("kind") not in kinds:
        raise ValueError("unsupported observation kind")
    for key in ("host", "sourceId"):
        if key in value and value[key] != cfg[key]:
            raise ValueError("event differs from configured source binding")
    for key in ("observedAt", "scheduledFor"):
        timestamp = value.get(key)
        if timestamp is None and key == "scheduledFor":
            continue
        if not isinstance(timestamp, str) or not STAMP.fullmatch(timestamp):
            raise ValueError("event requires explicit timestamp")
        dt.datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    body = encode(value)
    if len(body.encode()) > MAX_EVENT:
        raise ValueError("operation event exceeds limit")
    return body


def secure_database(path):
    for suffix in ("", "-wal", "-shm", "-journal"):
        candidate = Path(str(path) + suffix)
        try:
            info = candidate.lstat()
        except FileNotFoundError:
            continue
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise ValueError("unsafe operation queue file")


class Queue:
    def __init__(self, base, cfg, lane="operations", binding_extra=None):
        if lane not in ("operations", "websites"):
            raise ValueError("unsupported evidence queue")
        secure_dir(base)
        self.fd = lock_file(base / "queue.lock", time.monotonic() + 5)
        self.db = None
        try:
            file = base / (lane + ".sqlite")
            secure_database(file)
            self.db = sqlite3.connect(str(file), timeout=2)
            secure_database(file)
            self.db.execute("PRAGMA trusted_schema=OFF")
            self.db.execute("PRAGMA journal_mode=WAL")
            self.db.execute("PRAGMA synchronous=FULL")
            self.db.execute("PRAGMA busy_timeout=2000")
            self.db.executescript("CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);"
                "CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,body TEXT NOT NULL,digest TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','blocked','delivered')),attempts INTEGER NOT NULL DEFAULT 0,last_status INTEGER,receipt TEXT);")
            # An additive disposition preserves the earlier delivery state and
            # existing queue schema, without rewriting any retained event.
            columns = {row[1] for row in self.db.execute("PRAGMA table_info(events)")}
            for name in ("abandoned_reason", "abandoned_at"):
                if name not in columns:
                    self.db.execute("ALTER TABLE events ADD COLUMN " + name + " TEXT")
            binding = encode({**{key: cfg[key] for key in ("sourceId", "host", "consoleUrl")}, "lane": lane, "options": binding_extra})
            prior = self.db.execute("SELECT value FROM metadata WHERE key='binding'").fetchone()
            if prior and prior[0] != binding:
                raise ValueError("queue source or destination changed")
            with self.db:
                self.db.execute("INSERT OR IGNORE INTO metadata VALUES('binding',?)", (binding,))
        except BaseException:
            self.close()
            raise

    def close(self):
        if self.db is not None:
            self.db.close()
            self.db = None
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None

    def status(self):
        counts = {"pending": 0, "blocked": 0, "delivered": 0, "abandoned": 0}
        for state, number in self.db.execute("SELECT CASE WHEN abandoned_at IS NOT NULL THEN 'abandoned' ELSE state END disposition,count(*) FROM events GROUP BY disposition"):
            counts[state] = number
        head = self.db.execute("SELECT id,state,attempts,last_status FROM events WHERE state!='delivered' AND abandoned_at IS NULL ORDER BY sequence LIMIT 1").fetchone()
        return {"ok": True, "counts": counts, "retained": sum(counts.values()), "capacity": MAX_ENTRIES,
                "next": dict(zip(("id", "state", "attempts", "lastHttpStatus"), head)) if head else None}

    def enqueue(self, body):
        return self.enqueue_body(body, decode(body)["eventId"])

    def enqueue_body(self, body, event_id):
        digest = hashlib.sha256(body.encode()).hexdigest()
        with self.db:
            prior = self.db.execute("SELECT digest,CASE WHEN abandoned_at IS NOT NULL THEN 'abandoned' ELSE state END FROM events WHERE id=?", (event_id,)).fetchone()
            if prior:
                if prior[0] != digest:
                    raise ValueError("event identity conflict; retained event unchanged")
                return {"ok": True, "id": event_id, "replay": True, "state": prior[1]}
            count, size = self.db.execute("SELECT count(*),coalesce(sum(length(CAST(body AS BLOB))),0) FROM events").fetchone()
            if count >= MAX_ENTRIES or size + len(body.encode()) > MAX_BYTES:
                raise ValueError("queue capacity reached; no retained event was discarded")
            self.db.execute("INSERT INTO events(id,body,digest,state) VALUES(?,?,?,'pending')", (event_id, body, digest))
        return {"ok": True, "id": event_id, "replay": False, "state": "pending"}

    def retry(self, event_id):
        with self.db:
            changed = self.db.execute("UPDATE events SET state='pending',last_status=NULL WHERE id=? AND state='blocked' AND abandoned_at IS NULL", (event_id,)).rowcount
            if not changed:
                raise ValueError("retry requires one retained blocked event")
        return {"ok": True, "state": "pending"}

    def abandon(self, event_id, reason):
        if not isinstance(reason, str) or not reason.strip() or len(reason.encode()) > 1000 or "\0" in reason:
            raise ValueError("abandon requires a bounded explicit reason")
        with self.db:
            prior = self.db.execute("SELECT state,abandoned_reason,abandoned_at FROM events WHERE id=?", (event_id,)).fetchone()
            if not prior or prior[0] == "delivered":
                raise ValueError("only retained unfinished evidence can be abandoned")
            if prior[2] is not None:
                if prior[1] != reason:
                    raise ValueError("abandonment reason is immutable")
                return {"ok": True, "id": event_id, "state": "abandoned", "replay": True}
            recorded_at = dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            self.db.execute("UPDATE events SET abandoned_reason=?,abandoned_at=? WHERE id=?", (reason, recorded_at, event_id))
        return {"ok": True, "id": event_id, "state": "abandoned", "replay": False}


def deliver(cfg, body, timeout):
    event = decode(body)
    envelope = encode({"sourceId": cfg["sourceId"], "host": cfg["host"], "event": event}).encode()
    request = urllib.request.Request(cfg["consoleUrl"] + "/api/v1/monitor/operations", data=envelope, method="POST",
        headers={"Authorization": "Bearer " + read_token(cfg), "Content-Type": "application/json", "Accept": "application/json"})
    with PRIVATE_OPENER.open(request, timeout=min(timeout, 10)) as response:
        if response.status != 200 or response.headers.get_content_type() != "application/json":
            raise ValueError("unsupported operation receipt response")
        raw = response.read(MAX_EVENT + 1)
        if len(raw) > MAX_EVENT:
            raise ValueError("operation receipt exceeds bound")
        receipt = decode(raw)
        if not isinstance(receipt, dict) or receipt.get("ok") is not True or receipt.get("eventId") != event["eventId"] or receipt.get("receiptId") != "host:" + cfg["host"] + ":" + event["eventId"]:
            raise ValueError("matching durable operation receipt required")
        return {key: receipt[key] for key in ("ok", "eventId", "receiptId")}


def send(queue, cfg):
    deadline = time.monotonic() + 45
    delivered = 0
    for unused in range(MAX_SEND):
        # A blocked earlier event stops later lifecycle events overtaking it.
        row = queue.db.execute("SELECT id,body,state FROM events WHERE state!='delivered' AND abandoned_at IS NULL ORDER BY sequence LIMIT 1").fetchone()
        if not row or row[2] == "blocked" or time.monotonic() >= deadline:
            break
        event_id, body, state = row
        with queue.db:
            queue.db.execute("UPDATE events SET attempts=attempts+1 WHERE id=?", (event_id,))
        try:
            receipt = deliver(cfg, body, deadline - time.monotonic())
        except urllib.error.HTTPError as error:
            permanent = error.code in (400, 401, 403, 404, 405, 409, 413, 415, 422)
            with queue.db:
                queue.db.execute("UPDATE events SET state=?,last_status=? WHERE id=?", ("blocked" if permanent else "pending", error.code, event_id))
            raise
        with queue.db:
            queue.db.execute("UPDATE events SET state='delivered',receipt=?,last_status=200 WHERE id=?", (encode(receipt), event_id))
        delivered += 1
    result = queue.status()
    result["deliveredThisRun"] = delivered
    return result


def main():
    parser = Arguments(description=__doc__)
    parser.add_argument("command", choices=("enqueue", "send", "status", "retry", "abandon"))
    parser.add_argument("--config", required=True, help="absolute owner-only JSON configuration outside the checkout")
    parser.add_argument("--queue-dir", required=True, help="dedicated absolute owner-only queue outside the checkout")
    parser.add_argument("--event-file", help="absolute owner-only stable JSON event (enqueue only)")
    parser.add_argument("--event-id", help="retained event identity (retry or abandon only)")
    parser.add_argument("--reason", help="bounded reason retained for explicit abandonment")
    args = parser.parse_args()
    if (args.command == "enqueue") != bool(args.event_file) or (args.command in ("retry", "abandon")) != bool(args.event_id) or (args.command == "abandon") != bool(args.reason):
        parser.error("command arguments do not match")
    if args.event_id and not ID.fullmatch(args.event_id):
        parser.error("invalid event identity")
    os.umask(0o077)
    cfg = load_config(args.config)
    body = None
    if args.event_file:
        outside_source_tree(Path(args.event_file))
        body = validate_event(decode(read_regular(args.event_file, MAX_EVENT)), cfg)
    queue = Queue(Path(args.queue_dir), cfg)
    try:
        result = queue.enqueue(body) if args.command == "enqueue" else queue.retry(args.event_id) if args.command == "retry" else queue.abandon(args.event_id, args.reason) if args.command == "abandon" else send(queue, cfg) if args.command == "send" else queue.status()
        print(encode(result))
        return 1 if args.command == "send" and (result["counts"]["pending"] or result["counts"]["blocked"]) else 0
    finally:
        queue.close()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print("Operation sender " + type(error).__name__ + ": operation could not complete; inspect private configuration and retained queue. No queued event was discarded.", file=sys.stderr)
        sys.exit(1)
