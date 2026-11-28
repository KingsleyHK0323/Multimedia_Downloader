// OpenAI-Codex_app_ui: synthetic conversion preview and stop error checks.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { PreviewGeneration, redactLog, safeAiErrorText } from "./operation.ts";

const source = readFileSync(new URL("../tabs/ConvertTab.svelte", import.meta.url), "utf8");
const preview = source.match(/async function previewConversion\(\) \{[\s\S]*?\n  \}(?=\n(?:\n)?  async function start)/)?.[0];
const stop = source.match(/async function stop\(\) \{[\s\S]*?\n  \}(?=\n\n  const inputCls)/)?.[0];
assert.ok(preview && stop, "the real conversion preview and stop handlers must exist");
let checks = 0;
function equal(actual, expected, message) { assert.deepEqual(actual, expected, message); checks++; }
function ok(value, message) { assert.ok(value, message); checks++; }
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const result = { jobs: [{
  src: "synthetic-input", dst: "synthetic-output", existing: "missing",
  batch_duplicate: false, source_matches: "no",
}] };
function harness({ previewCall = async () => result, stopCall = async () => ({ stopping: true }),
                   scrub = redactLog, failToast = false } = {}) {
  const generation = new PreviewGeneration();
  const state = { notices: [], busy: true };
  state.busy = false; // OpenAI-Codex_app_ui: preview begins with an idle store.
  const context = createContext({
    Error, String, Array,
    api: { previewConvert: previewCall, stop: stopCall },
    busy: { set: (value) => { state.busy = value; context.$busy = value; } }, // OpenAI-Codex_app_ui
    redactLog: scrub, safeAiErrorText,
    previewGeneration: generation, previewKey: "synthetic-key", previewing: false, preview: null,
    uploading: false, entries: [{ path: "synthetic-input" }], $busy: false,
    formats: {}, validSavePath: true, dstFmt: "mp4", savePath: "/synthetic",
    conflictPolicy: "rename", stopping: false, $activeOperation: "convert",
    tr: (key) => key,
    toast: (text, kind) => {
      state.notices.push({ text, kind });
      if (failToast && kind === "err") throw new Error("synthetic toast failure");
    },
  });
  runInContext(preview + "\n" + stop + "\nthis.previewConversion = previewConversion; this.stopConversion = stop;", context);
  return { context, generation, state };
}

