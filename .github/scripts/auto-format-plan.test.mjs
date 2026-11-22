// OpenAI-Codex_format_architecture: target the reusable read-only formatter planner.
// OpenAI-Codex_health_release_architecture: exercise formatter reconciliation in disposable Git histories.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = readFileSync(resolve('.github/scripts/formatter-plan.py'), 'utf8').replaceAll('\r\n', '\n');

function command(root, executable, args, env = process.env) {
  const result = spawnSync(executable, args, { cwd: root, env, encoding: 'utf8', timeout: 120000 });
  if (result.error) throw result.error;
  return result;
}
function git(root, ...args) {
  const value = command(root, 'git', args);
  assert.equal(value.status, 0, value.stderr);
  return value.stdout.trim();
}
function fixture() {
  const root = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'format-history-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Formatter Test');
  git(root, 'config', 'user.email', 'formatter-test@example.invalid');
  git(root, 'config', 'commit.gpgsign', 'false');
  const put = (path, value) => {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, value);
  };
  const commit = (message) => {
    git(root, 'add', '-A');
    git(root, 'commit', '--allow-empty', '-qm', message);
    return git(root, 'rev-parse', 'HEAD');
  };
  put('change.py', 'value = 1\n');
  put('gone.py', 'gone = 1\n');
  put('restore.py', 'restore = 1\n');
  put('unrelated.txt', 'untouched\n');
  const anchor = commit('anchor');
  return { root, put, commit, anchor };
}
function runPlan(f, anchor = f.anchor, service = '') {
  git(f.root, 'update-ref', 'refs/heads/source', 'HEAD');
  const output = join(mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'format-plan-output-')), 'plan');
  const result = command(f.root, 'python', ['-I', '-c', script], {
    ...process.env, FORMAT_GIT_DIR: f.root, FORMAT_OUTPUT: output, FORMAT_ANCHOR: anchor, FORMAT_SERVICE_SHA: service,
  });
  const manifest = result.status === 0 ? JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8')) : null;
  return { result, manifest, output };
}
function formatted(run, name) {
  const item = run.manifest.files.find((entry) => entry.path === name);
  assert.ok(item, 'missing planned file ' + name);
  return readFileSync(join(run.output, 'blobs', item.sha256), 'utf8');
}

test('reconciles A to B to A, added and restored files without deleted or unrelated paths', () => {
  const f = fixture();
  f.put('change.py', 'value=  2\n');
  f.put('new.py', 'new=  3\n');
  rmSync(join(f.root, 'gone.py'));
  rmSync(join(f.root, 'restore.py'));
  f.commit('first');
  f.put('change.py', 'value=  4\n');
  f.commit('second');
  f.put('change.py', 'value=  2\n');
  f.put('restore.py', 'restore=  9\n');
  const reverted = f.commit('restore');
  const result = runPlan(f);
  assert.equal(result.result.status, 0, result.result.stderr);
  assert.equal(formatted(result, 'change.py'), 'value = 2\n');
  assert.equal(formatted(result, 'new.py'), 'new = 3\n');
  assert.equal(formatted(result, 'restore.py'), 'restore = 9\n');
  assert.equal(result.manifest.files.some((file) => file.path === 'gone.py'), false);
  assert.equal(result.manifest.files.some((file) => file.path === 'unrelated.txt'), false);
  assert.equal(result.manifest.files.find((file) => file.path === 'change.py').last_change, reverted);
  assert.equal(readFileSync(join(f.root, 'unrelated.txt'), 'utf8'), 'untouched\n');
});

test('reconciles merge commits through their first parent', () => {
  const f = fixture();
  const initial = git(f.root, 'branch', '--show-current');
  git(f.root, 'checkout', '-qb', 'feature');
  f.put('feature.py', 'feature=  5\n');
  f.commit('feature');
  git(f.root, 'checkout', '-q', initial);
  f.put('change.py', 'value=  6\n');
  f.commit('main');
  git(f.root, 'merge', '--no-ff', '-qm', 'merge feature', 'feature');
  const result = runPlan(f);
  assert.equal(result.result.status, 0, result.result.stderr);
  assert.equal(formatted(result, 'feature.py'), 'feature = 5\n');
  assert.equal(formatted(result, 'change.py'), 'value = 6\n');
});

