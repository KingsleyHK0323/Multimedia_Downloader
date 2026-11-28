// OpenAI-Codex_app_ui: focused, side-effect-free contract checks.
import assert from "node:assert/strict";
import { operationOutcome, redactLog, reconcileTaskStatuses, isAbsoluteNativePath, PreviewGeneration } from "./operation.ts";

const summary = (overrides = {}) => ({
  total: 2, succeeded: 2, failed: 0, skipped: 0, cancelled: false, ...overrides,
});

assert.equal(operationOutcome(summary()), "succeeded");
assert.equal(operationOutcome(summary({ succeeded: 1, failed: 1 })), "partial");
assert.equal(operationOutcome(summary({ succeeded: 0, failed: 2 })), "failed");
assert.equal(operationOutcome(summary({ succeeded: 0, failed: 1, skipped: 1 })), "partial");
assert.equal(operationOutcome(summary({ succeeded: 1, skipped: 1 })), "partial");
assert.equal(operationOutcome(summary({ succeeded: 1, skipped: 1, cancelled: true })), "cancelled");
assert.equal(operationOutcome(undefined), "unknown");
assert.equal(operationOutcome(summary({ succeeded: 0, failed: 0, skipped: 0 })), "unknown");

const clean = redactLog("Fetch https://demo:example@example.test/file?token=example#secret Bearer example-secret");
assert.ok(!clean.includes("demo:example"));
assert.ok(!clean.includes("token=example"));
assert.ok(!clean.includes("#secret"));
assert.ok(!clean.includes("example-secret"));
assert.ok(clean.includes("example.test/file"));
const namedSecrets = redactLog('api_key="example-key" access_token=example-token Cookie: session=example-cookie');
assert.ok(!namedSecrets.includes("example-key"));
assert.ok(!namedSecrets.includes("example-token"));
assert.ok(!namedSecrets.includes("example-cookie"));

assert.deepEqual(reconcileTaskStatuses([
  { task_id: "first", status: "done" },
  { task_id: "second", status: "error" },
]), { first: "done", second: "error" });

assert.equal(isAbsoluteNativePath(String.raw`C:\Media\clip.mp4`), true);
assert.equal(isAbsoluteNativePath(String.raw`\\server\share\clip.mp4`), true);
assert.equal(isAbsoluteNativePath("/home/user/clip.mp4"), true);
assert.equal(isAbsoluteNativePath("clip.mp4"), false);
assert.equal(isAbsoluteNativePath("C:clip.mp4"), false);
assert.equal(isAbsoluteNativePath("/tmp/clip\u0000.mp4"), false);

// OpenAI-Codex_Fork_Source_Code: previews cannot reappear after a conversion.
const generation = new PreviewGeneration();
let visible = null;
async function receivePreview(response) {
  const ticket = generation.capture();
  const value = await response;
  if (generation.isCurrent(ticket)) visible = value;
}
await receivePreview(Promise.resolve("missing"));
assert.equal(visible, "missing");
let resolveBeforeStart;
const beforeStart = receivePreview(new Promise((resolve) => { resolveBeforeStart = resolve; }));
generation.invalidate(); // Conversion begins after the preview was displayed.
visible = null;
resolveBeforeStart("missing");
await beforeStart;
assert.equal(visible, null);
let resolveLate;
const late = receivePreview(new Promise((resolve) => { resolveLate = resolve; }));
generation.invalidate(); // Conversion finishes before the outstanding reply.
visible = null;
resolveLate("missing");
await late;
assert.equal(visible, null);
await receivePreview(Promise.resolve("exists"));
assert.equal(visible, "exists");
let input = "A";
const initialKey = input;
const originalGeneration = generation.capture();
input = "B";
generation.invalidate();
input = "A";
generation.invalidate();
assert.equal(input, initialKey);
assert.equal(generation.isCurrent(originalGeneration), false);

