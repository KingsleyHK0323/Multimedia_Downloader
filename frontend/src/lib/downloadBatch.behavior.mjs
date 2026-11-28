// OpenAI-Codex: support blank lines and Windows line endings in handler fixtures.
// OpenAI-Codex_app_ui: synthetic checks for the shared download batch state.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";
import { runInContext } from "node:vm";
import { isValidDownloadResult } from "./downloadResult.ts";
import { operationOutcome } from "./operation.ts";
import { safeAiErrorText } from "./operation.ts"; // OpenAI-Codex_app_ui
import { OperationCoordinator } from "./operationCoordinator.ts";

const queue = [];
function changed(a, b) {
  return a !== a ? b === b : a !== b || (a !== null && typeof a === "object") || typeof a === "function";
}
function writable(initial) {
  let value = initial;
  const subscribers = new Set();
  function set(next) {
    if (!changed(value, next)) return;
    value = next;
    const flush = queue.length === 0;
    for (const entry of subscribers) {
      entry[1]();
      queue.push(entry, value);
    }
    if (flush) {
      for (let i = 0; i < queue.length; i += 2) queue[i][0](queue[i + 1]);
      queue.length = 0;
    }
  }
  function subscribe(run, invalidate = () => {}) {
    const entry = [run, invalidate];
    subscribers.add(entry);
    run(value);
    return () => subscribers.delete(entry);
  }
  return { set, update: (fn) => set(fn(value)), subscribe };
}
const get = (store) => {
  let value;
  store.subscribe((next) => { value = next; })();
  return value;
};
function derived(store, fn) {
  const result = writable(undefined);
  store.subscribe((value) => result.set(fn(value)));
  return { subscribe: result.subscribe };
}
const context = createContext({ localStorage: { getItem: () => null, setItem: () => {} } });
function synthetic(exports) {
  return new SyntheticModule(Object.keys(exports), function () {
    for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
  }, { context });
}
const dependencies = {
  "svelte/store": synthetic({ writable, derived, get }),
  "./i18n": synthetic({ Translator: class { t(key) { return key; } }, DEFAULT_LANG: "en" }),
  "./lib/operation": synthetic({ redactLog: (value) => value }),
};
const source = readFileSync(new URL("../store.ts", import.meta.url), "utf8");
const module = new SourceTextModule(stripTypeScriptTypes(source), { context, identifier: "store.ts" });
await module.link((specifier) => {
  assert.ok(dependencies[specifier], `unexpected import ${specifier}`);
  return dependencies[specifier];
});
await module.evaluate();
const store = module.namespace;
for (const name of ["beginDownloadBatch", "activateDownloadBatch", "isCurrentDownloadBatch",
  "setDownloadBatchPhase", "canDisplayDownloadBatch", "downloadBatchUnknown", "downloadBatchToken"]) {
  assert.equal(typeof store[name], "function", `${name} must exist`);
}

// Exercise the actual store with a synchronous in-memory Svelte-store substitute.
const items = () => get(store.downloadItems);
const visible = (mode) => store.canDisplayDownloadBatch(items(), mode) && get(store.downloadMode) === mode;
store.activeOperation.set("download");
store.downloadMode.set("video");
store.downloadItems.set([{ url: "old", status: "done" }]);
assert.equal(visible("video"), false, "unmarked data must stay hidden");
const batchA = store.beginDownloadBatch();
store.activateDownloadBatch(batchA, "video");
assert.equal(visible("video"), true);
store.markDownloadItem(0, "running");
assert.equal(items()[0].status, "running");
store.setDownloadBatchPhase(batchA, "unknown");
assert.equal(visible("video"), false);
assert.equal(store.downloadBatchUnknown(items(), "video"), true);
store.markDownloadItem(0, "done");
assert.equal(items()[0].status, "running", "late events cannot change unknown data");

