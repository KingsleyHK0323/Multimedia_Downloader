// OpenAI-Codex_artifact_fix: pin reviewed artifact action upgrades.
// OpenAI-Codex_health_release_architecture: reconstruct a merged patch candidate before tag or release decisions.
import { createHash } from 'node:crypto';
import { ANCHOR_PATH, ANCHOR_CONTENT, currentPatchLabel, labelAtMerge, utcSecond } from './patch-source-authorization.mjs';
import { validateSourcePr, VERSION_PATHS } from './patch-release-policy.mjs';
import { validatePatchCandidate } from './patch-candidate-policy.mjs';

const FULL = 'KingsleyHK0323/Multimedia_Downloader', RID = 1251103365;
const TEMP = 'automation/protected-workflows';
const SHA = /^[0-9a-f]{40}$/;
const blobHash = bytes => createHash('sha1')
  .update(Buffer.concat([Buffer.from('blob ' + bytes.length + '\0'), bytes])).digest('hex');

export async function inspectMergedPatch({ github, context, workflowSha, anchorPrNumber, versionPrNumber }) {
  const { owner, repo } = context.repo || {};
  if (owner + '/' + repo !== FULL || context.ref !== 'refs/heads/Source_Code' || !SHA.test(workflowSha || '') ||
      !Number.isSafeInteger(anchorPrNumber) || anchorPrNumber < 1 ||
      !Number.isSafeInteger(versionPrNumber) || versionPrNumber < 1) {
    throw new Error('Merged patch inspection context is invalid.');
  }
  const ref = async () => {
    const d = (await github.rest.git.getRef({ owner, repo, ref: 'heads/Source_Code' })).data;
    if (d?.ref !== 'refs/heads/Source_Code' || d.object?.type !== 'commit' ||
        d.object.sha !== workflowSha) throw new Error('Source_Code moved during release inspection.');
    return d.object.sha;
  };
  const getCommit = async sha => {
    if (!SHA.test(sha || '')) throw new Error('Invalid Git commit SHA.');
    const d = (await github.rest.git.getCommit({ owner, repo, commit_sha: sha })).data;
    if (d?.sha !== sha || !SHA.test(d.tree?.sha || '') || !Array.isArray(d.parents) ||
        d.parents.some(parent => !SHA.test(parent?.sha || ''))) throw new Error('Commit metadata is incomplete.');
    return d;
  };
  const getTree = async sha => {
    const d = (await github.rest.git.getTree({ owner, repo, tree_sha: sha, recursive: 'true' })).data;
    if (d?.sha !== sha || d.truncated !== false || !Array.isArray(d.tree) || d.tree.length > 100000) {
      throw new Error('Git tree inventory is incomplete.');
    }
    return d.tree;
  };
  const getFiles = async entries => {
    const byPath = new Map();
    for (const item of entries) {
      if (!item || typeof item.path !== 'string' || byPath.has(item.path)) throw new Error('Duplicate tree path.');
      byPath.set(item.path, item);
    }
    const files = {};
    let total = 0;
    for (const path of VERSION_PATHS) {
      const entry = byPath.get(path);
      if (entry?.type !== 'blob' || entry.mode !== '100644' || !SHA.test(entry.sha || '') ||
          !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 5_000_000) {
        throw new Error('Version file tree entry is invalid.');
      }
      total += entry.size;
      if (total > 20_000_000) throw new Error('Version source files are too large.');
      const blob = (await github.rest.git.getBlob({ owner, repo, file_sha: entry.sha })).data;
      if (blob?.sha !== entry.sha || blob.encoding !== 'base64' || blob.size !== entry.size ||
          typeof blob.content !== 'string') throw new Error('Version blob metadata is invalid.');
      const encoded = blob.content.replace(/\s/g, '');
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
        throw new Error('Version blob encoding is invalid.');
      }
      const bytes = Buffer.from(encoded, 'base64');
      if (bytes.length !== entry.size || bytes.toString('base64') !== encoded ||
          blobHash(bytes) !== entry.sha || bytes.includes(0)) throw new Error('Version blob bytes are invalid.');
      files[path] = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (!Buffer.from(files[path], 'utf8').equals(bytes)) throw new Error('Version blob is not canonical UTF-8.');
    }
    return files;
  };
  await ref();
  const [versionResponse, anchorResponse] = await Promise.all([
    github.rest.pulls.get({ owner, repo, pull_number: versionPrNumber }),
    github.rest.pulls.get({ owner, repo, pull_number: anchorPrNumber }),
  ]);
  const versionPr = versionResponse.data, anchor = anchorResponse.data;
  if (versionPr?.number !== versionPrNumber || versionPr.state !== 'closed' || versionPr.merged !== true ||
      versionPr.user?.id !== 359694872 || versionPr.user.login !== 'kingsley-multimedia-automation[bot]' ||
      versionPr.user.type !== 'Bot' || typeof versionPr.body !== 'string') {
    throw new Error('Merged version PR identity is invalid.');
  }
  const markers = [...versionPr.body.matchAll(/^<!-- automatic-patch-source:([1-9][0-9]*):([0-9a-f]{40}) -->$/gm)];
  if (markers.length !== 1) throw new Error('Merged version PR source marker is ambiguous.');
  const sourceNumber = Number(markers[0][1]);
  if (!Number.isSafeInteger(sourceNumber) || sourceNumber < 1) throw new Error('Source PR number is invalid.');
  const source = (await github.rest.pulls.get({ owner, repo, pull_number: sourceNumber })).data;
  const sourceId = validateSourcePr(source, { requireCurrentLabel: false });
  if (sourceId.mergeSha !== markers[0][2] || source.number !== sourceNumber) {
    throw new Error('Merged version PR does not match the source PR.');
  }
  if (anchor?.number !== anchorPrNumber || anchor.state !== 'closed' || anchor.merged !== true ||
      anchor.user?.id !== 157894869 || anchor.base?.ref !== 'Source_Code' ||
      anchor.base?.repo?.id !== RID || anchor.base.repo.full_name !== FULL ||
      anchor.head?.ref !== TEMP || anchor.head?.repo?.id !== RID || anchor.head.repo.full_name !== FULL ||
      !SHA.test(anchor.merge_commit_sha || '') || utcSecond(source.merged_at) <= utcSecond(anchor.merged_at)) {
    throw new Error('Approved migration anchor is invalid.');
  }
  const anchorCommit = await getCommit(anchor.merge_commit_sha);
  const marker = (await getTree(anchorCommit.tree.sha)).filter(entry => entry?.path === ANCHOR_PATH);
  if (marker.length !== 1 || marker[0].type !== 'blob' || marker[0].mode !== '100644' ||
      marker[0].sha !== blobHash(Buffer.from(ANCHOR_CONTENT, 'utf8'))) {
    throw new Error('Approved migration anchor marker is invalid.');
  }
  const B = versionPr.base?.sha, H = versionPr.head?.sha;
  if (!SHA.test(B || '') || !SHA.test(H || '') || versionPr.merge_commit_sha !== H) {
    throw new Error('Merged version PR does not identify its exact source commit.');
  }
  let cursor = workflowSha;
  const seen = new Set();
  let sawHead = false, sawAnchor = false;
  while (!sawAnchor) {
    if (seen.has(cursor) || seen.size >= 10000) throw new Error('First-parent release history is incomplete.');
    seen.add(cursor);
    if (cursor === H) sawHead = true;
    if (cursor === anchor.merge_commit_sha) { sawAnchor = true; break; }
    const entry = await getCommit(cursor);
    if (!entry.parents.length) throw new Error('Migration anchor is not in Source_Code first-parent history.');
    cursor = entry.parents[0].sha;
  }
  if (!sawHead) throw new Error('Version commit is not in Source_Code first-parent history.');
  const ancestry = (await github.rest.repos.compareCommits({ owner, repo, base: sourceId.mergeSha, head: B })).data;
  if (ancestry?.merge_base_commit?.sha !== sourceId.mergeSha || ancestry.behind_by !== 0 ||
      !['ahead', 'identical'].includes(ancestry.status)) throw new Error('Source PR is not in version base history.');
  const timeline = await github.paginate(github.rest.issues.listEventsForTimeline, {
    owner, repo, issue_number: sourceNumber, per_page: 100,
  });
  const authorization = await labelAtMerge(timeline, source.merged_at, sourceId.mergeSha, github, sourceNumber);
  if (!authorization.atMerge) throw new Error('Patch label authorization at merge is unavailable.');
  const sourceCurrentlyAuthorized = currentPatchLabel(source) && !authorization.withdrawnAfterMerge;
  const [baseCommit, headCommit, signed, currentCommit] = await Promise.all([
    getCommit(B), getCommit(H), github.rest.repos.getCommit({ owner, repo, ref: H }), getCommit(workflowSha),
  ]);
  const [baseTree, headTree, currentTree, changedFiles] = await Promise.all([
    getTree(baseCommit.tree.sha), getTree(headCommit.tree.sha), getTree(currentCommit.tree.sha),
    github.paginate(github.rest.pulls.listFiles, { owner, repo, pull_number: versionPrNumber, per_page: 100 }),
  ]);
  const files = await getFiles(baseTree);
  const candidate = validatePatchCandidate({ source, versionPr, base: B, headCommit,
    signedCommit: signed.data, baseTree, headTree, files, changedFiles, phase: 'merged' });
  const githubTree = entries => entries.filter(entry => entry?.path === '.github');
  const [from, current] = [githubTree(headTree), githubTree(currentTree)];
  if (from.length !== 1 || current.length !== 1 || from[0].type !== 'tree' ||
      from[0].mode !== '040000' || current[0].type !== 'tree' || current[0].mode !== '040000' ||
      from[0].sha !== current[0].sha) throw new Error('Release workflow tree changed since the version commit.');
  // OpenAI-Codex: pin the currently verified release workflow and asset uploader.
  // These exact trusted release files verify staged artifacts and published asset digests.
  const trustedFiles = new Map([
    ['.github/workflows/release.yml', '0080bc40cd8ca29941874c25893f5aa24d121d81'],
    ['.github/workflows/release-build.yml', '31ffddae74a463787901b1318375949d3feabe00'],
    ['.github/scripts/upload-release-assets.mjs', 'dfc8465957eedc56448bc1fe71fc086acaad509c'],
    ['.github/scripts/verify-tag-protection.mjs', '12d61171e87bec08779e52648a77a7d7d5ac62ea'],
    ['.github/scripts/select-release-artifacts.mjs', 'c7fd3a52e296ef311e230a13d9a8d96039bad621'],
    ['.github/scripts/download-release-artifacts.py', 'dc8ca25a9548af1098ec63bb4e6a95f27114826e'],
    ['.github/scripts/stage-release-artifacts.py', 'c92c5d2e83f677f675128edb6ad16d0dcacc588c'],
    ['.github/scripts/verify-version-at-commit.mjs', '7e26a075d94f0e6840a676585c9b65029284f633'],
    ['.github/scripts/verify-release-assets.mjs', '24f704391248e8fd2da01ad73b279fb3ad2e203f'],
    ['.github/scripts/release-commit-notes.mjs', '37a37e58593055947daab2c58f8e747455389960'],
  ]);
  for (const [path, expected] of trustedFiles) {
    const entries = headTree.filter(entry => entry?.path === path);
    if (entries.length !== 1 || entries[0].type !== 'blob' || entries[0].mode !== '100644' ||
        entries[0].sha !== expected) throw new Error('A release provenance helper changed: ' + path);
  }
  await ref();
  return { ...candidate, sourceCurrentlyAuthorized };
}
