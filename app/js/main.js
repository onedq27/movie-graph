// Wiring, state and routing. State that must survive reload/back lives in location.hash:
//   #/{set}        list: one section per genre, or the flat result grid while a search/genre filter is on
//   #/{set}/map    every title as a dot on the genre map
//   #/{set}/{id}   graph centred on that id

import { loadMeta, loadSet, loadXY, posOfId } from './data.js';
import { filterItems } from './search.js';
import { renderGraph, genreColor, PALETTE_SIZE } from './graph.js';
import { showPanel } from './panel.js';
import { genreSections } from './sections.js';
import { renderMap, matchMask } from './map.js';

const PAGE = 100;            // rows rendered per step
const SECTION_ROWS = 6;      // cards per genre section: two rows of 3, three rows of 2
const SECTION_ROWS_PHONE = 4;
const COUNT_MIN = 5;
const COUNT_MAX = 30;
const COUNT_DEFAULT = 12;
const SHEET_PEEK = 112;      // px of the bottom sheet visible when collapsed (keep in sync with app.css)
const NOUN = { movie: 'ფილმი', serial: 'სერიალი' };
const PLURAL = { movie: 'ფილმები', serial: 'სერიალები' };
const APP_TITLE = 'ფილმების გრაფი';

const $ = (id) => document.getElementById(id);
const phone = matchMedia('(max-width: 719px)');
const fmt = (n) => n.toLocaleString('ka-GE').replace(/,/g, ' ');

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

const state = {
  meta: null,
  set: null,
  data: null,          // {index, nb} of the current set
  query: '',
  genres: new Set(),   // indexes into meta.genres
  results: [],
  limit: PAGE,
  listScroll: 0,
  note: '',
  view: 'status',
  center: -1,
  selected: -1,
  count: readCount(),
  graph: null,
  browse: 'list',      // the browsing view last shown ('list' | 'map'): where the graph's back button leads
  map: null,           // map controller while the map view is open
  mapSet: null,
  mapSel: -1,          // position selected on the map
  mapMem: {},          // set -> {view, selected}: pan/zoom and selection survive a trip to the graph
};

function readCount() {
  try {
    const v = Number(localStorage.getItem('neighbours'));
    if (Number.isInteger(v) && v >= COUNT_MIN && v <= COUNT_MAX) return v;
  } catch { /* storage may be unavailable */ }
  return COUNT_DEFAULT;
}
function saveCount(v) {
  try { localStorage.setItem('neighbours', String(v)); } catch { /* ignore */ }
}

function readBrowse() {
  try { return localStorage.getItem('browse') === 'map' ? 'map' : 'list'; } catch { return 'list'; }
}
function setBrowse(view) {
  state.browse = view;
  try { localStorage.setItem('browse', view); } catch { /* ignore */ }
}

// ---- views ----------------------------------------------------------------

function setView(view) {
  state.view = view;
  $('view-status').hidden = view !== 'status';
  $('view-list').hidden = view !== 'list';
  $('view-graph').hidden = view !== 'graph';
  $('view-map').hidden = view !== 'map';
  document.body.dataset.view = view;
  if (view !== 'map') closeMap();
  if (view !== 'graph' && state.graph) {
    state.graph.destroy();
    state.graph = null;
  }
}

function showStatus(kind) {
  const box = $('view-status');
  if (kind === 'loading') {
    const spin = el('div', 'spinner');
    spin.setAttribute('aria-hidden', 'true');
    box.replaceChildren(spin, el('p', null, 'იტვირთება…'));
  } else {
    const retry = el('button', 'btn primary', 'თავიდან ცდა');
    retry.type = 'button';
    retry.addEventListener('click', route);
    box.replaceChildren(
      el('p', 'empty-title', 'მონაცემები ვერ ჩაიტვირთა'),
      el('p', 'muted', 'შეამოწმე ინტერნეტი და სცადე თავიდან.'),
      retry,
    );
  }
  setView('status');
}

function setCurrent(a, on) {
  a.classList.toggle('is-on', on);
  if (on) a.setAttribute('aria-current', 'page');
  else a.removeAttribute('aria-current');
}

