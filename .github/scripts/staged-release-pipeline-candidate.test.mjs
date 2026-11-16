// OpenAI-Codex_safe_scope: mock-only candidate tests; never call real GitHub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const workflow = readFileSync(resolve('.github/workflows/staged-release-pipeline-candidate.yml'), 'utf8');
const gate = workflow.split('  protection-gate:')[1]?.split('  create-draft:')[0];
const section = workflow.split('      - name: Create draft and upload without replacement')[1];
const shellLines = section?.split('\n').slice(section.split('\n').findIndex(x => x.trim() === 'run: |') + 1);
assert.ok(gate && shellLines?.length, 'candidate job must exist');
const script = shellLines.map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');

const fakeGh = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2), state = process.env.MOCK_STATE;
fs.appendFileSync(path.join(state,'calls'), JSON.stringify(a)+'\\n');
const marker = name => path.join(state,name);
if (a[0] === 'api') {
  const n = fs.existsSync(marker('api')) ? Number(fs.readFileSync(marker('api'),'utf8')) : 0;
  fs.writeFileSync(marker('api'),String(n+1));
  console.log(process.env.MOCK_MODE === 'tag-change' && n > 0 ? 'b'.repeat(40) : 'a'.repeat(40));
} else if (a[0] === 'release' && a[1] === 'create') {
  if (process.env.MOCK_MODE === 'conflict' || process.env.MOCK_MODE === 'timeout') process.exit(1);
} else if (a[0] === 'release' && a[1] === 'view') {
  const n = fs.existsSync(marker('view')) ? Number(fs.readFileSync(marker('view'),'utf8')) : 0;
  fs.writeFileSync(marker('view'),String(n+1));
  console.log(process.env.MOCK_MODE === 'draft-change' && n > 0 ? 'false' : 'true');
} else if (a[0] === 'release' && a[1] === 'upload') {
  const n = fs.existsSync(marker('uploads')) ? Number(fs.readFileSync(marker('uploads'),'utf8')) : 0;
  fs.writeFileSync(marker('uploads'), String(n+1));
  if (process.env.MOCK_MODE === 'upload-failure' && n === 2) process.exit(1);
  if (fs.existsSync(path.join(state,path.basename(a[3])))) process.exit(1);
  fs.copyFileSync(a[3],path.join(state,path.basename(a[3])));
} else if (a[0] === 'release' && a[1] === 'download') {
  if (process.env.MOCK_MODE === 'download-failure') process.exit(1);
  const name = a[a.indexOf('--pattern')+1], dir = a[a.indexOf('--dir')+1];
  fs.copyFileSync(path.join(state,name),path.join(dir,name));
  if (process.env.MOCK_MODE === 'download-corrupt') fs.appendFileSync(path.join(dir,name),'corrupt');
} else process.exit(2);
`;

function execute(mode) {
  const root = mkdtempSync(join(tmpdir(), 'staged-draft-mock-'));
  try {
    const bin = join(root, 'bin'), state = join(root, 'state'), temp = join(root, 'temp');
    for (const p of [bin, state, temp]) mkdirSync(p);
    writeFileSync(join(bin, 'gh'), fakeGh); chmodSync(join(bin, 'gh'), 0o755);
    const files = {
      'ubuntu-22.04': ['Multimedia.Downloader-1.2.3-1.x86_64.rpm', 'Multimedia.Downloader_1.2.3_amd64.AppImage', 'Multimedia.Downloader_1.2.3_amd64.deb'],
      'macos-15': ['Multimedia.Downloader_1.2.3_aarch64.dmg'],
      'windows-latest': ['Multimedia.Downloader_1.2.3_x64-setup.exe', 'Multimedia.Downloader_1.2.3_x64_en-US.msi'],
    };
    for (const [platform, names] of Object.entries(files)) {
      const dir = join(root, 'staged-artifacts', `staged-123-1-${platform}`); mkdirSync(dir, { recursive: true });
      for (const name of names) writeFileSync(join(dir, name), `test bytes ${name}`);
    }
    if (mode === 'duplicate') writeFileSync(join(state, files['ubuntu-22.04'][0]), 'existing asset');
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, MOCK_STATE: state, MOCK_MODE: mode,
      RUNNER_TEMP: temp, TAG: 'v1.2.3', SOURCE_SHA: 'a'.repeat(40), VERSION: '1.2.3',
      GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', GITHUB_REPOSITORY: 'example/repo', GH_TOKEN: 'mock' };
    const result = spawnSync('bash', ['-c', script], { cwd: root, env, encoding: 'utf8', timeout: 10000 });
    const calls = readFileSync(join(state, 'calls'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    return { status: result.status, error: result.error, stderr: result.stderr, calls };
  } finally { /* Runner temporary data is left for runner disposal. */ }
}

test('protection gate is unconditional and fails closed', () => {
  assert.match(gate, /exit 1/);
  assert.doesNotMatch(gate, /if:/);
  assert.match(workflow, /needs: \[validate-input, build, verify-artifacts, protection-gate\]/);
});

test('mock success creates draft and uploads six files without public or overwrite commands', () => {
  const r = execute('success'); assert.equal(r.status, 0, r.stderr);
  const create = r.calls.filter(x => x[1] === 'create');
  assert.equal(create.length, 1); assert.ok(create[0].includes('--draft')); assert.ok(create[0].includes('--verify-tag'));
  assert.equal(r.calls.filter(x => x[1] === 'upload').length, 6);
  assert.equal(r.calls.filter(x => x[1] === 'download').length, 6);
  assert.ok(r.calls.every(x => !x.includes('--clobber') && x[1] !== 'edit' && x[1] !== 'delete'));
});

for (const mode of ['conflict', 'timeout']) test(`${mode} stops without upload or retry`, () => {
  const r = execute(mode); assert.notEqual(r.status, 0);
  assert.equal(r.calls.filter(x => x[1] === 'create').length, 1);
  assert.equal(r.calls.filter(x => x[1] === 'upload').length, 0);
});

for (const mode of ['tag-change', 'draft-change']) test(`${mode} is detected on final readback`, () => {
  const r = execute(mode); assert.notEqual(r.status, 0);
  assert.equal(r.calls.filter(x => x[1] === 'upload').length, 6);
  assert.ok(r.calls.every(x => x[1] !== 'edit' && x[1] !== 'delete'));
});

for (const [mode, uploads] of [['upload-failure', 3], ['duplicate', 1], ['download-failure', 6], ['download-corrupt', 6]]) {
  test(`${mode} stops without retries or cleanup`, () => {
    const r = execute(mode); assert.notEqual(r.status, 0);
    assert.equal(r.calls.filter(x => x[1] === 'upload').length, uploads);
    assert.equal(r.calls.filter(x => x[1] === 'create').length, 1);
    assert.ok(r.calls.every(x => x[1] !== 'edit' && x[1] !== 'delete' && !x.includes('--clobber')));
  });
}

test('actual verifier accepts six matching files and rejects corrupted bytes', () => {
  const verify = workflow.split('      - name: Verify all staged artifacts')[1]?.split('          python - <<\'PY\'\n')[1]?.split('\n          PY')[0];
  assert.ok(verify, 'actual verifier must be found');
  const root = mkdtempSync(join(tmpdir(), 'staged-verify-mock-'));
  const files = {
    'ubuntu-22.04': ['Multimedia.Downloader-1.2.3-1.x86_64.rpm', 'Multimedia.Downloader_1.2.3_amd64.AppImage', 'Multimedia.Downloader_1.2.3_amd64.deb'],
    'macos-15': ['Multimedia.Downloader_1.2.3_aarch64.dmg'],
    'windows-latest': ['Multimedia.Downloader_1.2.3_x64-setup.exe', 'Multimedia.Downloader_1.2.3_x64_en-US.msi'],
  };
  for (const [platform, names] of Object.entries(files)) {
    const dir = join(root, 'staged-artifacts', `staged-123-1-${platform}`); mkdirSync(dir, { recursive: true });
    const assets = names.map(name => {
      const bytes = Buffer.from(`bytes ${name}`); writeFileSync(join(dir, name), bytes);
      return { name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    });
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ sourceSha: 'a'.repeat(40), version: '1.2.3', runId: '123', attempt: '1', platform, assets }));
  }
  const env = { ...process.env, SOURCE_SHA: 'a'.repeat(40), VERSION: '1.2.3', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' };
  const run = () => spawnSync('python3', ['-c', verify.split('\n').map(x => x.slice(10)).join('\n')], { cwd: root, env, encoding: 'utf8' });
  const good = run(); assert.equal(good.status, 0, good.stderr);
  writeFileSync(join(root, 'staged-artifacts', 'staged-123-1-macos-15', files['macos-15'][0]), 'wrong');
  const bad = run(); assert.notEqual(bad.status, 0); assert.match(bad.stderr, /digest, size or uniqueness mismatch/);
});

