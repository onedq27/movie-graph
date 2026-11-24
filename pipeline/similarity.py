"""Plot embeddings (cached) and nearest neighbours for one set of items.

Model and text recipe were chosen by a spot check on real data; the evidence
is in docs/similarity.md.
"""
import hashlib
import re
from pathlib import Path

import numpy as np

from pipeline.extract import Item

MODEL = "intfloat/multilingual-e5-large-instruct"
RECIPE = "desc"
# The title is embedded too (as "title. description") and mixed in at this weight:
# it keeps sequels together, while a full-weight title pulls in films that merely
# share a title word ("Iron Man" -> "The Man in the Iron Mask").
TITLE_WEIGHT = 1.0
# Tuned on real data (docs/similarity.md): with centred embeddings 0.7/0.3 still let
# same-genre titles with unrelated plots into the lists; 0.85/0.15 does not.
W_PLOT = 0.85
W_GENRE = 0.15
# Models that expect a prefix on every input. For a symmetric task the e5
# "instruct" model gets the same instruction on both sides.
_E5_INSTRUCTION = "Instruct: Retrieve movies and series with a similar plot\nQuery: "
PREFIXES = {
    "intfloat/multilingual-e5-large-instruct": _E5_INSTRUCTION,
    "intfloat/multilingual-e5-small": "query: ",
    "intfloat/multilingual-e5-base": "query: ",
    "intfloat/multilingual-e5-large": "query: ",
}
BATCH_SIZE = 32


def embed_text(item: Item, recipe: str = RECIPE) -> str:
    """The text that represents an item's plot; '' when there is no description."""
    if not item.description:
        return ""
    if recipe == "desc":
        return item.description
    if recipe == "title_desc":
        return f"{item.title_ka}. {item.description}"
    if recipe == "titles_desc":
        title = f"{item.title_ka} ({item.title_en})" if item.title_en else item.title_ka
        return f"{title}. {item.description}"
    raise ValueError(f"unknown recipe: {recipe}")


def _key(model_name: str, text: str) -> str:
    return hashlib.sha1(f"{model_name}\n{text}".encode("utf-8")).hexdigest()


def _cache_path(cache_dir: Path, model_name: str) -> Path:
    return Path(cache_dir) / ("emb-" + re.sub(r"[^A-Za-z0-9._-]+", "_", model_name) + ".npz")


