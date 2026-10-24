// Which extension folder the tests load: EXT_DIR if set, else the test build (with the test hooks) that this file builds first.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ext = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PROD = ext; // the production files (no test hooks)
export function extDir() {
  if (process.env.EXT_DIR) return path.resolve(process.env.EXT_DIR);
  const r = spawnSync('node', [path.join(ext, 'build.mjs'), '--test'], { cwd: ext, stdio: 'inherit' });
  if (r.status !== 0) throw new Error('test build failed');
  return path.join(ext, '.test-build');
}
