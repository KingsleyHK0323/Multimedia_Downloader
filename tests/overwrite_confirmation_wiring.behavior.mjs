// OpenAI-Codex_app_ui: fake UI/transport checks and static cross-language wiring checks.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const between = (text, first, last) => {
  const begin = text.indexOf(first);
  const end = text.indexOf(last, begin + first.length);
  assert.ok(begin >= 0 && end > begin, "missing source boundaries: " + first);
  return text.slice(begin, end);
};
const args = process.argv.slice(2);
const selected = (name) => args.length === 0 || args.includes("--" + name + "-only");
let checks = 0;
function equal(actual, expected, message) { assert.deepEqual(actual, expected, message); checks++; }
function ok(value, message) { assert.ok(value, message); checks++; }

if (selected("ui")) {
  const conversion = read("frontend/src/tabs/ConvertTab.svelte");
  const ai = read("frontend/src/ai/AiPanel.svelte");
  const api = read("frontend/src/api.ts");
  const convertCode = stripTypeScriptTypes(between(conversion, "  async function start() {", "  async function stop() {"), { mode: "strip" });
  const queueCode = stripTypeScriptTypes(between(ai, "  async function confirmAndRun() {", "  async function stopQueue() {"), { mode: "strip" });

  function convertHarness(input) {
    const factory = new Function("input", [
      'let uploading=false,entries=[{path:"synthetic-input"}],$busy=false,$eventReady=true,formats={},validSavePath=true;',
      'let conflictPolicy=input.policy,dstFmt="mp4",savePath="synthetic",stopping=false,jobs=[],conversionResultUnreliable=false,conversionError="";',
      'let confirms=0;const calls=[];',
      'const window={confirm(){confirms++;return input.accept;}},tr=(key)=>key,toast=()=>{};',
      'const busy={set(v){$busy=v;}},activeOperation={set(){}},IS_WEB=false;',
      'const api={async startConvert(a){calls.push(a);return null;}};',
      'const isValidConversionResult=()=>false,operationOutcome=()=>"unknown",safeAiErrorText=(fn)=>fn(),redactLog=String;',
      'function invalidatePreview(){}',
      convertCode,
      'return {start,result:()=>({calls,confirms,busy:$busy})};',
    ].join("\n"));
    return factory(input);
  }

  for (const [policy, accept, requests, confirms] of [
    ["rename", false, 1, 0], ["skip", false, 1, 0],
    ["overwrite", false, 0, 1], ["overwrite", true, 1, 1],
  ]) {
    const h = convertHarness({policy, accept});
    await h.start();
    const result = h.result();
    equal(result.calls.length, requests, policy + " request count");
    equal(result.confirms, confirms, policy + " confirmation count");
    equal(result.busy, false, policy + " busy is cleared");
    if (requests) {
      equal(result.calls[0].conflict_policy, policy, policy + " policy preserved");
      equal(Object.hasOwn(result.calls[0], "overwrite_confirmed"), policy === "overwrite", policy + " confirmation presence");
      if (policy === "overwrite") equal(result.calls[0].overwrite_confirmed, true, "confirmed conversion transmits true");
    }
  }

  function queueHarness(input) {
    const factory = new Function("input", [
      'let plan={tasks:input.tasks},$busy=false,$eventReady=true,planPathsValid=true;',
      'let queueResultsUnreliable=false,phase="review",stopping=false,queueStarted=false,disposed=false,activeUnlisten;',
      'let taskStatus={},taskResults={},errorText="",confirms=0; const calls=[];',
      'const window={confirm(){confirms++;return input.accept;}},tr=(key)=>key,toast=()=>{},redactLog=String;',
      'const busy={set(v){$busy=v;}},activeOperation={set(){}};',
      'const api={async onEvent(){return ()=>{};},async runQueue(tasks,confirmed){calls.push({tasks,confirmed});return null;}};',
      'function invalidateQueuePreview(){} function clearSubscription(){} function markQueueResultUnreliable(){}',
      'const isValidQueueResult=()=>false,operationOutcome=()=>"unknown",reconcileTaskStatuses=()=>({});',
      queueCode,
      'return {run:confirmAndRun,result:()=>({calls,confirms,busy:$busy})};',
    ].join("\n"));
    return factory(input);
  }
  const download = {kind:"download",task_id:"download",url:"synthetic-url"};
  for (const [policy, accept, requests, confirms] of [
    ["rename", false, 1, 0], ["skip", false, 1, 0],
    ["overwrite", false, 0, 1], ["overwrite", true, 1, 1],
  ]) {
    const tasks = [download,{kind:"convert",task_id:"convert",conflict_policy:policy}];
    const h = queueHarness({tasks,accept});
    await h.run();
    const result = h.result();
    equal(result.calls.length, requests, "queue " + policy + " request count");
    equal(result.confirms, confirms, "queue " + policy + " confirmation count");
    equal(result.busy, false, "queue " + policy + " busy is cleared");
    if (requests) {
      equal(result.calls[0].tasks, tasks, "queue tasks preserved");
      equal(result.calls[0].confirmed, policy === "overwrite", "queue confirmation boolean");
    }
  }

  for (const [name, classBegin, classEnd, method] of [
    ["desktop", "class TauriApi", "class WebApi", "invoke"],
    ["web", "class WebApi", "class MockApi", "post"],
  ]) {
    const source = between(api, classBegin, classEnd);
    const start = between(source, "  startConvert(", "  previewConvert(");
    const run = between(source, "  runQueue(", "  stop(");
    const code = stripTypeScriptTypes("class Probe {\n" + start + run + "\n}", { mode: "strip" });
    const Probe = new Function(code + "\nreturn Probe;")();
    const probe = new Probe();
    const calls = [];
    probe[method] = (...value) => calls.push(value);
    const convert = {files:["synthetic"],conflict_policy:"overwrite",overwrite_confirmed:true,operation_id:"synthetic-id"};
    probe.startConvert(convert);
    const forwardedConvert = name === "desktop" ? calls.at(-1)[1].args : calls.at(-1)[1];
    equal(forwardedConvert, convert, name + " conversion payload preserved");
    for (const confirmed of [false,true]) {
      const tasks = [{kind:"convert",conflict_policy:confirmed ? "overwrite" : "rename"}];
      probe.runQueue(tasks, confirmed, "synthetic-id");
      const payload = name === "desktop" ? calls.at(-1)[1].args : calls.at(-1)[1];
      equal(payload.tasks, tasks, name + " queue tasks preserved");
      equal(payload.operation_id, "synthetic-id", name + " queue operation ID preserved");
      equal(Object.hasOwn(payload, "overwrite_confirmed"), confirmed, name + " queue flag presence");
      if (confirmed) equal(payload.overwrite_confirmed, true, name + " queue flag is boolean true");
    }
  }
  console.log("Fake UI and transport: " + checks + " checks passed.");
}

