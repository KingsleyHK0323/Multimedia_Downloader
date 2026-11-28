// OpenAI-Codex_app_ui: validate terminal download results before presenting success.
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isValidDownloadResult(expected: readonly string[], value: unknown): boolean {
  if (!expected.length || !value || typeof value !== "object") return false;
  const result = value as { results?: unknown; summary?: unknown };
  if (!Array.isArray(result.results) || !result.summary || typeof result.summary !== "object") return false;
  const { total, succeeded, failed, skipped, cancelled } = result.summary as Record<string, unknown>;
  if (!isCount(total) || !isCount(succeeded) || !isCount(failed) || !isCount(skipped) ||
      typeof cancelled !== "boolean" || total !== expected.length ||
      succeeded + failed + skipped !== total || result.results.length !== succeeded + failed) return false;

  let actualSucceeded = 0;
  let actualFailed = 0;
  for (let i = 0; i < result.results.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(result.results, i)) return false;
    const item: unknown = result.results[i];
    if (!Array.isArray(item) || item.length !== 3 ||
        !Object.prototype.hasOwnProperty.call(item, 0) || !Object.prototype.hasOwnProperty.call(item, 1) ||
        !Object.prototype.hasOwnProperty.call(item, 2) ||
        item[0] !== expected[i] || typeof item[1] !== "boolean" || typeof item[2] !== "string") return false;
    if (item[1] && item[2] !== "") return false;
    if (item[1]) actualSucceeded += 1;
    else actualFailed += 1;
  }
  return actualSucceeded === succeeded && actualFailed === failed && skipped === expected.length - result.results.length;
}
