// OpenAI-Codex_health_release_architecture: test the actual health merger with simulated GitHub APIs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const workflow = readFileSync(new URL('../workflows/automation-health-merge.yml', import.meta.url), 'utf8')
  .replaceAll('\r\n', '\n');
const start = '          script: |\n';
assert.equal(workflow.split(start).length, 2);
const script = workflow.split(start)[1].split('\n').map((line) => line.slice(12)).join('\n');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const execute = new AsyncFunction('context', 'github', 'core', 'getOctokit', 'process', 'Buffer', 'require', script);
const localRequire = createRequire(import.meta.url);
const owner = 'KingsleyHK0323';
const repo = 'Multimedia_Downloader';
const full = owner + '/' + repo;
const branch = 'automation/ci-health-100-1';
const base = 'a'.repeat(40);
const head = 'b'.repeat(40);
const merge = 'c'.repeat(40);
const merged = 'd'.repeat(40);
const changed = 'e'.repeat(40);
const bot = { id: 359694872, login: 'kingsley-multimedia-automation[bot]', type: 'Bot' };
const path = '.github/automation/ci-health.json';
const hashBlob = (text) => {
  const bytes = Buffer.from(text, 'utf8');
  return createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
};
const scheduled = {
  id: 101, run_attempt: 2, path: '.github/workflows/ci.yml', event: 'schedule',
  head_branch: 'Source_Code', status: 'completed', conclusion: 'success',
  html_url: 'https://github.com/' + full + '/actions/runs/101',
};
const report = JSON.stringify({
  generated_by: 'OpenAI-Codex', workflow: 'ci.yml', event: 'schedule', branch: 'Source_Code',
  run_id: 101, run_attempt: scheduled.run_attempt, status: 'completed', conclusion: 'success', url: scheduled.html_url,
}, null, 2) + '\n';
const entry = (name, type, mode, value) => ({ path: name, type, mode, sha: value });
const tree = (value, ...entries) => ({ sha: value, truncated: false, tree: entries });

