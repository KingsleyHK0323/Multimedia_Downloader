// OpenAI-Codex_health_release_architecture: update only Source_Code after verified App push checks.
import { createHash } from 'node:crypto';
import { ANCHOR_PATH, ANCHOR_CONTENT, currentPatchLabel, labelAtMerge, utcSecond } from './patch-source-authorization.mjs';
import { validateSourcePr, VERSION_PATHS } from './patch-release-policy.mjs';
import { validatePatchCandidate } from './patch-candidate-policy.mjs';
import { sourceRulesSnapshot, requiredPushChecks } from './patch-push-checks.mjs';

const REPO = 'KingsleyHK0323/Multimedia_Downloader';
const REPO_ID = 1251103365;
const TEMP = 'automation/protected-workflows';
const BOT = 'kingsley-multimedia-automation[bot]';
const SHA = /^[0-9a-f]{40}$/;
const blobHash = bytes => createHash('sha1')
  .update(Buffer.concat([Buffer.from('blob ' + bytes.length + '\0'), bytes])).digest('hex');

export async function reconcilePatchCas({ github, app, context, appSlug, workflowSha, anchorPrNumber }) {
  const { owner, repo } = context.repo || {};
  if (owner + '/' + repo !== REPO || context.ref !== 'refs/heads/Source_Code' ||
      appSlug !== 'kingsley-multimedia-automation' || !SHA.test(workflowSha || '') ||
      !Number.isSafeInteger(anchorPrNumber) || anchorPrNumber < 1) {
    throw new Error('Unexpected patch coordinator context.');
  }
  const appInfo = (await app.request('GET /apps/{app_slug}', { app_slug: appSlug })).data;
  const bot = (await app.rest.users.getByUsername({ username: BOT })).data;
  if (appInfo?.id !== 5868451 || appInfo.slug !== appSlug ||
      bot?.id !== 359694872 || bot.login !== BOT || bot.type !== 'Bot') {
    throw new Error('Patch automation App identity cannot be verified.');
  }
  const ref = async branch => {
    const data = (await github.rest.git.getRef({ owner, repo, ref: 'heads/' + branch })).data;
    if (data?.ref !== 'refs/heads/' + branch || data.object?.type !== 'commit' ||
        !SHA.test(data.object.sha || '')) throw new Error('Branch ref is incomplete.');
    return data.object.sha;
  };
  const commit = async sha => {
    if (!SHA.test(sha || '')) throw new Error('Invalid commit SHA.');
    const data = (await github.rest.git.getCommit({ owner, repo, commit_sha: sha })).data;
    if (data?.sha !== sha || !SHA.test(data.tree?.sha || '') || !Array.isArray(data.parents) ||
        data.parents.some(parent => !SHA.test(parent?.sha || ''))) {
      throw new Error('Commit metadata is incomplete.');
    }
    return data;
  };
  const tree = async sha => {
    const data = (await github.rest.git.getTree({ owner, repo, tree_sha: sha, recursive: 'true' })).data;
    if (data?.sha !== sha || data.truncated !== false || !Array.isArray(data.tree) ||
        data.tree.length > 100000) throw new Error('Git tree inventory is incomplete.');
    return data.tree;
  };
  const readFiles = async items => {
    const byPath = new Map();
    for (const item of items) {
      if (!item || typeof item.path !== 'string' || byPath.has(item.path)) {
        throw new Error('Base tree contains an ambiguous path.');
      }
      byPath.set(item.path, item);
    }
    const result = {};
    let total = 0;
    for (const path of VERSION_PATHS) {
      const entry = byPath.get(path);
      if (entry?.type !== 'blob' || entry.mode !== '100644' || !SHA.test(entry.sha || '') ||
          !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 5_000_000) {
        throw new Error('Version source entry is incomplete: ' + path);
      }
      total += entry.size;
      if (total > 20_000_000) throw new Error('Version source files are too large.');
      const data = (await github.rest.git.getBlob({ owner, repo, file_sha: entry.sha })).data;
      if (data?.sha !== entry.sha || data.encoding !== 'base64' || data.size !== entry.size ||
          typeof data.content !== 'string') throw new Error('Git blob metadata is incomplete.');
      const encoded = data.content.replace(/\s/g, '');
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
        throw new Error('Git blob encoding is invalid.');
      }
      const bytes = Buffer.from(encoded, 'base64');
      if (bytes.toString('base64') !== encoded || bytes.length !== entry.size ||
          blobHash(bytes) !== entry.sha || bytes.includes(0)) throw new Error('Git blob bytes are invalid.');
      result[path] = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (!Buffer.from(result[path], 'utf8').equals(bytes)) throw new Error('Git blob is not canonical UTF-8.');
    }
    return result;
  };
  const validateAnchor = async base => {
    const pr = (await github.rest.pulls.get({ owner, repo, pull_number: anchorPrNumber })).data;
    if (pr?.number !== anchorPrNumber || pr.state !== 'closed' || pr.merged !== true ||
        pr.user?.id !== 157894869 || pr.base?.ref !== 'Source_Code' ||
        pr.base?.repo?.id !== REPO_ID || pr.base.repo.full_name !== REPO ||
        pr.head?.ref !== TEMP || pr.head?.repo?.id !== REPO_ID || pr.head.repo.full_name !== REPO ||
        !SHA.test(pr.merge_commit_sha || '')) throw new Error('Approved migration anchor is invalid.');
    const anchorTime = utcSecond(pr.merged_at);
    const anchor = await commit(pr.merge_commit_sha);
    const marker = (await tree(anchor.tree.sha)).filter(item => item?.path === ANCHOR_PATH);
    if (marker.length !== 1 || marker[0].type !== 'blob' || marker[0].mode !== '100644' ||
        marker[0].sha !== blobHash(Buffer.from(ANCHOR_CONTENT, 'utf8'))) {
      throw new Error('Approved migration marker is invalid.');
    }
    let cursor = base;
    const seen = new Set();
    while (cursor !== pr.merge_commit_sha) {
      if (seen.has(cursor) || seen.size >= 10000) throw new Error('Anchor first-parent history is incomplete.');
      seen.add(cursor);
      const current = await commit(cursor);
      if (!current.parents.length) throw new Error('Anchor is not in Source_Code first-parent history.');
      cursor = current.parents[0].sha;
    }
    return anchorTime;
  };
  const open = await github.paginate(github.rest.pulls.list, {
    owner, repo, state: 'open', head: owner + ':' + TEMP, base: 'Source_Code', per_page: 100,
  });
  if (!Array.isArray(open) || open.length > 1) throw new Error('Service branch PR listing is ambiguous.');
  if (open.length === 0) return { status: 'idle' };
  const initial = open[0];
  if (!Number.isSafeInteger(initial?.number) || initial.number < 1 || initial.user?.id !== 359694872 ||
      typeof initial.body !== 'string') return { status: 'service-branch-busy' };
  const markerPattern = /^<!-- automatic-patch-source:([1-9][0-9]*):([0-9a-f]{40}) -->$/gm;
  const markers = [...initial.body.matchAll(markerPattern)];
  if (markers.length === 0 && !initial.body.includes('automatic-patch-source:')) {
    return { status: 'service-branch-busy' };
  }
  if (markers.length !== 1) throw new Error('Patch source marker is incomplete or ambiguous.');
  const sourceNumber = Number(markers[0][1]);
  if (!Number.isSafeInteger(sourceNumber) || sourceNumber < 1) throw new Error('Patch source PR number is invalid.');
  const inspect = async () => {
    const headPrs = await github.paginate(github.rest.pulls.list, {
      owner, repo, state: 'open', head: owner + ':' + TEMP, per_page: 100,
    });
    const basePrs = await github.paginate(github.rest.pulls.list, {
      owner, repo, state: 'open', base: TEMP, per_page: 100,
    });
    if (!Array.isArray(headPrs) || headPrs.length !== 1 || headPrs[0]?.number !== initial.number ||
        !Array.isArray(basePrs) || basePrs.length !== 0) {
      throw new Error('Service branch is used by another or ambiguous PR.');
    }
    const base = await ref('Source_Code');
    if (base !== workflowSha) throw new Error('Source_Code advanced beyond the trusted workflow revision.');
    const [versionPrResponse, sourceResponse] = await Promise.all([
      github.rest.pulls.get({ owner, repo, pull_number: initial.number }),
      github.rest.pulls.get({ owner, repo, pull_number: sourceNumber }),
    ]);
    const versionPr = versionPrResponse.data, source = sourceResponse.data;
    const sourceId = validateSourcePr(source);
    if (sourceId.mergeSha !== markers[0][2] || source.number !== sourceNumber) {
      throw new Error('Source PR changed or no longer matches the marker.');
    }
    const anchorTime = await validateAnchor(base);
    if (utcSecond(source.merged_at) <= anchorTime) throw new Error('Source PR predates the migration anchor.');
    const events = await github.paginate(github.rest.issues.listEventsForTimeline, {
      owner, repo, issue_number: sourceNumber, per_page: 100,
    });
    const authorization = await labelAtMerge(events, source.merged_at, sourceId.mergeSha, github, sourceNumber);
    if (!authorization.atMerge || authorization.withdrawnAfterMerge || !currentPatchLabel(source)) {
      throw new Error('Source PR patch authorization is no longer active.');
    }
    const ancestry = (await github.rest.repos.compareCommits({
      owner, repo, base: sourceId.mergeSha, head: base,
    })).data;
    if (ancestry?.merge_base_commit?.sha !== sourceId.mergeSha || ancestry.behind_by !== 0 ||
        !['ahead', 'identical'].includes(ancestry.status)) {
      throw new Error('Source PR merge is not in current Source_Code history.');
    }
    const head = await ref(TEMP);
    if (versionPr?.number !== initial.number || versionPr.head?.sha !== head) {
      throw new Error('Version PR or service ref changed.');
    }
    const [baseCommit, headCommit, details] = await Promise.all([
      commit(base), commit(head), github.rest.repos.getCommit({ owner, repo, ref: head }),
    ]);
    const [baseTree, headTree, changedFiles] = await Promise.all([
      tree(baseCommit.tree.sha), tree(headCommit.tree.sha),
      github.paginate(github.rest.pulls.listFiles, { owner, repo, pull_number: initial.number, per_page: 100 }),
    ]);
    const files = await readFiles(baseTree);
    const candidate = validatePatchCandidate({ source, versionPr, base, headCommit,
      signedCommit: details.data, baseTree, headTree, files, changedFiles });
    if (await ref('Source_Code') !== base || await ref(TEMP) !== head) {
      throw new Error('Version refs changed during verification.');
    }
    return candidate;
  };
  const first = await inspect();
  const firstRules = await sourceRulesSnapshot(app, { owner, repo });
  const firstChecks = await requiredPushChecks(github, { owner, repo, head: first.head, branch: TEMP });
  if (firstChecks === null) return { status: 'waiting-for-checks', pr: first.versionPr, head: first.head };
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await inspect();
    const rules = await sourceRulesSnapshot(app, { owner, repo });
    const checks = await requiredPushChecks(github, { owner, repo, head: first.head, branch: TEMP });
    if (JSON.stringify(current) !== JSON.stringify(first) ||
        JSON.stringify(rules) !== JSON.stringify(firstRules) ||
        JSON.stringify(checks) !== JSON.stringify(firstChecks)) {
      throw new Error('Patch candidate, rules, or check evidence changed before update.');
    }
  }
  const mutation = 'patch-' + first.versionPr + '-' + first.head;
  const updated = await app.graphql(
    'mutation($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }',
    { input: { repositoryId: firstRules.nodeId, clientMutationId: mutation,
      refUpdates: [{ name: 'refs/heads/Source_Code', beforeOid: first.base, afterOid: first.head, force: false }] } },
  );
  if (updated?.updateRefs?.clientMutationId !== mutation || await ref('Source_Code') !== first.head) {
    throw new Error('The exact checked Source_Code update was not confirmed.');
  }
  return { status: 'updated-needs-source-checks', ...first };
}
