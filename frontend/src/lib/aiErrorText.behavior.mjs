// OpenAI-Codex_app_ui: synthetic checks for synchronous error formatting.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { safeAiErrorText } from "./operation.ts";

export function runSafeAiErrorChecks() {
  let checks = 0;
  function equal(actual, expected, message) { assert.deepEqual(actual, expected, message); checks++; }
  equal(safeAiErrorText(() => "ordinary"), "ordinary", "ordinary text");
  equal(safeAiErrorText(() => ""), "", "empty text");
  for (const value of [null, undefined, 0, {}, Promise.resolve("synthetic")]) {
    equal(safeAiErrorText(() => value), "[redacted]", "non-string fallback");
  }
  let calls = 0;
  equal(safeAiErrorText(() => { calls++; throw Error("synthetic"); }), "[redacted]", "exception fallback");
  equal(calls, 1, "callback not retried");
  return checks;
}

if (import.meta.url.startsWith("file:") && process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  console.log("Shared AI error helper: " + runSafeAiErrorChecks() + " synthetic checks passed.");
}
