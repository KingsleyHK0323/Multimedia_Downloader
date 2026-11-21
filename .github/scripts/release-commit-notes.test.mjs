// OpenAI-Codex: verify release changelog generation against isolated Git histories.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const generator = fileURLToPath(new URL('./release-commit-notes.mjs', import.meta.url));
const workflow = readFileSync(new URL('../workflows/release.yml', import.meta.url), 'utf8');
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'release-notes-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--quiet');
  function commit(subject) {
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', subject);
    return git('rev-parse', 'HEAD');
  }
  return { dir, git, commit };
}
function generate(dir, tag, repository = 'example/project') {
  const out = join(dir, 'github-output.txt');
  writeFileSync(out, '');
  const result = spawnSync(process.execPath, [generator], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, RELEASE_TAG: tag, GITHUB_REPOSITORY: repository, RUNNER_TEMP: dir, GITHUB_OUTPUT: out },
  });
  if (result.error) throw result.error;
  return { result, output: readFileSync(out, 'utf8') };
}

test('includes each commit since the nearest previous tag', () => {
  const { dir, git, commit } = fixture();
  commit('Old release subject');
  git('tag', 'v1.0.0');
  const first = commit('Direct change');
  const second = commit('Fix [render] @someone <script>');
  git('tag', 'v1.0.1');
  const { result, output } = generate(dir, 'v1.0.1');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(output, 'previous_tag=v1.0.0\n');
  const notes = readFileSync(join(dir, 'release-commit-notes.md'), 'utf8');
  assert.match(notes, /## Commits since v1\.0\.0/);
  assert.ok(notes.includes(first) && notes.includes(second));
  assert.ok(notes.includes('Direct change'));
  assert.ok(notes.includes('Fix \\[render\\] &#64;someone &lt;script&gt;'));
  assert.ok(!notes.includes('Old release subject'));
});

test('a first release includes the initial commit', () => {
  const { dir, git, commit } = fixture();
  const sha = commit('Initial change');
  git('tag', 'v0.1.0');
  const { result, output } = generate(dir, 'v0.1.0');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(output, 'previous_tag=\n');
  assert.ok(readFileSync(join(dir, 'release-commit-notes.md'), 'utf8').includes(sha));
});

test('rejects invalid input and missing tags without producing notes', () => {
  const { dir, commit } = fixture();
  commit('Initial change');
  for (const tag of ['v01.2.3', 'v1.2.3;whoami', 'v1.2.3']) {
    const { result, output } = generate(dir, tag);
    assert.notEqual(result.status, 0, tag);
    assert.equal(output, '');
  }
  assert.notEqual(generate(dir, 'v1.2.3', '../other').result.status, 0);
});

test('workflow preserves generated PR notes and adds commit notes using the same base', () => {
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /--generate-notes --notes-file "\$RUNNER_TEMP\/release-commit-notes\.md"/);
  assert.match(workflow, /--notes-start-tag "\$previous"/);
  assert.match(workflow, /--verify-tag/);
});