function harness(options = {}) {
  const testBranch = options.testBranch || branch;
  const state = {
    pr: {
      number: 12, state: 'open', user: bot, draft: false, auto_merge: null, labels: [],
      mergeable: true, merge_commit_sha: merge, changed_files: 1,
      head: { ref: testBranch, sha: head, repo: { full_name: full } },
      base: { ref: 'Source_Code', sha: base, repo: { full_name: full } },
      html_url: 'https://github.com/' + full + '/pull/12',
    },
    files: [{ filename: path, status: 'modified', sha: hashBlob(report) }],
    scheduled: { ...scheduled }, report, writes: [], notices: [],
    bypass: 'never', strict: true, integration: 15368,
    pullRule: true, rulesReads: 0, runsReads: 0, prReads: 0,
    mutateRules: false, mutateRuns: false, mutatePr: false, moveBase: false,
    mergeConflict: false, missingMatrix: false, foreignOnly: false, pendingMatrix: false,
    websiteReads: 0, noWebsiteRule: false, websiteBypass: 'never', mutateWebsite: false,
    allowFetchMerge: false, websiteParamMode: 'missing', websiteDetailParamMode: 'missing',
    repoReads: 0, repositoryFork: false, repositoryId: 1251103365, repositoryName: full,
    mutateRepository: false, websiteSourceType: 'Repository', websiteSource: full,
    detailSourceType: 'Repository', detailSource: full, scopeMode: 'exact',
    ...options,
  };
  const rules = () => [
    ...(state.pullRule ? [{ type: 'pull_request', ruleset_id: 7, ruleset_source_type: 'Repository', ruleset_source: full }] : []),
    { type: 'required_status_checks', ruleset_id: 7, ruleset_source_type: 'Repository', ruleset_source: full,
      parameters: { strict_required_status_checks_policy: state.strict,
        required_status_checks: [
          { context: 'Required CI', integration_id: state.integration },
          { context: 'Required Python matrix', integration_id: state.integration },
        ] } },
  ];
  const contextName = 'dependabot-context-' + base + '-' + head + '-' + merge;
  const ciNames = [contextName, 'Required CI', 'version-consistency', 'auto-format-guard',
    'release-input-guard', 'lint', 'python-tests', 'frontend-check', 'rust-check'];
  const matrixNames = [contextName, 'Required Python matrix'];
  for (const os of ['ubuntu-22.04', 'macos-15', 'windows-latest']) {
    for (const version of ['3.10', '3.11', '3.12', '3.13', '3.14']) {
      matrixNames.push('python-tests (' + os + ', ' + version + ')');
    }
  }
  const makeRun = (id, name, workflowPath) => ({
    id, name, path: workflowPath, head_sha: head, head_branch: testBranch, event: 'pull_request',
    repository: { full_name: full }, head_repository: { full_name: full },
    status: 'completed', conclusion: 'success', run_attempt: 1,
  });
  const ciRun = makeRun(200, 'CI', '.github/workflows/ci.yml');
  const matrixRun = makeRun(201, 'Python matrix tests', '.github/workflows/python-matrix.yml');
  const trees = {
    ['1'.repeat(40)]: tree('1'.repeat(40), entry('.github', 'tree', '040000', '2'.repeat(40))),
    ['2'.repeat(40)]: tree('2'.repeat(40), entry('automation', 'tree', '040000', '3'.repeat(40))),
    ['3'.repeat(40)]: tree('3'.repeat(40), entry('ci-health.json', 'blob', '100644', hashBlob('old\n'))),
    ['4'.repeat(40)]: tree('4'.repeat(40), entry('.github', 'tree', '040000', '5'.repeat(40))),
    ['5'.repeat(40)]: tree('5'.repeat(40), entry('automation', 'tree', '040000', '6'.repeat(40))),
    ['6'.repeat(40)]: tree('6'.repeat(40), entry('ci-health.json', 'blob', '100644', hashBlob(report))),
  };
  const reader = { rest: {
    git: {
      getRef: async ({ ref }) => ({
        data: { ref: 'refs/' + ref, object: { type: 'commit',
          sha: ref === 'heads/Source_Code' ? (state.moveBase && state.prReads > 1 ? changed : base) : head } },
      }),
      getCommit: async ({ commit_sha }) => ({ data: {
        sha: commit_sha, tree: { sha: commit_sha === base ? '1'.repeat(40) : '4'.repeat(40) },
      } }),
      getTree: async ({ tree_sha }) => ({ data: trees[tree_sha] }),
    },
    repos: {
      getContent: async () => ({ data: { type: 'file', encoding: 'base64',
        sha: hashBlob(state.report), content: Buffer.from(state.report).toString('base64') } }),
    },
    pulls: {
      list: async () => ({ data: state.foreignOnly ? [{
        number: 13, state: 'open', user: { id: 9, login: 'fork-user', type: 'User' },
        head: { ref: branch, repo: { full_name: 'fork-user/Multimedia_Downloader' } },
      }] : [state.pr] }),
      get: async () => {
        state.prReads++;
        const pr = structuredClone(state.pr);
        if (state.mutatePr && state.prReads > 1) pr.merge_commit_sha = changed;
        return { data: pr };
      },
      listFiles: async () => ({ data: state.files }),
    },
    actions: {
      listWorkflowRuns: async () => ({ data: { total_count: 1, workflow_runs: [state.scheduled] } }),
      listWorkflowRunsForRepo: async () => {
        state.runsReads++;
        const ci = { ...ciRun };
        if (state.mutateRuns && state.runsReads > 1) ci.run_attempt = 2;
        return { data: { total_count: 2, workflow_runs: [ci, { ...matrixRun,
          status: state.pendingMatrix ? 'in_progress' : matrixRun.status }] } };
      },
      listJobsForWorkflowRunAttempt: async ({ run_id }) => {
        const names = run_id === ciRun.id ? ciNames : matrixNames;
        const selected = state.missingMatrix && run_id === matrixRun.id ? names.slice(0, -1) : names;
        return { data: { total_count: selected.length,
          jobs: selected.map((name) => ({ name, run_id, status: 'completed', conclusion: 'success' })) } };
      },
    },
  } };
  reader.paginate = async (fn, args) => (await fn(args)).data;
  const writer = {
    paginate: async (route, args) => {
      assert.equal(route, 'GET /repos/{owner}/{repo}/rules/branches/{branch}');
      if (args.branch === 'Multimedia_Downloader_Web_Preview') {
        state.websiteReads++;
        if (state.noWebsiteRule) return [];
        const parameters = state.websiteParamMode === 'missing' ? undefined :
          state.websiteParamMode === 'null' ? null :
          state.websiteParamMode === 'empty' ? {} :
          state.websiteParamMode === 'extra' ? { update_allows_fetch_and_merge: false, unknown_option: true } :
          { update_allows_fetch_and_merge: state.allowFetchMerge };
        return [{ type: state.mutateWebsite && state.websiteReads > 1 ? 'deletion' : 'update',
          ...(parameters === undefined ? {} : { parameters }),
          ruleset_id: 8, ruleset_source_type: state.websiteSourceType, ruleset_source: state.websiteSource }];
      }
      assert.equal(args.branch, 'Source_Code');
      state.rulesReads++;
      const result = rules();
      if (state.mutateRules && state.rulesReads > 1) result[0].type = 'changed';
      return result;
    },
    request: async (route, args) => {
      if (route === 'GET /apps/{app_slug}') {
        return { data: { id: 5868451, slug: args.app_slug } };
      }
      assert.equal(route, 'GET /repos/{owner}/{repo}/rulesets/{ruleset_id}');
      if (args.ruleset_id === 8) {
        const parameters = state.websiteDetailParamMode === 'missing' ? undefined :
          state.websiteDetailParamMode === 'null' ? null :
          state.websiteDetailParamMode === 'empty' ? {} :
          state.websiteDetailParamMode === 'extra' ? { update_allows_fetch_and_merge: false, unknown_option: true } :
          { update_allows_fetch_and_merge: state.allowFetchMerge };
        const include = state.scopeMode === 'other' ? ['refs/heads/Source_Code'] :
          state.scopeMode === 'broad' ? ['~ALL'] : ['refs/heads/Multimedia_Downloader_Web_Preview'];
        const exclude = state.scopeMode === 'excluded' ? ['refs/heads/Multimedia_Downloader_Web_Preview'] : [];
        const conditions = state.scopeMode === 'missing' ? undefined :
          { ref_name: { include, exclude }, ...(state.scopeMode === 'unknown' ? { unknown: true } : {}) };
        return { data: { id: 8, enforcement: 'active', target: 'branch',
          source_type: state.detailSourceType, source: state.detailSource, conditions,
          current_user_can_bypass: state.websiteBypass,
          rules: [{ type: 'update', ...(parameters === undefined ? {} : { parameters }) }] } };
      }
      assert.equal(args.ruleset_id, 7);
      return { data: { id: 7, enforcement: 'active', target: 'branch',
        current_user_can_bypass: state.bypass, rules: rules().map(({ type }) => ({ type })) } };
    },
    rest: {
      repos: { get: async () => {
        state.repoReads++;
        return { data: { id: state.repositoryId, full_name: state.repositoryName,
          fork: state.mutateRepository && state.repoReads > 1 ? true : state.repositoryFork } };
      } },
      users: { getByUsername: async () => ({ data: bot }) },
      pulls: {
        merge: async (args) => {
          state.writes.push(args);
          if (state.mergeConflict) throw new Error('head changed: HTTP 409');
          return { data: { merged: true, sha: merged } };
        },
      },
    },
  };
  const core = { info: (s) => state.notices.push(s), notice: (s) => state.notices.push(s) };
  const invoke = () => execute({ repo: { owner, repo }, ref: state.sourceRef ?? 'refs/heads/Source_Code' }, reader, core,
    (token) => { assert.equal(token, 'test-token'); return writer; },
    { env: { APP_TOKEN: 'test-token', APP_SLUG: 'kingsley-multimedia-automation' } }, Buffer, localRequire);
  return { state, invoke };
}

