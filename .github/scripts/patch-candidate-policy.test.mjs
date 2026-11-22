// OpenAI-Codex_health_release_architecture: exercise exact version candidate validation.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { validatePatchCandidate } from './patch-candidate-policy.mjs';
import { planVersion, VERSION_PATHS } from './patch-release-policy.mjs';

const repo = 'KingsleyHK0323/Multimedia_Downloader', repoId = 1251103365;
const base = 'a'.repeat(40), head = 'b'.repeat(40), sourceMerge = 'c'.repeat(40);
const bot = 'kingsley-multimedia-automation[bot]';
function hash(text) {
  const bytes = Buffer.from(text);
  return createHash('sha1').update(Buffer.concat([Buffer.from('blob ' + bytes.length + '\0'), bytes])).digest('hex');
}
function setup() {
  const version = '4.3.22', date = '2026-11-22';
  const manifest = JSON.stringify({ name: 'test', version }, null, 2) + '\n';
  const lock = JSON.stringify({ name: 'test', version, packages: { '': { version } } }, null, 2) + '\n';
  const files = {
    'package.json': manifest, 'package-lock.json': lock,
    'frontend/package.json': manifest, 'frontend/package-lock.json': lock,
    'src-tauri/tauri.conf.json': manifest,
    'src-tauri/Cargo.toml': '[package]\nversion = "' + version + '"\n',
    'src-tauri/Cargo.lock': '[[package]]\nname = "multimedia-downloader"\nversion = "' + version + '"\n',
    'README.md': '# Multimedia Downloader — V' + version + '\n',
    'CHANGELOG.md': '### Unreleased\n\n#### Fixed\n- Correct release handling.\n\n### [4.3.22] — 2026-11-18\n',
    'engine/__init__.py': '__version__ = "' + version + '"\n',
  };
  const plan = planVersion(files, 42, date);
  const baseTree = VERSION_PATHS.map(path => ({ path, type: 'blob', mode: '100644', sha: hash(files[path]) }));
  baseTree.push({ path: 'unrelated.txt', type: 'blob', mode: '100644', sha: hash('original') });
  const headTree = baseTree.map(item => ({ ...item, sha: plan.updates[item.path] ? hash(plan.updates[item.path]) : item.sha }));
  const source = { number: 42, state: 'closed', merged: true, merged_at: '2026-11-22T10:00:00Z',
    merge_commit_sha: sourceMerge, labels: [{ name: 'release:patch' }], user: { id: 157894869 },
    base: { ref: 'Source_Code', repo: { id: repoId, full_name: repo } } };
  const versionPr = { number: 200, state: 'open', draft: false, auto_merge: null, labels: [],
    user: { id: 359694872, login: bot, type: 'Bot' }, changed_files: 10,
    html_url: 'https://github.com/' + repo + '/pull/200',
    body: '<!-- automatic-patch-source:42:' + sourceMerge + ' -->\n',
    base: { ref: 'Source_Code', sha: base, repo: { id: repoId, full_name: repo } },
    head: { ref: 'automation/protected-workflows', sha: head, repo: { id: repoId, full_name: repo } } };
  const message = 'chore: release ' + plan.tag + ' after PR #42\n\n' +
    'Automatic patch release for merged PR #42\nPatch-Source-SHA: ' + sourceMerge +
    '\nPatch-Plan-Date: ' + date + '\nOpenAI-Codex_health_release_architecture';
  const headCommit = { sha: head, tree: { sha: 'd'.repeat(40) }, parents: [{ sha: base }], message };
  const signedCommit = { sha: head, author: { id: 359694872, login: bot, type: 'Bot' },
    committer: { id: 19864447, login: 'web-flow', type: 'User' },
    commit: { tree: { sha: headCommit.tree.sha }, verification: { verified: true, reason: 'valid' } },
    parents: [{ sha: base }] };
  const changedFiles = VERSION_PATHS.map(path => ({ filename: path, status: 'modified',
    sha: headTree.find(item => item.path === path).sha }));
  return { source, versionPr, base, headCommit, signedCommit, baseTree, headTree, files, changedFiles };
}

test('accepts the signed one-parent candidate only when the entire tree equals the version plan', () => {
  const result = validatePatchCandidate(setup());
  assert.equal(result.tag, 'v4.3.23');
  assert.equal(result.source, 42);
  assert.equal(result.base, base);
  assert.equal(result.head, head);
});

test('rejects stale base, a forged signer, and extra parents', () => {
  for (const mutate of [
    x => { x.versionPr.base.sha = 'e'.repeat(40); },
    x => { x.signedCommit.committer.id = 99; },
    x => { x.headCommit.parents.push({ sha: 'e'.repeat(40) }); },
    x => { x.signedCommit.commit.verification.verified = false; },
  ]) {
    const candidate = setup(); mutate(candidate);
    assert.throws(() => validatePatchCandidate(candidate));
  }
});

test('rejects unrelated tree changes and altered version bytes', () => {
  const unrelated = setup();
  unrelated.headTree.find(item => item.path === 'unrelated.txt').sha = hash('changed');
  assert.throws(() => validatePatchCandidate(unrelated), /unrelated/);
  const changed = setup();
  changed.headTree.find(item => item.path === 'package.json').sha = hash('invalid');
  assert.throws(() => validatePatchCandidate(changed), /differs/);
  const modifiedSource = setup();
  modifiedSource.files['package.json'] += ' ';
  assert.throws(() => validatePatchCandidate(modifiedSource), /base tree/);
  const nul = setup();
  nul.files['README.md'] += String.fromCharCode(0);
  assert.throws(() => validatePatchCandidate(nul), /base tree/);
});

test('rejects a retargeted, relabeled, incomplete, or auto-merging version PR', () => {
  for (const mutate of [
    x => { x.versionPr.base.ref = 'Multimedia_Downloader_Web_Preview'; },
    x => { x.versionPr.labels = [{ name: 'Release:Patch' }]; },
    x => { x.versionPr.auto_merge = {}; },
    x => { x.changedFiles.pop(); },
    x => { x.changedFiles[0].previous_filename = 'old.json'; },
  ]) {
    const candidate = setup(); mutate(candidate);
    assert.throws(() => validatePatchCandidate(candidate));
  }
});

test('requires an exact merged head before using a candidate for release reconciliation', () => {
  const candidate = setup();
  candidate.versionPr.state = 'closed';
  candidate.versionPr.merged = true;
  candidate.versionPr.merge_commit_sha = head;
  assert.equal(validatePatchCandidate({ ...candidate, phase: 'merged' }).head, head);
  candidate.versionPr.merge_commit_sha = 'e'.repeat(40);
  assert.throws(() => validatePatchCandidate({ ...candidate, phase: 'merged' }));
  assert.throws(() => validatePatchCandidate({ ...candidate, phase: 'unexpected' }));
});

test('merged candidates remain inspectable after the source label is removed', () => {
  const candidate = setup();
  candidate.source.labels = [];
  assert.throws(() => validatePatchCandidate(candidate));
  candidate.versionPr.state = 'closed';
  candidate.versionPr.merged = true;
  candidate.versionPr.merge_commit_sha = head;
  assert.equal(validatePatchCandidate({ ...candidate, phase: 'merged' }).head, head);
});
