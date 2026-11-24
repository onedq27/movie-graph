// Loads the Data Contract files from data/. All URLs are relative.
// Promises are memoised; a failed load is forgotten so a retry really refetches.

let metaPromise = null;
let meta = null;
const setCache = new Map();    // set -> Promise<{index, nb}>
const chunkCache = new Map();  // `${set}.${k}` -> Promise<{desc, img, url}>

/** [chunk number, offset inside the chunk] for position p. */
export function chunkOf(p, chunkSize) {
  return [Math.floor(p / chunkSize), p % chunkSize];
}

/** Position of an id in the ascending index.id array, or -1. */
export function posOfId(index, id) {
  const ids = index.id;
  let lo = 0;
  let hi = ids.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ids[mid] === id) return mid;
    if (ids[mid] < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

export function dataUrl(name, version) {
  return version ? `data/${name}?v=${encodeURIComponent(version)}` : `data/${name}`;
}

async function getJson(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

function memo(cache, key, make) {
  let pr = cache.get(key);
  if (!pr) {
    pr = make();
    cache.set(key, pr);
    pr.catch(() => { if (cache.get(key) === pr) cache.delete(key); });
  }
  return pr;
}

export function loadMeta() {
  if (!metaPromise) {
    const pr = getJson(dataUrl('meta.json'), { cache: 'no-cache' }).then((m) => {
      if (!m || !m.sets || !Array.isArray(m.genres)) throw new Error('meta.json: unexpected shape');
      meta = m;
      return m;
    });
    metaPromise = pr;
    pr.catch(() => { if (metaPromise === pr) metaPromise = null; });
  }
  return metaPromise;
}

export function loadSet(set) {
  return memo(setCache, set, async () => {
    const m = meta || await loadMeta();
    if (!m.sets[set]) throw new Error(`unknown set: ${set}`);
    const [index, nb] = await Promise.all([
      getJson(dataUrl(`${set}.index.json`, m.version)),
      getJson(dataUrl(`${set}.nb.json`, m.version)),
    ]);
    return { index, nb };
  });
}

export async function loadDetail(set, p) {
  const m = meta || await loadMeta();
  const size = (m.sets[set] && m.sets[set].chunkSize) || 500;
  const [k, off] = chunkOf(p, size);
  const chunk = await memo(chunkCache, `${set}.${k}`, () => getJson(dataUrl(`${set}.d.${k}.json`, m.version)));
  return {
    desc: chunk.desc[off] || '',
    img: chunk.img[off] || '',
    url: chunk.url[off] || '',
  };
}
