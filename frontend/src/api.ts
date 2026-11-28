/**
 * Transport abstraction between the UI and the engine.
 *
 * Under Tauri, calls are forwarded to Rust IPC commands (which talk to the
 * Python engine sidecar); in a plain browser (vite dev / preview) a mock
 * implementation simulates the engine so the UI is fully previewable without
 * the desktop shell. Both emit the SAME event shape the sidecar defines, so
 * the UI code is identical in either environment.
 *
 * Three transports, selected at load time:
 *   - TauriApi  — inside the desktop shell (Rust IPC → stdio sidecar).
 *   - WebApi    — served by `web_app.py` (HTTP POST commands + SSE events).
 *                 Enabled by the `VITE_BACKEND=web` build flag (`build:web`).
 *   - MockApi   — plain browser preview with no backend (vite dev): fakes
 *                 progress with setTimeout, never touches yt-dlp/ffmpeg.
 *
 * All three emit the SAME event shape the sidecar defines, so the UI code is
 * identical regardless of transport. (V4.1 added WebApi — the real deployable
 * web version; see `System_Architecture/V4.0 System Architecture.md` §8.)
 * OpenAI-Codex_app_ui: typed terminal results and ready event subscriptions.
 */

import type { OperationSummary } from "./lib/operation";
import { HttpResponseError, OperationCoordinator, type OperationCommand, type OperationState, type OperationStatus, type Reservation, type ReservationTransport } from "./lib/operationCoordinator";
import { SharedEventStream, type ConnectionState } from "./lib/eventStream";

export type Formats = {
  video: string[];
  audio: string[];
  quality: string[];
  browsers: string[];
  // OpenAI-Codex_Fork_Source_Code: encoder choices do not imply GPU availability.
  video_encoders: VideoEncoder[];
  hardware_video_formats: string[];
};

export type VideoEncoder = "software" | "h264_nvenc" | "h264_qsv" | "h264_amf" | "h264_videotoolbox";

export type EngineEvent = (
  | { type: "log"; level: string; key: string; fmt?: Record<string, unknown> }
  | { type: "progress"; pct: number; speed: string; eta: string }
  | { type: "item_start"; index: number; total: number; url: string }
  | { type: "task_update"; task_id: string; label: string; kind: string; status: string; error: string }
) & { operation_id?: string };

export type DownloadArgs = {
  urls: string[];
  mode: "video" | "audio";
  video_fmt: string;
  audio_fmt: string;
  quality: string;
  save_path: string;
  browser?: string;
  cookie_file?: string;
  bitrate?: string;
  /** Selected playlist entries must be downloaded as individual videos. */
  noplaylist?: boolean;
};

export type PlaylistPreviewArgs = {
  url: string;
  mode: "video" | "audio";
  video_fmt: string;
  audio_fmt: string;
  quality: string;
  browser?: string;
  cookie_file?: string;
  bitrate?: string;
};

export type PlaylistPreviewEntry = {
  entry_id: string;
  index: number;
  url: string;
  title: string;
  duration_seconds: number | null;
};

export type PlaylistPreview = {
  title: string;
  entries: PlaylistPreviewEntry[];
  total_entries: number;
  unavailable_entries: number;
  truncated: boolean;
  preview_limit: number;
};

export type ConvertArgs = {
  files: string[];
  dst_fmt: string;
  save_path: string;
  conflict_policy?: "rename" | "skip" | "overwrite";
  overwrite_confirmed?: boolean;
  video_encoder?: VideoEncoder;
};

export type DownloadResult = { results: Array<[string, boolean, string]>; summary: OperationSummary };
export type ConvertJob = { src: string; dst: string; status: string; error: string; download_url?: string };
export type ConvertResult = { jobs: ConvertJob[]; summary: OperationSummary };
export type ConversionPreview = { jobs: Array<{
  src: string; dst: string; existing: "exists" | "missing" | "unknown";
  batch_duplicate: boolean; source_matches: "yes" | "no" | "unknown";
}> };

