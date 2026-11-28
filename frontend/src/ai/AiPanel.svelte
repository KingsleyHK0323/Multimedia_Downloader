<script lang="ts">
  import { onDestroy } from "svelte";
  import {
    Sparkles, X, Settings, Lock, Loader2, RotateCcw,
    Download, RefreshCw, Clock, CheckCircle2, XCircle, SkipForward,
  } from "lucide-svelte";
  import { t, busy, activeOperation, eventReady } from "../store";
  import { api, IS_MOCK, IS_TAURI, IS_WEB, type AiPlan, type AiTask, type EngineEvent, type QueueConversionPreview, type QueueResultTask } from "../api";
  import { toast } from "../lib/toast";
  import { operationOutcome, reconcileTaskStatuses, redactLog, isAbsoluteNativePath } from "../lib/operation";
  import { safeAiErrorText } from "../lib/operation"; // OpenAI-Codex_app_ui
  import { keyStorageView, type KeySaveState } from "../lib/keyStorage";
  import { QueuePreviewSession, queuePreviewInput } from "../lib/queuePreview";
  import { isValidQueueResult } from "../lib/queueResult";

  const tr = $derived($t);

  let { onclose, open }: { onclose: () => void; open: boolean } = $props();

  // OpenAI-Codex_app_ui: session-only keys are never written to localStorage.
  // Previously saved keys are preserved until the user explicitly removes them.
  const KEY_STORAGE = "mmdl_or_api_key";
  const SAVE_PATH_STORAGE = "mmdl_ai_save_path";
  let keyReadFailed = false;

  function readStored(key: string): string {
    try { return localStorage.getItem(key) ?? ""; }
    catch { if (key === KEY_STORAGE) keyReadFailed = true; return ""; }
  }
  const storedApiKey = readStored(KEY_STORAGE);
  let apiKey = $state(storedApiKey);
  let defaultSavePath = $state(readStored(SAVE_PATH_STORAGE));
  let rememberKey = $state(Boolean(storedApiKey));
  let savedKeyExists = $state(Boolean(storedApiKey));
  let possibleLegacy = $state(keyReadFailed);
  let keySaveState = $state<KeySaveState>("pending");
  let keyEditRevision = $state(0);
  const keyStorageStatus = $derived(keyStorageView({ remember: rememberKey, hasValue: Boolean(apiKey),
    saveState: keySaveState, savedKeyExists, possibleLegacy }));
  let showSettings = $state(!storedApiKey && !IS_MOCK);

  function markKeyStoragePending() { keySaveState = "pending"; keyEditRevision += 1; }

  $effect(() => {
    keyEditRevision;
    if (rememberKey && apiKey) {
      try { localStorage.setItem(KEY_STORAGE, apiKey); savedKeyExists = true; keySaveState = "saved"; }
      catch { possibleLegacy = true; keySaveState = "failed"; }
    } else keySaveState = "idle";
  });
  $effect(() => { try { localStorage.setItem(SAVE_PATH_STORAGE, defaultSavePath); } catch { /* storage may be unavailable */ } });

  type Phase = "idle" | "planning" | "review" | "running" | "done" | "error";
  let phase = $state<Phase>("idle");
  let prompt = $state("");
  let plan = $state<AiPlan | null>(null);
  let taskStatus = $state<Record<string, string>>({});
  let taskResults = $state<Record<string, QueueResultTask>>({});
  let errorText = $state("");
  let stopping = $state(false);
  let queueStarted = $state(false);
  let queueResultsUnreliable = $state(false);
  let queuePreview = $state<QueueConversionPreview | null>(null);
  let queuePreviewing = $state(false);
  const queuePreviewSession = new QueuePreviewSession();
  let nextPlan = 0;
  let dialog = $state<HTMLDivElement | null>(null);
  let closeButton = $state<HTMLButtonElement | null>(null);
  const planPathsValid = $derived(!IS_TAURI || !plan || plan.tasks.every((task) =>
    task.kind === "download" ? isAbsoluteNativePath(task.options.save_path) &&
      (!task.options.cookie_file || isAbsoluteNativePath(task.options.cookie_file)) :
      isAbsoluteNativePath(task.src_path) && isAbsoluteNativePath(task.dst_path)));
  const hasConvertTasks = $derived(Boolean(plan?.tasks.some((task) => task.kind === "convert")));
  const queuePreviewInputs = $derived(plan ? queuePreviewInput(plan.tasks) : []);
  const queuePreviewKey = $derived(JSON.stringify(plan?.tasks.map((task) => task.kind === "convert"
    ? { kind: task.kind, task_id: task.task_id, src_path: task.src_path, dst_path: task.dst_path,
      conflict_policy: task.conflict_policy, label: task.label }
    : { kind: task.kind, task_id: task.task_id }) ?? []));
  let disposed = false;
  let activeUnlisten: (() => void) | undefined;
  function clearSubscription() { const off = activeUnlisten; activeUnlisten = undefined; off?.(); }
  function invalidateQueuePreview() { queuePreviewSession.invalidate(); queuePreview = null; queuePreviewing = false; }
  onDestroy(() => { disposed = true; invalidateQueuePreview(); clearSubscription(); });

  $effect(() => { queuePreviewKey; invalidateQueuePreview(); });

  const examples = $derived([tr("ai_example_1"), tr("ai_example_2"), tr("ai_example_3"), tr("ai_example_4")]);

  function reset() {
    invalidateQueuePreview();
    phase = "idle"; plan = null; taskStatus = {}; taskResults = {}; errorText = ""; prompt = "";
    queueResultsUnreliable = false;
  }

  function removeTask(taskId: string) {
    if (plan && phase === "review") {
      invalidateQueuePreview();
      plan = { ...plan, tasks: plan.tasks.filter((task) => task.task_id !== taskId) };
    }
  }

  $effect(() => {
    if (!open) return;
    const previous = document.activeElement;
    queueMicrotask(() => { if (open) closeButton?.focus(); });
    return () => { if (previous instanceof HTMLElement) previous.focus(); };
  });

  function dialogKey(event: KeyboardEvent) {
    if (event.key === "Escape") { event.preventDefault(); onclose(); return; }
    if (event.key !== "Tab" || !dialog) return;
    const controls = Array.from(dialog.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href]"));
    if (!controls.length) return;
    if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls[controls.length - 1].focus(); }
    else if (!event.shiftKey && document.activeElement === controls[controls.length - 1]) { event.preventDefault(); controls[0].focus(); }
  }

  async function getPlan() {
    if (!IS_MOCK && !apiKey.trim()) {
      errorText = tr("ai_no_key"); phase = "error"; showSettings = true; return;
    }
    if (!prompt.trim() || $busy || !$eventReady) return;
    invalidateQueuePreview();
    phase = "planning"; errorText = "";
    busy.set(true); activeOperation.set("ai-plan");
    try {
      const result = await api.aiPlan(apiKey, prompt, { save_path: defaultSavePath, browser: "none" });
      const prefix = `plan-${Date.now()}-${++nextPlan}`;
      plan = { ...result, tasks: result.tasks.map((task, i) => ({ ...task, task_id: `${prefix}-${i}` })) };
      taskStatus = Object.fromEntries(plan.tasks.map((task) => [task.task_id!, "pending"]));
      taskResults = {};
      phase = "review";
    } catch (e) {
      // OpenAI-Codex_app_ui: fall back safely if error redaction fails.
      try {
        errorText = redactLog(String(e instanceof Error ? e.message : e));
      } catch { errorText = "[redacted]"; }
      if (typeof errorText !== "string") errorText = "[redacted]";
      phase = "error";
    } finally {
      busy.set(false); activeOperation.set(null);
    }
  }

  async function previewQueueConversions() {
    if (phase !== "review" || !plan || !hasConvertTasks || !queuePreviewInputs || queuePreviewing || $busy || !planPathsValid) return;
    invalidateQueuePreview();
    queuePreviewing = true;
    const key = queuePreviewKey;
    const result = await queuePreviewSession.request(plan.tasks, (tasks) => api.previewQueue(tasks));
    if (disposed || !queuePreviewSession.isCurrent(result.generation) || result.kind === "stale") return;
    if (phase !== "review" || key !== queuePreviewKey) { invalidateQueuePreview(); return; }
    queuePreviewing = false;
    if (result.kind === "ready") queuePreview = result.value;
    else if (result.kind === "invalid") toast(tr("preview_failed"), "err");
    else if (result.kind === "error") toast(safeAiErrorText(() => redactLog(String(result.error instanceof Error ? result.error.message : result.error))), "err");
  }

  // D4 gate: this is the ONLY place execution starts, and only on user click.
  // OpenAI-Codex_engine_cli: terminal results supersede provisional event states.
  function markQueueResultUnreliable(tasks: readonly AiTask[]) {
    queueResultsUnreliable = true;
    taskStatus = Object.fromEntries(tasks.map((task) => [task.task_id ?? "", "unknown"]));
    taskResults = {};
    toast(tr("queue_result_unreliable"), "err", 9000);
  }

  async function confirmAndRun() {
    if (!plan || plan.tasks.length === 0 || $busy || !$eventReady || !planPathsValid) return;
    const tasksToRun = plan.tasks;
    const overwrite = plan.tasks.some((task) => task.kind === "convert" && task.conflict_policy === "overwrite");
    if (overwrite && !window.confirm(tr("conflict_overwrite_confirm"))) return;
    invalidateQueuePreview();
    queueResultsUnreliable = false;
    phase = "running";
    busy.set(true); activeOperation.set("ai-queue"); stopping = false; queueStarted = false;
    try {
      const off = await api.onEvent((e: EngineEvent) => {
        if (queueResultsUnreliable) return;
        if (e.type === "task_update" && e.task_id) taskStatus = { ...taskStatus, [e.task_id]: e.status };
      });
      if (disposed || !$eventReady) {
        off();
        if (!disposed) { errorText = tr("event_disconnected"); toast(errorText, "err"); }
        if (!disposed) markQueueResultUnreliable(tasksToRun);
        return;
      }
      activeUnlisten = off;
      queueStarted = true;
      const res = await api.runQueue(tasksToRun, overwrite);
      if (!isValidQueueResult(tasksToRun, res)) {
        if (!disposed) markQueueResultUnreliable(tasksToRun);
        return;
      }
      const ids = new Set(tasksToRun.map((task) => task.task_id));
      const consistent = Array.isArray(res?.tasks) && res.tasks.length === tasksToRun.length &&
        res.summary?.total === tasksToRun.length && new Set(res.tasks.map((task) => task.task_id)).size === ids.size &&
        res.tasks.every((task) => ids.has(task.task_id));
      if (consistent) {
        taskStatus = { ...taskStatus, ...reconcileTaskStatuses(res.tasks) };
        taskResults = Object.fromEntries(res.tasks.map((task) => [task.task_id, task]));
      }
      const outcome = consistent ? operationOutcome(res?.summary) : "unknown";
      toast(tr(`operation_${outcome}`, res?.summary), outcome === "succeeded" ? "ok" : outcome === "cancelled" ? "info" : "err");
    } catch (e) {
      if (!disposed) markQueueResultUnreliable(tasksToRun);
      // OpenAI-Codex_app_ui: fall back safely if queue error redaction fails.
      try {
        errorText = redactLog(String(e instanceof Error ? e.message : e));
      } catch { errorText = "[redacted]"; }
      if (typeof errorText !== "string") errorText = "[redacted]";
      toast(errorText, "err");
    } finally {
      invalidateQueuePreview();
      clearSubscription(); phase = "done"; stopping = false; queueStarted = false;
      busy.set(false); activeOperation.set(null);
    }
  }

  async function stopQueue() {
    if (stopping || !queueStarted || $activeOperation !== "ai-queue") return;
    stopping = true;
    try {
      const result = await api.stop();
      if (result?.stopping) toast(tr("stop_requested"), "info");
      else { stopping = false; toast(tr("stop_not_active"), "info"); }
    }
    catch (e) { stopping = false; toast(safeAiErrorText(() => redactLog(String(e instanceof Error ? e.message : e))), "err"); }
  }

  function taskLine(task: AiTask): string {
    const actual = task.task_id ? taskResults[task.task_id]?.dst_path : undefined;
    return task.kind === "download" ? task.url : `${task.src_path} → ${actual || task.dst_path}`;
  }

  function downloadLink(value?: string): string | null {
    if (!IS_WEB || !value) return null;
    try {
      const url = new URL(value, window.location.origin);
      return url.origin === window.location.origin && url.pathname.startsWith("/files/") ? url.href : null;
    } catch { return null; }
  }

  const statusIcons: Record<string, { icon: typeof Clock; cls: string }> = {
    unknown: { icon: Clock, cls: "text-amber-500" },
    pending: { icon: Clock, cls: "text-zinc-400" },
    running: { icon: Loader2, cls: "animate-spin text-indigo-500" },
    done: { icon: CheckCircle2, cls: "text-emerald-500" },
    error: { icon: XCircle, cls: "text-red-500" },
    skipped: { icon: SkipForward, cls: "text-amber-500" },
  };

  const inputCls =
    "w-full rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-2.5 text-sm " +
    "placeholder:text-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:placeholder:text-zinc-600";
