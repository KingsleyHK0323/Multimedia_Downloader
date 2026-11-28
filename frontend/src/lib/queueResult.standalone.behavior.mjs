// OpenAI-Codex_app_ui: standalone synthetic checks for the AI queue result guard.
// No UI, transport, filesystem mutation, or network access is required.
import assert from "node:assert/strict";
import { isValidQueueResult } from "./queueResult.ts";

const expected = [
  { task_id: "download-1", kind: "download" },
  { task_id: "convert-1", kind: "convert" },
];
const baseline = {
  tasks: [
    { task_id: "download-1", kind: "download", label: "Download", status: "done", error: "", dst_path: null },
    { task_id: "convert-1", kind: "convert", label: "Convert", status: "error", error: "failed", dst_path: "/output.mp4" },
  ],
  summary: { total: 2, succeeded: 1, failed: 1, skipped: 0, cancelled: false },
};
let checked = 0;
function check(name, wanted, mutate = () => {}) {
  const tasks = structuredClone(expected);
  const result = structuredClone(baseline);
  mutate(tasks, result);
  assert.equal(isValidQueueResult(tasks, result), wanted, name);
  checked++;
}

check("mixed terminal result", true);
check("results can arrive in a different order", true, (_, result) => result.tasks.reverse());
check("successful conversion reports its actual renamed destination", true, (_, result) => {
  Object.assign(result.tasks[1], { status: "done", error: "", dst_path: "/output (1).mp4", download_url: "/files/output%20(1).mp4" });
  Object.assign(result.summary, { succeeded: 2, failed: 0 });
});
check("an error message may be empty", true, (_, result) => { result.tasks[1].error = ""; });
check("a non-cancelled skip can have a reason", true, (_, result) => {
  Object.assign(result.tasks[1], { status: "skipped", error: "dependency" });
  Object.assign(result.summary, { failed: 0, skipped: 1 });
});
check("cancelled work may include a skipped task", true, (_, result) => {
  result.tasks[1].status = "skipped";
  Object.assign(result.summary, { failed: 0, skipped: 1, cancelled: true });
});
check("a late stop can coexist with terminal results", true, (_, result) => { result.summary.cancelled = true; });
check("download destination may be absent", true, (_, result) => { delete result.tasks[0].dst_path; });
check("conversion destination may be absent for a skipped task", true, (_, result) => {
  result.tasks[1].status = "skipped";
  delete result.tasks[1].dst_path;
  Object.assign(result.summary, { failed: 0, skipped: 1 });
});

const rejected = [
  ["empty expected tasks", (tasks) => { tasks.length = 0; }],
  ["sparse expected tasks", (tasks) => { delete tasks[0]; }],
  ["null expected task", (tasks) => { tasks[0] = null; }],
  ["missing expected ID", (tasks) => { delete tasks[0].task_id; }],
  ["non-string expected ID", (tasks) => { tasks[0].task_id = 1; }],
  ["blank expected ID", (tasks) => { tasks[0].task_id = "  "; }],
  ["duplicate expected ID", (tasks) => { tasks[1].task_id = tasks[0].task_id; }],
  ["unknown expected kind", (tasks) => { tasks[0].kind = "unknown"; }],
  ["missing tasks", (_, result) => { delete result.tasks; }],
  ["non-array tasks", (_, result) => { result.tasks = {}; }],
  ["short tasks array", (_, result) => { result.tasks.pop(); }],
  ["extra task", (_, result) => { result.tasks.push(result.tasks[0]); }],
  ["sparse result tasks", (_, result) => { delete result.tasks[0]; }],
  ["null result task", (_, result) => { result.tasks[0] = null; }],
  ["array result task", (_, result) => { result.tasks[0] = []; }],
  ["missing result ID", (_, result) => { delete result.tasks[0].task_id; }],
  ["non-string result ID", (_, result) => { result.tasks[0].task_id = 1; }],
  ["unknown result ID", (_, result) => { result.tasks[0].task_id = "other"; }],
  ["duplicate result ID", (_, result) => { result.tasks[1].task_id = result.tasks[0].task_id; }],
  ["result kind mismatch", (_, result) => { result.tasks[1].kind = "download"; }],
  ["missing label", (_, result) => { delete result.tasks[0].label; }],
  ["non-string label", (_, result) => { result.tasks[0].label = 1; }],
  ["missing error", (_, result) => { delete result.tasks[0].error; }],
  ["non-string error", (_, result) => { result.tasks[0].error = null; }],
  ["success with an error", (_, result) => { result.tasks[0].error = "contradiction"; }],
  ["pending terminal status", (_, result) => { result.tasks[0].status = "pending"; }],
  ["running terminal status", (_, result) => { result.tasks[0].status = "running"; }],
  ["unknown terminal status", (_, result) => { result.tasks[0].status = "cancelled"; }],
  ["missing status", (_, result) => { delete result.tasks[0].status; }],
  ["missing summary", (_, result) => { delete result.summary; }],
  ["null summary", (_, result) => { result.summary = null; }],
  ["summary total mismatch", (_, result) => { result.summary.total = 1; }],
  ["summary count mismatch", (_, result) => { Object.assign(result.summary, { succeeded: 2, failed: 0 }); }],
  ["missing summary count", (_, result) => { delete result.summary.failed; }],
  ["negative summary count", (_, result) => { result.summary.failed = -1; }],
  ["fractional summary count", (_, result) => { result.summary.failed = 0.5; }],
  ["unsafe summary count", (_, result) => { result.summary.failed = Number.MAX_SAFE_INTEGER + 1; }],
  ["non-finite summary count", (_, result) => { result.summary.failed = Infinity; }],
  ["non-boolean cancelled", (_, result) => { result.summary.cancelled = 0; }],
  ["non-string destination", (_, result) => { result.tasks[1].dst_path = 1; }],
  ["completed conversion without destination", (_, result) => {
    Object.assign(result.tasks[1], { status: "done", error: "", dst_path: "" });
    Object.assign(result.summary, { succeeded: 2, failed: 0 });
  }],
  ["non-string download link", (_, result) => { result.tasks[0].download_url = 1; }],
  ["download link on failed task", (_, result) => { result.tasks[1].download_url = "/files/output.mp4"; }],
];
for (const [name, mutate] of rejected) check(name, false, mutate);
for (const value of [null, undefined, 42, "result", [], {}]) {
  assert.equal(isValidQueueResult(expected, value), false, "malformed result root");
  checked++;
}

// A string link is structural data only; callers must apply their own URL policy.
check("URL destinations are not validated here", true, (_, result) => {
  result.tasks[0].download_url = "https://example.invalid/not-a-validated-link";
});
console.log(`Queue result guard: ${checked} synthetic checks passed.`);