{
  const h = harness();
  await h.context.previewConversion();
  equal(h.context.preview, result, "valid preview is retained");
  equal(h.context.previewing, false, "preview success clears loading");
  equal(h.state.notices, [], "preview success has no error notice");
}
{
  const h = harness();
  await h.context.stopConversion();
  equal(h.state.notices, [{ text: "stop_requested", kind: "info" }], "accepted stop reports only a request");
  equal(h.context.stopping, true, "accepted stop remains pending");
}
{
  const h = harness({ stopCall: async () => ({ stopping: false }) });
  await h.context.stopConversion();
  equal(h.state.notices, [{ text: "stop_not_active", kind: "info" }], "unaccepted stop is reported");
  equal(h.context.stopping, false, "unaccepted stop re-enables the control");
}
const hostileString = { toString() { throw new Error("synthetic formatting failure"); } };
const hostileMessage = new Error("synthetic");
Object.defineProperty(hostileMessage, "message", { get() { throw new Error("synthetic getter failure"); } });
const cases = [
  ["ordinary error", new Error("ordinary diagnostic"), redactLog, "ordinary diagnostic"],
  ["throwing string conversion", hostileString, redactLog, "[redacted]"],
  ["throwing message getter", hostileMessage, redactLog, "[redacted]"],
  ["throwing redactor", new Error("synthetic"), () => { throw new Error("synthetic redactor failure"); }, "[redacted]"],
  ["non-string redactor", new Error("synthetic"), () => null, "[redacted]"],
];
for (const operation of ["preview", "stop"]) {
  // OpenAI-Codex_app_ui: permit isolating stop failures during regression checks.
  if (process.argv.includes("--stop-only") && operation === "preview") continue;
  for (const [name, failure, scrub, expected] of cases) {
    const options = { scrub };
    options[operation === "preview" ? "previewCall" : "stopCall"] = async () => { throw failure; };
    const h = harness(options);
    if (operation === "stop") { h.state.busy = true; h.context.$busy = true; } // OpenAI-Codex_app_ui
    try {
      await h.context[operation === "preview" ? "previewConversion" : "stopConversion"]();
    } catch {
      assert.fail(operation + " " + name + " must show a safe error instead of throwing");
    }
    equal(h.state.notices, [{ text: (operation === "preview" ? "preview_failed " : "btn_stop web_job_error: ") + expected, kind: "err" }], operation + " " + name + " notice");
    equal(h.state.busy, operation === "preview" ? false : true, operation + " " + name + " retains synthetic busy");
    if (operation === "preview") {
      equal(h.context.previewing, false, name + " clears preview loading");
      equal(h.context.preview, null, name + " keeps preview empty");
    } else equal(h.context.stopping, false, name + " re-enables stop");
  }
  {
    const options = {};
    options[operation === "preview" ? "previewCall" : "stopCall"] = async () => {
      throw new Error("Authorization: Bearer SYNTHETIC_SECRET");
    };
    const h = harness(options);
    await h.context[operation === "preview" ? "previewConversion" : "stopConversion"]();
    equal(h.state.notices.length, 1, operation + " secret error appears once");
    ok(h.state.notices[0].text.includes("[redacted]"), operation + " reports redaction");
    ok(!h.state.notices[0].text.includes("SYNTHETIC_SECRET"), operation + " hides synthetic secret");
  }
  {
    const options = { failToast: true };
    options[operation === "preview" ? "previewCall" : "stopCall"] = async () => { throw new Error("ordinary diagnostic"); };
    const h = harness(options);
    await assert.rejects(h.context[operation === "preview" ? "previewConversion" : "stopConversion"](), /synthetic toast failure/);
    checks++;
    equal(h.state.notices.length, 1, operation + " error toast is not retried");
    if (operation === "preview") equal(h.context.previewing, false, "toast failure clears preview loading");
    else equal(h.context.stopping, false, "toast failure leaves stop enabled");
  }
}
// OpenAI-Codex_app_ui: preserve action context when translation or redaction fails.
for (const operation of ["preview", "stop"]) {
  if (process.argv.includes("--stop-only") && operation === "preview") continue;
  for (const translate of [
    () => "", () => "   ", () => null,
    () => { throw new Error("synthetic translation failure"); },
    (key) => key === "btn_stop" ? "Stop" : " ",
  ]) {
    const options = { scrub: () => { throw new Error("synthetic redactor failure"); } };
    options[operation === "preview" ? "previewCall" : "stopCall"] = async () => { throw hostileString; };
    const h = harness(options);
    h.context.tr = translate;
    await h.context[operation === "preview" ? "previewConversion" : "stopConversion"]();
    const label = operation === "preview" ? "Preview error " : "Stop error: ";
    equal(h.state.notices, [{ text: label + "[redacted]", kind: "err" }], operation + " fallback keeps action context");
    if (operation === "preview") equal(h.context.previewing, false, "fallback clears preview loading");
    else equal(h.context.stopping, false, "fallback re-enables stop");
  }
}
// OpenAI-Codex_app_ui: exercise bundled labels with synthetic failures.
for (const locale of ["en", "zh_tw", "zh_cn"]) {
  const translations = JSON.parse(readFileSync(new URL("../../../locales/" + locale + ".json", import.meta.url), "utf8"));
  for (const operation of ["preview", "stop"]) {
    if (process.argv.includes("--stop-only") && operation === "preview") continue;
    const options = {};
    options[operation === "preview" ? "previewCall" : "stopCall"] = async () => { throw hostileString; };
    const h = harness(options);
    h.context.tr = (key) => translations[key];
    await h.context[operation === "preview" ? "previewConversion" : "stopConversion"]();
    const label = operation === "preview" ? translations.preview_failed + " " :
      translations.btn_stop + " " + translations.web_job_error + ": ";
    ok(typeof label === "string" && label.trim().length > 0, locale + " has an action label");
    equal(h.state.notices, [{ text: label + "[redacted]", kind: "err" }], locale + " " + operation + " keeps its label");
  }
}
// OpenAI-Codex_app_ui: cover synchronous and thenable transport failures.
async function withinDeadline(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("synthetic deadline")), 5000); }),
    ]);
  } finally { clearTimeout(timer); }
}
const throwingThen = {};
Object.defineProperty(throwingThen, "then", { get() { throw new Error("synthetic then getter"); } });
for (const operation of ["preview", "stop"]) {
  if (process.argv.includes("--stop-only") && operation === "preview") continue;
  for (const [name, call, detail] of [
    ["sync", () => { throw new Error("synthetic sync"); }, "synthetic sync"],
    ["thenable", () => ({ then(_resolve, reject) { reject(new Error("synthetic thenable")); } }), "synthetic thenable"],
    ["getter", () => throwingThen, "synthetic then getter"],
  ]) {
    const options = {};
    options[operation === "preview" ? "previewCall" : "stopCall"] = call;
    const h = harness(options);
    await withinDeadline(h.context[operation === "preview" ? "previewConversion" : "stopConversion"]());
    const label = operation === "preview" ? "preview_failed " : "btn_stop web_job_error: ";
    equal(h.state.notices, [{ text: label + detail, kind: "err" }], operation + " " + name + " reports error");
    if (operation === "preview") equal(h.context.previewing, false, "transport failure clears preview loading");
    else equal(h.context.stopping, false, "transport failure re-enables stop");
  }
}
// OpenAI-Codex_app_ui: invalid preview results must not repeat the same label.
if (!process.argv.includes("--stop-only")) {
  for (const locale of ["en", "zh_tw", "zh_cn"]) {
    const translations = JSON.parse(readFileSync(new URL("../../../locales/" + locale + ".json", import.meta.url), "utf8"));
    const h = harness({ previewCall: async () => ({ jobs: [] }) });
    h.context.tr = (key) => translations[key];
    await h.context.previewConversion();
    equal(h.state.notices, [{ text: translations.preview_failed, kind: "err" }], locale + " invalid preview is not repeated");
    equal(h.context.previewing, false, locale + " invalid preview clears loading");
  }
}
for (const invalidation of ["generation", "key"]) {
  const pending = deferred();
  const h = harness({ previewCall: () => pending.promise });
  const translationCalls = []; h.context.tr = (key) => { translationCalls.push(key); return key; }; // OpenAI-Codex_app_ui
  const work = h.context.previewConversion();
  if (invalidation === "generation") h.generation.invalidate();
  else h.context.previewKey = "new-key";
  pending.reject(hostileString);
  await work;
  equal(h.state.notices, [], invalidation + " stale preview shows no error");
  equal(translationCalls, [], invalidation + " stale preview does not translate"); // OpenAI-Codex_app_ui
  equal(h.context.previewing, false, invalidation + " stale preview clears loading");
}
console.log("Conversion preview and stop error presentation: " + checks + " synthetic checks passed.");
