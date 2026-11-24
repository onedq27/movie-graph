import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const fresh = () => import(`../data.js?t=${Math.random()}`);

const META = { version: '20261124T1200', genres: ['დრამა'], sets: { movie: { count: 3, chunkSize: 2, chunks: 2 } } };
const FILES = {
  'data/meta.json': META,
  'data/movie.index.json?v=20261124T1200': { id: [5, 9, 12], ka: ['ა', 'ბ', 'გ'], en: ['a', 'b', 'c'], year: [0, 0, 0], g: [[0], [], [0]], nd: [0, 0, 1] },
  'data/movie.nb.json?v=20261124T1200': { n: [[1], [0], [0, 1]], s: [[80], [80], [50, 50]] },
  'data/movie.d.0.json?v=20261124T1200': { desc: ['d0', 'd1'], img: ['i0', 'i1'], url: ['u0', 'u1'] },
  'data/movie.d.1.json?v=20261124T1200': { desc: [''], img: ['i2'], url: ['u2'] },
};
let calls;
let failing;
beforeEach(() => {
  calls = [];
  failing = new Set();
  globalThis.fetch = async (url) => {
    calls.push(url);
    if (failing.has(url) || !(url in FILES)) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => structuredClone(FILES[url]) };
  };
});

test('chunkOf', async () => {
  const { chunkOf } = await fresh();
  assert.deepEqual(chunkOf(0, 500), [0, 0]);
  assert.deepEqual(chunkOf(499, 500), [0, 499]);
  assert.deepEqual(chunkOf(500, 500), [1, 0]);
  assert.deepEqual(chunkOf(10299, 500), [20, 299]);
});

test('posOfId', async () => {
  const { posOfId } = await fresh();
  const index = { id: [5, 9, 12, 40] };
  assert.equal(posOfId(index, 5), 0);
  assert.equal(posOfId(index, 12), 2);
  assert.equal(posOfId(index, 40), 3);
  assert.equal(posOfId(index, 6), -1);
  assert.equal(posOfId({ id: [] }, 1), -1);
});

test('meta is fetched unversioned, data files carry ?v=', async () => {
  const { loadSet, loadDetail } = await fresh();
  const { index, nb } = await loadSet('movie');
  assert.equal(index.id.length, 3);
  assert.equal(nb.n.length, 3);
  assert.deepEqual(await loadDetail('movie', 1), { desc: 'd1', img: 'i1', url: 'u1' });
  assert.deepEqual(await loadDetail('movie', 2), { desc: '', img: 'i2', url: 'u2' });
  assert.equal(calls[0], 'data/meta.json');
  assert.ok(calls.slice(1).every((u) => u.endsWith('?v=20261124T1200')));
});

test('chunks and sets are memoised', async () => {
  const { loadSet, loadDetail } = await fresh();
  await loadSet('movie');
  await loadSet('movie');
  await loadDetail('movie', 0);
  await loadDetail('movie', 1);
  assert.equal(calls.filter((u) => u.includes('index')).length, 1);
  assert.equal(calls.filter((u) => u.includes('.d.0.')).length, 1);
});

test('a failed chunk is not cached: retry refetches and succeeds', async () => {
  const { loadDetail } = await fresh();
  const url = 'data/movie.d.0.json?v=20261124T1200';
  failing.add(url);
  await assert.rejects(loadDetail('movie', 0));
  failing.delete(url);
  assert.equal((await loadDetail('movie', 0)).desc, 'd0');
  assert.equal(calls.filter((u) => u === url).length, 2);
});

test('unknown set rejects', async () => {
  const { loadSet } = await fresh();
  await assert.rejects(loadSet('nope'));
});
