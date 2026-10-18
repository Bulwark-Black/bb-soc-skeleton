#!/usr/bin/env python3
"""Probe explicitly reviewed HTTPS targets and durably deliver website evidence.

Only collect --reviewed-targets contacts configured targets. send replays retained
batches to the private console; it never re-probes a target or rewrites evidence.
"""
import datetime as dt
from contextlib import contextmanager
import hashlib
import http.client
import importlib.util
import os
from pathlib import Path
import re
import signal
import socket
import ssl
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import urljoin, urlsplit, urlunsplit
import uuid

from collector import (PRIVATE_OPENER, canonical, outside_source_tree, private_origin,
                       read_regular, read_token, stamp)

_spec = importlib.util.spec_from_file_location("operation_sender", Path(__file__).with_name("send-operation.py"))
_sender = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_sender)
Arguments, Queue, decode, encode = _sender.Arguments, _sender.Queue, _sender.decode, _sender.encode
MAX_BODY = 65536
TIMEOUT = 5
REDIRECTS = {301, 302, 303, 307, 308}


def target_url(value):
    if not isinstance(value, str) or not value or len(value) > 300 or re.search(r"[\x00-\x20\x7f\\]", value):
        raise ValueError("invalid explicit website target")
    parsed = urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username is not None or parsed.password is not None or parsed.query or parsed.fragment or parsed.port == 0:
        raise ValueError("targets require credential-free HTTPS URLs without query or fragment")
    return value


def load_config(filename):
    path = Path(filename)
    outside_source_tree(path)
    cfg = decode(read_regular(path))
    if not isinstance(cfg, dict) or set(cfg) != {"schemaVersion", "sourceId", "host", "consoleUrl", "tokenFile", "targets"}:
        raise ValueError("invalid website observer configuration")
    if type(cfg["schemaVersion"]) is not int or cfg["schemaVersion"] != 1 or any(not isinstance(cfg[k], str) or not _sender.ID.fullmatch(cfg[k]) for k in ("host", "sourceId")):
        raise ValueError("invalid observer identity")
    cfg["consoleUrl"] = private_origin(cfg["consoleUrl"])
    if not isinstance(cfg["tokenFile"], str):
        raise ValueError("explicit tokenFile required")
    outside_source_tree(Path(cfg["tokenFile"]))
    targets = cfg["targets"]
    if not isinstance(targets, list) or not targets or len(targets) > 20:
        raise ValueError("configure one to twenty reviewed targets")
    for value in targets:
        target_url(value)
    if len(set(targets)) != len(targets):
        raise ValueError("duplicate website target")
    return cfg


def origin(url):
    parsed = urlsplit(url)
    return parsed.scheme, parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80)


def safe_redirect(url):
    parsed = urlsplit(url)
    # Keep useful destination evidence without retaining query/fragment secrets.
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))[:500]


def request_once(url, timeout):
    parsed = urlsplit(url)
    connection = http.client.HTTPSConnection(parsed.hostname, parsed.port or 443, timeout=timeout, context=ssl.create_default_context())
    try:
        # Explicit connect captures the certificate from the verified TLS socket
        # even when the peer closes the connection after its response headers.
        connection.connect()
        certificate = connection.sock.getpeercert()
        expires = certificate.get("notAfter")
        certificate_end = dt.datetime.fromtimestamp(ssl.cert_time_to_seconds(expires), dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z") if expires else None
        connection.request("GET", urlunsplit(("", "", parsed.path or "/", parsed.query, "")),
                           headers={"User-Agent": "BB-SOC-website-observer/1", "Accept": "*/*", "Connection": "close"})
        response = connection.getresponse()
        # Do not read or persist a response body, cookies, or authentication.
        return {"status": response.status, "location": response.getheader("Location"), "certNotAfter": certificate_end}
    finally:
        connection.close()


@contextmanager
def deadline_after(seconds):
    # A socket timeout alone resets for each read and does not bound DNS or a
    # peer that drips headers. CLI probes run in the main POSIX process, where
    # this wall-clock deadline bounds connect, TLS and headers together.
    prior_handler = signal.getsignal(signal.SIGALRM)
    prior_timer = signal.getitimer(signal.ITIMER_REAL)
    started = time.monotonic()
    def expired(signum, frame):
        raise TimeoutError()
    signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, min(seconds, prior_timer[0]) if prior_timer[0] else seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, prior_handler)
        if prior_timer[0]:
            signal.setitimer(signal.ITIMER_REAL, max(0.000001, prior_timer[0] - (time.monotonic() - started)), prior_timer[1])


