// OpenAI-Codex_health_release_architecture: safely reconcile merged patch tags and their releases.
import { assertTagProtection } from './verify-tag-protection.mjs';
import { inspectMergedPatch } from './inspect-merged-patch.mjs';
import { requiredPushChecks } from './patch-push-checks.mjs';
import { verifyPublishedPatch } from './verify-published-patch.mjs';

const FULL = 'KingsleyHK0323/Multimedia_Downloader';
const SHA = /^[0-9a-f]{40}$/;
const BOT = 'kingsley-multimedia-automation[bot]';
const positive = value => Number.isSafeInteger(value) && value > 0;

export async function reconcilePatchReleases({ github, app, context, appSlug, workflowSha, anchorPrNumber }) {
  const { owner, repo } = context.repo || {};
  if (owner + '/' + repo !== FULL || context.ref !== 'refs/heads/Source_Code' ||
      appSlug !== 'kingsley-multimedia-automation' || !SHA.test(workflowSha || '') ||
      !positive(anchorPrNumber)) {
    throw new Error('Patch release finalizer context is invalid.');
  }
  const info = (await app.request('GET /apps/{app_slug}', { app_slug: appSlug })).data;
  const bot = (await app.rest.users.getByUsername({ username: BOT })).data;
  const repository = (await app.rest.repos.get({ owner, repo })).data;
  if (info?.id !== 5868451 || info.slug !== appSlug || bot?.id !== 359694872 ||
      bot.login !== BOT || bot.type !== 'Bot' || repository?.id !== 1251103365 ||
      repository.full_name !== FULL || repository.fork !== false) throw new Error('Patch App identity is invalid.');
  const sourceRef = async () => {
    const d = (await github.rest.git.getRef({ owner, repo, ref: 'heads/Source_Code' })).data;
    if (d?.ref !== 'refs/heads/Source_Code' || d.object?.type !== 'commit' || d.object.sha !== workflowSha) {
      throw new Error('Source_Code changed during patch release reconciliation.');
    }
  };
  const tagProtection = async () => {
    const d = (await app.request('GET /repos/{owner}/{repo}/rulesets/{ruleset_id}', {
      owner, repo, ruleset_id: 27823531, includes_parents: true,
    })).data;
    assertTagProtection(d, FULL);
  };
  const readTag = async tag => {
    let ref;
    try { ref = (await github.rest.git.getRef({ owner, repo, ref: 'tags/' + tag })).data; }
    catch (error) { if (error?.status === 404) return null; throw error; }
    if (ref?.ref !== 'refs/tags/' + tag) throw new Error('Version tag ref is invalid.');
    let object = ref.object;
    const seen = new Set();
    for (let depth = 0; depth < 8 && object?.type === 'tag'; depth++) {
      if (!SHA.test(object.sha || '') || seen.has(object.sha)) throw new Error('Annotated tag chain is invalid.');
      seen.add(object.sha);
      object = (await github.rest.git.getTag({ owner, repo, tag_sha: object.sha })).data.object;
    }
    if (object?.type !== 'commit' || !SHA.test(object.sha || '')) throw new Error('Version tag target is invalid.');
    return object.sha;
  };
  const readRelease = async tag => {
    try { return (await github.rest.repos.getReleaseByTag({ owner, repo, tag })).data; }
    catch (error) { if (error?.status === 404) return null; throw error; }
  };
  const trustedTagRun = async candidate => {
    const data = (await github.rest.actions.listWorkflowRunsForRepo({
      owner, repo, event: 'push', head_sha: candidate.head, per_page: 100,
    })).data;
    if (!data || !Number.isSafeInteger(data.total_count) || data.total_count < 0 || data.total_count > 100 ||
        !Array.isArray(data.workflow_runs) || data.workflow_runs.length !== data.total_count) {
      throw new Error('Tag-push release runs are incomplete.');
    }
    const runs = data.workflow_runs.filter(run => run?.path === '.github/workflows/release.yml' &&
      run.head_sha === candidate.head && run.head_branch === candidate.tag);
    if (runs.length > 1) throw new Error('Tag-push release runs are ambiguous.');
    if (!runs.length) return null;
    const run = runs[0];
    if (!positive(run.id) || run.workflow_id !== 315481913 || run.event !== 'push' ||
        run.actor?.id !== 359694872 || run.actor.login !== BOT || run.actor.type !== 'Bot' ||
        run.repository?.id !== 1251103365 || run.repository.full_name !== FULL ||
        run.head_repository?.id !== 1251103365 || run.head_repository.full_name !== FULL) {
      throw new Error('Tag-push release run identity is invalid.');
    }
    if (run.status !== 'completed' && !['queued', 'in_progress', 'waiting', 'requested', 'pending'].includes(run.status)) {
      throw new Error('Tag-push release run status is unknown.');
    }
    if ((run.status === 'completed' && typeof run.conclusion !== 'string') ||
        (run.status !== 'completed' && run.conclusion !== null)) {
      throw new Error('Tag-push release run conclusion is incomplete.');
    }
    return run;
  };
  await sourceRef();
  const prs = await github.paginate(github.rest.pulls.list, {
    owner, repo, state: 'closed', base: 'Source_Code', head: owner + ':automation/protected-workflows', per_page: 100,
  });
  if (!Array.isArray(prs) || prs.length > 1000) throw new Error('Closed service PR inventory is incomplete.');
  const relevant = prs.filter(pr => pr?.user?.id === 359694872 &&
    typeof pr.body === 'string' && pr.body.includes('<!-- automatic-patch-source:'));
  if (relevant.some(pr => !positive(pr.number) || typeof pr.merged_at !== 'string' ||
      !Number.isFinite(Date.parse(pr.merged_at)))) {
    throw new Error('A version PR was closed without a verifiable merge; preserve it for review.');
  }
  relevant.sort((a, b) => Date.parse(a.merged_at) - Date.parse(b.merged_at) || a.number - b.number);
  const completed = [], skipped = [];
  for (const pr of relevant) {
    const inspect = () => inspectMergedPatch({ github, context, workflowSha, anchorPrNumber, versionPrNumber: pr.number });
    const candidate = await inspect();
    await tagProtection();
    const target = await readTag(candidate.tag);
    if (target !== null && target !== candidate.head) {
      throw new Error('Existing version tag points to a different commit; preserve it for review.');
    }
    if (target === null) {
      if (!candidate.sourceCurrentlyAuthorized) {
        const stable = await inspect();
        if (JSON.stringify(candidate) !== JSON.stringify(stable) || await readTag(candidate.tag) !== null) {
          throw new Error('Withdrawn source or its tag changed during reconciliation.');
        }
        skipped.push(candidate.source);
        continue;
      }
      const checks = await requiredPushChecks(github, {
        owner, repo, head: candidate.head, branch: 'Source_Code',
      });
      if (checks === null) return { status: 'waiting-for-source-checks', pr: pr.number, completed };
      const current = await inspect();
      const checksAgain = await requiredPushChecks(github, { owner, repo, head: candidate.head, branch: 'Source_Code' });
      if (JSON.stringify(candidate) !== JSON.stringify(current) ||
          JSON.stringify(checks) !== JSON.stringify(checksAgain)) {
        throw new Error('Merged candidate or Source_Code push checks changed before tag creation.');
      }
      const latest = await inspect();
      if (!latest.sourceCurrentlyAuthorized) {
        if (await readTag(candidate.tag) !== null) throw new Error('The tag changed during source withdrawal.');
        skipped.push(candidate.source);
        continue;
      }
      if (JSON.stringify(latest) !== JSON.stringify(candidate)) {
        throw new Error('Merged candidate changed immediately before tag creation.');
      }
      await tagProtection(); await sourceRef();
      let created;
      try {
        created = (await app.rest.git.createRef({
          owner, repo, ref: 'refs/tags/' + candidate.tag, sha: candidate.head,
        })).data;
      } catch (error) {
        if (error?.status !== 422 || await readTag(candidate.tag) !== candidate.head) throw error;
      }
      if (created && (created.ref !== 'refs/tags/' + candidate.tag ||
          created.object?.type !== 'commit' || created.object.sha !== candidate.head)) {
        throw new Error('Create-only version tag response is invalid.');
      }
      if (await readTag(candidate.tag) !== candidate.head) throw new Error('Version tag creation was not confirmed.');
      return { status: 'tag-created', tag: candidate.tag, head: candidate.head, pr: pr.number, completed };
    }
    const release = await readRelease(candidate.tag);
    if (release === null) {
      const run = await trustedTagRun(candidate);
      if (run?.status === 'completed') {
        throw new Error(run.conclusion === 'success'
          ? 'Release workflow succeeded but no release exists.'
          : 'Release workflow failed; preserve its state for review.');
      }
      return { status: 'waiting-for-release-run', tag: candidate.tag, pr: pr.number, completed };
    }
    if (!positive(release?.id) || release.tag_name !== candidate.tag || typeof release.draft !== 'boolean') {
      throw new Error('Release metadata is incomplete.');
    }
    if (release.draft) {
      const run = await trustedTagRun(candidate);
      if (run && run.status !== 'completed') {
        return { status: 'waiting-for-release-run', tag: candidate.tag, pr: pr.number, completed };
      }
      return { status: 'draft-requires-review', tag: candidate.tag, pr: pr.number, completed };
    }
    const proof = await verifyPublishedPatch({ github, owner, repo, tag: candidate.tag, commit: candidate.head, release });
    if (proof === null) return { status: 'waiting-for-publication-proof', tag: candidate.tag, pr: pr.number, completed };
    const current = await inspect();
    const afterRelease = await readRelease(candidate.tag);
    const afterProof = await verifyPublishedPatch({ github, owner, repo, tag: candidate.tag, commit: candidate.head,
      release: afterRelease });
    if (JSON.stringify(current) !== JSON.stringify(candidate) || await readTag(candidate.tag) !== candidate.head ||
        JSON.stringify(release) !== JSON.stringify(afterRelease) || JSON.stringify(proof) !== JSON.stringify(afterProof)) {
      throw new Error('Published release or its provenance changed during verification.');
    }
    completed.push(candidate.source);
  }
  return { status: 'ready', completed, skipped };
}
