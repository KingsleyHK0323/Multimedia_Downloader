// OpenAI-Codex_app_ui: in-memory AI conversion preview contract checks.
import assert from "node:assert/strict";
import { QueuePreviewSession, queuePreviewInput } from "./queuePreview.ts";

function deferred() { let resolve, reject; const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject }; }
const tasks = [
  { kind: "download", task_id: "download", url: "https://example.test", options: { cookie_file: "sensitive" } },
  { kind: "convert", task_id: "a", label: "A", src_path: "/a.mkv", dst_path: "/a.mp4", conflict_policy: "rename" },
  { kind: "convert", task_id: "b", label: "B", src_path: "/b.mkv", dst_path: "/b.mp4" },
];
const inputs = queuePreviewInput(tasks);
assert.equal(inputs.length, 2);
assert.ok(inputs.every((task) => task.kind === "convert" && !Object.hasOwn(task, "url") && !Object.hasOwn(task, "options")));
assert.equal(queuePreviewInput([{ ...tasks[1], task_id: " " }]), null);
assert.equal(queuePreviewInput([tasks[1], { ...tasks[2], task_id: "a" }]), null);
const good = { jobs: [
  { task_id: "b", src: "server/b.mkv", dst: "server/b.mp4", existing: "unknown", batch_duplicate: false, source_matches: "no" },
  { task_id: "a", src: "server/a.mkv", dst: "server/a.mp4", existing: "exists", batch_duplicate: true, source_matches: "yes" },
] };
for (const bad of [
  { jobs: [good.jobs[0]] },
  { jobs: [good.jobs[0], good.jobs[0]] },
  { jobs: [good.jobs[0], { ...good.jobs[1], task_id: "other" }] },
  { jobs: [good.jobs[0], { ...good.jobs[1], existing: "safe" }] },
  { jobs: [good.jobs[0], { ...good.jobs[1], batch_duplicate: "false" }] },
  { jobs: [good.jobs[0], { ...good.jobs[1], source_matches: "maybe" }] },
  { jobs: [good.jobs[0], { ...good.jobs[1], src: 123 }] },
]) {
  const session = new QueuePreviewSession();
  assert.equal((await session.request(tasks, async () => bad)).kind, "invalid");
}
{
  const session = new QueuePreviewSession(), first = deferred(), second = deferred();
  const a = session.request(tasks, () => first.promise);
  session.invalidate();
  const b = session.request(tasks, () => second.promise);
  first.resolve(good);
  assert.equal((await a).kind, "stale");
  second.resolve(good);
  const result = await b;
  assert.equal(result.kind, "ready");
  assert.equal(result.value.jobs[0].dst, "server/b.mp4");
  session.invalidate();
  assert.equal(session.isCurrent(result.generation), false);
}
{
  const session = new QueuePreviewSession(), pending = deferred();
  const request = session.request(tasks, () => pending.promise);
  session.invalidate();
  pending.reject(new Error("old request failed"));
  assert.equal((await request).kind, "stale");
}
console.log("AI queue preview checks passed using in-memory fakes.");
