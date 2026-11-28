// OpenAI-Codex_engine_cli: validate AI queue terminal results before presentation.
type ExpectedQueueTask = { task_id?: string; kind: string };

export function isValidQueueResult(expected: readonly ExpectedQueueTask[], value: unknown): boolean {
  if (!value || typeof value !== "object" || expected.length === 0) return false;
  const result = value as { tasks?: unknown; summary?: unknown };
  if (!Array.isArray(result.tasks) || result.tasks.length !== expected.length ||
      !result.summary || typeof result.summary !== "object") return false;
  const summary = result.summary as Record<string, unknown>;
  const counts = [summary.total, summary.succeeded, summary.failed, summary.skipped];
  if (counts.some((count) => !Number.isSafeInteger(count) || (count as number) < 0) ||
      typeof summary.cancelled !== "boolean" || summary.total !== expected.length) return false;

  const remaining = new Map<string, string>();
  for (const task of expected) {
    if (!task || typeof task.task_id !== "string" || !task.task_id.trim() ||
        (task.kind !== "download" && task.kind !== "convert") || remaining.has(task.task_id)) return false;
    remaining.set(task.task_id, task.kind);
  }
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  for (const item of result.tasks) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const task = item as Record<string, unknown>;
    if (typeof task.task_id !== "string" || !remaining.has(task.task_id) ||
        task.kind !== remaining.get(task.task_id) || typeof task.label !== "string" ||
        typeof task.error !== "string") return false;
    remaining.delete(task.task_id);
    if (task.dst_path !== undefined && task.dst_path !== null && typeof task.dst_path !== "string") return false;
    if (task.download_url !== undefined && (typeof task.download_url !== "string" || task.status !== "done")) return false;
    if (task.status === "done") {
      if (task.error || (task.kind === "convert" && (typeof task.dst_path !== "string" || !task.dst_path))) return false;
      succeeded++;
    } else if (task.status === "error") failed++;
    else if (task.status === "skipped") skipped++;
    else return false;
  }
  return remaining.size === 0 && summary.succeeded === succeeded &&
    summary.failed === failed && summary.skipped === skipped;
}
