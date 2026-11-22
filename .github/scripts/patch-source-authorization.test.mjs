// OpenAI-Codex_health_release_architecture: verify owner and historical label authorization boundaries.
import assert from 'node:assert/strict';
import test from 'node:test';
import { currentPatchLabel, labelAtMerge, utcSecond } from './patch-source-authorization.mjs';

const sha = 'a'.repeat(40);
const owner = { id: 157894869, node_id: 'U_kgDOCWlI1Q', type: 'User' };
const bot = { id: 41898282, node_id: 'MDM6Qm90NDE4OTgyODI=', type: 'Bot' };
const patch = { id: 'LA_kwDOSpJShc8AAAADEWCHJg', name: 'release:patch',
  createdAt: '2026-11-22T06:44:42Z', updatedAt: '2026-11-22T06:44:42Z',
  repository: { databaseId: 1251103365 } };
const merged = { event: 'merged', node_id: 'merged-event', created_at: '2026-11-22T07:00:00Z', commit_id: sha };
const change = (event, node_id, created_at, actor = owner) => ({
  event, node_id, created_at, actor, label: { name: 'release:patch' },
});
const graphqlNode = (event, label = patch) => ({
  __typename: event.event === 'labeled' ? 'LabeledEvent' : 'UnlabeledEvent',
  id: event.node_id, createdAt: event.created_at,
  actor: { __typename: event.actor.type, id: event.actor.node_id,
    ...(event.actor.type === 'User' ? { databaseId: event.actor.id } : {}) },
  label: structuredClone(label),
  labelable: { __typename: 'PullRequest', number: 42, repository: { databaseId: 1251103365 } },
});
function fixture(events, { labels = {}, nodes = {}, confirm = events } = {}) {
  const indexed = new Map(events.filter(event => ['labeled', 'unlabeled'].includes(event.event))
    .map(event => [event.node_id, event.actor ? graphqlNode(event, labels[event.node_id] ?? patch) : null]));
  for (const [id, value] of Object.entries(nodes)) indexed.set(id, value);
  return {
    rest: { issues: { listEventsForTimeline: 'issues.timeline' } },
    paginate: async (method, args) => {
      assert.equal(method, 'issues.timeline');
      assert.equal(args.issue_number, 42);
      return structuredClone(confirm);
    },
    graphql: async (_query, { ids }) => ({ nodes: ids.map(id => structuredClone(indexed.get(id))) }),
  };
}
const valid = () => change('labeled', 'label-1', '2026-11-22T06:59:00Z');
async function authorize(events, options) {
  return labelAtMerge(events, merged.created_at, sha, fixture(events, options), 42);
}
test('accepts the owner label only while its identity and name predate the event', async () => {
  assert.deepEqual(await authorize([valid(), merged]), { atMerge: true, withdrawnAfterMerge: false });
  assert.deepEqual(await authorize([change('labeled', 'after', '2026-11-22T07:00:01Z'), merged]), { atMerge: false, withdrawnAfterMerge: false });
  assert.deepEqual(await authorize([valid(), change('unlabeled', 'remove', '2026-11-22T06:59:30Z'), merged]), { atMerge: false, withdrawnAfterMerge: false });
});

test('detects post-merge withdrawal independently of authorization at merge', async () => {
  const events = [valid(), merged, change('unlabeled', 'remove-after', '2026-11-22T07:01:00Z', bot)];
  assert.deepEqual(await authorize(events), { atMerge: true, withdrawnAfterMerge: true });
  const restoredByBot = [...events, change('labeled', 'bot-readd', '2026-11-22T07:02:00Z', bot)];
  assert.deepEqual(await authorize(restoredByBot), { atMerge: true, withdrawnAfterMerge: true });
  assert.equal(currentPatchLabel({ labels: [{ name: 'release:patch', node_id: patch.id }] }), true);
  assert.equal(currentPatchLabel({ labels: [] }), false);
  assert.throws(() => currentPatchLabel({ labels: [{ name: 'release:patch', node_id: 'other' }] }));
});

test('rejects App, other user, missing and cross-API mismatched actors', async () => {
  const other = { id: 42, node_id: 'other-user', type: 'User' };
  for (const actor of [bot, other]) {
    const events = [change('labeled', 'label-1', '2026-11-22T06:59:00Z', actor), merged];
    await assert.rejects(authorize(events), /owner/);
  }
  const missing = { ...valid(), actor: null };
  await assert.rejects(authorize([missing, merged]), /incomplete/);
  const event = valid(), node = graphqlNode(event);
  node.actor.databaseId = 42;
  await assert.rejects(authorize([event, merged], { nodes: { 'label-1': node } }), /disagree/);
});
test('rejects renamed, replaced, deleted, missing-time, wrong-repository and same-second labels', async () => {
  const event = valid(), events = [event, merged];
  for (const label of [
    { ...patch, name: 'renamed' },
    { ...patch, updatedAt: '2026-11-22T06:59:00Z' },
    { ...patch, updatedAt: '2026-11-22T07:01:00Z' },
    { ...patch, createdAt: null },
    { ...patch, updatedAt: null },
    { ...patch, createdAt: '2026-11-22T06:44:41Z' },
    { ...patch, id: 'recreated-label' },
    { ...patch, repository: { databaseId: 1 } },
  ]) await assert.rejects(authorize(events, { labels: { 'label-1': label } }));
  await assert.rejects(authorize(events, { nodes: { 'label-1': null } }), /disagree/);
});
test('rejects event or source identity mismatch, timeline changes and ambiguous ordering', async () => {
  const event = valid(), events = [event, merged], node = graphqlNode(event);
  const wrongSource = { ...node, labelable: { ...node.labelable, number: 43 } };
  await assert.rejects(authorize(events, { nodes: { 'label-1': wrongSource } }), /disagree/);
  await assert.rejects(authorize(events, { confirm: [merged] }), /timeline changed/);
  await assert.rejects(authorize([change('labeled', 'same', merged.created_at), merged]), /same second/);
  await assert.rejects(authorize([event, change('unlabeled', 'remove', event.created_at), merged]), /ambiguous/);
  await assert.rejects(authorize([event, event, merged]), /incomplete/);
  await assert.rejects(authorize([event]), /merge timeline/);
});
test('timestamps must be exact, valid UTC seconds', () => {
  assert.equal(utcSecond('2026-11-22T07:00:00Z'), Date.parse('2026-11-22T07:00:00Z'));
  for (const value of ['2026-11-22', '2026-11-22T07:00:00+08:00', '2026-02-30T01:00:00Z']) {
    assert.throws(() => utcSecond(value));
  }
});
