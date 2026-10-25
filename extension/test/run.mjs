// Playwright test for "shapcn everywhere". Launches the system Google Chrome (new headless mode) and loads the unpacked extension.
// Branded Chrome 137 and newer ignores --load-extension, so the extension is loaded through the CDP method Extensions.loadUnpacked
// (needs --enable-unsafe-extension-debugging). Chrome runs in its own temporary profile. No tab of the owner is touched.
// Run: node test/run.mjs [--no-web]
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { createRequire } from 'node:module';
import { chromePath, ciArgs } from './chrome.mjs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
import { extDir, PROD } from './ext-dir.mjs';
const EXT = extDir(); // the test build (with the test hooks), or EXT_DIR
const req = createRequire(path.join(process.env.PLAYWRIGHT_DIR || EXT, 'x.js'));
const { chromium } = req('playwright');
const CHROME = chromePath();
const WEB = !process.argv.includes('--no-web') && !process.env.CI; // the tests that open real public sites are skipped with --no-web, and in CI
fs.mkdirSync(path.join(HERE, 'out'), { recursive: true });

const results = [];
let currentGroup = '';
function check(name, ok, detail = '') {
  results.push({ group: currentGroup, name, ok: !!ok, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + currentGroup + ' | ' + name + (detail ? ' | ' + detail : ''));
}
const group = (g) => {
  currentGroup = g;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- static server (fixtures)
const FIX = path.join(HERE, 'fixtures');
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };
const requested = [];
const server = http.createServer((q, r) => {
  const name = q.url.split('?')[0].replace(/^\/+/, '') || 'x-like.html';
  requested.push(name);
  const f = path.join(FIX, name);
  if (!f.startsWith(FIX) || !fs.existsSync(f)) {
    r.statusCode = 404;
    r.end('');
    return;
  }
  const h = { 'Content-Type': (TYPES[path.extname(f)] || 'text/plain') + '; charset=utf-8' };
  if (name === 'csp.html') h['Content-Security-Policy'] = "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:";
  r.writeHead(200, h);
  r.end(fs.readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const url = (n) => `http://localhost:${PORT}/${n}`;

// ---------------------------------------------------------------- Chrome
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shapcn-ext-'));
const chrome = cp.spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check', '--window-size=1000,800', ...ciArgs(), 'about:blank'], { stdio: 'ignore' });
let wsPort = null;
for (let i = 0; i < 100 && !wsPort; i++) {
  await sleep(100);
  try {
    wsPort = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
  } catch (e) {
    // not yet
  }
}
if (!wsPort) throw new Error('Chrome did not start');
const browser = await chromium.connectOverCDP('http://127.0.0.1:' + wsPort);
const bcdp = await browser.newBrowserCDPSession();
const { id: EXT_ID } = await bcdp.send('Extensions.loadUnpacked', { path: EXT });
const ctx = browser.contexts()[0];
// THROTTLE=6 slows the CPU of every page 6 times (a slow shared CI runner without a GPU). Use it to look for tests that depend on speed.
const THROTTLE = Number(process.env.THROTTLE || 0);
if (THROTTLE > 1) ctx.on('page', (p) => ctx.newCDPSession(p).then((s) => s.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE })).catch(() => {}));
const version = browser.version();
console.log('Chrome', version, 'extension id', EXT_ID, 'fixtures on port', PORT);

const pageErrors = []; // { url, text, ours }
const consoleErrors = [];
const reqHosts = new Set();

async function openPage(u, opts = {}) {
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1000, height: 800 });
  const cdp = await ctx.newCDPSession(page);
  const world = { id: null };
  cdp.on('Runtime.executionContextCreated', ({ context }) => {
    if (context.auxData && context.auxData.type === 'isolated' && String(context.origin).startsWith('chrome-extension://' + EXT_ID)) world.id = context.id;
  });
  cdp.on('Runtime.executionContextsCleared', () => {
    world.id = null;
  });
  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails: d }) => {
    const text = (d.exception && d.exception.description) || d.text;
    pageErrors.push({ page: u, text, ours: String(d.url || '').startsWith('chrome-extension://') || /chrome-extension:\/\//.test(text || '') });
  });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const loc = m.location() || {};
    if (/favicon\.ico/.test(loc.url || '') || /favicon/.test(m.text())) return;
    consoleErrors.push({ page: u, text: m.text(), url: loc.url, ours: String(loc.url || '').startsWith('chrome-extension://') });
  });
  page.on('request', (r) => reqHosts.add(new URL(r.url()).host));
  await cdp.send('Runtime.enable');
  await page.goto(u, { waitUntil: opts.waitUntil || 'load', timeout: 45000 });
  for (let i = 0; i < 100 && world.id === null && !opts.noScript; i++) await sleep(50);
  const iso = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, contextId: world.id, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('iso: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description));
    return r.result.value;
  };
  // The test build has a logical clock: no step of time longer than 40 ms, so a slow machine still draws enough frames of each run
  // (see clock in src/content.js). SHAPCN_REAL_TIME=1 turns it off.
  if (!opts.noScript && !process.env.SHAPCN_REAL_TIME) await iso("typeof __shapcn !== 'undefined' && __shapcn.clockStart(40)").catch(() => {});
  return { page, iso, world, cdp };
}

