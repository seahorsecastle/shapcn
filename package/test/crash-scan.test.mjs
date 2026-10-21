// 500 random Lucide pairs: planMorph must not throw, and no frame may hold NaN, Infinity or undefined.
import test from 'node:test';
import assert from 'node:assert/strict';
import { m, randomPairs } from './helpers.mjs';

test('500 random Lucide pairs plan and draw without error or NaN', () => {
  const STEPS = 10;
  for (const [a, b] of randomPairs(500, 20261021)) {
    let plan;
    assert.doesNotThrow(() => { plan = m.planMorph(a, b); }, a + ' -> ' + b);
    for (let i = 0; i <= STEPS; i++) {
      const frame = plan.frame(i / STEPS);
      assert.ok(Array.isArray(frame), a + ' -> ' + b + ': frame is an array');
      for (const e of frame) {
        assert.ok(!/NaN|undefined|Infinity/.test(e.d), a + ' -> ' + b + ' t=' + i / STEPS + ': bad path data');
        assert.ok(Number.isFinite(e.opacity), a + ' -> ' + b + ': opacity is a finite number');
        assert.ok(Number.isFinite(e.widthScale), a + ' -> ' + b + ': widthScale is a finite number');
      }
    }
  }
});
