// OpenAI-Codex: exercise workflow checkout provenance in isolated Git fixtures.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const cross = readFileSync(new URL('../workflows/cross-branch-checks.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const staged = readFileSync(new URL('../workflows/staged-build-only.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const directory = () => mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'workflow-ref-guard-'));

function shellBlock(source, start, end) {
  assert.equal(source.split(start).length, 2);
  const block = source.split(start)[1].split(end)[0];
  const body = block.split('        shell: bash\n        run: |\n')[1];
  assert.ok(body);
  assert.doesNotMatch(body, /\$\{\{/);
  return body.split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
}

test('preview checks execute only commits from trusted website history', () => {
  const start = '      # BEGIN TRUSTED_PREVIEW_REF\n';
  const end = '      # END TRUSTED_PREVIEW_REF';
  const script = shellBlock(cross, start, end);
  const before = cross.split(start)[0];
  assert.match(before, /ref: Multimedia_Downloader_Website\n          fetch-depth: 0\n          persist-credentials: false/);

  const repo = join(directory(), 'repo');
  mkdirSync(repo);
  const env = { ...process.env, GIT_AUTHOR_NAME: 'CI Fixture', GIT_AUTHOR_EMAIL: 'ci@example.invalid',
    GIT_COMMITTER_NAME: 'CI Fixture', GIT_COMMITTER_EMAIL: 'ci@example.invalid',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.BASH_ENV;
  delete env.ENV;
  function git(...args) {
    const result = spawnSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', ...args], {
      env, encoding: 'utf8', timeout: 5000,
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git('init', '--quiet', '-b', 'preview');
  git('commit', '--allow-empty', '--quiet', '-m', 'website base');
  const ancestor = git('rev-parse', 'HEAD');
  git('commit', '--allow-empty', '--quiet', '-m', 'website update');
  const tip = git('rev-parse', 'HEAD');
  git('checkout', '--quiet', '--orphan', 'untrusted');
  git('commit', '--allow-empty', '--quiet', '-m', 'untrusted');
  const untrusted = git('rev-parse', 'HEAD');
  git('checkout', '--quiet', 'preview');

  function verify(overrides) {
    git('checkout', '--quiet', 'preview');
    const input = { EVENT_NAME: 'workflow_dispatch', RUN_BRANCH: '', RUN_REPOSITORY: '',
      THIS_REPOSITORY: 'owner/repo', RUN_SHA: '', RUN_CONCLUSION: '', REQUESTED_SHA: '', ...overrides };
    const result = spawnSync('bash', ['--noprofile', '--norc', '-c', script], {
      cwd: repo, env: { ...env, ...input }, encoding: 'utf8', timeout: 5000,
    });
    if (result.error) throw result.error;
    return result;
  }

  assert.equal(verify({ REQUESTED_SHA: ancestor }).status, 0);
  assert.equal(git('rev-parse', 'HEAD'), ancestor);
  assert.notEqual(verify({ REQUESTED_SHA: untrusted }).status, 0);
  assert.equal(git('rev-parse', 'HEAD'), tip);
  assert.notEqual(verify({ REQUESTED_SHA: 'v1$(printf INJECTED)' }).status, 0);
  const run = { EVENT_NAME: 'workflow_run', RUN_BRANCH: 'Multimedia_Downloader_Website',
    RUN_REPOSITORY: 'owner/repo', RUN_SHA: ancestor, RUN_CONCLUSION: 'success' };
  assert.equal(verify(run).status, 0);
  assert.equal(git('rev-parse', 'HEAD'), ancestor);
  assert.notEqual(verify({ ...run, RUN_REPOSITORY: 'fork/repo' }).status, 0);
  assert.notEqual(verify({ ...run, RUN_CONCLUSION: 'failure' }).status, 0);
  assert.notEqual(verify({ ...run, RUN_SHA: '' }).status, 0);
  assert.equal(verify({ EVENT_NAME: 'push', REQUESTED_SHA: untrusted }).status, 0);
  assert.equal(git('rev-parse', 'HEAD'), tip);
});

test('staged builds bind requested source to the dispatched workflow commit', () => {
  const script = shellBlock(staged, '      - id: validate\n', '\n  build:');
  assert.ok(staged.includes('          ref: ${{ github.sha }}\n          persist-credentials: false'));
  function verify(source, workflow, tag) {
    const output = join(directory(), 'github-output');
    const env = { ...process.env, SOURCE_SHA: source, WORKFLOW_SHA: workflow,
      TAG: tag, GITHUB_OUTPUT: output };
    delete env.BASH_ENV;
    delete env.ENV;
    const result = spawnSync('bash', ['--noprofile', '--norc', '-c', script], {
      env, encoding: 'utf8', timeout: 5000,
    });
    if (result.error) throw result.error;
    return result.status;
  }
  const sha = 'a'.repeat(40);
  assert.equal(verify(sha, sha, 'v4.3.22'), 0);
  assert.notEqual(verify('b'.repeat(40), sha, 'v4.3.22'), 0);
  assert.notEqual(verify('$(printf INJECTED)', sha, 'v4.3.22'), 0);
  assert.notEqual(verify(sha, sha, 'v4.3.22-rc1'), 0);
});
