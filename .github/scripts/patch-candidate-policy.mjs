// OpenAI-Codex_health_release_architecture: validate an exact, signed single-parent version candidate.
import { createHash } from 'node:crypto';
import { planVersion, validateSourcePr, validateVersionPr, VERSION_PATHS } from './patch-release-policy.mjs';

const SHA = /^[0-9a-f]{40}$/;
const REPO = 'KingsleyHK0323/Multimedia_Downloader';
const BOT = 'kingsley-multimedia-automation[bot]';
const APP_ID = 359694872;
const MAX_FILE = 5_000_000;
const blobHash = bytes => createHash('sha1')
  .update(Buffer.concat([Buffer.from('blob ' + bytes.length + '\0'), bytes])).digest('hex');

function entries(items) {
  if (!Array.isArray(items) || items.length > 100000) throw new Error('Tree inventory is incomplete.');
  const result = new Map();
  for (const item of items) {
    if (!item || typeof item.path !== 'string' || !item.path || result.has(item.path) ||
        !SHA.test(item.sha || '') || typeof item.mode !== 'string' ||
        !['blob', 'tree', 'commit'].includes(item.type)) {
      throw new Error('Tree entry is malformed or duplicated.');
    }
    result.set(item.path, item);
  }
  return result;
}
function commitMessage(plan, source, date) {
  return 'chore: release ' + plan.tag + ' after PR #' + source.number + '\n\n' +
    'Automatic patch release for merged PR #' + source.number + '\n' +
    'Patch-Source-SHA: ' + source.mergeSha + '\n' +
    'Patch-Plan-Date: ' + date + '\n' +
    'OpenAI-Codex_health_release_architecture';
}

export function validatePatchCandidate({ source, versionPr, base, headCommit, signedCommit,
  baseTree, headTree, files, changedFiles, phase = 'open' }) {
  if (!['open', 'merged'].includes(phase)) throw new Error('Unknown version PR phase.');
  const requireCurrentLabel = phase !== 'merged';
  const sourceId = validateSourcePr(source, { requireCurrentLabel });
  const prId = validateVersionPr(versionPr, source, { requireMerged: phase === 'merged', requireCurrentLabel });
  if (!SHA.test(base || '') || prId.base !== base ||
      (phase === 'open' ? versionPr.state !== 'open' : prId.merge !== prId.head) ||
      versionPr.user?.login !== BOT || versionPr.user?.type !== 'Bot' ||
      versionPr.changed_files !== VERSION_PATHS.length ||
      versionPr.html_url !== 'https://github.com/' + REPO + '/pull/' + versionPr.number ||
      !headCommit || headCommit.sha !== prId.head || !SHA.test(headCommit.tree?.sha || '') ||
      !Array.isArray(headCommit.parents) || headCommit.parents.length !== 1 ||
      headCommit.parents[0]?.sha !== base) throw new Error('Version PR or single-parent commit is invalid.');
  if (signedCommit?.sha !== headCommit.sha || signedCommit.author?.id !== APP_ID ||
      signedCommit.author.login !== BOT || signedCommit.author.type !== 'Bot' ||
      signedCommit.committer?.id !== 19864447 || signedCommit.committer.login !== 'web-flow' ||
      signedCommit.committer.type !== 'User' || signedCommit.commit?.verification?.verified !== true ||
      signedCommit.commit.verification.reason !== 'valid' ||
      signedCommit.commit.tree?.sha !== headCommit.tree.sha ||
      !Array.isArray(signedCommit.parents) || signedCommit.parents.length !== 1 ||
      signedCommit.parents[0]?.sha !== base) throw new Error('Version commit signature or identity is invalid.');
  if (typeof headCommit.message !== 'string') throw new Error('Version commit message is invalid.');
  const dateLines = headCommit.message.split('\n').filter(line => line.startsWith('Patch-Plan-Date: '));
  if (dateLines.length !== 1) throw new Error('Version commit date is missing or ambiguous.');
  const date = dateLines[0].slice('Patch-Plan-Date: '.length);
  const before = entries(baseTree), after = entries(headTree);
  if (before.size !== after.size || !files || typeof files !== 'object') {
    throw new Error('Candidate tree or source files are incomplete.');
  }
  let total = 0;
  for (const path of VERSION_PATHS) {
    const item = before.get(path);
    if (item?.type !== 'blob' || item.mode !== '100644' || typeof files[path] !== 'string') {
      throw new Error('A version source file is missing or unsafe: ' + path);
    }
    const bytes = Buffer.from(files[path], 'utf8');
    total += bytes.length;
    if (bytes.length > MAX_FILE || total > 20_000_000 || bytes.includes(0) ||
        bytes.toString('utf8') !== files[path] || blobHash(bytes) !== item.sha) {
      throw new Error('A version source file differs from the base tree: ' + path);
    }
  }
  const plan = planVersion(files, sourceId.number, date);
  if (headCommit.message.trimEnd() !== commitMessage(plan, sourceId, date)) {
    throw new Error('Version commit message does not match its plan.');
  }
  for (const [path, prior] of before) {
    const next = after.get(path);
    if (!next || next.type !== prior.type || next.mode !== prior.mode) {
      throw new Error('Candidate changed a path, type, or mode: ' + path);
    }
    if (VERSION_PATHS.includes(path)) {
      const expected = blobHash(Buffer.from(plan.updates[path], 'utf8'));
      if (next.type !== 'blob' || next.mode !== '100644' || next.sha !== expected || next.sha === prior.sha) {
        throw new Error('Candidate version file differs from its plan: ' + path);
      }
    } else if (prior.type !== 'tree' && next.sha !== prior.sha) {
      throw new Error('Candidate changed an unrelated object: ' + path);
    }
  }
  if (!Array.isArray(changedFiles) || changedFiles.length !== VERSION_PATHS.length ||
      new Set(changedFiles.map(file => file?.filename)).size !== VERSION_PATHS.length ||
      changedFiles.some(file => !VERSION_PATHS.includes(file?.filename) || file.status !== 'modified' ||
        file.previous_filename !== undefined || file.sha !== after.get(file.filename)?.sha)) {
    throw new Error('Version PR changed-file inventory is incomplete or unexpected.');
  }
  return { base, head: headCommit.sha, source: sourceId.number, sourceMerge: sourceId.mergeSha,
    versionPr: versionPr.number, tag: plan.tag, date };
}
