// OpenAI-Codex_format_architecture: validate npm publish trust and tag-protection guards.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const workflow = readFileSync(new URL('../workflows/npm-package.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const publish = workflow.split('  publish:\n')[1];
assert.ok(publish);
const step = publish.split('      - name: Verify trusted automation revision\n')[1]
  ?.split('\n      - uses: actions/checkout@')[0];
assert.ok(step);
const shell = step.split('        run: |\n')[1]
  .split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');

test('npm publisher checks a trusted immutable workflow revision before checkout', () => {
  assert.match(publish, /WORKFLOW_SHA: \$\{\{ job\.workflow_sha \}\}/);
  assert.match(publish, /WORKFLOW_REPOSITORY: \$\{\{ job\.workflow_repository \}\}/);
  assert.match(publish, /ref: \$\{\{ job\.workflow_sha \}\}/);
  assert.match(publish, /persist-credentials: false/);
  assert.ok(publish.indexOf('- name: Verify trusted automation revision') < publish.indexOf('- uses: actions/checkout@'));
  assert.ok(publish.indexOf('- uses: actions/checkout@') < publish.indexOf('- name: Verify version-tag protections'));
});

test('npm release mode checks tag rules before package publication', () => {
  const gate = publish.indexOf('- name: Verify version-tag protections');
  const action = publish.indexOf('npm publish ');
  assert.ok(gate >= 0 && action > gate);
  assert.match(publish.slice(gate, action), /if: needs\.build\.outputs\.mode == 'release'/);
  assert.match(publish.slice(gate, action), /node automation\/\.github\/scripts\/verify-tag-protection\.mjs/);
  assert.match(publish.slice(gate, action), /if \[\[ "\$MODE" == release \]\]; then\s+node automation\/\.github\/scripts\/verify-tag-protection\.mjs/);
  assert.match(publish.slice(action), /--ignore-scripts/);
});

test('trusted revision shell rejects foreign or non-ancestral workflow commits', () => {
  const directory = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'npm-workflow-ref-'));
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'),
    '#!/bin/sh\nif [ "$MOCK_BAD" = 1 ]; then sha=ffffffffffffffffffffffffffffffffffffffff; else sha="$WORKFLOW_SHA"; fi\n' +
    'printf "{\\"merge_base_commit\\":{\\"sha\\":\\"%s\\"},\\"behind_by\\":0,\\"status\\":\\"ahead\\"}\\n" "$sha"\n',
    { mode: 0o755 });
  function run(overrides) {
    return spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', shell], {
      cwd: directory, encoding: 'utf8', timeout: 5000,
      env: { ...process.env, PATH: bin + ':' + process.env.PATH, WORKFLOW_SHA: 'a'.repeat(40),
        WORKFLOW_REPOSITORY: 'KingsleyHK0323/Multimedia_Downloader',
        GITHUB_REPOSITORY: 'KingsleyHK0323/Multimedia_Downloader', MOCK_BAD: '0', ...overrides },
    });
  }
  assert.equal(run({}).status, 0);
  assert.notEqual(run({ MOCK_BAD: '1' }).status, 0);
  assert.notEqual(run({ WORKFLOW_REPOSITORY: 'other/repo' }).status, 0);
  assert.notEqual(run({ WORKFLOW_SHA: 'not-a-commit' }).status, 0);
});

test('approved PR verification is read-only and cannot publish packages', () => {
  const verify = workflow.split('  verify-automation:\n')[1]?.split('\n  build:')[0];
  assert.ok(verify);
  assert.match(verify, /github\.event_name == 'pull_request'/);
  assert.match(verify, /PR_NUMBER: \$\{\{ github\.event\.pull_request\.number \}\}/);
  assert.match(verify, /github\.event\.sender\.id == 157894869/);
  assert.match(verify, /head\.repo\.id == 1251103365/);
  assert.match(verify, /permissions:\n      contents: read/);
  assert.doesNotMatch(verify, /contents: write|packages: write|npm publish|NODE_AUTH_TOKEN/);
  assert.match(verify, /GITHUB_REF" == "refs\/pull\/\$PR_NUMBER\/merge"/);
  assert.match(verify, /WORKFLOW_SHA" == "\$PR_HEAD" \|\| "\$WORKFLOW_SHA" == "\$GITHUB_SHA"/);
  assert.match(verify, /ref: \$\{\{ job\.workflow_sha \}\}/);
  assert.match(verify, /node automation\/\.github\/scripts\/verify-tag-protection\.mjs/);
  const build = workflow.split('  build:\n')[1]?.split('\n  publish:')[0];
  assert.match(build, /if: github\.event_name != 'pull_request'/);
  assert.match(publish, /if: github\.event_name != 'pull_request'/);
});

test('PR verification shell binds event number, approved refs and synthetic commit parents', () => {
  const verify = workflow.split('  verify-automation:\n')[1]?.split('\n  build:')[0];
  const step = verify?.split('      - name: Verify approved PR workflow revision\n')[1]
    ?.split('\n      - uses: actions/checkout@')[0];
  assert.ok(step);
  const shell = step.split('        run: |\n')[1].split('\n')
    .map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
  const directory = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'npm-pr-verify-'));
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'),
    '#!/bin/sh\nif [ "$MOCK_BAD_PARENT" = 1 ]; then head=ffffffffffffffffffffffffffffffffffffffff; else head="$PR_HEAD"; fi\n' +
    'printf "{\\"parents\\":[{\\"sha\\":\\"%s\\"},{\\"sha\\":\\"%s\\"}]}\\n" "$PR_BASE" "$head"\n',
    { mode: 0o755 });
  const event = join(directory, 'event.json');
  writeFileSync(event, JSON.stringify({ number: 74, sender: { id: 157894869 },
    pull_request: { user: { id: 157894869 },
      head: { ref: 'automation/protected-workflows', repo: { id: 1251103365 } },
      base: { ref: 'Source_Code', repo: { id: 1251103365 } } } }));
  function run(overrides) {
    return spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', shell], {
      cwd: directory, encoding: 'utf8', timeout: 5000,
      env: { ...process.env, PATH: bin + ':' + process.env.PATH, GITHUB_EVENT_PATH: event,
        GITHUB_REPOSITORY: 'KingsleyHK0323/Multimedia_Downloader',
        GITHUB_HEAD_REF: 'automation/protected-workflows', GITHUB_BASE_REF: 'Source_Code',
        GITHUB_REF: 'refs/pull/74/merge', GITHUB_SHA: 'c'.repeat(40), PR_NUMBER: '74',
        WORKFLOW_SHA: 'a'.repeat(40), WORKFLOW_REPOSITORY: 'KingsleyHK0323/Multimedia_Downloader',
        PR_HEAD: 'a'.repeat(40), PR_BASE: 'b'.repeat(40), MOCK_BAD_PARENT: '0', ...overrides },
    });
  }
  assert.equal(run({}).status, 0);
  assert.notEqual(run({ GITHUB_REF: 'refs/pull/75/merge' }).status, 0);
  assert.notEqual(run({ GITHUB_HEAD_REF: 'automation/Protected-workflows' }).status, 0);
  assert.notEqual(run({ PR_NUMBER: '074' }).status, 0);
  assert.notEqual(run({ MOCK_BAD_PARENT: '1' }).status, 0);
});
