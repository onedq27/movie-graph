// Service worker for the movie graph PWA.
//
// Everything is resolved relative to the worker's scope, because the app is
// served from a sub-path (https://<user>.github.io/<repo>/).
//
//   index.html           stale-while-revalidate (cache answers, network refreshes it)
//   css/js with ?v=      cache-first: the deploy stamps every css/js URL with the build
//                        (app/dev/stamp.mjs), so a page always gets the css/js it was
//                        written for, never a leftover from an older deploy
//   other shell files    stale-while-revalidate (icons, manifest, everything when unstamped)
//   data/meta.json       network-first, cached copy when offline
//   data/*?v=<version>   cache-first (the version is part of the URL; includes {set}.xy.json)
//   other origins        not handled at all (posters go straight to the network)
//
// The cached data/meta.json is the "newest version seen". Whenever a fresher
// meta.json arrives, and on every activate, cached data files whose ?v= is not
// that version are deleted, so an installed phone does not keep old exports.

const BUILD = 'dev';              // the deploy replaces this with the commit SHA (app/dev/stamp.mjs)
const SHELL_CACHE = 'shell-v2';   // bump only if the caching scheme itself changes
const DATA_CACHE = 'data-v1';

const SCOPE = new URL('./', self.location.href);
const DATA_PREFIX = new URL('data/', SCOPE).pathname;
const META_PATH = new URL('data/meta.json', SCOPE).pathname;
const INDEX_URL = new URL('index.html', SCOPE).href;

const SHELL = [
  './',
  'index.html',
  'css/app.css',
  'js/main.js',
  'js/data.js',
  'js/search.js',
  'js/graph.js',
  'js/panel.js',
  'js/sections.js',
  'js/map.js',
  'js/theme.js',
  'vendor/d3.min.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

const cacheable = (res) => res && res.ok && res.type === 'basic';
const STAMPED = BUILD !== 'dev';
// Same rule as the stamp script: css and js carry the build in their URL.
const shellUrl = (path) => {
  const url = new URL(path, SCOPE);
  if (STAMPED && /\.(css|js)$/.test(url.pathname)) url.searchParams.set('v', BUILD);
  return url.href;
};

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // One by one: a missing or failing file must not fail the whole install.
    await Promise.all(SHELL.map(async (path) => {
      try {
        const url = shellUrl(path);
        const res = await fetch(url, { cache: 'no-cache' });
        if (cacheable(res)) await cache.put(url, res);
      } catch (_) { /* picked up later by stale-while-revalidate */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((n) => n !== SHELL_CACHE && n !== DATA_CACHE)
      .map((n) => caches.delete(n)));
    await pruneData(await cachedVersion());
    await pruneShell();
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;        // posters etc.
  if (!url.pathname.startsWith(SCOPE.pathname)) return;

  if (url.pathname === META_PATH) {
    event.respondWith(metaNetworkFirst(event, req));
  } else if (url.pathname.startsWith(DATA_PREFIX)) {
    event.respondWith(url.searchParams.has('v')
      ? dataCacheFirst(req)
      : networkFirst(req));                               // unversioned: never pin it
  } else if (req.mode !== 'navigate' && url.searchParams.has('v')) {
    event.respondWith(shellVersioned(url));
  } else {
    event.respondWith(shellStaleWhileRevalidate(event, req, url));
  }
});

// ---- data ---------------------------------------------------------------

async function versionOf(res) {
  try {
    const meta = await res.clone().json();
    return typeof meta.version === 'string' && meta.version ? meta.version : null;
  } catch (_) {
    return null;
  }
}

async function cachedVersion() {
  const cache = await caches.open(DATA_CACHE);
  const res = await cache.match(META_PATH, { ignoreSearch: true });
  return res ? versionOf(res) : null;
}

// Delete every cached data file that does not belong to `version`.
async function pruneData(version) {
  if (!version) return;            // nothing trustworthy to compare with: keep all
  const cache = await caches.open(DATA_CACHE);
  const keys = await cache.keys();
  await Promise.all(keys.map((req) => {
    const url = new URL(req.url);
    if (url.pathname === META_PATH) return null;
    return url.searchParams.get('v') === version ? null : cache.delete(req);
  }));
}

async function metaNetworkFirst(event, req) {
  const cache = await caches.open(DATA_CACHE);
  try {
    // 'no-store': skip the HTTP cache (GitHub Pages serves max-age=600).
    const res = await fetch(req.url, { cache: 'no-store' });
    if (!cacheable(res)) throw new Error('meta ' + res.status);
    const version = await versionOf(res);
    if (!version) throw new Error('meta without version');
    const copy = res.clone();
    event.waitUntil((async () => {
      // Stored under the bare path so there is exactly one meta entry.
      await cache.put(new URL(META_PATH, SCOPE).href, copy);
      await pruneData(version);
    })());
    return res;
  } catch (err) {
    const cached = await cache.match(META_PATH, { ignoreSearch: true });
    if (cached) return cached;
    throw err;
  }
}

async function dataCacheFirst(req) {
  const cache = await caches.open(DATA_CACHE);
  const cached = await cache.match(req.url);
  if (cached) return cached;
  const res = await fetch(req);
  if (cacheable(res)) {
    // Awaited so a caller that sees the response can rely on it being cached.
    await cache.put(req.url, res.clone());
  }
  return res;
}

async function networkFirst(req) {
  const cache = await caches.open(DATA_CACHE);
  try {
    const res = await fetch(req.url, { cache: 'no-store' });
    if (cacheable(res)) await cache.put(req.url, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(req.url);
    if (cached) return cached;
    throw err;
  }
}

// ---- shell --------------------------------------------------------------

// css/js of one build: the URL names the build, so a cached copy never goes stale.
async function shellVersioned(url) {
  const cache = await caches.open(SHELL_CACHE);
  const key = url.origin + url.pathname + url.search;
  const cached = await cache.match(key);
  if (cached) return cached;
  try {
    // 'no-cache': the same path was served with other bytes by an earlier deploy.
    const res = await fetch(key, { cache: 'no-cache' });
    if (cacheable(res)) await cache.put(key, res.clone());
    return res;
  } catch (err) {
    // Offline and this build is not cached yet: another build's file beats a blank page.
    const other = await cache.match(url.origin + url.pathname, { ignoreSearch: true });
    if (other) return other;
    throw err;
  }
}

// Drop css/js that belong to other builds.
async function pruneShell() {
  if (!STAMPED) return;
  const cache = await caches.open(SHELL_CACHE);
  const keys = await cache.keys();
  await Promise.all(keys.map((req) => {
    const v = new URL(req.url).searchParams.get('v');
    return v === null || v === BUILD ? null : cache.delete(req);
  }));
}

async function shellStaleWhileRevalidate(event, req, url) {
  const cache = await caches.open(SHELL_CACHE);
  // Page loads (with or without a query string) all map to index.html.
  const key = req.mode === 'navigate' ? INDEX_URL : url.origin + url.pathname;
  const cached = await cache.match(key);

  const refresh = (async () => {
    // 'no-cache' = revalidate with the server instead of trusting the HTTP cache.
    const res = await fetch(key, { cache: 'no-cache' });
    if (cacheable(res)) await cache.put(key, res.clone());
    return res;
  })();

  if (cached) {
    event.waitUntil(refresh.catch(() => {}));
    return cached;
  }
  return refresh;
}
