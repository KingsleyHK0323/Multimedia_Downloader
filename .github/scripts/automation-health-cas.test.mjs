// OpenAI-Codex_ruleset_architecture: exercise the actual health CAS workflow with isolated GitHub API mocks.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const workflow = readFileSync(new URL('../workflows/automation-health-cas.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const delimiter = '          script: |\n';
assert.equal(workflow.split(delimiter).length, 2);
const script = workflow.split(delimiter)[1].split('\n').map((line) => line.slice(12)).join('\n');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const execute = new AsyncFunction('context', 'github', 'core', 'getOctokit', 'process', 'Buffer', 'require', script);
const localRequire = createRequire(import.meta.url);
const owner = 'KingsleyHK0323';
const repo = 'Multimedia_Downloader';
const full = owner + '/' + repo;
const repositoryId = 1251103365;
const branch = 'automation/protected-workflows';
const base = 'a'.repeat(40);
const head = 'b'.repeat(40);
const changed = 'c'.repeat(40);
const bot = { id: 359694872, login: 'kingsley-multimedia-automation[bot]', type: 'Bot' };
const path = '.github/automation/ci-health.json';
const hash = (text) => {
  const bytes = Buffer.from(text, 'utf8');
  return createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
};
const scheduled = {
  id: 101, run_attempt: 1, path: '.github/workflows/ci.yml', event: 'schedule',
  head_branch: 'Source_Code', status: 'completed', conclusion: 'success',
  repository: { id: repositoryId }, head_repository: { id: repositoryId },
  html_url: 'https://github.com/' + full + '/actions/runs/101',
};
const report = JSON.stringify({
  generated_by: 'OpenAI-Codex', workflow: 'ci.yml', event: 'schedule', branch: 'Source_Code',
  run_id: scheduled.id, run_attempt: scheduled.run_attempt, status: scheduled.status, conclusion: scheduled.conclusion, url: scheduled.html_url,
}, null, 2) + '\n';
const entry = (path, type, mode, sha) => ({ path, type, mode, sha });
const tree = (sha, ...entries) => ({ sha, truncated: false, tree: entries });

