// OpenAI-Codex_health_release_architecture: exercise the staged fixed-branch writer with mocked GitHub APIs.
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
const execute = new AsyncFunction('context', 'github', 'core', 'getOctokit', 'process', 'Buffer', 'require', script);
const localRequire = createRequire(import.meta.url);
const owner = 'KingsleyHK0323';
const repo = 'Multimedia_Downloader';
const full = owner + '/' + repo;
const path = '.github/automation/ci-health.json';
const branch = 'automation/protected-workflows';
const base = 'a'.repeat(40);
const moved = 'd'.repeat(40);
const baseTree = 'b'.repeat(40);
const changedTree = 'c'.repeat(40);
const candidate = 'e'.repeat(40);
const bot = { id: 359694872, login: 'kingsley-multimedia-automation[bot]', type: 'Bot' };
const oldReport = Buffer.from('{"previous":true}\n');
const blob = (bytes) => createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
const missing = () => Object.assign(new Error('not found'), { status: 404 });

function harness(options = {}) {
  const state = { base, ref: null, pr: null, closed: [], basePrs: [], externalPrs: [], writes: [],
    notices: [], commits: {}, report: null, reportBlob: null, badSignature: false, badTree: false,
    failCreatePr: false, moveAfterRef: false, ...options };
  state.run = state.run ?? { id: 123, run_attempt: 1, path: '.github/workflows/ci.yml', event: 'schedule',
    head_branch: 'Source_Code', status: 'completed', conclusion: 'success', created_at: '2026-11-22T00:00:00Z',
    html_url: 'https://github.com/' + full + '/actions/runs/123',
    repository: { id: 1251103365 }, head_repository: { id: 1251103365 } };
  const tree = (changed) => [
    { path: '.github', type: 'tree', mode: '040000', sha: (changed ? '1' : '2').repeat(40) },
    { path: '.github/automation', type: 'tree', mode: '040000', sha: (changed ? '3' : '4').repeat(40) },
    { path, type: 'blob', mode: '100644', sha: changed ? (state.historicReport ? blob(state.historicReport) : state.reportBlob) : blob(oldReport) },
    { path: 'README.md', type: 'blob', mode: '100644', sha: (changed && state.badTree ? '5' : '6').repeat(40) },
  ];
  const makePr = () => ({
    number: 41, state: 'open', user: bot, draft: false, auto_merge: null, labels: [], changed_files: 1,
    head: { ref: branch, sha: state.ref, repo: { id: 1251103365, full_name: full } },
    base: { ref: 'Source_Code', sha: state.base, repo: { id: 1251103365, full_name: full } },
    html_url: 'https://github.com/' + full + '/pull/41',
  });
  const reader = { rest: {
    actions: {
      listWorkflowRuns: async () => ({ data: { total_count: state.noRun ? 0 : 1,
        workflow_runs: state.noRun ? [] : [state.run] } }),
      getWorkflowRun: async ({ run_id }) => ({ data: { id: run_id, run_attempt: 1,
        path: '.github/workflows/automation-health.yml', event: 'workflow_dispatch', head_branch: 'Source_Code',
        repository: { id: 1251103365 }, head_repository: { id: 1251103365 } } }),
    },
    git: {
      getRef: async ({ ref }) => {
        const value = ref === 'heads/Source_Code' ? state.base : ref === 'heads/' + branch ? state.ref : null;
        if (!value) throw missing();
        return { data: { ref: 'refs/' + ref, object: { type: 'commit', sha: value } } };
      },
      getCommit: async ({ commit_sha }) => {
        if (commit_sha === state.base) return { data: { sha: state.base, tree: { sha: baseTree }, parents: [] } };
        const item = state.commits[commit_sha];
        if (!item) throw missing();
        return { data: item };
      },
      getTree: async ({ tree_sha }) => {
        if (tree_sha !== baseTree && tree_sha !== changedTree) throw missing();
        return { data: { sha: tree_sha, truncated: false, tree: tree(tree_sha === changedTree) } };
      },
    },
    repos: {
      getContent: async ({ ref }) => {
        const bytes = ref === state.base ? oldReport : ref === candidate ? (state.historicReport ?? state.report) : null;
        if (!bytes) throw missing();
        return { data: { type: 'file', encoding: 'base64', sha: blob(bytes), content: bytes.toString('base64') } };
      },
      getCommit: async ({ ref }) => {
        const item = state.commits[ref];
        if (!item) throw missing();
        return { data: { sha: ref, author: bot, committer: { id: 19864447, login: 'web-flow' },
          parents: item.parents, commit: { message: item.message, tree: item.tree,
            verification: { verified: !state.badSignature, reason: state.badSignature ? 'unsigned' : 'valid' } } } };
      },
    },
    pulls: {
      list: async ({ state: kind, head, base: target }) => {
        if (kind === 'closed') return { data: state.closed };
        if (target === branch) return { data: state.basePrs };
        if (head === owner + ':' + branch) return { data: state.pr?.state === 'open' ? [state.pr] : [] };
        throw new Error('Unexpected PR query.');
      },
      get: async ({ pull_number }) => {
        if (!state.pr || state.pr.number !== pull_number) throw missing();
        return { data: state.pr };
      },
      listFiles: async () => ({ data: [{ filename: path, status: 'modified', sha: state.reportBlob }] }),
    },
  } };
  reader.paginate = async (method, args) => (await method(args)).data;
  reader.graphql = async (_query, args) => {
    assert.equal(args.ref, 'refs/heads/' + branch);
    const list = [...(state.pr?.state === 'open' ? [state.pr] : []), ...state.externalPrs];
    return { repository: { nameWithOwner: full, ref: { target: { oid: state.ref },
      associatedPullRequests: { totalCount: list.length, pageInfo: { hasNextPage: false },
        nodes: list.map((item) => ({ number: item.number, state: 'OPEN', headRefName: branch,
          baseRefName: item.base.ref, headRepository: { nameWithOwner: item.head.repo.full_name },
          baseRepository: { nameWithOwner: item.base.repo.full_name } })) } } } };
  };
  const writer = {
    request: async (route, args) => {
      assert.equal(route, 'GET /apps/{app_slug}');
      return { data: { id: 5868451, slug: args.app_slug } };
    },
    rest: {
      repos: { get: async () => ({ data: { id: 1251103365, full_name: full } }) },
      users: { getByUsername: async () => ({ data: bot }) },
      git: {
        createBlob: async ({ content, encoding }) => {
          assert.equal(encoding, 'base64');
          state.report = Buffer.from(content, 'base64');
          state.reportBlob = blob(state.report);
          state.writes.push('blob');
          return { data: { sha: state.reportBlob } };
        },
        createTree: async ({ base_tree, tree: changes }) => {
          assert.equal(base_tree, baseTree);
          assert.deepEqual(changes, [{ path, type: 'blob', mode: '100644', sha: state.reportBlob }]);
          state.writes.push('tree');
          return { data: { sha: changedTree } };
        },
        createCommit: async ({ tree: sha, parents, message }) => {
          assert.equal(sha, changedTree);
          state.commits[candidate] = { sha: candidate, tree: { sha }, parents: parents.map((value) => ({ sha: value })), message };
          state.writes.push('commit');
          return { data: state.commits[candidate] };
        },
        createRef: async ({ ref, sha }) => {
          assert.equal(ref, 'refs/heads/' + branch);
          if (state.ref) throw new Error('ref exists');
          state.ref = sha;
          state.writes.push('ref');
          if (state.moveAfterRef) state.base = moved;
          return { data: { ref, object: { sha } } };
        },
      },
      pulls: {
        create: async ({ head, base: target }) => {
          assert.equal(head, branch);
          assert.equal(target, 'Source_Code');
          if (state.failCreatePr) throw new Error('simulated create PR failure');
          state.pr = makePr();
          state.writes.push('pr');
          return { data: { number: state.pr.number } };
        },
      },
    },
  };
  const core = { info: (msg) => state.notices.push(msg), notice: (msg) => state.notices.push(msg) };
  const invoke = () => execute({ repo: { owner, repo }, ref: 'refs/heads/Source_Code' }, reader, core,
    (token) => { assert.equal(token, 'test-token'); return writer; },
    { env: { APP_TOKEN: 'test-token', APP_SLUG: 'kingsley-multimedia-automation',
      GITHUB_RUN_ID: '456', GITHUB_RUN_ATTEMPT: '1', WORKFLOW_SHA: state.workflowSha ?? state.base } }, Buffer, localRequire);
  return { state, invoke, makePr };
}

