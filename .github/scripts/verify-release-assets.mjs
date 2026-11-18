// OpenAI-Codex: validate the exact installer inventory before release publication.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function validateAssets(tag, response) {
  if (typeof tag !== 'string' || !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag) || tag.length > 51) {
    throw new Error('Invalid version tag');
  }
  if (!response || !Array.isArray(response.assets)) throw new Error('Invalid asset response');
  const version = tag.slice(1);
  const expected = new Set([
    'Multimedia.Downloader-' + version + '-1.x86_64.rpm',
    'Multimedia.Downloader_' + version + '_amd64.AppImage',
    'Multimedia.Downloader_' + version + '_amd64.deb',
    'Multimedia.Downloader_' + version + '_aarch64.dmg',
    'Multimedia.Downloader_' + version + '_x64-setup.exe',
    'Multimedia.Downloader_' + version + '_x64_en-US.msi',
  ]);
  const isInstaller = name => /\.(?:rpm|AppImage|deb|dmg|msi)$/.test(name) || name.endsWith('-setup.exe');
  const installers = response.assets.filter(item => item && typeof item.name === 'string' && isInstaller(item.name));
  if (installers.length !== expected.size) throw new Error('Unexpected installer count');
  const names = new Set();
  for (const item of installers) {
    if (!expected.has(item.name) || names.has(item.name) || !Number.isSafeInteger(item.size) || item.size <= 0) {
      throw new Error('Unexpected, duplicate or empty installer');
    }
    names.add(item.name);
  }
  if (names.size !== expected.size) throw new Error('Incomplete installer inventory');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [tag, file] = process.argv.slice(2);
    validateAssets(tag, JSON.parse(readFileSync(file, 'utf8')));
    console.log('Verified six version-specific installer assets.');
  } catch (error) {
    console.error('::error::Release asset validation failed:', error.message);
    process.exitCode = 1;
  }
}
