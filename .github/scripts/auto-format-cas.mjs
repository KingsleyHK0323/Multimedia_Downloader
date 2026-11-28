// OpenAI-Codex_format_architecture: reconcile verified formatting with a checked compare-and-swap.
import { createHash } from 'node:crypto';
import { readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { TextDecoder } from 'node:util';

const FULL = 'KingsleyHK0323/Multimedia_Downloader';
const SOURCE = 'Source_Code';
const SERVICE = 'automation/protected-workflows';
const BOT_ID = 359694872;
const BOT_LOGIN = 'kingsley-multimedia-automation[bot]';
const APP_ID = 5868451;
const REPO_ID = 1251103365;
const ANCHOR = '2f596251077f7dad4d68928339c82a05f118aaed';
const MARKER = '<!-- automation-format-cas-v1 -->';
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const HASH = bytes => createHash('sha256').update(bytes).digest('hex');
const blobHash = bytes => createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
const fail = message => { throw new Error(message); };
const isOid = value => typeof value === 'string' && SHA.test(value);
const isBot = user => user?.id === BOT_ID && user?.login === BOT_LOGIN && user?.type === 'Bot';
const pathOrder = (left, right) => {
  const a = Array.from(left, char => char.codePointAt(0));
  const b = Array.from(right, char => char.codePointAt(0));
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
};
const safePath = path => typeof path === 'string' && path.length > 0 && !path.startsWith('/') &&
  path.split('/').every(part => part && !['.', '..', '.git'].includes(part) &&
    !part.includes('\\') && [...part].every(char => char.codePointAt(0) >= 32 && char.codePointAt(0) !== 127));

function file(root, relative) {
  const path = join(root, relative);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('Artifact data is not a regular file.');
  return readFileSync(path);
}

export function readPlan(root) {
  const first = join(root, 'one'), second = join(root, 'two');
  for (const dir of [root, first, second]) {
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Artifact directory is unsafe.');
  }
  const manifest = file(first, 'manifest.json');
  const otherManifest = file(second, 'manifest.json');
  const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const firstText = decode(manifest), secondText = decode(otherManifest);
  const plan = JSON.parse(firstText);
  let mergedCleanupRace = false;
  if (!manifest.equals(otherManifest)) {
    // OpenAI-Codex_format_architecture: allow only a no-work snapshot of an already merged service.
    const other = JSON.parse(secondText);
    const empty = value => value && Array.isArray(value.files) && value.files.length === 0 &&
      value.limited === false && Array.isArray(value.prior) && value.prior.length === 0 &&
      value.warning_count === 0 && Array.isArray(value.warnings) && value.warnings.length === 0;
    if (!isOid(plan?.base) || !empty(plan) || !empty(other) ||
        !((plan.service === null && other.service === plan.base) ||
          (plan.service === plan.base && other.service === null))) {
      fail('Independent formatting plans disagree.');
    }
    const withService = plan.service === null ? secondText : firstText;
    const withoutService = plan.service === null ? firstText : secondText;
    const needle = ',"service":"' + plan.base + '","warning_count":';
    const position = withService.indexOf(needle);
    if (position < 0 || withService.indexOf(needle, position + 1) !== -1 ||
        withService.slice(0, position) + ',"service":null,"warning_count":' +
          withService.slice(position + needle.length) !== withoutService) {
      fail('Independent formatting plans disagree.');
    }
    mergedCleanupRace = true;
  }
  if (!plan || Object.keys(plan).sort().join(',') !== 'anchor,base,black,configs,files,limited,prior,service,warning_count,warnings' ||
      plan.anchor !== ANCHOR || !isOid(plan.base) || plan.black !== '25.1.0' ||
      !Array.isArray(plan.configs) || !Array.isArray(plan.files) || plan.files.length > 50 ||
      !Array.isArray(plan.warnings) || plan.warnings.length > 256 ||
      !Number.isSafeInteger(plan.warning_count) || plan.warning_count < plan.warnings.length ||
      typeof plan.limited !== 'boolean' || !(plan.service === null || isOid(plan.service)) ||
      !Array.isArray(plan.prior) || plan.prior.length > 32 || plan.prior.some(item =>
        !item || Object.keys(item).sort().join(',') !== 'base,digest,head,tree' ||
        !isOid(item.base) || !DIGEST.test(item.digest) || !isOid(item.head) || !isOid(item.tree))) fail('Invalid formatter manifest.');
  if (plan.files.length) {
    for (const dir of [join(first, 'blobs'), join(second, 'blobs')]) {
      const stat = lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Artifact payload directory is unsafe.');
    }
  }
  const outputs = new Map();
  let prior = '', total = 0;
  for (const item of plan.files) {
    if (!item || Object.keys(item).sort().join(',') !== 'last_change,mode,output,path,sha256,size,source' ||
        !safePath(item.path) || !item.path.endsWith('.py') || item.path.startsWith('.github/workflows/') ||
        (prior && pathOrder(prior, item.path) >= 0) || !['100644', '100755'].includes(item.mode) ||
        !isOid(item.source) || !isOid(item.output) || !isOid(item.last_change) ||
        !DIGEST.test(item.sha256) || !Number.isSafeInteger(item.size) || item.size < 0 ||
        item.size > 25 * 1024 * 1024) fail('Invalid formatter file metadata.');
    prior = item.path;
    const bytes = file(first, 'blobs/' + item.sha256);
    if (!bytes.equals(file(second, 'blobs/' + item.sha256)) ||
        bytes.length !== item.size || HASH(bytes) !== item.sha256 ||
        blobHash(bytes) !== item.output || item.output === item.source) {
      fail('Formatter output bytes do not match independent plans.');
    }
    total += bytes.length;
    if (total > 40 * 1024 * 1024) fail('Formatter batch exceeds the data limit.');
    outputs.set(item.path, bytes);
  }
  prior = '';
  for (const config of plan.configs) {
    if (!config || Object.keys(config).sort().join(',') !== 'path,sha' ||
        !safePath(config.path) || !(config.path === 'pyproject.toml' || config.path.endsWith('/pyproject.toml')) ||
        (prior && pathOrder(prior, config.path) >= 0) || !isOid(config.sha)) fail('Invalid formatter configuration identity.');
    prior = config.path;
  }
  return { plan, outputs, mergedCleanupRace };
}

export async function reconcileFormatter({ github, app, context, appSlug, workflowSha, artifactRoot, log = console }) {
  const { owner, repo } = context.repo || {};
  if (owner + '/' + repo !== FULL || context.ref !== 'refs/heads/' + SOURCE ||
      appSlug !== 'kingsley-multimedia-automation' || !isOid(workflowSha)) {
    fail('Unexpected repository, source ref, App, or workflow revision.');
  }
  const application = (await app.request('GET /apps/{app_slug}', { app_slug: appSlug })).data;
  const actor = (await app.rest.users.getByUsername({ username: BOT_LOGIN })).data;
  const repository = (await app.rest.repos.get({ owner, repo })).data;
  if (application?.id !== APP_ID || application?.slug !== appSlug || !isBot(actor) ||
      repository?.id !== REPO_ID || repository.full_name !== FULL ||
      repository.fork !== false || typeof repository.node_id !== 'string' || !repository.node_id) {
    fail('The repository or automation App identity is unexpected.');
  }
  const { plan, outputs, mergedCleanupRace } = readPlan(artifactRoot);
  const getRef = async (branch, missing = false) => {
    try {
      const value = (await github.rest.git.getRef({ owner, repo, ref: 'heads/' + branch })).data;
      if (value?.ref !== 'refs/heads/' + branch || value.object?.type !== 'commit' || !isOid(value.object.sha)) {
        fail('Invalid branch ref.');
      }
      return value.object.sha;
    } catch (error) {
      if (missing && error.status === 404) return null;
      throw error;
    }
  };
  const base = await getRef(SOURCE);
  if (base !== plan.base || base !== workflowSha) fail('Source_Code moved since the trusted plan; retry.');
  const requireBase = async () => {
    if (await getRef(SOURCE) !== base) fail('Source_Code moved; retry without changing it.');
  };
  const getCommit = async sha => {
    const data = (await github.rest.git.getCommit({ owner, repo, commit_sha: sha })).data;
    if (data?.sha !== sha || !isOid(data.tree?.sha) || !Array.isArray(data.parents) ||
        data.parents.some(parent => !isOid(parent.sha))) fail('Invalid Git commit.');
    return data;
  };
  const tree = async sha => {
    const data = (await github.rest.git.getTree({ owner, repo, tree_sha: sha, recursive: 'true' })).data;
    if (data?.sha !== sha || data.truncated !== false || !Array.isArray(data.tree) || data.tree.length > 100000) {
      fail('Git tree is incomplete.');
    }
    const map = new Map();
    for (const entry of data.tree) {
      if (typeof entry?.path !== 'string' || !entry.path || map.has(entry.path) ||
          !['blob', 'tree', 'commit'].includes(entry.type) || !isOid(entry.sha) ||
          typeof entry.mode !== 'string') fail('Git tree has invalid entries.');
      map.set(entry.path, entry);
    }
    return map;
  };
  const baseCommit = await getCommit(base);
  const sourceTree = await tree(baseCommit.tree.sha);
  for (const config of plan.configs) {
    const entry = sourceTree.get(config.path);
    if (!entry || entry.type !== 'blob' || entry.mode !== '100644' || entry.sha !== config.sha) {
      fail('Formatter configuration changed.');
    }
  }
  for (const item of plan.files) {
    const entry = sourceTree.get(item.path);
    if (!entry || entry.type !== 'blob' || entry.mode !== item.mode || entry.sha !== item.source) {
      fail('Formatter input changed.');
    }
  }
  const exactTree = async sha => {
    const next = await tree(sha);
    if (next.size !== sourceTree.size) fail('Formatter changed the path inventory.');
    for (const [path, old] of sourceTree) {
      const item = plan.files.find(value => value.path === path);
      const current = next.get(path);
      if (!current || current.type !== old.type || current.mode !== old.mode) {
        fail('Formatter changed a path or file mode.');
      }
      if (item) {
        if (current.sha !== item.output) fail('Formatter output does not match the verified plan.');
      } else if (old.type !== 'tree' && current.sha !== old.sha) {
        fail('Formatter changed an unrelated object.');
      }
    }
  };
  const rulesSnapshot = async () => {
    const rules = await app.paginate('GET /repos/{owner}/{repo}/rules/branches/{branch}', {
      owner, repo, branch: SOURCE, per_page: 100,
    });
    if (!Array.isArray(rules) || !rules.length || rules.length > 1000 ||
        rules.some(rule => !Number.isSafeInteger(rule?.ruleset_id) || rule.ruleset_id < 1 ||
          !['Repository', 'Organization'].includes(rule.ruleset_source_type) ||
          typeof rule.ruleset_source !== 'string' || typeof rule.type !== 'string')) {
      fail('Source_Code rules are missing or incomplete.');
    }
    if (rules.some(rule => rule.type === 'pull_request')) fail('Source_Code currently requires PR merges.');
    if (!rules.some(rule => rule.type === 'non_fast_forward')) fail('Source_Code must block force pushes.');
    const contexts = new Set();
    for (const rule of rules.filter(value => value.type === 'required_status_checks')) {
      const p = rule.parameters;
      if (!p || typeof p.strict_required_status_checks_policy !== 'boolean' ||
          !Array.isArray(p.required_status_checks) || !p.required_status_checks.length) {
        fail('A Source_Code required-check rule is incomplete.');
      }
      for (const check of p.required_status_checks) {
        if (check?.integration_id === 15368 &&
            ['Required CI', 'Required Python matrix'].includes(check.context)) contexts.add(check.context);
      }
    }
    if (contexts.size !== 2) fail('CI and matrix rules from GitHub Actions are required.');
    const ids = [...new Set(rules.map(rule => rule.ruleset_id))].sort((a, b) => a - b);
    const details = [];
    for (const id of ids) {
      const value = (await app.request('GET /repos/{owner}/{repo}/rulesets/{ruleset_id}', {
        owner, repo, ruleset_id: id, includes_parents: true,
      })).data;
      if (value?.id !== id || value.enforcement !== 'active' || value.target !== 'branch' ||
          value.current_user_can_bypass !== 'never' || !Array.isArray(value.rules)) {
        fail('An applicable Source_Code rule is inactive, missing, or bypassable by the App.');
      }
      details.push({ id, enforcement: value.enforcement, target: value.target,
        current_user_can_bypass: value.current_user_can_bypass, rules: value.rules });
    }
    return JSON.stringify({ rules: [...rules].sort((a, b) => a.ruleset_id - b.ruleset_id || a.type.localeCompare(b.type)), details });
  };
  const messageDigest = HASH(Buffer.from(JSON.stringify({ configs: plan.configs, files: plan.files })));
  const message = 'style: format changed Python files\n\nOpenAI-Codex_format_architecture\nFormat-Plan-SHA256: ' + messageDigest;
  const commitsBot = async sha => {
    const detail = (await github.rest.repos.getCommit({ owner, repo, ref: sha })).data;
    if (detail?.sha !== sha || !isBot(detail.author) || detail.committer?.id !== 19864447 ||
        detail.committer?.login !== 'web-flow' || detail.committer?.type !== 'User' ||
        detail.commit?.verification?.verified !== true || detail.commit.verification.reason !== 'valid' ||
        !/^style: format changed Python files\n\nOpenAI-Codex_format_architecture\nFormat-Plan-SHA256: [0-9a-f]{64}$/.test(detail.commit.message || '')) {
      fail('The formatter branch is not a verified App commit.');
    }
    return detail;
  };
  const listPrs = async () => {
    const values = await github.paginate(github.rest.pulls.list, {
      owner, repo, state: 'all', head: owner + ':' + SERVICE, per_page: 100,
    });
    if (!Array.isArray(values) || values.length > 1000) fail('Service branch PR inventory is incomplete.');
    const ids = new Set();
    for (const pr of values) {
      if (!Number.isSafeInteger(pr?.number) || pr.number < 1 || ids.has(pr.number) ||
          !['open', 'closed'].includes(pr.state) || pr.head?.ref !== SERVICE ||
          (pr.head.repo !== null && pr.head.repo?.full_name !== FULL)) fail('Service branch PR inventory is invalid.');
      ids.add(pr.number);
    }
    return values.sort((a, b) => b.number - a.number);
  };
  const isAncestor = async (older, newer) => {
    const comparison = (await github.rest.repos.compareCommits({ owner, repo, base: older, head: newer })).data;
    return comparison?.merge_base_commit?.sha === older && comparison.behind_by === 0 &&
      ['ahead', 'identical'].includes(comparison.status);
  };
  // OpenAI-Codex_formatter_fix: GitHub can retain an older base on an open PR.
  const prInfo = async (number, expectedHead, allowHistoricalBase = false, previousHead) => {
    const read = async () => (await github.rest.pulls.get({ owner, repo, pull_number: number })).data;
    let pr = await read();
    // OpenAI-Codex_restore127: GitHub may briefly report the previous head after a verified ref update.
    for (const delay of [500, 1000, 2000]) {
      if (!previousHead || pr?.head?.sha !== previousHead) break;
      await new Promise(resolve => setTimeout(resolve, delay));
      pr = await read();
    }
    if (pr?.number !== number || pr.state !== 'open' || !isBot(pr.user) ||
        pr.head?.repo?.full_name !== FULL || pr.head.ref !== SERVICE || pr.head.sha !== expectedHead ||
        pr.base?.repo?.full_name !== FULL || pr.base.ref !== SOURCE ||
        (pr.base.sha !== base && !(allowHistoricalBase && /^[a-f0-9]{40}$/.test(pr.base.sha) &&
          await isAncestor(pr.base.sha, base))) ||
        pr.draft !== false || pr.auto_merge !== null || !Array.isArray(pr.labels) ||
        pr.labels.some(label => typeof label?.name !== 'string' || label.name.toLowerCase() === 'release:patch') ||
        typeof pr.body !== 'string' || !pr.body.includes(MARKER)) fail('Formatter PR is no longer safe to update.');
    return pr;
  };
  const allPrs = await listPrs();
  const open = allPrs.filter(pr => pr.state === 'open');
  if (open.length > 1) fail('More than one PR uses the service branch.');
  if (open.length && (!isBot(open[0].user) || typeof open[0].body !== 'string' || !open[0].body.includes(MARKER))) {
    fail('The service branch is occupied by another PR.');
  }
  const previous = allPrs.find(pr => isBot(pr.user) && typeof pr.body === 'string' && pr.body.includes(MARKER));
  let serviceHead = await getRef(SERVICE, true);
  // OpenAI-Codex_format_architecture: the ref can also disappear after both snapshots.
  const noWork = plan.files.length === 0 && plan.warning_count === 0 &&
    plan.warnings.length === 0 && plan.prior.length === 0 && plan.limited === false;
  const cleanupRefMoved = plan.service !== serviceHead &&
    (plan.service === null || plan.service === base) &&
    (serviceHead === null || serviceHead === base);
  if (noWork && (mergedCleanupRace || cleanupRefMoved)) {
    const verifyMergedCleanup = async values => {
      const latest = values[0];
      if (values.some(pr => pr.state === 'open') || !latest || latest.state !== 'closed' ||
          typeof latest.merged_at !== 'string' || !Number.isFinite(Date.parse(latest.merged_at)) ||
          latest.merge_commit_sha !== base || latest.head?.sha !== base ||
          latest.head?.repo?.full_name !== FULL || latest.base?.ref !== SOURCE ||
          latest.base?.repo?.full_name !== FULL) {
        fail('The cleanup snapshot does not match the latest merged service PR.');
      }
      const currentService = await getRef(SERVICE, true);
      if (currentService !== null && currentService !== base) {
        fail('The service branch moved during merged cleanup.');
      }
      await requireBase();
      return latest.number;
    };
    const mergedPr = await verifyMergedCleanup(allPrs);
    if (await verifyMergedCleanup(await listPrs()) !== mergedPr) {
      fail('The latest service PR changed during merged cleanup.');
    }
    return { status: 'idle-after-merged-cleanup', pr: mergedPr, head: base };
  }
  if (!open.length && previous?.state === 'closed' && !previous.merged_at) {
    fail('The latest formatter PR was closed without merging; it will not be reopened.');
  }
  const firstRules = await rulesSnapshot();
  if (serviceHead !== plan.service) fail('The service branch moved since independent planning; retry.');
  let pr = null;
  if (open.length) {
    if (!serviceHead) fail('Open formatter PR has no service branch.');
    pr = await prInfo(open[0].number, serviceHead, true);
    await commitsBot(serviceHead);
  }
  const verifyHistoricalProof = async () => {
    let cursor = serviceHead;
    const candidates = new Set();
    for (const item of plan.prior) {
      if (!cursor || await isAncestor(cursor, base) || item.head !== cursor || candidates.has(cursor)) {
        fail('Formatter ancestry evidence is inconsistent.');
      }
      const commit = await getCommit(cursor);
      const signed = await commitsBot(cursor);
      if (signed.commit.message !== 'style: format changed Python files\n\nOpenAI-Codex_format_architecture\nFormat-Plan-SHA256: ' + item.digest) {
        fail('Historical formatter plan digest does not match the signed commit.');
      }
      if (commit.tree.sha !== item.tree || commit.parents.length < 1 || commit.parents.length > 2 ||
          commit.parents[0].sha !== item.base || !(await isAncestor(item.base, base)) ||
          (commit.parents.length === 2 && commit.parents[1].sha === item.base)) {
        fail('Formatter ancestry parents or trees do not match independent recomputation.');
      }
      candidates.add(cursor);
      cursor = commit.parents[1]?.sha || null;
    }
    if (cursor && !(await isAncestor(cursor, base))) fail('Formatter ancestry evidence is incomplete.');
    if (!candidates.size) return;
    const values = await github.paginate(github.rest.pulls.list, { owner, repo, state: 'open', per_page: 100 });
    if (!Array.isArray(values) || values.length > 1000) fail('Open PR inventory is incomplete.');
    for (const other of values) {
      if (other?.state !== 'open' || !Number.isSafeInteger(other.number) || other.number < 1 ||
          !isOid(other.head?.sha)) fail('Open PR identity is incomplete.');
      if (other.number !== pr?.number && candidates.has(other.head.sha)) {
        fail('A different open PR would be indirectly merged by the formatter update.');
      }
    }
  };
  await verifyHistoricalProof();
  if (pr && serviceHead === base) {
    return { status: 'waiting-for-indirect-close', pr: pr.number, head: serviceHead };
  }
  if (!plan.files.length) {
    if (plan.warning_count) fail('Some changed Python files could not be formatted; inspect planner output.');
    if (pr) fail('The open formatter PR is superseded; preserving it for review.');
    return { status: 'idle' };
  }
  if (plan.warning_count) log.warn('Some Python files were skipped; their warnings remain in the plan artifact.');

  let currentMatches = false;
  let recoveredOrphan = false;
  if (!pr && serviceHead) {
    try {
      const detail = await commitsBot(serviceHead);
      const commit = await getCommit(serviceHead);
      if (detail.commit.message === message && commit.parents[0]?.sha === base) {
        await exactTree(commit.tree.sha);
        recoveredOrphan = true;
      }
    } catch (error) {
      if (!error || error.message !== 'The formatter branch is not a verified App commit.') throw error;
    }
  }
  if (recoveredOrphan) {
    await requireBase();
    if ((await listPrs()).some(value => value.state === 'open')) fail('Another service PR appeared.');
    const opened = (await app.rest.pulls.create({ owner, repo, head: SERVICE, base: SOURCE,
      title: 'style: format changed Python files',
      body: MARKER + '\n\nFormats verified Python files with Black 25.1.0.\n\nOpenAI-Codex_format_architecture' })).data;
    if (!Number.isSafeInteger(opened?.number) || opened.number < 1) fail('Formatter PR recovery was not confirmed.');
    await prInfo(opened.number, serviceHead);
    return { status: 'recovered', pr: opened.number, head: serviceHead };
  }
  if (pr) {
    const detail = await commitsBot(serviceHead);
    const commit = await getCommit(serviceHead);
    if (detail.commit.message === message && commit.parents[0]?.sha === base) {
      await exactTree(commit.tree.sha);
      currentMatches = true;
    }
  }
  if (!currentMatches) {
    if (!pr && serviceHead) {
      const comparison = (await github.rest.repos.compareCommits({ owner, repo, base: serviceHead, head: base })).data;
      if (comparison?.merge_base_commit?.sha !== serviceHead || comparison.behind_by !== 0 ||
          !['ahead', 'identical'].includes(comparison.status)) {
        fail('Existing service branch contains unmerged work; preserving it.');
      }
    }
    const changes = [];
    for (const item of plan.files) {
      const bytes = outputs.get(item.path);
      const blob = (await app.rest.git.createBlob({ owner, repo, content: bytes.toString('base64'), encoding: 'base64' })).data;
      if (blob?.sha !== item.output) fail('Created formatter blob is inconsistent.');
      changes.push({ path: item.path, mode: item.mode, type: 'blob', sha: item.output });
    }
    const createdTree = (await app.rest.git.createTree({ owner, repo, base_tree: baseCommit.tree.sha, tree: changes })).data;
    if (!isOid(createdTree?.sha)) fail('Created formatter tree is invalid.');
    await exactTree(createdTree.sha);
    const parents = [base];
    if (serviceHead) {
      const compare = (await github.rest.repos.compareCommits({ owner, repo, base: serviceHead, head: base })).data;
      if (compare?.merge_base_commit?.sha !== serviceHead || compare.behind_by !== 0 ||
          !['ahead', 'identical'].includes(compare.status)) {
        if (!pr) fail('Service branch cannot be safely advanced.');
        parents.push(serviceHead);
      }
    }
    const created = (await app.rest.git.createCommit({ owner, repo, message, tree: createdTree.sha, parents })).data;
    if (!isOid(created?.sha) || created.tree?.sha !== createdTree.sha ||
        !Array.isArray(created.parents) || created.parents.map(value => value.sha).join(',') !== parents.join(',') ||
        created.verification?.verified !== true || created.verification.reason !== 'valid') {
      fail('Created formatter commit is not the expected signed commit.');
    }
    await requireBase();
    if (await rulesSnapshot() !== firstRules) fail('Source_Code rules changed before updating the service branch.');
    if (pr) await prInfo(pr.number, serviceHead, true);
    if (serviceHead) {
      const mutation = await app.graphql('mutation($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }', {
        input: { repositoryId: repository.node_id, clientMutationId: 'format-service-' + serviceHead,
          refUpdates: [{ name: 'refs/heads/' + SERVICE, beforeOid: serviceHead, afterOid: created.sha, force: false }] },
      });
      if (mutation?.updateRefs?.clientMutationId !== 'format-service-' + serviceHead) fail('Service branch update was not confirmed.');
    } else {
      const ref = (await app.rest.git.createRef({ owner, repo, ref: 'refs/heads/' + SERVICE, sha: created.sha })).data;
      if (ref?.ref !== 'refs/heads/' + SERVICE || ref.object?.sha !== created.sha) fail('Service branch creation was not confirmed.');
    }
    const previousHead = serviceHead;
    serviceHead = created.sha;
    if (await getRef(SERVICE) !== serviceHead) fail('Service branch moved after update.');
    await commitsBot(serviceHead);
    if (!pr) {
      await requireBase();
      if ((await listPrs()).some(value => value.state === 'open')) fail('Another service PR appeared.');
      const opened = (await app.rest.pulls.create({ owner, repo, head: SERVICE, base: SOURCE,
        title: 'style: format changed Python files',
        body: MARKER + '\n\nFormats verified Python files with Black 25.1.0.\n\nOpenAI-Codex_format_architecture' })).data;
      if (!Number.isSafeInteger(opened?.number) || opened.number < 1) fail('Formatter PR creation was not confirmed.');
      await prInfo(opened.number, serviceHead);
      return { status: 'created', pr: opened.number, head: serviceHead };
    }
    await prInfo(pr.number, serviceHead, true, previousHead);
    return { status: 'updated', pr: pr.number, head: serviceHead };
  }

  const required = [
    { path: '.github/workflows/ci.yml', name: 'CI', jobs: [
      'Required CI', 'version-consistency', 'auto-format-guard', 'release-input-guard',
      'lint', 'python-tests', 'frontend-check', 'rust-check',
    ] },
    { path: '.github/workflows/python-matrix.yml', name: 'Python matrix tests', jobs: [
      'Required Python matrix',
      ...['ubuntu-22.04', 'macos-15', 'windows-latest'].flatMap(os =>
        ['3.10', '3.11', '3.12', '3.13', '3.14'].map(version => 'python-tests (' + os + ', ' + version + ')')),
    ] },
  ];
  const getRuns = async () => {
    const values = [];
    let total;
    for (let page = 1; page <= 11; page++) {
      const response = (await github.rest.actions.listWorkflowRunsForRepo({
        owner, repo, event: 'push', head_sha: serviceHead, per_page: 100, page,
      })).data;
      if (!Number.isSafeInteger(response?.total_count) || response.total_count < 0 || response.total_count > 1000 ||
          (total !== undefined && total !== response.total_count) || !Array.isArray(response.workflow_runs)) {
        fail('Push run inventory is incomplete.');
      }
      total = response.total_count;
      values.push(...response.workflow_runs);
      if (values.length >= total) break;
      if (response.workflow_runs.length !== 100) fail('Push run page is incomplete.');
    }
    if (values.length !== total) fail('Push run inventory is truncated.');
    return required.map(spec => {
      const runs = values.filter(run => run?.path === spec.path && run.head_sha === serviceHead &&
        run.event === 'push' && run.head_branch === SERVICE &&
        run.repository?.id === REPO_ID && run.head_repository?.id === REPO_ID)
        .sort((a, b) => b.id - a.id);
      const run = runs[0];
      if (!run || ['queued', 'in_progress', 'waiting', 'requested', 'pending'].includes(run.status)) return null;
      if (!Number.isSafeInteger(run.id) || run.id < 1 || !Number.isSafeInteger(run.run_attempt) ||
          run.run_attempt < 1 || run.run_attempt > 20 || run.name !== spec.name || run.status !== 'completed' || run.conclusion !== 'success') {
        fail('The latest required service-branch push run did not pass.');
      }
      return { id: run.id, attempt: run.run_attempt, path: spec.path };
    });
  };
  const successfulJobs = async (run, names) => {
    const pending = new Set(names), selected = new Map();
    for (let attempt = run.attempt; attempt >= 1 && pending.size; attempt--) {
      const data = (await github.rest.actions.listJobsForWorkflowRunAttempt({
        owner, repo, run_id: run.id, attempt_number: attempt, per_page: 100,
      })).data;
      if (!Number.isSafeInteger(data?.total_count) || data.total_count < 0 || data.total_count > 100 ||
          !Array.isArray(data.jobs) || data.jobs.length !== data.total_count) fail('Workflow jobs are incomplete.');
      for (const name of [...pending]) {
        const found = data.jobs.filter(job => job?.name === name);
        if (found.length > 1) fail('A required job name is ambiguous.');
        if (!found.length) continue;
        const job = found[0];
        if (!Number.isSafeInteger(job.id) || job.id < 1 || job.run_id !== run.id ||
            job.status !== 'completed' || job.conclusion !== 'success') fail('A required job did not succeed.');
        const prefix = 'https://api.github.com/repos/' + FULL + '/check-runs/';
        const match = typeof job.check_run_url === 'string' && job.check_run_url.startsWith(prefix)
          ? job.check_run_url.slice(prefix.length) : '';
        if (!/^[1-9][0-9]*$/.test(match)) fail('A required job has no valid check-run identity.');
        const check = (await github.rest.checks.get({ owner, repo, check_run_id: Number(match) })).data;
        if (check?.id !== Number(match) || check.name !== name || check.head_sha !== serviceHead ||
            check.app?.id !== 15368 || check.status !== 'completed' || check.conclusion !== 'success') {
          fail('A required GitHub Actions check is not bound to the tested head.');
        }
        const age = Date.now() - Date.parse(check.completed_at);
        if (!Number.isFinite(age) || age < -60000 || age > 7 * 24 * 60 * 60 * 1000) {
          fail('A required GitHub Actions check is not fresh; rerun the relevant push workflow.');
        }
        selected.set(name, { id: job.id, check: check.id, attempt, completed: check.completed_at });
        pending.delete(name);
      }
    }
    if (pending.size) fail('A required job is missing.');
    return names.map(name => ({ name, ...selected.get(name) }));
  };
  const firstRuns = await getRuns();
  if (firstRuns.some(value => !value)) return { status: 'waiting-for-checks', pr: pr.number, head: serviceHead };
  const expectedContext = 'dependabot-context-' + serviceHead + '-' + serviceHead + '-' + serviceHead;
  const evidence = await Promise.all(firstRuns.map((run, index) =>
    successfulJobs(run, [expectedContext, ...required[index].jobs])));
  await requireBase();
  if (await getRef(SERVICE) !== serviceHead) fail('Service branch changed before source update.');
  await prInfo(pr.number, serviceHead, true);
  if (await rulesSnapshot() !== firstRules) fail('Source_Code rules changed before source update.');
  const secondRuns = await getRuns();
  if (JSON.stringify(firstRuns) !== JSON.stringify(secondRuns)) fail('Push runs changed before source update.');
  const again = await Promise.all(secondRuns.map((run, index) =>
    successfulJobs(run, [expectedContext, ...required[index].jobs])));
  if (JSON.stringify(evidence) !== JSON.stringify(again)) fail('Required job attempts changed before source update.');
  await requireBase();
  await verifyHistoricalProof();
  const mutation = await app.graphql('mutation($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }', {
    input: { repositoryId: repository.node_id, clientMutationId: 'format-source-' + serviceHead,
      refUpdates: [{ name: 'refs/heads/' + SOURCE, beforeOid: base, afterOid: serviceHead, force: false }] },
  });
  if (mutation?.updateRefs?.clientMutationId !== 'format-source-' + serviceHead) fail('Source_Code update was not confirmed.');
  if (await getRef(SOURCE) !== serviceHead) fail('Source_Code moved after its checked update; inspect before retrying.');
  return { status: 'updated-source', pr: pr.number, head: serviceHead, limited: plan.limited };
}
