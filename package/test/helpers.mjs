// Shared helpers for the tests. Loads the package source and the Lucide data from the package folder only.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as m from '../index.js';

export const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
export const nodes = JSON.parse(readFileSync(join(PKG, 'data', 'lucide-nodes.json'), 'utf8'));
m.registerIcons(nodes);
export { m };
export const names = Object.keys(nodes).sort();

// A small seeded random generator (mulberry32), so a failure can be repeated.
export function rng(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomPairs(n, seed) {
  const r = rng(seed);
  const out = [];
  while (out.length < n) {
    const a = names[Math.floor(r() * names.length)];
    const b = names[Math.floor(r() * names.length)];
    if (a !== b) out.push([a, b]);
  }
  return out;
}

// The numbers of the "d" attribute of a frame entry, as an array of [x, y] points.
export function entryPoints(e) {
  const v = e.d.match(/-?\d*\.?\d+(?:e-?\d+)?/gi).map(Number);
  const pts = [];
  for (let i = 0; i + 1 < v.length; i += 2) pts.push([v[i], v[i + 1]]);
  return pts;
}

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Distance from a point to a set of polylines (arrays of [x, y]).
export function distToLines(p, lines) {
  let best = Infinity;
  for (const L of lines) {
    if (L.length === 1) best = Math.min(best, Math.hypot(p[0] - L[0][0], p[1] - L[0][1]));
    for (let i = 0; i + 1 < L.length; i++) best = Math.min(best, segDist(p[0], p[1], L[i][0], L[i][1], L[i + 1][0], L[i + 1][1]));
  }
  return best;
}

// The rest form of a stroke icon, as polylines.
export function restLines(name) {
  return m.iconToStrokes(name).map((s) => {
    const pts = [];
    for (let i = 0; i + 1 < s.pts.length; i += 2) pts.push([s.pts[i], s.pts[i + 1]]);
    return pts;
  });
}

function lineLength(L) {
  let n = 0;
  for (let i = 0; i + 1 < L.length; i++) n += Math.hypot(L[i + 1][0] - L[i][0], L[i + 1][1] - L[i][1]);
  return n;
}

// The visible polylines of a frame. A piece shorter than minLength (a part that has not grown yet) is left out.
export function frameLines(frame, minLength = 0) {
  return frame.filter((e) => e.opacity > 0).map(entryPoints).filter((L) => lineLength(L) >= minLength);
}

// Largest distance from the points of A to the lines of B.
export function oneWay(linesA, linesB) {
  let worst = 0;
  for (const L of linesA) for (const p of L) worst = Math.max(worst, distToLines(p, linesB));
  return worst;
}
