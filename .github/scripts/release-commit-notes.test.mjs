// OpenAI-Codex: verify release changelog generation against isolated Git histories.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

// OpenAI-Codex: execute the real release-creation shell with a fake GitHub CLI.
function ensureRelease(exists, draft, previous) {
  const marker = '      - name: Ensure a GitHub Release exists for this tag\n';
  assert.equal(workflow.split(marker).length, 2);
  const block = workflow.split(marker)[1].split('\n  build:')[0];
  assert.equal(block.split('        run: |\n').length, 2);
  const shell = block.split('        run: |\n')[1].replace(/^          /gm, '')
    .replaceAll('${{ steps.tag.outputs.tag }}', 'v1.0.1')
    .replaceAll('${{ steps.release_notes.outputs.previous_tag }}', previous);
  assert.ok(!shell.includes('${{'));
  const dir = mkdtempSync(join(tmpdir(), 'release-create-'));
  const bin = join(dir, 'bin');
  const log = join(dir, 'create-args.txt');
  mkdirSync(bin);
  const fake = '#!/bin/sh\n' +
    'if [ "$1" = release ] && [ "$2" = view ]; then\n' +
    '  [ "$FAKE_EXISTS" = 1 ] || exit 1\n' +
    '  case " $* " in *" --json "*) if [ "$FAKE_DRAFT" = 1 ]; then echo true; else echo false; fi ;; esac\n' +
    '  exit 0\nfi\n' +
    'if [ "$1" = release ] && [ "$2" = create ]; then printf "%s\\n" "$@" > "$GH_LOG"; exit 0; fi\n' +
    'exit 98\n';
  writeFileSync(join(bin, 'gh'), fake, { mode: 0o755 });
  const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', shell], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: bin + ':' + process.env.PATH, GITHUB_REPOSITORY: 'example/project',
      RUNNER_TEMP: dir, GH_LOG: log, FAKE_EXISTS: String(exists), FAKE_DRAFT: String(draft) },
  });
  if (result.error) throw result.error;
  return { result, args: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [] };
}

test('creates a draft with exact tag, generated PR notes and direct commit notes', () => {
  const { result, args } = ensureRelease(0, 0, 'v1.0.0');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(args.slice(0, 3), ['release', 'create', 'v1.0.1']);
  for (const flag of ['--draft', '--verify-tag', '--generate-notes', '--notes-file', '--notes-start-tag']) {
    assert.ok(args.includes(flag), flag);
  }
  assert.equal(args[args.indexOf('--notes-start-tag') + 1], 'v1.0.0');
  assert.match(args[args.indexOf('--notes-file') + 1], /release-commit-notes\.md$/);
});

test('preserves an existing draft and refuses to alter a published release', () => {
  const draft = ensureRelease(1, 1, 'v1.0.0');
  assert.equal(draft.result.status, 0, draft.result.stderr);
  assert.deepEqual(draft.args, []);
  const published = ensureRelease(1, 0, 'v1.0.0');
  assert.notEqual(published.result.status, 0);
  assert.deepEqual(published.args, []);
});

test('first release does not pass a nonexistent start tag', () => {
  const { result, args } = ensureRelease(0, 0, '');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!args.includes('--notes-start-tag'));
});
