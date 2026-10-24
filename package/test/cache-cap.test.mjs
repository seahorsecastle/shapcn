import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('the parse cache is capped: 1,857 distinct morphs over all Lucide icons keep the heap bounded, and frames do not change after eviction', () => {
  const out = execFileSync(process.execPath, ['--expose-gc', fileURLToPath(new URL('./cache-cap-child.mjs', import.meta.url))], { encoding: 'utf8' });
  const r = JSON.parse(out.trim().split('\n').pop());
  console.log(JSON.stringify(r));
  assert.equal(r.same, true, 'frames of 6 sample morphs are identical after the cache evicted their icons');
  assert.ok(r.end < 14e6, 'heap after all morphs: ' + (r.end / 1e6).toFixed(1) + ' MB (unbounded: 71 MB in this run)');
  assert.ok(r.end < r.marks[300] * 2 + 3e6 && r.marks[1000] < r.marks[300] * 2 + 3e6, 'the heap is flat after 300 morphs: ' + JSON.stringify(r.marks) + ' end ' + r.end);
});
