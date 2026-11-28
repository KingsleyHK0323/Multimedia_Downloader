// OpenAI-Codex_publish_audit: standalone tests for the proposed additive guard.
// This does not execute a GitHub workflow or contact any external service.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// Extract the exact proposed guard from release.yml, not a duplicate copy.
function readValidationShell() {
  const workflow = readFileSync(new URL('../workflows/release.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const start = '      # BEGIN RELEASE_INPUT_GUARD\n';
  const end = '      # END RELEASE_INPUT_GUARD\n';
  if (workflow.split(start).length !== 2 || workflow.split(end).length !== 2) throw new Error('guard markers missing or ambiguous');
  const begin = workflow.indexOf(start), finish = workflow.indexOf(end);
  const setup = workflow.indexOf('\n  setup:\n'), tagStep = workflow.indexOf('\n      - id: tag\n');
  if (!(setup >= 0 && begin > setup && finish > begin && finish < tagStep) ||
      /^\s*-\s/m.test(workflow.slice(setup, begin))) throw new Error('guard must be the first setup step');
  const block = workflow.slice(begin + start.length, finish);
  if (!block.startsWith('      - name: Validate release inputs\n') || /^\s*(?:if|continue-on-error):/m.test(block) ||
      !block.includes("          RAW_TAG: ${{ needs.metadata.outputs.tag }}\n") ||
      !block.includes("          RAW_ONLY: ${{ inputs.only || github.event.inputs.only || 'all' }}\n") ||
      !block.includes('        shell: bash\n        run: |\n')) throw new Error('guard env or shell differs');
  const script = block.split('        shell: bash\n        run: |\n')[1];
  const lines = script.split('\n');
  if (lines.at(-1) !== '') throw new Error('guard script missing trailing newline');
  lines.pop();
  if (lines.length === 0 || lines.some(line => !line.startsWith('          '))) throw new Error('invalid guard indentation');
  return lines.map(line => line.slice(10)).join('\n') + '\n';
}

function validate(tag, only) {
  const env = { ...process.env, RAW_TAG: tag, RAW_ONLY: only };
  delete env.BASH_ENV;
  delete env.ENV;
  const result = spawnSync(process.env.RELEASE_GUARD_BASH || 'bash', ['--noprofile', '--norc', '-c', readValidationShell()], {
    env, encoding: 'utf8', timeout: 5000,
  });
  if (result.error) throw result.error;
  return result;
}

test('accepts canonical versions and the four supported platforms', () => {
  for (const tag of ['v0.0.0', 'v4.3.21', 'v123.456.789']) {
    for (const only of ['all', 'ubuntu-22.04', 'macos-15', 'windows-latest']) {
      assert.equal(validate(tag, only).status, 0, `${tag} ${only}`);
    }
  }
});

test('rejects invalid or noncanonical tags and line terminators', () => {
  for (const tag of ['', '4.3.21', 'v04.3.21', 'v4.03.21', 'v4.3.021', 'v4.3.21-rc1', 'v4.3.21+1', 'v4.3.21 ', 'v4.3.21\n', 'v4.3.21\r', `v${'9'.repeat(52)}.0.0`]) {
    const result = validate(tag, 'all');
    assert.equal(result.status, 1, JSON.stringify(tag));
    assert.equal(result.stdout.trim(), '::error::Invalid release tag.');
  }
});

test('rejects shell syntax as data and never echoes it', () => {
  for (const attack of ['v1.2.3";echo INJECTED;#', 'v1.2.3$(echo INJECTED)', 'v1.2.3`echo INJECTED`', 'v1.2.3\nINJECTED']) {
    const result = validate(attack, 'all');
    assert.equal(result.status, 1);
    assert.equal(result.stdout.trim(), '::error::Invalid release tag.');
    assert.equal((result.stdout + result.stderr).includes('INJECTED'), false);
  }
  for (const attack of ['all;echo INJECTED', '$(echo INJECTED)', 'all\n', 'ALL', '']) {
    const result = validate('v4.3.21', attack);
    assert.equal(result.status, 1);
    assert.equal(result.stdout.trim(), '::error::Invalid release platform.');
    assert.equal((result.stdout + result.stderr).includes('INJECTED'), false);
  }
});


// OpenAI-Codex: test that release inputs remain data, not generated shell code.
test('release tag and platform inputs cannot inject shell commands', () => {
  const source = readFileSync(new URL('../workflows/release.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const tagBlock = source.split('      - id: tag\n')[1]?.split('\n      - id: m\n')[0];
  const matrixBlock = source.split('      - id: m\n')[1]?.split('\n      # OpenAI-Codex: verification')[0];
  assert.ok(tagBlock && matrixBlock);
  assert.ok(tagBlock.includes('          RELEASE_TAG: ${{ needs.metadata.outputs.tag }}\n'));
  assert.ok(matrixBlock.includes("          RELEASE_ONLY: ${{ inputs.only || github.event.inputs.only || 'all' }}\n"));
  const tagScript = tagBlock.match(/^        run: (.+)$/m)?.[1];
  const matrixBody = matrixBlock.split('        run: |\n')[1];
  assert.ok(tagScript && matrixBody);
  const matrixScript = matrixBody.split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
  assert.doesNotMatch(tagScript + matrixScript, /\$\{\{/);

  function run(script, envInput) {
    const directory = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'release-input-guard-'));
    const output = join(directory, 'github-output');
    const env = { ...process.env, ...envInput, GITHUB_OUTPUT: output };
    delete env.BASH_ENV;
    delete env.ENV;
    const result = spawnSync(process.env.RELEASE_GUARD_BASH || 'bash', ['--noprofile', '--norc', '-c', script], {
      env, encoding: 'utf8', timeout: 5000,
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    return readFileSync(output, 'utf8');
  }

  assert.equal(run(tagScript, { RELEASE_TAG: 'v4.3.22' }), 'tag=v4.3.22\n');
  const tagAttack = 'v1.2.3$(printf INJECTED)';
  assert.equal(run(tagScript, { RELEASE_TAG: tagAttack }), 'tag=' + tagAttack + '\n');
  assert.equal(run(matrixScript, { RELEASE_ONLY: 'all' }),
    'matrix={"platform":["ubuntu-22.04","macos-15","windows-latest"]}\n');
  assert.equal(run(matrixScript, { RELEASE_ONLY: 'macos-15' }),
    'matrix={"platform":["macos-15"]}\n');
  const platformAttack = 'all$(printf INJECTED)';
  assert.equal(run(matrixScript, { RELEASE_ONLY: platformAttack }),
    'matrix={"platform":["' + platformAttack + '"]}\n');
});


// OpenAI-Codex_format_architecture: verify trusted and untrusted jobs have separate permissions.
test('builds and verification cannot obtain release write credentials', () => {
  const source = readFileSync(new URL('../workflows/release.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const between = (a, b) => {
    assert.equal(source.split(a).length, 2);
    const tail = source.split(a)[1];
    assert.ok(tail.includes(b));
    return tail.split(b)[0];
  };
  const setup = between('  setup:\n', '\n  build-linux:');
  assert.match(setup, /contents: read/);
  assert.doesNotMatch(setup, /contents: write|gh release create|repos\.createRelease/);
  for (const [start, end] of [
    ['  build-linux:\n', '\n  build-macos:'],
    ['  build-macos:\n', '\n  build-windows:'],
    ['  build-windows:\n', '\n  # OpenAI-Codex: verify the same build jobs'],
  ]) {
    const block = between(start, end);
    assert.match(block, /contents: read/);
    assert.doesNotMatch(block, /contents: write|GH_TOKEN|secrets\.|gh release upload/);
    assert.match(block, /source_sha: \$\{\{ needs\.metadata\.outputs\.source_sha \}\}/);
    assert.match(block, /uses: \.\/\.github\/workflows\/release-build\.yml/);
  }
  const reusable = readFileSync(new URL('../workflows/release-build.yml', import.meta.url), 'utf8');
  assert.match(reusable, /ref: \$\{\{ needs\.validate\.outputs\.source_sha \}\}/);
  assert.match(reusable, /contents: read/);
  assert.doesNotMatch(reusable, /contents: write|GH_TOKEN|secrets\./);
  const publisher = between('  publisher:\n', '\n  # OpenAI-Codex: apply the same asset');
  assert.match(publisher, /contents: write/);
  assert.match(publisher, /!cancelled\(\)/);
  assert.doesNotMatch(publisher, /always\(\)/);
  assert.match(publisher, /actions: read/);
  assert.match(publisher, /job\.workflow_sha/);
  assert.match(publisher, /github\.event_name != 'pull_request'/);
  assert.match(publisher, /stage-release-artifacts\.py/);
  assert.match(publisher, /verify-version-at-commit\.mjs/);
  assert.match(publisher, /upload-release-assets\.mjs/);
  assert.doesNotMatch(publisher, /ref: \$\{\{ needs\.metadata\.outputs\.source_sha \}\}/);
  assert.match(between('  publish-beta:\n', '\n  # OpenAI-Codex: publish only complete builds'), /publisher/);
  assert.match(between('  publish-stable:\n', '\n  # OpenAI-Codex: dispatch package publication'), /publisher/);
});
test('v4.3.3 publication stops before the metadata job makes an API request', () => {
  const workflow = readFileSync(new URL('../workflows/release.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const block = workflow.split('      - name: Validate tag and resolve its trusted source\n')[1]
    ?.split('\n  setup:')[0];
  const body = block?.split('        run: |\n')[1];
  assert.ok(body);
  const shell = body.split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
  const directory = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'release-metadata-'));
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\necho unexpected-api >&2\nexit 91\n', { mode: 0o755 });
  const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', shell], {
    cwd: directory, encoding: 'utf8', timeout: 5000,
    env: { ...process.env, PATH: bin + ':' + process.env.PATH, GITHUB_REPOSITORY: 'KingsleyHK0323/Multimedia_Downloader',
      TAG: 'v4.3.3', VERIFY_ONLY: 'false', ONLY: 'all', WORKFLOW_SHA: 'a'.repeat(40),
      WORKFLOW_REPOSITORY: 'KingsleyHK0323/Multimedia_Downloader', WORKFLOW_PATH: '.github/workflows/release.yml',
      GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/Source_Code' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /requires separate authorization/);
  assert.doesNotMatch(result.stderr, /unexpected-api/);
});

test('single-platform recovery never publishes a release or npm package', () => {
  const source = readFileSync(new URL('../workflows/release.yml', import.meta.url), 'utf8');
  const beta = source.split('  publish-beta:\n')[1]?.split('  # OpenAI-Codex: publish only complete builds')[0];
  const stable = source.split('  publish-stable:\n')[1]?.split('  # OpenAI-Codex: dispatch package publication')[0];
  assert.ok(beta && stable);
  assert.match(beta, /inputs\.only \|\| github\.event\.inputs\.only \|\| 'all'\) == 'all'/);
  assert.match(stable, /inputs\.only \|\| github\.event\.inputs\.only \|\| 'all'\) == 'all'/);
  assert.match(source, /Partial recovery requires an existing draft release/);
});

test('metadata resolves immutable tag targets and rejects non-ancestral commits', () => {
  const workflow = readFileSync(new URL('../workflows/release.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const body = workflow.split('      - name: Validate tag and resolve its trusted source\n')[1]
    .split('\n  setup:')[0].split('        run: |\n')[1];
  const shell = body.split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
  const directory = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'release-metadata-api-'));
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  const fake = '#!/bin/sh\n' +
    'case "$2" in\n' +
    '  */git/ref/tags/*) printf "{\\"object\\":{\\"type\\":\\"commit\\",\\"sha\\":\\"%s\\"}}\\n" "$MOCK_TARGET" ;;\n' +
    '  */compare/*) candidate=${2##*/compare/}; candidate=${candidate%%...*}; ' +
    'if [ "$MOCK_BAD_REL" = 1 ]; then candidate=ffffffffffffffffffffffffffffffffffffffff; fi; ' +
    'printf "{\\"merge_base_commit\\":{\\"sha\\":\\"%s\\"},\\"behind_by\\":0,\\"status\\":\\"ahead\\"}\\n" "$candidate" ;;\n' +
    '  *) exit 91 ;;\n' +
    'esac\n';
  writeFileSync(join(bin, 'gh'), fake, { mode: 0o755 });
  function run(tag, verifyOnly, bad) {
    const output = join(directory, 'output-' + Math.random());
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', shell], {
      cwd: directory, encoding: 'utf8', timeout: 5000,
      env: { ...process.env, PATH: bin + ':' + process.env.PATH,
        GITHUB_REPOSITORY: 'KingsleyHK0323/Multimedia_Downloader', GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_REF: 'refs/heads/Source_Code', TAG: tag, VERIFY_ONLY: verifyOnly, ONLY: 'all',
        WORKFLOW_SHA: 'a'.repeat(40), WORKFLOW_REPOSITORY: 'KingsleyHK0323/Multimedia_Downloader',
        WORKFLOW_PATH: '.github/workflows/release.yml', MOCK_TARGET: 'b'.repeat(40),
        MOCK_BAD_REL: bad ? '1' : '0', GITHUB_OUTPUT: output },
    });
    return result;
  }
  assert.equal(run('v4.3.23', 'false', false).status, 0);
  assert.notEqual(run('v4.3.23', 'false', true).status, 0);
  assert.equal(run('v4.3.3', 'true', false).status, 0);
  assert.notEqual(run('v4.3.3', 'false', false).status, 0);
});

test('owner-only temporary PR runs build-only against its exact synthetic merge', () => {
  const source = readFileSync(new URL('../workflows/release.yml', import.meta.url), 'utf8');
  const prTrigger = source.split('  pull_request:\n')[1]?.split('\n  push:')[0];
  assert.ok(prTrigger);
  assert.match(prTrigger, /paths:/);
  assert.match(prTrigger, /\.github\/workflows\/release\.yml/);
  assert.match(prTrigger, /\.github\/workflows\/release-build\.yml/);
  const meta = source.split('  metadata:\n')[1]?.split('\n  setup:')[0];
  assert.ok(meta);
  assert.match(meta, /github\.event\.pull_request\.user\.id == 157894869/);
  assert.match(meta, /github\.event\.sender\.id == 157894869/);
  assert.match(meta, /head\.ref == 'automation\/protected-workflows'/);
  assert.match(meta, /head\.repo\.full_name == github\.repository/);
  assert.match(meta, /base\.repo\.full_name == github\.repository/);
  assert.match(meta, /sha="\$GITHUB_SHA"/);
  assert.match(meta, /VERIFY_ONLY=true/);
  for (const job of ['publisher', 'publish-beta', 'publish-stable', 'request-npm-package']) {
    const body = source.split('  ' + job + ':\n')[1];
    assert.ok(body);
    assert.match(body.split(/\n  [a-z][a-z-]*:\n/)[0], /github\.event_name != 'pull_request'/);
  }
});

test('workflow concurrency uses an available context and npm job has one condition', () => {
  const source = readFileSync(new URL('../workflows/release.yml', import.meta.url), 'utf8');
  const group = source.split('\nconcurrency:\n')[1]?.split('\njobs:\n')[0];
  assert.ok(group);
  assert.doesNotMatch(group, /needs\./);
  assert.match(group, /inputs\.tag \|\| github\.event\.inputs\.tag \|\| github\.ref_name/);
  const npm = source.split('  request-npm-package:\n')[1];
  assert.ok(npm);
  assert.equal((npm.match(/^    if:/gm) || []).length, 1);
  assert.match(npm, /github\.event_name != 'pull_request'.*needs\.publish-stable\.result == 'success'/);
});

test('cloud release workflow lint is pinned and runs with read-only permissions', () => {
  const source = readFileSync(new URL('../workflows/ci.yml', import.meta.url), 'utf8');
  const job = source.split('  release-input-guard:\n')[1]?.split('\n  lint:')[0];
  assert.ok(job);
  assert.match(job, /permissions:\n      contents: read/);
  assert.match(job, /persist-credentials: false/);
  assert.match(job, /actionlint_1\.7\.12_linux_amd64\.tar\.gz/);
  assert.match(job, /8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8/);
  assert.match(job, /\.github\/workflows\/release\.yml \.github\/workflows\/release-build\.yml/);
});

test('PR metadata requires exact branch casing before trusted API data is consumed', () => {
  const workflow = readFileSync(new URL('../workflows/release.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const body = workflow.split('      - name: Validate tag and resolve its trusted source\n')[1]
    .split('\n  setup:')[0].split('        run: |\n')[1];
  const shell = body.split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
  const directory = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'release-pr-case-'));
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  const fake = '#!/bin/sh\n' +
    'case "$2" in\n' +
    '  */git/commits/*) printf "{\\"parents\\":[{\\"sha\\":\\"%s\\"},{\\"sha\\":\\"%s\\"}]}\\n" "$PR_BASE" "$PR_HEAD" ;;\n' +
    '  */contents/package.json*) printf eyJ2ZXJzaW9uIjoiNC4zLjIyIn0= ;;\n' +
    '  *) exit 91 ;;\n' +
    'esac\n';
  writeFileSync(join(bin, 'gh'), fake, { mode: 0o755 });
  function run(headRef, baseRef) {
    const output = join(directory, 'output-' + Math.random());
    return spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', shell], {
      cwd: directory, encoding: 'utf8', timeout: 5000,
      env: { ...process.env, PATH: bin + ':' + process.env.PATH,
        GITHUB_REPOSITORY: 'KingsleyHK0323/Multimedia_Downloader', GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_REF: 'refs/pull/81/merge', GITHUB_SHA: 'c'.repeat(40),
        GITHUB_HEAD_REF: headRef, GITHUB_BASE_REF: baseRef, TAG: '81/merge', VERIFY_ONLY: '', ONLY: 'all',
        WORKFLOW_SHA: 'a'.repeat(40), WORKFLOW_REPOSITORY: 'KingsleyHK0323/Multimedia_Downloader',
        WORKFLOW_PATH: '.github/workflows/release.yml', PR_HEAD: 'a'.repeat(40), PR_BASE: 'b'.repeat(40),
        GITHUB_OUTPUT: output },
    });
  }
  assert.equal(run('automation/protected-workflows', 'Source_Code').status, 0);
  assert.notEqual(run('automation/Protected-workflows', 'Source_Code').status, 0);
  assert.notEqual(run('automation/protected-workflows', 'source_code').status, 0);
});


test('version-tag protections are checked with each job token before release writes', () => {
  const source = readFileSync(new URL('../workflows/release.yml', import.meta.url), 'utf8');
  const block = name => {
    const section = source.split('  ' + name + ':\n')[1];
    assert.ok(section, name);
    return section.split(/\n  (?:#|[a-z][a-z-]*:)/)[0];
  };
  const verify = block('verify-only');
  assert.match(verify, /contents: read/);
  assert.match(verify, /node automation\/\.github\/scripts\/verify-tag-protection\.mjs/);
  const publisher = block('publisher');
  const checks = [...publisher.matchAll(/node automation\/\.github\/scripts\/verify-tag-protection\.mjs/g)]
    .map(match => match.index);
  assert.equal(checks.length, 2);
  assert.ok(checks[0] < publisher.indexOf('- name: Create or verify the draft release'));
  assert.ok(checks[1] < publisher.indexOf('- name: Upload or verify exact release assets'));
  for (const name of ['publish-beta', 'publish-stable']) {
    const body = block(name);
    assert.match(body, /node automation\/\.github\/scripts\/verify-tag-protection\.mjs/);
    assert.ok(body.indexOf('verify-tag-protection.mjs') < body.indexOf('gh release edit '));
  }
});


// OpenAI-Codex: exercise the actual draft-release script with isolated GitHub mocks.
test('approved Public Beta tags create and validate prerelease drafts', async () => {
  const source = readFileSync(new URL('../workflows/release.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const section = source.split('      - name: Create or verify the draft release\n')[1]
    ?.split('\n      # OpenAI-Codex_format_architecture: verify tag rules')[0];
  assert.ok(section);
  const block = section.split('          script: |\n')[1];
  assert.ok(block);
  const script = block.split('\n').map((line) => {
    if (!line.trim()) return '';
    assert.ok(line.startsWith('            '));
    return line.slice(12);
  }).join('\n');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const execute = new AsyncFunction('github', 'context', 'process', 'require', script);
  const target = 'a'.repeat(40);

  async function run(tag, existing) {
    let created;
    const repos = {
      listReleases: async () => { throw new Error('pagination wrapper required'); },
      generateReleaseNotes: async () => ({ data: { body: 'Generated notes' } }),
      createRelease: async (options) => { created = options; return { data: options }; },
    };
    const github = { paginate: async (method) => {
      assert.equal(method, repos.listReleases);
      return existing ? (Array.isArray(existing) ? existing : [existing]) : [];
    }, rest: { git: { getRef: async () => ({ data: { object: { type: 'commit', sha: target } } }) }, repos } };
    const context = { repo: { owner: 'KingsleyHK0323', repo: 'Multimedia_Downloader' } };
    const process = { env: { RELEASE_TAG: tag, TARGET_SHA: target, RELEASE_ONLY: 'all', RUNNER_TEMP: '/tmp', PREVIOUS_TAG: '' } };
    const require = (name) => {
      if (name === 'node:fs') return { readFileSync: () => 'Release notes' };
      if (name === 'node:path') return { join: (...parts) => parts.join('/') };
      throw new Error('Unexpected module');
    };
    await execute(github, context, process, require);
    return created;
  }

  for (const tag of ['v4.3.22', 'v4.3.23', 'v4.3.24']) {
    const created = await run(tag);
    assert.equal(created.draft, true);
    assert.equal(created.prerelease, true);
    assert.equal(created.name, tag + ' Public Beta');
    if (tag === 'v4.3.23') assert.match(created.body, /Windows progress and BiliBili download scenarios have not been verified/);
    assert.equal(await run(tag, { tag_name: tag, draft: true, prerelease: true }), undefined);
    await assert.rejects(run(tag, { tag_name: tag, draft: true, prerelease: false }), /expected draft/);
    await assert.rejects(run(tag, [{ tag_name: tag }, { tag_name: tag }]), /Ambiguous releases/);
  }
  const stable = await run('v4.3.25');
  assert.equal(stable.prerelease, false);
  assert.equal(stable.name, 'v4.3.25');
  await assert.rejects(run('v4.3.3'), /Invalid release target/);
});

test('approved Public Beta tags route only through verified beta publication', () => {
  const source = readFileSync(new URL('../workflows/release.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const beta = source.split('  publish-beta:\n')[1]?.split('  # OpenAI-Codex: publish only complete builds')[0];
  const stable = source.split('  publish-stable:\n')[1]?.split('  # OpenAI-Codex: dispatch package publication')[0];
  assert.ok(beta && stable);
  for (const tag of ['v4.3.22', 'v4.3.23', 'v4.3.24']) {
    assert.ok(beta.includes("needs.metadata.outputs.tag == '" + tag + "'"));
    assert.ok(stable.includes("needs.metadata.outputs.tag != '" + tag + "'"));
  }
  assert.ok(stable.includes("needs.metadata.outputs.tag != 'v4.3.3'"));
  assert.match(beta, /RELEASE_TAG: \$\{\{ needs\.metadata\.outputs\.tag \}\}/);
  assert.match(beta, /verify-tag-protection\.mjs/);
  assert.match(beta, /gh release edit "\$TAG" --repo "\$GITHUB_REPOSITORY" --draft=false --prerelease --latest=false/);
  assert.match(beta, /upload-release-assets\.mjs "\$TAG" --verify-inventory/);
  assert.match(beta, /verify-release-assets\.mjs "\$TAG"/);
});
