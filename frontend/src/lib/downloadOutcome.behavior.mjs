// OpenAI-Codex_Fork_GitHub_REPO: synthetic terminal reply classification.
import assert from "node:assert/strict";
import { downloadOutcome } from "./downloadOutcome.ts";

const urls = ["https://example.com/a", "https://example.com/b"];
const good = [[urls[0], true, ""], [urls[1], true, ""]];
assert.deepEqual(downloadOutcome({ results: good }, urls), { kind: "complete", total: 2 });
assert.deepEqual(downloadOutcome({ results: [[urls[0], true, ""], [urls[1], false, "x"]] }, urls),
  { kind: "failed", total: 2, failed: 1 });
assert.deepEqual(downloadOutcome({ results: [[urls[0], false, "x"], [urls[1], false, "y"]] }, urls),
  { kind: "failed", total: 2, failed: 2 });
assert.deepEqual(downloadOutcome({ results: [good[0]] }, urls), { kind: "incomplete", total: 2, done: 1 });
assert.deepEqual(downloadOutcome({ results: [] }, urls), { kind: "incomplete", total: 2, done: 0 });
for (const bad of [null, undefined, {}, { results: [...good, good[0]] },
  { results: [good[1], good[0]] }, { results: [[urls[0], "true", ""]] },
  { results: [[urls[0], true, null]] }, { results: new Array(2) }]) {
  assert.deepEqual(downloadOutcome(bad, urls), { kind: "unknown" });
}
assert.deepEqual(downloadOutcome({ results: [[urls[0], true, ""], [urls[0], true, ""]] },
  [urls[0], urls[0]]), { kind: "complete", total: 2 });
assert.deepEqual(downloadOutcome({ results: [] }, []), { kind: "unknown" });
console.log("Download outcome checks passed with synthetic replies.");
