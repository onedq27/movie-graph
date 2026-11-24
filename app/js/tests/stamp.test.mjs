import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stampHtml, stampJs, stampSw, stampApp, checkBuild } from '../../dev/stamp.mjs';

const APP = path.resolve(import.meta.dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');

test('stampHtml versions local css and js, nothing else', () => {
  const html = [
    '<link rel="stylesheet" href="css/app.css">',
    '<link rel="manifest" href="manifest.webmanifest">',
    '<link rel="icon" href="icons/icon-192.png">',
    '<script src="vendor/d3.min.js"></script>',
    '<script type="module" src="js/main.js"></script>',
    '<script src="https://cdn.example/x.js"></script>',
    '<a href="#/movie">x</a>',
  ].join('\n');
  assert.equal(stampHtml(html, 'abc'), [
    '<link rel="stylesheet" href="css/app.css?v=abc">',
    '<link rel="manifest" href="manifest.webmanifest">',
    '<link rel="icon" href="icons/icon-192.png">',
    '<script src="vendor/d3.min.js?v=abc"></script>',
    '<script type="module" src="js/main.js?v=abc"></script>',
    '<script src="https://cdn.example/x.js"></script>',
    '<a href="#/movie">x</a>',
  ].join('\n'));
});

test('stampJs versions relative imports and leaves other strings alone', () => {
  const src = [
    "import { a } from './a.js';",
    'import { b } from "../b.js";',
    "import './side.js';",
    "const m = await import('./lazy.js');",
    "const s = 'sw.js'; fetch('./data.js');",
    "import fs from 'node:fs';",
  ].join('\n');
  assert.equal(stampJs(src, 'abc'), [
    "import { a } from './a.js?v=abc';",
    'import { b } from "../b.js?v=abc";',
    "import './side.js?v=abc';",
    "const m = await import('./lazy.js?v=abc');",
    "const s = 'sw.js'; fetch('./data.js');",
    "import fs from 'node:fs';",
  ].join('\n'));
});

test('stampSw sets BUILD and refuses a file without the marker', () => {
  assert.match(stampSw(read('sw.js'), 'abc'), /const BUILD = 'abc';/);
  assert.throws(() => stampSw('const x = 1;', 'abc'), /BUILD/);
});

test('checkBuild rejects ids that would break a URL or a string literal', () => {
  assert.equal(checkBuild('7d3fa43'), '7d3fa43');
  for (const bad of ['', 'dev', "a'b", 'a b', 'a&b', undefined]) assert.throws(() => checkBuild(bad));
});

test('the real app, stamped: every css/js reference carries the build', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-'));
  try {
    fs.mkdirSync(path.join(dir, 'js'));
    for (const rel of ['index.html', 'sw.js']) fs.copyFileSync(path.join(APP, rel), path.join(dir, rel));
    const modules = fs.readdirSync(path.join(APP, 'js')).filter((n) => n.endsWith('.js'));
    for (const n of modules) fs.copyFileSync(path.join(APP, 'js', n), path.join(dir, 'js', n));
    stampApp(dir, 'b1');

    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    const assets = [...html.matchAll(/(?:href|src)="([^"]+\.(?:css|js)[^"]*)"/g)].map((m) => m[1]);
    assert.ok(assets.length >= 3);
    for (const a of assets) assert.match(a, /\?v=b1$/, a);

    // Every module must be imported under ONE URL, or the browser loads it twice.
    for (const n of modules) {
      const src = fs.readFileSync(path.join(dir, 'js', n), 'utf8');
      const imports = [...src.matchAll(/^import\s[^;]*?['"]([^'"]+)['"]/gm)].map((m) => m[1]);
      for (const spec of imports) assert.match(spec, /\.js\?v=b1$/, `${n}: ${spec}`);
    }
    assert.match(fs.readFileSync(path.join(dir, 'sw.js'), 'utf8'), /const BUILD = 'b1';/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
