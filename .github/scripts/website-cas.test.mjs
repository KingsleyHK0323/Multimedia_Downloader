// OpenAI-Codex_ruleset_architecture: verify website CAS decisions with fake GitHub APIs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { reconcileWebsite } from './website-cas.mjs';

const owner = 'KingsleyHK0323', repo = 'Multimedia_Downloader';
const full = owner + '/' + repo, target = 'Multimedia_Downloader_Web_Preview';
const temp = 'automation/protected-workflows', marker = '<!-- automation-website-candidate:v1 -->';
const source = 'a'.repeat(40), B = 'b'.repeat(40), H = 'c'.repeat(40);
const bt = 'd'.repeat(40), ht = 'e'.repeat(40), gh = 'f'.repeat(40);
const ciBlob = '7f8b062f29ee5286ef88c5f5ca4c7c73c5e8dc29';
const now = Date.parse('2026-11-22T12:00:00Z');
const bot = { id: 359694872, login: 'kingsley-multimedia-automation[bot]', type: 'Bot' };
const ownerUser = { id: 157894869, login: 'KingsleyHK0323', type: 'User' };
const gqlOwner = { __typename: 'User', login: 'KingsleyHK0323', id: 'U_kgDOCWlI1Q' };
const node = (path, type, sha, mode = type === 'tree' ? '040000' : '100644') => ({ path, type, sha, mode });

