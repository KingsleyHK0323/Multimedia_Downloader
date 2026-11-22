// OpenAI-Codex_ruleset_architecture: exercise the actual retry scripts with mocked GitHub metadata.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const retry = await readFile(new URL('../workflows/dependabot-retry.yml', import.meta.url), 'utf8');
const merge = await readFile(new URL('../workflows/dependabot-auto-merge.yml', import.meta.url), 'utf8');
const parts = retry.split('          script: |\n');
assert.equal(parts.length, 3, 'expected separate read-only scan and dispatch scripts');
const normalize = s => s.split('\n').map(line => line.startsWith('            ') ? line.slice(12) : line).join('\n');
const scanSource = normalize(parts[1].split('\n  dispatch:\n')[0]);
const dispatchSource = normalize(parts[2]);
const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
const scan = new AsyncFunction('github', 'context', 'core', 'process', scanSource);
const dispatch = new AsyncFunction('github', 'context', 'core', 'process', dispatchSource);
const sha = n => n.toString(16).padStart(40, '0');
const tip = sha(999), moved = sha(998);
const context = { repo: { owner: 'KingsleyHK0323', repo: 'Multimedia_Downloader' }, ref: 'refs/heads/Source_Code', eventName: 'schedule' };
const botPr = (number, head = sha(number)) => ({ number, state: 'open', draft: false,
  user: { id: 49699333, login: 'dependabot[bot]', type: 'Bot' },
  base: { ref: 'Source_Code', repo: { id: 1251103365 } },
  head: { sha: head, repo: { id: 1251103365 } } });
const humanPr = number => ({ ...botPr(number), user: { id: 10, login: 'human', type: 'User' } });

function mock({ pages = [[]], refs = [tip], rejectHead = null, missingRunId = false } = {}) {
  const requests = [], output = {}, notices = [], warnings = [];
  let refIndex = 0;
  const github = {
    rest: {
      pulls: { list: async args => ({ data: pages[args.page - 1] || [] }) },
      git: { getRef: async () => ({ data: { ref: 'refs/heads/Source_Code', object: { sha: refs[Math.min(refIndex++, refs.length - 1)] } } }) },
    },
    request: async (route, args) => {
      requests.push({ route, args });
      if (args.inputs.head_sha === rejectHead) throw new Error('fixture dispatch error');
      return { data: missingRunId ? {} : { workflow_run_id: requests.length } };
    },
  };
  const core = { setOutput: (key, value) => { output[key] = value; },
    notice: value => notices.push(value), warning: value => warnings.push(value) };
  return { github, core, requests, output, notices, warnings };
}

test('scan pages all open PRs and emits only distinct same-repository non-draft bot heads', async () => {
  const first = Array.from({ length: 100 }, (_, i) => humanPr(i + 1));
  const fork = botPr(103); fork.head.repo.id = 12;
  const draft = botPr(104); draft.draft = true;
  const m = mock({ pages: [first, [botPr(101), botPr(102, sha(101)), fork, draft]] });
  await scan(m.github, context, m.core, { env: { WORKFLOW_SHA: tip } });
  assert.deepEqual(JSON.parse(m.output.heads), [sha(101)]);
  assert.equal(m.output.count, '1');
  assert.equal(m.requests.length, 0);
});

test('scan fails closed for duplicates, missing bot metadata, excessive pages and moved source', async () => {
  const broken = botPr(1); delete broken.head.sha;
  const large = Array.from({ length: 11 }, (_, page) => Array.from({ length: 100 }, (_, n) => humanPr(page * 100 + n + 1)));
  const scenarios = [
    { pages: [Array.from({ length: 100 }, (_, i) => humanPr(i + 1)), [humanPr(1)]] },
    { pages: [[broken]] }, { pages: large }, { pages: [[botPr(1)]], refs: [moved] },
  ];
  for (const scenario of scenarios) {
    const m = mock(scenario);
    await assert.rejects(scan(m.github, context, m.core, { env: { WORKFLOW_SHA: tip } }));
    assert.equal(m.requests.length, 0);
  }
});

test('dispatch requests only exact SHA inputs and records returned run IDs', async () => {
  const m = mock();
  await dispatch(m.github, context, m.core, { env: { WORKFLOW_SHA: tip, HEADS: JSON.stringify([sha(1), sha(2)]) } });
  assert.equal(m.requests.length, 2);
  for (const [i, request] of m.requests.entries()) {
    assert.equal(request.args.workflow_id, 'dependabot-auto-merge.yml');
    assert.equal(request.args.ref, 'Source_Code');
    assert.equal(request.args.inputs.head_sha, sha(i + 1));
    assert.equal(request.args.return_run_details, true);
    assert.equal(request.args.headers['X-GitHub-Api-Version'], '2022-11-28');
  }
  assert.ok(m.notices.every(s => s.includes('not yet complete')));
});

test('dispatch rejects invalid or duplicate SHAs and stops if Source_Code advances', async () => {
  for (const heads of [[], ['fake'], [sha(1), sha(1)]]) {
    const m = mock();
    await assert.rejects(dispatch(m.github, context, m.core, { env: { WORKFLOW_SHA: tip, HEADS: JSON.stringify(heads) } }));
    assert.equal(m.requests.length, 0);
  }
  const m = mock({ refs: [tip, moved] });
  await assert.rejects(dispatch(m.github, context, m.core, { env: { WORKFLOW_SHA: tip, HEADS: JSON.stringify([sha(1), sha(2)]) } }));
  assert.equal(m.requests.length, 1);
});

test('dispatch attempts remaining heads but reports unconfirmed requests', async () => {
  const m = mock({ rejectHead: sha(1) });
  await assert.rejects(dispatch(m.github, context, m.core, { env: { WORKFLOW_SHA: tip, HEADS: JSON.stringify([sha(1), sha(2)]) } }));
  assert.equal(m.requests.length, 2);
  assert.equal(m.warnings.length, 1);
  const missing = mock({ missingRunId: true });
  await assert.rejects(dispatch(missing.github, context, missing.core, { env: { WORKFLOW_SHA: tip, HEADS: JSON.stringify([sha(1)]) } }));
});

test('dry runs have no dispatch job and merge retries retain the per-head queue and SHA guard', () => {
  assert.match(retry, /github\.event_name == 'workflow_dispatch' && inputs\.dry_run == true/);
  assert.match(retry, /github\.event_name == 'workflow_dispatch' && inputs\.dry_run == false/);
  assert.match(retry, /permissions: \{\}/);
  assert.match(merge, /github\.event_name == 'workflow_dispatch' && inputs\.head_sha/);
  assert.match(merge, /queue: max/);
  assert.doesNotMatch(merge, /cancel-in-progress: true/);
  const candidate = merge.split('        run: |\n')[1]
    .split('\n      - name: Create scoped automation App token\n')[0]
    .split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
  if (process.platform === 'linux') {
    const r = spawnSync('bash', ['--noprofile', '--norc', '-c', candidate],
      { encoding: 'utf8', env: { ...process.env, HEAD_SHA: 'not-a-sha' } });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /valid commit SHA/);
  }
});
