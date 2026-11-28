// OpenAI-Codex_health_release_architecture: exercise App version PR reconciliation with in-memory GitHub APIs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { reconcileVersionPr } from './auto-patch-pr-writer.mjs';
import { reconcilePatchReleases } from './patch-release-finalizer.mjs';
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
          assert.equal(state.commits.has(sha), false, 'Synthetic commit SHA must be unique');
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


async function prepareRelease() {
  const { state, args, prepared } = await prepareCas();
  const pr = state.prs.find(item => item.number === prepared.pr);
  pr.state = 'closed'; pr.merged = true; pr.merged_at = '2026-11-22T09:01:00Z';
  pr.merge_commit_sha = prepared.head;
  state.refs.set('Source_Code', prepared.head);
  args.workflowSha = prepared.head;
  const baseTree = state.trees.get(state.commits.get(fixedSha('a')).tree.sha);
  const headTree = state.trees.get(state.commits.get(prepared.head).tree.sha);
  const pins = [
    ['.github/workflows/release.yml', '0080bc40cd8ca29941874c25893f5aa24d121d81'],
    ['.github/workflows/release-build.yml', '27f65bfb9426e86216ffc4ea89e248ea5ac14025'],
    ['.github/scripts/upload-release-assets.mjs', 'dfc8465957eedc56448bc1fe71fc086acaad509c'],
    ['.github/scripts/verify-tag-protection.mjs', '12d61171e87bec08779e52648a77a7d7d5ac62ea'],
    ['.github/scripts/select-release-artifacts.mjs', 'c7fd3a52e296ef311e230a13d9a8d96039bad621'],
    ['.github/scripts/download-release-artifacts.py', 'dc8ca25a9548af1098ec63bb4e6a95f27114826e'],
    ['.github/scripts/stage-release-artifacts.py', 'c92c5d2e83f677f675128edb6ad16d0dcacc588c'],
    ['.github/scripts/verify-version-at-commit.mjs', '7e26a075d94f0e6840a676585c9b65029284f633'],
    ['.github/scripts/verify-release-assets.mjs', '24f704391248e8fd2da01ad73b279fb3ad2e203f'],
    ['.github/scripts/release-commit-notes.mjs', '37a37e58593055947daab2c58f8e747455389960'],
  ];
  for (const tree of [baseTree, headTree]) {
    tree.push({ path: '.github', type: 'tree', mode: '040000', sha: fixedSha('f') });
    for (const [path, sha] of pins) {
      const existing = tree.find(item => item.path === path);
      if (existing) { existing.sha = sha; existing.type = 'blob'; existing.mode = '100644'; }
      else tree.push({ path, sha, type: 'blob', mode: '100644' });
    }
  }
  const oldRef = args.app.rest.git.createRef;
  args.app.rest.git.createRef = async value => {
    const result = await oldRef(value);
    result.data.object.type = 'commit';
    return result;
  };
  const getRuns = args.github.rest.actions.listWorkflowRunsForRepo;
  args.github.rest.actions.listWorkflowRunsForRepo = async value => {
    const result = await getRuns(value);
    for (const run of result.data.workflow_runs) run.head_branch = 'Source_Code';
    if (state.releaseRun) result.data.workflow_runs.push(state.releaseRun);
    result.data.total_count = result.data.workflow_runs.length;
    return result;
  };
  state.writes.length = 0;
  return { state, args, prepared };
}

test('creates only the exact version tag after merged PR and Source_Code push checks', async () => {
  const { state, args, prepared } = await prepareRelease();
  const result = await reconcilePatchReleases(args);
  assert.equal(result.status, 'tag-created');
  assert.equal(result.tag, 'v4.3.23');
  assert.equal(state.tags.get('v4.3.23'), prepared.head);
  assert.deepEqual(state.writes, ['tag']);
});


