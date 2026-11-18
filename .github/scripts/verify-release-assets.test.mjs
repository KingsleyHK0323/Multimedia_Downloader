// OpenAI-Codex: exercise release inventory validation without a GitHub release.
import assert from 'node:assert/strict';
import test from 'node:test';
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
