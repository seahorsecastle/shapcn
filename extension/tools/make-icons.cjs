// Draws icons/icon{16,32,48,128}.png: the Lucide `shapes` mark (ISC) in ink on a yellow tile.
// Run: PLAYWRIGHT_DIR=<folder with node_modules/playwright> node tools/make-icons.cjs
const path = require('path');
const { createRequire } = require('module');
const req = createRequire(path.join(process.env.PLAYWRIGHT_DIR || path.join(__dirname, '..'), 'x.js'));
const { chromium } = req('playwright');
const SHAPES = '<path d="M8.3 10a.7.7 0 0 1-.626-1.079L11.4 3a.7.7 0 0 1 1.198-.043L16.3 8.9a.7.7 0 0 1-.572 1.1Z"/><rect x="3" y="14" width="7" height="7" rx="1"/><circle cx="17.5" cy="17.5" r="3.5"/>';
(async () => {
  const b = await chromium.launch({ channel: 'chrome' });
  for (const n of [16, 32, 48, 128]) {
    const p = await b.newPage({ viewport: { width: n, height: n }, deviceScaleFactor: 1 });
    const sw = n <= 16 ? 2.6 : n <= 32 ? 2.2 : 2;
    await p.setContent(`<body style="margin:0;background:transparent"><svg width="${n}" height="${n}" viewBox="0 0 ${n} ${n}"><rect width="${n}" height="${n}" rx="${n * 0.22}" fill="#FFE14D"/><g transform="translate(${n * 0.2} ${n * 0.2}) scale(${(n * 0.6) / 24})" fill="none" stroke="#14130F" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${SHAPES}</g></svg>`);
    await p.screenshot({ path: path.join(__dirname, '..', 'icons', `icon${n}.png`), omitBackground: true });
    await p.close();
  }
  await b.close();
})();
