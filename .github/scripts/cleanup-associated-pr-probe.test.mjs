// OpenAI-Codex_health_release_architecture: test the read-only ref-association probe with mock APIs.
// OpenAI-Codex: assert the explicit fail-closed errors for changed or absent associations.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = (await readFile(new URL('../workflows/cleanup-associated-pr-probe.yml', import.meta.url), 'utf8'))
  .replaceAll('\r\n', '\n');
const marker = '          script: |\n';
assert.equal(workflow.split(marker).length, 2);
const script = workflow.split(marker)[1].split('\n').map((line) => line.startsWith('            ') ? line.slice(12) : line).join('\n');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const execute = new AsyncFunction('context', 'github', 'core', script);
const full = 'KingsleyHK0323/Multimedia_Downloader';
const branch = 'automation/protected-workflows';
const sha = 'a'.repeat(40);
function harness(options = {}) {
  const pr = { number: 75, state: 'open', user: { id: 157894869 },
    head: { ref: branch, sha, repo: { id: 1251103365, full_name: full } },
    base: { ref: 'Source_Code', repo: { id: 1251103365, full_name: full } } };
  const state = { pr, notices: [], reads: 0, ...options };
  const context = { eventName: 'pull_request', repo: { owner: 'KingsleyHK0323', repo: 'Multimedia_Downloader' },
    payload: { repository: { id: 1251103365, full_name: full }, sender: { id: 157894869 }, pull_request: structuredClone(pr) } };
  const github = {
    rest: {
      pulls: { get: async () => {
        state.reads++;
        if (state.movePr && state.reads > 1) state.pr.head.sha = 'b'.repeat(40);
        return { data: state.pr };
      } },
      git: { getRef: async () => ({ data: { ref: 'refs/heads/' + branch, object: { type: 'commit', sha } } }) },
    },
    graphql: async (query, args) => {
      assert.match(query, /associatedPullRequests/);
      assert.equal(args.qualifiedName, 'refs/heads/' + branch);
      return { repository: { nameWithOwner: full, ref: {
        name: branch, prefix: 'refs/heads/', target: { oid: state.badOid ? 'b'.repeat(40) : sha },
        associatedPullRequests: { totalCount: 1,
          nodes: state.missingPr ? [] : [{ number: 75, state: 'OPEN', headRefName: branch,
            baseRefName: 'Source_Code', headRepository: { nameWithOwner: full }, baseRepository: { nameWithOwner: full } }],
          pageInfo: { hasNextPage: false },
        },
      } } };
    },
  };
  return { state, context, invoke: () => execute(context, github, { notice: (msg) => state.notices.push(msg) }) };
}
test('observes the exact current same-repository PR and branch', async () => {
  const h = harness(); await h.invoke();
  assert.equal(h.state.reads, 2);
  assert.ok(h.state.notices.some((msg) => msg.includes('exact same-repo PR')));
});
test('rejects a missing association, changed branch or changed PR', async () => {
  for (const options of [{ missingPr: true }, { badOid: true }, { movePr: true }]) {
    const h = harness(options); await assert.rejects(h.invoke(), /cannot confirm the exact open PR|pull request changed/i);
  }
});
test('rejects fork and non-owner events before using the API', async () => {
  for (const modify of [
    (pr) => { pr.user.id = 7; },
    (pr) => { pr.head.repo.id = 7; },
    (pr) => { pr.base.ref = 'Multimedia_Downloader_Website'; },
  ]) {
    const h = harness(); modify(h.context.payload.pull_request);
    await assert.rejects(h.invoke(), /identity is invalid/);
    assert.equal(h.state.reads, 0);
  }
});
test('rejects events sent by anyone other than the repository owner', async () => {
  const h = harness(); h.context.payload.sender.id = 7;
  await assert.rejects(h.invoke(), /identity is invalid/);
  assert.equal(h.state.reads, 0);
});
test('runs only on the approved PR with read-only permissions and no checkout or secret', () => {
  assert.match(workflow, /pull_request:\n    branches: \[Source_Code\]/);
  assert.match(workflow, /contents: read\n  pull-requests: read/);
  assert.match(workflow, /github\.event\.pull_request\.head\.ref == 'automation\/protected-workflows'/);
  assert.match(workflow, /github\.event\.sender\.id == 157894869/);
  assert.doesNotMatch(workflow, /actions\/checkout|secrets\.|contents: write|pull-requests: write/);
});
