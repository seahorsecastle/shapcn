// Tests for the nine findings of the Sol review (SOL-REVIEW-0.1.0.md). Each test is written to fail on 0.1.0 and pass on 0.1.1.
// Run: node test/findings.mjs                 (the test build of this extension)
//      EXT_DIR=<other extension folder> node test/findings.mjs (for example the old 0.1.0 folder, to see the failures)
import path from 'node:path';
import { boot, sleep, HERE } from './harness.mjs';

import { extDir } from './ext-dir.mjs';
const EXT = extDir(); // the test build (with the test hooks), or EXT_DIR
const H = await boot(EXT);
const { check, group, openPage, setSettings, center, idle, away, url, ctx } = H;
const DEF = { enabled: true, hover: 'grow', click: 'pop', strength: 1.5, offSites: [] };

// Count dark pixels in a clip of the page (the screenshot is decoded in a canvas of a scratch page).
async function ink(P, clip) {
  const buf = await P.page.screenshot({ clip });
  const sp = await ctx.newPage();
  const n = await sp.evaluate(async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let k = 0;
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] < 110 && d[i + 1] < 110 && d[i + 2] < 110 && d[i + 3] > 200) {
        k++;
        sx += (i / 4) % c.width;
        sy += Math.floor(i / 4 / c.width);
      }
    }
    return { n: k, cx: k ? sx / k : 0, cy: k ? sy / k : 0 };
  }, buf.toString('base64'));
  await sp.close();
  return n;
}
const inkN = async (P, clip) => (await ink(P, clip)).n;
// How slow is this machine, seen from the page? A fixed piece of JavaScript is timed (about 3 ms on the machine where the limits were set).
// The time limits of the cost tests are multiplied by max(1, that / 3), so that a slow runner does not fail a test that measures time.
// The counters of those tests (scans, parent reads) do not depend on speed and are not scaled.
async function slowdown(P) {
  const ms = await P.page.evaluate(() => {
    const t0 = performance.now();
    let x = 0;
    for (let i = 0; i < 4e6; i++) x += i % 7;
    return performance.now() - t0 + (x < 0 ? 1 : 0);
  });
  return Math.max(1, ms / 3);
}
const clipAround = (c, r = 20) => ({ x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r });
const hook = (P, expr) => P.iso(`typeof __shapcn.${expr.split('(')[0]} === 'function' ? (${'__shapcn.' + expr}) : 'no hook'`);

