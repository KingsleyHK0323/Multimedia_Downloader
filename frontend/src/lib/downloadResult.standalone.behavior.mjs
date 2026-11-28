// OpenAI-Codex_app_ui: standalone synthetic checks for download result validation.
import assert from "node:assert/strict";
import { isValidDownloadResult } from "./downloadResult.ts";

const requested = ["synthetic-a", "synthetic-b", "synthetic-c"];
const succeeded = (url) => [url, true, ""];
const failed = (url, error = "synthetic failure") => [url, false, error];
const summary = (ok, error, skipped, cancelled = false) => ({
  total: 3, succeeded: ok, failed: error, skipped, cancelled,
});
let checked = 0;
function check(name, expected, response, want) {
  assert.equal(isValidDownloadResult(expected, response), want, name);
  checked++;
}

const valid = [
  ["all succeeded", { results: requested.map(succeeded), summary: summary(3, 0, 0) }],
  ["all failed", { results: requested.map((url) => failed(url)), summary: summary(0, 3, 0) }],
  ["failure with empty exception message", { results: [failed(requested[0], "")], summary: summary(0, 1, 2) }],
  ["mixed completed results", { results: [succeeded(requested[0]), failed(requested[1]), succeeded(requested[2])], summary: summary(2, 1, 0) }],
  ["mixed completed and skipped", { results: [succeeded(requested[0]), failed(requested[1])], summary: summary(1, 1, 1) }],
  ["cancel after one result", { results: [succeeded(requested[0])], summary: summary(1, 0, 2, true) }],
  ["cancel before results", { results: [], summary: summary(0, 0, 3, true) }],
  ["all skipped without cancellation", { results: [], summary: summary(0, 0, 3) }],
  ["stop after all items finished", { results: requested.map(succeeded), summary: summary(3, 0, 0, true) }],
  ["failed then succeeded before stop", { results: [failed(requested[0]), succeeded(requested[1])], summary: summary(1, 1, 1, true) }],
];
for (const [name, response] of valid) check(name, requested, response, true);
const repeated = ["same-synthetic-url", "same-synthetic-url"];
check("duplicate requests preserve positional matching", repeated, {
  results: [succeeded(repeated[0]), failed(repeated[1])],
  summary: { total: 2, succeeded: 1, failed: 1, skipped: 0, cancelled: false },
}, true);
const immutableRequests = Object.freeze(["frozen-a"]);
const immutableResponse = Object.freeze({
  results: Object.freeze([Object.freeze(["frozen-a", true, ""])]),
  summary: Object.freeze({ total: 1, succeeded: 1, failed: 0, skipped: 0, cancelled: false }),
});
check("valid frozen values are not mutated", immutableRequests, immutableResponse, true);
check("empty requests are rejected", [], { results: [], summary: { total: 0, succeeded: 0, failed: 0, skipped: 0, cancelled: false } }, false);

const sparseResults = [succeeded(requested[0]), , succeeded(requested[2])];
const sparseTuple = [requested[0], true];
sparseTuple.length = 3;
const fullSummary = summary(3, 0, 0);
const singleSummary = summary(1, 0, 2);
const invalid = [
  ["missing reply", undefined],
  ["null reply", null],
  ["numeric reply", 42],
  ["string reply", "result"],
  ["boolean reply", true],
  ["symbol reply", Symbol("synthetic")],
  ["array reply", []],
  ["missing fields", {}],
  ["missing results", { summary: fullSummary }],
  ["null results", { results: null, summary: fullSummary }],
  ["non-array results", { results: "invalid", summary: fullSummary }],
  ["missing summary", { results: requested.map(succeeded) }],
  ["null summary", { results: requested.map(succeeded), summary: null }],
  ["non-object summary", { results: requested.map(succeeded), summary: "invalid" }],
  ["missing total", { results: [succeeded(requested[0])], summary: { succeeded: 1, failed: 0, skipped: 2, cancelled: false } }],
  ["incorrect total", { results: [succeeded(requested[0])], summary: { ...singleSummary, total: 2 } }],
  ["missing succeeded", { results: [succeeded(requested[0])], summary: { total: 3, failed: 0, skipped: 2, cancelled: false } }],
  ["negative count", { results: [succeeded(requested[0])], summary: summary(1, -1, 3) }],
  ["fractional count", { results: [succeeded(requested[0])], summary: summary(1.5, 0, 1.5) }],
  ["NaN count", { results: [succeeded(requested[0])], summary: summary(Number.NaN, 0, 2) }],
  ["infinite count", { results: [succeeded(requested[0])], summary: summary(Number.POSITIVE_INFINITY, 0, 2) }],
  ["unsafe count", { results: [succeeded(requested[0])], summary: summary(Number.MAX_SAFE_INTEGER + 1, 0, 2) }],
  ["string count", { results: [succeeded(requested[0])], summary: summary("1", 0, 2) }],
  ["bigint count", { results: [succeeded(requested[0])], summary: summary(1n, 0, 2) }],
  ["missing cancelled", { results: [succeeded(requested[0])], summary: { total: 3, succeeded: 1, failed: 0, skipped: 2 } }],
  ["non-boolean cancelled", { results: [succeeded(requested[0])], summary: { ...singleSummary, cancelled: "false" } }],
  ["counts do not add up", { results: [succeeded(requested[0])], summary: summary(1, 0, 1) }],
  ["completed count differs from length", { results: [succeeded(requested[0])], summary: summary(2, 0, 1) }],
  ["actual failure contradicts success count", { results: [failed(requested[0]), succeeded(requested[1]), succeeded(requested[2])], summary: fullSummary }],
  ["actual success contradicts failure count", { results: requested.map(succeeded), summary: summary(2, 1, 0) }],
  ["sparse result array", { results: sparseResults, summary: fullSummary }],
  ["sparse tuple", { results: [sparseTuple], summary: singleSummary }],
  ["null tuple", { results: [null], summary: singleSummary }],
  ["non-array tuple", { results: [{ url: requested[0], ok: true, error: "" }], summary: singleSummary }],
  ["short tuple", { results: [[requested[0], true]], summary: singleSummary }],
  ["long tuple", { results: [[requested[0], true, "", "extra"]], summary: singleSummary }],
  ["non-boolean success", { results: [[requested[0], "true", ""]], summary: singleSummary }],
  ["null error", { results: [[requested[0], true, null]], summary: singleSummary }],
  ["exception object instead of error string", { results: [[requested[0], false, new Error("synthetic")]], summary: summary(0, 1, 2) }],
  ["success with error text", { results: [[requested[0], true, "synthetic failure"]], summary: singleSummary }],
  ["success with whitespace error text", { results: [[requested[0], true, " "]], summary: singleSummary }],
  ["skipped first request is not a result prefix", { results: [succeeded(requested[1])], summary: singleSummary }],
  ["reordered results", { results: [succeeded(requested[1]), succeeded(requested[0])], summary: summary(2, 0, 1) }],
  ["unknown result URL", { results: [succeeded("synthetic-other")], summary: singleSummary }],
  ["duplicate output for distinct requests", { results: [succeeded(requested[0]), succeeded(requested[0])], summary: summary(2, 0, 1) }],
  ["too many results", { results: [...requested.map(succeeded), succeeded("synthetic-extra")], summary: fullSummary }],
];
for (const [name, response] of invalid) check(name, requested, response, false);
console.log(`Download result guard: ${checked} synthetic checks passed.`);