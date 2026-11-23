// OpenAI-Codex: exercise the actual release gate without publishing anything.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const workflow = await readFile(new URL('../workflows/release.yml', import.meta.url), 'utf8');
const start = 'if SHA="$sha" node -e \x27\n';
const end = '\n            \x27 <<< "$runs"; then';
assert.equal(workflow.split(start).length, 2);
const script = workflow.split(start)[1].split(end)[0];
assert.ok(script);
const sha = 'a'.repeat(40);
const run = (path, options = {}) => ({
  id: 1, path, head_sha: sha, head_branch: 'Source_Code',
  event: 'push', status: 'completed', conclusion: 'success', ...options,
});
const ci = '.github/workflows/ci.yml';
const matrix = '.github/workflows/python-matrix.yml';
function verify(runs, total = runs.length) {
  const result = spawnSync(process.execPath, ['-e', script], {
    input: JSON.stringify({ total_count: total, workflow_runs: runs }),
    encoding: 'utf8', env: { ...process.env, SHA: sha }, timeout: 5000,
  });
  assert.equal(result.error, undefined);
  return result.status;
}
test('accepts both passing checks for the exact source commit', () => {
  assert.equal(verify([run(ci), run(matrix)]), 0);
});
test('rejects missing, stale, incomplete or failed checks', () => {
  assert.notEqual(verify([run(ci)]), 0);
  assert.notEqual(verify([run(ci), run(matrix, { head_sha: 'b'.repeat(40) })]), 0);
  assert.notEqual(verify([run(ci), run(matrix, { status: 'in_progress', conclusion: null })]), 0);
  assert.notEqual(verify([run(ci), run(matrix, { conclusion: 'failure' })]), 0);
  assert.notEqual(verify([run(ci), run(matrix, { head_branch: 'other' })]), 0);
  assert.notEqual(verify([run(ci), run(matrix, { event: 'pull_request' })]), 0);
  assert.notEqual(verify([run(ci), run(matrix)], 101), 0);
});
test('a newer failing run overrides an older success', () => {
  assert.notEqual(verify([run(ci), run(matrix), run(matrix, { id: 2, conclusion: 'failure' })]), 0);
});

// OpenAI-Codex: package publication must recheck the same exact-commit gates.
const packageWorkflow = await readFile(new URL('../workflows/npm-package.yml', import.meta.url), 'utf8');
const packagePieces = packageWorkflow.split('SHA="$sha" node -e \x27\n').slice(1);
assert.equal(packagePieces.length, 2);
const packageScript = (part) => part.split('\x27 < "$RUNNER_TEMP/package-runs.json"; then')[0]
  .split('\n').map((line) => line.trim()).join('\n').trim();
assert.equal(packageScript(packagePieces[0]), packageScript(packagePieces[1]));
function verifyPackage(runs, total = runs.length) {
  const result = spawnSync(process.execPath, ['-e', packageScript(packagePieces[0])], {
    input: JSON.stringify({ total_count: total, workflow_runs: runs }),
    encoding: 'utf8', env: { ...process.env, SHA: sha }, timeout: 5000,
  });
  assert.equal(result.error, undefined);
  return result.status;
}
test('package publication accepts both passing exact-commit checks', () => {
  assert.equal(verifyPackage([run(ci), run(matrix)]), 0);
});
test('package publication rejects missing, incomplete and stale checks', () => {
  assert.notEqual(verifyPackage([run(ci)]), 0);
  assert.notEqual(verifyPackage([run(ci), run(matrix, { status: 'in_progress', conclusion: null })]), 0);
  assert.notEqual(verifyPackage([run(ci), run(matrix, { head_sha: 'b'.repeat(40) })]), 0);
  assert.notEqual(verifyPackage([run(ci), run(matrix, { head_branch: 'other' })]), 0);
  assert.notEqual(verifyPackage([run(ci), run(matrix, { event: 'pull_request' })]), 0);
});
test('package publication rejects newer failures or incomplete API results', () => {
  assert.notEqual(verifyPackage([run(ci), run(matrix), run(matrix, { id: 2, conclusion: 'failure' })]), 0);
  assert.notEqual(verifyPackage([run(ci), run(matrix)], 3), 0);
  assert.notEqual(verifyPackage([run(ci), run(matrix)], 101), 0);
  assert.notEqual(verifyPackage([run(ci), run(matrix, { id: null })]), 0);
});

