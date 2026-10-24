import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { PKG } from './helpers.mjs';

test('dist/morph-icon.js is minified (about 170 kB gzip) and dist/morph-icon.dev.js is the readable build', () => {
  const min = readFileSync(PKG + '/dist/morph-icon.js');
  const dev = readFileSync(PKG + '/dist/morph-icon.dev.js');
  const gz = gzipSync(min, { level: 9 }).length;
  console.log('dist: min ' + min.length + ' B raw, ' + gz + ' B gzip; dev ' + dev.length + ' B raw, ' + gzipSync(dev, { level: 9 }).length + ' B gzip');
  assert.ok(gz < 180000, 'minified gzip ' + gz);
  assert.ok(min.length < 0.7 * dev.length, 'minified raw is at most 70% of the readable build');
  assert.ok(min.toString().split('\n').length < 20, 'the minified file has few lines');
  assert.ok(dev.toString().split('\n').length > 5000, 'the dev build keeps its lines');
  assert.match(min.toString().slice(0, 200), /shapcn: morph any icon/, 'license line first');
  assert.match(min.toString(), /window\.shapcn=/, 'exports window.shapcn');
  assert.ok(statSync(PKG + '/dist/morph-icon.js').size > 100000);
});
