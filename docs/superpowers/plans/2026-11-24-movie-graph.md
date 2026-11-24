# Movie Graph (gemovie.tv) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An installable static web app that shows, for any gemovie.tv movie or series, its 10–15 most similar titles (plot + genre) as an interactive graph, with a detail panel and name/ID/genre filters.

**Architecture:** A local Python pipeline (scrape → extract → embed → neighbours → export) writes compact JSON into `app/data/`. A build-less static app (ES modules + vendored d3) reads only that JSON. A service worker and manifest make it a PWA served from GitHub Pages.

**Tech Stack:** Python 3.12 in `.venv` (created with `uv`), `sentence-transformers`, `numpy`, `pytest`; vanilla JS ES modules, d3 v7 (vendored, no CDN), `node --test`; GitHub Actions Pages deploy.

**Spec:** `docs/superpowers/specs/2026-11-24-movie-graph-design.md` (Georgian). Read it first.

## Global Constraints

- Everything is free and local: no paid APIs, no text sent to external services.
- Movies and series are separate sets: neighbours never cross sets.
- Score = 0.7 × plot cosine + 0.3 × genre Jaccard (weights may be tuned on examples, see Task 3). Top 30 neighbours stored per item.
- Items with an empty description never appear as anyone's neighbour; their own neighbours are genre-only and they carry the `nd` flag.
- UI language is Georgian. Light and dark theme follow the system.
- All app URLs are relative (the app is served from `https://<user>.github.io/<repo>/`). No CDN: every script/style is local so the shell works offline.
- Scraped strings are untrusted: insert them with `textContent` / attribute setters, never `innerHTML`.
- No single data file the phone must load up front may exceed ~4 MB uncompressed.
- Do NOT run git commands. The repository is initialised and committed by the coordinator at the end.
- `data/raw/pages.jsonl` is being appended to by a running scraper. Read it only; tolerate a truncated last line. Do not start another scrape.

## Data Contract (pipeline → app)

All files live in `app/data/`. `{set}` is `movie` or `serial`. Position `p` is an item's index in the index arrays (items sorted by id ascending).

- `meta.json`: `{"version": "<UTC yyyymmddThhmm>", "genres": ["დრამა", ...], "sets": {"movie": {"count": N, "chunkSize": 500, "chunks": K}, "serial": {...}}}`. `genres` is sorted by frequency, descending.
- `{set}.index.json` (columnar, equal-length arrays): `{"id": [int], "ka": [str], "en": [str], "year": [int, 0 if unknown], "g": [[genre index into meta.genres]], "nd": [0|1]}`.
- `{set}.nb.json`: `{"n": [[p, ...]], "s": [[int 0–100, ...]]}` — for each item up to 30 neighbour positions, best first, with matching scores.
- `{set}.d.{k}.json` where `k = floor(p / 500)`: `{"desc": [str], "img": [str], "url": [str]}`; item `p` is at `p % 500`.

App fetches data files as `data/<name>?v=<meta.version>`; `meta.json` itself is fetched without a version.

## File Map

```
pipeline/scrape.py        (exists) sitemaps → data/raw/pages.jsonl, data/raw/sitemap_keys.json
pipeline/extract.py       pages.jsonl → list of Item
pipeline/similarity.py    embeddings (cached) + neighbours
pipeline/export.py        writes the data contract into app/data/
pipeline/run.py           extract → similarity → export, prints a summary
tests/                    pytest for the pipeline
requirements.txt
app/index.html, app/css/app.css
app/js/main.js            wiring, state, routing (location.hash)
app/js/data.js            loads meta/index/nb/detail chunks
app/js/search.js          pure filtering (name / id / genres)
app/js/graph.js           d3 force graph
app/js/panel.js           detail panel / bottom sheet
app/js/tests/*.test.mjs   node --test for search.js and data.js helpers
app/vendor/d3.min.js
app/dev/make_fixture.py   dev-only fixture in contract format
app/manifest.webmanifest, app/sw.js, app/icons/*.png
.github/workflows/pages.yml, .gitignore, README.md
```

