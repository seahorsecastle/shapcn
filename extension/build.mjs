// Builds the extension from source with esbuild. The engine is bundled from this repository's own package/ folder (no copied file).
//   node build.mjs           production: content.js and popup.js next to the manifest (no test hooks). This is what you load unpacked or zip.
//   node build.mjs --test    test build in .test-build/ (a full copy, with the test hooks: __shapcn, fault injection, freeze, trace)
// The popup imports a few Lucide icons from package/lucide.js. That file is generated: run `npm run build` in package/ first.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, copyFileSync, cpSync } from 'node:fs';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const test = process.argv.includes('--test');
const out = test ? path.join(here, '.test-build') : here;

if (!existsSync(path.join(here, '../package/lucide.js'))) {
  console.error('package/lucide.js is missing. Run "npm install && npm run build" in package/ first.');
  process.exit(1);
}
if (test) {
  mkdirSync(out, { recursive: true });
  for (const f of ['manifest.json', 'popup.html', 'popup.css']) copyFileSync(path.join(here, f), path.join(out, f));
  cpSync(path.join(here, 'icons'), path.join(out, 'icons'), { recursive: true });
}
for (const [entry, file] of [['src/content.js', 'content.js'], ['src/popup.js', 'popup.js']]) {
  await build({
    entryPoints: [path.join(here, entry)],
    bundle: true,
    format: 'iife',
    minify: true,
    target: 'chrome120',
    legalComments: 'none',
    define: { TEST_HOOKS: String(test) },
    outfile: path.join(out, file),
    logLevel: 'info',
  });
}
