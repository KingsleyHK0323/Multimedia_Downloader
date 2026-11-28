// OpenAI-Codex_engine_cli: upload protocol checks use memory-only files and fetch fakes.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

let api = { readUploadConfig: async () => ({ enabled: false, reason: "unknown" }) };
if (existsSync(new URL("./webUpload.ts", import.meta.url))) api = await import("./webUpload.ts");
const chunkSize = 262144;
const enabled = { enabled: true, max_file_bytes: 2_000_000, max_total_bytes: 10_000_000, chunk_bytes: chunkSize };
const id = "03-0123456789abcdef0123456789abcdef";
const path = ".mmdl-uploads-v1/slot-03/payload.mp4";
const reply = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
const config = await api.readUploadConfig(async () => reply(enabled));
assert.deepEqual(config, enabled);

const disabled = await api.readUploadConfig(async () => reply({enabled:false,reason:"not_configured"}));
assert.deepEqual(disabled, {enabled:false,reason:"not_configured"});
const unknown = await api.readUploadConfig(async () => reply({enabled:false,reason:"server secret"}));
assert.deepEqual(unknown, {enabled:false,reason:"unknown"});
const safeMaximum = {...enabled,max_file_bytes:Number.MAX_SAFE_INTEGER,max_total_bytes:Number.MAX_SAFE_INTEGER};
assert.deepEqual(await api.readUploadConfig(async () => reply(safeMaximum)),safeMaximum);
await assert.rejects(() => api.readUploadConfig(async () => reply({...enabled,max_total_bytes:Number.MAX_SAFE_INTEGER + 1})),
  (error) => error.kind === "config");
for (const value of [null, {}, {...enabled, chunk_bytes:1}, {...enabled, max_file_bytes:0}, {...enabled, max_total_bytes:NaN}]) {
  await assert.rejects(() => api.readUploadConfig(async () => reply(value)), (error) => error.kind === "config");
}

function file(name, size) {
  const bytes = Uint8Array.from({length:size}, (_, index) => index % 251);
  return { name, size, slice(start, end) { return { arrayBuffer: async () => bytes.slice(start, end).buffer }; }, bytes };
}
for (const bad of [file("",0),file("bad/name.mp4",0),file("bad\\name.mp4",0),file("bad\u0000name",0),file("a".repeat(256),0),file("big.mp4",2_000_001)]) {
  assert.equal(api.isValidUploadFile(bad, enabled), false);
}
assert.equal(api.isValidUploadFile(file("片段😀.mp4",0), enabled), true);

function server(options = {}) {
  const calls = [], chunks = [];
  let chunkAttempts = 0, finishAttempts = 0;
  const fetcher = async (url, request = {}) => {
    const body = request.body ? JSON.parse(request.body) : undefined;
    calls.push({url,body,signal:request.signal});
    if (url === "/api/uploads") {
      if (options.lostCreate) throw new TypeError("network lost");
      return reply(options.createResponse ?? {upload_id:id,chunk_bytes:chunkSize,next_offset:0});
    }
    if (url === "/api/uploads/chunk") {
      chunkAttempts++;
      if (options.abortChunk) { options.abortChunk.abort(); throw new DOMException("aborted","AbortError"); }
      if (options.failChunkHttp) return reply({error_code:"conflict"},409);
      if (options.lostChunk && chunkAttempts === 1) throw new TypeError("response lost");
      chunks.push(body);
      const length = Buffer.from(body.data_base64,"base64").length;
      return reply({next_offset: options.badOffset ? body.offset : body.offset + length});
    }
    if (url === "/api/uploads/finish") {
      finishAttempts++;
      if (options.lostFinish && finishAttempts === 1) throw new TypeError("response lost");
      return reply({path: options.finishPath ?? path});
    }
    throw new Error("unexpected request");
  };
  return {fetcher,calls,chunks};
}

