import numpy as np

from pipeline.extract import Item
from pipeline.similarity import neighbours


def item(pid, genres, desc="x", year=2000):
    return Item(id=pid, type="movie", title_ka=f"t{pid}", title_en="", year=year, genres=list(genres),
                description=desc, image="", url="")


def unit(rows):
    a = np.asarray(rows, dtype=np.float32)
    return a / np.linalg.norm(a, axis=1, keepdims=True)


def test_pinned_score():
    items = [item(1, "xy"), item(2, "yz")]
    emb = np.array([[1.0, 0.0], [0.6, 0.8]], dtype=np.float32)
    n, s = neighbours(items, emb)
    # 0.7 * cos(0.6) + 0.3 * jaccard(1/3) = 0.52
    assert n == [[1], [0]]
    assert s == [[52], [52]]


def test_custom_weights():
    items = [item(1, "xy"), item(2, "yz")]
    emb = np.array([[1.0, 0.0], [0.6, 0.8]], dtype=np.float32)
    _, s = neighbours(items, emb, w_plot=1.0, w_genre=0.0)
    assert s == [[60], [60]]


def test_never_self_sorted_and_capped():
    rng = np.random.default_rng(0)
    items = [item(i, rng.choice(list("abcde"), size=2, replace=False)) for i in range(40)]
    emb = unit(rng.normal(size=(40, 8)))
    n, s = neighbours(items, emb, k=7)
    assert len(n) == len(s) == 40
    for p, (row, scores) in enumerate(zip(n, s)):
        assert p not in row
        assert len(row) == len(scores) == 7
        assert len(set(row)) == 7
        assert scores == sorted(scores, reverse=True)
        assert all(isinstance(v, int) and 0 <= v <= 100 for v in scores)
        assert all(isinstance(v, int) for v in row)


def test_matches_brute_force_across_blocks():
    rng = np.random.default_rng(1)
    items = [item(i, rng.choice(list("abcde"), size=int(rng.integers(0, 4)), replace=False)) for i in range(60)]
    emb = unit(rng.normal(size=(60, 6)))
    n, s = neighbours(items, emb, k=5, block=7)
    for p in range(60):
        best = []
        for q in range(60):
            if q == p:
                continue
            a, b = set(items[p].genres), set(items[q].genres)
            jac = len(a & b) / len(a | b) if a | b else 0.0
            best.append((-(0.7 * float(emb[p] @ emb[q]) + 0.3 * jac), q))
        best.sort()
        assert n[p] == [q for _, q in best[:5]]
        assert s[p] == [int(round(100 * min(1.0, max(0.0, -v)))) for v, _ in best[:5]]


def test_fewer_when_set_is_small():
    items = [item(1, "a"), item(2, "a"), item(3, "b")]
    n, s = neighbours(items, unit([[1, 0], [1, 1], [0, 1]]), k=30)
    assert [len(r) for r in n] == [2, 2, 2]
    assert neighbours([item(1, "a")], unit([[1, 0]])) == ([[]], [[]])
    assert neighbours([], np.zeros((0, 4), dtype=np.float32)) == ([], [])


def test_negative_score_clamped_to_zero():
    items = [item(1, "a"), item(2, "b")]
    _, s = neighbours(items, unit([[1, 0], [-1, 0]]))
    assert s == [[0], [0]]


def test_no_description_item():
    items = [
        item(0, "ab", desc="", year=2000),
        item(1, "ab", year=2010),
        item(2, "ab", year=2001),
        item(3, "a", year=2000),
        item(4, "c", year=2000),      # no shared genre: not a neighbour at all
        item(5, "ab", desc="", year=2000),  # no description: never a neighbour
    ]
    emb = unit([[0, 0, 1], [1, 0, 0], [1, 0.1, 0], [1, 0.2, 0], [1, 0.3, 0], [0, 0, 1]])
    emb[0] = 0
    emb[5] = 0
    n, s = neighbours(items, emb)
    assert n[0] == [2, 1, 3]            # jaccard 1, 1, 0.5; tie broken by closer year
    assert s[0] == [100, 100, 50]
    for p, row in enumerate(n):
        assert 0 not in row and 5 not in row
    assert len(n[1]) == 3               # items 2, 3, 4


def test_no_description_year_unknown_sorts_last_among_ties():
    items = [item(0, "a", desc="", year=2000), item(1, "a", year=0), item(2, "a", year=1950)]
    n, _ = neighbours(items, unit([[1, 0], [1, 0], [0, 1]]))
    assert n[0] == [2, 1]


