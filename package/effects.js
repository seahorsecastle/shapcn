// Morphicon effects (round 6): appear and disappear as plans. Built only on the hooks of core.js.
// Round 15 adds `planAlive`: a one-shot "life" wiggle for hover (SPEC R15-1 to R15-5).
// Round 19 adds the hover styles (grow, bend, bold, cascade, move) and the press styles (pop, squash, squat-jump, burst).
import { DEFAULTS, easings, iconLoops, planToLoops, planDraw, iconToStrokes, getIconInfo, planMorph } from './core.js';

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

// The numbers of a path string. Morph frames of some icon sets write `M x y L x y` (a letter between the numbers), others `M x y x y`.
function alNums(d) {
  return (d.match(/-?\d*\.?\d+(?:e-?\d+)?/gi) || []).map(Number);
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

// ---------------------------------------------------------------------------
// Round 19: hover and press styles (promoted from the rollover lab, owner-approved).
//
// Hover: `wiggle` (the alive rig picks above), `grow`, `bend`, `bold` (held while hovered), `cascade`, `move`
// (live sway from the pointer, `createSway`). Press: `pop`, `squash`, `squat-jump`, `burst`. A press can also change the
// icon (`planPress(name, { style, to })`). Every style returns the same plan interface as `planAlive`: frame(0) and
// frame(1) are the rest icon, no point goes more than 3 units outside the 24 box, the stroke width never changes, there
// is no fading, and two strokes that meet at a point move together in every frame. The default strength is 1.5.
// ---------------------------------------------------------------------------

/** The hover styles. `wiggle` (and its old name `alive`) is deprecated: it still works, but it is not in this list. */
export const HOVER_STYLES = Object.freeze(['grow', 'bend', 'bold', 'cascade', 'move']);
/** The press styles. `anticipate-jump` is the old name of `squat-jump`. */
export const PRESS_STYLES = Object.freeze(['pop', 'squash', 'squat-jump', 'burst']);

let wiggleWarned = false;
// One console.warn per page, the first time the deprecated wiggle is used.
function warnWiggle() {
  if (wiggleWarned) return;
  wiggleWarned = true;
  if (typeof console !== 'undefined' && console.warn) console.warn('shapcn: hover="wiggle" is deprecated and will be removed in 0.3.0; use grow, bend, bold, cascade or move');
}

const HOVER_ALIAS = Object.freeze({ wiggle: 'alive' });
const PRESS_ALIAS = Object.freeze({ 'anticipate-jump': 'squat-jump' });
/** Is this a hover name the element or `planAlive` accepts? */
export const isHoverStyle = (name) => HOVER_STYLES.includes(name) || name === 'alive' || name === 'wiggle';
/** Is this a press name the element or `planPress` accepts? */
export const isPressStyle = (name) => PRESS_STYLES.includes(name) || name === 'anticipate-jump';
/** The internal name of a hover style (`wiggle` is `alive`). */
export const resolveHover = (name) => HOVER_ALIAS[name] || name;
/** The internal name of a press style (`anticipate-jump` is `squat-jump`). */
export const resolvePress = (name) => PRESS_ALIAS[name] || name;
const PLAN_HOVER = ['grow', 'bend', 'bold', 'cascade', 'move']; // the hover styles that have their own motion code (wiggle is the rig-picked one)

const ALIVE_MS = Object.freeze({ alive: 600, bold: 250, cascade: 500, move: 900 }); // every style not listed is 400 ms
const ALIVE_DEFAULT_MS = 400;
const PRESS_MS = Object.freeze({ squash: 300, pop: 300, 'squat-jump': 500, burst: 500 });
/** The default run time in ms of a hover style. */
export const hoverMs = (name) => ALIVE_MS[resolveHover(name)] || ALIVE_DEFAULT_MS;
/** The default run time in ms of a press style. */
export const pressMs = (name) => PRESS_MS[resolvePress(name)];
/** Time in ms of the return to rest when the pointer leaves in the middle of a hover run. */
export const RETARGET_MS = 240;

const STYLE_STEP = 0.6; // units: the largest gap between two points after densifying (non-affine styles)
const STYLE_OUT = 0.4; // fraction of the timeline spent on the way out; the rest is the spring back
const STYLE_FIT_TIMES = 96; // times sampled to fit the bound
const STYLE_FIT_MARGIN = 0.05; // units kept inside the bound for the 2-decimal rounding of the path
const STRENGTH_DEFAULT = 1.5; // the default strength of every style (the slider goes from 0.5 to 3)
const SPREAD_UNITS = 1.6; // grow: units the far edge moves out (grows with the square of the distance)
const BEND_AMP = 1.1; // bend: units of the largest offset
const BEND_CROSS = 0.7; // bend: the second axis bends this fraction of the first
const BEND_WAVE = 0.35; // bend: the second harmonic (an S curve) is this fraction of the first
const BEND_WAVE_LAG = 0.12; // bend: the S curve starts this fraction of the timeline later
const BEND_GROW = 0.04; // bend: a small growth so the bend reads at a glance
const BOLD_PEAK = 0.35; // bold: the stroke weight swells by this fraction (2 to 2.7)
const BOLD_MAX = 1.8; // bold: the width scale never goes above this, so strokes do not merge (2 to 3.6)
const BOLD_MIN = 0.5; // bold: the width scale never goes below this
const CASCADE_ERASE = 0.12; // cascade: fraction of the timeline that takes the old ink away
const CASCADE_KEEP = 0.15; // cascade: the share of every stroke that stays drawn at the turn from erase to redraw
const CASCADE_STAGGER = 0.6; // cascade: fraction of the draw time spent on the stagger between strokes
const POP_PEAK = 0.16; // pop: grows to about 1.18
const SQUASH_Y = 0.2; // squash: scale Y 0.8
const SQUASH_X = 0.12; // squash: scale X 1.12
const SQUASH_IN = 0.25; // squash: fraction of the timeline of the squash
const JUMP_UP = 2; // squat-jump: units up
const JUMP_SQUASH_Y = 0.12; // squat-jump: landing squash, scale Y
const JUMP_SQUASH_X = 0.08; // squat-jump: landing squash, scale X
const BURST_BASE = 0.1; // burst: the center grows this much
const BURST_SPREAD = 0.35; // burst: the far edge grows this much more
const BURST_OUT = 0.3; // burst: fraction of the timeline on the way out
const AJ_SQUAT = 0.12; // squat-jump: squat depth (scale Y)
const AJ_SQUAT_END = 0.2; // squat-jump: the squat is full at this fraction
const AJ_LAUNCH = 0.28; // squat-jump: the squat is gone at this fraction
const AJ_AIR_FROM = 0.24;
const AJ_AIR_TO = 0.62;
const HOVER_ZETA = 0.7; // spring damping of the hover styles (bounce about 0.3)
const HOVER_OMEGA = 14;

// One out-and-back pulse from the engine spring: out over [0, h] (about 16% overshoot), back over [h, 1] with a
// small rebound. Exactly 0 at t = 0 and t = 1.
function alSpringEase(zeta, omega) {
  const wd = omega * Math.sqrt(1 - zeta * zeta);
  const k = (zeta * omega) / wd;
  return (t) => (t <= 0 ? 0 : t >= 1 ? 1 : 1 - Math.exp(-zeta * omega * t) * (Math.cos(wd * t) + k * Math.sin(wd * t)));
}
const HOVER_SPRING = alSpringEase(HOVER_ZETA, HOVER_OMEGA);
function alPulse(t, h = STYLE_OUT, sp = HOVER_SPRING) {
  return t < h ? sp(t / h) : 1 - sp((t - h) / (1 - h));
}
const alSmooth = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

function alDensify(P) {
  const out = [];
  const n = P.length / 2;
  for (let k = 0; k < n; k++) {
    if (k > 0) {
      const x0 = P[2 * k - 2];
      const y0 = P[2 * k - 1];
      const x1 = P[2 * k];
      const y1 = P[2 * k + 1];
      const m = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / STYLE_STEP);
      for (let j = 1; j < m; j++) out.push(x0 + ((x1 - x0) * j) / m, y0 + ((y1 - y0) * j) / m);
    }
    out.push(P[2 * k], P[2 * k + 1]);
  }
  return Float64Array.from(out);
}

