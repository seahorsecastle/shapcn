import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { m } from './helpers.mjs';

test('unregisterIcons: 10,000 icons registered and removed bring the registry and the heap back to the baseline', () => {
  const out = execFileSync(process.execPath, ['--expose-gc', fileURLToPath(new URL('./unregister-child.mjs', import.meta.url))], { encoding: 'utf8' });
  const r = JSON.parse(out.trim().split('\n').pop());
  console.log(JSON.stringify(r));
  assert.equal(r.mid.size, r.base.size + r.N, 'registry grows by N');
  assert.equal(r.removed, r.N);
  assert.equal(r.again, 0, 'a second call removes nothing');
  assert.equal(r.protectedShape, 0, 'shape: icons stay, unknown names are ignored');
  assert.equal(r.after.size, r.base.size, 'registry size is back to the baseline');
  assert.ok(r.mid.heap - r.base.heap > 1e6, 'the 10,000 icons used measurable memory (' + (r.mid.heap - r.base.heap) + ' B)');
  assert.ok(r.after.heap - r.base.heap < 0.1 * (r.mid.heap - r.base.heap), 'heap is back within 10% of the growth (growth ' + (r.mid.heap - r.base.heap) + ' B, left ' + (r.after.heap - r.base.heap) + ' B)');
  assert.equal(r.unknownThrows, true, 'a removed icon is unknown');
  assert.equal(r.planSame, true, 'plans of the remaining icons are identical');
});

test('unregisterIcons: family icons, a single name, an iterable, bad input', () => {
  m.registerSVGs({ a: '<svg viewBox="0 0 24 24"><path d="M4 4L20 20"/></svg>', b: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="6"/></svg>' }, { kind: 'fill', family: 'tmpfam' });
  assert.ok(m.getIconNames().includes('tmpfam:a'));
  m.planMorph('tmpfam:a', 'tmpfam:b').frame(0.5);
  assert.equal(m.unregisterIcons('tmpfam:a'), 1);
  assert.equal(m.unregisterIcons(new Set(['tmpfam:b'])), 1);
  assert.ok(!m.getIconNames().some((n) => n.startsWith('tmpfam:')));
  assert.equal(m.unregisterIcons(), 0);
  assert.equal(m.unregisterIcons([1, null, {}]), 0);
  assert.ok(m.getIconNames(true).includes('shape:dot'));
});

test('index.d.ts declares unregisterIcons and README documents it', async () => {
  const { readFileSync } = await import('node:fs');
  const { PKG } = await import('./helpers.mjs');
  const dts = readFileSync(PKG + '/index.d.ts', 'utf8');
  assert.match(dts, /export function unregisterIcons\(names: string \| Iterable<string>\): number;/);
  assert.match(readFileSync(PKG + '/README.md', 'utf8'), /unregisterIcons/);
});

// Item: shape names. Only the four built-ins stay.
test('unregisterIcons protects the four built-in shapes only; a shape: name the page registered can be removed', () => {
  m.registerIcons({ 'shape:mine': [['path', { d: 'M1 1L20 20' }]] });
  assert.equal(m.unregisterIcons(['shape:dot', 'shape:circle', 'shape:square', 'shape:line']), 0);
  assert.equal(m.unregisterIcons('shape:mine'), 1);
  assert.ok(!m.getIconNames(true).includes('shape:mine'));
  assert.equal(m.getIconNames(true).filter((n) => n.startsWith('shape:')).length, 4);
});

test('fill-icon churn: morphing a kept fill icon to temporary fill icons and unregistering them leaves no memory behind', () => {
  const out = execFileSync(process.execPath, ['--expose-gc', fileURLToPath(new URL('./unregister-fill-child.mjs', import.meta.url))], { encoding: 'utf8' });
  const r = JSON.parse(out.trim().split('\n').pop());
  console.log(JSON.stringify(r));
  assert.ok(r.mid - r.base > 1e6, 'the churn used memory (' + (r.mid - r.base) + ' B)');
  assert.ok(r.after - r.base < 0.1 * (r.mid - r.base), 'heap back near baseline (grew ' + (r.mid - r.base) + ', left ' + (r.after - r.base) + ')');
});

test('interleaved registrations: forms of unregistered icons are evicted even after other registrations cleared the stroke cache', () => {
  const out = execFileSync(process.execPath, ['--expose-gc', fileURLToPath(new URL('./unregister-interleave-child.mjs', import.meta.url))], { encoding: 'utf8' });
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.ok(r.afterPlan > 0, 'planning cached forms');
  assert.equal(r.afterAll, 0, 'forms left after unregistering everything: ' + r.afterAll);
});
