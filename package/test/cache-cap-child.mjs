// Child of cache-cap.test.mjs (--expose-gc): 1,857 distinct morphs over all Lucide icons; prints heap numbers and frame hashes.
import * as m from '../index.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const nodes = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'lucide-nodes.json'), 'utf8'));
m.registerIcons(nodes);
const names = Object.keys(nodes).sort();
const gc = () => { global.gc(); global.gc(); };
function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); }
const sample = [['mic', 'mic-off'], ['bell', 'bell-off'], ['heart', 'check'], ['anchor', 'minus'], ['sun', 'moon'], ['trash', 'x']];
const frames = () => hash(sample.map(([a, b]) => { const p = m.planMorph(a, b); return [0, 0.3, 0.6, 1].map((t) => p.frame(t).map((e) => e.d).join('|')).join('/'); }).join('\n'));
const before = frames();
gc();
const base = process.memoryUsage().heapUsed;
const marks = {};
for (let i = 0; i + 1 < names.length; i++) {
  m.planMorph(names[i], names[i + 1]).frame(0.5);
  if (i === 299 || i === 999) { gc(); marks[i + 1] = process.memoryUsage().heapUsed - base; }
}
gc();
const end = process.memoryUsage().heapUsed - base;
console.log(JSON.stringify({ morphs: names.length - 1, marks, end, same: frames() === before }));