## Review Focus

1. **Page without usable data** (`status` not `ok`, `entity` null, name without ` | `, missing genre/description, duplicate keys, truncated last line): the pipeline skips or falls back and never crashes. → Task 2 tests.
2. **Item with fewer neighbours than the slider asks for** (small set, `nd` item, single-genre oddity): the graph draws what exists and the slider does not break. → Task 5.
3. **Search input variety** (Georgian text, Latin text in any case, partial title, pure digits as ID, empty query, a query matching thousands): results are correct and the list stays fast (cap rendered rows). → Task 4 tests.
4. **Network failure on a detail chunk or poster** (offline phone): panel still shows title/year/genres, a clear "ვერ ჩაიტვირთა" with retry, broken poster hidden. → Task 5.
5. **Stale data on an installed phone after a re-export**: new `meta.version` makes the app fetch fresh data files; old cached versions are dropped. → Task 6.

---

### Task 1: Scraper (done by coordinator)

`pipeline/scrape.py` exists and is running. Output line format:
`{"key": "movie:1894", "type": "movie"|"serial", "id": int, "url": str, "lastmod": str, "status": "ok"|"no_ld"|"http_404"|"http_410"|"error", "entity": {...}|null}`.
`entity` is the page's ld+json `Movie` / `TVEpisode` object without `actor`: `name`, `description`, `genre` (list of Georgian names), `image`, `url`, `contentRating`.
`data/raw/sitemap_keys.json` is the list of keys currently in the sitemaps.

### Task 2: Extract

**Files:** Create `pipeline/extract.py`, `tests/test_extract.py`, `requirements.txt`, `.venv` (`uv venv --python 3.12 .venv`).

**Produces:**
- `@dataclass Item: id: int; type: str; title_ka: str; title_en: str; year: int; genres: list[str]; description: str; image: str; url: str`
- `parse_name(name: str) -> tuple[str, str]`
- `load_items(pages_path: Path, sitemap_keys_path: Path | None = None) -> list[Item]`

- [ ] Tests first, with these exact cases:
  - `parse_name("რკინის კაცი ქართულად | Iron Man qartulad - GEMOVIE.TV") == ("რკინის კაცი", "Iron Man")`
  - `parse_name("მწვანე გველი ქართულად | Green Snake (白蛇2：青蛇劫起) qartulad - GEMOVIE.TV")[1] == "Green Snake (白蛇2：青蛇劫起)"`
  - `parse_name("Solo Title")` → `("Solo Title", "")`; HTML entities in names/descriptions are unescaped.
  - year comes from the URL slug (`...-qartulad-2008` → 2008), `0` when absent.
  - description: stripped; a trailing `...` is kept as is; missing → `""`.
  - `load_items`: skips non-`ok` records and null entities; last line wins for a duplicate key; ignores a truncated last line; when `sitemap_keys_path` is given, drops keys not in it; missing `genre` → `[]`; returns items sorted by `(type, id)`.
- [ ] Implement, run `.venv/bin/pytest tests/test_extract.py -v` → all pass.

### Task 3: Similarity + export + run

**Files:** Create `pipeline/similarity.py`, `pipeline/export.py`, `pipeline/run.py`, `tests/test_similarity.py`, `tests/test_export.py`.

**Consumes:** `Item`, `load_items` from Task 2.

**Produces:**
- `embed(items: list[Item], cache_dir: Path) -> np.ndarray` — L2-normalised rows; cache keyed by model name + hash of the embedded text so re-runs only embed new/changed items.
- `neighbours(items: list[Item], emb: np.ndarray, k: int = 30, w_plot: float = 0.7, w_genre: float = 0.3) -> tuple[list[list[int]], list[list[int]]]` — positions and 0–100 integer scores for ONE set.
- `export(items_by_set: dict[str, list[Item]], nb_by_set: dict, out_dir: Path, version: str) -> None` — writes the Data Contract.
- `python -m pipeline.run` (from repo root): load → embed → neighbours per set → export to `app/data/` → print counts per set, number of `nd` items, file sizes, and the neighbours of Iron Man (movie id 1894) if present.

