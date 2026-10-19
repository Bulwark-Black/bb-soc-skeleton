"""Synthetic native collector tests: no host probes or network requests."""
import contextlib
import datetime as dt
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import types
import unittest
from unittest.mock import patch
import uuid

ROOT = Path(__file__).resolve().parents[1]
COLLECTOR = ROOT / "tools/native-monitor/collector.py"
spec = importlib.util.spec_from_file_location("native_collector", COLLECTOR)
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

class NativeCollectorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soc-native-agent-")
        self.root = Path(self.temp.name).resolve()
        self.base = self.root / "state"
        self.token = self.root / "source-token"
        self.token.write_text("A" * 48 + "\n")
        self.token.chmod(0o600)
        self.config = self.root / "config.json"
        self.input = {"schemaVersion": 1, "host": "server-a", "sourceId": "source-a",
                      "consoleUrl": "http://127.0.0.1:8080", "tokenFile": str(self.token),
                      "services": [{"unit": "example.service"}]}
        self.config.write_text(json.dumps(self.input))
        self.config.chmod(0o600)
        self.cfg = agent.load_config(self.config)
        agent.prepare(self.base)

    def tearDown(self):
        self.temp.cleanup()

    def batch(self, sequence=1, stream=None):
        return {"schemaVersion": 1, "sourceId": "source-a", "streamId": stream or str(uuid.uuid4()),
                "sequence": sequence, "batchId": str(uuid.uuid4()), "observedAt": agent.stamp(),
                "bootId": str(uuid.uuid4()), "monotonicNs": "1000000", "collectorVersion": "fixture-1",
                "configRevision": "a" * 64, "collection": {"ok": True, "durationMs": 1.25},
                "samples": [{"seriesId": "server-a.cpu.utilization_pct", "quality": "good", "value": 12.5}], "checks": []}

    def queue(self, count=1):
        state = agent.state_for(self.base)
        agent.bind_state(self.cfg, state)
        batches = []
        for unused in range(count):
            state["sequence"] += 1
            batch = self.batch(state["sequence"], state["streamId"])
            name = str(batch["sequence"]).zfill(16) + "-" + batch["batchId"] + ".json"
            agent.atomic_json(self.base / "outbox" / name, batch)
            batches.append(batch)
        agent.atomic_json(self.base / "state.json", state)
        return batches

    def receipt(self, batch):
        return {"ok": True, "accepted": True, "batchId": batch["batchId"],
                "digest": hashlib.sha256(agent.canonical(batch).encode()).hexdigest(), "receiptId": "b" * 64,
                "replay": False, "observedAt": round(dt.datetime.fromisoformat(batch["observedAt"].replace("Z", "+00:00")).timestamp() * 1000)}

    def test_origins_are_private_explicit_without_redirects_or_proxies(self):
        private_host = ".".join(("10", "1", "2", "3"))
        shared_host = ".".join(("100", "64", "0", "1"))
        tailnet_host = ".".join(("host", "example", "ts", "net"))
        for value in ("http://127.0.0.1:8080", "http://[::1]:8080", "https://" + private_host, "https://" + shared_host, "https://" + tailnet_host):
            self.assertTrue(agent.private_origin(value))
        for value in ("https://example.invalid", "http://" + private_host, "http://" + ".".join(("127", "1")), "http://" + str(2130706433),
                      "http://localhost/path", "http://" + "user" + ":" + "pass" + "@localhost", "http://localhost?x=y", "http://localhost" + ":0", "http://localhost/%2f"):
            with self.assertRaises(ValueError):
                agent.private_origin(value)
        self.assertIsNone(agent.NoRedirect().redirect_request(None, None, 302, "redirect", {}, "https://example.invalid"))
        self.assertFalse(any(isinstance(h, agent.urllib.request.ProxyHandler) and h.proxies for h in agent.PRIVATE_OPENER.handlers))

    def test_config_requires_explicit_source_and_check_config_has_no_side_effects(self):
        self.assertEqual(self.cfg["sourceId"], "source-a")
        untouched = self.root / "never-created"
        output = subprocess.run(["python3", str(COLLECTOR), "check-config", "--config", str(self.config), "--state-dir", str(untouched)],
                                capture_output=True, timeout=5, check=False)
        self.assertEqual(output.returncode, 0, output.stderr.decode())
        self.assertFalse(untouched.exists())
        self.assertEqual(json.loads(output.stdout)["host"], "server-a")
        self.assertNotIn("A" * 48, output.stdout.decode())
        bad = dict(self.input, sourceId="")
        self.config.write_text(json.dumps(bad))
        with self.assertRaises(ValueError):
            agent.load_config(self.config)

    def test_private_token_refuses_service_tokens_links_and_fifo(self):
        self.assertEqual(agent.read_token(self.cfg), "A" * 48)
        self.token.chmod(0o644)
        with self.assertRaises(ValueError):
            agent.read_token(self.cfg)
        self.token.chmod(0o600)
        self.token.write_text("bbsvc_" + "A" * 48)
        with self.assertRaises(ValueError):
            agent.read_token(self.cfg)
        linked = self.root / "link"
        linked.symlink_to(self.token)
        with self.assertRaises(ValueError):
            agent.read_regular(linked)
        fifo = self.root / "fifo"
        os.mkfifo(fifo, 0o600)
        with self.assertRaises(ValueError):
            agent.read_regular(fifo)

    def test_cpu_first_sample_reboot_and_counter_reset_are_unknown(self):
        previous = {"total": 100, "idle": 60, "bootId": "boot-1", "monotonicNs": 1000}
        current = {"total": 200, "idle": 100, "bootId": "boot-1", "monotonicNs": 2000}
        self.assertEqual(agent.cpu_delta(current, previous)[0], 60)
        self.assertIsNone(agent.cpu_delta(current, None)[0])
        self.assertIsNone(agent.cpu_delta(dict(current, bootId="boot-2"), previous)[0])
        self.assertIsNone(agent.cpu_delta(dict(current, total=99), previous)[0])
        with self.assertRaises(ValueError):
            agent.parse_cpu("cpu 1 -1 1 1 1 1 1 1")

    def test_synthetic_collection_uses_source_identity_and_preserves_measured_failure(self):
        proc = self.root / "proc"
        (proc / "sys/kernel/random").mkdir(parents=True)
        (proc / "sys/kernel/random/boot_id").write_text(str(uuid.uuid4()))
        (proc / "stat").write_text("cpu 10 0 10 80 0 0 0 0\n")
        (proc / "meminfo").write_text("MemTotal: 1000 kB\nMemAvailable: 500 kB\nSwapTotal: 100 kB\nSwapFree: 100 kB\n")
        (proc / "loadavg").write_text("0.5 0.2 0.1 1/1 123\n")
        disk = types.SimpleNamespace(f_blocks=100, f_bfree=50, f_bavail=40, f_frsize=4096)
        def runner(argv, **kwargs):
            return 0, "LoadState=loaded\nActiveState=failed\nSubState=failed\nResult=exit-code"
        state = {"streamId": str(uuid.uuid4()), "sequence": 0}
        cfg = dict(self.cfg, postgres={"enabled": True})
        with patch.object(agent, "pg_result", side_effect=ValueError("synthetic unavailable")):
            batch, cpu = agent.collect_batch(cfg, state, proc=proc, statvfs=lambda p: disk, runner=runner)
        self.assertEqual(batch["sourceId"], "source-a")
        self.assertNotIn("host", batch)
        self.assertFalse(batch["collection"]["ok"])
        self.assertEqual(batch["checks"][0]["status"], "critical")
        self.assertEqual(batch["samples"][0]["quality"], "unknown")
        self.assertTrue(all(s["quality"] == "unknown" for s in batch["samples"] if ".postgres." in s["seriesId"]))
        self.assertIsNotNone(cpu)

    def test_canonical_batch_digest_matches_receiver_for_realistic_numeric_shapes(self):
        batch = self.batch()
        batch["samples"] = [{"value": n, "reason": "Synthetic café"} for n in (0, -0.0, 1.0, 0.5, 1e-7, 1e-6, 1e20, 1e21, 73.63746022588216, 4503599627370496)]
        script = "const {digest}=require('./server/native-monitor/store');let s='';process.stdin.on('data',b=>s+=b).on('end',()=>process.stdout.write(digest(JSON.parse(s))));"
        process = subprocess.run(["node", "-e", script], cwd=ROOT, input=json.dumps(batch).encode(), capture_output=True, timeout=10, check=False)
        self.assertEqual(process.returncode, 0, process.stderr.decode())
        self.assertEqual(hashlib.sha256(agent.canonical(batch).encode()).hexdigest(), process.stdout.decode())

    def test_sender_retains_exact_body_on_transport_and_unmatched_receipt_failure(self):
        batches = self.queue()
        target = next((self.base / "outbox").iterdir())
        original = target.read_bytes()
        with self.assertRaises(TimeoutError):
            agent.send(self.cfg, self.base, deliver_fn=lambda *args: (_ for _ in ()).throw(TimeoutError()))
        self.assertEqual(target.read_bytes(), original)
        wrong = dict(self.receipt(batches[0]), digest="0" * 64)
        with self.assertRaises(ValueError):
            agent.send(self.cfg, self.base, deliver_fn=lambda *args: wrong)
        self.assertEqual(target.read_bytes(), original)
        agent.send(self.cfg, self.base, deliver_fn=lambda *args: self.receipt(batches[0]))
        self.assertFalse(target.exists())
        self.assertEqual(agent.read_json(self.base / "last-delivery.json")["batchId"], batches[0]["batchId"])

    def test_sender_drains_sixteen_then_resumes_without_reordering(self):
        batches = self.queue(18)
        sent = []
        def deliver(cfg, body, timeout):
            batch = json.loads(body); sent.append(batch["sequence"])
            return self.receipt(batch)
        agent.send(self.cfg, self.base, deliver_fn=deliver)
        self.assertEqual(sent, list(range(1, 17)))
        self.assertEqual(len(list((self.base / "outbox").iterdir())), 2)
        agent.send(self.cfg, self.base, deliver_fn=deliver)
        self.assertEqual(sent, list(range(1, 19)))

    def test_direct_http_envelope_uses_source_credential_and_matching_receipt(self):
        batch = self.batch()
        class Response:
            status = 200
            headers = types.SimpleNamespace(get_content_type=lambda: "application/json")
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def read(inner, maximum): return json.dumps(self.receipt(batch)).encode()
        captured = []
        def open_request(request, timeout):
            captured.append((request, timeout)); return Response()
        with patch.object(agent.PRIVATE_OPENER, "open", side_effect=open_request):
            agent.deliver(self.cfg, json.dumps(batch).encode(), 20)
        request, timeout = captured[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:8080/api/v1/monitor/batches")
        self.assertEqual(request.get_header("Authorization"), "Bearer " + "A" * 48)
        self.assertEqual(json.loads(request.data), {"sourceId": "source-a", "host": "server-a", "batch": batch})
        self.assertEqual(timeout, 15)

    def test_pending_crash_recovery_and_gap_ledger_are_durable(self):
        batch = self.batch()
        state = {"schemaVersion": 1, "streamId": batch["streamId"], "sequence": 0}
        agent.bind_state(self.cfg, state)
        name = "0000000000000001-" + batch["batchId"] + ".json"
        state.update(sequence=1, pending={"name": name, "batch": batch})
        agent.atomic_json(self.base / "state.json", state)
        agent.recover_pending(self.base, state)
        self.assertEqual(agent.read_json(self.base / "outbox" / name), batch)
        self.assertNotIn("pending", agent.read_json(self.base / "state.json"))
        gap = agent.prune(self.base, self.base / "outbox", agent.BATCH_NAME, 0, 0)
        self.assertEqual(gap["discarded"], 1)
        self.assertEqual(gap["recent"][0]["reason"], "capacity")
        self.assertFalse((self.base / "outbox" / name).exists())
        self.assertEqual(agent.read_json(self.base / "gaps-outbox.json")["pending"], [])

    def test_source_or_console_rebinding_cannot_send_existing_outbox(self):
        self.queue()
        for cfg in (dict(self.cfg, sourceId="source-b"), dict(self.cfg, consoleUrl="https://" + ".".join(("host", "example", "ts", "net")))):
            with self.assertRaises(ValueError):
                agent.send(cfg, self.base, deliver_fn=lambda *args: self.fail("network must not be reached"))
        self.assertEqual(len(list((self.base / "outbox").iterdir())), 1)

if __name__ == "__main__":
    unittest.main()