// The same densify for a loop with a visibility mask (one entry per segment): each piece of a segment keeps its entry.
function alDensifyVis(P, vis) {
  const out = [];
  const outVis = [];
  const n = P.length / 2;
  for (let k = 0; k < n; k++) {
    if (k > 0) {
      const x0 = P[2 * k - 2];
      const y0 = P[2 * k - 1];
      const x1 = P[2 * k];
      const y1 = P[2 * k + 1];
      const m = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / STYLE_STEP);
      const v = vis ? vis[k - 1] : 1;
      for (let j = 1; j < m; j++) {
        out.push(x0 + ((x1 - x0) * j) / m, y0 + ((y1 - y0) * j) / m);
        outVis.push(v);
      }
      outVis.push(v);
    }
    out.push(P[2 * k], P[2 * k + 1]);
  }
  return { points: Float64Array.from(out), vis: Uint8Array.from(outVis) };
}

// The first fraction f of a polyline (by length). f >= 1 returns the polyline itself; nothing left returns an empty array.
function alTrim(P, f) {
  if (f >= 1) return P;
  let L = 0;
  for (let k = 2; k < P.length; k += 2) L += Math.hypot(P[k] - P[k - 2], P[k + 1] - P[k - 1]);
  const target = f * L;
  if (!(target > 1e-6)) return new Float64Array(0);
  const out = [P[0], P[1]];
  let acc = 0;
  for (let k = 2; k < P.length; k += 2) {
    const seg = Math.hypot(P[k] - P[k - 2], P[k + 1] - P[k - 1]);
    if (acc + seg >= target) {
      const u = seg > 1e-12 ? (target - acc) / seg : 0;
      out.push(P[k - 2] + (P[k] - P[k - 2]) * u, P[k - 1] + (P[k + 1] - P[k - 1]) * u);
      return Float64Array.from(out);
    }
    out.push(P[k], P[k + 1]);
    acc += seg;
  }
  return Float64Array.from(out);
}

// Affine helpers on flat point arrays.
function alAffine(P, out, bx, by, sx, sy, dx, dy, deg) {
  const c = Math.cos(deg * ALIVE_DEG);
  const s = Math.sin(deg * ALIVE_DEG);
  for (let q = 0; q < P.length; q += 2) {
    const x = (P[q] - bx) * sx;
    const y = (P[q + 1] - by) * sy;
    out[q] = bx + c * x - s * y + dx;
    out[q + 1] = by + s * x + c * y + dy;
  }
}

// The point warp of a style at time t with amplitude gain g. `ctx` holds the rest geometry.
function alWarp(style, ctx, P, t, g) {
  const out = new Float64Array(P.length);
  const { cx, cy, R, bx, by, bw, bh, baseY } = ctx;
  const sp = easings.bouncy;
  switch (style) {
    case 'p:squat-jump': {
      let q0 = 0;
      if (t < AJ_SQUAT_END) q0 = alSmooth(t / AJ_SQUAT_END);
      else if (t < AJ_LAUNCH) q0 = 1 - alSmooth((t - AJ_SQUAT_END) / (AJ_LAUNCH - AJ_SQUAT_END));
      let dy = 0;
      let q1 = 0;
      if (t >= AJ_AIR_FROM && t < AJ_AIR_TO) dy = -g * JUMP_UP * Math.sin((Math.PI * (t - AJ_AIR_FROM)) / (AJ_AIR_TO - AJ_AIR_FROM));
      else if (t >= AJ_AIR_TO) {
        const u = (t - AJ_AIR_TO) / (1 - AJ_AIR_TO);
        q1 = alSmooth(u / 0.12) * (1 - sp(u));
      }
      const sy = 1 - g * (AJ_SQUAT * q0 + JUMP_SQUASH_Y * q1);
      const sx = 1 + g * (0.08 * q0 + JUMP_SQUASH_X * q1);
      for (let i = 0; i < P.length; i += 2) {
        out[i] = bx + (P[i] - bx) * sx;
        out[i + 1] = baseY + (P[i + 1] - baseY) * sy + dy;
      }
      break;
    }
    case 'p:pop': {
      const k = 1 + g * POP_PEAK * alPulse(t, 0.3);
      alAffine(P, out, bx, by, k, k, 0, 0, 0);
      break;
    }
    case 'p:squash': {
      const q = t < SQUASH_IN ? alSmooth(t / SQUASH_IN) : 1 - sp((t - SQUASH_IN) / (1 - SQUASH_IN));
      for (let i = 0; i < P.length; i += 2) {
        out[i] = bx + (P[i] - bx) * (1 + g * SQUASH_X * q);
        out[i + 1] = baseY + (P[i + 1] - baseY) * (1 - g * SQUASH_Y * q);
      }
      break;
    }
    case 'p:burst': {
      const pu = alPulse(t, BURST_OUT);
      for (let q = 0; q < P.length; q += 2) {
        const dx = P[q] - cx;
        const dy = P[q + 1] - cy;
        const f = Math.min(1, Math.hypot(dx, dy) / R);
        const k = 1 + g * pu * (BURST_BASE + BURST_SPREAD * f);
        out[q] = cx + dx * k;
        out[q + 1] = cy + dy * k;
      }
      break;
    }
    case 'grow': {
      const pu = alPulse(t);
      for (let q = 0; q < P.length; q += 2) {
        const dx = P[q] - cx;
        const dy = P[q + 1] - cy;
        const r = Math.hypot(dx, dy);
        const f = Math.min(1, r / R);
        const m = r > 1e-9 ? (g * SPREAD_UNITS * pu * f * f) / r : 0;
        out[q] = P[q] + dx * m;
        out[q + 1] = P[q + 1] + dy * m;
      }
      break;
    }
    default: {
      // bend: offsets that follow a smooth sine of the position across the icon box, plus a later second harmonic.
      const w1 = g * BEND_AMP * alPulse(t);
      const w2 = g * BEND_AMP * BEND_WAVE * alPulse(alClamp((t - BEND_WAVE_LAG) / (1 - BEND_WAVE_LAG)));
      const k = 1 + g * BEND_GROW * alPulse(t);
      for (let q = 0; q < P.length; q += 2) {
        const u = (P[q] - bx + bw / 2) / bw;
        const v = (P[q + 1] - by + bh / 2) / bh;
        const x = bx + (P[q] - bx) * k;
        const y = by + (P[q + 1] - by) * k;
        out[q] = x + w1 * Math.sin(Math.PI * v) + w2 * Math.sin(2 * Math.PI * v);
        out[q + 1] = y + BEND_CROSS * (w1 * Math.sin(Math.PI * u) + w2 * Math.sin(2 * Math.PI * u));
      }
    }
  }
  return out;
}

const AFFINE_STYLES = new Set(['p:squash', 'p:pop', 'p:squat-jump']);

