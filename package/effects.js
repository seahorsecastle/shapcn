// Morphicon effects (round 6): appear and disappear as plans. Built only on the hooks of core.js.
// Round 15 adds `planAlive`: a one-shot "life" wiggle for hover (SPEC R15-1 to R15-5).
import { DEFAULTS, easings, iconLoops, planToLoops, planDraw, iconToStrokes, getIconInfo } from './core.js';

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
export const EFFECTS = Object.freeze(['implode', 'explode', 'assemble', 'draw', 'erase', 'scale', 'expand']);

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
export function planEffect(name, direction, effect, opts = {}) {
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
export function planAlive(name, opts = {}) {
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