function harness(options = {}) {
  const state = {
    source: base, temp: head, refReads: 0, prReads: 0, rulesReads: 0, runReads: 0,
    writes: [], notices: [], checks: new Map(), checkReads: 0, bypass: 'never', integration: 15368, nonForce: true,
    pullRule: false, updateRule: false, report, scheduled: { ...scheduled },
    malformedTree: false, truncatedTree: false, badParent: false, extraParent: false, badCheckApp: false, mutateCheck: false,
    unverified: false, wrongAuthor: false, missingMatrix: false, duplicateRun: false, missingAttempt: false,
    pendingMatrix: false, mutateRules: false, mutateRuns: false, moveBase: false,
    moveHead: false, casConflict: false, rerunMatrix: false, failRerun: false,
    workflowSha: base, sourceRef: 'refs/heads/Source_Code',
    ...options,
  };
  state.pr = {
    number: 12, state: 'open', user: bot, draft: false, auto_merge: null, labels: [],
    changed_files: 1, head: { ref: branch, sha: head, repo: { id: repositoryId, full_name: full } },
    base: { ref: 'Source_Code', sha: base, repo: { id: repositoryId, full_name: full } },
    html_url: 'https://github.com/' + full + '/pull/12',
  };
  const rules = () => [
    ...(state.nonForce ? [{ type: 'non_fast_forward', ruleset_id: 7, ruleset_source_type: 'Repository', ruleset_source: full }] : []),
    ...(state.pullRule ? [{ type: 'pull_request', ruleset_id: 7, ruleset_source_type: 'Repository', ruleset_source: full }] : []),
    ...(state.updateRule ? [{ type: 'update', ruleset_id: 7, ruleset_source_type: 'Repository', ruleset_source: full }] : []),
    { type: 'required_status_checks', ruleset_id: 7, ruleset_source_type: 'Repository', ruleset_source: full,
      parameters: { strict_required_status_checks_policy: false,
        required_status_checks: [
          { context: 'Required CI', integration_id: state.integration },
          { context: 'Required Python matrix', integration_id: state.integration },
        ] } },
  ];
  const contextName = 'dependabot-context-' + head + '-' + head + '-' + head;
  const ciNames = [contextName, 'Required CI', 'version-consistency', 'auto-format-guard',
    'release-input-guard', 'lint', 'python-tests', 'frontend-check', 'rust-check'];
  const matrixNames = [contextName, 'Required Python matrix'];
  for (const os of ['ubuntu-22.04', 'macos-15', 'windows-latest']) {
    for (const version of ['3.10', '3.11', '3.12', '3.13', '3.14']) {
      matrixNames.push('python-tests (' + os + ', ' + version + ')');
    }
  }
  const makeRun = (id, name, workflowPath, workflowId) => ({
    id, name, path: workflowPath, workflow_id: workflowId, head_sha: head, head_branch: branch,
    event: 'push', actor: bot, repository: { id: repositoryId, full_name: full },
    head_repository: { id: repositoryId, full_name: full },
    status: 'completed', conclusion: 'success', run_attempt: 1, created_at: new Date().toISOString(),
  });
  const ciRun = makeRun(200, 'CI', '.github/workflows/ci.yml', 318584423);
  const matrixRun = makeRun(201, 'Python matrix tests', '.github/workflows/python-matrix.yml', 422035428);
  const rootBase = '1'.repeat(40), ghBase = '2'.repeat(40), autoBase = '3'.repeat(40);
  const rootHead = '4'.repeat(40), ghHead = '5'.repeat(40), autoHead = '6'.repeat(40);
  const ciBlob = '7'.repeat(40), matrixBlob = '8'.repeat(40);
  const trees = {
    [rootBase]: tree(rootBase, entry('.github', 'tree', '040000', ghBase)),
    [ghBase]: tree(ghBase, entry('automation', 'tree', '040000', autoBase)),
    [autoBase]: tree(autoBase, entry('ci-health.json', 'blob', '100644', hash('old\n'))),
    [rootHead]: tree(rootHead, entry('.github', 'tree', '040000', ghHead)),
    [ghHead]: tree(ghHead, entry('automation', 'tree', '040000', autoHead)),
    [autoHead]: tree(autoHead, entry('ci-health.json', 'blob', '100644', hash(report))),
  };
  const recursiveTree = (which) => {
    const isHead = which === rootHead;
    return tree(which,
      entry('.github', 'tree', '040000', isHead ? ghHead : ghBase),
      entry('.github/automation', 'tree', '040000', isHead ? autoHead : autoBase),
      entry(path, 'blob', '100644', isHead ? hash(report) : hash('old\n')),
      entry('.github/workflows', 'tree', '040000', '9'.repeat(40)),
      entry('.github/workflows/ci.yml', 'blob', '100644', isHead && state.malformedTree ? changed : ciBlob),
      entry('.github/workflows/python-matrix.yml', 'blob', '100644', matrixBlob),
      entry('README.md', 'blob', '100644', 'f'.repeat(40)),
    );
  };
  const reader = { rest: {
    git: {
      getRef: async ({ ref }) => {
        state.refReads++;
        if (state.moveBase && state.prReads > 1) state.source = changed;
        if (state.moveHead && state.prReads > 1) state.temp = changed;
        return { data: { ref: 'refs/' + ref, object: { type: 'commit',
          sha: ref === 'heads/Source_Code' ? state.source : state.temp } } };
      },
      getCommit: async ({ commit_sha }) => ({ data: {
        sha: commit_sha, tree: { sha: commit_sha === base ? rootBase : rootHead },
        parents: commit_sha === head ? [{ sha: state.badParent ? changed : base },
          ...(state.extraParent ? [{ sha: changed }] : [])] : [],
      } }),
      getTree: async ({ tree_sha, recursive }) => {
        const data = recursive ? recursiveTree(tree_sha) : trees[tree_sha];
        return { data: { ...data, truncated: state.truncatedTree ? true : false } };
      },
    },
    repos: {
      getContent: async () => ({ data: { type: 'file', encoding: 'base64',
        sha: hash(state.report), content: Buffer.from(state.report).toString('base64') } }),
      getCommit: async () => ({ data: {
        sha: head, author: state.wrongAuthor ? { ...bot, id: 7 } : bot,
        committer: { id: 19864447 }, commit: { tree: { sha: rootHead },
          verification: { verified: !state.unverified, reason: state.unverified ? 'unsigned' : 'valid' } },
        parents: [{ sha: state.badParent ? changed : base }, ...(state.extraParent ? [{ sha: changed }] : [])],
      } }),
    },
    checks: { get: async ({ check_run_id }) => {
      state.checkReads++;
      const check = state.checks.get(check_run_id);
      return { data: state.badCheckApp || (state.mutateCheck && state.checkReads > 26)
        ? { ...check, app: { id: 99 } } : check };
    } },
    pulls: {
      list: async () => ({ data: [state.pr] }),
      get: async () => { state.prReads++; return { data: structuredClone(state.pr) }; },
      listFiles: async () => ({ data: [{ filename: path, status: 'modified', sha: hash(report) }] }),
    },
    actions: {
      listWorkflowRuns: async () => ({ data: { total_count: 1, workflow_runs: [state.scheduled] } }),
      listWorkflowRunsForRepo: async ({ event, head_sha }) => {
        assert.equal(event, 'push'); assert.equal(head_sha, head);
        state.runReads++;
        const matrix = { ...matrixRun, run_attempt: state.rerunMatrix ? 2 : 1,
          status: state.pendingMatrix ? 'in_progress' : 'completed' };
        const ci = { ...ciRun, run_attempt: state.mutateRuns && state.runReads > 1 ? 2 : 1 };
        const runs = [ci, matrix, ...(state.duplicateRun ? [{ ...ci, id: 202 }] : [])];
        return { data: { total_count: runs.length, workflow_runs: runs } };
      },
      listJobsForWorkflowRunAttempt: async ({ run_id, attempt_number }) => {
        const names = run_id === ciRun.id ? ciNames : matrixNames;
        let selected = state.missingMatrix && run_id === matrixRun.id ? names.slice(0, -1) : names;
        if (attempt_number === 2) selected = [names[0], names[1]];
        const jobs = selected.map((name, index) => ({
          id: run_id * 1000 + attempt_number * 100 + index, name, run_id,
          ...(state.missingAttempt ? {} : { run_attempt: attempt_number }), head_sha: head, status: 'completed',
          check_run_url: 'https://api.github.com/repos/' + full + '/check-runs/' + (50000 + run_id * 1000 + attempt_number * 100 + index),
          conclusion: state.failRerun && attempt_number === 2 && index === 0 ? 'failure' : 'success',
        }));
        for (const job of jobs) state.checks.set(job.id + 50000, { id: job.id + 50000, name: job.name, head_sha: head,
          status: job.status, conclusion: job.conclusion, app: { id: 15368 } });
        return { data: { total_count: jobs.length, jobs } };
      },
    },
  } };
  reader.paginate = async (fn, args) => (await fn(args)).data;
  const writer = {
    paginate: async (route, args) => {
      assert.equal(route, 'GET /repos/{owner}/{repo}/rules/branches/{branch}');
      assert.equal(args.branch, 'Source_Code');
      state.rulesReads++;
      const result = rules();
      if (state.mutateRules && state.rulesReads > 1) result[0].type = 'changed';
      return result;
    },
    request: async (route, args) => {
      if (route === 'GET /apps/{app_slug}') return { data: { id: 5868451, slug: args.app_slug } };
      assert.equal(route, 'GET /repos/{owner}/{repo}/rulesets/{ruleset_id}');
      return { data: { id: 7, enforcement: 'active', target: 'branch',
        current_user_can_bypass: state.bypass, rules: rules().map(({ type }) => ({ type })),
        conditions: { ref_name: { include: ['refs/heads/Source_Code'], exclude: [] } } } };
    },
    rest: {
      repos: { get: async () => ({ data: { id: repositoryId, full_name: full, node_id: 'repo-node' } }) },
      users: { getByUsername: async () => ({ data: bot }) },
    },
    graphql: async (query, variables) => {
      state.writes.push({ query, variables });
      if (state.casConflict) throw new Error('beforeOid conflict');
      state.source = head;
      return { updateRefs: { clientMutationId: variables.input.clientMutationId } };
    },
  };
  const core = { info: (s) => state.notices.push(s), notice: (s) => state.notices.push(s) };
  const invoke = () => execute({ repo: { owner, repo }, ref: state.sourceRef }, reader, core,
    (token) => { assert.equal(token, 'test-token'); return writer; },
    { env: { APP_TOKEN: 'test-token', APP_SLUG: 'kingsley-multimedia-automation',
      WORKFLOW_SHA: state.workflowSha } }, Buffer, localRequire);
  return { state, invoke };
}

