// OpenAI-Codex: support blank lines and Windows line endings in handler fixtures.
// OpenAI-Codex_web_ai: exercise terminal download errors without a browser or network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { createContext, runInContext, SourceTextModule, SyntheticModule } from "node:vm";
import { isValidDownloadResult } from "./downloadResult.ts";
import { operationOutcome, redactLog, safeAiErrorText } from "./operation.ts";
import { OperationCoordinator } from "./operationCoordinator.ts";

const queue = [];
function writable(initial) {
  let value = initial;
  const subscribers = new Set();
  function set(next) {
    const changed = value !== next || (value !== null && typeof value === "object");
    if (!changed) return;
    value = next;
    const flush = queue.length === 0;
    for (const entry of subscribers) { entry[1](); queue.push(entry, value); }
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
function get(store) { let value; store.subscribe((next) => { value = next; })(); return value; }
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
  "./lib/operation": synthetic({ redactLog }),
};
const storeSource = readFileSync(new URL("../store.ts", import.meta.url), "utf8");
const storeModule = new SourceTextModule(stripTypeScriptTypes(storeSource), { context });
await storeModule.link((specifier) => {
  assert.ok(dependencies[specifier], `unexpected store dependency ${specifier}`);
  return dependencies[specifier];
});
await storeModule.evaluate();
const store = storeModule.namespace;
const component = readFileSync(new URL("../tabs/DownloadTab.svelte", import.meta.url), "utf8");
const startSource = component.match(/async function start\(\) \{[\s\S]*?\r?\n  \}(?=\s*async function stop)/)?.[0];
assert.ok(startSource, "download start handler must exist");

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}
const requests = [];
function mount(mode, urls) {
  const vm = createContext({
    urlList: urls, formats: {}, validSavePath: true, validCookieFile: true, mode,
    downloadResultUnreliable: false, videoFmt: "mp4", audioFmt: "mp3", quality: "best",
    savePath: "/synthetic", browser: "none", cookieFile: "", bitrate: "192", stopping: false,
    api: { startDownload: () => { const pending = deferred(); requests.push(pending); return pending.promise; } },
    isValidDownloadResult, operationOutcome, redactLog, safeAiErrorText,
    toast: () => {}, tr: (key) => key,
    ...Object.fromEntries([
      "busy", "activeOperation", "eventReady", "downloadItems", "downloadMode", "progress",
      "beginDownloadBatch", "activateDownloadBatch", "setDownloadBatchPhase", "isCurrentDownloadBatch",
      "isIdleDownloadBatch", "downloadBatchToken",
    ].map((name) => [name, store[name]])),
  });
  const unsubscribers = ["busy", "activeOperation", "eventReady", "downloadItems", "downloadMode"].map((name) =>
    store[name].subscribe((value) => { vm[`$${name}`] = value; }));
  runInContext(`${stripTypeScriptTypes(startSource)}\nthis.startDownload = start;`, vm);
  return { vm, unmount: () => unsubscribers.forEach((off) => off()) };
}
function reset() {
  store.busy.set(false); store.activeOperation.set(null); store.eventReady.set(true);
  store.downloadItems.set([]); store.downloadMode.set(null); requests.length = 0;
}
const items = () => get(store.downloadItems);

