// Hover and press styles (0.2.0). For every style: rest at both ends, the bound, joints that stay joined, no NaN,
// no fading, an unchanged stroke width, interruptible runs. Plus: bold holds, move settles, press that changes the icon.
//
// By default the checks run on a fixed sample of the Lucide icons (every 11th name plus 24 icons from real app UIs) so that
// `npm test` stays fast. SHAPCN_FULL=1 runs every icon (about 1,858; a few minutes):
//   SHAPCN_FULL=1 node --test test/hover-press.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { m, names, randomPairs, PKG } from './helpers.mjs';

const FULL = process.env.SHAPCN_FULL === '1';
const APP_ICONS = 'heart bookmark bell share send mail star play search settings trash user-plus circle-plus user-check mail-open sun moon upload copy menu eye phone archive repeat'.split(' ');
const ICONS = FULL ? names : [...new Set([...names.filter((_, i) => i % 11 === 0), ...APP_ICONS.filter((n) => names.includes(n))])];

const HOVER = m.HOVER_STYLES; // wiggle grow bend bold cascade move
const PRESS = m.PRESS_STYLES; // pop squash squat-jump burst
const BOUND = 3; // units outside the 24 box
const JOINT_TOL = 0.05; // a joined end stays within this of the stroke it touches
const ART_GAP_FACTOR = 2.5; // some icons have a gap of 0.02 to 0.05 units in their own art; that gap may grow to at most this many times its rest size (burst measures 2.1)
const ART_GAP_MAX = 0.1; // and never beyond this (0.4% of the icon)
const REST_TOL = 0.006; // d strings have 2 decimals

const parseD = (d) => d.slice(1).trim().split(/\s+/).map(Number);
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
const restOf = (name) => m.iconToStrokes(name).map((s) => {
  const P = Array.from(s.pts);
  if (s.closed && P.length >= 2) P.push(P[0], P[1]);
  return P;
});
const frameStrokes = (plan, t, n) => {
  const out = new Array(n).fill(null);
  for (const e of plan.frame(t)) out[e.slot] = parseD(e.d);
  return out;
};
const maxDiff = (A, B) => {
  let worst = 0;
  for (let i = 0; i < A.length; i++) {
    if (!A[i] || !B[i]) continue;
    if (A[i].length !== B[i].length) return Infinity;
    for (let k = 0; k < A[i].length; k++) worst = Math.max(worst, Math.abs(A[i][k] - B[i][k]));
  }
  return worst;
};
// The joints of an icon at rest: an end of stroke i within JOINT_TOL of stroke j. d0 is the gap at rest.
// A joint stays joined when its gap stays within JOINT_TOL, or within ART_GAP_FACTOR times the gap the art already had.
const stays = (gap, jt) => gap <= JOINT_TOL || gap <= Math.min(ART_GAP_MAX, jt.d0 * ART_GAP_FACTOR);
const jointsOf = (RP) => {
  const J = [];
  RP.forEach((P, i) => {
    if (P.length < 4) return;
    for (const [ex, ey, endIdx] of [[P[0], P[1], 0], [P[P.length - 2], P[P.length - 1], P.length - 2]]) {
      RP.forEach((Q, j) => { if (j !== i && Q.length >= 4) { const d0 = segDist(ex, ey, Q); if (d0 <= JOINT_TOL) J.push({ i, endIdx, j, d0 }); } });
    }
  });
  return J;
};
const report = (label, fails) => assert.equal(fails.length, 0, label + ': ' + fails.length + ' failed, e.g. ' + fails.slice(0, 6).join('; '));

const make = (kind, style, name, extra = {}) => (kind === 'hover' ? m.planAlive(name, { style, ...extra }) : m.planPress(name, { style, ...extra }));

