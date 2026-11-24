import json

import pytest

from pipeline.export import CHUNK_SIZE, export
from pipeline.extract import Item


def make(kind, n):
    items = []
    for i in range(n):
        genres = ["დრამა"] + (["კომედია"] if i % 3 == 0 else []) + (["საშინელება"] if i % 10 == 0 else [])
        items.append(Item(id=10 + i * 2, type=kind, title_ka=f"სათაური {i}", title_en=f"Title {i}",
                          year=0 if i == 1 else 1990 + i % 30, genres=genres[::-1],
                          description="" if i % 7 == 0 else f"აღწერა {i} ...",
                          image=f"https://img/{i}.jpg", url=f"https://gemovie.tv/{kind}/{10 + i * 2}/x-qartulad-2000"))
    return items


def ring(n, k=3):
    return ([[(p + d) % n for d in range(1, k + 1)] for p in range(n)],
            [[90 - d for d in range(1, k + 1)] for _ in range(n)])


@pytest.fixture
def exported(tmp_path):
    items = {"movie": make("movie", 1203), "serial": make("serial", 4)}
    nb = {"movie": ring(1203), "serial": ring(4)}
    out = tmp_path / "out"
    export(items, nb, out, "20261124T2200")
    return items, out, lambda name: json.loads((out / name).read_text(encoding="utf-8"))


def test_meta(exported):
    items, out, load = exported
    meta = load("meta.json")
    assert meta["version"] == "20261124T2200"
    assert meta["genres"] == ["დრამა", "კომედია", "საშინელება"]  # by frequency, descending
    assert meta["sets"]["movie"] == {"count": 1203, "chunkSize": 500, "chunks": 3}
    assert meta["sets"]["serial"] == {"count": 4, "chunkSize": 500, "chunks": 1}
    assert CHUNK_SIZE == 500


def test_index_columns(exported):
    items, out, load = exported
    meta = load("meta.json")
    for kind in ("movie", "serial"):
        idx = load(f"{kind}.index.json")
        assert set(idx) == {"id", "ka", "en", "year", "g", "nd"}
        assert {len(v) for v in idx.values()} == {len(items[kind])}
        assert idx["id"] == sorted(idx["id"])
        for p, it in enumerate(items[kind]):
            assert idx["id"][p] == it.id and idx["ka"][p] == it.title_ka and idx["en"][p] == it.title_en
            assert idx["year"][p] == it.year
            assert idx["nd"][p] == (1 if it.description == "" else 0)
            assert [meta["genres"][g] for g in idx["g"][p]] == it.genres  # item's own order kept


def test_chunks(exported):
    items, out, load = exported
    for k in range(3):
        chunk = load(f"movie.d.{k}.json")
        part = items["movie"][k * 500:(k + 1) * 500]
        assert chunk == {"desc": [i.description for i in part], "img": [i.image for i in part],
                         "url": [i.url for i in part]}
    assert not (out / "movie.d.3.json").exists()
    assert len(load("serial.d.0.json")["desc"]) == 4


def test_neighbours_file(exported):
    items, out, load = exported
    nb = load("movie.nb.json")
    assert len(nb["n"]) == len(nb["s"]) == 1203
    assert all(p < 1203 for row in nb["n"] for p in row)
    assert nb["n"][1202] == [0, 1, 2] and nb["s"][0] == [89, 88, 87]


def test_items_are_sorted_by_id_and_positions_remapped(tmp_path):
    a, b, c = make("movie", 3)
    items = [c, a, b]                       # positions 0,1,2 refer to this order
    nb = ([[1, 2], [0], []], [[80, 70], [60], []])
    export({"movie": items, "serial": []}, {"movie": nb, "serial": ([], [])}, tmp_path, "v")
    idx = json.loads((tmp_path / "movie.index.json").read_text(encoding="utf-8"))
    out = json.loads((tmp_path / "movie.nb.json").read_text(encoding="utf-8"))
    assert idx["id"] == [a.id, b.id, c.id]
    assert out["n"] == [[2], [], [0, 1]] and out["s"] == [[60], [], [80, 70]]


def test_empty_set_and_stale_chunks_removed(tmp_path):
    (tmp_path / "movie.d.7.json").write_text("{}")
    (tmp_path / "keep.txt").write_text("x")
    export({"movie": make("movie", 2), "serial": []}, {"movie": ring(2, 1), "serial": ([], [])}, tmp_path, "v")
    meta = json.loads((tmp_path / "meta.json").read_text(encoding="utf-8"))
    assert meta["sets"]["serial"] == {"count": 0, "chunkSize": 500, "chunks": 0}
    assert json.loads((tmp_path / "serial.index.json").read_text())["id"] == []
    assert not (tmp_path / "movie.d.7.json").exists()
    assert (tmp_path / "keep.txt").exists()


def test_georgian_is_written_unescaped(exported):
    _, out, _ = exported
    assert "სათაური" in (out / "movie.index.json").read_text(encoding="utf-8")


def test_source_hash_changes_only_when_items_change():
    from pipeline.extract import Item
    from pipeline.run import source_hash

    def item(i, desc="d"):
        return Item(id=i, type="movie", title_ka="ა", title_en="a", year=2000, genres=["დრამა"],
                    description=desc, image="", url="")

    base = [item(1), item(2)]
    assert source_hash(base) == source_hash([item(1), item(2)])
    assert source_hash(base) != source_hash(base + [item(3)])
    assert source_hash(base) != source_hash([item(1), item(2, "other")])
    assert source_hash(base) != source_hash([item(1)])