// OpenAI-Codex_web_ai: check complete URL masking before header substitutions.
const syntheticUrlCases = [
  ["userinfo apostrophe", "https://FAKE_USER'FAKE_PART:FAKE_PASS@example.invalid/watch", ["FAKE_USER", "FAKE_PART", "FAKE_PASS"]],
  ["leading userinfo apostrophe", "https://'FAKE_USER:FAKE_PASS@example.invalid/watch", ["FAKE_USER", "FAKE_PASS"]],
  ["query apostrophe", "https://example.invalid/watch?token=FAKE_HEAD'FAKE_TAIL", ["FAKE_HEAD", "FAKE_TAIL"]],
  ["fragment apostrophe", "https://example.invalid/watch#FAKE_HEAD'FAKE_TAIL", ["FAKE_HEAD", "FAKE_TAIL"]],
  ["consecutive apostrophes", "https://FAKE_USER''FAKE_PART:FAKE_PASS@example.invalid/watch?x=FAKE_HEAD''FAKE_TAIL", ["FAKE_USER", "FAKE_PART", "FAKE_PASS", "FAKE_HEAD", "FAKE_TAIL"]],
  ["single-quoted URL", "Fetch 'https://FAKE_USER'FAKE_PART:FAKE_PASS@example.invalid/watch?x=FAKE_HEAD'FAKE_TAIL' done.", ["FAKE_USER", "FAKE_PART", "FAKE_PASS", "FAKE_HEAD", "FAKE_TAIL"]],
  ["double-quoted URL", 'Fetch "https://example.invalid/watch?x=FAKE_HEAD\'FAKE_TAIL" done.', ["FAKE_HEAD", "FAKE_TAIL"]],
  ["trailing query apostrophe", "https://example.invalid/watch?token=FAKE_HEAD'", ["FAKE_HEAD"]],
  ["trailing fragment apostrophe", "https://example.invalid/watch#FAKE_HEAD'", ["FAKE_HEAD"]],
  ["adjacent quoted URLs", "Links 'https://example.invalid/a','https://FAKE_USER:FAKE_PASS@example.test/b?x=FAKE_QUERY'.", ["FAKE_USER", "FAKE_PASS", "FAKE_QUERY"]],
  ["ambiguous nested URL", "https://example.invalid/watch?next=FAKE_HEAD','https://example.test/FAKE_TAIL", ["FAKE_HEAD", "FAKE_TAIL"]],
  ["nested URL in query", "https://example.invalid/watch?next=https://example.test/FAKE_TAIL", ["FAKE_TAIL"]],
  ["authorization userinfo", "https://Authorization='FAKE_HEAD'FAKE_TAIL@example.invalid/watch", ["FAKE_HEAD", "FAKE_TAIL"]],
  ["cookie userinfo", "https://Cookie='FAKE_HEAD'FAKE_TAIL@example.invalid/watch", ["FAKE_HEAD", "FAKE_TAIL"]],
  ["proxy authorization userinfo", "https://Proxy-Authorization='FAKE_HEAD'FAKE_TAIL@example.invalid/watch", ["FAKE_HEAD", "FAKE_TAIL"]],
  ["set cookie userinfo", "https://Set-Cookie='FAKE_HEAD'FAKE_TAIL@example.invalid/watch", ["FAKE_HEAD", "FAKE_TAIL"]],
  ["authorization query", "https://example.invalid/watch?Authorization='FAKE_HEAD'FAKE_TAIL", ["FAKE_HEAD", "FAKE_TAIL"]],
  ["cookie fragment", "https://example.invalid/watch#Cookie='FAKE_HEAD'FAKE_TAIL", ["FAKE_HEAD", "FAKE_TAIL"]],
  ["header-like wrapped URL", "Fetch 'https://Authorization='FAKE_HEAD'FAKE_TAIL@example.invalid/watch?Cookie='FAKE_MORE'FAKE_LAST' done.", ["FAKE_HEAD", "FAKE_TAIL", "FAKE_MORE", "FAKE_LAST"]],
  // OpenAI-Codex_web_ai: keep full header values covered when they contain URLs.
  ["authorization header with URL", "Authorization: Basic FAKE_AUTH https://example.invalid/watch?x=FAKE_QUERY", ["FAKE_AUTH", "FAKE_QUERY"]],
  ["cookie header with URL", "Cookie: session=FAKE_SESSION; source=https://example.invalid/watch?x=FAKE_QUERY", ["FAKE_SESSION", "FAKE_QUERY"]],
];
const syntheticUrlFailures = [];
for (const [name, value, markers] of syntheticUrlCases) {
  const safe = redactLog(value);
  const repeated = redactLog(safe);
  if (markers.some((marker) => safe.includes(marker) || repeated.includes(marker))) syntheticUrlFailures.push(name + " leak");
  if (safe !== repeated) syntheticUrlFailures.push(name + " idempotence");
}
assert.deepEqual(syntheticUrlFailures, [], "synthetic URL cases must be redacted and stable");
assert.equal(redactLog("Visit 'https://example.invalid/watch' when ready."), "Visit 'https://example.invalid/watch' when ready.");
assert.equal(redactLog("An ordinary diagnostic remains unchanged."), "An ordinary diagnostic remains unchanged.");

