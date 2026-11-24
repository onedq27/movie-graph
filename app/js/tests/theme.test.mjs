import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickTheme, otherTheme, savedTheme, initTheme, THEME_BAR, THEME_EVENT, THEME_KEY } from '../theme.js';

const LABELS = { dark: 'to dark', light: 'to light' };

function storageOf(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    map,
  };
}

// Just enough DOM for initTheme.
function world({ saved, systemDark = false, storage } = {}) {
  const doc = new EventTarget();
  doc.documentElement = { dataset: {} };
  const button = new EventTarget();
  button.attrs = {};
  button.setAttribute = (k, v) => { button.attrs[k] = v; };
  const mq = new EventTarget();
  mq.matches = systemDark;
  const meta = { content: '' };
  const store = storage || storageOf(saved ? { [THEME_KEY]: saved } : {});
  const events = [];
  doc.addEventListener(THEME_EVENT, () => events.push(doc.documentElement.dataset.theme));
  initTheme({ doc, storage: store, systemDark: mq, button, meta, labels: LABELS });
  return {
    doc, button, mq, meta, store, events,
    theme: () => doc.documentElement.dataset.theme,
    click: () => button.dispatchEvent(new Event('click')),
    system: (dark) => { mq.matches = dark; mq.dispatchEvent(new Event('change')); },
  };
}

test('pickTheme: a saved choice wins, otherwise the system decides', () => {
  assert.equal(pickTheme('dark', false), 'dark');
  assert.equal(pickTheme('light', true), 'light');
  assert.equal(pickTheme(null, true), 'dark');
  assert.equal(pickTheme(null, false), 'light');
  assert.equal(pickTheme('purple', true), 'dark');   // junk in storage is ignored
});

test('otherTheme flips', () => {
  assert.equal(otherTheme('dark'), 'light');
  assert.equal(otherTheme('light'), 'dark');
});

test('savedTheme survives missing, broken and junk storage', () => {
  assert.equal(savedTheme(storageOf({ theme: 'dark' })), 'dark');
  assert.equal(savedTheme(storageOf({ theme: 'blue' })), null);
  assert.equal(savedTheme(storageOf()), null);
  assert.equal(savedTheme(null), null);
  assert.equal(savedTheme({ getItem() { throw new Error('denied'); } }), null);
});

test('starts on the system theme when nothing is saved', () => {
  assert.equal(world({ systemDark: true }).theme(), 'dark');
  assert.equal(world({ systemDark: false }).theme(), 'light');
});

test('starts on the saved theme whatever the system says', () => {
  assert.equal(world({ saved: 'dark', systemDark: false }).theme(), 'dark');
  assert.equal(world({ saved: 'light', systemDark: true }).theme(), 'light');
});

test('a click switches the theme, saves it, and switches back on the next click', () => {
  const w = world({ systemDark: false });
  w.click();
  assert.equal(w.theme(), 'dark');
  assert.equal(w.store.map.get(THEME_KEY), 'dark');
  w.click();
  assert.equal(w.theme(), 'light');
  assert.equal(w.store.map.get(THEME_KEY), 'light');
});

test('every switch updates the browser bar colour and the button label', () => {
  const w = world({ systemDark: false });
  assert.equal(w.meta.content, THEME_BAR.light);
  assert.equal(w.button.attrs['aria-label'], LABELS.dark);    // in light, it offers dark
  w.click();
  assert.equal(w.meta.content, THEME_BAR.dark);
  assert.equal(w.button.attrs['aria-label'], LABELS.light);
  assert.equal(w.button.title, LABELS.light);
});

test('every switch announces itself so the canvas map can repaint', () => {
  const w = world({ systemDark: false });
  w.click();
  w.click();
  assert.deepEqual(w.events, ['light', 'dark', 'light']);
});

test('follows a system change only until the user has chosen', () => {
  const w = world({ systemDark: false });
  w.system(true);
  assert.equal(w.theme(), 'dark');
  w.click();                       // explicit choice: light
  w.system(false);
  w.system(true);
  assert.equal(w.theme(), 'light');
});

test('still switches when storage refuses writes', () => {
  const storage = { getItem: () => null, setItem() { throw new Error('quota'); } };
  const w = world({ storage });
  w.click();
  assert.equal(w.theme(), 'dark');
});
