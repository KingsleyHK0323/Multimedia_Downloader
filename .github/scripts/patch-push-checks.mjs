// OpenAI-Codex_health_release_architecture: verify exact App push checks before any fixed-ref update.
const FULL_NAME = 'KingsleyHK0323/Multimedia_Downloader';
const REPO_ID = 1251103365;
const BOT_ID = 359694872;
const BOT_LOGIN = 'kingsley-multimedia-automation[bot]';
const BRANCH = 'automation/protected-workflows';
const ACTIONS_APP_ID = 15368;
const SHA = /^[0-9a-f]{40}$/;
const positive = x => Number.isSafeInteger(x) && x > 0;
const isBot = user => user?.id === BOT_ID && user.login === BOT_LOGIN && user.type === 'Bot';

export async function sourceRulesSnapshot(app, { owner, repo }) {
  if (owner + '/' + repo !== FULL_NAME) throw new Error('Unexpected repository.');
  const repository = (await app.rest.repos.get({ owner, repo })).data;
  if (repository?.id !== REPO_ID || repository.full_name !== FULL_NAME ||
      typeof repository.node_id !== 'string' || !repository.node_id || repository.fork !== false) {
    throw new Error('Repository identity is incomplete.');
  }
  const rules = await app.paginate('GET /repos/{owner}/{repo}/rules/branches/{branch}', {
    owner, repo, branch: 'Source_Code', per_page: 100,
  });
  if (!Array.isArray(rules) || rules.length < 1 || rules.length > 1000 ||
      rules.some(rule => !rule || !positive(rule.ruleset_id) ||
        !['Repository', 'Organization'].includes(rule.ruleset_source_type) ||
        typeof rule.ruleset_source !== 'string' || typeof rule.type !== 'string')) {
    throw new Error('Active Source_Code rules are incomplete.');
  }
  const details = [];
  for (const id of [...new Set(rules.map(rule => rule.ruleset_id))].sort((a, b) => a - b)) {
    const detail = (await app.request('GET /repos/{owner}/{repo}/rulesets/{ruleset_id}', {
      owner, repo, ruleset_id: id, includes_parents: true,
    })).data;
    if (detail?.id !== id || detail.enforcement !== 'active' || detail.target !== 'branch' ||
        detail.current_user_can_bypass !== 'never' || !Array.isArray(detail.rules)) {
      throw new Error('An active Source_Code ruleset is unavailable or bypassable by the App.');
    }
    details.push({ id, rules: detail.rules, enforcement: detail.enforcement,
      current_user_can_bypass: detail.current_user_can_bypass, conditions: detail.conditions });
  }
  if (!rules.some(rule => rule.type === 'non_fast_forward') ||
      rules.some(rule => rule.type === 'pull_request' || rule.type === 'update')) {
    throw new Error('Source_Code must forbid force pushes and permit checked direct updates.');
  }
  const protectedChecks = new Set();
  for (const rule of rules.filter(rule => rule.type === 'required_status_checks')) {
    const params = rule.parameters;
    if (!params || typeof params.strict_required_status_checks_policy !== 'boolean' ||
        !Array.isArray(params.required_status_checks) || params.required_status_checks.length === 0) {
      throw new Error('A required-check rule is incomplete.');
    }
    for (const check of params.required_status_checks) {
      if (check?.integration_id === ACTIONS_APP_ID &&
          ['Required CI', 'Required Python matrix'].includes(check.context)) protectedChecks.add(check.context);
    }
  }
  if (!protectedChecks.has('Required CI') || !protectedChecks.has('Required Python matrix')) {
    throw new Error('Required CI and matrix checks from GitHub Actions are not active.');
  }
  return { nodeId: repository.node_id, snapshot: JSON.stringify({
    rules: [...rules].sort((a, b) => a.ruleset_id - b.ruleset_id || a.type.localeCompare(b.type)),
    details,
  }) };
}