// The motion of a hover or press style: { X(i, t) points of stroke i, W(t) width scale, dense(i) }. Identity at t = 0 and t = 1.
function alStyleX(style, S, T, RP, strength, o = {}) {
  const one = () => 1;
  const phase = o.phase === 'down' ? 'down' : null;
  const atRest = (t) => t <= 0 || t >= 1;
  if (style === 'cascade') {
    // Old ink goes away from the end back to the start, then the strokes draw again in rig order (body first, parts after).
    const n = RP.length;
    const E = CASCADE_ERASE;
    const STAG = CASCADE_STAGGER;
    // a part of every stroke stays drawn at the turn, so the icon is never empty
    const low = Math.max(CASCADE_KEEP, 1 - Math.min(1, strength));
    const win = (1 - E) * (1 - STAG);
    const order = Array.from({ length: n }, (_, i) => i);
    order.sort((a, b) => ((T[a] && T[a].level >= 0 ? T[a].level : 99) - (T[b] && T[b].level >= 0 ? T[b].level : 99)) || a - b);
    const pos = new Array(n);
    order.forEach((i, k) => (pos[i] = k));
    const X = (i, t) => {
      if (t <= 0 || t >= 1) return RP[i];
      let f;
      if (t < E) f = 1 - (1 - low) * easings.easeInOutCubic(t / E);
      else {
        const off = n > 1 ? ((1 - E) * STAG * pos[i]) / (n - 1) : 0;
        f = low + (1 - low) * easings.easeOutCubic(alClamp((t - E - off) / win));
      }
      return alTrim(RP[i], f);
    };
    return { X, W: one, dense: null };
  }
  if (style === 'bold') {
    // Bold holds: phase 'down' swells on a spring and stays swollen (frame 1 is the held weight). The way back is
    // `retargetPlan(plan, t, true)`. With no phase the weight swells and returns (the whole run).
    if (phase === 'down') {
      return { dense: (i) => RP[i], X: (i) => RP[i], W: (t) => (t <= 0 ? 1 : Math.min(BOLD_MAX, 1 + strength * BOLD_PEAK * HOVER_SPRING(alClamp(t)))) };
    }
    return { dense: (i) => RP[i], X: (i) => RP[i], W: (t) => (t <= 0 || t >= 1 ? 1 : Math.min(BOLD_MAX, Math.max(BOLD_MIN, 1 + strength * BOLD_PEAK * alPulse(t, STYLE_OUT)))) };
  }
  const DP = AFFINE_STYLES.has(style) ? RP : RP.map((P) => alDensify(P));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const P of RP) {
    for (let k = 0; k < P.length; k += 2) {
      x0 = Math.min(x0, P[k]); x1 = Math.max(x1, P[k]);
      y0 = Math.min(y0, P[k + 1]); y1 = Math.max(y1, P[k + 1]);
    }
  }
  const [cx, cy] = alCoreCenter(S, T);
  let R = 1e-6;
  for (const P of RP) for (let k = 0; k < P.length; k += 2) R = Math.max(R, Math.hypot(P[k] - cx, P[k + 1] - cy));
  const limit = ALIVE_BOUND - STYLE_FIT_MARGIN;
  const bx = (x0 + x1) / 2;
  const by = (y0 + y1) / 2;
  const ctx = { cx, cy, R, bx, by, bw: Math.max(1, x1 - x0), bh: Math.max(1, y1 - y0), baseY: y1 };
  // R15-5: find the largest gain in [0, strength] that keeps every point within the bound at the sampled times.
  const worst = (g) => {
    let w = 0;
    for (let s = 1; s < STYLE_FIT_TIMES; s++) {
      const t = s / STYLE_FIT_TIMES;
      for (const P of DP) {
        const Q = alWarp(style, ctx, P, t, g);
        for (let k = 0; k < Q.length; k++) w = Math.max(w, -Q[k], Q[k] - 24);
      }
    }
    return w;
  };
  let gain = strength;
  if (worst(gain) > limit) {
    let lo = 0;
    let hi = gain;
    for (let it = 0; it < 8; it++) {
      const mid = (lo + hi) / 2;
      if (worst(mid) <= limit) lo = mid;
      else hi = mid;
    }
    gain = lo;
  }
  return { X: (i, t) => (atRest(t) ? RP[i] : alWarp(style, ctx, DP[i], alClamp(t), gain)), W: one, dense: (i) => DP[i], info: { ctx, gain } };
}

// ---------------------------------------------------------------------------
// `move`: the icon hangs from its top (a bell, a lamp) or stands on its base (a house, a trash can, a user) and sways
// with the pointer. Each stroke moves rigidly about its own joint. A part rides its parent, and a stroke end that
// touches another stroke is stitched to it, so no joint opens.
// ---------------------------------------------------------------------------

const RIG_STITCH_LEN = 3; // units: how far along a stroke a stitch correction reaches
const RIG_FIT_TIMES = 64; // times sampled to fit the bound
const RIG_FIT_MARGIN = 0.3; // units kept inside the bound: a spring can peak between two samples
const RIG_JOINT_TOL = 0.05; // units: a stroke end this close to another stroke is a joint
const HANG_PUSH_DEG = 18; // the first swing at full pointer speed (the plan without a live pointer)
const HANG_CYCLES = 2.5; // swings over the run
const HANG_DECAY = 3.2; // how fast the swings die (exp(-decay t))
const HANG_DEFAULT_VELOCITY = { vx: 0.5, vy: 0 }; // when no pointer movement is known (keyboard, touch)
const HF_FREQ = 2.2; // Hz of the sway spring
const HF_ZETA = 0.32; // damping ratio (2 to 3 visible swings after the pointer leaves)
const HF_RELEASE_DAMP = 1.45; // the damping is this many times higher after the pointer left
const HF_VISIBLE = 0.05; // at rest when no point is more than this far (units) from its rest place
const HF_MAX_DEG = 14; // the lean at full pointer speed
const HF_KICK = 240; // degrees per second given by the first move at full speed
const HF_SMOOTH = 0.1; // seconds of smoothing of the pointer velocity
const HF_IDLE = 0.06; // seconds without a move before the input decays
const HF_LAG_GAIN = 0.03; // a part trails its parent's turn rate by this (degrees per degree per second)
const HF_EXTRA_MAX = 6; // the largest extra turn of a part, degrees
const HF_STEP = 1 / 120; // seconds, the largest physics step

// Where the icon hangs or stands: { x, y, kind: 'top' | 'base' | 'tip' }.
function alHangPoint(DP) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const P of DP) {
    for (let k = 0; k < P.length; k += 2) {
      x0 = Math.min(x0, P[k]); x1 = Math.max(x1, P[k]);
      y0 = Math.min(y0, P[k + 1]); y1 = Math.max(y1, P[k + 1]);
    }
  }
  const H = Math.max(1e-6, y1 - y0);
  const W = Math.max(1e-6, x1 - x0);
  const band = (from, to) => {
    let a = Infinity, b = -Infinity, sx = 0, c = 0;
    for (const P of DP) {
      for (let k = 0; k < P.length; k += 2) {
        if (P[k + 1] >= from && P[k + 1] <= to) {
          a = Math.min(a, P[k]); b = Math.max(b, P[k]); sx += P[k]; c++;
        }
      }
    }
    return c ? { w: b - a, x: sx / c } : { w: 0, x: (x0 + x1) / 2 };
  };
  const top = band(y0, y0 + 0.2 * H);
  const bot = band(y1 - 0.12 * H, y1);
  if (bot.w >= 0.6 * W) return { x: bot.x, y: y1, kind: 'base' };
  const topX = band(y0, y0 + 0.06 * H).x;
  if (top.w < 0.7 * W && Math.abs(topX - (x0 + x1) / 2) <= 0.15 * W) return { x: topX, y: y0, kind: 'top' };
  return { x: band(y1 - 0.05 * H, y1).x, y: y1, kind: 'tip' };
}

