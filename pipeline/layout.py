"""2D map coordinates for one set: one disc per genre, titles inside a disc
arranged by plot.

A plain UMAP of all titles gave a few tiny, overlapping blobs in a mostly empty
square, which is useless as a map. So the layout is built in three steps:

1. Titles are grouped by their FIRST genre (the app colours a dot by it).
2. Inside a group, a 2D projection of the plot vectors decides who sits next to
   whom, and the points are then snapped onto evenly spaced rings (ring k holds
   6k points), so no two dots overlap and every disc has the same density.
3. The discs (radius grows with sqrt(count)) are packed around the largest one.
"""
import math

import numpy as np

from pipeline.extract import Item

GRID = 1000  # coordinates are integers 0..GRID
GAP = 2.5  # free space between two genre discs, in dot spacings
NO_GENRE = ""


def ring_count(n: int) -> int:
    """Number of rings (beyond the centre dot) needed to seat n points."""
    k = 0
    while 1 + 3 * k * (k + 1) < n:
        k += 1
    return k


def seat_on_rings(xy: np.ndarray) -> np.ndarray:
    """Move n projected points onto ring slots: the centre, then ring k with 6k
    slots at radius k. Points nearer the projection's centre get inner rings and
    keep their angular order, so neighbours in the projection stay neighbours."""
    n = len(xy)
    out = np.zeros((n, 2), dtype=np.float64)
    if n == 0:
        return out
    rel = np.asarray(xy, dtype=np.float64) - np.median(xy, axis=0)
    radius = np.hypot(rel[:, 0], rel[:, 1])
    angle = np.arctan2(rel[:, 1], rel[:, 0])
    by_radius = np.argsort(radius, kind="stable")
    start, k = 1, 1  # by_radius[0] stays at the centre
    while start < n:
        members = by_radius[start:start + 6 * k]
        members = members[np.argsort(angle[members], kind="stable")]
        m = len(members)
        step = 2 * math.pi / m
        # Rotate the ring so its slots sit as close as possible to the members' own angles.
        offset = float(np.angle(np.exp(1j * (angle[members] - step * np.arange(m))).mean()))
        theta = offset + step * np.arange(m)
        out[members, 0] = k * np.cos(theta)
        out[members, 1] = k * np.sin(theta)
        start += m
        k += 1
    return out


def pack_discs(radii: list[float], gap: float = GAP) -> np.ndarray:
    """Centres for the discs, given largest first: the first at the origin, each
    later one at the free spot closest to the origin."""
    centres: list[tuple[float, float]] = []
    for i, r in enumerate(radii):
        if i == 0:
            centres.append((0.0, 0.0))
            continue
        best = None
        dist = radii[0] + r + gap
        while best is None:
            steps = max(24, int(2 * math.pi * dist / 2))
            for s in range(steps):
                a = 2 * math.pi * s / steps
                x, y = dist * math.cos(a), dist * math.sin(a)
                if all(math.hypot(x - cx, y - cy) >= r + cr + gap
                       for (cx, cy), cr in zip(centres, radii)):
                    best = (x, y)
                    break
            dist += 1.0
        centres.append(best)
    return np.array(centres, dtype=np.float64)


def to_grid(xy: np.ndarray, grid: int = GRID) -> np.ndarray:
    """Scale to integers 0..grid, keeping the aspect ratio and centring the map."""
    xy = np.asarray(xy, dtype=np.float64)
    if len(xy) == 0:
        return np.zeros((0, 2), dtype=int)
    lo, hi = xy.min(axis=0), xy.max(axis=0)
    span = float(max((hi - lo).max(), 1e-9))
    unit = (xy - (lo + hi) / 2) / span + 0.5
    return np.clip(np.rint(unit * grid), 0, grid).astype(int)


def project(emb: np.ndarray, seed: int = 42) -> np.ndarray:
    """2D projection of one genre's plot vectors (UMAP; PCA for tiny groups)."""
    n = len(emb)
    if n < 3:
        return np.column_stack([np.arange(n, dtype=np.float64), np.zeros(n)])
    if n < 40:
        x = emb - emb.mean(axis=0)
        _, _, vt = np.linalg.svd(x, full_matrices=False)
        return x @ vt[:2].T
    import umap  # imported late: slow to load and not needed by the unit tests

    return umap.UMAP(n_components=2, n_neighbors=min(20, n - 1), min_dist=0.5,
                     metric="cosine", random_state=seed).fit_transform(emb)


def layout(items: list[Item], emb: np.ndarray, project=project) -> np.ndarray:
    """Return an (n, 2) integer array of map coordinates in 0..GRID."""
    emb = np.asarray(emb, dtype=np.float32)
    groups: dict[str, list[int]] = {}
    for row, it in enumerate(items):
        groups.setdefault(it.genres[0] if it.genres else NO_GENRE, []).append(row)
    order = sorted(groups, key=lambda g: (-len(groups[g]), g))
    radii = [ring_count(len(groups[g])) + 0.5 for g in order]
    centres = pack_discs(radii)
    xy = np.zeros((len(items), 2), dtype=np.float64)
    for genre, centre in zip(order, centres):
        rows = groups[genre]
        xy[rows] = seat_on_rings(np.asarray(project(emb[rows]), dtype=np.float64)) + centre
    return to_grid(xy)
