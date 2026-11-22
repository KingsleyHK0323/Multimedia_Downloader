// OpenAI-Codex_format_architecture: verify the bounded data-only artifact extractor.
// OpenAI-Codex_health_release_architecture: exercise actual artifact selection and bounded extraction.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const workflow = readFileSync(resolve('.github/workflows/formatter-app-cas.yml'), 'utf8').replaceAll('\r\n', '\n');
const pick = (start, end, indent) => {
  const before = workflow.split(start);
  assert.equal(before.length, 2);
  const after = before[1].split(end);
  assert.equal(after.length, 2);
  return after[0].replace(/^\n/, '').split('\n').map((line) => line.slice(indent)).join('\n');
};
const extractor = pick("          # BEGIN FORMAT_SAFE_UNZIP_PYTHON\n          python -I - <<'PY'\n", "\n          PY\n          # END FORMAT_SAFE_UNZIP_PYTHON", 10);
const zipMaker = String.raw`
import os, sys, zipfile
root, mode = sys.argv[1:]
for replica in ("one", "two"):
    with zipfile.ZipFile(os.path.join(root, "format-" + replica + ".zip"), "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.json", "{}\n")
        if mode == "path":
            z.writestr("../escape", "bad")
        elif mode == "duplicate":
            z.writestr("manifest.json", "bad")
        elif mode == "symlink":
            info = zipfile.ZipInfo("blobs/" + "a" * 64)
            info.create_system = 3
            info.external_attr = (0o120777 << 16)
            z.writestr(info, "outside")
        elif mode == "large":
            z.writestr("blobs/" + "a" * 64, b"x" * (25 * 1024 * 1024 + 1))
        else:
            z.writestr("blobs/" + "a" * 64, b"data")
`;
function extract(mode, corruptDigest = false) {
  const root = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'format-artifact-'));
  execFileSync('python', ['-I', '-c', zipMaker, root, mode]);
  const digest = (name) => createHash('sha256').update(readFileSync(join(root, 'format-' + name + '.zip'))).digest('hex');
  return { root, result: spawnSync('python', ['-I', '-c', extractor], {
    encoding: 'utf8', env: { ...process.env, RUNNER_TEMP: root,
      FORMAT_ONE_DIGEST: corruptDigest ? '0'.repeat(64) : digest('one'), FORMAT_TWO_DIGEST: digest('two') },
  }) };
}

test('extracts only a valid, digest-matched archive', () => {
  const { root, result } = extract('good');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(root, 'format-artifacts', 'one', 'blobs', 'a'.repeat(64)), 'utf8'), 'data');
  assert.notEqual(extract('good', true).result.status, 0);
});

test('rejects traversal, duplicate, symlink and oversized archive entries', () => {
  for (const mode of ['path', 'duplicate', 'symlink', 'large']) {
    assert.notEqual(extract(mode).result.status, 0, mode);
  }
});

