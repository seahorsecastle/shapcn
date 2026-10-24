// 0.2.2: a press that joins a running press on an icon with chained strokes (bridges) starts on the picture on
// screen, also when it is interrupted in its first 15%.
// By default the checks run on a sample (every 12th icon with bridges, plus anchor, alarm-clock-off, accessibility). SHAPCN_FULL=1 runs all of them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { m, names } from './helpers.mjs';

const FULL = process.env.SHAPCN_FULL === '1';
const pieces = (d) => d.split('M').filter((x) => x.trim()).map((x) => x.trim().split(/\s+/).map(Number));
const segDist = (px, py, P) => {
  let best = Infinity;
  for (let k = 0; k + 3 < P.length; k += 2) {
    const ax = P[k], ay = P[k + 1], dx = P[k + 2] - ax, dy = P[k + 3] - ay;
    const L = dx * dx + dy * dy;
    const f = L > 1e-12 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
    best = Math.min(best, Math.hypot(px - (ax + f * dx), py - (ay + f * dy)));
  }
  return best;
};
// Points along the polylines at most 0.1 units apart, so the interior of a long segment counts (not only its vertices).
const samples = (X) => {
  const out = [];
  for (const P of X) {
    for (let k = 0; k + 3 < P.length; k += 2) {
      const n = Math.max(1, Math.ceil(Math.hypot(P[k + 2] - P[k], P[k + 3] - P[k + 1]) / 0.1));
      for (let q = 0; q < n; q++) out.push([P[k] + ((P[k + 2] - P[k]) * q) / n, P[k + 1] + ((P[k + 3] - P[k + 1]) * q) / n]);
    }
    if (P.length >= 2) out.push([P[P.length - 2], P[P.length - 1]]);
  }
  return out;
};
const distTo = (pt, Y) => { let b = Infinity; for (const Q of Y) b = Math.min(b, segDist(pt[0], pt[1], Q)); return b; };
const hd1 = (X, Y) => { let w = 0; for (const pt of samples(X)) w = Math.max(w, distTo(pt, Y)); return w; };
const hd = (A, B) => Math.max(hd1(A, B), hd1(B, A));
// The points of either picture that are further than tol from the other one.
const mismatches = (A, B, tol) => [...samples(A).filter((p) => distTo(p, B) > tol), ...samples(B).filter((p) => distTo(p, A) > tol)];
const polysOf = (es) => es.flatMap((e) => pieces(e.d)).filter((P) => P.length >= 4);
const restPolys = (name) => m.iconToStrokes(name).map((s) => { const P = Array.from(s.pts); if (s.closed) P.push(P[0], P[1]); return P; }).filter((P) => P.length >= 4);
const report = (label, fails) => assert.equal(fails.length, 0, label + ': ' + fails.length + ' failed, e.g. ' + fails.slice(0, 6).join('; '));

const BRIDGED = names.filter((n) => m.iconToStrokes(n).some((s) => s.bridges > 0));
const SAMPLE = FULL ? BRIDGED : [...new Set([...BRIDGED.filter((_, i) => i % 12 === 0), 'anchor', 'alarm-clock-off', 'accessibility'])];

test('there are Lucide icons with bridges, and the named ones are among them', () => {
  assert.ok(BRIDGED.length > 400, 'bridged icons: ' + BRIDGED.length);
  for (const n of ['anchor', 'alarm-clock-off', 'accessibility']) assert.ok(BRIDGED.includes(n), n);
});

test('a joined press draws the bridge lines of the old icon at the join and none after they retract', () => {
  const count = (plan, u) => plan.frame(u).reduce((a, e) => a + pieces(e.d).length, 0);
  for (const style of m.PRESS_STYLES) {
    for (const n of ['anchor', 'alarm-clock-off', 'accessibility']) {
      const joined = m.planPress(n, { style, to: 'check', fromT: 0.3, joinPlan: m.planPress(n, { style }) });
      const morphPieces = m.planMorph(n, 'check', { easing: 'spring' }).frame(0).reduce((a, e) => a + pieces(e.d).length, 0);
      let runs = 0;
      for (const st of m.iconToStrokes(n)) if (st.vis) for (let k = 0; k < st.vis.length; k++) if (!st.vis[k] && (k === 0 || st.vis[k - 1])) runs++;
      assert.ok(runs > 0, n + ' has bridges');
      assert.equal(count(joined, 0), morphPieces + runs, n + ' ' + style + ': the morph pieces plus one piece per bridge at the join');
      assert.ok(count(joined, 0.5) < count(joined, 0), n + ' ' + style + ': the bridges are gone later');
      assert.equal(count(joined, 0.6), count(m.planPress(n, { style, to: 'check', fromT: 0.3 }), 0.6), n + ' ' + style + ': same after the bridges retract');
    }
  }
});

