// OpenAI-Codex_health_release_architecture: exercise the actual health PR script with mocked GitHub APIs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const workflow = readFileSync(new URL('../workflows/automation-health.yml', import.meta.url), 'utf8')
  .replaceAll('\r\n', '\n');
const start = '          script: |\n';
assert.equal(workflow.split(start).length, 3);
const script = workflow.split(start)[2].split('\n').map((line) => line.slice(12)).join('\n');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const executeScript = new AsyncFunction('context', 'github', 'core', 'getOctokit', 'process', 'Buffer', 'require', 'setTimeout', script);
const localRequire = createRequire(import.meta.url);
const owner = 'KingsleyHK0323';
const repo = 'Multimedia_Downloader';
const fullName = owner + '/' + repo;
const path = '.github/automation/ci-health.json';
const base = 'a'.repeat(40);
const moved = '9'.repeat(40);
const baseTree = 'b'.repeat(40);
const baseGithub = 'c'.repeat(40);
const baseAutomation = 'd'.repeat(40);
const newTree = 'e'.repeat(40);
const newGithub = 'f'.repeat(40);
const newAutomation = '1'.repeat(40);
const newCommit = '2'.repeat(40);
const mergedCommit = '4'.repeat(40);
const refreshedCommit = '5'.repeat(40);
const secondCommit = 'ab'.repeat(20);
const refreshedTree = '6'.repeat(40);
const refreshedGithub = '7'.repeat(40);
const refreshedAutomation = '8'.repeat(40);
const botId = 359694872;
const message = 'chore: update scheduled CI health report\n\nOpenAI-Codex_health_release_architecture';
const blob = (value) => {
  const bytes = Buffer.from(value, 'utf8');
  return createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
};
const missing = () => Object.assign(new Error('not found'), { status: 404 });
const entry = (name, type, mode, value) => ({ path: name, type, mode, sha: value });
const tree = (value, ...items) => ({ sha: value, truncated: false, tree: items });
const run = {
  id: 123, run_attempt: 1, path: '.github/workflows/ci.yml', event: 'schedule',
  created_at: '2026-11-21T00:00:00Z',
  head_branch: 'Source_Code', status: 'completed', conclusion: 'success',
  html_url: 'https://github.com/' + fullName + '/actions/runs/123',
};
const expectedReport = JSON.stringify({
  generated_by: 'OpenAI-Codex', workflow: 'ci.yml', event: 'schedule',
  branch: 'Source_Code', run_id: 123, status: 'completed', conclusion: 'success',
  url: run.html_url,
}, null, 2) + '\n';

