// OpenAI-Codex_app_ui: synthetic checks for AI preview and stop error presentation.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { safeAiErrorText, redactLog } from "./operation.ts";

export async function runPreviewStopChecks({ source: overrideSource, allowAbsent = false } = {}) {
  const source = overrideSource === undefined
    ? readFileSync(new URL("../ai/AiPanel.svelte", import.meta.url), "utf8")
    : overrideSource;
  assert.equal(typeof source, "string", "panel source must be a string");
  const hasPreview = source.includes("  async function previewQueueConversions(");
  const hasStop = source.includes("  async function stopQueue(");
  if (!hasPreview || !hasStop) {
    if (allowAbsent && !hasPreview && !hasStop) return { skipped: true, checks: 0 };
    throw Error("Both preview and stop call sites are required.");
  }
  function extract(name) {
    const marker = "  async function " + name + "(";
    const start = source.indexOf(marker), end = source.indexOf("\n  }", start);
    assert.ok(start >= 0 && end > start, name + " must exist");
    return stripTypeScriptTypes(source.slice(start, end + 4), { mode: "strip" });
  }
  const preview = extract("previewQueueConversions"), stop = extract("stopQueue");
  function harness(scrub, config = {}) {
    const body = [
      'let phase="review",plan={tasks:[{kind:"convert",task_id:"synthetic",src_path:"/synthetic",dst_path:"/synthetic"}]};',
      'let hasConvertTasks=true,queuePreviewInputs=[{}],queuePreviewing=false,$busy=false,planPathsValid=true,queuePreviewKey="same",queuePreview=null,disposed=false;',
      'let stopping=false,queueStarted=true,$activeOperation="ai-queue",invalidations=0;const messages=[];',
      'const tr=(key)=>key;',
      'function toast(value,kind){messages.push({value,kind});if(config.toastFailure)throw Error("synthetic toast failure");}',
      'function invalidateQueuePreview(){invalidations++;queuePreview=null;queuePreviewing=false;}',
      'const api={previewQueue:()=>{throw Error("must stay fake");},stop:async()=>{if(config.stopError)throw config.stopError;return config.stopResult??{stopping:true};}};',
      'const queuePreviewSession={request:async()=>config.previewResult??{kind:"error",error:config.previewError,generation:1},isCurrent:()=>true};',
      preview, stop,
      'return {previewQueueConversions,stopQueue,state:()=>({phase,queuePreviewing,queuePreview,stopping,messages,invalidations})};',
    ].join("\n");
    return new Function("redactLog", "safeAiErrorText", "config", body)(scrub, safeAiErrorText, config);
  }
  let checks = 0;
  function equal(actual, expected, message) { assert.deepEqual(actual, expected, message); checks++; }
  function ok(value, message) { assert.ok(value, message); checks++; }
  for (const method of ["previewQueueConversions", "stopQueue"]) {
    const key = method === "previewQueueConversions" ? "previewError" : "stopError";
    const raw = Error("Authorization: Basic SYNTHETIC_SECRET");
    const cases = [
      ["error", raw, redactLog, undefined, "SYNTHETIC_SECRET"],
      ["string", "password=SYNTHETIC_PASSWORD", redactLog, undefined, "SYNTHETIC_PASSWORD"],
      ["toString throws", { toString() { throw Error("synthetic conversion"); } }, redactLog, "[redacted]"],
      ["redactor throws", raw, () => { throw Error("synthetic redaction"); }, "[redacted]"],
      ["redactor null", raw, () => null, "[redacted]"],
      ["redactor object", raw, () => ({}), "[redacted]"],
      ["ordinary", Error("ordinary diagnostic"), redactLog, "ordinary diagnostic"],
    ];
    for (const [name, failure, scrub, expected, secret] of cases) {
      const h = harness(scrub, { [key]: failure });
      await h[method]();
      const state = h.state();
      equal(state.messages.length, 1, method + " " + name + " one toast");
      equal(state.messages[0].kind, "err", method + " " + name + " kind");
      if (secret) ok(!state.messages[0].value.includes(secret), method + " " + name + " redaction");
      else equal(state.messages[0].value, expected, method + " " + name + " fallback");
      if (method === "previewQueueConversions") equal(state.queuePreviewing, false, method + " loading");
      else equal(state.stopping, false, method + " stopping");
    }
    const failingToast = harness(redactLog, { [key]: raw, toastFailure: true });
    await assert.rejects(failingToast[method](), /synthetic toast failure/); checks++;
    equal(failingToast.state().messages.length, 1, method + " error toast is not retried");
    if (method === "previewQueueConversions") equal(failingToast.state().queuePreviewing, false, method + " failing toast loading");
    else equal(failingToast.state().stopping, false, method + " failing toast stopping");
  }
  let h = harness(redactLog, { previewResult: { kind: "ready", generation: 1, value: { jobs: ["synthetic"] } } });
  await h.previewQueueConversions();
  equal(h.state().queuePreview, { jobs: ["synthetic"] }, "preview success value");
  equal(h.state().queuePreviewing, false, "preview success flag");
  equal(h.state().messages.length, 0, "preview success no toast");
  h = harness(redactLog, { previewResult: { kind: "invalid", generation: 1 } });
  await h.previewQueueConversions();
  equal(h.state().messages, [{ value: "preview_failed", kind: "err" }], "invalid preview toast");
  equal(h.state().queuePreviewing, false, "invalid preview flag");
  for (const [stopping, wantFlag, wantToast] of [[true, true, "stop_requested"], [false, false, "stop_not_active"]]) {
    h = harness(redactLog, { stopResult: { stopping } });
    await h.stopQueue();
    equal(h.state().stopping, wantFlag, "stop success state");
    equal(h.state().messages, [{ value: wantToast, kind: "info" }], "stop success toast");
  }
  h = harness(redactLog, { stopResult: { stopping: true }, toastFailure: true });
  await assert.rejects(h.stopQueue(), /synthetic toast failure/); checks++;
  equal(h.state().messages.length, 2, "existing success toast retry remains");
  equal(h.state().stopping, false, "existing success toast failure clears stop flag");
  return { skipped: false, checks };
}

if (import.meta.url.startsWith("file:") && process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const result = await runPreviewStopChecks({ allowAbsent: process.argv.slice(2).includes("--allow-absent") });
  console.log(result.skipped ? "SKIPPED: preview/stop not present" : "AI preview and stop: " + result.checks + " synthetic checks passed.");
}
