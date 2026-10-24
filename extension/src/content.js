// shapcn everywhere: content script. Runs in the extension's isolated world (the page cannot see it).
// It listens for pointer events on the document. On hover or press of an interactive element it finds the small inline icons
// inside it, turns each one into engine icon data with registerSVGs, and plays a real shapcn plan (planAlive, planPress,
// createSway). The plan is drawn into an overlay svg inside a closed shadow root. The page's own svg is never edited: it is
// only made transparent while the run plays, and its style attribute is put back exactly when the run ends.
// TEST_HOOKS is replaced by the build (esbuild --define): true in the test build, false in the production build and the store zip.
import * as S from './engine.js';
import { regionMerger } from './fillregions.js';

const DEFAULTS = { enabled: true, hover: 'wiggle', click: 'pop', strength: 1.5, offSites: [] };
const settings = { ...DEFAULTS };
const MIN = 12;
const MAX = 48;
const NS = 'http://www.w3.org/2000/svg';
const INTERACTIVE = 'a[href],button,summary,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="switch"],[role="checkbox"],[role="option"],[onclick],[tabindex]:not([tabindex="-1"])';
const SHAPES = new Set(['path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon']);
const SKIP = new Set(['defs', 'title', 'desc', 'metadata', 'style']);
const GEO = ['d', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'width', 'height', 'points', 'x1', 'y1', 'x2', 'y2'];

const faults = { frame: false, hide: false, adopt: false };
const freeze = { on: false, t: null }; // t: a number, or [from, to] (each run gets a phase in the range), or null (0.22 to 0.72)
function freezePhase(run) {
  const f = (run.seq * 0.137) % 1;
  if (typeof freeze.t === 'number') return freeze.t;
  if (Array.isArray(freeze.t)) return freeze.t[0] + f * (freeze.t[1] - freeze.t[0]);
  return 0.22 + f * 0.5;
} // tests: make the first drawn frame, or the hiding, throw
const stats = { scanned: 0, parentReads: 0, runs: 0, icons: 0, skipped: 0, reasons: {}, errors: 0, frames: 0, ms: 0 };
const counted = new WeakSet();

// ---------------------------------------------------------------- settings
function siteOff() {
  const h = location.hostname;
  return settings.offSites.includes(h) || settings.offSites.includes(h.replace(/^www\./, ''));
}
function reduced() {
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) {
    return false;
  }
}
const isOn = () => settings.enabled && !siteOff() && !reduced();
try {
  // Reduced motion turned on while runs play: stop them at once, and drop the move listener.
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', (e) => {
    if (e.matches) stopAll();
    syncMoveListener();
  });
} catch (e) {
  // no media query events
}

function applySettings(next) {
  for (const k of Object.keys(DEFAULTS)) if (next && next[k] !== undefined) settings[k] = next[k];
  if (!Array.isArray(settings.offSites)) settings.offSites = [];
  const s = Number(settings.strength);
  settings.strength = Number.isFinite(s) ? Math.min(3, Math.max(0.5, s)) : 1.5;
  if (!settings.enabled || siteOff()) stopAll();
  syncMoveListener();
}

try {
  chrome.storage.sync.get(DEFAULTS, (v) => {
    if (!chrome.runtime.lastError) applySettings(v);
  });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'sync') return;
    const n = {};
    for (const k of Object.keys(ch)) n[k] = ch[k].newValue === undefined ? DEFAULTS[k] : ch[k].newValue;
    applySettings(n);
  });
} catch (e) {
  // the extension was reloaded: this old script does nothing
}

// ---------------------------------------------------------------- finding icons
// The element that acts as the button around a node. First a semantic one (a, button, role=button, tabindex ...).
// Else a plain element that the page styled as clickable: the outermost element of the chain of cursor:pointer elements
// that starts at the node or at one of its three nearest ancestors. (An icon with pointer-events:none inside such an
// element is never the event target, the clickable element is.)
const cursorOf = (el) => {
  try {
    return getComputedStyle(el).cursor;
  } catch (e) {
    return '';
  }
};
function clickableOf(node) {
  const el = node && node.nodeType === 1 ? node : node && node.parentElement;
  if (!el || !el.closest) return null;
  const hit = el.closest(INTERACTIVE);
  if (hit) return hit;
  let start = null;
  let e = el;
  for (let i = 0; e && i < 4 && e !== document.body && e !== document.documentElement; e = e.parentElement, i++) {
    if (cursorOf(e) === 'pointer') {
      start = e;
      break;
    }
  }
  if (!start) return null;
  let top = start;
  for (let p = start.parentElement, i = 0; p && i < 8 && p !== document.body && p !== document.documentElement; p = p.parentElement, i++) {
    if (cursorOf(p) !== 'pointer') break;
    top = p;
  }
  return top;
}
const interactiveOf = clickableOf;
const hostTooBig = (h) => {
  if (h.localName === 'svg') return false;
  const r = h.getBoundingClientRect();
  return r.width > 640 || r.height > 240;
};

function iconsOf(host) {
  const list = host.localName === 'svg' ? [host] : Array.from(host.querySelectorAll('svg'));
  const out = [];
  pass = new Map(); // the style-rule lists of this pass
  try {
    for (const svg of list) {
      if (out.length >= 4) break;
      if (svg.closest('[data-shapcn-overlay]')) continue;
      const r = svg.getBoundingClientRect();
      if (r.width < MIN || r.height < MIN || r.width > MAX || r.height > MAX) continue;
      const rec = describe(svg, r);
      if (rec) out.push(rec);
    }
  } finally {
    pass = null;
  }
  return out;
}

// ---------------------------------------------------------------- svg to engine icon
class Bail extends Error {}
const bail = (why) => {
  throw new Bail(why);
};
const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const painted = (v) => v && v !== 'none' && v !== 'transparent' && v !== 'rgba(0, 0, 0, 0)';

const hiddenWord = (v) => v === 'hidden' || v === 'collapse';

