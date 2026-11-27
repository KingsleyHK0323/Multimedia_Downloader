// OpenAI-Codex: report success only when every conversion has a terminal result.
export type ConvertOutcome =
  | { kind: "complete"; total: number }
  | { kind: "failed"; total: number; failed: number }
  | { kind: "unknown" };

export function convertOutcome(response: unknown, total: number): ConvertOutcome {
  if (!Number.isInteger(total) || total < 1 || !response || typeof response !== "object" ||
      !("jobs" in response) || !Array.isArray(response.jobs) || response.jobs.length !== total) {
    return { kind: "unknown" };
  }
  let failed = 0;
  for (const job of response.jobs) {
    if (!job || typeof job !== "object" || typeof job.src !== "string" ||
        typeof job.dst !== "string" || typeof job.error !== "string" ||
        !["done", "error", "no_ffmpeg"].includes(job.status)) return { kind: "unknown" };
    if (job.status !== "done") failed++;
  }
  return failed ? { kind: "failed", total, failed } : { kind: "complete", total };
}

