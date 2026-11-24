// Pure grouping for the "სექციები" list view: one newest-first list per genre. No DOM.

const cache = new WeakMap();

/**
 * @param index columnar index ({id, g, ...}); positions ascend with id, so "newest" = highest p
 * @param {number} genreCount meta.genres.length
 * @returns {{gi: number, items: number[]}[]} in meta.genres order (most frequent first),
 *   empty genres skipped. An item with several genres is listed under each of them.
 */
export function groupByGenre(index, genreCount) {
  const lists = Array.from({ length: Math.max(0, genreCount | 0) }, () => []);
  const g = index.g;
  for (let p = index.id.length - 1; p >= 0; p--) {
    const have = g[p] || [];
    for (let k = 0; k < have.length; k++) {
      const list = lists[have[k]];
      // guard against a repeated genre on one item
      if (list && list[list.length - 1] !== p) list.push(p);
    }
  }
  const out = [];
  lists.forEach((items, gi) => { if (items.length) out.push({ gi, items }); });
  return out;
}

/** groupByGenre, computed once per loaded index. */
export function genreSections(index, genreCount) {
  let hit = cache.get(index);
  if (!hit || hit.genreCount !== genreCount) {
    hit = { genreCount, sections: groupByGenre(index, genreCount) };
    cache.set(index, hit);
  }
  return hit.sections;
}