function harness(options = {}) {
  const state = {
    run: { ...run }, total: 1, old: '{"previous": true}\n', branchHead: null,
    pr: null, writes: [], notices: [], baseReads: 0, baseMovesAt: 0,
    candidate: null, newReport: null, failPullCreate: false, extraFile: false,
    incompleteTree: false, openOthers: [], currentBase: base, finishUpdate: true,
    mergeCandidate: null, refreshCandidate: null, firstCandidate: null, refs: {},
    previousReport: null, badIdentity: false, casConflict: false, closedOthers: [],
    manyRecentClosed: false, treeUnexpected: false, retargetDuringCas: false, ...options,
  };
  const oldBlob = () => blob(state.old);
  const currentBlob = () => blob(state.newReport);
  let branch = 'automation/ci-health-123-1-' + base;
  let branchRef = 'refs/heads/' + branch;
  const makePr = (stateName = 'open') => ({
    number: 75, state: stateName, user: { login: 'kingsley-multimedia-automation[bot]', type: 'Bot', id: botId },
    auto_merge: null, draft: false, mergeable: true, changed_files: 1,
    merged_at: null, updated_at: '2026-11-22T00:00:00Z',
    head: { ref: branch, sha: state.branchHead, repo: { full_name: fullName } },
    base: { ref: 'Source_Code', sha: state.currentBase, repo: { full_name: fullName } },
    html_url: 'https://github.com/' + fullName + '/pull/75',
  });
  const reader = { rest: {
    actions: {
      listWorkflowRuns: async () => ({ data: {
        total_count: state.total, workflow_runs: state.run ? [state.run] : [],
      } }),
      getWorkflowRun: async ({ run_id }) => ({ data: run_id === run.id ? { ...run } : null }),
      getWorkflowRunAttempt: async ({ run_id, attempt_number }) => ({
        data: run_id === run.id && attempt_number === run.run_attempt ? { ...run } : null,
      }),
    },
    repos: {
      get: async () => ({ data: { full_name: fullName, node_id: 'R_test_repository' } }),
      getContent: async ({ ref }) => {
        const value = ref === base || ref === moved ? state.old :
          ref === refreshedCommit || ref === mergedCommit || ref === secondCommit ? state.newReport :
          ref === newCommit ? (state.previousReport ?? state.newReport) : null;
        if (value === null) throw missing();
        return { data: { type: 'file', encoding: 'base64', sha: blob(value),
          content: Buffer.from(value, 'utf8').toString('base64') } };
      },
    },
    git: {
      getRef: async ({ ref }) => {
        if (ref === 'heads/Source_Code') {
          state.baseReads++;
          const value = state.baseMovesAt && state.baseReads >= state.baseMovesAt ? moved : state.currentBase;
          return { data: { ref: 'refs/heads/Source_Code', object: { type: 'commit', sha: value } } };
        }
        if (!state.refs[ref]) throw missing();
        return { data: { ref: 'refs/' + ref, object: { type: 'commit', sha: state.refs[ref] } } };
      },
      getCommit: async ({ commit_sha }) => {
        if (commit_sha === base || commit_sha === moved) return { data: { sha: commit_sha, tree: { sha: baseTree }, parents: [] } };
        if (state.mergeCandidate && commit_sha === state.mergeCandidate.sha) return { data: state.mergeCandidate };
        if (state.refreshCandidate && commit_sha === state.refreshCandidate.sha) return { data: state.refreshCandidate };
        if (state.candidate && commit_sha === state.candidate.sha) return { data: state.candidate };
        if (state.firstCandidate && commit_sha === state.firstCandidate.sha) return { data: state.firstCandidate };
        throw missing();
      },
      getTree: async ({ tree_sha, recursive }) => {
        const oldSha = oldBlob();
        const newSha = state.newReport === null ? oldSha : currentBlob();
        if (recursive === 'true') {
          const isBase = tree_sha === baseTree;
          if (![baseTree, newTree, refreshedTree].includes(tree_sha)) throw missing();
          const ghTree = isBase ? baseGithub : (tree_sha === refreshedTree ? refreshedGithub : newGithub);
          const automationTree = isBase ? baseAutomation : (tree_sha === refreshedTree ? refreshedAutomation : newAutomation);
          const content = isBase ? oldSha : newSha;
          return { data: tree(tree_sha,
            entry('.github', 'tree', '040000', ghTree),
            entry('.github/automation', 'tree', '040000', automationTree),
            entry(path, 'blob', '100644', content),
            entry('README.md', 'blob', '100644', state.treeUnexpected && !isBase ? '3'.repeat(40) : 'e1'.repeat(20)),
            entry('scripts', 'tree', '040000', 'e2'.repeat(20)),
            entry('scripts/tool.py', 'blob', '100644', 'e3'.repeat(20))) };
        }
        const trees = {
          [baseTree]: tree(baseTree, entry('.github', 'tree', '040000', baseGithub)),
          [baseGithub]: tree(baseGithub, entry('automation', 'tree', '040000', baseAutomation)),
          [baseAutomation]: tree(baseAutomation, entry('ci-health.json', 'blob', '100644', oldSha)),
          [newTree]: tree(newTree, entry('.github', 'tree', '040000', newGithub)),
          [newGithub]: tree(newGithub, entry('automation', 'tree', '040000', newAutomation)),
          [newAutomation]: tree(newAutomation, entry('ci-health.json', 'blob', '100644',
            state.previousReport === null ? newSha : blob(state.previousReport))),
          [refreshedTree]: tree(refreshedTree, entry('.github', 'tree', '040000', refreshedGithub)),
          [refreshedGithub]: tree(refreshedGithub, entry('automation', 'tree', '040000', refreshedAutomation)),
          [refreshedAutomation]: tree(refreshedAutomation, entry('ci-health.json', 'blob', '100644', newSha)),
        };
        if (!trees[tree_sha]) throw missing();
        return { data: state.incompleteTree ? { ...trees[tree_sha], truncated: true } : trees[tree_sha] };
      },
    },
    pulls: {
      get: async ({ pull_number }) => {
        assert.equal(pull_number, state.pr?.number);
        return { data: state.pr };
      },
      listFiles: async () => ({ data: state.pr.changed_files === 0 ? [] : [{
        filename: path, status: 'modified', sha: currentBlob(),
      }] }),
      list: async (args) => {
        if (args.state === 'open') {
          return { data: [...state.openOthers, ...(state.pr?.state === 'open' ? [state.pr] : [])] };
        }
        if (args.state === 'closed') {
          if (state.manyRecentClosed) {
            return { data: Array.from({ length: 100 }, () => ({
              state: 'closed', updated_at: '2026-11-22T00:00:00Z', user: { id: 9, login: 'other', type: 'User' },
            })) };
          }
          return { data: [...state.closedOthers, ...(state.pr?.state === 'closed' ? [state.pr] : [])] };
        }
        if (args.state === 'all') return { data: state.pr && args.head === owner + ':' + state.pr.head.ref ? [state.pr] : [] };
        throw new Error('unexpected pull list');
      },
    },
  } };
  reader.paginate = async (fn, args) => (await fn(args)).data;
  reader.request = async (route, args) => {
    assert.equal(route, 'GET /repos/{owner}/{repo}/compare/{base}...{head}');
    if (args.base === base && args.head === moved) {
      return { data: { status: 'ahead', ahead_by: 1, behind_by: 0, total_commits: 1,
        base_commit: { sha: base }, merge_base_commit: { sha: base }, files: [] } };
    }
    const isStale = args.base === moved && [newCommit, refreshedCommit].includes(args.head);
    const isMerged = args.base === moved && args.head === mergedCommit;
    const isFresh = args.head === refreshedCommit && [base, newCommit, moved].includes(args.base);
    const isSecond = args.head === secondCommit && [base, moved].includes(args.base);
    assert.ok((args.base === base && args.head === newCommit) || isStale || isMerged || isFresh || isSecond);
    const reportAtHead = args.head === refreshedCommit || args.head === mergedCommit || args.head === secondCommit ?
      state.newReport : (state.previousReport ?? state.newReport);
    const files = [{ filename: path, status: 'modified', sha: blob(reportAtHead) }];
    if (state.extraFile) files.push({ filename: 'unrelated.txt', status: 'modified', sha: '3'.repeat(40) });
    const ahead = isMerged ? (state.refreshCandidate ? 3 : 2) :
      (isFresh && [base, moved].includes(args.base) ? 2 : 1);
    return { data: { status: isStale ? 'diverged' : 'ahead',
      ahead_by: ahead, behind_by: isStale ? 1 : 0, total_commits: ahead,
      base_commit: { sha: args.base }, merge_base_commit: { sha: isStale ? base : args.base }, files } };
  };
  const writer = {
    graphql: async (query, { input }) => {
      if (query.includes('updateRefs')) {
        state.writes.push({ kind: 'updateRefs', input });
        if (state.casConflict) throw new Error('beforeOid conflict');
        assert.equal(input.repositoryId, 'R_test_repository');
        assert.equal(input.refUpdates.length, 1);
        const change = input.refUpdates[0];
        assert.equal(change.name, 'refs/heads/' + branch);
        assert.equal(change.beforeOid, state.branchHead);
        assert.equal(change.afterOid, mergedCommit);
        assert.equal(change.force, false);
        if (state.retargetDuringCas) state.pr.base.ref = 'Multimedia_Downloader_Web_Preview';
        state.branchHead = mergedCommit;
        state.refs['heads/' + branch] = mergedCommit;
        state.pr.head.sha = mergedCommit;
        return { updateRefs: { clientMutationId: input.clientMutationId } };
      }
      state.writes.push({ kind: 'graphql', input });
      if (state.casConflict) throw new Error('expectedHeadOid conflict');
      assert.match(query, /createCommitOnBranch/);
      assert.equal(input.expectedHeadOid, state.branchHead);
      assert.deepEqual(input.fileChanges.additions.map((file) => file.path), [path]);
      state.previousReport = state.newReport;
      state.newReport = Buffer.from(input.fileChanges.additions[0].contents, 'base64').toString('utf8');
      state.refreshCandidate = { sha: refreshedCommit, tree: { sha: refreshedTree },
        message: 'chore: refresh scheduled CI health report\n\nOpenAI-Codex_health_release_architecture',
        parents: [{ sha: state.branchHead }] };
      state.branchHead = refreshedCommit;
      state.refs['heads/' + branch] = refreshedCommit;
      state.pr.head.sha = refreshedCommit;
      return { createCommitOnBranch: { commit: { oid: refreshedCommit }, ref: { target: { oid: refreshedCommit } } } };
    },
    request: async (route, args) => {
    assert.equal(route, 'GET /apps/{app_slug}');
    assert.equal(args.app_slug, 'kingsley-multimedia-automation');
    return { data: { id: state.badIdentity ? 1 : 5868451, slug: args.app_slug } };
  }, rest: {
    users: {
      getByUsername: async ({ username }) => ({ data: { login: username, type: 'Bot', id: botId } }),
    },
    git: {
      createBlob: async (args) => {
        state.writes.push({ kind: 'blob', args });
        if (state.candidate && state.pr?.state === 'closed') state.previousReport = state.newReport;
        state.newReport = args.content;
        return { data: { sha: blob(args.content) } };
      },
      createTree: async (args) => {
        state.writes.push({ kind: 'tree', args });
        return { data: { sha: state.refreshCandidate || (state.candidate && state.pr?.state === 'closed') ? refreshedTree : newTree } };
      },
      createCommit: async (args) => {
        state.writes.push({ kind: 'commit', args });
        if (args.parents.length === 2) {
          state.mergeCandidate = { sha: mergedCommit, message: args.message,
            tree: { sha: args.tree }, parents: args.parents.map((value) => ({ sha: value })) };
          return { data: state.mergeCandidate };
        }
        if (state.candidate) state.firstCandidate = state.candidate;
        state.candidate = { sha: state.firstCandidate ? secondCommit : newCommit, message: args.message,
          tree: { sha: args.tree }, parents: args.parents.map((value) => ({ sha: value })) };
        return { data: state.candidate };
      },
      createRef: async (args) => {
        state.writes.push({ kind: 'ref', args });
        assert.equal(args.ref, 'refs/heads/automation/ci-health-' + state.run.id + '-' + state.run.run_attempt + '-' + state.currentBase);
        branchRef = args.ref;
        branch = args.ref.slice('refs/heads/'.length);
        state.branchHead = args.sha;
        state.refs['heads/' + branch] = args.sha;
        return { data: { ref: args.ref, object: { sha: args.sha } } };
      },
    },
    pulls: {
      update: async (args) => {
        state.writes.push({ kind: 'close', args });
        assert.equal(args.state, 'closed');
        state.pr.state = 'closed';
        return { data: state.pr };
      },
      create: async (args) => {
        state.writes.push({ kind: 'pr', args });
        if (state.failPullCreate) throw new Error('simulated PR API failure');
        state.pr = makePr();
        return { data: state.pr };
      },
    },
  } };
  const core = {
    info: (value) => state.notices.push(value),
    notice: (value) => state.notices.push(value),
    warning: (value) => state.notices.push(value),
  };
  const invoke = () => executeScript({ repo: { owner, repo }, ref: state.sourceRef ?? 'refs/heads/Source_Code' }, reader, core,
    (token) => { assert.equal(token, 'test-token'); return writer; },
    { env: { APP_TOKEN: 'test-token', APP_SLUG: 'kingsley-multimedia-automation' } }, Buffer, localRequire,
    (callback) => callback());
  return { state, invoke, makePr };
}