async function setSettings(P, patch) {
  await P.iso(`new Promise(r => chrome.storage.sync.set(${JSON.stringify(patch)}, r))`);
  for (let i = 0; i < 40; i++) {
    const ok = await P.iso(`(() => { const s = __shapcn.settings; const p = ${JSON.stringify(patch)}; return Object.keys(p).every(k => JSON.stringify(s[k]) === JSON.stringify(p[k])); })()`);
    if (ok) return;
    await sleep(25);
  }
  throw new Error('settings did not arrive');
}

// page-side helpers
const SNAP = `(() => [...document.querySelectorAll('body *')].filter(e => !e.hasAttribute('data-shapcn-overlay')).map(e => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(v => Math.round(v * 100) / 100).join(','); }).join(';'))()`;
const SVGS = `JSON.stringify([...document.querySelectorAll('svg')].map(s => s.outerHTML))`;

async function center(P, sel) {
  // A page that re-renders (the React-style fixture) can replace the node between two calls: try again a few times.
  let b = null;
  for (let i = 0; i < 8 && !b; i++) {
    b = await P.page.locator(sel).first().boundingBox();
    if (!b) await sleep(25);
  }
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}
async function idle(P, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if ((await P.iso('__shapcn.active()')) === 0) return true;
    await sleep(40);
  }
  return false;
}
async function away(P) {
  await P.page.mouse.move(2, 2);
  await sleep(60);
}

// A monitor in the page: for `ms`, each animation frame, compare layout, hit target and look for the overlay host.
async function startMonitor(P, cx, cy) {
  await P.page.evaluate(
    ({ cx, cy }) => {
      const snap = () => [...document.querySelectorAll('body *')].filter((e) => !e.hasAttribute('data-shapcn-overlay')).map((e) => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 100) / 100).join(','); }).join(';');
      const idOf = (el) => (el ? (el.id || el.tagName) + '' : '');
      const base = snap();
      const top = idOf(document.elementFromPoint(cx, cy));
      const m = { frames: 0, moved: 0, topChanged: 0, hostSeen: 0, running: true };
      window.__mon = m;
      (function f() {
        if (!m.running) return;
        m.frames++;
        if (snap() !== base) m.moved++;
        if (idOf(document.elementFromPoint(cx, cy)) !== top) m.topChanged++;
        if (document.querySelector('[data-shapcn-overlay]')) m.hostSeen++;
        requestAnimationFrame(f);
      })();
    },
    { cx, cy }
  );
}
async function stopMonitor(P) {
  return P.page.evaluate(() => {
    window.__mon.running = false;
    return window.__mon;
  });
}

const uniq = (a) => new Set(a).size;
async function traceFor(P, id) {
  const all = await P.iso('JSON.stringify(__shapcn.trace.frames)');
  return JSON.parse(all).filter((f) => f.id === id);
}

