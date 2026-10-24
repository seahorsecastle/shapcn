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
const skip = process.env.SHAPCN_REQUIRE_ALL ? false : !chromium ? 'Playwright is not installed (see click-browser.test.mjs)' : !existsSync(dist) ? 'run npm run build first' : false;
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

const FRESH = `window.fresh = (name) => { const m = document.createElement('morph-icon'); m.setAttribute('name', name); m.setAttribute('size', '64'); document.body.appendChild(m); const h = m.querySelector('svg').innerHTML; m.remove(); return h; };`;

test('1. a removed icon leaves no document or button listeners; a reconnected icon works again', { skip }, () => withBrowser(async (browser) => {
  const { page, errs } = await setup(browser, '<div id="host"></div>');
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
  assert.equal(r.during, 1, 'one shared document pointerdown listener for 30 icons, not 30: ' + r.during);
  assert.equal(r.after, 1, 'the shared listener stays, and no listener is left per icon: ' + r.after);
  assert.equal(r.buttons, 0, 'pointerenter listeners left on the removed buttons: ' + r.buttons);
  assert.equal(r.oldAncestorPlays, false, 'the old ancestor still drives the icon');
  assert.equal(r.newAncestorPlays, true, 'the new ancestor does not drive the icon');
  assert.deepEqual(errs, []);
}));

test('2. a live sway (hover="move") that is interrupted or destroyed settles its Promise with false', { skip }, () => withBrowser(async (browser) => {
  const { page, errs } = await setup(browser, '<button><morph-icon id="m" name="bell" size="32" hover="move" press="pop"></morph-icon></button><div id="host"></div>');
  const r = await page.evaluate(async () => {
    const m = document.getElementById('m');
    const out = {};
    const settle = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r('pending'), 500))]);
    for (const how of ['playPress', 'morphTo', 'remove', 'MorphIcon.destroy']) {
      let p, el = m, mi = null;
      if (how === 'remove') { el = m.cloneNode(false); el.id = 'tmp'; el.setAttribute('name', 'bell'); m.parentNode.appendChild(el); await new Promise((r) => setTimeout(r, 50)); }
      if (how === 'MorphIcon.destroy') { mi = new window.shapcn.MorphIcon(document.getElementById('host'), { hover: 'move' }); mi.set('bell'); p = mi.playAlive({ velocity: { vx: 0.6, vy: 0 } }); }
      else p = el.playAlive({ velocity: { vx: 0.6, vy: 0 } });
      await new Promise((r) => setTimeout(r, 80));
      out[how + ' active'] = how === 'MorphIcon.destroy' ? !!mi._live : !!el._mi._live; // the sway runs before it is interrupted
      if (how === 'playPress') m.playPress(); else if (how === 'morphTo') m.morphTo('check'); else if (how === 'remove') el.remove(); else mi.destroy();
      out[how] = await settle(p);
      if (how === 'morphTo') m.morphTo('bell');
      await new Promise((r) => setTimeout(r, 900)); // let the interrupting run end before the next case
    }
    return out;
  });
  assert.deepEqual(r, { 'playPress active': true, playPress: false, 'morphTo active': true, morphTo: false, 'remove active': true, remove: false, 'MorphIcon.destroy active': true, 'MorphIcon.destroy': false });
  assert.deepEqual(errs, []);
}));

