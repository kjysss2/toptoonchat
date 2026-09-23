#!/usr/bin/env python3
"""Mirror the public global-expansion data into the static Pages payload."""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

SOURCE_ORIGIN = "https://toptoon-tracker.john6428.workers.dev"
ENDPOINTS = {
    "comparison": "/api/site-comparison",
    "timeseries": "/api/site-totals-timeseries",
    "traction": "/api/site-traction",
}
SITE_KEYS = ("kr", "global", "jp", "tw")
ROOT = Path(__file__).resolve().parents[1]
DATA_FILE = ROOT / "dist" / "data" / "global-expansion.json"
KST = timezone(timedelta(hours=9), "KST")
USER_AGENT = "ToptoonChatCounter/2.1 (public-global-data-mirror)"


def fetch_json(url: str) -> dict[str, Any]:
    """Read one fixed public JSON endpoint with bounded retries."""
    request = Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
        },
    )
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            with urlopen(request, timeout=30) as response:  # nosec B310 -- fixed public HTTPS source
                payload = json.loads(
                    response.read().decode("utf-8"),
                    parse_constant=lambda value: (_ for _ in ()).throw(
                        ValueError(f"Non-standard JSON number: {value}")
                    ),
                )
            if not isinstance(payload, dict):
                raise ValueError(f"Expected a JSON object from {url}")
            return payload
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError, ValueError) as error:
            last_error = error
            if isinstance(error, HTTPError) and error.code not in (429, 500, 502, 503, 504):
                break
            if attempt < 2:
                time.sleep(2 ** (attempt + 1))
    raise RuntimeError(f"Could not fetch {url}: {last_error}")


def is_non_negative_number(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
        and value >= 0
    )


def is_finite_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def is_nullable_non_negative_number(value: Any) -> bool:
    return value is None or is_non_negative_number(value)


def is_nullable_finite_number(value: Any) -> bool:
    return value is None or is_finite_number(value)


