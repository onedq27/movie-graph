# Similarity: model choice and evidence

Measured 2026-11-24 on the full scrape: 10,329 movies and 1,318 series.

## What the pipeline does

- **Model:** `intfloat/multilingual-e5-large-instruct` (local, free, ~2.2 GB download), with the
  instruction `Instruct: Retrieve movies and series with a similar plot\nQuery: ` on every text.
- **Text:** two embeddings per item — the description alone, and `"<Georgian title>. <description>"`.
  Each is centred (the set's mean vector subtracted, re-normalised), then added 1:1 and normalised
  (`similarity.plot_vectors`, `TITLE_WEIGHT = 1.0`).
- **Score:** `0.85 × plot cosine + 0.15 × genre Jaccard` (`W_PLOT`, `W_GENRE`), top 30 per item,
  movies and series separately.
- **No description:** 237 movies and 5 series carry only the site-wide meta description
  ("GEMOVIE | ჯიმუვი - უახლესი ფილმები ქართულად 4K ხარისხში…") instead of a plot. `extract.py` turns
  that into an empty description, so they get the `nd` flag, genre-only neighbours, and never
  appear in anyone else's list. No page had a literally empty description.

## Why these choices

**Centring.** Raw cosines are useless for mixing with genres: for e5-small any two descriptions
score 0.79–0.87 (5th–95th percentile), so `0.3 × Jaccard` decided every ranking — Iron Man's first
ten neighbours all had Jaccard 1.0 and no plot relation. After centring an unrelated pair scores
about 0. It also cut the share of titles that appear in nobody's top 10 from 7–11% to 1–5%.

**Model.** Two proxies on movies with a description (10,092), description-only embedding, centred,
plot cosine only:
"franchise recall@10" = for titles that belong to a franchise by English title (1,645 titles), is a
sibling among the 10 nearest; "genre agreement" = mean genre Jaccard of the 10 nearest (random pair: 0.156).

| model | franchise recall@10 | genre agreement | notes |
|---|---|---|---|
| multilingual-e5-large-instruct | 0.490 | 0.334 | n = 10,329 (run before the boilerplate fix) |
| BAAI/bge-m3 | 0.439 | 0.301 | |
| multilingual-e5-small | 0.289 | 0.264 | |

On an identical 6,400-movie snapshot: e5-large-instruct 0.522 / 0.320, bge-m3 0.463 / 0.284.
Earlier, on smaller partial scrapes (2,200–4,300 movies, numbers not comparable across rows because
the scrape was growing): LaBSE 0.539 / 0.281, e5-base 0.472 / 0.267, paraphrase-multilingual-MiniLM
0.297 / 0.271, e5-large (non-instruct) 0.382 / 0.267; bge-m3 on its partial set had 0.622 / 0.298.
The neighbour lists agreed with the numbers: with the small models Home Alone's nearest plots
included "Lee Cronin's The Mummy", and MiniLM gave Se7en a list of unrelated titles at cosine 0.85+.
`Qwen/Qwen3-Embedding-0.6B` was dropped unmeasured: about 7 s per batch of 32 on this machine.

**Title weight.** Title fully inside the text finds sequels (franchise@12 with the final score: 0.82)
but pulls in films that only share a title word: Iron Man → "The Man with the Iron Fists",
"The Man in the Iron Mask", "Iron Sky"; The Green Mile → "Green Book", "The Green Knight".
Description alone loses sequels (0.58; Iron Man 2 ranked 7th). The 1:1 mix gives 0.69 and removed
those false matches from the checked lists.

**Weights.** Share of top-12 neighbours whose description cosine is below 0.15 (i.e. in the list
because of genre or title, not plot), 1:1 mix: 9.6% at 0.7/0.3, 2.5% at 0.8/0.2, 0.8% at 0.85/0.15,
0.2% at 0.9/0.1. Franchise@12: 0.66, 0.70, 0.69, 0.69. At 0.7/0.3 The Green Mile listed
"Dorian Gray" (cosine 0.05, same three genres). 0.85/0.15 was chosen.

## Example lists (final settings, score in front)

- **Iron Man** — 49 Iron Man 2; 47 Iron Man 3; 45 The Creator; 44 Iron Man: Rise of Technovore;
  42 Kin; 41 Iron Man & Hulk: Heroes United; 41 Transformers: Age of Extinction; 40 Firefox;
  39 Captain America: The First Avenger; 39 The Incredible Hulk
- **Dawn of the Dead (2004)** — 42 Ravenous; 41 28 Weeks Later; 39 Eden; 39 Earthquake; 38 The Divide;
  37 Worldbreaker; 37 The Colony; 35 I Am Legend; 35 Free Fire
- **The Matrix** — 57 The Terminator; 51 The Matrix Reloaded; 50 Edge of Tomorrow; 49 Singularity;
  48 Universal Soldier: The Return; 48 Ghost in the Shell (2017); 48 Ghost in the Shell (1995)
- **Se7en** — 49 Murder by Numbers; 48 Righteous Kill; 47 The Bone Collector; 45 8MM; 45 Hangman;
  45 Deceiver; 43 Le Samouraï; 42 The Postcard Killings; 42 Fallen
- **Home Alone** — 56 Home Alone 4; 53 Home Alone: The Holiday Heist; 52 Home Alone 2; 39 Mickey's
  Magical Christmas; 38 K-9 Adventures: A Christmas Tale; 37 Ho Ho Ho; 37 Teddy's Christmas
- **The Lord of the Rings: The Fellowship of the Ring** — 64 The Two Towers; 51 The Return of the King;
  51 The Hobbit: An Unexpected Journey; 49 The Desolation of Smaug; 43 The Battle of the Five Armies
- **Shrek** — 61 Shrek Forever After; 60 Shrek 2; 47 Ice Dragon; 46 Shrek the Halls; 46 A Minecraft
  Movie; 44 Shrek the Third; 44 Shrek 5; 41 Puss in Boots
- **The Green Mile** — 35 Stone; 32 Constantine; 31 Meet Joe Black; 31 The BFG; 30 Camp X-Ray;
  29 Sleepy Hollow; 27 The Condemned (weak: prison and supernatural themes, no close match)
- **Game of Thrones** (series) — 52 A Knight of the Seven Kingdoms; 43 Camelot; 41 House of the Dragon;
  39 Cursed; 37 The Rings of Power; 36 Vikings; 36 Barbarians
- **Sherlock** (series) — 47 The Smile Has Left Your Eyes; 46 The Frankenstein Chronicles;
  44 Criminal: UK; 44 Detective Hole; 44 Dublin Murders; 41 The Alienist
- **Breaking Bad** (series) — 36 Dopesick; 28 Sons of Anarchy; 27 The Sopranos; 27 The Wire;
  27 Happy Valley (plausible, low scores)
- **Stranger Things** (series) — 37 Eric; 31 Hysteria!; 29 The Pembrokeshire Murders; 26 Frankie Drake
  Mysteries; 26 Waco (weak after the first two)

## Known limits

- Scores are low in absolute terms: the best neighbour averages about 47, the 12th about 36; values
  above 65 are rare. Link width in the app should be scaled to the range shown, not to 0–100.
- Titles whose description is one vague sentence get loose lists (The Green Mile, Stranger Things).
- The series set is small (1,313 with a description), so close matches often do not exist.
- The title mix still lets some shared-title-word matches into ranks 15–30.

## Speed and cache

About 35–40 texts/s on the M1 Pro (MPS). A cold run embeds every item twice (two texts), roughly
10 minutes for the full set; this figure is extrapolated from partial runs (1,313 series texts in
about 35 s after model load), not timed end to end. Vectors are cached in
`data/cache/emb-<model>.npz` keyed by model name + text hash; a re-run with a warm cache spends
under a second on embeddings and about 8 s on neighbours.