// Top-bar set switch (keeps the current browsing view), list/map switch, brand and back links.
function markNav(r) {
  const tail = r.map ? '/map' : '';
  document.querySelectorAll('.seg a[data-set]').forEach((a) => {
    a.setAttribute('href', `#/${a.dataset.set}${tail}`);
    setCurrent(a, a.dataset.set === r.set);
  });
  document.querySelectorAll('.view-seg a').forEach((a) => {
    const map = a.dataset.view === 'map';
    a.setAttribute('href', `#/${r.set}${map ? '/map' : ''}`);
    setCurrent(a, map === !!r.map);
  });
  $('brand').setAttribute('href', `#/${r.set}`);
  const toMap = r.map || (r.id != null && state.browse === 'map');
  const back = $('back');
  back.setAttribute('href', `#/${r.set}${toMap ? '/map' : ''}`);
  back.setAttribute('aria-label', toMap ? 'რუკაზე დაბრუნება' : 'სიაში დაბრუნება');
  back.querySelector('span').textContent = toMap ? 'რუკა' : 'სია';
}

// ---- routing --------------------------------------------------------------

function parseHash() {
  const m = /^#\/(movie|serial)(?:\/(map|\d{1,9}))?\/?$/.exec(location.hash);
  if (!m) return null;
  return { set: m[1], map: m[2] === 'map', id: m[2] && m[2] !== 'map' ? Number(m[2]) : null };
}

let routeSeq = 0;
let opened = false;
async function route() {
  let r = parseHash();
  if (!r) {
    // Opened without a route (home-screen icon, bare URL): start in the view used last time.
    const map = !opened && readBrowse() === 'map';
    history.replaceState(null, '', map ? '#/movie/map' : '#/movie');
    r = { set: 'movie', map, id: null };
  }
  opened = true;
  const seq = ++routeSeq;
  markNav(r);
  closeGenres();

  if (state.set !== r.set || !state.data) {
    // only show the spinner if loading is not instant (cached set)
    const timer = setTimeout(() => { if (seq === routeSeq) showStatus('loading'); }, state.meta ? 150 : 0);
    try {
      if (!state.meta) {
        state.meta = await loadMeta();
        buildGenreChips();
      }
      const data = await loadSet(r.set);
      if (seq !== routeSeq) return;
      if (state.set !== r.set) {
        state.limit = PAGE;
        state.listScroll = 0;
      }
      state.set = r.set;
      state.data = data;
    } catch (err) {
      console.error(err);
      if (seq === routeSeq) showStatus('error');
      return;
    } finally {
      clearTimeout(timer);
    }
  }

  if (r.map) {
    showMap();
    return;
  }
  if (r.id == null) {
    showList();
    return;
  }
  const p = posOfId(state.data.index, r.id);
  if (p < 0) {
    state.note = `ID ${r.id} ამ ნაკრებში ვერ მოიძებნა.`;
    history.replaceState(null, '', `#/${r.set}`);
    markNav({ set: r.set, map: false, id: null });
    showList();
    return;
  }
  showGraph(p);
}

// ---- list -----------------------------------------------------------------

function showList() {
  setView('list');
  setBrowse('list');
  document.title = `${PLURAL[state.set]} — ${APP_TITLE}`;
  renderList();
  $('view-list').scrollTop = state.listScroll;
}

function buildRow(p) {
  const { index } = state.data;
  const { genres } = state.meta;
  const li = el('li');
  const a = el('a', 'row');
  a.href = `#/${state.set}/${index.id[p]}`;

  const dot = el('span', 'dot');
  dot.style.background = genreColor((index.g[p] || [])[0]);

  const main = el('span', 'row-main');
  const ka = index.ka[p];
  const en = index.en[p];
  main.append(el('span', 'row-title', ka || en || `#${index.id[p]}`));
  const sub = [];
  if (ka && en) sub.push(en);
  if (index.year[p]) sub.push(String(index.year[p]));
  if (sub.length) main.append(el('span', 'row-sub', sub.join(' · ')));

  const side = el('span', 'row-side');
  const names = (index.g[p] || []).slice(0, 2).map((gi) => genres[gi]).filter(Boolean);
  if (names.length) side.append(el('span', 'row-genres', names.join(' · ')));
  side.append(el('span', 'row-id', `ID ${index.id[p]}`));

  a.append(dot, main, side);
  li.append(a);
  return li;
}

