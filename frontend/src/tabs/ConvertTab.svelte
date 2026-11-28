<script lang="ts">
  import { onMount } from "svelte";
  import { Play, Square, X, FileVideo } from "lucide-svelte";
  import Card from "../components/Card.svelte";
  import { api, IS_TAURI, IS_WEB, type Formats, type ConvertJob, type ConversionPreview, type VideoEncoder } from "../api";
  import { t, busy, activeOperation, eventReady } from "../store";
  import { toast } from "../lib/toast";
  import { operationOutcome, redactLog, isAbsoluteNativePath, PreviewGeneration } from "../lib/operation";
  import { safeAiErrorText } from "../lib/operation"; // OpenAI-Codex_app_ui
  import { isValidConversionResult } from "../lib/convertResult";
  import { readUploadConfig, uploadFile, isValidUploadFile, UploadError, type UploadConfig, type UploadProgress } from "../lib/webUpload";

  let { formats, active }: { formats: Formats | null; active: boolean } = $props();
  const tr = $derived($t);

  // OpenAI-Codex_app_ui: a browser file name is not a usable native path.
  type Entry = { path: string };
  let entries = $state<Entry[]>([]);
  let dstFmt = $state("mp4");
  // OpenAI-Codex_Fork_Source_Code: software remains the explicit default.
  let videoEncoder = $state<VideoEncoder>("software");
  let savePath = $state("");
  let conflictPolicy = $state<"rename" | "skip" | "overwrite">("rename");
  let jobs = $state<ConvertJob[]>([]);
  // OpenAI-Codex_app_ui: keep unconfirmed results and safe diagnostics visible.
  let conversionResultUnreliable = $state(false);
  let conversionError = $state("");
  let stopping = $state(false);
  let nativeDropReady = $state(false);
  let nativeDropOver = $state(false);
  let pathInput = $state("");
  let pickingFiles = $state(false);
  // OpenAI-Codex_engine_cli: uploaded paths enter the list only after finish is confirmed.
  let uploadConfig = $state<UploadConfig | null>(null);
  let uploadConfigLoading = $state(IS_WEB);
  let uploadConfigError = $state(false);
  let selectedUpload = $state<File | null>(null);
  let completedUpload = $state<File | null>(null);
  let uploading = $state(false);
  let uploadProgress = $state<UploadProgress | null>(null);
  let uploadFeedback = $state<"" | "invalid" | "unconfirmed" | "completed">("");
  let uploadController: AbortController | null = null;
  let uploadConfigController: AbortController | null = null;
  let uploadDisposed = false;
  // OpenAI-Codex_Fork_Source_Code: preview is a snapshot, never a reservation.
  let preview = $state<ConversionPreview | null>(null);
  let previewing = $state(false);
  const previewGeneration = new PreviewGeneration();

  const allFormats = $derived([...(formats?.video ?? []), ...(formats?.audio ?? [])]);
  const encoderFormatSupported = $derived(videoEncoder === "software" ||
    (formats?.hardware_video_formats ?? []).includes(dstFmt.toLowerCase()));
  const validSavePath = $derived(!IS_TAURI || isAbsoluteNativePath(savePath.trim()));
  const previewKey = $derived(JSON.stringify({
    files: entries.map((entry) => entry.path), dst_fmt: dstFmt,
    save_path: savePath.trim(), conflict_policy: conflictPolicy,
  }));

  function invalidatePreview() {
    previewGeneration.invalidate();
    preview = null;
  }

  $effect(() => {
    previewKey;
    invalidatePreview();
  });

  const uploadReasonKeys = new Map([
    ["not_configured", "web_upload_reason_not_configured"],
    ["invalid_configuration", "web_upload_reason_invalid_configuration"],
    ["insufficient_total", "web_upload_reason_insufficient_total"],
    ["unrestricted_paths", "web_upload_reason_unrestricted_paths"],
    ["unsupported_platform", "web_upload_reason_unsupported_platform"],
  ]);

  // OpenAI-Codex_Fork_Source_Code: describe the initial platform boundary.
  uploadReasonKeys.set("unsupported_platform", "web_upload_reason_windows_local_only");

  async function refreshUploadConfig() {
    if (!IS_WEB || uploading) return;
    uploadConfigController?.abort();
    const controller = new AbortController();
    uploadConfigController = controller;
    uploadConfigLoading = true;
    uploadConfigError = false;
    try {
      const result = await readUploadConfig(fetch, controller.signal);
      if (!uploadDisposed && uploadConfigController === controller) uploadConfig = result;
    } catch {
      if (!uploadDisposed && uploadConfigController === controller) {
        uploadConfig = null;
        uploadConfigError = true;
      }
    } finally {
      if (!uploadDisposed && uploadConfigController === controller) uploadConfigLoading = false;
    }
  }

  onMount(() => {
    if (!IS_WEB) return;
    uploadDisposed = false;
    void refreshUploadConfig();
    return () => {
      uploadDisposed = true;
      uploadConfigController?.abort();
      uploadController?.abort();
    };
  });

  function selectUpload(event: Event) {
    if (uploading) return;
    const input = event.currentTarget as HTMLInputElement;
    selectedUpload = input.files?.[0] ?? null;
    completedUpload = null;
    uploadProgress = null;
    uploadFeedback = "";
  }

  async function startUpload() {
    if (!IS_WEB || uploading || $busy) return;
    if (!selectedUpload || !uploadConfig || !isValidUploadFile(selectedUpload, uploadConfig)) {
      uploadFeedback = "invalid";
      return;
    }
    if (selectedUpload === completedUpload) return;
    const file = selectedUpload;
    const config = uploadConfig;
    const controller = new AbortController();
    uploadController = controller;
    uploading = true;
    uploadFeedback = "";
    uploadProgress = {sent:0,total:file.size,phase:"uploading"};
    try {
      const path = await uploadFile(file, config, { signal:controller.signal,
        onProgress:(progress) => { if (!uploadDisposed && uploadController === controller) uploadProgress = progress; } });
      if (!uploadDisposed && uploadController === controller && controller.signal.aborted) uploadFeedback = "unconfirmed";
      if (uploadDisposed || controller.signal.aborted || uploadController !== controller) return;
      invalidatePreview();
      entries.push({path});
      completedUpload = file;
      uploadFeedback = "completed";
    } catch (error) {
      if (!uploadDisposed && uploadController === controller) {
        uploadFeedback = error instanceof UploadError && error.kind === "invalid_file" ? "invalid" : "unconfirmed";
      }
    } finally {
      if (uploadController === controller) {
        uploadController = null;
        if (!uploadDisposed) uploading = false;
      }
    }
  }

  function stopUpload() {
    uploadController?.abort();
  }

  onMount(() => {
    if (!IS_TAURI) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) => getCurrentWebview().onDragDropEvent((event) => {
        if (disposed || !active) return;
        if (event.payload.type === "enter" || event.payload.type === "over") nativeDropOver = true;
        else if (event.payload.type === "leave") nativeDropOver = false;
        else if (event.payload.type === "drop") {
          nativeDropOver = false;
          const paths = event.payload.paths.filter(isAbsoluteNativePath);
          if (paths.length) invalidatePreview();
          for (const path of paths) entries.push({ path });
          if (paths.length !== event.payload.paths.length) toast(tr("native_path_rejected"), "err");
        }
      }))
      .then((off) => {
        if (disposed) off();
        else { unlisten = off; nativeDropReady = true; }
      })
      .catch(() => { if (!disposed) nativeDropReady = false; });
    return () => { disposed = true; unlisten?.(); };
  });

  // OpenAI-Codex_ai_ui_check: native selection returns paths under the user's control.
  async function pickFiles() {
    if (!IS_TAURI || pickingFiles || $busy) return;
    pickingFiles = true;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const paths = await invoke<string[]>("select_convert_files");
      if (!paths.length || $busy) return;
      if (!paths.every(isAbsoluteNativePath)) {
        toast(tr("native_path_rejected"), "err");
        return;
      }
      invalidatePreview();
      for (const path of paths) entries.push({ path });
    } catch (error) {
      toast(safeAiErrorText(() => redactLog(String(error))), "err");
    } finally {
      pickingFiles = false;
    }
  }

  function addTyped() {
    const paths = pathInput.split("\n").map((p) => p.trim()).filter(Boolean);
    if (IS_TAURI && paths.some((path) => !isAbsoluteNativePath(path))) {
      toast(tr("convert_local_path_invalid"), "err");
      return;
    }
    if (paths.length) invalidatePreview();
    for (const p of paths) entries.push({ path: p });
    pathInput = "";
  }
  function downloadLink(value?: string): string | null {
    if (!IS_WEB || !value) return null;
    try {
      const url = new URL(value, window.location.origin);
      return url.origin === window.location.origin && url.pathname.startsWith("/files/") ? url.href : null;
    } catch { return null; }
  }

  async function previewConversion() {
    if (uploading) return;
    if (previewing || entries.length === 0 || $busy || !formats || !validSavePath) return;
    const key = previewKey;
    const generation = previewGeneration.capture();
    const files = entries.map((entry) => entry.path);
    previewing = true;
    preview = null;
    try {
      const result = await api.previewConvert({
        files, dst_fmt: dstFmt, save_path: savePath.trim(), conflict_policy: conflictPolicy,
      });
      const valid = Array.isArray(result?.jobs) && result.jobs.length === files.length &&
        result.jobs.every((job) => typeof job.src === "string" && typeof job.dst === "string" &&
          ["exists", "missing", "unknown"].includes(job.existing) &&
          typeof job.batch_duplicate === "boolean" &&
          ["yes", "no", "unknown"].includes(job.source_matches));
      if (!valid) throw new Error(tr("preview_failed"));
      if (previewGeneration.isCurrent(generation) && key === previewKey) preview = result;
    } catch (e) {
      if (previewGeneration.isCurrent(generation) && key === previewKey) {
        // OpenAI-Codex_app_ui: retain a localized preview-error label.
        let previewErrorLabel = "Preview error";
        try {
          const translated = tr("preview_failed");
          if (typeof translated === "string" && translated.trim()) previewErrorLabel = translated;
        } catch {
          // Retain the fixed fallback if localization fails.
        }
        // OpenAI-Codex_app_ui: avoid repeating an identical preview diagnostic.
        const formatPreviewError = (message = "") =>
          message === previewErrorLabel + " " + previewErrorLabel ? previewErrorLabel : message;
        toast(formatPreviewError(previewErrorLabel + " " + safeAiErrorText(() => redactLog(String(e instanceof Error ? e.message : e)))), "err");
      }
    } finally {
      previewing = false;
    }
  }

  async function start() {
    // OpenAI-Codex_Fork_Source_Code: extracted mock callers remain software-only.
    const selectedVideoEncoder = typeof videoEncoder === "undefined" ? "software" : videoEncoder;
    const selectedEncoderAllowed = typeof encoderFormatSupported === "undefined" || encoderFormatSupported;
    if (uploading) return;
    if (entries.length === 0 || $busy || !$eventReady || !formats || !validSavePath || !selectedEncoderAllowed) return;
    const startedFiles = entries.map((entry) => entry.path);
    const overwriteConfirmed = conflictPolicy === "overwrite" && window.confirm(tr("conflict_overwrite_confirm"));
    if (conflictPolicy === "overwrite" && !overwriteConfirmed) return;
    invalidatePreview();
    busy.set(true);
    activeOperation.set("convert");
    stopping = false;
    jobs = [];
    conversionResultUnreliable = false;
    conversionError = "";
    try {
      const result = await api.startConvert({
        files: startedFiles,
        dst_fmt: dstFmt,
        save_path: savePath.trim(),
        conflict_policy: conflictPolicy,
        video_encoder: selectedVideoEncoder,
        ...(overwriteConfirmed ? { overwrite_confirmed: true } : {}),
      });
      // OpenAI-Codex_engine_cli: never render or report inconsistent results as success.
      if (!isValidConversionResult(result, startedFiles, !IS_WEB)) {
        conversionResultUnreliable = true;
        toast(tr("conversion_result_unreliable"), "err", 9000);
        return;
      }
      jobs = Array.isArray(result?.jobs) ? result.jobs : [];
      const consistent = Array.isArray(result?.jobs) && result.jobs.length === startedFiles.length && result.summary?.total === startedFiles.length;
      const outcome = consistent ? operationOutcome(result?.summary) : "unknown";
      toast(tr(`operation_${outcome}`, result?.summary), outcome === "succeeded" ? "ok" : outcome === "cancelled" ? "info" : "err");
    } catch (e) {
      // OpenAI-Codex_app_ui: retain only a safely formatted diagnostic.
      conversionResultUnreliable = true;
      conversionError = safeAiErrorText(() => redactLog(String(e instanceof Error ? e.message : e)));
      e = conversionError;
      toast(tr("conversion_result_unreliable"), "err", 9000);
      toast(safeAiErrorText(() => redactLog(String(e instanceof Error ? e.message : e))), "err");
    } finally {
      invalidatePreview();
      busy.set(false);
      activeOperation.set(null);
      stopping = false;
    }
  }
  async function stop() {
    if (stopping || $activeOperation !== "convert") return;
    stopping = true;
    try {
      const result = await api.stop();
      if (result?.stopping) toast(tr("stop_requested"), "info");
      else { stopping = false; toast(tr("stop_not_active"), "info"); }
    }
    catch (e) { stopping = false;
      // OpenAI-Codex_app_ui: retain a localized stop-error label.
      let stopErrorLabel = "Stop error";
      try {
        const stopLabel = tr("btn_stop"), errorLabel = tr("web_job_error");
        if (typeof stopLabel === "string" && stopLabel.trim() && typeof errorLabel === "string" && errorLabel.trim()) stopErrorLabel = stopLabel + " " + errorLabel;
      } catch {
        // Retain the fixed fallback if localization fails.
      }
      toast(stopErrorLabel + ": " + safeAiErrorText(() => redactLog(String(e instanceof Error ? e.message : e))), "err"); }
  }

  const inputCls =
    "w-full rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-2.5 text-sm " +
    "placeholder:text-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:placeholder:text-zinc-600";
  const labelCls = "mb-1.5 block text-xs font-medium text-zinc-600 dark:text-zinc-400";