# --- embed: cache behaviour, with a fake encoder (no model download) ---

from pipeline.similarity import embed, embed_text  # noqa: E402


class FakeEncoder:
    def __init__(self):
        self.calls = []

    def __call__(self, model_name, texts):
        self.calls.append(list(texts))
        return np.array([[len(t), 1.0, 2.0] for t in texts], dtype=np.float32)


def test_embed_normalises_and_zeroes_missing_descriptions(tmp_path):
    enc = FakeEncoder()
    items = [item(1, "a", desc="ერთი"), item(2, "a", desc=""), item(3, "a", desc="სამი სიტყვა")]
    emb = embed(items, tmp_path, model_name="fake/model", encode=enc)
    assert emb.shape == (3, 3)
    assert np.allclose(np.linalg.norm(emb, axis=1), [1, 0, 1])
    assert sum(len(c) for c in enc.calls) == 2      # the empty description is never embedded


def test_embed_reuses_cache_and_embeds_only_new_or_changed(tmp_path):
    items = [item(1, "a", desc="ერთი"), item(2, "a", desc="ორი")]
    first = embed(items, tmp_path, model_name="fake/model", encode=FakeEncoder())
    enc = FakeEncoder()
    again = embed(items, tmp_path, model_name="fake/model", encode=enc)
    assert enc.calls == [] and np.array_equal(first, again)
    items[1] = item(2, "a", desc="ორი შეცვლილი")
    items.append(item(3, "a", desc="სამი"))
    embed(items, tmp_path, model_name="fake/model", encode=enc)
    assert len(enc.calls) == 1 and len(enc.calls[0]) == 2
    other = FakeEncoder()
    embed(items, tmp_path, model_name="other/model", encode=other)   # cache is per model
    assert len(other.calls[0]) == 3


def test_embed_survives_corrupt_cache(tmp_path):
    items = [item(1, "a", desc="ერთი")]
    embed(items, tmp_path, model_name="fake/model", encode=FakeEncoder())
    for f in tmp_path.iterdir():
        f.write_bytes(b"garbage")
    enc = FakeEncoder()
    assert embed(items, tmp_path, model_name="fake/model", encode=enc).shape == (1, 3)
    assert len(enc.calls) == 1


def test_embed_text_empty_without_description():
    assert embed_text(item(1, "a", desc="")) == ""
    assert "t1" in embed_text(item(1, "a", desc="რაღაც"), "title_desc")


def test_center_removes_common_direction():
    from pipeline.similarity import center

    rng = np.random.default_rng(2)
    raw = unit(rng.normal(size=(50, 6)) * 0.1 + np.array([5, 0, 0, 0, 0, 0]))
    items = [item(i, "a") for i in range(50)]
    items[3] = item(3, "a", desc="")
    raw[3] = 0
    assert np.median(raw[:3] @ raw[4:].T) > 0.9          # everything looks alike before
    out = center(items, raw)
    assert np.allclose(np.linalg.norm(np.delete(out, 3, axis=0), axis=1), 1, atol=1e-5)
    assert not out[3].any()                               # no-description row stays zero
    assert abs(np.median(out[:3] @ out[4:].T)) < 0.3
    assert raw[0, 0] > 0.9                                # input not modified


def test_center_tiny_set_is_unchanged():
    from pipeline.similarity import center

    emb = unit([[1.0, 0.0]])
    assert np.array_equal(center([item(1, "a")], emb), emb)


def test_plot_vectors_mixes_title_and_zeroes_missing(tmp_path):
    from pipeline.similarity import plot_vectors

    def enc(model_name, texts):
        rng = np.random.default_rng(len("".join(texts)))
        return unit(rng.normal(size=(len(texts), 5)))

    items = [item(i, "a", desc=f"აღწერა {i}") for i in range(6)]
    items[2] = item(2, "a", desc="")
    with_title = plot_vectors(items, tmp_path, model_name="fake/model", encode=enc)
    no_title = plot_vectors(items, tmp_path, model_name="fake/model", title_weight=0, encode=enc)
    assert with_title.shape == (6, 5)
    assert np.allclose(np.linalg.norm(np.delete(with_title, 2, axis=0), axis=1), 1, atol=1e-5)
    assert not with_title[2].any() and not no_title[2].any()
    assert not np.allclose(with_title, no_title)
