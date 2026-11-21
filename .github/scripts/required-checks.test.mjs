// OpenAI-Codex: exercise the actual required-check scripts without GitHub writes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

function extract(path, job) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const marker = '  ' + job + ':\n';
  assert.equal(source.split(marker).length, 2);
  const section = source.split(marker)[1];
  const start = "          node -e '\n";
  const end = "\n          '\n";
  assert.equal(section.split(start).length, 2);
  const script = section.split(start)[1].split(end)[0];
  assert.ok(script);
  return script.split('\n').map(line => line.startsWith('            ') ? line.slice(12) : line).join('\n');
}

const cases = [
  ['CI', extract('../workflows/ci.yml', 'ci-required'), 7],
  ['Python matrix', extract('../workflows/python-matrix.yml', 'matrix-required'), 1],
];
for (const [name, script, count] of cases) {
  test(name + ' requires every prerequisite to succeed', () => {
    const results = Object.fromEntries(Array.from({ length: count }, (_, index) => ['job' + index, { result: 'success' }]));
    function check(value) {
      const run = spawnSync(process.execPath, ['-e', script], {
        env: { ...process.env, REQUIRED_RESULTS: typeof value === 'string' ? value : JSON.stringify(value) },
        encoding: 'utf8', timeout: 5000,
      });
      if (run.error) throw run.error;
      return run.status;
    }
    assert.equal(check(results), 0);
    for (const result of ['failure', 'cancelled', 'skipped']) {
      assert.notEqual(check({ ...results, job0: { result } }), 0, result);
    }
    assert.notEqual(check(Object.fromEntries(Object.entries(results).slice(1))), 0);
    assert.notEqual(check({ ...results, extra: { result: 'success' } }), 0);
    assert.notEqual(check('{invalid json'), 0);
  });
}
