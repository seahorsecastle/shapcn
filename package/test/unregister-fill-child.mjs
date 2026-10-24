// Child of unregister.test.mjs (--expose-gc): a kept fill icon morphs to many temporary fill icons, which are then unregistered.
import * as m from '../index.js';
const gc = () => { global.gc(); global.gc(); };
const poly = (i) => { const k = 3 + (i % 9); const pts = []; for (let q = 0; q < k; q++) { const a = (2 * Math.PI * q) / k, r = 6 + ((i * 7 + q * 3) % 5); pts.push([12 + r * Math.cos(a), 12 + r * Math.sin(a)]); } return [['path', { d: 'M' + pts.map((p) => p[0].toFixed(2) + ' ' + p[1].toFixed(2)).join('L') + 'Z' }]]; };
m.registerFamily({ id: 'k', kind: 'fill', icons: { keep: poly(1) } });
// one round of the same work first: code and fixed caches are warm, so the baseline is fair
function round(n, keepAlive) {
  const icons = {};
  const names = [];
  for (let i = 0; i < n; i++) { icons['t' + i] = poly(i); names.push('tmp:t' + i); }
  m.registerFamily({ id: 'tmp', kind: 'fill', icons });
  for (const nm of names) m.planMorph('k:keep', nm).frame(0.5);
  let mid = 0;
  if (keepAlive) { gc(); mid = process.memoryUsage().heapUsed; }
  m.unregisterIcons(names);
  return mid;
}
round(300, false);
gc();
const base = process.memoryUsage().heapUsed;
const mid = round(4000, true);
gc();
console.log(JSON.stringify({ base, mid, after: process.memoryUsage().heapUsed }));
