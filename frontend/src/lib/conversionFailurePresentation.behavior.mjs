// OpenAI-Codex_app_ui: synthetic conversion error presentation checks.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { operationOutcome, redactLog, safeAiErrorText } from "./operation.ts";
import { isValidConversionResult } from "./convertResult.ts";

const source = readFileSync(new URL("../tabs/ConvertTab.svelte", import.meta.url), "utf8");
const startAt = source.indexOf("  async function start() {");
const stopAt = source.indexOf("  async function stop() {", startAt);
assert.ok(startAt >= 0 && stopAt > startAt, "conversion handlers must exist");
const startCode = stripTypeScriptTypes(source.slice(startAt, stopAt), { mode: "strip" });
let checks = 0;
function equal(actual, expected, message) { assert.deepEqual(actual, expected, message); checks++; }
function ok(value, message) { assert.ok(value, message); checks++; }
function harness({ run, scrub = redactLog, initialUnreliable = false, initialError = "" }) {
  const factory = new Function("api", "redactLog", "safeAiErrorText", "operationOutcome", "isValidConversionResult", "settings", [
    'let uploading=false, entries=[{path:"/synthetic/a.mkv"}], $busy=false, $eventReady=true, formats={}, validSavePath=true;',
    'let conflictPolicy="rename", dstFmt="mp4", savePath="/synthetic/out", stopping=false, jobs=[];',
    'let conversionResultUnreliable=settings.initialUnreliable, conversionError=settings.initialError, currentOperation=null;',
    'const messages=[], busy={set(v){$busy=v;}}, activeOperation={set(v){currentOperation=v;}};',
    'const IS_WEB=false, tr=(key)=>key, toast=(text,kind)=>messages.push({text,kind});',
    'function invalidatePreview(){}',
    startCode,
    'return {start,state:()=>({unreliable:conversionResultUnreliable,error:conversionError,jobs,busy:$busy,currentOperation,messages})};',
  ].join("\n"));
  return factory({startConvert:run}, scrub, safeAiErrorText, operationOutcome, isValidConversionResult, {initialUnreliable,initialError});
}
const summary = {total:1,succeeded:1,failed:0,skipped:0,cancelled:false};
const done = {src:"/synthetic/a.mkv",dst:"/synthetic/out/a.mp4",status:"done",error:""};
const normal = {jobs:[done],summary};

// A failed request must leave a redacted, persistent warning after finally.
{
  const secret = "SYNTHETIC_SECRET_42";
  const h = harness({run:async()=>{throw new Error("Cannot publish https://example.invalid/out?token="+secret);}});
  await h.start();
  const state = h.state();
  equal(state.unreliable,true,"failed request must leave the warning visible");
  equal(state.busy,false,"failed request clears busy after settlement");
  equal(state.currentOperation,null,"failed request clears active operation");
  ok(state.error.includes("[redacted]") && !state.error.includes(secret),"persistent error is redacted");
  ok(state.messages.every((item)=>typeof item.text === "string" && !item.text.includes(secret)),"toasts do not expose the synthetic secret");
}

for (const [name, failure, scrub] of [
  ["throwing toString",{toString(){throw new Error("synthetic formatting");}},redactLog],
  ["throwing redactor",new Error("synthetic"),()=>{throw new Error("synthetic redaction");}],
  ["non-string redactor",new Error("synthetic"),()=>null],
]) {
  const h = harness({run:async()=>{throw failure;},scrub});
  await h.start();
  equal(h.state().unreliable,true,name+" warning");
  equal(h.state().error,"[redacted]",name+" fallback");
  equal(h.state().busy,false,name+" cleanup");
  ok(h.state().messages.every((item)=>typeof item.text === "string"),name+" toast is safe text");
}

// Invalid terminal payloads remain unknown and cannot retain prior diagnostics.
{
  const h = harness({run:async()=>({jobs:[],summary}),initialUnreliable:true,initialError:"stale"});
  await h.start();
  equal(h.state().unreliable,true,"invalid payload warning");
  equal(h.state().error,"","invalid payload discards an earlier diagnostic");
  equal(h.state().jobs,[],"invalid payload does not render jobs");
  ok(!h.state().messages.some((item)=>item.kind === "ok"),"invalid payload cannot report success");
}

// Reset happens synchronously before a new pending request settles.
{
  let resolve; const pending = new Promise((r)=>{resolve=r;});
  const h = harness({run:()=>pending,initialUnreliable:true,initialError:"stale"});
  const started = h.start();
  equal(h.state().unreliable,false,"new operation clears stale warning before await");
  equal(h.state().error,"","new operation clears stale details before await");
  equal(h.state().busy,true,"new operation remains busy while pending");
  resolve(normal); await started;
  equal(h.state().busy,false,"success clears busy");
  equal(h.state().unreliable,false,"valid success has no warning");
  equal(h.state().jobs,[done],"valid success retains job");
}

for (const [name, job, resultSummary, notice] of [
  ["failure",{...done,status:"error",error:"cannot safely publish without overwriting"},{...summary,succeeded:0,failed:1},"operation_failed"],
  ["empty failure",{...done,status:"error",error:""},{...summary,succeeded:0,failed:1},"operation_failed"],
  ["skipped",{...done,status:"skipped",error:""},{...summary,succeeded:0,skipped:1,cancelled:true},"operation_cancelled"],
]) {
  const h = harness({run:async()=>({jobs:[job],summary:resultSummary})});
  await h.start();
  equal(h.state().unreliable,false,name+" has a valid terminal result");
  equal(h.state().jobs,[job],name+" keeps the terminal detail");
  equal(h.state().messages.at(-1)?.text,notice,name+" notice");
}

// Check the real component markup and evaluate its failure-only fallback condition.
assert.match(source,/\{#if conversionResultUnreliable\}[\s\S]*?role="alert"[\s\S]*?tr\("conversion_result_unreliable"\)[\s\S]*?conversionError[\s\S]*?\{\/if\}/);
checks++;
assert.match(source,/safeAiErrorText\(\(\) => redactLog\(job\.error\)\)/); checks++;
const fallback = source.match(/\{#if ([^}\n]*job\.status[^}\n]*)\}<p[^>]*>\{tr\("conversion_error_no_details"\)\}<\/p>\{\/if\}/);
assert.ok(fallback,"failure-detail fallback must exist"); checks++;
const showFallback = new Function("job", "return ("+fallback[1]+");");
for (const [status,error,want] of [["error","",true],["error","  ",true],["no_ffmpeg","",true],["error","details",false],["skipped","",false],["done","",false]]) {
  equal(showFallback({status,error}),want,"fallback for "+status);
}
for (const locale of ["en","zh_tw","zh_cn"]) {
  const data = JSON.parse(readFileSync(new URL("../../../locales/"+locale+".json", import.meta.url),"utf8"));
  ok(typeof data.conversion_error_no_details === "string" && data.conversion_error_no_details.trim().length > 0,locale+" fallback translation");
}
console.log("Conversion failure presentation: "+checks+" synthetic checks passed.");