test('creates exactly one report commit and App PR and reruns idempotently', async () => {
  const h = harness();
  await h.invoke();
  assert.deepEqual(h.state.writes, ['blob', 'tree', 'commit', 'ref', 'pr']);
  assert.equal(h.state.ref, candidate);
  assert.equal(h.state.commits[candidate].parents[0].sha, base);
  assert.match(h.state.commits[candidate].message, /Health-CI: 123\/1\nWriter-Run: 456\/1$/);
  assert.equal(JSON.parse(h.state.report).run_id, 123);
  assert.equal(JSON.parse(h.state.report).run_attempt, 1);
  await h.invoke();
  assert.deepEqual(h.state.writes, ['blob', 'tree', 'commit', 'ref', 'pr']);
});

test('waits for absent and in-progress scheduled CI without a write', async () => {
  const none = harness({ noRun: true });
  await none.invoke();
  assert.deepEqual(none.state.writes, []);
  const active = harness();
  active.state.run.status = 'in_progress';
  active.state.run.conclusion = null;
  await active.invoke();
  assert.deepEqual(active.state.writes, []);
});

test('recovers only a verified orphan after PR creation fails', async () => {
  const h = harness({ failCreatePr: true });
  await assert.rejects(h.invoke(), /simulated create PR failure/);
  assert.deepEqual(h.state.writes, ['blob', 'tree', 'commit', 'ref']);
  h.state.failCreatePr = false;
  await h.invoke();
  assert.deepEqual(h.state.writes, ['blob', 'tree', 'commit', 'ref', 'pr']);
});

