// Real browser: element-level behavior of <morph-icon> that the pure plan tests cannot see (0.2.1).
// Needs Playwright and Chrome, like click-browser.test.mjs (see the comment there). Skips without Playwright.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PKG } from './helpers.mjs';

let chromium = null;
try {
  chromium = createRequire((process.env.PLAYWRIGHT_DIR || PKG) + '/')('playwright').chromium;
} catch (e) {
  chromium = null;
}
const dist = PKG + '/dist/morph-icon.js';
const skip = !chromium ? 'Playwright is not installed (see click-browser.test.mjs)' : !existsSync(dist) ? 'run npm run build first' : false;
// The page counts every addEventListener on document and on buttons before the engine loads, to see leaks.
const SPY = `<script>
window.__listeners = new Map();
const add = EventTarget.prototype.addEventListener, rem = EventTarget.prototype.removeEventListener;
const key = (t, type, fn, opt) => type + '|' + (t === document ? 'document' : t.tagName || 'other');
EventTarget.prototype.addEventListener = function (type, fn, opt) {
  if (type === 'pointerdown' || type === 'pointerenter') { const k = key(this, type); window.__listeners.set(k, (window.__listeners.get(k) || new Set()).add(fn)); }
  return add.call(this, type, fn, opt);
};
EventTarget.prototype.removeEventListener = function (type, fn, opt) {
  if (type === 'pointerdown' || type === 'pointerenter') { const s = window.__listeners.get(key(this, type)); if (s) s.delete(fn); }
  return rem.call(this, type, fn, opt);
};
window.live = (type, who) => (window.__listeners.get(type + '|' + who) || new Set()).size;
// geometry of an svg: the polylines of its paths, and the largest distance between two pictures
window.polys = (svg) => [...svg.querySelectorAll('path')].flatMap((p) => p.getAttribute('d').split('M').filter((x) => x.trim()).map((x) => x.trim().split(/\\s+/).map(Number))).filter((P) => P.length >= 4);
const sd = (px, py, P) => { let b = Infinity; for (let k = 0; k + 3 < P.length; k += 2) { const ax = P[k], ay = P[k + 1], dx = P[k + 2] - ax, dy = P[k + 3] - ay, L = dx * dx + dy * dy, f = L > 1e-12 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0; b = Math.min(b, Math.hypot(px - ax - f * dx, py - ay - f * dy)); } return b; };
window.dist = (A, B) => { let m = 0; for (const [X, Y] of [[A, B], [B, A]]) for (const P of X) for (let k = 0; k < P.length; k += 2) { let b = Infinity; for (const Q of Y) b = Math.min(b, sd(P[k], P[k + 1], Q)); m = Math.max(m, b); } return m; };
</script>`;
async function setup(browser, body) {
  const page = await (await browser.newContext({ viewport: { width: 700, height: 500 } })).newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.setContent('<!doctype html><body style="margin:40px">' + SPY + '<script>' + readFileSync(dist, 'utf8') + '<\/script>' + body + '</body>');
  await page.waitForTimeout(400);
  return { page, errs };
}
async function withBrowser(fn) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try { await fn(browser); } finally { await browser.close(); }
}

test('1. a removed icon leaves no document or button listeners; a reconnected icon works again', { skip }, () => withBrowser(async (browser) => {
  const { page } = await setup(browser, '<div id="host"></div>');
  const r = await page.evaluate(async () => {
    const out = {};
    const base = window.live('pointerdown', 'document');
    const host = document.getElementById('host');
    for (let i = 0; i < 30; i++) { const b = document.createElement('button'); b.innerHTML = '<morph-icon name="bell" hover="grow" press="pop"></morph-icon>'; host.appendChild(b); }
    await new Promise((r) => setTimeout(r, 100));
    out.during = window.live('pointerdown', 'document') - base;
    host.innerHTML = '';
    await new Promise((r) => setTimeout(r, 100));
    out.after = window.live('pointerdown', 'document') - base;
    out.buttons = window.live('pointerenter', 'BUTTON');
    // move one icon to another button: hover must follow the new ancestor and not the old one
    const b1 = document.createElement('button'), b2 = document.createElement('button');
    host.append(b1, b2);
    b1.innerHTML = '<morph-icon id="m" name="bell" size="32" hover="grow"></morph-icon>';
    await new Promise((r) => setTimeout(r, 100));
    const m = document.getElementById('m');
    b2.appendChild(m);
    await new Promise((r) => setTimeout(r, 100));
    const svgs = () => m.querySelector('svg').innerHTML;
    const rest = svgs();
    b1.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }));
    await new Promise((r) => setTimeout(r, 120));
    out.oldAncestorPlays = svgs() !== rest;
    await new Promise((r) => setTimeout(r, 700));
    b2.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }));
    await new Promise((r) => setTimeout(r, 120));
    out.newAncestorPlays = svgs() !== rest;
    return out;
  });
  assert.equal(r.after, 0, 'document pointerdown listeners left after removing 30 icons: ' + r.after + ' (during: ' + r.during + ')');
  assert.equal(r.buttons, 0, 'pointerenter listeners left on the removed buttons: ' + r.buttons);
  assert.equal(r.oldAncestorPlays, false, 'the old ancestor still drives the icon');
  assert.equal(r.newAncestorPlays, true, 'the new ancestor does not drive the icon');
}));

