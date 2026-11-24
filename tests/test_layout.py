import math

import numpy as np

from pipeline import layout
from pipeline.extract import Item


def make(n, genre):
    return [Item(id=i, type="movie", title_ka="", title_en="", year=2000, genres=[genre] if genre else [],
                 description="d", image="", url="") for i in range(n)]


def flat_project(emb):  # deterministic stand-in for UMAP
    return np.asarray(emb, dtype=float)[:, :2]


def test_ring_count():
    assert [layout.ring_count(n) for n in (0, 1, 2, 7, 8, 19, 20)] == [0, 0, 1, 1, 2, 2, 3]


def test_seat_on_rings_never_overlaps():
    rng = np.random.RandomState(0)
    pts = layout.seat_on_rings(rng.normal(size=(500, 2)))
    assert len({(round(x, 6), round(y, 6)) for x, y in pts}) == 500
    d = np.hypot(*(pts[:, None, :] - pts[None, :, :]).transpose(2, 0, 1))
    np.fill_diagonal(d, 9)
    assert d.min() > 0.9  # neighbouring slots are about one unit apart


def test_seat_on_rings_keeps_inner_points_inside():
    pts = np.array([[0, 0], [5, 0], [0, 6], [-7, 0], [0, -8], [9, 9], [-9, 9], [50, 0]], dtype=float)
    seated = layout.seat_on_rings(pts)
    assert np.hypot(*seated[-1]) > np.hypot(*seated[1])  # the far point is on an outer ring


def test_seat_on_rings_handles_identical_and_tiny_inputs():
    assert layout.seat_on_rings(np.zeros((0, 2))).shape == (0, 2)
    assert layout.seat_on_rings(np.zeros((1, 2))).tolist() == [[0.0, 0.0]]
    same = layout.seat_on_rings(np.zeros((30, 2)))
    assert len({(round(x, 6), round(y, 6)) for x, y in same}) == 30


def test_pack_discs_leaves_the_gap():
    radii = [10.5, 6.5, 6.5, 3.5, 1.5, 0.5]
    c = layout.pack_discs(radii, gap=2.0)
    for i in range(len(radii)):
        for j in range(i):
            assert math.hypot(*(c[i] - c[j])) >= radii[i] + radii[j] + 2.0 - 1e-9


def test_to_grid_range_and_aspect():
    g = layout.to_grid(np.array([[0, 0], [10, 0], [10, 5]], dtype=float))
    assert g.min() >= 0 and g.max() <= layout.GRID
    assert g[1][0] - g[0][0] == layout.GRID and g[2][1] - g[1][1] == layout.GRID // 2


def test_layout_separates_genres_and_covers_everyone():
    items = make(60, "დრამა") + make(25, "კომედია") + make(1, None)
    emb = np.random.RandomState(1).normal(size=(len(items), 8)).astype(np.float32)
    xy = layout.layout(items, emb, project=flat_project)
    assert xy.shape == (86, 2) and xy.min() >= 0 and xy.max() <= layout.GRID
    assert len({tuple(p) for p in xy.tolist()}) == 86
    a, b = xy[:60].astype(float), xy[60:85].astype(float)
    ca, cb = a.mean(axis=0), b.mean(axis=0)
    ra = np.hypot(*(a - ca).T).max()
    rb = np.hypot(*(b - cb).T).max()
    assert math.hypot(*(ca - cb)) > ra + rb  # the two genre discs do not touch


def test_layout_empty():
    assert layout.layout([], np.zeros((0, 8))).shape == (0, 2)