test('a withdrawn source with no tag is skipped, and a later source may proceed', async () => {
  const { state, args, prepared } = await prepareRelease();
  state.source.labels = [];
  const cancelled = await reconcilePatchReleases(args);
  assert.equal(cancelled.status, 'ready');
  assert.deepEqual(cancelled.completed, []);
  assert.deepEqual(cancelled.skipped, [42]);
  assert.deepEqual(state.writes, []);

  const B = fixedSha('e'), previous = state.commits.get(prepared.head);
  assert.notEqual(B, prepared.head);
  assert.equal(state.commits.has(B), false, 'Synthetic source commit must not overwrite an existing commit');
  state.commits.set(B, { sha: B, tree: previous.tree, parents: [{ sha: prepared.head }], message: 'Merge later source PR' });
  state.refs.set('Source_Code', B);
  state.refs.delete('automation/protected-workflows');
  args.workflowSha = B;
  const nextSource = { ...state.source, number: 43, merge_commit_sha: B, merged_at: '2026-11-22T07:02:00Z',
    labels: [{ name: 'release:patch', node_id: 'LA_kwDOSpJShc8AAAADEWCHJg' }] };
  state.prs.push(nextSource);
  state.source = nextSource;
  const create = args.app.rest.pulls.create;
  args.app.rest.pulls.create = async input => {
    const result = await create(input);
    result.data.number = 201;
    return result;
  };
  const next = await reconcileVersionPr({ ...args, verifiedSkipped: cancelled.skipped });
  assert.equal(next.status, 'created');
  assert.equal(next.source, 43);
  assert.equal(state.tags.size, 0);
});
test('tag creation is cancelled if the owner removes the label immediately before the write', async () => {
  const { state, args } = await prepareRelease();
  const read = args.github.rest.pulls.get;
  let reads = 0;
  args.github.rest.pulls.get = async parameters => {
    if (parameters.pull_number === 42 && ++reads === 3) state.source.labels = [];
    return read(parameters);
  };
  const result = await reconcilePatchReleases(args);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.skipped, [42]);
  assert.equal(state.tags.size, 0);
  assert.deepEqual(state.writes, []);
});


test('a remove and bot re-add at the last check cannot create a tag', async () => {
  const { state, args } = await prepareRelease();
  const read = args.github.rest.pulls.get, paginate = args.github.paginate, graphql = args.github.graphql;
  let reads = 0, changed = false;
  args.github.rest.pulls.get = async parameters => {
    if (parameters.pull_number === 42 && ++reads === 3) changed = true;
    return read(parameters);
  };
  const ownerActor = { id: 157894869, node_id: 'U_kgDOCWlI1Q', type: 'User' };
  const botActor = { id: 41898282, node_id: 'MDM6Qm90NDE4OTgyODI=', type: 'Bot' };
  const extraEvents = [
    { event: 'unlabeled', node_id: 'remove-after', created_at: '2026-11-22T07:01:00Z',
      actor: ownerActor, label: { name: 'release:patch' } },
    { event: 'labeled', node_id: 'bot-readd', created_at: '2026-11-22T07:02:00Z',
      actor: botActor, label: { name: 'release:patch' } },
  ];
  args.github.paginate = async (method, parameters) => {
    const events = await paginate(method, parameters);
    return method === 'issues.timeline' && changed ? [...events, ...extraEvents] : events;
  };
  args.github.graphql = async (query, { ids }) => {
    const ordinary = ids.filter(id => !extraEvents.some(event => event.node_id === id));
    const result = ordinary.length ? await graphql(query, { ids: ordinary }) : { nodes: [] };
    return { nodes: ids.map(id => {
      const event = extraEvents.find(item => item.node_id === id);
      if (!event) return result.nodes[ordinary.indexOf(id)];
      return { __typename: event.event === 'labeled' ? 'LabeledEvent' : 'UnlabeledEvent',
        id, createdAt: event.created_at, actor: { __typename: event.actor.type, id: event.actor.node_id,
          ...(event.actor.type === 'User' ? { databaseId: event.actor.id } : {}) },
        label: { id: 'LA_kwDOSpJShc8AAAADEWCHJg', name: 'release:patch',
          createdAt: '2026-11-22T06:44:42Z', updatedAt: '2026-11-22T06:44:42Z',
          repository: { databaseId: 1251103365 } },
        labelable: { __typename: 'PullRequest', number: 42, repository: { databaseId: 1251103365 } } };
    }) };
  };
  const result = await reconcilePatchReleases(args);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.skipped, [42]);
  assert.equal(state.tags.size, 0);
  assert.deepEqual(state.writes, []);
});

