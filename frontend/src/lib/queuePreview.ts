// OpenAI-Codex_app_ui: validate queue preview identities and discard stale responses.
import type { AiTask, QueueConversionPreview, QueuePreviewTask } from "../api";

export function queuePreviewInput(tasks: AiTask[]): QueuePreviewTask[] | null {
  const result: QueuePreviewTask[] = [];
  const ids = new Set<string>();
  for (const task of tasks) {
    if (task.kind !== "convert") continue;
    const id = task.task_id;
    if (typeof id !== "string" || !id.trim() || id !== id.trim() || ids.has(id) ||
        typeof task.label !== "string" || typeof task.src_path !== "string" || !task.src_path ||
        typeof task.dst_path !== "string" || !task.dst_path ||
        (task.conflict_policy !== undefined && !["rename", "skip", "overwrite"].includes(task.conflict_policy))) return null;
    ids.add(id);
    result.push({ kind: "convert", task_id: id, label: task.label, src_path: task.src_path, dst_path: task.dst_path,
      ...(task.conflict_policy ? { conflict_policy: task.conflict_policy } : {}) });
  }
  return result;
}

function validPreview(tasks: QueuePreviewTask[], result: unknown): result is QueueConversionPreview {
  if (!result || typeof result !== "object") return false;
  const jobs = (result as { jobs?: unknown }).jobs;
  if (!Array.isArray(jobs) || jobs.length !== tasks.length) return false;
  const expected = new Set(tasks.map((task) => task.task_id));
  const seen = new Set<string>();
  for (const job of jobs) {
    if (!job || typeof job !== "object") return false;
    const row = job as Record<string, unknown>;
    if (typeof row.task_id !== "string" || !expected.has(row.task_id) || seen.has(row.task_id) ||
        typeof row.src !== "string" || !row.src || typeof row.dst !== "string" || !row.dst ||
        typeof row.existing !== "string" || !["exists", "missing", "unknown"].includes(row.existing) ||
        typeof row.batch_duplicate !== "boolean" || typeof row.source_matches !== "string" ||
        !["yes", "no", "unknown"].includes(row.source_matches)) return false;
    seen.add(row.task_id);
  }
  return seen.size === expected.size;
}

type PreviewOutcome = ({ kind: "ready"; value: QueueConversionPreview } | { kind: "invalid" | "stale" } | { kind: "error"; error: unknown }) & { generation: number };
export class QueuePreviewSession {
  private generation = 0;
  invalidate(): void { this.generation += 1; }
  isCurrent(generation: number): boolean { return this.generation === generation; }
  async request(tasks: AiTask[], fetchPreview: (tasks: QueuePreviewTask[]) => Promise<QueueConversionPreview>): Promise<PreviewOutcome> {
    const generation = ++this.generation;
    const input = queuePreviewInput(tasks);
    if (!input || !input.length) return { kind: "invalid", generation };
    try {
      const value = await fetchPreview(input);
      if (generation !== this.generation) return { kind: "stale", generation };
      return validPreview(input, value) ? { kind: "ready", value, generation } : { kind: "invalid", generation };
    } catch (error) {
      return generation !== this.generation ? { kind: "stale", generation } : { kind: "error", error, generation };
    }
  }
}
