// OpenAI-Codex_format_architecture: reconstruct source-label authorization from the complete PR timeline.
// OpenAI-Codex_health_release_architecture: bind owner and immutable label identity across REST and GraphQL.
const SECOND = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;
const SHA = /^[0-9a-f]{40}$/;
const OWNER_ID = 157894869;
const OWNER_NODE = 'U_kgDOCWlI1Q';
const REPO_ID = 1251103365;
const PATCH_LABEL_ID = 'LA_kwDOSpJShc8AAAADEWCHJg';
const PATCH_LABEL_CREATED = '2026-11-22T06:44:42Z';
export const ANCHOR_PATH = '.github/automation/patch-release-pr-v1.txt';
export const ANCHOR_CONTENT = 'OpenAI-Codex_format_architecture: auto-patch PR mode migration v1\n';
export function utcSecond(value) {
  if (typeof value !== 'string' || !SECOND.test(value)) throw new Error('Invalid exact UTC timestamp.');
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value.slice(0, -1) + '.000Z') {
    throw new Error('Invalid exact UTC timestamp.');
  }
  return time;
}
const LABEL_NODES_QUERY = `
  query PatchLabelEventNodes($ids: [ID!]!) {
    nodes(ids: $ids) {
      __typename
      ... on LabeledEvent {
        id createdAt
        actor { __typename ... on User { id databaseId } ... on Bot { id } }
        label { id name createdAt updatedAt repository { databaseId } }
        labelable { __typename ... on PullRequest { number repository { databaseId } } }
      }
      ... on UnlabeledEvent {
        id createdAt
        actor { __typename ... on User { id databaseId } ... on Bot { id } }
        label { id name createdAt updatedAt repository { databaseId } }
        labelable { __typename ... on PullRequest { number repository { databaseId } } }
      }
    }
  }
`;
export function currentPatchLabel(pr) {
  if (!Array.isArray(pr?.labels) || pr.labels.some(label => !label || typeof label.name !== 'string')) {
    throw new Error('Current source PR labels are incomplete.');
  }
  const relevant = pr.labels.filter(label =>
    label.name.toLowerCase() === 'release:patch' || label.node_id === PATCH_LABEL_ID);
  if (!relevant.length) return false;
  if (relevant.length !== 1 || relevant[0].name !== 'release:patch' || relevant[0].node_id !== PATCH_LABEL_ID) {
    throw new Error('Current patch label identity is ambiguous.');
  }
  return true;
}
export async function labelAtMerge(events, mergedAt, mergeSha, github, sourceNumber) {
  const mergedTime = utcSecond(mergedAt);
  if (!Array.isArray(events) || events.length > 10_000 || !SHA.test(mergeSha || '') ||
      !github || typeof github.graphql !== 'function' || typeof github.paginate !== 'function' ||
      !github.rest?.issues?.listEventsForTimeline ||
      !Number.isSafeInteger(sourceNumber) || sourceNumber <= 0) {
    throw new Error('Source PR timeline is incomplete.');
  }
  const merged = events.filter(event => event?.event === 'merged');
  if (merged.length !== 1 || merged[0].created_at !== mergedAt || merged[0].commit_id !== mergeSha) {
    throw new Error('Source PR merge timeline is incomplete or inconsistent.');
  }
  const changes = [];
  const seen = new Set();
  for (const event of events) {
    if (!event || typeof event.event !== 'string') throw new Error('Source PR timeline has an incomplete event.');
    if (!['labeled', 'unlabeled'].includes(event.event)) continue;
    if (typeof event.node_id !== 'string' || !event.node_id || seen.has(event.node_id) ||
        typeof event.label?.name !== 'string' || !event.label.name ||
        !event.actor || !['User', 'Bot'].includes(event.actor.type) ||
        typeof event.actor.node_id !== 'string' || !event.actor.node_id ||
        !Number.isSafeInteger(event.actor.id) || event.actor.id <= 0) {
      throw new Error('A source PR label event is incomplete.');
    }
    seen.add(event.node_id);
    changes.push({ event, time: utcSecond(event.created_at) });
  }
  const fingerprint = timeline => {
    if (!Array.isArray(timeline) || timeline.length > 10_000) throw new Error('Source PR timeline is incomplete.');
    const selected = [];
    for (const event of timeline) {
      if (!event || typeof event.event !== 'string') throw new Error('Source PR timeline has an incomplete event.');
      if (['merged', 'labeled', 'unlabeled'].includes(event.event)) {
        selected.push([event.event, event.node_id ?? null, event.created_at ?? null, event.commit_id ?? null,
          event.label?.name ?? null, event.actor?.id ?? null, event.actor?.node_id ?? null, event.actor?.type ?? null]);
      }
    }
    return JSON.stringify(selected);
  };
  const metadata = new Map();
  for (let offset = 0; offset < changes.length; offset += 100) {
    const chunk = changes.slice(offset, offset + 100);
    const response = await github.graphql(LABEL_NODES_QUERY, { ids: chunk.map(item => item.event.node_id) });
    if (!response || !Array.isArray(response.nodes) || response.nodes.length !== chunk.length) {
      throw new Error('GraphQL label event response is incomplete.');
    }
    for (let index = 0; index < chunk.length; index++) {
      const item = chunk[index], event = item.event, node = response.nodes[index];
      const expectedType = event.event === 'labeled' ? 'LabeledEvent' : 'UnlabeledEvent';
      if (!node || node.id !== event.node_id || node.__typename !== expectedType ||
          node.createdAt !== event.created_at || !node.actor ||
          node.actor.__typename !== event.actor.type || node.actor.id !== event.actor.node_id ||
          (node.actor.__typename === 'User' && node.actor.databaseId !== event.actor.id) ||
          !node.label || typeof node.label.id !== 'string' || !node.label.id ||
          typeof node.label.name !== 'string' || !node.label.name ||
          node.label.repository?.databaseId !== REPO_ID ||
          node.labelable?.__typename !== 'PullRequest' ||
          node.labelable.number !== sourceNumber || node.labelable.repository?.databaseId !== REPO_ID) {
        throw new Error('REST and GraphQL source label events disagree.');
      }
      const label = node.label;
      const prior = metadata.get(label.id);
      const description = JSON.stringify([label.name, label.createdAt, label.updatedAt, label.repository.databaseId]);
      if (prior !== undefined && prior !== description) {
        throw new Error('Label metadata changed during source authorization.');
      }
      metadata.set(label.id, description);
      item.label = label;
    }
  }
  const confirm = await github.paginate(github.rest.issues.listEventsForTimeline, {
    owner: 'KingsleyHK0323', repo: 'Multimedia_Downloader', issue_number: sourceNumber, per_page: 100,
  });
  if (fingerprint(events) !== fingerprint(confirm)) throw new Error('Source PR timeline changed during authorization.');
  if (changes.some(item => item.label.id !== PATCH_LABEL_ID &&
      (item.label.name === 'release:patch' || item.event.label.name === 'release:patch'))) {
    throw new Error('Patch label identity is not the approved label.');
  }
  const withdrawnAfterMerge = changes.some(item => item.label.id === PATCH_LABEL_ID &&
    item.event.event === 'unlabeled' && item.time > mergedTime);
  const relevant = changes.filter(item => item.label.id === PATCH_LABEL_ID && item.time <= mergedTime)
    .sort((a, b) => a.time - b.time);
  let active = null, previousTime = null;
  for (const item of relevant) {
    if (item.time === mergedTime) throw new Error('Patch label changed in the same second as merge.');
    if (item.time === previousTime) throw new Error('Patch label events have ambiguous ordering.');
    const { label, event, time } = item;
    const created = utcSecond(label.createdAt), updated = utcSecond(label.updatedAt);
    if (label.name !== 'release:patch' || label.createdAt !== PATCH_LABEL_CREATED ||
        created > updated || updated >= time || event.label.name !== 'release:patch') {
      throw new Error('Patch label identity or historical name cannot be established.');
    }
    if ((event.event === 'labeled') === Boolean(active)) {
      throw new Error('Patch label history is incomplete or inconsistent.');
    }
    active = event.event === 'labeled' ? item : null;
    previousTime = time;
  }
  if (!active) return { atMerge: false, withdrawnAfterMerge };
  if (active.event.actor.type !== 'User' || active.event.actor.id !== OWNER_ID ||
      active.event.actor.node_id !== OWNER_NODE) {
    throw new Error('Effective patch label was not added by the repository owner.');
  }
  return { atMerge: true, withdrawnAfterMerge };
}
