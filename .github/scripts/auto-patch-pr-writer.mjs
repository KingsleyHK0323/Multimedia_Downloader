// OpenAI-Codex_health_release_architecture: reconcile one fixed-branch version PR from verified Git objects.
import { createHash } from 'node:crypto';
import { assertTagProtection } from './verify-tag-protection.mjs';
import { ANCHOR_PATH, ANCHOR_CONTENT, currentPatchLabel, labelAtMerge, utcSecond } from './patch-source-authorization.mjs';
import { planVersion, validateSourcePr, validateVersionPr, versionBranch, VERSION_PATHS } from './patch-release-policy.mjs';

const REPO = 'KingsleyHK0323/Multimedia_Downloader';
const BASE = 'Source_Code';
const APP_ID = 5868451;
const BOT_ID = 359694872;
const BOT_LOGIN = 'kingsley-multimedia-automation[bot]';
const SHA = /^[0-9a-f]{40}$/;
const BRANCH = /^automation\/protected-workflows$/;
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const MARKER = /^Automatic patch release for merged PR #([1-9][0-9]*)$/gm;
const MAX_FILE = 5_000_000;

function fail(message) { throw new Error(message); }
function isSha(value) { return typeof value === 'string' && SHA.test(value); }
function blobHash(bytes) {
  return createHash('sha1').update(Buffer.concat([Buffer.from('blob ' + bytes.length + '\0'), bytes])).digest('hex');
}
function dateHongKong(now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).map(item => [item.type, item.value]));
  return parts.year + '-' + parts.month + '-' + parts.day;
}
function commitMessage(plan, source, date) {
  return 'chore: release ' + plan.tag + ' after PR #' + source.number + '\n\n' +
    'Automatic patch release for merged PR #' + source.number + '\n' +
    'Patch-Source-SHA: ' + source.mergeSha + '\n' +
    'Patch-Plan-Date: ' + date + '\n' +
    'OpenAI-Codex_health_release_architecture';
}
function parseCommitMessage(message, source) {
  if (typeof message !== 'string') fail('Version commit message is missing.');
  const lines = message.trimEnd().split('\n');
  const first = /^chore: release (v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)) after PR #([1-9][0-9]*)$/.exec(lines[0]);
  const dateLines = lines.filter(line => line.startsWith('Patch-Plan-Date: '));
  if (!first || Number(first[2]) !== source.number || dateLines.length !== 1 ||
      !DATE.test(dateLines[0].slice('Patch-Plan-Date: '.length)) ||
      lines.filter(line => line === 'Automatic patch release for merged PR #' + source.number).length !== 1 ||
      lines.filter(line => line === 'Patch-Source-SHA: ' + source.mergeSha).length !== 1) {
    fail('Version branch provenance is invalid.');
  }
  return { tag: first[1], date: dateLines[0].slice('Patch-Plan-Date: '.length) };
}