if (selected("web")) {
  const web = read("web_app.py");
  const convert = between(web, "def api_convert():", '@app.post("/api/preview_convert")');
  const queue = between(web, "def api_run_queue():", '@app.post("/api/ai_plan")');
  const preview = between(web, "def api_preview_convert():", '@app.post("/api/run_queue")');
  const forwarding = /\*\*\(\{"overwrite_confirmed": True\} if a\.get\("overwrite_confirmed"\) is True else \{\}\)/;
  ok(/_policy\(a\.get\("conflict_policy"\), a\.get\("overwrite_confirmed"\)\)/.test(convert), "web conversion retains policy validation");
  ok(/_confine_tasks\(a\.get\("tasks"\), a\.get\("overwrite_confirmed"\)\)/.test(queue), "web queue retains policy validation");
  ok(forwarding.test(convert), "web conversion passes only explicit boolean true");
  ok(forwarding.test(queue), "web queue passes only explicit boolean true");
  ok(!preview.includes("overwrite_confirmed"), "preview remains confirmation-free");
  console.log("Web checks inspect source only; no Python or Flask execution.");
}

if (selected("tauri")) {
  const rust = read("src-tauri/src/main.rs");
  const convert = between(rust, "async fn start_convert(", "async fn run_queue(");
  const queue = between(rust, "async fn run_queue(", "async fn ai_plan(");
  ok(/policy == "overwrite" && args\.get\("overwrite_confirmed"\)\.and_then\(Value::as_bool\) != Some\(true\)/.test(convert), "desktop conversion retains strict validation");
  ok(/"overwrite_confirmed": args\.get\("overwrite_confirmed"\)\.and_then\(Value::as_bool\) == Some\(true\)/.test(convert), "desktop conversion forwards a strict boolean");
  ok(/let mut request = args;[\s\S]*?streaming\(&app, &engine, "run_queue", request, Some\(&operation_id\)\)/.test(queue), "desktop queue keeps its request");
  console.log("Desktop checks inspect Rust source only; no Rust execution.");
}
