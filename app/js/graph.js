// d3 force graph: one centre item and its nearest neighbours.
// d3 is loaded as a classic script (vendor/d3.min.js) before the modules.

export const PALETTE_SIZE = 10;

/** CSS colour for a genre index (the most frequent genres get their own hue). */
export function genreColor(gi) {
  return Number.isInteger(gi) && gi >= 0 && gi < PALETTE_SIZE ? `var(--g${gi})` : 'var(--g-other)';
}

/** Split a title into at most `maxLines` lines of about `maxChars`, ending with … when cut. */
export function wrapLabel(text, maxChars = 14, maxLines = 2) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let i = 0;
  while (i < words.length && lines.length < maxLines) {
    let cur = words[i++];
    while (i < words.length && `${cur} ${words[i]}`.length <= maxChars) cur += ` ${words[i++]}`;
    lines.push(cur.length > maxChars + 2 ? `${cur.slice(0, maxChars).trimEnd()}…` : cur);
  }
  if (i < words.length) {
    let last = lines[lines.length - 1];
    if (!last.endsWith('…')) {
      if (last.length > maxChars - 1) last = last.slice(0, maxChars - 1);
      lines[lines.length - 1] = `${last.replace(/[\s.,:;!?-]+$/, '')}…`;
    }
  }
  return lines;
}

/**
 * Pure graph model. Draws what exists: fewer neighbours than `count` is fine.
 * @returns {{nodes: {p, center, score, rank}[], links: {source, target, score, kind}[]}}
 *   kind 'c' = centre→neighbour, 'n' = neighbour↔neighbour (either lists the other).
 */
export function buildGraph({ index, nb, center, count }) {
  const total = index.id.length;
  const listed = (nb.n && nb.n[center]) || [];
  const scores = (nb.s && nb.s[center]) || [];
  const want = Math.max(0, Math.floor(Number(count) || 0));
  const nodes = [{ p: center, center: true, score: null, rank: -1 }];
  const links = [];
  const seen = new Set([center]);
  for (let i = 0; i < listed.length && nodes.length - 1 < want; i++) {
    const p = listed[i];
    if (!Number.isInteger(p) || p < 0 || p >= total || seen.has(p)) continue;
    seen.add(p);
    const score = Number(scores[i]) || 0;
    nodes.push({ p, center: false, score, rank: nodes.length - 1 });
    links.push({ source: center, target: p, score, kind: 'c' });
  }
  for (let i = 1; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i].p;
      const b = nodes[j].p;
      const ia = (nb.n[a] || []).indexOf(b);
      const ib = (nb.n[b] || []).indexOf(a);
      if (ia < 0 && ib < 0) continue;
      const score = Math.max(ia >= 0 ? Number(nb.s[a][ia]) || 0 : 0, ib >= 0 ? Number(nb.s[b][ib]) || 0 : 0);
      links.push({ source: a, target: b, score, kind: 'n' });
    }
  }
  return { nodes, links };
}

// ---------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';
const LINE_H = 13.5;
const instances = new WeakMap();
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Keeps label boxes (dot + text under it) from overlapping; circles alone are not enough for text.
function rectCollide(pad) {
  let nodes = [];
  function force(alpha) {
    const k = 0.6 * Math.max(alpha, 0.15);
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const dx = b.x - a.x;
        const dy = (b.y + b.boxDy) - (a.y + a.boxDy);
        const ox = (a.boxW + b.boxW) / 2 + pad - Math.abs(dx);
        if (ox <= 0) continue;
        const oy = (a.boxH + b.boxH) / 2 + pad - Math.abs(dy);
        if (oy <= 0) continue;
        if (ox < oy) {
          const s = ox * k * (dx < 0 ? -1 : 1);
          a.vx -= s; b.vx += s;
        } else {
          const s = oy * k * (dy < 0 ? -1 : 1);
          a.vy -= s; b.vy += s;
        }
      }
    }
  }
  force.initialize = (n) => { nodes = n; };
  return force;
}

