// OpenAI-Codex: execute the current TypeScript handlers across line endings.
import { stripTypeScriptTypes } from "node:module";
// OpenAI-Codex_app_ui: exercise download error presentation with synthetic transport failures.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { isValidDownloadResult } from "./downloadResult.ts";
import { operationOutcome, redactLog, safeAiErrorText } from "./operation.ts";

const source = readFileSync(new URL("../tabs/DownloadTab.svelte", import.meta.url), "utf8");
const start = source.match(/async function start\(\) \{[\s\S]*?\r?\n  \}(?=\s*async function stop)/)?.[0];
const stop = source.match(/async function stop\(\) \{[\s\S]*?\r?\n  \}(?=\s*\/\/|\s*const inputCls)/)?.[0];
assert.ok(start && stop, "the real download handlers must exist");

let checks = 0;
function equal(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks++;
}
function ok(value, message) {
  assert.ok(value, message);
  checks++;
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const success = {
  results: [["synthetic-input", true, ""]],
  summary: { total: 1, succeeded: 1, failed: 0, skipped: 0, cancelled: false },
};
function harness({ startCall = async () => success, stopCall = async () => ({ stopping: true }),
                   scrub = redactLog, failToast = false } = {}) {
  const token = {};
  const state = { items: [], busy: false, active: null, phase: "", current: true, notices: [] };
  const context = createContext({
    Error, String,
    urlList: ["synthetic-input"], $busy: false, $eventReady: true, formats: {},
    validSavePath: true, validCookieFile: true, $activeOperation: "download", $downloadItems: [],
    mode: "video", videoFmt: "mp4", audioFmt: "mp3", quality: "best",
    savePath: "/synthetic", browser: "none", cookieFile: "", bitrate: "192",
    downloadResultUnreliable: false, stopping: false,
    api: { startDownload: startCall, stop: stopCall },
    isValidDownloadResult, operationOutcome, redactLog: scrub, safeAiErrorText,
    beginDownloadBatch: () => token, activateDownloadBatch: () => {},
    setDownloadBatchPhase: (_token, phase) => { state.phase = phase; },
    isCurrentDownloadBatch: (candidate) => state.current && candidate === token,
    isIdleDownloadBatch: () => true, downloadBatchToken: () => token,
    downloadItems: {
      set: (items) => { state.items = items; },
      update: (fn) => { state.items = fn(state.items); },
    },
    downloadMode: { set: () => {} }, progress: { set: () => {} },
    busy: { set: (value) => { state.busy = value; } },
    activeOperation: { set: (value) => { state.active = value; } },
    tr: (key) => key,
    toast: (text, kind) => {
      state.notices.push({ text, kind });
      if (failToast && kind === "err") throw new Error("synthetic toast failure");
    },
  });
  runInContext(stripTypeScriptTypes(start) + "\n" + stop + "\nthis.startDownload = start; this.stopDownload = stop;", context);
  return { context, state };
}

{
  const h = harness();
  await h.context.startDownload();
  equal(h.state.notices, [{ text: "operation_succeeded", kind: "ok" }], "valid success remains success");
  equal(h.state.busy, false, "successful start clears busy");
  equal(h.state.active, null, "successful start clears active operation");
}
{
  const h = harness({ stopCall: async () => ({ stopping: true }) });
  await h.context.stopDownload();
  equal(h.state.notices, [{ text: "stop_requested", kind: "info" }], "successful stop reports request");
  equal(h.context.stopping, true, "accepted stop remains pending");
}
{
  const h = harness({ stopCall: async () => ({ stopping: false }) });
  await h.context.stopDownload();
  equal(h.state.notices, [{ text: "stop_not_active", kind: "info" }], "unaccepted stop is reported");
  equal(h.context.stopping, false, "unaccepted stop re-enables the button");
}

const hostileString = { toString() { throw new Error("synthetic formatting failure"); } };
const hostileMessage = new Error("synthetic");
Object.defineProperty(hostileMessage, "message", { get() { throw new Error("synthetic message getter failure"); } });
const cases = [
  ["ordinary error", new Error("ordinary diagnostic"), redactLog, "ordinary diagnostic"],
  ["throwing string conversion", hostileString, redactLog, "[redacted]"],
  ["throwing message getter", hostileMessage, redactLog, "[redacted]"],
  ["throwing redactor", new Error("synthetic"), () => { throw new Error("synthetic redactor failure"); }, "[redacted]"],
  ["non-string redactor", new Error("synthetic"), () => null, "[redacted]"],
];
for (const operation of ["start", "stop"]) {
  for (const [name, failure, scrub, expected] of cases) {
    const options = { scrub };
    options[operation === "start" ? "startCall" : "stopCall"] = async () => { throw failure; };
    const h = harness(options);
    try {
      await h.context[operation === "start" ? "startDownload" : "stopDownload"]();
    } catch {
      assert.fail(operation + " " + name + " must show a safe error instead of throwing");
    }
    // OpenAI-Codex_web_ai: stop errors retain context if detail formatting fails.
    equal(h.state.notices, [{ text: (operation === "stop" ? "btn_stop web_job_error: " : "") + expected, kind: "err" }], operation + " " + name + " notice");
    if (operation === "start") {
      equal(h.state.phase, "unknown", name + " start preserves unknown result");
      equal(h.context.downloadResultUnreliable, true, name + " start hides unconfirmed results");
      equal(h.state.busy, false, name + " start clears busy");
      equal(h.state.active, null, name + " start clears active operation");
    } else {
      equal(h.context.stopping, false, name + " stop re-enables the button");
    }
  }
  {
    const options = {};
    options[operation === "start" ? "startCall" : "stopCall"] = async () => {
      throw new Error("Authorization: Bearer SYNTHETIC_SECRET");
    };
    const h = harness(options);
    await h.context[operation === "start" ? "startDownload" : "stopDownload"]();
    equal(h.state.notices.length, 1, operation + " secret error shown once");
    ok(h.state.notices[0].text.includes("[redacted]"), operation + " contains redaction");
    ok(!h.state.notices[0].text.includes("SYNTHETIC_SECRET"), operation + " hides synthetic secret");
  }
  {
    const options = { failToast: true };
    options[operation === "start" ? "startCall" : "stopCall"] = async () => { throw new Error("ordinary diagnostic"); };
    const h = harness(options);
    await assert.rejects(h.context[operation === "start" ? "startDownload" : "stopDownload"](), /synthetic toast failure/);
    checks++;
    equal(h.state.notices.length, 1, operation + " failing toast is not retried");
    if (operation === "start") equal(h.state.busy, false, "toast failure still clears busy");
    else equal(h.context.stopping, false, "toast failure leaves stop enabled");
  }
}
{
  const pending = deferred();
  const h = harness({ stopCall: () => pending.promise });
  const stopping = h.context.stopDownload();
  h.state.current = false;
  pending.reject(hostileString);
  await stopping;
  equal(h.state.notices.length, 0, "a stale stop error does not display for another batch");
}
// OpenAI-Codex_web_ai: preserve current busy state across diverse stop failures.
async function withStopDeadline(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("synthetic timeout")), 5000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const stopGetterFailure = {};
Object.defineProperty(stopGetterFailure, "then", { get() { throw new Error("synthetic getter"); } });
for (const [name, stopCall, detail] of [
  ["sync throw", () => { throw new Error("synthetic sync"); }, "synthetic sync"],
  ["thenable rejection", () => ({ then(_resolve, reject) { reject(new Error("synthetic thenable")); } }), "synthetic thenable"],
  ["then getter", () => stopGetterFailure, "synthetic getter"],
]) {
  const h = harness({ stopCall });
  h.state.busy = true;
  await withStopDeadline(h.context.stopDownload());
  equal(h.state.notices, [{ text: "btn_stop web_job_error: " + detail, kind: "err" }], name + " notice");
  equal(h.state.busy, true, name + " preserves busy");
  equal(h.context.stopping, false, name + " re-enables stop");
}
for (const badTranslation of [
  () => "", () => "   ", () => null,
  () => { throw new Error("synthetic translation failure"); },
  (key) => key === "btn_stop" ? "Stop" : " ",
]) {
  const h = harness({
    stopCall: () => { throw new Error("synthetic sync"); },
    scrub: () => { throw new Error("synthetic redaction failure"); },
  });
  h.state.busy = true;
  h.context.tr = badTranslation;
  await withStopDeadline(h.context.stopDownload());
  equal(h.state.notices, [{ text: "Stop error: [redacted]", kind: "err" }], "fallback keeps context");
  equal(h.state.busy, true, "fallback preserves busy");
}
console.log("Download error presentation: " + checks + " synthetic checks passed.");
