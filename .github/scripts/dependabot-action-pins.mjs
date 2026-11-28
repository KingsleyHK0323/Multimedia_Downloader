// OpenAI-Codex_automerge_fix: only reconcile immutable, same-major pins in two reviewed consumers.
import { createHash } from 'node:crypto';
import { sourceRulesSnapshot } from './patch-push-checks.mjs';

const owner = 'KingsleyHK0323', repo = 'Multimedia_Downloader', base = 'Source_Code';
const repositoryId = 1251103365, sha = /^[0-9a-f]{40}$/;
const policies = new Map([
  ['.github/workflows/container.yml', { action: 'docker/login-action', id: 287743349 }],
  ['.github/workflows/stale.yml', { action: 'actions/stale', id: 200437066 }],
]);

export function pinChange(previous, updated, action) {
  const before = previous.split('\n'), after = updated.split('\n');
  if (before.length !== after.length) return null;
  const changed = before.map((line, i) => line !== after[i] ? i : -1).filter(i => i >= 0);
  if (changed.length !== 1) return null;
  const parse = line => /^( +(?:- )?uses: )([a-z0-9-]+\/[a-z0-9-]+)@([0-9a-f]{40}) # v(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.exec(line);
  const old = parse(before[changed[0]]), next = parse(after[changed[0]]);
  if (!old || !next || old[1] !== next[1] || old[2] !== action || next[2] !== action ||
      old[3] === next[3] || old[4] !== next[4] || Number(next[5]) < Number(old[5]) ||
      (next[5] === old[5] && Number(next[6]) <= Number(old[6]))) return null;
  return { commit: next[3], tag: 'v' + next.slice(4).join('.') };
}

// Check the complete git delta, including executable modes, instead of trusting a rendered patch.
function leaves(tree) {
  if (tree.truncated !== false || !Array.isArray(tree.tree)) throw Error('Incomplete git tree.');
  return new Map(tree.tree.filter(e => e.type !== 'tree').map(e => [e.path, e]));
}

export function changedConsumer(before, after) {
  const old = leaves(before), next = leaves(after);
  if (old.size !== next.size) return null;
  let name;
  for (const [path, a] of old) {
    const b = next.get(path);
    if (!b || b.type !== a.type || b.mode !== a.mode) return null;
    if (a.sha === b.sha) continue;
    if (name || !policies.has(path) || a.type !== 'blob' || a.mode !== '100644') return null;
    name = path;
  }
  return name && { name, before: old.get(name).sha, after: next.get(name).sha };
}

function isCandidate(pr) {
  return pr.state === 'open' && pr.draft === false && pr.base.ref === base &&
    pr.base.repo?.id === repositoryId && pr.head.repo?.id === repositoryId &&
    pr.user?.type === 'Bot' && pr.user.id === 49699333 && pr.user.login === 'dependabot[bot]' &&
    pr.head.ref.startsWith('dependabot/github_actions/') && sha.test(pr.head.sha);
}

