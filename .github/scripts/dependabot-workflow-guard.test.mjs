// OpenAI-Codex: offline tests for the Dependabot auto-merge guard.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Insert after the existing workflow_files check and before gh pr merge.
export const guard = String.raw`
if ! guard_pr="$(gh api "repos/$GH_REPO/pulls/$pr_number")" ||
   ! guard_pages="$(gh api --paginate --slurp "repos/$GH_REPO/pulls/$pr_number/files?per_page=100")"; then
  echo "::warning::Cannot inspect every PR file; skipping merge."
  exit 0
fi
if ! printf '%s\0%s' "$guard_pr" "$guard_pages" | node -e '
  const fs = require("fs");
  try {
    const parts = fs.readFileSync(0, "utf8").split("\0");
    if (parts.length !== 2) process.exit(1);
    const pr = JSON.parse(parts[0]);
    const pages = JSON.parse(parts[1]);
    if (pr.state !== "open" || pr.base?.ref !== "Source_Code" ||
        pr.head?.sha !== process.env.HEAD_SHA ||
        !Number.isInteger(pr.changed_files) || pr.changed_files < 1 || pr.changed_files > 3000 ||
        !Array.isArray(pages) || !pages.every(Array.isArray)) process.exit(1);
    const files = pages.flat();
    if (files.length !== pr.changed_files) process.exit(1);
    // OpenAI-Codex_ruleset_architecture: allow only the existing dependency manifests.
    const unsafe = p => p.startsWith(".github/");
    const allowed = new Set([
      "package.json", "package-lock.json",
      "frontend/package.json", "frontend/package-lock.json",
      "engine/requirements.txt", "requirements-dev.txt", "requirements-tui.txt", "requirements-web.txt",
      "src-tauri/Cargo.toml", "src-tauri/Cargo.lock",
    ]);
    if (new Set(files.map(f => f?.filename)).size !== files.length ||
        !files.every(f => f && typeof f.filename === "string" &&
          f.status === "modified" && f.previous_filename === undefined &&
          !unsafe(f.filename) && allowed.has(f.filename))) process.exit(1);
  } catch { process.exit(1); }
'; then
  echo "::warning::PR file list or identity is unsafe or incomplete; skipping merge."
  exit 0
fi
`;

const sha = 'a'.repeat(40);
// OpenAI-Codex_ruleset_architecture: only currently configured manifests may change.
const allowed = [
  'package.json', 'package-lock.json', 'frontend/package.json', 'frontend/package-lock.json',
  'engine/requirements.txt', 'requirements-dev.txt', 'requirements-tui.txt', 'requirements-web.txt',
  'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock',
];
const normal = i => ({ filename: allowed[i % allowed.length], status: 'modified' });
const workflow = await readFile(new URL('../workflows/dependabot-auto-merge.yml', import.meta.url), 'utf8');
const start = 'if ! guard_pr=';
const end = 'PR file list or identity is unsafe or incomplete; skipping merge.';
assert.equal(workflow.split(start).length, 2, 'expected exactly one actual guard in workflow');
const actualGuard = workflow.split(start)[1].split('\n')
  .map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
assert.equal(actualGuard.split(end).length, 2, 'expected exactly one guard terminator');
const guardEnd = actualGuard.indexOf('\nfi', actualGuard.indexOf(end));
assert.notEqual(guardEnd, -1, 'expected guard closing fi');
const actualShellGuard = start + actualGuard.slice(0, guardEnd + '\nfi'.length);
assert.equal(actualShellGuard.split("| node -e '\n").length, 2, 'expected actual Node validator');
assert.equal(actualShellGuard.split("\n'; then").length, 2, 'expected validator terminator');
const validator = actualShellGuard.split("| node -e '\n")[1].split("\n'; then")[0];

