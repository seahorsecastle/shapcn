// wiggle (and its old name alive) is deprecated in 0.2.2: it still plays exactly as in 0.2.1, it warns once per page, and it is not in HOVER_STYLES.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { m, names, PKG } from './helpers.mjs';

function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); }

test('HOVER_STYLES does not list wiggle, but wiggle and alive still resolve', () => {
  assert.deepEqual([...m.HOVER_STYLES], ['grow', 'bend', 'bold', 'cascade', 'move']);
  assert.ok(m.isHoverStyle('wiggle') && m.isHoverStyle('alive'));
  assert.equal(m.resolveHover('wiggle'), 'alive');
  assert.ok(m.hoverMs('wiggle') === 600 && m.hoverMs('alive') === 600);
});

test('wiggle frames are unchanged byte for byte against 0.2.1 (all icons; wiggle, alive, strength 1)', () => {
  const ref = JSON.parse(readFileSync(PKG + '/test/wiggle-default.json', 'utf8'));
  const fails = [];
  for (const n of names) {
    const out = [];
    for (const opts of [{ style: 'wiggle' }, { style: 'alive' }, { style: 'wiggle', strength: 1 }, { style: 'wiggle', wiggleJoin: false }]) {
      const p = m.planAlive(n, opts);
      for (const t of [0, 0.2, 0.45, 0.7, 1]) out.push(p.frame(t).map((e) => e.d).join('|'));
    }
    if (ref[n] !== hash(out.join('\n'))) fails.push(n);
  }
  assert.equal(fails.length, 0, 'changed: ' + fails.slice(0, 8).join(', '));
});

test('the first use of wiggle (planAlive, style wiggle or alive) logs one console.warn per page; other styles and presses log none', () => {
  const code = `
    import * as m from ${JSON.stringify(PKG + '/index.js')};
    import { readFileSync } from 'node:fs';
    m.registerIcons(JSON.parse(readFileSync(${JSON.stringify(PKG + '/data/lucide-nodes.json')}, 'utf8')));
    const warns = []; console.warn = (...a) => warns.push(a.join(' '));
    m.planAlive('bell', { style: 'grow' }); m.planPress('bell', { style: 'pop' }); m.planAlive('bell', { style: 'bend' });
    const before = warns.length;
    m.planAlive('bell', { style: 'wiggle' }); m.planAlive('bell', { style: 'alive' }); m.planAlive('heart', { style: 'wiggle' });
    console.log(JSON.stringify({ before, after: warns.length, text: warns[0] }));`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.equal(r.before, 0, 'no warning for supported styles');
  assert.equal(r.after, 1, 'exactly one warning');
  assert.equal(r.text, 'shapcn: hover="wiggle" is deprecated and will be removed in 0.3.0; use grow, bend, bold, cascade or move');
});

test('default use warns too: planAlive(name) without a style, as the first call in a fresh process, logs one warning', () => {
  const code = `
    import * as m from ${JSON.stringify(PKG + '/index.js')};
    import { readFileSync } from 'node:fs';
    m.registerIcons(JSON.parse(readFileSync(${JSON.stringify(PKG + '/data/lucide-nodes.json')}, 'utf8')));
    const warns = []; console.warn = (...a) => warns.push(a.join(' '));
    m.planAlive('bell'); m.planAlive('heart', {}); m.planAlive('bell', { style: 'wiggle' });
    console.log(JSON.stringify({ n: warns.length }));`;
  const r = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' }).trim().split('\n').pop());
  assert.equal(r.n, 1);
  assert.match(readFileSync(PKG + '/index.d.ts', 'utf8'), /becomes `grow` in 0\.3\.0/);
  assert.match(readFileSync(PKG + '/README.md', 'utf8'), /becomes `grow` in 0\.3\.0/);
});

test('index.d.ts marks wiggle deprecated and README has no wiggle example', () => {
  const dts = readFileSync(PKG + '/index.d.ts', 'utf8');
  assert.match(dts, /@deprecated[^\n]*wiggle/);
  assert.doesNotMatch(dts, /wiggleJoin|wiggle-join/);
  assert.match(dts, /export type HoverStyle = 'grow' \| 'bend' \| 'bold' \| 'cascade' \| 'move';/);
  const readme = readFileSync(PKG + '/README.md', 'utf8');
  assert.doesNotMatch(readme, /wiggleJoin|wiggle-join/);
  assert.doesNotMatch(readme, /hover="(wiggle|alive)"[^\n]*>/);
  assert.match(readme, /Deprecated/);
  assert.equal(JSON.parse(readFileSync(PKG + '/package.json', 'utf8')).version, '0.2.2');
});
