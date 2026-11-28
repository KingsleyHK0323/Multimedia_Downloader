// OpenAI-Codex_Fork_Source_Code: isolate update URL handling from real network and storage.
import assert from "node:assert/strict";

const canonical = "https://github.com/KingsleyHK0323/Multimedia_Downloader/releases/latest";
let reply;
let dismissed = null;
let requests = 0;
globalThis.__APP_VERSION__ = "4.3.20";
globalThis.fetch = async (url, options) => {
  requests++;
  assert.equal(url, "https://api.github.com/repos/KingsleyHK0323/Multimedia_Downloader/releases/latest");
  assert.equal(options.headers.Accept, "application/vnd.github+json");
  assert.equal(options.redirect, "error");
  if (reply instanceof Error) throw reply;
  return reply;
};
globalThis.localStorage = {
  getItem: () => dismissed,
  setItem: (_key, value) => { dismissed = value; },
};

const { checkForUpdate, dismissUpdate } = await import("./updateCheck.ts");
const response = (data) => ({ ok: true, json: async () => data });
for (const html_url of [
  "https://example.invalid/fake-release",
  "javascript:alert(1)",
  "https://github.com.example.invalid/KingsleyHK0323/Multimedia_Downloader/releases/latest",
  "https://github.com@evil.example.invalid/path",
  "https://github.com/KingsleyHK0323/Multimedia_Downloader/releases/tag/v4.3.21",
  { href: "https://example.invalid" },
  null,
  undefined,
  canonical,
]) {
  reply = response({ tag_name: "v4.3.21", html_url });
  assert.deepEqual(await checkForUpdate(), { latest: "4.3.21", url: canonical });
}

reply = response({ tag_name: "v4.3.20", html_url: "https://example.invalid" });
assert.equal(await checkForUpdate(), null);
reply = response({ tag_name: "v4.3.21", html_url: "https://example.invalid" });
dismissUpdate("4.3.21");
assert.equal(await checkForUpdate(), null);
dismissed = null;
reply = { ok: false };
assert.equal(await checkForUpdate(), null);
reply = new Error("synthetic offline condition");
assert.equal(await checkForUpdate(), null);
assert.equal(requests, 13);
let reads = 0;
const changing = { tag_name: "v4.3.21", get html_url() {
  return reads++ === 0 ? canonical : "https://example.invalid/late-change";
} };
reply = response(changing);
assert.deepEqual(await checkForUpdate(), { latest: "4.3.21", url: canonical });
const changingProxy = new Proxy({ tag_name: "v4.3.21" }, {
  get(target, key) {
    if (key === "html_url") return reads++ % 2 ? canonical : "https://example.invalid/proxy";
    return Reflect.get(target, key);
  },
});
reply = response(changingProxy);
assert.deepEqual(await checkForUpdate(), { latest: "4.3.21", url: canonical });
assert.equal(requests, 15);
// OpenAI-Codex_Fork_Source_Code: restricted storage must not block update visibility or dismissal.
const originalStorage = globalThis.localStorage;
const storageDefects = [];
reply = response({ tag_name: "v4.3.21", html_url: canonical });
globalThis.localStorage = {
  getItem() { throw new Error("synthetic read denial"); },
  setItem() { throw new Error("synthetic write denial"); },
};
if ((await checkForUpdate())?.latest !== "4.3.21") storageDefects.push("update hidden when storage read fails");
try { dismissUpdate("4.3.21"); } catch { storageDefects.push("dismiss throws when storage write fails"); }
const { readFileSync } = await import("node:fs");
const bannerSource = readFileSync(new URL("../components/UpdateBanner.svelte", import.meta.url), "utf8");
const dismissSource = bannerSource.match(/function dismiss\(\) \{[\s\S]*?\n  \}/)?.[0];
assert.ok(dismissSource, "actual banner dismiss handler must be found");
const banner = new Function("dismissUpdate", `let info = { latest: "4.3.21" }; ${dismissSource}; return { dismiss, info: () => info };`)(dismissUpdate);
try { banner.dismiss(); } catch { storageDefects.push("banner handler throws"); }
if (banner.info() !== null) storageDefects.push("banner stays visible after dismissal");
Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("synthetic storage accessor denial"); } });
if ((await checkForUpdate())?.latest !== "4.3.21") storageDefects.push("update hidden when storage accessor fails");
try { dismissUpdate("4.3.21"); } catch { storageDefects.push("dismiss throws when storage accessor fails"); }
Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: originalStorage });
assert.deepEqual(storageDefects, [], `restricted storage defects: ${storageDefects.join("; ")}`);

// OpenAI-Codex_ops_check: reject malformed tags and non-public or beta releases.
for (const data of [
  { tag_name: "v5.invalid.0" }, { tag_name: "v5.0.0-beta" },
  { tag_name: "v9999999999999999999.0.0" }, { tag_name: "v5.0.0", draft: true },
  { tag_name: "v5.0.0", prerelease: true },
]) {
  reply = response(data);
  assert.equal(await checkForUpdate(), null);
}
console.log("Update link and dismissal checks passed using synthetic responses.");