test('skips absent runs and unchanged report without writes', async () => {
  const none = harness({ run: null, total: 0 });
  await none.invoke();
  assert.deepEqual(none.state.writes, []);
  const same = harness({ old: expectedReport });
  await same.invoke();
  assert.deepEqual(same.state.writes, []);
});

test('creates only one exact report commit and PR, then reruns idempotently', async () => {
  const h = harness();
  await h.invoke();
  assert.deepEqual(h.state.writes.map((entry) => entry.kind), ['blob', 'tree', 'commit', 'ref', 'pr']);
  assert.equal(h.state.newReport, expectedReport);
  const changes = h.state.writes.find((entry) => entry.kind === 'tree').args.tree;
  assert.deepEqual(changes, [{ path, mode: '100644', type: 'blob', sha: blob(expectedReport) }]);
  assert.deepEqual(h.state.writes.find((entry) => entry.kind === 'commit').args.parents, [base]);
  assert.equal(h.state.writes.find((entry) => entry.kind === 'pr').args.base, 'Source_Code');
  const count = h.state.writes.length;
  await h.invoke();
  assert.equal(h.state.writes.length, count);
});

test('does not reopen a previously closed report PR', async () => {
  const h = harness();
  await h.invoke();
  h.state.pr.state = 'closed';
  const count = h.state.writes.length;
  await assert.rejects(h.invoke(), /was closed; it will not be reopened/);
  assert.equal(h.state.writes.length, count);
});

