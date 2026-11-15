// OpenAI-Codex_asset_policy: non-authorizing asset metadata regression tests.
import assert from "node:assert/strict";
import test from "node:test";
import { classifyReleaseAssets as classify } from "./release-asset-policy.mjs";

const expected = { tag: "v4.3.21", commitSha: "a".repeat(40), runId: 123, attempt: 2 };
const names = [
  "Multimedia.Downloader-4.3.21-1.x86_64.rpm",
  "Multimedia.Downloader_4.3.21_aarch64.dmg",
  "Multimedia.Downloader_4.3.21_amd64.AppImage",
  "Multimedia.Downloader_4.3.21_amd64.deb",
  "Multimedia.Downloader_4.3.21_x64-setup.exe",
  "Multimedia.Downloader_4.3.21_x64_en-US.msi",
];
const manifest = () => names.map((name) => ({ name, size: 1234, sha256: "b".repeat(64), ...expected }));

test("complete matching inventory is informational only", () => {
  const result = classify(expected, manifest());
  assert.deepEqual(result, { ok: true, version: "4.3.21", count: 6, publishAuthorized: false });
  assert.equal(classify(expected, manifest().reverse()).ok, true);
});

test("rejects incomplete, duplicate, extra and wrong-version names", () => {
  const a = manifest();
  assert.equal(classify(expected, a.slice(1)).ok, false);
  assert.equal(classify(expected, [...a, a[0]]).ok, false);
  assert.equal(classify(expected, [a[0], a[0], ...a.slice(2)]).ok, false);
  for (const name of ["../" + names[0], names[0].replace("4.3.21", "4.3.20"), names[0].toUpperCase()]) {
    const next = manifest(); next[0].name = name;
    assert.equal(classify(expected, next).ok, false, name);
  }
});

test("rejects invalid expected version and source identity", () => {
  for (const bad of [null, {}, { ...expected, tag: "v04.3.21" }, { ...expected, tag: "4.3.21" }, { ...expected, tag: "v4.3.21-rc1" },
    { ...expected, tag: "v4.3.21\n" }, { ...expected, commitSha: "a".repeat(40) + "\n" },
    { ...expected, commitSha: "A".repeat(40) }, { ...expected, runId: 0 },
    { ...expected, attempt: 1.5 }, { ...expected, runId: Number.MAX_SAFE_INTEGER + 1 }]) {
    const result = classify(bad, manifest());
    assert.equal(result.ok, false);
    assert.equal(result.publishAuthorized, false);
  }
});

test("rejects invalid per-asset size, digest or originating identity", () => {
  for (const change of [
    { size: 0 }, { size: -1 }, { size: 1.1 }, { size: Number.MAX_SAFE_INTEGER + 1 },
    { sha256: "A".repeat(64) }, { sha256: "b".repeat(63) }, { sha256: "b".repeat(64) + "\n" }, { sha256: "g".repeat(64) },
    { tag: "v4.3.20" }, { commitSha: "c".repeat(40) }, { runId: 124 }, { attempt: 1 },
  ]) {
    const next = manifest(); Object.assign(next[0], change);
    assert.equal(classify(expected, next).ok, false, JSON.stringify(change));
  }
});

test("unreadable or malformed metadata fails closed", () => {
  assert.equal(classify(expected, null).ok, false);
  const a = manifest(); a[0] = null;
  assert.equal(classify(expected, a).ok, false);
  const poisoned = manifest(); Object.defineProperty(poisoned[0], "name", { get() { throw new Error("poison"); } });
  assert.deepEqual(classify(expected, poisoned), { ok: false, reason: "unreadable metadata", publishAuthorized: false });
  const forged = [null, null, null, null, null, null];
  forged[Symbol.iterator] = function* () { yield* manifest(); };
  assert.equal(classify(expected, forged).ok, false);
});

