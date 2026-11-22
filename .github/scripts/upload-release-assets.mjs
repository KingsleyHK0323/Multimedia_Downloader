// OpenAI-Codex_format_architecture: reuse only byte-identical assets for the exact release tag.
import { createHash } from 'node:crypto';
import { request } from 'node:https';
import { execFileSync } from 'node:child_process';
import { constants, copyFileSync, createReadStream, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export async function verifyTarget(api, repo, tag, expectedSha) {
  if (tag === 'v4.3.3') throw new Error('v4.3.3 requires separate release authorization.');
  if (!REPO.test(repo) || !TAG.test(tag) || tag.length > 51 || !SHA.test(expectedSha)) {
    throw new Error('Invalid repository, tag or expected source commit.');
  }
  let object = (await api.ref(repo, tag))?.object;
  const seen = new Set();
  for (let depth = 0; depth < 8 && object?.type === 'tag'; depth++) {
    if (!SHA.test(object.sha) || seen.has(object.sha)) throw new Error('Invalid annotated tag chain.');
    seen.add(object.sha);
    object = (await api.tag(repo, object.sha))?.object;
  }
  if (object?.type !== 'commit' || object.sha !== expectedSha) {
    throw new Error('Release tag does not point to the exact checked-out commit.');
  }
}
export function classifyAsset(assets, file) {
  if (!Array.isArray(assets) || !file || typeof file.name !== 'string' ||
      !Number.isSafeInteger(file.size) || file.size <= 0 || !DIGEST.test(file.digest)) {
    throw new Error('Invalid asset inventory or local file metadata.');
  }
  const matches = assets.filter(asset => asset?.name === file.name);
  if (matches.length > 1) throw new Error('Duplicate release asset names.');
  if (!matches.length) return 'missing';
  const asset = matches[0];
  if (asset.state !== 'uploaded' || asset.size !== file.size || asset.digest !== file.digest) {
    throw new Error('Existing release asset differs or cannot be verified.');
  }
  return 'identical';
}
export async function syncAssets({ api, repo, tag, expectedSha, files }) {
  if (!Array.isArray(files) || files.length === 0 ||
      new Set(files.map(file => file.name)).size !== files.length) {
    throw new Error('Release file selection is empty or contains duplicate names.');
  }
  await verifyTarget(api, repo, tag, expectedSha);
  const readRelease = async () => {
    const release = await api.release(repo, tag);
    if (!release || release.tag_name !== tag || release.draft !== true ||
        !Number.isSafeInteger(release.id) || release.id < 1) {
      throw new Error('Expected a matching draft release.');
    }
    return release;
  };
  const first = await readRelease();
  const firstAssets = await api.assets(repo, first.id);
  for (const file of files) classifyAsset(firstAssets, file);

  const results = [];
  for (const file of files) {
    await verifyTarget(api, repo, tag, expectedSha);
    const release = await readRelease();
    if (release.id !== first.id) throw new Error('Release identity changed.');
    let assets = await api.assets(repo, release.id);
    if (classifyAsset(assets, file) === 'identical') {
      results.push({ name: file.name, result: 'reused' });
      continue;
    }
    try {
      // Never pass --clobber: concurrent uploads must remain create-only.
      await api.upload(repo, release.id, file.name, file.path, file.size);
    } catch (error) {
      // A network error or simultaneous upload is safe to accept only if the
      // resulting asset is already byte-identical and still targets this tag.
      await verifyTarget(api, repo, tag, expectedSha);
      const after = await readRelease();
      if (after.id !== first.id) throw new Error('Release identity changed.');
      assets = await api.assets(repo, after.id);
      if (classifyAsset(assets, file) !== 'identical') throw error;
      results.push({ name: file.name, result: 'reused-after-race' });
      continue;
    }
    await verifyTarget(api, repo, tag, expectedSha);
    const after = await readRelease();
    if (after.id !== first.id || classifyAsset(await api.assets(repo, after.id), file) !== 'identical') {
      throw new Error('Uploaded asset cannot be verified.');
    }
    results.push({ name: file.name, result: 'uploaded' });
  }
  await verifyTarget(api, repo, tag, expectedSha);
  return results;
}

export function expectedNames(tag, runnerOs) {
  if (tag === 'v4.3.3') throw new Error('v4.3.3 requires separate release authorization.');
  if (!TAG.test(tag) || tag.length > 51) throw new Error('Invalid version tag.');
  const version = tag.slice(1);
  const names = {
    Linux: [
      'Multimedia.Downloader-' + version + '-1.x86_64.rpm',
      'Multimedia.Downloader_' + version + '_amd64.AppImage',
      'Multimedia.Downloader_' + version + '_amd64.deb',
    ],
    macOS: ['Multimedia.Downloader_' + version + '_aarch64.dmg'],
    Windows: [
      'Multimedia.Downloader_' + version + '_x64-setup.exe',
      'Multimedia.Downloader_' + version + '_x64_en-US.msi',
    ],
  };
  names.all = [...names.Linux, ...names.macOS, ...names.Windows];
  if (!Object.hasOwn(names, runnerOs)) throw new Error('Unexpected runner OS.');
  return names[runnerOs];
}
export async function verifyInventory({ api, repo, tag, expectedSha, manifest }) {
  await verifyTarget(api, repo, tag, expectedSha);
  const release = await api.release(repo, tag);
  if (!release || release.tag_name !== tag || release.draft !== true ||
      !Number.isSafeInteger(release.id) || release.id < 1 ||
      (tag === 'v4.3.22' ? release.prerelease !== true : release.prerelease !== false)) {
    throw new Error('Release is not the expected draft.');
  }
  const expected = new Set(expectedNames(tag, 'all'));
  if (!Array.isArray(manifest) || manifest.length !== expected.size ||
      new Set(manifest.map(file => file?.name)).size !== expected.size ||
      manifest.some(file => !expected.has(file?.name))) {
    throw new Error('Release artifact manifest is incomplete.');
  }
  const assets = await api.assets(repo, release.id);
  const installers = assets.filter(asset => typeof asset?.name === 'string' &&
    (/\.(?:rpm|deb|AppImage|dmg|msi)$/.test(asset.name) || asset.name.endsWith('-setup.exe')));
  if (installers.length !== expected.size || installers.some(asset => !expected.has(asset.name))) {
    throw new Error('Release installer inventory is unexpected.');
  }
  for (const file of manifest) {
    if (classifyAsset(assets, file) !== 'identical') throw new Error('Release asset is missing.');
  }
  await verifyTarget(api, repo, tag, expectedSha);
}

async function digestFile(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return 'sha256:' + digest.digest('hex');
}
export async function collectFiles(root, tag, runnerOs) {
  const expected = new Set(expectedNames(tag, runnerOs));
  const found = new Map();
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        const name = basename(path).replace(/^Multimedia Downloader(?=[_-])/, 'Multimedia.Downloader');
        const installer = /\.(?:deb|rpm|AppImage|dmg|msi)$/.test(name) || name.endsWith('-setup.exe');
        if (installer && !expected.has(name)) throw new Error('Unexpected installer in platform output.');
        if (expected.has(name)) {
          if (found.has(name)) throw new Error('Duplicate local installer names.');
          const stat = statSync(path);
          if (!Number.isSafeInteger(stat.size) || stat.size <= 0) throw new Error('Invalid local installer.');
          found.set(name, { name, path, size: stat.size });
        }
      }
    }
  }
  walk(root);
  if (found.size !== expected.size) throw new Error('Platform installer set is incomplete.');
  const result = [];
  for (const file of found.values()) result.push({ ...file, digest: await digestFile(file.path) });
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