// One block per genre: heading, the newest few titles, and a way to see all of them.
function renderSections() {
  const { index } = state.data;
  const { genres } = state.meta;
  const rows = phone.matches ? SECTION_ROWS_PHONE : SECTION_ROWS;
  const frag = document.createDocumentFragment();
  for (const { gi, items } of genreSections(index, genres.length)) {
    const sec = el('section', 'gsec');
    const head = el('div', 'gsec-head');
    const title = el('h2', 'gsec-title');
    const dot = el('span', 'dot');
    dot.style.background = genreColor(gi);
    title.append(dot, el('span', null, genres[gi]));
    head.append(title, el('span', 'gsec-count', fmt(items.length)));
    if (items.length > rows) {
      const all = el('button', 'link-btn gsec-all', 'ყველა ›');
      all.type = 'button';
      all.dataset.gi = String(gi);
      all.setAttribute('aria-label', `${genres[gi]}: ყველა ${fmt(items.length)}`);
      head.append(all);
    }
    const list = el('ul', 'results');
    for (let i = 0; i < items.length && i < rows; i++) list.append(buildRow(items[i]));
    sec.append(head, list);
    frag.append(sec);
  }
  $('sections').replaceChildren(frag);
}

function isFiltered() {
  return state.query.trim() !== '' || state.genres.size > 0;
}

function appendRows(from, to) {
  const frag = document.createDocumentFragment();
  for (let i = from; i < to; i++) frag.append(buildRow(state.results[i]));
  $('results').append(frag);
}

function updateMore() {
  const left = state.results.length - Math.min(state.limit, state.results.length);
  const more = $('more');
  more.hidden = left <= 0;
  more.textContent = `მეტის ჩვენება (დარჩა ${fmt(left)})`;
}

function renderList() {
  const { index } = state.data;
  const total = index.id.length;
  const filtered = isFiltered();
  const sectioned = !filtered && total > 0;   // nothing typed, no genre picked: browse by genre
  state.results = sectioned ? [] : filterItems(index, { query: state.query, genres: [...state.genres] });
  const found = sectioned ? total : state.results.length;

  $('list-count').textContent = PLURAL[state.set];
  const note = $('list-note');
  note.textContent = state.note || (filtered ? `ნაპოვნია ${fmt(found)} · სულ ${fmt(total)}` : `სულ ${fmt(total)} ${NOUN[state.set]} · ჟანრების მიხედვით`);
  note.classList.toggle('warn', !!state.note);
  note.hidden = false;
  state.note = '';

  $('sections').hidden = !sectioned;
  $('results').hidden = sectioned;
  if (sectioned) renderSections();
  else $('sections').replaceChildren();
  $('results').replaceChildren();
  appendRows(0, Math.min(state.limit, found));
  updateMore();

  const empty = $('list-empty');
  empty.hidden = found > 0;
  if (!found) {
    empty.querySelector('.empty-title').textContent = total ? 'ვერაფერი მოიძებნა' : 'მონაცემები ჯერ არ არის';
    empty.querySelector('.muted').textContent = total ? 'სცადე სხვა სახელი, ID ან ნაკლები ჟანრი.' : 'ამ ნაკრებში ჩანაწერები არ არის.';
    $('list-reset').hidden = !filtered;
  }
}

// Re-apply the search box + genre filter to whichever browsing view is open.
let listRaf = 0;
function scheduleList() {
  cancelAnimationFrame(listRaf);
  listRaf = requestAnimationFrame(() => {
    if (!state.data) return;
    if (state.view === 'map') {
      applyMapFilter(true);
    } else if (state.view === 'list') {
      renderList();
      $('view-list').scrollTop = 0;
    }
  });
}

function filtersChanged() {
  state.limit = PAGE;
  state.listScroll = 0;
}

// ---- search box -----------------------------------------------------------

function onQuery() {
  const input = $('q');
  state.query = input.value;
  $('q-clear').hidden = input.value === '';
  filtersChanged();
  if (!state.data) return;
  if (state.view === 'graph') location.hash = `#/${state.set}`;   // typing while a graph is open returns to the list
  else scheduleList();
}

function resetFilters() {
  $('q').value = '';
  state.query = '';
  $('q-clear').hidden = true;
  state.genres.clear();
  syncGenreUi();
  filtersChanged();
  scheduleList();
}

// ---- genres ---------------------------------------------------------------

