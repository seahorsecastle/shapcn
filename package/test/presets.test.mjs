// The feel presets plan without error, and the old name bouncy still works.
import test from 'node:test';
import assert from 'node:assert/strict';
import { m, randomPairs } from './helpers.mjs';

test('elastic, spring and smooth are easing functions with exact ends', () => {
  for (const name of ['elastic', 'spring', 'smooth', 'bouncy']) {
    const f = m.easings[name];
    assert.equal(typeof f, 'function', name + ' exists');
    assert.ok(Math.abs(f(0)) < 1e-9, name + '(0) is 0');
    assert.ok(Math.abs(f(1) - 1) < 1e-9, name + '(1) is 1');
  }
});

test('the spring presets overshoot and smooth does not', () => {
  const peak = (f) => { let p = 0; for (let i = 0; i <= 200; i++) p = Math.max(p, f(i / 200)); return p; };
  assert.ok(peak(m.easings.smooth) <= 1 + 1e-9);
  assert.ok(peak(m.easings.spring) > 1.05);
  assert.ok(peak(m.easings.elastic) > peak(m.easings.spring));
});

test('every preset plans 60 random pairs without error', () => {
  for (const easing of ['elastic', 'spring', 'smooth', 'bouncy']) {
    for (const [a, b] of randomPairs(60, 99)) {
      let plan;
      assert.doesNotThrow(() => { plan = m.planMorph(a, b, { easing }); }, easing + ' ' + a + ' -> ' + b);
      for (const t of [0, 0.25, 0.5, 0.75, 1]) assert.ok(Array.isArray(plan.frame(t)));
    }
  }
});

test('an unknown easing name is an error or falls back, it does not give NaN', () => {
  let plan = null;
  try { plan = m.planMorph('mic', 'mic-off', { easing: 'no-such-feel' }); } catch (e) { assert.ok(e instanceof Error); return; }
  for (const e of plan.frame(0.5)) assert.ok(!/NaN/.test(e.d));
});