test('recovers an exact orphan branch after PR creation failed without updating or forcing it', async () => {
  const h = harness({ failPullCreate: true });
  await assert.rejects(h.invoke(), /simulated PR API failure/);
  assert.equal(h.state.writes.filter((entry) => entry.kind === 'ref').length, 1);
  h.state.failPullCreate = false;
  await h.invoke();
  assert.equal(h.state.writes.filter((entry) => entry.kind === 'ref').length, 1);
  assert.equal(h.state.writes.filter((entry) => entry.kind === 'blob').length, 1);
  assert.equal(h.state.pr.state, 'open');
});

test('rejects malformed run data and incomplete Git trees before creating a branch', async () => {
  const malformed = harness();
  delete malformed.state.run.html_url;
  await assert.rejects(malformed.invoke(), /metadata is incomplete/);
  assert.deepEqual(malformed.state.writes, []);
  const badTree = harness({ incompleteTree: true });
  await assert.rejects(badTree.invoke(), /Git tree is incomplete/);
  assert.deepEqual(badTree.state.writes, []);
});

test('stops when base moves, including after branch creation, without creating a PR', async () => {
  const beforeRef = harness({ baseMovesAt: 2 });
  await assert.rejects(beforeRef.invoke(), /Source_Code moved/);
  assert.equal(beforeRef.state.writes.some((entry) => entry.kind === 'ref'), false);
  const afterRef = harness({ baseMovesAt: 3 });
  await assert.rejects(afterRef.invoke(), /Source_Code moved/);
  assert.equal(afterRef.state.writes.filter((entry) => entry.kind === 'ref').length, 1);
  assert.equal(afterRef.state.writes.some((entry) => entry.kind === 'pr'), false);
});

