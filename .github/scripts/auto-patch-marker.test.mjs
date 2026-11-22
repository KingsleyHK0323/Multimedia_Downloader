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

// OpenAI-Codex_ruleset_architecture: reject App-authored PRs before any release operation.
const authorGuard = extract('PATCH_RELEASE_BOT_GUARD');
const guardScript = [
  'set -euo pipefail',
  'gh() {',
  '  if [[ "${MOCK_API_FAIL:-false}" == "true" ]]; then return 1; fi',
  '  [[ "$1" == "api" && "$2" == "repos/example/repo/pulls/${PR_NUMBER}" ]] || return 1',
  '  printf "%s" "$MOCK_PR_JSON"',
  '}',
  authorGuard,
  'printf "GUARD PASSED\\n"',
].join('\n');

function checkAuthorGuard(pr, eventName, options = {}) {
  const env = {
    PATH: process.env.PATH,
    PR_NUMBER: options.prNumber ?? '42',
    GITHUB_REPOSITORY: 'example/repo',
    GITHUB_EVENT_NAME: eventName,
    MOCK_API_FAIL: options.apiFailure ? 'true' : 'false',
    MOCK_PR_JSON: typeof pr === 'string' ? pr : JSON.stringify(pr),
  };
  const result = spawnSync('bash', ['-c', guardScript], {
    env, encoding: 'utf8', timeout: 5000,
  });
  if (result.error) throw result.error;
  return result;
}

test('excludes the automation App author for both event and dispatch paths', () => {
  assert.ok(workflow.indexOf('# BEGIN PATCH_RELEASE_BOT_GUARD') < workflow.indexOf('- uses: actions/checkout@v7'));
  for (const eventName of ['pull_request_target', 'workflow_dispatch']) {
    const result = checkAuthorGuard({
      user: { id: 359694872, login: 'kingsley-multimedia-automation[bot]', type: 'Bot' },
      labels: [{ name: 'release:patch' }],
    }, eventName);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /Automation App PRs cannot trigger automatic patch releases/);
    assert.doesNotMatch(result.stdout, /GUARD PASSED/);
  }
});

test('allows non-App PR authors for both source paths', () => {
  for (const eventName of ['pull_request_target', 'workflow_dispatch']) {
    for (const author of [
      { id: 157894869, login: 'KingsleyHK0323', type: 'User' },
      { id: 49699333, login: 'dependabot[bot]', type: 'Bot' },
    ]) {
      const result = checkAuthorGuard({ user: author }, eventName);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /GUARD PASSED/);
    }
  }
});

test('fails closed on invalid or unavailable source author metadata', () => {
  for (const fixture of [{}, { user: null }, { user: {} }, { user: { id: '359694872' } },
    { user: { id: null } }, { user: { id: 0 } }, { user: { id: 1.5 } }, '{invalid']) {
    const result = checkAuthorGuard(fixture, 'workflow_dispatch');
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /GUARD PASSED/);
  }
  const unavailable = checkAuthorGuard({ user: { id: 157894869 } }, 'workflow_dispatch', { apiFailure: true });
  assert.notEqual(unavailable.status, 0);
  const invalidNumber = checkAuthorGuard({ user: { id: 157894869 } }, 'workflow_dispatch', { prNumber: '01' });
  assert.notEqual(invalidNumber.status, 0);
});

