// OpenAI-Codex_watchdog_scope: execute the actual watchdog script with mock APIs.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = await readFile(new URL('../workflows/weekly-dependabot-watchdog.yml', import.meta.url), 'utf8');
const marker = '          script: |\n';
assert.equal(workflow.split(marker).length, 2, 'expected one watchdog script');
const script = workflow.split(marker)[1].split('\n').map((line) => line.startsWith('            ') ? line.slice(12) : line).join('\n');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const rootOld = ['npm_and_yarn in / - Update #1', 'pip in / - Update #3', 'github_actions in / - Update #6'];
const rootDot = rootOld.map((name) => name.replace(' in / - ', ' in /. - '));
const nonRoot = ['npm_and_yarn in /frontend - Update #2', 'pip in /engine - Update #4', 'cargo in /src-tauri - Update #5'];

async function run(names, failureName = null, alerts = [], preview = false) {
  const runs = names.map((name, i) => ({
    name, path: 'dynamic/dependabot/dependabot-updates', created_at: new Date().toISOString(),
    status: 'completed', conclusion: name === failureName ? 'failure' : 'success',
    id: i + 1, run_number: i + 1, html_url: 'https://example.invalid/run',
  }));
  const before = JSON.stringify(runs), calls = [], failures = [];
  const summary = { addHeading() { return this; }, addRaw() { return this; }, addList() { return this; }, async write() { return this; } };
  const actions = { listWorkflowRunsForRepo: async () => ({ data: { total_count: runs.length, workflow_runs: [] } }) };
  const pulls = { list() {} };
  const dependabot = { listAlertsForRepo() {} };
  const repos = { listBranches() {} };
  const issues = {
    listForRepo() {},
    async create(input) { calls.push({ method: 'create', body: input.body }); return { data: { html_url: 'https://example.invalid/issue' } }; },
    async update(input) { calls.push({ method: 'update', body: input.body }); },
  };
  const github = { rest: { actions, pulls, repos, issues, dependabot }, async paginate(fn) {
    if (fn === actions.listWorkflowRunsForRepo) return runs;
    if (fn === dependabot.listAlertsForRepo) return alerts;
    if (fn === pulls.list || fn === repos.listBranches || fn === issues.listForRepo) return [];
    throw Error('Unexpected API call');
  } };
  const core = { summary, warning() {}, info() {}, setFailed(message) { failures.push(message); } };
  await new AsyncFunction('github', 'core', 'context', script)(github, core, { repo: { owner: 'owner', repo: 'repo' }, eventName: preview ? 'workflow_dispatch' : 'schedule', payload: { inputs: { preview: preview ? 'true' : 'false' } } });
  assert.deepEqual(failures, [], 'unexpected workflow failure');
  assert.equal(JSON.stringify(runs), before, 'input response objects changed');
  return calls;
}

test('observed root alias and historic root format are accepted without issue writes', async () => {
  for (const roots of [rootDot, rootOld]) assert.deepEqual(await run([...roots, ...nonRoot]), []);
});

test('root failure and missing or unknown root scan produce a finding', async () => {
  for (const [names, failure] of [
    [[...rootDot, ...nonRoot], rootDot[0]],
    [[...rootDot.slice(1), ...nonRoot], null],
    [[rootDot[0].replace('/.', '/.x'), ...rootDot.slice(1), ...nonRoot], null],
  ]) {
    const calls = await run(names, failure);
    assert.equal(calls.length, 1);
    assert.match(calls[0].body, /root npm/);
  }
});

test('non-root scan failures remain findings without false root findings', async () => {
  for (const name of nonRoot) {
    const calls = await run([...rootDot, ...nonRoot], name);
    assert.equal(calls.length, 1);
    assert.match(calls[0].body, /concluded `failure`/);
    assert.doesNotMatch(calls[0].body, /recent Dependabot scan for (root npm|root pip|GitHub Actions)/);
  }
});