test('never overwrites a conflicting tag or incomplete draft release', async () => {
  const conflict = await prepareRelease();
  conflict.state.tags.set('v4.3.23', fixedSha('f'));
  await assert.rejects(reconcilePatchReleases(conflict.args), /different commit/);
  assert.deepEqual(conflict.state.writes, []);
  const partial = await prepareRelease();
  partial.state.tags.set('v4.3.23', partial.prepared.head);
  partial.state.release = { id: 7, tag_name: 'v4.3.23', draft: true };
  assert.equal((await reconcilePatchReleases(partial.args)).status, 'draft-requires-review');
  assert.deepEqual(partial.state.writes, []);
});


test('waits for a trusted active tag run while its release draft is being populated', async () => {
  const { state, args, prepared } = await prepareRelease();
  const tag = 'v4.3.23';
  const repository = { id: 1251103365, full_name: owner + '/' + repo };
  state.tags.set(tag, prepared.head);
  state.release = { id: 7, tag_name: tag, draft: true };
  state.releaseRun = { id: 13, workflow_id: 315481913, path: '.github/workflows/release.yml',
    event: 'push', head_sha: prepared.head, head_branch: tag,
    actor: { id: 359694872, login: 'kingsley-multimedia-automation[bot]', type: 'Bot' },
    repository, head_repository: repository, status: 'in_progress', conclusion: null };
  assert.equal((await reconcilePatchReleases(args)).status, 'waiting-for-release-run');
  state.releaseRun.status = 'completed';
  state.releaseRun.conclusion = 'failure';
  assert.equal((await reconcilePatchReleases(args)).status, 'draft-requires-review');
  state.releaseRun.status = 'in_progress';
  state.releaseRun.conclusion = null;
  state.releaseRun.actor.id = 1;
  await assert.rejects(reconcilePatchReleases(args), /run identity/);
  state.releaseRun.actor.id = 359694872;
  state.releaseRun.status = 'unexpected';
  await assert.rejects(reconcilePatchReleases(args), /status is unknown/);
  state.releaseRun.status = 'in_progress';
  state.releaseRun.conclusion = 'failure';
  await assert.rejects(reconcilePatchReleases(args), /conclusion is incomplete/);
  state.releaseRun.conclusion = null;
  const runs = args.github.rest.actions.listWorkflowRunsForRepo;
  args.github.rest.actions.listWorkflowRunsForRepo = async parameters => {
    const result = await runs(parameters);
    result.data.workflow_runs.push({ ...state.releaseRun, id: 14 });
    result.data.total_count = result.data.workflow_runs.length;
    return result;
  };
  await assert.rejects(reconcilePatchReleases(args), /runs are ambiguous/);
  assert.deepEqual(state.writes, []);
});

test('waits for a tag-push release run without dispatching a duplicate', async () => {
  const { state, args, prepared } = await prepareRelease();
  state.tags.set('v4.3.23', prepared.head);
  const result = await reconcilePatchReleases(args);
  assert.equal(result.status, 'waiting-for-release-run');
  assert.deepEqual(state.writes, []);
});

