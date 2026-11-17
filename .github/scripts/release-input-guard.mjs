// OpenAI-Codex_Fork_GitHub_REPO: validate exact release tag and source identity.
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';

const TAG_PATTERN = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

export function validateReleaseInputs({ tag, sourceSha, workflowSha, ref }) {
  if (typeof tag !== 'string' || tag.length > 51 || !TAG_PATTERN.test(tag)) {
    throw new Error('Invalid canonical release tag.');
  }
  if (typeof sourceSha !== 'string' || !SHA_PATTERN.test(sourceSha)) {
    throw new Error('Invalid source commit SHA.');
  }
  if (typeof workflowSha !== 'string' || !SHA_PATTERN.test(workflowSha) || sourceSha !== workflowSha) {
    throw new Error('The source SHA must match the dispatched workflow commit.');
  }
  if (ref !== 'refs/tags/' + tag) {
    throw new Error('The workflow must run from the exact release tag.');
  }
  return { tag, sourceSha, version: tag.slice(1) };
}

async function main() {
  try {
    const result = validateReleaseInputs({
      tag: process.env.TAG,
      sourceSha: process.env.SOURCE_SHA,
      workflowSha: process.env.WORKFLOW_SHA,
      ref: process.env.GITHUB_REF,
    });
    writeFileSync(process.env.GITHUB_OUTPUT, 'tag=' + result.tag + '\nversion=' + result.version + '\nsource_sha=' + result.sourceSha + '\n', { flag: 'a' });
    process.stdout.write('Validated exact tag, source SHA, and workflow ref.\n');
  } catch (error) {
    process.stderr.write('::error::' + error.message + '\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