test('advances only Source_Code from the tested base to the exact health head', async () => {
  const h = harness();
  await h.invoke();
  assert.equal(h.state.writes.length, 1);
  assert.deepEqual(h.state.writes[0].variables.input.refUpdates,
    [{ name: 'refs/heads/Source_Code', beforeOid: base, afterOid: head, force: false }]);
  assert.equal(h.state.source, head);
  assert.equal(h.state.temp, head);
});

test('rejects unsafe rules or an App bypass before a ref write', async () => {
  for (const options of [{ bypass: 'always' }, { bypass: null }, { integration: 99 },
    { nonForce: false }, { pullRule: true }, { updateRule: true }, { mutateRules: true }]) {
    const h = harness(options);
    await assert.rejects(h.invoke());
    assert.deepEqual(h.state.writes, []);
  }
});

test('rejects changed workflow trees, truncated trees and untrusted commit ancestry', async () => {
  for (const options of [{ malformedTree: true }, { truncatedTree: true }, { badParent: true },
    { extraParent: true }, { unverified: true }, { wrongAuthor: true }]) {
    const h = harness(options);
    await assert.rejects(h.invoke());
    assert.deepEqual(h.state.writes, []);
  }
});

test('rejects stale report, pending scheduled run, release label and another author', async () => {
  const stale = harness({ report: '{"old":true}\n' });
  const pending = harness();
  pending.state.scheduled.status = 'in_progress';
  const attempt = harness();
  attempt.state.scheduled.run_attempt = 2;
  const label = harness();
  label.state.pr.labels = [{ name: 'RELEASE:PATCH' }];
  const foreign = harness();
  foreign.state.pr.user = { id: 5, login: 'external', type: 'User' };
  for (const h of [stale, pending, attempt, label]) {
    await assert.rejects(h.invoke());
    assert.deepEqual(h.state.writes, []);
  }
  await foreign.invoke();
  assert.deepEqual(foreign.state.writes, []);
});

