import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, wrapLabel, genreColor } from '../graph.js';

const index = { id: [1, 2, 3, 4, 5, 6], ka: [], en: [], year: [], g: [], nd: [] };
const nb = {
  n: [[1, 2, 3, 4], [0, 2], [0], [5], [], []],
  s: [[90, 80, 70, 60], [90, 55], [80], [40], [], []],
};

test('centre plus the first `count` neighbours, best first', () => {
  const g = buildGraph({ index, nb, center: 0, count: 3 });
  assert.deepEqual(g.nodes.map((n) => n.p), [0, 1, 2, 3]);
  assert.equal(g.nodes[0].center, true);
  assert.deepEqual(g.nodes.slice(1).map((n) => n.score), [90, 80, 70]);
  assert.deepEqual(g.links.filter((l) => l.kind === 'c').map((l) => [l.source, l.target, l.score]), [[0, 1, 90], [0, 2, 80], [0, 3, 70]]);
});

test('neighbours are linked when either lists the other', () => {
  const g = buildGraph({ index, nb, center: 0, count: 4 });
  // 1 lists 2 (2 does not list 1) -> one link; 3 and 4 list neither of the shown ones
  assert.deepEqual(g.links.filter((l) => l.kind === 'n').map((l) => [l.source, l.target, l.score]), [[1, 2, 55]]);
});

test('fewer neighbours than asked: draws what exists', () => {
  assert.equal(buildGraph({ index, nb, center: 0, count: 30 }).nodes.length, 5);
  assert.equal(buildGraph({ index, nb, center: 2, count: 12 }).nodes.length, 2);
  const lonely = buildGraph({ index, nb, center: 4, count: 12 });
  assert.deepEqual(lonely.nodes.map((n) => n.p), [4]);
  assert.deepEqual(lonely.links, []);
});

test('bad neighbour data is skipped, not drawn', () => {
  const odd = { n: [[0, 1, 1, 99, -1, 2]], s: [[100, 90, 90, 80, 70, 60]] };
  const g = buildGraph({ index, nb: odd, center: 0, count: 10 });
  assert.deepEqual(g.nodes.map((n) => n.p), [0, 1, 2]);
  const missing = buildGraph({ index, nb: { n: [], s: [] }, center: 3, count: 10 });
  assert.equal(missing.nodes.length, 1);
});

test('wrapLabel keeps short titles, wraps to two lines, truncates the rest', () => {
  assert.deepEqual(wrapLabel('ღვია'), ['ღვია']);
  assert.deepEqual(wrapLabel('რკინის კაცი 2'), ['რკინის კაცი 2']);
  assert.deepEqual(wrapLabel('დამზადებულია ამერიკაში'), ['დამზადებულია', 'ამერიკაში']);
  const long = wrapLabel('ბეჭდების მბრძანებელი: ბეჭდის საძმო და კიდევ რაღაც');
  assert.equal(long.length, 2);
  assert.ok(long[1].endsWith('…'));
  assert.ok(long.every((l) => l.length <= 17));
  assert.ok(wrapLabel('Supercalifragilisticexpialidocious')[0].length <= 15);
  assert.deepEqual(wrapLabel(''), ['']);
});

test('genreColor falls back to the neutral colour', () => {
  assert.equal(genreColor(0), 'var(--g0)');
  assert.equal(genreColor(9), 'var(--g9)');
  assert.equal(genreColor(10), 'var(--g-other)');
  assert.equal(genreColor(undefined), 'var(--g-other)');
});