function buildGenreChips() {
  const box = $('genre-chips');
  box.replaceChildren();
  state.meta.genres.forEach((name, gi) => {
    const chip = el('button', 'chip');
    chip.type = 'button';
    chip.dataset.gi = String(gi);
    chip.setAttribute('aria-pressed', 'false');
    const dot = el('span', 'dot');
    dot.style.background = genreColor(gi);
    chip.append(dot, el('span', null, name));
    box.append(chip);
  });
}

function syncGenreUi() {
  document.querySelectorAll('#genre-chips .chip').forEach((chip) => {
    chip.setAttribute('aria-pressed', String(state.genres.has(Number(chip.dataset.gi))));
  });
  const badge = $('genre-badge');
  badge.hidden = state.genres.size === 0;
  badge.textContent = String(state.genres.size);
  $('genre-btn').classList.toggle('is-active', state.genres.size > 0);
}

function onGenresChanged() {
  syncGenreUi();
  filtersChanged();
  if (state.view === 'graph') applyDimmed();
  else scheduleList();
}

function openGenres() {
  $('genre-pop').hidden = false;
  $('genre-btn').setAttribute('aria-expanded', 'true');
}
function closeGenres() {
  $('genre-pop').hidden = true;
  $('genre-btn').setAttribute('aria-expanded', 'false');
}

// ---- map ------------------------------------------------------------------

let mapSeq = 0;

function closeMap() {
  mapSeq++;
  if (state.map) {
    state.mapMem[state.mapSet] = { view: state.map.view(), selected: state.mapSel };
    state.map.destroy();
    state.map = null;
  }
  state.mapSel = -1;
  $('map-card').hidden = true;
}

function mapStatus(kind) {
  const box = $('map-status');
  box.hidden = !kind;
  $('map').hidden = !!kind;
  $('map-fit').hidden = kind === 'error';
  if (kind === 'loading') {
    const spin = el('div', 'spinner');
    spin.setAttribute('aria-hidden', 'true');
    box.replaceChildren(spin, el('p', null, 'რუკა იტვირთება…'));
  } else if (kind === 'error') {
    const retry = el('button', 'btn primary', 'თავიდან ცდა');
    retry.type = 'button';
    retry.addEventListener('click', showMap);
    box.replaceChildren(
      el('p', 'empty-title', 'რუკა ვერ ჩაიტვირთა'),
      el('p', 'muted', 'შეამოწმე ინტერნეტი და სცადე თავიდან. სია და გრაფი ისევ მუშაობს.'),
      retry,
    );
  } else {
    box.replaceChildren();
  }
}

function renderMapLegend() {
  const { index } = state.data;
  const { genres } = state.meta;
  const used = new Set();
  let other = false;
  for (let p = 0; p < index.id.length; p++) {
    const gi = (index.g[p] || [])[0];
    if (Number.isInteger(gi) && gi < PALETTE_SIZE && genres[gi]) used.add(gi);
    else other = true;
  }
  const box = $('map-legend');
  box.replaceChildren();
  const add = (color, name) => {
    const item = el('span', 'legend-item');
    const dot = el('span', 'dot');
    dot.style.background = color;
    item.append(dot, el('span', null, name));
    box.append(item);
  };
  [...used].sort((a, b) => a - b).forEach((gi) => add(genreColor(gi), genres[gi]));
  if (other) add(genreColor(-1), 'სხვა');
}

function renderMapNote(m) {
  const note = $('map-note');
  const total = state.data.index.id.length;
  note.hidden = !m.mask;
  note.textContent = m.mask ? (m.count ? `ნაპოვნია ${fmt(m.count)} / ${fmt(total)}` : 'ვერაფერი მოიძებნა') : '';
}

// Part of the map hidden under the card, in the map's own coordinates.
function mapCover() {
  const card = $('map-card');
  if (card.hidden) return null;
  const c = card.getBoundingClientRect();
  const m = $('map').getBoundingClientRect();
  return { left: c.left - m.left, top: c.top - m.top, right: c.right - m.left, bottom: c.bottom - m.top };
}

