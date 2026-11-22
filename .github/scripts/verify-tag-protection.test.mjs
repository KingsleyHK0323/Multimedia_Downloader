// OpenAI-Codex_format_architecture: prove unknown protection states fail closed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { assertTagProtection } from './verify-tag-protection.mjs';

function fixture() {
  return {
    id: 27823531, source: 'KingsleyHK0323/Multimedia_Downloader', source_type: 'Repository',
    target: 'tag', enforcement: 'active',
    conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } },
    rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }, { type: 'update' }],
    bypass_actors: [], current_user_can_bypass: 'never',
  };
}
test('accepts the verified principal while reporting hidden bypass actors', () => {
  assert.deepEqual(assertTagProtection(fixture()), { bypassActorsVisible: true });
  const hidden = fixture();
  delete hidden.bypass_actors;
  assert.deepEqual(assertTagProtection(hidden), { bypassActorsVisible: false });
});
test('missing, inactive, mismatched, or bypassable rules fail closed', () => {
  for (const change of [
    x => { x.bypass_actors = null; },
    x => { x.bypass_actors = [{ actor_id: 1 }]; }, x => { x.current_user_can_bypass = 'always'; },
    x => { delete x.current_user_can_bypass; }, x => { x.id++; }, x => { x.enforcement = 'disabled'; },
    x => { x.target = 'branch'; }, x => { x.source = 'other/repository'; },
    x => { x.conditions.ref_name.include = ['refs/tags/*']; },
    x => { x.conditions.ref_name.exclude = ['refs/tags/v4*']; },
    x => { x.rules = x.rules.filter(rule => rule.type !== 'deletion'); },
    x => { x.rules = x.rules.filter(rule => rule.type !== 'non_fast_forward'); },
    x => { x.rules = x.rules.filter(rule => rule.type !== 'update'); },
  ]) {
    const rule = fixture();
    change(rule);
    assert.throws(() => assertTagProtection(rule), /Cannot prove/);
  }
  assert.throws(() => assertTagProtection(fixture(), 'other/repository'), /Cannot prove/);
});