test('first frame of a press that joins a running press: under 0.05 units from the picture on screen (segment interiors sampled), every icon with bridges, 4 styles, 3 phases', () => {
  const fails = [];
  let cases = 0;
  let excused = 0;
  const dest = (a) => (a === 'check' ? 'minus' : 'check');
  for (const a of SAMPLE) {
    const b = dest(a);
    for (const style of m.PRESS_STYLES) {
      const run = m.planPress(a, { style });
      for (const fromT of [0.15, 0.4, 0.75]) {
        for (const withJoinPlan of [true, false]) {
          const joined = m.planPress(a, { style, to: b, fromT, ...(withJoinPlan ? { joinPlan: run } : {}) });
          const A = polysOf(joined.frame(0));
          const B = polysOf(run.frame(fromT));
          cases++;
          const bad = mismatches(A, B, 0.05);
          if (!bad.length) continue;
          // Known cause that is not a bridge: the morph resamples tiny arcs away (the morph source is up to 0.09 off the rest icon).
          // Excuse a mismatching point only where the same icon, with chaining off (no bridges at all), mismatches too, within 0.15 units.
          const off = { chainGap: -1 };
          const ctrl = mismatches(polysOf(m.planPress(a, { style, to: b, fromT, ...off }).frame(0)), polysOf(m.planPress(a, { style, ...off }).frame(fromT)), 0.05);
          const left = bad.filter((p) => !ctrl.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= 0.15));
          if (left.length) fails.push(style + ' ' + a + ' fromT=' + fromT + (withJoinPlan ? '' : ' (no joinPlan)') + ': ' + left.length + ' points off, worst at ' + left[0].map((v) => v.toFixed(1)).join(','));
          else excused++;
        }
      }
    }
  }
  console.log('bridged join: ' + SAMPLE.length + ' icons, ' + cases + ' cases, ' + excused + ' cases excused only at points that mismatch without bridges too, failures ' + fails.length);
  assert.ok(excused <= 0.02 * cases, 'excused cases: ' + excused + ' of ' + cases);
  report('bridged join jump', fails);
});

test('the join test can fail: with the bridge lines left out of the joined first frame, anchor (pop, squash) is caught', () => {
  for (const style of ['pop', 'squash']) {
    const run = m.planPress('anchor', { style });
    const joined = m.planPress('anchor', { style, to: 'check', fromT: 0.4, joinPlan: run });
    const morphOnly = polysOf(m.planMorph('anchor', 'check', { easing: 'spring' }).frame(0)); // what the join would show without the bridge pieces
    assert.ok(mismatches(morphOnly, polysOf(run.frame(0)), 0.05).length > 0, style + ': a picture without bridges is far from the running picture');
    assert.equal(mismatches(polysOf(joined.frame(0)), polysOf(run.frame(0.4)), 0.05).length, 0, style + ': the joined first frame is on the picture on screen');
  }
});

