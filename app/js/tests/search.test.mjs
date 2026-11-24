import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterItems, normalize } from '../search.js';

// positions:      0            1            2              3             4            5
const index = {
  id:   [7,           18,          180,           1894,         1917,        50691],
  ka:   ['შვიდი',     'რკინის კაცი', 'რკინის კაცი 2', 'შურისმაძიებლები', '1917',   'ღვია'],
  en:   ['Se7en',     'Iron Man',  'Iron Man 2',  'The Avengers', '1917',      'Juniper'],
  year: [1995,        2008,        2010,          2012,         2019,        2021],
  g:    [[0, 2],      [1, 3],      [1, 3],        [1, 3, 4],    [0, 5],      [0, 6]],
  nd:   [0, 0, 0, 0, 0, 1],
};
const ids = (ps) => ps.map((p) => index.id[p]);

test('empty query, no genres: everything, newest id first', () => {
  assert.deepEqual(filterItems(index, { query: '', genres: [] }), [5, 4, 3, 2, 1, 0]);
  assert.deepEqual(filterItems(index, {}), [5, 4, 3, 2, 1, 0]);
  assert.deepEqual(filterItems(index, { query: '   ' }), [5, 4, 3, 2, 1, 0]);
});

test('Georgian substring', () => {
  assert.deepEqual(ids(filterItems(index, { query: 'კაცი' })), [180, 18]);
  assert.deepEqual(ids(filterItems(index, { query: 'მაძიებ' })), [1894]);
});

test('Latin is case-insensitive, partial titles match', () => {
  assert.deepEqual(ids(filterItems(index, { query: 'IRON' })), [180, 18]);
  assert.deepEqual(ids(filterItems(index, { query: 'iron man 2' })), [180]);
  assert.deepEqual(ids(filterItems(index, { query: 'veng' })), [1894]);
  assert.deepEqual(ids(filterItems(index, { query: '  jUnIp ' })), [50691]);
});

test('prefix matches come before inner matches', () => {
  const idx = { id: [1, 2, 3], ka: ['ა', 'ბ', 'გ'], en: ['Batman', 'The Man', 'Manhattan'], year: [0, 0, 0], g: [[], [], []], nd: [0, 0, 0] };
  assert.deepEqual(ids2(idx, filterItems(idx, { query: 'man' })), [3, 2, 1]);
});
const ids2 = (idx, ps) => ps.map((p) => idx.id[p]);

test('digits match ids by prefix, exact id first, then titles', () => {
  assert.deepEqual(ids(filterItems(index, { query: '18' })), [18, 180, 1894]);
  assert.deepEqual(ids(filterItems(index, { query: '180' })), [180]);
  assert.deepEqual(ids(filterItems(index, { query: '1' })).slice(0, 4), [18, 180, 1894, 1917]);
  assert.deepEqual(ids(filterItems(index, { query: '50691' })), [50691]);
  // "7" is an exact id (its own title "Se7en" must not list it twice) and is inside the title "1917"
  assert.deepEqual(ids(filterItems(index, { query: '7' })), [7, 1917]);
  // "2" is no id prefix but is in "Iron Man 2"
  assert.deepEqual(ids(filterItems(index, { query: '2' })), [180]);
  // no duplicates when id and title both match
  assert.deepEqual(ids(filterItems(index, { query: '1917' })), [1917]);
});

test('genres require ALL selected', () => {
  assert.deepEqual(ids(filterItems(index, { genres: [1, 3] })), [1894, 180, 18]);
  assert.deepEqual(ids(filterItems(index, { genres: [1, 4] })), [1894]);
  assert.deepEqual(ids(filterItems(index, { genres: [0] })), [50691, 1917, 7]);
  assert.deepEqual(filterItems(index, { genres: [2, 6] }), []);
});

test('query and genres combine', () => {
  assert.deepEqual(ids(filterItems(index, { query: 'iron', genres: [4] })), []);
  assert.deepEqual(ids(filterItems(index, { query: '18', genres: [4] })), [1894]);
  assert.deepEqual(ids(filterItems(index, { query: 'ი', genres: [0] })), [50691, 7]);
});

test('no matches -> []', () => {
  assert.deepEqual(filterItems(index, { query: 'zzzz' }), []);
  assert.deepEqual(filterItems(index, { query: '999999' }), []);
  assert.deepEqual(filterItems({ id: [], ka: [], en: [], year: [], g: [], nd: [] }, { query: 'a' }), []);
});

test('normalize', () => {
  assert.equal(normalize('  Iron   MAN '), 'iron man');
  assert.equal(normalize(null), '');
});

test('10k items stay fast, even for a query matching thousands', () => {
  const n = 10_300;
  const words = ['კაცი', 'ღამე', 'ქალაქი', 'სიყვარული', 'ომი', 'მგზავრი', 'ბოლო', 'დღე'];
  const big = { id: [], ka: [], en: [], year: [], g: [], nd: [] };
  for (let i = 0; i < n; i++) {
    big.id.push(i * 5 + 1);
    big.ka.push(`${words[i % 8]} ${words[(i * 7) % 8]} ${i}`);
    big.en.push(`The Movie Number ${i} of ${words.length}`);
    big.year.push(1950 + (i % 75));
    big.g.push([i % 20, (i * 3) % 20, (i * 11) % 20]);
    big.nd.push(0);
  }
  filterItems(big, { query: 'warm-up' });
  const t0 = performance.now();
  const all = filterItems(big, {});
  const many = filterItems(big, { query: 'movie' });
  const ka = filterItems(big, { query: 'კაცი' });
  const digits = filterItems(big, { query: '1' });
  const genre = filterItems(big, { query: 'e', genres: [3, 9] });
  const ms = performance.now() - t0;
  assert.equal(all.length, n);
  assert.equal(many.length, n);
  assert.ok(ka.length > 1000);
  assert.ok(digits.length > 1000);
  assert.equal(new Set(digits).size, digits.length);
  assert.ok(genre.every((p) => big.g[p].includes(3) && big.g[p].includes(9)));
  assert.ok(ms < 250, `5 searches over ${n} items took ${ms.toFixed(1)} ms`);
});
