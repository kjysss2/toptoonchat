#!/usr/bin/env python3
"""Capture the public Toptoon Chat character-ranking payload once per day.

This scraper deliberately makes one anonymous GET request to the public, robots-allowed
ranking page. It does not log in, access chat routes, send messages, or download images.
"""

from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo


SOURCE_URL = "https://chat.toptoon.com/ranking"
ROOT = Path(__file__).resolve().parents[1]
DATA_FILE = ROOT / "dist" / "data" / "snapshots.json"
KST = ZoneInfo("Asia/Seoul")
USER_AGENT = "ToptoonChatCounter/1.0 (public-ranking-research; one-request-per-day)"


def fetch_html() -> str:
    request = Request(
        SOURCE_URL,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.5",
        },
    )
    with urlopen(request, timeout=30) as response:  # nosec B310: fixed public HTTPS URL
        content_type = response.headers.get_content_charset() or "utf-8"
        return response.read().decode(content_type, errors="replace")


def decode_flight_payload(html: str) -> str:
    """Join Next.js Flight chunks embedded in the server-rendered document."""
    matches = re.findall(r"self\.__next_f\.push\((\[.*?\])\)</script>", html, flags=re.DOTALL)
    chunks: list[str] = []
    for encoded in matches:
        try:
            payload = json.loads(encoded)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, list) and len(payload) > 1 and isinstance(payload[1], str):
            chunks.append(payload[1])
    if not chunks:
        raise ValueError("Next.js ranking payload was not found")
    return "".join(chunks)


def extract_ranking(html: str) -> dict[str, Any]:
    flight = decode_flight_payload(html)
    # The public app has used both names during frontend releases.  Keep the
    # parser tolerant to a harmless payload-field rename without probing any
    # private API.
    match = re.search(
        r'"(?:initialRealtimeData|initialCharacterRanking)":(\{.*?\}),"initialUserRanking"',
        flight,
        flags=re.DOTALL,
    )
    if not match:
        raise ValueError("Character-ranking object was not found in the public payload")

    ranking = json.loads(match.group(1))
    raw_items = ranking.get("items")
    if not isinstance(raw_items, list) or not raw_items:
        raise ValueError("Character-ranking list is empty or has an unexpected shape")

    items: list[dict[str, Any]] = []
    for raw in raw_items:
        if not isinstance(raw, dict):
            continue
        rank = raw.get("rank")
        name = raw.get("name")
        if not isinstance(rank, int) or not isinstance(name, str) or not name.strip():
            continue

        kind = raw.get("kind") if isinstance(raw.get("kind"), str) else "character"
        character_id = raw.get("characterId")
        content_id = raw.get("contentId")
        stable_id = (
            content_id
            if kind == "content" and content_id is not None
            else character_id if character_id is not None else content_id
        )
        item_key = f"{kind}:{stable_id}" if stable_id is not None else f"{kind}:name:{name.strip()}"
        badges = raw.get("badges") if isinstance(raw.get("badges"), list) else []

        # Store only investment-relevant public ranking fields. Do not retain thumbnails,
        # dialogue previews, hashtags, user data, or other content metadata.
        items.append(
            {
                "key": item_key,
                "rank": rank,
                "name": name.strip(),
                "kind": kind,
                "character_id": character_id,
                "content_id": content_id,
                "cast_count": raw.get("castCount"),
                "score": raw.get("score"),
                "is_new": bool(raw.get("isNew")),
                "has_new_start": bool(raw.get("hasNewStart")),
                "badges": [badge for badge in badges if isinstance(badge, str)],
            }
        )

    if len(items) < 5:
        raise ValueError("Too few valid ranking rows were parsed; retaining existing data")

    return {
        "source_updated_at": ranking.get("updatedAt"),
        "items": sorted(items, key=lambda item: item["rank"]),
    }


def load_history() -> dict[str, Any]:
    if not DATA_FILE.exists():
        return {"schema_version": 1, "source_url": SOURCE_URL, "snapshots": []}
    with DATA_FILE.open(encoding="utf-8") as file:
        history = json.load(file)
    if not isinstance(history, dict) or not isinstance(history.get("snapshots"), list):
        raise ValueError("Existing snapshots file has an unexpected format")
    return history


def local_date(iso_timestamp: str) -> str:
    return datetime.fromisoformat(iso_timestamp.replace("Z", "+00:00")).astimezone(KST).date().isoformat()


def write_history(history: dict[str, Any], ranking: dict[str, Any]) -> dict[str, Any]:
    captured = datetime.now(timezone.utc)
    snapshot = {
        "captured_at": captured.isoformat().replace("+00:00", "Z"),
        "captured_kst": captured.astimezone(KST).strftime("%Y-%m-%d %H:%M KST"),
        "source_updated_at": ranking["source_updated_at"],
        "items": ranking["items"],
    }

    snapshots = history["snapshots"]
    today = local_date(snapshot["captured_at"])
    if snapshots and local_date(snapshots[-1]["captured_at"]) == today:
        snapshots[-1] = snapshot
    else:
        snapshots.append(snapshot)

    history["schema_version"] = 1
    history["source_url"] = SOURCE_URL
    history["updated_at"] = snapshot["captured_at"]
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    DATA_FILE.write_text(
        json.dumps(history, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return snapshot


def main() -> int:
    try:
        ranking = extract_ranking(fetch_html())
        snapshot = write_history(load_history(), ranking)
    except Exception as error:  # Preserve the prior data file if parsing or network fails.
        print(f"Ranking capture failed: {error}", file=sys.stderr)
        return 1

    print(
        f"Captured {len(snapshot['items'])} ranking rows at {snapshot['captured_kst']} "
        f"(source updated: {snapshot['source_updated_at']})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
