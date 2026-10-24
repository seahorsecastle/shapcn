// Child process of unregister.test.mjs: run with --expose-gc. Prints one JSON line.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as m from '../index.js';
const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const nodes = JSON.parse(readFileSync(join(PKG, 'data', 'lucide-nodes.json'), 'utf8'));
m.registerIcons(nodes);
const gc = () => { global.gc(); global.gc(); };
const keep = ['mic', 'mic-off', 'anchor', 'alarm-clock', 'bell', 'arrow-down'];
const sig = () => JSON.stringify(keep.flatMap((a, i) => {
  const b = keep[(i + 1) % keep.length];
  const p = m.planMorph(a, b);
  return [0, 0.3, 0.6, 1].map((t) => p.frame(t).map((e) => e.d));
}));
const before = sig();
gc();
const base = { heap: process.memoryUsage().heapUsed, size: m.getIconNames(true).length };
const N = 10000;
const mk = (i) => [['path', { d: `M${2 + (i % 20)} ${3 + (i % 17)} L20 ${4 + (i % 13)} L${6 + (i % 11)} 21` }], ['circle', { cx: 12, cy: 12, r: 3 + (i % 5) }]];
const names = [];
let map = {};
for (let i = 0; i < N; i++) { names.push('tmp-' + i); map[names[i]] = mk(i); }
m.registerIcons(map);
// use some of them, so plan caches fill
for (let i = 0; i < 300; i++) m.planMorph(names[i], names[i + 1]).frame(0.5);
m.planMorph('mic', names[5]).frame(0.5);
const mid = { heap: (gc(), process.memoryUsage().heapUsed), size: m.getIconNames(true).length };
map = null; // the caller must not hold the icons either
const removed = m.unregisterIcons(names);
const again = m.unregisterIcons(names);
const protectedShape = m.unregisterIcons(['shape:dot', 'no-such-icon']);
gc();
const after = { heap: process.memoryUsage().heapUsed, size: m.getIconNames(true).length };
let unknownThrows = false;
try { m.planMorph('mic', names[0]); } catch { unknownThrows = true; }
console.log(JSON.stringify({ N, base, mid, after, removed, again, protectedShape, unknownThrows, planSame: sig() === before }));