const large = file("example.mp4",chunkSize * 2 + 3);
const normal = server();
const progress = [];
assert.equal(await api.uploadFile(large, enabled, {fetcher:normal.fetcher,onProgress:(value)=>progress.push(value)}), path);
assert.deepEqual(normal.chunks.map((chunk)=>chunk.offset), [0,chunkSize,chunkSize*2]);
assert.deepEqual(normal.chunks.map((chunk)=>Buffer.from(chunk.data_base64,"base64").length), [chunkSize,chunkSize,3]);
assert.deepEqual(Buffer.concat(normal.chunks.map((chunk)=>Buffer.from(chunk.data_base64,"base64"))), Buffer.from(large.bytes));
assert.equal(progress.at(-1).phase, "finalizing");
assert.equal(progress.at(-1).sent, large.size);
assert.equal(normal.calls.at(-1).url, "/api/uploads/finish");

const retry = server({lostChunk:true,lostFinish:true});
assert.equal(await api.uploadFile(file("a.mp4",5), enabled, {fetcher:retry.fetcher}), path);
const chunkCalls = retry.calls.filter((call)=>call.url === "/api/uploads/chunk");
assert.equal(chunkCalls.length,2);
assert.deepEqual(chunkCalls[0].body,chunkCalls[1].body);
assert.equal(retry.calls.filter((call)=>call.url === "/api/uploads/finish").length,2);
const empty = server();
assert.equal(await api.uploadFile(file("empty.mp4",0), enabled, {fetcher:empty.fetcher}), path);
assert.equal(empty.calls.some((call)=>call.url === "/api/uploads/chunk"),false);

for (const options of [{lostCreate:true},{badOffset:true},{failChunkHttp:true},{finishPath:"../outside.mp4"},
                       {finishPath:".mmdl-uploads-v1/slot-04/payload.mp4"}]) {
  const fake = server(options);
  await assert.rejects(()=>api.uploadFile(file("a.mp4",5),enabled,{fetcher:fake.fetcher}));
  if (options.lostCreate) assert.equal(fake.calls.filter((call)=>call.url === "/api/uploads").length,1);
  if (options.failChunkHttp) assert.equal(fake.calls.filter((call)=>call.url === "/api/uploads/chunk").length,1);
}
const controller = new AbortController();
const cancelled = server({abortChunk:controller});
await assert.rejects(()=>api.uploadFile(file("a.mp4",5),enabled,{fetcher:cancelled.fetcher,signal:controller.signal}),
  (error)=>error.kind === "cancelled");
assert.equal(cancelled.calls.filter((call)=>call.url === "/api/uploads/chunk").length,1);
assert.equal(cancelled.calls.some((call)=>call.url === "/api/uploads/finish"),false);

// Extract the actual page handlers: this does not mount Svelte or send requests.
const component = readFileSync(new URL("../tabs/ConvertTab.svelte", import.meta.url), "utf8");
const handlersStart = component.indexOf("  async function startUpload() {");
const handlersEnd = component.indexOf("\n  onMount(() => {", handlersStart);
assert.ok(handlersStart >= 0 && handlersEnd > handlersStart);
const handlers = stripTypeScriptTypes(component.slice(handlersStart, handlersEnd), {mode:"strip"});
function pageHarness({isWeb = true, valid = true, perform} = {}) {
  const factory = new Function("IS_WEB", "isValidUploadFile", "uploadFile", "UploadError", "AbortController", `
    let uploading = false, $busy = false, uploadDisposed = false;
    let uploadController = null, uploadFeedback = "", uploadProgress = null;
    let selectedUpload = {name:"clip.mp4",size:5}, completedUpload = null;
    let uploadConfig = {enabled:true}, entries = [], invalidations = 0;
    function invalidatePreview() { invalidations++; }
    ${handlers}
    return { run: () => startUpload(), stop: () => stopUpload(),
      dispose: () => { uploadDisposed = true; },
      state: () => ({ entries, invalidations, uploading, uploadFeedback, uploadProgress }) };
  `);
  return factory(isWeb, () => valid, perform, api.UploadError, AbortController);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise,resolve,reject};
}
const waiting = deferred();
const successPage = pageHarness({perform:(_file,_config,options) => {
  options.onProgress({sent:2,total:5,phase:"uploading"});
  return waiting.promise;
}});
const pendingSuccess = successPage.run();
assert.equal(successPage.state().uploading,true);
assert.deepEqual(successPage.state().entries,[]);
assert.equal(successPage.state().uploadProgress.sent,2);
waiting.resolve(path);
await pendingSuccess;
assert.deepEqual(successPage.state().entries,[{path}]);
assert.equal(successPage.state().invalidations,1);
assert.equal(successPage.state().uploadFeedback,"completed");
assert.equal(successPage.state().uploading,false);