// One hover run on an icon. Returns what was seen.
async function hoverRun(P, sel, id, holdMs = 900) {
  await away(P);
  await idle(P);
  await P.iso('__shapcn.trace.frames.length = 0; __shapcn.trace.on = true; true');
  const before = { svgs: await P.page.evaluate(SVGS), snap: await P.page.evaluate(SNAP) };
  const c = await center(P, sel);
  await startMonitor(P, c.x, c.y);
  await P.page.mouse.move(c.x, c.y);
  await sleep(holdMs);
  await P.page.mouse.move(2, 2);
  const ended = await idle(P);
  await sleep(60);
  const mon = await stopMonitor(P);
  const after = { svgs: await P.page.evaluate(SVGS), snap: await P.page.evaluate(SNAP) };
  const frames = await traceFor(P, id);
  const hostGone = await P.page.evaluate(() => !document.querySelector('[data-shapcn-overlay]'));
  await P.iso('__shapcn.trace.on = false; true');
  return { frames, distinct: uniq(frames.map((f) => f.h)), styles: [...new Set(frames.map((f) => f.style))], kinds: [...new Set(frames.map((f) => f.rk))], same: before.svgs === after.svgs, snapSame: before.snap === after.snap, mon, ended, hostGone };
}

// ---------------------------------------------------------------- the fixtures
const FIXTURES = [
  { file: 'x-like.html', icons: [['#reply svg', 'reply'], ['#repost svg', 'repost'], ['#like svg', 'like'], ['#bookmark svg', 'bookmark'], ['#share svg', 'share'], ['#n-home svg', 'n-home'], ['#n-bell svg', 'n-bell']], clickIds: ['reply', 'repost', 'like', 'bookmark', 'share', 'n-home', 'n-bell'], click: (id) => '#' + id },
  { file: 'github-like.html', icons: [['#logo svg', 'logo'], ['#search svg', 'search'], ['#plus svg', 'plus'], ['#bell svg', 'bell']], clickIds: ['logo', 'search', 'plus', 'bell'], click: (id) => '#' + id },
  { file: 'lucide.html', icons: ['heart', 'bell', 'bookmark', 'settings', 'search', 'plus', 'star', 'styled'].map((n) => ['#' + n + ' svg', n]), clickIds: ['heart', 'bell', 'bookmark', 'settings', 'search', 'plus', 'star', 'styled'], click: (id) => '#' + id },
];

const DEFAULT_SET = { enabled: true, hover: 'grow', click: 'pop', strength: 1.5, offSites: [] };

