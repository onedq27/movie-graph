// Pure filtering over a columnar index ({id, ka, en, year, g, nd}). No DOM.

const prepared = new WeakMap();

export function normalize(s) {
  return String(s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function prep(index) {
  let c = prepared.get(index);
  if (!c) {
    c = {
      ka: index.ka.map(normalize),
      en: index.en.map(normalize),
      ids: index.id.map(String),
    };
    prepared.set(index, c);
  }
  return c;
}

// 0 = title starts with the query, 1 = a word starts with it, 2 = anywhere, -1 = no match.
function rank(text, q) {
  const at = text.indexOf(q);
  if (at < 0) return -1;
  if (at === 0) return 0;
  if (text[at - 1] === ' ' || text.indexOf(' ' + q, at - 1) >= 0) return 1;
  return 2;
}

/**
 * @param index columnar index
 * @param {{query?: string, genres?: number[]}} filter
 * @returns {number[]} positions, best first
 *
 * - digits-only query: exact id, then ids starting with the digits (ascending),
 *   then titles containing the digits (e.g. "1917", "300").
 * - other query: case-insensitive substring over ka and en; prefix matches first,
 *   newest id first within a group.
 * - genres: an item must have ALL of them.
 * - nothing set: every position, newest id first.
 */
export function filterItems(index, { query = '', genres = [] } = {}) {
  const n = index.id.length;
  const q = normalize(query);
  const g = index.g;
  const need = genres.length;
  const passes = need === 0
    ? () => true
    : (p) => {
        const have = g[p];
        if (have.length < need) return false;
        for (let k = 0; k < need; k++) if (!have.includes(genres[k])) return false;
        return true;
      };

  const out = [];
  if (!q) {
    for (let p = n - 1; p >= 0; p--) if (passes(p)) out.push(p);
    return out;
  }

  const c = prep(index);
  const buckets = [[], [], []];
  const scanTitles = (skip) => {
    for (let p = n - 1; p >= 0; p--) {
      if (skip && skip.has(p)) continue;
      if (!passes(p)) continue;
      const a = rank(c.ka[p], q);
      const b = rank(c.en[p], q);
      const r = a < 0 ? b : b < 0 ? a : Math.min(a, b);
      if (r >= 0) buckets[r].push(p);
    }
    return buckets[0].concat(buckets[1], buckets[2]);
  };

  if (/^\d+$/.test(q)) {
    const digits = q.replace(/^0+(?=\d)/, '');
    let exact = -1;
    for (let p = 0; p < n; p++) {
      const s = c.ids[p];
      if (!s.startsWith(digits) || !passes(p)) continue;
      if (s.length === digits.length) exact = p;
      else out.push(p);
    }
    if (exact >= 0) out.unshift(exact);
    return out.concat(scanTitles(new Set(out)));
  }
  return scanTitles(null);
}
