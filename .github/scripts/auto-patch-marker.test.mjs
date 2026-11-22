// OpenAI-Codex_health_release_architecture: test the actual release guard against isolated Git history.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const workflow = readFileSync(new URL('../workflows/auto-patch-release.yml', import.meta.url), 'utf8')
  .replaceAll('\r\n', '\n');

function extract(name) {
  const begin = '          # BEGIN ' + name + '\n';
  const end = '          # END ' + name + '\n';
  assert.equal(workflow.split(begin).length, 2, 'missing or duplicate begin marker: ' + name);
  const rest = workflow.split(begin)[1];
  assert.equal(rest.split(end).length, 2, 'missing or duplicate end marker: ' + name);
  return rest.split(end)[0].split('\n').filter((line) => line.length > 0).map((line) => {
    assert.ok(line.startsWith('          '), 'unexpected workflow indentation');
    return line.slice(10);
  }).join('\n');
}

const script = [
  'set -euo pipefail',
  extract('PATCH_RELEASE_NUMBER'),
  extract('PATCH_RELEASE_LOOKUP'),
  'printf "RESULT:%s\\n" "$release_commit"',
].join('\n');

function makeRepo() {
  const root = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'patch-release-marker-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('config', 'user.name', 'Release Marker Test');
  git('config', 'user.email', 'release-marker-test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  const commit = (subject, body) => {
    git('commit', '--quiet', '--allow-empty', '-m', subject, '-m', body);
    return git('rev-parse', 'HEAD');
  };
  const pointRemote = () => git('update-ref', 'refs/remotes/origin/Source_Code', 'HEAD');
  commit('test root', 'Test fixture only.');
  return { root, commit, pointRemote };
}

function check(root, number) {
  const env = { ...process.env };
  delete env.PR_NUMBER;
  if (number !== undefined) env.PR_NUMBER = number;
  const result = spawnSync('bash', ['-c', script], {
    cwd: root, env, encoding: 'utf8', timeout: 5000,
  });
  if (result.error) throw result.error;
  return result;
}

test('matches complete marker lines and does not confuse PR number prefixes', () => {
  const repo = makeRepo();
  const ten = repo.commit('release ten', 'Automatic patch release for merged PR #10');
  repo.pointRemote();
  let result = check(repo.root, '1');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'RESULT:\n');
  result = check(repo.root, '10');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'RESULT:' + ten + '\n');

  const one = repo.commit('release one', 'Automatic patch release for merged PR #1');
  const newestTen = repo.commit('release ten again', 'Automatic patch release for merged PR #10');
  repo.commit('not an exact marker', 'Automatic patch release for merged PR #1 (draft)');
  repo.pointRemote();
  result = check(repo.root, '1');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'RESULT:' + one + '\n');
  result = check(repo.root, '10');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'RESULT:' + newestTen + '\n');
});

test('rejects missing or noncanonical PR numbers before the Git lookup', () => {
  const root = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'patch-release-invalid-'));
  for (const value of [undefined, '', '0', '-1', '01', '1.0', '1e2', ' 1', '1\n2', '1;echo bad']) {
    const result = check(root, value);
    assert.notEqual(result.status, 0, 'unexpected acceptance: ' + String(value));
    assert.match(result.stdout, /::error::Invalid PR number\./);
    assert.doesNotMatch(result.stderr, /fatal:/i);
  }
});
