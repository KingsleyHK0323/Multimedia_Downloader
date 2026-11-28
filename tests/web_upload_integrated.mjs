// OpenAI-Codex_engine_cli: cross-language upload checks use memory-only fakes.
// Run with Node 24 and an explicitly supplied Python executable:
// node --no-warnings tests/web_upload_integrated.mjs /path/to/python
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const python = process.argv[2];
assert.ok(python, "Provide the existing Python executable as the first argument.");
globalThis.fetch = () => { throw new Error("Real network access is forbidden in this check."); };

const bridgePath = fileURLToPath(new URL("./web_upload_memory_bridge.py", import.meta.url));
const child = spawn(python, ["-B", bridgePath], { stdio: ["pipe", "pipe", "pipe"] });
const pending = new Map();
let sequence = 0;
let childError = "";
child.stderr.on("data", (chunk) => { childError += chunk.toString(); });
const exited = new Promise((resolve) => {
  child.on("error", (error) => resolve({ error }));
  child.on("exit", (code, signal) => resolve({ code, signal }));
});
createInterface({ input: child.stdout }).on("line", (line) => {
  const response = JSON.parse(line);
  const resolver = pending.get(response.id);
  if (!resolver) throw new Error("Unexpected synthetic bridge response.");
  pending.delete(response.id);
  resolver(response.result);
});

function rpc(message) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ ...message, id }) + "\n", (error) => {
      if (error) { pending.delete(id); reject(error); }
    });
  });
}

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Synthetic check timed out.")), 20000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function makeFile(name, size) {
  const bytes = Uint8Array.from({ length: size }, (_, index) => index % 251);
  return {
    name, size, bytes,
    slice(start, end) { return { arrayBuffer: async () => bytes.slice(start, end).buffer }; },
  };
}

function network(service, options = {}) {
  const calls = [];
  let lostCreate = options.lostCreateOnce === true;
  let lostChunk = options.lostChunkOnce === true;
  let lostFinish = options.lostFinishOnce === true;
  let pausedFinish = options.pauseFinish === true;
  const finishObserved = deferred();
  const releaseFinish = deferred();
  let lastUploadId = null;
  async function fetcher(url, request = {}) {
    const body = request.body ?? "";
    calls.push({ url, body });
    const response = await bounded(rpc({
      kind: "request", service, url, method: request.method ?? "GET",
      headers: request.headers ?? {}, body,
    }));
    if (url === "/api/uploads" && response.status === 200) {
      lastUploadId = response.body.upload_id;
      if (lostCreate) { lostCreate = false; throw new TypeError("Synthetic create response lost."); }
    }
    if (url === "/api/uploads/chunk" && response.status === 200 && lostChunk) {
      lostChunk = false;
      throw new TypeError("Synthetic committed chunk response lost.");
    }
    if (url === "/api/uploads/finish" && response.status === 200) {
      if (lostFinish) { lostFinish = false; throw new TypeError("Synthetic committed finish response lost."); }
      if (pausedFinish) {
        pausedFinish = false;
        finishObserved.resolve();
        await bounded(releaseFinish.promise);
      }
    }
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: async () => response.body,
    };
  }
  return {
    fetcher, calls, finishObserved, releaseFinish,
    get uploadId() { return lastUploadId; },
  };
}

function post(service, url, body, extra = {}) {
  return bounded(rpc({
    kind: "request", service, url, method: "POST",
    headers: { "Content-Type": "application/json", ...(extra.headers ?? {}) },
    body: JSON.stringify(body), ...extra,
  }));
}

const transport = await import("../frontend/src/lib/webUpload.ts");
const component = readFileSync(new URL("../frontend/src/tabs/ConvertTab.svelte", import.meta.url), "utf8");
const handlerStart = component.indexOf("  async function startUpload() {");
const handlerEnd = component.indexOf("\n  onMount(() => {", handlerStart);
assert.ok(handlerStart >= 0 && handlerEnd > handlerStart, "Cannot find the current page handlers.");
const handlers = stripTypeScriptTypes(component.slice(handlerStart, handlerEnd), { mode: "strip" });

