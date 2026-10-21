// Morphicon regions (round 7, R7-B): the fill planner. Fill icons (Phosphor, Remix, Tabler filled) are 2D shapes.
// The unit of motion is a region (an outer contour plus its holes), not a stroke. No DOM. Round 7b: it imports
// resampleLoop (corners kept), makeRigidBlend, and parseContours from core.js (core.js does not import this file).
//
// Plan API (same as a core plan): frame(t), snapshot(t), slots, occludes, turn, plus `fill: true`, `occlusion: 'none'`,
// and `strokeWidth: 0`. A frame entry is { d, opacity (the layer opacity), widthScale: 1, key, slot, depth, occluder: false,
// fill: true, region: true, layer }. One entry per region per frame (the outer contour and its holes in one `d`).
// The `region: true` mark tells render.js a region entry (fill only) from a styled stroke entry (`fill: true` with a stroke).

import { resampleLoop, makeRigidBlend, parseContours } from './core.js';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

/** Knobs of the fill planner. Any key of `opts` replaces the default. */
export const FILL_DEFAULTS = Object.freeze({
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
export function setIconResolver(fn) {
  resolver = typeof fn === 'function' ? fn : null;
}

// ---------------------------------------------------------------------------
// Path parser: d string to flat closed polylines, scaled into the 24 grid
// ---------------------------------------------------------------------------

const NUMRE = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y;

/** Parse a path `d` into subpaths: arrays of x, y numbers (24-grid units, `scale` applied). Every subpath is treated as closed. */
export function parsePath(d, scale = 1) {
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
export function regionsOf(src) {
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
export function planFill(from, to, opts = {}) {
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
export function planFillEffect(src, direction, effect = 'implode', opts = {}) {
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