try {
  // ------------------------------------------------------------ 1. the page changes another inline style during a run
  group('1 unhide keeps page changes');
  {
    const P = await openPage(url('lucide.html'));
    await setSettings(P, { ...DEF, hover: 'grow', click: 'none' });
    await away(P);
    const c = await center(P, '#heart svg');
    await P.page.mouse.move(c.x, c.y);
    await sleep(120);
    await P.page.evaluate(() => {
      const s = document.querySelector('#heart svg');
      s.style.setProperty('color', 'rgb(200, 0, 0)'); // the page changes unrelated properties while the run plays
      s.style.setProperty('transform', 'rotate(0deg)');
    });
    await P.page.mouse.move(2, 2);
    await idle(P);
    const st = await P.page.evaluate(() => {
      const s = document.querySelector('#heart svg').style;
      return { opacity: s.getPropertyValue('opacity'), transition: s.getPropertyValue('transition'), color: s.getPropertyValue('color'), transform: s.getPropertyValue('transform') };
    });
    check("after the run: opacity and transition are gone, the page's color and transform stay", st.opacity === '' && st.transition === '' && st.color === 'rgb(200, 0, 0)' && st.transform === 'rotate(0deg)', JSON.stringify(st));
    // the page sets its own opacity during the run: that value is not overwritten
    await away(P);
    const c2 = await center(P, '#bell svg');
    await P.page.mouse.move(c2.x, c2.y);
    await sleep(100);
    await P.page.evaluate(() => document.querySelector('#bell svg').style.setProperty('opacity', '0.5'));
    await P.page.mouse.move(2, 2);
    await idle(P);
    const op = await P.page.evaluate(() => document.querySelector('#bell svg').style.getPropertyValue('opacity'));
    check("a value the page sets itself on the same property is kept (opacity 0.5)", op === '0.5', `opacity ${op}`);
    await P.page.close();
  }

  // ------------------------------------------------------------ 2. a throw while a run starts
  group('2 failed start is undone');
  {
    const P = await openPage(url('lucide.html'));
    await setSettings(P, { ...DEF, hover: 'grow', click: 'pop' });
    await P.iso('__shapcn.faults.frame = true; true');
    const before = await P.page.evaluate(() => document.querySelector('#heart svg').outerHTML);
    await away(P);
    const c = await center(P, '#heart svg');
    await P.page.mouse.move(c.x, c.y);
    await sleep(300);
    const mid = await P.page.evaluate(() => ({ svg: document.querySelector('#heart svg').outerHTML, host: !!document.querySelector('[data-shapcn-overlay]') }));
    const info = JSON.parse(await P.iso('JSON.stringify({ active: __shapcn.active(), errors: __shapcn.stats.errors })'));
    check('hover: the original svg is back, no overlay, no run, the error is counted', mid.svg === before && !mid.host && info.active === 0 && info.errors >= 1, `markup equal ${mid.svg === before}, overlay left ${mid.host}, runs ${info.active}, errors ${info.errors}`);
    await P.page.mouse.move(2, 2);
    await P.page.mouse.click(c.x, c.y, { delay: 20 });
    await sleep(300);
    const mid2 = await P.page.evaluate(() => ({ svg: document.querySelector('#heart svg').outerHTML, host: !!document.querySelector('[data-shapcn-overlay]'), clicks: window.clicks.heart }));
    check('click: the same, and the click still reaches the page', mid2.svg === before && !mid2.host && mid2.clicks === 1, `markup equal ${mid2.svg === before}, overlay left ${mid2.host}, page clicks ${mid2.clicks}`);
    await P.iso('__shapcn.faults.frame = false; true');
    await P.page.close();
  }

  // ------------------------------------------------------------ 3. click while the hover run plays
  group('3 press during hover is visible');
  {
    const P = await openPage(url('lucide.html'));
    await setSettings(P, { ...DEF, hover: 'grow', click: 'burst', strength: 1.5 });
    await away(P);
    await idle(P);
    const c = await center(P, '#heart svg');
    const clip = clipAround(c);
    const rest = await inkN(P, clip);
    await P.page.mouse.move(c.x, c.y);
    await sleep(150); // the hover run is still playing (600 ms)
    await P.page.mouse.down();
    await sleep(40);
    const during = await inkN(P, clip);
    await P.page.mouse.up();
    await idle(P);
    check('the press overlay is visible (dark pixels during the press are at least half of the rest)', during >= rest * 0.5, `rest ${rest} px, during the press ${during} px`);
    await P.page.close();
  }

  // ------------------------------------------------------------ 4. hidden artwork stays hidden
  group('4 hidden artwork');
  {
    const P = await openPage(url('hidden-group.html'));
    await setSettings(P, { ...DEF, hover: 'grow', click: 'none', strength: 1 });
    await away(P);
    await idle(P);
    const c = await center(P, '#hid svg');
    const clip = clipAround(c, 26);
    const rest = await inkN(P, clip);
    await P.page.mouse.move(c.x, c.y);
    await sleep(110);
    const during = await inkN(P, clip);
    await P.page.mouse.move(2, 2);
    await idle(P);
    check('hidden groups and hidden shapes stay hidden during a run (ink during <= 2.2 x rest)', during <= rest * 2.2, `rest ${rest} px, during ${during} px`);
    const r = await H.hoverRun(P, '#faded svg', 'faded');
    check('an icon with a faded shape is skipped (no run, markup untouched)', r.frames.length === 0 && r.same, `frames ${r.frames.length}`);
    await P.page.close();
  }

  // ------------------------------------------------------------ 5. held bold
  group('5 held bold');
  {
    const L = await openPage(url('lucide.html'));
    await L.page.evaluate(() => (document.body.style.minHeight = '3000px')); // tall body, so that it can scroll
    await setSettings(L, { ...DEF, hover: 'bold', click: 'none' });
    await away(L);
    const c = await center(L, '#heart svg');
    await L.page.mouse.move(c.x, c.y);
    await sleep(700); // bold takes 250 ms, then it is held
    const f0 = await L.iso('__shapcn.stats.frames');
    await sleep(400);
    const f1 = await L.iso('__shapcn.stats.frames');
    const held = await L.iso('__shapcn.active()');
    check('a held bold run draws no frames while the pointer stays (frames in 400 ms: at most 2)', held === 1 && f1 - f0 <= 2, `runs ${held}, frames in 400 ms ${f1 - f0}`);
    await L.page.evaluate(() => window.scrollBy(0, 40));
    // two animation frames: the scroll event has been handled (the browser's own pointer-leave after a scroll comes later, and ends the run)
    await L.page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const info = await hook(L, 'overlayInfo()');
    const o = Array.isArray(info) ? info[0] : null;
    check('after a scroll the held overlay is still on its icon (within 1 px)', !!o && Math.abs(o.top - o.svgTop) < 1 && Math.abs(o.left - o.svgLeft) < 1, JSON.stringify(info));
    await L.page.mouse.move(2, 2);
    const ended = await idle(L);
    check('leaving the held icon plays it back to rest and ends the run', ended);
    await L.page.close();
  }

  // ------------------------------------------------------------ 6. retention
  group('6 retention');
  {
    const P = await openPage(url('lucide.html'));
    await setSettings(P, { ...DEF, hover: 'bold', click: 'none' });
    // fixed positions, so that removing one button moves no other button under the pointer
    await P.page.evaluate(() => document.querySelectorAll('#bar button').forEach((b, i) => Object.assign(b.style, { position: 'absolute', left: 16 + i * 52 + 'px', top: '16px' })));
    await away(P);
    const c = await center(P, '#heart svg');
    await P.page.mouse.move(c.x, c.y);
    await sleep(600);
    const before = await hook(P, 'sizes()');
    await P.page.evaluate(() => document.getElementById('heart').remove()); // the page removes the hovered button
    await P.page.mouse.move(c.x, c.y + 200, { steps: 3 }); // any pointer move elsewhere (straight down, over no icon)
    await sleep(200);
    const after = await hook(P, 'sizes()');
    const hostGone = await P.page.evaluate(() => !document.querySelector('[data-shapcn-overlay]'));
    check('a removed hovered button leaves no hover record, run or overlay', before.hovered === 1 && after.hovered === 0 && after.runs === 0 && hostGone, `hover records ${before.hovered} -> ${after.hovered}, runs ${after.runs}, overlay removed ${hostGone}`);
    await P.page.evaluate(() => {
      const bar = document.getElementById('bar');
      for (let i = 0; i < 600; i++) {
        const b = document.createElement('button');
        b.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M${2 + (i % 20)} ${3 + Math.floor(i / 20)} L20 ${5 + (i % 7)} L${4 + (i % 9)} 21"/></svg>`;
        bar.appendChild(b);
      }
    });
    await P.iso('__shapcn.scan().length');
    const big = await hook(P, 'sizes()');
    check('the description cache is bounded (600 different icons, cache at most 256)', big.cache <= 256, `cache ${big.cache}, engine registrations ${big.registered}`);
    await P.page.close();
  }

  // ------------------------------------------------------------ 7. reduced motion turned on during a run
  group('7 reduced motion mid-run');
  {
    const P = await openPage(url('lucide.html'));
    await setSettings(P, { ...DEF, hover: 'move', click: 'none' });
    await away(P);
    const c = await center(P, '#heart svg');
    await P.page.mouse.move(c.x, c.y);
    await sleep(250);
    const a0 = await P.iso('__shapcn.active()');
    await P.page.emulateMedia({ reducedMotion: 'reduce' });
    await sleep(250);
    const a1 = await P.iso('__shapcn.active()');
    const hostGone = await P.page.evaluate(() => !document.querySelector('[data-shapcn-overlay]'));
    const svgStyle = await P.page.evaluate(() => document.querySelector('#heart svg').getAttribute('style'));
    const mv = await hook(P, 'moveOn()');
    check('a running "move" run stops at once, the icon comes back, no move listener', a0 === 1 && a1 === 0 && hostGone && svgStyle === null && mv === false, `runs ${a0} -> ${a1}, overlay removed ${hostGone}, svg style ${svgStyle}, move listener on: ${mv}`);
    await P.page.emulateMedia({ reducedMotion: 'no-preference' });
    await sleep(150);
    const mv2 = await hook(P, 'moveOn()');
    check('reduced motion off again: the move listener is back', mv2 === true, String(mv2));
    await setSettings(P, { hover: 'bold' });
    await away(P);
    await P.page.mouse.move(c.x, c.y);
    await sleep(700);
    const held = await P.iso('__shapcn.active()');
    await P.page.emulateMedia({ reducedMotion: 'reduce' });
    await sleep(200);
    const held2 = await P.iso('__shapcn.active()');
    check('a held bold run stops too', held === 1 && held2 === 0, `runs ${held} -> ${held2}`);
    await P.page.close();
  }

  // ------------------------------------------------------------ 8. the strength slider
  group('8 strength slider');
  {
    const pop = await ctx.newPage();
    await pop.goto(`chrome-extension://${H.EXT_ID}/popup.html?host=localhost`);
    await pop.waitForSelector('#hover .cur');
    await pop.evaluate(() => {
      window.__sets = [];
      const orig = chrome.storage.sync.set.bind(chrome.storage.sync);
      chrome.storage.sync.set = (patch, cb) => {
        window.__sets.push(JSON.stringify(patch));
        return orig(patch, cb);
      };
    });
    const box = await pop.locator('#strength').boundingBox();
    const y = box.y + box.height / 2;
    await pop.mouse.move(box.x + 10, y);
    await pop.mouse.down();
    for (let i = 0; i <= 30; i++) {
      await pop.mouse.move(box.x + 10 + ((box.width - 20) * i) / 30, y);
      await sleep(8);
    }
    const midWrites = await pop.evaluate(() => window.__sets.length);
    await pop.mouse.up();
    await sleep(150);
    const writes = await pop.evaluate(() => window.__sets.filter((s) => s.includes('strength')).length);
    const stored = (await pop.evaluate(() => new Promise((r) => chrome.storage.sync.get('strength', r)))).strength;
    const shown = await pop.locator('#sval').textContent();
    check('a drag of 30 moves writes storage at most 2 times, and the end value is saved', writes <= 2 && Math.abs(stored - 3) < 0.15 && Number(shown) === stored, `writes during the drag ${midWrites}, in total ${writes}, stored ${stored}, shown ${shown}`);
    await pop.evaluate(() => {
      chrome.storage.sync.set = () => Promise.reject(new Error('QUOTA_BYTES_PER_ITEM exceeded'));
    });
    await pop.locator('#strength').fill('1.1');
    await sleep(600);
    const msg = await pop.locator('#status').textContent();
    const back = await pop.locator('#strength').inputValue();
    check('a failed write shows a message and shows the stored value again', /Could not save/.test(msg) && Number(back) === stored, `message "${msg}", slider back to ${back}`);
    await pop.close();
  }

  // ------------------------------------------------------------ 9. listbox keyboard
  group('9 listbox keyboard');
  {
    const pop = await ctx.newPage();
    await pop.goto(`chrome-extension://${H.EXT_ID}/popup.html?host=localhost`);
    await pop.waitForSelector('#hover .cur');
    await pop.evaluate(() => new Promise((r) => chrome.storage.sync.clear(r)));
    await pop.reload();
    await pop.waitForSelector('#hover .cur');
    await sleep(200);
    await pop.locator('#hover').focus();
    await pop.keyboard.press('Enter');
    const stops = await pop.locator('#hover-menu .opt[tabindex="0"]').count();
    const val = () => pop.evaluate(() => document.activeElement.dataset.value || document.activeElement.id);
    const v0 = await val();
    await pop.keyboard.press('ArrowDown');
    const v1 = await val();
    await pop.keyboard.press('End');
    const v2 = await val();
    await pop.keyboard.press('Home');
    const v3 = await val();
    await pop.keyboard.press('ArrowUp');
    const v4 = await val();
    check('one tab stop in the list; ArrowDown, End, Home, ArrowUp move the focus', stops === 1 && v0 === 'grow' && v1 === 'bend' && v2 === 'move' && v3 === 'none' && v4 === 'none', `tab stops ${stops}; focus: ${v0}, ${v1}, ${v2}, ${v3}, ${v4}`);
    await pop.keyboard.press('ArrowDown');
    await pop.keyboard.press('ArrowDown');
    await pop.keyboard.press('Enter');
    await sleep(150);
    const chosen = await pop.evaluate(() => new Promise((r) => chrome.storage.sync.get('hover', r)));
    check('Enter on the focused option chooses it, and focus goes back to the button', chosen.hover === 'bend' && (await val()) === 'hover', `stored ${chosen.hover}, focus on ${await val()}`);
    await pop.keyboard.press('Enter');
    await pop.keyboard.press('ArrowDown');
    await pop.keyboard.press('Escape');
    const closed = await pop.evaluate(() => ({ hidden: document.getElementById('hover-menu').hidden, focus: document.activeElement.id }));
    check('Escape closes the list and returns focus to the trigger', closed.hidden && closed.focus === 'hover', JSON.stringify(closed));
    await pop.close();
  }

  // ============================================================ round 2 (review of 0.1.1)
  // ------------------------------------------------------------ A. every transition longhand is restored on its own
  group('A transition longhands');
  {
    const P = await openPage(url('lucide.html'));
    await setSettings(P, { ...DEF, hover: 'grow', click: 'none' });
    for (const [id, style] of [['heart', 'transition-duration:.2s'], ['bell', 'transition-property: color; transition-delay: 50ms; color: rgb(10, 20, 30)']]) {
      await P.page.evaluate(([i, st]) => document.querySelector('#' + i + ' svg').setAttribute('style', st), [id, style]);
      const before = await P.page.evaluate((i) => document.querySelector('#' + i + ' svg').getAttribute('style'), id);
      const r = await H.hoverRun(P, '#' + id + ' svg', id);
      const after = await P.page.evaluate((i) => document.querySelector('#' + i + ' svg').getAttribute('style'), id);
      const props = await P.page.evaluate((i) => { const s = document.querySelector('#' + i + ' svg').style; return ['transition-property', 'transition-duration', 'transition-delay', 'transition-timing-function', 'opacity'].map((p) => p + '=' + s.getPropertyValue(p)).join(' '); }, id);
      check(`svg style="${style}" is the same text after a run`, r.frames.length > 8 && after === before, `before "${before}", after "${after}", longhands: ${props}`);
    }
    await P.page.close();
  }

  // ------------------------------------------------------------ B. a held run follows layout changes and removal
  group('B held run monitoring');
  {
    const P = await openPage(url('lucide.html'));
    await setSettings(P, { ...DEF, hover: 'bold', click: 'none' });
    // fixed positions, so that removing one button moves no other button under the pointer
    await P.page.evaluate(() => document.querySelectorAll('#bar button').forEach((b, i) => Object.assign(b.style, { position: 'absolute', left: 16 + i * 52 + 'px', top: '16px' })));
    await away(P);
    const c = await center(P, '#heart svg');
    await P.page.mouse.move(c.x, c.y);
    await sleep(700);
    await P.page.evaluate(() => (document.getElementById('heart').style.left = '22px')); // the page moves the icon by 6 px (the pointer stays on it), with no scroll or resize
    await sleep(500);
    const info = await hook(P, 'overlayInfo()');
    const o = Array.isArray(info) ? info[0] : null;
    check('after a layout change the held overlay is on the moved icon (within 1 px)', !!o && Math.abs(o.left - o.svgLeft) < 1 && Math.abs(o.top - o.svgTop) < 1, JSON.stringify(info));
    const mon = await hook(P, 'heldMonitor()');
    await P.page.evaluate(() => document.getElementById('heart').remove()); // removed with no pointer event
    await sleep(500);
    const after = await hook(P, 'sizes()');
    const hostGone = await P.page.evaluate(() => !document.querySelector('[data-shapcn-overlay]'));
    const mon2 = await hook(P, 'heldMonitor()');
    check('a held icon removed with no pointer event is cleaned up, and the monitor stops', after.runs === 0 && after.hovered === 0 && hostGone && mon === true && mon2 === false, `runs ${after.runs}, hover records ${after.hovered}, overlay removed ${hostGone}, monitor ${mon} -> ${mon2}`);
    await P.page.close();
  }

  // ------------------------------------------------------------ C. an evicted geometry is never registered again
  group('C registration budget');
  {
    const P = await openPage(url('lucide.html'));
    await setSettings(P, { ...DEF });
    await P.page.evaluate(() => {
      const bar = document.getElementById('bar');
      for (let i = 0; i < 300; i++) {
        const b = document.createElement('button');
        b.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M${2 + (i % 20)} ${3 + Math.floor(i / 20)} L20 ${5 + (i % 7)} L${4 + (i % 9)} 21"/></svg>`;
        bar.appendChild(b);
      }
    });
    const first = JSON.parse(await P.iso('JSON.stringify(__shapcn.scan().length)'));
    const s1 = await hook(P, 'sizes()');
    let last = first;
    for (let i = 0; i < 4; i++) last = JSON.parse(await P.iso('JSON.stringify(__shapcn.scan().length)'));
    const s2 = await hook(P, 'sizes()');
    check('300 different icons scanned 5 times (more than the 256 LRU): registrations do not grow, all stay usable', s2.registered === s1.registered && last === first && s1.registered < 320, `registrations after pass 1: ${s1.registered}, after pass 5: ${s2.registered}, usable icons ${first} then ${last}`);
    await P.page.close();
  }

  // ------------------------------------------------------------ D. save recovery never overwrites a newer edit
  group('D popup save recovery');
  {
    const pop = await ctx.newPage();
    await pop.goto(`chrome-extension://${H.EXT_ID}/popup.html?host=localhost`);
    await pop.waitForSelector('#hover .cur');
    await pop.evaluate(() => new Promise((r) => chrome.storage.sync.clear(r)));
    await pop.reload();
    await pop.waitForSelector('#hover .cur');
    await sleep(200);
    await pop.evaluate(() => {
      const orig = chrome.storage.sync.set.bind(chrome.storage.sync);
      let n = 0;
      chrome.storage.sync.set = (patch, cb) => {
        if ('strength' in patch && n++ === 0) return new Promise((_, rej) => setTimeout(() => rej(new Error('QUOTA')), 400)); // the first save fails, late
        return orig(patch, cb);
      };
    });
    await pop.locator('#strength').fill('2'); // input + change: save 1 (fails at +400 ms)
    await sleep(150);
    await pop.locator('#strength').evaluate((e) => {
      e.value = '2.6';
      e.dispatchEvent(new Event('input', { bubbles: true })); // a newer edit, saved 400 ms later
    });
    await sleep(1100);
    const stored = (await pop.evaluate(() => new Promise((r) => chrome.storage.sync.get('strength', r)))).strength;
    const shown = await pop.locator('#strength').inputValue();
    check('a late failure of an older save does not overwrite a newer edit; the newer value is saved', stored === 2.6 && Number(shown) === 2.6, `stored ${stored}, slider ${shown}`);
    // a failed read is reported
    await pop.evaluate(() => {
      chrome.storage.sync.set = () => Promise.reject(new Error('QUOTA'));
      chrome.storage.sync.get = () => {
        throw new Error('READ BROKEN');
      };
    });
    await pop.locator('#strength').fill('1.2');
    await sleep(500);
    const msg = await pop.locator('#status').textContent();
    check('a failed read after a failed save is shown', /could not read/i.test(msg), `message "${msg}"`);
    await pop.close();
  }

  // ------------------------------------------------------------ E. use elements that draw nothing are skipped
  group('E use element state');
  {
    const P = await openPage(url('use-hidden.html'));
    await setSettings(P, { ...DEF, hover: 'grow', click: 'none' });
    for (const [id, expectRun] of [['u-ok', true], ['u-sym', true], ['u-hidtarget', false], ['u-vishidden', false], ['u-faded', false], ['u-none', false]]) {
      const r = await H.hoverRun(P, '#' + id + ' svg', id);
      check(`<use> case ${id}: ${expectRun ? 'plays' : 'is skipped'}`, expectRun ? r.frames.length >= 8 && r.same : r.frames.length === 0 && r.same, `frames ${r.frames.length}`);
    }
    await P.page.close();
  }

  // ============================================================ round 3 (review of 0.1.2)
  // ------------------------------------------------------------ 1 and 2: <use> targets
  group('R3-1,2 use targets');
  {
    const P = await openPage(url('use-hidden.html'));
    await setSettings(P, { ...DEF, hover: 'grow', click: 'none' });
    for (const [id, expectRun, why] of [
      ['u-hidsvg', false, 'an explicitly hidden <svg> target is rejected'],
      ['u-okvg', true, 'a visible <svg> target plays'],
      ['u-inh', true, 'a visible <use> of a path in a hidden, faint sprite plays (visibility and fill-opacity come from the definition)'],
      ['u-inhsym', true, 'the same through a <symbol>'],
      ['u-ownvis', false, 'a target that sets visibility:hidden itself is rejected'],
    ]) {
      const r = await H.hoverRun(P, '#' + id + ' svg', id);
      check(`${id}: ${why}`, expectRun ? r.frames.length >= 8 && r.same : r.frames.length === 0 && r.same, `frames ${r.frames.length}`);
    }
    await P.page.close();
  }

  // ------------------------------------------------------------ 3: hover records
  group('R3-3 hover records');
  {
    const P = await openPage(url('lucide.html'));
    await setSettings(P, { ...DEF, hover: 'grow', click: 'none' });
    await away(P);
    const c = await center(P, '#heart svg');
    await P.page.mouse.move(c.x, c.y);
    await sleep(200);
    const s0 = await hook(P, 'sizes()');
    // the page replaces the svg inside the (still connected) hovered button
    await P.page.evaluate(() => { const b = document.getElementById('heart'); b.innerHTML = b.innerHTML + ''; });
    await sleep(1500);
    const n1 = await hook(P, 'hoveredSvgs()');
    const s1 = await hook(P, 'sizes()');
    check('a detached svg is pruned from the hover record of a connected host (no pointer event needed)', s0.hovered === 1 && n1 === 0 && s1.hovered === 0, `hover records ${s0.hovered} -> ${s1.hovered}, svgs held ${n1}`);
    await P.page.close();

    const Q = await openPage(url('lucide.html'));
    await setSettings(Q, { ...DEF, hover: 'grow', click: 'none' });
    await away(Q);
    const c2 = await center(Q, '#bell svg');
    await Q.page.mouse.move(c2.x, c2.y);
    await sleep(900); // the grow has ended: no run, only the hover record
    // from here on the content script sees no pointer, scroll or resize event: the page stops them in the capture phase of window
    await Q.page.evaluate(() => { for (const t of ['pointerover', 'pointerout', 'pointermove', 'pointerdown', 'pointercancel', 'scroll', 'resize']) window.addEventListener(t, (e) => e.stopImmediatePropagation(), true); });
    const t0 = await hook(Q, 'idleTimer()');
    await Q.page.evaluate(() => document.getElementById('bell').remove());
    await sleep(1600);
    const s2 = await hook(Q, 'sizes()');
    const t1 = await hook(Q, 'idleTimer()');
    check('a removed hovered host with no run is dropped by the slow idle check, and the timer stops', t0 === true && s2.hovered === 0 && t1 === false, `idle timer ${t0} -> ${t1}, hover records ${s2.hovered}`);
    await Q.page.close();
  }

  // ============================================================ round 4 (defects from the independent tester)
  group('D1 clone during a run');
  {
    const P = await openPage(url('defects.html'));
    await setSettings(P, { ...DEF, hover: 'grow', click: 'none' });
    for (const [id, how] of [['c1', "const s = document.querySelector('#c1 svg'); s.replaceWith(s.cloneNode(true));"], ['c2', "const b = document.getElementById('c2'); b.innerHTML = b.innerHTML;"]]) {
      await away(P);
      await idle(P);
      const c = await center(P, '#' + id + ' svg');
      const rest = await inkN(P, clipAround(c));
      await P.page.mouse.move(c.x, c.y);
      await sleep(120);
      await P.page.evaluate(how); // the page copies the svg while the run plays
      await P.page.mouse.move(2, 2);
      await idle(P);
      await sleep(100);
      const st = await P.page.evaluate((i) => { const s = document.querySelector('#' + i + ' svg'); return { opacity: getComputedStyle(s).opacity, style: s.getAttribute('style') }; }, id);
      const after = await inkN(P, clipAround(await center(P, '#' + id), 20));
      check(`${id}: the copy is visible after the run (opacity 1, ink back, no inline style)`, st.opacity === '1' && st.style === null && after >= rest * 0.8, `opacity ${st.opacity}, style ${st.style}, ink ${rest} at rest, ${after} after`);
    }
    await P.page.close();
  }

  group('D2 CSS transform');
  {
    const P = await openPage(url('defects.html'));
    await setSettings(P, { ...DEF, hover: 'grow', click: 'none', strength: 0.5 });
    await away(P);
    const c = await center(P, '#rot svg');
    const clip = clipAround(c, 16);
    const rest = await ink(P, clip);
    await P.page.mouse.move(c.x, c.y);
    await sleep(110);
    const mid = await ink(P, clip);
    const d = Math.hypot(mid.cx - rest.cx, mid.cy - rest.cy);
    check('a rotated icon keeps its orientation during the run (ink centre moves less than 1.5 px)', d < 1.5, `rest centre ${rest.cx.toFixed(1)},${rest.cy.toFixed(1)}, during ${mid.cx.toFixed(1)},${mid.cy.toFixed(1)}, shift ${d.toFixed(2)} px`);
    await P.page.close();
  }

  group('D3 CSS zoom');
  {
    const P = await openPage(url('defects.html'));
    await setSettings(P, { ...DEF, hover: 'grow', click: 'none', strength: 0.5 });
    await P.page.evaluate(() => (document.documentElement.style.zoom = '1.25'));
    await sleep(100);
    await away(P);
    const c = await center(P, '#zoom svg');
    const clip = clipAround(c, 22);
    const rest = await ink(P, clip);
    await P.page.mouse.move(c.x, c.y);
    await sleep(110);
    const mid = await ink(P, clip);
    const d = Math.hypot(mid.cx - rest.cx, mid.cy - rest.cy);
    check('with html zoom 1.25 the overlay has the icon\'s size and place (ink within 1.35 x, centre within 1.5 px)', mid.n <= rest.n * 1.35 && mid.n >= rest.n * 0.7 && d < 1.5, `ink ${rest.n} -> ${mid.n}, centre shift ${d.toFixed(2)} px`);
    await P.page.close();
  }

  group('D4 non-semantic clickable');
  {
    const P = await openPage(url('defects.html'));
    await setSettings(P, { ...DEF, hover: 'grow', click: 'none' });
    const r = await H.hoverRun(P, '#ptr svg', 'ptr');
    check('an <a> without href (cursor:pointer) around an svg with pointer-events:none animates on hover', r.frames.length >= 8 && r.same, `frames ${r.frames.length}`);
    // the count of scan() is honest: every counted icon really plays when hovered
    const found = JSON.parse(await P.iso('JSON.stringify(__shapcn.scan())'));
    let played = 0;
    for (const f of found) {
      await away(P);
      await idle(P);
      const n0 = await P.iso('__shapcn.stats.runs');
      await P.page.mouse.move(f.x, f.y);
      await sleep(150);
      if ((await P.iso('__shapcn.stats.runs')) > n0) played++;
    }
    check('scan() counts only icons that play (the svg in a 700 px clickable block is not counted)', found.length === played && found.length >= 5, `counted ${found.length}, played ${played}`);
    await P.page.close();
  }

  group('D5 caps and joins');
  {
    const P = await openPage(url('defects.html'));
    await setSettings(P, { ...DEF, hover: 'grow', click: 'none' });
    await away(P);
    const c = await center(P, '#butt svg');
    await P.page.mouse.move(c.x, c.y);
    await sleep(150);
    const a = await hook(P, 'overlayAttrs()');
    const o = Array.isArray(a) ? a[0] : null;
    check('the overlay copies butt caps, miter joins and the miter limit; no path overrides them', !!o && o.cap === 'butt' && o.join === 'miter' && o.miter === '10' && o.pathCaps.every((x) => x === null), JSON.stringify(a));
    await P.page.close();
  }

  // ============================================================ round 5 (review of 0.1.3)
  group('P1 clones during a run');
  {
    const P = await openPage(url('defects2.html'));
    await setSettings(P, { ...DEF, hover: 'grow', click: 'none' });
    // normal run: the page replaces the svg by a copy, and re-serializes another one
    for (const [id, how] of [['k1', "const s = document.querySelector('#k1 svg'); s.replaceWith(s.cloneNode(true));"], ['k2', "const b = document.getElementById('k2'); b.innerHTML = b.innerHTML;"]]) {
      await away(P);
      await idle(P);
      const c = await center(P, '#' + id + ' svg');
      await P.page.mouse.move(c.x, c.y);
      await sleep(120);
      await P.page.evaluate(how);
      const op = await P.page.evaluate((i) => getComputedStyle(document.querySelector('#' + i + ' svg')).opacity, id); // right away, while the run lives
      check(`${id}: the copy is visible at once, while the run plays`, op === '1', `opacity of the copy ${op}`);
      await P.page.mouse.move(2, 2);
      await idle(P);
    }
    // held run (bold): the original stays, the page adds a copy next to it
    await setSettings(P, { hover: 'bold' });
    await away(P);
    const c = await center(P, '#k3 svg');
    await P.page.mouse.move(c.x, c.y);
    await sleep(700);
    await P.page.evaluate(() => { const s = document.querySelector('#k3 svg'); window.__copy = s.cloneNode(true); document.getElementById('k3').appendChild(window.__copy); });
    const ops = await P.page.evaluate(() => [...document.querySelectorAll('#k3 svg')].map((s) => getComputedStyle(s).opacity));
    check('held run: the original is hidden, the copy next to it is visible', ops.length === 2 && ops[0] === '0' && ops[1] === '1', `opacities ${ops.join(', ')}`);
    await P.page.close();
  }

  group('P2 transforms above the overlay');
  {
    const P = await openPage(url('defects2.html'));
    await setSettings(P, { ...DEF, hover: 'grow', click: 'none', strength: 0.5 });
    for (const [label, tf] of [['translateX(40px)', 'translateX(40px)'], ['rotate(7deg)', 'rotate(7deg)'], ['a skew', 'matrix(1, 0.15, 0.1, 1, 12, 0)']]) {
      await P.page.evaluate((t) => (document.documentElement.style.transform = t), tf);
      await sleep(100);
      await away(P);
      const c = await center(P, '#plain svg');
      const clip = clipAround(c, 22);
      const rest = await ink(P, clip);
      await P.page.mouse.move(c.x, c.y);
      await sleep(110);
      const mid = await ink(P, clip);
      const d = Math.hypot(mid.cx - rest.cx, mid.cy - rest.cy);
      check(`html { transform: ${label} }: the overlay is on the icon (centre within 1.5 px, ink within 1.4 x)`, d < 1.5 && mid.n <= rest.n * 1.4 && mid.n >= rest.n * 0.7, `ink ${rest.n} -> ${mid.n}, shift ${d.toFixed(2)} px`);
      await P.page.mouse.move(2, 2);
      await idle(P);
    }
    await P.page.evaluate(() => (document.documentElement.style.transform = 'perspective(400px) rotateY(25deg)'));
    await sleep(100);
    const r = await H.hoverRun(P, '#plain svg', 'plain');
    check('a perspective on the page cannot be corrected: the icon is not animated, nothing is left behind', r.frames.length === 0 && r.same && r.hostGone, `frames ${r.frames.length}`);
    await P.page.close();
  }

  group('P3 symbol viewBox');
  {
    const P = await openPage(url('defects2.html'));
    await setSettings(P, { ...DEF, hover: 'grow', click: 'none', strength: 0.5 });
    for (const id of ['sym48', 'symar']) {
      await away(P);
      const c = await center(P, '#' + id + ' svg');
      const clip = clipAround(c, id === 'symar' ? 30 : 20);
      const rest = await ink(P, clip);
      const runs0 = await P.iso('__shapcn.stats.runs');
      await P.page.mouse.move(c.x, c.y);
      await sleep(110);
      const mid = await ink(P, clip);
      const played = (await P.iso('__shapcn.stats.runs')) > runs0;
      const d = Math.hypot(mid.cx - rest.cx, mid.cy - rest.cy);
      check(`${id}: ${id === 'sym48' ? 'a 48 x 48 symbol in a 24 x 24 svg' : 'a square symbol in a 48 x 24 svg (letterboxed)'} keeps its size and place (ink within 1.4 x, centre within 1.5 px)`, played && mid.n <= rest.n * 1.4 && mid.n >= rest.n * 0.7 && d < 1.5, `run played ${played}, ink ${rest.n} -> ${mid.n}, shift ${d.toFixed(2)} px`);
      await P.page.mouse.move(2, 2);
      await idle(P);
    }
    await P.page.close();
  }

  group('P4 style rules on use targets');
  {
    const P = await openPage(url('defects2.html'));
    await setSettings(P, { ...DEF, hover: 'grow', click: 'none' });
    for (const [id, run, why] of [
      ['u-hv', false, 'a style rule sets visibility:hidden on the target path'],
      ['u-fo', false, 'a style rule sets fill-opacity:.2 on the target path'],
      ['u-hg', false, 'a style rule hides a group inside the symbol'],
      ['u-hgv', true, 'a shape that sets visibility:visible inside that hidden group is drawn'],
    ]) {
      const r = await H.hoverRun(P, '#' + id + ' svg', id);
      check(`${id}: ${why}`, run ? r.frames.length >= 8 && r.same : r.frames.length === 0 && r.same, `frames ${r.frames.length}`);
    }
    await P.page.close();
  }

  group('P5 hiding must work');
  {
    const P = await openPage(url('defects2.html'));
    await setSettings(P, { ...DEF, hover: 'grow', click: 'none' });
    for (const id of ['strong', 'strong2']) {
      const r = await H.hoverRun(P, '#' + id + ' svg', id);
      const info = { roots: await hook(P, 'sheetRoots()') };
      check(`${id}: an author rule keeps the icon visible: no overlay is drawn, everything is rolled back`, r.frames.length === 0 && r.same && r.hostGone && info.roots === 0, `frames ${r.frames.length}, markup equal ${r.same}, overlay removed ${r.hostGone}, sheets ${info.roots}`);
    }
    await P.page.close();
  }

  group('P6 mixed caps');
  {
    const P = await openPage(url('defects2.html'));
    await setSettings(P, { ...DEF, hover: 'grow', click: 'none' });
    const r = await H.hoverRun(P, '#mixed svg', 'mixed');
    check('an icon whose shapes have different caps is skipped (the engine takes one cap)', r.frames.length === 0 && r.same, `frames ${r.frames.length}`);
    await P.page.close();
  }

  group('P7 transactional hide');
  {
    const P = await openPage(url('defects2.html'));
    await setSettings(P, { ...DEF, hover: 'grow', click: 'none' });
    await P.iso('__shapcn.faults.hide = true; true');
    const before = await P.page.evaluate(() => document.querySelector('#k1 svg').outerHTML);
    await away(P);
    const c = await center(P, '#k1 svg');
    await P.page.mouse.move(c.x, c.y);
    await sleep(300);
    const after = await P.page.evaluate(() => ({ svg: document.querySelector('#k1 svg').outerHTML, host: !!document.querySelector('[data-shapcn-overlay]') }));
    const info = { roots: await hook(P, 'sheetRoots()'), runs: await P.iso('__shapcn.active()'), errors: await P.iso('__shapcn.stats.errors') };
    check('a throw inside hide() leaves no attribute, no rule, no sheet, no overlay', after.svg === before && !after.host && info.roots === 0 && info.runs === 0 && info.errors >= 1, `markup equal ${after.svg === before}, overlay ${after.host}, sheets ${info.roots}, runs ${info.runs}, errors ${info.errors}`);
    await P.iso('__shapcn.faults.hide = false; true');
    await P.page.close();
  }

  // ============================================================ round 6 (review of 0.1.4)
  group('Q1 observer cost');
  {
    const P = await openPage(url('defects2.html'));
    await setSettings(P, { ...DEF, hover: 'bold', click: 'none' });
    await away(P);
    const c = await center(P, '#k3 svg');
    await P.page.mouse.move(c.x, c.y);
    await sleep(700); // held: the observer is on
    const slow = await slowdown(P);
    const sc0 = await P.iso('__shapcn.stats.scanned');
    const t = await P.page.evaluate(async () => {
      const t0 = performance.now();
      const top = document.createElement('div');
      top.style.display = 'none'; // no layout for the chain (a deep chain would overflow the layout stack)
      document.body.appendChild(top);
      let p = top;
      for (let i = 0; i < 3000; i++) { const d = document.createElement('div'); p.appendChild(d); p = d; } // 3,000 nested insertions in one task
      const t1 = performance.now();
      await new Promise((r) => setTimeout(r, 0)); // every microtask, the observer callback among them, has run after this
      const t2 = performance.now();
      return { build: t1 - t0, observer: t2 - t1 };
    });
    const scans = (await P.iso('__shapcn.stats.scanned')) - sc0;
    check('3,000 nested insertions in one task: one subtree scan, not 3,000 (and the delivery takes under 15 ms)', t.observer < 15 * slow && scans <= 2, `machine ${slow.toFixed(1)}x slower than the reference, limit ${(15 * slow).toFixed(0)} ms, subtree scans ${scans}, build ${t.build.toFixed(1)} ms, observer ${t.observer.toFixed(1)} ms`);
    await P.page.close();
  }

  group('Q2 style rules cost');
  {
    const P = await openPage(url('defects2.html'));
    await setSettings(P, { ...DEF, hover: 'none', click: 'pop' });
    await P.page.evaluate(() => {
      let css = '';
      for (let i = 0; i < 20000; i++) css += `.zz${i}{color:rgb(${i % 255},0,0);margin:${i % 7}px}\n`;
      css += '.zzv{visibility:visible}\n';
      const st = document.createElement('style');
      st.textContent = css;
      document.head.appendChild(st);
    });
    await sleep(300);
    // warm-up: one press on an ordinary icon (the first call of any code is slow in a cold page)
    await P.page.evaluate(() => document.getElementById('k1').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })));
    await sleep(500);
    const slow = await slowdown(P);
    const runs0 = await P.iso('__shapcn.stats.runs');
    const times = [];
    for (let i = 0; i < 3; i++) {
      const t = await P.page.evaluate(() => {
        const b = document.getElementById('u-hgv');
        const t0 = performance.now();
        b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
        return performance.now() - t0;
      });
      times.push(t);
      await sleep(100);
    }
    const runs = (await P.iso('__shapcn.stats.runs')) - runs0;
    check('a pointerdown on a <use> icon on a page with 20,000 rules takes under 5 ms (3 tries), and the icon is skipped', Math.max(...times) < 5 * slow && runs === 0, `machine ${slow.toFixed(1)}x slower than the reference, limit ${(5 * slow).toFixed(0)} ms, times ${times.map((x) => x.toFixed(2)).join(', ')} ms, runs ${runs}`);
    await P.page.close();
  }

  group('Q3 use lengths');
  {
    const P = await openPage(url('use-len.html'));
    await setSettings(P, { ...DEF, hover: 'grow', click: 'none' });
    for (const [id, run] of [['l-px', true], ['l-num', true], ['l-pct', false], ['l-em', false], ['l-xpct', false]]) {
      const r = await H.hoverRun(P, '#' + id + ' svg', id);
      check(`${id}: ${run ? 'plain number or px: plays' : 'percent or other unit: skipped'}`, run ? r.frames.length >= 8 && r.same : r.frames.length === 0 && r.same, `frames ${r.frames.length}`);
    }
    await P.page.close();
  }

  group('Q4 marker copied by attribute');
  {
    const P = await openPage(url('defects2.html'));
    await setSettings(P, { ...DEF, hover: 'bold', click: 'none' });
    await away(P);
    const c = await center(P, '#k1 svg');
    await P.page.mouse.move(c.x, c.y);
    await sleep(700);
    const ops = await P.page.evaluate(async () => {
      const id = document.querySelector('#k1 svg').getAttribute('data-shapcn-run');
      const other = document.querySelector('#k2 svg');
      other.setAttribute('data-shapcn-run', id); // the page copies the attribute onto another svg
      await new Promise((r) => queueMicrotask(r));
      return { id, other: getComputedStyle(other).opacity, original: getComputedStyle(document.querySelector('#k1 svg')).opacity };
    });
    check('a marker patched onto another svg is removed at once; the original stays hidden', ops.other === '1' && ops.original === '0', `copy ${ops.other}, original ${ops.original}`);
    await P.page.close();
  }

  group('Q5 unreadable style sheets');
  {
    const P = await openPage(url('use-xo.html'));
    await setSettings(P, { ...DEF, hover: 'grow', click: 'none' });
    await P.page.evaluate((href) => new Promise((res) => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href; l.onload = res; l.onerror = res; document.head.appendChild(l); }), `http://127.0.0.1:${H.PORT}/x.css`);
    await sleep(200);
    const a = await H.hoverRun(P, '#xo-plain svg', 'xo-plain');
    check('another-origin style sheet present: a <use> icon that only a sheet could settle is skipped', a.frames.length === 0 && a.same, `frames ${a.frames.length}`);
    const b = await H.hoverRun(P, '#xo-settled svg', 'xo-settled');
    check('the same page: a <use> target that declares the three values inline plays', b.frames.length >= 8 && b.same, `frames ${b.frames.length}`);
    await P.page.close();
  }

  group('Q6 rollback of a failed adoption');
  {
    const P = await openPage(url('defects2.html'));
    await setSettings(P, { ...DEF, hover: 'grow', click: 'none' });
    await P.iso('__shapcn.faults.adopt = true; true');
    const before = await P.page.evaluate(() => document.querySelector('#k1 svg').outerHTML);
    await away(P);
    const c = await center(P, '#k1 svg');
    await P.page.mouse.move(c.x, c.y);
    await sleep(300);
    const after = await P.page.evaluate(() => ({ svg: document.querySelector('#k1 svg').outerHTML, host: !!document.querySelector('[data-shapcn-overlay]') }));
    const roots = await hook(P, 'sheetRoots()');
    const errs = await P.iso('__shapcn.stats.errors');
    check('adoption fails again during the rollback: no sheet record is left, no overlay, the error is counted', after.svg === before && !after.host && roots === 0 && errs >= 1, `markup equal ${after.svg === before}, sheet records ${roots}, errors ${errs}`);
    await P.iso('__shapcn.faults.adopt = false; true');
    const r = await H.hoverRun(P, '#k2 svg', 'k2');
    check('with the fault gone the next hover plays', r.frames.length >= 8 && r.same, `frames ${r.frames.length}`);
    await P.page.close();
  }

  // ============================================================ round 7 (review of 0.1.5)
  group('S1 a style sheet that changes');
  {
    const P = await openPage(url('use-restyle.html'));
    await setSettings(P, { ...DEF, hover: 'grow', click: 'none' });
    const a = await H.hoverRun(P, '#rs svg', 'rs');
    check('before the change: the <use> icon plays', a.frames.length >= 8 && a.same, `frames ${a.frames.length}`);
    // the page replaces the sheet's text with ONE rule again (same number of sheets, same number of rules) that now hides the path
    await P.page.evaluate(() => { document.getElementById('st').textContent = '.a{visibility:hidden}'; });
    const rules = await P.page.evaluate(() => document.getElementById('st').sheet.cssRules.length);
    const b = await H.hoverRun(P, '#rs svg', 'rs');
    check('after a same-count replacement that hides the path: the icon is skipped, the page\'s hidden artwork is not revealed', rules === 1 && b.frames.length === 0 && b.same, `rules ${rules}, frames ${b.frames.length}`);
    await P.page.close();
  }

  group('S2 observer ancestor reads');
  {
    const P = await openPage(url('defects2.html'));
    await setSettings(P, { ...DEF, hover: 'bold', click: 'none' });
    await away(P);
    const c = await center(P, '#k3 svg');
    await P.page.mouse.move(c.x, c.y);
    await sleep(700); // held: the observer is on
    // task 1: a chain of 512 nested elements, hidden (no layout). The observer delivers it and is done with it.
    await P.page.evaluate(() => {
      const top = document.createElement('div');
      top.id = 'deep';
      top.style.display = 'none';
      document.body.appendChild(top);
      let p = top;
      for (let i = 0; i < 511; i++) { const d = document.createElement('div'); p.appendChild(d); p = d; }
      window.__deepest = p;
    });
    await sleep(100);
    const slow = await slowdown(P);
    const r0 = await P.iso('__shapcn.stats.parentReads');
    // task 2: 20,000 leaves under the deepest element
    const t = await P.page.evaluate(async () => {
      const t0 = performance.now();
      for (let i = 0; i < 20000; i++) window.__deepest.appendChild(document.createElement('span'));
      const t1 = performance.now();
      await new Promise((r) => setTimeout(r, 0));
      return { build: t1 - t0, observer: performance.now() - t1 };
    });
    const reads = (await P.iso('__shapcn.stats.parentReads')) - r0;
    check('20,000 leaves under 512 ancestors: parent reads are about nodes + depth (under 60,000), delivery under 40 ms (0.1.5 needs about 275 ms)', reads < 60000 && t.observer < 40 * slow, `machine ${slow.toFixed(1)}x slower than the reference, limit ${(40 * slow).toFixed(0)} ms, parent reads ${reads}, build ${t.build.toFixed(1)} ms, observer ${t.observer.toFixed(1)} ms`);
    await P.page.close();
  }

  // ============================================================ wiggle is retired (owner, 0.1.7)
  group('W wiggle retired');
  {
    // a fresh install: the default hover style is grow
    const P = await openPage(url('lucide.html'));
    await P.iso('new Promise((r) => chrome.storage.sync.clear(r))');
    await sleep(300);
    await P.page.reload();
    await sleep(600);
    if (!process.env.SHAPCN_REAL_TIME) await P.iso('__shapcn.clockStart(40)'); // a reload gives the page a new content script: start its clock again
    const def = await P.iso('__shapcn.settings.hover');
    check('default hover style is grow', def === 'grow', String(def));
    // settings saved by an older version say wiggle: the page plays grow
    await P.iso("new Promise((r) => chrome.storage.sync.set({ enabled: true, hover: 'wiggle', click: 'none', strength: 1.5, offSites: [] }, r))");
    await sleep(400);
    const mig = await P.iso('__shapcn.settings.hover');
    const r = await H.hoverRun(P, '#heart svg', 'heart');
    check("a stored 'wiggle' plays as grow", mig === 'grow' && r.frames.length >= 8 && r.styles.join() === 'grow', `settings.hover ${mig}, frames ${r.frames.length}, style ${r.styles.join('/')}`);
    await P.page.close();
    // the popup shows Grow, offers no wiggle, and saves the migration
    const pop = await ctx.newPage();
    await pop.goto(`chrome-extension://${H.EXT_ID}/popup.html?host=localhost`);
    await pop.waitForSelector('#hover .cur');
    await sleep(500);
    const cur = await pop.locator('#hover .cur').textContent();
    const saved = (await pop.evaluate(() => new Promise((r) => chrome.storage.sync.get('hover', r)))).hover;
    await pop.locator('#hover').click();
    const values = await pop.locator('#hover-menu .opt').evaluateAll((els) => els.map((e) => e.dataset.value));
    check("popup: stored wiggle shows as Grow and is saved as 'grow'; the menu has no wiggle", cur === 'Grow' && saved === 'grow' && !values.includes('wiggle') && values.join() === 'none,grow,bend,bold,cascade,move', `shown ${cur}, saved ${saved}, menu ${values.join()}`);
    await pop.close();
  }
} finally {
  const pass = H.results.filter((r) => r.ok).length;
  console.log(`\nFINDINGS ${pass} of ${H.results.length} checks passed (extension: ${EXT})`);
  await H.close();
  process.exitCode = pass === H.results.length ? 0 : 1;
}
