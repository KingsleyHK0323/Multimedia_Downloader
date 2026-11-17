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
    const unsafe = p => p.startsWith(".github/workflows/") || p.startsWith(".github/actions/");
    if (!files.every(f => f && typeof f.filename === "string" && f.filename.length > 0 &&
        typeof f.status === "string" && f.status.length > 0 &&
        (f.status !== "renamed" || (typeof f.previous_filename === "string" && f.previous_filename.length > 0)) &&
        (f.previous_filename === undefined || (typeof f.previous_filename === "string" && f.previous_filename.length > 0)) &&
        !unsafe(f.filename) && (f.previous_filename === undefined || !unsafe(f.previous_filename)))) process.exit(1);
  } catch { process.exit(1); }
'; then
  echo "::warning::PR file list or identity is unsafe or incomplete; skipping merge."
  exit 0
fi
`;

const sha = 'a'.repeat(40);
const normal = i => ({ filename: `deps/package-${i}.json`, status: 'modified' });
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
assert.equal(actualGuard.split("| node -e '\n").length, 2, 'expected actual Node validator');
assert.equal(actualGuard.split("\n'; then").length, 2, 'expected validator terminator');
const validator = actualGuard.split("| node -e '\n")[1].split("\n'; then")[0];

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

test('normal Dependabot dependency changes can reach the mocked merge, including later pages', () => {
  assert.equal(check([[normal(1)]]), true);
  assert.equal(check([Array.from({ length: 100 }, (_, i) => normal(i)), [normal(100)]]), true);
});

test('workflow and action paths are rejected on any page and either side of a rename', () => {
  for (const file of [
    { filename: '.github/workflows/test.yml', status: 'added' },
    { filename: '.github/actions/task/action.yml', status: 'modified' },
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
    GH_REPO=example/repo
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
  const normalPages = [Array.from({ length: 100 }, (_, i) => normal(i)), [normal(100)]];
  assert.equal(runShell(normalPages), true);
  assert.equal(runShell(normalPages, true), false);
  assert.equal(runShell(normalPages, false, true), false);
  assert.equal(runShell([normalPages[0], [{ filename: '.github/workflows/test.yml', status: 'modified' }]]), false);
});


test('merge requires the exact CI-tested head and does not bypass or delete', () => {
  assert.ok(workflow.includes('gh pr merge "${pr_number}" --squash --match-head-commit "${HEAD_SHA}"'));
  assert.equal(workflow.includes('--admin'), false);
  assert.equal(workflow.includes('--delete-branch'), false);
});