test('2. a live sway (hover="move") that is interrupted settles its Promise with false', { skip }, () => withBrowser(async (browser) => {
  const { page } = await setup(browser, '<button><morph-icon id="m" name="bell" size="32" hover="move" press="pop"></morph-icon></button>');
  const r = await page.evaluate(async () => {
    const m = document.getElementById('m');
    const out = {};
    for (const how of ['playPress', 'morphTo', 'destroy']) {
      const p = how === 'destroy' ? m._mi.playAlive({ velocity: { vx: 0.6, vy: 0 } }) : m.playAlive({ velocity: { vx: 0.6, vy: 0 } });
      await new Promise((r) => setTimeout(r, 80));
      if (how === 'playPress') m.playPress(); else if (how === 'morphTo') m.morphTo('check'); else m._mi._cancel();
      out[how] = await Promise.race([p, new Promise((r) => setTimeout(() => r('pending'), 400))]);
      m.morphTo('bell'); await new Promise((r) => setTimeout(r, 700));
    }
    return out;
  });
  assert.deepEqual(r, { playPress: false, morphTo: false, destroy: false });
}));

test('3. bold: enter, leave, enter again during the return keeps the held weight', { skip }, () => withBrowser(async (browser) => {
  const { page } = await setup(browser, '<button style="padding:20px"><morph-icon id="m" name="heart" size="64" hover="bold"></morph-icon></button>');
  const rest = await page.evaluate(() => document.getElementById('m').querySelector('svg').innerHTML);
  const bb = await page.locator('#m').boundingBox();
  const c = [bb.x + bb.width / 2, bb.y + bb.height / 2];
  await page.mouse.move(5, 5);
  await page.mouse.move(c[0], c[1], { steps: 2 });
  await page.waitForTimeout(600);
  await page.mouse.move(5, 5);
  await page.waitForTimeout(90);
  await page.mouse.move(c[0], c[1], { steps: 2 });
  await page.waitForTimeout(900);
  const held = await page.evaluate(() => document.getElementById('m').querySelector('svg').innerHTML);
  assert.notEqual(held, rest, 'after re-entering during the return, the icon is back at rest while the pointer is over it');
  await page.mouse.move(5, 5);
  await page.waitForTimeout(900);
  assert.equal(await page.evaluate(() => document.getElementById('m').querySelector('svg').innerHTML), rest, 'leaving lets go');
}));

test('4. a name change that joins a running press does not jump', { skip }, () => withBrowser(async (browser) => {
  const { page } = await setup(browser, '<button id="b" style="padding:20px"><morph-icon id="m" name="minus" size="64" press="squash" duration="600"></morph-icon></button>');
  const worst = await page.evaluate(async () => {
    const m = document.getElementById('m'), b = document.getElementById('b');
    let worst = 0;
    for (const to of ['arrow-down', 'plus', 'x']) {
      m.morphTo('minus'); await new Promise((r) => setTimeout(r, 800));
      b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
      await new Promise((r) => setTimeout(r, 90));
      const A = window.polys(m.querySelector('svg'));
      m.setAttribute('name', to); // joins the press that runs
      const B = window.polys(m.querySelector('svg'));
      worst = Math.max(worst, window.dist(A, B));
      await new Promise((r) => setTimeout(r, 800));
    }
    return worst;
  });
  assert.ok(worst < 0.1, 'the first frame of the joined press differs from the interrupted frame by ' + worst.toFixed(2) + ' units');
}));

test('5. a second press during a combined press does not snap from the wrong picture', { skip }, () => withBrowser(async (browser) => {
  const { page } = await setup(browser, '<button id="b"><morph-icon id="m" name="trash" size="64" press="squash" duration="600"></morph-icon></button>');
  const r = await page.evaluate(async () => {
    const m = document.getElementById('m'), out = {};
    m.pressTo('check');
    await new Promise((r) => setTimeout(r, 160));
    let A = window.polys(m.querySelector('svg'));
    m.playPress();
    out.press = window.dist(A, window.polys(m.querySelector('svg')));
    await new Promise((r) => setTimeout(r, 900));
    m.pressTo('check'); await new Promise((r) => setTimeout(r, 900));
    m.pressTo('trash');
    await new Promise((r) => setTimeout(r, 160));
    A = window.polys(m.querySelector('svg'));
    m.pressTo('check');
    out.pressTo = window.dist(A, window.polys(m.querySelector('svg')));
    await new Promise((r) => setTimeout(r, 900));
    out.end = m.getAttribute('name');
    return out;
  });
  assert.ok(r.press < 0.1, 'playPress during a combined press jumped by ' + r.press.toFixed(2));
  assert.ok(r.pressTo < 0.1, 'pressTo during a combined press jumped by ' + r.pressTo.toFixed(2));
  assert.equal(r.end, 'check');
}));
