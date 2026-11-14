// OpenAI-Codex_app_ui: exercise key-storage state using synthetic values only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { keyStorageView } from "./keyStorage.ts";

const source = readFileSync(new URL("../ai/AiPanel.svelte", import.meta.url), "utf8");
const effect = source.match(/\$effect\(\(\) => \{([\s\S]*?)\n  \}\);/)?.[1];
assert.ok(effect, "key persistence effect must exist");
const readBody = source.match(/function readStored\(key: string\): string \{([\s\S]*?)\n  \}/)?.[1];
assert.ok(readBody, "existing storage read must exist");
assert.equal((source.match(/localStorage\.getItem\(/g) ?? []).length, 1);
assert.doesNotMatch(source, /localStorage\.(removeItem|clear)\(/);
assert.match(source, /oninput=\{markKeyStoragePending\}/);
assert.match(source, /onchange=\{markKeyStoragePending\}/);
assert.match(source, /function markKeyStoragePending\(\) \{ keySaveState = "pending"; keyEditRevision \+= 1; \}/);

{
  const ctx = createContext({ KEY_STORAGE: "synthetic-key", keyReadFailed: false,
    localStorage: { getItem: () => { throw new Error("storage denied"); } } });
  assert.equal(runInContext(`(function(key) { ${readBody} })(KEY_STORAGE)`, ctx), "");
  assert.equal(ctx.keyReadFailed, true);
}

function simulate({ rememberKey = true, apiKey = "synthetic-value", savedKeyExists = false, possibleLegacy = false, fail = false } = {}) {
  const writes = [];
  const ctx = createContext({
    rememberKey, apiKey, savedKeyExists, possibleLegacy, keySaveState: "pending", keyEditRevision: 0, KEY_STORAGE: "synthetic-key",
    localStorage: { setItem: (name, value) => { if (fail) throw new Error("storage denied"); writes.push([name, value]); } },
  });
  runInContext(effect, ctx);
  return { ctx, writes };
}
function view(ctx) {
  return keyStorageView({ remember: ctx.rememberKey, hasValue: Boolean(ctx.apiKey), saveState: ctx.keySaveState,
    savedKeyExists: ctx.savedKeyExists, possibleLegacy: ctx.possibleLegacy });
}

{
  const { ctx, writes } = simulate();
  assert.equal(writes.length, 1);
  assert.equal(ctx.keySaveState, "saved");
  assert.equal(ctx.savedKeyExists, true);
  assert.equal(view(ctx).hint, "ai_key_saved_hint");
}
for (const oldKey of [false, true]) {
  const { ctx, writes } = simulate({ savedKeyExists: oldKey, fail: true });
  assert.equal(writes.length, 0);
  assert.equal(ctx.keySaveState, "failed");
  assert.equal(ctx.savedKeyExists, oldKey);
  assert.equal(ctx.possibleLegacy, true);
  assert.equal(view(ctx).hint, "ai_key_save_failed_hint");
  ctx.rememberKey = false;
  runInContext(effect, ctx);
  assert.equal(view(ctx).hint, "ai_key_session_hint");
  assert.equal(view(ctx).legacy, oldKey ? "ai_key_legacy_hint" : "ai_key_legacy_possible_hint");
}
{
  const { ctx, writes } = simulate({ rememberKey: false, possibleLegacy: true });
  assert.equal(writes.length, 0);
  assert.equal(view(ctx).legacy, "ai_key_legacy_possible_hint");
  ctx.rememberKey = true;
  ctx.apiKey = "";
  runInContext(effect, ctx);
  assert.equal(writes.length, 0);
  assert.equal(view(ctx).hint, "ai_key_session_hint");
  assert.equal(view(ctx).legacy, "ai_key_legacy_possible_hint");
}
assert.equal(keyStorageView({ remember: true, hasValue: true, saveState: "pending", savedKeyExists: true, possibleLegacy: false }).hint, null);
console.log("Key-storage hint checks passed using in-memory fakes.");
