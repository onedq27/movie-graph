// Runs sw.js against a fake Cache API and a fake network, and walks it through
// deploys. The point: a page must never get css/js from a different deploy
// than its index.html.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { stampSw, stampHtml } from '../../dev/stamp.mjs';

const SW_SOURCE = fs.readFileSync(path.resolve(import.meta.dirname, '../../sw.js'), 'utf8');
const ORIGIN = 'https://example.test';
const BASE = `${ORIGIN}/app/`;

class FakeResponse {
  constructor(body, ok = true) { this.body = body; this.ok = ok; this.type = 'basic'; this.status = ok ? 200 : 404; }
  clone() { return new FakeResponse(this.body, this.ok); }
  async text() { return this.body; }
  async json() { return JSON.parse(this.body); }
}

class FakeCache {
  constructor() { this.map = new Map(); }
  async match(key, opts = {}) {
    const url = typeof key === 'string' ? new URL(key, BASE).href : key.url;
    if (this.map.has(url)) return this.map.get(url).clone();
    if (opts.ignoreSearch) {
      const bare = (u) => { const x = new URL(u); return x.origin + x.pathname; };
      for (const [k, v] of this.map) if (bare(k) === bare(url)) return v.clone();
    }
    return undefined;
  }
  async put(key, res) { this.map.set(typeof key === 'string' ? key : key.url, res); }
  async keys() { return [...this.map.keys()].map((url) => ({ url })); }
  async delete(key) { return this.map.delete(typeof key === 'string' ? key : key.url); }
}

// One browser profile (its caches) and one server (what is deployed right now).
function world() {
  const stores = new Map();
  const caches = {
    open: async (name) => { if (!stores.has(name)) stores.set(name, new FakeCache()); return stores.get(name); },
    keys: async () => [...stores.keys()],
    delete: async (name) => stores.delete(name),
  };
  const net = { deployed: null, online: true, hits: [] };
  // Like GitHub Pages: the query string is ignored, the current deploy answers.
  const fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (!net.online) throw new TypeError('offline');
    net.hits.push(url.pathname.replace('/app/', '') + url.search);
    const rel = url.pathname.replace('/app/', '') || 'index.html';
    if (rel === 'data/meta.json') return new FakeResponse(JSON.stringify({ version: 'data1' }));
    if (rel === 'index.html') {
      const page = '<link rel="stylesheet" href="css/app.css"><script src="js/main.js"></script>';
      return new FakeResponse(net.deployed === 'dev' ? page : stampHtml(page, net.deployed));
    }
    return new FakeResponse(`${rel}@${net.deployed}`);
  };

  // Start the service worker of `build`, as the browser does after fetching a changed sw.js.
  async function worker(build) {
    const listeners = {};
    const self = {
      location: { href: `${BASE}sw.js`, origin: ORIGIN },
      addEventListener: (type, fn) => { listeners[type] = fn; },
      skipWaiting: async () => {},
      clients: { claim: async () => {} },
    };
    const source = build === 'dev' ? SW_SOURCE : stampSw(SW_SOURCE, build);
    vm.runInNewContext(source, { self, caches, fetch, URL, Promise, JSON, Error });
    const lifecycle = async (type) => {
      const waits = [];
      listeners[type]({ waitUntil: (p) => waits.push(p) });
      await Promise.all(waits);
    };
    await lifecycle('install');
    await lifecycle('activate');
    return {
      // Resolves with the body once background work (waitUntil) has also finished.
      async get(rel, mode = 'no-cors') {
        const waits = [];
        let answer;
        listeners.fetch({
          request: { method: 'GET', url: BASE + rel, mode },
          respondWith: (p) => { answer = p; },
          waitUntil: (p) => waits.push(p),
        });
        assert.ok(answer, `the worker ignored ${rel}`);
        const res = await answer;
        await Promise.all(waits);
        return res.text();
      },
    };
  }
  const shellKeys = async () => (stores.get('shell-v2') ? [...stores.get('shell-v2').map.keys()].map((k) => k.replace(BASE, '')) : []);
  return { net, stores, worker, shellKeys };
}

const assetsOf = (pageHtml) => [...pageHtml.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]);

test('install caches css/js under the URL of its build', async () => {
  const w = world();
  w.net.deployed = 'A';
  await w.worker('A');
  const keys = await w.shellKeys();
  assert.ok(keys.includes('css/app.css?v=A'));
  assert.ok(keys.includes('js/main.js?v=A'));
  assert.ok(keys.includes('js/theme.js?v=A'));
  assert.ok(keys.includes('index.html'));
  assert.ok(keys.includes('icons/icon-192.png'));          // not css/js: no build in the URL
});

test('cached css/js of the current build is served without the network', async () => {
  const w = world();
  w.net.deployed = 'A';
  const sw = await w.worker('A');
  w.net.hits.length = 0;
  assert.equal(await sw.get('css/app.css?v=A'), 'css/app.css@A');
  assert.deepEqual(w.net.hits, []);
});

test('after a deploy, whichever index.html is served gets the css/js of its own build', async () => {
  const w = world();
  w.net.deployed = 'A';
  const sw = await w.worker('A');         // the worker of build A stays in charge for now
  w.net.deployed = 'B';                   // a new deploy lands

  // Every page load from here on, in whatever state the caches are.
  for (let load = 1; load <= 3; load++) {
    const page = await sw.get('', 'navigate');
    const build = /\?v=(\w+)/.exec(page)[1];
    for (const asset of assetsOf(page)) {
      const body = await sw.get(asset);
      assert.equal(body, `${asset.split('?')[0]}@${build}`, `load ${load}: ${asset} came from another build`);
    }
    if (load === 1) assert.equal(build, 'A');   // cached page first, refreshed in the background
    else assert.equal(build, 'B');
  }
});

test('a new worker drops the css/js of older builds and the old cache', async () => {
  const w = world();
  w.stores.set('shell-v1', new FakeCache());   // left by the worker before build stamping
  w.net.deployed = 'A';
  await w.worker('A');
  w.net.deployed = 'B';
  await w.worker('B');
  const keys = await w.shellKeys();
  assert.ok(keys.includes('js/main.js?v=B'));
  assert.deepEqual(keys.filter((k) => k.includes('?v=A')), []);
  assert.ok(!w.stores.has('shell-v1'));
  assert.ok(w.stores.has('data-v1'));
});

test('offline, the app still opens from the cache', async () => {
  const w = world();
  w.net.deployed = 'A';
  const sw = await w.worker('A');
  w.net.online = false;
  const page = await sw.get('', 'navigate');
  for (const asset of assetsOf(page)) assert.equal(await sw.get(asset), `${asset.split('?')[0]}@A`);
});

test('offline with a page newer than the cached css/js: an older file beats a blank page', async () => {
  const w = world();
  w.net.deployed = 'A';
  const sw = await w.worker('A');
  w.net.online = false;
  assert.equal(await sw.get('css/app.css?v=B'), 'css/app.css@A');
});

test('unstamped (local development): shell files are refreshed on every load', async () => {
  const w = world();
  w.net.deployed = 'dev';
  const sw = await w.worker('dev');
  assert.ok((await w.shellKeys()).includes('css/app.css'));
  w.net.deployed = 'dev2';                                   // the file was edited
  assert.equal(await sw.get('css/app.css'), 'css/app.css@dev');    // cached copy now…
  assert.equal(await sw.get('css/app.css'), 'css/app.css@dev2');   // …the edit on the next load
});
