// OpenAI-Codex: execute the current TypeScript handlers across line endings.
import { stripTypeScriptTypes } from "node:module";
// OpenAI-Codex_app_ui: synthetic download-result contract checks.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { isValidDownloadResult } from "./downloadResult.ts";
import { operationOutcome } from "./operation.ts";
import { safeAiErrorText } from "./operation.ts"; // OpenAI-Codex_app_ui

const expected = ["synthetic-a", "synthetic-b", "synthetic-c"];
const summary = (succeeded, failed, skipped, cancelled = false) => ({ total: 3, succeeded, failed, skipped, cancelled });
const done = (url) => [url, true, ""];
const fail = (url) => [url, false, "synthetic error"];

for (const result of [
  { results: expected.map(done), summary: summary(3, 0, 0) },
  { results: [[expected[0], false, ""]], summary: summary(0, 1, 2) },
  { results: [done(expected[0]), fail(expected[1]), done(expected[2])], summary: summary(2, 1, 0) },
  { results: [done(expected[0]), fail(expected[1])], summary: summary(1, 1, 1) },
  { results: [done(expected[0])], summary: summary(1, 0, 2, true) },
  { results: [], summary: summary(0, 0, 3, true) },
]) assert.equal(isValidDownloadResult(expected, result), true);

const sparseResults = [done(expected[0]), , done(expected[2])];
const sparseTuple = [expected[0], true, ,];
for (const result of [
  { results: [[expected[0], true, "synthetic error"]], summary: summary(1, 0, 2) },
  { results: [fail(expected[0]), done(expected[1]), done(expected[2])], summary: summary(3, 0, 0) },
  { results: [done(expected[0]), done(expected[1]), done(expected[2])], summary: summary(2, 1, 0) },
  { results: sparseResults, summary: summary(3, 0, 0) },
  { results: [sparseTuple], summary: summary(1, 0, 2) },
  { results: [[expected[0], true]], summary: summary(1, 0, 2) },
  { results: [[expected[0], true, "", "extra"]], summary: summary(1, 0, 2) },
  { results: [[expected[0], true, null]], summary: summary(1, 0, 2) },
  { results: [[expected[0], "true", ""]], summary: summary(1, 0, 2) },
  { results: [done(expected[1])], summary: summary(1, 0, 2) },
  { results: [done(expected[0])], summary: { ...summary(1, 0, 2), total: 2 } },
  { results: [done(expected[0])], summary: summary(1.5, 0, 1.5) },
  { results: [done(expected[0])], summary: summary(Number.NaN, 0, 2) },
  { results: [done(expected[0])], summary: summary(Number.POSITIVE_INFINITY, 0, 2) },
  { results: [done(expected[0])], summary: summary(1, -1, 3) },
  { results: [done(expected[0])], summary: { ...summary(1, 0, 2), cancelled: "false" } },
  { results: [done(expected[0])], summary: null },
  { results: "invalid", summary: summary(3, 0, 0) },
  null,
]) assert.equal(isValidDownloadResult(expected, result), false);

