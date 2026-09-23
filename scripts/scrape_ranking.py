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

ROOT = Path(__file__).resolve().parents[1]
DATA_FILE = ROOT / "dist" / "data" / "snapshots.json"
TAIWAN_DATA_FILE = ROOT / "dist" / "data" / "snapshots-tw.json"
US_DATA_FILE = ROOT / "dist" / "data" / "snapshots-us.json"
JAPAN_DATA_FILE = ROOT / "dist" / "data" / "snapshots-jp.json"
SITES = {
    "kr": {
        "label": "Korea",
        "base_url": "https://chat.toptoon.com",
        "accept_language": "ko-KR,ko;q=0.9",
        "title_marker": r"(?:AI 채팅|\|)",
        "counter_unit": r"회",
    },
    "tw": {
        "label": "Taiwan",
        "base_url": "https://chat.toptoon.net",
        "accept_language": "zh-TW,zh;q=0.9",
        "title_marker": r"(?:AI角色聊天|AI聊天|\|)",
        "counter_unit": r"(?:次|回)?",
    },
    "us": {
        "label": "US",
        "base_url": "https://chat.global.toptoon.com",
        "accept_language": "en-US,en;q=0.9",
        "title_marker": r"(?:AI Chat|\|)",
        "counter_unit": r"(?:times?)?",
    },
    "jp": {
        "label": "Japan",
        "base_url": "https://chat.toptoon.jp",
        "accept_language": "ja-JP,ja;q=0.9",
        "title_marker": r"(?:AIチャット|\|)",
        "counter_unit": r"回",
    },
}
# Current Korean standard time has no DST; works on Windows without tzdata.
KST = timezone(timedelta(hours=9), "KST")
USER_AGENT = "ToptoonChatCounter/2.0 (public-counter-research; one-daily-capture)"
DETAIL_RE = re.compile(r"(?:href=[\"']?)(/detail/(?:character|content)/[0-9]+)", re.I)
COUNTER_FIELDS = {"view_count": ("viewCount", "totalViewCount", "view_count", "views"), "chat_count": ("chatCount", "conversationCount", "totalChatCount", "chat_count")}

def site_config(market: str = "kr") -> dict[str, Any]:
    return SITES[market]

def data_file_for(market: str = "kr") -> Path:
    return {
        "kr": DATA_FILE,
        "tw": TAIWAN_DATA_FILE,
        "us": US_DATA_FILE,
        "jp": JAPAN_DATA_FILE,
    }[market]

def fetch(url: str, accept_language: str = SITES["kr"]["accept_language"]) -> str:
    request = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml", "Accept-Language": accept_language})
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

def public_detail_urls(market: str = "kr") -> list[str]:
    config = site_config(market)
    base_url = config["base_url"]
    urls: set[str] = set()
    for path in ("/", "/explore", "/ranking"):
        catalog = urljoin(base_url, path)
        urls.update(urljoin(base_url, detail) for detail in DETAIL_RE.findall(fetch(catalog, config["accept_language"])))
    if not urls: raise ValueError("No public work detail links found in catalog pages")
    return sorted(urls)

def json_counter(page: str, names: tuple[str, ...]) -> int | None:
    for field in names:
        match = re.search(rf"[\"']{re.escape(field)}[\"']\s*:\s*[\"']?([0-9]+)", page)
        if match: return int(match.group(1))
    return None

def visible_counter_fallback(page: str, market: str = "kr") -> tuple[int, int] | None:
    """Read the two public counters in card order: eye/View then chat."""
    text = re.sub(r"<script[\s\S]*?</script>|<style[\s\S]*?</style>", " ", page, flags=re.I)
    text = re.sub(r"\s+", " ", html_module.unescape(re.sub(r"<[^>]+>", " ", text)))
    match = re.search(rf"([0-9][0-9,]*)\s*{site_config(market)['counter_unit']}\s+([0-9][0-9,]*)", text)
    return (int(match.group(1).replace(",", "")), int(match.group(2).replace(",", ""))) if match else None