function fixture() {
  const state = {
    refs: { Source_Code: source, [target]: B, [temp]: H }, writes: [],
    truncated: false,
    before: [node('.github', 'tree', gh), node('src', 'tree', '1'.repeat(40)),
      node('src/main.js', 'blob', '2'.repeat(40)), node('package.json', 'blob', '3'.repeat(40)),
      node('.github/workflows/website-ci.yml', 'blob', ciBlob)],
    after: [node('.github', 'tree', gh), node('src', 'tree', '4'.repeat(40)),
      node('src/main.js', 'blob', '5'.repeat(40)), node('package.json', 'blob', '3'.repeat(40)),
      node('.github/workflows/website-ci.yml', 'blob', ciBlob)],
    files: [{ filename: 'src/main.js', status: 'modified' }],
    rules: [
      { ruleset_id: 1, ruleset_source_type: 'Repository', ruleset_source: full, type: 'non_fast_forward' },
      { ruleset_id: 1, ruleset_source_type: 'Repository', ruleset_source: full, type: 'required_status_checks',
        parameters: { strict_required_status_checks_policy: true,
          required_status_checks: [{ context: 'Required Website build', integration_id: 15368 }] } },
    ],
    bypass: 'never',
  };
  const repository = { id: 1251103365, full_name: full };
  state.pr = { number: 42, state: 'open', draft: false, merged: false, user: ownerUser, body: marker,
    updated_at: '2026-11-22T11:58:00Z',
    html_url: 'https://github.com/' + full + '/pull/42', labels: [], auto_merge: null, changed_files: 1,
    head: { ref: temp, sha: H, repo: repository }, base: { ref: target, sha: B, repo: repository } };
  state.commitInfo = { sha: H, author: ownerUser, committer: ownerUser, parents: [{ sha: B }],
    commit: { tree: { sha: ht }, verification: { verified: false, reason: 'unsigned' } } };
  state.run = { id: 11, name: 'Website build check', path: '.github/workflows/website-ci.yml',
    workflow_id: 426421851, event: 'push', head_sha: H, head_branch: temp, actor: ownerUser,
    repository, head_repository: repository, status: 'completed', conclusion: 'success', run_attempt: 1 };
  state.jobs = [{ id: 21, run_id: 11, run_attempt: 1, head_sha: H, name: 'Required Website build',
    status: 'completed', conclusion: 'success', check_run_url: 'https://api.github.com/repos/' + full + '/check-runs/31' }];
  state.check = { id: 31, name: 'Required Website build', head_sha: H, app: { id: 15368 },
    status: 'completed', conclusion: 'success', completed_at: '2026-11-22T11:59:00Z' };
  const pullsList = async () => { throw new Error('use paginate'); };
  const listFiles = async () => { throw new Error('use paginate'); };
  const github = { graphql: async (query, vars) => {
    if (query.includes('associatedPullRequests')) return { repository: { nameWithOwner: full, ref: {
      name: temp, prefix: 'refs/heads/', target: { oid: state.refs[temp] },
      associatedPullRequests: { totalCount: state.associatedCount ?? 1, pageInfo: { hasNextPage: false },
        nodes: [{ number: 42, repository: { nameWithOwner: full, databaseId: 1251103365 } }] },
    } } };
    if (!query.includes('timelineItems')) throw new Error('Unexpected GraphQL query');
    const events = state.timelineEvents || [];
    state.timelineCalls = (state.timelineCalls || 0) + 1;
    const offset = vars.cursor ? Number(vars.cursor.slice(1)) : 0;
    const nodes = events.slice(offset, offset + 100), more = offset + nodes.length < events.length;
    return { repository: { nameWithOwner: full, pullRequest: { number: 42, state: 'OPEN',
      isDraft: false, headRefOid: H, baseRefName: target, updatedAt: state.pr.updated_at,
      timelineItems: { totalCount: state.timelineCount ?? events.length,
        updatedAt: state.timelineBump && state.timelineCalls > 1 ? '2026-11-22T11:59:00Z' :
          (state.timelineRevision || '2026-11-22T11:58:00Z'), nodes,
        pageInfo: { hasNextPage: more, endCursor: more ? (state.repeatCursor ? 'c100' : 'c' + (offset + nodes.length)) : null } },
    } } };
  }, rest: {
    pulls: { list: pullsList, listFiles, get: async () => ({ data: state.pr }) },
    git: {
      getRef: async ({ ref }) => ({ data: { ref: 'refs/' + ref, object: {
        type: 'commit', sha: state.refs[ref.slice('heads/'.length)] } } }),
      getCommit: async ({ commit_sha }) => ({ data: commit_sha === B
        ? { sha: B, tree: { sha: bt } } : { sha: H, tree: { sha: ht }, parents: [{ sha: B }] } }),
      getTree: async ({ tree_sha }) => ({ data: { sha: tree_sha, truncated: state.truncated,
        tree: tree_sha === bt ? state.before : state.after } }),
    },
    repos: { getCommit: async () => ({ data: state.commitInfo }) },
    actions: {
      listWorkflowRunsForRepo: async () => ({ data: { total_count: 1, workflow_runs: [state.run] } }),
      listJobsForWorkflowRunAttempt: async () => ({ data: { total_count: state.jobs.length, jobs: state.jobs } }),
    },
    checks: { get: async () => ({ data: state.check }) },
  }, paginate: async (method, args) => {
    if (method === listFiles) return state.files;
    if (method === pullsList) {
      if (args.head) return state.headPrs || [state.pr];
      if (args.base === temp) return state.basePrs || [];
      return [state.pr];
    }
    throw new Error('Unexpected GitHub pagination');
  } };
  const app = {
    rest: {
      users: { getByUsername: async () => ({ data: bot }) },
      repos: { get: async () => ({ data: { ...repository, fork: false, node_id: 'REPO_NODE' } }) },
    },
    paginate: async () => state.rules,
    request: async route => route === 'GET /apps/{app_slug}'
      ? { data: { id: 5868451, slug: 'kingsley-multimedia-automation' } }
      : { data: { id: 1, target: 'branch', enforcement: 'active', current_user_can_bypass: state.bypass,
          rules: state.rules, conditions: { ref_name: { include: ['refs/heads/' + target], exclude: [] } } } },
    graphql: async (_query, { input }) => {
      state.writes.push(input);
      const update = input.refUpdates[0];
      if (update.name !== 'refs/heads/' + target || update.beforeOid !== state.refs[target] ||
          update.afterOid !== H || update.force !== false) throw new Error('CAS rejected');
      state.refs[target] = H;
      return { updateRefs: { clientMutationId: input.clientMutationId } };
    },
  };
  const args = { github, app, context: { repo: { owner, repo }, ref: 'refs/heads/Source_Code' },
    appSlug: 'kingsley-multimedia-automation', workflowSha: source, now };
  return { state, args };
}