for (const [kind, styles] of [['hover', HOVER], ['press', PRESS]]) {
  for (const style of styles) {
    test(kind + ':' + style + ' rests at both ends, stays in the bound, keeps joints, never fades (' + ICONS.length + ' icons)', () => {
      const fails = [];
      for (const name of ICONS) {
        const why = [];
        const RP = restOf(name);
        const n = RP.length;
        const plan = make(kind, style, name);
        const base = m.planAlive(name, {});
        if (plan.strokeWidth !== base.strokeWidth) why.push('strokeWidth');
        for (const t of [0, 1]) {
          if (plan.frame(t).some((e) => e.widthScale !== 1)) why.push('width@' + t);
          const F = frameStrokes(plan, t, n);
          for (let i = 0; i < n; i++) {
            if (RP[i].length < 4) continue;
            if (!F[i] || F[i].length !== RP[i].length || F[i].some((v, k) => !(Math.abs(v - RP[i][k]) <= REST_TOL))) { why.push('rest' + t); break; }
          }
        }
        let worst = 0;
        for (let s = 0; s <= 100; s++) {
          for (const e of plan.frame(s / 100)) {
            if (e.opacity !== 1) why.push('opacity');
            const isBold = style === 'bold';
            if (isBold ? !(e.widthScale >= 0.5 && e.widthScale <= 1.9) : e.widthScale !== 1) why.push('widthScale');
            for (const v of parseD(e.d)) {
              if (!Number.isFinite(v)) why.push('nan');
              worst = Math.max(worst, -v, v - 24);
            }
          }
        }
        if (worst > BOUND + 1e-9) why.push('bound ' + worst.toFixed(2));
        // joints. cascade draws strokes in order. The wiggle of a ripple icon (arcs that shrink about their middle) and of a few
        // radiate icons (a spoke that touches a stroke it does not belong to, for example expand, flower, life-buoy, ship-wheel)
        // opens joints. That is the motion of 0.1.0 (round 15), unchanged. So wiggle is checked for joints on pop and swing icons only.
        if (style !== 'cascade' && !(style === 'wiggle' && (plan.kind === 'ripple' || plan.kind === 'radiate'))) {
          const J = jointsOf(RP);
          for (let s = 1; s <= 20 && J.length; s++) {
            const F = frameStrokes(plan, s / 21, n);
            for (const jt of J) {
              const a = F[jt.i], b = F[jt.j];
              if (!a || !b) continue;
              if (!stays(segDist(a[jt.endIdx === 0 ? 0 : a.length - 2], a[jt.endIdx === 0 ? 1 : a.length - 1], b), jt)) { why.push('joint'); break; }
            }
          }
        }
        if (why.length) fails.push(name + ' [' + [...new Set(why)].join(',') + ']');
      }
      report(kind + ':' + style, fails);
    });

    test(kind + ':' + style + ' keeps the bound and the ends at strength 0.5 and 3 (slider range)', () => {
      const fails = [];
      for (const name of ICONS.filter((_, i) => i % 3 === 0)) {
        const RP = restOf(name);
        for (const strength of [0.5, 3]) {
          const plan = make(kind, style, name, { strength });
          const why = [];
          let worst = 0;
          for (let s = 0; s <= 60; s++) for (const e of plan.frame(s / 60)) for (const v of parseD(e.d)) { if (!Number.isFinite(v)) why.push('nan'); worst = Math.max(worst, -v, v - 24); }
          if (worst > BOUND + 1e-9) why.push('bound ' + worst.toFixed(2));
          for (const t of [0, 1]) if (maxDiff(frameStrokes(plan, t, RP.length), RP.map((P) => (P.length < 4 ? null : P))) > REST_TOL) why.push('rest' + t);
          if (why.length) fails.push(name + '@' + strength + ' [' + [...new Set(why)].join(',') + ']');
        }
      }
      report(kind + ':' + style + ' strength', fails);
    });

    // wiggle (the rig-picked move of 0.1.0) and cascade (it trims strokes) have no dense plan: they finish their short run.
    if (style === 'wiggle' || style === 'cascade') {
      test(kind + ':' + style + ' finishes its run (it is not interruptible, by design)', () => {
        const fails = [];
        for (const name of ICONS) {
          const src = make(kind, style, name);
          if (src.dense) fails.push(name + ' has a dense plan');
          if (m.retargetPlan(src, 0.3, true) !== null) fails.push(name + ' retargets');
        }
        report(kind + ':' + style + ' not interruptible', fails);
      });
    } else {
      test(kind + ':' + style + ' is interruptible (retarget at t=0.3 to rest and forward)', () => {
        const fails = [];
        for (const name of ICONS) {
          const why = [];
          const n = m.iconToStrokes(name).length;
          const src = make(kind, style, name);
          if (!src.dense) { why.push('noDense'); fails.push(name + ' [noDense]'); continue; }
          const rest = frameStrokes(m.planAlive(name, {}), 1, n);
          for (const toRest of [true, false]) {
            const rt = m.retargetPlan(src, 0.3, toRest);
            if (!(maxDiff(frameStrokes(rt, 0, n), frameStrokes(src, 0.3, n)) <= 0.02)) why.push('jump' + (toRest ? 'Rest' : 'Fwd'));
            if (!(maxDiff(frameStrokes(rt, 1, n), toRest ? rest : frameStrokes(src, 1, n)) <= REST_TOL)) why.push('end' + (toRest ? 'Rest' : 'Fwd'));
            let worst = 0;
            for (let k = 0; k <= 40; k++) for (const e of rt.frame(k / 40)) for (const v of parseD(e.d)) { if (!Number.isFinite(v)) why.push('nan'); worst = Math.max(worst, -v, v - 24); }
            if (worst > BOUND + 1e-9) why.push('bound');
          }
          if (why.length) fails.push(name + ' [' + [...new Set(why)].join(',') + ']');
        }
        report(kind + ':' + style + ' retarget', fails);
      });
    }
  }
}