// The motion of `move`. Returns { X, W, dense, live } like alStyleX. `live` drives `createSway`.
function alMoveX(S, T, RP, strength, o) {
  const n = S.length;
  const DP = RP.map((P) => alDensify(P));
  const wt = S.map((s) => s.length * (s.closed ? 1.5 : 1));
  const role = S.map((s, i) => (T[i] ? T[i].role : 'core'));
  const parent = S.map((s, i) => (T[i] && T[i].parent >= 0 ? T[i].parent : -1));
  const isPart = (i) => role[i] === 'part' && parent[i] >= 0;
  const level = S.map((s, i) => (isPart(i) ? Math.max(1, T[i].level) : 0));
  const maxLevel = Math.max(0, ...level);
  const cen = RP.map((P) => alCentroid(P));
  const [, bcy] = alCoreCenter(S, T);
  // The pivot of a part is its joint with its parent: its own end when it attaches with an end, else the contact point.
  const pivot = S.map((s, i) => {
    if (!isPart(i)) return cen[i];
    const t = T[i];
    if (t.attach === 'end' && !s.closed && (t.end === 0 || t.end === 1)) {
      const P = RP[i];
      return t.end === 0 ? [P[0], P[1]] : [P[P.length - 2], P[P.length - 1]];
    }
    if (t.contact) return [t.contact[0], t.contact[1]];
    let best = null;
    let bd = Infinity;
    const Q = DP[parent[i]];
    for (let k = 0; k < RP[i].length; k += 2) {
      for (let m = 0; m < Q.length; m += 2) {
        const d = Math.hypot(RP[i][k] - Q[m], RP[i][k + 1] - Q[m + 1]);
        if (d < bd) {
          bd = d;
          best = [RP[i][k], RP[i][k + 1]];
        }
      }
    }
    return best || cen[i];
  });
  const hp = alHangPoint(DP);
  const v = o.velocity && Number.isFinite(o.velocity.vx) ? o.velocity : HANG_DEFAULT_VELOCITY;
  const speed = Math.min(1, Math.hypot(v.vx, v.vy || 0));
  // sRight: +1 when a positive turn moves the middle of the body to the right (a body above the pivot), else -1
  const sRight = bcy - hp.y <= 0 ? 1 : -1;
  const dirSign = Math.abs(v.vx) < 0.05 ? 1 : Math.sign(v.vx);
  const lateral = Math.abs(v.vx) < 0.05 ? 0.4 : 1; // a pointer that moves straight up or down brushes less
  const amp = HANG_PUSH_DEG * Math.max(0.25, speed) * lateral * sRight * dirSign;
  const env = (t) => Math.sin(2 * Math.PI * HANG_CYCLES * alClamp(t)) * Math.exp(-HANG_DECAY * alClamp(t)) * (1 - alClamp(t));
  let G = 1;
  // the local matrix of stroke i: the body turns about the hang point, a part rides its parent
  let loc = (i, t) => (isPart(i) ? null : alRot(hp.x, hp.y, G * amp * env(t)));

  // ---- joints to stitch: a stroke end that touches another stroke ----
  const cl = DP.map((P) => {
    const c = new Float64Array(P.length / 2);
    for (let k = 1; k < c.length; k++) c[k] = c[k - 1] + Math.hypot(P[2 * k] - P[2 * k - 2], P[2 * k + 1] - P[2 * k - 1]);
    return c;
  });
  const rank = (a, b) => level[a] - level[b] || wt[b] - wt[a] || a - b; // negative: a leads b
  const joints = [];
  for (let i = 0; i < n; i++) {
    const P = DP[i];
    if (P.length < 4) continue;
    // A closed stroke has one joint point, its start (its last point repeats it).
    const ends = S[i].closed ? [[0, P[0], P[1]]] : [[0, P[0], P[1]], [P.length / 2 - 1, P[P.length - 2], P[P.length - 1]]];
    for (const [vi, px, py] of ends) {
      for (let j = 0; j < n; j++) {
        if (j === i || DP[j].length < 4) continue;
        const Q = DP[j];
        let best = Infinity;
        let bs = 0;
        let bf = 0;
        for (let k = 0; k + 3 < Q.length; k += 2) {
          const ax = Q[k], ay = Q[k + 1];
          const dx = Q[k + 2] - ax, dy = Q[k + 3] - ay;
          const l2 = dx * dx + dy * dy;
          let f = l2 > 1e-12 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
          f = Math.max(0, Math.min(1, f));
          const d = Math.hypot(px - ax - f * dx, py - ay - f * dy);
          if (d < best) { best = d; bs = k / 2; bf = f; }
        }
        if (best <= RIG_JOINT_TOL) {
          // The end of i touches the point (bs, bf) of j. The follower is the stroke that ranks lower.
          const iFollows = rank(i, j) > 0;
          joints.push({ f: iFollows ? i : j, l: iFollows ? j : i, fEnd: iFollows ? vi : null, fSeg: iFollows ? 0 : bs, fFrac: iFollows ? 0 : bf, lEnd: iFollows ? null : vi, lSeg: iFollows ? bs : 0, lFrac: iFollows ? bf : 0 });
        }
      }
    }
  }
  joints.sort((x, y) => rank(x.f, y.f)); // leaders are corrected before the strokes that follow them
  const at = (P, vi, seg, frac) => {
    if (vi !== null) return [P[2 * vi], P[2 * vi + 1]];
    return [P[2 * seg] + (P[2 * seg + 2] - P[2 * seg]) * frac, P[2 * seg + 1] + (P[2 * seg + 3] - P[2 * seg + 1]) * frac];
  };

  // ---- the frame: world matrices, points, stitching ----
  let cacheKey = NaN;
  let cacheGain = NaN;
  let cacheP = null;
  const compute = (t, g) => {
    if (t === cacheKey && g === cacheGain) return cacheP;
    G = g;
    const Wm = new Array(n);
    const world = (i) => {
      if (Wm[i]) return Wm[i];
      const L = loc(i, t);
      const p = isPart(i) ? parent[i] : -1;
      let A;
      if (p < 0) A = L || { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
      else {
        const Wp = world(p);
        A = L ? alMul(Wp, L) : Wp;
      }
      Wm[i] = A;
      return A;
    };
    const P = new Array(n);
    for (let i = 0; i < n; i++) P[i] = alApply(world(i), DP[i]);
    for (let pass = 0; pass < 6 && joints.length; pass++) {
      for (const j of joints) {
        const F = P[j.f];
        const cur = at(F, j.fEnd, j.fSeg, j.fFrac);
        const tgt = at(P[j.l], j.lEnd, j.lSeg, j.lFrac);
        const dx = tgt[0] - cur[0];
        const dy = tgt[1] - cur[1];
        if (Math.abs(dx) + Math.abs(dy) < 1e-9) continue;
        const c = cl[j.f];
        const total = c[c.length - 1];
        const LEN = Math.max(1e-6, Math.min(RIG_STITCH_LEN, 0.5 * total));
        const sj = j.fEnd !== null ? c[j.fEnd] : c[j.fSeg] + (c[j.fSeg + 1] - c[j.fSeg]) * j.fFrac;
        for (let k = 0; k < c.length; k++) {
          let d = Math.abs(c[k] - sj);
          if (S[j.f].closed) d = Math.min(d, total - d);
          const w = alSmooth(1 - d / LEN);
          if (w > 0) {
            F[2 * k] += dx * w;
            F[2 * k + 1] += dy * w;
          }
        }
      }
    }
    cacheKey = t;
    cacheGain = g;
    cacheP = P;
    return P;
  };

  // ---- the live frame: a turn about the hang point and an extra turn of each part depth, set by the sway physics ----
  const state = { theta: 0, extra: new Array(maxLevel + 1).fill(0) };
  let liveN = 0;
  let swingOK = null;
  let zeroStitch = null;
  const run = (theta, extra) => {
    state.theta = theta;
    state.extra = extra;
    const keep = loc;
    loc = (i) => (isPart(i) ? (swingOK[i] ? alRot(pivot[i][0], pivot[i][1], state.extra[level[i]] || 0) : null) : alRot(hp.x, hp.y, state.theta));
    const P = compute(-(++liveN), 1);
    loc = keep;
    return P;
  };
  const liveFrame = (theta, extra, wRest = 1) => {
    if (!swingOK) {
      // A part with more than one joint cannot turn alone: a second joint would open. It only rides its parent.
      const cnt = new Array(n).fill(0);
      for (const j of joints) {
        cnt[j.f]++;
        cnt[j.l]++;
      }
      swingOK = cnt.map((c, i) => c <= 1 && !(isPart(i) && T[i].attach === 'arch'));
      // The stitch also closes the art's own small gaps at rest. That is taken out, so the rest pose is the true rest icon.
      zeroStitch = run(0, new Array(extra.length).fill(0)).map((A, i) => Float64Array.from(A, (val, k) => val - DP[i][k]));
    }
    return run(theta, extra).map((A, i) => Float64Array.from(A, (val, k) => val - wRest * zeroStitch[i][k]));
  };

  // ---- the largest gain in [0, strength] that keeps every point of the plan inside the bound ----
  const limit = ALIVE_BOUND - RIG_FIT_MARGIN;
  const worst = (g) => {
    let w = 0;
    for (let s = 1; s < RIG_FIT_TIMES; s++) {
      const P = compute(s / RIG_FIT_TIMES, g);
      for (const A of P) for (let k = 0; k < A.length; k++) w = Math.max(w, -A[k], A[k] - 24);
    }
    return w;
  };
  let gain = strength;
  if (worst(gain) > limit) {
    let lo = 0;
    let hi = gain;
    for (let it = 0; it < 7; it++) {
      const mid = (lo + hi) / 2;
      if (worst(mid) <= limit) lo = mid;
      else hi = mid;
    }
    gain = lo;
  }
  cacheKey = NaN;
  // The largest turn about the pivot, either way, that keeps every point inside the bound (room is kept for the parts).
  const lim = ALIVE_BOUND - RIG_FIT_MARGIN - 0.9;
  const fits = (deg) => {
    for (const sgn of [1, -1]) {
      const c = Math.cos(deg * ALIVE_DEG);
      const sn = Math.sin(sgn * deg * ALIVE_DEG);
      for (const A of DP) {
        for (let k = 0; k < A.length; k += 2) {
          const x = hp.x + (A[k] - hp.x) * c - (A[k + 1] - hp.y) * sn;
          const y = hp.y + (A[k] - hp.x) * sn + (A[k + 1] - hp.y) * c;
          if (x < -lim || x > 24 + lim || y < -lim || y > 24 + lim) return false;
        }
      }
    }
    return true;
  };
  let lo = 0;
  let hi = 40;
  for (let it = 0; it < 8; it++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  let rmax = 1e-6;
  for (const A of DP) for (let k = 0; k < A.length; k += 2) rmax = Math.max(rmax, Math.hypot(A[k] - hp.x, A[k + 1] - hp.y));
  const live = { frame: liveFrame, rest: RP, rmax, sRight, maxLevel, cap: lo / 1.6 };
  return {
    live,
    X: (i, t) => (t <= 0 || t >= 1 ? RP[i] : compute(t, gain)[i]),
    W: () => 1,
    dense: (i) => DP[i],
  };
}

function alPlanObject({ slots, n, strokeWidth, kind, X, Wf }) {
  return {
    kind,
    slots,
    turn: 0,
    duration: 0,
    strokeWidth,
    linecap: 'round',
    linejoin: 'round',
    occlusion: 'none',
    masks: false,
    occludes: () => false,
    twinOccludes: () => false,
    X,
    W: Wf,
    frame(t) {
      t = alClamp(t);
      const res = [];
      for (let i = 0; i < n; i++) {
        const d = alD(X(i, t));
        if (!d || d === 'M') continue;
        const e = { d, opacity: 1, widthScale: Wf(t), key: i * 4, slot: i, depth: i, occluder: false };
        res.push(e);
      }
      return res;
    },
    snapshot(t) {
      t = alClamp(t);
      const loops = [];
      for (let i = 0; i < n; i++) {
        const P = X(i, t);
        if (P.length < 4) continue;
        loops.push({ points: P, opacity: 1, widthScale: 1, vis: new Uint8Array(P.length / 2 - 1).fill(1) });
      }
      return { kind: 'snapshot', loops };
    },
  };
}

const RETARGET_BLEND = 0.35; // forward retarget: fraction of the run that blends the current pose into the plan

/**
 * Interruptible motion. A plan that starts at the pose `src` has at time `t`.
 * - `toRest` true: from that pose back to the rest icon (a gentle spring; the pointer left). Frame 0 is the pose, frame 1 the rest icon.
 * - `toRest` false: from that pose forward into the original plan (the pointer came back). Frame 1 is the end of the original plan.
 * Needs a plan with `dense` (the styles except cascade). The result can be retargeted again.
 * @param {Object} src A plan from `planAlive` or `planPress`, or a plan from `retargetPlan`.
 * @param {number} t The time of `src` to start from (0 to 1).
 * @param {boolean} toRest
 */
export function retargetPlan(src, t, toRest) {
  if (!src || typeof src.dense !== 'function') return null;
  const base = src.base || src;
  const pose = [];
  const A = (i) => pose[i] || (pose[i] = src.X(i, t));
  const WA = src.W(t);
  const lerp = (a, b, e) => {
    if (a.length !== b.length) return b;
    const out = new Float64Array(a.length);
    for (let k = 0; k < a.length; k++) out[k] = a[k] + (b[k] - a[k]) * e;
    return out;
  };
  const X = toRest
    ? (i, u) => (u >= 1 ? src.rest(i) : lerp(A(i).length === src.dense(i).length ? A(i) : src.dense(i), src.dense(i), easings.gentle(u)))
    : (i, u) => (u >= 1 ? base.X(i, 1) : lerp(A(i), base.X(i, Math.max(u, 1e-6)), alSmooth(u / RETARGET_BLEND)));
  const Wf = toRest ? (u) => (u >= 1 ? 1 : WA + (1 - WA) * easings.gentle(u)) : (u) => WA + (base.W(u) - WA) * alSmooth(u / RETARGET_BLEND);
  const plan = alPlanObject({ slots: src.slots, n: src.slots.length, strokeWidth: src.strokeWidth, kind: 'retarget', X, Wf });
  plan.dense = src.dense;
  plan.rest = src.rest;
  plan.base = base;
  plan.returning = !!toRest;
  return plan;
}

/**
 * A live sway for `hover="move"`. A small spring physics object that runs frame by frame, not on a fixed
 * timeline. The icon turns about its hang or stand point (top for an icon that hangs, base for one that stands). The
 * pointer's movement drives the turn: the angle follows `sRight * velocity * maxDeg` on a damped spring, parts trail
 * their parent by depth, and after `release()` the sway rings down to rest.
 *   const sw = createSway('bell', { strength: 1, duration: 900 });
 *   sw.push(vx, vy);          // a kick (the pointer came in with this velocity, each -1..1)
 *   sw.setInput(vx, vy);      // while the pointer is over the icon: its current velocity, -1..1
 *   sw.release();             // the pointer left
 *   sw.frame(now);            // advance the physics to `now` (ms) and return the entries to draw (like plan.frame)
 *   sw.atRest;                // released and still: draw the rest icon
 * @param {string|Array} name
 * @param {{strength?: number, duration?: number}} [opts] `duration` (ms) scales the spring: 900 is the default feel.
 */
export function createSway(name, opts = {}) {
  const plan = planAlive(name, { ...opts, style: 'move' });
  const L = plan.live;
  const strength = Number.isFinite(opts.strength) && opts.strength > 0 ? opts.strength : STRENGTH_DEFAULT;
  const timeScale = Number.isFinite(opts.duration) && opts.duration > 0 ? 900 / opts.duration : 1;
  const w0 = 2 * Math.PI * HF_FREQ * timeScale;
  const K = w0 * w0;
  const C = 2 * HF_ZETA * w0;
  const wp = 2 * Math.PI * 3.2 * timeScale;
  const Kp = wp * wp;
  const Cp = 2 * 0.3 * wp;
  const maxDeg = Math.min(HF_MAX_DEG * strength, L.cap);
  const clamp1 = (v) => Math.max(-1, Math.min(1, Number.isFinite(v) ? v : 0));
  const st = { th: 0, om: 0, vf: 0, inX: 0, idle: 0, released: false, last: null, ex: new Array(L.maxLevel + 1).fill(0), eo: new Array(L.maxLevel + 1).fill(0) };
  const step = (dt) => {
    st.idle += dt;
    if (st.idle > HF_IDLE) st.inX *= Math.exp(-dt / 0.08);
    st.vf += (st.inX - st.vf) * (1 - Math.exp(-dt / HF_SMOOTH));
    const target = L.sRight * st.vf * maxDeg;
    // After the pointer leaves the sway rings down with more damping, so it settles in about a second.
    st.om += (K * (target - st.th) - (st.released ? C * HF_RELEASE_DAMP : C) * st.om) * dt;
    st.th += st.om * dt;
    const lim = maxDeg * 1.6;
    if (Math.abs(st.th) > lim) {
      st.th = Math.sign(st.th) * lim;
      st.om = 0;
    }
    for (let l = 1; l <= L.maxLevel; l++) {
      const T = -HF_LAG_GAIN * st.om * (1 + 0.3 * (l - 1)) * strength;
      st.eo[l] += (Kp * (T - st.ex[l]) - Cp * st.eo[l]) * dt;
      st.ex[l] += st.eo[l] * dt;
      st.ex[l] = Math.max(-HF_EXTRA_MAX, Math.min(HF_EXTRA_MAX, st.ex[l]));
    }
  };
  const entriesOf = (P) => {
    const res = [];
    for (let i = 0; i < P.length; i++) {
      const d = alD(P[i]);
      if (!d || d === 'M') continue;
      const e = { d, opacity: 1, widthScale: 1, key: i * 4, slot: i, depth: i, occluder: false };
      res.push(e);
    }
    return res;
  };
  return {
    kind: 'sway',
    slots: plan.slots,
    strokeWidth: plan.strokeWidth,
    linecap: 'round',
    linejoin: 'round',
    occlusion: 'none',
    masks: false,
    occludes: () => false,
    twinOccludes: () => false,
    push(vx) {
      st.om += L.sRight * clamp1(vx) * HF_KICK * strength * timeScale;
      st.released = false;
    },
    setInput(vx) {
      st.inX = clamp1(vx);
      st.idle = 0;
      st.released = false;
    },
    release() {
      st.inX = 0;
      st.released = true;
    },
    get released() {
      return st.released;
    },
    get atRest() {
      // The size of the swing left: the angle and the angle the speed would reach. At rest when that is under 0.05 units at the far ink.
      const left = Math.hypot(st.th, st.om / w0) * ALIVE_DEG * L.rmax;
      return st.released && left < HF_VISIBLE && Math.abs(st.vf) < 0.01 && st.ex.every((e, l) => Math.abs(e) * ALIVE_DEG * L.rmax < HF_VISIBLE && Math.abs(st.eo[l] / wp) * ALIVE_DEG * L.rmax < HF_VISIBLE);
    },
    /** The angle now, in degrees (for tests). */
    get angle() {
      return st.th;
    },
    frame(now) {
      if (st.last === null) st.last = now;
      let dt = Math.min(Math.max(0, now - st.last), 50) / 1000;
      st.last = now;
      while (dt > 1e-9) {
        const h = Math.min(HF_STEP, dt);
        step(h);
        dt -= h;
      }
      // Near rest the stitch's small gap-closing is taken out (weight 1 at rest, 0 once the swing is 0.12 units or more).
      const left = Math.hypot(st.th, st.om / w0) * ALIVE_DEG * L.rmax;
      return entriesOf(L.frame(st.th, st.ex.slice(), 1 - alSmooth(left / 0.12)));
    },
    /** The rest icon, as entries (frame at rest). */
    rest() {
      return entriesOf(L.rest); // the true rest strokes
    },
  };
}

// ---------------------------------------------------------------------------
// A click that changes the icon. `planPress(name, { style, to })` plays the press style while the icon
// morphs from `name` to `to` inside it. The morph is the real morph plan (planMorph, spring). The press motion is applied
// to the points of each morph frame, so one plan returns the combined frames. frame(0) is the old rest icon and frame(1)
// the new rest icon (they are the morph plan's own first and last frames). The morph runs in a window of the press:
// - squash: through the squash and the spring back
// - squat-jump: in the air, from take-off to landing
// - burst: around the peak, the parts are out as the old icon and snap back in as the new one
// ---------------------------------------------------------------------------

/** Default run time in ms of a click that changes the icon. Other styles: 500 ms. */
const PRESS_TO_MS = Object.freeze({ squash: 450, 'squat-jump': 650, burst: 600 });
/** The default run time in ms of a press that changes the icon. */
export const pressToMs = (style) => PRESS_TO_MS[resolvePress(style)] || 500;
// The window of the press timeline (0..1) in which the morph runs.
const PRESS_TO_WINDOW = { squash: [0.1, 0.9], 'squat-jump': [AJ_AIR_FROM, AJ_AIR_TO], burst: [0.2, 0.45] };

function alPressCtx(names) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  let cx = 0;
  let cy = 0;
  const all = [];
  for (const nm of names) {
    const S = iconToStrokes(nm);
    const c = alCoreCenter(S, S.tree || []);
    cx += c[0] / names.length;
    cy += c[1] / names.length;
    for (const st of S) {
      for (let k = 0; k < st.pts.length; k += 2) {
        all.push(st.pts[k], st.pts[k + 1]);
        x0 = Math.min(x0, st.pts[k]); x1 = Math.max(x1, st.pts[k]);
        y0 = Math.min(y0, st.pts[k + 1]); y1 = Math.max(y1, st.pts[k + 1]);
      }
    }
  }
  let R = 1e-6;
  const bx = (x0 + x1) / 2;
  const by = (y0 + y1) / 2;
  for (let k = 0; k < all.length; k += 2) R = Math.max(R, Math.hypot(all[k] - cx, all[k + 1] - cy));
  return { cx, cy, R, bx, by, bw: Math.max(1, x1 - x0), bh: Math.max(1, y1 - y0), baseY: y1 };
}

function planPressTo(name, to, opts) {
  // `opts.joinPlan`: the standalone press plan that runs now. The joined plan continues that press: its style, pivot and gain.
  const joined = opts.joinPlan && opts.joinPlan.pressInfo ? opts.joinPlan.pressInfo : null;
  const style = joined ? joined.style : isPressStyle(opts.style) ? resolvePress(opts.style) : 'squash';
  const key = 'p:' + style;
  const strength = Number.isFinite(opts.strength) && opts.strength > 0 ? opts.strength : STRENGTH_DEFAULT;
  const fromT = Number.isFinite(opts.fromT) ? alClamp(opts.fromT) : 0;
  // A joined plan morphs from the same stroke geometry as the press that runs (its chain knobs), not from those of this call.
  const joinGeo = opts.joinPlan && opts.joinPlan.geo ? opts.joinPlan.geo : {};
  const morph = planMorph(name, to, { easing: 'spring', ...opts, ...joinGeo, style: undefined, to: undefined, strength: undefined, fromT: undefined, joinPlan: undefined });
  const ctxC = alPressCtx([name, to]);
  const win = PRESS_TO_WINDOW[style] || [0.15, 0.7];
  // A press that joins one that runs starts from the context and the gain of that press (its pivot and size), so its first
  // frame is the picture on screen. Both blend to the context of the combined plan over the first part of the plan.
  let ctx0 = null;
  let gain0 = 1;
  if (fromT > 0) {
    try {
      // The running press if we know it; else rebuilt from the settings of this call (the same geometry knobs).
      const geo = {};
      for (const k of ['cornerAngle', 'chainGap', 'chainAngle']) if ((joinGeo[k] !== undefined ? joinGeo[k] : opts[k]) !== undefined) geo[k] = joinGeo[k] !== undefined ? joinGeo[k] : opts[k];
      const info = joined || planAlive(name, { ...geo, click: true, style, strength: opts.strength }).pressInfo;
      if (info) {
        ctx0 = info.ctx;
        gain0 = info.gain;
      }
    } catch (e) {
      ctx0 = null;
    }
  }
  const BLEND = 0.4;
  let speed = 1; // how fast the blend runs: raised only when the bound needs it (see the fit below). The first frame never changes.
  const ctxAt = (u) => {
    if (!ctx0) return ctxC;
    const e = alSmooth((u * speed) / BLEND);
    const out = {};
    for (const k of Object.keys(ctxC)) out[k] = typeof ctxC[k] === 'number' && typeof ctx0[k] === 'number' ? ctx0[k] + (ctxC[k] - ctx0[k]) * e : ctxC[k];
    return out;
  };
  const gainAt = (u, g) => (ctx0 ? gain0 + (g - gain0) * alSmooth((u * speed) / BLEND) : g);
  // A press that is almost over (late) has no room for the morph window of its style: the morph then plays over the whole plan.
  const late = fromT > 0.7;
  const ws = late ? fromT : Math.max(win[0], fromT);
  const we = late ? 1 : Math.min(1, Math.max(win[1], ws + 0.25));
  // u: the plan time 0..1. The press time runs from fromT to 1. The morph time is its window.
  const pressT = (u) => fromT + (1 - fromT) * u;
  const morphT = (t, u) => (late ? alClamp(u) : alClamp((t - ws) / (we - ws)));
  const dOf = (P) => alD(P);
  // One preparation for frame() and snapshot(): a warp that is not affine bends a long straight piece, so it is densified first.
  const prepPiece = (P) => (AFFINE_STYLES.has(key) ? P : alDensify(P));
  // A morph path can hold several pieces (M x y x y ... M x y ...): each piece is warped alone.
  const warpD = (d, t, g, c) =>
    d
      .split('M')
      .filter((seg) => seg.trim())
      .map((seg) => {
        const P = Float64Array.from(alNums(seg));
        // a warp that is not affine bends a long straight piece: densify it, as the standalone press does
        return dOf(alWarp(key, c, prepPiece(P), t, g));
      })
      .join('');
  // The press that runs draws a chained stroke as one polyline, bridge lines included (its plan is built from the chained strokes),
  // while the morph draws the strokes apart. A press that joins it starts from the same picture: the bridge lines of the old icon
  // are drawn at the join and retract into the stroke over the first BRIDGE_OUT of the plan, then the strokes are apart as in the morph.
  const BRIDGE_OUT = 0.15;
  const bridges = [];
  if (fromT > 0) {
    try {
      const g0 = { ...DEFAULTS, ...opts, ...joinGeo };
      const SS = iconToStrokes(name, g0.cornerAngle, g0.chainGap, g0.chainAngle);
      for (const st of SS) {
        if (!st.vis || st.bridges <= 0) continue;
        const P = st.pts;
        const np = P.length / 2;
        const at = (k) => [P[2 * (k % np)], P[2 * (k % np) + 1]];
        let run = null;
        for (let k = 0; k < st.vis.length; k++) {
          if (!st.vis[k]) {
            if (!run) run = [...at(k)];
            run.push(...at(k + 1));
          } else if (run) {
            bridges.push({ P: Float64Array.from(run), opacity: st.opacity, sw: st.sw });
            run = null;
          }
        }
        if (run) bridges.push({ P: Float64Array.from(run), opacity: st.opacity, sw: st.sw });
      }
    } catch (e) {
      bridges.length = 0;
    }
  }
  // One geometry for frame() and snapshot(): the bridge pieces at plan time u, warped like the rest of the picture.
  const bridgePieces = (u, t, c, gg) => {
    if (!bridges.length || u >= BRIDGE_OUT) return [];
    const keep = 1 - alSmooth(u / BRIDGE_OUT);
    const out = [];
    for (const B of bridges) {
      const piece = keep < 1 ? alTrim(B.P, keep) : B.P;
      if (piece.length >= 4) out.push({ points: alWarp(key, c, prepPiece(piece), t, gg), opacity: Number.isFinite(B.opacity) ? B.opacity : 1, sw: B.sw });
    }
    return out;
  };
  const frameAt = (u, g) => {
    const t = pressT(u);
    const entries = morph.frame(morphT(t, u));
    const c = ctxAt(u);
    const gg = gainAt(u, g);
    const res = [];
    for (const e of entries) {
      if (!e.d || e.d === 'M') continue;
      res.push({ ...e, d: warpD(e.d, t, gg, c) });
    }
    // each bridge is its own entry with the opacity and the own width of the stroke it belongs to
    bridgePieces(u, t, c, gg).forEach((B, k) => {
      const e = { d: dOf(B.points), opacity: B.opacity, widthScale: 1, key: 100000 + k, slot: res.length ? res[0].slot : 0, depth: res.length ? res[0].depth || 0 : 0, occluder: false };
      if (B.sw > 0) e.strokeWidth = B.sw;
      res.push(e);
    });
    return res;
  };
  // R15-5: the largest gain that keeps the combined frames inside the bound.
  const limit = ALIVE_BOUND - RIG_FIT_MARGIN; // the morph and the press peak at different times, so keep room between samples
  const outside = (u, g) => {
    let w = 0;
    for (const e of frameAt(u, g)) for (const v of alNums(e.d)) w = Math.max(w, -v, v - 24);
    return w;
  };
  // 99 samples, then the three highest are searched more finely: the morph and the press can peak together in a very short time.
  const worst = (g) => {
    const vals = [];
    for (let q = 1; q < 100; q++) vals.push([outside(q / 100, g), q]);
    let w = 0;
    for (const [v] of vals) w = Math.max(w, v);
    const top = vals.slice().sort((x, y) => y[0] - x[0]).filter((x, i, arr) => arr.slice(0, i).every((y) => Math.abs(y[1] - x[1]) > 1)).slice(0, 3);
    for (const [, q] of top) for (let k = -9; k <= 9; k++) w = Math.max(w, outside(Math.min(0.9999, Math.max(0.0001, (q + k * 0.1) / 100)), g));
    return w;
  };
  let gain = strength;
  if (worst(gain) > limit) {
    let lo = 0;
    let hi = gain;
    for (let it = 0; it < 6; it++) {
      const mid = (lo + hi) / 2;
      if (worst(mid) <= limit) lo = mid;
      else hi = mid;
    }
    gain = lo;
  }
  const hard = ALIVE_BOUND - STYLE_FIT_MARGIN; // the limit the standalone press is fitted to
  if (ctx0 && worst(gain) > hard + 1e-9) {
    // The running press is big and the combined picture leaves the bound while the blend runs: blend faster. The first frame stays the picture on screen.
    for (const sp of [1.5, 2, 3, 5, 8, 16]) {
      speed = sp;
      if (worst(gain) <= hard + 1e-9) break;
    }
  }
  const plan = Object.create(morph);
  plan.kind = 'press-to';
  plan.pressWindow = late ? { ws: 0, we: 1, fromT } : { ws, we, fromT }; // the part of the plan before ws shows the old icon, after we the new icon (late: the morph runs over the whole plan)
  plan.frame = (u) => {
    u = alClamp(u);
    if (u >= 1) return morph.frame(1);
    if (u <= 0 && fromT === 0) return morph.frame(0);
    return frameAt(u, gain);
  };
  plan.snapshot = (u) => {
    u = alClamp(u);
    const t = pressT(u);
    const snap = morph.snapshot(morphT(t, u));
    const c = ctxAt(u);
    const gg = gainAt(u, gain);
    const loops = snap.loops.map((L) => {
      if (u >= 1) return L;
      if (AFFINE_STYLES.has(key)) return { ...L, points: alWarp(key, c, L.points, t, gg) };
      const D = alDensifyVis(L.points, L.vis);
      return { ...L, points: alWarp(key, c, D.points, t, gg), vis: D.vis };
    });
    for (const B of bridgePieces(u, t, c, gg)) {
      const lp = { points: B.points, opacity: B.opacity, widthScale: 1, vis: new Uint8Array(B.points.length / 2 - 1).fill(1) };
      if (B.sw > 0) lp.strokeWidth = B.sw;
      loops.push(lp);
    }
    return { ...snap, loops };
  };
  return plan;
}

/**
 * A press plan. Same as `planAlive(name, { style })` with a press style (`PRESS_STYLES`). Default style: pop.
 * With `to` (another icon name) the icon morphs from `name` to `to` inside the press (see above); `fromT` (0 to 1) starts
 * the press at that phase, for a name change during a press that is already running.
 * @param {string|Array} name
 * @param {Object} [opts] `style`, `to`, `fromT`, `strength` (default 1.5), and the core knobs.
 */
export function planPress(name, opts = {}) {
  if (typeof opts.to === 'string' && opts.to && opts.to !== name) return planPressTo(name, opts.to, opts);
  return planAlive(name, { ...opts, click: true, style: isPressStyle(opts.style) ? resolvePress(opts.style) : 'pop' });
}

/**
 * R15-1/R15-2: a one-shot "alive" plan for hover. The plan draws the icon at frame(0) and frame(1) exactly and a
 * short life wiggle in between. It never changes the icon.
 * - radiate: alike parts around a center pulse out one by one; the core turns a little.
 * - ripple: open arcs sharing a center shrink to their midpoint and grow back, inner arc first.
 * - swing: a body with a long part at one end swings like a pendulum on a spring.
 * - pop (fallback): the whole icon dips, springs, and tilts.
 * @param {string|Array} name An icon name or an icon node.
 * @param {Object} [opts] Core knobs (`cornerAngle`, `chainGap`, `chainAngle`) are honored. `style`: one of `HOVER_STYLES` to use that hover style instead of the rig-picked wiggle (deprecated).
 * @returns {{kind: string, frame: Function, snapshot: Function, slots: Array, occludes: Function, occlusion: string, turn: number, duration: number, strokeWidth: number, linecap: string, linejoin: string}}
 */
export function planAlive(name, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const S = iconToStrokes(name, o.cornerAngle, o.chainGap, o.chainAngle);
  if (!S || !S.length) throw new Error('planAlive: no strokes for the icon.');
  const T = S.tree || [];
  const style = opts.click === true ? (isPressStyle(opts.style) ? 'p:' + resolvePress(opts.style) : null) : PLAN_HOVER.includes(resolveHover(opts.style)) ? resolveHover(opts.style) : null;
  const strength = Number.isFinite(opts.strength) && opts.strength > 0 ? opts.strength : STRENGTH_DEFAULT;
  let Wf = () => 1;
  let denseOf = null;
  let liveInfo = null;
  let pressInfo = null;
  if (!style) warnWiggle(); // the effective style is the deprecated wiggle: an explicit 'wiggle' or 'alive', or no style at all (the default)
  const kind = style ? { kind: style } : classifyAlive(S, T);

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
  if (style) {
    const sx = style === 'move' ? alMoveX(S, T, RP, strength, opts) : alStyleX(style, S, T, RP, strength, opts);
    liveInfo = sx.live || null;
    pressInfo = sx.info || null;
    X = sx.X;
    Wf = sx.W;
    denseOf = sx.dense;
  } else if (kind.kind === 'radiate') {
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

  if (!style && Math.abs(strength - 1) > 1e-9) {
    // wiggle: the strength scales how far each point goes from its rest place; the bound still holds.
    const X0 = X;
    const wob = (g) => (i, t) => {
      const P = X0(i, t);
      if (t <= 0 || t >= 1) return P;
      const out = new Float64Array(P.length);
      for (let k = 0; k < P.length; k++) out[k] = RP[i][k] + g * (P[k] - RP[i][k]);
      return out;
    };
    const limit = ALIVE_BOUND - STYLE_FIT_MARGIN;
    const worst = (g) => {
      const f = wob(g);
      let w = 0;
      for (let q = 1; q < STYLE_FIT_TIMES; q++) for (let i = 0; i < S.length; i++) for (const v of f(i, q / STYLE_FIT_TIMES)) w = Math.max(w, -v, v - 24);
      return w;
    };
    let g = strength;
    if (worst(g) > limit) {
      let lo = 0;
      let hi = g;
      for (let it = 0; it < 8; it++) {
        const mid = (lo + hi) / 2;
        if (worst(mid) <= limit) lo = mid;
        else hi = mid;
      }
      g = lo;
    }
    X = wob(g);
  }
  const plan = alPlanObject({ slots, n: S.length, strokeWidth: alStrokeWidth(name), kind: kind.kind, X, Wf });
  plan.live = liveInfo;
  plan.geo = { cornerAngle: o.cornerAngle, chainGap: o.chainGap, chainAngle: o.chainAngle }; // the geometry knobs the plan was built with: a press that joins it uses them
  plan.pressInfo = pressInfo && style ? { ...pressInfo, style: style.replace(/^p:/, '') } : pressInfo; // the warp context, the fitted gain and the style of a press: a press that joins this one starts from them
  if (style && denseOf) {
    // Interruptible: `retargetPlan` can start from any frame of this plan.
    plan.dense = denseOf;
    plan.rest = (i) => RP[i];
  }
  return plan;
}
