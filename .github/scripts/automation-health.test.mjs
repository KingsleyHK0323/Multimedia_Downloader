// OpenAI-Codex: exercise report writes without touching GitHub.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
const text = readFileSync('.github/workflows/automation-health.yml', 'utf8');
const script = text.split('          script: |\n')[1].split('\n').map(line => line.slice(12)).join('\n');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
async function execute(run, existing) {
  const writes = [];
  const github = { rest: {
    actions: { listWorkflowRuns: async () => ({ data: { workflow_runs: run ? [run] : [] } }) },
    repos: {
      getContent: async () => { if (!existing) { const e = new Error('missing'); e.status = 404; throw e; } return { data: existing }; },
      createOrUpdateFileContents: async args => writes.push(args),
    },
  } };
  const core = { notice() {}, info() {} };
  await new AsyncFunction('context', 'github', 'core', script)({ repo: { owner: 'o', repo: 'r' } }, github, core);
  return writes;
}
const run = { id: 123, status: 'completed', conclusion: 'success', html_url: 'https://github.com/o/r/actions/runs/123' };
test('creates deterministic report only when a run exists', async () => {
  assert.deepEqual(await execute(null), []);
  const writes = await execute(run);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].branch, 'Source_Code');
  const report = JSON.parse(Buffer.from(writes[0].content, 'base64').toString());
  assert.equal(report.run_id, 123);
  assert.equal(report.conclusion, 'success');
});
test('avoids redundant commits and checks file identity', async () => {
  const first = (await execute(run))[0];
  const existing = { type: 'file', encoding: 'base64', sha: 'abc', content: first.content };
  assert.deepEqual(await execute(run, existing), []);
  const changed = await execute({ ...run, conclusion: 'failure' }, existing);
  assert.equal(changed[0].sha, 'abc');
  await assert.rejects(execute(run, { ...existing, type: 'dir' }));
});