const source = readFileSync(new URL("../tabs/DownloadTab.svelte", import.meta.url), "utf8");
assert.match(source, /if \(!isValidDownloadResult\(startedUrls, result\)\)/);
assert.match(source, /catch \(e\) \{\s*(?:if \(!isCurrentDownloadBatch\(batchToken\)\) return;\s*setDownloadBatchPhase\(batchToken, "unknown"\);\s*if \(!isCurrentDownloadBatch\(batchToken\)\) return;\s*)downloadResultUnreliable = true;\s*toast\(/);
assert.match(source, /downloadResultUnreliable = false;\s*const startedUrls/);
assert.match(source, /\{#if !downloadResultUnreliable\}\s*<!-- Per-item batch status -->/);
assert.match(source, /\{#if downloadResultUnreliable && \$downloadMode === mode\}[\s\S]*?tr\("operation_state_unknown"\)/);
assert.match(source, /finally \{\s*(?:if \(isCurrentDownloadBatch\(batchToken\)\) \{\s*)busy\.set\(false\);\s*(?:if \(isCurrentDownloadBatch\(batchToken\)\) \{\s*)activeOperation\.set\(null\);/);

// Execute the actual start handler against fake stores and a synthetic transport.
const startFunction = source.match(/async function start\(\) \{[\s\S]*?\r?\n  \}(?=\s*async function stop)/)?.[0];
assert.ok(startFunction, "download start handler must exist");
function harness(reply, reject = false) {
  const state = { items: [], updates: 0, toasts: [], busy: false, active: null };
  const ctx = createContext({
    urlList: expected, $busy: false, $eventReady: true, formats: {}, validSavePath: true, validCookieFile: true,
    downloadResultUnreliable: true, mode: "video", videoFmt: "mp4", audioFmt: "mp3", quality: "best",
    savePath: "/synthetic", browser: "none", cookieFile: "", bitrate: "192", stopping: false,
    downloadItems: { set: (items) => { state.items = items; }, update: (fn) => { state.updates++; state.items = fn(state.items); } },
    downloadMode: { set: () => {} }, busy: { set: (value) => { state.busy = value; } },
    activeOperation: { set: (value) => { state.active = value; } }, progress: { set: () => {} },
    api: { startDownload: async () => {
      state.items = state.items.map((item) => ({ ...item, status: "done" }));
      if (reject) throw new Error("synthetic transport error");
      return reply;
    } },
    isValidDownloadResult, operationOutcome, redactLog: (value) => value,
    toast: (key, kind) => state.toasts.push([key, kind]), tr: (key) => key,
  });
  Object.assign(ctx, {
    safeAiErrorText, // OpenAI-Codex_app_ui
    beginDownloadBatch: () => ({}), activateDownloadBatch: () => {}, setDownloadBatchPhase: () => {},
    isCurrentDownloadBatch: () => true, isIdleDownloadBatch: () => true,
  });
  runInContext(`${stripTypeScriptTypes(startFunction)}\nthis.startDownload = start;`, ctx);
  return { ctx, state };
}
for (const reply of [
  { results: [[expected[0], true, "synthetic error"]], summary: summary(1, 0, 2) },
  { results: [fail(expected[0]), done(expected[1]), done(expected[2])], summary: summary(3, 0, 0) },
  { results: sparseResults, summary: summary(3, 0, 0) },
  { results: [[expected[0], true]], summary: summary(1, 0, 2) },
]) {
  const { ctx, state } = harness(reply);
  const pending = ctx.startDownload();
  assert.equal(ctx.downloadResultUnreliable, false);
  await pending;
  assert.equal(ctx.downloadResultUnreliable, true);
  assert.equal(state.updates, 0);
  assert.deepEqual(state.toasts, [["operation_unknown", "err"]]);
  assert.equal(state.busy, false);
  assert.equal(state.active, null);
}
{
  const { ctx, state } = harness(null, true);
  await ctx.startDownload();
  assert.equal(ctx.downloadResultUnreliable, true);
  assert.equal(state.updates, 0);
  assert.equal(state.toasts.length, 1);
  assert.equal(state.toasts[0][1], "err");
  assert.match(state.toasts[0][0], /synthetic transport error/);
  assert.equal(state.busy, false);
}
for (const [reply, expectedToast, expectedStatuses] of [
  [{ results: expected.map(done), summary: summary(3, 0, 0) }, "operation_succeeded", ["done", "done", "done"]],
  [{ results: expected.map(fail), summary: summary(0, 3, 0) }, "operation_failed", ["error", "error", "error"]],
  [{ results: [[expected[0], false, ""], fail(expected[1]), fail(expected[2])], summary: summary(0, 3, 0) }, "operation_failed", ["error", "error", "error"]],
  [{ results: [done(expected[0]), fail(expected[1])], summary: summary(1, 1, 1) }, "operation_partial", ["done", "error", "skipped"]],
  [{ results: [done(expected[0]), done(expected[1])], summary: summary(2, 0, 1) }, "operation_partial", ["done", "done", "skipped"]],
  [{ results: [done(expected[0])], summary: summary(1, 0, 2, true) }, "operation_cancelled", ["done", "skipped", "skipped"]],
]) {
  const { ctx, state } = harness(reply);
  await ctx.startDownload();
  assert.equal(ctx.downloadResultUnreliable, false);
  assert.equal(state.toasts[0][0], expectedToast);
  assert.deepEqual(Array.from(state.items, (item) => item.status), expectedStatuses);
  assert.equal(state.busy, false);
}
console.log("Download result validation checks passed using synthetic values.");