test('fails closed on unexpected changed files or competing health PRs', async () => {
  const unsafe = harness({ extraFile: true });
  await assert.rejects(unsafe.invoke(), /changes more than the intended report/);
  assert.equal(unsafe.state.writes.some((entry) => entry.kind === 'pr'), false);
  const conflict = harness({ openOthers: [98, 99].map((number) => ({
    number, state: 'open', user: { login: 'kingsley-multimedia-automation[bot]', type: 'Bot', id: botId },
    head: { ref: 'automation/ci-health-' + number + '-1', repo: { full_name: fullName } },
  })) });
  await assert.rejects(conflict.invoke(), /Multiple App health PRs/);
  assert.deepEqual(conflict.state.writes, []);
});

test('updates an existing stale health PR without forcing and verifies the new head', async () => {
  const h = harness();
  await h.invoke();
  h.state.currentBase = moved;
  h.state.pr.base.sha = moved;
  const count = h.state.writes.length;
  await h.invoke();
  const updates = h.state.writes.filter((entry) => entry.kind === 'updateRefs');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].input.refUpdates[0].beforeOid, newCommit);
  assert.equal(updates[0].input.refUpdates[0].afterOid, mergedCommit);
  assert.equal(updates[0].input.refUpdates[0].force, false);
  assert.deepEqual(h.state.mergeCandidate.parents.map((item) => item.sha), [newCommit, moved]);
  assert.equal(h.state.branchHead, mergedCommit);
  assert.equal(h.state.writes.length, count + 3);
  await h.invoke();
  assert.equal(h.state.writes.length, count + 3);
});

test('preserves the branch when atomic ref comparison fails', async () => {
  const h = harness();
  await h.invoke();
  h.state.currentBase = moved;
  h.state.pr.base.sha = moved;
  h.state.casConflict = true;
  await assert.rejects(h.invoke(), /beforeOid conflict/);
  assert.equal(h.state.branchHead, newCommit);
  assert.equal(h.state.refs['heads/automation/ci-health-123-1-' + base], newCommit);
});