def _load_cache(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        with np.load(path) as data:
            return dict(zip(data["keys"].tolist(), data["vecs"]))
    except Exception:  # unreadable cache: recompute rather than crash
        return {}


def _save_cache(path: Path, cache: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp.npz")
    keys = sorted(cache)
    np.savez(tmp, keys=np.array(keys), vecs=np.stack([cache[k] for k in keys]).astype(np.float32))
    tmp.replace(path)


def _encode(model_name: str, texts: list[str]) -> np.ndarray:
    from sentence_transformers import SentenceTransformer  # heavy import, only when needed

    model = SentenceTransformer(model_name)
    return np.asarray(model.encode(texts, batch_size=BATCH_SIZE, normalize_embeddings=True,
                                   show_progress_bar=len(texts) > 500), dtype=np.float32)


def embed(items: list[Item], cache_dir: Path, model_name: str = MODEL, recipe: str = RECIPE,
          encode=_encode) -> np.ndarray:
    """L2-normalised embedding per item (zero row for items without a description).

    Vectors are cached in cache_dir by model name + hash of the embedded text,
    so a re-run only embeds new or changed items.
    """
    prefix = PREFIXES.get(model_name, "")
    texts = [embed_text(it, recipe) for it in items]
    keys = [_key(model_name, prefix + t) if t else None for t in texts]
    path = _cache_path(cache_dir, model_name)
    cache = _load_cache(path)
    missing = {}
    for key, text in zip(keys, texts):
        if key is not None and key not in cache:
            missing[key] = prefix + text
    if missing:
        vecs = encode(model_name, list(missing.values()))
        cache.update(zip(missing, vecs))
        _save_cache(path, cache)
    dim = len(next(iter(cache.values()))) if cache else 1
    emb = np.zeros((len(items), dim), dtype=np.float32)
    for row, key in enumerate(keys):
        if key is not None:
            emb[row] = cache[key]
    norms = np.linalg.norm(emb, axis=1, keepdims=True)
    return emb / np.where(norms == 0, 1, norms)


def center(items: list[Item], emb: np.ndarray) -> np.ndarray:
    """Subtract the set's mean embedding and re-normalise.

    Raw cosines from these models sit in a narrow band (about 0.8-0.9 for any
    two descriptions), so 0.3 * Jaccard would decide every ranking. After
    centring an unrelated pair scores about 0 and the plot term carries real
    information. Rows of items without a description stay zero.
    """
    emb = np.array(emb, dtype=np.float32)
    mask = np.array([bool(it.description) for it in items], dtype=bool)
    if mask.sum() < 2:
        return emb
    emb[mask] -= emb[mask].mean(axis=0)
    norms = np.linalg.norm(emb[mask], axis=1, keepdims=True)
    emb[mask] /= np.where(norms == 0, 1, norms)
    emb[~mask] = 0
    return emb


def plot_vectors(items: list[Item], cache_dir: Path, model_name: str = MODEL,
                 title_weight: float = TITLE_WEIGHT, encode=_encode) -> np.ndarray:
    """The vectors neighbours() should get for one set: centred description
    embedding plus title_weight * centred "title. description" embedding,
    re-normalised. Rows of items without a description are zero."""
    out = center(items, embed(items, cache_dir, model_name, "desc", encode))
    if title_weight:
        out = out + title_weight * center(items, embed(items, cache_dir, model_name, "title_desc", encode))
        norms = np.linalg.norm(out, axis=1, keepdims=True)
        out = out / np.where(norms == 0, 1, norms)
    return out.astype(np.float32)


def _genre_matrix(items: list[Item]) -> np.ndarray:
    names = sorted({g for it in items for g in it.genres})
    col = {g: i for i, g in enumerate(names)}
    mat = np.zeros((len(items), max(1, len(names))), dtype=np.float32)
    for row, it in enumerate(items):
        for g in it.genres:
            mat[row, col[g]] = 1.0
    return mat


def neighbours(items: list[Item], emb: np.ndarray, k: int = 30, w_plot: float = 0.7,
               w_genre: float = 0.3, block: int = 1024) -> tuple[list[list[int]], list[list[int]]]:
    """Top-k neighbour positions and 0-100 scores for every item of ONE set.

    score = round(100 * clamp(w_plot * cosine + w_genre * genre Jaccard, 0, 1)).
    Items without a description are nobody's neighbour; their own list is
    ranked by genre Jaccard alone (ties: closer year), score = round(100 * Jaccard),
    and holds only items sharing at least one genre.
    """
    n = len(items)
    if n == 0:
        return [], []
    emb = np.asarray(emb, dtype=np.float32)
    has_desc = np.array([bool(it.description) for it in items])
    years = np.array([it.year for it in items], dtype=np.float64)
    genres = _genre_matrix(items)
    genre_count = genres.sum(axis=1)
    positions = np.arange(n)
    out_n, out_s = [], []
    for start in range(0, n, block):
        rows = slice(start, min(start + block, n))
        inter = genres[rows] @ genres.T
        union = genre_count[rows, None] + genre_count[None, :] - inter
        jac = np.divide(inter, union, out=np.zeros_like(inter), where=union > 0)
        score = w_plot * (emb[rows] @ emb.T) + w_genre * jac
        for i, p in enumerate(range(rows.start, rows.stop)):
            allowed = has_desc.copy()
            allowed[p] = False
            if has_desc[p]:
                cand = positions[allowed]
                order = np.lexsort((cand, -score[i, cand]))[:k]
                top = cand[order]
                final = np.clip(score[i, top], 0.0, 1.0)
            else:
                cand = positions[allowed & (jac[i] > 0)]
                gap = np.abs(years[cand] - years[p])
                gap[(years[cand] == 0) | (years[p] == 0)] = np.inf
                order = np.lexsort((cand, gap, -jac[i, cand]))[:k]
                top = cand[order]
                final = jac[i, top]
            out_n.append([int(q) for q in top])
            out_s.append([int(v) for v in np.rint(100 * final.astype(np.float64))])
    return out_n, out_s