const snapshots = [];
const snapshot = () => {
  const current = items();
  snapshots.push({
    video: store.canDisplayDownloadBatch(current, "video") && get(store.downloadMode) === "video",
    audio: store.canDisplayDownloadBatch(current, "audio") && get(store.downloadMode) === "audio",
    urls: Array.from(current, (item) => item?.url),
  });
};
const offItems = store.downloadItems.subscribe(snapshot);
const offMode = store.downloadMode.subscribe(snapshot);
snapshots.length = 0;
const batchB = store.beginDownloadBatch();
store.downloadItems.set([{ url: "new", status: "pending" }]);
store.downloadMode.set("audio");
store.activateDownloadBatch(batchB, "audio");
assert.ok(snapshots.length >= 4);
assert.ok(snapshots.every((snapshot) => !snapshot.video));
assert.ok(snapshots.every((snapshot) => !snapshot.audio || snapshot.urls[0] === "new"));
assert.equal(visible("audio"), true);
assert.equal(store.isCurrentDownloadBatch(batchA), false);
assert.equal(store.isCurrentDownloadBatch(batchB), true);
store.setDownloadBatchPhase(batchA, "unknown");
assert.equal(visible("audio"), true, "an old token cannot hide a later batch");
store.markDownloadItem(0, "done");
store.setDownloadBatchPhase(batchB, "finalizing");
assert.equal(visible("audio"), false);
store.markDownloadItem(0, "error");
assert.equal(items()[0].status, "done", "events cannot change finalizing items");
store.downloadItems.update((current) => current.map((item) => ({ ...item, status: "error" })));
store.setDownloadBatchPhase(batchB, "terminal");
assert.equal(visible("audio"), true);
store.markDownloadItem(0, "done");
assert.equal(items()[0].status, "error", "events cannot change terminal items");
const mixed = [{ ...items()[0] }, { url: "untagged", status: "done" }];
store.downloadItems.set(mixed);
assert.equal(visible("audio"), false, "partially tagged data must stay hidden");
store.downloadItems.set([items()[0], ,]);
assert.equal(visible("audio"), false, "sparse batches must stay hidden");
offItems();
offMode();

