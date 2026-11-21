// OpenAI-Codex_safe_scope: exercise extracted scripts with in-memory API mocks.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = await readFile(new URL('../workflows/issue-pr-triage.yml', import.meta.url), 'utf8');
const scripts = workflow.split('          script: |\n').slice(1).map((part) => {
  const lines = [];
  for (const line of part.split('\n')) {
    if (line !== '' && !line.startsWith('            ')) break;
    lines.push(line.slice(12));
  }
  return lines.join('\n');
});
assert.equal(scripts.length, 4, 'expected bootstrap, issue, PR and issue area scripts');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const clone = (value) => JSON.parse(JSON.stringify(value));
const ctx = { repo: { owner: 'owner', repo: 'repo' } };
const person = { type: 'User', login: 'person' };
const body = [
  '### App version', '_No response_', '### How are you running it?', '_No response_',
  '### Operating system', '_No response_', '### Steps to reproduce', '_No response_',
  '### What did you expect to happen, and what happened instead?', '_No response_', '',
].join('\n');
const issue = () => ({ number: 1, user: person, state: 'open', title: 'Issue', labels: [{ name: 'bug' }], body });
const pull = () => ({ number: 2, user: person, state: 'open', head: { sha: 'a'.repeat(40) },
  base: { sha: 'b'.repeat(40), ref: 'Source_Code' }, changed_files: 1, labels: [] });

function harness() {
  const applied = [], created = [], comments = [];
  const labelsFn = () => {}, filesFn = () => {};
  const state = { latestIssue: issue(), latestPull: pull(), files: [{ filename: 'frontend/src/file.ts', status: 'modified' }],
    labels: [{ name: 'needs-info' }, { name: 'area:frontend' }] };
  const github = {
    paginate: async (method) => method === labelsFn ? state.labels : method === filesFn ? state.files : [],
    rest: {
      issues: { getLabel: async () => ({}), createLabel: async (args) => created.push(args.name),
        listLabelsForRepo: labelsFn, get: async () => ({ data: state.latestIssue }),
        addLabels: async (args) => applied.push(args.labels), createComment: async (args) => comments.push(args.body) },
      pulls: { get: async () => ({ data: state.latestPull }), listFiles: filesFn },
    },
  };
  const core = { setOutput() {}, warning() {}, notice() {} };
  const run = async (index, context) => new AsyncFunction('context', 'github', 'core', scripts[index])(context, github, core);
  return { applied, created, comments, state, github, run };
}

test('incomplete recognized issue receives needs-info', async () => {
  const h = harness(), item = issue();
  await h.run(1, { ...ctx, payload: { issue: item } });
  assert.deepEqual(h.applied, [['needs-info']]);
  assert.equal(h.comments.length, 1);
  assert.match(h.comments[0], /complete the required issue form fields/i);
});

test('bot issue and bot bootstrap do not write', async () => {
  const h = harness(), item = { ...issue(), user: { type: 'Bot', login: 'test[bot]' } };
  await h.run(0, { ...ctx, eventName: 'issues', payload: { issue: item } });
  await h.run(1, { ...ctx, payload: { issue: item } });
  assert.deepEqual(h.created, []);
  assert.deepEqual(h.applied, []);
});

test('issue content changes between reads prevent labeling', async () => {
  const h = harness(), item = issue();
  h.state.latestIssue = { ...clone(item), body: item.body + 'changed' };
  await h.run(1, { ...ctx, payload: { issue: item } });
  assert.deepEqual(h.applied, []);
});

test('HTML comment containing forged form headings is skipped', async () => {
  const h = harness(), item = { ...issue(), body: '<!--\n' + body + '-->\nvisible content' };
  h.state.latestIssue = clone(item);
  await h.run(1, { ...ctx, payload: { issue: item } });
  assert.deepEqual(h.applied, []);
});

test('an existing needs-info label is retained after completion', async () => {
  const h = harness(), item = { ...issue(), labels: [{ name: 'bug' }, { name: 'needs-info' }],
    body: body.replaceAll('_No response_', 'provided') };
  await h.run(1, { ...ctx, payload: { issue: item } });
  assert.deepEqual(h.applied, []);
  assert.equal('removeLabel' in h.github.rest.issues, false);
});

