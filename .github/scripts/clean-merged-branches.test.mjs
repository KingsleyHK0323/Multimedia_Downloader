// OpenAI-Codex_health_release_architecture: exercise real cleanup decisions with mock GitHub APIs.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = (await readFile(new URL('../workflows/clean-merged-branches.yml', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
const marker = '          script: |\n';
assert.equal(workflow.split(marker).length, 2);
const script = workflow.split(marker)[1].split('\n').map((line) => line.startsWith('            ') ? line.slice(12) : line).join('\n');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const fn = new AsyncFunction('context', 'github', 'core', 'require', script);
const owner = 'KingsleyHK0323';
const repo = 'Multimedia_Downloader';
const full = owner + '/' + repo;
const repoId = 1251103365;
const sha = 'a'.repeat(40);
const otherSha = 'b'.repeat(40);
const created = '2026-11-20T00:00:00Z';
const missing = () => Object.assign(new Error('not found'), { status: 404 });

function mergedPr(branch = 'feature', id = 12) {
  return { number: id, state: 'closed', created_at: created, merged: true,
    merged_at: '2026-11-21T00:00:00Z',
    head: { ref: branch, sha, repo: { id: repoId, full_name: full } },
    base: { ref: 'Source_Code', repo: { id: repoId, full_name: full } } };
}
function openPr(head = 'unrelated', base = 'Source_Code', id = 30, headRepo = full) {
  return { number: id, created_at: created, state: 'open',
    head: { ref: head, repo: headRepo === null ? null : { full_name: headRepo } },
    base: { ref: base, repo: { full_name: full } } };
}
function harness(options = {}) {
  const pr = options.pr || mergedPr();
  const state = { pr, prs: { [pr.number]: pr }, refs: { [pr.head.ref]: sha },
    open: [], deleted: [], reads: {}, warnings: [], event: 'pull_request_target',
    dryRun: 'true', ...options };
  const context = { eventName: state.event, ref: 'refs/heads/Source_Code',
    repo: { owner, repo }, payload: { repository: { id: repoId, full_name: full },
      pull_request: { number: pr.number, merged: pr.merged }, workflow_run: { id: 101 } } };
  const github = {
    graphql: async (query, vars) => {
      assert.match(query, /associatedPullRequests/);
      const branch = vars.qualifiedName.slice('refs/heads/'.length);
      if (state.badGraph) return { repository: null };
      return { repository: { nameWithOwner: full, ref: { name: branch, prefix: 'refs/heads/',
        target: { oid: state.refs[branch] }, associatedPullRequests: {
          totalCount: state.crossOpen ? 1 : 0,
          nodes: state.crossOpen ? [{ number: 99 }] : [],
          pageInfo: { hasNextPage: false },
        } } } };
    },
    rest: {
    pulls: {
      get: async ({ pull_number }) => {
        state.reads[pull_number] = (state.reads[pull_number] || 0) + 1;
        if (state.onPrRead) state.onPrRead(pull_number, state);
        return { data: state.prs[pull_number] };
      },
      list: async ({ state: kind, page, per_page, head, base }) => {
        if (kind === 'open' && state.badOpenResponse) return { data: null };
        state.queries ||= [];
        state.queries.push({ kind, page, per_page, head, base });
        let entries = kind === 'open' ? state.open : Object.values(state.prs)
          .filter((item) => item.state === 'closed')
          .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.number - b.number);
        if (head) entries = entries.filter((item) =>
          item.head.repo && item.head.repo.full_name.split('/')[0] + ':' + item.head.ref === head);
        if (base) entries = entries.filter((item) => item.base?.ref === base);
        return { data: entries.slice((page - 1) * per_page, page * per_page) };
      },
    },
    repos: { listBranches: async ({ page }) => ({ data: Object.entries(state.refs)
      .slice((page - 1) * 100, page * 100).map(([name, id]) => ({ name, commit: { sha: id } })) }) },
    git: { getRef: async ({ ref }) => {
      const branch = ref.slice('heads/'.length);
      if (!state.refs[branch]) throw missing();
      return { data: { ref: 'refs/' + ref, object: { type: 'commit', sha: state.refs[branch] } } };
    } },
    actions: { getWorkflowRun: async () => ({ data: state.run || {
      id: 101, status: 'completed', event: 'push', name: 'CI',
      repository: { id: repoId }, head_repository: { id: repoId },
      path: '.github/workflows/ci.yml', head_branch: 'Source_Code', head_sha: sha,
    } }) },
  } };
  const fakeRequire = (name) => {
    if (name === 'node:child_process') return { execFileSync: (command, args) => {
      assert.equal(command, 'git');
      if (args.includes('push')) {
        const lease = args.find((arg) => arg.startsWith('--force-with-lease=refs/heads/'));
        assert.ok(lease);
        const branch = lease.slice('--force-with-lease=refs/heads/'.length).split(':')[0];
        const expected = lease.slice(lease.lastIndexOf(':') + 1);
        assert.equal(state.refs[branch], expected);
        if (branch === state.failBranch) throw new Error('simulated lease conflict');
        state.deleted.push(branch);
        delete state.refs[branch];
      }
    } };
    if (name === 'node:fs') return { mkdtempSync: () => '/fake/git' };
    if (name === 'node:os') return { tmpdir: () => '/fake' };
    if (name === 'node:path') return { join: (...parts) => parts.join('/') };
    throw new Error('Unexpected dependency');
  };
  const core = { info() {}, warning(message) { state.warnings.push(message); } };
  process.env.CLEANUP_TOKEN = 'test-token';
  process.env.MANUAL_PR = String(pr.number);
  process.env.DRY_RUN = state.dryRun;
  return { state, context, invoke: () => fn(context, github, core, fakeRequire) };
}

