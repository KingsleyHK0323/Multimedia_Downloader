// OpenAI-Codex_Fork_GitHub_REPO: mock-only release pipeline checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProtection } from './verify_release_protection.mjs';

const fixture = () => ({
  rulesets: [{
    id: 101,
    target: 'tag',
    enforcement: 'active',
    conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } },
    rules: [{ type: 'update' }, { type: 'deletion' }],
    bypass_actors: [],
  }],
  environment: {
    name: 'staged-release-publish',
    protection_rules: [{ type: 'branch_policy' }],
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  },
  policies: [{ name: 'v*', type: 'tag' }],
});

test('accepts tag update/deletion protection and an automatic v* environment', () => {
  assert.deepEqual(validateProtection(fixture()), []);
  const branchPolicy = fixture();
  branchPolicy.environment.protection_rules = [{ type: 'branch_policy' }];
  assert.deepEqual(validateProtection(branchPolicy), []);
});

test('rejects missing protection, a human gate, or non-v* deployment scope', () => {
  const missing = fixture();
  missing.rulesets = [];
  assert.throws(() => validateProtection(missing), /ruleset/);

  const humanGate = fixture();
  humanGate.environment.protection_rules = [{ type: 'required_reviewers', reviewers: [{ type: 'User' }] }];
  assert.throws(() => validateProtection(humanGate), /human approval/);

  const wrongScope = fixture();
  wrongScope.policies = [{ name: '*', type: 'branch' }];
  assert.throws(() => validateProtection(wrongScope), /v\* tag policy/);
});

test('rejects any bypass actor exposed by the API', () => {
  const config = fixture();
  config.rulesets[0].bypass_actors = [{ actor_type: 'RepositoryRole', actor_id: 5 }];
  assert.throws(() => validateProtection(config), /bypass actors/);
});

// OpenAI-Codex: verify missing or malformed bypass details stop publication.
test('fails closed when GitHub hides or malforms bypass actor details', () => {
  for (const value of [undefined, null, {}]) {
    const config = fixture();
    if (value === undefined) delete config.rulesets[0].bypass_actors;
    else config.rulesets[0].bypass_actors = value;
    assert.throws(() => validateProtection(config), /bypass safety cannot be verified/);
  }
});