test('preserves an unknown occupied temporary ref and a branch used as PR base', async () => {
  const unknown = harness({ ref: '9'.repeat(40) });
  await assert.rejects(unknown.invoke());
  assert.deepEqual(unknown.state.writes, []);
  assert.equal(unknown.state.ref, '9'.repeat(40));
  const baseUsed = harness({ basePrs: [{ number: 10 }] });
  await assert.rejects(baseUsed.invoke(), /unexpected open PR/);
  assert.deepEqual(baseUsed.state.writes, []);
});

test('rejects a human-authored PR and external PR association without overwriting refs', async () => {
  const h = harness();
  await h.invoke();
  const count = h.state.writes.length;
  h.state.pr.user = { id: 1, login: 'human', type: 'User' };
  await assert.rejects(h.invoke(), /expected App health PR/);
  assert.equal(h.state.writes.length, count);
  h.state.pr.user = bot;
  h.state.externalPrs = [{ number: 42, head: { repo: { full_name: full } },
    base: { ref: 'main', repo: { full_name: 'other/project' } } }];
  await assert.rejects(h.invoke(), /unknown or incomplete PR associations/);
  assert.equal(h.state.ref, candidate);
});

test('rejects a stale base and a new scheduled report without forcing a ref', async () => {
  const h = harness();
  await h.invoke();
  const count = h.state.writes.length;
  h.state.base = moved;
  h.state.pr.base.sha = moved;
  await assert.rejects(h.invoke(), /base is stale/);
  assert.equal(h.state.ref, candidate);
  assert.equal(h.state.writes.length, count);
  h.state.base = base;
  h.state.pr.base.sha = base;
  h.state.run = { ...h.state.run, id: 124, html_url: 'https://github.com/' + full + '/actions/runs/124' };
  await assert.rejects(h.invoke(), /nonce|current|report/);
  assert.equal(h.state.ref, candidate);
  assert.equal(h.state.writes.length, count);
});

test('rejects unsigned App commits and unrelated tree changes before creating a ref', async () => {
  for (const options of [{ badSignature: true }, { badTree: true }]) {
    const h = harness(options);
    await assert.rejects(h.invoke());
    assert.equal(h.state.ref, null);
    assert.equal(h.state.writes.includes('ref'), false);
  }
});

test('does not recreate a manually closed report even after its branch is removed', async () => {
  const h = harness();
  await h.invoke();
  const closed = { ...h.state.pr, state: 'closed', merged_at: null, updated_at: '2026-11-22T01:00:00Z' };
  h.state.closed = [closed];
  h.state.pr = null;
  h.state.ref = null;
  const count = h.state.writes.length;
  await assert.rejects(h.invoke(), /manually closed/);
  assert.equal(h.state.ref, null);
  assert.equal(h.state.writes.length, count);
});

