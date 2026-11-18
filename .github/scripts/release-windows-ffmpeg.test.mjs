// OpenAI-Codex: exercise the actual Windows download guard with fake commands.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const workflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
const start = '      - name: Stage ffmpeg — Windows\n';
const end = '\n      - name: Install JS dependencies\n';
assert.equal(workflow.split(start).length, 2);
const block = workflow.split(start)[1].split(end)[0];
const marker = '        run: |\n';
assert.equal(block.split(marker).length, 2);
const shell = block.split(marker)[1].replace(/^          /gm, '');
function run(failCurl, failArchive) {
  const root = mkdtempSync(join(tmpdir(), 'ffmpeg-guard-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'curl'), '#!/bin/sh\n[ "$FAIL_CURL" != 1 ] || exit 22\ntouch ffmpeg.zip\n', { mode: 0o755 });
  writeFileSync(join(bin, '7z'), '#!/bin/sh\nprintf "%s\\n" "$1" >> "$MOCK_LOG"\n[ "$FAIL_ARCHIVE" != 1 ] || exit 2\nexit 0\n', { mode: 0o755 });
  const log = join(root, 'calls');
  const result = spawnSync('bash', ['--noprofile', '--norc', '-c', shell], {
    cwd: root, encoding: 'utf8', timeout: 5000,
    env: { ...process.env, PATH: bin + ':' + process.env.PATH, FAIL_CURL: String(failCurl), FAIL_ARCHIVE: String(failArchive), MOCK_LOG: log },
  });
  assert.ifError(result.error);
  return { result, calls: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [] };
}
test('HTTP errors prevent archive handling', () => {
  const { result, calls } = run(1, 0);
  assert.notEqual(result.status, 0);
  assert.deepEqual(calls, []);
});
test('invalid archive stops before extraction', () => {
  const { result, calls } = run(0, 1);
  assert.notEqual(result.status, 0);
  assert.deepEqual(calls, ['t']);
});
test('an archive with no ffmpeg executable fails', () => {
  const { result, calls } = run(0, 0);
  assert.notEqual(result.status, 0);
  assert.deepEqual(calls, ['t', 'x']);
});