test('requires every matrix job, an unambiguous App push run and stable refs', async () => {
  for (const options of [{ missingMatrix: true }, { badCheckApp: true }, { mutateCheck: true }, { duplicateRun: true }, { mutateRuns: true },
    { moveBase: true }, { moveHead: true }, { workflowSha: changed }]) {
    const h = harness(options);
    await assert.rejects(h.invoke());
    assert.deepEqual(h.state.writes, []);
  }
});

test('reuses earlier successful jobs only when a partial rerun succeeds', async () => {
  const ok = harness({ rerunMatrix: true, missingAttempt: true });
  await ok.invoke();
  assert.equal(ok.state.writes.length, 1);
  const bad = harness({ rerunMatrix: true, failRerun: true });
  await assert.rejects(bad.invoke(), /Required job did not succeed/);
  assert.deepEqual(bad.state.writes, []);
});

test('waits for pending matrix and surfaces a failed atomic update', async () => {
  const waiting = harness({ pendingMatrix: true });
  await waiting.invoke();
  assert.deepEqual(waiting.state.writes, []);
  assert.ok(waiting.state.notices.some((s) => s.includes('Waiting for')));
  const conflict = harness({ casConflict: true });
  await assert.rejects(conflict.invoke(), /beforeOid conflict/);
  assert.equal(conflict.state.source, base);
});

test('is opt-in and checks the exact source ref before requesting an App token', () => {
  assert.match(workflow, /vars\.AUTOMATION_PR_MODE == 'enabled'/);
  assert.match(workflow, /vars\.AUTOMATION_HEALTH_CAS == 'enabled'/);
  assert.match(workflow, /group: automation-service-reconcile\n      queue: max/);
  assert.ok(workflow.indexOf('Verify exact source ref') < workflow.indexOf('Create a repository-scoped App token'));
  assert.match(workflow, /Source_Code changed before token creation/);
  assert.doesNotMatch(workflow, /pulls\.merge|git\.deleteRef|repos\.deleteFile/);
});
