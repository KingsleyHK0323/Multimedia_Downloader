// OpenAI-Codex_Fork_GitHub_REPO: classify terminal replies without exposing URLs or errors.
export type DownloadOutcome =
  | { kind: "complete"; total: number }
  | { kind: "failed"; total: number; failed: number }
  | { kind: "incomplete"; total: number; done: number }
  | { kind: "unknown" };

export function downloadOutcome(response: unknown, requested: readonly string[]): DownloadOutcome {
  if (requested.length === 0 || !response || typeof response !== "object" ||
      !("results" in response) || !Array.isArray(response.results)) return { kind: "unknown" };
  const results: unknown[] = response.results;
  if (results.length > requested.length) return { kind: "unknown" };
  let failed = 0;
  for (let i = 0; i < results.length; i++) {
    const item = results[i];
    if (!Array.isArray(item) || item.length !== 3 || item[0] !== requested[i] ||
        typeof item[1] !== "boolean" || typeof item[2] !== "string") return { kind: "unknown" };
    if (!item[1]) failed += 1;
  }
  if (results.length < requested.length) return { kind: "incomplete", total: requested.length, done: results.length };
  if (failed) return { kind: "failed", total: requested.length, failed };
  return { kind: "complete", total: requested.length };
}