test('updates only the fixed website ref after the exact owner push succeeds', async () => {
  const f = fixture();
  const result = await reconcileWebsite(f.args);
  assert.deepEqual(result, { status: 'updated', pr: 42, head: H });
  assert.equal(f.state.writes.length, 1);
  assert.deepEqual(f.state.writes[0].refUpdates, [{
    name: 'refs/heads/' + target, beforeOid: B, afterOid: H, force: false,
  }]);
  assert.equal(f.state.refs.Source_Code, source);
});

test('waits for the real push build before updating', async () => {
  const f = fixture();
  f.state.run.status = 'in_progress'; f.state.run.conclusion = null;
  assert.equal((await reconcileWebsite(f.args)).status, 'waiting-for-checks');
  assert.equal(f.state.writes.length, 0);
});

test('rejects a bypassable rule, stale check, wrong parent, or wrong push actor', async () => {
  for (const change of [
    f => { f.state.bypass = 'always'; },
    f => { f.state.check.completed_at = '2026-11-01T00:00:00Z'; },
    f => { f.state.run.actor = bot; },
    f => { f.state.commitInfo.parents = [{ sha: '9'.repeat(40) }]; },
    f => { f.state.check.app.id = 1; },
  ]) {
    const f = fixture(); change(f);
    await assert.rejects(reconcileWebsite(f.args));
    assert.equal(f.state.writes.length, 0);
  }
});

test('rejects changes to automation, package configuration, and related PR reuse', async () => {
  for (const change of [
    f => { f.state.after[0] = node('.github', 'tree', '6'.repeat(40)); },
    f => { f.state.before[4] = node('.github/workflows/website-ci.yml', 'blob', '6'.repeat(40)); },
    f => { f.state.after[3] = node('package.json', 'blob', '6'.repeat(40)); },
    f => { f.state.after[2] = node('src/../secret.js', 'blob', '6'.repeat(40)); },
    f => { f.state.headPrs = [f.state.pr, { ...f.state.pr, number: 43 }]; },
    f => { f.state.basePrs = [{ number: 43 }]; },
    f => { f.state.associatedCount = 2; },
    f => { f.state.pr.labels = [{ name: 'release:patch' }]; },
  ]) {
    const f = fixture(); change(f);
    await assert.rejects(reconcileWebsite(f.args));
    assert.equal(f.state.writes.length, 0);
  }
});

test('rejects tree truncation, file list mismatch and a changed Source_Code revision', async () => {
  const f = fixture();
  f.state.files = [];
  await assert.rejects(reconcileWebsite(f.args));
  assert.equal(f.state.writes.length, 0);
  const truncated = fixture();
  truncated.state.truncated = true;
  await assert.rejects(reconcileWebsite(truncated.args), /tree inventory/);
  assert.equal(truncated.state.writes.length, 0);
  const g = fixture();
  g.state.refs.Source_Code = H;
  await assert.rejects(reconcileWebsite(g.args));
  assert.equal(g.state.writes.length, 0);
});

test('fails closed if the website base changes before the ref mutation', async () => {
  const f = fixture();
  const original = f.args.app.graphql;
  f.args.app.graphql = async (...args) => { f.state.refs[target] = '9'.repeat(40); return original(...args); };
  await assert.rejects(reconcileWebsite(f.args), /CAS rejected/);
  assert.equal(f.state.refs.Source_Code, source);
});


