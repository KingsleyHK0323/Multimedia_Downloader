// OpenAI-Codex_health_release_architecture: exercise exact App push and ruleset evidence.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sourceRulesSnapshot, requiredPushChecks } from './patch-push-checks.mjs';

const owner = 'KingsleyHK0323', repo = 'Multimedia_Downloader';
const full = owner + '/' + repo, branch = 'automation/protected-workflows';
const head = 'a'.repeat(40), now = Date.parse('2026-11-22T12:00:00Z');
const context = 'dependabot-context-' + head + '-' + head + '-' + head;
function fixture(options = {}) {
  const bot = { id: 359694872, login: 'kingsley-multimedia-automation[bot]', type: 'Bot' };
  const repository = { id: 1251103365, full_name: full };
  const runs = [
    { id: 11, workflow_id: 318584423, name: 'CI', path: '.github/workflows/ci.yml' },
    { id: 12, workflow_id: 422035428, name: 'Python matrix tests', path: '.github/workflows/python-matrix.yml' },
  ].map(run => ({ ...run, actor: bot, repository, head_repository: repository, head_sha: head,
    head_branch: options.branch || branch, event: 'push', status: 'completed', conclusion: 'success',
    run_attempt: options.partial ? 2 : 1, created_at: options.oldRun ? '2026-11-01T00:00:00Z' : '2026-11-22T11:00:00Z' }));
  if (options.wrongActor) runs[0].actor = { id: 9, login: 'other', type: 'Bot' };
  if (options.pending) runs[1].status = 'in_progress';
  const names = [
    [context, 'Required CI', 'version-consistency', 'auto-format-guard', 'release-input-guard',
      'lint', 'python-tests', 'frontend-check', 'rust-check'],
    [context, 'Required Python matrix'],
  ];
  for (const os of ['ubuntu-22.04', 'macos-15', 'windows-latest']) {
    for (const version of ['3.10', '3.11', '3.12', '3.13', '3.14']) {
      names[1].push('python-tests (' + os + ', ' + version + ')');
    }
  }
  const jobsByAttempt = new Map(), checks = new Map();
  for (let index = 0; index < runs.length; index++) {
    const run = runs[index];
    const make = (name, offset, attempt) => {
      const id = run.id * 10000 + attempt * 100 + offset;
      const conclusion = options.failedRerun && attempt === 2 ? 'failure' : 'success';
      const job = { id, name, run_id: run.id, run_attempt: attempt, head_sha: head,
        status: 'completed', conclusion,
        check_run_url: 'https://api.github.com/repos/' + full + '/check-runs/' + id };
      checks.set(id, { id, name, head_sha: head, status: 'completed', conclusion,
        app: { id: options.wrongCheckApp ? 2 : 15368 },
        completed_at: options.oldFirstChecks && attempt === 1 ? '2026-11-01T00:00:00Z' : '2026-11-22T11:59:00Z' });
      return job;
    };
    jobsByAttempt.set(run.id + ':1', names[index].map((name, i) => make(name, i, 1)));
    if (options.partial) jobsByAttempt.set(run.id + ':2', options.fullRerun
      ? names[index].map((name, i) => make(name, i, 2)) : [make(names[index].at(-1), 1, 2)]);
  }
  const github = { rest: {
    actions: {
      listWorkflowRunsForRepo: async () => ({ data: options.badPagination
        ? { total_count: 101, workflow_runs: runs }
        : { total_count: runs.length, workflow_runs: runs } }),
      listJobsForWorkflowRunAttempt: async ({ run_id, attempt_number }) => {
        const jobs = jobsByAttempt.get(run_id + ':' + attempt_number) || [];
        return { data: { total_count: jobs.length, jobs } };
      },
    },
    checks: { get: async ({ check_run_id }) => ({ data: checks.get(check_run_id) }) },
  } };
  const common = { ruleset_id: 1, ruleset_source_type: 'Repository', ruleset_source: full };
  const rules = [
    { ...common, type: 'non_fast_forward' },
    { ...common, type: 'required_status_checks', parameters: {
      strict_required_status_checks_policy: true,
      required_status_checks: [
        { context: 'Required CI', integration_id: 15368 },
        { context: 'Required Python matrix', integration_id: 15368 },
      ],
    } },
  ];
  const app = {
    rest: { repos: { get: async () => ({ data: { ...repository, node_id: 'R_repo', fork: false } }) } },
    paginate: async () => rules,
    request: async () => ({ data: { id: 1, enforcement: 'active', target: 'branch',
      current_user_can_bypass: options.bypass ? 'always' : 'never', rules, conditions: {} } }),
  };
  return { github, app, runs, rules, checks };
}