- [ ] Tests first (`neighbours` and `export` take plain arrays, so tests use tiny hand-made embeddings, no model download):
  - an item never lists itself; lists are sorted by score descending; at most `k` entries; fewer when the set is small.
  - score = `round(100 * clamp(0.7*cos + 0.3*jaccard, 0, 1))` — pin one hand-computed value.
  - an item with `description == ""` appears in nobody's list; its own list is ordered by genre Jaccard only (ties: closer year first) and its score is `round(100 * jaccard)`.
  - `export`: arrays in `{set}.index.json` have equal length; `nd` is 1 exactly for empty descriptions; chunk `k` holds items `500k … 500k+499`; `meta.genres` sorted by frequency; every neighbour position `< count`; round-trips through `json.load`.
- [ ] Implement. Choose the embedding model by a spot check on real data (candidates: `intfloat/multilingual-e5-small`, `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`, `sentence-transformers/LaBSE`; all must run locally on an M1 with 16 GB). Embed description plus title; judge on ~8 well-known titles whether neighbours make plot sense, and pick the better model and text recipe. Record the choice and the evidence in `README.md` under "Similarity".
- [ ] Run `.venv/bin/pytest -v` → all pass. Run `.venv/bin/python -m pipeline.run` on whatever part of `pages.jsonl` exists and report the printed summary.

### Task 4: App shell, data loading, search

**Files:** Create `app/index.html`, `app/css/app.css`, `app/js/main.js`, `app/js/data.js`, `app/js/search.js`, `app/js/tests/search.test.mjs`, `app/dev/make_fixture.py`.

**Produces:**
- `data.js`: `loadMeta(): Promise<Meta>`, `loadSet(set): Promise<{index, nb}>`, `loadDetail(set, p): Promise<{desc, img, url}>` (fetches and memoises the chunk), `chunkOf(p, chunkSize): [k, offset]`.
- `search.js`: `filterItems(index, {query, genres}) : number[]` — positions. Digits-only query matches ids by prefix (exact id first); otherwise case-insensitive substring over `ka` and `en`; `genres` (array of genre indexes) requires ALL selected genres; empty query + no genres → all positions, newest id first.
- `index.html` contains `<link rel="manifest" href="manifest.webmanifest">`, `<meta name="theme-color">`, apple-touch-icon → `icons/icon-192.png`, and `main.js` registers `sw.js` (guarded: only when `'serviceWorker' in navigator` and not on `file:`).
- State lives in `location.hash`: `#/{set}` (list) and `#/{set}/{id}` (graph), so browser back works and links are shareable.

- [ ] `app/dev/make_fixture.py`: builds contract-format files in `app/data/` from the first ~300 `ok` lines of `data/raw/pages.jsonl` with random neighbours (dev only; the real export overwrites it).
- [ ] Tests first for `filterItems` (`node --test app/js/tests/`): Georgian substring, Latin case-insensitive, digits → id prefix with exact id first, multi-genre AND, empty query ordering, no matches → `[]`.
- [ ] Implement shell per the spec's wireframe: set switch "ფილმები / სერიალები", search box, genre multi-select, result list (render at most 100 rows, "მეტის ჩვენება" loads more), graph area + panel area. Phone layout (< 720px): single column, panel as bottom sheet.
- [ ] Verify: `node --test app/js/tests/` passes; `python3 -m http.server -d app 8765` serves a working list from the fixture.

### Task 5: Graph and panel

**Files:** Create `app/js/graph.js`, `app/js/panel.js`, `app/vendor/d3.min.js` (d3 v7, downloaded once); modify `app/js/main.js`.

