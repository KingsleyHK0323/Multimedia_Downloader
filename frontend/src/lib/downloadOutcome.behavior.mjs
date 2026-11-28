// OpenAI-Codex_Fork_GitHub_REPO: synthetic terminal reply classification.
import assert from "node:assert/strict";
import { downloadOutcome, formatDownloadPercent } from "./downloadOutcome.ts";

const urls = ["https://example.com/a", "https://example.com/b"];
const good = [[urls[0], true, ""], [urls[1], true, ""]];
// OpenAI-Codex_ui_fix: preserve the reported code without exposing private request details.
assert.deepEqual(downloadOutcome({ results: [[urls[0], false, "HTTP Error 412: private detail"]] }, [urls[0]]),
  { kind: "failed", total: 1, failed: 1, httpStatus: "412" });
assert.equal(formatDownloadPercent(7.739312008126959), "7.7");
assert.equal(formatDownloadPercent(101), "100");
assert.equal(formatDownloadPercent(-1), "0");
assert.equal(formatDownloadPercent(NaN), "—");
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