export async function requiredPushChecks(github, { owner, repo, head, branch = BRANCH, now = Date.now() }) {
  if (owner + '/' + repo !== FULL_NAME || !SHA.test(head || '') ||
      ![BRANCH, 'Source_Code'].includes(branch) ||
      !Number.isFinite(now)) throw new Error('Unexpected repository, head, branch, or time.');
  const runs = [];
  const seen = new Set();
  let total;
  for (let page = 1; page <= 10; page++) {
    const data = (await github.rest.actions.listWorkflowRunsForRepo({
      owner, repo, event: 'push', head_sha: head, per_page: 100, page,
    })).data;
    if (!data || !Number.isSafeInteger(data.total_count) || data.total_count < 0 || data.total_count > 1000 ||
        !Array.isArray(data.workflow_runs) || data.workflow_runs.length > 100 ||
        (total !== undefined && data.total_count !== total)) throw new Error('Push run pagination is incomplete.');
    total = data.total_count;
    for (const run of data.workflow_runs) {
      if (!positive(run?.id) || seen.has(run.id)) throw new Error('Push run identity is ambiguous.');
      seen.add(run.id);
      runs.push(run);
    }
    if (runs.length >= total) break;
    if (data.workflow_runs.length !== 100) throw new Error('Push run page is incomplete.');
  }
  if (runs.length !== total) throw new Error('Push run count is incomplete.');
  const expectedRuns = [
    ['.github/workflows/ci.yml', 'CI', 318584423],
    ['.github/workflows/python-matrix.yml', 'Python matrix tests', 422035428],
  ];
  const selected = expectedRuns.map(([path, name, workflowId]) => {
    const matches = runs.filter(run => run?.path === path && run.head_sha === head && run.head_branch === branch);
    if (matches.length === 0) return null;
    if (matches.length !== 1) throw new Error('Multiple matching push runs are ambiguous.');
    const run = matches[0];
    if (['queued', 'in_progress', 'waiting', 'requested', 'pending'].includes(run.status)) return null;
    const age = now - Date.parse(run.created_at);
    if (run.name !== name || run.workflow_id !== workflowId || run.event !== 'push' || !isBot(run.actor) ||
        run.repository?.id !== REPO_ID || run.repository.full_name !== FULL_NAME ||
        run.head_repository?.id !== REPO_ID || run.head_repository.full_name !== FULL_NAME ||
        run.status !== 'completed' || run.conclusion !== 'success' ||
        !positive(run.run_attempt) || run.run_attempt > 10 ||
        !Number.isFinite(age) || age < -60000) {
      throw new Error('The exact App push run is not trusted and successful.');
    }
    return { id: run.id, attempt: run.run_attempt, path, head };
  });
  if (selected.some(run => run === null)) return null;

  const contextName = 'dependabot-context-' + head + '-' + head + '-' + head;
  const ciNames = [contextName, 'Required CI', 'version-consistency', 'auto-format-guard',
    'release-input-guard', 'lint', 'python-tests', 'frontend-check', 'rust-check'];
  const matrixNames = [contextName, 'Required Python matrix'];
  for (const os of ['ubuntu-22.04', 'macos-15', 'windows-latest']) {
    for (const version of ['3.10', '3.11', '3.12', '3.13', '3.14']) {
      matrixNames.push('python-tests (' + os + ', ' + version + ')');
    }
  }
  const collect = async (run, required) => {
    const latest = new Map(), ids = new Set();
    for (let attempt = 1; attempt <= run.attempt; attempt++) {
      const data = (await github.rest.actions.listJobsForWorkflowRunAttempt({
        owner, repo, run_id: run.id, attempt_number: attempt, per_page: 100,
      })).data;
      if (!data || !positive(data.total_count) || data.total_count > 100 ||
          !Array.isArray(data.jobs) || data.jobs.length !== data.total_count) {
        throw new Error('Workflow attempt job list is incomplete.');
      }
      const names = new Set();
      for (const job of data.jobs) {
        if (!positive(job?.id) || ids.has(job.id) || job.run_id !== run.id || job.head_sha !== head ||
            (job.run_attempt !== undefined && job.run_attempt !== attempt) ||
            typeof job.name !== 'string' || names.has(job.name)) throw new Error('Job identity is incomplete.');
        ids.add(job.id); names.add(job.name); latest.set(job.name, { job, attempt });
      }
    }
    const evidence = [];
    for (const name of required) {
      const item = latest.get(name), job = item?.job;
      if (!job || job.status !== 'completed' || job.conclusion !== 'success') {
        throw new Error('Required job did not succeed: ' + name);
      }
      const prefix = 'https://api.github.com/repos/' + FULL_NAME + '/check-runs/';
      const suffix = typeof job.check_run_url === 'string' && job.check_run_url.startsWith(prefix)
        ? job.check_run_url.slice(prefix.length) : '';
      const checkId = Number(suffix);
      if (!/^[1-9][0-9]*$/.test(suffix) || !positive(checkId)) throw new Error('Invalid check-run URL.');
      const check = (await github.rest.checks.get({ owner, repo, check_run_id: checkId })).data;
      if (check?.id !== checkId || check.name !== name || check.head_sha !== head ||
          check.status !== 'completed' || check.conclusion !== 'success' ||
          check.app?.id !== ACTIONS_APP_ID) throw new Error('Required check-run is not trusted: ' + name);
      const completedAge = now - Date.parse(check.completed_at);
      if (!Number.isFinite(completedAge) || completedAge < -60000 || completedAge > 6 * 24 * 60 * 60 * 1000) {
        throw new Error('Required check-run is not recent: ' + name);
      }
      evidence.push({ name, jobId: job.id, checkId, attempt: item.attempt, completed_at: check.completed_at });
    }
    return evidence;
  };
  const evidence = await Promise.all([collect(selected[0], ciNames), collect(selected[1], matrixNames)]);
  return { runs: selected, evidence };
}