test('squash merges only the verified App PR head', async () => {
  const h = harness();
  await h.invoke();
  assert.equal(h.state.writes.length, 1);
  assert.equal(h.state.writes[0].sha, head);
  assert.equal(h.state.writes[0].merge_method, 'squash');
  assert.equal(h.state.writes[0].pull_number, 12);
});

test('ignores a fork with the same branch prefix', async () => {
  const h = harness({ foreignOnly: true });
  await h.invoke();
  assert.deepEqual(h.state.writes, []);
});

test('rejects bypassable, non-strict, unpinned and missing PR rules', async () => {
  for (const options of [{ bypass: 'always' }, { bypass: null }, { strict: false },
    { integration: 99 }, { pullRule: false }]) {
    const h = harness(options);
    await assert.rejects(h.invoke());
    assert.deepEqual(h.state.writes, []);
  }
});

test('rejects changed files, unexpected reports, release labels and native auto-merge', async () => {
  const extra = harness();
  extra.state.files.push({ filename: 'other.txt', status: 'modified', sha: changed });
  await assert.rejects(extra.invoke(), /exactly the report file/);
  const stale = harness({ report: '{"old": true}\n' });
  await assert.rejects(stale.invoke(), /not the latest trusted CI report|incomplete/);
  const label = harness();
  label.state.pr.labels = [{ name: 'release:patch' }];
  await assert.rejects(label.invoke(), /release label/);
  const auto = harness();
  auto.state.pr.auto_merge = { enabled_by: { login: 'owner' } };
  await assert.rejects(auto.invoke(), /mergeability is unsafe/);
  for (const h of [extra, stale, label, auto]) assert.deepEqual(h.state.writes, []);
});

