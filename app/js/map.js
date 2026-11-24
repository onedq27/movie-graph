// Canvas map: every title of a set as one dot, placed by data/{set}.xy.json (0..1000 on both axes).
// d3 is loaded as a classic script (vendor/d3.min.js) before the modules.
// The helpers at the top are pure (no DOM) and covered by tests/map.test.mjs.

import { genreColor, PALETTE_SIZE } from './graph.js';
import { filterItems } from './search.js';

export const MAX_TITLE_LABELS = 40;

/** Colour bucket of a first genre: its own palette slot, or the shared "other" slot. */
export function bucketOf(gi) {
  return Number.isInteger(gi) && gi >= 0 && gi < PALETTE_SIZE ? gi : PALETTE_SIZE;
}

/**
 * One entry per disc of the map: the titles sharing a FIRST genre (the genre that colours the
 * dot), plus one for titles without any genre (gi = -1, last). Empty genres are skipped.
 * x/y = mean of the dots (where the genre's name goes), r = distance of the farthest dot.
 * @returns {{gi:number, x:number, y:number, r:number, n:number}[]} in genre order
 */
export function genreCentres(index, xy, genreCount) {
  const acc = Array.from({ length: genreCount + 1 }, () => ({ sx: 0, sy: 0, n: 0, r: 0 }));
  const n = Math.min(index.id.length, xy.x.length, xy.y.length);
  const slot = (p) => {
    const gi = (index.g[p] || [])[0];
    return Number.isInteger(gi) && gi >= 0 && gi < genreCount ? gi : genreCount;
  };
  for (let p = 0; p < n; p++) {
    const a = acc[slot(p)];
    a.sx += xy.x[p];
    a.sy += xy.y[p];
    a.n++;
  }
  for (let p = 0; p < n; p++) {
    const a = acc[slot(p)];
    const d = Math.hypot(xy.x[p] - a.sx / a.n, xy.y[p] - a.sy / a.n);
    if (d > a.r) a.r = d;
  }
  const out = [];
  acc.forEach((a, i) => {
    if (a.n) out.push({ gi: i < genreCount ? i : -1, x: a.sx / a.n, y: a.sy / a.n, r: a.r, n: a.n });
  });
  return out;
}

/**
 * Typical distance between a dot and its nearest neighbour (median over a sample), in map units.
 * Dot size, hit radius and the zoom at which titles appear are all derived from it.
 */
export function typicalSpacing(xs, ys, samples = 80) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 10;
  const step = Math.max(1, Math.floor(n / samples));
  const found = [];
  for (let i = 0; i < n; i += step) {
    let best = Infinity;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const dx = xs[j] - xs[i];
      const dy = ys[j] - ys[i];
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
    found.push(Math.sqrt(best));
  }
  found.sort((a, b) => a - b);
  return Math.max(found[found.length >> 1], 0.5);
}

/**
 * Which dots stay vivid for the current search box + genre filter (same rules as the list).
 * @returns {{mask: Uint8Array|null, count: number, best: number}}
 *   mask is null when nothing is filtered (everything vivid); best = top-ranked match or -1.
 */
export function matchMask(index, { query = '', genres = [] } = {}) {
  const n = index.id.length;
  if (String(query ?? '').trim() === '' && genres.length === 0) return { mask: null, count: n, best: -1 };
  const hits = filterItems(index, { query, genres });
  const mask = new Uint8Array(n);
  for (let i = 0; i < hits.length; i++) mask[hits[i]] = 1;
  return { mask, count: hits.length, best: hits.length ? hits[0] : -1 };
}

/**
 * Greedy label choice: walk the candidates in priority order and keep each one whose box
 * (grown by `pad`) overlaps none of the kept ones, until `max` are kept.
 * @param rects flat [x0, y0, x1, y1, ...] for `count` candidates
 * @param out   receives the kept candidate numbers
 * @returns {number} how many were kept
 */
