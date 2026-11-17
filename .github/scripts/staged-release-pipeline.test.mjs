// OpenAI-Codex: mock-only release pipeline checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const workflow = readFileSync(resolve('.github/workflows/staged-release-pipeline.yml'), 'utf8');
const patchWorkflow = readFileSync(resolve('.github/workflows/auto-patch-release.yml'), 'utf8');
const publishMarker = '      - name: Publish verified release after draft readback\n';
const section = workflow.split(publishMarker)[1];
const runMarker = '        run: |\n';
const runStart = section?.indexOf(runMarker);
assert.ok(runStart >= 0, 'publish shell must exist');
const script = section.slice(runStart + runMarker.length).split('\n').map(line =>
  line.startsWith('          ') ? line.slice(10) : line
).join('\n');

const fakeGh = [
  '#!/usr/bin/env node',
  'const fs = require("node:fs"), path = require("node:path");',
  'const a = process.argv.slice(2), state = process.env.MOCK_STATE, mode = process.env.MOCK_MODE;',
  'const marker = name => path.join(state, name);',
  'const record = () => fs.appendFileSync(marker("calls"), JSON.stringify(a) + "\\n");',
  'record();',
  'const version = process.env.VERSION;',
  'const assets = ["Multimedia.Downloader-" + version + "-1.x86_64.rpm", "Multimedia.Downloader_" + version + "_amd64.AppImage", "Multimedia.Downloader_" + version + "_amd64.deb", "Multimedia.Downloader_" + version + "_aarch64.dmg", "Multimedia.Downloader_" + version + "_x64-setup.exe", "Multimedia.Downloader_" + version + "_x64_en-US.msi"];',
  'if (a[0] === "api") {',
  '  const n = fs.existsSync(marker("api")) ? Number(fs.readFileSync(marker("api"), "utf8")) : 0;',
  '  fs.writeFileSync(marker("api"), String(n + 1));',
  '  console.log(mode === "tag-change" && n > 0 ? "b".repeat(40) : "a".repeat(40));',
  '} else if (a[0] === "release" && a[1] === "create") {',
  '  if (mode === "conflict" || mode === "timeout") process.exit(1);',
  '} else if (a[0] === "release" && a[1] === "view") {',
  '  const query = a[a.indexOf("--jq") + 1] || "";',
  '  const n = fs.existsSync(marker("view")) ? Number(fs.readFileSync(marker("view"), "utf8")) : 0;',
  '  fs.writeFileSync(marker("view"), String(n + 1));',
  '  if (query.includes(".assets[].name")) console.log(assets.sort().join(","));',
  '  else if (query.includes("isDraft == true")) console.log(mode === "draft-change" && n > 0 ? "false" : "true");',
  '  else if (query.includes("isDraft == false")) console.log("true");',
  '  else if (query.includes("length == 0")) console.log("true");',
  '  else if (query.includes("length == 6")) console.log("true");',
  '  else process.exit(2);',
  '} else if (a[0] === "release" && a[1] === "upload") {',
  '  const n = fs.existsSync(marker("uploads")) ? Number(fs.readFileSync(marker("uploads"), "utf8")) : 0;',
  '  fs.writeFileSync(marker("uploads"), String(n + 1));',
  '  if (mode === "upload-failure" && n === 2) process.exit(1);',
  '  const destination = marker(path.basename(a[3]));',
  '  if (fs.existsSync(destination)) process.exit(1);',
  '  fs.copyFileSync(a[3], destination);',
  '} else if (a[0] === "release" && a[1] === "download") {',
  '  if (mode === "download-failure") process.exit(1);',
  '  const name = a[a.indexOf("--pattern") + 1], dir = a[a.indexOf("--dir") + 1];',
  '  fs.copyFileSync(marker(name), path.join(dir, name));',
  '  if (mode === "download-corrupt") fs.appendFileSync(path.join(dir, name), "corrupt");',
  '} else if (a[0] === "release" && a[1] === "edit") {',
  '  fs.writeFileSync(marker("published"), "yes");',
  '} else process.exit(2);',
].join('\n');

