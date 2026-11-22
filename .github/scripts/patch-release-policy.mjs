// OpenAI-Codex_format_architecture: deterministic, non-executing patch-release policy.
const SHA = /^[0-9a-f]{40}$/;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const SOURCE_REPO = 'KingsleyHK0323/Multimedia_Downloader';
// OpenAI-Codex_health_release_architecture: share the single approved temporary branch.
const SOURCE_REPO_ID = 1251103365;
const FIXED_BRANCH = 'automation/protected-workflows';
const APP_BOT_ID = 359694872;
export const VERSION_PATHS = Object.freeze([
  'package.json', 'package-lock.json', 'frontend/package.json', 'frontend/package-lock.json',
  'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock',
  'README.md', 'CHANGELOG.md', 'engine/__init__.py',
]);
function fail(message) { throw new Error(message); }
function canonicalNumber(value) {
  return Number.isSafeInteger(value) && value > 0;
}
function replaceExactly(source, pattern, replacer, wanted, name) {
  let n = 0;
  const result = source.replace(pattern, (...args) => {
    n++;
    return replacer(...args);
  });
  if (n !== wanted) fail('Unexpected version fields in ' + name);
  return result;
}
function updateJson(source, oldVersion, version, isLock, name) {
  const data = JSON.parse(source);
  if (!data || Array.isArray(data) || data.version !== oldVersion) fail('Invalid root version in ' + name);
  if (isLock && (!data.packages?.[''] || data.packages[''].version !== oldVersion)) {
    fail('Invalid root lock package version in ' + name);
  }
  const expected = structuredClone(data);
  expected.version = version;
  if (isLock) expected.packages[''].version = version;
  const escaped = oldVersion.replaceAll('.', '\\.');
  const pattern = new RegExp('("version"\\s*:\\s*")' + escaped + '(")', 'g');
  let replaced = 0;
  const output = source.replace(pattern, (match, prefix, suffix) => {
    if (replaced >= (isLock ? 2 : 1)) return match;
    replaced++;
    return prefix + version + suffix;
  });
  if (replaced !== (isLock ? 2 : 1) ||
      JSON.stringify(JSON.parse(output)) !== JSON.stringify(expected)) {
    fail('JSON version fields are ambiguous in ' + name);
  }
  return output;
}
function checkDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('Invalid release date.');
  const date = new Date(value + 'T00:00:00Z');
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    fail('Invalid release date.');
  }
}
function promoteChangelog(source, version, date, number) {
  const lines = source.match(/.*(?:\r?\n|$)/g)?.filter(Boolean) || [];
  const i = lines.findIndex(line => /^### Unreleased\s*$/.test(line));
  if (i < 0) fail('Unreleased changelog section is missing.');
  let end = lines.findIndex((line, n) => n > i && /^### /.test(line));
  if (end < 0) end = lines.length;
  let notes = lines.slice(i + 1, end).join('').trim();
  if (!notes) notes = '#### Maintenance\n- Automated patch release after merged pull request #' + number + '.';
  return lines.slice(0, i + 1).join('') + '\n### [' + version + '] — ' + date +
    '\n\n' + notes + '\n\n' + lines.slice(end).join('');
}
export function planVersion(files, sourcePrNumber, date) {
  if (!canonicalNumber(sourcePrNumber)) fail('Invalid source PR number.');
  checkDate(date);
  if (!files || VERSION_PATHS.some(path => typeof files[path] !== 'string')) fail('Version files are incomplete.');
  if (VERSION_PATHS.some(path => files[path].includes('\r'))) fail('Version files must use LF line endings.');
  const data = JSON.parse(files['package.json']);
  const current = data?.version;
  const match = typeof current === 'string' && current.match(VERSION);
  if (!match || current.length > 49) fail('Invalid current version.');
  const patch = BigInt(match[3]) + 1n;
  const version = match[1] + '.' + match[2] + '.' + patch.toString();
  if (version.length > 50 || version === '4.3.3') fail('This version requires separate release authorization.');
  const updates = {};
  for (const [name, lock] of [
    ['package.json', false], ['package-lock.json', true],
    ['frontend/package.json', false], ['frontend/package-lock.json', true],
    ['src-tauri/tauri.conf.json', false],
  ]) updates[name] = updateJson(files[name], current, version, lock, name);
  const escaped = current.replaceAll('.', '\\.');
  updates['src-tauri/Cargo.toml'] = replaceExactly(
    files['src-tauri/Cargo.toml'], new RegExp('^version\\s*=\\s*"' + escaped + '"$', 'gm'),
    () => 'version = "' + version + '"', 1, 'src-tauri/Cargo.toml'
  );
  updates['src-tauri/Cargo.lock'] = replaceExactly(
    files['src-tauri/Cargo.lock'], new RegExp('(^name = "multimedia-downloader"\\nversion = ")' + escaped + '("$)', 'gm'),
    (_, prefix, suffix) => prefix + version + suffix, 1, 'src-tauri/Cargo.lock'
  );
  updates['README.md'] = replaceExactly(
    files['README.md'], new RegExp('^(# Multimedia Downloader — V)' + escaped + '$', 'gm'),
    (_, prefix) => prefix + version, 1, 'README.md'
  );
  updates['engine/__init__.py'] = replaceExactly(
    files['engine/__init__.py'], new RegExp('^(__version__\\s*=\\s*")' + escaped + '("$)', 'gm'),
    (_, prefix, suffix) => prefix + version + suffix, 1, 'engine/__init__.py'
  );
  updates['CHANGELOG.md'] = promoteChangelog(files['CHANGELOG.md'], version, date, sourcePrNumber);
  if (VERSION_PATHS.some(path => updates[path] === files[path])) fail('An expected version file did not change.');
  return { sourcePrNumber, oldVersion: current, version, tag: 'v' + version, updates };
}
export function validateSourcePr(pr, { requireCurrentLabel = true } = {}) {
  if (!pr || !canonicalNumber(pr.number) || pr.state !== 'closed' || pr.merged !== true ||
      typeof pr.merged_at !== 'string' || Number.isNaN(Date.parse(pr.merged_at)) ||
      pr.base?.ref !== 'Source_Code' || pr.base?.repo?.id !== SOURCE_REPO_ID ||
      pr.base.repo.full_name !== SOURCE_REPO ||
      !canonicalNumber(pr.user?.id) || pr.user.id === APP_BOT_ID ||
      !Array.isArray(pr.labels) || (requireCurrentLabel && !pr.labels.some(label => label?.name === 'release:patch')) ||
      !SHA.test(pr.merge_commit_sha || '')) {
    fail('Source PR is not an eligible merged, labeled Source_Code change.');
  }
  return { number: pr.number, mergeSha: pr.merge_commit_sha };
}
export function versionBranch(number) {
  if (!canonicalNumber(number)) fail('Invalid source PR number.');
  return FIXED_BRANCH;
}
export function validateVersionPr(pr, source, { requireMerged = false, requireCurrentLabel = true } = {}) {
  validateSourcePr(source, { requireCurrentLabel });
  if (!pr || !canonicalNumber(pr.number) || pr.user?.id !== APP_BOT_ID ||
      pr.base?.ref !== 'Source_Code' || pr.base?.repo?.id !== SOURCE_REPO_ID ||
      pr.base.repo.full_name !== SOURCE_REPO || pr.head?.repo?.id !== SOURCE_REPO_ID ||
      pr.head.repo.full_name !== SOURCE_REPO || pr.head?.ref !== versionBranch(source.number) ||
      !SHA.test(pr.head?.sha || '') || !SHA.test(pr.base?.sha || '') ||
      pr.draft !== false || pr.auto_merge !== null || !Array.isArray(pr.labels) ||
      pr.labels.some(label => typeof label?.name !== 'string' || label.name.toLowerCase() === 'release:patch')) {
    fail('Version PR is not the expected App-authored Source_Code request.');
  }
  const marker = '<!-- automatic-patch-source:' + source.number + ':' + source.merge_commit_sha + ' -->';
  if (typeof pr.body !== 'string' || pr.body.split('\n').filter(line => line === marker).length !== 1) {
    fail('Version PR does not identify the exact source PR and merge commit.');
  }
  if (requireMerged && (pr.state !== 'closed' || pr.merged !== true || !SHA.test(pr.merge_commit_sha || ''))) {
    fail('Version PR has not merged.');
  }
  return { source: source.number, base: pr.base.sha, head: pr.head.sha,
    merge: requireMerged ? pr.merge_commit_sha : null };
}
