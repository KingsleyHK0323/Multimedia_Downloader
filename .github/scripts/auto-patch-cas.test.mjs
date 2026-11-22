// OpenAI-Codex_health_release_architecture: exercise App version PR reconciliation with in-memory GitHub APIs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { reconcileVersionPr } from './auto-patch-pr-writer.mjs';
import { reconcilePatchCas } from './auto-patch-cas.mjs';
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
          conditions: { ref_name: { include: ['refs/heads/Multimedia_Downloader_Web_Preview'], exclude: [] } } } };
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
      if (branch === 'Multimedia_Downloader_Web_Preview') {
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

async function prepareCas(options = {}) {
  const { state, args } = setup();
  const prepared = await reconcileVersionPr(args);
  const pr = state.prs.find(item => item.number === prepared.pr);
  pr.changed_files = 10;
  pr.html_url = 'https://github.com/' + fullName + '/pull/' + pr.number;
  args.github.rest.pulls.listFiles = 'pulls.files';
  const priorPaginate = args.github.paginate;
  args.github.paginate = async (method, parameters) => {
    if (method === 'pulls.files') {
      const tree = state.trees.get(state.commits.get(pr.head.sha).tree.sha);
      const files = VERSION_PATHS.map(path => ({ filename: path, status: 'modified',
        sha: tree.find(entry => entry.path === path).sha }));
      if (options.foreignFile) files[0].sha = fixedSha('f');
      return files;
    }
    return priorPaginate(method, parameters);
  };
  args.github.rest.repos.getCommit = async ({ ref }) => {
    const c = state.commits.get(ref);
    return { data: { sha: ref,
      author: { id: 359694872, login: 'kingsley-multimedia-automation[bot]', type: 'Bot' },
      committer: { id: options.badSigner ? 3 : 19864447, login: 'web-flow', type: 'User' },
      commit: { tree: c.tree, verification: { verified: true, reason: 'valid' } }, parents: c.parents } };
  };
  const common = { ruleset_id: 1, ruleset_source_type: 'Repository', ruleset_source: fullName };
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
  args.app.paginate = async () => rules;
  const priorRequest = args.app.request;
  args.app.request = async (route, parameters) => {
    if (route === 'GET /repos/{owner}/{repo}/rulesets/{ruleset_id}' && parameters.ruleset_id === 1) {
      return { data: { id: 1, target: 'branch', enforcement: 'active',
        current_user_can_bypass: options.bypass ? 'always' : 'never', rules } };
    }
    return priorRequest(route, parameters);
  };
  const checks = new Map(), head = prepared.head, fixedTime = new Date().toISOString();
  const repoInfo = { id: 1251103365, full_name: fullName };
  const actor = { id: 359694872, login: 'kingsley-multimedia-automation[bot]', type: 'Bot' };
  args.github.rest.actions.listWorkflowRunsForRepo = async () => {
    if (options.pending) return { data: { total_count: 0, workflow_runs: [] } };
    const workflow_runs = [
      { id: 11, workflow_id: 318584423, path: '.github/workflows/ci.yml', name: 'CI' },
      { id: 12, workflow_id: 422035428, path: '.github/workflows/python-matrix.yml', name: 'Python matrix tests' },
    ].map(run => ({ ...run, event: 'push', head_sha: head, head_branch: 'automation/protected-workflows',
      actor, repository: repoInfo, head_repository: repoInfo, status: 'completed',
      conclusion: 'success', run_attempt: 1, created_at: fixedTime }));
    return { data: { total_count: workflow_runs.length, workflow_runs } };
  };
  args.github.rest.actions.listJobsForWorkflowRunAttempt = async ({ run_id }) => {
    const context = 'dependabot-context-' + head + '-' + head + '-' + head;
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
    const jobs = names.map((name, index) => {
      const id = run_id * 1000 + index + 1;
      checks.set(id, { id, name, head_sha: head, status: 'completed', conclusion: 'success',
        completed_at: fixedTime, app: { id: 15368 } });
      return { id, name, run_id, run_attempt: 1, head_sha: head, status: 'completed', conclusion: 'success',
        check_run_url: 'https://api.github.com/repos/' + fullName + '/check-runs/' + id };
    });
    return { data: { total_count: jobs.length, jobs } };
  };
  args.github.rest.checks = { get: async ({ check_run_id }) => ({ data: checks.get(check_run_id) }) };
  state.writes.length = 0;
  return { state, args, prepared };
}

test('updates only Source_Code by an exact non-forced CAS after real push evidence', async () => {
  const { state, args, prepared } = await prepareCas();
  const result = await reconcilePatchCas(args);
  assert.equal(result.status, 'updated-needs-source-checks');
  assert.equal(state.refs.get('Source_Code'), prepared.head);
  assert.equal(state.refs.get('automation/protected-workflows'), prepared.head);
  assert.deepEqual(state.writes, ['cas']);
  assert.equal(state.tags.size, 0);
});

test('waits for missing checks and preserves the source ref', async () => {
  const { state, args } = await prepareCas({ pending: true });
  const result = await reconcilePatchCas(args);
  assert.equal(result.status, 'waiting-for-checks');
  assert.equal(state.refs.get('Source_Code'), fixedSha('a'));
  assert.deepEqual(state.writes, []);
});

test('rejects untrusted signatures, unrelated changes, and App ruleset bypass', async () => {
  for (const options of [{ badSigner: true }, { foreignFile: true }, { bypass: true }]) {
    const { state, args } = await prepareCas(options);
    await assert.rejects(reconcilePatchCas(args));
    assert.equal(state.refs.get('Source_Code'), fixedSha('a'));
    assert.deepEqual(state.writes, []);
  }
});

test('rejects a changed source label or another PR using the same branch', async () => {
  const revoked = await prepareCas();
  revoked.state.source.labels = [];
  await assert.rejects(reconcilePatchCas(revoked.args));
  assert.deepEqual(revoked.state.writes, []);

  const busy = await prepareCas();
  busy.state.prs.push({ number: 201, state: 'open',
    user: { id: 157894869 }, head: { ref: 'automation/protected-workflows' },
    base: { ref: 'Multimedia_Downloader_Web_Preview' } });
  await assert.rejects(reconcilePatchCas(busy.args), /another or ambiguous/);
  assert.deepEqual(busy.state.writes, []);
});

test('rejects a source merge that is not an ancestor of Source_Code', async () => {
  const { state, args } = await prepareCas();
  args.github.rest.repos.compareCommits = async () => ({ data: {
    merge_base_commit: { sha: 'f'.repeat(40) }, status: 'diverged', behind_by: 1,
  } });
  await assert.rejects(reconcilePatchCas(args), /not in current Source_Code history/);
  assert.deepEqual(state.writes, []);
});