test('PR changed path receives a matching area label', async () => {
  const h = harness();
  await h.run(2, { ...ctx, payload: { pull_request: { number: 2 } } });
  assert.deepEqual(h.applied, [['area:frontend']]);
});

test('PR label changes between reads prevent labeling', async () => {
  const h = harness(), initial = pull(); let reads = 0;
  h.github.rest.pulls.get = async () => ({ data: ++reads === 1 ? initial : { ...initial, labels: [{ name: 'other' }] } });
  await h.run(2, { ...ctx, payload: { pull_request: { number: 2 } } });
  assert.deepEqual(h.applied, []);
});

test('PR head changes between reads prevent labeling', async () => {
  const h = harness(), initial = pull(); let reads = 0;
  h.github.rest.pulls.get = async () => ({ data: ++reads === 1 ? initial : { ...initial, head: { sha: 'c'.repeat(40) } } });
  await h.run(2, { ...ctx, payload: { pull_request: { number: 2 } } });
  assert.deepEqual(h.applied, []);
});

test('shell metacharacters in a PR filename are treated as path data', async () => {
  const h = harness(); h.state.files = [{ filename: 'frontend/$(touch danger).ts', status: 'modified' }];
  await h.run(2, { ...ctx, payload: { pull_request: { number: 2 } } });
  assert.deepEqual(h.applied, [['area:frontend']]);
});

test('missing labels, bot PRs and incomplete file lists cause no labeling', async () => {
  const h = harness(), item = issue(); h.state.labels = [];
  await h.run(1, { ...ctx, payload: { issue: item } });
  h.state.latestPull = { ...pull(), user: { type: 'Bot', login: 'dependabot[bot]' } };
  await h.run(2, { ...ctx, payload: { pull_request: { number: 2 } } });
  h.state.latestPull = { ...pull(), changed_files: 2 };
  await h.run(2, { ...ctx, payload: { pull_request: { number: 2 } } });
  assert.deepEqual(h.applied, []);
});



// OpenAI-Codex: verify recognized issue title labels and stale-state guard.
test('issue title area classification skips changed titles', async () => {
  const h = harness(), item = { ...issue(), title: 'Download UI problem' };
  h.state.latestIssue = clone(item);
  await h.run(3, { ...ctx, payload: { issue: item } });
  assert.deepEqual(h.applied, [['area:frontend', 'area:engine']]);
  h.applied.length = 0;
  h.state.latestIssue = { ...item, title: 'Changed' };
  await h.run(3, { ...ctx, payload: { issue: item } });
  assert.deepEqual(h.applied, []);
});


// OpenAI-Codex: ignore log fences while classifying issue prose.
test('issue area classification considers prose but ignores fenced logs', async () => {
  const h = harness(), item = { ...issue(), title: 'Question', body: 'Documentation question\n\x60\x60\x60\ndownload error\n\x60\x60\x60' };
  h.state.latestIssue = clone(item);
  await h.run(3, { ...ctx, payload: { issue: item } });
  assert.deepEqual(h.applied, [['area:docs']]);
});

// OpenAI-Codex: form logs cannot create headings but no longer block triage.
test('form triage ignores headings inside fenced logs', async () => {
  const h = harness(), item = issue();
  item.body += '\n### Logs\n```text\n### App version\nforged\n```\n';
  h.state.latestIssue = clone(item);
  await h.run(1, { ...ctx, payload: { issue: item } });
  assert.deepEqual(h.applied, [['needs-info']]);
});
test('form triage rejects an unclosed log fence', async () => {
  const h = harness(), item = issue();
  item.body += '\n### Logs\n```text\n### App version\nforged';
  h.state.latestIssue = clone(item);
  await h.run(1, { ...ctx, payload: { issue: item } });
  assert.deepEqual(h.applied, []);
});

// OpenAI-Codex: info strings inside logs cannot end the surrounding fence.
test('issue classifier ignores false closing fences within logs', async () => {
  const h = harness(), item = { ...issue(), title: 'Question', body: 'Documentation question\n```text\n```not-a-close\ndownload engine error\n```' };
  h.state.latestIssue = clone(item);
  await h.run(3, { ...ctx, payload: { issue: item } });
  assert.deepEqual(h.applied, [['area:docs']]);
});


