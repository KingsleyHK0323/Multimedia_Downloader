// OpenAI-Codex: exercise release inventory validation without a GitHub release.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateAssets } from './verify-release-assets.mjs';

const names = [
  'Multimedia.Downloader-4.3.22-1.x86_64.rpm',
  'Multimedia.Downloader_4.3.22_amd64.AppImage',
  'Multimedia.Downloader_4.3.22_amd64.deb',
  'Multimedia.Downloader_4.3.22_aarch64.dmg',
  'Multimedia.Downloader_4.3.22_x64-setup.exe',
  'Multimedia.Downloader_4.3.22_x64_en-US.msi',
];
const assets = () => names.map(name => ({ name, size: 123 }));
test('accepts the six expected nonempty installers and supplemental checksums', () => {
  assert.doesNotThrow(() => validateAssets('v4.3.22', { assets: [...assets(), { name: 'SHA256SUMS', size: 10 }] }));
});
test('rejects missing, wrong version, duplicate, empty or invalid assets', () => {
  assert.throws(() => validateAssets('v4.3.22', { assets: assets().slice(1) }));
  assert.throws(() => validateAssets('v4.3.23', { assets: assets() }));
  assert.throws(() => validateAssets('v4.3.22', { assets: [...assets().slice(0, 5), assets()[0]] }));
  const empty = assets(); empty[0].size = 0;
  assert.throws(() => validateAssets('v4.3.22', { assets: empty }));
  assert.throws(() => validateAssets('v4.3.22-rc1', { assets: assets() }));
});

test('CLI rejects invalid inventories and accepts complete ones', () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-assets-'));
  try {
    const file = join(dir, 'assets.json');
    const script = fileURLToPath(new URL('./verify-release-assets.mjs', import.meta.url));
    writeFileSync(file, JSON.stringify({ assets: assets().slice(1) }));
    const invalid = spawnSync(process.execPath, [script, 'v4.3.22', file], { encoding: 'utf8' });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /Release asset validation failed/);
    writeFileSync(file, JSON.stringify({ assets: assets() }));
    const valid = spawnSync(process.execPath, [script, 'v4.3.22', file], { encoding: 'utf8' });
    assert.equal(valid.status, 0);
    assert.match(valid.stdout, /Verified six version-specific installer assets/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
