// OpenAI-Codex: test actual branch cleanup decisions against mocked APIs.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = await readFile(new URL('../workflows/clean-merged-branches.yml', import.meta.url), 'utf8');
const marker = '          script: |\n';
assert.equal(workflow.split(marker).length, 2);
const script = workflow.split(marker)[1].split('\n').map(line => line.startsWith('            ') ? line.slice(12) : line).join('\n');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const fn = new AsyncFunction('context', 'github', 'core', script);
const sha = 'a'.repeat(40);
function makePr(branch = 'feature') {
  return { merged: true, head: { ref: branch, sha, repo: { full_name: 'owner/repo' } } };
}
async function invoke(pr, actualSha = sha, dispatch = false, dryRun = 'true') {
  const deleted = [];
  const context = { eventName: dispatch ? 'workflow_dispatch' : 'pull_request_target',
    repo: { owner: 'owner', repo: 'repo' },
    payload: { repository: { full_name: 'owner/repo' }, pull_request: pr } };
  const github = { rest: { pulls: { get: async () => ({ data: pr }) }, git: {
    getRef: async () => ({ data: { object: { sha: actualSha } } }),
    deleteRef: async ({ ref }) => deleted.push(ref),
  } } };
  const core = { info() {}, warning() {} };
  if (dispatch) { process.env.MANUAL_PR = '12'; process.env.DRY_RUN = dryRun; }
  await fn(context, github, core);
  return deleted;
}
test('deletes only a merged, unchanged local feature branch', async () => {
  assert.deepEqual(await invoke(makePr()), ['heads/feature']);
  assert.deepEqual(await invoke(makePr(), 'b'.repeat(40)), []);
  const fork = makePr(); fork.head.repo.full_name = 'other/repo';
  assert.deepEqual(await invoke(fork), []);
});
test('never deletes either permanent branch', async () => {
  for (const branch of ['Source_Code', 'Multimedia_Downloader_Web_Preview']) {
    assert.deepEqual(await invoke(makePr(branch)), []);
  }
});
test('manual cleanup rejects unmerged pull requests', async () => {
  const pr = makePr(); pr.merged = false;
  await assert.rejects(() => invoke(pr, sha, true));
});

// OpenAI-Codex: verify dispatch defaults to inspection and explicit cleanup remains available.
test('manual dry run preserves eligible branches', async () => {
  assert.deepEqual(await invoke(makePr(), sha, true), []);
  assert.deepEqual(await invoke(makePr(), sha, true, 'false'), ['heads/feature']);
});

// OpenAI-Codex: a deleted source repository must never authorize cleanup.
test('preserves a branch when the PR source repository is unavailable', async () => {
  const pr = makePr();
  pr.head.repo = null;
  assert.deepEqual(await invoke(pr), []);
});
