import { test } from 'node:test';
import assert from 'node:assert/strict';
import { genreCentres, matchMask, pickLabels, bucketOf, clipTitle, typicalSpacing, MAX_TITLE_LABELS } from '../map.js';

const index = {
  id: [1, 2, 3, 4, 5, 6],
  ka: ['ღამე', 'დღე', 'ღამის მგზავრი', 'ზღვა', 'მთა', 'ტყე'],
  en: ['Night', 'Day', 'Night Rider', 'Sea', 'Mountain', 'Forest'],
  year: [0, 0, 0, 0, 0, 0],
  g: [[0, 2], [0], [2, 0], [], [0], [2]],
  nd: [0, 0, 0, 0, 0, 0],
};
const xy = { x: [100, 200, 800, 500, 300, 900], y: [100, 100, 700, 500, 400, 900] };

test('genre label positions: mean of the titles whose FIRST genre it is', () => {
  const c = genreCentres(index, xy, 3);
  assert.deepEqual(c.map((g) => g.gi), [0, 2, -1]);          // genre 1 is nobody's first genre
  assert.deepEqual([c[0].x, c[0].y, c[0].n], [200, 200, 3]);  // positions 0, 1, 4
  assert.deepEqual([c[1].x, c[1].y, c[1].n], [850, 800, 2]);  // positions 2, 5 (position 0 has genre 2 second)
  assert.equal(c[0].r, Math.hypot(100, 200));                 // farthest dot of the disc
});

test('titles without a genre form their own entry, last', () => {
  const c = genreCentres(index, xy, 3);
  assert.deepEqual(c[2], { gi: -1, x: 500, y: 500, r: 0, n: 1 });
  assert.equal(genreCentres({ id: [1], g: [[0]] }, { x: [5], y: [6] }, 1).length, 1);
});

test('match mask: nothing filtered means everything is vivid', () => {
  assert.deepEqual(matchMask(index, {}), { mask: null, count: 6, best: -1 });
  assert.equal(matchMask(index, { query: '   ', genres: [] }).mask, null);
});

test('match mask: search query, same rules as the list', () => {
  const m = matchMask(index, { query: 'ღამ' });
  assert.deepEqual([...m.mask], [1, 0, 1, 0, 0, 0]);
  assert.equal(m.count, 2);
  assert.equal(m.best, 2);   // newest of the prefix matches
  const en = matchMask(index, { query: 'SEA' });
  assert.deepEqual([en.count, en.best], [1, 3]);
});

test('match mask: genre filter needs all picked genres, and combines with the query', () => {
  assert.deepEqual([...matchMask(index, { genres: [2] }).mask], [1, 0, 1, 0, 0, 1]);
  assert.deepEqual([...matchMask(index, { genres: [0, 2] }).mask], [1, 0, 1, 0, 0, 0]);
  assert.deepEqual([...matchMask(index, { query: 'rider', genres: [0] }).mask], [0, 0, 1, 0, 0, 0]);
});

test('match mask: no match dims everything', () => {
  const m = matchMask(index, { query: 'zzz' });
  assert.deepEqual([m.count, m.best, m.mask.some(Boolean)], [0, -1, false]);
});

const flat = (boxes) => Float64Array.from(boxes.flat());

test('label choice keeps earlier (higher priority) boxes and drops the ones that overlap them', () => {
  const rects = flat([[0, 0, 50, 10], [40, 5, 90, 15], [60, 0, 100, 10], [0, 20, 50, 30]]);
  const out = new Int32Array(10);
  const kept = pickLabels(rects, 4, 10, out);
  assert.deepEqual([...out.subarray(0, kept)], [0, 2, 3]);
});

test('label choice honours padding', () => {
  const rects = flat([[0, 0, 50, 10], [52, 0, 100, 10]]);
  const out = new Int32Array(2);
  assert.equal(pickLabels(rects, 2, 2, out, 0), 2);
  assert.equal(pickLabels(rects, 2, 2, out, 3), 1);
});

test('label choice is capped', () => {
  const boxes = Array.from({ length: 200 }, (_, i) => [i * 100, 0, i * 100 + 50, 10]);   // none overlap
  const out = new Int32Array(MAX_TITLE_LABELS);
  const kept = pickLabels(flat(boxes), 200, MAX_TITLE_LABELS, out);
  assert.equal(kept, MAX_TITLE_LABELS);
  assert.ok(MAX_TITLE_LABELS <= 40);
  assert.deepEqual([...out.subarray(0, 3)], [0, 1, 2]);
  assert.equal(pickLabels(flat(boxes), 200, 0, out), 0);
});

test('colour bucket: palette genres keep their slot, the rest share one', () => {
  assert.deepEqual([bucketOf(0), bucketOf(9), bucketOf(10), bucketOf(25), bucketOf(undefined), bucketOf(-1)], [0, 9, 10, 10, 10, 10]);
});

test('clipTitle', () => {
  assert.equal(clipTitle('მოკლე'), 'მოკლე');
  const long = clipTitle('ძალიან გრძელი სათაური რომელიც არ ეტევა', 12);
  assert.ok(long.endsWith('…') && long.length <= 13);
});

test('typical spacing of a regular grid', () => {
  const xs = [];
  const ys = [];
  for (let i = 0; i < 20; i++) for (let j = 0; j < 20; j++) { xs.push(i * 6); ys.push(j * 6); }
  assert.equal(typicalSpacing(xs, ys), 6);
  assert.equal(typicalSpacing([1], [1]), 10);
});
