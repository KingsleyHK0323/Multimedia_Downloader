// OpenAI-Codex_format_architecture: bind staged installers to successful jobs in this run.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const PLATFORMS = ['ubuntu-22.04', 'macos-15', 'windows-latest'];
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
function positive(value) { return Number.isSafeInteger(value) && value > 0; }
export function selectArtifacts({ artifacts, jobs, run, runId, runAttempt, eventName, repo, ids, digests, jobIds, only = 'all' }) {
  if (!Array.isArray(artifacts) || !Array.isArray(jobs) || !positive(runId) ||
      !positive(runAttempt) || !run || run.id !== runId || run.run_attempt !== runAttempt ||
      run.event !== eventName || run.repository?.full_name !== repo || !SHA.test(run.head_sha || '') ||
      !ids || !digests || !jobIds) throw new Error('Invalid run metadata.');
  const runHeadSha = run.head_sha;
  const selected = only === 'all' ? PLATFORMS : PLATFORMS.includes(only) ? [only] : [];
  if (!selected.length) throw new Error('Invalid platform selection.');
  const result = [];
  for (const platform of selected) {
    const jobId = Number(jobIds[platform]);
    if (!positive(jobId) || String(jobId) !== String(jobIds[platform])) {
      throw new Error('Missing trusted build job output for ' + platform);
    }
    const expectedCheck = 'https://api.github.com/repos/' + repo + '/check-runs/' + jobId;
    const candidates = jobs.filter(job => job?.check_run_url === expectedCheck);
    if (candidates.length !== 1) throw new Error('Missing or duplicate build job for ' + platform);
    const job = candidates[0];
    if (!positive(job.id) || job.run_id !== runId || !positive(job.run_attempt) || job.run_attempt > runAttempt ||
        job.status !== 'completed' || job.conclusion !== 'success' || job.head_sha !== runHeadSha ||
        !Array.isArray(job.steps) ||
        !job.steps.some(step => step.name === 'Stage release artifact' && step.conclusion === 'success')) {
      throw new Error('Expected build job did not succeed for ' + platform);
    }
    const expectedId = Number(ids[platform]);
    const rawDigest = digests[platform];
    const expectedDigest = typeof rawDigest === 'string' && /^[0-9a-f]{64}$/.test(rawDigest)
      ? 'sha256:' + rawDigest : rawDigest;
    if (!positive(expectedId) || String(expectedId) !== String(ids[platform]) || !DIGEST.test(expectedDigest || '')) {
      throw new Error('Missing trusted upload output for ' + platform);
    }
    const name = 'release-stage-' + runId + '-' + job.run_attempt + '-' + platform;
    const matches = artifacts.filter(artifact => artifact?.name === name);
    if (matches.length !== 1) throw new Error('Missing or duplicate staged artifact for ' + platform);
    const artifact = matches[0];
    if (!positive(artifact.id) || artifact.id !== expectedId || artifact.digest !== expectedDigest ||
        artifact.expired !== false ||
        !positive(artifact.size_in_bytes) || artifact.size_in_bytes > 2_000_000_000 ||
        !DIGEST.test(artifact.digest || '') || artifact.workflow_run?.id !== runId ||
        artifact.workflow_run?.head_sha !== runHeadSha) {
      throw new Error('Invalid staged artifact metadata for ' + platform);
    }
    result.push({ platform, id: artifact.id, digest: artifact.digest, size: artifact.size_in_bytes,
      attempt: job.run_attempt });
  }
  if (new Set(result.map(item => item.id)).size !== selected.length) {
    throw new Error('An artifact was reused for multiple platforms.');
  }
  return result;
}
function pages(file, key) {
  const value = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(value) || value.length > 10 ||
      value.some(page => !page || !Array.isArray(page[key]) ||
        !Number.isSafeInteger(page.total_count) || page.total_count > 1000)) {
    throw new Error('Incomplete paginated ' + key + ' response.');
  }
  const entries = value.flatMap(page => page[key]);
  if (value.length && entries.length !== value[0].total_count) {
    throw new Error('Incomplete paginated ' + key + ' response.');
  }
  return entries;
}
function main() {
  const [artifactFile, jobFile, runFile] = process.argv.slice(2);
  const result = selectArtifacts({
    artifacts: pages(artifactFile, 'artifacts'), jobs: pages(jobFile, 'jobs'),
    runId: Number(process.env.GITHUB_RUN_ID), runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    run: JSON.parse(readFileSync(runFile, 'utf8')), eventName: process.env.GITHUB_EVENT_NAME || '',
    repo: process.env.GITHUB_REPOSITORY || '', only: process.env.RELEASE_ONLY || '',
    jobIds: { 'ubuntu-22.04': process.env.LINUX_JOB_ID, 'macos-15': process.env.MAC_JOB_ID,
      'windows-latest': process.env.WINDOWS_JOB_ID },
    ids: { 'ubuntu-22.04': process.env.LINUX_ID, 'macos-15': process.env.MAC_ID,
      'windows-latest': process.env.WINDOWS_ID },
    digests: { 'ubuntu-22.04': process.env.LINUX_DIGEST, 'macos-15': process.env.MAC_DIGEST,
      'windows-latest': process.env.WINDOWS_DIGEST },
  });
  process.stdout.write(JSON.stringify(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) {
    console.error('::error::Release artifact selection failed: ' + error.message);
    process.exitCode = 1;
  }
}
