// OpenAI-Codex_engine_cli: isolated conversion result contract checks.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { operationOutcome } from "./operation.ts";
import { safeAiErrorText } from "./operation.ts"; // OpenAI-Codex_app_ui

let isValidConversionResult = () => { throw new Error("conversion result guard is missing"); };
if (existsSync(new URL("./convertResult.ts", import.meta.url))) {
  ({ isValidConversionResult } = await import("./convertResult.ts"));
}
const source = readFileSync(new URL("../tabs/ConvertTab.svelte", import.meta.url), "utf8");
const oldAssignment = source.indexOf("      jobs = Array.isArray(result?.jobs) ? result.jobs : [];");
const blockStart = source.lastIndexOf("      });", oldAssignment) + "      });".length;
const blockEnd = source.indexOf("    } catch (e) {", oldAssignment);
assert.ok(oldAssignment >= 0 && blockStart >= "      });".length && blockEnd > oldAssignment);
const block = source.slice(blockStart, blockEnd);
const applyResult = new Function("result", "startedFiles", "operationOutcome", "isValidConversionResult", "IS_WEB", "toast", "tr", `
  let jobs = [];
  let conversionResultUnreliable = false;
  (() => { ${block} })();
  return jobs;
`);

const files = ["a.mkv"];
const summary = { total: 1, succeeded: 1, failed: 0, skipped: 0, cancelled: false };
const done = { src: "a.mkv", dst: "out/a.mp4", status: "done", error: "" };
const payload = (job, value = summary) => ({ jobs: [job], summary: value });
function present(result, startedFiles = files, isWeb = false) {
  const messages = [];
  const jobs = applyResult(result, startedFiles, operationOutcome, isValidConversionResult, isWeb,
    (key, kind) => messages.push({ key, kind }), (key) => key);
  return { messages, jobs };
}

for (const job of [
  { ...done, status: "error", error: "failed" },
  { ...done, status: "no_ffmpeg", error: "missing" },
  { ...done, status: "skipped" },
  { ...done, status: "converting" },
  { ...done, error: "unexpected" },
  { ...done, src: "other.mkv" },
  { ...done, error: 42 },
  null,
  { status: "done" },
]) {
  const actual = present(payload(job));
  assert.deepEqual(actual.messages, [{ key: "conversion_result_unreliable", kind: "err" }]);
  assert.deepEqual(actual.jobs, []);
}
assert.deepEqual(present(payload(done)).messages, [{ key: "operation_succeeded", kind: "ok" }]);
assert.deepEqual(present(payload({ ...done, status: "no_ffmpeg", error: "missing" },
  { ...summary, succeeded: 0, failed: 1 })).messages, [{ key: "operation_failed", kind: "err" }]);
assert.deepEqual(present(payload({ ...done, status: "skipped" },
  { ...summary, succeeded: 0, skipped: 1, cancelled: true })).messages,
  [{ key: "operation_cancelled", kind: "info" }]);
assert.deepEqual(present(payload({ ...done, src: "/server/downloads/a.mkv" }), files, true).messages,
  [{ key: "operation_succeeded", kind: "ok" }]);
const duplicate = { jobs: [done, done], summary: { ...summary, total: 2, succeeded: 2 } };
assert.deepEqual(present(duplicate, ["a.mkv", "a.mkv"]).messages,
  [{ key: "operation_succeeded", kind: "ok" }]);
for (const result of [
  null,
  payload(done, { ...summary, total: true }),
  payload(done, { ...summary, cancelled: 0 }),
  payload(done, { ...summary, succeeded: 0 }),
  payload({ ...done, status: "skipped", download_url: "/files/old" },
    { ...summary, succeeded: 0, skipped: 1 }),
]) {
  assert.deepEqual(present(result).messages, [{ key: "conversion_result_unreliable", kind: "err" }]);
  assert.deepEqual(present(result).jobs, []);
}

// A failed request may have started conversion, so the warning must survive its catch path.
const catchStart = source.indexOf("    } catch (e) {", oldAssignment);
const catchEnd = source.indexOf("    } finally {", catchStart);
assert.ok(catchStart > oldAssignment && catchEnd > catchStart);
const catchBody = source.slice(catchStart + "    } catch (e) {".length, catchEnd);
const handleError = new Function("e", "toast", "tr", "redactLog", "safeAiErrorText", "let conversionResultUnreliable = false; let conversionError = \"\";\n" + catchBody);
const errors = [];
handleError(new Error("transport failed"), (key, kind) => errors.push({ key, kind }), (key) => key, (value) => value, safeAiErrorText);
assert.deepEqual(errors, [
  { key: "conversion_result_unreliable", kind: "err" },
  { key: "transport failed", kind: "err" },
]);
console.log("Conversion result presentation contract passed.");
