// OpenAI-Codex_format_architecture: check the formatter's opt-in and credential boundaries.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const legacy = readFileSync('.github/workflows/auto-format.yml', 'utf8').replaceAll('\r\n', '\n');
const main = readFileSync('.github/workflows/formatter-app-cas.yml', 'utf8').replaceAll('\r\n', '\n');
const plan = readFileSync('.github/workflows/formatter-plan.yml', 'utf8').replaceAll('\r\n', '\n');
const matrix = readFileSync('.github/workflows/python-matrix.yml', 'utf8').replaceAll('\r\n', '\n');

test('legacy formatting remains the default and keeps its original concurrency', () => {
  assert.match(legacy, /group: auto-format-\$\{\{ github\.ref \}\}/);
  assert.match(legacy, /cancel-in-progress: false/);
  assert.match(legacy, /vars\.AUTOMATION_FORMAT_MODE == '' \|\| vars\.AUTOMATION_FORMAT_MODE == 'legacy'/);
  assert.match(legacy, /github\.actor != 'github-actions\[bot\]'/);
  assert.match(main, /invalid-mode:/);
  assert.match(main, /vars\.AUTOMATION_FORMAT_MODE != 'enabled'/);
});

test('two independent, unprivileged planner calls retain their own artifact identities', () => {
  assert.equal((main.match(/uses: \.\/\.github\/workflows\/formatter-plan\.yml/g) || []).length, 2);
  assert.match(main, /replica: one/);
  assert.match(main, /replica: two/);
  assert.match(plan, /artifact_id: \$\{\{ steps\.retained\.outputs\.artifact-id \}\}/);
  assert.match(plan, /artifact_digest: \$\{\{ steps\.retained\.outputs\.artifact-digest \}\}/);
  assert.doesNotMatch(plan, /secrets\.|create-github-app-token|contents: write|pull-requests: write/);
  assert.match(main, /ids\[0\] === ids\[1\]/);
  assert.match(main, /item\.digest !== 'sha256:' \+ digests\[index\]/);
  assert.match(main, /item\.workflow_run\?\.id !== context\.runId/);
});

test('App credentials follow validation and are limited to repository contents and PRs', () => {
  const verify = main.indexOf('name: Verify trusted reconciliation module');
  const artifacts = main.indexOf('name: Validate and extract artifact data');
  const tip = main.indexOf('name: Verify source tip before App token');
  const token = main.indexOf('name: Create repository-scoped App token');
  const run = main.indexOf('name: Reconcile verified formatter plan');
  assert.ok(verify >= 0 && verify < artifacts && artifacts < tip && tip < token && token < run);
  assert.match(main, /permission-contents: write/);
  assert.match(main, /permission-pull-requests: write/);
  assert.doesNotMatch(main, /permission-workflows: write|permission-checks: write/);
  assert.match(main, /persist-credentials: false/);
  assert.match(main, /!cancelled\(\)/);
});

test('approved service branch runs the actual push matrix', () => {
  assert.match(matrix, /branches: \[Source_Code, automation\/protected-workflows\]/);
  assert.match(main, /head_branch == 'automation\/protected-workflows'/);
  assert.match(main, /group: automation-service-reconcile/);
});

const selectorStart = '            // BEGIN FORMAT_ARTIFACT_IDENTITIES\n';
const selectorEnd = '\n            // END FORMAT_ARTIFACT_IDENTITIES';
assert.equal(main.split(selectorStart).length, 2);
const selectorCode = main.split(selectorStart)[1].split(selectorEnd)[0]
  .split('\n').map(line => line.slice(12)).join('\n');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const selectArtifacts = new AsyncFunction('context', 'github', 'core', 'process', selectorCode);
function artifactsFixture() {
  const digest = 'a'.repeat(64);
  const env = { ONE_ID: '10', TWO_ID: '11', ONE_DIGEST: digest, TWO_DIGEST: digest, GITHUB_RUN_ATTEMPT: '1' };
  const items = new Map([['10', 'one'], ['11', 'two']].map(([id, label]) => [Number(id), {
    id: Number(id), name: 'format-plan-100-1-' + label, expired: false, size_in_bytes: 300,
    workflow_run: { id: 100, repository_id: 1251103365, head_repository_id: 1251103365 },
    digest: 'sha256:' + digest,
  }]));
  const outputs = {};
  return { env, items, outputs, context: { repo: { owner: 'KingsleyHK0323', repo: 'Multimedia_Downloader' }, runId: 100 },
    github: { rest: { actions: { getArtifact: async ({ artifact_id }) => ({ data: items.get(artifact_id) }) } } },
    core: { setOutput: (name, value) => { outputs[name] = value; } } };
}
async function selectFixture(f) {
  return selectArtifacts(f.context, f.github, f.core, { env: f.env });
}
test('artifact selection binds independent job outputs to the current run and digest', async () => {
  const f = artifactsFixture();
  await selectFixture(f);
  assert.equal(f.outputs.one_id, '10');
  assert.equal(f.outputs.two_id, '11');
  assert.equal(f.outputs.one_digest, 'a'.repeat(64));
});
test('artifact selection rejects reused IDs, wrong attempts, digest changes and other runs', async () => {
  for (const change of [
    f => { f.env.TWO_ID = '10'; },
    f => { f.items.get(10).name = 'format-plan-100-2-one'; },
    f => { f.items.get(10).digest = 'sha256:' + 'b'.repeat(64); },
    f => { f.items.get(11).workflow_run.id = 101; },
    f => { f.items.get(11).workflow_run.head_repository_id = 9; },
  ]) {
    const f = artifactsFixture();
    change(f);
    await assert.rejects(selectFixture(f));
  }
});

