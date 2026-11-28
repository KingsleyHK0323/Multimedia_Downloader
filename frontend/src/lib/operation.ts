// OpenAI-Codex_app_ui: shared operation presentation and log privacy helpers.
export type OperationSummary = {
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  cancelled: boolean;
};

export type OperationOutcome = "succeeded" | "partial" | "failed" | "cancelled" | "unknown";

// OpenAI-Codex_Fork_Source_Code: reject snapshots from before an operation.
export class PreviewGeneration {
  private generation = 0;

  capture(): number { return this.generation; }
  invalidate(): void { this.generation += 1; }
  isCurrent(value: number): boolean { return value === this.generation; }
}

export function operationOutcome(value: unknown): OperationOutcome {
  if (!value || typeof value !== "object") return "unknown";
  const summary = value as Partial<OperationSummary>;
  const counts = [summary.total, summary.succeeded, summary.failed, summary.skipped];
  if (counts.some((n) => !Number.isSafeInteger(n) || (n as number) < 0) ||
      typeof summary.cancelled !== "boolean") return "unknown";
  const { total, succeeded, failed, skipped, cancelled } = summary as OperationSummary;
  if (total === 0 || succeeded + failed + skipped !== total) return "unknown";
  if (cancelled) return "cancelled";
  if (failed > 0 && succeeded === 0 && skipped === 0) return "failed";
  if (failed > 0 || skipped > 0) return "partial";
  return succeeded === total ? "succeeded" : "unknown";
}

export function redactLog(text: string): string {
  // OpenAI-Codex_web_ai: fail closed on ambiguous double-quoted private URLs.
  text = text.replace(/https?:\/\/[^\s<>]+/gi, (raw) =>
    raw.includes('"') && /[@?#]/.test(raw) ? "[redacted URL]" : raw,
  );
  // OpenAI-Codex_web_ai: protect complete URLs before credential substitutions.
  text = text.replace(
    /https?:\/\/(?:(?=(?:(?!https?:\/\/)[^\s<>"])*[?#])[^\s<>"]+|(?:(?!https?:\/\/)[^\s<>"])+)/gi,
    (raw, offset, original) => {
      const wrapper = offset > 0 && original[offset - 1] === "'" ? /'([.,;:!)}]*)$/.exec(raw) : null;
      const value = wrapper ? raw.slice(0, wrapper.index) : raw;
      const trailing = wrapper ? wrapper[0] : "";
      try {
        const url = new URL(value);
        const hadPrivateParts = Boolean(url.search || url.hash || url.username || url.password);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.toString() + (hadPrivateParts ? "?[redacted]" : "") + trailing;
      } catch {
        return "[redacted URL]" + trailing;
      }
    },
  );
  // OpenAI-Codex_app_ui: mask common credential headers before rendering or export.
  text = text.replace(/(^|[^A-Za-z0-9_-])(["']?(?:proxy-authorization|authorization|set-cookie|cookie)["']?[ \t]*[:=][ \t]*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*)/gim, '$1$2"[redacted]"');
  // OpenAI-Codex_web_ai: consume escaped quotes in named credential values.
  text = text.replace(
    /(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}&]+)/gi,
    "$1[redacted]",
  );
  return text
    .replace(/https?:\/\/[^\s<>"']+/gi, (raw) => {
      try {
        const url = new URL(raw);
        const hadPrivateParts = Boolean(url.search || url.hash || url.username || url.password);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.toString() + (hadPrivateParts ? "?[redacted]" : "");
      } catch {
        return "[redacted URL]";
      }
    })
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/(\b(?:set-)?cookie\s*:\s*)[^\r\n]+/gi, "$1[redacted]")
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}&]+)/gi, "$1[redacted]");
}

export function reconcileTaskStatuses(tasks: Array<{ task_id: string; status: string }>): Record<string, string> {
  return Object.fromEntries(tasks.filter((task) => task.task_id).map((task) => [task.task_id, task.status]));
}

export function isAbsoluteNativePath(value: unknown): value is string {
  return typeof value === "string" &&
    !value.includes("\0") &&
    (/^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]/.test(value) || value.startsWith("/"));
}

// OpenAI-Codex_app_ui: protect synchronous error formatting and redaction.
export function safeAiErrorText(makeText: () => unknown): string {
  try {
    const text = makeText();
    return typeof text === "string" ? text : "[redacted]";
  } catch { return "[redacted]"; }
}