const late = deferred();
const cancelledPage = pageHarness({perform:()=>late.promise});
const pendingCancelled = cancelledPage.run();
cancelledPage.stop();
late.resolve(path);
await pendingCancelled;
assert.deepEqual(cancelledPage.state().entries,[]);
assert.equal(cancelledPage.state().uploadFeedback,"unconfirmed");
assert.equal(cancelledPage.state().uploading,false);

const failedPage = pageHarness({perform:async()=>{throw new Error("server response lost");}});
await failedPage.run();
assert.deepEqual(failedPage.state().entries,[]);
assert.equal(failedPage.state().uploadFeedback,"unconfirmed");
const disposedReply = deferred();
const disposedPage = pageHarness({perform:()=>disposedReply.promise});
const pendingDisposed = disposedPage.run();
disposedPage.dispose();
disposedReply.resolve(path);
await pendingDisposed;
assert.deepEqual(disposedPage.state().entries,[]);
let callsWhileBlocked = 0;
for (const options of [{isWeb:false},{valid:false}]) {
  const page = pageHarness({...options, perform:async()=>{callsWhileBlocked++;return path;}});
  await page.run();
  assert.deepEqual(page.state().entries,[]);
}
assert.equal(callsWhileBlocked,0);

for (const name of ["bad\u007fname", "bad\u0085name", "\ud800"]) {
  assert.equal(api.isValidUploadFile(file(name,0),enabled),false);
}
for (const name of [".", ".."]) assert.equal(api.isValidUploadFile(file(name,0),enabled),false);
const preAborted = new AbortController();
preAborted.abort();
let calledAfterAbort = false;
await assert.rejects(() => api.uploadFile(file("a.mp4",5),enabled,{
  signal:preAborted.signal, fetcher:async()=>{calledAfterAbort=true;return reply({});},
}), (error)=>error.kind === "cancelled");
assert.equal(calledAfterAbort,false);
const malformedCreate = server({createResponse:{upload_id:id,chunk_bytes:chunkSize,next_offset:1}});
await assert.rejects(() => api.uploadFile(file("a.mp4",5),enabled,{fetcher:malformedCreate.fetcher}),
  (error)=>error.kind === "protocol");
assert.equal(malformedCreate.calls.length,1);

// OpenAI-Codex_web_ai: response body loss after commit must follow bounded retry rules.
function bodyLossServer(stage, failures, options = {}) {
  const calls = [];
  let attempts = 0, chunkCommitted = false, finishCommitted = false;
  const endpoint = {create:"/api/uploads", chunk:"/api/uploads/chunk", finish:"/api/uploads/finish"}[stage];
  const fetcher = async (url, request = {}) => {
    calls.push({url,body:request.body});
    if (url === "/api/uploads/chunk") chunkCommitted = true;
    if (url === "/api/uploads/finish") {
      assert.equal(chunkCommitted, true);
      finishCommitted = true;
    }
    if (url === endpoint) {
      attempts++;
      if (options.httpFailure) return reply({error_code:"unavailable"},503);
      if (attempts <= failures) return {
        ok:true,
        json:async()=>{
          if (options.controller) options.controller.abort();
          if (options.abortError) throw new DOMException("synthetic response abort","AbortError");
          if (options.syntaxError) throw new SyntaxError("synthetic invalid response body");
          throw new TypeError("synthetic response body loss");
        },
      };
    }
    if (url === "/api/uploads") return reply({upload_id:id,chunk_bytes:chunkSize,next_offset:0});
    if (url === "/api/uploads/chunk") return reply({next_offset:5});
    if (url === "/api/uploads/finish") return reply({path});
    throw new Error("unexpected fake request");
  };
  return {fetcher,calls,state:()=>({chunkCommitted,finishCommitted})};
}

