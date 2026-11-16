// OpenAI-Codex_publish_audit: CI-only fake-gh test for the actual upload shell.
// This does not address early public release creation or concurrent publishers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const workflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
const match = workflow.match(/^      - name: Upload installers to the release\r?\n(?:(?!      - name:)[\s\S])*?        run: \|\r?\n((?:          .*\r?\n|\r?\n)+)/m);
assert.ok(match, 'actual release upload shell must exist');
const shell = match[1].replace(/^          /gm, '').replaceAll('${{ needs.setup.outputs.tag }}', 'v1.2.3');
assert.ok(!shell.includes('${{'), 'unexpected workflow expression');

function runUpload(collision) {
  const root = mkdtempSync(join(tmpdir(), 'release-upload-test-'));
  const bin = join(root, 'bin');
  const bundles = join(root, 'src-tauri', 'target', 'release', 'bundle');
  mkdirSync(bin, { recursive: true });
  mkdirSync(bundles, { recursive: true });
  writeFileSync(join(bundles, 'sample installer.deb'), 'fixture');
  const log = join(root, 'gh-calls');
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' invoked >> "$MOCK_LOG"\n[ "$1" = release ] && [ "$2" = upload ] && [ "$3" = v1.2.3 ] || exit 90\nfor arg do [ "$arg" != --clobber ] || exit 91; done\n[ "$MOCK_COLLISION" != 1 ] || exit 1\nexit 0\n`, { mode: 0o755 });
  const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', shell], {
    cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MOCK_LOG: log, MOCK_COLLISION: collision ? '1' : '0', GITHUB_REPOSITORY: 'example/repo' },
  });
  assert.ifError(result.error);
  return { ...result, calls: readFileSync(log, 'utf8').trim().split('\n').length };
}

test('upload sends existing bundle without clobber', () => {
  const result = runUpload(false);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls, 1);
});

test('existing name fails, with no retry', () => {
  const result = runUpload(true);
  assert.notEqual(result.status, 0);
  assert.equal(result.calls, 1);
});