// ── AI assistant types (Phase 5) ─────────────────────────────────────────────
// Mirrors engine.queue.Task on the Python side — this is what run_queue expects.
export type AiDownloadTask = {
  kind: "download";
  task_id?: string;
  label: string;
  url: string;
  options: {
    save_path: string;
    mode: "video" | "audio";
    video_fmt: string;
    audio_fmt: string;
    quality: string;
    browser: string;
    bitrate?: string;
    cookie_file?: string;
  };
};
export type AiConvertTask = {
  kind: "convert";
  task_id?: string;
  label: string;
  src_path: string;
  dst_path: string;
  conflict_policy?: "rename" | "skip" | "overwrite";
  video_encoder?: VideoEncoder;
};
export type AiTask = AiDownloadTask | AiConvertTask;

// OpenAI-Codex_Fork_Source_Code: preserve each queue task's explicit destination.
export type QueuePreviewTask = AiConvertTask & { task_id: string };
export type QueueConversionPreview = {
  jobs: Array<ConversionPreview["jobs"][number] & { task_id: string }>;
};

export type AiPlan = {
  summary: string;
  tasks: AiTask[];
  warnings: string[];
};

export type AiContext = { save_path: string; browser: string };

export type QueueResultTask = { task_id: string; kind: string; label: string; status: string; error: string; dst_path?: string; download_url?: string };
export type QueueResult = { tasks: QueueResultTask[]; summary: OperationSummary };
export type StopResult = { stopping: boolean };
export type OperationNotice = "uncertain" | "result_lost" | "not_started" | "result_unknown" | "response_error";

export interface Api {
  getFormats(): Promise<Formats>;
  getLocales(): Promise<Record<string, string>>;
  startDownload(args: DownloadArgs): Promise<DownloadResult>;
  previewPlaylist(args: PlaylistPreviewArgs): Promise<PlaylistPreview>;
  startConvert(args: ConvertArgs): Promise<ConvertResult>;
  previewConvert(args: ConvertArgs): Promise<ConversionPreview>;
  previewQueue(tasks: QueuePreviewTask[]): Promise<QueueConversionPreview>;
  aiPlan(apiKey: string, prompt: string, context: AiContext): Promise<AiPlan>;
  runQueue(tasks: AiTask[], overwriteConfirmed?: boolean): Promise<QueueResult>;
  stop(): Promise<StopResult>;
  onEvent(cb: (e: EngineEvent) => void): Promise<() => void>;
  onConnectionState(cb: (state: ConnectionState) => void): () => void;
  onOperationUncertain(cb: (notice: OperationNotice) => void): () => void;
  retryEvents(): void;
}

type DownloadRequest = DownloadArgs & { operation_id: string };
type ConvertRequest = ConvertArgs & { operation_id: string };
interface Transport extends ReservationTransport {
  getFormats(): Promise<Formats>;
  getLocales(): Promise<Record<string, string>>;
  startDownload(args: DownloadRequest): Promise<DownloadResult>;
  previewPlaylist(args: PlaylistPreviewArgs): Promise<PlaylistPreview>;
  startConvert(args: ConvertRequest): Promise<ConvertResult>;
  previewConvert(args: ConvertArgs): Promise<ConversionPreview>;
  previewQueue(tasks: QueuePreviewTask[]): Promise<QueueConversionPreview>;
  aiPlan(apiKey: string, prompt: string, context: AiContext): Promise<AiPlan>;
  runQueue(tasks: AiTask[], overwriteConfirmed: boolean, operationId: string): Promise<QueueResult>;
  onEvent(cb: (e: EngineEvent) => void): Promise<() => void>;
  onConnectionState(cb: (state: ConnectionState) => void): () => void;
  retryEvents(): void;
}

