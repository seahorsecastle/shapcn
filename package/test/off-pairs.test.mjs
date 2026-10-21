// Named -off pairs: the body of the icon stays where it is. Some pieces must not move before the end.
import test from 'node:test';
import assert from 'node:assert/strict';
import { m } from './helpers.mjs';

for (const [a, b] of [['mic', 'mic-off'], ['eye', 'eye-off'], ['camera', 'camera-off'], ['video', 'video-off']]) {
  test(a + ' -> ' + b + ': at least 3 pieces stay still from t=0 to t=0.95', () => {
    const plan = m.planMorph(a, b);
    const first = new Map();
    const moved = new Set();
    for (let i = 0; i <= 95; i++) {
      for (const e of plan.frame(i / 100)) {
        if (!first.has(e.key)) first.set(e.key, e.d);
        else if (first.get(e.key) !== e.d) moved.add(e.key);
      }
    }
    const still = [...first.keys()].filter((k) => !moved.has(k));
    assert.ok(still.length >= 3, a + ' -> ' + b + ': only ' + still.length + ' still pieces of ' + first.size);
  });
}