test('deletes only an unchanged same-repo merged head', async () => {
  const h = harness(); await h.invoke(); assert.deepEqual(h.state.deleted, ['feature']);
  const moved = harness({ refs: { feature: otherSha } }); await moved.invoke(); assert.deepEqual(moved.state.deleted, []);
  const fork = mergedPr(); fork.head.repo.full_name = 'someone/fork'; fork.head.repo.id = 7;
  const external = harness({ pr: fork }); await external.invoke(); assert.deepEqual(external.state.deleted, []);
  const missingRepo = mergedPr(); missingRepo.head.repo = null;
  const noRepo = harness({ pr: missingRepo }); await noRepo.invoke(); assert.deepEqual(noRepo.state.deleted, []);
});

test('refuses missing or mismatched repository IDs', async () => {
  for (const mutate of [
    (pr) => { delete pr.head.repo.id; },
    (pr) => { delete pr.base.repo.id; },
  ]) {
    const pr = mergedPr(); mutate(pr);
    const h = harness({ pr });
    await assert.rejects(h.invoke(), /repository identifiers are incomplete/);
    assert.deepEqual(h.state.deleted, []);
  }
  for (const mutate of [
    (pr) => { pr.head.repo.id = 7; },
    (pr) => { pr.base.repo.id = 7; },
  ]) {
    const pr = mergedPr(); mutate(pr);
    const h = harness({ pr }); await h.invoke(); assert.deepEqual(h.state.deleted, []);
  }
});

test('always preserves both permanent branches and every open PR head or base', async () => {
  for (const branch of ['Source_Code', 'Multimedia_Downloader_Web_Preview']) {
    const h = harness({ pr: mergedPr(branch) }); await h.invoke(); assert.deepEqual(h.state.deleted, []);
  }
  for (const item of [openPr('feature'), openPr('other', 'feature')]) {
    const h = harness({ open: [item] }); await h.invoke(); assert.deepEqual(h.state.deleted, []);
  }
  const external = harness({ open: [openPr('feature', 'Source_Code', 30, 'someone/fork')] });
  await external.invoke(); assert.deepEqual(external.state.deleted, ['feature']);
  const sameOwner = harness({ open: [openPr('feature', 'Source_Code', 30, owner + '/another')] });
  await sameOwner.invoke(); assert.deepEqual(sameOwner.state.deleted, []);
});

test('manual dry run preserves eligible refs and rejects an unmerged PR', async () => {
  const dry = harness({ event: 'workflow_dispatch' }); await dry.invoke(); assert.deepEqual(dry.state.deleted, []);
  const live = harness({ event: 'workflow_dispatch', dryRun: 'false' }); await live.invoke();
  assert.deepEqual(live.state.deleted, ['feature']);
  const pr = mergedPr(); pr.merged = false; pr.merged_at = null;
  const unmerged = harness({ pr, event: 'workflow_dispatch', dryRun: 'false' });
  await assert.rejects(unmerged.invoke(), /not merged/);
});

test('re-reads a merged PR and preserves a branch that changed during the check', async () => {
  const h = harness({ onPrRead: (id, state) => {
    if (state.reads[id] === 2) state.prs[id] = { ...state.prs[id], head: { ...state.prs[id].head, sha: otherSha } };
  } });
  await h.invoke(); assert.deepEqual(h.state.deleted, []);
});

test('schedule sweeps merged refs and preserves closed unmerged refs', async () => {
  const one = mergedPr('one', 12); const two = mergedPr('two', 13);
  const unmerged = mergedPr('unmerged', 14); unmerged.merged = false; unmerged.merged_at = null;
  const h = harness({ event: 'schedule', prs: { 12: one, 13: two, 14: unmerged },
    refs: { one: sha, two: sha, unmerged: sha } });
  await h.invoke(); assert.deepEqual(h.state.deleted.sort(), ['one', 'two']);
});

