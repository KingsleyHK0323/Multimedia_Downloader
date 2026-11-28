// OpenAI-Codex_health_release_architecture: exercise App version PR reconciliation with in-memory GitHub APIs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { reconcileVersionPr } from './auto-patch-pr-writer.mjs';
import { VERSION_PATHS } from './patch-release-policy.mjs';
import { ANCHOR_PATH, ANCHOR_CONTENT } from './patch-source-authorization.mjs';

const owner = 'KingsleyHK0323', repo = 'Multimedia_Downloader';
const fullName = owner + '/' + repo;
const fixedSha = value => value.repeat(40);
const blobHash = text => {
  const bytes = Buffer.from(text);
  return createHash('sha1').update(Buffer.concat([Buffer.from('blob ' + bytes.length + '\0'), bytes])).digest('hex');
};
function files(version = '4.3.22') {
  const manifest = JSON.stringify({ name: 'test', version }, null, 2) + '\n';
  const lock = JSON.stringify({ name: 'test', version, packages: { '': { version } } }, null, 2) + '\n';
  return {
    'package.json': manifest, 'package-lock.json': lock,
    'frontend/package.json': manifest, 'frontend/package-lock.json': lock,
    'src-tauri/tauri.conf.json': manifest,
    'src-tauri/Cargo.toml': '[package]\nversion = "' + version + '"\n',
    'src-tauri/Cargo.lock': '[[package]]\nname = "multimedia-downloader"\nversion = "' + version + '"\n',
    'README.md': '# Multimedia Downloader — V' + version + '\n',
    'CHANGELOG.md': '### Unreleased\n\n#### Fixed\n- Correct release handling.\n\n### [4.3.22] — 2026-11-18\n',
    'engine/__init__.py': '__version__ = "' + version + '"\n',
    '.github/workflows/release.yml': 'name: Trusted release workflow\n',
    '.github/workflows/release-build.yml': 'name: Trusted release build\n',
    '.github/workflows/npm-package.yml': 'name: Trusted package workflow\n',
    '.github/scripts/verify-tag-protection.mjs': 'trusted tag helper\n',
    '.github/scripts/upload-release-assets.mjs': 'trusted asset helper\n',
    '.github/scripts/select-release-artifacts.mjs': 'trusted selector\n',
    '.github/scripts/download-release-artifacts.py': 'trusted downloader\n',
    '.github/scripts/stage-release-artifacts.py': 'trusted staging\n',
    '.github/scripts/verify-version-at-commit.mjs': 'trusted version guard\n',
    '.github/scripts/verify-release-assets.mjs': 'trusted inventory guard\n',
    '.github/scripts/release-commit-notes.mjs': 'trusted notes\n',
    [ANCHOR_PATH]: ANCHOR_CONTENT,
  };
}
function safeRule() {
  return { id: 27823531, source: fullName, source_type: 'Repository', target: 'tag',
    enforcement: 'active', current_user_can_bypass: 'never', bypass_actors: [],
    conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } },
    rules: [{ type: 'update' }, { type: 'deletion' }, { type: 'non_fast_forward' }] };
}
function setup(options = {}) {
  const source = { number: 42, state: 'closed', merged: true, merged_at: '2026-11-22T07:00:00Z',
    merge_commit_sha: fixedSha('b'), labels: [{ name: 'release:patch', node_id: 'LA_kwDOSpJShc8AAAADEWCHJg' }],
    user: { id: 157894869, login: owner, type: 'User' },
    base: { ref: 'Source_Code', sha: fixedSha('a'), repo: { id: 1251103365, full_name: fullName } } };
  if (options.sourceBeforeAnchor) source.merged_at = '2026-11-22T06:45:00Z';
  const anchor = { number: 73, state: 'closed', merged: true, merged_at: '2026-11-22T06:50:00Z',
    merge_commit_sha: fixedSha('9'), labels: [], user: { id: 157894869 },
    base: { ref: 'Source_Code', repo: { id: 1251103365, full_name: fullName } },
    head: { ref: 'automation/protected-workflows', repo: { id: 1251103365, full_name: fullName } } };
  const state = { source, prs: [source, anchor], refs: new Map([['Source_Code', fixedSha('a')]]),
    commits: new Map(), trees: new Map(), blobs: new Map(), tags: new Map(), releaseRuns: [], release: null, writes: [], commitCounter: 0, treeCounter: 0 };
  const baseFiles = files();
  function createTreeSnapshot(data) {
    return Object.entries(data).map(([path, content]) => {
      const sha = blobHash(content);
      state.blobs.set(sha, content);
      return { path, type: 'blob', mode: '100644', sha, size: Buffer.byteLength(content) };
    });
  }
  state.trees.set(fixedSha('1'), createTreeSnapshot(baseFiles));
  state.commits.set(fixedSha('a'), { sha: fixedSha('a'), tree: { sha: fixedSha('1') },
    parents: [{ sha: fixedSha('b') }], message: 'Source base' });
  state.commits.set(fixedSha('b'), { sha: fixedSha('b'), tree: { sha: fixedSha('1') },
    parents: [{ sha: fixedSha('9') }], message: 'Merged source PR' });
  state.commits.set(fixedSha('9'), { sha: fixedSha('9'), tree: { sha: fixedSha('1') },
    parents: [], message: 'Migration anchor' });
  const noRef = () => { const error = new Error('not found'); error.status = 404; throw error; };
  const labelActor = options.labelByBot
    ? { id: 41898282, node_id: 'MDM6Qm90NDE4OTgyODI=', type: 'Bot' }
    : { id: 157894869, node_id: 'U_kgDOCWlI1Q', type: 'User' };
  const eventTime = () => options.sameSecond ? state.source.merged_at
    : options.lateLabel ? '2026-11-22T07:00:01Z' : '2026-11-22T06:59:00Z';
  const github = {
    graphql: async (_query, { ids }) => ({
      nodes: ids.map(id => {
        assert.equal(id, 'label-event-' + state.source.number);
        return { __typename: 'LabeledEvent', id, createdAt: eventTime(),
          actor: { __typename: labelActor.type, id: labelActor.node_id,
            ...(labelActor.type === 'User' ? { databaseId: labelActor.id } : {}) },
          label: { id: 'LA_kwDOSpJShc8AAAADEWCHJg', name: 'release:patch',
            createdAt: '2026-11-22T06:44:42Z',
            updatedAt: options.labelUpdated ?? '2026-11-22T06:44:42Z',
            repository: { databaseId: 1251103365 } },
          labelable: { __typename: 'PullRequest', number: state.source.number,
            repository: { databaseId: 1251103365 } },
        };
      }),
    }),
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (ref.startsWith('tags/')) {
            const tag = ref.slice('tags/'.length), sha = state.tags.get(tag);
            if (!sha) noRef();
            return { data: { ref: 'refs/tags/' + tag, object: { type: 'commit', sha } } };
          }
          const branch = ref.slice('heads/'.length), sha = state.refs.get(branch);
          if (!sha) noRef();
          return { data: { ref: 'refs/heads/' + branch, object: { type: 'commit', sha } } };
        },
        getCommit: async ({ commit_sha }) => ({ data: state.commits.get(commit_sha) }),
        getTree: async ({ tree_sha }) => ({ data: { sha: tree_sha, truncated: false, tree: state.trees.get(tree_sha) } }),
        getBlob: async ({ file_sha }) => {
          const bytes = Buffer.from(state.blobs.get(file_sha));
          return { data: { sha: file_sha, encoding: 'base64', size: bytes.length, content: bytes.toString('base64') } };
        },
      },
      pulls: {
        list: 'pulls.list',
        get: async ({ pull_number }) => {
          const pr = state.prs.find(item => item.number === pull_number);
          if (pr?.head?.ref) pr.head.sha = state.refs.get(pr.head.ref) || pr.head.sha;
          return { data: pr };
        },
      },
      repos: {
        getCommit: async ({ ref }) => ({ data: { sha: ref,
          author: options.legacyAuthor && ref === fixedSha('a')
            ? { id: 41898282, login: 'github-actions[bot]', type: 'Bot' }
            : options.forgedCommit ? { id: 157894869, login: owner, type: 'User' }
              : { id: 359694872, login: 'kingsley-multimedia-automation[bot]', type: 'Bot' },
          committer: options.forgedSigner ? { id: 157894869, login: owner, type: 'User' }
            : { id: 19864447, login: 'web-flow', type: 'User' },
          commit: { verification: { verified: options.invalidSignature ? false : true, reason: 'valid' } } } }),
        listPullRequestsAssociatedWithCommit: 'repos.commitPulls',
        listReleaseAssets: 'repos.releaseAssets',
        getReleaseByTag: async () => {
          if (!state.release) noRef();
          return { data: state.release };
        },
        listCommits: 'repos.listCommits',
        compareCommits: async ({ base }) => ({ data: { merge_base_commit: { sha: options.badAncestry && base === fixedSha('b') ? fixedSha('f') : base },
          status: 'ahead', behind_by: 0 } }),
      },
      issues: { listEventsForTimeline: 'issues.timeline' },
      actions: {
        listWorkflowRunsForRepo: async ({ head_sha, event }) => {
          if (event === 'workflow_dispatch') {
            return { data: { total_count: state.releaseRuns.length, workflow_runs: state.releaseRuns } };
          }
          if (options.pendingChecks) return { data: { total_count: 0, workflow_runs: [] } };
          const branch = 'automation/protected-workflows';
          const workflow_runs = [
            { id: 11, name: 'CI', path: '.github/workflows/ci.yml' },
            { id: 12, name: 'Python matrix tests', path: '.github/workflows/python-matrix.yml' },
          ].map(item => ({ ...item, run_attempt: 1, event: 'pull_request', head_sha,
            head_branch: branch, status: 'completed', conclusion: 'success',
            repository: { full_name: fullName }, head_repository: { full_name: fullName } }));
          return { data: { total_count: workflow_runs.length, workflow_runs } };
        },
        listJobsForWorkflowRunAttempt: async ({ run_id }) => {
          if (run_id === 99) {
            const names = ['release-context-v4.3.23-' + fixedSha('7'), 'publisher', 'publish-stable'];
            const jobs = names.map(name => ({ name, run_id, status: 'completed', conclusion: 'success' }));
            return { data: { total_count: jobs.length, jobs } };
          }
          const pr = state.prs.find(item => item.number === 200);
          const head = pr.head.sha, base = pr.base.sha, merge = fixedSha('f');
          const context = 'dependabot-context-' + base + '-' + head + '-' + merge;
          const names = run_id === 11
            ? [context, 'Required CI', 'version-consistency', 'auto-format-guard', 'release-input-guard',
              'lint', 'python-tests', 'frontend-check', 'rust-check']
            : [context, 'Required Python matrix'];
          if (run_id === 12) {
            for (const os of ['ubuntu-22.04', 'macos-15', 'windows-latest']) {
              for (const version of ['3.10', '3.11', '3.12', '3.13', '3.14']) {
                names.push('python-tests (' + os + ', ' + version + ')');
              }
            }
          }
          const jobs = names.map(name => ({ name, run_id, status: 'completed', conclusion: 'success' }));
          return { data: { total_count: jobs.length, jobs } };
        },
      },
    },
    paginate: async (method, parameters = {}) => {
      if (method === 'pulls.list') {
        if (parameters.state !== 'open') return state.prs;
        return state.prs.filter(pr => pr.state === 'open' &&
          (!parameters.head || parameters.head === owner + ':' + pr.head?.ref) &&
          (!parameters.base || parameters.base === pr.base?.ref));
      }
      if (method === 'repos.commitPulls') return state.prs.filter(pr => pr.number === 200 && pr.merged === true);
      if (method === 'repos.releaseAssets') {
        return [
          'Multimedia.Downloader-4.3.23-1.x86_64.rpm', 'Multimedia.Downloader_4.3.23_amd64.AppImage',
          'Multimedia.Downloader_4.3.23_amd64.deb', 'Multimedia.Downloader_4.3.23_aarch64.dmg',
          'Multimedia.Downloader_4.3.23_x64-setup.exe', 'Multimedia.Downloader_4.3.23_x64_en-US.msi',
        ].map(name => ({ name, size: 1, digest: 'sha256:' + 'c'.repeat(64), state: 'uploaded' }));
      }
      if (method === 'issues.timeline') {
        const time = state.source.merged_at;
        let labelTime = '2026-11-22T06:59:00Z';
        if (options.lateLabel) labelTime = '2026-11-22T07:00:01Z';
        if (options.sameSecond) labelTime = time;
        return [
          { event: 'labeled', node_id: 'label-event-' + state.source.number, actor: labelActor, created_at: labelTime, label: { name: 'release:patch' } },
          { event: 'merged', created_at: time, commit_id: state.source.merge_commit_sha },
        ];
      }
      return [{ sha: state.refs.get('Source_Code'), commit: { message: state.commits.get(state.refs.get('Source_Code')).message } }];
    },
  };
  const app = {
    request: async (route, parameters = {}) => {
      if (route === 'GET /apps/{app_slug}') return { data: { id: 5868451, slug: 'kingsley-multimedia-automation' } };
      if (route === 'GET /repos/{owner}/{repo}/rulesets/{ruleset_id}') {
        const id = parameters.ruleset_id;
        if (id === 1) return { data: { id: 1, target: 'branch', enforcement: 'active',
          current_user_can_bypass: 'never', rules: [{ type: 'pull_request' }, { type: 'required_status_checks' }] } };
        if (id === 2) return { data: { id: 2, target: 'branch', enforcement: 'active', source_type: 'Repository',
          source: fullName, current_user_can_bypass: 'never', rules: [{ type: 'update' }],
          conditions: { ref_name: { include: ['refs/heads/Multimedia_Downloader_Website'], exclude: [] } } } };
        const rule = safeRule();
        if (options.hideBypass) delete rule.bypass_actors;
        if (options.hideCurrentBypass) delete rule.current_user_can_bypass;
        return { data: rule };
      }
      throw new Error('Unexpected request');
    },
    paginate: async (_route, { branch }) => {
      const common = { ruleset_source_type: 'Repository', ruleset_source: fullName };
      if (branch === 'Source_Code') return [
        { ...common, ruleset_id: 1, type: 'pull_request' },
        { ...common, ruleset_id: 1, type: 'required_status_checks', parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: [{ context: 'Required CI', integration_id: 15368 },
            { context: 'Required Python matrix', integration_id: 15368 }],
        } },
      ];
      if (branch === 'Multimedia_Downloader_Website') {
        return [{ ...common, ruleset_id: 2, type: 'update' }];
      }
      throw new Error('Unexpected branch rules');
    },
    rest: {
      users: { getByUsername: async () => ({ data: { id: 359694872, login: 'kingsley-multimedia-automation[bot]', type: 'Bot' } }) },
      repos: { get: async () => ({ data: { id: 1251103365, node_id: 'R_repo', full_name: fullName, fork: false } }) },
      git: {
        createTree: async ({ base_tree, tree }) => {
          state.writes.push('tree');
          const byPath = new Map(state.trees.get(base_tree).map(item => [item.path, { ...item }]));
          for (const item of tree) {
            const sha = blobHash(item.content);
            state.blobs.set(sha, item.content);
            byPath.set(item.path, { path: item.path, type: item.type, mode: item.mode,
              sha, size: Buffer.byteLength(item.content) });
          }
          if (options.foreignFile) byPath.set('unrelated.txt', {
            path: 'unrelated.txt', type: 'blob', mode: '100644', sha: fixedSha('9'), size: 1,
          });
          const sha = String(++state.treeCounter + 1).repeat(40);
          state.trees.set(sha, [...byPath.values()]);
          return { data: { sha } };
        },
        createCommit: async ({ message, tree, parents }) => {
          state.writes.push('commit');
          const sha = (state.commitCounter++ === 0 ? 'c' : 'd').repeat(40);
          const commit = { sha, message, tree: { sha: tree }, parents: parents.map(value => ({ sha: value })) };
          state.commits.set(sha, commit);
          return { data: commit };
        },
        createRef: async ({ ref, sha }) => {
          if (ref.startsWith('refs/tags/')) {
            state.writes.push('tag');
            const tag = ref.slice('refs/tags/'.length);
            if (state.tags.has(tag)) throw new Error('tag exists');
            state.tags.set(tag, sha);
            return { data: { ref, object: { sha } } };
          }
          state.writes.push('ref');
          const branch = ref.slice('refs/heads/'.length);
          if (state.refs.has(branch)) throw new Error('ref exists');
          state.refs.set(branch, sha);
          return { data: { ref, object: { sha } } };
        },
      },
      pulls: {
        merge: async ({ pull_number, sha, commit_title, commit_message }) => {
          state.writes.push('merge');
          const pr = state.prs.find(item => item.number === pull_number);
          assert.equal(pr.head.sha, sha);
          const mergeSha = fixedSha('7');
          const source = state.commits.get(sha);
          state.commits.set(mergeSha, { sha: mergeSha, tree: source.tree,
            parents: [{ sha: pr.base.sha }], message: commit_title + '\n\n' + commit_message });
          state.refs.set('Source_Code', mergeSha);
          pr.state = 'closed';
          pr.merged = true;
          pr.merged_by = { id: 359694872 };
          pr.merge_commit_sha = mergeSha;
          return { data: { merged: true, sha: mergeSha } };
        },
        create: async ({ base, head, body, title }) => {
          state.writes.push('pr');
          if (options.failCreateOnce) { options.failCreateOnce = false; throw new Error('network'); }
          const pr = { number: 200, state: 'open', body, title, draft: false, auto_merge: null, labels: [],
            user: { id: 359694872, login: 'kingsley-multimedia-automation[bot]', type: 'Bot' },
            base: { ref: base, sha: state.refs.get(base), repo: { id: 1251103365, full_name: fullName } },
            head: { ref: head, sha: state.refs.get(head), repo: { id: 1251103365, full_name: fullName } } };
          state.prs.push(pr);
          return { data: pr };
        },
      },
    },
    graphql: async (_query, { input }) => {
      state.writes.push('cas');
      const change = input.refUpdates[0], branch = change.name.slice('refs/heads/'.length);
      assert.equal(state.refs.get(branch), change.beforeOid);
      assert.equal(change.force, false);
      state.refs.set(branch, change.afterOid);
      return { updateRefs: { clientMutationId: input.clientMutationId } };
    },
  };
  const args = { github, app, context: { repo: { owner, repo }, ref: 'refs/heads/Source_Code' },
    appSlug: 'kingsley-multimedia-automation', workflowSha: fixedSha('a'), anchorPrNumber: 73, now: new Date('2026-11-22T09:00:00Z') };
  return { state, args };
}
test('creates a single deterministic App PR with exactly the version file set', async () => {
  const { state, args } = setup();
  const result = await reconcileVersionPr(args);
  assert.equal(result.status, 'created');
  assert.equal(result.pr, 200);
  assert.equal(state.refs.get('automation/protected-workflows'), result.head);
  assert.deepEqual(state.writes, ['tree', 'commit', 'ref', 'pr']);
  const tree = state.trees.get(state.commits.get(result.head).tree.sha);
  assert.deepEqual(tree.filter(item => VERSION_PATHS.includes(item.path)).map(item => item.path).sort(), [...VERSION_PATHS].sort());
  assert.match(state.prs.at(-1).body, /automatic-patch-source:42:/);
});
test('unverified acting-principal protection stops before any version write', async () => {
  const { state, args } = setup({ hideCurrentBypass: true });
  await assert.rejects(reconcileVersionPr(args), /Cannot prove/);
  assert.deepEqual(state.writes, []);
});
test('source PR not in Source_Code history stops before any write', async () => {
  const { state, args } = setup({ badAncestry: true });
  await assert.rejects(reconcileVersionPr(args), /not in the current Source_Code history/);
  assert.deepEqual(state.writes, []);
});
test('extra tree paths are rejected before a ref or PR is created', async () => {
  const { state, args } = setup({ foreignFile: true });
  await assert.rejects(reconcileVersionPr(args), /path inventory/);
  assert.deepEqual(state.writes, ['tree']);
});
test('an orphan branch is verified and recovered without replacing it', async () => {
  const { state, args } = setup({ failCreateOnce: true });
  await assert.rejects(reconcileVersionPr(args), /network/);
  assert.equal(state.writes.filter(item => item === 'ref').length, 1);
  const result = await reconcileVersionPr(args);
  assert.equal(result.status, 'created');
  assert.equal(state.writes.filter(item => item === 'ref').length, 1);
});
test('a manually closed version PR is not reopened', async () => {
  const { state, args } = setup();
  await reconcileVersionPr(args);
  state.prs.at(-1).state = 'closed';
  const count = state.writes.length;
  await assert.rejects(reconcileVersionPr(args), /Version PR #200 was closed/);
  assert.equal(state.writes.length, count);
});

test('base advancement preserves the stale branch and performs no update', async () => {
  const { state, args } = setup();
  const first = await reconcileVersionPr(args);
  const nextBase = fixedSha('e'), nextTree = fixedSha('8');
  state.trees.set(nextTree, state.trees.get(fixedSha('1')).map(item => ({ ...item })));
  state.commits.set(nextBase, { sha: nextBase, tree: { sha: nextTree },
    parents: [{ sha: fixedSha('a') }], message: 'Unrelated change' });
  state.refs.set('Source_Code', nextBase);
  const count = state.writes.length;
  await assert.rejects(reconcileVersionPr({ ...args, workflowSha: nextBase }), /stale/);
  assert.equal(state.refs.get('automation/protected-workflows'), first.head);
  assert.equal(state.writes.length, count);
});

test('hidden bypass-actor list is reported without claiming it is empty', async () => {
  const { state, args } = setup({ hideBypass: true });
  const result = await reconcileVersionPr(args);
  assert.equal(result.status, 'created');
  assert.equal(state.refs.get('automation/protected-workflows'), result.head);
});

test('manual request validates the PR number and does not select another source', async () => {
  const { state, args } = setup();
  await assert.rejects(reconcileVersionPr({ ...args, requestedSource: 0 }), /Invalid requested source/);
  await assert.rejects(reconcileVersionPr({ ...args, requestedSource: 43 }), /not eligible/);
  assert.deepEqual(state.writes, []);
});

test('only a patch label already active before merge authorizes PR creation', async () => {
  const early = setup({ sourceBeforeAnchor: true });
  assert.equal((await reconcileVersionPr(early.args)).status, 'idle');
  assert.deepEqual(early.state.writes, []);
  const late = setup({ lateLabel: true });
  assert.equal((await reconcileVersionPr(late.args)).status, 'idle');
  assert.deepEqual(late.state.writes, []);
  await assert.rejects(reconcileVersionPr({ ...late.args, requestedSource: 42 }), /authorization/);
  assert.deepEqual(late.state.writes, []);
  const { state, args } = setup({ sameSecond: true });
  await assert.rejects(reconcileVersionPr(args), /same second/);
  assert.deepEqual(state.writes, []);
});


test('bot or renamed label cannot start an automatic version change', async () => {
  for (const options of [{ labelByBot: true }, { labelUpdated: '2026-11-22T07:01:00Z' }]) {
    const { state, args } = setup(options);
    await assert.rejects(reconcileVersionPr(args));
    assert.deepEqual(state.writes, []);
  }
});


test('an unmerged version PR remains untouched when the owner withdraws its source label', async () => {
  const { state, args } = setup();
  const created = await reconcileVersionPr(args);
  const before = [...state.writes];
  state.source.labels = [];
  await assert.rejects(reconcileVersionPr(args), /open version PR.*preserve/i);
  assert.deepEqual(state.writes, before);
  assert.equal(state.prs.find(pr => pr.number === created.pr).state, 'open');
  assert.equal(state.refs.get('automation/protected-workflows'), created.head);
});


test('a source label withdrawn before branch creation leaves no service ref or PR', async () => {
  const { state, args } = setup();
  const read = args.github.rest.pulls.get;
  let reads = 0;
  args.github.rest.pulls.get = async parameters => {
    if (parameters.pull_number === 42 && ++reads === 2) state.source.labels = [];
    return read(parameters);
  };
  await assert.rejects(reconcileVersionPr(args));
  assert.deepEqual(state.writes, ['tree', 'commit']);
  assert.equal(state.refs.has('automation/protected-workflows'), false);
  assert.equal(state.prs.some(pr => pr.number === 200), false);
});

test('forged or unsigned version commits never create a branch or PR', async () => {
  for (const options of [{ forgedCommit: true }, { invalidSignature: true }, { forgedSigner: true }]) {
    const { state, args } = setup(options);
    await assert.rejects(reconcileVersionPr(args), /verified automation App commit/);
    assert.deepEqual(state.writes, ['tree', 'commit']);
  }
});

test('native auto-merge enabled on a version PR is rejected', async () => {
  const { state, args } = setup();
  const created = await reconcileVersionPr(args);
  const pr = state.prs.find(item => item.number === 200);
  pr.auto_merge = { enabled_by: { id: 157894869 } };
  const count = state.writes.length;
  await assert.rejects(reconcileVersionPr(args), /expected App-authored/);
  assert.equal(state.writes.length, count);
  assert.equal(state.refs.get('automation/protected-workflows'), created.head);
});

test('migration marker and current workflow tip are mandatory before any write', async () => {
  const missing = setup();
  const marker = missing.state.trees.get(fixedSha('1')).find(item => item.path === ANCHOR_PATH);
  marker.sha = fixedSha('f');
  await assert.rejects(reconcileVersionPr(missing.args), /immutable opt-in marker/);
  assert.deepEqual(missing.state.writes, []);
  const stale = setup();
  await assert.rejects(reconcileVersionPr({ ...stale.args, workflowSha: fixedSha('f') }), /not the current Source_Code tip/);
  assert.deepEqual(stale.state.writes, []);
});

test('release-like messages on a non-first parent do not block eligible sources', async () => {
  const { state, args } = setup();
  state.commits.set(fixedSha('f'), { sha: fixedSha('f'), tree: { sha: fixedSha('1') },
    parents: [{ sha: fixedSha('9') }],
    message: 'chore: release v4.3.99 after PR #42\n\nAutomatic patch release for merged PR #42' });
  state.commits.get(fixedSha('a')).parents.push({ sha: fixedSha('f') });
  const result = await reconcileVersionPr(args);
  assert.equal(result.status, 'created');
});

test('a legacy tag alone cannot silently complete a source PR during migration', async () => {
  const { state, args } = setup({ legacyAuthor: true });
  state.commits.get(fixedSha('a')).message =
    'chore: release v4.3.23 after PR #42\n\nAutomatic patch release for merged PR #42';
  state.tags.set('v4.3.23', fixedSha('a'));
  await assert.rejects(reconcileVersionPr(args), /no verified migration record/);
  assert.deepEqual(state.writes, []);
});

test('another open PR using the service branch prevents branch creation', async () => {
  const { state, args } = setup();
  state.prs.push({ number: 210, state: 'open', user: { id: 157894869 },
    head: { ref: 'automation/protected-workflows', repo: { id: 1251103365, full_name: fullName } },
    base: { ref: 'Source_Code', repo: { id: 1251103365, full_name: fullName } } });
  await assert.rejects(reconcileVersionPr(args), /already in use|unrelated|ambiguous/);
  assert.deepEqual(state.writes, []);
});

test('an unrelated existing service ref is never overwritten', async () => {
  const { state, args } = setup();
  state.refs.set('automation/protected-workflows', fixedSha('a'));
  await assert.rejects(reconcileVersionPr(args), /not the expected|provenance/);
  assert.equal(state.refs.get('automation/protected-workflows'), fixedSha('a'));
  assert.deepEqual(state.writes, []);
});

test('continues only after the corresponding release has independently been verified', async () => {
  const { state, args } = setup();
  const created = await reconcileVersionPr(args);
  const pr = state.prs.find(item => item.number === created.pr);
  pr.state = 'closed'; pr.merged = true; pr.merged_at = '2026-11-22T09:01:00Z';
  pr.merge_commit_sha = created.head;
  state.refs.set('Source_Code', created.head);
  state.tags.set('v4.3.23', created.head);
  const count = state.writes.length;
  await assert.rejects(reconcileVersionPr({ ...args, workflowSha: created.head }), /pending release/);
  const result = await reconcileVersionPr({ ...args, workflowSha: created.head, verifiedCompleted: [42] });
  assert.equal(result.status, 'idle');
  assert.equal(state.writes.length, count);
});

test('rejects forged or malformed verified release sets', async () => {
  const { state, args } = setup();
  await assert.rejects(reconcileVersionPr({ ...args, verifiedCompleted: [42, 42] }), /set is invalid/);
  await assert.rejects(reconcileVersionPr({ ...args, verifiedCompleted: [999] }), /does not match/);
  assert.deepEqual(state.writes, []);
});
