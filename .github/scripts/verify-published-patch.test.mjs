// OpenAI-Codex_health_release_architecture: verify patch publication against real-run and asset evidence.
import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyPublishedPatch } from './verify-published-patch.mjs';

const owner = 'KingsleyHK0323', repo = 'Multimedia_Downloader', full = owner + '/' + repo;
const tag = 'v4.3.23', commit = 'a'.repeat(40);
const start = '2026-11-22T10:00:00Z', uploaded = '2026-11-22T10:02:00Z';
const publisherEnd = '2026-11-22T10:04:00Z', stableStart = '2026-11-22T10:05:00Z';
const published = '2026-11-22T10:06:00Z', stableEnd = '2026-11-22T10:07:00Z';
const names = [
  'Multimedia.Downloader-4.3.23-1.x86_64.rpm',
  'Multimedia.Downloader_4.3.23_amd64.AppImage',
  'Multimedia.Downloader_4.3.23_amd64.deb',
  'Multimedia.Downloader_4.3.23_aarch64.dmg',
  'Multimedia.Downloader_4.3.23_x64-setup.exe',
  'Multimedia.Downloader_4.3.23_x64_en-US.msi',
];
function fixture() {
  const repository = { id: 1251103365, full_name: full };
  const run = { id: 12, check_suite_id: 44, name: 'Release build', path: '.github/workflows/release.yml',
    workflow_id: 315481913, event: 'push', head_sha: commit, head_branch: tag,
    actor: { id: 359694872, login: 'kingsley-multimedia-automation[bot]', type: 'Bot' },
    repository, head_repository: repository, status: 'completed', conclusion: 'success', run_attempt: 1 };
  const stepNames = {
    metadata: ['Validate tag and resolve its trusted source'],
    setup: ['Validate release inputs', 'Check version consistency across project files', 'Check the tag matches the project version'],
    publisher: ['Verify version data at the immutable source commit', 'Resolve and verify build artifact identities',
      'Download and safely stage installer data', 'Create or verify the draft release', 'Upload or verify exact release assets'],
    'publish-stable': ['Verify installers and exact-commit tests'],
  };
  const checks = new Map();
  const jobs = Object.entries(stepNames).map(([name, steps], index) => {
    const id = 100 + index;
    checks.set(id, { id, name, head_sha: commit, status: 'completed', conclusion: 'success',
      app: { id: 15368 }, check_suite: { id: 44 } });
    return { id, name, run_id: 12, run_attempt: 1, head_sha: commit, status: 'completed', conclusion: 'success',
      started_at: name === 'publish-stable' ? stableStart : start,
      completed_at: name === 'publish-stable' ? stableEnd : publisherEnd,
      check_run_url: 'https://api.github.com/repos/' + full + '/check-runs/' + id,
      steps: steps.map(step => ({ name: step, status: 'completed', conclusion: 'success' })) };
  });
  const assets = names.map((name, index) => ({ id: index + 1, name, size: index + 1,
    digest: 'sha256:' + String(index).repeat(64), state: 'uploaded', created_at: uploaded, updated_at: uploaded,
    uploader: { id: 41898282, login: 'github-actions[bot]', type: 'Bot' } }));
  const state = { runs: [run], jobs, checks, assets };
  const github = { rest: {
    actions: {
      listWorkflowRunsForRepo: async () => ({ data: { total_count: state.runs.length, workflow_runs: state.runs } }),
      listJobsForWorkflowRunAttempt: async () => ({ data: { total_count: state.jobs.length, jobs: state.jobs } }),
    },
    checks: { get: async ({ check_run_id }) => ({ data: state.checks.get(check_run_id) }) },
    repos: { listReleaseAssets: 'assets' },
  }, paginate: async method => method === 'assets' ? state.assets : [] };
  const release = { id: 7, tag_name: tag, draft: false, prerelease: false, published_at: published };
  return { state, args: { github, owner, repo, tag, commit, release } };
}

test('accepts six unchanged assets from the exact successful App release run', async () => {
  const { args } = fixture();
  const proof = await verifyPublishedPatch(args);
  assert.equal(proof.runId, 12);
  assert.equal(proof.jobs.length, 4);
  assert.equal(proof.assets.length, 6);
});

test('waits if no matching tag push run has appeared', async () => {
  const { state, args } = fixture();
  state.runs = [];
  assert.equal(await verifyPublishedPatch(args), null);
});

test('rejects untrusted runs, checks, failed steps and asset replacements', async () => {
  for (const mutate of [
    x => { x.state.runs[0].actor.id = 1; },
    x => { x.state.checks.get(100).check_suite.id = 1; },
    x => { x.state.jobs.find(job => job.name === 'publisher').steps[0].conclusion = 'failure'; },
    x => { x.state.assets[0].uploader.id = 1; },
    x => { x.state.assets[0].digest = null; },
    x => { x.state.assets[0].updated_at = '2026-11-22T10:08:00Z'; },
    x => { x.state.jobs.find(job => job.name === 'publish-stable').started_at = publisherEnd; },
    x => { x.state.assets.pop(); },
    x => { x.args.release.prerelease = true; },
    x => { x.state.runs.push({ ...x.state.runs[0], id: 13 }); },
  ]) {
    const candidate = fixture(); mutate(candidate);
    await assert.rejects(verifyPublishedPatch(candidate.args));
  }
});
