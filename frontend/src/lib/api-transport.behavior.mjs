// OpenAI-Codex_app_ui, OpenAI-Codex_Fork_Source_Code: exercise transport wiring with in-memory fakes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";

function deferred() {
  let resolve;
  const promise = new Promise((ok) => { resolve = ok; });
  return { promise, resolve };
}
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
const response = (body) => ({ ok: true, status: 200, json: async () => body });
const args = { urls: ["https://example.test/video"], mode: "video", video_fmt: "mp4", audio_fmt: "mp3", quality: "best", save_path: "/out" };
const completed = { results: [], summary: { total: 1, succeeded: 0, failed: 0, skipped: 1, cancelled: true } };
const queuePreviewTasks = [{ kind: "convert", task_id: "task-1", label: "item", src_path: "/in.mkv", dst_path: "/custom.mp4" }];

async function loadApi(globals, env, dynamicImport) {
  const context = createContext({ console, ...globals });
  const source = readFileSync(new URL("../api.ts", import.meta.url), "utf8");
  const mod = new SourceTextModule(stripTypeScriptTypes(source), {
    context,
    initializeImportMeta(meta) { meta.env = env; },
    importModuleDynamically: (specifier) => dynamicImport(specifier, context),
  });
  await mod.link((specifier) => {
    const files = { "./lib/operationCoordinator": "./operationCoordinator.ts", "./lib/eventStream": "./eventStream.ts" };
    if (!files[specifier]) throw new Error(`Unexpected import: ${specifier}`);
    return new SourceTextModule(stripTypeScriptTypes(readFileSync(new URL(files[specifier], import.meta.url), "utf8")), { context });
  });
  await mod.evaluate();
  return mod.namespace.api;
}