// OpenAI-Codex: security update failures must not be lost among version scans.
test('reports the latest failed security update only while a related alert is open', async () => {
  const bases = [...rootDot, ...nonRoot];
  const oldRun = 'cargo in /src-tauri for glib - Update #7';
  const newRun = 'cargo in /src-tauri for glib - Update #8';
  const alerts = [{ dependency: { package: { ecosystem: 'rust', name: 'glib' }, manifest_path: 'src-tauri/Cargo.lock' } }];
  const failed = await run([...bases, oldRun], oldRun, alerts);
  assert.equal(failed.length, 1);
  assert.match(failed[0].body, /security update for an open alert did not succeed/);
  assert.doesNotMatch(failed[0].body, /glib/);
  assert.deepEqual(await run([...bases, oldRun], oldRun), []);
  const unresolved = await run([...bases, oldRun, newRun], oldRun, alerts);
  assert.equal(unresolved.length, 1);
  assert.match(unresolved[0].body, /Dependabot maintenance is not fully verified/);
  assert.doesNotMatch(unresolved[0].body, /security update for an open alert did not succeed/);
  assert.deepEqual(await run([...bases, oldRun, newRun], oldRun, alerts, true), []);
});

test('warns when open alerts cannot be matched and preview makes no issue changes', async () => {
  const bases = [...rootDot, ...nonRoot];
  const alerts = [{ dependency: { package: { ecosystem: 'rust', name: 'glib' }, manifest_path: 'src-tauri/Cargo.lock' } }];
  const missing = await run(bases, null, alerts);
  assert.equal(missing.length, 1);
  assert.match(missing[0].body, /no matching security-update attempt/);
  const failed = 'cargo in /src-tauri for glib - Update #9';
  assert.deepEqual(await run([...bases, failed], failed, alerts, true), []);
  await assert.rejects(() => run(bases, null, null));
});

test('normalizes Python package names when matching update attempts', async () => {
  const bases = [...rootDot, ...nonRoot];
  const failed = 'pip in / for example-package - Update #10';
  const alerts = [{ dependency: { package: { ecosystem: 'pip', name: 'Example_Package' }, manifest_path: 'requirements.txt' } }];
  const result = await run([...bases, failed], failed, alerts);
  assert.equal(result.length, 1);
  assert.match(result[0].body, /security update for an open alert did not succeed/);
});

// OpenAI-Codex: one package in separate manifests needs separate security-update attempts.
test('correlates security updates by manifest directory and package', async () => {
  const bases = [...rootDot, ...nonRoot];
  const first = 'cargo in /src-tauri for glib - Update #10';
  const second = 'cargo in /other for glib - Update #11';
  const alerts = ['src-tauri/Cargo.lock', 'other/Cargo.lock'].map((manifest_path) => ({
    dependency: { package: { ecosystem: 'rust', name: 'glib' }, manifest_path },
  }));
  const partial = await run([...bases, first], null, alerts);
  assert.equal(partial.length, 1);
  assert.match(partial[0].body, /no matching security-update attempt/);
  const complete = await run([...bases, first, second], null, alerts);
  assert.equal(complete.length, 1);
  assert.doesNotMatch(complete[0].body, /no matching security-update attempt/);
  assert.match(complete[0].body, /not fully verified/);
});

test('normalizes security-update root aliases without accepting malformed alert paths', async () => {
  const bases = [...rootDot, ...nonRoot];
  const securityRun = 'npm_and_yarn in /. for example-package - Update #12';
  const alert = { dependency: { package: { ecosystem: 'npm', name: 'example-package' }, manifest_path: 'package-lock.json' } };
  const result = await run([...bases, securityRun], null, [alert]);
  assert.equal(result.length, 1);
  assert.doesNotMatch(result[0].body, /no matching security-update attempt/);
  for (const manifest_path of ['', '../package-lock.json', '/package-lock.json', 'dir//package-lock.json', 'dir\\\\package-lock.json']) {
    const invalid = await run(bases, null, [{ dependency: { ...alert.dependency, manifest_path } }]);
    assert.equal(invalid.length, 1);
    assert.match(invalid[0].body, /Could not correlate at least one open Dependabot alert/);
  }
});