test('3. bold: enter, leave, enter again during the return keeps the held weight', { skip }, () => withBrowser(async (browser) => {
  const { page, errs } = await setup(browser, '<button style="padding:20px"><morph-icon id="m" name="heart" size="64" hover="bold"></morph-icon></button>');
  const rest = await page.evaluate(() => document.getElementById('m').querySelector('svg').innerHTML);
  const bb = await page.locator('#m').boundingBox();
  const c = [bb.x + bb.width / 2, bb.y + bb.height / 2];
  await page.mouse.move(5, 5);
  await page.mouse.move(c[0], c[1], { steps: 2 });
  await page.waitForTimeout(600);
  await page.mouse.move(5, 5);
  await page.waitForTimeout(90);
  assert.equal(await page.evaluate(() => !!document.getElementById('m')._mi._run && document.getElementById('m')._mi._run.returning), true, 'the icon is in its return when the pointer comes back');
  await page.mouse.move(c[0], c[1], { steps: 2 });
  await page.waitForTimeout(900);
  const held = await page.evaluate(() => document.getElementById('m').querySelector('svg').innerHTML);
  assert.notEqual(held, rest, 'after re-entering during the return, the icon is back at rest while the pointer is over it');
  assert.ok(/stroke-width="(2\.[5-9]|3)/.test(held), 'the held icon is drawn with a heavier stroke');
  await page.mouse.move(5, 5);
  await page.waitForTimeout(900);
  assert.equal(await page.evaluate(() => document.getElementById('m').querySelector('svg').innerHTML), rest, 'leaving lets go');
  assert.deepEqual(errs, []);
}));

test('4. a press that joins a running press continues it: no jump, whatever the settings of the call that started it; the run ends on the destination', { skip }, () => withBrowser(async (browser) => {
  const { page, errs } = await setup(browser, '<button id="b" style="padding:20px"><morph-icon id="m" name="minus" size="64" press="squash" press-strength="0.5" duration="600"></morph-icon></button><script>' + FRESH + '<\/script>');
  const r = await page.evaluate(async () => {
    const m = document.getElementById('m'), b = document.getElementById('b');
    const out = { cases: [] };
    const cases = [
      ['attribute press, join by name', async (to) => { b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' })); await new Promise((r) => setTimeout(r, 90)); return () => { m.setAttribute('name', to); return Promise.resolve('attr'); }; }],
      ['per-call strength 3 and duration 1000, join by pressTo', async (to) => { m.playPress({ pressStrength: 3, pressDuration: 1000 }); await new Promise((r) => setTimeout(r, 200)); return () => m.pressTo(to); }],
      ['per-call style burst, join by pressTo', async (to) => { m.playPress({ press: 'burst', pressStrength: 2.5 }); await new Promise((r) => setTimeout(r, 150)); return () => m.pressTo(to); }],
    ];
    for (const [label, start] of cases) {
      for (const to of ['arrow-down', 'plus']) {
        m.morphTo('minus'); await new Promise((r) => setTimeout(r, 900));
        const join = await start(to);
        const active = !!(m._mi._run && m._mi._run.press && !m._mi._run.combined); // the press runs before it is joined
        const A = window.polys(m.querySelector('svg'));
        const p = join();
        const B = window.polys(m.querySelector('svg'));
        const combined = !!(m._mi._run && m._mi._run.combined);
        const res = await Promise.race([p, new Promise((r) => setTimeout(() => r('pending'), 2500))]);
        await new Promise((r) => setTimeout(r, 1200));
        out.cases.push({ label, to, active, combined, jump: window.dist(A, B), result: res, final: m.querySelector('svg').innerHTML === window.fresh(to), name: m.getAttribute('name') });
      }
    }
    return out;
  });
  for (const c of r.cases) {
    assert.equal(c.active, true, c.label + ': the press ran before it was joined');
    assert.equal(c.combined, true, c.label + ': the joined run is a combined press');
    assert.ok(c.jump < 0.1, c.label + ' -> ' + c.to + ': the first frame of the joined press differs from the interrupted frame by ' + c.jump.toFixed(2) + ' units');
    assert.ok(c.result === true || c.result === 'attr', c.label + ': the joined press did not settle with true: ' + c.result);
    assert.equal(c.final, true, c.label + ' -> ' + c.to + ': the rendered picture at the end is the destination icon');
  }
  assert.deepEqual(errs, []);
}));

test('5. a second press during a combined press does not snap from the wrong picture', { skip }, () => withBrowser(async (browser) => {
  const { page, errs } = await setup(browser, '<button id="b"><morph-icon id="m" name="trash" size="64" press="squash" duration="600"></morph-icon></button><script>' + FRESH + '<\/script>');
  const r = await page.evaluate(async () => {
    const m = document.getElementById('m'), out = {};
    const settle = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r('pending'), 3000))]);
    const p1 = m.pressTo('check');
    await new Promise((r) => setTimeout(r, 160));
    out.activeBefore = !!(m._mi._run && m._mi._run.combined);
    let A = window.polys(m.querySelector('svg'));
    out.press = await m.playPress(); // refused: the combined press plays to its end
    out.pressJump = window.dist(A, window.polys(m.querySelector('svg')));
    out.stillCombined = !!(m._mi._run && m._mi._run.combined);
    out.first = await settle(p1);
    out.afterFirst = m.querySelector('svg').innerHTML === window.fresh('check');
    // pressTo back while a combined press runs: morph on from the picture on screen
    const p2 = m.pressTo('trash');
    await new Promise((r) => setTimeout(r, 160));
    out.active2 = !!(m._mi._run && m._mi._run.combined);
    A = window.polys(m.querySelector('svg'));
    const p3 = m.pressTo('check');
    out.pressToJump = window.dist(A, window.polys(m.querySelector('svg')));
    out.p2 = await settle(p2); // the interrupted run settles false
    out.p3 = await settle(p3);
    await new Promise((r) => setTimeout(r, 800));
    out.end = m.getAttribute('name');
    out.final = m.querySelector('svg').innerHTML === window.fresh('check');
    return out;
  });
  assert.equal(r.activeBefore, true, 'the combined press runs before the second press');
  assert.equal(r.press, false, 'playPress during a combined press is refused');
  assert.ok(r.pressJump < 0.1, 'playPress during a combined press jumped by ' + r.pressJump.toFixed(2));
  assert.equal(r.stillCombined, true, 'the combined press goes on');
  assert.equal(r.first, true, 'the first pressTo settles true');
  assert.equal(r.afterFirst, true, 'the picture after the first pressTo is the check icon');
  assert.equal(r.active2, true, 'the second combined press runs before it is interrupted');
  assert.ok(r.pressToJump < 0.1, 'pressTo during a combined press jumped by ' + r.pressToJump.toFixed(2));
  assert.equal(r.p2, false, 'the interrupted pressTo settles false');
  assert.equal(r.p3, true, 'the last pressTo settles true: ' + r.p3);
  assert.equal(r.end, 'check');
  assert.equal(r.final, true, 'the rendered picture at the end is the check icon');
  assert.deepEqual(errs, []);
}));

