// OpenAI-Codex_bridge_fix: unconnected candidate. Provider assertions are not
// evidence by themselves; tag and GitHub API operations remain non-atomic.
import { stageRelease } from './staged-release-publisher.mjs';

export async function runControlledRelease({ release, evidence, store, expected, assets, title, notes, enableWrites = false } = {}) {
  if (enableWrites !== true) return { ok: false, reason: 'writes disabled', sideEffectUncertain: false };
  try {
    if (!release || !evidence || !store || !expected || typeof title !== 'string' || typeof notes !== 'string') throw Error('configuration');
    const identity = Object.freeze({ tag: expected.tag, commitSha: expected.commitSha, runId: expected.runId, attempt: expected.attempt });
    // The provider must independently establish these conditions. This boolean
    // contract is not itself a permission check or a provenance guarantee.
    const proof = await evidence.verifySafety(identity);
    if (!proof || proof.draftVisibility !== true || proof.releaseInventoryTrusted !== true ||
        proof.tagProtected !== true || proof.actorNonBypass !== true || proof.buildTrusted !== true) throw Error('safety unverified');
    let createdId = null;
    const resolveTag = async (tag) => { if (tag !== identity.tag) throw Error('tag mismatch'); return await evidence.resolveTag(identity); };
    const adapter = Object.freeze({
      verifyAccess: async () => await evidence.verifyAccess(identity) === true,
      resolveTag,
      findRelease: async (tag) => {
        if (tag !== identity.tag || await evidence.verifyAccess(identity) !== true) throw Error('access');
        const lookup = await release.getReleaseByTag(tag);
        if (!lookup || lookup.status !== 404) return { status: lookup?.status, complete: false };
        // A 404 alone may hide private or draft resources: require verified
        // visibility and a fully paginated list supplied by the trusted provider.
        for (let page = 1; page <= 1000; page++) {
          const response = await evidence.listVisibleReleases(page, identity);
          if (!response || typeof response !== 'object') throw Error('release inventory');
          const { status, data } = response;
          if (status !== 200 || !Array.isArray(data)) throw Error('release inventory');
          const length = data.length;
          if (!Number.isSafeInteger(length) || length < 0 || length > 100) throw Error('release inventory');
          for (let i = 0; i < length; i++) {
            const item = data[i];
            if (!item || typeof item !== 'object') throw Error('release entry');
            const { tag_name: foundTag } = item;
            if (typeof foundTag !== 'string' || !foundTag || foundTag === tag) throw Error('existing or unknown release');
          }
          if (length < 100) return { status: 404, complete: true };
        }
        throw Error('release pagination limit');
      },
      validateBuild: async (given) => await evidence.validateBuild(given),
      readBytes: async (name, options) => await store.readBytes(name, options),
      createDraft: async ({ tag, verifyTag }) => {
        if (tag !== identity.tag || verifyTag !== true || await resolveTag(tag) !== identity.commitSha) throw Error('tag');
        const response = await release.createDraft({ tag, commitSha: identity.commitSha, title, notes });
        if (!response || typeof response !== 'object') throw Error('draft response');
        const { id, draft, tag_name: foundTag } = response;
        if (Number.isSafeInteger(id) && id > 0 && draft === true && foundTag === tag) createdId = id;
        return { id, draft, tag: foundTag };
      },
      uploadNew: async ({ draftId, name, bytes, overwrite }) => {
        if (draftId !== createdId || overwrite !== false) throw Error('upload');
        return await release.uploadAsset(draftId, name, bytes);
      },
      listAssets: async (draftId) => {
        if (draftId !== createdId) throw Error('draft');
        const items = [];
        for (let page = 1; page <= 1000; page++) {
          const response = await release.listAssets(draftId, page);
          if (!response || typeof response !== 'object') throw Error('asset inventory');
          const { status, data } = response;
          if (status !== 200 || !Array.isArray(data)) throw Error('asset inventory');
          const length = data.length;
          if (!Number.isSafeInteger(length) || length < 0 || length > 100) throw Error('asset inventory');
          for (let i = 0; i < length; i++) {
            const entry = data[i];
            if (!entry || typeof entry !== 'object') throw Error('asset entry');
            const { id, name, state, size } = entry;
            items.push(Object.freeze({ id, name, state, size }));
          }
          if (length < 100) return { complete: true, assets: items };
        }
        throw Error('asset pagination limit');
      },
      readUploadedBytes: async (draftId, id, options) => {
        if (draftId !== createdId || !options || !Number.isSafeInteger(options.maxBytes)) throw Error('download');
        return await release.downloadAsset(id, Math.min(options.maxBytes, 512 * 1024 * 1024));
      },
      verifyDraft: async (draftId, tag) => {
        if (draftId !== createdId || tag !== identity.tag || await resolveTag(tag) !== identity.commitSha) return false;
        const response = await release.getRelease(draftId);
        if (!response || typeof response !== 'object') return false;
        const { status, data } = response;
        if (status !== 200 || !data || typeof data !== 'object') return false;
        const { id, draft, tag_name: foundTag } = data;
        return id === draftId && draft === true && foundTag === tag;
      },
      publishDraft: async (draftId) => {
        if (draftId !== createdId) throw Error('draft');
        const response = await release.publishDraft(draftId);
        if (!response || typeof response !== 'object') throw Error('publish response');
        const { id, draft, tag_name: foundTag } = response;
        return { id, draft, tag: foundTag };
      },
    });
    // The adapter is private to this invocation; callers receive only a result.
    return await stageRelease({ adapter, expected: identity, assets, enableWrites: true });
  } catch { return { ok: false, reason: 'safety evidence unavailable', sideEffectUncertain: false }; }
}