for (const stage of ["chunk","finish"]) {
  const fake = bodyLossServer(stage,1);
  const progress = [];
  assert.equal(await api.uploadFile(file("a.mp4",5),enabled,{
    fetcher:fake.fetcher,onProgress:(value)=>progress.push(value),
  }),path);
  const attempts = fake.calls.filter((call)=>call.url === "/api/uploads/" + stage);
  assert.equal(attempts.length,2);
  assert.equal(attempts[0].body,attempts[1].body);
  assert.deepEqual(fake.state(),{chunkCommitted:true,finishCommitted:true});
  assert.deepEqual(progress,[
    {sent:0,total:5,phase:"uploading"},
    {sent:5,total:5,phase:"uploading"},
    {sent:5,total:5,phase:"finalizing"},
  ]);

  const repeated = bodyLossServer(stage,2);
  await assert.rejects(()=>api.uploadFile(file("a.mp4",5),enabled,{fetcher:repeated.fetcher}),
    (error)=>error.kind === "unconfirmed");
  assert.equal(repeated.calls.filter((call)=>call.url === "/api/uploads/" + stage).length,2);
  if (stage === "chunk") assert.equal(repeated.calls.some((call)=>call.url === "/api/uploads/finish"),false);
}

const createBodyLost = bodyLossServer("create",1);
await assert.rejects(()=>api.uploadFile(file("a.mp4",5),enabled,{fetcher:createBodyLost.fetcher}),
  (error)=>error.kind === "unconfirmed");
assert.equal(createBodyLost.calls.length,1);

const bodyHttpError = bodyLossServer("chunk",1,{httpFailure:true});
await assert.rejects(()=>api.uploadFile(file("a.mp4",5),enabled,{fetcher:bodyHttpError.fetcher}),
  (error)=>error.kind === "server");
assert.equal(bodyHttpError.calls.filter((call)=>call.url === "/api/uploads/chunk").length,1);


// OpenAI-Codex_web_ai: keep HTTP and protocol failures distinct from body retries.
for (const stage of ["create","finish"]) {
  const fake = bodyLossServer(stage,1,{httpFailure:true});
  await assert.rejects(()=>api.uploadFile(file("a.mp4",5),enabled,{fetcher:fake.fetcher}),
    (error)=>error.kind === "server");
  const endpoint = stage === "create" ? "/api/uploads" : "/api/uploads/finish";
  assert.equal(fake.calls.filter((call)=>call.url === endpoint).length,1);
}
const badJson = bodyLossServer("chunk",2,{syntaxError:true});
await assert.rejects(()=>api.uploadFile(file("a.mp4",5),enabled,{fetcher:badJson.fetcher}),
  (error)=>error.kind === "unconfirmed");
assert.equal(badJson.calls.filter((call)=>call.url === "/api/uploads/chunk").length,2);
assert.equal(badJson.calls.some((call)=>call.url === "/api/uploads/finish"),false);

const badShape = server({badOffset:true});
await assert.rejects(()=>api.uploadFile(file("a.mp4",5),enabled,{fetcher:badShape.fetcher}),
  (error)=>error.kind === "protocol");
assert.equal(badShape.calls.filter((call)=>call.url === "/api/uploads/chunk").length,1);
assert.equal(badShape.calls.some((call)=>call.url === "/api/uploads/finish"),false);

const bodyAbort = new AbortController();
const cancelledBody = bodyLossServer("chunk",1,{controller:bodyAbort,abortError:true});
await assert.rejects(()=>api.uploadFile(file("a.mp4",5),enabled,{
  fetcher:cancelledBody.fetcher,signal:bodyAbort.signal,
}), (error)=>error.kind === "cancelled");
assert.equal(cancelledBody.calls.filter((call)=>call.url === "/api/uploads/chunk").length,1);
assert.equal(cancelledBody.calls.some((call)=>call.url === "/api/uploads/finish"),false);

const detachedAbort = bodyLossServer("chunk",1,{abortError:true});
await assert.rejects(()=>api.uploadFile(file("a.mp4",5),enabled,{fetcher:detachedAbort.fetcher}),
  (error)=>error.kind === "unconfirmed");
assert.equal(detachedAbort.calls.filter((call)=>call.url === "/api/uploads/chunk").length,1);

console.log("Memory-only web upload protocol checks passed.");
