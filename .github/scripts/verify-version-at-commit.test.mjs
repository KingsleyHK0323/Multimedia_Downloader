// OpenAI-Codex_format_architecture: mock version-file reads at a Git commit.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { fetchVersionFiles, verifyVersionFiles, VERSION_FILES } from './verify-version-at-commit.mjs';

const sha = char => char.repeat(40);
const repo = 'KingsleyHK0323/Multimedia_Downloader';
const version = '4.3.23';
function fixtureFiles() {
  const manifest = JSON.stringify({ name: 'test', version });
  const lock = JSON.stringify({ version, packages: { '': { version } } });
  return {
    'package.json': manifest, 'package-lock.json': lock,
    'frontend/package.json': manifest, 'frontend/package-lock.json': lock,
    'src-tauri/tauri.conf.json': manifest,
    'src-tauri/Cargo.toml': '[package]\nversion = "' + version + '"\n',
    'src-tauri/Cargo.lock': '[[package]]\nname = "multimedia-downloader"\nversion = "' + version + '"\n',
    'README.md': '# Multimedia Downloader — V' + version + '\n',
    'CHANGELOG.md': '### Unreleased\n\n### [' + version + '] — 2026-11-22\n',
    'engine/__init__.py': '__version__ = "' + version + '"\n',
  };
}
function gitSha(bytes) {
  return createHash('sha1').update(Buffer.concat([Buffer.from('blob ' + bytes.length + '\0'), bytes])).digest('hex');
}
function fake(options = {}) {
  const files = fixtureFiles();
  const blobs = new Map();
  const entries = VERSION_FILES.map(path => {
    const bytes = Buffer.from(files[path]);
    const id = gitSha(bytes);
    blobs.set(id, bytes);
    return { path, type: 'blob', mode: options.symlink && path === 'README.md' ? '120000' : '100644',
      sha: id, size: bytes.length };
  });
  return {
    commit: async () => ({ sha: options.wrongCommit ? sha('f') : sha('a'), tree: { sha: sha('b') } }),
    tree: async () => ({ truncated: !!options.truncated, tree: entries }),
    blob: async (_repo, id) => {
      const bytes = blobs.get(id);
      return { sha: id, size: bytes.length, encoding: 'base64',
        content: (options.corrupt ? Buffer.alloc(bytes.length, 0x78) : bytes).toString('base64') };
    },
  };
}
test('verifies all ten version fields including root lock packages', () => {
  verifyVersionFiles(fixtureFiles(), 'v4.3.23');
  for (const path of VERSION_FILES) {
    const files = fixtureFiles();
    files[path] = files[path].replaceAll(version, '4.3.22');
    assert.throws(() => verifyVersionFiles(files, 'v4.3.23'));
  }
});
test('reserved or malformed release tags cannot be published', () => {
  for (const tag of ['v4.3.3', 'v04.3.23', 'v4.3.23-rc1', 'v4.٣.23']) {
    assert.throws(() => verifyVersionFiles(fixtureFiles(), tag), /Invalid or reserved/);
  }
});
test('fetches and hashes only regular files from the exact commit', async () => {
  const files = await fetchVersionFiles(fake(), repo, sha('a'));
  assert.deepEqual(files, fixtureFiles());
  verifyVersionFiles(files, 'v4.3.23');
});
test('rejects wrong commits, truncated trees, symlinks and altered blob bytes', async () => {
  for (const options of [{ wrongCommit: true }, { truncated: true }, { symlink: true }, { corrupt: true }]) {
    await assert.rejects(fetchVersionFiles(fake(options), repo, sha('a')));
  }
});