function renderMapCard() {
  const card = $('map-card');
  const p = state.mapSel;
  if (p < 0) {
    card.hidden = true;
    card.replaceChildren();
    return;
  }
  const { index } = state.data;
  const { genres } = state.meta;
  const ka = index.ka[p];
  const en = index.en[p];

  const head = el('div', 'map-card-head');
  const titles = el('div', 'titles');
  titles.append(el('h2', 'map-card-title', ka || en || `#${index.id[p]}`));
  const sub = [];
  if (ka && en) sub.push(en);
  if (index.year[p]) sub.push(String(index.year[p]));
  if (sub.length) titles.append(el('p', 'panel-sub', sub.join(' · ')));
  const close = el('button', 'icon-btn');
  close.type = 'button';
  close.setAttribute('aria-label', 'დახურვა');
  const x = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  x.setAttribute('viewBox', '0 0 20 20');
  x.setAttribute('width', '16');
  x.setAttribute('height', '16');
  x.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M5 5l10 10M15 5L5 15');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linecap', 'round');
  x.append(path);
  close.append(x);
  close.addEventListener('click', () => selectOnMap(-1));
  head.append(titles, close);

  const tags = el('div', 'tags');
  for (const gi of (index.g[p] || []).slice(0, 4)) {
    if (!genres[gi]) continue;
    const tag = el('span', 'tag');
    const dot = el('span', 'dot');
    dot.style.background = genreColor(gi);
    tag.append(dot, el('span', null, genres[gi]));
    tags.append(tag);
  }

  const go = el('a', 'btn primary', 'გრაფის ნახვა');
  go.href = `#/${state.set}/${index.id[p]}`;

  card.replaceChildren(head, ...(tags.childElementCount ? [tags] : []), go);
  card.hidden = false;
}

function selectOnMap(p) {
  if (!state.map) return;
  state.mapSel = p;
  renderMapCard();
  state.map.select(p);
}

function applyMapFilter(byUser = false) {
  if (!state.map) return;
  const m = matchMask(state.data.index, { query: state.query, genres: [...state.genres] });
  state.map.setMatch(m.mask, m.count);
  renderMapNote(m);
  // a search that leaves exactly one title: show where it is
  if (byUser && m.mask && m.count === 1 && state.query.trim() !== '') {
    selectOnMap(m.best);
    state.map.centreOn(m.best);
  }
}

function showMap() {
  closeMap();                      // a map of the other set, or a failed attempt
  setView('map');
  setBrowse('map');
  document.title = `${PLURAL[state.set]} · რუკა — ${APP_TITLE}`;
  renderMapLegend();
  $('map-note').hidden = true;
  const seq = mapSeq;
  const set = state.set;
  mapStatus(null);
  const timer = setTimeout(() => { if (seq === mapSeq) mapStatus('loading'); }, 150);
  loadXY(set).then((xy) => {
    clearTimeout(timer);
    if (seq !== mapSeq || state.view !== 'map') return;
    mapStatus(null);               // the container must be visible before it is measured
    const mem = state.mapMem[set] || {};
    const m = matchMask(state.data.index, { query: state.query, genres: [...state.genres] });
    state.mapSet = set;
    state.mapSel = Number.isInteger(mem.selected) ? mem.selected : -1;
    renderMapCard();
    state.map = renderMap($('map'), {
      index: state.data.index,
      xy,
      genres: state.meta.genres,
      mask: m.mask,
      matchCount: m.count,
      selected: state.mapSel,
      view: mem.view,
      cover: mapCover,
      onSelect: selectOnMap,
    });
    renderMapNote(m);
  }, (err) => {
    clearTimeout(timer);
    console.error(err);
    if (seq === mapSeq && state.view === 'map') mapStatus('error');
  });
}

// ---- graph ----------------------------------------------------------------

function available(p) {
  const list = state.data.nb.n[p];
  return Math.min(COUNT_MAX, Array.isArray(list) ? list.length : 0);
}

function dimmedSet(shown) {
  const out = new Set();
  if (!state.genres.size) return out;
  const need = [...state.genres];
  const { g } = state.data.index;
  for (const p of shown) {
    const have = g[p] || [];
    if (!need.every((gi) => have.includes(gi))) out.add(p);
  }
  return out;
}

function applyDimmed() {
  if (!state.graph) return;
  const dim = dimmedSet(state.graph.shown);
  state.graph.setDimmed(dim);
  renderGraphNote(dim.size);
}

