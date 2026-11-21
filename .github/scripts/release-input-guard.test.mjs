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
      !block.includes("          RAW_TAG: ${{ inputs.tag || github.event.inputs.tag || github.ref_name }}\n") ||
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


// OpenAI-Codex: verification-only runs must not reach release or package writes.
test('verification-only mode isolates release and package publication paths', () => {
  const source = readFileSync(new URL('../workflows/release.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const between = (start, end) => {
    assert.equal(source.split(start).length, 2, 'unique start required');
    const tail = source.split(start)[1];
    assert.ok(tail.includes(end), 'end required');
    return tail.split(end)[0];
  };
  assert.match(between('      - name: Validate verification-only mode\n', '      # OpenAI-Codex: create the requested beta tag'),
    /SOURCE_REF.*github\.ref[\s\S]*"\$ONLY" == all/);
  assert.match(between('      - name: Ensure a GitHub Release exists for this tag\n', '\n  build:'),
    /if: inputs\.verify_only != true/);
  assert.match(between('      - name: Upload installers to the release\n', '\n  # OpenAI-Codex: verify the same build jobs'),
    /if: inputs\.verify_only != true/);
  assert.match(between('  publish-beta:\n', '  # OpenAI-Codex: publish only complete builds'),
    /if: inputs\.verify_only != true/);
  assert.match(between('  publish-stable:\n', '  # OpenAI-Codex: dispatch package publication'),
    /if: inputs\.verify_only != true/);
  const buildAction = between('      - name: Build the Tauri app\n', '      # OpenAI-Codex: retain only installer files');
  assert.doesNotMatch(buildAction, /tagName|releaseName|releaseId|GITHUB_TOKEN/);
  const verification = between('  verify-only:\n', '  # OpenAI-Codex: apply the same asset');
  assert.match(verification, /contents: read/);
  assert.doesNotMatch(verification, /gh release|npm publish|contents: write/);
});

// OpenAI-Codex: test that release inputs remain data, not generated shell code.
test('release tag and platform inputs cannot inject shell commands', () => {
  const source = readFileSync(new URL('../workflows/release.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const tagBlock = source.split('      - id: tag\n')[1]?.split('\n      - id: m\n')[0];
  const matrixBlock = source.split('      - id: m\n')[1]?.split('\n      # OpenAI-Codex: verification')[0];
  assert.ok(tagBlock && matrixBlock);
  assert.ok(tagBlock.includes('          RELEASE_TAG: ${{ inputs.tag || github.event.inputs.tag || github.ref_name }}\n'));
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

// OpenAI-Codex: exercise downstream release shells with local fake commands in CI.
test('derived release tags stay data in version checks and release creation', () => {
  const source = readFileSync(new URL('../workflows/release.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  function scriptBetween(start, end) {
    assert.equal(source.split(start).length, 2);
    const block = source.split(start)[1].split(end)[0];
    const body = block.split('        run: |\n')[1];
    assert.ok(body);
    assert.doesNotMatch(body, /\$\{\{/);
    return body.split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
  }
  const versionCheck = scriptBetween('      - name: Check the tag matches the project version\n',
    '\n      # Runs BEFORE');
  const ensureRelease = scriptBetween('      - name: Ensure a GitHub Release exists for this tag\n',
    '\n  build:');
  const root = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'release-shell-test-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'python'), '#!/bin/sh\nprintf "4.3.22\\n"\n', { mode: 0o755 });
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\nif [ "$1" = release ] && [ "$2" = view ]; then exit 1; fi\nif [ "$1" = release ] && [ "$2" = create ]; then printf "%s\\n" "$@" > "$MOCK_ARGS"; exit 0; fi\nexit 99\n', { mode: 0o755 });
  const argsFile = join(root, 'gh-args');
  function run(script, tag, previous = '') {
    const env = { ...process.env, PATH: bin + ':' + process.env.PATH, RELEASE_TAG: tag,
      PREVIOUS_TAG: previous, GITHUB_REPOSITORY: 'example/repo', RUNNER_TEMP: root,
      MOCK_ARGS: argsFile, GH_TOKEN: 'fixture' };
    delete env.BASH_ENV;
    delete env.ENV;
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script], {
      cwd: root, env, encoding: 'utf8', timeout: 5000,
    });
    if (result.error) throw result.error;
    return result;
  }
  assert.equal(run(versionCheck, 'v4.3.22').status, 0);
  assert.notEqual(run(versionCheck, 'v4.3.23').status, 0);
  const attack = 'v4.3.22$(printf INJECTED)';
  const checked = run(versionCheck, attack);
  assert.notEqual(checked.status, 0);
  assert.ok(checked.stdout.includes(attack));
  assert.equal(run(ensureRelease, 'v4.3.23', 'v4.3.22').status, 0);
  assert.ok(readFileSync(argsFile, 'utf8').split('\n').includes('v4.3.22'));
  const previous = 'v4.3.21$(printf INJECTED)';
  assert.equal(run(ensureRelease, attack, previous).status, 0);
  const args = readFileSync(argsFile, 'utf8').split('\n');
  assert.ok(args.includes(attack));
  assert.ok(args.includes(previous));
});