test('refuses stale updates when mergeability or auto-merge is unsafe', async () => {
  const conflict = harness();
  await conflict.invoke();
  conflict.state.currentBase = moved;
  conflict.state.pr.base.sha = moved;
  conflict.state.pr.mergeable = false;
  await assert.rejects(conflict.invoke(), /mergeability is unavailable or conflicted/);
  assert.equal(conflict.state.writes.some((entry) => entry.kind === 'updateRefs'), false);

  const auto = harness();
  await auto.invoke();
  auto.state.currentBase = moved;
  auto.state.pr.base.sha = moved;
  auto.state.pr.auto_merge = { enabled_by: { login: 'owner' } };
  await assert.rejects(auto.invoke(), /auto-merge setting is unsafe/);
  assert.equal(auto.state.writes.some((entry) => entry.kind === 'updateRefs'), false);
});

test('ignores health-like PRs from forks or other identities', async () => {
  const other = harness({ openOthers: [
    { number: 98, state: 'open', user: { login: 'other', type: 'User', id: 999 },
      head: { ref: 'automation/ci-health-999-1', repo: { full_name: 'other/Multimedia_Downloader' } } },
    { number: 99, state: 'open', user: { login: 'other', type: 'User', id: 999 },
      head: { ref: 'automation/ci-health-998-1', repo: { full_name: fullName } } },
  ] });
  await other.invoke();
  assert.equal(other.state.pr.state, 'open');
  assert.equal(other.state.writes.filter((entry) => entry.kind === 'pr').length, 1);
});

test('rejects an unverified App identity before any writes', async () => {
  const h = harness({ badIdentity: true });
  await assert.rejects(h.invoke(), /App identity cannot be verified/);
  assert.deepEqual(h.state.writes, []);
});

test('refreshes the same App PR for a newer scheduled run using expectedHeadOid', async () => {
  const h = harness();
  await h.invoke();
  const previousWrites = h.state.writes.length;
  h.state.run = { ...run, id: 124, html_url: 'https://github.com/' + fullName + '/actions/runs/124' };
  await h.invoke();
  const write = h.state.writes.find((entry) => entry.kind === 'graphql');
  assert.equal(write.input.expectedHeadOid, newCommit);
  assert.equal(write.input.branch.branchName, 'automation/ci-health-123-1-' + base);
  assert.equal(h.state.branchHead, refreshedCommit);
  assert.equal(h.state.pr.head.ref, 'automation/ci-health-123-1-' + base);
  assert.equal(h.state.writes.length, previousWrites + 1);
  assert.equal(JSON.parse(h.state.newReport).run_id, 124);
  await h.invoke();
  assert.equal(h.state.writes.length, previousWrites + 1);
});

test('does not update the branch if an expected-head comparison fails', async () => {
  const h = harness({ casConflict: true });
  await h.invoke();
  h.state.run = { ...run, id: 124, html_url: 'https://github.com/' + fullName + '/actions/runs/124' };
  await assert.rejects(h.invoke(), /expectedHeadOid conflict/);
  assert.equal(h.state.branchHead, newCommit);
  assert.equal(h.state.pr.head.sha, newCommit);
});

test('a refreshed and closed report is not recreated for the same scheduled run', async () => {
  const h = harness();
  await h.invoke();
  h.state.run = { ...run, id: 124, html_url: 'https://github.com/' + fullName + '/actions/runs/124' };
  await h.invoke();
  h.state.pr.state = 'closed';
  const count = h.state.writes.length;
  await assert.rejects(h.invoke(), /was closed; it will not be reopened/);
  assert.equal(h.state.writes.length, count);
});

test('a closed old report does not prevent a later scheduled run from opening a new PR', async () => {
  const h = harness();
  await h.invoke();
  h.state.pr.state = 'closed';
  h.state.run = { ...run, id: 124, html_url: 'https://github.com/' + fullName + '/actions/runs/124' };
  await h.invoke();
  assert.equal(h.state.pr.state, 'open');
  assert.equal(h.state.pr.head.ref, 'automation/ci-health-124-1-' + base);
  assert.notEqual(h.state.pr.head.sha, newCommit);
  assert.equal(h.state.pr.head.sha, secondCommit);
  assert.equal(h.state.refs['heads/automation/ci-health-123-1-' + base], newCommit);
});