function check(pages, options = {}) {
  const files = pages.flat();
  const pr = { state: 'open', base: { ref: 'Source_Code' }, head: { sha }, changed_files: files.length, ...options.pr };
  // Model the shell's API error short circuit; no API or merge is invoked.
  if (options.failPr || options.failFiles) return false;
  const result = spawnSync(process.execPath, ['-e', validator], {
    encoding: 'utf8', input: `${JSON.stringify(pr)}\0${JSON.stringify(pages)}`,
    env: { ...process.env, HEAD_SHA: sha },
  });
  assert.equal(result.error, undefined);
  return result.status === 0;
}

test('only configured dependency manifests can reach the mocked update', () => {
  for (const file of allowed) assert.equal(check([[{ filename: file, status: 'modified' }]]), true);
  assert.equal(check([allowed.map((_, i) => normal(i))]), true);
  assert.equal(check([[normal(0), normal(0)]]), false);
  for (const status of ['added', 'removed', 'renamed', 'changed']) {
    assert.equal(check([[{ filename: 'package.json', status }]]), false);
  }
  for (const file of ['engine/downloader.py', 'scripts/setup.py', 'packaging/npm/package.json', '.github/dependabot.yml']) {
    assert.equal(check([[{ filename: file, status: 'modified' }]]), false);
  }
  assert.equal(check([[{ filename: 'package.json', status: 'modified', previous_filename: 'engine/downloader.py' }]]), false);
});

test('workflow and action paths are rejected on any page and either side of a rename', () => {
  for (const file of [
    { filename: '.github/workflows/test.yml', status: 'added' },
    { filename: '.github/actions/task/action.yml', status: 'modified' },
    { filename: '.github/scripts/unsafe.mjs', status: 'modified' },
    { filename: 'deps/new', previous_filename: '.github/workflows/old.yml', status: 'renamed' },
    { filename: '.github/workflows/new.yml', previous_filename: 'deps/old', status: 'renamed' },
  ]) assert.equal(check([Array.from({ length: 100 }, (_, i) => normal(i)), [file]]), false);
});

test('API errors, incomplete lists, malformed renames and stale PR identity fail closed', () => {
  for (const [pages, options] of [
    [[[normal(0)]], { failPr: true }], [[[normal(0)]], { failFiles: true }],
    [[[normal(0)]], { pr: { changed_files: 2 } }],
    [[[normal(0)]], { pr: { changed_files: 3001 } }],
    [[[{ filename: 'deps/new', status: 'renamed' }]], {}],
    [[[normal(0)]], { pr: { head: { sha: 'b'.repeat(40) } } }],
    [[[normal(0)]], { pr: { base: { ref: 'other' } } }],
    [[], {}],
  ]) assert.equal(check(pages, options), false);
});

