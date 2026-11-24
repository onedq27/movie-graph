#!/usr/bin/env python3
"""Dev-only fixture: writes Data Contract files into app/data/ from a slice of
data/raw/pages.jsonl with FAKE neighbours (genre overlap + seeded noise).

The real export (python -m pipeline.run) overwrites these files.
Stdlib only; works on Python 3.9.

    python3 app/dev/make_fixture.py [--movies 300] [--out app/data]
"""
import argparse
import html
import json
import random
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CHUNK = 500
TOP = 30
SYNTH_SERIALS = 9      # small on purpose: exercises "fewer neighbours than the slider asks"
BLANK_DESC_EVERY = 97  # blank a few descriptions so the `nd` path is exercised


def read_ok(path):
    """ok records in file order, last line wins per key; tolerates a truncated last line."""
    by_key = {}
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            if not isinstance(rec, dict) or rec.get("status") != "ok" or not isinstance(rec.get("entity"), dict):
                continue
            by_key[rec.get("key")] = rec
    return list(by_key.values())


def parse_name(name):
    name = html.unescape(name or "").strip()
    name = re.sub(r"\s*-\s*GEMOVIE\.TV\s*$", "", name)
    if " | " not in name:
        return name, ""
    ka, en = name.split(" | ", 1)
    ka = re.sub(r"\s*ქართულად\s*$", "", ka).strip()
    en = re.sub(r"\s*qartulad\s*$", "", en).strip()
    return ka, en


def to_item(rec, force_type=None):
    e = rec["entity"]
    ka, en = parse_name(e.get("name", ""))
    m = re.search(r"-(\d{4})/?$", rec.get("url", ""))
    genres = e.get("genre") or []
    if isinstance(genres, str):
        genres = [genres]
    return {
        "id": int(rec["id"]),
        "type": force_type or rec["type"],
        "ka": ka,
        "en": en,
        "year": int(m.group(1)) if m else 0,
        "genres": [html.unescape(g).strip() for g in genres if g],
        "desc": html.unescape(e.get("description") or "").strip(),
        "img": e.get("image") or "",
        "url": e.get("url") or rec.get("url", ""),
    }


def fake_neighbours(items, rng):
    n = len(items)
    gsets = [set(it["genres"]) for it in items]
    nb, sc = [], []
    noise = {}
    for i in range(n):
        cands = []
        for j in range(n):
            if i == j or not items[j]["desc"]:
                continue  # items without a description are never anyone's neighbour
            union = gsets[i] | gsets[j]
            jac = len(gsets[i] & gsets[j]) / len(union) if union else 0.0
            if not items[i]["desc"]:
                score = jac
            else:
                key = (min(i, j), max(i, j))
                if key not in noise:
                    noise[key] = rng.random()
                cos = 0.2 + 0.45 * jac + 0.3 * noise[key]
                score = 0.7 * cos + 0.3 * jac
            cands.append((score, -abs(items[i]["year"] - items[j]["year"]), j))
        cands.sort(reverse=True)
        top = [c for c in cands[:TOP] if c[0] > 0]
        nb.append([c[2] for c in top])
        sc.append([int(round(100 * max(0.0, min(1.0, c[0])))) for c in top])
    return nb, sc


def write(path, obj):
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pages", default=str(ROOT / "data" / "raw" / "pages.jsonl"))
    ap.add_argument("--out", default=str(ROOT / "app" / "data"))
    ap.add_argument("--movies", type=int, default=300)
    args = ap.parse_args()

    recs = read_ok(args.pages)
    movie_recs = [r for r in recs if r.get("type") == "movie"]
    serial_recs = [r for r in recs if r.get("type") == "serial"]

    movies = [to_item(r) for r in movie_recs[: args.movies]]
    if serial_recs:
        serials = [to_item(r) for r in serial_recs[: args.movies]]
        synth = False
    else:
        pool = movie_recs[args.movies:] or movie_recs
        serials = [to_item(r, "serial") for r in pool[:SYNTH_SERIALS]]
        synth = True

    sets = {"movie": movies, "serial": serials}
    for items in sets.values():
        items.sort(key=lambda it: it["id"])
        for k, it in enumerate(items):
            if k % BLANK_DESC_EVERY == 5:
                it["desc"] = ""

    freq = Counter(g for items in sets.values() for it in items for g in it["genres"])
    genres = [g for g, _ in sorted(freq.items(), key=lambda kv: (-kv[1], kv[0]))]
    gidx = {g: i for i, g in enumerate(genres)}

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob("*.json"):
        old.unlink()

    rng = random.Random(20261124)
    meta = {
        "version": datetime.now(timezone.utc).strftime("%Y%m%dT%H%M"),
        "genres": genres,
        "sets": {},
        "fixture": True,
    }
    for name, items in sets.items():
        nb, sc = fake_neighbours(items, rng)
        write(out / f"{name}.index.json", {
            "id": [it["id"] for it in items],
            "ka": [it["ka"] for it in items],
            "en": [it["en"] for it in items],
            "year": [it["year"] for it in items],
            "g": [[gidx[g] for g in it["genres"]] for it in items],
            "nd": [0 if it["desc"] else 1 for it in items],
        })
        write(out / f"{name}.nb.json", {"n": nb, "s": sc})
        chunks = max(1, -(-len(items) // CHUNK))
        for k in range(chunks):
            part = items[k * CHUNK:(k + 1) * CHUNK]
            write(out / f"{name}.d.{k}.json", {
                "desc": [it["desc"] for it in part],
                "img": [it["img"] for it in part],
                "url": [it["url"] for it in part],
            })
        meta["sets"][name] = {"count": len(items), "chunkSize": CHUNK, "chunks": chunks}
    write(out / "meta.json", meta)

    print(f"fixture -> {out}  version {meta['version']}")
    for name, items in sets.items():
        note = " (synthesised from movie lines)" if name == "serial" and synth else ""
        print(f"  {name}: {len(items)} items, {sum(1 for it in items if not it['desc'])} without description{note}")


if __name__ == "__main__":
    main()
