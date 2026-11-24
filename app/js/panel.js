// Detail panel (side column on desktop, bottom sheet on phones).
// Every scraped string goes in through textContent / attribute setters.

import { loadDetail } from './data.js';
import { genreColor } from './graph.js';

const tokens = new WeakMap();

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

/** Only http(s) links are ever put into href/src. */
export function safeHttpUrl(value) {
  try {
    const u = new URL(String(value || ''));
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : '';
  } catch {
    return '';
  }
}

/** TMDB serves multi-megabyte originals; ask for a phone-sized rendition instead. */
export function posterUrl(value) {
  const url = safeHttpUrl(value);
  return url.replace(/^(https?:\/\/image\.tmdb\.org\/t\/p\/)original\//, '$1w780/');
}

/**
 * @param {HTMLElement} root
 * @param {{set:string, p:number, index:object, meta:object, noDescription:boolean,
 *          onRecentre?:(p:number)=>void, score?:number|null, isCenter?:boolean}} o
 */
export function showPanel(root, o) {
  const { set, p, index, meta, noDescription, onRecentre, score = null, isCenter = false } = o;
  const token = {};
  tokens.set(root, token);
  const alive = () => tokens.get(root) === token;

  const ka = index.ka[p] || '';
  const en = index.en[p] || '';
  const year = index.year[p] || 0;
  const id = index.id[p];

  const frag = document.createDocumentFragment();

  // head: poster + titles
  const head = el('div', 'panel-head');
  const poster = el('div', 'poster');
  poster.hidden = true;
  const titles = el('div', 'titles');
  titles.append(el('h2', 'panel-title', ka || en || `#${id}`));
  const subParts = [];
  if (ka && en) subParts.push(en);
  if (year) subParts.push(String(year));
  if (subParts.length) titles.append(el('p', 'panel-sub', subParts.join(' · ')));
  const metaLine = el('p', 'panel-meta');
  metaLine.append(el('span', 'kind', set === 'serial' ? 'სერიალი' : 'ფილმი'), el('span', 'id', `ID ${id}`));
  if (isCenter) metaLine.append(el('span', 'pill', 'ცენტრი'));
  else if (score != null) metaLine.append(el('span', 'pill', `მსგავსება ${score}%`));
  titles.append(metaLine);
  head.append(poster, titles);
  frag.append(head);

  // genres
  const gs = index.g[p] || [];
  if (gs.length) {
    const tags = el('ul', 'tags');
    gs.forEach((gi, k) => {
      const li = el('li', 'tag');
      const dot = el('span', 'dot');
      dot.style.background = k === 0 ? genreColor(gi) : 'transparent';
      if (k !== 0) dot.classList.add('hollow');
      li.append(dot, el('span', null, meta.genres[gi] || '—'));
      tags.append(li);
    });
    frag.append(tags);
  }

  if (noDescription) {
    frag.append(el('p', 'notice', 'აღწერა არ არის — კავშირები მხოლოდ ჟანრითაა'));
  }

  const body = el('div', 'panel-desc');
  frag.append(body);

  // actions
  const actions = el('div', 'panel-actions');
  const watch = el('a', 'btn primary watch');
  watch.append(el('span', null, 'უყურე gemovie.tv-ზე'));
  watch.target = '_blank';
  watch.rel = 'noopener';
  watch.setAttribute('aria-disabled', 'true');
  actions.append(watch);
  if (!isCenter && onRecentre) {
    const around = el('button', 'btn around', 'ამის ირგვლივ აჩვენე');
    around.type = 'button';
    around.addEventListener('click', () => onRecentre(p));
    actions.append(around);
  }
  frag.append(actions);

  root.replaceChildren(frag);
  root.scrollTop = 0;

  function showLoading() {
    const sk = el('div', 'skeleton');
    sk.setAttribute('aria-label', 'იტვირთება');
    sk.append(el('span'), el('span'), el('span'));
    body.replaceChildren(sk);
  }

  function showError() {
    const box = el('div', 'load-error');
    box.setAttribute('role', 'alert');
    box.append(el('p', null, 'ვერ ჩაიტვირთა'), el('p', 'muted', 'შეამოწმე ინტერნეტი და სცადე თავიდან.'));
    const retry = el('button', 'btn', 'თავიდან ცდა');
    retry.type = 'button';
    retry.addEventListener('click', load);
    box.append(retry);
    body.replaceChildren(box);
  }

  function showDetail(d) {
    if (d.desc) body.replaceChildren(el('p', 'desc', d.desc));
    else if (noDescription) body.replaceChildren();
    else body.replaceChildren(el('p', 'muted', 'აღწერა არ არის.'));

    const href = safeHttpUrl(d.url);
    if (href) {
      watch.href = href;
      watch.removeAttribute('aria-disabled');
    }

    const src = posterUrl(d.img);
    if (src) {
      const img = new Image();
      img.alt = '';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      // A broken or unreachable poster simply never shows: the box stays hidden.
      img.addEventListener('load', () => {
        if (!alive()) return;
        poster.replaceChildren(img);
        poster.hidden = false;
      });
      img.addEventListener('error', () => { if (alive()) poster.hidden = true; });
      img.src = src;
    }
  }

  function load() {
    showLoading();
    loadDetail(set, p).then(
      (d) => { if (alive()) showDetail(d); },
      () => { if (alive()) showError(); },
    );
  }
  load();
}