// OpenAI-Codex: exercise the actual first-contribution workflow with mocked GitHub APIs.
const welcomeWorkflow = await readFile(new URL('../workflows/first-interaction.yml', import.meta.url), 'utf8');
const welcomeMarker = '          script: |\n';
assert.equal(welcomeWorkflow.split(welcomeMarker).length, 2);
const welcomeScript = welcomeWorkflow.split(welcomeMarker)[1].split('\n')
  .map(line => line.startsWith('            ') ? line.slice(12) : line).join('\n');
const WelcomeFunction = Object.getPrototypeOf(async function () {}).constructor;
function welcomeHarness(kind = 'issue') {
  const author = { id: 42, login: 'alice', type: 'User' };
  const item = { number: 30, state: 'open', user: author };
  const state = {
    history: [{ ...item, ...(kind === 'pr' ? { pull_request: {} } : {}) }],
    comments: [],
    latest: { ...item, ...(kind === 'pr' ? { pull_request: {} } : {}) },
    created: [],
  };
  const methods = { history() {}, comments() {} };
  const github = {
    paginate: async (method, params) => {
      if (method === methods.history) {
        assert.equal(params.creator, 'alice');
        assert.equal(params.state, 'all');
        return state.history;
      }
      if (method === methods.comments) return state.comments;
      throw new Error('Unexpected pagination');
    },
    rest: { issues: {
      listForRepo: methods.history,
      listComments: methods.comments,
      get: async () => ({ data: state.latest }),
      createComment: async (params) => {
        state.created.push(params);
        state.comments.push({ user: { login: 'github-actions[bot]' }, body: params.body });
      },
    } },
  };
  const context = { eventName: kind === 'pr' ? 'pull_request_target' : 'issues',
    repo: { owner: 'owner', repo: 'repo' }, payload: {
      action: 'opened', sender: author, ...(kind === 'pr' ? { pull_request: item } : { issue: item }),
    } };
  const core = { notice() {}, warning() {} };
  const run = () => new WelcomeFunction('context', 'github', 'core', welcomeScript)(context, github, core);
  return { state, item, author, context, run };
}
test('welcomes the first issue or PR once, with the correct message', async () => {
  for (const kind of ['issue', 'pr']) {
    const h = welcomeHarness(kind);
    await h.run();
    assert.equal(h.state.created.length, 1);
    assert.match(h.state.created[0].body, kind === 'issue' ? /first issue/ : /first pull request/);
    assert.match(h.state.created[0].body, /multimedia-downloader:first-contribution/);
    await h.run();
    assert.equal(h.state.created.length, 1);
  }
});
test('earlier issues or PRs by the same author prevent another welcome', async () => {
  for (const kind of ['issue', 'pr']) {
    for (const wasPull of [true, false]) {
      const h = welcomeHarness(kind);
      h.state.history.push({ number: 3, user: h.author, ...(wasPull ? { pull_request: {} } : {}) });
      await h.run();
      assert.equal(h.state.created.length, 0);
    }
  }
});
test('other contributors and newer items do not suppress the first welcome', async () => {
  const h = welcomeHarness('pr');
  h.state.history.push({ number: 1, user: { id: 99, login: 'other', type: 'User' } });
  h.state.history.push({ number: 31, user: h.author });
  await h.run();
  assert.equal(h.state.created.length, 1);
});
test('bot, missing history, changed identity and closed targets do not post', async () => {
  for (const variant of ['bot', 'missing', 'changed', 'closed']) {
    const h = welcomeHarness();
    if (variant === 'bot') h.context.payload.sender = { id: 42, login: 'bot', type: 'Bot' };
    if (variant === 'missing') h.state.history = [];
    if (variant === 'changed') h.state.latest = { ...h.item, user: { id: 43 } };
    if (variant === 'closed') h.state.latest = { ...h.item, state: 'closed' };
    await h.run();
    assert.equal(h.state.created.length, 0, variant);
  }
});
test('existing legacy welcome and malformed history fail closed', async () => {
  const h = welcomeHarness();
  h.state.comments.push({ user: { login: 'github-actions[bot]' },
    body: 'Thank you for opening your first issue! We appreciate the report and will review it.' });
  await h.run();
  assert.equal(h.state.created.length, 0);
  const broken = welcomeHarness();
  broken.state.history.push({ number: null, user: broken.author });
  await assert.rejects(broken.run(), /Incomplete contributor history/);
  assert.equal(broken.state.created.length, 0);
});