const gateStart = '            // BEGIN FORMAT_READY_GATE\n';
const gateEnd = '\n            // END FORMAT_READY_GATE';
assert.equal(main.split(gateStart).length, 2);
const gateCode = main.split(gateStart)[1].split(gateEnd)[0]
  .split('\n').map(line => line.slice(12)).join('\n');
const readyGate = new AsyncFunction('context', 'github', 'core', gateCode);
function gateFixture() {
  const sha = 'a'.repeat(40);
  const base = { event: 'push', head_sha: sha, head_branch: 'automation/protected-workflows',
    repository: { id: 1251103365 }, head_repository: { id: 1251103365 },
    status: 'completed', conclusion: 'success' };
  const runs = [
    { ...base, id: 1, path: '.github/workflows/ci.yml', name: 'CI' },
    { ...base, id: 2, path: '.github/workflows/python-matrix.yml', name: 'Python matrix tests' },
  ];
  const outputs = {};
  return { runs, outputs, context: { repo: { owner: 'KingsleyHK0323', repo: 'Multimedia_Downloader' },
      ref: 'refs/heads/Source_Code', eventName: 'workflow_run', payload: { workflow_run: base } },
    github: { rest: { actions: { listWorkflowRunsForRepo: 'list-runs' } }, paginate: async () => runs },
    core: { setOutput: (name, value) => { outputs[name] = value; } } };
}
test('workflow-run planning waits until both exact-head push runs pass', async () => {
  const f = gateFixture();
  f.runs[1].status = 'in_progress';
  await readyGate(f.context, f.github, f.core);
  assert.equal(f.outputs.ready, 'false');
  f.runs[1].status = 'completed';
  await readyGate(f.context, f.github, f.core);
  assert.equal(f.outputs.ready, 'true');
  f.runs[0].head_sha = 'b'.repeat(40);
  await readyGate(f.context, f.github, f.core);
  assert.equal(f.outputs.ready, 'false');
});
test('push and schedule events can plan without waiting on old workflow-run metadata', async () => {
  const f = gateFixture();
  f.context.eventName = 'push';
  await readyGate(f.context, f.github, f.core);
  assert.equal(f.outputs.ready, 'true');
});

test('manual dry-run plans independently while preventing every App-token step', () => {
  assert.match(main, /dry_run:\n\s+description:.*\n\s+required: true\n\s+type: boolean\n\s+default: true/);
  assert.match(main, /include_service: \$\{\{ github\.event_name != 'workflow_dispatch' \|\| inputs\.dry_run != true \}\}/);
  const dry = main.split('  dry-run:\n')[1]?.split('\n  reconcile:\n')[0];
  assert.ok(dry);
  assert.match(dry, /permissions: \{\}/);
  assert.match(plan, /name: Retain formatting plan as data\n\s+if: inputs\.include_service == true/);
  assert.doesNotMatch(dry, /secrets\.|create-github-app-token|APP_TOKEN|contents: write|actions: write/);
  const reconcile = main.split('  reconcile:\n')[1];
  assert.ok(reconcile);
  assert.match(reconcile, /github\.event_name != 'workflow_dispatch' \|\| inputs\.dry_run != true/);
});

const previewStart = "          # BEGIN FORMAT_PREVIEW_SUMMARY\n          python -I - <<'PY'\n";
const previewEnd = "\n          PY\n          # END FORMAT_PREVIEW_SUMMARY";
assert.equal(plan.split(previewStart).length, 2);
const previewCode = plan.split(previewStart)[1].split(previewEnd)[0].replace(/^          /gm, '');
function summarizePreview(manifest) {
  const dir = mkdtempSync(join(tmpdir(), 'formatter-preview-'));
  try {
    const output = join(dir, 'output.txt');
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
    writeFileSync(output, '');
    const result = spawnSync('python', ['-I', '-c', previewCode], {
      encoding: 'utf8', env: { ...process.env, FORMAT_OUTPUT: dir, GITHUB_OUTPUT: output },
    });
    return { result, output: readFileSync(output, 'utf8') };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('preview outputs only bounded paths, hashes and warnings from matching metadata', () => {
  const value = { base: 'a'.repeat(40), service: null, prior: [], limited: false,
    warning_count: 1, warnings: [{ path: 'warn.py', reason: 'black-file-failed', secret: 'do-not-output' }],
    files: [{ path: 'dir/' + 'x'.repeat(200) + '.py', source: 'b'.repeat(40),
      output: 'c'.repeat(40), sha256: 'd'.repeat(64), source_bytes: 'do-not-output' }] };
  const { result, output } = summarizePreview(value);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(output.includes('do-not-output'), false);
  assert.ok(output.length < 110010);
  assert.ok(output.startsWith('summary='));
  const summary = JSON.parse(output.slice('summary='.length));
  assert.equal(summary.file_count, 1);
  assert.equal(summary.files[0].path_truncated, true);
  assert.equal(summary.warnings[0].reason, 'black-file-failed');
  assert.equal(summary.warnings_truncated, false);
});
test('preview rejects branch state and invalid hashes instead of emitting metadata', () => {
  const base = { base: 'a'.repeat(40), service: null, prior: [], limited: false,
    warning_count: 0, warnings: [], files: [] };
  for (const manifest of [{ ...base, service: 'b'.repeat(40) }, { ...base, base: 'invalid' }]) {
    const { result, output } = summarizePreview(manifest);
    assert.notEqual(result.status, 0);
    assert.equal(output, '');
  }
});