// Which of visibility, fill-opacity and stroke-opacity does a node DECLARE (inline style, presentation attribute, or a style rule
// that matches it; `inherit` is no declaration)? Only the fact of a declaration is read: when there is one, the node's computed value
// is the one that wins.
// The style rules are read into a short list of the rules that declare any of the three, once for each pass of looking at the
// icons of a button (see iconsOf), and never kept after it. The build has a budget (1,000 rules, 1.5 ms): a page with more rules cannot be
// resolved, and its <use> icons are skipped. A sheet that the page may not read (another origin) is unknown: a <use> icon is skipped
// when something that only a sheet could settle is left open.
const PROPS = ['visibility', 'fill-opacity', 'stroke-opacity'];
const RULE_BUDGET = 1000;
const TIME_BUDGET_MS = 1.5;
function buildIndex(root) {
  const lists = [Array.from(root.styleSheets || document.styleSheets), (root.adoptedStyleSheets || []).filter((x) => !ownSheets.has(x))];
  const sheetsNow = lists[0].concat(lists[1]);
  const idx = { list: [], big: false, unreadable: false };
  let visited = 0;
  const t0 = performance.now();
  const spend = () => {
    if (++visited > RULE_BUDGET || ((visited & 127) === 0 && performance.now() - t0 > TIME_BUDGET_MS)) throw new Error('budget');
  };
  const walk = (rules, conds) => {
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i];
      spend();
      let c = conds;
      if (r.media) c = c.concat([['m', r.media.mediaText]]);
      else if (r.constructor && r.constructor.name === 'CSSSupportsRule') c = c.concat([['s', r.conditionText]]);
      if (r.selectorText !== undefined && r.style) {
        const props = PROPS.filter((p) => {
          const v = r.style.getPropertyValue(p);
          return v && v !== 'inherit';
        });
        if (props.length) idx.list.push({ sel: r.selectorText, props, conds: c });
      }
      if (r.styleSheet) {
        try {
          walk(r.styleSheet.cssRules, c);
        } catch (e) {
          if (e.message === 'budget') throw e;
          idx.unreadable = true;
        }
      } else if (r.cssRules) walk(r.cssRules, c);
    }
  };
  try {
    for (const sh of sheetsNow) {
      let rules;
      try {
        rules = sh.cssRules;
      } catch (e) {
        idx.unreadable = true;
        continue;
      }
      walk(rules, []);
    }
  } catch (e) {
    idx.big = true;
  }
  return idx;
}
// The list is built once for each pass of looking at icons (iconsOf), then dropped. Nothing is kept between interactions,
// so a style sheet that the page changes (even with the same number of rules) is always read again.
let pass = null; // Map: root -> index, alive during one iconsOf
function indexFor(root) {
  if (!pass) return buildIndex(root); // not inside a pass (a direct call): build, keep nothing
  let idx = pass.get(root);
  if (!idx) {
    idx = buildIndex(root);
    pass.set(root, idx);
  }
  return idx;
}
function condsHold(conds) {
  for (const [k, t] of conds) {
    try {
      if (k === 'm' ? !matchMedia(t).matches : !CSS.supports(t)) return false;
    } catch (e) {
      return false;
    }
  }
  return true;
}
// -> { visibility: bool, 'fill-opacity': bool, 'stroke-opacity': bool }. Bails when it cannot be known.
function declaredProps(el) {
  const out = {};
  const need = [];
  for (const p of PROPS) {
    const val = (el.style && el.style.getPropertyValue(p)) || el.getAttribute(p);
    if (val) out[p] = val !== 'inherit'; // an inline value settles it
    else need.push(p);
  }
  if (!need.length) return out;
  const idx = indexFor(el.getRootNode());
  if (idx.big) bail('rules-budget');
  const found = new Set();
  for (const r of idx.list) {
    if (!r.props.some((p) => need.includes(p) && !found.has(p))) continue;
    try {
      if (!el.matches(r.sel) || !condsHold(r.conds)) continue;
    } catch (e) {
      continue;
    }
    for (const p of r.props) found.add(p);
  }
  for (const p of need) {
    out[p] = found.has(p);
    if (!out[p] && idx.unreadable) bail('sheets-unreadable');
  }
  return out;
}
// What applies to a node of the referenced subtree when it is drawn by a <use>: inherited values start at the <use> element
// (where it is drawn), not at the ancestors of the definition. A node that declares a value gets its own computed one.
function stepEff(el, own, parent) {
  const d = declaredProps(el);
  return {
    vis: d.visibility ? own.visibility : parent.vis,
    fo: d['fill-opacity'] ? own.fillOpacity : parent.fo,
    so: d['stroke-opacity'] ? own.strokeOpacity : parent.so,
  };
}

function collect(root, list, inherit, eff) {
  for (const el of Array.from(root.children)) {
    const tag = el.localName;
    if (SKIP.has(tag)) continue;
    if (el.hasAttribute('transform') || el.hasAttribute('clip-path') || el.hasAttribute('mask') || el.hasAttribute('filter')) bail('transform-clip-mask');
    const own = getComputedStyle(el);
    if (own.display === 'none') continue; // a hidden group (or shape) stays hidden, with all it holds
    if (tag === 'g') {
      if (Number(own.opacity) < 1) bail('group-opacity');
      collect(el, list, inherit, inherit ? stepEff(el, own, eff) : null);
      continue;
    }
    if (!SHAPES.has(tag)) bail('element-' + tag);
    if (inherit) {
      // drawn through <use>: see stepEff
      const e = stepEff(el, own, eff);
      if (hiddenWord(e.vis)) continue;
      if (Number(own.opacity) < 1 || Number(e.fo) < 1 || Number(e.so) < 1) bail('shape-opacity');
    } else {
      if (own.visibility === 'hidden' || own.visibility === 'collapse') continue;
      if (Number(own.opacity) < 1 || Number(own.fillOpacity) < 1 || Number(own.strokeOpacity) < 1) bail('shape-opacity');
    }
    const cs = inherit || own;
    if (String(cs.fill).startsWith('url(') || String(cs.stroke).startsWith('url(')) bail('gradient');
    list.push({ el, fill: cs.fill, stroke: cs.stroke, sw: parseFloat(cs.strokeWidth) || 0, cap: cs.strokeLinecap, join: cs.strokeLinejoin, miter: cs.strokeMiterlimit });
  }
}

