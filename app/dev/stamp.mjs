// Stamps a build id into the deployed copy of the app, so that index.html and
// the css/js it loads always belong to the same deploy:
//
//   index.html   css/app.css          ->  css/app.css?v=<build>
//   js/*.js      from './map.js'      ->  from './map.js?v=<build>'
//   sw.js        const BUILD = 'dev'  ->  const BUILD = '<build>'
//
// Without it a reload right after a deploy can pair the new index.html with the
// previous css/js still held by the browser (same URL, older bytes).
//
// Run by the Pages workflow on its checkout, never on the working tree:
//   node app/dev/stamp.mjs app <build>

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCAL_ASSET = /\b(href|src)="((?![a-z]+:|\/\/)[^"?#]+\.(?:css|js))"/g;
const IMPORT = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"?]+\.js)\2/g;
const BUILD_LINE = /const BUILD = 'dev';/;

export function checkBuild(build) {
  if (!/^[\w.-]+$/.test(build || '') || build === 'dev') throw new Error(`bad build id: ${build}`);
  return build;
}

export function stampHtml(html, build) {
  return html.replace(LOCAL_ASSET, (_, attr, url) => `${attr}="${url}?v=${build}"`);
}

export function stampJs(source, build) {
  return source.replace(IMPORT, (_, head, quote, url) => `${head}${quote}${url}?v=${build}${quote}`);
}

export function stampSw(source, build) {
  if (!BUILD_LINE.test(source)) throw new Error("sw.js: `const BUILD = 'dev';` not found");
  return source.replace(BUILD_LINE, `const BUILD = '${build}';`);
}

export function stampApp(appDir, build) {
  checkBuild(build);
  const edit = (rel, fn) => {
    const file = path.join(appDir, rel);
    fs.writeFileSync(file, fn(fs.readFileSync(file, 'utf8'), build));
  };
  edit('index.html', stampHtml);
  edit('sw.js', stampSw);
  for (const name of fs.readdirSync(path.join(appDir, 'js'))) {
    if (name.endsWith('.js')) edit(path.join('js', name), stampJs);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [appDir, build] = process.argv.slice(2);
  if (!appDir || !build) {
    console.error('usage: node stamp.mjs <app dir> <build id>');
    process.exit(2);
  }
  stampApp(appDir, build);
  console.log(`stamped ${appDir} as ${build}`);
}
