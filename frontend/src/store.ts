/** Shared Svelte stores: active language (with reactive translator) and log lines.
 * OpenAI-Codex_app_ui: preserve preferences and redact exported log content. */

import { writable, derived } from "svelte/store";
import { Translator, DEFAULT_LANG, type Lang } from "./i18n";
import { redactLog } from "./lib/operation";
import { get } from "svelte/store";

const LANGUAGE_KEY = "mmdl_language";
function savedLanguage(): Lang {
  try {
    const value = localStorage.getItem(LANGUAGE_KEY);
    return value === "zh_tw" || value === "zh_cn" || value === "en" ? value : DEFAULT_LANG;
  } catch { return DEFAULT_LANG; }
}
export const lang = writable<Lang>(savedLanguage());

// Keep <html lang> in sync for screen readers / correct font selection.
lang.subscribe((l) => {
  if (typeof document !== "undefined") {
    document.documentElement.lang = l === "zh_tw" ? "zh-Hant" : l === "zh_cn" ? "zh-Hans" : "en";
  }
  try { localStorage.setItem(LANGUAGE_KEY, l); } catch { /* storage may be disabled */ }
});

/** Reactive translator function; recomputed whenever `lang` changes. */
export const t = derived(lang, ($lang) => {
  const tr = new Translator($lang);
  return (key: string, params?: Record<string, unknown>) => tr.t(key, params);
});

export type LogEntry = { level: string; text: string; seq: number; ts: string };

const MAX_LOGS = 2000; // cap so an hours-long batch can't grow memory unbounded

let _seq = 0;
export const logs = writable<LogEntry[]>([]);

export function pushLog(level: string, text: string): void {
  // OpenAI-Codex_app_ui: preserve the existing append path while sanitizing both fields.
  {
    let safeLevel = "info";
    let safeText = "[redacted]";
    try { if (typeof level === "string") { const value = redactLog(level); if (typeof value === "string") safeLevel = value; } } catch { /* Keep the fallback. */ }
    try { if (typeof text === "string") { const value = redactLog(text); if (typeof value === "string") safeText = value; } } catch { /* Keep the fallback. */ }
    const ts = new Date().toLocaleTimeString(undefined, { hour12: false });
    logs.update((l) => {
      const next = [...l, { level: safeLevel, text: safeText, seq: _seq++, ts }];
      return next.length > MAX_LOGS ? next.slice(next.length - MAX_LOGS) : next;
    });
    return;
  }
  // OpenAI-Codex_app_ui: event levels also appear in exported log text.
  level = typeof level === "string" ? redactLog(level) : "info";
  const ts = new Date().toLocaleTimeString(undefined, { hour12: false });
  logs.update((l) => {
    const next = [...l, { level, text: redactLog(text), seq: _seq++, ts }];
    return next.length > MAX_LOGS ? next.slice(next.length - MAX_LOGS) : next;
  });
}

export function clearLogs(): void {
  logs.set([]);
}

export type Progress = { pct: number; speed: string; eta: string };
export const progress = writable<Progress | null>(null);

/** True while an engine operation (download/convert) is running. */
export const busy = writable(false);
export const activeOperation = writable<"download" | "convert" | "ai-plan" | "ai-queue" | null>(null);
/** Commands wait until the event stream is connected. */
export const eventReady = writable(false);

// Per-batch download item list. Lives here (not as DownloadTab.svelte local
// state) so it survives switching away to another tab and back — Svelte's
// {#if}/{:else if} tab switching in App.svelte destroys and recreates the
// tab component on every switch, which was silently wiping a component-local
// list (see GitHub issue #9). Updated from App.svelte's global event
// listener, which — unlike a per-tab onMount — is never torn down.
// OpenAI-Codex_web_ai: retain validated terminal errors for the current batch.
// OpenAI-Codex_Fork_Source_Code: preserve playlist titles alongside per-item URLs.
export type DownloadItem = { url: string; label?: string; status: "pending" | "running" | "done" | "error" | "skipped"; error?: string };
export const downloadItems = writable<DownloadItem[]>([]);
export const downloadMode = writable<"video" | "audio" | null>(null);

