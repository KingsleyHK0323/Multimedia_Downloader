// OpenAI-Codex_format_architecture: exercise patch-release decisions using local fixtures.
import assert from 'node:assert/strict';
import test from 'node:test';
import { planVersion, validateSourcePr, validateVersionPr, versionBranch, VERSION_PATHS } from './patch-release-policy.mjs';

const sha = char => char.repeat(40);
const repo = 'KingsleyHK0323/Multimedia_Downloader';
function source(overrides = {}) {
  return {
    number: 42, state: 'closed', merged: true, merged_at: '2026-11-22T01:00:00Z',
    merge_commit_sha: sha('a'), base: { ref: 'Source_Code', repo: { id: 1251103365, full_name: repo } },
    user: { id: 157894869 }, labels: [{ name: 'release:patch' }], ...overrides,
  };
}
function versionPr(overrides = {}) {
  return {
    number: 43, state: 'closed', merged: true, merge_commit_sha: sha('d'),
    draft: false, auto_merge: null, labels: [],
    user: { id: 359694872 },
    base: { ref: 'Source_Code', sha: sha('b'), repo: { id: 1251103365, full_name: repo } },
    head: { ref: versionBranch(42), sha: sha('c'), repo: { id: 1251103365, full_name: repo } },
    body: 'Patch release.\n<!-- automatic-patch-source:42:' + sha('a') + ' -->\n',
    ...overrides,
  };
}
function files(version = '4.3.22') {
  const manifest = JSON.stringify({ name: 'test', version }, null, 2) + '\n';
  const lock = JSON.stringify({ name: 'test', version, packages: { '': { name: 'test', version },
    child: { version: '1.0.0' } } }, null, 2) + '\n';
  return {
    'package.json': manifest,
    'package-lock.json': lock,
    'frontend/package.json': manifest,
    'frontend/package-lock.json': lock,
    'src-tauri/tauri.conf.json': manifest,
    'src-tauri/Cargo.toml': '[package]\nname = "multimedia-downloader"\nversion = "' + version + '"\n',
    'src-tauri/Cargo.lock': '[[package]]\nname = "multimedia-downloader"\nversion = "' + version + '"\n',
    'README.md': '# Multimedia Downloader — V' + version + '\n',
    'CHANGELOG.md': '# Changelog\n\n### Unreleased\n\n#### Fixes\n- Corrected a problem.\n\n### [4.3.21] — 2026-11-20\n',
    'engine/__init__.py': '__version__ = "' + version + '"\n',
  };
}
test('plans exactly the ten version files with the source PR and release date', () => {
  const before = files();
  const result = planVersion(before, 42, '2026-11-22');
  assert.equal(result.oldVersion, '4.3.22');
  assert.equal(result.version, '4.3.23');
  assert.equal(result.tag, 'v4.3.23');
  assert.deepEqual(Object.keys(result.updates).sort(), [...VERSION_PATHS].sort());
  assert.equal(JSON.parse(result.updates['package-lock.json']).packages[''].version, '4.3.23');
  assert.equal(JSON.parse(result.updates['package-lock.json']).packages.child.version, '1.0.0');
  assert.match(result.updates['CHANGELOG.md'], /### \[4\.3\.23\] — 2026-11-22/);
  assert.equal(before['README.md'], '# Multimedia Downloader — V4.3.22\n');
});
test('blocks v4.3.3, malformed versions, invalid dates and ambiguous files', () => {
  assert.throws(() => planVersion(files('4.3.2'), 42, '2026-11-22'), /separate release authorization/);
  assert.throws(() => planVersion(files('4.03.22'), 42, '2026-11-22'), /Invalid current version/);
  assert.throws(() => planVersion(files('4.3.22'), 0, '2026-11-22'), /Invalid source PR/);
  assert.throws(() => planVersion(files('4.3.22'), 42, '2026-02-30'), /Invalid release date/);
  const bad = files();
  bad['README.md'] += '# Multimedia Downloader — V4.3.22\n';
  assert.throws(() => planVersion(bad, 42, '2026-11-22'), /Unexpected version fields/);
  const missing = files();
  delete missing['CHANGELOG.md'];
  assert.throws(() => planVersion(missing, 42, '2026-11-22'), /incomplete/);
});
test('will not alter nested JSON when root version fields are not the first occurrences', () => {
  const input = files();
  input['package.json'] = '{"nested":{"version":"4.3.22"},"version":"4.3.22"}\n';
  assert.throws(() => planVersion(input, 42, '2026-11-22'), /ambiguous/);
});
test('source PR must be merged, labeled, on this repository and not App-authored', () => {
  assert.deepEqual(validateSourcePr(source()), { number: 42, mergeSha: sha('a') });
  for (const bad of [
    source({ merged: false }), source({ state: 'open' }), source({ labels: [] }),
    source({ user: { id: 359694872 } }), source({ merge_commit_sha: 'bad' }),
    source({ base: { ref: 'Multimedia_Downloader_Web_Preview', repo: { id: 1251103365, full_name: repo } } }),
    source({ base: { ref: 'Source_Code', repo: { full_name: 'other/repo' } } }),
  ]) assert.throws(() => validateSourcePr(bad), /not an eligible/);
});
test('version PR is bound to the exact source, App, repository and branch', () => {
  assert.deepEqual(validateVersionPr(versionPr(), source(), { requireMerged: true }),
    { source: 42, base: sha('b'), head: sha('c'), merge: sha('d') });
  for (const bad of [
    versionPr({ user: { id: 1 } }),
    versionPr({ body: '<!-- automatic-patch-source:42:' + sha('f') + ' -->' }),
    versionPr({ body: '<!-- automatic-patch-source:420:' + sha('a') + ' -->' }),
    versionPr({ body: '<!-- automatic-patch-source:42:' + sha('a') + ' -->\n<!-- automatic-patch-source:42:' + sha('a') + ' -->' }),
    versionPr({ base: { ref: 'Multimedia_Downloader_Web_Preview', sha: sha('b'), repo: { id: 1251103365, full_name: repo } } }),
    versionPr({ head: { ref: 'automation/patch-release-pr-420', sha: sha('c'), repo: { id: 1251103365, full_name: repo } } }),
    versionPr({ merged: false }),
  ]) assert.throws(() => validateVersionPr(bad, source(), { requireMerged: true }));
});

test('version PRs cannot enable native auto-merge, remain draft or trigger patch release', () => {
  for (const changes of [
    { draft: true }, { auto_merge: { enabled_by: { id: 1 } } },
    { labels: [{ name: 'release:patch' }] }, { labels: null },
  ]) assert.throws(() => validateVersionPr(versionPr(changes), source()), /expected App-authored/);
});

test('version bump fails closed on CRLF input rather than mixing newline conventions', () => {
  const input = files();
  input['CHANGELOG.md'] = input['CHANGELOG.md'].replaceAll('\n', '\r\n');
  assert.throws(() => planVersion(input, 42, '2026-11-22'), /LF line endings/);
});

// OpenAI-Codex_health_release_architecture: all patch work uses the same approved temporary branch.
test('patch PRs use only the approved branch and exact repository identity', () => {
  assert.equal(versionBranch(42), 'automation/protected-workflows');
  assert.equal(versionBranch(420), 'automation/protected-workflows');
  const sourcePr = source();
  const pr = versionPr();
  assert.doesNotThrow(() => validateVersionPr(pr, sourcePr));
  assert.throws(() => validateVersionPr({ ...pr, head: { ...pr.head,
    repo: { id: 1, full_name: repo } } }, sourcePr));
  assert.throws(() => validateVersionPr({ ...pr, labels: [{ name: 'Release:Patch' }] }, sourcePr));
});


test('historical version inspection may read a merged source after its label is removed', () => {
  const withdrawn = { ...source(), labels: [] };
  assert.throws(() => validateSourcePr(withdrawn));
  assert.deepEqual(validateSourcePr(withdrawn, { requireCurrentLabel: false }), { number: 42, mergeSha: sha('a') });
  assert.doesNotThrow(() => validateVersionPr(versionPr(), withdrawn, { requireMerged: true, requireCurrentLabel: false }));
});