test('refreshes a newer report and then updates a stale base without force', async () => {
  const h = harness();
  await h.invoke();
  h.state.run = { ...run, id: 124, html_url: 'https://github.com/' + fullName + '/actions/runs/124' };
  h.state.currentBase = moved;
  h.state.pr.base.sha = moved;
  await h.invoke();
  const refresh = h.state.writes.find((entry) => entry.kind === 'graphql');
  const update = h.state.writes.find((entry) => entry.kind === 'updateRefs');
  assert.equal(refresh.input.expectedHeadOid, newCommit);
  assert.equal(update.input.refUpdates[0].beforeOid, refreshedCommit);
  assert.equal(update.input.refUpdates[0].force, false);
  assert.deepEqual(h.state.mergeCandidate.parents.map((item) => item.sha), [refreshedCommit, moved]);
  assert.equal(h.state.branchHead, mergedCommit);
  assert.equal(JSON.parse(h.state.newReport).run_id, 124);
});

// OpenAI-Codex_health_release_architecture: preserve coverage of the default legacy path.
const legacyScript = workflow.split(start)[1].split('\n  report:')[0]
  .split('\n').map((line) => line.slice(12)).join('\n');

async function executeLegacyHealth(legacyRun, existing) {
  const writes = [];
  const github = { rest: {
    actions: { listWorkflowRuns: async () => ({ data: { workflow_runs: legacyRun ? [legacyRun] : [] } }) },
    repos: {
      getContent: async () => {
        if (!existing) { const error = new Error('missing'); error.status = 404; throw error; }
        return { data: existing };
      },
      createOrUpdateFileContents: async (args) => writes.push(args),
    },
  } };
  const core = { notice() {}, info() {} };
  await new AsyncFunction('context', 'github', 'core', legacyScript)(
    { repo: { owner: 'o', repo: 'r' } }, github, core,
  );
  return writes;
}

const legacyRun = {
  id: 123, status: 'completed', conclusion: 'success', html_url: 'https://github.com/o/r/actions/runs/123',
};

test('legacy mode creates a deterministic report only when a run exists', async () => {
  assert.deepEqual(await executeLegacyHealth(null), []);
  const writes = await executeLegacyHealth(legacyRun);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].branch, 'Source_Code');
  const value = JSON.parse(Buffer.from(writes[0].content, 'base64').toString());
  assert.equal(value.run_id, 123);
  assert.equal(value.conclusion, 'success');
});

test('legacy mode avoids redundant commits and validates existing file metadata', async () => {
  const first = (await executeLegacyHealth(legacyRun))[0];
  const existing = { type: 'file', encoding: 'base64', sha: 'abc', content: first.content };
  assert.deepEqual(await executeLegacyHealth(legacyRun, existing), []);
  const changed = await executeLegacyHealth({ ...legacyRun, conclusion: 'failure' }, existing);
  assert.equal(changed[0].sha, 'abc');
  await assert.rejects(executeLegacyHealth(legacyRun, { ...existing, type: 'dir' }));
});

test('mode gates default to legacy and reject unknown values', () => {
  assert.match(workflow, /legacy-report:\n    if: >-\n      \(vars\.AUTOMATION_PR_MODE == '' \|\| vars\.AUTOMATION_PR_MODE == 'legacy'\) &&/);
  assert.match(workflow, /github\.event\.schedule == '25 13 \* \* 2'/);
  assert.match(workflow, /report:\n    if: >-[\s\S]*?vars\.AUTOMATION_PR_MODE == 'enabled'/);
  assert.match(workflow, /github\.event\.workflow_run\.head_repository\.full_name == github\.repository/);
  assert.match(workflow, /startsWith\(github\.event\.workflow_run\.head_branch, 'automation\/ci-health-'\)/);
  assert.match(workflow, /invalid-mode:\n    if: vars\.AUTOMATION_PR_MODE != '' && vars\.AUTOMATION_PR_MODE != 'legacy' && vars\.AUTOMATION_PR_MODE != 'enabled'/);
  assert.match(workflow, /AUTOMATION_PR_MODE must be empty, legacy, or enabled\./);
  assert.match(workflow, /invalid-mode:[\s\S]*?exit 1\n  legacy-report:/);
});

test('allows recovery when a merged report was subsequently reverted', async () => {
  const h = harness();
  await h.invoke();
  h.state.pr.state = 'closed';
  h.state.pr.merged_at = '2026-11-22T00:00:00Z';
  h.state.currentBase = moved;
  await h.invoke();
  assert.equal(h.state.pr.state, 'open');
  assert.equal(h.state.pr.head.ref, 'automation/ci-health-123-1-' + moved);
  assert.equal(h.state.pr.head.sha, secondCommit);
  assert.equal(h.state.refs['heads/automation/ci-health-123-1-' + base], newCommit);
});