test('trusted source and website push checks can wake reconciliation; unrelated runs cannot', async () => {
  const website = { id: 101, status: 'completed', event: 'push', name: 'Website build check',
    repository: { id: repoId }, head_repository: { id: repoId }, head_sha: sha,
    path: '.github/workflows/website.yml', head_branch: 'Multimedia_Downloader_Web_Preview' };
  for (const run of [undefined, website]) {
    const h = harness({ event: 'workflow_run', run });
    await h.invoke(); assert.deepEqual(h.state.deleted, ['feature']);
  }
  for (const run of [{ ...website, event: 'pull_request' },
    { ...website, head_repository: { id: 7 } }, { ...website, head_branch: 'Source_Code' }]) {
    const h = harness({ event: 'workflow_run', run });
    await h.invoke(); assert.deepEqual(h.state.deleted, []);
  }
});

test('continues safely when one scheduled lease fails and reports the failure', async () => {
  const one = mergedPr('one', 12); const two = mergedPr('two', 13);
  const h = harness({ event: 'schedule', prs: { 12: one, 13: two },
    refs: { one: sha, two: sha }, failBranch: 'one' });
  await assert.rejects(h.invoke(), /Some merged-branch cleanups failed/);
  assert.deepEqual(h.state.deleted, ['two']);
});

test('queries open head and base independently with exact branch filters', async () => {
  const many = Array.from({ length: 100 }, (_, i) => openPr('other-' + i, 'Source_Code', i + 1));
  many.push(openPr('feature', 'Source_Code', 101));
  const h = harness({ open: many }); await h.invoke(); assert.deepEqual(h.state.deleted, []);
  assert.ok(h.state.queries.some((q) => q.kind === 'open' && q.head === owner + ':feature' && q.per_page === 1));
  assert.ok(h.state.queries.some((q) => q.kind === 'open' && q.base === 'feature' && q.per_page === 1));
  const malformed = harness({ badOpenResponse: true });
  await assert.rejects(malformed.invoke(), /Targeted open PR search is incomplete/);
  const cross = harness({ crossOpen: true }); await cross.invoke(); assert.deepEqual(cross.state.deleted, []);
  const missingGraph = harness({ badGraph: true });
  await assert.rejects(missingGraph.invoke(), /Associated open PR inventory is incomplete/);
});

test('retains a branch when its targeted closed PR history exceeds the safe limit', async () => {
  const prs = {};
  for (let id = 1; id <= 500; id++) {
    const item = mergedPr('feature', id);
    item.merged = false;
    item.merged_at = null;
    prs[id] = item;
  }
  const h = harness({ event: 'schedule', prs, refs: { feature: sha } });
  await assert.rejects(h.invoke(), /exceeded safe limits/);
  assert.deepEqual(h.state.deleted, []);
});

test('keeps the cleanup concurrency queue valid without cancelling pending work', () => {
  assert.match(workflow, /^concurrency:\n  group: cleanup-merged-branches\n  queue: max$/m);
  assert.equal((workflow.match(/^\s+queue\s*:/gm) || []).length, 1);
  assert.doesNotMatch(workflow, /^\s+cancel-in-progress\s*:/m);
});

// OpenAI-Codex: exercise Git's server-side lease against an isolated bare fixture.
test('atomic lease preserves an advanced branch and deletes the unchanged head', async () => {
  const { execFileSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-lease-test-'));
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  const git = (args, options = {}) => execFileSync('git', args, { encoding: 'utf8', stdio: 'pipe', ...options }).trim();
  git(['init', '--bare', remote]);
  git(['init', work]);
  git(['-C', work, 'config', 'user.name', 'Cleanup Test']);
  git(['-C', work, 'config', 'user.email', 'cleanup@example.invalid']);
  git(['-C', work, 'checkout', '-b', 'lease-test']);
  git(['-C', work, 'commit', '--allow-empty', '-m', 'initial']);
  const old = git(['-C', work, 'rev-parse', 'HEAD']);
  git(['-C', work, 'push', remote, 'HEAD:refs/heads/lease-test']);
  git(['-C', work, 'commit', '--allow-empty', '-m', 'advance']);
  const current = git(['-C', work, 'rev-parse', 'HEAD']);
  git(['-C', work, 'push', remote, 'HEAD:refs/heads/lease-test']);
  const deletion = expected => ['-C', work, 'push', `--force-with-lease=refs/heads/lease-test:${expected}`, remote, ':refs/heads/lease-test'];
  assert.throws(() => git(deletion(old)));
  assert.equal(git(['--git-dir', remote, 'rev-parse', 'refs/heads/lease-test']), current);
  git(deletion(current));
  assert.throws(() => git(['--git-dir', remote, 'rev-parse', '--verify', 'refs/heads/lease-test']));
});
