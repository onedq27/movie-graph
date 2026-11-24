"""extract -> embed -> neighbours -> export.

Usage (from the repo root): .venv/bin/python -m pipeline.run [--out app/data]
"""
import argparse
import hashlib
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from pipeline import layout, similarity
from pipeline.export import SETS, export
from pipeline.extract import load_items

ROOT = Path(__file__).resolve().parent.parent
MAX_FILE_BYTES = 4 * 1024 * 1024
SHOWCASE = ("movie", 1894)  # Iron Man


def source_hash(items) -> str:
    """Fingerprint of everything the export depends on: the items and the
    similarity settings. Same fingerprint, same export."""
    h = hashlib.sha1()
    h.update(json.dumps([similarity.MODEL, similarity.TITLE_WEIGHT, similarity.W_PLOT, similarity.W_GENRE,
                         layout.GRID, layout.GAP]).encode("utf-8"))
    for it in items:
        h.update(json.dumps([it.type, it.id, it.title_ka, it.title_en, it.year, it.genres,
                             it.description, it.image, it.url], ensure_ascii=False).encode("utf-8"))
    return h.hexdigest()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    ap.add_argument("--out", type=Path, default=ROOT / "app" / "data", help="output directory")
    ap.add_argument("--pages", type=Path, default=ROOT / "data" / "raw" / "pages.jsonl")
    ap.add_argument("--sitemap-keys", type=Path, default=ROOT / "data" / "raw" / "sitemap_keys.json")
    ap.add_argument("--cache", type=Path, default=ROOT / "data" / "cache")
    ap.add_argument("--if-changed", action="store_true",
                    help="do nothing when the items are the same as in the existing export")
    args = ap.parse_args(argv)

    keys = args.sitemap_keys if args.sitemap_keys.exists() else None
    items = load_items(args.pages, keys)
    if not items:
        print(f"no usable items in {args.pages}; nothing exported", file=sys.stderr)
        return 1

    source = source_hash(items)
    meta_path = args.out / "meta.json"
    if args.if_changed and meta_path.exists():
        try:
            previous = json.loads(meta_path.read_text(encoding="utf-8")).get("source")
        except ValueError:
            previous = None
        if previous == source:
            print(f"no changes: {len(items)} items, same as the existing export")
            return 0

    items_by_set, nb_by_set, xy_by_set = {}, {}, {}
    for kind in SETS:
        part = [it for it in items if it.type == kind]
        started = time.monotonic()
        emb = similarity.plot_vectors(part, args.cache)
        embed_s = time.monotonic() - started
        started = time.monotonic()
        nb_by_set[kind] = similarity.neighbours(part, emb, w_plot=similarity.W_PLOT, w_genre=similarity.W_GENRE)
        items_by_set[kind] = part
        xy_by_set[kind] = layout.layout(part, emb)
        nd = sum(1 for it in part if not it.description)
        print(f"{kind}: {len(part)} items, {nd} without description (nd), "
              f"embed {embed_s:.1f}s, neighbours {time.monotonic() - started:.1f}s")

    version = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M")
    export(items_by_set, nb_by_set, args.out, version)
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    meta["source"] = source
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    for kind, part in items_by_set.items():
        # Same order as {set}.index.json: position = index after sorting by id.
        order = sorted(range(len(part)), key=lambda i: part[i].id)
        xy = xy_by_set[kind]
        (args.out / f"{kind}.xy.json").write_text(json.dumps(
            {"x": [int(xy[i][0]) for i in order], "y": [int(xy[i][1]) for i in order]},
            separators=(",", ":")), encoding="utf-8")

    print(f"model: {similarity.MODEL}, text: description + {similarity.TITLE_WEIGHT} * title, "
          f"score = {similarity.W_PLOT} * plot + {similarity.W_GENRE} * genre")
    print(f"exported version {version} to {args.out}")
    total = 0
    for path in sorted(args.out.glob("*.json")):
        size = path.stat().st_size
        total += size
        if ".d." not in path.name or size > MAX_FILE_BYTES:
            flag = "  <-- over 4 MB" if size > MAX_FILE_BYTES else ""
            print(f"  {path.name}: {size / 1024:.0f} KB{flag}")
    chunks = list(args.out.glob("*.d.*.json"))
    if chunks:
        sizes = [p.stat().st_size for p in chunks]
        print(f"  {len(chunks)} detail chunks: {sum(sizes) / 1024:.0f} KB total, largest {max(sizes) / 1024:.0f} KB")
    print(f"  total: {total / 1024 / 1024:.2f} MB")

    kind, wanted = SHOWCASE
    part = items_by_set[kind]
    pos = next((p for p, it in enumerate(part) if it.id == wanted), None)
    if pos is None:
        print(f"{kind} {wanted} is not in the data yet")
    else:
        print(f"neighbours of {part[pos].title_ka} | {part[pos].title_en} ({kind} {wanted}):")
        nb_n, nb_s = nb_by_set[kind]
        for q, score in zip(nb_n[pos], nb_s[pos]):
            it = part[q]
            print(f"  {score:3d}  {it.title_ka} | {it.title_en} ({it.year}) [{', '.join(it.genres)}]")
    return 0


if __name__ == "__main__":
    sys.exit(main())
