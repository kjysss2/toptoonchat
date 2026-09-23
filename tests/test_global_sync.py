import copy
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from scripts import sync_global_expansion as sync


def sample_comparison():
    rows = [
        {"character_id": index, "name": f"캐릭터 {index}", "kr_chats": index * 100,
         "global_chats": index, "global_pct": index / 100,
         "jp_chats": index * 10, "jp_pct": index / 10,
         "tw_chats": index * 5, "tw_pct": index / 20}
        for index in range(1, 6)
    ]
    per_site = {
        site: {
            "chats": 1000 + index,
            "views": 2000 + index,
            "char_count": 5,
            "conversion_pct": 1 + index / 10,
        }
        for index, site in enumerate(sync.SITE_KEYS)
    }
    return {
        "rows": rows,
        "site_labels": {site: site for site in sync.SITE_KEYS},
        "overall": {
            "per_site": per_site,
            "per_site_pct": {site: index + 1 for index, site in enumerate(sync.SITE_KEYS[1:])},
            "overseas_total": 3003,
            "global_traction_pct": 300.3,
        },
    }


def sample_timeseries():
    return {"rows": [
        {"date": "2026-09-15", "site": site, "total_views": 100 + index, "total_chats": 10 + index}
        for index, site in enumerate(sync.SITE_KEYS)
    ] + [
        {"date": "2026-09-16", "site": "kr", "total_views": 200, "total_chats": 20}
    ]}


def sample_traction():
    return {"daily": [
        {"date": "2026-09-15", "kr_delta": 10, "overseas_delta": 5},
        {"date": "2026-09-16", "kr_delta": 12, "overseas_delta": 6},
    ], "data_start_by_site": {site: "2026-09-15" for site in sync.SITE_KEYS}}


class GlobalSyncTest(unittest.TestCase):
    def test_builds_static_payload_from_all_public_endpoints(self):
        responses = [sample_comparison(), sample_timeseries(), sample_traction()]
        with patch.object(sync, "fetch_json", side_effect=responses) as fetch:
            payload = sync.build_payload(now=datetime(2026, 9, 17, 0, 3, tzinfo=timezone.utc))

        self.assertEqual(fetch.call_count, 3)
        self.assertEqual(payload["schema_version"], 1)
        self.assertEqual(payload["captured_kst"], "2026-09-17 09:03 KST")
        self.assertEqual(payload["source_latest_date"], "2026-09-16")
        self.assertEqual(payload["comparison"]["overall"]["per_site"]["jp"]["chats"], 1002)
        self.assertIn("Global(EN)", payload["source"]["note"])

    def test_invalid_source_does_not_replace_existing_static_file(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "global-expansion.json"
            destination.write_text('{"existing": true}\n', encoding="utf-8")
            original = destination.read_bytes()
            invalid = sample_comparison()
            invalid["overall"]["per_site"].pop("tw")
            with patch.object(sync, "fetch_json", side_effect=[invalid, sample_timeseries(), sample_traction()]):
                with self.assertRaises(ValueError):
                    sync.build_payload()
            self.assertEqual(destination.read_bytes(), original)

    def test_atomic_write_creates_parseable_json(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "global-expansion.json"
            self.assertTrue(sync.write_payload({"schema_version": 1, "name": "테스트"}, destination))
            self.assertEqual(json.loads(destination.read_text(encoding="utf-8"))["name"], "테스트")
            self.assertFalse(destination.with_suffix(".json.tmp").exists())

    def test_unchanged_source_keeps_existing_capture_timestamp(self):
        payload = {
            "schema_version": 1,
            "source": {"origin": "https://example.test"},
            "source_latest_date": "2026-09-17",
            "comparison": sample_comparison(),
            "timeseries": sample_timeseries(),
            "traction": sample_traction(),
            "captured_at": "2026-09-17T00:00:00Z",
            "captured_kst": "2026-09-17 09:00 KST",
        }
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "global-expansion.json"
            self.assertTrue(sync.write_payload(payload, destination))
            repeated = copy.deepcopy(payload)
            repeated["captured_at"] = "2026-09-17T01:00:00Z"
            repeated["captured_kst"] = "2026-09-17 10:00 KST"
            self.assertFalse(sync.write_payload(repeated, destination))
            self.assertEqual(json.loads(destination.read_text(encoding="utf-8"))["captured_kst"], "2026-09-17 09:00 KST")

    def test_older_source_snapshot_does_not_replace_newer_file(self):
        payload = {
            "schema_version": 1,
            "source": {"origin": "https://example.test"},
            "source_latest_date": "2026-09-17",
            "comparison": sample_comparison(),
            "timeseries": sample_timeseries(),
            "traction": sample_traction(),
        }
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "global-expansion.json"
            self.assertTrue(sync.write_payload(payload, destination))
            older = copy.deepcopy(payload)
            older["source_latest_date"] = "2026-09-16"
            older["comparison"]["rows"][0]["kr_chats"] = 999999
            self.assertFalse(sync.write_payload(older, destination))
            self.assertEqual(json.loads(destination.read_text(encoding="utf-8"))["source_latest_date"], "2026-09-17")

    def test_rejects_non_finite_numbers_and_invalid_dates(self):
        invalid_comparison = sample_comparison()
        invalid_comparison["rows"][0]["global_chats"] = float("inf")
        with self.assertRaises(ValueError):
            sync.validate_payload(invalid_comparison, sample_timeseries(), sample_traction())

        duplicate_ids = sample_comparison()
        duplicate_ids["rows"][1]["character_id"] = duplicate_ids["rows"][0]["character_id"]
        with self.assertRaises(ValueError):
            sync.validate_payload(duplicate_ids, sample_timeseries(), sample_traction())

        invalid_timeseries = sample_timeseries()
        invalid_timeseries["rows"][0]["date"] = "2026-9-15"
        with self.assertRaises(ValueError):
            sync.validate_payload(sample_comparison(), invalid_timeseries, sample_traction())


if __name__ == "__main__":
    unittest.main()
