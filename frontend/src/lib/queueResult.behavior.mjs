// OpenAI-Codex_engine_cli: exercise AI queue result handling with in-memory transports.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { operationOutcome, reconcileTaskStatuses, redactLog } from "./operation.ts";

let isValidQueueResult = () => { throw new Error("queue result guard is missing"); };
if (existsSync(new URL("./queueResult.ts", import.meta.url))) {
  ({ isValidQueueResult } = await import("./queueResult.ts"));
}
const source = readFileSync(new URL("../ai/AiPanel.svelte", import.meta.url), "utf8");
const start = source.indexOf("  async function confirmAndRun() {");
const end = source.indexOf("  async function stopQueue()", start);
assert.ok(start >= 0 && end > start);
const runCode = stripTypeScriptTypes(source.slice(start, end), { mode: "strip" });
const markStart = source.indexOf("  function markQueueResultUnreliable(");
const markEnd = markStart < 0 ? -1 : source.indexOf("\n  }", markStart);
const markCode = markStart < 0 ? "" : stripTypeScriptTypes(source.slice(markStart, markEnd + 4), { mode: "strip" });
const exercise = new Function("api", "operationOutcome", "reconcileTaskStatuses", "redactLog", "isValidQueueResult", "tasks", `
  let plan = { tasks }, phase = "review", taskStatus = {one:"pending"};
  let taskResults = {one:{task_id:"one",status:"done",error:""}}, errorText = "";
  let stopping = false, queueStarted = false, queueResultsUnreliable = false;
  let disposed = false, activeUnlisten, $busy = false, $eventReady = true, planPathsValid = true;
  const messages = [], busy = {set(){}}, activeOperation = {set(){}}, tr = (key) => key;
  const toast = (text, kind) => messages.push({text,kind});
  const invalidateQueuePreview = () => {}, clearSubscription = () => {};
  ${markCode}
  ${runCode}
  return (async () => { await confirmAndRun(); return { phase, taskStatus, taskResults, errorText, messages, queueResultsUnreliable }; })();
`);
const tasks = [{task_id:"one",kind:"convert",label:"a",src_path:"/a.mkv",dst_path:"/a.mp4"}];
const summary = {total:1,succeeded:1,failed:0,skipped:0,cancelled:false};
const done = {task_id:"one",kind:"convert",label:"a",status:"done",error:"",dst_path:"/a.mp4"};
async function present(result, options = {}) {
  let event;
  const api = {
    onEvent: async (callback) => { event = callback; return () => {}; },
    runQueue: async () => {
      event({type:"task_update",task_id:"one",status:"done"});
      if (options.throws) throw new Error("result lost");
      return result;
    },
  };
  return exercise(api, operationOutcome, reconcileTaskStatuses, redactLog, isValidQueueResult, options.tasks ?? tasks);
}

for (const result of [
  {tasks:[{...done,status:"error",error:"failed"}],summary},
  {tasks:[{...done,status:"skipped"}],summary},
  {tasks:[{...done,status:"running"}],summary},
  {tasks:[{...done,error:"unexpected"}],summary},
  {tasks:[{...done,kind:"download"}],summary},
  {tasks:[{...done,task_id:"other"}],summary},
  {tasks:[null],summary},
  {tasks:[],summary},
  undefined,
]) {
  const actual = await present(result);
  assert.equal(actual.phase, "done");
  assert.equal(actual.queueResultsUnreliable, true);
  assert.equal(actual.taskStatus.one, "unknown");
  assert.deepEqual(actual.taskResults, {});
  assert.ok(!actual.messages.some((item) => item.text === "operation_succeeded"));
}
const lost = await present(null, {throws:true});
assert.equal(lost.phase, "done");
assert.equal(lost.queueResultsUnreliable, true);
assert.equal(lost.taskStatus.one, "unknown");
assert.deepEqual(lost.taskResults, {});

for (const [task, sum, outcome] of [
  [done, summary, "operation_succeeded"],
  [{...done,status:"error",error:"failed"}, {...summary,succeeded:0,failed:1}, "operation_failed"],
  [{...done,status:"skipped"}, {...summary,succeeded:0,skipped:1,cancelled:true}, "operation_cancelled"],
]) {
  const actual = await present({tasks:[task],summary:sum});
  assert.equal(actual.queueResultsUnreliable, false);
  assert.equal(actual.taskStatus.one, task.status);
  assert.deepEqual(actual.taskResults.one, task);
  assert.equal(actual.messages.at(-1).text, outcome);
}

const mixedTasks = [
  {task_id:"one",kind:"download",label:"download",url:"https://example.invalid",options:{save_path:"/out"}},
  {task_id:"two",kind:"convert",label:"convert",src_path:"/a.mkv",dst_path:"/a.mp4"},
];
const mixed = {tasks:[
  {task_id:"two",kind:"convert",label:"convert",status:"done",error:"",dst_path:"/a.mp4"},
  {task_id:"one",kind:"download",label:"download",status:"skipped",error:"",dst_path:null},
], summary:{total:2,succeeded:1,failed:0,skipped:1,cancelled:true}};
const mixedResult = await present(mixed, {tasks:mixedTasks});
assert.equal(mixedResult.queueResultsUnreliable, false);
assert.deepEqual(mixedResult.taskStatus, {one:"skipped",two:"done"});
assert.equal(mixedResult.messages.at(-1).text, "operation_cancelled");
const duplicate = {...mixed,tasks:[mixed.tasks[0],mixed.tasks[0]]};
const duplicateResult = await present(duplicate, {tasks:mixedTasks});
assert.equal(duplicateResult.queueResultsUnreliable, true);
assert.deepEqual(duplicateResult.taskStatus, {one:"unknown",two:"unknown"});
assert.deepEqual(duplicateResult.taskResults, {});

// A callback already queued before unsubscribe cannot restore an untrusted event status.
const eventStart = source.indexOf("      const off = await api.onEvent((e: EngineEvent) => {");
const eventEnd = source.indexOf("      });", eventStart);
assert.ok(eventStart >= 0 && eventEnd > eventStart);
const eventBody = source.slice(eventStart + "      const off = await api.onEvent((e: EngineEvent) => {".length, eventEnd);
const handleEvent = new Function("e", "queueResultsUnreliable", `
  let taskStatus = {one:"unknown"};
  (() => { ${eventBody} })();
  return taskStatus;
`);
const doneEvent = {type:"task_update",task_id:"one",status:"done"};
assert.deepEqual(handleEvent(doneEvent, true), {one:"unknown"});
assert.deepEqual(handleEvent(doneEvent, false), {one:"done"});
console.log("AI queue result presentation contract passed.");