const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// ── Real (Tauri) transport ────────────────────────────────────────────────
class TauriApi implements Transport {
  private listeners = new Set<(event: EngineEvent) => void>();
  private observers = new Set<(state: ConnectionState) => void>();
  private eventState: ConnectionState = "disconnected";
  private unlisten: (() => void) | undefined;
  private eventGeneration = 0;
  private connecting = false;

  private async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(cmd, args);
  }
  getFormats() { return this.invoke<Formats>("get_formats"); }
  getLocales() { return this.invoke<Record<string, string>>("get_locales"); }
  prepare(command: OperationCommand) { return this.invoke<Reservation>("prepare_operation", { args: { command } }); }
  release(operationId: string) { return this.invoke<{ released: boolean }>("release_operation", { args: { operation_id: operationId } }); }
  status(operationId: string) { return this.invoke<OperationStatus>("operation_status", { args: { operation_id: operationId } }); }
  startDownload(args: DownloadRequest) { return this.invoke<DownloadResult>("start_download", { args }); }
  previewPlaylist(args: PlaylistPreviewArgs) { return this.invoke<PlaylistPreview>("preview_playlist", { args }); }
  startConvert(args: ConvertRequest) { return this.invoke<ConvertResult>("start_convert", { args }); }
  previewConvert(args: ConvertArgs) { return this.invoke<ConversionPreview>("preview_convert", { args }); }
  previewQueue(tasks: QueuePreviewTask[]) { return this.invoke<QueueConversionPreview>("preview_queue", { args: { tasks } }); }
  aiPlan(apiKey: string, prompt: string, context: AiContext) {
    return this.invoke<AiPlan>("ai_plan", { args: { api_key: apiKey, prompt, context } });
  }
  runQueue(tasks: AiTask[], overwriteConfirmed: boolean, operationId: string) {
    return this.invoke<QueueResult>("run_queue", { args: { tasks, operation_id: operationId, ...(overwriteConfirmed ? { overwrite_confirmed: true } : {}) } });
  }
  stop(operationId: string) { return this.invoke<StopResult>("stop_engine", { args: { operation_id: operationId } }); }

  private setEventState(state: ConnectionState) {
    if (state === this.eventState) return;
    this.eventState = state;
    this.observers.forEach((cb) => cb(state));
  }
  private async connectEvents() {
    if (this.connecting || this.unlisten || !this.listeners.size) return;
    const generation = ++this.eventGeneration;
    this.connecting = true;
    this.setEventState("connecting");
    try {
      const { listen } = await import("@tauri-apps/api/event");
      const off = await listen<EngineEvent>("engine-event", (ev) => {
        if (generation === this.eventGeneration) this.listeners.forEach((cb) => cb(ev.payload));
      });
      if (generation !== this.eventGeneration || !this.listeners.size) { off(); return; }
      this.unlisten = off;
      this.setEventState("open");
    } catch {
      if (generation === this.eventGeneration) this.setEventState("disconnected");
    } finally {
      if (generation === this.eventGeneration) this.connecting = false;
    }
  }
  onEvent(cb: (e: EngineEvent) => void): Promise<() => void> {
    this.listeners.add(cb);
    void this.connectEvents();
    return Promise.resolve(() => {
      this.listeners.delete(cb);
      if (!this.listeners.size) {
        this.eventGeneration++;
        this.connecting = false;
        this.unlisten?.();
        this.unlisten = undefined;
        this.setEventState("disconnected");
      }
    });
  }
  onConnectionState(cb: (state: ConnectionState) => void): () => void {
    this.observers.add(cb);
    cb(this.eventState);
    return () => { this.observers.delete(cb); };
  }
  retryEvents() {
    this.eventGeneration++;
    this.connecting = false;
    this.unlisten?.();
    this.unlisten = undefined;
    void this.connectEvents();
  }
}