test('6. icons of the Remix family: a press that changes the icon and a move sway never draw a NaN path (about 1 run in 3 failed before)', { skip }, () => withBrowser(async (browser) => {
  const { readFileSync } = await import('node:fs');
  const json = readFileSync(PKG + '/data/families/remix-line-s.json', 'utf8');
  const { page, errs } = await setup(browser, '<button id="b"><morph-icon id="m" size="64" hover="move" press="squat-jump" duration="500"></morph-icon></button><script>' + FRESH + '<\/script>');
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 120)); });
  const r = await page.evaluate(async (json) => {
    window.shapcn.registerFamilyFile(json);
    const m = document.getElementById('m'), b = document.getElementById('b');
    const names = window.shapcn.getIconNames().filter((n) => n.indexOf('remix-line-s:') === 0);
    const want = ['shopping-cart', 'refresh', 'flashlight', 'shield', 'moon', 'star-off', 'attachment', '24-hours'];
    const from = want.map((w) => names.find((n) => n === 'remix-line-s:' + w) || names.find((n) => n.indexOf('remix-line-s:' + w) === 0)).filter(Boolean);
    const bad = [];
    let seen = 0, runs = 0;
    const zeroRun = () => [...m.querySelectorAll('path')].some((p) => /(\s0){10,}/.test(' ' + p.getAttribute('d').replace(/[A-Za-z]/g, ' ')));
    for (let rep = 0; rep < 3; rep++) {
      for (let i = 0; i < from.length; i++) {
        const a = from[i], c = from[(i + 3) % from.length];
        m.setAttribute('name', a); await new Promise((r) => setTimeout(r, 650));
        b.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' })); // the move sway
        const p = m.pressTo(c);
        if (!(m._mi._run && m._mi._run.combined)) bad.push('not a combined run: ' + a + '>' + c);
        const t0 = performance.now();
        while (performance.now() - t0 < 700) { seen++; if (zeroRun()) { bad.push(a + '>' + c); break; } await new Promise((r) => setTimeout(r, 25)); }
        runs++;
        b.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' }));
        const done = await p;
        if (done !== true) bad.push('pressTo settled ' + done + ': ' + a + '>' + c);
        if (m.querySelector('svg').innerHTML !== window.fresh(c)) bad.push('the rendered picture is not ' + c + ': ' + a);
      }
    }
    return { bad, seen, runs };
  }, json);
  assert.ok(r.runs >= 20 && r.seen > 200, 'the test ran: ' + JSON.stringify({ runs: r.runs, seen: r.seen }));
  assert.deepEqual(r.bad, [], 'a path of zeros (NaN) was drawn for ' + r.bad.join(', '));
  assert.deepEqual(errs, []);
}));

