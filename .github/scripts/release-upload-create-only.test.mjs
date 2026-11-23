// OpenAI-Codex_format_architecture: exercise release asset recovery with an in-memory GitHub API.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { classifyAsset, expectedNames, findUniqueRelease, stageFiles, syncAssets, verifyInventory, verifyTarget } from './upload-release-assets.mjs';

const repo = 'KingsleyHK0323/Multimedia_Downloader';
const tag = 'v4.3.23';
const sha = 'a'.repeat(40);
const digest = 'sha256:' + 'b'.repeat(64);
const file = { name: 'Multimedia.Downloader_4.3.23_amd64.deb', path: '/tmp/installer', size: 42, digest };
const remote = () => ({ name: file.name, size: file.size, digest: file.digest, state: 'uploaded' });

function fake(options = {}) {
  const calls = [];
  const assets = options.assets ? [...options.assets] : [];
  let refCalls = 0;
  let releaseCalls = 0;
  const api = {
    assertTagProtection: async () => { if (options.unsafeRules) throw new Error('tag rules unavailable'); },
    ref: async () => {
      refCalls++;
      return { object: { type: options.annotated ? 'tag' : 'commit',
        sha: options.moveTagAt === refCalls ? 'c'.repeat(40) : (options.annotated ? 'd'.repeat(40) : sha) } };
    },
    tag: async () => ({ object: { type: 'commit', sha } }),
    release: async () => {
      releaseCalls++;
      return { id: 123, tag_name: tag, draft: options.publishAt === releaseCalls ? false : true };
    },
    assets: async () => [...assets],
    upload: async (ownerRepo, releaseId, name, path, size) => {
      calls.push({ repo: ownerRepo, releaseId, name, path, size });
      if (!options.noRemoteOnUpload) assets.push(remote());
      if (options.uploadError) throw new Error('network or conflict');
    },
  };
  return { api, assets, calls };
}
function run(state, files = [file]) {
  return syncAssets({ api: state.api, repo, tag, expectedSha: sha, files });
}
test('reuses only an exact existing digest and size, with no upload', async () => {
  const state = fake({ assets: [remote()] });
  assert.deepEqual(await run(state), [{ name: file.name, result: 'reused' }]);
  assert.deepEqual(state.calls, []);
});
test('creates a missing asset and verifies its remote digest', async () => {
  const state = fake();
  assert.deepEqual(await run(state), [{ name: file.name, result: 'uploaded' }]);
  assert.equal(state.calls.length, 1);
  assert.deepEqual(state.calls[0], { repo, releaseId: 123, name: file.name, path: file.path, size: file.size });
});
test('an ambiguous failed upload is accepted only if the asset now matches', async () => {
  const same = fake({ uploadError: true });
  assert.equal((await run(same))[0].result, 'reused-after-race');
  const absent = fake({ uploadError: true, noRemoteOnUpload: true });
  await assert.rejects(run(absent), /network or conflict/);
});
test('different, incomplete, duplicate and digestless existing assets fail closed', async () => {
  for (const assets of [
    [{ ...remote(), digest: 'sha256:' + 'c'.repeat(64) }],
    [{ ...remote(), size: 41 }],
    [{ ...remote(), state: 'starter' }],
    [{ ...remote(), digest: null }],
    [remote(), remote()],
  ]) {
    const state = fake({ assets });
    await assert.rejects(run(state), /differs|Duplicate/);
    assert.deepEqual(state.calls, []);
  }
});
test('tag changes and published releases cannot be reused or uploaded', async () => {
  for (const state of [fake({ moveTagAt: 1 }), fake({ publishAt: 1 })]) {
    await assert.rejects(run(state), /exact checked-out commit|matching draft release/);
    assert.deepEqual(state.calls, []);
  }
  const publishedBeforeUpload = fake({ publishAt: 2 });
  await assert.rejects(run(publishedBeforeUpload), /matching draft release/);
  assert.deepEqual(publishedBeforeUpload.calls, []);
});
test('all existing assets are checked before any missing asset is uploaded', async () => {
  const other = { name: 'second.deb', path: '/tmp/second', size: 10, digest };
  const state = fake({ assets: [{ name: other.name, size: 9, digest, state: 'uploaded' }] });
  await assert.rejects(run(state, [file, other]), /differs/);
  assert.deepEqual(state.calls, []);
});
test('an uploaded asset without a verified remote digest fails', async () => {
  const state = fake({ noRemoteOnUpload: true });
  await assert.rejects(run(state), /cannot be verified/);
  assert.equal(state.calls.length, 1);
});
test('annotated tags resolve to the exact source commit', async () => {
  const state = fake({ annotated: true });
  await verifyTarget(state.api, repo, tag, sha);
  await assert.rejects(verifyTarget(state.api, repo, tag, 'f'.repeat(40)), /exact checked-out commit/);
});
test('asset classifications and platform names are strict', () => {
  assert.equal(classifyAsset([], file), 'missing');
  assert.equal(expectedNames(tag, 'Linux').length, 3);
  assert.equal(expectedNames(tag, 'macOS').length, 1);
  assert.equal(expectedNames(tag, 'Windows').length, 2);
  assert.equal(expectedNames(tag, 'all').length, 6);
  assert.throws(() => expectedNames('v4.03.23', 'Linux'));
  assert.throws(() => expectedNames('v4.3.3', 'Linux'), /separate release authorization/);
  assert.throws(() => expectedNames(tag, 'Solaris'));
});

