// OpenAI-Codex_format_architecture: verify release version files as data at an immutable commit.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const SHA = /^[0-9a-f]{40}$/;
const TAG = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const VERSION_FILES = Object.freeze([
  'package.json', 'package-lock.json', 'frontend/package.json', 'frontend/package-lock.json',
  'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock',
  'README.md', 'CHANGELOG.md', 'engine/__init__.py',
]);
function versionMatch(source, pattern, name, wanted) {
  const found = source.match(pattern);
  if (!found || found[1] !== wanted) throw new Error('Incorrect version in ' + name);
}
export function verifyVersionFiles(files, tag) {
  if (!TAG.test(tag) || tag.length > 51 || tag === 'v4.3.3') throw new Error('Invalid or reserved release tag.');
  if (!files || VERSION_FILES.some(path => typeof files[path] !== 'string')) throw new Error('Missing version files.');
  const wanted = tag.slice(1);
  for (const name of ['package.json', 'package-lock.json', 'frontend/package.json',
    'frontend/package-lock.json', 'src-tauri/tauri.conf.json']) {
    const value = JSON.parse(files[name]);
    if (!value || Array.isArray(value) || value.version !== wanted) throw new Error('Incorrect version in ' + name);
    if (name.endsWith('package-lock.json') && value.packages?.['']?.version !== wanted) {
      throw new Error('Incorrect root lock version in ' + name);
    }
  }
  versionMatch(files['src-tauri/Cargo.toml'], /^version\s*=\s*"([^"]+)"\s*$/m, 'Cargo.toml', wanted);
  versionMatch(files['src-tauri/Cargo.lock'], /^name = "multimedia-downloader"\r?\nversion = "([^"]+)"/m, 'Cargo.lock', wanted);
  versionMatch(files['README.md'], /^#\s+Multimedia Downloader\s+—\s+V(\S+)/m, 'README.md', wanted);
  versionMatch(files['CHANGELOG.md'], /^###\s+\[([^\]]+)\]/m, 'CHANGELOG.md', wanted);
  versionMatch(files['engine/__init__.py'], /^__version__\s*=\s*"([^"]+)"/m, 'engine/__init__.py', wanted);
}
export async function fetchVersionFiles(api, repo, commit) {
  if (!REPO.test(repo) || !SHA.test(commit)) throw new Error('Invalid immutable source.');
  const data = await api.commit(repo, commit);
  if (data?.sha !== commit || !SHA.test(data.tree?.sha || '')) throw new Error('Invalid source commit.');
  const tree = await api.tree(repo, data.tree.sha);
  if (tree?.truncated !== false || !Array.isArray(tree.tree)) throw new Error('Incomplete source tree.');
  const entries = new Map(tree.tree.map(item => [item.path, item]));
  if (entries.size !== tree.tree.length) throw new Error('Duplicate source tree paths.');
  const files = {};
  let total = 0;
  for (const path of VERSION_FILES) {
    const entry = entries.get(path);
    if (!entry || entry.type !== 'blob' || entry.mode !== '100644' || !SHA.test(entry.sha || '') ||
        !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 5_000_000) {
      throw new Error('Unsafe version file: ' + path);
    }
    total += entry.size;
    if (total > 20_000_000) throw new Error('Version files exceed the safe size limit.');
    const blob = await api.blob(repo, entry.sha);
    if (blob?.sha !== entry.sha || blob.encoding !== 'base64' || blob.size !== entry.size ||
        typeof blob.content !== 'string') throw new Error('Invalid version blob metadata.');
    const bytes = Buffer.from(blob.content.replace(/\s/g, ''), 'base64');
    const digest = createHash('sha1').update(Buffer.concat([Buffer.from('blob ' + bytes.length + '\0'), bytes])).digest('hex');
    if (bytes.length !== entry.size || digest !== entry.sha || bytes.includes(0)) {
      throw new Error('Version blob integrity failed.');
    }
    files[path] = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }
  return files;
}
function gh(...args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 30_000_000 });
}
function githubApi() {
  return {
    commit: async (repo, sha) => JSON.parse(gh('api', 'repos/' + repo + '/git/commits/' + sha)),
    tree: async (repo, sha) => JSON.parse(gh('api', 'repos/' + repo + '/git/trees/' + sha + '?recursive=1')),
    blob: async (repo, sha) => JSON.parse(gh('api', 'repos/' + repo + '/git/blobs/' + sha)),
  };
}
async function main() {
  const tag = process.env.RELEASE_TAG || '';
  const sha = process.env.RELEASE_TARGET_SHA || '';
  const repo = process.env.GITHUB_REPOSITORY || '';
  verifyVersionFiles(await fetchVersionFiles(githubApi(), repo, sha), tag);
  console.log('Verified release version files at immutable source commit.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(); } catch (error) {
    console.error('::error::Release version verification failed: ' + error.message);
    process.exitCode = 1;
  }
}
