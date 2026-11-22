// OpenAI-Codex_format_architecture: mock the actual release artifact selector.
import assert from 'node:assert/strict';
import test from 'node:test';
import { selectArtifacts } from './select-release-artifacts.mjs';

const runId = 123;
const workflowSha = 'a'.repeat(40);
const platforms = ['ubuntu-22.04', 'macos-15', 'windows-latest'];
function job(platform, attempt, overrides = {}) {
  return { id: 100 + platforms.indexOf(platform) + 10 * attempt,
    name: 'Release build (' + platform + ')', run_id: runId, run_attempt: attempt,
    status: 'completed', conclusion: 'success', head_sha: workflowSha,
    check_run_url: 'https://api.github.com/repos/KingsleyHK0323/Multimedia_Downloader/check-runs/' + (100 + platforms.indexOf(platform) + 10 * attempt),
    steps: [{ name: 'Stage release artifact', conclusion: 'success' }], ...overrides };
}
function artifact(platform, attempt, overrides = {}) {
  return { id: 200 + platforms.indexOf(platform) + 10 * attempt,
    name: 'release-stage-' + runId + '-' + attempt + '-' + platform,
    size_in_bytes: 1024, expired: false, digest: 'sha256:' + 'b'.repeat(64),
    workflow_run: { id: runId, head_sha: workflowSha }, ...overrides };
}
function fixture() {
  return { runId, runAttempt: 1, eventName: 'workflow_dispatch', repo: 'KingsleyHK0323/Multimedia_Downloader',
    run: { id: runId, run_attempt: 1, event: 'workflow_dispatch', head_sha: workflowSha,
      repository: { full_name: 'KingsleyHK0323/Multimedia_Downloader' } },
    jobIds: Object.fromEntries(platforms.map(p => [p, String(job(p, 1).id)])),
    ids: Object.fromEntries(platforms.map(p => [p, String(artifact(p, 1).id)])),
    digests: Object.fromEntries(platforms.map(p => [p, 'sha256:' + 'b'.repeat(64)])),
    jobs: platforms.map(p => job(p, 1)), artifacts: platforms.map(p => artifact(p, 1)) };
}
test('selects exactly the three verified platform artifacts', () => {
  const result = selectArtifacts(fixture());
  assert.deepEqual(result.map(x => x.platform), platforms);
  assert.deepEqual(result.map(x => x.attempt), [1, 1, 1]);
});
test('failed-only reruns preserve successful artifacts from earlier attempts', () => {
  const x = fixture();
  x.runAttempt = 2;
  x.run.run_attempt = 2;
  x.jobs.push(job('windows-latest', 2));
  x.jobIds['windows-latest'] = String(job('windows-latest', 2).id);
  x.artifacts.push(artifact('windows-latest', 2));
  x.ids['windows-latest'] = String(artifact('windows-latest', 2).id);
  const result = selectArtifacts(x);
  assert.deepEqual(result.map(item => item.attempt), [1, 1, 2]);
});
test('a newer failed platform attempt cannot reuse an older success', () => {
  const x = fixture();
  x.runAttempt = 2;
  x.run.run_attempt = 2;
  x.jobs.push(job('windows-latest', 2, { conclusion: 'failure' }));
  x.jobIds['windows-latest'] = String(job('windows-latest', 2).id);
  assert.throws(() => selectArtifacts(x), /did not succeed/);
});
test('missing, duplicate, expired and foreign artifacts fail closed', () => {
  for (const alter of [
    x => { x.artifacts.pop(); },
    x => { x.artifacts.push({ ...x.artifacts[0] }); },
    x => { x.artifacts[0].expired = true; },
    x => { x.artifacts[0].digest = null; },
    x => { x.artifacts[0].workflow_run.id++; },
    x => { x.artifacts[0].workflow_run.head_sha = 'c'.repeat(40); },
    x => { x.artifacts[0].size_in_bytes = 0; },
  ]) {
    const x = fixture();
    alter(x);
    assert.throws(() => selectArtifacts(x));
  }
});
test('missing, foreign or ambiguous jobs fail closed', () => {
  for (const alter of [
    x => { x.jobs.pop(); },
    x => { x.jobs[0].head_sha = 'f'.repeat(40); },
    x => { x.jobs[0].run_id++; },
    x => { x.jobs.push({ ...x.jobs[0] }); },
    x => { x.jobs[0].status = 'in_progress'; },
  ]) {
    const x = fixture();
    alter(x);
    assert.throws(() => selectArtifacts(x));
  }
});

test('artifact id and digest must match the individual upload action outputs', () => {
  const badId = fixture();
  badId.ids['ubuntu-22.04'] = '999';
  assert.throws(() => selectArtifacts(badId), /Invalid staged artifact metadata/);
  const badDigest = fixture();
  badDigest.digests['macos-15'] = 'c'.repeat(64);
  assert.throws(() => selectArtifacts(badDigest), /Invalid staged artifact metadata/);
});

test('a single-platform recovery selects only the requested platform', () => {
  const x = fixture();
  x.only = 'macos-15';
  x.jobs = x.jobs.filter(item => item.name.includes('macos-15'));
  x.artifacts = x.artifacts.filter(item => item.name.endsWith('macos-15'));
  assert.deepEqual(selectArtifacts(x).map(item => item.platform), ['macos-15']);
  x.only = 'unknown';
  assert.throws(() => selectArtifacts(x), /Invalid platform selection/);
});

test('pull_request_target uses the REST run head rather than the base GITHUB_SHA', () => {
  const x = fixture();
  const actualHead = 'c'.repeat(40);
  x.eventName = 'pull_request_target';
  x.run.event = 'pull_request_target';
  x.run.head_sha = actualHead;
  for (const item of x.jobs) item.head_sha = actualHead;
  for (const item of x.artifacts) item.workflow_run.head_sha = actualHead;
  assert.deepEqual(selectArtifacts(x).map(item => item.platform), platforms);
  x.artifacts[0].workflow_run.head_sha = 'a'.repeat(40);
  assert.throws(() => selectArtifacts(x), /Invalid staged artifact metadata/);
});