function sourceOf(svg) {
  // <svg><use href="#id"/></svg>: the shapes come from the element the use points to (same document only).
  const kids = Array.from(svg.children).filter((c) => !SKIP.has(c.localName));
  if (kids.length === 1 && kids[0].localName === 'use') {
    const ref = kids[0].getAttribute('href') || kids[0].getAttribute('xlink:href') || '';
    if (!ref.startsWith('#')) bail('use-external');
    let t = null;
    try {
      t = document.getElementById(ref.slice(1));
    } catch (e) {
      t = null;
    }
    if (!t) bail('use-missing');
    return { root: t, use: kids[0], wrap: t.localName === 'symbol' || t.localName === 'svg' ? t : null };
  }
  return { root: svg, use: null, wrap: svg };
}

const index = new Map(); // key -> engine name | null, for every admitted registration (never evicted, at most REGISTER_MAX)
const cache = new Map(); // key -> engine name | null. Least recently used first (the fast path).
const CACHE_MAX = 256;
const REGISTER_MAX = 1000; // the engine has no way to remove an icon, so the number of registrations is capped
let seq = 0;

// Matrices are [a, b, c, d, e, f] as in CSS matrix(). mul(A, B) applies B first.
const mul = (A, B) => [A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1], A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3], A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5]];
function inv(M) {
  const det = M[0] * M[3] - M[1] * M[2];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return null;
  const a = M[3] / det, b = -M[1] / det, c = -M[2] / det, d = M[0] / det;
  return [a, b, c, d, -(a * M[4] + c * M[5]), -(b * M[4] + d * M[5])];
}
// x, y, width and height of a <use> (or of a nested svg): a plain number or px only. Percentages and other units need the
// viewport to resolve, and the icon is skipped.
const PLAIN = /^\s*[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?(px)?\s*$/i;
function plain(v) {
  if (v == null || v === '') return null;
  if (!PLAIN.test(v)) bail('use-length');
  return parseFloat(v);
}
const len = (v) => {
  const n = plain(v);
  return n > 0 ? n : null;
};
// Where the referenced content lands: from its own user units into the user units of the outer svg. A <symbol> (or nested svg)
// with a viewBox is fitted into the use viewport (x, y, width, height of the <use>, default the whole outer viewBox) by its
// preserveAspectRatio. Without a viewBox the content keeps the outer units and only moves by x and y.
function useMatrix(svg, use, wrap, vb) {
  const ux = plain(use.getAttribute('x')) || 0;
  const uy = plain(use.getAttribute('y')) || 0;
  len(use.getAttribute('width'));
  len(use.getAttribute('height')); // a bad length bails, also when no viewBox is used
  if (!wrap || wrap === svg || !wrap.getAttribute('viewBox')) return [1, 0, 0, 1, ux, uy];
  let ovb = svg.getAttribute('viewBox');
  ovb = ovb ? ovb.trim().split(/[\s,]+/).map(Number) : [0, 0, parseFloat(svg.getAttribute('width')), parseFloat(svg.getAttribute('height'))];
  if (ovb.length !== 4 || !ovb.every(Number.isFinite) || !(ovb[2] > 0) || !(ovb[3] > 0)) bail('no-viewbox');
  const VW = len(use.getAttribute('width')) || (wrap.localName === 'svg' && len(wrap.getAttribute('width'))) || ovb[2];
  const VH = len(use.getAttribute('height')) || (wrap.localName === 'svg' && len(wrap.getAttribute('height'))) || ovb[3];
  const par = (wrap.getAttribute('preserveAspectRatio') || 'xMidYMid meet').trim().split(/\s+/);
  if (par[0] === 'none') return [VW / vb[2], 0, 0, VH / vb[3], ux, uy];
  if (par[1] === 'slice') bail('slice'); // the content would be clipped by the viewport: not reproduced
  const s = Math.min(VW / vb[2], VH / vb[3]);
  const fx = /xMin/.test(par[0]) ? 0 : /xMax/.test(par[0]) ? 1 : 0.5;
  const fy = /YMin/.test(par[0]) ? 0 : /YMax/.test(par[0]) ? 1 : 0.5;
  return [s, 0, 0, s, ux + fx * (VW - vb[2] * s), uy + fy * (VH - vb[3] * s)];
}

function describe(svg, rect) {
  try {
    const rec = describeOrThrow(svg, rect);
    return rec;
  } catch (e) {
    stats.skipped++;
    const why = e instanceof Bail ? e.message : 'error';
    stats.reasons[why] = (stats.reasons[why] || 0) + 1;
    return null;
  }
}

function describeOrThrow(svg, rect) {
  const scs = getComputedStyle(svg);
  if (scs.visibility === 'hidden' || scs.display === 'none') bail('hidden');
  const { root, use, wrap } = sourceOf(svg);
  const list = [];
  if (use) {
    const ucs = getComputedStyle(use);
    // The <use> element is checked where it is drawn (its computed values include the instance's ancestors).
    if (ucs.display === 'none' || hiddenWord(ucs.visibility)) bail('hidden');
    if (Number(ucs.opacity) < 1 || Number(ucs.fillOpacity) < 1 || Number(ucs.strokeOpacity) < 1) bail('shape-opacity');
    if (use.hasAttribute('transform')) bail('transform-clip-mask');
    // The target: its own display and opacity (not inherited), and visibility and paint opacity as they apply in the instance.
    const rootCs = getComputedStyle(root);
    if (rootCs.display === 'none' && root.localName !== 'symbol') bail('hidden'); // only a <symbol> is display:none by default
    if (Number(rootCs.opacity) < 1) bail('shape-opacity');
    const eff0 = stepEff(root, rootCs, { vis: ucs.visibility, fo: ucs.fillOpacity, so: ucs.strokeOpacity });
    if (root.localName === 'symbol' || root.localName === 'svg' || root.localName === 'g') collect(root, list, ucs, eff0);
    else if (SHAPES.has(root.localName)) {
      if (hiddenWord(eff0.vis)) bail('hidden');
      if (Number(eff0.fo) < 1 || Number(eff0.so) < 1) bail('shape-opacity');
      list.push({ el: root, fill: ucs.fill, stroke: ucs.stroke, sw: parseFloat(ucs.strokeWidth) || 0, cap: ucs.strokeLinecap, join: ucs.strokeLinejoin, miter: ucs.strokeMiterlimit });
    } else bail('use-target');
  } else collect(root, list, null);
  if (!list.length || list.length > 24) bail(list.length ? 'too-many-shapes' : 'no-shapes');
  // the view box
  let vb = null;
  const src = wrap || svg;
  const vbAttr = src.getAttribute('viewBox') || svg.getAttribute('viewBox');
  if (vbAttr) vb = vbAttr.trim().split(/[\s,]+/).map(Number);
  else {
    const w = parseFloat(svg.getAttribute('width'));
    const h = parseFloat(svg.getAttribute('height'));
    if (w > 0 && h > 0) vb = [0, 0, w, h];
  }
  if (!vb || vb.length !== 4 || !vb.every(Number.isFinite) || !(vb[2] > 0) || !(vb[3] > 0)) bail('no-viewbox');
  if (vb[0] !== 0 || vb[1] !== 0) bail('viewbox-origin');
  const inner = use ? useMatrix(svg, use, wrap, vb) : [1, 0, 0, 1, 0, 0];
  const anyStroke = list.some((s) => painted(s.stroke) && s.sw > 0);
  const anyFill = list.some((s) => painted(s.fill));
  if (!anyStroke && !anyFill) bail('nothing-painted');
  const kind = anyStroke ? 'stroke' : 'fill';
  const first = list.find((s) => (kind === 'stroke' ? painted(s.stroke) && s.sw > 0 : painted(s.fill)));
  const color = kind === 'stroke' ? first.stroke : first.fill;
  if (kind === 'stroke') {
    const strokes = list.filter((x) => painted(x.stroke) && x.sw > 0);
    // the engine takes one cap and one join for an icon, so an icon whose shapes differ cannot be drawn like the original
    if (strokes.some((x) => x.cap !== first.cap || x.join !== first.join || parseFloat(x.miter) !== parseFloat(first.miter))) bail('mixed-caps');
  }
  const k = 24 / vb[2];
  const sw = kind === 'stroke' ? first.sw : 0;
  let body = '';
  for (const s of list) {
    let a = '';
    for (const g of GEO) if (s.el.hasAttribute(g)) a += ' ' + g + '="' + esc(s.el.getAttribute(g)) + '"';
    if (kind === 'stroke') {
      const strokeOn = painted(s.stroke) && s.sw > 0;
      const fillOn = painted(s.fill);
      if (!strokeOn && !fillOn) continue;
      if (fillOn) a += ' fill="currentColor"';
      if (!strokeOn) a += ' stroke="none"';
      else if (Math.abs(s.sw - sw) > 0.01) a += ' stroke-width="' + esc(s.sw) + '"';
    } else if (!painted(s.fill)) continue;
    body += '<' + s.el.localName + a + '/>';
  }
  const cap = kind === 'stroke' ? first.cap : 'round';
  const join = kind === 'stroke' ? first.join : 'round';
  const miter = kind === 'stroke' ? parseFloat(first.miter) || 4 : 4;
  const markup = '<svg viewBox="0 0 ' + vb[2] + ' ' + vb[3] + '"' + (kind === 'stroke' ? ' stroke-width="' + sw + '"' : '') + '>' + body + '</svg>';
  const key = [kind, cap, join, markup].join('|');
  let name = cache.get(key);
  if (name === undefined) name = index.get(key); // evicted from the LRU: the engine already has it, never register it again
  if (name !== undefined) {
    cache.delete(key); // refresh: most recently used goes last
    cache.set(key, name);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  } else {
    if (seq >= REGISTER_MAX) bail('registry-limit');
    try {
      const id = 'i' + ++seq;
      const names =
        kind === 'fill'
          ? S.registerSVGs({ [id]: markup }, { kind: 'fill' })
          : S.registerSVGs({ [id]: markup }, { kind: 'stroke', family: 'e' + seq, linecap: cap === 'butt' || cap === 'square' ? cap : 'round', linejoin: join === 'miter' || join === 'bevel' ? join : 'round' });
      name = names[0];
    } catch (e) {
      name = null;
    }
    cache.set(key, name);
    if (index.size < REGISTER_MAX) index.set(key, name);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }
  if (!name) bail('engine-rejected');
  return { svg, name, kind, inner, sw24: sw * k, cap, join, miter, color, vbw: vb[2], vbh: vb[3], par: svg.getAttribute('preserveAspectRatio'), opacity: runs.has(svg) ? runs.get(svg).rec.opacity : scs.opacity };
}

// ---------------------------------------------------------------- overlay
let host = null;
let shadow = null;
function ensureHost() {
  if (host && host.isConnected) return shadow;
  host = document.createElement('div');
  host.setAttribute('data-shapcn-overlay', '');
  host.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:2147483647;contain:none;';
  shadow = host.attachShadow({ mode: 'closed' });
  (document.documentElement || document.body).appendChild(host);
  return shadow;
}
function dropHost() {
  if (host && host.parentNode) host.parentNode.removeChild(host);
  host = null;
  shadow = null;
}

function makeOverlay(rec) {
  const ov = document.createElementNS(NS, 'svg');
  // The overlay is sized in the icon's own user units and placed with the icon's screen matrix (see place), so a CSS
  // transform on the icon or on an ancestor, the view box scaling, and preserveAspectRatio are all carried over.
  ov.setAttribute('viewBox', '0 0 24 ' + (24 * rec.vbh) / rec.vbw);
  ov.setAttribute('width', String(rec.vbw));
  ov.setAttribute('height', String(rec.vbh));
  ov.setAttribute('fill', 'none');
  ov.setAttribute('stroke', 'currentColor');
  ov.style.cssText = 'position:absolute;left:0;top:0;display:block;overflow:visible;pointer-events:none;margin:0;padding:0;border:0;max-width:none;max-height:none;transform-origin:0 0;';
  ov.style.color = rec.color;
  if (rec.opacity !== '1') ov.style.opacity = rec.opacity;
  const sh = ensureHost();
  ensureProbe(sh);
  sh.appendChild(ov);
  return ov;
}

// The overlay lives in the page, so the page's own transforms and CSS zoom apply to it too (html { transform: ... }, zoom).
// Four zero-size probes in the overlay host, at (0,0), (100,0), (0,100) and (100,100) of the host's own px, show where the host's
// coordinates land on the screen. That gives the host-to-screen matrix H. The overlay gets inverse(H) x (icon to screen), so it
// ends where the icon is. A matrix that cannot be inverted, or that is not affine (a perspective), cannot be corrected: the run is skipped.
let probes = null;
function ensureProbe(sh) {
  if (probes && probes[0].parentNode === sh) return;
  probes = [[0, 0], [100, 0], [0, 100], [100, 100]].map(([x, y]) => {
    const d = document.createElement('div');
    d.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:0;height:0;visibility:hidden;pointer-events:none;`;
    sh.appendChild(d);
    return d;
  });
}
function hostMatrix() {
  if (!probes) return null;
  const r = probes.map((d) => d.getBoundingClientRect());
  const H = [(r[1].left - r[0].left) / 100, (r[1].top - r[0].top) / 100, (r[2].left - r[0].left) / 100, (r[2].top - r[0].top) / 100, r[0].left, r[0].top];
  if (!H.every(Number.isFinite)) return null;
  const px = H[0] * 100 + H[2] * 100 + H[4];
  const py = H[1] * 100 + H[3] * 100 + H[5];
  if (Math.abs(px - r[3].left) > 0.5 || Math.abs(py - r[3].top) > 0.5) return null; // not affine
  return H;
}

function place(run) {
  const svg = run.svg;
  const r = svg.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  const m = svg.getScreenCTM && svg.getScreenCTM();
  if (!m) return false;
  const H = hostMatrix();
  const Hi = H && inv(H);
  if (!Hi) return false;
  const L = mul(Hi, mul([m.a, m.b, m.c, m.d, m.e, m.f], run.rec.inner));
  if (!L.every(Number.isFinite)) return false;
  run.ov.style.transform = `matrix(${L.join(',')})`;
  return true;
}

// ---------------------------------------------------------------- runs
const runs = new Map(); // svg -> run
// host element -> [svg]. While it holds anything, a slow timer (once a second) drops records whose nodes left the page,
// for the case that no pointer, scroll or resize event comes. The timer stops when the map is empty.
let idleTimer = 0;
function syncIdle() {
  if (hovered.size && !idleTimer) idleTimer = setInterval(sweep, 1000);
  else if (!hovered.size && idleTimer) {
    clearInterval(idleTimer);
    idleTimer = 0;
  }
}
class HoverMap extends Map {
  set(k, v) {
    super.set(k, v);
    syncIdle();
    return this;
  }
  delete(k) {
    const r = super.delete(k);
    syncIdle();
    return r;
  }
  clear() {
    super.clear();
    syncIdle();
  }
}
const hovered = new HoverMap();
let raf = 0;
const now = () => performance.now();

// Hiding the original svg writes nothing the page can copy. The svg gets a per-run attribute, and one constructed stylesheet that
// the extension owns (adopted by the svg's document or shadow root) holds a rule for each running id. When the run ends the
// rule and the attribute go. The svg's style attribute is never touched.
// A copy that the page makes during the run (cloneNode, innerHTML) carries the same attribute. A MutationObserver on the root
// removes the attribute from every node that is inserted and is not the registered original, before the next paint, so a copy
// is never hidden. After the hiding is set, the computed opacity is read: if a stronger author rule keeps the icon visible,
// the run is not started.
const sheets = new Map(); // root -> { sheet, ids: Set, mo }
const ownSheets = new WeakSet();
const runById = new Map();
let runSeq = 0;
const ruleText = (id) => `svg[data-shapcn-run="${id}"][data-shapcn-run="${id}"][data-shapcn-run="${id}"]{opacity:0 !important;transition:none !important;}`;
function writeSheet(root, rec) {
  rec.sheet.replaceSync(Array.from(rec.ids, ruleText).join('\n'));
}
function stripMarker(n) {
  const id = n.getAttribute && n.getAttribute('data-shapcn-run');
  if (id === null || id === undefined) return;
  const run = runById.get(Number(id));
  if (!run || run.svg !== n) n.removeAttribute('data-shapcn-run');
}
// One delivery of mutation records. The inserted nodes are reduced to the roots that no other inserted node contains (a chain of
// 1,000 nested insertions is one root), and each root is scanned once. An attribute record is checked on its own node.
function scanRecords(records) {
  const added = new Set();
  for (const m of records) {
    if (m.type === 'attributes') {
      stripMarker(m.target);
      continue;
    }
    for (const n of m.addedNodes) if (n.nodeType === 1) added.add(n);
  }
  if (!added.size) return;
  // inside.get(p) is true when p is an inserted node or has one above it. Every node that is visited gets its answer stored (also the
  // ones that reach the root with none), so each node's parent is read once per delivery, however many leaves share the ancestors.
  const inside = new Map();
  const isInside = (start) => {
    const path = [];
    let res = false;
    for (let p = start; p; p = p.parentNode) {
      stats.parentReads++;
      if (inside.has(p)) {
        res = inside.get(p);
        break;
      }
      if (added.has(p)) {
        res = true;
        path.push(p);
        break;
      }
      path.push(p);
    }
    for (const q of path) inside.set(q, res);
    return res;
  };
  for (const n of added) {
    if (isInside(n.parentNode)) continue; // an inserted node above this one covers it
    stats.scanned++;
    stripMarker(n);
    if (n.firstElementChild) for (const h of n.querySelectorAll('[data-shapcn-run]')) stripMarker(h); // a leaf has no descendants to scan
  }
}
function hide(run) {
  const el = run.svg;
  run.id = ++runSeq;
  run.root = el.getRootNode();
  try {
    if (!('adoptedStyleSheets' in run.root)) throw new Error('no adoptedStyleSheets');
    let rec = sheets.get(run.root);
    if (!rec) {
      rec = { sheet: new CSSStyleSheet(), ids: new Set(), mo: null };
      ownSheets.add(rec.sheet);
      sheets.set(run.root, rec);
      if (TEST_HOOKS && faults.adopt) throw new Error('injected adopt fault');
      run.root.adoptedStyleSheets = [...run.root.adoptedStyleSheets, rec.sheet];
      rec.mo = new MutationObserver(scanRecords);
      rec.mo.observe(run.root, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-shapcn-run'] });
    }
    runById.set(run.id, run);
    rec.ids.add(run.id);
    writeSheet(run.root, rec);
    el.setAttribute('data-shapcn-run', String(run.id));
    if (TEST_HOOKS && faults.hide) throw new Error('injected hide fault');
    if (getComputedStyle(el).opacity !== '0') throw new Error('the page keeps the icon visible (a stronger rule)');
  } catch (e) {
    unhide(run); // undo whatever was done: attribute, rule, sheet, observer
    throw e;
  }
}
function unhide(run) {
  const el = run.svg;
  runById.delete(run.id);
  try {
    if (el.getAttribute('data-shapcn-run') === String(run.id)) el.removeAttribute('data-shapcn-run');
  } catch (e) {
    // ignore
  }
  const rec = run.root && sheets.get(run.root);
  if (!rec) return;
  rec.ids.delete(run.id);
  if (rec.ids.size) {
    try {
      writeSheet(run.root, rec);
    } catch (e) {
      // ignore
    }
    return;
  }
  // The last run of this root: take everything away. Each step is guarded, and the record goes in any case. A sheet that stays
  // adopted (when the removal fails) is emptied first, so that it hides nothing.
  try {
    rec.sheet.replaceSync('');
  } catch (e) {
    // ignore
  }
  try {
    if (rec.mo) {
      scanRecords(rec.mo.takeRecords());
      rec.mo.disconnect();
    }
  } catch (e) {
    // ignore
  }
  try {
    if (TEST_HOOKS && faults.adopt) throw new Error('injected adopt fault');
    run.root.adoptedStyleSheets = run.root.adoptedStyleSheets.filter((x) => x !== rec.sheet);
  } catch (e) {
    // ignore
  } finally {
    sheets.delete(run.root);
  }
}

function end(run) {
  if (runs.get(run.svg) === run) runs.delete(run.svg);
  try {
    if (run.ov.parentNode) run.ov.parentNode.removeChild(run.ov);
  } catch (e) {
    // the node is gone
  }
  try {
    unhide(run);
  } catch (e) {
    // the node is gone
  }
  if (!runs.size) dropHost();
  syncHeldListeners();
}
function stopAll() {
  for (const run of Array.from(runs.values())) end(run);
  hovered.clear();
}

function styleOf(rec, name, press) {
  // Fill icons: `bold` swells the stroke width, and a solid icon has none. Use `grow` instead.
  if (!press && rec.kind === 'fill' && name === 'bold') return 'grow';
  return name;
}

function buildPlan(rec, style, press) {
  try {
    const opts = { style, strength: settings.strength };
    if (!press && style === 'bold') opts.phase = 'down';
    let plan = press ? S.planPress(rec.name, opts) : S.planAlive(rec.name, opts);
    let merge = null;
    if (rec.kind === 'fill') {
      merge = regionMerger(plan);
      // `cascade` moves the parts one after the other. A solid icon with one region has no parts: use `grow`.
      if (!press && style === 'cascade' && merge.groups < 2) {
        style = 'grow';
        plan = S.planAlive(rec.name, { style, strength: settings.strength });
        merge = regionMerger(plan);
      }
    }
    return { plan, merge, style };
  } catch (e) {
    stats.lastError = 'plan: ' + String((e && e.stack) || e).slice(0, 400);
    return null;
  }
}

// Make a run in one step: hide the original, add the overlay, run `setup`, draw the first frame. If anything throws,
// end the run (the original comes back, the overlay goes) and then report the error.
function launch(rec, kind, setup) {
  const prev = runs.get(rec.svg);
  if (prev) end(prev);
  let run = null;
  try {
    run = newRun(rec, kind);
    setup(run);
    begin(run, now());
  } catch (e) {
    if (run) end(run);
    else if (!runs.size) dropHost();
    stats.errors++;
    stats.lastError = String((e && e.stack) || e).slice(0, 400);
  }
}

function newRun(rec, kind) {
  const ov = makeOverlay(rec);
  const run = { seq: stats.runs, svg: rec.svg, rec, ov, kind, plan: null, merge: null, start: now(), dur: 500, t: 0, returning: false, hold: false, holding: false, sway: null, style: '' };
  try {
    hide(run); // unwinds its own work when it throws
  } catch (e) {
    if (ov.parentNode) ov.parentNode.removeChild(ov);
    throw e;
  }
  runs.set(rec.svg, run);
  if (!counted.has(rec.svg)) {
    counted.add(rec.svg);
    stats.icons++;
  }
  stats.runs++;
  return run;
}

// The overlay copies the icon's own stroke caps, joins and miter limit (computed style), not the plan's defaults, so the ends of
// the strokes look the same as the original. renderInto reads the caps from the plan, so the plan is wrapped once with them.
function ownedPlan(run, plan) {
  if (run.rpFor === plan) return run.rp;
  const rec = run.rec;
  run.rp = Object.create(plan, { linecap: { value: rec.cap }, linejoin: { value: rec.join } });
  run.rpFor = plan;
  return run.rp;
}
function draw(run, entries, plan, strokeWidth) {
  const rec = run.rec;
  if (rec.kind === 'fill') {
    S.renderInto(run.ov, run.merge(entries), plan, { occlusion: 'none', strokeWidth: 2, baseWidth: 2 });
    return;
  }
  const w = strokeWidth > 0 ? strokeWidth : rec.sw24 || 2;
  run.ov.setAttribute('stroke-width', String(w));
  run.ov.setAttribute('stroke-linecap', rec.cap);
  run.ov.setAttribute('stroke-linejoin', rec.join);
  run.ov.setAttribute('stroke-miterlimit', String(rec.miter));
  S.renderInto(run.ov, entries, ownedPlan(run, plan), { strokeWidth: w, baseWidth: w, linecap: rec.cap, linejoin: rec.join });
}

const trace = { on: false, frames: [] };
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}
function frame(run, t, tNow) {
  if (TEST_HOOKS && faults.frame) throw new Error('injected frame fault');
  if (run.sway) draw(run, run.sway.frame(tNow), run.sway, run.sway.strokeWidth);
  else draw(run, run.plan.frame(t), run.plan, run.plan.strokeWidth);
  if (TEST_HOOKS && trace.on) {
    const b = run.ov.getBBox();
    trace.frames.push({ id: run.svg.id || (run.svg.parentElement && run.svg.parentElement.id) || '', kind: run.kind, style: run.style, rk: run.rec.kind, t: Math.round(t * 1000) / 1000, bbox: [b.x, b.y, b.width, b.height].map((v) => Math.round(v * 100) / 100), paths: run.ov.querySelectorAll('path').length, h: hash(run.ov.innerHTML) });
  }
}

// A held run (bold, while the pointer stays) draws nothing new. It needs no frame loop, only a new position when the page moves.
const animating = () => {
  for (const run of runs.values()) if (!run.holding) return true;
  return false;
};
function kick() {
  if (!raf && animating()) raf = requestAnimationFrame(tick);
}
function repositionHeld() {
  sweep();
  for (const run of Array.from(runs.values())) if (run.holding && !place(run)) end(run);
}
// A held run is watched at a low rate (5 times a second) as long as one exists: the page can move the icon (layout change,
// an animation of a parent) or remove it with no pointer event. The check moves the overlay and drops removed icons.
// Scroll and resize also move it at once. Everything is removed when the last held run ends.
let heldOn = false;
let heldTimer = 0;
function syncHeldListeners() {
  let any = false;
  for (const run of runs.values()) if (run.holding) any = true;
  if (any && !heldOn) {
    window.addEventListener('scroll', repositionHeld, { passive: true, capture: true });
    window.addEventListener('resize', repositionHeld, { passive: true });
    heldTimer = setInterval(repositionHeld, 200);
  } else if (!any && heldOn) {
    window.removeEventListener('scroll', repositionHeld, true);
    window.removeEventListener('resize', repositionHeld);
    clearInterval(heldTimer);
    heldTimer = 0;
  }
  heldOn = any;
}
// Drop what points at a node that left the page: runs, and the hover records that hold the button.
function sweep() {
  for (const run of Array.from(runs.values())) if (!run.svg.isConnected) end(run);
  for (const [h, list] of Array.from(hovered)) {
    const live = h.isConnected ? list.filter((svg) => svg.isConnected) : [];
    if (!live.length) hovered.delete(h);
    else if (live.length !== list.length) hovered.set(h, live);
  }
}

function tick(tNow) {
  raf = 0;
  const t0 = now();
  for (const run of Array.from(runs.values())) {
    try {
      step(run, tNow);
    } catch (e) {
      stats.errors++;
      stats.lastError = String((e && e.stack) || e).slice(0, 400);
      end(run);
    }
  }
  stats.frames++;
  stats.ms += now() - t0;
  kick();
}

function step(run, tNow) {
  if (!run.svg.isConnected || !settings.enabled || siteOff() || reduced()) {
    sweep();
    return end(run);
  }
  if (!place(run)) return end(run);
  if (run.sway) {
    frame(run, 0, tNow);
    if (run.sway.atRest) end(run);
    return;
  }
  if (run.holding) return;
  // Test and screenshot hook: with freeze on, a run stays at one phase of its plan (the same real frame), so a picture can be taken
  // in the middle of a motion. freeze.t sets the phase, else each run gets its own phase from its number. Off by default.
  const t = TEST_HOOKS && freeze.on ? freezePhase(run) : Math.min(1, (tNow - run.start) / run.dur);
  run.t = t;
  if (t >= 1) {
    if (run.hold) {
      frame(run, 1, tNow);
      run.holding = true;
      syncHeldListeners();
      return;
    }
    return end(run);
  }
  frame(run, t, tNow);
}

function begin(run, tNow) {
  if (!place(run)) return end(run);
  frame(run, 0, tNow);
  kick();
}

// ---------------------------------------------------------------- hover
const hist = [];
function onMove(e) {
  const t = now();
  hist.push({ x: e.clientX, y: e.clientY, t });
  while (hist.length && t - hist[0].t > 300) hist.shift();
  const v = velocity(60);
  if (v) for (const run of runs.values()) if (run.sway) run.sway.setInput(v.vx, v.vy);
}
function velocity(win) {
  const t = now();
  const s = hist.filter((p) => t - p.t <= win);
  if (s.length < 2) return null;
  const a = s[0];
  const b = s[s.length - 1];
  const dt = Math.max(1, b.t - a.t);
  const c = (v) => Math.max(-1, Math.min(1, v / 2));
  return { vx: c((b.x - a.x) / dt), vy: c((b.y - a.y) / dt) };
}
let moveOn = false;
function syncMoveListener() {
  const want = settings.enabled && settings.hover === 'move' && !siteOff() && !reduced();
  if (want && !moveOn) document.addEventListener('pointermove', onMove, { passive: true, capture: true });
  else if (!want && moveOn) document.removeEventListener('pointermove', onMove, true);
  moveOn = want;
}

function hoverIcon(rec) {
  const name = settings.hover;
  if (name === 'none' || !S.HOVER_STYLES.includes(name)) return;
  const prev = runs.get(rec.svg);
  const tNow = now();
  if (prev) {
    if (prev.kind !== 'hover' || !prev.returning || !prev.plan || !prev.plan.dense) return;
    const fwd = S.retargetPlan(prev.plan, prev.t, false);
    if (!fwd) return;
    prev.plan = fwd;
    prev.start = tNow;
    prev.dur = S.hoverMs(prev.style);
    prev.returning = false;
    return;
  }
  const style = styleOf(rec, name, false);
  if (style === 'move') {
    launch(rec, 'hover', (run) => {
      const sway = S.createSway(rec.name, { strength: settings.strength, duration: S.hoverMs('move') });
      run.sway = sway;
      run.style = 'move';
      run.merge = rec.kind === 'fill' ? regionMerger(sway, sway.rest()) : null;
      const v = velocity(80) || { vx: 0.4, vy: 0 };
      sway.push(v.vx);
    });
    return;
  }
  const built = buildPlan(rec, style, false);
  if (!built) return;
  launch(rec, 'hover', (run) => {
    run.plan = built.plan;
    run.merge = built.merge;
    run.style = built.style;
    run.dur = S.hoverMs(built.style);
    run.hold = built.style === 'bold';
  });
}

function leaveIcon(svg) {
  const run = runs.get(svg);
  if (!run || run.kind !== 'hover') return;
  if (run.sway) {
    run.sway.release();
    return;
  }
  if (run.returning) return;
  const t = run.holding ? 1 : run.t;
  if (!run.plan || !run.plan.dense) return;
  const back = S.retargetPlan(run.plan, t, true);
  if (!back) return;
  run.plan = back;
  run.start = now();
  run.dur = S.RETARGET_MS;
  run.returning = true;
  run.hold = false;
  run.holding = false;
  run.t = 0;
  syncHeldListeners();
  kick();
}

function pressIcon(rec) {
  const name = settings.click;
  if (name === 'none' || !S.PRESS_STYLES.includes(name)) return;
  const built = buildPlan(rec, name, true);
  if (!built) return;
  launch(rec, 'press', (run) => {
    run.plan = built.plan;
    run.merge = built.merge;
    run.style = name;
    run.dur = S.pressMs(name);
  });
}

// ---------------------------------------------------------------- events (all passive, none stops or changes an event)
function guard(fn) {
  return (e) => {
    try {
      fn(e);
    } catch (err) {
      stats.errors++;
      stats.lastError = String((err && err.stack) || err).slice(0, 400);
    }
  };
}

document.addEventListener(
  'pointerover',
  guard((e) => {
    sweep();
    if (!isOn() || e.pointerType === 'touch' || settings.hover === 'none') return;
    const h = interactiveOf(e.target);
    if (!h || hovered.has(h)) return;
    if (e.relatedTarget && h.contains(e.relatedTarget)) return;
    if (hostTooBig(h)) return; // a big container is not an icon button
    const icons = iconsOf(h);
    if (!icons.length) return;
    hovered.set(h, icons.map((r) => r.svg));
    for (const rec of icons) hoverIcon(rec);
  }),
  { passive: true, capture: true }
);

document.addEventListener(
  'pointerout',
  guard((e) => {
    const h = interactiveOf(e.target);
    if (!h || !hovered.has(h)) return;
    if (e.relatedTarget && h.contains(e.relatedTarget)) return;
    for (const svg of hovered.get(h)) leaveIcon(svg);
    hovered.delete(h);
  }),
  { passive: true, capture: true }
);

document.addEventListener('pointercancel', guard(() => {
  for (const [, list] of hovered) for (const svg of list) leaveIcon(svg);
  hovered.clear();
}), { passive: true, capture: true });

function pressHost(h) {
  sweep();
  if (!h || !isOn() || settings.click === 'none') return;
  if (hostTooBig(h)) return;
  for (const rec of iconsOf(h)) pressIcon(rec);
}
document.addEventListener('pointerdown', guard((e) => { if (e.button === 0 || e.pointerType === 'touch') pressHost(interactiveOf(e.target)); }), { passive: true, capture: true });
document.addEventListener('keydown', guard((e) => {
  if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
    const t = e.target;
    if (t && t.nodeType === 1 && t.matches && t.matches('a[href],button,summary,[role="button"],[role="link"],[role="tab"],[role="switch"],[role="menuitem"]')) pressHost(t);
  }
}), { passive: true, capture: true });
window.addEventListener('blur', guard(() => {
  for (const [, list] of hovered) for (const svg of list) leaveIcon(svg);
  hovered.clear();
}));

// ---------------------------------------------------------------- scan (popup and tests only)
// Counts the icons that a hover would really animate: the same host rule, the same size rule, the same description.
function scan() {
  const found = [];
  const byHost = new Map();
  for (const svg of document.querySelectorAll('svg')) {
    if (svg.closest('[data-shapcn-overlay]')) continue;
    const h = clickableOf(svg);
    if (!h || hostTooBig(h)) continue;
    if (!byHost.has(h)) byHost.set(h, iconsOf(h));
    const rec = byHost.get(h).find((r) => r.svg === svg);
    if (!rec) continue;
    const r = svg.getBoundingClientRect();
    found.push({ x: r.left + r.width / 2, y: r.top + r.height / 2, kind: rec.kind, name: rec.name });
  }
  return found;
}

try {
  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    if (msg && msg.type === 'shapcn:info') {
      reply({ hostname: location.hostname, icons: scan().length });
      return false;
    }
    return false;
  });
} catch (e) {
  // ignore
}

// Test hooks. They exist only in the test build (TEST_HOOKS is false in the production build, and this block is removed from it).
if (TEST_HOOKS) globalThis.__shapcn = {
  overlayAttrs: () => Array.from(runs.values()).map((r) => ({ cap: r.ov.getAttribute('stroke-linecap'), join: r.ov.getAttribute('stroke-linejoin'), miter: r.ov.getAttribute('stroke-miterlimit'), transform: r.ov.style.transform, pathCaps: Array.from(r.ov.querySelectorAll('path')).map((p) => p.getAttribute('stroke-linecap')) })),
  stats,
  settings,
  trace,
  faults,
  freeze,
  sheetRoots: () => sheets.size,
  scan,
  active: () => runs.size,
  overlayCount: () => (host ? 1 : 0),
  sizes: () => ({ hovered: hovered.size, cache: cache.size, index: index.size, runs: runs.size, registered: seq }),
  moveOn: () => moveOn,
  heldMonitor: () => heldOn,
  idleTimer: () => !!idleTimer,
  hoveredSvgs: () => Array.from(hovered.values()).reduce((n, l) => n + l.length, 0),
  held: () => Array.from(runs.values()).filter((r) => r.holding).length,
  overlayInfo: () => Array.from(runs.values()).map((r) => ({ opacity: r.ov.style.opacity, left: r.ov.getBoundingClientRect().left, top: r.ov.getBoundingClientRect().top, w: r.ov.getBoundingClientRect().width, h: r.ov.getBoundingClientRect().height, svgW: r.svg.getBoundingClientRect().width, svgH: r.svg.getBoundingClientRect().height, svgTop: r.svg.getBoundingClientRect().top, svgLeft: r.svg.getBoundingClientRect().left })),
};