test('Linux shell guard invokes mocked APIs and stops before the merge sentinel', { skip: process.platform !== 'linux' }, () => {
  const prelude = String.raw`
    set -euo pipefail
    GH_REPO=KingsleyHK0323/Multimedia_Downloader
    pr_number=123
    export HEAD_SHA
    gh() {
      if [ "$1" != api ]; then echo UNEXPECTED_GH; return 1; fi
      if [ "$2" = --paginate ]; then
        [ "$FAIL_FILES" != 1 ] || return 1
        printf '%s' "$PAGES"
      else
        [ "$FAIL_PR" != 1 ] || return 1
        printf '%s' "$PR"
      fi
    }
  `;
  const runShell = (pages, failPr = false, failFiles = false) => {
    const pr = { state: 'open', base: { ref: 'Source_Code' }, head: { sha }, changed_files: pages.flat().length };
    const result = spawnSync('bash', ['--noprofile', '--norc', '-c', `${prelude}\n${actualShellGuard}\necho MERGE_SENTINEL`], {
      encoding: 'utf8', env: { ...process.env, HEAD_SHA: sha, PR: JSON.stringify(pr), PAGES: JSON.stringify(pages), FAIL_PR: failPr ? '1' : '0', FAIL_FILES: failFiles ? '1' : '0' },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /UNEXPECTED_GH/);
    return result.stdout.includes('MERGE_SENTINEL');
  };
  const normalPages = [allowed.slice(0, 5).map((_, i) => normal(i)), allowed.slice(5).map((_, i) => normal(i + 5))];
  assert.equal(runShell(normalPages), true);
  assert.equal(runShell(normalPages, true), false);
  assert.equal(runShell(normalPages, false, true), false);
  assert.equal(runShell([normalPages[0], [{ filename: '.github/workflows/test.yml', status: 'modified' }]]), false);
});


test('update fixes the Source ref and uses non-force expected-head CAS', () => {
  assert.match(workflow, /refUpdates:\[\{name:"refs\/heads\/Source_Code",beforeOid:\$before,afterOid:\$after,force:false\}\]/);
  assert.doesNotMatch(workflow, /gh pr merge/);
  assert.equal(workflow.includes('--admin'), false);
  assert.equal(workflow.includes('--delete-branch'), false);
});


// OpenAI-Codex: exercise the actual same-head workflow-run gate.
test('both latest workflow runs must succeed for the exact PR head', () => {
  const marker = "if ! printf '%s' \"$runs\" | node -e '\n";
  const suffix = "\n          '; then";
  assert.equal(workflow.split(marker).length, 2);
  const validator = workflow.split(marker)[1].split(suffix)[0];
  const base = [
    { id: 1, path: '.github/workflows/ci.yml', head_sha: sha, status: 'completed', conclusion: 'success' },
    { id: 2, path: '.github/workflows/python-matrix.yml', head_sha: sha, status: 'completed', conclusion: 'success' },
  ];
  const accepts = (runs, total = runs.length) => spawnSync(process.execPath, ['-e', validator], {
    encoding: 'utf8', input: JSON.stringify({ total_count: total, workflow_runs: runs }),
    env: { ...process.env, HEAD_SHA: sha },
  }).status === 0;
  assert.equal(accepts(base), true);
  assert.equal(accepts(base.slice(0, 1)), false);
  assert.equal(accepts(base, 101), false);
  assert.equal(accepts([...base, { ...base[0], id: 3, conclusion: 'failure' }]), false);
  assert.equal(accepts([...base, { ...base[1], id: 4, status: 'in_progress', conclusion: null }]), false);
  assert.equal(accepts([base[0], { ...base[1], head_sha: 'b'.repeat(40) }]), false);
});


// OpenAI-Codex: run the actual auto-merge shell with a fully mocked GitHub CLI.
test('auto-merge requires the exact tested head, base and merge context', { skip: process.platform !== 'linux' }, async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const marker = '        run: |\n';
  const sections = workflow.split(marker);
  assert.equal(sections.length, 3);
  const candidate = sections[1].split('\n      - name: Create scoped automation App token\n')[0]
    .split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
  const finalMerge = sections[2].split('\n')
    .map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-workflow-test-'));
  const base = 'b'.repeat(40), merge = 'c'.repeat(40), moved = 'd'.repeat(40);
  const run = ({ failure = false, protectedFile = false, noPr = false,
    baseMoved = false, badContext = false, noJobs = false, badAttempt = false,
    finalBaseMoved = false, retarget = false, finalHeadMoved = false, finalChecksFailed = false,
    bypass = false, noRules = false, staleWorkflow = false, foreignBase = false, foreignHead = false,
    spoofBot = false, badApp = false, badAppBot = false, badRepo = false, forked = false, looseRules = false,
    twoParents = false, wrongParent = false, wrongMergeParents = false, wrongMergeTree = false,
    wrongGithubTree = false, incompleteTree = false, badSignature = false, badCommitAuthor = false,
    badCheckApp = false, failedCheck = false, moreOpenPRs = false, missingAssociated = false,
    badCommitter = false, badRunActor = false, ambiguousInitial = false, incompleteInitial = false,
    executableAllowed = false, symlinkAllowed = false, newPath = false, nonallowedChange = false,
    draftInitial = false, draftFinal = false, draftAssociated = false } = {}) => {
    const log = path.join(root, Math.random().toString(36).slice(2));
    const repo = { id: 1251103365, full_name: 'KingsleyHK0323/Multimedia_Downloader' };
    const pr = { number: 66, state: 'open', draft: draftInitial, user: { login: 'dependabot[bot]', id: 49699333, type: 'Bot' }, mergeable: true,
      base: { ref: 'Source_Code', sha: base, repo }, head: { sha, repo }, merge_commit_sha: merge, changed_files: 1 };
    const rules = noRules ? [] : [
      { ruleset_id: 7, ruleset_source_type: 'Repository', ruleset_source: 'KingsleyHK0323/Multimedia_Downloader', type: 'non_fast_forward' },
      { ruleset_id: 7, ruleset_source_type: 'Repository', ruleset_source: 'KingsleyHK0323/Multimedia_Downloader', type: 'required_status_checks',
        parameters: { strict_required_status_checks_policy: !looseRules, required_status_checks: [
          { context: 'Required CI', integration_id: 15368 }, { context: 'Required Python matrix', integration_id: 15368 },
        ] } },
    ];
    const detail = { id: 7, enforcement: 'active', target: 'branch', current_user_can_bypass: bypass ? 'always' : 'never', rules: [] };
    const runs = { total_count: 2, workflow_runs: [
      { id: 1, run_attempt: badAttempt ? null : 1, workflow_id: 318584423, event: 'pull_request',
        actor: { id: badRunActor ? 2 : 49699333, login: 'dependabot[bot]', type: 'Bot' },
        repository: { id: repo.id }, head_repository: { id: repo.id }, path: '.github/workflows/ci.yml', head_sha: sha,
        status: 'completed', conclusion: failure ? 'failure' : 'success' },
      { id: 2, run_attempt: 1, workflow_id: 422035428, event: 'pull_request',
        actor: { id: 49699333, login: 'dependabot[bot]', type: 'Bot' }, triggering_actor: { id: 157894869, type: 'User' },
        repository: { id: repo.id }, head_repository: { id: repo.id }, path: '.github/workflows/python-matrix.yml', head_sha: sha,
        status: 'completed', conclusion: 'success' },
    ] };
    const contextName = ['dependabot-context', base, sha, badContext ? moved : merge].join('-');
    const job = (name, runId, checkId) => ({ name, run_id: runId, head_sha: sha,
      status: 'completed', conclusion: 'success',
      check_run_url: 'https://api.github.com/repos/KingsleyHK0323/Multimedia_Downloader/check-runs/' + checkId });
    const ciJobs = { total_count: 2, jobs: [{ name: contextName, status: 'completed', conclusion: 'success' }, job('Required CI', 1, 501)] };
    const matrixJobs = { total_count: 2, jobs: [{ name: contextName, status: 'completed', conclusion: 'success' }, job('Required Python matrix', 2, 502)] };
    const treeBase = 'e'.repeat(40), treeHead = 'f'.repeat(40), githubTree = '1'.repeat(40);
    const baseCommit = { sha: base, tree: { sha: treeBase }, parents: [] };
    const headCommit = { sha, tree: { sha: treeHead }, parents: [{ sha: wrongParent ? moved : base }, ...(twoParents ? [{ sha: moved }] : [])] };
    const mergeCommit = { sha: merge, tree: { sha: wrongMergeTree ? treeBase : treeHead },
      parents: [{ sha: base }, { sha: wrongMergeParents ? moved : sha }] };
    const identity = { sha, author: { id: badCommitAuthor ? 9 : 49699333, login: 'dependabot[bot]', type: 'Bot' },
      committer: { id: badCommitter ? 157894869 : 19864447, login: badCommitter ? 'KingsleyHK0323' : 'web-flow', type: 'User' },
      commit: { verification: { verified: !badSignature, reason: 'valid' } } };
    const rootTree = (isHead = false) => ({ sha: isHead ? treeHead : treeBase, truncated: incompleteTree, tree: [
      { path: '.github', type: 'tree', mode: '040000', sha: isHead && wrongGithubTree ? '2'.repeat(40) : githubTree },
      { path: 'engine', type: 'tree', mode: '040000', sha: '5'.repeat(40) },
      { path: 'frontend', type: 'tree', mode: '040000', sha: '6'.repeat(40) },
      { path: 'src-tauri', type: 'tree', mode: '040000', sha: '7'.repeat(40) },
      ...allowed.map((path, i) => ({ path, type: 'blob',
        mode: isHead && i === 0 && executableAllowed ? '100755' :
          isHead && i === 0 && symlinkAllowed ? '120000' : '100644',
        sha: isHead && i === 0 ? '4'.repeat(40) : '3'.repeat(40) })),
      { path: 'engine/downloader.py', type: 'blob', mode: '100644',
        sha: isHead && nonallowedChange ? '9'.repeat(40) : '8'.repeat(40) },
      ...(isHead && newPath ? [{ path: 'extra.py', type: 'blob', mode: '100644', sha: 'a'.repeat(40) }] : []),
    ] });
    const check = (name, id) => ({ id, name, head_sha: sha, app: { id: badCheckApp ? 9 : 15368 },
      status: 'completed', conclusion: failedCheck ? 'failure' : 'success' });
    const associated = missingAssociated ? [] : [{ ...pr, draft: draftAssociated }, ...(moreOpenPRs ? [{ ...pr, number: 67 }] : [])];
    const pages = [[{ filename: protectedFile ? '.github/actions/unsafe/action.yml' : 'requirements-dev.txt', status: 'modified' }]];
    const prelude = String.raw`
      gh() {
        printf '%s\n' "$*" >> "$GH_LOG"
        case "$*" in

          "api repos/KingsleyHK0323/Multimedia_Downloader/actions/runs?"*) printf '%s' "$RUNS" ;;
          "api repos/KingsleyHK0323/Multimedia_Downloader/pulls/66/files "*) : ;;
          "api --paginate --slurp repos/KingsleyHK0323/Multimedia_Downloader/pulls/66/files?per_page=100") printf '%s' "$PAGES" ;;
          "api repos/KingsleyHK0323/Multimedia_Downloader/pulls/66 --jq "*) printf '%s\n' "$LABEL" ;;
          "api repos/KingsleyHK0323/Multimedia_Downloader/pulls/66") printf '%s' "$PR" ;;
          "api repos/KingsleyHK0323/Multimedia_Downloader/git/ref/heads/Source_Code --jq .object.sha")
            if [ -f "$UPDATED_FILE" ]; then printf '%s\n' "$HEAD_SHA"; else printf '%s\n' "$BASE_HEAD"; fi ;;
          "api repos/KingsleyHK0323/Multimedia_Downloader/actions/runs/1/attempts/1/jobs?per_page=100")
            [ "$NO_JOBS" != 1 ] || return 1; printf '%s' "$CI_JOBS" ;;
          "api repos/KingsleyHK0323/Multimedia_Downloader/actions/runs/2/attempts/1/jobs?per_page=100")
            [ "$NO_JOBS" != 1 ] || return 1; printf '%s' "$MATRIX_JOBS" ;;
          "api apps/kingsley-multimedia-automation") [ "$GH_TOKEN" = app-fixture ] || return 1; printf '%s' "$APP_INFO" ;;
          "api users/kingsley-multimedia-automation%5Bbot%5D") [ "$GH_TOKEN" = app-fixture ] || return 1; printf '%s' "$BOT_INFO" ;;
          "api repos/KingsleyHK0323/Multimedia_Downloader") [ "$GH_TOKEN" = app-fixture ] || return 1; printf '%s' "$REPO_INFO" ;;
          "api --paginate --slurp repos/KingsleyHK0323/Multimedia_Downloader/rules/branches/Source_Code?per_page=100")
            [ "$GH_TOKEN" = app-fixture ] || return 1
            printf '%s' "$RULE_PAGES" ;;
          "api repos/KingsleyHK0323/Multimedia_Downloader/rulesets/7?includes_parents=true")
            [ "$GH_TOKEN" = app-fixture ] || return 1
            printf '%s' "$RULE_DETAIL" ;;
          "api repos/KingsleyHK0323/Multimedia_Downloader/git/commits/"*)
            id="$(basename "$2")"
            if [ "$id" = "$BASE_SHA" ]; then printf '%s' "$BASE_COMMIT"
            elif [ "$id" = "$HEAD_SHA" ]; then printf '%s' "$HEAD_COMMIT"
            else printf '%s' "$MERGE_COMMIT"; fi ;;
          "api repos/KingsleyHK0323/Multimedia_Downloader/commits/"*)
            printf '%s' "$HEAD_IDENTITY" ;;
          "api repos/KingsleyHK0323/Multimedia_Downloader/git/trees/"*)
            id="$(basename "$2" | cut -d"?" -f1)"
            if [ "$id" = "$TREE_BASE" ]; then printf '%s' "$BASE_TREE_JSON"; else printf '%s' "$HEAD_TREE_JSON"; fi ;;
          "api repos/KingsleyHK0323/Multimedia_Downloader/check-runs/501") printf '%s' "$CI_CHECK" ;;
          "api repos/KingsleyHK0323/Multimedia_Downloader/check-runs/502") printf '%s' "$MATRIX_CHECK" ;;
          "api --paginate --slurp repos/KingsleyHK0323/Multimedia_Downloader/commits/"*"/pulls?per_page=100")
            if [ "$NO_PR" = 1 ]; then printf '[[]]'
            elif [ "$MOCK_STAGE" = final ]; then printf '%s' "$ASSOCIATED"
            else printf '%s' "$INITIAL_ASSOCIATED"; fi ;;
          "api graphql --input -")
            [ "$GH_TOKEN" = app-fixture ] || return 1
            cat > "$PAYLOAD_FILE"
            node -e '
              const fs = require("fs");
              const x = JSON.parse(fs.readFileSync(process.env.PAYLOAD_FILE, "utf8"));
              const r = x.variables?.input?.refUpdates;
              if (!Array.isArray(r) || r.length !== 1 || r[0].name !== "refs/heads/Source_Code" ||
                  r[0].beforeOid !== process.env.BASE_SHA || r[0].afterOid !== process.env.HEAD_SHA ||
                  r[0].force !== false) process.exit(1);
            ' || return 1
            : > "$UPDATED_FILE"
            printf '{"data":{"updateRefs":{"clientMutationId":"dependabot-66-%s"}}}' "$HEAD_SHA" ;;
          "pr merge 66 "*) [ "$GH_TOKEN" = app-fixture ] || return 1 ;;
          "workflow run clean-merged-branches.yml "*|"workflow run auto-patch-release.yml "*)
            [ "$GH_TOKEN" = system-fixture ] || return 1 ;;
          *) printf 'Unexpected gh call: %s\n' "$*" >&2; return 1 ;;
        esac
      }
    `;
    const output = log + '.outputs';
    const common = { ...process.env, GH_REPO: 'KingsleyHK0323/Multimedia_Downloader', GH_TOKEN: 'system-fixture',
      RUNNER_TEMP: root, GH_LOG: log, GITHUB_OUTPUT: output, HEAD_SHA: sha,
      WORKFLOW_SHA: staleWorkflow ? moved : base, PR: JSON.stringify(pr),
      RUNS: JSON.stringify(runs), PAGES: JSON.stringify(pages), CI_JOBS: JSON.stringify(ciJobs), MATRIX_JOBS: JSON.stringify(matrixJobs),
      BASE_HEAD: baseMoved ? moved : base, NO_PR: noPr ? '1' : '0', NO_JOBS: noJobs ? '1' : '0',
      LABEL: 'false', UPDATED_FILE: log + '.updated', PAYLOAD_FILE: log + '.payload', MOCK_STAGE: 'initial',
      INITIAL_ASSOCIATED: JSON.stringify([incompleteInitial ? [pr, { number: 67, state: 'open' }] :
        [pr, ...(ambiguousInitial ? [{ ...pr, number: 67 }] : [])]]) };
    const first = spawnSync('bash', ['--noprofile', '--norc', '-c', prelude + '\n' + candidate], { encoding: 'utf8', env: common });
    assert.equal(first.error, undefined);
    assert.equal(first.status, 0, first.stderr);
    const outputs = fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : '';
    if (outputs.includes('eligible=true\n')) {
      fs.appendFileSync(log, 'APP_CREATED\n');
      const finalPr = { ...pr, draft: draftFinal,
        user: { ...pr.user, id: spoofBot ? 2 : pr.user.id },
        base: { ...pr.base, ref: retarget ? 'other' : pr.base.ref, repo: foreignBase ? { ...repo, id: 9 } : repo },
        head: { ...pr.head, sha: finalHeadMoved ? moved : sha, repo: foreignHead ? { ...repo, id: 9 } : repo } };
      const finalRuns = structuredClone(runs);
      if (finalChecksFailed) finalRuns.workflow_runs[0].conclusion = 'failure';
      const reported = Object.fromEntries(outputs.trim().split('\n').map(line => {
        const i = line.indexOf('=');
        assert.ok(i > 0);
        return [line.slice(0, i), line.slice(i + 1)];
      }));
      assert.equal(reported.pr_number, '66');
      assert.equal(reported.base_sha, base);
      const finalEnv = { ...common, APP_TOKEN: 'app-fixture', APP_SLUG: 'kingsley-multimedia-automation',
        PR_NUMBER: reported.pr_number, BASE_SHA: reported.base_sha, MERGE_SHA: reported.merge_sha, CI_ID: reported.ci_id,
        CI_ATTEMPT: reported.ci_attempt, MATRIX_ID: reported.matrix_id, MATRIX_ATTEMPT: reported.matrix_attempt,
        RULE_PAGES: JSON.stringify([rules]), RULE_DETAIL: JSON.stringify(detail), PR: JSON.stringify(finalPr),
        APP_INFO: JSON.stringify({ id: badApp ? 4 : 5868451, slug: 'kingsley-multimedia-automation' }),
        BOT_INFO: JSON.stringify({ id: badAppBot ? 5 : 359694872, login: 'kingsley-multimedia-automation[bot]', type: 'Bot' }),
        REPO_INFO: JSON.stringify({ ...repo, id: badRepo ? 6 : repo.id, fork: forked, node_id: 'R_repo' }),
        BASE_COMMIT: JSON.stringify(baseCommit), HEAD_COMMIT: JSON.stringify(headCommit),
        MERGE_COMMIT: JSON.stringify(mergeCommit), HEAD_IDENTITY: JSON.stringify(identity),
        TREE_BASE: treeBase, BASE_TREE_JSON: JSON.stringify(rootTree()), HEAD_TREE_JSON: JSON.stringify(rootTree(true)),
        CI_CHECK: JSON.stringify(check('Required CI', 501)), MATRIX_CHECK: JSON.stringify(check('Required Python matrix', 502)),
        ASSOCIATED: JSON.stringify([associated]), MOCK_STAGE: 'final', UPDATED_FILE: log + '.updated', PAYLOAD_FILE: log + '.payload',
        BASE_HEAD: finalBaseMoved ? moved : base, RUNS: JSON.stringify(finalRuns) };
      const last = spawnSync('bash', ['--noprofile', '--norc', '-c', prelude + '\n' + finalMerge], { encoding: 'utf8', env: finalEnv });
      assert.equal(last.error, undefined);
      assert.equal(last.status, 0, last.stderr);
    }
    return fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  };
  const success = run();
  assert.match(success, /APP_CREATED/);
  assert.match(success, /api graphql --input -/);
  assert.match(success, /workflow run clean-merged-branches\.yml/);
  for (const variant of [{ failure: true }, { protectedFile: true }, { noPr: true },
    { baseMoved: true }, { badContext: true }, { noJobs: true }, { badAttempt: true }, { staleWorkflow: true }, { badRunActor: true },
    { ambiguousInitial: true }, { incompleteInitial: true }, { draftInitial: true }]) {
    const result = run(variant);
    assert.doesNotMatch(result, /APP_CREATED/);
    assert.doesNotMatch(result, /api graphql --input -/);
  }
  for (const variant of [{ finalBaseMoved: true }, { retarget: true }, { finalHeadMoved: true },
    { finalChecksFailed: true }, { bypass: true }, { noRules: true }, { looseRules: true },
    { foreignBase: true }, { foreignHead: true }, { spoofBot: true },
    { badApp: true }, { badAppBot: true }, { badRepo: true }, { forked: true },
    { twoParents: true }, { wrongParent: true }, { wrongMergeParents: true }, { wrongMergeTree: true },
    { wrongGithubTree: true }, { incompleteTree: true }, { badSignature: true }, { badCommitAuthor: true }, { badCommitter: true },
    { badCheckApp: true }, { failedCheck: true }, { moreOpenPRs: true }, { missingAssociated: true },
    { executableAllowed: true }, { symlinkAllowed: true }, { newPath: true }, { nonallowedChange: true },
    { draftFinal: true }, { draftAssociated: true }]) {
    const result = run(variant);
    assert.match(result, /APP_CREATED/);
    assert.doesNotMatch(result, /api graphql --input -/);
  }
  assert.doesNotMatch(success, /workflow run auto-patch-release\.yml/);
});