// The web transport uses one stream, and keeps stop available while offline.
{
  const prepare = deferred(), secondPrepare = deferred(), stop = deferred(), start = deferred(), calls = [], sources = [], states = [], events = [], notices = [];
  let prepareCount = 0, startCount = 0;
  const timers = new Map();
  let timerId = 0;
  class FakeEventSource {
    constructor(url) { this.url = url; this.closed = false; sources.push(this); }
    close() { this.closed = true; }
  }
  const api = await loadApi({
    window: {}, EventSource: FakeEventSource,
    setTimeout: (fn) => { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout: (id) => timers.delete(id),
    fetch: (path, options) => {
      calls.push({ path, body: options?.body ? JSON.parse(options.body) : undefined });
      if (path === "/api/operations") {
        prepareCount++;
        if (prepareCount === 1) return prepare.promise;
        if (prepareCount === 2) return secondPrepare.promise;
        return Promise.resolve(response({ operation_id: prepareCount === 3 ? "web-C" : "web-D", instance_id: "instance-web", command: "download", expires_in: 120 }));
      }
      if (path === "/api/stop") return stop.promise;
      if (path === "/api/download") {
        startCount++;
        if (startCount === 1) return start.promise;
        if (startCount === 2) return Promise.resolve({ ok: false, status: 400, json: async () => ({ error: "Invalid destination" }) });
        return Promise.reject(new Error("network disconnected"));
      }
      if (path === "/api/operations/status") return Promise.resolve(response({
        state: calls.at(-1).body.operation_id === "web-C" ? "reserved" : "completed", instance_id: "instance-web", idle: false,
      }));
      if (path === "/api/operations/release") return Promise.resolve(response({ released: true }));
      if (path === "/api/preview_convert") return Promise.resolve(response({ jobs: [] }));
      if (path === "/api/preview_queue") return Promise.resolve(response({ jobs: [] }));
      throw new Error(`Unexpected path ${path}`);
    },
  }, { VITE_BACKEND: "web" }, () => { throw new Error("Unexpected dynamic import"); });
  const offState = api.onConnectionState((state) => states.push(state));
  const offNotice = api.onOperationUncertain((notice) => notices.push(notice));
  const off = await api.onEvent((event) => events.push(event));
  const offAi = await api.onEvent(() => {});
  assert.equal(sources.length, 1);
  sources[0].onerror();
  assert.equal(states.at(-1), "disconnected");
  sources[0].onopen();
  assert.equal(states.at(-1), "open");
  const run = api.startDownload(args);
  sources[0].onerror();
  const stopped = api.stop();
  await flush();
  assert.deepEqual(calls.map((call) => call.path), ["/api/operations"]);
  prepare.resolve(response({ operation_id: "web-A", instance_id: "instance-web", command: "download", expires_in: 120 }));
  await flush();
  assert.equal(calls[1].path, "/api/stop");
  assert.equal(calls[1].body.operation_id, "web-A");
  assert.equal(calls.some((call) => call.path === "/api/download"), false);
  sources[0].onopen();
  stop.resolve(response({ stopping: true }));
  await flush();
  const started = calls.find((call) => call.path === "/api/download");
  assert.equal(started.body.operation_id, "web-A");
  sources[0].onopen();
  for (const id of ["old", "web-A"]) sources[0].onmessage({ data: JSON.stringify({ type: "progress", operation_id: id }) });
  assert.equal(events.length, 1);
  assert.equal(events[0].operation_id, "web-A");
  start.resolve(response(completed));
  assert.equal((await stopped).stopping, true);
  assert.equal((await run).summary.cancelled, true);
  assert.equal(calls.at(-1).body.operation_id, "web-A");
  sources[0].onmessage({ data: JSON.stringify({ type: "progress", operation_id: "web-A" }) });
  assert.equal(events.length, 1);
  const second = api.startDownload(args);
  const secondResult = second.then(() => "resolved", () => "rejected");
  sources[0].onerror();
  secondPrepare.resolve(response({ operation_id: "web-B", instance_id: "instance-web", command: "download", expires_in: 120 }));
  assert.equal(await secondResult, "rejected");
  assert.equal(calls.filter((call) => call.path === "/api/download").length, 1);
  assert.equal(calls.at(-1).body.operation_id, "web-B");
  sources[0].onopen();
  const httpError = await api.startDownload(args).then(() => null, (error) => error);
  assert.equal(httpError.message, "Invalid destination");
  assert.equal(calls.find((call) => call.path === "/api/operations/status" && call.body.operation_id === "web-C").body.operation_id, "web-C");
  assert.ok(notices.includes("not_started"));
  const networkError = await api.startDownload(args).then(() => null, (error) => error);
  assert.match(networkError.message, /final result was lost/);
  assert.ok(notices.includes("result_lost"));
  assert.equal(calls.find((call) => call.path === "/api/operations/status" && call.body.operation_id === "web-D").body.operation_id, "web-D");
  await api.previewConvert({ files: [], dst_fmt: "mp4", save_path: "" });
  assert.equal(calls.at(-1).path, "/api/preview_convert");
  assert.equal("operation_id" in calls.at(-1).body, false);
  await api.previewQueue(queuePreviewTasks);
  assert.equal(calls.at(-1).path, "/api/preview_queue");
  assert.equal(calls.at(-1).body.tasks[0].dst_path, "/custom.mp4");
  assert.equal("operation_id" in calls.at(-1).body, false);
  offAi();
  assert.equal(sources[0].closed, false);
  off();
  assert.equal(sources[0].closed, true);
  assert.equal(timers.size, 0);
  offState();
  offNotice();
}

// The Tauri IPC transport uses the same operation ID in each command.
{
  const prepare = deferred(), stop = deferred(), start = deferred(), calls = [], notices = [];
  let prepareCount = 0, startCount = 0;
  let listener;
  const exportsByName = {
    "@tauri-apps/api/core": { invoke: (command, payload) => {
      calls.push({ command, payload });
      if (command === "prepare_operation") return ++prepareCount === 1 ? prepare.promise : Promise.resolve({ operation_id: `desktop-${String.fromCharCode(64 + prepareCount)}`, instance_id: "instance-desktop", expires_in: 120 });
      if (command === "stop_engine") return stop.promise;
      if (command === "start_download") return ++startCount === 1 ? start.promise : Promise.reject("ambiguous desktop error");
      if (command === "operation_status") {
        const id = payload.args.operation_id;
        return Promise.resolve({ state: id === "desktop-D" ? "unknown" : "completed", instance_id: "instance-desktop", idle: true,
          ...(id === "desktop-C" ? { confirmed_error: "Sidecar reported a failure" } : {}) });
      }
      if (command === "release_operation") return Promise.resolve({});
      if (command === "preview_convert") return Promise.resolve({ jobs: [] });
      if (command === "preview_queue") return Promise.resolve({ jobs: [] });
      throw new Error(`Unexpected command ${command}`);
    } },
    "@tauri-apps/api/event": { listen: async (_name, callback) => { listener = callback; return () => { listener = undefined; }; } },
  };
  const cache = new Map();
  const dynamicImport = async (specifier, context) => {
    if (!cache.has(specifier)) {
      const values = exportsByName[specifier];
      if (!values) throw new Error(`Unexpected dynamic import ${specifier}`);
      const module = new SyntheticModule(Object.keys(values), function () {
        for (const [key, value] of Object.entries(values)) this.setExport(key, value);
      }, { context });
      cache.set(specifier, module);
      await module.link(() => {});
      await module.evaluate();
    }
    return cache.get(specifier);
  };
  const timers = new Map();
  let timerId = 0;
  const api = await loadApi({
    window: { __TAURI_INTERNALS__: {} },
    setTimeout: (fn) => { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout: (id) => timers.delete(id),
  }, {}, dynamicImport);
  const states = [];
  const offState = api.onConnectionState((state) => states.push(state));
  const offNotice = api.onOperationUncertain((notice) => notices.push(notice));
  const off = await api.onEvent(() => {});
  await flush();
  assert.equal(states.at(-1), "open");
  assert.equal(typeof listener, "function");
  const run = api.startDownload(args);
  const stopped = api.stop();
  await flush();
  assert.equal(calls[0].command, "prepare_operation");
  assert.equal(calls[0].payload.args.command, "download");
  prepare.resolve({ operation_id: "desktop-A", instance_id: "instance-desktop", expires_in: 120 });
  await flush();
  assert.equal(calls[1].command, "stop_engine");
  assert.equal(calls[1].payload.args.operation_id, "desktop-A");
  stop.resolve({ stopping: true });
  await flush();
  assert.equal(calls[2].command, "start_download");
  assert.equal(calls[2].payload.args.operation_id, "desktop-A");
  start.resolve(completed);
  assert.equal((await stopped).stopping, true);
  assert.equal((await run).summary.cancelled, true);
  assert.equal(calls[3].command, "release_operation");
  assert.equal(calls[3].payload.args.operation_id, "desktop-A");
  await api.previewConvert({ files: [], dst_fmt: "mp4", save_path: "" });
  assert.equal(calls.at(-1).command, "preview_convert");
  assert.equal("operation_id" in calls.at(-1).payload.args, false);
  await api.previewQueue(queuePreviewTasks);
  assert.equal(calls.at(-1).command, "preview_queue");
  assert.equal(calls.at(-1).payload.args.tasks[0].dst_path, "/custom.mp4");
  assert.equal("operation_id" in calls.at(-1).payload.args, false);
  const ambiguous = await api.startDownload(args).then(() => null, (error) => error);
  assert.match(ambiguous.message, /final result was lost/);
  assert.ok(notices.includes("result_lost"));
  const status = calls.find((call) => call.command === "operation_status");
  assert.equal(status.payload.args.operation_id, "desktop-B");
  const confirmed = await api.startDownload(args).then(() => null, (error) => error);
  assert.equal(confirmed.message, "Sidecar reported a failure");
  assert.ok(notices.includes("response_error"));
  const unknown = await api.startDownload(args).then(() => null, (error) => error);
  assert.match(unknown.message, /result is unknown/);
  assert.match(unknown.message, /ambiguous desktop error/);
  assert.ok(notices.includes("result_unknown"));
  off();
  offState();
  offNotice();
  assert.equal(listener, undefined);
  assert.equal(timers.size, 0);
}
console.log("Web and Tauri transport wiring checks passed.");