export async function stageFiles(files, tempRoot) {
  if (typeof tempRoot !== 'string' || !tempRoot) throw new Error('Missing trusted runner temporary directory.');
  const dir = mkdtempSync(join(tempRoot, 'release-upload-'));
  const result = [];
  for (const file of files) {
    if (!file || typeof file.name !== 'string' ||
        !/^[A-Za-z0-9._-]+$/.test(file.name) || basename(file.name) !== file.name ||
        !DIGEST.test(file.digest) || !Number.isSafeInteger(file.size) || file.size <= 0) {
      throw new Error('Invalid installer staging metadata.');
    }
    const path = join(dir, file.name);
    copyFileSync(file.path, path, constants.COPYFILE_EXCL);
    const stat = statSync(path);
    if (stat.size !== file.size || await digestFile(path) !== file.digest) {
      throw new Error('Staged installer differs from its checked source.');
    }
    result.push({ ...file, path });
  }
  return result;
}

function gh(...args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 20_000_000 });
}
function parse(value) { return JSON.parse(value); }
function uploadByReleaseId(repo, id, name, path, size) {
  const token = process.env.GH_TOKEN || '';
  if (!token || !REPO.test(repo) || !Number.isSafeInteger(id) || id <= 0 ||
      !/^[A-Za-z0-9._-]+$/.test(name) || !Number.isSafeInteger(size) || size <= 0) {
    throw new Error('Invalid release asset upload parameters.');
  }
  return new Promise((resolveUpload, rejectUpload) => {
    const req = request({
      protocol: 'https:', hostname: 'uploads.github.com', method: 'POST',
      path: '/repos/' + repo + '/releases/' + id + '/assets?name=' + encodeURIComponent(name),
      headers: { 'Accept': 'application/vnd.github+json', 'Authorization': 'Bearer ' + token,
        'User-Agent': 'Multimedia-Downloader-Release', 'Content-Type': 'application/octet-stream',
        'Content-Length': String(size), 'X-GitHub-Api-Version': '2022-11-28' },
    }, response => {
      response.resume();
      response.on('end', () => response.statusCode === 201
        ? resolveUpload() : rejectUpload(new Error('GitHub asset upload failed: HTTP ' + response.statusCode)));
      response.on('error', () => rejectUpload(new Error('GitHub asset upload response failed.')));
    });
    req.setTimeout(1800000, () => req.destroy(new Error('GitHub asset upload timed out.')));
    req.on('error', () => rejectUpload(new Error('GitHub asset upload failed.')));
    const stream = createReadStream(path);
    stream.on('error', () => req.destroy(new Error('Installer data could not be read.')));
    stream.pipe(req);
  });
}
function githubApi() {
  return {
    ref: async (repo, tag) => parse(gh('api', 'repos/' + repo + '/git/ref/tags/' + tag)),
    tag: async (repo, sha) => parse(gh('api', 'repos/' + repo + '/git/tags/' + sha)),
    release: async (repo, tag) => parse(gh('api', 'repos/' + repo + '/releases/tags/' + tag)),
    assets: async (repo, id) => {
      const pages = parse(gh('api', '--paginate', '--slurp',
        'repos/' + repo + '/releases/' + id + '/assets?per_page=100'));
      if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) {
        throw new Error('Invalid paginated release assets.');
      }
      return pages.flat();
    },
    upload: async (repo, releaseId, name, path, size) => uploadByReleaseId(repo, releaseId, name, path, size),
  };
}
async function main() {
  const [tag, mode = 'upload'] = process.argv.slice(2);
  const repo = process.env.GITHUB_REPOSITORY || '';
  const expectedSha = process.env.RELEASE_TARGET_SHA || '';
  if (mode === '--verify-tag') {
    await verifyTarget(githubApi(), repo, tag, expectedSha);
    return;
  }
  if (mode === '--verify-inventory') {
    const encoded = process.env.RELEASE_MANIFEST || '';
    if (encoded.length > 100000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
      throw new Error('Invalid release artifact manifest encoding.');
    }
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded) throw new Error('Invalid release artifact manifest encoding.');
    const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    await verifyInventory({ api: githubApi(), repo, tag, expectedSha, manifest });
    return;
  }
  if (mode !== 'upload') throw new Error('Invalid release asset mode.');
  const temp = resolve(process.env.RUNNER_TEMP || '');
  const root = resolve(process.env.RELEASE_STAGE_DIR || '');
  if (!SHA.test(expectedSha) || !root.startsWith(temp + '/') || !process.env.RUNNER_TEMP) {
    throw new Error('Invalid staging directory or expected commit.');
  }
  const selection = { all: 'all', 'ubuntu-22.04': 'Linux', 'macos-15': 'macOS', 'windows-latest': 'Windows' };
  const requested = process.env.RELEASE_ONLY || '';
  if (!Object.hasOwn(selection, requested)) throw new Error('Invalid platform selection.');
  const collected = await collectFiles(root, tag, selection[requested]);
  const files = await stageFiles(collected, process.env.RUNNER_TEMP || '');
  const results = await syncAssets({ api: githubApi(), repo, tag, expectedSha, files });
  for (const result of results) console.log(result.result + ': ' + result.name);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(); }
  catch (error) {
    console.error('::error::Release asset validation failed: ' + error.message);
    process.exitCode = 1;
  }
}
