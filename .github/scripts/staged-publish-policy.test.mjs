// OpenAI-Codex_publish_candidate: regression checks; never authorizes release.
import test from "node:test";
import assert from "node:assert/strict";
import { classifyStagedPublish as classify } from "./staged-publish-policy.mjs";

const expected = { tag: "v4.3.21", commitSha: "a".repeat(40), runId: 12, attempt: 2 };
const names = ["Multimedia.Downloader-4.3.21-1.x86_64.rpm", "Multimedia.Downloader_4.3.21_aarch64.dmg",
  "Multimedia.Downloader_4.3.21_amd64.AppImage", "Multimedia.Downloader_4.3.21_amd64.deb",
  "Multimedia.Downloader_4.3.21_x64-setup.exe", "Multimedia.Downloader_4.3.21_x64_en-US.msi"];
const make = () => {
  const assets = names.map((name, i) => ({ ...expected, name, size: i + 1, sha256: String(i).repeat(64) }));
  return {
    preflight: { tagLookup: "found", tag: expected.tag, tagCommit: expected.commitSha,
      tagMutationAttempted: false, releaseLookup: "absent", releaseInventoryComplete: true },
    build: { ...expected, status: "completed", conclusion: "success", artifactInventoryComplete: true, assets },
    draft: { createdReleaseId: 3, readbackReleaseId: 3, createdInThisOperation: true, isDraft: true,
      tag: expected.tag, tagCommit: expected.commitSha, tagMutationAttempted: false, uploadMode: "create-only",
      uploadConflictObserved: false, assetInventoryComplete: true,
      assets: assets.map(({ name, size, sha256 }, i) => ({ id: i + 1, name, size, sha256, state: "uploaded" })) },
  };
};

test("matching snapshots permit review but never publication", () => {
  assert.deepEqual(classify(expected, make()), { ok: true, snapshotConsistent: true, publishAuthorized: false });
});
test("missing, unknown, existing or moved tag and release fail closed", () => {
  for (const change of [{ tagLookup: "missing" }, { tagCommit: "b".repeat(40) }, { tagMutationAttempted: true },
    { releaseLookup: "present" }, { releaseLookup: "unknown" }, { releaseInventoryComplete: false }]) {
    const e = make(); Object.assign(e.preflight, change); assert.equal(classify(expected, e).ok, false);
  }
});
test("failed build, wrong run and incomplete assets fail closed", () => {
  for (const change of [{ status: "in_progress" }, { conclusion: "failure" }, { runId: 13 }, { attempt: 1 },
    { commitSha: "b".repeat(40) }, { artifactInventoryComplete: false }, { assets: [] }]) {
    const e = make(); Object.assign(e.build, change); assert.equal(classify(expected, e).ok, false);
  }
});
test("draft identity, conflicts, overwritten mode and tag drift fail closed", () => {
  for (const change of [{ createdReleaseId: 0 }, { readbackReleaseId: 4 }, { createdInThisOperation: false },
    { isDraft: false }, { tagCommit: "b".repeat(40) }, { tagMutationAttempted: true },
    { uploadMode: "overwrite" }, { uploadConflictObserved: true }, { assetInventoryComplete: false }]) {
    const e = make(); Object.assign(e.draft, change); assert.equal(classify(expected, e).ok, false);
  }
});
test("draft asset readback must match six distinct uploaded assets", () => {
  const variants = [a => a.pop(), a => a.push({ ...a[0], id: 7 }), a => { a[1].id = a[0].id; },
    a => { a[1].name = a[0].name; }, a => { a[0].size++; }, a => { a[0].sha256 = "f".repeat(64); },
    a => { a[0].state = "new"; }, a => { a[0] = null; }];
  for (const mutate of variants) { const e = make(); mutate(e.draft.assets); assert.equal(classify(expected, e).ok, false); }
});
test("invalid inputs and throwing getters do not authorize publication", () => {
  for (const value of [null, {}, { ...expected, tag: "v04.3.21" }, { ...expected, commitSha: "a".repeat(40) + "\n" }]) {
    const result = classify(value, make()); assert.equal(result.ok, false); assert.equal(result.publishAuthorized, false);
  }
  const e = make(); Object.defineProperty(e, "preflight", { get() { throw new Error("unreadable"); } });
  assert.equal(classify(expected, e).publishAuthorized, false);
});



test("asset fields are read once", () => {
  const evidence = make(), asset = evidence.build.assets[0];
  let reads = 0;
  Object.defineProperty(asset, "size", { get() { reads++; return 1; } });
  assert.equal(classify(expected, evidence).snapshotConsistent, true);
  assert.equal(reads, 1);
});
