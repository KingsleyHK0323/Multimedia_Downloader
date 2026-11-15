// OpenAI-Codex_publish_candidate: informational snapshot classifier only.
// No I/O, release writes, locking, provenance verification or publication occurs.
import { classifyReleaseAssets } from "./release-asset-policy.mjs";

const isId = (value) => Number.isSafeInteger(value) && value > 0;

// Inputs must be independently verified plain data snapshots. Their contents
// cannot establish API completeness, source authenticity or atomicity. In
// particular, a successful result must never be used as permission to publish.
export function classifyStagedPublish(expected, evidence) {
  const reject = (reason) => ({ ok: false, reason, publishAuthorized: false });
  try {
    if (!expected || typeof expected !== "object" || Array.isArray(expected) ||
        !evidence || typeof evidence !== "object" || Array.isArray(evidence)) return reject("invalid input");
    const identity = { tag: expected.tag, commitSha: expected.commitSha, runId: expected.runId, attempt: expected.attempt };
    const { preflight, build, draft } = evidence;
    if (!preflight || !build || !draft || typeof preflight !== "object" || typeof build !== "object" || typeof draft !== "object") {
      return reject("missing evidence");
    }
    // OpenAI-Codex_Fork_GitHub_REPO: copy each observed field exactly once.
    const capture = (list) => {
      if (!Array.isArray(list) || list.length !== 6) return null;
      return Array.from({ length: 6 }, (_, index) => {
        const item = list[index];
        if (!item || typeof item !== "object" || Array.isArray(item)) return null;
        const { name, size, sha256, tag, commitSha, runId, attempt, id, state } = item;
        return { name, size, sha256, tag, commitSha, runId, attempt, id, state };
      });
    };
    const buildAssets = capture(build.assets), draftAssets = capture(draft.assets);
    // An existing tag may be used only if it already resolves to the expected
    // commit. Neither tag creation nor moving an existing tag is modelled.
    if (preflight.tagLookup !== "found" || preflight.tag !== identity.tag ||
        preflight.tagCommit !== identity.commitSha || preflight.tagMutationAttempted !== false ||
        preflight.releaseLookup !== "absent" || preflight.releaseInventoryComplete !== true) {
      return reject("preflight not established");
    }
    if (build.status !== "completed" || build.conclusion !== "success" ||
        build.tag !== identity.tag || build.commitSha !== identity.commitSha ||
        build.runId !== identity.runId || build.attempt !== identity.attempt ||
        build.artifactInventoryComplete !== true || classifyReleaseAssets(identity, buildAssets).ok !== true) {
      return reject("build evidence not established");
    }
    if (!isId(draft.createdReleaseId) || draft.readbackReleaseId !== draft.createdReleaseId ||
        draft.createdInThisOperation !== true || draft.isDraft !== true ||
        draft.tag !== identity.tag || draft.tagCommit !== identity.commitSha ||
        draft.tagMutationAttempted !== false || draft.uploadMode !== "create-only" ||
        draft.uploadConflictObserved !== false || draft.assetInventoryComplete !== true ||
        !Array.isArray(draftAssets) || draftAssets.length !== buildAssets.length) {
      return reject("draft evidence not established");
    }
    const assetsByName = new Map();
    for (let i = 0; i < buildAssets.length; i++) {
      const asset = buildAssets[i];
      assetsByName.set(asset.name, { size: asset.size, sha256: asset.sha256 });
    }
    const seenNames = new Set(), seenIds = new Set();
    for (let i = 0; i < draftAssets.length; i++) {
      const asset = draftAssets[i];
      if (!asset || typeof asset !== "object" || Array.isArray(asset)) return reject("invalid draft asset");
      const { id, name, size, sha256, state } = asset;
      const source = assetsByName.get(name);
      if (!isId(id) || seenIds.has(id) || seenNames.has(name) || !source || state !== "uploaded" ||
          size !== source.size || sha256 !== source.sha256) return reject("draft assets differ from build evidence");
      seenIds.add(id);
      seenNames.add(name);
    }
    if (seenNames.size !== 6) return reject("incomplete draft inventory");
    // These are observations only. Tag, draft and asset state can change after
    // any re-read; no finite sequence of snapshots proves the next write safe.
    return { ok: true, snapshotConsistent: true, publishAuthorized: false };
  } catch {
    return reject("unreadable evidence");
  }
}