def probe(url, request_fn=request_once, monotonic=time.monotonic, timestamp=stamp):
    target_url(url)
    started = monotonic()
    current, redirect, certificate_end, status, error = url, None, None, 0, None
    try:
        for hop in range(4):
            remaining = TIMEOUT - (monotonic() - started)
            if remaining <= 0:
                raise TimeoutError()
            with deadline_after(remaining):
                result = request_fn(current, remaining)
            status, certificate_end = result["status"], result["certNotAfter"]
            if status not in REDIRECTS:
                if certificate_end is None:
                    error = "verified-tls-expiry-unavailable"
                break
            location = result.get("location")
            if not isinstance(location, str) or not location or len(location) > 2048 or re.search(r"[\x00-\x20\x7f\\]", location):
                error = "invalid-redirect-location"
                break
            destination = urljoin(current, location)
            parsed = urlsplit(destination)
            if parsed.username is not None or parsed.password is not None or origin(destination) != origin(url):
                error = "redirect-outside-configured-origin"
                break
            if hop >= 3:
                error = "redirect-limit-exceeded"
                break
            redirect, current = safe_redirect(destination), destination
    except ssl.SSLCertVerificationError:
        status, error = 0, "tls-verification-failed"
    except (TimeoutError, socket.timeout):
        status, error = 0, "probe-timeout"
    except ssl.SSLError:
        status, error = 0, "tls-probe-failed"
    except Exception:
        status, error = 0, "probe-connection-failed"
    return {"url": url, "at": timestamp(), "status": status, "ms": min(600000, max(0, round((monotonic() - started) * 1000))),
            "error": error, "redirect": redirect, "certNotAfter": certificate_end}


def collect(queue, cfg, reviewed_targets=False, probe_fn=probe):
    if reviewed_targets is not True:
        raise ValueError("collect requires explicit reviewed-targets flag")
    # Capacity is checked before contacting any endpoint. Collection never drops
    # older evidence to make room for a new probe.
    count, size = queue.db.execute("SELECT count(*),coalesce(sum(length(CAST(body AS BLOB))),0) FROM events").fetchone()
    if count >= _sender.MAX_ENTRIES or size + MAX_BODY > _sender.MAX_BYTES:
        raise ValueError("website queue capacity reached")
    checks = [probe_fn(url) for url in cfg["targets"]]
    batch = {"schemaVersion": 1, "batchId": "website." + str(uuid.uuid4()), "observedAt": stamp(), "checks": checks}
    body = encode(batch)
    if len(body.encode()) > MAX_BODY:
        raise ValueError("website batch exceeds bound")
    return queue.enqueue_body(body, batch["batchId"])


def receipt_for(value, batch, cfg):
    digest = hashlib.sha256(canonical(batch).encode()).hexdigest()
    expected_id = hashlib.sha256(canonical([cfg["host"], batch["batchId"], digest]).encode()).hexdigest()
    observed = round(dt.datetime.fromisoformat(batch["observedAt"].replace("Z", "+00:00")).timestamp() * 1000)
    if not isinstance(value, dict) or value.get("ok") is not True or value.get("accepted") is not True or value.get("batchId") != batch["batchId"] or value.get("digest") != digest or value.get("receiptId") != expected_id or value.get("observedAt") != observed or type(value.get("replay")) is not bool:
        raise ValueError("matching durable website receipt required")
    return {key: value[key] for key in ("ok", "accepted", "batchId", "digest", "receiptId", "observedAt", "replay")}