**Consumes:** `loadSet`, `loadDetail`, `filterItems`, hash routing from Task 4.

**Produces:**
- `graph.js`: `renderGraph(container, {index, nb, center: p, count, dimmed: Set<number>, onSelect(p), onRecentre(p)})`.
- `panel.js`: `showPanel(el, {set, p, index, meta, noDescription: boolean, onRecentre})`.

- [ ] Graph: centre node + first `count` neighbours (slider 5–30, default 12). Link from centre to each neighbour, plus a link between two shown neighbours when either lists the other in its top 30. Link width/length follow the score; node colour = first genre; labels are `ka` titles (truncate long ones). Drag, zoom, pan, touch. Fewer neighbours than `count` → draw what exists.
- [ ] Genre filter while a graph is open: neighbours missing the selected genres are dimmed, not removed.
- [ ] Tap a node → panel: poster (hidden on load error), `ka` / `en` title, year, genres, description, button "უყურე gemovie.tv-ზე" (`target="_blank" rel="noopener"`), button "ამის ირგვლივ აჩვენე" (re-centres, updates hash). For `nd` items show "აღწერა არ არის — კავშირები მხოლოდ ჟანრითაა". Detail fetch failure → "ვერ ჩაიტვირთა" + retry button; title/year/genres still shown.
- [ ] Verify in headless Chrome against the fixture (`"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --screenshot=... --window-size=1280,800 http://localhost:8765/#/movie/<id>` and a 390×844 phone size); read the screenshots and fix what looks broken.

### Task 6: PWA and deploy files

**Files:** Create `app/manifest.webmanifest`, `app/sw.js`, `app/icons/icon-192.png`, `app/icons/icon-512.png`, `app/icons/icon-maskable-512.png`, `.github/workflows/pages.yml`, `.gitignore`, `README.md`.

**Consumes (fixed names, do not create these):** shell files `index.html`, `css/app.css`, `js/main.js`, `js/data.js`, `js/search.js`, `js/graph.js`, `js/panel.js`, `vendor/d3.min.js`.

- [ ] `manifest.webmanifest`: Georgian `name` "ფილმების გრაფი", `short_name` "ფილმები", `start_url: "./"`, `scope: "./"`, `display: "standalone"`, theme/background colours, the three icons (one `purpose: "maskable"`). Icons: generate real PNGs (a simple graph glyph) with a script using only the Python stdlib or Chrome headless; no external assets.
- [ ] `sw.js`: precache the shell list; shell = stale-while-revalidate; `data/meta.json` = network-first with cache fallback; other `data/*` = cache-first (URLs carry `?v=`); on activate delete cached `data/*` entries whose `v` differs from the newest seen; cross-origin requests (posters) pass through untouched.
- [ ] `.github/workflows/pages.yml`: on push to `main`, upload `app/` as the Pages artifact and deploy (`actions/configure-pages`, `actions/upload-pages-artifact`, `actions/deploy-pages`).
- [ ] `.gitignore`: `.venv/`, `data/`, `__pycache__/`, `.pytest_cache/`, `.idea/`, `.DS_Store`. (`app/data/` IS committed.)
- [ ] `README.md` (Georgian): what it is, how to refresh data (`python3 pipeline/scrape.py` then `.venv/bin/python -m pipeline.run`), how to install on a phone (Android Chrome and iPhone Safari steps). Leave a "Similarity" heading for Task 3 to fill.
- [ ] Verify: manifest parses as JSON and icons have the declared pixel sizes; `node --check app/sw.js` passes.

### Task 7: Integrate and verify (coordinator)

- [ ] After the scrape finishes: `.venv/bin/python -m pipeline.run` on the full data; check sizes against the 4 MB constraint and the `nd` count.
- [ ] Serve `app/`, screenshot desktop + phone sizes in headless Chrome on real data, spot-check neighbours of several known titles in both sets.
- [ ] `git init`, first commit. Publishing (GitHub repo + Pages) only after the user confirms.