// OpenAI-Codex: beta releases must meet the same exact-commit requirements.
const betaJob = workflow.split('  publish-beta:\n')[1].split('  # OpenAI-Codex: publish only complete builds')[0];
// OpenAI-Codex: the verified beta job uses its validated tag.
assert.ok(betaJob.includes('verify-release-assets.mjs "$TAG"'));
const betaStart = 'if BETA_SHA="$sha" node -e \x27\n';
const betaEnd = '\n            \x27 <<< "$runs"; then';
assert.equal(betaJob.split(betaStart).length, 2);
const betaScript = betaJob.split(betaStart)[1].split(betaEnd)[0];
function verifyBeta(runs, total = runs.length) {
  const result = spawnSync(process.execPath, ['-e', betaScript], {
    input: JSON.stringify({ total_count: total, workflow_runs: runs }),
    encoding: 'utf8', env: { ...process.env, BETA_SHA: sha }, timeout: 5000,
  });
  assert.equal(result.error, undefined);
  return result.status;
}
test('beta publication requires passing CI and matrix for its exact commit', () => {
  assert.equal(verifyBeta([run(ci), run(matrix)]), 0);
  assert.notEqual(verifyBeta([run(ci)]), 0);
  assert.notEqual(verifyBeta([run(ci), run(matrix, { head_sha: 'b'.repeat(40) })]), 0);
  assert.notEqual(verifyBeta([run(ci), run(matrix, { status: 'in_progress', conclusion: null })]), 0);
  assert.notEqual(verifyBeta([run(ci), run(matrix, { conclusion: 'failure' })]), 0);
  assert.notEqual(verifyBeta([run(ci), run(matrix), run(matrix, { id: 2, conclusion: 'failure' })]), 0);
  assert.notEqual(verifyBeta([run(ci), run(matrix)], 3), 0);
});

// OpenAI-Codex: fully paginated histories may contain more than one hundred runs.
test('complete long histories retain exact-commit release checks', () => {
  const history = Array.from({ length: 120 }, (_, index) => run(ci, { id: index + 1 }));
  const checks = [...history, run(matrix, { id: 121 })];
  assert.equal(verify(checks), 0);
  assert.equal(verifyBeta(checks), 0);
  assert.notEqual(verifyBeta([...checks, run(matrix, { id: 122, conclusion: 'failure' })]), 0);
  assert.match(workflow, /actions\/workflows\/ci\.yml\/runs\?head_sha=\$sha&branch=Source_Code&per_page=100/);
  assert.match(workflow, /actions\/workflows\/python-matrix\.yml\/runs\?head_sha=\$sha&branch=Source_Code&per_page=100/);
  assert.match(workflow, /gh api --paginate --slurp/);
});

// OpenAI-Codex: exercise the actual paginated query and reject truncated or duplicate pages.
test('workflow history query combines complete pages and fails closed on partial data', () => {
  const directory = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'release-page-test-'));
  const gh = join(directory, 'gh');
  writeFileSync(gh, '#!/bin/sh\ncase "$*" in *ci.yml*) printf "%s" "$CI_PAGES";; *python-matrix.yml*) printf "%s" "$MATRIX_PAGES";; *) exit 2;; esac\n');
  chmodSync(gh, 0o755);
  const query = betaJob.split('for attempt in $(seq 1 60); do\n')[1]
    ?.split('\n            if BETA_SHA=')[0];
  assert.ok(query);
  function collect(ciPages, matrixPages) {
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c',
      query + '\nprintf "%s" "$runs"'], {
      encoding: 'utf8', timeout: 5000,
      env: { ...process.env, PATH: directory + ':' + process.env.PATH,
        GITHUB_REPOSITORY: 'KingsleyHK0323/Multimedia_Downloader', sha,
        CI_PAGES: JSON.stringify(ciPages), MATRIX_PAGES: JSON.stringify(matrixPages) },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  const twoPages = [{ total_count: 2, workflow_runs: [run(ci, { id: 1 })] },
    { total_count: 2, workflow_runs: [run(ci, { id: 2 })] }];
  const matrixPage = [{ total_count: 1, workflow_runs: [run(matrix, { id: 3 })] }];
  assert.equal(collect(twoPages, matrixPage).total_count, 3);
  assert.deepEqual(collect([twoPages[0]], matrixPage), {});
  assert.deepEqual(collect([twoPages[0], { ...twoPages[1], total_count: 3 }], matrixPage), {});
  assert.deepEqual(collect([twoPages[0], { ...twoPages[1], workflow_runs: [run(ci, { id: 1 })] }], matrixPage), {});
});
