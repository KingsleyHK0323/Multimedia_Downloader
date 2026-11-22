// OpenAI-Codex_health_release_architecture: verify the staged CAS workflow matches reviewed modules.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = name => readFileSync('.github/' + name, 'utf8');
const workflow = read('workflows/auto-patch-cas-staged.yml');
const exact = name => read('scripts/' + name).replace(/^export /gm, '')
  .replace(/^import .*;\n/gm, '').trimEnd();
function block(name) {
  const begin = workflow.indexOf('            // BEGIN EXACT ' + name + '\n');
  const end = workflow.indexOf('            // END EXACT ' + name + '\n');
  assert.ok(begin >= 0 && end > begin);
  const lines = workflow.slice(begin, end).split('\n').slice(1);
  assert.equal(lines.pop(), '');
  return lines.map(line => {
    assert.equal(line.slice(0, 12), '            ');
    return line.slice(12);
  }).filter(Boolean).join('\n');
}
const compact = text => text.split('\n').filter(Boolean).join('\n');

test('keeps the App CAS unconditionally stopped before token creation', () => {
  const stop = workflow.indexOf('name: Keep patch App CAS disabled');
  const fail = workflow.indexOf('          exit 1', stop);
  const token = workflow.indexOf('name: Create a repository-scoped App token');
  assert.ok(stop > 0 && fail > stop && token > fail);
  assert.match(workflow, /vars\.AUTOMATION_PATCH_PR_MODE == 'enabled'/);
  assert.match(workflow, /vars\.AUTOMATION_PATCH_CAS == 'enabled'/);
  assert.match(workflow, /group: automation-service-reconcile/);
  assert.doesNotMatch(workflow, /actions\/checkout|pull_request_target/);
  assert.match(workflow, /\[\[ "\$tip" == "\$WORKFLOW_SHA" \]\]/);
});

test('inlines exactly the reviewed policy, push checks, candidate and coordinator', () => {
  for (const [name, file] of [
    ['SOURCE AUTHORIZATION HELPER', 'patch-source-authorization.mjs'],
    ['PATCH POLICY', 'patch-release-policy.mjs'],
    ['PATCH CANDIDATE POLICY', 'patch-candidate-policy.mjs'],
    ['PUSH CHECK POLICY', 'patch-push-checks.mjs'],
    ['PATCH CAS COORDINATOR', 'auto-patch-cas.mjs'],
  ]) assert.equal(block(name), compact(exact(file)));
});