// ── Real (web backend) transport ─────────────────────────────────────────────
// Talks to web_app.py over the same origin: POST for commands, SSE for events.
class WebApi implements Transport {
  private readonly events = new SharedEventStream({ create: () => new EventSource("/events") });
  private async get<T>(path: string): Promise<T> {
    const r = await fetch(path);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json() as Promise<T>;
  }
  private async post<T>(path: string, body?: unknown): Promise<T> {
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try {
        const j = await r.json();
        if (j?.error) msg = String(j.error);
      } catch { /* non-JSON error body */ }
      throw new HttpResponseError(r.status, msg);
    }
    if (r.status === 204) return undefined as T;
    return r.json() as Promise<T>;
  }

  getFormats() { return this.get<Formats>("/api/formats"); }
  getLocales() { return this.get<Record<string, string>>("/api/locales"); }
  prepare(command: OperationCommand) { return this.post<Reservation>("/api/operations", { command }); }
  release(operationId: string) { return this.post<{ released: boolean }>("/api/operations/release", { operation_id: operationId }); }
  status(operationId: string) { return this.post<OperationStatus>("/api/operations/status", { operation_id: operationId }); }
  startDownload(args: DownloadRequest) { return this.post<DownloadResult>("/api/download", args); }
  previewPlaylist(args: PlaylistPreviewArgs) { return this.post<PlaylistPreview>("/api/preview_playlist", args); }
  startConvert(args: ConvertRequest) { return this.post<ConvertResult>("/api/convert", args); }
  previewConvert(args: ConvertArgs) { return this.post<ConversionPreview>("/api/preview_convert", args); }
  previewQueue(tasks: QueuePreviewTask[]) { return this.post<QueueConversionPreview>("/api/preview_queue", { tasks }); }
  aiPlan(apiKey: string, prompt: string, context: AiContext) {
    return this.post<AiPlan>("/api/ai_plan", { api_key: apiKey, prompt, context });
  }
  runQueue(tasks: AiTask[], overwriteConfirmed: boolean, operationId: string) {
    return this.post<QueueResult>("/api/run_queue", { tasks, operation_id: operationId, ...(overwriteConfirmed ? { overwrite_confirmed: true } : {}) });
  }
  stop(operationId: string) { return this.post<StopResult>("/api/stop", { operation_id: operationId }); }

  onEvent(cb: (e: EngineEvent) => void): Promise<() => void> {
    return Promise.resolve(this.events.subscribe((event) => cb(event as unknown as EngineEvent)));
  }
  onConnectionState(cb: (state: ConnectionState) => void): () => void { return this.events.observe(cb); }
  retryEvents() { this.events.retry(); }
}

// ── Mock (browser) transport ────────────────────────────────────────────────
const FORMATS: Formats = {
  video: ["mp4", "mkv", "mov", "avi", "webm", "flv", "wmv", "ts", "m4v", "3gp"],
  audio: ["mp3", "flac", "aac", "wav", "ogg", "m4a", "opus", "wma"],
  quality: ["best", "1080p", "720p", "480p", "360p", "worst"],
  browsers: ["none", "chrome", "firefox", "edge", "safari", "brave", "opera", "chromium"],
  // The browser mock cannot verify or perform hardware encoding.
  video_encoders: ["software"],
  hardware_video_formats: [],
};

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
let nextMockInstance = 0;
const MOCK_HARDWARE_ENCODER_ERROR = "Hardware encoding is unavailable in the browser preview.";

class MockApi implements Transport {
  private listeners = new Set<(e: EngineEvent) => void>();
  private observers = new Set<(state: ConnectionState) => void>();
  private stopped = false;
  private nextOperation = 0;
  private reservation: { id: string; command: OperationCommand; stopped: boolean; started: boolean } | null = null;
  private completed = new Set<string>();
  private released = new Set<string>();
  private readonly instanceId = `mock-instance-${++nextMockInstance}`;

  private emit(e: EngineEvent) {
    const event = this.reservation?.started ? { ...e, operation_id: this.reservation.id } : e;
    this.listeners.forEach((cb) => cb(event));
  }