async function inspect(github, number, workflowSha) {
  const args = { owner, repo };
  const { data: pr } = await github.rest.pulls.get({ ...args, pull_number: number });
  if (!isCandidate(pr) || pr.commits !== 1 || pr.changed_files !== 1 ||
      !Array.isArray(pr.labels) || pr.labels.some(label => label.name === 'release:patch')) return;
  const { data: head } = await github.rest.repos.getCommit({ ...args, ref: pr.head.sha });
  if (head.sha !== pr.head.sha || head.parents.length !== 1 ||
      head.author?.id !== 49699333 || head.committer?.id !== 19864447 ||
      head.commit.verification?.verified !== true || head.commit.verification.reason !== 'valid') return;
  const parent = head.parents[0].sha;
  const tree = async ref => (await github.rest.git.getTree({ ...args, tree_sha: ref, recursive: '1' })).data;
  const treeForCommit = async ref => {
    const commit = (await github.rest.git.getCommit({ ...args, commit_sha: ref })).data;
    if (commit.sha !== ref || !sha.test(commit.tree?.sha)) throw Error('Unexpected commit tree.');
    return tree(commit.tree.sha);
  };
  const [old, next] = await Promise.all([treeForCommit(parent), tree(head.commit.tree.sha)]);
  const change = changedConsumer(old, next);
  if (!change) return;
  const policy = policies.get(change.name);
  const blob = async id => {
    const { data } = await github.rest.git.getBlob({ ...args, file_sha: id });
    if (data.sha !== id || data.encoding !== 'base64' || data.size > 128 * 1024) throw Error('Unexpected workflow blob.');
    const bytes = Buffer.from(data.content, 'base64');
    const hash = createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
    if (hash !== id || bytes.length !== data.size) throw Error('Workflow blob verification failed.');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  };
  const pin = pinChange(await blob(change.before), await blob(change.after), policy.action);
  if (!pin) return;
  const [upOwner, upRepo] = policy.action.split('/');
  const upstream = { owner: upOwner, repo: upRepo };
  const info = (await github.rest.repos.get(upstream)).data;
  if (info.id !== policy.id || info.full_name !== policy.action || info.archived || info.fork) return;
  const release = (await github.rest.repos.getReleaseByTag({ ...upstream, tag: pin.tag })).data;
  if (release.draft || release.prerelease || !release.published_at || release.tag_name !== pin.tag) return;
  let target = (await github.rest.git.getRef({ ...upstream, ref: 'tags/' + pin.tag })).data.object;
  for (let depth = 0; target.type === 'tag' && depth < 3; depth++) {
    target = (await github.rest.git.getTag({ ...upstream, tag_sha: target.sha })).data.object;
  }
  if (target.type !== 'commit' || target.sha !== pin.commit) return;
  const state = { number, head: head.sha, base: workflowSha };
  if (parent !== workflowSha) {
    // Never ask the bot to overwrite a maintainer's edit to this consumer.
    const current = leaves(await treeForCommit(workflowSha)).get(change.name);
    if (current?.mode === '100644' && current.sha === change.before) return { ...state, operation: 'rebase' };
    return;
  }
  if (pr.base.sha !== workflowSha || pr.mergeable !== true || pr.mergeable_state !== 'clean') return;
  for (const workflow_id of [318584423, 422035428]) {
    const runs = (await github.rest.actions.listWorkflowRuns({
      ...args, workflow_id, event: 'pull_request', head_sha: head.sha, per_page: 100,
    })).data;
    if (!runs.total_count || runs.total_count !== runs.workflow_runs.length) return;
    const latest = [...runs.workflow_runs].sort((a, b) => b.id - a.id)[0];
    if (latest.repository?.id !== repositoryId || latest.head_repository?.id !== repositoryId ||
        latest.head_sha !== head.sha || latest.workflow_id !== workflow_id || latest.event !== 'pull_request' ||
        latest.status !== 'completed' || latest.conclusion !== 'success' ||
        !latest.pull_requests?.some(p => p.number === number && p.base?.sha === workflowSha && p.head?.sha === head.sha)) return;
  }
  return { ...state, operation: 'merge' };
}

export async function reconcile({ github, core, workflowSha, app, number = 0 }) {
  const args = { owner, repo };
  if (!sha.test(workflowSha)) throw Error('Missing workflow SHA.');
  const tip = async () => (await github.rest.git.getRef({ ...args, ref: 'heads/' + base })).data.object.sha;
  if (await tip() !== workflowSha) return;
  const candidates = number ? [number] : (await github.paginate(github.rest.pulls.list, {
    ...args, base, state: 'open', per_page: 100,
  })).filter(isCandidate).map(p => p.number);
  for (const n of candidates) {
    const plan = await inspect(github, n, workflowSha);
    if (!plan) continue;
    core.notice('Validated ' + plan.operation + ' candidate #' + n + ' at ' + plan.head);
    const body = '@dependabot rebase\n\n<!-- action-pin-rebase:' + plan.head + ':' + plan.base + ' -->';
    if (plan.operation === 'rebase') {
      const comments = await github.paginate(github.rest.issues.listComments, { ...args, issue_number: n, per_page: 100 });
      if (comments.some(c => c.user?.id === 359694872 && c.body === body)) continue;
    }
    if (!app) { core.setOutput('number', String(n)); return; }
    if (plan.operation === 'merge') {
      const { snapshot } = await sourceRulesSnapshot(app, args);
      const strict = JSON.parse(snapshot).rules.filter(r => r.type === 'required_status_checks' &&
        r.parameters.strict_required_status_checks_policy).flatMap(r => r.parameters.required_status_checks);
      if (!['Required CI', 'Required Python matrix'].every(name =>
        strict.some(check => check.context === name && check.integration_id === 15368))) {
        throw Error('Required checks must apply to the current base.');
      }
    }
    const current = (await github.rest.pulls.get({ ...args, pull_number: n })).data;
    if (!isCandidate(current) || current.head.sha !== plan.head ||
        !Array.isArray(current.labels) || current.labels.some(label => label.name === 'release:patch') ||
        await tip() !== plan.base) return;
    if (plan.operation === 'merge') {
      if (current.base.sha !== plan.base || current.mergeable_state !== 'clean') return;
      const result = await app.rest.pulls.merge({ ...args, pull_number: n, sha: plan.head, merge_method: 'squash' });
      if (result.data.merged !== true) throw Error('GitHub declined the checked merge.');
    } else {
      await app.rest.issues.createComment({ ...args, issue_number: n, body });
    }
    return;
  }
}
