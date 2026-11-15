// OpenAI-Codex_publish_impl: unconnected draft; not approved for production.
// Adapter contract: verifyAccess, resolveTag, findRelease, validateBuild,
// readBytes, createDraft, uploadNew, listAssets, publishDraft. All methods
// return promises; implementations must establish API provenance and complete
// pagination. An adapter is not intrinsically trustworthy. No automatic retry.
import { createHash } from 'node:crypto';
import { classifyReleaseAssets } from './release-asset-policy.mjs';
const MAX_ASSET_BYTES = 1024 * 1024 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;

export async function stageRelease({ adapter, expected, assets, enableWrites = false }) {
  const fail = (reason, draftId = null) => ({ ok: false, reason, draftId, sideEffectUncertain: createStarted });
  let draftId = null;
  let createStarted = false;
  try {
    if (enableWrites !== true) return fail('writes disabled');
    if (!expected || typeof expected !== 'object') return fail('invalid identity');
    const identity = Object.freeze({ tag: expected.tag, commitSha: expected.commitSha, runId: expected.runId, attempt: expected.attempt });
    if (!adapter || await adapter.verifyAccess() !== true) return fail('access unverified');
    if ((await adapter.resolveTag(identity.tag)) !== identity.commitSha) return fail('tag mismatch');
    const existing = await adapter.findRelease(identity.tag);
    if (!existing || existing.status !== 404 || existing.complete !== true) return fail('release not proven absent');
    const buildResult = await adapter.validateBuild(identity);
    if (!buildResult || buildResult.verified !== true) return fail('build unverified');
    const rawManifest = buildResult.assets;
    if (!Array.isArray(rawManifest) || rawManifest.length !== 6) return fail('build unverified');
    const manifestAssets = Array.from({length: 6}, (_, i) => { const x = rawManifest[i]; if (!x || typeof x !== 'object') throw Error('bad manifest'); const {name,size,sha256,tag,commitSha,runId,attempt} = x; return Object.freeze({name,size,sha256,tag,commitSha,runId,attempt}); });
    if (!classifyReleaseAssets(identity, manifestAssets).ok) return fail('invalid build manifest');
    if (manifestAssets.some(entry => entry.size > MAX_ASSET_BYTES) || manifestAssets.reduce((sum, entry) => sum + entry.size, 0) > MAX_TOTAL_BYTES) return fail('asset limits exceeded');
    if (!Array.isArray(assets) || assets.length !== 6) return fail('invalid assets');
    const snapshots = [];
    for (let i = 0; i < 6; i++) {
      const item = assets[i];
      if (!item || typeof item !== 'object') return fail('invalid asset input');
      const name = item.name;
      if (typeof name !== 'string') return fail('invalid asset input');
      const data = await adapter.readBytes(name, { maxBytes: MAX_ASSET_BYTES });
      if (!(data instanceof Uint8Array) || data.byteLength === 0 || data.byteLength > MAX_ASSET_BYTES) return fail('invalid bytes');
      const bytes = Buffer.from(data);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const matches = manifestAssets.filter(entry => entry.name === name);
      if (matches.length !== 1 || matches[0].size !== bytes.length || matches[0].sha256 !== sha256) return fail('build asset mismatch');
      snapshots.push({ ...identity, name, size: bytes.length, sha256, bytes });
    }
    if (!classifyReleaseAssets(identity, snapshots).ok) return fail('invalid asset inventory');
    if ((await adapter.resolveTag(identity.tag)) !== identity.commitSha) return fail('tag changed');
    createStarted = true;
    const draft = await adapter.createDraft({ tag: identity.tag, verifyTag: true });
    if (!draft || typeof draft !== 'object') return fail('draft unverified', draftId);
    const { id: observedId, draft: observedDraft, tag: observedTag } = draft;
    if (Number.isSafeInteger(observedId) && observedId > 0) draftId = observedId;
    if (!Number.isSafeInteger(observedId) || observedId <= 0 || observedDraft !== true || observedTag !== identity.tag) return fail('draft unverified', draftId);
    for (const file of snapshots) await adapter.uploadNew({ draftId, name: file.name, bytes: file.bytes, overwrite: false });
    const result = await adapter.listAssets(draftId);
    if (!result || result.complete !== true) return fail('asset readback incomplete', draftId);
    const returnedAssets = result.assets;
    if (!Array.isArray(returnedAssets) || returnedAssets.length !== 6) return fail('asset readback incomplete', draftId);
    const ids = new Set(), names = new Set();
    for (let i = 0; i < 6; i++) {
      const item = returnedAssets[i];
      if (!item || typeof item !== 'object') return fail('asset readback mismatch', draftId);
      const {id, name, state, size} = item;
      const original = snapshots.find(x => x.name === name);
      if (!original || names.has(name) || !Number.isSafeInteger(id) || id <= 0 || ids.has(id) || state !== 'uploaded' || size !== original.size) return fail('asset readback mismatch', draftId);
      const downloaded = await adapter.readUploadedBytes(draftId, id, { maxBytes: MAX_ASSET_BYTES });
      if (!(downloaded instanceof Uint8Array) || downloaded.byteLength !== original.size || createHash('sha256').update(downloaded).digest('hex') !== original.sha256) return fail('asset bytes mismatch', draftId);
      names.add(name); ids.add(id);
    }
    if ((await adapter.resolveTag(identity.tag)) !== identity.commitSha || await adapter.verifyDraft(draftId, identity.tag) !== true) return fail('final state changed', draftId);
    const published = await adapter.publishDraft(draftId);
    if (!published || published.id !== draftId || published.draft !== false || published.tag !== identity.tag) return fail('publication unconfirmed', draftId);
    return { ok: true, draftId };
  } catch { return fail('adapter error or uncertain operation', draftId); }
}