</script>

<!-- Backdrop (click to close) -->
<div
  class="fixed inset-0 z-40 bg-black/45 backdrop-blur-[2px]"
  onclick={onclose}
  aria-hidden="true"
></div>

<!-- Panel: right sidebar on lg+, bottom sheet (with drag handle + safe area) below -->
<div
  bind:this={dialog}
  class="fixed z-50 flex flex-col border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-900
         inset-x-0 bottom-0 max-h-[85dvh] rounded-t-2xl border-t
         lg:inset-x-auto lg:top-0 lg:right-0 lg:h-full lg:max-h-none lg:w-105 lg:rounded-none lg:border-t-0 lg:border-l"
  role="dialog"
  tabindex="-1"
  onkeydown={dialogKey}
  aria-modal="true"
  aria-label={tr("ai_assistant")}
>
  <!-- Mobile drag handle -->
  <div class="grid place-items-center py-2 lg:hidden" aria-hidden="true">
    <div class="h-1 w-10 rounded-full bg-zinc-300 dark:bg-zinc-700"></div>
  </div>

  <header class="flex items-center gap-2 border-b border-zinc-200 px-4 pb-3 lg:pt-4 dark:border-zinc-800">
    <div class="grid size-7 place-items-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 text-white">
      <Sparkles class="size-3.5" aria-hidden="true" />
    </div>
    <div class="min-w-0 flex-1 leading-tight">
      <strong class="block text-sm">{tr("ai_assistant")}</strong>
      <span class="text-[10px] text-zinc-400 dark:text-zinc-500">{tr("ai_powered_by")}</span>
    </div>
    <button
      class="grid size-9 place-items-center rounded-lg text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
      onclick={() => (showSettings = !showSettings)}
      aria-label={tr("ai_settings")}
      aria-expanded={showSettings}
    ><Settings class="size-4" aria-hidden="true" /></button>
    <button
      bind:this={closeButton}
      class="grid size-9 place-items-center rounded-lg text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
      onclick={onclose}
      aria-label={tr("btn_cancel")}
    ><X class="size-4" aria-hidden="true" /></button>
  </header>

  <div class="pb-safe flex-1 space-y-4 overflow-y-auto p-4">
    {#if IS_MOCK}
      <p class="rounded-lg bg-amber-50 px-3 py-2 text-[11px] text-amber-700 dark:bg-amber-950/40 dark:text-amber-400">
        {tr("ai_mock_notice")}
      </p>
    {/if}

    {#if showSettings}
      <div class="space-y-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950">
        <label class="block">
          <span class="mb-1.5 block text-xs font-medium text-zinc-600 dark:text-zinc-400">{tr("ai_api_key_label")}</span>
          <input type="password" autocomplete="off" class={inputCls} bind:value={apiKey} placeholder={tr("ai_api_key_placeholder")}
                 oninput={markKeyStoragePending}
                 aria-describedby={keyStorageStatus.legacy ? "ai-key-storage-hint ai-key-legacy-hint" : "ai-key-storage-hint"} />
        </label>
        <label class="flex items-center gap-2 text-xs text-zinc-700 dark:text-zinc-300">
          <input type="checkbox" bind:checked={rememberKey} onchange={markKeyStoragePending} />{tr("ai_remember_key")}
        </label>
        <p id="ai-key-storage-hint" role={keyStorageStatus.hint === "ai_key_save_failed_hint" ? "alert" : undefined} class="text-xs text-zinc-600 dark:text-zinc-400">{keyStorageStatus.hint ? tr(keyStorageStatus.hint) : ""}</p>
        {#if keyStorageStatus.legacy}<p id="ai-key-legacy-hint" class="text-xs text-amber-700 dark:text-amber-400">{tr(keyStorageStatus.legacy)}</p>{/if}
        {#if IS_WEB}<p class="text-xs text-zinc-600 dark:text-zinc-400">{tr("ai_key_web_hint")}</p>{/if}
        <label class="block">
          <span class="mb-1.5 block text-xs font-medium text-zinc-600 dark:text-zinc-400">{tr("ai_default_save_path")}</span>
          <input class={inputCls} bind:value={defaultSavePath} placeholder={tr(IS_WEB ? "ai_web_output_placeholder" : "local_output_placeholder")} aria-describedby="ai-save-hint" />
          <span id="ai-save-hint" class="mt-1 block text-xs text-zinc-500">{tr("ai_save_path_hint")}</span>
        </label>
      </div>
    {/if}

    {#if phase === "idle" || phase === "error"}
      <!-- Example prompt chips -->
      <div>
        <p class="mb-2 text-xs text-zinc-500 dark:text-zinc-400">{tr("ai_examples_title")}</p>
        <div class="flex flex-wrap gap-1.5">
          {#each examples as ex}
            <button
              class="max-w-full truncate rounded-full border border-zinc-300 px-3 py-1.5 text-[11px]
                     text-zinc-600 hover:border-indigo-400 hover:text-indigo-500
                     dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-indigo-500"
              onclick={() => (prompt = ex)}
            >{ex}</button>
          {/each}
        </div>
      </div>

      <textarea rows="4" aria-label={tr("ai_prompt_label")} class={inputCls + " resize-y"} bind:value={prompt} placeholder={tr("ai_prompt_placeholder")}></textarea>

      {#if phase === "error"}
        <p class="text-xs text-red-500">{errorText}</p>
      {/if}

      <button
        class="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r
               from-indigo-500 to-violet-600 text-sm font-semibold text-white shadow-sm
               transition hover:opacity-95 active:scale-[0.99] disabled:opacity-50"
        onclick={getPlan}
        disabled={!prompt.trim() || $busy || !$eventReady}
      >
        <Sparkles class="size-4" aria-hidden="true" />{tr("ai_btn_plan")}
      </button>

    {:else if phase === "planning"}
      <div class="grid place-items-center gap-3 py-10 text-zinc-500 dark:text-zinc-400">
        <Loader2 class="size-7 animate-spin text-indigo-500" aria-hidden="true" />
        <p class="text-sm">{tr("ai_planning")}</p>
      </div>

    {:else if plan}
      <p class="text-sm font-semibold">{plan.summary}</p>

      {#if plan.tasks.length === 0}
        <p class="text-xs text-zinc-500 dark:text-zinc-400">{tr("ai_no_tasks")}</p>
      {:else}
        <div>
          <p class="mb-2 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
            {tr("ai_tasks_title")}
          </p>
          <ul class="flex flex-col gap-1.5">
            {#each plan.tasks as task, i}
              {@const s = statusIcons[taskStatus[task.task_id ?? ""] ?? "pending"] ?? statusIcons.pending}
              {@const snapshot = queuePreview?.jobs.find((job) => job.task_id === task.task_id)}
              <li class="flex items-center gap-2.5 rounded-lg bg-zinc-50 px-3 py-2.5 text-xs dark:bg-zinc-950">
                <s.icon class="size-4 shrink-0 {s.cls}" aria-hidden="true" />
                {#if task.kind === "download"}
                  <Download class="size-3.5 shrink-0 text-zinc-400" aria-hidden="true" />
                {:else}
                  <RefreshCw class="size-3.5 shrink-0 text-zinc-400" aria-hidden="true" />
                {/if}
                <div class="min-w-0 flex-1">
                  <span class="block text-[10px] text-zinc-400">
                    {task.kind === "download" ? tr("ai_task_download") : tr("ai_task_convert")}
                  </span>
                  <span class="block break-all font-mono text-zinc-700 dark:text-zinc-300">{taskLine(task)}</span>
                  <span class="block">{tr(`task_status_${taskStatus[task.task_id ?? ""] ?? "pending"}`)}</span>
                  {#if task.kind === "download"}
                    <span class="block break-all">{tr("ai_plan_save_path")}: {task.options.save_path}</span>
                    <span class="block">{tr("ai_plan_mode")}: {task.options.mode} · {tr("ai_plan_format")}: {task.options.mode === "audio" ? task.options.audio_fmt : task.options.video_fmt} · {tr("lbl_quality")} {task.options.quality} · {tr("ai_plan_browser")}: {task.options.browser}</span>
                    {#if task.options.mode === "audio"}<span class="block">{tr("ai_plan_bitrate")}: {task.options.bitrate ?? "192"} kbps</span>{/if}
                    {#if task.options.cookie_file}<span class="block break-all">{tr("ai_plan_cookie_file")}: {task.options.cookie_file}</span>{/if}
                  {:else}
                    <span class="block">{tr("conflict_label")}: {tr(`conflict_${task.conflict_policy ?? "rename"}`)}</span>
                    {#if phase === "review" && snapshot}
                      <span class="mt-1 block break-all font-mono">{snapshot.src} → {snapshot.dst}</span>
                      <span class="block">{tr("preview_existing")}: {tr(`preview_${snapshot.existing}`)}</span>
                      <span class="block">{tr("preview_source_matches")}: {tr(`preview_${snapshot.source_matches}`)}</span>
                      {#if snapshot.batch_duplicate}<span class="block text-amber-700 dark:text-amber-400">{tr("preview_batch_duplicate")}</span>{/if}
                    {/if}
                  {/if}
                  {#if task.task_id && taskResults[task.task_id]?.error}<span class="block break-all text-red-600 dark:text-red-400">{redactLog(taskResults[task.task_id].error)}</span>{/if}
                  {#if task.task_id && downloadLink(taskResults[task.task_id]?.download_url)}<a class="underline" href={downloadLink(taskResults[task.task_id]?.download_url) ?? undefined}>{tr("download_output")}</a>{/if}
                </div>
                {#if phase === "review"}<button class="min-h-11 px-2 underline" onclick={() => removeTask(task.task_id ?? "")}>{tr("btn_remove_selected")}</button>{/if}
              </li>
            {/each}
          </ul>
        </div>
      {/if}

      {#if plan.warnings.length > 0}
        <div>
          <p class="mb-1.5 text-[11px] font-semibold tracking-wide text-amber-500 uppercase">{tr("ai_warnings_title")}</p>
          <ul class="space-y-1 text-[11px] text-amber-600 dark:text-amber-400">
            {#each plan.warnings as w}<li>• {w}</li>{/each}
          </ul>
        </div>
      {/if}

      {#if phase === "review"}
        {#if !planPathsValid}<p role="alert" class="text-sm text-red-700 dark:text-red-400">{tr("ai_local_paths_invalid")}</p>{/if}
        {#if hasConvertTasks}
          {#if !queuePreviewInputs}<p role="alert" class="text-xs text-red-600 dark:text-red-400">{tr("preview_failed")}</p>{/if}
          <button type="button" class="min-h-11 rounded-xl border border-zinc-300 px-4 text-xs disabled:opacity-50 dark:border-zinc-700"
                  onclick={previewQueueConversions} disabled={queuePreviewing || $busy || !planPathsValid || !queuePreviewInputs}>{tr("preview_button")}</button>
          {#if queuePreview}<p role="status" class="text-xs text-zinc-600 dark:text-zinc-400">{tr("ai_preview_snapshot_hint")}</p>{/if}
        {/if}
        <!-- Safety gate (D4): nothing has run yet; execution needs this click. -->
        <p class="flex items-start gap-2 rounded-lg bg-zinc-100 px-3 py-2.5 text-[11px] leading-snug text-zinc-600 dark:bg-zinc-950 dark:text-zinc-400">
          <Lock class="mt-0.5 size-3.5 shrink-0 text-emerald-500" aria-hidden="true" />
          {tr("ai_safety_note")}
        </p>
        <div class="flex flex-col gap-2">
          <button
            class="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-emerald-600
                   text-sm font-bold text-white shadow-sm transition hover:bg-emerald-500
                   active:scale-[0.99] disabled:opacity-50"
            onclick={confirmAndRun}
            disabled={plan.tasks.length === 0 || $busy || !$eventReady || !planPathsValid}
          >
            <CheckCircle2 class="size-4.5" aria-hidden="true" />{tr("btn_confirm")}
          </button>
          <div class="flex gap-2">
            <button
              class="flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-xl border border-zinc-300
                     text-xs text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              onclick={getPlan}
            ><RotateCcw class="size-3.5" aria-hidden="true" />{tr("ai_regenerate")}</button>
            <button
              class="flex min-h-10 flex-1 items-center justify-center rounded-xl border border-zinc-300
                     text-xs text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              onclick={reset}
            >{tr("btn_cancel")}</button>
          </div>
        </div>
      {:else if phase === "running"}
        <div class="flex flex-col items-center justify-center gap-2 py-3 text-sm text-zinc-500 dark:text-zinc-400">
          <span class="flex items-center gap-2"><Loader2 class="size-4 animate-spin text-indigo-500" aria-hidden="true" />{tr("ai_running")}</span>
          <p>{tr("ai_close_background")}</p>
          <button class="min-h-11 rounded-lg border px-4 disabled:opacity-50" onclick={stopQueue} disabled={stopping || !queueStarted || $activeOperation !== "ai-queue"}>{tr("btn_stop")}</button>
        </div>
      {:else if phase === "done"}
        {#if queueResultsUnreliable}<p role="alert" class="text-xs text-amber-700 dark:text-amber-400">{tr("queue_result_unreliable")}</p>{/if}
        {#if errorText}<p class="text-xs text-red-500">{errorText}</p>{/if}
        <div class="flex gap-2">
          <button
            class="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-indigo-500
                   text-sm font-semibold text-white hover:bg-indigo-600"
            onclick={reset}
          ><Sparkles class="size-4" aria-hidden="true" />{tr("ai_new_request")}</button>
          <button
            class="flex min-h-11 items-center justify-center rounded-xl border border-zinc-300 px-4
                   text-sm text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            onclick={onclose}
          >{tr("btn_cancel")}</button>
        </div>
      {/if}
    {/if}
  </div>
</div>