function sheetMode() {
  return $('panel').dataset.sheet || 'peek';
}
function insets() {
  if (!phone.matches) return {};
  const half = Math.round(window.innerHeight * 0.46);
  return { bottom: sheetMode() === 'peek' ? SHEET_PEEK : half };
}
function focusMode() {
  return phone.matches && sheetMode() !== 'peek';
}
function setSheet(mode) {
  if (sheetMode() === mode) return;
  $('panel').dataset.sheet = mode;
  if (mode === 'peek') $('panel-body').scrollTop = 0;
  if (state.graph) state.graph.setInsets(insets(), focusMode());
}

// The slider never asks for more than exists: its range shrinks to what the item has.
function syncSlider() {
  const avail = available(state.center);
  const slider = $('count');
  const shown = Math.min(state.count, avail);
  const lo = Math.min(COUNT_MIN, avail);
  slider.min = String(lo);
  slider.max = String(Math.max(avail, lo + 1));
  slider.value = String(shown);
  slider.disabled = avail <= COUNT_MIN;
  $('count-out').textContent = String(shown);
  slider.closest('.slider').title = avail < COUNT_MAX ? `სულ ${avail} მსგავსი ${NOUN[state.set]} არსებობს` : '';
  return shown;
}

function renderLegend() {
  const { index } = state.data;
  const { genres } = state.meta;
  const used = new Set();
  let other = false;
  for (const p of [state.center, ...state.graph.shown]) {
    const gi = (index.g[p] || [])[0];
    if (Number.isInteger(gi) && gi < PALETTE_SIZE && genres[gi]) used.add(gi);
    else other = true;
  }
  const box = $('legend');
  box.replaceChildren();
  const add = (color, name) => {
    const item = el('span', 'legend-item');
    const dot = el('span', 'dot');
    dot.style.background = color;
    item.append(dot, el('span', null, name));
    box.append(item);
  };
  [...used].sort((a, b) => a - b).forEach((gi) => add(genreColor(gi), genres[gi]));
  if (other) add(genreColor(-1), 'სხვა');
}

function renderGraphNote(dimCount = 0) {
  const note = $('graph-note');
  const shown = state.graph ? state.graph.shown.length : 0;
  let text = '';
  if (!shown) text = `მსგავსი ${PLURAL[state.set]} ვერ მოიძებნა.`;
  else if (dimCount) text = `ჟანრის ფილტრი: ${shown - dimCount} / ${shown} შეესაბამება`;
  note.textContent = text;
  note.hidden = !text;
}

function drawGraph() {
  const { index, nb } = state.data;
  const count = syncSlider();
  const shownNow = (nb.n[state.center] || []).slice(0, count);
  if (state.selected !== state.center && !shownNow.includes(state.selected)) {
    state.selected = state.center;
    renderPanel();
  }
  state.graph = renderGraph($('graph'), {
    index,
    nb,
    center: state.center,
    count,
    selected: state.selected,
    dimmed: dimmedSet(shownNow),
    insets: insets(),
    focus: focusMode(),
    onSelect: selectNode,
    onRecentre: recentre,
  });
  renderLegend();
  renderGraphNote(dimmedSet(state.graph.shown).size);
}

function renderPanel() {
  const { index, nb } = state.data;
  const p = state.selected;
  const at = (nb.n[state.center] || []).indexOf(p);
  showPanel($('panel-body'), {
    set: state.set,
    p,
    index,
    meta: state.meta,
    noDescription: index.nd[p] === 1,
    isCenter: p === state.center,
    score: at >= 0 ? nb.s[state.center][at] : null,
    onRecentre: recentre,
  });
}

function selectNode(p) {
  if (state.selected !== p) {
    state.selected = p;
    renderPanel();
  }
  state.graph.select(p);
  if (phone.matches && sheetMode() === 'peek') setSheet('half');   // re-frames the graph above the sheet
}

function recentre(p) {
  location.hash = `#/${state.set}/${state.data.index.id[p]}`;
}

function showGraph(p) {
  const { index } = state.data;
  state.center = p;
  state.selected = p;
  $('panel').dataset.sheet = 'peek';
  setView('graph');               // must be visible before measuring/drawing
  document.title = `${index.ka[p] || index.en[p] || index.id[p]} — ${APP_TITLE}`;
  renderPanel();
  drawGraph();
}

// ---- events ---------------------------------------------------------------