// The real start/stop functions are extracted; component lifetimes and transport are synthetic.
const componentSource = readFileSync(new URL("../tabs/DownloadTab.svelte", import.meta.url), "utf8");
const startSource = componentSource.match(/async function start\(\) \{[\s\S]*?\r?\n  \}(?=\s*async function stop)/)?.[0];
const stopSource = componentSource.match(/async function stop\(\) \{[\s\S]*?\r?\n  \}(?=\s*\/\/|\s*const inputCls)/)?.[0];
assert.ok(startSource && stopSource);
assert.match(componentSource, /\{#if canDisplayDownloadBatch\(\$downloadItems, mode\)\}/);
assert.match(componentSource, /\{#if downloadBatchUnknown\(\$downloadItems, mode\)\}/);
assert.match(componentSource, /downloadBatchToken\(\$downloadItems, mode\)/);
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const requests = [], stopRequests = [], toasts = [];
const fakeApi = {
  startDownload: (args) => { const result = deferred(); requests.push({ args, result }); return result.promise; },
  stop: () => { const result = deferred(); stopRequests.push(result); return result.promise; },
};
function mountSynthetic(mode, urls) {
  const vm = createContext({
    urlList: urls, formats: {}, validSavePath: true, validCookieFile: true, mode,
    downloadResultUnreliable: false, videoFmt: "mp4", audioFmt: "mp3", quality: "best",
    savePath: "/synthetic", browser: "none", cookieFile: "", bitrate: "192", stopping: false,
    api: fakeApi, isValidDownloadResult, operationOutcome, redactLog: (value) => value,
    safeAiErrorText, // OpenAI-Codex_app_ui
    toast: (message, kind) => toasts.push([message, kind]), tr: (key) => key,
    ...Object.fromEntries([
      "busy", "activeOperation", "eventReady", "downloadItems", "downloadMode", "progress",
      "beginDownloadBatch", "activateDownloadBatch", "setDownloadBatchPhase", "isCurrentDownloadBatch",
      "isIdleDownloadBatch", "downloadBatchToken",
    ].map((name) => [name, store[name]])),
  });
  const subscriptions = ["busy", "activeOperation", "eventReady", "downloadItems", "downloadMode"].map((name) =>
    store[name].subscribe((value) => { vm[`$${name}`] = value; }));
  runInContext(`${stripTypeScriptTypes(startSource)}\n${stopSource}\nthis.startDownload = start; this.stopDownload = stop;`, vm);
  return { vm, unmount: () => subscriptions.forEach((off) => off()) };
}
function result(urls, statuses, cancelled = false) {
  const values = statuses.map((ok, index) => [urls[index], ok, ok ? "" : "synthetic failure"]);
  return { results: values, summary: { total: urls.length, succeeded: statuses.filter(Boolean).length,
    failed: statuses.filter((ok) => !ok).length, skipped: urls.length - statuses.length, cancelled } };
}
function resetSynthetic() {
  store.busy.set(false);
  store.activeOperation.set(null);
  store.eventReady.set(true);
  store.downloadItems.set([]);
  store.downloadMode.set(null);
  requests.length = 0;
  stopRequests.length = 0;
  toasts.length = 0;
}

// A destroyed instance may still finish its request; the new instance shares the actual store.
resetSynthetic();
const videoA = mountSynthetic("video", ["synthetic-video-a"]);
const pendingA = videoA.vm.startDownload();
assert.equal(get(store.busy), true);
store.markDownloadItem(0, "done");
videoA.unmount();
const videoRemounted = mountSynthetic("video", ["synthetic-video-b"]);
requests[0].result.resolve({ results: [["synthetic-video-a", true, "contradiction"]],
  summary: { total: 1, succeeded: 1, failed: 0, skipped: 0, cancelled: false } });
await pendingA;
assert.equal(store.downloadBatchUnknown(items(), "video"), true);
assert.equal(visible("video"), false);
assert.equal(videoRemounted.vm.downloadResultUnreliable, false);
assert.equal(get(store.busy), false);
assert.equal(get(store.activeOperation), null);

// Every synchronous store notification hides the old untrusted batch while starting another mode.
const audio = mountSynthetic("audio", ["synthetic-audio"]);
const remountSnapshots = [];
const checkRemount = () => remountSnapshots.push({
  video: visible("video"), audio: visible("audio"), urls: Array.from(items(), (item) => item?.url),
});
const remountOffItems = store.downloadItems.subscribe(checkRemount);
const remountOffMode = store.downloadMode.subscribe(checkRemount);
const remountOffBusy = store.busy.subscribe(checkRemount);
const remountOffActive = store.activeOperation.subscribe(checkRemount);
remountSnapshots.length = 0;
const pendingAudio = audio.vm.startDownload();
assert.ok(remountSnapshots.length > 0);
assert.ok(remountSnapshots.every((snapshot) => !snapshot.video));
assert.ok(remountSnapshots.every((snapshot) => !snapshot.audio || snapshot.urls[0] === "synthetic-audio"));
assert.equal(visible("audio"), true);
requests[1].result.resolve(result(["synthetic-audio"], [], true));
await pendingAudio;
assert.equal(items()[0].status, "skipped");
assert.equal(toasts.at(-1)[0], "operation_cancelled");
audio.vm.urlList = ["synthetic-audio-next"];
remountSnapshots.length = 0;
const pendingSameMode = audio.vm.startDownload();
assert.ok(remountSnapshots.length > 0);
assert.equal(remountSnapshots[0].audio, false, "the previous terminal batch is hidden before notification");
assert.ok(remountSnapshots.every((snapshot) => !snapshot.audio || snapshot.urls[0] === "synthetic-audio-next"));
requests[2].result.resolve(result(["synthetic-audio-next"], [true]));
await pendingSameMode;
remountOffItems();
remountOffMode();
remountOffBusy();
remountOffActive();
videoRemounted.unmount();
audio.unmount();

// Force a successor before an older promise settles to check both stop paths and finally guards.
for (const [firstMode, nextMode, lateStop, lateStart] of [
  ["video", "video", "success", "success"],
  ["video", "audio", "false", "reject"],
  ["audio", "video", "reject", "success"],
]) {
  resetSynthetic();
  const first = mountSynthetic(firstMode, ["synthetic-first"]);
  const firstRun = first.vm.startDownload();
  const firstStop = first.vm.stopDownload();
  store.busy.set(false);
  store.activeOperation.set(null);
  const next = firstMode === nextMode ? first : mountSynthetic(nextMode, ["synthetic-next"]);
  next.vm.urlList = ["synthetic-next"];
  const nextRun = next.vm.startDownload();
  const nextStop = next.vm.stopDownload();
  const nextToken = store.downloadBatchToken(items());
  assert.equal(next.vm.stopping, true);
  const before = toasts.length;
  if (lateStop === "reject") stopRequests[0].reject(new Error("synthetic late stop"));
  else stopRequests[0].resolve({ stopping: lateStop === "success" });
  await firstStop;
  assert.equal(toasts.length, before);
  assert.equal(next.vm.stopping, true);
  if (lateStart === "reject") requests[0].result.reject(new Error("synthetic late request"));
  else requests[0].result.resolve(result(["synthetic-first"], [true]));
  await firstRun;
  assert.equal(toasts.length, before);
  assert.equal(store.downloadBatchToken(items()), nextToken);
  assert.equal(items()[0].url, "synthetic-next");
  assert.equal(get(store.busy), true);
  assert.equal(get(store.activeOperation), "download");
  stopRequests[1].resolve({ stopping: true });
  await nextStop;
  requests[1].result.resolve(result(["synthetic-next"], [false]));
  await nextRun;
  assert.equal(items()[0].status, "error");
  assert.equal(get(store.busy), false);
  first.unmount();
  if (next !== first) next.unmount();
}

// A rejected request after unmount must remain hidden for a fresh instance.
resetSynthetic();
const rejected = mountSynthetic("audio", ["synthetic-rejected"]);
const rejectedRun = rejected.vm.startDownload();
store.markDownloadItem(0, "done");
rejected.unmount();
const rejectedRemount = mountSynthetic("audio", ["synthetic-later"]);
requests[0].result.reject(new Error("synthetic transport failure"));
await rejectedRun;
assert.equal(store.downloadBatchUnknown(items(), "audio"), true);
assert.equal(visible("audio"), false);
assert.equal(toasts.length, 1);
assert.notEqual(toasts[0][0], "operation_unknown");
rejectedRemount.unmount();

// A new start triggered synchronously by busy=false must survive the older finally block.
resetSynthetic();
const oldInstance = mountSynthetic("video", ["synthetic-old"]);
const nextInstance = mountSynthetic("audio", ["synthetic-successor"]);
const oldRun = oldInstance.vm.startDownload();
let trigger = true, successorRun;
const offBusy = store.busy.subscribe((busy) => {
  if (!busy && trigger) {
    trigger = false;
    successorRun = nextInstance.vm.startDownload();
  }
});
requests[0].result.resolve(result(["synthetic-old"], [true]));
await oldRun;
assert.ok(successorRun);
assert.equal(get(store.busy), true);
assert.equal(get(store.activeOperation), "download");
assert.equal(items()[0].url, "synthetic-successor");
requests[1].result.resolve(result(["synthetic-successor"], [true]));
await successorRun;
offBusy();
oldInstance.unmount();
nextInstance.unmount();

// Reentrant starts during the first item notification cannot claim the same slot.
resetSynthetic();
const firstClaim = mountSynthetic("video", ["synthetic-first-claim"]);
const secondClaim = mountSynthetic("audio", ["synthetic-second-claim"]);
let attemptClaim = false, secondClaimRun;
const offClaim = store.downloadItems.subscribe(() => {
  if (attemptClaim) { attemptClaim = false; secondClaimRun = secondClaim.vm.startDownload(); }
});
attemptClaim = true;
const firstClaimRun = firstClaim.vm.startDownload();
await secondClaimRun;
assert.equal(requests.length, 1);
assert.equal(items()[0].url, "synthetic-first-claim");
requests[0].result.resolve(result(["synthetic-first-claim"], [true]));
await firstClaimRun;
offClaim();
firstClaim.unmount();
secondClaim.unmount();

// A subscriber starting a successor during finalization cannot receive the older result.
resetSynthetic();
const finalizingOld = mountSynthetic("video", ["synthetic-finalizing-old"]);
const finalizingNext = mountSynthetic("audio", ["synthetic-finalizing-next"]);
const finalizingRun = finalizingOld.vm.startDownload();
const finalizingToken = store.downloadBatchToken(items());
let finalizingArmed = false, finalizingNextRun;
const offFinalizing = store.downloadItems.subscribe((current) => {
  if (finalizingArmed && store.downloadBatchToken(current) === finalizingToken &&
      !store.canDisplayDownloadBatch(current, "video") && !store.downloadBatchUnknown(current, "video")) {
    finalizingArmed = false;
    store.busy.set(false);
    store.activeOperation.set(null);
    finalizingNext.vm.$busy = false;
    finalizingNextRun = finalizingNext.vm.startDownload();
  }
});
finalizingArmed = true;
requests[0].result.resolve(result(["synthetic-finalizing-old"], [true]));
await finalizingRun;
assert.ok(finalizingNextRun);
assert.equal(get(store.busy), true);
assert.equal(get(store.activeOperation), "download");
assert.equal(items()[0].url, "synthetic-finalizing-next");
assert.equal(items()[0].status, "pending");
requests[1].result.resolve(result(["synthetic-finalizing-next"], [true]));
await finalizingNextRun;
offFinalizing();
finalizingOld.unmount();
finalizingNext.unmount();

// Run the actual App event callback behind the actual coordinator's ID filter.
const appSource = readFileSync(new URL("../App.svelte", import.meta.url), "utf8");
const eventBody = appSource.match(/void api\.onEvent\(\(e: EngineEvent\) => \{([\s\S]*?)\n    \}\)\.then/)?.[1];
assert.ok(eventBody, "App event callback must exist");
const eventLogs = [];
const eventVm = createContext({
  $lang: "en", $activeOperation: null,
  Translator: class { t(key) { return key; } },
  pushLog: (...args) => eventLogs.push(args),
  markDownloadItem: store.markDownloadItem, progress: store.progress,
});
const offEventActive = store.activeOperation.subscribe((value) => { eventVm.$activeOperation = value; });
runInContext(`${stripTypeScriptTypes(`function handle(e: unknown) { ${eventBody}\n}`)}\nthis.handleEvent = handle;`, eventVm);
resetSynthetic();
const eventToken = store.beginDownloadBatch();
store.downloadItems.set([{ url: "synthetic-event", status: "pending" }]);
store.downloadMode.set("video");
store.activateDownloadBatch(eventToken, "video");
store.activeOperation.set("download");
const work = deferred();
const coordinator = new OperationCoordinator({
  prepare: async () => ({ operation_id: "current-operation", instance_id: "synthetic-instance", expires_in: 120 }),
  release: async () => ({ released: false }), stop: async () => ({ stopping: true }),
  status: async () => ({ state: "running", instance_id: "synthetic-instance", idle: false }),
}, { setTimer: () => 1, clearTimer: () => {} });
const coordinatedRun = coordinator.run("download", () => work.promise);
for (let i = 0; i < 12; i++) await Promise.resolve();
assert.equal(coordinator.acceptsEvent({ operation_id: "current-operation" }), true);
const event = (value) => { if (coordinator.acceptsEvent(value)) eventVm.handleEvent(value); };
event({ type: "log", key: "log_item_done", level: "ok", fmt: { i: 1 }, operation_id: "old-operation" });
event({ type: "log", key: "log_item_done", level: "ok", fmt: { i: 1 } });
assert.equal(items()[0].status, "pending");
event({ type: "log", key: "log_item_done", level: "ok", fmt: { i: 1 }, operation_id: "current-operation" });
assert.equal(items()[0].status, "done");
store.setDownloadBatchPhase(eventToken, "terminal");
event({ type: "log", key: "log_item_error", level: "error", fmt: { i: 1 }, operation_id: "current-operation" });
assert.equal(items()[0].status, "done");
work.resolve("synthetic terminal result");
await coordinatedRun;
store.setDownloadBatchPhase(eventToken, "live");
store.markDownloadItem(0, "error");
store.progress.set(null);
event({ type: "log", key: "log_item_done", level: "ok", fmt: { i: 1 } });
event({ type: "item_start", index: 1, total: 1, url: "synthetic-event" });
event({ type: "progress", pct: 80, speed: "--", eta: "--" });
assert.equal(items()[0].status, "error", "untagged late events must not alter items");
assert.equal(get(store.progress), null);
assert.ok(eventLogs.length >= 2, "event log remains available when its state update is rejected");
offEventActive();
console.log("Shared download batch synthetic checks passed.");
