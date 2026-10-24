// Real browser: a press or hover style must never swallow the button's `click`.
// Why: every frame replaces the children of the svg. A pointerdown on a stroke would lose its target and Chrome would not fire `click`.
// This test needs Playwright and Chrome. It skips when Playwright is not found. To run it:
//   npm i --no-save playwright            (in package/), or: PLAYWRIGHT_DIR=/path/with/node_modules node --test test/click-browser.test.mjs
// It uses the installed Google Chrome (channel "chrome") and the built dist/morph-icon.js (run `npm run build` first; `npm test` does).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PKG, m } from './helpers.mjs';

let chromium = null;
try {
  const req = createRequire((process.env.PLAYWRIGHT_DIR || PKG) + '/');
  chromium = req('playwright').chromium;
} catch (e) {
  chromium = null;
}
const dist = PKG + '/dist/morph-icon.js';
const skip = process.env.SHAPCN_REQUIRE_ALL ? false : !chromium ? 'Playwright is not installed (see the comment at the top of this file)' : !existsSync(dist) ? 'run npm run build first' : false;

test('a click fires when the pointer goes down on a stroke, for every press style and every hover style', { skip }, async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await (await browser.newContext({ viewport: { width: 700, height: 500 } })).newPage();
    const cases = [
      ...m.PRESS_STYLES.map((s) => ({ attr: 'press="' + s + '"', label: 'press ' + s })),
      ...m.HOVER_STYLES.map((s) => ({ attr: 'hover="' + s + '"', label: 'hover ' + s })),
      { attr: 'hover="alive"', label: 'hover alive (old name)' },
      { attr: 'hover="wiggle" press="burst"', label: 'hover wiggle + press burst' },
    ];
    const html = '<!doctype html><body style="margin:40px"><script>' + readFileSync(dist, 'utf8') + '<\/script>' +
      cases.map((c, i) => '<button id="b' + i + '" style="padding:20px;margin:10px"><morph-icon id="i' + i + '" name="share" size="64" ' + c.attr + '></morph-icon></button>').join('') + '</body>';
    await page.setContent(html);
    await page.waitForTimeout(500);
    await page.evaluate((n) => { window.clicks = new Array(n).fill(0); for (let i = 0; i < n; i++) document.getElementById('b' + i).addEventListener('click', () => window.clicks[i]++); }, cases.length);
    const fails = [];
    for (const [i, c] of cases.entries()) {
      // a point on a stroke: the middle of the first path, in page coordinates
      const pt = await page.evaluate((id) => {
        const p = document.getElementById(id).querySelector('svg path, svg line, svg polyline');
        const q = p.getPointAtLength ? p.getPointAtLength(p.getTotalLength() / 2) : { x: 12, y: 12 };
        const r = p.ownerSVGElement.createSVGPoint(); r.x = q.x; r.y = q.y;
        const s = r.matrixTransform(p.getScreenCTM());
        return [s.x, s.y];
      }, 'i' + i);
      for (const wait of [0, 80, 540]) {
        const before = await page.evaluate((k) => window.clicks[k], i);
        await page.mouse.move(5, 5);
        await page.waitForTimeout(700);
        await page.mouse.move(pt[0], pt[1], { steps: 2 });
        await page.waitForTimeout(wait);
        await page.mouse.down();
        await page.waitForTimeout(80);
        await page.mouse.up();
        await page.waitForTimeout(50);
        const after = await page.evaluate((k) => window.clicks[k], i);
        if (after !== before + 1) fails.push(c.label + ' (hover ' + wait + ' ms before the click)');
      }
    }
    assert.deepEqual(fails, [], 'clicks lost: ' + fails.join('; '));
  } finally {
    await browser.close();
  }
});