test('closes only an App PR made redundant by the current base and preserves its branch', async () => {
  const h = harness();
  await h.invoke();
  h.state.old = expectedReport;
  h.state.pr.changed_files = 0;
  const before = h.state.writes.length;
  await h.invoke();
  assert.equal(h.state.pr.state, 'closed');
  assert.equal(h.state.writes.length, before + 1);
  assert.equal(h.state.writes.at(-1).kind, 'close');
  assert.equal(h.state.refs['heads/automation/ci-health-123-1-' + base], newCommit);
  assert.ok(h.state.notices.some((notice) => notice.includes('branch was preserved')));
});

test('bounds the closed PR scan and fails on incomplete timestamps', async () => {
  const many = harness({ manyRecentClosed: true });
  await assert.rejects(many.invoke(), /Too many recent closed PRs/);
  assert.deepEqual(many.state.writes, []);
  const missingTime = harness({ closedOthers: [{ state: 'closed' }] });
  await assert.rejects(missingTime.invoke(), /timestamps are incomplete/);
  assert.deepEqual(missingTime.state.writes, []);
  const old = harness({ closedOthers: [{ state: 'closed', updated_at: '2026-11-20T00:00:00Z' }] });
  await old.invoke();
  assert.equal(old.state.pr.state, 'open');
});

test('refuses a case-mismatched source ref before any write', async () => {
  const h = harness({ sourceRef: 'refs/heads/source_code' });
  await assert.rejects(h.invoke(), /Unexpected repository/);
  assert.deepEqual(h.state.writes, []);
});

test('checks the exact source ref before either legacy writing or minting an App token', () => {
  const legacy = workflow.indexOf('  legacy-report:');
  const app = workflow.indexOf('\n  report:');
  assert.ok(legacy >= 0 && app > legacy);
  assert.ok(workflow.indexOf('Verify exact source ref', legacy) < workflow.indexOf('Update report when scheduled CI changes', legacy));
  assert.ok(workflow.indexOf('Verify exact source ref', app) < workflow.indexOf('Create a repository-scoped App token', app));
});

test('rejects an unrelated change in a generated base tree before the ref update', async () => {
  const h = harness();
  await h.invoke();
  h.state.currentBase = moved;
  h.state.pr.base.sha = moved;
  h.state.treeUnexpected = true;
  await assert.rejects(h.invoke(), /changed an unrelated object/);
  assert.equal(h.state.writes.some((entry) => entry.kind === 'updateRefs'), false);
  assert.equal(h.state.branchHead, newCommit);
});

test('a concurrent retarget cannot alter the fixed Source_Code parent', async () => {
  const h = harness({ retargetDuringCas: true });
  await h.invoke();
  h.state.currentBase = moved;
  h.state.pr.base.sha = moved;
  await assert.rejects(h.invoke(), /identity, head, base, or auto-merge setting is unsafe/);
  assert.deepEqual(h.state.mergeCandidate.parents.map((item) => item.sha), [newCommit, moved]);
  assert.equal(h.state.branchHead, mergedCommit);
});

// OpenAI-Codex_health_release_architecture: prevent an opt-in variable from enabling App writes before isolation.
test('health PR mode stops unconditionally before creating an App token', () => {
  const report = workflow.split('\n  report:\n')[1];
  assert.ok(report, 'health PR job must be present');
  const guard = "      # OpenAI-Codex_health_release_architecture: keep App PR writes disabled until branch isolation is verified.\n" +
    "      - name: Block health PR writes pending branch isolation\n" +
    "        shell: bash\n" +
    "        run: |\n" +
    "          echo '::error::Health App PR mode is disabled until branch isolation is verified.'\n" +
    "          exit 1\n";
  const tokenStep = "      - name: Create a repository-scoped App token\n";
  assert.equal(report.split(guard).length, 2, 'the unconditional fail-closed step must be unique');
  assert.ok(report.indexOf(guard) < report.indexOf(tokenStep), 'the guard must precede the App token');
  assert.ok(report.includes(guard + tokenStep), 'no step may be inserted between the guard and token');
  assert.match(report, /vars\.AUTOMATION_PR_MODE == 'enabled'/);
  assert.doesNotMatch(guard, /^\s*(?:if|continue-on-error):/m);
});
