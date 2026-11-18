// OpenAI-Codex: run the actual formatter selection in a temporary Git repository.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
function run(root, before, head) {
  return spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', shell], {
    cwd: root, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, BEFORE_SHA: before, PUSH_SHA: head },
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