  prepare(command: OperationCommand) {
    if (this.reservation) return Promise.reject(new Error("Another operation is already running"));
    const id = `mock-operation-${++this.nextOperation}`;
    this.reservation = { id, command, stopped: false, started: false };
    return Promise.resolve({ operation_id: id, instance_id: this.instanceId, command, expires_in: 120 });
  }
  stop(operationId: string) {
    if (!this.reservation || this.reservation.id !== operationId) return Promise.resolve({ stopping: false });
    this.reservation.stopped = true;
    this.stopped = true;
    return Promise.resolve({ stopping: true });
  }
  release(operationId: string) {
    if (this.reservation?.id !== operationId) return Promise.resolve({ released: false });
    if (this.reservation.started) {
      if (this.completed.has(operationId)) this.reservation = null;
      return Promise.resolve({ released: false });
    }
    this.reservation = null;
    this.released.add(operationId);
    return Promise.resolve({ released: true });
  }
  status(operationId: string): Promise<{ state: OperationState; instance_id: string; idle: boolean }> {
    const state = this.completed.has(operationId) ? "completed" : this.released.has(operationId) ? "released" : this.reservation?.id === operationId
      ? this.reservation.started ? "running" : "reserved"
      : "unknown";
    return Promise.resolve({ state, instance_id: this.instanceId, idle: this.reservation === null });
  }
  private finish(operationId: string) {
    this.completed.add(operationId);
    if (this.reservation?.id === operationId && this.reservation.started) this.reservation = null;
  }
  private begin(command: OperationCommand, operationId: string) {
    if (!this.reservation || this.reservation.id !== operationId ||
        this.reservation.command !== command || this.reservation.started) throw new Error("Invalid operation reservation");
    this.reservation.started = true;
    this.stopped = this.reservation.stopped;
  }

  getFormats() { return Promise.resolve(FORMATS); }
  getLocales() {
    return Promise.resolve({ en: "English", zh_tw: "繁體中文", zh_cn: "简体中文" });
  }

  async startDownload(args: DownloadRequest): Promise<DownloadResult> {
    this.begin("download", args.operation_id);
    try {
    const urls = args.urls.filter((u) => u.trim());
    const total = urls.length;
    const results: DownloadResult["results"] = [];
    this.emit({ type: "log", level: "info", key: "log_start_batch", fmt: { n: total } });
    for (let i = 0; i < total; i++) {
      if (this.stopped) {
        this.emit({ type: "log", level: "warn", key: "log_stopped_dl" });
        break;
      }
      const idx = i + 1;
      this.emit({ type: "item_start", index: idx, total, url: urls[i] });
      this.emit({ type: "log", level: "info", key: "log_item_downloading", fmt: { i: idx, t: total, url: urls[i] } });
      for (const pct of [20, 55, 90, 100]) {
        if (this.stopped) break;
        await delay(180);
        if (this.stopped) break;
        this.emit({ type: "progress", pct, speed: "3.4MiB/s", eta: pct < 100 ? "00:03" : "--" });
      }
      if (this.stopped) break;
      this.emit({ type: "log", level: "ok", key: "log_item_done", fmt: { i: idx, t: total } });
      results.push([urls[i], true, ""]);
    }
    if (!this.stopped) this.emit({ type: "log", level: "ok", key: "log_all_done", fmt: { t: total } });
    return { results, summary: { total, succeeded: results.length, failed: 0, skipped: total - results.length, cancelled: this.stopped } };
    } finally { this.finish(args.operation_id); }
  }

  previewPlaylist(_args: PlaylistPreviewArgs): Promise<PlaylistPreview> {
    return Promise.reject(new Error("Playlist metadata preview is unavailable in the browser mock."));
  }