test('rejects incomplete matrix and changing rules, runs, merge or base before merge', async () => {
  for (const options of [{ missingMatrix: true }, { mutateRules: true },
    { mutateRuns: true }, { mutatePr: true }, { moveBase: true }]) {
    const h = harness(options);
    await assert.rejects(h.invoke());
    assert.deepEqual(h.state.writes, []);
  }
});

test('propagates owner or branch races detected by GitHub during merge', async () => {
  const h = harness({ mergeConflict: true });
  await assert.rejects(h.invoke(), /HTTP 409/);
  assert.equal(h.state.writes.length, 1);
  assert.equal(h.state.writes[0].sha, head);
});

test('waits for an incomplete CI matrix without merging', async () => {
  const h = harness({ pendingMatrix: true });
  await h.invoke();
  assert.deepEqual(h.state.writes, []);
  assert.ok(h.state.notices.some((value) => value.includes('Waiting for')));
});

// OpenAI-Codex_ruleset_architecture: reproduce GitHub's parameterless non-fork response and fail closed otherwise.
test('accepts parameterless and explicit false update rules on the exact non-fork website scope', async () => {
  for (const options of [
    {},
    { websiteParamMode: 'normal', websiteDetailParamMode: 'normal' },
    { websiteParamMode: 'missing', websiteDetailParamMode: 'normal' },
    { websiteParamMode: 'normal', websiteDetailParamMode: 'missing' },
  ]) {
    const h = harness(options);
    await h.invoke();
    assert.equal(h.state.writes.length, 1);
    assert.equal(h.state.writes[0].sha, head);
  }
});

test('rejects absent, bypassable, changed or malformed website update restrictions', async () => {
  for (const options of [
    { noWebsiteRule: true }, { websiteBypass: 'always' }, { websiteBypass: null },
    { mutateWebsite: true }, { allowFetchMerge: true, websiteParamMode: 'normal' },
    { allowFetchMerge: true, websiteDetailParamMode: 'normal' },
    { websiteParamMode: 'null' }, { websiteParamMode: 'empty' }, { websiteParamMode: 'extra' },
    { websiteDetailParamMode: 'null' }, { websiteDetailParamMode: 'empty' }, { websiteDetailParamMode: 'extra' },
    { websiteSourceType: 'Organization' }, { websiteSource: 'other/repo' },
    { detailSourceType: 'Organization' }, { detailSource: 'other/repo' },
    { scopeMode: 'other' }, { scopeMode: 'broad' }, { scopeMode: 'excluded' },
    { scopeMode: 'unknown' }, { scopeMode: 'missing' },
  ]) {
    const h = harness(options);
    await assert.rejects(h.invoke());
    assert.deepEqual(h.state.writes, []);
  }
});

test('rejects forks, incomplete repository identity and changes between snapshots', async () => {
  for (const options of [
    { repositoryFork: true }, { repositoryFork: null }, { repositoryFork: undefined },
    { repositoryFork: 'false' }, { repositoryId: 999 }, { repositoryName: 'other/repo' },
    { mutateRepository: true },
  ]) {
    const h = harness(options);
    await assert.rejects(h.invoke(), /Repository identity or non-fork status/);
    assert.deepEqual(h.state.writes, []);
  }
});

test('accepts the base-specific branch format while preserving legacy format', async () => {
  const h = harness({ testBranch: branch + '-' + base });
  await h.invoke();
  assert.equal(h.state.writes.length, 1);
  assert.equal(h.state.writes[0].sha, head);
});

test('the merger remains disabled by default and uses job-level shared concurrency', () => {
  assert.match(workflow, /vars\.AUTOMATION_PR_MODE == 'enabled'/);
  assert.match(workflow, /vars\.AUTOMATION_SAFE_MERGE == 'enabled'/);
  assert.match(workflow, /merge-health:[\s\S]*?concurrency:\n      group: automation-health-report\n      queue: max/);
  assert.doesNotMatch(workflow, /\nconcurrency:\n/);
});

test('refuses a case-mismatched source ref before merging', async () => {
  const h = harness({ sourceRef: 'refs/heads/source_code' });
  await assert.rejects(h.invoke(), /Unexpected repository/);
  assert.deepEqual(h.state.writes, []);
});

test('checks the exact source ref before minting an App token', () => {
  assert.ok(workflow.indexOf('Verify exact source ref') < workflow.indexOf('Create a repository-scoped App token'));
});


test('hard stops health merging before creating an App token regardless of repository variables', () => {
  const block = workflow.split('      - name: Block health merge pending branch isolation\n')[1];
  assert.ok(block, 'required hard stop is missing');
  assert.match(block.split('      - name: Create a repository-scoped App token\n')[0], /exit 1/);
  assert.ok(workflow.indexOf('Block health merge pending branch isolation') <
    workflow.indexOf('Create a repository-scoped App token'));
});
