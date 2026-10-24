// Child of unregister.test.mjs: register A,B, plan, register C, unregister all; count the cached forms through a debug copy of core.js.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(PKG, 'core.js'), 'utf8') + '\nexport const __forms = () => lru.size;';
const m = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const node = (d) => [['path', { d }]];
m.registerIcons({ a: node('M2 2L20 20'), b: node('M2 20L20 2') });
m.planMorph('a', 'b');
const afterPlan = m.__forms();
m.registerIcons({ c: node('M4 12L20 12') });
m.unregisterIcons(['a', 'b', 'c']);
console.log(JSON.stringify({ afterPlan, afterAll: m.__forms() }));
