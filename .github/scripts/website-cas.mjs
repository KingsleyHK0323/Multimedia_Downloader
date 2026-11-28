// OpenAI-Codex_ruleset_architecture: verify a website candidate before one fixed-ref App CAS.
const FULL = 'KingsleyHK0323/Multimedia_Downloader';
const RID = 1251103365;
const OWNER_ID = 157894869;
const OWNER_NODE = 'U_kgDOCWlI1Q';
const OWNER = 'KingsleyHK0323';
const BOT_ID = 359694872;
const BOT = 'kingsley-multimedia-automation[bot]';
const APP_ID = 5868451;
const ACTIONS_ID = 15368;
const WEBSITE_CI_BLOB = '7f8b062f29ee5286ef88c5f5ca4c7c73c5e8dc29';
const TARGET = 'Multimedia_Downloader_Website';
const TEMP = 'automation/protected-workflows';
const SHA = /^[0-9a-f]{40}$/;
const positive = n => Number.isSafeInteger(n) && n > 0;
const oid = v => typeof v === 'string' && SHA.test(v);
const isBot = u => u?.id === BOT_ID && u.login === BOT && u.type === 'Bot';
const isOwner = u => u?.id === OWNER_ID && u.login === OWNER && u.type === 'User';
const safePath = p => typeof p === 'string' && p.length > 0 && !p.startsWith('/') &&
  !p.includes(String.fromCharCode(92)) && [...p].every(c => c.codePointAt(0) >= 32 && c.codePointAt(0) !== 127) &&
  p.split('/').every(part => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git');
const allowed = p => safePath(p) && (p === 'index.html' || p === 'README.md' ||
  p === 'Change Log.md' || p === 'PRODUCT.md' || p.startsWith('src/') || p.startsWith('public/'));
const fail = message => { throw new Error(message); };

export async function reconcileWebsite({ github, app, context, appSlug, workflowSha, now = Date.now() }) {
  const owner = 'KingsleyHK0323', repo = 'Multimedia_Downloader';
  if (context?.repo?.owner !== owner || context.repo.repo !== repo ||
      context.ref !== 'refs/heads/Source_Code' || appSlug !== 'kingsley-multimedia-automation' ||
      !oid(workflowSha) || !Number.isFinite(now)) fail('Unexpected website coordinator context.');
  const getRef = async name => {
    const data = (await github.rest.git.getRef({ owner, repo, ref: 'heads/' + name })).data;
    if (data?.ref !== 'refs/heads/' + name || data.object?.type !== 'commit' || !oid(data.object.sha)) {
      fail('Branch identity is incomplete.');
    }
    return data.object.sha;
  };
  if (await getRef('Source_Code') !== workflowSha) fail('Coordinator revision is not the Source_Code tip.');
  const info = (await app.request('GET /apps/{app_slug}', { app_slug: appSlug })).data;
  const bot = (await app.rest.users.getByUsername({ username: BOT })).data;
  if (info?.id !== APP_ID || info.slug !== appSlug || !isBot(bot)) fail('Automation App identity is invalid.');
  const rulesSnapshot = async () => {
    const repository = (await app.rest.repos.get({ owner, repo })).data;
    if (repository?.id !== RID || repository.full_name !== FULL || repository.fork !== false ||
        typeof repository.node_id !== 'string' || !repository.node_id) fail('Repository identity is invalid.');
    const rules = await app.paginate('GET /repos/{owner}/{repo}/rules/branches/{branch}', {
      owner, repo, branch: TARGET, per_page: 100,
    });
    if (!Array.isArray(rules) || !rules.length || rules.length > 1000 ||
        rules.some(r => !r || !positive(r.ruleset_id) ||
          !['Repository', 'Organization'].includes(r.ruleset_source_type) ||
          typeof r.ruleset_source !== 'string' || typeof r.type !== 'string')) fail('Website rules are incomplete.');
    const details = [];
    for (const id of [...new Set(rules.map(r => r.ruleset_id))].sort((a, b) => a - b)) {
      const d = (await app.request('GET /repos/{owner}/{repo}/rulesets/{ruleset_id}', {
        owner, repo, ruleset_id: id, includes_parents: true,
      })).data;
      if (d?.id !== id || d.target !== 'branch' || d.enforcement !== 'active' ||
          d.current_user_can_bypass !== 'never' || !Array.isArray(d.rules)) {
        fail('An applicable website ruleset is unavailable or bypassable by the App.');
      }
      details.push({ id, enforcement: d.enforcement, current_user_can_bypass: d.current_user_can_bypass,
        rules: d.rules, conditions: d.conditions });
    }
    if (!rules.some(r => r.type === 'non_fast_forward') ||
        rules.some(r => r.type === 'pull_request' || r.type === 'update')) {
      fail('Website rules must forbid force pushes and permit checked direct updates.');
    }
    let required = false;
    for (const r of rules.filter(r => r.type === 'required_status_checks')) {
      const p = r.parameters;
      if (!p || typeof p.strict_required_status_checks_policy !== 'boolean' ||
          !Array.isArray(p.required_status_checks) || !p.required_status_checks.length) fail('Website check rules are incomplete.');
      if (p.required_status_checks.some(c => c?.context === 'Required Website build' && c.integration_id === ACTIONS_ID)) {
        required = true;
      }
    }
    if (!required) fail('Required Website build from GitHub Actions is not active.');
    return { node: repository.node_id, snapshot: JSON.stringify({
      rules: [...rules].sort((a, b) => a.ruleset_id - b.ruleset_id || a.type.localeCompare(b.type)), details,
    }) };
  };
  const list = async params => {
    const data = await github.paginate(github.rest.pulls.list, { owner, repo, state: 'open', per_page: 100, ...params });
    if (!Array.isArray(data) || data.length > 1000) fail('Open PR inventory is incomplete.');
    return data;
  };
  const prOpen = await list({ base: TARGET });
  const candidates = prOpen.filter(p => isOwner(p?.user) && p.head?.ref === TEMP &&
    p.head?.repo?.id === RID && p.head.repo.full_name === FULL);
  if (candidates.length === 0) return { status: 'idle' };
  if (candidates.length !== 1 || !positive(candidates[0].number)) fail('Website PR identity is ambiguous.');
  const number = candidates[0].number;
  // The timeline is authoritative for PR state transitions, not for the contents of H.
  const inspectTimeline = async (number, head, expectedUpdatedAt) => {
    const restricted = new Set(['BaseRefChangedEvent', 'ReopenedEvent', 'ReadyForReviewEvent', 'ConvertToDraftEvent']);
    const forbidden = new Set(['AutomaticBaseChangeFailedEvent', 'AutomaticBaseChangeSucceededEvent',
      'BaseRefDeletedEvent', 'BaseRefForcePushedEvent', 'HeadRefDeletedEvent', 'HeadRefForcePushedEvent',
      'HeadRefRestoredEvent', 'MergedEvent', 'AutoMergeEnabledEvent', 'AddedToMergeQueueEvent']);
    const benign = new Set(['AddedToProjectEvent', 'AddedToProjectV2Event', 'AddedToStackEvent',
      'AssignedEvent', 'AutoMergeDisabledEvent', 'AutoRebaseEnabledEvent', 'AutoSquashEnabledEvent',
      'BlockedByAddedEvent', 'BlockedByRemovedEvent', 'BlockingAddedEvent', 'BlockingRemovedEvent',
      'ClosedEvent', 'CommentDeletedEvent', 'ConnectedEvent', 'ConvertedFromDraftEvent',
      'ConvertedNoteToIssueEvent', 'ConvertedToDiscussionEvent', 'CrossReferencedEvent', 'DemilestonedEvent',
      'DeployedEvent', 'DeploymentEnvironmentChangedEvent', 'DisconnectedEvent', 'IssueComment',
      'IssueCommentPinnedEvent', 'IssueCommentUnpinnedEvent', 'IssueFieldAddedEvent', 'IssueFieldChangedEvent',
      'IssueFieldRemovedEvent', 'IssueTypeAddedEvent', 'IssueTypeChangedEvent', 'IssueTypeRemovedEvent',
      'LabeledEvent', 'LockedEvent', 'MarkedAsDuplicateEvent', 'MentionedEvent', 'MilestonedEvent',
      'MovedColumnsInProjectEvent', 'ParentIssueAddedEvent', 'ParentIssueRemovedEvent', 'PinnedEvent',
      'ProjectV2ItemStatusChangedEvent', 'PullRequestCommit', 'PullRequestCommitCommentThread',
      'PullRequestReview', 'PullRequestReviewThread', 'PullRequestRevisionMarker', 'ReferencedEvent',
      'RemovedFromMergeQueueEvent', 'RemovedFromProjectEvent', 'RemovedFromProjectV2Event',
      'RemovedFromStackEvent', 'RenamedTitleEvent', 'ReviewDismissedEvent', 'ReviewRequestRemovedEvent',
      'ReviewRequestedEvent', 'SubIssueAddedEvent', 'SubIssueRemovedEvent', 'SubscribedEvent',
      'TransferredEvent', 'UnassignedEvent', 'UnlabeledEvent', 'UnlockedEvent', 'UnmarkedAsDuplicateEvent',
      'UnpinnedEvent', 'UnsubscribedEvent', 'UserBlockedEvent']);
    const actorFields = 'id createdAt actor { __typename login ... on User { id } }';
    const fragments = [
      '... on BaseRefChangedEvent { ' + actorFields + ' previousRefName currentRefName }',
      '... on ReopenedEvent { ' + actorFields + ' }',
      '... on ReadyForReviewEvent { ' + actorFields + ' }',
      '... on ConvertToDraftEvent { ' + actorFields + ' }',
    ].join(' ');
    const query = 'query($owner:String!, $repo:String!, $number:Int!, $cursor:String) {' +
      ' repository(owner:$owner, name:$repo) { nameWithOwner pullRequest(number:$number) {' +
      ' number state isDraft headRefOid baseRefName updatedAt timelineItems(first:100, after:$cursor) {' +
      ' totalCount updatedAt nodes { __typename ' + fragments + ' } pageInfo { hasNextPage endCursor }' +
      ' } } } }';
    let cursor = null, total, revision;
    const all = [], ids = new Set(), cursors = new Set();
    for (let page = 1; page <= 10; page++) {
      const data = await github.graphql(query, { owner, repo, number, cursor });
      const pr = data?.repository?.pullRequest, conn = pr?.timelineItems;
      if (data?.repository?.nameWithOwner !== FULL || pr?.number !== number || pr.state !== 'OPEN' ||
          pr.isDraft !== false || pr.headRefOid !== head || pr.baseRefName !== TARGET ||
          typeof pr.updatedAt !== 'string' || pr.updatedAt !== expectedUpdatedAt ||
          !conn || !Number.isSafeInteger(conn.totalCount) || conn.totalCount < 0 ||
          conn.totalCount > 1000 || typeof conn.updatedAt !== 'string' ||
          !Number.isFinite(Date.parse(conn.updatedAt)) || !Array.isArray(conn.nodes) ||
          conn.nodes.length > 100 || typeof conn.pageInfo?.hasNextPage !== 'boolean' ||
          (total !== undefined && total !== conn.totalCount) ||
          (revision !== undefined && revision !== conn.updatedAt)) {
        fail('Website PR timeline is incomplete or changed.');
      }
      total = conn.totalCount; revision = conn.updatedAt;
      for (const item of conn.nodes) {
        if (!item || typeof item.__typename !== 'string') fail('A website timeline item is incomplete.');
        if (forbidden.has(item.__typename)) fail('Website PR has an unsafe ref or merge event.');
        if (!restricted.has(item.__typename) && !benign.has(item.__typename)) fail('Website timeline has an unknown event.');
        if (restricted.has(item.__typename)) {
          if (typeof item.id !== 'string' || !item.id || ids.has(item.id) ||
              typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt)) ||
              item.actor?.__typename !== 'User' || item.actor.login !== OWNER ||
              item.actor.id !== OWNER_NODE) fail('Website PR transition was not made by the owner.');
          ids.add(item.id);
          if (item.__typename === 'BaseRefChangedEvent' &&
              (typeof item.previousRefName !== 'string' || !item.previousRefName ||
               typeof item.currentRefName !== 'string' || !item.currentRefName)) {
            fail('Website base-change event is incomplete.');
          }
        }
        all.push(item);
      }
      if (!conn.pageInfo.hasNextPage) {
        if (all.length !== total) fail('Website PR timeline count is incomplete.');
        let state = 'OPEN';
        const baseChanges = [];
        for (const item of all) {
          if (item.__typename === 'ClosedEvent') state = 'CLOSED';
          if (item.__typename === 'ReopenedEvent') {
            if (state !== 'CLOSED') fail('Website PR reopen history is inconsistent.');
            state = 'OPEN';
          }
          if (item.__typename === 'BaseRefChangedEvent') baseChanges.push(item);
        }
        if (state !== 'OPEN') fail('Website PR open history is inconsistent.');
        for (let i = 1; i < baseChanges.length; i++) {
          if (baseChanges[i - 1].currentRefName !== baseChanges[i].previousRefName) {
            fail('Website PR base-change history is inconsistent.');
          }
        }
        if (baseChanges.length && baseChanges.at(-1).currentRefName !== TARGET) {
          fail('The latest website base-change event does not match the current base.');
        }
        return JSON.stringify({ updatedAt: pr.updatedAt, revision, total, events: all });
      }
      if (conn.nodes.length !== 100 || typeof conn.pageInfo.endCursor !== 'string' ||
          !conn.pageInfo.endCursor || cursors.has(conn.pageInfo.endCursor)) {
        fail('Website PR timeline cursor is invalid.');
      }
      cursors.add(conn.pageInfo.endCursor);
      cursor = conn.pageInfo.endCursor;
    }
    fail('Website PR timeline exceeds its safe limit.');
  };
  const inspect = async () => {
    if (await getRef('Source_Code') !== workflowSha) fail('Coordinator revision changed.');
    const pr = (await github.rest.pulls.get({ owner, repo, pull_number: number })).data;
    if (!pr || pr.number !== number || pr.state !== 'open' || pr.draft !== false || pr.merged !== false ||
        !isOwner(pr.user) || pr.head?.ref !== TEMP || pr.base?.ref !== TARGET ||
        pr.head?.repo?.id !== RID || pr.head.repo.full_name !== FULL ||
        pr.base?.repo?.id !== RID || pr.base.repo.full_name !== FULL ||
        !oid(pr.head.sha) || !oid(pr.base.sha) || pr.auto_merge !== null ||
        pr.html_url !== 'https://github.com/' + FULL + '/pull/' + number ||
        typeof pr.updated_at !== 'string' || !Number.isFinite(Date.parse(pr.updated_at)) ||
        !Array.isArray(pr.labels) || pr.labels.some(x => typeof x?.name !== 'string' ||
          x.name.toLowerCase() === 'release:patch') || !positive(pr.changed_files) || pr.changed_files > 1000) {
      fail('Website PR identity or metadata is unsafe.');
    }
    const B = await getRef(TARGET), H = await getRef(TEMP);
    if (B !== pr.base.sha || H !== pr.head.sha || B === H) fail('Website base or temporary head changed.');
    const [byHead, byBase] = await Promise.all([list({ head: owner + ':' + TEMP }), list({ base: TEMP })]);
    if (byHead.length !== 1 || byHead[0].number !== number || byBase.length !== 0) {
      fail('The temporary branch is used by another open PR.');
    }
    const linked = await github.graphql(
      'query($owner:String!, $repo:String!, $ref:String!) {' +
      ' repository(owner:$owner, name:$repo) { nameWithOwner ref(qualifiedName:$ref) {' +
      ' name prefix target { oid } associatedPullRequests(first:2, states:[OPEN]) {' +
      ' totalCount nodes { number repository { nameWithOwner databaseId } } pageInfo { hasNextPage } } } } }',
      { owner, repo, ref: 'refs/heads/' + TEMP },
    );
    const ref = linked?.repository?.ref, connection = ref?.associatedPullRequests;
    if (linked?.repository?.nameWithOwner !== FULL || ref?.name !== TEMP || ref.prefix !== 'refs/heads/' ||
        ref.target?.oid !== H || connection?.totalCount !== 1 || connection.pageInfo?.hasNextPage !== false ||
        !Array.isArray(connection.nodes) || connection.nodes.length !== 1 ||
        connection.nodes[0]?.number !== number || connection.nodes[0]?.repository?.nameWithOwner !== FULL ||
        connection.nodes[0]?.repository?.databaseId !== RID) {
      fail('Temporary branch associations are incomplete or another open PR uses it.');
    }
    const timeline = await inspectTimeline(number, H, pr.updated_at);
    const candidateCommit = (await github.rest.repos.getCommit({ owner, repo, ref: H })).data;
    if (candidateCommit?.sha !== H || !Array.isArray(candidateCommit.parents) || candidateCommit.parents.length !== 1 ||
        candidateCommit.parents[0]?.sha !== B) fail('Candidate is not a single-parent commit on the website base.');
    const [baseCommit, headCommit] = await Promise.all([
      github.rest.git.getCommit({ owner, repo, commit_sha: B }),
      github.rest.git.getCommit({ owner, repo, commit_sha: H }),
    ]);
    const bc = baseCommit.data, hc = headCommit.data;
    if (bc?.sha !== B || !oid(bc.tree?.sha) || hc?.sha !== H || !oid(hc.tree?.sha) ||
        candidateCommit.commit?.tree?.sha !== hc.tree.sha || !Array.isArray(hc.parents) ||
        hc.parents.length !== 1 || hc.parents[0]?.sha !== B) fail('Website Git commit objects are inconsistent.');
    const before = (await github.rest.git.getTree({ owner, repo, tree_sha: bc.tree.sha, recursive: '1' })).data;
    const after = (await github.rest.git.getTree({ owner, repo, tree_sha: hc.tree.sha, recursive: '1' })).data;
    const inventory = (d, expected) => {
      if (!d || d.sha !== expected || d.truncated !== false || !Array.isArray(d.tree) ||
          d.tree.length > 100000) fail('Website tree inventory is incomplete.');
      const m = new Map();
      for (const x of d.tree) {
        if (!x || typeof x.path !== 'string' || !x.path || m.has(x.path) || !oid(x.sha) ||
            !['tree', 'blob', 'commit'].includes(x.type) || typeof x.mode !== 'string') fail('Website tree is malformed.');
        m.set(x.path, x);
      }
      return m;
    };
    const a = inventory(before, bc.tree.sha), z = inventory(after, hc.tree.sha);
    const ag = a.get('.github'), zg = z.get('.github');
    if (ag?.type !== 'tree' || zg?.type !== 'tree' || ag.mode !== '040000' || zg.mode !== '040000' ||
        ag.sha !== zg.sha) fail('Website automation was changed.');
    const ci = a.get('.github/workflows/website-ci.yml');
    if (ci?.type !== 'blob' || ci.mode !== '100644' || ci.sha !== WEBSITE_CI_BLOB ||
        z.get('.github/workflows/website-ci.yml')?.sha !== WEBSITE_CI_BLOB) {
      fail('Website CI is not the independently trusted workflow.');
    }
    const changed = new Set();
    for (const path of new Set([...a.keys(), ...z.keys()])) {
      const old = a.get(path), next = z.get(path);
      if (old?.type === 'tree' || next?.type === 'tree') {
        if ((old && old.type !== 'tree') || (next && next.type !== 'tree') ||
            ((!old || !next) && (!safePath(path) || !(path === 'src' || path.startsWith('src/') ||
              path === 'public' || path.startsWith('public/'))))) fail('Website directory changed unexpectedly.');
        continue;
      }
      if (old?.sha === next?.sha && old?.type === next?.type && old?.mode === next?.mode) continue;
      if (!allowed(path) || [old, next].some(x => x && (x.type !== 'blob' || !['100644', '100755'].includes(x.mode)))) {
        fail('Website candidate changes an unapproved path or object.');
      }
      changed.add(path);
    }
    if (!changed.size || changed.size > 1000) fail('Website change inventory is empty or too large.');
    const files = await github.paginate(github.rest.pulls.listFiles, { owner, repo, pull_number: number, per_page: 100 });
    if (!Array.isArray(files) || files.length !== pr.changed_files || files.length > 1000) fail('Website PR file list is incomplete.');
    const listed = new Set();
    for (const f of files) {
      if (!f || !['added', 'removed', 'modified', 'renamed'].includes(f.status) ||
          typeof f.filename !== 'string' || !changed.has(f.filename) || listed.has(f.filename)) fail('Unexpected website PR file.');
      listed.add(f.filename);
      if (f.status === 'renamed') {
        if (typeof f.previous_filename !== 'string' || !changed.has(f.previous_filename) || listed.has(f.previous_filename)) {
          fail('Website rename metadata is invalid.');
        }
        listed.add(f.previous_filename);
      } else if (f.previous_filename !== undefined) fail('Unexpected previous filename.');
    }
    if (listed.size !== changed.size || [...changed].some(p => !listed.has(p))) fail('PR file and tree inventories differ.');
    return { number, B, H, githubTree: ag.sha, timeline, changes: [...changed].sort() };
  };
  const checks = async H => {
    const all = [];
    let total;
    for (let page = 1; page <= 10; page++) {
      const d = (await github.rest.actions.listWorkflowRunsForRepo({
        owner, repo, event: 'push', head_sha: H, per_page: 100, page,
      })).data;
      if (!d || !Number.isSafeInteger(d.total_count) || d.total_count < 0 || d.total_count > 1000 ||
          !Array.isArray(d.workflow_runs) || d.workflow_runs.length > 100 ||
          (total !== undefined && total !== d.total_count)) fail('Website push run inventory is incomplete.');
      total = d.total_count;
      all.push(...d.workflow_runs);
      if (all.length >= total) break;
      if (d.workflow_runs.length !== 100) fail('Website push run page is incomplete.');
    }
    if (all.length !== total || new Set(all.map(r => r?.id)).size !== all.length) fail('Website push runs are ambiguous.');
    const runs = all.filter(r => r?.path === '.github/workflows/website-ci.yml' && r.head_sha === H && r.head_branch === TEMP);
    if (runs.length === 0) return null;
    if (runs.length !== 1) fail('Multiple website push runs are ambiguous.');
    const r = runs[0];
    if (['queued', 'in_progress', 'waiting', 'requested', 'pending'].includes(r.status)) return null;
    if (!positive(r.id) || r.name !== 'Website build check' || r.workflow_id !== 426421851 ||
        r.event !== 'push' || !isOwner(r.actor) || r.repository?.id !== RID ||
        r.repository.full_name !== FULL || r.head_repository?.id !== RID || r.head_repository.full_name !== FULL ||
        r.status !== 'completed' || r.conclusion !== 'success' || !positive(r.run_attempt) || r.run_attempt > 10) {
      fail('Website push run is not a successful owner run.');
    }
    let selected = null;
    const seen = new Set();
    for (let attempt = 1; attempt <= r.run_attempt; attempt++) {
      const d = (await github.rest.actions.listJobsForWorkflowRunAttempt({
        owner, repo, run_id: r.id, attempt_number: attempt, per_page: 100,
      })).data;
      if (!d || !positive(d.total_count) || d.total_count > 100 || !Array.isArray(d.jobs) || d.jobs.length !== d.total_count) {
        fail('Website job attempt is incomplete.');
      }
      const names = new Set();
      for (const j of d.jobs) {
        if (!positive(j?.id) || seen.has(j.id) || j.run_id !== r.id || j.head_sha !== H ||
            (j.run_attempt !== undefined && j.run_attempt !== attempt) || typeof j.name !== 'string' ||
            names.has(j.name)) fail('Website job identity is ambiguous.');
        seen.add(j.id); names.add(j.name);
        if (j.name === 'Required Website build') selected = { job: j, attempt };
      }
    }
    const job = selected?.job;
    if (!job || job.status !== 'completed' || job.conclusion !== 'success') fail('Website build job did not succeed.');
    const prefix = 'https://api.github.com/repos/' + FULL + '/check-runs/';
    const id = typeof job.check_run_url === 'string' && job.check_run_url.startsWith(prefix)
      ? job.check_run_url.slice(prefix.length) : '';
    if (!/^[1-9][0-9]*$/.test(id) || !positive(Number(id))) fail('Website check-run URL is invalid.');
    const c = (await github.rest.checks.get({ owner, repo, check_run_id: Number(id) })).data;
    const age = now - Date.parse(c?.completed_at);
    if (c?.id !== Number(id) || c.name !== 'Required Website build' || c.head_sha !== H ||
        c.app?.id !== ACTIONS_ID || c.status !== 'completed' || c.conclusion !== 'success' ||
        !Number.isFinite(age) || age < -60000 || age > 6 * 24 * 60 * 60 * 1000) fail('Website check is untrusted or stale.');
    return { run: r.id, attempt: r.run_attempt, job: job.id, check: c.id, completed: c.completed_at };
  };
  const r1 = await rulesSnapshot(), p1 = await inspect(), c1 = await checks(p1.H);
  if (c1 === null) return { status: 'waiting-for-checks', pr: number, head: p1.H };
  const r2 = await rulesSnapshot(), p2 = await inspect(), c2 = await checks(p2.H);
  if (JSON.stringify([r1, p1, c1]) !== JSON.stringify([r2, p2, c2])) fail('Website rules, PR or check changed.');
  const r3 = await rulesSnapshot(), p3 = await inspect(), c3 = await checks(p3.H);
  if (JSON.stringify([r1, p1, c1]) !== JSON.stringify([r3, p3, c3])) fail('Website state changed before update.');
  const result = await app.graphql(
    'mutation($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }',
    { input: { repositoryId: r1.node, clientMutationId: 'website-' + number + '-' + p1.H,
      refUpdates: [{ name: 'refs/heads/' + TARGET, beforeOid: p1.B, afterOid: p1.H, force: false }] } },
  );
  if (result?.updateRefs?.clientMutationId !== 'website-' + number + '-' + p1.H || await getRef(TARGET) !== p1.H) {
    fail('GitHub did not confirm the exact website ref update.');
  }
  return { status: 'updated', pr: number, head: p1.H };
}