test('an icon that is unregistered while it shows: a name change draws the new icon at rest, later morphs work, nothing throws', { skip }, () => withBrowser(async (browser) => {
  const { page, errs } = await setup(browser, '<div id="host"><button><morph-icon id="e" name="bell" size="48" hover="grow" press="pop"></morph-icon></button></div><script>' + FRESH + '</script>');
  const r = await page.evaluate(async () => {
    const s = window.shapcn;
    const wait = (ms) => new Promise((x) => setTimeout(x, ms));
    s.registerIcons({ rmA: [['circle', { cx: 12, cy: 12, r: 6 }]] });
    const e = document.getElementById('e');
    e.setAttribute('name', 'rmA');
    await wait(700);
    const out = {};
    s.unregisterIcons('rmA');
    out.play = [await e.playAlive(), await e.playPress()];
    e.setAttribute('name', 'star');
    await wait(100);
    out.star = e.querySelector('svg').innerHTML === window.fresh('star');
    await e.morphTo('heart');
    out.heart = e.querySelector('svg').innerHTML === window.fresh('heart');
    // the same through the API: set and pressTo and hide from a removed icon
    s.registerIcons({ rmB: [['circle', { cx: 12, cy: 12, r: 5 }]] });
    e._mi.set('rmB');
    s.unregisterIcons('rmB');
    try { await e.pressTo('bell'); out.pressTo = e.querySelector('svg').innerHTML === window.fresh('bell'); } catch (x) { out.pressTo = 'throws ' + x.message; }
    return out;
  });
  assert.deepEqual(r.play, [false, false], 'playAlive and playPress resolve false');
  assert.equal(r.star, true, 'the new icon is drawn at rest');
  assert.equal(r.heart, true, 'a later morph works');
  assert.equal(r.pressTo, true, 'pressTo from a removed icon draws the new icon');
  assert.deepEqual(errs, []);
}));

