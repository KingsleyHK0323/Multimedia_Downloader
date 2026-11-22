// OpenAI-Codex_format_architecture: verify formatter CAS against in-memory GitHub APIs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { readPlan, reconcileFormatter } from './auto-format-cas.mjs';

const owner = 'KingsleyHK0323', repo = 'Multimedia_Downloader';
const full = owner + '/' + repo, service = 'automation/protected-workflows';
const oid = character => character.repeat(40);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const blob = bytes => createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
const source = Buffer.from('x=1\n'), formatted = Buffer.from('x = 1\n');
const bot = { id: 359694872, login: 'kingsley-multimedia-automation[bot]', type: 'Bot' };
const webFlow = { id: 19864447, login: 'web-flow', type: 'User' };
const context = { repo: { owner, repo }, ref: 'refs/heads/Source_Code' };
const anchor = '2f596251077f7dad4d68928339c82a05f118aaed';

function fixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'formatter-cas-'));
  const refs = new Map([['Source_Code', oid('a')]]);
  const trees = new Map([[oid('1'), [{ path: 'test.py', type: 'blob', mode: '100644', sha: blob(source), size: source.length }]]]);
  const commits = new Map([[oid('a'), { sha: oid('a'), tree: { sha: oid('1') }, parents: [{ sha: oid('9') }] }]]);
  const prs = [];
  const writes = [];
  const checks = new Map();
  const completedAt = new Date(Date.now() - (options.staleCheck ? 8 * 24 * 60 * 60 * 1000 : 0)).toISOString();
  const state = { root, refs, trees, commits, prs, writes, checks, options, commitCount: 0, treeCount: 0 };

  function writePlan(base = oid('a')) {
    const branchHead = refs.get(service) || null;
    const prior = [];
    let cursor = branchHead;
    const isAncestor = (candidate, head) => {
      if (candidate === head) return true;
      const seen = new Set(), queue = [head];
      while (queue.length) {
        const value = queue.pop();
        if (value === candidate) return true;
        if (seen.has(value)) continue;
        seen.add(value);
        for (const parent of commits.get(value)?.parents || []) queue.push(parent.sha);
      }
      return false;
    };
    while (cursor && !isAncestor(cursor, base)) {
      const commit = commits.get(cursor);
      prior.push({ base: commit.parents[0].sha, digest: commit.message.split('Format-Plan-SHA256: ')[1], head: cursor, tree: commit.tree.sha });
      cursor = commit.parents[1]?.sha || null;
    }
    const plan = { anchor, base, black: '25.1.0', configs: [], limited: false, prior, service: branchHead,
      warning_count: 0, warnings: [],
      files: [{ path: 'test.py', mode: '100644', source: blob(source), last_change: base,
        output: blob(formatted), sha256: hash(formatted), size: formatted.length }] };
    for (const name of ['one', 'two']) {
      const dir = join(root, name);
      mkdirSync(join(dir, 'blobs'), { recursive: true });
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify(plan));
      writeFileSync(join(dir, 'blobs', hash(formatted)), formatted);
    }
  }
  writePlan();
  const noRef = () => { const error = new Error('not found'); error.status = 404; throw error; };
  const contextName = head => 'dependabot-context-' + head + '-' + head + '-' + head;
  const jobNames = (runId, head) => runId === 11
    ? [contextName(head), 'Required CI', 'version-consistency', 'auto-format-guard', 'release-input-guard',
      'lint', 'python-tests', 'frontend-check', 'rust-check']
    : [contextName(head), 'Required Python matrix',
      ...['ubuntu-22.04', 'macos-15', 'windows-latest'].flatMap(os =>
        ['3.10', '3.11', '3.12', '3.13', '3.14'].map(v => 'python-tests (' + os + ', ' + v + ')'))];
  const github = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          const branch = ref.slice('heads/'.length);
          const sha = refs.get(branch);
          if (!sha) noRef();
          return { data: { ref: 'refs/heads/' + branch, object: { type: 'commit', sha } } };
        },
        getCommit: async ({ commit_sha }) => ({ data: commits.get(commit_sha) }),
        getTree: async ({ tree_sha }) => ({ data: { sha: tree_sha, truncated: false, tree: trees.get(tree_sha) } }),
      },
      repos: {
        getCommit: async ({ ref }) => {
          const value = commits.get(ref);
          return { data: { sha: ref, author: options.badBot ? { id: 1 } : bot,
            committer: webFlow, commit: { message: value.message, verification: { verified: true, reason: 'valid' } } } };
        },
        compareCommits: async ({ base, head }) => {
          const ancestor = base === head || base === oid('a') || base === oid('9') ||
            (base === oid('c') && head === oid('c'));
          return { data: { merge_base_commit: { sha: ancestor ? base : oid('a') },
            status: ancestor ? (base === head ? 'identical' : 'ahead') : 'diverged', behind_by: ancestor ? 0 : 1 } };
        },
      },
      pulls: {
        list: 'pulls.list',
        get: async ({ pull_number }) => {
          const pr = prs.find(item => item.number === pull_number);
          if (pr?.state === 'open') {
            pr.head.sha = refs.get(service);
            pr.base.sha = refs.get('Source_Code');
          }
          return { data: pr };
        },
      },
      actions: {
        listWorkflowRunsForRepo: async ({ head_sha }) => {
          const results = options.pending ? [] : [
            { id: 11, path: '.github/workflows/ci.yml', name: 'CI' },
            { id: 12, path: '.github/workflows/python-matrix.yml', name: 'Python matrix tests' },
          ].map(item => ({ ...item, run_attempt: 1, event: 'push', head_sha,
            head_branch: service, status: 'completed', conclusion: 'success',
            repository: { id: 1251103365 }, head_repository: { id: 1251103365 } }));
          return { data: { total_count: results.length, workflow_runs: results } };
        },
        listJobsForWorkflowRunAttempt: async ({ run_id }) => {
          const head = refs.get(service);
          const jobs = jobNames(run_id, head).map((name, index) => {
            const id = run_id * 100 + index;
            checks.set(id, { id, name, head_sha: options.badCheck ? oid('f') : head,
              app: { id: 15368 }, status: 'completed', conclusion: 'success',
              completed_at: completedAt });
            return { id, name, run_id, status: 'completed', conclusion: 'success',
              check_run_url: 'https://api.github.com/repos/' + full + '/check-runs/' + id };
          });
          return { data: { total_count: jobs.length, jobs } };
        },
      },
      checks: { get: async ({ check_run_id }) => ({ data: checks.get(check_run_id) }) },
    },
    paginate: async (method, params) => {
      if (method === 'pulls.list') return prs
        .filter(pr => params.state !== 'open' || pr.state === 'open')
        .filter(pr => !params.head || pr.head.ref === service)
        .map(pr => ({ ...pr }));
      throw new Error('Unexpected paginate method');
    },
  };
  const app = {
    request: async (route, values = {}) => {
      if (route === 'GET /apps/{app_slug}') return { data: { id: 5868451, slug: 'kingsley-multimedia-automation' } };
      if (route === 'GET /repos/{owner}/{repo}/rulesets/{ruleset_id}') return {
        data: { id: values.ruleset_id, target: 'branch', enforcement: 'active',
          current_user_can_bypass: options.bypass ? 'always' : 'never',
          rules: [{ type: 'non_fast_forward' }, { type: 'required_status_checks' }] },
      };
      throw new Error('Unexpected App request');
    },
    paginate: async () => {
      const common = { ruleset_id: 1, ruleset_source_type: 'Repository', ruleset_source: full };
      const result = [
        { ...common, type: 'non_fast_forward' },
        { ...common, type: 'required_status_checks', parameters: {
          strict_required_status_checks_policy: !options.looseChecks,
          required_status_checks: [{ context: 'Required CI', integration_id: 15368 },
            { context: 'Required Python matrix', integration_id: 15368 }],
        } },
      ];
      if (options.requirePr) result.push({ ...common, type: 'pull_request' });
      return result;
    },
    rest: {
      users: { getByUsername: async () => ({ data: bot }) },
      repos: { get: async () => ({ data: { id: 1251103365, node_id: 'R_repo', full_name: full, fork: false } }) },
      git: {
        createBlob: async ({ content }) => {
          const bytes = Buffer.from(content, 'base64');
          writes.push('blob');
          return { data: { sha: blob(bytes) } };
        },
        createTree: async ({ base_tree, tree }) => {
          writes.push('tree');
          const entries = new Map(trees.get(base_tree).map(item => [item.path, { ...item }]));
          for (const item of tree) entries.set(item.path, { ...item, size: formatted.length });
          const sha = oid(String(++state.treeCount + 1));
          trees.set(sha, [...entries.values()]);
          return { data: { sha } };
        },
        createCommit: async ({ message, tree, parents }) => {
          writes.push('commit');
          const sha = oid(state.commitCount++ === 0 ? 'c' : 'd');
          const commit = { sha, message, tree: { sha: tree }, parents: parents.map(value => ({ sha: value })),
            verification: { verified: true, reason: 'valid' } };
          commits.set(sha, commit);
          return { data: commit };
        },
        createRef: async ({ ref, sha }) => {
          writes.push('service-create');
          if (refs.has(service)) throw new Error('ref exists');
          refs.set(service, sha);
          return { data: { ref, object: { type: 'commit', sha } } };
        },
      },
      pulls: {
        create: async ({ head, base, title, body }) => {
          writes.push('pr');
          if (options.failCreateOnce) { options.failCreateOnce = false; throw new Error('network'); }
          const pr = { number: 200, state: 'open', merged_at: null, title, body, user: bot, draft: false,
            auto_merge: null, labels: [], head: { ref: head, sha: refs.get(head), repo: { full_name: full } },
            base: { ref: base, sha: refs.get(base), repo: { full_name: full } } };
          prs.push(pr);
          return { data: pr };
        },
      },
    },
    graphql: async (_query, { input }) => {
      const change = input.refUpdates[0];
      const branch = change.name.slice('refs/heads/'.length);
      if (options.conflictBeforeCas && branch === 'Source_Code') refs.set(branch, oid('e'));
      if (refs.get(branch) !== change.beforeOid || change.force !== false) throw new Error('CAS conflict');
      writes.push(branch === service ? 'service-cas' : 'source-cas');
      refs.set(branch, change.afterOid);
      return { updateRefs: { clientMutationId: input.clientMutationId } };
    },
  };
  const args = { github, app, context, appSlug: 'kingsley-multimedia-automation', workflowSha: oid('a'),
    artifactRoot: root, log: { warn() {} } };
  return { state, args, writePlan, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

// OpenAI-Codex_format_architecture: exercise only the merged-service cleanup race.
function cleanupTransition(options = {}) {
  const f = fixture(options);
  for (const name of ['one', 'two']) {
    const path = join(f.state.root, name, 'manifest.json');
    const plan = JSON.parse(readFileSync(path, 'utf8'));
    plan.files = [];
    plan.service = name === 'one' ? null : oid('a');
    writeFileSync(path, JSON.stringify(plan));
  }
  f.state.commits.get(oid('a')).message =
    'style: format changed Python files\n\nOpenAI-Codex_format_architecture\nFormat-Plan-SHA256: ' + '0'.repeat(64);
  f.state.prs.push({
    number: 88, state: 'closed', merged_at: '2026-11-22T06:05:25Z',
    merge_commit_sha: oid('a'), user: bot, body: '<!-- automation-format-cas-v1 -->',
    head: { ref: service, sha: oid('a'), repo: { full_name: full } },
    base: { ref: 'Source_Code', sha: oid('9'), repo: { full_name: full } },
  });
  return f;
}

test('merged cleanup race is a no-op without relying on branch rules', async () => {
  for (const author of [bot, { id: 157894869, login: 'KingsleyHK0323', type: 'User' },
    { id: 321, login: 'another-bot', type: 'Bot' }]) {
    for (const present of [false, true]) {
      const f = cleanupTransition({ requirePr: true, bypass: true, badBot: true });
      try {
        f.state.prs[0].user = author;
        f.state.prs[0].body = 'A merged same-repository service PR.';
        f.state.commits.get(oid('a')).message = 'Unsigned owner commit';
        if (present) f.state.refs.set(service, oid('a'));
        const result = await reconcileFormatter(f.args);
        assert.deepEqual(result, { status: 'idle-after-merged-cleanup', pr: 88, head: oid('a') });
        assert.deepEqual(f.state.writes, []);
      } finally { f.dispose(); }
    }
  }
});

test('a merged service ref moving after both snapshots is a no-op', async () => {
  for (const [planned, current] of [[oid('a'), null], [null, oid('a')]]) {
    const f = cleanupTransition({ requirePr: true, bypass: true });
    try {
      for (const name of ['one', 'two']) {
        const path = join(f.state.root, name, 'manifest.json');
        const plan = JSON.parse(readFileSync(path, 'utf8'));
        plan.service = planned;
        writeFileSync(path, JSON.stringify(plan));
      }
      if (current !== null) f.state.refs.set(service, current);
      const result = await reconcileFormatter(f.args);
      assert.deepEqual(result, { status: 'idle-after-merged-cleanup', pr: 88, head: oid('a') });
      assert.deepEqual(f.state.writes, []);
    } finally { f.dispose(); }
  }
});

test('a moved ref cannot hide work, warnings, history, or an unmerged PR', async () => {
  const mutations = [
    plan => { plan.files = [{ path: 'test.py', mode: '100644', source: blob(source),
      last_change: oid('a'), output: blob(formatted), sha256: hash(formatted), size: formatted.length }]; },
    plan => { plan.warning_count = 1; plan.warnings = [{ path: 'test.py', reason: 'unsafe-path' }]; },
    plan => { plan.limited = true; },
    plan => { plan.prior = [{ base: oid('a'), head: oid('b'), tree: oid('c'), digest: '0'.repeat(64) }]; },
  ];
  for (const mutate of mutations) {
    const f = cleanupTransition();
    try {
      for (const name of ['one', 'two']) {
        const path = join(f.state.root, name, 'manifest.json');
        const plan = JSON.parse(readFileSync(path, 'utf8'));
        plan.service = oid('a');
        mutate(plan);
        writeFileSync(path, JSON.stringify(plan));
      }
      await assert.rejects(reconcileFormatter(f.args), /service branch moved/);
      assert.deepEqual(f.state.writes, []);
    } finally { f.dispose(); }
  }
  const f = cleanupTransition();
  try {
    for (const name of ['one', 'two']) {
      const path = join(f.state.root, name, 'manifest.json');
      const plan = JSON.parse(readFileSync(path, 'utf8'));
      plan.service = oid('a');
      writeFileSync(path, JSON.stringify(plan));
    }
    f.state.prs[0].merged_at = null;
    await assert.rejects(reconcileFormatter(f.args));
    assert.deepEqual(f.state.writes, []);
  } finally { f.dispose(); }
});

test('merged cleanup race is rejected without exact merged PR identity', async () => {
  const mutations = [
    f => { f.state.prs[0].merged_at = null; },
    f => { f.state.prs[0].merge_commit_sha = oid('b'); },
    f => { f.state.prs[0].head.sha = oid('b'); },
    f => { f.state.prs[0].base.ref = 'other'; },
    f => { f.state.prs[0].head.repo.full_name = 'other/repo'; },
    f => { f.state.prs[0].base.repo.full_name = 'other/repo'; },
    f => { f.state.prs.push({ ...f.state.prs[0], number: 89, merged_at: null }); },
    f => { f.state.refs.set(service, oid('b')); },
    f => { f.state.prs.push({ ...f.state.prs[0], number: 89, state: 'open' }); },
  ];
  for (const mutate of mutations) {
    const f = cleanupTransition();
    try {
      mutate(f);
      await assert.rejects(reconcileFormatter(f.args));
      assert.deepEqual(f.state.writes, []);
    } finally { f.dispose(); }
  }
});

test('cleanup no-op rechecks source, service, and merged PR before returning', async () => {
  for (const changed of ['source', 'service', 'pr']) {
    const f = cleanupTransition();
    try {
      const getRef = f.args.github.rest.git.getRef;
      let sourceReads = 0, serviceReads = 0;
      f.args.github.rest.git.getRef = async args => {
        if (args.ref === 'heads/Source_Code' && ++sourceReads === 3 && changed === 'source') {
          f.state.refs.set('Source_Code', oid('b'));
        }
        if (args.ref === 'heads/' + service && ++serviceReads === 3 && changed === 'service') {
          f.state.refs.set(service, oid('b'));
        }
        return getRef(args);
      };
      const paginate = f.args.github.paginate;
      let inventories = 0;
      f.args.github.paginate = async (method, args) => {
        if (method === 'pulls.list' && ++inventories === 2 && changed === 'pr') {
          f.state.prs[0].merge_commit_sha = oid('b');
        }
        return paginate(method, args);
      };
      await assert.rejects(reconcileFormatter(f.args));
      assert.deepEqual(f.state.writes, []);
    } finally { f.dispose(); }
  }
});

test('cleanup snapshot cannot suppress work, warnings, limited batches, or history', async () => {
  const mutations = [
    plan => { plan.files = [{ path: 'test.py', mode: '100644', source: blob(source),
      last_change: oid('a'), output: blob(formatted), sha256: hash(formatted), size: formatted.length }]; },
    plan => { plan.warning_count = 1; plan.warnings = [{ path: 'test.py', reason: 'unsafe-path' }]; },
    plan => { plan.limited = true; },
    plan => { plan.prior = [{ base: oid('a'), head: oid('b'), tree: oid('c'), digest: '0'.repeat(64) }]; },
  ];
  for (const mutate of mutations) {
    const f = cleanupTransition();
    try {
      for (const name of ['one', 'two']) {
        const path = join(f.state.root, name, 'manifest.json');
        const plan = JSON.parse(readFileSync(path, 'utf8'));
        mutate(plan);
        writeFileSync(path, JSON.stringify(plan));
      }
      await assert.rejects(reconcileFormatter(f.args), /Independent formatting plans disagree/);
      assert.deepEqual(f.state.writes, []);
    } finally { f.dispose(); }
  }
});

test('other independent plan differences remain blocked', async () => {
  const mutations = [
    plan => { plan.service = oid('b'); },
    plan => { plan.anchor = oid('b'); },
    plan => { plan.files = [{ path: 'unexpected.py' }]; },
    plan => { plan.warning_count = 1; },
  ];
  for (const mutate of mutations) {
    const f = cleanupTransition();
    try {
      const path = join(f.state.root, 'two', 'manifest.json');
      const plan = JSON.parse(readFileSync(path, 'utf8'));
      mutate(plan);
      writeFileSync(path, JSON.stringify(plan));
      await assert.rejects(reconcileFormatter(f.args), /Independent formatting plans disagree/);
      assert.deepEqual(f.state.writes, []);
    } finally { f.dispose(); }
  }
});

test('creates a verified formatter PR without changing Source_Code', async () => {
  const f = fixture();
  try {
    const result = await reconcileFormatter(f.args);
    assert.equal(result.status, 'created');
    assert.equal(f.state.refs.get('Source_Code'), oid('a'));
    assert.equal(f.state.refs.get(service), oid('c'));
    assert.deepEqual(f.state.writes, ['blob', 'tree', 'commit', 'service-create', 'pr']);
  } finally { f.dispose(); }
});
test('only same-head successful push jobs permit exact Source_Code CAS', async () => {
  const f = fixture();
  try {
    await reconcileFormatter(f.args);
    f.writePlan();
    const result = await reconcileFormatter(f.args);
    assert.equal(result.status, 'updated-source');
    assert.equal(f.state.refs.get('Source_Code'), oid('c'));
    assert.deepEqual(f.state.writes.filter(value => value === 'source-cas'), ['source-cas']);
  } finally { f.dispose(); }
});
test('missing checks do not update the protected source branch', async () => {
  const f = fixture({ pending: true });
  try {
    await reconcileFormatter(f.args);
    f.writePlan();
    const result = await reconcileFormatter(f.args);
    assert.equal(result.status, 'waiting-for-checks');
    assert.equal(f.state.refs.get('Source_Code'), oid('a'));
  } finally { f.dispose(); }
});
test('checks for a different commit cannot authorize the CAS', async () => {
  const f = fixture({ badCheck: true });
  try {
    await reconcileFormatter(f.args);
    f.writePlan();
    await assert.rejects(reconcileFormatter(f.args), /not bound to the tested head/);
    assert.equal(f.state.refs.get('Source_Code'), oid('a'));
  } finally { f.dispose(); }
});
test('a missing rule, bypass, or PR-only policy stops all App writes', async () => {
  for (const options of [{ bypass: true }, { requirePr: true }]) {
    const f = fixture(options);
    try {
      await assert.rejects(reconcileFormatter(f.args), /bypassable|requires PR merges/);
      assert.deepEqual(f.state.writes, []);
    } finally { f.dispose(); }
  }
});
test('an existing human PR blocks the service branch', async () => {
  const f = fixture();
  try {
    f.state.refs.set(service, oid('a'));
    f.state.prs.push({ number: 80, state: 'open', user: { id: 1 }, body: '',
      head: { ref: service, sha: oid('a'), repo: { full_name: full } } });
    await assert.rejects(reconcileFormatter(f.args), /occupied by another PR/);
    assert.deepEqual(f.state.writes, []);
  } finally { f.dispose(); }
});
test('a verified orphan branch is recovered without replacing its commit', async () => {
  const f = fixture({ failCreateOnce: true });
  try {
    await assert.rejects(reconcileFormatter(f.args), /network/);
    f.writePlan();
    const result = await reconcileFormatter(f.args);
    assert.equal(result.status, 'recovered');
    assert.equal(f.state.refs.get(service), oid('c'));
    assert.equal(f.state.writes.filter(value => value === 'service-create').length, 1);
    assert.equal(f.state.writes.filter(value => value === 'commit').length, 1);
  } finally { f.dispose(); }
});
test('a closed formatter PR is not silently recreated', async () => {
  const f = fixture();
  try {
    await reconcileFormatter(f.args);
    f.state.prs[0].state = 'closed';
    f.writePlan();
    const count = f.state.writes.length;
    await assert.rejects(reconcileFormatter(f.args), /closed without merging/);
    assert.equal(f.state.writes.length, count);
  } finally { f.dispose(); }
});
test('a moved source uses a base-first two-parent service update', async () => {
  const f = fixture();
  try {
    await reconcileFormatter(f.args);
    const nextBase = oid('e');
    f.state.commits.set(nextBase, { sha: nextBase, tree: { sha: oid('1') }, parents: [{ sha: oid('a') }] });
    f.state.refs.set('Source_Code', nextBase);
    f.writePlan(nextBase);
    const result = await reconcileFormatter({ ...f.args, workflowSha: nextBase });
    assert.equal(result.status, 'updated');
    assert.deepEqual(f.state.commits.get(oid('d')).parents.map(item => item.sha), [nextBase, oid('c')]);
    assert.equal(f.state.refs.get('Source_Code'), nextBase);
    assert.equal(f.state.refs.get(service), oid('d'));
    f.writePlan(nextBase);
    const merged = await reconcileFormatter({ ...f.args, workflowSha: nextBase });
    assert.equal(merged.status, 'updated-source');
    assert.equal(f.state.refs.get('Source_Code'), oid('d'));
  } finally { f.dispose(); }
});
test('a changed source tip invalidates the old workflow and plan', async () => {
  const f = fixture();
  try {
    f.state.refs.set('Source_Code', oid('e'));
    await assert.rejects(reconcileFormatter(f.args), /moved since the trusted plan/);
    assert.deepEqual(f.state.writes, []);
  } finally { f.dispose(); }
});

test('missing historical recomputation proof blocks introducing old commits', async () => {
  const f = fixture();
  try {
    await reconcileFormatter(f.args);
    f.writePlan();
    for (const name of ['one', 'two']) {
      const path = join(f.state.root, name, 'manifest.json');
      const plan = JSON.parse(readFileSync(path, 'utf8'));
      plan.prior = [];
      writeFileSync(path, JSON.stringify(plan));
    }
    await assert.rejects(reconcileFormatter(f.args), /ancestry evidence is incomplete/);
    assert.equal(f.state.refs.get('Source_Code'), oid('a'));
  } finally { f.dispose(); }
});
test('a second open PR pointing at an introduced commit blocks the source update', async () => {
  const f = fixture();
  try {
    await reconcileFormatter(f.args);
    f.writePlan();
    f.state.prs.push({ number: 201, state: 'open', user: { id: 1 },
      head: { ref: 'other', sha: oid('c'), repo: { full_name: full } } });
    await assert.rejects(reconcileFormatter(f.args), /different open PR/);
    assert.equal(f.state.refs.get('Source_Code'), oid('a'));
  } finally { f.dispose(); }
});

test('disagreeing independent formatter artifacts never create a ref', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.state.root, 'two', 'blobs', hash(formatted)), 'modified payload');
    await assert.rejects(reconcileFormatter(f.args), /do not match independent plans/);
    assert.deepEqual(f.state.writes, []);
  } finally { f.dispose(); }
});
test('a concurrent source change makes the atomic source CAS fail', async () => {
  const f = fixture({ conflictBeforeCas: true });
  try {
    await reconcileFormatter(f.args);
    f.writePlan();
    await assert.rejects(reconcileFormatter(f.args), /CAS conflict/);
    assert.equal(f.state.refs.get('Source_Code'), oid('e'));
    assert.equal(f.state.writes.includes('source-cas'), false);
  } finally { f.dispose(); }
});

