// OpenAI-Codex: exercise actual terminal outcomes, including unknown replies.
import assert from "node:assert/strict";
import { convertOutcome } from "./convertOutcome.ts";

const done = { src: "a.mkv", dst: "a.mp4", status: "done", error: "" };
const error = { src: "b.mkv", dst: "b.mp4", status: "error", error: "failed" };
assert.deepEqual(convertOutcome({ jobs: [done, done] }, 2), { kind: "complete", total: 2 });
assert.deepEqual(convertOutcome({ jobs: [done, error] }, 2), { kind: "failed", total: 2, failed: 1 });
for (const response of [null, {}, { jobs: [done] }, { jobs: [{ ...done, status: "pending" }, done] },
  { jobs: [{ ...done, error: null }, done] }, { jobs: new Array(2) }]) {
  assert.deepEqual(convertOutcome(response, 2), { kind: "unknown" });
}
console.log("Conversion outcome checks passed with synthetic replies.");