/**
 * @param {HTMLElement} container
 * @param {{index, nb, center:number, count:number, dimmed?:Set<number>, selected?:number,
 *          insets?:{top?:number,right?:number,bottom?:number,left?:number}, focus?:boolean,
 *          onSelect?:(p:number)=>void, onRecentre?:(p:number)=>void}} opts
 * @returns controller {select, setDimmed, setInsets, fit, destroy, shown: number[]}
 */
export function renderGraph(container, opts) {
  const d3 = globalThis.d3;
  const { index, nb, center, onSelect, onRecentre } = opts;
  const prev = instances.get(container);
  const keep = prev && prev.index === index && prev.center === center ? prev : null;
  if (prev) prev.destroy();

  const model = buildGraph(opts);
  const nodes = model.nodes;
  const links = model.links;
  const byP = new Map(nodes.map((n) => [n.p, n]));
  const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  let width = Math.max(container.clientWidth, 200);
  let height = Math.max(container.clientHeight, 200);
  let insets = { top: 0, right: 0, bottom: 0, left: 0, ...(opts.insets || {}) };
  let selected = opts.selected != null && byP.has(opts.selected) ? opts.selected : center;
  let dimmed = opts.dimmed || new Set();
  let focus = !!opts.focus;   // tight space (phone sheet open): frame centre + selected instead of everything
  let userMoved = keep ? keep.userMoved() : false;
  let destroyed = false;

  const svg = d3.select(container).append('svg')
    .attr('class', 'graph-svg')
    .attr('width', width).attr('height', height)
    .attr('role', 'group')
    .attr('aria-label', 'მსგავსების გრაფი');
  const viewport = svg.append('g');
  const linkLayer = viewport.append('g').attr('class', 'links');
  const nodeLayer = viewport.append('g').attr('class', 'nodes');

  // ---- scales -------------------------------------------------------------
  const cScores = links.filter((l) => l.kind === 'c').map((l) => l.score);
  const sMax = cScores.length ? Math.max(...cScores) : 100;
  const sMin = cScores.length ? Math.min(...cScores) : 0;
  const rel = (s) => (sMax === sMin ? 0.6 : clamp((s - sMin) / (sMax - sMin), 0, 1));
  const visW = () => Math.max(120, width - insets.left - insets.right);
  const visH = () => Math.max(120, height - insets.top - insets.bottom);
  const n = nodes.length - 1;
  const R = clamp(Math.min(visW(), visH()) * 0.4, 105, 250) + Math.max(0, n - 12) * 4;

  nodes.forEach((d) => {
    d.gi = (index.g[d.p] || [])[0];
    d.title = index.ka[d.p] || index.en[d.p] || `#${index.id[d.p]}`;
    d.lines = wrapLabel(d.title, d.center ? 18 : 14, 2);
    d.r = d.center ? 15 : 7.5 + 4 * rel(d.score);
  });

  // ---- elements -----------------------------------------------------------
  const link = linkLayer.selectAll('line').data(links).join('line')
    .attr('class', (l) => `link link-${l.kind}`)
    .attr('stroke-width', (l) => (l.kind === 'c' ? 1.2 + 3.6 * rel(l.score) : 0.7 + 0.9 * rel(l.score)))
    .attr('stroke-opacity', (l) => (l.kind === 'c' ? 0.42 + 0.4 * rel(l.score) : 0.1 + 0.16 * rel(l.score)));

  const node = nodeLayer.selectAll('g').data(nodes, (d) => d.p).join('g')
    .attr('class', (d) => `node${d.center ? ' is-center' : ''}`)
    .attr('tabindex', 0)
    .attr('role', 'button');
  node.append('circle').attr('class', 'hit').attr('r', (d) => Math.max(22, d.r + 8));
  node.append('circle').attr('class', 'ring').attr('r', (d) => d.r + 5);
  node.append('circle').attr('class', 'dot').attr('r', (d) => d.r).style('fill', (d) => genreColor(d.gi));
  node.each(function (d) {
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('class', 'label');
    text.setAttribute('text-anchor', 'middle');
    d.lines.forEach((line, i) => {
      const tspan = document.createElementNS(SVG_NS, 'tspan');
      tspan.setAttribute('x', '0');
      tspan.setAttribute('y', String(d.r + 15 + i * LINE_H));
      tspan.textContent = line;
      text.appendChild(tspan);
    });
    this.appendChild(text);
    const tip = document.createElementNS(SVG_NS, 'title');
    tip.textContent = d.center ? d.title : `${d.title} — მსგავსება ${d.score}%`;
    this.appendChild(tip);
    this.setAttribute('aria-label', tip.textContent);

    // label box for collision, measured when possible
    let w = Math.max(...d.lines.map((s) => s.length)) * (d.center ? 8 : 7);
    try {
      const bw = text.getBBox().width;
      if (bw > 0) w = bw;
    } catch { /* not rendered yet: keep the estimate */ }
    const textH = d.lines.length * LINE_H + 5;
    d.boxW = Math.max(w, 2 * d.r) + 6;
    d.boxH = 2 * d.r + textH;
    d.boxDy = textH / 2;
  });

  // ---- layout -------------------------------------------------------------
  const c = byP.get(center);
  c.x = 0; c.y = 0; c.fx = 0; c.fy = 0;
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));
  nodes.forEach((d) => {
    if (d.center) return;
    const old = keep && keep.positions.get(d.p);
    if (old) {
      d.x = old.x; d.y = old.y;
      if (old.pinned) { d.fx = old.x; d.fy = old.y; }
    } else {
      const a = d.rank * GOLDEN;
      const rr = R * (1.1 - 0.45 * rel(d.score));
      d.x = Math.cos(a) * rr;
      d.y = Math.sin(a) * rr;
    }
  });

  const portrait = visH() > visW() * 1.15;
  const landscape = visW() > visH() * 1.15;
  const sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id((d) => d.p)
      .distance((l) => (l.kind === 'c' ? R * (1.12 - 0.5 * rel(l.score)) : R * 0.62))
      .strength((l) => (l.kind === 'c' ? 0.55 : 0.02 + 0.06 * rel(l.score))))
    .force('charge', d3.forceManyBody().strength(-260).distanceMax(R * 2.6))
    .force('x', d3.forceX(0).strength(portrait ? 0.11 : 0.035))
    .force('y', d3.forceY(0).strength(landscape ? 0.11 : 0.035))
    .force('boxes', rectCollide(7))
    .on('tick', draw)
    .stop();
  for (let i = 0; i < (keep ? 140 : 320); i++) sim.tick();

  function draw() {
    link
      .attr('x1', (l) => l.source.x).attr('y1', (l) => l.source.y)
      .attr('x2', (l) => l.target.x).attr('y2', (l) => l.target.y);
    node.attr('transform', (d) => `translate(${d.x},${d.y})`);
  }
  draw();

  // ---- zoom / pan ---------------------------------------------------------
  const zoom = d3.zoom()
    .scaleExtent([0.3, 3])
    .on('zoom', (event) => {
      viewport.attr('transform', event.transform);
      if (event.sourceEvent) userMoved = true;
    });
  svg.call(zoom).on('dblclick.zoom', null);

  function bounds(list) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const d of list) {
      x0 = Math.min(x0, d.x - d.boxW / 2);
      x1 = Math.max(x1, d.x + d.boxW / 2);
      y0 = Math.min(y0, d.y - d.r - 6);
      y1 = Math.max(y1, d.y - d.r + d.boxH + 4);
    }
    return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
  }
  const PAD = 14;
  const K_MAX = 1.25;
  // Everything in view. In focus mode: only centre + selected, at the scale the whole graph
  // has when nothing covers the stage, so labels stay readable above an open sheet.
  function fitTransform() {
    const all = bounds(nodes);
    let b = all;
    let k;
    if (focus) {
      const kAll = clamp(Math.min((width - 2 * PAD) / all.w, (height - 2 * PAD) / all.h), 0.3, K_MAX);
      b = bounds([byP.get(center), byP.get(selected) || byP.get(center)]);
      k = clamp(Math.min((visW() - 2 * PAD) / b.w, (visH() - 2 * PAD) / b.h), 0.3, kAll);
    } else {
      k = clamp(Math.min((visW() - 2 * PAD) / all.w, (visH() - 2 * PAD) / all.h), 0.3, K_MAX);
    }
    const cx = insets.left + visW() / 2;
    const cy = insets.top + visH() / 2;
    return d3.zoomIdentity.translate(cx - k * (b.x0 + b.x1) / 2, cy - k * (b.y0 + b.y1) / 2).scale(k);
  }
  function apply(t, animate) {
    if (destroyed) return;
    if (animate && !reduceMotion) svg.transition().duration(320).call(zoom.transform, t);
    else svg.call(zoom.transform, t);
  }
  function fit(animate = true) {
    userMoved = false;
    apply(fitTransform(), animate);
  }
  // Pan just enough to bring a node into the visible (not covered) part of the stage.
  function reveal(p) {
    const d = byP.get(p);
    if (!d) return;
    const t = d3.zoomTransform(svg.node());
    const sx = t.applyX(d.x);
    const sy = t.applyY(d.y);
    const m = 44;
    const dx = sx < insets.left + m ? insets.left + m - sx : sx > width - insets.right - m ? width - insets.right - m - sx : 0;
    const dy = sy < insets.top + m ? insets.top + m - sy : sy > height - insets.bottom - m ? height - insets.bottom - m - sy : 0;
    if (dx || dy) apply(d3.zoomIdentity.translate(t.x + dx, t.y + dy).scale(t.k), true);
  }
  if (keep && userMoved) apply(keep.transform(), false);
  else apply(fitTransform(), false);

  // ---- interaction --------------------------------------------------------
  node.call(d3.drag()
    .on('start', (event, d) => {
      if (!event.active) sim.alphaTarget(0.22).restart();
      d.fx = d.x; d.fy = d.y;
    })
    .on('drag', (event, d) => {
      d.fx = event.x; d.fy = event.y;
      d.pinned = true;
      userMoved = true;
    })
    .on('end', (event, d) => {
      if (!event.active) sim.alphaTarget(0);
      if (!d.pinned && !d.center) { d.fx = null; d.fy = null; }
    }));
  node
    .on('click', (event, d) => { if (!event.defaultPrevented && onSelect) onSelect(d.p); })
    .on('dblclick', (event, d) => {
      event.preventDefault();
      if (!d.center && onRecentre) onRecentre(d.p);
    })
    .on('keydown', (event, d) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        if (onSelect) onSelect(d.p);
      }
    });

  function paintState() {
    node
      .classed('is-selected', (d) => d.p === selected)
      .classed('is-dim', (d) => !d.center && dimmed.has(d.p));
    link
      .classed('is-hl', (l) => selected !== center && (l.source.p === selected || l.target.p === selected))
      .classed('is-dim', (l) => dimmed.has(l.source.p) || dimmed.has(l.target.p));
  }
  paintState();

  let ro = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (!w || !h || (w === width && h === height)) return;
      width = w; height = h;
      svg.attr('width', w).attr('height', h);
      if (!userMoved) apply(fitTransform(), false);
    });
    ro.observe(container);
  }

  const api = {
    index,
    center,
    shown: nodes.filter((d) => !d.center).map((d) => d.p),
    positions: { get: (p) => { const d = byP.get(p); return d && { x: d.x, y: d.y, pinned: !!d.pinned }; } },
    userMoved: () => userMoved,
    transform: () => d3.zoomTransform(svg.node()),
    select(p) {
      selected = byP.has(p) ? p : center;
      paintState();
      if (userMoved) reveal(selected);
      else if (focus) apply(fitTransform(), true);
    },
    setDimmed(set) {
      dimmed = set || new Set();
      paintState();
    },
    setInsets(next, wantFocus = false) {
      insets = { top: 0, right: 0, bottom: 0, left: 0, ...(next || {}) };
      focus = !!wantFocus;
      if (!userMoved) apply(fitTransform(), true);
      else reveal(selected);
    },
    fit,
    destroy() {
      destroyed = true;
      sim.stop();
      if (ro) ro.disconnect();
      svg.interrupt();
      svg.remove();
      if (instances.get(container) === api) instances.delete(container);
    },
  };
  instances.set(container, api);
  return api;
}
