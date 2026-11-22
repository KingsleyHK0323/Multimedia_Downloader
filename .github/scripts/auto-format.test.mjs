// OpenAI-Codex: run the actual formatter selection in a temporary Git repository.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const workflow = readFileSync(resolve('.github/workflows/auto-format.yml'), 'utf8');
const start = '      - name: Format changed Python files\n';
const end = '\n      - name: Commit and request CI\n';
assert.equal(workflow.split(start).length, 2);
const block = workflow.split(start)[1].split(end)[0];
const marker = '        run: |\n';
assert.equal(block.split(marker).length, 2);
const shell = block.split(marker)[1].replace(/^          /gm, '');
// OpenAI-Codex_format_architecture: exercise the real isolated pip command offline.
const installMarker = '      - name: Install pinned formatter\n';
assert.equal(workflow.split(installMarker).length, 2);
const installBlock = workflow.split(installMarker)[1].split('\n      - name:')[0];
const installLines = installBlock.split('\n').filter(line => line.startsWith('        run: '));
assert.equal(installLines.length, 1);
const installCommand = installLines[0].slice('        run: '.length);
function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mmdl-format-test-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(root, 'changed.py'), 'value = 1\n');
  writeFileSync(join(root, 'untouched.py'), 'untouched=  2\n');
  writeFileSync(join(root, 'note.txt'), 'before\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'baseline');
  const before = git(root, 'rev-parse', 'HEAD');
  writeFileSync(join(root, 'changed.py'), 'value=  42\n');
  writeFileSync(join(root, 'note.txt'), 'after\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'change');
  return { root, before, head: git(root, 'rev-parse', 'HEAD') };
}
function run(root, before, head, extraEnv = {}) {
  return spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', shell], {
    cwd: root, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, ...extraEnv, BEFORE_SHA: before, PUSH_SHA: head },
  });
}
test('formats and stages only changed Python files', () => {
  const { root, before, head } = fixture();
  const result = run(root, before, head);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(root, 'changed.py'), 'utf8'), 'value = 42\n');
  assert.equal(readFileSync(join(root, 'untouched.py'), 'utf8'), 'untouched=  2\n');
  assert.equal(git(root, 'diff', '--cached', '--name-only'), 'changed.py');
});
test('rejects a missing base commit', () => {
  const { root, head } = fixture();
  const result = run(root, '0'.repeat(40), head);
  assert.notEqual(result.status, 0);
  assert.equal(git(root, 'diff', '--cached', '--name-only'), '');
});

// OpenAI-Codex: changed symlinks must never cause another file to be formatted.
test('does not follow changed Python symlinks', () => {
  const { root, head } = fixture();
  symlinkSync('untouched.py', join(root, 'link.py'));
  git(root, 'add', 'link.py');
  git(root, 'commit', '-qm', 'add symlink');
  const result = run(root, head, git(root, 'rev-parse', 'HEAD'));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(root, 'untouched.py'), 'utf8'), 'untouched=  2\n');
  assert.equal(git(root, 'diff', '--cached', '--name-only'), '');
});

// OpenAI-Codex_format_architecture: checkout modules cannot replace pip, Python startup or Black.
test('formatter installation ignores checkout-local pip and startup modules', () => {
  const root = mkdtempSync(join(tmpdir(), 'mmdl-pip-isolation-test-'));
  writeFileSync(join(root, 'sitecustomize.py'), 'raise SystemExit("unsafe checkout startup")\n');
  writeFileSync(join(root, 'pip.py'), 'raise SystemExit("unsafe checkout pip")\n');
  const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c',
    installCommand + ' --no-index --no-deps'], {
    cwd: root, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, PYTHONPATH: root, PIP_DISABLE_PIP_VERSION_CHECK: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
});
test('formatting ignores checkout-local startup and Black modules', () => {
  const { root, before, head } = fixture();
  writeFileSync(join(root, 'sitecustomize.py'), 'raise SystemExit("unsafe checkout startup")\n');
  writeFileSync(join(root, 'black.py'), 'raise SystemExit("unsafe checkout black")\n');
  const result = run(root, before, head, { PYTHONPATH: root });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(root, 'changed.py'), 'utf8'), 'value = 42\n');
  assert.equal(git(root, 'diff', '--cached', '--name-only'), 'changed.py');
});