test('scans more than 100 commits without relying on a workflow queue', () => {
  const f = fixture();
  for (let index = 0; index < 105; index++) {
    f.put('change.py', 'value=  ' + index + '\n');
    f.commit('change ' + index);
  }
  const result = runPlan(f);
  assert.equal(result.result.status, 0, result.result.stderr);
  assert.equal(formatted(result, 'change.py'), 'value = 104\n');
});

test('uses the group common-root Black config and preserves the nested config', () => {
  const f = fixture();
  f.put('pyproject.toml', '[tool.black]\nline-length = 88\n');
  f.put('nested/pyproject.toml', '[tool.black]\nline-length = 20\n');
  f.put('nested/example.py', 'data=[1,2,3,4,5,6,7,8,9,10]\n');
  f.put('change.py', 'value=  4\n');
  f.commit('configs and files');
  const result = runPlan(f);
  assert.equal(result.result.status, 0, result.result.stderr);
  assert.equal(formatted(result, 'nested/example.py'), 'data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]\n');
  assert.equal(readFileSync(join(f.root, 'nested/pyproject.toml'), 'utf8'), '[tool.black]\nline-length = 20\n');
});

test('rejects an anchor outside the current first-parent history', () => {
  const f = fixture();
  const initial = git(f.root, 'branch', '--show-current');
  git(f.root, 'checkout', '-qb', 'side');
  f.put('side.py', 'side=  1\n');
  const side = f.commit('side');
  git(f.root, 'checkout', '-q', initial);
  f.put('change.py', 'value=  9\n');
  f.commit('main');
  const result = runPlan(f, side);
  assert.notEqual(result.result.status, 0);
  assert.match(result.result.stderr, /anchor is not on/);
});

test('uses bounded batches without dropping later files', () => {
  const f = fixture();
  for (let index = 0; index < 56; index++) {
    f.put('bulk/file_' + String(index).padStart(3, '0') + '.py', 'value=  ' + index + '\n');
  }
  f.commit('large push');
  const first = runPlan(f);
  assert.equal(first.result.status, 0, first.result.stderr);
  assert.equal(first.manifest.files.length, 50);
  assert.equal(first.manifest.limited, true);
  for (const item of first.manifest.files) f.put(item.path, formatted(first, item.path));
  f.commit('merge first batch');
  const second = runPlan(f);
  assert.equal(second.result.status, 0, second.result.stderr);
  assert.equal(second.manifest.files.length, 6);
});

test('skips one oversized source without blocking later valid files', () => {
  const f = fixture();
  f.put('bulk/000-huge.py', '#' + 'x'.repeat(25 * 1024 * 1024) + '\n');
  f.put('bulk/001-small.py', 'value=  8\n');
  f.commit('large source');
  const result = runPlan(f);
  assert.equal(result.result.status, 0, result.result.stderr);
  assert.equal(formatted(result, 'bulk/001-small.py'), 'value = 8\n');
  assert.ok(result.manifest.warnings.some((item) => item.path === 'bulk/000-huge.py' && item.reason === 'source-over-25MiB'));
});

test('retries valid files in a failed group using the original common-root Black settings', () => {
  const f = fixture();
  f.put('pyproject.toml', '[tool.black]\nline-length = 88\n');
  f.put('nested/pyproject.toml', '[tool.black]\nline-length = 20\n');
  f.put('bad.py', 'if :\n');
  f.put('nested/good.py', 'data=[1,2,3,4,5,6,7,8,9,10]\n');
  f.commit('mixed validity');
  const result = runPlan(f);
  assert.equal(result.result.status, 0, result.result.stderr);
  assert.equal(formatted(result, 'nested/good.py'), 'data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]\n');
  assert.ok(result.manifest.warnings.some((item) => item.path === 'bad.py' && item.reason === 'black-file-failed'));
  assert.equal(result.manifest.warnings.some((item) => item.path === 'nested/good.py'), false);
});

