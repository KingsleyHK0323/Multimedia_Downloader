// OpenAI-Codex_app_ui: synthetic checks for the backup log-store connection.
// Source overrides are supplied in memory; the default reads the actual files.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { redactLog } from "./operation.ts";

export function runLogStoreChecks(overrides = {}) {
  const source = (name, path) => {
    const value = Object.hasOwn(overrides, name) ? overrides[name] : readFileSync(new URL(path, import.meta.url), "utf8");
    assert.equal(typeof value, "string", `${name} source must be a string`);
    return value;
  };
  const store = source("store", "../store.ts");
  const app = source("app", "../App.svelte");
  const log = source("log", "../tabs/LogTab.svelte");
  const signature = "export function pushLog(level: string, text: string): void {";
  const start = store.indexOf(signature);
  const end = store.indexOf("\n}", start);
  assert.ok(start >= 0 && end > start, "log append function must exist");
  const appendCode = stripTypeScriptTypes(store.slice(start, end + 2)).replace(/^export /, "");
  let checks = 0;
  const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
  const ok = (actual, message) => { assert.ok(actual, message); checks++; };

  function appender(scrub = redactLog) {
    let entries = [];
    const logs = { update: (fn) => { entries = fn(entries); } };
    const pushLog = new Function("logs", "redactLog", `let _seq = 0; const MAX_LOGS = 2000; ${appendCode}; return pushLog;`)(logs, scrub);
    return { pushLog, entries: () => entries };
  }
  const exportLine = log.split("\n").find((line) => line.trimStart().startsWith("const text = $logs.map("));
  assert.ok(exportLine, "log export expression must exist");
  const exportCode = exportLine.trim().slice("const text = ".length).replace(/;$/, "");
  const render = new Function("$logs", `return ${exportCode};`);

  const current = appender();
  current.pushLog("Authorization: Basic SYNTHETIC_LEVEL_42", "Authorization: Basic SYNTHETIC_TEXT_42");
  let entry = current.entries()[0];
  ok(!entry.level.includes("SYNTHETIC_LEVEL_42"), "log level is redacted");
  ok(!entry.text.includes("SYNTHETIC_TEXT_42"), "log text is redacted");
  const exported = render(current.entries());
  ok(!exported.includes("SYNTHETIC_LEVEL_42") && !exported.includes("SYNTHETIC_TEXT_42"), "export is redacted");
  current.pushLog("warn", "ordinary diagnostic");
  equal(current.entries()[1].level, "warn", "ordinary level remains unchanged");
  equal(current.entries()[1].text, "ordinary diagnostic", "ordinary message remains unchanged");

  for (const invalidLevel of [null, undefined, 5, {}, Symbol("level")]) {
    current.pushLog(invalidLevel, "ordinary");
    equal(current.entries().at(-1).level, "info", "invalid level uses safe fallback");
  }
  const noCoercion = { toString() { throw new Error("synthetic object must not be coerced"); } };
  for (const invalidText of [null, undefined, 5, noCoercion, Symbol("text")]) {
    current.pushLog("info", invalidText);
    equal(current.entries().at(-1).text, "[redacted]", "invalid text uses safe fallback");
  }

  const failedLevel = appender((value) => {
    if (value === "SYNTHETIC_LEVEL_THROW") throw new Error("synthetic failure");
    return redactLog(value);
  });
  failedLevel.pushLog("SYNTHETIC_LEVEL_THROW", "Authorization: Basic SYNTHETIC_TEXT_42");
  equal(failedLevel.entries()[0].level, "info", "level failure uses fallback");
  ok(!failedLevel.entries()[0].text.includes("SYNTHETIC_TEXT_42"), "level failure does not expose text");
  const failedText = appender((value) => {
    if (value === "SYNTHETIC_TEXT_THROW") throw new Error("synthetic failure");
    return redactLog(value);
  });
  failedText.pushLog("Authorization: Basic SYNTHETIC_LEVEL_42", "SYNTHETIC_TEXT_THROW");
  equal(failedText.entries()[0].text, "[redacted]", "text failure uses fallback");
  ok(!failedText.entries()[0].level.includes("SYNTHETIC_LEVEL_42"), "text failure does not expose level");
  const failedBoth = appender(() => { throw new Error("synthetic failure"); });
  failedBoth.pushLog("level", "text");
  equal([failedBoth.entries()[0].level, failedBoth.entries()[0].text], ["info", "[redacted]"], "both failures use fallbacks");
  for (const invalid of [null, undefined, 5, {}]) {
    const invalidResult = appender(() => invalid);
    invalidResult.pushLog("level", "text");
    equal([invalidResult.entries()[0].level, invalidResult.entries()[0].text], ["info", "[redacted]"], "invalid redactor return uses fallbacks");
  }

  // Extract the actual event callback without mounting Svelte or making requests.
  const marker = "api.onEvent((e: EngineEvent) => {";
  const callbackStart = app.indexOf(marker);
  const callbackEnd = app.indexOf("\n    })", callbackStart);
  assert.ok(callbackStart >= 0 && callbackEnd > callbackStart, "app event callback must exist");
  const callbackCode = stripTypeScriptTypes(`function handle(e: unknown) {${app.slice(callbackStart + marker.length, callbackEnd)}\n}`);
  const marks = [], progressUpdates = [];
  class Translator { t(_key, fmt) { return `Fetch ${fmt.url}`; } }
  const handle = new Function("pushLog", "Translator", "$lang", "$activeOperation", "markDownloadItem", "progress", "busy", `${callbackCode}; return handle;`)(
    current.pushLog, Translator, "en", "download", (...args) => marks.push(args),
    { set: (value) => progressUpdates.push(value) }, { set: () => {} },
  );
  const event = Object.freeze({ type: "log", operation_id: "synthetic", level: "Authorization: Basic SYNTHETIC_LEVEL_42",
    key: "log_item_done", fmt: Object.freeze({ i: 1, url: "https://example.invalid/path?x=SYNTHETIC_QUERY_42" }) });
  const before = JSON.stringify(event);
  handle(event);
  equal(JSON.stringify(event), before, "original log event is unchanged");
  equal(marks.at(-1), [0, "done"], "original event still drives item state");
  ok(!render(current.entries()).includes("SYNTHETIC_QUERY_42"), "event-derived log is redacted");
  const progressEvent = Object.freeze({ type: "progress", operation_id: "synthetic", pct: 50, speed: "fake", eta: "fake" });
  const countBefore = current.entries().length;
  handle(progressEvent);
  equal(current.entries().length, countBefore, "progress is not turned into a log");
  equal(progressUpdates.at(-1), { pct: 50, speed: "fake", eta: "fake" }, "progress data is preserved");
  const item = Object.freeze({ type: "item_start", operation_id: "synthetic", index: 2,
    url: "https://example.invalid/raw?x=SYNTHETIC_RAW_42" });
  handle(item);
  equal(item.url, "https://example.invalid/raw?x=SYNTHETIC_RAW_42", "item event retains the original URL");
  equal(marks.at(-1), [1, "running"], "item event still drives state");

  // Non-HTTP schemes, URL paths and unlabeled data have no universal secrecy guarantee.
  const untrusted = "s3://SYNTHETIC_USER:SYNTHETIC_PASS@example.invalid/file?x=SYNTHETIC_QUERY";
  const raw = Object.freeze({ value: untrusted });
  current.pushLog("info", raw.value);
  equal(raw.value, untrusted, "log formatting does not mutate the input");
  ok(typeof current.entries().at(-1).text === "string", "formatted log remains text");
  return checks;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const count = runLogStoreChecks();
  console.log(`Log-store connection: ${count} synthetic checks passed.`);
}