export async function reconcileVersionPr({ github, app, context, appSlug, workflowSha = '', anchorPrNumber = 0, requestedSource = null, verifiedCompleted = [], verifiedSkipped = [], now = new Date() }) {
  if (!Array.isArray(verifiedCompleted) || verifiedCompleted.length > 1000 ||
      verifiedCompleted.some(number => !Number.isSafeInteger(number) || number < 1) ||
      new Set(verifiedCompleted).size !== verifiedCompleted.length || !Array.isArray(verifiedSkipped) ||
      verifiedSkipped.length > 1000 || verifiedSkipped.some(number => !Number.isSafeInteger(number) || number < 1) ||
      new Set(verifiedSkipped).size !== verifiedSkipped.length ||
      verifiedSkipped.some(number => verifiedCompleted.includes(number))) fail('Verified release set is invalid.');
  if (!Number.isSafeInteger(anchorPrNumber) || anchorPrNumber < 1) fail('A verified migration anchor PR is required.');
  if (requestedSource !== null && (!Number.isSafeInteger(requestedSource) || requestedSource < 1)) {
    fail('Invalid requested source PR number.');
  }
  const { owner, repo } = context.repo || {};
  if (owner + '/' + repo !== REPO || context.ref !== 'refs/heads/' + BASE ||
      appSlug !== 'kingsley-multimedia-automation') fail('Unexpected repository, ref, or App.');
  const application = (await app.request('GET /apps/{app_slug}', { app_slug: appSlug })).data;
  const bot = (await app.rest.users.getByUsername({ username: BOT_LOGIN })).data;
  const repository = (await app.rest.repos.get({ owner, repo })).data;
  if (application?.id !== APP_ID || application?.slug !== appSlug ||
      bot?.id !== BOT_ID || bot?.login !== BOT_LOGIN || bot?.type !== 'Bot' ||
      repository?.id !== 1251103365 || repository.full_name !== REPO ||
      typeof repository.node_id !== 'string' || repository.fork !== false) fail('App or repository identity mismatch.');

  let reportedHiddenBypassActors = false;
  const ensureTagProtection = async () => {
    if (await getRef(BASE) !== workflowSha) fail('Automation workflow revision is no longer the Source_Code tip.');
    const response = (await app.request('GET /repos/{owner}/{repo}/rulesets/{ruleset_id}', {
      owner, repo, ruleset_id: 27823531, includes_parents: true,
    })).data;
    const result = assertTagProtection(response, REPO);
    if (!result.bypassActorsVisible && !reportedHiddenBypassActors) {
      console.log('::notice::Other actors with tag-rule bypass are not visible to this token.');
      reportedHiddenBypassActors = true;
    }
  };
  const getRef = async branch => {
    try {
      const data = (await github.rest.git.getRef({ owner, repo, ref: 'heads/' + branch })).data;
      if (data.ref !== 'refs/heads/' + branch || data.object?.type !== 'commit' ||
          !isSha(data.object.sha)) fail('Invalid branch ref.');
      return data.object.sha;
    } catch (error) {
      if (error.status === 404 && branch !== BASE) return null;
      throw error;
    }
  };
  const getCommit = async sha => {
    if (!isSha(sha)) fail('Invalid commit SHA.');
    const commit = (await github.rest.git.getCommit({ owner, repo, commit_sha: sha })).data;
    if (commit?.sha !== sha || !isSha(commit.tree?.sha) || !Array.isArray(commit.parents) ||
        commit.parents.some(parent => !isSha(parent.sha))) fail('Incomplete Git commit.');
    return commit;
  };
  const getTree = async treeSha => {
    const tree = (await github.rest.git.getTree({ owner, repo, tree_sha: treeSha, recursive: 'true' })).data;
    if (tree?.sha !== treeSha || tree.truncated !== false || !Array.isArray(tree.tree) ||
        tree.tree.length > 100_000) fail('Incomplete Git tree.');
    const entries = new Map();
    for (const item of tree.tree) {
      if (typeof item?.path !== 'string' || !item.path || entries.has(item.path) ||
          !['blob', 'tree', 'commit'].includes(item.type) || !isSha(item.sha) ||
          typeof item.mode !== 'string') fail('Ambiguous Git tree.');
      entries.set(item.path, item);
    }
    return entries;
  };
  const readFiles = async entries => {
    const files = {};
    let total = 0;
    for (const path of VERSION_PATHS) {
      const entry = entries.get(path);
      if (!entry || entry.type !== 'blob' || entry.mode !== '100644' ||
          !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_FILE) {
        fail('A version path is missing or unsafe: ' + path);
      }
      total += entry.size;
      if (total > 20_000_000) fail('Version files exceed the size limit.');
      const blob = (await github.rest.git.getBlob({ owner, repo, file_sha: entry.sha })).data;
      if (blob?.sha !== entry.sha || blob.encoding !== 'base64' ||
          blob.size !== entry.size || typeof blob.content !== 'string') fail('Invalid Git blob metadata.');
      const encoded = blob.content.replace(/\s/g, '');
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
        fail('Invalid Git blob encoding.');
      }
      const bytes = Buffer.from(encoded, 'base64');
      if (bytes.toString('base64') !== encoded || bytes.length !== entry.size ||
          blobHash(bytes) !== entry.sha || bytes.includes(0)) fail('Git blob verification failed.');
      files[path] = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (!Buffer.from(files[path], 'utf8').equals(bytes)) fail('Version file is not canonical UTF-8.');
    }
    return files;
  };
  const planFor = async (base, source, date) => {
    const commit = await getCommit(base);
    const tree = await getTree(commit.tree.sha);
    const plan = planVersion(await readFiles(tree), source.number, date);
    return { commit, tree, plan };
  };
  const verifyTree = async (baseTree, changedTreeSha, plan) => {
    const changed = await getTree(changedTreeSha);
    if (changed.size !== baseTree.size) fail('Version tree changed the path inventory.');
    for (const [path, before] of baseTree) {
      const after = changed.get(path);
      if (!after || after.type !== before.type || after.mode !== before.mode) {
        fail('Version tree changed a path or file mode.');
      }
      if (VERSION_PATHS.includes(path)) {
        const expected = Buffer.from(plan.updates[path], 'utf8');
        if (after.type !== 'blob' || after.mode !== '100644' || after.sha !== blobHash(expected)) {
          fail('Version tree has unexpected bytes: ' + path);
        }
      } else if (before.type !== 'tree' && after.sha !== before.sha) {
        fail('Version tree changed an unrelated object.');
      }
    }
  };
  const inspectBranchCommit = async (head, source) => {
    const verified = (await github.rest.repos.getCommit({ owner, repo, ref: head })).data;
    if (verified?.sha !== head || verified.author?.id !== BOT_ID ||
        verified.author?.login !== BOT_LOGIN || verified.author?.type !== 'Bot' ||
        verified.committer?.id !== 19864447 || verified.committer?.login !== 'web-flow' ||
        verified.committer?.type !== 'User' || verified.commit?.verification?.verified !== true ||
        verified.commit.verification.reason !== 'valid') {
      fail('Version commit is not a verified automation App commit.');
    }
    const commit = await getCommit(head);
    if (commit.parents.length !== 1) fail('Version commit must have one parent.');
    const previousBase = commit.parents.at(-1).sha;
    const info = parseCommitMessage(commit.message, source);
    const data = await planFor(previousBase, source, info.date);
    if (data.plan.tag !== info.tag || commit.message.trimEnd() !== commitMessage(data.plan, source, info.date)) {
      fail('Version commit is not the expected deterministic update.');
    }
    await verifyTree(data.tree, commit.tree.sha, data.plan);
    return { previousBase, date: info.date, plan: data.plan };
  };
  const buildCommit = async (source, date, base) => {
    const { commit, tree, plan } = await planFor(base, source, date);
    await ensureTagProtection();
    const created = (await app.rest.git.createTree({
      owner, repo, base_tree: commit.tree.sha,
      tree: VERSION_PATHS.map(path => ({ path, mode: '100644', type: 'blob', content: plan.updates[path] })),
    })).data;
    if (!isSha(created?.sha)) fail('Version tree creation failed.');
    await verifyTree(tree, created.sha, plan);
    const parents = [base];
    await ensureTagProtection();
    const result = (await app.rest.git.createCommit({
      owner, repo, message: commitMessage(plan, source, date), tree: created.sha, parents,
    })).data;
    if (!isSha(result?.sha) || result.tree?.sha !== created.sha ||
        !Array.isArray(result.parents) || result.parents.map(x => x.sha).join(',') !== parents.join(',')) {
      fail('Version commit response is invalid.');
    }
    await inspectBranchCommit(result.sha, source);
    return result.sha;
  };
  const prState = async (number, source, expectedHead) => {
    const pr = (await github.rest.pulls.get({ owner, repo, pull_number: number })).data;
    validateVersionPr(pr, source);
    if (pr.state !== 'open' || pr.head.sha !== expectedHead ||
        pr.user.login !== BOT_LOGIN || pr.user.type !== 'Bot') fail('Version PR changed or was closed.');
    return pr;
  };

  const base = await getRef(BASE);
  if (!isSha(workflowSha) || workflowSha !== base) fail('Automation workflow revision is not the current Source_Code tip.');
  const anchor = (await github.rest.pulls.get({ owner, repo, pull_number: anchorPrNumber })).data;
  if (!anchor || anchor.number !== anchorPrNumber || anchor.state !== 'closed' || anchor.merged !== true ||
      anchor.user?.id !== 157894869 || anchor.base?.ref !== BASE ||
      anchor.base?.repo?.full_name !== REPO || anchor.head?.repo?.full_name !== REPO ||
      anchor.head?.ref !== 'automation/protected-workflows' || !isSha(anchor.merge_commit_sha)) {
    fail('Migration anchor PR is not the approved merged automation change.');
  }
  const anchorTime = utcSecond(anchor.merged_at);
  const anchorCommit = await getCommit(anchor.merge_commit_sha);
  const anchorTree = await getTree(anchorCommit.tree.sha);
  const markerEntry = anchorTree.get(ANCHOR_PATH);
  if (!markerEntry || markerEntry.type !== 'blob' || markerEntry.mode !== '100644' ||
      markerEntry.sha !== blobHash(Buffer.from(ANCHOR_CONTENT, 'utf8'))) {
    fail('Migration anchor does not contain the immutable opt-in marker.');
  }
  const anchorAncestry = (await github.rest.repos.compareCommits({
    owner, repo, base: anchor.merge_commit_sha, head: base,
  })).data;
  if (anchorAncestry?.merge_base_commit?.sha !== anchor.merge_commit_sha ||
      anchorAncestry.behind_by !== 0 || !['ahead', 'identical'].includes(anchorAncestry.status)) {
    fail('Migration anchor is no longer in Source_Code history.');
  }
  const sourceAuthorized = async source => {
    const identity = validateSourcePr(source);
    if (utcSecond(source.merged_at) <= anchorTime) return false;
    const events = await github.paginate(github.rest.issues.listEventsForTimeline, {
      owner, repo, issue_number: source.number, per_page: 100,
    });
    const auth = await labelAtMerge(events, source.merged_at, identity.mergeSha, github, source.number);
    return auth.atMerge && !auth.withdrawnAfterMerge && currentPatchLabel(source);
  };
  const pulls = await github.paginate(github.rest.pulls.list, { owner, repo, state: 'all', per_page: 100 });
  if (!Array.isArray(pulls) || pulls.length > 1000) fail('PR history exceeds the reconciliation limit.');
  const commits = [];
  const visited = new Set();
  let cursor = base;
  while (cursor !== anchor.merge_commit_sha) {
    if (commits.length >= 10_000 || visited.has(cursor)) fail('First-parent history is incomplete or too long.');
    visited.add(cursor);
    const commit = await getCommit(cursor);
    if (!commit.parents.length) fail('Migration anchor is not in Source_Code first-parent history.');
    commits.push({ sha: cursor, commit: { message: commit.message } });
    cursor = commit.parents[0].sha;
  }
  const completed = new Set();
  const pendingTags = [];
  for (const item of commits) {
    const message = item?.commit?.message;
    if (!isSha(item?.sha) || typeof message !== 'string') fail('Incomplete commit history.');
    const matches = [...message.matchAll(MARKER)];
    if (!matches.length) continue;
    const subject = /^(?:chore: release) (v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)) after PR #([1-9][0-9]*)$/.exec(message.split('\n')[0]);
    if (!subject || matches.length !== 1 || matches[0][1] !== subject[2]) continue;
    const number = Number(subject[2]);
    const associated = await github.paginate(github.rest.repos.listPullRequestsAssociatedWithCommit, {
      owner, repo, commit_sha: item.sha, per_page: 100,
    });
    if (!Array.isArray(associated) || associated.length > 1000) fail('Commit PR associations are incomplete.');
    const introducing = associated.filter(pr => pr?.merge_commit_sha === item.sha);
    if (introducing.length > 1) fail('Release commit has ambiguous PR provenance.');
    let appVersionPr = false;
    if (introducing.length === 1) {
      const introduced = introducing[0];
      if (introduced.user?.id !== BOT_ID || introduced.head?.ref !== versionBranch(number) ||
          introduced.base?.ref !== BASE || introduced.base?.repo?.full_name !== REPO) continue;
      appVersionPr = true;
    } else {
      const verified = (await github.rest.repos.getCommit({ owner, repo, ref: item.sha })).data;
      if (!verified || verified.sha !== item.sha || !verified.author ||
          !Number.isSafeInteger(verified.author.id)) fail('Historical commit author is unavailable.');
      if (verified.author.id !== 41898282 || verified.author.login !== 'github-actions[bot]') continue;
    }
    const historicalSource = pulls.find(pr => pr?.number === number);
    if (!historicalSource || !historicalSource.merged_at || utcSecond(historicalSource.merged_at) <= anchorTime) continue;
    const tag = subject[1];
    if (!Number.isSafeInteger(number) || tag.length > 51) fail('Invalid historical release marker.');
    let object;
    try {
      const ref = (await github.rest.git.getRef({ owner, repo, ref: 'tags/' + tag })).data;
      if (ref?.ref !== 'refs/tags/' + tag) fail('Unexpected historical tag ref.');
      object = ref.object;
    } catch (error) {
      if (error.status !== 404) throw error;
      if (!appVersionPr) fail('Legacy release ' + tag + ' has no tag; verify its release state before migration.');
      if (verifiedSkipped.includes(number)) completed.add(number);
      else pendingTags.push({ source: number, tag, commit: item.sha });
      continue;
    }
    for (let depth = 0; depth < 8 && object?.type === 'tag'; depth++) {
      if (!isSha(object.sha)) fail('Invalid annotated tag.');
      object = (await github.rest.git.getTag({ owner, repo, tag_sha: object.sha })).data.object;
    }
    if (object?.type !== 'commit' || object.sha !== item.sha) fail('Historical release tag points to a different commit.');
    if (appVersionPr && verifiedCompleted.includes(number)) completed.add(number);
    else if (appVersionPr) pendingTags.push({ source: number, tag, commit: item.sha });
    else fail('Legacy release ' + tag + ' has no verified migration record; review its publication state.');
  }
  if ([...verifiedCompleted, ...verifiedSkipped].some(number => !completed.has(number))) {
    fail('Verified release evidence does not match the Source_Code first-parent history.');
  }
  if (pendingTags.length) {
    const pending = pendingTags.at(-1);
    fail('Source PR #' + pending.source + ' has a pending release; reconcile its tag and assets first.');
  }
  const candidates = pulls.filter(pr => pr?.state === 'closed' && pr.merged_at &&
    pr.base?.ref === BASE && pr.base?.repo?.full_name === REPO &&
    utcSecond(pr.merged_at) > anchorTime &&
    Number.isSafeInteger(pr.number) && pr.number > 0 && pr.user?.id !== BOT_ID &&
    Array.isArray(pr.labels) && pr.labels.some(label => label?.name === 'release:patch') &&
    !completed.has(pr.number))
    .filter(pr => requestedSource === null || pr.number === requestedSource)
    .sort((a, b) => Date.parse(a.merged_at) - Date.parse(b.merged_at) || a.number - b.number);
  let source = null;
  for (const candidate of candidates) {
    const current = (await github.rest.pulls.get({ owner, repo, pull_number: candidate.number })).data;
    if (!(await sourceAuthorized(current))) {
      if (requestedSource !== null) fail('Requested source PR label authorization cannot be established.');
      continue;
    }
    source = current; break;
  }
  if (!source) {
    const occupied = pulls.filter(pr => pr?.state === 'open' && pr.user?.id === BOT_ID &&
      pr.head?.ref === 'automation/protected-workflows' && pr.head?.repo?.id === 1251103365 &&
      pr.head.repo.full_name === REPO && typeof pr.body === 'string' &&
      pr.body.includes('<!-- automatic-patch-source:'));
    if (occupied.length) {
      fail('An open version PR has no active source authorization; preserve the PR and branch for review.');
    }
    if (requestedSource !== null && completed.has(requestedSource)) return { status: 'already-tagged', source: requestedSource };
    if (requestedSource !== null) fail('Requested source PR #' + requestedSource + ' is not eligible for patch automation.');
    return { status: 'idle' };
  }
  const sourceIdentity = validateSourcePr(source);
  const ancestry = (await github.rest.repos.compareCommits({
    owner, repo, base: sourceIdentity.mergeSha, head: base,
  })).data;
  if (ancestry?.merge_base_commit?.sha !== sourceIdentity.mergeSha ||
      ancestry.behind_by !== 0 || !['ahead', 'identical'].includes(ancestry.status)) {
    fail('Source PR merge commit is not in the current Source_Code history.');
  }
  const branch = versionBranch(source.number);
  if (!BRANCH.test(branch)) fail('Version branch is invalid.');
  const sourceMarker = '<!-- automatic-patch-source:' + source.number + ':' + sourceIdentity.mergeSha + ' -->';
  const matches = pulls.filter(pr => pr?.user?.id === BOT_ID &&
    pr.head?.repo?.id === 1251103365 && pr.head.repo.full_name === REPO && pr.head.ref === branch &&
    typeof pr.body === 'string' && pr.body.split('\n').filter(line => line === sourceMarker).length === 1);
  if (matches.length > 1) fail('Multiple version PRs already exist for this source.');
  const prior = matches[0];
  if (prior && prior.state !== 'open') {
    validateVersionPr((await github.rest.pulls.get({ owner, repo, pull_number: prior.number })).data, source);
    fail('Version PR #' + prior.number + ' was closed; source PR #' + source.number + ' requires review.');
  }

  // An unrelated or retargeted PR must never be reused as this service branch.
  const stableOpen = async expectedNumber => {
    const headPrs = await github.paginate(github.rest.pulls.list, {
      owner, repo, state: 'open', head: owner + ':' + branch, per_page: 100,
    });
    const basePrs = await github.paginate(github.rest.pulls.list, {
      owner, repo, state: 'open', base: branch, per_page: 100,
    });
    if (!Array.isArray(headPrs) || !Array.isArray(basePrs) || headPrs.length > 1 || basePrs.length !== 0 ||
        headPrs.some(pr => !pr || pr.number !== expectedNumber || pr.state !== 'open' ||
          pr.user?.id !== BOT_ID || pr.head?.repo?.id !== 1251103365 ||
          pr.head.repo.full_name !== REPO || pr.head.ref !== branch ||
          pr.base?.repo?.id !== 1251103365 || pr.base.repo.full_name !== REPO ||
          pr.base.ref !== BASE)) {
      fail('The service branch is in use by an unrelated or ambiguous PR.');
    }
    if (expectedNumber === null && headPrs.length !== 0) fail('The service branch is already in use.');
    if (expectedNumber !== null && (headPrs.length !== 1 || headPrs[0].number !== expectedNumber)) {
      fail('The existing version PR cannot be verified.');
    }
  };
  let head = await getRef(branch);
  let date = dateHongKong(now);
  await stableOpen(prior?.number ?? null);
  if (head) {
    const old = await inspectBranchCommit(head, sourceIdentity);
    date = old.date;
    if (old.previousBase !== base) fail('Version branch is stale; preserve it for review.');
    if (prior) await prState(prior.number, source, head);
  } else {
    if (prior) fail('Version PR exists but its branch is missing.');
    head = await buildCommit(sourceIdentity, date, base);
    if (await getRef(BASE) !== base || await getRef(branch) !== null) {
      fail('Base or service branch changed before version branch creation.');
    }
    await stableOpen(null);
    await ensureTagProtection();
    const currentSource = (await github.rest.pulls.get({ owner, repo, pull_number: source.number })).data;
    validateSourcePr(currentSource);
    if (currentSource.merge_commit_sha !== sourceIdentity.mergeSha || !(await sourceAuthorized(currentSource))) {
      fail('Source PR authorization changed before version branch creation.');
    }
    if (await getRef(BASE) !== base || await getRef(branch) !== null) {
      fail('Base or service branch changed before version branch creation.');
    }
    await stableOpen(null);
    const created = (await app.rest.git.createRef({ owner, repo, ref: 'refs/heads/' + branch, sha: head })).data;
    if (created?.ref !== 'refs/heads/' + branch || created.object?.sha !== head) fail('Version branch creation failed.');
  }
  if (await getRef(BASE) !== base || await getRef(branch) !== head) fail('Base or service branch changed before PR.');
  await inspectBranchCommit(head, sourceIdentity);
  if (prior) {
    const currentPr = await prState(prior.number, source, head);
    if (currentPr.base.sha !== base) fail('Version PR base changed.');
    await stableOpen(prior.number);
    return { status: 'ready-for-checks', source: source.number, pr: prior.number, head };
  }
  await stableOpen(null);
  const refreshed = (await github.rest.pulls.get({ owner, repo, pull_number: source.number })).data;
  validateSourcePr(refreshed);
  if (refreshed.merge_commit_sha !== sourceIdentity.mergeSha ||
      !(await sourceAuthorized(refreshed))) fail('Source PR authorization changed before version PR creation.');
  await ensureTagProtection();
  if (await getRef(branch) !== head) fail('Service branch changed before version PR creation.');
  await stableOpen(null);
  const created = (await app.rest.pulls.create({
    owner, repo, base: BASE, head: branch,
    title: 'chore: prepare automatic patch release after PR #' + source.number,
    body: '<!-- automatic-patch-source:' + source.number + ':' + sourceIdentity.mergeSha + ' -->\n\n' +
      'Prepares the version update for the verified merged source PR.\n\n' +
      'OpenAI-Codex_health_release_architecture',
  })).data;
  if (!Number.isSafeInteger(created?.number) || created.number < 1) fail('Version PR creation was not confirmed.');
  await prState(created.number, source, head);
  await stableOpen(created.number);
  if (await getRef(BASE) !== base || await getRef(branch) !== head) fail('Refs changed after version PR creation.');
  return { status: 'created', source: source.number, pr: created.number, head };
}
