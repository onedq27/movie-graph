"""Download gemovie.tv movie/serial pages and keep only their structured data.

Usage: python3 pipeline/scrape.py [--limit N] [--rate 3.0] [--workers 4]

Reads the two sitemaps, fetches every page not yet stored, and appends one JSON
line per page to data/raw/pages.jsonl:

  {"key": "movie:1894", "type": "movie", "id": 1894, "url": "...",
   "lastmod": "...", "status": "ok" | "no_ld" | "http_404" | "error",
   "entity": {...ld+json Movie/TVEpisode object without "actor"...} | null}

Resumable: keys already stored with status ok/no_ld/http_404 are skipped, so a
re-run only fetches new or previously failed pages. Stdlib only.
"""
import argparse
import gzip
import json
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "raw" / "pages.jsonl"
SITEMAPS = {
    "movie": "https://gemovie.tv/movie_sitemap.xml",
    "serial": "https://gemovie.tv/serial_sitemap.xml",
}
UA = "Mozilla/5.0 (compatible; movie-graph/1.0)"
FINAL = {"ok", "no_ld", "http_404", "http_410"}
URL_RE = re.compile(r"<url>\s*<loc>([^<]+)</loc>(?:\s*<lastmod>([^<]*)</lastmod>)?", re.S)
PAGE_RE = re.compile(r"https://gemovie\.tv/(movie|serial)/(\d+)/")
LD_RE = re.compile(r'<script type="application/ld\+json">(.*?)</script>', re.S)
ENTITY_TYPES = {"Movie", "TVEpisode", "TVSeries"}


class RateLimiter:
    def __init__(self, per_second):
        self.interval = 1.0 / per_second
        self.lock = threading.Lock()
        self.next_at = time.monotonic()

    def wait(self):
        with self.lock:
            now = time.monotonic()
            at = max(now, self.next_at)
            self.next_at = at + self.interval
        time.sleep(max(0.0, at - now))

    def pause(self, seconds):
        with self.lock:
            self.next_at = max(self.next_at, time.monotonic() + seconds)


def fetch(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Encoding": "gzip"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read()
        if resp.headers.get("Content-Encoding") == "gzip":
            body = gzip.decompress(body)
    return body.decode("utf-8", errors="replace")


def parse_sitemap(xml):
    """Return [(type, id, url, lastmod)] for every movie/serial URL in the sitemap."""
    pages = []
    for loc, lastmod in URL_RE.findall(xml):
        m = PAGE_RE.match(loc.strip())
        if m:
            pages.append((m.group(1), int(m.group(2)), loc.strip(), (lastmod or "").strip()))
    return pages


def extract_entity(html):
    """Return the Movie/TVEpisode ld+json object (without actors), or None."""
    for block in LD_RE.findall(html):
        try:
            data = json.loads(block)
        except ValueError:
            continue
        nodes = data.get("@graph", [data]) if isinstance(data, dict) else data
        for node in nodes if isinstance(nodes, list) else []:
            if isinstance(node, dict) and node.get("@type") in ENTITY_TYPES:
                node.pop("actor", None)
                return node
    return None


def load_done():
    done = set()
    if OUT.exists():
        with OUT.open(encoding="utf-8") as f:
            for line in f:
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                if rec.get("status") in FINAL:
                    done.add(rec["key"])
    return done


def scrape_one(page, limiter):
    kind, pid, url, lastmod = page
    rec = {"key": f"{kind}:{pid}", "type": kind, "id": pid, "url": url,
           "lastmod": lastmod, "status": "error", "entity": None}
    for attempt in range(4):
        limiter.wait()
        try:
            entity = extract_entity(fetch(url))
            rec["entity"] = entity
            rec["status"] = "ok" if entity else "no_ld"
            return rec
        except urllib.error.HTTPError as e:
            if e.code in (404, 410):
                rec["status"] = f"http_{e.code}"
                return rec
            if e.code in (429, 503):
                limiter.pause(30 * (attempt + 1))
            rec["error"] = f"http_{e.code}"
        except Exception as e:  # network errors, timeouts
            rec["error"] = f"{type(e).__name__}: {e}"[:200]
        time.sleep(2 * (attempt + 1))
    return rec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="fetch at most N pages (0 = all)")
    ap.add_argument("--rate", type=float, default=3.0, help="max requests per second")
    ap.add_argument("--workers", type=int, default=4, help="parallel connections")
    args = ap.parse_args()

    OUT.parent.mkdir(parents=True, exist_ok=True)
    pages = []
    for kind, sm in SITEMAPS.items():
        found = parse_sitemap(fetch(sm))
        print(f"sitemap {kind}: {len(found)} pages", flush=True)
        pages.extend(found)
    (OUT.parent / "sitemap_keys.json").write_text(
        json.dumps([f"{k}:{i}" for k, i, _, _ in pages]), encoding="utf-8")

    done = load_done()
    todo = [p for p in pages if f"{p[0]}:{p[1]}" not in done]
    if args.limit:
        todo = todo[: args.limit]
    print(f"already stored: {len(done)}, to fetch: {len(todo)}", flush=True)

    limiter = RateLimiter(args.rate)
    lock = threading.Lock()
    counts = {}
    started = time.monotonic()
    with OUT.open("a", encoding="utf-8") as out, ThreadPoolExecutor(max_workers=args.workers) as pool:
        for n, rec in enumerate(pool.map(lambda p: scrape_one(p, limiter), todo), 1):
            with lock:
                out.write(json.dumps(rec, ensure_ascii=False) + "\n")
                out.flush()
            counts[rec["status"]] = counts.get(rec["status"], 0) + 1
            if n % 200 == 0 or n == len(todo):
                print(f"{n}/{len(todo)} {counts} {time.monotonic() - started:.0f}s", flush=True)
    print("done", counts, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
