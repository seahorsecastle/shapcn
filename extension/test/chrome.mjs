// Finds the system Google Chrome (the tests need real Chrome: the branded build, in new headless mode). CHROME=<path> overrides.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

export function chromePath() {
  if (process.env.CHROME) return process.env.CHROME;
  const list = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', // macOS
    '/opt/google/chrome/chrome', // Linux (the package of "playwright install chrome")
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ];
  for (const p of list) if (fs.existsSync(p)) return p;
  for (const n of ['google-chrome', 'google-chrome-stable']) {
    const r = spawnSync('which', [n], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  throw new Error('Google Chrome not found. Install it (npx playwright install chrome) or set CHROME=<path>.');
}

// Extra Chrome flags for CI. On ubuntu-latest (24.04) AppArmor can block the user namespaces that the Chrome sandbox needs, and Chrome then stops with
// "No usable sandbox". The harness starts Chrome itself (Playwright, which adds these flags on its own, is not the launcher), so it adds them here.
export function ciArgs() {
  return process.env.CI ? ['--no-sandbox', '--disable-dev-shm-usage'] : [];
}