// OpenAI-Codex_ruleset_architecture: the token is scoped and created only after eligibility.
test('Dependabot App token is scoped and never paired with a checkout', () => {
  assert.match(workflow, /if: steps\.candidate\.outputs\.eligible == 'true'/);
  assert.match(workflow, /owner: KingsleyHK0323/);
  assert.match(workflow, /repositories: Multimedia_Downloader/);
  assert.match(workflow, /permission-contents: write/);
  assert.doesNotMatch(workflow, /permission-pull-requests: write/);
  assert.match(workflow, /AUTOMATION_DEPENDABOT_CAS == 'enabled'/);
  assert.doesNotMatch(workflow, /actions\/checkout/);
});

// OpenAI-Codex: both PR test workflows publish their context as a GitHub job name.
test('CI and matrix expose the same non-checkout merge context job', async () => {
  const ciWorkflow = await readFile(new URL('../workflows/ci.yml', import.meta.url), 'utf8');
  const matrixWorkflow = await readFile(new URL('../workflows/python-matrix.yml', import.meta.url), 'utf8');
  const getJob = text => text.split('  dependabot-merge-context:\n')[1].split(/\n  [A-Za-z][\w-]*:/)[0];
  const ciJob = getJob(ciWorkflow), matrixJob = getJob(matrixWorkflow);
  assert.equal(ciJob, matrixJob);
  assert.match(ciJob, /dependabot-context-/);
  assert.match(ciJob, /github\.event\.pull_request\.base\.sha/);
  assert.match(ciJob, /github\.event\.pull_request\.head\.sha/);
  assert.match(ciJob, /github\.sha/);
  assert.doesNotMatch(ciJob, /actions\/checkout/);
});