export function pickLabels(rects, count, max, out, pad = 0) {
  let kept = 0;
  for (let i = 0; i < count && kept < max; i++) {
    const a = i * 4;
    const x0 = rects[a] - pad;
    const y0 = rects[a + 1] - pad;
    const x1 = rects[a + 2] + pad;
    const y1 = rects[a + 3] + pad;
    let free = true;
    for (let j = 0; j < kept; j++) {
      const b = out[j] * 4;
      if (x0 < rects[b + 2] && x1 > rects[b] && y0 < rects[b + 3] && y1 > rects[b + 1]) { free = false; break; }
    }
    if (free) out[kept++] = i;
  }
  return kept;
}

/** Shorten a title for a map label. */
export function clipTitle(text, max = 24) {
  const s = String(text || '').trim();
  return s.length > max + 1 ? `${s.slice(0, max).trimEnd()}…` : s;
}

// ---------------------------------------------------------------------------

const TAU = Math.PI * 2;
const PAD = 26;              // px kept free around the data at "fit all"
const TITLE_GAP = 16;        // title labels appear once neighbouring dots are this many px apart
const MAX_GAP = 90;          // deepest zoom: neighbouring dots this many px apart
const FEW = 15;              // this few matches: label them at any zoom
const CANDIDATES = 260;      // newest dots in view considered for a title label per frame
const DIM_ALPHA = 0.14;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * @param {HTMLElement} container
 * @param {{index, xy:{x:number[],y:number[]}, genres:string[], mask?:Uint8Array|null, matchCount?:number,
 *          selected?:number, view?:{x:number,y:number,k:number}|null,
 *          cover?:()=>({left:number,top:number,right:number,bottom:number}|null),
 *          onSelect?:(p:number)=>void}} opts
 * @returns controller {select, setMatch, centreOn, fit, view, destroy}
 */