// OpenAI-Codex_web_ai: evaluate the real item-error template branches with fake data.
const rowStart = component.indexOf("<!-- OpenAI-Codex_web_ai: display redacted terminal details. -->");
const rowEnd = component.indexOf("</li>", rowStart);
assert.ok(rowStart >= 0 && rowEnd > rowStart);
const row = component.slice(rowStart, rowEnd);
const branchPattern = /\{#if\s+([^}]+)\}|\{:else\}|\{\/if\}|\{(downloadItemErrorText\(item\.error\)|tr\("conversion_error_no_details"\))\}/g;
let branchCode = "const output = [];";
for (const match of row.matchAll(branchPattern)) {
  if (match[1]) branchCode += `if (${match[1]}) {`;
  else if (match[0] === "{:else}") branchCode += "} else {";
  else if (match[0] === "{/if}") branchCode += "}";
  else branchCode += `output.push(${match[2]});`;
}
const renderBranches = new Function("item", "tr", "downloadItemErrorText", branchCode + "return output.join('');");
const formatterSource = component.match(/function downloadItemErrorText\(error: string\): string \{[\s\S]*?\n  \}/)?.[0];
assert.ok(formatterSource);
const formatter = createContext({ redactLog, safeAiErrorText });
runInContext(stripTypeScriptTypes(`${formatterSource}\nthis.format = downloadItemErrorText;`), formatter);
const locales = Object.fromEntries(["en", "zh_tw", "zh_cn"].map((locale) => [locale,
  JSON.parse(readFileSync(new URL(`../../../locales/${locale}.json`, import.meta.url), "utf8"))]));
function renderItem(item, locale) {
  return renderBranches(item, (key) => locales[locale][key], formatter.format);
}
for (const locale of Object.keys(locales)) {
  const fallback = locales[locale].conversion_error_no_details;
  assert.ok(typeof fallback === "string" && fallback.trim(), `${locale} fallback must be translated`);
  for (const error of [undefined, "", "   \t\n"]) {
    assert.equal(renderItem({ status: "error", error }, locale), fallback,
      `${locale} missing or blank failure details must show the fallback`);
  }
  for (const status of ["pending", "running", "done", "skipped"]) {
    assert.equal(renderItem({ status, error: "old error" }, locale), "", `${status} must not display a failure`);
  }
}

reset();
const first = mount("video", ["synthetic-a", "synthetic-b", "synthetic-c"]);
const firstRun = first.vm.startDownload();
const detail = "Request failed https://example.invalid/media?token=SYNTHETIC_SECRET";
requests[0].resolve({
  results: [["synthetic-a", false, detail], ["synthetic-b", true, ""]],
  summary: { total: 3, succeeded: 1, failed: 1, skipped: 1, cancelled: true },
});
await firstRun;
assert.equal(items()[0].status, "error");
assert.equal(items()[0].error, detail, "validated terminal error must be retained");
assert.equal(items()[1].status, "done");
assert.equal(items()[1].error, "", "successful item has no error");
assert.equal(items()[2].status, "skipped");
assert.equal(items()[2].error, "", "unstarted item has no terminal error");
assert.equal(store.canDisplayDownloadBatch(items(), "video"), true);
first.unmount();

reset();
const older = mount("video", ["synthetic-old"]);
const oldRun = older.vm.startDownload();
store.busy.set(false); store.activeOperation.set(null);
const newer = mount("audio", ["synthetic-new"]);
const newRun = newer.vm.startDownload();
const newToken = store.downloadBatchToken(items());
requests[0].resolve({ results: [["synthetic-old", false, "OLD_PRIVATE_ERROR"]],
  summary: { total: 1, succeeded: 0, failed: 1, skipped: 0, cancelled: false } });
await oldRun;
assert.equal(store.downloadBatchToken(items()), newToken);
assert.equal(items()[0].url, "synthetic-new");
assert.equal(items()[0].status, "pending");
assert.equal(items()[0].error, undefined, "late old error must not enter a new batch");
// OpenAI-Codex_web_ai: exercise the actual event callback and operation ID filter.
const app = readFileSync(new URL("../App.svelte", import.meta.url), "utf8");
const eventBody = app.match(/void api\.onEvent\(\(e: EngineEvent\) => \{([\s\S]*?)\n    \}\)\.then/)?.[1];
assert.ok(eventBody, "application event callback must exist");
const eventContext = createContext({
  $lang: "en", $activeOperation: "download",
  Translator: class { t(key) { return key; } }, pushLog: () => {},
  markDownloadItem: store.markDownloadItem, progress: store.progress,
});
runInContext(stripTypeScriptTypes(`function handle(e: unknown) { ${eventBody}\n}\nthis.handleEvent = handle;`), eventContext);
const coordinator = new OperationCoordinator({
  prepare: async () => ({ operation_id: "current-operation", instance_id: "synthetic-instance", expires_in: 120 }),
  release: async () => ({ released: false }), stop: async () => ({ stopping: true }),
  status: async () => ({ state: "running", instance_id: "synthetic-instance", idle: false }),
}, { setTimer: () => 1, clearTimer: () => {} });
const work = deferred();
const coordinatedRun = coordinator.run("download", () => work.promise);
for (let i = 0; i < 12; i++) await Promise.resolve();
const event = (value) => { if (coordinator.acceptsEvent(value)) eventContext.handleEvent(value); };
event({ type: "log", key: "log_item_done", level: "ok", fmt: { i: 1 }, operation_id: "old-operation" });
event({ type: "log", key: "log_item_done", level: "ok", fmt: { i: 1 } });
assert.equal(items()[0].status, "pending", "old or untagged events must not affect the new batch");
event({ type: "log", key: "log_item_error", level: "err", fmt: { i: 1 }, operation_id: "current-operation" });
assert.equal(items()[0].status, "error", "current events still update live items");
assert.equal(renderItem(items()[0], "en"), locales.en.conversion_error_no_details,
  "an SSE error without details must show the fallback");
requests[1].resolve({ results: [["synthetic-new", false, "new error"]],
  summary: { total: 1, succeeded: 0, failed: 1, skipped: 0, cancelled: false } });
await newRun;
assert.equal(items()[0].error, "new error");
assert.equal(renderItem(items()[0], "en"), "new error", "terminal detail must replace the provisional fallback");
event({ type: "log", key: "log_item_done", level: "ok", fmt: { i: 1 }, operation_id: "current-operation" });
assert.equal(items()[0].status, "error", "late events must not alter terminal status");
assert.equal(items()[0].error, "new error", "late events must not replace terminal detail");
work.resolve("synthetic terminal result");
await coordinatedRun;
older.unmount(); newer.unmount();

reset();
const invalid = mount("video", ["synthetic-invalid"]);
const invalidRun = invalid.vm.startDownload();
requests[0].resolve({ results: [["synthetic-invalid", false, 42]],
  summary: { total: 1, succeeded: 0, failed: 1, skipped: 0, cancelled: false } });
await invalidRun;
assert.equal(store.downloadBatchUnknown(items(), "video"), true);
assert.equal(items()[0].error, undefined, "invalid results must not supply item errors");
invalid.unmount();

const helper = component.match(/function downloadItemErrorText\(error: string\): string \{[\s\S]*?\n  \}/)?.[0];
assert.ok(helper, "download errors need a safe formatting helper");
const display = component.match(/\{#if item\.error\}([\s\S]*?)\{\/if\}/)?.[1];
assert.ok(display && /\{downloadItemErrorText\(item\.error\)\}/.test(display), "nonempty item errors must use the safe formatter");
assert.doesNotMatch(display, /\{@html/);
const renderContext = createContext({ redactLog, safeAiErrorText });
runInContext(stripTypeScriptTypes(`${helper}\nthis.renderError = downloadItemErrorText;`), renderContext);
const safe = renderContext.renderError(detail);
assert.ok(!safe.includes("SYNTHETIC_SECRET"), "URL credentials must not appear in displayed errors");
assert.ok(safe.includes("[redacted]"));
const safeHeader = renderContext.renderError("Authorization: SYNTHETIC_HEADER_SECRET");
assert.ok(!safeHeader.includes("SYNTHETIC_HEADER_SECRET"), "header credentials must not appear in displayed errors");
assert.equal(renderContext.renderError(""), "");
renderContext.redactLog = () => { throw new Error("synthetic formatter failure"); };
assert.equal(renderContext.renderError(detail), "[redacted]", "formatter failures must fall back safely");
renderContext.redactLog = () => undefined;
assert.equal(renderContext.renderError(detail), "[redacted]", "non-string formatter results must fall back safely");
console.log("Synthetic download-item error checks passed.");
