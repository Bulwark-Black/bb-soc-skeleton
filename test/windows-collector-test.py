import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("windows_collector", Path(__file__).resolve().parents[1] / "tools/collect-windows-events.py")
c = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(c)
XML = '<Event xmlns="http://schemas.microsoft.com/win/2004/08/events/event"><System><Provider Name="Microsoft-Windows-Security-Auditing"/><EventID>4625</EventID><Version>0</Version><TimeCreated SystemTime="2026-10-18T12:00:00.1234567Z"/><EventRecordID>18446744073709551615</EventRecordID><Channel>Security</Channel><Computer>server.example.invalid</Computer></System><EventData><Data Name="TargetUserName">synthetic-user</Data><Data Name="Status">0xc000006a</Data></EventData></Event>'

class CollectorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="windows-collector-test-")
        self.directory = Path(self.temp.name).resolve(); self.directory.chmod(0o700)
        self.token = self.directory / "credential"; self.token.write_text("x" * 40); self.token.chmod(0o600)
        self.cfg = {"schemaVersion": 1, "sourceId": "source-example", "estateId": "application-example", "consoleUrl": "http://localhost:3000", "tokenFile": str(self.token), "nodeExecutable": str(Path(shutil.which("node")).resolve()), "channels": ["Security"], "computers": ["server.example.invalid"], "maxEvents": 16}
        self.result = {"events": [XML], "bookmark": '<BookmarkList><Bookmark Channel="Security" RecordId="8"/></BookmarkList>', "creationTime": "synthetic-generation", "atLimit": False}
    def tearDown(self): self.temp.cleanup()
    def mapper(self, cfg, events):
        # The real JS adapter is tested above; isolated transaction tests don't
        # depend on the global vendor catalog having been wired by another task.
        return {"schemaVersion": "1", "documentType": "ingest-batch", "sourceId": cfg["sourceId"], "receiptId": "receipt-example", "sentAt": "2026-10-18T12:00:00.123Z", "records": events}
    def collect(self): return c.collect(self.directory, self.cfg, reader=lambda value: self.result, mapper=self.mapper)
    def receipt(self, cfg, batch):
        return {"schemaVersion": "1", "documentType": "ingest-receipt", "sourceId": cfg["sourceId"], "receiptId": batch["receiptId"], "status": "accepted", "accepted": len(batch["records"]), "duplicates": 0, "receivedAt": "2026-10-18T12:00:01.000Z", "replay": False}
    def test_xml_named_fields_userdata_and_identity(self):
        event = c.xml_event(XML, "Security", "epoch", self.cfg["computers"])
        self.assertEqual(event["eventRecordId"], "18446744073709551615")
        self.assertEqual(event["eventData"]["TargetUserName"], "synthetic-user")
        forwarded = c.xml_event(XML, "ForwardedEvents", "epoch", self.cfg["computers"])
        self.assertEqual(forwarded["collectionChannel"], "ForwardedEvents"); self.assertEqual(forwarded["channel"], "Security")
        user = XML[:XML.index('<EventData>')] + '<UserData><LogFileCleared xmlns="http://manifests.microsoft.com/win/2004/08/windows/eventlog"><SubjectUserSid>S-1-5-18</SubjectUserSid></LogFileCleared></UserData></Event>'
        self.assertEqual(c.xml_event(user, "Security", "epoch", self.cfg["computers"])["userData"]["SubjectUserSid"], "S-1-5-18")
        for xml in ['<!DOCTYPE Event [<!ENTITY x "bad">]>' + XML, XML.replace('Name="Status"', 'Name="TargetUserName"'), XML.replace('server.example.invalid', 'foreign.example.invalid')]:
            with self.assertRaises(ValueError): c.xml_event(xml, "Security", "epoch", self.cfg["computers"])
        with self.assertRaises(ValueError): c.xml_event(XML, "Application", "epoch", self.cfg["computers"])
    def test_spool_precedes_cursor_and_delivery_failure_retains_identical_batch(self):
        self.collect(); pending = (self.directory / "pending.json").read_bytes()
        self.assertFalse((self.directory / "state.json").exists())
        with self.assertRaises(OSError): c.send(self.directory, self.cfg, transport=lambda *a: (_ for _ in ()).throw(OSError("offline")))
        self.assertEqual((self.directory / "pending.json").read_bytes(), pending)
        def forbidden(_): self.fail("must not read past pending outbox")
        self.assertEqual(c.collect(self.directory, self.cfg, reader=forbidden)["state"], "pending-delivery")
        result = c.send(self.directory, self.cfg, transport=self.receipt)
        self.assertEqual(result["state"], "delivered"); self.assertFalse((self.directory / "pending.json").exists())
        state = c.load_state(self.directory, self.cfg)
        self.assertEqual(state["channels"]["Security"]["bookmark"], self.result["bookmark"])
        self.assertEqual(state["channels"]["Security"]["anchorHash"], hashlib.sha256(XML.encode()).hexdigest())
    def test_wrong_receipt_does_not_advance(self):
        self.collect()
        for override in ({"receiptId": "foreign"}, {"sourceId": "foreign"}, {"accepted": 0}, {"replay": "yes"}, {"receivedAt": "2026-02-30T00:00:00Z"}):
            with self.assertRaises(ValueError): c.send(self.directory, self.cfg, transport=lambda cfg, batch: dict(self.receipt(cfg, batch), **override))
            self.assertFalse((self.directory / "state.json").exists())
    def test_crash_after_checkpoint_before_retirement_recovers_without_duplicate_work(self):
        self.collect()
        original = Path.unlink
        def interrupted(path, *a, **kw):
            if path.name == "pending.json": raise OSError("simulated crash")
            return original(path, *a, **kw)
        with patch.object(Path, "unlink", interrupted), self.assertRaises(OSError): c.send(self.directory, self.cfg, transport=self.receipt)
        def forbidden(*_): self.fail("confirmed checkpoint can retire pending file without sending again")
        self.assertTrue(c.send(self.directory, self.cfg, transport=forbidden)["recovered"])
    def test_quiet_read_is_local_status_and_never_manufactures_health(self):
        self.result["events"] = []; self.result["bookmark"] = None
        result = self.collect()
        self.assertEqual(result["state"], "quiet"); self.assertFalse(result["serverHealthProof"])
        self.assertFalse((self.directory / "pending.json").exists())
    def test_failed_or_changed_channel_has_no_cursor_advance(self):
        with self.assertRaises(ValueError): c.collect(self.directory, self.cfg, reader=lambda _: (_ for _ in ()).throw(ValueError("stale bookmark")))
        self.assertFalse((self.directory / "state.json").exists()); self.assertTrue((self.directory / "failure.json").exists())
        self.collect(); c.send(self.directory, self.cfg, transport=self.receipt)
        prior = (self.directory / "state.json").read_bytes(); self.result["creationTime"] = "changed"
        with self.assertRaises(ValueError): self.collect()
        self.assertEqual((self.directory / "state.json").read_bytes(), prior)
    def test_configuration_binding_digest_and_revision_are_checked(self):
        self.collect()
        with self.assertRaises(ValueError): c.send(self.directory, dict(self.cfg, sourceId="foreign"), transport=self.receipt)
        pending = json.loads((self.directory / "pending.json").read_bytes()); pending["batch"]["receiptId"] = "changed"
        c.atomic_json(self.directory / "pending.json", pending)
        with self.assertRaises(ValueError): c.send(self.directory, self.cfg, transport=self.receipt)
    def test_xml_or_mapper_failure_is_atomic(self):
        for result in ({**self.result, "events": [XML, "<bad/>"]}, {**self.result, "bookmark": None}):
            with self.assertRaises(ValueError): c.collect(self.directory, self.cfg, reader=lambda _: result, mapper=self.mapper)
            self.assertFalse((self.directory / "pending.json").exists()); self.assertFalse((self.directory / "state.json").exists())
        with self.assertRaises(ValueError): c.collect(self.directory, self.cfg, reader=lambda _: self.result, mapper=lambda *args: (_ for _ in ()).throw(ValueError("mapping rejected")))
        self.assertFalse((self.directory / "state.json").exists())
    def test_private_files_origins_platform_and_lock(self):
        self.assertEqual(c.private_origin("http://localhost:3000"), self.cfg["consoleUrl"])
        for origin in ["https://example.invalid", "http://" + ".".join(["10", "0", "0", "1"]), "http:" + "//user" + "@localhost", "http://localhost/path"]:
            with self.assertRaises(ValueError): c.private_origin(origin)
        if os.name != "nt":
            with self.assertRaises(ValueError): c.powershell({"mode": "read"})
            self.token.chmod(0o644)
            with self.assertRaises(ValueError): c.read_private(self.token)
            self.token.chmod(0o600)
            link = self.directory / "link"; link.symlink_to(self.token)
            with self.assertRaises(ValueError): c.read_private(link)
        with c.locked(self.directory):
            with self.assertRaises(OSError):
                with c.locked(self.directory): pass
    def test_real_node_mapper_produces_canonical_batch_and_replay_identity(self):
        event = c.xml_event(XML, "Security", "synthetic-epoch", self.cfg["computers"])
        batch = c.normalize(self.cfg, [event])
        self.assertEqual(batch["documentType"], "ingest-batch")
        self.assertEqual(batch["records"][0]["kind"], "log.event")
        self.assertEqual(batch["records"][0]["payload"]["fields"]["win.Status"], "0xc000006a")
        self.assertEqual(batch, c.normalize(self.cfg, [event]))
        other = c.normalize(dict(self.cfg, sourceId="another-source"), [event])
        self.assertNotEqual(batch["records"][0]["recordId"], other["records"][0]["recordId"])

    def test_historical_event_uses_frozen_delivery_time_without_rewriting_evidence(self):
        original_time = "2024-10-18T12:00:00.1234567Z"
        old = dict(self.result, events=[XML.replace("2026-10-18T12:00:00.1234567Z", original_time)])
        delivery_time = "2026-10-18T12:00:00.000Z"
        with patch.object(c, "stamp", return_value=delivery_time):
            c.collect(self.directory, self.cfg, reader=lambda _: old)
        pending = json.loads((self.directory / "pending.json").read_bytes())
        self.assertEqual(pending["batch"]["sentAt"], delivery_time)
        record = pending["batch"]["records"][0]
        self.assertEqual(record["observedAt"], "2024-10-18T12:00:00.123Z")
        self.assertEqual(record["payload"]["fields"]["eventTime"], original_time)
        before = (self.directory / "pending.json").read_bytes()
        with patch.object(c, "stamp", return_value="2026-10-19T12:00:00.000Z"):
            with self.assertRaises(OSError): c.send(self.directory, self.cfg, transport=lambda *a: (_ for _ in ()).throw(OSError("offline")))
        self.assertEqual((self.directory / "pending.json").read_bytes(), before)

    def test_bookmark_reader_consumes_anchor_before_continuing_the_same_query(self):
        # Static guard for the native API regression. Linux cannot execute the
        # Windows EventLogReader; live platform commissioning is still required.
        script = c.NATIVE_SCRIPT
        self.assertEqual(script.count("New-Object System.Diagnostics.Eventing.Reader.EventLogReader("), 1)
        self.assertIn("$reader.Seek($bookmark, 0)", script)
        self.assertIn("$anchor = $reader.ReadEvent()", script)
        self.assertIn("$record = $reader.ReadEvent()", script)
        self.assertLess(script.index("$actual -ne $p.anchorHash"), script.index("$record = $reader.ReadEvent()"))
        self.assertNotIn("EventLogReader($query,$bookmark)", script)

    def test_resumed_quiet_read_preserves_anchor_and_next_collection_continues(self):
        c.collect(self.directory, self.cfg, reader=lambda _: self.result)
        c.send(self.directory, self.cfg, transport=self.receipt)
        before = c.load_state(self.directory, self.cfg)["channels"]["Security"]
        def quiet(request):
            self.assertEqual(request["bookmark"], before["bookmark"])
            self.assertEqual(request["anchorHash"], before["anchorHash"])
            return dict(self.result, events=[])
        self.assertEqual(c.collect(self.directory, self.cfg, reader=quiet)["state"], "quiet")
        self.assertFalse((self.directory / "pending.json").exists())
        after = c.load_state(self.directory, self.cfg)["channels"]["Security"]
        for key in ["bookmark", "anchorHash", "logEpoch", "creationTime"]: self.assertEqual(after[key], before[key])
        next_xml = XML.replace("18446744073709551615", "18446744073709551614")
        def new_event(request):
            self.assertEqual(request["bookmark"], before["bookmark"])
            return dict(self.result, events=[next_xml], bookmark="synthetic-next-bookmark")
        c.collect(self.directory, self.cfg, reader=new_event)
        pending = json.loads((self.directory / "pending.json").read_bytes())
        self.assertEqual(len(pending["batch"]["records"]), 1)
        self.assertEqual(pending["batch"]["records"][0]["payload"]["fields"]["eventRecordId"], "18446744073709551614")
        c.send(self.directory, self.cfg, transport=self.receipt)
        self.assertEqual(c.load_state(self.directory, self.cfg)["channels"]["Security"]["bookmark"], "synthetic-next-bookmark")

    def test_recollected_records_keep_identity_but_new_delivery_time_has_new_receipt(self):
        receipts = {}
        batches = []
        def transport(cfg, batch):
            body = c.encoded(batch)
            if batch["receiptId"] in receipts:
                self.assertEqual(receipts[batch["receiptId"]], body, "Same receipt with changed body would be a server 409")
            receipts[batch["receiptId"]] = body
            batches.append(batch)
            return self.receipt(cfg, batch)
        for instant in ["2026-10-18T12:00:00.000Z", "2026-10-18T12:00:01.000Z"]:
            with patch.object(c, "stamp", return_value=instant): c.collect(self.directory, self.cfg, reader=lambda _: self.result)
            c.send(self.directory, self.cfg, transport=transport)
        self.assertEqual(batches[0]["records"], batches[1]["records"])
        self.assertNotEqual(batches[0]["receiptId"], batches[1]["receiptId"])
        for batch in batches:
            identity = dict(batch); identity.pop("receiptId")
            self.assertEqual(batch["receiptId"], "windows:" + hashlib.sha256(c.encoded(identity)).hexdigest())

    def test_config_check_does_not_collect_or_send(self):
        cfgfile = self.directory / "config.json"; c.atomic_json(cfgfile, self.cfg)
        checked = c.config_file(cfgfile)
        self.assertEqual(checked, self.cfg)
        self.assertFalse((self.directory / "pending.json").exists())
        changed = dict(self.cfg, channels=["Security", "Security"]); c.atomic_json(cfgfile, changed)
        with self.assertRaises(ValueError): c.config_file(cfgfile)

if __name__ == '__main__': unittest.main()
