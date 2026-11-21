// OpenAI-Codex: include every commit subject alongside GitHub's generated PR notes.
import { spawnSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const tag = process.env.RELEASE_TAG || '';
const repository = process.env.GITHUB_REPOSITORY || '';
const temp = process.env.RUNNER_TEMP || '';
const output = process.env.GITHUB_OUTPUT || '';
if (!/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(tag) ||
    tag.length > 51 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !temp || !output) {
  throw new Error('Invalid release changelog configuration.');
}

function git(args, allowFailure = false) {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) throw new Error('Unable to read complete release history: ' + result.stderr.trim());
  return result;
}
if (git(['rev-parse', '--is-shallow-repository']).stdout.trim() !== 'false') {
  throw new Error('Full Git history is required for release notes.');
}
const head = git(['rev-parse', '--verify', 'refs/tags/' + tag + '^{commit}']).stdout.trim();
if (!/^[0-9a-f]{40,64}$/.test(head)) throw new Error('Invalid tagged commit.');
const ancestry = git(['rev-list', '--parents', '-n', '1', head]).stdout.trim().split(/\s+/);
if (ancestry[0] !== head) throw new Error('Tagged commit changed while generating notes.');
let previous = '';
if (ancestry.length > 1) {
  const result = git(['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', ancestry[1]], true);
  if (result.status === 0) {
    previous = result.stdout.trim();
    if (!/^v[0-9A-Za-z._-]+$/.test(previous)) throw new Error('Invalid previous release tag.');
  } else {
    const candidates = git(['tag', '--merged', ancestry[1], '--list', 'v[0-9]*']).stdout.trim();
    if (candidates) throw new Error('Could not select the previous release tag.');
  }
}
const range = previous ? 'refs/tags/' + previous + '..' + head : head;
const history = git(['log', '--no-show-signature', '--format=%H%x00%s%x00', range, '--']).stdout;
const parts = history.split('\0');
const rows = [];
while (parts.length >= 2) {
  const sha = parts.shift().trim();
  const subject = parts.shift();
  if (!/^[0-9a-f]{40,64}$/.test(sha) || subject === undefined) throw new Error('Malformed Git history.');
  const safe = subject.replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/@/g, '&#64;').replace(/([\\`*_{}\[\]])/g, '\\$1');
  rows.push('- [' + sha.slice(0, 12) + '](https://github.com/' + repository + '/commit/' + sha + ') ' + safe);
}
if (parts.join('').trim() !== '' || !rows.length) throw new Error('Empty or malformed release history.');
const heading = previous ? '## Commits since ' + previous : '## Commits';
writeFileSync(join(temp, 'release-commit-notes.md'), heading + '\n\n' + rows.join('\n') + '\n');
appendFileSync(output, 'previous_tag=' + previous + '\n');
