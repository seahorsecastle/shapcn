// Builds dist/morph-icon.js: the engine, the Lucide icons and the <morph-icon> element as one classic script.
// Usage: node scripts/build-dist.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(PKG, p), 'utf8');
const fail = (msg) => { console.error('build-dist: ' + msg); process.exit(1); };

const strip = (src) =>
  src.replace(/^import[^\n]*\n/gm, '').replace(/^export\s*\{[^}]*\};?[ \t]*$/gm, '').replace(/^export\s+(?=(?:const|function|class|async|let)\b)/gm, '');
const core = strip(read('core.js'));
const render = strip(read('render.js'));
const effects = strip(read('effects.js'));
const dom = strip(read('dom.js'));
const regionsSrc = read('regions.js');
const regionNames = Array.from(regionsSrc.matchAll(/^export\s+(?:const|function|class|async function)\s+([A-Za-z_$][\w$]*)/gm)).map((m) => m[1]);
const regions =
  'const __regions = (function () {\n' + strip(regionsSrc) + '\nreturn { ' + regionNames.join(', ') + ' };\n})();\n' +
  'const { ' + regionNames.filter((n) => n !== 'parsePath').join(', ') + ' } = __regions;';
const indexSrc = read('index.js');
const glueStart = indexSrc.indexOf('export function registerFamilyFile');
if (glueStart < 0) fail('index.js has no registerFamilyFile');
const glue = strip(indexSrc.slice(glueStart)).replace(/\bcore\./g, '');
const names = ['DEFAULTS', 'easings', 'registerIcons', 'registerFamily', 'registerFamilyFile', 'getIconInfo', 'getFamily', 'getIconNames', 'iconToSVG', 'planMorph', 'planAlive', 'MorphIcon', 'defineMorphIcon'];
const nodes = JSON.stringify(JSON.parse(read('data/lucide-nodes.json')));
const script =
  '/* shapcn: morph any icon into any other. MIT license. Lucide icons: ISC license. https://shapcn.com */\n' +
  "(function () {\n'use strict';\nif (window.customElements && window.customElements.get('morph-icon')) return;\n" +
  core + '\n' + regions + '\n' + render + '\n' + effects + '\n' + dom + '\n' + glue + '\n' +
  'registerIcons(' + nodes + ');\ndefineMorphIcon();\n' +
  'window.shapcn = {\n' + names.map((n) => '  ' + n + ': ' + n).join(',\n') + '\n};\n})();\n';
mkdirSync(join(PKG, 'dist'), { recursive: true });
writeFileSync(join(PKG, 'dist', 'morph-icon.js'), script);
console.log('dist/morph-icon.js ' + script.length + ' bytes');