try {
  // ============================================================ A. hover on every fixture icon
  for (const fx of FIXTURES) {
    group('hover ' + fx.file);
    const P = await openPage(url(fx.file));
    await setSettings(P, { ...DEFAULT_SET, click: 'none' });
    for (const [sel, id] of fx.icons) {
      const r = await hoverRun(P, sel, id);
      // frames are keyed by the svg id or its parent id: map to the parent button id used in the fixtures
      const f = r.frames.length ? r.frames : (await traceFor(P, id));
      check(`${id}: hover animates`, r.frames.length >= 8 && r.distinct >= 4, `frames ${r.frames.length}, distinct pictures ${r.distinct}, kind ${r.kinds.join('/')}, style ${r.styles.join('/')}`);
      check(`${id}: original svg markup restored exactly`, r.same && r.ended && r.hostGone, `markup equal ${r.same}, run ended ${r.ended}, overlay removed ${r.hostGone}`);
      check(`${id}: layout boxes never moved, hit target unchanged`, r.mon.moved === 0 && r.mon.topChanged === 0, `checked ${r.mon.frames} frames, overlay on screen in ${r.mon.hostSeen}, layout changes ${r.mon.moved}, hit-target changes ${r.mon.topChanged}`);
    }
    await P.page.close();
  }
  // ============================================================ B. click on every fixture icon
  for (const fx of FIXTURES) {
    group('click ' + fx.file);
    const P = await openPage(url(fx.file));
    await setSettings(P, { ...DEFAULT_SET, hover: 'none', click: 'pop' });
    for (const id of fx.clickIds) {
      await away(P);
      await idle(P);
      const sel = fx.click(id);
      const c = await center(P, sel + ' svg');
      await P.iso('__shapcn.trace.frames.length = 0; __shapcn.trace.on = true; true');
      const n0 = (await P.page.evaluate((i) => (window.clicks && window.clicks[i]) || 0, id));
      for (let i = 0; i < 5; i++) {
        await P.page.mouse.click(c.x, c.y, { delay: 30 });
        await sleep(i % 2 ? 0 : 140);
      }
      const n1 = await P.page.evaluate((i) => (window.clicks && window.clicks[i]) || 0, id);
      const frames = (await P.iso('JSON.stringify(__shapcn.trace.frames)')); const fr = JSON.parse(frames).filter((f) => f.kind === 'press');
      const ended = await idle(P);
      const same = await P.page.evaluate(SVGS);
      check(`${id}: 5 of 5 clicks reach the page handler, pop plays`, n1 - n0 === 5 && fr.length >= 8, `handler count ${n1 - n0}/5, press frames ${fr.length}`);
      await P.iso('__shapcn.trace.on = false; true');
      void ended;
      void same;
    }
    await P.page.close();
  }
  // ============================================================ C. all hover styles and click styles, filled and stroke icons
  group('styles');
  {
    const P = await openPage(url('x-like.html'));
    const L = await openPage(url('lucide.html'));
    const HOVER = ['grow', 'bend', 'bold', 'cascade', 'move']; // wiggle is retired: it is not in the popup
    const PRESS = ['pop', 'squash', 'squat-jump', 'burst'];
    const fallbacks = {};
    for (const [Pg, sel, id, label] of [[P, '#like svg', 'like', 'fill: like'], [P, '#reply svg', 'reply', 'fill: reply (has a hole)'], [P, '#share svg', 'share', 'fill: share (two parts)'], [L, '#heart svg', 'heart', 'stroke: heart']]) {
      await setSettings(Pg, { ...DEFAULT_SET, click: 'none' });
      for (const st of HOVER) {
        await setSettings(Pg, { hover: st });
        const r = await hoverRun(Pg, sel, id, st === 'bold' ? 700 : 1000);
        const eff = r.styles.join('/');
        if (eff !== st) fallbacks[`${label} ${st}`] = eff;
        check(`${label}: hover ${st} plays (${eff})`, r.frames.length >= 6 && r.distinct >= 3 && r.same && r.hostGone && r.mon.moved === 0, `frames ${r.frames.length}, distinct ${r.distinct}`);
      }
      await setSettings(Pg, { hover: 'none' });
      for (const st of PRESS) {
        await setSettings(Pg, { click: st });
        await away(Pg);
        await idle(Pg);
        await Pg.iso('__shapcn.trace.frames.length = 0; __shapcn.trace.on = true; true');
        const c = await center(Pg, sel);
        await Pg.page.mouse.click(c.x, c.y, { delay: 30 });
        await idle(Pg);
        const fr = await traceFor(Pg, id);
        await Pg.iso('__shapcn.trace.on = false; true');
        const same = await Pg.page.evaluate(SVGS);
        const ok = fr.length >= 6 && uniq(fr.map((f) => f.h)) >= 3;
        check(`${label}: click ${st} plays`, ok, `frames ${fr.length}, distinct ${uniq(fr.map((f) => f.h))}`);
        void same;
      }
    }
    console.log('Fallbacks used for fill icons:', JSON.stringify(fallbacks));
    results.push({ group: 'styles', name: 'fallbacks', ok: true, detail: JSON.stringify(fallbacks) });
    await P.page.close();
    await L.page.close();
  }
  // ============================================================ D. React-like page (the page replaces the icon during the run)
  group('react-like');
  {
    const P = await openPage(url('react-like.html'));
    await setSettings(P, { ...DEFAULT_SET, hover: 'grow', click: 'pop' });
    await away(P);
    const r0 = await P.page.evaluate(() => window.renders);
    const c = await center(P, '#like svg');
    await P.page.mouse.move(c.x, c.y);
    await sleep(900);
    await P.page.mouse.move(2, 2);
    const ended = await idle(P);
    const r1 = await P.page.evaluate(() => window.renders);
    const hostGone = await P.page.evaluate(() => !document.querySelector('[data-shapcn-overlay]'));
    check('hover while the page re-renders: the run stops, no leftover overlay', ended && hostGone && r1 > r0, `renders ${r0} to ${r1}, run ended ${ended}, overlay removed ${hostGone}`);
    const svgStyle = await P.page.evaluate(() => [...document.querySelectorAll('svg')].map((s) => s.getAttribute('style')));
    check('no stray style on the new svgs', svgStyle.every((s) => s === null), JSON.stringify(svgStyle));
    const clickSix = async () => {
      let ok = 0;
      for (let i = 0; i < 6; i++) {
        const cc = await center(P, '#like svg');
        await P.page.mouse.move(cc.x, cc.y);
        await sleep(100);
        const before = await P.page.evaluate(() => window.clicks);
        await P.page.mouse.click(cc.x, cc.y, { delay: 25 });
        await sleep(i % 2 ? 10 : 120);
        const after = await P.page.evaluate(() => window.clicks);
        if (after - before === 1) ok++;
      }
      await idle(P);
      return ok;
    };
    const okOn = await clickSix();
    await setSettings(P, { enabled: false });
    const okOff = await clickSix();
    check('6 of 6 clicks fire the page handler while it re-renders (extension on; control with the extension off: ' + okOff + ' of 6)', okOn === 6, `handler fired ${okOn}/6 on, ${okOff}/6 off`);
    await P.page.close();
  }
  // ============================================================ E. strict CSP page
  group('csp');
  {
    const P = await openPage(url('csp.html'));
    const cspBefore = consoleErrors.filter((e) => e.page === url('csp.html')).length; // the page's own inline style attribute is blocked at load
    await setSettings(P, { ...DEFAULT_SET });
    const r = await hoverRun(P, '#b1 svg', 'b1');
    check('no new CSP violation is raised by a run (the one at load is the page\'s own style attribute)', consoleErrors.filter((e) => e.page === url('csp.html')).length === cspBefore, `violations at load ${cspBefore}, after the run ${consoleErrors.filter((e) => e.page === url('csp.html')).length}`);
    check('hover works under a strict CSP, markup (with its style attribute) restored', r.frames.length >= 8 && r.same && r.hostGone, `frames ${r.frames.length}, markup equal ${r.same}`);
    await setSettings(P, { hover: 'none', click: 'pop' });
    const c = await center(P, '#b1');
    for (let i = 0; i < 3; i++) await P.page.mouse.click(c.x, c.y, { delay: 20 });
    await idle(P);
    check('click passes through under a strict CSP', (await P.page.evaluate(() => window.clicks)) === 3);
    await P.page.close();
  }
  // ============================================================ F. off switches, reduced motion, popup
  group('switches');
  {
    const P = await openPage(url('lucide.html'));
    await setSettings(P, { ...DEFAULT_SET, click: 'none' });
    const base = await hoverRun(P, '#heart svg', 'heart');
    check('baseline hover plays', base.frames.length >= 8, `frames ${base.frames.length}`);

    // per-site off, set from the popup page UI (changes reach the open tab with no reload)
    const pop = await ctx.newPage();
    await pop.goto(`chrome-extension://${EXT_ID}/popup.html?host=localhost`);
    await pop.waitForSelector('#hover .cur');
    await pop.locator('label:has(#siteoff)').click();
    await sleep(150);
    const stored = await pop.evaluate(() => new Promise((r) => chrome.storage.sync.get(null, r)));
    check('popup "Off on this site" stores the host in chrome.storage.sync', Array.isArray(stored.offSites) && stored.offSites.includes('localhost'), JSON.stringify(stored.offSites));
    const off = await hoverRun(P, '#heart svg', 'heart');
    check('per-site off: no animation on that site, no reload', off.frames.length === 0 && off.mon.hostSeen === 0, `frames ${off.frames.length}`);
    await pop.locator('label:has(#siteoff)').click();
    await sleep(150);
    const on = await hoverRun(P, '#heart svg', 'heart');
    check('per-site on again: animates again', on.frames.length >= 8, `frames ${on.frames.length}`);

    await pop.locator('label:has(#enabled)').click();
    await sleep(150);
    const dis = await hoverRun(P, '#heart svg', 'heart');
    check('master off: no animation', dis.frames.length === 0, `frames ${dis.frames.length}`);
    await pop.locator('label:has(#enabled)').click();
    await sleep(150);

    await P.page.emulateMedia({ reducedMotion: 'reduce' });
    await sleep(100);
    const rm = await hoverRun(P, '#heart svg', 'heart');
    await setSettings(P, { click: 'pop' });
    await away(P);
    await P.iso('__shapcn.trace.frames.length = 0; __shapcn.trace.on = true; true');
    const c = await center(P, '#heart svg');
    await P.page.mouse.click(c.x, c.y, { delay: 30 });
    await sleep(500);
    const rmPress = JSON.parse(await P.iso('JSON.stringify(__shapcn.trace.frames)')).length;
    await P.iso('__shapcn.trace.on = false; true');
    check('prefers-reduced-motion: reduce turns hover and click off', rm.frames.length === 0 && rmPress === 0, `hover frames ${rm.frames.length}, click frames ${rmPress}, clicks still counted ${await P.page.evaluate(() => window.clicks.heart)}`);
    await P.page.emulateMedia({ reducedMotion: 'no-preference' });
    await setSettings(P, { click: 'none' });
    const back = await hoverRun(P, '#heart svg', 'heart');
    check('reduced motion off again: animates again', back.frames.length >= 8, `frames ${back.frames.length}`);

    // the style "None" options
    await setSettings(P, { hover: 'none' });
    const none = await hoverRun(P, '#heart svg', 'heart');
    check('hover style None: nothing plays', none.frames.length === 0);

    // strength changes the size of the motion
    await setSettings(P, { hover: 'grow', strength: 0.5 });
    const lo = await hoverRun(P, '#heart svg', 'heart', 500);
    await setSettings(P, { hover: 'grow', strength: 3 });
    const hi = await hoverRun(P, '#heart svg', 'heart', 500);
    const span = (r) => Math.max(...r.frames.map((f) => f.bbox[2]));
    check('strength 3 moves more than strength 0.5', span(hi) > span(lo) + 0.3, `widest picture ${span(lo).toFixed(2)} at 0.5, ${span(hi).toFixed(2)} at 3`);
    await P.page.close();

    // popup UI
    group('popup');
    await pop.evaluate(() => new Promise((r) => chrome.storage.sync.clear(r)));
    await pop.reload();
    await pop.waitForSelector('#hover .cur');
    await sleep(200);
    check('popup shows the defaults', (await pop.locator('#hover .cur').textContent()) === 'Grow' && (await pop.locator('#click .cur').textContent()) === 'Pop' && (await pop.locator('#strength').inputValue()) === '1.5');
    await pop.locator('#hover').click();
    const hoverRows = await pop.locator('#hover-menu .opt').count();
    const hoverIcons = await pop.locator('#hover-menu .opt morph-icon svg').count();
    await pop.locator('#click').click();
    const clickRows = await pop.locator('#click-menu .opt').count();
    check('hover menu: None + 5 styles (no wiggle), each with a live icon', hoverRows === 6 && hoverIcons === 6, `rows ${hoverRows}, icons ${hoverIcons}`);
    check('click menu: None + 4 styles', clickRows === 5, `rows ${clickRows}`);
    // a row preview plays on row hover
    await pop.locator('#hover').click();
    const row = pop.locator('#hover-menu .opt[data-value="bend"]'); // not the chosen row: the chosen row is focused when the menu opens, and its icon moves
    const ic = row.locator('morph-icon');
    const b0 = await ic.evaluate((el) => el.querySelector('svg').innerHTML);
    const bb = await row.boundingBox();
    await pop.mouse.move(2, 2);
    // The preview is the engine's own <morph-icon>, on the clock of the page. A slow machine draws few frames, so the test does not count
    // pictures: it waits (up to 6 s) for a picture that differs from rest, and then for the icon to be back at rest.
    const seen = new Set();
    await pop.mouse.move(bb.x + 20, bb.y + bb.height / 2);
    let pvMoved = false;
    let pvBack = false;
    for (let i = 0; i < 200 && !pvBack; i++) {
      const cur = await ic.evaluate((el) => el.querySelector('svg').innerHTML);
      seen.add(cur);
      if (cur !== b0) pvMoved = true;
      else if (pvMoved) pvBack = true;
      await sleep(30);
    }
    const b1 = await ic.evaluate((el) => el.querySelector('svg').innerHTML);
    check('menu row preview plays its style on hover and returns to rest', pvMoved && pvBack && b0 === b1, `pvMoved ${pvMoved}, back at rest ${pvBack}, distinct pictures ${seen.size}`);
    await row.click();
    await sleep(120);
    let s = await pop.evaluate(() => new Promise((r) => chrome.storage.sync.get(null, r)));
    check('choosing a hover style stores it', s.hover === 'bend', JSON.stringify(s.hover));
    await pop.locator('#click').click();
    await pop.locator('#click-menu .opt[data-value="burst"]').click();
    await sleep(120);
    s = await pop.evaluate(() => new Promise((r) => chrome.storage.sync.get(null, r)));
    check('choosing a click style stores it', s.click === 'burst', JSON.stringify(s.click));
    await pop.locator('#strength').fill('2.4');
    await sleep(120);
    s = await pop.evaluate(() => new Promise((r) => chrome.storage.sync.get(null, r)));
    const rng = await pop.locator('#strength').evaluate((e) => [e.min, e.max, e.step]);
    check('strength slider 0.5 to 3, stored', s.strength === 2.4 && rng.join() === '0.5,3,0.1', `range ${rng.join('/')}, stored ${s.strength}`);
    await pop.screenshot({ path: path.join(HERE, 'out', 'popup.png') });
    await pop.locator('#hover').click();
    await pop.screenshot({ path: path.join(HERE, 'out', 'popup-menu.png') });
    await pop.close();
  }
  // ============================================================ F2. contact sheet (rest, then three moments of a run) for the eye
  group('visual');
  {
    const sheet = [];
    for (const [file, sel, id] of [['x-like.html', '#reply svg', 'reply'], ['x-like.html', '#like svg', 'like'], ['x-like.html', '#share svg', 'share'], ['x-like.html', '#repost svg', 'repost'], ['github-like.html', '#logo svg', 'logo'], ['github-like.html', '#bell svg', 'bell'], ['lucide.html', '#heart svg', 'heart'], ['lucide.html', '#settings svg', 'settings']]) {
      const P = await openPage(url(file));
      await P.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 800, deviceScaleFactor: 4, mobile: false });
      for (const [kind, style] of [['hover', 'grow'], ['hover', 'bend'], ['click', 'burst'], ['click', 'squash']]) {
        await setSettings(P, kind === 'hover' ? { ...DEFAULT_SET, hover: style, click: 'none', strength: 2 } : { ...DEFAULT_SET, hover: 'none', click: style, strength: 2 });
        await away(P);
        await idle(P);
        const c = await center(P, sel);
        const clip = { x: c.x - 24, y: c.y - 24, width: 48, height: 48 };
        const shots = [];
        shots.push((await P.page.screenshot({ clip })).toString('base64'));
        if (kind === 'hover') await P.page.mouse.move(c.x, c.y);
        else {
          await P.page.mouse.move(c.x, c.y);
          await P.page.mouse.down();
        }
        for (const ms of kind === 'hover' ? [90, 110, 120] : [70, 90, 120]) {
          await sleep(ms);
          shots.push((await P.page.screenshot({ clip })).toString('base64'));
        }
        if (kind === 'click') await P.page.mouse.up();
        await sleep(700);
        shots.push((await P.page.screenshot({ clip })).toString('base64'));
        await away(P);
        sheet.push({ label: `${id} ${style}`, shots });
      }
      await P.page.close();
    }
    const sp = await ctx.newPage();
    await sp.setContent('<body style="margin:8px;background:#fff;font:11px sans-serif">' + sheet.map((r) => `<div style="display:flex;align-items:center;gap:4px;margin:2px 0"><span style="width:110px">${r.label}</span>${r.shots.map((b) => `<img src="data:image/png;base64,${b}" width="96" height="96" style="border:1px solid #eee">`).join('')}</div>`).join('') + '</body>');
    await sp.setViewportSize({ width: 700, height: 100 + sheet.length * 100 });
    await sp.screenshot({ path: path.join(HERE, 'out', 'contact-sheet.png'), fullPage: true });
    await sp.close();
    check('contact sheet written (rest, three moments, rest) to test/out/contact-sheet.png', true);
  }
  // ============================================================ G. no network from the extension, no eval, permissions
  group('safety');
  {
    const src = fs.readFileSync(path.join(PROD, 'content.js'), 'utf8') + fs.readFileSync(path.join(PROD, 'popup.js'), 'utf8');
    const bad = ['fetch(', 'XMLHttpRequest', 'WebSocket', 'sendBeacon', 'importScripts', 'eval(', 'new Function(', 'EventSource', 'http://', 'https://'].filter((w) => src.includes(w));
    const urls = [...new Set(src.match(/https?:\/\/[^\s"'`)<>]+/g) || [])];
    check('bundles contain no network or eval APIs', bad.filter((w) => !/^https?:/.test(w)).length === 0, `found: ${bad.join(', ') || 'none'}; URL strings: ${urls.join(' ') || 'none'}`);
    const man = JSON.parse(fs.readFileSync(path.join(PROD, 'manifest.json'), 'utf8'));
    check('manifest: permissions are only storage, no host_permissions, one content script on all URLs', JSON.stringify(man.permissions) === '["storage"]' && !man.host_permissions && man.content_scripts.length === 1 && man.content_scripts[0].matches.join() === '<all_urls>', JSON.stringify({ permissions: man.permissions, matches: man.content_scripts[0].matches }));
    check('all page requests in the fixture runs went to localhost only', [...reqHosts].every((h) => h.startsWith('localhost')), [...reqHosts].join(', '));
  }
  // ============================================================ H. real sites (public, logged out, read only: pointer moves only, no clicks)
  const real = [];
  if (WEB) {
    group('real sites');
    for (const site of ['https://github.com', 'https://en.wikipedia.org/wiki/Main_Page']) {
      const entry = { site };
      try {
        const P = await openPage(site, { waitUntil: 'load' });
        await sleep(1500);
        await setSettings(P, { ...DEFAULT_SET });
        const found = JSON.parse(await P.iso('JSON.stringify(__shapcn.scan())'));
        const info = JSON.parse(await P.iso('JSON.stringify({stats: __shapcn.stats})'));
        entry.found = found.length;
        entry.kinds = found.reduce((a, f) => ((a[f.kind] = (a[f.kind] || 0) + 1), a), {});
        entry.skippedReasons = info.stats.reasons;
        // hover the first 25 distinct icons with the mouse (move only)
        let played = 0;
        const tried = found.filter((f) => f.x > 0 && f.y > 0 && f.x < 1000 && f.y < 800).slice(0, 25);
        await P.iso('__shapcn.trace.frames.length = 0; __shapcn.trace.on = true; true');
        for (const f of tried) {
          await away(P);
          const n0 = await P.iso('__shapcn.stats.runs');
          await P.page.mouse.move(f.x, f.y, { steps: 3 });
          await sleep(120);
          const n1 = await P.iso('__shapcn.stats.runs');
          if (n1 > n0) played++;
        }
        await away(P);
        await idle(P, 5000);
        const st = JSON.parse(await P.iso('JSON.stringify(__shapcn.stats)'));
        entry.hovered = tried.length;
        entry.played = played;
        entry.runs = st.runs;
        entry.distinctIconsAnimated = st.icons;
        entry.ourErrors = st.errors;
        entry.msPerFrame = st.frames ? +(st.ms / st.frames).toFixed(3) : null;
        entry.overlayLeft = await P.page.evaluate(() => !!document.querySelector('[data-shapcn-overlay]'));
        entry.opacityLeft = await P.page.evaluate(() => [...document.querySelectorAll('svg')].filter((s) => /opacity:\s*0\s*!important/.test(s.getAttribute('style') || '')).length);
        await P.iso('__shapcn.trace.on = false; true');
        await P.page.close();
      } catch (e) {
        entry.error = String(e.message).slice(0, 200);
      }
      real.push(entry);
      console.log('REAL', JSON.stringify(entry));
    }
  }
  // ============================================================ I. console errors
  group('errors');
  const ours = [...pageErrors, ...consoleErrors].filter((e) => e.ours);
  const fixtureErrors = [...pageErrors, ...consoleErrors].filter((e) => String(e.page).startsWith('http://localhost') && !(e.page === url('csp.html') && /Applying inline style violates/.test(e.text)));
  check('no console or page errors on the fixture pages (except the strict-CSP page\'s own blocked style attribute)', fixtureErrors.length === 0, fixtureErrors.map((e) => e.text).slice(0, 3).join(' || '));
  check('no error from the extension on any page (fixtures, github, wikipedia)', ours.length === 0, ours.map((e) => e.text).slice(0, 3).join(' || '));
  const siteErrors = [...pageErrors, ...consoleErrors].filter((e) => !String(e.page).startsWith('http://localhost') && !String(e.page).startsWith('chrome-extension'));
  console.log('Errors raised by the real sites themselves (not by the extension):', siteErrors.length, siteErrors.slice(0, 3).map((e) => String(e.text).slice(0, 100)));
  fs.writeFileSync(path.join(HERE, 'out', 'results.json'), JSON.stringify({ chrome: version, results, real, siteErrorsCount: siteErrors.length }, null, 1));
} finally {
  const pass = results.filter((r) => r.ok).length;
  console.log(`\nRESULT ${pass} of ${results.length} checks passed`);
  await browser.close().catch(() => {});
  chrome.kill();
  server.close();
  process.exitCode = pass === results.length ? 0 : 1;
}
