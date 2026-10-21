/* shapcn: morph any icon into any other. MIT license. Lucide icons: ISC license. https://shapcn.com */
(function () {
'use strict';
if (window.customElements && window.customElements.get('morph-icon')) return;
// Morphicon core engine. Pure ES module. No DOM. No dependencies.
// See SPEC.md for the design (round 5: rules for any pair: core and parts, no fading, staged order, intrinsic bend).

/** @typedef {[string, Object<string,string|number>]} IconElement */
/** @typedef {IconElement[]} IconNode */
/**
 * @typedef {Object} Stroke
 * @property {number} id
 * @property {boolean} closed
 * @property {Float64Array} pts      dense x,y pairs
 * @property {Int32Array} corners    point indices that are features
 * @property {number} length
 * @property {number} opacity
 * @property {boolean} cacheable
 * @property {Uint8Array|null} vis   per dense segment: 1 real, 0 bridge (null = all real)
 * @property {number} bridges        number of bridge segments
 * @property {number} pieces         number of icon strokes that this stroke chains
 */
/**
 * @typedef {Object} Snapshot
 * @property {'snapshot'} kind
 * @property {{points: Float64Array, opacity: number}[]} loops
 */
/**
 * @typedef {Object} Entry  One path to draw. A slot gives one entry per non-empty visibility class.
 * @property {string} d
 * @property {number} opacity
 * @property {number} widthScale
 * @property {number} key    slot * 4 + class (0 solid, 1 fading out, 2 fading in)
 * @property {number} slot   index into plan.slots
 * @property {boolean} [fill]       R7b: drawn with a fill too (filled stroke; fill only when strokeWidth is 0)
 * @property {number} [strokeWidth] R7b: absolute stroke width (24-grid units) when it differs from plan.strokeWidth * widthScale; 0 = no stroke
 */

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

/** All knobs. Frozen. */
const DEFAULTS = Object.freeze({
  sampleSpacing: 0.3,
  minPoints: 17,
  maxPoints: 513,
  coarsePoints: 49, // odd: 48 unique points for a loop, plus the repeated first point
  rigid: true,
  maxRotation: 100, // degrees
  minRigidSpread: 0.25,
  vanishPenalty: 10,
  travelWeight: 0.5, // weight of the centroid travel in the pair cost (1 = full, 0 = none)
  foldBias: 1.25, // closed to open: use fold only if foldBias * cost(fold) < cost(cut)
  extras: 'collapse',
  mergeFactor: 1.5,
  stagger: 0,
  easing: 'easeInOutCubic',
  cornerAngle: 15, // degrees
  snapshotCornerAngle: 30, // degrees
  flip: true, // mirrored match slots flip over instead of rotating
  flipMaxResidual: 0.15, // reflection fit must be this good (relative residual)
  flipAdvantage: 0.5, // and this many times better than the rotation fit
  flipMinRotResidual: 0.1, // and the rotation fit must be at least this bad (else the shapes are the same)
  chainGap: 4.5, // open strokes whose ends are closer than this can chain (with the angle rule); < 0 turns chaining off
  chainAngle: 80, // degrees; the bridge must be within this angle of both stroke tangents
  drawOpen: false, // legacy matching only: open strokes draw on (grow) and erase (collapse) along their path, inside a time window
  wholeTurn: true, // a 90, 180, or 270 degree turn of the whole icon about (12, 12) turns every slot as one piece
  // Round 5: rules for any pair.
  matching: 'rules', // 'rules' (core and parts, no fading) or 'legacy' (round 4: vanish and appear by penalty, merge, split)
  partGate: true, // a part ties to a part only when they are alike (false: every part pair is allowed)
  partSizeRatio: 2.5, // gate: length ratio of the two parts is at most this
  partShapeMax: 0.35, // gate: relative shape residual (rotation, scale, translation) is at most this
  retractReach: 2.5, // an open part retracts or draws out from its end when that end is this close to its anchor
  facingAnchor: true, // R10-1: a part that scales in or out uses the facing point of its parent as the anchor (false: the nearest parent point, round 9c)
  twins: true, // R10-2: a new (or leaving) part that has the same shape as a part that stays slides out from behind it (or in behind it)
  twinScale: 0.5, // R10-2: the size of a closed twin when it is behind its sibling
  keepStatic: true, // R14: parts of strokes that are the same in both icons (an overlap) are cut out and stay put; the rest draws or erases out of them (stroke icons only)
  twinBalance: 'center', // R12-1: 'center' (the group spreads about its centroid; default since R12c), 'split' (the twins start as copies of the sibling's old shape), 'off' (11f)
  staging: true, // exits, then the main change, then entries (Rule 5)
  stageOut: Object.freeze([0, 0.4]), // window of the exits
  stageMain: Object.freeze([0.2, 0.8]), // window of the core slots and the tied parts
  stageIn: Object.freeze([0.6, 1]), // window of the entries
  stageStagger: 0.12, // fraction of the out and in windows used to order the parts by distance from the core
  interp: 'rigid', // 'intrinsic' (edge lengths and angles, bends like a wire) or 'rigid' (rotation + scale + residual)
  // Round 6: level of detail, physical objects, hooks for effects.
  simplify: false, // true: a hard slot goes detail, simple shape, simple shape, detail (R6-1)
  simplifyAbove: 0.12, // a slot is hard when the relative shape distance of F and T is above this
  lodSplit: Object.freeze([0.3, 0.7]), // the three steps of a hard slot, in the slot's own time
  occlusion: 'none', // 'none' (default), 'mask', or 'fill' (R6-2, options). Core stores it; render.js uses it. 'none' keeps round 5 exits
  widthScale: null, // null (always 1) or a function (slot, t) => number (effects only)
  drawStagger: 0.5, // planDraw: fraction of the time that the starts of the strokes are spread over
  // Round 7: objects.
  objects: false, // R9 (owner vote of round 8): false (default, round 7b: parts travel, the round 6b stroke rules), 'containers' (R8-1: gather, shapes change, details), 'single' (R7-A: strokes that touch are one object; `true` means the same)
  containerSplit: Object.freeze([0.3, 0.7]), // R8-1: gather, shapes change, details (fractions of the whole time)
  objectSplit: Object.freeze([0.35, 0.65]), // gather, morph, detail of a multi-stroke object, inside the main window
});


// ---------------------------------------------------------------------------
// Easings
// ---------------------------------------------------------------------------

// R13-1: a damped spring that starts at 0 and settles at 1 (exactly 0 for t <= 0 and exactly 1 for t >= 1).
function springEase(zeta, omega) {
  const wd = omega * Math.sqrt(1 - zeta * zeta);
  const k = (zeta * omega) / wd;
  return (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return 1 - Math.exp(-zeta * omega * t) * (Math.cos(wd * t) + k * Math.sin(wd * t));
  };
}

const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

const easings = {
  linear: (t) => t,
  easeInOutCubic,
  easeOutCubic: (t) => 1 - Math.pow(1 - t, 3),
  // R13-1: the feel presets. smooth: ease in-out cubic. spring: about 16% overshoot, one wobble. bouncy: about 37%, two to three wobbles.
  smooth: easeInOutCubic,
  spring: springEase(0.5, 13),
  bouncy: springEase(0.3, 18), // kept for back compatibility; not documented
  elastic: springEase(0.2, 26), // about 53% overshoot, 3 to 5 wobbles
  gentle: springEase(0.75, 10), // the spring of rounds 1 to 12 (about 2% overshoot)
};

// R13-2: what a plan needs to know about an easing. fx: the easing leaves [0, 1] (overshoot or undershoot). tc: the first
// window time at which it reaches 1. over: the largest value above 1. pop: the share of that overshoot that an entering
// part uses for its size (R13-4: about 12% for spring, 25% for bouncy).
const easingInfoCache = new WeakMap();
function easingInfo(easing) {
  let r = easingInfoCache.get(easing);
  if (r) return r;
  const N = 1000;
  let mx = 0;
  let mn = 0;
  let tc = 1;
  let found = false;
  for (let k = 1; k < N; k++) {
    const v = easing(k / N);
    if (v > mx) mx = v;
    if (v < mn) mn = v;
    if (!found && v >= 1) {
      found = true;
      let lo = (k - 1) / N;
      let hi = k / N;
      for (let j = 0; j < 40; j++) {
        const mid = 0.5 * (lo + hi);
        if (easing(mid) < 1) lo = mid;
        else hi = mid;
      }
      tc = hi;
    }
  }
  const over = Math.max(0, mx - 1);
  const fx = over > 1e-9 || mn < -1e-9;
  r = { fx, tc: fx ? tc : 1, over, pop: over > 0 ? Math.min(0.25, 0.75 * over) / over : 0 };
  easingInfoCache.set(easing, r);
  return r;
}

function resolveEasing(e) {
  if (typeof e === 'function') return e;
  return easings[e] || easings.easeInOutCubic;
}

// R13 fix: the easing that the plan structure (windows, anchors, twin checks) is built with. An easing that leaves [0, 1]
// (spring, bouncy) is built with the smooth easing, so the structure does not depend on the feel. Other easings are used as given.
function planEasingOf(o) {
  const e = resolveEasing(o.easing);
  return easingInfo(e).fx ? easings.smooth : e;
}

// ---------------------------------------------------------------------------
// Icon registry and families (R7-0)
// ---------------------------------------------------------------------------

/** @type {Map<string, IconNode>} */
const registry = new Map();
/** @type {Map<string, Stroke[]>} */
const strokeCache = new Map();

const DEFAULT_FAMILY = Object.freeze({ id: 'lucide', kind: 'stroke', viewBox: '0 0 24 24', strokeWidth: 2 });
const DEFAULT_REC = { family: DEFAULT_FAMILY, scale: 1, linecap: 'round', linejoin: 'round' };
/** icon name -> family record { family, scale, linecap, linejoin }. Plain Lucide names are not in this map. */
const nameFamily = new Map();
/** family id -> family record */
const familyById = new Map();

function viewBoxString(vb) {
  if (typeof vb === 'string' && vb.trim()) return vb.trim().split(/[\s,]+/).join(' ');
  if (Array.isArray(vb) && vb.length === 4) return vb.join(' ');
  if (typeof vb === 'number' && vb > 0) return '0 0 ' + vb + ' ' + vb;
  return '0 0 24 24';
}

/**
 * Register a whole icon family (R7-0). Names become `<id>:<name>` (for example `phosphor-regular:camera`).
 * The parser scales coordinates by 24 / viewBox width, so every tolerance stays in 24-grid units.
 * @param {{id: string, kind: 'stroke'|'fill', viewBox?: string, strokeWidth?: number, linecap?: string, linejoin?: string, icons: Object<string, IconNode>}} spec
 * @returns {{id: string, kind: string, viewBox: string, strokeWidth: number}} the family
 */
function registerFamily(spec) {
  if (!spec || typeof spec.id !== 'string' || !spec.id || !spec.icons || typeof spec.icons !== 'object') {
    throw new Error('registerFamily: { id, kind, viewBox, strokeWidth, icons } is required.');
  }
  const kind = spec.kind === 'fill' ? 'fill' : 'stroke';
  const viewBox = viewBoxString(spec.viewBox);
  const vbw = Number(viewBox.split(' ')[2]);
  const scale = vbw > 0 ? 24 / vbw : 1;
  const sw = Number.isFinite(Number(spec.strokeWidth)) && spec.strokeWidth !== null && spec.strokeWidth !== undefined ? Number(spec.strokeWidth) : kind === 'fill' ? 0 : 2;
  const family = Object.freeze({ id: spec.id, kind, viewBox, strokeWidth: sw });
  const rec = { family, scale, linecap: spec.linecap || 'round', linejoin: spec.linejoin || 'round' };
  familyById.set(spec.id, rec);
  for (const name of Object.keys(spec.icons)) {
    const full = spec.id + ':' + name;
    const v = spec.icons[name];
    if (Array.isArray(v)) {
      registry.set(full, v);
      nameFamily.set(full, rec);
      continue;
    }
    // R9-2: a record of a `-s` set: { kind, nodes, nodesViewBox, restNodes, restViewBox, fallback }.
    if (!v || !Array.isArray(v.nodes)) throw new Error('registerFamily: icon "' + name + '" must be an icon node or a record with nodes.');
    const nvb = viewBoxString(v.nodesViewBox || spec.viewBox);
    const nvw = Number(nvb.split(' ')[2]);
    const r = { ...rec, scale: nvw > 0 ? 24 / nvw : 1 };
    if (v.fallback === true || v.kind === 'fill') {
      // A fallback icon is a fill icon for planning (getKind), with its own view box (256 for Phosphor).
      r.family = Object.freeze({ id: spec.id, kind: 'fill', viewBox: nvb, strokeWidth: 0 });
    } else if (nvb !== viewBox) {
      r.family = Object.freeze({ id: spec.id, kind, viewBox: nvb, strokeWidth: sw });
    }
    if (Array.isArray(v.restNodes)) r.rest = { nodes: v.restNodes, viewBox: viewBoxString(v.restViewBox || nvb) };
    registry.set(full, v.nodes);
    nameFamily.set(full, r);
  }
  strokeCache.clear();
  return family;
}

/**
 * Add icons to the registry (the default family: Lucide, 24 grid, stroke width 2).
 * @param {Object<string, IconNode>} map
 */
function registerIcons(map) {
  for (const name of Object.keys(map)) {
    registry.set(name, map[name]);
    nameFamily.delete(name);
  }
  strokeCache.clear();
}

// R6-3: simple shapes are icons too, so any icon can morph into or out of them.
registry.set('shape:dot', [['path', { d: 'M12 12h.01' }]]);
registry.set('shape:circle', [['circle', { cx: 12, cy: 12, r: 8 }]]);
registry.set('shape:square', [['rect', { x: 4, y: 4, width: 16, height: 16, rx: 3 }]]);
registry.set('shape:line', [['path', { d: 'M5 12h14' }]]);

/**
 * @param {boolean} [withShapes] true: also list the four `shape:` icons (dot, circle, square, line)
 * @returns {string[]}
 */
function getIconNames(withShapes = false) {
  const all = Array.from(registry.keys());
  return withShapes ? all : all.filter((n) => !n.startsWith('shape:'));
}

function getNode(name) {
  const node = registry.get(name);
  if (!node) throw new Error('Unknown icon "' + name + '". Call registerIcons or registerFamily first.');
  return node;
}

function famRec(name) {
  return nameFamily.get(name) || DEFAULT_REC;
}

/**
 * The nodes and the family of an icon (R7-0).
 * @param {string} name  a plain Lucide name or `<familyId>:<name>`
 * @returns {{nodes: IconNode, family: {id: string, kind: 'stroke'|'fill', viewBox: string, strokeWidth: number}}}
 */
function getIconInfo(name) {
  if (Array.isArray(name)) return { nodes: name, family: DEFAULT_FAMILY };
  const nodes = getNode(name);
  return { nodes, family: famRec(name).family };
}

/** The family record of a registered family id (or null). Includes the stroke attributes `linecap` and `linejoin`. */
function getFamily(id) {
  const r = familyById.get(id);
  return r ? { ...r.family, linecap: r.linecap, linejoin: r.linejoin } : null;
}

/**
 * Is `src` a snapshot (the result of `plan.snapshot(t)`)? A stroke snapshot has `kind: 'snapshot'`. A fill snapshot
 * (R7b) has `kind: 'fill'` (older fill snapshots: `kind: 'snapshot'` with `fill: true`). Both have a `loops` array.
 */
function isSnapshot(src) {
  if (!src || typeof src !== 'object' || Array.isArray(src)) return false;
  return src.kind === 'snapshot' || ((src.kind === 'fill' || src.kind === 'stroke') && Array.isArray(src.loops));
}

/**
 * 'stroke' or 'fill' for an icon name, an icon node, or a snapshot. A snapshot is 'fill' when `snapshot.kind` is
 * 'fill', or `snapshot.fill` is true, or `snapshot.family.kind` is 'fill'. Else it is 'stroke'.
 */
function getKind(src) {
  if (typeof src === 'string') {
    getNode(src);
    return famRec(src).family.kind;
  }
  if (isSnapshot(src)) return src.kind === 'fill' || src.fill === true || (src.family && src.family.kind === 'fill') ? 'fill' : 'stroke';
  return 'stroke';
}

// Stroke width of a source in 24-grid units (the family width times 24 / viewBox width).
function srcWidth(src) {
  if (typeof src === 'string') {
    getNode(src);
    const r = famRec(src);
    return r.family.strokeWidth * r.scale;
  }
  if (isSnapshot(src)) {
    if (Number.isFinite(src.strokeWidth)) return src.strokeWidth;
    if (src.family && Number.isFinite(src.family.strokeWidth)) return src.family.strokeWidth;
  }
  return 2;
}

// R9b: the line caps and joins of a source: a family's own values, or the plan values of a snapshot. Default round.
function srcCaps(src) {
  if (typeof src === 'string') {
    getNode(src);
    const r = famRec(src);
    return { cap: r.linecap || 'round', join: r.linejoin || 'round' };
  }
  if (isSnapshot(src)) return { cap: src.linecap || 'round', join: src.linejoin || 'round' };
  return { cap: 'round', join: 'round' };
}

// ---------------------------------------------------------------------------
// Number formatting
// ---------------------------------------------------------------------------

function fmt(x) {
  const r = Math.round(x * 100) / 100;
  if (r === 0 || !Number.isFinite(r)) return '0';
  return String(r);
}

function escAttr(v) {
  return String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// ---------------------------------------------------------------------------
// Original markup
// ---------------------------------------------------------------------------

/**
 * R9-2: the exact rest picture of an icon of a `-s` set: `{ nodes, viewBox }` of the original fill nodes, or null
 * (the icon has no `restNodes`: draw `iconInnerSVG` as strokes).
 * @param {string} name
 * @returns {{nodes: IconNode, viewBox: string}|null}
 */
function getRestPicture(name) {
  if (typeof name !== 'string') return null;
  getNode(name);
  const r = famRec(name).rest;
  return r ? { nodes: r.nodes, viewBox: r.viewBox } : null;
}

/**
 * Inner markup (the child elements) of an icon, exactly as in the Lucide data.
 * @param {string|IconNode} nodeOrName
 * @returns {string}
 */
function iconInnerSVG(nodeOrName) {
  const node = typeof nodeOrName === 'string' ? getNode(nodeOrName) : nodeOrName;
  let out = '';
  for (const [tag, attrs] of node) {
    out += '<' + tag;
    for (const k of Object.keys(attrs)) out += ' ' + k + '="' + escAttr(attrs[k]) + '"';
    out += '/>';
  }
  return out;
}

/**
 * Exact original markup of an icon. Same attributes as Lucide.
 * @param {string|IconNode} nodeOrName
 * @param {{size?: number, color?: string, strokeWidth?: number}} [opts]
 * @returns {string}
 */
function iconToSVG(nodeOrName, opts = {}) {
  const size = opts.size ?? 24;
  const color = opts.color ?? 'currentColor';
  const rec = typeof nodeOrName === 'string' ? famRec(nodeOrName) : DEFAULT_REC;
  const fam = rec.family;
  // R9-2: an icon of a `-s` set has its exact original fill nodes. At rest the picture is that original.
  if (rec.rest) {
    let inner = '';
    for (const [tag, attrs] of rec.rest.nodes) {
      inner += '<' + tag;
      for (const k of Object.keys(attrs)) inner += ' ' + k + '="' + escAttr(attrs[k]) + '"';
      inner += '/>';
    }
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size +
      '" viewBox="' + rec.rest.viewBox + '" fill="' + escAttr(color) + '">' + inner + '</svg>'
    );
  }
  const vb = fam.viewBox;
  if (fam.kind === 'fill') {
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size +
      '" viewBox="' + vb + '" fill="' + escAttr(color === 'currentColor' ? 'currentColor' : color) + '">' + iconInnerSVG(nodeOrName) + '</svg>'
    );
  }
  const sw = opts.strokeWidth ?? fam.strokeWidth;
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size +
    '" viewBox="' + vb + '" fill="none" stroke="' + escAttr(color) + '" stroke-width="' + sw +
    '" stroke-linecap="' + rec.linecap + '" stroke-linejoin="' + rec.linejoin + '">' + iconInnerSVG(nodeOrName) + '</svg>'
  );
}

// ---------------------------------------------------------------------------
// Step 1 and 2: parse icon nodes into strokes, flatten curves
// ---------------------------------------------------------------------------

let strokeId = 1;

// R7b: two strokes have the same style when their fill flag, opacity, and (for fill only) no-stroke flag agree. Only strokes of one style
// chain, and only strokes of one style tie. A different style exits and enters.
function sameStyle(a, b) {
  if (!a || !b) return true;
  return !!a.fill === !!b.fill && Math.abs((a.opacity === undefined ? 1 : a.opacity) - (b.opacity === undefined ? 1 : b.opacity)) < 1e-9 && sameWidth(a, b);
}

// R9b: the relative width of a stroke is its own width divided by the width of its icon (1 = the icon width, 0 = fill only).
// Two strokes whose relative widths differ by more than 10% do not chain and do not tie (they exit and enter).
function sameWidth(a, b) {
  const x = a.rw === undefined ? 1 : a.rw;
  const y = b.rw === undefined ? 1 : b.rw;
  return Math.abs(x - y) <= 0.1 * Math.max(x, y);
}

function dist(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

function polyLen(P, n, closed) {
  let L = 0;
  for (let i = 1; i < n; i++) L += dist(P[2 * i], P[2 * i + 1], P[2 * i - 2], P[2 * i - 1]);
  if (closed && n > 1) L += dist(P[2 * n - 2], P[2 * n - 1], P[0], P[1]);
  return L;
}

// Turn angle (radians, 0 to PI) at point i.
function turnAt(P, n, closed, i) {
  let ip = i - 1;
  let inx = i + 1;
  if (closed) {
    ip = (i - 1 + n) % n;
    inx = (i + 1) % n;
  } else if (ip < 0 || inx >= n) {
    return Math.PI;
  }
  const ax = P[2 * i] - P[2 * ip];
  const ay = P[2 * i + 1] - P[2 * ip + 1];
  const bx = P[2 * inx] - P[2 * i];
  const by = P[2 * inx + 1] - P[2 * i + 1];
  return Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by));
}

/**
 * Build a Stroke from raw points and joint indices (vertices where two segments meet).
 * @returns {Stroke|null}
 */
function makeStroke(pts, joints, closed, cornerAngleDeg, opacity = 1, cacheable = true, vis = null) {
  let n = pts.length / 2;
  if (n === 0) return null;
  if (n === 1) {
    pts = [pts[0], pts[1], pts[0], pts[1]];
    n = 2;
    closed = false;
    joints = [0, 1];
    vis = null;
  }
  if (closed && dist(pts[2 * n - 2], pts[2 * n - 1], pts[0], pts[1]) < 1e-6) n--;
  if (closed && n < 2) {
    pts = [pts[0], pts[1], pts[0], pts[1]];
    n = 2;
    closed = false;
    joints = [0, 1];
    vis = null;
  }
  let P = Float64Array.from(pts.slice(0, 2 * n));
  let length = polyLen(P, n, closed);
  if (!closed && length >= 0.02 && n >= 3 && dist(P[2 * n - 2], P[2 * n - 1], P[0], P[1]) < 0.01) {
    closed = true;
    n--;
    P = P.slice(0, 2 * n);
    length = polyLen(P, n, true);
  }
  const limit = cornerAngleDeg * DEG;
  const set = new Set();
  for (const j of joints) {
    if (j < n && turnAt(P, n, closed, j) > limit) set.add(j);
  }
  if (!closed) {
    set.add(0);
    set.add(n - 1);
  }
  // The per-segment visibility mask has one entry per dense segment (n for a closed stroke, n - 1 for an open one).
  let mask = null;
  if (vis && vis.length === (closed ? n : n - 1)) {
    mask = Uint8Array.from(vis);
    // Every vertex between a visible and a hidden segment is a feature.
    for (let j = 0; j < n; j++) {
      const a = closed ? (j - 1 + n) % n : j - 1;
      const b = closed || j < n - 1 ? j : -1;
      if (a >= 0 && b >= 0 && mask[a] !== mask[b]) set.add(j);
    }
  }
  const corners = Int32Array.from(Array.from(set).sort((a, b) => a - b));
  // R7b: `fill` (drawn with a fill too) and `sw` (own stroke width in 24-grid units, 0 = no stroke, null = the icon's width).
  return { id: strokeId++, closed, pts: P, corners, length, opacity, cacheable, vis: mask, bridges: 0, pieces: 1, fill: false, sw: null, rw: 1 };
}

function approxCurveSegments(len) {
  return Math.min(1000, Math.max(4, Math.ceil(len / 0.1)));
}

function arcFlatten(x1, y1, rx, ry, phiDeg, fa, fs, x2, y2, push) {
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2)) {
    push(x2, y2);
    return;
  }
  const phi = phiDeg * DEG;
  const cosP = Math.cos(phi);
  const sinP = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cosP * dx + sinP * dy;
  const y1p = -sinP * dx + cosP * dy;
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) {
    const sq = Math.sqrt(lam);
    rx *= sq;
    ry *= sq;
  }
  const rx2 = rx * rx;
  const ry2 = ry * ry;
  const den = rx2 * y1p * y1p + ry2 * x1p * x1p;
  let coef = 0;
  if (den > 0) {
    coef = Math.sqrt(Math.max(0, (rx2 * ry2 - den) / den));
    if (fa === fs) coef = -coef;
  }
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cosP * cxp - sinP * cyp + (x1 + x2) / 2;
  const cy = sinP * cxp + cosP * cyp + (y1 + y2) / 2;
  const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const ux = (x1p - cxp) / rx;
  const uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx;
  const vy = (-y1p - cyp) / ry;
  const th1 = ang(1, 0, ux, uy);
  let dth = ang(ux, uy, vx, vy);
  if (!fs && dth > 0) dth -= TAU;
  else if (fs && dth < 0) dth += TAU;
  const n = approxCurveSegments(0.5 * (rx + ry) * Math.abs(dth));
  for (let k = 1; k < n; k++) {
    const t = th1 + (dth * k) / n;
    const ct = Math.cos(t);
    const st = Math.sin(t);
    push(cosP * rx * ct - sinP * ry * st + cx, sinP * rx * ct + cosP * ry * st + cy);
  }
  push(x2, y2);
}

// Apply an affine matrix [a, b, c, d, e, f] to x, y pairs (SVG order: x' = a x + c y + e, y' = b x + d y + f).
function applyAffine(pts, m) {
  const out = new Array(pts.length);
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i];
    const y = pts[i + 1];
    out[i] = m[0] * x + m[2] * y + m[4];
    out[i + 1] = m[1] * x + m[3] * y + m[5];
  }
  return out;
}

function matMul(p, q) {
  return [
    p[0] * q[0] + p[2] * q[1],
    p[1] * q[0] + p[3] * q[1],
    p[0] * q[2] + p[2] * q[3],
    p[1] * q[2] + p[3] * q[3],
    p[0] * q[4] + p[2] * q[5] + p[4],
    p[1] * q[4] + p[3] * q[5] + p[5],
  ];
}

/**
 * Parse an SVG transform attribute (matrix, translate, scale, rotate, skewX, skewY) into one matrix. The translation
 * is multiplied by k, because the points are already scaled by k (the family scale). Returns null for no transform
 * or an unknown one.
 */
function parseTransform(str, k) {
  const re = /([a-zA-Z]+)\s*\(([^)]*)\)/g;
  let m = [1, 0, 0, 1, 0, 0];
  let any = false;
  let r;
  while ((r = re.exec(String(str)))) {
    const v = numberList(r[2]);
    let t = null;
    const name = r[1];
    if (name === 'matrix' && v.length === 6) t = v;
    else if (name === 'translate' && v.length >= 1) t = [1, 0, 0, 1, v[0], v.length > 1 ? v[1] : 0];
    else if (name === 'scale' && v.length >= 1) t = [v[0], 0, 0, v.length > 1 ? v[1] : v[0], 0, 0];
    else if (name === 'rotate' && v.length >= 1) {
      const a = v[0] * DEG;
      const co = Math.cos(a);
      const si = Math.sin(a);
      const cx = v.length >= 3 ? v[1] : 0;
      const cy = v.length >= 3 ? v[2] : 0;
      t = [co, si, -si, co, cx - co * cx + si * cy, cy - si * cx - co * cy];
    } else if (name === 'skewX' && v.length === 1) t = [1, 0, Math.tan(v[0] * DEG), 1, 0, 0];
    else if (name === 'skewY' && v.length === 1) t = [1, Math.tan(v[0] * DEG), 0, 1, 0, 0];
    if (!t) return null;
    m = matMul(m, t);
    any = true;
  }
  if (!any) return null;
  m[4] *= k;
  m[5] *= k;
  return m;
}

/** Parse an SVG path "d" string into strokes. k scales every length (the family scale, 24 / viewBox). tf is an affine matrix or null. */
function parsePath(d, cornerAngle, k = 1, tf = null) {
  const strokes = [];
  const len = d.length;
  const numRe = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
  let i = 0;
  const ws = () => {
    while (i < len) {
      const c = d.charCodeAt(i);
      if (c === 32 || c === 44 || c === 9 || c === 10 || c === 13) i++;
      else break;
    }
  };
  const num = () => {
    ws();
    numRe.lastIndex = i;
    const m = numRe.exec(d);
    if (!m) return NaN;
    i = numRe.lastIndex;
    return parseFloat(m[0]);
  };
  const flag = () => {
    ws();
    const c = d[i];
    if (c === '0' || c === '1') {
      i++;
      return c === '1' ? 1 : 0;
    }
    return NaN;
  };

  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let b = null; // current builder: { pts, joints, drawn }
  let prev = null; // { type: 'C'|'Q', x, y } last control point

  const begin = (x, y) => {
    b = { pts: [x, y], joints: [0], drawn: false };
  };
  const finish = (closed) => {
    if (b && b.drawn) {
      const s = makeStroke(tf ? applyAffine(b.pts, tf) : b.pts, b.joints, closed, cornerAngle);
      if (s) strokes.push(s);
    }
    b = null;
  };
  const add = (x, y) => {
    const l = b.pts.length;
    if (dist(x, y, b.pts[l - 2], b.pts[l - 1]) >= 1e-6) b.pts.push(x, y);
    b.drawn = true;
  };
  const endCmd = () => b.joints.push(b.pts.length / 2 - 1);
  const ensure = () => {
    if (!b) begin(cx, cy);
  };

  const ARGC = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
  let cmd = '';
  for (;;) {
    ws();
    if (i >= len) break;
    const ch = d[i];
    if (/[A-Za-z]/.test(ch)) {
      if (!(ch.toUpperCase() in ARGC)) break;
      cmd = ch;
      i++;
      if (ch === 'Z' || ch === 'z') {
        if (b) {
          b.drawn = true;
          finish(true);
        }
        cx = sx;
        cy = sy;
        prev = null;
        continue;
      }
    } else if (!cmd || cmd === 'Z' || cmd === 'z') {
      break;
    }
    const up = cmd.toUpperCase();
    const rel = cmd !== up;
    const argc = ARGC[up];
    const a = [];
    let ok = true;
    for (let k = 0; k < argc; k++) {
      const v = up === 'A' && (k === 3 || k === 4) ? flag() : num();
      if (Number.isNaN(v)) {
        ok = false;
        break;
      }
      a.push(v);
    }
    if (!ok) break;
    if (k !== 1) for (let q = 0; q < a.length; q++) if (!(up === 'A' && q >= 2 && q <= 4)) a[q] *= k;
    const ox = rel ? cx : 0;
    const oy = rel ? cy : 0;
    let nprev = null;

    if (up === 'M') {
      finish(false);
      cx = a[0] + ox;
      cy = a[1] + oy;
      sx = cx;
      sy = cy;
      begin(cx, cy);
    } else if (up === 'L' || up === 'H' || up === 'V') {
      ensure();
      let x = cx;
      let y = cy;
      if (up === 'L') {
        x = a[0] + ox;
        y = a[1] + oy;
      } else if (up === 'H') x = a[0] + ox;
      else y = a[0] + oy;
      add(x, y);
      endCmd();
      cx = x;
      cy = y;
    } else if (up === 'C' || up === 'S') {
      ensure();
      let x1;
      let y1;
      let k = 0;
      if (up === 'C') {
        x1 = a[0] + ox;
        y1 = a[1] + oy;
        k = 2;
      } else if (prev && prev.type === 'C') {
        x1 = 2 * cx - prev.x;
        y1 = 2 * cy - prev.y;
      } else {
        x1 = cx;
        y1 = cy;
      }
      const x2 = a[k] + ox;
      const y2 = a[k + 1] + oy;
      const x = a[k + 2] + ox;
      const y = a[k + 3] + oy;
      const approx = dist(cx, cy, x1, y1) + dist(x1, y1, x2, y2) + dist(x2, y2, x, y);
      const n = approxCurveSegments(approx);
      for (let s = 1; s < n; s++) {
        const t = s / n;
        const u = 1 - t;
        const w0 = u * u * u;
        const w1 = 3 * u * u * t;
        const w2 = 3 * u * t * t;
        const w3 = t * t * t;
        add(w0 * cx + w1 * x1 + w2 * x2 + w3 * x, w0 * cy + w1 * y1 + w2 * y2 + w3 * y);
      }
      add(x, y);
      endCmd();
      nprev = { type: 'C', x: x2, y: y2 };
      cx = x;
      cy = y;
    } else if (up === 'Q' || up === 'T') {
      ensure();
      let x1;
      let y1;
      let k = 0;
      if (up === 'Q') {
        x1 = a[0] + ox;
        y1 = a[1] + oy;
        k = 2;
      } else if (prev && prev.type === 'Q') {
        x1 = 2 * cx - prev.x;
        y1 = 2 * cy - prev.y;
      } else {
        x1 = cx;
        y1 = cy;
      }
      const x = a[k] + ox;
      const y = a[k + 1] + oy;
      const n = approxCurveSegments(dist(cx, cy, x1, y1) + dist(x1, y1, x, y));
      for (let s = 1; s < n; s++) {
        const t = s / n;
        const u = 1 - t;
        add(u * u * cx + 2 * u * t * x1 + t * t * x, u * u * cy + 2 * u * t * y1 + t * t * y);
      }
      add(x, y);
      endCmd();
      nprev = { type: 'Q', x: x1, y: y1 };
      cx = x;
      cy = y;
    } else if (up === 'A') {
      ensure();
      const x = a[5] + ox;
      const y = a[6] + oy;
      arcFlatten(cx, cy, a[0], a[1], a[2], a[3], a[4], x, y, add);
      endCmd();
      cx = x;
      cy = y;
    }
    prev = nprev;
    if (cmd === 'M') cmd = 'L';
    else if (cmd === 'm') cmd = 'l';
  }
  finish(false);
  return strokes;
}

function shapeCircleLike(cx, cy, rx, ry, cornerAngle, tf = null) {
  const n = approxCurveSegments(TAU * Math.max(rx, ry));
  const pts = [];
  for (let k = 0; k < n; k++) {
    const a = -Math.PI / 2 + (TAU * k) / n;
    pts.push(cx + rx * Math.cos(a), cy + ry * Math.sin(a));
  }
  return makeStroke(tf ? applyAffine(pts, tf) : pts, [], true, cornerAngle);
}

function shapeRect(attrs, cornerAngle, tf = null) {
  const x = Number(attrs.x) || 0;
  const y = Number(attrs.y) || 0;
  const w = Number(attrs.width) || 0;
  const h = Number(attrs.height) || 0;
  const hasRx = attrs.rx !== undefined && attrs.rx !== '';
  const hasRy = attrs.ry !== undefined && attrs.ry !== '';
  let rx = hasRx ? Number(attrs.rx) || 0 : hasRy ? Number(attrs.ry) || 0 : 0;
  let ry = hasRy ? Number(attrs.ry) || 0 : hasRx ? Number(attrs.rx) || 0 : 0;
  rx = Math.min(Math.max(rx, 0), w / 2);
  ry = Math.min(Math.max(ry, 0), h / 2);
  if (rx <= 0 || ry <= 0) {
    const q = [x, y, x + w, y, x + w, y + h, x, y + h];
    return makeStroke(tf ? applyAffine(q, tf) : q, [0, 1, 2, 3], true, cornerAngle);
  }
  const pts = [];
  const n = approxCurveSegments(0.5 * Math.PI * Math.max(rx, ry));
  const corner = (ccx, ccy, a0) => {
    for (let k = 0; k <= n; k++) {
      const a = a0 + (Math.PI / 2) * (k / n);
      pts.push(ccx + rx * Math.cos(a), ccy + ry * Math.sin(a));
    }
  };
  corner(x + w - rx, y + ry, -Math.PI / 2); // top right
  corner(x + w - rx, y + h - ry, 0); // bottom right
  corner(x + rx, y + h - ry, Math.PI / 2); // bottom left
  corner(x + rx, y + ry, Math.PI); // top left
  // The loop starts at the end of the top edge and runs clockwise.
  return makeStroke(tf ? applyAffine(pts, tf) : pts, [], true, cornerAngle);
}

function numberList(s) {
  const out = [];
  const re = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;
  let m;
  while ((m = re.exec(String(s)))) out.push(parseFloat(m[0]));
  return out;
}

let warned = new Set();

/**
 * Parse an icon node into strokes (Step 1 and 2). k is the family scale (24 / viewBox width). An element with
 * stroke="none" without a fill is skipped. R7b: fill="currentColor" makes a filled stroke, stroke="none" with a fill is fill only, an element stroke-width is the width of its strokes. A transform attribute is applied to the points. An opacity
 * attribute below 1 becomes the opacity of the strokes of that element.
 */
function nodeToStrokes(node, cornerAngle, k = 1, base = 2) {
  const out = [];
  const sc = (v) => (Number(v) || 0) * k;
  for (const [tag, attrs] of node) {
    // R7b: element styles. fill="currentColor" (any fill but none or transparent) = a filled stroke (fill and stroke).
    // stroke="none" with a fill = fill only (sw 0). stroke="none" without a fill draws nothing: skipped.
    const fillAttr = attrs.fill;
    const filled = fillAttr !== undefined && fillAttr !== null && fillAttr !== '' && fillAttr !== 'none' && fillAttr !== 'transparent';
    const noStroke = attrs.stroke === 'none';
    if (noStroke && !filled) continue;
    let elSw = null;
    if (noStroke) elSw = 0;
    else if (attrs['stroke-width'] !== undefined) {
      const w = Number(attrs['stroke-width']);
      if (Number.isFinite(w) && w >= 0) elSw = w * k;
    }
    const tf = attrs.transform ? parseTransform(attrs.transform, k) : null;
    const before = out.length;
    let s = null;
    if (tag === 'path') {
      for (const st of parsePath(String(attrs.d || ''), cornerAngle, k, tf)) out.push(st);
    } else if (tag === 'circle') {
      const r = sc(attrs.r);
      s = shapeCircleLike(sc(attrs.cx), sc(attrs.cy), r, r, cornerAngle, tf);
    } else if (tag === 'ellipse') {
      s = shapeCircleLike(sc(attrs.cx), sc(attrs.cy), sc(attrs.rx), sc(attrs.ry), cornerAngle, tf);
    } else if (tag === 'rect') {
      const sa = { ...attrs, x: sc(attrs.x), y: sc(attrs.y), width: sc(attrs.width), height: sc(attrs.height) };
      if (attrs.rx !== undefined && attrs.rx !== '') sa.rx = sc(attrs.rx);
      if (attrs.ry !== undefined && attrs.ry !== '') sa.ry = sc(attrs.ry);
      s = shapeRect(sa, cornerAngle, tf);
    } else if (tag === 'line') {
      const q = [sc(attrs.x1), sc(attrs.y1), sc(attrs.x2), sc(attrs.y2)];
      s = makeStroke(tf ? applyAffine(q, tf) : q, [0, 1], false, cornerAngle);
    } else if (tag === 'polyline' || tag === 'polygon') {
      const v = numberList(attrs.points);
      if (v.length >= 4) {
        const n = v.length >> 1;
        const joints = [];
        for (let q = 0; q < n; q++) joints.push(q);
        const pv = v.slice(0, 2 * n).map((x) => x * k);
        s = makeStroke(tf ? applyAffine(pv, tf) : pv, joints, tag === 'polygon', cornerAngle);
      }
    }
    if (s) out.push(s);
    for (let q = before; q < out.length; q++) {
      out[q].fill = filled;
      out[q].sw = elSw;
      out[q].rw = elSw === null ? 1 : base > 0 ? elSw / base : elSw === 0 ? 0 : 1; // R9b
    }
    if (attrs.opacity !== undefined) {
      const op = Number(attrs.opacity);
      if (Number.isFinite(op) && op < 1) for (let q = before; q < out.length; q++) out[q].opacity = Math.max(0, op);
    }
  }
  return out;
}

// Unit vector from an end point of an open stroke toward its inside (uses a point 0.3 or more away).
function endDir(s, w) {
  const P = s.pts;
  const n = P.length / 2;
  const i0 = w === 0 ? 0 : n - 1;
  const step = w === 0 ? 1 : -1;
  const px = P[2 * i0];
  const py = P[2 * i0 + 1];
  let bx = px;
  let by = py;
  for (let i = i0 + step; i >= 0 && i < n; i += step) {
    bx = P[2 * i];
    by = P[2 * i + 1];
    if (dist(px, py, bx, by) >= 0.3) break;
  }
  const d = dist(px, py, bx, by);
  if (d < 0.02) return null;
  return [(bx - px) / d, (by - py) / d];
}

// Build one stroke from chained pieces. pieces: [{ s, rev }]. A bridge is a hidden straight segment.
function buildChain(pieces, closed, cornerAngle) {
  const pts = [];
  const joints = [];
  const vis = [];
  for (let pi = 0; pi < pieces.length; pi++) {
    const { s, rev } = pieces[pi];
    const P = s.pts;
    const n = P.length / 2;
    let st = 0;
    if (pi > 0) {
      const l = pts.length;
      const fi = rev ? n - 1 : 0;
      if (dist(pts[l - 2], pts[l - 1], P[2 * fi], P[2 * fi + 1]) < 1e-6) {
        st = 1;
        vis.push(1); // the first real segment of this piece
      } else vis.push(0); // bridge
    }
    const base = pts.length / 2;
    for (let i = st; i < n; i++) {
      const li = rev ? n - 1 - i : i;
      pts.push(P[2 * li], P[2 * li + 1]);
    }
    for (let i = 0; i < n - st - 1; i++) vis.push(1);
    joints.push(base - st);
    for (const c of s.corners) {
      const oc = rev ? n - 1 - c : c;
      if (oc >= st) joints.push(base + oc - st);
      else if (base > 0) joints.push(base - 1);
    }
  }
  if (closed) {
    const n = pts.length / 2;
    if (dist(pts[2 * n - 2], pts[2 * n - 1], pts[0], pts[1]) >= 1e-6) vis.push(0); // closing bridge
  }
  const st = makeStroke(pts, joints, closed, cornerAngle, pieces[0].s.opacity, true, Uint8Array.from(vis));
  if (!st) return null;
  st.fill = pieces[0].s.fill;
  st.sw = pieces[0].s.sw;
  st.rw = pieces[0].s.rw === undefined ? 1 : pieces[0].s.rw;
  st.pieces = pieces.length;
  st.bridges = 0;
  if (st.vis) for (let i = 0; i < st.vis.length; i++) if (!st.vis[i]) st.bridges++;
  return st;
}

/**
 * Icon-level chaining (SPEC R3-3). Only open strokes chain. Two ends join when the gap is below 0.5, or when
 * the gap is below chainGap and the bridge direction is within chainAngle of both tangents. Greedy, smallest
 * gaps first. Each end joins once.
 */
function chainStrokes(strokes, o) {
  if (!(o.chainGap >= 0) || strokes.length < 1) return strokes;
  const ends = [];
  const endIdx = new Int32Array(strokes.length * 2).fill(-1);
  for (let k = 0; k < strokes.length; k++) {
    const s = strokes[k];
    if (s.closed || s.length < 0.02) continue;
    const n = s.pts.length / 2;
    endIdx[2 * k] = ends.length;
    ends.push({ k, w: 0, x: s.pts[0], y: s.pts[1], d: endDir(s, 0) });
    endIdx[2 * k + 1] = ends.length;
    ends.push({ k, w: 1, x: s.pts[2 * n - 2], y: s.pts[2 * n - 1], d: endDir(s, 1) });
  }
  if (ends.length < 2) return strokes;
  const cosMax = Math.cos(o.chainAngle * DEG);
  const cands = [];
  for (let a = 0; a < ends.length; a++) {
    for (let b = a + 1; b < ends.length; b++) {
      const p = ends[a];
      const q = ends[b];
      const gap = dist(p.x, p.y, q.x, q.y);
      let ok = gap < 0.5;
      if (!ok && gap < o.chainGap && p.d && q.d) {
        const bx = (q.x - p.x) / gap;
        const by = (q.y - p.y) / gap;
        // The bridge leaves s1 at p (away from its inside) and enters s2 at q (toward its inside).
        ok = -(bx * p.d[0] + by * p.d[1]) >= cosMax && bx * q.d[0] + by * q.d[1] >= cosMax;
      }
      if (ok && !sameStyle(strokes[p.k], strokes[q.k])) ok = false; // R7b: only strokes of one style chain
      if (ok && gap >= 0.5 && sharedParent(strokes, p, q)) ok = false; // R11-1: two ends on one third stroke are a junction
      if (ok) cands.push({ gap, a, b });
    }
  }
  if (cands.length === 0) return strokes;
  cands.sort((x, y) => x.gap - y.gap || x.a - y.a || x.b - y.b);
  const join = new Int32Array(ends.length).fill(-1);
  const parent = Array.from({ length: strokes.length }, (_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const closedComp = new Set();
  for (const c of cands) {
    if (join[c.a] >= 0 || join[c.b] >= 0) continue;
    const ra = find(ends[c.a].k);
    const rb = find(ends[c.b].k);
    if (ra === rb) closedComp.add(ra); // joins the two free ends of one chain: the chain closes
    else parent[ra] = rb;
    join[c.a] = c.b;
    join[c.b] = c.a;
  }
  // Groups.
  const groups = new Map();
  for (let k = 0; k < strokes.length; k++) {
    if (endIdx[2 * k] < 0) continue;
    if (join[endIdx[2 * k]] < 0 && join[endIdx[2 * k + 1]] < 0) continue;
    const r = find(k);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(k);
  }
  const out = [];
  const done = new Set();
  for (let k = 0; k < strokes.length; k++) {
    const r = endIdx[2 * k] >= 0 ? find(k) : -1;
    if (!groups.has(r)) {
      out.push(strokes[k]);
      continue;
    }
    if (done.has(r)) continue;
    done.add(r);
    const members = groups.get(r);
    const isClosed = closedComp.has(r);
    // Start at a stroke with a free end. A closed chain starts at its first stroke.
    let start = members[0];
    let win = 0;
    if (!isClosed) {
      for (const m of members) {
        if (join[endIdx[2 * m]] < 0) {
          start = m;
          win = 0;
          break;
        }
        if (join[endIdx[2 * m + 1]] < 0) {
          start = m;
          win = 1;
          break;
        }
      }
    }
    const pieces = [];
    let cur = start;
    let w = win;
    for (let guard = 0; guard <= members.length; guard++) {
      pieces.push({ s: strokes[cur], rev: w === 1 });
      const e = join[endIdx[2 * cur + (1 - w)]];
      if (e < 0) break;
      const nx = ends[e];
      if (nx.k === start && nx.w === win) break;
      cur = nx.k;
      w = nx.w;
    }
    const ch = pieces.length > 1 || isClosed ? buildChain(pieces, isClosed, o.cornerAngle) : null;
    if (ch) out.push(ch);
    else for (const pc of pieces) out.push(pc.s);
  }
  return out;
}


// ---------------------------------------------------------------------------
// R11: the attachment tree. Helpers for touching, chains across real breaks only, and the tree of an icon.
// ---------------------------------------------------------------------------

const ARCH2_R11D = 0.5; // R11d-3: an arch draws out of both contacts when the middle of its contacts is more than 0.5 units from the parent line
const TOUCH_R11 = 1; // a part touches a stroke when some point of it lies within 1 unit of the line of that stroke

// The nearest point of the visible line of stroke q to (x, y). Hidden (bridge) segments do not count. Returns the shared
// object { d, x, y, i, f } (the squared-free distance d, the point, the segment i and the fraction f along it).
const _near = { d: 0, x: 0, y: 0, i: 0, f: 0 };
function nearestOnStroke(q, x, y) {
  const P = q.pts;
  const n = P.length / 2;
  const m = q.closed ? n : n - 1;
  let bd = Infinity;
  for (let i = 0; i < m; i++) {
    if (q.vis && !q.vis[i]) continue;
    const j = (i + 1) % n;
    const ax = P[2 * i];
    const ay = P[2 * i + 1];
    const dx = P[2 * j] - ax;
    const dy = P[2 * j + 1] - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = ax + t * dx;
    const ey = ay + t * dy;
    const d = Math.hypot(x - ex, y - ey);
    if (d < bd) {
      bd = d;
      _near.x = ex;
      _near.y = ey;
      _near.i = i;
      _near.f = t;
    }
  }
  if (bd === Infinity) {
    bd = Math.hypot(x - P[0], y - P[1]);
    _near.x = P[0];
    _near.y = P[1];
    _near.i = 0;
    _near.f = 0;
  }
  _near.d = bd;
  return _near;
}

// R14-10: one shared all-visible mask per length. A slot's `visF`/`visT` is only read, so an all-1 mask can be shared by every
// slot of that length instead of two fresh Uint8Arrays per slot (this is the largest per-plan allocation).
const ONES_MASK = new Map();
function onesMask(n) {
  let a = ONES_MASK.get(n);
  if (!a) {
    a = new Uint8Array(n).fill(1);
    ONES_MASK.set(n, a);
  }
  return a;
}

// R11b-1: a fast "is the visible line of stroke q within TOUCH_R11 of (x, y)?" test. A grid of 2-unit cells over the box of q holds,
// for each cell, the visible segments within TOUCH_R11 of it (cached on the stroke). Same answer as
// nearestOnStroke(q, x, y).d <= TOUCH_R11 + 1e-6, without the scan over every segment.
const GRID_CS = 2;
function strokeGrid(q) {
  if (q._grid) return q._grid;
  const P = q.pts;
  const n = P.length / 2;
  const m = q.closed ? n : n - 1;
  const R = TOUCH_R11 + 1e-6;
  const b = strokeBox(q);
  const x0 = b[0] - R;
  const y0 = b[1] - R;
  const nx = Math.max(1, Math.ceil((b[2] + R - x0) / GRID_CS) + 1);
  const ny = Math.max(1, Math.ceil((b[3] + R - y0) / GRID_CS) + 1);
  const cells = new Array(nx * ny);
  let any = false;
  for (let i = 0; i < m; i++) {
    if (q.vis && !q.vis[i]) continue;
    any = true;
    const j = (i + 1) % n;
    const ax = P[2 * i];
    const ay = P[2 * i + 1];
    const bx = P[2 * j];
    const by = P[2 * j + 1];
    const cx0 = Math.max(0, Math.floor((Math.min(ax, bx) - R - x0) / GRID_CS));
    const cx1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx) + R - x0) / GRID_CS));
    const cy0 = Math.max(0, Math.floor((Math.min(ay, by) - R - y0) / GRID_CS));
    const cy1 = Math.min(ny - 1, Math.floor((Math.max(ay, by) + R - y0) / GRID_CS));
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) (cells[cy * nx + cx] || (cells[cy * nx + cx] = [])).push(i);
  }
  q._grid = { x0, y0, nx, ny, cells, any, R };
  return q._grid;
}
function nearWithin(q, x, y) {
  const g = strokeGrid(q);
  const R = g.R;
  if (!g.any) return Math.hypot(x - q.pts[0], y - q.pts[1]) <= R;
  const cx = Math.floor((x - g.x0) / GRID_CS);
  const cy = Math.floor((y - g.y0) / GRID_CS);
  if (cx < 0 || cy < 0 || cx >= g.nx || cy >= g.ny) return false;
  const lst = g.cells[cy * g.nx + cx];
  if (!lst) return false;
  const P = q.pts;
  const n = P.length / 2;
  const R2 = R * R;
  for (let k = 0; k < lst.length; k++) {
    const i = lst[k];
    const j = (i + 1) % n;
    const ax = P[2 * i];
    const ay = P[2 * i + 1];
    const dx = P[2 * j] - ax;
    const dy = P[2 * j + 1] - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = x - (ax + t * dx);
    const ey = y - (ay + t * dy);
    if (ex * ex + ey * ey <= R2) return true;
  }
  return false;
}

// R14-10: nearestOnStroke through the segment grid (R11b-1). Same answer as nearestOnStroke whenever the nearest segment lies
// within the grid radius (R = TOUCH_R11 = 1 unit); a point further out gets d = Infinity. The keep pre-pass only asks whether a
// point lies within KEEP_DIST (0.15), so this is exact there and much cheaper than the full scan over every segment.
function nearestOnStrokeNear(q, x, y) {
  const g = strokeGrid(q);
  const P = q.pts;
  if (!g.any) {
    const d = Math.hypot(x - P[0], y - P[1]);
    _near.d = d;
    _near.x = P[0];
    _near.y = P[1];
    _near.i = 0;
    _near.f = 0;
    return _near;
  }
  const cx = Math.floor((x - g.x0) / GRID_CS);
  const cy = Math.floor((y - g.y0) / GRID_CS);
  const lst = cx < 0 || cy < 0 || cx >= g.nx || cy >= g.ny ? null : g.cells[cy * g.nx + cx];
  if (!lst) {
    _near.d = Infinity;
    return _near;
  }
  const n = P.length / 2;
  let bd = Infinity;
  let bi = 0;
  let bf = 0;
  let bx = P[0];
  let by = P[1];
  for (let k = 0; k < lst.length; k++) {
    const i = lst[k];
    const j = (i + 1) % n;
    const ax = P[2 * i];
    const ay = P[2 * i + 1];
    const dx = P[2 * j] - ax;
    const dy = P[2 * j + 1] - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = ax + t * dx;
    const ey = ay + t * dy;
    const d = Math.hypot(x - ex, y - ey);
    if (d < bd) {
      bd = d;
      bx = ex;
      by = ey;
      bi = i;
      bf = t;
    }
  }
  _near.d = bd;
  _near.x = bx;
  _near.y = by;
  _near.i = bi;
  _near.f = bf;
  return _near;
}

// Do the visible samples of stroke p come within TOUCH_R11 of the visible line of stroke q? (R11b-1: early exit, box prefilter.)
function touchesStroke(p, q) {
  const a = strokeBox(p);
  const b = strokeBox(q);
  const r = TOUCH_R11 + 1e-6;
  if (a[2] + r < b[0] || b[2] + r < a[0] || a[3] + r < b[1] || b[3] + r < a[1]) return false;
  const S = visSamples(p);
  for (let k = 0; k < S.length; k += 2) if (nearWithin(q, S[k], S[k + 1])) return true;
  return false;
}

// R11b-1: nearestOnStroke with a start hint and segment boxes. `hint` is the segment that was nearest to the previous sample (a
// walk along a stroke moves the nearest segment only a little), so most segments fail the box test against the bound. Same
// minimum distance as nearestOnStroke; the shared result object is the same one.
function nearestOnStrokeHint(q, x, y, hint) {
  const P = q.pts;
  const n = P.length / 2;
  const m = q.closed ? n : n - 1;
  let sb = q._sbox;
  if (!sb) {
    sb = new Float64Array(4 * m);
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % n;
      if (q.vis && !q.vis[i]) {
        sb[4 * i] = NaN;
        continue;
      }
      sb[4 * i] = Math.min(P[2 * i], P[2 * j]);
      sb[4 * i + 1] = Math.min(P[2 * i + 1], P[2 * j + 1]);
      sb[4 * i + 2] = Math.max(P[2 * i], P[2 * j]);
      sb[4 * i + 3] = Math.max(P[2 * i + 1], P[2 * j + 1]);
    }
    q._sbox = sb;
  }
  let bd = Infinity;
  let bi = -1;
  let bf = 0;
  let bx = 0;
  let by = 0;
  const one = (i) => {
    const j = (i + 1) % n;
    const ax = P[2 * i];
    const ay = P[2 * i + 1];
    const dx = P[2 * j] - ax;
    const dy = P[2 * j + 1] - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = ax + t * dx;
    const ey = ay + t * dy;
    const d = Math.hypot(x - ex, y - ey);
    if (d < bd) {
      bd = d;
      bi = i;
      bf = t;
      bx = ex;
      by = ey;
    }
  };
  if (hint >= 0 && hint < m && sb[4 * hint] === sb[4 * hint]) one(hint);
  for (let i = 0; i < m; i++) {
    const x0 = sb[4 * i];
    if (x0 !== x0) continue; // hidden segment
    if (bd < Infinity) {
      const ex = Math.max(x0 - x, 0, x - sb[4 * i + 2]);
      const ey = Math.max(sb[4 * i + 1] - y, 0, y - sb[4 * i + 3]);
      if (ex * ex + ey * ey >= bd * bd) continue;
    }
    if (i !== hint) one(i);
  }
  if (bi < 0) {
    _near.d = Math.hypot(x - P[0], y - P[1]);
    _near.x = P[0];
    _near.y = P[1];
    _near.i = 0;
    _near.f = 0;
    return _near;
  }
  _near.d = bd;
  _near.x = bx;
  _near.y = by;
  _near.i = bi;
  _near.f = bf;
  return _near;
}

// Sample points along the visible line of a stroke, about every 0.5 units (cached).
function visSamples(s) {
  if (s._vsmp) return s._vsmp;
  const P = s.pts;
  const n = P.length / 2;
  const m = s.closed ? n : n - 1;
  const out = [];
  for (let i = 0; i < m; i++) {
    if (s.vis && !s.vis[i]) continue;
    const j = (i + 1) % n;
    const ax = P[2 * i];
    const ay = P[2 * i + 1];
    const dx = P[2 * j] - ax;
    const dy = P[2 * j + 1] - ay;
    const cnt = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 0.5));
    for (let k = 0; k <= cnt; k++) out.push(ax + (dx * k) / cnt, ay + (dy * k) / cnt);
  }
  if (!out.length) out.push(P[0], P[1]);
  s._vsmp = Float64Array.from(out);
  return s._vsmp;
}

function strokeBox(s) {
  if (s._box) return s._box;
  const P = s.pts;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < P.length; i += 2) {
    x0 = Math.min(x0, P[i]);
    x1 = Math.max(x1, P[i]);
    y0 = Math.min(y0, P[i + 1]);
    y1 = Math.max(y1, P[i + 1]);
  }
  s._box = [x0, y0, x1, y1];
  return s._box;
}

// The closest approach of stroke p to the line of stroke q: { d, px, py (the point of p), qx, qy (the point of q) }, or null
// when the boxes are further apart than TOUCH_R11.
function closestApproach(p, q) {
  const a = strokeBox(p);
  const b = strokeBox(q);
  const r = TOUCH_R11;
  if (a[2] + r < b[0] || b[2] + r < a[0] || a[3] + r < b[1] || b[3] + r < a[1]) return null;
  const S = visSamples(p);
  let best = null;
  let hint = -1;
  for (let k = 0; k < S.length; k += 2) {
    const nr = nearestOnStrokeHint(q, S[k], S[k + 1], hint);
    hint = nr.i;
    if (!best || nr.d < best.d) best = { d: nr.d, px: S[k], py: S[k + 1], qx: nr.x, qy: nr.y };
  }
  return best;
}

// Is the stroke a straight open line (every point within 0.05 of the chord)?
function strokeStraight(s) {
  if (s.closed) return false;
  const P = s.pts;
  const n = P.length / 2;
  const dx = P[2 * n - 2] - P[0];
  const dy = P[2 * n - 1] - P[1];
  const L = Math.hypot(dx, dy);
  if (!(L > 1e-6)) return false;
  for (let i = 1; i < n - 1; i++) {
    if (Math.abs(((P[2 * i] - P[0]) * dy - (P[2 * i + 1] - P[1]) * dx) / L) > 0.05) return false;
  }
  return true;
}

// R11-1: do the two ends p and q (of two different strokes) both touch one and the same third stroke (within 1 unit)? Then they
// sit on a shared parent: a junction, not a break. Exception: the third stroke is straight and the two ends lie on opposite
// sides of it (a slash cut, as in the "-off" icons).
function sharedParent(strokes, p, q) {
  for (let k = 0; k < strokes.length; k++) {
    if (k === p.k || k === q.k) continue;
    const t = strokes[k];
    if (!nearWithin(t, p.x, p.y)) continue;
    if (!nearWithin(t, q.x, q.y)) continue;
    if (strokeStraight(t)) {
      const P = t.pts;
      const n = P.length / 2;
      const dx = P[2 * n - 2] - P[0];
      const dy = P[2 * n - 1] - P[1];
      const sp = (p.x - P[0]) * dy - (p.y - P[1]) * dx;
      const sq = (q.x - P[0]) * dy - (q.y - P[1]) * dx;
      if (sp * sq < 0) continue;
    }
    return true;
  }
  return false;
}

/**
 * R11-7: the contact point of a part that touches its parent in the middle (or a closed part). The part samples that lie within 0.05 of
 * the smallest distance to the parent line form the contact run; the middle sample of the run (the run that holds the nearest sample)
 * is the place of contact, and the contact point is the point of the parent line nearest to it. A flat part on a flat parent
 * (every point equally near) gets the middle of the run, not its first point.
 */
function contactPoint(s, q) {
  const V = visSamples(s);
  const m = V.length / 2;
  const d = new Float64Array(m);
  let hint = -1;
  let k0 = 0;
  for (let k = 0; k < m; k++) {
    const nr = nearestOnStrokeHint(q, V[2 * k], V[2 * k + 1], hint);
    hint = nr.i;
    d[k] = nr.d;
    if (d[k] < d[k0]) k0 = k;
  }
  const lim = d[k0] + 0.05;
  let a = k0;
  let b = k0;
  while (a > 0 && d[a - 1] <= lim) a--;
  while (b < m - 1 && d[b + 1] <= lim) b++;
  const km = Math.floor((a + b) / 2);
  const nr = nearestOnStrokeHint(q, V[2 * km], V[2 * km + 1], -1);
  return { x: nr.x, y: nr.y, d: d[k0] };
}

// The distance between a part and the line of a stroke (the smallest distance of a sample of the part).
function partDistance(s, q) {
  const V = visSamples(s);
  let hint = -1;
  let bd = Infinity;
  for (let k = 0; k < V.length; k += 2) {
    const nr = nearestOnStrokeHint(q, V[k], V[k + 1], hint);
    hint = nr.i;
    if (nr.d < bd) bd = nr.d;
  }
  return bd;
}

/**
 * R11-2 / R11-3 / R11b-4: attach the part p (stroke s) to the stroke qi. `kind` forces the attachment (R11b-5, a mirror pair shares one
 * decision): null takes the one that the geometry gives ('end': one end within 1 unit of the parent, 'arch': both ends, 'contact': else).
 * An arch scales about the middle of its two contacts only when that middle lies within 0.5 units of the parent line (R11d-3) (`arch2` false);
 * else it draws out of both contacts (`arch2` true, R11b-4).
 */
function attachNode(S, t, p, qi, kind, arch2) {
  const q = S[qi];
  const s = S[p];
  const P = s.pts;
  const m = P.length / 2;
  const e0 = s.closed ? null : nearestOnStrokeHint(q, P[0], P[1], -1);
  const c0 = e0 && (kind || e0.d <= TOUCH_R11 + 1e-6) ? [e0.x, e0.y] : null;
  const d0 = e0 ? e0.d : Infinity;
  const e1 = s.closed ? null : nearestOnStrokeHint(q, P[2 * m - 2], P[2 * m - 1], -1);
  const c1 = e1 && (kind || e1.d <= TOUCH_R11 + 1e-6) ? [e1.x, e1.y] : null;
  const d1 = e1 ? e1.d : Infinity;
  t.parent = qi;
  t.arch2 = false;
  t.end = -1;
  let k = kind;
  if (!k) k = c0 && c1 ? 'arch' : c0 || c1 ? 'end' : 'contact';
  if (s.closed) k = 'contact';
  if (k === 'arch' && !(c0 && c1)) k = 'contact';
  if (k === 'arch') {
    const mid = nearestOnStrokeHint(q, 0.5 * (c0[0] + c1[0]), 0.5 * (c0[1] + c1[1]), -1);
    t.attach = 'arch';
    t.contact = [mid.x, mid.y];
    t.contacts = [c0, c1];
    t.arch2 = kind ? !!arch2 : mid.d > ARCH2_R11D + 1e-6;
  } else if (k === 'end') {
    t.attach = 'end';
    t.end = c0 && (!c1 || d0 <= d1) ? 0 : 1;
    t.contact = t.end === 0 ? c0 : c1;
    t.contacts = [t.contact];
  } else {
    const ca = contactPoint(s, q);
    t.attach = 'contact';
    t.contact = [ca.x, ca.y];
    t.contacts = [t.contact];
  }
}

/**
 * R11b-5: mirror pairs. A part whose reflection about the vertical or the horizontal center line of the icon (x = 12, y = 12) matches
 * another part within 0.3 units forms a pair with it. A pair shares one attach decision (the member that touches its parent more
 * closely decides: the kind, the level, the arch mode), so the two parts get the same motion kind and the same windows.
 * `tree[i].mirror` is the partner (-1 for none) and `tree[i].pair` the smaller index of the pair.
 */
const MIRROR_TOL = 0.3;
function strokeCentroid(s) {
  if (s._cen) return s._cen;
  const V = visSamples(s);
  let x = 0;
  let y = 0;
  for (let k = 0; k < V.length; k += 2) {
    x += V[k];
    y += V[k + 1];
  }
  const m = V.length / 2;
  s._cen = [x / m, y / m];
  return s._cen;
}
function mirrorGap(A, B, ax) {
  const ba = strokeBox(A);
  const bb = strokeBox(B);
  const r0 = ax === 'v' ? [24 - ba[2], ba[1], 24 - ba[0], ba[3]] : [ba[0], 24 - ba[3], ba[2], 24 - ba[1]];
  if (r0[2] + MIRROR_TOL < bb[0] || bb[2] + MIRROR_TOL < r0[0] || r0[3] + MIRROR_TOL < bb[1] || bb[3] + MIRROR_TOL < r0[1]) return Infinity;
  // R11b-1: the same reflection must give about the same length and the same centroid (cheap tests before the sample test).
  if (Math.abs(A.length - B.length) > 1 + 0.1 * Math.max(A.length, B.length)) return Infinity;
  const ca = strokeCentroid(A);
  const cb = strokeCentroid(B);
  const rx = ax === 'v' ? 24 - ca[0] : ca[0];
  const ry = ax === 'v' ? ca[1] : 24 - ca[1];
  if (Math.hypot(rx - cb[0], ry - cb[1]) > 2 * MIRROR_TOL) return Infinity;
  let worst = 0;
  // A coarse pass (every 8th sample, 4 units apart) rejects most pairs; the fine pass checks every 2nd sample (1 unit apart).
  for (const step of [8, 2]) {
    for (const [X, Y] of [
      [A, B],
      [B, A],
    ]) {
      const V = visSamples(X);
      let hint = -1;
      for (let k = 0; k < V.length; k += 2 * step) {
        const x = ax === 'v' ? 24 - V[k] : V[k];
        const y = ax === 'v' ? V[k + 1] : 24 - V[k + 1];
        const nr = nearestOnStrokeHint(Y, x, y, hint);
        hint = nr.i;
        if (nr.d > MIRROR_TOL) return Infinity;
        if (step === 2 && nr.d > worst) worst = nr.d;
      }
    }
  }
  return worst;
}

function mirrorPairs(S, tree, wt, nearestCore, touch) {
  const n = S.length;
  const parts = [];
  // A core stroke can pair too (two strokes that are untied are parts of the plan): it only gets a pair id (one rank), no attach decision.
  for (let i = 0; i < n; i++) parts.push(i);
  if (parts.length < 2) return;
  const best = [];
  for (let a = 0; a < parts.length; a++) {
    for (let b = a + 1; b < parts.length; b++) {
      const i = parts[a];
      const j = parts[b];
      const g = Math.min(mirrorGap(S[i], S[j], 'v'), mirrorGap(S[i], S[j], 'h'));
      if (g < Infinity) best.push({ i, j, g });
    }
  }
  if (!best.length) return;
  best.sort((x, y) => x.g - y.g || x.i - y.i || x.j - y.j);
  // The strokes that match one another form a group (a pair, or four corners that mirror about both axes): one decision, one rank.
  const root = Array.from({ length: n }, (_, i) => i);
  const find = (a) => {
    while (root[a] !== a) {
      root[a] = root[root[a]];
      a = root[a];
    }
    return a;
  };
  for (const { i, j } of best) {
    if (tree[i].mirror < 0) tree[i].mirror = j;
    if (tree[j].mirror < 0) tree[j].mirror = i;
    const a = find(i);
    const b = find(j);
    if (a !== b) root[Math.max(a, b)] = Math.min(a, b);
  }
  for (let p = 0; p < n; p++) if (tree[p].mirror >= 0) tree[p].pair = find(p);
  // R11d-1: the members of one mirror group never parent each other (the two strokes of an X touch each other). A member whose parent, or
  // a stroke further up its parent chain, is in its own group takes the best parent outside the group (lowest level, then heaviest, whose chain does not pass through the group);
  // with none, it is free (level 1, parent = nearest core). The decision step below then shares it with the other members.
  const hangsOnGroup = (q, gid) => {
    for (let g = q, k = 0; g >= 0 && k <= n; k++) {
      if (tree[g].pair === gid) return true;
      g = tree[g].attach && tree[g].attach !== 'free' ? tree[g].parent : -1;
    }
    return false;
  };
  const releveled = () => {
    for (let it = 0; it < n; it++) {
      let ch = false;
      for (let p = 0; p < n; p++) {
        const t = tree[p];
        if (t.role === 'core' || t.attach === 'free' || t.parent < 0) continue;
        const lv = tree[t.parent].level + 1;
        if (t.level !== lv) {
          t.level = lv;
          ch = true;
        }
      }
      if (!ch) break;
    }
  };
  for (let p = 0; p < n; p++) {
    const t = tree[p];
    const gid = t.pair;
    if (gid < 0 || t.role !== 'part' || !t.attach || t.attach === 'free' || t.parent < 0 || !hangsOnGroup(t.parent, gid)) continue;
    let bq = -1;
    for (let q = 0; q < n; q++) {
      if (q === p || tree[q].pair === gid || tree[q].level < 0 || !touch(p, q) || hangsOnGroup(q, gid)) continue;
      if (bq < 0 || tree[q].level < tree[bq].level || (tree[q].level === tree[bq].level && wt[q] > wt[bq])) bq = q;
    }
    if (bq >= 0) {
      attachNode(S, t, p, bq, null, false);
      t.level = tree[bq].level + 1;
    } else {
      t.attach = 'free';
      t.parent = nearestCore(p);
      t.level = 1;
      t.contact = null;
      t.contacts = null;
      t.end = -1;
      t.arch2 = false;
    }
    releveled();
  }
  // One attach decision per group: the member with the smallest distance to its parent decides (a free part has no distance).
  const dist = (p) => (tree[p].attach && tree[p].attach !== 'free' && tree[p].parent >= 0 ? partDistance(S[p], S[tree[p].parent]) : Infinity);
  const groups = new Map();
  for (let p = 0; p < n; p++) if (tree[p].pair >= 0 && tree[p].role === 'part') groups.set(tree[p].pair, [...(groups.get(tree[p].pair) || []), p]);
  const pairs = [];
  // R11c-1: a part whose parent chain passes through its own mirror group (a dot that touches its mirror twin) decides on its own: it is
  // left out of the group decision, so no decision of the group can move a stroke that another member of the group hangs on.
  const chainHas = (p, test) => {
    for (let g = tree[p].attach && tree[p].attach !== 'free' ? tree[p].parent : -1, k = 0; g >= 0 && k < n; g = tree[g].attach && tree[g].attach !== 'free' ? tree[g].parent : -1, k++) if (test(g)) return true;
    return false;
  };
  for (const [gid, g0] of groups) {
    const g = g0.filter((p) => !chainHas(p, (q) => tree[q].pair === gid));
    for (const p of g0) tree[p].alone = !g.includes(p); // no shared window, level, or rank in the plan
    if (g.length < 2) continue;
    const ds = g.map((p) => ({ p, d: dist(p) }));
    ds.sort((x, y) => x.d - y.d || x.p - y.p);
    for (let k = 1; k < ds.length; k++) pairs.push([ds[0].p, ds[k].p, ds[0].d, ds[k].d]);
  }
  pairs.sort((x, y) => tree[x[0]].level - tree[y[0]].level);
  const relevel = () => {
    for (let it = 0; it < n; it++) {
      let ch = false;
      for (let p = 0; p < n; p++) {
        const t = tree[p];
        if (t.role === 'core' || t.attach === 'free' || t.parent < 0) continue;
        const lv = tree[t.parent].level + 1;
        if (t.level !== lv) {
          t.level = lv;
          ch = true;
        }
      }
      if (!ch) break;
    }
  };
  // R11c-2: the group shares one decision only when, for the other member, the mirrored contacts of the decider lie within 1 unit of that
  // member's own parent line, and the two parents are the same stroke or mirror images of each other. Else each member decides on its own.
  const reflect = [(c) => [24 - c[0], c[1]], (c) => [c[0], 24 - c[1]], (c) => [24 - c[0], 24 - c[1]]];
  const shares = (D, O) => {
    const op = O.parent;
    if (op < 0 || !D.contacts || !D.contacts.length) return false;
    if (!(op === D.parent || (tree[op].pair >= 0 && tree[op].pair === tree[D.parent].pair))) return false;
    return reflect.some((f) => D.contacts.every((c) => nearestOnStrokeHint(S[op], f(c)[0], f(c)[1], -1).d <= TOUCH_R11 + 1e-6));
  };
  for (const [dec, oth] of pairs) {
    const D = tree[dec];
    const O = tree[oth];
    if (!D.attach || D.attach === 'free') continue; // the decider is free only when every member is free: nothing to share
    if (!shares(D, O)) continue;
    if (D.attach === O.attach && D.level === O.level && O.parent === D.parent && (D.attach !== 'arch' || D.arch2 === O.arch2)) continue;
    const par = O.parent;
    if (par === oth || tree[par].level < 0 || chainHas(par, (q) => q === oth)) continue;
    attachNode(S, O, oth, par, D.attach, D.arch2);
    O.level = tree[par].level + 1;
    relevel();
  }
}

/**
 * R11-2: the attachment tree of the strokes of one icon (after chaining). Entry i:
 *   { index, role: 'core'|'part', parent (stroke index, -1 for core), level (0 for core), attach: null|'end'|'arch'|'contact'|'free',
 *     contact: [x, y] | null (a point on the line of the parent), contacts: [[x, y], ...] | null, end: 0 | 1 | -1 }.
 * Levels by breadth-first search from the core (a part that touches a level-k stroke and none of a lower level has level k + 1;
 * among several parents, the heaviest). A part that touches nothing is free: level 1, parent = the nearest core stroke.
 * A group of parts that touch each other but no assigned stroke is rooted at its heaviest stroke (free), and the search goes on from it.
 */
function buildTree(S) {
  const n = S.length;
  const wt = S.map(strokeWeight);
  const mx = wt.reduce((x, y) => Math.max(x, y), 0);
  const tree = S.map((s, i) => ({ index: i, role: S[i]._role === 'kept' ? 'core' : S[i]._role === 'changed' ? 'part' : wt[i] >= 0.5 * mx ? 'core' : 'part', parent: -1, level: -1, attach: null, contact: null, contacts: null, end: -1, arch2: false, mirror: -1, pair: -1, alone: false }));
  const touchCache = new Map();
  const touch = (p, q) => {
    const key = p * n + q;
    if (!touchCache.has(key)) {
      touchCache.set(key, touchesStroke(S[p], S[q]));
    }
    return touchCache.get(key);
  };
  for (let i = 0; i < n; i++) if (tree[i].role === 'core') tree[i].level = 0;
  const bfs = (k0) => {
    for (let k = k0; ; k++) {
      let any = false;
      for (let p = 0; p < n; p++) {
        if (tree[p].level >= 0) continue;
        let bq = -1;
        for (let q = 0; q < n; q++) {
          if (q === p || tree[q].level !== k) continue;
          if (!touch(p, q)) continue;
          if (bq < 0 || (S[q]._role === 'kept' && S[bq]._role !== 'kept') || (S[q]._role === 'kept') === (S[bq]._role === 'kept') && wt[q] > wt[bq]) bq = q;
        }
        if (bq >= 0) {
          tree[p].level = k + 1;
          tree[p].parent = bq;
          any = true;
        }
      }
      if (!any && !tree.some((t) => t.level === k + 1)) break;
    }
  };
  bfs(0);
  // Parts the search did not reach: free (touch nothing assigned).
  const nearestCore = (p) => {
    // R11b-1: one core: no search. Several: cores in the order of the distance between the boxes; a core whose box is further than
    // the best distance so far is skipped, and so is every sample whose distance to the box is not below the best.
    const cores = [];
    for (let q = 0; q < n; q++) if (tree[q].role === 'core' && q !== p) cores.push(q);
    if (cores.length <= 1) return cores.length ? cores[0] : -1;
    const Sp = visSamples(S[p]);
    const pb = strokeBox(S[p]);
    const lb = (q) => {
      const b = strokeBox(S[q]);
      return Math.hypot(Math.max(b[0] - pb[2], 0, pb[0] - b[2]), Math.max(b[1] - pb[3], 0, pb[1] - b[3]));
    };
    const order = cores.map((q) => ({ q, l: lb(q) })).sort((a, b) => a.l - b.l || a.q - b.q);
    let bq = -1;
    let bd = Infinity;
    for (const { q, l } of order) {
      if (l > bd) break;
      let d = Infinity;
      const bx = strokeBox(S[q]);
      let hint = -1;
      for (let k = 0; k < Sp.length; k += 2) {
        const ex = Math.max(bx[0] - Sp[k], 0, Sp[k] - bx[2]);
        const ey = Math.max(bx[1] - Sp[k + 1], 0, Sp[k + 1] - bx[3]);
        if (Math.hypot(ex, ey) > Math.min(bd, d)) continue;
        const nr = nearestOnStrokeHint(S[q], Sp[k], Sp[k + 1], hint);
        hint = nr.i;
        d = Math.min(d, nr.d);
      }
      if (d < bd || (d === bd && q < bq)) {
        bd = d;
        bq = q;
      }
    }
    return bq;
  };
  for (let guard = 0; guard < n; guard++) {
    const rest = [];
    for (let p = 0; p < n; p++) if (tree[p].level < 0) rest.push(p);
    if (!rest.length) break;
    // Prefer a stroke that touches nothing at all; else the heaviest of the remaining strokes.
    let root = -1;
    for (const p of rest) if (!rest.some((q) => q !== p && (touch(p, q) || touch(q, p)))) root = root < 0 ? p : root;
    if (root < 0) root = rest.reduce((a, b) => (wt[b] > wt[a] ? b : a));
    tree[root].level = 1;
    tree[root].attach = 'free';
    tree[root].parent = nearestCore(root);
    bfs(1);
  }
  // R14 fix pass 4b: a part's parent is the piece (kept or changed) that holds its contact point. The search above prefers a
  // kept piece, and among equal levels the heaviest, so a part whose contact lies on a neighbouring piece of the same cut stroke
  // (the pieces share a seam) can land on the wrong piece; its anchor then sits off the part and the part leaves the parent line
  // (t4_through). Reparent such a part to the cut piece that holds its contact point: it rides that piece, and leaves or enters
  // with it (a deeper level, as R11 orders levels). Plans with no kept piece are not touched (the no-cut path equals round 13).
  if (S.some((s) => s._role === 'kept')) {
    const contactD = (p, q) => {
      const b = closestApproach(S[p], S[q]);
      return b ? b.d : Infinity;
    };
    const below = (q, p) => {
      for (let g = 0, c = q; c >= 0 && g <= n; g++, c = tree[c].parent) if (c === p) return true;
      return false;
    };
    for (let p = 0; p < n; p++) {
      const t = tree[p];
      if (t.role === 'core' || t.attach === 'free' || t.parent < 0) continue;
      if (S[t.parent]._role !== 'kept' && S[t.parent]._role !== 'changed') continue;
      let best = -1;
      let bd = contactD(p, t.parent);
      for (let q = 0; q < n; q++) {
        if (q === p || q === t.parent || (S[q]._role !== 'changed' && S[q]._role !== 'kept') || tree[q].level < 0 || below(q, p)) continue;
        if (!touch(p, q)) continue;
        const d = contactD(p, q);
        if (d < bd - 1e-9) {
          bd = d;
          best = q;
        }
      }
      if (best >= 0) t.parent = best;
    }
    // The level follows the new parent (a parent first).
    for (let guard = 0; guard < n; guard++) {
      let change = false;
      for (let p = 0; p < n; p++) {
        const t = tree[p];
        if (t.role === 'core' || t.parent < 0 || tree[t.parent].level < 0) continue;
        const lv = tree[t.parent].level + 1;
        if (t.level !== lv) {
          t.level = lv;
          change = true;
        }
      }
      if (!change) break;
    }
  }
  // Attachment of every attached part to its parent.
  for (let p = 0; p < n; p++) {
    const t = tree[p];
    if (t.role === 'core' || t.attach === 'free' || t.parent < 0) continue;
    // R14 fix pass 3: a changed piece (a piece cut out of a stroke that has a kept run) attaches to the kept piece it joins
    // with an 'end' attachment, never an arch (arch2). It joins the kept piece at the seam, so the seam end is the contact.
    const kind = S[p]._role === 'changed' && S[t.parent]._role === 'kept' ? 'end' : null;
    attachNode(S, t, p, t.parent, kind, false);
  }
  mirrorPairs(S, tree, wt, nearestCore, touch);
  return tree;
}

/**
 * R11-2: the attachment tree of an icon, per stroke (after chaining): { index, role, parent, level, attach, contact }.
 * `attach` is 'end' (touches its parent with one end), 'arch' (both ends), 'contact' (a closed part, or a part that touches
 * in its middle), 'free' (touches nothing), or null for a core stroke. `contact` is a point on the line of the parent.
 * @param {string|IconNode} nodeOrName
 * @returns {{index: number, role: string, parent: number, level: number, attach: string|null, contact: number[]|null}[]}
 */
function iconTree(nodeOrName) {
  const S = iconToStrokes(nodeOrName);
  const T = S.tree || buildTree(S);
  return T.map((t) => ({ index: t.index, role: t.role, parent: t.parent, level: t.level, attach: t.attach, contact: t.contact ? [t.contact[0], t.contact[1]] : null, arch2: !!t.arch2, mirror: t.mirror, pair: t.pair, alone: !!t.alone }));
}

/**
 * Parse an icon into strokes (and chain them). Cached per name.
 * @param {string|IconNode} nodeOrName
 * @param {number} [cornerAngle] degrees
 * @param {number} [chainGap]
 * @param {number} [chainAngle] degrees
 * @returns {Stroke[]}
 */
function iconToStrokes(nodeOrName, cornerAngle = DEFAULTS.cornerAngle, chainGap = DEFAULTS.chainGap, chainAngle = DEFAULTS.chainAngle) {
  const o = { cornerAngle, chainGap, chainAngle };
  if (typeof nodeOrName === 'string') {
    const key = nodeOrName + '|' + cornerAngle + '|' + chainGap + '|' + chainAngle;
    let s = strokeCache.get(key);
    if (!s) {
      const rec = famRec(nodeOrName);
      s = chainStrokes(nodeToStrokes(getNode(nodeOrName), cornerAngle, rec.scale, rec.family.strokeWidth * rec.scale), o);
      s.tree = buildTree(s); // R11-2: cached with the parsed icon
      strokeCache.set(key, s);
    }
    return s;
  }
  const strokes = chainStrokes(nodeToStrokes(nodeOrName, cornerAngle), o);
  for (const s of strokes) s.cacheable = false;
  strokes.tree = buildTree(strokes);
  return strokes;
}

/** Turn a snapshot into strokes: closed when the polyline ends where it starts. Loops can carry a vis mask. */
function snapshotToStrokes(snap, cornerAngle) {
  const out = [];
  for (const loop of snap.loops) {
    const src = loop.points;
    const rv = loop.vis && loop.vis.length === src.length / 2 - 1 ? loop.vis : null;
    const pts = [];
    const vv = [];
    for (let k = 0; k < src.length; k += 2) {
      const l = pts.length;
      if (l === 0 || dist(src[k], src[k + 1], pts[l - 2], pts[l - 1]) >= 1e-6) {
        if (l > 0) vv.push(rv ? rv[k / 2 - 1] : 1);
        pts.push(src[k], src[k + 1]);
      }
    }
    if (pts.length < 2) continue;
    const joints = [];
    for (let k = 0; k < pts.length / 2; k++) joints.push(k);
    // A polyline whose last point equals its first point is a closed stroke. Else it is open.
    let closed = src.length >= 4 && dist(src[0], src[1], src[src.length - 2], src[src.length - 1]) < 1e-6;
    if (!closed && pts.length >= 6) {
      // R6b: a loop whose ends are within 0.5 units counts as closed (the old plan and the new plan must agree).
      const n2 = pts.length / 2;
      const gap = dist(pts[0], pts[1], pts[2 * n2 - 2], pts[2 * n2 - 1]);
      let len = 0;
      for (let k = 1; k < n2 && len < 1; k++) len += dist(pts[2 * k], pts[2 * k + 1], pts[2 * k - 2], pts[2 * k - 1]);
      if (gap <= 0.5 && len >= 1) {
        pts.push(pts[0], pts[1]);
        vv.push(1);
        closed = true;
      }
    }
    const s = makeStroke(pts, joints, closed, cornerAngle, loop.opacity, false, rv ? Uint8Array.from(vv) : null);
    if (s) {
      // R7: the stroke width scale of the snapshot loop. The new plan starts at this width and eases it to 1.
      s.ws0 = Number.isFinite(loop.widthScale) ? loop.widthScale : 1;
      // R7b: the style of the loop: fill flag and its own absolute stroke width (24-grid units; 0 = no stroke).
      s.fill = !!loop.fill;
      s.sw = Number.isFinite(loop.strokeWidth) ? loop.strokeWidth : null;
      // R9b: the relative width (own width / the width of the snapshot). A loop without its own width counts as 1.
      s.rw = s.sw === null ? 1 : snap.strokeWidth > 0 ? s.sw / snap.strokeWidth : s.sw === 0 ? 0 : 1;
      if (s.vis) {
        // Count the hidden runs (bridges).
        let runs = 0;
        const L = s.vis.length;
        for (let i = 0; i < L; i++) if (!s.vis[i] && (i > 0 ? s.vis[i - 1] : s.closed ? s.vis[L - 1] : 1)) runs++;
        s.bridges = runs;
      }
      out.push(s);
    }
  }
  return out;
}

function toStrokes(src, o) {
  if (typeof src === 'string' || Array.isArray(src)) return iconToStrokes(src, o.cornerAngle, o.chainGap, o.chainAngle);
  if (isSnapshot(src)) return snapshotToStrokes(src, o.snapshotCornerAngle);
  throw new Error('planMorph: from and to must be an icon name, an icon node, or a snapshot.');
}

// ---------------------------------------------------------------------------
// Step 3: resample to a canonical loop of M points
// ---------------------------------------------------------------------------

function oddUp(x) {
  const c = Math.ceil(x);
  return c % 2 === 1 ? c : c + 1;
}

/** Number of points that a stroke needs for good fidelity. */
function need(stroke, o) {
  const k = stroke.corners.length;
  const base = Math.ceil(stroke.length / o.sampleSpacing);
  return stroke.closed ? base + 2 * k : 2 * (base + 2 * k + 2);
}

// M is odd: a loop has M - 1 unique points plus the repeated first point.
function clampM(x, o) {
  const lo = oddUp(o.minPoints);
  const hi = o.maxPoints % 2 === 1 ? o.maxPoints : o.maxPoints - 1;
  return Math.min(hi, Math.max(lo, oddUp(x)));
}

// Lazy extended arrays for walking along a stroke by arc length.
function getExt(stroke) {
  if (stroke._ext) return stroke._ext;
  const n = stroke.pts.length / 2;
  let P = stroke.pts;
  let m = n;
  if (stroke.closed) {
    P = new Float64Array(2 * (2 * n + 1));
    P.set(stroke.pts, 0);
    P.set(stroke.pts, 2 * n);
    P[4 * n] = stroke.pts[0];
    P[4 * n + 1] = stroke.pts[1];
    m = 2 * n + 1;
  }
  const cum = new Float64Array(m);
  for (let k = 1; k < m; k++) cum[k] = cum[k - 1] + dist(P[2 * k], P[2 * k + 1], P[2 * k - 2], P[2 * k - 1]);
  let segVis = null;
  if (stroke.vis) {
    segVis = new Uint8Array(m - 1);
    for (let e = 0; e < m - 1; e++) segVis[e] = stroke.vis[e % stroke.vis.length];
  }
  stroke._ext = { P, cum, segVis };
  return stroke._ext;
}

// Visibility of the dense segment under arc length position s.
function visAt(ext, s) {
  const { cum, segVis } = ext;
  let lo = 0;
  let hi = segVis.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cum[mid] <= s) lo = mid;
    else hi = mid - 1;
  }
  return segVis[lo];
}

// Mask for resampled points with arc positions pos[0..cnt-1] and a final position endPos.
function sampleMask(ext, pos, cnt, endPos) {
  const m = new Uint8Array(cnt);
  for (let k = 0; k < cnt; k++) {
    const a = pos[k];
    const b = k + 1 < cnt ? pos[k + 1] : endPos;
    m[k] = visAt(ext, 0.5 * (a + b));
  }
  return m;
}

// Split `total` samples over arcs in proportion to their length. Each arc gets at least 1.
function allocate(lens, total) {
  const k = lens.length;
  const counts = new Int32Array(k);
  let sum = 0;
  let L = 0;
  for (let j = 0; j < k; j++) L += lens[j];
  const ideal = new Float64Array(k);
  for (let j = 0; j < k; j++) {
    ideal[j] = L > 0 ? (total * lens[j]) / L : total / k;
    counts[j] = Math.max(1, Math.floor(ideal[j]));
    sum += counts[j];
  }
  while (sum < total) {
    let best = 0;
    let bv = -Infinity;
    for (let j = 0; j < k; j++) {
      const r = ideal[j] - counts[j];
      if (r > bv) {
        bv = r;
        best = j;
      }
    }
    counts[best]++;
    sum++;
  }
  while (sum > total) {
    let best = -1;
    let bv = Infinity;
    for (let j = 0; j < k; j++) {
      if (counts[j] > 1) {
        const r = ideal[j] - counts[j];
        if (r < bv) {
          bv = r;
          best = j;
        }
      }
    }
    if (best < 0) break;
    counts[best]--;
    sum--;
  }
  return counts;
}

// Keep at most `keep` corners (largest turn angles). Open strokes always keep both ends.
function limitCorners(stroke, keep) {
  const c = Array.from(stroke.corners);
  if (c.length <= keep) return c;
  const n = stroke.pts.length / 2;
  const open = !stroke.closed;
  const ends = open ? [0, n - 1] : [];
  const rest = c.filter((i) => !(open && (i === 0 || i === n - 1)));
  rest.sort((a, b) => turnAt(stroke.pts, n, stroke.closed, b) - turnAt(stroke.pts, n, stroke.closed, a));
  return ends.concat(rest.slice(0, Math.max(0, keep - ends.length))).sort((a, b) => a - b);
}

// Write `count` evenly spaced samples of the arc [i0, i1] into out. First sample is on i0.
function sampleArc(P, cum, i0, i1, count, withEnd, out, w, pos) {
  const s0 = cum[i0];
  const a = cum[i1] - s0;
  let idx = i0;
  for (let t = 0; t < count; t++) {
    if (t === 0) {
      if (pos) pos[w >> 1] = s0;
      out[w++] = P[2 * i0];
      out[w++] = P[2 * i0 + 1];
      continue;
    }
    const s = s0 + (a * t) / count;
    if (pos) pos[w >> 1] = s;
    while (idx < i1 - 1 && cum[idx + 1] < s) idx++;
    const seg = cum[idx + 1] - cum[idx];
    const f = seg > 0 ? (s - cum[idx]) / seg : 0;
    out[w++] = P[2 * idx] + (P[2 * idx + 2] - P[2 * idx]) * f;
    out[w++] = P[2 * idx + 1] + (P[2 * idx + 3] - P[2 * idx + 1]) * f;
  }
  if (withEnd) {
    if (pos) pos[w >> 1] = cum[i1];
    out[w++] = P[2 * i1];
    out[w++] = P[2 * i1 + 1];
  }
  return w;
}

// Closed stroke: U unique points around the loop (corner preserving). Returns 2U numbers.
function resampleClosed(stroke, U) {
  const out = new Float64Array(2 * U);
  const ext = getExt(stroke);
  const { P, cum } = ext;
  const pos = ext.segVis ? new Float64Array(U) : null;
  const n = stroke.pts.length / 2;
  const corners = limitCorners(stroke, U);
  const k = corners.length;
  const arcs = [];
  if (k === 0) arcs.push([0, n]);
  else for (let j = 0; j < k; j++) arcs.push([corners[j], j + 1 < k ? corners[j + 1] : corners[0] + n]);
  const lens = arcs.map(([a, b]) => cum[b] - cum[a]);
  const counts = allocate(lens, U);
  let w = 0;
  for (let j = 0; j < arcs.length; j++) w = sampleArc(P, cum, arcs[j][0], arcs[j][1], counts[j], false, out, w, pos);
  if (pos) out.vis = sampleMask(ext, pos, U, cum[arcs[arcs.length - 1][1]]);
  return out;
}

// Open stroke: nseg + 1 points from the start to the end (corner preserving). Returns 2(nseg+1) numbers.
function resampleOpen(stroke, nseg) {
  const ext = getExt(stroke);
  const { P, cum } = ext;
  const pos = ext.segVis ? new Float64Array(nseg + 1) : null;
  const n = stroke.pts.length / 2;
  const corners = limitCorners(stroke, nseg + 1);
  const arcs = [];
  for (let j = 0; j + 1 < corners.length; j++) arcs.push([corners[j], corners[j + 1]]);
  if (arcs.length === 0) arcs.push([0, n - 1]);
  const out = new Float64Array(2 * (nseg + 1));
  const lens = arcs.map(([a, b]) => cum[b] - cum[a]);
  const counts = allocate(lens, nseg);
  let w = 0;
  for (let j = 0; j < arcs.length; j++) w = sampleArc(P, cum, arcs[j][0], arcs[j][1], counts[j], j === arcs.length - 1, out, w, pos);
  if (pos) out.vis = sampleMask(ext, pos, nseg, pos[nseg]);
  return out;
}

const FORM_LOOP = 0; // closed stroke: M - 1 unique points, then the first point again
const FORM_PASS = 1; // open stroke: M points from start to end
const FORM_FOLD = 2; // open stroke, doubled back: s0..sh, s(h-1)..s0 with h = (M - 1) / 2

function buildForm(stroke, M, form) {
  if (form === FORM_LOOP) {
    const U = M - 1;
    const u = resampleClosed(stroke, U);
    const out = new Float64Array(2 * M);
    out.set(u, 0);
    out[2 * U] = u[0];
    out[2 * U + 1] = u[1];
    if (u.vis) out.vis = u.vis;
    return out;
  }
  if (form === FORM_PASS) return resampleOpen(stroke, M - 1);
  const h = (M - 1) / 2;
  const half = resampleOpen(stroke, h);
  const out = new Float64Array(2 * M);
  if (half.vis) {
    out.vis = new Uint8Array(2 * h);
    for (let i = 0; i < h; i++) {
      out.vis[i] = half.vis[i];
      out.vis[2 * h - 1 - i] = half.vis[i];
    }
  }
  for (let i = 0; i <= h; i++) {
    out[2 * i] = half[2 * i];
    out[2 * i + 1] = half[2 * i + 1];
  }
  for (let i = h + 1; i < M; i++) {
    out[2 * i] = half[2 * (2 * h - i)];
    out[2 * i + 1] = half[2 * (2 * h - i) + 1];
  }
  return out;
}

// Bounded LRU for resampled forms of cacheable strokes.
const LRU_MAX = 500;
const lru = new Map();

function formFor(stroke, M, form) {
  if (!stroke.cacheable) return buildForm(stroke, M, form);
  const key = stroke.id * 4096 + M * 4 + form;
  let v = lru.get(key);
  if (v) {
    lru.delete(key);
    lru.set(key, v);
    return v;
  }
  v = buildForm(stroke, M, form);
  lru.set(key, v);
  if (lru.size > LRU_MAX) lru.delete(lru.keys().next().value);
  return v;
}

// ---------------------------------------------------------------------------
// Step 4: matching
// ---------------------------------------------------------------------------

// Hungarian method (Kuhn-Munkres with potentials). a is N x N row-major. Returns row -> column.
function hungarian(a, N) {
  const u = new Float64Array(N + 1);
  const v = new Float64Array(N + 1);
  const p = new Int32Array(N + 1);
  const way = new Int32Array(N + 1);
  for (let i = 1; i <= N; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Float64Array(N + 1).fill(Infinity);
    const used = new Uint8Array(N + 1);
    do {
      used[j0] = 1;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= N; j++) {
        if (used[j]) continue;
        const cur = a[(i0 - 1) * N + (j - 1)] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= N; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }
  const rowToCol = new Int32Array(N);
  for (let j = 1; j <= N; j++) rowToCol[p[j] - 1] = j - 1;
  return rowToCol;
}
function spread2(L) {
  const M = L.length / 2;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < M; i++) {
    cx += L[2 * i];
    cy += L[2 * i + 1];
  }
  cx /= M;
  cy /= M;
  let s = 0;
  for (let i = 0; i < M; i++) {
    const dx = L[2 * i] - cx;
    const dy = L[2 * i + 1] - cy;
    s += dx * dx + dy * dy;
  }
  return s / M;
}

function centroidLoop(L) {
  const M = L.length / 2;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < M; i++) {
    cx += L[2 * i];
    cy += L[2 * i + 1];
  }
  cx /= M;
  cy /= M;
  const out = new Float64Array(L.length);
  for (let i = 0; i < M; i++) {
    out[2 * i] = cx;
    out[2 * i + 1] = cy;
  }
  return out;
}

// Pair modes.
const MODE_LOOP = 0;
const MODE_PASS = 1;
const MODE_CUT = 2;
const MODE_FOLD = 3;
const MODE_NAMES = ['loop', 'pass', 'cut', 'fold'];

const scanRes = { s: 0, dir: 1 };

/**
 * Best alignment of Y to X. X is a fixed array of N points.
 * ycl true: Y is a closed loop (its first N - 1 points are unique). Candidate i is Y[(s + dir*i) mod U], i = 0..N-1.
 * ycl false: Y has N points, and a candidate is Y forward or reversed.
 * Cost = mean|d|^2 - (1 - tw) |mean d|^2, where d_i = X_i - cand_i. (tw = 1 is the raw cost, tw = 0 ignores travel.)
 * shifts: array of shifts to test (null = all). dirFix: 0 tests both directions, else only that one.
 * Returns the best cost and fills scanRes.
 */
function scanCost(X, Y, N, ycl, tw, shifts, dirFix) {
  const U = N - 1;
  let bc = Infinity;
  let bs = 0;
  let bd = 1;
  const nShift = ycl ? (shifts ? shifts.length : U) : 1;
  const k1 = 1 - tw;
  const invN = 1 / N;
  for (let dir = 1; dir >= -1; dir -= 2) {
    if (dirFix && dir !== dirFix) continue;
    for (let q = 0; q < nShift; q++) {
      const s = ycl ? (shifts ? shifts[q] : q) : 0;
      let sum = 0;
      let sx = 0;
      let sy = 0;
      for (let i = 0; i < N; i++) {
        let j;
        if (ycl) {
          j = s + dir * i;
          if (j >= U) j -= U;
          else if (j < 0) j += U;
        } else j = dir > 0 ? i : N - 1 - i;
        const dx = X[2 * i] - Y[2 * j];
        const dy = X[2 * i + 1] - Y[2 * j + 1];
        sum += dx * dx + dy * dy;
        sx += dx;
        sy += dy;
      }
      const c = (sum - k1 * (sx * sx + sy * sy) * invN) * invN;
      if (c < bc) {
        bc = c;
        bs = s;
        bd = dir;
      }
    }
  }
  scanRes.s = bs;
  scanRes.dir = bd;
  return bc;
}

// Write the candidate (Y aligned by s and dir) into out (N points).
function buildCand(Y, N, ycl, s, dir, out) {
  const U = N - 1;
  for (let i = 0; i < N; i++) {
    let j;
    if (ycl) {
      j = s + dir * i;
      if (j >= U) j -= U;
      else if (j < 0) j += U;
    } else j = dir > 0 ? i : N - 1 - i;
    out[2 * i] = Y[2 * j];
    out[2 * i + 1] = Y[2 * j + 1];
  }
}

// Segment mask of the candidate that buildCand makes (N points, N - 1 segments). yv: mask of Y or null.
function buildCandVis(yv, N, ycl, s, dir) {
  const out = new Uint8Array(N - 1);
  const U = N - 1;
  for (let i = 0; i < U; i++) {
    if (ycl) {
      out[i] = dir > 0 ? yv[(s + i) % U] : yv[(((s - i - 1) % U) + U) % U];
    } else out[i] = dir > 0 ? yv[i] : yv[N - 2 - i];
  }
  return out;
}

// Fit statistics of T against F (centered sums), N points each.
const st = { A: 0, B: 0, A2: 0, B2: 0, SF: 0, ST: 0 };
function stats(F, T, N) {
  let sFx = 0;
  let sFy = 0;
  let sTx = 0;
  let sTy = 0;
  let sFF = 0;
  let sTT = 0;
  let xx = 0;
  let yy = 0;
  let xy = 0;
  let yx = 0;
  for (let i = 0; i < N; i++) {
    const fx = F[2 * i];
    const fy = F[2 * i + 1];
    const tx = T[2 * i];
    const ty = T[2 * i + 1];
    sFx += fx;
    sFy += fy;
    sTx += tx;
    sTy += ty;
    sFF += fx * fx + fy * fy;
    sTT += tx * tx + ty * ty;
    xx += fx * tx;
    yy += fy * ty;
    xy += fx * ty;
    yx += fy * tx;
  }
  st.A = xx + yy - (sFx * sTx + sFy * sTy) / N;
  st.B = xy - yx - (sFx * sTy - sFy * sTx) / N;
  st.A2 = xx - yy - (sFx * sTx - sFy * sTy) / N;
  st.B2 = xy + yx - (sFx * sTy + sFy * sTx) / N;
  st.SF = sFF - (sFx * sFx + sFy * sFy) / N;
  st.ST = sTT - (sTx * sTx + sTy * sTy) / N;
}

const candBuf = new Float64Array(2 * 520);
const flipRes = { rRot: Infinity, rRef: Infinity, s: 0, dir: 1, SF: 0, ST: 0, rotS: 0, rotDir: 1, theta: 0 };

/**
 * Search rotation and reflection fits over the alignments. Fills flipRes with the best relative residual of
 * each fit, and the alignment (s, dir) of the best reflection fit.
 */
function flipScan(X, Y, N, ycl, yIsF, shifts, dirFix) {
  const U = N - 1;
  const nShift = ycl ? (shifts ? shifts.length : U) : 1;
  flipRes.rRot = Infinity;
  flipRes.rRef = Infinity;
  flipRes.s = 0;
  flipRes.dir = 1;
  flipRes.SF = 0;
  flipRes.ST = 0;
  flipRes.rotS = 0;
  flipRes.rotDir = 1;
  flipRes.theta = 0;
  for (let dir = 1; dir >= -1; dir -= 2) {
    if (dirFix && dir !== dirFix) continue;
    for (let q = 0; q < nShift; q++) {
      const s = ycl ? (shifts ? shifts[q] : q) : 0;
      buildCand(Y, N, ycl, s, dir, candBuf);
      if (yIsF) stats(candBuf, X, N);
      else stats(X, candBuf, N);
      if (st.SF < 1e-9 || st.ST < 1e-9) continue;
      const rot = (st.ST - (st.A * st.A + st.B * st.B) / st.SF) / st.ST;
      const ref = (st.ST - (st.A2 * st.A2 + st.B2 * st.B2) / st.SF) / st.ST;
      if (rot < flipRes.rRot) {
        flipRes.rRot = rot;
        flipRes.rotS = s;
        flipRes.rotDir = dir;
        flipRes.theta = Math.atan2(st.B, st.A);
      }
      if (ref < flipRes.rRef) {
        flipRes.rRef = ref;
        flipRes.s = s;
        flipRes.dir = dir;
        flipRes.SF = st.SF;
        flipRes.ST = st.ST;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Step 5: per-pair forms and fine alignment
// ---------------------------------------------------------------------------

/**
 * The arrays for a pair at M points. X is fixed. Y is the side that is aligned (a closed loop, or the
 * second pass). yIsF says that Y is the from side.
 */
function pairForms(a, b, mode, M) {
  if (mode === MODE_LOOP) return { X: formFor(a, M, FORM_LOOP), Y: formFor(b, M, FORM_LOOP), ycl: true, yIsF: false };
  if (mode === MODE_PASS) return { X: formFor(a, M, FORM_PASS), Y: formFor(b, M, FORM_PASS), ycl: false, yIsF: false };
  const of = mode === MODE_CUT ? FORM_PASS : FORM_FOLD;
  if (a.closed) return { X: formFor(b, M, of), Y: formFor(a, M, FORM_LOOP), ycl: true, yIsF: true };
  return { X: formFor(a, M, of), Y: formFor(b, M, FORM_LOOP), ycl: true, yIsF: false };
}

function windowShifts(sc, M, K) {
  const U = M - 1;
  const sf = Math.round((sc * U) / (K - 1));
  const r = Math.ceil(M / K) + 2;
  const out = [];
  for (let q = 0; q <= 2 * r; q++) {
    // Order of offsets: 0, +1, -1, +2, -2 ... Ties keep the nearest to the coarse guess.
    const off = q === 0 ? 0 : q % 2 === 1 ? (q + 1) / 2 : -q / 2;
    out.push((((sf + off) % U) + U) % U);
  }
  return out;
}

// Fine alignment by the shape cost. Returns { F, T }.
function alignFine(f, M, sc, dir, K) {
  const shifts = f.ycl ? windowShifts(sc, M, K) : null;
  scanCost(f.X, f.Y, M, f.ycl, 0, shifts, dir);
  return finishAlign(f, M, scanRes.s, scanRes.dir);
}

function finishAlign(f, M, s, dir) {
  const Yc = new Float64Array(2 * M);
  buildCand(f.Y, M, f.ycl, s, dir, Yc);
  if (f.Y.vis) Yc.vis = buildCandVis(f.Y.vis, M, f.ycl, s, dir);
  return f.yIsF ? { F: Yc, T: f.X } : { F: f.X, T: Yc };
}

// ---------------------------------------------------------------------------
// Step 6: per-slot interpolation setup
// ---------------------------------------------------------------------------

// flipPhi: axis angle of the reflection when the slot is a flip, else null.
// forceTheta: a rotation angle that is used without the maxRotation clamp (big turn), else null.
function prepareSlotMotion(slot, o, flipPhi, forceTheta) {
  const { F, T, M } = slot;
  slot.motion = 'linear';
  slot.theta = 0;
  slot.scale = 1;
  slot.flip = false;
  if (!o.rigid || slot.static) return;
  let cFx = 0;
  let cFy = 0;
  let cTx = 0;
  let cTy = 0;
  for (let i = 0; i < M; i++) {
    cFx += F[2 * i];
    cFy += F[2 * i + 1];
    cTx += T[2 * i];
    cTy += T[2 * i + 1];
  }
  cFx /= M;
  cFy /= M;
  cTx /= M;
  cTy /= M;
  const Fc = new Float64Array(2 * M);
  const Tc = new Float64Array(2 * M);
  let A = 0;
  let B = 0;
  let sF = 0;
  let sT = 0;
  for (let i = 0; i < M; i++) {
    const fx = F[2 * i] - cFx;
    const fy = F[2 * i + 1] - cFy;
    const tx = T[2 * i] - cTx;
    const ty = T[2 * i + 1] - cTy;
    Fc[2 * i] = fx;
    Fc[2 * i + 1] = fy;
    Tc[2 * i] = tx;
    Tc[2 * i + 1] = ty;
    A += fx * tx + fy * ty;
    B += fx * ty - fy * tx;
    sF += fx * fx + fy * fy;
    sT += tx * tx + ty * ty;
  }
  if (sF < 1e-9 || sT < 1e-9) return;
  const s = Math.sqrt(sT / sF);
  const Tp = new Float64Array(2 * M);
  if (flipPhi !== null) {
    const ax = Math.cos(flipPhi);
    const ay = Math.sin(flipPhi);
    for (let i = 0; i < M; i++) {
      const x = Tc[2 * i];
      const y = Tc[2 * i + 1];
      const pa = x * ax + y * ay;
      const pn = -x * ay + y * ax;
      // H(v) = (v.a) a - (v.n) n, with n = (-ay, ax)
      Tp[2 * i] = (pa * ax + pn * ay) / s;
      Tp[2 * i + 1] = (pa * ay - pn * ax) / s;
    }
    slot.motion = 'flip';
    slot.flip = true;
    slot.scale = s;
    slot._r = { cFx, cFy, cTx, cTy, Fc, Tp, ax, ay };
    return;
  }
  let theta = Math.atan2(B, A);
  if (!Number.isFinite(theta)) theta = 0;
  if (forceTheta !== null && Number.isFinite(forceTheta)) theta = forceTheta;
  else if (Math.abs(theta) > o.maxRotation * DEG || Math.sqrt(sF / M) < o.minRigidSpread || Math.sqrt(sT / M) < o.minRigidSpread) theta = 0;
  const co = Math.cos(-theta);
  const si = Math.sin(-theta);
  for (let i = 0; i < M; i++) {
    const x = Tc[2 * i] / s;
    const y = Tc[2 * i + 1] / s;
    Tp[2 * i] = co * x - si * y;
    Tp[2 * i + 1] = si * x + co * y;
  }
  slot.motion = 'rigid';
  slot.theta = theta;
  slot.scale = s;
  slot._r = { cFx, cFy, cTx, cTy, Fc, Tp };
}

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// Cumulative arc length along a polyline of M points.
function cumLen(L, M) {
  const c = new Float64Array(M);
  for (let i = 1; i < M; i++) c[i] = c[i - 1] + dist(L[2 * i], L[2 * i + 1], L[2 * i - 2], L[2 * i - 1]);
  return c;
}

// Draw on (src = T) or erase (src = F): point i sits at arc length min(s_i, a) (draw) or max(s_i, a) (erase), a = v * L.
// v is the draw or erase progress (R4-1: a smoothstep of u inside a time window).
function evalDraw(slot, v, src, draw) {
  const { M, cum, L } = slot;
  const out = slot.buf;
  const ar = v * L;
  let k = 0;
  while (k < M - 1 && cum[k + 1] <= ar) k++;
  let tx;
  let ty;
  if (k >= M - 1) {
    tx = src[2 * (M - 1)];
    ty = src[2 * (M - 1) + 1];
  } else {
    const seg = cum[k + 1] - cum[k];
    const f = seg > 0 ? (ar - cum[k]) / seg : 0;
    tx = src[2 * k] + (src[2 * k + 2] - src[2 * k]) * f;
    ty = src[2 * k + 1] + (src[2 * k + 3] - src[2 * k + 1]) * f;
  }
  for (let i = 0; i < M; i++) {
    const keep = draw ? cum[i] <= ar : cum[i] >= ar;
    if (keep) {
      out[2 * i] = src[2 * i];
      out[2 * i + 1] = src[2 * i + 1];
    } else {
      out[2 * i] = tx;
      out[2 * i + 1] = ty;
    }
  }
}

// The rigid blend (rotation + scale + translation + residual) of a prepared slot-like object at progress u.
function rigidEval(slot, u, out) {
  const M = slot.M;
  const r = slot._r;
  const cx = r.cFx + (r.cTx - r.cFx) * u;
  const cy = r.cFy + (r.cTy - r.cFy) * u;
  const sc = 1 + (slot.scale - 1) * u;
  const ang = slot.theta * u;
  const co = Math.cos(ang);
  const si = Math.sin(ang);
  const v = 1 - u;
  const { Fc, Tp } = r;
  for (let i = 0; i < M; i++) {
    const fx = Fc[2 * i] * v + Tp[2 * i] * u;
    const fy = Fc[2 * i + 1] * v + Tp[2 * i + 1] * u;
    out[2 * i] = cx + sc * (co * fx - si * fy);
    out[2 * i + 1] = cy + sc * (si * fx + co * fy);
  }
}

// R13-3: the rigid blend with follow-through. The pose (translation, rotation, log scale) runs on ue, which may pass 1 (the
// swing past the end pose). The shape (the residual) runs on um, the monotone progress, so it stays intact.
function rigidPose(slot, ue, um, out, ues = ue) {
  const M = slot.M;
  const r = slot._r;
  const cx = r.cFx + (r.cTx - r.cFx) * ue;
  const cy = r.cFy + (r.cTy - r.cFy) * ue;
  const sc = slot.scale > 0 ? Math.exp(Math.log(slot.scale) * ues) : 1; // ues: the scale part of the swing (gain slot._gs, R13 fix pass 3)
  const ang = slot.theta * ue;
  const co = Math.cos(ang);
  const si = Math.sin(ang);
  const v = 1 - um;
  const { Fc, Tp } = r;
  for (let i = 0; i < M; i++) {
    const fx = Fc[2 * i] * v + Tp[2 * i] * um;
    const fy = Fc[2 * i + 1] * v + Tp[2 * i + 1] * um;
    out[2 * i] = cx + sc * (co * fx - si * fy);
    out[2 * i + 1] = cy + sc * (si * fx + co * fy);
  }
}

// R6-1: a hard slot moves in three steps: F to proxy(F), proxy(F) to proxy(T), proxy(T) to T. tau is the slot's
// linear progress (no easing). Each step has its own easing.
function evalLod(slot, tau, out) {
  const d = slot._lod;
  const M = slot.M;
  const s0 = slot.lodSplit[0];
  const s1 = slot.lodSplit[1];
  if (tau <= s0) {
    const p = d.ease(s0 > 0 ? tau / s0 : 1);
    const { F } = slot;
    const PF = d.PF;
    for (let k = 0; k < 2 * M; k++) out[k] = F[k] + (PF[k] - F[k]) * p;
  } else if (tau < s1) {
    const p = d.ease((tau - s0) / (s1 - s0));
    const mid = d.mid;
    if (mid.motion === 'rigid') rigidEval(mid, p, out);
    else {
      const PF = d.PF;
      const PT = d.PT;
      for (let k = 0; k < 2 * M; k++) out[k] = PF[k] + (PT[k] - PF[k]) * p;
    }
  } else {
    const p = d.ease(s1 < 1 ? (tau - s1) / (1 - s1) : 1);
    const PT = d.PT;
    const { T } = slot;
    for (let k = 0; k < 2 * M; k++) out[k] = PT[k] + (T[k] - PT[k]) * p;
  }
}

// Evaluate the slot polyline at eased progress u (and linear progress tau) into slot.buf. Returns the slot opacity.
// R13-2: um is the monotone progress (u, but 1 for good once u has reached 1; equal to u for an easing that stays in [0, 1]).
// Every show, hide, draw, erase, and fade decision runs on um. fx (the easing info of the plan, or null) switches on the
// follow-through of a rigid slot (R13-3), which runs on u with the slot gain slot._g (R13-6).
function evalSlot(slot, u, tau, um = u, fx = null, tg = null) {
  if (slot.motion === 'twin') return slot._split ? evalSplitTwin(slot, um) : evalTwin(slot, tau);
  if (slot.kind === 'exit' || slot.kind === 'enter') return evalAnchored(slot, um);
  const { F, T, M } = slot;
  const out = slot.buf;
  const pose = fx !== null && slot.motion === 'rigid' && !slot.lod;
  // R14-7: a kept piece is the from piece in every frame before t = 1 (0 px of motion) and the to piece at t = 1 (a switch of at
  // most 0.25 units). tg is the global time (the slot's own tau reaches 1 early with a stagger).
  if (slot.keep) out.set(tg !== null && tg >= 1 ? T : F);
  else if (u <= 0) out.set(F);
  else if (u >= 1 && !(pose && u > 1)) out.set(T);
  else if (pose) {
    const past = tau >= fx.tc;
    const g = slot._g === undefined ? 1 : slot._g;
    const gs = slot._gs === undefined ? 1 : slot._gs;
    const ue = past ? 1 + g * (u - 1) : u;
    // gs blends the scale part of the swing from the smooth easing (gs = 0) to the full follow-through (gs = 1)
    // and so does the progress of the residual shape (um), so at gs = 0 the scale and the shape equal the smooth ones
    let ues = ue;
    let umr = um;
    if (gs < 1) {
      const sm = easings.smooth(tau);
      ues = sm + gs * (ue - sm);
      umr = sm + gs * (um - sm);
    }
    rigidPose(slot, ue, umr, out, ues);
  }
  else if (slot.lod) evalLod(slot, tau, out);
  else if (slot.motion === 'superellipse') evalSuper(slot, u);
  else if (slot.motion === 'intrinsic') evalIntrinsic(slot, u);
  else if (slot.motion === 'rigid') rigidEval(slot, u, out);
  else if (slot.motion === 'flip') {
    const r = slot._r;
    const cx = r.cFx + (r.cTx - r.cFx) * u;
    const cy = r.cFy + (r.cTy - r.cFy) * u;
    const sc = 1 + (slot.scale - 1) * u;
    const cu = Math.cos(Math.PI * u);
    const v = 1 - u;
    const { Fc, Tp, ax, ay } = r;
    for (let i = 0; i < M; i++) {
      const lx = Fc[2 * i] * v + Tp[2 * i] * u;
      const ly = Fc[2 * i + 1] * v + Tp[2 * i + 1] * u;
      const la = lx * ax + ly * ay;
      const ln = -lx * ay + ly * ax;
      // X = c + s * [ la * a + cos(pi u) * ln * n ], with n = (-ay, ax)
      out[2 * i] = cx + sc * (la * ax - cu * ln * ay);
      out[2 * i + 1] = cy + sc * (la * ay + cu * ln * ax);
    }
  } else if (slot.motion === 'draw') {
    evalDraw(slot, smoothstep(0.4, 1, um), T, true);
  } else if (slot.motion === 'erase') {
    evalDraw(slot, smoothstep(0, 0.6, um), F, false);
  } else {
    // Plain linear blend. F + (T - F) u is exactly F when F and T are equal.
    for (let k = 0; k < 2 * M; k++) out[k] = F[k] + (T[k] - F[k]) * u;
  }
  let op;
  if (slot.kind === 'collapse') {
    op = slot.motion === 'erase' ? 1 - smoothstep(0.35, 0.6, um) : 1 - smoothstep(0, 0.6, um);
    op *= slot.fromOp;
  } else if (slot.kind === 'grow') op = slot.motion === 'draw' ? smoothstep(0.4, 0.55, um) : smoothstep(0.4, 1, um);
  else op = slot.fromOp + ((slot.toOp === undefined ? 1 : slot.toOp) - slot.fromOp) * um;
  return Math.min(1, Math.max(0, op));
}

// Visibility classes: 0 solid (1 to 1), 1 fading out (1 to 0), 2 fading in (0 to 1), 3 hidden (0 to 0).
function buildClasses(slot) {
  const n = slot.M - 1;
  const { visF, visT } = slot;
  const cls = new Uint8Array(n);
  for (let k = 0; k < n; k++) cls[k] = visF[k] ? (visT[k] ? 0 : 1) : visT[k] ? 2 : 3;
  const runs = [null, null, null];
  for (let c = 0; c < 3; c++) {
    let list = null;
    let k = 0;
    while (k < n) {
      if (cls[k] !== c) {
        k++;
        continue;
      }
      const a = k;
      while (k < n && cls[k] === c) k++;
      if (!list) list = [];
      list.push(a, k); // segments a .. k - 1
    }
    runs[c] = list;
  }
  slot.cls = cls;
  slot.runs = runs;
}

// Path data for the runs of one class. Each run of segments a..b-1 is one subpath: points a..b.
function runsToD(L, list) {
  let d = '';
  for (let r = 0; r < list.length; r += 2) {
    const a = list[r];
    const b = list[r + 1];
    const parts = new Array(2 * (b - a + 1));
    for (let k = 0; k < parts.length; k++) parts[k] = fmt(L[2 * a + k]);
    d += (r ? ' M' : 'M') + parts.join(' ');
  }
  return d;
}

function classFactor(c, u) {
  if (c === 1) return 1 - smoothstep(0, 0.6, u);
  if (c === 2) return smoothstep(0.4, 1, u);
  return 1;
}

// ---------------------------------------------------------------------------
// R5 Rule 6: intrinsic interpolation (edge lengths and edge angles, after Sederberg et al. 1993)
// ---------------------------------------------------------------------------

// Edge lengths and edge angles of a polyline of M points. A zero-length edge takes the angle of its nearest
// non-zero neighbor.
function edgeData(P, M, len, ang) {
  const E = M - 1;
  let any = false;
  for (let i = 0; i < E; i++) {
    const dx = P[2 * i + 2] - P[2 * i];
    const dy = P[2 * i + 3] - P[2 * i + 1];
    len[i] = Math.hypot(dx, dy);
    if (len[i] > 1e-9) {
      ang[i] = Math.atan2(dy, dx);
      any = true;
    } else ang[i] = NaN;
  }
  if (!any) {
    ang.fill(0);
    return;
  }
  for (let i = 0; i < E; i++) {
    if (!Number.isNaN(ang[i])) continue;
    for (let d = 1; d < E; d++) {
      if (i - d >= 0 && len[i - d] > 1e-9) {
        ang[i] = Math.atan2(P[2 * (i - d) + 3] - P[2 * (i - d) + 1], P[2 * (i - d) + 2] - P[2 * (i - d)]);
        break;
      }
      if (i + d < E && len[i + d] > 1e-9) {
        ang[i] = Math.atan2(P[2 * (i + d) + 3] - P[2 * (i + d) + 1], P[2 * (i + d) + 2] - P[2 * (i + d)]);
        break;
      }
    }
  }
}

function wrapPi(x) {
  x %= TAU;
  if (x > Math.PI) x -= TAU;
  else if (x <= -Math.PI) x += TAU;
  return x;
}

// Turn a prepared rigid slot into an intrinsic one. slot.theta is the base rotation of the rigid fit.
function prepareIntrinsic(slot) {
  const { F, T, M } = slot;
  const E = M - 1;
  const LF = new Float64Array(E);
  const LT = new Float64Array(E);
  const aF = new Float64Array(E);
  const aT = new Float64Array(E);
  edgeData(F, M, LF, aF);
  edgeData(T, M, LT, aT);
  const dA = new Float64Array(E);
  const theta = slot.theta;
  let prev = 0;
  for (let i = 0; i < E; i++) {
    const d = aT[i] - aF[i] - theta;
    const delta = i === 0 ? wrapPi(d) : d - TAU * Math.round((d - prev) / TAU);
    prev = delta;
    dA[i] = theta + delta;
  }
  slot.motion = 'intrinsic';
  slot._i = {
    LF,
    LT,
    aF,
    dA,
    cum: new Float64Array(M),
    cFx: slot._r.cFx,
    cFy: slot._r.cFy,
    cTx: slot._r.cTx,
    cTy: slot._r.cTy,
    chF: [F[2 * (M - 1)] - F[0], F[2 * (M - 1) + 1] - F[1]],
    chT: [T[2 * (M - 1)] - T[0], T[2 * (M - 1) + 1] - T[1]],
  };
}

function evalIntrinsic(slot, u) {
  const { M } = slot;
  const I = slot._i;
  const out = slot.buf;
  const { LF, LT, aF, dA, cum } = I;
  let x = 0;
  let y = 0;
  let c = 0;
  out[0] = 0;
  out[1] = 0;
  cum[0] = 0;
  for (let i = 0; i < M - 1; i++) {
    const len = LF[i] + (LT[i] - LF[i]) * u;
    const ang = aF[i] + u * dA[i];
    x += len * Math.cos(ang);
    y += len * Math.sin(ang);
    c += len;
    out[2 * i + 2] = x;
    out[2 * i + 3] = y;
    cum[i + 1] = c;
  }
  // Chord fix: the error of the end point is spread in proportion to the cumulative edge length.
  const ex = I.chF[0] + (I.chT[0] - I.chF[0]) * u - x;
  const ey = I.chF[1] + (I.chT[1] - I.chF[1]) * u - y;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < M; i++) {
    if (c > 1e-12) {
      const f = cum[i] / c;
      out[2 * i] += ex * f;
      out[2 * i + 1] += ey * f;
    }
    mx += out[2 * i];
    my += out[2 * i + 1];
  }
  const sx = I.cFx + (I.cTx - I.cFx) * u - mx / M;
  const sy = I.cFy + (I.cTy - I.cFy) * u - my / M;
  for (let i = 0; i < M; i++) {
    out[2 * i] += sx;
    out[2 * i + 1] += sy;
  }
}

// ---------------------------------------------------------------------------
// R5 Rule 4: exit and enter slots ride on a point of a core slot
// ---------------------------------------------------------------------------

// A part of the old icon (exit) or the new icon (enter) at eased progress v. A(t) is the current position of the anchor point.
// R11b-4: a two-sided arch. Both ends ride on their anchors of the parent; the points between follow by arc length. The slot runs
// (visibility class 1 for an exit, 2 for an entry) draw it from both ends toward the middle, or erase it from the middle.
function evalArch2(slot, u) {
  const exit = slot.kind === 'exit';
  const as = slot._anchorSlot;
  const B = as.buf;
  const src = exit ? slot.F : slot.T;
  const out = slot.buf;
  const M = slot.M;
  const lam = slot.lam;
  const [e0, e1] = slot.ends;
  let j = 2 * e0.i;
  const ax = B[j] + (e0.f > 0 ? e0.f * (B[j + 2] - B[j]) : 0);
  const ay = B[j + 1] + (e0.f > 0 ? e0.f * (B[j + 3] - B[j + 1]) : 0);
  j = 2 * e1.i;
  const bx = B[j] + (e1.f > 0 ? e1.f * (B[j + 2] - B[j]) : 0);
  const by = B[j + 1] + (e1.f > 0 ? e1.f * (B[j + 3] - B[j + 1]) : 0);
  // The ends are not exactly on the parent line (they lie up to 1 unit from it). An end is pinned to its anchor at the start of an
  // entry and at the end of an exit, and goes back to its own place as the part gets its full size (as the draw motion does).
  const w = exit ? u : 1 - u;
  const rax = exit ? e0.x0 : e0.x1;
  const ray = exit ? e0.y0 : e0.y1;
  const rbx = exit ? e1.x0 : e1.x1;
  const rby = exit ? e1.y0 : e1.y1;
  const dax = ax - rax + w * (rax - src[0]);
  const day = ay - ray + w * (ray - src[1]);
  const dbx = bx - rbx + w * (rbx - src[2 * M - 2]);
  const dby = by - rby + w * (rby - src[2 * M - 1]);
  for (let i = 0; i < M; i++) {
    const l = lam[i];
    out[2 * i] = src[2 * i] + (1 - l) * dax + l * dbx;
    out[2 * i + 1] = src[2 * i + 1] + (1 - l) * day + l * dby;
  }
  return exit ? slot.fromOp : slot.toOp === undefined ? 1 : slot.toOp;
}

function shiftBuf(out, M, dx, dy) {
  for (let i = 0; i < M; i++) {
    out[2 * i] += dx;
    out[2 * i + 1] += dy;
  }
}

// The attach point of a slot in the current frame (read from the buffer of its parent), or its rest anchor.
function anchorOf(slot) {
  const as = slot._anchorSlot;
  let ax;
  let ay;
  if (slot.motion === 'arch2' && as && slot.ends) {
    const B = as.buf;
    const [e0, e1] = slot.ends;
    let j = 2 * e0.i;
    const x0 = B[j] + (e0.f > 0 ? e0.f * (B[j + 2] - B[j]) : 0);
    const y0 = B[j + 1] + (e0.f > 0 ? e0.f * (B[j + 3] - B[j + 1]) : 0);
    j = 2 * e1.i;
    const x1 = B[j] + (e1.f > 0 ? e1.f * (B[j + 2] - B[j]) : 0);
    const y1 = B[j + 1] + (e1.f > 0 ? e1.f * (B[j + 3] - B[j + 1]) : 0);
    ax = 0.5 * (x0 + x1);
    ay = 0.5 * (y0 + y1);
  } else if (as) {
    const j = 2 * slot.anchorIndex;
    ax = as.buf[j];
    ay = as.buf[j + 1];
    if (slot.anchorFrac > 0) {
      ax += slot.anchorFrac * (as.buf[j + 2] - as.buf[j]);
      ay += slot.anchorFrac * (as.buf[j + 3] - as.buf[j + 1]);
    }
  } else {
    ax = slot.a0x;
    ay = slot.a0y;
  }
  return [ax, ay];
}

// R13-6 fix: with an easing that leaves [0, 1], an entering or exiting part that rides a fast parent can lie more than 4 units
// outside the box, and no gain of the follow-through changes that. In every frame such a part is scaled about its attach point,
// just enough to bring every point inside 4 units. A part that is inside the limit is not touched.
const CLAMP_LIM = 3.9;
function clampSlot(slot) {
  const [ax, ay] = anchorOf(slot);
  if (!Number.isFinite(ax) || !Number.isFinite(ay)) return;
  const b = slot.buf;
  const lo = -CLAMP_LIM;
  const hi = 24 + CLAMP_LIM;
  let s = 1;
  for (let k = 0; k + 1 < b.length; k += 2) {
    for (let c = 0; c < 2; c++) {
      const v = b[k + c];
      const a = c === 0 ? ax : ay;
      if (v > hi) s = Math.min(s, a < hi ? (hi - a) / (v - a) : 0);
      else if (v < lo) s = Math.min(s, a > lo ? (a - lo) / (a - v) : 0);
    }
  }
  if (s >= 1) return;
  for (let k = 0; k + 1 < b.length; k += 2) {
    b[k] = ax + s * (b[k] - ax);
    b[k + 1] = ay + s * (b[k + 1] - ay);
  }
}

// R13-4: an entering part overshoots its size about its attach point. f scales the polyline about the attach point A(t).
function popEnter(slot, f) {
  if (f === 1 || slot.motion === 'twin' || slot.r8d) return;
  const [ax, ay] = anchorOf(slot);
  if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(f)) return;
  const out = slot.buf;
  for (let i = 0; i < slot.M; i++) {
    out[2 * i] = ax + f * (out[2 * i] - ax);
    out[2 * i + 1] = ay + f * (out[2 * i + 1] - ay);
  }
}

// R13-6: find the gain slot._g of the follow-through (pose overshoot, entry pop) of every slot so that no drawn point lies more
// than 4 units outside the 24-unit box (a slot that is already farther out without any follow-through keeps its own limit).
// A child rides its parent, so a parent's gain goes down with its child's.
function calibrateGain(slots, evalAll, fx, hidden) {
  const n = slots.length;
  let tmin = 1;
  for (const s of slots) tmin = Math.min(tmin, s.window[0] + fx.tc * (s.window[1] - s.window[0]));
  const ts = [];
  for (let k = 0; k <= 80; k++) if (k / 80 >= tmin - 1e-9) ts.push(k / 80);
  const measure = (g) => {
    for (let i = 0; i < n; i++) slots[i]._g = g[i];
    const ex = new Float64Array(n);
    for (const t of ts) {
      evalAll(t);
      for (let i = 0; i < n; i++) {
        if (hidden(t, i)) continue;
        const b = slots[i].buf;
        let w = 0;
        for (let k = 0; k + 1 < b.length; k += 2) {
          const o = Math.max(-b[k], b[k] - 24, -b[k + 1], b[k + 1] - 24);
          if (o > w) w = o;
        }
        if (w > ex[i]) ex[i] = w;
      }
    }
    return ex;
  };
  const LIM = 4;
  const ones = new Float64Array(n).fill(1);
  const e1 = measure(ones);
  if (!e1.some((v) => v > LIM)) return;
  const e0 = measure(new Float64Array(n));
  const g = new Float64Array(n).fill(1);
  const lim = (i) => Math.max(LIM, e0[i]);
  for (let i = 0; i < n; i++) {
    if (e1[i] <= lim(i)) continue;
    const tgt = Math.max(LIM - 0.2, e0[i]);
    g[i] = e1[i] > e0[i] ? Math.min(1, Math.max(0, (tgt - e0[i]) / (e1[i] - e0[i]))) : 0;
  }
  const idxOf = new Map(slots.map((s, i) => [s, i]));
  const shrink = (i, f) => {
    for (let c = slots[i], d = 0; c && d < 16; c = c._anchorSlot, d++) {
      const j = idxOf.get(c);
      if (j !== undefined) g[j] = f === 0 ? 0 : g[j] * f;
    }
  };
  for (let it = 0; it < 8; it++) {
    const e = measure(g);
    const bad = [];
    for (let i = 0; i < n; i++) if (e[i] > lim(i) + 1e-9) bad.push(i);
    if (!bad.length) break;
    for (const i of bad) shrink(i, it < 7 ? 0.7 : 0);
  }
  measure(g);
}

// R13 fix pass 3 (attachment): a child that hangs off a part of its parent keeps its smooth distance to the parent's drawn stroke.
// The anchor can lie in free space (the middle of the two ends of an arch, up to about 5 units from the stroke). The scale part of
// the parent's follow-through (the pose overshoot of a rigid parent, the entry pop of an entering parent) multiplies that distance
// (5 units times 1.03 is 0.15 units). The gain slot._gs scales only the scale part of the follow-through of such a parent, so that
// the distance never exceeds its value under the smooth easing (same frames) by more than ATT_LIM units (0.08 units is 0.32 px at 96 px).
// For a rigid parent, gs also blends the progress of the residual shape toward the smooth one (the parent then reaches its end
// shape no earlier than under the smooth easing). The translation and rotation of the swing are not touched. This runs at plan time, only when a child exceeds the limit.
const ATT_LIM = 0.08;
function distToBuf(slot, x, y) {
  let best = Infinity;
  const B = slot.buf;
  const runs = slot.runs;
  if (!runs) return best;
  for (let c = 0; c < 3; c++) {
    const list = runs[c];
    if (!list) continue;
    for (let r = 0; r < list.length; r += 2) {
      for (let k = list[r]; k < list[r + 1]; k++) {
        const ax = B[2 * k];
        const ay = B[2 * k + 1];
        const dx = B[2 * k + 2] - ax;
        const dy = B[2 * k + 3] - ay;
        const l2 = dx * dx + dy * dy;
        let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d = Math.hypot(ax + t * dx - x, ay + t * dy - y);
        if (d < best) best = d;
      }
    }
  }
  return best;
}
function calibrateAttach(slots, evalAll, hidden, setRef) {
  const kids = [];
  for (const s of slots) {
    if ((s.kind !== 'exit' && s.kind !== 'enter') || s.motion === 'twin' || !s._anchorSlot) continue;
    if (s.attach !== 'end' && s.attach !== 'arch' && s.attach !== 'contact') continue;
    kids.push(s);
  }
  if (!kids.length) return;
  const idxOf = new Map(slots.map((s, i) => [s, i]));
  const parents = [...new Set(kids.map((k) => k._anchorSlot))];
  let tmin = 1;
  for (const s of slots) tmin = Math.min(tmin, s.window[0]);
  const ts = [];
  for (let k = 0; k <= 40; k++) if (k / 40 >= tmin - 1e-9) ts.push(k / 40);
  const measure = () => {
    const m = new Float64Array(kids.length);
    for (const t of ts) {
      evalAll(t);
      for (let q = 0; q < kids.length; q++) {
        const kid = kids[q];
        if (hidden(t, idxOf.get(kid)) || hidden(t, idxOf.get(kid._anchorSlot))) continue;
        const [ax, ay] = anchorOf(kid);
        if (!Number.isFinite(ax) || !Number.isFinite(ay)) continue;
        const d = distToBuf(kid._anchorSlot, ax, ay);
        if (d < Infinity && d > m[q]) m[q] = d;
      }
    }
    return m;
  };
  const setG = (v) => {
    for (const p of parents) p._gs = v.get(p);
  };
  const gv = new Map(parents.map((p) => [p, 1]));
  setG(gv);
  const full = measure();
  setRef(true); // the reference: the same frames under the smooth easing
  const ref = measure();
  setRef(false);
  const badParents = new Set();
  kids.forEach((k, q) => {
    if (full[q] > ref[q] + ATT_LIM) badParents.add(k._anchorSlot);
  });
  if (!badParents.size) {
    setG(gv);
    return;
  }
  const lo = new Map(parents.map((p) => [p, 0]));
  const hi = new Map(parents.map((p) => [p, 1]));
  for (let it = 0; it < 7; it++) {
    const mid = new Map(parents.map((p) => [p, badParents.has(p) ? 0.5 * (lo.get(p) + hi.get(p)) : 1]));
    setG(mid);
    const m = measure();
    const ok = new Map(parents.map((p) => [p, true]));
    kids.forEach((k, q) => {
      if (m[q] > ref[q] + ATT_LIM) ok.set(k._anchorSlot, false);
    });
    for (const p of badParents) {
      if (ok.get(p)) lo.set(p, mid.get(p));
      else hi.set(p, mid.get(p));
    }
  }
  setG(new Map(parents.map((p) => [p, badParents.has(p) ? lo.get(p) : 1])));
  measure();
}

function evalAnchored(slot, u) {
  if (slot.r8d) return evalDetail(slot, u);
  if (slot.motion === 'arch2') return evalArch2(slot, u);
  const { F, T, M } = slot;
  const out = slot.buf;
  const as = slot._anchorSlot;
  let ax = as ? as.buf[2 * slot.anchorIndex] : slot.a0x;
  let ay = as ? as.buf[2 * slot.anchorIndex + 1] : slot.a0y;
  // R10-1: the anchor can lie between two points of the parent (a fraction along the edge).
  if (as && slot.anchorFrac > 0) {
    const j = 2 * slot.anchorIndex;
    ax += slot.anchorFrac * (as.buf[j + 2] - as.buf[j]);
    ay += slot.anchorFrac * (as.buf[j + 3] - as.buf[j + 1]);
  }
  if (slot.motion === 'under') {
    // R6-2: the part goes under its closed parent (exit), or comes out from under it (entry).
    const exit = slot.kind === 'exit';
    if (exit && u <= 0) {
      out.set(F);
      if (as && as._bal) shiftBuf(out, M, ax - slot.a0x, ay - slot.a0y); // R12c-2: rides on a shifted sibling
      return slot.fromOp;
    }
    underPoint(as.buf, as.M, slot.anchorIndex, ax, ay);
    const w = exit ? u : 1 - u;
    const e = underSlide(w);
    const sc = underScale(w);
    const px = ax + e * (underQ.x - ax);
    const py = ay + e * (underQ.y - ay);
    const src = exit ? F : T;
    const bx = exit ? slot.a0x : slot.a1x;
    const by = exit ? slot.a0y : slot.a1y;
    for (let i = 0; i < M; i++) {
      out[2 * i] = px + sc * (src[2 * i] - bx);
      out[2 * i + 1] = py + sc * (src[2 * i + 1] - by);
    }
    return exit ? slot.fromOp : slot.toOp === undefined ? 1 : slot.toOp;
  }
  if (slot.kind === 'exit') {
    if (u <= 0) {
      out.set(F);
      if (as && as._bal) shiftBuf(out, M, ax - slot.a0x, ay - slot.a0y); // R12c-2: rides on a shifted sibling
      return slot.fromOp;
    }
    if (slot.motion === 'erase') {
      // The part retracts toward its last point (the end near the anchor). That end is pinned to A(t).
      evalDraw(slot, u, F, false);
      const sx = ax - slot.a0x + u * (slot.a0x - slot.ex);
      const sy = ay - slot.a0y + u * (slot.a0y - slot.ey);
      for (let i = 0; i < M; i++) {
        out[2 * i] += sx;
        out[2 * i + 1] += sy;
      }
    } else {
      const k = 1 - u;
      for (let i = 0; i < M; i++) {
        out[2 * i] = ax + k * (F[2 * i] - slot.a0x);
        out[2 * i + 1] = ay + k * (F[2 * i + 1] - slot.a0y);
      }
    }
    return slot.fromOp;
  }
  if (slot.motion === 'draw') {
    // The part draws out of its first point (the end near the anchor). That end is pinned to A(t).
    evalDraw(slot, u, T, true);
    const sx = ax - slot.a1x + (1 - u) * (slot.a1x - slot.ex);
    const sy = ay - slot.a1y + (1 - u) * (slot.a1y - slot.ey);
    for (let i = 0; i < M; i++) {
      out[2 * i] += sx;
      out[2 * i + 1] += sy;
    }
  } else {
    for (let i = 0; i < M; i++) {
      out[2 * i] = ax + u * (T[2 * i] - slot.a1x);
      out[2 * i + 1] = ay + u * (T[2 * i + 1] - slot.a1y);
    }
  }
  return slot.toOp === undefined ? 1 : slot.toOp;
}

// Is point i of the slot usable as an anchor? Its neighbor segments must be real. pass 0: in F and in T.
// pass 1: on the given side only. pass 2: any point.
function anchorOk(sl, i, pass, side) {
  if (pass === 2) return true;
  const E = sl.M - 1;
  const vs = pass === 0 ? null : side === 'F' ? sl.visF : sl.visT;
  for (let k = i - 1; k <= i; k++) {
    if (k < 0 || k >= E) continue;
    if (pass === 0) {
      if (!sl.visF[k] || !sl.visT[k]) return false;
    } else if (!vs[k]) return false;
  }
  return true;
}

let nearJ = 0;
// Squared distance from point i of P to the nearest of the ns sample points S.
function nearestSample(P, i, S, ns) {
  const px = P[2 * i];
  const py = P[2 * i + 1];
  let bd = Infinity;
  for (let j = 0; j < ns; j++) {
    const dx = px - S[2 * j];
    const dy = py - S[2 * j + 1];
    const d = dx * dx + dy * dy;
    if (d < bd) {
      bd = d;
      nearJ = j;
    }
  }
  return bd;
}

/**
 * Pick the anchor of an untied part: the core slot and the point index whose point (F for an old part, T for
 * a new part) is nearest to the part. Returns { slot, index } or null.
 */
function pickAnchor(samples, cores, side) {
  const ns = samples.length / 2;
  for (let pass = 0; pass < 3; pass++) {
    let bd = Infinity;
    let bs = null;
    let bi = -1;
    let bj = 0;
    for (const sl of cores) {
      const P = side === 'F' ? sl.F : sl.T;
      const M = sl.M;
      const stride = Math.max(1, Math.floor((M - 1) / 40));
      for (let i = 0; i < M; i += stride) {
        if (!anchorOk(sl, i, pass, side)) continue;
        const d = nearestSample(P, i, samples, ns);
        if (d < bd) {
          bd = d;
          bs = sl;
          bi = i;
          bj = nearJ;
        }
      }
    }
    if (!bs) continue;
    const P = side === 'F' ? bs.F : bs.T;
    const stride = Math.max(1, Math.floor((bs.M - 1) / 40));
    // R11-7: points of the core that are as near as the best one (within 0.05 units) form an equal run: take the middle of the run
    // that holds the best point. A flat part beside a flat core has every point of the core facing it, so the first point never wins.
    {
      const lim = (Math.sqrt(bd) + 0.05) * (Math.sqrt(bd) + 0.05);
      const near = (i) => anchorOk(bs, i, pass, side) && nearestSample(P, i, samples, ns) <= lim;
      let a = bi;
      let b = bi;
      while (a - stride >= 0 && near(a - stride)) a -= stride;
      while (b + stride < bs.M && near(b + stride)) b += stride;
      if (b > a) {
        let mi = Math.round((a + b) / 2);
        if (!anchorOk(bs, mi, pass, side)) mi = bi;
        bi = mi;
        bd = nearestSample(P, bi, samples, ns);
        bj = nearJ;
      }
    }
    // Refine around the best index at full resolution, against the nearest sample point.
    const qx = samples[2 * bj];
    const qy = samples[2 * bj + 1];
    for (let i = Math.max(0, bi - stride + 1); i <= Math.min(bs.M - 1, bi + stride - 1); i++) {
      if (!anchorOk(bs, i, pass, side)) continue;
      const dx = P[2 * i] - qx;
      const dy = P[2 * i + 1] - qy;
      const d = dx * dx + dy * dy;
      if (d < bd - 1e-6) {
        bd = d;
        bi = i;
      }
    }
    return { slot: bs, index: bi };
  }
  return null;
}

function reversePoly(P, M) {
  const out = new Float64Array(2 * M);
  for (let i = 0; i < M; i++) {
    out[2 * i] = P[2 * (M - 1 - i)];
    out[2 * i + 1] = P[2 * (M - 1 - i) + 1];
  }
  if (P.vis) {
    out.vis = new Uint8Array(M - 1);
    for (let k = 0; k < M - 1; k++) out.vis[k] = P.vis[M - 2 - k];
  }
  return out;
}

function meanPt(P, M) {
  let x = 0;
  let y = 0;
  for (let i = 0; i < M; i++) {
    x += P[2 * i];
    y += P[2 * i + 1];
  }
  return [x / M, y / M];
}

// Build an exit slot (a part of the old icon) or an enter slot (a part of the new icon).
// pre (R7-A, optional): { anc, fixed, group }. anc is a given anchor { slot, index } or null, fixed is a fixed anchor
// point [x, y] (on the outline of a multi-stroke core object) or null, and group true means that the stroke belongs to
// a multi-stroke object: it only scales toward the anchor (no retract), so the strokes of the object move as one group.
function buildPartSlot(kind, st, idx, o, K, cores, pre, att) {
  const exit = kind === 'exit';
  const M = clampM(need(st, o), o);
  const form = st.closed ? FORM_LOOP : FORM_PASS;
  let P = formFor(st, M, form);
  const samples = formFor(st, K, form);
  // R11-3: a part that is attached to a parent (att.attach 'end', 'arch' or 'contact') rides on the contact point on its parent
  // slot, whatever the parent is doing. A free part (or a part of an object plan) keeps the round 10c anchor.
  const attached = !!(att && att.parentSlot && att.contact && att.attach !== 'free' && !pre);
  let attFrac = 0;
  let anc;
  // R11b-4: an arch whose two contacts have a middle further than 1 unit from the parent line grows out of both contacts (or leaves
  // into both). Its two anchors are the places of the parent nearest to the two ends of the part.
  const arch2 = attached && att.attach === 'arch' && !!att.arch2 && !st.closed;
  let loc2 = null;
  if (attached) {
    const loc = arch2 ? locateOnSlot(att.parentSlot, exit ? 'F' : 'T', P[0], P[1]) : locateOnSlot(att.parentSlot, exit ? 'F' : 'T', att.contact[0], att.contact[1]);
    if (arch2) loc2 = locateOnSlot(att.parentSlot, exit ? 'F' : 'T', P[2 * M - 2], P[2 * M - 1]);
    anc = { slot: att.parentSlot, index: loc.i };
    attFrac = loc.f;
  } else anc = pre ? pre.anc : cores.length ? pickAnchor(samples, cores, exit ? 'F' : 'T') : null;
  let a0;
  let a1;
  if (anc && attached) {
    a0 = lerpAt(anc.slot.F, anc.index, attFrac);
    a1 = lerpAt(anc.slot.T, anc.index, attFrac);
  } else if (anc) {
    a0 = [anc.slot.F[2 * anc.index], anc.slot.F[2 * anc.index + 1]];
    a1 = [anc.slot.T[2 * anc.index], anc.slot.T[2 * anc.index + 1]];
  } else if (pre && pre.fixed) {
    a0 = a1 = pre.fixed;
  } else {
    a0 = a1 = centroidOf(samples, st.closed);
  }
  const ref = exit ? a0 : a1;
  let motion = 'scale';
  let ex = 0;
  let ey = 0;
  if (!st.closed && st.length > 1e-6 && !(pre && pre.group) && (!attached || att.attach === 'end')) {
    const d0 = dist(P[0], P[1], ref[0], ref[1]);
    const d1 = dist(P[2 * M - 2], P[2 * M - 1], ref[0], ref[1]);
    // R11-3: a part that touches its parent with one end always draws out of it (or erases into it).
    // R11-7: a free part that is mirror symmetric about its own axis does not retract into one end unless that end lies on the axis.
    const symOk = attached || pre || (() => {
      const ax = selfAxes(st);
      return !ax.length || ax.some((a) => Math.abs((a.v ? ref[0] : ref[1]) - a.c) <= 0.1);
    })();
    if (symOk && (attached || Math.min(d0, d1) <= o.retractReach)) {
      // An exit retracts toward its last point. An enter draws out of its first point.
      if (exit ? d0 < d1 : d1 < d0) P = reversePoly(P, M);
      motion = exit ? 'erase' : 'draw';
      const e = exit ? M - 1 : 0;
      ex = P[2 * e];
      ey = P[2 * e + 1];
    }
  }
  // R10-1 / R10b-1: a part that scales in or out and lies outside its parent uses the facing point of its parent as the
  // anchor: where the segment from the parent centroid to the part centroid crosses the parent outline. A part whose
  // centroid is inside a closed parent keeps the round 9c anchor (the nearest point of the parent line).
  let aIndex = anc ? anc.index : -1;
  let aFrac = attached ? attFrac : 0;
  let goesUnder = !!anc && !attached && o.occlusion !== 'none' && (exit ? anc.slot.closedF : anc.slot.closedT);
  if (anc && motion === 'scale' && !pre && !attached && !goesUnder && o.facingAnchor !== false) {
    const side = exit ? 'F' : 'T';
    const q = centroidOf(samples, st.closed);
    const fp = facingPoint(anc.slot, side, q[0], q[1]);
    if (fp.best) {
      aIndex = fp.best.i;
      aFrac = fp.best.f;
      a0 = lerpAt(anc.slot.F, aIndex, aFrac);
      a1 = lerpAt(anc.slot.T, aIndex, aFrac);
    }
  }
  // R11-7: a part that is mirror symmetric about its own axis scales about a place of a core stroke that lies on that axis (the crossing
  // of the axis with the solid edges of the parent, or else of another core stroke, that is nearest to the first anchor).
  if (anc && motion === 'scale' && !pre && !attached && o.facingAnchor !== false) {
    const axes = selfAxes(st);
    const cur = exit ? a0 : a1;
    if (axes.length && !axes.some((a) => Math.abs((a.v ? cur[0] : cur[1]) - a.c) <= 0.1)) {
      let bestR = null;
      let bestSl = null;
      // Solid edges first (drawn in the old and in the new icon); else the edges drawn on this side.
      for (const kindOfEdge of [2, 1]) {
        for (const sl0 of [anc.slot, ...cores.filter((c) => c !== anc.slot)]) {
          const vs = exit ? sl0.visF : sl0.visT;
          const mk = new Uint8Array(sl0.M - 1);
          for (let k = 0; k < mk.length; k++) mk[k] = kindOfEdge === 2 ? (sl0.visF[k] && sl0.visT[k] ? 1 : 0) : vs[k] ? 1 : 0;
          const r = relocateOnSlot(sl0, exit ? 'F' : 'T', cur[0], cur[1], mk, axes);
          if (r && r.axis && (!bestR || r.d < bestR.d)) {
            bestR = r;
            bestSl = sl0;
          }
        }
        if (bestR) break;
      }
      if (bestR) {
        anc = { slot: bestSl, index: bestR.i };
        aIndex = bestR.i;
        aFrac = bestR.f;
        a0 = lerpAt(bestSl.F, aIndex, aFrac);
        a1 = lerpAt(bestSl.T, aIndex, aFrac);
        goesUnder = o.occlusion !== 'none' && (exit ? bestSl.closedF : bestSl.closedT);
      }
    }
  }
  const Z = new Float64Array(2 * M);
  const z = exit ? a1 : a0;
  for (let i = 0; i < M; i++) {
    Z[2 * i] = z[0];
    Z[2 * i + 1] = z[1];
  }
  const vis = P.vis || onesMask(M - 1);
  const slot = {
    kind,
    role: 'part',
    mode: st.closed ? 'loop' : 'pass',
    fromIndex: exit ? idx : -1,
    toIndex: exit ? -1 : idx,
    M,
    F: exit ? P : Z,
    T: exit ? Z : P,
    visF: vis,
    visT: vis,
    weight: st.length,
    fromOp: st.opacity,
    toOp: st.opacity,
    fill: !!st.fill,
    sw0: st.sw === undefined ? null : st.sw,
    sw1: st.sw === undefined ? null : st.sw,
    ws0: exit && st.ws0 !== undefined ? st.ws0 : 1,
    buf: new Float64Array(2 * M),
    static: false,
    bigTurn: false,
    flip: false,
    theta: 0,
    scale: 1,
    motion,
    chain: { from: exit ? st.bridges : 0, to: exit ? 0 : st.bridges },
    anchor: -1,
    anchorIndex: aIndex,
    anchorFrac: aFrac,
    twinOf: -1,
    window: [0, 1],
    _anchorSlot: anc ? anc.slot : null,
    a0x: a0[0],
    a0y: a0[1],
    a1x: a1[0],
    a1y: a1[1],
    ex,
    ey,
  };
  if (motion !== 'scale') {
    slot.cum = cumLen(P, M);
    slot.L = slot.cum[M - 1];
  }
  if (arch2 && loc2) {
    // R11b-4: the part keeps its shape; its two ends ride on the two anchors, the points between follow by arc length. It is drawn
    // from both ends toward the middle (an entry) or erased from the middle into both ends (an exit): the visibility classes do that.
    const cum = cumLen(P, M);
    const lam = new Float64Array(M);
    for (let i = 0; i < M; i++) lam[i] = cum[M - 1] > 0 ? cum[i] / cum[M - 1] : 0;
    slot.motion = 'arch2';
    slot.cum = cum;
    slot.L = cum[M - 1];
    slot.lam = lam;
    slot.ends = [null, null];
    setSlotAnchor(slot, att.parentSlot, anc.index, attFrac, false);
    setSlotAnchor(slot, att.parentSlot, loc2.i, loc2.f, true);
    // R11c-3: a dashed arch (hidden bridges) is drawn from both ends along the whole polyline, and only its real runs show.
    let real = null;
    if (vis.some((v) => !v)) {
      real = [];
      for (let k = 0; k < M - 1; ) {
        if (!vis[k]) {
          k++;
          continue;
        }
        const a0r = k;
        while (k < M - 1 && vis[k]) k++;
        real.push(a0r, k);
      }
    }
    slot.archWhole = !!real;
    const rl = real || [0, M - 1];
    slot.runs = exit ? [null, rl, null] : [null, null, rl];
  }
  // R6-2: a part whose parent is a closed stroke goes under the parent (or comes out from under it).
  if (goesUnder) slot.motion = 'under';
  // R11-2: the attachment of the part (debug data and the order of events).
  slot.attach = attached ? att.attach : 'free';
  slot.level = att ? att.level : 1;
  if (att) {
    slot._lvl = att.level;
    slot._att = att;
  }
  const runs2 = slot.motion === 'arch2' ? slot.runs : null;
  buildClasses(slot);
  if (runs2) slot.runs = runs2;
  return slot;
}

// R11-3: the place on the polyline of a slot (side 'F' or 'T') that is nearest to (x, y): the edge i and the fraction f along
// it. Edges that are solid in the old and in the new icon are preferred (an edge that fades is cut while the slot morphs), then
// edges that are visible on the given side.
function locateOnSlot(sl, side, x, y) {
  const P = side === 'F' ? sl.F : sl.T;
  const vs = side === 'F' ? sl.visF : sl.visT;
  const M = sl.M;
  let solid = null;
  let vis = null;
  let any = null;
  for (let i = 0; i < M - 1; i++) {
    const ax = P[2 * i];
    const ay = P[2 * i + 1];
    const dx = P[2 * i + 2] - ax;
    const dy = P[2 * i + 3] - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
    if (!any || d < any.d) any = { i, f: t, d };
    if (vs[i] && (!vis || d < vis.d)) vis = { i, f: t, d };
    if (sl.visF[i] && sl.visT[i] && (!solid || d < solid.d)) solid = { i, f: t, d };
  }
  const best = solid && vis && solid.d <= vis.d + 1 ? solid : vis || any || { i: 0, f: 0, d: 0 };
  return best;
}

// R10-1: the point of the parent outline that faces a part. `sl` is the parent slot, `side` 'F' (an exit) or 'T' (an
// entry), (qx, qy) the centroid of the part. Returns { best: { i, f } | null }: the edge i and the fraction f
// along it where the segment from the parent centroid to the part centroid crosses the outline (the crossing nearest
// to the part). R10b-1: a part whose centroid is inside a closed parent has no facing point (best is null).
function facingPoint(sl, side, qx, qy) {
  const P = side === 'F' ? sl.F : sl.T;
  const M = sl.M;
  const closed = sl.mode === 'loop';
  if (closed && pip(P, M, qx, qy)) return { best: null };
  const n = closed ? M - 1 : M;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    cx += P[2 * i];
    cy += P[2 * i + 1];
  }
  cx /= n;
  cy /= n;
  const dx = qx - cx;
  const dy = qy - cy;
  let best = null;
  let bs = -1;
  for (let i = 0; i < M - 1; i++) {
    // R10c-1: only an edge that is solid in the old and in the new icon (as in anchorOk pass 0). An edge that fades
    // (visF 1, visT 0, or the reverse) is cut in the middle while the parent morphs, so a point on it can leave the line.
    if (!sl.visF[i] || !sl.visT[i]) continue;
    const x1 = P[2 * i];
    const y1 = P[2 * i + 1];
    const ex = P[2 * i + 2] - x1;
    const ey = P[2 * i + 3] - y1;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-9) continue;
    const wx = x1 - cx;
    const wy = y1 - cy;
    const s = (wx * ey - wy * ex) / den;
    const f = (wx * dy - wy * dx) / den;
    if (s < 0 || s > 1 || f < 0 || f > 1) continue;
    if (s > bs) {
      bs = s;
      best = { i, f };
    }
  }
  return { best };
}

// The point at fraction f along the edge i of the polyline P.
function lerpAt(P, i, f) {
  return [P[2 * i] + f * (P[2 * i + 2] - P[2 * i]), P[2 * i + 1] + f * (P[2 * i + 3] - P[2 * i + 1])];
}

// R11-7: the axes (vertical x = c, horizontal y = c) about which a stroke is mirror symmetric (every sample of it reflects onto its own
// line within 0.1 units). The axis passes through the middle of the bounding box. Cached on the stroke.
function selfAxes(st) {
  if (st._axes) return st._axes;
  const out = [];
  if (st.pts && st.pts.length >= 4) {
    const V = visSamples(st);
    const b = strokeBox(st);
    const cx = 0.5 * (b[0] + b[2]);
    const cy = 0.5 * (b[1] + b[3]);
    for (const ax of ['v', 'h']) {
      let ok = true;
      let hint = -1;
      for (let k = 0; k < V.length && ok; k += 2) {
        const x = ax === 'v' ? 2 * cx - V[k] : V[k];
        const y = ax === 'v' ? V[k + 1] : 2 * cy - V[k + 1];
        const nr = nearestOnStrokeHint(st, x, y, hint);
        hint = nr.i;
        if (nr.d > 0.1) ok = false;
      }
      if (ok) out.push(ax === 'v' ? { v: true, c: cx } : { v: false, c: cy });
    }
  }
  st._axes = out;
  return out;
}

// R11b-3 / R11-7: the place on the polyline of slot `sl` (side 'F' or 'T') nearest to (x, y), on the edges where mask[i] is set (all
// edges when mask is null). With `axes` (the symmetry axes of the part) the anchor must lie within 0.1 of an axis: when the nearest
// place does not, the crossing of an axis with the allowed edges that is nearest to (x, y) is used (at most 6 units further away).
// Returns { i, f, d, axis } or null (no allowed edge).
function relocateOnSlot(sl, side, x, y, mask, axes) {
  const P = side === 'F' ? sl.F : sl.T;
  const E = sl.M - 1;
  let best = null;
  for (let i = 0; i < E; i++) {
    if (mask && !mask[i]) continue;
    const ax = P[2 * i];
    const ay = P[2 * i + 1];
    const dx = P[2 * i + 2] - ax;
    const dy = P[2 * i + 3] - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
    if (!best || d < best.d - 1e-9) best = { i, f: t, d, axis: false, px: ax + t * dx, py: ay + t * dy };
  }
  if (!best) return null;
  if (axes && axes.length && !axes.some((a) => Math.abs((a.v ? best.px : best.py) - a.c) <= 0.1)) {
    let bc = null;
    for (let i = 0; i < E; i++) {
      if (mask && !mask[i]) continue;
      for (const a of axes) {
        const c0 = (a.v ? P[2 * i] : P[2 * i + 1]) - a.c;
        const c1 = (a.v ? P[2 * i + 2] : P[2 * i + 3]) - a.c;
        let f;
        if (Math.abs(c0) <= 0.05 && Math.abs(c1) <= 0.05) {
          // The edge lies on the axis: any point of it is on the axis; take the one nearest to (x, y).
          const dx = P[2 * i + 2] - P[2 * i];
          const dy = P[2 * i + 3] - P[2 * i + 1];
          const l2 = dx * dx + dy * dy;
          f = l2 > 0 ? ((x - P[2 * i]) * dx + (y - P[2 * i + 1]) * dy) / l2 : 0;
          f = f < 0 ? 0 : f > 1 ? 1 : f;
        } else {
          if (c0 * c1 > 0 || c0 === c1) continue;
          f = c0 / (c0 - c1);
        }
        const px = P[2 * i] + f * (P[2 * i + 2] - P[2 * i]);
        const py = P[2 * i + 1] + f * (P[2 * i + 3] - P[2 * i + 1]);
        const d = Math.hypot(px - x, py - y);
        if (!bc || d < bc.d - 1e-9) bc = { i, f, d, axis: true, px, py };
      }
    }
    if (bc) best = bc;
  }
  return best;
}

// R11b-3: the edges of the polyline of slot `par` that are drawn at the linear time te (the slot is at its own window progress). A tied
// slot is evaluated; a part that rides on its parent uses its rest polyline. An edge counts as drawn when all of it lies in a drawn piece.
function drawnEdges(par, te, easing, stagger) {
  const E = par.M - 1;
  if (!par.runs) return null;
  const mask = new Uint8Array(E);
  const r0 = par.runs[0];
  if (r0) for (let r = 0; r < r0.length; r += 2) for (let k = r0[r]; k < r0[r + 1]; k++) mask[k] = 1;
  if (!(par.runs[1] || par.runs[2])) return mask;
  const w0 = par.window[0];
  const w1 = par.window[1];
  let tl = w1 > w0 ? (te - w0) / (w1 - w0) : te >= w1 ? 1 : 0;
  tl = Math.min(1, Math.max(0, tl));
  const mover = par.kind === 'exit' || par.kind === 'enter';
  const tau = mover ? tl : Math.min(1, Math.max(0, (tl - stagger * par.rank) / (1 - stagger)));
  const u = tau <= 0 ? 0 : tau >= 1 ? 1 : easing(tau);
  let L;
  if (mover) L = par.kind === 'exit' ? par.F : par.T;
  else {
    evalSlot(par, u, tau, u, null, te);
    L = par.buf;
  }
  for (let c = 1; c <= 2; c++) {
    const list = par.runs[c];
    if (!list) continue;
    const h = c === 1 ? u : 1 - u;
    if (h >= 1) continue;
    if (par.archWhole && h > 0) {
      const M1 = L.length / 2;
      const cw = new Float64Array(M1);
      for (let k = 1; k < M1; k++) cw[k] = cw[k - 1] + dist(L[2 * k], L[2 * k + 1], L[2 * k - 2], L[2 * k - 1]);
      const Lw = cw[M1 - 1];
      const visW = ((1 - h) / 2) * Lw;
      if (!(visW > 1e-6)) continue;
      for (let r = 0; r < list.length; r += 2) for (let k = list[r]; k < list[r + 1]; k++) if (cw[k + 1] <= visW + 1e-9 || cw[k] >= Lw - visW - 1e-9) mask[k] = 1;
      continue;
    }
    for (let r = 0; r < list.length; r += 2) {
      const a = list[r];
      const b = list[r + 1];
      if (h <= 0) {
        for (let k = a; k < b; k++) mask[k] = 1;
        continue;
      }
      const cum = new Float64Array(b - a + 1);
      for (let k = 1; k <= b - a; k++) cum[k] = cum[k - 1] + dist(L[2 * (a + k)], L[2 * (a + k) + 1], L[2 * (a + k) - 2], L[2 * (a + k) - 1]);
      const Lr = cum[b - a];
      const vis = ((1 - h) / 2) * Lr;
      if (!(vis > 1e-6)) continue;
      for (let k = a; k < b; k++) if (cum[k - a + 1] <= vis + 1e-9 || cum[k - a] >= Lr - vis - 1e-9) mask[k] = 1;
    }
  }
  return mask;
}

// Move the anchor of an attached part slot to the place (i, f) of its parent slot. `second` (a two-sided arch only): which end (0 or 1)
// of the arch; the anchor a0 / a1 of such a slot is the middle of its two end anchors.
function setSlotAnchor(sl, par, i, f, second) {
  const a0 = lerpAt(par.F, i, f);
  const a1 = lerpAt(par.T, i, f);
  if (sl.ends) {
    const k = second ? 1 : 0;
    sl.ends[k] = { i, f, x0: a0[0], y0: a0[1], x1: a1[0], y1: a1[1] };
    const [e0, e1] = sl.ends;
    if (!e0 || !e1) return;
    sl.anchorIndex = e0.i;
    sl.anchorFrac = e0.f;
    sl.a0x = 0.5 * (e0.x0 + e1.x0);
    sl.a0y = 0.5 * (e0.y0 + e1.y0);
    sl.a1x = 0.5 * (e0.x1 + e1.x1);
    sl.a1y = 0.5 * (e0.y1 + e1.y1);
    return;
  }
  sl.anchorIndex = i;
  sl.anchorFrac = f;
  sl.a0x = a0[0];
  sl.a0y = a0[1];
  sl.a1x = a1[0];
  sl.a1y = a1[1];
  const exit = sl.kind === 'exit';
  const Z = exit ? sl.T : sl.F;
  const z = exit ? a1 : a0;
  for (let k = 0; k < sl.M; k++) {
    Z[2 * k] = z[0];
    Z[2 * k + 1] = z[1];
  }
}

// R11b-3: every attached part rides on a place of its parent that is drawn at the edge of its own window (an entry starts there, an
// exit ends there). A symmetric part (R11-7) takes a place on its own axis. Runs once the windows are final.
function retargetAnchors(slots, o) {
  const easing = planEasingOf(o);
  const stagger = Math.min(0.99, Math.max(0, o.stagger));
  for (const s of slots) {
    if ((s.kind !== 'exit' && s.kind !== 'enter') || !s._att || s._att.attach === 'free' || !s._anchorSlot) continue;
    if (s.motion === 'twin' || s.motion === 'under' || !s._srcSt) continue;
    const exit = s.kind === 'exit';
    const par = s._anchorSlot;
    const side = exit ? 'F' : 'T';
    const te = exit ? s.window[1] : s.window[0];
    const mask = drawnEdges(par, te, easing, stagger);
    const axes = selfAxes(s._srcSt);
    const P = exit ? s.F : s.T;
    const ends = s.motion === 'arch2' ? [[P[0], P[1], false], [P[2 * s.M - 2], P[2 * s.M - 1], true]] : [[s._att.contact[0], s._att.contact[1], false]];
    for (const [qx, qy, second] of ends) {
      const i0 = s.ends ? s.ends[second ? 1 : 0].i : s.anchorIndex;
      const f0 = s.ends ? s.ends[second ? 1 : 0].f : s.anchorFrac;
      const cur = lerpAt(side === 'F' ? par.F : par.T, i0, f0);
      const okEdge = !mask || mask[i0] === 1;
      const onAxis = !axes.length || s.motion === 'arch2' || axes.some((a) => Math.abs((a.v ? cur[0] : cur[1]) - a.c) <= 0.1);
      if (okEdge && onAxis) continue;
      const r = relocateOnSlot(par, side, qx, qy, mask, s.motion === 'arch2' ? null : axes);
      if (!r) continue;
      if (!okEdge || r.axis) setSlotAnchor(s, par, r.i, r.f, second);
    }
  }
}

// ---------------------------------------------------------------------------
// R10-2: twins. A new part that is the same shape as a part that stays (up to a translation) slides out from behind it.
// ---------------------------------------------------------------------------

// The twin sibling of stroke `st` among the tied slots, or null. side 'T': an entry (compare with the new strokes of the
// tied slots); 'F': an exit. Returns { sib, P } with P the polyline of the twin (M of the sibling points, aligned to the
// sibling, in place).
function findTwin(st, side, slots, A, B, o, att) {
  const exit = side === 'F';
  // R11-5: a part that is attached to a parent never moves as a twin.
  if (att && att.attach !== 'free') return null;
  let best = null;
  for (const sib of slots) {
    if (sib.kind !== 'match' || sib.role === null || sib.lod) continue;
    const idx = exit ? sib.fromIndex : sib.toIndex;
    if (idx < 0) continue;
    const ss = (exit ? A : B)[idx];
    if (!ss || !!ss.closed !== !!st.closed || !sameStyle(st, ss) || ss.bridges || st.bridges) continue;
    if ((exit ? sib.chain.from : sib.chain.to) !== 0) continue;
    // R10b-2 (a): a closed twin needs a sibling that is closed in the old and in the new icon.
    if (st.closed) {
      const oa = A[sib.fromIndex];
      const ob = B[sib.toIndex];
      if (sib.fromIndex < 0 || sib.toIndex < 0 || !oa || !ob || !oa.closed || !ob.closed) continue;
    }
    if (!(ss.length > 1e-6) || Math.abs(st.length / ss.length - 1) > 0.05) continue;
    const M = sib.M;
    const R = exit ? sib.F : sib.T;
    const P = formFor(st, M, st.closed ? FORM_LOOP : FORM_PASS);
    const al = alignTranslated(P, R, M, !!st.closed);
    if (!al || al.res >= 0.02) continue;
    const U = st.closed ? M - 1 : M;
    const cp = meanPt(al.P, U);
    const cr = meanPt(R, U);
    const d = dist(cp[0], cp[1], cr[0], cr[1]);
    // R11-5: a free twin needs its centroid within one sibling bounding-box diagonal of the sibling centroid.
    if (d > bboxDiag(R, U)) continue;
    if (!best || d < best.d) best = { sib, P: al.P, d };
  }
  return best;
}

// Align the polyline P to R (M points) with a shift and a direction, so that the relative residual after removing the
// translation is smallest. Returns { P: aligned copy (in place, not translated), res } or null.
function alignTranslated(P, R, M, closed) {
  const U = closed ? M - 1 : M;
  const cp = meanPt(P, U);
  const cr = meanPt(R, U);
  let den = 0;
  for (let k = 0; k < U; k++) den += (R[2 * k] - cr[0]) ** 2 + (R[2 * k + 1] - cr[1]) ** 2;
  if (!(den > 1e-9)) return null;
  let bc = Infinity;
  let bs = 0;
  let bd = 1;
  const shifts = closed ? U : 1;
  for (let dir = 1; dir >= -1; dir -= 2) {
    for (let s = 0; s < shifts; s++) {
      let c = 0;
      for (let k = 0; k < U && c < bc; k++) {
        const j = closed ? (((s + dir * k) % U) + U) % U : dir > 0 ? k : U - 1 - k;
        const ex = P[2 * j] - cp[0] - (R[2 * k] - cr[0]);
        const ey = P[2 * j + 1] - cp[1] - (R[2 * k + 1] - cr[1]);
        c += ex * ex + ey * ey;
      }
      if (c < bc) {
        bc = c;
        bs = s;
        bd = dir;
      }
    }
  }
  const out = new Float64Array(2 * M);
  for (let k = 0; k < U; k++) {
    const j = closed ? (((bs + bd * k) % U) + U) % U : bd > 0 ? k : U - 1 - k;
    out[2 * k] = P[2 * j];
    out[2 * k + 1] = P[2 * j + 1];
  }
  if (closed) {
    out[2 * U] = out[0];
    out[2 * U + 1] = out[1];
  }
  return { P: out, res: Math.sqrt(bc / den) };
}

// Build the slot of a twin. `tw` is the result of findTwin. An entry goes from a copy of its sibling (scaled to
// `twinScale` about the sibling centroid when closed) to its own place; an exit does the reverse.
function buildTwinSlot(kind, st, idx, tw, o, small) {
  const exit = kind === 'exit';
  const sib = tw.sib;
  const M = sib.M;
  const loop = !!st.closed;
  const closed = loop && !small; // R10b-3: a small closed twin uses the open-twin motion (no scale, no mask)
  const P = tw.P;
  const Q = new Float64Array(2 * M);
  const R = exit ? sib.F : sib.T;
  const U = loop ? M - 1 : M;
  const c = meanPt(R, U);
  const k = closed ? o.twinScale : 1;
  for (let i = 0; i < M; i++) {
    Q[2 * i] = c[0] + k * (R[2 * i] - c[0]);
    Q[2 * i + 1] = c[1] + k * (R[2 * i + 1] - c[1]);
  }
  const vis = onesMask(M - 1);
  const cp = meanPt(P, U);
  const slot = {
    kind,
    role: 'part',
    mode: loop ? 'loop' : 'pass',
    fromIndex: exit ? idx : -1,
    toIndex: exit ? -1 : idx,
    M,
    F: exit ? P : Q,
    T: exit ? Q : P,
    visF: vis,
    visT: vis,
    weight: st.length,
    fromOp: st.opacity,
    toOp: st.opacity,
    fill: !!st.fill,
    sw0: st.sw === undefined ? null : st.sw,
    sw1: st.sw === undefined ? null : st.sw,
    ws0: exit && st.ws0 !== undefined ? st.ws0 : 1,
    buf: new Float64Array(2 * M),
    static: false,
    bigTurn: false,
    flip: false,
    theta: 0,
    scale: 1,
    motion: 'twin',
    chain: { from: 0, to: 0 },
    anchor: -1,
    anchorIndex: -1,
    anchorFrac: 0,
    twinOf: -1,
    twinClosed: closed,
    twinScale: k,
    window: [0, 1],
    _anchorSlot: sib,
    _twinSlot: sib,
    a0x: cp[0],
    a0y: cp[1],
    a1x: cp[0],
    a1y: cp[1],
    ex: 0,
    ey: 0,
  };
  buildClasses(slot);
  return slot;
}

// A twin at the linear local window time u (R10b-4: position and size follow s = u * u * (3 - 2 * u)). The sibling is a
// tied slot, evaluated before. Entry: from the copy of the sibling's current shape (scaled about its centroid when
// closed) to the own place. Exit: the reverse.
function evalTwin(slot, u) {
  const exit = slot.kind === 'exit';
  const out = slot.buf;
  const M = slot.M;
  const op = exit ? slot.fromOp : slot.toOp === undefined ? 1 : slot.toOp;
  if (exit ? u <= 0 : u >= 1) {
    out.set(exit ? slot.F : slot.T);
    return op;
  }
  const w = u < 0 ? 0 : u > 1 ? 1 : u;
  const sm = w * w * (3 - 2 * w);
  const S = slot._twinSlot._balBase || slot._twinSlot.buf; // R12-1 'center': the sibling placed at the group centroid
  const U = slot.mode === 'loop' ? M - 1 : M;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < U; i++) {
    cx += S[2 * i];
    cy += S[2 * i + 1];
  }
  cx /= U;
  cy /= U;
  const k = slot.twinClosed ? slot.twinScale : 1;
  const E = exit ? slot.F : slot.T; // the own place
  for (let i = 0; i < M; i++) {
    const qx = cx + k * (S[2 * i] - cx);
    const qy = cy + k * (S[2 * i + 1] - cy);
    if (exit) {
      out[2 * i] = E[2 * i] + sm * (qx - E[2 * i]);
      out[2 * i + 1] = E[2 * i + 1] + sm * (qy - E[2 * i + 1]);
    } else {
      out[2 * i] = qx + sm * (E[2 * i] - qx);
      out[2 * i + 1] = qy + sm * (E[2 * i + 1] - qy);
    }
  }
  return op;
}


// R12-1 'split': a twin follows its sibling. An entry starts as an exact copy of the sibling's old shape and morphs into its own
// place with the sibling's progress u (eased); an exit is the reverse (many to one). P is aligned to the sibling points.
function evalSplitTwin(slot, u) {
  const exit = slot.kind === 'exit';
  const out = slot.buf;
  const M = slot.M;
  const op = exit ? slot.fromOp : slot.toOp === undefined ? 1 : slot.toOp;
  const E = exit ? slot.F : slot.T; // the own place
  if (exit ? u <= 0 : u >= 1) {
    out.set(E);
    return op;
  }
  const sib = slot._twinSlot;
  const sb = sib.buf;
  const R = exit ? sib.F : sib.T;
  const f = exit ? 1 - u : u < 0 ? 0 : u;
  for (let k = 0; k < 2 * M; k++) out[k] = sb[k] + f * (E[k] - R[k]);
  return op;
}

// R12-1 'center': the sibling is shifted by the vector d = G - (centroid of its final place) while the group is not spread out
// (G is the centroid of the final places of the sibling and its twins). Entry: the shift grows with the sibling's progress f = u
// and goes away over the twin window (smoothstep s). Exit: it grows over the twin window and goes away with f = 1 - u.
// `_balBase` is the sibling placed at G (what its twins start from, or end on).
function applyBalance(s, t, u) {
  const b = s._bal;
  const w = b.win[1] > b.win[0] ? Math.min(1, Math.max(0, (t - b.win[0]) / (b.win[1] - b.win[0]))) : t >= b.win[1] ? 1 : 0;
  const sm = w * w * (3 - 2 * w);
  const f = b.exit ? 1 - u : u;
  const buf = s.buf;
  const bb = b.base;
  const n = s.M;
  const offK = b.exit ? sm : 1 - sm; // share of the shift that S itself carries
  const ox = b.dx * f * offK;
  const oy = b.dy * f * offK;
  const ex = b.dx * f * (1 - offK);
  const ey = b.dy * f * (1 - offK);
  for (let i = 0; i < n; i++) {
    if (offK > 0 && f > 0) {
      buf[2 * i] += ox;
      buf[2 * i + 1] += oy;
    }
    bb[2 * i] = buf[2 * i] + ex;
    bb[2 * i + 1] = buf[2 * i + 1] + ey;
  }
  s._balBase = bb;
}

// R12-1: the balance of twin groups (a sibling S and its twins). Runs after the windows and the twin checks.
// Returns true when the windows must be set again ('split': the twins leave the entry and exit windows).
function isStaticSlot(sl) {
  const F = sl.F;
  const T = sl.T;
  for (let i = 0; i < 2 * sl.M; i += 2) if (Math.hypot(F[i] - T[i], F[i + 1] - T[i + 1]) > 0.05) return false;
  return true;
}

function balanceTwins(slots, o) {
  const mode = o.twinBalance;
  if (mode !== 'center' && mode !== 'split') return false;
  const groups = new Map();
  for (const s of slots) {
    if (s.motion !== 'twin' || !s._twinSlot || (s.kind !== 'enter' && s.kind !== 'exit')) continue;
    const key = s._twinSlot;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { enter: [], exit: [] }));
    g[s.kind].push(s);
  }
  let again = false;
  const cands = [];
  for (const [sib, g] of groups) {
    for (const kind of ['enter', 'exit']) {
      const list = g[kind];
      if (!list.length) continue;
      const exit = kind === 'exit';
      if (mode === 'split') {
        for (const s of list) {
          s._split = true;
          s.twinClosed = false; // exact overlap: no mask
          s.twinScale = 1;
          delete s._win;
        }
        again = true;
        continue;
      }
      // R12c-3: a sibling with the same shape and place in both icons (every point within 0.05 units of its partner point) stays still:
      // no balance, and its twins keep the 11f behavior. R14 fix pass 4: a kept piece (R14-2, R14-7) is the same shape within the
      // 0.15 keep tolerance but up to 0.25 units apart, so isStaticSlot misses it; a kept piece must not move before t = 1 either.
      if (isStaticSlot(sib) || sib.keep) {
        cands.push({ sib, list, exit, dx: 0, dy: 0, active: false }); // only for the mirror link of the windows
        continue;
      }
      const cen = (sl) => meanPt(exit ? sl.F : sl.T, sl.mode === 'loop' ? sl.M - 1 : sl.M);
      const cs = cen(sib);
      let gx = cs[0];
      let gy = cs[1];
      for (const s of list) {
        const c = cen(s);
        gx += c[0];
        gy += c[1];
      }
      gx /= list.length + 1;
      gy /= list.length + 1;
      const dx = gx - cs[0];
      const dy = gy - cs[1];
      const active = !(Math.hypot(dx, dy) < 0.01 || sib._bal);
      cands.push({ sib, list, exit, dx, dy, active });
    }
  }
  if (mode === 'split') return again;
  // R12c-1: every set of twins linked by a mirror group (the same _pairId, across twin groups, transitively) gets one window: the
  // union of the windows of all its twins. A set with no active group stays as it is (11f windows).
  const parent = cands.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const byPair = new Map();
  cands.forEach((c, i) => {
    for (const s of c.list) {
      if (!s._pairId) continue;
      const k = s._pairId;
      if (byPair.has(k)) parent[find(i)] = find(byPair.get(k));
      else byPair.set(k, i);
    }
  });
  const comps = new Map();
  cands.forEach((c, i) => {
    const r = find(i);
    if (!comps.has(r)) comps.set(r, []);
    comps.get(r).push(c);
  });
  for (const cc of comps.values()) {
    if (!cc.some((c) => c.active)) continue;
    let a = Infinity;
    let b = -Infinity;
    for (const c of cc) {
      for (const s of c.list) {
        a = Math.min(a, s.window[0]);
        b = Math.max(b, s.window[1]);
      }
    }
    for (const c of cc) {
      for (const s of c.list) {
        s.window = [a, b];
        s._win = [a, b];
      }
      if (c.active) c.sib._bal = { exit: c.exit, dx: c.dx, dy: c.dy, win: [a, b], base: new Float64Array(2 * c.sib.M) };
    }
  }
  return again;
}

// Do the segments of the polyline C (M points) cross a segment of the polyline S (M points)? A proper crossing only.
function polylinesCross(C, S, M) {
  for (let i = 0; i + 1 < M; i++) {
    const ax = C[2 * i];
    const ay = C[2 * i + 1];
    const dx = C[2 * i + 2] - ax;
    const dy = C[2 * i + 3] - ay;
    for (let j = 0; j + 1 < M; j++) {
      const px = S[2 * j];
      const py = S[2 * j + 1];
      const ex = S[2 * j + 2] - px;
      const ey = S[2 * j + 3] - py;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-12) continue;
      const wx = px - ax;
      const wy = py - ay;
      const tt = (wx * ey - wy * ex) / den;
      const ee = (wx * dy - wy * dx) / den;
      if (tt > 1e-9 && tt < 1 - 1e-9 && ee > 1e-9 && ee < 1 - 1e-9) return true;
    }
  }
  return false;
}

// The bounding-box diagonal of the first n points of P (x, y pairs).
function bboxDiag(P, n) {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let j = 0; j < n; j++) {
    x0 = Math.min(x0, P[2 * j]);
    x1 = Math.max(x1, P[2 * j]);
    y0 = Math.min(y0, P[2 * j + 1]);
    y1 = Math.max(y1, P[2 * j + 1]);
  }
  return Math.hypot(x1 - x0, y1 - y0);
}

// R10b-2 (b), R10b-3, R10c-2, R10c-3, run after the windows are set. Every twin is checked at its real window edge
// (window[0] for an entry, window[1] for an exit; the sibling is evaluated there with its own window and stagger).
//  - R10c-3: the bounding-box diagonal of the sibling there must be within 0.8 to 1.25 of its rest diagonal (the new
//    icon for an entry, the old icon for an exit). If not, the part is a normal part (facing-point anchor).
//  - R10c-2: a closed twin: the 50% copy (about the sibling centroid) must lie inside the sibling polygon (all points)
//    and no segment of the copy may cross a segment of the sibling outline. If not, the part is a normal part.
//  - R10b-3: a small closed copy (no side of 2 stroke widths or more) gets the open-twin motion.
// Returns true when a slot changed (the windows must be set again).
function checkClosedTwins(slots, A, B, o, K, easing) {
  if (!slots.some((s) => s.motion === 'twin')) return false;
  const stagger = Math.min(0.99, Math.max(0, o.stagger));
  const order = slots.map((s, i) => i).sort((x, y) => slots[y].weight - slots[x].weight || x - y);
  const last = Math.max(1, slots.length - 1);
  const rank = new Map();
  order.forEach((i, k) => rank.set(slots[i], k / last));
  const swT = Number.isFinite(o._swTo) ? o._swTo : 2;
  const cores = slots.filter((sl) => sl.role === 'core');
  let changed = false;
  // R11b-2: a slot that replaces another slot (a twin that becomes a normal part): the parts that ride on the old slot are built
  // again on the new one (the old object is not evaluated any more, so a part that kept it would be drawn near (0, 0)).
  const replace = (i, ps) => {
    const old = slots[i];
    ps._pairId = old._pairId;
    slots[i] = ps;
    changed = true;
    for (let j = 0; j < slots.length; j++) {
      const c = slots[j];
      if (c._anchorSlot !== old || (c.kind !== 'exit' && c.kind !== 'enter') || !c._att || !c._srcSt) continue;
      const att2 = { ...c._att, parentSlot: ps };
      const nc = buildPartSlot(c.kind, c._srcSt, c._srcIdx, o, K, cores, undefined, att2);
      nc.closedF = false;
      nc.closedT = false;
      nc.lod = false;
      nc.depth = 0.5;
      if (c._win) nc._win = c._win;
      nc._srcSt = c._srcSt;
      nc._srcIdx = c._srcIdx;
      replace(j, nc);
    }
  };
  const normal = (i, s) => {
    const ps = buildPartSlot(s.kind, s._twSt, s._twIdx, o, K, cores, undefined, s._att);
    ps.closedF = false;
    ps.closedT = false;
    ps.lod = false;
    ps.depth = 0.5;
    if (s._win) ps._win = s._win;
    ps._srcSt = s._twSt;
    ps._srcIdx = s._twIdx;
    replace(i, ps);
  };
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (s.motion !== 'twin') continue;
    const exit = s.kind === 'exit';
    const sib = s._twinSlot;
    // The sibling at the real window edge of the twin.
    const t = exit ? s.window[1] : s.window[0];
    const w0 = sib.window[0];
    const w1 = sib.window[1];
    let tl = w1 > w0 ? (t - w0) / (w1 - w0) : t >= w1 ? 1 : 0;
    tl = Math.min(1, Math.max(0, tl));
    const tau = Math.min(1, Math.max(0, (tl - stagger * rank.get(sib)) / (1 - stagger)));
    const u = tau <= 0 ? 0 : tau >= 1 ? 1 : easing(tau);
    evalSlot(sib, u, tau);
    const S = sib.buf;
    const M = sib.M;
    const loop = sib.mode === 'loop';
    const U = loop ? M - 1 : M;
    // R10c-3: the sibling must already have about its final size.
    const rest = bboxDiag(exit ? sib.F : sib.T, U);
    const now = bboxDiag(S, U);
    if (!(rest > 1e-9) || now < 0.8 * rest || now > 1.25 * rest) {
      normal(i, s);
      continue;
    }
    if (!s.twinClosed) continue;
    const c = meanPt(S, U);
    const k = s.twinScale;
    const C = new Float64Array(2 * M);
    for (let j = 0; j < M; j++) {
      C[2 * j] = c[0] + k * (S[2 * j] - c[0]);
      C[2 * j + 1] = c[1] + k * (S[2 * j + 1] - c[1]);
    }
    let ok = true;
    for (let j = 0; j < U && ok; j++) ok = pip(S, M, C[2 * j], C[2 * j + 1]);
    if (ok) ok = !polylinesCross(C, S, M);
    if (!ok) {
      normal(i, s);
      continue;
    }
    // R10b-3: a small copy (no side of 2 stroke widths or more) uses the open-twin motion.
    const P = s._tw.P;
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (let j = 0; j < U; j++) {
      x0 = Math.min(x0, P[2 * j]);
      x1 = Math.max(x1, P[2 * j]);
      y0 = Math.min(y0, P[2 * j + 1]);
      y1 = Math.max(y1, P[2 * j + 1]);
    }
    if (k * Math.max(x1 - x0, y1 - y0) < 2 * swT) {
      const ps = buildTwinSlot(s.kind, s._twSt, s._twIdx, s._tw, o, true);
      ps.closedF = false;
      ps.closedT = false;
      ps.lod = false;
      ps.depth = 0.5;
      if (s._win) ps._win = s._win;
      ps._tw = s._tw;
      ps._twSt = s._twSt;
      ps._twIdx = s._twIdx;
      ps._att = s._att;
      ps._lvl = s._lvl;
      ps.attach = 'free';
      ps.level = 1;
      replace(i, ps);
    }
  }
  return changed;
}

// A stroke that draws on (enter) or erases (exit) along its own path, with no parent (planDraw).
function buildDrawSlot(kind, st, idx, o) {
  const exit = kind === 'exit';
  const M = clampM(need(st, o), o);
  const P = formFor(st, M, st.closed ? FORM_LOOP : FORM_PASS);
  const e = exit ? M - 1 : 0;
  const ex = P[2 * e];
  const ey = P[2 * e + 1];
  const Z = new Float64Array(2 * M);
  for (let i = 0; i < M; i++) {
    Z[2 * i] = ex;
    Z[2 * i + 1] = ey;
  }
  const vis = P.vis || onesMask(M - 1);
  const slot = {
    kind,
    role: 'core',
    mode: st.closed ? 'loop' : 'pass',
    fromIndex: exit ? idx : -1,
    toIndex: exit ? -1 : idx,
    M,
    F: exit ? P : Z,
    T: exit ? Z : P,
    visF: vis,
    visT: vis,
    weight: st.length,
    fromOp: st.opacity,
    toOp: st.opacity,
    fill: !!st.fill,
    sw0: st.sw === undefined ? null : st.sw,
    sw1: st.sw === undefined ? null : st.sw,
    ws0: exit && st.ws0 !== undefined ? st.ws0 : 1,
    buf: new Float64Array(2 * M),
    static: false,
    bigTurn: false,
    flip: false,
    theta: 0,
    scale: 1,
    motion: exit ? 'erase' : 'draw',
    chain: { from: exit ? st.bridges : 0, to: exit ? 0 : st.bridges },
    anchor: -1,
    anchorIndex: -1,
    window: [0, 1],
    _anchorSlot: null,
    a0x: ex,
    a0y: ey,
    a1x: ex,
    a1y: ey,
    ex,
    ey,
  };
  slot.cum = cumLen(P, M);
  slot.L = slot.cum[M - 1];
  buildClasses(slot);
  return slot;
}

// ---------------------------------------------------------------------------
// R5 Rule 4b: chain bridges open and close by moving
// ---------------------------------------------------------------------------

// The points of the sub-polyline of points a..b between arc lengths s0 and s1 (cum is relative to point a).
function polySub(L, a, b, cum, s0, s1) {
  const pts = [];
  const at = (s) => {
    let k = 0;
    while (k < b - a - 1 && cum[k + 1] < s) k++;
    const seg = cum[k + 1] - cum[k];
    const f = seg > 0 ? Math.min(1, Math.max(0, (s - cum[k]) / seg)) : 0;
    const i = a + k;
    return [L[2 * i] + (L[2 * i + 2] - L[2 * i]) * f, L[2 * i + 1] + (L[2 * i + 3] - L[2 * i + 1]) * f];
  };
  const p0 = at(s0);
  pts.push(p0[0], p0[1]);
  for (let k = 1; k <= b - a; k++) {
    if (cum[k] > s0 && cum[k] < s1) pts.push(L[2 * (a + k)], L[2 * (a + k) + 1]);
  }
  const p1 = at(s1);
  pts.push(p1[0], p1[1]);
  return Float64Array.from(pts);
}

// The pieces of the slot polyline that show at eased progress u. A run that becomes hidden (class 1) opens
// from its middle: its hidden part is the central fraction u. A run that becomes visible (class 2) closes
// from its ends toward its middle. Class 0 runs always show. Returns an array of point arrays.
function slotPieces(slot, u) {
  const L = slot.buf;
  const out = [];
  const r0 = slot.runs[0];
  if (r0) for (let r = 0; r < r0.length; r += 2) out.push(L.slice(2 * r0[r], 2 * (r0[r + 1] + 1)));
  for (let c = 1; c <= 2; c++) {
    const list = slot.runs[c];
    if (!list) continue;
    const h = c === 1 ? u : 1 - u; // hidden fraction
    if (h >= 1) continue;
    if (slot.archWhole && h > 0) {
      // R11c-3: the revealed length is measured along the whole polyline (both ends toward the middle); only the real runs show.
      const M1 = L.length / 2;
      const cw = new Float64Array(M1);
      for (let k = 1; k < M1; k++) cw[k] = cw[k - 1] + dist(L[2 * k], L[2 * k + 1], L[2 * k - 2], L[2 * k - 1]);
      const Lw = cw[M1 - 1];
      const visW = ((1 - h) / 2) * Lw;
      if (!(visW > 1e-9)) continue;
      for (let r = 0; r < list.length; r += 2) {
        const a = list[r];
        const b = list[r + 1];
        const rel = new Float64Array(b - a + 1);
        for (let k = 0; k <= b - a; k++) rel[k] = cw[a + k] - cw[a];
        for (const [s0, s1] of [[0, visW], [Lw - visW, Lw]]) {
          const lo = Math.max(s0, cw[a]);
          const hi = Math.min(s1, cw[b]);
          if (hi - lo > 1e-9) out.push(polySub(L, a, b, rel, lo - cw[a], hi - cw[a]));
        }
      }
      continue;
    }
    for (let r = 0; r < list.length; r += 2) {
      const a = list[r];
      const b = list[r + 1];
      if (h <= 0) {
        out.push(L.slice(2 * a, 2 * (b + 1)));
        continue;
      }
      const cum = new Float64Array(b - a + 1);
      for (let k = 1; k <= b - a; k++) cum[k] = cum[k - 1] + dist(L[2 * (a + k)], L[2 * (a + k) + 1], L[2 * (a + k) - 2], L[2 * (a + k) - 1]);
      const Lr = cum[b - a];
      const vis = ((1 - h) / 2) * Lr;
      if (!(vis > 1e-9)) continue; // (R11b-4: a two-sided arch starts with very short pieces)
      out.push(polySub(L, a, b, cum, 0, vis));
      out.push(polySub(L, a, b, cum, Lr - vis, Lr));
    }
  }
  return out;
}

function piecesToD(pieces) {
  let d = '';
  for (let r = 0; r < pieces.length; r++) {
    const P = pieces[r];
    const parts = new Array(P.length);
    for (let k = 0; k < P.length; k++) parts[k] = fmt(P[k]);
    d += (r ? ' M' : 'M') + parts.join(' ');
  }
  return d;
}

// ---------------------------------------------------------------------------
// R4-3: whole-icon turn
// ---------------------------------------------------------------------------

// Turn the points of an array by g degrees (0, 90, 180, 270) about (12, 12). Exact, no trig. Keeps .vis.
function turnPts(L, g) {
  if (g === 0) return L;
  const out = new Float64Array(L.length);
  for (let i = 0; i < L.length; i += 2) {
    const x = L[i];
    const y = L[i + 1];
    if (g === 90) {
      out[i] = 24 - y;
      out[i + 1] = x;
    } else if (g === 180) {
      out[i] = 24 - x;
      out[i + 1] = 24 - y;
    } else {
      out[i] = y;
      out[i + 1] = 24 - x;
    }
  }
  if (L.vis) out.vis = L.vis;
  return out;
}

function turnStroke(s, g) {
  return { ...s, id: strokeId++, pts: turnPts(s.pts, g), cacheable: false, _ext: undefined, _info: undefined, _ts: undefined };
}

const TURN_LIMIT = 0.01; // mean squared distance for a pair to match under a turn

// One-to-one pairing of the from strokes and the to strokes, with every pair within TURN_LIMIT after the
// from strokes turn by g degrees. Returns row -> column, or null.
function turnPairing(A, B, coarseA, coarseB, K, g) {
  const n = A.length;
  const cost = new Float64Array(n * n).fill(1e9);
  const cA = coarseA.map((L) => turnPts(L, g));
  // R5 Rule 7: the centroid is taken over the unique points (a loop repeats its first point).
  const cenA = cA.map((L, i) => centroidOf(L, A[i].closed));
  const cenB = coarseB.map((L, j) => centroidOf(L, B[j].closed));
  for (let i = 0; i < n; i++) {
    let any = false;
    for (let j = 0; j < n; j++) {
      if (A[i].closed !== B[j].closed) continue;
      if (!sameStyle(A[i], B[j])) continue;
      const dx = cenA[i][0] - cenB[j][0];
      const dy = cenA[i][1] - cenB[j][1];
      if (dx * dx + dy * dy > 2 * TURN_LIMIT) continue; // the mean squared distance is about the centroid distance squared or more
      const c = scanCost(cA[i], coarseB[j], K, A[i].closed, 1, null, 0);
      if (c <= TURN_LIMIT) {
        cost[i * n + j] = c;
        any = true;
      }
    }
    if (!any) return null;
  }
  const asg = hungarian(cost, n);
  for (let i = 0; i < n; i++) if (cost[i * n + asg[i]] > TURN_LIMIT) return null;
  return asg;
}

function centroidOf(L, closed) {
  const M = closed ? L.length / 2 - 1 : L.length / 2;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < M; i++) {
    cx += L[2 * i];
    cy += L[2 * i + 1];
  }
  return [cx / M, cy / M];
}

// R5 Rule 7: one open stroke with at most 3 vertices, and a mirror about the vertical or horizontal axis through
// (12, 12) maps it onto the other (a chevron, a V). That is a flip, not a turn.
function singleVMirror(a, b) {
  if (a.closed || b.closed) return false;
  const na = a.pts.length / 2;
  const nb = b.pts.length / 2;
  if (na > 3 || nb > 3 || na !== nb) return false;
  for (let ax = 0; ax < 2; ax++) {
    for (let dir = 1; dir >= -1; dir -= 2) {
      let sum = 0;
      for (let i = 0; i < na; i++) {
        const j = dir > 0 ? i : na - 1 - i;
        const x = ax === 0 ? 24 - a.pts[2 * i] : a.pts[2 * i];
        const y = ax === 0 ? a.pts[2 * i + 1] : 24 - a.pts[2 * i + 1];
        const dx = x - b.pts[2 * j];
        const dy = y - b.pts[2 * j + 1];
        sum += dx * dx + dy * dy;
      }
      if (sum / na <= TURN_LIMIT) return true;
    }
  }
  return false;
}

// Whole-icon turn: { g, pair } or null. Not a turn when the strokes already match with no turn.
function detectWholeTurn(A, B, coarseA, coarseB, K) {
  const n = A.length;
  if (n === 0 || n !== B.length) return null;
  if (n === 1 && singleVMirror(A[0], B[0])) return null;
  if (turnPairing(A, B, coarseA, coarseB, K, 0)) return null;
  for (const g of [90, 180, 270]) {
    const pair = turnPairing(A, B, coarseA, coarseB, K, g);
    if (pair) return { g, pair };
  }
  return null;
}

// Every point turns about (12, 12) by theta (radians): X = c0 + R(theta u) lerp(F - c0, R(-theta)(T - c0), u).
function prepareTurn(slot, theta) {
  const { F, T, M } = slot;
  const Fc = new Float64Array(2 * M);
  const Tp = new Float64Array(2 * M);
  const co = Math.cos(-theta);
  const si = Math.sin(-theta);
  for (let i = 0; i < M; i++) {
    Fc[2 * i] = F[2 * i] - 12;
    Fc[2 * i + 1] = F[2 * i + 1] - 12;
    const x = T[2 * i] - 12;
    const y = T[2 * i + 1] - 12;
    Tp[2 * i] = co * x - si * y;
    Tp[2 * i + 1] = si * x + co * y;
  }
  slot.motion = 'rigid';
  slot.static = false;
  slot.flip = false;
  slot.theta = theta;
  slot.scale = 1;
  slot._r = { cFx: 12, cFy: 12, cTx: 12, cTy: 12, Fc, Tp };
}

// ---------------------------------------------------------------------------
// R6-1: level of detail. A proxy is the simple shape of a stroke.
// ---------------------------------------------------------------------------

function sgnPow(x, p) {
  const a = Math.pow(Math.abs(x), p);
  return x < 0 ? -a : a;
}

// A closed superellipse |x/a|^n + |y/b|^n = 1 turned by phi about its center, as U points at equal arc length.
function superellipseLoop(cx, cy, a, b, phi, n, U) {
  const Nd = 4 * U;
  const D = new Float64Array(2 * Nd);
  const p = 2 / n;
  const co = Math.cos(phi);
  const si = Math.sin(phi);
  for (let k = 0; k < Nd; k++) {
    const t = (TAU * k) / Nd;
    const x = a * sgnPow(Math.cos(t), p);
    const y = b * sgnPow(Math.sin(t), p);
    D[2 * k] = cx + co * x - si * y;
    D[2 * k + 1] = cy + si * x + co * y;
  }
  const cum = new Float64Array(Nd + 1);
  for (let k = 1; k <= Nd; k++) {
    const i = k % Nd;
    cum[k] = cum[k - 1] + dist(D[2 * i], D[2 * i + 1], D[2 * (k - 1)], D[2 * (k - 1) + 1]);
  }
  const out = new Float64Array(2 * U);
  const total = cum[Nd];
  let idx = 0;
  for (let q = 0; q < U; q++) {
    const s = (total * q) / U;
    while (idx < Nd - 1 && cum[idx + 1] < s) idx++;
    const seg = cum[idx + 1] - cum[idx];
    const f = seg > 0 ? (s - cum[idx]) / seg : 0;
    const i1 = (idx + 1) % Nd;
    out[2 * q] = D[2 * idx] + (D[2 * i1] - D[2 * idx]) * f;
    out[2 * q + 1] = D[2 * idx + 1] + (D[2 * i1 + 1] - D[2 * idx + 1]) * f;
  }
  return out;
}

// The superellipse fit of a closed polyline of M points (first = last). Returns { cx, cy, a, b, phi, n } or null for a point.
function fitSuperellipse(F, M) {
  const U = M - 1;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < U; i++) {
    mx += F[2 * i];
    my += F[2 * i + 1];
  }
  mx /= U;
  my /= U;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < U; i++) {
    const dx = F[2 * i] - mx;
    const dy = F[2 * i + 1] - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const phi = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const co = Math.cos(phi);
  const si = Math.sin(phi);
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  let area = 0;
  for (let i = 0; i < U; i++) {
    const dx = F[2 * i] - mx;
    const dy = F[2 * i + 1] - my;
    const u = co * dx + si * dy;
    const v = -si * dx + co * dy;
    if (u < u0) u0 = u;
    if (u > u1) u1 = u;
    if (v < v0) v0 = v;
    if (v > v1) v1 = v;
    const j = (i + 1) % U;
    area += F[2 * i] * F[2 * j + 1] - F[2 * j] * F[2 * i + 1];
  }
  area = Math.abs(area) / 2;
  const a = (u1 - u0) / 2;
  const b = (v1 - v0) / 2;
  if (!(a > 1e-6) && !(b > 1e-6)) return null;
  const cu = (u0 + u1) / 2;
  const cv = (v0 + v1) / 2;
  const A = Math.max(a, 1e-6);
  const B = Math.max(b, 1e-6);
  return { cx: mx + co * cu - si * cv, cy: my + si * cu + co * cv, a: A, b: B, phi, n: area / (4 * A * B) >= 0.88 ? 4 : 2 };
}

// The closed proxy of a closed polyline F (M points). Aligned to F by the best shift and direction.
function proxyClosed(F, M) {
  const fit = fitSuperellipse(F, M);
  const out = new Float64Array(2 * M);
  if (!fit) {
    for (let i = 0; i < M; i++) {
      out[2 * i] = F[0];
      out[2 * i + 1] = F[1];
    }
    return out;
  }
  const U = M - 1;
  const K = DEFAULTS.coarsePoints;
  // Coarse alignment: F sampled at K points against a 48 point proxy.
  const Fc = new Float64Array(2 * K);
  for (let i = 0; i < K; i++) {
    const j = Math.round((i * U) / (K - 1));
    Fc[2 * i] = F[2 * j];
    Fc[2 * i + 1] = F[2 * j + 1];
  }
  const Pc = superellipseLoop(fit.cx, fit.cy, fit.a, fit.b, fit.phi, fit.n, K - 1);
  scanCost(Fc, Pc, K, true, 1, null, 0);
  const sc = scanRes.s;
  const dir = scanRes.dir;
  const Pf = superellipseLoop(fit.cx, fit.cy, fit.a, fit.b, fit.phi, fit.n, U);
  const shifts = windowShifts(sc, M, K);
  scanCost(F, Pf, M, true, 1, shifts, dir);
  buildCand(Pf, M, true, scanRes.s, scanRes.dir, out);
  return out;
}

function wrap2pi(x) {
  const t = x % TAU;
  return t < 0 ? t + TAU : t;
}

// The open proxy of an open polyline F (M points): the arc through its start, its arc-length middle, and its end.
// A nearly straight stroke gets the chord. Point i of the proxy belongs to point i of F.
function proxyOpen(F, M) {
  const out = new Float64Array(2 * M);
  const cum = cumLen(F, M);
  const len = cum[M - 1];
  const x0 = F[0];
  const y0 = F[1];
  const x1 = F[2 * M - 2];
  const y1 = F[2 * M - 1];
  if (len < 0.02) {
    out.set(F);
    return out;
  }
  let k = 0;
  while (k < M - 2 && cum[k + 1] < len / 2) k++;
  const seg = cum[k + 1] - cum[k];
  const f = seg > 0 ? (len / 2 - cum[k]) / seg : 0;
  const xm = F[2 * k] + (F[2 * k + 2] - F[2 * k]) * f;
  const ym = F[2 * k + 1] + (F[2 * k + 3] - F[2 * k + 1]) * f;
  const cl = dist(x0, y0, x1, y1);
  const chord = () => {
    for (let i = 0; i < M; i++) {
      out[2 * i] = x0 + ((x1 - x0) * i) / (M - 1);
      out[2 * i + 1] = y0 + ((y1 - y0) * i) / (M - 1);
    }
    return out;
  };
  let cx;
  let cy;
  let sweep;
  let a0;
  if (cl < 1e-3) {
    // The ends meet: the circle with the start and the middle point as a diameter.
    cx = (x0 + xm) / 2;
    cy = (y0 + ym) / 2;
    a0 = Math.atan2(y0 - cy, x0 - cx);
    sweep = TAU;
  } else {
    const dev = Math.abs((x1 - x0) * (ym - y0) - (y1 - y0) * (xm - x0)) / cl;
    if (dev <= 0.15) return chord();
    const d = 2 * (x0 * (ym - y1) + xm * (y1 - y0) + x1 * (y0 - ym));
    if (Math.abs(d) < 1e-9) return chord();
    const s0 = x0 * x0 + y0 * y0;
    const sm = xm * xm + ym * ym;
    const s1 = x1 * x1 + y1 * y1;
    cx = (s0 * (ym - y1) + sm * (y1 - y0) + s1 * (y0 - ym)) / d;
    cy = (s0 * (x1 - xm) + sm * (x0 - x1) + s1 * (xm - x0)) / d;
    a0 = Math.atan2(y0 - cy, x0 - cx);
    const am = Math.atan2(ym - cy, xm - cx);
    const a1 = Math.atan2(y1 - cy, x1 - cx);
    const dm = wrap2pi(am - a0);
    const d1 = wrap2pi(a1 - a0);
    sweep = dm <= d1 ? d1 : d1 - TAU;
  }
  const R = Math.hypot(x0 - cx, y0 - cy);
  if (!(R < 1e4)) return chord();
  for (let i = 0; i < M; i++) {
    const a = a0 + (sweep * i) / (M - 1);
    out[2 * i] = cx + R * Math.cos(a);
    out[2 * i + 1] = cy + R * Math.sin(a);
  }
  out[0] = x0;
  out[1] = y0;
  if (cl >= 1e-3) {
    out[2 * M - 2] = x1;
    out[2 * M - 1] = y1;
  }
  return out;
}

// Set up the three steps of a hard slot. closedF and closedT tell whether the stroke on that side is closed.
function prepareLod(slot, o, easing) {
  const { F, T, M } = slot;
  const PF = slot.closedF ? proxyClosed(F, M) : proxyOpen(F, M);
  const PT = slot.closedT ? proxyClosed(T, M) : proxyOpen(T, M);
  const mid = { F: PF, T: PT, M, static: false };
  prepareSlotMotion(mid, o, null, null);
  slot.lod = true;
  slot.lodSplit = [o.lodSplit[0], o.lodSplit[1]];
  slot._lod = { PF, PT, mid, ease: easing };
}

// ---------------------------------------------------------------------------
// R6-2: physical objects. Depth inside one icon, rest overlap, and the point under a closed parent.
// ---------------------------------------------------------------------------

// Point in polygon (ray casting) for the points P[0..n-1].
function pip(P, n, x, y) {
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = P[2 * i];
    const yi = P[2 * i + 1];
    const xj = P[2 * j];
    const yj = P[2 * j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Distance from (x, y) to the closed polygon P[0..n-1].
function distToPoly(P, n, x, y) {
  let best = Infinity;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = P[2 * j];
    const ay = P[2 * j + 1];
    const bx = P[2 * i];
    const by = P[2 * i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
    t = Math.min(1, Math.max(0, t));
    const d = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
    if (d < best) best = d;
  }
  return best;
}

function strokeInfo(s) {
  if (s._info) return s._info;
  const P = s.pts;
  const n = P.length / 2;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let cx = 0;
  let cy = 0;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const x = P[2 * i];
    const y = P[2 * i + 1];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    cx += x;
    cy += y;
    const j = (i + 1) % n;
    area += x * P[2 * j + 1] - P[2 * j] * y;
  }
  s._info = { n, x0, y0, x1, y1, cx: cx / n, cy: cy / n, area: Math.abs(area) / 2 };
  return s._info;
}

// Does stroke j lie inside the closed stroke i? Its centroid is inside the polygon and its box is inside the box of i.
function lieInside(si, sj) {
  if (!si.closed || si === sj) return false;
  const a = strokeInfo(si);
  const b = strokeInfo(sj);
  const e = 1e-6;
  if (b.x0 < a.x0 - e || b.x1 > a.x1 + e || b.y0 < a.y0 - e || b.y1 > a.y1 + e) return false;
  return pip(si.pts, a.n, b.cx, b.cy);
}

/**
 * Normalized depth of every stroke of one icon: 0 is the back, 1 is the front (0.5 for a single stroke).
 * A stroke that lies inside a closed stroke is in front of it. Otherwise a smaller closed stroke is in front of a
 * larger one (by area), and an open stroke is in front of a closed one. Ties keep the source order (later is in front).
 */
function strokeDepths(S) {
  const n = S.length;
  const out = new Float64Array(n);
  if (n === 1) {
    out[0] = 0.5;
    return out;
  }
  const front = (i, j) => {
    // > 0: i in front of j
    const a = S[i];
    const b = S[j];
    if (lieInside(b, a)) return 1;
    if (lieInside(a, b)) return -1;
    if (a.closed && b.closed) {
      const d = strokeInfo(b).area - strokeInfo(a).area;
      if (Math.abs(d) > 1e-6) return d > 0 ? 1 : -1;
    } else if (a.closed !== b.closed) return a.closed ? -1 : 1;
    return i - j;
  };
  const order = Array.from({ length: n }, (_, i) => i);
  order.sort((i, j) => front(i, j));
  order.forEach((idx, rank) => {
    out[idx] = rank / (n - 1);
  });
  return out;
}

// Rest overlap matrix of one icon: does any ink of one stroke lie inside the closed interior of another?
// coarse: the coarse forms of the strokes. Returns a Uint8Array n * n.
function restOverlap(S, coarse) {
  const n = S.length;
  const out = new Uint8Array(n * n);
  for (let i = 0; i < n; i++) {
    if (!S[i].closed) continue;
    const Pi = coarse[i];
    const ni = Pi.length / 2 - 1;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const Pj = coarse[j];
      const nj = Pj.length / 2;
      for (let k = 0; k < nj; k++) {
        const x = Pj[2 * k];
        const y = Pj[2 * k + 1];
        // Ink, not centerline (R6b): a stroke has half width 1 (plus 0.05). It overlaps the interior when a point lies
        // inside the shape (at any depth, so within 1.05 of the edge on the inside too), or on the edge (a stroke end
        // on the edge has its round cap inside).
        if (pip(Pi, ni, x, y) || distToPoly(Pi, ni, x, y) < 1e-3) {
          out[i * n + j] = 1;
          out[j * n + i] = 1;
          break;
        }
      }
    }
  }
  return out;
}

// The point under a closed parent: the centroid of its current polyline if that is inside, else a point 1 unit
// inside from the anchor point. Writes the result to underQ.
const underQ = { x: 0, y: 0 };
function underPoint(P, M, ai, ax, ay) {
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < M; i++) {
    cx += P[2 * i];
    cy += P[2 * i + 1];
  }
  cx /= M;
  cy /= M;
  if (pip(P, M, cx, cy)) {
    underQ.x = cx;
    underQ.y = cy;
    return;
  }
  const i0 = Math.max(0, ai - 1);
  const i1 = Math.min(M - 1, ai + 1);
  let tx = P[2 * i1] - P[2 * i0];
  let ty = P[2 * i1 + 1] - P[2 * i0 + 1];
  const tl = Math.hypot(tx, ty);
  underQ.x = ax;
  underQ.y = ay;
  if (tl < 1e-9) return;
  tx /= tl;
  ty /= tl;
  const px = ax - ty;
  const py = ay + tx;
  const mx = ax + ty;
  const my = ay - tx;
  if (pip(P, M, px, py)) {
    underQ.x = px;
    underQ.y = py;
  } else if (pip(P, M, mx, my)) {
    underQ.x = mx;
    underQ.y = my;
  }
}

// How an exit goes under its parent, and how an entry comes out from under it. w runs from 0 (at the parent line,
// full size) to 1 (a point under the parent). The part slides in the first 70% and scales to 0.6, then shrinks to a point.
function underSlide(w) {
  const t = Math.min(1, w / 0.7);
  return t * t * (3 - 2 * t);
}
function underScale(w) {
  return w < 0.7 ? 1 - (0.4 * w) / 0.7 : (0.6 * (1 - w)) / 0.3;
}

// ---------------------------------------------------------------------------
// R5 Rules 1 to 3: matching
// ---------------------------------------------------------------------------

const BIG = 1e9;

function strokeWeight(st) {
  return st.length * (st.closed ? 1.5 : 1);
}

// Pair cost and best coarse alignment of stroke a (from) and stroke b (to). Closed to open uses cut.
// ca and cb are the coarse natural forms. Returns a shared object.
const pairRes = { c: 0, mode: MODE_LOOP, s: 0, dir: 1 };
function pairInfo(a, ca, b, cb, K, o) {
  let c;
  let mode;
  if (a.closed && b.closed) {
    c = scanCost(ca, cb, K, true, o.travelWeight, null, 0);
    mode = MODE_LOOP;
  } else if (!a.closed && !b.closed) {
    c = scanCost(ca, cb, K, false, o.travelWeight, null, 0);
    mode = MODE_PASS;
  } else {
    // The open stroke is the fixed side X (its pass form). The closed stroke is the loop Y that is cut.
    c = scanCost(a.closed ? cb : ca, a.closed ? ca : cb, K, true, o.travelWeight, null, 0);
    mode = MODE_CUT;
  }
  pairRes.c = c;
  pairRes.mode = mode;
  pairRes.s = scanRes.s;
  pairRes.dir = scanRes.dir;
  return pairRes;
}

// Rule 3 gate: are two parts alike? Same kind, similar length, similar shape.
const GATE_N = 25;
function partsAlike(a, b, o) {
  if (a.closed !== b.closed) return false;
  const lo = Math.max(Math.min(a.length, b.length), 1e-3);
  const hi = Math.max(a.length, b.length, 1e-3);
  if (hi / lo > o.partSizeRatio) return false;
  const form = a.closed ? FORM_LOOP : FORM_PASS;
  const la = formFor(a, GATE_N, form);
  const lb = formFor(b, GATE_N, form);
  const sa = spread2(la);
  const sb = spread2(lb);
  if (sa < 1e-9 && sb < 1e-9) return true;
  if (sa < 1e-9 || sb < 1e-9) return false;
  flipScan(la, lb, GATE_N, a.closed, false, null, 0);
  return flipRes.rRot <= o.partShapeMax;
}

/**
 * Rules 1 to 3. Returns raw slot descriptions:
 *   { kind: 'match', fi, ti, mode, s, dir, role } or { kind: 'exit', fi } or { kind: 'enter', ti }.
 */
function rulesMatching(A, B, coarseA, coarseB, K, o, turnPair) {
  const n = A.length;
  const m = B.length;
  const wA = A.map(strokeWeight);
  const wB = B.map(strokeWeight);
  const mxA = wA.reduce((x, y) => Math.max(x, y), 0);
  const mxB = wB.reduce((x, y) => Math.max(x, y), 0);
  const coreA = wA.map((w, i) => (A[i]._role === 'kept' ? true : A[i]._role === 'changed' ? false : w >= 0.5 * mxA));
  const coreB = wB.map((w, j) => (B[j]._role === 'kept' ? true : B[j]._role === 'changed' ? false : w >= 0.5 * mxB));
  const raw = [];
  const tieOfA = new Map(); // R11-6: stroke index in A -> its tie record
  const tie = (i, j, role) => {
    const r = pairInfo(A[i], coarseA[i], B[j], coarseB[j], K, o);
    const rec = { kind: 'match', fi: i, ti: j, mode: r.mode, s: r.s, dir: r.dir, role };
    raw.push(rec);
    tieOfA.set(i, rec);
    return rec;
  };
  if (turnPair) {
    for (let i = 0; i < n; i++) tie(i, turnPair[i], coreA[i] || coreB[turnPair[i]] ? 'core' : 'part');
    return raw;
  }
  const usedA = new Uint8Array(n);
  const usedB = new Uint8Array(m);

  // R14: kept pieces (the overlap of two strokes) pair up and are static.
  for (let i = 0; i < n; i++) {
    const w = A[i]._keepWith;
    if (!w) continue;
    const j = B.indexOf(w);
    if (j < 0 || usedA[i] || usedB[j]) continue;
    usedA[i] = 1;
    usedB[j] = 1;
    tie(i, j, 'core').keep = true;
  }
  // Static strokes: the same shape at the same place in both icons. They stay put and take no part in the rules.
  const cenA = coarseA.map((L, i) => centroidOf(L, A[i].closed));
  const cenB = coarseB.map((L, j) => centroidOf(L, B[j].closed));
  const cands = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      if (A[i].closed !== B[j].closed) continue;
      if (!sameStyle(A[i], B[j])) continue;
      if (Math.abs(A[i].length - B[j].length) > 0.02 * Math.max(A[i].length, B[j].length) + 0.05) continue;
      if (Math.abs(cenA[i][0] - cenB[j][0]) > 0.2 || Math.abs(cenA[i][1] - cenB[j][1]) > 0.2) continue;
      const c = scanCost(coarseA[i], coarseB[j], K, A[i].closed, 1, null, 0);
      if (c < 1e-6 || c < 1e-4 * spread2(coarseB[j])) cands.push({ i, j, c });
    }
  }
  cands.sort((x, y) => x.c - y.c || x.i - y.i || x.j - y.j);
  for (const c of cands) {
    if (usedA[c.i] || usedB[c.j]) continue;
    usedA[c.i] = 1;
    usedB[c.j] = 1;
    tie(c.i, c.j, coreA[c.i] ? 'core' : 'part');
  }

  // Rule 2: core to core, always. A closed core stroke that meets an open one is cut.
  const cA = [];
  const cB = [];
  for (let i = 0; i < n; i++) if (!usedA[i] && coreA[i]) cA.push(i);
  for (let j = 0; j < m; j++) if (!usedB[j] && coreB[j]) cB.push(j);
  if (cA.length && cB.length) {
    const N = Math.max(cA.length, cB.length);
    const cost = new Float64Array(N * N);
    for (let x = 0; x < cA.length; x++) {
      for (let y = 0; y < cB.length; y++) {
        cost[x * N + y] = sameStyle(A[cA[x]], B[cB[y]]) ? pairInfo(A[cA[x]], coarseA[cA[x]], B[cB[y]], coarseB[cB[y]], K, o).c : BIG;
      }
    }
    const asg = hungarian(cost, N);
    for (let x = 0; x < cA.length; x++) {
      const y = asg[x];
      if (y >= cB.length || cost[x * N + y] >= BIG / 2) continue;
      usedA[cA[x]] = 1;
      usedB[cB[y]] = 1;
      tie(cA[x], cB[y], 'core');
    }
  }

  // Rule 3: a part ties to a part only when they are alike. The leftover core strokes are parts.
  // R11-6: when at least one of two parts is attached to a parent, they tie only if their parents are tied to each other and
  // their anchor points (the contact point, or for a free part the point of its parent nearest to it) lie at about the same
  // place on the parent (within a quarter of its outline, after the alignment of the parent tie). The ties run level by level,
  // so a parent tie exists before the parts on it are considered.
  const trA = A.tree || null;
  const trB = B.tree || null;
  const lvl = (tr, i) => (tr && tr[i] && tr[i].level > 0 ? tr[i].level : 1);
  const attachedNode = (tr, i) => (tr && tr[i] && tr[i].attach && tr[i].attach !== 'free' && tr[i].parent >= 0 ? tr[i] : null);
  const anchorOf = (S, tr, i) => {
    const nd = tr[i];
    if (nd.attach && nd.attach !== 'free' && nd.contact) return nd.contact;
    // A free part: the point of its nearest core stroke that is nearest to the centroid of the part.
    if (nd.parent < 0) return null;
    const c = centroidOf(formFor(S[i], 25, S[i].closed ? FORM_LOOP : FORM_PASS), S[i].closed);
    const q = nearestOnStroke(S[nd.parent], c[0], c[1]);
    return [q.x, q.y];
  };
  const nearIdx = (L, K2, pt) => {
    let bi = 0;
    let bd = Infinity;
    for (let k = 0; k < K2; k++) {
      const d = (L[2 * k] - pt[0]) ** 2 + (L[2 * k + 1] - pt[1]) ** 2;
      if (d < bd) {
        bd = d;
        bi = k;
      }
    }
    return bi;
  };
  const sameSpot = (i, j) => {
    const a = attachedNode(trA, i);
    const b = attachedNode(trB, j);
    if (!a && !b) return true;
    if (!trA || !trB) return true;
    const pi = a ? a.parent : trA[i].parent;
    const pj = b ? b.parent : trB[j].parent;
    if (pi < 0 || pj < 0) return false;
    const rec = tieOfA.get(pi);
    if (!rec || rec.ti !== pj) return false;
    const ptA = anchorOf(A, trA, i);
    const ptB = anchorOf(B, trB, j);
    if (!ptA || !ptB) return true;
    if (rec.mode !== MODE_LOOP && rec.mode !== MODE_PASS) return true;
    const ka = nearIdx(coarseA[pi], K, ptA);
    const kb = nearIdx(coarseB[pj], K, ptB);
    if (rec.mode === MODE_LOOP) {
      const U = K - 1;
      const kb2 = (((rec.s + rec.dir * ka) % U) + U) % U;
      const dd = Math.abs(kb - kb2);
      return Math.min(dd, U - dd) <= U / 4;
    }
    const kb2 = rec.dir > 0 ? ka : K - 1 - ka;
    return Math.abs(kb - kb2) <= (K - 1) / 4;
  };
  const partPass = (inPass) => {
    const pA = [];
    const pB = [];
    for (let i = 0; i < n; i++) if (!usedA[i]) pA.push(i);
    for (let j = 0; j < m; j++) if (!usedB[j]) pB.push(j);
    if (!pA.length || !pB.length) return;
    const N = Math.max(pA.length, pB.length);
    const cost = new Float64Array(N * N);
    let any = false;
    for (let x = 0; x < pA.length; x++) {
      for (let y = 0; y < pB.length; y++) {
        const i = pA[x];
        const j = pB[y];
        let c = BIG;
        if (inPass(i, j) && sameStyle(A[i], B[j]) && (!o.partGate || partsAlike(A[i], B[j], o)) && sameSpot(i, j)) {
          c = pairInfo(A[i], coarseA[i], B[j], coarseB[j], K, o).c;
          any = true;
        }
        cost[x * N + y] = c;
      }
    }
    if (any) {
      const asg = hungarian(cost, N);
      for (let x = 0; x < pA.length; x++) {
        const y = asg[x];
        if (y >= pB.length || cost[x * N + y] >= BIG / 2) continue;
        usedA[pA[x]] = 1;
        usedB[pB[y]] = 1;
        tie(pA[x], pB[y], 'part');
      }
    }
  };
  let maxLvl = 1;
  for (let i = 0; i < n; i++) if (!usedA[i]) maxLvl = Math.max(maxLvl, lvl(trA, i));
  for (let j = 0; j < m; j++) if (!usedB[j]) maxLvl = Math.max(maxLvl, lvl(trB, j));
  // Pass L takes the pairs whose deeper part has level L (level 1 first: free parts and parts on the core).
  for (let L = 1; L <= maxLvl; L++) partPass((i, j) => Math.max(lvl(trA, i), lvl(trB, j)) === L);
  for (let i = 0; i < n; i++) if (!usedA[i]) raw.push({ kind: 'exit', fi: i });
  for (let j = 0; j < m; j++) if (!usedB[j]) raw.push({ kind: 'enter', ti: j });
  return raw;
}

// Round 4 matching (matching: 'legacy'): vanish and appear by penalty, merge, split, collapse, grow.
function legacyMatching(A, B, coarseA, coarseB, K, o, turnPair) {
  const n = A.length;
  const m = B.length;
  // Pair costs, forms, and best coarse alignment.
  const D = new Float64Array(n * m);
  const pMode = new Int8Array(n * m);
  const pS = new Int32Array(n * m);
  const pD = new Int8Array(n * m);
  for (let i = 0; i < n; i++) {
    const a = A[i];
    for (let j = 0; j < m; j++) {
      const b = B[j];
      const idx = i * m + j;
      let c;
      if (a.closed && b.closed) {
        c = scanCost(coarseA[i], coarseB[j], K, true, o.travelWeight, null, 0);
        pMode[idx] = MODE_LOOP;
      } else if (!a.closed && !b.closed) {
        c = scanCost(coarseA[i], coarseB[j], K, false, o.travelWeight, null, 0);
        pMode[idx] = MODE_PASS;
      } else {
        const cl = a.closed ? coarseA[i] : coarseB[j];
        const op = a.closed ? B[j] : A[i];
        const cut = scanCost(formFor(op, K, FORM_PASS), cl, K, true, o.travelWeight, null, 0);
        const cs = scanRes.s;
        const cd = scanRes.dir;
        const fold = scanCost(formFor(op, K, FORM_FOLD), cl, K, true, o.travelWeight, null, 0);
        if (o.foldBias * fold < cut) {
          c = fold;
          pMode[idx] = MODE_FOLD;
        } else {
          c = cut;
          pMode[idx] = MODE_CUT;
          scanRes.s = cs;
          scanRes.dir = cd;
        }
      }
      D[idx] = c;
      pS[idx] = scanRes.s;
      pD[idx] = scanRes.dir;
    }
  }
  const VA = coarseA.map((L) => spread2(L) + o.vanishPenalty);
  const VB = coarseB.map((L) => spread2(L) + o.vanishPenalty);

  // Augmented assignment.
  const N = n + m;
  const cost = new Float64Array(N * N).fill(BIG);
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) cost[i * N + j] = D[i * m + j];
  for (let i = 0; i < n; i++) cost[i * N + (m + i)] = VA[i];
  for (let j = 0; j < m; j++) cost[(n + j) * N + j] = VB[j];
  for (let j = 0; j < m; j++) for (let i = 0; i < n; i++) cost[(n + j) * N + (m + i)] = 0;
  const assign = turnPair ? turnPair : N > 0 ? hungarian(cost, N) : new Int32Array(0);

  const toMatched = new Uint8Array(m);
  const fromMatched = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const c = assign[i];
    if (c < m) {
      fromMatched[i] = c;
      toMatched[c] = 1;
    }
  }
  const pair = (kind, fi, ti) => ({ kind, fi, ti, mode: pMode[fi * m + ti], s: pS[fi * m + ti], dir: pD[fi * m + ti], role: null });

  const raw = [];
  for (let i = 0; i < n; i++) {
    if (fromMatched[i] >= 0) {
      raw.push(pair('match', i, fromMatched[i]));
      continue;
    }
    let kind = 'collapse';
    let bj = -1;
    if (o.extras === 'auto' && m > 0) {
      let bv = Infinity;
      for (let j = 0; j < m; j++) {
        if (D[i * m + j] < bv) {
          bv = D[i * m + j];
          bj = j;
        }
      }
      if (bv <= o.mergeFactor * VA[i]) kind = 'merge';
    }
    if (kind === 'merge') raw.push(pair(kind, i, bj));
    else raw.push({ kind, fi: i, ti: -1, role: null });
  }
  for (let j = 0; j < m; j++) {
    if (toMatched[j]) continue;
    let kind = 'grow';
    let ai = -1;
    if (o.extras === 'auto' && n > 0) {
      let bv = Infinity;
      for (let i = 0; i < n; i++) {
        if (D[i * m + j] < bv) {
          bv = D[i * m + j];
          ai = i;
        }
      }
      if (bv <= o.mergeFactor * VB[j]) kind = 'split';
    }
    if (kind === 'split') raw.push(pair(kind, ai, j));
    else raw.push({ kind, fi: -1, ti: j, role: null });
  }
  return raw;
}

// Sign of the signed area of a loop (its unique points).
function areaSign(L) {
  const U = L.length / 2 - 1;
  let a = 0;
  for (let i = 0; i < U; i++) {
    const j = (i + 1) % U;
    a += L[2 * i] * L[2 * j + 1] - L[2 * j] * L[2 * i + 1];
  }
  return a < 0 ? -1 : 1;
}

// ---------------------------------------------------------------------------
// R5 Rule 5 (shared): windows of the slots
// ---------------------------------------------------------------------------

/**
 * The three staging windows in linear time. With `staging` off all three are [0, 1].
 * `main` starts at stageMain[0] only when there are exits, and ends at stageMain[1] only when there are entries.
 * @param {Partial<typeof DEFAULTS>} opts
 * @param {boolean} hasExits
 * @param {boolean} hasEnters
 * @returns {{out: number[], main: number[], in: number[]}}
 */
function stageWindows(opts, hasExits, hasEnters) {
  const o = { ...DEFAULTS, ...opts };
  if (!o.staging) return { out: [0, 1], main: [0, 1], in: [0, 1] };
  return {
    out: [o.stageOut[0], o.stageOut[1]],
    main: [hasExits ? o.stageMain[0] : 0, hasEnters ? o.stageMain[1] : 1],
    in: [o.stageIn[0], o.stageIn[1]],
  };
}

/**
 * Windows for `count` parts that leave (or arrive) one after the other inside the window W. The part with rank 0
 * starts first. Each part has the length (1 - stagger) of W. `stagger` is `stageStagger`, clamped to [0, 0.9].
 * @param {number} count
 * @param {number[]} W
 * @param {number} [stagger]
 * @returns {number[][]}
 */
function staggerWindows(count, W, stagger = DEFAULTS.stageStagger) {
  const ss = Math.min(0.9, Math.max(0, stagger));
  const len = (1 - ss) * (W[1] - W[0]);
  const out = [];
  for (let k = 0; k < count; k++) {
    const rank = count > 1 ? k / (count - 1) : 0;
    const delay = ss * (W[1] - W[0]) * rank;
    out.push([W[0] + delay, W[0] + delay + len]);
  }
  return out;
}


// R11-4: windows by level. A part that rides on a moving part (its parent is an exit or an enter slot of the same kind) has the
// effective level of its parent plus 1; every other part has level 1. With K levels, the level-k entry has the window
// [a + (k - 1) x L / (K + 1), a + (k + 1) x L / (K + 1)] inside the in window [a, a + L]. Exits mirror it in the out window:
// the deepest parts leave first and level 1 leaves last. The rank stagger (outer parts first for exits, inner parts first for
// entries; parts at the same distance from the core, such as two mirror parts, share one rank) stays inside each window.
// A child never starts before its contact point exists on its parent (an exit never ends after it is gone).
function placeLevels(list, W, side, isExit, cores, o) {
  if (!list.length) return;
  const eff = new Map();
  // R11b-5: the two parts of a mirror pair share one level (the deeper one) and one rank.
  const pairOf = new Map();
  for (const sl of list) {
    if (!sl._pairId) continue;
    const g = pairOf.get(sl._pairId) || [];
    g.push(sl);
    pairOf.set(sl._pairId, g);
  }
  const ownEff = (sl, d = 0) => {
    let v = 1;
    const par = sl._anchorSlot;
    if (sl.attach && sl.attach !== 'free' && par && par.kind === sl.kind && par._lvl !== undefined && d < 16) v = 1 + ownEff(par, d + 1);
    return v;
  };
  const effOf = (sl) => {
    if (eff.has(sl)) return eff.get(sl);
    let v = ownEff(sl);
    const g = sl._pairId ? pairOf.get(sl._pairId) : null;
    // R11c-1: only an attached part takes the level of its group (a free part has no parent slot to take a later level from).
    if (g && g.length >= 2 && sl._anchorSlot && sl.attach && sl.attach !== 'free') for (const m of g) v = Math.max(v, ownEff(m));
    // A part is always deeper than its parent (the pair rule can raise the parent).
    const par = sl._anchorSlot;
    if (sl.attach && sl.attach !== 'free' && par && par.kind === sl.kind && par._lvl !== undefined) v = Math.max(v, 1 + effOf(par));
    eff.set(sl, v);
    return v;
  };
  let K = 1;
  for (const sl of list) K = Math.max(K, effOf(sl));
  let cx = 12;
  let cy = 12;
  if (cores.length) {
    cx = 0;
    cy = 0;
    for (const sl of cores) {
      const c = meanPt(side === 'F' ? sl.F : sl.T, sl.M);
      cx += c[0];
      cy += c[1];
    }
    cx /= cores.length;
    cy /= cores.length;
  }
  const len = W[1] - W[0];
  const easing = planEasingOf(o);
  const tauOf = (c) => {
    // The linear window time at which the eased progress reaches c.
    let lo = 0;
    let hi = 1;
    for (let k = 0; k < 40; k++) {
      const mid = 0.5 * (lo + hi);
      if (easing(mid) < c) lo = mid;
      else hi = mid;
    }
    return 0.5 * (lo + hi);
  };
  for (let k = 1; k <= K; k++) {
    const members = list.filter((sl) => effOf(sl) === k);
    if (!members.length) continue;
    const a = isExit ? W[0] + ((K - k) * len) / (K + 1) : W[0] + ((k - 1) * len) / (K + 1);
    const Wk = [a, a + (2 * len) / (K + 1)];
    const dd = members.map((sl) => {
      const c = meanPt(side === 'F' ? sl.F : sl.T, sl.M);
      return { sl, d: Math.hypot(c[0] - cx, c[1] - cy) };
    });
    // R11b-5: the two parts of a pair take the mean of their two distances, so they share one rank (the distance from the core
    // centroid is not mirror symmetric when the other icon moves the core).
    for (const g of pairOf.values()) {
      const es = g.map((m) => dd.find((e) => e.sl === m)).filter(Boolean);
      if (es.length < 2) continue;
      const mean = es.reduce((a, e) => a + e.d, 0) / es.length;
      for (const e of es) e.d = mean;
    }
    dd.sort((x, y) => (isExit ? y.d - x.d : x.d - y.d));
    const groups = [];
    for (const e of dd) {
      const g = groups[groups.length - 1];
      if (g && Math.abs(g.d - e.d) <= 0.25) g.sls.push(e.sl);
      else groups.push({ d: e.d, sls: [e.sl] });
    }
    const wins = staggerWindows(groups.length, Wk, o.stageStagger);
    groups.forEach((g, gi) => {
      for (const sl of g.sls) sl.window = [wins[gi][0], wins[gi][1]];
    });
    // R11c-4: a two-sided arch rides on two places of its parent. Its ends are on the rest line only while the parent is at its rest
    // shape, so an entry ends no earlier than its parent, and an exit starts no later than its parent (parents are final here).
    for (const sl of members) {
      const par = sl._anchorSlot;
      if (sl.motion !== 'arch2' || !par) continue;
      if (isExit) sl.window = [Math.max(0, Math.min(sl.window[0], par.window[0])), sl.window[1]];
      else sl.window = [sl.window[0], Math.min(1, Math.max(sl.window[1], par.window[1]))];
    }
    // The contact point rule (parents are final: they have a lower level).
    if (k === 1) {
      for (const g of pairOf.values()) {
        const ms = g.filter((m) => members.includes(m) && m.motion === 'arch2');
        if (ms.length < 2) continue;
        const w = isExit ? [Math.min(...ms.map((m) => m.window[0])), ms[0].window[1]] : [ms[0].window[0], Math.max(...ms.map((m) => m.window[1]))];
        for (const m of ms) m.window = [w[0], w[1]];
      }
      continue;
    }
    const harmonize = () => {
      // R11b-5: the parts of a mirror group share one window (the contact rule can move one of them by a hair).
      for (const g of pairOf.values()) {
        const ms = g.filter((m) => members.includes(m));
        if (ms.length < 2) continue;
        const a0 = ms.map((m) => m.window[0]);
        const a1 = ms.map((m) => m.window[1]);
        const w = isExit ? [Math.min(...a0), Math.min(...a1)] : [Math.max(...a0), Math.max(...a1)];
        for (const m of ms) m.window = [w[0], w[1]];
      }
    };
    for (const sl of members) {
      const par = sl._anchorSlot;
      if (!par) continue;
      const w = par.window;
      let tc;
      if (par.motion === 'arch2' && par.cum && par.L > 0) {
        // R11b-4: the parent is drawn from both ends (or erased into both ends): the contact point exists once the nearer front passes it.
        const j = Math.min(sl.anchorIndex, par.M - 2);
        const sC = par.cum[j] + (sl.anchorFrac || 0) * (par.cum[j + 1] - par.cum[j]);
        const fr = (2 * Math.min(sC, par.L - sC)) / par.L;
        tc = w[0] + tauOf(isExit ? Math.max(0.05, 1 - fr) : Math.min(0.95, Math.max(0, fr))) * (w[1] - w[0]);
      } else if ((par.motion === 'draw' || par.motion === 'erase') && par.cum && par.L > 0) {
        const j = Math.min(sl.anchorIndex, par.M - 2);
        const sC = par.cum[j] + (sl.anchorFrac || 0) * (par.cum[j + 1] - par.cum[j]);
        tc = w[0] + tauOf(Math.min(0.95, Math.max(0, sC / par.L))) * (w[1] - w[0]);
      } else tc = w[0] + 0.5 * (w[1] - w[0]);
      if (isExit) {
        const e1 = Math.min(sl.window[1], Math.max(tc, 0.04));
        sl.window = [Math.max(0, Math.min(sl.window[0], e1 - 0.05)), e1];
      } else {
        const s0 = Math.min(Math.max(sl.window[0], tc), 0.95);
        sl.window = [s0, Math.max(sl.window[1], Math.min(1, s0 + 0.05))];
      }
    }
    harmonize();
  }
}

// Fill the window of every slot (R5 Rule 5), the phase windows of multi-stroke objects (R7-A), and the overrides.
// A slot with a `_unit` belongs to a group of slots (the strokes of one exiting or entering object): the group has one window.
function applyWindows(slots, o, rules) {
  const exits = slots.filter((sl) => sl.kind === 'exit' && !sl._split);
  const enters = slots.filter((sl) => sl.kind === 'enter' && !sl._split);
  let m0 = 0;
  let m1 = 1;
  if (rules && o.staging) {
    const sw = stageWindows(o, exits.length > 0, enters.length > 0);
    m0 = sw.main[0];
    m1 = sw.main[1];
    for (const sl of slots) if (sl.kind !== 'exit' && sl.kind !== 'enter') sl.window = [m0, m1];
    const cores = slots.filter((sl) => sl.role === 'core');
    const place = (list, W, side, outerFirst) => {
      if (!list.length) return;
      let cx = 12;
      let cy = 12;
      if (cores.length) {
        cx = 0;
        cy = 0;
        for (const sl of cores) {
          const c = meanPt(side === 'F' ? sl.F : sl.T, sl.M);
          cx += c[0];
          cy += c[1];
        }
        cx /= cores.length;
        cy /= cores.length;
      }
      const units = [];
      const byKey = new Map();
      for (const sl of list) {
        if (sl._unit === undefined) units.push([sl]);
        else {
          let u = byKey.get(sl._unit);
          if (!u) {
            u = [];
            byKey.set(sl._unit, u);
            units.push(u);
          }
          u.push(sl);
        }
      }
      const dd = units.map((sls) => {
        let x = 0;
        let y = 0;
        for (const sl of sls) {
          const c = meanPt(side === 'F' ? sl.F : sl.T, sl.M);
          x += c[0];
          y += c[1];
        }
        return { sls, d: Math.hypot(x / sls.length - cx, y / sls.length - cy) };
      });
      // The part that goes first has rank 0.
      dd.sort((x, y) => (outerFirst ? y.d - x.d : x.d - y.d));
      const wins = staggerWindows(dd.length, W, o.stageStagger);
      dd.forEach((e, k) => {
        for (const sl of e.sls) sl.window = [wins[k][0], wins[k][1]];
      });
    };
    const hasLvl = (sl) => sl._lvl !== undefined;
    place(exits.filter((sl) => !hasLvl(sl)), sw.out, 'F', true);
    place(enters.filter((sl) => !hasLvl(sl)), sw.in, 'T', false);
    placeLevels(exits.filter(hasLvl), sw.out, 'F', true, cores, o);
    placeLevels(enters.filter(hasLvl), sw.in, 'T', false, cores, o);
  }
  // R7-A: gather, morph, detail inside the main window. A slot shows only inside its `show` range.
  const Lm = m1 - m0;
  for (const sl of slots) {
    if (!sl._phase) continue;
    sl.window = [m0 + sl._phase[0] * Lm, m0 + sl._phase[1] * Lm];
    if (sl.phase === 'gather') sl.show = [0, sl.window[1]];
    else if (sl.phase === 'morph') sl.show = [sl.window[0], sl.window[1]];
    else sl.show = [sl.window[0], 1];
  }
  for (const sl of slots) if (sl._win) sl.window = [sl._win[0], sl._win[1]];
  // R12-1 'split': a twin runs in the window of its sibling.
  for (const sl of slots) if (sl._split && sl._twinSlot) sl.window = [sl._twinSlot.window[0], sl._twinSlot.window[1]];
}

// ---------------------------------------------------------------------------
// R7-A: objects. Strokes that touch are one object. Rules 1 to 5 run on objects.
// ---------------------------------------------------------------------------

const TOUCH = 1.2; // two strokes touch when their polylines come within this many units (T-joints included)
const objCache = new WeakMap();

// The stroke as a polyline with a point about every 0.5 units (a closed stroke repeats its first point).
function touchSamples(s) {
  if (s._ts) return s._ts;
  const P = s.pts;
  const n = P.length / 2;
  const out = [P[0], P[1]];
  let ex = P[0];
  let ey = P[1];
  const lim = s.closed ? n + 1 : n;
  for (let i = 1; i < lim; i++) {
    const j = i % n;
    const x = P[2 * j];
    const y = P[2 * j + 1];
    if (dist(x, y, ex, ey) >= 0.5 || i === lim - 1) {
      out.push(x, y);
      ex = x;
      ey = y;
    }
  }
  s._ts = Float64Array.from(out);
  return s._ts;
}

// Is some point of P within sqrt(t2) of the polyline Q?
function nearSegs(P, np, Q, nq, t2) {
  for (let i = 0; i < np; i++) {
    const px = P[2 * i];
    const py = P[2 * i + 1];
    for (let j = 0; j + 1 < nq; j++) {
      const ax = Q[2 * j];
      const ay = Q[2 * j + 1];
      const dx = Q[2 * j + 2] - ax;
      const dy = Q[2 * j + 3] - ay;
      const l2 = dx * dx + dy * dy;
      let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = px - (ax + t * dx);
      const ey = py - (ay + t * dy);
      if (ex * ex + ey * ey <= t2) return true;
    }
  }
  return false;
}

function strokesTouch(a, b) {
  const ia = strokeInfo(a);
  const ib = strokeInfo(b);
  if (ia.x1 + TOUCH < ib.x0 || ib.x1 + TOUCH < ia.x0 || ia.y1 + TOUCH < ib.y0 || ib.y1 + TOUCH < ia.y0) return false;
  const A = touchSamples(a);
  const B = touchSamples(b);
  const t2 = TOUCH * TOUCH;
  return nearSegs(A, A.length / 2, B, B.length / 2, t2) || nearSegs(B, B.length / 2, A, A.length / 2, t2);
}

// Union-find of the strokes that touch. Returns arrays of stroke indices, ordered by their first member. Cached per strokes array.
function groupStrokes(S) {
  let g = objCache.get(S);
  if (g) return g;
  const n = S.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const ri = find(i);
      const rj = find(j);
      if (ri === rj) continue;
      if (strokesTouch(S[i], S[j])) parent[Math.max(ri, rj)] = Math.min(ri, rj);
    }
  }
  const map = new Map();
  g = [];
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!map.has(r)) {
      map.set(r, []);
      g.push(map.get(r));
    }
    map.get(r).push(i);
  }
  objCache.set(S, g);
  return g;
}

function makeObjects(S, groups, side) {
  return groups.map((idx, gi) => {
    const strokes = idx.map((i) => S[i]);
    let weight = 0;
    let length = 0;
    for (const s of strokes) {
      weight += strokeWeight(s);
      length += s.length;
    }
    return { id: side + gi, side, idx, strokes, weight, length, single: idx.length === 1 };
  });
}

// Points of an object, spread over its strokes in proportion to their length (about 96 points).
function objCloud(obj) {
  if (obj._cloud) return obj._cloud;
  const total = Math.max(obj.length, 1e-6);
  const parts = [];
  for (const s of obj.strokes) {
    let m = Math.max(5, Math.round((96 * s.length) / total));
    if (m % 2 === 0) m++;
    const F = formFor(s, m, s.closed ? FORM_LOOP : FORM_PASS);
    const cnt = s.closed ? m - 1 : m;
    for (let i = 0; i < cnt; i++) parts.push(F[2 * i], F[2 * i + 1]);
  }
  obj._cloud = Float64Array.from(parts);
  return obj._cloud;
}

// Area of the convex hull of the points (U[i], V[i]).
function convexHullArea(U, V, n) {
  const idx = Array.from({ length: n }, (_, i) => i).sort((i, j) => U[i] - U[j] || V[i] - V[j]);
  const cross = (o, a, b) => (U[a] - U[o]) * (V[b] - V[o]) - (V[a] - V[o]) * (U[b] - U[o]);
  const lower = [];
  for (const i of idx) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], i) <= 0) lower.pop();
    lower.push(i);
  }
  const upper = [];
  for (let k = idx.length - 1; k >= 0; k--) {
    const i = idx[k];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], i) <= 0) upper.pop();
    upper.push(i);
  }
  lower.pop();
  upper.pop();
  const h = lower.concat(upper);
  let area = 0;
  for (let k = 0; k < h.length; k++) {
    const a = h[k];
    const b = h[(k + 1) % h.length];
    area += U[a] * V[b] - U[b] * V[a];
  }
  return Math.abs(area) / 2;
}

/**
 * The superellipse of R6-1 fitted to a cloud of points: principal axes, extents, and the exponent by the fill ratio of
 * the convex hull of the points (4 when the ratio is at least 0.88, else 2). Returns { cx, cy, a, b, phi, n }.
 * @param {Float64Array|number[]} P  x, y pairs
 */
function fitSuperellipsePoints(P) {
  const n = P.length / 2;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += P[2 * i];
    my += P[2 * i + 1];
  }
  mx /= n;
  my /= n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = P[2 * i] - mx;
    const dy = P[2 * i + 1] - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const phi = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const co = Math.cos(phi);
  const si = Math.sin(phi);
  const U = new Float64Array(n);
  const V = new Float64Array(n);
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const dx = P[2 * i] - mx;
    const dy = P[2 * i + 1] - my;
    const u = co * dx + si * dy;
    const v = -si * dx + co * dy;
    U[i] = u;
    V[i] = v;
    if (u < u0) u0 = u;
    if (u > u1) u1 = u;
    if (v < v0) v0 = v;
    if (v > v1) v1 = v;
  }
  const A = Math.max((u1 - u0) / 2, 0.01);
  const B = Math.max((v1 - v0) / 2, 0.01);
  const cu = (u0 + u1) / 2;
  const cv = (v0 + v1) / 2;
  const fill = convexHullArea(U, V, n) / (4 * A * B);
  return { cx: mx + co * cu - si * cv, cy: my + si * cu + co * cv, a: A, b: B, phi, n: fill >= 0.88 ? 4 : 2 };
}

// The proxy fit of an object: the R6-1 fit of a one-stroke closed object, else the fit of all its points.
function objFit(obj) {
  if (obj._fit) return obj._fit;
  let fit = null;
  if (obj.single && obj.strokes[0].closed) {
    const M = 129;
    fit = fitSuperellipse(formFor(obj.strokes[0], M, FORM_LOOP), M);
  }
  if (!fit) fit = fitSuperellipsePoints(objCloud(obj));
  obj._fit = fit;
  return fit;
}

/**
 * Express the superellipse fb in the frame of fa: the same curve, with the axis angle the short way from fa.phi
 * (the shape is the same under a quarter turn when a and b swap, and under any turn when it is a circle).
 */
function alignSuperellipse(fa, fb) {
  const hi = Math.max(fb.a, fb.b);
  const lo = Math.min(fb.a, fb.b);
  if (fb.n === 2 && lo >= 0.96 * hi) return { ...fb, phi: fa.phi };
  let best = null;
  let bd = Infinity;
  for (let k = 0; k < 4; k++) {
    const dphi = wrapPi(fb.phi + (k * Math.PI) / 2 - fa.phi);
    if (Math.abs(dphi) < bd - 1e-12) {
      bd = Math.abs(dphi);
      best = { k, dphi };
    }
  }
  const swap = best.k % 2 === 1;
  return { cx: fb.cx, cy: fb.cy, a: swap ? fb.b : fb.a, b: swap ? fb.a : fb.b, phi: fa.phi + best.dphi, n: fb.n };
}

/** Interpolate the parameters of two superellipses (center straight, axis angle, a, b, n). u in [0, 1]. */
function lerpSuperellipse(fa, fb, u) {
  const l = (x, y) => x + (y - x) * u;
  return { cx: l(fa.cx, fb.cx), cy: l(fa.cy, fb.cy), a: l(fa.a, fb.a), b: l(fa.b, fb.b), phi: l(fa.phi, fb.phi), n: l(fa.n, fb.n) };
}

// Dense points of the superellipse curve (Nd points by the curve parameter) with the cumulative arc length.
function superDense(f, Nd) {
  const D = new Float64Array(2 * Nd);
  const p = 2 / f.n;
  const co = Math.cos(f.phi);
  const si = Math.sin(f.phi);
  for (let k = 0; k < Nd; k++) {
    const t = (TAU * k) / Nd;
    const x = f.a * sgnPow(Math.cos(t), p);
    const y = f.b * sgnPow(Math.sin(t), p);
    D[2 * k] = f.cx + co * x - si * y;
    D[2 * k + 1] = f.cy + si * x + co * y;
  }
  const cum = new Float64Array(Nd + 1);
  for (let k = 1; k <= Nd; k++) {
    const i = k % Nd;
    cum[k] = cum[k - 1] + dist(D[2 * i], D[2 * i + 1], D[2 * (k - 1)], D[2 * (k - 1) + 1]);
  }
  return { D, cum, Nd, total: cum[Nd] };
}

// The point of the outline at arc position s (wraps around). Writes to out.
function outlineAt(ol, s, out) {
  const { D, cum, Nd, total } = ol;
  s %= total;
  if (s < 0) s += total;
  let lo = 0;
  let hi = Nd - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cum[mid] <= s) lo = mid;
    else hi = mid - 1;
  }
  const seg = cum[lo + 1] - cum[lo];
  const f = seg > 0 ? (s - cum[lo]) / seg : 0;
  const i1 = (lo + 1) % Nd;
  out[0] = D[2 * lo] + (D[2 * i1] - D[2 * lo]) * f;
  out[1] = D[2 * lo + 1] + (D[2 * i1 + 1] - D[2 * lo + 1]) * f;
}

// The arc position of the point of the outline that is nearest to (x, y).
function outlineNearest(ol, x, y) {
  const { D, cum, Nd } = ol;
  let bd = Infinity;
  let bs = 0;
  for (let i = 0; i < Nd; i++) {
    const j = (i + 1) % Nd;
    const ax = D[2 * i];
    const ay = D[2 * i + 1];
    const dx = D[2 * j] - ax;
    const dy = D[2 * j + 1] - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = x - (ax + t * dx);
    const ey = y - (ay + t * dy);
    const d2 = ex * ex + ey * ey;
    if (d2 < bd) {
      bd = d2;
      bs = cum[i] + t * (cum[i + 1] - cum[i]);
    }
  }
  return bs;
}

// K points of the outline at equal arc length (the last repeats the first).
function sampleOutline(ol, K) {
  const out = new Float64Array(2 * K);
  const p = [0, 0];
  for (let i = 0; i < K; i++) {
    outlineAt(ol, (ol.total * i) / (K - 1), p);
    out[2 * i] = p[0];
    out[2 * i + 1] = p[1];
  }
  return out;
}

// Where a stroke projects onto the outline: the circular mean of its arc positions, how much of the outline it covers
// (radians), and the arc position of the point nearest to its centroid.
function projectStroke(s, ol) {
  const m = 33;
  const F = formFor(s, m, s.closed ? FORM_LOOP : FORM_PASS);
  const cnt = s.closed ? m - 1 : m;
  const Lt = ol.total;
  const th = new Float64Array(cnt);
  let sc = 0;
  let ss = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < cnt; i++) {
    const a = (TAU * outlineNearest(ol, F[2 * i], F[2 * i + 1])) / Lt;
    th[i] = a;
    sc += Math.cos(a);
    ss += Math.sin(a);
    cx += F[2 * i];
    cy += F[2 * i + 1];
  }
  cx /= cnt;
  cy /= cnt;
  let mean = Math.hypot(sc, ss) > 1e-6 ? Math.atan2(ss, sc) : th[0];
  if (mean < 0) mean += TAU;
  const sorted = Array.from(th).sort((x, y) => x - y);
  let maxGap = sorted[0] + TAU - sorted[sorted.length - 1];
  for (let i = 1; i < sorted.length; i++) maxGap = Math.max(maxGap, sorted[i] - sorted[i - 1]);
  return { pos: (mean * Lt) / TAU, cover: TAU - maxGap, cpos: outlineNearest(ol, cx, cy) };
}

/**
 * Silhouette tiling (R7-A). Every stroke of the object gets a tile on the outline of the proxy `fit`. Returns
 * { tiles: [{ real, tile, M, closedT }], ol }. `real` is the stroke form (M points) and `tile` its target on the
 * outline (M points), aligned to each other. The tiles cover the whole outline, in the order of the angle of the
 * projections of the strokes, with shares in proportion to the stroke lengths. A closed stroke that covers 300 degrees
 * or more is the spine: it takes the whole outline, and the others go to zero-length shares at their projection
 * points. A one-stroke object takes the whole outline.
 */
function tileObject(obj, fit, o) {
  const ol = superDense(fit, 360);
  const Lt = ol.total;
  const strokes = obj.strokes;
  const ns = strokes.length;
  const tiles = new Array(ns);
  const Ms = new Array(ns);
  const reals = new Array(ns);
  for (let k = 0; k < ns; k++) {
    const s = strokes[k];
    Ms[k] = clampM(need(s, o), o);
    reals[k] = formFor(s, Ms[k], s.closed ? FORM_LOOP : FORM_PASS);
  }
  const p = [0, 0];
  const wholeTile = (k) => {
    const real = reals[k];
    const M = Ms[k];
    const Y = new Float64Array(2 * M);
    for (let i = 0; i < M; i++) {
      outlineAt(ol, (Lt * i) / (M - 1), p);
      Y[2 * i] = p[0];
      Y[2 * i + 1] = p[1];
    }
    scanCost(real, Y, M, true, 1, null, 0);
    const tile = new Float64Array(2 * M);
    buildCand(Y, M, true, scanRes.s, scanRes.dir, tile);
    tiles[k] = { real, tile, M, closedT: true };
  };
  const pointTile = (k, pos) => {
    const M = Ms[k];
    outlineAt(ol, pos, p);
    const tile = new Float64Array(2 * M);
    for (let i = 0; i < M; i++) {
      tile[2 * i] = p[0];
      tile[2 * i + 1] = p[1];
    }
    tiles[k] = { real: reals[k], tile, M, closedT: false };
  };
  const arcTile = (k, a, w) => {
    const real = reals[k];
    const M = Ms[k];
    let T = new Float64Array(2 * M);
    for (let i = 0; i < M; i++) {
      outlineAt(ol, a + (w * i) / (M - 1), p);
      T[2 * i] = p[0];
      T[2 * i + 1] = p[1];
    }
    if (!strokes[k].closed) {
      let cf = 0;
      let cr = 0;
      for (let i = 0; i < M; i++) {
        const fx = real[2 * i] - T[2 * i];
        const fy = real[2 * i + 1] - T[2 * i + 1];
        const rx = real[2 * i] - T[2 * (M - 1 - i)];
        const ry = real[2 * i + 1] - T[2 * (M - 1 - i) + 1];
        cf += fx * fx + fy * fy;
        cr += rx * rx + ry * ry;
      }
      if (cr < cf) T = reversePoly(T, M);
      tiles[k] = { real, tile: T, M, closedT: false };
    } else {
      scanCost(T, real, M, true, 1, null, 0);
      const sS = scanRes.s;
      const dD = scanRes.dir;
      const R = new Float64Array(2 * M);
      buildCand(real, M, true, sS, dD, R);
      if (real.vis) R.vis = buildCandVis(real.vis, M, true, sS, dD);
      tiles[k] = { real: R, tile: T, M, closedT: false };
    }
  };

  if (ns === 1) {
    wholeTile(0);
    return { tiles, ol };
  }
  const info = strokes.map((s) => projectStroke(s, ol));
  let spine = -1;
  for (let k = 0; k < ns; k++) {
    if (strokes[k].closed && info[k].cover >= 300 * DEG && (spine < 0 || strokes[k].length > strokes[spine].length)) spine = k;
  }
  if (spine >= 0) {
    wholeTile(spine);
    for (let k = 0; k < ns; k++) if (k !== spine) pointTile(k, info[k].cpos);
    return { tiles, ol };
  }
  const order = Array.from({ length: ns }, (_, k) => k).sort((x, y) => info[x].pos - info[y].pos || x - y);
  const lens = order.map((k) => Math.max(strokes[k].length, 1e-3));
  const sum = lens.reduce((x, y) => x + y, 0);
  const W = lens.map((l) => (Lt * l) / sum);
  const c = new Float64Array(ns + 1);
  for (let q = 0; q < ns; q++) c[q + 1] = c[q] + W[q];
  // The start of the tiling: the best of the starts that put one share at the angle of its stroke.
  let bestStart = 0;
  let bestCost = Infinity;
  for (let j = 0; j < ns; j++) {
    const start = info[order[j]].pos - (c[j] + W[j] / 2);
    let cost = 0;
    for (let q = 0; q < ns; q++) {
      let d = (start + c[q] + W[q] / 2 - info[order[q]].pos) % Lt;
      if (d > Lt / 2) d -= Lt;
      else if (d < -Lt / 2) d += Lt;
      cost += lens[q] * d * d;
    }
    if (cost < bestCost) {
      bestCost = cost;
      bestStart = start;
    }
  }
  for (let q = 0; q < ns; q++) arcTile(order[q], bestStart + c[q], W[q]);
  return { tiles, ol };
}

// Fields shared by all slots of the object planner.
function objSlot(p) {
  const M = p.M;
  const ones = () => onesMask(M - 1);
  const slot = {
    kind: 'match',
    role: p.role,
    mode: p.mode || 'tile',
    fromIndex: p.fromIndex === undefined ? -1 : p.fromIndex,
    toIndex: p.toIndex === undefined ? -1 : p.toIndex,
    M,
    F: p.F,
    T: p.T,
    visF: p.visF || ones(),
    visT: p.visT || ones(),
    weight: p.weight,
    fromOp: p.fromOp === undefined ? 1 : p.fromOp,
    toOp: p.toOp === undefined ? 1 : p.toOp,
    fill: !!p.fill,
    sw0: p.sw0 === undefined ? null : p.sw0,
    sw1: p.sw1 === undefined ? null : p.sw1,
    ws0: p.ws0 === undefined ? 1 : p.ws0,
    buf: new Float64Array(2 * M),
    static: false,
    bigTurn: false,
    chain: p.chain || { from: 0, to: 0 },
    anchor: -1,
    anchorIndex: -1,
    window: [0, 1],
    _anchorSlot: null,
    closedF: !!p.closedF,
    closedT: !!p.closedT,
    lod: false,
    depth: 0.5,
    motion: p.motion || 'linear',
    theta: 0,
    scale: 1,
    flip: false,
    phase: p.phase,
    _phase: p.split,
    _noAnchor: true,
  };
  if (p.fromIdxs) slot.fromIdxs = p.fromIdxs;
  if (p.toIdxs) slot.toIdxs = p.toIdxs;
  if (p.se) slot._se = p.se;
  buildClasses(slot);
  return slot;
}

function meanOf(strokes, key) {
  let w = 0;
  let v = 0;
  for (const s of strokes) {
    const l = Math.max(s.length, 1e-3);
    w += l;
    v += l * (s[key] === undefined ? 1 : s[key]);
  }
  return w > 0 ? v / w : 1;
}

// The three steps of a tied pair where at least one object has several strokes (silhouette tiling).
// Returns the slots. Pushes the outlines of a core object to `outlines` (anchors of exits and entries).
function tripleSlots(oa, ob, role, o, K, outlines) {
  const fa = objFit(oa);
  const fb = alignSuperellipse(fa, objFit(ob));
  const ta = tileObject(oa, fa, o);
  const tb = tileObject(ob, fb, o);
  const sp0 = Math.min(0.9, Math.max(0.05, o.objectSplit[0]));
  const sp1 = Math.min(0.95, Math.max(sp0 + 0.05, o.objectSplit[1]));
  const slots = [];
  oa.strokes.forEach((s, k) => {
    const t = ta.tiles[k];
    slots.push(
      objSlot({
        role, phase: 'gather', split: [0, sp0], M: t.M, F: t.real, T: t.tile, visF: t.real.vis || null, visT: null,
        weight: s.length, fromOp: s.opacity, toOp: s.opacity, fill: s.fill, sw0: s.sw, sw1: s.sw, ws0: s.ws0, chain: { from: s.bridges, to: 0 },
        closedF: s.closed, closedT: t.closedT, fromIndex: oa.idx[k], toIndex: -1,
      }),
    );
  });
  const Lt = Math.max(ta.ol.total, tb.ol.total);
  const M = clampM(Math.ceil(Lt / o.sampleSpacing), o);
  const U = M - 1;
  const mk = (f) => {
    const L = superellipseLoop(f.cx, f.cy, f.a, f.b, f.phi, f.n, U);
    const out = new Float64Array(2 * M);
    out.set(L);
    out[2 * U] = L[0];
    out[2 * U + 1] = L[1];
    return out;
  };
  slots.push(
    objSlot({
      role, phase: 'morph', split: [sp0, sp1], M, F: mk(fa), T: mk(fb), weight: Math.max(oa.length, ob.length),
      fromOp: meanOf(oa.strokes, 'opacity'), toOp: meanOf(ob.strokes, 'opacity'), fill: oa.strokes.some((x) => x.fill), sw0: oa.strokes[0].sw, sw1: ob.strokes[0].sw, ws0: meanOf(oa.strokes, 'ws0'),
      closedF: true, closedT: true, motion: 'superellipse', se: { fa, fb, U }, fromIdxs: oa.idx, toIdxs: ob.idx,
    }),
  );
  ob.strokes.forEach((s, k) => {
    const t = tb.tiles[k];
    slots.push(
      objSlot({
        role, phase: 'detail', split: [sp1, 1], M: t.M, F: t.tile, T: t.real, visF: null, visT: t.real.vis || null,
        weight: s.length, fromOp: s.opacity, toOp: s.opacity, fill: s.fill, sw0: s.sw, sw1: s.sw, ws0: 1, chain: { from: 0, to: s.bridges },
        closedF: t.closedT, closedT: s.closed, fromIndex: -1, toIndex: ob.idx[k],
      }),
    );
  });
  if (role === 'core') outlines.push({ A: sampleOutline(ta.ol, K), B: sampleOutline(tb.ol, K) });
  return slots;
}

// A superellipse loop at progress u (the slot of the middle step). Writes into slot.buf.
function evalSuper(slot, u) {
  const { fa, fb, U } = slot._se;
  const f = lerpSuperellipse(fa, fb, u);
  const L = superellipseLoop(f.cx, f.cy, f.a, f.b, f.phi, f.n, U);
  const out = slot.buf;
  out.set(L);
  out[2 * U] = L[0];
  out[2 * U + 1] = L[1];
}

// ---------------------------------------------------------------------------
// R7-A: matching of objects (Rules 1 to 3 on objects)
// ---------------------------------------------------------------------------

// The form of an object for the pair cost D: its coarse stroke form (one stroke), or its proxy loop at K points.
function prepD(ob, coarse, K) {
  if (ob.single) {
    ob.ps = ob.strokes[0];
    ob.cf = coarse[ob.idx[0]];
    return;
  }
  const f = objFit(ob);
  const L = superellipseLoop(f.cx, f.cy, f.a, f.b, f.phi, f.n, K - 1);
  const cf = new Float64Array(2 * K);
  cf.set(L);
  cf[2 * (K - 1)] = L[0];
  cf[2 * (K - 1) + 1] = L[1];
  ob.cf = cf;
  ob.ps = { closed: true, length: ob.length };
}

// Rule 3 gate on objects: both closed or both open, similar ink length, similar shape (proxy loops for several strokes).
function gateForm(ob) {
  if (ob._gf) return ob._gf;
  if (ob.single) ob._gf = formFor(ob.strokes[0], GATE_N, ob.strokes[0].closed ? FORM_LOOP : FORM_PASS);
  else {
    const f = objFit(ob);
    const L = superellipseLoop(f.cx, f.cy, f.a, f.b, f.phi, f.n, GATE_N - 1);
    const g = new Float64Array(2 * GATE_N);
    g.set(L);
    g[2 * (GATE_N - 1)] = L[0];
    g[2 * (GATE_N - 1) + 1] = L[1];
    ob._gf = g;
  }
  return ob._gf;
}

function objectsAlike(a, b, o) {
  if (a.ps.closed !== b.ps.closed) return false;
  const lo = Math.max(Math.min(a.length, b.length), 1e-3);
  const hi = Math.max(a.length, b.length, 1e-3);
  if (hi / lo > o.partSizeRatio) return false;
  const la = gateForm(a);
  const lb = gateForm(b);
  const sa = spread2(la);
  const sb = spread2(lb);
  if (sa < 1e-9 && sb < 1e-9) return true;
  if (sa < 1e-9 || sb < 1e-9) return false;
  flipScan(la, lb, GATE_N, a.ps.closed, false, null, 0);
  return flipRes.rRot <= o.partShapeMax;
}

/**
 * Rules 1 to 3 on objects. The weight of an object is the sum of the weights of its strokes. D uses the coarse stroke
 * form for a one-stroke object and the proxy loop (at the coarse M) for an object of several strokes.
 * Returns raw slot descriptions: { kind: 'static' | 'match', fi, ti, mode, s, dir, role }, { kind: 'exit', fi }, { kind: 'enter', ti }.
 */
function objectMatching(OA, OB, K, o, staticPairs) {
  const n = OA.length;
  const m = OB.length;
  const mxA = OA.reduce((x, ob) => Math.max(x, ob.weight), 0);
  const mxB = OB.reduce((x, ob) => Math.max(x, ob.weight), 0);
  const coreA = OA.map((ob) => ob.weight >= 0.5 * mxA);
  const coreB = OB.map((ob) => ob.weight >= 0.5 * mxB);
  const raw = [];
  const usedA = new Uint8Array(n);
  const usedB = new Uint8Array(m);
  const pairObj = (a, b) => pairInfo(a.ps, a.cf, b.ps, b.cf, K, o);
  const tie = (i, j, role) => {
    const r = pairObj(OA[i], OB[j]);
    raw.push({ kind: 'match', fi: i, ti: j, mode: r.mode, s: r.s, dir: r.dir, role });
  };
  for (const sp of staticPairs) {
    usedA[sp.fi] = 1;
    usedB[sp.ti] = 1;
    raw.push({ kind: 'static', fi: sp.fi, ti: sp.ti, role: coreA[sp.fi] ? 'core' : 'part' });
  }
  // Rule 2: core to core.
  const cA = [];
  const cB = [];
  for (let i = 0; i < n; i++) if (!usedA[i] && coreA[i]) cA.push(i);
  for (let j = 0; j < m; j++) if (!usedB[j] && coreB[j]) cB.push(j);
  if (cA.length && cB.length) {
    const N = Math.max(cA.length, cB.length);
    const cost = new Float64Array(N * N);
    for (let x = 0; x < cA.length; x++) for (let y = 0; y < cB.length; y++) cost[x * N + y] = pairObj(OA[cA[x]], OB[cB[y]]).c;
    const asg = hungarian(cost, N);
    for (let x = 0; x < cA.length; x++) {
      const y = asg[x];
      if (y >= cB.length) continue;
      usedA[cA[x]] = 1;
      usedB[cB[y]] = 1;
      tie(cA[x], cB[y], 'core');
    }
  }
  // Rule 3: a part ties to a part only when they are alike.
  const pA = [];
  const pB = [];
  for (let i = 0; i < n; i++) if (!usedA[i]) pA.push(i);
  for (let j = 0; j < m; j++) if (!usedB[j]) pB.push(j);
  if (pA.length && pB.length) {
    const N = Math.max(pA.length, pB.length);
    const cost = new Float64Array(N * N);
    let any = false;
    for (let x = 0; x < pA.length; x++) {
      for (let y = 0; y < pB.length; y++) {
        let c = BIG;
        if (!o.partGate || objectsAlike(OA[pA[x]], OB[pB[y]], o)) {
          c = pairObj(OA[pA[x]], OB[pB[y]]).c;
          any = true;
        }
        cost[x * N + y] = c;
      }
    }
    if (any) {
      const asg = hungarian(cost, N);
      for (let x = 0; x < pA.length; x++) {
        const y = asg[x];
        if (y >= pB.length || cost[x * N + y] >= BIG / 2) continue;
        usedA[pA[x]] = 1;
        usedB[pB[y]] = 1;
        tie(pA[x], pB[y], 'part');
      }
    }
  }
  for (let i = 0; i < n; i++) if (!usedA[i]) raw.push({ kind: 'exit', fi: i });
  for (let j = 0; j < m; j++) if (!usedB[j]) raw.push({ kind: 'enter', ti: j });
  return raw;
}

// Strokes of A and B that are the same shape at the same place (Rule 1). Returns row -> column (or -1), greedy by cost.
function staticStrokePairs(A, B, coarseA, coarseB, K) {
  const n = A.length;
  const m = B.length;
  const out = new Int32Array(n).fill(-1);
  const usedB = new Uint8Array(m);
  const cenA = coarseA.map((L, i) => centroidOf(L, A[i].closed));
  const cenB = coarseB.map((L, j) => centroidOf(L, B[j].closed));
  const cands = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      if (A[i].closed !== B[j].closed) continue;
      if (!sameStyle(A[i], B[j])) continue;
      if (Math.abs(A[i].length - B[j].length) > 0.02 * Math.max(A[i].length, B[j].length) + 0.05) continue;
      if (Math.abs(cenA[i][0] - cenB[j][0]) > 0.2 || Math.abs(cenA[i][1] - cenB[j][1]) > 0.2) continue;
      const c = scanCost(coarseA[i], coarseB[j], K, A[i].closed, 1, null, 0);
      if (c < 1e-6 || c < 1e-4 * spread2(coarseB[j])) cands.push({ i, j, c });
    }
  }
  cands.sort((x, y) => x.c - y.c || x.i - y.i || x.j - y.j);
  for (const c of cands) {
    if (out[c.i] >= 0 || usedB[c.j]) continue;
    out[c.i] = c.j;
    usedB[c.j] = 1;
  }
  return out;
}

// The anchor of an untied part object: the nearest point on a core slot (as in Rule 4), or on the outline of a tied
// core object of several strokes (P_A for an exit, P_B for an entry). Returns { anc } or { fixed: [x, y] } or null.
function pickObjAnchor(samples, side, cores, outlines) {
  const ns = samples.length / 2;
  let best = null;
  let bd = Infinity;
  const anc = cores.length ? pickAnchor(samples, cores, side) : null;
  if (anc) {
    const P = side === 'F' ? anc.slot.F : anc.slot.T;
    bd = nearestSample(P, anc.index, samples, ns);
    best = { anc };
  }
  for (const ol of outlines) {
    const P = side === 'F' ? ol.A : ol.B;
    const mm = P.length / 2;
    for (let i = 0; i < mm; i++) {
      const d = nearestSample(P, i, samples, ns);
      if (d < bd) {
        bd = d;
        best = { fixed: [P[2 * i], P[2 * i + 1]] };
      }
    }
  }
  return best;
}

/**
 * The plan of two icons by objects (R7-A). Returns null when the round 6b stroke plan applies: no object has several
 * strokes, a whole-icon turn fits, or every stroke is static.
 */
function tryObjectPlan(A, B, o) {
  const gA = groupStrokes(A);
  const gB = groupStrokes(B);
  if (gA.every((g) => g.length === 1) && gB.every((g) => g.length === 1)) return null;
  const K = oddUp(o.coarsePoints);
  const easing = resolveEasing(o.easing);
  const coarseA = A.map((s) => formFor(s, K, s.closed ? FORM_LOOP : FORM_PASS));
  const coarseB = B.map((s) => formFor(s, K, s.closed ? FORM_LOOP : FORM_PASS));
  if (o.wholeTurn && o.rigid && detectWholeTurn(A, B, coarseA, coarseB, K)) return null;
  const sp = staticStrokePairs(A, B, coarseA, coarseB, K);
  if (A.length === B.length && A.length > 0 && sp.every((v) => v >= 0)) return null;

  const OA = makeObjects(A, gA, 'A');
  const OB = makeObjects(B, gB, 'B');
  const objOfB = new Int32Array(B.length);
  OB.forEach((ob, j) => ob.idx.forEach((i) => (objOfB[i] = j)));
  const staticPairs = [];
  OA.forEach((oa, i) => {
    let j = -2;
    let ok = true;
    for (const si of oa.idx) {
      const sj = sp[si];
      if (sj < 0) {
        ok = false;
        break;
      }
      if (j === -2) j = objOfB[sj];
      else if (j !== objOfB[sj]) {
        ok = false;
        break;
      }
    }
    if (ok && j >= 0 && OB[j].idx.length === oa.idx.length) staticPairs.push({ fi: i, ti: j });
  });
  for (const ob of OA) prepD(ob, coarseA, K);
  for (const ob of OB) prepD(ob, coarseB, K);
  const raw = objectMatching(OA, OB, K, o, staticPairs);

  const slots = [];
  const pending = [];
  const outlines = [];
  const objInfo = [];
  for (const r of raw) {
    if (r.kind === 'exit' || r.kind === 'enter') {
      pending.push(r);
      continue;
    }
    const oa = OA[r.fi];
    const ob = OB[r.ti];
    const oid = oa.id + '>' + ob.id;
    objInfo.push({ id: oid, kind: r.kind === 'static' ? 'static' : oa.single && ob.single ? 'match' : 'tiled', role: r.role, from: oa.idx.slice(), to: ob.idx.slice() });
    if (r.kind === 'static') {
      for (const si of oa.idx) {
        const sj = sp[si];
        const pr = pairInfo(A[si], coarseA[si], B[sj], coarseB[sj], K, o);
        const sl = makeTiedSlot({ kind: 'match', fi: si, ti: sj, mode: pr.mode, s: pr.s, dir: pr.dir, role: r.role }, A, B, o, K, true, false, 0, 0, easing);
        sl.object = oid;
        sl.phase = 'match';
        slots.push(sl);
      }
    } else if (oa.single && ob.single) {
      const sl = makeTiedSlot({ kind: 'match', fi: oa.idx[0], ti: ob.idx[0], mode: r.mode, s: r.s, dir: r.dir, role: r.role }, A, B, o, K, true, false, 0, 0, easing);
      sl.object = oid;
      sl.phase = 'match';
      slots.push(sl);
    } else {
      for (const sl of tripleSlots(oa, ob, r.role, o, K, outlines)) {
        sl.object = oid;
        slots.push(sl);
      }
    }
  }

  // Rule 4 on objects: all strokes of an untied object share one anchor and move as one group.
  const cores = slots.filter((sl) => sl.role === 'core' && !sl._noAnchor);
  for (const r of pending) {
    const exit = r.kind === 'exit';
    const ob = exit ? OA[r.fi] : OB[r.ti];
    objInfo.push({ id: ob.id, kind: r.kind, role: 'part', from: exit ? ob.idx.slice() : [], to: exit ? [] : ob.idx.slice() });
    const group = !ob.single;
    const side = exit ? 'F' : 'T';
    const st0 = ob.strokes[0];
    const samples = ob.single ? formFor(st0, K, st0.closed ? FORM_LOOP : FORM_PASS) : objCloud(ob);
    let pre = pickObjAnchor(samples, side, cores, outlines);
    if (group && !pre) {
      const cl = objCloud(ob);
      let cx = 0;
      let cy = 0;
      for (let i = 0; i < cl.length / 2; i++) {
        cx += cl[2 * i];
        cy += cl[2 * i + 1];
      }
      pre = { fixed: [cx / (cl.length / 2), cy / (cl.length / 2)] };
    }
    ob.strokes.forEach((st, k) => {
      const ps = buildPartSlot(r.kind, st, ob.idx[k], o, K, cores, pre ? { anc: pre.anc || null, fixed: pre.fixed || null, group } : null);
      ps.closedF = false;
      ps.closedT = false;
      ps.lod = false;
      ps.depth = 0.5;
      ps.object = ob.id;
      ps.phase = r.kind;
      ps._noAnchor = true;
      if (group) ps._unit = ob.id;
      slots.push(ps);
    });
  }

  applyWindows(slots, o, true);
  return finishPlan(slots, A, B, coarseA, coarseB, o, true, 0, null, null, { objects: objInfo });
}

// ---------------------------------------------------------------------------
// R8-1: containers, details, and free strokes. Gather, shapes change, details.
// ---------------------------------------------------------------------------

const R8_HULL_AREA = 20; // an open touch group is a container when the hull of its points has at least this area
const R8_HULL_LEN = 0.6; // and its total stroke length is at least this times the hull perimeter
const R8_SMALL_AREA = 3; // a closed stroke below this area that touches a container is a detail of it
const R8_NEAR = 4; // a stroke within this distance of a container (and not touching) is its detail

// Smallest squared distance from the points of P (np points) to the polyline Q (nq points).
function ptsPolyDist2(P, np, Q, nq) {
  let best = Infinity;
  for (let i = 0; i < np; i++) {
    const px = P[2 * i];
    const py = P[2 * i + 1];
    for (let j = 0; j + 1 < nq; j++) {
      const ax = Q[2 * j];
      const ay = Q[2 * j + 1];
      const dx = Q[2 * j + 2] - ax;
      const dy = Q[2 * j + 3] - ay;
      const l2 = dx * dx + dy * dy;
      let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = px - (ax + t * dx);
      const ey = py - (ay + t * dy);
      const d2 = ex * ex + ey * ey;
      if (d2 < best) best = d2;
    }
  }
  return best;
}

// Distance between two strokes (polylines).
function strokeGap(a, b) {
  const A = touchSamples(a);
  const B = touchSamples(b);
  return Math.sqrt(Math.min(ptsPolyDist2(A, A.length / 2, B, B.length / 2), ptsPolyDist2(B, B.length / 2, A, A.length / 2)));
}

function unitGap(s, u) {
  let d = Infinity;
  for (const t of u.strokes) d = Math.min(d, strokeGap(s, t));
  return d;
}

// Area and perimeter of the convex hull of the points P (x, y pairs).
function hullStats(P) {
  const n = P.length / 2;
  const idx = Array.from({ length: n }, (_, i) => i).sort((i, j) => P[2 * i] - P[2 * j] || P[2 * i + 1] - P[2 * j + 1]);
  const cross = (o, a, b) => (P[2 * a] - P[2 * o]) * (P[2 * b + 1] - P[2 * o + 1]) - (P[2 * a + 1] - P[2 * o + 1]) * (P[2 * b] - P[2 * o]);
  const lower = [];
  for (const i of idx) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], i) <= 0) lower.pop();
    lower.push(i);
  }
  const upper = [];
  for (let k = idx.length - 1; k >= 0; k--) {
    const i = idx[k];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], i) <= 0) upper.pop();
    upper.push(i);
  }
  lower.pop();
  upper.pop();
  const h = lower.concat(upper);
  let area = 0;
  let perim = 0;
  for (let k = 0; k < h.length; k++) {
    const a = h[k];
    const b = h[(k + 1) % h.length];
    area += P[2 * a] * P[2 * b + 1] - P[2 * b] * P[2 * a + 1];
    perim += dist(P[2 * a], P[2 * a + 1], P[2 * b], P[2 * b + 1]);
  }
  return { area: Math.abs(area) / 2, perim };
}

// Is (x, y) inside the superellipse f?
function inSuper(f, x, y) {
  const dx = x - f.cx;
  const dy = y - f.cy;
  const co = Math.cos(f.phi);
  const si = Math.sin(f.phi);
  const u = Math.abs(co * dx + si * dy) / f.a;
  const v = Math.abs(-si * dx + co * dy) / f.b;
  return Math.pow(u, f.n) + Math.pow(v, f.n) <= 1;
}

/**
 * R8-1: sort the strokes of one icon into units. A unit is a container (a closed stroke, or an open touch group that
 * encloses a shape; `idx` holds its own strokes and `details` the strokes that belong to it) or a free stroke (an
 * open stroke that belongs to no container). Returns { units, role, owner }: per stroke its role
 * ('container' | 'detail' | 'free') and its unit.
 */
function r8Units(S) {
  const n = S.length;
  const units = [];
  const role = new Array(n).fill(null);
  const owner = new Array(n).fill(null);
  const mk = (idx, kind) => {
    const strokes = idx.map((i) => S[i]);
    let weight = 0;
    let length = 0;
    for (const s of strokes) {
      weight += strokeWeight(s);
      length += s.length;
    }
    const u = { id: -1, role: kind, idx, strokes, weight, length, single: idx.length === 1, details: [], side: '' };
    units.push(u);
    for (const i of idx) {
      role[i] = kind;
      owner[i] = u;
    }
    return u;
  };
  const closedBig = [];
  const closedSmall = [];
  const opens = [];
  for (let i = 0; i < n; i++) {
    if (S[i].closed) (strokeInfo(S[i]).area >= R8_SMALL_AREA ? closedBig : closedSmall).push(i);
    else opens.push(i);
  }
  for (const i of closedBig) mk([i], 'container');
  // Open touch groups that enclose a shape are containers (the brain outline: six open lobes).
  const par = new Map(opens.map((i) => [i, i]));
  const find = (i) => {
    while (par.get(i) !== i) {
      par.set(i, par.get(par.get(i)));
      i = par.get(i);
    }
    return i;
  };
  for (let x = 0; x < opens.length; x++) {
    for (let y = x + 1; y < opens.length; y++) {
      const rx = find(opens[x]);
      const ry = find(opens[y]);
      if (rx !== ry && strokesTouch(S[opens[x]], S[opens[y]])) par.set(Math.max(rx, ry), Math.min(rx, ry));
    }
  }
  const groups = new Map();
  for (const i of opens) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }
  for (const g of groups.values()) {
    const strokes = g.map((i) => S[i]);
    let length = 0;
    for (const s of strokes) length += s.length;
    const cloud = objCloud({ strokes, length });
    if (cloud.length < 6) continue;
    const h = hullStats(cloud);
    if (h.area >= R8_HULL_AREA && length >= R8_HULL_LEN * h.perim) mk(g, 'container');
  }
  const conts = units.filter((u) => u.role === 'container');
  // A small closed stroke that touches a container is its detail. Else it is a container of its own.
  for (const i of closedSmall) {
    let best = null;
    let bd = Infinity;
    for (const u of conts) {
      const d = unitGap(S[i], u);
      if (d <= TOUCH && d < bd) {
        bd = d;
        best = u;
      }
    }
    if (best) {
      best.details.push(i);
      role[i] = 'detail';
      owner[i] = best;
    } else conts.push(mk([i], 'container'));
  }
  // Other open strokes: the container they touch, else the container whose proxy contains their centroid, else the
  // nearest container within R8_NEAR, else a free stroke.
  for (const i of opens) {
    if (role[i]) continue;
    const s = S[i];
    let best = null;
    let bd = Infinity;
    for (const u of conts) {
      const d = unitGap(s, u);
      if (d <= TOUCH && d < bd) {
        bd = d;
        best = u;
      }
    }
    if (!best) {
      const info = strokeInfo(s);
      let ba = Infinity;
      for (const u of conts) {
        const f = objFit(u);
        if (inSuper(f, info.cx, info.cy) && f.a * f.b < ba) {
          ba = f.a * f.b;
          best = u;
        }
      }
    }
    if (!best) {
      bd = Infinity;
      for (const u of conts) {
        const d = unitGap(s, u);
        if (d <= R8_NEAR + 0.05 && d < bd) {
          bd = d;
          best = u;
        }
      }
    }
    if (best) {
      best.details.push(i);
      role[i] = 'detail';
      owner[i] = best;
    } else mk([i], 'free');
  }
  units.sort((x, y) => Math.min(...x.idx) - Math.min(...y.idx));
  units.forEach((u, k) => {
    u.id = k;
    u.details.sort((x, y) => x - y);
  });
  return { units, role, owner };
}

// Cost of tying two units: the proxy parameters (center distance squared, plus half the squared difference of a and of b).
function r8Cost(ua, ub) {
  const fa = objFit(ua);
  const fb = alignSuperellipse(fa, objFit(ub));
  const dx = fa.cx - fb.cx;
  const dy = fa.cy - fb.cy;
  return dx * dx + dy * dy + 0.5 * (fa.a - fb.a) * (fa.a - fb.a) + 0.5 * (fa.b - fb.b) * (fa.b - fb.b);
}

// The gather step of a unit: its strokes move onto its proxy outline (tiles).
function r8Gather(oa, ta, c0) {
  return oa.strokes.map((s, k) => {
    const t = ta.tiles[k];
    return objSlot({
      role: 'core', phase: 'gather', split: [0, c0], M: t.M, F: t.real, T: t.tile, visF: t.real.vis || null, visT: null,
      weight: s.length, fromOp: s.opacity, toOp: s.opacity, fill: s.fill, sw0: s.sw, sw1: s.sw, ws0: s.ws0, chain: { from: s.bridges, to: 0 },
      closedF: s.closed, closedT: t.closedT, fromIndex: oa.idx[k], toIndex: -1,
    });
  });
}

// The shapes step: one closed loop (the proxy) from the parameters fa to the parameters fb.
function r8Morph(oa, ob, fa, fb, c0, c1, o) {
  const Lt = Math.max(superDense(fa, 360).total, superDense(fb, 360).total);
  const M = clampM(Math.ceil(Lt / o.sampleSpacing), o);
  const U = M - 1;
  const mk = (f) => {
    const L = superellipseLoop(f.cx, f.cy, f.a, f.b, f.phi, f.n, U);
    const out = new Float64Array(2 * M);
    out.set(L);
    out[2 * U] = L[0];
    out[2 * U + 1] = L[1];
    return out;
  };
  const ref = oa || ob;
  const other = ob || oa;
  return objSlot({
    role: 'core', phase: 'morph', split: [c0, c1], M, F: mk(fa), T: mk(fb), weight: Math.max(oa ? oa.length : 0, ob ? ob.length : 0),
    fromOp: meanOf(ref.strokes, 'opacity'), toOp: meanOf(other.strokes, 'opacity'), fill: ref.strokes.some((x) => x.fill), sw0: ref.strokes[0].sw, sw1: other.strokes[0].sw,
    ws0: oa ? meanOf(oa.strokes, 'ws0') : 1, closedF: true, closedT: true, motion: 'superellipse', se: { fa, fb, U }, fromIdxs: oa ? oa.idx : [], toIdxs: ob ? ob.idx : [],
  });
}

// The details step: the proxy outline becomes the strokes of the unit.
function r8Detail(ob, tb, c1) {
  return ob.strokes.map((s, k) => {
    const t = tb.tiles[k];
    return objSlot({
      role: 'core', phase: 'detail', split: [c1, 1], M: t.M, F: t.tile, T: t.real, visF: null, visT: t.real.vis || null,
      weight: s.length, fromOp: s.opacity, toOp: s.opacity, fill: s.fill, sw0: s.sw, sw1: s.sw, ws0: 1, chain: { from: 0, to: s.bridges },
      closedF: t.closedT, closedT: s.closed, fromIndex: -1, toIndex: ob.idx[k],
    });
  });
}

// A detail that leaves into (exit) or grows out of (enter) its container, from the edge it connects to.
// `cands` are the slots of the container (old side for an exit, new side for an enter). The connection point is the
// point of the container nearest to the detail. It rides on the container as the container changes. The detail never
// slides: an open detail with an end near the connection point (retractReach) retracts into or draws out from that
// end, another open detail grows out of its own point nearest to the container along its length in both directions
// (`bloom`), and a closed detail scales about its own point nearest to the container (`scaleq`).
function buildDetailSlot(kind, st, idx, o, K, cands) {
  const exit = kind === 'exit';
  const M = clampM(need(st, o), o);
  const form = st.closed ? FORM_LOOP : FORM_PASS;
  let P = formFor(st, M, form);
  const samples = formFor(st, K, form);
  const anc = cands.length ? pickAnchor(samples, cands, exit ? 'F' : 'T') : null;
  let a0;
  let a1;
  if (anc) {
    a0 = [anc.slot.F[2 * anc.index], anc.slot.F[2 * anc.index + 1]];
    a1 = [anc.slot.T[2 * anc.index], anc.slot.T[2 * anc.index + 1]];
  } else a0 = a1 = centroidOf(samples, st.closed);
  const ref = exit ? a0 : a1;
  let motion = 'scaleq';
  if (!st.closed && st.length > 1e-3) {
    const d0 = dist(P[0], P[1], ref[0], ref[1]);
    const d1 = dist(P[2 * M - 2], P[2 * M - 1], ref[0], ref[1]);
    if (Math.min(d0, d1) <= o.retractReach) {
      // An exit retracts toward its last point. An enter draws out of its first point.
      if (exit ? d0 < d1 : d1 < d0) P = reversePoly(P, M);
      motion = exit ? 'erase' : 'draw';
    } else motion = 'bloom';
  }
  // The point of the detail nearest to the connection point.
  let iq = 0;
  let bd = Infinity;
  for (let i = 0; i < M; i++) {
    const d = (P[2 * i] - ref[0]) * (P[2 * i] - ref[0]) + (P[2 * i + 1] - ref[1]) * (P[2 * i + 1] - ref[1]);
    if (d < bd) {
      bd = d;
      iq = i;
    }
  }
  const Z = new Float64Array(2 * M);
  for (let i = 0; i < M; i++) {
    Z[2 * i] = P[2 * iq];
    Z[2 * i + 1] = P[2 * iq + 1];
  }
  const vis = P.vis || onesMask(M - 1);
  const slot = {
    kind,
    role: 'part',
    mode: st.closed ? 'loop' : 'pass',
    fromIndex: exit ? idx : -1,
    toIndex: exit ? -1 : idx,
    M,
    F: exit ? P : Z,
    T: exit ? Z : P,
    visF: vis,
    visT: vis,
    weight: st.length,
    fromOp: st.opacity,
    toOp: st.opacity,
    fill: !!st.fill,
    sw0: st.sw === undefined ? null : st.sw,
    sw1: st.sw === undefined ? null : st.sw,
    ws0: exit && st.ws0 !== undefined ? st.ws0 : 1,
    buf: new Float64Array(2 * M),
    static: false,
    bigTurn: false,
    flip: false,
    theta: 0,
    scale: 1,
    motion,
    chain: { from: exit ? st.bridges : 0, to: exit ? 0 : st.bridges },
    anchor: -1,
    anchorIndex: anc ? anc.index : -1,
    window: [0, 1],
    _anchorSlot: anc ? anc.slot : null,
    a0x: a0[0],
    a0y: a0[1],
    a1x: a1[0],
    a1y: a1[1],
    qx: P[2 * iq],
    qy: P[2 * iq + 1],
    r8d: true,
    closedF: false,
    closedT: false,
    lod: false,
    depth: 0.5,
  };
  if (motion !== 'scaleq') {
    slot.cum = cumLen(P, M);
    slot.L = slot.cum[M - 1];
    slot.sq = slot.cum[iq];
  }
  buildClasses(slot);
  return slot;
}

// A detail grows from both sides of its point sq (arc length) along its own length. v in [0, 1].
function evalBloom(slot, v, src) {
  const { M, cum, L, sq } = slot;
  const out = slot.buf;
  const lo = sq * (1 - v);
  const hi = sq + (L - sq) * v;
  let k = 0;
  for (let i = 0; i < M; i++) {
    const s = Math.min(hi, Math.max(lo, cum[i]));
    while (k < M - 2 && cum[k + 1] < s) k++;
    const seg = cum[k + 1] - cum[k];
    const f = seg > 0 ? Math.min(1, Math.max(0, (s - cum[k]) / seg)) : 0;
    out[2 * i] = src[2 * k] + (src[2 * k + 2] - src[2 * k]) * f;
    out[2 * i + 1] = src[2 * k + 1] + (src[2 * k + 3] - src[2 * k + 1]) * f;
  }
}

// R8 detail at eased progress u. The detail keeps its place: it only shifts with the point of its container (the anchor).
function evalDetail(slot, u) {
  const { F, T } = slot;
  const out = slot.buf;
  const exit = slot.kind === 'exit';
  const src = exit ? F : T;
  const op = exit ? slot.fromOp : slot.toOp === undefined ? 1 : slot.toOp;
  if (exit ? u <= 0 : u >= 1) {
    out.set(src);
    const as0 = slot._anchorSlot;
    if (as0 && as0._bal) shiftBuf(out, slot.M, as0.buf[2 * slot.anchorIndex] - (exit ? slot.a0x : slot.a1x), as0.buf[2 * slot.anchorIndex + 1] - (exit ? slot.a0y : slot.a1y)); // R12c-2
    return op;
  }
  const as = slot._anchorSlot;
  let dx = 0;
  let dy = 0;
  if (as) {
    dx = as.buf[2 * slot.anchorIndex] - (exit ? slot.a0x : slot.a1x);
    dy = as.buf[2 * slot.anchorIndex + 1] - (exit ? slot.a0y : slot.a1y);
  }
  const p = exit ? 1 - u : u;
  const M = slot.M;
  if (slot.motion === 'erase') evalDraw(slot, u, F, false);
  else if (slot.motion === 'draw') evalDraw(slot, u, T, true);
  else if (slot.motion === 'bloom') evalBloom(slot, p, src);
  else {
    const { qx, qy } = slot;
    for (let i = 0; i < M; i++) {
      out[2 * i] = qx + p * (src[2 * i] - qx);
      out[2 * i + 1] = qy + p * (src[2 * i + 1] - qy);
    }
  }
  if (dx !== 0 || dy !== 0) {
    for (let i = 0; i < M; i++) {
      out[2 * i] += dx;
      out[2 * i + 1] += dy;
    }
  }
  return op;
}

/**
 * The plan of two stroke icons by containers (R8-1). Returns null when the round 6b stroke plan applies: a whole-icon
 * turn fits, or every stroke is static.
 *
 * Timeline (`containerSplit`, default [0.3, 0.7]):
 *   [0, 0.3] gather: details retract into their container (from the edge they connect to); each container becomes its
 *            proxy (point blend, or silhouette tiling when it has several strokes); a free stroke goes to its proxy.
 *   [0.3, 0.7] shapes change: proxies tie to proxies (Hungarian on the proxy parameters). A tied proxy morphs by
 *            parameter interpolation. An old proxy with no partner merges into the nearest new proxy. A new proxy with no
 *            partner splits out of the nearest old proxy.
 *   [0.7, 1] details: each new proxy becomes its container; new details grow out from the edge they connect to.
 * Static containers, static free strokes, and the static details of a static container stay still.
 */
function tryContainerPlan(A, B, o) {
  if (!A.length || !B.length) return null;
  const K = oddUp(o.coarsePoints);
  const easing = resolveEasing(o.easing);
  const coarseA = A.map((s) => formFor(s, K, s.closed ? FORM_LOOP : FORM_PASS));
  const coarseB = B.map((s) => formFor(s, K, s.closed ? FORM_LOOP : FORM_PASS));
  if (o.wholeTurn && o.rigid && detectWholeTurn(A, B, coarseA, coarseB, K)) return null;
  const sp = staticStrokePairs(A, B, coarseA, coarseB, K);
  if (A.length === B.length && sp.every((v) => v >= 0)) return null;
  const c0 = Math.min(0.9, Math.max(0.05, o.containerSplit[0]));
  const c1 = Math.min(0.95, Math.max(c0 + 0.05, o.containerSplit[1]));
  const oL = { ...o, simplify: true, lodSplit: [c0, c1] };
  const UA = r8Units(A);
  const UB = r8Units(B);
  UA.units.forEach((u) => (u.side = 'A'));
  UB.units.forEach((u) => (u.side = 'B'));
  const key = (u) => u.side + u.id;

  // Static units: the same shape at the same place, in the same role.
  const staticOf = new Map(); // key of the old unit -> new unit
  const takenB = new Set();
  for (const ua of UA.units) {
    let ub = null;
    let ok = true;
    for (const i of ua.idx) {
      const j = sp[i];
      if (j < 0 || UB.role[j] !== ua.role || (ub && UB.owner[j] !== ub)) {
        ok = false;
        break;
      }
      ub = UB.owner[j];
    }
    if (ok && ub && ub.idx.length === ua.idx.length && !takenB.has(ub.id)) {
      staticOf.set(key(ua), ub);
      takenB.add(ub.id);
    }
  }
  const slots = [];
  const info = [];
  const slotsOf = new Map(); // key of a unit -> its slots on the anchor side ({ g: gather or static, d: detail or static })
  const addSlots = (list, meta) => {
    for (const sl of list) {
      sl.r8 = meta;
      slots.push(sl);
    }
  };
  const mkStatic = (fi, ti, role) => {
    const pr = pairInfo(A[fi], coarseA[fi], B[ti], coarseB[ti], K, o);
    const sl = makeTiedSlot({ kind: 'match', fi, ti, mode: pr.mode, s: pr.s, dir: pr.dir, role }, A, B, o, K, true, false, 0, 0, easing);
    sl.phase = 'match';
    return sl;
  };
  const doneA = new Set(); // old details that are static
  const doneB = new Set();
  for (const ua of UA.units) {
    const ub = staticOf.get(key(ua));
    if (!ub) continue;
    const id = key(ua) + '>' + key(ub);
    const meta = { role: ua.role, tie: 'static', unit: id };
    const list = ua.idx.map((i) => mkStatic(i, sp[i], 'core'));
    addSlots(list, meta);
    slotsOf.set(key(ua), { g: list });
    slotsOf.set(key(ub), { d: list });
    info.push({ id, kind: 'static', role: ua.role, from: ua.idx.slice(), to: ub.idx.slice(), details: { from: ua.details.slice(), to: ub.details.slice() } });
    if (ua.role !== 'container') continue;
    for (const da of ua.details) {
      const dj = sp[da];
      if (dj >= 0 && UB.role[dj] === 'detail' && UB.owner[dj] === ub) {
        addSlots([mkStatic(da, dj, 'part')], { role: 'detail', tie: 'static', unit: id });
        doneA.add(da);
        doneB.add(dj);
      }
    }
  }

  // Tie the proxies: containers with containers, free strokes with free strokes, then the leftovers across.
  const ra = UA.units.filter((u) => !staticOf.has(key(u)));
  const rb = UB.units.filter((u) => !takenB.has(u.id));
  const tied = new Map(); // key of the old unit -> new unit
  const tiedB = new Set();
  const assign = (la, lb) => {
    if (!la.length || !lb.length) return;
    const N = Math.max(la.length, lb.length);
    const cost = new Float64Array(N * N);
    for (let x = 0; x < la.length; x++) {
      for (let y = 0; y < lb.length; y++) cost[x * N + y] = sameStyle(la[x].strokes[0], lb[y].strokes[0]) ? r8Cost(la[x], lb[y]) : BIG;
    }
    const asg = hungarian(cost, N);
    for (let x = 0; x < la.length; x++) {
      const y = asg[x];
      if (y >= lb.length || cost[x * N + y] >= BIG / 2) continue;
      tied.set(key(la[x]), lb[y]);
      tiedB.add(lb[y].id);
    }
  };
  const left = (list, side) => list.filter((u) => (side === 'A' ? !tied.has(key(u)) : !tiedB.has(u.id)));
  for (const role of ['container', 'free']) assign(left(ra, 'A').filter((u) => u.role === role), left(rb, 'B').filter((u) => u.role === role));
  assign(left(ra, 'A'), left(rb, 'B'));

  // The nearest proxy on the other side (a non-static one when there is one).
  const nearest = (u, list, all) => {
    const pool = list.length ? list : all;
    let best = null;
    let bc = Infinity;
    for (const v of pool) {
      const c = u.side === 'A' ? r8Cost(u, v) : r8Cost(v, u);
      if (c < bc) {
        bc = c;
        best = v;
      }
    }
    return best;
  };
  const phaseOf = (sl) => {
    sl.window = [sl._phase[0], sl._phase[1]];
    sl.show = sl.phase === 'gather' ? [0, sl.window[1]] : sl.phase === 'morph' ? [sl.window[0], sl.window[1]] : [sl.window[0], 1];
  };
  // ua: old unit or null (split); ub: new unit or null (merge); other: the unit whose proxy a merge goes into (new side)
  // or a split comes out of (old side).
  const triple = (ua, ub, other, tie, id) => {
    let fa;
    let fb;
    if (ua && ub) {
      fa = objFit(ua);
      fb = alignSuperellipse(fa, objFit(ub));
    } else if (ua) {
      fa = objFit(ua);
      fb = alignSuperellipse(fa, objFit(other));
    } else {
      fa = objFit(other);
      fb = alignSuperellipse(fa, objFit(ub));
    }
    const meta = { role: (ua || ub).role, tie, unit: id };
    const g = ua ? r8Gather(ua, tileObject(ua, fa, o), c0) : [];
    const m = r8Morph(ua, ub, fa, fb, c0, c1, o);
    const d = ub ? r8Detail(ub, tileObject(ub, fb, o), c1) : [];
    const list = g.concat([m], d);
    for (const sl of list) phaseOf(sl);
    addSlots(list, meta);
    if (ua) slotsOf.set(key(ua), { g });
    if (ub) slotsOf.set(key(ub), { d });
  };
  for (const ua of ra) {
    const ub = tied.get(key(ua));
    if (ub) {
      const id = key(ua) + '>' + key(ub);
      info.push({ id, kind: 'tie', role: ua.role === ub.role ? ua.role : 'cross', from: ua.idx.slice(), to: ub.idx.slice(), details: { from: ua.details.slice(), to: ub.details.slice() } });
      if (ua.role === 'free' && ub.role === 'free') {
        const i = ua.idx[0];
        const j = ub.idx[0];
        const pr = pairInfo(A[i], coarseA[i], B[j], coarseB[j], K, o);
        const sl = makeTiedSlot({ kind: 'match', fi: i, ti: j, mode: pr.mode, s: pr.s, dir: pr.dir, role: 'core', lod: true }, A, B, oL, K, true, false, 0, 0, easing);
        sl.window = [0, 1];
        sl.phase = 'match';
        addSlots([sl], { role: 'free', tie: 'tie', unit: id });
      } else triple(ua, ub, null, 'tie', id);
    } else {
      const dst = nearest(ua, rb, UB.units);
      const id = key(ua) + '>' + key(dst);
      info.push({ id, kind: 'merge', role: ua.role, from: ua.idx.slice(), to: [], details: { from: ua.details.slice(), to: [] } });
      triple(ua, null, dst, 'merge', id);
    }
  }
  for (const ub of rb) {
    if (tiedB.has(ub.id)) continue;
    const src = nearest(ub, ra, UA.units);
    const id = key(src) + '>' + key(ub);
    info.push({ id, kind: 'split', role: ub.role, from: [], to: ub.idx.slice(), details: { from: [], to: ub.details.slice() } });
    triple(null, ub, src, 'split', id);
  }

  // The details: exits retract into the old container in [0, c0]; entries grow out of the new container in [c1, 1].
  for (const ua of UA.units) {
    if (ua.role !== 'container') continue;
    const cands = (slotsOf.get(key(ua)) || {}).g || [];
    const meta = { role: 'detail', tie: staticOf.has(key(ua)) ? 'static' : tied.has(key(ua)) ? 'tie' : 'merge', unit: key(ua) };
    for (const i of ua.details) {
      if (doneA.has(i)) continue;
      const sl = buildDetailSlot('exit', A[i], i, o, K, cands);
      sl.window = [0, c0];
      addSlots([sl], meta);
    }
  }
  for (const ub of UB.units) {
    if (ub.role !== 'container') continue;
    const cands = (slotsOf.get(key(ub)) || {}).d || [];
    const meta = { role: 'detail', tie: takenB.has(ub.id) ? 'static' : tiedB.has(ub.id) ? 'tie' : 'split', unit: key(ub) };
    for (const j of ub.details) {
      if (doneB.has(j)) continue;
      const sl = buildDetailSlot('enter', B[j], j, o, K, cands);
      sl.window = [c1, 1];
      addSlots([sl], meta);
    }
  }
  return finishPlan(slots, A, B, coarseA, coarseB, o, true, 0, null, null, { objects: info });
}

// ---------------------------------------------------------------------------
// planMorph
// ---------------------------------------------------------------------------

let fillPlanner = null;
let crossPlanner = null;

/**
 * Set the planner for a pair of fill icons (R7-B). `fn(from, to, opts)` returns a plan with the plan API.
 * `from` and `to` are what the caller gave planMorph (name, node, or snapshot). `opts` is the full knob set
 * (DEFAULTS merged with the caller's options). Pass null to remove it.
 * @param {((from: any, to: any, opts: any) => any)|null} fn
 */
function setFillPlanner(fn) {
  fillPlanner = typeof fn === 'function' ? fn : null;
}

/**
 * Set the planner for a pair of icons of different kinds (a stroke icon and a fill icon). `fn(from, to, opts)`
 * returns a sequence plan (implode the old icon, then expand the new one). planMorph sets `plan.crossKind = true`.
 * @param {((from: any, to: any, opts: any) => any)|null} fn
 */
function setCrossPlanner(fn) {
  crossPlanner = typeof fn === 'function' ? fn : null;
}

const familyOfSet = (id) => (id.indexOf('-') > 0 ? id.slice(0, id.indexOf('-')) : id);

/**
 * R8: are the two icons the same icon in two styles? True when both are names with the same base name (the part after
 * the `<id>:` prefix; a plain Lucide name has the set `lucide`) and their sets are the same set or belong to one family
 * (the part of the set id before the first `-`: `phosphor-thin` and `phosphor-bold` are one family, `remix-line` and
 * `remix-fill`, `tabler-outline` and `tabler-filled`). Nodes and snapshots are never style toggles.
 * @param {any} a
 * @param {any} b
 * @returns {boolean}
 */
function isStyleToggle(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const split = (s) => {
    const k = s.indexOf(':');
    return k > 0 ? { set: s.slice(0, k), name: s.slice(k + 1) } : { set: 'lucide', name: s };
  };
  const x = split(a);
  const y = split(b);
  if (x.name !== y.name) return false;
  return x.set === y.set || familyOfSet(x.set) === familyOfSet(y.set);
}

/**
 * Plan a morph between two icons. `from` and `to` can be an icon name, an icon node, or a snapshot.
 * Two stroke icons: the stroke planner (objects, Rules 1 to 5). Two fill icons: the fill planner (setFillPlanner).
 * A stroke icon and a fill icon: the cross planner (setCrossPlanner), and `plan.crossKind` is true.
 * @param {string|IconNode|Snapshot} from
 * @param {string|IconNode|Snapshot} to
 * @param {Partial<typeof DEFAULTS>} [opts]
 */
function planMorph(from, to, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  // R8: a style toggle (the same icon in two styles) morphs directly: no gather and detail steps.
  o.styleToggle = isStyleToggle(from, to);
  if (o.styleToggle) o.objects = false;
  const ka = getKind(from);
  const kb = getKind(to);
  if (ka === 'fill' && kb === 'fill') {
    if (!fillPlanner) throw new Error('planMorph: both icons are fill icons, and no fill planner is set. Import regions.js (it calls setFillPlanner) or call setFillPlanner(fn).');
    return fillPlanner(from, to, o);
  }
  if (ka !== kb) {
    if (!crossPlanner) throw new Error('planMorph: one icon is a stroke icon and the other is a fill icon, and no cross planner is set. Call setCrossPlanner(fn) (regions.js or index.js does this).');
    const plan = crossPlanner(from, to, o);
    if (plan && plan.crossKind === undefined) plan.crossKind = true;
    return plan;
  }
  o._swFrom = srcWidth(from);
  o._swTo = srcWidth(to);
  o._capsFrom = srcCaps(from);
  o._capsTo = srcCaps(to);
  return planStrokes(toStrokes(from, o), toStrokes(to, o), o);
}

// ---------------------------------------------------------------------------
// R14: keep what stays. A pre-pass before matching (stroke icons, rules matching, no objects).
// A point of a stroke is kept when it lies within KEEP_DIST of a stroke of the other icon and the two tangents agree within
// KEEP_ANGLE. A run of kept points at least KEEP_RUN long is a kept segment. Strokes with kept segments are cut into kept
// pieces (paired with the piece of the other icon on the same line, static) and changed pieces (which hang on the kept piece
// they join). A stroke is cut only when its paired kept length is at least KEEP_FRAC of its length.
// ---------------------------------------------------------------------------

const KEEP_DIST = 0.15;
const KEEP_COS = Math.cos(20 * DEG);
const KEEP_RUN = 1;
const KEEP_FRAC = 0.25;
const KEEP_STEP = 0.25;
const KEEP_GAP = 0.5;
const KEEP_COVER = 0.9;

// Dense copy of a stroke: points at most KEEP_STEP apart (the geometry does not change), the corner flags, the segment visibility.
function keepDensify(s) {
  const P = s.pts;
  const n0 = P.length / 2;
  const m0 = s.closed ? n0 : n0 - 1;
  const isCorner = new Uint8Array(n0);
  for (const c of s.corners) isCorner[c] = 1;
  const pts = [];
  const cor = [];
  const vis = [];
  for (let i = 0; i < m0; i++) {
    const j = (i + 1) % n0;
    const dx = P[2 * j] - P[2 * i];
    const dy = P[2 * j + 1] - P[2 * i + 1];
    const cnt = Math.max(1, Math.ceil(Math.hypot(dx, dy) / KEEP_STEP));
    const v = s.vis ? s.vis[i] : 1;
    for (let k = 0; k < cnt; k++) {
      pts.push(P[2 * i] + (dx * k) / cnt, P[2 * i + 1] + (dy * k) / cnt);
      cor.push(k === 0 ? isCorner[i] : 0);
      vis.push(v);
    }
  }
  if (!s.closed) {
    pts.push(P[2 * (n0 - 1)], P[2 * (n0 - 1) + 1]);
    cor.push(1);
  }
  return { pts, cor, vis, n: pts.length / 2, closed: s.closed };
}

// Which points of the dense stroke D (of stroke s) are kept against the strokes `others` of the other icon.
function keepMask(s, D, others) {
  const n = D.n;
  const kept = new Uint8Array(n);
  const cand = others.filter((q) => !q.fill && q.sw !== 0 && sameStyle(s, q));
  if (!cand.length) return kept;
  const boxes = cand.map(strokeBox);
  const m = D.closed ? n : n - 1;
  let any = false;
  for (let p = 0; p < n; p++) {
    // The segment that starts at p (the one that ends at p for the last point of an open stroke).
    let a = p;
    let b = (p + 1) % n;
    let sv = p < m ? D.vis[p] : 0;
    if (p >= m) {
      a = p - 1;
      b = p;
      sv = a >= 0 ? D.vis[a] : 0;
    }
    if (!sv) continue;
    const x = D.pts[2 * p];
    const y = D.pts[2 * p + 1];
    let tx = D.pts[2 * b] - D.pts[2 * a];
    let ty = D.pts[2 * b + 1] - D.pts[2 * a + 1];
    const tl = Math.hypot(tx, ty);
    if (tl < 1e-9) continue;
    tx /= tl;
    ty /= tl;
    for (let c = 0; c < cand.length && !kept[p]; c++) {
      const bx = boxes[c];
      if (x < bx[0] - KEEP_DIST || x > bx[2] + KEEP_DIST || y < bx[1] - KEEP_DIST || y > bx[3] + KEEP_DIST) continue;
      const q = cand[c];
      const nr = nearestOnStrokeNear(q, x, y);
      if (nr.d > KEEP_DIST) continue;
      const Q = q.pts;
      const i = nr.i;
      const j = (i + 1) % (Q.length / 2);
      const ux = Q[2 * j] - Q[2 * i];
      const uy = Q[2 * j + 1] - Q[2 * i + 1];
      const ul = Math.hypot(ux, uy);
      if (ul < 1e-9) continue;
      if (Math.abs((tx * ux + ty * uy) / ul) >= KEEP_COS) kept[p] = 1;
    }
    if (kept[p]) any = true;
  }
  return any ? kept : null;
}

// Fill gaps shorter than KEEP_GAP between kept points, then return the runs of at least KEEP_RUN: [{ a, b, len }] in unrolled point
// indices (b may be >= n for a closed stroke: use modulo). A closed stroke that is kept all round is one run { a: 0, b: n, all: true }.
function keepRuns(D, kept) {
  const n = D.n;
  const closed = D.closed;
  const segLen = (p) => Math.hypot(D.pts[2 * ((p + 1) % n)] - D.pts[2 * p], D.pts[2 * ((p + 1) % n) + 1] - D.pts[2 * p + 1]);
  const lenOf = (a, b) => {
    let L = 0;
    for (let p = a; p < b; p++) L += segLen(p % n);
    return L;
  };
  let first = -1;
  for (let p = 0; p < n; p++) {
    if (kept[p]) {
      first = p;
      break;
    }
  }
  if (first < 0) return [];
  // Gap fill between consecutive kept points (unrolled from `first`; a closed stroke also fills the gap that wraps round).
  const span = closed ? n : n - first;
  let prev = first;
  for (let u = first + 1; u <= first + span; u++) {
    const isEnd = closed && u === first + n;
    if (!isEnd && u >= first + span) break;
    if (!isEnd && !kept[u % n]) continue;
    if (u - prev > 1 && lenOf(prev, u) <= KEEP_GAP) for (let w = prev + 1; w < u; w++) kept[w % n] = 1;
    prev = u;
  }
  let allKept = true;
  for (let p = 0; p < n; p++) {
    if (!kept[p]) {
      allKept = false;
      break;
    }
  }
  if (closed && allKept) return [{ a: 0, b: n, all: true, len: lenOf(0, n) }];
  let start = 0;
  if (closed) {
    for (let p = 0; p < n; p++) {
      if (kept[p] && !kept[(p - 1 + n) % n]) {
        start = p;
        break;
      }
    }
  }
  const runs = [];
  let u = 0;
  while (u < n) {
    if (!kept[(start + u) % n]) {
      u++;
      continue;
    }
    let e = u;
    while (e + 1 < n && kept[(start + e + 1) % n]) e++;
    const L = lenOf(start + u, start + e);
    if (L >= KEEP_RUN) runs.push({ a: start + u, b: start + e, len: L });
    u = e + 1;
  }
  return runs;
}

function keepDistToPoly(Q, x, y) {
  let bd = Infinity;
  for (let j = 0; j + 3 < Q.length; j += 2) {
    const dx = Q[j + 2] - Q[j];
    const dy = Q[j + 3] - Q[j + 1];
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((x - Q[j]) * dx + (y - Q[j + 1]) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(x - Q[j] - t * dx, y - Q[j + 1] - t * dy);
    if (d < bd) bd = d;
  }
  return bd;
}

function ptsInside(P, Q, thr = KEEP_DIST + 0.03) {
  // Fraction of the points of P (flat) that lie within thr of the polyline Q (flat).
  const np = P.length / 2;
  const nq = Q.length / 2;
  let hit = 0;
  for (let i = 0; i < np; i++) {
    const x = P[2 * i];
    const y = P[2 * i + 1];
    let bd = Infinity;
    for (let j = 0; j + 1 < nq; j++) {
      const ax = Q[2 * j];
      const ay = Q[2 * j + 1];
      const dx = Q[2 * j + 2] - ax;
      const dy = Q[2 * j + 3] - ay;
      const l2 = dx * dx + dy * dy;
      let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(x - ax - t * dx, y - ay - t * dy);
      if (d < bd) bd = d;
    }
    if (bd <= thr) hit++;
  }
  return np ? hit / np : 0;
}

// The ends of two kept pieces (flat point lists) agree within KEEP_END, first to first and last to last, or crossed.
function keepEndsAgree(P, Q) {
  const e = (L, k) => (k === 0 ? [L[0], L[1]] : [L[L.length - 2], L[L.length - 1]]);
  const d = (u, v) => Math.hypot(u[0] - v[0], u[1] - v[1]);
  const [p0, p1, q0, q1] = [e(P, 0), e(P, 1), e(Q, 0), e(Q, 1)];
  if (d(p0, q0) <= KEEP_END && d(p1, q1) <= KEEP_END) return true;
  return d(p0, q1) <= KEEP_END && d(p1, q0) <= KEEP_END;
}

function keepSub(D, a, b) {
  // Points a..b (unrolled, inclusive), their corner flags, and the visibility of the segments between them.
  const n = D.n;
  const pts = [];
  const cor = [];
  const vis = [];
  for (let p = a; p <= b; p++) {
    const q = p % n;
    pts.push(D.pts[2 * q], D.pts[2 * q + 1]);
    cor.push(D.cor[q]);
    if (p < b) vis.push(D.vis[q]);
  }
  return { pts, cor, vis };
}

function keepPiece(src, sub, role, cornerAngle) {
  const joints = [];
  sub.cor.forEach((c, i) => c && joints.push(i));
  const vis = sub.vis.every((v) => v) ? null : sub.vis;
  const st = makeStroke(sub.pts, joints, false, cornerAngle, src.opacity, false, vis);
  if (!st) return null;
  st.fill = src.fill;
  st.sw = src.sw;
  st.rw = src.rw;
  if (src.ws0 !== undefined) st.ws0 = src.ws0;
  st.bridges = countBridges(st);
  st._role = role;
  return st;
}

/**
 * R14 pre-pass. Returns { A, B, info } with the cut strokes (each array carries .tree), or null when nothing is kept.
 * info.pairs lists the static slots: { a, b, len } (indices in the new arrays).
 */
function keepPrepass(A, B, o) {
  const prep = (S) => S.map((s) => (s.fill || s.sw === 0 ? null : keepDensify(s)));
  const DA = prep(A);
  const DB = prep(B);
  const pieces = []; // { side, si, run, D, len, whole, pts, pair }
  const collect = (S, D, other, side) => {
    S.forEach((s, si) => {
      if (!D[si]) return;
      const kept = keepMask(s, D[si], other);
      if (!kept) return;
      for (const run of keepRuns(D[si], kept)) {
        const sub = keepSub(D[si], run.a, run.b);
        const whole = run.all || (!s.closed && run.a === 0 && run.b === D[si].n - 1) || run.len >= 0.98 * s.length;
        pieces.push({ side, si, run, len: run.len, whole, pts: sub.pts, pair: null });
      }
    });
  };
  collect(A, DA, B, 'A');
  collect(B, DB, A, 'B');
  // R14-8b: never cut a stroke that belongs to an R11 mirror group (in either icon). The members of a group share one motion
  // (R11b-5), so a cut on one member and not on its partner would move the two apart. When either icon has a mirror group the
  // pre-pass returns with no cut: the R11 rig finds a partner by its original stroke index, and a cut shifts the plan's indices.
  const partners = (S) => {
    const out = S.map(() => []);
    for (let i = 0; i < S.length; i++) {
      for (let j = i + 1; j < S.length; j++) {
        const gv = mirrorGap(S[i], S[j], 'v');
        const gh = mirrorGap(S[i], S[j], 'h');
        if (Math.min(gv, gh) === Infinity) continue;
        const ax = gv <= gh ? 'v' : 'h';
        out[i].push({ j, ax });
        out[j].push({ j: i, ax });
      }
    }
    return out;
  };
  const mirrorOf = { A: partners(A), B: partners(B) };
  if (mirrorOf.A.some((l) => l.length) || mirrorOf.B.some((l) => l.length)) return null;
  const pa = pieces.filter((p) => p.side === 'A');
  const pb = pieces.filter((p) => p.side === 'B');
  if (!pa.length || !pb.length) return null;
  const cands = [];
  for (const x of pa) {
    for (const y of pb) {
      if (!sameStyle(A[x.si], B[y.si])) continue;
      const c1 = ptsInside(x.pts, y.pts, KEEP_DIST);
      if (c1 < KEEP_COVER) continue;
      const c2 = ptsInside(y.pts, x.pts, KEEP_DIST);
      if (c2 < KEEP_COVER) continue;
      if (!keepEndsAgree(x.pts, y.pts)) continue;
      cands.push({ x, y, sc: Math.min(c1, c2) });
    }
  }
  cands.sort((p, q) => q.sc - p.sc);
  for (const c of cands) {
    if (c.x.pair || c.y.pair) continue;
    c.x.pair = c.y;
    c.y.pair = c.x;
  }
  // R14-11: a kept piece that lies on two strokes of the other icon is cut at the seam, and each part is kept with the stroke it lies on.
  for (const side of ['A', 'B']) {
    const D = side === 'A' ? DA : DB;
    const mineP = pieces.filter((p) => p.side === side && !p.pair);
    const otherP = pieces.filter((p) => p.side !== side && !p.pair);
    for (const y of mineP) {
      if (D[y.si].closed) continue;
      const xs = otherP.filter((x) => !x.pair && sameStyle(A[side === 'A' ? y.si : x.si], B[side === 'A' ? x.si : y.si]) && ptsInside(x.pts, y.pts, KEEP_DIST) >= KEEP_COVER);
      if (xs.length < 2 || new Set(xs.map((x) => x.si)).size < 2) continue;
      const d = D[y.si];
      const lab = [];
      for (let p = y.run.a; p <= y.run.b; p++) {
        let best = -1;
        let bd = KEEP_DIST;
        xs.forEach((x, k) => {
          const dd = keepDistToPoly(x.pts, d.pts[2 * p], d.pts[2 * p + 1]);
          if (dd <= bd) {
            bd = dd;
            best = k;
          }
        });
        lab.push(best);
      }
      const subs = [];
      xs.forEach((x, k) => {
        let bestRun = null;
        for (let i = 0; i < lab.length; i++) {
          if (lab[i] !== k) continue;
          let e = i;
          while (e + 1 < lab.length && lab[e + 1] === k) e++;
          const a = y.run.a + i;
          const b = y.run.a + e;
          let len = 0;
          for (let p = a; p < b; p++) len += Math.hypot(d.pts[2 * p + 2] - d.pts[2 * p], d.pts[2 * p + 3] - d.pts[2 * p + 1]);
          if (len >= KEEP_RUN && (!bestRun || len > bestRun.len)) bestRun = { a, b, len };
          i = e;
        }
        if (bestRun && keepEndsAgree(keepSub(d, bestRun.a, bestRun.b).pts, x.pts)) subs.push({ x, run: bestRun });
      });
      let tot = 0;
      for (const sb of subs) tot += sb.run.len;
      if (subs.length < 2 || tot < KEEP_COVER * y.len) continue;
      for (const sb of subs) {
        const np = { side, si: y.si, run: sb.run, len: sb.run.len, whole: false, pts: keepSub(d, sb.run.a, sb.run.b).pts, pair: sb.x };
        sb.x.pair = np;
        pieces.push(np);
        (side === 'A' ? pa : pb).push(np);
      }
    }
  }
  // A kept piece that is a whole stroke on both sides is the old static case: leave it to the static rule.
  for (const p of pa) if (p.pair && p.whole && p.pair.whole) { p.pair.pair = null; p.pair = null; }
  // R14-5: a stroke is cut only when its paired kept length is at least KEEP_FRAC of its length.
  for (let guard = 0; guard < 16; guard++) {
    let change = false;
    for (const side of ['A', 'B']) {
      const S = side === 'A' ? A : B;
      S.forEach((s, si) => {
        const mine = pieces.filter((p) => p.side === side && p.si === si && p.pair);
        if (!mine.length) return;
        let L = 0;
        for (const p of mine) L += p.len;
        if (L < KEEP_FRAC * s.length) {
          for (const p of mine) { p.pair.pair = null; p.pair = null; }
          change = true;
        }
      });
    }
    if (!change) break;
  }
  if (!pieces.some((p) => p.pair)) return null;
  // Cut.
  const build = (S, D, side) => {
    const out = [];
    const made = new Map(); // piece -> stroke
    S.forEach((s, si) => {
      const mine = pieces.filter((p) => p.side === side && p.si === si && p.pair).sort((x, y) => x.run.a - y.run.a);
      if (!mine.length) {
        out.push(s);
        return;
      }
      const d = D[si];
      const n = d.n;
      const seq = [];
      const keptStroke = (p) => {
        const st = keepPiece(s, keepSub(d, p.run.a, p.run.b), 'kept', o.cornerAngle);
        if (st) made.set(p, st);
        return st;
      };
      const changed = (a, b) => {
        if (b <= a) return null;
        return keepPiece(s, keepSub(d, a, b), 'changed', o.cornerAngle);
      };
      if (s.closed) {
        if (mine[0].run.all) {
          // whole closed stroke kept: one kept piece (closed)
          const st = { ...s, id: strokeId++, cacheable: false, _role: 'kept', _box: undefined, _grid: undefined, _vsmp: undefined, _ext: undefined, _info: undefined, _ts: undefined };
          made.set(mine[0], st);
          out.push(st);
          return;
        }
        const a0 = mine[0].run.a;
        for (let k = 0; k < mine.length; k++) {
          seq.push(keptStroke(mine[k]));
          const e = mine[k].run.b;
          const nx = k + 1 < mine.length ? mine[k + 1].run.a : a0 + n;
          seq.push(changed(e, nx));
        }
      } else {
        const r0 = mine[0].run;
        if (r0.a > 0) seq.push(changed(0, r0.a));
        for (let k = 0; k < mine.length; k++) {
          seq.push(keptStroke(mine[k]));
          const e = mine[k].run.b;
          const nx = k + 1 < mine.length ? mine[k + 1].run.a : n - 1;
          seq.push(changed(e, nx));
        }
      }
      for (const st of seq) if (st) out.push(st);
    });
    return { out, made };
  };
  const ra = build(A, DA, 'A');
  const rb = build(B, DB, 'B');
  const pairs = [];
  for (const p of pa) {
    if (!p.pair) continue;
    const sa = ra.made.get(p);
    const sb = rb.made.get(p.pair);
    if (!sa || !sb) continue;
    sa._keepWith = sb;
    sb._keepWith = sa;
    pairs.push({ a: sa, b: sb, len: Math.max(p.len, p.pair.len) });
  }
  if (!pairs.length) return null;
  const NA = ra.out;
  const NB = rb.out;
  NA.tree = buildTree(NA);
  NB.tree = buildTree(NB);
  return { A: NA, B: NB, pairs: pairs.map((p) => ({ a: NA.indexOf(p.a), b: NB.indexOf(p.b), len: p.len })) };
}

/**
 * R14: the kept pieces of two stroke icons, for reports and tests: { pairs: [{ a, b, len, ax, bx }], A: [{ role, len }], B: [...] }.
 * Returns null when nothing is cut. `ax` and `bx` are the point lists (flat) of the kept piece on each side.
 */
function keptSegments(from, to, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const A = toStrokes(from, o);
  const B = toStrokes(to, o);
  o._swFrom = srcWidth(from);
  o._swTo = srcWidth(to);
  o._capsFrom = srcCaps(from);
  o._capsTo = srcCaps(to);
  o.styleToggle = isStyleToggle(from, to);
  if (o.styleToggle) o.objects = false;
  const kp = planStrokesKeep(A, B, o).kp;
  if (!kp) return null;
  const info = (S) => S.map((s) => ({ role: s._role || 'whole', len: +s.length.toFixed(3), closed: s.closed }));
  return { pairs: kp.pairs.map((p) => ({ a: p.a, b: p.b, len: +p.len.toFixed(3) })), A: info(kp.A), B: info(kp.B) };
}

// R14 fix pass 2: the ink travel of a plan (px at 96 px): the sum over frame steps of the displacement of index-matched points
// of each slot entry. Used at plan time to decide whether a cut pays (R14-5).
const KEEP_NUM = /-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/g;
function inkTravel(plan, nf) {
  let prev = null;
  let sum = 0;
  for (let f = 0; f <= nf; f++) {
    const cur = new Map();
    for (const e of plan.frame(f / nf)) {
      const subs = e.d.split('M');
      const list = [];
      for (const sp of subs) if (sp) list.push((sp.match(KEEP_NUM) || []).map(Number));
      cur.set(e.key, list);
    }
    if (prev) {
      for (const [k, list] of cur) {
        const l0 = prev.get(k);
        if (!l0) continue;
        for (let i = 0; i < Math.min(list.length, l0.length); i++) {
          const n = Math.min(list[i].length, l0[i].length) >> 1;
          for (let q = 0; q < n; q++) sum += Math.hypot(list[i][2 * q] - l0[i][2 * q], list[i][2 * q + 1] - l0[i][2 * q + 1]);
        }
      }
    }
    prev = cur;
  }
  return sum * 4;
}

const KEEP_TRAVEL_FRAMES = 20;
const KEEP_END = 0.24; // R14 fix pass 2: the two kept pieces of a pair have ends within KEEP_END units 

// R14-10: a cheap necessary test before the keep pre-pass (which densifies every stroke and scans it against the other icon).
// A kept point of a stroke lies within KEEP_DIST of a stroke of the other icon, so the two stroke boxes are within KEEP_DIST.
// Most pairs have no such pair of strokes, so the pre-pass does not run for them.
function keepCandidate(A, B) {
  const xs = [];
  const ys = [];
  for (const s of A) if (!s.fill && s.sw !== 0) xs.push({ s, b: strokeBox(s) });
  for (const s of B) if (!s.fill && s.sw !== 0) ys.push({ s, b: strokeBox(s) });
  for (const x of xs) {
    for (const y of ys) {
      if (!sameStyle(x.s, y.s)) continue;
      const dx = Math.max(x.b[0] - y.b[2], y.b[0] - x.b[2], 0);
      const dy = Math.max(x.b[1] - y.b[3], y.b[1] - x.b[3], 0);
      if (Math.hypot(dx, dy) <= KEEP_DIST) return true;
    }
  }
  return false;
}

// R14 + R14-5: the plan, and the accepted pre-pass (null when no cut is kept). R14-9 (gate B, owner 2026-10-20; R14-9b, gate 1.0, is withdrawn): the cut plan is kept
// when its ink travel is at most o.keepGate times the travel of the plan without the cut (default 0.8): the cut must lower the travel by at least 20%.
function planStrokesKeep(A, B, o) {
  if (o.keepStatic !== false && o.matching !== 'legacy' && !o.objects && !o.styleToggle && A.length && B.length && A !== B) {
    if (!keepCandidate(A, B)) return { plan: null, kp: null }; // R14-10: plan both ways only when there is a candidate
    const kp = keepPrepass(A, B, o);
    if (kp) {
      const cut = buildPlan(kp.A, kp.B, { ...o, _keepPairs: kp.pairs }, null);
      const gate = o.keepGate === undefined ? 0.8 : o.keepGate; // R14-9: keep the cuts only when they lower the ink travel by at least 20% (ratio at most 0.8)
      if (gate === Infinity) return { plan: cut, kp };
      const plain = buildPlan(A, B, { ...o }, null);
      const ratio = inkTravel(cut, KEEP_TRAVEL_FRAMES) / Math.max(1e-9, inkTravel(plain, KEEP_TRAVEL_FRAMES));
      if (ratio <= gate) return { plan: cut, kp };
      return { plan: plain, kp: null }; // R14-10: reuse the uncut plan (planStrokes does not build it again)
    }
  }
  return { plan: null, kp: null };
}

// The stroke planner: objects (R7-A) when they apply, else the round 6b stroke rules.
function planStrokes(A, B, o) {
  const k = planStrokesKeep(A, B, o);
  if (k.plan) return k.plan;
  if (o.matching !== 'legacy') {
    if (o.objects === 'containers') {
      const p = tryContainerPlan(A, B, o);
      if (p) return p;
    } else if (o.objects === 'single' || o.objects === true) {
      const p = tryObjectPlan(A, B, o);
      if (p) return p;
    }
  }
  return buildPlan(A, B, o, null);
}

// ---------------------------------------------------------------------------
// R6-3 hooks for effects
// ---------------------------------------------------------------------------

function countBridges(s) {
  if (!s.vis) return 0;
  let runs = 0;
  const L = s.vis.length;
  for (let i = 0; i < L; i++) if (!s.vis[i] && (i > 0 ? s.vis[i - 1] : s.closed ? s.vis[L - 1] : 1)) runs++;
  return runs;
}

/**
 * The strokes of an icon (or a snapshot) as loops that planToLoops accepts as targets. One loop per stroke, in
 * source order. `points` is a Float64Array of x, y pairs (a closed loop does not repeat its first point).
 * `joints` are the feature points and `vis` is the segment mask of a chain (null when all segments are real).
 * Copy and transform `points` to make a target: a similarity transform keeps `joints` and `vis` valid.
 * @param {string|IconNode|Snapshot} src
 * @param {Partial<typeof DEFAULTS>} [opts]
 * @returns {{points: Float64Array, closed: boolean, joints: Int32Array, vis: Uint8Array|null}[]}
 */
function iconLoops(src, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  return toStrokes(src, o).map((s) => ({
    points: Float64Array.from(s.pts),
    closed: s.closed,
    joints: Int32Array.from(s.corners),
    vis: s.vis ? Uint8Array.from(s.vis) : null,
  }));
}

function loopToStroke(t, o) {
  const src = t.points;
  const pts = [];
  for (let k = 0; k < src.length; k += 2) pts.push(src[k], src[k + 1]);
  const n = pts.length / 2;
  if (n === 0) return null;
  const closed = t.closed !== undefined ? !!t.closed : n >= 3 && dist(pts[0], pts[1], pts[2 * n - 2], pts[2 * n - 1]) < 1e-6;
  let joints = t.joints ? Array.from(t.joints) : null;
  if (!joints) {
    joints = [];
    for (let k = 0; k < n; k++) joints.push(k);
  }
  const s = makeStroke(pts, joints, closed, o.cornerAngle, 1, false, t.vis || null);
  if (s) s.bridges = countBridges(s);
  return s;
}

/**
 * Plan a morph from an icon (or snapshot) to a list of target loops, with a forced one-to-one pairing in slot order:
 * source stroke i (source order, see iconLoops) is tied to targets[i]. A null target (or a missing one) leaves the
 * source stroke unpaired: it is an `exit` slot that goes into the body. A target past the last source stroke is an
 * `enter` slot. A target is `{ points, closed?, joints?, vis?, role?, align?, lod?, window? }`:
 * - `align`: 'best' (default, the same alignment as planMorph) or 'identity' (point k to point k: use it for a
 *   similarity copy of the source loop made from iconLoops; no flip or big turn is tried);
 * - `role`: 'core' or 'part' (default: by weight, as in Rule 1). Exits and enters ride on core slots;
 * - `lod`: true forces the three steps of R6-1 for this slot (use with `minRigidSpread: 0` for tiny targets);
 * - `window`: [start, end] of this slot in plan time (an override of staging).
 * `opts` take every knob of planMorph, plus `widthScale: (slot, t) => number`. Use `staging: false` for plain windows.
 * @param {string|IconNode|Snapshot} from
 * @param {(null|{points: ArrayLike<number>, closed?: boolean, joints?: ArrayLike<number>, vis?: Uint8Array|null, role?: string, align?: string, lod?: boolean, window?: number[]})[]} targets
 * @param {Partial<typeof DEFAULTS>} [opts]
 */
function planToLoops(from, targets, opts = {}) {
  const o = { ...DEFAULTS, ...opts, matching: 'rules', wholeTurn: false };
  o._swFrom = o._swTo = srcWidth(from);
  o._capsFrom = o._capsTo = srcCaps(from);
  const A = toStrokes(from, o);
  const B = [];
  const tmap = [];
  for (let j = 0; j < targets.length; j++) {
    const st = targets[j] ? loopToStroke(targets[j], o) : null;
    if (st) {
      tmap.push(B.length);
      B.push(st);
    } else tmap.push(-1);
  }
  return buildPlan(A, B, o, { targets, tmap });
}

/**
 * A plan where every stroke of an icon draws on (`direction` 'in') or erases (`direction` 'out') along its own path,
 * in source order. The starts are spread over `drawStagger` of the time. There is no parent, so nothing hides.
 * @param {string|IconNode|Snapshot} src
 * @param {'in'|'out'} direction
 * @param {Partial<typeof DEFAULTS>} [opts]
 */
function planDraw(src, direction, opts = {}) {
  const o = { ...DEFAULTS, ...opts, matching: 'rules' };
  o._swFrom = o._swTo = srcWidth(src);
  o._capsFrom = o._capsTo = srcCaps(src);
  const S = toStrokes(src, o);
  const inn = direction === 'in';
  const slots = S.map((st, i) => buildDrawSlot(inn ? 'enter' : 'exit', st, i, o));
  const n = slots.length;
  const g = Math.min(0.95, Math.max(0, o.drawStagger));
  slots.forEach((sl, i) => {
    const w0 = n > 1 ? (g * i) / (n - 1) : 0;
    sl.window = [w0, w0 + 1 - g];
  });
  const coarse = S.map((s) => formFor(s, DEFAULTS.coarsePoints, s.closed ? FORM_LOOP : FORM_PASS));
  const none = [];
  return finishPlan(slots, inn ? none : S, inn ? S : none, inn ? [] : coarse, inn ? coarse : [], o, true, 0);
}

// The forced pairing of planToLoops.
function forcedMatching(A, B, coarseA, coarseB, K, o, forced) {
  const { targets, tmap } = forced;
  const raw = [];
  const wA = A.map(strokeWeight);
  const wB = B.map(strokeWeight);
  const mxA = wA.reduce((x, y) => Math.max(x, y), 0);
  const mxB = wB.reduce((x, y) => Math.max(x, y), 0);
  for (let i = 0; i < A.length; i++) {
    const t = i < targets.length ? targets[i] : null;
    const j = i < targets.length ? tmap[i] : -1;
    if (!t || j < 0) {
      raw.push({ kind: 'exit', fi: i, win: t && t.window });
      continue;
    }
    const a = A[i];
    const b = B[j];
    const ident = a.closed === b.closed && t.align === 'identity';
    const role = t.role || (wA[i] >= 0.5 * mxA || wB[j] >= 0.5 * mxB ? 'core' : 'part');
    if (ident) {
      raw.push({ kind: 'match', fi: i, ti: j, mode: a.closed ? MODE_LOOP : MODE_PASS, s: 0, dir: 1, role, ident: true, lod: !!t.lod, win: t.window });
    } else {
      const r = pairInfo(a, coarseA[i], b, coarseB[j], K, o);
      raw.push({ kind: 'match', fi: i, ti: j, mode: r.mode, s: r.s, dir: r.dir, role, ident: false, lod: !!t.lod, win: t.window });
    }
  }
  for (let k = A.length; k < targets.length; k++) {
    if (targets[k] && tmap[k] >= 0) raw.push({ kind: 'enter', ti: tmap[k], win: targets[k].window });
  }
  return raw;
}


// One tied slot (match, merge, split, collapse, grow) from a raw matching entry. Used by buildPlan and the object planner.
function makeTiedSlot(r, A, B, o, K, rules, turning, turnDeg, turnG, easing) {
  const a = r.fi >= 0 ? A[r.fi] : null;
  const b = r.ti >= 0 ? B[r.ti] : null;
  let M;
  let F;
  let T;
  let weight;
  let modeName;
  let flipPhi = null;
  let forceTheta = null;
  let isStatic = false;
  let bigTurn = false;
  let visF;
  let visT;
  let shapeRes = Infinity; // R6-1: relative shape distance of F and T (rotation, scale, translation)
  if (r.kind === 'collapse') {
    M = clampM(need(a, o), o);
    F = formFor(a, M, a.closed ? FORM_LOOP : FORM_PASS);
    T = centroidLoop(F);
    weight = a.length;
    modeName = 'collapse';
    visF = visT = F.vis;
  } else if (r.kind === 'grow') {
    M = clampM(need(b, o), o);
    T = formFor(b, M, b.closed ? FORM_LOOP : FORM_PASS);
    F = centroidLoop(T);
    weight = b.length;
    modeName = 'grow';
    visF = visT = T.vis;
  } else {
    M = clampM(Math.max(need(a, o), need(b, o)), o);
    const mode = r.mode;
    modeName = MODE_NAMES[mode];
    const f = pairForms(a, b, mode, M);
    let s0 = r.s;
    let d0 = r.dir;
    // R5 Rule 6: loop to loop, both loops get the same winding, so that the edge angles can interpolate.
    if (rules && o.interp === 'intrinsic' && o.rigid && !turning && mode === MODE_LOOP) {
      const ca = formFor(a, K, FORM_LOOP);
      const cb = formFor(b, K, FORM_LOOP);
      const want = areaSign(ca) === areaSign(cb) ? 1 : -1;
      if (d0 !== want) {
        scanCost(ca, cb, K, true, o.travelWeight, null, want);
        s0 = scanRes.s;
        d0 = want;
      }
    }
    // Default alignment (shape cost). A forced identity pairing keeps point k to point k.
    let res = r.ident ? finishAlign(f, M, 0, 1) : alignFine(f, M, s0, d0, K);
    // R3-1: the same shape at the same place is static.
    let dd = 0;
    for (let k = 0; k < 2 * M; k++) {
      const e = res.F[k] - res.T[k];
      dd += e * e;
    }
    stats(res.F, res.T, M);
    isStatic = dd / M < 1e-6 || (st.ST > 1e-9 && dd / st.ST < 1e-4);
    if (r.keep && !turning) isStatic = true; // R14: a kept piece does not move
    if (turning) isStatic = false;
    if (!turning && !isStatic && !r.ident && o.rigid && r.kind === 'match') {
      // Coarse search of the rotation fit and the reflection fit over all alignments.
      const fc = pairForms(a, b, mode, K);
      flipScan(fc.X, fc.Y, K, fc.ycl, fc.yIsF, null, 0);
      const rRot = flipRes.rRot;
      const rRef = flipRes.rRef;
      const theta0 = flipRes.theta;
      const rotS = flipRes.rotS;
      const rotDir = flipRes.rotDir;
      const refS = flipRes.s;
      const refDir = flipRes.dir;
      const spreadOk = Math.sqrt(flipRes.SF / K) >= o.minRigidSpread && Math.sqrt(flipRes.ST / K) >= o.minRigidSpread;
      if (spreadOk) shapeRes = rRot;
      let done = false;
      // R3-1: flip only when the rotation fit is clearly bad and the reflection fit is good.
      if (o.flip && spreadOk && rRot >= o.flipMinRotResidual && rRef < o.flipMaxResidual && rRef < o.flipAdvantage * rRot) {
        const shifts = f.ycl ? windowShifts(refS, M, K) : null;
        flipScan(f.X, f.Y, M, f.ycl, f.yIsF, shifts, refDir);
        if (Number.isFinite(flipRes.rRef)) {
          res = finishAlign(f, M, flipRes.s, flipRes.dir);
          stats(res.F, res.T, M);
          flipPhi = 0.5 * Math.atan2(st.B2, st.A2);
          done = true;
        }
      }
      // R4-3: a turned copy rotates as one piece, with no clamp (no r_lin condition).
      if (!done && spreadOk && Math.abs(theta0) > o.maxRotation * DEG && rRot < 1e-3 && rRef > 0.01) {
        const shifts = f.ycl ? windowShifts(rotS, M, K) : null;
        flipScan(f.X, f.Y, M, f.ycl, f.yIsF, shifts, rotDir);
        if (Number.isFinite(flipRes.rRot)) {
          res = finishAlign(f, M, flipRes.rotS, flipRes.rotDir);
          stats(res.F, res.T, M);
          forceTheta = Math.atan2(st.B, st.A);
          bigTurn = true;
        }
      }
    }
    F = res.F;
    T = res.T;
    // The from side was turned for the pairing. Turn it back: the slot starts at the real from icon.
    if (turning) F = turnPts(F, (360 - turnG) % 360);
    weight = Math.max(a.length, b.length);
    visF = F.vis;
    visT = T.vis;
  }
  const nseg = M - 1;
  const slot = {
    kind: r.kind,
    role: r.role || null,
    mode: modeName,
    fromIndex: r.fi,
    toIndex: r.ti,
    M,
    F,
    T,
    visF: visF || onesMask(nseg),
    visT: visT || onesMask(nseg),
    weight,
    fromOp: a ? a.opacity : 0,
    toOp: b ? b.opacity : 1,
    fill: !!(a || b).fill,
    sw0: a && a.sw !== undefined ? a.sw : null,
    sw1: b && b.sw !== undefined ? b.sw : null,
    ws0: a && a.ws0 !== undefined ? a.ws0 : 1,
    buf: new Float64Array(2 * M),
    static: isStatic,
    keep: !!(r.keep && !turning),
    bigTurn,
    chain: { from: a ? a.bridges : 0, to: b ? b.bridges : 0 },
    anchor: -1,
    anchorIndex: -1,
    window: [0, 1],
    _anchorSlot: null,
    closedF: !!(a && a.closed),
    closedT: !!(b && b.closed),
    lod: false,
    depth: 0.5,
  };
  if (r.win) slot._win = r.win;
  if (turning) prepareTurn(slot, (turnDeg * Math.PI) / 180);
  else {
    prepareSlotMotion(slot, o, flipPhi, forceTheta);
    // R5 Rule 6: a plain rigid slot bends like a wire.
    if (rules && o.interp === 'intrinsic' && slot.motion === 'rigid') prepareIntrinsic(slot);
  }
  // R4-1: open strokes draw on and erase inside a time window (legacy matching only). Short open strokes (length < 3) scale like closed ones.
  if (!rules && o.drawOpen && r.kind === 'grow' && !b.closed && b.length >= 3) {
    slot.motion = 'draw';
    slot.cum = cumLen(T, M);
    slot.L = slot.cum[M - 1];
  } else if (!rules && o.drawOpen && r.kind === 'collapse' && !a.closed && a.length >= 3) {
    slot.motion = 'erase';
    slot.cum = cumLen(F, M);
    slot.L = slot.cum[M - 1];
  }
  buildClasses(slot);
  // R6-1: a hard slot (its shape changes a lot) goes detail, simple shape, simple shape, detail.
  if (rules && o.simplify && o.rigid && r.kind === 'match' && !turning && !slot.static && !slot.flip && !slot.bigTurn) {
    const noBridge = slot.chain.from === 0 && slot.chain.to === 0 && !slot.runs[1] && !slot.runs[2];
    if (r.lod || (noBridge && Number.isFinite(shapeRes) && shapeRes > o.simplifyAbove)) prepareLod(slot, o, easing);
  }
  return slot;
}

function buildPlan(A, B, o, forced) {
  const rules = o.matching !== 'legacy';
  const K = oddUp(o.coarsePoints) === o.coarsePoints ? o.coarsePoints : oddUp(o.coarsePoints);
  const easing = resolveEasing(o.easing);
  const dA = strokeDepths(A);
  const dB = strokeDepths(B);
  const trA = A.tree || null; // R11-2: the attachment trees of the two icons (null for a snapshot)
  const trB = B.tree || null;

  // Coarse natural form per stroke: loop (closed) or pass (open).
  let coarseA = A.map((s) => formFor(s, K, s.closed ? FORM_LOOP : FORM_PASS));
  const coarseB = B.map((s) => formFor(s, K, s.closed ? FORM_LOOP : FORM_PASS));

  // R4-3: whole-icon turn. Plan from the turned copy of the from strokes, with the pairing forced.
  let turnDeg = 0;
  let turnPair = null;
  if (!forced && o.wholeTurn && o.rigid) {
    const wt = detectWholeTurn(A, B, coarseA, coarseB, K);
    if (wt) {
      turnDeg = wt.g === 270 ? -90 : wt.g;
      turnPair = wt.pair;
      A = A.map((s) => turnStroke(s, wt.g));
      coarseA = coarseA.map((L) => turnPts(L, wt.g));
    }
  }
  const turnG = turnDeg === 0 ? 0 : turnDeg < 0 ? 270 : turnDeg;
  const turning = turnPair !== null;

  const raw = forced
    ? forcedMatching(A, B, coarseA, coarseB, K, o, forced)
    : rules
      ? rulesMatching(A, B, coarseA, coarseB, K, o, turnPair)
      : legacyMatching(A, B, coarseA, coarseB, K, o, turnPair);

  // Build the polylines for each tied slot (match, merge, split, collapse, grow).
  const slots = [];
  const pending = [];
  for (const r of raw) {
    if (r.kind === 'exit' || r.kind === 'enter') {
      pending.push(r);
      continue;
    }
    slots.push(makeTiedSlot(r, A, B, o, K, rules, turning, turnDeg, turnG, easing));
  }

  // R5 Rule 4 and R11-3: untied parts ride on a point of their parent. Exits anchor on the old side, entries on the new side.
  // A part that touches its parent (R11-2) rides on the contact point on the parent slot, whatever that slot is doing, so the parent
  // slots come first (by level). A free part rides on a point of a core slot (round 10c).
  if (pending.length) {
    const cores = slots.filter((sl) => sl.role === 'core');
    const tied = slots.slice();
    const useTree = rules && !turning && !forced;
    const nodeOf = (r) => {
      const tr = r.kind === 'exit' ? trA : trB;
      return useTree && tr ? tr[r.kind === 'exit' ? r.fi : r.ti] || null : null;
    };
    // R11b-2: the level of the stroke in its tree, 0 for a core stroke that is itself an entry or an exit, so that a part never
    // looks for a parent slot that is built after it.
    const lvOf = (r) => {
      const nd = nodeOf(r);
      return nd && nd.level >= 0 ? nd.level : 1;
    };
    pending.sort((x, y) => lvOf(x) - lvOf(y)); // a stable sort: the parent slot exists when its part is built
    const slotOfStroke = (exitSide, idx) => slots.find((sl) => (exitSide ? sl.fromIndex : sl.toIndex) === idx);
    // R11b-5: the parts of a mirror group are twins together or not at all (a twin of one side only would move the two mirror parts apart).
    const twinOf = new Map();
    const twinGroups = new Map();
    if (o.twins !== false && rules && !turning && !forced) {
      for (const r of pending) {
        const exit = r.kind === 'exit';
        const nd = nodeOf(r);
        if (!nd || !(nd.pair >= 0) || (nd.attach && nd.attach !== 'free' && nd.parent >= 0)) continue;
        const st = exit ? A[r.fi] : B[r.ti];
        const tw0 = findTwin(st, exit ? 'F' : 'T', tied, A, B, o, { attach: 'free' });
        const key = (exit ? 'x' : 'e') + nd.pair;
        const g = twinGroups.get(key) || { n: 0, tw: 0 };
        g.n++;
        if (tw0) g.tw++;
        twinGroups.set(key, g);
      }
    }
    for (const r of pending) {
      const exit = r.kind === 'exit';
      const st = exit ? A[r.fi] : B[r.ti];
      const nd = nodeOf(r);
      let att = null;
      if (nd) {
        const par = nd.attach && nd.attach !== 'free' && nd.parent >= 0 ? slotOfStroke(exit, nd.parent) : null;
        att = par ? { attach: nd.attach, level: nd.level, contact: nd.contact, parentSlot: par, arch2: !!nd.arch2 } : { attach: 'free', level: nd.level > 0 ? nd.level : 1, contact: null, parentSlot: null };
        // R11e-1: a member of a mirror group that moves (enters or exits) while another member of its group stays (a tied slot),
        // and the two touch in the icon: the moving member attaches to the staying one at their contact.
        // R11f-1: only a member that is free in its icon tree (no parent it touches); a member with its own parent keeps it.
        // The tree can miss a parent that the stroke touches (a core stroke has none), so a touch with any stroke outside its mirror group also counts as a parent.
        const trF = exit ? trA : trB;
        const SSF = exit ? A : B;
        const idxF = exit ? r.fi : r.ti;
        let ownParent = nd.attach && nd.attach !== 'free' && nd.parent >= 0;
        if (!ownParent && nd.pair >= 0 && !nd.alone) for (let m = 0; m < trF.length && !ownParent; m++) if (m !== idxF && trF[m].pair !== nd.pair && touchesStroke(SSF[idxF], SSF[m])) ownParent = true;
        if (nd.pair >= 0 && !nd.alone && !ownParent) {
          const tr = exit ? trA : trB;
          const SS = exit ? A : B;
          const idx = exit ? r.fi : r.ti;
          for (let m = 0; m < tr.length; m++) {
            if (m === idx || tr[m].pair !== nd.pair) continue;
            const stay = tied.find((sl) => (exit ? sl.fromIndex : sl.toIndex) === m);
            if (!stay || !touchesStroke(SS[idx], SS[m])) continue;
            const tmp = {};
            attachNode(SS, tmp, idx, m, null, false);
            if (!tmp.contact) continue;
            att = { attach: tmp.attach, level: 1, contact: tmp.contact, parentSlot: stay, arch2: !!tmp.arch2 };
            break;
          }
        }
      }
      // R10-2: a part that has the same shape as a part that stays slides out from behind it (or in behind it). R11-5: free parts only.
      const tgk = nd && nd.pair >= 0 ? twinGroups.get((exit ? 'x' : 'e') + nd.pair) : null;
      const mixed = !!tgk && tgk.tw > 0 && tgk.tw < tgk.n;
      const tw = o.twins !== false && rules && !turning && !forced && !mixed ? findTwin(st, exit ? 'F' : 'T', tied, A, B, o, att) : null;
      const ps = tw ? buildTwinSlot(r.kind, st, exit ? r.fi : r.ti, tw, o, false) : buildPartSlot(r.kind, st, exit ? r.fi : r.ti, o, K, cores, undefined, att);
      if (tw) {
        ps._tw = tw;
        ps._twSt = st;
        ps._twIdx = exit ? r.fi : r.ti;
        ps._att = att || { attach: 'free', level: 1, contact: null, parentSlot: null };
        ps._lvl = ps._att.level;
        ps.attach = 'free';
        ps.level = 1;
      }
      ps.closedF = false;
      ps.closedT = false;
      ps.lod = false;
      ps.depth = 0.5;
      if (r.win) ps._win = r.win;
      ps._srcSt = st; // R11b-2: to build the part again when its parent slot is replaced
      ps._srcIdx = exit ? r.fi : r.ti;
      if (nd && nd.pair >= 0 && !nd.alone) ps._pairId = (exit ? 'x' : 'e') + nd.pair; // R11b-5: the mirror pair of the part
      slots.push(ps);
    }
  }

  // R5 Rule 5: windows. Exits first, then the main change, then entries.
  applyWindows(slots, o, rules);

  // R10b-2 (b) and R10b-3: a closed twin is checked once the windows are known.
  const planEasing = planEasingOf(o);
  for (let pass = 0; pass < 4 && checkClosedTwins(slots, A, B, o, K, planEasing); pass++) applyWindows(slots, o, rules);
  // R12-1: the balance of twin groups.
  if (balanceTwins(slots, o)) applyWindows(slots, o, rules);

  return finishPlan(slots, A, B, coarseA, coarseB, o, rules, turnDeg, dA, dB);
}

// R6-2: stroke index of the pairs, and the normalized depth of a slot.
function finishPlan(slots, A, B, coarseA, coarseB, o, rules, turnDeg, dA, dB, extra) {
  dA = dA || strokeDepths(A);
  dB = dB || strokeDepths(B);
  slots.sort((x, y) => y.weight - x.weight);
  const last = Math.max(1, slots.length - 1);
  slots.forEach((s, idx) => {
    s.rank = idx / last;
    s.key = idx;
  });
  for (const s of slots) if (s._anchorSlot) s.anchor = slots.indexOf(s._anchorSlot);
  for (const s of slots) if (s._twinSlot) s.twinOf = slots.indexOf(s._twinSlot);
  // R11b-3: the anchor of an attached part lies on an edge of its parent that is drawn at the edge of the window of the part.
  retargetAnchors(slots, o);
  // R6-2: slot depth. The mean of the normalized depth in the old icon and in the new icon. An exit or an entry is
  // just behind its anchor slot.
  for (const s of slots) {
    if (s.kind === 'exit' || s.kind === 'enter') continue;
    const v = [];
    if (s.fromIndex >= 0 && s.fromIndex < dA.length) v.push(dA[s.fromIndex]);
    if (s.toIndex >= 0 && s.toIndex < dB.length) v.push(dB[s.toIndex]);
    // R7-A: the loop of the middle step of a multi-stroke object takes the mean depth of the strokes of the object.
    if (s.fromIdxs) for (const i of s.fromIdxs) if (i < dA.length) v.push(dA[i]);
    if (s.toIdxs) for (const i of s.toIdxs) if (i < dB.length) v.push(dB[i]);
    s.depth = v.length ? v.reduce((x, y) => x + y, 0) / v.length : 0.5;
  }
  // R11-3: a part can ride on another part, so the parts are taken in the order of their chain of parents (a parent first).
  const chainDepth = (s) => {
    let d = 0;
    for (let c = s; c && (c.kind === 'exit' || c.kind === 'enter') && d < 16; c = c._anchorSlot) d++;
    return d;
  };
  const movers = [];
  for (let i = 0; i < slots.length; i++) if (slots[i].kind === 'exit' || slots[i].kind === 'enter') movers.push(i);
  movers.sort((x, y) => chainDepth(slots[x]) - chainDepth(slots[y]) || x - y);
  for (const i of movers) {
    const s = slots[i];
    if (s.anchor >= 0) s.depth = slots[s.anchor].depth - 0.001;
    else s.depth = s.kind === 'exit' ? (s.fromIndex >= 0 ? dA[s.fromIndex] : 0.5) : s.toIndex >= 0 ? dB[s.toIndex] : 0.5;
  }
  // R11-2: the attachment of every slot, for the tester and the site.
  for (const s of slots) {
    if (s.kind === 'exit' || s.kind === 'enter') {
      s.parentSlot = s.anchor;
      if (s.level === undefined) s.level = 1;
      if (s.attach === undefined) s.attach = 'free';
    } else {
      s.parentSlot = -1;
      s.level = 0;
      s.attach = null;
    }
  }
  // Evaluation order: a slot that rides on another slot comes after it.
  const order = [];
  for (let i = 0; i < slots.length; i++) if (slots[i].kind !== 'exit' && slots[i].kind !== 'enter') order.push(i);
  for (const i of movers) order.push(i);
  const curU = new Float64Array(slots.length);
  const curOp = new Float64Array(slots.length);
  const curTau = new Float64Array(slots.length);
  const curUm = new Float64Array(slots.length); // R13-2: the monotone progress

  const easing = resolveEasing(o.easing);
  const efx = easingInfo(easing);
  const fxArg = efx.fx ? efx : null;
  const stagger = Math.min(0.99, Math.max(0, o.stagger));

  // Linear progress of a slot inside its own window (with the stagger of core slots).
  function slotTau(slot, t) {
    const w0 = slot.window[0];
    const w1 = slot.window[1];
    let tl = w1 > w0 ? (t - w0) / (w1 - w0) : t >= w1 ? 1 : 0;
    tl = Math.min(1, Math.max(0, tl));
    let tau = tl;
    if (slot.kind !== 'exit' && slot.kind !== 'enter') {
      const delay = stagger * slot.rank;
      tau = Math.min(1, Math.max(0, (tl - delay) / (1 - stagger)));
    }
    return tau;
  }

  // R12-1: a 'split' twin takes the progress of its sibling; a 'center' sibling is shifted (applyBalance).
  const slotIdx = new Map(slots.map((sl, i) => [sl, i]));
  let refSmooth = false; // plan time only: evaluate with the smooth easing (the reference of calibrateAttach)
  const evalAll = (t) => {
    for (let k = 0; k < order.length; k++) {
      const i = order[k];
      const sl = slots[i];
      let tau = slotTau(sl, t);
      let u = tau <= 0 ? 0 : tau >= 1 ? 1 : (refSmooth ? easings.smooth : easing)(tau);
      let um = u;
      const fxA = refSmooth ? null : fxArg;
      if (fxA) um = tau <= 0 ? 0 : tau >= fxArg.tc ? 1 : Math.max(0, u);
      if (sl._split) {
        const si = slotIdx.get(sl._twinSlot);
        u = curU[si];
        um = curUm[si];
        tau = curTau[si];
      }
      curU[i] = u;
      curUm[i] = um;
      curTau[i] = tau;
      curOp[i] = evalSlot(sl, u, tau, um, fxA, t);
      if (fxA && sl.kind === 'enter' && tau >= fxArg.tc && tau < 1) popEnter(sl, 1 + (sl._g === undefined ? 1 : sl._g) * (sl._gs === undefined ? 1 : sl._gs) * efx.pop * (u - 1));
      if (fxA && (sl.kind === 'exit' || sl.kind === 'enter')) clampSlot(sl);
      if (sl._bal) applyBalance(sl, t, um);
    }
  };

  // R6-2: rest overlap (lazy). Two strokes that overlap at rest in the old icon or in the new icon never hide each other.
  let ovA = null;
  let ovB = null;
  const ensureOverlap = () => {
    if (ovA) return;
    ovA = restOverlap(A, coarseA);
    ovB = restOverlap(B, coarseB);
  };
  // R10-2: a closed twin goes behind its sibling. With occlusion 'none' only the twin pairs hide anything.
  const hasClosedTwin = slots.some((s) => s.motion === 'twin' && s.twinClosed);
  // R10c-2: the siblings of closed twins. While a sibling fades part of its outline (pieces), its entry `d` is open pieces
  // that a mask fill closes with chords, so the mask hides only part of the twin. These entries carry `maskD`, the whole
  // closed polyline of the slot, and the renderer fills that in the mask.
  const closedSibs = new Set(slots.filter((s) => s.motion === 'twin' && s.twinClosed).map((s) => s._twinSlot));
  const twinOnly = hasClosedTwin && o.occlusion === 'none';
  const isTwinPair = (i, j) => i >= 0 && j >= 0 && j < slots.length && slots[j].motion === 'twin' && !!slots[j].twinClosed && slots[j].twinOf === i;
  const baseOccludes = (i, j) => {
    if (i === j || i < 0 || j < 0 || i >= slots.length || j >= slots.length) return false;
    const si = slots[i];
    const sj = slots[j];
    if (!(si.depth > sj.depth)) return false;
    if (si.phase === 'morph' || sj.phase === 'morph') return false; // the loop of a multi-stroke object never hides or gets hidden
    ensureOverlap();
    if (si.fromIndex >= 0 && sj.fromIndex >= 0 && ovA[si.fromIndex * A.length + sj.fromIndex]) return false;
    if (si.toIndex >= 0 && sj.toIndex >= 0 && ovB[si.toIndex * B.length + sj.toIndex]) return false;
    return true;
  };
  const occludes = (i, j) => (twinOnly && !isTwinPair(i, j) ? false : baseOccludes(i, j));
  const twinOccludes = (i, j) => isTwinPair(i, j) && baseOccludes(i, j);
  // R10-2: the visible part of a closed twin in a snapshot: the runs of points outside the interior of the sibling.
  const clipTwin = (i, pieces) => {
    const s = slots[i];
    if (s.motion !== 'twin' || !s.twinClosed || !twinOccludes(s.twinOf, i)) return pieces;
    const sb = slots[s.twinOf].buf;
    const sm = slots[s.twinOf].M;
    const res = [];
    // R10b-5: cut each piece at the exact crossings with the sibling polygon; keep the runs outside, drop the runs inside.
    for (const P of pieces) {
      const n = P.length / 2;
      let run = null;
      let any = false;
      for (let k = 0; k + 1 < n; k++) {
        const ax = P[2 * k];
        const ay = P[2 * k + 1];
        const bx = P[2 * k + 2];
        const by = P[2 * k + 3];
        const dx = bx - ax;
        const dy = by - ay;
        const ts = [0];
        for (let a = 0, b = sm - 1; a < sm; b = a++) {
          const px = sb[2 * b];
          const py = sb[2 * b + 1];
          const ex = sb[2 * a] - px;
          const ey = sb[2 * a + 1] - py;
          const den = dx * ey - dy * ex;
          if (Math.abs(den) < 1e-12) continue;
          const wx = px - ax;
          const wy = py - ay;
          const tt = (wx * ey - wy * ex) / den;
          const ee = (wx * dy - wy * dx) / den;
          if (tt > 1e-9 && tt < 1 - 1e-9 && ee >= 0 && ee <= 1) ts.push(tt);
        }
        ts.push(1);
        ts.sort((x, y) => x - y);
        for (let m = 0; m + 1 < ts.length; m++) {
          const t0 = ts[m];
          const t1 = ts[m + 1];
          if (t1 - t0 < 1e-12) continue;
          const tm = 0.5 * (t0 + t1);
          const outside = !pip(sb, sm, ax + dx * tm, ay + dy * tm);
          if (outside) {
            if (!run) run = [ax + dx * t0, ay + dy * t0];
            run.push(ax + dx * t1, ay + dy * t1);
          } else {
            any = true;
            if (run && run.length >= 4) res.push(Float64Array.from(run));
            run = null;
          }
        }
      }
      if (run && run.length >= 4) res.push(any ? Float64Array.from(run) : P);
    }
    return res;
  };
  // A part that goes under its closed parent and is completely hidden there is not part of the picture (snapshot).
  const hiddenUnder = (i) => {
    const s = slots[i];
    if (s.motion !== 'under' || !s._anchorSlot || !occludes(s.anchor, i)) return false;
    const as = s._anchorSlot;
    const P = s.buf;
    const stride = Math.max(1, Math.floor((s.M - 1) / 12));
    for (let k = 0; k < s.M; k += stride) {
      const x = P[2 * k];
      const y = P[2 * k + 1];
      if (!pip(as.buf, as.M, x, y) || distToPoly(as.buf, as.M, x, y) < 1) return false;
    }
    return true;
  };
  const isClosedNow = (s) => {
    const B2 = s.buf;
    const n = s.M;
    if (dist(B2[0], B2[1], B2[2 * n - 2], B2[2 * n - 1]) > 0.5) return false;
    let len = 0;
    for (let k = 1; k < n && len < 1; k++) len += dist(B2[2 * k], B2[2 * k + 1], B2[2 * k - 2], B2[2 * k - 1]);
    return len >= 1;
  };
  const wsf = typeof o.widthScale === 'function' ? o.widthScale : null;
  // R7: a stroke that comes from a snapshot starts at the width scale of its snapshot loop and eases it to 1 over the first 30%.
  const widthOf = (s, t) => {
    let w = 1;
    if (wsf) {
      const x = wsf(s, t);
      w = Number.isFinite(x) ? Math.max(0, x) : 1;
    }
    if (s.ws0 !== undefined && s.ws0 !== 1) w *= s.ws0 + (1 - s.ws0) * smoothstep(0, 0.3, t);
    return w;
  };
  // R7-0: the stroke width of the plan is the width of the new icon. When the two icons differ, the width moves from one to the other.
  const swF = Number.isFinite(o._swFrom) ? o._swFrom : 2;
  const swT = Number.isFinite(o._swTo) ? o._swTo : 2;
  const swAt = (t) => (swF === swT ? swT : swF + (swT - swF) * smoothstep(0, 1, t));
  const swRatio = (t) => (swF === swT || !(swT > 0) ? 1 : swAt(t) / swT);
  // R9b: the caps and joins of the plan: the values of the two families when they agree, else round.
  const cf = o._capsFrom || { cap: 'round', join: 'round' };
  const ct = o._capsTo || { cap: 'round', join: 'round' };
  const planCap = cf.cap === ct.cap ? cf.cap : 'round';
  const planJoin = cf.join === ct.join ? cf.join : 'round';
  // R7b: the user width function of a slot at time t (effects), without the snapshot start width.
  const userW = (s, t) => {
    if (!wsf) return 1;
    const x = wsf(s, t);
    return Number.isFinite(x) ? Math.max(0, x) : 1;
  };
  // R7b: the style of a slot at time t. fill: the slot is drawn with a fill. strokeWidth: the absolute stroke width
  // (24-grid units; 0 = no stroke) of a slot with its own width, or null when the slot uses the plan width.
  const ownWidth = (s, t) => {
    if (s.sw0 == null && s.sw1 == null) return null;
    const wf = s.sw0 != null ? s.sw0 : swF * (s.ws0 !== undefined ? s.ws0 : 1);
    const wt = s.sw1 != null ? s.sw1 : swT;
    const w = (wf === wt ? wt : wf + (wt - wf) * smoothstep(0, 1, t)) * userW(s, t);
    return Math.abs(w - swT * widthOf(s, t) * swRatio(t)) < 1e-9 ? null : w;
  };
  const shown = (s, t) => !s.show || (t >= s.show[0] && (t < s.show[1] || s.show[1] >= 1));

  const norm = (t) => (t <= 0 || !(t === t) ? 0 : t >= 1 ? 1 : t);

  // R13-6: no point more than 4 units outside the 24-unit box. The follow-through (pose overshoot of a rigid slot, entry pop)
  // of a slot is scaled down by a gain slot._g (1 = full) when it would push ink farther. The gains are found at plan time.
  const hiddenAt = (t, i) => !shown(slots[i], t) || (slots[i].kind === 'exit' && curUm[i] >= 1) || (slots[i].kind === 'enter' && curUm[i] <= 0);
  if (fxArg) calibrateGain(slots, evalAll, fxArg, hiddenAt);
  if (fxArg) calibrateAttach(slots, evalAll, hiddenAt, (v) => (refSmooth = v));

  return {
    slots,
    turn: turnDeg,
    duration: 0,
    /** R7-0: the stroke width (24-grid units) of the new icon. The renderer draws `strokeWidth * entry.widthScale`. */
    strokeWidth: swT,
    /** R7-0: the stroke width of the old icon. When it differs, entries carry the ratio in `widthScale`. */
    strokeWidthFrom: swF,
    /** R9b: the stroke caps and joins of the plan (the families' values when both agree, else 'round'). Draw the plan with them. */
    linecap: planCap,
    linejoin: planJoin,
    /** R7-A: the objects of the plan (debug data): { id, kind, role, from, to } with stroke indices. */
    objects: (extra && extra.objects) || [],
    /**
     * R6-2: may slot i hide slot j? True when slot i is in front of slot j, and the two strokes do not overlap
     * at rest in the old icon or in the new icon. A frame entry also needs `occluder` (a closed polyline) to hide.
     * @param {number} i
     * @param {number} j
     * @returns {boolean}
     */
    occludes,
    /** R10-2: true when the plan has a closed twin (a part that slides out from behind its sibling). The renderer then draws masks for the twin pairs, also when the `occlusion` option is 'none'. */
    masks: hasClosedTwin,
    /** R10-2: may slot i hide slot j as a twin pair? True only for (sibling, closed twin) pairs. */
    twinOccludes,
    /**
     * Frame at linear time t in [0, 1]. Legacy matching: one entry per non-empty visibility class of each slot.
     * Rules matching: one entry per slot (opacity 1, widthScale 1). Moving bridges are subpaths of that entry.
     * @param {number} t
     * @returns {Entry[]}
     */
    frame(t) {
      t = norm(t);
      evalAll(t);
      const res = [];
      for (let i = 0; i < slots.length; i++) {
        const s = slots[i];
        const u = curUm[i]; // R13-2: show, hide, and fronts run on the monotone progress
        const op = curOp[i];
        if (rules) {
          // Hidden points (an exit at u = 1, an enter at u = 0) are not drawn. snapshot() drops them too.
          if ((s.kind === 'exit' && u >= 1) || (s.kind === 'enter' && u <= 0)) continue;
          if (!shown(s, t)) continue;
          const d = s.runs[1] || s.runs[2] ? piecesToD(slotPieces(s, u)) : s.runs[0] ? runsToD(s.buf, s.runs[0]) : '';
          if (d) {
            const e = { d, opacity: Math.min(1, Math.max(0, op)), widthScale: widthOf(s, t) * swRatio(t), key: i * 4, slot: i, depth: s.depth, occluder: isClosedNow(s) };
            if (s.fill) e.fill = true;
            if (e.occluder && (s.runs[1] || s.runs[2]) && closedSibs.has(s)) e.maskD = runsToD(s.buf, [0, s.M - 1]);
            const ow = ownWidth(s, t);
            if (ow !== null) e.strokeWidth = ow;
            res.push(e);
          }
          continue;
        }
        for (let c = 0; c < 3; c++) {
          const list = s.runs[c];
          if (!list) continue;
          const e = {
            d: runsToD(s.buf, list),
            opacity: Math.min(1, Math.max(0, op * classFactor(c, u))),
            widthScale: widthOf(s, t) * swRatio(t),
            key: i * 4 + c,
            slot: i,
            depth: s.depth,
            occluder: isClosedNow(s),
          };
          if (s.fill) e.fill = true;
          const ow = ownWidth(s, t);
          if (ow !== null) e.strokeWidth = ow;
          res.push(e);
        }
      }
      return res;
    },
    /**
     * The current picture, exact, to use as the start of a new morph. One loop per subpath of each frame
     * entry, with that entry's opacity and an all-visible mask.
     * @param {number} t
     * @returns {Snapshot}
     */
    snapshot(t) {
      t = norm(t);
      evalAll(t);
      const loops = [];
      for (let i = 0; i < slots.length; i++) {
        const s = slots[i];
        const u = curUm[i]; // R13-2: show, hide, and fronts run on the monotone progress
        const op = curOp[i];
        if (rules) {
          // A part that is reduced to a point under the body, or has not started, is not part of the picture.
          if ((s.kind === 'exit' && u >= 1) || (s.kind === 'enter' && u <= 0)) continue;
          if (!shown(s, t)) continue;
          const eo = Math.min(1, Math.max(0, op));
          if (eo < 0.02) continue;
          if (hiddenUnder(i)) continue;
          const pieces = clipTwin(i, s.runs[1] || s.runs[2] ? slotPieces(s, u) : (s.runs[0] || []).length ? slotPieces({ buf: s.buf, runs: [s.runs[0], null, null] }, u) : []);
          const ws = widthOf(s, t);
          const ow = ownWidth(s, t);
          for (const P of pieces) {
            const lp = { points: P, opacity: eo, vis: new Uint8Array(P.length / 2 - 1).fill(1), widthScale: ws };
            if (s.fill) lp.fill = true;
            if (ow !== null) lp.strokeWidth = ow;
            loops.push(lp);
          }
          continue;
        }
        for (let c = 0; c < 3; c++) {
          const list = s.runs[c];
          if (!list) continue;
          const eo = Math.min(1, Math.max(0, op * classFactor(c, u)));
          if (eo < 0.02) continue;
          for (let r = 0; r < list.length; r += 2) {
            const a = list[r];
            const b = list[r + 1];
            const lp = { points: s.buf.slice(2 * a, 2 * (b + 1)), opacity: eo, vis: new Uint8Array(b - a).fill(1), widthScale: widthOf(s, t) };
            if (s.fill) lp.fill = true;
            const ow = ownWidth(s, t);
            if (ow !== null) lp.strokeWidth = ow;
            loops.push(lp);
          }
        }
      }
      // strokeWidth: the current stroke width (24-grid units). The loop `widthScale` values are relative to it.
      return { kind: 'snapshot', loops, strokeWidth: swAt(t), linecap: planCap, linejoin: planJoin, family: { kind: 'stroke' } };
    },
  };
}

// ---------------------------------------------------------------------------
// Hooks for regions (R7-B). The fill planner in regions.js builds on these. See README, "Hooks for regions".
// ---------------------------------------------------------------------------

/**
 * Parse a path "d" string into closed contours in 24-grid units. Every subpath is closed (an open subpath is closed
 * with a straight segment). Curves and arcs are flattened to dense points. Give the family `viewBox` (a string such as
 * '0 0 256 256') or a number `scale` (24 / viewBox width) to scale the coordinates.
 * @param {string} d
 * @param {{viewBox?: string, scale?: number, cornerAngle?: number}} [opts]
 * @returns {(Stroke & {area: number})[]} closed strokes (`pts` are the unique points, the first is not repeated).
 *   `area` is the signed shoelace area (the sign tells the winding in the y-down system).
 */
function parseContours(d, opts = {}) {
  let k = Number.isFinite(opts.scale) ? opts.scale : 1;
  if (!Number.isFinite(opts.scale) && opts.viewBox) {
    const w = Number(viewBoxString(opts.viewBox).split(' ')[2]);
    if (w > 0) k = 24 / w;
  }
  const ca = opts.cornerAngle === undefined ? DEFAULTS.cornerAngle : opts.cornerAngle;
  const out = [];
  for (const s of parsePath(String(d || ''), ca, k, null)) {
    let c = s;
    if (!c.closed) {
      c = makeStroke(Array.from(s.pts), Array.from(s.corners), true, ca);
      if (!c || !c.closed) continue;
    }
    const n = c.pts.length / 2;
    if (n < 3) continue;
    c.area = polygonArea(c.pts, n);
    out.push(c);
  }
  return out;
}

/** Signed shoelace area of the closed polygon P[0..n-1] (x, y pairs). */
function polygonArea(P, n = P.length / 2) {
  let a = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += P[2 * i] * P[2 * j + 1] - P[2 * j] * P[2 * i + 1];
  }
  return a / 2;
}

/** Point in polygon (ray casting) for the closed polygon P[0..n-1]. */
function pointInPolygon(P, n, x, y) {
  return pip(P, n, x, y);
}

/**
 * Resample a closed contour (from parseContours) at M points (M odd, rounded up). The result has M points: M - 1
 * unique points spread at equal arc length with the corners kept, and the first point again at the end.
 * @param {Stroke} contour
 * @param {number} M
 * @returns {Float64Array}
 */
function resampleLoop(contour, M) {
  return formFor(contour, oddUp(M), FORM_LOOP);
}

/**
 * Align the closed loop Y to the closed loop X (both N points, the first repeated at the end). Tests every shift of
 * Y in both directions (or only `dir`: 1 or -1). The cost is mean |X - Y|^2 minus (1 - travel) times the squared mean
 * offset (travel 1: the plain mean squared distance; 0: the shape cost, translation ignored).
 * @param {Float64Array} X
 * @param {Float64Array} Y
 * @param {number} N
 * @param {{travel?: number, dir?: number}} [opts]
 * @returns {{cost: number, shift: number, dir: number, Y: Float64Array}} Y aligned to X (N points, first repeated at the end)
 */
function alignLoops(X, Y, N, opts = {}) {
  const tw = opts.travel === undefined ? 1 : opts.travel;
  const cost = scanCost(X, Y, N, true, tw, null, opts.dir || 0);
  const out = new Float64Array(2 * N);
  buildCand(Y, N, true, scanRes.s, scanRes.dir, out);
  return { cost, shift: scanRes.s, dir: scanRes.dir, Y: out };
}

/**
 * The rigid blend (rotation + scale + translation + residual, the default `interp`) of two aligned polylines F and T
 * (M points each). `eval(u, out)` writes the polyline at progress u in [0, 1] (u is already eased) and returns out.
 * `theta` is the rotation in radians (0 when it is above `maxRotation` or the shape is tiny) and `scale` the scale.
 * @param {Float64Array} F
 * @param {Float64Array} T
 * @param {number} M
 * @param {Partial<typeof DEFAULTS>} [opts]
 */
function makeRigidBlend(F, T, M, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const slot = { F, T, M, static: false };
  prepareSlotMotion(slot, o, null, null);
  const buf = new Float64Array(2 * M);
  return {
    theta: slot.theta,
    scale: slot.scale,
    motion: slot.motion,
    eval(u, out = buf) {
      if (u <= 0) out.set(F);
      else if (u >= 1) out.set(T);
      else if (slot.motion === 'rigid') rigidEval(slot, u, out);
      else for (let k = 0; k < 2 * M; k++) out[k] = F[k] + (T[k] - F[k]) * u;
      return out;
    },
  };
}

/** A superellipse (from fitSuperellipse or fitSuperellipsePoints) as a closed loop of M points (M - 1 unique at equal arc length, the first repeated). */
function sampleSuperellipse(fit, M) {
  const U = M - 1;
  const L = superellipseLoop(fit.cx, fit.cy, fit.a, fit.b, fit.phi, fit.n, U);
  const out = new Float64Array(2 * M);
  out.set(L);
  out[2 * U] = L[0];
  out[2 * U + 1] = L[1];
  return out;
}



const __regions = (function () {
// Morphicon regions (round 7, R7-B): the fill planner. Fill icons (Phosphor, Remix, Tabler filled) are 2D shapes.
// The unit of motion is a region (an outer contour plus its holes), not a stroke. No DOM. Round 7b: it imports
// resampleLoop (corners kept), makeRigidBlend, and parseContours from core.js (core.js does not import this file).
//
// Plan API (same as a core plan): frame(t), snapshot(t), slots, occludes, turn, plus `fill: true`, `occlusion: 'none'`,
// and `strokeWidth: 0`. A frame entry is { d, opacity (the layer opacity), widthScale: 1, key, slot, depth, occluder: false,
// fill: true, region: true, layer }. One entry per region per frame (the outer contour and its holes in one `d`).
// The `region: true` mark tells render.js a region entry (fill only) from a styled stroke entry (`fill: true` with a stroke).


const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

/** Knobs of the fill planner. Any key of `opts` replaces the default. */
const FILL_DEFAULTS = Object.freeze({
  sampleSpacing: 0.3, // target spacing between samples (24-grid units)
  minPoints: 17,
  maxPoints: 513,
  easing: 'easeInOutCubic',
  travelWeight: 0.5, // weight of the centroid travel in the pair cost D
  partGate: true,
  partSizeRatio: 2.5, // gate: the ratio of sqrt(area) of two parts is at most this
  partShapeMax: 0.35, // gate: the relative shape distance of two parts is at most this
  coreFraction: 0.5, // a region is core when its area is at least this fraction of the largest area
  fillSimplify: false, // R9 (owner vote of round 8: default false). true is round 8 (R8-2): a hard pair goes through its simple shape: gather [0, 0.3], shapes change [0.3, 0.7], detail [0.7, 1]. false: every pair morphs directly. Style toggles always morph directly
  simplifyAbove: 0.12, // a pair is hard when the relative shape distance of the outer contours is above this
  staging: true, // exits and closing holes first, then the main change, then entries and opening holes
  gather: Object.freeze([0, 0.3]), // small parts shrink into their edge point, holes close, a hard pair goes to its simple shape
  detail: Object.freeze([0.7, 1]), // small parts grow out of their edge point, holes open, a hard pair goes to its detail
  main: Object.freeze([0.2, 0.8]), // the outer morph of an easy pair (starts at 0 with no exits, ends at 1 with no entries)
});

const SPRING_ZETA = 0.75;
const SPRING_OMEGA = 10;
const SPRING_WD = SPRING_OMEGA * Math.sqrt(1 - SPRING_ZETA * SPRING_ZETA);
const EASE = {
  linear: (t) => t,
  easeInOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  easeOutCubic: (t) => 1 - Math.pow(1 - t, 3),
  spring: (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    const e = Math.exp(-SPRING_ZETA * SPRING_OMEGA * t);
    return 1 - e * (Math.cos(SPRING_WD * t) + ((SPRING_ZETA * SPRING_OMEGA) / SPRING_WD) * Math.sin(SPRING_WD * t));
  },
};
const ev = (x) => x + (x & 1); // the next even number (a loop of core's resampleLoop has an even number of unique points)
const getEase = (e) => (typeof e === 'function' ? e : EASE[e] || EASE.easeInOutCubic);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const wrapPi = (a) => {
  a = ((a + Math.PI) % TAU + TAU) % TAU - Math.PI;
  return a === -Math.PI ? Math.PI : a;
};
// Progress of t inside the window [w0, w1], clamped to [0, 1].
const prog = (t, w) => (w[1] > w[0] ? clamp01((t - w[0]) / (w[1] - w[0])) : t >= w[1] ? 1 : 0);

// ---------------------------------------------------------------------------
// Icon resolver (set by index.js: core's getIconInfo)
// ---------------------------------------------------------------------------

let resolver = null;
/** Give the planner a function `name => { nodes, family }` so that it can accept icon names. */
function setIconResolver(fn) {
  resolver = typeof fn === 'function' ? fn : null;
}

// ---------------------------------------------------------------------------
// Path parser: d string to flat closed polylines, scaled into the 24 grid
// ---------------------------------------------------------------------------

const NUMRE = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y;

/** Parse a path `d` into subpaths: arrays of x, y numbers (24-grid units, `scale` applied). Every subpath is treated as closed. */
function parsePath(d, scale = 1) {
  const subs = [];
  let cur = null;
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  let lcx = 0;
  let lcy = 0;
  let last = '';
  let i = 0;
  const n = d.length;
  const skip = () => {
    while (i < n) {
      const c = d.charCodeAt(i);
      if (c <= 32 || c === 44) i++;
      else break;
    }
  };
  const num = () => {
    skip();
    NUMRE.lastIndex = i;
    const m = NUMRE.exec(d);
    if (!m) throw new Error('regions: bad path data near ' + i);
    i = NUMRE.lastIndex;
    return parseFloat(m[0]);
  };
  const flag = () => {
    skip();
    return d[i++] === '1' ? 1 : 0;
  };
  const begin = () => {
    cur = [x, y];
    subs.push(cur);
  };
  const lineTo = (nx, ny) => {
    if (!cur) begin();
    cur.push(nx, ny);
    x = nx;
    y = ny;
  };
  const cubic = (x1, y1, x2, y2, x3, y3) => {
    if (!cur) begin();
    const x0 = x;
    const y0 = y;
    const len = Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2);
    const N = Math.max(3, Math.min(90, Math.ceil(len / 0.12)));
    for (let j = 1; j <= N; j++) {
      const t = j / N;
      const m = 1 - t;
      cur.push(
        m * m * m * x0 + 3 * m * m * t * x1 + 3 * m * t * t * x2 + t * t * t * x3,
        m * m * m * y0 + 3 * m * m * t * y1 + 3 * m * t * t * y2 + t * t * t * y3
      );
    }
    x = x3;
    y = y3;
    lcx = x2;
    lcy = y2;
  };
  const quad = (x1, y1, x2, y2) => {
    if (!cur) begin();
    const x0 = x;
    const y0 = y;
    const len = Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x1, y2 - y1);
    const N = Math.max(3, Math.min(90, Math.ceil(len / 0.12)));
    for (let j = 1; j <= N; j++) {
      const t = j / N;
      const m = 1 - t;
      cur.push(m * m * x0 + 2 * m * t * x1 + t * t * x2, m * m * y0 + 2 * m * t * y1 + t * t * y2);
    }
    x = x2;
    y = y2;
    lcx = x1;
    lcy = y1;
  };
  const arc = (rx, ry, phiDeg, fa, fs, nx, ny) => {
    rx = Math.abs(rx);
    ry = Math.abs(ry);
    if (rx < 1e-9 || ry < 1e-9 || (nx === x && ny === y)) {
      lineTo(nx, ny);
      return;
    }
    if (!cur) begin();
    const phi = phiDeg * DEG;
    const cp = Math.cos(phi);
    const sp = Math.sin(phi);
    const dx = (x - nx) / 2;
    const dy = (y - ny) / 2;
    const x1p = cp * dx + sp * dy;
    const y1p = -sp * dx + cp * dy;
    const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lam > 1) {
      const s = Math.sqrt(lam);
      rx *= s;
      ry *= s;
    }
    const nu = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
    const de = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    let co = de === 0 ? 0 : Math.sqrt(Math.max(0, nu / de));
    if (fa === fs) co = -co;
    const cxp = (co * rx * y1p) / ry;
    const cyp = (-co * ry * x1p) / rx;
    const cx = cp * cxp - sp * cyp + (x + nx) / 2;
    const cy = sp * cxp + cp * cyp + (y + ny) / 2;
    const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    const th1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let dth = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
    if (!fs && dth > 0) dth -= TAU;
    else if (fs && dth < 0) dth += TAU;
    const N = Math.min(200, Math.max(2, Math.ceil(Math.abs(dth) / (8 * DEG)), Math.ceil((Math.abs(dth) * Math.max(rx, ry)) / 0.25)));
    for (let j = 1; j < N; j++) {
      const th = th1 + (dth * j) / N;
      const ex = rx * Math.cos(th);
      const ey = ry * Math.sin(th);
      cur.push(cp * ex - sp * ey + cx, sp * ex + cp * ey + cy);
    }
    cur.push(nx, ny);
    x = nx;
    y = ny;
  };

  let cmd = '';
  for (;;) {
    skip();
    if (i >= n) break;
    const ch = d[i];
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')) {
      cmd = ch;
      i++;
    } else if (!cmd) throw new Error('regions: path data must start with a command.');
    const rel = cmd >= 'a';
    const c = cmd.toUpperCase();
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    if (c === 'Z') {
      if (cur) {
        x = sx;
        y = sy;
        cur = null;
      }
      last = 'Z';
      continue;
    }
    if (c === 'M') {
      x = ox + num() * scale;
      y = oy + num() * scale;
      sx = x;
      sy = y;
      begin();
      cmd = rel ? 'l' : 'L';
      last = 'M';
      continue;
    }
    if (c === 'L') lineTo(ox + num() * scale, oy + num() * scale);
    else if (c === 'H') lineTo(ox + num() * scale, y);
    else if (c === 'V') lineTo(x, oy + num() * scale);
    else if (c === 'C') {
      const x1 = ox + num() * scale;
      const y1 = oy + num() * scale;
      const x2 = ox + num() * scale;
      const y2 = oy + num() * scale;
      cubic(x1, y1, x2, y2, ox + num() * scale, oy + num() * scale);
    } else if (c === 'S') {
      const refl = last === 'C' || last === 'S';
      const x1 = refl ? 2 * x - lcx : x;
      const y1 = refl ? 2 * y - lcy : y;
      const x2 = ox + num() * scale;
      const y2 = oy + num() * scale;
      cubic(x1, y1, x2, y2, ox + num() * scale, oy + num() * scale);
    } else if (c === 'Q') {
      const x1 = ox + num() * scale;
      const y1 = oy + num() * scale;
      quad(x1, y1, ox + num() * scale, oy + num() * scale);
    } else if (c === 'T') {
      const refl = last === 'Q' || last === 'T';
      const x1 = refl ? 2 * x - lcx : x;
      const y1 = refl ? 2 * y - lcy : y;
      quad(x1, y1, ox + num() * scale, oy + num() * scale);
    } else if (c === 'A') {
      const rx = num() * scale;
      const ry = num() * scale;
      const phi = num();
      const fa = flag();
      const fs = flag();
      arc(rx, ry, phi, fa, fs, ox + num() * scale, oy + num() * scale);
    } else throw new Error('regions: unknown path command "' + cmd + '".');
    last = c;
  }
  return subs;
}

// ---------------------------------------------------------------------------
// Contours
// ---------------------------------------------------------------------------

function shoelace(p) {
  let a = 0;
  const n = p.length / 2;
  for (let i = 0; i < n; i++) {
    const j = i + 1 === n ? 0 : i + 1;
    a += p[2 * i] * p[2 * j + 1] - p[2 * j] * p[2 * i + 1];
  }
  return a / 2;
}

function perimeter(p) {
  let L = 0;
  const n = p.length / 2;
  for (let i = 0; i < n; i++) {
    const j = i + 1 === n ? 0 : i + 1;
    L += Math.hypot(p[2 * j] - p[2 * i], p[2 * j + 1] - p[2 * i + 1]);
  }
  return L;
}

// A contour: unique points (no repeated first point), signed area, forced points ("corners"), and caches.
// `all` forces every vertex (a snapshot loop: it is already a sampled shape).
function makeContour(raw, all) {
  const pts = [];
  for (let k = 0; k < raw.length; k += 2) {
    const l = pts.length;
    if (l === 0 || Math.hypot(raw[k] - pts[l - 2], raw[k + 1] - pts[l - 1]) > 1e-7) pts.push(raw[k], raw[k + 1]);
  }
  while (pts.length >= 4 && Math.hypot(pts[0] - pts[pts.length - 2], pts[1] - pts[pts.length - 1]) <= 1e-7) pts.length -= 2;
  if (pts.length < 6) return null;
  const P = Float64Array.from(pts);
  const area = shoelace(P);
  if (Math.abs(area) < 1e-6) return null;
  return finishContour(P, area, all);
}

function cornerFlags(P, all) {
  const n = P.length / 2;
  const f = new Uint8Array(n);
  if (all) return f.fill(1);
  for (let i = 0; i < n; i++) {
    const a = i === 0 ? n - 1 : i - 1;
    const b = i + 1 === n ? 0 : i + 1;
    const ux = P[2 * i] - P[2 * a];
    const uy = P[2 * i + 1] - P[2 * a + 1];
    const vx = P[2 * b] - P[2 * i];
    const vy = P[2 * b + 1] - P[2 * i + 1];
    const lu = Math.hypot(ux, uy);
    const lv = Math.hypot(vx, vy);
    if (lu < 1e-9 || lv < 1e-9) continue;
    if ((ux * vx + uy * vy) / (lu * lv) < 0.906) f[i] = 1; // turn above 25 degrees
  }
  return f;
}

function finishContour(P, area, all) {
  const n = P.length / 2;
  const corner = cornerFlags(P, all);
  let nc = 0;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    nc += corner[i];
    const x = P[2 * i];
    const y = P[2 * i + 1];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    cx += x;
    cy += y;
  }
  return { pts: P, n, area, corner, nForced: nc, snap: !!all, len: perimeter(P), bbox: [x0, y0, x1, y1], cx: cx / n, cy: cy / n };
}

// The same contour with the winding that we want (outer: positive area, hole: negative area).
function oriented(c, positive) {
  if ((c.area > 0) === positive) return c;
  const n = c.n;
  const P = new Float64Array(2 * n);
  const f = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const j = n - 1 - i;
    P[2 * i] = c.pts[2 * j];
    P[2 * i + 1] = c.pts[2 * j + 1];
    f[i] = c.corner[j];
  }
  return { ...c, pts: P, corner: f, area: -c.area };
}

function pip(px, py, P) {
  let inside = false;
  const n = P.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = P[2 * i];
    const yi = P[2 * i + 1];
    const xj = P[2 * j];
    const yj = P[2 * j + 1];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Does contour `big` contain contour `small`? (bounding box, then a vote of three vertices)
function contains(big, small) {
  const a = big.bbox;
  const b = small.bbox;
  if (b[0] < a[0] - 1e-9 || b[1] < a[1] - 1e-9 || b[2] > a[2] + 1e-9 || b[3] > a[3] + 1e-9) return false;
  let votes = 0;
  for (let q = 0; q < 3; q++) {
    const i = Math.floor((q * small.n) / 3);
    if (pip(small.pts[2 * i], small.pts[2 * i + 1], big.pts)) votes++;
  }
  return votes >= 2;
}

// Nesting of the contours of one path under the nonzero rule. A contour is a hole when the points just inside it
// have winding 0 and the points just outside have winding other than 0. Returns regions { outer, holes }.
function nestContours(cs) {
  const m = cs.length;
  const sign = cs.map((c) => (c.area > 0 ? 1 : -1));
  const cont = cs.map(() => []);
  for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) if (i !== j && contains(cs[j], cs[i])) cont[i].push(j);
  const kind = new Array(m);
  for (let i = 0; i < m; i++) {
    let w = 0;
    for (const j of cont[i]) w += sign[j];
    kind[i] = w === 0 ? 'outer' : w + sign[i] === 0 ? 'hole' : 'skip';
  }
  const regions = [];
  const at = new Map();
  for (let i = 0; i < m; i++) {
    if (kind[i] !== 'outer') continue;
    const r = { outer: oriented(cs[i], true), holes: [] };
    at.set(i, r);
    regions.push(r);
  }
  for (let i = 0; i < m; i++) {
    if (kind[i] !== 'hole') continue;
    let best = -1;
    for (const j of cont[i]) if (kind[j] === 'outer' && (best < 0 || Math.abs(cs[j].area) < Math.abs(cs[best].area))) best = j;
    if (best >= 0) at.get(best).holes.push(oriented(cs[i], false));
  }
  return regions;
}

// Is every vertex of a within tol of the outline of b?
function vertsNear(a, b, tol) {
  const n = a.n;
  for (let i = 0; i < n; i++) if (segDist(b.pts, a.pts[2 * i], a.pts[2 * i + 1]) > tol) return false;
  return true;
}

// Round 7b: a contour that repeats an earlier contour of the same path (same points within 0.01, either direction) is dropped.
// Two copies would cancel (or double) under the nonzero rule and break the nesting.
function dropDuplicates(cs) {
  const out = [];
  for (const c of cs) {
    const dup = out.some(
      (k) =>
        Math.abs(Math.abs(k.area) - Math.abs(c.area)) <= 0.01 * Math.max(1, Math.abs(k.area)) &&
        Math.abs(k.bbox[0] - c.bbox[0]) <= 0.01 &&
        Math.abs(k.bbox[1] - c.bbox[1]) <= 0.01 &&
        Math.abs(k.bbox[2] - c.bbox[2]) <= 0.01 &&
        Math.abs(k.bbox[3] - c.bbox[3]) <= 0.01 &&
        vertsNear(c, k, 0.01) &&
        vertsNear(k, c, 0.01)
    );
    if (!dup) out.push(c);
  }
  return out;
}

function makeRegion(outer, holes, opacity) {
  let area = Math.abs(outer.area);
  for (const h of holes) area -= Math.abs(h.area);
  return { outer, holes, opacity, area: Math.max(area, 1e-6), cx: outer.cx, cy: outer.cy, bbox: outer.bbox };
}

// ---------------------------------------------------------------------------
// Sources: an icon (name, { nodes, family }) or a fill snapshot, as layers of regions
// ---------------------------------------------------------------------------

const parseCache = new WeakMap();

function groupLayers(regions) {
  const by = new Map();
  for (const r of regions) {
    if (!by.has(r.opacity)) by.set(r.opacity, []);
    by.get(r.opacity).push(r);
  }
  return [...by.keys()].sort((a, b) => a - b).map((op) => ({ opacity: op, regions: by.get(op) }));
}

function infoToLayers(info) {
  const nodes = info.nodes;
  const fam = info.family || {};
  const vb = String(fam.viewBox || '0 0 24 24').trim().split(/[\s,]+/).map(Number);
  const scale = 24 / (vb[2] || 24);
  const hit = parseCache.get(nodes);
  if (hit && hit.scale === scale) return hit.layers;
  const regions = [];
  for (const node of nodes) {
    if (!node || node[0] !== 'path' || !node[1] || typeof node[1].d !== 'string') continue;
    const op = node[1].opacity == null ? 1 : Math.min(1, Math.max(0, parseFloat(node[1].opacity)));
    const cs = dropDuplicates(parsePath(node[1].d, scale).map((s) => makeContour(s, false)).filter(Boolean));
    for (const r of nestContours(cs)) regions.push(makeRegion(r.outer, r.holes, op));
  }
  const layers = groupLayers(regions);
  parseCache.set(nodes, { scale, layers });
  return layers;
}

function snapshotToLayers(snap) {
  const regions = [];
  for (const r of snap.regions || []) {
    const outer = makeContour(r.outer, true);
    if (!outer) continue;
    const holes = (r.holes || []).map((h) => makeContour(h, true)).filter(Boolean);
    regions.push(makeRegion(oriented(outer, true), holes.map((h) => oriented(h, false)), r.opacity == null ? 1 : r.opacity));
  }
  return groupLayers(regions);
}

/** The layers of regions of an icon name, an icon info `{ nodes, family }`, an icon node, or a fill snapshot. */
function regionsOf(src) {
  if (typeof src === 'string') {
    if (!resolver) throw new Error('regions: no icon resolver. Call setIconResolver(getIconInfo) first.');
    const info = resolver(src);
    if (!info) throw new Error('regions: unknown icon "' + src + '".');
    return infoToLayers(info);
  }
  if (Array.isArray(src)) return infoToLayers({ nodes: src, family: {} });
  if (src && src.kind === 'snapshot') {
    if (!src.fill && !(src.family && src.family.kind === 'fill')) throw new Error('regions: a stroke snapshot is not a fill source.');
    return snapshotToLayers(src);
  }
  if (src && src.nodes) return infoToLayers(src);
  throw new Error('regions: from and to must be an icon name, an icon info, or a fill snapshot.');
}

// ---------------------------------------------------------------------------
// Resampling (closed contours, forced points kept)
// ---------------------------------------------------------------------------

function needPoints(c, o) {
  const base = Math.ceil(c.len / o.sampleSpacing);
  return c.snap ? Math.max(base, c.n) : base + c.nForced + 4;
}

function pairM(a, b, o) {
  let lo = o.minPoints;
  let hi = o.maxPoints;
  const forced = Math.max(a.nForced, b.nForced, 0) + (a.snap || b.snap ? 0 : 2);
  hi = Math.max(hi, forced);
  let M = Math.max(needPoints(a, o), needPoints(b, o), lo);
  M = Math.min(hi, M);
  return ev(Math.max(M, forced, 4));
}

// Core's closed contour for one of ours (cached). Corners: the 25 degree rule for an icon, every turn for a snapshot loop.
function coreOf(c) {
  if (c._core !== undefined) return c._core;
  let d = 'M' + c.pts[0] + ' ' + c.pts[1];
  for (let i = 1; i < c.n; i++) d += 'L' + c.pts[2 * i] + ' ' + c.pts[2 * i + 1];
  d += 'Z';
  let k = null;
  try {
    k = parseContours(d, { scale: 1, cornerAngle: c.snap ? 0.01 : 25 })[0] || null;
  } catch (e) {
    k = null;
  }
  c._core = k;
  return k;
}

// U unique points (U rounded up to even) of a closed contour, corners kept (core's resampleLoop; the repeated end point is cut).
function resampleU(c, U) {
  U = ev(U);
  const k = coreOf(c);
  if (!k) return resample(c, U);
  return resampleLoop(k, U + 1).slice(0, 2 * U);
}

function cumLen(P) {
  const n = P.length / 2;
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const j = i + 1 === n ? 0 : i + 1;
    cum[i + 1] = cum[i] + Math.hypot(P[2 * j] - P[2 * i], P[2 * j + 1] - P[2 * i + 1]);
  }
  return cum;
}

// Sample the closed contour c at M points. Every forced point stays, and the others spread over the arcs between
// forced points in proportion to arc length. The first output point is the first forced point (or point 0).
function resample(c, M, useCorners = true) {
  const P = c.pts;
  const n = c.n;
  const cum = c._cum || (c._cum = cumLen(P));
  const L = cum[n];
  const C = [];
  if (useCorners) for (let i = 0; i < n; i++) if (c.corner[i]) C.push(i);
  if (C.length === 0) C.push(0);
  if (M < C.length) M = C.length;
  const K = C.length;
  const la = new Float64Array(K);
  for (let k = 0; k < K; k++) {
    const a = C[k];
    const b = k + 1 < K ? C[k + 1] : C[0] + n;
    const sa = cum[a];
    const sb = b >= n ? cum[b - n] + L : cum[b];
    la[k] = K === 1 ? L : sb - sa;
  }
  // counts: one for each arc, and the rest in proportion to the arc length (largest remainder)
  const cnt = new Int32Array(K).fill(1);
  let rest = M - K;
  if (rest > 0) {
    const share = new Float64Array(K);
    let given = 0;
    for (let k = 0; k < K; k++) {
      share[k] = (rest * la[k]) / L;
      const f = Math.floor(share[k]);
      cnt[k] += f;
      given += f;
      share[k] -= f;
    }
    let left = rest - given;
    const order = Array.from({ length: K }, (_, k) => k).sort((p, q) => share[q] - share[p]);
    for (let q = 0; left > 0; q = (q + 1) % K, left--) cnt[order[q]]++;
  }
  const out = new Float64Array(2 * M);
  let w = 0;
  for (let k = 0; k < K; k++) {
    const sa = cum[C[k]];
    for (let j = 0; j < cnt[k]; j++) {
      let s = sa + (la[k] * j) / cnt[k];
      if (j === 0) {
        out[2 * w] = P[2 * C[k]];
        out[2 * w + 1] = P[2 * C[k] + 1];
        w++;
        continue;
      }
      s = s % L;
      // binary search for the edge
      let lo = 0;
      let hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (cum[mid] <= s) lo = mid;
        else hi = mid - 1;
      }
      const e = cum[lo + 1] - cum[lo];
      const t = e > 0 ? (s - cum[lo]) / e : 0;
      const nx = lo + 1 === n ? 0 : lo + 1;
      out[2 * w] = P[2 * lo] + (P[2 * nx] - P[2 * lo]) * t;
      out[2 * w + 1] = P[2 * lo + 1] + (P[2 * nx + 1] - P[2 * lo + 1]) * t;
      w++;
    }
  }
  return out;
}

const COARSE = 48;
const coarseOf = (c) => c._coarse || (c._coarse = resample(c, COARSE, false));

// ---------------------------------------------------------------------------
// Alignment and assignment
// ---------------------------------------------------------------------------

// The cyclic shift s that minimizes the mean squared distance of U[k] to V[(k + s) % M] (on a subsample for large M).
function bestShift(U, V, M) {
  const step = M > 96 ? Math.ceil(M / 48) : 1;
  let best = Infinity;
  let bs = 0;
  let cnt = 0;
  for (let k = 0; k < M; k += step) cnt++;
  for (let s = 0; s < M; s++) {
    let c = 0;
    for (let k = 0; k < M && c < best; k += step) {
      let j = k + s;
      if (j >= M) j -= M;
      const dx = U[2 * k] - V[2 * j];
      const dy = U[2 * k + 1] - V[2 * j + 1];
      c += dx * dx + dy * dy;
    }
    if (c < best) {
      best = c;
      bs = s;
    }
  }
  return { s: bs, cost: best / cnt };
}

const BIG = 1e9;

// Minimum-cost assignment of rows to columns (rectangular). cost[i][j] >= BIG means not allowed. Returns rowToCol.
function hungarian(cost, nr, nc) {
  const res = new Array(nr).fill(-1);
  if (nr === 0 || nc === 0) return res;
  const tr = nr > nc;
  const n = tr ? nc : nr;
  const m = tr ? nr : nc;
  const a = (i, j) => (tr ? cost[j - 1][i - 1] : cost[i - 1][j - 1]);
  const u = new Float64Array(n + 1);
  const v = new Float64Array(m + 1);
  const p = new Int32Array(m + 1);
  const way = new Int32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Float64Array(m + 1).fill(Infinity);
    const used = new Uint8Array(m + 1);
    do {
      used[j0] = 1;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = a(i0, j) - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }
  for (let j = 1; j <= m; j++) {
    if (!p[j]) continue;
    const i = p[j] - 1;
    const jj = j - 1;
    const r = tr ? jj : i;
    const c = tr ? i : jj;
    if (cost[r][c] < BIG) res[r] = c;
  }
  return res;
}

// ---------------------------------------------------------------------------
// Frames and proxies (superellipse on the principal axes)
// ---------------------------------------------------------------------------

function fitFrame(c) {
  const P = resample(c, 64, false);
  const n = 64;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += P[2 * i];
    my += P[2 * i + 1];
  }
  mx /= n;
  my /= n;
  let cxx = 0;
  let cyy = 0;
  let cxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = P[2 * i] - mx;
    const dy = P[2 * i + 1] - my;
    cxx += dx * dx;
    cyy += dy * dy;
    cxy += dx * dy;
  }
  const th = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
  const co = Math.cos(th);
  const si = Math.sin(th);
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (let i = 0; i < c.n; i++) {
    const dx = c.pts[2 * i] - mx;
    const dy = c.pts[2 * i + 1] - my;
    const u = dx * co + dy * si;
    const v = -dx * si + dy * co;
    if (u < u0) u0 = u;
    if (u > u1) u1 = u;
    if (v < v0) v0 = v;
    if (v > v1) v1 = v;
  }
  const cu = (u0 + u1) / 2;
  const cv = (v0 + v1) / 2;
  const a = Math.max(0.05, (u1 - u0) / 2);
  const b = Math.max(0.05, (v1 - v0) / 2);
  return { cx: mx + cu * co - cv * si, cy: my + cu * si + cv * co, th, a, b, n: Math.abs(c.area) / (4 * a * b) >= 0.88 ? 4 : 2 };
}

const frameOf = (c) => c._frame || (c._frame = fitFrame(c));

function toUnit(P, f) {
  const n = P.length / 2;
  const out = new Float64Array(2 * n);
  const co = Math.cos(f.th);
  const si = Math.sin(f.th);
  for (let i = 0; i < n; i++) {
    const dx = P[2 * i] - f.cx;
    const dy = P[2 * i + 1] - f.cy;
    out[2 * i] = (dx * co + dy * si) / f.a;
    out[2 * i + 1] = (-dx * si + dy * co) / f.b;
  }
  return out;
}

// World points of unit coordinates U in frame f, written to `out` (a new array when null).
function toWorld(U, f, out) {
  const n = U.length / 2;
  const R = out || new Float64Array(2 * n);
  const co = Math.cos(f.th);
  const si = Math.sin(f.th);
  for (let i = 0; i < n; i++) {
    const x = f.a * U[2 * i];
    const y = f.b * U[2 * i + 1];
    R[2 * i] = f.cx + x * co - y * si;
    R[2 * i + 1] = f.cy + x * si + y * co;
  }
  return R;
}

// The frame between fa (at 0) and fb (at 1). fb.th is already unwrapped next to fa.th.
function lerpFrame(fa, fb, u) {
  return {
    cx: fa.cx + (fb.cx - fa.cx) * u,
    cy: fa.cy + (fb.cy - fa.cy) * u,
    th: fa.th + (fb.th - fa.th) * u,
    a: fa.a + (fb.a - fa.a) * u,
    b: fa.b + (fb.b - fa.b) * u,
    n: fa.n + (fb.n - fa.n) * u,
  };
}

// A point of the superellipse of frame f at parameter t.
function superPoint(f, t, out, k) {
  const c = Math.cos(t);
  const s = Math.sin(t);
  const e = 2 / f.n;
  const x = f.a * Math.sign(c) * Math.pow(Math.abs(c), e);
  const y = f.b * Math.sign(s) * Math.pow(Math.abs(s), e);
  const co = Math.cos(f.th);
  const si = Math.sin(f.th);
  out[2 * k] = f.cx + x * co - y * si;
  out[2 * k + 1] = f.cy + x * si + y * co;
}

function superSamples(f, M) {
  const out = new Float64Array(2 * M);
  for (let k = 0; k < M; k++) superPoint(f, (TAU * k) / M, out, k);
  return out;
}

// B seen from the frame of A: the best of the four 90-degree variants of B's frame (cost: residual plus a small turn
// penalty). Returns { fb (variant frame, th unwrapped next to fa.th), rms (relative shape distance), turn }.
function analyzePair(A, B) {
  const cache = A._pairs || (A._pairs = new Map());
  const hit = cache.get(B);
  if (hit) return hit;
  const fa = frameOf(A);
  const fb = frameOf(B);
  const uA = toUnit(coarseOf(A), fa);
  let best = null;
  for (let k = 0; k < 4; k++) {
    const d = wrapPi(fb.th + (k * Math.PI) / 2 - fa.th);
    const f = { cx: fb.cx, cy: fb.cy, th: fa.th + d, a: k % 2 ? fb.b : fb.a, b: k % 2 ? fb.a : fb.b, n: fb.n };
    const uB = toUnit(coarseOf(B), f);
    const rms = Math.sqrt(bestShift(uA, uB, COARSE).cost);
    const score = rms + 0.08 * Math.abs(d);
    if (!best || score < best.score) best = { fb: f, rms, score };
  }
  cache.set(B, best);
  return best;
}

// ---------------------------------------------------------------------------
// Matching of regions (Rules 1 to 5 on regions)
// ---------------------------------------------------------------------------

function sameOutline(a, b) {
  if (Math.abs(a.cx - b.cx) > 0.05 || Math.abs(a.cy - b.cy) > 0.05) return false;
  if (Math.abs(Math.abs(a.area) - Math.abs(b.area)) > 0.02 * Math.max(Math.abs(a.area), 1)) return false;
  return bestShift(coarseOf(a), coarseOf(b), COARSE).cost < 1e-4;
}

function isStaticPair(a, b) {
  if (!sameOutline(a.outer, b.outer) || a.holes.length !== b.holes.length) return false;
  const used = new Set();
  for (const h of a.holes) {
    const j = b.holes.findIndex((g, q) => !used.has(q) && sameOutline(h, g));
    if (j < 0) return false;
    used.add(j);
  }
  return true;
}

function pairCost(a, b, o) {
  const p = analyzePair(a.outer, b.outer);
  const ra = Math.sqrt(frameOf(a.outer).a * frameOf(a.outer).b);
  const travel = Math.hypot(a.cx - b.cx, a.cy - b.cy);
  return p.rms * ra + o.travelWeight * travel + 0.5 * Math.abs(Math.sqrt(a.area) - Math.sqrt(b.area));
}

// One layer pair (the layers have the same opacity). Returns ops: static, match, exit, enter.
function matchLayer(LA, LB, o, maxA, maxB, rank, opacity) {
  const ops = [];
  let ra = LA ? LA.regions.slice() : [];
  let rb = LB ? LB.regions.slice() : [];
  // static strokes: the same region in the same place
  for (let i = ra.length - 1; i >= 0; i--) {
    const j = rb.findIndex((b) => isStaticPair(ra[i], b));
    if (j >= 0) {
      ops.push({ type: 'static', A: ra[i], B: rb[j], rank, opacity });
      ra.splice(i, 1);
      rb.splice(j, 1);
    }
  }
  const coreA = ra.filter((r) => r.area >= o.coreFraction * maxA);
  const coreB = rb.filter((r) => r.area >= o.coreFraction * maxB);
  const tiedA = new Set();
  const tiedB = new Set();
  if (coreA.length && coreB.length) {
    const cost = coreA.map((a) => coreB.map((b) => pairCost(a, b, o)));
    const asg = hungarian(cost, coreA.length, coreB.length);
    asg.forEach((j, i) => {
      if (j < 0) return;
      ops.push({ type: 'match', A: coreA[i], B: coreB[j], role: 'core', rank, opacity });
      tiedA.add(coreA[i]);
      tiedB.add(coreB[j]);
    });
  }
  // parts (and the core regions left over) tie only when they are alike
  const pa = ra.filter((r) => !tiedA.has(r));
  const pb = rb.filter((r) => !tiedB.has(r));
  if (pa.length && pb.length) {
    const cost = pa.map((a) =>
      pb.map((b) => {
        if (o.partGate) {
          const sr = Math.sqrt(a.area / b.area);
          if (Math.max(sr, 1 / sr) > o.partSizeRatio) return BIG;
          if (analyzePair(a.outer, b.outer).rms > o.partShapeMax) return BIG;
        }
        return pairCost(a, b, o);
      })
    );
    const asg = hungarian(cost, pa.length, pb.length);
    asg.forEach((j, i) => {
      if (j < 0) return;
      ops.push({ type: 'match', A: pa[i], B: pb[j], role: 'part', rank, opacity });
      tiedA.add(pa[i]);
      tiedB.add(pb[j]);
    });
  }
  for (const a of ra) if (!tiedA.has(a)) ops.push({ type: 'exit', A: a, rank, opacity });
  for (const b of rb) if (!tiedB.has(b)) ops.push({ type: 'enter', B: b, rank, opacity });
  return ops;
}

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

const fmt = (x) => {
  const r = Math.round(x * 10000) / 10000; // round 7b: 4 decimals for fills (thin icons)
  return r === 0 ? '0' : String(r);
};

function loopD(P) {
  const n = P.length / 2;
  let s = 'M' + fmt(P[0]) + ' ' + fmt(P[1]);
  for (let i = 1; i < n; i++) s += 'L' + fmt(P[2 * i]) + ' ' + fmt(P[2 * i + 1]);
  return s + 'Z';
}

const loopsToD = (loops) => loops.map(loopD).join('');

// Distance from a point to the outline of the polygon P (never 0 inside).
function segDist(P, px, py) {
  const n = P.length / 2;
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const j = i + 1 === n ? 0 : i + 1;
    const ax = P[2 * i];
    const ay = P[2 * i + 1];
    const bx = P[2 * j] - ax;
    const by = P[2 * j + 1] - ay;
    const l2 = bx * bx + by * by;
    const t = l2 > 0 ? clamp01(((px - ax) * bx + (py - ay) * by) / l2) : 0;
    const d = Math.hypot(px - ax - bx * t, py - ay - by * t);
    if (d < best) best = d;
  }
  return best;
}

// Distance from a point to a polygon (0 inside).
function polyDistance(px, py, P) {
  return pip(px, py, P) ? 0 : segDist(P, px, py);
}

function inRegion(r, x, y) {
  if (!pip(x, y, r.outer.pts)) return false;
  for (const h of r.holes) if (pip(x, y, h.pts)) return false;
  return true;
}

// The nearest core region of the region r (r itself is skipped), or null.
function nearestCore(r, anchors) {
  let best = null;
  let bd = Infinity;
  for (const c of anchors) {
    if (c === r) continue;
    const d = polyDistance(r.cx, r.cy, c.outer.pts);
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return best;
}

// Pull the points of a hole that left the outer contour back toward the frame center (a hole must stay inside).
function keepInside(H, outer, cx, cy) {
  const n = H.length / 2;
  for (let k = 0; k < n; k++) {
    let x = H[2 * k];
    let y = H[2 * k + 1];
    if (pip(x, y, outer)) continue;
    const x0 = x;
    const y0 = y;
    let f = 1;
    let ok = false;
    for (let it = 0; it < 10; it++) {
      f *= 0.85;
      x = cx + (x0 - cx) * f;
      y = cy + (y0 - cy) * f;
      if (pip(x, y, outer)) {
        ok = true;
        break;
      }
    }
    if (!ok) {
      x = cx;
      y = cy;
    }
    H[2 * k] = x;
    H[2 * k + 1] = y;
  }
}

function unitCentroid(U) {
  let x = 0;
  let y = 0;
  const n = U.length / 2;
  for (let i = 0; i < n; i++) {
    x += U[2 * i];
    y += U[2 * i + 1];
  }
  return [x / n, y / n];
}

const unitArea = (U) => Math.abs(shoelace(U));

// Holes of a tied region pair, carried by the frames fa and fb. Matched holes morph as loops, the others close or open.
function planHoles(A, B, fa, fb, o, noMatch) {
  const ha = A.holes;
  const hb = B.holes;
  const UA = ha.map((h) => toUnit(coarseOf(h), fa));
  const UB = hb.map((h) => toUnit(coarseOf(h), fb));
  const cost = UA.map((ua, i) =>
    UB.map((ub, j) => {
      const [x0, y0] = unitCentroid(ua);
      const [x1, y1] = unitCentroid(ub);
      const d = Math.hypot(x0 - x1, y0 - y1);
      const ar = unitArea(ua) / Math.max(unitArea(ub), 1e-9);
      if (d > 0.5 || ar > 6 || ar < 1 / 6) return BIG;
      return d + 0.5 * Math.sqrt(bestShift(ua, ub, COARSE).cost);
    })
  );
  const asg = !noMatch && ha.length && hb.length ? hungarian(cost, ha.length, hb.length) : ha.map(() => -1);
  const out = [];
  const usedB = new Set();
  // `U*` are unit points (frames fa and fb, for the proxy path); the world points are `H*` and `P` (for the direct path).
  ha.forEach((h, i) => {
    const j = asg[i];
    if (j >= 0) {
      usedB.add(j);
      const Mh = pairM(h, hb[j], o);
      const wa = resampleU(h, Mh);
      const wb = resampleU(hb[j], Mh);
      const a = toUnit(wa, fa);
      const b = toUnit(wb, fb);
      const sh = bestShift(a, b, Mh).s;
      const ba = new Float64Array(2 * Mh);
      const wbs = new Float64Array(2 * Mh);
      for (let k = 0; k < Mh; k++) {
        const q = (k + sh) % Mh;
        ba[2 * k] = b[2 * q];
        ba[2 * k + 1] = b[2 * q + 1];
        wbs[2 * k] = wb[2 * q];
        wbs[2 * k + 1] = wb[2 * q + 1];
      }
      out.push({ type: 'match', UA: a, UB: ba, HA: wa, HB: wbs, M: Mh });
    } else {
      const Mh = ev(Math.min(o.maxPoints, Math.max(needPoints(h, o), o.minPoints, h.nForced + 2)));
      const P = resampleU(h, Mh);
      const U = toUnit(P, fa);
      out.push({ type: 'close', U, c: unitCentroid(U), P, wc: unitCentroid(P) });
    }
  });
  hb.forEach((h, j) => {
    if (usedB.has(j)) return;
    const Mh = ev(Math.min(o.maxPoints, Math.max(needPoints(h, o), o.minPoints, h.nForced + 2)));
    const P = resampleU(h, Mh);
    const U = toUnit(P, fb);
    out.push({ type: 'open', U, c: unitCentroid(U), P, wc: unitCentroid(P) });
  });
  return out;
}

// Radius of a closed point set around (cx, cy) by angle: the largest radius in each of K bins (empty bins interpolated).
function polarProfile(P, cx, cy, K = 72) {
  const r = new Float64Array(K).fill(-1);
  const n = P.length / 2;
  for (let i = 0; i < n; i++) {
    const dx = P[2 * i] - cx;
    const dy = P[2 * i + 1] - cy;
    const b = Math.min(K - 1, Math.floor(((Math.atan2(dy, dx) + Math.PI) / TAU) * K));
    const rad = Math.hypot(dx, dy);
    if (rad > r[b]) r[b] = rad;
  }
  for (let b = 0; b < K; b++) {
    if (r[b] >= 0) continue;
    let p = 1;
    while (r[(b - p + K) % K] < 0 && p < K) p++;
    let q = 1;
    while (r[(b + q) % K] < 0 && q < K) q++;
    const lo = r[(b - p + K) % K];
    const hi = r[(b + q) % K];
    r[b] = lo >= 0 && hi >= 0 ? lo + ((hi - lo) * p) / (p + q) : Math.max(lo, hi, 0);
  }
  for (let b = 0; b < K; b++) if (r[b] < 0) r[b] = 0;
  return r;
}

function profileAt(r, a) {
  const K = r.length;
  const x = ((a + Math.PI) / TAU) * K - 0.5;
  const i0 = Math.floor(x);
  const f = x - i0;
  return r[((i0 % K) + K) % K] * (1 - f) + r[(((i0 + 1) % K) + K) % K] * f;
}

// Unit points U of frame f, moved along rays from the frame center by (profile `to` / profile `from`) at their angle.
// A hole follows the shrink of its outer contour toward the simple shape (and back).
function warpUnit(U, f, from, to) {
  const W = toWorld(U, f, null);
  for (let i = 0; i < W.length; i += 2) {
    const dx = W[i] - f.cx;
    const dy = W[i + 1] - f.cy;
    const a = Math.atan2(dy, dx);
    const rho = Math.min(2, Math.max(0.05, profileAt(to, a) / Math.max(profileAt(from, a), 1e-6)));
    W[i] = f.cx + dx * rho;
    W[i + 1] = f.cy + dy * rho;
  }
  return toUnit(W, f);
}

// A closed loop of n unique points with the first point repeated at the end (the form of makeRigidBlend).
function loopOf(P, n) {
  const L = new Float64Array(2 * n + 2);
  L.set(P.subarray(0, 2 * n));
  L[2 * n] = P[0];
  L[2 * n + 1] = P[1];
  return L;
}

// The similarity (rotation, uniform scale, translation) that takes the point set P to the point set Q (n points each,
// least squares). apply(T, x, y) maps a point.
function simFit(P, Q, n) {
  let px = 0;
  let py = 0;
  let qx = 0;
  let qy = 0;
  for (let i = 0; i < n; i++) {
    px += P[2 * i];
    py += P[2 * i + 1];
    qx += Q[2 * i];
    qy += Q[2 * i + 1];
  }
  px /= n;
  py /= n;
  qx /= n;
  qy /= n;
  let re = 0;
  let im = 0;
  let sq = 0;
  for (let i = 0; i < n; i++) {
    const ax = P[2 * i] - px;
    const ay = P[2 * i + 1] - py;
    const bx = Q[2 * i] - qx;
    const by = Q[2 * i + 1] - qy;
    re += ax * bx + ay * by;
    im += ax * by - ay * bx;
    sq += ax * ax + ay * ay;
  }
  if (sq < 1e-12) return { ar: 1, ai: 0, px, py, qx, qy };
  return { ar: re / sq, ai: im / sq, px, py, qx, qy };
}

function simApply(T, x, y) {
  const dx = x - T.px;
  const dy = y - T.py;
  return [T.qx + T.ar * dx - T.ai * dy, T.qy + T.ai * dx + T.ar * dy];
}

// A tied pair: the outer contour morphs as a loop (direct, or through its simple shape when hard). Round 7b: the direct
// path blends the outer contour and every matched hole with core's rigid blend (rotation, scale, translation, residual);
// a closing or opening hole rides on the similarity that carries the outer contour. The proxy path keeps the frames.
function buildTied(op, o, win, ease, forceHard, gather, detail) {
  const A = op.A;
  const B = op.B;
  const ca = A.outer;
  const cb = B.outer;
  const pa = analyzePair(ca, cb);
  const fa = frameOf(ca);
  const fb = pa.fb;
  const M = pairM(ca, cb, o);
  const ptsA = resampleU(ca, M);
  const ptsB = resampleU(cb, M);
  const uA = toUnit(ptsA, fa);
  const uB0 = toUnit(ptsB, fb);
  const S = bestShift(uA, uB0, M).s;
  const uB = new Float64Array(2 * M);
  const ptsBal = new Float64Array(2 * M);
  for (let k = 0; k < M; k++) {
    const q = (k + S) % M;
    uB[2 * k] = uB0[2 * q];
    uB[2 * k + 1] = uB0[2 * q + 1];
    ptsBal[2 * k] = ptsB[2 * q];
    ptsBal[2 * k + 1] = ptsB[2 * q + 1];
  }
  const hard = forceHard != null ? forceHard : o.fillSimplify && pa.rms > o.simplifyAbove;
  // R8-2: a hard pair uses the whole plan: gather [0, 0.3], shapes change [0.3, 0.7], detail [0.7, 1]. An explicit window (effects) stays.
  if (hard && !op.window) win = [0, 1];
  const holes = planHoles(A, B, fa, fb, o, !!op.detailHoles);
  let proxy = null;
  let blend = null;
  if (hard) {
    // proxy alignment: P_A to A, P_B to B (both through the same point pairing k)
    const PA = superSamples(fa, M);
    const PB = superSamples(fb, M);
    const sPA = bestShift(ptsA, PA, M).s;
    const sPB = bestShift(ptsBal, PB, M).s;
    let dJ = sPB - sPA;
    if (dJ > M / 2) dJ -= M;
    else if (dJ <= -M / 2) dJ += M;
    const PAal = new Float64Array(2 * M);
    const PBal = new Float64Array(2 * M);
    for (let k = 0; k < M; k++) {
      const qa = (k + sPA) % M;
      const qb = (k + sPB) % M;
      PAal[2 * k] = PA[2 * qa];
      PAal[2 * k + 1] = PA[2 * qa + 1];
      PBal[2 * k] = PB[2 * qb];
      PBal[2 * k + 1] = PB[2 * qb + 1];
    }
    proxy = { PAal, PBal, sPA, dJ };
    const profA = polarProfile(ptsA, fa.cx, fa.cy);
    const profPA = polarProfile(PAal, fa.cx, fa.cy);
    const profB = polarProfile(ptsBal, fb.cx, fb.cy);
    const profPB = polarProfile(PBal, fb.cx, fb.cy);
    for (const h of holes) {
      if (h.type === 'match') {
        h.WA = warpUnit(h.UA, fa, profA, profPA);
        h.WB = warpUnit(h.UB, fb, profB, profPB);
      } else if (h.type === 'close') h.W = warpUnit(h.U, fa, profA, profPA);
      else h.W = warpUnit(h.U, fb, profB, profPB);
    }
  } else {
    blend = makeRigidBlend(loopOf(ptsA, M), loopOf(ptsBal, M), M + 1);
    for (const h of holes) if (h.type === 'match') h.blend = makeRigidBlend(loopOf(h.HA, h.M), loopOf(h.HB, h.M), h.M + 1);
  }
  const split = gather[1] < detail[0] ? [gather[1], detail[0]] : [0.3, 0.7];
  const lerpArr = (X, Y, w, out) => {
    for (let i = 0; i < out.length; i++) out[i] = X[i] + (Y[i] - X[i]) * w;
    return out;
  };
  const bufU = new Float64Array(2 * M);
  const bufO = new Float64Array(2 * M + 2);
  const canonA = [A.outer.pts, ...A.holes.map((h) => h.pts)];
  const canonB = [B.outer.pts, ...B.holes.map((h) => h.pts)];

  function evalAt(t) {
    let outer;
    let fr;
    let um = 0;
    let st = 0; // hard pair: the step (1, 2, or 3) and its eased progress
    let e1 = 0;
    let e3 = 0;
    if (!hard) {
      um = ease(prog(t, win));
      fr = lerpFrame(fa, fb, um);
      outer = Float64Array.from(blend.eval(um, bufO).subarray(0, 2 * M));
    } else {
      const tl = prog(t, win);
      e1 = ease(clamp01(tl / split[0]));
      const e2 = ease(clamp01((tl - split[0]) / (split[1] - split[0])));
      e3 = ease(clamp01((tl - split[1]) / (1 - split[1])));
      um = e2;
      fr = lerpFrame(fa, fb, e2);
      if (tl < split[0]) {
        st = 1;
        outer = lerpArr(ptsA, proxy.PAal, e1, new Float64Array(2 * M));
      } else if (tl > split[1]) {
        st = 3;
        outer = lerpArr(proxy.PBal, ptsBal, e3, new Float64Array(2 * M));
      } else {
        st = 2;
        outer = new Float64Array(2 * M);
        for (let k = 0; k < M; k++) superPoint(fr, (TAU * (k + proxy.sPA + e2 * proxy.dJ)) / M, outer, k);
      }
    }
    const loops = [outer];
    let simA = null; // direct path: the similarity from A's outer contour (closing holes) or B's (opening holes) to the current one
    let simB = null;
    for (const h of holes) {
      let H;
      if (h.type === 'match') {
        if (!hard) H = Float64Array.from(h.blend.eval(um, new Float64Array(2 * h.M + 2)).subarray(0, 2 * h.M));
        else {
          if (st === 1) H = lerpArr(h.UA, h.WA, e1, new Float64Array(h.UA.length));
          else if (st === 3) H = lerpArr(h.WB, h.UB, e3, new Float64Array(h.UA.length));
          else H = lerpArr(h.WA, h.WB, um, new Float64Array(h.UA.length));
          H = toWorld(H, fr, null);
        }
      } else {
        const s = h.type === 'close' ? 1 - ease(prog(t, gather)) : ease(prog(t, detail));
        if (s <= 0.004) continue;
        if (!hard) {
          let T;
          if (h.type === 'close') T = simA || (simA = simFit(ptsA, outer, M));
          else T = simB || (simB = simFit(ptsBal, outer, M));
          const n = h.P.length / 2;
          H = new Float64Array(2 * n);
          for (let i = 0; i < n; i++) {
            const x = h.wc[0] + (h.P[2 * i] - h.wc[0]) * s;
            const y = h.wc[1] + (h.P[2 * i + 1] - h.wc[1]) * s;
            const q = simApply(T, x, y);
            H[2 * i] = q[0];
            H[2 * i + 1] = q[1];
          }
        } else {
          let U = h.U;
          if (h.type === 'close') U = st === 1 ? lerpArr(h.U, h.W, e1, new Float64Array(h.U.length)) : h.W;
          else U = st === 3 ? lerpArr(h.W, h.U, e3, new Float64Array(h.U.length)) : h.W;
          const V = new Float64Array(U.length);
          for (let i = 0; i < V.length; i += 2) {
            V[i] = h.c[0] + (U[i] - h.c[0]) * s;
            V[i + 1] = h.c[1] + (U[i + 1] - h.c[1]) * s;
          }
          H = toWorld(V, fr, null);
        }
      }
      keepInside(H, outer, fr.cx, fr.cy);
      loops.push(H);
    }
    return loops;
  }

  // The last evaluation is kept: the anchors of untied regions ask for the carried point at the same time.
  let lastT = NaN;
  let lastLoops = null;
  const evalRaw = (t) => {
    if (t !== lastT) {
      lastLoops = evalAt(t);
      lastT = t;
    }
    return lastLoops;
  };
  return {
    // Exact ends: at 0 and 1 the canonical contours of the icon (the same as a static slot), not the resampling of the pair.
    eval: (t) => (t <= 0 ? canonA : t >= 1 ? canonB : evalRaw(t)),
    // Where the point (x, y) of the unmoved region A (side 'A') or B (side 'B') is at time t: the point rides on the body.
    carry(t, x, y, side) {
      const outer = evalRaw(t < 0 ? 0 : t > 1 ? 1 : t)[0];
      const T = simFit(side === 'A' ? ptsA : ptsBal, outer, M);
      return simApply(T, x, y);
    },
    lod: !!hard,
    holes,
    window: win,
    split,
  };
}

// A small untied region (R8-2): it shrinks into the point of its outline that is nearest to the container (exit), or
// grows out of that point (enter), by scaling about it. The region never slides or flies in. `pivot(t)` is the carried
// world point of the container at time t: the pivot rides on the container while the container changes.
function buildPivot(r, p0, pivot, enter, win, ease) {
  const arrs = [r.outer, ...r.holes].map((c) => c.pts);
  return {
    eval(t) {
      const tau = prog(t, win);
      const e = ease(tau);
      const s = enter ? e : 1 - e;
      if (s <= 0.004 || (!enter && tau >= 1) || (enter && tau <= 0)) return null;
      if (s >= 1) return arrs;
      const q = pivot(t);
      return arrs.map((P) => {
        const Q = new Float64Array(P.length);
        for (let i = 0; i < P.length; i += 2) {
          Q[i] = q[0] + (P[i] - p0[0]) * s;
          Q[i + 1] = q[1] + (P[i + 1] - p0[1]) * s;
        }
        return Q;
      });
    },
  };
}

// The region of a simple shape (a superellipse of frame f, no holes). Its frame is f itself.
function proxyRegion(f, opacity) {
  const c = makeContour(superSamples(f, 96), false);
  const o = oriented(c, true);
  o._frame = f;
  return makeRegion(o, [], opacity);
}

// R8-2: an untied core-size region merges into the nearest new proxy (exit) or splits out of the nearest old proxy
// (enter). A merging region runs the proxy path to the shape of the target proxy and is drawn up to t = split[1] (0.7),
// where it lies exactly on that proxy. A splitting region is drawn from t = split[0] (0.3), where it lies on the old
// proxy. Nothing fades. The target pair has no matched holes, so the copy on top of it never covers a hole.
function buildMerge(op, target, enter, o, gather, detail, ease) {
  const f = enter ? frameOf(target.A.outer) : analyzePair(target.A.outer, target.B.outer).fb;
  const proxy = proxyRegion(f, op.opacity);
  const pair = enter ? { A: proxy, B: op.B, rank: op.rank, opacity: op.opacity } : { A: op.A, B: proxy, rank: op.rank, opacity: op.opacity };
  const impl = buildTied(pair, o, [0, 1], ease, true, gather, detail);
  const lo = enter ? impl.split[0] : -Infinity;
  const hi = enter ? Infinity : impl.split[1];
  return {
    eval: (t) => (t < lo || t > hi ? null : impl.eval(t)),
    holes: impl.holes,
    window: enter ? [impl.split[0], 1] : [0, impl.split[1]],
  };
}

function buildStatic(op) {
  const arrs = [op.A.outer.pts, ...op.A.holes.map((h) => h.pts)];
  return { eval: () => arrs };
}

// ---------------------------------------------------------------------------
// Plan assembly
// ---------------------------------------------------------------------------

function assemble(ops, o, extra = {}) {
  const ease = getEase(o.easing);
  const stage = o.staging;
  const gather = stage ? o.gather : [0, 1];
  const detail = stage ? o.detail : [0, 1];
  const hasExit = ops.some((p) => p.type === 'exit');
  const hasEnter = ops.some((p) => p.type === 'enter');
  const main = stage ? [hasExit ? o.main[0] : 0, hasEnter ? o.main[1] : 1] : [0, 1];
  // anchor candidates for exits (side A) and enters (side B): the regions that stay (static or tied), core first
  const side = (key) => {
    const list = ops.filter((p) => p.type === 'static' || p.type === 'match').map((p) => p[key]);
    const mx = list.reduce((m, r) => Math.max(m, r.area), 0);
    const core = list.filter((r) => r.area >= o.coreFraction * mx);
    return core.length ? core : list;
  };
  const anchorsA = side('A');
  const anchorsB = side('B');
  // R8-2: an untied region of core size merges into (exit) or splits out of (enter) the nearest tied core pair of its layer.
  const maxOf = (key) => ops.reduce((m, p) => (p[key] ? Math.max(m, p[key].area) : m), 0);
  const mxA = maxOf('A');
  const mxB = maxOf('B');
  const cores = ops.filter((p) => p.type === 'match' && p.role === 'core');
  for (const op of ops) {
    if (o._toggle || (op.type !== 'exit' && op.type !== 'enter') || !cores.length) continue;
    const enter = op.type === 'enter';
    const r = enter ? op.B : op.A;
    if (r.area < o.coreFraction * (enter ? mxB : mxA)) continue;
    let best = null;
    let bd = Infinity;
    for (const c of cores) {
      if (c.rank !== op.rank) continue;
      const q = enter ? c.A : c.B;
      const d = Math.hypot(q.cx - r.cx, q.cy - r.cy);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    if (!best) continue;
    op.merge = best;
    best.forceHard = true;
    best.detailHoles = true;
  }
  // the planner of each tied or static region: an anchor rides with it
  const implOfA = new Map();
  const implOfB = new Map();
  const preImpl = new Map();
  for (const op of ops) {
    if (op.type === 'static') preImpl.set(op, buildStatic(op));
    else if (op.type === 'match') preImpl.set(op, buildTied(op, o, op.window || main, ease, op.forceHard, gather, detail));
    else continue;
    implOfA.set(op.A, preImpl.get(op));
    implOfB.set(op.B, preImpl.get(op));
  }
  // The pivot of a small untied region r: its point nearest to the outline of the nearest core region c. It is carried by c.
  const pivotFn = (r, anchors, implOf, sideKey) => {
    const c = nearestCore(r, anchors);
    if (!c) {
      const p = [r.cx, r.cy];
      return { p0: p, at: () => p };
    }
    const P = r.outer.pts;
    let p0 = [P[0], P[1]];
    let bd = Infinity;
    for (let i = 0; i < P.length; i += 2) {
      let d = segDist(c.outer.pts, P[i], P[i + 1]);
      for (const h of c.holes) d = Math.min(d, segDist(h.pts, P[i], P[i + 1]));
      if (d < bd) {
        bd = d;
        p0 = [P[i], P[i + 1]];
      }
    }
    const impl = implOf.get(c);
    return { p0, at: impl && impl.carry ? (t) => impl.carry(t, p0[0], p0[1], sideKey) : () => p0 };
  };
  const slots = [];
  for (const op of ops) {
    let impl;
    let win;
    let motion;
    let lod = false;
    let weight;
    if (op.type === 'static') {
      impl = preImpl.get(op);
      win = [0, 1];
      motion = 'static';
      weight = op.A.area;
    } else if (op.type === 'match') {
      impl = preImpl.get(op);
      win = impl.window || op.window || main;
      lod = impl.lod;
      motion = lod ? 'proxy' : 'frame';
      weight = op.A.area;
    } else if (op.merge) {
      const enter = op.type === 'enter';
      impl = buildMerge(op, op.merge, enter, o, gather, detail, ease);
      win = impl.window;
      lod = true;
      motion = enter ? 'split' : 'merge';
      weight = (enter ? op.B : op.A).area;
    } else if (op.type === 'exit') {
      win = gather;
      const pv = pivotFn(op.A, anchorsA, implOfA, 'A');
      impl = buildPivot(op.A, pv.p0, pv.at, false, win, ease);
      motion = 'pivot';
      weight = op.A.area;
    } else {
      win = detail;
      const pv = pivotFn(op.B, anchorsB, implOfB, 'B');
      impl = buildPivot(op.B, pv.p0, pv.at, true, win, ease);
      motion = 'pivot';
      weight = op.B.area;
    }
    slots.push({
      role: op.type === 'match' ? op.role : op.type === 'static' ? 'static' : 'part',
      kind: op.type === 'match' || op.type === 'static' ? 'match' : op.type,
      anchor: -1,
      anchorIndex: -1,
      window: win.slice(),
      motion,
      lod,
      depth: op.rank,
      layer: op.rank,
      opacity: op.opacity,
      weight,
      static: op.type === 'static',
      holes: impl.holes ? impl.holes.map((h) => h.type) : [],
      _impl: impl,
      _order: op.type === 'exit' ? 1 : op.type === 'enter' ? 2 : 0,
    });
  }
  slots.sort((a, b) => a.layer - b.layer || a._order - b._order || b.weight - a.weight);
  const post = extra.post || null;
  const norm = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);

  function evalSlot(i, t) {
    let loops = slots[i]._impl.eval(t);
    if (!loops) return null;
    if (post) {
      const f = post(t);
      if (f <= 0.004) return null;
      if (f < 1) {
        loops = loops.map((P) => {
          const Q = new Float64Array(P.length);
          for (let k = 0; k < P.length; k += 2) {
            Q[k] = 12 + (P[k] - 12) * f;
            Q[k + 1] = 12 + (P[k + 1] - 12) * f;
          }
          return Q;
        });
      }
    }
    return loops;
  }

  return {
    fill: true,
    slots,
    turn: 0,
    duration: 0,
    occlusion: 'none',
    strokeWidth: 0,
    occludes: () => false,
    frame(t) {
      t = norm(t);
      const res = [];
      for (let i = 0; i < slots.length; i++) {
        const loops = evalSlot(i, t);
        if (!loops) continue;
        res.push({
          d: loopsToD(loops),
          opacity: slots[i].opacity,
          widthScale: 1,
          key: i * 4,
          slot: i,
          depth: slots[i].layer,
          occluder: false,
          fill: true,
          region: true,
          layer: slots[i].layer,
        });
      }
      return res;
    },
    snapshot(t) {
      t = norm(t);
      const regions = [];
      const loops = [];
      for (let i = 0; i < slots.length; i++) {
        const ls = evalSlot(i, t);
        if (!ls) continue;
        const copy = ls.map((P) => Float64Array.from(P));
        regions.push({ outer: copy[0], holes: copy.slice(1), opacity: slots[i].opacity, layer: slots[i].layer });
        for (const P of copy) {
          const Q = new Float64Array(P.length + 2);
          Q.set(P);
          Q[P.length] = P[0];
          Q[P.length + 1] = P[1];
          loops.push({ points: Q, opacity: slots[i].opacity, vis: new Uint8Array(P.length / 2).fill(1) });
        }
      }
      // Round 7b: the snapshot says that it is a fill picture. `kind` stays 'snapshot' (core finds a snapshot by it);
      // `family.kind` is what core's getKind reads, and `fill` is the flag that regions.js and the cross planner read.
      return { kind: 'snapshot', fill: true, snapshotKind: 'fill', family: { kind: 'fill' }, regions, loops };
    },
  };
}

function maxArea(layers) {
  let m = 0;
  for (const L of layers) for (const r of L.regions) if (r.area > m) m = r.area;
  return m;
}

// The same rule as core's isStyleToggle(a, b) (core.js did not export it when this was written): two icon names `<id>:<name>`
// with the same name after the prefix and two different sets of one family (the part of the id before the first '-').
function isStyleToggleLocal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const i = a.indexOf(':');
  const j = b.indexOf(':');
  if (i < 0 || j < 0 || a.slice(i + 1) !== b.slice(j + 1)) return false;
  const ia = a.slice(0, i);
  const ib = b.slice(0, j);
  return ia !== ib && ia.split('-')[0] === ib.split('-')[0];
}

/**
 * Plan a morph between two fill icons (R7-B). `from` and `to` are an icon name (needs setIconResolver), an icon info
 * `{ nodes, family }`, or a fill snapshot. Layers (by opacity) morph one by one. Inside a layer: static regions stay;
 * core regions tie by an optimal assignment; parts tie when alike. Round 8: a small untied region shrinks into (or grows
 * out of) the point of its outline nearest to its container, by scaling about that point; an untied core-size region
 * merges into (or splits out of) the nearest proxy. Tied outer contours morph as loops, directly or (hard pairs, default)
 * through their simple shape. A hole with no partner closes in [0, 0.3], a new hole opens in [0.7, 1].
 * @param {string|Object} from
 * @param {string|Object} to
 * @param {Object} [opts] knobs: see FILL_DEFAULTS
 */
function planFill(from, to, opts = {}) {
  const o = { ...FILL_DEFAULTS, ...opts };
  // R8-2: a style toggle (the same icon name in two styles of one family) morphs directly: no proxy path, no merge or split.
  if (isStyleToggleLocal(from, to)) {
    o.fillSimplify = false;
    o._toggle = true;
  }
  const la = regionsOf(from);
  const lb = regionsOf(to);
  const maxA = maxArea(la);
  const maxB = maxArea(lb);
  const ops = [];
  const levels = [...new Set([...la.map((l) => l.opacity), ...lb.map((l) => l.opacity)])].sort((a, b) => a - b);
  levels.forEach((op, rank) => {
    ops.push(...matchLayer(la.find((l) => l.opacity === op), lb.find((l) => l.opacity === op), o, maxA, maxB, rank, op));
  });
  return assemble(ops, o);
}

// ---------------------------------------------------------------------------
// Fill effect: implode (out) and expand (in) for a fill icon
// ---------------------------------------------------------------------------

function similarContour(c, cx, cy, s, deg) {
  const co = Math.cos(deg * DEG) * s;
  const si = Math.sin(deg * DEG) * s;
  const P = new Float64Array(c.pts.length);
  for (let k = 0; k < P.length; k += 2) {
    const x = c.pts[k] - cx;
    const y = c.pts[k + 1] - cy;
    P[k] = cx + co * x - si * y;
    P[k + 1] = cy + si * x + co * y;
  }
  const f = finishContour(P, c.area * s * s, c.snap);
  f.corner = c.corner;
  f.nForced = c.nForced;
  return f;
}

// R9-2: the explode effect for a fill icon (the same numbers as `fxExplode` in effects.js). Every region (outer contour with its
// holes) flies away from (12, 12) along the line through its centroid, by 8 + 0.5 d units, turns 40 degrees (the sign alternates
// by region), and scales to 0.3. Ease-in (t^3). In the last 30% the region shrinks to nothing about its own center. 'in' (assemble)
// plays the same plan backward. effects.js works on strokes, so the fill version lives here and uses the same constants.
function planFillExplode(src, direction, o) {
  const layers = regionsOf(src);
  const items = [];
  layers.forEach((L, rank) => {
    for (const r of L.regions) items.push({ r, rank, opacity: L.opacity });
  });
  const norm = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
  const inn = direction === 'in';
  const map = (t) => (inn ? 1 - norm(t) : norm(t));
  const slots = items.map((it, i) => {
    const r = it.r;
    const dx = r.cx - 12;
    const dy = r.cy - 12;
    const d = Math.hypot(dx, dy);
    let ux;
    let uy;
    if (d > 0.5) {
      ux = dx / d;
      uy = dy / d;
    } else {
      const a = i * 2.399963; // golden angle: a centered region still goes somewhere
      ux = Math.cos(a);
      uy = Math.sin(a);
    }
    const far = 8 + 0.5 * d;
    const sign = i % 2 === 0 ? 1 : -1;
    const contours = [r.outer, ...r.holes];
    const eval_ = (t) => {
      const e = t * t * t;
      const s = 1 + (0.3 - 1) * e;
      const ang = sign * 40 * e * DEG;
      const co = Math.cos(ang) * s;
      const si = Math.sin(ang) * s;
      const nx = r.cx + ux * far * e;
      const ny = r.cy + uy * far * e;
      const vanish = t > 0.7 ? Math.max(0, (1 - t) / 0.3) : 1;
      if (vanish <= 0.004) return null;
      return contours.map((c) => {
        const P = new Float64Array(c.pts.length);
        for (let k = 0; k < P.length; k += 2) {
          const x = c.pts[k] - r.cx;
          const y = c.pts[k + 1] - r.cy;
          P[k] = nx + vanish * (co * x - si * y);
          P[k + 1] = ny + vanish * (si * x + co * y);
        }
        return P;
      });
    };
    return {
      role: 'part', kind: 'exit', anchor: -1, anchorIndex: -1, window: [0, 1], motion: 'frame', lod: false,
      depth: it.rank, layer: it.rank, opacity: it.opacity, weight: r.area, static: false, holes: [], _eval: eval_, _order: 0,
    };
  });
  slots.sort((a, b) => a.layer - b.layer || b.weight - a.weight);
  return {
    fill: true,
    slots,
    turn: 0,
    duration: 0,
    occlusion: 'none',
    strokeWidth: 0,
    occludes: () => false,
    frame(t) {
      const u = map(t);
      const res = [];
      for (let i = 0; i < slots.length; i++) {
        const loops = slots[i]._eval(u);
        if (!loops) continue;
        res.push({ d: loopsToD(loops), opacity: slots[i].opacity, widthScale: 1, key: i * 4, slot: i, depth: slots[i].layer, occluder: false, fill: true, region: true, layer: slots[i].layer });
      }
      return res;
    },
    snapshot(t) {
      const u = map(t);
      const regions = [];
      const loops = [];
      for (let i = 0; i < slots.length; i++) {
        const ls = slots[i]._eval(u);
        if (!ls) continue;
        regions.push({ outer: ls[0], holes: ls.slice(1), opacity: slots[i].opacity, layer: slots[i].layer });
        for (const P of ls) {
          const Q = new Float64Array(P.length + 2);
          Q.set(P);
          Q[P.length] = P[0];
          Q[P.length + 1] = P[1];
          loops.push({ points: Q, opacity: slots[i].opacity, vis: new Uint8Array(P.length / 2).fill(1) });
        }
      }
      return { kind: 'snapshot', fill: true, snapshotKind: 'fill', family: { kind: 'fill' }, regions, loops };
    },
  };
}

/**
 * The implode effect for a fill icon. 'out' ends empty: parts go under the body, holes close, the body becomes its
 * simple shape, the shape shrinks to (12, 12) and turns 30 degrees, and the last 15% of the time shrinks it to nothing.
 * 'in' (expand) plays the same plan backward with an ease-out. Other effect names use implode too.
 * @param {string|Object} src icon name, icon info, or fill snapshot
 * @param {'in'|'out'} direction
 * @param {string} [effect]
 * @param {Object} [opts]
 */
function planFillEffect(src, direction, effect = 'implode', opts = {}) {
  if (direction !== 'in' && direction !== 'out') throw new Error("planFillEffect: direction must be 'in' or 'out'.");
  const o = { ...FILL_DEFAULTS, ...opts };
  const fx = String(effect || '').toLowerCase();
  if (fx === 'explode' || fx === 'assemble') return planFillExplode(src, direction, o);
  const layers = regionsOf(src);
  const mx = maxArea(layers);
  const ops = [];
  layers.forEach((L, rank) => {
    for (const r of L.regions) {
      if (r.area >= o.coreFraction * mx) {
        const B = makeRegion(similarContour(r.outer, 12, 12, 0.03, 30), [], r.opacity);
        ops.push({ type: 'match', A: r, B, role: 'core', rank, opacity: L.opacity, window: [0.3, 1], forceHard: true });
      } else ops.push({ type: 'exit', A: r, rank, opacity: L.opacity });
    }
  });
  const post = (t) => (t > 0.85 ? Math.max(0, (1 - t) / 0.15) : 1);
  const p = assemble(ops, { ...o, easing: 'easeInOutCubic' }, { post });
  if (direction === 'out') return p;
  const map = (t) => 1 - EASE.easeOutCubic(clamp01(t));
  return { ...p, frame: (t) => p.frame(map(t)), snapshot: (t) => p.snapshot(map(t)) };
}

return { FILL_DEFAULTS, setIconResolver, parsePath, regionsOf, planFill, planFillEffect };
})();
const { FILL_DEFAULTS, setIconResolver, regionsOf, planFill, planFillEffect } = __regions;
// Morphicon renderer (round 6, fill entries in round 7, styled stroke entries in round 7b, plan width and caps in round 9b). Pure: no DOM in entriesToSVG. renderInto is a small DOM helper.
// It draws the entries of plan.frame(t) back to front, and hides the parts that go behind a closed shape.

const RN_NS = 'http://www.w3.org/2000/svg';
const RN_BOX = { x: -24, y: -24, w: 72, h: 72 }; // the mask area: well past the 24 x 24 viewBox
let rnCounter = 0;

const rnNum = (x) => String(Math.round(x * 1000) / 1000);

// Back to front: depth up, then key. Returns a new array.
function rnOrder(entries) {
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.depth || 0) - (b.e.depth || 0) || a.i - b.i)
    .map((x) => x.e);
}

// For each entry of the sorted list: the entries in front of it that may hide it (mask mode).
// R10-2: with `twinOnly` (the option is 'none' but the plan has a closed twin) only the twin pairs of the plan hide anything.
function rnHiders(sorted, plan, o) {
  const out = sorted.map(() => []);
  const test = o.twinOnly && plan && typeof plan.twinOccludes === 'function' ? plan.twinOccludes : plan && plan.occludes;
  if (o.occlusion === 'none' || typeof test !== 'function') return out;
  for (let k = 0; k < sorted.length; k++) {
    const e = sorted[k];
    for (let m = k + 1; m < sorted.length; m++) {
      const f = sorted[m];
      if (!f.occluder || f.slot === e.slot) continue;
      if ((f.depth || 0) <= (e.depth || 0)) continue;
      if (test(f.slot, e.slot)) out[k].push(f);
    }
  }
  return out;
}

const rnMode = (m) => (m === 'mask' || m === 'fill' || m === 'none' ? m : null);

// Round 7: a missing `occlusion` option falls back to plan.occlusion (default 'none'), not to 'mask'.
function rnOptions(opts, plan) {
  const o = opts || {};
  let occlusion = rnMode(o.occlusion) || rnMode(plan && plan.occlusion) || 'none';
  // R10-2: a plan with a closed twin (`plan.masks`) always draws masks for its twin pairs, also with the option 'none'.
  const twinOnly = occlusion === 'none' && !!plan && plan.masks === true;
  if (twinOnly) occlusion = 'mask';
  return {
    occlusion,
    twinOnly,
    idPrefix: o.idPrefix || 'mo',
    strokeWidth: o.strokeWidth == null ? 2 : o.strokeWidth,
    baseWidth: o.baseWidth > 0 ? o.baseWidth : null,
    linecap: o.linecap || 'round',
    linejoin: o.linejoin || 'round',
    bg: o.bg || null,
  };
}

const rnFillValue = (o) => o.bg || 'var(--morph-bg, #fff)';

// Round 7b: two kinds of entry have `fill: true`.
//  - a region entry (a fill family: `region: true`, or any `fill` entry of a fill plan): fill currentColor, no stroke, nonzero rule;
//  - a styled stroke entry (a stroke family: an element with fill="currentColor"): fill and stroke, both currentColor,
//    with the stroke width of the entry (`strokeWidth`, 24-grid units). `fill: true` with `strokeWidth: 0` is fill only.
const rnIsRegion = (e, plan) => !!e.fill && (e.region === true || (!!plan && plan.fill === true));

// Does a stroke entry draw no stroke? (fill only)
const rnFillOnly = (e) => !!e.fill && e.strokeWidth === 0;

// R9b: the stroke width of a stroke entry in 24-grid units, absolute. An entry with its own width (`strokeWidth` > 0)
// draws exactly that width (the width already includes any width change over time, so `widthScale` is not applied again).
// Else the base width times `widthScale`. The base is `opts.baseWidth`, else `plan.strokeWidth` (the width of the plan's
// own family), else the wrapper width (`opts.strokeWidth`, default 2).
function rnWidth(e, plan, o) {
  if (e.strokeWidth > 0) return e.strokeWidth;
  const base = o.baseWidth || (plan && plan.strokeWidth > 0 ? plan.strokeWidth : o.strokeWidth);
  return base * (Number.isFinite(e.widthScale) ? e.widthScale : 1);
}

// The stroke-width attribute of a stroke entry, or null when the wrapper width (`opts.strokeWidth`) is right.
function rnWidthAttr(e, plan, o) {
  const w = rnWidth(e, plan, o);
  return Math.abs(w - o.strokeWidth) < 0.0005 ? null : rnNum(w);
}

// R9b: the cap and join attributes of a stroke entry, or null when the wrapper (`opts.linecap`, `opts.linejoin`, default round) is right.
const rnCap = (plan, o) => (plan && plan.linecap && plan.linecap !== o.linecap ? plan.linecap : null);
const rnJoin = (plan, o) => (plan && plan.linejoin && plan.linejoin !== o.linejoin ? plan.linejoin : null);

/**
 * The inner SVG markup of one frame. Put it inside an <svg viewBox="0 0 24 24"> that has the Lucide stroke
 * attributes (fill none, stroke, stroke-width, round caps and joins).
 * @param {{d: string, opacity: number, widthScale: number, key: number, slot: number, depth?: number, occluder?: boolean}[]} entries plan.frame(t)
 * @param {{occludes?: Function}} plan The plan that made the entries.
 * @param {{occlusion?: 'mask'|'fill'|'none', idPrefix?: string, strokeWidth?: number, baseWidth?: number, linecap?: string, linejoin?: string, bg?: string}} [opts]
 *   A missing `occlusion` uses `plan.occlusion` (default 'none'). A region entry (`fill: true, region: true`, or any fill
 *   entry of a plan with `plan.fill`) is drawn with fill currentColor, no stroke, and the nonzero rule. A stroke entry
 *   with `fill: true` is a filled stroke: fill and stroke, both currentColor; `strokeWidth: 0` there means fill only
 *   (stroke none). R9b: a stroke entry with `strokeWidth` > 0 draws exactly that width (24-grid units, absolute).
 *   Otherwise it draws `widthScale` times the base width: `opts.baseWidth`, else `plan.strokeWidth` (when above 0), else
 *   `opts.strokeWidth`. A path gets a `stroke-width` attribute only when its width differs from `opts.strokeWidth`.
 *   `plan.linecap` and `plan.linejoin` (round when missing) go on a path only when they differ from `opts.linecap` and
 *   `opts.linejoin` (default round). Put the same values on the wrapper svg.
 *   `idPrefix` makes the mask ids unique (use a different one for each svg on a page). `strokeWidth` is the stroke
 *   width of the wrapper svg (2). `baseWidth` overrides the base width. `bg` is a plain color for 'fill' mode
 *   (default `var(--morph-bg, #fff)`).
 * @returns {string}
 */
function entriesToSVG(entries, plan, opts) {
  const o = rnOptions(opts, plan);
  const sorted = rnOrder(entries);
  const hiders = rnHiders(sorted, plan, o);
  let defs = '';
  let body = '';
  for (let k = 0; k < sorted.length; k++) {
    const e = sorted[k];
    let attrs = ' d="' + e.d + '"';
    if (e.opacity < 1) attrs += ' opacity="' + rnNum(e.opacity) + '"';
    if (rnIsRegion(e, plan)) {
      // R7: a fill entry (a region of a fill family). No stroke, no mask, no occlusion fill.
      body += '<path' + attrs + ' fill="currentColor" stroke="none" fill-rule="nonzero"/>';
      continue;
    }
    if (e.fill) attrs += rnFillOnly(e) ? ' fill="currentColor" stroke="none"' : ' fill="currentColor"';
    const wa = rnWidthAttr(e, plan, o);
    if (wa !== null && !rnFillOnly(e)) attrs += ' stroke-width="' + wa + '"';
    if (!rnFillOnly(e)) {
      const lc = rnCap(plan, o);
      const lj = rnJoin(plan, o);
      if (lc) attrs += ' stroke-linecap="' + lc + '"';
      if (lj) attrs += ' stroke-linejoin="' + lj + '"';
    }
    if (o.occlusion === 'mask' && hiders[k].length) {
      const id = o.idPrefix + '-' + e.key;
      defs +=
        '<mask id="' + id + '" maskUnits="userSpaceOnUse" x="' + RN_BOX.x + '" y="' + RN_BOX.y + '" width="' + RN_BOX.w + '" height="' + RN_BOX.h + '">' +
        '<rect x="' + RN_BOX.x + '" y="' + RN_BOX.y + '" width="' + RN_BOX.w + '" height="' + RN_BOX.h + '" fill="#fff" stroke="none"/>' +
        hiders[k].map((f) => '<path d="' + (f.maskD || f.d) + '" fill="#000" stroke="none"/>').join('') +
        '</mask>';
      attrs += ' mask="url(#' + id + ')"';
    } else if (o.occlusion === 'fill' && e.occluder && !e.fill && rnHidesAny(sorted, k, plan)) {
      attrs += ' style="fill:' + rnFillValue(o) + '"';
    }
    body += '<path' + attrs + '/>';
  }
  return (defs ? '<defs>' + defs + '</defs>' : '') + body;
}

// 'fill' mode: an occluder gets the background fill only when it may hide an entry behind it.
function rnHidesAny(sorted, k, plan) {
  if (!plan || typeof plan.occludes !== 'function') return false;
  const f = sorted[k];
  for (let m = 0; m < k; m++) {
    const e = sorted[m];
    if (e.slot !== f.slot && (e.depth || 0) < (f.depth || 0) && plan.occludes(f.slot, e.slot)) return true;
  }
  return false;
}

const rnEl = (name) => document.createElementNS(RN_NS, name);

function rnState(svg, o) {
  let st = svg._morphRender;
  if (st && st.defs.parentNode === svg) return st;
  // First call, or something else changed the children (for example a rest render): start clean.
  svg.innerHTML = '';
  const defs = rnEl('defs');
  svg.appendChild(defs);
  st = { defs, paths: [], masks: [], prefix: o.idPrefix === 'mo' ? 'mo' + ++rnCounter : o.idPrefix };
  svg._morphRender = st;
  return st;
}

function rnSet(el, name, value) {
  if (value === null) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

/**
 * Draw entries into an <svg> element and reuse its child elements. The svg keeps one <defs> and a pool of
 * <path> elements. Call it again for every frame.
 * @param {SVGElement} svgEl
 * @param {Array} entries plan.frame(t)
 * @param {{occludes?: Function}} plan
 * @param {{occlusion?: 'mask'|'fill'|'none', idPrefix?: string, strokeWidth?: number, baseWidth?: number, linecap?: string, linejoin?: string, bg?: string}} [opts]
 */
function renderInto(svgEl, entries, plan, opts) {
  const o = rnOptions(opts, plan);
  const st = rnState(svgEl, o);
  const sorted = rnOrder(entries);
  const hiders = rnHiders(sorted, plan, o);
  let nMask = 0;
  for (let k = 0; k < sorted.length; k++) {
    const e = sorted[k];
    let p = st.paths[k];
    if (!p) {
      p = rnEl('path');
      st.paths[k] = p;
      svgEl.appendChild(p);
    } else if (p.style.display === 'none') p.style.display = '';
    p.setAttribute('d', e.d);
    rnSet(p, 'opacity', e.opacity < 1 ? rnNum(e.opacity) : null);
    if (rnIsRegion(e, plan)) {
      // R7: a fill entry. The pooled element may have drawn a stroke before, so set every attribute.
      rnSet(p, 'fill', 'currentColor');
      rnSet(p, 'stroke', 'none');
      rnSet(p, 'fill-rule', 'nonzero');
      rnSet(p, 'stroke-width', null);
      rnSet(p, 'stroke-linecap', null);
      rnSet(p, 'stroke-linejoin', null);
      rnSet(p, 'mask', null);
      p.style.fill = '';
      continue;
    }
    // A stroke entry; round 7b: a styled one (`fill: true`) also fills with currentColor. The pooled element may have
    // drawn something else before, so set every attribute.
    rnSet(p, 'fill', e.fill ? 'currentColor' : null);
    rnSet(p, 'stroke', rnFillOnly(e) ? 'none' : null);
    rnSet(p, 'fill-rule', null);
    rnSet(p, 'stroke-width', rnFillOnly(e) ? null : rnWidthAttr(e, plan, o));
    rnSet(p, 'stroke-linecap', rnFillOnly(e) ? null : rnCap(plan, o));
    rnSet(p, 'stroke-linejoin', rnFillOnly(e) ? null : rnJoin(plan, o));
    let maskRef = null;
    let fill = '';
    if (o.occlusion === 'mask' && hiders[k].length) {
      let m = st.masks[nMask];
      if (!m) {
        const el = rnEl('mask');
        el.setAttribute('id', st.prefix + '-m' + nMask);
        el.setAttribute('maskUnits', 'userSpaceOnUse');
        el.setAttribute('x', String(RN_BOX.x));
        el.setAttribute('y', String(RN_BOX.y));
        el.setAttribute('width', String(RN_BOX.w));
        el.setAttribute('height', String(RN_BOX.h));
        const r = rnEl('rect');
        r.setAttribute('x', String(RN_BOX.x));
        r.setAttribute('y', String(RN_BOX.y));
        r.setAttribute('width', String(RN_BOX.w));
        r.setAttribute('height', String(RN_BOX.h));
        r.setAttribute('fill', '#fff');
        r.setAttribute('stroke', 'none');
        el.appendChild(r);
        st.defs.appendChild(el);
        m = { el, paths: [] };
        st.masks[nMask] = m;
      }
      const list = hiders[k];
      for (let h = 0; h < list.length; h++) {
        let mp = m.paths[h];
        if (!mp) {
          mp = rnEl('path');
          mp.setAttribute('fill', '#000');
          mp.setAttribute('stroke', 'none');
          m.el.appendChild(mp);
          m.paths[h] = mp;
        } else if (mp.style.display === 'none') mp.style.display = '';
        mp.setAttribute('d', list[h].maskD || list[h].d);
      }
      for (let h = list.length; h < m.paths.length; h++) m.paths[h].style.display = 'none';
      maskRef = 'url(#' + st.prefix + '-m' + nMask + ')';
      nMask++;
    } else if (o.occlusion === 'fill' && e.occluder && !e.fill && rnHidesAny(sorted, k, plan)) {
      fill = rnFillValue(o);
    }
    rnSet(p, 'mask', maskRef);
    p.style.fill = fill;
  }
  for (let k = sorted.length; k < st.paths.length; k++) {
    if (st.paths[k].style.display !== 'none') st.paths[k].style.display = 'none';
  }
}

// Morphicon effects (round 6): appear and disappear as plans. Built only on the hooks of core.js.
// Round 15 adds `planAlive`: a one-shot "life" wiggle for hover (SPEC R15-1 to R15-5).

const FX_CX = 12;
const FX_CY = 12;
const FX_DEG = Math.PI / 180;

const FX_FAMILY = {
  implode: 'implode',
  expand: 'implode',
  explode: 'explode',
  assemble: 'explode',
  draw: 'draw',
  erase: 'draw',
  scale: 'scale',
};

/** The effect names. Each name works in both directions (for example `planEffect(n, 'in', 'implode')` is expand). */
const EFFECTS = Object.freeze(['implode', 'explode', 'assemble', 'draw', 'erase', 'scale', 'expand']);

// Similarity copy of a loop: scale s and turn by `deg` about (cx, cy), then move that point to (nx, ny).
function fxSim(points, cx, cy, nx, ny, s, deg) {
  const out = new Float64Array(points.length);
  const c = Math.cos(deg * FX_DEG) * s;
  const d = Math.sin(deg * FX_DEG) * s;
  for (let k = 0; k < points.length; k += 2) {
    const x = points[k] - cx;
    const y = points[k + 1] - cy;
    out[k] = nx + c * x - d * y;
    out[k + 1] = ny + d * x + c * y;
  }
  return out;
}

function fxCentroid(points) {
  let x = 0;
  let y = 0;
  const n = points.length / 2;
  for (let k = 0; k < points.length; k += 2) {
    x += points[k];
    y += points[k + 1];
  }
  return n ? [x / n, y / n] : [FX_CX, FX_CY];
}

function fxLength(L) {
  const p = L.points;
  let len = 0;
  for (let k = 2; k < p.length; k += 2) len += Math.hypot(p[k] - p[k - 2], p[k + 1] - p[k - 1]);
  if (L.closed && p.length >= 4) len += Math.hypot(p[0] - p[p.length - 2], p[1] - p[p.length - 1]);
  return len;
}

const fxTarget = (L, points, extra) => ({ points, closed: L.closed, joints: L.joints, vis: L.vis, align: 'identity', ...extra });

// Width goes to 0 in the last `frac` of the time, so that the last dot has no ink.
const fxWidth = (frac) => (slot, t) => (t > 1 - frac ? Math.max(0, (1 - t) / frac) : 1);

// A plan that plays `inner` with the time mapped by `map`. Same API as a plan.
function fxReverse(inner, map) {
  return { ...inner, frame: (t) => inner.frame(map(t)), snapshot: (t) => inner.snapshot(map(t)) };
}

// R6-3 implode (out): the parts go into the body, the body becomes its simple shape, the shape shrinks to
// (12, 12) and turns 30 degrees. The last dot shrinks (widthScale 0 in the last 15%).
function fxImplode(src, o) {
  const loops = iconLoops(src, o);
  const w = loops.map((L) => fxLength(L) * (L.closed ? 1.5 : 1));
  const mx = w.reduce((a, b) => Math.max(a, b), 0);
  const targets = loops.map((L, i) =>
    w[i] >= 0.5 * mx
      ? fxTarget(L, fxSim(L.points, FX_CX, FX_CY, FX_CX, FX_CY, 0.03, 30), { role: 'core', lod: true, window: [0.3, 1] })
      : null
  );
  return planToLoops(src, targets, { ...o, staging: true, easing: 'easeInOutCubic', minRigidSpread: 0, widthScale: fxWidth(0.15) });
}

// R6-3 explode (out): every stroke flies away from (12, 12) along the line through its centroid, by 8 + 0.5 d
// units, turns 40 degrees (the sign alternates), and scales to 0.3. Ease-in. widthScale 0 in the last 30%.
function fxExplode(src, o) {
  const loops = iconLoops(src, o);
  const targets = loops.map((L, i) => {
    const [cx, cy] = fxCentroid(L.points);
    const dx = cx - FX_CX;
    const dy = cy - FX_CY;
    const d = Math.hypot(dx, dy);
    let ux;
    let uy;
    if (d > 0.5) {
      ux = dx / d;
      uy = dy / d;
    } else {
      const a = i * 2.399963; // golden angle: a centered stroke still goes somewhere
      ux = Math.cos(a);
      uy = Math.sin(a);
    }
    const far = 8 + 0.5 * d;
    return fxTarget(L, fxSim(L.points, cx, cy, cx + ux * far, cy + uy * far, 0.3, i % 2 === 0 ? 40 : -40), {});
  });
  return planToLoops(src, targets, { ...o, staging: false, easing: (t) => t * t * t, widthScale: fxWidth(0.3) });
}

// R6-3 scale (out): the whole icon scales to 0 about (12, 12). R6b: the stroke width scales with the icon
// (widthScale = the scale factor, 1 to 0.03 on the eased path), so the lines get thinner as the icon shrinks.
function fxScaleOut(src, o) {
  const loops = iconLoops(src, o);
  const targets = loops.map((L) => fxTarget(L, fxSim(L.points, FX_CX, FX_CY, FX_CX, FX_CY, 0.03, 0), {}));
  const ease = easings.easeInOutCubic;
  // slot motion is eased by the plan's easing, so the width follows the same eased value: s(t) = 1 - 0.97 * ease(t).
  // The last dot has no ink: the scale factor times the same fade as before (0 in the last 15%).
  const vanish = fxWidth(0.15);
  return planToLoops(src, targets, {
    ...o,
    staging: false,
    easing: 'easeInOutCubic',
    minRigidSpread: 0,
    widthScale: (slot, t) => (1 - 0.97 * ease(Math.min(1, Math.max(0, t)))) * vanish(slot, t),
  });
}

/**
 * Plan an appear or disappear effect. The result has the plan API (`frame`, `snapshot`, `slots`, `occludes`, `turn`).
 * 'out' ends empty (frame(1) has no ink). 'in' starts empty (frame(0) has no ink) and ends as the icon, exactly.
 * - implode (out), expand (in): the parts go into the body, the body becomes a simple shape, it shrinks to the center.
 * - explode (out), assemble (in): every stroke flies away from the center, turns, and shrinks. Assemble is the reverse, with an ease-out.
 * - draw (in), erase (out): strokes draw on or erase along their own path, in source order.
 * - scale (in, out): the whole icon scales from or to 0 about (12, 12). 'in' uses the gentle (old spring) easing.
 * A name works in both directions: direction picks the variant ('in' + 'implode' is expand).
 * @param {string|Array|Object} name An icon name, an icon node, or a snapshot (to start from a running morph).
 * @param {'in'|'out'} direction
 * @param {string} effect One of EFFECTS.
 * @param {Object} [opts] Knobs of planMorph (matching, occlusion, and so on).
 */
function planEffect(name, direction, effect, opts = {}) {
  if (direction !== 'in' && direction !== 'out') throw new Error("planEffect: direction must be 'in' or 'out'.");
  const family = FX_FAMILY[String(effect || '').toLowerCase()];
  if (!family) throw new Error('planEffect: unknown effect "' + effect + '". Use one of: ' + EFFECTS.join(', ') + '.');
  const o = { ...DEFAULTS, ...opts };
  const inn = direction === 'in';
  switch (family) {
    case 'implode': {
      const p = fxImplode(name, o);
      return inn ? fxReverse(p, (t) => 1 - easings.easeOutCubic(Math.min(1, Math.max(0, t)))) : p;
    }
    case 'explode': {
      const p = fxExplode(name, o);
      return inn ? fxReverse(p, (t) => 1 - t) : p;
    }
    case 'draw':
      // One stroke takes the whole time (the core spreads the starts over drawStagger, which cuts a lone stroke short).
      return planDraw(name, direction, { ...o, easing: 'easeInOutCubic', drawStagger: iconLoops(name, o).length > 1 ? o.drawStagger : 0 });
    default: {
      const p = fxScaleOut(name, o);
      return inn ? fxReverse(p, (t) => 1 - easings.gentle(Math.min(1, Math.max(0, t)))) : p;
    }
  }
}

// ---------------------------------------------------------------------------
// Round 15: icons that come alive on hover (SPEC R15-1 to R15-5).
//
// `planAlive(name, opts)` returns a plan with the same frame interface as `planEffect`. It never changes the icon:
// frame(0) and frame(1) are the rest strokes exactly. The behavior is picked from the rig (`iconTree`) and the
// stroke geometry: radiate, ripple, swing, or pop. Every motion is a rigid similarity (rotation + uniform scale)
// about a point, so a child takes its parent's transform in every frame and the stroke width never changes.
// ---------------------------------------------------------------------------

const ALIVE_DEG = Math.PI / 180;

// Classifier thresholds (R15-2). Named so the rules can be read off the code.
const RADIATE_MIN_SPOKES = 4; // radiate: at least this many alike parts spread around one center
const RADIATE_ANGLE_TOL = 25; // degrees: a spoke axis within this of its radial line
const RADIATE_SIZE_RATIO = 2.0; // radiate: longest spoke / shortest spoke is at most this
const RADIATE_MIN_SPOKE = 0.5; // units: a shorter open stroke is not a spoke
const RADIATE_MAX_SPOKE = 12; // units: a longer open stroke is not a spoke (keeps the pulse inside the R15-5 box)
const RADIATE_MAX_GAP = 100; // degrees: the largest empty sector allowed between spokes
const RADIATE_MIN_SPAN = 180; // degrees: the spokes must wrap at least this far around the center
const RIPPLE_MIN_ARCS = 2; // ripple: at least this many open arcs
const RIPPLE_MIN_LEN = 1.5; // units: a shorter open stroke is not an arc
const RIPPLE_BULGE = 0.3; // units: how far the arc middle must sit off its chord
const RIPPLE_CENTER_TOL = 4.0; // units: arcs share a center when their circumcenters are this close
const RIPPLE_PHASE_RADIUS = 0.5; // R15-6: arcs at the same radius (within this) share one phase
const SWING_MIN_PART_LEN = 2.5; // units: the long part of a swing icon
const SWING_MAX_PARTS = 3; // swing: the body has few parts
const SWING_OFF_CENTER = 0.2; // swing: the long part sits this far (x body radius) from the body center

// Motion knobs (R15-2, R15-4, R15-5).
const ALIVE_STAGGER = 0.09; // fraction of the timeline between neighbouring parts (about 54 ms at 600 ms)
const ALIVE_MAX_OFFSET = 0.6; // the last part starts no later than this
const ALIVE_RADIATE_GROWTH = 0.25; // R15-2: peak 125% length
const ALIVE_RADIATE_TURN = 15; // degrees: the core turns this far and back
const ALIVE_RIPPLE_MIN = 0.15; // the arc shrinks to this fraction about its midpoint
const ALIVE_SWING_BACK = -12; // degrees: first swing
const ALIVE_SWING_FWD = 6; // degrees: second swing
const ALIVE_POP_DIP = 0.92; // R15-2: the whole icon dips to this
const ALIVE_POP_UP = 1.06; // and springs to this
const ALIVE_POP_TILT = 4; // degrees
const ALIVE_BOUND = 3; // R15-5: no point more than this far outside the 24-unit box

// --- small geometry helpers -------------------------------------------------------------------------------

const alClamp = (t) => (t <= 0 || t !== t ? 0 : t >= 1 ? 1 : t);

function alNum(x) {
  const r = Math.round(x * 100) / 100;
  if (r === 0 || !Number.isFinite(r)) return '0';
  return String(r);
}

// The `d` string of one polyline: `M x0 y0 x1 y1 ...` (the core format, 2 decimals).
function alD(P) {
  const parts = new Array(P.length);
  for (let k = 0; k < P.length; k++) parts[k] = alNum(P[k]);
  return 'M' + parts.join(' ');
}

function alCentroid(P) {
  let x = 0;
  let y = 0;
  const n = P.length / 2;
  if (!n) return [12, 12];
  for (let k = 0; k < P.length; k += 2) {
    x += P[k];
    y += P[k + 1];
  }
  return [x / n, y / n];
}

// The dense point at half the polyline length (the "middle" of an arc).
function alMidPoint(P) {
  let L = 0;
  for (let k = 2; k < P.length; k += 2) L += Math.hypot(P[k] - P[k - 2], P[k + 1] - P[k - 1]);
  const half = L / 2;
  let acc = 0;
  for (let k = 2; k < P.length; k += 2) {
    const seg = Math.hypot(P[k] - P[k - 2], P[k + 1] - P[k - 1]);
    if (acc + seg >= half) {
      const f = seg > 1e-9 ? (half - acc) / seg : 0;
      return [P[k - 2] + (P[k] - P[k - 2]) * f, P[k - 1] + (P[k + 1] - P[k - 1]) * f];
    }
    acc += seg;
  }
  return [P[P.length - 2], P[P.length - 1]];
}

function alCircumcenter(a, b, c) {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = a[0] * a[0] + a[1] * a[1];
  const b2 = b[0] * b[0] + b[1] * b[1];
  const c2 = c[0] * c[0] + c[1] * c[1];
  return [
    (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d,
    (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d,
  ];
}

// A rigid similarity as a 2x3 affine map: (x, y) -> (a x + c y + e, b x + d y + f).
function alRot(cx, cy, deg) {
  const c = Math.cos(deg * ALIVE_DEG);
  const s = Math.sin(deg * ALIVE_DEG);
  return { a: c, b: s, c: -s, d: c, e: cx - c * cx + s * cy, f: cy - s * cx - c * cy };
}
function alScale(cx, cy, k) {
  return { a: k, b: 0, c: 0, d: k, e: cx - k * cx, f: cy - k * cy };
}
function alApply(T, P) {
  const out = new Float64Array(P.length);
  for (let k = 0; k < P.length; k += 2) {
    const x = P[k];
    const y = P[k + 1];
    out[k] = T.a * x + T.c * y + T.e;
    out[k + 1] = T.b * x + T.d * y + T.f;
  }
  return out;
}
// A after B (B first).
function alMul(A, B) {
  return {
    a: A.a * B.a + A.c * B.b,
    b: A.b * B.a + A.d * B.b,
    c: A.a * B.c + A.c * B.d,
    d: A.b * B.c + A.d * B.d,
    e: A.a * B.e + A.c * B.f + A.e,
    f: A.b * B.e + A.d * B.f + A.f,
  };
}

// A smooth keyframe curve: keys is [[time, value], ...] with the first time 0 and the last time 1.
// Exact at the ends (a value is returned unchanged at t <= 0 and t >= 1).
function alKeys(keys, t) {
  const last = keys.length - 1;
  if (t <= keys[0][0]) return keys[0][1];
  if (t >= keys[last][0]) return keys[last][1];
  for (let i = 1; i <= last; i++) {
    if (t <= keys[i][0]) {
      const t0 = keys[i - 1][0];
      const v0 = keys[i - 1][1];
      const t1 = keys[i][0];
      const v1 = keys[i][1];
      const u = t1 > t0 ? (t - t0) / (t1 - t0) : 1;
      const s = u * u * (3 - 2 * u);
      return v0 + (v1 - v0) * s;
    }
  }
  return keys[last][1];
}

// --- the classifier (R15-2) -------------------------------------------------------------------------------

// The center of the core strokes; the centroid of every point when there is no core stroke.
function alCoreCenter(S, T) {
  let x = 0;
  let y = 0;
  let n = 0;
  for (let pass = 0; pass < 2 && !n; pass++) {
    for (let i = 0; i < S.length; i++) {
      if (pass === 0 && T[i].role !== 'core') continue;
      const P = S[i].pts;
      for (let k = 0; k < P.length; k += 2) {
        x += P[k];
        y += P[k + 1];
        n++;
      }
    }
  }
  return n ? [x / n, y / n] : [12, 12];
}

// radiate: 4 or more alike open parts, each roughly radial, spread around one center (sun rays, loader spokes).
function alRadiate(S, T) {
  const C = alCoreCenter(S, T);
  const sinTol = Math.sin(RADIATE_ANGLE_TOL * ALIVE_DEG);
  const spokes = [];
  for (let i = 0; i < S.length; i++) {
    const s = S[i];
    if (s.closed || s.length < RADIATE_MIN_SPOKE || s.length > RADIATE_MAX_SPOKE) continue;
    const P = s.pts;
    const n = P.length / 2;
    if (n < 2) continue;
    const ax = P[2 * n - 2] - P[0];
    const ay = P[2 * n - 1] - P[1];
    const alen = Math.hypot(ax, ay);
    if (alen < 1e-6) continue;
    const c = alCentroid(P);
    const rx = c[0] - C[0];
    const ry = c[1] - C[1];
    const rlen = Math.hypot(rx, ry);
    if (rlen < 0.5) continue;
    const cross = Math.abs((ax / alen) * (ry / rlen) - (ay / alen) * (rx / rlen));
    if (cross > sinTol) continue;
    spokes.push({ i, angle: ((Math.atan2(ry, rx) / ALIVE_DEG) % 360 + 360) % 360, len: s.length });
  }
  if (spokes.length < RADIATE_MIN_SPOKES) return null;
  let mn = Infinity;
  let mx = 0;
  for (const sp of spokes) {
    mn = Math.min(mn, sp.len);
    mx = Math.max(mx, sp.len);
  }
  if (mn < 1e-6 || mx / mn > RADIATE_SIZE_RATIO) return null;
  spokes.sort((a, b) => a.angle - b.angle);
  let maxGap = 0;
  for (let k = 0; k < spokes.length; k++) {
    const a = spokes[k].angle;
    const b = k + 1 < spokes.length ? spokes[k + 1].angle : spokes[0].angle + 360;
    maxGap = Math.max(maxGap, b - a);
  }
  if (maxGap > RADIATE_MAX_GAP || 360 - maxGap < RADIATE_MIN_SPAN) return null;
  return { kind: 'radiate', center: C, spokes };
}

// ripple: 2 or more open arcs that share a center (speaker waves, wifi, RSS).
// R15-6: an arc qualifies only when nothing is attached to it (no part with a real attach) and it is not itself
// attached to a moving stroke; arcs at the same radius (within RIPPLE_PHASE_RADIUS) and mirror arcs share one phase.
// The rig role is a preference: when at least RIPPLE_MIN_ARCS of the free arcs are parts, only parts ripple; else
// every free arc does (rss and wifi are made of core arcs, and rule 6 keeps them ripple).
function alRipple(S, T) {
  const candidates = [];
  for (let i = 0; i < S.length; i++) {
    const s = S[i];
    if (s.closed || s.length < RIPPLE_MIN_LEN) continue;
    const P = s.pts;
    if (P.length < 6) continue;
    const a = [P[0], P[1]];
    const b = [P[P.length - 2], P[P.length - 1]];
    const chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (chord < 0.5) continue;
    const mid = alMidPoint(P);
    const bulge = Math.abs((b[0] - a[0]) * (a[1] - mid[1]) - (a[0] - mid[0]) * (b[1] - a[1])) / chord;
    if (bulge < RIPPLE_BULGE) continue;
    const c = alCircumcenter(a, mid, b);
    if (!c) continue;
    candidates.push({ i, mid, center: c, radius: Math.hypot(mid[0] - c[0], mid[1] - c[1]) });
  }
  if (candidates.length < RIPPLE_MIN_ARCS) return null;
  let sx = 0;
  let sy = 0;
  for (const ar of candidates) {
    sx += ar.center[0];
    sy += ar.center[1];
  }
  const C = [sx / candidates.length, sy / candidates.length];
  for (const ar of candidates) if (Math.hypot(ar.center[0] - C[0], ar.center[1] - C[1]) > RIPPLE_CENTER_TOL) return null;
  // R15-6: an arc with a real attached child would leave the child behind when it shrinks; an arc that is itself
  // attached would leave its own contact point. Both are excluded.
  const hasChild = new Array(S.length).fill(false);
  for (let j = 0; j < S.length; j++) {
    const nd = T[j];
    if (nd && nd.parent >= 0 && nd.attach && nd.attach !== 'free') hasChild[nd.parent] = true;
  }
  const attached = (i) => !!(T[i] && T[i].attach && T[i].attach !== 'free');
  const free = candidates.filter((ar) => !hasChild[ar.i] && !attached(ar.i));
  if (free.length < RIPPLE_MIN_ARCS) return null;
  const parts = free.filter((ar) => T[ar.i] && T[ar.i].role === 'part');
  const arcs = parts.length >= RIPPLE_MIN_ARCS ? parts : free;
  arcs.sort((x, y) => x.radius - y.radius || x.i - y.i); // inner arc first
  return { kind: 'ripple', center: C, arcs };
}

// swing: a body with one long part at one end (search handle, key, bell clapper).
function alSwing(S, T) {
  let core = -1;
  let nCore = 0;
  for (let i = 0; i < S.length; i++) if (T[i].role === 'core') {
    core = i;
    nCore++;
  }
  if (nCore !== 1) return null;
  const parts = [];
  for (let i = 0; i < S.length; i++) if (i !== core) parts.push(i);
  if (parts.length < 1 || parts.length > SWING_MAX_PARTS) return null;
  const C = alCentroid(S[core].pts);
  const P = S[core].pts;
  let radius = 0;
  for (let k = 0; k < P.length; k += 2) radius = Math.max(radius, Math.hypot(P[k] - C[0], P[k + 1] - C[1]));
  for (const i of parts) {
    const s = S[i];
    if (s.length < SWING_MIN_PART_LEN) continue;
    const c = alCentroid(s.pts);
    if (Math.hypot(c[0] - C[0], c[1] - C[1]) >= SWING_OFF_CENTER * radius) return { kind: 'swing', body: core, center: C };
  }
  return null;
}

function classifyAlive(S, T) {
  const r = alRadiate(S, T);
  if (r) return r;
  const rp = alRipple(S, T);
  if (rp) return rp;
  const sw = alSwing(S, T);
  if (sw) return sw;
  return { kind: 'pop' };
}

// The stroke width of an icon in 24-grid units (0 = follow the instance option), for the renderer.
function alStrokeWidth(name) {
  if (typeof name !== 'string') return 0;
  try {
    const fam = getIconInfo(name).family;
    if (!fam || fam.kind === 'fill') return 0;
    const vbw = Number(String(fam.viewBox).split(/\s+/)[2]) || 24;
    const w = (fam.strokeWidth * 24) / vbw;
    return w > 0 && w !== 2 ? w : 0;
  } catch (e) {
    return 0;
  }
}

/**
 * R15-1/R15-2: a one-shot "alive" plan for hover. The plan draws the icon at frame(0) and frame(1) exactly and a
 * short life wiggle in between. It never changes the icon.
 * - radiate: alike parts around a center pulse out one by one; the core turns a little.
 * - ripple: open arcs sharing a center shrink to their midpoint and grow back, inner arc first.
 * - swing: a body with a long part at one end swings like a pendulum on a spring.
 * - pop (fallback): the whole icon dips, springs, and tilts.
 * @param {string|Array} name An icon name or an icon node.
 * @param {Object} [opts] Core knobs (`cornerAngle`, `chainGap`, `chainAngle`) are honored.
 * @returns {{kind: string, frame: Function, snapshot: Function, slots: Array, occludes: Function, occlusion: string, turn: number, duration: number, strokeWidth: number, linecap: string, linejoin: string}}
 */
function planAlive(name, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const S = iconToStrokes(name, o.cornerAngle, o.chainGap, o.chainAngle);
  if (!S || !S.length) throw new Error('planAlive: no strokes for the icon.');
  const T = S.tree || [];
  const kind = classifyAlive(S, T);

  // The rest polyline of each stroke. A closed stroke repeats its first point, so the drawn path closes.
  const RP = S.map((s) => {
    const P = s.pts;
    if (s.closed && P.length >= 2) {
      const out = new Float64Array(P.length + 2);
      out.set(P, 0);
      out[P.length] = P[0];
      out[P.length + 1] = P[1];
      return out;
    }
    return Float64Array.from(P);
  });

  // `X(i, t)` returns the points of stroke i at time t. Built per behavior; identity at t = 0 and t = 1.
  let X;
  if (kind.kind === 'radiate') {
    const C = kind.center;
    const spokes = kind.spokes;
    const spokeSet = new Set(spokes.map((sp) => sp.i));
    // One phase per mirror group (R15-3: mirror parts move alike), ordered around the circle.
    const groups = new Map();
    for (const sp of spokes) {
      const key = T[sp.i] && T[sp.i].pair >= 0 ? T[sp.i].pair : sp.i;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(sp);
    }
    const glist = [...groups.values()];
    glist.sort((a, b) => Math.min(...a.map((x) => x.angle)) - Math.min(...b.map((x) => x.angle)));
    const G = glist.length;
    const stagger = Math.min(ALIVE_STAGGER, ALIVE_MAX_OFFSET / Math.max(1, G - 1));
    const winLen = 1 - stagger * (G - 1);
    const offsetOf = new Map();
    glist.forEach((g, gi) => {
      const off = stagger * gi;
      for (const sp of g) offsetOf.set(sp.i, off);
    });
    // R15-7: a spoke that touches the core or a ring pulses about its contact point (the attached end stays put);
    // a free spoke pulses about its inner end.
    const pivotOf = new Map();
    for (const sp of spokes) {
      const nd = T[sp.i];
      if (nd && nd.attach && nd.attach !== 'free' && nd.parent >= 0 && nd.contact) {
        pivotOf.set(sp.i, [nd.contact[0], nd.contact[1]]);
      } else {
        const P = S[sp.i].pts;
        const n = P.length / 2;
        const d0 = Math.hypot(P[0] - C[0], P[1] - C[1]);
        const d1 = Math.hypot(P[2 * n - 2] - C[0], P[2 * n - 1] - C[1]);
        pivotOf.set(sp.i, d0 <= d1 ? [P[0], P[1]] : [P[2 * n - 2], P[2 * n - 1]]);
      }
    }
    // R15-8: every behavior composes child after parent. The root transform is the core turn; a spoke adds its
    // pulse on top of its parent's transform, so a part attached to a moving stroke rides it.
    const parentOf = new Array(S.length);
    for (let i = 0; i < S.length; i++) {
      const p = T[i] ? T[i].parent : -1;
      parentOf[i] = p >= 0 && p < S.length ? p : -1;
    }
    const turnKeys = [[0, 0], [0.4, ALIVE_RADIATE_TURN], [1, 0]];
    const pulseKeys = [[0, 0], [0.45, 1], [1, 0]];
    const localOf = (i, t) => {
      if (!spokeSet.has(i)) return null;
      const tau = alClamp((t - offsetOf.get(i)) / winLen);
      const k = 1 + ALIVE_RADIATE_GROWTH * alKeys(pulseKeys, tau);
      const p = pivotOf.get(i);
      return alScale(p[0], p[1], k);
    };
    let cacheT = NaN;
    let cacheA = null;
    const accum = (i, t) => {
      const hit = cacheA[i];
      if (hit) return hit;
      const local = localOf(i, t);
      const p = parentOf[i];
      const base = p >= 0 ? accum(p, t) : alRot(C[0], C[1], alKeys(turnKeys, t));
      const A = local ? alMul(base, local) : base;
      cacheA[i] = A;
      return A;
    };
    X = (i, t) => {
      if (t !== cacheT) {
        cacheT = t;
        cacheA = new Array(S.length);
      }
      return alApply(accum(i, t), RP[i]);
    };
  } else if (kind.kind === 'ripple') {
    const arcs = kind.arcs;
    const n = arcs.length;
    // R15-6: arcs at the same radius share one phase, and mirror arcs always share one phase.
    const uf = new Array(n);
    for (let k = 0; k < n; k++) uf[k] = k;
    const find = (k) => {
      while (uf[k] !== k) {
        uf[k] = uf[uf[k]];
        k = uf[k];
      }
      return k;
    };
    const union = (a, b) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) uf[ra] = rb;
    };
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        const sameRadius = Math.abs(arcs[a].radius - arcs[b].radius) <= RIPPLE_PHASE_RADIUS;
        const pairA = T[arcs[a].i] ? T[arcs[a].i].pair : -1;
        const pairB = T[arcs[b].i] ? T[arcs[b].i].pair : -1;
        const mirror = pairA >= 0 && pairA === pairB;
        if (sameRadius || mirror) union(a, b);
      }
    }
    const gindex = new Map();
    const glist = [];
    for (let k = 0; k < n; k++) {
      const r = find(k);
      if (!gindex.has(r)) {
        gindex.set(r, glist.length);
        glist.push({ rmin: arcs[k].radius, members: [] });
      }
      const gi = gindex.get(r);
      glist[gi].members.push(k);
      glist[gi].rmin = Math.min(glist[gi].rmin, arcs[k].radius);
    }
    glist.sort((a, b) => a.rmin - b.rmin); // inner arc first
    const phaseOf = new Array(n);
    glist.forEach((g, gi) => {
      for (const k of g.members) phaseOf[k] = gi;
    });
    const Gn = glist.length;
    const stagger = Math.min(ALIVE_STAGGER, ALIVE_MAX_OFFSET / Math.max(1, Gn - 1));
    const winLen = 1 - stagger * (Gn - 1);
    const idxOf = new Map(arcs.map((a, k) => [a.i, k]));
    const shrinkKeys = [[0, 1], [0.45, ALIVE_RIPPLE_MIN], [1, 1]];
    X = (i, t) => {
      const k = idxOf.get(i);
      if (k === undefined) return RP[i];
      const tau = alClamp((t - stagger * phaseOf[k]) / winLen);
      const mid = arcs[k].mid;
      return alApply(alScale(mid[0], mid[1], alKeys(shrinkKeys, tau)), RP[i]);
    };
  } else if (kind.kind === 'swing') {
    const C = kind.center;
    // Cap the angle so the farthest point stays within the R15-5 bound.
    let rmax = 0;
    for (const P of RP) for (let k = 0; k < P.length; k += 2) rmax = Math.max(rmax, Math.hypot(P[k] - C[0], P[k + 1] - C[1]));
    const maxRad = Math.max(Math.abs(ALIVE_SWING_BACK), Math.abs(ALIVE_SWING_FWD)) * ALIVE_DEG;
    const gain = rmax * maxRad > 1e-9 ? Math.min(1, ALIVE_BOUND / (rmax * maxRad)) : 1;
    const sKeys = [[0, 0], [0.3, ALIVE_SWING_BACK * gain], [0.62, ALIVE_SWING_FWD * gain], [1, 0]];
    X = (i, t) => alApply(alRot(C[0], C[1], alKeys(sKeys, t)), RP[i]);
  } else {
    const popKeys = [[0, 1], [0.25, ALIVE_POP_DIP], [0.55, ALIVE_POP_UP], [0.8, 0.985], [1, 1]];
    const tiltKeys = [[0, 0], [0.32, ALIVE_POP_TILT], [1, 0]];
    X = (i, t) => alApply(alMul(alScale(12, 12, alKeys(popKeys, t)), alRot(12, 12, alKeys(tiltKeys, t))), RP[i]);
  }

  const slots = S.map((s, i) => ({
    kind: 'alive',
    behavior: kind.kind,
    fromIndex: i,
    toIndex: i,
    weight: s.length,
    role: T[i] ? T[i].role : 'core',
    rank: i / Math.max(1, S.length - 1),
  }));

  const plan = {
    kind: kind.kind,
    slots,
    turn: 0,
    duration: 0,
    strokeWidth: alStrokeWidth(name),
    linecap: 'round',
    linejoin: 'round',
    occlusion: 'none',
    masks: false,
    occludes: () => false,
    twinOccludes: () => false,
    frame(t) {
      t = alClamp(t);
      const res = [];
      for (let i = 0; i < S.length; i++) {
        const d = alD(X(i, t));
        if (!d || d === 'M') continue;
        res.push({ d, opacity: 1, widthScale: 1, key: i * 4, slot: i, depth: i, occluder: false });
      }
      return res;
    },
    snapshot(t) {
      t = alClamp(t);
      const loops = [];
      for (let i = 0; i < S.length; i++) {
        const P = X(i, t);
        if (P.length < 4) continue;
        loops.push({ points: P, opacity: 1, widthScale: 1, vis: new Uint8Array(P.length / 2 - 1).fill(1) });
      }
      return { kind: 'snapshot', loops };
    },
  };
  return plan;
}

// Morphicon DOM layer. A small class and a custom element. Imports the pure core only.

const SVG_NS = 'http://www.w3.org/2000/svg';

const BASE = {
  size: 24,
  color: 'currentColor',
  strokeWidth: 2,
  duration: 450,
  easing: DEFAULTS.easing,
  respectReducedMotion: true,
  // R15-1: `hover: 'alive'` plays the life animation on pointer enter and on keyboard focus.
  hover: null,
  // R15-4: the alive animation is 600 ms by default.
  aliveDuration: 600,
};

const raf = (fn) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(() => fn(now()), 16));
const caf = (id) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id));
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function reducedMotion() {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) {
    return false;
  }
}

// R9b: the stroke style of the wrapper svg. A family with its own stroke width (not 2) and its own caps draws with them.
// A width of 2 is the Lucide width: it follows the instance option `strokeWidth`.
function styleFor(width, cap, join, o) {
  return { w: width > 0 && width !== 2 ? width : o.strokeWidth, cap: cap || 'round', join: join || 'round' };
}

// The style of an icon at rest (a name). Not a family icon, or a fill icon: the instance option and round caps.
function restStyle(name, o) {
  if (typeof name === 'string') {
    try {
      const f = getIconInfo(name).family;
      if (f && f.kind !== 'fill' && f.id !== 'lucide') {
        const fam = getFamily(f.id) || {};
        const vbw = Number(String(f.viewBox).split(/\s+/)[2]) || 24;
        return styleFor((f.strokeWidth * 24) / vbw, fam.linecap, fam.linejoin, o);
      }
    } catch (e) {
      // an unknown name: the default style
    }
  }
  return styleFor(0, 'round', 'round', o);
}

class MorphIcon {
  /**
   * @param {Element} target An <svg> element, or a container. A container gets an <svg> child.
   * @param {Object} [opts] name, size, color, strokeWidth, duration, easing, respectReducedMotion, plus core knobs.
   */
  constructor(target, opts = {}) {
    this.opts = { ...BASE, ...opts };
    this._name = null;
    this._raf = 0;
    this._run = null; // { plan, start, duration, resolve, t }
    this._hidden = false; // true when the icon is empty after hide()
    this._ownsSvg = false;
    if (target && target.namespaceURI === SVG_NS && target.tagName.toLowerCase() === 'svg') {
      this.svg = target;
    } else {
      this.svg = document.createElementNS(SVG_NS, 'svg');
      target.appendChild(this.svg);
      this._ownsSvg = true;
    }
    this._applySvgAttrs();
    if (this.opts.name) this.set(this.opts.name);
  }

  get name() {
    return this._name;
  }

  _applySvgAttrs() {
    const o = this.opts;
    const s = this.svg;
    s.setAttribute('xmlns', SVG_NS);
    s.setAttribute('width', String(o.size));
    s.setAttribute('height', String(o.size));
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', o.color);
    // R9b: while a plan runs, the wrapper has the stroke width and caps of the plan. At rest it has those of the icon.
    const st = this._run && this._run.style ? this._run.style : restStyle(this._name, o);
    s.setAttribute('stroke-width', String(st.w));
    s.setAttribute('stroke-linecap', st.cap);
    s.setAttribute('stroke-linejoin', st.join);
    s.style.overflow = 'visible'; // moving parts can pass over the 24 x 24 edge
  }

  /** Change instance options (size, color, strokeWidth, duration, easing, core knobs). */
  update(opts) {
    Object.assign(this.opts, opts);
    this._applySvgAttrs();
  }

  _cancel() {
    if (this._raf) caf(this._raf);
    this._raf = 0;
    const run = this._run;
    this._run = null;
    if (run) run.resolve(false);
  }

  _renderRest(name) {
    this._hidden = false;
    const st = restStyle(name, this.opts);
    this.svg.setAttribute('stroke-width', String(st.w));
    this.svg.setAttribute('stroke-linecap', st.cap);
    this.svg.setAttribute('stroke-linejoin', st.join);
    // R9-2: an icon of a `-s` set rests as its exact original fill nodes (scaled from their view box into the 24 grid).
    const rest = typeof name === 'string' ? getRestPicture(name) : null;
    if (rest) {
      const vbw = Number(rest.viewBox.split(' ')[2]) || 24;
      this.svg.innerHTML = '<g transform="scale(' + 24 / vbw + ')" fill="currentColor" stroke="none">' + iconInnerSVG(rest.nodes) + '</g>';
    } else this.svg.innerHTML = iconInnerSVG(name);
  }

  _renderEmpty() {
    this._hidden = true;
    this.svg.innerHTML = '';
  }

  /** Instant change, no animation. */
  set(name) {
    this._cancel();
    this._renderRest(name);
    this._name = name;
  }

  /**
   * Morph to another icon. Resolves true when the morph ends, false when a new call interrupts it.
   * On an empty icon (after hide) it is the same as show.
   * @param {string} name
   * @param {Object} [opts] Per-call options. They override the instance options.
   * @returns {Promise<boolean>}
   */
  morphTo(name, opts = {}) {
    const o = { ...this.opts, ...opts };
    try {
      if (this._hidden || (this._name === null && this._run)) return this.show(name, opts);
      if (this._name === null) {
        this.set(name);
        return Promise.resolve(true);
      }
      if (name === this._name) return Promise.resolve(true);
      const duration = this._duration(o);
      if (duration <= 0) {
        this.set(name);
        return Promise.resolve(true);
      }
      const { from, easing } = this._source(o);
      return this._play(planMorph(from, name, { ...o, easing }), duration, name, o);
    } catch (e) {
      return Promise.reject(e);
    }
  }

  /**
   * Disappear with an effect: 'implode' (default), 'explode', 'draw' (it erases), 'scale'. The icon is empty after it.
   * Resolves true when the effect ends, false when a new call interrupts it.
   * @param {Object} [opts] `effect`, plus per-call options.
   * @returns {Promise<boolean>}
   */
  hide(opts = {}) {
    const o = { ...this.opts, ...opts };
    try {
      if (this._hidden || this._name === null) return Promise.resolve(true);
      const duration = this._duration(o);
      if (duration <= 0) {
        this._cancel();
        this._name = null;
        this._renderEmpty();
        return Promise.resolve(true);
      }
      const { from } = this._source(o);
      const plan = planEffect(from, 'out', o.effect || 'implode', o);
      return this._play(plan, duration, null, o);
    } catch (e) {
      return Promise.reject(e);
    }
  }

  /**
   * Appear with an effect: 'expand' (default), 'assemble', 'draw', 'scale'. It works on an empty icon. On an icon
   * that shows something, it is the same as morphTo.
   * @param {string} name
   * @param {Object} [opts] `effect`, plus per-call options.
   * @returns {Promise<boolean>}
   */
  show(name, opts = {}) {
    const o = { ...this.opts, ...opts };
    try {
      if (this._name !== null) return this.morphTo(name, opts);
      const duration = this._duration(o);
      if (duration <= 0) {
        this.set(name);
        return Promise.resolve(true);
      }
      if (this._run) {
        // A hide runs now. Morph from its current picture. The shape is not empty yet.
        const { from } = this._source(o);
        return this._play(planMorph(from, name, { ...o, easing: 'easeOutCubic' }), duration, name, o);
      }
      this._renderEmpty();
      return this._play(planEffect(name, 'in', o.effect || 'expand', o), duration, name, o);
    } catch (e) {
      return Promise.reject(e);
    }
  }

  _duration(o) {
    return o.respectReducedMotion !== false && reducedMotion() ? 0 : o.duration;
  }

  /**
   * R15-1: play the one-shot "alive" life animation for the current icon. The icon is unchanged at the end.
   * It does nothing while reduced motion is on, while a morph is playing (a morph wins), or while an alive run
   * is already playing (it is not restarted). Safe to call from a pointerenter or focus handler.
   * @param {Object} [opts] Per-call options (`aliveDuration`, `respectReducedMotion`, core knobs).
   * @returns {Promise<boolean>} true when the run ends, false when it does not play.
   */
  playAlive(opts = {}) {
    const o = { ...this.opts, ...opts };
    if (this._name == null || this._hidden) return Promise.resolve(false);
    if (o.respectReducedMotion !== false && reducedMotion()) return Promise.resolve(false);
    // A morph that is playing wins over the alive animation; an alive run already playing is not restarted.
    if (this._run) return Promise.resolve(false);
    const duration = Number.isFinite(o.aliveDuration) ? o.aliveDuration : 600;
    if (duration <= 0) return Promise.resolve(false);
    let plan;
    try {
      plan = planAlive(this._name, o);
    } catch (e) {
      return Promise.resolve(false);
    }
    return this._play(plan, duration, this._name, o, { alive: true });
  }

  // The start of a new plan: the icon name, or the exact picture of the plan that runs now (an interruption).
  _source(o) {
    const prev = this._run;
    if (prev) return { from: prev.plan.snapshot(prev.t), easing: 'easeOutCubic' };
    return { from: this._name, easing: o.easing };
  }

  // Run a plan with requestAnimationFrame. `endName` is the icon at the end (null: empty).
  _play(plan, duration, endName, o, meta) {
    this._cancel();
    this._name = endName;
    this._hidden = false;
    // R9b: draw the plan at its own width and caps: the wrapper gets them, and the renderer uses the same width as its base.
    const style = styleFor(plan.strokeWidth, plan.linecap, plan.linejoin, o);
    const ro = { occlusion: o.occlusion, strokeWidth: style.w, baseWidth: style.w, linecap: style.cap, linejoin: style.join };
    return new Promise((resolve) => {
      this._run = { plan, start: now(), duration, resolve, t: 0, style, alive: !!(meta && meta.alive) };
      this.svg.setAttribute('stroke-width', String(style.w));
      this.svg.setAttribute('stroke-linecap', style.cap);
      this.svg.setAttribute('stroke-linejoin', style.join);
      this._draw(plan, 0, ro);
      const tick = () => {
        const run = this._run;
        if (!run || run.plan !== plan) return;
        const t = Math.min(1, (now() - run.start) / run.duration);
        run.t = t;
        if (t >= 1) {
          this._run = null;
          this._raf = 0;
          if (endName === null) this._renderEmpty();
          else this._renderRest(endName);
          resolve(true);
          return;
        }
        this._draw(plan, t, ro);
        this._raf = raf(tick);
      };
      this._raf = raf(tick);
    });
  }

  // Every frame goes through render.js: back to front, with masks for the shapes that go behind.
  _draw(plan, t, ro) {
    renderInto(this.svg, plan.frame(t), plan, ro);
  }

  destroy() {
    this._cancel();
    if (this._ownsSvg && this.svg.parentNode) this.svg.parentNode.removeChild(this.svg);
    else this.svg.innerHTML = '';
  }
}

const NUM_ATTRS = { size: 'size', duration: 'duration', stagger: 'stagger' };

/**
 * Register the custom element.
 * @param {string} [tagName]
 */
function defineMorphIcon(tagName = 'morph-icon') {
  if (typeof customElements === 'undefined' || typeof HTMLElement === 'undefined') return null;
  const existing = customElements.get(tagName);
  if (existing) return existing;

  class MorphIconElement extends HTMLElement {
    static get observedAttributes() {
      return ['name', 'size', 'color', 'stroke-width', 'duration', 'easing', 'stagger', 'effect', 'hover'];
    }

    get name() {
      return this.getAttribute('name');
    }

    set name(v) {
      if (v == null) this.removeAttribute('name');
      else this.setAttribute('name', String(v));
    }

    _optsFromAttrs() {
      const o = {};
      for (const a of Object.keys(NUM_ATTRS)) {
        if (this.hasAttribute(a)) o[a] = Number(this.getAttribute(a));
      }
      if (this.hasAttribute('color')) o.color = this.getAttribute('color');
      if (this.hasAttribute('stroke-width')) o.strokeWidth = Number(this.getAttribute('stroke-width'));
      if (this.hasAttribute('easing')) o.easing = this.getAttribute('easing');
      if (this.hasAttribute('effect')) o.effect = this.getAttribute('effect');
      if (this.hasAttribute('hover')) o.hover = this.getAttribute('hover');
      return o;
    }

    connectedCallback() {
      if (!this.style.display) this.style.display = 'inline-block';
      if (!this.style.lineHeight) this.style.lineHeight = '0';
      if (!this._mi) {
        const existing = this.querySelector(':scope > svg');
        this._mi = new MorphIcon(existing || this, this._optsFromAttrs());
        const name = this.getAttribute('name');
        if (name) this._mi.set(name);
        else if (this.hasAttribute('name')) this._mi._hidden = true; // an empty name: the first name after it shows with the effect
      }
      this._wireHover();
    }

    // R15-1: the element, or its nearest button or link ancestor, gets a pointerenter and a focus handler.
    _nearestFocusable() {
      for (let el = this; el; el = el.parentElement) {
        const tag = el.tagName ? el.tagName.toLowerCase() : '';
        if (tag === 'button' || tag === 'a' || tag === 'input' || tag === 'select' || tag === 'textarea') return el;
        if (el.hasAttribute && (el.hasAttribute('tabindex') || el.getAttribute('role') === 'button')) return el;
      }
      return null;
    }

    _wireHover() {
      if (this._hoverWired) return;
      this._hoverWired = true;
      this._onAlive = () => {
        const mi = this._mi;
        if (mi && mi.opts.hover === 'alive') mi.playAlive().catch(() => {});
      };
      this.addEventListener('pointerenter', this._onAlive);
      const host = this._nearestFocusable();
      if (host && host !== this) {
        host.addEventListener('focus', this._onAlive);
        this._focusHost = host;
      } else {
        this.addEventListener('focus', this._onAlive);
      }
    }

    disconnectedCallback() {
      // Keep the instance. The element can come back. Stop any running frame.
      if (this._mi) this._mi._cancel();
    }

    attributeChangedCallback(attr, oldV, newV) {
      const mi = this._mi;
      if (!mi || this._silent) return;
      if (attr === 'name') {
        // An empty name hides with the effect attribute (default implode). A name after empty shows with it (default expand).
        const p = newV ? mi.morphTo(newV) : mi.hide();
        p.catch((e) => console.error(e));
        return;
      }
      mi.update(this._optsFromAttrs());
    }

    /** Morph to another icon. Same as setting the name, but returns the Promise. */
    morphTo(name, opts) {
      if (!this._mi) this.connectedCallback();
      this._silent = true;
      this.setAttribute('name', name);
      this._silent = false;
      return this._mi.morphTo(name, opts);
    }

    /** Disappear with an effect (default: the effect attribute, else 'implode'). Sets the name to empty. */
    hide(opts) {
      if (!this._mi) this.connectedCallback();
      this._silent = true;
      this.setAttribute('name', '');
      this._silent = false;
      return this._mi.hide(opts);
    }

    /** Appear with an effect (default: the effect attribute, else 'expand'). */
    show(name, opts) {
      if (!this._mi) this.connectedCallback();
      this._silent = true;
      this.setAttribute('name', name);
      this._silent = false;
      return this._mi.show(name, opts);
    }

    /** R15-1: play the one-shot alive animation for the current icon (same as `hover="alive"` does on hover). */
    playAlive(opts) {
      if (!this._mi) this.connectedCallback();
      return this._mi.playAlive(opts);
    }
  }

  customElements.define(tagName, MorphIconElement);
  return MorphIconElement;
}

/**
 * R15-1: wire the alive animation onto an element for code use. On pointer enter and on keyboard focus of the
 * element or of its nearest button or link ancestor, the MorphIcon's icon comes to life once.
 * @param {MorphIcon|Element} el A MorphIcon instance, or a `<morph-icon>` element (or any element that owns one).
 * @param {Object} [opts] Per-call options for `playAlive`.
 * @returns {Function} a cleanup that removes the listeners.
 */
function alive(el, opts = {}) {
  const mi = el instanceof MorphIcon ? el : el && el._mi;
  const target = el instanceof MorphIcon ? el.svg : el;
  if (!mi || !target || typeof target.addEventListener !== 'function') return () => {};
  const fn = () => {
    mi.playAlive(opts).catch(() => {});
  };
  target.addEventListener('pointerenter', fn);
  let host = null;
  for (let e = target; e; e = e.parentElement) {
    const tag = e.tagName ? e.tagName.toLowerCase() : '';
    if (tag === 'button' || tag === 'a' || tag === 'input' || tag === 'select' || tag === 'textarea') {
      host = e;
      break;
    }
    if (e.hasAttribute && (e.hasAttribute('tabindex') || e.getAttribute('role') === 'button')) {
      host = e;
      break;
    }
  }
  (host || target).addEventListener('focus', fn);
  return () => {
    target.removeEventListener('pointerenter', fn);
    (host || target).removeEventListener('focus', fn);
  };
}

function registerFamilyFile(json) {
  const fam = typeof json === 'string' ? JSON.parse(json) : json;
  if (!fam || !fam.id || !fam.icons) throw new Error('registerFamilyFile: expected { id, kind, viewBox, strokeWidth, icons }.');
  if (typeof registerFamily !== 'function') throw new Error('registerFamilyFile: js has no registerFamily yet.');
  return registerFamily(fam);
}

/**
 * Register only some icons of a family. `family` is a family id of the package (`'tabler-outline'`, `'phosphor-regular-s'`, ...)
 * or a family spec without icons. `icons` maps a name to what the family module exports for it. Names are then `<id>:<name>`.
 *   import { bell, bellOff } from 'shape-aware-morph/tabler-outline';
 *   registerFamilyIcons('tabler-outline', { bell, 'bell-off': bellOff });
 */
function registerFamilyIcons(family, icons) {
  const meta = typeof family === 'string' ? FAMILY_META[family] : family;
  if (!meta || !meta.id) throw new Error('registerFamilyIcons: unknown family "' + family + '". Known: ' + Object.keys(FAMILY_META).join(', ') + '.');
  if (!icons || typeof icons !== 'object') throw new Error('registerFamilyIcons: icons must be an object of name to icon.');
  return registerFamily({ ...meta, icons });
}

// ---------------------------------------------------------------------------
// R7-B: the cross planner. A stroke icon to a fill icon (or the reverse) is not a morph yet: the old icon implodes
// over [0, 0.5] and the new icon expands over [0.5, 1]. The plan has the plan API and `crossKind = true`.
// ---------------------------------------------------------------------------

// 'stroke' or 'fill' for a name, an icon node, an icon info, or a snapshot. Also the family stroke width (stroke only).
function sideInfo(src) {
  if (src && src.kind === 'snapshot') return { kind: src.fill || (src.family && src.family.kind === 'fill') ? 'fill' : 'stroke', strokeWidth: 0 };
  if (Array.isArray(src)) return { kind: 'stroke', strokeWidth: 0 };
  let info = null;
  if (src && src.nodes) info = src;
  else if (typeof src === 'string' && typeof getIconInfo === 'function') info = getIconInfo(src);
  const fam = (info && info.family) || {};
  return { kind: fam.kind === 'fill' ? 'fill' : 'stroke', strokeWidth: fam.strokeWidth > 0 ? fam.strokeWidth : 0 };
}

function halfPlan(src, dir, opts, effect = 'implode') {
  const side = sideInfo(src);
  const plan = side.kind === 'fill' ? planFillEffect(src, dir, effect, opts) : planEffect(src, dir, effect, opts);
  return { plan, side };
}

/**
 * The sequence plan of R7-B. `from` and `to` are what planMorph got (name, icon node, icon info, or snapshot).
 * @param {string|Array|Object} from
 * @param {string|Array|Object} to
 * @param {Object} [opts]
 */
function planCross(from, to, opts = {}, effect = 'implode') {
  const a = halfPlan(from, 'out', opts, effect);
  const b = halfPlan(to, 'in', opts, effect);
  const na = a.plan.slots.length;
  const stamp = (entries, side, plan, slotOffset) =>
    entries.map((e) => {
      const r = { ...e, slot: e.slot + slotOffset, key: e.key + slotOffset * 4 };
      // R9b: an entry of a stroke side without its own width gets its absolute width (the plan width, else the family width, x widthScale).
      const base = plan.strokeWidth > 0 ? plan.strokeWidth : side.strokeWidth;
      if (side.kind === 'stroke' && base > 0 && r.strokeWidth == null) r.strokeWidth = base * (Number.isFinite(e.widthScale) ? e.widthScale : 1);
      return r;
    });
  const norm = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
  const first = (t) => t < 0.5;
  return {
    slots: [...a.plan.slots, ...b.plan.slots],
    turn: 0,
    duration: 0,
    crossKind: true,
    // R9b: the caps and joins of the stroke side (a cross plan has one stroke side).
    linecap: a.plan.linecap || b.plan.linecap || 'round',
    linejoin: a.plan.linejoin || b.plan.linejoin || 'round',
    occlusion: 'none',
    occludes(i, j) {
      if (i < na && j < na) return a.plan.occludes ? a.plan.occludes(i, j) : false;
      if (i >= na && j >= na) return b.plan.occludes ? b.plan.occludes(i - na, j - na) : false;
      return false;
    },
    frame(t) {
      t = norm(t);
      return first(t) ? stamp(a.plan.frame(2 * t), a.side, a.plan, 0) : stamp(b.plan.frame(2 * t - 1), b.side, b.plan, na);
    },
    snapshot(t) {
      t = norm(t);
      return first(t) ? a.plan.snapshot(2 * t) : b.plan.snapshot(2 * t - 1);
    },
  };
}

// ---------------------------------------------------------------------------
// R9-2: the planner of two fill icons. `solidMode` picks the plan:
//   'morph' (default): the region morph of regions.js (round 7b and 8), unchanged.
//   'explode': one plan. The old icon explodes over [0, 0.5], the new icon assembles over [0.5, 1] (effects 'explode' and 'assemble').
//   'implode': the old icon implodes over [0, 0.5], the new icon expands over [0.5, 1].
// Both sequence plans are built with planCross (the same sequence as the cross plan) and say so: `crossKind: true`, `solidMode`.
// ---------------------------------------------------------------------------
function planSolid(from, to, opts = {}) {
  const mode = opts && opts.solidMode ? opts.solidMode : 'morph';
  if (mode === 'morph' || opts.styleToggle) return planFill(from, to, opts); // a style toggle (the same icon in two styles) always morphs
  if (mode !== 'explode' && mode !== 'implode') throw new Error("planSolid: solidMode must be 'morph', 'explode', or 'implode' (got '" + mode + "').");
  const plan = planCross(from, to, opts, mode);
  plan.solidMode = mode;
  return plan;
}

// Register with the core when it has the hooks (js and regions.js do not import each other).
if (typeof getIconInfo === 'function') setIconResolver(getIconInfo);
if (typeof setFillPlanner === 'function') setFillPlanner(planSolid);
if (typeof setCrossPlanner === 'function') setCrossPlanner(planCross);

registerIcons({"a-arrow-down":[["path",{"d":"m14 12 4 4 4-4"}],["path",{"d":"M18 16V7"}],["path",{"d":"m2 16 4.039-9.69a.5.5 0 0 1 .923 0L11 16"}],["path",{"d":"M3.304 13h6.392"}]],"a-arrow-up":[["path",{"d":"m14 11 4-4 4 4"}],["path",{"d":"M18 16V7"}],["path",{"d":"m2 16 4.039-9.69a.5.5 0 0 1 .923 0L11 16"}],["path",{"d":"M3.304 13h6.392"}]],"a-large-small":[["path",{"d":"m15 16 2.536-7.328a1.02 1.02 1 0 1 1.928 0L22 16"}],["path",{"d":"M15.697 14h5.606"}],["path",{"d":"m2 16 4.039-9.69a.5.5 0 0 1 .923 0L11 16"}],["path",{"d":"M3.304 13h6.392"}]],"accessibility":[["circle",{"cx":"16","cy":"4","r":"1"}],["path",{"d":"m18 19 1-7-6 1"}],["path",{"d":"m5 8 3-3 5.5 3-2.36 3.5"}],["path",{"d":"M4.24 14.5a5 5 0 0 0 6.88 6"}],["path",{"d":"M13.76 17.5a5 5 0 0 0-6.88-6"}]],"activity":[["path",{"d":"M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"}]],"ad":[["path",{"d":"M10 13H6"}],["path",{"d":"M10 15v-4a2 2 0 0 0-4 0v4"}],["path",{"d":"M14 14.5a.5.5 0 0 0 .5.5h1a2.5 2.5 0 0 0 2.5-2.5v-1A2.5 2.5 0 0 0 15.5 9h-1a.5.5 0 0 0-.5.5z"}],["rect",{"x":"2","y":"5","width":"20","height":"14","rx":"2"}]],"air-vent":[["path",{"d":"M18 17.5a2.5 2.5 0 1 1-4 2.03V12"}],["path",{"d":"M6 12H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"}],["path",{"d":"M6 8h12"}],["path",{"d":"M6.6 15.572A2 2 0 1 0 10 17v-5"}]],"airplay":[["path",{"d":"M5 17H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-1"}],["path",{"d":"m12 15 5 6H7Z"}]],"alarm-clock-check":[["circle",{"cx":"12","cy":"13","r":"8"}],["path",{"d":"M5 3 2 6"}],["path",{"d":"m22 6-3-3"}],["path",{"d":"M6.38 18.7 4 21"}],["path",{"d":"M17.64 18.67 20 21"}],["path",{"d":"m9 13 2 2 4-4"}]],"alarm-clock-minus":[["circle",{"cx":"12","cy":"13","r":"8"}],["path",{"d":"M5 3 2 6"}],["path",{"d":"m22 6-3-3"}],["path",{"d":"M6.38 18.7 4 21"}],["path",{"d":"M17.64 18.67 20 21"}],["path",{"d":"M9 13h6"}]],"alarm-clock-off":[["path",{"d":"M6.87 6.87a8 8 0 1 0 11.26 11.26"}],["path",{"d":"M19.9 14.25a8 8 0 0 0-9.15-9.15"}],["path",{"d":"m22 6-3-3"}],["path",{"d":"M6.26 18.67 4 21"}],["path",{"d":"m2 2 20 20"}],["path",{"d":"M4 4 2 6"}]],"alarm-clock-plus":[["circle",{"cx":"12","cy":"13","r":"8"}],["path",{"d":"M5 3 2 6"}],["path",{"d":"m22 6-3-3"}],["path",{"d":"M6.38 18.7 4 21"}],["path",{"d":"M17.64 18.67 20 21"}],["path",{"d":"M12 10v6"}],["path",{"d":"M9 13h6"}]],"alarm-clock":[["circle",{"cx":"12","cy":"13","r":"8"}],["path",{"d":"M12 9v4l2 2"}],["path",{"d":"M5 3 2 6"}],["path",{"d":"m22 6-3-3"}],["path",{"d":"M6.38 18.7 4 21"}],["path",{"d":"M17.64 18.67 20 21"}]],"alarm-smoke":[["path",{"d":"M11 21c0-2.5 2-2.5 2-5"}],["path",{"d":"M16 21c0-2.5 2-2.5 2-5"}],["path",{"d":"m19 8-.8 3a1.25 1.25 0 0 1-1.2 1H7a1.25 1.25 0 0 1-1.2-1L5 8"}],["path",{"d":"M21 3a1 1 0 0 1 1 1v2a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a1 1 0 0 1 1-1z"}],["path",{"d":"M6 21c0-2.5 2-2.5 2-5"}]],"align-center-horizontal":[["path",{"d":"M2 12h20"}],["path",{"d":"M10 16v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-4"}],["path",{"d":"M10 8V4a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v4"}],["path",{"d":"M20 16v1a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2v-1"}],["path",{"d":"M14 8V7c0-1.1.9-2 2-2h2a2 2 0 0 1 2 2v1"}]],"align-center-vertical":[["path",{"d":"M12 2v20"}],["path",{"d":"M8 10H4a2 2 0 0 1-2-2V6c0-1.1.9-2 2-2h4"}],["path",{"d":"M16 10h4a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-4"}],["path",{"d":"M8 20H7a2 2 0 0 1-2-2v-2c0-1.1.9-2 2-2h1"}],["path",{"d":"M16 14h1a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-1"}]],"align-end-horizontal":[["rect",{"width":"6","height":"16","x":"4","y":"2","rx":"2"}],["rect",{"width":"6","height":"9","x":"14","y":"9","rx":"2"}],["path",{"d":"M22 22H2"}]],"align-end-vertical":[["rect",{"width":"16","height":"6","x":"2","y":"4","rx":"2"}],["rect",{"width":"9","height":"6","x":"9","y":"14","rx":"2"}],["path",{"d":"M22 22V2"}]],"align-horizontal-distribute-center":[["rect",{"width":"6","height":"14","x":"4","y":"5","rx":"2"}],["rect",{"width":"6","height":"10","x":"14","y":"7","rx":"2"}],["path",{"d":"M17 22v-5"}],["path",{"d":"M17 7V2"}],["path",{"d":"M7 22v-3"}],["path",{"d":"M7 5V2"}]],"align-horizontal-distribute-end":[["rect",{"width":"6","height":"14","x":"4","y":"5","rx":"2"}],["rect",{"width":"6","height":"10","x":"14","y":"7","rx":"2"}],["path",{"d":"M10 2v20"}],["path",{"d":"M20 2v20"}]],"align-horizontal-distribute-start":[["rect",{"width":"6","height":"14","x":"4","y":"5","rx":"2"}],["rect",{"width":"6","height":"10","x":"14","y":"7","rx":"2"}],["path",{"d":"M4 2v20"}],["path",{"d":"M14 2v20"}]],"align-horizontal-justify-center":[["rect",{"width":"6","height":"14","x":"2","y":"5","rx":"2"}],["rect",{"width":"6","height":"10","x":"16","y":"7","rx":"2"}],["path",{"d":"M12 2v20"}]],"align-horizontal-justify-end":[["rect",{"width":"6","height":"14","x":"2","y":"5","rx":"2"}],["rect",{"width":"6","height":"10","x":"12","y":"7","rx":"2"}],["path",{"d":"M22 2v20"}]],"align-horizontal-justify-start":[["rect",{"width":"6","height":"14","x":"6","y":"5","rx":"2"}],["rect",{"width":"6","height":"10","x":"16","y":"7","rx":"2"}],["path",{"d":"M2 2v20"}]],"align-horizontal-space-around":[["rect",{"width":"6","height":"10","x":"9","y":"7","rx":"2"}],["path",{"d":"M4 22V2"}],["path",{"d":"M20 22V2"}]],"align-horizontal-space-between":[["rect",{"width":"6","height":"14","x":"3","y":"5","rx":"2"}],["rect",{"width":"6","height":"10","x":"15","y":"7","rx":"2"}],["path",{"d":"M3 2v20"}],["path",{"d":"M21 2v20"}]],"align-start-horizontal":[["rect",{"width":"6","height":"16","x":"4","y":"6","rx":"2"}],["rect",{"width":"6","height":"9","x":"14","y":"6","rx":"2"}],["path",{"d":"M22 2H2"}]],"align-start-vertical":[["rect",{"width":"9","height":"6","x":"6","y":"14","rx":"2"}],["rect",{"width":"16","height":"6","x":"6","y":"4","rx":"2"}],["path",{"d":"M2 2v20"}]],"align-vertical-distribute-center":[["path",{"d":"M22 17h-3"}],["path",{"d":"M22 7h-5"}],["path",{"d":"M5 17H2"}],["path",{"d":"M7 7H2"}],["rect",{"x":"5","y":"14","width":"14","height":"6","rx":"2"}],["rect",{"x":"7","y":"4","width":"10","height":"6","rx":"2"}]],"align-vertical-distribute-end":[["rect",{"width":"14","height":"6","x":"5","y":"14","rx":"2"}],["rect",{"width":"10","height":"6","x":"7","y":"4","rx":"2"}],["path",{"d":"M2 20h20"}],["path",{"d":"M2 10h20"}]],"align-vertical-distribute-start":[["rect",{"width":"14","height":"6","x":"5","y":"14","rx":"2"}],["rect",{"width":"10","height":"6","x":"7","y":"4","rx":"2"}],["path",{"d":"M2 14h20"}],["path",{"d":"M2 4h20"}]],"align-vertical-justify-center":[["rect",{"width":"14","height":"6","x":"5","y":"16","rx":"2"}],["rect",{"width":"10","height":"6","x":"7","y":"2","rx":"2"}],["path",{"d":"M2 12h20"}]],"align-vertical-justify-end":[["rect",{"width":"14","height":"6","x":"5","y":"12","rx":"2"}],["rect",{"width":"10","height":"6","x":"7","y":"2","rx":"2"}],["path",{"d":"M2 22h20"}]],"align-vertical-justify-start":[["rect",{"width":"14","height":"6","x":"5","y":"16","rx":"2"}],["rect",{"width":"10","height":"6","x":"7","y":"6","rx":"2"}],["path",{"d":"M2 2h20"}]],"align-vertical-space-around":[["rect",{"width":"10","height":"6","x":"7","y":"9","rx":"2"}],["path",{"d":"M22 20H2"}],["path",{"d":"M22 4H2"}]],"align-vertical-space-between":[["rect",{"width":"14","height":"6","x":"5","y":"15","rx":"2"}],["rect",{"width":"10","height":"6","x":"7","y":"3","rx":"2"}],["path",{"d":"M2 21h20"}],["path",{"d":"M2 3h20"}]],"ambulance":[["path",{"d":"M10 10H6"}],["path",{"d":"M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"}],["path",{"d":"M19 18h2a1 1 0 0 0 1-1v-3.28a1 1 0 0 0-.684-.948l-1.923-.641a1 1 0 0 1-.578-.502l-1.539-3.076A1 1 0 0 0 16.382 8H14"}],["path",{"d":"M8 8v4"}],["path",{"d":"M9 18h6"}],["circle",{"cx":"17","cy":"18","r":"2"}],["circle",{"cx":"7","cy":"18","r":"2"}]],"ampersand":[["path",{"d":"M16 12h3"}],["path",{"d":"M17.5 12a8 8 0 0 1-8 8A4.5 4.5 0 0 1 5 15.5c0-6 8-4 8-8.5a3 3 0 1 0-6 0c0 3 2.5 8.5 12 13"}]],"ampersands":[["path",{"d":"M10 17c-5-3-7-7-7-9a2 2 0 0 1 4 0c0 2.5-5 2.5-5 6 0 1.7 1.3 3 3 3 2.8 0 5-2.2 5-5"}],["path",{"d":"M22 17c-5-3-7-7-7-9a2 2 0 0 1 4 0c0 2.5-5 2.5-5 6 0 1.7 1.3 3 3 3 2.8 0 5-2.2 5-5"}]],"amphora":[["path",{"d":"M10 2v5.632c0 .424-.272.795-.653.982A6 6 0 0 0 6 14c.006 4 3 7 5 8"}],["path",{"d":"M10 5H8a2 2 0 0 0 0 4h.68"}],["path",{"d":"M14 2v5.632c0 .424.272.795.652.982A6 6 0 0 1 18 14c0 4-3 7-5 8"}],["path",{"d":"M14 5h2a2 2 0 0 1 0 4h-.68"}],["path",{"d":"M18 22H6"}],["path",{"d":"M9 2h6"}]],"anchor":[["path",{"d":"M12 6v16"}],["path",{"d":"m19 13 2-1a9 9 0 0 1-18 0l2 1"}],["path",{"d":"M9 11h6"}],["circle",{"cx":"12","cy":"4","r":"2"}]],"angle":[["path",{"d":"M3 3v16a2 2 0 0 0 2 2h16"}],["path",{"d":"M3 11a10 10 0 0 1 10 10"}]],"antenna":[["path",{"d":"M2 12 7 2"}],["path",{"d":"m7 12 5-10"}],["path",{"d":"m12 12 5-10"}],["path",{"d":"m17 12 5-10"}],["path",{"d":"M4.5 7h15"}],["path",{"d":"M12 16v6"}]],"anvil":[["path",{"d":"M7 10H6a4 4 0 0 1-4-4 1 1 0 0 1 1-1h4"}],["path",{"d":"M7 5a1 1 0 0 1 1-1h13a1 1 0 0 1 1 1 7 7 0 0 1-7 7H8a1 1 0 0 1-1-1z"}],["path",{"d":"M9 12v5"}],["path",{"d":"M15 12v5"}],["path",{"d":"M5 20a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3 1 1 0 0 1-1 1H6a1 1 0 0 1-1-1"}]],"aperture":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"m14.31 8 5.74 9.94"}],["path",{"d":"M9.69 8h11.48"}],["path",{"d":"m7.38 12 5.74-9.94"}],["path",{"d":"M9.69 16 3.95 6.06"}],["path",{"d":"M14.31 16H2.83"}],["path",{"d":"m16.62 12-5.74 9.94"}]],"app-window-mac":[["rect",{"width":"20","height":"16","x":"2","y":"4","rx":"2"}],["path",{"d":"M6 8h.01"}],["path",{"d":"M10 8h.01"}],["path",{"d":"M14 8h.01"}]],"app-window":[["rect",{"x":"2","y":"4","width":"20","height":"16","rx":"2"}],["path",{"d":"M10 4v4"}],["path",{"d":"M2 8h20"}],["path",{"d":"M6 4v4"}]],"apple":[["path",{"d":"M12 6.528V3a1 1 0 0 1 1-1h0"}],["path",{"d":"M18.237 21A15 15 0 0 0 22 11a6 6 0 0 0-10-4.472A6 6 0 0 0 2 11a15.1 15.1 0 0 0 3.763 10 3 3 0 0 0 3.648.648 5.5 5.5 0 0 1 5.178 0A3 3 0 0 0 18.237 21"}]],"archive-restore":[["rect",{"width":"20","height":"5","x":"2","y":"3","rx":"1"}],["path",{"d":"M4 8v11a2 2 0 0 0 2 2h2"}],["path",{"d":"M20 8v11a2 2 0 0 1-2 2h-2"}],["path",{"d":"m9 15 3-3 3 3"}],["path",{"d":"M12 12v9"}]],"archive-x":[["rect",{"width":"20","height":"5","x":"2","y":"3","rx":"1"}],["path",{"d":"M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"}],["path",{"d":"m9.5 17 5-5"}],["path",{"d":"m9.5 12 5 5"}]],"archive":[["rect",{"width":"20","height":"5","x":"2","y":"3","rx":"1"}],["path",{"d":"M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"}],["path",{"d":"M10 12h4"}]],"armchair":[["path",{"d":"M19 9V6a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v3"}],["path",{"d":"M3 16a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5a2 2 0 0 0-4 0v1.5a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5V11a2 2 0 0 0-4 0z"}],["path",{"d":"M5 18v2"}],["path",{"d":"M19 18v2"}]],"arrow-big-down-dash":[["path",{"d":"M14 8a1 1 0 0 1 1 1v2a1 1 0 0 0 1 1h3.293a.707.707 0 0 1 .5 1.207l-6.939 6.939a1.207 1.207 0 0 1-1.708 0l-6.94-6.94a.707.707 0 0 1 .5-1.206H8a1 1 0 0 0 1-1V9a1 1 0 0 1 1-1z"}],["path",{"d":"M9 4h6"}]],"arrow-big-down":[["path",{"d":"M9 5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v6a1 1 0 0 0 1 1h3.293a.707.707 0 0 1 .5 1.207l-7.086 7.086a1 1 0 0 1-1.414 0l-7.086-7.086a.707.707 0 0 1 .5-1.207H8a1 1 0 0 0 1-1z"}]],"arrow-big-left-dash":[["path",{"d":"M13 9a1 1 0 0 1-1-1V4.707a.707.707 0 0 0-1.207-.5l-6.94 6.94a1.207 1.207 0 0 0 0 1.707l6.94 6.94a.707.707 0 0 0 1.207-.5V16a1 1 0 0 1 1-1h2a1 1 0 0 0 1-1v-4a1 1 0 0 0-1-1z"}],["path",{"d":"M20 9v6"}]],"arrow-big-left":[["path",{"d":"M10.793 19.793a.707.707 0 0 0 1.207-.5V16a1 1 0 0 1 1-1h6a1 1 0 0 0 1-1v-4a1 1 0 0 0-1-1h-6a1 1 0 0 1-1-1V4.707a.707.707 0 0 0-1.207-.5l-6.94 6.94a1.207 1.207 0 0 0 0 1.707z"}]],"arrow-big-right-dash":[["path",{"d":"M11 9a1 1 0 0 0 1-1V4.707a.707.707 0 0 1 1.207-.5l6.94 6.94a1.207 1.207 0 0 1 0 1.707l-6.94 6.94a.707.707 0 0 1-1.207-.5V16a1 1 0 0 0-1-1H9a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1z"}],["path",{"d":"M4 9v6"}]],"arrow-big-right":[["path",{"d":"M13.207 19.793a.707.707 0 0 1-1.207-.5V16a1 1 0 0 0-1-1H5a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h6a1 1 0 0 0 1-1V4.707a.707.707 0 0 1 1.207-.5l6.94 6.94a1.207 1.207 0 0 1 0 1.707z"}]],"arrow-big-up-dash":[["path",{"d":"M14 16a1 1 0 0 0 1-1v-2a1 1 0 0 1 1-1h3.293a.707.707 0 0 0 .5-1.207l-6.939-6.939a1.207 1.207 0 0 0-1.708 0l-6.94 6.94a.707.707 0 0 0 .5 1.206H8a1 1 0 0 1 1 1v2a1 1 0 0 0 1 1z"}],["path",{"d":"M9 20h6"}]],"arrow-big-up":[["path",{"d":"M9 19a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1v-6a1 1 0 0 1 1-1h3.293a.707.707 0 0 0 .5-1.207l-7.086-7.086a1 1 0 0 0-1.414 0l-7.086 7.086a.707.707 0 0 0 .5 1.207H8a1 1 0 0 1 1 1z"}]],"arrow-down-0-1":[["path",{"d":"m3 16 4 4 4-4"}],["path",{"d":"M7 20V4"}],["rect",{"x":"15","y":"4","width":"4","height":"6","ry":"2"}],["path",{"d":"M17 20v-6h-2"}],["path",{"d":"M15 20h4"}]],"arrow-down-1-0":[["path",{"d":"m3 16 4 4 4-4"}],["path",{"d":"M7 20V4"}],["path",{"d":"M17 10V4h-2"}],["path",{"d":"M15 10h4"}],["rect",{"x":"15","y":"14","width":"4","height":"6","ry":"2"}]],"arrow-down-a-z":[["path",{"d":"m3 16 4 4 4-4"}],["path",{"d":"M7 20V4"}],["path",{"d":"M20 8h-5"}],["path",{"d":"M15 10V6.5a2.5 2.5 0 0 1 5 0V10"}],["path",{"d":"M15 14h5l-5 6h5"}]],"arrow-down-from-line":[["path",{"d":"M19 3H5"}],["path",{"d":"M12 21V7"}],["path",{"d":"m6 15 6 6 6-6"}]],"arrow-down-left":[["path",{"d":"M17 7 7 17"}],["path",{"d":"M17 17H7V7"}]],"arrow-down-narrow-wide":[["path",{"d":"m3 16 4 4 4-4"}],["path",{"d":"M7 20V4"}],["path",{"d":"M11 4h4"}],["path",{"d":"M11 8h7"}],["path",{"d":"M11 12h10"}]],"arrow-down-right":[["path",{"d":"m7 7 10 10"}],["path",{"d":"M17 7v10H7"}]],"arrow-down-to-dot":[["path",{"d":"M12 2v14"}],["path",{"d":"m19 9-7 7-7-7"}],["circle",{"cx":"12","cy":"21","r":"1"}]],"arrow-down-to-line":[["path",{"d":"M12 17V3"}],["path",{"d":"m6 11 6 6 6-6"}],["path",{"d":"M19 21H5"}]],"arrow-down-up":[["path",{"d":"m3 16 4 4 4-4"}],["path",{"d":"M7 20V4"}],["path",{"d":"m21 8-4-4-4 4"}],["path",{"d":"M17 4v16"}]],"arrow-down-wide-narrow":[["path",{"d":"m3 16 4 4 4-4"}],["path",{"d":"M7 20V4"}],["path",{"d":"M11 4h10"}],["path",{"d":"M11 8h7"}],["path",{"d":"M11 12h4"}]],"arrow-down-z-a":[["path",{"d":"m3 16 4 4 4-4"}],["path",{"d":"M7 4v16"}],["path",{"d":"M15 4h5l-5 6h5"}],["path",{"d":"M15 20v-3.5a2.5 2.5 0 0 1 5 0V20"}],["path",{"d":"M20 18h-5"}]],"arrow-down":[["path",{"d":"M12 5v14"}],["path",{"d":"m19 12-7 7-7-7"}]],"arrow-left-from-line":[["path",{"d":"m9 6-6 6 6 6"}],["path",{"d":"M3 12h14"}],["path",{"d":"M21 19V5"}]],"arrow-left-right":[["path",{"d":"M8 3 4 7l4 4"}],["path",{"d":"M4 7h16"}],["path",{"d":"m16 21 4-4-4-4"}],["path",{"d":"M20 17H4"}]],"arrow-left-to-line":[["path",{"d":"M3 19V5"}],["path",{"d":"m13 6-6 6 6 6"}],["path",{"d":"M7 12h14"}]],"arrow-left":[["path",{"d":"m12 19-7-7 7-7"}],["path",{"d":"M19 12H5"}]],"arrow-right-from-line":[["path",{"d":"M3 5v14"}],["path",{"d":"M21 12H7"}],["path",{"d":"m15 18 6-6-6-6"}]],"arrow-right-left":[["path",{"d":"m16 3 4 4-4 4"}],["path",{"d":"M20 7H4"}],["path",{"d":"m8 21-4-4 4-4"}],["path",{"d":"M4 17h16"}]],"arrow-right-to-line":[["path",{"d":"M17 12H3"}],["path",{"d":"m11 18 6-6-6-6"}],["path",{"d":"M21 5v14"}]],"arrow-right":[["path",{"d":"M5 12h14"}],["path",{"d":"m12 5 7 7-7 7"}]],"arrow-up-0-1":[["path",{"d":"m3 8 4-4 4 4"}],["path",{"d":"M7 4v16"}],["rect",{"x":"15","y":"4","width":"4","height":"6","ry":"2"}],["path",{"d":"M17 20v-6h-2"}],["path",{"d":"M15 20h4"}]],"arrow-up-1-0":[["path",{"d":"m3 8 4-4 4 4"}],["path",{"d":"M7 4v16"}],["path",{"d":"M17 10V4h-2"}],["path",{"d":"M15 10h4"}],["rect",{"x":"15","y":"14","width":"4","height":"6","ry":"2"}]],"arrow-up-a-z":[["path",{"d":"m3 8 4-4 4 4"}],["path",{"d":"M7 4v16"}],["path",{"d":"M20 8h-5"}],["path",{"d":"M15 10V6.5a2.5 2.5 0 0 1 5 0V10"}],["path",{"d":"M15 14h5l-5 6h5"}]],"arrow-up-down":[["path",{"d":"m21 16-4 4-4-4"}],["path",{"d":"M17 20V4"}],["path",{"d":"m3 8 4-4 4 4"}],["path",{"d":"M7 4v16"}]],"arrow-up-from-dot":[["path",{"d":"m5 9 7-7 7 7"}],["path",{"d":"M12 16V2"}],["circle",{"cx":"12","cy":"21","r":"1"}]],"arrow-up-from-line":[["path",{"d":"m18 9-6-6-6 6"}],["path",{"d":"M12 3v14"}],["path",{"d":"M5 21h14"}]],"arrow-up-left":[["path",{"d":"M7 17V7h10"}],["path",{"d":"M17 17 7 7"}]],"arrow-up-narrow-wide":[["path",{"d":"m3 8 4-4 4 4"}],["path",{"d":"M7 4v16"}],["path",{"d":"M11 12h4"}],["path",{"d":"M11 16h7"}],["path",{"d":"M11 20h10"}]],"arrow-up-right":[["path",{"d":"M7 7h10v10"}],["path",{"d":"M7 17 17 7"}]],"arrow-up-to-line":[["path",{"d":"M5 3h14"}],["path",{"d":"m18 13-6-6-6 6"}],["path",{"d":"M12 7v14"}]],"arrow-up-wide-narrow":[["path",{"d":"m3 8 4-4 4 4"}],["path",{"d":"M7 4v16"}],["path",{"d":"M11 12h10"}],["path",{"d":"M11 16h7"}],["path",{"d":"M11 20h4"}]],"arrow-up-z-a":[["path",{"d":"m3 8 4-4 4 4"}],["path",{"d":"M7 4v16"}],["path",{"d":"M15 4h5l-5 6h5"}],["path",{"d":"M15 20v-3.5a2.5 2.5 0 0 1 5 0V20"}],["path",{"d":"M20 18h-5"}]],"arrow-up":[["path",{"d":"m5 12 7-7 7 7"}],["path",{"d":"M12 19V5"}]],"arrows-up-from-line":[["path",{"d":"m4 6 3-3 3 3"}],["path",{"d":"M7 17V3"}],["path",{"d":"m14 6 3-3 3 3"}],["path",{"d":"M17 17V3"}],["path",{"d":"M4 21h16"}]],"asterisk":[["path",{"d":"M12 5v14"}],["path",{"d":"m18.065 8.496-12.125 7"}],["path",{"d":"m5.94 8.504 12.125 7"}]],"astroid":[["path",{"d":"M12.983 21.186a1 1 0 0 1-1.966 0 10 10 0 0 0-8.203-8.203 1 1 0 0 1 0-1.966 10 10 0 0 0 8.203-8.203 1 1 0 0 1 1.966 0 10 10 0 0 0 8.203 8.203 1 1 0 0 1 0 1.966 10 10 0 0 0-8.203 8.203"}]],"at-sign":[["circle",{"cx":"12","cy":"12","r":"4"}],["path",{"d":"M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"}]],"atom":[["circle",{"cx":"12","cy":"12","r":"1"}],["path",{"d":"M20.2 20.2c2.04-2.03.02-7.36-4.5-11.9-4.54-4.52-9.87-6.54-11.9-4.5-2.04 2.03-.02 7.36 4.5 11.9 4.54 4.52 9.87 6.54 11.9 4.5Z"}],["path",{"d":"M15.7 15.7c4.52-4.54 6.54-9.87 4.5-11.9-2.03-2.04-7.36-.02-11.9 4.5-4.52 4.54-6.54 9.87-4.5 11.9 2.03 2.04 7.36.02 11.9-4.5Z"}]],"audio-lines-off":[["path",{"d":"M10 10v11"}],["path",{"d":"M10 3v1.35"}],["path",{"d":"M14 14v1"}],["path",{"d":"M14 8v.35"}],["path",{"d":"M18 5v7.35"}],["path",{"d":"M2 10v3"}],["path",{"d":"m2 2 20 20"}],["path",{"d":"M22 10v3"}],["path",{"d":"M6 6v11"}]],"audio-lines-x":[["path",{"d":"M10 3v18"}],["path",{"d":"M14 8v6.35"}],["path",{"d":"m17 17 5 5"}],["path",{"d":"M18 5v8.1"}],["path",{"d":"M2 10v3"}],["path",{"d":"M22 10v3"}],["path",{"d":"m22 17-5 5"}],["path",{"d":"M6 6v11"}]],"audio-lines":[["path",{"d":"M2 10v3"}],["path",{"d":"M6 6v11"}],["path",{"d":"M10 3v18"}],["path",{"d":"M14 8v7"}],["path",{"d":"M18 5v13"}],["path",{"d":"M22 10v3"}]],"audio-waveform":[["path",{"d":"M2 13a2 2 0 0 0 2-2V7a2 2 0 0 1 4 0v13a2 2 0 0 0 4 0V4a2 2 0 0 1 4 0v13a2 2 0 0 0 4 0v-4a2 2 0 0 1 2-2"}]],"award":[["path",{"d":"m15.477 12.89 1.515 8.526a.5.5 0 0 1-.81.47l-3.58-2.687a1 1 0 0 0-1.197 0l-3.586 2.686a.5.5 0 0 1-.81-.469l1.514-8.526"}],["circle",{"cx":"12","cy":"8","r":"6"}]],"axe":[["path",{"d":"m14 12-8.381 8.38a1 1 0 0 1-3.001-3L11 9"}],["path",{"d":"M15 15.5a.5.5 0 0 0 .5.5A6.5 6.5 0 0 0 22 9.5a.5.5 0 0 0-.5-.5h-1.672a2 2 0 0 1-1.414-.586l-5.062-5.062a1.205 1.205 0 0 0-1.704 0L9.352 5.648a1.205 1.205 0 0 0 0 1.704l5.062 5.062A2 2 0 0 1 15 13.828z"}]],"axis-3d":[["path",{"d":"M13.5 10.5 15 9"}],["path",{"d":"M4 4v15a1 1 0 0 0 1 1h15"}],["path",{"d":"M4.293 19.707 6 18"}],["path",{"d":"m9 15 1.5-1.5"}]],"baby":[["path",{"d":"M10 16c.5.3 1.2.5 2 .5s1.5-.2 2-.5"}],["path",{"d":"M15 12h.01"}],["path",{"d":"M19.38 6.813A9 9 0 0 1 20.8 10.2a2 2 0 0 1 0 3.6 9 9 0 0 1-17.6 0 2 2 0 0 1 0-3.6A9 9 0 0 1 12 3c2 0 3.5 1.1 3.5 2.5s-.9 2.5-2 2.5c-.8 0-1.5-.4-1.5-1"}],["path",{"d":"M9 12h.01"}]],"backpack":[["path",{"d":"M4 10a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"}],["path",{"d":"M8 10h8"}],["path",{"d":"M8 18h8"}],["path",{"d":"M8 22v-6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v6"}],["path",{"d":"M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"}]],"badge-alert":[["path",{"d":"M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"}],["line",{"x1":"12","x2":"12","y1":"8","y2":"12"}],["line",{"x1":"12","x2":"12.01","y1":"16","y2":"16"}]],"badge-cent":[["path",{"d":"M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"}],["path",{"d":"M12 7v10"}],["path",{"d":"M15.4 10a4 4 0 1 0 0 4"}]],"badge-check":[["path",{"d":"M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"}],["path",{"d":"m16 9-5.5 5.5L8 12"}]],"badge-dollar-sign":[["path",{"d":"M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"}],["path",{"d":"M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"}],["path",{"d":"M12 18V6"}]],"badge-euro":[["path",{"d":"M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"}],["path",{"d":"M7 12h5"}],["path",{"d":"M15 9.4a4 4 0 1 0 0 5.2"}]],"badge-indian-rupee":[["path",{"d":"M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"}],["path",{"d":"M8 8h8"}],["path",{"d":"M8 12h8"}],["path",{"d":"m13 17-5-1h1a4 4 0 0 0 0-8"}]],"badge-info":[["path",{"d":"M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"}],["line",{"x1":"12","x2":"12","y1":"16","y2":"12"}],["line",{"x1":"12","x2":"12.01","y1":"8","y2":"8"}]],"badge-japanese-yen":[["path",{"d":"M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"}],["path",{"d":"m9 8 3 3v7"}],["path",{"d":"m12 11 3-3"}],["path",{"d":"M9 12h6"}],["path",{"d":"M9 16h6"}]],"badge-minus":[["path",{"d":"M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"}],["line",{"x1":"8","x2":"16","y1":"12","y2":"12"}]],"badge-percent":[["path",{"d":"M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"}],["path",{"d":"m15 9-6 6"}],["path",{"d":"M9 9h.01"}],["path",{"d":"M15 15h.01"}]],"badge-plus":[["path",{"d":"M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"}],["line",{"x1":"12","x2":"12","y1":"8","y2":"16"}],["line",{"x1":"8","x2":"16","y1":"12","y2":"12"}]],"badge-pound-sterling":[["path",{"d":"M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"}],["path",{"d":"M8 12h4"}],["path",{"d":"M10 16V9.5a2.5 2.5 0 0 1 5 0"}],["path",{"d":"M8 16h7"}]],"badge-question-mark":[["path",{"d":"M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"}],["path",{"d":"M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"}],["line",{"x1":"12","x2":"12.01","y1":"17","y2":"17"}]],"badge-russian-ruble":[["path",{"d":"M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"}],["path",{"d":"M9 16h5"}],["path",{"d":"M9 12h5a2 2 0 1 0 0-4h-3v9"}]],"badge-swiss-franc":[["path",{"d":"M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"}],["path",{"d":"M11 17V8h4"}],["path",{"d":"M11 12h3"}],["path",{"d":"M9 16h4"}]],"badge-turkish-lira":[["path",{"d":"M11 7v10a5 5 0 0 0 5-5"}],["path",{"d":"m15 8-6 3"}],["path",{"d":"M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76"}]],"badge-x":[["path",{"d":"M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"}],["line",{"x1":"15","x2":"9","y1":"9","y2":"15"}],["line",{"x1":"9","x2":"15","y1":"9","y2":"15"}]],"badge":[["path",{"d":"M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"}]],"baggage-claim":[["path",{"d":"M22 18H6a2 2 0 0 1-2-2V7a2 2 0 0 0-2-2"}],["path",{"d":"M17 14V4a2 2 0 0 0-2-2h-1a2 2 0 0 0-2 2v10"}],["rect",{"width":"13","height":"8","x":"8","y":"6","rx":"1"}],["circle",{"cx":"18","cy":"20","r":"2"}],["circle",{"cx":"9","cy":"20","r":"2"}]],"balloon":[["path",{"d":"M12 16v1a2 2 0 0 0 2 2h1a2 2 0 0 1 2 2v1"}],["path",{"d":"M12 6a2 2 0 0 1 2 2"}],["path",{"d":"M18 8c0 4-3.5 8-6 8s-6-4-6-8a6 6 0 0 1 12 0"}]],"ban":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M4.929 4.929 19.07 19.071"}]],"banana":[["path",{"d":"M4 13c3.5-2 8-2 10 2a5.5 5.5 0 0 1 8 5"}],["path",{"d":"M5.15 17.89c5.52-1.52 8.65-6.89 7-12C11.55 4 11.5 2 13 2c3.22 0 5 5.5 5 8 0 6.5-4.2 12-10.49 12C5.11 22 2 22 2 20c0-1.5 1.14-1.55 3.15-2.11Z"}]],"bandage":[["path",{"d":"M10 10.01h.01"}],["path",{"d":"M10 14.01h.01"}],["path",{"d":"M14 10.01h.01"}],["path",{"d":"M14 14.01h.01"}],["path",{"d":"M18 6v12"}],["path",{"d":"M6 6v12"}],["rect",{"x":"2","y":"6","width":"20","height":"12","rx":"2"}]],"bangladeshi-taka":[["path",{"d":"M6 5a2 2 0 0 1 4 0v12a4 4 0 0 0 8 0 2 2 0 0 0-4 0"}],["path",{"d":"M6 9h12"}]],"banknote-arrow-down":[["path",{"d":"M12 18H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5"}],["path",{"d":"m16 19 3 3 3-3"}],["path",{"d":"M18 12h.01"}],["path",{"d":"M19 16v6"}],["path",{"d":"M6 12h.01"}],["circle",{"cx":"12","cy":"12","r":"2"}]],"banknote-arrow-up":[["path",{"d":"M12 18H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5"}],["path",{"d":"M18 12h.01"}],["path",{"d":"M19 22v-6"}],["path",{"d":"m22 19-3-3-3 3"}],["path",{"d":"M6 12h.01"}],["circle",{"cx":"12","cy":"12","r":"2"}]],"banknote-check":[["path",{"d":"M11.748 18H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4.875"}],["path",{"d":"m16 19 2 2 4-4"}],["path",{"d":"M18 12h.01"}],["path",{"d":"M6 12h.01"}],["circle",{"cx":"12","cy":"12","r":"2"}]],"banknote-x":[["path",{"d":"M13 18H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5"}],["path",{"d":"m17 17 5 5"}],["path",{"d":"M18 12h.01"}],["path",{"d":"m22 17-5 5"}],["path",{"d":"M6 12h.01"}],["circle",{"cx":"12","cy":"12","r":"2"}]],"banknote":[["rect",{"width":"20","height":"12","x":"2","y":"6","rx":"2"}],["circle",{"cx":"12","cy":"12","r":"2"}],["path",{"d":"M6 12h.01M18 12h.01"}]],"barcode":[["path",{"d":"M3 5v14"}],["path",{"d":"M8 5v14"}],["path",{"d":"M12 5v14"}],["path",{"d":"M17 5v14"}],["path",{"d":"M21 5v14"}]],"barrel":[["path",{"d":"M10 3a41 41 0 000 18"}],["path",{"d":"M14 3a41 41 0 010 18"}],["path",{"d":"M16.997 21a2 2 0 001.68-.92 15.25 15.25 0 000-16.16 2 2 0 00-1.68-.92h-10a2 2 0 00-1.681.92 15.25 15.25 0 000 16.16 2 2 0 001.681.92z"}],["path",{"d":"M3.54 16h16.914"}],["path",{"d":"M3.54 8h16.914"}]],"baseline":[["path",{"d":"M4 20h16"}],["path",{"d":"m6 16 6-12 6 12"}],["path",{"d":"M8 12h8"}]],"bath":[["path",{"d":"M10 4 8 6"}],["path",{"d":"M17 19v2"}],["path",{"d":"M2 12h20"}],["path",{"d":"M7 19v2"}],["path",{"d":"M9 5 7.621 3.621A2.121 2.121 0 0 0 4 5v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"}]],"battery-charging":[["path",{"d":"m11 7-3 5h4l-3 5"}],["path",{"d":"M14.856 6H16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.935"}],["path",{"d":"M22 14v-4"}],["path",{"d":"M5.14 18H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2.936"}]],"battery-full":[["path",{"d":"M10 10v4"}],["path",{"d":"M14 10v4"}],["path",{"d":"M22 14v-4"}],["path",{"d":"M6 10v4"}],["rect",{"x":"2","y":"6","width":"16","height":"12","rx":"2"}]],"battery-low":[["path",{"d":"M22 14v-4"}],["path",{"d":"M6 14v-4"}],["rect",{"x":"2","y":"6","width":"16","height":"12","rx":"2"}]],"battery-medium":[["path",{"d":"M10 14v-4"}],["path",{"d":"M22 14v-4"}],["path",{"d":"M6 14v-4"}],["rect",{"x":"2","y":"6","width":"16","height":"12","rx":"2"}]],"battery-plus":[["path",{"d":"M10 9v6"}],["path",{"d":"M12.543 6H16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-3.605"}],["path",{"d":"M22 14v-4"}],["path",{"d":"M7 12h6"}],["path",{"d":"M7.606 18H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3.606"}]],"battery-warning":[["path",{"d":"M10 17h.01"}],["path",{"d":"M10 7v6"}],["path",{"d":"M14 6h2a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2"}],["path",{"d":"M22 14v-4"}],["path",{"d":"M6 18H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2"}]],"battery":[["path",{"d":"M 22 14 L 22 10"}],["rect",{"x":"2","y":"6","width":"16","height":"12","rx":"2"}]],"beaker":[["path",{"d":"M4.5 3h15"}],["path",{"d":"M6 3v16a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V3"}],["path",{"d":"M6 14h12"}]],"bean-off":[["path",{"d":"M9 9c-.64.64-1.521.954-2.402 1.165A6 6 0 0 0 8 22a13.96 13.96 0 0 0 9.9-4.1"}],["path",{"d":"M10.75 5.093A6 6 0 0 1 22 8c0 2.411-.61 4.68-1.683 6.66"}],["path",{"d":"M5.341 10.62a4 4 0 0 0 6.487 1.208M10.62 5.341a4.015 4.015 0 0 1 2.039 2.04"}],["line",{"x1":"2","x2":"22","y1":"2","y2":"22"}]],"bean":[["path",{"d":"M10.165 6.598C9.954 7.478 9.64 8.36 9 9c-.64.64-1.521.954-2.402 1.165A6 6 0 0 0 8 22c7.732 0 14-6.268 14-14a6 6 0 0 0-11.835-1.402Z"}],["path",{"d":"M5.341 10.62a4 4 0 1 0 5.279-5.28"}]],"bed-double":[["path",{"d":"M2 20v-8a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v8"}],["path",{"d":"M4 10V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v4"}],["path",{"d":"M12 4v6"}],["path",{"d":"M2 18h20"}]],"bed-single":[["path",{"d":"M3 20v-8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v8"}],["path",{"d":"M5 10V6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v4"}],["path",{"d":"M3 18h18"}]],"bed":[["path",{"d":"M2 4v16"}],["path",{"d":"M2 8h18a2 2 0 0 1 2 2v10"}],["path",{"d":"M2 17h20"}],["path",{"d":"M6 8v9"}]],"beef-off":[["path",{"d":"M11.771 6.109a2.5 2.5 0 0 1 3.12 3.12"}],["path",{"d":"M17.852 12.185a6.5 6.5 0 0 0-9.035-9.04"}],["path",{"d":"M18.013 18.013C15.029 20.349 10.831 22 7 22a3 3 0 0 1-2.68-1.66L2.4 16.5"}],["path",{"d":"m18.5 6 2.19 4.5a6.48 6.48 0 0 1-.139 4.393"}],["path",{"d":"m2 2 20 20"}],["path",{"d":"M6.355 6.37a7 7 0 0 0-.075.23c-1.1 3.13-.78 3.9-3.18 6.08A3 3 0 0 0 5 18c3.356 0 6.993-1.267 9.85-3.151"}]],"beef":[["path",{"d":"M16.4 13.7A6.5 6.5 0 1 0 6.28 6.6c-1.1 3.13-.78 3.9-3.18 6.08A3 3 0 0 0 5 18c4 0 8.4-1.8 11.4-4.3"}],["path",{"d":"m18.5 6 1.754 3.5a6.48 6.48 0 0 1-1.854 8.2C15.4 20.2 11 22 7 22a3 3 0 0 1-2.68-1.66L2.4 16.5"}],["circle",{"cx":"12.5","cy":"8.5","r":"2.5"}]],"beer-off":[["path",{"d":"M13 13v5"}],["path",{"d":"M17 11.47V8"}],["path",{"d":"M17 11h1a3 3 0 0 1 2.745 4.211"}],["path",{"d":"m2 2 20 20"}],["path",{"d":"M5 8v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-3"}],["path",{"d":"M7.536 7.535C6.766 7.649 6.154 8 5.5 8a2.5 2.5 0 0 1-1.768-4.268"}],["path",{"d":"M8.727 3.204C9.306 2.767 9.885 2 11 2c1.56 0 2 1.5 3 1.5s1.72-.5 2.5-.5a1 1 0 1 1 0 5c-.78 0-1.5-.5-2.5-.5a3.149 3.149 0 0 0-.842.12"}],["path",{"d":"M9 14.6V18"}]],"beer":[["path",{"d":"M17 11h1a3 3 0 0 1 0 6h-1"}],["path",{"d":"M9 12v6"}],["path",{"d":"M13 12v6"}],["path",{"d":"M14 7.5c-1 0-1.44.5-3 .5s-2-.5-3-.5-1.72.5-2.5.5a2.5 2.5 0 0 1 0-5c.78 0 1.57.5 2.5.5S9.44 2 11 2s2 1.5 3 1.5 1.72-.5 2.5-.5a2.5 2.5 0 0 1 0 5c-.78 0-1.5-.5-2.5-.5Z"}],["path",{"d":"M5 8v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8"}]],"bell-check":[["path",{"d":"M10.268 21a2 2 0 0 0 3.464 0"}],["path",{"d":"m15 8 2 2 4-4"}],["path",{"d":"M16.8607 4.4824A6 6 0 0 0 6 8C6 12.499 4.589 13.956 3.262 15.326"}],["path",{"d":"M3.262 15.326A1 1 0 0 0 4 17H20A1 1 0 0 0 20.74 15.327C20.209 14.779 19.665 14.218 19.203 13.454"}]],"bell-dot":[["path",{"d":"M10.268 21a2 2 0 0 0 3.464 0"}],["path",{"d":"M11.68 2.009A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673c-.824-.85-1.678-1.731-2.21-3.348"}],["circle",{"cx":"18","cy":"5","r":"3"}]],"bell-electric":[["path",{"d":"M18.518 17.347A7 7 0 0 1 14 19"}],["path",{"d":"M18.8 4A11 11 0 0 1 20 9"}],["path",{"d":"M9 9h.01"}],["circle",{"cx":"20","cy":"16","r":"2"}],["circle",{"cx":"9","cy":"9","r":"7"}],["rect",{"x":"4","y":"16","width":"10","height":"6","rx":"2"}]],"bell-minus":[["path",{"d":"M10.268 21a2 2 0 0 0 3.464 0"}],["path",{"d":"M15 8h6"}],["path",{"d":"M16.243 3.757A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673A9.4 9.4 0 0 1 18.667 12"}]],"bell-off":[["path",{"d":"M10.268 21a2 2 0 0 0 3.464 0"}],["path",{"d":"M17 17H4a1 1 0 0 1-.74-1.673C4.59 13.956 6 12.499 6 8a6 6 0 0 1 .258-1.742"}],["path",{"d":"m2 2 20 20"}],["path",{"d":"M8.668 3.01A6 6 0 0 1 18 8c0 2.687.77 4.653 1.707 6.05"}]],"bell-plus":[["path",{"d":"M10.268 21a2 2 0 0 0 3.464 0"}],["path",{"d":"M15 8h6"}],["path",{"d":"M18 5v6"}],["path",{"d":"M20.002 14.464a9 9 0 0 0 .738.863A1 1 0 0 1 20 17H4a1 1 0 0 1-.74-1.673C4.59 13.956 6 12.499 6 8a6 6 0 0 1 8.75-5.332"}]],"bell-ring":[["path",{"d":"M10.268 21a2 2 0 0 0 3.464 0"}],["path",{"d":"M22 8c0-2.3-.8-4.3-2-6"}],["path",{"d":"M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"}],["path",{"d":"M4 2C2.8 3.7 2 5.7 2 8"}]],"bell":[["path",{"d":"M10.268 21a2 2 0 0 0 3.464 0"}],["path",{"d":"M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"}]],"between-horizontal-end":[["rect",{"width":"13","height":"7","x":"3","y":"3","rx":"1"}],["path",{"d":"m22 15-3-3 3-3"}],["rect",{"width":"13","height":"7","x":"3","y":"14","rx":"1"}]],"between-horizontal-start":[["rect",{"width":"13","height":"7","x":"8","y":"3","rx":"1"}],["path",{"d":"m2 9 3 3-3 3"}],["rect",{"width":"13","height":"7","x":"8","y":"14","rx":"1"}]],"between-vertical-end":[["rect",{"width":"7","height":"13","x":"3","y":"3","rx":"1"}],["path",{"d":"m9 22 3-3 3 3"}],["rect",{"width":"7","height":"13","x":"14","y":"3","rx":"1"}]],"between-vertical-start":[["rect",{"width":"7","height":"13","x":"3","y":"8","rx":"1"}],["path",{"d":"m15 2-3 3-3-3"}],["rect",{"width":"7","height":"13","x":"14","y":"8","rx":"1"}]],"biceps-flexed":[["path",{"d":"M12.409 13.017A5 5 0 0 1 22 15c0 3.866-4 7-9 7-4.077 0-8.153-.82-10.371-2.462-.426-.316-.631-.832-.62-1.362C2.118 12.723 2.627 2 10 2a3 3 0 0 1 3 3 2 2 0 0 1-2 2c-1.105 0-1.64-.444-2-1"}],["path",{"d":"M15 14a5 5 0 0 0-7.584 2"}],["path",{"d":"M9.964 6.825C8.019 7.977 9.5 13 8 15"}]],"bike":[["circle",{"cx":"18.5","cy":"17.5","r":"3.5"}],["circle",{"cx":"5.5","cy":"17.5","r":"3.5"}],["circle",{"cx":"15","cy":"5","r":"1"}],["path",{"d":"M12 17.5V14l-3-3 4-3 2 3h2"}]],"binary":[["rect",{"x":"14","y":"14","width":"4","height":"6","rx":"2"}],["rect",{"x":"6","y":"4","width":"4","height":"6","rx":"2"}],["path",{"d":"M6 20h4"}],["path",{"d":"M14 10h4"}],["path",{"d":"M6 14h2v6"}],["path",{"d":"M14 4h2v6"}]],"binoculars":[["path",{"d":"M10 10h4"}],["path",{"d":"M19 7V4a1 1 0 0 0-1-1h-2a1 1 0 0 0-1 1v3"}],["path",{"d":"M20 21a2 2 0 0 0 2-2v-3.851c0-1.39-2-2.962-2-4.829V8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v11a2 2 0 0 0 2 2z"}],["path",{"d":"M 22 16 L 2 16"}],["path",{"d":"M4 21a2 2 0 0 1-2-2v-3.851c0-1.39 2-2.962 2-4.829V8a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v11a2 2 0 0 1-2 2z"}],["path",{"d":"M9 7V4a1 1 0 0 0-1-1H6a1 1 0 0 0-1 1v3"}]],"biohazard":[["circle",{"cx":"12","cy":"11.9","r":"2"}],["path",{"d":"M6.7 3.4c-.9 2.5 0 5.2 2.2 6.7C6.5 9 3.7 9.6 2 11.6"}],["path",{"d":"m8.9 10.1 1.4.8"}],["path",{"d":"M17.3 3.4c.9 2.5 0 5.2-2.2 6.7 2.4-1.2 5.2-.6 6.9 1.5"}],["path",{"d":"m15.1 10.1-1.4.8"}],["path",{"d":"M16.7 20.8c-2.6-.4-4.6-2.6-4.7-5.3-.2 2.6-2.1 4.8-4.7 5.2"}],["path",{"d":"M12 13.9v1.6"}],["path",{"d":"M13.5 5.4c-1-.2-2-.2-3 0"}],["path",{"d":"M17 16.4c.7-.7 1.2-1.6 1.5-2.5"}],["path",{"d":"M5.5 13.9c.3.9.8 1.8 1.5 2.5"}]],"bird":[["path",{"d":"M16 7h.01"}],["path",{"d":"M3.4 18H12a8 8 0 0 0 8-8V7a4 4 0 0 0-7.28-2.3L2 20"}],["path",{"d":"m20 7 2 .5-2 .5"}],["path",{"d":"M10 18v3"}],["path",{"d":"M14 17.75V21"}],["path",{"d":"M7 18a6 6 0 0 0 3.84-10.61"}]],"birdhouse":[["path",{"d":"M12 18v4"}],["path",{"d":"m17 18 1.956-11.468"}],["path",{"d":"m3 8 7.82-5.615a2 2 0 0 1 2.36 0L21 8"}],["path",{"d":"M4 18h16"}],["path",{"d":"M7 18 5.044 6.532"}],["circle",{"cx":"12","cy":"10","r":"2"}]],"bitcoin":[["path",{"d":"M11.767 19.089c4.924.868 6.14-6.025 1.216-6.894m-1.216 6.894L5.86 18.047m5.908 1.042-.347 1.97m1.563-8.864c4.924.869 6.14-6.025 1.215-6.893m-1.215 6.893-3.94-.694m5.155-6.2L8.29 4.26m5.908 1.042.348-1.97M7.48 20.364l3.126-17.727"}]],"blend":[["circle",{"cx":"15","cy":"9","r":"7"}],["circle",{"cx":"9","cy":"15","r":"7"}]],"blender":[["path",{"d":"M8 14a2 2 0 0 0-1.963 1.615l-1.018 5.193A1 1 0 0 0 6 22h12a1 1 0 0 0 .981-1.192l-1.018-5.193A2 2 0 0 0 16 14z"}],["path",{"d":"m17 2-1 12"}],["path",{"d":"M8.006 14 7 2"}],["path",{"d":"M7.565 8.787A5 5 0 0 0 12 8a5 5 0 0 1 4.56-.75"}],["path",{"d":"M19 2H5a2 2 0 0 0-2 2v5a2 2 0 0 0 .688 1.5"}],["path",{"d":"M12 18h.01"}]],"blinds":[["path",{"d":"M3 3h18"}],["path",{"d":"M20 7H8"}],["path",{"d":"M20 11H8"}],["path",{"d":"M10 19h10"}],["path",{"d":"M8 15h12"}],["path",{"d":"M4 3v14"}],["circle",{"cx":"4","cy":"19","r":"2"}]],"blocks":[["path",{"d":"M10 22V7a1 1 0 0 0-1-1H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5a1 1 0 0 0-1-1H2"}],["rect",{"x":"14","y":"2","width":"8","height":"8","rx":"1"}]],"bluetooth-connected":[["path",{"d":"m7 7 10 10-5 5V2l5 5L7 17"}],["line",{"x1":"18","x2":"21","y1":"12","y2":"12"}],["line",{"x1":"3","x2":"6","y1":"12","y2":"12"}]],"bluetooth-off":[["path",{"d":"m17 17-5 5V12l-5 5"}],["path",{"d":"m2 2 20 20"}],["path",{"d":"M14.5 9.5 17 7l-5-5v4.5"}]],"bluetooth-searching":[["path",{"d":"m7 7 10 10-5 5V2l5 5L7 17"}],["path",{"d":"M20.83 14.83a4 4 0 0 0 0-5.66"}],["path",{"d":"M18 12h.01"}]],"bluetooth":[["path",{"d":"m7 7 10 10-5 5V2l5 5L7 17"}]],"bold":[["path",{"d":"M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8"}]],"bolt":[["path",{"d":"M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"}],["circle",{"cx":"12","cy":"12","r":"4"}]],"bomb":[["circle",{"cx":"11","cy":"13","r":"9"}],["path",{"d":"M14.35 4.65 16.3 2.7a2.41 2.41 0 0 1 3.4 0l1.6 1.6a2.4 2.4 0 0 1 0 3.4l-1.95 1.95"}],["path",{"d":"m22 2-1.5 1.5"}]],"bone-fracture":[["path",{"d":"M14 4.5a1 1 0 0 1 5 0 .5.5 0 0 0 .5.5 1 1 0 0 1 0 5c-.81 0-1.8-.7-2.5 0l-1.958 1.957a.15.15 0 0 1-.252-.072l-.493-2.07a.15.15 0 0 0-.111-.112l-2.072-.494a.15.15 0 0 1-.072-.252L14 7c.7-.7 0-1.69 0-2.5"}],["path",{"d":"m16 20-1-2"}],["path",{"d":"m20 16-2-1"}],["path",{"d":"m4 8 2 1"}],["path",{"d":"m8 4 1 2"}],["path",{"d":"M9.698 14.19a.15.15 0 0 0 .112.112l2.074.489a.15.15 0 0 1 .072.252L10 17c-.7.7 0 1.69 0 2.5a1 1 0 0 1-5 0 .495.495 0 0 0-.5-.5 1 1 0 0 1 0-5c.81 0 1.8.7 2.5 0l1.956-1.957a.15.15 0 0 1 .252.072z"}]],"bone":[["path",{"d":"M17 10c.7-.7 1.69 0 2.5 0a2.5 2.5 0 1 0 0-5 .5.5 0 0 1-.5-.5 2.5 2.5 0 1 0-5 0c0 .81.7 1.8 0 2.5l-7 7c-.7.7-1.69 0-2.5 0a2.5 2.5 0 0 0 0 5c.28 0 .5.22.5.5a2.5 2.5 0 1 0 5 0c0-.81-.7-1.8 0-2.5Z"}]],"book-a":[["path",{"d":"M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"}],["path",{"d":"m8 13 4-7 4 7"}],["path",{"d":"M9.1 11h5.7"}]],"book-alert":[["path",{"d":"M12 13h.01"}],["path",{"d":"M12 6v3"}],["path",{"d":"M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"}]],"book-audio":[["path",{"d":"M12 6v7"}],["path",{"d":"M16 8v3"}],["path",{"d":"M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"}],["path",{"d":"M8 8v3"}]],"book-bookmark":[["path",{"d":"M10 2v7.751a.25.25 0 00.407.195l2.28-1.834a.5.5 0 01.627 0l2.28 1.834A.25.25 0 0016 9.751V2"}],["path",{"d":"M4 19.5v-15A2.5 2.5 0 016.5 2H19a1 1 0 011 1v18a1 1 0 01-1 1H6.5a1 1 0 010-5H20"}]],"book-check":[["path",{"d":"M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"}],["path",{"d":"m9 9.5 2 2 4-4"}]],"book-copy":[["path",{"d":"M5 7a2 2 0 0 0-2 2v11"}],["path",{"d":"M5.803 18H5a2 2 0 0 0 0 4h9.5a.5.5 0 0 0 .5-.5V21"}],["path",{"d":"M9 15V4a2 2 0 0 1 2-2h9.5a.5.5 0 0 1 .5.5v14a.5.5 0 0 1-.5.5H11a2 2 0 0 1 0-4h10"}]],"book-dashed":[["path",{"d":"M12 17h1.5"}],["path",{"d":"M12 22h1.5"}],["path",{"d":"M12 2h1.5"}],["path",{"d":"M17.5 22H19a1 1 0 0 0 1-1"}],["path",{"d":"M17.5 2H19a1 1 0 0 1 1 1v1.5"}],["path",{"d":"M20 14v3h-2.5"}],["path",{"d":"M20 8.5V10"}],["path",{"d":"M4 10V8.5"}],["path",{"d":"M4 19.5V14"}],["path",{"d":"M4 4.5A2.5 2.5 0 0 1 6.5 2H8"}],["path",{"d":"M8 22H6.5a1 1 0 0 1 0-5H8"}]],"book-down":[["path",{"d":"M12 13V7"}],["path",{"d":"M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"}],["path",{"d":"m9 10 3 3 3-3"}]],"book-headphones":[["path",{"d":"M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"}],["path",{"d":"M8 12v-2a4 4 0 0 1 8 0v2"}],["circle",{"cx":"15","cy":"12","r":"1"}],["circle",{"cx":"9","cy":"12","r":"1"}]],"book-heart":[["path",{"d":"M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"}],["path",{"d":"M8.62 9.8A2.25 2.25 0 1 1 12 6.836a2.25 2.25 0 1 1 3.38 2.966l-2.626 2.856a.998.998 0 0 1-1.507 0z"}]],"book-image":[["path",{"d":"m20 13.7-2.1-2.1a2 2 0 0 0-2.8 0L9.7 17"}],["path",{"d":"M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"}],["circle",{"cx":"10","cy":"8","r":"2"}]],"book-key":[["path",{"d":"M13 2H6.5A2.5 2.5 0 0 0 4 4.5v15"}],["path",{"d":"M17 2v6"}],["path",{"d":"M17 4h2"}],["path",{"d":"M20 15.2V21a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"}],["circle",{"cx":"17","cy":"10","r":"2"}]],"book-lock":[["path",{"d":"M18 6V4a2 2 0 1 0-4 0v2"}],["path",{"d":"M20 15v6a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"}],["path",{"d":"M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H10"}],["rect",{"x":"12","y":"6","width":"8","height":"5","rx":"1"}]],"book-minus":[["path",{"d":"M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"}],["path",{"d":"M9 10h6"}]],"book-open-check":[["path",{"d":"M12 5v16"}],["path",{"d":"m16 12 2 2 4-4"}],["path",{"d":"M22 6V5a2 2 0 00-1.999-2L16 3.002A5 5 0 0012 5a5 5 0 00-4-2H4a2 2 0 00-2 2v12a2 2 0 001.999 2H8a5 5 0 014 2 5 5 0 014-2h4.001A2 2 0 0022 17v-1.344"}]],"book-open-text":[["path",{"d":"M12 5v16"}],["path",{"d":"M16 13h2"}],["path",{"d":"M16 9h2"}],["path",{"d":"M20.001 19A2 2 0 0022 17V5a2 2 0 00-1.999-2L16 3.002A5 5 0 0012 5a5 5 0 00-4-2H4a2 2 0 00-2 2v12a2 2 0 001.999 2H8a5 5 0 014 2 5 5 0 014-2z"}],["path",{"d":"M6 13h2"}],["path",{"d":"M6 9h2"}]],"book-open":[["path",{"d":"M12 5v16"}],["path",{"d":"M20.001 19A2 2 0 0022 17V5a2 2 0 00-1.999-2L16 3.002A5 5 0 0012 5a5 5 0 00-4-2H4a2 2 0 00-2 2v12a2 2 0 001.999 2H8a5 5 0 014 2 5 5 0 014-2z"}]],"book-plus":[["path",{"d":"M12 7v6"}],["path",{"d":"M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"}],["path",{"d":"M9 10h6"}]],"book-search":[["path",{"d":"M11 22H5.5a1 1 0 0 1 0-5h4.501"}],["path",{"d":"m21 22-1.879-1.878"}],["path",{"d":"M3 19.5v-15A2.5 2.5 0 0 1 5.5 2H18a1 1 0 0 1 1 1v8"}],["circle",{"cx":"17","cy":"18","r":"3"}]],"book-text":[["path",{"d":"M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"}],["path",{"d":"M8 11h8"}],["path",{"d":"M8 7h6"}]],"book-type":[["path",{"d":"M10 13h4"}],["path",{"d":"M12 6v7"}],["path",{"d":"M16 8V6H8v2"}],["path",{"d":"M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"}]],"book-up-2":[["path",{"d":"M12 13V7"}],["path",{"d":"M18 2h1a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"}],["path",{"d":"M4 19.5v-15A2.5 2.5 0 0 1 6.5 2"}],["path",{"d":"m9 10 3-3 3 3"}],["path",{"d":"m9 5 3-3 3 3"}]],"book-up":[["path",{"d":"M12 13V7"}],["path",{"d":"M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"}],["path",{"d":"m9 10 3-3 3 3"}]],"book-user":[["path",{"d":"M15 13a3 3 0 1 0-6 0"}],["path",{"d":"M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"}],["circle",{"cx":"12","cy":"8","r":"2"}]],"book-x":[["path",{"d":"m14.5 7.5-5 5"}],["path",{"d":"M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"}],["path",{"d":"m9.5 7.5 5 5"}]],"book":[["path",{"d":"M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"}]],"bookmark-check":[["path",{"d":"M17 3a2 2 0 0 1 2 2v15a1 1 0 0 1-1.496.868l-4.512-2.578a2 2 0 0 0-1.984 0l-4.512 2.578A1 1 0 0 1 5 20V5a2 2 0 0 1 2-2z"}],["path",{"d":"m9 10 2 2 4-4"}]],"bookmark-minus":[["path",{"d":"M15 10H9"}],["path",{"d":"M17 3a2 2 0 0 1 2 2v15a1 1 0 0 1-1.496.868l-4.512-2.578a2 2 0 0 0-1.984 0l-4.512 2.578A1 1 0 0 1 5 20V5a2 2 0 0 1 2-2z"}]],"bookmark-off":[["path",{"d":"M19 19v1a1 1 0 0 1-1.496.868l-4.512-2.578a2 2 0 0 0-1.984 0l-4.512 2.578A1 1 0 0 1 5 20V5"}],["path",{"d":"m2 2 20 20"}],["path",{"d":"M8.656 3H17a2 2 0 0 1 2 2v8.344"}]],"bookmark-plus":[["path",{"d":"M12 7v6"}],["path",{"d":"M15 10H9"}],["path",{"d":"M17 3a2 2 0 0 1 2 2v15a1 1 0 0 1-1.496.868l-4.512-2.578a2 2 0 0 0-1.984 0l-4.512 2.578A1 1 0 0 1 5 20V5a2 2 0 0 1 2-2z"}]],"bookmark-x":[["path",{"d":"m14.5 7.5-5 5"}],["path",{"d":"M17 3a2 2 0 0 1 2 2v15a1 1 0 0 1-1.496.868l-4.512-2.578a2 2 0 0 0-1.984 0l-4.512 2.578A1 1 0 0 1 5 20V5a2 2 0 0 1 2-2z"}],["path",{"d":"m9.5 7.5 5 5"}]],"bookmark":[["path",{"d":"M17 3a2 2 0 0 1 2 2v15a1 1 0 0 1-1.496.868l-4.512-2.578a2 2 0 0 0-1.984 0l-4.512 2.578A1 1 0 0 1 5 20V5a2 2 0 0 1 2-2z"}]],"boom-box":[["path",{"d":"M4 9V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v4"}],["path",{"d":"M8 8v1"}],["path",{"d":"M12 8v1"}],["path",{"d":"M16 8v1"}],["rect",{"width":"20","height":"12","x":"2","y":"9","rx":"2"}],["circle",{"cx":"8","cy":"15","r":"2"}],["circle",{"cx":"16","cy":"15","r":"2"}]],"bot-message-square":[["path",{"d":"M12 6V2H8"}],["path",{"d":"M15 11v2"}],["path",{"d":"M2 12h2"}],["path",{"d":"M20 12h2"}],["path",{"d":"M20 16a2 2 0 0 1-2 2H8.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 4 20.286V8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z"}],["path",{"d":"M9 11v2"}]],"bot-off":[["path",{"d":"M13.67 8H18a2 2 0 0 1 2 2v4.33"}],["path",{"d":"M2 14h2"}],["path",{"d":"M20 14h2"}],["path",{"d":"M22 22 2 2"}],["path",{"d":"M8 8H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 1.414-.586"}],["path",{"d":"M9 13v2"}],["path",{"d":"M9.67 4H12v2.33"}]],"bot":[["path",{"d":"M12 8V4H8"}],["rect",{"width":"16","height":"12","x":"4","y":"8","rx":"2"}],["path",{"d":"M2 14h2"}],["path",{"d":"M20 14h2"}],["path",{"d":"M15 13v2"}],["path",{"d":"M9 13v2"}]],"bottle-wine":[["path",{"d":"M10 3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2a6 6 0 0 0 1.2 3.6l.6.8A6 6 0 0 1 17 13v8a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1v-8a6 6 0 0 1 1.2-3.6l.6-.8A6 6 0 0 0 10 5z"}],["path",{"d":"M17 13h-4a1 1 0 0 0-1 1v3a1 1 0 0 0 1 1h4"}]],"bow-arrow":[["path",{"d":"M17 3h4v4"}],["path",{"d":"M18.575 11.082a13 13 0 0 1 1.048 9.027 1.17 1.17 0 0 1-1.914.597L14 17"}],["path",{"d":"M7 10 3.29 6.29a1.17 1.17 0 0 1 .6-1.91 13 13 0 0 1 9.03 1.05"}],["path",{"d":"M7 14a1.7 1.7 0 0 0-1.207.5l-2.646 2.646A.5.5 0 0 0 3.5 18H5a1 1 0 0 1 1 1v1.5a.5.5 0 0 0 .854.354L9.5 18.207A1.7 1.7 0 0 0 10 17v-2a1 1 0 0 0-1-1z"}],["path",{"d":"M9.707 14.293 21 3"}]],"box":[["path",{"d":"M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"}],["path",{"d":"m3.3 7 8.7 5 8.7-5"}],["path",{"d":"M12 22V12"}]],"boxes":[["path",{"d":"M2.97 12.92A2 2 0 0 0 2 14.63v3.24a2 2 0 0 0 .97 1.71l3 1.8a2 2 0 0 0 2.06 0L12 19v-5.5l-5-3-4.03 2.42Z"}],["path",{"d":"m7 16.5-4.74-2.85"}],["path",{"d":"m7 16.5 5-3"}],["path",{"d":"M7 16.5v5.17"}],["path",{"d":"M12 13.5V19l3.97 2.38a2 2 0 0 0 2.06 0l3-1.8a2 2 0 0 0 .97-1.71v-3.24a2 2 0 0 0-.97-1.71L17 10.5l-5 3Z"}],["path",{"d":"m17 16.5-5-3"}],["path",{"d":"m17 16.5 4.74-2.85"}],["path",{"d":"M17 16.5v5.17"}],["path",{"d":"M7.97 4.42A2 2 0 0 0 7 6.13v4.37l5 3 5-3V6.13a2 2 0 0 0-.97-1.71l-3-1.8a2 2 0 0 0-2.06 0l-3 1.8Z"}],["path",{"d":"M12 8 7.26 5.15"}],["path",{"d":"m12 8 4.74-2.85"}],["path",{"d":"M12 13.5V8"}]],"braces":[["path",{"d":"M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1"}],["path",{"d":"M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"}]],"brackets":[["path",{"d":"M16 3h3a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1h-3"}],["path",{"d":"M8 21H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h3"}]],"brain-circuit":[["path",{"d":"M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"}],["path",{"d":"M9 13a4.5 4.5 0 0 0 3-4"}],["path",{"d":"M6.003 5.125A3 3 0 0 0 6.401 6.5"}],["path",{"d":"M3.477 10.896a4 4 0 0 1 .585-.396"}],["path",{"d":"M6 18a4 4 0 0 1-1.967-.516"}],["path",{"d":"M12 13h4"}],["path",{"d":"M12 18h6a2 2 0 0 1 2 2v1"}],["path",{"d":"M12 8h8"}],["path",{"d":"M16 8V5a2 2 0 0 1 2-2"}],["circle",{"cx":"16","cy":"13","r":".5"}],["circle",{"cx":"18","cy":"3","r":".5"}],["circle",{"cx":"20","cy":"21","r":".5"}],["circle",{"cx":"20","cy":"8","r":".5"}]],"brain-cog":[["path",{"d":"m10.852 14.772-.383.923"}],["path",{"d":"m10.852 9.228-.383-.923"}],["path",{"d":"m13.148 14.772.382.924"}],["path",{"d":"m13.531 8.305-.383.923"}],["path",{"d":"m14.772 10.852.923-.383"}],["path",{"d":"m14.772 13.148.923.383"}],["path",{"d":"M17.598 6.5A3 3 0 1 0 12 5a3 3 0 0 0-5.63-1.446 3 3 0 0 0-.368 1.571 4 4 0 0 0-2.525 5.771"}],["path",{"d":"M17.998 5.125a4 4 0 0 1 2.525 5.771"}],["path",{"d":"M19.505 10.294a4 4 0 0 1-1.5 7.706"}],["path",{"d":"M4.032 17.483A4 4 0 0 0 11.464 20c.18-.311.892-.311 1.072 0a4 4 0 0 0 7.432-2.516"}],["path",{"d":"M4.5 10.291A4 4 0 0 0 6 18"}],["path",{"d":"M6.002 5.125a3 3 0 0 0 .4 1.375"}],["path",{"d":"m9.228 10.852-.923-.383"}],["path",{"d":"m9.228 13.148-.923.383"}],["circle",{"cx":"12","cy":"12","r":"3"}]],"brain":[["path",{"d":"M12 18V5"}],["path",{"d":"M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4"}],["path",{"d":"M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5"}],["path",{"d":"M17.997 5.125a4 4 0 0 1 2.526 5.77"}],["path",{"d":"M18 18a4 4 0 0 0 2-7.464"}],["path",{"d":"M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517"}],["path",{"d":"M6 18a4 4 0 0 1-2-7.464"}],["path",{"d":"M6.003 5.125a4 4 0 0 0-2.526 5.77"}]],"brick-wall-fire":[["path",{"d":"M16 3v2.107"}],["path",{"d":"M17 9c1 3 2.5 3.5 3.5 4.5A5 5 0 0 1 22 17a5 5 0 0 1-10 0c0-.3 0-.6.1-.9a2 2 0 1 0 3.3-2C13 11.5 16 9 17 9"}],["path",{"d":"M21 8.274V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.938"}],["path",{"d":"M3 15h5.253"}],["path",{"d":"M3 9h8.228"}],["path",{"d":"M8 15v6"}],["path",{"d":"M8 3v6"}]],"brick-wall-shield":[["path",{"d":"M12 9v1.258"}],["path",{"d":"M16 3v5.46"}],["path",{"d":"M21 9.118V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5.75"}],["path",{"d":"M22 17.5c0 2.499-1.75 3.749-3.83 4.474a.5.5 0 0 1-.335-.005c-2.085-.72-3.835-1.97-3.835-4.47V14a.5.5 0 0 1 .5-.499c1 0 2.25-.6 3.12-1.36a.6.6 0 0 1 .76-.001c.875.765 2.12 1.36 3.12 1.36a.5.5 0 0 1 .5.5z"}],["path",{"d":"M3 15h7"}],["path",{"d":"M3 9h12.142"}],["path",{"d":"M8 15v6"}],["path",{"d":"M8 3v6"}]],"brick-wall":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M12 9v6"}],["path",{"d":"M16 15v6"}],["path",{"d":"M16 3v6"}],["path",{"d":"M3 15h18"}],["path",{"d":"M3 9h18"}],["path",{"d":"M8 15v6"}],["path",{"d":"M8 3v6"}]],"bridge":[["path",{"d":"M10 9.728V16"}],["path",{"d":"M14 9.728V16"}],["path",{"d":"M18 20V4"}],["path",{"d":"m22 11-4-4A7.5 7.5 0 0 1 6 7l-4 4"}],["path",{"d":"M22 16H2"}],["path",{"d":"M6 20V4"}]],"briefcase-business":[["path",{"d":"M12 12h.01"}],["path",{"d":"M16 6V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"}],["path",{"d":"M22 13a18.15 18.15 0 0 1-20 0"}],["rect",{"width":"20","height":"14","x":"2","y":"6","rx":"2"}]],"briefcase-conveyor-belt":[["path",{"d":"M10 20v2"}],["path",{"d":"M14 20v2"}],["path",{"d":"M18 20v2"}],["path",{"d":"M21 20H3"}],["path",{"d":"M6 20v2"}],["path",{"d":"M8 16V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v12"}],["rect",{"x":"4","y":"6","width":"16","height":"10","rx":"2"}]],"briefcase-medical":[["path",{"d":"M12 11v4"}],["path",{"d":"M14 13h-4"}],["path",{"d":"M16 6V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"}],["path",{"d":"M18 6v14"}],["path",{"d":"M6 6v14"}],["rect",{"width":"20","height":"14","x":"2","y":"6","rx":"2"}]],"briefcase-plus":[["path",{"d":"M13.354 20H4a2 2 0 01-2-2V8a2 2 0 012-2h16a2 2 0 012 2v3.354"}],["path",{"d":"M16 11.354V4a2 2 0 00-2-2h-4a2 2 0 00-2 2v16"}],["path",{"d":"M16 17h6"}],["path",{"d":"M19 14v6"}]],"briefcase":[["path",{"d":"M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"}],["rect",{"width":"20","height":"14","x":"2","y":"6","rx":"2"}]],"bring-to-front":[["rect",{"x":"8","y":"8","width":"8","height":"8","rx":"2"}],["path",{"d":"M4 10a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2"}],["path",{"d":"M14 20a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2"}]],"broccoli":[["path",{"d":"M10 13a3 3 0 01-2.121-5.121"}],["path",{"d":"M15.606 14.204c-3.5 1.5-5.899 4.503-8.899 7.503A1 1 0 016 22c-2 0-4-2-4-4a1 1 0 01.293-.707c1.911-1.911 3.823-3.578 5.347-5.441"}],["path",{"d":"M16.573 14.737A4 4 0 0114 11"}],["path",{"d":"M7.14 10.907a4 4 0 112.756-7.43A4 4 0 0116.7 4.48a2 2 0 012.82 2.82 4 4 0 011.002 6.805 4 4 0 11-7.51 1.59"}]],"broom-sparkles":[["path",{"d":"M11 2v2"}],["path",{"d":"M12 3h-2"}],["path",{"d":"M13.5 10.5 22 2"}],["path",{"d":"M14.734 13.841a2 2 0 00-.314-2.42L12.58 9.58a2 2 0 00-2.421-.314l-7.657 4.461A1 1 0 002.3 15.3l6.403 6.403a1 1 0 001.571-.204z"}],["path",{"d":"M20 15v4"}],["path",{"d":"M22 17h-4"}],["path",{"d":"M4 4v4"}],["path",{"d":"m5 18 2-2"}],["path",{"d":"M6 6H2"}],["path",{"d":"m7.699 10.7 5.602 5.601"}]],"broom":[["path",{"d":"M13.5 10.5 22 2"}],["path",{"d":"M14.734 13.841a2 2 0 00-.314-2.42L12.58 9.58a2 2 0 00-2.421-.314l-7.657 4.461A1 1 0 002.3 15.3l6.403 6.403a1 1 0 001.571-.204z"}],["path",{"d":"m5 18 2-2"}],["path",{"d":"m7.699 10.7 5.602 5.601"}]],"brush-cleaning":[["path",{"d":"m16 22-1-4"}],["path",{"d":"M19 14a1 1 0 0 0 1-1v-1a2 2 0 0 0-2-2h-3a1 1 0 0 1-1-1V4a2 2 0 0 0-4 0v5a1 1 0 0 1-1 1H6a2 2 0 0 0-2 2v1a1 1 0 0 0 1 1"}],["path",{"d":"M19 14H5l-1.973 6.767A1 1 0 0 0 4 22h16a1 1 0 0 0 .973-1.233z"}],["path",{"d":"m8 22 1-4"}]],"brush":[["path",{"d":"m11 10 3 3"}],["path",{"d":"M6.5 21A3.5 3.5 0 1 0 3 17.5a2.62 2.62 0 0 1-.708 1.792A1 1 0 0 0 3 21z"}],["path",{"d":"M9.969 17.031 21.378 5.624a1 1 0 0 0-3.002-3.002L6.967 14.031"}]],"bubbles":[["path",{"d":"M7.001 15.085A1.5 1.5 0 0 1 9 16.5"}],["circle",{"cx":"18.5","cy":"8.5","r":"3.5"}],["circle",{"cx":"7.5","cy":"16.5","r":"5.5"}],["circle",{"cx":"7.5","cy":"4.5","r":"2.5"}]],"bug-off":[["path",{"d":"M12 20v-8"}],["path",{"d":"M12.656 7H14a4 4 0 0 1 4 4v1.344"}],["path",{"d":"M14.12 3.88 16 2"}],["path",{"d":"M17.123 17.123A6 6 0 0 1 6 14v-3a4 4 0 0 1 1.72-3.287"}],["path",{"d":"m2 2 20 20"}],["path",{"d":"M21 5a4 4 0 0 1-3.55 3.97"}],["path",{"d":"M22 13h-3.344"}],["path",{"d":"M3 21a4 4 0 0 1 3.81-4"}],["path",{"d":"M3 5a4 4 0 0 0 3.55 3.97"}],["path",{"d":"M6 13H2"}],["path",{"d":"m8 2 1.88 1.88"}],["path",{"d":"M9.712 4.06A3 3 0 0 1 15 6v1.13"}]],"bug-play":[["path",{"d":"M10 19.655A6 6 0 0 1 6 14v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 3.97"}],["path",{"d":"M14 15.003a1 1 0 0 1 1.517-.859l4.997 2.997a1 1 0 0 1 0 1.718l-4.997 2.997a1 1 0 0 1-1.517-.86z"}],["path",{"d":"M14.12 3.88 16 2"}],["path",{"d":"M21 5a4 4 0 0 1-3.55 3.97"}],["path",{"d":"M3 21a4 4 0 0 1 3.81-4"}],["path",{"d":"M3 5a4 4 0 0 0 3.55 3.97"}],["path",{"d":"M6 13H2"}],["path",{"d":"m8 2 1.88 1.88"}],["path",{"d":"M9 7.13V6a3 3 0 1 1 6 0v1.13"}]],"bug":[["path",{"d":"M12 20v-9"}],["path",{"d":"M14 7a4 4 0 0 1 4 4v3a6 6 0 0 1-12 0v-3a4 4 0 0 1 4-4z"}],["path",{"d":"M14.12 3.88 16 2"}],["path",{"d":"M21 21a4 4 0 0 0-3.81-4"}],["path",{"d":"M21 5a4 4 0 0 1-3.55 3.97"}],["path",{"d":"M22 13h-4"}],["path",{"d":"M3 21a4 4 0 0 1 3.81-4"}],["path",{"d":"M3 5a4 4 0 0 0 3.55 3.97"}],["path",{"d":"M6 13H2"}],["path",{"d":"m8 2 1.88 1.88"}],["path",{"d":"M9 7.13V6a3 3 0 1 1 6 0v1.13"}]],"building-complex-plus":[["path",{"d":"M10 12h4"}],["path",{"d":"M10 21v-3a2 2 0 013.05-1.702"}],["path",{"d":"M10 8h4"}],["path",{"d":"M16 19h6"}],["path",{"d":"M18 7h2a2 2 0 012 2v4.355"}],["path",{"d":"M19 16v6"}],["path",{"d":"M6 10H4a2 2 0 00-2 2v7a2 2 0 002 2h8.535"}],["path",{"d":"M6 21V5a2 2 0 012-2h8a2 2 0 012 2v7.126"}]],"building-complex":[["path",{"d":"M10 12h4"}],["path",{"d":"M10 8h4"}],["path",{"d":"M14 21v-3a2 2 0 0 0-4 0v3"}],["path",{"d":"M6 10H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-2"}],["path",{"d":"M6 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16"}]],"building":[["path",{"d":"M12 10h.01"}],["path",{"d":"M12 14h.01"}],["path",{"d":"M12 6h.01"}],["path",{"d":"M16 10h.01"}],["path",{"d":"M16 14h.01"}],["path",{"d":"M16 6h.01"}],["path",{"d":"M8 10h.01"}],["path",{"d":"M8 14h.01"}],["path",{"d":"M8 6h.01"}],["path",{"d":"M9 22v-3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"}],["rect",{"x":"4","y":"2","width":"16","height":"20","rx":"2"}]],"bus-front":[["path",{"d":"M4 6 2 7"}],["path",{"d":"M10 6h4"}],["path",{"d":"m22 7-2-1"}],["rect",{"width":"16","height":"16","x":"4","y":"3","rx":"2"}],["path",{"d":"M4 11h16"}],["path",{"d":"M8 15h.01"}],["path",{"d":"M16 15h.01"}],["path",{"d":"M6 19v2"}],["path",{"d":"M18 21v-2"}]],"bus":[["path",{"d":"M8 6v6"}],["path",{"d":"M15 6v6"}],["path",{"d":"M2 12h19.6"}],["path",{"d":"M18 18h3s.5-1.7.8-2.8c.1-.4.2-.8.2-1.2 0-.4-.1-.8-.2-1.2l-1.4-5C20.1 6.8 19.1 6 18 6H4a2 2 0 0 0-2 2v10h3"}],["circle",{"cx":"7","cy":"18","r":"2"}],["path",{"d":"M9 18h5"}],["circle",{"cx":"16","cy":"18","r":"2"}]],"cable-car":[["path",{"d":"M10 3h.01"}],["path",{"d":"M14 2h.01"}],["path",{"d":"m2 9 20-5"}],["path",{"d":"M12 12V6.5"}],["rect",{"width":"16","height":"10","x":"4","y":"12","rx":"3"}],["path",{"d":"M9 12v5"}],["path",{"d":"M15 12v5"}],["path",{"d":"M4 17h16"}]],"cable":[["path",{"d":"M17 19a1 1 0 0 1-1-1v-2a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2a1 1 0 0 1-1 1z"}],["path",{"d":"M17 21v-2"}],["path",{"d":"M19 14V6.5a1 1 0 0 0-7 0v11a1 1 0 0 1-7 0V10"}],["path",{"d":"M21 21v-2"}],["path",{"d":"M3 5V3"}],["path",{"d":"M4 10a2 2 0 0 1-2-2V6a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2a2 2 0 0 1-2 2z"}],["path",{"d":"M7 5V3"}]],"cake-slice":[["path",{"d":"M16 13H3"}],["path",{"d":"M16 17H3"}],["path",{"d":"m7.2 7.9-3.388 2.5A2 2 0 0 0 3 12.01V20a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-8.654c0-2-2.44-6.026-6.44-8.026a1 1 0 0 0-1.082.057L10.4 5.6"}],["circle",{"cx":"9","cy":"7","r":"2"}]],"cake":[["path",{"d":"M20 21v-8a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8"}],["path",{"d":"M4 16s.5-1 2-1 2.5 2 4 2 2.5-2 4-2 2.5 2 4 2 2-1 2-1"}],["path",{"d":"M2 21h20"}],["path",{"d":"M7 8v3"}],["path",{"d":"M12 8v3"}],["path",{"d":"M17 8v3"}],["path",{"d":"M7 4h.01"}],["path",{"d":"M12 4h.01"}],["path",{"d":"M17 4h.01"}]],"calculator":[["rect",{"width":"16","height":"20","x":"4","y":"2","rx":"2"}],["line",{"x1":"8","x2":"16","y1":"6","y2":"6"}],["line",{"x1":"16","x2":"16","y1":"14","y2":"18"}],["path",{"d":"M16 10h.01"}],["path",{"d":"M12 10h.01"}],["path",{"d":"M8 10h.01"}],["path",{"d":"M12 14h.01"}],["path",{"d":"M8 14h.01"}],["path",{"d":"M12 18h.01"}],["path",{"d":"M8 18h.01"}]],"calendar-1":[["path",{"d":"M11 13h1v4"}],["path",{"d":"M16 2v3"}],["path",{"d":"M3 9h18"}],["path",{"d":"M8 2v3"}],["rect",{"x":"3","y":"3","width":"18","height":"18","rx":"2"}]],"calendar-arrow-down":[["path",{"d":"m14 17 4 4 4-4"}],["path",{"d":"M16 2v3"}],["path",{"d":"M18 13v8"}],["path",{"d":"M21 10.354V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2h7.343"}],["path",{"d":"M3 9h18"}],["path",{"d":"M8 2v3"}]],"calendar-arrow-up":[["path",{"d":"m14 17 4-4 4 4"}],["path",{"d":"M16 2v3"}],["path",{"d":"M18 21v-8"}],["path",{"d":"M21 10.343V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2h9"}],["path",{"d":"M3 9h18"}],["path",{"d":"M8 2v3"}]],"calendar-check-2":[["path",{"d":"M 19 3 L 5 3"}],["path",{"d":"M 21 13 L 21 5"}],["path",{"d":"M 21 5 A2 2 0 0 0 19 3"}],["path",{"d":"M 3 19 A2 2 0 0 0 5 21"}],["path",{"d":"M 3 5 L 3 19"}],["path",{"d":"M 5 3 A2 2 0 0 0 3 5"}],["path",{"d":"m16 19 2 2 4-4"}],["path",{"d":"M16 2v3"}],["path",{"d":"M3 9h18"}],["path",{"d":"M5 21 L12.5 21"}],["path",{"d":"M8 2v3"}]],"calendar-check":[["path",{"d":"M8 2v3"}],["path",{"d":"M16 2v3"}],["rect",{"x":"3","y":"3","width":"18","height":"18","rx":"2"}],["path",{"d":"M3 9h18"}],["path",{"d":"m9 15 2 2 4-4"}]],"calendar-chevrons-right":[["path",{"d":"m13 21 3-3-3-3"}],["path",{"d":"M16 2v3"}],["path",{"d":"m19 21 3-3-3-3"}],["path",{"d":"M21 11.5V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2h4"}],["path",{"d":"M3 9h18"}],["path",{"d":"M8 2v3"}]],"calendar-clock":[["path",{"d":"M16 14v2.2l1.6 1"}],["path",{"d":"M16 2v3"}],["path",{"d":"M21 7.338V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2h2.338"}],["path",{"d":"M3 9h5.859"}],["path",{"d":"M8 2v3"}],["circle",{"cx":"16","cy":"16","r":"6"}]],"calendar-cog":[["path",{"d":"m15.228 16.852-.923-.383"}],["path",{"d":"m15.228 19.148-.923.383"}],["path",{"d":"M16 2v3"}],["path",{"d":"m16.47 14.305.382.923"}],["path",{"d":"m16.852 20.772-.383.924"}],["path",{"d":"m19.148 15.228.383-.923"}],["path",{"d":"m19.53 21.696-.382-.924"}],["path",{"d":"m20.773 16.852.924-.383"}],["path",{"d":"m20.773 19.148.924.383"}],["path",{"d":"M21 10.5V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2h5.5"}],["path",{"d":"M3 9h18"}],["path",{"d":"M8 2v3"}],["circle",{"cx":"18","cy":"18","r":"3"}]],"calendar-days":[["path",{"d":"M8 2v3"}],["path",{"d":"M16 2v3"}],["rect",{"x":"3","y":"3","width":"18","height":"18","rx":"2"}],["path",{"d":"M3 9h18"}],["path",{"d":"M8 13h.01"}],["path",{"d":"M12 13h.01"}],["path",{"d":"M16 13h.01"}],["path",{"d":"M8 17h.01"}],["path",{"d":"M12 17h.01"}],["path",{"d":"M16 17h.01"}]],"calendar-fold":[["path",{"d":"M16 2v3"}],["path",{"d":"M21 15V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2h10v-5a1 1 0 011-1za2.4 2.4 0 01-.706 1.706l-3.588 3.588A2.4 2.4 0 0115 21"}],["path",{"d":"M3 9h18"}],["path",{"d":"M8 2v3"}]],"calendar-heart":[["path",{"d":"M12.127 21H5a2 2 0 01-2-2V5a2 2 0 012-2h14a2 2 0 012 2v5.125"}],["path",{"d":"M14.62 17.8A2.25 2.25 0 1118 14.836a2.25 2.25 0 113.38 2.966l-2.626 2.856a.998.998 0 01-1.507 0z"}],["path",{"d":"M16 2v3"}],["path",{"d":"M3 9h18"}],["path",{"d":"M8 2v3"}]],"calendar-minus-2":[["path",{"d":"M8 2v3"}],["path",{"d":"M16 2v3"}],["rect",{"x":"3","y":"3","width":"18","height":"18","rx":"2"}],["path",{"d":"M3 9h18"}],["path",{"d":"M10 15h4"}]],"calendar-minus":[["path",{"d":"M16 18h6"}],["path",{"d":"M16 2v3"}],["path",{"d":"M21 14V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2h8.3"}],["path",{"d":"M3 9h18"}],["path",{"d":"M8 2v3"}]],"calendar-off":[["path",{"d":"M16 2v3"}],["path",{"d":"m2 2 20 20"}],["path",{"d":"M21 9h-5.5"}],["path",{"d":"M3 9h6"}],["path",{"d":"M3.586 3.586A2 2 0 003 5v14a2 2 0 002 2h14a2 2 0 001.414-.586"}],["path",{"d":"M8.656 3H19a2 2 0 012 2v10.344"}]],"calendar-plus-2":[["path",{"d":"M8 2v3"}],["path",{"d":"M16 2v3"}],["rect",{"x":"3","y":"3","width":"18","height":"18","rx":"2"}],["path",{"d":"M3 9h18"}],["path",{"d":"M10 15h4"}],["path",{"d":"M12 13v4"}]],"calendar-plus":[["path",{"d":"M16 18h6"}],["path",{"d":"M16 2v3"}],["path",{"d":"M19 15v6"}],["path",{"d":"M21 11.5V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2h8.3"}],["path",{"d":"M3 9h18"}],["path",{"d":"M8 2v3"}]],"calendar-range":[["rect",{"x":"3","y":"3","width":"18","height":"18","rx":"2"}],["path",{"d":"M16 2v3"}],["path",{"d":"M3 9h18"}],["path",{"d":"M8 2v3"}],["path",{"d":"M17 13h-6"}],["path",{"d":"M13 17H7"}],["path",{"d":"M7 13h.01"}],["path",{"d":"M17 17h.01"}]],"calendar-search":[["path",{"d":"M16 2v3"}],["path",{"d":"M21 10.69V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2h7.25"}],["path",{"d":"m22 21-1.875-1.875"}],["path",{"d":"M3 9h18"}],["path",{"d":"M8 2v3"}],["circle",{"cx":"18","cy":"17","r":"3"}]],"calendar-sync":[["path",{"d":"M11 10v4h4"}],["path",{"d":"m11 14 1.535-1.605a5 5 0 018 1.5"}],["path",{"d":"M16 2v3"}],["path",{"d":"m21 18-1.535 1.605a5 5 0 01-8-1.5"}],["path",{"d":"M21 22v-4h-4"}],["path",{"d":"M21 8.517V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2h3.517"}],["path",{"d":"M3 9h4"}],["path",{"d":"M8 2v3"}]],"calendar-x-2":[["path",{"d":"M16 2v3"}],["path",{"d":"m17 16 5 5"}],["path",{"d":"m17 21 5-5"}],["path",{"d":"M21 12V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2h8"}],["path",{"d":"M3 9h18"}],["path",{"d":"M8 2v3"}]],"calendar-x":[["path",{"d":"M8 2v3"}],["path",{"d":"M16 2v3"}],["rect",{"x":"3","y":"3","width":"18","height":"18","rx":"2"}],["path",{"d":"M3 9h18"}],["path",{"d":"m14 13-4 4"}],["path",{"d":"m10 13 4 4"}]],"calendar":[["path",{"d":"M8 2v3"}],["path",{"d":"M16 2v3"}],["rect",{"x":"3","y":"3","width":"18","height":"18","rx":"2"}],["path",{"d":"M3 9h18"}]],"calendars":[["path",{"d":"M12 2v2"}],["path",{"d":"M15.726 21.01A2 2 0 0 1 14 22H4a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2"}],["path",{"d":"M18 2v2"}],["path",{"d":"M2 13h2"}],["path",{"d":"M8 8h14"}],["rect",{"x":"8","y":"3","width":"14","height":"14","rx":"2"}]],"camera-off":[["path",{"d":"M14.564 14.558a3 3 0 1 1-4.122-4.121"}],["path",{"d":"m2 2 20 20"}],["path",{"d":"M20 20H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 .819-.175"}],["path",{"d":"M9.695 4.024A2 2 0 0 1 10.004 4h3.993a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v7.344"}]],"camera":[["path",{"d":"M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z"}],["circle",{"cx":"12","cy":"13","r":"3"}]],"can-soda":[["path",{"d":"m17 22 1.664-2.496a2 2 0 00.336-1.11V5.606a2 2 0 00-.336-1.11L17 2"}],["path",{"d":"M18 22H6"}],["path",{"d":"M18 2H6"}],["path",{"d":"M5 17h14"}],["path",{"d":"M5 7h14"}],["path",{"d":"m7 22-1.664-2.496A2 2 0 015 18.394V5.606a2 2 0 01.336-1.11L7 2"}]],"can":[["path",{"d":"M21 10.5a9 2.5 0 01-18 0v8a9 2.5 0 0018 0z"}],["path",{"d":"M21 10.5A9 2.5 25.32 004.59 3.47 9 2.5 25.32 0021 10.5"}],["path",{"d":"M3 10.5a9 2.5 0 016.527-2.405"}],["path",{"d":"M9 16.858a31 31 0 006 0"}]],"candy-cane":[["path",{"d":"m10.8 5 2.111 4.223"}],["path",{"d":"M17.75 7 15 2.1"}],["path",{"d":"m4.874 14.647 2.12 4.24"}],["path",{"d":"M5.7 21a2 2 0 0 1-3.5-2l8.6-14a6 6 0 0 1 10.4 6 2 2 0 1 1-3.464-2 2 2 0 1 0-3.464-2z"}],["path",{"d":"m7.906 9.712 2.005 4.411"}]],"candy-off":[["path",{"d":"M10 10v7.9"}],["path",{"d":"M11.802 6.145a5 5 0 0 1 6.053 6.053"}],["path",{"d":"M14 6.1v2.243"}],["path",{"d":"m15.5 15.571-.964.964a5 5 0 0 1-7.071 0 5 5 0 0 1 0-7.07l.964-.965"}],["path",{"d":"M16 7V3a1 1 0 0 1 1.707-.707 2.5 2.5 0 0 0 2.152.717 1 1 0 0 1 1.131 1.131 2.5 2.5 0 0 0 .717 2.152A1 1 0 0 1 21 8h-4"}],["path",{"d":"m2 2 20 20"}],["path",{"d":"M8 17v4a1 1 0 0 1-1.707.707 2.5 2.5 0 0 0-2.152-.717 1 1 0 0 1-1.131-1.131 2.5 2.5 0 0 0-.717-2.152A1 1 0 0 1 3 16h4"}]],"candy":[["path",{"d":"M10 7v10.9"}],["path",{"d":"M14 6.1V17"}],["path",{"d":"M16 7V3a1 1 0 0 1 1.707-.707 2.5 2.5 0 0 0 2.152.717 1 1 0 0 1 1.131 1.131 2.5 2.5 0 0 0 .717 2.152A1 1 0 0 1 21 8h-4"}],["path",{"d":"M16.536 7.465a5 5 0 0 0-7.072 0l-2 2a5 5 0 0 0 0 7.07 5 5 0 0 0 7.072 0l2-2a5 5 0 0 0 0-7.07"}],["path",{"d":"M8 17v4a1 1 0 0 1-1.707.707 2.5 2.5 0 0 0-2.152-.717 1 1 0 0 1-1.131-1.131 2.5 2.5 0 0 0-.717-2.152A1 1 0 0 1 3 16h4"}]],"cannabis-off":[["path",{"d":"M12 22v-4c1.5 1.5 3.5 3 6 3 0-1.5-.5-3.5-2-5"}],["path",{"d":"M13.988 8.327C13.902 6.054 13.365 3.82 12 2a9.3 9.3 0 0 0-1.445 2.9"}],["path",{"d":"M17.375 11.725C18.882 10.53 21 7.841 21 6c-2.324 0-5.08 1.296-6.662 2.684"}],["path",{"d":"m2 2 20 20"}],["path",{"d":"M21.024 15.378A15 15 0 0 0 22 15c-.426-1.279-2.67-2.557-4.25-2.907"}],["path",{"d":"M6.995 6.992C5.714 6.4 4.29 6 3 6c0 2 2.5 5 4 6-1.5 0-4.5 1.5-5 3 3.5 1.5 6 1 6 1-1.5 1.5-2 3.5-2 5 2.5 0 4.5-1.5 6-3"}]],"cannabis":[["path",{"d":"M12 22v-4"}],["path",{"d":"M7 12c-1.5 0-4.5 1.5-5 3 3.5 1.5 6 1 6 1-1.5 1.5-2 3.5-2 5 2.5 0 4.5-1.5 6-3 1.5 1.5 3.5 3 6 3 0-1.5-.5-3.5-2-5 0 0 2.5.5 6-1-.5-1.5-3.5-3-5-3 1.5-1 4-4 4-6-2.5 0-5.5 1.5-7 3 0-2.5-.5-5-2-7-1.5 2-2 4.5-2 7-1.5-1.5-4.5-3-7-3 0 2 2.5 5 4 6"}]],"captions-off":[["path",{"d":"M10.5 5H19a2 2 0 0 1 2 2v8.5"}],["path",{"d":"M17 11h-.5"}],["path",{"d":"M19 19H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2"}],["path",{"d":"m2 2 20 20"}],["path",{"d":"M7 11h4"}],["path",{"d":"M7 15h2.5"}]],"captions":[["rect",{"width":"18","height":"14","x":"3","y":"5","rx":"2","ry":"2"}],["path",{"d":"M7 15h4M15 15h2M7 11h2M13 11h4"}]],"car-battery":[["path",{"d":"M14 13h4"}],["path",{"d":"M16 15v-4"}],["path",{"d":"M18 5v2"}],["path",{"d":"M6 13h4"}],["path",{"d":"M6 5v2"}],["rect",{"x":"2","y":"7","width":"20","height":"12","rx":"2"}]],"car-front":[["path",{"d":"m21 8-2 2-1.5-3.7A2 2 0 0 0 15.646 5H8.4a2 2 0 0 0-1.903 1.257L5 10 3 8"}],["path",{"d":"M7 14h.01"}],["path",{"d":"M17 14h.01"}],["rect",{"width":"18","height":"8","x":"3","y":"10","rx":"2"}],["path",{"d":"M5 18v2"}],["path",{"d":"M19 18v2"}]],"car-taxi-front":[["path",{"d":"M10 2h4"}],["path",{"d":"m21 8-2 2-1.5-3.7A2 2 0 0 0 15.646 5H8.4a2 2 0 0 0-1.903 1.257L5 10 3 8"}],["path",{"d":"M7 14h.01"}],["path",{"d":"M17 14h.01"}],["rect",{"width":"18","height":"8","x":"3","y":"10","rx":"2"}],["path",{"d":"M5 18v2"}],["path",{"d":"M19 18v2"}]],"car":[["path",{"d":"M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"}],["circle",{"cx":"7","cy":"17","r":"2"}],["path",{"d":"M9 17h6"}],["circle",{"cx":"17","cy":"17","r":"2"}]],"caravan":[["path",{"d":"M18 19V9a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v8a2 2 0 0 0 2 2h2"}],["path",{"d":"M2 9h3a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H2"}],["path",{"d":"M22 17v1a1 1 0 0 1-1 1H10v-9a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v9"}],["circle",{"cx":"8","cy":"19","r":"2"}]],"card-sim":[["path",{"d":"M12 14v4"}],["path",{"d":"M14.172 2a2 2 0 0 1 1.414.586l3.828 3.828A2 2 0 0 1 20 7.828V20a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"}],["path",{"d":"M8 14h8"}],["rect",{"x":"8","y":"10","width":"8","height":"8","rx":"2"}]],"carrot":[["path",{"d":"M15 16a1 1 0 0 0-7-7q-4 4-5.987 12.385a.5.5 0 0 0 .602.602Q11 20 15 16l-3-3"}],["path",{"d":"M15 9q4 4 7 0-3-4-7 0 4-4 0-7-4 3 0 7"}],["path",{"d":"m8 15-2.58-2.58"}]],"carton-off":[["path",{"d":"M10 10H5v10a2 2 0 002 2h10a2 2 0 002-2v-1"}],["path",{"d":"M13 22v-9"}],["path",{"d":"M13.902 8.245 16 6h-4.343"}],["path",{"d":"M19 13.343V10a2 2 0 00-.539-1.367L16 6V3a1 1 0 00-1-1H9a1 1 0 00-.857.486"}],["path",{"d":"m2 2 20 20"}],["path",{"d":"M7.034 7.034 5.539 8.633A2 2 0 005 10"}]],"carton":[["path",{"d":"M13 22V10a2 2 0 01.539-1.367L16 6H8L5.539 8.633A2 2 0 005 10v10a2 2 0 002 2h10a2 2 0 002-2V10a2 2 0 00-.539-1.367L16 6V3a1 1 0 00-1-1H9a1 1 0 00-1 1v3"}],["path",{"d":"M5 10h8"}]],"case-lower":[["path",{"d":"M10 9v7"}],["path",{"d":"M14 6v10"}],["circle",{"cx":"17.5","cy":"12.5","r":"3.5"}],["circle",{"cx":"6.5","cy":"12.5","r":"3.5"}]],"case-sensitive":[["path",{"d":"m2 16 4.039-9.69a.5.5 0 0 1 .923 0L11 16"}],["path",{"d":"M22 9v7"}],["path",{"d":"M3.304 13h6.392"}],["circle",{"cx":"18.5","cy":"12.5","r":"3.5"}]],"case-upper":[["path",{"d":"M15 11h4.5a1 1 0 0 1 0 5h-4a.5.5 0 0 1-.5-.5v-9a.5.5 0 0 1 .5-.5h3a1 1 0 0 1 0 5"}],["path",{"d":"m2 16 4.039-9.69a.5.5 0 0 1 .923 0L11 16"}],["path",{"d":"M3.304 13h6.392"}]],"cassette-tape":[["rect",{"width":"20","height":"16","x":"2","y":"4","rx":"2"}],["circle",{"cx":"8","cy":"10","r":"2"}],["path",{"d":"M8 12h8"}],["circle",{"cx":"16","cy":"10","r":"2"}],["path",{"d":"m6 20 .7-2.9A1.4 1.4 0 0 1 8.1 16h7.8a1.4 1.4 0 0 1 1.4 1l.7 3"}]],"cast":[["path",{"d":"M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6"}],["path",{"d":"M2 12a9 9 0 0 1 8 8"}],["path",{"d":"M2 16a5 5 0 0 1 4 4"}],["line",{"x1":"2","x2":"2.01","y1":"20","y2":"20"}]],"castle":[["path",{"d":"M10 5V3"}],["path",{"d":"M14 5V3"}],["path",{"d":"M15 21v-3a3 3 0 0 0-6 0v3"}],["path",{"d":"M18 3v8"}],["path",{"d":"M18 5H6"}],["path",{"d":"M22 11H2"}],["path",{"d":"M22 9v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9"}],["path",{"d":"M6 3v8"}]],"cat":[["path",{"d":"M12 5c.67 0 1.35.09 2 .26 1.78-2 5.03-2.84 6.42-2.26 1.4.58-.42 7-.42 7 .57 1.07 1 2.24 1 3.44C21 17.9 16.97 21 12 21s-9-3-9-7.56c0-1.25.5-2.4 1-3.44 0 0-1.89-6.42-.5-7 1.39-.58 4.72.23 6.5 2.23A9.04 9.04 0 0 1 12 5Z"}],["path",{"d":"M8 14v.5"}],["path",{"d":"M16 14v.5"}],["path",{"d":"M11.25 16.25h1.5L12 17l-.75-.75Z"}]],"cctv-off":[["path",{"d":"m12.309 6.652 4.797 2.401a1 1 0 0 1 .447 1.341l-.501 1.001.605.605h2.725a1 1 0 0 1 .894 1.447l-.724 1.448"}],["path",{"d":"m15.166 15.166-.719 1.439a1 1 0 0 1-1.342.447L3.61 12.3a2.92 2.92 0 0 1-1.3-3.91L3.69 5.6a2.9 2.9 0 0 1 .873-1.037"}],["path",{"d":"M2 19h3.76a2 2 0 0 0 1.8-1.1l1.441-2.902"}],["path",{"d":"m2 2 20 20"}],["path",{"d":"M2 21v-4"}],["path",{"d":"M7 9h.01"}]],"cctv":[["path",{"d":"M16.75 12h3.632a1 1 0 0 1 .894 1.447l-2.034 4.069a1 1 0 0 1-1.708.134l-2.124-2.97"}],["path",{"d":"M17.106 9.053a1 1 0 0 1 .447 1.341l-3.106 6.211a1 1 0 0 1-1.342.447L3.61 12.3a2.92 2.92 0 0 1-1.3-3.91L3.69 5.6a2.92 2.92 0 0 1 3.92-1.3z"}],["path",{"d":"M2 19h3.76a2 2 0 0 0 1.8-1.1L9 15"}],["path",{"d":"M2 21v-4"}],["path",{"d":"M7 9h.01"}]],"chart-area":[["path",{"d":"M3 3v16a2 2 0 0 0 2 2h16"}],["path",{"d":"M7 11.207a.5.5 0 0 1 .146-.353l2-2a.5.5 0 0 1 .708 0l3.292 3.292a.5.5 0 0 0 .708 0l4.292-4.292a.5.5 0 0 1 .854.353V16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1z"}]],"chart-bar-big":[["path",{"d":"M3 3v16a2 2 0 0 0 2 2h16"}],["rect",{"x":"7","y":"13","width":"9","height":"4","rx":"1"}],["rect",{"x":"7","y":"5","width":"12","height":"4","rx":"1"}]],"chart-bar-decreasing":[["path",{"d":"M3 3v16a2 2 0 0 0 2 2h16"}],["path",{"d":"M7 11h8"}],["path",{"d":"M7 16h3"}],["path",{"d":"M7 6h12"}]],"chart-bar-increasing":[["path",{"d":"M3 3v16a2 2 0 0 0 2 2h16"}],["path",{"d":"M7 11h8"}],["path",{"d":"M7 16h12"}],["path",{"d":"M7 6h3"}]],"chart-bar-stacked":[["path",{"d":"M11 13v4"}],["path",{"d":"M15 5v4"}],["path",{"d":"M3 3v16a2 2 0 0 0 2 2h16"}],["rect",{"x":"7","y":"13","width":"9","height":"4","rx":"1"}],["rect",{"x":"7","y":"5","width":"12","height":"4","rx":"1"}]],"chart-bar":[["path",{"d":"M3 3v16a2 2 0 0 0 2 2h16"}],["path",{"d":"M7 16h8"}],["path",{"d":"M7 11h12"}],["path",{"d":"M7 6h3"}]],"chart-candlestick":[["path",{"d":"M9 5v4"}],["rect",{"width":"4","height":"6","x":"7","y":"9","rx":"1"}],["path",{"d":"M9 15v2"}],["path",{"d":"M17 3v2"}],["rect",{"width":"4","height":"8","x":"15","y":"5","rx":"1"}],["path",{"d":"M17 13v3"}],["path",{"d":"M3 3v16a2 2 0 0 0 2 2h16"}]],"chart-column-big":[["path",{"d":"M3 3v16a2 2 0 0 0 2 2h16"}],["rect",{"x":"15","y":"5","width":"4","height":"12","rx":"1"}],["rect",{"x":"7","y":"8","width":"4","height":"9","rx":"1"}]],"chart-column-decreasing":[["path",{"d":"M13 17V9"}],["path",{"d":"M18 17v-3"}],["path",{"d":"M3 3v16a2 2 0 0 0 2 2h16"}],["path",{"d":"M8 17V5"}]],"chart-column-increasing":[["path",{"d":"M13 17V9"}],["path",{"d":"M18 17V5"}],["path",{"d":"M3 3v16a2 2 0 0 0 2 2h16"}],["path",{"d":"M8 17v-3"}]],"chart-column-stacked":[["path",{"d":"M11 13H7"}],["path",{"d":"M19 9h-4"}],["path",{"d":"M3 3v16a2 2 0 0 0 2 2h16"}],["rect",{"x":"15","y":"5","width":"4","height":"12","rx":"1"}],["rect",{"x":"7","y":"8","width":"4","height":"9","rx":"1"}]],"chart-column":[["path",{"d":"M3 3v16a2 2 0 0 0 2 2h16"}],["path",{"d":"M18 17V9"}],["path",{"d":"M13 17V5"}],["path",{"d":"M8 17v-3"}]],"chart-gantt":[["path",{"d":"M10 6h8"}],["path",{"d":"M12 16h6"}],["path",{"d":"M3 3v16a2 2 0 0 0 2 2h16"}],["path",{"d":"M8 11h7"}]],"chart-line":[["path",{"d":"M3 3v16a2 2 0 0 0 2 2h16"}],["path",{"d":"m19 9-5 5-4-4-3 3"}]],"chart-network":[["path",{"d":"m13.11 7.664 1.78 2.672"}],["path",{"d":"m14.162 12.788-3.324 1.424"}],["path",{"d":"m20 4-6.06 1.515"}],["path",{"d":"M3 3v16a2 2 0 0 0 2 2h16"}],["circle",{"cx":"12","cy":"6","r":"2"}],["circle",{"cx":"16","cy":"12","r":"2"}],["circle",{"cx":"9","cy":"15","r":"2"}]],"chart-no-axes-column-decreasing":[["path",{"d":"M5 21V3"}],["path",{"d":"M12 21V9"}],["path",{"d":"M19 21v-6"}]],"chart-no-axes-column-increasing":[["path",{"d":"M5 21v-6"}],["path",{"d":"M12 21V9"}],["path",{"d":"M19 21V3"}]],"chart-no-axes-column":[["path",{"d":"M5 21v-6"}],["path",{"d":"M12 21V3"}],["path",{"d":"M19 21V9"}]],"chart-no-axes-combined":[["path",{"d":"M12 16v5"}],["path",{"d":"M16 14.639V21"}],["path",{"d":"M20 10.656V21"}],["path",{"d":"m22 3-8.646 8.646a.5.5 0 0 1-.708 0L9.354 8.354a.5.5 0 0 0-.707 0L2 15"}],["path",{"d":"M4 18.463V21"}],["path",{"d":"M8 14.656V21"}]],"chart-no-axes-gantt":[["path",{"d":"M6 5h12"}],["path",{"d":"M4 12h10"}],["path",{"d":"M12 19h8"}]],"chart-pie":[["path",{"d":"M21 12c.552 0 1.005-.449.95-.998a10 10 0 0 0-8.953-8.951c-.55-.055-.998.398-.998.95v8a1 1 0 0 0 1 1z"}],["path",{"d":"M21.21 15.89A10 10 0 1 1 8 2.83"}]],"chart-scatter":[["circle",{"cx":"7.5","cy":"7.5","r":".5","fill":"currentColor"}],["circle",{"cx":"18.5","cy":"5.5","r":".5","fill":"currentColor"}],["circle",{"cx":"11.5","cy":"11.5","r":".5","fill":"currentColor"}],["circle",{"cx":"7.5","cy":"16.5","r":".5","fill":"currentColor"}],["circle",{"cx":"17.5","cy":"14.5","r":".5","fill":"currentColor"}],["path",{"d":"M3 3v16a2 2 0 0 0 2 2h16"}]],"chart-spline":[["path",{"d":"M3 3v16a2 2 0 0 0 2 2h16"}],["path",{"d":"M7 16c.5-2 1.5-7 4-7 2 0 2 3 4 3 2.5 0 4.5-5 5-7"}]],"check-check":[["path",{"d":"M18 6 7 17l-5-5"}],["path",{"d":"m22 10-7.5 7.5L13 16"}]],"check-line":[["path",{"d":"M20 4L9 15"}],["path",{"d":"M21 19L3 19"}],["path",{"d":"M9 15L4 10"}]],"check":[["path",{"d":"M20 6 9 17l-5-5"}]],"chef-hat":[["path",{"d":"M17 21a1 1 0 0 0 1-1v-5.35c0-.457.316-.844.727-1.041a4 4 0 0 0-2.134-7.589 5 5 0 0 0-9.186 0 4 4 0 0 0-2.134 7.588c.411.198.727.585.727 1.041V20a1 1 0 0 0 1 1Z"}],["path",{"d":"M6 17h12"}]],"cherry":[["path",{"d":"M2 17a5 5 0 0 0 10 0c0-2.76-2.5-5-5-3-2.5-2-5 .24-5 3Z"}],["path",{"d":"M12 17a5 5 0 0 0 10 0c0-2.76-2.5-5-5-3-2.5-2-5 .24-5 3Z"}],["path",{"d":"M7 14c3.22-2.91 4.29-8.75 5-12 1.66 2.38 4.94 9 5 12"}],["path",{"d":"M22 9c-4.29 0-7.14-2.33-10-7 5.71 0 10 4.67 10 7Z"}]],"chess-bishop":[["path",{"d":"M5 20a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v1a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z"}],["path",{"d":"M15 18c1.5-.615 3-2.461 3-4.923C18 8.769 14.5 4.462 12 2 9.5 4.462 6 8.77 6 13.077 6 15.539 7.5 17.385 9 18"}],["path",{"d":"m16 7-2.5 2.5"}],["path",{"d":"M9 2h6"}]],"chess-king":[["path",{"d":"M4 20a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v1a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"}],["path",{"d":"m6.7 18-1-1C4.35 15.682 3 14.09 3 12a5 5 0 0 1 4.95-5c1.584 0 2.7.455 4.05 1.818C13.35 7.455 14.466 7 16.05 7A5 5 0 0 1 21 12c0 2.082-1.359 3.673-2.7 5l-1 1"}],["path",{"d":"M10 4h4"}],["path",{"d":"M12 2v6.818"}]],"chess-knight":[["path",{"d":"M5 20a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v1a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z"}],["path",{"d":"M16.5 18c1-2 2.5-5 2.5-9a7 7 0 0 0-7-7H6.635a1 1 0 0 0-.768 1.64L7 5l-2.32 5.802a2 2 0 0 0 .95 2.526l2.87 1.456"}],["path",{"d":"m15 5 1.425-1.425"}],["path",{"d":"m17 8 1.53-1.53"}],["path",{"d":"M9.713 12.185 7 18"}]],"chess-pawn":[["path",{"d":"M5 20a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v1a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z"}],["path",{"d":"m14.5 10 1.5 8"}],["path",{"d":"M7 10h10"}],["path",{"d":"m8 18 1.5-8"}],["circle",{"cx":"12","cy":"6","r":"4"}]],"chess-queen":[["path",{"d":"M4 20a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v1a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"}],["path",{"d":"m12.474 5.943 1.567 5.34a1 1 0 0 0 1.75.328l2.616-3.402"}],["path",{"d":"m20 9-3 9"}],["path",{"d":"m5.594 8.209 2.615 3.403a1 1 0 0 0 1.75-.329l1.567-5.34"}],["path",{"d":"M7 18 4 9"}],["circle",{"cx":"12","cy":"4","r":"2"}],["circle",{"cx":"20","cy":"7","r":"2"}],["circle",{"cx":"4","cy":"7","r":"2"}]],"chess-rook":[["path",{"d":"M5 20a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v1a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z"}],["path",{"d":"M10 2v2"}],["path",{"d":"M14 2v2"}],["path",{"d":"m17 18-1-9"}],["path",{"d":"M6 2v5a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V2"}],["path",{"d":"M6 4h12"}],["path",{"d":"m7 18 1-9"}]],"chevron-down":[["path",{"d":"m6 9 6 6 6-6"}]],"chevron-first":[["path",{"d":"m17 18-6-6 6-6"}],["path",{"d":"M7 6v12"}]],"chevron-last":[["path",{"d":"m7 18 6-6-6-6"}],["path",{"d":"M17 6v12"}]],"chevron-left":[["path",{"d":"m15 18-6-6 6-6"}]],"chevron-right":[["path",{"d":"m9 18 6-6-6-6"}]],"chevron-up":[["path",{"d":"m18 15-6-6-6 6"}]],"chevrons-down-up":[["path",{"d":"m7 20 5-5 5 5"}],["path",{"d":"m7 4 5 5 5-5"}]],"chevrons-down":[["path",{"d":"m7 6 5 5 5-5"}],["path",{"d":"m7 13 5 5 5-5"}]],"chevrons-left-right-ellipsis":[["path",{"d":"M12 12h.01"}],["path",{"d":"M16 12h.01"}],["path",{"d":"m17 7 5 5-5 5"}],["path",{"d":"m7 7-5 5 5 5"}],["path",{"d":"M8 12h.01"}]],"chevrons-left-right":[["path",{"d":"m9 7-5 5 5 5"}],["path",{"d":"m15 7 5 5-5 5"}]],"chevrons-left":[["path",{"d":"m11 17-5-5 5-5"}],["path",{"d":"m18 17-5-5 5-5"}]],"chevrons-right-left":[["path",{"d":"m20 17-5-5 5-5"}],["path",{"d":"m4 17 5-5-5-5"}]],"chevrons-right":[["path",{"d":"m6 17 5-5-5-5"}],["path",{"d":"m13 17 5-5-5-5"}]],"chevrons-up-down":[["path",{"d":"m7 15 5 5 5-5"}],["path",{"d":"m7 9 5-5 5 5"}]],"chevrons-up":[["path",{"d":"m17 11-5-5-5 5"}],["path",{"d":"m17 18-5-5-5 5"}]],"church":[["path",{"d":"M10 9h4"}],["path",{"d":"M12 7v5"}],["path",{"d":"M14 21v-3a2 2 0 0 0-4 0v3"}],["path",{"d":"m18 9 3.52 2.147a1 1 0 0 1 .48.854V19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6.999a1 1 0 0 1 .48-.854L6 9"}],["path",{"d":"M6 21V7a1 1 0 0 1 .376-.782l5-3.999a1 1 0 0 1 1.249.001l5 4A1 1 0 0 1 18 7v14"}]],"cigarette-off":[["path",{"d":"M12 12H3a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h13"}],["path",{"d":"M18 8c0-2.5-2-2.5-2-5"}],["path",{"d":"m2 2 20 20"}],["path",{"d":"M21 12a1 1 0 0 1 1 1v2a1 1 0 0 1-.5.866"}],["path",{"d":"M22 8c0-2.5-2-2.5-2-5"}],["path",{"d":"M7 12v4"}]],"cigarette":[["path",{"d":"M17 12H3a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h14"}],["path",{"d":"M18 8c0-2.5-2-2.5-2-5"}],["path",{"d":"M21 16a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"}],["path",{"d":"M22 8c0-2.5-2-2.5-2-5"}],["path",{"d":"M7 12v4"}]],"circle-alert":[["circle",{"cx":"12","cy":"12","r":"10"}],["line",{"x1":"12","x2":"12","y1":"8","y2":"12"}],["line",{"x1":"12","x2":"12.01","y1":"16","y2":"16"}]],"circle-arrow-down":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M12 8v8"}],["path",{"d":"m8 12 4 4 4-4"}]],"circle-arrow-left":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"m12 8-4 4 4 4"}],["path",{"d":"M16 12H8"}]],"circle-arrow-out-down-left":[["path",{"d":"M2 12a10 10 0 1 1 10 10"}],["path",{"d":"m2 22 10-10"}],["path",{"d":"M8 22H2v-6"}]],"circle-arrow-out-down-right":[["path",{"d":"M12 22a10 10 0 1 1 10-10"}],["path",{"d":"M22 22 12 12"}],["path",{"d":"M22 16v6h-6"}]],"circle-arrow-out-up-left":[["path",{"d":"M2 8V2h6"}],["path",{"d":"m2 2 10 10"}],["path",{"d":"M12 2A10 10 0 1 1 2 12"}]],"circle-arrow-out-up-right":[["path",{"d":"M22 12A10 10 0 1 1 12 2"}],["path",{"d":"M22 2 12 12"}],["path",{"d":"M16 2h6v6"}]],"circle-arrow-right":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"m12 16 4-4-4-4"}],["path",{"d":"M8 12h8"}]],"circle-arrow-up":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"m16 12-4-4-4 4"}],["path",{"d":"M12 16V8"}]],"circle-check-big":[["path",{"d":"M21.801 10A10 10 0 1 1 17 3.335"}],["path",{"d":"m9 11 3 3L22 4"}]],"circle-check":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"m16 9-5.5 5.5L8 12"}]],"circle-chevron-down":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"m16 10-4 4-4-4"}]],"circle-chevron-left":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"m14 16-4-4 4-4"}]],"circle-chevron-right":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"m10 8 4 4-4 4"}]],"circle-chevron-up":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"m8 14 4-4 4 4"}]],"circle-dashed-check":[["path",{"d":"M10.1 2.182a10 10 0 013.8 0"}],["path",{"d":"M13.9 21.818a10 10 0 01-3.8 0"}],["path",{"d":"m16 9-5.5 5.5L8 12"}],["path",{"d":"M17.609 3.721a10 10 0 012.69 2.7"}],["path",{"d":"M2.182 13.9a10 10 0 010-3.8"}],["path",{"d":"M20.279 17.609a10 10 0 01-2.7 2.69"}],["path",{"d":"M21.818 10.1a10 10 0 010 3.8"}],["path",{"d":"M3.721 6.391a10 10 0 012.7-2.69"}],["path",{"d":"M6.391 20.279a10 10 0 01-2.69-2.7"}]],"circle-dashed":[["path",{"d":"M10.1 2.182a10 10 0 0 1 3.8 0"}],["path",{"d":"M13.9 21.818a10 10 0 0 1-3.8 0"}],["path",{"d":"M17.609 3.721a10 10 0 0 1 2.69 2.7"}],["path",{"d":"M2.182 13.9a10 10 0 0 1 0-3.8"}],["path",{"d":"M20.279 17.609a10 10 0 0 1-2.7 2.69"}],["path",{"d":"M21.818 10.1a10 10 0 0 1 0 3.8"}],["path",{"d":"M3.721 6.391a10 10 0 0 1 2.7-2.69"}],["path",{"d":"M6.391 20.279a10 10 0 0 1-2.69-2.7"}]],"circle-divide":[["circle",{"cx":"12","cy":"12","r":"10"}],["line",{"x1":"8","x2":"16","y1":"12","y2":"12"}],["line",{"x1":"12","x2":"12","y1":"16","y2":"16"}],["line",{"x1":"12","x2":"12","y1":"8","y2":"8"}]],"circle-dollar-sign":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"}],["path",{"d":"M12 18V6"}]],"circle-dot-dashed":[["path",{"d":"M10.1 2.18a9.93 9.93 0 0 1 3.8 0"}],["path",{"d":"M17.6 3.71a9.95 9.95 0 0 1 2.69 2.7"}],["path",{"d":"M21.82 10.1a9.93 9.93 0 0 1 0 3.8"}],["path",{"d":"M20.29 17.6a9.95 9.95 0 0 1-2.7 2.69"}],["path",{"d":"M13.9 21.82a9.94 9.94 0 0 1-3.8 0"}],["path",{"d":"M6.4 20.29a9.95 9.95 0 0 1-2.69-2.7"}],["path",{"d":"M2.18 13.9a9.93 9.93 0 0 1 0-3.8"}],["path",{"d":"M3.71 6.4a9.95 9.95 0 0 1 2.7-2.69"}],["circle",{"cx":"12","cy":"12","r":"1"}]],"circle-dot":[["circle",{"cx":"12","cy":"12","r":"1"}],["circle",{"cx":"12","cy":"12","r":"10"}]],"circle-ellipsis":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M17 12h.01"}],["path",{"d":"M12 12h.01"}],["path",{"d":"M7 12h.01"}]],"circle-equal":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M7 10h10"}],["path",{"d":"M7 14h10"}]],"circle-euro":[["path",{"d":"M15 9.4a4 4 0 1 0 0 5.2"}],["path",{"d":"M7 12h5"}],["circle",{"cx":"12","cy":"12","r":"10"}]],"circle-fading-arrow-up":[["path",{"d":"M12 2a10 10 0 0 1 7.38 16.75"}],["path",{"d":"m16 12-4-4-4 4"}],["path",{"d":"M12 16V8"}],["path",{"d":"M2.5 8.875a10 10 0 0 0-.5 3"}],["path",{"d":"M2.83 16a10 10 0 0 0 2.43 3.4"}],["path",{"d":"M4.636 5.235a10 10 0 0 1 .891-.857"}],["path",{"d":"M8.644 21.42a10 10 0 0 0 7.631-.38"}]],"circle-fading-plus":[["path",{"d":"M12 2a10 10 0 0 1 7.38 16.75"}],["path",{"d":"M12 8v8"}],["path",{"d":"M16 12H8"}],["path",{"d":"M2.5 8.875a10 10 0 0 0-.5 3"}],["path",{"d":"M2.83 16a10 10 0 0 0 2.43 3.4"}],["path",{"d":"M4.636 5.235a10 10 0 0 1 .891-.857"}],["path",{"d":"M8.644 21.42a10 10 0 0 0 7.631-.38"}]],"circle-gauge":[["path",{"d":"M15.6 2.7a10 10 0 1 0 5.7 5.7"}],["circle",{"cx":"12","cy":"12","r":"2"}],["path",{"d":"M13.4 10.6 19 5"}]],"circle-minus":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M8 12h8"}]],"circle-off":[["path",{"d":"m2 2 20 20"}],["path",{"d":"M8.35 2.69A10 10 0 0 1 21.3 15.65"}],["path",{"d":"M19.08 19.08A10 10 0 1 1 4.92 4.92"}]],"circle-parking-off":[["path",{"d":"M12.656 7H13a3 3 0 0 1 2.984 3.307"}],["path",{"d":"M13 13H9"}],["path",{"d":"M19.071 19.071A1 1 0 0 1 4.93 4.93"}],["path",{"d":"m2 2 20 20"}],["path",{"d":"M8.357 2.687a10 10 0 0 1 12.956 12.956"}],["path",{"d":"M9 17V9"}]],"circle-parking":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M9 17V7h4a3 3 0 0 1 0 6H9"}]],"circle-pause":[["circle",{"cx":"12","cy":"12","r":"10"}],["line",{"x1":"10","x2":"10","y1":"15","y2":"9"}],["line",{"x1":"14","x2":"14","y1":"15","y2":"9"}]],"circle-percent":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"m15 9-6 6"}],["path",{"d":"M9 9h.01"}],["path",{"d":"M15 15h.01"}]],"circle-pile":[["circle",{"cx":"12","cy":"19","r":"2"}],["circle",{"cx":"12","cy":"5","r":"2"}],["circle",{"cx":"16","cy":"12","r":"2"}],["circle",{"cx":"20","cy":"19","r":"2"}],["circle",{"cx":"4","cy":"19","r":"2"}],["circle",{"cx":"8","cy":"12","r":"2"}]],"circle-play":[["path",{"d":"M9 9.003a1 1 0 0 1 1.517-.859l4.997 2.997a1 1 0 0 1 0 1.718l-4.997 2.997A1 1 0 0 1 9 14.996z"}],["circle",{"cx":"12","cy":"12","r":"10"}]],"circle-plus":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M8 12h8"}],["path",{"d":"M12 8v8"}]],"circle-pound-sterling":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M10 16V9.5a1 1 0 0 1 5 0"}],["path",{"d":"M8 12h4"}],["path",{"d":"M8 16h7"}]],"circle-power":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M12 7v4"}],["path",{"d":"M7.998 9.003a5 5 0 1 0 8-.005"}]],"circle-question-mark":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"}],["path",{"d":"M12 17h.01"}]],"circle-slash-2":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M22 2 2 22"}]],"circle-slash":[["circle",{"cx":"12","cy":"12","r":"10"}],["line",{"x1":"9","x2":"15","y1":"15","y2":"9"}]],"circle-small":[["circle",{"cx":"12","cy":"12","r":"6"}]],"circle-star":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M11.051 7.616a1 1 0 0 1 1.909.024l.737 1.452a1 1 0 0 0 .737.535l1.634.256a1 1 0 0 1 .588 1.806l-1.172 1.168a1 1 0 0 0-.282.866l.259 1.613a1 1 0 0 1-1.541 1.134l-1.465-.75a1 1 0 0 0-.912 0l-1.465.75a1 1 0 0 1-1.539-1.133l.258-1.613a1 1 0 0 0-.282-.867l-1.156-1.152a1 1 0 0 1 .572-1.822l1.633-.256a1 1 0 0 0 .737-.535z"}]],"circle-stop":[["circle",{"cx":"12","cy":"12","r":"10"}],["rect",{"x":"9","y":"9","width":"6","height":"6","rx":"1"}]],"circle-user-round":[["path",{"d":"M17.925 20.056a6 6 0 0 0-11.851.001"}],["circle",{"cx":"12","cy":"11","r":"4"}],["circle",{"cx":"12","cy":"12","r":"10"}]],"circle-user":[["circle",{"cx":"12","cy":"12","r":"10"}],["circle",{"cx":"12","cy":"10","r":"3"}],["path",{"d":"M7 20.662V19a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v1.662"}]],"circle-x":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"m15 9-6 6"}],["path",{"d":"m9 9 6 6"}]],"circle":[["circle",{"cx":"12","cy":"12","r":"10"}]],"circuit-board":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M11 9h4a2 2 0 0 0 2-2V3"}],["circle",{"cx":"9","cy":"9","r":"2"}],["path",{"d":"M7 21v-4a2 2 0 0 1 2-2h4"}],["circle",{"cx":"15","cy":"15","r":"2"}]],"citrus":[["path",{"d":"M21.66 17.67a1.08 1.08 0 0 1-.04 1.6A12 12 0 0 1 4.73 2.38a1.1 1.1 0 0 1 1.61-.04z"}],["path",{"d":"M19.65 15.66A8 8 0 0 1 8.35 4.34"}],["path",{"d":"m14 10-5.5 5.5"}],["path",{"d":"M14 17.85V10H6.15"}]],"clapperboard":[["path",{"d":"m12.296 3.464 3.02 3.956"}],["path",{"d":"M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3z"}],["path",{"d":"M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"}],["path",{"d":"m6.18 5.276 3.1 3.899"}]],"clef-alto":[["path",{"d":"M10 4v16"}],["path",{"d":"M14 4.764a3 3 0 1 1-.152 4.327A4 4 0 0 1 10 12a4 4 0 0 1 3.848 2.909A3 3 0 1 1 14 19.236"}],["path",{"d":"M6 4v16"}]],"clef-bass":[["path",{"d":"M19 11h.01"}],["path",{"d":"M19 6h.01"}],["path",{"d":"M5 8c0-4 4-4 4-4 6 0 6 6 6 6 0 7-10 11-10 11"}],["circle",{"cx":"7","cy":"8","r":"2"}]],"clef-treble":[["path",{"d":"M10.586 21.414a2 2 0 0 0 3.378-1.791L11.036 4.377a2 2 0 1 1 3.378 1.037C12.414 7.414 7 8 7 13a5 5 0 0 0 5 5 5 4 0 0 0 5-4 3 3 0 0 0-3-3 3 2 0 0 0-3 2"}]],"clipboard-check":[["rect",{"width":"8","height":"4","x":"8","y":"2","rx":"1","ry":"1"}],["path",{"d":"M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"}],["path",{"d":"m9 14 2 2 4-4"}]],"clipboard-clock":[["path",{"d":"M16 14v2.2l1.6 1"}],["path",{"d":"M16 4h2a2 2 0 0 1 2 2v.832"}],["path",{"d":"M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h2"}],["circle",{"cx":"16","cy":"16","r":"6"}],["rect",{"x":"8","y":"2","width":"8","height":"4","rx":"1"}]],"clipboard-copy":[["rect",{"width":"8","height":"4","x":"8","y":"2","rx":"1","ry":"1"}],["path",{"d":"M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"}],["path",{"d":"M16 4h2a2 2 0 0 1 2 2v4"}],["path",{"d":"M21 14H11"}],["path",{"d":"m15 10-4 4 4 4"}]],"clipboard-list":[["rect",{"width":"8","height":"4","x":"8","y":"2","rx":"1","ry":"1"}],["path",{"d":"M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"}],["path",{"d":"M12 11h4"}],["path",{"d":"M12 16h4"}],["path",{"d":"M8 11h.01"}],["path",{"d":"M8 16h.01"}]],"clipboard-minus":[["rect",{"width":"8","height":"4","x":"8","y":"2","rx":"1","ry":"1"}],["path",{"d":"M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"}],["path",{"d":"M9 14h6"}]],"clipboard-paste":[["path",{"d":"M11 14h10"}],["path",{"d":"M16 4h2a2 2 0 0 1 2 2v1.344"}],["path",{"d":"m17 18 4-4-4-4"}],["path",{"d":"M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 1.793-1.113"}],["rect",{"x":"8","y":"2","width":"8","height":"4","rx":"1"}]],"clipboard-pen-line":[["rect",{"width":"8","height":"4","x":"8","y":"2","rx":"1"}],["path",{"d":"M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-.5"}],["path",{"d":"M16 4h2a2 2 0 0 1 1.73 1"}],["path",{"d":"M8 18h1"}],["path",{"d":"M21.378 12.626a1 1 0 0 0-3.004-3.004l-4.01 4.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z"}]],"clipboard-pen":[["path",{"d":"M16 4h2a2 2 0 0 1 2 2v2"}],["path",{"d":"M21.34 15.664a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z"}],["path",{"d":"M8 22H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"}],["rect",{"x":"8","y":"2","width":"8","height":"4","rx":"1"}]],"clipboard-plus":[["rect",{"width":"8","height":"4","x":"8","y":"2","rx":"1","ry":"1"}],["path",{"d":"M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"}],["path",{"d":"M9 14h6"}],["path",{"d":"M12 17v-6"}]],"clipboard-type":[["rect",{"width":"8","height":"4","x":"8","y":"2","rx":"1","ry":"1"}],["path",{"d":"M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"}],["path",{"d":"M9 12v-1h6v1"}],["path",{"d":"M11 17h2"}],["path",{"d":"M12 11v6"}]],"clipboard-x":[["rect",{"width":"8","height":"4","x":"8","y":"2","rx":"1","ry":"1"}],["path",{"d":"M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"}],["path",{"d":"m14.5 11.5-5 5"}],["path",{"d":"m9.5 11.5 5 5"}]],"clipboard":[["rect",{"width":"8","height":"4","x":"8","y":"2","rx":"1","ry":"1"}],["path",{"d":"M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"}]],"clock-1":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M12 6v6l2-4"}]],"clock-10":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M12 6v6l-4-2"}]],"clock-11":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M12 6v6l-2-4"}]],"clock-12":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M12 6v6"}]],"clock-2":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M12 6v6l4-2"}]],"clock-3":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M12 6v6h4"}]],"clock-4":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M12 6v6l4 2"}]],"clock-5":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M12 6v6l2 4"}]],"clock-6":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M12 6v10"}]],"clock-7":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M12 6v6l-2 4"}]],"clock-8":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M12 6v6l-4 2"}]],"clock-9":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M12 6v6H8"}]],"clock-alert":[["path",{"d":"M12 6v6l4 2"}],["path",{"d":"M20 12v5"}],["path",{"d":"M20 21h.01"}],["path",{"d":"M21.25 8.2A10 10 0 1 0 16 21.16"}]],"clock-arrow-down":[["path",{"d":"M12 6v6l2 1"}],["path",{"d":"M12.337 21.994a10 10 0 1 1 9.588-8.767"}],["path",{"d":"m14 18 4 4 4-4"}],["path",{"d":"M18 14v8"}]],"clock-arrow-left":[["path",{"d":"M12 6v6l1.5.8"}],["path",{"d":"M12.338 21.994a10 10 0 1 1 9.587-8.767"}],["path",{"d":"M14 18h8"}],["path",{"d":"m18 22-4-4 4-4"}]],"clock-arrow-right":[["path",{"d":"M12 6v6l2 1"}],["path",{"d":"M13.5 21.885A10 10 0 1 1 22 12"}],["path",{"d":"M14 18h8"}],["path",{"d":"m18 22 4-4-4-4"}]],"clock-arrow-up":[["path",{"d":"M12 6v6l1.56.78"}],["path",{"d":"M13.227 21.925a10 10 0 1 1 8.767-9.588"}],["path",{"d":"m14 18 4-4 4 4"}],["path",{"d":"M18 22v-8"}]],"clock-check":[["path",{"d":"M21.95 13a10 10 0 1 0-8.685 8.92"}],["path",{"d":"M12 6v6l4 2"}],["path",{"d":"m16 19 2 2 4-4"}]],"clock-fading":[["path",{"d":"M12 2a10 10 0 0 1 7.38 16.75"}],["path",{"d":"M12 6v6l4 2"}],["path",{"d":"M2.5 8.875a10 10 0 0 0-.5 3"}],["path",{"d":"M2.83 16a10 10 0 0 0 2.43 3.4"}],["path",{"d":"M4.636 5.235a10 10 0 0 1 .891-.857"}],["path",{"d":"M8.644 21.42a10 10 0 0 0 7.631-.38"}]],"clock-plus":[["path",{"d":"M12 6v6l3.644 1.822"}],["path",{"d":"M16 19h6"}],["path",{"d":"M19 16v6"}],["path",{"d":"M21.92 13.267a10 10 0 1 0-8.653 8.653"}]],"clock":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M12 6v6l4 2"}]],"closed-caption":[["path",{"d":"M10 9.17a3 3 0 1 0 0 5.66"}],["path",{"d":"M17 9.17a3 3 0 1 0 0 5.66"}],["rect",{"x":"2","y":"5","width":"20","height":"14","rx":"2"}]],"cloud-alert":[["path",{"d":"M12 12v4"}],["path",{"d":"M12 20h.01"}],["path",{"d":"M8.128 16.949A7 7 0 1 1 15.71 8h1.79a1 1 0 0 1 0 9h-1.642"}]],"cloud-backup":[["path",{"d":"M21 15.251A4.5 4.5 0 0 0 17.5 8h-1.79A7 7 0 1 0 3 13.607"}],["path",{"d":"M7 11v4h4"}],["path",{"d":"M8 19a5 5 0 0 0 9-3 4.5 4.5 0 0 0-4.5-4.5 4.82 4.82 0 0 0-3.41 1.41L7 15"}]],"cloud-check":[["path",{"d":"m17 15-5.5 5.5L9 18"}],["path",{"d":"M5.516 16.07A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 3.501 7.327"}]],"cloud-cog":[["path",{"d":"m10.852 19.772-.383.924"}],["path",{"d":"m13.148 14.228.383-.923"}],["path",{"d":"M13.148 19.772a3 3 0 1 0-2.296-5.544l-.383-.923"}],["path",{"d":"m13.53 20.696-.382-.924a3 3 0 1 1-2.296-5.544"}],["path",{"d":"m14.772 15.852.923-.383"}],["path",{"d":"m14.772 18.148.923.383"}],["path",{"d":"M4.2 15.1a7 7 0 1 1 9.93-9.858A7 7 0 0 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.2"}],["path",{"d":"m9.228 15.852-.923-.383"}],["path",{"d":"m9.228 18.148-.923.383"}]],"cloud-download":[["path",{"d":"M12 13v8l-4-4"}],["path",{"d":"m12 21 4-4"}],["path",{"d":"M4.393 15.269A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.436 8.284"}]],"cloud-drizzle":[["path",{"d":"M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"}],["path",{"d":"M8 19v1"}],["path",{"d":"M8 14v1"}],["path",{"d":"M16 19v1"}],["path",{"d":"M16 14v1"}],["path",{"d":"M12 21v1"}],["path",{"d":"M12 16v1"}]],"cloud-fog":[["path",{"d":"M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"}],["path",{"d":"M16 17H7"}],["path",{"d":"M17 21H9"}]],"cloud-hail":[["path",{"d":"M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"}],["path",{"d":"M16 14v2"}],["path",{"d":"M8 14v2"}],["path",{"d":"M16 20h.01"}],["path",{"d":"M8 20h.01"}],["path",{"d":"M12 16v2"}],["path",{"d":"M12 22h.01"}]],"cloud-lightning":[["path",{"d":"M6 16.326A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 .5 8.973"}],["path",{"d":"m13 12-3 5h4l-3 5"}]],"cloud-moon-rain":[["path",{"d":"M11 20v2"}],["path",{"d":"M18.376 14.512a6 6 0 0 0 3.461-4.127c.148-.625-.659-.97-1.248-.714a4 4 0 0 1-5.259-5.26c.255-.589-.09-1.395-.716-1.248a6 6 0 0 0-4.594 5.36"}],["path",{"d":"M3 20a5 5 0 1 1 8.9-4H13a3 3 0 0 1 2 5.24"}],["path",{"d":"M7 19v2"}]],"cloud-moon":[["path",{"d":"M13 16a3 3 0 0 1 0 6H7a5 5 0 1 1 4.9-6z"}],["path",{"d":"M18.376 14.512a6 6 0 0 0 3.461-4.127c.148-.625-.659-.97-1.248-.714a4 4 0 0 1-5.259-5.26c.255-.589-.09-1.395-.716-1.248a6 6 0 0 0-4.594 5.36"}]],"cloud-off":[["path",{"d":"M10.94 5.274A7 7 0 0 1 15.71 10h1.79a4.5 4.5 0 0 1 4.222 6.057"}],["path",{"d":"M18.796 18.81A4.5 4.5 0 0 1 17.5 19H9A7 7 0 0 1 5.79 5.78"}],["path",{"d":"m2 2 20 20"}]],"cloud-rain-wind":[["path",{"d":"M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"}],["path",{"d":"m9.2 22 3-7"}],["path",{"d":"m9 13-3 7"}],["path",{"d":"m17 13-3 7"}]],"cloud-rain":[["path",{"d":"M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"}],["path",{"d":"M16 14v6"}],["path",{"d":"M8 14v6"}],["path",{"d":"M12 16v6"}]],"cloud-snow":[["path",{"d":"M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"}],["path",{"d":"M8 15h.01"}],["path",{"d":"M8 19h.01"}],["path",{"d":"M12 17h.01"}],["path",{"d":"M12 21h.01"}],["path",{"d":"M16 15h.01"}],["path",{"d":"M16 19h.01"}]],"cloud-sun-rain":[["path",{"d":"M12 2v2"}],["path",{"d":"m4.93 4.93 1.41 1.41"}],["path",{"d":"M20 12h2"}],["path",{"d":"m19.07 4.93-1.41 1.41"}],["path",{"d":"M15.947 12.65a4 4 0 0 0-5.925-4.128"}],["path",{"d":"M3 20a5 5 0 1 1 8.9-4H13a3 3 0 0 1 2 5.24"}],["path",{"d":"M11 20v2"}],["path",{"d":"M7 19v2"}]],"cloud-sun":[["path",{"d":"M12 2v2"}],["path",{"d":"m4.93 4.93 1.41 1.41"}],["path",{"d":"M20 12h2"}],["path",{"d":"m19.07 4.93-1.41 1.41"}],["path",{"d":"M15.947 12.65a4 4 0 0 0-5.925-4.128"}],["path",{"d":"M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z"}]],"cloud-sync":[["path",{"d":"m17 18-1.535 1.605a5 5 0 0 1-8-1.5"}],["path",{"d":"M17 22v-4h-4"}],["path",{"d":"M20.996 15.251A4.5 4.5 0 0 0 17.495 8h-1.79a7 7 0 1 0-12.709 5.607"}],["path",{"d":"M7 10v4h4"}],["path",{"d":"m7 14 1.535-1.605a5 5 0 0 1 8 1.5"}]],"cloud-upload":[["path",{"d":"M12 13v8"}],["path",{"d":"M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"}],["path",{"d":"m8 17 4-4 4 4"}]],"cloud":[["path",{"d":"M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"}]],"cloudy":[["path",{"d":"M17.5 12a1 1 0 1 1 0 9H9.006a7 7 0 1 1 6.702-9z"}],["path",{"d":"M21.832 9A3 3 0 0 0 19 7h-2.207a5.5 5.5 0 0 0-10.72.61"}]],"clover":[["path",{"d":"M16.17 7.83 2 22"}],["path",{"d":"M4.02 12a2.827 2.827 0 1 1 3.81-4.17A2.827 2.827 0 1 1 12 4.02a2.827 2.827 0 1 1 4.17 3.81A2.827 2.827 0 1 1 19.98 12a2.827 2.827 0 1 1-3.81 4.17A2.827 2.827 0 1 1 12 19.98a2.827 2.827 0 1 1-4.17-3.81A1 1 0 1 1 4 12"}],["path",{"d":"m7.83 7.83 8.34 8.34"}]],"club":[["path",{"d":"M17.28 9.05a5.5 5.5 0 1 0-10.56 0A5.5 5.5 0 1 0 12 17.66a5.5 5.5 0 1 0 5.28-8.6Z"}],["path",{"d":"M12 17.66L12 22"}]],"code-xml":[["path",{"d":"m18 16 4-4-4-4"}],["path",{"d":"m6 8-4 4 4 4"}],["path",{"d":"m14.5 4-5 16"}]],"code":[["path",{"d":"m16 18 6-6-6-6"}],["path",{"d":"m8 6-6 6 6 6"}]],"coffee":[["path",{"d":"M10 2v2"}],["path",{"d":"M14 2v2"}],["path",{"d":"M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1"}],["path",{"d":"M6 2v2"}]],"cog":[["path",{"d":"M11 10.27 7 3.34"}],["path",{"d":"m11 13.73-4 6.93"}],["path",{"d":"M12 22v-2"}],["path",{"d":"M12 2v2"}],["path",{"d":"M14 12h8"}],["path",{"d":"m17 20.66-1-1.73"}],["path",{"d":"m17 3.34-1 1.73"}],["path",{"d":"M2 12h2"}],["path",{"d":"m20.66 17-1.73-1"}],["path",{"d":"m20.66 7-1.73 1"}],["path",{"d":"m3.34 17 1.73-1"}],["path",{"d":"m3.34 7 1.73 1"}],["circle",{"cx":"12","cy":"12","r":"2"}],["circle",{"cx":"12","cy":"12","r":"8"}]],"coins":[["path",{"d":"M13.744 17.736a6 6 0 1 1-7.48-7.48"}],["path",{"d":"M15 6h1v4"}],["path",{"d":"m6.134 14.768.866-.5 2 3.464"}],["circle",{"cx":"16","cy":"8","r":"6"}]],"columns-2":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M12 3v18"}]],"columns-3-cog":[["path",{"d":"M10.6 21H5a2 2 0 01-2-2V5a2 2 0 012-2h14a2 2 0 012 2v5.6"}],["path",{"d":"m14.305 19.53.923-.382"}],["path",{"d":"M15 3v7.6"}],["path",{"d":"m15.229 16.852-.924-.383"}],["path",{"d":"m16.852 15.228-.383-.923"}],["path",{"d":"m16.852 20.772-.383.924"}],["path",{"d":"m19.148 15.228.383-.923"}],["path",{"d":"m19.53 21.696-.382-.924"}],["path",{"d":"m20.773 16.852.922-.383"}],["path",{"d":"m20.773 19.148.922.383"}],["path",{"d":"M9 3v18"}],["circle",{"cx":"18","cy":"18","r":"3"}]],"columns-3":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M9 3v18"}],["path",{"d":"M15 3v18"}]],"columns-4":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M7.5 3v18"}],["path",{"d":"M12 3v18"}],["path",{"d":"M16.5 3v18"}]],"combine":[["path",{"d":"M14 3a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1"}],["path",{"d":"M19 3a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1"}],["path",{"d":"m7 15 3 3"}],["path",{"d":"m7 21 3-3H5a2 2 0 0 1-2-2v-2"}],["rect",{"x":"14","y":"14","width":"7","height":"7","rx":"1"}],["rect",{"x":"3","y":"3","width":"7","height":"7","rx":"1"}]],"command":[["path",{"d":"M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"}]],"compass":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z"}]],"component":[["path",{"d":"M15.536 11.293a1 1 0 0 0 0 1.414l2.376 2.377a1 1 0 0 0 1.414 0l2.377-2.377a1 1 0 0 0 0-1.414l-2.377-2.377a1 1 0 0 0-1.414 0z"}],["path",{"d":"M2.297 11.293a1 1 0 0 0 0 1.414l2.377 2.377a1 1 0 0 0 1.414 0l2.377-2.377a1 1 0 0 0 0-1.414L6.088 8.916a1 1 0 0 0-1.414 0z"}],["path",{"d":"M8.916 17.912a1 1 0 0 0 0 1.415l2.377 2.376a1 1 0 0 0 1.414 0l2.377-2.376a1 1 0 0 0 0-1.415l-2.377-2.376a1 1 0 0 0-1.414 0z"}],["path",{"d":"M8.916 4.674a1 1 0 0 0 0 1.414l2.377 2.376a1 1 0 0 0 1.414 0l2.377-2.376a1 1 0 0 0 0-1.414l-2.377-2.377a1 1 0 0 0-1.414 0z"}]],"computer":[["path",{"d":"M12 18h6"}],["path",{"d":"M6 18h.01"}],["path",{"d":"M8 6h1"}],["rect",{"x":"2","y":"14","width":"20","height":"8","rx":"2"}],["rect",{"x":"4","y":"2","width":"16","height":"12","rx":"2"}]],"concierge-bell":[["path",{"d":"M3 20a1 1 0 0 1-1-1v-1a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v1a1 1 0 0 1-1 1Z"}],["path",{"d":"M20 16a8 8 0 1 0-16 0"}],["path",{"d":"M12 4v4"}],["path",{"d":"M10 4h4"}]],"cone":[["path",{"d":"m20.9 18.55-8-15.98a1 1 0 0 0-1.8 0l-8 15.98"}],["ellipse",{"cx":"12","cy":"19","rx":"9","ry":"3"}]],"construction":[["rect",{"x":"2","y":"6","width":"20","height":"8","rx":"1"}],["path",{"d":"M17 14v7"}],["path",{"d":"M7 14v7"}],["path",{"d":"M17 3v3"}],["path",{"d":"M7 3v3"}],["path",{"d":"M10 14 2.3 6.3"}],["path",{"d":"m14 6 7.7 7.7"}],["path",{"d":"m8 6 8 8"}]],"contact-round":[["path",{"d":"M16 2v2"}],["path",{"d":"M17.915 21a6 6 0 10-12 0"}],["path",{"d":"M8 2v2"}],["circle",{"cx":"12","cy":"11","r":"4"}],["rect",{"x":"3","y":"3","width":"18","height":"18","rx":"2"}]],"contact":[["path",{"d":"M16 2v2"}],["path",{"d":"M7 21v-2a2 2 0 012-2h6a2 2 0 012 2v2"}],["path",{"d":"M8 2v2"}],["circle",{"cx":"12","cy":"10","r":"3"}],["rect",{"x":"3","y":"3","width":"18","height":"18","rx":"2"}]],"container":[["path",{"d":"M22 7.7c0-.6-.4-1.2-.8-1.5l-6.3-3.9a1.72 1.72 0 0 0-1.7 0l-10.3 6c-.5.2-.9.8-.9 1.4v6.6c0 .5.4 1.2.8 1.5l6.3 3.9a1.72 1.72 0 0 0 1.7 0l10.3-6c.5-.3.9-1 .9-1.5Z"}],["path",{"d":"M10 21.9V14L2.1 9.1"}],["path",{"d":"m10 14 11.9-6.9"}],["path",{"d":"M14 19.8v-8.1"}],["path",{"d":"M18 17.5V9.4"}]],"contrast":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M12 18a6 6 0 0 0 0-12v12z"}]],"cookie":[["path",{"d":"M11 17h.01"}],["path",{"d":"M11.496 2c.324-.016.558.292.529.615a4 4 0 004.235 4.368.713.713 0 01.758.757 4 4 0 004.366 4.237c.323-.03.63.204.614.527a10 10 0 01-2.915 6.566A1 1 0 114.93 4.918 10 10 0 0111.496 2"}],["path",{"d":"M12 12h.01"}],["path",{"d":"M16 16h.01"}],["path",{"d":"M16 3h.01"}],["path",{"d":"M21 4h.01"}],["path",{"d":"M21 8h.01"}],["path",{"d":"M7 14h.01"}],["path",{"d":"M9 8h.01"}]],"cooking-pot":[["path",{"d":"M2 12h20"}],["path",{"d":"M20 12v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8"}],["path",{"d":"m4 8 16-4"}],["path",{"d":"m8.86 6.78-.45-1.81a2 2 0 0 1 1.45-2.43l1.94-.48a2 2 0 0 1 2.43 1.46l.45 1.8"}]],"copy-check":[["path",{"d":"m12 15 2 2 4-4"}],["rect",{"width":"14","height":"14","x":"8","y":"8","rx":"2","ry":"2"}],["path",{"d":"M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"}]],"copy-minus":[["line",{"x1":"12","x2":"18","y1":"15","y2":"15"}],["rect",{"width":"14","height":"14","x":"8","y":"8","rx":"2","ry":"2"}],["path",{"d":"M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"}]],"copy-plus":[["line",{"x1":"15","x2":"15","y1":"12","y2":"18"}],["line",{"x1":"12","x2":"18","y1":"15","y2":"15"}],["rect",{"width":"14","height":"14","x":"8","y":"8","rx":"2","ry":"2"}],["path",{"d":"M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"}]],"copy-slash":[["line",{"x1":"12","x2":"18","y1":"18","y2":"12"}],["rect",{"width":"14","height":"14","x":"8","y":"8","rx":"2","ry":"2"}],["path",{"d":"M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"}]],"copy-x":[["path",{"d":"M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2"}],["rect",{"x":"8","y":"8","width":"14","height":"14","rx":"2"}],["path",{"d":"m12.5 12.5 5 5"}],["path",{"d":"m12.5 17.5 5-5"}]],"copy":[["rect",{"width":"14","height":"14","x":"8","y":"8","rx":"2","ry":"2"}],["path",{"d":"M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"}]],"copyleft":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M9.17 14.83a4 4 0 1 0 0-5.66"}]],"copyright":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M14.83 14.83a4 4 0 1 1 0-5.66"}]],"corner-down-left":[["path",{"d":"M20 4v7a4 4 0 0 1-4 4H4"}],["path",{"d":"m9 10-5 5 5 5"}]],"corner-down-right":[["path",{"d":"m15 10 5 5-5 5"}],["path",{"d":"M4 4v7a4 4 0 0 0 4 4h12"}]],"corner-left-down":[["path",{"d":"m14 15-5 5-5-5"}],["path",{"d":"M20 4h-7a4 4 0 0 0-4 4v12"}]],"corner-left-up":[["path",{"d":"M14 9 9 4 4 9"}],["path",{"d":"M20 20h-7a4 4 0 0 1-4-4V4"}]],"corner-right-down":[["path",{"d":"m10 15 5 5 5-5"}],["path",{"d":"M4 4h7a4 4 0 0 1 4 4v12"}]],"corner-right-up":[["path",{"d":"m10 9 5-5 5 5"}],["path",{"d":"M4 20h7a4 4 0 0 0 4-4V4"}]],"corner-up-left":[["path",{"d":"M20 20v-7a4 4 0 0 0-4-4H4"}],["path",{"d":"M9 14 4 9l5-5"}]],"corner-up-right":[["path",{"d":"m15 14 5-5-5-5"}],["path",{"d":"M4 20v-7a4 4 0 0 1 4-4h12"}]],"cpu":[["path",{"d":"M12 20v2"}],["path",{"d":"M12 2v2"}],["path",{"d":"M17 20v2"}],["path",{"d":"M17 2v2"}],["path",{"d":"M2 12h2"}],["path",{"d":"M2 17h2"}],["path",{"d":"M2 7h2"}],["path",{"d":"M20 12h2"}],["path",{"d":"M20 17h2"}],["path",{"d":"M20 7h2"}],["path",{"d":"M7 20v2"}],["path",{"d":"M7 2v2"}],["rect",{"x":"4","y":"4","width":"16","height":"16","rx":"2"}],["rect",{"x":"8","y":"8","width":"8","height":"8","rx":"1"}]],"creative-commons":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M10 9.3a2.8 2.8 0 0 0-3.5 1 3.1 3.1 0 0 0 0 3.4 2.7 2.7 0 0 0 3.5 1"}],["path",{"d":"M17 9.3a2.8 2.8 0 0 0-3.5 1 3.1 3.1 0 0 0 0 3.4 2.7 2.7 0 0 0 3.5 1"}]],"credit-card-check":[["path",{"d":"M12.5 19H4a2 2 0 01-2-2V7a2 2 0 012-2h16a2 2 0 012 2v4"}],["path",{"d":"M2 10h20"}],["path",{"d":"M6 14h2"}],["path",{"d":"m16 17 2 2 4-4"}]],"credit-card-minus":[["path",{"d":"M22 13V7a2 2 0 00-2-2H4a2 2 0 00-2 2v10a2 2 0 002 2h8.536"}],["path",{"d":"M22 10H2"}],["path",{"d":"M6 14h2"}],["path",{"d":"M16 17h6"}]],"credit-card-plus":[["path",{"d":"M22 11.354V7a2 2 0 00-2-2H4a2 2 0 00-2 2v10a2 2 0 002 2h8.536"}],["path",{"d":"M22 10H2"}],["path",{"d":"M6 14h2"}],["path",{"d":"M16 17h6"}],["path",{"d":"M19 14v6"}]],"credit-card-reader":[["path",{"d":"M15 16v1"}],["path",{"d":"M16.963 7.734A1 1 0 0015.999 7H8.003a1 1 0 00-.964.734L4.073 18.467A2 2 0 006 21h12a2 2 0 001.927-2.532z"}],["path",{"d":"M2.678 8.5A2 2 0 012 7V5a2 2 0 012-2h16a2 2 0 012 2v2a2 2 0 01-.676 1.499"}],["path",{"d":"m9 21 2-14"}]],"credit-card-x":[["path",{"d":"M12.5 19H4a2 2 0 01-2-2V7a2 2 0 012-2h16a2 2 0 012 2v3.5"}],["path",{"d":"M2 10h20"}],["path",{"d":"M6 14h2"}],["path",{"d":"m16.5 14.5 5 5"}],["path",{"d":"m21.5 14.5-5 5"}]],"credit-card":[["rect",{"width":"20","height":"14","x":"2","y":"5","rx":"2"}],["line",{"x1":"2","x2":"22","y1":"10","y2":"10"}],["path",{"d":"M6 14h2"}]],"croissant":[["path",{"d":"M10.2 18H4.774a1.5 1.5 0 0 1-1.352-.97 11 11 0 0 1 .132-6.487"}],["path",{"d":"M18 10.2V4.774a1.5 1.5 0 0 0-.97-1.352 11 11 0 0 0-6.486.132"}],["path",{"d":"M18 5a4 3 0 0 1 4 3 2 2 0 0 1-2 2 10 10 0 0 0-5.139 1.42"}],["path",{"d":"M5 18a3 4 0 0 0 3 4 2 2 0 0 0 2-2 10 10 0 0 1 1.42-5.14"}],["path",{"d":"M8.709 2.554a10 10 0 0 0-6.155 6.155 1.5 1.5 0 0 0 .676 1.626l9.807 5.42a2 2 0 0 0 2.718-2.718l-5.42-9.807a1.5 1.5 0 0 0-1.626-.676"}]],"crop":[["path",{"d":"M6 2v14a2 2 0 0 0 2 2h14"}],["path",{"d":"M18 22V8a2 2 0 0 0-2-2H2"}]],"cross":[["path",{"d":"M4 9a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h4a1 1 0 0 1 1 1v4a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2v-4a1 1 0 0 1 1-1h4a2 2 0 0 0 2-2v-2a2 2 0 0 0-2-2h-4a1 1 0 0 1-1-1V4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4a1 1 0 0 1-1 1z"}]],"crosshair":[["circle",{"cx":"12","cy":"12","r":"10"}],["line",{"x1":"22","x2":"18","y1":"12","y2":"12"}],["line",{"x1":"6","x2":"2","y1":"12","y2":"12"}],["line",{"x1":"12","x2":"12","y1":"6","y2":"2"}],["line",{"x1":"12","x2":"12","y1":"22","y2":"18"}]],"crown":[["path",{"d":"M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z"}],["path",{"d":"M5 21h14"}]],"cuboid":[["path",{"d":"M10 22v-8"}],["path",{"d":"M2.336 8.89 10 14l11.715-7.029"}],["path",{"d":"M22 14a2 2 0 0 1-.971 1.715l-10 6a2 2 0 0 1-2.138-.05l-6-4A2 2 0 0 1 2 16v-6a2 2 0 0 1 .971-1.715l10-6a2 2 0 0 1 2.138.05l6 4A2 2 0 0 1 22 8z"}]],"cup-soda":[["path",{"d":"m6 8 1.75 12.28a2 2 0 0 0 2 1.72h4.54a2 2 0 0 0 2-1.72L18 8"}],["path",{"d":"M5 8h14"}],["path",{"d":"M7 15a6.47 6.47 0 0 1 5 0 6.47 6.47 0 0 0 5 0"}],["path",{"d":"m12 8 1-6h2"}]],"cupcake":[["path",{"d":"M12 22v-9"}],["path",{"d":"M14 4h1a3 3 0 013 3l-.004.125A4 4 0 0121 11v2"}],["path",{"d":"m15.5 22 1.5-9"}],["path",{"d":"M21 13a1 1 0 01.919 1.394l-2.74 6.394A2 2 0 0117.34 22H6.659a2 2 0 01-1.838-1.212l-2.74-6.394A1 1 0 013 13z"}],["path",{"d":"M3 13v-2a4 4 0 013.003-3.875L6 7a3 3 0 013-3h1"}],["path",{"d":"M8.5 22 7 13"}],["circle",{"cx":"12","cy":"4","r":"2"}]],"currency":[["circle",{"cx":"12","cy":"12","r":"8"}],["line",{"x1":"3","x2":"6","y1":"3","y2":"6"}],["line",{"x1":"21","x2":"18","y1":"3","y2":"6"}],["line",{"x1":"3","x2":"6","y1":"21","y2":"18"}],["line",{"x1":"21","x2":"18","y1":"21","y2":"18"}]],"cylinder":[["ellipse",{"cx":"12","cy":"5","rx":"9","ry":"3"}],["path",{"d":"M3 5v14a9 3 0 0 0 18 0V5"}]],"dam":[["path",{"d":"M11 11.31c1.17.56 1.54 1.69 3.5 1.69 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"}],["path",{"d":"M11.75 18c.35.5 1.45 1 2.75 1 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"}],["path",{"d":"M2 10h4"}],["path",{"d":"M2 14h4"}],["path",{"d":"M2 18h4"}],["path",{"d":"M2 6h4"}],["path",{"d":"M7 3a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1L10 4a1 1 0 0 0-1-1z"}]],"database-arrow-down":[["path",{"d":"m16 19 3 3 3-3"}],["path",{"d":"M19 16v6"}],["path",{"d":"M21 12.536V5"}],["path",{"d":"M3 12A9 3 0 0 0 15.182 14.806"}],["path",{"d":"M3 5V19A9 3 0 0 0 13.318 21.968"}],["ellipse",{"cx":"12","cy":"5","rx":"9","ry":"3"}]],"database-arrow-up":[["path",{"d":"M19 22v-6"}],["path",{"d":"M21 12.536V5"}],["path",{"d":"m22 19-3-3-3 3"}],["path",{"d":"M3 12A9 3 0 0 0 14.457 14.886"}],["path",{"d":"M3 5V19A9 3 0 0 0 13.318 21.968"}],["ellipse",{"cx":"12","cy":"5","rx":"9","ry":"3"}]],"database-backup":[["ellipse",{"cx":"12","cy":"5","rx":"9","ry":"3"}],["path",{"d":"M3 12a9 3 0 0 0 5 2.69"}],["path",{"d":"M21 9.3V5"}],["path",{"d":"M3 5v14a9 3 0 0 0 6.47 2.88"}],["path",{"d":"M12 12v4h4"}],["path",{"d":"M13 20a5 5 0 0 0 9-3 4.5 4.5 0 0 0-4.5-4.5c-1.33 0-2.54.54-3.41 1.41L12 16"}]],"database-check":[["path",{"d":"m16 19 2 2 4-4"}],["path",{"d":"M21 13.127V5"}],["path",{"d":"M3 12A9 3 0 0 0 21 12"}],["path",{"d":"M3 5V19A9 3 0 0 0 13.318 21.968"}],["ellipse",{"cx":"12","cy":"5","rx":"9","ry":"3"}]],"database-minus":[["path",{"d":"M21 15V5"}],["path",{"d":"M22 19h-6"}],["path",{"d":"M3 12A9 3 0 0 0 21 12"}],["path",{"d":"M3 5V19A9 3 0 0 0 13.318 21.968"}],["ellipse",{"cx":"12","cy":"5","rx":"9","ry":"3"}]],"database-plus":[["path",{"d":"M19 16v6"}],["path",{"d":"M21 12.536V5"}],["path",{"d":"M22 19h-6"}],["path",{"d":"M3 12A9 3 0 0 0 15.1824 14.8061"}],["path",{"d":"M3 5V19A9 3 0 0 0 13.318 21.968"}],["ellipse",{"cx":"12","cy":"5","rx":"9","ry":"3"}]],"database-search":[["path",{"d":"M21 11.693V5"}],["path",{"d":"m22 22-1.875-1.875"}],["path",{"d":"M3 12a9 3 0 0 0 8.697 2.998"}],["path",{"d":"M3 5v14a9 3 0 0 0 9.28 2.999"}],["circle",{"cx":"18","cy":"18","r":"3"}],["ellipse",{"cx":"12","cy":"5","rx":"9","ry":"3"}]],"database-x":[["path",{"d":"m17 17 5 5"}],["path",{"d":"M19.323 13.744A9 3 0 0 0 21 12"}],["path",{"d":"M21 13.127V5"}],["path",{"d":"m22 17-5 5"}],["path",{"d":"M3 12A9 3 0 0 0 13.563 14.954"}],["path",{"d":"M3 5V19A9 3 0 0 0 13 21.981"}],["ellipse",{"cx":"12","cy":"5","rx":"9","ry":"3"}]],"database-zap":[["ellipse",{"cx":"12","cy":"5","rx":"9","ry":"3"}],["path",{"d":"M3 5V19A9 3 0 0 0 15 21.84"}],["path",{"d":"M21 5V8"}],["path",{"d":"M21 12L18 17H22L19 22"}],["path",{"d":"M3 12A9 3 0 0 0 14.59 14.87"}]],"database":[["ellipse",{"cx":"12","cy":"5","rx":"9","ry":"3"}],["path",{"d":"M3 5V19A9 3 0 0 0 21 19V5"}],["path",{"d":"M3 12A9 3 0 0 0 21 12"}]],"decimals-arrow-left":[["path",{"d":"m13 21-3-3 3-3"}],["path",{"d":"M20 18H10"}],["path",{"d":"M3 11h.01"}],["rect",{"x":"6","y":"3","width":"5","height":"8","rx":"2.5"}]],"decimals-arrow-right":[["path",{"d":"M10 18h10"}],["path",{"d":"m17 21 3-3-3-3"}],["path",{"d":"M3 11h.01"}],["rect",{"x":"15","y":"3","width":"5","height":"8","rx":"2.5"}],["rect",{"x":"6","y":"3","width":"5","height":"8","rx":"2.5"}]],"delete":[["path",{"d":"M10 5a2 2 0 0 0-1.344.519l-6.328 5.74a1 1 0 0 0 0 1.481l6.328 5.741A2 2 0 0 0 10 19h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z"}],["path",{"d":"m12 9 6 6"}],["path",{"d":"m18 9-6 6"}]],"dessert":[["path",{"d":"M10.162 3.167A10 10 0 0 0 2 13a2 2 0 0 0 4 0v-1a2 2 0 0 1 4 0v4a2 2 0 0 0 4 0v-4a2 2 0 0 1 4 0v1a2 2 0 0 0 4-.006 10 10 0 0 0-8.161-9.826"}],["path",{"d":"M20.804 14.869a9 9 0 0 1-17.608 0"}],["circle",{"cx":"12","cy":"4","r":"2"}]],"diameter":[["circle",{"cx":"19","cy":"19","r":"2"}],["circle",{"cx":"5","cy":"5","r":"2"}],["path",{"d":"M6.48 3.66a10 10 0 0 1 13.86 13.86"}],["path",{"d":"m6.41 6.41 11.18 11.18"}],["path",{"d":"M3.66 6.48a10 10 0 0 0 13.86 13.86"}]],"diamond-minus":[["path",{"d":"M2.7 10.3a2.41 2.41 0 0 0 0 3.41l7.59 7.59a2.41 2.41 0 0 0 3.41 0l7.59-7.59a2.41 2.41 0 0 0 0-3.41L13.7 2.71a2.41 2.41 0 0 0-3.41 0z"}],["path",{"d":"M8 12h8"}]],"diamond-percent":[["path",{"d":"M2.7 10.3a2.41 2.41 0 0 0 0 3.41l7.59 7.59a2.41 2.41 0 0 0 3.41 0l7.59-7.59a2.41 2.41 0 0 0 0-3.41L13.7 2.71a2.41 2.41 0 0 0-3.41 0Z"}],["path",{"d":"M9.2 9.2h.01"}],["path",{"d":"m14.5 9.5-5 5"}],["path",{"d":"M14.7 14.8h.01"}]],"diamond-plus":[["path",{"d":"M12 8v8"}],["path",{"d":"M2.7 10.3a2.41 2.41 0 0 0 0 3.41l7.59 7.59a2.41 2.41 0 0 0 3.41 0l7.59-7.59a2.41 2.41 0 0 0 0-3.41L13.7 2.71a2.41 2.41 0 0 0-3.41 0z"}],["path",{"d":"M8 12h8"}]],"diamond":[["path",{"d":"M2.7 10.3a2.41 2.41 0 0 0 0 3.41l7.59 7.59a2.41 2.41 0 0 0 3.41 0l7.59-7.59a2.41 2.41 0 0 0 0-3.41l-7.59-7.59a2.41 2.41 0 0 0-3.41 0Z"}]],"dice-1":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2","ry":"2"}],["path",{"d":"M12 12h.01"}]],"dice-2":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2","ry":"2"}],["path",{"d":"M15 9h.01"}],["path",{"d":"M9 15h.01"}]],"dice-3":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2","ry":"2"}],["path",{"d":"M16 8h.01"}],["path",{"d":"M12 12h.01"}],["path",{"d":"M8 16h.01"}]],"dice-4":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2","ry":"2"}],["path",{"d":"M16 8h.01"}],["path",{"d":"M8 8h.01"}],["path",{"d":"M8 16h.01"}],["path",{"d":"M16 16h.01"}]],"dice-5":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2","ry":"2"}],["path",{"d":"M16 8h.01"}],["path",{"d":"M8 8h.01"}],["path",{"d":"M8 16h.01"}],["path",{"d":"M16 16h.01"}],["path",{"d":"M12 12h.01"}]],"dice-6":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2","ry":"2"}],["path",{"d":"M16 8h.01"}],["path",{"d":"M16 12h.01"}],["path",{"d":"M16 16h.01"}],["path",{"d":"M8 8h.01"}],["path",{"d":"M8 12h.01"}],["path",{"d":"M8 16h.01"}]],"dices":[["rect",{"width":"12","height":"12","x":"2","y":"10","rx":"2","ry":"2"}],["path",{"d":"m17.92 14 3.5-3.5a2.24 2.24 0 0 0 0-3l-5-4.92a2.24 2.24 0 0 0-3 0L10 6"}],["path",{"d":"M6 18h.01"}],["path",{"d":"M10 14h.01"}],["path",{"d":"M15 6h.01"}],["path",{"d":"M18 9h.01"}]],"diff":[["path",{"d":"M12 3v14"}],["path",{"d":"M5 10h14"}],["path",{"d":"M5 21h14"}]],"disc-2":[["circle",{"cx":"12","cy":"12","r":"10"}],["circle",{"cx":"12","cy":"12","r":"4"}],["path",{"d":"M12 12h.01"}]],"disc-3":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M6 12c0-1.7.7-3.2 1.8-4.2"}],["circle",{"cx":"12","cy":"12","r":"2"}],["path",{"d":"M18 12c0 1.7-.7 3.2-1.8 4.2"}]],"disc-album":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["circle",{"cx":"12","cy":"12","r":"5"}],["path",{"d":"M12 12h.01"}]],"disc":[["circle",{"cx":"12","cy":"12","r":"10"}],["circle",{"cx":"12","cy":"12","r":"2"}]],"divide":[["circle",{"cx":"12","cy":"6","r":"1"}],["line",{"x1":"5","x2":"19","y1":"12","y2":"12"}],["circle",{"cx":"12","cy":"18","r":"1"}]],"dna-off":[["path",{"d":"M15 2c-1.35 1.5-2.092 3-2.5 4.5L14 8"}],["path",{"d":"m17 6-2.891-2.891"}],["path",{"d":"M2 15c3.333-3 6.667-3 10-3"}],["path",{"d":"m2 2 20 20"}],["path",{"d":"m20 9 .891.891"}],["path",{"d":"M22 9c-1.5 1.35-3 2.092-4.5 2.5l-1-1"}],["path",{"d":"M3.109 14.109 4 15"}],["path",{"d":"m6.5 12.5 1 1"}],["path",{"d":"m7 18 2.891 2.891"}],["path",{"d":"M9 22c1.35-1.5 2.092-3 2.5-4.5L10 16"}]],"dna":[["path",{"d":"m10 16 1.5 1.5"}],["path",{"d":"m14 8-1.5-1.5"}],["path",{"d":"M15 2c-1.798 1.998-2.518 3.995-2.807 5.993"}],["path",{"d":"m16.5 10.5 1 1"}],["path",{"d":"m17 6-2.891-2.891"}],["path",{"d":"M2 15c6.667-6 13.333 0 20-6"}],["path",{"d":"m20 9 .891.891"}],["path",{"d":"M3.109 14.109 4 15"}],["path",{"d":"m6.5 12.5 1 1"}],["path",{"d":"m7 18 2.891 2.891"}],["path",{"d":"M9 22c1.798-1.998 2.518-3.995 2.807-5.993"}]],"dock":[["path",{"d":"M2 8h20"}],["rect",{"width":"20","height":"16","x":"2","y":"4","rx":"2"}],["path",{"d":"M6 16h12"}]],"dog":[["path",{"d":"M11.25 16.25h1.5L12 17z"}],["path",{"d":"M16 14v.5"}],["path",{"d":"M4.42 11.247A13.152 13.152 0 0 0 4 14.556C4 18.728 7.582 21 12 21s8-2.272 8-6.444a11.702 11.702 0 0 0-.493-3.309"}],["path",{"d":"M8 14v.5"}],["path",{"d":"M8.5 8.5c-.384 1.05-1.083 2.028-2.344 2.5-1.931.722-3.576-.297-3.656-1-.113-.994 1.177-6.53 4-7 1.923-.321 3.651.845 3.651 2.235A7.497 7.497 0 0 1 14 5.277c0-1.39 1.844-2.598 3.767-2.277 2.823.47 4.113 6.006 4 7-.08.703-1.725 1.722-3.656 1-1.261-.472-1.855-1.45-2.239-2.5"}]],"dollar-sign":[["line",{"x1":"12","x2":"12","y1":"2","y2":"22"}],["path",{"d":"M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"}]],"dome":[["path",{"d":"M10 21v-3a2 2 0 014 0v3"}],["path",{"d":"M12 2v2"}],["path",{"d":"M18 12v9"}],["path",{"d":"M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2v-6a1 1 0 011-1h18a1 1 0 011 1z"}],["path",{"d":"M4 12a8 8 0 0116 0"}],["path",{"d":"M6 12v9"}]],"donut":[["path",{"d":"M20.5 10a2.5 2.5 0 0 1-2.4-3H18a2.95 2.95 0 0 1-2.6-4.4 10 10 0 1 0 6.3 7.1c-.3.2-.8.3-1.2.3"}],["circle",{"cx":"12","cy":"12","r":"3"}]],"door-closed-locked":[["path",{"d":"M19 8V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16"}],["path",{"d":"M2 21h8"}],["path",{"d":"M20 16v-2a2 2 0 00-4 0v2"}],["path",{"d":"M9 12h.01"}],["rect",{"x":"14","y":"16","width":"8","height":"5","rx":"1"}]],"door-closed-package":[["path",{"d":"M18 13v3"}],["path",{"d":"M19 9V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16"}],["path",{"d":"M2 21h8"}],["path",{"d":"M9 12h.01"}],["rect",{"x":"14","y":"13","width":"8","height":"8","rx":"1"}]],"door-closed":[["path",{"d":"M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16"}],["path",{"d":"M2 21h20"}],["path",{"d":"M9 12h.01"}]],"door-open":[["path",{"d":"M10 21H2"}],["path",{"d":"M10 3H7a2 2 0 00-2 2v16"}],["path",{"d":"M14 12h.01"}],["path",{"d":"M19 21V5a2 2 0 00-1.675-1.974l-6.163-1.013A1 1 0 0010 3v18a1 1 0 001.124.992z"}],["path",{"d":"M22 21h-3"}]],"door-stairwell":[["path",{"d":"M12 17v-3a1 1 0 011-1h6"}],["path",{"d":"M19 17h-9a1 1 0 00-1 1v3"}],["path",{"d":"M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16"}],["path",{"d":"M19 9h-3a1 1 0 00-1 1v3"}],["path",{"d":"M22 21H2"}]],"dot":[["circle",{"cx":"12","cy":"12","r":"1"}]],"download":[["path",{"d":"M12 15V3"}],["path",{"d":"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"}],["path",{"d":"m7 10 5 5 5-5"}]],"drafting-compass":[["path",{"d":"m12.99 6.74 1.93 3.44"}],["path",{"d":"M19.136 12a10 10 0 0 1-14.271 0"}],["path",{"d":"m21 21-2.16-3.84"}],["path",{"d":"m3 21 8.02-14.26"}],["circle",{"cx":"12","cy":"5","r":"2"}]],"drama":[["path",{"d":"M10 11h.01"}],["path",{"d":"M14 6h.01"}],["path",{"d":"M18 6h.01"}],["path",{"d":"M6.5 13.1h.01"}],["path",{"d":"M22 5c0 9-4 12-6 12s-6-3-6-12c0-2 2-3 6-3s6 1 6 3"}],["path",{"d":"M17.4 9.9c-.8.8-2 .8-2.8 0"}],["path",{"d":"M10.1 7.1C9 7.2 7.7 7.7 6 8.6c-3.5 2-4.7 3.9-3.7 5.6 4.5 7.8 9.5 8.4 11.2 7.4.9-.5 1.9-2.1 1.9-4.7"}],["path",{"d":"M9.1 16.5c.3-1.1 1.4-1.7 2.4-1.4"}]],"drill":[["path",{"d":"M10 18a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H5a3 3 0 0 1-3-3 1 1 0 0 1 1-1z"}],["path",{"d":"M13 10H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1l-.81 3.242a1 1 0 0 1-.97.758H8"}],["path",{"d":"M14 4h3a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1h-3"}],["path",{"d":"M18 6h4"}],["path",{"d":"m5 10-2 8"}],["path",{"d":"m7 18 2-8"}]],"drone":[["path",{"d":"M10 10 7 7"}],["path",{"d":"m10 14-3 3"}],["path",{"d":"m14 10 3-3"}],["path",{"d":"m14 14 3 3"}],["path",{"d":"M14.205 4.139a4 4 0 1 1 5.439 5.863"}],["path",{"d":"M19.637 14a4 4 0 1 1-5.432 5.868"}],["path",{"d":"M4.367 10a4 4 0 1 1 5.438-5.862"}],["path",{"d":"M9.795 19.862a4 4 0 1 1-5.429-5.873"}],["rect",{"x":"10","y":"8","width":"4","height":"8","rx":"1"}]],"droplet-off":[["path",{"d":"M18.715 13.186C18.29 11.858 17.384 10.607 16 9.5c-2-1.6-3.5-4-4-6.5a10.7 10.7 0 0 1-.884 2.586"}],["path",{"d":"m2 2 20 20"}],["path",{"d":"M8.795 8.797A11 11 0 0 1 8 9.5C6 11.1 5 13 5 15a7 7 0 0 0 13.222 3.208"}]],"droplet":[["path",{"d":"M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"}]],"droplets":[["path",{"d":"M7 16.3c2.2 0 4-1.83 4-4.05 0-1.16-.57-2.26-1.71-3.19S7.29 6.75 7 5.3c-.29 1.45-1.14 2.84-2.29 3.76S3 11.1 3 12.25c0 2.22 1.8 4.05 4 4.05z"}],["path",{"d":"M12.56 6.6A10.97 10.97 0 0 0 14 3.02c.5 2.5 2 4.9 4 6.5s3 3.5 3 5.5a6.98 6.98 0 0 1-11.91 4.97"}]],"drum":[["path",{"d":"m2 2 8 8"}],["path",{"d":"m22 2-8 8"}],["ellipse",{"cx":"12","cy":"9","rx":"10","ry":"5"}],["path",{"d":"M7 13.4v7.9"}],["path",{"d":"M12 14v8"}],["path",{"d":"M17 13.4v7.9"}],["path",{"d":"M2 9v8a10 5 0 0 0 20 0V9"}]],"drumstick":[["path",{"d":"M15.4 15.63a7.875 6 135 1 1 6.23-6.23 4.5 3.43 135 0 0-6.23 6.23"}],["path",{"d":"m8.29 12.71-2.6 2.6a2.5 2.5 0 1 0-1.65 4.65A2.5 2.5 0 1 0 8.7 18.3l2.59-2.59"}]],"dumbbell":[["path",{"d":"M17.596 12.768a2 2 0 1 0 2.829-2.829l-1.768-1.767a2 2 0 0 0 2.828-2.829l-2.828-2.828a2 2 0 0 0-2.829 2.828l-1.767-1.768a2 2 0 1 0-2.829 2.829z"}],["path",{"d":"m2.5 21.5 1.4-1.4"}],["path",{"d":"m20.1 3.9 1.4-1.4"}],["path",{"d":"M5.343 21.485a2 2 0 1 0 2.829-2.828l1.767 1.768a2 2 0 1 0 2.829-2.829l-6.364-6.364a2 2 0 1 0-2.829 2.829l1.768 1.767a2 2 0 0 0-2.828 2.829z"}],["path",{"d":"m9.6 14.4 4.8-4.8"}]],"ear-off":[["path",{"d":"M6 18.5a3.5 3.5 0 1 0 7 0c0-1.57.92-2.52 2.04-3.46"}],["path",{"d":"M6 8.5c0-.75.13-1.47.36-2.14"}],["path",{"d":"M8.8 3.15A6.5 6.5 0 0 1 19 8.5c0 1.63-.44 2.81-1.09 3.76"}],["path",{"d":"M12.5 6A2.5 2.5 0 0 1 15 8.5M10 13a2 2 0 0 0 1.82-1.18"}],["line",{"x1":"2","x2":"22","y1":"2","y2":"22"}]],"ear":[["path",{"d":"M6 8.5a6.5 6.5 0 1 1 13 0c0 6-6 6-6 10a3.5 3.5 0 1 1-7 0"}],["path",{"d":"M15 8.5a2.5 2.5 0 0 0-5 0v1a2 2 0 1 1 0 4"}]],"earth-lock":[["path",{"d":"M7 3.34V5a3 3 0 0 0 3 3"}],["path",{"d":"M11 21.95V18a2 2 0 0 0-2-2 2 2 0 0 1-2-2v-1a2 2 0 0 0-2-2H2.05"}],["path",{"d":"M21.54 15H17a2 2 0 0 0-2 2v4.54"}],["path",{"d":"M12 2a10 10 0 1 0 9.54 13"}],["path",{"d":"M20 6V4a2 2 0 1 0-4 0v2"}],["rect",{"width":"8","height":"5","x":"14","y":"6","rx":"1"}]],"earth":[["path",{"d":"M21.54 15H17a2 2 0 0 0-2 2v4.54"}],["path",{"d":"M7 3.34V5a3 3 0 0 0 3 3a2 2 0 0 1 2 2c0 1.1.9 2 2 2a2 2 0 0 0 2-2c0-1.1.9-2 2-2h3.17"}],["path",{"d":"M11 21.95V18a2 2 0 0 0-2-2a2 2 0 0 1-2-2v-1a2 2 0 0 0-2-2H2.05"}],["circle",{"cx":"12","cy":"12","r":"10"}]],"eclipse":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M12 2a7 7 0 1 0 10 10"}]],"egg-fried":[["circle",{"cx":"11.5","cy":"12.5","r":"3.5"}],["path",{"d":"M3 8c0-3.5 2.5-6 6.5-6 5 0 4.83 3 7.5 5s5 2 5 6c0 4.5-2.5 6.5-7 6.5-2.5 0-2.5 2.5-6 2.5s-7-2-7-5.5c0-3 1.5-3 1.5-5C3.5 10 3 9 3 8Z"}]],"egg-off":[["path",{"d":"m2 2 20 20"}],["path",{"d":"M20 14.347V14c0-6-4-12-8-12-1.078 0-2.157.436-3.157 1.19"}],["path",{"d":"M6.206 6.21C4.871 8.4 4 11.2 4 14a8 8 0 0 0 14.568 4.568"}]],"egg":[["path",{"d":"M12 2C8 2 4 8 4 14a8 8 0 0 0 16 0c0-6-4-12-8-12"}]],"eject":[["path",{"d":"M4 13a1 1 0 0 1-.72-1.695l7.257-7.668a2 2 0 0 1 2.926 0l7.256 7.668A1 1 0 0 1 20 13z"}],["rect",{"x":"3","y":"17","width":"18","height":"4","rx":"1"}]],"ellipse":[["ellipse",{"cx":"12","cy":"12","rx":"10","ry":"6"}]],"ellipsis-vertical":[["circle",{"cx":"12","cy":"12","r":"1"}],["circle",{"cx":"12","cy":"5","r":"1"}],["circle",{"cx":"12","cy":"19","r":"1"}]],"ellipsis":[["circle",{"cx":"12","cy":"12","r":"1"}],["circle",{"cx":"19","cy":"12","r":"1"}],["circle",{"cx":"5","cy":"12","r":"1"}]],"engine":[["path",{"d":"M10 3h6"}],["path",{"d":"M13 3v4"}],["path",{"d":"M2 10v6"}],["path",{"d":"M2 13h4"}],["path",{"d":"M6 16a2 2 0 002 2h1a2 2 0 011.6.8l.3.4a2 2 0 001.6.8h2.264a2 2 0 001.789-1.106l1.67-3.341a1 1 0 01.895-.553H21a1 1 0 001-1v-4a1 1 0 00-1-1h-3.5a1 1 0 01-.8-.4l-.9-1.2A1 1 0 0015 7h-4a1 1 0 00-.8.4l-.9 1.2a1 1 0 01-.8.4H7a1 1 0 00-1 1z"}]],"equal-approximately-not":[["path",{"d":"M5 15a6.5 6.5 0 0 1 7 0 6.5 6.5 0 0 0 7 0"}],["path",{"d":"M5 9a6.5 6.5 0 0 1 7 0 6.5 6.5 0 0 0 7 0"}],["line",{"x1":"19","x2":"5","y1":"5","y2":"19"}]],"equal-approximately":[["path",{"d":"M5 15a6.5 6.5 0 0 1 7 0 6.5 6.5 0 0 0 7 0"}],["path",{"d":"M5 9a6.5 6.5 0 0 1 7 0 6.5 6.5 0 0 0 7 0"}]],"equal-not":[["line",{"x1":"5","x2":"19","y1":"9","y2":"9"}],["line",{"x1":"5","x2":"19","y1":"15","y2":"15"}],["line",{"x1":"19","x2":"5","y1":"5","y2":"19"}]],"equal":[["line",{"x1":"5","x2":"19","y1":"9","y2":"9"}],["line",{"x1":"5","x2":"19","y1":"15","y2":"15"}]],"eraser":[["path",{"d":"M21 21H8a2 2 0 0 1-1.42-.587l-3.994-3.999a2 2 0 0 1 0-2.828l10-10a2 2 0 0 1 2.829 0l5.999 6a2 2 0 0 1 0 2.828L12.834 21"}],["path",{"d":"m5.082 11.09 8.828 8.828"}]],"ethernet-port":[["path",{"d":"M10 8v1"}],["path",{"d":"M14 8v1"}],["path",{"d":"M18 8v1"}],["path",{"d":"M19 17a2 2 0 00-1.765 1.059l-.47.882A2 2 0 0115 20H9a2 2 0 01-1.765-1.059l-.47-.882A2 2 0 005 17H4a2 2 0 01-2-2V6a2 2 0 012-2h16a2 2 0 012 2v9a2 2 0 01-2 2z"}],["path",{"d":"M6 8v1"}]],"euro":[["path",{"d":"M4 10h12"}],["path",{"d":"M4 14h9"}],["path",{"d":"M19 6a7.7 7.7 0 0 0-5.2-2A7.9 7.9 0 0 0 6 12c0 4.4 3.5 8 7.8 8 2 0 3.8-.8 5.2-2"}]],"ev-charger":[["path",{"d":"M14 13h2a2 2 0 0 1 2 2v2a2 2 0 0 0 4 0v-6.998a2 2 0 0 0-.59-1.42L18 5"}],["path",{"d":"M14 21V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v16"}],["path",{"d":"M2 21h13"}],["path",{"d":"M3 7h11"}],["path",{"d":"m9 11-2 3h3l-2 3"}]],"expand":[["path",{"d":"m15 15 6 6"}],["path",{"d":"m15 9 6-6"}],["path",{"d":"M21 16v5h-5"}],["path",{"d":"M21 8V3h-5"}],["path",{"d":"M3 16v5h5"}],["path",{"d":"m3 21 6-6"}],["path",{"d":"M3 8V3h5"}],["path",{"d":"M9 9 3 3"}]],"external-link":[["path",{"d":"M15 3h6v6"}],["path",{"d":"M10 14 21 3"}],["path",{"d":"M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"}]],"eye-closed":[["path",{"d":"m15 18-.722-3.25"}],["path",{"d":"M2 8a10.645 10.645 0 0 0 20 0"}],["path",{"d":"m20 15-1.726-2.05"}],["path",{"d":"m4 15 1.726-2.05"}],["path",{"d":"m9 18 .722-3.25"}]],"eye-dashed":[["path",{"d":"M13.054 18.946a11 11 0 0 1-2.11 0"}],["path",{"d":"M13.054 5.054a11 11 0 0 0-2.11-.001"}],["path",{"d":"M17.072 6.274a11 11 0 0 1 1.753 1.173"}],["path",{"d":"M18.825 16.552a11 11 0 0 1-1.753 1.174"}],["path",{"d":"M2.514 13.303a11 11 0 0 1-.452-.954 1 1 0 0 1 0-.697 11 11 0 0 1 .45-.955"}],["path",{"d":"M21.485 10.697a11 11 0 0 1 .453.955 1 1 0 0 1 0 .697 11 11 0 0 1-.453.954"}],["path",{"d":"M5.173 7.448a11 11 0 0 1 1.753-1.174"}],["path",{"d":"M6.926 17.726a11 11 0 0 1-1.753-1.174"}],["circle",{"cx":"12","cy":"12","r":"3"}]],"eye-off":[["path",{"d":"M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"}],["path",{"d":"M14.084 14.158a3 3 0 0 1-4.242-4.242"}],["path",{"d":"M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"}],["path",{"d":"m2 2 20 20"}]],"eye":[["path",{"d":"M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"}],["circle",{"cx":"12","cy":"12","r":"3"}]],"face-angry":[["path",{"d":"M15 12v-1.584"}],["path",{"d":"M17 10a5 5 0 00-3 1"}],["path",{"d":"M7 10a5 5 0 013 1"}],["path",{"d":"M9 12v-1.584"}],["path",{"d":"M9 17a5 5 0 016.001 0"}],["circle",{"cx":"12","cy":"12","r":"10"}]],"face-expressionless":[["path",{"d":"M14 10h2"}],["path",{"d":"M8 10h2"}],["path",{"d":"M8 16h8"}],["circle",{"cx":"12","cy":"12","r":"10"}]],"face-grinning":[["path",{"d":"M15 10V9"}],["path",{"d":"M7.084 14.302a5.12 5.12 0 009.833 0 .24.24 0 00-.235-.302H7.32a.24.24 0 00-.235.302"}],["path",{"d":"M9 10V9"}],["circle",{"cx":"12","cy":"12","r":"10"}]],"face-neutral":[["path",{"d":"M15 10V9"}],["path",{"d":"M8 16h8"}],["path",{"d":"M9 10V9"}],["circle",{"cx":"12","cy":"12","r":"10"}]],"face-slightly-frowning":[["path",{"d":"M15 10V9"}],["path",{"d":"M9 10V9"}],["path",{"d":"M9 16a5 5 0 016 0"}],["circle",{"cx":"12","cy":"12","r":"10"}]],"face-slightly-smiling-plus":[["path",{"d":"M13.267 2.08a10 10 0 108.653 8.653"}],["path",{"d":"M15 10V9"}],["path",{"d":"M16 5h6"}],["path",{"d":"M16.472 15a6 6 0 01-8.943 0"}],["path",{"d":"M19 2v6"}],["path",{"d":"M9 10V9"}]],"face-slightly-smiling":[["path",{"d":"M15 10V9"}],["path",{"d":"M16.472 15a6 6 0 01-8.943 0"}],["path",{"d":"M9 10V9"}],["circle",{"cx":"12","cy":"12","r":"10"}]],"factory":[["path",{"d":"M12 16h.01"}],["path",{"d":"M16 16h.01"}],["path",{"d":"M3 19a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5a.5.5 0 0 0-.769-.422l-4.462 2.844A.5.5 0 0 1 15 10.5v-2a.5.5 0 0 0-.769-.422L9.77 10.922A.5.5 0 0 1 9 10.5V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2z"}],["path",{"d":"M8 16h.01"}]],"fan":[["path",{"d":"M10.827 16.379a6.082 6.082 0 0 1-8.618-7.002l5.412 1.45a6.082 6.082 0 0 1 7.002-8.618l-1.45 5.412a6.082 6.082 0 0 1 8.618 7.002l-5.412-1.45a6.082 6.082 0 0 1-7.002 8.618l1.45-5.412Z"}],["path",{"d":"M12 12v.01"}]],"fast-forward":[["path",{"d":"M12 6a2 2 0 0 1 3.414-1.414l6 6a2 2 0 0 1 0 2.828l-6 6A2 2 0 0 1 12 18z"}],["path",{"d":"M2 6a2 2 0 0 1 3.414-1.414l6 6a2 2 0 0 1 0 2.828l-6 6A2 2 0 0 1 2 18z"}]],"faucet":[["path",{"d":"M10.083 5.428 5.57 4.083a2 2 0 10.001 3.834l4.512-1.345"}],["path",{"d":"M12 8v3"}],["path",{"d":"m13.917 5.428 4.511-1.345a2 2 0 110 3.834l-4.51-1.345"}],["path",{"d":"M18 17v-4.006"}],["path",{"d":"M22 11v8"}],["path",{"d":"M22 12h-3a1 1 0 00-1 .994h-2.539a4 4 0 00-6.915-.012L7 13a5 5 0 00-5 5v1a1 1 0 001 1h2a1 1 0 001-1v-1a1 1 0 01.995-1l1.552.018a4 4 0 006.907 0L18 17a1 1 0 001 1h3"}],["circle",{"cx":"12","cy":"6","r":"2"}]],"feather":[["path",{"d":"M14.086 18.412A2 2 0 0112.67 19H5v-7.672a2 2 0 01.586-1.414L11.75 3.75a6 6 0 118.49 8.49z"}],["path",{"d":"M16 8 2 22"}],["path",{"d":"M17.488 15H9"}]],"fence":[["path",{"d":"M4 3 2 5v15c0 .6.4 1 1 1h2c.6 0 1-.4 1-1V5Z"}],["path",{"d":"M6 8h4"}],["path",{"d":"M6 18h4"}],["path",{"d":"m12 3-2 2v15c0 .6.4 1 1 1h2c.6 0 1-.4 1-1V5Z"}],["path",{"d":"M14 8h4"}],["path",{"d":"M14 18h4"}],["path",{"d":"m20 3-2 2v15c0 .6.4 1 1 1h2c.6 0 1-.4 1-1V5Z"}]],"ferris-wheel":[["circle",{"cx":"12","cy":"12","r":"2"}],["path",{"d":"M12 2v4"}],["path",{"d":"m6.8 15-3.5 2"}],["path",{"d":"m20.7 7-3.5 2"}],["path",{"d":"M6.8 9 3.3 7"}],["path",{"d":"m20.7 17-3.5-2"}],["path",{"d":"m9 22 3-8 3 8"}],["path",{"d":"M8 22h8"}],["path",{"d":"M18 18.7a9 9 0 1 0-12 0"}]],"file-archive":[["path",{"d":"M13.659 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v11.5"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"M8 12v-1"}],["path",{"d":"M8 18v-2"}],["path",{"d":"M8 7V6"}],["circle",{"cx":"8","cy":"20","r":"2"}]],"file-axis-3d":[["path",{"d":"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"m8 18 4-4"}],["path",{"d":"M8 10v8h8"}]],"file-badge":[["path",{"d":"M13 22h5a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v3.3"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"m7.69 16.479 1.29 4.88a.5.5 0 0 1-.698.591l-1.843-.849a1 1 0 0 0-.879.001l-1.846.85a.5.5 0 0 1-.692-.593l1.29-4.88"}],["circle",{"cx":"6","cy":"14","r":"3"}]],"file-box":[["path",{"d":"M14 2v5a1 1 0 001 1h5"}],["path",{"d":"M14.692 22H18a2 2 0 002-2V8a2.4 2.4 0 00-.706-1.706l-3.588-3.588A2.4 2.4 0 0014 2H6a2 2 0 00-2 2v3.804"}],["path",{"d":"M2.264 13.752 7 16.5l4.737-2.748"}],["path",{"d":"M2.995 13.014A2 2 0 002 14.744v3.516a2 2 0 00.996 1.73l3 1.74a2 2 0 002.008 0l3-1.74A2 2 0 0012 18.26v-3.517a2 2 0 00-.995-1.73l-3-1.742a2 2 0 00-1.892-.064z"}],["path",{"d":"M7 16.5V22"}]],"file-braces-corner":[["path",{"d":"M14 22h4a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v6"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"M5 14a1 1 0 0 0-1 1v2a1 1 0 0 1-1 1 1 1 0 0 1 1 1v2a1 1 0 0 0 1 1"}],["path",{"d":"M9 22a1 1 0 0 0 1-1v-2a1 1 0 0 1 1-1 1 1 0 0 1-1-1v-2a1 1 0 0 0-1-1"}]],"file-braces":[["path",{"d":"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"M10 12a1 1 0 0 0-1 1v1a1 1 0 0 1-1 1 1 1 0 0 1 1 1v1a1 1 0 0 0 1 1"}],["path",{"d":"M14 18a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1 1 1 0 0 1-1-1v-1a1 1 0 0 0-1-1"}]],"file-chart-column-increasing":[["path",{"d":"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"M8 18v-2"}],["path",{"d":"M12 18v-4"}],["path",{"d":"M16 18v-6"}]],"file-chart-column":[["path",{"d":"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"M8 18v-1"}],["path",{"d":"M12 18v-6"}],["path",{"d":"M16 18v-3"}]],"file-chart-line":[["path",{"d":"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"m16 13-3.5 3.5-2-2L8 17"}]],"file-chart-pie":[["path",{"d":"M15.941 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.704l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v3.512"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"M4.017 11.512a6 6 0 1 0 8.466 8.475"}],["path",{"d":"M9 16a1 1 0 0 1-1-1v-4c0-.552.45-1.008.995-.917a6 6 0 0 1 4.922 4.922c.091.544-.365.995-.917.995z"}]],"file-check-corner":[["path",{"d":"M10.5 22H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v6"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"m14 20 2 2 4-4"}]],"file-check":[["path",{"d":"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"m9 15 2 2 4-4"}]],"file-clock":[["path",{"d":"M16 22h2a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v2.85"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"M8 14v2.2l1.6 1"}],["circle",{"cx":"8","cy":"16","r":"6"}]],"file-code-corner":[["path",{"d":"M4 12.15V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2h-3.35"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"m5 16-3 3 3 3"}],["path",{"d":"m9 22 3-3-3-3"}]],"file-code":[["path",{"d":"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"M10 12.5 8 15l2 2.5"}],["path",{"d":"m14 12.5 2 2.5-2 2.5"}]],"file-cog":[["path",{"d":"M15 8a1 1 0 0 1-1-1V2a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8z"}],["path",{"d":"M20 8v12a2 2 0 0 1-2 2h-4.182"}],["path",{"d":"m3.305 19.53.923-.382"}],["path",{"d":"M4 10.592V4a2 2 0 0 1 2-2h8"}],["path",{"d":"m4.228 16.852-.924-.383"}],["path",{"d":"m5.852 15.228-.383-.923"}],["path",{"d":"m5.852 20.772-.383.924"}],["path",{"d":"m8.148 15.228.383-.923"}],["path",{"d":"m8.53 21.696-.382-.924"}],["path",{"d":"m9.773 16.852.922-.383"}],["path",{"d":"m9.773 19.148.922.383"}],["circle",{"cx":"7","cy":"18","r":"3"}]],"file-diff":[["path",{"d":"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"}],["path",{"d":"M9 10h6"}],["path",{"d":"M12 13V7"}],["path",{"d":"M9 17h6"}]],"file-digit":[["path",{"d":"M4 12V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"M10 16h2v6"}],["path",{"d":"M10 22h4"}],["rect",{"x":"2","y":"16","width":"4","height":"6","rx":"2"}]],"file-down":[["path",{"d":"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"M12 18v-6"}],["path",{"d":"m9 15 3 3 3-3"}]],"file-exclamation-point":[["path",{"d":"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"}],["path",{"d":"M12 9v4"}],["path",{"d":"M12 17h.01"}]],"file-headphone":[["path",{"d":"M4 6.835V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2h-.343"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"M2 19a2 2 0 0 1 4 0v1a2 2 0 0 1-4 0v-4a6 6 0 0 1 12 0v4a2 2 0 0 1-4 0v-1a2 2 0 0 1 4 0"}]],"file-heart":[["path",{"d":"M13 22h5a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v7"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"M3.62 18.8A2.25 2.25 0 1 1 7 15.836a2.25 2.25 0 1 1 3.38 2.966l-2.626 2.856a1 1 0 0 1-1.507 0z"}]],"file-image":[["path",{"d":"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["circle",{"cx":"10","cy":"12","r":"2"}],["path",{"d":"m20 17-1.296-1.296a2.41 2.41 0 0 0-3.408 0L9 22"}]],"file-input":[["path",{"d":"M4 11V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-1"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"M2 15h10"}],["path",{"d":"m9 18 3-3-3-3"}]],"file-key":[["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"M4 12v6"}],["path",{"d":"M4 14h2"}],["path",{"d":"M9.65 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v4"}],["circle",{"cx":"4","cy":"20","r":"2"}]],"file-lock":[["path",{"d":"M4 9.8V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2h-3"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"M9 17v-2a2 2 0 0 0-4 0v2"}],["rect",{"width":"8","height":"5","x":"3","y":"17","rx":"1"}]],"file-minus-corner":[["path",{"d":"M20 14V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"M14 18h6"}]],"file-minus":[["path",{"d":"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"M9 15h6"}]],"file-music":[["path",{"d":"M11.65 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v10.35"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"M8 20v-7l3 1.474"}],["circle",{"cx":"6","cy":"20","r":"2"}]],"file-output":[["path",{"d":"M4.226 20.925A2 2 0 0 0 6 22h12a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v3.127"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"m5 11-3 3"}],["path",{"d":"m5 17-3-3h10"}]],"file-pen-line":[["path",{"d":"M14.364 13.634a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506l4.013-4.009a1 1 0 0 0-3.004-3.004z"}],["path",{"d":"M14.487 7.858A1 1 0 0 1 14 7V2"}],["path",{"d":"M20 19.645V20a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l2.516 2.516"}],["path",{"d":"M8 18h1"}]],"file-pen":[["path",{"d":"M12.659 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v9.34"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"M10.378 12.622a1 1 0 0 1 3 3.003L8.36 20.637a2 2 0 0 1-.854.506l-2.867.837a.5.5 0 0 1-.62-.62l.836-2.869a2 2 0 0 1 .506-.853z"}]],"file-play":[["path",{"d":"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"M15.033 13.44a.647.647 0 0 1 0 1.12l-4.065 2.352a.645.645 0 0 1-.968-.56v-4.704a.645.645 0 0 1 .967-.56z"}]],"file-plus-corner":[["path",{"d":"M11.35 22H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v5.35"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"M14 19h6"}],["path",{"d":"M17 16v6"}]],"file-plus":[["path",{"d":"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"M9 15h6"}],["path",{"d":"M12 18v-6"}]],"file-question-mark":[["path",{"d":"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"}],["path",{"d":"M12 17h.01"}],["path",{"d":"M9.1 9a3 3 0 0 1 5.82 1c0 2-3 3-3 3"}]],"file-scan":[["path",{"d":"M20 10V8a2.4 2.4 0 0 0-.706-1.704l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h4.35"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"M16 14a2 2 0 0 0-2 2"}],["path",{"d":"M16 22a2 2 0 0 1-2-2"}],["path",{"d":"M20 14a2 2 0 0 1 2 2"}],["path",{"d":"M20 22a2 2 0 0 0 2-2"}]],"file-search-corner":[["path",{"d":"M11.1 22H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.589 3.588A2.4 2.4 0 0 1 20 8v3.25"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"m21 22-2.88-2.88"}],["circle",{"cx":"16","cy":"17","r":"3"}]],"file-search":[["path",{"d":"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["circle",{"cx":"11.5","cy":"14.5","r":"2.5"}],["path",{"d":"M13.3 16.3 15 18"}]],"file-signal":[["path",{"d":"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"M8 15h.01"}],["path",{"d":"M11.5 13.5a2.5 2.5 0 0 1 0 3"}],["path",{"d":"M15 12a5 5 0 0 1 0 6"}]],"file-sliders":[["path",{"d":"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"M8 12h8"}],["path",{"d":"M10 11v2"}],["path",{"d":"M8 17h8"}],["path",{"d":"M14 16v2"}]],"file-spreadsheet":[["path",{"d":"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"M8 13h2"}],["path",{"d":"M14 13h2"}],["path",{"d":"M8 17h2"}],["path",{"d":"M14 17h2"}]],"file-stack":[["path",{"d":"M11 21a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1"}],["path",{"d":"M16 16a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1"}],["path",{"d":"M21 6a2 2 0 0 0-.586-1.414l-2-2A2 2 0 0 0 17 2h-3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1z"}]],"file-symlink":[["path",{"d":"M4 11V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h7"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"m10 18 3-3-3-3"}]],"file-terminal":[["path",{"d":"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"m8 16 2-2-2-2"}],["path",{"d":"M12 18h4"}]],"file-text":[["path",{"d":"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"M10 9H8"}],["path",{"d":"M16 13H8"}],["path",{"d":"M16 17H8"}]],"file-type-corner":[["path",{"d":"M12 22h6a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v6"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"M3 16v-1.5a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 .5.5V16"}],["path",{"d":"M6 22h2"}],["path",{"d":"M7 14v8"}]],"file-type":[["path",{"d":"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"M11 18h2"}],["path",{"d":"M12 12v6"}],["path",{"d":"M9 13v-.5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 .5.5v.5"}]],"file-up":[["path",{"d":"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"M12 12v6"}],["path",{"d":"m15 15-3-3-3 3"}]],"file-user":[["path",{"d":"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"M16 22a4 4 0 0 0-8 0"}],["circle",{"cx":"12","cy":"15","r":"3"}]],"file-video-camera":[["path",{"d":"M4 12V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"m10 17.843 3.033-1.755a.64.64 0 0 1 .967.56v4.704a.65.65 0 0 1-.967.56L10 20.157"}],["rect",{"width":"7","height":"6","x":"3","y":"16","rx":"1"}]],"file-volume":[["path",{"d":"M4 11.55V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2h-1.95"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"M12 15a5 5 0 0 1 0 6"}],["path",{"d":"M8 14.502a.5.5 0 0 0-.826-.381l-1.893 1.631a1 1 0 0 1-.651.243H3.5a.5.5 0 0 0-.5.501v3.006a.5.5 0 0 0 .5.501h1.129a1 1 0 0 1 .652.243l1.893 1.633a.5.5 0 0 0 .826-.38z"}]],"file-x-corner":[["path",{"d":"M11 22H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v5"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"m15 17 5 5"}],["path",{"d":"m20 17-5 5"}]],"file-x":[["path",{"d":"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"m14.5 12.5-5 5"}],["path",{"d":"m9.5 12.5 5 5"}]],"file":[["path",{"d":"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}]],"files":[["path",{"d":"M15 2h-4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8"}],["path",{"d":"M16.706 2.706A2.4 2.4 0 0 0 15 2v5a1 1 0 0 0 1 1h5a2.4 2.4 0 0 0-.706-1.706z"}],["path",{"d":"M5 7a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h8a2 2 0 0 0 1.732-1"}]],"film":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M7 3v18"}],["path",{"d":"M3 7.5h4"}],["path",{"d":"M3 12h18"}],["path",{"d":"M3 16.5h4"}],["path",{"d":"M17 3v18"}],["path",{"d":"M17 7.5h4"}],["path",{"d":"M17 16.5h4"}]],"fingerprint-pattern":[["path",{"d":"M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4"}],["path",{"d":"M14 13.12c0 2.38 0 6.38-1 8.88"}],["path",{"d":"M17.29 21.02c.12-.6.43-2.3.5-3.02"}],["path",{"d":"M2 12a10 10 0 0 1 18-6"}],["path",{"d":"M2 16h.01"}],["path",{"d":"M21.8 16c.2-2 .131-5.354 0-6"}],["path",{"d":"M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2"}],["path",{"d":"M8.65 22c.21-.66.45-1.32.57-2"}],["path",{"d":"M9 6.8a6 6 0 0 1 9 5.2v2"}]],"fire-extinguisher":[["path",{"d":"M15 6.5V3a1 1 0 0 0-1-1h-2a1 1 0 0 0-1 1v3.5"}],["path",{"d":"M9 18h8"}],["path",{"d":"M18 3h-3"}],["path",{"d":"M11 3a6 6 0 0 0-6 6v11"}],["path",{"d":"M5 13h4"}],["path",{"d":"M17 10a4 4 0 0 0-8 0v10a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2Z"}]],"fish-off":[["path",{"d":"M18 12.47v.03m0-.5v.47m-.475 5.056A6.744 6.744 0 0 1 15 18c-3.56 0-7.56-2.53-8.5-6 .348-1.28 1.114-2.433 2.121-3.38m3.444-2.088A8.802 8.802 0 0 1 15 6c3.56 0 6.06 2.54 7 6-.309 1.14-.786 2.177-1.413 3.058"}],["path",{"d":"M7 10.67C7 8 5.58 5.97 2.73 5.5c-1 1.5-1 5 .23 6.5-1.24 1.5-1.24 5-.23 6.5C5.58 18.03 7 16 7 13.33m7.48-4.372A9.77 9.77 0 0 1 16 6.07m0 11.86a9.77 9.77 0 0 1-1.728-3.618"}],["path",{"d":"m16.01 17.93-.23 1.4A2 2 0 0 1 13.8 21H9.5a5.96 5.96 0 0 0 1.49-3.98M8.53 3h5.27a2 2 0 0 1 1.98 1.67l.23 1.4M2 2l20 20"}]],"fish-symbol":[["path",{"d":"M2 16s9-15 20-4C11 23 2 8 2 8"}]],"fish":[["path",{"d":"M6.5 12c.94-3.46 4.94-6 8.5-6 3.56 0 6.06 2.54 7 6-.94 3.47-3.44 6-7 6s-7.56-2.53-8.5-6Z"}],["path",{"d":"M18 12v.5"}],["path",{"d":"M16 17.93a9.77 9.77 0 0 1 0-11.86"}],["path",{"d":"M7 10.67C7 8 5.58 5.97 2.73 5.5c-1 1.5-1 5 .23 6.5-1.24 1.5-1.24 5-.23 6.5C5.58 18.03 7 16 7 13.33"}],["path",{"d":"M10.46 7.26C10.2 5.88 9.17 4.24 8 3h5.8a2 2 0 0 1 1.98 1.67l.23 1.4"}],["path",{"d":"m16.01 17.93-.23 1.4A2 2 0 0 1 13.8 21H9.5a5.96 5.96 0 0 0 1.49-3.98"}]],"fishing-hook":[["path",{"d":"m17.586 11.414-5.93 5.93a1 1 0 0 1-8-8l3.137-3.137a.707.707 0 0 1 1.207.5V10"}],["path",{"d":"M20.414 8.586 22 7"}],["circle",{"cx":"19","cy":"10","r":"2"}]],"fishing-rod":[["path",{"d":"M4 11h1"}],["path",{"d":"M8 15a2 2 0 0 1-4 0V3a1 1 0 0 1 1-1h.5C14 2 20 9 20 18v4"}],["circle",{"cx":"18","cy":"18","r":"2"}]],"flag-off":[["path",{"d":"M16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528"}],["path",{"d":"m2 2 20 20"}],["path",{"d":"M4 22V4"}],["path",{"d":"M7.656 2H8c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10.347"}]],"flag-triangle-left":[["path",{"d":"M18 22V2.8a.8.8 0 0 0-1.17-.71L5.45 7.78a.8.8 0 0 0 0 1.44L18 15.5"}]],"flag-triangle-right":[["path",{"d":"M6 22V2.8a.8.8 0 0 1 1.17-.71l11.38 5.69a.8.8 0 0 1 0 1.44L6 15.5"}]],"flag":[["path",{"d":"M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528"}]],"flame-kindling":[["path",{"d":"M12 2c1 3 2.5 3.5 3.5 4.5A5 5 0 0 1 17 10a5 5 0 1 1-10 0c0-.3 0-.6.1-.9a2 2 0 1 0 3.3-2C8 4.5 11 2 12 2Z"}],["path",{"d":"m5 22 14-4"}],["path",{"d":"m5 18 14 4"}]],"flame":[["path",{"d":"M12 3q1 4 4 6.5t3 5.5a1 1 0 0 1-14 0 5 5 0 0 1 1-3 1 1 0 0 0 5 0c0-2-1.5-3-1.5-5q0-2 2.5-4"}]],"flashlight-off":[["path",{"d":"M11.652 6H18"}],["path",{"d":"M12 13v1"}],["path",{"d":"M16 16v4a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-8a4 4 0 0 0-.8-2.4l-.6-.8A3 3 0 0 1 6 7V6"}],["path",{"d":"m2 2 20 20"}],["path",{"d":"M7.649 2H17a1 1 0 0 1 1 1v4a3 3 0 0 1-.6 1.8l-.6.8a4 4 0 0 0-.55 1.007"}]],"flashlight":[["path",{"d":"M12 13v1"}],["path",{"d":"M17 2a1 1 0 0 1 1 1v4a3 3 0 0 1-.6 1.8l-.6.8A4 4 0 0 0 16 12v8a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2v-8a4 4 0 0 0-.8-2.4l-.6-.8A3 3 0 0 1 6 7V3a1 1 0 0 1 1-1z"}],["path",{"d":"M6 6h12"}]],"flask-conical-off":[["path",{"d":"M10 2v2.343"}],["path",{"d":"M14 2v6.343"}],["path",{"d":"m2 2 20 20"}],["path",{"d":"M20 20a2 2 0 0 1-2 2H6a2 2 0 0 1-1.755-2.96l5.227-9.563"}],["path",{"d":"M6.453 15H15"}],["path",{"d":"M8.5 2h7"}]],"flask-conical":[["path",{"d":"M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2"}],["path",{"d":"M6.453 15h11.094"}],["path",{"d":"M8.5 2h7"}]],"flask-round":[["path",{"d":"M10 2v6.292a7 7 0 1 0 4 0V2"}],["path",{"d":"M5 15h14"}],["path",{"d":"M8.5 2h7"}]],"flower-2":[["path",{"d":"M12 5a3 3 0 1 1 3 3m-3-3a3 3 0 1 0-3 3m3-3v1M9 8a3 3 0 1 0 3 3M9 8h1m5 0a3 3 0 1 1-3 3m3-3h-1m-2 3v-1"}],["circle",{"cx":"12","cy":"8","r":"2"}],["path",{"d":"M12 10v12"}],["path",{"d":"M12 22c4.2 0 7-1.667 7-5-4.2 0-7 1.667-7 5Z"}],["path",{"d":"M12 22c-4.2 0-7-1.667-7-5 4.2 0 7 1.667 7 5Z"}]],"flower":[["circle",{"cx":"12","cy":"12","r":"3"}],["path",{"d":"M12 16.5A4.5 4.5 0 1 1 7.5 12 4.5 4.5 0 1 1 12 7.5a4.5 4.5 0 1 1 4.5 4.5 4.5 4.5 0 1 1-4.5 4.5"}],["path",{"d":"M12 7.5V9"}],["path",{"d":"M7.5 12H9"}],["path",{"d":"M16.5 12H15"}],["path",{"d":"M12 16.5V15"}],["path",{"d":"m8 8 1.88 1.88"}],["path",{"d":"M14.12 9.88 16 8"}],["path",{"d":"m8 16 1.88-1.88"}],["path",{"d":"M14.12 14.12 16 16"}]],"focus":[["circle",{"cx":"12","cy":"12","r":"3"}],["path",{"d":"M3 7V5a2 2 0 0 1 2-2h2"}],["path",{"d":"M17 3h2a2 2 0 0 1 2 2v2"}],["path",{"d":"M21 17v2a2 2 0 0 1-2 2h-2"}],["path",{"d":"M7 21H5a2 2 0 0 1-2-2v-2"}]],"fold-horizontal":[["path",{"d":"M2 12h6"}],["path",{"d":"M22 12h-6"}],["path",{"d":"M12 2v2"}],["path",{"d":"M12 8v2"}],["path",{"d":"M12 14v2"}],["path",{"d":"M12 20v2"}],["path",{"d":"m19 9-3 3 3 3"}],["path",{"d":"m5 15 3-3-3-3"}]],"fold-vertical":[["path",{"d":"M12 22v-6"}],["path",{"d":"M12 8V2"}],["path",{"d":"M4 12H2"}],["path",{"d":"M10 12H8"}],["path",{"d":"M16 12h-2"}],["path",{"d":"M22 12h-2"}],["path",{"d":"m15 19-3-3-3 3"}],["path",{"d":"m15 5-3 3-3-3"}]],"folder-archive":[["circle",{"cx":"15","cy":"19","r":"2"}],["path",{"d":"M20.9 19.8A2 2 0 0 0 22 18V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h5.1"}],["path",{"d":"M15 11v-1"}],["path",{"d":"M15 17v-2"}]],"folder-bookmark":[["path",{"d":"M12 6v7.751a.25.25 0 00.407.195l2.28-1.834a.5.5 0 01.627 0l2.28 1.834a.25.25 0 00.406-.195V6"}],["path",{"d":"M20 20a2 2 0 002-2V8a2 2 0 00-2-2h-7.9a2 2 0 01-1.69-.9L9.6 3.9A2 2 0 007.93 3H4a2 2 0 00-2 2v13a2 2 0 002 2z"}]],"folder-check":[["path",{"d":"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"}],["path",{"d":"m9 13 2 2 4-4"}]],"folder-clock":[["path",{"d":"M16 14v2.2l1.6 1"}],["path",{"d":"M7 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2"}],["circle",{"cx":"16","cy":"16","r":"6"}]],"folder-closed":[["path",{"d":"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"}],["path",{"d":"M2 10h20"}]],"folder-code":[["path",{"d":"M10 10.5 8 13l2 2.5"}],["path",{"d":"m14 10.5 2 2.5-2 2.5"}],["path",{"d":"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"}]],"folder-cog":[["path",{"d":"M10.3 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.98a2 2 0 0 1 1.69.9l.66 1.2A2 2 0 0 0 12 6h8a2 2 0 0 1 2 2v3.3"}],["path",{"d":"m14.305 19.53.923-.382"}],["path",{"d":"m15.228 16.852-.923-.383"}],["path",{"d":"m16.852 15.228-.383-.923"}],["path",{"d":"m16.852 20.772-.383.924"}],["path",{"d":"m19.148 15.228.383-.923"}],["path",{"d":"m19.53 21.696-.382-.924"}],["path",{"d":"m20.772 16.852.924-.383"}],["path",{"d":"m20.772 19.148.924.383"}],["circle",{"cx":"18","cy":"18","r":"3"}]],"folder-dot":[["path",{"d":"M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"}],["circle",{"cx":"12","cy":"13","r":"1"}]],"folder-down":[["path",{"d":"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"}],["path",{"d":"M12 10v6"}],["path",{"d":"m15 13-3 3-3-3"}]],"folder-git-2":[["path",{"d":"M18 19a5 5 0 0 1-5-5v8"}],["path",{"d":"M9 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v5"}],["circle",{"cx":"13","cy":"12","r":"2"}],["circle",{"cx":"20","cy":"19","r":"2"}]],"folder-git":[["circle",{"cx":"12","cy":"13","r":"2"}],["path",{"d":"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"}],["path",{"d":"M14 13h3"}],["path",{"d":"M7 13h3"}]],"folder-heart":[["path",{"d":"M10.638 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v3.417"}],["path",{"d":"M14.62 18.8A2.25 2.25 0 1 1 18 15.836a2.25 2.25 0 1 1 3.38 2.966l-2.626 2.856a.998.998 0 0 1-1.507 0z"}]],"folder-input":[["path",{"d":"M2 9V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-1"}],["path",{"d":"M2 13h10"}],["path",{"d":"m9 16 3-3-3-3"}]],"folder-kanban":[["path",{"d":"M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"}],["path",{"d":"M8 10v4"}],["path",{"d":"M12 10v2"}],["path",{"d":"M16 10v6"}]],"folder-key":[["path",{"d":"M13 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v1.36"}],["path",{"d":"M19 12v6"}],["path",{"d":"M19 14h2"}],["circle",{"cx":"19","cy":"20","r":"2"}]],"folder-lock":[["rect",{"width":"8","height":"5","x":"14","y":"17","rx":"1"}],["path",{"d":"M10 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v2.5"}],["path",{"d":"M20 17v-2a2 2 0 1 0-4 0v2"}]],"folder-minus":[["path",{"d":"M9 13h6"}],["path",{"d":"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"}]],"folder-open-dot":[["path",{"d":"m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5c0-1.1.9-2 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2"}],["circle",{"cx":"14","cy":"15","r":"1"}]],"folder-open":[["path",{"d":"m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"}]],"folder-output":[["path",{"d":"M2 7.5V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-1.5"}],["path",{"d":"M2 13h10"}],["path",{"d":"m5 10-3 3 3 3"}]],"folder-pen":[["path",{"d":"M2 11.5V5a2 2 0 0 1 2-2h3.9c.7 0 1.3.3 1.7.9l.8 1.2c.4.6 1 .9 1.7.9H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-9.5"}],["path",{"d":"M11.378 13.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z"}]],"folder-plus":[["path",{"d":"M12 10v6"}],["path",{"d":"M9 13h6"}],["path",{"d":"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"}]],"folder-root":[["path",{"d":"M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"}],["circle",{"cx":"12","cy":"13","r":"2"}],["path",{"d":"M12 15v5"}]],"folder-search-2":[["circle",{"cx":"11.5","cy":"12.5","r":"2.5"}],["path",{"d":"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"}],["path",{"d":"M13.3 14.3 15 16"}]],"folder-search":[["path",{"d":"M10.7 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v4.1"}],["path",{"d":"m21 21-1.9-1.9"}],["circle",{"cx":"17","cy":"17","r":"3"}]],"folder-symlink":[["path",{"d":"M2 9.35V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h7"}],["path",{"d":"m8 16 3-3-3-3"}]],"folder-sync":[["path",{"d":"M9 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v.5"}],["path",{"d":"M12 10v4h4"}],["path",{"d":"m12 14 1.535-1.605a5 5 0 0 1 8 1.5"}],["path",{"d":"M22 22v-4h-4"}],["path",{"d":"m22 18-1.535 1.605a5 5 0 0 1-8-1.5"}]],"folder-tree":[["path",{"d":"M20 10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2.5a1 1 0 0 1-.8-.4l-.9-1.2A1 1 0 0 0 15 3h-2a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z"}],["path",{"d":"M20 21a1 1 0 0 0 1-1v-3a1 1 0 0 0-1-1h-2.9a1 1 0 0 1-.88-.55l-.42-.85a1 1 0 0 0-.92-.6H13a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z"}],["path",{"d":"M3 5a2 2 0 0 0 2 2h3"}],["path",{"d":"M3 3v13a2 2 0 0 0 2 2h3"}]],"folder-up":[["path",{"d":"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"}],["path",{"d":"M12 10v6"}],["path",{"d":"m9 13 3-3 3 3"}]],"folder-x":[["path",{"d":"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"}],["path",{"d":"m9.5 10.5 5 5"}],["path",{"d":"m14.5 10.5-5 5"}]],"folder":[["path",{"d":"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"}]],"folders":[["path",{"d":"M20 5a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h2.5a1.5 1.5 0 0 1 1.2.6l.6.8a1.5 1.5 0 0 0 1.2.6z"}],["path",{"d":"M3 8.268a2 2 0 0 0-1 1.738V19a2 2 0 0 0 2 2h11a2 2 0 0 0 1.732-1"}]],"footprints":[["path",{"d":"M4 16v-2.38C4 11.5 2.97 10.5 3 8c.03-2.72 1.49-6 4.5-6C9.37 2 10 3.8 10 5.5c0 3.11-2 5.66-2 8.68V16a2 2 0 1 1-4 0Z"}],["path",{"d":"M20 20v-2.38c0-2.12 1.03-3.12 1-5.62-.03-2.72-1.49-6-4.5-6C14.63 6 14 7.8 14 9.5c0 3.11 2 5.66 2 8.68V20a2 2 0 1 0 4 0Z"}],["path",{"d":"M16 17h4"}],["path",{"d":"M4 13h4"}]],"forklift":[["path",{"d":"M12 12H5a2 2 0 0 0-2 2v5"}],["path",{"d":"M15 19h7"}],["path",{"d":"M16 19V2"}],["path",{"d":"M6 12V7a2 2 0 0 1 2-2h2.172a2 2 0 0 1 1.414.586l3.828 3.828A2 2 0 0 1 16 10.828"}],["path",{"d":"M7 19h4"}],["circle",{"cx":"13","cy":"19","r":"2"}],["circle",{"cx":"5","cy":"19","r":"2"}]],"form":[["path",{"d":"M4 14h6"}],["path",{"d":"M4 2h10"}],["rect",{"x":"4","y":"18","width":"16","height":"4","rx":"1"}],["rect",{"x":"4","y":"6","width":"16","height":"4","rx":"1"}]],"forward":[["path",{"d":"m15 17 5-5-5-5"}],["path",{"d":"M4 18v-2a4 4 0 0 1 4-4h12"}]],"frame":[["line",{"x1":"22","x2":"2","y1":"6","y2":"6"}],["line",{"x1":"22","x2":"2","y1":"18","y2":"18"}],["line",{"x1":"6","x2":"6","y1":"2","y2":"22"}],["line",{"x1":"18","x2":"18","y1":"2","y2":"22"}]],"fuel":[["path",{"d":"M14 13h2a2 2 0 0 1 2 2v2a2 2 0 0 0 4 0v-6.998a2 2 0 0 0-.59-1.42L18 5"}],["path",{"d":"M14 21V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v16"}],["path",{"d":"M2 21h13"}],["path",{"d":"M3 9h11"}]],"fullscreen":[["path",{"d":"M3 7V5a2 2 0 0 1 2-2h2"}],["path",{"d":"M17 3h2a2 2 0 0 1 2 2v2"}],["path",{"d":"M21 17v2a2 2 0 0 1-2 2h-2"}],["path",{"d":"M7 21H5a2 2 0 0 1-2-2v-2"}],["rect",{"width":"10","height":"8","x":"7","y":"8","rx":"1"}]],"funnel-plus":[["path",{"d":"M13.354 3H3a1 1 0 0 0-.742 1.67l7.225 7.989A2 2 0 0 1 10 14v6a1 1 0 0 0 .553.895l2 1A1 1 0 0 0 14 21v-7a2 2 0 0 1 .517-1.341l1.218-1.348"}],["path",{"d":"M16 6h6"}],["path",{"d":"M19 3v6"}]],"funnel-x":[["path",{"d":"M12.531 3H3a1 1 0 0 0-.742 1.67l7.225 7.989A2 2 0 0 1 10 14v6a1 1 0 0 0 .553.895l2 1A1 1 0 0 0 14 21v-7a2 2 0 0 1 .517-1.341l.427-.473"}],["path",{"d":"m16.5 3.5 5 5"}],["path",{"d":"m21.5 3.5-5 5"}]],"funnel":[["path",{"d":"M10 20a1 1 0 0 0 .553.895l2 1A1 1 0 0 0 14 21v-7a2 2 0 0 1 .517-1.341L21.74 4.67A1 1 0 0 0 21 3H3a1 1 0 0 0-.742 1.67l7.225 7.989A2 2 0 0 1 10 14z"}]],"galaxy":[["path",{"d":"M16.005 15.108a5.041 6.52 28.25 00-8.008-6.217 5.041 6.52 28.25 008.008 6.217A11.884 7.288-60.76 014.029 7.001"}],["path",{"d":"M17 21h.01"}],["path",{"d":"M7 3h.01"}],["path",{"d":"M7.997 8.891a11.885 7.288-60.756 0111.977 8.107"}],["circle",{"cx":"12","cy":"12","r":"1","fill":"currentColor"}]],"gallery-horizontal-end":[["path",{"d":"M2 7v10"}],["path",{"d":"M6 5v14"}],["rect",{"width":"12","height":"18","x":"10","y":"3","rx":"2"}]],"gallery-horizontal":[["path",{"d":"M2 3v18"}],["rect",{"width":"12","height":"18","x":"6","y":"3","rx":"2"}],["path",{"d":"M22 3v18"}]],"gallery-thumbnails":[["rect",{"width":"18","height":"14","x":"3","y":"3","rx":"2"}],["path",{"d":"M4 21h1"}],["path",{"d":"M9 21h1"}],["path",{"d":"M14 21h1"}],["path",{"d":"M19 21h1"}]],"gallery-vertical-end":[["path",{"d":"M7 2h10"}],["path",{"d":"M5 6h14"}],["rect",{"width":"18","height":"12","x":"3","y":"10","rx":"2"}]],"gallery-vertical":[["path",{"d":"M3 2h18"}],["rect",{"width":"18","height":"12","x":"3","y":"6","rx":"2"}],["path",{"d":"M3 22h18"}]],"gamepad-2":[["line",{"x1":"6","x2":"10","y1":"11","y2":"11"}],["line",{"x1":"8","x2":"8","y1":"9","y2":"13"}],["line",{"x1":"15","x2":"15.01","y1":"12","y2":"12"}],["line",{"x1":"18","x2":"18.01","y1":"10","y2":"10"}],["path",{"d":"M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z"}]],"gamepad-directional":[["path",{"d":"M11.146 15.854a1.207 1.207 0 0 1 1.708 0l1.56 1.56A2 2 0 0 1 15 18.828V21a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1v-2.172a2 2 0 0 1 .586-1.414z"}],["path",{"d":"M18.828 15a2 2 0 0 1-1.414-.586l-1.56-1.56a1.207 1.207 0 0 1 0-1.708l1.56-1.56A2 2 0 0 1 18.828 9H21a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1z"}],["path",{"d":"M6.586 14.414A2 2 0 0 1 5.172 15H3a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h2.172a2 2 0 0 1 1.414.586l1.56 1.56a1.207 1.207 0 0 1 0 1.708z"}],["path",{"d":"M9 3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2.172a2 2 0 0 1-.586 1.414l-1.56 1.56a1.207 1.207 0 0 1-1.708 0l-1.56-1.56A2 2 0 0 1 9 5.172z"}]],"gamepad":[["line",{"x1":"6","x2":"10","y1":"12","y2":"12"}],["line",{"x1":"8","x2":"8","y1":"10","y2":"14"}],["line",{"x1":"15","x2":"15.01","y1":"13","y2":"13"}],["line",{"x1":"18","x2":"18.01","y1":"11","y2":"11"}],["rect",{"width":"20","height":"12","x":"2","y":"6","rx":"2"}]],"gap-horizontal":[["path",{"d":"M12 2v2"}],["path",{"d":"M12 8v2"}],["path",{"d":"M12 14v2"}],["path",{"d":"M12 20v2"}],["path",{"d":"M21 3h-3a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3"}],["path",{"d":"M3 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H3"}]],"gap-vertical":[["path",{"d":"M2 12h2"}],["path",{"d":"M8 12h2"}],["path",{"d":"M14 12h2"}],["path",{"d":"M20 12h2"}],["path",{"d":"M3 21v-3a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3"}],["path",{"d":"M3 3v3a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V3"}]],"gauge":[["path",{"d":"m12 14 4-4"}],["path",{"d":"M3.34 19a10 10 0 1 1 17.32 0"}]],"gavel":[["path",{"d":"m14 13-8.381 8.38a1 1 0 0 1-3.001-3l8.384-8.381"}],["path",{"d":"m16 16 6-6"}],["path",{"d":"m21.5 10.5-8-8"}],["path",{"d":"m8 8 6-6"}],["path",{"d":"m8.5 7.5 8 8"}]],"gem":[["path",{"d":"M10.5 3 8 9l4 13 4-13-2.5-6"}],["path",{"d":"M17 3a2 2 0 0 1 1.6.8l3 4a2 2 0 0 1 .013 2.382l-7.99 10.986a2 2 0 0 1-3.247 0l-7.99-10.986A2 2 0 0 1 2.4 7.8l2.998-3.997A2 2 0 0 1 7 3z"}],["path",{"d":"M2 9h20"}]],"georgian-lari":[["path",{"d":"M11.5 21a7.5 7.5 0 1 1 7.35-9"}],["path",{"d":"M13 12V3"}],["path",{"d":"M4 21h16"}],["path",{"d":"M9 12V3"}]],"germ-off":[["path",{"d":"m11 2 .925 1.848"}],["path",{"d":"M13 15h.01"}],["path",{"d":"M13.424 7.768a2 2 0 112.808 2.808"}],["path",{"d":"m16 21-1-2.472"}],["path",{"d":"M16.988 16.988A12 12 0 019 20a5 5 0 01-2.759-9.171 8.8 8.8 0 002.307-2.28"}],["path",{"d":"m19 2-1 1.804"}],["path",{"d":"m2 19 2.746-1.373"}],["path",{"d":"m2 2 20 20"}],["path",{"d":"m22 16-2.474-2.13a12 12 0 001.376-3.786 6 6 0 00-10.313-5.151"}],["path",{"d":"m22 5-1.804 1"}],["path",{"d":"m3 10 2 2"}],["path",{"d":"M9 16h.01"}],["path",{"d":"M9 20v2"}]],"germ":[["path",{"d":"m11 2 .925 1.848"}],["path",{"d":"M13 15h.01"}],["path",{"d":"m16 21-1-2.472"}],["path",{"d":"m19 2-1 1.804"}],["path",{"d":"m2 19 2.746-1.373"}],["path",{"d":"m22 16-2.474-2.13"}],["path",{"d":"m22 5-1.804 1"}],["path",{"d":"m3 10 2 2"}],["path",{"d":"M9 16h.01"}],["path",{"d":"M9 20v2"}],["path",{"d":"M9.33 7.035c-.51 1.478-1.786 2.93-3.09 3.794A5 5 0 009 20a12.1 12.1 0 0011.902-9.916A6 6 0 009.33 7.035"}],["circle",{"cx":"15","cy":"9","r":"2"}]],"ghost":[["path",{"d":"M15 10v1"}],["path",{"d":"M7.528 20.472a1.6 1.6 0 012.277 0l1.057 1.056a1.6 1.6 0 002.276 0l1.057-1.056a1.6 1.6 0 012.277 0l1.114 1.114a1.4 1.4 0 002.414-1V10a8 8 0 00-16 0v10.586a1.4 1.4 0 002.414 1z"}],["path",{"d":"M9 10v1"}]],"gift":[["path",{"d":"M12 7v14"}],["path",{"d":"M20 11v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8"}],["path",{"d":"M7.5 7a1 1 0 0 1 0-5A4.8 8 0 0 1 12 7a4.8 8 0 0 1 4.5-5 1 1 0 0 1 0 5"}],["rect",{"x":"3","y":"7","width":"18","height":"4","rx":"1"}]],"git-branch-minus":[["path",{"d":"M15 6a9 9 0 0 0-9 9V3"}],["path",{"d":"M21 18h-6"}],["circle",{"cx":"18","cy":"6","r":"3"}],["circle",{"cx":"6","cy":"18","r":"3"}]],"git-branch-plus":[["path",{"d":"M6 3v12"}],["path",{"d":"M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"}],["path",{"d":"M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"}],["path",{"d":"M15 6a9 9 0 0 0-9 9"}],["path",{"d":"M18 15v6"}],["path",{"d":"M21 18h-6"}]],"git-branch":[["path",{"d":"M15 6a9 9 0 0 0-9 9V3"}],["circle",{"cx":"18","cy":"6","r":"3"}],["circle",{"cx":"6","cy":"18","r":"3"}]],"git-commit-horizontal":[["circle",{"cx":"12","cy":"12","r":"3"}],["line",{"x1":"3","x2":"9","y1":"12","y2":"12"}],["line",{"x1":"15","x2":"21","y1":"12","y2":"12"}]],"git-commit-vertical":[["path",{"d":"M12 3v6"}],["circle",{"cx":"12","cy":"12","r":"3"}],["path",{"d":"M12 15v6"}]],"git-compare-arrows":[["circle",{"cx":"5","cy":"6","r":"3"}],["path",{"d":"M12 6h5a2 2 0 0 1 2 2v7"}],["path",{"d":"m15 9-3-3 3-3"}],["circle",{"cx":"19","cy":"18","r":"3"}],["path",{"d":"M12 18H7a2 2 0 0 1-2-2V9"}],["path",{"d":"m9 15 3 3-3 3"}]],"git-compare":[["circle",{"cx":"18","cy":"18","r":"3"}],["circle",{"cx":"6","cy":"6","r":"3"}],["path",{"d":"M13 6h3a2 2 0 0 1 2 2v7"}],["path",{"d":"M11 18H8a2 2 0 0 1-2-2V9"}]],"git-fork":[["circle",{"cx":"12","cy":"18","r":"3"}],["circle",{"cx":"6","cy":"6","r":"3"}],["circle",{"cx":"18","cy":"6","r":"3"}],["path",{"d":"M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9"}],["path",{"d":"M12 12v3"}]],"git-graph":[["circle",{"cx":"5","cy":"6","r":"3"}],["path",{"d":"M5 9v6"}],["circle",{"cx":"5","cy":"18","r":"3"}],["path",{"d":"M12 3v18"}],["circle",{"cx":"19","cy":"6","r":"3"}],["path",{"d":"M16 15.7A9 9 0 0 0 19 9"}]],"git-merge-conflict":[["path",{"d":"M12 6h4a2 2 0 0 1 2 2v7"}],["path",{"d":"M6 12v9"}],["path",{"d":"m8.5 3.5-5 5"}],["path",{"d":"m8.5 8.5-5-5"}],["circle",{"cx":"18","cy":"18","r":"3"}]],"git-merge":[["circle",{"cx":"18","cy":"18","r":"3"}],["circle",{"cx":"6","cy":"6","r":"3"}],["path",{"d":"M6 21V9a9 9 0 0 0 9 9"}]],"git-pull-request-arrow":[["circle",{"cx":"5","cy":"6","r":"3"}],["path",{"d":"M5 9v12"}],["circle",{"cx":"19","cy":"18","r":"3"}],["path",{"d":"m15 9-3-3 3-3"}],["path",{"d":"M12 6h5a2 2 0 0 1 2 2v7"}]],"git-pull-request-closed":[["path",{"d":"m15.5 3.5 5 5"}],["path",{"d":"m15.5 8.5 5-5"}],["path",{"d":"M18 11.62V15"}],["path",{"d":"M6 9v12"}],["circle",{"cx":"18","cy":"18","r":"3"}],["circle",{"cx":"6","cy":"6","r":"3"}]],"git-pull-request-create-arrow":[["circle",{"cx":"5","cy":"6","r":"3"}],["path",{"d":"M5 9v12"}],["path",{"d":"m15 9-3-3 3-3"}],["path",{"d":"M12 6h5a2 2 0 0 1 2 2v3"}],["path",{"d":"M19 15v6"}],["path",{"d":"M22 18h-6"}]],"git-pull-request-create":[["circle",{"cx":"6","cy":"6","r":"3"}],["path",{"d":"M6 9v12"}],["path",{"d":"M13 6h3a2 2 0 0 1 2 2v3"}],["path",{"d":"M18 15v6"}],["path",{"d":"M21 18h-6"}]],"git-pull-request-draft":[["circle",{"cx":"18","cy":"18","r":"3"}],["circle",{"cx":"6","cy":"6","r":"3"}],["path",{"d":"M18 6V5"}],["path",{"d":"M18 11v-1"}],["line",{"x1":"6","x2":"6","y1":"9","y2":"21"}]],"git-pull-request":[["circle",{"cx":"18","cy":"18","r":"3"}],["circle",{"cx":"6","cy":"6","r":"3"}],["path",{"d":"M13 6h3a2 2 0 0 1 2 2v7"}],["line",{"x1":"6","x2":"6","y1":"9","y2":"21"}]],"glass-water":[["path",{"d":"M5.116 4.104A1 1 0 0 1 6.11 3h11.78a1 1 0 0 1 .994 1.105L17.19 20.21A2 2 0 0 1 15.2 22H8.8a2 2 0 0 1-2-1.79z"}],["path",{"d":"M6 12a5 5 0 0 1 6 0 5 5 0 0 0 6 0"}]],"glasses":[["circle",{"cx":"6","cy":"15","r":"4"}],["circle",{"cx":"18","cy":"15","r":"4"}],["path",{"d":"M14 15a2 2 0 0 0-2-2 2 2 0 0 0-2 2"}],["path",{"d":"M2.5 13 5 7c.7-1.3 1.4-2 3-2"}],["path",{"d":"M21.5 13 19 7c-.7-1.3-1.5-2-3-2"}]],"globe-check":[["path",{"d":"m15 6 2 2 4-4"}],["path",{"d":"M2 12h20A10 10 0 1 1 12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 4-10"}]],"globe-code":[["path",{"d":"M15.5 10 13 7.5 15.5 5"}],["path",{"d":"M15.861 14A14.5 14.5 0 0112 22a14.48 14.48 0 010-20 10 10 0 109.888 11.5"}],["path",{"d":"M19.5 5 22 7.5 19.5 10"}],["path",{"d":"M2 12h8.5"}]],"globe-lock":[["path",{"d":"M15.686 15A14.5 14.5 0 0 1 12 22a14.5 14.5 0 0 1 0-20 10 10 0 1 0 9.542 13"}],["path",{"d":"M2 12h8.5"}],["path",{"d":"M20 6V4a2 2 0 1 0-4 0v2"}],["rect",{"width":"8","height":"5","x":"14","y":"6","rx":"1"}]],"globe-off":[["path",{"d":"M10.114 4.462A14.5 14.5 0 0 1 12 2a10 10 0 0 1 9.313 13.643"}],["path",{"d":"M15.557 15.556A14.5 14.5 0 0 1 12 22 10 10 0 0 1 4.929 4.929"}],["path",{"d":"M15.892 10.234A14.5 14.5 0 0 0 12 2a10 10 0 0 0-3.643.687"}],["path",{"d":"M17.656 12H22"}],["path",{"d":"M19.071 19.071A10 10 0 0 1 12 22 14.5 14.5 0 0 1 8.44 8.45"}],["path",{"d":"M2 12h10"}],["path",{"d":"m2 2 20 20"}]],"globe-x":[["path",{"d":"m16 3 5 5"}],["path",{"d":"M2 12h20A10 10 0 1 1 12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 4-10"}],["path",{"d":"m21 3-5 5"}]],"globe":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"}],["path",{"d":"M2 12h20"}]],"goal":[["path",{"d":"M12 13V2l8 4-8 4"}],["path",{"d":"M20.561 10.222a9 9 0 1 1-12.55-5.29"}],["path",{"d":"M8.002 9.997a5 5 0 1 0 8.9 2.02"}]],"gpu":[["path",{"d":"M2 17h18a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2H2"}],["path",{"d":"M2 21V3"}],["path",{"d":"M7 17v3a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1v-3"}],["circle",{"cx":"16","cy":"11","r":"2"}],["circle",{"cx":"8","cy":"11","r":"2"}]],"graduation-cap":[["path",{"d":"M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z"}],["path",{"d":"M22 10v6"}],["path",{"d":"M6 12.5V16a6 3 0 0 0 12 0v-3.5"}]],"grape":[["path",{"d":"M22 5V2l-5.89 5.89"}],["circle",{"cx":"16.6","cy":"15.89","r":"3"}],["circle",{"cx":"8.11","cy":"7.4","r":"3"}],["circle",{"cx":"12.35","cy":"11.65","r":"3"}],["circle",{"cx":"13.91","cy":"5.85","r":"3"}],["circle",{"cx":"18.15","cy":"10.09","r":"3"}],["circle",{"cx":"6.56","cy":"13.2","r":"3"}],["circle",{"cx":"10.8","cy":"17.44","r":"3"}],["circle",{"cx":"5","cy":"19","r":"3"}]],"grid-2x2-check":[["path",{"d":"M12 3v17a1 1 0 0 1-1 1H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6a1 1 0 0 1-1 1H3"}],["path",{"d":"m16 19 2 2 4-4"}]],"grid-2x2-plus":[["path",{"d":"M12 3v17a1 1 0 0 1-1 1H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6a1 1 0 0 1-1 1H3"}],["path",{"d":"M16 19h6"}],["path",{"d":"M19 22v-6"}]],"grid-2x2-x":[["path",{"d":"M12 3v17a1 1 0 0 1-1 1H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6a1 1 0 0 1-1 1H3"}],["path",{"d":"m16.5 16.5 5 5"}],["path",{"d":"m16.5 21.5 5-5"}]],"grid-2x2":[["path",{"d":"M12 3v18"}],["path",{"d":"M3 12h18"}],["rect",{"x":"3","y":"3","width":"18","height":"18","rx":"2"}]],"grid-3x2":[["path",{"d":"M15 3v18"}],["path",{"d":"M3 12h18"}],["path",{"d":"M9 3v18"}],["rect",{"x":"3","y":"3","width":"18","height":"18","rx":"2"}]],"grid-3x3":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M3 9h18"}],["path",{"d":"M3 15h18"}],["path",{"d":"M9 3v18"}],["path",{"d":"M15 3v18"}]],"grip-horizontal":[["circle",{"cx":"12","cy":"9","r":"1"}],["circle",{"cx":"19","cy":"9","r":"1"}],["circle",{"cx":"5","cy":"9","r":"1"}],["circle",{"cx":"12","cy":"15","r":"1"}],["circle",{"cx":"19","cy":"15","r":"1"}],["circle",{"cx":"5","cy":"15","r":"1"}]],"grip-vertical":[["circle",{"cx":"9","cy":"12","r":"1"}],["circle",{"cx":"9","cy":"5","r":"1"}],["circle",{"cx":"9","cy":"19","r":"1"}],["circle",{"cx":"15","cy":"12","r":"1"}],["circle",{"cx":"15","cy":"5","r":"1"}],["circle",{"cx":"15","cy":"19","r":"1"}]],"grip":[["circle",{"cx":"12","cy":"5","r":"1"}],["circle",{"cx":"19","cy":"5","r":"1"}],["circle",{"cx":"5","cy":"5","r":"1"}],["circle",{"cx":"12","cy":"12","r":"1"}],["circle",{"cx":"19","cy":"12","r":"1"}],["circle",{"cx":"5","cy":"12","r":"1"}],["circle",{"cx":"12","cy":"19","r":"1"}],["circle",{"cx":"19","cy":"19","r":"1"}],["circle",{"cx":"5","cy":"19","r":"1"}]],"group":[["path",{"d":"M3 7V5c0-1.1.9-2 2-2h2"}],["path",{"d":"M17 3h2c1.1 0 2 .9 2 2v2"}],["path",{"d":"M21 17v2c0 1.1-.9 2-2 2h-2"}],["path",{"d":"M7 21H5c-1.1 0-2-.9-2-2v-2"}],["rect",{"width":"7","height":"5","x":"7","y":"7","rx":"1"}],["rect",{"width":"7","height":"5","x":"10","y":"12","rx":"1"}]],"guitar":[["path",{"d":"m11.9 12.1 4.514-4.514"}],["path",{"d":"M20.1 2.3a1 1 0 0 0-1.4 0l-1.114 1.114A2 2 0 0 0 17 4.828v1.344a2 2 0 0 1-.586 1.414A2 2 0 0 1 17.828 7h1.344a2 2 0 0 0 1.414-.586L21.7 5.3a1 1 0 0 0 0-1.4z"}],["path",{"d":"m6 16 2 2"}],["path",{"d":"M8.23 9.85A3 3 0 0 1 11 8a5 5 0 0 1 5 5 3 3 0 0 1-1.85 2.77l-.92.38A2 2 0 0 0 12 18a4 4 0 0 1-4 4 6 6 0 0 1-6-6 4 4 0 0 1 4-4 2 2 0 0 0 1.85-1.23z"}]],"ham":[["path",{"d":"M13.144 21.144A7.274 10.445 45 1 0 2.856 10.856"}],["path",{"d":"M13.144 21.144A7.274 4.365 45 0 0 2.856 10.856a7.274 4.365 45 0 0 10.288 10.288"}],["path",{"d":"M16.565 10.435 18.6 8.4a2.501 2.501 0 1 0 1.65-4.65 2.5 2.5 0 1 0-4.66 1.66l-2.024 2.025"}],["path",{"d":"m8.5 16.5-1-1"}]],"hamburger":[["path",{"d":"M12 16H4a2 2 0 1 1 0-4h16a2 2 0 1 1 0 4h-4.25"}],["path",{"d":"M5 12a2 2 0 0 1-2-2 9 7 0 0 1 18 0 2 2 0 0 1-2 2"}],["path",{"d":"M5 16a2 2 0 0 0-2 2 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 2 2 0 0 0-2-2q0 0 0 0"}],["path",{"d":"m6.67 12 6.13 4.6a2 2 0 0 0 2.8-.4l3.15-4.2"}]],"hammer":[["path",{"d":"m15 12-9.373 9.373a1 1 0 0 1-3.001-3L12 9"}],["path",{"d":"m18 15 4-4"}],["path",{"d":"m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172v-.344a2 2 0 0 0-.586-1.414l-1.657-1.657A6 6 0 0 0 12.516 3H9l1.243 1.243A6 6 0 0 1 12 8.485V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5"}]],"hand-coins":[["path",{"d":"M11 15h2a2 2 0 1 0 0-4h-3c-.6 0-1.1.2-1.4.6L3 17"}],["path",{"d":"m7 21 1.6-1.4c.3-.4.8-.6 1.4-.6h4c1.1 0 2.1-.4 2.8-1.2l4.6-4.4a2 2 0 0 0-2.75-2.91l-4.2 3.9"}],["path",{"d":"m2 16 6 6"}],["circle",{"cx":"16","cy":"9","r":"2.9"}],["circle",{"cx":"6","cy":"5","r":"3"}]],"hand-fist":[["path",{"d":"M12.035 17.012a3 3 0 0 0-3-3l-.311-.002a.72.72 0 0 1-.505-1.229l1.195-1.195A2 2 0 0 1 10.828 11H12a2 2 0 0 0 0-4H9.243a3 3 0 0 0-2.122.879l-2.707 2.707A4.83 4.83 0 0 0 3 14a8 8 0 0 0 8 8h2a8 8 0 0 0 8-8V7a2 2 0 1 0-4 0v2a2 2 0 1 0 4 0"}],["path",{"d":"M13.888 9.662A2 2 0 0 0 17 8V5A2 2 0 1 0 13 5"}],["path",{"d":"M9 5A2 2 0 1 0 5 5V10"}],["path",{"d":"M9 7V4A2 2 0 1 1 13 4V7.268"}]],"hand-grab":[["path",{"d":"M18 11.5V9a2 2 0 0 0-2-2a2 2 0 0 0-2 2v1.4"}],["path",{"d":"M14 10V8a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"}],["path",{"d":"M10 9.9V9a2 2 0 0 0-2-2a2 2 0 0 0-2 2v5"}],["path",{"d":"M6 14a2 2 0 0 0-2-2a2 2 0 0 0-2 2"}],["path",{"d":"M18 11a2 2 0 1 1 4 0v3a8 8 0 0 1-8 8h-4a8 8 0 0 1-8-8 2 2 0 1 1 4 0"}]],"hand-heart":[["path",{"d":"M11 14h2a2 2 0 0 0 0-4h-3c-.6 0-1.1.2-1.4.6L3 16"}],["path",{"d":"m14.45 13.39 5.05-4.694C20.196 8 21 6.85 21 5.75a2.75 2.75 0 0 0-4.797-1.837.276.276 0 0 1-.406 0A2.75 2.75 0 0 0 11 5.75c0 1.2.802 2.248 1.5 2.946L16 11.95"}],["path",{"d":"m2 15 6 6"}],["path",{"d":"m7 20 1.6-1.4c.3-.4.8-.6 1.4-.6h4c1.1 0 2.1-.4 2.8-1.2l4.6-4.4a1 1 0 0 0-2.75-2.91"}]],"hand-helping":[["path",{"d":"M11 12h2a2 2 0 1 0 0-4h-3c-.6 0-1.1.2-1.4.6L3 14"}],["path",{"d":"m7 18 1.6-1.4c.3-.4.8-.6 1.4-.6h4c1.1 0 2.1-.4 2.8-1.2l4.6-4.4a2 2 0 0 0-2.75-2.91l-4.2 3.9"}],["path",{"d":"m2 13 6 6"}]],"hand-metal":[["path",{"d":"M18 12.5V10a2 2 0 0 0-2-2a2 2 0 0 0-2 2v1.4"}],["path",{"d":"M14 11V9a2 2 0 1 0-4 0v2"}],["path",{"d":"M10 10.5V5a2 2 0 1 0-4 0v9"}],["path",{"d":"m7 15-1.76-1.76a2 2 0 0 0-2.83 2.82l3.6 3.6C7.5 21.14 9.2 22 12 22h2a8 8 0 0 0 8-8V7a2 2 0 1 0-4 0v5"}]],"hand-platter":[["path",{"d":"M12 3V2"}],["path",{"d":"m15.4 17.4 3.2-2.8a2 2 0 1 1 2.8 2.9l-3.6 3.3c-.7.8-1.7 1.2-2.8 1.2h-4c-1.1 0-2.1-.4-2.8-1.2l-1.302-1.464A1 1 0 0 0 6.151 19H5"}],["path",{"d":"M2 14h12a2 2 0 0 1 0 4h-2"}],["path",{"d":"M4 10h16"}],["path",{"d":"M5 10a7 7 0 0 1 14 0"}],["path",{"d":"M5 14v6a1 1 0 0 1-1 1H2"}]],"hand":[["path",{"d":"M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2"}],["path",{"d":"M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"}],["path",{"d":"M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8"}],["path",{"d":"M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"}]],"handbag":[["path",{"d":"M2.048 18.566A2 2 0 0 0 4 21h16a2 2 0 0 0 1.952-2.434l-2-9A2 2 0 0 0 18 8H6a2 2 0 0 0-1.952 1.566z"}],["path",{"d":"M8 11V6a4 4 0 0 1 8 0v5"}]],"handshake":[["path",{"d":"m11 17 2 2a1 1 0 1 0 3-3"}],["path",{"d":"m14 14 2.5 2.5a1 1 0 1 0 3-3l-3.88-3.88a3 3 0 0 0-4.24 0l-.88.88a1 1 0 1 1-3-3l2.81-2.81a5.79 5.79 0 0 1 7.06-.87l.47.28a2 2 0 0 0 1.42.25L21 4"}],["path",{"d":"m21 3 1 11h-2"}],["path",{"d":"M3 3 2 14l6.5 6.5a1 1 0 1 0 3-3"}],["path",{"d":"M3 4h8"}]],"hard-drive-download":[["path",{"d":"M12 2v8"}],["path",{"d":"m16 6-4 4-4-4"}],["rect",{"width":"20","height":"8","x":"2","y":"14","rx":"2"}],["path",{"d":"M6 18h.01"}],["path",{"d":"M10 18h.01"}]],"hard-drive-upload":[["path",{"d":"m16 6-4-4-4 4"}],["path",{"d":"M12 2v8"}],["rect",{"width":"20","height":"8","x":"2","y":"14","rx":"2"}],["path",{"d":"M6 18h.01"}],["path",{"d":"M10 18h.01"}]],"hard-drive":[["path",{"d":"M10 16h.01"}],["path",{"d":"M2.212 11.577a2 2 0 0 0-.212.896V18a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5.527a2 2 0 0 0-.212-.896L18.55 5.11A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"}],["path",{"d":"M21.946 12.013H2.054"}],["path",{"d":"M6 16h.01"}]],"hard-hat":[["path",{"d":"M10 10V5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v5"}],["path",{"d":"M14 6a6 6 0 0 1 6 6v3"}],["path",{"d":"M4 15v-3a6 6 0 0 1 6-6"}],["rect",{"x":"2","y":"15","width":"20","height":"4","rx":"1"}]],"hash":[["line",{"x1":"4","x2":"20","y1":"9","y2":"9"}],["line",{"x1":"4","x2":"20","y1":"15","y2":"15"}],["line",{"x1":"10","x2":"8","y1":"3","y2":"21"}],["line",{"x1":"16","x2":"14","y1":"3","y2":"21"}]],"hat-glasses":[["path",{"d":"M14 18a2 2 0 0 0-4 0"}],["path",{"d":"m19 11-2.11-6.657a2 2 0 0 0-2.752-1.148l-1.276.61A2 2 0 0 1 12 4H8.5a2 2 0 0 0-1.925 1.456L5 11"}],["path",{"d":"M2 11h20"}],["circle",{"cx":"17","cy":"18","r":"3"}],["circle",{"cx":"7","cy":"18","r":"3"}]],"haze":[["path",{"d":"m5.2 6.2 1.4 1.4"}],["path",{"d":"M2 13h2"}],["path",{"d":"M20 13h2"}],["path",{"d":"m17.4 7.6 1.4-1.4"}],["path",{"d":"M22 17H2"}],["path",{"d":"M22 21H2"}],["path",{"d":"M16 13a4 4 0 0 0-8 0"}],["path",{"d":"M12 5V2.5"}]],"hd":[["path",{"d":"M10 12H6"}],["path",{"d":"M10 15V9"}],["path",{"d":"M14 14.5a.5.5 0 0 0 .5.5h1a2.5 2.5 0 0 0 2.5-2.5v-1A2.5 2.5 0 0 0 15.5 9h-1a.5.5 0 0 0-.5.5z"}],["path",{"d":"M6 15V9"}],["rect",{"x":"2","y":"5","width":"20","height":"14","rx":"2"}]],"hdmi-port":[["path",{"d":"M22 9a1 1 0 00-1-1H3a1 1 0 00-1 1v4a1 1 0 001 1h.5a2 2 0 011.6.8l.3.4A2 2 0 007 16h10a2 2 0 001.6-.8l.3-.4a2 2 0 011.6-.8h.5a1 1 0 001-1z"}],["path",{"d":"M8 12h8"}]],"heading-1":[["path",{"d":"M4 12h8"}],["path",{"d":"M4 18V6"}],["path",{"d":"M12 18V6"}],["path",{"d":"m17 12 3-2v8"}]],"heading-2":[["path",{"d":"M4 12h8"}],["path",{"d":"M4 18V6"}],["path",{"d":"M12 18V6"}],["path",{"d":"M21 18h-4c0-4 4-3 4-6 0-1.5-2-2.5-4-1"}]],"heading-3":[["path",{"d":"M4 12h8"}],["path",{"d":"M4 18V6"}],["path",{"d":"M12 18V6"}],["path",{"d":"M17.5 10.5c1.7-1 3.5 0 3.5 1.5a2 2 0 0 1-2 2"}],["path",{"d":"M17 17.5c2 1.5 4 .3 4-1.5a2 2 0 0 0-2-2"}]],"heading-4":[["path",{"d":"M12 18V6"}],["path",{"d":"M17 10v3a1 1 0 0 0 1 1h3"}],["path",{"d":"M21 10v8"}],["path",{"d":"M4 12h8"}],["path",{"d":"M4 18V6"}]],"heading-5":[["path",{"d":"M4 12h8"}],["path",{"d":"M4 18V6"}],["path",{"d":"M12 18V6"}],["path",{"d":"M17 13v-3h4"}],["path",{"d":"M17 17.7c.4.2.8.3 1.3.3 1.5 0 2.7-1.1 2.7-2.5S19.8 13 18.3 13H17"}]],"heading-6":[["path",{"d":"M4 12h8"}],["path",{"d":"M4 18V6"}],["path",{"d":"M12 18V6"}],["circle",{"cx":"19","cy":"16","r":"2"}],["path",{"d":"M20 10c-2 2-3 3.5-3 6"}]],"heading":[["path",{"d":"M6 12h12"}],["path",{"d":"M6 20V4"}],["path",{"d":"M18 20V4"}]],"headphone-off":[["path",{"d":"M21 14h-1.343"}],["path",{"d":"M9.128 3.47A9 9 0 0 1 21 12v3.343"}],["path",{"d":"m2 2 20 20"}],["path",{"d":"M20.414 20.414A2 2 0 0 1 19 21h-1a2 2 0 0 1-2-2v-3"}],["path",{"d":"M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 2.636-6.364"}]],"headphones":[["path",{"d":"M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"}]],"headset":[["path",{"d":"M3 11h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5Zm0 0a9 9 0 1 1 18 0m0 0v5a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3Z"}],["path",{"d":"M21 16v2a4 4 0 0 1-4 4h-5"}]],"heart-crack":[["path",{"d":"M12.409 5.824c-.702.792-1.15 1.496-1.415 2.166l2.153 2.156a.5.5 0 0 1 0 .707l-2.293 2.293a.5.5 0 0 0 0 .707L12 15"}],["path",{"d":"M13.508 20.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5a5.5 5.5 0 0 1 9.591-3.677.6.6 0 0 0 .818.001A5.5 5.5 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5z"}]],"heart-handshake":[["path",{"d":"M19.414 14.414C21 12.828 22 11.5 22 9.5a5.5 5.5 0 0 0-9.591-3.676.6.6 0 0 1-.818.001A5.5 5.5 0 0 0 2 9.5c0 2.3 1.5 4 3 5.5l5.535 5.362a2 2 0 0 0 2.879.052 2.12 2.12 0 0 0-.004-3 2.124 2.124 0 1 0 3-3 2.124 2.124 0 0 0 3.004 0 2 2 0 0 0 0-2.828l-1.881-1.882a2.41 2.41 0 0 0-3.409 0l-1.71 1.71a2 2 0 0 1-2.828 0 2 2 0 0 1 0-2.828l2.823-2.762"}]],"heart-minus":[["path",{"d":"m14.876 18.99-1.368 1.323a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5a5.2 5.2 0 0 1-.244 1.572"}],["path",{"d":"M15 15h6"}]],"heart-off":[["path",{"d":"M10.5 4.893a5.5 5.5 0 0 1 1.091.931.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 1.872-1.002 3.356-2.187 4.655"}],["path",{"d":"m16.967 16.967-3.459 3.346a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5a5.5 5.5 0 0 1 2.747-4.761"}],["path",{"d":"m2 2 20 20"}]],"heart-plus":[["path",{"d":"m14.479 19.374-.971.939a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5a5.2 5.2 0 0 1-.219 1.49"}],["path",{"d":"M15 15h6"}],["path",{"d":"M18 12v6"}]],"heart-pulse":[["path",{"d":"M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5"}],["path",{"d":"M3.22 13H9.5l.5-1 2 4.5 2-7 1.5 3.5h5.27"}]],"heart-x":[["path",{"d":"m15.5 12.5 5 5"}],["path",{"d":"m20.5 12.5-5 5"}],["path",{"d":"M21.955 8.774a5.5 5.5 0 0 0-9.546-2.95.6.6 0 0 1-.818 0A5.5 5.5 0 0 0 2 9.5c0 2.3 1.5 4 3 5.5l5.508 5.332a2 2 0 0 0 2.57.352"}]],"heart":[["path",{"d":"M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5"}]],"heater":[["path",{"d":"M11 8c2-3-2-3 0-6"}],["path",{"d":"M15.5 8c2-3-2-3 0-6"}],["path",{"d":"M6 10h.01"}],["path",{"d":"M6 14h.01"}],["path",{"d":"M10 16v-4"}],["path",{"d":"M14 16v-4"}],["path",{"d":"M18 16v-4"}],["path",{"d":"M20 6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3"}],["path",{"d":"M5 20v2"}],["path",{"d":"M19 20v2"}]],"helicopter":[["path",{"d":"M11 17v4"}],["path",{"d":"M14 3v8a2 2 0 0 0 2 2h5.865"}],["path",{"d":"M17 17v4"}],["path",{"d":"M18 17a4 4 0 0 0 4-4 8 6 0 0 0-8-6 6 5 0 0 0-6 5v3a2 2 0 0 0 2 2z"}],["path",{"d":"M2 10v5"}],["path",{"d":"M6 3h16"}],["path",{"d":"M7 21h14"}],["path",{"d":"M8 13H2"}]],"hexagon":[["path",{"d":"M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"}]],"highlighter":[["path",{"d":"m9 11-6 6v3h9l3-3"}],["path",{"d":"m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"}]],"hop-off":[["path",{"d":"M10.82 16.12c1.69.6 3.91.79 5.18.85.28.01.53-.09.7-.27"}],["path",{"d":"M11.14 20.57c.52.24 2.44 1.12 4.08 1.37.46.06.86-.25.9-.71.12-1.52-.3-3.43-.5-4.28"}],["path",{"d":"M16.13 21.05c1.65.63 3.68.84 4.87.91a.9.9 0 0 0 .7-.26"}],["path",{"d":"M17.99 5.52a20.83 20.83 0 0 1 3.15 4.5.8.8 0 0 1-.68 1.13c-1.17.1-2.5.02-3.9-.25"}],["path",{"d":"M20.57 11.14c.24.52 1.12 2.44 1.37 4.08.04.3-.08.59-.31.75"}],["path",{"d":"M4.93 4.93a10 10 0 0 0-.67 13.4c.35.43.96.4 1.17-.12.69-1.71 1.07-5.07 1.07-6.71 1.34.45 3.1.9 4.88.62a.85.85 0 0 0 .48-.24"}],["path",{"d":"M5.52 17.99c1.05.95 2.91 2.42 4.5 3.15a.8.8 0 0 0 1.13-.68c.2-2.34-.33-5.3-1.57-8.28"}],["path",{"d":"M8.35 2.68a10 10 0 0 1 9.98 1.58c.43.35.4.96-.12 1.17-1.5.6-4.3.98-6.07 1.05"}],["path",{"d":"m2 2 20 20"}]],"hop":[["path",{"d":"M10.82 16.12c1.69.6 3.91.79 5.18.85.55.03 1-.42.97-.97-.06-1.27-.26-3.5-.85-5.18"}],["path",{"d":"M11.5 6.5c1.64 0 5-.38 6.71-1.07.52-.2.55-.82.12-1.17A10 10 0 0 0 4.26 18.33c.35.43.96.4 1.17-.12.69-1.71 1.07-5.07 1.07-6.71 1.34.45 3.1.9 4.88.62a.88.88 0 0 0 .73-.74c.3-2.14-.15-3.5-.61-4.88"}],["path",{"d":"M15.62 16.95c.2.85.62 2.76.5 4.28a.77.77 0 0 1-.9.7 16.64 16.64 0 0 1-4.08-1.36"}],["path",{"d":"M16.13 21.05c1.65.63 3.68.84 4.87.91a.9.9 0 0 0 .96-.96 17.68 17.68 0 0 0-.9-4.87"}],["path",{"d":"M16.94 15.62c.86.2 2.77.62 4.29.5a.77.77 0 0 0 .7-.9 16.64 16.64 0 0 0-1.36-4.08"}],["path",{"d":"M17.99 5.52a20.82 20.82 0 0 1 3.15 4.5.8.8 0 0 1-.68 1.13c-2.33.2-5.3-.32-8.27-1.57"}],["path",{"d":"M4.93 4.93 3 3a.7.7 0 0 1 0-1"}],["path",{"d":"M9.58 12.18c1.24 2.98 1.77 5.95 1.57 8.28a.8.8 0 0 1-1.13.68 20.82 20.82 0 0 1-4.5-3.15"}]],"hospital":[["path",{"d":"M12 7v4"}],["path",{"d":"M14 21v-3a2 2 0 0 0-4 0v3"}],["path",{"d":"M14 9h-4"}],["path",{"d":"M18 11h2a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h2"}],["path",{"d":"M18 21V5a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16"}]],"hotel":[["path",{"d":"M10 22v-6.57"}],["path",{"d":"M12 11h.01"}],["path",{"d":"M12 7h.01"}],["path",{"d":"M14 15.43V22"}],["path",{"d":"M15 16a5 5 0 0 0-6 0"}],["path",{"d":"M16 11h.01"}],["path",{"d":"M16 7h.01"}],["path",{"d":"M8 11h.01"}],["path",{"d":"M8 7h.01"}],["rect",{"x":"4","y":"2","width":"16","height":"20","rx":"2"}]],"hourglass-cog":[["path",{"d":"m14.305 19.53.923-.382"}],["path",{"d":"m15.228 16.852-.923-.383"}],["path",{"d":"m16.852 15.228-.383-.923"}],["path",{"d":"m16.852 20.772-.383.924"}],["path",{"d":"M17 2v4.172a2 2 0 0 1-.586 1.414l-8.828 8.828A2 2 0 0 0 7 17.828V22"}],["path",{"d":"m19.148 15.228.383-.923"}],["path",{"d":"m19.53 21.696-.382-.924"}],["path",{"d":"m20.772 16.852.924-.383"}],["path",{"d":"m20.772 19.148.924.383"}],["path",{"d":"M5 22h6.159"}],["path",{"d":"M5 2h14"}],["path",{"d":"M7 2v4.172a2 2 0 0 0 .586 1.414l5.188 5.188"}],["circle",{"cx":"18","cy":"18","r":"3"}]],"hourglass":[["path",{"d":"M5 22h14"}],["path",{"d":"M5 2h14"}],["path",{"d":"M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"}],["path",{"d":"M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"}]],"house-cog":[["path",{"d":"M10.584 21H5a2 2 0 01-2-2v-9a2 2 0 01.709-1.527l7-6a2 2 0 012.582 0l7 6A2 2 0 0121 10.001v.583"}],["path",{"d":"M14 12H10a1 1 0 00-1 1v8"}],["path",{"d":"m14.305 19.53.923-.382"}],["path",{"d":"m15.229 16.852-.924-.383"}],["path",{"d":"m16.852 15.228-.383-.923"}],["path",{"d":"m16.852 20.773-.383.924"}],["path",{"d":"m19.148 15.228.383-.923"}],["path",{"d":"m19.53 21.697-.382-.924"}],["path",{"d":"m20.773 16.852.922-.383"}],["path",{"d":"m20.773 19.148.922.383"}],["circle",{"cx":"18","cy":"18","r":"3"}]],"house-heart":[["path",{"d":"M8.62 13.8A2.25 2.25 0 1 1 12 10.836a2.25 2.25 0 1 1 3.38 2.966l-2.626 2.856a.998.998 0 0 1-1.507 0z"}],["path",{"d":"M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"}]],"house-plug":[["path",{"d":"M10 12V8.964"}],["path",{"d":"M14 12V8.964"}],["path",{"d":"M15 12a1 1 0 0 1 1 1v2a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-2a1 1 0 0 1 1-1z"}],["path",{"d":"M8.5 21H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2h-5a2 2 0 0 1-2-2v-2"}]],"house-plus":[["path",{"d":"M12.35 21H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 .71-1.53l7-6a2 2 0 0 1 2.58 0l7 6A2 2 0 0 1 21 10v2.35"}],["path",{"d":"M14.8 12.4A1 1 0 0 0 14 12h-4a1 1 0 0 0-1 1v8"}],["path",{"d":"M15 18h6"}],["path",{"d":"M18 15v6"}]],"house-wifi":[["path",{"d":"M9.5 13.866a4 4 0 0 1 5 .01"}],["path",{"d":"M12 17h.01"}],["path",{"d":"M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"}],["path",{"d":"M7 10.754a8 8 0 0 1 10 0"}]],"house":[["path",{"d":"M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"}],["path",{"d":"M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"}]],"houses":[["path",{"d":"m12.681 4.24.834-.715a1.45 1.45 0 011.88 0l5.09 4.364A1.45 1.45 0 0121 9v6.546a1.45 1.45 0 01-1 1.381"}],["path",{"d":"M15.485 11.889A1.45 1.45 0 0116 13v6.546A1.454 1.454 0 0114.546 21H4.364a1.454 1.454 0 01-1.454-1.454V13a1.45 1.45 0 01.515-1.111l5.09-4.364a1.45 1.45 0 011.88 0z"}],["path",{"d":"M7.41 20.546v-4a1 1 0 011-1h2a1 1 0 011 1v4"}]],"ice-cream-bowl":[["path",{"d":"M12 17c5 0 8-2.69 8-6H4c0 3.31 3 6 8 6m-4 4h8m-4-3v3M5.14 11a3.5 3.5 0 1 1 6.71 0"}],["path",{"d":"M12.14 11a3.5 3.5 0 1 1 6.71 0"}],["path",{"d":"M15.5 6.5a3.5 3.5 0 1 0-7 0"}]],"ice-cream-cone":[["path",{"d":"m7 11 4.08 10.35a1 1 0 0 0 1.84 0L17 11"}],["path",{"d":"M17 7A5 5 0 0 0 7 7"}],["path",{"d":"M17 7a2 2 0 0 1 0 4H7a2 2 0 0 1 0-4"}]],"id-card-lanyard":[["path",{"d":"M13.5 8h-3"}],["path",{"d":"m15 2-1 2h3a2 2 0 012 2v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6a2 2 0 012-2h3"}],["path",{"d":"M16 22a4 4 0 00-8 0"}],["path",{"d":"m9 2 3 6"}],["circle",{"cx":"12","cy":"15","r":"3"}]],"id-card":[["path",{"d":"M13 19a4 4 0 00-8 0"}],["path",{"d":"M16 10h2"}],["path",{"d":"M16 14h2"}],["circle",{"cx":"9","cy":"12","r":"3"}],["rect",{"x":"2","y":"5","width":"20","height":"14","rx":"2"}]],"image-down":[["path",{"d":"M10.3 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10l-3.1-3.1a2 2 0 0 0-2.814.014L6 21"}],["path",{"d":"m14 19 3 3v-5.5"}],["path",{"d":"m17 22 3-3"}],["circle",{"cx":"9","cy":"9","r":"2"}]],"image-minus":[["path",{"d":"M21 9v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7"}],["line",{"x1":"16","x2":"22","y1":"5","y2":"5"}],["circle",{"cx":"9","cy":"9","r":"2"}],["path",{"d":"m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"}]],"image-off":[["line",{"x1":"2","x2":"22","y1":"2","y2":"22"}],["path",{"d":"M10.41 10.41a2 2 0 1 1-2.83-2.83"}],["line",{"x1":"13.5","x2":"6","y1":"13.5","y2":"21"}],["line",{"x1":"18","x2":"21","y1":"12","y2":"15"}],["path",{"d":"M3.59 3.59A1.99 1.99 0 0 0 3 5v14a2 2 0 0 0 2 2h14c.55 0 1.052-.22 1.41-.59"}],["path",{"d":"M21 15V5a2 2 0 0 0-2-2H9"}]],"image-play":[["path",{"d":"M15 15.003a1 1 0 0 1 1.517-.859l4.997 2.997a1 1 0 0 1 0 1.718l-4.997 2.997a1 1 0 0 1-1.517-.86z"}],["path",{"d":"M21 12.17V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h6"}],["path",{"d":"m6 21 5-5"}],["circle",{"cx":"9","cy":"9","r":"2"}]],"image-plus":[["path",{"d":"M16 5h6"}],["path",{"d":"M19 2v6"}],["path",{"d":"M21 11.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7.5"}],["path",{"d":"m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"}],["circle",{"cx":"9","cy":"9","r":"2"}]],"image-up":[["path",{"d":"M10.3 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10l-3.1-3.1a2 2 0 0 0-2.814.014L6 21"}],["path",{"d":"m14 19.5 3-3 3 3"}],["path",{"d":"M17 22v-5.5"}],["circle",{"cx":"9","cy":"9","r":"2"}]],"image-upscale":[["path",{"d":"M16 3h5v5"}],["path",{"d":"M17 21h2a2 2 0 0 0 2-2"}],["path",{"d":"M21 12v3"}],["path",{"d":"m21 3-5 5"}],["path",{"d":"M3 7V5a2 2 0 0 1 2-2"}],["path",{"d":"m5 21 4.144-4.144a1.21 1.21 0 0 1 1.712 0L13 19"}],["path",{"d":"M9 3h3"}],["rect",{"x":"3","y":"11","width":"10","height":"10","rx":"1"}]],"image":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2","ry":"2"}],["circle",{"cx":"9","cy":"9","r":"2"}],["path",{"d":"m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"}]],"images":[["path",{"d":"m22 11-1.296-1.296a2.4 2.4 0 0 0-3.408 0L11 16"}],["path",{"d":"M4 8a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2"}],["circle",{"cx":"13","cy":"7","r":"1","fill":"currentColor"}],["rect",{"x":"8","y":"2","width":"14","height":"14","rx":"2"}]],"import":[["path",{"d":"M12 3v12"}],["path",{"d":"m8 11 4 4 4-4"}],["path",{"d":"M8 5H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-4"}]],"inbox":[["polyline",{"points":"22 12 16 12 14 15 10 15 8 12 2 12"}],["path",{"d":"M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"}]],"indian-rupee":[["path",{"d":"M6 3h12"}],["path",{"d":"M6 8h12"}],["path",{"d":"m6 13 8.5 8"}],["path",{"d":"M6 13h3"}],["path",{"d":"M9 13c6.667 0 6.667-10 0-10"}]],"infinity":[["path",{"d":"M6 16c5 0 7-8 12-8a4 4 0 0 1 0 8c-5 0-7-8-12-8a4 4 0 1 0 0 8"}]],"info":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M12 16v-4"}],["path",{"d":"M12 8h.01"}]],"inspection-panel":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M7 7h.01"}],["path",{"d":"M17 7h.01"}],["path",{"d":"M7 17h.01"}],["path",{"d":"M17 17h.01"}]],"italic":[["line",{"x1":"19","x2":"10","y1":"4","y2":"4"}],["line",{"x1":"14","x2":"5","y1":"20","y2":"20"}],["line",{"x1":"15","x2":"9","y1":"4","y2":"20"}]],"iteration-ccw":[["path",{"d":"m16 14 4 4-4 4"}],["path",{"d":"M20 10a8 8 0 1 0-8 8h8"}]],"iteration-cw":[["path",{"d":"M4 10a8 8 0 1 1 8 8H4"}],["path",{"d":"m8 22-4-4 4-4"}]],"iv-bag":[["path",{"d":"M12 18v2a2 2 0 002 2h6"}],["path",{"d":"M6 11c.72.5 1.44 1 3 1 3 0 3-2 6-2 1.56 0 2.28.5 3 1"}],["path",{"d":"M9.293 3c.453 0 .887-.18 1.207-.5s.754-.5 1.207-.5h.586c.453 0 .887.18 1.207.5s.754.5 1.207.5H16a2 2 0 012 2v11a2 2 0 01-2 2H8a2 2 0 01-2-2V5a2 2 0 012-2z"}]],"japanese-yen":[["path",{"d":"M12 9.5V21m0-11.5L6 3m6 6.5L18 3"}],["path",{"d":"M6 15h12"}],["path",{"d":"M6 11h12"}]],"joystick":[["path",{"d":"M21 17a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2Z"}],["path",{"d":"M6 15v-2"}],["path",{"d":"M12 15V9"}],["circle",{"cx":"12","cy":"6","r":"3"}]],"kanban":[["path",{"d":"M5 3v14"}],["path",{"d":"M12 3v8"}],["path",{"d":"M19 3v18"}]],"kayak":[["path",{"d":"M18 17a1 1 0 0 0-1 1v1a2 2 0 1 0 2-2z"}],["path",{"d":"M20.97 3.61a.45.45 0 0 0-.58-.58C10.2 6.6 6.6 10.2 3.03 20.39a.45.45 0 0 0 .58.58C13.8 17.4 17.4 13.8 20.97 3.61"}],["path",{"d":"m6.707 6.707 10.586 10.586"}],["path",{"d":"M7 5a2 2 0 1 0-2 2h1a1 1 0 0 0 1-1z"}]],"key-round":[["path",{"d":"M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"}],["circle",{"cx":"16.5","cy":"7.5","r":".5","fill":"currentColor"}]],"key-square":[["path",{"d":"M12.4 2.7a2.5 2.5 0 0 1 3.4 0l5.5 5.5a2.5 2.5 0 0 1 0 3.4l-3.7 3.7a2.5 2.5 0 0 1-3.4 0L8.7 9.8a2.5 2.5 0 0 1 0-3.4z"}],["path",{"d":"m14 7 3 3"}],["path",{"d":"m9.4 10.6-6.814 6.814A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814"}]],"key":[["path",{"d":"m2 21 9.6-9.6"}],["path",{"d":"m7.5 15.5 2.3 2.3a1 1 0 0 1 0 1.4l-2.1 2.1a1 1 0 0 1-1.4 0L4 19"}],["circle",{"cx":"15.5","cy":"7.5","r":"5.5"}]],"keyboard-music":[["rect",{"width":"20","height":"16","x":"2","y":"4","rx":"2"}],["path",{"d":"M6 8h4"}],["path",{"d":"M14 8h.01"}],["path",{"d":"M18 8h.01"}],["path",{"d":"M2 12h20"}],["path",{"d":"M6 12v4"}],["path",{"d":"M10 12v4"}],["path",{"d":"M14 12v4"}],["path",{"d":"M18 12v4"}]],"keyboard-off":[["path",{"d":"M 20 4 A2 2 0 0 1 22 6"}],["path",{"d":"M 22 6 L 22 16.41"}],["path",{"d":"M 7 16 L 16 16"}],["path",{"d":"M 9.69 4 L 20 4"}],["path",{"d":"M14 8h.01"}],["path",{"d":"M18 8h.01"}],["path",{"d":"m2 2 20 20"}],["path",{"d":"M20 20H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2"}],["path",{"d":"M6 8h.01"}],["path",{"d":"M8 12h.01"}]],"keyboard":[["path",{"d":"M10 8h.01"}],["path",{"d":"M12 12h.01"}],["path",{"d":"M14 8h.01"}],["path",{"d":"M16 12h.01"}],["path",{"d":"M18 8h.01"}],["path",{"d":"M6 8h.01"}],["path",{"d":"M7 16h10"}],["path",{"d":"M8 12h.01"}],["rect",{"width":"20","height":"16","x":"2","y":"4","rx":"2"}]],"lambda":[["path",{"d":"M11.38 10 5 20"}],["path",{"d":"M19 18a2 2 0 01-2 2c-4.87-.003-5.052-16-10-16a2 2 0 00-2 2"}]],"lamp-ceiling":[["path",{"d":"M12 2v5"}],["path",{"d":"M14.829 15.998a3 3 0 1 1-5.658 0"}],["path",{"d":"M20.92 14.606A1 1 0 0 1 20 16H4a1 1 0 0 1-.92-1.394l3-7A1 1 0 0 1 7 7h10a1 1 0 0 1 .92.606z"}]],"lamp-desk":[["path",{"d":"M10.293 2.293a1 1 0 0 1 1.414 0l2.5 2.5 5.994 1.227a1 1 0 0 1 .506 1.687l-7 7a1 1 0 0 1-1.687-.506l-1.227-5.994-2.5-2.5a1 1 0 0 1 0-1.414z"}],["path",{"d":"m14.207 4.793-3.414 3.414"}],["path",{"d":"M3 20a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v1a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"}],["path",{"d":"m9.086 6.5-4.793 4.793a1 1 0 0 0-.18 1.17L7 18"}]],"lamp-floor":[["path",{"d":"M12 10v12"}],["path",{"d":"M17.929 7.629A1 1 0 0 1 17 9H7a1 1 0 0 1-.928-1.371l2-5A1 1 0 0 1 9 2h6a1 1 0 0 1 .928.629z"}],["path",{"d":"M9 22h6"}]],"lamp-wall-down":[["path",{"d":"M19.929 18.629A1 1 0 0 1 19 20H9a1 1 0 0 1-.928-1.371l2-5A1 1 0 0 1 11 13h6a1 1 0 0 1 .928.629z"}],["path",{"d":"M6 3a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"}],["path",{"d":"M8 6h4a2 2 0 0 1 2 2v5"}]],"lamp-wall-up":[["path",{"d":"M19.929 9.629A1 1 0 0 1 19 11H9a1 1 0 0 1-.928-1.371l2-5A1 1 0 0 1 11 4h6a1 1 0 0 1 .928.629z"}],["path",{"d":"M6 15a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2H5a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1z"}],["path",{"d":"M8 18h4a2 2 0 0 0 2-2v-5"}]],"lamp":[["path",{"d":"M12 12v6"}],["path",{"d":"M4.077 10.615A1 1 0 0 0 5 12h14a1 1 0 0 0 .923-1.385l-3.077-7.384A2 2 0 0 0 15 2H9a2 2 0 0 0-1.846 1.23Z"}],["path",{"d":"M8 20a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v1a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1z"}]],"land-plot":[["path",{"d":"m12 8 6-3-6-3v10"}],["path",{"d":"m8 11.99-5.5 3.14a1 1 0 0 0 0 1.74l8.5 4.86a2 2 0 0 0 2 0l8.5-4.86a1 1 0 0 0 0-1.74L16 12"}],["path",{"d":"m6.49 12.85 11.02 6.3"}],["path",{"d":"M17.51 12.85 6.5 19.15"}]],"landmark":[["path",{"d":"M10 18v-7"}],["path",{"d":"M11.119 2.205a2 2 0 0 1 1.762 0l7.84 3.846A.5.5 0 0 1 20.5 7h-17a.5.5 0 0 1-.22-.949z"}],["path",{"d":"M14 18v-7"}],["path",{"d":"M18 18v-7"}],["path",{"d":"M3 22h18"}],["path",{"d":"M6 18v-7"}]],"languages":[["path",{"d":"m5 8 6 6"}],["path",{"d":"m4 14 6-6 2-3"}],["path",{"d":"M2 5h12"}],["path",{"d":"M7 2h1"}],["path",{"d":"m22 22-5-10-5 10"}],["path",{"d":"M14 18h6"}]],"laptop-minimal-check":[["path",{"d":"M2 20h20"}],["path",{"d":"m9 10 2 2 4-4"}],["rect",{"x":"3","y":"4","width":"18","height":"12","rx":"2"}]],"laptop-minimal":[["rect",{"width":"18","height":"12","x":"3","y":"4","rx":"2","ry":"2"}],["line",{"x1":"2","x2":"22","y1":"20","y2":"20"}]],"laptop":[["path",{"d":"M18 5a2 2 0 0 1 2 2v8.526a2 2 0 0 0 .212.897l1.068 2.127a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45l1.068-2.127A2 2 0 0 0 4 15.526V7a2 2 0 0 1 2-2z"}],["path",{"d":"M20.054 15.987H3.946"}]],"lasso-select":[["path",{"d":"M7 22a5 5 0 0 1-2-4"}],["path",{"d":"M7 16.93c.96.43 1.96.74 2.99.91"}],["path",{"d":"M3.34 14A6.8 6.8 0 0 1 2 10c0-4.42 4.48-8 10-8s10 3.58 10 8a7.19 7.19 0 0 1-.33 2"}],["path",{"d":"M5 18a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"}],["path",{"d":"M14.33 22h-.09a.35.35 0 0 1-.24-.32v-10a.34.34 0 0 1 .33-.34c.08 0 .15.03.21.08l7.34 6a.33.33 0 0 1-.21.59h-4.49l-2.57 3.85a.35.35 0 0 1-.28.14z"}]],"lasso":[["path",{"d":"M3.704 14.467a10 8 0 1 1 3.115 2.375"}],["path",{"d":"M7 22a5 5 0 0 1-2-3.994"}],["circle",{"cx":"5","cy":"16","r":"2"}]],"layer-arrow-down":[["path",{"d":"M12 10v10"}],["path",{"d":"M22 10a1 1 0 01-.59.92l-5.077 2.308"}],["path",{"d":"M22.017 10.005a1 1 0 00-.597-.916l-8.59-3.91a2 2 0 00-1.66.001L2.6 9.08a1 1 0 00-.02 1.831l5.093 2.316"}],["path",{"d":"m9 17 3 3 3-3"}]],"layer-arrow-up":[["path",{"d":"M12 14V4"}],["path",{"d":"M7.674 10.774 2.58 13.09a1 1 0 000 1.822l8.6 3.91a2 2 0 001.65 0l8.58-3.9a1 1 0 00.59-.92 1 1 0 00-.59-.922l-5.078-2.308"}],["path",{"d":"m9 7 3-3 3 3"}]],"layers-2":[["path",{"d":"M13 13.74a2 2 0 0 1-2 0L2.5 8.87a1 1 0 0 1 0-1.74L11 2.26a2 2 0 0 1 2 0l8.5 4.87a1 1 0 0 1 0 1.74z"}],["path",{"d":"m20 14.285 1.5.845a1 1 0 0 1 0 1.74L13 21.74a2 2 0 0 1-2 0l-8.5-4.87a1 1 0 0 1 0-1.74l1.5-.845"}]],"layers-arrow-down":[["path",{"d":"M12 7v15"}],["path",{"d":"M2 12a1 1 0 00.58.91l5.093 2.316"}],["path",{"d":"M22 12a1 1 0 01-.59.92l-5.077 2.308"}],["path",{"d":"M8 10.37 2.6 7.91a1 1 0 010-1.831l8.57-3.9a2 2 0 011.66.001l8.59 3.91a1 1 0 010 1.831l-5.392 2.45"}],["path",{"d":"m9 19 3 3 3-3"}]],"layers-arrow-up":[["path",{"d":"M12 12V2"}],["path",{"d":"M2 17.002a1 1 0 00.58.91l8.6 3.91a2 2 0 001.65 0l8.58-3.9a1 1 0 00.59-.92"}],["path",{"d":"M7.674 8.774 2.58 11.09a1 1 0 000 1.822l8.6 3.91a2 2 0 001.65 0l8.58-3.9a1 1 0 00.59-.92 1 1 0 00-.59-.922l-5.078-2.308"}],["path",{"d":"m9 5 3-3 3 3"}]],"layers-minus":[["path",{"d":"M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 .83.18 2 2 0 0 0 .83-.18l8.58-3.9a1 1 0 0 0 0-1.832z"}],["path",{"d":"M16 17h6"}],["path",{"d":"M2.003 11.995a1 1 0 0 0 .597.915l8.58 3.91a2 2 0 0 0 .83.18"}],["path",{"d":"M2.003 16.995a1 1 0 0 0 .597.915l8.58 3.91a2 2 0 0 0 .83.18 2 2 0 0 0 .83-.18l2.11-.96"}],["path",{"d":"M22.018 12.004a1 1 0 0 1-.598.916l-.177.08"}]],"layers-plus":[["path",{"d":"M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 .83.18 2 2 0 0 0 .83-.18l8.58-3.9a1 1 0 0 0 0-1.831z"}],["path",{"d":"M16 17h6"}],["path",{"d":"M19 14v6"}],["path",{"d":"M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 .825.178"}],["path",{"d":"M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l2.116-.962"}]],"layers":[["path",{"d":"M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"}],["path",{"d":"M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"}],["path",{"d":"M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"}]],"layout-arrow-down":[["rect",{"width":"7","height":"7","x":"3","y":"3","rx":"1"}],["rect",{"width":"7","height":"7","x":"3","y":"14","rx":"1"}],["path",{"d":"M18 3v18"}],["path",{"d":"m21 18-3 3-3-3"}]],"layout-arrow-right":[["rect",{"width":"7","height":"7","x":"3","y":"3","rx":"1"}],["rect",{"width":"7","height":"7","x":"14","y":"3","rx":"1"}],["path",{"d":"M3 18h18"}],["path",{"d":"m18 21 3-3-3-3"}]],"layout-dashboard":[["rect",{"width":"7","height":"9","x":"3","y":"3","rx":"1"}],["rect",{"width":"7","height":"5","x":"14","y":"3","rx":"1"}],["rect",{"width":"7","height":"9","x":"14","y":"12","rx":"1"}],["rect",{"width":"7","height":"5","x":"3","y":"16","rx":"1"}]],"layout-freeform":[["rect",{"width":"7","height":"7","x":"3","y":"3","rx":"1"}],["rect",{"width":"7","height":"7","x":"14","y":"4","rx":"1"}],["rect",{"width":"7","height":"7","x":"4","y":"14","rx":"1"}]],"layout-grid-circles":[["circle",{"cx":"17.5","cy":"17.5","r":"3.5"}],["circle",{"cx":"17.5","cy":"6.5","r":"3.5"}],["circle",{"cx":"6.5","cy":"17.5","r":"3.5"}],["circle",{"cx":"6.5","cy":"6.5","r":"3.5"}]],"layout-grid":[["rect",{"width":"7","height":"7","x":"3","y":"3","rx":"1"}],["rect",{"width":"7","height":"7","x":"14","y":"3","rx":"1"}],["rect",{"width":"7","height":"7","x":"14","y":"14","rx":"1"}],["rect",{"width":"7","height":"7","x":"3","y":"14","rx":"1"}]],"layout-list":[["rect",{"width":"7","height":"7","x":"3","y":"3","rx":"1"}],["rect",{"width":"7","height":"7","x":"3","y":"14","rx":"1"}],["path",{"d":"M14 4h7"}],["path",{"d":"M14 9h7"}],["path",{"d":"M14 15h7"}],["path",{"d":"M14 20h7"}]],"layout-panel-left":[["rect",{"width":"7","height":"18","x":"3","y":"3","rx":"1"}],["rect",{"width":"7","height":"7","x":"14","y":"3","rx":"1"}],["rect",{"width":"7","height":"7","x":"14","y":"14","rx":"1"}]],"layout-panel-top":[["rect",{"width":"18","height":"7","x":"3","y":"3","rx":"1"}],["rect",{"width":"7","height":"7","x":"3","y":"14","rx":"1"}],["rect",{"width":"7","height":"7","x":"14","y":"14","rx":"1"}]],"layout-template":[["rect",{"width":"18","height":"7","x":"3","y":"3","rx":"1"}],["rect",{"width":"9","height":"7","x":"3","y":"14","rx":"1"}],["rect",{"width":"5","height":"7","x":"16","y":"14","rx":"1"}]],"leaf":[["path",{"d":"M11 20a10 10 0 0010-10 25.9 25.9 0 00-1.04-7.281 1 1 0 00-1.755-.325C15.833 5.5 13 5.5 9.8 6.1A7 7 0 0011 20"}],["path",{"d":"M2 21a5 5 0 012.911-4.544C7.613 15.212 8.351 15.24 11 13"}]],"leafy-green":[["path",{"d":"M2 22c1.25-.987 2.27-1.975 3.9-2.2a5.56 5.56 0 0 1 3.8 1.5 4 4 0 0 0 6.187-2.353 3.5 3.5 0 0 0 3.69-5.116A3.5 3.5 0 0 0 20.95 8 3.5 3.5 0 1 0 16 3.05a3.5 3.5 0 0 0-5.831 1.373 3.5 3.5 0 0 0-5.116 3.69 4 4 0 0 0-2.348 6.155C3.499 15.42 4.409 16.712 4.2 18.1 3.926 19.743 3.014 20.732 2 22"}],["path",{"d":"M2 22 17 7"}]],"lectern":[["path",{"d":"M15 13h4a2 2 0 001.901-1.38l1.057-4.333A1 1 0 0021 6H3a1 1 0 00-.958 1.287L3.1 11.621A2 2 0 005.001 13h4"}],["path",{"d":"M15 22V11a1 1 0 00-1-1h-4a1 1 0 00-1 1v11"}],["path",{"d":"M18 22H6"}],["path",{"d":"M18 6V3a1 1 0 00-1-1h-3"}]],"lens-concave":[["path",{"d":"M7 2a1 1 0 0 0-.8 1.6 14 14 0 0 1 0 16.8A1 1 0 0 0 7 22h10a1 1 0 0 0 .8-1.6 14 14 0 0 1 0-16.8A1 1 0 0 0 17 2z"}]],"lens-convex":[["path",{"d":"M13.433 2a1 1 0 0 1 .824.448 18 18 0 0 1 0 19.104 1 1 0 0 1-.824.448h-2.866a1 1 0 0 1-.824-.448 18 18 0 0 1 0-19.104A1 1 0 0 1 10.567 2z"}]],"letters":[["path",{"d":"M15 8H9"}],["path",{"d":"M21 15.354a4 4 0 100 5.292"}],["path",{"d":"M3 18h4a2 2 0 010 4H3.5a.5.5 0 01-.5-.5v-7a.5.5 0 01.5-.5H6a2 2 0 010 4"}],["path",{"d":"m8 10 3.453-7.648a.6.6 0 011.094 0L16 10"}]],"library-big":[["rect",{"width":"8","height":"18","x":"3","y":"3","rx":"1"}],["path",{"d":"M7 3v18"}],["path",{"d":"M20.4 18.9c.2.5-.1 1.1-.6 1.3l-1.9.7c-.5.2-1.1-.1-1.3-.6L11.1 5.1c-.2-.5.1-1.1.6-1.3l1.9-.7c.5-.2 1.1.1 1.3.6Z"}]],"library":[["path",{"d":"m16 6 4 14"}],["path",{"d":"M12 6v14"}],["path",{"d":"M8 8v12"}],["path",{"d":"M4 4v16"}]],"life-buoy":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"m4.93 4.93 4.24 4.24"}],["path",{"d":"m14.83 9.17 4.24-4.24"}],["path",{"d":"m14.83 14.83 4.24 4.24"}],["path",{"d":"m9.17 14.83-4.24 4.24"}],["circle",{"cx":"12","cy":"12","r":"4"}]],"ligature":[["path",{"d":"M14 12h2v8"}],["path",{"d":"M14 20h4"}],["path",{"d":"M6 12h4"}],["path",{"d":"M6 20h4"}],["path",{"d":"M8 20V8a4 4 0 0 1 7.464-2"}]],"lightbulb-off":[["path",{"d":"M16.8 11.2c.8-.9 1.2-2 1.2-3.2a6 6 0 0 0-9.3-5"}],["path",{"d":"m2 2 20 20"}],["path",{"d":"M6.3 6.3a4.67 4.67 0 0 0 1.2 5.2c.7.7 1.3 1.5 1.5 2.5"}],["path",{"d":"M9 18h6"}],["path",{"d":"M10 22h4"}]],"lightbulb":[["path",{"d":"M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"}],["path",{"d":"M9 18h6"}],["path",{"d":"M10 22h4"}]],"lighthouse":[["path",{"d":"M12 3V2"}],["path",{"d":"M16.066 16.865 7 22l2-11V6a3 3 0 016 0v5l2 11"}],["path",{"d":"m19.792 4.5.866-.5"}],["path",{"d":"m19.797 13.5.866.5"}],["path",{"d":"M21 9h1"}],["path",{"d":"M3 9H2"}],["path",{"d":"m4.203 13.5-.866.5"}],["path",{"d":"M4.208 4.5 3.342 4"}],["path",{"d":"M5.5 22h13"}],["path",{"d":"m7.932 16.875 7.377-4.178"}],["path",{"d":"M8 11h8"}],["path",{"d":"M8 7h8"}]],"line-dot-bottom-vertical":[["path",{"d":"M12 3v12"}],["circle",{"cx":"12","cy":"18","r":"3"}]],"line-dot-left-horizontal":[["path",{"d":"M9 12h12"}],["circle",{"cx":"6","cy":"12","r":"3"}]],"line-dot-right-horizontal":[["path",{"d":"M 3 12 L 15 12"}],["circle",{"cx":"18","cy":"12","r":"3"}]],"line-dot-top-vertical":[["path",{"d":"M12 9v12"}],["circle",{"cx":"12","cy":"6","r":"3"}]],"line-squiggle":[["path",{"d":"M7 3.5c5-2 7 2.5 3 4C1.5 10 2 15 5 16c5 2 9-10 14-7s.5 13.5-4 12c-5-2.5.5-11 6-2"}]],"line-style":[["path",{"d":"M11 5h2"}],["path",{"d":"M15 12h6"}],["path",{"d":"M19 5h2"}],["path",{"d":"M3 12h6"}],["path",{"d":"M3 19h18"}],["path",{"d":"M3 5h2"}]],"link-2-off":[["path",{"d":"M9 17H7A5 5 0 0 1 7 7"}],["path",{"d":"M15 7h2a5 5 0 0 1 4 8"}],["line",{"x1":"8","x2":"12","y1":"12","y2":"12"}],["line",{"x1":"2","x2":"22","y1":"2","y2":"22"}]],"link-2":[["path",{"d":"M9 17H7A5 5 0 0 1 7 7h2"}],["path",{"d":"M15 7h2a5 5 0 1 1 0 10h-2"}],["line",{"x1":"8","x2":"16","y1":"12","y2":"12"}]],"link":[["path",{"d":"M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"}],["path",{"d":"M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"}]],"list-check":[["path",{"d":"M16 5H3"}],["path",{"d":"M16 12H3"}],["path",{"d":"M11 19H3"}],["path",{"d":"m15 18 2 2 4-4"}]],"list-checks":[["path",{"d":"M13 5h8"}],["path",{"d":"M13 12h8"}],["path",{"d":"M13 19h8"}],["path",{"d":"m3 17 2 2 4-4"}],["path",{"d":"m3 7 2 2 4-4"}]],"list-chevrons-down-up":[["path",{"d":"M3 5h8"}],["path",{"d":"M3 12h8"}],["path",{"d":"M3 19h8"}],["path",{"d":"m15 5 3 3 3-3"}],["path",{"d":"m15 19 3-3 3 3"}]],"list-chevrons-up-down":[["path",{"d":"M3 5h8"}],["path",{"d":"M3 12h8"}],["path",{"d":"M3 19h8"}],["path",{"d":"m15 8 3-3 3 3"}],["path",{"d":"m15 16 3 3 3-3"}]],"list-clock":[["path",{"d":"M16 13v2.2l1.6 1"}],["path",{"d":"M3 12h3.458"}],["path",{"d":"M3 19h3.832"}],["path",{"d":"M3 5h18"}],["circle",{"cx":"16","cy":"15","r":"6"}]],"list-collapse":[["path",{"d":"M10 5h11"}],["path",{"d":"M10 12h11"}],["path",{"d":"M10 19h11"}],["path",{"d":"m3 10 3-3-3-3"}],["path",{"d":"m3 20 3-3-3-3"}]],"list-end":[["path",{"d":"M16 5H3"}],["path",{"d":"M16 12H3"}],["path",{"d":"M9 19H3"}],["path",{"d":"m16 16-3 3 3 3"}],["path",{"d":"M21 5v12a2 2 0 0 1-2 2h-6"}]],"list-filter-plus":[["path",{"d":"M12 5H2"}],["path",{"d":"M6 12h12"}],["path",{"d":"M9 19h6"}],["path",{"d":"M16 5h6"}],["path",{"d":"M19 8V2"}]],"list-filter":[["path",{"d":"M2 5h20"}],["path",{"d":"M6 12h12"}],["path",{"d":"M9 19h6"}]],"list-indent-decrease":[["path",{"d":"M21 5H11"}],["path",{"d":"M21 12H11"}],["path",{"d":"M21 19H11"}],["path",{"d":"m7 8-4 4 4 4"}]],"list-indent-increase":[["path",{"d":"M21 5H11"}],["path",{"d":"M21 12H11"}],["path",{"d":"M21 19H11"}],["path",{"d":"m3 8 4 4-4 4"}]],"list-minus":[["path",{"d":"M16 5H3"}],["path",{"d":"M11 12H3"}],["path",{"d":"M16 19H3"}],["path",{"d":"M21 12h-6"}]],"list-music":[["path",{"d":"M16 5H3"}],["path",{"d":"M11 12H3"}],["path",{"d":"M11 19H3"}],["path",{"d":"M21 16V5"}],["circle",{"cx":"18","cy":"16","r":"3"}]],"list-ordered":[["path",{"d":"M11 5h10"}],["path",{"d":"M11 12h10"}],["path",{"d":"M11 19h10"}],["path",{"d":"M4 4h1v5"}],["path",{"d":"M4 9h2"}],["path",{"d":"M6.5 20H3.4c0-1 2.6-1.925 2.6-3.5a1.5 1.5 0 0 0-2.6-1.02"}]],"list-plus":[["path",{"d":"M16 5H3"}],["path",{"d":"M11 12H3"}],["path",{"d":"M16 19H3"}],["path",{"d":"M18 9v6"}],["path",{"d":"M21 12h-6"}]],"list-restart":[["path",{"d":"M21 5H3"}],["path",{"d":"M7 12H3"}],["path",{"d":"M7 19H3"}],["path",{"d":"M12 18a5 5 0 0 0 9-3 4.5 4.5 0 0 0-4.5-4.5c-1.33 0-2.54.54-3.41 1.41L11 14"}],["path",{"d":"M11 10v4h4"}]],"list-sort-ascending":[["path",{"d":"M3 19h18"}],["path",{"d":"M15 12H3"}],["path",{"d":"M9 5H3"}]],"list-sort-descending":[["path",{"d":"M15 12H3"}],["path",{"d":"M3 5h18"}],["path",{"d":"M9 19H3"}]],"list-start":[["path",{"d":"M3 5h6"}],["path",{"d":"M3 12h13"}],["path",{"d":"M3 19h13"}],["path",{"d":"m16 8-3-3 3-3"}],["path",{"d":"M21 19V7a2 2 0 0 0-2-2h-6"}]],"list-todo":[["path",{"d":"M13 5h8"}],["path",{"d":"M13 12h8"}],["path",{"d":"M13 19h8"}],["path",{"d":"m3 17 2 2 4-4"}],["rect",{"x":"3","y":"4","width":"6","height":"6","rx":"1"}]],"list-tree":[["path",{"d":"M8 5h13"}],["path",{"d":"M13 12h8"}],["path",{"d":"M13 19h8"}],["path",{"d":"M3 10a2 2 0 0 0 2 2h3"}],["path",{"d":"M3 5v12a2 2 0 0 0 2 2h3"}]],"list-video":[["path",{"d":"M21 5H3"}],["path",{"d":"M10 12H3"}],["path",{"d":"M10 19H3"}],["path",{"d":"M15 12.003a1 1 0 0 1 1.517-.859l4.997 2.997a1 1 0 0 1 0 1.718l-4.997 2.997a1 1 0 0 1-1.517-.86z"}]],"list-x":[["path",{"d":"M16 5H3"}],["path",{"d":"M11 12H3"}],["path",{"d":"M16 19H3"}],["path",{"d":"m15.5 9.5 5 5"}],["path",{"d":"m20.5 9.5-5 5"}]],"list":[["path",{"d":"M3 5h.01"}],["path",{"d":"M3 12h.01"}],["path",{"d":"M3 19h.01"}],["path",{"d":"M8 5h13"}],["path",{"d":"M8 12h13"}],["path",{"d":"M8 19h13"}]],"loader-circle":[["path",{"d":"M21 12a9 9 0 1 1-6.219-8.56"}]],"loader-pinwheel":[["path",{"d":"M22 12a1 1 0 0 1-10 0 1 1 0 0 0-10 0"}],["path",{"d":"M7 20.7a1 1 0 1 1 5-8.7 1 1 0 1 0 5-8.6"}],["path",{"d":"M7 3.3a1 1 0 1 1 5 8.6 1 1 0 1 0 5 8.6"}],["circle",{"cx":"12","cy":"12","r":"10"}]],"loader":[["path",{"d":"M12 2v4"}],["path",{"d":"m16.2 7.8 2.9-2.9"}],["path",{"d":"M18 12h4"}],["path",{"d":"m16.2 16.2 2.9 2.9"}],["path",{"d":"M12 18v4"}],["path",{"d":"m4.9 19.1 2.9-2.9"}],["path",{"d":"M2 12h4"}],["path",{"d":"m4.9 4.9 2.9 2.9"}]],"locate-fixed":[["line",{"x1":"2","x2":"5","y1":"12","y2":"12"}],["line",{"x1":"19","x2":"22","y1":"12","y2":"12"}],["line",{"x1":"12","x2":"12","y1":"2","y2":"5"}],["line",{"x1":"12","x2":"12","y1":"19","y2":"22"}],["circle",{"cx":"12","cy":"12","r":"7"}],["circle",{"cx":"12","cy":"12","r":"3"}]],"locate-off":[["path",{"d":"M12 19v3"}],["path",{"d":"M12 2v3"}],["path",{"d":"M18.89 13.24a7 7 0 0 0-8.13-8.13"}],["path",{"d":"M19 12h3"}],["path",{"d":"M2 12h3"}],["path",{"d":"m2 2 20 20"}],["path",{"d":"M7.05 7.05a7 7 0 0 0 9.9 9.9"}]],"locate":[["line",{"x1":"2","x2":"5","y1":"12","y2":"12"}],["line",{"x1":"19","x2":"22","y1":"12","y2":"12"}],["line",{"x1":"12","x2":"12","y1":"2","y2":"5"}],["line",{"x1":"12","x2":"12","y1":"19","y2":"22"}],["circle",{"cx":"12","cy":"12","r":"7"}]],"lock-keyhole-open":[["circle",{"cx":"12","cy":"16","r":"1"}],["rect",{"width":"18","height":"12","x":"3","y":"10","rx":"2"}],["path",{"d":"M7 10V7a5 5 0 0 1 9.33-2.5"}]],"lock-keyhole":[["circle",{"cx":"12","cy":"16","r":"1"}],["rect",{"x":"3","y":"10","width":"18","height":"12","rx":"2"}],["path",{"d":"M7 10V7a5 5 0 0 1 10 0v3"}]],"lock-open":[["rect",{"width":"18","height":"11","x":"3","y":"11","rx":"2","ry":"2"}],["path",{"d":"M7 11V7a5 5 0 0 1 9.9-1"}]],"lock":[["rect",{"width":"18","height":"11","x":"3","y":"11","rx":"2","ry":"2"}],["path",{"d":"M7 11V7a5 5 0 0 1 10 0v4"}]],"log-in":[["path",{"d":"m10 17 5-5-5-5"}],["path",{"d":"M15 12H3"}],["path",{"d":"M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"}]],"log-out":[["path",{"d":"m16 17 5-5-5-5"}],["path",{"d":"M21 12H9"}],["path",{"d":"M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"}]],"logs":[["path",{"d":"M3 5h1"}],["path",{"d":"M3 12h1"}],["path",{"d":"M3 19h1"}],["path",{"d":"M8 5h1"}],["path",{"d":"M8 12h1"}],["path",{"d":"M8 19h1"}],["path",{"d":"M13 5h8"}],["path",{"d":"M13 12h8"}],["path",{"d":"M13 19h8"}]],"lollipop":[["circle",{"cx":"11","cy":"11","r":"8"}],["path",{"d":"m21 21-4.3-4.3"}],["path",{"d":"M11 11a2 2 0 0 0 4 0 4 4 0 0 0-8 0 6 6 0 0 0 12 0"}]],"luggage":[["path",{"d":"M6 20a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2"}],["path",{"d":"M8 18V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v14"}],["path",{"d":"M10 20h4"}],["circle",{"cx":"16","cy":"20","r":"2"}],["circle",{"cx":"8","cy":"20","r":"2"}]],"magnet":[["path",{"d":"m12 15 4 4"}],["path",{"d":"M2.352 10.648a1.205 1.205 0 0 0 0 1.704l2.296 2.296a1.205 1.205 0 0 0 1.704 0l6.029-6.029a1 1 0 1 1 3 3l-6.029 6.029a1.205 1.205 0 0 0 0 1.704l2.296 2.296a1.205 1.205 0 0 0 1.704 0l6.365-6.367A1 1 0 0 0 8.716 4.282z"}],["path",{"d":"m5 8 4 4"}]],"mail-badge":[["path",{"d":"M22 7.7V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8.25"}],["path",{"d":"M12 12.996a1.94 1.94 0 0 1-1.03-.296L2 7"}],["path",{"d":"m20.69 16.479 1.29 4.88a.5.5 0 0 1-.698.591l-1.843-.849a1 1 0 0 0-.879.001l-1.846.85a.5.5 0 0 1-.692-.593l1.29-4.88"}],["circle",{"cx":"19","cy":"14","r":"3"}]],"mail-check":[["path",{"d":"M22 13V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2h8"}],["path",{"d":"m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"}],["path",{"d":"m16 19 2 2 4-4"}]],"mail-clock":[["path",{"d":"M16 14v2.2l1.6 1"}],["path",{"d":"m22 7-.759.484"}],["path",{"d":"M6.835 20H4a2 2 0 01-2-2V6a2 2 0 012-2h16a2 2 0 012 2v2"}],["path",{"d":"M7.605 10.567 2 7"}],["circle",{"cx":"16","cy":"16","r":"6"}]],"mail-minus":[["path",{"d":"M22 15V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2h8"}],["path",{"d":"m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"}],["path",{"d":"M16 19h6"}]],"mail-open":[["path",{"d":"M21.2 8.4c.5.38.8.97.8 1.6v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V10a2 2 0 0 1 .8-1.6l8-6a2 2 0 0 1 2.4 0l8 6Z"}],["path",{"d":"m22 10-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 10"}]],"mail-pen":[["path",{"d":"M15.363 17.634a2 2 0 00-.506.854l-.837 2.87a.5.5 0 00.62.62l2.87-.837a2 2 0 00.854-.506l3.013-3.009a1 1 0 10-3.004-3.004z"}],["path",{"d":"M22 10.38V6a2 2 0 00-2-2H4a2 2 0 00-2 2v12a2 2 0 002 2h6.25"}],["path",{"d":"m22 7-8.991 5.727a2 2 0 01-2.009 0L2 7"}]],"mail-plus":[["path",{"d":"M22 13V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2h8"}],["path",{"d":"m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"}],["path",{"d":"M19 16v6"}],["path",{"d":"M16 19h6"}]],"mail-question-mark":[["path",{"d":"M22 10.5V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2h12.5"}],["path",{"d":"m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"}],["path",{"d":"M18 15.28c.2-.4.5-.8.9-1a2.1 2.1 0 0 1 2.6.4c.3.4.5.8.5 1.3 0 1.3-2 2-2 2"}],["path",{"d":"M20 22v.01"}]],"mail-search":[["path",{"d":"M22 12.5V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2h7.5"}],["path",{"d":"m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"}],["path",{"d":"M18 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"}],["circle",{"cx":"18","cy":"18","r":"3"}],["path",{"d":"m22 22-1.5-1.5"}]],"mail-warning":[["path",{"d":"M22 10.5V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2h12.5"}],["path",{"d":"m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"}],["path",{"d":"M20 14v4"}],["path",{"d":"M20 22v.01"}]],"mail-x":[["path",{"d":"M22 12.532V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8.792"}],["path",{"d":"m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7"}],["path",{"d":"m16.5 16.5 5 5"}],["path",{"d":"m21.5 16.5-5 5"}]],"mail":[["path",{"d":"m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7"}],["rect",{"x":"2","y":"4","width":"20","height":"16","rx":"2"}]],"mailbox":[["path",{"d":"M22 17a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9.5C2 7 4 5 6.5 5H18c2.2 0 4 1.8 4 4v8Z"}],["polyline",{"points":"15,9 18,9 18,11"}],["path",{"d":"M6.5 5C9 5 11 7 11 9.5V17a2 2 0 0 1-2 2"}],["line",{"x1":"6","x2":"7","y1":"10","y2":"10"}]],"mails":[["path",{"d":"M17 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 1-1.732"}],["path",{"d":"m22 5.5-6.419 4.179a2 2 0 0 1-2.162 0L7 5.5"}],["rect",{"x":"7","y":"3","width":"15","height":"12","rx":"2"}]],"map-minus":[["path",{"d":"m11 19-1.106-.552a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0l4.212 2.106a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619V14"}],["path",{"d":"M15 5.764V14"}],["path",{"d":"M21 18h-6"}],["path",{"d":"M9 3.236v15"}]],"map-pin-check-inside":[["path",{"d":"M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"}],["path",{"d":"m9 10 2 2 4-4"}]],"map-pin-check":[["path",{"d":"M19.43 12.935c.357-.967.57-1.955.57-2.935a8 8 0 0 0-16 0c0 4.993 5.539 10.193 7.399 11.799a1 1 0 0 0 1.202 0 32.197 32.197 0 0 0 .813-.728"}],["circle",{"cx":"12","cy":"10","r":"3"}],["path",{"d":"m16 18 2 2 4-4"}]],"map-pin-house":[["path",{"d":"M15 22a1 1 0 0 1-1-1v-4a1 1 0 0 1 .445-.832l3-2a1 1 0 0 1 1.11 0l3 2A1 1 0 0 1 22 17v4a1 1 0 0 1-1 1z"}],["path",{"d":"M18 10a8 8 0 0 0-16 0c0 4.993 5.539 10.193 7.399 11.799a1 1 0 0 0 .601.2"}],["path",{"d":"M18 22v-3"}],["circle",{"cx":"10","cy":"10","r":"3"}]],"map-pin-minus-inside":[["path",{"d":"M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"}],["path",{"d":"M9 10h6"}]],"map-pin-minus":[["path",{"d":"M18.977 14C19.6 12.701 20 11.343 20 10a8 8 0 0 0-16 0c0 4.993 5.539 10.193 7.399 11.799a1 1 0 0 0 1.202 0 32 32 0 0 0 .824-.738"}],["circle",{"cx":"12","cy":"10","r":"3"}],["path",{"d":"M16 18h6"}]],"map-pin-off":[["path",{"d":"M12.75 7.09a3 3 0 0 1 2.16 2.16"}],["path",{"d":"M17.072 17.072c-1.634 2.17-3.527 3.912-4.471 4.727a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 1.432-4.568"}],["path",{"d":"m2 2 20 20"}],["path",{"d":"M8.475 2.818A8 8 0 0 1 20 10c0 1.183-.31 2.377-.81 3.533"}],["path",{"d":"M9.13 9.13a3 3 0 0 0 3.74 3.74"}]],"map-pin-pen":[["path",{"d":"M17.97 9.304A8 8 0 0 0 2 10c0 4.69 4.887 9.562 7.022 11.468"}],["path",{"d":"M21.378 16.626a1 1 0 0 0-3.004-3.004l-4.01 4.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z"}],["circle",{"cx":"10","cy":"10","r":"3"}]],"map-pin-plus-inside":[["path",{"d":"M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"}],["path",{"d":"M12 7v6"}],["path",{"d":"M9 10h6"}]],"map-pin-plus":[["path",{"d":"M19.914 11.105A7.298 7.298 0 0 0 20 10a8 8 0 0 0-16 0c0 4.993 5.539 10.193 7.399 11.799a1 1 0 0 0 1.202 0 32 32 0 0 0 .824-.738"}],["circle",{"cx":"12","cy":"10","r":"3"}],["path",{"d":"M16 18h6"}],["path",{"d":"M19 15v6"}]],"map-pin-search":[["path",{"d":"M 12.248 21.969 a 1 1 0 0 1 -0.849 -0.17 C 9.539 20.193 4 14.993 4 10 a 8 8 0 0 1 16 0 C 20 10.42 19.961 10.841 19.888 11.262"}],["path",{"d":"m22 22-1.88-1.88"}],["circle",{"cx":"12","cy":"10","r":"3"}],["circle",{"cx":"18","cy":"18","r":"3"}]],"map-pin-x-inside":[["path",{"d":"M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"}],["path",{"d":"m14.5 7.5-5 5"}],["path",{"d":"m9.5 7.5 5 5"}]],"map-pin-x":[["path",{"d":"M19.752 11.901A7.78 7.78 0 0 0 20 10a8 8 0 0 0-16 0c0 4.993 5.539 10.193 7.399 11.799a1 1 0 0 0 1.202 0 19 19 0 0 0 .09-.077"}],["circle",{"cx":"12","cy":"10","r":"3"}],["path",{"d":"m21.5 15.5-5 5"}],["path",{"d":"m21.5 20.5-5-5"}]],"map-pin":[["path",{"d":"M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"}],["circle",{"cx":"12","cy":"10","r":"3"}]],"map-pinned":[["path",{"d":"M18 8c0 3.613-3.869 7.429-5.393 8.795a1 1 0 01-1.214 0C9.87 15.429 6 11.613 6 8a6 6 0 0112 0"}],["path",{"d":"M4.474 15h-.197a1 1 0 00-.969.753l-1.097 4.35a1.5 1.5 0 001.444 1.898L20.344 22a1.5 1.5 0 001.446-1.897l-1.098-4.35a1 1 0 00-.969-.753h-.197"}],["circle",{"cx":"12","cy":"8","r":"2"}]],"map-plus":[["path",{"d":"m11 19-1.106-.552a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0l4.212 2.106a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619V12"}],["path",{"d":"M15 5.764V12"}],["path",{"d":"M18 15v6"}],["path",{"d":"M21 18h-6"}],["path",{"d":"M9 3.236v15"}]],"map":[["path",{"d":"M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z"}],["path",{"d":"M15 5.764v15"}],["path",{"d":"M9 3.236v15"}]],"mars-stroke":[["path",{"d":"m14 6 4 4"}],["path",{"d":"M17 3h4v4"}],["path",{"d":"m21 3-7.75 7.75"}],["circle",{"cx":"9","cy":"15","r":"6"}]],"mars":[["path",{"d":"M16 3h5v5"}],["path",{"d":"m21 3-6.75 6.75"}],["circle",{"cx":"10","cy":"14","r":"6"}]],"martini":[["path",{"d":"M12 12 4.207 4.207A.707.707 0 0 1 4.707 3h14.586a.707.707 0 0 1 .5 1.207z"}],["path",{"d":"M12 12v10"}],["path",{"d":"M7 22h10"}]],"maximize-2":[["path",{"d":"M15 3h6v6"}],["path",{"d":"m21 3-7 7"}],["path",{"d":"m3 21 7-7"}],["path",{"d":"M9 21H3v-6"}]],"maximize":[["path",{"d":"M8 3H5a2 2 0 0 0-2 2v3"}],["path",{"d":"M21 8V5a2 2 0 0 0-2-2h-3"}],["path",{"d":"M3 16v3a2 2 0 0 0 2 2h3"}],["path",{"d":"M16 21h3a2 2 0 0 0 2-2v-3"}]],"medal":[["path",{"d":"M7.21 15 2.66 7.14a2 2 0 0 1 .13-2.2L4.4 2.8A2 2 0 0 1 6 2h12a2 2 0 0 1 1.6.8l1.6 2.14a2 2 0 0 1 .14 2.2L16.79 15"}],["path",{"d":"M11 12 5.12 2.2"}],["path",{"d":"m13 12 5.88-9.8"}],["path",{"d":"M8 7h8"}],["circle",{"cx":"12","cy":"17","r":"5"}],["path",{"d":"M12 18v-2h-.5"}]],"megaphone-off":[["path",{"d":"M11.636 6A13 13 0 0 0 19.4 3.2 1 1 0 0 1 21 4v11.344"}],["path",{"d":"M14.378 14.357A13 13 0 0 0 11 14H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h1"}],["path",{"d":"m2 2 20 20"}],["path",{"d":"M6 14a12 12 0 0 0 2.4 7.2 2 2 0 0 0 3.2-2.4A8 8 0 0 1 10 14"}],["path",{"d":"M8 8v6"}]],"megaphone":[["path",{"d":"M11 6a13 13 0 0 0 8.4-2.8A1 1 0 0 1 21 4v12a1 1 0 0 1-1.6.8A13 13 0 0 0 11 14H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"}],["path",{"d":"M6 14a12 12 0 0 0 2.4 7.2 2 2 0 0 0 3.2-2.4A8 8 0 0 1 10 14"}],["path",{"d":"M8 6v8"}]],"memory-stick":[["path",{"d":"M12 12v-2"}],["path",{"d":"M12 18v-2"}],["path",{"d":"M16 12v-2"}],["path",{"d":"M16 18v-2"}],["path",{"d":"M2 11h1.5"}],["path",{"d":"M20 18v-2"}],["path",{"d":"M20.5 11H22"}],["path",{"d":"M4 18v-2"}],["path",{"d":"M8 12v-2"}],["path",{"d":"M8 18v-2"}],["rect",{"x":"2","y":"6","width":"20","height":"10","rx":"2"}]],"menu":[["path",{"d":"M4 5h16"}],["path",{"d":"M4 12h16"}],["path",{"d":"M4 19h16"}]],"merge":[["path",{"d":"m8 6 4-4 4 4"}],["path",{"d":"M12 2v10.3a4 4 0 0 1-1.172 2.872L4 22"}],["path",{"d":"m20 22-5-5"}]],"message-circle-check":[["path",{"d":"M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"}],["path",{"d":"m16 9-5.5 5.5L8 12"}]],"message-circle-code":[["path",{"d":"m10 9-3 3 3 3"}],["path",{"d":"m14 15 3-3-3-3"}],["path",{"d":"M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"}]],"message-circle-dashed-check":[["path",{"d":"M10.1 2.182a10 10 0 013.8 0"}],["path",{"d":"M13.9 21.818a10 10 0 01-3.8 0"}],["path",{"d":"M17.609 3.72a10 10 0 012.69 2.7"}],["path",{"d":"M2.182 13.9a10 10 0 010-3.8"}],["path",{"d":"M20.28 17.61a10 10 0 01-2.7 2.69"}],["path",{"d":"M21.818 10.1a10 10 0 010 3.8"}],["path",{"d":"M3.721 6.391a10 10 0 012.7-2.69"}],["path",{"d":"m6.163 21.117-2.906.85a1 1 0 01-1.236-1.169l.965-2.98"}],["path",{"d":"m16 9-5.5 5.5L8 12"}]],"message-circle-dashed":[["path",{"d":"M10.1 2.182a10 10 0 0 1 3.8 0"}],["path",{"d":"M13.9 21.818a10 10 0 0 1-3.8 0"}],["path",{"d":"M17.609 3.72a10 10 0 0 1 2.69 2.7"}],["path",{"d":"M2.182 13.9a10 10 0 0 1 0-3.8"}],["path",{"d":"M20.28 17.61a10 10 0 0 1-2.7 2.69"}],["path",{"d":"M21.818 10.1a10 10 0 0 1 0 3.8"}],["path",{"d":"M3.721 6.391a10 10 0 0 1 2.7-2.69"}],["path",{"d":"m6.163 21.117-2.906.85a1 1 0 0 1-1.236-1.169l.965-2.98"}]],"message-circle-heart":[["path",{"d":"M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"}],["path",{"d":"M7.828 13.07A3 3 0 0 1 12 8.764a3 3 0 0 1 5.004 2.224 3 3 0 0 1-.832 2.083l-3.447 3.62a1 1 0 0 1-1.45-.001z"}]],"message-circle-more":[["path",{"d":"M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"}],["path",{"d":"M8 12h.01"}],["path",{"d":"M12 12h.01"}],["path",{"d":"M16 12h.01"}]],"message-circle-off":[["path",{"d":"m2 2 20 20"}],["path",{"d":"M4.93 4.929a10 10 0 0 0-1.938 11.412 2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 0 0 11.302-1.989"}],["path",{"d":"M8.35 2.69A10 10 0 0 1 21.3 15.65"}]],"message-circle-plus":[["path",{"d":"M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"}],["path",{"d":"M8 12h8"}],["path",{"d":"M12 8v8"}]],"message-circle-question-mark":[["path",{"d":"M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"}],["path",{"d":"M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"}],["path",{"d":"M12 17h.01"}]],"message-circle-reply":[["path",{"d":"M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"}],["path",{"d":"m10 15-3-3 3-3"}],["path",{"d":"M7 12h8a2 2 0 0 1 2 2v1"}]],"message-circle-warning":[["path",{"d":"M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"}],["path",{"d":"M12 8v4"}],["path",{"d":"M12 16h.01"}]],"message-circle-x":[["path",{"d":"M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"}],["path",{"d":"m15 9-6 6"}],["path",{"d":"m9 9 6 6"}]],"message-circle":[["path",{"d":"M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"}]],"message-square-check":[["path",{"d":"M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.7.7 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"}],["path",{"d":"m9 11 2 2 4-4"}]],"message-square-code":[["path",{"d":"M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"}],["path",{"d":"m10 8-3 3 3 3"}],["path",{"d":"m14 14 3-3-3-3"}]],"message-square-dashed":[["path",{"d":"M14 3h2"}],["path",{"d":"M16 19h-2"}],["path",{"d":"M2 12v-2"}],["path",{"d":"M2 16v5.286a.71.71 0 0 0 1.212.502l1.149-1.149"}],["path",{"d":"M20 19a2 2 0 0 0 2-2v-1"}],["path",{"d":"M22 10v2"}],["path",{"d":"M22 6V5a2 2 0 0 0-2-2"}],["path",{"d":"M4 3a2 2 0 0 0-2 2v1"}],["path",{"d":"M8 19h2"}],["path",{"d":"M8 3h2"}]],"message-square-diff":[["path",{"d":"M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"}],["path",{"d":"M10 15h4"}],["path",{"d":"M10 9h4"}],["path",{"d":"M12 7v4"}]],"message-square-dot":[["path",{"d":"M12.7 3H4a2 2 0 0 0-2 2v16.286a.71.71 0 0 0 1.212.502l2.202-2.202A2 2 0 0 1 6.828 19H20a2 2 0 0 0 2-2v-4.7"}],["circle",{"cx":"19","cy":"6","r":"3"}]],"message-square-heart":[["path",{"d":"M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"}],["path",{"d":"M7.5 9.5c0 .687.265 1.383.697 1.844l3.009 3.264a1.14 1.14 0 0 0 .407.314 1 1 0 0 0 .783-.004 1.14 1.14 0 0 0 .398-.31l3.008-3.264A2.77 2.77 0 0 0 16.5 9.5 2.5 2.5 0 0 0 12 8a2.5 2.5 0 0 0-4.5 1.5"}]],"message-square-lock":[["path",{"d":"M22 8.5V5a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v16.286a.71.71 0 0 0 1.212.502l2.202-2.202A2 2 0 0 1 6.828 19H10"}],["path",{"d":"M20 15v-2a2 2 0 0 0-4 0v2"}],["rect",{"x":"14","y":"15","width":"8","height":"5","rx":"1"}]],"message-square-more":[["path",{"d":"M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"}],["path",{"d":"M12 11h.01"}],["path",{"d":"M16 11h.01"}],["path",{"d":"M8 11h.01"}]],"message-square-off":[["path",{"d":"M19 19H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.7.7 0 0 1 2 21.286V5a2 2 0 0 1 1.184-1.826"}],["path",{"d":"m2 2 20 20"}],["path",{"d":"M8.656 3H20a2 2 0 0 1 2 2v11.344"}]],"message-square-plus":[["path",{"d":"M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"}],["path",{"d":"M12 8v6"}],["path",{"d":"M9 11h6"}]],"message-square-quote":[["path",{"d":"M14 14a2 2 0 0 0 2-2V8h-2"}],["path",{"d":"M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"}],["path",{"d":"M8 14a2 2 0 0 0 2-2V8H8"}]],"message-square-reply":[["path",{"d":"M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"}],["path",{"d":"m10 8-3 3 3 3"}],["path",{"d":"M17 14v-1a2 2 0 0 0-2-2H7"}]],"message-square-share":[["path",{"d":"M12 3H4a2 2 0 0 0-2 2v16.286a.71.71 0 0 0 1.212.502l2.202-2.202A2 2 0 0 1 6.828 19H20a2 2 0 0 0 2-2v-4"}],["path",{"d":"M16 3h6v6"}],["path",{"d":"m16 9 6-6"}]],"message-square-text":[["path",{"d":"M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"}],["path",{"d":"M7 11h10"}],["path",{"d":"M7 15h6"}],["path",{"d":"M7 7h8"}]],"message-square-warning":[["path",{"d":"M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"}],["path",{"d":"M12 15h.01"}],["path",{"d":"M12 7v4"}]],"message-square-x":[["path",{"d":"M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"}],["path",{"d":"m14.5 8.5-5 5"}],["path",{"d":"m9.5 8.5 5 5"}]],"message-square":[["path",{"d":"M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"}]],"messages-circle":[["path",{"d":"M19.95 10.05a7 7 0 011.412 7.872 1 1 0 00-.058.787l.675 2.089a1 1 0 01-1.236 1.168l-2.155-.631a1 1 0 00-.745.06 7 7 0 01-7.793-1.445"}],["path",{"d":"M2.696 12.708a1 1 0 00-.058-.785 7 7 0 113.518 3.473 1 1 0 00-.744-.061l-2.155.63a1 1 0 01-1.236-1.167z"}]],"messages-square":[["path",{"d":"M16 10a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 14.286V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"}],["path",{"d":"M20 9a2 2 0 0 1 2 2v10.286a.71.71 0 0 1-1.212.502l-2.202-2.202A2 2 0 0 0 17.172 19H10a2 2 0 0 1-2-2v-1"}]],"metronome":[["path",{"d":"M12 11.4V9.1"}],["path",{"d":"m12 17 6.59-6.59"}],["path",{"d":"m15.05 5.7-.218-.691a3 3 0 0 0-5.663 0L4.418 19.695A1 1 0 0 0 5.37 21h13.253a1 1 0 0 0 .951-1.31L18.45 16.2"}],["circle",{"cx":"20","cy":"9","r":"2"}]],"mic-audio-lines":[["path",{"d":"M10 3v2.341"}],["path",{"d":"M12 17v4"}],["path",{"d":"M14 5v.341"}],["path",{"d":"M18 5v13"}],["path",{"d":"M2 10v3"}],["path",{"d":"M22 10v3"}],["path",{"d":"M6 6v11"}],["path",{"d":"M9 21h6"}],["rect",{"width":"4","height":"8","x":"10","y":"9","rx":"2"}]],"mic-off":[["path",{"d":"M12 19v3"}],["path",{"d":"M15 9.34V5a3 3 0 0 0-5.68-1.33"}],["path",{"d":"M16.95 16.95A7 7 0 0 1 5 12v-2"}],["path",{"d":"M18.89 13.23A7 7 0 0 0 19 12v-2"}],["path",{"d":"m2 2 20 20"}],["path",{"d":"M9 9v3a3 3 0 0 0 5.12 2.12"}]],"mic-signal":[["path",{"d":"M12 17v4"}],["path",{"d":"M18 11a6 6 0 00-3-5.197"}],["path",{"d":"M2 11a10 10 0 015-8.662"}],["path",{"d":"M22 11a10 10 0 00-5-8.662"}],["path",{"d":"M6 11a6 6 0 013-5.197"}],["path",{"d":"M9 21h6"}],["rect",{"x":"10","y":"9","width":"4","height":"8","rx":"2"}]],"mic-vocal":[["path",{"d":"m11 7.601-5.994 8.19a1 1 0 0 0 .1 1.298l.817.818a1 1 0 0 0 1.314.087L15.09 12"}],["path",{"d":"M16.5 21.174C15.5 20.5 14.372 20 13 20c-2.058 0-3.928 2.356-6 2-2.072-.356-2.775-3.369-1.5-4.5"}],["circle",{"cx":"16","cy":"7","r":"5"}]],"mic":[["path",{"d":"M12 19v3"}],["path",{"d":"M19 10v2a7 7 0 0 1-14 0v-2"}],["rect",{"x":"9","y":"2","width":"6","height":"13","rx":"3"}]],"microchip":[["path",{"d":"M10 12h4"}],["path",{"d":"M10 17h4"}],["path",{"d":"M10 7h4"}],["path",{"d":"M18 12h2"}],["path",{"d":"M18 18h2"}],["path",{"d":"M18 6h2"}],["path",{"d":"M4 12h2"}],["path",{"d":"M4 18h2"}],["path",{"d":"M4 6h2"}],["rect",{"x":"6","y":"2","width":"12","height":"20","rx":"2"}]],"microscope":[["path",{"d":"M6 18h8"}],["path",{"d":"M3 22h18"}],["path",{"d":"M14 22a7 7 0 1 0 0-14h-1"}],["path",{"d":"M9 14h2"}],["path",{"d":"M9 12a2 2 0 0 1-2-2V6h6v4a2 2 0 0 1-2 2Z"}],["path",{"d":"M12 6V3a1 1 0 0 0-1-1H9a1 1 0 0 0-1 1v3"}]],"microwave":[["rect",{"width":"20","height":"15","x":"2","y":"4","rx":"2"}],["rect",{"width":"8","height":"7","x":"6","y":"8","rx":"1"}],["path",{"d":"M18 8v7"}],["path",{"d":"M6 19v2"}],["path",{"d":"M18 19v2"}]],"midi-port":[["path",{"d":"M12 18h.01"}],["path",{"d":"M15 2.458V5a1 1 0 01-1 1h-4a1 1 0 01-1-1V2.458"}],["path",{"d":"M16 16h.01"}],["path",{"d":"M18 12h.01"}],["path",{"d":"M6 12h.01"}],["path",{"d":"M8 16h.01"}],["circle",{"cx":"12","cy":"12","r":"10"}]],"milestone":[["path",{"d":"M12 13v8"}],["path",{"d":"M12 3v3"}],["path",{"d":"M18.172 6a2 2 0 0 1 1.414.586l2.06 2.06a1.207 1.207 0 0 1 0 1.708l-2.06 2.06a2 2 0 0 1-1.414.586H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z"}]],"milk-off":[["path",{"d":"M8 2h8"}],["path",{"d":"M9 2v1.343M15 2v2.789a4 4 0 0 0 .672 2.219l.656.984a4 4 0 0 1 .672 2.22v1.131M7.8 7.8l-.128.192A4 4 0 0 0 7 10.212V20a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-3"}],["path",{"d":"M7 15a6.47 6.47 0 0 1 5 0 6.472 6.472 0 0 0 3.435.435"}],["line",{"x1":"2","x2":"22","y1":"2","y2":"22"}]],"milk":[["path",{"d":"M8 2h8"}],["path",{"d":"M9 2v2.789a4 4 0 0 1-.672 2.219l-.656.984A4 4 0 0 0 7 10.212V20a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-9.789a4 4 0 0 0-.672-2.219l-.656-.984A4 4 0 0 1 15 4.788V2"}],["path",{"d":"M7 15a6.472 6.472 0 0 1 5 0 6.47 6.47 0 0 0 5 0"}]],"minimize-2":[["path",{"d":"m14 10 7-7"}],["path",{"d":"M20 10h-6V4"}],["path",{"d":"m3 21 7-7"}],["path",{"d":"M4 14h6v6"}]],"minimize":[["path",{"d":"M8 3v3a2 2 0 0 1-2 2H3"}],["path",{"d":"M21 8h-3a2 2 0 0 1-2-2V3"}],["path",{"d":"M3 16h3a2 2 0 0 1 2 2v3"}],["path",{"d":"M16 21v-3a2 2 0 0 1 2-2h3"}]],"minus":[["path",{"d":"M5 12h14"}]],"mirror-rectangular":[["path",{"d":"M11 6 8 9"}],["path",{"d":"m16 7-8 8"}],["rect",{"x":"4","y":"2","width":"16","height":"20","rx":"2"}]],"mirror-round":[["path",{"d":"M10 6.6 8.6 8"}],["path",{"d":"M12 18v4"}],["path",{"d":"M15 7.5 9.5 13"}],["path",{"d":"M7 22h10"}],["circle",{"cx":"12","cy":"10","r":"8"}]],"monitor-check":[["path",{"d":"m9 10 2 2 4-4"}],["rect",{"width":"20","height":"14","x":"2","y":"3","rx":"2"}],["path",{"d":"M12 17v4"}],["path",{"d":"M8 21h8"}]],"monitor-cloud":[["path",{"d":"M11 13a3 3 0 1 1 2.83-4H14a2 2 0 0 1 0 4z"}],["path",{"d":"M12 17v4"}],["path",{"d":"M8 21h8"}],["rect",{"x":"2","y":"3","width":"20","height":"14","rx":"2"}]],"monitor-cog":[["path",{"d":"M12 17v4"}],["path",{"d":"m14.305 7.53.923-.382"}],["path",{"d":"m15.228 4.852-.923-.383"}],["path",{"d":"m16.852 3.228-.383-.924"}],["path",{"d":"m16.852 8.772-.383.923"}],["path",{"d":"m19.148 3.228.383-.924"}],["path",{"d":"m19.53 9.696-.382-.924"}],["path",{"d":"m20.772 4.852.924-.383"}],["path",{"d":"m20.772 7.148.924.383"}],["path",{"d":"M22 13v2a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7"}],["path",{"d":"M8 21h8"}],["circle",{"cx":"18","cy":"6","r":"3"}]],"monitor-dot":[["path",{"d":"M12 17v4"}],["path",{"d":"M22 12.307V15a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8.693"}],["path",{"d":"M8 21h8"}],["circle",{"cx":"19","cy":"6","r":"3"}]],"monitor-down":[["path",{"d":"M12 13V7"}],["path",{"d":"m15 10-3 3-3-3"}],["rect",{"width":"20","height":"14","x":"2","y":"3","rx":"2"}],["path",{"d":"M12 17v4"}],["path",{"d":"M8 21h8"}]],"monitor-off":[["path",{"d":"M12 17v4"}],["path",{"d":"M17 17H4a2 2 0 0 1-2-2V5a2 2 0 0 1 1.184-1.826"}],["path",{"d":"m2 2 20 20"}],["path",{"d":"M8 21h8"}],["path",{"d":"M8.656 3H20a2 2 0 0 1 2 2v10a2 2 0 0 1-.293 1.042"}]],"monitor-pause":[["path",{"d":"M10 13V7"}],["path",{"d":"M14 13V7"}],["rect",{"width":"20","height":"14","x":"2","y":"3","rx":"2"}],["path",{"d":"M12 17v4"}],["path",{"d":"M8 21h8"}]],"monitor-pc":[["path",{"d":"M10 15H4a2 2 0 01-2-2V7a2 2 0 012-2h6"}],["path",{"d":"M10 19H5"}],["path",{"d":"M14 11h8"}],["path",{"d":"M14 7h8"}],["path",{"d":"M18 17h.01"}],["path",{"d":"M9 19v-4"}],["rect",{"x":"14","y":"3","width":"8","height":"18","rx":"1"}]],"monitor-play":[["path",{"d":"M15.033 9.44a.647.647 0 0 1 0 1.12l-4.065 2.352a.645.645 0 0 1-.968-.56V7.648a.645.645 0 0 1 .967-.56z"}],["path",{"d":"M12 17v4"}],["path",{"d":"M8 21h8"}],["rect",{"x":"2","y":"3","width":"20","height":"14","rx":"2"}]],"monitor-smartphone":[["path",{"d":"M18 8V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h8"}],["path",{"d":"M10 19v-3.96 3.15"}],["path",{"d":"M7 19h5"}],["rect",{"width":"6","height":"10","x":"16","y":"12","rx":"2"}]],"monitor-speaker":[["path",{"d":"M5.5 20H8"}],["path",{"d":"M17 9h.01"}],["rect",{"width":"10","height":"16","x":"12","y":"4","rx":"2"}],["path",{"d":"M8 6H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h4"}],["circle",{"cx":"17","cy":"15","r":"1"}]],"monitor-stop":[["path",{"d":"M12 17v4"}],["path",{"d":"M8 21h8"}],["rect",{"x":"2","y":"3","width":"20","height":"14","rx":"2"}],["rect",{"x":"9","y":"7","width":"6","height":"6","rx":"1"}]],"monitor-up":[["path",{"d":"m9 10 3-3 3 3"}],["path",{"d":"M12 13V7"}],["rect",{"width":"20","height":"14","x":"2","y":"3","rx":"2"}],["path",{"d":"M12 17v4"}],["path",{"d":"M8 21h8"}]],"monitor-x":[["path",{"d":"m14.5 12.5-5-5"}],["path",{"d":"m9.5 12.5 5-5"}],["rect",{"width":"20","height":"14","x":"2","y":"3","rx":"2"}],["path",{"d":"M12 17v4"}],["path",{"d":"M8 21h8"}]],"monitor":[["rect",{"width":"20","height":"14","x":"2","y":"3","rx":"2"}],["line",{"x1":"8","x2":"16","y1":"21","y2":"21"}],["line",{"x1":"12","x2":"12","y1":"17","y2":"21"}]],"moon-star":[["path",{"d":"M18 5h4"}],["path",{"d":"M20 3v4"}],["path",{"d":"M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"}]],"moon":[["path",{"d":"M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"}]],"mop-sparkles":[["path",{"d":"M10 22a3 3 0 01-3-3"}],["path",{"d":"M10 22c2.761 0 5-1.79 5-4-4.42 0-4.08-5-8.5-5a4.501 4.501 0 000 9z"}],["path",{"d":"M10 3H8"}],["path",{"d":"M12.5 11.5 22 2"}],["path",{"d":"M20 13v4"}],["path",{"d":"M22 15h-4"}],["path",{"d":"M4 5v4"}],["path",{"d":"M6 7H2"}],["path",{"d":"m6.98 13.02 2.665-2.664a1.21 1.21 0 011.71 0l2.29 2.288a1.21 1.21 0 010 1.712l-2.088 2.087"}],["path",{"d":"M9 2v2"}]],"mop":[["path",{"d":"M10 22c2.761 0 5-1.79 5-4-4.42 0-4.08-5-8.5-5a1 1 0 100 9za3 3 0 01-3-3"}],["path",{"d":"M12.5 11.5 22 2"}],["path",{"d":"m6.98 13.02 2.665-2.664a1.21 1.21 0 011.71 0l2.29 2.288a1.21 1.21 0 010 1.712l-2.088 2.087"}]],"mosque":[["path",{"d":"M12.268 2a2 2 0 003.465 2"}],["path",{"d":"M14 5 L14 8"}],["path",{"d":"M16 22v-3a2 2 0 00-4 0v3"}],["path",{"d":"M21 13c-.662-1.497-1.666-2.753-2.9-3.63C16.825 8.47 15.422 8 14 8s-2.826.47-4.1 1.37C8.668 10.248 7.663 11.504 7 13z"}],["path",{"d":"M3 9h4"}],["path",{"d":"M7 22V6a5 5 0 00-2-4 5 5 0 00-2 4v14a2 2 0 002 2h14a2 2 0 002-2v-7"}]],"motorbike":[["path",{"d":"m18 14-1-3"}],["path",{"d":"m3 9 6 2a2 2 0 0 1 2-2h2a2 2 0 0 1 1.99 1.81"}],["path",{"d":"M8 17h3a1 1 0 0 0 1-1 6 6 0 0 1 6-6 1 1 0 0 0 1-1v-.75A5 5 0 0 0 17 5"}],["circle",{"cx":"19","cy":"17","r":"3"}],["circle",{"cx":"5","cy":"17","r":"3"}]],"mountain-snow":[["path",{"d":"m8 3 4 8 5-5 5 15H2L8 3z"}],["path",{"d":"M4.14 15.08c2.62-1.57 5.24-1.43 7.86.42 2.74 1.94 5.49 2 8.23.19"}]],"mountain":[["path",{"d":"m8 3 4 8 5-5 5 15H2L8 3z"}]],"mouse-left":[["path",{"d":"M12 7.318V10"}],["path",{"d":"M5 10v5a7 7 0 0 0 14 0V9c0-3.527-2.608-6.515-6-7"}],["circle",{"cx":"7","cy":"4","r":"2"}]],"mouse-off":[["path",{"d":"M12 6v.343"}],["path",{"d":"M18.218 18.218A7 7 0 0 1 5 15V9a7 7 0 0 1 .782-3.218"}],["path",{"d":"M19 13.343V9A7 7 0 0 0 8.56 2.902"}],["path",{"d":"M22 22 2 2"}]],"mouse-pointer-2-off":[["path",{"d":"m15.55 8.45 5.138 2.087a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063L8.45 15.551"}],["path",{"d":"M22 2 2 22"}],["path",{"d":"m6.816 11.528-2.779-6.84a.495.495 0 0 1 .651-.651l6.84 2.779"}]],"mouse-pointer-2":[["path",{"d":"M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z"}]],"mouse-pointer-ban":[["path",{"d":"M2.034 2.681a.498.498 0 0 1 .647-.647l9 3.5a.5.5 0 0 1-.033.944L8.204 7.545a1 1 0 0 0-.66.66l-1.066 3.443a.5.5 0 0 1-.944.033z"}],["circle",{"cx":"16","cy":"16","r":"6"}],["path",{"d":"m11.8 11.8 8.4 8.4"}]],"mouse-pointer-click":[["path",{"d":"M14 4.1 12 6"}],["path",{"d":"m5.1 8-2.9-.8"}],["path",{"d":"m6 12-1.9 2"}],["path",{"d":"M7.2 2.2 8 5.1"}],["path",{"d":"M9.037 9.69a.498.498 0 0 1 .653-.653l11 4.5a.5.5 0 0 1-.074.949l-4.349 1.041a1 1 0 0 0-.74.739l-1.04 4.35a.5.5 0 0 1-.95.074z"}]],"mouse-pointer":[["path",{"d":"M12.586 12.586 19 19"}],["path",{"d":"M3.688 3.037a.497.497 0 0 0-.651.651l6.5 15.999a.501.501 0 0 0 .947-.062l1.569-6.083a2 2 0 0 1 1.448-1.479l6.124-1.579a.5.5 0 0 0 .063-.947z"}]],"mouse-right":[["path",{"d":"M12 7.318V10"}],["path",{"d":"M19 10v5a7 7 0 0 1-14 0V9c0-3.527 2.608-6.515 6-7"}],["circle",{"cx":"17","cy":"4","r":"2"}]],"mouse":[["rect",{"x":"5","y":"2","width":"14","height":"20","rx":"7"}],["path",{"d":"M12 6v4"}]],"mouth-off":[["path",{"d":"M13.074 7.417a2.6 2.6 0 012.989.099c1.829 1.36 3.053 2.076 5.479 3.644a1 1 0 01.308 1.368 11.6 11.6 0 01-1.617 2.05"}],["path",{"d":"M2 12a50.5 50.5 0 0010.99.99"}],["path",{"d":"m2 2 20 20"}],["path",{"d":"M21 11a1 1 0 011 1 51 51 0 01-3.734.61"}],["path",{"d":"M7.695 7.695c-1.7 1.247-2.92 1.967-5.238 3.464a1 1 0 00-.307 1.369 11.6 11.6 0 0014.766 4.388"}]],"mouth":[["path",{"d":"M2 12a50.5 50.5 0 0020 0 1 1 0 00-1-1"}],["path",{"d":"M2.457 11.159a1 1 0 00-.307 1.369 11.59 11.59 0 0019.7 0 1 1 0 00-.308-1.368c-2.426-1.568-3.65-2.284-5.479-3.644a2.6 2.6 0 00-3.373.208 1 1 0 01-1.38 0 2.62 2.62 0 00-3.373-.208c-1.83 1.36-3.053 2.076-5.48 3.643"}]],"move-3d":[["path",{"d":"M5 3v16h16"}],["path",{"d":"m5 19 6-6"}],["path",{"d":"m2 6 3-3 3 3"}],["path",{"d":"m18 16 3 3-3 3"}]],"move-diagonal-2":[["path",{"d":"M19 13v6h-6"}],["path",{"d":"M5 11V5h6"}],["path",{"d":"m5 5 14 14"}]],"move-diagonal":[["path",{"d":"M11 19H5v-6"}],["path",{"d":"M13 5h6v6"}],["path",{"d":"M19 5 5 19"}]],"move-down-left":[["path",{"d":"M11 19H5V13"}],["path",{"d":"M19 5L5 19"}]],"move-down-right":[["path",{"d":"M19 13V19H13"}],["path",{"d":"M5 5L19 19"}]],"move-down":[["path",{"d":"M8 18L12 22L16 18"}],["path",{"d":"M12 2V22"}]],"move-horizontal":[["path",{"d":"m18 8 4 4-4 4"}],["path",{"d":"M2 12h20"}],["path",{"d":"m6 8-4 4 4 4"}]],"move-left":[["path",{"d":"M6 8L2 12L6 16"}],["path",{"d":"M2 12H22"}]],"move-right":[["path",{"d":"M18 8L22 12L18 16"}],["path",{"d":"M2 12H22"}]],"move-up-left":[["path",{"d":"M5 11V5H11"}],["path",{"d":"M5 5L19 19"}]],"move-up-right":[["path",{"d":"M13 5H19V11"}],["path",{"d":"M19 5L5 19"}]],"move-up":[["path",{"d":"M8 6L12 2L16 6"}],["path",{"d":"M12 2V22"}]],"move-vertical":[["path",{"d":"M12 2v20"}],["path",{"d":"m8 18 4 4 4-4"}],["path",{"d":"m8 6 4-4 4 4"}]],"move":[["path",{"d":"M12 2v20"}],["path",{"d":"m15 19-3 3-3-3"}],["path",{"d":"m19 9 3 3-3 3"}],["path",{"d":"M2 12h20"}],["path",{"d":"m5 9-3 3 3 3"}],["path",{"d":"m9 5 3-3 3 3"}]],"music-2":[["circle",{"cx":"8","cy":"18","r":"4"}],["path",{"d":"M12 18V2l7 4"}]],"music-3":[["circle",{"cx":"12","cy":"18","r":"4"}],["path",{"d":"M16 18V2"}]],"music-4":[["path",{"d":"M9 18V5l12-2v13"}],["path",{"d":"m9 9 12-2"}],["circle",{"cx":"6","cy":"18","r":"3"}],["circle",{"cx":"18","cy":"16","r":"3"}]],"music":[["path",{"d":"M9 18V5l12-2v13"}],["circle",{"cx":"6","cy":"18","r":"3"}],["circle",{"cx":"18","cy":"16","r":"3"}]],"navigation-2-off":[["path",{"d":"M9.31 9.31 5 21l7-4 7 4-1.17-3.17"}],["path",{"d":"M14.53 8.88 12 2l-1.17 3.17"}],["line",{"x1":"2","x2":"22","y1":"2","y2":"22"}]],"navigation-2":[["polygon",{"points":"12 2 19 21 12 17 5 21 12 2"}]],"navigation-off":[["path",{"d":"M8.43 8.43 3 11l8 2 2 8 2.57-5.43"}],["path",{"d":"M17.39 11.73 22 2l-9.73 4.61"}],["line",{"x1":"2","x2":"22","y1":"2","y2":"22"}]],"navigation":[["polygon",{"points":"3 11 22 2 13 21 11 13 3 11"}]],"nepali-rupee":[["path",{"d":"M18 16.173 A4.74 4.74 0 0 0 13.496 8.005"}],["path",{"d":"M4 3 L20 3"}],["path",{"d":"M5 13 L13.5 21"}],["path",{"d":"M5 13 L9 13"}],["path",{"d":"M8 13 C15.5 13 14.667 3 8 3"}]],"network":[["rect",{"x":"16","y":"16","width":"6","height":"6","rx":"1"}],["rect",{"x":"2","y":"16","width":"6","height":"6","rx":"1"}],["rect",{"x":"9","y":"2","width":"6","height":"6","rx":"1"}],["path",{"d":"M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"}],["path",{"d":"M12 12V8"}]],"newspaper":[["path",{"d":"M15 18h-5"}],["path",{"d":"M18 14h-8"}],["path",{"d":"M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-4 0v-9a2 2 0 0 1 2-2h2"}],["rect",{"width":"8","height":"4","x":"10","y":"6","rx":"1"}]],"nfc":[["path",{"d":"M6 8.32a7.43 7.43 0 0 1 0 7.36"}],["path",{"d":"M9.46 6.21a11.76 11.76 0 0 1 0 11.58"}],["path",{"d":"M12.91 4.1a15.91 15.91 0 0 1 .01 15.8"}],["path",{"d":"M16.37 2a20.16 20.16 0 0 1 0 20"}]],"non-binary":[["path",{"d":"M12 2v10"}],["path",{"d":"m8.5 4 7 4"}],["path",{"d":"m8.5 8 7-4"}],["circle",{"cx":"12","cy":"17","r":"5"}]],"notebook-dot":[["path",{"d":"M16 11.75V22"}],["path",{"d":"M2 10h4"}],["path",{"d":"M2 14h4"}],["path",{"d":"M2 18h4"}],["path",{"d":"M2 6h4"}],["path",{"d":"M20 11.75V20a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h5.65"}],["circle",{"cx":"18","cy":"5","r":"3"}]],"notebook-pen":[["path",{"d":"M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4"}],["path",{"d":"M2 6h4"}],["path",{"d":"M2 10h4"}],["path",{"d":"M2 14h4"}],["path",{"d":"M2 18h4"}],["path",{"d":"M21.378 5.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z"}]],"notebook-tabs":[["path",{"d":"M2 6h4"}],["path",{"d":"M2 10h4"}],["path",{"d":"M2 14h4"}],["path",{"d":"M2 18h4"}],["rect",{"width":"16","height":"20","x":"4","y":"2","rx":"2"}],["path",{"d":"M15 2v20"}],["path",{"d":"M15 7h5"}],["path",{"d":"M15 12h5"}],["path",{"d":"M15 17h5"}]],"notebook-text":[["path",{"d":"M2 6h4"}],["path",{"d":"M2 10h4"}],["path",{"d":"M2 14h4"}],["path",{"d":"M2 18h4"}],["rect",{"width":"16","height":"20","x":"4","y":"2","rx":"2"}],["path",{"d":"M9.5 8h5"}],["path",{"d":"M9.5 12H16"}],["path",{"d":"M9.5 16H14"}]],"notebook":[["path",{"d":"M2 6h4"}],["path",{"d":"M2 10h4"}],["path",{"d":"M2 14h4"}],["path",{"d":"M2 18h4"}],["rect",{"width":"16","height":"20","x":"4","y":"2","rx":"2"}],["path",{"d":"M16 2v20"}]],"notepad-text-dashed":[["path",{"d":"M8 2v4"}],["path",{"d":"M12 2v4"}],["path",{"d":"M16 2v4"}],["path",{"d":"M16 4h2a2 2 0 0 1 2 2v2"}],["path",{"d":"M20 12v2"}],["path",{"d":"M20 18v2a2 2 0 0 1-2 2h-1"}],["path",{"d":"M13 22h-2"}],["path",{"d":"M7 22H6a2 2 0 0 1-2-2v-2"}],["path",{"d":"M4 14v-2"}],["path",{"d":"M4 8V6a2 2 0 0 1 2-2h2"}],["path",{"d":"M8 10h6"}],["path",{"d":"M8 14h8"}],["path",{"d":"M8 18h5"}]],"notepad-text":[["path",{"d":"M8 2v4"}],["path",{"d":"M12 2v4"}],["path",{"d":"M16 2v4"}],["rect",{"width":"16","height":"18","x":"4","y":"4","rx":"2"}],["path",{"d":"M8 10h6"}],["path",{"d":"M8 14h8"}],["path",{"d":"M8 18h5"}]],"nut-off":[["path",{"d":"M11.868 11.868a.88.88 0 01-.488.252c-1.78.28-3.54-.17-4.88-.62 0 1.272-.229 3.578-.653 5.347a10 10 0 01-.417 1.363c-.21.52-.82.55-1.17.12a10 10 0 01.677-13.393"}],["path",{"d":"M12.14 6.485a27.4 27.4 0 004.707-.638L20 9a7.23 7.23 0 011.706 7.05"}],["path",{"d":"m2 2 20 20"}],["path",{"d":"M20.707 20.707A1 1 0 0120 21h-1c-1.069 0-1.648.242-2.485.552A7.2 7.2 0 019.002 20l-3.155-3.153"}],["path",{"d":"M8.356 2.7a10 10 0 019.974 1.56c.43.35.4.97-.12 1.17a10 10 0 01-1.363.417"}]],"nut":[["path",{"d":"M16.847 5.847 20 9a7.23 7.23 0 011.551 7.516C21.241 17.352 21 17.932 21 19v1a1 1 0 01-1 1h-1c-1.069 0-1.648.242-2.485.552A7.2 7.2 0 019.002 20l-3.155-3.153"}],["path",{"d":"M18.21 5.43c-1.71.69-5.07 1.07-6.71 1.07.46 1.38.91 2.74.61 4.88a.88.88 0 01-.73.74c-1.78.28-3.54-.17-4.88-.62 0 1.64-.38 5-1.07 6.71-.21.52-.82.55-1.17.12A10 10 0 0118.33 4.26c.43.35.4.97-.12 1.17"}],["path",{"d":"M4.93 4.93 3 3a.7.7 0 010-1"}]],"octagon-alert":[["path",{"d":"M12 16h.01"}],["path",{"d":"M12 8v4"}],["path",{"d":"M15.312 2a2 2 0 0 1 1.414.586l4.688 4.688A2 2 0 0 1 22 8.688v6.624a2 2 0 0 1-.586 1.414l-4.688 4.688a2 2 0 0 1-1.414.586H8.688a2 2 0 0 1-1.414-.586l-4.688-4.688A2 2 0 0 1 2 15.312V8.688a2 2 0 0 1 .586-1.414l4.688-4.688A2 2 0 0 1 8.688 2z"}]],"octagon-minus":[["path",{"d":"M2.586 16.726A2 2 0 0 1 2 15.312V8.688a2 2 0 0 1 .586-1.414l4.688-4.688A2 2 0 0 1 8.688 2h6.624a2 2 0 0 1 1.414.586l4.688 4.688A2 2 0 0 1 22 8.688v6.624a2 2 0 0 1-.586 1.414l-4.688 4.688a2 2 0 0 1-1.414.586H8.688a2 2 0 0 1-1.414-.586z"}],["path",{"d":"M8 12h8"}]],"octagon-pause":[["path",{"d":"M10 15V9"}],["path",{"d":"M14 15V9"}],["path",{"d":"M2.586 16.726A2 2 0 0 1 2 15.312V8.688a2 2 0 0 1 .586-1.414l4.688-4.688A2 2 0 0 1 8.688 2h6.624a2 2 0 0 1 1.414.586l4.688 4.688A2 2 0 0 1 22 8.688v6.624a2 2 0 0 1-.586 1.414l-4.688 4.688a2 2 0 0 1-1.414.586H8.688a2 2 0 0 1-1.414-.586z"}]],"octagon-x":[["path",{"d":"m15 9-6 6"}],["path",{"d":"M2.586 16.726A2 2 0 0 1 2 15.312V8.688a2 2 0 0 1 .586-1.414l4.688-4.688A2 2 0 0 1 8.688 2h6.624a2 2 0 0 1 1.414.586l4.688 4.688A2 2 0 0 1 22 8.688v6.624a2 2 0 0 1-.586 1.414l-4.688 4.688a2 2 0 0 1-1.414.586H8.688a2 2 0 0 1-1.414-.586z"}],["path",{"d":"m9 9 6 6"}]],"octagon":[["path",{"d":"M2.586 16.726A2 2 0 0 1 2 15.312V8.688a2 2 0 0 1 .586-1.414l4.688-4.688A2 2 0 0 1 8.688 2h6.624a2 2 0 0 1 1.414.586l4.688 4.688A2 2 0 0 1 22 8.688v6.624a2 2 0 0 1-.586 1.414l-4.688 4.688a2 2 0 0 1-1.414.586H8.688a2 2 0 0 1-1.414-.586z"}]],"omega":[["path",{"d":"M3 20h4.5a.5.5 0 0 0 .5-.5v-.282a.52.52 0 0 0-.247-.437 8 8 0 1 1 8.494-.001.52.52 0 0 0-.247.438v.282a.5.5 0 0 0 .5.5H21"}]],"option":[["path",{"d":"M14 3h7"}],["path",{"d":"M3 3h5.28a1 1 0 0 1 .948.684l5.544 16.632a1 1 0 0 0 .949.684H21"}]],"orbit":[["path",{"d":"M20.341 6.484A10 10 0 0 1 10.266 21.85"}],["path",{"d":"M3.659 17.516A10 10 0 0 1 13.74 2.152"}],["circle",{"cx":"12","cy":"12","r":"3"}],["circle",{"cx":"19","cy":"5","r":"2"}],["circle",{"cx":"5","cy":"19","r":"2"}]],"origami":[["path",{"d":"M12 12V4a1 1 0 0 1 1-1h6.297a1 1 0 0 1 .651 1.759l-4.696 4.025"}],["path",{"d":"m12 21-7.414-7.414A2 2 0 0 1 4 12.172V6.415a1.002 1.002 0 0 1 1.707-.707L20 20.009"}],["path",{"d":"m12.214 3.381 8.414 14.966a1 1 0 0 1-.167 1.199l-1.168 1.163a1 1 0 0 1-.706.291H6.351a1 1 0 0 1-.625-.219L3.25 18.8a1 1 0 0 1 .631-1.781l4.165.027"}]],"package-2":[["path",{"d":"M12 3v6"}],["path",{"d":"M16.76 3a2 2 0 0 1 1.8 1.1l2.23 4.479a2 2 0 0 1 .21.891V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9.472a2 2 0 0 1 .211-.894L5.45 4.1A2 2 0 0 1 7.24 3z"}],["path",{"d":"M3.054 9.013h17.893"}]],"package-check":[["path",{"d":"M12 22V12"}],["path",{"d":"m16 17 2 2 4-4"}],["path",{"d":"M21 11.127V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.729l7 4a2 2 0 0 0 2 .001l1.32-.753"}],["path",{"d":"M3.29 7 12 12l8.71-5"}],["path",{"d":"m7.5 4.27 8.997 5.148"}]],"package-minus":[["path",{"d":"M12 22V12"}],["path",{"d":"M16 17h6"}],["path",{"d":"M21 13V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.729l7 4a2 2 0 0 0 2 .001l1.675-.955"}],["path",{"d":"M3.29 7 12 12l8.71-5"}],["path",{"d":"m7.5 4.27 8.997 5.148"}]],"package-open":[["path",{"d":"M12 22v-9"}],["path",{"d":"M15.17 2.21a1.67 1.67 0 0 1 1.63 0L21 4.57a1.93 1.93 0 0 1 0 3.36L8.82 14.79a1.655 1.655 0 0 1-1.64 0L3 12.43a1.93 1.93 0 0 1 0-3.36z"}],["path",{"d":"M20 13v3.87a2.06 2.06 0 0 1-1.11 1.83l-6 3.08a1.93 1.93 0 0 1-1.78 0l-6-3.08A2.06 2.06 0 0 1 4 16.87V13"}],["path",{"d":"M21 12.43a1.93 1.93 0 0 0 0-3.36L8.83 2.2a1.64 1.64 0 0 0-1.63 0L3 4.57a1.93 1.93 0 0 0 0 3.36l12.18 6.86a1.636 1.636 0 0 0 1.63 0z"}]],"package-plus":[["path",{"d":"M12 22V12"}],["path",{"d":"M16 17h6"}],["path",{"d":"M19 14v6"}],["path",{"d":"M21 10.535V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.729l7 4a2 2 0 0 0 2 .001l1.675-.955"}],["path",{"d":"M3.29 7 12 12l8.71-5"}],["path",{"d":"m7.5 4.27 8.997 5.148"}]],"package-search":[["path",{"d":"M12 22V12"}],["path",{"d":"M20.27 18.27 22 20"}],["path",{"d":"M21 10.498V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.729l7 4a2 2 0 0 0 2 .001l.98-.559"}],["path",{"d":"M3.29 7 12 12l8.71-5"}],["path",{"d":"m7.5 4.27 8.997 5.148"}],["circle",{"cx":"18.5","cy":"16.5","r":"2.5"}]],"package-x":[["path",{"d":"M12 22V12"}],["path",{"d":"m16.5 14.5 5 5"}],["path",{"d":"m16.5 19.5 5-5"}],["path",{"d":"M21 10.5V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.729l7 4a2 2 0 0 0 2 .001l.13-.074"}],["path",{"d":"M3.29 7 12 12l8.71-5"}],["path",{"d":"m7.5 4.27 8.997 5.148"}]],"package":[["path",{"d":"M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"}],["path",{"d":"M12 22V12"}],["polyline",{"points":"3.29 7 12 12 20.71 7"}],["path",{"d":"m7.5 4.27 9 5.15"}]],"paint-bucket":[["path",{"d":"M11 7 6 2"}],["path",{"d":"M18.992 12H2.041"}],["path",{"d":"M21.145 18.38A3.34 3.34 0 0 1 20 16.5a3.3 3.3 0 0 1-1.145 1.88c-.575.46-.855 1.02-.855 1.595A2 2 0 0 0 20 22a2 2 0 0 0 2-2.025c0-.58-.285-1.13-.855-1.595"}],["path",{"d":"m8.5 4.5 2.148-2.148a1.205 1.205 0 0 1 1.704 0l7.296 7.296a1.205 1.205 0 0 1 0 1.704l-7.592 7.592a3.615 3.615 0 0 1-5.112 0l-3.888-3.888a3.615 3.615 0 0 1 0-5.112L5.67 7.33"}]],"paint-roller":[["rect",{"width":"16","height":"6","x":"2","y":"2","rx":"2"}],["path",{"d":"M10 16v-2a2 2 0 0 1 2-2h8a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"}],["rect",{"width":"4","height":"6","x":"8","y":"16","rx":"1"}]],"paintbrush-vertical":[["path",{"d":"M10 2v2"}],["path",{"d":"M14 2v4"}],["path",{"d":"M17 2a1 1 0 0 1 1 1v9H6V3a1 1 0 0 1 1-1z"}],["path",{"d":"M6 12a1 1 0 0 0-1 1v1a2 2 0 0 0 2 2h2a1 1 0 0 1 1 1v2.9a2 2 0 1 0 4 0V17a1 1 0 0 1 1-1h2a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1"}]],"paintbrush":[["path",{"d":"m14.622 17.897-10.68-2.913"}],["path",{"d":"M18.376 2.622a1 1 0 1 1 3.002 3.002L17.36 9.643a.5.5 0 0 0 0 .707l.944.944a2.41 2.41 0 0 1 0 3.408l-.944.944a.5.5 0 0 1-.707 0L8.354 7.348a.5.5 0 0 1 0-.707l.944-.944a2.41 2.41 0 0 1 3.408 0l.944.944a.5.5 0 0 0 .707 0z"}],["path",{"d":"M9 8c-1.804 2.71-3.97 3.46-6.583 3.948a.507.507 0 0 0-.302.819l7.32 8.883a1 1 0 0 0 1.185.204C12.735 20.405 16 16.792 16 15"}]],"palette":[["path",{"d":"M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z"}],["circle",{"cx":"13.5","cy":"6.5","r":".5","fill":"currentColor"}],["circle",{"cx":"17.5","cy":"10.5","r":".5","fill":"currentColor"}],["circle",{"cx":"6.5","cy":"12.5","r":".5","fill":"currentColor"}],["circle",{"cx":"8.5","cy":"7.5","r":".5","fill":"currentColor"}]],"panda":[["path",{"d":"M11.25 17.25h1.5L12 18z"}],["path",{"d":"m15 12 2 2"}],["path",{"d":"M17.902 6.599a8 8 0 0 0-.5-.5"}],["path",{"d":"M2 14.5C2 19.47 6.48 22 12 22s10-2.53 10-7.5a10 10 0 0 0-1.3-4.83 4.5 4.5 0 1 0-7.05-5.5 8 8 0 0 0-3.3 0 4.5 4.5 0 1 0-7.04 5.5A10 10 0 0 0 2 14.5"}],["path",{"d":"M6.099 6.599a8 8 0 0 1 .5-.5"}],["path",{"d":"m9 12-2 2"}]],"panel-bottom-close":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M3 15h18"}],["path",{"d":"m15 8-3 3-3-3"}]],"panel-bottom-dashed":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M14 15h1"}],["path",{"d":"M19 15h2"}],["path",{"d":"M3 15h2"}],["path",{"d":"M9 15h1"}]],"panel-bottom-open":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M3 15h18"}],["path",{"d":"m9 10 3-3 3 3"}]],"panel-bottom":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M3 15h18"}]],"panel-left-close":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M9 3v18"}],["path",{"d":"m16 15-3-3 3-3"}]],"panel-left-dashed":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M9 14v1"}],["path",{"d":"M9 19v2"}],["path",{"d":"M9 3v2"}],["path",{"d":"M9 9v1"}]],"panel-left-open":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M9 3v18"}],["path",{"d":"m14 9 3 3-3 3"}]],"panel-left-right-dashed":[["path",{"d":"M15 10V9"}],["path",{"d":"M15 15v-1"}],["path",{"d":"M15 21v-2"}],["path",{"d":"M15 5V3"}],["path",{"d":"M9 10V9"}],["path",{"d":"M9 15v-1"}],["path",{"d":"M9 21v-2"}],["path",{"d":"M9 5V3"}],["rect",{"x":"3","y":"3","width":"18","height":"18","rx":"2"}]],"panel-left":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M9 3v18"}]],"panel-right-close":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M15 3v18"}],["path",{"d":"m8 9 3 3-3 3"}]],"panel-right-dashed":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M15 14v1"}],["path",{"d":"M15 19v2"}],["path",{"d":"M15 3v2"}],["path",{"d":"M15 9v1"}]],"panel-right-open":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M15 3v18"}],["path",{"d":"m10 15-3-3 3-3"}]],"panel-right":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M15 3v18"}]],"panel-top-bottom-dashed":[["path",{"d":"M14 15h1"}],["path",{"d":"M14 9h1"}],["path",{"d":"M19 15h2"}],["path",{"d":"M19 9h2"}],["path",{"d":"M3 15h2"}],["path",{"d":"M3 9h2"}],["path",{"d":"M9 15h1"}],["path",{"d":"M9 9h1"}],["rect",{"x":"3","y":"3","width":"18","height":"18","rx":"2"}]],"panel-top-close":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M3 9h18"}],["path",{"d":"m9 16 3-3 3 3"}]],"panel-top-dashed":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M14 9h1"}],["path",{"d":"M19 9h2"}],["path",{"d":"M3 9h2"}],["path",{"d":"M9 9h1"}]],"panel-top-open":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M3 9h18"}],["path",{"d":"m15 14-3 3-3-3"}]],"panel-top":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M3 9h18"}]],"panels-left-bottom":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M9 3v18"}],["path",{"d":"M9 15h12"}]],"panels-right-bottom":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M3 15h12"}],["path",{"d":"M15 3v18"}]],"panels-top-left":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M3 9h18"}],["path",{"d":"M9 21V9"}]],"paper-bag":[["path",{"d":"M5.364 3.848C4 6 3 9.652 3 12.652V19a2 2 0 002 2h14a2 2 0 002-2v-5c0-2.334-1.816-4.668-2.622-7.002"}],["path",{"d":"M7 3h11.379a2 2 0 011.789 1.106l.723 1.447A1 1 0 0119.997 7h-8.525a2 2 0 01-1.789-1.106L8.79 4.105a2 2 0 10-3.579 1.789l2.261 4.522A5 5 0 018 12.652V21"}]],"paperclip":[["path",{"d":"m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551"}]],"parasol":[["path",{"d":"M12.5 11.134 18.196 21"}],["path",{"d":"M20.425 5.299a10 10 0 0 0-16.941 9.78c.183.563.843.774 1.355.478L20.16 6.711c.512-.296.66-.973.264-1.413"}],["path",{"d":"M21 21H3"}]],"parentheses":[["path",{"d":"M8 21s-4-3-4-9 4-9 4-9"}],["path",{"d":"M16 3s4 3 4 9-4 9-4 9"}]],"park":[["path",{"d":"M12 18h10"}],["path",{"d":"M13.248 9.998A4.5 4.5 0 0 0 11.75 8.6V8a1 1 0 0 0-7.5 0 4.9 4.9 0 0 0 2.25 9H8"}],["path",{"d":"m15 14-2 6"}],["path",{"d":"m19 14 2 6"}],["path",{"d":"M21 14h-8"}],["path",{"d":"M8 20v-5.922a2 2 0 0 0-.586-1.414L6.5 11.75"}],["path",{"d":"M9.205 12.795 8 14"}],["circle",{"cx":"19","cy":"6","r":"2"}]],"parking-meter":[["path",{"d":"M11 15h2"}],["path",{"d":"M12 12v3"}],["path",{"d":"M12 19v3"}],["path",{"d":"M15.282 19a1 1 0 0 0 .948-.68l2.37-6.988a7 7 0 1 0-13.2 0l2.37 6.988a1 1 0 0 0 .948.68z"}],["path",{"d":"M9 9a3 3 0 1 1 6 0"}]],"party-popper":[["path",{"d":"M5.8 11.3 2 22l10.7-3.79"}],["path",{"d":"M4 3h.01"}],["path",{"d":"M22 8h.01"}],["path",{"d":"M15 2h.01"}],["path",{"d":"M22 20h.01"}],["path",{"d":"m22 2-2.24.75a2.9 2.9 0 0 0-1.96 3.12c.1.86-.57 1.63-1.45 1.63h-.38c-.86 0-1.6.6-1.76 1.44L14 10"}],["path",{"d":"m22 13-.82-.33c-.86-.34-1.82.2-1.98 1.11c-.11.7-.72 1.22-1.43 1.22H17"}],["path",{"d":"m11 2 .33.82c.34.86-.2 1.82-1.11 1.98C9.52 4.9 9 5.52 9 6.23V7"}],["path",{"d":"M11 13c1.93 1.93 2.83 4.17 2 5-.83.83-3.07-.07-5-2-1.93-1.93-2.83-4.17-2-5 .83-.83 3.07.07 5 2Z"}]],"pause":[["rect",{"x":"14","y":"3","width":"5","height":"18","rx":"1"}],["rect",{"x":"5","y":"3","width":"5","height":"18","rx":"1"}]],"paw-print":[["circle",{"cx":"11","cy":"4","r":"2"}],["circle",{"cx":"18","cy":"8","r":"2"}],["circle",{"cx":"20","cy":"16","r":"2"}],["path",{"d":"M9 10a5 5 0 0 1 5 5v3.5a3.5 3.5 0 0 1-6.84 1.045Q6.52 17.48 4.46 16.84A3.5 3.5 0 0 1 5.5 10Z"}]],"pc-case":[["rect",{"width":"14","height":"20","x":"5","y":"2","rx":"2"}],["path",{"d":"M15 14h.01"}],["path",{"d":"M9 6h6"}],["path",{"d":"M9 10h6"}]],"pen-line":[["path",{"d":"M13 21h8"}],["path",{"d":"M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"}]],"pen-off":[["path",{"d":"m10 10-6.157 6.162a2 2 0 0 0-.5.833l-1.322 4.36a.5.5 0 0 0 .622.624l4.358-1.323a2 2 0 0 0 .83-.5L14 13.982"}],["path",{"d":"m12.829 7.172 4.359-4.346a1 1 0 1 1 3.986 3.986l-4.353 4.353"}],["path",{"d":"m2 2 20 20"}]],"pen-tool":[["path",{"d":"M15.707 21.293a1 1 0 0 1-1.414 0l-1.586-1.586a1 1 0 0 1 0-1.414l5.586-5.586a1 1 0 0 1 1.414 0l1.586 1.586a1 1 0 0 1 0 1.414z"}],["path",{"d":"m18 13-1.375-6.874a1 1 0 0 0-.746-.776L3.235 2.028a1 1 0 0 0-1.207 1.207L5.35 15.879a1 1 0 0 0 .776.746L13 18"}],["path",{"d":"m2.3 2.3 7.286 7.286"}],["circle",{"cx":"11","cy":"11","r":"2"}]],"pen":[["path",{"d":"M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"}]],"pencil-line":[["path",{"d":"M13 21h8"}],["path",{"d":"m15 5 4 4"}],["path",{"d":"M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"}]],"pencil-off":[["path",{"d":"m10 10-6.157 6.162a2 2 0 0 0-.5.833l-1.322 4.36a.5.5 0 0 0 .622.624l4.358-1.323a2 2 0 0 0 .83-.5L14 13.982"}],["path",{"d":"m12.829 7.172 4.359-4.346a1 1 0 1 1 3.986 3.986l-4.353 4.353"}],["path",{"d":"m15 5 4 4"}],["path",{"d":"m2 2 20 20"}]],"pencil-ruler":[["path",{"d":"M13 7 8.7 2.7a2.41 2.41 0 0 0-3.4 0L2.7 5.3a2.41 2.41 0 0 0 0 3.4L7 13"}],["path",{"d":"m8 6 2-2"}],["path",{"d":"m18 16 2-2"}],["path",{"d":"m17 11 4.3 4.3c.94.94.94 2.46 0 3.4l-2.6 2.6c-.94.94-2.46.94-3.4 0L11 17"}],["path",{"d":"M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"}],["path",{"d":"m15 5 4 4"}]],"pencil-sparkles":[["path",{"d":"M10 3H8"}],["path",{"d":"m15.007 5.008 3.987 3.986"}],["path",{"d":"M20 15v4"}],["path",{"d":"M21.174 6.813a2.82 2.82 0 0 0-3.986-3.987L3.842 16.175a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"}],["path",{"d":"M22 17h-4"}],["path",{"d":"M4 5v4"}],["path",{"d":"M6 7H2"}],["path",{"d":"M9 2v2"}]],"pencil":[["path",{"d":"M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"}],["path",{"d":"m15 5 4 4"}]],"pentagon":[["path",{"d":"M10.83 2.38a2 2 0 0 1 2.34 0l8 5.74a2 2 0 0 1 .73 2.25l-3.04 9.26a2 2 0 0 1-1.9 1.37H7.04a2 2 0 0 1-1.9-1.37L2.1 10.37a2 2 0 0 1 .73-2.25z"}]],"percent":[["line",{"x1":"19","x2":"5","y1":"5","y2":"19"}],["circle",{"cx":"6.5","cy":"6.5","r":"2.5"}],["circle",{"cx":"17.5","cy":"17.5","r":"2.5"}]],"person-standing":[["circle",{"cx":"12","cy":"5","r":"1"}],["path",{"d":"m9 20 3-6 3 6"}],["path",{"d":"m6 8 6 2 6-2"}],["path",{"d":"M12 10v4"}]],"phi":[["path",{"d":"M12 2v20"}],["circle",{"cx":"12","cy":"12","r":"7"}]],"philippine-peso":[["path",{"d":"M20 11H4"}],["path",{"d":"M20 7H4"}],["path",{"d":"M7 21V4a1 1 0 0 1 1-1h4a1 1 0 0 1 0 12H7"}]],"phone-call":[["path",{"d":"M13 2a9 9 0 0 1 9 9"}],["path",{"d":"M13 6a5 5 0 0 1 5 5"}],["path",{"d":"M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384"}]],"phone-forwarded":[["path",{"d":"M14 6h8"}],["path",{"d":"m18 2 4 4-4 4"}],["path",{"d":"M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384"}]],"phone-incoming":[["path",{"d":"M16 2v6h6"}],["path",{"d":"m22 2-6 6"}],["path",{"d":"M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384"}]],"phone-missed":[["path",{"d":"m16 2 6 6"}],["path",{"d":"m22 2-6 6"}],["path",{"d":"M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384"}]],"phone-off":[["path",{"d":"M10.1 13.9a14 14 0 0 0 3.732 2.668 1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2 18 18 0 0 1-12.728-5.272"}],["path",{"d":"M22 2 2 22"}],["path",{"d":"M4.76 13.582A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 .244.473"}]],"phone-outgoing":[["path",{"d":"m16 8 6-6"}],["path",{"d":"M22 8V2h-6"}],["path",{"d":"M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384"}]],"phone":[["path",{"d":"M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384"}]],"pi":[["line",{"x1":"9","x2":"9","y1":"4","y2":"20"}],["path",{"d":"M4 7c0-1.7 1.3-3 3-3h13"}],["path",{"d":"M18 20c-1.7 0-3-1.3-3-3V4"}]],"piano":[["path",{"d":"M10 13v4"}],["path",{"d":"M14 13v4"}],["path",{"d":"M18 13v4"}],["path",{"d":"M2 13h20"}],["path",{"d":"M22 11.5A3.5 3.5 0 0018.5 8a3.52 3.52 0 01-3.173-2A7 7 0 002 9v10a2 2 0 002 2h16a2 2 0 002-2z"}],["path",{"d":"M6 13v4"}]],"pickaxe":[["path",{"d":"m14 13-8.381 8.38a1 1 0 0 1-3.001-3L11 9.999"}],["path",{"d":"M15.973 4.027A13 13 0 0 0 5.902 2.373c-1.398.342-1.092 2.158.277 2.601a19.9 19.9 0 0 1 5.822 3.024"}],["path",{"d":"M16.001 11.999a19.9 19.9 0 0 1 3.024 5.824c.444 1.369 2.26 1.676 2.603.278A13 13 0 0 0 20 8.069"}],["path",{"d":"M18.352 3.352a1.205 1.205 0 0 0-1.704 0l-5.296 5.296a1.205 1.205 0 0 0 0 1.704l2.296 2.296a1.205 1.205 0 0 0 1.704 0l5.296-5.296a1.205 1.205 0 0 0 0-1.704z"}]],"picture-in-picture-2":[["path",{"d":"M21 9V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10c0 1.1.9 2 2 2h4"}],["rect",{"width":"10","height":"7","x":"12","y":"13","rx":"2"}]],"picture-in-picture":[["path",{"d":"M2 10h6V4"}],["path",{"d":"m2 4 6 6"}],["path",{"d":"M21 10V7a2 2 0 0 0-2-2h-7"}],["path",{"d":"M3 14v2a2 2 0 0 0 2 2h3"}],["rect",{"x":"12","y":"14","width":"10","height":"7","rx":"1"}]],"piggy-bank":[["path",{"d":"M11 17h3v2a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1v-3a3.16 3.16 0 0 0 2-2h1a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1h-1a5 5 0 0 0-2-4V3a4 4 0 0 0-3.2 1.6l-.3.4H11a6 6 0 0 0-6 6v1a5 5 0 0 0 2 4v3a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1z"}],["path",{"d":"M16 10h.01"}],["path",{"d":"M2 8v1a2 2 0 0 0 2 2h1"}]],"pilcrow-left":[["path",{"d":"M14 3v11"}],["path",{"d":"M14 9h-3a3 3 0 0 1 0-6h9"}],["path",{"d":"M18 3v11"}],["path",{"d":"M22 18H2l4-4"}],["path",{"d":"m6 22-4-4"}]],"pilcrow-right":[["path",{"d":"M10 3v11"}],["path",{"d":"M10 9H7a1 1 0 0 1 0-6h8"}],["path",{"d":"M14 3v11"}],["path",{"d":"m18 14 4 4H2"}],["path",{"d":"m22 18-4 4"}]],"pilcrow":[["path",{"d":"M13 4v16"}],["path",{"d":"M17 4v16"}],["path",{"d":"M19 4H9.5a4.5 4.5 0 0 0 0 9H13"}]],"pill-bottle":[["path",{"d":"M18 11h-4a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h4"}],["path",{"d":"M6 7v13a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7"}],["rect",{"width":"16","height":"5","x":"4","y":"2","rx":"1"}]],"pill":[["path",{"d":"m10.5 20.5 10-10a4.95 4.95 0 1 0-7-7l-10 10a4.95 4.95 0 1 0 7 7Z"}],["path",{"d":"m8.5 8.5 7 7"}]],"pin-off":[["path",{"d":"M12 17v5"}],["path",{"d":"M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89"}],["path",{"d":"m2 2 20 20"}],["path",{"d":"M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11"}]],"pin":[["path",{"d":"M12 17v5"}],["path",{"d":"M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"}]],"pipette":[["path",{"d":"m12 9-8.414 8.414A2 2 0 0 0 3 18.828v1.344a2 2 0 0 1-.586 1.414A2 2 0 0 1 3.828 21h1.344a2 2 0 0 0 1.414-.586L15 12"}],["path",{"d":"m18 9 .4.4a1 1 0 1 1-3 3l-3.8-3.8a1 1 0 1 1 3-3l.4.4 3.4-3.4a1 1 0 1 1 3 3z"}],["path",{"d":"m2 22 .414-.414"}]],"pizza":[["path",{"d":"m12 14-1 1"}],["path",{"d":"m13.75 18.25-1.25 1.42"}],["path",{"d":"M17.775 5.654a15.68 15.68 0 0 0-12.121 12.12"}],["path",{"d":"M18.8 9.3a1 1 0 0 0 2.1 7.7"}],["path",{"d":"M21.964 20.732a1 1 0 0 1-1.232 1.232l-18-5a1 1 0 0 1-.695-1.232A19.68 19.68 0 0 1 15.732 2.037a1 1 0 0 1 1.232.695z"}]],"plane-landing":[["path",{"d":"M2 22h20"}],["path",{"d":"M3.77 10.77 2 9l2-4.5 1.1.55c.55.28.9.84.9 1.45s.35 1.17.9 1.45L8 8.5l3-6 1.05.53a2 2 0 0 1 1.09 1.52l.72 5.4a2 2 0 0 0 1.09 1.52l4.4 2.2c.42.22.78.55 1.01.96l.6 1.03c.49.88-.06 1.98-1.06 2.1l-1.18.15c-.47.06-.95-.02-1.37-.24L4.29 11.15a2 2 0 0 1-.52-.38Z"}]],"plane-takeoff":[["path",{"d":"M2 22h20"}],["path",{"d":"M6.36 17.4 4 17l-2-4 1.1-.55a2 2 0 0 1 1.8 0l.17.1a2 2 0 0 0 1.8 0L8 12 5 6l.9-.45a2 2 0 0 1 2.09.2l4.02 3a2 2 0 0 0 2.1.2l4.19-2.06a2.41 2.41 0 0 1 1.73-.17L21 7a1.4 1.4 0 0 1 .87 1.99l-.38.76c-.23.46-.6.84-1.07 1.08L7.58 17.2a2 2 0 0 1-1.22.18Z"}]],"plane":[["path",{"d":"M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"}]],"plant-pot":[["path",{"d":"M14 8.536V6a4 4 0 014-4h1.5a.5.5 0 01.5.5V4a4 4 0 01-4 4 4 4 0 00-4 4 5 5 0 01-8-4 5 5 0 018 4c0 2 1 3 1 5"}],["path",{"d":"m18 17-1.085 3.58A2 2 0 0115 22H9.002a2 2 0 01-1.913-1.418L6 17"}],["path",{"d":"M5 17h14"}]],"play-off":[["path",{"d":"m10.215 4.56 9.79 5.71a2 2 0 0 1 .003 3.458l-.393.23"}],["path",{"d":"m16.042 16.042-8.034 4.686A2 2 0 0 1 5 19V5"}],["path",{"d":"m2 2 20 20"}]],"play":[["path",{"d":"M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"}]],"playing-card":[["path",{"d":"M12.832 8.445a1 1 0 00-1.589-.098l-2.075 3.098a1 1 0 000 1.11l2 3a1 1 0 001.664 0l2-3a1 1 0 000-1.11z"}],["rect",{"x":"5","y":"2","width":"14","height":"20","rx":"2"}]],"playing-cards-fan":[["path",{"d":"M12.65 7.65a2 2 0 012.629-1.046l5.51 2.374a2 2 0 011.046 2.628l-3.957 9.184a2 2 0 01-2.628 1.046l-5.51-2.374a2 2 0 01-1.046-2.628z"}],["path",{"d":"M18 7.777V4a2 2 0 00-2-2h-6a2 2 0 00-2 2v10a2 2 0 001.137 1.805"}],["path",{"d":"m8 4.389-4.364.809a2 2 0 00-1.602 2.33l1.822 9.833a2 2 0 002.331 1.602l2.542-.47"}]],"playing-cards":[["path",{"d":"M14.832 8.445a1 1 0 00-1.589-.098l-2.075 3.098a1 1 0 000 1.11l2 3a1 1 0 001.664 0l2-3a1 1 0 000-1.11z"}],["path",{"d":"m7.18 20.827-5-11a2 2 0 01.993-2.647L7 5.44"}],["rect",{"x":"7","y":"2","width":"14","height":"20","rx":"2"}]],"plug-2":[["path",{"d":"M9 2v6"}],["path",{"d":"M15 2v6"}],["path",{"d":"M12 17v5"}],["path",{"d":"M5 8h14"}],["path",{"d":"M6 11V8h12v3a6 6 0 1 1-12 0Z"}]],"plug-zap":[["path",{"d":"M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z"}],["path",{"d":"m2 22 3-3"}],["path",{"d":"M7.5 13.5 10 11"}],["path",{"d":"M10.5 16.5 13 14"}],["path",{"d":"m18 3-4 4h6l-4 4"}]],"plug":[["path",{"d":"M12 22v-5"}],["path",{"d":"M15 8V2"}],["path",{"d":"M17 8a1 1 0 0 1 1 1v4a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1z"}],["path",{"d":"M9 8V2"}]],"plus":[["path",{"d":"M5 12h14"}],["path",{"d":"M12 5v14"}]],"pocket-knife":[["path",{"d":"M3 2v1c0 1 2 1 2 2S3 6 3 7s2 1 2 2-2 1-2 2 2 1 2 2"}],["path",{"d":"M18 6h.01"}],["path",{"d":"M6 18h.01"}],["path",{"d":"M20.83 8.83a4 4 0 0 0-5.66-5.66l-12 12a4 4 0 1 0 5.66 5.66Z"}],["path",{"d":"M18 11.66V22a4 4 0 0 0 4-4V6"}]],"podium":[["path",{"d":"M12 6V2h-1"}],["path",{"d":"M9 15a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-3a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1"}],["path",{"d":"M9 21V11a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v10"}]],"pointer-off":[["path",{"d":"M10 4.5V4a2 2 0 0 0-2.41-1.957"}],["path",{"d":"M13.9 8.4a2 2 0 0 0-1.26-1.295"}],["path",{"d":"M21.7 16.2A8 8 0 0 0 22 14v-3a2 2 0 1 0-4 0v-1a2 2 0 0 0-3.63-1.158"}],["path",{"d":"m7 15-1.8-1.8a2 2 0 0 0-2.79 2.86L6 19.7a7.74 7.74 0 0 0 6 2.3h2a8 8 0 0 0 5.657-2.343"}],["path",{"d":"M6 6v8"}],["path",{"d":"m2 2 20 20"}]],"pointer":[["path",{"d":"M22 14a8 8 0 0 1-8 8"}],["path",{"d":"M18 11v-1a2 2 0 0 0-2-2a2 2 0 0 0-2 2"}],["path",{"d":"M14 10V9a2 2 0 0 0-2-2a2 2 0 0 0-2 2v1"}],["path",{"d":"M10 9.5V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v10"}],["path",{"d":"M18 11a2 2 0 1 1 4 0v3a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"}]],"popcorn":[["path",{"d":"M18 8a2 2 0 0 0 0-4 2 2 0 0 0-4 0 2 2 0 0 0-4 0 2 2 0 0 0-4 0 2 2 0 0 0 0 4"}],["path",{"d":"M10 22 9 8"}],["path",{"d":"m14 22 1-14"}],["path",{"d":"M20 8c.5 0 .9.4.8 1l-2.6 12c-.1.5-.7 1-1.2 1H7c-.6 0-1.1-.4-1.2-1L3.2 9c-.1-.6.3-1 .8-1Z"}]],"popsicle":[["path",{"d":"M18.6 14.4c.8-.8.8-2 0-2.8l-8.1-8.1a4.95 4.95 0 1 0-7.1 7.1l8.1 8.1c.9.7 2.1.7 2.9-.1Z"}],["path",{"d":"m22 22-5.5-5.5"}]],"pound-sterling":[["path",{"d":"M18 7c0-5.333-8-5.333-8 0"}],["path",{"d":"M10 7v14"}],["path",{"d":"M6 21h12"}],["path",{"d":"M6 13h10"}]],"power-off":[["path",{"d":"M18.36 6.64A9 9 0 0 1 20.77 15"}],["path",{"d":"M6.16 6.16a9 9 0 1 0 12.68 12.68"}],["path",{"d":"M12 2v4"}],["path",{"d":"m2 2 20 20"}]],"power":[["path",{"d":"M12 2v10"}],["path",{"d":"M18.4 6.6a9 9 0 1 1-12.77.04"}]],"presentation":[["path",{"d":"M2 3h20"}],["path",{"d":"M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3"}],["path",{"d":"m7 21 5-5 5 5"}]],"printer-3d":[["path",{"d":"M10 11v1"}],["path",{"d":"M12 8h8"}],["path",{"d":"M15 20v-3a1 1 0 00-1-1H9a1 1 0 00-1 1v3"}],["path",{"d":"M4 20h16"}],["path",{"d":"M4 22V4a2 2 0 012-2h12a2 2 0 012 2v18"}],["path",{"d":"M4 8h4"}],["path",{"d":"M8.635 10.093A2 2 0 018 8.631V7a1 1 0 011-1h2a1 1 0 011 1v2a1 1 0 01-.293.707l-1 1a1 1 0 01-1.414 0z"}]],"printer-check":[["path",{"d":"M13.5 22H7a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v.5"}],["path",{"d":"m16 19 2 2 4-4"}],["path",{"d":"M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v2"}],["path",{"d":"M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6"}]],"printer-x":[["path",{"d":"M12.531 22H7a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h6.377"}],["path",{"d":"m16.5 16.5 5 5"}],["path",{"d":"m16.5 21.5 5-5"}],["path",{"d":"M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v1.5"}],["path",{"d":"M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6"}]],"printer":[["path",{"d":"M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"}],["path",{"d":"M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6"}],["rect",{"x":"6","y":"14","width":"12","height":"8","rx":"1"}]],"projector":[["path",{"d":"M5 7 3 5"}],["path",{"d":"M9 6V3"}],["path",{"d":"m13 7 2-2"}],["circle",{"cx":"9","cy":"13","r":"3"}],["path",{"d":"M11.83 12H20a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h2.17"}],["path",{"d":"M16 16h2"}]],"proportions":[["rect",{"width":"20","height":"16","x":"2","y":"4","rx":"2"}],["path",{"d":"M12 9v11"}],["path",{"d":"M2 9h13a2 2 0 0 1 2 2v9"}]],"puzzle":[["path",{"d":"M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z"}]],"pyramid":[["path",{"d":"M2.5 16.88a1 1 0 0 1-.32-1.43l9-13.02a1 1 0 0 1 1.64 0l9 13.01a1 1 0 0 1-.32 1.44l-8.51 4.86a2 2 0 0 1-1.98 0Z"}],["path",{"d":"M12 2v20"}]],"qr-code":[["rect",{"width":"5","height":"5","x":"3","y":"3","rx":"1"}],["rect",{"width":"5","height":"5","x":"16","y":"3","rx":"1"}],["rect",{"width":"5","height":"5","x":"3","y":"16","rx":"1"}],["path",{"d":"M21 16h-3a2 2 0 0 0-2 2v3"}],["path",{"d":"M21 21v.01"}],["path",{"d":"M12 7v3a2 2 0 0 1-2 2H7"}],["path",{"d":"M3 12h.01"}],["path",{"d":"M12 3h.01"}],["path",{"d":"M12 16v.01"}],["path",{"d":"M16 12h1"}],["path",{"d":"M21 12v.01"}],["path",{"d":"M12 21v-1"}]],"quote":[["path",{"d":"M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"}],["path",{"d":"M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"}]],"rabbit":[["path",{"d":"M13 16a3 3 0 0 1 2.24 5"}],["path",{"d":"M18 12h.01"}],["path",{"d":"M18 21h-8a4 4 0 0 1-4-4 7 7 0 0 1 7-7h.2L9.6 6.4a1 1 0 1 1 2.8-2.8L15.8 7h.2c3.3 0 6 2.7 6 6v1a2 2 0 0 1-2 2h-1a3 3 0 0 0-3 3"}],["path",{"d":"M20 8.54V4a2 2 0 1 0-4 0v3"}],["path",{"d":"M7.612 12.524a3 3 0 1 0-1.6 4.3"}]],"radar":[["path",{"d":"M19.07 4.93A10 10 0 0 0 6.99 3.34"}],["path",{"d":"M4 6h.01"}],["path",{"d":"M2.29 9.62A10 10 0 1 0 21.31 8.35"}],["path",{"d":"M16.24 7.76A6 6 0 1 0 8.23 16.67"}],["path",{"d":"M12 18h.01"}],["path",{"d":"M17.99 11.66A6 6 0 0 1 15.77 16.67"}],["circle",{"cx":"12","cy":"12","r":"2"}],["path",{"d":"m13.41 10.59 5.66-5.66"}]],"radiation":[["path",{"d":"M12 12h.01"}],["path",{"d":"M14 15.4641a4 4 0 0 1-4 0L7.52786 19.74597 A 1 1 0 0 0 7.99303 21.16211 10 10 0 0 0 16.00697 21.16211 1 1 0 0 0 16.47214 19.74597z"}],["path",{"d":"M16 12a4 4 0 0 0-2-3.464l2.472-4.282a1 1 0 0 1 1.46-.305 10 10 0 0 1 4.006 6.94A1 1 0 0 1 21 12z"}],["path",{"d":"M8 12a4 4 0 0 1 2-3.464L7.528 4.254a1 1 0 0 0-1.46-.305 10 10 0 0 0-4.006 6.94A1 1 0 0 0 3 12z"}]],"radical":[["path",{"d":"M3 12h3.28a1 1 0 0 1 .948.684l2.298 7.934a.5.5 0 0 0 .96-.044L13.82 4.771A1 1 0 0 1 14.792 4H21"}]],"radio-off":[["path",{"d":"M13.414 13.414a2 2 0 1 1-2.828-2.828"}],["path",{"d":"M16.247 7.761a6 6 0 0 1 1.744 4.572"}],["path",{"d":"M19.075 4.933a10 10 0 0 1 2.234 10.72"}],["path",{"d":"m2 2 20 20"}],["path",{"d":"M4.925 19.067a10 10 0 0 1 0-14.134"}],["path",{"d":"M7.753 16.239a6 6 0 0 1 0-8.478"}]],"radio-receiver":[["path",{"d":"M5 16v2"}],["path",{"d":"M19 16v2"}],["rect",{"width":"20","height":"8","x":"2","y":"8","rx":"2"}],["path",{"d":"M18 12h.01"}]],"radio-tower":[["path",{"d":"M4.9 16.1C1 12.2 1 5.8 4.9 1.9"}],["path",{"d":"M7.8 4.7a6.14 6.14 0 0 0-.8 7.5"}],["circle",{"cx":"12","cy":"9","r":"2"}],["path",{"d":"M16.2 4.8c2 2 2.26 5.11.8 7.47"}],["path",{"d":"M19.1 1.9a9.96 9.96 0 0 1 0 14.1"}],["path",{"d":"M9.5 18h5"}],["path",{"d":"m8 22 4-11 4 11"}]],"radio":[["path",{"d":"M16.247 7.761a6 6 0 0 1 0 8.478"}],["path",{"d":"M19.075 4.933a10 10 0 0 1 0 14.134"}],["path",{"d":"M4.925 19.067a10 10 0 0 1 0-14.134"}],["path",{"d":"M7.753 16.239a6 6 0 0 1 0-8.478"}],["circle",{"cx":"12","cy":"12","r":"2"}]],"radius":[["path",{"d":"M20.34 17.52a10 10 0 1 0-2.82 2.82"}],["circle",{"cx":"19","cy":"19","r":"2"}],["path",{"d":"m13.41 13.41 4.18 4.18"}],["circle",{"cx":"12","cy":"12","r":"2"}]],"rainbow":[["path",{"d":"M22 17a10 10 0 0 0-20 0"}],["path",{"d":"M6 17a6 6 0 0 1 12 0"}],["path",{"d":"M10 17a2 2 0 0 1 4 0"}]],"rat":[["path",{"d":"M13 22H4a2 2 0 0 1 0-4h12"}],["path",{"d":"M13.236 18a3 3 0 0 0-2.2-5"}],["path",{"d":"M16 9h.01"}],["path",{"d":"M16.82 3.94a3 3 0 1 1 3.237 4.868l1.815 2.587a1.5 1.5 0 0 1-1.5 2.1l-2.872-.453a3 3 0 0 0-3.5 3"}],["path",{"d":"M17 4.988a3 3 0 1 0-5.2 2.052A7 7 0 0 0 4 14.015 4 4 0 0 0 8 18"}]],"ratio":[["rect",{"width":"12","height":"20","x":"6","y":"2","rx":"2"}],["rect",{"width":"20","height":"12","x":"2","y":"6","rx":"2"}]],"receipt-cent":[["path",{"d":"M12 7v10"}],["path",{"d":"M14.828 14.829a4 4 0 0 1-5.656 0 4 4 0 0 1 0-5.657 4 4 0 0 1 5.656 0"}],["path",{"d":"M4 3a1 1 0 0 1 1-1 1.3 1.3 0 0 1 .7.2l.933.6a1.3 1.3 0 0 0 1.4 0l.934-.6a1.3 1.3 0 0 1 1.4 0l.933.6a1.3 1.3 0 0 0 1.4 0l.933-.6a1.3 1.3 0 0 1 1.4 0l.934.6a1.3 1.3 0 0 0 1.4 0l.933-.6A1.3 1.3 0 0 1 19 2a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1 1.3 1.3 0 0 1-.7-.2l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.934.6a1.3 1.3 0 0 1-1.4 0l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-1.4 0l-.934-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-.7.2 1 1 0 0 1-1-1z"}]],"receipt-euro":[["path",{"d":"M15.828 14.829a4 4 0 0 1-5.656 0 4 4 0 0 1 0-5.657 4 4 0 0 1 5.656 0"}],["path",{"d":"M4 3a1 1 0 0 1 1-1 1.3 1.3 0 0 1 .7.2l.933.6a1.3 1.3 0 0 0 1.4 0l.934-.6a1.3 1.3 0 0 1 1.4 0l.933.6a1.3 1.3 0 0 0 1.4 0l.933-.6a1.3 1.3 0 0 1 1.4 0l.934.6a1.3 1.3 0 0 0 1.4 0l.933-.6A1.3 1.3 0 0 1 19 2a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1 1.3 1.3 0 0 1-.7-.2l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.934.6a1.3 1.3 0 0 1-1.4 0l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-1.4 0l-.934-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-.7.2 1 1 0 0 1-1-1z"}],["path",{"d":"M8 12h5"}]],"receipt-indian-rupee":[["path",{"d":"M4 3a1 1 0 0 1 1-1 1.3 1.3 0 0 1 .7.2l.933.6a1.3 1.3 0 0 0 1.4 0l.934-.6a1.3 1.3 0 0 1 1.4 0l.933.6a1.3 1.3 0 0 0 1.4 0l.933-.6a1.3 1.3 0 0 1 1.4 0l.934.6a1.3 1.3 0 0 0 1.4 0l.933-.6A1.3 1.3 0 0 1 19 2a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1 1.3 1.3 0 0 1-.7-.2l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.934.6a1.3 1.3 0 0 1-1.4 0l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-1.4 0l-.934-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-.7.2 1 1 0 0 1-1-1z"}],["path",{"d":"M8 11h8"}],["path",{"d":"M8 7h8"}],["path",{"d":"M9 7a4 4 0 0 1 0 8H8l3 2"}]],"receipt-japanese-yen":[["path",{"d":"m12 10 3-3"}],["path",{"d":"M4 3a1 1 0 0 1 1-1 1.3 1.3 0 0 1 .7.2l.933.6a1.3 1.3 0 0 0 1.4 0l.934-.6a1.3 1.3 0 0 1 1.4 0l.933.6a1.3 1.3 0 0 0 1.4 0l.933-.6a1.3 1.3 0 0 1 1.4 0l.934.6a1.3 1.3 0 0 0 1.4 0l.933-.6A1.3 1.3 0 0 1 19 2a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1 1.3 1.3 0 0 1-.7-.2l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.934.6a1.3 1.3 0 0 1-1.4 0l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-1.4 0l-.934-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-.7.2 1 1 0 0 1-1-1z"}],["path",{"d":"M9 11h6"}],["path",{"d":"M9 15h6"}],["path",{"d":"m9 7 3 3v7"}]],"receipt-pound-sterling":[["path",{"d":"M10 17V9.5a1 1 0 0 1 5 0"}],["path",{"d":"M4 3a1 1 0 0 1 1-1 1.3 1.3 0 0 1 .7.2l.933.6a1.3 1.3 0 0 0 1.4 0l.934-.6a1.3 1.3 0 0 1 1.4 0l.933.6a1.3 1.3 0 0 0 1.4 0l.933-.6a1.3 1.3 0 0 1 1.4 0l.934.6a1.3 1.3 0 0 0 1.4 0l.933-.6A1.3 1.3 0 0 1 19 2a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1 1.3 1.3 0 0 1-.7-.2l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.934.6a1.3 1.3 0 0 1-1.4 0l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-1.4 0l-.934-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-.7.2 1 1 0 0 1-1-1z"}],["path",{"d":"M8 13h5"}],["path",{"d":"M8 17h7"}]],"receipt-russian-ruble":[["path",{"d":"M4 3a1 1 0 0 1 1-1 1.3 1.3 0 0 1 .7.2l.933.6a1.3 1.3 0 0 0 1.4 0l.934-.6a1.3 1.3 0 0 1 1.4 0l.933.6a1.3 1.3 0 0 0 1.4 0l.933-.6a1.3 1.3 0 0 1 1.4 0l.934.6a1.3 1.3 0 0 0 1.4 0l.933-.6A1.3 1.3 0 0 1 19 2a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1 1.3 1.3 0 0 1-.7-.2l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.934.6a1.3 1.3 0 0 1-1.4 0l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-1.4 0l-.934-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-.7.2 1 1 0 0 1-1-1z"}],["path",{"d":"M8 11h5a2 2 0 0 0 0-4h-3v10"}],["path",{"d":"M8 15h5"}]],"receipt-swiss-franc":[["path",{"d":"M10 11h4"}],["path",{"d":"M10 17V7h5"}],["path",{"d":"M4 3a1 1 0 0 1 1-1 1.3 1.3 0 0 1 .7.2l.933.6a1.3 1.3 0 0 0 1.4 0l.934-.6a1.3 1.3 0 0 1 1.4 0l.933.6a1.3 1.3 0 0 0 1.4 0l.933-.6a1.3 1.3 0 0 1 1.4 0l.934.6a1.3 1.3 0 0 0 1.4 0l.933-.6A1.3 1.3 0 0 1 19 2a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1 1.3 1.3 0 0 1-.7-.2l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.934.6a1.3 1.3 0 0 1-1.4 0l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-1.4 0l-.934-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-.7.2 1 1 0 0 1-1-1z"}],["path",{"d":"M8 15h5"}]],"receipt-text":[["path",{"d":"M13 16H8"}],["path",{"d":"M14 8H8"}],["path",{"d":"M16 12H8"}],["path",{"d":"M4 3a1 1 0 0 1 1-1 1.3 1.3 0 0 1 .7.2l.933.6a1.3 1.3 0 0 0 1.4 0l.934-.6a1.3 1.3 0 0 1 1.4 0l.933.6a1.3 1.3 0 0 0 1.4 0l.933-.6a1.3 1.3 0 0 1 1.4 0l.934.6a1.3 1.3 0 0 0 1.4 0l.933-.6A1.3 1.3 0 0 1 19 2a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1 1.3 1.3 0 0 1-.7-.2l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.934.6a1.3 1.3 0 0 1-1.4 0l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-1.4 0l-.934-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-.7.2 1 1 0 0 1-1-1z"}]],"receipt-turkish-lira":[["path",{"d":"M10 7v10a5 5 0 0 0 5-5"}],["path",{"d":"m14 8-6 3"}],["path",{"d":"M4 3a1 1 0 0 1 1-1 1.3 1.3 0 0 1 .7.2l.933.6a1.3 1.3 0 0 0 1.4 0l.934-.6a1.3 1.3 0 0 1 1.4 0l.933.6a1.3 1.3 0 0 0 1.4 0l.933-.6a1.3 1.3 0 0 1 1.4 0l.934.6a1.3 1.3 0 0 0 1.4 0l.933-.6A1.3 1.3 0 0 1 19 2a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1 1.3 1.3 0 0 1-.7-.2l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.934.6a1.3 1.3 0 0 1-1.4 0l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-1.4 0l-.934-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-.7.2 1 1 0 0 1-1-1z"}]],"receipt":[["path",{"d":"M12 17V7"}],["path",{"d":"M16 8h-6a2 2 0 0 0 0 4h4a2 2 0 0 1 0 4H8"}],["path",{"d":"M4 3a1 1 0 0 1 1-1 1.3 1.3 0 0 1 .7.2l.933.6a1.3 1.3 0 0 0 1.4 0l.934-.6a1.3 1.3 0 0 1 1.4 0l.933.6a1.3 1.3 0 0 0 1.4 0l.933-.6a1.3 1.3 0 0 1 1.4 0l.934.6a1.3 1.3 0 0 0 1.4 0l.933-.6A1.3 1.3 0 0 1 19 2a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1 1.3 1.3 0 0 1-.7-.2l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.934.6a1.3 1.3 0 0 1-1.4 0l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-1.4 0l-.934-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-.7.2 1 1 0 0 1-1-1z"}]],"rectangle-circle":[["path",{"d":"M14 4v16H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"}],["circle",{"cx":"14","cy":"12","r":"8"}]],"rectangle-ellipsis":[["rect",{"width":"20","height":"12","x":"2","y":"6","rx":"2"}],["path",{"d":"M12 12h.01"}],["path",{"d":"M17 12h.01"}],["path",{"d":"M7 12h.01"}]],"rectangle-goggles":[["path",{"d":"M20 6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-4a2 2 0 0 1-1.6-.8l-1.6-2.13a1 1 0 0 0-1.6 0L9.6 17.2A2 2 0 0 1 8 18H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"}]],"rectangle-horizontal":[["rect",{"width":"20","height":"12","x":"2","y":"6","rx":"2"}]],"rectangle-vertical":[["rect",{"width":"12","height":"20","x":"6","y":"2","rx":"2"}]],"recycle":[["path",{"d":"M7 19H4.815a1.83 1.83 0 0 1-1.57-.881 1.785 1.785 0 0 1-.004-1.784L7.196 9.5"}],["path",{"d":"M11 19h8.203a1.83 1.83 0 0 0 1.556-.89 1.784 1.784 0 0 0 0-1.775l-1.226-2.12"}],["path",{"d":"m14 16-3 3 3 3"}],["path",{"d":"M8.293 13.596 7.196 9.5 3.1 10.598"}],["path",{"d":"m9.344 5.811 1.093-1.892A1.83 1.83 0 0 1 11.985 3a1.784 1.784 0 0 1 1.546.888l3.943 6.843"}],["path",{"d":"m13.378 9.633 4.096 1.098 1.097-4.096"}]],"redo-2":[["path",{"d":"m15 14 5-5-5-5"}],["path",{"d":"M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13"}]],"redo-dot":[["circle",{"cx":"12","cy":"17","r":"1"}],["path",{"d":"M21 7v6h-6"}],["path",{"d":"M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3l3 2.7"}]],"redo":[["path",{"d":"M21 7v6h-6"}],["path",{"d":"M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3l3 2.7"}]],"refresh-ccw-dot":[["path",{"d":"M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"}],["path",{"d":"M3 3v5h5"}],["path",{"d":"M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"}],["path",{"d":"M16 16h5v5"}],["circle",{"cx":"12","cy":"12","r":"1"}]],"refresh-ccw":[["path",{"d":"M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"}],["path",{"d":"M3 3v5h5"}],["path",{"d":"M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"}],["path",{"d":"M16 16h5v5"}]],"refresh-cw-off":[["path",{"d":"M21 8L18.74 5.74A9.75 9.75 0 0 0 12 3C11 3 10.03 3.16 9.13 3.47"}],["path",{"d":"M8 16H3v5"}],["path",{"d":"M3 12C3 9.51 4 7.26 5.64 5.64"}],["path",{"d":"m3 16 2.26 2.26A9.75 9.75 0 0 0 12 21c2.49 0 4.74-1 6.36-2.64"}],["path",{"d":"M21 12c0 1-.16 1.97-.47 2.87"}],["path",{"d":"M21 3v5h-5"}],["path",{"d":"M22 22 2 2"}]],"refresh-cw":[["path",{"d":"M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"}],["path",{"d":"M21 3v5h-5"}],["path",{"d":"M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"}],["path",{"d":"M8 16H3v5"}]],"refrigerator":[["path",{"d":"M5 6a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6Z"}],["path",{"d":"M5 10h14"}],["path",{"d":"M15 7v6"}]],"regex":[["path",{"d":"M17 3v10"}],["path",{"d":"m12.67 5.5 8.66 5"}],["path",{"d":"m12.67 10.5 8.66-5"}],["path",{"d":"M9 17a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2v-2z"}]],"remove-formatting":[["path",{"d":"M4 7V4h16v3"}],["path",{"d":"M5 20h6"}],["path",{"d":"M13 4 8 20"}],["path",{"d":"m15 15 5 5"}],["path",{"d":"m20 15-5 5"}]],"repeat-1":[["path",{"d":"m17 2 4 4-4 4"}],["path",{"d":"M3 11v-1a4 4 0 0 1 4-4h14"}],["path",{"d":"m7 22-4-4 4-4"}],["path",{"d":"M21 13v1a4 4 0 0 1-4 4H3"}],["path",{"d":"M11 10h1v4"}]],"repeat-2":[["path",{"d":"m2 9 3-3 3 3"}],["path",{"d":"M13 18H7a2 2 0 0 1-2-2V6"}],["path",{"d":"m22 15-3 3-3-3"}],["path",{"d":"M11 6h6a2 2 0 0 1 2 2v10"}]],"repeat-off":[["path",{"d":"M11.656 6H21l-4-4"}],["path",{"d":"M17.898 17.898A4 4 0 0 1 17 18H3l4-4"}],["path",{"d":"m2 2 20 20"}],["path",{"d":"M21 13v1a4 4 0 0 1-.171 1.159"}],["path",{"d":"m21 6-4 4"}],["path",{"d":"M3 11v-1a4 4 0 0 1 3.102-3.898"}],["path",{"d":"m7 22-4-4"}]],"repeat":[["path",{"d":"m17 2 4 4-4 4"}],["path",{"d":"M3 11v-1a4 4 0 0 1 4-4h14"}],["path",{"d":"m7 22-4-4 4-4"}],["path",{"d":"M21 13v1a4 4 0 0 1-4 4H3"}]],"replace-all":[["path",{"d":"M14 14a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1"}],["path",{"d":"M14 4a1 1 0 0 1 1-1"}],["path",{"d":"M15 10a1 1 0 0 1-1-1"}],["path",{"d":"M19 14a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1"}],["path",{"d":"M21 4a1 1 0 0 0-1-1"}],["path",{"d":"M21 9a1 1 0 0 1-1 1"}],["path",{"d":"m3 7 3 3 3-3"}],["path",{"d":"M6 10V5a2 2 0 0 1 2-2h2"}],["rect",{"x":"3","y":"14","width":"7","height":"7","rx":"1"}]],"replace":[["path",{"d":"M14 4a1 1 0 0 1 1-1"}],["path",{"d":"M15 10a1 1 0 0 1-1-1"}],["path",{"d":"M21 4a1 1 0 0 0-1-1"}],["path",{"d":"M21 9a1 1 0 0 1-1 1"}],["path",{"d":"m3 7 3 3 3-3"}],["path",{"d":"M6 10V5a2 2 0 0 1 2-2h2"}],["rect",{"x":"3","y":"14","width":"7","height":"7","rx":"1"}]],"reply-all":[["path",{"d":"m12 17-5-5 5-5"}],["path",{"d":"M22 18v-2a4 4 0 0 0-4-4H7"}],["path",{"d":"m7 17-5-5 5-5"}]],"reply":[["path",{"d":"M20 18v-2a4 4 0 0 0-4-4H4"}],["path",{"d":"m9 17-5-5 5-5"}]],"rewind":[["path",{"d":"M12 6a2 2 0 0 0-3.414-1.414l-6 6a2 2 0 0 0 0 2.828l6 6A2 2 0 0 0 12 18z"}],["path",{"d":"M22 6a2 2 0 0 0-3.414-1.414l-6 6a2 2 0 0 0 0 2.828l6 6A2 2 0 0 0 22 18z"}]],"ribbon":[["path",{"d":"M12 11.22C11 9.997 10 9 10 8a2 2 0 0 1 4 0c0 1-.998 2.002-2.01 3.22"}],["path",{"d":"m12 18 2.57-3.5"}],["path",{"d":"M6.243 9.016a7 7 0 0 1 11.507-.009"}],["path",{"d":"M9.35 14.53 12 11.22"}],["path",{"d":"M9.35 14.53C7.728 12.246 6 10.221 6 7a6 5 0 0 1 12 0c-.005 3.22-1.778 5.235-3.43 7.5l3.557 4.527a1 1 0 0 1-.203 1.43l-1.894 1.36a1 1 0 0 1-1.384-.215L12 18l-2.679 3.593a1 1 0 0 1-1.39.213l-1.865-1.353a1 1 0 0 1-.203-1.422z"}]],"road":[["path",{"d":"M12 17v4"}],["path",{"d":"M12 5V3"}],["path",{"d":"M12 9v3"}],["path",{"d":"M2.077 18.449A2 2 0 0 0 4 21h16a2 2 0 0 0 1.924-2.55l-4-14A2 2 0 0 0 16 3H8a2 2 0 0 0-1.924 1.45z"}]],"robot-arm":[["path",{"d":"M12 21 7.5 8.322"}],["path",{"d":"m14 7 1.75-3.767a.5.5 0 0 1 .662-.172L20 5.005"}],["path",{"d":"m20 8.998-3.588 1.944a.5.5 0 0 1-.662-.172L14 7H8"}],["path",{"d":"M3.486 21h10"}],["path",{"d":"M5 21V8.732"}],["circle",{"cx":"6","cy":"7","r":"2"}]],"robot-vacuum":[["path",{"d":"M11 17h2"}],["path",{"d":"M12 12h.01"}],["path",{"d":"M17 12a5 5 0 00-10 0"}],["path",{"d":"M19 2v2.8"}],["path",{"d":"M2 5h2.8"}],["path",{"d":"M22 5h-2.8"}],["path",{"d":"M5 2v2.8"}],["circle",{"cx":"12","cy":"12","r":"10"}]],"rocket":[["path",{"d":"M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"}],["path",{"d":"M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09"}],["path",{"d":"M9 12a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.4 22.4 0 0 1-4 2z"}],["path",{"d":"M9 12H4s.55-3.03 2-4c1.62-1.08 5 .05 5 .05"}]],"rocking-chair":[["path",{"d":"m15 13 3.708 7.416"}],["path",{"d":"M3 19a15 15 0 0 0 18 0"}],["path",{"d":"m3 2 3.21 9.633A2 2 0 0 0 8.109 13H18"}],["path",{"d":"m9 13-3.708 7.416"}]],"roller-coaster":[["path",{"d":"M6 19V5"}],["path",{"d":"M10 19V6.8"}],["path",{"d":"M14 19v-7.8"}],["path",{"d":"M18 5v4"}],["path",{"d":"M18 19v-6"}],["path",{"d":"M22 19V9"}],["path",{"d":"M2 19V9a4 4 0 0 1 4-4c2 0 4 1.33 6 4s4 4 6 4a4 4 0 1 0-3-6.65"}]],"rose":[["path",{"d":"M17 10h-1a4 4 0 1 1 4-4v.534"}],["path",{"d":"M17 6h1a4 4 0 0 1 1.42 7.74l-2.29.87a6 6 0 0 1-5.339-10.68l2.069-1.31"}],["path",{"d":"M4.5 17c2.8-.5 4.4 0 5.5.8s1.8 2.2 2.3 3.7c-2 .4-3.5.4-4.8-.3-1.2-.6-2.3-1.9-3-4.2"}],["path",{"d":"M9.77 12C4 15 2 22 2 22"}],["circle",{"cx":"17","cy":"8","r":"2"}]],"rotate-3d":[["path",{"d":"m15.194 13.707 3.814 1.86-1.86 3.814"}],["path",{"d":"M16.47214 7.52786 A 5 10 0 1 0 13 21.79796"}],["path",{"d":"M21.79796 11 A 10 5 0 1 0 19 15.57071"}]],"rotate-ccw-clock":[["path",{"d":"M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"}],["path",{"d":"M3 3v5h5"}],["path",{"d":"M12 7v5l4 2"}]],"rotate-ccw-key":[["path",{"d":"M12 7v6"}],["path",{"d":"M12 9h2"}],["path",{"d":"M3 12a9 9 0 1 0 9-9 9.74 9.74 0 0 0-6.74 2.74L3 8"}],["path",{"d":"M3 3v5h5"}],["circle",{"cx":"12","cy":"15","r":"2"}]],"rotate-ccw-square":[["path",{"d":"M20 9V7a2 2 0 0 0-2-2h-6"}],["path",{"d":"m15 2-3 3 3 3"}],["path",{"d":"M20 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2"}]],"rotate-ccw":[["path",{"d":"M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"}],["path",{"d":"M3 3v5h5"}]],"rotate-cw-clock":[["path",{"d":"M12 7v5l4 2"}],["path",{"d":"M16 8h5V3"}],["path",{"d":"m21 8-2.3-2.3A9.7 9.7 0 0012 3a9 9 0 109 9"}]],"rotate-cw-fading-clock":[["path",{"d":"M12 3a9.75 9.75 0 0 1 6.74 2.74"}],["path",{"d":"M18.74 5.74 21 8"}],["path",{"d":"M21 8V3"}],["path",{"d":"M7.5 19.794c-6-3.464-6-12.124 0-15.588"}],["path",{"d":"M7.5 4.206A9 9 0 0 1 12 3"}],["path",{"d":"M12 7v5l4 2"}],["path",{"d":"M14 20.775A9 9 0 0 1 12 21"}],["path",{"d":"M19 17.656a9 9 0 0 1-1.5 1.456"}],["path",{"d":"M21 12a9 9 0 0 1-.228 2"}],["path",{"d":"M21 8h-5"}]],"rotate-cw-square":[["path",{"d":"M12 5H6a2 2 0 0 0-2 2v3"}],["path",{"d":"m9 8 3-3-3-3"}],["path",{"d":"M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"}]],"rotate-cw":[["path",{"d":"M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"}],["path",{"d":"M21 3v5h-5"}]],"route-off":[["circle",{"cx":"6","cy":"19","r":"3"}],["path",{"d":"M9 19h8.5c.4 0 .9-.1 1.3-.2"}],["path",{"d":"M5.2 5.2A3.5 3.53 0 0 0 6.5 12H12"}],["path",{"d":"m2 2 20 20"}],["path",{"d":"M21 15.3a3.5 3.5 0 0 0-3.3-3.3"}],["path",{"d":"M15 5h-4.3"}],["circle",{"cx":"18","cy":"5","r":"3"}]],"route":[["circle",{"cx":"6","cy":"19","r":"3"}],["path",{"d":"M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"}],["circle",{"cx":"18","cy":"5","r":"3"}]],"router":[["rect",{"width":"20","height":"8","x":"2","y":"14","rx":"2"}],["path",{"d":"M6.01 18H6"}],["path",{"d":"M10.01 18H10"}],["path",{"d":"M15 10v4"}],["path",{"d":"M17.84 7.17a4 4 0 0 0-5.66 0"}],["path",{"d":"M20.66 4.34a8 8 0 0 0-11.31 0"}]],"rows-2":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M3 12h18"}]],"rows-3":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M21 9H3"}],["path",{"d":"M21 15H3"}]],"rows-4":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M21 7.5H3"}],["path",{"d":"M21 12H3"}],["path",{"d":"M21 16.5H3"}]],"rss":[["path",{"d":"M4 11a9 9 0 0 1 9 9"}],["path",{"d":"M4 4a16 16 0 0 1 16 16"}],["circle",{"cx":"5","cy":"19","r":"1"}]],"ruler-dimension-line":[["path",{"d":"M10 15v-3"}],["path",{"d":"M14 15v-3"}],["path",{"d":"M18 15v-3"}],["path",{"d":"M2 8V4"}],["path",{"d":"M22 6H2"}],["path",{"d":"M22 8V4"}],["path",{"d":"M6 15v-3"}],["rect",{"x":"2","y":"12","width":"20","height":"8","rx":"2"}]],"ruler":[["path",{"d":"M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0Z"}],["path",{"d":"m14.5 12.5 2-2"}],["path",{"d":"m11.5 9.5 2-2"}],["path",{"d":"m8.5 6.5 2-2"}],["path",{"d":"m17.5 15.5 2-2"}]],"russian-ruble":[["path",{"d":"M6 11h8a4 4 0 0 0 0-8H9v18"}],["path",{"d":"M6 15h8"}]],"sailboat":[["path",{"d":"M10 2v15"}],["path",{"d":"M7 22a4 4 0 0 1-4-4 1 1 0 0 1 1-1h16a1 1 0 0 1 1 1 4 4 0 0 1-4 4z"}],["path",{"d":"M9.159 2.46a1 1 0 0 1 1.521-.193l9.977 8.98A1 1 0 0 1 20 13H4a1 1 0 0 1-.824-1.567z"}]],"salad":[["path",{"d":"M7 21h10"}],["path",{"d":"M12 21a9 9 0 0 0 9-9H3a9 9 0 0 0 9 9Z"}],["path",{"d":"M11.38 12a2.4 2.4 0 0 1-.4-4.77 2.4 2.4 0 0 1 3.2-2.77 2.4 2.4 0 0 1 3.47-.63 2.4 2.4 0 0 1 3.37 3.37 2.4 2.4 0 0 1-1.1 3.7 2.51 2.51 0 0 1 .03 1.1"}],["path",{"d":"m13 12 4-4"}],["path",{"d":"M10.9 7.25A3.99 3.99 0 0 0 4 10c0 .73.2 1.41.54 2"}]],"sandwich":[["path",{"d":"m2.37 11.223 8.372-6.777a2 2 0 0 1 2.516 0l8.371 6.777"}],["path",{"d":"M21 15a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1h-5.25"}],["path",{"d":"M3 15a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h9"}],["path",{"d":"m6.67 15 6.13 4.6a2 2 0 0 0 2.8-.4l3.15-4.2"}],["rect",{"width":"20","height":"4","x":"2","y":"11","rx":"1"}]],"satellite-dish":[["path",{"d":"M18 12a6 6 0 00-6-6"}],["path",{"d":"M2.824 10.459a8 8 0 0010.717 10.717c.558-.276.623-1.012.183-1.452l-9.448-9.448c-.44-.44-1.176-.375-1.452.183"}],["path",{"d":"M22 12A10 10 0 0012 2"}],["path",{"d":"m9 15 4-4"}]],"satellite":[["path",{"d":"m13.5 6.5-3.148-3.148a1.205 1.205 0 0 0-1.704 0L6.352 5.648a1.205 1.205 0 0 0 0 1.704L9.5 10.5"}],["path",{"d":"M16.5 7.5 19 5"}],["path",{"d":"m17.5 10.5 3.148 3.148a1.205 1.205 0 0 1 0 1.704l-2.296 2.296a1.205 1.205 0 0 1-1.704 0L13.5 14.5"}],["path",{"d":"M9 21a6 6 0 0 0-6-6"}],["path",{"d":"M9.352 10.648a1.205 1.205 0 0 0 0 1.704l2.296 2.296a1.205 1.205 0 0 0 1.704 0l4.296-4.296a1.205 1.205 0 0 0 0-1.704l-2.296-2.296a1.205 1.205 0 0 0-1.704 0z"}]],"saudi-riyal":[["path",{"d":"m20 19.5-5.5 1.2"}],["path",{"d":"M14.5 4v11.22a1 1 0 0 0 1.242.97L20 15.2"}],["path",{"d":"m2.978 19.351 5.549-1.363A2 2 0 0 0 10 16V2"}],["path",{"d":"M20 10 4 13.5"}]],"save-all":[["path",{"d":"M10 2v3a1 1 0 0 0 1 1h5"}],["path",{"d":"M18 18v-6a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6"}],["path",{"d":"M18 22H4a2 2 0 0 1-2-2V6"}],["path",{"d":"M8 18a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9.172a2 2 0 0 1 1.414.586l2.828 2.828A2 2 0 0 1 22 6.828V16a2 2 0 0 1-2.01 2z"}]],"save-check":[["path",{"d":"M12.5 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h10.2a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4v4.35"}],["path",{"d":"m16 19 2 2 4-4"}],["path",{"d":"M17 15.13V14a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"}],["path",{"d":"M7 3v4a1 1 0 0 0 1 1h7"}]],"save-off":[["path",{"d":"M13 13H8a1 1 0 0 0-1 1v7"}],["path",{"d":"M14 8h1"}],["path",{"d":"M17 21v-4"}],["path",{"d":"m2 2 20 20"}],["path",{"d":"M20.41 20.41A2 2 0 0 1 19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 .59-1.41"}],["path",{"d":"M9 3h6.2a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V15"}]],"save-pen":[["path",{"d":"M13.33 13H8a1 1 0 00-1 1v7"}],["path",{"d":"M14.363 17.634a2 2 0 00-.506.854l-.837 2.87a.5.5 0 00.62.62l2.87-.837a2 2 0 00.854-.506l4.013-4.009a1 1 0 10-3.004-3.004z"}],["path",{"d":"M7 3v4a1 1 0 001 1h7"}],["path",{"d":"M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h10.2a2 2 0 011.4.6l3.8 3.8a2 2 0 01.6 1.4v.3"}]],"save-plus":[["path",{"d":"M12.5 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h10.2a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V12"}],["path",{"d":"M16 13H8a1 1 0 0 0-1 1v7"}],["path",{"d":"M19 22v-6"}],["path",{"d":"M22 19h-6"}],["path",{"d":"M7 3v4a1 1 0 0 0 1 1h7"}]],"save":[["path",{"d":"M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"}],["path",{"d":"M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"}],["path",{"d":"M7 3v4a1 1 0 0 0 1 1h7"}]],"scale-3d":[["path",{"d":"M5 7v11a1 1 0 0 0 1 1h11"}],["path",{"d":"M5.293 18.707 11 13"}],["circle",{"cx":"19","cy":"19","r":"2"}],["circle",{"cx":"5","cy":"5","r":"2"}]],"scale":[["path",{"d":"M12 3v18"}],["path",{"d":"m19 8 3 8a5 5 0 0 1-6 0zV7"}],["path",{"d":"M3 7h1a17 17 0 0 0 8-2 17 17 0 0 0 8 2h1"}],["path",{"d":"m5 8 3 8a5 5 0 0 1-6 0zV7"}],["path",{"d":"M7 21h10"}]],"scaling":[["path",{"d":"M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"}],["path",{"d":"M14 15H9v-5"}],["path",{"d":"M16 3h5v5"}],["path",{"d":"M21 3 9 15"}]],"scan-barcode":[["path",{"d":"M3 7V5a2 2 0 0 1 2-2h2"}],["path",{"d":"M17 3h2a2 2 0 0 1 2 2v2"}],["path",{"d":"M21 17v2a2 2 0 0 1-2 2h-2"}],["path",{"d":"M7 21H5a2 2 0 0 1-2-2v-2"}],["path",{"d":"M8 7v10"}],["path",{"d":"M12 7v10"}],["path",{"d":"M17 7v10"}]],"scan-box":[["path",{"d":"M12 12v5.5"}],["path",{"d":"M17 3h2a2 2 0 012 2v2"}],["path",{"d":"M21 17v2a2 2 0 01-2 2h-2"}],["path",{"d":"M3 7V5a2 2 0 012-2h2"}],["path",{"d":"M7 21H5a2 2 0 01-2-2v-2"}],["path",{"d":"M7.264 9.252 12 12l4.737-2.748"}],["path",{"d":"M7.995 8.514A2 2 0 007 10.244v3.516a2 2 0 00.996 1.73l3 1.74a2 2 0 002.008 0l3-1.74A2 2 0 0017 13.76v-3.517a2 2 0 00-.995-1.73l-3-1.742a2 2 0 00-1.892-.064z"}]],"scan-eye":[["path",{"d":"M3 7V5a2 2 0 0 1 2-2h2"}],["path",{"d":"M17 3h2a2 2 0 0 1 2 2v2"}],["path",{"d":"M21 17v2a2 2 0 0 1-2 2h-2"}],["path",{"d":"M7 21H5a2 2 0 0 1-2-2v-2"}],["circle",{"cx":"12","cy":"12","r":"1"}],["path",{"d":"M18.944 12.33a1 1 0 0 0 0-.66 7.5 7.5 0 0 0-13.888 0 1 1 0 0 0 0 .66 7.5 7.5 0 0 0 13.888 0"}]],"scan-face":[["path",{"d":"M3 7V5a2 2 0 0 1 2-2h2"}],["path",{"d":"M17 3h2a2 2 0 0 1 2 2v2"}],["path",{"d":"M21 17v2a2 2 0 0 1-2 2h-2"}],["path",{"d":"M7 21H5a2 2 0 0 1-2-2v-2"}],["path",{"d":"M8 14s1.5 2 4 2 4-2 4-2"}],["path",{"d":"M9 9h.01"}],["path",{"d":"M15 9h.01"}]],"scan-heart":[["path",{"d":"M17 3h2a2 2 0 0 1 2 2v2"}],["path",{"d":"M21 17v2a2 2 0 0 1-2 2h-2"}],["path",{"d":"M3 7V5a2 2 0 0 1 2-2h2"}],["path",{"d":"M7 21H5a2 2 0 0 1-2-2v-2"}],["path",{"d":"M7.828 13.07A3 3 0 0 1 12 8.764a3 3 0 0 1 4.172 4.306l-3.447 3.62a1 1 0 0 1-1.449 0z"}]],"scan-line":[["path",{"d":"M3 7V5a2 2 0 0 1 2-2h2"}],["path",{"d":"M17 3h2a2 2 0 0 1 2 2v2"}],["path",{"d":"M21 17v2a2 2 0 0 1-2 2h-2"}],["path",{"d":"M7 21H5a2 2 0 0 1-2-2v-2"}],["path",{"d":"M7 12h10"}]],"scan-qr-code":[["path",{"d":"M17 12v4a1 1 0 0 1-1 1h-4"}],["path",{"d":"M17 3h2a2 2 0 0 1 2 2v2"}],["path",{"d":"M17 8V7"}],["path",{"d":"M21 17v2a2 2 0 0 1-2 2h-2"}],["path",{"d":"M3 7V5a2 2 0 0 1 2-2h2"}],["path",{"d":"M7 17h.01"}],["path",{"d":"M7 21H5a2 2 0 0 1-2-2v-2"}],["rect",{"x":"7","y":"7","width":"5","height":"5","rx":"1"}]],"scan-search":[["path",{"d":"M3 7V5a2 2 0 0 1 2-2h2"}],["path",{"d":"M17 3h2a2 2 0 0 1 2 2v2"}],["path",{"d":"M21 17v2a2 2 0 0 1-2 2h-2"}],["path",{"d":"M7 21H5a2 2 0 0 1-2-2v-2"}],["circle",{"cx":"12","cy":"12","r":"3"}],["path",{"d":"m16 16-1.9-1.9"}]],"scan-square":[["path",{"d":"M3 7V5a2 2 0 0 1 2-2h2"}],["path",{"d":"M17 3h2a2 2 0 0 1 2 2v2"}],["path",{"d":"M21 17v2a2 2 0 0 1-2 2h-2"}],["path",{"d":"M7 21H5a2 2 0 0 1-2-2v-2"}],["rect",{"width":"8","height":"8","x":"8","y":"8","rx":"1"}]],"scan-text":[["path",{"d":"M3 7V5a2 2 0 0 1 2-2h2"}],["path",{"d":"M17 3h2a2 2 0 0 1 2 2v2"}],["path",{"d":"M21 17v2a2 2 0 0 1-2 2h-2"}],["path",{"d":"M7 21H5a2 2 0 0 1-2-2v-2"}],["path",{"d":"M7 8h8"}],["path",{"d":"M7 12h10"}],["path",{"d":"M7 16h6"}]],"scan":[["path",{"d":"M3 7V5a2 2 0 0 1 2-2h2"}],["path",{"d":"M17 3h2a2 2 0 0 1 2 2v2"}],["path",{"d":"M21 17v2a2 2 0 0 1-2 2h-2"}],["path",{"d":"M7 21H5a2 2 0 0 1-2-2v-2"}]],"school":[["path",{"d":"M14 21v-3a2 2 0 0 0-4 0v3"}],["path",{"d":"M18 4.933V21"}],["path",{"d":"m4 6 7.106-3.79a2 2 0 0 1 1.788 0L20 6"}],["path",{"d":"m6 11-3.52 2.147a1 1 0 0 0-.48.854V19a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5a1 1 0 0 0-.48-.853L18 11"}],["path",{"d":"M6 4.933V21"}],["circle",{"cx":"12","cy":"9","r":"2"}]],"scissors-line-dashed":[["path",{"d":"M5.42 9.42 8 12"}],["circle",{"cx":"4","cy":"8","r":"2"}],["path",{"d":"m14 6-8.58 8.58"}],["circle",{"cx":"4","cy":"16","r":"2"}],["path",{"d":"M10.8 14.8 14 18"}],["path",{"d":"M16 12h-2"}],["path",{"d":"M22 12h-2"}]],"scissors":[["circle",{"cx":"6","cy":"6","r":"3"}],["path",{"d":"M8.12 8.12 12 12"}],["path",{"d":"M20 4 8.12 15.88"}],["circle",{"cx":"6","cy":"18","r":"3"}],["path",{"d":"M14.8 14.8 20 20"}]],"scooter":[["path",{"d":"M21 4h-3.5l2 11.05"}],["path",{"d":"M6.95 17h5.142c.523 0 .95-.406 1.063-.916a6.5 6.5 0 0 1 5.345-5.009"}],["circle",{"cx":"19.5","cy":"17.5","r":"2.5"}],["circle",{"cx":"4.5","cy":"17.5","r":"2.5"}]],"screen-share-off":[["path",{"d":"M13 3H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-3"}],["path",{"d":"M8 21h8"}],["path",{"d":"M12 17v4"}],["path",{"d":"m22 3-5 5"}],["path",{"d":"m17 3 5 5"}]],"screen-share":[["path",{"d":"M13 3H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-3"}],["path",{"d":"M8 21h8"}],["path",{"d":"M12 17v4"}],["path",{"d":"m17 8 5-5"}],["path",{"d":"M17 3h5v5"}]],"scroll-text":[["path",{"d":"M15 12h-5"}],["path",{"d":"M15 8h-5"}],["path",{"d":"M19 17V5a2 2 0 0 0-2-2H4"}],["path",{"d":"M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"}]],"scroll":[["path",{"d":"M19 17V5a2 2 0 0 0-2-2H4"}],["path",{"d":"M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"}]],"search-alert":[["circle",{"cx":"11","cy":"11","r":"8"}],["path",{"d":"m21 21-4.3-4.3"}],["path",{"d":"M11 7v4"}],["path",{"d":"M11 15h.01"}]],"search-check":[["path",{"d":"m8 11 2 2 4-4"}],["circle",{"cx":"11","cy":"11","r":"8"}],["path",{"d":"m21 21-4.3-4.3"}]],"search-code":[["path",{"d":"m13 13.5 2-2.5-2-2.5"}],["path",{"d":"m21 21-4.3-4.3"}],["path",{"d":"M9 8.5 7 11l2 2.5"}],["circle",{"cx":"11","cy":"11","r":"8"}]],"search-slash":[["path",{"d":"m13.5 8.5-5 5"}],["circle",{"cx":"11","cy":"11","r":"8"}],["path",{"d":"m21 21-4.3-4.3"}]],"search-x":[["path",{"d":"m13.5 8.5-5 5"}],["path",{"d":"m8.5 8.5 5 5"}],["circle",{"cx":"11","cy":"11","r":"8"}],["path",{"d":"m21 21-4.3-4.3"}]],"search":[["path",{"d":"m21 21-4.34-4.34"}],["circle",{"cx":"11","cy":"11","r":"8"}]],"section":[["path",{"d":"M16 5a4 3 0 0 0-8 0c0 4 8 3 8 7a4 3 0 0 1-8 0"}],["path",{"d":"M8 19a4 3 0 0 0 8 0c0-4-8-3-8-7a4 3 0 0 1 8 0"}]],"send-horizontal":[["path",{"d":"M3.714 3.048a.498.498 0 0 0-.683.627l2.843 7.627a2 2 0 0 1 0 1.396l-2.842 7.627a.498.498 0 0 0 .682.627l18-8.5a.5.5 0 0 0 0-.904z"}],["path",{"d":"M6 12h16"}]],"send-to-back":[["rect",{"x":"14","y":"14","width":"8","height":"8","rx":"2"}],["rect",{"x":"2","y":"2","width":"8","height":"8","rx":"2"}],["path",{"d":"M7 14v1a2 2 0 0 0 2 2h1"}],["path",{"d":"M14 7h1a2 2 0 0 1 2 2v1"}]],"send":[["path",{"d":"M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"}],["path",{"d":"m21.854 2.147-10.94 10.939"}]],"separator-horizontal":[["path",{"d":"m16 16-4 4-4-4"}],["path",{"d":"M3 12h18"}],["path",{"d":"m8 8 4-4 4 4"}]],"separator-vertical":[["path",{"d":"M12 3v18"}],["path",{"d":"m16 16 4-4-4-4"}],["path",{"d":"m8 8-4 4 4 4"}]],"server-cog":[["path",{"d":"m10.852 14.772-.383.923"}],["path",{"d":"M13.148 14.772a3 3 0 1 0-2.296-5.544l-.383-.923"}],["path",{"d":"m13.148 9.228.383-.923"}],["path",{"d":"m13.53 15.696-.382-.924a3 3 0 1 1-2.296-5.544"}],["path",{"d":"m14.772 10.852.923-.383"}],["path",{"d":"m14.772 13.148.923.383"}],["path",{"d":"M4.5 10H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-.5"}],["path",{"d":"M4.5 14H4a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2h-.5"}],["path",{"d":"M6 18h.01"}],["path",{"d":"M6 6h.01"}],["path",{"d":"m9.228 10.852-.923-.383"}],["path",{"d":"m9.228 13.148-.923.383"}]],"server-crash":[["path",{"d":"M6 10H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2"}],["path",{"d":"M6 14H4a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2h-2"}],["path",{"d":"M6 6h.01"}],["path",{"d":"M6 18h.01"}],["path",{"d":"m13 6-4 6h6l-4 6"}]],"server-off":[["path",{"d":"M7 2h13a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-5"}],["path",{"d":"M10 10 2.5 2.5C2 2 2 2.5 2 5v3a2 2 0 0 0 2 2h6z"}],["path",{"d":"M22 17v-1a2 2 0 0 0-2-2h-1"}],["path",{"d":"M4 14a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h16.5l1-.5.5.5-8-8H4z"}],["path",{"d":"M6 18h.01"}],["path",{"d":"m2 2 20 20"}]],"server-plus":[["path",{"d":"M12.5 10H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v2"}],["path",{"d":"M16 12h6"}],["path",{"d":"M19 9v6"}],["path",{"d":"M22 18v2a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h8.5"}],["path",{"d":"M6 18h.01"}],["path",{"d":"M6 6h.01"}]],"server":[["rect",{"width":"20","height":"8","x":"2","y":"2","rx":"2","ry":"2"}],["rect",{"width":"20","height":"8","x":"2","y":"14","rx":"2","ry":"2"}],["line",{"x1":"6","x2":"6.01","y1":"6","y2":"6"}],["line",{"x1":"6","x2":"6.01","y1":"18","y2":"18"}]],"settings-2":[["path",{"d":"M14 17H5"}],["path",{"d":"M19 7h-9"}],["circle",{"cx":"17","cy":"17","r":"3"}],["circle",{"cx":"7","cy":"7","r":"3"}]],"settings":[["path",{"d":"M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"}],["circle",{"cx":"12","cy":"12","r":"3"}]],"shapes":[["path",{"d":"M8.3 10a.7.7 0 0 1-.626-1.079L11.4 3a.7.7 0 0 1 1.198-.043L16.3 8.9a.7.7 0 0 1-.572 1.1Z"}],["rect",{"x":"3","y":"14","width":"7","height":"7","rx":"1"}],["circle",{"cx":"17.5","cy":"17.5","r":"3.5"}]],"share-2":[["circle",{"cx":"18","cy":"5","r":"3"}],["circle",{"cx":"6","cy":"12","r":"3"}],["circle",{"cx":"18","cy":"19","r":"3"}],["line",{"x1":"8.59","x2":"15.42","y1":"13.51","y2":"17.49"}],["line",{"x1":"15.41","x2":"8.59","y1":"6.51","y2":"10.49"}]],"share":[["path",{"d":"M12 2v13"}],["path",{"d":"m16 6-4-4-4 4"}],["path",{"d":"M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"}]],"sheet":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2","ry":"2"}],["line",{"x1":"3","x2":"21","y1":"9","y2":"9"}],["line",{"x1":"3","x2":"21","y1":"15","y2":"15"}],["line",{"x1":"9","x2":"9","y1":"9","y2":"21"}],["line",{"x1":"15","x2":"15","y1":"9","y2":"21"}]],"shell":[["path",{"d":"M14 11a2 2 0 1 1-4 0 4 4 0 0 1 8 0 6 6 0 0 1-12 0 8 8 0 0 1 16 0 10 10 0 1 1-20 0 11.93 11.93 0 0 1 2.42-7.22 2 2 0 1 1 3.16 2.44"}]],"shelving-unit":[["path",{"d":"M12 12V9a1 1 0 0 0-1-1H9a1 1 0 0 0-1 1v3"}],["path",{"d":"M16 20v-3a1 1 0 0 0-1-1h-2a1 1 0 0 0-1 1v3"}],["path",{"d":"M20 22V2"}],["path",{"d":"M4 12h16"}],["path",{"d":"M4 20h16"}],["path",{"d":"M4 2v20"}],["path",{"d":"M4 4h16"}]],"shield-alert":[["path",{"d":"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"}],["path",{"d":"M12 8v4"}],["path",{"d":"M12 16h.01"}]],"shield-ban":[["path",{"d":"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"}],["path",{"d":"m4.243 5.21 14.39 12.472"}]],"shield-check":[["path",{"d":"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"}],["path",{"d":"m9 12 2 2 4-4"}]],"shield-cog-corner":[["path",{"d":"M11 22c-3.806-1.45-7-3.966-7-9V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1v4"}],["path",{"d":"M14.923 16.547 14 16.164"}],["path",{"d":"m14.923 18.843-.923.383"}],["path",{"d":"M16.547 14.923 16.164 14"}],["path",{"d":"m16.547 20.467-.383.924"}],["path",{"d":"m18.843 14.923.383-.923"}],["path",{"d":"m19.225 21.391-.382-.924"}],["path",{"d":"m20.467 16.547.923-.383"}],["path",{"d":"m20.467 18.843.923.383"}],["circle",{"cx":"17.695","cy":"17.695","r":"3"}]],"shield-cog":[["path",{"d":"m10.929 14.467-.383.924"}],["path",{"d":"M10.929 8.923 10.546 8"}],["path",{"d":"M13.225 8.923 13.608 8"}],["path",{"d":"m13.607 15.391-.382-.924"}],["path",{"d":"m14.849 10.547.923-.383"}],["path",{"d":"m14.849 12.843.923.383"}],["path",{"d":"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"}],["path",{"d":"m9.305 10.547-.923-.383"}],["path",{"d":"m9.305 12.843-.923.383"}],["circle",{"cx":"12.077","cy":"11.695","r":"3"}]],"shield-ellipsis":[["path",{"d":"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"}],["path",{"d":"M8 12h.01"}],["path",{"d":"M12 12h.01"}],["path",{"d":"M16 12h.01"}]],"shield-half":[["path",{"d":"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"}],["path",{"d":"M12 22V2"}]],"shield-keyhole":[["path",{"d":"M12 13v3"}],["path",{"d":"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 01-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 011-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 011.52 0C14.51 3.81 17 5 19 5a1 1 0 011 1z"}],["circle",{"cx":"12","cy":"11","r":"2"}]],"shield-lock":[["path",{"d":"M20 9.807V6a1 1 0 00-1-1c-2 0-4.49-1.19-6.24-2.72a1.17 1.17 0 00-1.52 0C9.5 3.8 7 5 5 5a1 1 0 00-1 1v7c0 3.88 2.107 6.254 5 7.796"}],["path",{"d":"M19 17v-2a2 2 0 00-4 0v2"}],["rect",{"x":"13","y":"17","width":"8","height":"5","rx":"1"}]],"shield-minus":[["path",{"d":"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"}],["path",{"d":"M9 12h6"}]],"shield-off":[["path",{"d":"m2 2 20 20"}],["path",{"d":"M5 5a1 1 0 0 0-1 1v7c0 5 3.5 7.5 7.67 8.94a1 1 0 0 0 .67.01c2.35-.82 4.48-1.97 5.9-3.71"}],["path",{"d":"M9.309 3.652A12.252 12.252 0 0 0 11.24 2.28a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1v7a9.784 9.784 0 0 1-.08 1.264"}]],"shield-plus":[["path",{"d":"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"}],["path",{"d":"M9 12h6"}],["path",{"d":"M12 9v6"}]],"shield-question-mark":[["path",{"d":"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"}],["path",{"d":"M9.1 9a3 3 0 0 1 5.82 1c0 2-3 3-3 3"}],["path",{"d":"M12 17h.01"}]],"shield-user":[["path",{"d":"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"}],["path",{"d":"M6.376 18.91a6 6 0 0 1 11.249.003"}],["circle",{"cx":"12","cy":"11","r":"4"}]],"shield-x":[["path",{"d":"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"}],["path",{"d":"m14.5 9.5-5 5"}],["path",{"d":"m9.5 9.5 5 5"}]],"shield":[["path",{"d":"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"}]],"ship-cargo":[["path",{"d":"M12 15v-3"}],["path",{"d":"M12 2v2"}],["path",{"d":"M16.5 12V9a1 1 0 011-1h1a1 1 0 001-1V5a1 1 0 00-1-1h-13a1 1 0 00-1 1v2a1 1 0 001 1h1a1 1 0 011 1v3"}],["path",{"d":"M19.38 19c1.076-1.815 1.636-4.89 1.628-6.008a1 1 0 00-1-.992H3.984a1 1 0 00-1 .984c-.03 1.86.97 5.621 2.826 7.776"}],["path",{"d":"M2 20c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1s1.2 1 2.5 1c2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"}]],"ship-wheel":[["circle",{"cx":"12","cy":"12","r":"8"}],["path",{"d":"M12 2v7.5"}],["path",{"d":"m19 5-5.23 5.23"}],["path",{"d":"M22 12h-7.5"}],["path",{"d":"m19 19-5.23-5.23"}],["path",{"d":"M12 14.5V22"}],["path",{"d":"M10.23 13.77 5 19"}],["path",{"d":"M9.5 12H2"}],["path",{"d":"M10.23 10.23 5 5"}],["circle",{"cx":"12","cy":"12","r":"2.5"}]],"ship":[["path",{"d":"M12 2v2"}],["path",{"d":"M12 9.189V13"}],["path",{"d":"M19 12V6a2 2 0 00-2-2H7a2 2 0 00-2 2v6"}],["path",{"d":"M19.38 19A11.6 11.6 0 0021 13l-8.188-3.639a2 2 0 00-1.624 0L3 13.001a11.6 11.6 0 002.81 7.76"}],["path",{"d":"M2 20c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1s1.2 1 2.5 1c2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"}]],"shirt":[["path",{"d":"M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10c0 1.1.9 2 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23z"}]],"shopping-bag":[["path",{"d":"M16 10a4 4 0 0 1-8 0"}],["path",{"d":"M3.103 6.034h17.794"}],["path",{"d":"M3.4 5.467a2 2 0 0 0-.4 1.2V20a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6.667a2 2 0 0 0-.4-1.2l-2-2.667A2 2 0 0 0 17 2H7a2 2 0 0 0-1.6.8z"}]],"shopping-basket":[["path",{"d":"m15 11-1 9"}],["path",{"d":"m19 11-4-7"}],["path",{"d":"M2 11h20"}],["path",{"d":"m3.5 11 1.6 7.4a2 2 0 0 0 2 1.6h9.8a2 2 0 0 0 2-1.6l1.7-7.4"}],["path",{"d":"M4.5 15.5h15"}],["path",{"d":"m5 11 4-7"}],["path",{"d":"m9 11 1 9"}]],"shopping-cart-minus":[["path",{"d":"M16 5h6"}],["path",{"d":"m2.05 2.05 1.099-.028a1 1 0 011.008.815l2.69 14.347A1 1 0 007.83 18H18"}],["path",{"d":"M4.564 5H12"}],["path",{"d":"M6.25 14h12.712a2 2 0 001.991-1.57l.514-3.113"}],["circle",{"cx":"18","cy":"20","r":"2"}],["circle",{"cx":"8","cy":"20","r":"2"}]],"shopping-cart-plus":[["path",{"d":"M16 5h6"}],["path",{"d":"M19 2v6"}],["path",{"d":"m2.05 2.05 1.099-.028a1 1 0 011.008.815l2.69 14.347A1 1 0 007.83 18H18"}],["path",{"d":"M4.564 5H12"}],["path",{"d":"M6.25 14h12.712a2 2 0 001.991-1.57l.172-1.041"}],["circle",{"cx":"18","cy":"20","r":"2"}],["circle",{"cx":"8","cy":"20","r":"2"}]],"shopping-cart":[["path",{"d":"m2.05 2.05 1.099-.028a1 1 0 0 1 1.008.815l2.69 14.347A1 1 0 0 0 7.83 18H18"}],["path",{"d":"M4.563 5h16.435a1 1 0 0 1 .981 1.204l-1.026 6.226A2 2 0 0 1 18.962 14H6.25"}],["circle",{"cx":"18","cy":"20","r":"2"}],["circle",{"cx":"8","cy":"20","r":"2"}]],"shovel":[["path",{"d":"M21.56 4.56a1.5 1.5 0 0 1 0 2.122l-.47.47a3 3 0 0 1-4.212-.03 3 3 0 0 1 0-4.243l.44-.44a1.5 1.5 0 0 1 2.121 0z"}],["path",{"d":"M3 22a1 1 0 0 1-1-1v-3.586a1 1 0 0 1 .293-.707l3.355-3.355a1.205 1.205 0 0 1 1.704 0l3.296 3.296a1.205 1.205 0 0 1 0 1.704l-3.355 3.355a1 1 0 0 1-.707.293z"}],["path",{"d":"m9 15 7.879-7.878"}]],"shower-head":[["path",{"d":"m4 4 2.5 2.5"}],["path",{"d":"M13.5 6.5a4.95 4.95 0 0 0-7 7"}],["path",{"d":"M15 5 5 15"}],["path",{"d":"M14 17v.01"}],["path",{"d":"M10 16v.01"}],["path",{"d":"M13 13v.01"}],["path",{"d":"M16 10v.01"}],["path",{"d":"M11 20v.01"}],["path",{"d":"M17 14v.01"}],["path",{"d":"M20 11v.01"}]],"shredder":[["path",{"d":"M4 13V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v5"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"M10 22v-5"}],["path",{"d":"M14 19v-2"}],["path",{"d":"M18 20v-3"}],["path",{"d":"M2 13h20"}],["path",{"d":"M6 20v-3"}]],"shrimp-off":[["path",{"d":"M10 2a3.28 3.28 0 003.227 1.798l6.17-.561A1 1 0 1119.614 8H13.5"}],["path",{"d":"M11 20c-.5.5-1.12 1-2.5 1a1 1 0 010-5H12a7 7 0 003.283-.817"}],["path",{"d":"M11 22c-.5-.5-1.12-1-2.5-1a6.5 6.5 0 01-5.63-3.25 6.44 6.44 0 015.236-9.744"}],["path",{"d":"M18.04 12.54A7 7 0 0019 9V8"}],["path",{"d":"m2 2 20 20"}],["path",{"d":"M8 16c-2 0-4.5-4-4-6"}],["path",{"d":"M9.43 9.33A8.5 8.5 0 0010 16"}]],"shrimp":[["path",{"d":"M10 2a3.28 3.28 0 003.227 1.798l6.17-.561A1 1 0 1119.614 8H8.5a6.44 6.44 0 00-5.63 9.75A6.5 6.5 0 008.5 21c1.38 0 2-.5 2.5-1"}],["path",{"d":"M10 8a8.5 8.5 0 000 8"}],["path",{"d":"M11 22c-.5-.5-1.12-1-2.5-1a1 1 0 010-5H12a7 7 0 007-7V8"}],["path",{"d":"M13 12h.01"}],["path",{"d":"M8 16c-2 0-4.5-4-4-6"}]],"shrink":[["path",{"d":"m15 15 6 6m-6-6v4.8m0-4.8h4.8"}],["path",{"d":"M9 19.8V15m0 0H4.2M9 15l-6 6"}],["path",{"d":"M15 4.2V9m0 0h4.8M15 9l6-6"}],["path",{"d":"M9 4.2V9m0 0H4.2M9 9 3 3"}]],"shrub":[["path",{"d":"M12 22v-5.172a2 2 0 0 0-.586-1.414L9.5 13.5"}],["path",{"d":"M14.5 14.5 12 17"}],["path",{"d":"M17 8.8A6 6 0 0 1 13.8 20H10A6.5 6.5 0 0 1 7 8a5 5 0 0 1 10 0z"}]],"shuffle":[["path",{"d":"m18 14 4 4-4 4"}],["path",{"d":"m18 2 4 4-4 4"}],["path",{"d":"M2 18h1.973a4 4 0 0 0 3.3-1.7l5.454-8.6a4 4 0 0 1 3.3-1.7H22"}],["path",{"d":"M2 6h1.972a4 4 0 0 1 3.6 2.2"}],["path",{"d":"M22 18h-6.041a4 4 0 0 1-3.3-1.8l-.359-.45"}]],"sigma":[["path",{"d":"M18 7V5a1 1 0 0 0-1-1H6.5a.5.5 0 0 0-.4.8l4.5 6a2 2 0 0 1 0 2.4l-4.5 6a.5.5 0 0 0 .4.8H17a1 1 0 0 0 1-1v-2"}]],"signal-high":[["path",{"d":"M2 20h.01"}],["path",{"d":"M7 20v-4"}],["path",{"d":"M12 20v-8"}],["path",{"d":"M17 20V8"}]],"signal-low":[["path",{"d":"M2 20h.01"}],["path",{"d":"M7 20v-4"}]],"signal-medium":[["path",{"d":"M2 20h.01"}],["path",{"d":"M7 20v-4"}],["path",{"d":"M12 20v-8"}]],"signal-zero":[["path",{"d":"M2 20h.01"}]],"signal":[["path",{"d":"M2 20h.01"}],["path",{"d":"M7 20v-4"}],["path",{"d":"M12 20v-8"}],["path",{"d":"M17 20V8"}],["path",{"d":"M22 4v16"}]],"signature":[["path",{"d":"m21 17-2.156-1.868A.5.5 0 0 0 18 15.5v.5a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1c0-2.545-3.991-3.97-8.5-4a1 1 0 0 0 0 5c4.153 0 4.745-11.295 5.708-13.5a2.5 2.5 0 1 1 3.31 3.284"}],["path",{"d":"M3 21h18"}]],"signpost-big":[["path",{"d":"M10 9H4L2 7l2-2h6"}],["path",{"d":"M14 5h6l2 2-2 2h-6"}],["path",{"d":"M10 22V4a2 2 0 1 1 4 0v18"}],["path",{"d":"M8 22h8"}]],"signpost":[["path",{"d":"M12 13v8"}],["path",{"d":"M12 3v3"}],["path",{"d":"M2.354 10.354a1.207 1.207 0 0 1 0-1.708l2.06-2.06A2 2 0 0 1 5.828 6h12.344a2 2 0 0 1 1.414.586l2.06 2.06a1.207 1.207 0 0 1 0 1.708l-2.06 2.06a2 2 0 0 1-1.414.586H5.828a2 2 0 0 1-1.414-.586z"}]],"siren":[["path",{"d":"M7 18v-6a5 5 0 1 1 10 0v6"}],["path",{"d":"M5 21a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-1a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2z"}],["path",{"d":"M21 12h1"}],["path",{"d":"M18.5 4.5 18 5"}],["path",{"d":"M2 12h1"}],["path",{"d":"M12 2v1"}],["path",{"d":"m4.929 4.929.707.707"}],["path",{"d":"M12 12v6"}]],"skip-back":[["path",{"d":"M17.971 4.285A2 2 0 0 1 21 6v12a2 2 0 0 1-3.029 1.715l-9.997-5.998a2 2 0 0 1-.003-3.432z"}],["path",{"d":"M3 20V4"}]],"skip-forward":[["path",{"d":"M21 4v16"}],["path",{"d":"M6.029 4.285A2 2 0 0 0 3 6v12a2 2 0 0 0 3.029 1.715l9.997-5.998a2 2 0 0 0 .003-3.432z"}]],"skull":[["path",{"d":"m12.5 17-.5-1-.5 1h1z"}],["path",{"d":"M15 22a1 1 0 0 0 1-1v-1a2 2 0 0 0 1.56-3.25 8 8 0 1 0-11.12 0A2 2 0 0 0 8 20v1a1 1 0 0 0 1 1z"}],["circle",{"cx":"15","cy":"12","r":"1"}],["circle",{"cx":"9","cy":"12","r":"1"}]],"slash":[["path",{"d":"M22 2 2 22"}]],"slice":[["path",{"d":"M11 16.586V19a1 1 0 0 1-1 1H2L18.37 3.63a1 1 0 1 1 3 3l-9.663 9.663a1 1 0 0 1-1.414 0L8 14"}]],"sliders-horizontal":[["path",{"d":"M10 5H3"}],["path",{"d":"M12 19H3"}],["path",{"d":"M14 3v4"}],["path",{"d":"M16 17v4"}],["path",{"d":"M21 12h-9"}],["path",{"d":"M21 19h-5"}],["path",{"d":"M21 5h-7"}],["path",{"d":"M8 10v4"}],["path",{"d":"M8 12H3"}]],"sliders-vertical":[["path",{"d":"M10 8h4"}],["path",{"d":"M12 21v-9"}],["path",{"d":"M12 8V3"}],["path",{"d":"M17 16h4"}],["path",{"d":"M19 12V3"}],["path",{"d":"M19 21v-5"}],["path",{"d":"M3 14h4"}],["path",{"d":"M5 10V3"}],["path",{"d":"M5 21v-7"}]],"smartphone-charging":[["rect",{"width":"14","height":"20","x":"5","y":"2","rx":"2","ry":"2"}],["path",{"d":"M12.667 8 10 12h4l-2.667 4"}]],"smartphone-nfc":[["rect",{"width":"7","height":"12","x":"2","y":"6","rx":"1"}],["path",{"d":"M13 8.32a7.43 7.43 0 0 1 0 7.36"}],["path",{"d":"M16.46 6.21a11.76 11.76 0 0 1 0 11.58"}],["path",{"d":"M19.91 4.1a15.91 15.91 0 0 1 .01 15.8"}]],"smartphone":[["rect",{"width":"14","height":"20","x":"5","y":"2","rx":"2","ry":"2"}],["path",{"d":"M12 18h.01"}]],"snail":[["path",{"d":"M2 13a6 6 0 1 0 12 0 4 4 0 1 0-8 0 2 2 0 0 0 4 0"}],["circle",{"cx":"10","cy":"13","r":"8"}],["path",{"d":"M2 21h12c4.4 0 8-3.6 8-8V7a2 2 0 1 0-4 0v6"}],["path",{"d":"M18 3 19.1 5.2"}],["path",{"d":"M22 3 20.9 5.2"}]],"snowflake":[["path",{"d":"m10 20-1.25-2.5L6 18"}],["path",{"d":"M10 4 8.75 6.5 6 6"}],["path",{"d":"m14 20 1.25-2.5L18 18"}],["path",{"d":"m14 4 1.25 2.5L18 6"}],["path",{"d":"m17 21-3-6h-4"}],["path",{"d":"m17 3-3 6 1.5 3"}],["path",{"d":"M2 12h6.5L10 9"}],["path",{"d":"m20 10-1.5 2 1.5 2"}],["path",{"d":"M22 12h-6.5L14 15"}],["path",{"d":"m4 10 1.5 2L4 14"}],["path",{"d":"m7 21 3-6-1.5-3"}],["path",{"d":"m7 3 3 6h4"}]],"soap-dispenser-droplet":[["path",{"d":"M10.5 2v4"}],["path",{"d":"M14 2H7a2 2 0 0 0-2 2"}],["path",{"d":"M19.29 14.76A6.67 6.67 0 0 1 17 11a6.6 6.6 0 0 1-2.29 3.76c-1.15.92-1.71 2.04-1.71 3.19 0 2.22 1.8 4.05 4 4.05s4-1.83 4-4.05c0-1.16-.57-2.26-1.71-3.19"}],["path",{"d":"M9.607 21H6a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h7V7a1 1 0 0 0-1-1H9a1 1 0 0 0-1 1v3"}]],"sofa":[["path",{"d":"M20 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v3"}],["path",{"d":"M2 16a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5a2 2 0 0 0-4 0v1.5a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5V11a2 2 0 0 0-4 0z"}],["path",{"d":"M4 18v2"}],["path",{"d":"M20 18v2"}],["path",{"d":"M12 4v9"}]],"solar-panel":[["path",{"d":"M11 2h2"}],["path",{"d":"m14.28 14-4.56 8"}],["path",{"d":"m21 22-1.558-4H4.558"}],["path",{"d":"M3 10v2"}],["path",{"d":"M6.245 15.04A2 2 0 0 1 8 14h12a1 1 0 0 1 .864 1.505l-3.11 5.457A2 2 0 0 1 16 22H4a1 1 0 0 1-.863-1.506z"}],["path",{"d":"M7 2a4 4 0 0 1-4 4"}],["path",{"d":"m8.66 7.66 1.41 1.41"}]],"soup":[["path",{"d":"M12 21a9 9 0 0 0 9-9H3a9 9 0 0 0 9 9Z"}],["path",{"d":"M7 21h10"}],["path",{"d":"M19.5 12 22 6"}],["path",{"d":"M16.25 3c.27.1.8.53.75 1.36-.06.83-.93 1.2-1 2.02-.05.78.34 1.24.73 1.62"}],["path",{"d":"M11.25 3c.27.1.8.53.74 1.36-.05.83-.93 1.2-.98 2.02-.06.78.33 1.24.72 1.62"}],["path",{"d":"M6.25 3c.27.1.8.53.75 1.36-.06.83-.93 1.2-1 2.02-.05.78.34 1.24.74 1.62"}]],"space":[["path",{"d":"M22 17v1c0 .5-.5 1-1 1H3c-.5 0-1-.5-1-1v-1"}]],"spade":[["path",{"d":"M12 18v4"}],["path",{"d":"M2 14.499a5.5 5.5 0 0 0 9.591 3.675.6.6 0 0 1 .818.001A5.5 5.5 0 0 0 22 14.5c0-2.29-1.5-4-3-5.5l-5.492-5.312a2 2 0 0 0-3-.02L5 8.999c-1.5 1.5-3 3.2-3 5.5"}]],"sparkle":[["path",{"d":"M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"}]],"sparkles":[["path",{"d":"M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"}],["path",{"d":"M20 2v4"}],["path",{"d":"M22 4h-4"}],["circle",{"cx":"4","cy":"20","r":"2"}]],"speaker":[["rect",{"width":"16","height":"20","x":"4","y":"2","rx":"2"}],["path",{"d":"M12 6h.01"}],["circle",{"cx":"12","cy":"14","r":"4"}],["path",{"d":"M12 14h.01"}]],"speech":[["path",{"d":"M8.8 20v-4.1l1.9.2a2.3 2.3 0 0 0 2.164-2.1V8.3A5.37 5.37 0 0 0 2 8.25c0 2.8.656 3.054 1 4.55a5.77 5.77 0 0 1 .029 2.758L2 20"}],["path",{"d":"M19.8 17.8a7.5 7.5 0 0 0 .003-10.603"}],["path",{"d":"M17 15a3.5 3.5 0 0 0-.025-4.975"}]],"spell-check-2":[["path",{"d":"m6 16 6-12 6 12"}],["path",{"d":"M8 12h8"}],["path",{"d":"M4 21c1.1 0 1.1-1 2.3-1s1.1 1 2.3 1c1.1 0 1.1-1 2.3-1 1.1 0 1.1 1 2.3 1 1.1 0 1.1-1 2.3-1 1.1 0 1.1 1 2.3 1 1.1 0 1.1-1 2.3-1"}]],"spell-check":[["path",{"d":"m20 15-5.5 5.5L12 18"}],["path",{"d":"m4 16 6-12 5.115 10.23"}],["path",{"d":"M6 12h8"}]],"spline-pointer":[["path",{"d":"M12.034 12.681a.498.498 0 0 1 .647-.647l9 3.5a.5.5 0 0 1-.033.943l-3.444 1.068a1 1 0 0 0-.66.66l-1.067 3.443a.5.5 0 0 1-.943.033z"}],["path",{"d":"M5 17A12 12 0 0 1 17 5"}],["circle",{"cx":"19","cy":"5","r":"2"}],["circle",{"cx":"5","cy":"19","r":"2"}]],"spline":[["circle",{"cx":"19","cy":"5","r":"2"}],["circle",{"cx":"5","cy":"19","r":"2"}],["path",{"d":"M5 17A12 12 0 0 1 17 5"}]],"split":[["path",{"d":"M16 3h5v5"}],["path",{"d":"M8 3H3v5"}],["path",{"d":"M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3"}],["path",{"d":"m15 9 6-6"}]],"spool":[["path",{"d":"M17 13.44 4.442 17.082A2 2 0 0 0 4.982 21H19a2 2 0 0 0 .558-3.921l-1.115-.32A2 2 0 0 1 17 14.837V7.66"}],["path",{"d":"m7 10.56 12.558-3.642A2 2 0 0 0 19.018 3H5a2 2 0 0 0-.558 3.921l1.115.32A2 2 0 0 1 7 9.163v7.178"}]],"sport-shoe":[["path",{"d":"m15 10.42 4.8-5.07"}],["path",{"d":"M19 18h3"}],["path",{"d":"M9.5 22 21.414 9.415A2 2 0 0 0 21.2 6.4l-5.61-4.208A1 1 0 0 0 14 3v2a2 2 0 0 1-1.394 1.906L8.677 8.053A1 1 0 0 0 8 9c-.155 6.393-2.082 9-4 9a2 2 0 0 0 0 4h14"}]],"spotlight":[["path",{"d":"M15.295 19.562 16 22"}],["path",{"d":"m17 16 3.758 2.098"}],["path",{"d":"m19 12.5 3.026-.598"}],["path",{"d":"M7.61 6.3a3 3 0 0 0-3.92 1.3l-1.38 2.79a3 3 0 0 0 1.3 3.91l6.89 3.597a1 1 0 0 0 1.342-.447l3.106-6.211a1 1 0 0 0-.447-1.341z"}],["path",{"d":"M8 9V2"}]],"spray-can":[["path",{"d":"M3 3h.01"}],["path",{"d":"M7 5h.01"}],["path",{"d":"M11 7h.01"}],["path",{"d":"M3 7h.01"}],["path",{"d":"M7 9h.01"}],["path",{"d":"M3 11h.01"}],["rect",{"width":"4","height":"4","x":"15","y":"5"}],["path",{"d":"m19 9 2 2v10c0 .6-.4 1-1 1h-6c-.6 0-1-.4-1-1V11l2-2"}],["path",{"d":"m13 14 8-2"}],["path",{"d":"m13 19 8-2"}]],"sprout":[["path",{"d":"M14 9.536V7a4 4 0 0 1 4-4h1.5a.5.5 0 0 1 .5.5V5a4 4 0 0 1-4 4 4 4 0 0 0-4 4c0 2 1 3 1 5a5 5 0 0 1-1 3"}],["path",{"d":"M4 9a5 5 0 0 1 8 4 5 5 0 0 1-8-4"}],["path",{"d":"M5 21h14"}]],"square-activity":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M17 12h-2l-2 5-2-10-2 5H7"}]],"square-arrow-down-left":[["path",{"d":"M15 15H9l6-6"}],["path",{"d":"M9 15V9"}],["rect",{"x":"3","y":"3","width":"18","height":"18","rx":"2"}]],"square-arrow-down-right":[["path",{"d":"M15 15 9 9"}],["path",{"d":"M9 15h6V9"}],["rect",{"x":"3","y":"3","width":"18","height":"18","rx":"2"}]],"square-arrow-down":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M12 8v8"}],["path",{"d":"m8 12 4 4 4-4"}]],"square-arrow-left":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"m12 8-4 4 4 4"}],["path",{"d":"M16 12H8"}]],"square-arrow-out-down-left":[["path",{"d":"M13 21h6a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6"}],["path",{"d":"m3 21 9-9"}],["path",{"d":"M9 21H3v-6"}]],"square-arrow-out-down-right":[["path",{"d":"M21 11V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h6"}],["path",{"d":"m21 21-9-9"}],["path",{"d":"M21 15v6h-6"}]],"square-arrow-out-up-left":[["path",{"d":"M13 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-6"}],["path",{"d":"m3 3 9 9"}],["path",{"d":"M3 9V3h6"}]],"square-arrow-out-up-right":[["path",{"d":"M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6"}],["path",{"d":"m21 3-9 9"}],["path",{"d":"M15 3h6v6"}]],"square-arrow-right-enter":[["path",{"d":"m10 16 4-4-4-4"}],["path",{"d":"M3 12h11"}],["path",{"d":"M3 8V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3"}]],"square-arrow-right-exit":[["path",{"d":"M10 12h11"}],["path",{"d":"m17 16 4-4-4-4"}],["path",{"d":"M21 6.344V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-1.344"}]],"square-arrow-right":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M8 12h8"}],["path",{"d":"m12 16 4-4-4-4"}]],"square-arrow-up-left":[["path",{"d":"M15 15 9 9"}],["path",{"d":"M9 15V9h6"}],["rect",{"x":"3","y":"3","width":"18","height":"18","rx":"2"}]],"square-arrow-up-right":[["path",{"d":"M15 15V9H9"}],["path",{"d":"m9 15 6-6"}],["rect",{"x":"3","y":"3","width":"18","height":"18","rx":"2"}]],"square-arrow-up":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"m16 12-4-4-4 4"}],["path",{"d":"M12 16V8"}]],"square-asterisk":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M12 8v8"}],["path",{"d":"m8.5 14 7-4"}],["path",{"d":"m8.5 10 7 4"}]],"square-bookmark":[["path",{"d":"M11 3v7.751a.25.25 0 00.407.195l2.28-1.834a.5.5 0 01.627 0l2.28 1.834a.25.25 0 00.406-.195V3"}],["rect",{"x":"3","y":"3","width":"18","height":"18","rx":"2"}]],"square-bottom-dashed-scissors":[["path",{"d":"M14 21h1"}],["path",{"d":"m17 17-2.18-2.18"}],["path",{"d":"M5 21a2 2 0 01-2-2V5a2 2 0 012-2h14a2 2 0 012 2v14a2 2 0 01-2 2"}],["path",{"d":"M9 21h1"}],["path",{"d":"M9.56 14.44 17 7"}],["path",{"d":"M9.56 9.56 12 12"}],["circle",{"cx":"8.5","cy":"15.5","r":"1.5"}],["circle",{"cx":"8.5","cy":"8.5","r":"1.5"}]],"square-centerline-dashed-horizontal":[["path",{"d":"M8 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h3"}],["path",{"d":"M16 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3"}],["path",{"d":"M12 20v2"}],["path",{"d":"M12 14v2"}],["path",{"d":"M12 8v2"}],["path",{"d":"M12 2v2"}]],"square-centerline-dashed-vertical":[["path",{"d":"M21 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v3"}],["path",{"d":"M21 16v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3"}],["path",{"d":"M4 12H2"}],["path",{"d":"M10 12H8"}],["path",{"d":"M16 12h-2"}],["path",{"d":"M22 12h-2"}]],"square-chart-gantt":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M9 8h7"}],["path",{"d":"M8 12h6"}],["path",{"d":"M11 16h5"}]],"square-check-big":[["path",{"d":"M21 10.656V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12.344"}],["path",{"d":"m9 11 3 3L22 4"}]],"square-check":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"m16 9-5.5 5.5L8 12"}]],"square-chevron-down":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"m16 10-4 4-4-4"}]],"square-chevron-left":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"m14 16-4-4 4-4"}]],"square-chevron-right":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"m10 8 4 4-4 4"}]],"square-chevron-up":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"m8 14 4-4 4 4"}]],"square-code":[["path",{"d":"m10 9-3 3 3 3"}],["path",{"d":"m14 15 3-3-3-3"}],["rect",{"x":"3","y":"3","width":"18","height":"18","rx":"2"}]],"square-dashed-bottom-code":[["path",{"d":"M10 9.5 8 12l2 2.5"}],["path",{"d":"M14 21h1"}],["path",{"d":"m14 9.5 2 2.5-2 2.5"}],["path",{"d":"M5 21a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2"}],["path",{"d":"M9 21h1"}]],"square-dashed-bottom":[["path",{"d":"M5 21a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2"}],["path",{"d":"M9 21h1"}],["path",{"d":"M14 21h1"}]],"square-dashed-kanban":[["path",{"d":"M8 7v7"}],["path",{"d":"M12 7v4"}],["path",{"d":"M16 7v9"}],["path",{"d":"M5 3a2 2 0 0 0-2 2"}],["path",{"d":"M9 3h1"}],["path",{"d":"M14 3h1"}],["path",{"d":"M19 3a2 2 0 0 1 2 2"}],["path",{"d":"M21 9v1"}],["path",{"d":"M21 14v1"}],["path",{"d":"M21 19a2 2 0 0 1-2 2"}],["path",{"d":"M14 21h1"}],["path",{"d":"M9 21h1"}],["path",{"d":"M5 21a2 2 0 0 1-2-2"}],["path",{"d":"M3 14v1"}],["path",{"d":"M3 9v1"}]],"square-dashed-mouse-pointer":[["path",{"d":"M12.034 12.681a.498.498 0 0 1 .647-.647l9 3.5a.5.5 0 0 1-.033.943l-3.444 1.068a1 1 0 0 0-.66.66l-1.067 3.443a.5.5 0 0 1-.943.033z"}],["path",{"d":"M5 3a2 2 0 0 0-2 2"}],["path",{"d":"M19 3a2 2 0 0 1 2 2"}],["path",{"d":"M5 21a2 2 0 0 1-2-2"}],["path",{"d":"M9 3h1"}],["path",{"d":"M9 21h2"}],["path",{"d":"M14 3h1"}],["path",{"d":"M3 9v1"}],["path",{"d":"M21 9v2"}],["path",{"d":"M3 14v1"}]],"square-dashed-plus":[["path",{"d":"M5 3a2 2 0 0 0-2 2"}],["path",{"d":"M19 3a2 2 0 0 1 2 2"}],["path",{"d":"M21 19a2 2 0 0 1-2 2"}],["path",{"d":"M5 21a2 2 0 0 1-2-2"}],["path",{"d":"M9 3h1"}],["path",{"d":"M9 21h1"}],["path",{"d":"M14 3h1"}],["path",{"d":"M14 21h1"}],["path",{"d":"M3 9v1"}],["path",{"d":"M21 9v1"}],["path",{"d":"M3 14v1"}],["path",{"d":"M21 14v1"}],["path",{"d":"M8 12h8"}],["path",{"d":"M12 8v8"}]],"square-dashed-text":[["path",{"d":"M14 21h1"}],["path",{"d":"M14 3h1"}],["path",{"d":"M19 3a2 2 0 0 1 2 2"}],["path",{"d":"M21 14v1"}],["path",{"d":"M21 19a2 2 0 0 1-2 2"}],["path",{"d":"M21 9v1"}],["path",{"d":"M3 14v1"}],["path",{"d":"M3 9v1"}],["path",{"d":"M5 21a2 2 0 0 1-2-2"}],["path",{"d":"M5 3a2 2 0 0 0-2 2"}],["path",{"d":"M7 12h10"}],["path",{"d":"M7 16h6"}],["path",{"d":"M7 8h8"}],["path",{"d":"M9 21h1"}],["path",{"d":"M9 3h1"}]],"square-dashed-top-solid":[["path",{"d":"M14 21h1"}],["path",{"d":"M21 14v1"}],["path",{"d":"M21 19a2 2 0 0 1-2 2"}],["path",{"d":"M21 9v1"}],["path",{"d":"M3 14v1"}],["path",{"d":"M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2"}],["path",{"d":"M3 9v1"}],["path",{"d":"M5 21a2 2 0 0 1-2-2"}],["path",{"d":"M9 21h1"}]],"square-dashed-x-corner":[["path",{"d":"M14 3h1"}],["path",{"d":"m16 16 5 5"}],["path",{"d":"M19 3a2 2 0 012 2"}],["path",{"d":"m21 16-5 5"}],["path",{"d":"M21 9v1"}],["path",{"d":"M3 14v1"}],["path",{"d":"M3 9v1"}],["path",{"d":"M5 21a2 2 0 01-2-2"}],["path",{"d":"M5 3a2 2 0 00-2 2"}],["path",{"d":"M9 21h1"}],["path",{"d":"M9 3h1"}]],"square-dashed-x":[["path",{"d":"M14 21h1"}],["path",{"d":"M14 3h1"}],["path",{"d":"M19 3a2 2 0 012 2"}],["path",{"d":"M21 14v1"}],["path",{"d":"M21 19a2 2 0 01-2 2"}],["path",{"d":"M21 9v1"}],["path",{"d":"M3 14v1"}],["path",{"d":"M3 9v1"}],["path",{"d":"M5 21a2 2 0 01-2-2"}],["path",{"d":"M5 3a2 2 0 00-2 2"}],["path",{"d":"m9 15 6-6"}],["path",{"d":"M9 21h1"}],["path",{"d":"M9 3h1"}],["path",{"d":"m9 9 6 6"}]],"square-dashed":[["path",{"d":"M5 3a2 2 0 0 0-2 2"}],["path",{"d":"M19 3a2 2 0 0 1 2 2"}],["path",{"d":"M21 19a2 2 0 0 1-2 2"}],["path",{"d":"M5 21a2 2 0 0 1-2-2"}],["path",{"d":"M9 3h1"}],["path",{"d":"M9 21h1"}],["path",{"d":"M14 3h1"}],["path",{"d":"M14 21h1"}],["path",{"d":"M3 9v1"}],["path",{"d":"M21 9v1"}],["path",{"d":"M3 14v1"}],["path",{"d":"M21 14v1"}]],"square-dimensions":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M12 7H7v5"}],["path",{"d":"M12 17h5v-5"}]],"square-divide":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2","ry":"2"}],["line",{"x1":"8","x2":"16","y1":"12","y2":"12"}],["line",{"x1":"12","x2":"12","y1":"16","y2":"16"}],["line",{"x1":"12","x2":"12","y1":"8","y2":"8"}]],"square-dot":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["circle",{"cx":"12","cy":"12","r":"1"}]],"square-equal":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M7 10h10"}],["path",{"d":"M7 14h10"}]],"square-exclamation-point":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["line",{"x1":"12","x2":"12","y1":"8","y2":"12"}],["line",{"x1":"12","x2":"12.01","y1":"16","y2":"16"}]],"square-function":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2","ry":"2"}],["path",{"d":"M9 17c2 0 2.8-1 2.8-2.8V10c0-2 1-3.3 3.2-3"}],["path",{"d":"M9 11.2h5.7"}]],"square-kanban":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M8 7v7"}],["path",{"d":"M12 7v4"}],["path",{"d":"M16 7v9"}]],"square-library":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M7 7v10"}],["path",{"d":"M11 7v10"}],["path",{"d":"m15 7 2 10"}]],"square-m":[["path",{"d":"M8 16V8.5a.5.5 0 0 1 .9-.3l2.7 3.599a.5.5 0 0 0 .8 0l2.7-3.6a.5.5 0 0 1 .9.3V16"}],["rect",{"x":"3","y":"3","width":"18","height":"18","rx":"2"}]],"square-menu":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M7 8h10"}],["path",{"d":"M7 12h10"}],["path",{"d":"M7 16h10"}]],"square-minus":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M8 12h8"}]],"square-mouse-pointer":[["path",{"d":"M12.034 12.681a.498.498 0 0 1 .647-.647l9 3.5a.5.5 0 0 1-.033.943l-3.444 1.068a1 1 0 0 0-.66.66l-1.067 3.443a.5.5 0 0 1-.943.033z"}],["path",{"d":"M21 11V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h6"}]],"square-off":[["path",{"d":"M20.4 20.4a2 2 0 01-1.4.6H5a2 2 0 01-2-2V5a2 2 0 01.59-1.41"}],["path",{"d":"M21 15.3V5a2 2 0 00-2-2H8.7"}],["path",{"d":"M22 22 2 2"}]],"square-parking-off":[["path",{"d":"M3.6 3.6A2 2 0 0 1 5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-.59 1.41"}],["path",{"d":"M3 8.7V19a2 2 0 0 0 2 2h10.3"}],["path",{"d":"m2 2 20 20"}],["path",{"d":"M13 13a3 3 0 1 0 0-6H9v2"}],["path",{"d":"M9 17v-2.3"}]],"square-parking":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M9 17V7h4a3 3 0 0 1 0 6H9"}]],"square-pause":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["line",{"x1":"10","x2":"10","y1":"15","y2":"9"}],["line",{"x1":"14","x2":"14","y1":"15","y2":"9"}]],"square-pen":[["path",{"d":"M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"}],["path",{"d":"M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"}]],"square-percent":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"m15 9-6 6"}],["path",{"d":"M9 9h.01"}],["path",{"d":"M15 15h.01"}]],"square-pi":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M7 7h10"}],["path",{"d":"M10 7v10"}],["path",{"d":"M16 17a2 2 0 0 1-2-2V7"}]],"square-pilcrow":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M12 12H9.5a2.5 2.5 0 0 1 0-5H17"}],["path",{"d":"M12 7v10"}],["path",{"d":"M16 7v10"}]],"square-play":[["rect",{"x":"3","y":"3","width":"18","height":"18","rx":"2"}],["path",{"d":"M9 9.003a1 1 0 0 1 1.517-.859l4.997 2.997a1 1 0 0 1 0 1.718l-4.997 2.997A1 1 0 0 1 9 14.996z"}]],"square-plus":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M8 12h8"}],["path",{"d":"M12 8v8"}]],"square-power":[["path",{"d":"M12 7v4"}],["path",{"d":"M7.998 9.003a5 5 0 1 0 8-.005"}],["rect",{"x":"3","y":"3","width":"18","height":"18","rx":"2"}]],"square-radical":[["path",{"d":"M7 12h2l2 5 2-10h4"}],["rect",{"x":"3","y":"3","width":"18","height":"18","rx":"2"}]],"square-round-corner":[["path",{"d":"M21 11a8 8 0 0 0-8-8"}],["path",{"d":"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"}]],"square-scissors":[["path",{"d":"m17 17-2.18-2.18"}],["path",{"d":"M9.56 14.44 17 7"}],["path",{"d":"M9.56 9.56 12 12"}],["circle",{"cx":"8.5","cy":"15.5","r":"1.5"}],["circle",{"cx":"8.5","cy":"8.5","r":"1.5"}],["rect",{"x":"3","y":"3","width":"18","height":"18","rx":"2"}]],"square-sigma":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M16 8.9V7H8l4 5-4 5h8v-1.9"}]],"square-slash":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["line",{"x1":"9","x2":"15","y1":"15","y2":"9"}]],"square-sparkles":[["path",{"d":"M11 15H7"}],["path",{"d":"M15.41 2.49a.6.6 0 011.18 0l.63 3.334a1.2 1.2 0 00.956.955l3.334.631a.6.6 0 010 1.18l-3.334.63a1.2 1.2 0 00-.955.956l-.631 3.334a.6.6 0 01-1.18 0l-.63-3.334a1.2 1.2 0 00-.956-.955L10.49 8.59a.6.6 0 010-1.18l3.334-.63a1.2 1.2 0 00.955-.956z"}],["path",{"d":"M21 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h6"}],["path",{"d":"M9 13v4"}]],"square-split-horizontal":[["path",{"d":"M12 2v20"}],["path",{"d":"M16 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3"}],["path",{"d":"M8 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3"}]],"square-split-vertical":[["path",{"d":"M2 12h20"}],["path",{"d":"M21 16v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3"}],["path",{"d":"M3 8V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3"}]],"square-square":[["rect",{"x":"3","y":"3","width":"18","height":"18","rx":"2"}],["rect",{"x":"8","y":"8","width":"8","height":"8","rx":"1"}]],"square-stack":[["path",{"d":"M4 10c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h4c1.1 0 2 .9 2 2"}],["path",{"d":"M10 16c-1.1 0-2-.9-2-2v-4c0-1.1.9-2 2-2h4c1.1 0 2 .9 2 2"}],["rect",{"width":"8","height":"8","x":"14","y":"14","rx":"2"}]],"square-star":[["path",{"d":"M11.035 7.69a1 1 0 0 1 1.909.024l.737 1.452a1 1 0 0 0 .737.535l1.634.256a1 1 0 0 1 .588 1.806l-1.172 1.168a1 1 0 0 0-.282.866l.259 1.613a1 1 0 0 1-1.541 1.134l-1.465-.75a1 1 0 0 0-.912 0l-1.465.75a1 1 0 0 1-1.539-1.133l.258-1.613a1 1 0 0 0-.282-.866l-1.156-1.153a1 1 0 0 1 .572-1.822l1.633-.256a1 1 0 0 0 .737-.535z"}],["rect",{"x":"3","y":"3","width":"18","height":"18","rx":"2"}]],"square-stop":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["rect",{"x":"9","y":"9","width":"6","height":"6","rx":"1"}]],"square-terminal":[["path",{"d":"m7 11 2-2-2-2"}],["path",{"d":"M11 13h4"}],["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2","ry":"2"}]],"square-text":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M7 8h8"}],["path",{"d":"M7 12h10"}],["path",{"d":"M7 16h6"}]],"square-user-round":[["path",{"d":"M18 21a6 6 0 0 0-12 0"}],["circle",{"cx":"12","cy":"11","r":"4"}],["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}]],"square-user":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["circle",{"cx":"12","cy":"10","r":"3"}],["path",{"d":"M7 21v-2a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v2"}]],"square-x":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2","ry":"2"}],["path",{"d":"m15 9-6 6"}],["path",{"d":"m9 9 6 6"}]],"square":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}]],"squares-exclude":[["path",{"d":"M16 12v2a2 2 0 0 1-2 2H9a1 1 0 0 0-1 1v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2h0"}],["path",{"d":"M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v3a1 1 0 0 1-1 1h-5a2 2 0 0 0-2 2v2"}]],"squares-intersect":[["path",{"d":"M10 22a2 2 0 0 1-2-2"}],["path",{"d":"M14 2a2 2 0 0 1 2 2"}],["path",{"d":"M16 22h-2"}],["path",{"d":"M2 10V8"}],["path",{"d":"M2 4a2 2 0 0 1 2-2"}],["path",{"d":"M20 8a2 2 0 0 1 2 2"}],["path",{"d":"M22 14v2"}],["path",{"d":"M22 20a2 2 0 0 1-2 2"}],["path",{"d":"M4 16a2 2 0 0 1-2-2"}],["path",{"d":"M8 10a2 2 0 0 1 2-2h5a1 1 0 0 1 1 1v5a2 2 0 0 1-2 2H9a1 1 0 0 1-1-1z"}],["path",{"d":"M8 2h2"}]],"squares-subtract":[["path",{"d":"M10 22a2 2 0 0 1-2-2"}],["path",{"d":"M16 22h-2"}],["path",{"d":"M16 4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3a1 1 0 0 0 1-1v-5a2 2 0 0 1 2-2h5a1 1 0 0 0 1-1z"}],["path",{"d":"M20 8a2 2 0 0 1 2 2"}],["path",{"d":"M22 14v2"}],["path",{"d":"M22 20a2 2 0 0 1-2 2"}]],"squares-unite":[["path",{"d":"M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v3a1 1 0 0 0 1 1h3a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2v-3a1 1 0 0 0-1-1z"}]],"squircle-dashed":[["path",{"d":"M13.77 3.043a34 34 0 0 0-3.54 0"}],["path",{"d":"M13.771 20.956a33 33 0 0 1-3.541.001"}],["path",{"d":"M20.18 17.74c-.51 1.15-1.29 1.93-2.439 2.44"}],["path",{"d":"M20.18 6.259c-.51-1.148-1.291-1.929-2.44-2.438"}],["path",{"d":"M20.957 10.23a33 33 0 0 1 0 3.54"}],["path",{"d":"M3.043 10.23a34 34 0 0 0 .001 3.541"}],["path",{"d":"M6.26 20.179c-1.15-.508-1.93-1.29-2.44-2.438"}],["path",{"d":"M6.26 3.82c-1.149.51-1.93 1.291-2.44 2.44"}]],"squircle":[["path",{"d":"M12 3c7.2 0 9 1.8 9 9s-1.8 9-9 9-9-1.8-9-9 1.8-9 9-9"}]],"squirrel":[["path",{"d":"M15.236 22a3 3 0 0 0-2.2-5"}],["path",{"d":"M16 20a3 3 0 0 1 3-3h1a2 2 0 0 0 2-2v-2a4 4 0 0 0-4-4V4"}],["path",{"d":"M18 13h.01"}],["path",{"d":"M18 6a4 4 0 0 0-4 4 7 7 0 0 0-7 7c0-5 4-5 4-10.5a4.5 4.5 0 1 0-9 0 2.5 2.5 0 0 0 5 0C7 10 3 11 3 17c0 2.8 2.2 5 5 5h10"}]],"stamp":[["path",{"d":"M14 13V8.5C14 7 15 7 15 5a3 3 0 0 0-6 0c0 2 1 2 1 3.5V13"}],["path",{"d":"M20 15.5a2.5 2.5 0 0 0-2.5-2.5h-11A2.5 2.5 0 0 0 4 15.5V17a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1z"}],["path",{"d":"M5 22h14"}]],"star-check":[["path",{"d":"m19.06 12.501 2.78-2.707a.53.53 0 0 0-.294-.905l-5.166-.755a2.1 2.1 0 0 1-1.595-1.16l-2.31-4.68a.53.53 0 0 0-.95.001L9.216 6.974a2.1 2.1 0 0 1-1.597 1.16l-5.165.755a.53.53 0 0 0-.294.906l3.736 3.637a2.1 2.1 0 0 1 .611 1.879l-.88 5.139a.53.53 0 0 0 .769.56l4.617-2.428.027-.014"}],["path",{"d":"m15 18 2 2 4-4"}]],"star-half":[["path",{"d":"M12 18.338a2.1 2.1 0 0 0-.987.244L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.12 2.12 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.12 2.12 0 0 0 1.597-1.16l2.309-4.679A.53.53 0 0 1 12 2"}]],"star-minus":[["path",{"d":"M15 18h6"}],["path",{"d":"M17.688 14a2.1 2.1 0 0 1 .416-.568l3.736-3.638a.53.53 0 0 0-.294-.905l-5.166-.755a2.1 2.1 0 0 1-1.595-1.16l-2.31-4.68a.53.53 0 0 0-.95.001L9.216 6.974a2.1 2.1 0 0 1-1.597 1.16l-5.165.755a.53.53 0 0 0-.294.906l3.736 3.637a2.1 2.1 0 0 1 .611 1.879l-.88 5.139a.53.53 0 0 0 .769.56l4.617-2.428.027-.014"}]],"star-off":[["path",{"d":"m10.344 4.688 1.181-2.393a.53.53 0 0 1 .95 0l2.31 4.679a2.12 2.12 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.237 3.152"}],["path",{"d":"m17.945 17.945.43 2.505a.53.53 0 0 1-.771.56l-4.618-2.428a2.12 2.12 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.12 2.12 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a8 8 0 0 0 .4-.099"}],["path",{"d":"m2 2 20 20"}]],"star-plus":[["path",{"d":"M11.013 18.582 6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.12 2.12 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.12 2.12 0 0 0 1.597-1.16l2.309-4.679a.53.53 0 0 1 .95 0l2.31 4.679a2.12 2.12 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904L20 11.5"}],["path",{"d":"M15 18h6"}],["path",{"d":"M18 15v6"}]],"star-x":[["path",{"d":"m15.5 15.5 5 5"}],["path",{"d":"m20.063 11.525 1.777-1.731a.53.53 0 0 0-.294-.905l-5.166-.755a2.1 2.1 0 0 1-1.595-1.16l-2.31-4.68a.53.53 0 0 0-.95.001L9.216 6.974a2.1 2.1 0 0 1-1.597 1.16l-5.165.755a.53.53 0 0 0-.294.906l3.736 3.637a2.1 2.1 0 0 1 .611 1.879l-.88 5.139a.53.53 0 0 0 .769.56l4.617-2.428a2.1 2.1 0 0 1 .987-.243 2 2 0 0 1 .132.004"}],["path",{"d":"m20.5 15.5-5 5"}]],"star":[["path",{"d":"M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"}]],"step-back":[["path",{"d":"M13.971 4.285A2 2 0 0 1 17 6v12a2 2 0 0 1-3.029 1.715l-9.997-5.998a2 2 0 0 1-.003-3.432z"}],["path",{"d":"M21 20V4"}]],"step-forward":[["path",{"d":"M10.029 4.285A2 2 0 0 0 7 6v12a2 2 0 0 0 3.029 1.715l9.997-5.998a2 2 0 0 0 .003-3.432z"}],["path",{"d":"M3 4v16"}]],"stethoscope":[["path",{"d":"M11 2v2"}],["path",{"d":"M5 2v2"}],["path",{"d":"M5 3H4a2 2 0 0 0-2 2v4a6 6 0 0 0 12 0V5a2 2 0 0 0-2-2h-1"}],["path",{"d":"M8 15a6 6 0 0 0 12 0v-3"}],["circle",{"cx":"20","cy":"10","r":"2"}]],"sticker":[["path",{"d":"M21 9a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 15 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2z"}],["path",{"d":"M15 3v5a1 1 0 0 0 1 1h5"}],["path",{"d":"M8 13h.01"}],["path",{"d":"M16 13h.01"}],["path",{"d":"M10 16s.8 1 2 1c1.3 0 2-1 2-1"}]],"sticky-note-check":[["path",{"d":"m15 19 2 2 4-4"}],["path",{"d":"M15 3v5a1 1 0 0 0 1 1h5"}],["path",{"d":"M21 13V9a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 15 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h6.5"}]],"sticky-note-minus":[["path",{"d":"M15 3v5a1 1 0 0 0 1 1h5"}],["path",{"d":"M21 14V9a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 15 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h7.35"}],["path",{"d":"M21 18h-6"}]],"sticky-note-off":[["path",{"d":"M15 3v5a1 1 0 0 0 1 1h5"}],["path",{"d":"m2 2 20 20"}],["path",{"d":"M3.586 3.586A2 2 0 0 0 3 5v14a2 2 0 0 0 2 2h14a2 2 0 0 0 1.414-.586"}],["path",{"d":"M8.656 3H15a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 21 9v6.344"}]],"sticky-note-plus":[["path",{"d":"M15 3v5a1 1 0 0 0 1 1h5"}],["path",{"d":"M18 15v6"}],["path",{"d":"M21 12.356V9a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 15 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h7.355"}],["path",{"d":"M21 18h-6"}]],"sticky-note-x":[["path",{"d":"M15 3v5a1 1 0 0 0 1 1h5"}],["path",{"d":"m16 16 5 5"}],["path",{"d":"M21 12V9a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 15 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h7"}],["path",{"d":"m21 16-5 5"}]],"sticky-note":[["path",{"d":"M21 9a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 15 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2z"}],["path",{"d":"M15 3v5a1 1 0 0 0 1 1h5"}]],"sticky-notes":[["path",{"d":"M10 8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 16 14v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z"}],["path",{"d":"M10 8v5a1 1 0 0 0 1 1h5"}],["path",{"d":"M8 4a2 2 0 0 1 2-2h6a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 22 8v6a2 2 0 0 1-2 2"}],["path",{"d":"M16 2v5a1 1 0 0 0 1 1h5"}]],"stone":[["path",{"d":"M11.264 2.205A4 4 0 0 0 6.42 4.211l-4 8a4 4 0 0 0 1.359 5.117l6 4a4 4 0 0 0 4.438 0l6-4a4 4 0 0 0 1.576-4.592l-2-6a4 4 0 0 0-2.53-2.53z"}],["path",{"d":"M11.99 22 14 12l7.822 3.184"}],["path",{"d":"M14 12 8.47 2.302"}]],"store":[["path",{"d":"M15 21v-5a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v5"}],["path",{"d":"M17.774 10.31a1.12 1.12 0 0 0-1.549 0 2.5 2.5 0 0 1-3.451 0 1.12 1.12 0 0 0-1.548 0 2.5 2.5 0 0 1-3.452 0 1.12 1.12 0 0 0-1.549 0 2.5 2.5 0 0 1-3.77-3.248l2.889-4.184A2 2 0 0 1 7 2h10a2 2 0 0 1 1.653.873l2.895 4.192a2.5 2.5 0 0 1-3.774 3.244"}],["path",{"d":"M4 10.95V19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8.05"}]],"stretch-horizontal":[["rect",{"width":"20","height":"6","x":"2","y":"4","rx":"2"}],["rect",{"width":"20","height":"6","x":"2","y":"14","rx":"2"}]],"stretch-vertical":[["rect",{"width":"6","height":"20","x":"4","y":"2","rx":"2"}],["rect",{"width":"6","height":"20","x":"14","y":"2","rx":"2"}]],"strikethrough":[["path",{"d":"M16 4H9a3 3 0 0 0-2.83 4"}],["path",{"d":"M14 12a4 4 0 0 1 0 8H6"}],["line",{"x1":"4","x2":"20","y1":"12","y2":"12"}]],"subscript":[["path",{"d":"m4 5 8 8"}],["path",{"d":"m12 5-8 8"}],["path",{"d":"M20 19h-4c0-1.5.44-2 1.5-2.5S20 15.33 20 14c0-.47-.17-.93-.48-1.29a2.11 2.11 0 0 0-2.62-.44c-.42.24-.74.62-.9 1.07"}]],"summary":[["path",{"d":"M15 4H7"}],["path",{"d":"m18 16 3 3-3 3"}],["path",{"d":"M3 4v13a2 2 0 0 0 2 2h16"}],["path",{"d":"M7 14h7"}],["path",{"d":"M7 9h12"}]],"sun-dim":[["circle",{"cx":"12","cy":"12","r":"4"}],["path",{"d":"M12 4h.01"}],["path",{"d":"M20 12h.01"}],["path",{"d":"M12 20h.01"}],["path",{"d":"M4 12h.01"}],["path",{"d":"M17.657 6.343h.01"}],["path",{"d":"M17.657 17.657h.01"}],["path",{"d":"M6.343 17.657h.01"}],["path",{"d":"M6.343 6.343h.01"}]],"sun-medium":[["circle",{"cx":"12","cy":"12","r":"4"}],["path",{"d":"M12 3v1"}],["path",{"d":"M12 20v1"}],["path",{"d":"M3 12h1"}],["path",{"d":"M20 12h1"}],["path",{"d":"m18.364 5.636-.707.707"}],["path",{"d":"m6.343 17.657-.707.707"}],["path",{"d":"m5.636 5.636.707.707"}],["path",{"d":"m17.657 17.657.707.707"}]],"sun-moon":[["path",{"d":"M12 2v2"}],["path",{"d":"M14.837 16.385a6 6 0 1 1-7.223-7.222c.624-.147.97.66.715 1.248a4 4 0 0 0 5.26 5.259c.589-.255 1.396.09 1.248.715"}],["path",{"d":"M16 12a4 4 0 0 0-4-4"}],["path",{"d":"m19 5-1.256 1.256"}],["path",{"d":"M20 12h2"}]],"sun-snow":[["path",{"d":"M10 21v-1"}],["path",{"d":"M10 4V3"}],["path",{"d":"M10 9a3 3 0 0 0 0 6"}],["path",{"d":"m14 20 1.25-2.5L18 18"}],["path",{"d":"m14 4 1.25 2.5L18 6"}],["path",{"d":"m17 21-3-6 1.5-3H22"}],["path",{"d":"m17 3-3 6 1.5 3"}],["path",{"d":"M2 12h1"}],["path",{"d":"m20 10-1.5 2 1.5 2"}],["path",{"d":"m3.64 18.36.7-.7"}],["path",{"d":"m4.34 6.34-.7-.7"}]],"sun":[["circle",{"cx":"12","cy":"12","r":"4"}],["path",{"d":"M12 2v2"}],["path",{"d":"M12 20v2"}],["path",{"d":"m4.93 4.93 1.41 1.41"}],["path",{"d":"m17.66 17.66 1.41 1.41"}],["path",{"d":"M2 12h2"}],["path",{"d":"M20 12h2"}],["path",{"d":"m6.34 17.66-1.41 1.41"}],["path",{"d":"m19.07 4.93-1.41 1.41"}]],"sunrise":[["path",{"d":"M12 2v8"}],["path",{"d":"m4.93 10.93 1.41 1.41"}],["path",{"d":"M2 18h2"}],["path",{"d":"M20 18h2"}],["path",{"d":"m19.07 10.93-1.41 1.41"}],["path",{"d":"M22 22H2"}],["path",{"d":"m8 6 4-4 4 4"}],["path",{"d":"M16 18a4 4 0 0 0-8 0"}]],"sunset":[["path",{"d":"M12 10V2"}],["path",{"d":"m4.93 10.93 1.41 1.41"}],["path",{"d":"M2 18h2"}],["path",{"d":"M20 18h2"}],["path",{"d":"m19.07 10.93-1.41 1.41"}],["path",{"d":"M22 22H2"}],["path",{"d":"m16 6-4 4-4-4"}],["path",{"d":"M16 18a4 4 0 0 0-8 0"}]],"superscript":[["path",{"d":"m4 19 8-8"}],["path",{"d":"m12 19-8-8"}],["path",{"d":"M20 12h-4c0-1.5.442-2 1.5-2.5S20 8.334 20 7.002c0-.472-.17-.93-.484-1.29a2.105 2.105 0 0 0-2.617-.436c-.42.239-.738.614-.899 1.06"}]],"swatch-book":[["path",{"d":"M11 17a4 4 0 0 1-8 0V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2Z"}],["path",{"d":"M16.7 13H19a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H7"}],["path",{"d":"M 7 17h.01"}],["path",{"d":"m11 8 2.3-2.3a2.4 2.4 0 0 1 3.404.004L18.6 7.6a2.4 2.4 0 0 1 .026 3.434L9.9 19.8"}]],"swiss-franc":[["path",{"d":"M10 21V3h8"}],["path",{"d":"M6 16h9"}],["path",{"d":"M10 9.5h7"}]],"switch-camera":[["path",{"d":"M11 19H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5"}],["path",{"d":"M13 5h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-5"}],["circle",{"cx":"12","cy":"12","r":"3"}],["path",{"d":"m18 22-3-3 3-3"}],["path",{"d":"m6 2 3 3-3 3"}]],"sword":[["path",{"d":"m11 19-6-6"}],["path",{"d":"m5 21-2-2"}],["path",{"d":"m8 16-4 4"}],["path",{"d":"M9.5 17.5 20.414 6.586A2 2 0 0021 5.172V3h-2.172a2 2 0 00-1.414.586L6.5 14.5"}]],"swords":[["path",{"d":"m13 19 6-6"}],["path",{"d":"M14.5 17.5 3.586 6.586A2 2 0 013 5.172V3h2.172a2 2 0 011.414.586L17.5 14.5"}],["path",{"d":"m14.828 6.172 2.586-2.586A2 2 0 0118.828 3H21v2.172a2 2 0 01-.586 1.414l-2.586 2.586"}],["path",{"d":"m16 16 4 4"}],["path",{"d":"m19 21 2-2"}],["path",{"d":"m5 14 4 4"}],["path",{"d":"m5 21-2-2"}],["path",{"d":"M7.5 16.5 4 20"}]],"syringe":[["path",{"d":"m18 2 4 4"}],["path",{"d":"m17 7 3-3"}],["path",{"d":"M19 9 8.7 19.3c-1 1-2.5 1-3.4 0l-.6-.6c-1-1-1-2.5 0-3.4L15 5"}],["path",{"d":"m9 11 4 4"}],["path",{"d":"m5 19-3 3"}],["path",{"d":"m14 4 6 6"}]],"table-2":[["path",{"d":"M3 9h18"}],["path",{"d":"M9 3v18"}],["rect",{"x":"3","y":"3","width":"18","height":"18","rx":"2"}]],"table-cells-merge":[["path",{"d":"M12 21v-6"}],["path",{"d":"M12 9V3"}],["path",{"d":"M3 15h18"}],["path",{"d":"M3 9h18"}],["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}]],"table-cells-split":[["path",{"d":"M12 15V9"}],["path",{"d":"M3 15h18"}],["path",{"d":"M3 9h18"}],["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}]],"table-columns-split":[["path",{"d":"M14 14v2"}],["path",{"d":"M14 20v2"}],["path",{"d":"M14 2v2"}],["path",{"d":"M14 8v2"}],["path",{"d":"M2 15h8"}],["path",{"d":"M2 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H2"}],["path",{"d":"M2 9h8"}],["path",{"d":"M22 15h-4"}],["path",{"d":"M22 3h-2a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h2"}],["path",{"d":"M22 9h-4"}],["path",{"d":"M5 3v18"}]],"table-of-contents":[["path",{"d":"M16 5H3"}],["path",{"d":"M16 12H3"}],["path",{"d":"M16 19H3"}],["path",{"d":"M21 5h.01"}],["path",{"d":"M21 12h.01"}],["path",{"d":"M21 19h.01"}]],"table-properties":[["path",{"d":"M15 3v18"}],["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M21 9H3"}],["path",{"d":"M21 15H3"}]],"table-rows-split":[["path",{"d":"M14 10h2"}],["path",{"d":"M15 22v-8"}],["path",{"d":"M15 2v4"}],["path",{"d":"M2 10h2"}],["path",{"d":"M20 10h2"}],["path",{"d":"M3 19h18"}],["path",{"d":"M3 22v-6a2 2 135 0 1 2-2h14a2 2 45 0 1 2 2v6"}],["path",{"d":"M3 2v2a2 2 45 0 0 2 2h14a2 2 135 0 0 2-2V2"}],["path",{"d":"M8 10h2"}],["path",{"d":"M9 22v-8"}],["path",{"d":"M9 2v4"}]],"table":[["path",{"d":"M12 3v18"}],["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M3 9h18"}],["path",{"d":"M3 15h18"}]],"tablet-smartphone":[["rect",{"width":"10","height":"14","x":"3","y":"8","rx":"2"}],["path",{"d":"M5 4a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2h-2.4"}],["path",{"d":"M8 18h.01"}]],"tablet":[["rect",{"width":"16","height":"20","x":"4","y":"2","rx":"2","ry":"2"}],["line",{"x1":"12","x2":"12.01","y1":"18","y2":"18"}]],"tablets":[["circle",{"cx":"7","cy":"7","r":"5"}],["circle",{"cx":"17","cy":"17","r":"5"}],["path",{"d":"M12 17h10"}],["path",{"d":"m3.46 10.54 7.08-7.08"}]],"tag-plus":[["path",{"d":"M16 13h6"}],["path",{"d":"m16.5 6.5-3.914-3.914A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l1.79-1.79"}],["path",{"d":"M19 10v6"}],["circle",{"cx":"7.5","cy":"7.5","r":".5","fill":"currentColor"}]],"tag-x":[["path",{"d":"m16.5 6.5-3.914-3.914A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.43 2.43 0 0 0 3.42 0l1.79-1.79"}],["path",{"d":"m16.5 10.5 5 5"}],["path",{"d":"m21.5 10.5-5 5"}],["circle",{"cx":"7.5","cy":"7.5","r":".5","fill":"currentColor"}]],"tag":[["path",{"d":"M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"}],["circle",{"cx":"7.5","cy":"7.5","r":".5","fill":"currentColor"}]],"tags":[["path",{"d":"M13.172 2a2 2 0 0 1 1.414.586l6.71 6.71a2.4 2.4 0 0 1 0 3.408l-4.592 4.592a2.4 2.4 0 0 1-3.408 0l-6.71-6.71A2 2 0 0 1 6 9.172V3a1 1 0 0 1 1-1z"}],["path",{"d":"M2 7v6.172a2 2 0 0 0 .586 1.414l6.71 6.71a2.4 2.4 0 0 0 3.191.193"}],["circle",{"cx":"10.5","cy":"6.5","r":".5","fill":"currentColor"}]],"tally-1":[["path",{"d":"M4 4v16"}]],"tally-2":[["path",{"d":"M4 4v16"}],["path",{"d":"M9 4v16"}]],"tally-3":[["path",{"d":"M4 4v16"}],["path",{"d":"M9 4v16"}],["path",{"d":"M14 4v16"}]],"tally-4":[["path",{"d":"M4 4v16"}],["path",{"d":"M9 4v16"}],["path",{"d":"M14 4v16"}],["path",{"d":"M19 4v16"}]],"tally-5":[["path",{"d":"M4 4v16"}],["path",{"d":"M9 4v16"}],["path",{"d":"M14 4v16"}],["path",{"d":"M19 4v16"}],["path",{"d":"M22 6 2 18"}]],"tangent":[["circle",{"cx":"17","cy":"4","r":"2"}],["path",{"d":"M15.59 5.41 5.41 15.59"}],["circle",{"cx":"4","cy":"17","r":"2"}],["path",{"d":"M12 22s-4-9-1.5-11.5S22 12 22 12"}]],"target":[["circle",{"cx":"12","cy":"12","r":"10"}],["circle",{"cx":"12","cy":"12","r":"6"}],["circle",{"cx":"12","cy":"12","r":"2"}]],"telescope":[["path",{"d":"m10.065 12.493-6.18 1.318a.934.934 0 0 1-1.108-.702l-.537-2.15a1.07 1.07 0 0 1 .691-1.265l13.504-4.44"}],["path",{"d":"m13.56 11.747 4.332-.924"}],["path",{"d":"m16 21-3.105-6.21"}],["path",{"d":"M16.485 5.94a2 2 0 0 1 1.455-2.425l1.09-.272a1 1 0 0 1 1.212.727l1.515 6.06a1 1 0 0 1-.727 1.213l-1.09.272a2 2 0 0 1-2.425-1.455z"}],["path",{"d":"m6.158 8.633 1.114 4.456"}],["path",{"d":"m8 21 3.105-6.21"}],["circle",{"cx":"12","cy":"13","r":"2"}]],"tent-tree":[["circle",{"cx":"4","cy":"4","r":"2"}],["path",{"d":"m14 5 3-3 3 3"}],["path",{"d":"m14 10 3-3 3 3"}],["path",{"d":"M17 14V2"}],["path",{"d":"M17 14H7l-5 8h20Z"}],["path",{"d":"M8 14v8"}],["path",{"d":"m9 14 5 8"}]],"tent":[["path",{"d":"M3.5 21 14 3"}],["path",{"d":"M20.5 21 10 3"}],["path",{"d":"M15.5 21 12 15l-3.5 6"}],["path",{"d":"M2 21h20"}]],"terminal":[["path",{"d":"M12 19h8"}],["path",{"d":"m4 17 6-6-6-6"}]],"test-tube-diagonal":[["path",{"d":"M21 7 6.82 21.18a2.83 2.83 0 0 1-3.99-.01a2.83 2.83 0 0 1 0-4L17 3"}],["path",{"d":"m16 2 6 6"}],["path",{"d":"M12 16H4"}]],"test-tube":[["path",{"d":"M14.5 2v17.5c0 1.4-1.1 2.5-2.5 2.5c-1.4 0-2.5-1.1-2.5-2.5V2"}],["path",{"d":"M8.5 2h7"}],["path",{"d":"M14.5 16h-5"}]],"test-tubes":[["path",{"d":"M9 2v17.5A2.5 2.5 0 0 1 6.5 22A2.5 2.5 0 0 1 4 19.5V2"}],["path",{"d":"M20 2v17.5a2.5 2.5 0 0 1-2.5 2.5a2.5 2.5 0 0 1-2.5-2.5V2"}],["path",{"d":"M3 2h7"}],["path",{"d":"M14 2h7"}],["path",{"d":"M9 16H4"}],["path",{"d":"M20 16h-5"}]],"text-align-center":[["path",{"d":"M21 5H3"}],["path",{"d":"M17 12H7"}],["path",{"d":"M19 19H5"}]],"text-align-end":[["path",{"d":"M21 5H3"}],["path",{"d":"M21 12H9"}],["path",{"d":"M21 19H7"}]],"text-align-justify":[["path",{"d":"M3 5h18"}],["path",{"d":"M3 12h18"}],["path",{"d":"M3 19h18"}]],"text-align-start":[["path",{"d":"M21 5H3"}],["path",{"d":"M15 12H3"}],["path",{"d":"M17 19H3"}]],"text-cursor-input":[["path",{"d":"M12 20h-1a2 2 0 0 1-2-2 2 2 0 0 1-2 2H6"}],["path",{"d":"M13 8h7a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-7"}],["path",{"d":"M5 16H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h1"}],["path",{"d":"M6 4h1a2 2 0 0 1 2 2 2 2 0 0 1 2-2h1"}],["path",{"d":"M9 6v12"}]],"text-cursor":[["path",{"d":"M17 22h-1a4 4 0 0 1-4-4V6a4 4 0 0 1 4-4h1"}],["path",{"d":"M7 22h1a4 4 0 0 0 4-4"}],["path",{"d":"M7 2h1a4 4 0 0 1 4 4"}]],"text-initial":[["path",{"d":"M15 5h6"}],["path",{"d":"M15 12h6"}],["path",{"d":"M3 19h18"}],["path",{"d":"m3 12 3.553-7.724a.5.5 0 0 1 .894 0L11 12"}],["path",{"d":"M3.92 10h6.16"}]],"text-quote":[["path",{"d":"M17 5H3"}],["path",{"d":"M21 12H8"}],["path",{"d":"M21 19H8"}],["path",{"d":"M3 12v7"}]],"text-search":[["path",{"d":"M21 5H3"}],["path",{"d":"M10 12H3"}],["path",{"d":"M10 19H3"}],["circle",{"cx":"17","cy":"15","r":"3"}],["path",{"d":"m21 19-1.9-1.9"}]],"text-wrap":[["path",{"d":"m16 16-3 3 3 3"}],["path",{"d":"M3 12h14.5a1 1 0 0 1 0 7H13"}],["path",{"d":"M3 19h6"}],["path",{"d":"M3 5h18"}]],"theater":[["path",{"d":"M2 10s3-3 3-8"}],["path",{"d":"M22 10s-3-3-3-8"}],["path",{"d":"M10 2c0 4.4-3.6 8-8 8"}],["path",{"d":"M14 2c0 4.4 3.6 8 8 8"}],["path",{"d":"M2 10s2 2 2 5"}],["path",{"d":"M22 10s-2 2-2 5"}],["path",{"d":"M8 15h8"}],["path",{"d":"M2 22v-1a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v1"}],["path",{"d":"M14 22v-1a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v1"}]],"thermometer-snowflake":[["path",{"d":"m10 20-1.25-2.5L6 18"}],["path",{"d":"M10 4 8.75 6.5 6 6"}],["path",{"d":"M10.585 15H10"}],["path",{"d":"M2 12h6.5L10 9"}],["path",{"d":"M20 14.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0z"}],["path",{"d":"m4 10 1.5 2L4 14"}],["path",{"d":"m7 21 3-6-1.5-3"}],["path",{"d":"m7 3 3 6h2"}]],"thermometer-sun":[["path",{"d":"M12 2v2"}],["path",{"d":"M12 8a4 4 0 0 0-1.645 7.647"}],["path",{"d":"M2 12h2"}],["path",{"d":"M20 14.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0z"}],["path",{"d":"m4.93 4.93 1.41 1.41"}],["path",{"d":"m6.34 17.66-1.41 1.41"}]],"thermometer":[["path",{"d":"M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z"}]],"thumbs-down":[["path",{"d":"M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"}],["path",{"d":"M17 14V2"}]],"thumbs-up":[["path",{"d":"M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"}],["path",{"d":"M7 10v12"}]],"tic-tac-toe":[["path",{"d":"M12 2v20"}],["path",{"d":"m21 16-5 5"}],["path",{"d":"m21 21-5-5"}],["path",{"d":"M22 12H2"}],["path",{"d":"M8 3 3 8"}],["path",{"d":"M8 8 3 3"}],["circle",{"cx":"18.5","cy":"5.5","r":"2.5"}],["circle",{"cx":"5.5","cy":"18.5","r":"2.5"}]],"ticket-check":[["path",{"d":"M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"}],["path",{"d":"m9 12 2 2 4-4"}]],"ticket-minus":[["path",{"d":"M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"}],["path",{"d":"M9 12h6"}]],"ticket-percent":[["path",{"d":"M2 9a3 3 0 1 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 1 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"}],["path",{"d":"M9 9h.01"}],["path",{"d":"m15 9-6 6"}],["path",{"d":"M15 15h.01"}]],"ticket-plus":[["path",{"d":"M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"}],["path",{"d":"M9 12h6"}],["path",{"d":"M12 9v6"}]],"ticket-slash":[["path",{"d":"M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"}],["path",{"d":"m9.5 14.5 5-5"}]],"ticket-x":[["path",{"d":"M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"}],["path",{"d":"m9.5 14.5 5-5"}],["path",{"d":"m9.5 9.5 5 5"}]],"ticket":[["path",{"d":"M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"}],["path",{"d":"M13 5v2"}],["path",{"d":"M13 17v2"}],["path",{"d":"M13 11v2"}]],"tickets-plane":[["path",{"d":"M10.5 17h1.227a2 2 0 0 0 1.345-.52L18 12"}],["path",{"d":"m12 13.5 3.794.506"}],["path",{"d":"m3.173 8.18 11-5a2 2 0 0 1 2.647.993L18.56 8"}],["path",{"d":"M6 10V8"}],["path",{"d":"M6 14v1"}],["path",{"d":"M6 19v2"}],["rect",{"x":"2","y":"8","width":"20","height":"13","rx":"2"}]],"tickets":[["path",{"d":"m3.173 8.18 11-5a2 2 0 0 1 2.647.993L18.56 8"}],["path",{"d":"M6 10V8"}],["path",{"d":"M6 14v1"}],["path",{"d":"M6 19v2"}],["rect",{"x":"2","y":"8","width":"20","height":"13","rx":"2"}]],"timeline":[["path",{"d":"M4 12h.01"}],["path",{"d":"M4 16h.01"}],["path",{"d":"M4 20h.01"}],["path",{"d":"M4 4h.01"}],["path",{"d":"M4 8h.01"}],["path",{"d":"M9.414 13.414a2 2 0 0 0 1.414.586H19a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1h-8.172a2 2 0 0 0-1.414.586L8 12z"}],["path",{"d":"M9.414 21.414a2 2 0 0 0 1.414.586H19a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1h-8.172a2 2 0 0 0-1.414.586L8 20z"}],["path",{"d":"M9.414 5.414A2 2 0 0 0 10.828 6H19a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1h-8.172a2 2 0 0 0-1.414.586L8 4z"}]],"timer-off":[["path",{"d":"M10 2h4"}],["path",{"d":"M4.6 11a8 8 0 0 0 1.7 8.7 8 8 0 0 0 8.7 1.7"}],["path",{"d":"M7.4 7.4a8 8 0 0 1 10.3 1 8 8 0 0 1 .9 10.2"}],["path",{"d":"m2 2 20 20"}],["path",{"d":"M12 12v-2"}]],"timer-reset":[["path",{"d":"M10 2h4"}],["path",{"d":"M12 14v-4"}],["path",{"d":"M4 13a8 8 0 0 1 8-7 8 8 0 1 1-5.3 14L4 17.6"}],["path",{"d":"M9 17H4v5"}]],"timer":[["line",{"x1":"10","x2":"14","y1":"2","y2":"2"}],["line",{"x1":"12","x2":"15","y1":"14","y2":"11"}],["circle",{"cx":"12","cy":"14","r":"8"}]],"toggle-left":[["circle",{"cx":"9","cy":"12","r":"3"}],["rect",{"width":"20","height":"14","x":"2","y":"5","rx":"7"}]],"toggle-right":[["circle",{"cx":"15","cy":"12","r":"3"}],["rect",{"width":"20","height":"14","x":"2","y":"5","rx":"7"}]],"toilet":[["path",{"d":"M7 12h13a1 1 0 0 1 1 1 5 5 0 0 1-5 5h-.598a.5.5 0 0 0-.424.765l1.544 2.47a.5.5 0 0 1-.424.765H5.402a.5.5 0 0 1-.424-.765L7 18"}],["path",{"d":"M8 18a5 5 0 0 1-5-5V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8"}]],"tool-case":[["path",{"d":"M10 15h4"}],["path",{"d":"m14.817 10.995-.971-1.45 1.034-1.232a2 2 0 0 0-2.025-3.238l-1.82.364L9.91 3.885a2 2 0 0 0-3.625.748L6.141 6.55l-1.725.426a2 2 0 0 0-.19 3.756l.657.27"}],["path",{"d":"m18.822 10.995 2.26-5.38a1 1 0 0 0-.557-1.318L16.954 2.9a1 1 0 0 0-1.281.533l-.924 2.122"}],["path",{"d":"M4 12.006A1 1 0 0 1 4.994 11H19a1 1 0 0 1 1 1v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"}]],"toolbox":[["path",{"d":"M16 12v4"}],["path",{"d":"M16 6V4a2 2 0 00-2-2h-4a2 2 0 00-2 2v2"}],["path",{"d":"M17 6a2 2 0 011.414.586l3 3A2 2 0 0122 11v8a2 2 0 01-2 2H4a2 2 0 01-2-2v-8a2 2 0 01.586-1.414l3-3A2 2 0 017 6z"}],["path",{"d":"M2 14h20"}],["path",{"d":"M8 12v4"}]],"toothbrush-sparkles":[["path",{"d":"M10 3H8"}],["path",{"d":"M14.586 11.414 22 4"}],["path",{"d":"M15 11a8 8 0 01-.429.4"}],["path",{"d":"m2 22 7-7c1.857-1.857 3.714-1.99 5.571-3.6l-1.985-1.986A2 2 0 0114 6a2 2 0 012-2 2 2 0 013.262-1.552l2.152 2.138"}],["path",{"d":"M20 15v4"}],["path",{"d":"M22 17h-4"}],["path",{"d":"M4 5v4"}],["path",{"d":"M6 7H2"}],["path",{"d":"M9 2v2"}]],"toothbrush":[["path",{"d":"M15 11c-2 2-4 2-6 4l-7 7"}],["path",{"d":"m22 4-7.414 7.414-2-2A2 2 0 0114 6c0-.512.196-1.024.586-1.414A2 2 0 0116 4a2 2 0 013.262-1.552l2.152 2.138"}]],"tornado":[["path",{"d":"M21 4H3"}],["path",{"d":"M18 8H6"}],["path",{"d":"M19 12H9"}],["path",{"d":"M16 16h-6"}],["path",{"d":"M11 20H9"}]],"torus":[["ellipse",{"cx":"12","cy":"11","rx":"3","ry":"2"}],["ellipse",{"cx":"12","cy":"12.5","rx":"10","ry":"8.5"}]],"touchpad-off":[["path",{"d":"M12 20v-6"}],["path",{"d":"M19.656 14H22"}],["path",{"d":"M2 14h12"}],["path",{"d":"m2 2 20 20"}],["path",{"d":"M20 20H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2"}],["path",{"d":"M9.656 4H20a2 2 0 0 1 2 2v10.344"}]],"touchpad":[["rect",{"width":"20","height":"16","x":"2","y":"4","rx":"2"}],["path",{"d":"M2 14h20"}],["path",{"d":"M12 20v-6"}]],"towel-rack":[["path",{"d":"M22 7h-2"}],["path",{"d":"M6.5 3h11A2.5 2.5 0 0 1 20 5.5V20a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V5.5a1 1 0 0 0-5 0V17a1 1 0 0 0 1 1h4"}],["path",{"d":"M9 7H2"}]],"tower-control":[["path",{"d":"M18.2 12.27 20 6H4l1.8 6.27a1 1 0 0 0 .95.73h10.5a1 1 0 0 0 .96-.73Z"}],["path",{"d":"M8 13v9"}],["path",{"d":"M16 22v-9"}],["path",{"d":"m9 6 1 7"}],["path",{"d":"m15 6-1 7"}],["path",{"d":"M12 6V2"}],["path",{"d":"M13 2h-2"}]],"toy-brick":[["rect",{"width":"18","height":"12","x":"3","y":"8","rx":"1"}],["path",{"d":"M10 8V5c0-.6-.4-1-1-1H6a1 1 0 0 0-1 1v3"}],["path",{"d":"M19 8V5c0-.6-.4-1-1-1h-3a1 1 0 0 0-1 1v3"}]],"tractor":[["path",{"d":"m10 11 11 .9a1 1 0 0 1 .8 1.1l-.665 4.158a1 1 0 0 1-.988.842H20"}],["path",{"d":"M16 18h-5"}],["path",{"d":"M18 5a1 1 0 0 0-1 1v5.573"}],["path",{"d":"M3 4h8.129a1 1 0 0 1 .99.863L13 11.246"}],["path",{"d":"M4 11V4"}],["path",{"d":"M7 15h.01"}],["path",{"d":"M8 10.1V4"}],["circle",{"cx":"18","cy":"18","r":"2"}],["circle",{"cx":"7","cy":"15","r":"5"}]],"traffic-cone":[["path",{"d":"M16.05 10.966a5 2.5 0 0 1-8.1 0"}],["path",{"d":"m16.923 14.049 4.48 2.04a1 1 0 0 1 .001 1.831l-8.574 3.9a2 2 0 0 1-1.66 0l-8.574-3.91a1 1 0 0 1 0-1.83l4.484-2.04"}],["path",{"d":"M16.949 14.14a5 2.5 0 1 1-9.9 0L10.063 3.5a2 2 0 0 1 3.874 0z"}],["path",{"d":"M9.194 6.57a5 2.5 0 0 0 5.61 0"}]],"trailer":[["path",{"d":"M10 11.341V10"}],["path",{"d":"M14 13v-3"}],["path",{"d":"M18 17V8a2 2 0 00-2-2H4a2 2 0 00-2 2v7a2 2 0 002 2h2"}],["path",{"d":"M22 15v1a1 1 0 01-1 1H10"}],["path",{"d":"M6 11.341V10"}],["circle",{"cx":"8","cy":"17","r":"2"}]],"train-front-tunnel":[["path",{"d":"M2 22V12a10 10 0 1 1 20 0v10"}],["path",{"d":"M15 6.8v1.4a3 2.8 0 1 1-6 0V6.8"}],["path",{"d":"M10 15h.01"}],["path",{"d":"M14 15h.01"}],["path",{"d":"M10 19a4 4 0 0 1-4-4v-3a6 6 0 1 1 12 0v3a4 4 0 0 1-4 4Z"}],["path",{"d":"m9 19-2 3"}],["path",{"d":"m15 19 2 3"}]],"train-front":[["path",{"d":"M8 3.1V7a4 4 0 0 0 8 0V3.1"}],["path",{"d":"m9 15-1-1"}],["path",{"d":"m15 15 1-1"}],["path",{"d":"M9 19c-2.8 0-5-2.2-5-5v-4a8 8 0 0 1 16 0v4c0 2.8-2.2 5-5 5Z"}],["path",{"d":"m8 19-2 3"}],["path",{"d":"m16 19 2 3"}]],"train-track":[["path",{"d":"M2 17 17 2"}],["path",{"d":"m2 14 8 8"}],["path",{"d":"m5 11 8 8"}],["path",{"d":"m8 8 8 8"}],["path",{"d":"m11 5 8 8"}],["path",{"d":"m14 2 8 8"}],["path",{"d":"M7 22 22 7"}]],"tram-front":[["rect",{"width":"16","height":"16","x":"4","y":"3","rx":"2"}],["path",{"d":"M4 11h16"}],["path",{"d":"M12 3v8"}],["path",{"d":"m8 19-2 3"}],["path",{"d":"m18 22-2-3"}],["path",{"d":"M8 15h.01"}],["path",{"d":"M16 15h.01"}]],"transgender":[["path",{"d":"M12 16v6"}],["path",{"d":"M14 20h-4"}],["path",{"d":"M18 2h4v4"}],["path",{"d":"m2 2 7.17 7.17"}],["path",{"d":"M2 5.355V2h3.357"}],["path",{"d":"m22 2-7.17 7.17"}],["path",{"d":"M8 5 5 8"}],["circle",{"cx":"12","cy":"12","r":"4"}]],"trash-off":[["path",{"d":"M10 11v6"}],["path",{"d":"M14 17v-3"}],["path",{"d":"M16 6V4a2 2 0 00-2-2h-4a2 2 0 00-1.576.768"}],["path",{"d":"M19 6v7.344"}],["path",{"d":"m2 2 20 20"}],["path",{"d":"M21 6h-9.344"}],["path",{"d":"M3 6h3"}],["path",{"d":"M5 6v14a2 2 0 002 2h10a2 2 0 002-2v-1"}]],"trash":[["path",{"d":"M10 11v6"}],["path",{"d":"M14 11v6"}],["path",{"d":"M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"}],["path",{"d":"M3 6h18"}],["path",{"d":"M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"}]],"tree-deciduous":[["path",{"d":"M8 19a4 4 0 0 1-2.24-7.32A3.5 3.5 0 0 1 9 6.03V6a3 3 0 1 1 6 0v.04a3.5 3.5 0 0 1 3.24 5.65A4 4 0 0 1 16 19Z"}],["path",{"d":"M12 19v3"}]],"tree-palm":[["path",{"d":"M13 8c0-2.76-2.46-5-5.5-5S2 5.24 2 8h2l1-1 1 1h4"}],["path",{"d":"M13 7.14A5.82 5.82 0 0 1 16.5 6c3.04 0 5.5 2.24 5.5 5h-3l-1-1-1 1h-3"}],["path",{"d":"M5.89 9.71c-2.15 2.15-2.3 5.47-.35 7.43l4.24-4.25.7-.7.71-.71 2.12-2.12c-1.95-1.96-5.27-1.8-7.42.35"}],["path",{"d":"M11 15.5c.5 2.5-.17 4.5-1 6.5h4c2-5.5-.5-12-1-14"}]],"tree-pine":[["path",{"d":"m17 14 3 3.3a1 1 0 0 1-.7 1.7H4.7a1 1 0 0 1-.7-1.7L7 14h-.3a1 1 0 0 1-.7-1.7L9 9h-.2A1 1 0 0 1 8 7.3L12 3l4 4.3a1 1 0 0 1-.8 1.7H15l3 3.3a1 1 0 0 1-.7 1.7H17Z"}],["path",{"d":"M12 22v-3"}]],"trees":[["path",{"d":"M10 10v.2A3 3 0 0 1 8.9 16H5a3 3 0 0 1-1-5.8V10a3 3 0 0 1 6 0Z"}],["path",{"d":"M7 16v6"}],["path",{"d":"M13 19v3"}],["path",{"d":"M12 19h8.3a1 1 0 0 0 .7-1.7L18 14h.3a1 1 0 0 0 .7-1.7L16 9h.2a1 1 0 0 0 .8-1.7L13 3l-1.4 1.5"}]],"trending-down":[["path",{"d":"M16 17h6v-6"}],["path",{"d":"m22 17-8.5-8.5-5 5L2 7"}]],"trending-up-down":[["path",{"d":"M14.828 14.828 21 21"}],["path",{"d":"M21 16v5h-5"}],["path",{"d":"m21 3-9 9-4-4-6 6"}],["path",{"d":"M21 8V3h-5"}]],"trending-up":[["path",{"d":"M16 7h6v6"}],["path",{"d":"m22 7-8.5 8.5-5-5L2 17"}]],"triangle-alert":[["path",{"d":"m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"}],["path",{"d":"M12 9v4"}],["path",{"d":"M12 17h.01"}]],"triangle-dashed":[["path",{"d":"M10.17 4.193a2 2 0 0 1 3.666.013"}],["path",{"d":"M14 21h2"}],["path",{"d":"m15.874 7.743 1 1.732"}],["path",{"d":"m18.849 12.952 1 1.732"}],["path",{"d":"M21.824 18.18a2 2 0 0 1-1.835 2.824"}],["path",{"d":"M4.024 21a2 2 0 0 1-1.839-2.839"}],["path",{"d":"m5.136 12.952-1 1.732"}],["path",{"d":"M8 21h2"}],["path",{"d":"m8.102 7.743-1 1.732"}]],"triangle-right":[["path",{"d":"M22 18a2 2 0 0 1-2 2H3c-1.1 0-1.3-.6-.4-1.3L20.4 4.3c.9-.7 1.6-.4 1.6.7Z"}]],"triangle":[["path",{"d":"M13.73 4a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"}]],"triangles-centerline-dashed-horizontal":[["path",{"d":"M10 12H8"}],["path",{"d":"M16 12h-2"}],["path",{"d":"M22 12h-2"}],["path",{"d":"M4 12H2"}],["path",{"d":"M7.298 20.288A1 1 0 008 22h8a1 1 0 00.703-1.712l-3.991-3.99a1 1 0 00-1.424-.001z"}],["path",{"d":"M7.298 3.712A1 1 0 018 2h8a1 1 0 01.703 1.712l-3.991 3.99a1 1 0 01-1.424.001z"}]],"triangles-centerline-dashed-vertical":[["path",{"d":"M12 14v2"}],["path",{"d":"M12 20v2"}],["path",{"d":"M12 2v2"}],["path",{"d":"M12 8v2"}],["path",{"d":"M20.288 16.703A1 1 0 0022 16V8a1 1 0 00-1.712-.703l-3.99 3.991a1 1 0 00-.001 1.424z"}],["path",{"d":"M3.712 16.703A1 1 0 012 16V8a1 1 0 011.712-.703l3.99 3.991a1 1 0 01.001 1.424z"}]],"trophy":[["path",{"d":"M10 14.66V17a1 1 0 0 1-1 1 2 2 0 0 0-2 2v2"}],["path",{"d":"M14 14.66V17a1 1 0 0 0 1 1 2 2 0 0 1 2 2v2"}],["path",{"d":"M17.916 10H19.5A2.5 2.5 0 0 0 22 7.5V5a1 1 0 0 0-1-1h-3"}],["path",{"d":"M4 22h16"}],["path",{"d":"M6 9a6 6 0 0 0 12 0V3a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1z"}],["path",{"d":"M6.084 10H4.5A2.5 2.5 0 0 1 2 7.5V5a1 1 0 0 1 1-1h3"}]],"truck-electric":[["path",{"d":"M14 19V7a2 2 0 0 0-2-2H9"}],["path",{"d":"M15 19H9"}],["path",{"d":"M19 19h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.62L18.3 9.38a1 1 0 0 0-.78-.38H14"}],["path",{"d":"M2 13v5a1 1 0 0 0 1 1h2"}],["path",{"d":"M4 3 2.15 5.15a.495.495 0 0 0 .35.86h2.15a.47.47 0 0 1 .35.86L3 9.02"}],["circle",{"cx":"17","cy":"19","r":"2"}],["circle",{"cx":"7","cy":"19","r":"2"}]],"truck":[["path",{"d":"M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"}],["path",{"d":"M15 18H9"}],["path",{"d":"M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14"}],["circle",{"cx":"17","cy":"18","r":"2"}],["circle",{"cx":"7","cy":"18","r":"2"}]],"tube-lotion":[["path",{"d":"M15 18v3a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1v-3"}],["path",{"d":"M17 2a2 2 0 0 1 1.6 3.2A8 8 0 0 0 17 10v6a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-6a8 8 0 0 0-1.6-4.8A2 2 0 0 1 7 2z"}],["path",{"d":"M7 10a6.47 6.47 0 0 1 5 0 6.47 6.47 0 0 0 5 0"}]],"turkish-lira":[["path",{"d":"M15 4 5 9"}],["path",{"d":"m15 8.5-10 5"}],["path",{"d":"M18 12a9 9 0 0 1-9 9V3"}]],"turntable":[["path",{"d":"M10 12.01h.01"}],["path",{"d":"M18 8v4a8 8 0 0 1-1.07 4"}],["circle",{"cx":"10","cy":"12","r":"4"}],["rect",{"x":"2","y":"4","width":"20","height":"16","rx":"2"}]],"turtle":[["path",{"d":"m12 10 2 4v3a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1v-3a8 8 0 1 0-16 0v3a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1v-3l2-4h4Z"}],["path",{"d":"M4.82 7.9 8 10"}],["path",{"d":"M15.18 7.9 12 10"}],["path",{"d":"M16.93 10H20a2 2 0 0 1 0 4H2"}]],"tv-minimal-play":[["path",{"d":"M15.033 9.44a.647.647 0 0 1 0 1.12l-4.065 2.352a.645.645 0 0 1-.968-.56V7.648a.645.645 0 0 1 .967-.56z"}],["path",{"d":"M7 21h10"}],["rect",{"width":"20","height":"14","x":"2","y":"3","rx":"2"}]],"tv-minimal":[["path",{"d":"M7 21h10"}],["rect",{"width":"20","height":"14","x":"2","y":"3","rx":"2"}]],"tv":[["path",{"d":"m17 2-5 5-5-5"}],["rect",{"width":"20","height":"15","x":"2","y":"7","rx":"2"}]],"type-outline":[["path",{"d":"M14 16.5a.5.5 0 0 0 .5.5h.5a2 2 0 0 1 0 4H9a2 2 0 0 1 0-4h.5a.5.5 0 0 0 .5-.5v-9a.5.5 0 0 0-.5-.5h-3a.5.5 0 0 0-.5.5V8a2 2 0 0 1-4 0V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v3a2 2 0 0 1-4 0v-.5a.5.5 0 0 0-.5-.5h-3a.5.5 0 0 0-.5.5Z"}]],"type":[["path",{"d":"M12 4v16"}],["path",{"d":"M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2"}],["path",{"d":"M9 20h6"}]],"umbrella-off":[["path",{"d":"M12 13v7a2 2 0 0 0 4 0"}],["path",{"d":"M12 2v2"}],["path",{"d":"M18.656 13h2.336a1 1 0 0 0 .97-1.274 10.284 10.284 0 0 0-12.07-7.51"}],["path",{"d":"m2 2 20 20"}],["path",{"d":"M5.961 5.957a10.28 10.28 0 0 0-3.922 5.769A1 1 0 0 0 3 13h10"}]],"umbrella":[["path",{"d":"M12 13v7a2 2 0 0 0 4 0"}],["path",{"d":"M12 2v2"}],["path",{"d":"M20.992 13a1 1 0 0 0 .97-1.274 10.284 10.284 0 0 0-19.923 0A1 1 0 0 0 3 13z"}]],"underline":[["path",{"d":"M6 4v6a6 6 0 0 0 12 0V4"}],["line",{"x1":"4","x2":"20","y1":"20","y2":"20"}]],"undo-2":[["path",{"d":"M9 14 4 9l5-5"}],["path",{"d":"M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"}]],"undo-dot":[["path",{"d":"M21 17a9 9 0 0 0-15-6.7L3 13"}],["path",{"d":"M3 7v6h6"}],["circle",{"cx":"12","cy":"17","r":"1"}]],"undo":[["path",{"d":"M3 7v6h6"}],["path",{"d":"M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"}]],"unfold-horizontal":[["path",{"d":"M16 12h6"}],["path",{"d":"M8 12H2"}],["path",{"d":"M12 2v2"}],["path",{"d":"M12 8v2"}],["path",{"d":"M12 14v2"}],["path",{"d":"M12 20v2"}],["path",{"d":"m19 15 3-3-3-3"}],["path",{"d":"m5 9-3 3 3 3"}]],"unfold-vertical":[["path",{"d":"M12 22v-6"}],["path",{"d":"M12 8V2"}],["path",{"d":"M4 12H2"}],["path",{"d":"M10 12H8"}],["path",{"d":"M16 12h-2"}],["path",{"d":"M22 12h-2"}],["path",{"d":"m15 19-3 3-3-3"}],["path",{"d":"m15 5-3-3-3 3"}]],"ungroup":[["rect",{"x":"11","y":"14","width":"10","height":"7","rx":"2"}],["rect",{"x":"3","y":"3","width":"10","height":"7","rx":"2"}]],"university":[["path",{"d":"M14 21v-3a2 2 0 0 0-4 0v3"}],["path",{"d":"M18 12h.01"}],["path",{"d":"M18 16h.01"}],["path",{"d":"M22 7a1 1 0 0 0-1-1h-2a2 2 0 0 1-1.143-.359L13.143 2.36a2 2 0 0 0-2.286-.001L6.143 5.64A2 2 0 0 1 5 6H3a1 1 0 0 0-1 1v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2z"}],["path",{"d":"M6 12h.01"}],["path",{"d":"M6 16h.01"}],["circle",{"cx":"12","cy":"10","r":"2"}]],"unlink-2":[["path",{"d":"M15 7h2a5 5 0 0 1 0 10h-2m-6 0H7A5 5 0 0 1 7 7h2"}]],"unlink":[["path",{"d":"m18.84 12.25 1.72-1.71h-.02a5.004 5.004 0 0 0-.12-7.07 5.006 5.006 0 0 0-6.95 0l-1.72 1.71"}],["path",{"d":"m5.17 11.75-1.71 1.71a5.004 5.004 0 0 0 .12 7.07 5.006 5.006 0 0 0 6.95 0l1.71-1.71"}],["line",{"x1":"8","x2":"8","y1":"2","y2":"5"}],["line",{"x1":"2","x2":"5","y1":"8","y2":"8"}],["line",{"x1":"16","x2":"16","y1":"19","y2":"22"}],["line",{"x1":"19","x2":"22","y1":"16","y2":"16"}]],"unplug":[["path",{"d":"m19 5 3-3"}],["path",{"d":"m2 22 3-3"}],["path",{"d":"M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z"}],["path",{"d":"M7.5 13.5 10 11"}],["path",{"d":"M10.5 16.5 13 14"}],["path",{"d":"m12 6 6 6 2.3-2.3a2.4 2.4 0 0 0 0-3.4l-2.6-2.6a2.4 2.4 0 0 0-3.4 0Z"}]],"upload":[["path",{"d":"M12 3v12"}],["path",{"d":"m17 8-5-5-5 5"}],["path",{"d":"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"}]],"usb-c-port":[["path",{"d":"M6 12h12"}],["rect",{"x":"2","y":"8","width":"20","height":"8","rx":"4"}]],"usb":[["circle",{"cx":"10","cy":"7","r":"1"}],["circle",{"cx":"4","cy":"20","r":"1"}],["path",{"d":"M4.7 19.3 19 5"}],["path",{"d":"m21 3-3 1 2 2Z"}],["path",{"d":"M9.26 7.68 5 12l2 5"}],["path",{"d":"m10 14 5 2 3.5-3.5"}],["path",{"d":"m18 12 1-1 1 1-1 1Z"}]],"user-check":[["path",{"d":"m16 11 2 2 4-4"}],["path",{"d":"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"}],["circle",{"cx":"9","cy":"7","r":"4"}]],"user-cog":[["path",{"d":"M10 15H6a4 4 0 0 0-4 4v2"}],["path",{"d":"m14.305 16.53.923-.382"}],["path",{"d":"m15.228 13.852-.923-.383"}],["path",{"d":"m16.852 12.228-.383-.923"}],["path",{"d":"m16.852 17.772-.383.924"}],["path",{"d":"m19.148 12.228.383-.923"}],["path",{"d":"m19.53 18.696-.382-.924"}],["path",{"d":"m20.772 13.852.924-.383"}],["path",{"d":"m20.772 16.148.924.383"}],["circle",{"cx":"18","cy":"15","r":"3"}],["circle",{"cx":"9","cy":"7","r":"4"}]],"user-group":[["path",{"d":"M17 21v-1a2 2 0 00-2-2H9a2 2 0 00-2 2v1"}],["path",{"d":"M19 10h1a2 2 0 012 2v1"}],["path",{"d":"M5 10H4a2 2 0 00-2 2v1"}],["circle",{"cx":"12","cy":"11","r":"3"}],["circle",{"cx":"18","cy":"4","r":"2"}],["circle",{"cx":"6","cy":"4","r":"2"}]],"user-key":[["path",{"d":"M20 11v6"}],["path",{"d":"M20 13h2"}],["path",{"d":"M3 21v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 2.072.578"}],["circle",{"cx":"10","cy":"7","r":"4"}],["circle",{"cx":"20","cy":"19","r":"2"}]],"user-lock":[["path",{"d":"M19 16v-2a2 2 0 0 0-4 0v2"}],["path",{"d":"M9.5 15H7a4 4 0 0 0-4 4v2"}],["circle",{"cx":"10","cy":"7","r":"4"}],["rect",{"x":"13","y":"16","width":"8","height":"5","rx":".899"}]],"user-minus":[["path",{"d":"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"}],["circle",{"cx":"9","cy":"7","r":"4"}],["line",{"x1":"22","x2":"16","y1":"11","y2":"11"}]],"user-pen":[["path",{"d":"M11.5 15H7a4 4 0 0 0-4 4v2"}],["path",{"d":"M21.378 16.626a1 1 0 0 0-3.004-3.004l-4.01 4.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z"}],["circle",{"cx":"10","cy":"7","r":"4"}]],"user-plus":[["path",{"d":"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"}],["circle",{"cx":"9","cy":"7","r":"4"}],["line",{"x1":"19","x2":"19","y1":"8","y2":"14"}],["line",{"x1":"22","x2":"16","y1":"11","y2":"11"}]],"user-round-arrow-left":[["path",{"d":"m19 16-3 3"}],["path",{"d":"M2 21a8 8 0 0 1 12.664-6.5"}],["path",{"d":"M22 19h-6l3 3"}],["circle",{"cx":"10","cy":"8","r":"5"}]],"user-round-check":[["path",{"d":"M2 21a8 8 0 0 1 13.292-6"}],["circle",{"cx":"10","cy":"8","r":"5"}],["path",{"d":"m16 19 2 2 4-4"}]],"user-round-cog":[["path",{"d":"m14.305 19.53.923-.382"}],["path",{"d":"m15.228 16.852-.923-.383"}],["path",{"d":"m16.852 15.228-.383-.923"}],["path",{"d":"m16.852 20.772-.383.924"}],["path",{"d":"m19.148 15.228.383-.923"}],["path",{"d":"m19.53 21.696-.382-.924"}],["path",{"d":"M2 21a8 8 0 0 1 10.434-7.62"}],["path",{"d":"m20.772 16.852.924-.383"}],["path",{"d":"m20.772 19.148.924.383"}],["circle",{"cx":"10","cy":"8","r":"5"}],["circle",{"cx":"18","cy":"18","r":"3"}]],"user-round-group":[["path",{"d":"M17 21a5 5 0 00-10 0"}],["path",{"d":"M22 10.5a3.5 3.5 0 00-5.507-2.868"}],["path",{"d":"M7.507 7.632A3.5 3.5 0 002 10.5"}],["circle",{"cx":"12","cy":"13","r":"3"}],["circle",{"cx":"18.5","cy":"4.5","r":"2.5"}],["circle",{"cx":"5.5","cy":"4.5","r":"2.5"}]],"user-round-key":[["path",{"d":"M19 11v6"}],["path",{"d":"M19 13h2"}],["path",{"d":"M2 21a8 8 0 0 1 12.868-6.349"}],["circle",{"cx":"10","cy":"8","r":"5"}],["circle",{"cx":"19","cy":"19","r":"2"}]],"user-round-minus":[["path",{"d":"M2 21a8 8 0 0 1 13.292-6"}],["circle",{"cx":"10","cy":"8","r":"5"}],["path",{"d":"M22 19h-6"}]],"user-round-pen":[["path",{"d":"M2 21a8 8 0 0 1 10.821-7.487"}],["path",{"d":"M21.378 16.626a1 1 0 0 0-3.004-3.004l-4.01 4.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z"}],["circle",{"cx":"10","cy":"8","r":"5"}]],"user-round-plus":[["path",{"d":"M2 21a8 8 0 0 1 13.292-6"}],["circle",{"cx":"10","cy":"8","r":"5"}],["path",{"d":"M19 16v6"}],["path",{"d":"M22 19h-6"}]],"user-round-search":[["circle",{"cx":"10","cy":"8","r":"5"}],["path",{"d":"M2 21a8 8 0 0 1 10.434-7.62"}],["circle",{"cx":"18","cy":"18","r":"3"}],["path",{"d":"m22 22-1.9-1.9"}]],"user-round-x":[["path",{"d":"m16.5 16.5 5 5"}],["path",{"d":"M2 21a8 8 0 0 1 11.531-7.18"}],["path",{"d":"m21.5 16.5-5 5"}],["circle",{"cx":"10","cy":"8","r":"5"}]],"user-round":[["circle",{"cx":"12","cy":"8","r":"5"}],["path",{"d":"M20 21a8 8 0 0 0-16 0"}]],"user-search":[["circle",{"cx":"10","cy":"7","r":"4"}],["path",{"d":"M10.3 15H7a4 4 0 0 0-4 4v2"}],["circle",{"cx":"17","cy":"17","r":"3"}],["path",{"d":"m21 21-1.9-1.9"}]],"user-shield":[["path",{"d":"M10 15H6a4 4 0 0 0-4 4v2"}],["path",{"d":"M22 17.5c0 2.499-1.75 3.749-3.83 4.474a.5.5 0 0 1-.335-.005c-2.085-.72-3.835-1.97-3.835-4.47V14a.5.5 0 0 1 .5-.499c1 0 2.25-.6 3.12-1.36a.6.6 0 0 1 .76-.001c.875.765 2.12 1.36 3.12 1.36a.5.5 0 0 1 .5.5z"}],["circle",{"cx":"9","cy":"7","r":"4"}]],"user-star":[["path",{"d":"M16.051 12.616a1 1 0 0 1 1.909.024l.737 1.452a1 1 0 0 0 .737.535l1.634.256a1 1 0 0 1 .588 1.806l-1.172 1.168a1 1 0 0 0-.282.866l.259 1.613a1 1 0 0 1-1.541 1.134l-1.465-.75a1 1 0 0 0-.912 0l-1.465.75a1 1 0 0 1-1.539-1.133l.258-1.613a1 1 0 0 0-.282-.866l-1.156-1.153a1 1 0 0 1 .572-1.822l1.633-.256a1 1 0 0 0 .737-.535z"}],["path",{"d":"M8 15H7a4 4 0 0 0-4 4v2"}],["circle",{"cx":"10","cy":"7","r":"4"}]],"user-x":[["path",{"d":"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"}],["circle",{"cx":"9","cy":"7","r":"4"}],["line",{"x1":"17","x2":"22","y1":"8","y2":"13"}],["line",{"x1":"22","x2":"17","y1":"8","y2":"13"}]],"user":[["path",{"d":"M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"}],["circle",{"cx":"12","cy":"7","r":"4"}]],"users-round":[["path",{"d":"M18 21a8 8 0 0 0-16 0"}],["circle",{"cx":"10","cy":"8","r":"5"}],["path",{"d":"M22 20c0-3.37-2-6.5-4-8a5 5 0 0 0-.45-8.3"}]],"users":[["path",{"d":"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"}],["path",{"d":"M16 3.128a4 4 0 0 1 0 7.744"}],["path",{"d":"M22 21v-2a4 4 0 0 0-3-3.87"}],["circle",{"cx":"9","cy":"7","r":"4"}]],"utensils-crossed":[["path",{"d":"m16 2-2.3 2.3a3 3 0 0 0 0 4.2l1.8 1.8a3 3 0 0 0 4.2 0L22 8"}],["path",{"d":"M15 15 3.3 3.3a4.2 4.2 0 0 0 0 6l7.3 7.3c.7.7 2 .7 2.8 0L15 15Zm0 0 7 7"}],["path",{"d":"m2.1 21.8 6.4-6.3"}],["path",{"d":"m19 5-7 7"}]],"utensils":[["path",{"d":"M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"}],["path",{"d":"M7 2v20"}],["path",{"d":"M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"}]],"utility-pole":[["path",{"d":"M12 2v20"}],["path",{"d":"M2 5h20"}],["path",{"d":"M3 3v2"}],["path",{"d":"M7 3v2"}],["path",{"d":"M17 3v2"}],["path",{"d":"M21 3v2"}],["path",{"d":"m19 5-7 7-7-7"}]],"van":[["path",{"d":"M13 6v5a1 1 0 0 0 1 1h6.102a1 1 0 0 1 .712.298l.898.91a1 1 0 0 1 .288.702V17a1 1 0 0 1-1 1h-3"}],["path",{"d":"M5 18H3a1 1 0 0 1-1-1V8a2 2 0 0 1 2-2h12c1.1 0 2.1.8 2.4 1.8l1.176 4.2"}],["path",{"d":"M9 18h5"}],["circle",{"cx":"16","cy":"18","r":"2"}],["circle",{"cx":"7","cy":"18","r":"2"}]],"variable":[["path",{"d":"M8 21s-4-3-4-9 4-9 4-9"}],["path",{"d":"M16 3s4 3 4 9-4 9-4 9"}],["line",{"x1":"15","x2":"9","y1":"9","y2":"15"}],["line",{"x1":"9","x2":"15","y1":"9","y2":"15"}]],"vault":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["circle",{"cx":"7.5","cy":"7.5","r":".5","fill":"currentColor"}],["path",{"d":"m7.9 7.9 2.7 2.7"}],["circle",{"cx":"16.5","cy":"7.5","r":".5","fill":"currentColor"}],["path",{"d":"m13.4 10.6 2.7-2.7"}],["circle",{"cx":"7.5","cy":"16.5","r":".5","fill":"currentColor"}],["path",{"d":"m7.9 16.1 2.7-2.7"}],["circle",{"cx":"16.5","cy":"16.5","r":".5","fill":"currentColor"}],["path",{"d":"m13.4 13.4 2.7 2.7"}],["circle",{"cx":"12","cy":"12","r":"2"}]],"vector-polygon":[["path",{"d":"m12.828 4.813 5.344 2.375"}],["path",{"d":"m15.769 18.153 3.461-8.306"}],["path",{"d":"m5.687 14.074 7.625 4.852"}],["path",{"d":"M9.772 5.579 5.228 11.42"}],["circle",{"cx":"11","cy":"4","r":"2"}],["circle",{"cx":"15","cy":"20","r":"2"}],["circle",{"cx":"20","cy":"8","r":"2"}],["circle",{"cx":"4","cy":"13","r":"2"}]],"vector-square":[["path",{"d":"M17.055 4.533a24 24 0 00-10.11 0"}],["path",{"d":"M19.467 17.055a24 24 0 000-10.11"}],["path",{"d":"M4.533 6.945a24 24 0 000 10.11"}],["path",{"d":"M6.945 19.467a24 24 0 0010.11 0"}],["circle",{"cx":"19","cy":"19","r":"2"}],["circle",{"cx":"19","cy":"5","r":"2"}],["circle",{"cx":"5","cy":"19","r":"2"}],["circle",{"cx":"5","cy":"5","r":"2"}]],"vegan":[["path",{"d":"M16 8q6 0 6-6-6 0-6 6"}],["path",{"d":"M17.41 3.59a10 10 0 1 0 3 3"}],["path",{"d":"M2 2a26.6 26.6 0 0 1 10 20c.9-6.82 1.5-9.5 4-14"}]],"venetian-mask":[["path",{"d":"M18 11c-1.5 0-2.5.5-3 2"}],["path",{"d":"M4 6a2 2 0 0 0-2 2v4a5 5 0 0 0 5 5 8 8 0 0 1 5 2 8 8 0 0 1 5-2 5 5 0 0 0 5-5V8a2 2 0 0 0-2-2h-3a8 8 0 0 0-5 2 8 8 0 0 0-5-2z"}],["path",{"d":"M6 11c1.5 0 2.5.5 3 2"}]],"venus-and-mars":[["path",{"d":"M10 20h4"}],["path",{"d":"M12 16v6"}],["path",{"d":"M17 2h4v4"}],["path",{"d":"m21 2-5.46 5.46"}],["circle",{"cx":"12","cy":"11","r":"5"}]],"venus":[["path",{"d":"M12 15v7"}],["path",{"d":"M9 19h6"}],["circle",{"cx":"12","cy":"9","r":"6"}]],"vibrate-off":[["path",{"d":"m2 8 2 2-2 2 2 2-2 2"}],["path",{"d":"m22 8-2 2 2 2-2 2 2 2"}],["path",{"d":"M8 8v10c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2"}],["path",{"d":"M16 10.34V6c0-.55-.45-1-1-1h-4.34"}],["line",{"x1":"2","x2":"22","y1":"2","y2":"22"}]],"vibrate":[["path",{"d":"m2 8 2 2-2 2 2 2-2 2"}],["path",{"d":"m22 8-2 2 2 2-2 2 2 2"}],["rect",{"width":"8","height":"14","x":"8","y":"5","rx":"1"}]],"video-off":[["path",{"d":"M10.66 6H14a2 2 0 0 1 2 2v2.5l5.248-3.062A.5.5 0 0 1 22 7.87v8.196"}],["path",{"d":"M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2"}],["path",{"d":"m2 2 20 20"}]],"video":[["path",{"d":"m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"}],["rect",{"x":"2","y":"6","width":"14","height":"12","rx":"2"}]],"videotape":[["rect",{"width":"20","height":"16","x":"2","y":"4","rx":"2"}],["path",{"d":"M2 8h20"}],["circle",{"cx":"8","cy":"14","r":"2"}],["path",{"d":"M8 12h8"}],["circle",{"cx":"16","cy":"14","r":"2"}]],"view":[["path",{"d":"M21 17v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2"}],["path",{"d":"M21 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v2"}],["circle",{"cx":"12","cy":"12","r":"1"}],["path",{"d":"M18.944 12.33a1 1 0 0 0 0-.66 7.5 7.5 0 0 0-13.888 0 1 1 0 0 0 0 .66 7.5 7.5 0 0 0 13.888 0"}]],"virus-off":[["path",{"d":"M10.01 10h.01"}],["path",{"d":"M12 14.991h.01"}],["path",{"d":"M12 22v-3"}],["path",{"d":"M12 2v3"}],["path",{"d":"M13 22h-2"}],["path",{"d":"M13 2h-2"}],["path",{"d":"m16.5 19.794-1-1.733"}],["path",{"d":"m16.5 4.205-1 1.732"}],["path",{"d":"M18.891 13.235a7 7 0 00-8.126-8.126"}],["path",{"d":"m19.794 7.5-1.732 1"}],["path",{"d":"M2 12h3"}],["path",{"d":"M2 13v-2"}],["path",{"d":"m2 2 20 20"}],["path",{"d":"M22 12h-3"}],["path",{"d":"M22 13v-2"}],["path",{"d":"m4.206 16.5 1.732-1"}],["path",{"d":"m4.206 7.5 1.732 1"}],["path",{"d":"M7.05 7.05a7 7 0 009.9 9.9"}],["path",{"d":"m7.5 19.794 1-1.733"}],["path",{"d":"M9 12h.01"}]],"virus":[["path",{"d":"M12 14.991h.01"}],["path",{"d":"M12 22v-3"}],["path",{"d":"M12 2v3"}],["path",{"d":"M13 22h-2"}],["path",{"d":"M13 2h-2"}],["path",{"d":"M13.99 10H14"}],["path",{"d":"m16.5 19.794-1-1.733"}],["path",{"d":"m16.5 4.205-1 1.732"}],["path",{"d":"m19.794 16.5-1.732-1"}],["path",{"d":"m19.794 7.5-1.732 1"}],["path",{"d":"M2 12h3"}],["path",{"d":"M2 13v-2"}],["path",{"d":"M22 12h-3"}],["path",{"d":"M22 13v-2"}],["path",{"d":"m4.206 16.5 1.732-1"}],["path",{"d":"m4.206 7.5 1.732 1"}],["path",{"d":"m7.5 19.794 1-1.733"}],["path",{"d":"m7.5 4.205 1 1.732"}],["path",{"d":"M9 12h.01"}],["circle",{"cx":"12","cy":"12","r":"7"}]],"voicemail":[["circle",{"cx":"6","cy":"12","r":"4"}],["circle",{"cx":"18","cy":"12","r":"4"}],["line",{"x1":"6","x2":"18","y1":"16","y2":"16"}]],"volleyball":[["path",{"d":"M11 7a16 16 20 0 1 10.98 4.362"}],["path",{"d":"M12 12a13 13 0 0 1-8.66 5"}],["path",{"d":"M16.83 13.634a16 16 0 0 1-9.267 7.328"}],["path",{"d":"M20.66 17A13 13 0 0 0 12 12a13 13 0 0 1 0-10"}],["path",{"d":"M8.17 15.366a16 16 0 0 1-1.713-11.69"}],["circle",{"cx":"12","cy":"12","r":"10"}]],"volume-1":[["path",{"d":"M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"}],["path",{"d":"M16 9a5 5 0 0 1 0 6"}]],"volume-2":[["path",{"d":"M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"}],["path",{"d":"M16 9a5 5 0 0 1 0 6"}],["path",{"d":"M19.364 18.364a9 9 0 0 0 0-12.728"}]],"volume-off":[["path",{"d":"M16 9a5 5 0 0 1 .95 2.293"}],["path",{"d":"M19.364 5.636a9 9 0 0 1 1.889 9.96"}],["path",{"d":"m2 2 20 20"}],["path",{"d":"m7 7-.587.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298V11"}],["path",{"d":"M9.828 4.172A.686.686 0 0 1 11 4.657v.686"}]],"volume-x":[["path",{"d":"M11 4.702a.7.7 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.7.7 0 0 0 11 19.298z"}],["path",{"d":"m16.5 14.5 5-5"}],["path",{"d":"m16.5 9.5 5 5"}]],"volume":[["path",{"d":"M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"}]],"vote":[["path",{"d":"m9 12 2 2 4-4"}],["path",{"d":"M5 7c0-1.1.9-2 2-2h10a2 2 0 0 1 2 2v12H5V7Z"}],["path",{"d":"M22 19H2"}]],"wallet-cards":[["path",{"d":"M3 11h3.75a2 2 0 0 1 1.6.8l.45.6a4 4 0 0 0 6.4 0l.45-.6a2 2 0 0 1 1.6-.8H21"}],["path",{"d":"M3 7h18"}],["rect",{"x":"3","y":"3","width":"18","height":"18","rx":"2"}]],"wallet-minimal":[["path",{"d":"M17 14h.01"}],["path",{"d":"M7 7h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14"}]],"wallet":[["path",{"d":"M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"}],["path",{"d":"M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"}]],"wallpaper":[["path",{"d":"M12 17v4"}],["path",{"d":"M8 21h8"}],["path",{"d":"m9 17 6.1-6.1a2 2 0 0 1 2.81.01L22 15"}],["circle",{"cx":"8","cy":"9","r":"2"}],["rect",{"x":"2","y":"3","width":"20","height":"14","rx":"2"}]],"wand-sparkles":[["path",{"d":"m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72"}],["path",{"d":"m14 7 3 3"}],["path",{"d":"M5 6v4"}],["path",{"d":"M19 14v4"}],["path",{"d":"M10 2v2"}],["path",{"d":"M7 8H3"}],["path",{"d":"M21 16h-4"}],["path",{"d":"M11 3H9"}]],"wand":[["path",{"d":"M15 4V2"}],["path",{"d":"M15 16v-2"}],["path",{"d":"M8 9h2"}],["path",{"d":"M20 9h2"}],["path",{"d":"M17.8 11.8 19 13"}],["path",{"d":"M15 9h.01"}],["path",{"d":"M17.8 6.2 19 5"}],["path",{"d":"m3 21 9-9"}],["path",{"d":"M12.2 6.2 11 5"}]],"warehouse":[["path",{"d":"M18 21V10a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1v11"}],["path",{"d":"M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 1.132-1.803l7.95-3.974a2 2 0 0 1 1.837 0l7.948 3.974A2 2 0 0 1 22 8z"}],["path",{"d":"M6 13h12"}],["path",{"d":"M6 17h12"}]],"washing-machine":[["path",{"d":"M3 6h3"}],["path",{"d":"M17 6h.01"}],["rect",{"width":"18","height":"20","x":"3","y":"2","rx":"2"}],["circle",{"cx":"12","cy":"13","r":"5"}],["path",{"d":"M12 18a2.5 2.5 0 0 0 0-5 2.5 2.5 0 0 1 0-5"}]],"watch":[["path",{"d":"M12 10v2.2l1.6 1"}],["path",{"d":"m16.13 7.66-.81-4.05a2 2 0 0 0-2-1.61h-2.68a2 2 0 0 0-2 1.61l-.78 4.05"}],["path",{"d":"m7.88 16.36.8 4a2 2 0 0 0 2 1.61h2.72a2 2 0 0 0 2-1.61l.81-4.05"}],["circle",{"cx":"12","cy":"12","r":"6"}]],"waves-arrow-down":[["path",{"d":"M12 10L12 2"}],["path",{"d":"M16 6L12 10L8 6"}],["path",{"d":"M2 15C2.6 15.5 3.2 16 4.5 16C7 16 7 14 9.5 14C12.1 14 11.9 16 14.5 16C17 16 17 14 19.5 14C20.8 14 21.4 14.5 22 15"}],["path",{"d":"M2 21C2.6 21.5 3.2 22 4.5 22C7 22 7 20 9.5 20C12.1 20 11.9 22 14.5 22C17 22 17 20 19.5 20C20.8 20 21.4 20.5 22 21"}]],"waves-arrow-up":[["path",{"d":"M12 2v8"}],["path",{"d":"M2 15c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"}],["path",{"d":"M2 21c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"}],["path",{"d":"m8 6 4-4 4 4"}]],"waves-horizontal":[["path",{"d":"M2 12q2.5 2 5 0t5 0 5 0 5 0"}],["path",{"d":"M2 19q2.5 2 5 0t5 0 5 0 5 0"}],["path",{"d":"M2 5q2.5 2 5 0t5 0 5 0 5 0"}]],"waves-ladder":[["path",{"d":"M19 5a2 2 0 0 0-2 2v11"}],["path",{"d":"M2 18c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"}],["path",{"d":"M7 13h10"}],["path",{"d":"M7 9h10"}],["path",{"d":"M9 5a2 2 0 0 0-2 2v11"}]],"waves-vertical":[["path",{"d":"M12 2q2 2.5 0 5t0 5 0 5 0 5"}],["path",{"d":"M19 2q2 2.5 0 5t0 5 0 5 0 5"}],["path",{"d":"M5 2q2 2.5 0 5t0 5 0 5 0 5"}]],"waypoints":[["path",{"d":"m10.586 5.414-5.172 5.172"}],["path",{"d":"m18.586 13.414-5.172 5.172"}],["path",{"d":"M6 12h12"}],["circle",{"cx":"12","cy":"20","r":"2"}],["circle",{"cx":"12","cy":"4","r":"2"}],["circle",{"cx":"20","cy":"12","r":"2"}],["circle",{"cx":"4","cy":"12","r":"2"}]],"webcam-off":[["path",{"d":"M12 22v-4"}],["path",{"d":"M12.754 7.096a3 3 0 0 1 2.15 2.15"}],["path",{"d":"M12.863 12.873a3 3 0 0 1-3.736-3.735"}],["path",{"d":"M16.566 16.57A8 8 0 0 1 5.43 5.433"}],["path",{"d":"m2 2 20 20"}],["path",{"d":"M7 22h10"}],["path",{"d":"M8.478 2.817a8 8 0 0 1 10.705 10.705"}]],"webcam":[["circle",{"cx":"12","cy":"10","r":"8"}],["circle",{"cx":"12","cy":"10","r":"3"}],["path",{"d":"M7 22h10"}],["path",{"d":"M12 22v-4"}]],"webhook-off":[["path",{"d":"M17 17h-5c-1.09-.02-1.94.92-2.5 1.9A3 3 0 1 1 2.57 15"}],["path",{"d":"M9 3.4a4 4 0 0 1 6.52.66"}],["path",{"d":"m6 17 3.1-5.8a2.5 2.5 0 0 0 .057-2.05"}],["path",{"d":"M20.3 20.3a4 4 0 0 1-2.3.7"}],["path",{"d":"M18.6 13a4 4 0 0 1 3.357 3.414"}],["path",{"d":"m12 6 .6 1"}],["path",{"d":"m2 2 20 20"}]],"webhook":[["path",{"d":"M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2"}],["path",{"d":"m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06"}],["path",{"d":"m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8"}]],"weight-tilde":[["path",{"d":"M6.5 8a2 2 0 0 0-1.906 1.46L2.1 18.5A2 2 0 0 0 4 21h16a2 2 0 0 0 1.925-2.54L19.4 9.5A2 2 0 0 0 17.48 8z"}],["path",{"d":"M7.999 15a2.5 2.5 0 0 1 4 0 2.5 2.5 0 0 0 4 0"}],["circle",{"cx":"12","cy":"5","r":"3"}]],"weight":[["circle",{"cx":"12","cy":"5","r":"3"}],["path",{"d":"M6.5 8a2 2 0 0 0-1.905 1.46L2.1 18.5A2 2 0 0 0 4 21h16a2 2 0 0 0 1.925-2.54L19.4 9.5A2 2 0 0 0 17.48 8Z"}]],"wheat-off":[["path",{"d":"m2 22 10-10"}],["path",{"d":"m16 8-1.17 1.17"}],["path",{"d":"M3.47 12.53 5 11l1.53 1.53a3.5 3.5 0 0 1 0 4.94L5 19l-1.53-1.53a3.5 3.5 0 0 1 0-4.94Z"}],["path",{"d":"m8 8-.53.53a3.5 3.5 0 0 0 0 4.94L9 15l1.53-1.53c.55-.55.88-1.25.98-1.97"}],["path",{"d":"M10.91 5.26c.15-.26.34-.51.56-.73L13 3l1.53 1.53a3.5 3.5 0 0 1 .28 4.62"}],["path",{"d":"M20 2h2v2a4 4 0 0 1-4 4h-2V6a4 4 0 0 1 4-4Z"}],["path",{"d":"M11.47 17.47 13 19l-1.53 1.53a3.5 3.5 0 0 1-4.94 0L5 19l1.53-1.53a3.5 3.5 0 0 1 4.94 0Z"}],["path",{"d":"m16 16-.53.53a3.5 3.5 0 0 1-4.94 0L9 15l1.53-1.53a3.49 3.49 0 0 1 1.97-.98"}],["path",{"d":"M18.74 13.09c.26-.15.51-.34.73-.56L21 11l-1.53-1.53a3.5 3.5 0 0 0-4.62-.28"}],["line",{"x1":"2","x2":"22","y1":"2","y2":"22"}]],"wheat":[["path",{"d":"M2 22 16 8"}],["path",{"d":"M3.47 12.53 5 11l1.53 1.53a3.5 3.5 0 0 1 0 4.94L5 19l-1.53-1.53a3.5 3.5 0 0 1 0-4.94Z"}],["path",{"d":"M7.47 8.53 9 7l1.53 1.53a3.5 3.5 0 0 1 0 4.94L9 15l-1.53-1.53a3.5 3.5 0 0 1 0-4.94Z"}],["path",{"d":"M11.47 4.53 13 3l1.53 1.53a3.5 3.5 0 0 1 0 4.94L13 11l-1.53-1.53a3.5 3.5 0 0 1 0-4.94Z"}],["path",{"d":"M20 2h2v2a4 4 0 0 1-4 4h-2V6a4 4 0 0 1 4-4Z"}],["path",{"d":"M11.47 17.47 13 19l-1.53 1.53a3.5 3.5 0 0 1-4.94 0L5 19l1.53-1.53a3.5 3.5 0 0 1 4.94 0Z"}],["path",{"d":"M15.47 13.47 17 15l-1.53 1.53a3.5 3.5 0 0 1-4.94 0L9 15l1.53-1.53a3.5 3.5 0 0 1 4.94 0Z"}],["path",{"d":"M19.47 9.47 21 11l-1.53 1.53a3.5 3.5 0 0 1-4.94 0L13 11l1.53-1.53a3.5 3.5 0 0 1 4.94 0Z"}]],"whistle":[["path",{"d":"M10 6v4"}],["path",{"d":"M21 6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1h-5.675A7 7 0 1 1 9 6z"}]],"whole-word":[["circle",{"cx":"7","cy":"12","r":"3"}],["path",{"d":"M10 9v6"}],["circle",{"cx":"17","cy":"12","r":"3"}],["path",{"d":"M14 7v8"}],["path",{"d":"M22 17v1c0 .5-.5 1-1 1H3c-.5 0-1-.5-1-1v-1"}]],"wifi-cog":[["path",{"d":"m14.305 19.53.923-.382"}],["path",{"d":"m15.228 16.852-.923-.383"}],["path",{"d":"m16.852 15.228-.383-.923"}],["path",{"d":"m16.852 20.772-.383.924"}],["path",{"d":"m19.148 15.228.383-.923"}],["path",{"d":"m19.53 21.696-.382-.924"}],["path",{"d":"M2 7.82a15 15 0 0 1 20 0"}],["path",{"d":"m20.772 16.852.924-.383"}],["path",{"d":"m20.772 19.148.924.383"}],["path",{"d":"M5 11.858a10 10 0 0 1 11.5-1.785"}],["path",{"d":"M8.5 15.429a5 5 0 0 1 2.413-1.31"}],["circle",{"cx":"18","cy":"18","r":"3"}]],"wifi-high":[["path",{"d":"M12 20h.01"}],["path",{"d":"M5 12.859a10 10 0 0 1 14 0"}],["path",{"d":"M8.5 16.429a5 5 0 0 1 7 0"}]],"wifi-low":[["path",{"d":"M12 20h.01"}],["path",{"d":"M8.5 16.429a5 5 0 0 1 7 0"}]],"wifi-off":[["path",{"d":"M12 20h.01"}],["path",{"d":"M8.5 16.429a5 5 0 0 1 7 0"}],["path",{"d":"M5 12.859a10 10 0 0 1 5.17-2.69"}],["path",{"d":"M19 12.859a10 10 0 0 0-2.007-1.523"}],["path",{"d":"M2 8.82a15 15 0 0 1 4.177-2.643"}],["path",{"d":"M22 8.82a15 15 0 0 0-11.288-3.764"}],["path",{"d":"m2 2 20 20"}]],"wifi-pen":[["path",{"d":"M2 8.82a15 15 0 0 1 20 0"}],["path",{"d":"M21.378 16.626a1 1 0 0 0-3.004-3.004l-4.01 4.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z"}],["path",{"d":"M5 12.859a10 10 0 0 1 10.5-2.222"}],["path",{"d":"M8.5 16.429a5 5 0 0 1 3-1.406"}]],"wifi-sync":[["path",{"d":"M11.965 10.105v4L13.5 12.5a5 5 0 0 1 8 1.5"}],["path",{"d":"M11.965 14.105h4"}],["path",{"d":"M17.965 18.105h4L20.43 19.71a5 5 0 0 1-8-1.5"}],["path",{"d":"M2 8.82a15 15 0 0 1 20 0"}],["path",{"d":"M21.965 22.105v-4"}],["path",{"d":"M5 12.86a10 10 0 0 1 3-2.032"}],["path",{"d":"M8.5 16.429h.01"}]],"wifi-zero":[["path",{"d":"M12 20h.01"}]],"wifi":[["path",{"d":"M12 20h.01"}],["path",{"d":"M2 8.82a15 15 0 0 1 20 0"}],["path",{"d":"M5 12.859a10 10 0 0 1 14 0"}],["path",{"d":"M8.5 16.429a5 5 0 0 1 7 0"}]],"wind-arrow-down":[["path",{"d":"M10 2v8"}],["path",{"d":"M12.8 21.6A2 2 0 1 0 14 18H2"}],["path",{"d":"M17.5 10a2.5 2.5 0 1 1 2 4H2"}],["path",{"d":"m6 6 4 4 4-4"}]],"wind":[["path",{"d":"M12.8 19.6A2 2 0 1 0 14 16H2"}],["path",{"d":"M17.5 8a2.5 2.5 0 1 1 2 4H2"}],["path",{"d":"M9.8 4.4A2 2 0 1 1 11 8H2"}]],"wine-off":[["path",{"d":"M8 22h8"}],["path",{"d":"M7 10h3m7 0h-1.343"}],["path",{"d":"M12 15v7"}],["path",{"d":"M7.307 7.307A12.33 12.33 0 0 0 7 10a5 5 0 0 0 7.391 4.391M8.638 2.981C8.75 2.668 8.872 2.34 9 2h6c1.5 4 2 6 2 8 0 .407-.05.809-.145 1.198"}],["line",{"x1":"2","x2":"22","y1":"2","y2":"22"}]],"wine":[["path",{"d":"M8 22h8"}],["path",{"d":"M7 10h10"}],["path",{"d":"M12 15v7"}],["path",{"d":"M12 15a5 5 0 0 0 5-5c0-2-.5-4-2-8H9c-1.5 4-2 6-2 8a5 5 0 0 0 5 5Z"}]],"workflow":[["rect",{"width":"8","height":"8","x":"3","y":"3","rx":"2"}],["path",{"d":"M7 11v4a2 2 0 0 0 2 2h4"}],["rect",{"width":"8","height":"8","x":"13","y":"13","rx":"2"}]],"worm":[["path",{"d":"m19 12-1.5 3"}],["path",{"d":"M19.63 18.81 22 20"}],["path",{"d":"M6.47 8.23a1.68 1.68 0 0 1 2.44 1.93l-.64 2.08a6.76 6.76 0 0 0 10.16 7.67l.42-.27a1 1 0 1 0-2.73-4.21l-.42.27a1.76 1.76 0 0 1-2.63-1.99l.64-2.08A6.66 6.66 0 0 0 3.94 3.9l-.7.4a1 1 0 1 0 2.55 4.34z"}]],"wrench-off":[["path",{"d":"M10.747 5.093a6 6 0 0 1 6.841-2.882c.438.12.54.662.219.984L14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-2.882 6.842"}],["path",{"d":"m13.5 13.5-7.88 7.88a1 1 0 0 1-2.999-3l7.88-7.88"}],["path",{"d":"m2 2 20 20"}]],"wrench":[["path",{"d":"M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z"}]],"x-line-top":[["path",{"d":"M18 4H6"}],["path",{"d":"M18 8 6 20"}],["path",{"d":"m6 8 12 12"}]],"x":[["path",{"d":"M18 6 6 18"}],["path",{"d":"m6 6 12 12"}]],"zap-off":[["path",{"d":"M10.768 5.111 13.44 2.44a1.5 1.5 0 012.474 1.561l-1.633 4.625"}],["path",{"d":"m18.889 13.232.672-.672A1.5 1.5 0 0018.5 10h-2.844"}],["path",{"d":"m2 2 20 20"}],["path",{"d":"m7.94 7.94-3.5 3.499A1.5 1.5 0 005.5 14h4.002a.5.5 0 01.471.666L8.086 20a1.5 1.5 0 002.475 1.56l5.5-5.5"}]],"zap":[["path",{"d":"M15.914 4a1.5 1.5 0 00-2.474-1.561l-9 9A1.5 1.5 0 005.5 14h4.002a.5.5 0 01.471.666L8.086 20a1.5 1.5 0 002.475 1.56l9-9A1.5 1.5 0 0018.5 10h-3.997a.5.5 0 01-.472-.667z"}]],"zodiac-aquarius":[["path",{"d":"m2 10 2.456-3.684a.7.7 0 0 1 1.106-.013l2.39 3.413a.7.7 0 0 0 1.096-.001l2.402-3.432a.7.7 0 0 1 1.098 0l2.402 3.432a.7.7 0 0 0 1.098 0l2.389-3.413a.7.7 0 0 1 1.106.013L22 10"}],["path",{"d":"m2 18.002 2.456-3.684a.7.7 0 0 1 1.106-.013l2.39 3.413a.7.7 0 0 0 1.097 0l2.402-3.432a.7.7 0 0 1 1.098 0l2.402 3.432a.7.7 0 0 0 1.098 0l2.389-3.413a.7.7 0 0 1 1.106.013L22 18.002"}]],"zodiac-aries":[["path",{"d":"M12 7.5a4.5 4.5 0 1 1 5 4.5"}],["path",{"d":"M7 12a4.5 4.5 0 1 1 5-4.5V21"}]],"zodiac-cancer":[["path",{"d":"M21 14.5A9 6.5 0 0 1 5.5 19"}],["path",{"d":"M3 9.5A9 6.5 0 0 1 18.5 5"}],["circle",{"cx":"17.5","cy":"14.5","r":"3.5"}],["circle",{"cx":"6.5","cy":"9.5","r":"3.5"}]],"zodiac-capricorn":[["path",{"d":"M11 21a3 3 0 0 0 3-3V6.5a1 1 0 0 0-7 0"}],["path",{"d":"M7 19V6a3 3 0 0 0-3-3h0"}],["circle",{"cx":"17","cy":"17","r":"3"}]],"zodiac-gemini":[["path",{"d":"M16 4.525v14.948"}],["path",{"d":"M20 3A17 17 0 0 1 4 3"}],["path",{"d":"M4 21a17 17 0 0 1 16 0"}],["path",{"d":"M8 4.525v14.948"}]],"zodiac-leo":[["path",{"d":"M10 16c0-4-3-4.5-3-8a5 5 0 0 1 10 0c0 3.466-3 6.196-3 10a3 3 0 0 0 6 0"}],["circle",{"cx":"7","cy":"16","r":"3"}]],"zodiac-libra":[["path",{"d":"M3 16h6.857c.162-.012.19-.323.038-.38a6 6 0 1 1 4.212 0c-.153.057-.125.368.038.38H21"}],["path",{"d":"M3 20h18"}]],"zodiac-ophiuchus":[["path",{"d":"M3 10A6.06 6.06 0 0 1 12 10 A6.06 6.06 0 0 0 21 10"}],["path",{"d":"M6 3v12a6 6 0 0 0 12 0V3"}]],"zodiac-pisces":[["path",{"d":"M19 21a15 15 0 0 1 0-18"}],["path",{"d":"M20 12H4"}],["path",{"d":"M5 3a15 15 0 0 1 0 18"}]],"zodiac-sagittarius":[["path",{"d":"M15 3h6v6"}],["path",{"d":"M21 3 3 21"}],["path",{"d":"m9 9 6 6"}]],"zodiac-scorpio":[["path",{"d":"M10 19V5.5a1 1 0 0 1 5 0V17a2 2 0 0 0 2 2h5l-3-3"}],["path",{"d":"m22 19-3 3"}],["path",{"d":"M5 19V5.5a1 1 0 0 1 5 0"}],["path",{"d":"M5 5.5A2.5 2.5 0 0 0 2.5 3"}]],"zodiac-taurus":[["circle",{"cx":"12","cy":"15","r":"6"}],["path",{"d":"M18 3A6 6 0 0 1 6 3"}]],"zodiac-virgo":[["path",{"d":"M11 5.5a1 1 0 0 1 5 0V16a5 5 0 0 0 5 5"}],["path",{"d":"M16 11.5a1 1 0 0 1 5 0V16a5 5 0 0 1-5 5"}],["path",{"d":"M6 19V6a3 3 0 0 0-3-3h0"}],["path",{"d":"M6 5.5a1 1 0 0 1 5 0V19"}]],"zoom-in":[["circle",{"cx":"11","cy":"11","r":"8"}],["line",{"x1":"21","x2":"16.65","y1":"21","y2":"16.65"}],["line",{"x1":"11","x2":"11","y1":"8","y2":"14"}],["line",{"x1":"8","x2":"14","y1":"11","y2":"11"}]],"zoom-out":[["circle",{"cx":"11","cy":"11","r":"8"}],["line",{"x1":"21","x2":"16.65","y1":"21","y2":"16.65"}],["line",{"x1":"8","x2":"14","y1":"11","y2":"11"}]]});
defineMorphIcon();
window.shapcn = {
  DEFAULTS: DEFAULTS,
  easings: easings,
  registerIcons: registerIcons,
  registerFamily: registerFamily,
  registerFamilyFile: registerFamilyFile,
  getIconInfo: getIconInfo,
  getFamily: getFamily,
  getIconNames: getIconNames,
  iconToSVG: iconToSVG,
  planMorph: planMorph,
  planAlive: planAlive,
  MorphIcon: MorphIcon,
  defineMorphIcon: defineMorphIcon
};
})();
