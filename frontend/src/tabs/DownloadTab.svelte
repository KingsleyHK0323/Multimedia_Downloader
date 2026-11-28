<script lang="ts">
  import { Square, Link2, Clock, Loader2, CheckCircle2, XCircle } from "lucide-svelte";
  import Card from "../components/Card.svelte";
  import ProgressBar from "../components/ProgressBar.svelte";
  import { api, IS_TAURI, IS_WEB, IS_MOCK, type Formats, type PlaylistPreview } from "../api";
  import { t, progress, busy, activeOperation, eventReady, downloadItems, downloadMode } from "../store";
  import { toast } from "../lib/toast";
  import { operationOutcome, redactLog, isAbsoluteNativePath } from "../lib/operation";
  import { safeAiErrorText } from "../lib/operation"; // OpenAI-Codex_app_ui
  import { isValidDownloadResult } from "../lib/downloadResult";
  import { beginDownloadBatch, activateDownloadBatch, setDownloadBatchPhase, isCurrentDownloadBatch,
    isIdleDownloadBatch, canDisplayDownloadBatch, downloadBatchUnknown, downloadBatchToken, downloadTerminalSummary } from "../store";

  let { mode, formats }: { mode: "video" | "audio"; formats: Formats | null } = $props();

  const tr = $derived($t);
  // OpenAI-Codex: render the batch result even after returning to this tab.
  const terminalSummary = $derived(downloadTerminalSummary($downloadItems, mode));

  let urls = $state("");
  let videoFmt = $state("mp4");
  let audioFmt = $state("mp3");
  let quality = $state("best");
  // OpenAI-Codex_app_ui: pass the chosen bitrate and report terminal results.
  let bitrate = $state("192");
  let savePath = $state("");
  let browser = $state("none");
  let cookieFile = $state("");
  let stopping = $state(false);
  // OpenAI-Codex_app_ui: hide unconfirmed per-item statuses after a missing or inconsistent result.
  let downloadResultUnreliable = $state(false);
  // OpenAI-Codex_Fork_Source_Code: keep metadata preview separate from downloads.
  let playlistPreview = $state<PlaylistPreview | null>(null);
  let playlistPreviewLoading = $state(false);
  // OpenAI-Codex_Fork_Source_Code: prevent stale previews from stacking requests.
  let playlistPreviewInFlight = $state(false);
  let playlistPreviewError = $state("");
  let playlistSelectedEntryIds = $state<string[]>([]);
  let loadedPlaylistPreviewKey = $state("");
  let activePlaylistPreviewKey = $state("");
  let playlistPreviewRequestId = 0;
  let observedPlaylistPreviewInputKey = "";
  let observedDownloadBatch: object | null = null;
  $effect(() => {
    const token = downloadBatchToken($downloadItems, mode);
    if (token && token !== observedDownloadBatch) {
      observedDownloadBatch = token;
      downloadResultUnreliable = false;
    }
  });

  const urlList = $derived(urls.split("\n").map((u) => u.trim()).filter(Boolean));
  const playlistPreviewInputKey = $derived(JSON.stringify({
    url: urlList.length === 1 ? urlList[0] : "",
    mode, videoFmt, audioFmt, quality, bitrate, browser, cookieFile,
  }));
  const activePlaylistPreview = $derived(
    playlistPreview && loadedPlaylistPreviewKey === playlistPreviewInputKey ? playlistPreview : null,
  );
  const selectedPlaylistEntries = $derived(activePlaylistPreview
    ? activePlaylistPreview.entries.filter((entry) => playlistSelectedEntryIds.includes(entry.entry_id))
    : []);
  const urlsToDownload = $derived(activePlaylistPreview
    ? selectedPlaylistEntries.map((entry) => entry.url)
    : urlList);
  const validSavePath = $derived(!IS_TAURI || isAbsoluteNativePath(savePath.trim()));
  const validCookieFile = $derived(!IS_TAURI || cookieFile === "" || isAbsoluteNativePath(cookieFile));

  $effect(() => {
    const key = playlistPreviewInputKey;
    if (observedPlaylistPreviewInputKey && observedPlaylistPreviewInputKey !== key) {
      playlistPreviewRequestId++;
      activePlaylistPreviewKey = "";
      playlistPreviewLoading = false;
      loadedPlaylistPreviewKey = "";
      playlistPreview = null;
      playlistSelectedEntryIds = [];
      playlistPreviewError = "";
    }
    observedPlaylistPreviewInputKey = key;
  });

  async function previewPlaylist() {
    if (IS_MOCK || urlList.length !== 1 || playlistPreviewLoading || playlistPreviewInFlight || $busy || !$eventReady || !validCookieFile) return;
    const requestId = ++playlistPreviewRequestId;
    const key = playlistPreviewInputKey;
    activePlaylistPreviewKey = key;
    playlistPreview = null;
    loadedPlaylistPreviewKey = "";
    playlistSelectedEntryIds = [];
    playlistPreviewLoading = true;
    playlistPreviewInFlight = true;
    playlistPreviewError = "";
    try {
      const result = await api.previewPlaylist({
        url: urlList[0], mode,
        video_fmt: videoFmt, audio_fmt: audioFmt, quality,
        browser, cookie_file: cookieFile, bitrate,
      });
      if (requestId !== playlistPreviewRequestId || key !== playlistPreviewInputKey) return;
      playlistPreview = result;
      loadedPlaylistPreviewKey = key;
      playlistSelectedEntryIds = result.entries.map((entry) => entry.entry_id);
    } catch (e) {
      if (requestId !== playlistPreviewRequestId || key !== playlistPreviewInputKey) return;
      playlistPreview = null;
      loadedPlaylistPreviewKey = "";
      playlistSelectedEntryIds = [];
      playlistPreviewError = safeAiErrorText(() => redactLog(String(e instanceof Error ? e.message : e)));
    } finally {
      playlistPreviewInFlight = false;
      if (requestId === playlistPreviewRequestId) {
        activePlaylistPreviewKey = "";
        playlistPreviewLoading = false;
      }
    }
  }

  function formatPlaylistDuration(seconds: number | null): string {
    if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return tr("playlist_entry_duration_unknown");
    const total = Math.floor(seconds);
    const sec = String(total % 60).padStart(2, "0");
    const minutes = Math.floor(total / 60);
    if (minutes >= 60) return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${sec}`;
    return `${minutes}:${sec}`;
  }

  function clearPlaylistPreview() {
    playlistPreviewRequestId++;
    activePlaylistPreviewKey = "";
    playlistPreviewLoading = false;
    loadedPlaylistPreviewKey = "";
    playlistPreview = null;
    playlistSelectedEntryIds = [];
    playlistPreviewError = "";
  }

  async function start() {
    const playlistPreviewForRun = typeof activePlaylistPreview === "undefined" ? null : activePlaylistPreview;
    const selectedEntries = playlistPreviewForRun && typeof selectedPlaylistEntries !== "undefined"
      ? [...selectedPlaylistEntries]
      : [];
    const previewIsLoading = typeof playlistPreviewLoading !== "undefined" && playlistPreviewLoading === true;
    if ((playlistPreviewForRun ? selectedEntries.length : urlList.length) === 0 || previewIsLoading || $busy || !$eventReady || !formats || !validSavePath || !validCookieFile) return;
    const batchToken = beginDownloadBatch();
    if (!batchToken || $busy) return;
    busy.set(true);
    activeOperation.set("download");
    downloadResultUnreliable = false;
    const startedUrls = playlistPreviewForRun ? selectedEntries.map((entry) => entry.url) : [...urlList];
    // Lives in the shared store (not local state) so it survives switching
    // away to another tab and back — see store.ts's downloadItems comment.
    downloadItems.set(startedUrls.map((url, index) => ({
      url,
      ...(playlistPreviewForRun ? { label: `${selectedEntries[index].index}. ${selectedEntries[index].title}` } : {}),
      status: "pending" as const,
    })));
    downloadMode.set(mode);
    activateDownloadBatch(batchToken, mode);
    busy.set(true);
    activeOperation.set("download");
    stopping = false;
    progress.set(null);
    try {
      const result = await api.startDownload({
        urls: startedUrls, mode, ...(playlistPreviewForRun ? { noplaylist: true } : {}),
        video_fmt: videoFmt, audio_fmt: audioFmt,
        quality, save_path: savePath.trim(), browser, cookie_file: cookieFile, bitrate,
      });
      if (!isCurrentDownloadBatch(batchToken)) return;
      if (!isValidDownloadResult(startedUrls, result)) {
        setDownloadBatchPhase(batchToken, "unknown");
        if (!isCurrentDownloadBatch(batchToken)) return;
        downloadResultUnreliable = true;
        toast(tr("operation_unknown"), "err");
        return;
      }
      setDownloadBatchPhase(batchToken, "finalizing");
      if (!isCurrentDownloadBatch(batchToken)) return;
      const consistent = Array.isArray(result?.results) && result?.summary?.total === startedUrls.length &&
        result.results.length === result.summary.succeeded + result.summary.failed &&
        result.results.every((item, i) => Array.isArray(item) && item[0] === startedUrls[i] && typeof item[1] === "boolean");
      if (!consistent) {
        setDownloadBatchPhase(batchToken, "unknown");
        if (!isCurrentDownloadBatch(batchToken)) return;
        downloadResultUnreliable = true;
      }
      if (consistent) {
        if (!isCurrentDownloadBatch(batchToken)) return;
        downloadItems.update((items) => items.map((item, i) => ({
          ...item,
          status: result.results[i] ? (result.results[i][1] ? "done" : "error") : "skipped",
          // OpenAI-Codex_web_ai: preserve validated per-item terminal errors.
          error: result.results[i]?.[2] ?? "",
        })));
      }
      if (!isCurrentDownloadBatch(batchToken)) return;
      if (consistent) setDownloadBatchPhase(batchToken, "terminal", result.summary);
      if (!isCurrentDownloadBatch(batchToken)) return;
      const outcome = consistent ? operationOutcome(result?.summary) : "unknown";
      toast(tr(`operation_${outcome}`, result?.summary), outcome === "succeeded" ? "ok" : outcome === "cancelled" ? "info" : "err");
    } catch (e) {
      if (!isCurrentDownloadBatch(batchToken)) return;
      setDownloadBatchPhase(batchToken, "unknown");
      if (!isCurrentDownloadBatch(batchToken)) return;
      downloadResultUnreliable = true;
      toast(safeAiErrorText(() => redactLog(String(e instanceof Error ? e.message : e))), "err");
    } finally {
      if (isCurrentDownloadBatch(batchToken)) {
      busy.set(false);
      if (isCurrentDownloadBatch(batchToken)) {
      activeOperation.set(null);
      if (isIdleDownloadBatch(batchToken)) {
      stopping = false;
      }
      }
      }
    }
  }

  async function stop() {
    if (stopping || $activeOperation !== "download") return;
    const stopBatch = downloadBatchToken($downloadItems);
    if (!stopBatch) return;
    stopping = true;
    try {
      const result = await api.stop();
      if (!isCurrentDownloadBatch(stopBatch)) return;
      if (result?.stopping) toast(tr("stop_requested"), "info");
      else { stopping = false; toast(tr("stop_not_active"), "info"); }
    }
    catch (e) { if (!isCurrentDownloadBatch(stopBatch)) return; stopping = false;
      // OpenAI-Codex_web_ai: retain stop/error context when detail formatting fails.
      let stopErrorLabel = "Stop error";
      try {
        const stopLabel = tr("btn_stop"), errorLabel = tr("web_job_error");
        if (typeof stopLabel === "string" && stopLabel.trim() && typeof errorLabel === "string" && errorLabel.trim()) stopErrorLabel = `${stopLabel} ${errorLabel}`;
      } catch {
        // Retain the fixed fallback if localization fails.
      }
      toast(`${stopErrorLabel}: ` + safeAiErrorText(() => redactLog(String(e instanceof Error ? e.message : e))), "err"); }
  }

  // OpenAI-Codex_web_ai: fail closed when formatting an item error.
  function downloadItemErrorText(error: string): string {
    return safeAiErrorText(() => redactLog(error));
  }

  const inputCls =
    "w-full rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-2.5 text-sm " +
    "placeholder:text-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:placeholder:text-zinc-600";
  const labelCls = "mb-1.5 block text-xs font-medium text-zinc-600 dark:text-zinc-400";
</script>

<div class="flex flex-col gap-4">
  <Card title={tr("sec_urls")}>
    <label class={labelCls} for={`download-urls-${mode}`}>{tr("sec_urls")}</label>
    <textarea
      id={`download-urls-${mode}`}
      rows="4"
      class={inputCls + " resize-y font-mono text-[13px]"}
      bind:value={urls}
      placeholder={tr("web_url_placeholder")}
    ></textarea>
    <p class="mt-2 flex items-center gap-1.5 text-[11px] text-zinc-400 dark:text-zinc-500">
      <Link2 class="size-3 shrink-0" aria-hidden="true" />{tr("urls_caption")}
    </p>
    <!-- OpenAI-Codex_Fork_Source_Code: explain playlist preview and input counts. -->
    <p class="mt-1 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{tr("download_playlist_count_note")}</p>
    <div class="mt-3 flex flex-wrap items-center gap-2">
      <button
        type="button"
        class="min-h-10 rounded-lg border border-zinc-300 px-3 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        onclick={previewPlaylist}
        disabled={IS_MOCK || playlistPreviewLoading || playlistPreviewInFlight || $busy || !$eventReady || urlList.length !== 1 || !validCookieFile}
      >
        {#if playlistPreviewLoading || playlistPreviewInFlight}<Loader2 class="mr-1 inline size-3.5 animate-spin" aria-hidden="true" />{/if}
        {tr("playlist_preview_button")}
      </button>
      <span class="text-xs text-zinc-500 dark:text-zinc-400">{tr("playlist_preview_hint")}</span>
    </div>
    {#if IS_MOCK}
      <p class="mt-2 text-xs text-amber-700 dark:text-amber-400">{tr("playlist_preview_mock_unavailable")}</p>
    {:else if urlList.length > 1}
      <p class="mt-2 text-xs text-zinc-500 dark:text-zinc-400">{tr("playlist_preview_one_url")}</p>
    {/if}
    {#if playlistPreviewError}
      <p role="alert" class="mt-2 text-xs text-red-600 dark:text-red-400">{tr("playlist_preview_failed")} {playlistPreviewError}</p>
    {/if}
  </Card>

  {#if activePlaylistPreview}
    <Card title={activePlaylistPreview.title}>
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p aria-live="polite" class="text-xs text-zinc-600 dark:text-zinc-400">
          {tr("playlist_preview_selected_count", {
            selected: selectedPlaylistEntries.length,
            shown: activePlaylistPreview.entries.length,
            total: activePlaylistPreview.total_entries,
          })}
        </p>
        <div class="flex gap-2">
          <button type="button" class="min-h-9 rounded-lg border border-zinc-300 px-2.5 text-xs disabled:opacity-50 dark:border-zinc-700" onclick={() => playlistSelectedEntryIds = activePlaylistPreview?.entries.map((entry) => entry.entry_id) ?? []} disabled={$busy}>{tr("playlist_preview_select_all")}</button>
          <button type="button" class="min-h-9 rounded-lg border border-zinc-300 px-2.5 text-xs disabled:opacity-50 dark:border-zinc-700" onclick={() => playlistSelectedEntryIds = []} disabled={$busy}>{tr("playlist_preview_select_none")}</button>
          <button type="button" class="min-h-9 rounded-lg border border-zinc-300 px-2.5 text-xs disabled:opacity-50 dark:border-zinc-700" onclick={clearPlaylistPreview} disabled={$busy}>{tr("playlist_preview_clear")}</button>
        </div>
      </div>
      {#if activePlaylistPreview.unavailable_entries > 0}
        <p class="mb-2 text-xs text-amber-700 dark:text-amber-400">{tr("playlist_preview_unavailable", { count: activePlaylistPreview.unavailable_entries })}</p>
      {/if}
      {#if activePlaylistPreview.truncated}
        <p class="mb-2 text-xs text-amber-700 dark:text-amber-400">{tr("playlist_preview_truncated", { limit: activePlaylistPreview.preview_limit })}</p>
      {/if}
      {#if activePlaylistPreview.entries.length === 0}
        <p class="text-sm text-zinc-500 dark:text-zinc-400">{tr("playlist_preview_no_items")}</p>
      {:else}
        <ul class="max-h-96 divide-y divide-zinc-200 overflow-y-auto rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {#each activePlaylistPreview.entries as entry (entry.entry_id)}
            <li class="px-3 py-2.5">
              <label class="flex cursor-pointer items-start gap-3">
                <input type="checkbox" class="mt-0.5 size-4 shrink-0 accent-indigo-500 disabled:opacity-50" value={entry.entry_id} bind:group={playlistSelectedEntryIds} aria-label={`${entry.index}. ${entry.title}`} disabled={$busy} />
                <span class="min-w-0 flex-1">
                  <span class="block break-words text-sm text-zinc-800 dark:text-zinc-200">{entry.index}. {entry.title}</span>
                  <span class="mt-0.5 block text-xs text-zinc-500 dark:text-zinc-400">{formatPlaylistDuration(entry.duration_seconds)}</span>
                </span>
              </label>
            </li>
          {/each}
        </ul>
      {/if}
    </Card>
  {/if}

  <Card title={tr("sec_format")}>
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {#if mode === "video"}
        <label>
          <span class={labelCls}>{tr("lbl_video_fmt")}</span>
          <select class={inputCls} bind:value={videoFmt}>
            {#each formats?.video ?? [] as f}<option>{f}</option>{/each}
          </select>
        </label>
        <label>
          <span class={labelCls}>{tr("lbl_quality")}</span>
          <select class={inputCls} bind:value={quality}>
            {#each formats?.quality ?? [] as q}<option>{q}</option>{/each}
          </select>
        </label>
      {:else}
        <label>
          <span class={labelCls}>{tr("lbl_audio_fmt")}</span>
          <select class={inputCls} bind:value={audioFmt}>
            {#each formats?.audio ?? [] as f}<option>{f}</option>{/each}
          </select>
        </label>
        <label>
          <span class={labelCls}>{tr("lbl_bitrate")}</span>
          <select class={inputCls} bind:value={bitrate}>
            <option value="192">192 kbps</option>
            <option value="320">320 kbps</option>
            <option value="128">128 kbps</option>
          </select>
        </label>
      {/if}
      <label>
        <span class={labelCls}>{tr("sec_save")}</span>
        <input class={inputCls} bind:value={savePath} placeholder={tr(IS_WEB ? "web_output_placeholder" : "local_output_placeholder")} aria-describedby={`download-save-hint-${mode}`} />
        <span id={`download-save-hint-${mode}`} class="mt-1 block text-xs text-zinc-500">{tr(IS_WEB ? "web_output_hint" : "local_output_hint")}</span>
      </label>
    </div>
  </Card>

  <Card title={tr("sec_cookie")}>
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <label>
        <span class={labelCls}>{tr("cookie_m1")}</span>
        <select class={inputCls} bind:value={browser}>
          {#each formats?.browsers ?? [] as b}<option>{b}</option>{/each}
        </select>
      </label>
      <label>
        <span class={labelCls}>{tr("cookie_m2")}</span>
        <input class={inputCls} bind:value={cookieFile} autocomplete="off"
               aria-invalid={!validCookieFile}
               aria-describedby={`download-cookie-hint-${mode}${validCookieFile ? "" : ` download-cookie-error-${mode}`}`} />
        {#if !validCookieFile}
          <span id={`download-cookie-error-${mode}`} role="alert" class="mt-1 block text-xs text-red-600 dark:text-red-400">{tr("cookie_local_path_invalid")}</span>
        {/if}
      </label>
      <p id={`download-cookie-hint-${mode}`} class="text-xs text-zinc-500 dark:text-zinc-400">{tr(IS_WEB ? "cookie_server_hint" : "cookie_local_hint")}</p>
      <p class="self-end pb-1 text-[11px] leading-snug text-zinc-400 dark:text-zinc-500">
        {tr("cookie_warning")}
      </p>
    </div>
  </Card>

  {#if terminalSummary}
    <Card><p role="status">{tr(`operation_${operationOutcome(terminalSummary)}`, terminalSummary)}</p></Card>
  {:else if $progress && $activeOperation === "download" && $downloadMode === mode && canDisplayDownloadBatch($downloadItems, mode)}
    <Card>
      <ProgressBar
        pct={$progress.pct}
        label={tr("status_progress", { pct: Math.round($progress.pct * 10) / 10, speed: $progress.speed, eta: $progress.eta })}
      />
    </Card>
  {/if}

  <!-- Actions -->
  <div class="flex gap-2.5">
    <button
      class="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-indigo-500
             text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-600
             active:scale-[0.99] disabled:opacity-50 sm:flex-none sm:px-6"
      onclick={start}
      disabled={$busy || !$eventReady || !formats || !validSavePath || !validCookieFile || urlsToDownload.length === 0 || playlistPreviewLoading}
    >
      <!-- OpenAI-Codex: use the dedicated download-action artwork. -->
      <img src="/icons/download-action.png" class="size-5" alt="" aria-hidden="true" />{tr("btn_start_download")}
    </button>
    <button
      class="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-zinc-300
             px-4 text-sm text-zinc-600 hover:bg-zinc-100 disabled:opacity-40
             dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
      onclick={stop}
      disabled={$activeOperation !== "download" || stopping}
    >
      <Square class="size-3.5" aria-hidden="true" />{stopping ? tr("stop_requested") : tr("btn_stop")}
    </button>
  </div>

  {#if canDisplayDownloadBatch($downloadItems, mode)}
  {#if !downloadResultUnreliable}
  <!-- Per-item batch status -->
  {#if $downloadItems.length > 0 && $downloadMode === mode}
    <Card title={tr("ai_tasks_title")}>
      <ul class="flex flex-col gap-1.5">
        {#each $downloadItems as item}
          <li class="flex flex-wrap items-center gap-2.5 rounded-lg bg-zinc-50 px-3 py-2 text-xs dark:bg-zinc-950">
            {#if item.status === "pending"}<Clock class="size-3.5 shrink-0 text-zinc-400" aria-hidden="true" />
            {:else if item.status === "running"}<Loader2 class="size-3.5 shrink-0 animate-spin text-indigo-500" aria-hidden="true" />
            {:else if item.status === "done"}<CheckCircle2 class="size-3.5 shrink-0 text-emerald-500" aria-hidden="true" />
            {:else if item.status === "error"}<XCircle class="size-3.5 shrink-0 text-red-500" aria-hidden="true" />
            {:else}<Clock class="size-3.5 shrink-0 text-amber-500" aria-hidden="true" />{/if}
            <span class="sr-only">{tr(`task_status_${item.status}`)}</span>
            <span class="truncate min-w-0 flex-1 text-zinc-700 dark:text-zinc-300" title={item.url}>{item.label ?? item.url}</span>
            <!-- OpenAI-Codex_web_ai: display redacted terminal details. -->
            {#if item.status === "error" && item.error?.trim()}
            {#if item.error}
              <span class="basis-full pl-6 whitespace-pre-wrap break-words text-red-600 dark:text-red-400">{downloadItemErrorText(item.error)}</span>
            {/if}
            {/if}
            <!-- OpenAI-Codex_web_ai: show the localized fallback when details are missing. -->
            {#if item.status === "error" && !item.error?.trim()}
              <span class="basis-full pl-6 whitespace-pre-wrap break-words text-red-600 dark:text-red-400">{tr("conversion_error_no_details")}</span>
            {/if}
          </li>
        {/each}
      </ul>
    </Card>
  {/if}
  {/if}
  {/if}
  {#if downloadBatchUnknown($downloadItems, mode)}
  {#if downloadResultUnreliable && $downloadMode === mode}
    <p role="alert" class="text-sm text-amber-700 dark:text-amber-400">{tr("operation_state_unknown")}</p>
  {/if}
  {#if !downloadResultUnreliable && $downloadMode === mode}
    <p role="alert" class="text-sm text-amber-700 dark:text-amber-400">{tr("operation_state_unknown")}</p>
  {/if}
  {/if}
</div>
