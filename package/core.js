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
export const DEFAULTS = Object.freeze({
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

export const easings = {
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
export function registerFamily(spec) {
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
export function registerIcons(map) {
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
export function getIconNames(withShapes = false) {
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
export function getIconInfo(name) {
  if (Array.isArray(name)) return { nodes: name, family: DEFAULT_FAMILY };
  const nodes = getNode(name);
  return { nodes, family: famRec(name).family };
}

/** The family record of a registered family id (or null). Includes the stroke attributes `linecap` and `linejoin`. */
export function getFamily(id) {
  const r = familyById.get(id);
  return r ? { ...r.family, linecap: r.linecap, linejoin: r.linejoin } : null;
}

/**
 * Is `src` a snapshot (the result of `plan.snapshot(t)`)? A stroke snapshot has `kind: 'snapshot'`. A fill snapshot
 * (R7b) has `kind: 'fill'` (older fill snapshots: `kind: 'snapshot'` with `fill: true`). Both have a `loops` array.
 */
export function isSnapshot(src) {
  if (!src || typeof src !== 'object' || Array.isArray(src)) return false;
  return src.kind === 'snapshot' || ((src.kind === 'fill' || src.kind === 'stroke') && Array.isArray(src.loops));
}

/**
 * 'stroke' or 'fill' for an icon name, an icon node, or a snapshot. A snapshot is 'fill' when `snapshot.kind` is
 * 'fill', or `snapshot.fill` is true, or `snapshot.family.kind` is 'fill'. Else it is 'stroke'.
 */
export function getKind(src) {
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
export function getRestPicture(name) {
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
export function iconInnerSVG(nodeOrName) {
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
export function iconToSVG(nodeOrName, opts = {}) {
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
export function iconTree(nodeOrName) {
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
export function iconToStrokes(nodeOrName, cornerAngle = DEFAULTS.cornerAngle, chainGap = DEFAULTS.chainGap, chainAngle = DEFAULTS.chainAngle) {
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
export function stageWindows(opts, hasExits, hasEnters) {
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
export function staggerWindows(count, W, stagger = DEFAULTS.stageStagger) {
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
export function fitSuperellipsePoints(P) {
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
export function alignSuperellipse(fa, fb) {
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
export function lerpSuperellipse(fa, fb, u) {
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
export function setFillPlanner(fn) {
  fillPlanner = typeof fn === 'function' ? fn : null;
}

/**
 * Set the planner for a pair of icons of different kinds (a stroke icon and a fill icon). `fn(from, to, opts)`
 * returns a sequence plan (implode the old icon, then expand the new one). planMorph sets `plan.crossKind = true`.
 * @param {((from: any, to: any, opts: any) => any)|null} fn
 */
export function setCrossPlanner(fn) {
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
export function isStyleToggle(a, b) {
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
export function planMorph(from, to, opts = {}) {
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
export function keptSegments(from, to, opts = {}) {
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
export function iconLoops(src, opts = {}) {
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
export function planToLoops(from, targets, opts = {}) {
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
export function planDraw(src, direction, opts = {}) {
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
export function parseContours(d, opts = {}) {
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
export function polygonArea(P, n = P.length / 2) {
  let a = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += P[2 * i] * P[2 * j + 1] - P[2 * j] * P[2 * i + 1];
  }
  return a / 2;
}

/** Point in polygon (ray casting) for the closed polygon P[0..n-1]. */
export function pointInPolygon(P, n, x, y) {
  return pip(P, n, x, y);
}

/**
 * Resample a closed contour (from parseContours) at M points (M odd, rounded up). The result has M points: M - 1
 * unique points spread at equal arc length with the corners kept, and the first point again at the end.
 * @param {Stroke} contour
 * @param {number} M
 * @returns {Float64Array}
 */
export function resampleLoop(contour, M) {
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
export function alignLoops(X, Y, N, opts = {}) {
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
export function makeRigidBlend(F, T, M, opts = {}) {
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
export function sampleSuperellipse(fit, M) {
  const U = M - 1;
  const L = superellipseLoop(fit.cx, fit.cy, fit.a, fit.b, fit.phi, fit.n, U);
  const out = new Float64Array(2 * M);
  out.set(L);
  out[2 * U] = L[0];
  out[2 * U + 1] = L[1];
  return out;
}

export { hungarian, resolveEasing, smoothstep, fmt, cumLen, fitSuperellipse, superellipseLoop, proxyClosed, proxyOpen };