test('loose required-check policy still requires the exact base via CAS', async () => {
  const f = fixture({ looseChecks: true });
  try {
    await reconcileFormatter(f.args);
    f.writePlan();
    const result = await reconcileFormatter(f.args);
    assert.equal(result.status, 'updated-source');
    assert.equal(f.state.refs.get('Source_Code'), oid('c'));
  } finally { f.dispose(); }
});

test('accepts Python codepoint ordering for supplementary Unicode paths', () => {
  const f = fixture();
  try {
    for (const name of ['one', 'two']) {
      const path = join(f.state.root, name, 'manifest.json');
      const plan = JSON.parse(readFileSync(path, 'utf8'));
      const item = plan.files[0];
      plan.files = [{ ...item, path: '\ue000.py' }, { ...item, path: '😀.py' }];
      writeFileSync(path, JSON.stringify(plan));
    }
    const { plan } = readPlan(f.state.root);
    assert.deepEqual(plan.files.map(item => item.path), ['\ue000.py', '😀.py']);
  } finally { f.dispose(); }
});

test('an expired GitHub Actions check cannot authorize the source update', async () => {
  const f = fixture({ staleCheck: true });
  try {
    await reconcileFormatter(f.args);
    f.writePlan();
    await assert.rejects(reconcileFormatter(f.args), /check is not fresh/);
    assert.equal(f.state.refs.get('Source_Code'), oid('a'));
  } finally { f.dispose(); }
});
