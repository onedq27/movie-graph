import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupByGenre, genreSections } from '../sections.js';

// positions ascend with id, so a higher position is a newer title
const index = {
  id: [10, 11, 12, 13, 14, 15],
  g: [[0], [1, 0], [], [3, 1], [0, 3], [1]],
};

test('one section per genre in genre order, empty genres skipped', () => {
  const s = groupByGenre(index, 5);
  assert.deepEqual(s.map((x) => x.gi), [0, 1, 3]);   // 2 and 4 have no titles
});

test('newest first inside a section, with full counts', () => {
  const s = groupByGenre(index, 5);
  assert.deepEqual(s[0].items, [4, 1, 0]);
  assert.deepEqual(s[1].items, [5, 3, 1]);
  assert.deepEqual(s[2].items, [4, 3]);
  assert.deepEqual(s.map((x) => x.items.length), [3, 3, 2]);
});

test('a title with several genres is listed under each of them, one without any under none', () => {
  const s = groupByGenre(index, 5);
  assert.equal(s.filter((x) => x.items.includes(1)).length, 2);
  assert.equal(s.filter((x) => x.items.includes(4)).length, 2);
  assert.equal(s.some((x) => x.items.includes(2)), false);
});

test('tolerates a repeated or unknown genre index', () => {
  const s = groupByGenre({ id: [1, 2], g: [[0, 0], [7, 0]] }, 2);
  assert.deepEqual(s, [{ gi: 0, items: [1, 0] }]);
});

test('empty set', () => {
  assert.deepEqual(groupByGenre({ id: [], g: [] }, 3), []);
});

test('genreSections computes once per index', () => {
  assert.equal(genreSections(index, 5), genreSections(index, 5));
  assert.deepEqual(genreSections(index, 5), groupByGenre(index, 5));
});