function pageHarness(file, config, fetcher) {
  const body = [
    'let uploading = false, $busy = false, uploadDisposed = false;',
    'let uploadController = null, uploadFeedback = "", uploadProgress = null;',
    'let selectedUpload = file, completedUpload = null, uploadConfig = config, entries = [];',
    'let invalidations = 0;',
    'function invalidatePreview() { invalidations++; }',
    handlers,
    'return { run: () => startUpload(), stop: () => stopUpload(),',
    'state: () => ({ entries, uploadFeedback, uploadProgress, uploading, invalidations }) };',
  ].join("\n");
  const factory = new Function(
    "IS_WEB", "isValidUploadFile", "uploadFile", "UploadError", "AbortController", "file", "config", body,
  );
  const invoke = (selected, selectedConfig, options) =>
    transport.uploadFile(selected, selectedConfig, { ...options, fetcher });
  return factory(true, transport.isValidUploadFile, invoke, transport.UploadError, AbortController, file, config);
}

try {
  const disabledNet = network("disabled");
  assert.deepEqual(await bounded(transport.readUploadConfig(disabledNet.fetcher)), {
    enabled: false, reason: "not_configured",
  });
  await assert.rejects(
    () => transport.uploadFile(makeFile("blocked.mp4", 1), { enabled: false, reason: "not_configured" },
      { fetcher: disabledNet.fetcher }),
    (error) => error.kind === "invalid_file",
  );
  assert.equal(disabledNet.calls.length, 1);
  const disabledCreate = await post("disabled", "/api/uploads", { name: "blocked.mp4", size: 1 });
  assert.equal(disabledCreate.status, 403);
  assert.equal(disabledCreate.body.error_code, "disabled");

  const enabledNet = network("enabled");
  const config = await bounded(transport.readUploadConfig(enabledNet.fetcher));
  assert.deepEqual(config, {
    enabled: true, max_file_bytes: 524288, max_total_bytes: 3000000, chunk_bytes: 262144,
  });
  const badHost = await bounded(rpc({
    kind: "request", service: "enabled", url: "/api/uploads/config",
    method: "GET", host: "untrusted.invalid",
  }));
  assert.equal(badHost.status, 400);
  const badOrigin = await post("enabled", "/api/uploads", { name: "x.mp4", size: 1 }, {
    headers: { "Content-Type": "application/json", Origin: "https://untrusted.invalid" },
  });
  assert.equal(badOrigin.status, 403);
  const noLength = await post("enabled", "/api/uploads", { name: "x.mp4", size: 1 }, { omit_length: true });
  assert.equal(noLength.status, 400);
  assert.equal((await post("enabled", "/api/uploads", { name: "../x", size: 1 })).status, 400);
  assert.equal((await post("enabled", "/api/uploads", { name: "x.mp4", size: 524289 })).status, 413);

  const incomplete = await post("enabled", "/api/uploads", { name: "partial.mp4", size: 5 });
  assert.equal(incomplete.status, 200);
  assert.ok(incomplete.body.upload_id.startsWith("00-"));
  const incompletePath = ".mmdl-uploads-v1/slot-00/payload.mp4";
  const convert = (path) => post("enabled", "/api/convert", {
    operation_id: "synthetic-operation", files: [path], dst_fmt: "mp4", save_path: "",
  });
  assert.equal((await convert(incompletePath)).status, 403);
  assert.equal((await post("enabled", "/api/uploads/finish", { upload_id: incomplete.body.upload_id })).status, 409);
  assert.equal((await bounded(rpc({ kind: "counts", service: "enabled" }))).convert_calls, 0);

  const fakeFile = makeFile("clip.mp4", 262147);
  const retryNet = network("enabled", { lostChunkOnce: true, lostFinishOnce: true, pauseFinish: true });
  const page = pageHarness(fakeFile, config, retryNet.fetcher);
  const uploading = page.run();
  await bounded(retryNet.finishObserved.promise);
  assert.deepEqual(page.state().entries, []);
  const beforeReply = await bounded(rpc({ kind: "snapshot", service: "enabled", upload_id: retryNet.uploadId }));
  assert.equal(beforeReply.completed, true);
  retryNet.releaseFinish.resolve();
  await bounded(uploading);
  assert.equal(page.state().uploadFeedback, "completed");
  assert.equal(page.state().entries.length, 1);
  const uploadedPath = page.state().entries[0].path;
  assert.equal(uploadedPath, ".mmdl-uploads-v1/slot-01/payload.mp4");
  assert.equal(page.state().invalidations, 1);
  const chunks = retryNet.calls.filter((call) => call.url === "/api/uploads/chunk");
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].body, chunks[1].body);
  assert.equal(retryNet.calls.filter((call) => call.url === "/api/uploads/finish").length, 2);
  const snapshot = await bounded(rpc({ kind: "snapshot", service: "enabled", upload_id: retryNet.uploadId }));
  assert.equal(snapshot.bytes, fakeFile.size);
  assert.equal(snapshot.journal_bytes, 196);
  assert.equal(snapshot.sha256, createHash("sha256").update(fakeFile.bytes).digest("hex"));
  const conversion = await convert(uploadedPath);
  assert.equal(conversion.status, 200);
  assert.equal(conversion.body.cmd, "convert");
  assert.equal(conversion.body.files[0], "C:\\virtual\\downloads\\.mmdl-uploads-v1\\slot-01\\payload.mp4");

  const lostCreateNet = network("enabled", { lostCreateOnce: true });
  const lostCreatePage = pageHarness(makeFile("lost.mp4", 1), config, lostCreateNet.fetcher);
  await bounded(lostCreatePage.run());
  assert.equal(lostCreateNet.calls.filter((call) => call.url === "/api/uploads").length, 1);
  assert.equal(lostCreatePage.state().uploadFeedback, "unconfirmed");
  assert.deepEqual(lostCreatePage.state().entries, []);
  assert.equal((await bounded(rpc({ kind: "snapshot", service: "enabled", upload_id: lostCreateNet.uploadId }))).completed, false);

  const cancelledNet = network("enabled", { pauseFinish: true });
  const cancelledPage = pageHarness(makeFile("cancel.mp4", 3), config, cancelledNet.fetcher);
  const cancelling = cancelledPage.run();
  await bounded(cancelledNet.finishObserved.promise);
  cancelledPage.stop();
  cancelledNet.releaseFinish.resolve();
  await bounded(cancelling);
  assert.equal(cancelledPage.state().uploadFeedback, "unconfirmed");
  assert.deepEqual(cancelledPage.state().entries, []);
  assert.equal((await bounded(rpc({ kind: "snapshot", service: "enabled", upload_id: cancelledNet.uploadId }))).completed, true);

  const emptyNet = network("enabled");
  const emptyPath = await bounded(transport.uploadFile(makeFile("empty.mp4", 0), config, { fetcher: emptyNet.fetcher }));
  assert.equal(emptyPath, ".mmdl-uploads-v1/slot-04/payload.mp4");
  assert.equal(emptyNet.calls.some((call) => call.url === "/api/uploads/chunk"), false);
  assert.equal((await bounded(rpc({ kind: "snapshot", service: "enabled", upload_id: emptyNet.uploadId }))).bytes, 0);
  const full = await post("enabled", "/api/uploads", { name: "full.mp4", size: 1 });
  assert.equal(full.status, 409);
  assert.equal(full.body.error_code, "quota_exhausted");
  console.log("Memory-only frontend, extracted Web routes, and UploadStore integration checks passed.");
} finally {
  child.stdin.end();
  const result = await bounded(exited);
  assert.equal(result.code, 0, childError || JSON.stringify(result));
}
