// OpenAI-Codex_app_ui, OpenAI-Codex_Fork_Source_Code: in-memory checks of the browser mock contract.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { createContext, SourceTextModule } from "node:vm";

const context = createContext({
  URL,
  setTimeout: (callback, ms) => { if (ms < 10000) queueMicrotask(callback); return 1; },
  clearTimeout: () => {},
});
const source = readFileSync(new URL("../api.ts", import.meta.url), "utf8") + "\nexport { MockApi };\n";
const mod = new SourceTextModule(stripTypeScriptTypes(source, { mode: "strip" }), {
  context,
  initializeImportMeta(meta) { meta.env = {}; },
});
await mod.link((specifier) => {
  const files = {
    "./lib/operationCoordinator": "./operationCoordinator.ts",
    "./lib/eventStream": "./eventStream.ts",
  };
  if (!files[specifier]) throw new Error(`Unexpected runtime import: ${specifier}`);
  return new SourceTextModule(stripTypeScriptTypes(readFileSync(new URL(files[specifier], import.meta.url), "utf8")), { context });
});
await mod.evaluate();
const { api, MockApi } = mod.namespace;
const offEvents = await api.onEvent(() => {});

const conversion = api.startConvert({ files: ["/a.mkv", "/b.mkv"], dst_fmt: "mp4", save_path: "/out" });
await api.stop();
const result = await conversion;
assert.equal(result.jobs.length, 2);
assert.ok(result.jobs.every((job) => job.status === "skipped"));
assert.equal(result.summary.succeeded, 0);
assert.equal(result.summary.skipped, 2);
assert.equal(result.summary.cancelled, true);

const preview = await api.previewConvert({ files: ["/a.mkv", "/a.mov"], dst_fmt: "mp4", save_path: "/out" });
assert.ok(preview.jobs.every((job) => job.existing === "unknown" && job.source_matches === "unknown"));
assert.ok(preview.jobs.every((job) => job.batch_duplicate));
const queuePreview = await api.previewQueue([
  { kind: "convert", task_id: "custom-1", label: "a", src_path: "/one/a.mkv", dst_path: "/custom/name.mp4" },
  { kind: "convert", task_id: "custom-2", label: "b", src_path: "/two/b.mov", dst_path: "/custom/other.mp4" },
]);
assert.equal(queuePreview.jobs[0].task_id, "custom-1");
assert.equal(queuePreview.jobs[0].dst, "/custom/name.mp4");
assert.ok(queuePreview.jobs.every((job) => job.existing === "unknown" && job.source_matches === "unknown" && job.batch_duplicate));

const plan = await api.aiPlan("", "https://example.test/item", { save_path: "", browser: "none" });
assert.equal(plan.tasks.length, 0);
assert.ok(plan.warnings.length > 0);
offEvents();

const mock = new MockApi();
const reservation = await mock.prepare("convert");
const running = mock.startConvert({ files: ["/a.mkv"], dst_fmt: "mp4", save_path: "/out", operation_id: reservation.operation_id });
const beforeRelease = mock.status(reservation.operation_id);
const refusedRelease = mock.release(reservation.operation_id);
const afterRelease = mock.status(reservation.operation_id);
assert.equal((await beforeRelease).state, "running");
assert.equal((await refusedRelease).released, false);
assert.equal((await afterRelease).state, "running");
await running;
assert.equal((await mock.status(reservation.operation_id)).state, "completed");