// OpenAI-Codex_web_ai: conservatively hide ambiguous URLs with raw double quotes.
const syntheticDoubleQuoteUrls = [
  ["double quote userinfo", 'https://FAKE_HEAD"FAKE_TAIL:FAKE_PASS@example.invalid/watch', ["FAKE_HEAD", "FAKE_TAIL", "FAKE_PASS"]],
  ["leading double quote userinfo", 'https://"FAKE_HEAD:FAKE_PASS@example.invalid/watch', ["FAKE_HEAD", "FAKE_PASS"]],
  ["double quote query", 'https://example.invalid/watch?x=FAKE_HEAD"FAKE_TAIL', ["FAKE_HEAD", "FAKE_TAIL"]],
  ["double quote fragment", 'https://example.invalid/watch#FAKE_HEAD"FAKE_TAIL', ["FAKE_HEAD", "FAKE_TAIL"]],
  ["double quote header userinfo", 'https://Authorization="FAKE_HEAD"FAKE_TAIL@example.invalid/watch', ["FAKE_HEAD", "FAKE_TAIL"]],
  ["double quote wrapped URL", 'Fetch "https://FAKE_HEAD"FAKE_TAIL:FAKE_PASS@example.invalid/watch" done.', ["FAKE_HEAD", "FAKE_TAIL", "FAKE_PASS"]],
  ["double quote URL in JSON", JSON.stringify({ detail: 'https://example.invalid/watch?x=FAKE_HEAD"FAKE_TAIL', status: 401 }), ["FAKE_HEAD", "FAKE_TAIL"]],
];
const syntheticDoubleQuoteFailures = [];
for (const [name, value, markers] of syntheticDoubleQuoteUrls) {
  const safe = redactLog(value);
  const repeated = redactLog(safe);
  if (markers.some((marker) => safe.includes(marker) || repeated.includes(marker))) syntheticDoubleQuoteFailures.push(name + " leak");
  if (safe !== repeated) syntheticDoubleQuoteFailures.push(name + " idempotence");
}
assert.deepEqual(syntheticDoubleQuoteFailures, [], "ambiguous URLs must be redacted and stable");
assert.equal(redactLog('Visit "https://example.invalid/watch" when ready.'), 'Visit "https://example.invalid/watch" when ready.');

// OpenAI-Codex_web_ai: redact the complete JSON-escaped value on the first pass.
const syntheticEscapedFields = ["api_key", "access_token", "refresh_token", "password", "secret"];
const syntheticEscapedValues = [
  ['double quote', 'FAKE_HEAD"FAKE_TAIL'],
  ['backslash before quote', String.raw`FAKE_HEAD\"FAKE_TAIL`],
];
const syntheticEscapedFailures = [];
for (const key of syntheticEscapedFields) {
  for (const [name, value] of syntheticEscapedValues) {
    const input = JSON.stringify({ [key]: value, status: 401 });
    const safe = redactLog(input);
    const repeated = redactLog(safe);
    if (safe.includes("FAKE_HEAD") || safe.includes("FAKE_TAIL") ||
        repeated.includes("FAKE_HEAD") || repeated.includes("FAKE_TAIL")) {
      syntheticEscapedFailures.push(key + " " + name + " leak");
    }
    if (safe !== repeated) syntheticEscapedFailures.push(key + " " + name + " idempotence");
    if (!safe.includes('"status":401')) syntheticEscapedFailures.push(key + " " + name + " diagnostic");
  }
}
const syntheticSingleQuoted = String.raw`password='FAKE_HEAD\'FAKE_TAIL' status=401`;
const safeSingleQuoted = redactLog(syntheticSingleQuoted);
if (safeSingleQuoted.includes("FAKE_HEAD") || safeSingleQuoted.includes("FAKE_TAIL")) {
  syntheticEscapedFailures.push("single quoted escaped value leak");
}
if (redactLog(safeSingleQuoted) !== safeSingleQuoted) syntheticEscapedFailures.push("single quoted escaped value idempotence");
assert.deepEqual(syntheticEscapedFailures, [], "escaped named values must be redacted and stable");