  async startConvert(args: ConvertRequest): Promise<ConvertResult> {
    // OpenAI-Codex_Fork_Source_Code: never simulate physical hardware success.
    if ((args.video_encoder ?? "software") !== "software") throw new Error(MOCK_HARDWARE_ENCODER_ERROR);
    this.begin("convert", args.operation_id);
    try {
    const files = args.files.filter((f) => f.trim());
    const total = files.length;
    const jobs: ConvertJob[] = [];
    for (let i = 0; i < total; i++) {
      if (this.stopped) {
        this.emit({ type: "log", level: "warn", key: "log_convert_stopped" });
        break;
      }
      const idx = i + 1;
      const name = files[i].split(/[\\/]/).pop() ?? files[i];
      const dst = name.replace(/\.[^.]+$/, "") + "." + args.dst_fmt;
      this.emit({ type: "log", level: "info", key: "log_convert_start", fmt: { i: idx, t: total, src: name, dst } });
      await delay(320);
      if (this.stopped) break;
      this.emit({ type: "log", level: "ok", key: "log_convert_done", fmt: { i: idx, t: total, name: dst } });
      jobs.push({ src: files[i], dst, status: "done", error: "" });
    }
    const succeeded = jobs.length;
    for (const src of files.slice(succeeded)) {
      const name = src.split(/[\\/]/).pop() ?? src;
      const dst = name.replace(/\.[^.]+$/, "") + "." + args.dst_fmt;
      jobs.push({ src, dst, status: "skipped", error: "" });
    }
    if (!this.stopped) this.emit({ type: "log", level: "ok", key: "log_all_converted", fmt: { t: total } });
    return { jobs, summary: { total, succeeded, failed: 0, skipped: total - succeeded, cancelled: this.stopped } };
    } finally { this.finish(args.operation_id); }
  }

  previewConvert(args: ConvertArgs): Promise<ConversionPreview> {
    const separator = args.save_path.includes("\\") && !args.save_path.includes("/") ? "\\" : "/";
    const root = args.save_path;
    const jobs = args.files.map((src) => {
      const name = src.split(/[\\/]/).pop() ?? src;
      const output = name.replace(/\.[^.]+$/, "") + "." + args.dst_fmt;
      return { src, dst: root ? root + (/[\\/]$/.test(root) ? "" : separator) + output : output };
    });
    return Promise.resolve({ jobs: jobs.map((job) => ({
      ...job, existing: "unknown" as const, source_matches: "unknown" as const,
      batch_duplicate: jobs.length > 1,
    })) });
  }

  previewQueue(tasks: QueuePreviewTask[]): Promise<QueueConversionPreview> {
    return Promise.resolve({ jobs: tasks.map((task) => ({
      task_id: task.task_id, src: task.src_path, dst: task.dst_path,
      existing: "unknown" as const, source_matches: "unknown" as const,
      batch_duplicate: tasks.length > 1,
    })) });
  }

