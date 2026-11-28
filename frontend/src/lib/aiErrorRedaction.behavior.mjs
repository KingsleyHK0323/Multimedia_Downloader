// OpenAI-Codex_app_ui: synthetic checks for AI panel error presentation.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function runAiErrorChecks(overrideSource) {
  const source = overrideSource === undefined
    ? readFileSync(new URL("../ai/AiPanel.svelte", import.meta.url), "utf8")
    : overrideSource;
  assert.equal(typeof source, "string", "panel source must be a string");
  function extract(name, isAsync) {
    const marker = "  " + (isAsync ? "async " : "") + "function " + name + "(";
    const start = source.indexOf(marker);
    const end = source.indexOf("\n  }", start);
    assert.ok(start >= 0 && end > start, name + " must exist");
    return stripTypeScriptTypes(source.slice(start, end + 4), { mode: "strip" });
  }
  const mark = source.includes("function markQueueResultUnreliable(")
    ? extract("markQueueResultUnreliable", false)
    : "function markQueueResultUnreliable() {}";
  const getPlan = extract("getPlan", true);
  const confirmAndRun = extract("confirmAndRun", true);
  let checks = 0;
  function equal(actual, expected, message) { assert.deepEqual(actual, expected, message); checks++; }
  function ok(value, message) { assert.ok(value, message); checks++; }
  function harness(scrub, failures = {}, failToast = false) {
    const body = [
      'let IS_MOCK=false, apiKey="synthetic-key", prompt="synthetic", defaultSavePath="/synthetic", phase="review", errorText="", showSettings=false;',
      'let plan={tasks:[{task_id:"one",kind:"download",label:"synthetic",url:"synthetic",options:{save_path:"/synthetic"}}]}, taskStatus={}, taskResults={};',
      'let $busy=false, $eventReady=true, planPathsValid=true, disposed=false, stopping=false, queueStarted=false, queueResultsUnreliable=false, activeUnlisten, nextPlan=0;',
      'let busyValue=false, activeValue=null, unsubs=0; const messages=[];',
      'const busy={set:(v)=>{busyValue=v;}}, activeOperation={set:(v)=>{activeValue=v;}};',
      'const tr=(key)=>key, toast=(value,kind)=>{messages.push({value,kind}); if(failToast && value==="ordinary diagnostic") throw Error("synthetic toast failure");};',
      'const invalidateQueuePreview=()=>{}, clearSubscription=()=>{const off=activeUnlisten;activeUnlisten=undefined;off?.();};',
      'const api={aiPlan:async()=>{if(failures.plan)throw failures.plan;return {tasks:[{kind:"download",label:"synthetic",url:"synthetic",options:{save_path:"/synthetic"}}]};},',
      'onEvent:()=>()=>{unsubs++;},runQueue:async()=>{if(failures.queue)throw failures.queue;return {tasks:[{task_id:"one",kind:"download",label:"synthetic",status:"done",error:""}],summary:{total:1,succeeded:1,failed:0,skipped:0,cancelled:false}};}};',
      mark, getPlan, confirmAndRun,
      'return {getPlan,confirmAndRun,state:()=>({phase,errorText,messages,busyValue,activeValue,unsubs})};',
    ].join("\n");
    const factory = new Function("redactLog", "failures", "failToast", "operationOutcome", "reconcileTaskStatuses", "isValidQueueResult", body);
    return factory(scrub, failures, failToast, () => "succeeded", () => ({ one: "done" }), () => true);
  }
  const fakeRedactor = (value) => value.replace(/SYNTHETIC_SECRET/g, "[redacted]");
  for (const method of ["getPlan", "confirmAndRun"]) {
    let task = harness(fakeRedactor);
    await task[method]();
    equal(task.state().phase, method === "getPlan" ? "review" : "done", method + " success phase");
    equal(task.state().busyValue, false, method + " success busy");
    equal(task.state().activeValue, null, method + " success active");
    if (method === "confirmAndRun") equal(task.state().unsubs, 1, "success unsubscribe");

    const badString = { toString() { throw new Error("synthetic string failure"); } };
    const badMessage = new Error("synthetic");
    Object.defineProperty(badMessage, "message", { get() { throw new Error("synthetic message failure"); } });
    const cases = [
      ["error object", new Error("Authorization: SYNTHETIC_SECRET"), fakeRedactor, "Authorization: [redacted]"],
      ["string error", "password=SYNTHETIC_SECRET", fakeRedactor, "password=[redacted]"],
      ["string conversion failure", badString, fakeRedactor, "[redacted]"],
      ["message getter failure", badMessage, fakeRedactor, "[redacted]"],
      ["redactor failure", new Error("synthetic"), () => { throw new Error("synthetic redaction failure"); }, "[redacted]"],
      ["redactor returned null", new Error("synthetic"), () => null, "[redacted]"],
      ["redactor returned object", new Error("synthetic"), () => ({}), "[redacted]"],
      ["ordinary error", new Error("ordinary diagnostic"), fakeRedactor, "ordinary diagnostic"],
    ];
    for (const [name, failure, scrub, expected] of cases) {
      const failures = method === "getPlan" ? { plan: failure } : { queue: failure };
      task = harness(scrub, failures);
      await task[method]();
      const state = task.state();
      equal(state.errorText, expected, method + " " + name + " message");
      equal(state.phase, method === "getPlan" ? "error" : "done", method + " " + name + " phase");
      equal(state.busyValue, false, method + " " + name + " busy");
      equal(state.activeValue, null, method + " " + name + " active");
      if (method === "confirmAndRun") {
        equal(state.unsubs, 1, method + " " + name + " unsubscribe");
        equal(state.messages.at(-1), { value: expected, kind: "err" }, method + " " + name + " toast");
      }
    }
  }

  const failedToast = harness(fakeRedactor, { queue: new Error("ordinary diagnostic") }, true);
  await assert.rejects(failedToast.confirmAndRun(), /synthetic toast failure/);
  checks++;
  const state = failedToast.state();
  equal(state.messages.filter((message) => message.value === "ordinary diagnostic").length, 1, "toast is not retried");
  equal(state.phase, "done", "toast failure retains finally phase");
  equal(state.busyValue, false, "toast failure clears busy");
  equal(state.activeValue, null, "toast failure clears active operation");
  equal(state.unsubs, 1, "toast failure unsubscribes");
  ok(!state.messages.some((message) => String(message.value).includes("SYNTHETIC_SECRET")), "toast has no synthetic secret");
  return checks;
}

if (import.meta.url.startsWith("file:") && process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const checks = await runAiErrorChecks();
  console.log("AI error presentation: " + checks + " synthetic checks passed.");
}
