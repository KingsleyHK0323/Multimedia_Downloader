// OpenAI-Codex_app_ui: synthetic, in-memory checks of log redaction and export formatting.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { redactLog } from "./operation.ts";

const examples = [
  ["Authorization: Basic SYNTHETIC_BASIC_42", "SYNTHETIC_BASIC_42"],
  ['{"Authorization":"Basic SYNTHETIC_JSON_42", "status":401}', "SYNTHETIC_JSON_42"],
  ['{"Cookie":"session=SYNTHETIC_COOKIE_42; theme=dark", "status":401}', "SYNTHETIC_COOKIE_42"],
  ["Proxy-Authorization: Negotiate SYNTHETIC_PROXY_42", "SYNTHETIC_PROXY_42"],
  ["Set-Cookie: session=SYNTHETIC_SET_42; Path=/", "SYNTHETIC_SET_42"],
  ["Authorization:\r\n  Basic SYNTHETIC_FOLDED_42", "SYNTHETIC_FOLDED_42"],
  [String.raw`{"Authorization":"Basic SYNTHETIC_ESCAPE_42\"tail","status":401}`, "SYNTHETIC_ESCAPE_42"],
  ["Bearer SYNTHETIC_BEARER_42", "SYNTHETIC_BEARER_42"],
  ['api_key="SYNTHETIC_KEY_42"', "SYNTHETIC_KEY_42"],
];
for (const [value, marker] of examples) {
  const safe = redactLog(value);
  assert.ok(!safe.includes(marker), `synthetic ${marker} must be redacted`);
  assert.ok(safe.includes("[redacted]"));
  assert.equal(redactLog(safe), safe, "redaction should be stable on repeated calls");
}
assert.ok(redactLog(examples[1][0]).includes('"status":401'));
assert.equal(redactLog("Conversion failed: unsupported media format"), "Conversion failed: unsupported media format");
const cleanUrl = redactLog("Fetching https://example.invalid/media?token=SYNTHETIC_URL_42#SYNTHETIC_FRAGMENT_42");
assert.ok(!cleanUrl.includes("SYNTHETIC_URL_42") && !cleanUrl.includes("SYNTHETIC_FRAGMENT_42"));
assert.ok(cleanUrl.includes("example.invalid/media"));

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

// Run the actual store append and LogTab export expression against fake in-memory values.
const storeSource = readFileSync(new URL("../store.ts", import.meta.url), "utf8");
const appendSource = storeSource.match(/export function pushLog\(level: string, text: string\): void \{[\s\S]*?\n\}/)?.[0];
assert.ok(appendSource);
let entries = [];
const fakeLogs = { update: (fn) => { entries = fn(entries); } };
const appendScript = stripTypeScriptTypes(appendSource).replace(/^export /, "");
const pushLog = new Function("logs", "redactLog", `let _seq = 0; const MAX_LOGS = 2000; ${appendScript}; return pushLog;`)(fakeLogs, redactLog);
pushLog("err", examples[0][0]);
pushLog("Authorization: Basic SYNTHETIC_LEVEL_42", "synthetic event text");
pushLog("warn", "ordinary level");
pushLog(null, "invalid synthetic level");
assert.equal(entries[2].level, "warn");
assert.equal(entries[3].level, "info");
const logSource = readFileSync(new URL("../tabs/LogTab.svelte", import.meta.url), "utf8");
const exportExpression = logSource.match(/const text = (\$logs\.map\([^\n]+);/)?.[1];
assert.ok(exportExpression);
const exported = new Function("$logs", `return ${exportExpression};`)(entries);
assert.ok(!exported.includes(examples[0][1]));
assert.ok(!exported.includes("SYNTHETIC_LEVEL_42"));
assert.ok(exported.includes("[redacted]"));
console.log("Synthetic log redaction and in-memory export checks passed.");