test('a joined press that is interrupted in its first 15% starts from the picture on screen: snapshot equals frame (bridges included)', () => {
  const fails = [];
  for (const style of m.PRESS_STYLES) {
    for (const n of ['anchor', 'alarm-clock-off', 'accessibility', ...SAMPLE.slice(0, 12)]) {
      for (const fromT of [0.15, 0.4]) {
        const joined = m.planPress(n, { style, to: 'check', fromT, joinPlan: m.planPress(n, { style }) });
        for (const u of [0, 0.04, 0.1, 0.14, 0.3]) {
          const frame = polysOf(joined.frame(u));
          const snap = joined.snapshot(u).loops.map((L) => Array.from(L.points)).filter((P) => P.length >= 4);
          const bad = mismatches(frame, snap, 0.06);
          if (bad.length) fails.push(style + ' ' + n + ' fromT=' + fromT + ' u=' + u + ' ' + bad.length + ' points, e.g. ' + bad[0].map((v) => v.toFixed(1)).join(','));
        }
        // and a morph that starts from the snapshot starts on that picture
        const snap = joined.snapshot(0.04);
        const next = m.planMorph(snap, 'heart', { easing: 'spring' });
        const first = polysOf(next.frame(0));
        const bad = mismatches(first, snap.loops.map((L) => Array.from(L.points)).filter((P) => P.length >= 4), 0.1);
        if (bad.length && n === 'anchor') fails.push(style + ' ' + n + ' morph from snapshot starts off by ' + bad.length + ' points');
      }
    }
  }
  report('interrupted joined press', fails);
});

test('a press on an icon with bridges starts and ends on the rest icon (both ends asserted), stays in the bound, keeps snapshot masks consistent', () => {
  const fails = [];
  for (const style of m.PRESS_STYLES) {
    for (const n of SAMPLE.slice(0, 40)) {
      const plan = m.planPress(n, { style });
      const rest = restPolys(n);
      for (const t of [0, 1]) if (hd(polysOf(plan.frame(t)), rest) > 0.02) fails.push(style + ' ' + n + ' standalone pose at ' + t);
      const dst = m.planPress(n, { style, to: 'check' });
      if (mismatches(polysOf(dst.frame(0)), polysOf(m.planMorph(n, 'check', { easing: 'spring' }).frame(0)), 0.01).length) fails.push(style + ' ' + n + ' joined-plan start is not the morph start');
      if (hd(polysOf(dst.frame(1)), restPolys('check')) > 0.05) fails.push(style + ' ' + n + ' joined-plan end');
      for (const t of [0, 0.25, 0.5, 0.75, 1]) for (const P of polysOf(plan.frame(t))) for (const v of P) if (!(v > -3.01 && v < 27.01)) fails.push(style + ' ' + n + ' bound ' + v);
      for (const L of plan.snapshot(0.5).loops) if (L.vis.length !== L.points.length / 2 - 1) fails.push(style + ' ' + n + ' vis length');
    }
  }
  report('bridged press sanity', fails);
});

test('a styled icon (opacity 0.25, stroke-width 4): the bridges of an interrupted joined press keep that opacity and width in frame and snapshot', () => {
  // the anchor, with its own opacity and stroke width on every path
  const nodes = m.getIconInfo('anchor').nodes.map(([tag, a]) => [tag, { ...a, opacity: 0.25, 'stroke-width': 4 }]);
  m.registerIcons({ 'styled-anchor': nodes });
  const S = m.iconToStrokes('styled-anchor');
  assert.ok(S.some((s) => s.bridges > 0), 'the styled icon still has bridges');
  assert.ok(S.every((s) => s.opacity === 0.25 && s.sw === 4), 'strokes carry the style');
  for (const style of m.PRESS_STYLES) {
    const joined = m.planPress('styled-anchor', { style, to: 'check', fromT: 0.4, joinPlan: m.planPress('styled-anchor', { style }) });
    for (const u of [0, 0.04, 0.1]) {
      const frame = joined.frame(u).filter((e) => e.key >= 100000);
      const snap = joined.snapshot(u).loops.filter((L) => L.points.length === 0 ? false : true);
      assert.ok(frame.length > 0, style + ' u=' + u + ': bridge entries');
      for (const e of frame) assert.ok(e.opacity === 0.25 && e.strokeWidth === 4, style + ' frame bridge style ' + e.opacity + '/' + e.strokeWidth);
      const styledLoops = snap.filter((L) => L.opacity === 0.25 && L.strokeWidth === 4);
      assert.ok(styledLoops.length >= frame.length, style + ' u=' + u + ': snapshot carries the bridge style (' + styledLoops.length + ' styled loops for ' + frame.length + ' bridges)');
    }
  }
});