test('accepts only the exact successful App push and its Actions check runs', async () => {
  const { github, app } = fixture();
  const evidence = await requiredPushChecks(github, { owner, repo, head, branch, now });
  assert.equal(evidence.runs.length, 2);
  assert.equal(evidence.evidence[0].length, 9);
  assert.equal(evidence.evidence[1].length, 17);
  assert.equal((await sourceRulesSnapshot(app, { owner, repo })).nodeId, 'R_repo');
});

test('collects the latest result for each job across a partial rerun', async () => {
  const { github } = fixture({ partial: true });
  const evidence = await requiredPushChecks(github, { owner, repo, head, branch, now });
  assert.equal(evidence.evidence[0].find(item => item.name === 'rust-check').attempt, 2);
  assert.equal(evidence.evidence[0].find(item => item.name === 'lint').attempt, 1);
  await assert.rejects(requiredPushChecks(fixture({ partial: true, failedRerun: true }).github,
    { owner, repo, head, branch, now }), /did not succeed/);
});

test('waits for unfinished CI and rejects untrusted or incomplete evidence', async () => {
  assert.equal(await requiredPushChecks(fixture({ pending: true }).github, { owner, repo, head, branch, now }), null);
  for (const options of [{ wrongActor: true }, { wrongCheckApp: true }, { badPagination: true }]) {
    await assert.rejects(requiredPushChecks(fixture(options).github, { owner, repo, head, branch, now }));
  }
  await assert.rejects(requiredPushChecks(fixture().github, { owner, repo, head, branch: 'other', now }));
});

test('requires both Actions checks and rejects App bypass or PR-only rules', async () => {
  const { app, rules } = fixture();
  await assert.rejects(sourceRulesSnapshot(fixture({ bypass: true }).app, { owner, repo }), /bypassable/);
  rules.push({ ruleset_id: 1, ruleset_source_type: 'Repository', ruleset_source: full, type: 'pull_request' });
  await assert.rejects(sourceRulesSnapshot(app, { owner, repo }), /direct updates/);
  const missing = fixture();
  missing.rules[1].parameters.required_status_checks.pop();
  await assert.rejects(sourceRulesSnapshot(missing.app, { owner, repo }), /not active/);
});

test('allows a fresh complete rerun of an older run but rejects stale retained jobs', async () => {
  const fresh = fixture({ oldRun: true, oldFirstChecks: true, partial: true, fullRerun: true });
  const evidence = await requiredPushChecks(fresh.github, { owner, repo, head, branch, now });
  assert.ok(evidence.evidence.flat().every(item => item.attempt === 2));
  const partial = fixture({ oldRun: true, oldFirstChecks: true, partial: true });
  await assert.rejects(requiredPushChecks(partial.github, { owner, repo, head, branch, now }), /not recent/);
});

test('can separately verify the same App commit on Source_Code after the CAS', async () => {
  const { github } = fixture({ branch: 'Source_Code' });
  const evidence = await requiredPushChecks(github, { owner, repo, head, branch: 'Source_Code', now });
  assert.equal(evidence.runs.length, 2);
  assert.ok(evidence.evidence.flat().every(item => item.completed_at));
});
