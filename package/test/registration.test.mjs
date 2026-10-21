// Per-family modules, registerFamilyIcons, registerSVGs, and errors for bad input.
// The family modules are generated: run "npm run build" first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { m, names } from './helpers.mjs';
import lucide, { mic, micOff } from '../lucide.js';
import tabler, { bell, bellOff } from '../tabler-outline.js';
import phosphor from '../phosphor-regular-s.js';
import remix from '../remix-fill.js';

test('a family module has named exports and a default export', () => {
  assert.equal(Object.keys(lucide).length, names.length);
  assert.deepEqual(lucide.mic, mic);
  assert.ok(Array.isArray(mic) && Array.isArray(micOff));
  assert.ok(Object.keys(tabler.icons).length > 1000);
  assert.equal(tabler.icons.bell, bell);
});

test('the default export of tabler-outline is a family spec', () => {
  assert.equal(typeof tabler.icons, 'object');
  assert.equal(tabler.id, 'tabler-outline');
  assert.equal(tabler.kind, 'stroke');
  assert.ok(phosphor.icons && remix.icons);
});

test('registerFamilyIcons registers only the icons given and they morph', () => {
  const info = m.registerFamilyIcons('tabler-outline', { bell, 'bell-off': bellOff });
  assert.equal(info.id, 'tabler-outline');
  const plan = m.planMorph('tabler-outline:bell', 'tabler-outline:bell-off');
  assert.ok(plan.frame(0.5).length > 0);
  assert.throws(() => m.planMorph('tabler-outline:bell', 'tabler-outline:not-registered-icon'));
});

test('registerFamilyIcons rejects an unknown family and bad input', () => {
  assert.throws(() => m.registerFamilyIcons('no-such-family', {}), /unknown family/);
  assert.throws(() => m.registerFamilyIcons('tabler-outline', null), /icons must be an object/);
});

test('registerSVGs round trip on 10 icons', () => {
  const picks = ['mic', 'bell', 'heart', 'house', 'star', 'sun', 'moon', 'camera', 'eye', 'lock'];
  const svgs = {};
  for (const n of picks) {
    assert.ok(m.iconToSVG(n).includes('<svg'), n);
    svgs['rt-' + n] = m.iconToSVG(n);
  }
  m.registerSVGs(svgs);
  for (const n of picks) {
    const plan = m.planMorph('rt-' + n, n);
    for (const t of [0, 0.5, 1]) {
      for (const e of plan.frame(t)) assert.ok(!/NaN|undefined/.test(e.d), n + ' t=' + t);
    }
  }
});

test('bad input gives a clear error', () => {
  assert.throws(() => m.planMorph('no-such-icon-xyz', 'mic'));
  assert.throws(() => m.planMorph('mic', 'no-such-icon-xyz'));
  assert.throws(() => m.planMorph(null, 'mic'));
  assert.throws(() => m.registerFamilyFile('{}'), /expected/);
  assert.throws(() => m.registerFamilyFile('not json'));
});
