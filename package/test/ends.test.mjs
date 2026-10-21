// Exact ends: at t=0 the picture is the first icon, at t=1 it is the second icon.
import test from 'node:test';
import assert from 'node:assert/strict';
import { m, randomPairs, restLines, frameLines, oneWay } from './helpers.mjs';

const TOL = 0.1; // grid units; the measured worst value over many pairs is about 0.03

test('t=0 shows all of the first icon and t=1 shows all of the second icon (80 pairs)', () => {
  for (const [a, b] of randomPairs(80, 1234)) {
    const plan = m.planMorph(a, b);
    const start = oneWay(restLines(a), frameLines(plan.frame(0)));
    const end = oneWay(restLines(b), frameLines(plan.frame(1)));
    assert.ok(start < TOL, a + ' -> ' + b + ': first icon is missing at t=0 by ' + start.toFixed(3));
    assert.ok(end < TOL, a + ' -> ' + b + ': second icon is missing at t=1 by ' + end.toFixed(3));
  }
});

test('t=0 and t=1 do not depend on the easing preset (80 pairs)', () => {
  const ref = (a, b, easing, t) => JSON.stringify(m.planMorph(a, b, { easing }).frame(t));
  for (const [a, b] of randomPairs(80, 4321)) {
    for (const t of [0, 1]) {
      const smooth = ref(a, b, 'smooth', t);
      for (const easing of ['spring', 'elastic', 'bouncy']) {
        assert.equal(ref(a, b, easing, t), smooth, a + ' -> ' + b + ' ' + easing + ' t=' + t);
      }
    }
  }
});