test('defaults: wiggle is alive at 600 ms, grow 400, bend 400, bold 250, cascade 500, move 900; press 300/300/500/500', () => {
  assert.deepEqual(['wiggle', 'alive', 'grow', 'bend', 'bold', 'cascade', 'move'].map(m.hoverMs), [600, 600, 400, 400, 250, 500, 900]);
  assert.deepEqual(['pop', 'squash', 'squat-jump', 'anticipate-jump', 'burst'].map(m.pressMs), [300, 300, 500, 500, 500]);
  assert.deepEqual([...m.HOVER_STYLES], ['wiggle', 'grow', 'bend', 'bold', 'cascade', 'move']);
  assert.deepEqual([...m.PRESS_STYLES], ['pop', 'squash', 'squat-jump', 'burst']);
});

test('aliases: wiggle equals alive, anticipate-jump equals squat-jump; the default strength is 1.5', () => {
  for (const name of ['heart', 'bell', 'sun', 'trash']) {
    const a = JSON.stringify(m.planAlive(name, { style: 'wiggle' }).frame(0.4));
    assert.equal(JSON.stringify(m.planAlive(name, { style: 'alive' }).frame(0.4)), a, name + ' alive');
    assert.equal(JSON.stringify(m.planAlive(name, {}).frame(0.4)), a, name + ' no style');
    assert.equal(JSON.stringify(m.planAlive(name, { style: 'wiggle', strength: 1.5 }).frame(0.4)), a, name + ' strength 1.5');
    const p = JSON.stringify(m.planPress(name, { style: 'squat-jump' }).frame(0.5));
    assert.equal(JSON.stringify(m.planPress(name, { style: 'anticipate-jump' }).frame(0.5)), p, name + ' anticipate-jump');
    for (const st of ['grow', 'burst']) {
      const g = JSON.stringify((st === 'grow' ? m.planAlive(name, { style: 'grow' }) : m.planPress(name, { style: 'burst' })).frame(0.35));
      const h = JSON.stringify((st === 'grow' ? m.planAlive(name, { style: 'grow', strength: 1.5 }) : m.planPress(name, { style: 'burst', strength: 1.5 })).frame(0.35));
      assert.equal(g, h, name + ' ' + st + ' default strength');
    }
  }
  // a stronger style moves farther than a weaker one
  const reach = (st) => {
    let lo = Infinity, hi = -Infinity;
    for (const e of m.planAlive('star', { style: 'grow', strength: st }).frame(0.15)) for (const v of parseD(e.d)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    return hi - lo;
  };
  assert.ok(reach(1.5) > reach(0.5) && reach(3) >= reach(1.5), 'strength scales the motion: ' + [0.5, 1.5, 3].map(reach).join(' '));
});

test('hover:bold holds while hovered and goes back from where it is on leave (' + ICONS.length + ' icons)', () => {
  const fails = [];
  const peakOf = (strength) => Math.min(1.8, 1 + 0.35 * strength);
  for (const name of ICONS) {
    const why = [];
    const down = m.planAlive(name, { style: 'bold', phase: 'down' });
    const ws = (plan, t) => plan.frame(t).map((e) => e.widthScale);
    if (!ws(down, 0).every((w) => w === 1)) why.push('startNotRest');
    const held = ws(down, 1);
    if (!held.every((w) => Math.abs(w - held[0]) < 1e-9) || Math.abs(held[0] - peakOf(1.5)) > 1e-6) why.push('heldNotConstant');
    if (Math.abs(ws(down, 0.999)[0] - held[0]) > 0.01) why.push('drift');
    for (const t0 of [1, 0.2]) {
      const rt = m.retargetPlan(down, t0, true);
      if (Math.abs(ws(rt, 0)[0] - ws(down, t0)[0]) > 1e-9) why.push('jump' + t0);
      if (!ws(rt, 1).every((w) => w === 1)) why.push('endNotRest');
      if (rt.frame(0.5).map((e) => e.d).join('|') !== down.frame(0.5).map((e) => e.d).join('|')) why.push('geometry');
    }
    const back = m.retargetPlan(down, 1, true);
    const fwd = m.retargetPlan(back, 0.3, false);
    if (Math.abs(ws(fwd, 0)[0] - ws(back, 0.3)[0]) > 1e-9) why.push('reenterJump');
    if (Math.abs(ws(fwd, 1)[0] - held[0]) > 1e-9) why.push('reenterEnd');
    if (why.length) fails.push(name + ' [' + [...new Set(why)].join(',') + ']');
  }
  report('bold hold', fails);
});

test('hover:move settles in under 1.3 s after a 2 s pointer path (' + ICONS.length + ' icons, four paths), stays in the bound and keeps joints', () => {
  const fails = [];
  const paths = {
    slow: (t) => 0.25 * Math.sin(Math.PI * t),
    fast: () => 1,
    backforth: (t) => (Math.sin(2 * Math.PI * 3 * t) >= 0 ? 1 : -1),
    resonant: (t) => Math.sin(2 * Math.PI * 2.2 * t),
  };
  let slowest = 0;
  for (const name of ICONS) {
    const why = [];
    const RP = restOf(name);
    const n = RP.length;
    const J = jointsOf(RP);
    for (const [pn, fn] of Object.entries(paths)) {
      const sw = m.createSway(name);
      let tm = 0;
      sw.frame(0);
      sw.push(fn(0));
      const check = (E) => {
        const F = new Array(n).fill(null);
        for (const e of E) {
          F[e.slot] = parseD(e.d);
          if (e.opacity !== 1 || e.widthScale !== 1) why.push('attr');
          for (const v of F[e.slot]) {
            if (!Number.isFinite(v)) why.push('nan');
            else if (-v > BOUND || v - 24 > BOUND) why.push('bound');
          }
        }
        for (const jt of J) {
          const a = F[jt.i], b = F[jt.j];
          if (a && b && !stays(segDist(a[jt.endIdx === 0 ? 0 : a.length - 2], a[jt.endIdx === 0 ? 1 : a.length - 1], b), jt)) { why.push('joint'); break; }
        }
      };
      for (let k = 0; k * (1000 / 60) <= 2000; k++) {
        tm = k * (1000 / 60);
        sw.setInput(fn(tm / 1000), 0);
        const E = sw.frame(tm);
        if (k % 3 === 0) check(E);
      }
      sw.release();
      let back = 0;
      while (!sw.atRest && back < 3000) {
        back += 1000 / 60;
        const E = sw.frame(tm + back);
        if (Math.round(back) % 4 === 0) check(E);
      }
      slowest = Math.max(slowest, back);
      if (back > 1300) why.push('slow:' + pn + ':' + Math.round(back));
      // the rest strokes are the true rest icon (the swap to the rest icon must not pop)
      if (pn === 'slow') {
        for (const e of sw.rest()) {
          const P = parseD(e.d);
          if (P.length !== RP[e.slot].length || P.some((v, k) => Math.abs(v - RP[e.slot][k]) > REST_TOL)) { why.push('restNotTrue'); break; }
        }
      }
    }
    if (why.length) fails.push(name + ' [' + [...new Set(why)].join(',') + ']');
  }
  report('move', fails);
  assert.ok(slowest <= 1300, 'slowest settle ' + Math.round(slowest) + ' ms');
});

// ---- a press that changes the icon: the 24 real pairs of the "Click and change" step, plus random pairs ----
const REAL_PAIRS = 'circle-plus>circle-check user-plus>user-check bookmark>bookmark-check mail>mail-open sun>moon bell>bell-off captions-off>captions upload>loader loader>check copy>check share>check menu>x map>list eye>eye-off phone>phone-call heart-plus>heart arrow-up>check archive>check send>check shopping-cart-plus>circle-check list-plus>list-checks shield-plus>shield-check volume-2>volume-x repeat>repeat-1'.split(' ').map((p) => p.split('>'));
const PAIRS = [...REAL_PAIRS, ...randomPairs(FULL ? 300 : 30, 12345)];
const hd = (A, B) => {
  let worst = 0;
  for (const [X, Y] of [[A, B], [B, A]]) for (const P of X) for (let k = 0; k < P.length; k += 2) { let best = Infinity; for (const Q of Y) best = Math.min(best, segDist(P[k], P[k + 1], Q)); worst = Math.max(worst, best); }
  return worst;
};
const polysOf = (entries) => entries.flatMap((e) => pieces(e.d)).filter((P) => P.length >= 4);
const restPolys = (name) => restOf(name).filter((P) => P.length >= 4);

test('there are 24 real pairs and every icon of them exists', () => {
  assert.equal(REAL_PAIRS.length, 24);
  for (const [a, b] of REAL_PAIRS) assert.ok(names.includes(a) && names.includes(b), a + '>' + b);
});

for (const style of PRESS) {
  test('press:' + style + ' with a new icon: the 24 real pairs and ' + (PAIRS.length - 24) + ' random pairs start on the old icon, end on the new one, keep the bound and the joints', () => {
    const fails = [];
    for (const [a, b] of PAIRS) {
      const why = [];
      const plan = m.planPress(a, { style, to: b });
      if (hd(polysOf(plan.frame(0)), restPolys(a)) > 0.05) why.push('start');
      if (hd(polysOf(plan.frame(1)), restPolys(b)) > 0.05) why.push('end');
      let worst = 0;
      for (let q = 0; q <= 100; q++) {
        for (const e of plan.frame(q / 100)) {
          if (e.opacity !== 1) why.push('opacity');
          if (/[A-LN-Za-z]/.test(e.d)) why.push('path');
          for (const v of e.d.replace(/M/g, ' ').trim().split(/\s+/).map(Number)) {
            if (!Number.isFinite(v)) why.push('nan');
            worst = Math.max(worst, -v, v - 24);
          }
        }
      }
      if (worst > BOUND + 1e-9) why.push('bound ' + worst.toFixed(2));
      // before the morph starts the frames show the old icon, after it ends the new icon: their joints stay joined
      const { ws, we } = plan.pressWindow;
      for (const [u0, u1, ref] of [[0.02, ws - 0.01, 0], [we + 0.01, 0.98, 1]]) {
        if (!(u1 > u0)) continue;
        const F0 = plan.frame(ref).flatMap((e) => pieces(e.d));
        const J = jointsOf(F0);
        for (let q = 0; q < 6; q++) {
          const F = plan.frame(u0 + ((u1 - u0) * q) / 5).flatMap((e) => pieces(e.d));
          for (const jt of J) {
            const A = F[jt.i], B = F[jt.j];
            if (A && B && A.length >= 4 && !stays(segDist(A[jt.endIdx ? A.length - 2 : 0], A[jt.endIdx ? A.length - 1 : 1], B), jt)) { why.push('joint'); break; }
          }
        }
      }
      // a name change in the middle of a running press: the combined plan starts at that phase and ends on the new icon
      const mid = m.planPress(a, { style, to: b, fromT: 0.3 });
      if (hd(polysOf(mid.frame(1)), restPolys(b)) > 0.05) why.push('fromTEnd');
      for (const e of mid.frame(0.5)) for (const v of e.d.replace(/M/g, ' ').trim().split(/\s+/).map(Number)) if (!Number.isFinite(v)) why.push('nan');
      if (why.length) fails.push(a + '>' + b + ' [' + [...new Set(why)].join(',') + ']');
    }
    report('press+change ' + style, fails);
  });
}

test('planPress with an unknown style or no style falls back to pop; planAlive with an unknown style is the wiggle', () => {
  const a = JSON.stringify(m.planPress('heart', { style: 'pop' }).frame(0.3));
  assert.equal(JSON.stringify(m.planPress('heart', {}).frame(0.3)), a);
  assert.equal(JSON.stringify(m.planPress('heart', { style: 'no-such-style' }).frame(0.3)), a);
  assert.equal(JSON.stringify(m.planAlive('bell', { style: 'no-such-style' }).frame(0.3)), JSON.stringify(m.planAlive('bell', {}).frame(0.3)));
});

test('the rejected lab styles are gone', () => {
  for (const gone of ['flex', 'stretch', 'bloom', 'lift', 'tilt', 'redraw', 'flip', 'orbit', 'anticipate', 'follow', 'lean', 'hang-push', 'hang-drag', 'hinge', 'twins', 'regrow', 'hang-follow']) {
    assert.ok(!m.isHoverStyle(gone), gone + ' is not a hover style');
    const a = JSON.stringify(m.planAlive('heart', { style: gone }).frame(0.3));
    assert.equal(a, JSON.stringify(m.planAlive('heart', {}).frame(0.3)), gone + ' falls back to the wiggle');
  }
  for (const gone of ['press', 'hold', 'jump', 'spin', 'flip', 'redraw', 'bold', 'press-body', 'pop-parts', 'point-go', 'hinge-snap', 'rebuild']) {
    assert.ok(!m.isPressStyle(gone), gone + ' is not a press style');
  }
});

// ---- 0.2.1: edge cases of the press that changes the icon ----
test('fromT 0 and fromT 1 both give a finite plan that starts on the old icon and ends on the new icon', () => {
  const fails = [];
  const pairs = [...REAL_PAIRS.slice(0, 8), ['minus', 'arrow-down'], ['trash', 'check']];
  for (const style of PRESS) {
    for (const [a, b] of pairs) {
      for (const fromT of [0, 0.5, 0.75, 0.999, 1]) {
        const why = [];
        const plan = m.planPress(a, { style, to: b, fromT });
        for (let q = 0; q <= 50; q++) for (const e of plan.frame(q / 50)) for (const v of e.d.replace(/M/g, ' ').trim().split(/\s+/).map(Number)) if (!Number.isFinite(v)) why.push('nan@' + q);
        if (fromT === 0 && hd(polysOf(plan.frame(0)), restPolys(a)) > 0.05) why.push('start');
        if (hd(polysOf(plan.frame(1)), restPolys(b)) > 0.05) why.push('end');
        // the morph really plays over the plan: halfway it is neither the old nor the new icon (a window of zero length would pop at the end)
        if (a === 'trash' && fromT >= 0.75) {
          const mid = polysOf(plan.frame(0.5));
          if (hd(mid, restPolys(a)) < 0.3 || hd(mid, restPolys(b)) < 0.3) why.push('noMorph');
        }
        if (why.length) fails.push(style + ' ' + a + '>' + b + ' fromT=' + fromT + ' [' + [...new Set(why)].join(',') + ']');
      }
    }
  }
  report('fromT boundaries', fails);
});

test('a press that joins a running press starts on the picture of that press (no jump)', () => {
  const fails = [];
  for (const style of PRESS) {
    for (const [a, b] of [['minus', 'arrow-down'], ['heart', 'check'], ['sun', 'moon'], ['trash', 'check'], ['mail', 'mail-open']]) {
      for (const fromT of [0.1, 0.3, 0.5, 0.8]) {
        const run = m.planPress(a, { style });
        const joined = m.planPress(a, { style, to: b, fromT });
        const d = hd(polysOf(joined.frame(0)), polysOf(run.frame(fromT)));
        if (d > 0.05) fails.push(style + ' ' + a + '>' + b + ' fromT=' + fromT + ' jump ' + d.toFixed(2));
      }
    }
  }
  report('joined press jump', fails);
});

test('a press that joins a running press continues it, whatever the settings of the replacement call (strength, style, geometry knobs)', () => {
  const fails = [];
  const GEO = [{}, { chainGap: 0.5, chainAngle: 30 }, { cornerAngle: 30 }]; // the replacement call carries the same geometry knobs, as the element does
  for (const geo of GEO) {
    for (const [runStyle, runStrength, newStyle, newStrength] of [['squash', 3, 'squash', 0.5], ['squash', 0.5, 'burst', 3], ['squat-jump', 3, 'pop', 0.5], ['burst', 2.5, 'squash', 1], ['pop', 0.5, 'squat-jump', 3]]) {
      for (const [a, b] of [['minus', 'arrow-down'], ['heart', 'check'], ['sun', 'moon'], ['trash', 'check']]) {
        for (const fromT of [0.2, 0.45, 0.7]) {
          const run = m.planPress(a, { style: runStyle, strength: runStrength, ...geo });
          // the replacement call has another style and strength; the running press is passed as joinPlan
          const joined = m.planPress(a, { style: newStyle, strength: newStrength, to: b, fromT, joinPlan: run, ...geo });
          const d = hd(polysOf(joined.frame(0)), polysOf(run.frame(fromT)));
          if (d > 0.05) fails.push(JSON.stringify(geo) + ' run ' + runStyle + '@' + runStrength + ' then ' + newStyle + '@' + newStrength + ' ' + a + '>' + b + ' fromT=' + fromT + ' jump ' + d.toFixed(2));
          // the joined plan still ends on the new icon and stays in the bound
          if (hd(polysOf(joined.frame(1)), restPolys(b)) > 0.05) fails.push('end ' + a + '>' + b);
          let worst = 0;
          for (let q = 0; q <= 40; q++) for (const e of joined.frame(q / 40)) for (const v of e.d.replace(/M/g, ' ').trim().split(/\s+/).map(Number)) worst = Math.max(worst, -v, v - 24);
          if (worst > BOUND + 1e-9) fails.push('bound ' + a + '>' + b + ' ' + worst.toFixed(2));
        }
      }
    }
  }
  report('continuity with settings of the replacement call', fails);
});

test('a press that joins a running press morphs from the stroke geometry of that press (its chain knobs), not from the knobs of the joining call', () => {
  const fails = [];
  const geo = { chainGap: 12, chainAngle: 30 };
  for (const [a, b] of [['a-arrow-down', 'check'], ['alarm-clock', 'check'], ['a-arrow-up', 'heart']]) {
    const want = m.planMorph(a, b, { ...geo }).frame(0).length; // the entries of the source icon with the knobs of the running press
    const dflt = m.planMorph(a, b).frame(0).length;
    if (want === dflt) { fails.push(a + ': the knobs do not change the plan (bad test icon)'); continue; }
    for (const style of PRESS) {
      const run = m.planPress(a, { style, ...geo });
      const joined = m.planPress(a, { style, to: b, fromT: 0.3, joinPlan: run }); // no knobs in the joining call
      const got = joined.frame(0).length;
      if (got !== want) fails.push(style + ' ' + a + '>' + b + ': ' + got + ' entries, the running press geometry gives ' + want + ' (default knobs give ' + dflt + ')');
      if (hd(polysOf(joined.frame(1)), restPolys(b)) > 0.05) fails.push(style + ' ' + a + '>' + b + ' does not end on the new icon');
    }
  }
  report('join geometry', fails);
});

test('burst: snapshot() and frame() are the same picture, and a morph that starts from the snapshot starts on the displayed picture', () => {
  const fails = [];
  const loopsPolys = (snap) => snap.loops.map((L) => Array.from(L.points)).filter((P) => P.length >= 4);
  for (const style of ['burst', 'squat-jump', 'squash', 'pop']) {
    for (const [a, b] of [['heart', 'check'], ['sun', 'moon'], ['minus', 'arrow-down'], ['equal', 'x'], ['plus', 'check']]) {
      for (const u of [0.05, 0.25, 0.4, 0.7]) {
        const plan = m.planPress(a, { style, to: b });
        const shown = polysOf(plan.frame(u));
        const snap = plan.snapshot(u);
        const d = hd(loopsPolys(snap), shown);
        if (d > 0.05) fails.push(style + ' ' + a + '>' + b + ' u=' + u + ' snapshot vs frame ' + d.toFixed(2));
        for (const L of snap.loops) if (L.vis && L.vis.length !== L.points.length / 2 - 1) fails.push(style + ' ' + a + ' vis length');
        // an interruption: a new morph from this snapshot starts on the displayed picture
        const next = m.planMorph(snap, 'star', {});
        const d2 = hd(polysOf(next.frame(0)), shown);
        if (d2 > 0.05) fails.push(style + ' ' + a + '>' + b + ' u=' + u + ' morph from snapshot starts ' + d2.toFixed(2) + ' off');
      }
    }
  }
  report('snapshot', fails);
});

test('press with a new icon works on icons of the other families (their morph paths are written `M x y L x y`): no NaN, bound kept', async () => {
  const { readFileSync } = await import('node:fs');
  const fams = ['remix-line-s', 'phosphor-regular-s', 'tabler-outline', 'hugeicons'];
  const fails = [];
  for (const f of fams) {
    const json = JSON.parse(readFileSync(new URL('../data/families/' + f + '.json', import.meta.url), 'utf8'));
    m.registerFamilyFile(json);
    const all = m.getIconNames().filter((n) => n.startsWith(f + ':'));
    const pick = all.filter((_, i) => i % Math.max(1, Math.floor(all.length / 18)) === 0).slice(0, 18);
    for (const a of pick) {
      for (const b of [pick[(pick.indexOf(a) + 5) % pick.length], 'remix-line-s:moon'].filter((x) => all.includes(x) || x.startsWith(f))) {
        if (a === b || !m.getIconNames().includes(b)) continue;
        for (const style of PRESS) {
          const plan = m.planPress(a, { style, to: b });
          let worst = 0;
          for (let q = 0; q <= 40; q++) {
            for (const e of plan.frame(q / 40)) {
              for (const why of dProblems(e.d)) fails.push(style + ' ' + a + '>' + b + ' q=' + q + ' ' + why);
              if (/(\s0){10,}/.test(' ' + e.d.replace(/[A-Za-z]/g, ' '))) { fails.push(style + ' ' + a + '>' + b + ' q=' + q + ' a run of zeros (NaN)'); break; }
              for (const v of e.d.match(/-?\d*\.?\d+/g).map(Number)) worst = Math.max(worst, -v, v - 24);
            }
          }
          if (worst > BOUND + 1e-9) fails.push(style + ' ' + a + '>' + b + ' bound ' + worst.toFixed(2));
        }
      }
    }
  }
  report('family icons', fails.slice(0, 20));
});

// Every token of a path string must be a finite number, and every piece must have an even count of them (x y pairs).
const dProblems = (d) => {
  const out = [];
  if (/NaN|Infinity|undefined/.test(d)) out.push('non-finite token');
  for (const piece of d.split('M').filter((x) => x.trim())) {
    const toks = piece.split(/[\sLZ]+/).filter(Boolean);
    if (toks.some((t) => !/^-?\d*\.?\d+(e-?\d+)?$/i.test(t))) out.push('bad token in "' + piece.slice(0, 30) + '"');
    if (toks.length % 2) out.push('odd count of coordinates');
  }
  return out;
};
const numsOf = (d) => d.split('M').filter((x) => x.trim()).map((x) => (x.match(/-?\d*\.?\d+(?:e-?\d+)?/gi) || []).map(Number)).filter((P) => P.length >= 4);

test('press with a new icon on a family whose morph frames are written `M x y L x y`: the frames are the independent morph frames (a press of strength near 0 is the morph), every token is finite, every piece has x y pairs', async () => {
  const { readFileSync } = await import('node:fs');
  const fails = [];
  let sawL = 0;
  for (const f of ['remix-line-s', 'phosphor-regular-s', 'tabler-outline', 'hugeicons']) {
    m.registerFamilyFile(JSON.parse(readFileSync(new URL('../data/families/' + f + '.json', import.meta.url), 'utf8')));
    const all = m.getIconNames().filter((n) => n.startsWith(f + ':'));
    const pick = all.filter((_, i) => i % Math.floor(all.length / 8) === 0).slice(0, 8);
    for (let i = 0; i < pick.length; i++) {
      const a = pick[i], b = pick[(i + 3) % pick.length];
      const morph = m.planMorph(a, b, { easing: 'spring' });
      if (morph.frame(0.5).some((e) => /L/.test(e.d))) sawL++;
      for (const style of PRESS) {
        const plan = m.planPress(a, { style, to: b, strength: 1e-6 }); // a press of almost no motion: the picture is the morph
        const { ws, we } = plan.pressWindow;
        for (const u of [0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9]) {
          const frame = plan.frame(u);
          for (const e of frame) for (const why of dProblems(e.d)) fails.push(style + ' ' + a + '>' + b + ' u=' + u + ' ' + why);
          const expected = morph.frame(Math.min(1, Math.max(0, (u - ws) / (we - ws)))).flatMap((e) => numsOf(e.d));
          const got = frame.flatMap((e) => numsOf(e.d));
          const d = hd(got, expected);
          if (!(d < 0.05)) fails.push(style + ' ' + a + '>' + b + ' u=' + u + ' differs from the morph frame by ' + d);
        }
      }
    }
  }
  assert.ok(sawL > 0, 'the test must see morph frames in the `L` format (otherwise it tests nothing)');
  report('morph frames of the families', fails.slice(0, 12));
});

test('index.d.ts declares the `to` option of planPress as a string (declaration text; the compile test below checks it with tsc)', async () => {
  const { readFileSync } = await import('node:fs');
  const dts = readFileSync(new URL('../index.d.ts', import.meta.url), 'utf8');
  assert.match(dts, /to\?: string;/);
  assert.doesNotMatch(dts, /to\?: IconSource/);
});

test('a non-string `to` is not supported: planPress ignores it and presses the old icon (plain press, no morph)', () => {
  const nodes = [['circle', { cx: 12, cy: 12, r: 8 }]];
  for (const to of [nodes, { nodes }, 42, null, '', undefined]) {
    const plan = m.planPress('heart', { style: 'pop', to });
    assert.equal(plan.pressWindow, undefined, 'no combined plan for ' + JSON.stringify(to));
    assert.ok(hd(polysOf(plan.frame(1)), restPolys('heart')) < 0.05, 'ends on the heart');
  }
});

const { createRequire: tscRequire } = await import('node:module');
const { existsSync: tscExists } = await import('node:fs');
let TSC = process.env.TSC_PATH || null;
if (!TSC) { try { TSC = tscRequire((process.env.PLAYWRIGHT_DIR || PKG) + '/').resolve('typescript/bin/tsc'); } catch (e) { TSC = null; } }
// skips when typescript is not found: set TSC_PATH=/path/to/typescript/bin/tsc, or npm i --no-save typescript
test('TypeScript (tsc --strict): `to` takes a string and rejects an icon node', { skip: process.env.SHAPCN_REQUIRE_ALL ? false : !TSC || !tscExists(TSC) ? 'typescript not found (TSC_PATH, or npm i --no-save typescript)' : false }, async () => {
  const tsc = TSC;
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'tsc-'));
  const run = (name, body) => {
    writeFileSync(join(dir, name), "import { planPress, planAlive } from '" + PKG + "/index';\n" + body);
    try { execFileSync(process.execPath, [tsc, '--noEmit', '--strict', '--skipLibCheck', '--target', 'es2020', '--module', 'esnext', '--moduleResolution', 'bundler', join(dir, name)], { encoding: 'utf8', stdio: 'pipe' }); return ''; } catch (e) { return String(e.stdout || e.stderr || e.message); }
  };
  assert.equal(run('ok.ts', "planPress('heart', { style: 'burst', to: 'check', fromT: 0.3, strength: 2 });\nplanAlive('bell', { style: 'grow' });"), '', 'a string `to` must compile');
  const bad = run('bad.ts', "planPress('heart', { to: [['circle', { cx: 12, cy: 12, r: 8 }]] });");
  assert.match(bad, /error TS2\d+/, 'an icon node as `to` must not compile: ' + bad);
});