test('preserves the ref and does not create a PR if the base moves after ref creation', async () => {
  const h = harness({ moveAfterRef: true });
  await assert.rejects(h.invoke(), /Source_Code moved/);
  assert.equal(h.state.ref, candidate);
  assert.equal(h.state.pr, null);
  assert.equal(h.state.writes.includes('pr'), false);
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
  id: 123, run_attempt: 1, status: 'completed', conclusion: 'success', html_url: 'https://github.com/o/r/actions/runs/123',
};

test('legacy mode creates a deterministic report only when a run exists', async () => {
  assert.deepEqual(await executeLegacyHealth(null), []);
  const writes = await executeLegacyHealth(legacyRun);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].branch, 'Source_Code');
  const value = JSON.parse(Buffer.from(writes[0].content, 'base64').toString());
  assert.equal(value.run_id, 123);
  assert.equal(value.run_attempt, 1);
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
  assert.match(workflow, /github\.event\.workflow_run\.head_branch == 'automation\/protected-workflows'/);
  assert.match(workflow, /github\.event\.workflow_run\.event == 'push' \|\| github\.event\.workflow_run\.event == 'pull_request'/);
  assert.match(workflow, /invalid-mode:\n    if: vars\.AUTOMATION_PR_MODE != '' && vars\.AUTOMATION_PR_MODE != 'legacy' && vars\.AUTOMATION_PR_MODE != 'enabled'/);
  assert.match(workflow, /AUTOMATION_PR_MODE must be empty, legacy, or enabled\./);
  assert.match(workflow, /invalid-mode:[\s\S]*?exit 1\n  legacy-report:/);
});

// OpenAI-Codex: health proposals are opt-in and limited to the approved source ref.
test('health PR mode requires an explicit opt-in and a source ref', () => {
  const report = workflow.split('\n  report:\n')[1];
  assert.ok(report, 'health PR job must be present');
  const gate = report.split('\n    concurrency:\n')[0];
  assert.match(gate, /vars\.AUTOMATION_PR_MODE == 'enabled'/);
  assert.match(gate, /github\.repository == 'KingsleyHK0323\/Multimedia_Downloader'/);
  assert.match(gate, /github\.ref == 'refs\/heads\/Source_Code'/);
});

test('rejects an obsolete queued writer revision before any write', async () => {
  const h = harness({ workflowSha: 'f'.repeat(40) });
  await assert.rejects(h.invoke(), /writer revision is stale/);
  assert.deepEqual(h.state.writes, []);
});

test('checks the writer revision before creating an App token', () => {
  const report = workflow.split('\n  report:\n')[1];
  const revision = report.indexOf('      - name: Verify current health writer revision\n');
  const token = report.indexOf('      - name: Create a repository-scoped App token\n');
  assert.ok(revision >= 0 && revision < token);
  assert.ok(report.includes("WORKFLOW_SHA: ${{ job.workflow_sha }}"));
  assert.match(report, /source_sha.*git\/ref\/heads\/Source_Code/);
});

test('legacy mode refuses missing or invalid scheduled run attempt metadata', async () => {
  for (const attempt of [undefined, 0, -1, '1']) {
    assert.deepEqual(await executeLegacyHealth({ ...legacyRun, run_attempt: attempt }), []);
  }
});

test('a rerun attempt produces its actual attempt in the proposed report', async () => {
  const h = harness();
  h.state.run.run_attempt = 2;
  await h.invoke();
  const value = JSON.parse(h.state.report.toString('utf8'));
  assert.equal(value.run_id, 123);
  assert.equal(value.run_attempt, 2);
  assert.deepEqual(Object.keys(value), ['generated_by', 'workflow', 'event', 'branch',
    'run_id', 'run_attempt', 'status', 'conclusion', 'url']);
});

test('legacy health retains its lock while the App writer uses the shared service lock', () => {
  const parts = workflow.split('\n  report:');
  assert.equal(parts.length, 2);
  assert.match(parts[0], /group: automation-health-report\n      queue: max/);
  assert.match(parts[1], /group: automation-service-reconcile\n      queue: max/);
});

test('does not recreate a manually closed equivalent report from the previous schema', async () => {
  const h = harness();
  await h.invoke();
  const previous = JSON.parse(h.state.report.toString('utf8'));
  delete previous.run_attempt;
  h.state.historicReport = Buffer.from(JSON.stringify(previous, null, 2) + '\n', 'utf8');
  h.state.closed = [{ ...h.state.pr, state: 'closed', merged_at: null, updated_at: '2026-11-22T01:00:00Z' }];
  h.state.pr = null;
  h.state.ref = null;
  const count = h.state.writes.length;
  await assert.rejects(h.invoke(), /manually closed/);
  assert.equal(h.state.writes.length, count);
  assert.equal(h.state.ref, null);
});