function execute(mode) {
  const root = mkdtempSync(join(tmpdir(), 'staged-release-mock-'));
  const bin = join(root, 'bin'), state = join(root, 'state'), temp = join(root, 'temp');
  for (const folder of [bin, state, temp]) mkdirSync(folder);
  writeFileSync(join(bin, 'gh'), fakeGh);
  chmodSync(join(bin, 'gh'), 0o755);

  const files = {
    'ubuntu-22.04': ['Multimedia.Downloader-1.2.3-1.x86_64.rpm', 'Multimedia.Downloader_1.2.3_amd64.AppImage', 'Multimedia.Downloader_1.2.3_amd64.deb'],
    'macos-15': ['Multimedia.Downloader_1.2.3_aarch64.dmg'],
    'windows-latest': ['Multimedia.Downloader_1.2.3_x64-setup.exe', 'Multimedia.Downloader_1.2.3_x64_en-US.msi'],
  };
  for (const [platform, names] of Object.entries(files)) {
    const folder = join(root, 'staged-artifacts', 'staged-123-1-' + platform);
    mkdirSync(folder, { recursive: true });
    for (const name of names) writeFileSync(join(folder, name), 'test bytes ' + name);
  }
  if (mode === 'duplicate') writeFileSync(join(state, files['ubuntu-22.04'][0]), 'existing asset');
  const env = {
    ...process.env,
    PATH: bin + ':' + process.env.PATH,
    MOCK_STATE: state,
    MOCK_MODE: mode,
    RUNNER_TEMP: temp,
    TAG: 'v1.2.3',
    SOURCE_SHA: 'a'.repeat(40),
    VERSION: '1.2.3',
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_REPOSITORY: 'example/repo',
    GH_TOKEN: 'mock',
  };
  const result = spawnSync('bash', ['--noprofile', '--norc', '-c', script], {
    cwd: root, env, encoding: 'utf8', timeout: 10000,
  });
  const calls = readFileSync(join(state, 'calls'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  return { status: result.status, error: result.error, stderr: result.stderr, calls, state };
}

test('publishing job is automatic, protected, and the only contents writer', () => {
  assert.match(workflow, /environment:\s*\n\s*name: staged-release-publish/);
  assert.match(workflow, /contents:\s*write/);
  assert.match(workflow, /needs: \[validate-input, protection-preflight, verify-artifacts\]/);
  assert.doesNotMatch(workflow, /required_reviewers|protection-gate:|create-draft:/);
  assert.match(workflow, /gh release edit "\$TAG" --repo "\$GITHUB_REPOSITORY" --draft=false/);
});

test('success publishes only after six exact byte readbacks', () => {
  const result = execute('success');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls.filter(call => call[1] === 'create').length, 1);
  assert.equal(result.calls.filter(call => call[1] === 'upload').length, 6);
  assert.equal(result.calls.filter(call => call[1] === 'download').length, 6);
  assert.equal(result.calls.filter(call => call[1] === 'edit').length, 1);
  assert.ok(result.calls.at(-1)[1] === 'view');
  assert.ok(result.calls.every(call => !call.includes('--clobber') && call[1] !== 'delete'));
  assert.ok(result.calls.find(call => call[1] === 'create').includes('--draft'));
});

for (const mode of ['conflict', 'timeout']) {
  test(mode + ' stops without upload or retry', () => {
    const result = execute(mode);
    assert.notEqual(result.status, 0);
    assert.equal(result.calls.filter(call => call[1] === 'create').length, 1);
    assert.equal(result.calls.filter(call => call[1] === 'upload').length, 0);
    assert.equal(result.calls.filter(call => call[1] === 'edit').length, 0);
  });
}

for (const mode of ['tag-change', 'draft-change']) {
  test(mode + ' stops before publication', () => {
    const result = execute(mode);
    assert.notEqual(result.status, 0);
    assert.equal(result.calls.filter(call => call[1] === 'edit').length, 0);
    assert.ok(result.calls.every(call => call[1] !== 'delete'));
  });
}

for (const [mode, uploads] of [['upload-failure', 3], ['duplicate', 1], ['download-failure', 6], ['download-corrupt', 6]]) {
  test(mode + ' stops without retry or cleanup', () => {
    const result = execute(mode);
    assert.notEqual(result.status, 0);
    assert.equal(result.calls.filter(call => call[1] === 'upload').length, uploads);
    assert.equal(result.calls.filter(call => call[1] === 'create').length, 1);
    assert.equal(result.calls.filter(call => call[1] === 'edit').length, 0);
    assert.ok(result.calls.every(call => call[1] !== 'delete' && !call.includes('--clobber')));
  });
}


test('automatic patch release dispatches the pipeline on the exact pushed tag', () => {
  assert.ok(patchWorkflow.includes('gh workflow run .github/workflows/staged-release-pipeline.yml'));
  assert.ok(patchWorkflow.includes('--ref "$TAG"'));
  assert.ok(patchWorkflow.includes('-f source_sha="$SOURCE_SHA" -f tag="$TAG"'));
  assert.ok(!patchWorkflow.includes('uses: ./.github/workflows/release.yml'));
});