  // Naive heuristic "planner" so the AI panel is demoable without a real API
  // key or network access: pull URLs / file paths out of the free-text prompt.
  async aiPlan(_apiKey: string, prompt: string, context: AiContext): Promise<AiPlan> {
    this.emit({ type: "log", level: "info", key: "log_ai_planning_start" });
    await delay(300);
    this.emit({ type: "log", level: "info", key: "log_ai_executing" });
    await delay(300);
    this.emit({ type: "log", level: "info", key: "log_ai_checking" });
    await delay(200);

    const urls = Array.from(prompt.matchAll(/https?:\/\/\S+/g)).map((m) => m[0]);
    const files = Array.from(
      prompt.matchAll(/[^\s"']+\.(mkv|mov|avi|webm|flv|wmv|ts|m4v|3gp|mp4|mp3|wav|flac)/gi),
    ).map((m) => m[0]);

    const savePath = context.save_path.trim();
    const tasks: AiTask[] = [];
    const warnings: string[] = [];

    if (!savePath) {
      return { summary: "No tasks inferred (mock)", tasks, warnings: ["mock: Set a save location before planning."] };
    }

    for (const url of urls) {
      tasks.push({
        kind: "download", label: url, url,
        options: { save_path: savePath, mode: "video", video_fmt: "mp4",
                  audio_fmt: "mp3", quality: "best", browser: context.browser || "none" },
      });
    }
    for (const f of files) {
      const dstFmt = /\bmp3\b/i.test(prompt) ? "mp3" : "mp4";
      const name = f.split(/[\\/]/).pop() ?? f;
      const dst = name.replace(/\.[^.]+$/, "") + "." + dstFmt;
      tasks.push({ kind: "convert", label: name, src_path: f, dst_path: savePath + "\\" + dst });
    }
    if (tasks.length === 0) {
      warnings.push("mock: no URL or file path found in the prompt — try mentioning one explicitly");
    }

    this.emit({ type: "log", level: "ok", key: "log_ai_plan_ready", fmt: { n: tasks.length } });
    return {
      summary: tasks.length ? `${tasks.length} task(s) inferred from your request (mock)` : "No tasks inferred (mock)",
      tasks,
      warnings,
    };
  }

  async runQueue(tasks: AiTask[], _overwriteConfirmed: boolean, operationId: string): Promise<QueueResult> {
    // OpenAI-Codex_Fork_Source_Code: reject hardware requests in mock queues too.
    if (tasks.some((task) => task.kind === "convert" && (task.video_encoder ?? "software") !== "software")) {
      throw new Error(MOCK_HARDWARE_ENCODER_ERROR);
    }
    this.begin("run_queue", operationId);
    try {
    const total = tasks.length;
    this.emit({ type: "log", level: "info", key: "log_queue_start", fmt: { n: total } });

    const results: QueueResultTask[] = [];
    let ok = 0;
    for (let i = 0; i < total; i++) {
      const task = tasks[i];
      if (this.stopped) {
        this.emit({ type: "log", level: "warn", key: "log_queue_stopped" });
        for (const rest of tasks.slice(i)) {
          const task_id = rest.task_id ?? `mock-${results.length}`;
          this.emit({ type: "task_update", task_id, label: rest.label, kind: rest.kind, status: "skipped", error: "" });
          results.push({ task_id, kind: rest.kind, label: rest.label, status: "skipped", error: "" });
        }
        break;
      }
      const task_id = task.task_id ?? `mock-${i}`;
      this.emit({ type: "task_update", task_id, label: task.label, kind: task.kind, status: "running", error: "" });
      if (task.kind === "download") {
        this.emit({ type: "item_start", index: i + 1, total, url: task.url });
        for (const pct of [30, 70, 100]) {
          await delay(150);
          this.emit({ type: "progress", pct, speed: "3.4MiB/s", eta: pct < 100 ? "00:02" : "--" });
        }
      } else {
        this.emit({ type: "log", level: "info", key: "log_convert_start",
                   fmt: { i: i + 1, t: total, src: task.label, dst: task.dst_path } });
        await delay(280);
      }
      this.emit({ type: "task_update", task_id, label: task.label, kind: task.kind, status: "done", error: "" });
      results.push({ task_id, kind: task.kind, label: task.label, status: "done", error: "", ...(task.kind === "convert" ? { dst_path: task.dst_path } : {}) });
      ok++;
    }
    this.emit({ type: "log", level: "ok", key: "log_queue_done", fmt: { ok, fail: total - ok, t: total } });
    return { tasks: results, summary: { total, succeeded: ok, failed: 0, skipped: total - ok, cancelled: this.stopped } };
    } finally { this.finish(operationId); }
  }

  async onEvent(cb: (e: EngineEvent) => void): Promise<() => void> {
    this.listeners.add(cb);
    this.observers.forEach((observer) => observer("open"));
    return () => {
      this.listeners.delete(cb);
      if (!this.listeners.size) this.observers.forEach((observer) => observer("disconnected"));
    };
  }
  onConnectionState(cb: (state: ConnectionState) => void): () => void {
    this.observers.add(cb);
    cb(this.listeners.size ? "open" : "disconnected");
    return () => { this.observers.delete(cb); };
  }
  retryEvents() { if (this.listeners.size) this.observers.forEach((observer) => observer("open")); }
}

class CoordinatedApi implements Api {
  private readonly operations: OperationCoordinator;
  private readonly transport: Transport;
  private readonly uncertainListeners = new Set<(notice: OperationNotice) => void>();

  constructor(transport: Transport) {
    this.transport = transport;
    let eventsOpen = false;
    transport.onConnectionState((state) => { eventsOpen = state === "open"; });
    this.operations = new OperationCoordinator(transport, {
      onUncertain: () => this.uncertainListeners.forEach((listener) => listener("uncertain")),
      onLostOutcome: (outcome, recognizedError) => this.uncertainListeners.forEach((listener) => listener(
        outcome === "not_started" ? "not_started" : outcome === "unknown_idle" ? "result_unknown" : recognizedError ? "response_error" : "result_lost",
      )),
      canStart: () => eventsOpen,
    });
  }
  getFormats() { return this.transport.getFormats(); }
  getLocales() { return this.transport.getLocales(); }
  startDownload(args: DownloadArgs) {
    return this.operations.run("download", (operation_id) => this.transport.startDownload({ ...args, operation_id }));
  }
  previewPlaylist(args: PlaylistPreviewArgs) { return this.transport.previewPlaylist(args); }
  startConvert(args: ConvertArgs) {
    return this.operations.run("convert", (operation_id) => this.transport.startConvert({ ...args, operation_id }));
  }
  previewConvert(args: ConvertArgs) { return this.transport.previewConvert(args); }
  previewQueue(tasks: QueuePreviewTask[]) { return this.transport.previewQueue(tasks); }
  aiPlan(apiKey: string, prompt: string, context: AiContext) { return this.transport.aiPlan(apiKey, prompt, context); }
  runQueue(tasks: AiTask[], overwriteConfirmed = false) {
    return this.operations.run("run_queue", (id) => this.transport.runQueue(tasks, overwriteConfirmed, id));
  }
  stop() { return this.operations.stop(); }
  onEvent(cb: (e: EngineEvent) => void) {
    return this.transport.onEvent((event) => { if (this.operations.acceptsEvent(event)) cb(event); });
  }
  onConnectionState(cb: (state: ConnectionState) => void) { return this.transport.onConnectionState(cb); }
  onOperationUncertain(cb: (notice: OperationNotice) => void) {
    this.uncertainListeners.add(cb);
    return () => { this.uncertainListeners.delete(cb); };
  }
  retryEvents() { this.transport.retryEvents(); }
}

// Non-Tauri selection is decided at build time: `VITE_BACKEND=web` (the
// `build:web` script) picks the real web backend; otherwise mock preview.
const USE_WEB = import.meta.env.VITE_BACKEND === "web";

const transport: Transport = isTauri
  ? new TauriApi()
  : USE_WEB
    ? new WebApi()
    : new MockApi();
export const api: Api = new CoordinatedApi(transport);
/** True only in the no-backend browser preview (fakes progress, no real work). */
export const IS_MOCK = !isTauri && !USE_WEB;
export const IS_WEB = !isTauri && USE_WEB;
/** True when running inside the Tauri desktop shell (native dialogs, IPC…). */
export const IS_TAURI = isTauri;
export { FORMATS as MOCK_FORMATS };

/**
 * Opens a URL in the system's default browser. Inside Tauri, a plain
 * `<a target="_blank">`/`window.open` doesn't reliably reach the OS browser
 * across platforms, hence the `opener` plugin; in a plain browser tab
 * `window.open` already does the right thing.
 */
export async function openExternal(url: string): Promise<void> {
  if (isTauri) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