def require_iso_date(value: Any, label: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{label} is missing a YYYY-MM-DD date")
    try:
        parsed = date.fromisoformat(value)
    except ValueError as error:
        raise ValueError(f"{label} has an invalid date: {value!r}") from error
    if parsed.isoformat() != value:
        raise ValueError(f"{label} is missing a YYYY-MM-DD date")
    return value


def require_list(value: Any, label: str, *, minimum: int = 1) -> list[dict[str, Any]]:
    if not isinstance(value, list) or len(value) < minimum or not all(isinstance(item, dict) for item in value):
        raise ValueError(f"{label} has an unexpected format")
    return value


def validate_payload(comparison: dict[str, Any], timeseries: dict[str, Any], traction: dict[str, Any]) -> None:
    rows = require_list(comparison.get("rows"), "site-comparison rows", minimum=5)
    character_ids: set[int] = set()
    for index, row in enumerate(rows):
        character_id = row.get("character_id")
        if not isinstance(character_id, int) or isinstance(character_id, bool) or character_id <= 0 or character_id in character_ids:
            raise ValueError(f"site-comparison row {index} has an invalid or duplicate character ID")
        character_ids.add(character_id)
        if not isinstance(row.get("name"), str) or not row["name"].strip() or not is_non_negative_number(row.get("kr_chats")):
            raise ValueError("site-comparison rows are missing character names or Korean chat totals")
        for site in SITE_KEYS[1:]:
            chats_key, percentage_key = f"{site}_chats", f"{site}_pct"
            if chats_key not in row or percentage_key not in row:
                raise ValueError(f"site-comparison row {index} is missing {site} comparison data")
            chats, percentage = row[chats_key], row[percentage_key]
            if not is_nullable_non_negative_number(chats) or not is_nullable_non_negative_number(percentage):
                raise ValueError(f"site-comparison row {index} has an invalid {site} value")
            if (chats is None) != (percentage is None):
                raise ValueError(f"site-comparison row {index} has incomplete {site} comparison data")

    overall = comparison.get("overall")
    per_site = overall.get("per_site") if isinstance(overall, dict) else None
    if not isinstance(per_site, dict):
        raise ValueError("site-comparison overall totals are missing")
    for site in SITE_KEYS:
        site_total = per_site.get(site)
        if not isinstance(site_total, dict) or not all(
            is_non_negative_number(site_total.get(field)) for field in ("chats", "views", "char_count", "conversion_pct")
        ):
            raise ValueError(f"site-comparison total for {site} is missing or invalid")
    per_site_pct = overall.get("per_site_pct") if isinstance(overall, dict) else None
    if not isinstance(per_site_pct, dict) or not all(
        is_non_negative_number(per_site_pct.get(site)) for site in SITE_KEYS[1:]
    ):
        raise ValueError("site-comparison country shares are missing or invalid")
    if not is_non_negative_number(overall.get("overseas_total")) or not is_non_negative_number(overall.get("global_traction_pct")):
        raise ValueError("site-comparison overseas totals are missing or invalid")

    series_rows = require_list(timeseries.get("rows"), "site-totals-timeseries rows", minimum=4)
    observed_sites = set()
    for index, row in enumerate(series_rows):
        require_iso_date(row.get("date"), f"site-totals-timeseries row {index}")
        site = row.get("site")
        if site not in SITE_KEYS:
            raise ValueError(f"site-totals-timeseries row {index} has an unknown site")
        if not all(is_non_negative_number(row.get(field)) for field in ("total_views", "total_chats")):
            raise ValueError(f"site-totals-timeseries row {index} has invalid totals")
        observed_sites.add(site)
    if not set(SITE_KEYS).issubset(observed_sites):
        raise ValueError("site-totals-timeseries does not include every tracked site")

    daily = require_list(traction.get("daily"), "site-traction daily rows")
    for index, row in enumerate(daily):
        require_iso_date(row.get("date"), f"site-traction row {index}")
        if not all(is_nullable_finite_number(row.get(field)) for field in ("kr_delta", "overseas_delta")):
            raise ValueError(f"site-traction row {index} has invalid daily changes")


def latest_source_date(timeseries: dict[str, Any]) -> str | None:
    dates = [row.get("date") for row in timeseries.get("rows", []) if isinstance(row, dict) and isinstance(row.get("date"), str)]
    return max(dates) if dates else None


def build_payload(*, now: datetime | None = None) -> dict[str, Any]:
    comparison = fetch_json(SOURCE_ORIGIN + ENDPOINTS["comparison"])
    timeseries = fetch_json(SOURCE_ORIGIN + ENDPOINTS["timeseries"])
    traction = fetch_json(SOURCE_ORIGIN + ENDPOINTS["traction"])
    validate_payload(comparison, timeseries, traction)

    captured = now or datetime.now(timezone.utc)
    if captured.tzinfo is None:
        raise ValueError("Capture timestamp must include a timezone")
    captured = captured.astimezone(timezone.utc)
    return {
        "schema_version": 1,
        "source": {
            "name": "탑툰챗 방문자수 트래커",
            "origin": SOURCE_ORIGIN,
            "endpoints": {name: SOURCE_ORIGIN + path for name, path in ENDPOINTS.items()},
            "note": "Global(EN)은 미국 한정 수치가 아닌 영어권 글로벌 사이트 수치입니다.",
        },
        "captured_at": captured.isoformat().replace("+00:00", "Z"),
        "captured_kst": captured.astimezone(KST).strftime("%Y-%m-%d %H:%M KST"),
        "source_latest_date": latest_source_date(timeseries),
        "comparison": comparison,
        "timeseries": timeseries,
        "traction": traction,
    }


def source_snapshot(payload: dict[str, Any]) -> dict[str, Any]:
    """The source content whose changes should produce a new static commit."""
    return {
        key: payload.get(key)
        for key in ("schema_version", "source", "source_latest_date", "comparison", "timeseries", "traction")
    }


def read_existing_payload(destination: Path) -> dict[str, Any] | None:
    if not destination.exists():
        return None
    try:
        return json.loads(
            destination.read_text(encoding="utf-8"),
            parse_constant=lambda value: (_ for _ in ()).throw(
                ValueError(f"Non-standard JSON number: {value}")
            ),
        )
    except (OSError, json.JSONDecodeError, ValueError):
        return None


def write_payload(payload: dict[str, Any], destination: Path = DATA_FILE) -> bool:
    """Atomically update the static file only for current, changed source data."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    existing = read_existing_payload(destination)
    if existing:
        existing_date = existing.get("source_latest_date")
        incoming_date = payload.get("source_latest_date")
        if isinstance(existing_date, str) and isinstance(incoming_date, str):
            try:
                if date.fromisoformat(incoming_date) < date.fromisoformat(existing_date):
                    return False
            except ValueError:
                pass
        if source_snapshot(existing) == source_snapshot(payload):
            return False
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    temporary.replace(destination)
    return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DATA_FILE, help="Static JSON destination")
    args = parser.parse_args(argv)
    try:
        payload = build_payload()
        changed = write_payload(payload, args.output)
    except Exception as error:
        print(f"Global expansion sync failed: {error}", file=sys.stderr)
        return 1
    state = "Synced" if changed else "Kept current"
    print(f"{state} global expansion data ({len(payload['comparison']['rows'])} characters, source date {payload['source_latest_date'] or '-'})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