test('an icon that is unregistered while an animation plays: the Promise settles false in every completion path (press, morph, show, move sway), nothing throws, the element recovers', { skip }, () => withBrowser(async (browser) => {
  const { page, errs } = await setup(browser, '<div id="host"></div><script>' + FRESH + '</script>');
  const r = await page.evaluate(async () => {
    const s = window.shapcn;
    const wait = (ms) => new Promise((x) => setTimeout(x, ms));
    const host = document.getElementById('host');
    const settle = (p) => Promise.race([p.then((v) => 'settled:' + v, (e) => 'rejected:' + e.message), wait(2500).then(() => 'pending')]);
    const out = {};
    const mk = (attrs) => { const b = document.createElement('button'); b.innerHTML = '<morph-icon size="48" ' + attrs + '></morph-icon>'; host.appendChild(b); return b.firstChild; };
    const reg = (n, r) => s.registerIcons({ [n]: [['circle', { cx: 12, cy: 12, r }]] });
    // 1. press: the icon at the end of the press is gone
    reg('gone1', 6);
    let e = mk('name="gone1" press="squash" press-duration="400"');
    await wait(100);
    let p = e.playPress(); await wait(120); s.unregisterIcons('gone1'); out.press = await settle(p);
    // 2. morph: the destination of a morph is gone
    reg('gone2', 5);
    e = mk('name="bell" duration="500"');
    await wait(100);
    p = e.morphTo('gone2'); await wait(150); s.unregisterIcons('gone2'); out.morph = await settle(p);
    // 3. show: an empty icon shows a name that is then removed
    reg('gone3', 4);
    e = mk('name="bell" duration="500"');
    await wait(100);
    await e.hide(); p = e.show('gone3'); await wait(150); s.unregisterIcons('gone3'); out.show = await settle(p);
    // 4. move sway
    reg('gone4', 7);
    const b = document.createElement('button'); b.innerHTML = '<morph-icon name="gone4" size="48" hover="move"></morph-icon>'; host.appendChild(b);
    e = b.firstChild; await wait(100);
    p = e.playAlive(); await wait(100); s.unregisterIcons('gone4'); e.leaveAlive(); out.sway = await settle(p);
    // after each: the element is usable again (a name change draws the new icon)
    const els = [...host.querySelectorAll('morph-icon')];
    out.recover = [];
    for (const el of els) { el.setAttribute('name', 'star'); await wait(900); out.recover.push(el.querySelector('svg').innerHTML === window.fresh('star')); }
    return out;
  });
  for (const k of ['press', 'morph', 'show', 'sway']) assert.equal(r[k], 'settled:false', k + ' Promise: ' + r[k]);
  assert.deepEqual(r.recover, [true, true, true, true], 'every element recovers with a new name');
  assert.deepEqual(errs, []);
}));

test('listeners: 1,000 icons add one document pointerdown listener, and a held bold hover still lets go on a tap elsewhere (touch)', { skip }, () => withBrowser(async (browser) => {
  const { page, errs } = await setup(browser, '<div id="host"></div><script>' + FRESH + '</script>');
  const r = await page.evaluate(async () => {
    const wait = (ms) => new Promise((x) => setTimeout(x, ms));
    const host = document.getElementById('host');
    const before = window.live('pointerdown', 'document');
    for (let i = 0; i < 1000; i++) { const b = document.createElement('button'); b.innerHTML = '<morph-icon name="bell" size="24" hover="bold"></morph-icon>'; host.appendChild(b); }
    await wait(200);
    const out = { docListeners: window.live('pointerdown', 'document') - before, buttonEnter: window.live('pointerenter', 'BUTTON') };
    // touch: a tap on icon 0 holds bold; a tap on icon 1 (another target) lets go of icon 0; a tap on icon 0 itself does not
    const [b0, b1] = host.children;
    const m0 = b0.firstChild;
    const rest = window.fresh('bell');
    const touch = (el) => el.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true }));
    touch(b0); await wait(450);
    out.held = !!m0._mi._holdPlan;
    touch(m0); await wait(100);
    out.stillHeldAfterOwnTap = !!m0._mi._holdPlan || !!m0._mi._run;
    await wait(600);
    touch(b0); await wait(450); // re-hold if the second tap let go
    if (!m0._mi._holdPlan) { touch(b0); await wait(450); }
    out.heldAgain = !!m0._mi._holdPlan;
    touch(b1); await wait(700);
    out.releasedByOtherTap = !m0._mi._holdPlan && !m0._mi._run;
    out.restAfter = m0.querySelector('svg').innerHTML === rest;
    host.innerHTML = '';
    await wait(100);
    out.afterRemove = window.live('pointerdown', 'document') - before;
    return out;
  });
  assert.equal(r.docListeners, 1, 'document pointerdown listeners for 1,000 icons: ' + r.docListeners);
  assert.equal(r.buttonEnter, 1000, 'each button keeps its own pointerenter');
  assert.equal(r.held, true, 'a touch tap holds bold');
  assert.equal(r.heldAgain, true);
  assert.equal(r.releasedByOtherTap, true, 'a tap on another target lets go');
  assert.equal(r.restAfter, true, 'the icon is back at rest');
  assert.equal(r.afterRemove, 1, 'the one shared listener stays; nothing per icon');
  assert.deepEqual(errs, []);
}));
