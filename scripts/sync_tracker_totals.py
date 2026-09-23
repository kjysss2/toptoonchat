#!/usr/bin/env python3
"""Fill missing daily country totals from the public Toptoon tracker."""
from __future__ import annotations

import json
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
SOURCE_ORIGIN = "https://toptoon-tracker.john6428.workers.dev"
SOURCE_URL = SOURCE_ORIGIN + "/api/site-totals-timeseries"
TRACKER_SITE_TO_MARKET = {"kr": "kr", "tw": "tw", "global": "us", "jp": "jp"}
MARKET_FILES = {
    "kr": ROOT / "dist" / "data" / "snapshots.json",
    "tw": ROOT / "dist" / "data" / "snapshots-tw.json",
    "us": ROOT / "dist" / "data" / "snapshots-us.json",
    "jp": ROOT / "dist" / "data" / "snapshots-jp.json",
}
KST = timezone(timedelta(hours=9), "KST")
USER_AGENT = "ToptoonChatCounter/2.2 (public-tracker-total-backfill)"


def fetch_json(url: str = SOURCE_URL) -> dict[str, Any]:
    request = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            with urlopen(request, timeout=30) as response:  # nosec B310 -- fixed public HTTPS source
                payload = json.loads(
                    response.read().decode("utf-8"),
                    parse_constant=lambda value: (_ for _ in ()).throw(ValueError(f"Non-standard JSON number: {value}")),
                )
            if not isinstance(payload, dict):
                raise ValueError("Tracker response must be a JSON object")
            return payload
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError, ValueError) as error:
            last_error = error
            if isinstance(error, HTTPError) and error.code not in (429, 500, 502, 503, 504):
                break
            if attempt < 2:
                time.sleep(2 ** (attempt + 1))
    raise RuntimeError(f"Could not fetch tracker totals: {last_error}")


def parse_day(value: Any, label: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{label} is missing a YYYY-MM-DD date")
    try:
        parsed = date.fromisoformat(value)
    except ValueError as error:
        raise ValueError(f"{label} has an invalid date: {value!r}") from error
    if parsed.isoformat() != value:
        raise ValueError(f"{label} is missing a YYYY-MM-DD date")
    return value


def is_non_negative_integer(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def tracker_rows(payload: dict[str, Any]) -> dict[str, list[dict[str, int | str]]]:
    rows = payload.get("rows")
    if not isinstance(rows, list) or not rows:
        raise ValueError("Tracker totals rows are missing")
    grouped: dict[str, list[dict[str, int | str]]] = {market: [] for market in MARKET_FILES}
    seen: set[tuple[str, str]] = set()
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            raise ValueError(f"Tracker row {index} has an unexpected format")
        source_site = row.get("site")
        if source_site not in TRACKER_SITE_TO_MARKET:
            continue
        source_day = parse_day(row.get("date"), f"Tracker row {index}")
        if not is_non_negative_integer(row.get("total_views")) or not is_non_negative_integer(row.get("total_chats")):
            raise ValueError(f"Tracker row {index} has invalid View or Chat totals")
        market = TRACKER_SITE_TO_MARKET[source_site]
        key = (market, source_day)
        if key in seen:
            raise ValueError(f"Tracker has duplicate totals for {market} on {source_day}")
        seen.add(key)
        grouped[market].append({"date": source_day, "view_count": row["total_views"], "chat_count": row["total_chats"]})
    if any(not grouped[market] for market in MARKET_FILES):
        raise ValueError("Tracker totals are missing one or more supported markets")
    for rows_for_market in grouped.values():
        rows_for_market.sort(key=lambda row: str(row["date"]))
    return grouped


def snapshot_day(snapshot: dict[str, Any]) -> str | None:
    timestamp = snapshot.get("captured_at")
    if not isinstance(timestamp, str):
        return None
    try:
        parsed = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            return None
        return parsed.astimezone(KST).date().isoformat()
    except ValueError:
        return None


def has_totals(snapshot: dict[str, Any]) -> bool:
    totals = snapshot.get("totals")
    if isinstance(totals, dict) and is_non_negative_integer(totals.get("view_count")) and is_non_negative_integer(totals.get("chat_count")):
        return True
    items = snapshot.get("items")
    return isinstance(items, list) and any(
        isinstance(item, dict) and is_non_negative_integer(item.get("view_count")) and is_non_negative_integer(item.get("chat_count"))
        for item in items
    )


def load_history(path: Path) -> dict[str, Any]:
    history = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(history, dict) or not isinstance(history.get("snapshots"), list):
        raise ValueError(f"{path.name} has an unexpected format")
    tracker_totals = history.get("tracker_totals", [])
    if not isinstance(tracker_totals, list) or not all(isinstance(snapshot, dict) for snapshot in tracker_totals):
        raise ValueError(f"{path.name} has an unexpected tracker_totals format")
    return history


def tracker_snapshot(row: dict[str, int | str]) -> dict[str, Any]:
    source_day = str(row["date"])
    return {
        "captured_at": f"{source_day}T12:00:00+09:00",
        "captured_kst": f"{source_day} 원본 트래커 일별 합계",
        "source": "toptoon-tracker",
        "source_url": SOURCE_URL,
        "totals": {"view_count": row["view_count"], "chat_count": row["chat_count"], "observed_items": None},
    }


def backfill_history(history: dict[str, Any], rows: list[dict[str, int | str]]) -> int:
    # A calendar date already present in the user's direct history always wins,
    # even when that legacy snapshot has no counters.  The tracker is only a
    # source for dates that do not exist locally at all.
    direct_dates = {day for snapshot in history["snapshots"] if (day := snapshot_day(snapshot))}
    tracker_totals = history.setdefault("tracker_totals", [])
    tracker_dates = {day for snapshot in tracker_totals if has_totals(snapshot) if (day := snapshot_day(snapshot))}
    additions = [tracker_snapshot(row) for row in rows if row["date"] not in direct_dates and row["date"] not in tracker_dates]
    if not additions:
        return 0
    tracker_totals.extend(additions)
    tracker_totals.sort(key=lambda snapshot: snapshot_day(snapshot) or "")
    history["schema_version"] = max(3, int(history.get("schema_version", 2)))
    return len(additions)


def write_history(path: Path, history: dict[str, Any]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(history, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def backfill(data_files: dict[str, Path] = MARKET_FILES) -> dict[str, int]:
    rows_by_market = tracker_rows(fetch_json())
    histories = {market: load_history(path) for market, path in data_files.items()}
    changed = {market: backfill_history(histories[market], rows_by_market[market]) for market in data_files}
    for market, count in changed.items():
        if count:
            write_history(data_files[market], histories[market])
    return changed


def main() -> int:
    try:
        changed = backfill()
    except Exception as error:
        print(f"Tracker total backfill failed: {error}", file=sys.stderr)
        return 1
    print("Tracker total backfill: " + ", ".join(f"{market} +{count}" for market, count in changed.items()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
