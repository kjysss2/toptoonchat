import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts import sync_tracker_totals as sync


def source_payload():
    rows = []
    for site, base in (("kr", 1000), ("tw", 2000), ("global", 3000), ("jp", 4000)):
        for offset, day in enumerate(("2026-09-01", "2026-09-02")):
            rows.append({"site": site, "date": day, "total_views": base + offset * 10, "total_chats": base // 10 + offset})
    return {"rows": rows}


def direct_snapshot(day: str, *, valid: bool) -> dict:
    snapshot = {"captured_at": f"{day}T08:00:00+09:00", "items": []}
    if valid:
        snapshot["totals"] = {"view_count": 10, "chat_count": 2, "observed_items": 5}
    else:
        snapshot["items"] = [{"rank": 1, "name": "legacy"}]
    return snapshot


class TrackerTotalsTest(unittest.TestCase):
    def histories(self, directory: str) -> dict[str, Path]:
        paths = {market: Path(directory) / f"{market}.json" for market in sync.MARKET_FILES}
        for market, path in paths.items():
            snapshots = [direct_snapshot("2026-09-01", valid=market == "kr")]
            path.write_text(json.dumps({"schema_version": 2, "market": market, "snapshots": snapshots}), encoding="utf-8")
        return paths

    def test_backfills_only_missing_calendar_days_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = self.histories(directory)
            with patch.object(sync, "fetch_json", return_value=source_payload()):
                changed = sync.backfill(paths)
            self.assertEqual(changed, {"kr": 1, "tw": 1, "us": 1, "jp": 1})

            kr = json.loads(paths["kr"].read_text(encoding="utf-8"))
            self.assertEqual(len(kr["snapshots"]), 1)
            self.assertEqual(kr["schema_version"], 3)
            self.assertEqual([row["captured_kst"][:10] for row in kr["tracker_totals"]], ["2026-09-02"])

            us = json.loads(paths["us"].read_text(encoding="utf-8"))
            self.assertEqual(us["tracker_totals"][0]["totals"]["view_count"], 3010)
            self.assertEqual(us["tracker_totals"][0]["source"], "toptoon-tracker")
            self.assertNotIn("items", us["tracker_totals"][0])
            original = {market: path.read_bytes() for market, path in paths.items()}
            with patch.object(sync, "fetch_json", return_value=source_payload()):
                self.assertEqual(sync.backfill(paths), {"kr": 0, "tw": 0, "us": 0, "jp": 0})
            self.assertEqual({market: path.read_bytes() for market, path in paths.items()}, original)

    def test_invalid_source_leaves_all_histories_unchanged(self):
        invalid = copy.deepcopy(source_payload())
        invalid["rows"][0]["total_chats"] = -1
        with tempfile.TemporaryDirectory() as directory:
            paths = self.histories(directory)
            original = {market: path.read_bytes() for market, path in paths.items()}
            with patch.object(sync, "fetch_json", return_value=invalid):
                with self.assertRaises(ValueError):
                    sync.backfill(paths)
            self.assertEqual({market: path.read_bytes() for market, path in paths.items()}, original)


if __name__ == "__main__":
    unittest.main()