function bind() {
  window.addEventListener('hashchange', route);

  $('q').addEventListener('input', onQuery);
  $('q').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const q = state.query.trim();
    // Enter on an exact ID opens it straight away
    if (/^\d+$/.test(q) && state.data && posOfId(state.data.index, Number(q)) >= 0) {
      location.hash = `#/${state.set}/${Number(q)}`;
    }
    $('q').blur();
  });
  $('q-clear').addEventListener('click', () => {
    $('q').value = '';
    onQuery();
    $('q').focus();
  });
  $('list-reset').addEventListener('click', resetFilters);

  // "ყველა ›" of a genre section = that genre as the filter
  $('sections').addEventListener('click', (event) => {
    const all = event.target.closest('.gsec-all');
    if (!all) return;
    state.genres = new Set([Number(all.dataset.gi)]);
    onGenresChanged();
  });
  // "სექციები" while a filter hides the sections: clear the filter instead of doing nothing
  document.querySelectorAll('.view-seg a[data-view="list"]').forEach((a) => {
    a.addEventListener('click', (event) => {
      if (state.view !== 'list' || !isFiltered()) return;
      event.preventDefault();
      resetFilters();
    });
  });
  $('map-fit').addEventListener('click', () => { if (state.map) state.map.fit(); });

  $('more').addEventListener('click', () => {
    const from = Math.min(state.limit, state.results.length);
    state.limit += PAGE;
    appendRows(from, Math.min(state.limit, state.results.length));
    updateMore();
  });
  $('view-list').addEventListener('scroll', () => {
    if (state.view === 'list') state.listScroll = $('view-list').scrollTop;
  }, { passive: true });

  $('genre-btn').addEventListener('click', () => {
    if ($('genre-pop').hidden) openGenres();
    else closeGenres();
  });
  $('genre-done').addEventListener('click', closeGenres);
  $('genre-clear').addEventListener('click', () => {
    state.genres.clear();
    onGenresChanged();
  });
  $('genre-chips').addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (!chip) return;
    const gi = Number(chip.dataset.gi);
    if (state.genres.has(gi)) state.genres.delete(gi);
    else state.genres.add(gi);
    onGenresChanged();
  });
  document.addEventListener('pointerdown', (event) => {
    if (!$('genre-pop').hidden && !event.target.closest('.genre-wrap')) closeGenres();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (state.view === 'map' && state.mapSel >= 0 && $('genre-pop').hidden) selectOnMap(-1);
      closeGenres();
    }
    if (event.key === '/' && !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) {
      event.preventDefault();
      $('q').focus();
    }
  });

  let sliderRaf = 0;
  $('count').addEventListener('input', () => {
    state.count = Number($('count').value);
    $('count-out').textContent = String(state.count);
    saveCount(state.count);
    cancelAnimationFrame(sliderRaf);
    sliderRaf = requestAnimationFrame(() => { if (state.view === 'graph') drawGraph(); });
  });
  $('fit').addEventListener('click', () => { if (state.graph) state.graph.fit(); });

  // bottom sheet: tap the grip to toggle, swipe it up/down to step through peek → half → full
  const grip = $('sheet-grip');
  const order = ['peek', 'half', 'full'];
  let startY = null;
  let swiped = false;
  grip.addEventListener('pointerdown', (event) => { startY = event.clientY; swiped = false; });
  grip.addEventListener('pointerup', (event) => {
    if (startY == null) return;
    const dy = event.clientY - startY;
    startY = null;
    if (Math.abs(dy) < 24) return;
    swiped = true;
    const i = order.indexOf(sheetMode());
    setSheet(order[Math.max(0, Math.min(order.length - 1, i + (dy < 0 ? 1 : -1)))]);
  });
  grip.addEventListener('click', () => {
    if (swiped) { swiped = false; return; }
    setSheet(sheetMode() === 'peek' ? 'half' : 'peek');
  });
  $('panel-body').addEventListener('click', (event) => {
    if (phone.matches && sheetMode() === 'peek' && !event.target.closest('a, button')) setSheet('half');
  });
  phone.addEventListener('change', () => {
    if (state.graph) state.graph.setInsets(insets(), focusMode());
    if (state.view === 'list' && state.data && !isFiltered()) renderList();   // sections show fewer cards on phones
  });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  const go = () => { navigator.serviceWorker.register('sw.js').catch(() => { /* the app works without it */ }); };
  if (document.readyState === 'complete') go();
  else window.addEventListener('load', go, { once: true });
}

bind();
route();
registerServiceWorker();