test('independently recomputes a stale formatter commit against its original base', () => {
  const f = fixture();
  f.put('change.py', 'value=  2\n');
  const originalBase = f.commit('source change');
  const first = runPlan(f);
  assert.equal(first.result.status, 0, first.result.stderr);
  f.put('change.py', formatted(first, 'change.py'));
  const service = f.commit('formatter proposal');
  git(f.root, 'update-ref', 'refs/heads/service', service);
  git(f.root, 'checkout', '-q', '--detach', originalBase);
  f.put('unrelated.txt', 'new source change\n');
  const currentBase = f.commit('source advanced');
  const rerun = runPlan(f, f.anchor, service);
  assert.equal(rerun.result.status, 0, rerun.result.stderr);
  assert.equal(rerun.manifest.base, currentBase);
  assert.equal(rerun.manifest.service, service);
  assert.deepEqual(rerun.manifest.prior, [{ head: service, base: originalBase,
    digest: createHash('sha256').update(JSON.stringify({ configs: first.manifest.configs, files: first.manifest.files })).digest('hex'),
    tree: git(f.root, 'rev-parse', service + '^{tree}') }]);
});
test('rejects a stale formatter commit that changed unrelated data', () => {
  const f = fixture();
  f.put('change.py', 'value=  2\n');
  const originalBase = f.commit('source change');
  const first = runPlan(f);
  assert.equal(first.result.status, 0, first.result.stderr);
  f.put('change.py', formatted(first, 'change.py'));
  f.put('unrelated.txt', 'unexpected data\n');
  const service = f.commit('forged formatter proposal');
  git(f.root, 'update-ref', 'refs/heads/service', service);
  git(f.root, 'checkout', '-q', '--detach', originalBase);
  f.put('unrelated.txt', 'source advanced\n');
  f.commit('source advanced');
  const rerun = runPlan(f, f.anchor, service);
  assert.notEqual(rerun.result.status, 0);
  assert.match(rerun.result.stderr, /unrelated change/);
});

test('preserves a valid declared non-UTF8 Python source encoding', () => {
  const f = fixture();
  f.put('encoded.py', Buffer.from('# -*- coding: cp1252 -*-\nname= "caf\xe9"\n', 'latin1'));
  f.commit('add encoded Python');
  const result = runPlan(f);
  assert.equal(result.result.status, 0, result.result.stderr);
  const item = result.manifest.files.find(entry => entry.path === 'encoded.py');
  assert.ok(item);
  const bytes = readFileSync(join(result.output, 'blobs', item.sha256));
  assert.ok(bytes.includes(0xe9));
  assert.match(bytes.toString('latin1'), /name = "caf/);
});

test('historical plan digests match JavaScript for non-ASCII Python paths', () => {
  const f = fixture();
  f.put('資料/片段.py', 'value=  7\n');
  const originalBase = f.commit('source with unicode path');
  const first = runPlan(f);
  assert.equal(first.result.status, 0, first.result.stderr);
  f.put('資料/片段.py', formatted(first, '資料/片段.py'));
  const service = f.commit('formatter proposal');
  git(f.root, 'update-ref', 'refs/heads/service', service);
  git(f.root, 'checkout', '-q', '--detach', originalBase);
  f.put('unrelated.txt', 'source advanced\n');
  f.commit('source advanced');
  const rerun = runPlan(f, f.anchor, service);
  assert.equal(rerun.result.status, 0, rerun.result.stderr);
  const expected = createHash('sha256')
    .update(JSON.stringify({ configs: first.manifest.configs, files: first.manifest.files }))
    .digest('hex');
  assert.equal(rerun.manifest.prior[0].digest, expected);
});
