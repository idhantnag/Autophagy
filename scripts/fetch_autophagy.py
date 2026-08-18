#!/usr/bin/env python3
"""
Refresh the cached trend counts for the Autophagy Radar tracker.

Autophagy Radar is a *live* tool: every paper and every window summary is
fetched from PubMed directly in the browser, so the site works with no build
step. This script only pre-computes the small "themes over time" chart so it
loads instantly, and stamps a fresh snapshot of recent activity. It reads the
theme/query definitions straight from data/autophagy.json (single source of
truth) and writes the counts back into the same file.

Like the sibling NeuroTrends fetcher, it only asks PubMed for *counts*
(retmax=0) — it never downloads article bodies — and stays polite to NCBI:
  - <= 3 requests / second without an API key (10/s with one)
  - identifies itself via `tool` and `email`
  - retries with backoff on transient failures / HTTP 429

Usage:
    python3 scripts/fetch_autophagy.py --email you@example.com
    python3 scripts/fetch_autophagy.py --email you@example.com --api-key KEY \
        --year-start 2016 --year-end 2026
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from urllib.error import HTTPError, URLError

ESEARCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi"
HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_JSON = os.path.normpath(os.path.join(HERE, "..", "data", "autophagy.json"))


class NCBIClient:
    def __init__(self, email: str, api_key: str | None, verbose: bool = True):
        self.email = email
        self.api_key = api_key
        self.verbose = verbose
        self.delay = 0.11 if api_key else 0.34  # 10/s with key, ~3/s without
        self.requests = 0

    def count(self, term: str) -> int:
        params = {
            "db": "pubmed", "term": term, "retmode": "json", "retmax": "0",
            "tool": "autophagy-radar", "email": self.email,
        }
        if self.api_key:
            params["api_key"] = self.api_key
        url = ESEARCH + "?" + urllib.parse.urlencode(params)

        backoff = 1.0
        for attempt in range(6):
            try:
                time.sleep(self.delay)
                req = urllib.request.Request(url, headers={"User-Agent": "autophagy-radar/1.0"})
                with urllib.request.urlopen(req, timeout=30) as resp:
                    data = json.load(resp)
                self.requests += 1
                return int(data["esearchresult"]["count"])
            except (HTTPError, URLError, KeyError, ValueError, TimeoutError) as exc:
                if self.verbose:
                    print(f"    retry ({attempt+1}/6) after error: {exc}", file=sys.stderr)
                time.sleep(backoff)
                backoff = min(backoff * 2, 20)
        raise RuntimeError(f"giving up on query: {term}")


def ydat(year: int) -> str:
    return f'"{year}"[pdat]'


def main() -> int:
    ap = argparse.ArgumentParser(description="Refresh Autophagy Radar trend cache.")
    ap.add_argument("--email", default=os.environ.get("NCBI_EMAIL", "anonymous@example.com"))
    ap.add_argument("--api-key", default=os.environ.get("NCBI_API_KEY"))
    ap.add_argument("--year-start", type=int, default=2016)
    ap.add_argument("--year-end", type=int, default=dt.date.today().year)
    ap.add_argument("--json", default=DEFAULT_JSON)
    args = ap.parse_args()

    with open(args.json, encoding="utf-8") as fh:
        cfg = json.load(fh)

    base = cfg["baseQuery"]
    themes = cfg["themes"]
    years = list(range(args.year_start, args.year_end + 1))
    client = NCBIClient(args.email, args.api_key)

    print(f"[1/2] Themes over time ({years[0]}–{years[-1]}) …")
    trend = {}
    for th in themes:
        label, tq = th["label"], th["query"]
        trend[th["id"]] = {
            str(y): client.count(f"{base} AND {tq} AND {ydat(y)}") for y in years
        }
        print(f"    {label:<40} {sum(trend[th['id']].values()):>7} papers")

    print("\n[2/2] Recent-activity snapshot (trailing 30 days) …")
    today = dt.date.today()
    start = today - dt.timedelta(days=30)
    window = f'("{start:%Y/%m/%d}"[edat] : "{today:%Y/%m/%d}"[edat])'
    snapshot = {"windowDays": 30, "asOf": today.isoformat(), "byTheme": {}}
    snapshot["total"] = client.count(f"{base} AND {window}")
    for th in themes:
        snapshot["byTheme"][th["id"]] = client.count(f"{base} AND {th['query']} AND {window}")
        print(f"    {th['label']:<40} {snapshot['byTheme'][th['id']]:>6} new")
    print(f"    {'ALL autophagy':<40} {snapshot['total']:>6} new")

    cfg["years"] = years
    cfg["trend"] = trend
    cfg["snapshot"] = snapshot
    cfg["meta"]["generated"] = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    cfg["meta"]["requests"] = client.requests

    with open(args.json, "w", encoding="utf-8") as fh:
        json.dump(cfg, fh, indent=2, ensure_ascii=False)
    print(f"\nUpdated {args.json}  ({client.requests} requests used)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
