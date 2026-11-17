// OpenAI-Codex_Fork_GitHub_REPO: mock-only release pipeline checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateReleaseInputs } from './release-input-guard.mjs';

const valid = {
  tag: 'v4.3.21',
  sourceSha: 'a'.repeat(40),
  workflowSha: 'a'.repeat(40),
  ref: 'refs/tags/v4.3.21',
};

test('accepts an exact canonical tag dispatch', () => {
  assert.deepEqual(validateReleaseInputs(valid), {
    tag: 'v4.3.21',
    sourceSha: 'a'.repeat(40),
    version: '4.3.21',
  });
});

test('rejects malformed tags and shell-like input as data', () => {
  for (const tag of ['', '4.3.21', 'v04.3.21', 'v4.03.21', 'v4.3.021', 'v4.3.21-rc1', 'v4.3.21+1', 'v4.3.21 ', 'v4.3.21\n', 'v1.2.3";echo INJECTED;#', 'v1.2.3$(echo INJECTED)']) {
    assert.throws(() => validateReleaseInputs({ ...valid, tag, ref: 'refs/tags/' + tag }));
  }
});

test('requires a lowercase full SHA matching the workflow source', () => {
  for (const sourceSha of ['', 'A'.repeat(40), 'a'.repeat(39), 'g'.repeat(40)]) {
    assert.throws(() => validateReleaseInputs({ ...valid, sourceSha, workflowSha: sourceSha }));
  }
  assert.throws(() => validateReleaseInputs({ ...valid, workflowSha: 'b'.repeat(40) }));
});

test('rejects a branch dispatch or a different tag ref', () => {
  assert.throws(() => validateReleaseInputs({ ...valid, ref: 'refs/heads/Source_Code' }));
  assert.throws(() => validateReleaseInputs({ ...valid, ref: 'refs/tags/v4.3.20' }));
});

test('legacy release workflow has no tag, reusable, or write-enabled trigger', () => {
  const legacy = readFileSync(new URL('../workflows/release.yml', import.meta.url), 'utf8');
  assert.match(legacy, /name: Legacy release workflow \(disabled\)/);
  assert.doesNotMatch(legacy, /^  push:/m);
  assert.doesNotMatch(legacy, /^  workflow_call:/m);
  assert.doesNotMatch(legacy, /contents:\s*write/);
});