test('accepts a published release only after trusted run, check and asset proof, then unblocks the writer', async () => {
  const { state, args, prepared } = await prepareRelease();
  const tag = 'v4.3.23', H = prepared.head, fullName = owner + '/' + repo;
  state.tags.set(tag, H);
  state.source.labels = [];
  state.release = { id: 7, tag_name: tag, draft: false, prerelease: false, published_at: '2026-11-22T10:06:00Z' };
  const repository = { id: 1251103365, full_name: fullName };
  state.releaseRun = { id: 13, check_suite_id: 44, name: 'Release build', path: '.github/workflows/release.yml',
    workflow_id: 315481913, event: 'push', head_sha: H, head_branch: tag,
    actor: { id: 359694872, login: 'kingsley-multimedia-automation[bot]', type: 'Bot' },
    repository, head_repository: repository, status: 'completed', conclusion: 'success', run_attempt: 1 };
  const steps = {
    metadata: ['Validate tag and resolve its trusted source'],
    setup: ['Validate release inputs', 'Check version consistency across project files', 'Check the tag matches the project version'],
    publisher: ['Verify version data at the immutable source commit', 'Resolve and verify build artifact identities',
      'Download and safely stage installer data', 'Create or verify the draft release', 'Upload or verify exact release assets'],
    'publish-stable': ['Verify installers and exact-commit tests'],
  };
  const checkMap = new Map();
  const jobs = Object.entries(steps).map(([name, values], index) => {
    const id = 500 + index;
    checkMap.set(id, { id, name, head_sha: H, status: 'completed', conclusion: 'success',
      app: { id: 15368 }, check_suite: { id: 44 } });
    return { id, name, run_id: 13, run_attempt: 1, head_sha: H, status: 'completed', conclusion: 'success',
      started_at: name === 'publish-stable' ? '2026-11-22T10:05:00Z' : '2026-11-22T10:00:00Z',
      completed_at: name === 'publish-stable' ? '2026-11-22T10:07:00Z' : '2026-11-22T10:04:00Z',
      check_run_url: 'https://api.github.com/repos/' + fullName + '/check-runs/' + id,
      steps: values.map(value => ({ name: value, status: 'completed', conclusion: 'success' })) };
  });
  const prevJobs = args.github.rest.actions.listJobsForWorkflowRunAttempt;
  args.github.rest.actions.listJobsForWorkflowRunAttempt = async value => value.run_id === 13
    ? { data: { total_count: jobs.length, jobs } } : prevJobs(value);
  const prevChecks = args.github.rest.checks.get;
  args.github.rest.checks.get = async value => checkMap.has(value.check_run_id)
    ? { data: checkMap.get(value.check_run_id) } : prevChecks(value);
  const names = [
    'Multimedia.Downloader-4.3.23-1.x86_64.rpm', 'Multimedia.Downloader_4.3.23_amd64.AppImage',
    'Multimedia.Downloader_4.3.23_amd64.deb', 'Multimedia.Downloader_4.3.23_aarch64.dmg',
    'Multimedia.Downloader_4.3.23_x64-setup.exe', 'Multimedia.Downloader_4.3.23_x64_en-US.msi',
  ];
  const assets = names.map((name, index) => ({ id: index + 1, name, size: index + 1,
    digest: 'sha256:' + String(index).repeat(64), state: 'uploaded',
    created_at: '2026-11-22T10:02:00Z', updated_at: '2026-11-22T10:02:00Z',
    uploader: { id: 41898282, login: 'github-actions[bot]', type: 'Bot' } }));
  const priorPaginate = args.github.paginate;
  args.github.paginate = async (method, parameters) => method === 'repos.releaseAssets'
    ? assets : priorPaginate(method, parameters);
  const result = await reconcilePatchReleases(args);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.completed, [42]);
  assert.equal((await reconcileVersionPr({ ...args, verifiedCompleted: result.completed })).status, 'idle');
  assert.deepEqual(state.writes, []);
});

// OpenAI-Codex: a release helper update must refresh the trusted blob pins.
test('trusted release pins match all current repository helper files', () => {
  const inspector = readFileSync(new URL('./inspect-merged-patch.mjs', import.meta.url), 'utf8');
  const entries = [...inspector.matchAll(/^\s*\['(\.github\/(?:workflows|scripts)\/[^']+)', '([0-9a-f]{40})'\],$/gm)];
  assert.equal(entries.length, 10);
  assert.equal(new Set(entries.map(entry => entry[1])).size, 10);
  for (const [, path, expected] of entries) {
    const source = readFileSync(new URL('../../' + path, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
    assert.equal(blobHash(source), expected, 'Trusted release helper changed: ' + path);
  }
});
