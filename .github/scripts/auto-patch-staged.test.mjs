// OpenAI-Codex_health_release_architecture: verify the connected staged patch workflow uses reviewed code.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = name => readFileSync('.github/' + name, 'utf8');
const workflow = read('workflows/auto-patch-staged.yml');
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

test('keeps writer and finalizer stopped before App token creation', () => {
  const stop = workflow.indexOf('name: Keep patch App writing disabled');
  const fail = workflow.indexOf('          exit 1', stop);
  const token = workflow.indexOf('name: Create a repository-scoped App token');
  assert.ok(stop > 0 && fail > stop && token > fail);
  assert.match(workflow, /vars\.AUTOMATION_PATCH_PR_MODE == 'enabled'/);
  assert.match(workflow, /group: automation-service-reconcile/);
  assert.doesNotMatch(workflow, /actions\/checkout|pull_request_target|import\(/);
  assert.match(workflow, /\[\[ "\$tip" == "\$WORKFLOW_SHA" \]\]/);
  const finalizer = workflow.indexOf('const state = await reconcilePatchReleases');
  const writer = workflow.indexOf('const result = await reconcileVersionPr', finalizer);
  assert.ok(finalizer > token && writer > finalizer);
  assert.match(workflow.slice(finalizer, writer), /state\.status !== 'ready'/);
  assert.match(workflow.slice(writer), /verifiedCompleted: state\.completed/);
  assert.match(workflow.slice(writer), /verifiedSkipped: state\.skipped/);
});

test('inlines the reviewed helpers without changes', () => {
  const guard = read('scripts/verify-tag-protection.mjs');
  const guardStart = guard.indexOf('const REPO'), guardEnd = guard.indexOf('export function verifyTagProtection');
  assert.ok(guardStart >= 0 && guardEnd > guardStart);
  assert.equal(block('TAG PROTECTION HELPER'),
    compact(guard.slice(guardStart, guardEnd).replace(/^export /gm, '').trimEnd()));
  const uploader = read('scripts/upload-release-assets.mjs');
  const tagLine = uploader.split('\n').find(line => line.startsWith('const TAG = '));
  const start = uploader.indexOf('export function expectedNames(');
  const end = uploader.indexOf('export async function verifyInventory(', start);
  assert.ok(tagLine && start >= 0 && end > start);
  assert.equal(block('EXPECTED RELEASE NAMES'),
    compact(tagLine + '\n' + uploader.slice(start, end).replace(/^export /gm, '').trimEnd()));
  for (const [name, file] of [
    ['SOURCE AUTHORIZATION HELPER', 'patch-source-authorization.mjs'],
    ['PATCH POLICY', 'patch-release-policy.mjs'],
    ['PATCH CANDIDATE POLICY', 'patch-candidate-policy.mjs'],
    ['PUSH CHECK POLICY', 'patch-push-checks.mjs'],
    ['MERGED PATCH INSPECTOR', 'inspect-merged-patch.mjs'],
    ['PUBLISHED RELEASE VERIFIER', 'verify-published-patch.mjs'],
    ['PATCH RELEASE FINALIZER', 'patch-release-finalizer.mjs'],
    ['VERSION PR WRITER', 'auto-patch-pr-writer.mjs'],
  ]) assert.equal(block(name), compact(exact(file)));
});
