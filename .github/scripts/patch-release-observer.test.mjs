// OpenAI-Codex_health_release_architecture: test merge observation without creating releases.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../workflows/patch-release-observer.yml', import.meta.url), 'utf8')
  .replaceAll('\r\n', '\n');
const begin = '          # BEGIN PATCH_OBSERVER_VALIDATION\n';
const end = '          # END PATCH_OBSERVER_VALIDATION';
assert.equal(workflow.split(begin).length, 2);
const script = workflow.split(begin)[1].split(end)[0].split('\n').map((line) => line.slice(10)).join('\n');
const valid = {
  OBSERVED_REPOSITORY: 'KingsleyHK0323/Multimedia_Downloader',
  OBSERVED_REPOSITORY_ID: '1251103365', OBSERVED_BASE_ID: '1251103365',
  OBSERVED_HEAD_ID: '1251103365', OBSERVED_HEAD_REF: 'automation/protected-workflows',
  OBSERVED_SENDER_ID: '157894869',
  OBSERVED_REF: 'refs/heads/Source_Code', OBSERVED_BASE_REF: 'Source_Code',
  OBSERVED_ACTION: 'closed', OBSERVED_MERGED: 'true', OBSERVED_NUMBER: '77',
  OBSERVED_AUTHOR_ID: '157894869', OBSERVED_MERGE_SHA: 'a'.repeat(40),
  OBSERVED_HEAD_SHA: 'b'.repeat(40), OBSERVED_LABEL: 'true',
};
const invoke = (changes = {}) => execFileSync('bash', ['-c', script], {
  env: { ...process.env, ...valid, ...changes }, encoding: 'utf8', stdio: 'pipe',
});

test('validates authentic-looking merge metadata for either label snapshot', () => {
  assert.match(invoke(), /no release action was requested/);
  assert.match(invoke({ OBSERVED_LABEL: 'false' }), /no release action was requested/);
});

test('rejects malformed, out-of-scope, unmerged, and App-authored events', () => {
  for (const change of [
    { OBSERVED_REPOSITORY_ID: '1' }, { OBSERVED_BASE_ID: '1' }, { OBSERVED_HEAD_ID: '1' },
    { OBSERVED_SENDER_ID: '1' }, { OBSERVED_HEAD_REF: 'automation/other' },
    { OBSERVED_REF: 'refs/heads/source_code' }, { OBSERVED_BASE_REF: 'other' },
    { OBSERVED_ACTION: 'opened' }, { OBSERVED_MERGED: 'false' },
    { OBSERVED_NUMBER: '0' }, { OBSERVED_NUMBER: '1;exit 0' },
    { OBSERVED_AUTHOR_ID: '359694872' }, { OBSERVED_MERGE_SHA: 'A'.repeat(40) },
    { OBSERVED_HEAD_SHA: 'a'.repeat(39) }, { OBSERVED_LABEL: 'TRUE' },
  ]) assert.throws(() => invoke(change));
});

test('uses only merged pull-request events and does not request privileges', () => {
  assert.match(workflow, /pull_request:\n    branches: \[Source_Code\]\n    types: \[closed\]/);
  assert.match(workflow, /github\.event\.pull_request\.merged == true/);
  assert.match(workflow, /patch-event-\$\{\{ github\.event\.pull_request\.number \}\}/);
  assert.match(workflow, /permissions: \{\}/);
  assert.doesNotMatch(workflow, /actions\/checkout|secrets\.|contents: write|pull-requests: write/);
});
