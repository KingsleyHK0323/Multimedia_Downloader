// OpenAI-Codex_health_release_architecture: verify publication via the exact trusted release run and unchanged assets.
import { expectedNames } from './upload-release-assets.mjs';

const FULL = 'KingsleyHK0323/Multimedia_Downloader', RID = 1251103365;
const BOT = 'kingsley-multimedia-automation[bot]', SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const positive = n => Number.isSafeInteger(n) && n > 0;

export async function verifyPublishedPatch({ github, owner, repo, tag, commit, release }) {
  if (owner + '/' + repo !== FULL || !SHA.test(commit || '') || !positive(release?.id) ||
      release.tag_name !== tag || release.draft !== false || release.prerelease !== false ||
      typeof release.published_at !== 'string' || !Number.isFinite(Date.parse(release.published_at))) {
    throw new Error('Published patch release metadata is invalid.');
  }
  const expected = new Set(expectedNames(tag, 'all'));
  const runs = [];
  let total;
  for (let page = 1; page <= 10; page++) {
    const d = (await github.rest.actions.listWorkflowRunsForRepo({
      owner, repo, event: 'push', head_sha: commit, per_page: 100, page,
    })).data;
    if (!d || !Number.isSafeInteger(d.total_count) || d.total_count < 0 || d.total_count > 1000 ||
        !Array.isArray(d.workflow_runs) || d.workflow_runs.length > 100 ||
        (total !== undefined && total !== d.total_count)) throw new Error('Release run inventory is incomplete.');
    total = d.total_count; runs.push(...d.workflow_runs);
    if (runs.length >= total) break;
    if (d.workflow_runs.length !== 100) throw new Error('Release run page is incomplete.');
  }
  if (runs.length !== total || new Set(runs.map(run => run?.id)).size !== runs.length) {
    throw new Error('Release run identities are ambiguous.');
  }
  const matching = runs.filter(run => run?.path === '.github/workflows/release.yml' &&
    run.head_sha === commit && run.head_branch === tag);
  if (matching.length === 0) return null;
  if (matching.length !== 1) throw new Error('More than one tag-push release run is ambiguous.');
  const run = matching[0];
  if (!positive(run.id) || run.name !== 'Release build' || run.workflow_id !== 315481913 ||
      run.event !== 'push' || run.actor?.id !== 359694872 || run.actor.login !== BOT ||
      run.actor.type !== 'Bot' || run.repository?.id !== RID || run.repository.full_name !== FULL ||
      run.head_repository?.id !== RID || run.head_repository.full_name !== FULL ||
      !positive(run.run_attempt) || run.run_attempt > 10 || !positive(run.check_suite_id)) {
    throw new Error('Release run is not the exact App tag push.');
  }
  if (['queued', 'in_progress', 'waiting', 'requested', 'pending'].includes(run.status)) return null;
  if (run.status !== 'completed' || run.conclusion !== 'success') throw new Error('Release run did not succeed.');
  const required = new Map([
    ['metadata', ['Validate tag and resolve its trusted source']],
    ['setup', ['Validate release inputs', 'Check version consistency across project files',
      'Check the tag matches the project version']],
    ['publisher', ['Verify version data at the immutable source commit', 'Resolve and verify build artifact identities',
      'Download and safely stage installer data', 'Create or verify the draft release', 'Upload or verify exact release assets']],
    ['publish-stable', ['Verify installers and exact-commit tests']],
  ]);
  const latest = new Map(), seen = new Set();
  for (let attempt = 1; attempt <= run.run_attempt; attempt++) {
    const d = (await github.rest.actions.listJobsForWorkflowRunAttempt({
      owner, repo, run_id: run.id, attempt_number: attempt, per_page: 100,
    })).data;
    if (!d || !Number.isSafeInteger(d.total_count) || d.total_count < 1 || d.total_count > 100 ||
        !Array.isArray(d.jobs) || d.jobs.length !== d.total_count) throw new Error('Release jobs are incomplete.');
    const names = new Set();
    for (const job of d.jobs) {
      if (!positive(job?.id) || seen.has(job.id) || job.run_id !== run.id || job.head_sha !== commit ||
          (job.run_attempt !== undefined && job.run_attempt !== attempt) ||
          typeof job.name !== 'string' || names.has(job.name)) throw new Error('Release job identity is invalid.');
      seen.add(job.id); names.add(job.name);
      if (required.has(job.name)) latest.set(job.name, { job, attempt });
    }
  }
  const proof = [];
  for (const [name, steps] of required) {
    const selected = latest.get(name), job = selected?.job;
    if (!job || job.status !== 'completed' || job.conclusion !== 'success' || !Array.isArray(job.steps)) {
      throw new Error('Required release job did not succeed: ' + name);
    }
    const start = Date.parse(job.started_at), end = Date.parse(job.completed_at);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new Error('Release job timing is invalid.');
    for (const step of steps) {
      const matches = job.steps.filter(item => item?.name === step);
      if (matches.length !== 1 || matches[0].status !== 'completed' || matches[0].conclusion !== 'success') {
        throw new Error('Required release step did not succeed: ' + step);
      }
    }
    const prefix = 'https://api.github.com/repos/' + FULL + '/check-runs/';
    const suffix = typeof job.check_run_url === 'string' && job.check_run_url.startsWith(prefix)
      ? job.check_run_url.slice(prefix.length) : '';
    const checkId = Number(suffix);
    if (!/^[1-9][0-9]*$/.test(suffix) || !positive(checkId)) throw new Error('Release job check identity is invalid.');
    const check = (await github.rest.checks.get({ owner, repo, check_run_id: checkId })).data;
    if (check?.id !== checkId || check.name !== name || check.head_sha !== commit ||
        check.status !== 'completed' || check.conclusion !== 'success' || check.app?.id !== 15368 ||
        check.check_suite?.id !== run.check_suite_id) throw new Error('Release job check is not trusted: ' + name);
    proof.push({ name, job: job.id, check: checkId, attempt: selected.attempt, start, end });
  }
  const publisher = proof.find(item => item.name === 'publisher');
  const stable = proof.find(item => item.name === 'publish-stable');
  const published = Date.parse(release.published_at);
  if (stable.start <= publisher.end || published < stable.start || published > stable.end) {
    throw new Error('Release publication timing does not match the trusted jobs.');
  }
  const assets = await github.paginate(github.rest.repos.listReleaseAssets, {
    owner, repo, release_id: release.id, per_page: 100,
  });
  if (!Array.isArray(assets) || assets.length > 1000) throw new Error('Release asset inventory is incomplete.');
  const installers = assets.filter(asset => typeof asset?.name === 'string' &&
    (/\.(?:rpm|deb|AppImage|dmg|msi)$/.test(asset.name) || asset.name.endsWith('-setup.exe')));
  if (installers.length !== expected.size || new Set(installers.map(asset => asset.name)).size !== expected.size ||
      installers.some(asset => !expected.has(asset.name) || !positive(asset.id) || asset.state !== 'uploaded' ||
        !positive(asset.size) || !DIGEST.test(asset.digest || '') ||
        asset.uploader?.id !== 41898282 || asset.uploader.login !== 'github-actions[bot]' ||
        asset.uploader.type !== 'Bot' || !Number.isFinite(Date.parse(asset.created_at)) ||
        !Number.isFinite(Date.parse(asset.updated_at)) ||
        Date.parse(asset.created_at) < publisher.start || Date.parse(asset.updated_at) > publisher.end ||
        Date.parse(asset.updated_at) < Date.parse(asset.created_at))) {
    throw new Error('Published assets do not match the trusted publisher interval.');
  }
  return { runId: run.id, attempt: run.run_attempt, jobs: proof,
    assets: installers.map(asset => ({ id: asset.id, name: asset.name, size: asset.size,
      digest: asset.digest, created_at: asset.created_at, updated_at: asset.updated_at }))
      .sort((a, b) => a.name.localeCompare(b.name)) };
}
