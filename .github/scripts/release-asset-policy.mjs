// OpenAI-Codex_asset_policy: metadata classifier only; no release authorization.
// This module performs no filesystem, network, workflow or credential operations.

// OpenAI-Codex_Fork_GitHub_REPO: require the true end, including against trailing line terminators.
const TAG = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?![\s\S])/;
const COMMIT = /^[0-9a-f]{40}(?![\s\S])/;
const DIGEST = /^[0-9a-f]{64}(?![\s\S])/;
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;

// Expected identity must come from separately verified trusted evidence. Matching
// metadata does not prove the bytes, provenance, version contents or build safety.
export function classifyReleaseAssets(expected, assets) {
  const reject = (reason) => ({ ok: false, reason, publishAuthorized: false });
  try {
    if (!expected || typeof expected !== "object" || Array.isArray(expected)) return reject("invalid expected identity");
    const { tag, commitSha, runId, attempt } = expected;
    if (typeof tag !== "string" || tag.length > 51 || !TAG.test(tag) ||
        typeof commitSha !== "string" || !COMMIT.test(commitSha) ||
        !positiveInteger(runId) || !positiveInteger(attempt)) return reject("invalid expected identity");
    const version = tag.slice(1);
    const allowed = new Set([
      `Multimedia.Downloader-${version}-1.x86_64.rpm`,
      `Multimedia.Downloader_${version}_aarch64.dmg`,
      `Multimedia.Downloader_${version}_amd64.AppImage`,
      `Multimedia.Downloader_${version}_amd64.deb`,
      `Multimedia.Downloader_${version}_x64-setup.exe`,
      `Multimedia.Downloader_${version}_x64_en-US.msi`,
    ]);
    if (!Array.isArray(assets) || assets.length !== allowed.size) return reject("asset inventory incomplete");
    const seen = new Set();
    // OpenAI-Codex_Fork_GitHub_REPO: ignore a caller-supplied array iterator.
    for (let index = 0; index < allowed.size; index++) {
      const asset = assets[index];
      if (!asset || typeof asset !== "object" || Array.isArray(asset)) return reject("invalid asset metadata");
      const { name, size, sha256, tag: assetTag, commitSha: assetCommit, runId: assetRun, attempt: assetAttempt } = asset;
      if (typeof name !== "string" || !allowed.has(name) || seen.has(name) ||
          !positiveInteger(size) || typeof sha256 !== "string" || !DIGEST.test(sha256) ||
          assetTag !== tag || assetCommit !== commitSha || assetRun !== runId || assetAttempt !== attempt) {
        return reject("invalid asset metadata");
      }
      seen.add(name);
    }
    return { ok: true, version, count: seen.size, publishAuthorized: false };
  } catch {
    return reject("unreadable metadata");
  }
}

