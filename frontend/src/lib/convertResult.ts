// OpenAI-Codex_engine_cli: validate terminal conversion results before rendering.
export function isValidConversionResult(value: unknown, expected: readonly string[], matchSources: boolean): boolean {
  if (!value || typeof value !== "object" || expected.length === 0) return false;
  const result = value as { jobs?: unknown; summary?: unknown };
  if (!Array.isArray(result.jobs) || result.jobs.length !== expected.length ||
      !result.summary || typeof result.summary !== "object") return false;
  const summary = result.summary as Record<string, unknown>;
  const counts = [summary.total, summary.succeeded, summary.failed, summary.skipped];
  if (counts.some((count) => !Number.isSafeInteger(count) || (count as number) < 0) ||
      typeof summary.cancelled !== "boolean" || summary.total !== expected.length) return false;

  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  for (let index = 0; index < result.jobs.length; index++) {
    const item: unknown = result.jobs[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const job = item as Record<string, unknown>;
    if (typeof job.src !== "string" || !job.src || typeof job.dst !== "string" || !job.dst ||
        typeof job.error !== "string" || (matchSources && job.src !== expected[index])) return false;
    if (job.download_url !== undefined && (typeof job.download_url !== "string" || job.status !== "done")) return false;
    if (job.status === "done") {
      if (job.error) return false;
      succeeded++;
    } else if (job.status === "error" || job.status === "no_ffmpeg") failed++;
    else if (job.status === "skipped") skipped++;
    else return false;
  }
  return summary.succeeded === succeeded && summary.failed === failed && summary.skipped === skipped;
}
