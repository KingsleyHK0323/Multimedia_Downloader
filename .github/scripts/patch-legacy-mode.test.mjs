// OpenAI-Codex_health_release_architecture: keep legacy and App patch writers mutually exclusive.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync('.github/workflows/auto-patch-release.yml', 'utf8');
test('defaults to legacy and fails closed for an unknown mode', () => {
  const invalid = workflow.split('  reject-unsupported-mode:\n')[1]?.split('\n  bump:')[0];
  const bump = workflow.split('  bump:\n')[1]?.split('\n    runs-on:')[0];
  assert.ok(invalid && bump);
  for (const value of ["''", "'legacy'", "'enabled'"]) assert.ok(invalid.includes('!= ' + value));
  assert.match(invalid, /exit 1/);
  assert.match(bump, /vars\.AUTOMATION_PATCH_PR_MODE == '' \|\| vars\.AUTOMATION_PATCH_PR_MODE == 'legacy'/);
  assert.doesNotMatch(bump, /AUTOMATION_PATCH_PR_MODE == 'enabled'/);
  assert.match(workflow, /source_author_id.*359694872/);
  assert.match(workflow, /needs: bump/);
});
