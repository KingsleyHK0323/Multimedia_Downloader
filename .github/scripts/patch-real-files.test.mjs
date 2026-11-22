// OpenAI-Codex_health_release_architecture: preview patch planning against the checked-out release files.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { planVersion, VERSION_PATHS } from './patch-release-policy.mjs';

test('plans the checked-out version files without writing them', () => {
  const before = new Map(VERSION_PATHS.map(path => [path, readFileSync(path)]));
  const files = Object.fromEntries([...before].map(([path, bytes]) => {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    assert.deepEqual(Buffer.from(text, 'utf8'), bytes, path + ' must be canonical UTF-8');
    return [path, text];
  }));
  const current = JSON.parse(files['package.json']).version;
  assert.match(current, /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/);
  const [major, minor, patch] = current.split('.');
  const expected = major + '.' + minor + '.' + (BigInt(patch) + 1n);
  if (expected === '4.3.3') {
    assert.throws(() => planVersion(files, 1, '2026-11-22'), /separate release authorization/);
    for (const [path, bytes] of before) assert.deepEqual(readFileSync(path), bytes, path + ' must remain unchanged');
    return;
  }
  const result = planVersion(files, 1, '2026-11-22');
  assert.equal(result.oldVersion, current);
  assert.equal(result.version, expected);
  assert.equal(result.tag, 'v' + expected);
  assert.deepEqual(Object.keys(result.updates).sort(), [...VERSION_PATHS].sort());
  for (const path of ['package.json', 'package-lock.json', 'frontend/package.json',
    'frontend/package-lock.json', 'src-tauri/tauri.conf.json']) {
    const json = JSON.parse(result.updates[path]);
    assert.equal(json.version, expected, path);
    if (path.endsWith('package-lock.json')) assert.equal(json.packages[''].version, expected, path);
  }
  assert.ok(result.updates['src-tauri/Cargo.toml'].includes('version = "' + expected + '"'));
  assert.ok(result.updates['src-tauri/Cargo.lock'].includes('name = "multimedia-downloader"\nversion = "' + expected + '"'));
  assert.ok(result.updates['README.md'].includes('V' + expected));
  assert.ok(result.updates['CHANGELOG.md'].includes('### [' + expected + '] — 2026-11-22'));
  assert.ok(result.updates['engine/__init__.py'].includes('__version__ = "' + expected + '"'));
  for (const [path, bytes] of before) assert.deepEqual(readFileSync(path), bytes, path + ' must remain unchanged');
});
