"""Write the pipeline -> app data contract (see the plan's "Data Contract")."""
import json
import re
from collections import Counter
from pathlib import Path

from pipeline.extract import Item

CHUNK_SIZE = 500
SETS = ("movie", "serial")
_CHUNK_FILE_RE = re.compile(r"^(movie|serial)\.d\.(\d+)\.json$")


def _write(path: Path, obj) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(path)


def export(items_by_set: dict[str, list[Item]], nb_by_set: dict, out_dir: Path, version: str) -> None:
    """nb_by_set[set] = (positions, scores) as returned by similarity.neighbours,
    with positions referring to items_by_set[set] in the given order."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    freq = Counter(g for items in items_by_set.values() for it in items for g in it.genres)
    genres = sorted(freq, key=lambda g: (-freq[g], g))
    genre_index = {g: i for i, g in enumerate(genres)}
    meta = {"version": version, "genres": genres, "sets": {}}
    written = set()

    for kind in SETS:
        items = items_by_set.get(kind, [])
        nb_n, nb_s = nb_by_set.get(kind, ([], []))
        # Contract: position = index after sorting by id ascending.
        order = sorted(range(len(items)), key=lambda i: items[i].id)
        new_pos = {old: new for new, old in enumerate(order)}
        items = [items[i] for i in order]
        nb_n = [[new_pos[q] for q in nb_n[i]] for i in order]
        nb_s = [[int(v) for v in nb_s[i]] for i in order]

        _write(out_dir / f"{kind}.index.json", {
            "id": [it.id for it in items],
            "ka": [it.title_ka for it in items],
            "en": [it.title_en for it in items],
            "year": [it.year for it in items],
            "g": [[genre_index[g] for g in it.genres] for it in items],
            "nd": [0 if it.description else 1 for it in items],
        })
        _write(out_dir / f"{kind}.nb.json", {"n": nb_n, "s": nb_s})
        chunks = -(-len(items) // CHUNK_SIZE)
        for k in range(chunks):
            part = items[k * CHUNK_SIZE:(k + 1) * CHUNK_SIZE]
            name = f"{kind}.d.{k}.json"
            _write(out_dir / name, {"desc": [it.description for it in part],
                                    "img": [it.image for it in part],
                                    "url": [it.url for it in part]})
            written.add(name)
        meta["sets"][kind] = {"count": len(items), "chunkSize": CHUNK_SIZE, "chunks": chunks}

    for path in out_dir.iterdir():  # chunks left over from a larger, older export
        if _CHUNK_FILE_RE.match(path.name) and path.name not in written:
            path.unlink()
    _write(out_dir / "meta.json", meta)