test('release workflow calls the guarded uploader without a clobber flag', () => {
  const workflow = readFileSync(new URL('../workflows/release.yml', import.meta.url), 'utf8');
  const block = workflow.split('      - name: Upload or verify exact release assets\n')[1]
    ?.split('\n  # OpenAI-Codex: apply the same asset')[0];
  assert.ok(block);
  assert.match(block, /node automation\/\.github\/scripts\/upload-release-assets\.mjs "\$RELEASE_TAG"/);
  assert.doesNotMatch(block, /--clobber/);
});

test('stages a space-containing basename under the exact GitHub asset name', async () => {
  const root = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'release-asset-stage-test-'));
  const source = join(root, 'Multimedia Downloader_4.3.23_amd64.deb');
  const bytes = Buffer.from('fixture installer');
  writeFileSync(source, bytes);
  const expected = { name: file.name, path: source, size: bytes.length,
    digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex') };
  const [staged] = await stageFiles([expected], root);
  assert.equal(staged.path.split(/[\\/]/).at(-1), expected.name);
  assert.deepEqual(readFileSync(staged.path), bytes);
});
test('staging rejects changed installer bytes and unsafe names', async () => {
  const root = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'release-asset-stage-reject-'));
  const source = join(root, 'source file.deb');
  writeFileSync(source, 'not the claimed bytes');
  await assert.rejects(stageFiles([{ ...file, path: source }], root), /differs/);
  await assert.rejects(stageFiles([{ ...file, name: '../escape', path: source }], root), /metadata/);
});

test('publication inventory must match all six staged bytes', async () => {
  const names = expectedNames(tag, 'all');
  const manifest = names.map((name, index) => ({ name, size: index + 1, digest }));
  const state = fake({ assets: manifest.map(item => ({ ...item, state: 'uploaded' })) });
  // OpenAI-Codex: v4.3.23 inventory must belong to a prerelease draft.
  state.api.release = async () => ({ id: 123, tag_name: tag, draft: true, prerelease: true });
  await verifyInventory({ api: state.api, repo, tag, expectedSha: sha, manifest });
  state.api.release = async () => ({ id: 123, tag_name: tag, draft: true, prerelease: false });
  await assert.rejects(verifyInventory({ api: state.api, repo, tag, expectedSha: sha, manifest }), /expected draft/);
  state.api.release = async () => ({ id: 123, tag_name: tag, draft: true, prerelease: true });
  state.assets[0].digest = 'sha256:' + 'c'.repeat(64);
  await assert.rejects(verifyInventory({ api: state.api, repo, tag, expectedSha: sha, manifest }), /differs/);
});

test('tag protection failure prevents asset upload or publication inventory approval', async () => {
  const upload = fake({ unsafeRules: true });
  await assert.rejects(run(upload), /tag rules unavailable/);
  assert.deepEqual(upload.calls, []);
  const inventory = fake({ unsafeRules: true });
  await assert.rejects(verifyInventory({ api: inventory.api, repo, tag, expectedSha: sha, manifest: [] }),
    /tag rules unavailable/);
});

// OpenAI-Codex: draft lookup must be paginated and reject ambiguous tags.
test('finds one draft across pages and rejects missing or duplicate tags', () => {
  const draft = { id: 123, tag_name: tag, draft: true, prerelease: true };
  assert.equal(findUniqueRelease([[{ tag_name: 'v1.0.0' }], [draft]], tag), draft);
  assert.throws(() => findUniqueRelease([[]], tag), /exactly one/);
  assert.throws(() => findUniqueRelease([[draft], [draft]], tag), /exactly one/);
  assert.throws(() => findUniqueRelease([{}], tag), /paginated/);
  assert.throws(() => findUniqueRelease([], tag), /paginated/);
});
