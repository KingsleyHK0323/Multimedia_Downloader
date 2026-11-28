// OpenAI-Codex: verify release changelog generation against isolated Git histories.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
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


// OpenAI-Codex: keep stable release fixtures distinct from the approved beta tags.
// OpenAI-Codex_format_architecture: execute the actual draft-creation script with GitHub mocks.
const creationBlock = workflow.split('      - name: Create or verify the draft release\n')[1];
const scriptBlock = creationBlock?.split('          script: |\n')[1];
assert.ok(scriptBlock);
const scriptLines = [];
for (const line of scriptBlock.split('\n')) {
  if (line === '') { scriptLines.push(''); continue; }
  if (!line.startsWith('            ')) break;
  scriptLines.push(line.slice(12));
}
const creationScript = scriptLines.join('\n');
assert.ok(creationScript.trim());
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const runCreation = new AsyncFunction('github', 'context', 'require', creationScript);
const target = 'a'.repeat(40);
function scenario(options = {}) {
  const calls = [];
  let reads = 0;
  const api = {
    // OpenAI-Codex: model draft-inclusive paginated release listings.
    paginate: async method => {
      assert.equal(method, api.rest.repos.listReleases);
      reads++;
      if (!options.exists && !(options.race && reads > 1)) return [];
      return [{ tag_name: 'v4.3.25', draft: options.published ? false : true, prerelease: false }];
    },
    rest: {
      git: {
        getRef: async () => ({ data: { object: { type: 'commit', sha: options.badTarget ? 'b'.repeat(40) : target } } }),
      },
      repos: {
        listReleases: async () => { throw new Error('pagination wrapper required'); },
        generateReleaseNotes: async args => { calls.push(['notes', args]); return { data: { body: 'Generated PR notes' } }; },
        createRelease: async args => {
          calls.push(['create', args]);
          if (options.race) throw Object.assign(new Error('conflict'), { status: 422 });
          return { data: { ...args, tag_name: args.tag_name, draft: true, prerelease: false } };
        },
      },
    },
  };
  const env = { RELEASE_TAG: options.tag || 'v4.3.25', TARGET_SHA: target,
    PREVIOUS_TAG: 'v4.3.22', RELEASE_ONLY: options.only || 'all', RUNNER_TEMP: '/tmp' };
  return { calls, api, env };
}
async function executeCreation(options = {}) {
  const state = scenario(options);
  const old = Object.fromEntries(Object.keys(state.env).map(key => [key, process.env[key]]));
  Object.assign(process.env, state.env);
  const req = name => name === 'node:fs' ? { readFileSync: () => 'Direct commit notes' } : require(name);
  try {
    await runCreation(state.api, { repo: { owner: 'KingsleyHK0323', repo: 'Multimedia_Downloader' } }, req);
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  return state;
}
async function rejectCreation(options, pattern) {
  const state = scenario(options);
  const old = Object.fromEntries(Object.keys(state.env).map(key => [key, process.env[key]]));
  Object.assign(process.env, state.env);
  const req = name => name === 'node:fs' ? { readFileSync: () => 'Direct commit notes' } : require(name);
  try {
    await assert.rejects(runCreation(state.api, { repo: { owner: 'KingsleyHK0323', repo: 'Multimedia_Downloader' } }, req), pattern);
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  return state;
}
test('creates a draft from the exact tag with both commit and generated notes', async () => {
  const state = await executeCreation();
  assert.deepEqual(state.calls.map(item => item[0]), ['notes', 'create']);
  const options = state.calls[1][1];
  assert.equal(options.tag_name, 'v4.3.25');
  assert.equal(options.target_commitish, target);
  assert.equal(options.draft, true);
  assert.equal(options.prerelease, false);
  assert.match(options.body, /Direct commit notes/);
  assert.match(options.body, /Generated PR notes/);
  assert.equal(state.calls[0][1].previous_tag_name, 'v4.3.22');
});
test('preserves an existing draft and handles a concurrent matching draft', async () => {
  assert.deepEqual((await executeCreation({ exists: true })).calls, []);
  assert.deepEqual((await executeCreation({ race: true })).calls.map(item => item[0]), ['notes', 'create']);
});
test('published, retargeted and reserved releases fail without creating a release', async () => {
  for (const options of [{ exists: true, published: true }, { badTarget: true }, { tag: 'v4.3.3' }]) {
    const state = await rejectCreation(options, /expected draft|Tag target changed|Invalid release target/);
    assert.deepEqual(state.calls, []);
  }
});

test('partial recovery requires an existing draft and cannot create one', async () => {
  const state = await rejectCreation({ only: 'macos-15' }, /requires an existing draft/);
  assert.deepEqual(state.calls, []);
  const existing = await executeCreation({ only: 'macos-15', exists: true });
  assert.deepEqual(existing.calls, []);
});
