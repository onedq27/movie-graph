// Checks that the hand-written shell files agree with each other: the ids the
// script looks up exist in the page, both themes define the same colours, and
// the service worker knows every file the page needs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { THEME_BAR, THEME_KEY } from '../theme.js';

const APP = path.resolve(import.meta.dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');
const html = read('index.html');
const css = read('css/app.css');
const sw = read('sw.js');

function block(selector) {
  const start = css.indexOf(selector + ' {');
  assert.ok(start >= 0, `${selector} block missing`);
  return css.slice(start, css.indexOf('\n}', start));
}
const vars = (text) => Object.fromEntries([...text.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)].map((m) => [m[1], m[2].trim()]));
const light = vars(block(':root'));
const dark = vars(block(':root[data-theme="dark"]'));

test('every id main.js looks up exists in index.html', () => {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const used = new Set([...read('js/main.js').matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  assert.ok(used.size > 10);
  for (const id of used) assert.ok(ids.has(id), `#${id} is used in main.js but not in index.html`);
});

test('the toggle button has both icons and a label', () => {
  const btn = /<button id="theme-btn"[^>]*>[\s\S]*?<\/button>/.exec(html);
  assert.ok(btn, 'theme button missing');
  assert.match(btn[0], /aria-label="[^"]+"/);
  assert.match(btn[0], /class="i-moon"/);
  assert.match(btn[0], /class="i-sun"/);
});

test('the dark theme overrides every colour of the light one, and adds none of its own', () => {
  const sizes = new Set(['--radius', '--tap']);
  const colours = Object.keys(light).filter((k) => !sizes.has(k));
  assert.ok(colours.length > 30);
  assert.deepEqual(Object.keys(dark).sort(), colours.sort());
});

test('each theme sets its own color-scheme, so form controls and scrollbars follow', () => {
  assert.match(block(':root'), /color-scheme:\s*light;/);
  assert.match(block(':root[data-theme="dark"]'), /color-scheme:\s*dark;/);
});

test('the theme does not depend on the system setting in css', () => {
  // The toggle sets data-theme; a prefers-color-scheme rule would fight it.
  assert.doesNotMatch(css, /prefers-color-scheme/);
});

test('one icon shows per theme', () => {
  assert.match(css, /\.theme-btn \.i-sun, :root\[data-theme="dark"\] \.theme-btn \.i-moon \{ display: none; \}/);
  assert.match(css, /:root\[data-theme="dark"\] \.theme-btn \.i-sun \{ display: block; \}/);
});

test('browser bar colours match the page background of each theme', () => {
  assert.equal(THEME_BAR.light, light['--bg']);
  assert.equal(THEME_BAR.dark, dark['--bg']);
});

// The inline script in <head> picks the theme before first paint.
function runInline({ saved, systemDark, storageThrows = false }) {
  const m = /<script>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, 'inline theme script missing');
  assert.ok(html.indexOf(m[0]) < html.indexOf('rel="stylesheet"'), 'must run before the stylesheet paints');
  const meta = { content: '' };
  const document = {
    documentElement: { dataset: {} },
    getElementById: (id) => (id === 'theme-color' ? meta : null),
  };
  const localStorage = {
    getItem: (k) => { if (storageThrows) throw new Error('denied'); return k === THEME_KEY ? saved ?? null : null; },
  };
  vm.runInNewContext(m[1], { document, localStorage, matchMedia: () => ({ matches: systemDark }) });
  return { theme: document.documentElement.dataset.theme, bar: meta.content };
}

test('first paint: saved theme, else system theme, with the matching bar colour', () => {
  assert.deepEqual(runInline({ saved: 'dark', systemDark: false }), { theme: 'dark', bar: THEME_BAR.dark });
  assert.deepEqual(runInline({ saved: 'light', systemDark: true }), { theme: 'light', bar: THEME_BAR.light });
  assert.deepEqual(runInline({ saved: null, systemDark: true }), { theme: 'dark', bar: THEME_BAR.dark });
  assert.deepEqual(runInline({ saved: 'junk', systemDark: false }), { theme: 'light', bar: THEME_BAR.light });
  assert.deepEqual(runInline({ systemDark: true, storageThrows: true }), { theme: 'dark', bar: THEME_BAR.dark });
});

test('the service worker precaches every file the page loads', () => {
  const list = /const SHELL = \[([\s\S]*?)\];/.exec(sw);
  const shell = new Set([...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
  for (const rel of shell) {
    if (rel !== './') assert.ok(fs.existsSync(path.join(APP, rel)), `SHELL lists a missing file: ${rel}`);
  }
  const modules = fs.readdirSync(path.join(APP, 'js')).filter((n) => n.endsWith('.js')).map((n) => `js/${n}`);
  const linked = [...html.matchAll(/(?:href|src)="([^"#:]+\.(?:css|js|webmanifest))"/g)].map((m) => m[1]);
  for (const rel of [...modules, ...linked]) assert.ok(shell.has(rel), `${rel} is not in the service worker SHELL list`);
});