def deliver(cfg, body, timeout):
    batch = decode(body)
    request = urllib.request.Request(cfg["consoleUrl"] + "/api/v1/monitor/websites", method="POST",
        data=encode({"sourceId": cfg["sourceId"], "host": cfg["host"], "batch": batch}).encode(),
        headers={"Authorization": "Bearer " + read_token(cfg), "Content-Type": "application/json", "Accept": "application/json"})
    with PRIVATE_OPENER.open(request, timeout=min(timeout, 10)) as response:
        if response.status != 200 or response.headers.get_content_type() != "application/json":
            raise ValueError("unsupported website receipt response")
        raw = response.read(MAX_BODY + 1)
        if len(raw) > MAX_BODY:
            raise ValueError("website receipt exceeds bound")
        return receipt_for(decode(raw), batch, cfg)


def send(queue, cfg):
    deadline, sent = time.monotonic() + 45, 0
    for unused in range(16):
        row = queue.db.execute("SELECT id,body,state FROM events WHERE state!='delivered' AND abandoned_at IS NULL ORDER BY sequence LIMIT 1").fetchone()
        if not row or row[2] == "blocked" or time.monotonic() >= deadline:
            break
        batch_id, body, state = row
        with queue.db:
            queue.db.execute("UPDATE events SET attempts=attempts+1 WHERE id=?", (batch_id,))
        try:
            receipt = deliver(cfg, body, deadline - time.monotonic())
        except urllib.error.HTTPError as error:
            blocked = error.code in (400, 401, 403, 404, 405, 409, 413, 415, 422)
            with queue.db:
                queue.db.execute("UPDATE events SET state=?,last_status=? WHERE id=?", ("blocked" if blocked else "pending", error.code, batch_id))
            raise
        with queue.db:
            queue.db.execute("UPDATE events SET state='delivered',receipt=?,last_status=200 WHERE id=?", (encode(receipt), batch_id))
        sent += 1
    result = queue.status()
    result["deliveredThisRun"] = sent
    return result


def main():
    parser = Arguments(description=__doc__)
    parser.add_argument("command", choices=("collect", "send", "status", "retry", "abandon"))
    parser.add_argument("--config", required=True)
    parser.add_argument("--queue-dir", required=True)
    parser.add_argument("--reviewed-targets", action="store_true", help="confirm these explicit configured targets are approved for GET probes")
    parser.add_argument("--batch-id", help="retained batch for explicit retry or abandonment")
    parser.add_argument("--reason", help="bounded reason retained for explicit abandonment")
    args = parser.parse_args()
    if (args.command == "collect") != args.reviewed_targets or (args.command in ("retry", "abandon")) != bool(args.batch_id) or (args.command == "abandon") != bool(args.reason):
        parser.error("collect requires reviewed targets; retry requires batch identity")
    os.umask(0o077)
    cfg = load_config(args.config)
    queue = Queue(Path(args.queue_dir), cfg, lane="websites", binding_extra=sorted(cfg["targets"]))
    try:
        result = collect(queue, cfg, reviewed_targets=True) if args.command == "collect" else send(queue, cfg) if args.command == "send" else queue.retry(args.batch_id) if args.command == "retry" else queue.abandon(args.batch_id, args.reason) if args.command == "abandon" else queue.status()
        print(encode(result))
        return 1 if args.command == "send" and (result["counts"]["pending"] or result["counts"]["blocked"]) else 0
    finally:
        queue.close()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print("Website observer " + type(error).__name__ + ": probe or delivery could not complete; inspect private configuration and retained queue. No queued evidence was discarded.", file=sys.stderr)
        sys.exit(1)
