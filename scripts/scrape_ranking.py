#!/usr/bin/env python3
"""Daily, anonymous capture of public Toptoon Chat View and Chat counters."""
from __future__ import annotations
import argparse
import html as html_module
import json
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urljoin
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

BASE_URL = "https://chat.toptoon.com"
CATALOG_URLS = (f"{BASE_URL}/", f"{BASE_URL}/explore", f"{BASE_URL}/ranking")
ROOT = Path(__file__).resolve().parents[1]
DATA_FILE = ROOT / "dist" / "data" / "snapshots.json"
# Current Korean standard time has no DST; works on Windows without tzdata.
KST = timezone(timedelta(hours=9), "KST")
USER_AGENT = "ToptoonChatCounter/2.0 (public-counter-research; one-daily-capture)"
DETAIL_RE = re.compile(r"(?:href=[\"']?)(/detail/(?:character|content)/[0-9]+)", re.I)
COUNTER_FIELDS = {"view_count": ("viewCount", "totalViewCount", "view_count", "views"), "chat_count": ("chatCount", "conversationCount", "totalChatCount", "chat_count")}

def fetch(url: str) -> str:
    request = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml", "Accept-Language": "ko-KR,ko;q=0.9"})
    for attempt in range(3):
        try:
            with urlopen(request, timeout=30) as response:  # nosec B310 -- fixed public HTTPS origin
                return response.read().decode(response.headers.get_content_charset() or "utf-8", errors="replace")
        except (URLError, TimeoutError) as error:
            if isinstance(error, HTTPError) and error.code not in (429, 500, 502, 503, 504):
                raise
            if attempt == 2:
                raise
            time.sleep(2 ** (attempt + 1))
    raise RuntimeError("Public page fetch did not complete")

def public_detail_urls() -> list[str]:
    urls: set[str] = set()
    for catalog in CATALOG_URLS:
        urls.update(urljoin(BASE_URL, path) for path in DETAIL_RE.findall(fetch(catalog)))
    if not urls: raise ValueError("No public work detail links found in catalog pages")
    return sorted(urls)

def json_counter(page: str, names: tuple[str, ...]) -> int | None:
    for field in names:
        match = re.search(rf"[\"']{re.escape(field)}[\"']\s*:\s*[\"']?([0-9]+)", page)
        if match: return int(match.group(1))
    return None

def visible_counter_fallback(page: str) -> tuple[int, int] | None:
    """Read the two public counters in card order: eye/View then chat."""
    text = re.sub(r"<script[\s\S]*?</script>|<style[\s\S]*?</style>", " ", page, flags=re.I)
    text = re.sub(r"\s+", " ", html_module.unescape(re.sub(r"<[^>]+>", " ", text)))
    match = re.search(r"([0-9][0-9,]*)\s*회\s+([0-9][0-9,]*)", text)
    return (int(match.group(1).replace(",", "")), int(match.group(2).replace(",", ""))) if match else None

def detail_item(url: str) -> dict[str, Any] | None:
    page = fetch(url)
    view_count, chat_count = json_counter(page, COUNTER_FIELDS["view_count"]), json_counter(page, COUNTER_FIELDS["chat_count"])
    if view_count is None or chat_count is None:
        fallback = visible_counter_fallback(page)
        if fallback: view_count, chat_count = fallback
    if view_count is None or chat_count is None: return None
    route = re.search(r"/detail/(character|content)/([0-9]+)$", url)
    title = re.search(r"<title>\s*(.*?)\s*(?:AI 채팅|\|)", page, flags=re.S | re.I)
    name = html_module.unescape(re.sub(r"<[^>]+>", "", title.group(1))).strip() if title else url.rsplit("/", 1)[-1]
    kind, item_id = route.groups() if route else ("unknown", url)
    return {"key": f"{kind}:{item_id}", "kind": kind, "id": int(item_id), "name": name, "url": url, "view_count": view_count, "chat_count": chat_count}

def capture_items() -> list[dict[str, Any]]:
    urls = public_detail_urls(); items: list[dict[str, Any]] = []
    for index, url in enumerate(urls):
        item = detail_item(url)
        if item: items.append(item)
        if index < len(urls) - 1: time.sleep(0.15)
    if len(items) < 5: raise ValueError(f"Only {len(items)} public counters parsed; existing data was preserved")
    return sorted(items, key=lambda item: item["name"])

def load_history() -> dict[str, Any]:
    if not DATA_FILE.exists(): return {"schema_version": 2, "source_url": BASE_URL, "snapshots": []}
    history = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    if not isinstance(history, dict) or not isinstance(history.get("snapshots"), list): raise ValueError("Existing snapshots file has an unexpected format")
    return history

def local_date(timestamp: str) -> str:
    return datetime.fromisoformat(timestamp.replace("Z", "+00:00")).astimezone(KST).date().isoformat()

def capture_due(history: dict[str, Any], now: datetime) -> bool:
    """Keep the first valid capture after 07:00 KST, even if cron runs late."""
    morning = now.astimezone(KST).replace(hour=7, minute=0, second=0, microsecond=0)
    if now < morning:
        return False
    for snapshot in history["snapshots"]:
        captured = datetime.fromisoformat(snapshot["captured_at"].replace("Z", "+00:00"))
        items = snapshot.get("items", [])
        valid = len(items) >= 5 and all(
            type(item.get(field)) is int and item[field] >= 0
            for item in items for field in ("view_count", "chat_count")
        )
        if morning <= captured <= now and valid:
            return False
    return True

def write_history(history: dict[str, Any], items: list[dict[str, Any]], *, now: datetime | None = None) -> dict[str, Any]:
    captured = now or datetime.now(timezone.utc)
    snapshot = {"captured_at": captured.isoformat().replace("+00:00", "Z"), "captured_kst": captured.astimezone(KST).strftime("%Y-%m-%d %H:%M KST"), "items": items, "totals": {"view_count": sum(item["view_count"] for item in items), "chat_count": sum(item["chat_count"] for item in items), "observed_items": len(items)}}
    snapshots = history["snapshots"]
    if snapshots and local_date(snapshots[-1]["captured_at"]) == local_date(snapshot["captured_at"]): snapshots[-1] = snapshot
    else: snapshots.append(snapshot)
    history.update({"schema_version": 2, "source_url": BASE_URL, "updated_at": snapshot["captured_at"]})
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    temporary = DATA_FILE.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(history, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(DATA_FILE)
    return snapshot

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="Capture now even before 07:00 KST or after today's successful capture")
    args = parser.parse_args(argv)
    try:
        history = load_history()
        if not args.force and not capture_due(history, datetime.now(timezone.utc)):
            print("Capture skipped: before 07:00 KST or today's morning snapshot already exists. Deployment can still retry.")
            return 0
        snapshot = write_history(history, capture_items())
    except Exception as error:
        print(f"Public counter capture failed: {error}", file=sys.stderr); return 1
    print(f"Captured {snapshot['totals']['observed_items']} public works at {snapshot['captured_kst']}")
    return 0

if __name__ == "__main__": raise SystemExit(main())