test('requires owner-originated PR transitions and rejects forced or incomplete history', async () => {
  const ownerEvent = type => ({ __typename: type, id: 'event-1', createdAt: '2026-11-22T11:57:00Z', actor: gqlOwner });
  const good = fixture();
  good.state.timelineEvents = [ownerEvent('ReadyForReviewEvent')];
  assert.equal((await reconcileWebsite(good.args)).status, 'updated');
  const reopened = fixture();
  reopened.state.timelineEvents = [{ __typename: 'ClosedEvent' }, ownerEvent('ReopenedEvent')];
  assert.equal((await reconcileWebsite(reopened.args)).status, 'updated');
  for (const events of [
    [{ ...ownerEvent('ReopenedEvent'), actor: { __typename: 'Bot', login: bot.login } }],
    [{ ...ownerEvent('ReadyForReviewEvent'), actor: { __typename: 'Bot', login: bot.login } }],
    [{ ...ownerEvent('BaseRefChangedEvent'), actor: { __typename: 'Bot', login: bot.login } }],
    [{ __typename: 'HeadRefForcePushedEvent' }],
    [{ __typename: 'AutomaticBaseChangeSucceededEvent' }],
    [{ __typename: 'FutureUnknownStateEvent' }],
    [{ ...ownerEvent('BaseRefChangedEvent'), previousRefName: 'Source_Code', currentRefName: 'other' }],
  ]) {
    const f = fixture(); f.state.timelineEvents = events;
    await assert.rejects(reconcileWebsite(f.args));
    assert.equal(f.state.writes.length, 0);
  }
  const incomplete = fixture(); incomplete.state.timelineCount = 1;
  await assert.rejects(reconcileWebsite(incomplete.args), /timeline count/);
  assert.equal(incomplete.state.writes.length, 0);
});

test('fully traverses owner PR timeline pages without trusting PR text', async () => {
  const f = fixture();
  f.state.pr.body = 'Any ordinary owner PR description';
  f.state.timelineEvents = Array.from({ length: 101 }, () => ({ __typename: 'IssueComment' }));
  assert.equal((await reconcileWebsite(f.args)).status, 'updated');
});

test('rejects repeated timeline cursors and state changes between snapshots', async () => {
  const repeated = fixture();
  repeated.state.repeatCursor = true;
  repeated.state.timelineEvents = Array.from({ length: 201 }, () => ({ __typename: 'IssueComment' }));
  await assert.rejects(reconcileWebsite(repeated.args), /timeline cursor/);
  assert.equal(repeated.state.writes.length, 0);
  const changed = fixture();
  changed.state.timelineBump = true;
  await assert.rejects(reconcileWebsite(changed.args), /rules, PR or check changed/);
  assert.equal(changed.state.writes.length, 0);
});

test('stages exact inline coordinator with an unconditional stop before any App token', () => {
  const workflow = readFileSync(new URL('../workflows/website-cas.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const module = readFileSync(new URL('./website-cas.mjs', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const start = '            // BEGIN EXACT WEBSITE CAS\n';
  const end = '\n            // END EXACT WEBSITE CAS';
  assert.equal(workflow.split(start).length, 2);
  const embedded = workflow.split(start)[1].split(end)[0].split('\n').map(line => {
    assert.equal(line.slice(0, 12), '            ');
    return line.slice(12);
  }).join('\n');
  assert.equal(embedded, module.replace(/^export /gm, '').trimEnd());
  const stop = workflow.indexOf('name: Keep website App writing disabled');
  const fail = workflow.indexOf('          exit 1', stop);
  const token = workflow.indexOf('name: Create repository-scoped App token');
  assert.ok(stop > 0 && fail > stop && token > fail);
  assert.match(workflow, /vars\.AUTOMATION_WEBSITE_CAS == 'enabled'/);
  assert.match(workflow, /group: automation-service-reconcile/);
  assert.doesNotMatch(workflow, /actions\/checkout|import\(/);
});