export function markDownloadItem(index: number, status: DownloadItem["status"]): void {
  downloadItems.update((items) => {
    if (!downloadBatchAcceptsEvents(items)) return items;
    if (!items[index]) return items;
    const next = [...items];
    next[index] = { ...next[index], status };
    return next;
  });
}

// OpenAI-Codex_app_ui: keep batch identity, mode, and trust with the item data.
type DownloadBatchPhase = "live" | "finalizing" | "terminal" | "unknown" | "superseded";
// OpenAI-Codex: preserve the validated terminal summary across tab remounts.
type DownloadBatchMeta = { token: object; mode: "video" | "audio"; phase: DownloadBatchPhase; summary?: import("./lib/operation").OperationSummary };
const downloadBatchMarker: unique symbol = Symbol("download-batch");
type TaggedDownloadItem = DownloadItem & { [downloadBatchMarker]?: DownloadBatchMeta };
let beginningDownloadBatch = false;

function readDownloadBatch(items: readonly DownloadItem[]): DownloadBatchMeta | null {
  if (!items.length) return null;
  for (let i = 0; i < items.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(items, i) || !items[i]) return null;
  }
  const meta = (items[0] as TaggedDownloadItem)[downloadBatchMarker];
  if (!meta || !items.every((item) => (item as TaggedDownloadItem)[downloadBatchMarker] === meta)) return null;
  return meta;
}

function tagDownloadBatch(items: readonly DownloadItem[], meta: DownloadBatchMeta): DownloadItem[] {
  return items.map((item) => ({ ...item, [downloadBatchMarker]: meta }));
}

export function beginDownloadBatch(): object | null {
  if (beginningDownloadBatch) return null;
  beginningDownloadBatch = true;
  try {
    const token = {};
    downloadItems.update((items) => {
      const meta = readDownloadBatch(items);
      return meta ? tagDownloadBatch(items, { ...meta, phase: "superseded" }) : items;
    });
    return token;
  } finally { beginningDownloadBatch = false; }
}

export function activateDownloadBatch(token: object, mode: "video" | "audio"): void {
  downloadItems.update((items) => tagDownloadBatch(items, { token, mode, phase: "live" }));
}

export function setDownloadBatchPhase(token: object, phase: DownloadBatchPhase, summary?: DownloadBatchMeta["summary"]): void {
  downloadItems.update((items) => {
    const meta = readDownloadBatch(items);
    return meta?.token === token ? tagDownloadBatch(items, { ...meta, phase, summary }) : items;
  });
}

export function downloadTerminalSummary(items: readonly DownloadItem[], mode: "video" | "audio") {
  const meta = readDownloadBatch(items);
  return meta?.phase === "terminal" && meta.mode === mode ? meta.summary : undefined;
}

export function downloadBatchToken(items: readonly DownloadItem[], mode?: "video" | "audio"): object | null {
  const meta = readDownloadBatch(items);
  return meta && (!mode || meta.mode === mode) ? meta.token : null;
}

export function isCurrentDownloadBatch(token: object): boolean {
  const meta = readDownloadBatch(get(downloadItems));
  if (!meta || meta.phase === "superseded") return false;
  return downloadBatchToken(get(downloadItems)) === token && get(activeOperation) === "download";
}

export function isIdleDownloadBatch(token: object): boolean {
  const meta = readDownloadBatch(get(downloadItems));
  if (!meta || meta.phase === "superseded") return false;
  return downloadBatchToken(get(downloadItems)) === token && get(activeOperation) === null;
}

export function canDisplayDownloadBatch(items: readonly DownloadItem[], mode: "video" | "audio"): boolean {
  const meta = readDownloadBatch(items);
  return !!meta && meta.mode === mode && (meta.phase === "live" || meta.phase === "terminal");
}

export function downloadBatchUnknown(items: readonly DownloadItem[], mode: "video" | "audio"): boolean {
  const meta = readDownloadBatch(items);
  return !!meta && meta.mode === mode && meta.phase === "unknown";
}

function downloadBatchAcceptsEvents(items: readonly DownloadItem[]): boolean {
  return readDownloadBatch(items)?.phase === "live";
}