</script>

<div class="flex flex-col gap-4">
  {#if !IS_WEB}
  <p class="rounded-lg px-4 py-3 text-sm {nativeDropOver ? 'bg-indigo-100 text-indigo-900 dark:bg-indigo-950 dark:text-indigo-100' : 'bg-zinc-100 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-200'}">{tr(IS_WEB ? "convert_paths_web" : nativeDropReady ? "convert_paths_desktop_drop" : "convert_paths_desktop")}</p>
  {/if}
  {#if IS_WEB}
    <p class="rounded-lg bg-zinc-100 px-4 py-3 text-sm text-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">{tr("web_upload_intro")}</p>
  {/if}

  <Card title={tr("cv_file_list")}>
    {#if IS_TAURI}
      <button type="button" class="mb-2 rounded-lg border px-3 py-2 text-sm"
              onclick={pickFiles} disabled={pickingFiles || $busy}>{tr("btn_add_files")}</button>
    {/if}
    <div class="flex gap-2">
      <textarea
        rows="2"
        aria-label={tr("convert_path_label")}
        class={inputCls + " resize-y font-mono text-[13px]"}
        bind:value={pathInput}
        placeholder={IS_WEB ? tr("web_input_placeholder") : tr("local_input_placeholder")}
      ></textarea>
      <button
        class="shrink-0 self-start rounded-lg border border-zinc-300 px-3 py-2 text-xs
               hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
        onclick={addTyped}
        aria-label={tr("btn_add_files")}
      >＋</button>
    </div>

    {#if entries.length > 0}
      <p class="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
        {tr("files_selected", { n: entries.length })}
      </p>
      <ul class="mt-1.5 flex flex-col gap-1.5">
        {#each entries as entry, i}
          <li class="flex items-center gap-2.5 rounded-lg bg-zinc-50 px-3 py-2 text-xs dark:bg-zinc-950">
            <FileVideo class="size-3.5 shrink-0 text-zinc-400" aria-hidden="true" />
            <span class="min-w-0 flex-1 truncate font-mono">{entry.path}</span>
            <button
              class="grid size-6 shrink-0 place-items-center rounded text-zinc-400 hover:bg-zinc-200
                     hover:text-red-500 dark:hover:bg-zinc-800"
              aria-label={tr("btn_remove_selected")}
              onclick={() => { invalidatePreview(); entries.splice(i, 1); }}
            ><X class="size-3.5" aria-hidden="true" /></button>
          </li>
        {/each}
      </ul>
    {/if}
  </Card>

  {#if IS_WEB}
    <Card title={tr("web_upload_title")}>
      <div class="space-y-3 text-xs text-zinc-600 dark:text-zinc-400">
        <p>{tr("web_upload_retention")}</p>
        <p>{tr("web_upload_slot_accounting")}</p>
        <p>{tr("web_upload_naming")}</p>
        <p>{tr("web_upload_stop_notice")}</p>
        {#if uploadConfigLoading}
          <p role="status">{tr("web_upload_checking")}</p>
        {:else if uploadConfigError || !uploadConfig}
          <p role="alert">{tr("web_upload_config_error")}</p>
          <button type="button" class="min-h-10 underline" onclick={refreshUploadConfig}>{tr("retry")}</button>
        {:else if !uploadConfig.enabled}
          <p role="status">{tr("web_upload_disabled", {reason:tr(uploadReasonKeys.get(uploadConfig.reason) ?? "web_upload_reason_unknown")})}</p>
          <button type="button" class="min-h-10 underline" onclick={refreshUploadConfig}>{tr("retry")}</button>
        {:else}
          <p>{tr("web_upload_enabled_note")}</p>
          <p>{tr("web_upload_limits", {file:uploadConfig.max_file_bytes, total:uploadConfig.max_total_bytes})}</p>
          <label class="block space-y-1">
            <span>{tr("web_upload_select")}</span>
            <input type="file" class="block w-full text-xs" disabled={uploading || $busy} onchange={selectUpload} />
          </label>
          {#if selectedUpload}
            <p class="break-all">{tr("web_upload_selected", {name:selectedUpload.name, size:selectedUpload.size})}</p>
            {#if !isValidUploadFile(selectedUpload, uploadConfig)}<p role="alert">{tr("web_upload_invalid_file")}</p>{/if}
          {/if}
          <div class="flex flex-wrap gap-2">
            <button type="button" class="min-h-10 rounded-lg border px-3 disabled:opacity-40"
                    onclick={startUpload} disabled={uploading || $busy || !selectedUpload || selectedUpload === completedUpload || !isValidUploadFile(selectedUpload, uploadConfig)}>{tr("web_upload_start")}</button>
            <button type="button" class="min-h-10 rounded-lg border px-3 disabled:opacity-40"
                    onclick={stopUpload} disabled={!uploading}>{tr("web_upload_cancel")}</button>
          </div>
          {#if uploadProgress && uploading}
            <div role="status" aria-live="polite">
              <p>{tr("web_upload_progress", {sent:uploadProgress.sent, total:uploadProgress.total})}</p>
              <progress class="w-full" value={uploadProgress.sent} max={Math.max(uploadProgress.total, 1)} aria-label={tr("web_upload_progress", {sent:uploadProgress.sent, total:uploadProgress.total})}></progress>
              {#if uploadProgress.phase === "finalizing"}<p>{tr("web_upload_finalizing")}</p>{/if}
            </div>
          {/if}
          {#if uploadFeedback === "invalid"}<p role="alert">{tr("web_upload_invalid_file")}</p>{/if}
          {#if uploadFeedback === "unconfirmed"}<p role="alert">{tr("web_upload_unconfirmed")}</p>{/if}
          {#if uploadFeedback === "completed"}<p role="status">{tr("web_upload_completed")}</p>{/if}
        {/if}
      </div>
    </Card>
  {/if}

  <Card title={tr("cv_format")}>
    <div class="grid grid-cols-2 gap-3">
      <label>
        <span class={labelCls}>{tr("cv_to")}</span>
        <select class={inputCls} bind:value={dstFmt} onchange={invalidatePreview}>
          {#each allFormats as f}<option>{f}</option>{/each}
        </select>
      </label>
      <label>
        <span class={labelCls}>{tr("video_encoder_label")}</span>
        <select class={inputCls} bind:value={videoEncoder} onchange={invalidatePreview}
                aria-invalid={!encoderFormatSupported}
                aria-describedby={`video-encoder-hint${encoderFormatSupported ? "" : " video-encoder-error"}`}>
          {#each formats?.video_encoders ?? ["software"] as encoder}
            <option value={encoder} disabled={encoder !== "software" && !(formats?.hardware_video_formats ?? []).includes(dstFmt.toLowerCase())}>{tr(`video_encoder_${encoder}`)}</option>
          {/each}
        </select>
        <span id="video-encoder-hint" class="mt-1 block text-xs text-zinc-500 dark:text-zinc-400">{tr("video_encoder_hint")}</span>
        {#if !encoderFormatSupported}
          <span id="video-encoder-error" role="alert" class="mt-1 block text-xs text-red-600 dark:text-red-400">{tr("video_encoder_unsupported_format")}</span>
        {/if}
      </label>
      <label>
        <span class={labelCls}>{tr("conflict_label")}</span>
        <select class={inputCls} bind:value={conflictPolicy} onchange={invalidatePreview}>
          <option value="rename">{tr("conflict_rename")}</option>
          <option value="skip">{tr("conflict_skip")}</option>
          <option value="overwrite">{tr("conflict_overwrite")}</option>
        </select>
      </label>
      <label>
        <span class={labelCls}>{tr("cv_output")}</span>
        <input class={inputCls} bind:value={savePath} oninput={invalidatePreview} placeholder={tr(IS_WEB ? "web_output_placeholder" : "local_output_placeholder")} aria-describedby="convert-save-hint" />
        <span id="convert-save-hint" class="mt-1 block text-xs text-zinc-500">{tr(IS_WEB ? "web_output_hint" : "local_output_hint")}</span>
      </label>
    </div>

    <!-- Advanced ffmpeg params — UI shell; engine wiring TODO (documented) -->
    <details class="mt-3">
      <summary class="cursor-pointer text-xs text-zinc-500 select-none dark:text-zinc-400">
        {tr("adv_options")}
      </summary>
      <p class="mt-2 text-[11px] text-zinc-400 dark:text-zinc-500">{tr("cv_ffmpeg_notice")}</p>
    </details>
  </Card>

  <div class="flex gap-2.5">
    <button
      class="flex min-h-11 items-center justify-center rounded-xl border border-zinc-300 px-4 text-sm
             text-zinc-600 hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
      onclick={previewConversion}
      disabled={uploading || previewing || $busy || !formats || !validSavePath || entries.length === 0}
    >{tr("preview_button")}</button>
    <button
      class="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-indigo-500
             text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-600
             active:scale-[0.99] disabled:opacity-50 sm:flex-none sm:px-6"
      onclick={start}
      disabled={uploading || $busy || !$eventReady || !formats || !validSavePath || entries.length === 0 || !encoderFormatSupported}
    >
      <Play class="size-4" aria-hidden="true" />{tr("btn_start_convert")}
    </button>
    <button
      class="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-zinc-300
             px-4 text-sm text-zinc-600 hover:bg-zinc-100 disabled:opacity-40
             dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
      onclick={stop}
      disabled={$activeOperation !== "convert" || stopping}
    >
      <Square class="size-3.5" aria-hidden="true" />{tr("btn_stop")}
    </button>
  </div>

  {#if preview}
    <Card title={tr("preview_title")}>
      <p class="mb-3 text-xs text-zinc-600 dark:text-zinc-400">{tr("preview_snapshot_hint")}</p>
      <ul class="space-y-2">
        {#each preview.jobs as job}
          <li class="rounded-lg bg-zinc-50 p-3 text-xs dark:bg-zinc-950">
            <p class="break-all">{job.src} → {job.dst}</p>
            <p>{tr("preview_existing")}: {tr(`preview_${job.existing}`)}</p>
            <p>{tr("preview_source_matches")}: {tr(`preview_${job.source_matches}`)}</p>
            {#if job.batch_duplicate}<p class="font-medium text-amber-700 dark:text-amber-400">{tr("preview_batch_duplicate")}</p>{/if}
          </li>
        {/each}
      </ul>
    </Card>
  {/if}

  {#if conversionResultUnreliable}
    <!-- OpenAI-Codex_app_ui: retain a safe diagnostic until the next operation. -->
    <div role="alert" class="rounded-lg bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100">
      <p>{tr("conversion_result_unreliable")}</p>
      {#if conversionError}<p class="mt-1 break-all">{conversionError}</p>{/if}
    </div>
  {/if}

  {#if jobs.length}
    <Card title={tr("conversion_results")}>
      <ul class="space-y-2">
        {#each jobs as job}
          <li class="rounded-lg bg-zinc-50 p-3 text-xs dark:bg-zinc-950">
            <p class="break-all">{job.src} → {job.dst}</p>
            <p>{tr(`task_status_${job.status}`)}</p>
            {#if job.error}<p class="break-all text-red-600 dark:text-red-400">{safeAiErrorText(() => redactLog(job.error))}</p>{/if}
            {#if (job.status === "error" || job.status === "no_ffmpeg") && !job.error.trim()}<p class="break-all text-red-600 dark:text-red-400">{tr("conversion_error_no_details")}</p>{/if}
            {#if downloadLink(job.download_url)}<a class="underline" href={downloadLink(job.download_url) ?? undefined}>{tr("download_output")}</a>{/if}
          </li>
        {/each}
      </ul>
    </Card>
  {/if}
</div>
