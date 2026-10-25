// Shared test harness: static fixture server, system Chrome (new headless) with the unpacked extension, helpers.
// Usage: const H = await boot(extDir); ... await H.close();
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { createRequire } from 'node:module';
import { chromePath, ciArgs } from './chrome.mjs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = process.env.FIX_DIR ? path.resolve(process.env.FIX_DIR) : path.join(HERE, 'fixtures'); // FIX_DIR: serve another folder (the store asset pages)
const CHROME = chromePath();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export { sleep, HERE };

export async function boot(EXT) {
  const req = createRequire(path.join(process.env.PLAYWRIGHT_DIR || EXT, 'x.js'));
  const { chromium } = req('playwright');
  const results = [];
  let currentGroup = '';
  const check = (name, ok, detail = '') => {
    results.push({ group: currentGroup, name, ok: !!ok, detail });
    console.log((ok ? 'PASS ' : 'FAIL ') + currentGroup + ' | ' + name + (detail ? ' | ' + detail : ''));
  };
  const group = (g) => {
    currentGroup = g;
  };
// ---------------------------------------------------------------- static server (fixtures)
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml' };
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
  await page.bringToFront(); // a page in the background gets no animation frames (rAF stops), so every test page is brought to the front
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
// Waits until no run is active. It returns as soon as that is true, so a long limit costs nothing on a fast machine. On a slow runner
// (a few frames a second) one run takes seconds, and the next step must not start before it ends.
async function idle(P, ms = 60000) {
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
  await P.page.bringToFront(); // another tab (the popup, a second page) may have been opened after this one
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


  async function close() {
    await browser.close().catch(() => {});
    chrome.kill();
    server.close();
  }
  return { ctx, openPage, setSettings, center, idle, away, check, group, results, url, close, EXT_ID, PORT, pageErrors, consoleErrors, version, SNAP, SVGS, startMonitor, stopMonitor, sleep, hoverRun, traceFor, uniq };
}
