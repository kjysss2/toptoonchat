import copy
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from scripts import scrape_ranking as scraper


def at(value):
    return datetime.fromisoformat(value)


def snapshot(timestamp):
    return {"captured_at": timestamp, "items": [
        {"key": f"character:{i}", "view_count": i + 10, "chat_count": i + 1}
        for i in range(5)
    ]}


class CaptureSafeguardsTest(unittest.TestCase):
    def test_before_morning_waits_but_seven_is_due(self):
        history = {"snapshots": []}
        self.assertFalse(scraper.capture_due(history, at("2026-09-10T06:59:59+09:00")))
        self.assertTrue(scraper.capture_due(history, at("2026-09-10T07:00:00+09:00")))

    def test_late_schedule_keeps_first_morning_snapshot(self):
        history = {"snapshots": [snapshot("2026-09-09T22:01:00Z")]}
        original = copy.deepcopy(history)
        self.assertFalse(scraper.capture_due(history, at("2026-09-10T08:47:00+09:00")))
        self.assertEqual(history, original)

    def test_midnight_manual_capture_does_not_suppress_morning(self):
        history = {"snapshots": [snapshot("2026-09-10T00:15:00+09:00")]}
        self.assertTrue(scraper.capture_due(history, at("2026-09-10T07:00:00+09:00")))

    def test_yesterday_and_legacy_ranking_do_not_suppress_capture(self):
        previous = snapshot("2026-09-09T07:01:00+09:00")
        legacy = {"captured_at": "2026-09-10T07:01:00+09:00", "items": [{"rank": 1}] * 5}
        self.assertTrue(scraper.capture_due({"snapshots": [previous, legacy]}, at("2026-09-10T08:00:00+09:00")))

    def test_skip_makes_no_network_request_and_no_write(self):
        now = datetime.now(timezone.utc)
        history = {"snapshots": [snapshot(now.isoformat())]}
        with patch.object(scraper, "load_history", return_value=history), patch.object(scraper, "capture_items") as capture, patch.object(scraper, "write_history") as write:
            self.assertEqual(scraper.main(["--market", "kr"]), 0)
            capture.assert_not_called()
            write.assert_not_called()

    def test_manual_force_still_captures(self):
        result = {"totals": {"observed_items": 5}, "captured_kst": "2026-09-10 07:01 KST"}
        with patch.object(scraper, "load_history", return_value={"snapshots": []}), patch.object(scraper, "capture_due", return_value=False), patch.object(scraper, "capture_items", return_value=[]) as capture, patch.object(scraper, "write_history", return_value=result):
            self.assertEqual(scraper.main(["--force", "--market", "kr"]), 0)
            capture.assert_called_once()

    def test_failed_capture_preserves_existing_file(self):
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory) / "snapshots.json"
            data.write_text('{"snapshots": []}', encoding="utf-8")
            original = data.read_bytes()
            with patch.object(scraper, "DATA_FILE", data), patch.object(scraper, "capture_items", side_effect=RuntimeError("source unavailable")):
                self.assertEqual(scraper.main(["--force", "--market", "kr"]), 1)
            self.assertEqual(data.read_bytes(), original)

    def test_atomic_write_replaces_same_kst_day_and_appends_next(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(scraper, "DATA_FILE", Path(directory) / "snapshots.json"):
            history = {"snapshots": []}
            items = snapshot("2026-09-10T07:00:00+09:00")["items"]
            scraper.write_history(history, items, now=at("2026-09-09T22:01:00+00:00"))
            scraper.write_history(history, items, now=at("2026-09-10T00:01:00+00:00"))
            self.assertEqual(len(history["snapshots"]), 1)
            scraper.write_history(history, items, now=at("2026-09-10T22:01:00+00:00"))
            self.assertEqual(len(json.loads(scraper.DATA_FILE.read_text(encoding="utf-8"))["snapshots"]), 2)
            self.assertFalse(scraper.DATA_FILE.with_suffix(".json.tmp").exists())

    def test_japan_market_uses_japanese_origin_and_separate_history(self):
        config = scraper.site_config("jp")
        self.assertEqual(config["base_url"], "https://chat.toptoon.jp")
        self.assertEqual(scraper.data_file_for("jp"), scraper.JAPAN_DATA_FILE)
        self.assertNotEqual(scraper.data_file_for("jp"), scraper.DATA_FILE)

    def test_taiwan_market_uses_taiwanese_origin_and_separate_history(self):
        config = scraper.site_config("tw")
        self.assertEqual(config["base_url"], "https://chat.toptoon.net")
        self.assertEqual(scraper.data_file_for("tw"), scraper.TAIWAN_DATA_FILE)
        self.assertNotIn(scraper.data_file_for("tw"), (scraper.DATA_FILE, scraper.JAPAN_DATA_FILE))

    def test_us_market_uses_global_origin_and_separate_history(self):
        config = scraper.site_config("us")
        self.assertEqual(config["base_url"], "https://chat.global.toptoon.com")
        self.assertEqual(scraper.data_file_for("us"), scraper.US_DATA_FILE)
        self.assertNotIn(scraper.data_file_for("us"), (scraper.DATA_FILE, scraper.JAPAN_DATA_FILE, scraper.TAIWAN_DATA_FILE))


if __name__ == "__main__":
    unittest.main()