export function renderMap(container, opts) {
  const d3 = globalThis.d3;
  const { index, xy, genres, onSelect, cover } = opts;
  const n = index.id.length;
  const xs = Float32Array.from(xy.x);
  const ys = Float32Array.from(xy.y);
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const coarse = matchMedia('(pointer: coarse)');
  const darkMq = matchMedia('(prefers-color-scheme: dark)');

  // ---- static model -------------------------------------------------------
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  const sizes = new Int32Array(PALETTE_SIZE + 1);
  for (let p = 0; p < n; p++) {
    if (xs[p] < bx0) bx0 = xs[p];
    if (xs[p] > bx1) bx1 = xs[p];
    if (ys[p] < by0) by0 = ys[p];
    if (ys[p] > by1) by1 = ys[p];
    sizes[bucketOf((index.g[p] || [])[0])]++;
  }
  if (!n) { bx0 = 0; by0 = 0; bx1 = 1000; by1 = 1000; }
  const spanX = Math.max(bx1 - bx0, 1);
  const spanY = Math.max(by1 - by0, 1);

  // positions per colour, so a frame is one path per colour
  const buckets = Array.from(sizes, (size) => new Int32Array(size));
  const fill = new Int32Array(PALETTE_SIZE + 1);
  const all = new Array(n);
  for (let p = 0; p < n; p++) {
    const b = bucketOf((index.g[p] || [])[0]);
    buckets[b][fill[b]++] = p;
    all[p] = p;
  }
  // "other" first, then the rarest palette colours last so they are not buried
  const order = [PALETTE_SIZE, ...Array.from({ length: PALETTE_SIZE }, (_, i) => i).sort((a, b) => sizes[b] - sizes[a])];

  const qx = (p) => xs[p];
  const qy = (p) => ys[p];
  const tree = d3.quadtree().x(qx).y(qy).addAll(all);
  let matchTree = null;

  const spacing = typicalSpacing(xs, ys);
  const centres = genreCentres(index, xy, genres.length)
    .sort((a, b) => b.n - a.n)
    .map((c) => ({ ...c, name: c.gi < 0 ? 'ჟანრის გარეშე' : genres[c.gi], w: 0, ws: 0 }));

  const titles = new Array(n);          // clipped label text, filled lazily
  const titleW = new Float32Array(n);   // measured label widths, 0 = not measured yet
  const SLOTS = CANDIDATES + 1 + centres.length;   // genre names first: titles must not cover them
  const candP = new Int32Array(SLOTS);
  const candRect = new Float64Array(SLOTS * 4);
  const picked = new Int32Array(MAX_TITLE_LABELS + centres.length);
  const genreRect = new Float64Array(Math.max(centres.length, 1) * 4);
  const genreAt = new Int32Array(Math.max(centres.length, 1));
  const genrePicked = new Int32Array(Math.max(centres.length, 1));
  const genreIn = new Uint8Array(Math.max(centres.length, 1));

  // ---- state --------------------------------------------------------------
  let width = Math.max(container.clientWidth, 120);
  let height = Math.max(container.clientHeight, 120);
  let dpr = 1;
  let k0 = 1;                           // scale of "fit all"
  let kMax = 1;
  let t = d3.zoomIdentity;
  let mask = opts.mask || null;
  let matchCount = opts.matchCount ?? n;
  let selected = Number.isInteger(opts.selected) && opts.selected >= 0 && opts.selected < n ? opts.selected : -1;
  let hovered = -1;
  let userMoved = false;
  let destroyed = false;
  let raf = 0;
  let theme = null;

  const canvas = document.createElement('canvas');
  canvas.className = 'map-canvas';
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `რუკა: ${n} სათაური ჟანრების მიხედვით. ისრებით გადაადგილება, + და − მასშტაბი, 0 — ყველას ჩატევა.`);
  const tip = document.createElement('div');
  tip.className = 'map-tip';
  tip.hidden = true;
  container.append(canvas, tip);
  const ctx = canvas.getContext('2d');
  const sel = d3.select(canvas);

  function readTheme() {
    const root = getComputedStyle(document.documentElement);
    const v = (name) => root.getPropertyValue(name).trim();
    const resolve = (value) => {
      const m = /^var\((--[\w-]+)\)$/.exec(value);
      return m ? v(m[1]) : value;
    };
    const family = root.fontFamily || 'sans-serif';
    theme = {
      colors: Array.from({ length: PALETTE_SIZE + 1 }, (_, b) => resolve(genreColor(b < PALETTE_SIZE ? b : -1))),
      text: v('--text'),
      bg: v('--stage-bg'),
      accent: v('--accent'),
      genreFont: `700 13px ${family}`,
      genreSmall: `600 12px ${family}`,
      titleFont: `500 11.5px ${family}`,
      titleBold: `700 12px ${family}`,
    };
    titleW.fill(0);
    ctx.font = theme.genreFont;
    for (const c of centres) c.w = ctx.measureText(c.name).width;
    ctx.font = theme.genreSmall;
    for (const c of centres) c.ws = ctx.measureText(c.name).width;
  }

  // ---- geometry -----------------------------------------------------------
  function fitTransform() {
    const k = Math.min((width - 2 * PAD) / spanX, (height - 2 * PAD) / spanY);
    return d3.zoomIdentity
      .translate(width / 2 - k * (bx0 + bx1) / 2, height / 2 - k * (by0 + by1) / 2)
      .scale(k);
  }

  const zoom = d3.zoom()
    .on('zoom', (event) => {
      t = event.transform;
      if (event.sourceEvent) {
        userMoved = true;
        hideTip();
      }
      invalidate();
    });

  function layout() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);   // 3x phones: 2x is sharp enough and much cheaper
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    k0 = Math.max(Math.min((width - 2 * PAD) / spanX, (height - 2 * PAD) / spanY), 0.01);
    kMax = Math.max(k0 * 8, MAX_GAP / spacing);
    zoom
      .extent([[0, 0], [width, height]])
      .scaleExtent([k0 * 0.8, kMax])
      .translateExtent([[bx0 - spanX * 0.6, by0 - spanY * 0.6], [bx1 + spanX * 0.6, by1 + spanY * 0.6]]);
  }

  function apply(next, animate) {
    if (destroyed) return;
    if (animate && !reduceMotion) sel.transition().duration(340).call(zoom.transform, next);
    else sel.call(zoom.transform, next);
  }

  // ---- drawing ------------------------------------------------------------
  function invalidate() {
    if (!raf && !destroyed) raf = requestAnimationFrame(draw);
  }

  // One path per colour. want: -1 = every dot, 0 = only non-matching, 1 = only matching.
  function pass(want, r) {
    const k = t.k;
    const tx = t.x;
    const ty = t.y;
    // Dots this small are a few device pixels: a square of the same area looks the same
    // and fills several times faster, which is what keeps the fitted view smooth on phones.
    const square = r < 1.25;
    const side = r * 1.772;
    const h = side / 2;
    const lo = -r;
    const hiX = width + r;
    const hiY = height + r;
    for (let o = 0; o < order.length; o++) {
      const list = buckets[order[o]];
      if (!list.length) continue;
      ctx.fillStyle = theme.colors[order[o]];
      ctx.beginPath();
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        if (want >= 0 && mask[p] !== want) continue;
        const x = xs[p] * k + tx;
        if (x < lo || x > hiX) continue;
        const y = ys[p] * k + ty;
        if (y < lo || y > hiY) continue;
        if (square) {
          ctx.rect(x - h, y - h, side, side);
        } else {
          ctx.moveTo(x + r, y);
          ctx.arc(x, y, r, 0, TAU);
        }
      }
      ctx.fill();
    }
  }

  function haloText(text, x, y) {
    ctx.strokeText(text, x, y);
    ctx.fillText(text, x, y);
  }

  function titleOf(p) {
    let s = titles[p];
    if (s === undefined) {
      s = clipTitle(index.ka[p] || index.en[p] || `#${index.id[p]}`);
      titles[p] = s;
    }
    if (!titleW[p]) titleW[p] = ctx.measureText(s).width || 1;
    return s;
  }

  function addCandidate(c, p, x, y, r) {
    titleOf(p);
    const a = c * 4;
    candP[c] = p;
    // right of the dot; left of it when the right side would run off the screen
    const x0 = x + r + 4 + titleW[p] > width - 3 && x - r - 4 - titleW[p] > 3 ? x - r - 4 - titleW[p] : x + r + 4;
    candRect[a] = x0;
    candRect[a + 1] = y - 8;
    candRect[a + 2] = x0 + titleW[p];
    candRect[a + 3] = y + 8;
  }

  function draw() {
    raf = 0;
    if (destroyed) return;
    const k = t.k;
    const tx = t.x;
    const ty = t.y;
    const gap = spacing * k;              // px between neighbouring dots
    const r = clamp(gap * 0.36, 0.85, 6.5);  // textured discs when fitted, separate dots when zoomed in
    const few = !!mask && matchCount <= FEW;
    // few matches: big enough to spot among thousands; many: keep the texture
    const hot = !mask ? r : matchCount <= 300 ? Math.max(r * 1.2, 3.2) : r * 1.1;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.lineJoin = 'round';

    // dots
    if (mask) {
      ctx.globalAlpha = DIM_ALPHA;
      pass(0, r);
      ctx.globalAlpha = 1;
      pass(1, hot);
      if (few) {
        ctx.strokeStyle = theme.text;
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        for (let p = 0; p < n; p++) {
          if (!mask[p]) continue;
          const x = xs[p] * k + tx;
          const y = ys[p] * k + ty;
          ctx.moveTo(x + hot + 3.5, y);
          ctx.arc(x, y, hot + 3.5, 0, TAU);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    } else {
      pass(-1, r);
    }

    ctx.textBaseline = 'middle';
    ctx.strokeStyle = theme.bg;

    // genre names: in the middle of a disc that has room for it, above a small one.
    // A disc that has grown past the screen drops its name (you are inside it by then).
    let shownGenres = 0;
    if (centres.length) {
      const minDim = Math.min(width, height);
      ctx.textAlign = 'left';
      for (let i = 0; i < centres.length; i++) {       // biggest disc first
        const g = centres[i];
        const rad = g.r * k;
        if (rad > minDim * 0.62) continue;
        const cx = g.x * k + tx;
        const cy = g.y * k + ty;
        if (cx < -rad || cx > width + rad || cy < -rad || cy > height + rad) continue;
        // A disc with room for it carries its name (with a colour key) in the middle. A smaller one
        // gets a plain name across its middle; a tiny one, which the name would hide, gets it
        // right next to it. If the spot is taken by a bigger genre's name, the next spot is tried.
        const inside = rad * 2 >= g.w + 15;
        const tiny = rad < 16 || g.n <= 12;
        const half = inside ? (g.w + 15) / 2 : g.ws / 2;
        const side = rad + r + 5 + half;
        const up = rad + r + 10;
        for (let attempt = tiny ? 1 : 0; attempt < (inside ? 1 : 5); attempt++) {
          let x = cx;
          let y = cy;
          if (attempt === 1) {
            if (tiny) x += side; else y -= up;
          } else if (attempt === 2) {
            if (tiny) x -= side; else y += up;
          } else if (attempt === 3) {
            if (tiny) y -= up; else x += side;
          } else if (attempt === 4) {
            if (tiny) y += up; else x -= side;
          }
          if (x - half < 2 || x + half > width - 2) {
            if (!inside) continue;
            x = clamp(x, half + 2, Math.max(half + 2, width - half - 2));
          }
          if (y < 9 || y > height - 9) continue;
          const a = shownGenres * 4;
          genreRect[a] = x - half;
          genreRect[a + 1] = y - 9;
          genreRect[a + 2] = x + half;
          genreRect[a + 3] = y + 9;
          if (pickLabels(genreRect, shownGenres + 1, shownGenres + 1, genrePicked, 2) > shownGenres) {
            genreAt[shownGenres] = i;
            genreIn[shownGenres++] = inside ? 1 : 0;
            break;
          }
        }
      }
      for (let j = 0; j < shownGenres; j++) {
        const a = j * 4;
        const g = centres[genreAt[j]];
        const x0 = genreRect[a];
        const y = genreRect[a + 1] + 9;
        ctx.globalAlpha = clamp((minDim * 0.62 - g.r * k) / (minDim * 0.14), 0, 1);
        ctx.fillStyle = theme.text;
        if (!genreIn[j]) {
          ctx.font = theme.genreSmall;
          ctx.lineWidth = 4;
          haloText(g.name, x0, y);
          continue;
        }
        ctx.font = theme.genreFont;
        ctx.lineWidth = 5;
        haloText(g.name, x0 + 15, y);
        ctx.beginPath();
        ctx.arc(x0 + 5, y, 6.5, 0, TAU);
        ctx.fillStyle = theme.bg;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x0 + 5, y, 4.5, 0, TAU);
        ctx.fillStyle = theme.colors[bucketOf(g.gi)];
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // selected / hovered dot
    const mark = (p, color, big) => {
      const x = xs[p] * k + tx;
      const y = ys[p] * k + ty;
      const rr = Math.max(r, 3) + (big ? 1.5 : 0.5);
      ctx.beginPath();
      ctx.arc(x, y, rr + 1.5, 0, TAU);
      ctx.fillStyle = theme.bg;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, rr, 0, TAU);
      ctx.fillStyle = theme.colors[bucketOf((index.g[p] || [])[0])];
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, rr + 4.5, 0, TAU);
      ctx.strokeStyle = color;
      ctx.lineWidth = big ? 2.5 : 1.5;
      ctx.stroke();
      return rr;
    };
    if (hovered >= 0 && hovered !== selected) mark(hovered, theme.text, false);
    let selR = 0;
    if (selected >= 0) selR = mark(selected, theme.accent, true);

    // title labels: only when few dots are worth naming
    ctx.strokeStyle = theme.bg;
    ctx.lineWidth = 3.5;
    ctx.textAlign = 'left';
    ctx.fillStyle = theme.text;
    if (gap >= TITLE_GAP || few) {
      ctx.font = theme.titleFont;
      let c = 0;
      for (let j = 0; j < shownGenres * 4; j++) candRect[j] = genreRect[j];   // occupied: genre names
      for (; c < shownGenres; c++) candP[c] = -1;
      const first = c;
      if (selected >= 0) addCandidate(c++, selected, xs[selected] * k + tx, ys[selected] * k + ty, selR + 4.5);
      const lr = mask ? hot : r;
      for (let p = n - 1; p >= 0 && c - first <= CANDIDATES; p--) {      // newest first
        if (p === selected || (mask && !mask[p])) continue;
        const x = xs[p] * k + tx;
        if (x < -lr || x > width + lr) continue;
        const y = ys[p] * k + ty;
        if (y < 8 || y > height - 8) continue;
        addCandidate(c++, p, x, y, lr);
      }
      const m = pickLabels(candRect, c, MAX_TITLE_LABELS + first, picked, 2);
      for (let j = 0; j < m; j++) {
        const i = picked[j];
        const p = candP[i];
        if (p < 0 || p === selected) continue;   // genre name / drawn bold below
        haloText(titles[p], candRect[i * 4], candRect[i * 4 + 1] + 8);
      }
    }
    if (selected >= 0) {
      ctx.font = theme.titleBold;
      const x = xs[selected] * k + tx + selR + 8.5;
      haloText(titles[selected] === undefined ? titleOf(selected) : titles[selected], x, ys[selected] * k + ty);
    }
  }

  // ---- hit testing --------------------------------------------------------
  function pointOf(event) {
    const box = canvas.getBoundingClientRect();
    return [event.clientX - box.left, event.clientY - box.top];
  }
  function find(px, py, radius) {
    const wx = t.invertX(px);
    const wy = t.invertY(py);
    const rw = radius / t.k;
    // with a filter on, a matching dot under the finger wins over a dimmed one
    const hit = matchTree ? matchTree.find(wx, wy, rw) : undefined;
    const p = hit !== undefined ? hit : tree.find(wx, wy, rw);
    return p === undefined ? -1 : p;
  }

  function hideTip() {
    if (hovered < 0 && tip.hidden) return;
    hovered = -1;
    tip.hidden = true;
    canvas.style.cursor = '';
    invalidate();
  }

  function onMove(event) {
    if (event.pointerType !== 'mouse' || event.buttons) return;
    const [px, py] = pointOf(event);
    const p = find(px, py, clamp(spacing * t.k * 0.5, 6, 12));
    if (p < 0) { hideTip(); return; }
    if (p !== hovered) {
      hovered = p;
      const year = index.year[p] ? ` · ${index.year[p]}` : '';
      tip.textContent = `${index.ka[p] || index.en[p] || `#${index.id[p]}`}${year}`;
      tip.hidden = false;
      canvas.style.cursor = 'pointer';
      invalidate();
    }
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const left = clamp(px + 14, 6, Math.max(6, width - tw - 6));
    const top = py + 18 + th > height - 6 ? py - th - 12 : py + 18;
    tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  function onClick(event) {
    const [px, py] = pointOf(event);
    const touch = event.pointerType ? event.pointerType !== 'mouse' : coarse.matches;
    const half = spacing * t.k * 0.5;   // half-way to the next dot: the nearest one wins, empty space stays empty
    const p = find(px, py, touch ? clamp(half, 16, 28) : clamp(half, 8, 14));
    if (onSelect) onSelect(p);
  }

  function onKey(event) {
    const step = 70;
    const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[event.key]) {
      sel.call(zoom.translateBy, moves[event.key][0] / t.k, moves[event.key][1] / t.k);
    } else if (event.key === '+' || event.key === '=') {
      sel.call(zoom.scaleBy, 1.5);
    } else if (event.key === '-' || event.key === '_') {
      sel.call(zoom.scaleBy, 1 / 1.5);
    } else if (event.key === '0') {
      fit();
    } else {
      return;
    }
    userMoved = event.key !== '0';
    event.preventDefault();
  }

  // Pan just enough to keep a dot clear of the edges and of the card that covers part of the map.
  function reveal(p) {
    const x = t.applyX(xs[p]);
    const y = t.applyY(ys[p]);
    const m = 36;
    let dx = x < m ? m - x : x > width - m ? width - m - x : 0;
    let dy = y < m ? m - y : y > height - m ? height - m - y : 0;
    const c = cover ? cover() : null;
    if (c && x + dx > c.left - 16 && x + dx < c.right + 16 && y + dy > c.top - m && y + dy < c.bottom) {
      dy = c.top - m - y;
    }
    if (dx || dy) apply(d3.zoomIdentity.translate(t.x + dx, t.y + dy).scale(t.k), true);
  }

  function fit(animate = true) {
    userMoved = false;
    apply(fitTransform(), animate);
  }

  function setTree() {
    matchTree = null;
    if (!mask || matchCount <= 0 || matchCount >= n) return;
    const hits = [];
    for (let p = 0; p < n; p++) if (mask[p]) hits.push(p);
    matchTree = d3.quadtree().x(qx).y(qy).addAll(hits);
  }

  // ---- wiring -------------------------------------------------------------
  readTheme();
  layout();
  setTree();
  sel.call(zoom);
  const v = opts.view;
  if (v && Number.isFinite(v.k) && Number.isFinite(v.x) && Number.isFinite(v.y)) {
    userMoved = true;
    apply(d3.zoomIdentity.translate(v.x, v.y).scale(clamp(v.k, k0 * 0.8, kMax)), false);
  } else {
    apply(fitTransform(), false);
  }
  invalidate();

  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerleave', hideTip);
  canvas.addEventListener('click', onClick);
  canvas.addEventListener('keydown', onKey);
  const onTheme = () => { readTheme(); invalidate(); };
  darkMq.addEventListener('change', onTheme);

  let ro = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (!w || !h || (w === width && h === height)) return;
      // keep what is in the middle of the screen in the middle
      const cx = t.invertX(width / 2);
      const cy = t.invertY(height / 2);
      width = w; height = h;
      layout();
      const k = clamp(t.k, k0 * 0.8, kMax);
      if (!userMoved) apply(fitTransform(), false);
      else apply(d3.zoomIdentity.translate(w / 2 - cx * k, h / 2 - cy * k).scale(k), false);
      invalidate();
    });
    ro.observe(container);
  }

  return {
    index,
    select(p) {
      selected = Number.isInteger(p) && p >= 0 && p < n ? p : -1;
      invalidate();
      if (selected >= 0) reveal(selected);
    },
    setMatch(nextMask, count) {
      mask = nextMask || null;
      matchCount = mask ? count : n;
      setTree();
      invalidate();
    },
    /** Bring a dot to the middle, zooming in far enough to read its neighbours' names. */
    centreOn(p) {
      if (!(p >= 0 && p < n)) return;
      const k = clamp((TITLE_GAP + 5) / spacing, t.k, kMax);
      const c = cover ? cover() : null;
      const cy = c && c.left < width / 2 && c.right > width / 2 ? c.top / 2 : height / 2;
      userMoved = true;
      apply(d3.zoomIdentity.translate(width / 2 - xs[p] * k, cy - ys[p] * k).scale(k), true);
    },
    fit,
    /** Current pan/zoom, or null while the map still shows "fit all". */
    view: () => (userMoved ? { x: t.x, y: t.y, k: t.k } : null),
    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf);
      if (ro) ro.disconnect();
      darkMq.removeEventListener('change', onTheme);
      sel.interrupt();
      sel.on('.zoom', null);
      canvas.remove();
      tip.remove();
    },
  };
}