def detail_item(url: str, market: str = "kr") -> dict[str, Any] | None:
    config = site_config(market)
    page = fetch(url, config["accept_language"])
    view_count, chat_count = json_counter(page, COUNTER_FIELDS["view_count"]), json_counter(page, COUNTER_FIELDS["chat_count"])
    if view_count is None or chat_count is None:
        fallback = visible_counter_fallback(page, market)
        if fallback: view_count, chat_count = fallback
    if view_count is None or chat_count is None: return None
    route = re.search(r"/detail/(character|content)/([0-9]+)$", url)
    title = re.search(rf"<title>\s*(.*?)\s*{config['title_marker']}", page, flags=re.S | re.I)
    name = html_module.unescape(re.sub(r"<[^>]+>", "", title.group(1))).strip() if title else url.rsplit("/", 1)[-1]
    kind, item_id = route.groups() if route else ("unknown", url)
    return {"key": f"{kind}:{item_id}", "kind": kind, "id": int(item_id), "name": name, "url": url, "view_count": view_count, "chat_count": chat_count}

def capture_items(market: str = "kr") -> list[dict[str, Any]]:
    urls = public_detail_urls(market); items: list[dict[str, Any]] = []
    for index, url in enumerate(urls):
        item = detail_item(url, market)
        if item: items.append(item)
        if index < len(urls) - 1: time.sleep(0.15)
    if len(items) < 5: raise ValueError(f"Only {len(items)} public counters parsed; existing data was preserved")
    return sorted(items, key=lambda item: item["name"])

def load_history(market: str = "kr") -> dict[str, Any]:
    config = site_config(market)
    data_file = data_file_for(market)
    if not data_file.exists(): return {"schema_version": 3, "market": market, "source_url": config["base_url"], "snapshots": []}
    history = json.loads(data_file.read_text(encoding="utf-8"))
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

def write_history(history: dict[str, Any], items: list[dict[str, Any]], *, now: datetime | None = None, market: str = "kr") -> dict[str, Any]:
    config = site_config(market)
    data_file = data_file_for(market)
    captured = now or datetime.now(timezone.utc)
    snapshot = {"captured_at": captured.isoformat().replace("+00:00", "Z"), "captured_kst": captured.astimezone(KST).strftime("%Y-%m-%d %H:%M KST"), "items": items, "totals": {"view_count": sum(item["view_count"] for item in items), "chat_count": sum(item["chat_count"] for item in items), "observed_items": len(items)}}
    snapshots = history["snapshots"]
    if snapshots and local_date(snapshots[-1]["captured_at"]) == local_date(snapshot["captured_at"]): snapshots[-1] = snapshot
    else: snapshots.append(snapshot)
    history.update({"schema_version": 3, "market": market, "source_url": config["base_url"], "updated_at": snapshot["captured_at"]})
    data_file.parent.mkdir(parents=True, exist_ok=True)
    temporary = data_file.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(history, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(data_file)
    return snapshot

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="Capture now even before 07:00 KST or after today's successful capture")
    parser.add_argument("--market", choices=("all", *SITES), default="all", help="Market to capture (default: all configured markets)")
    args = parser.parse_args(argv)
    markets = SITES if args.market == "all" else (args.market,)
    failed = False
    for market in markets:
        config = site_config(market)
        try:
            history = load_history(market)
            if not args.force and not capture_due(history, datetime.now(timezone.utc)):
                print(f"{config['label']} capture skipped: before 07:00 KST or today's morning snapshot already exists.")
                continue
            snapshot = write_history(history, capture_items(market), market=market)
        except Exception as error:
            print(f"{config['label']} public counter capture failed: {error}", file=sys.stderr)
            failed = True
            continue
        print(f"Captured {snapshot['totals']['observed_items']} {config['label']} public works at {snapshot['captured_kst']}")
    return 1 if failed else 0

if __name__ == "__main__": raise SystemExit(main())
