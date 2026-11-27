<script lang="ts">
  import { onMount } from "svelte";
  import { Upload, Play, Square, X, FileVideo } from "lucide-svelte";
  import Card from "../components/Card.svelte";
  import { api, IS_MOCK, IS_TAURI, type Formats } from "../api";
  import { t, busy } from "../store";
  import { toast } from "../lib/toast";
  import { convertOutcome } from "../lib/convertOutcome";

  let { formats, active }: { formats: Formats | null; active: boolean } = $props();
  const tr = $derived($t);

  // OpenAI-Codex: real conversions require native paths, not browser file names.
  type Entry = { path: string; size?: number };
  let entries = $state<Entry[]>([]);
  let dstFmt = $state("mp4");
  let savePath = $state("");
  let dragOver = $state(false);
  let pathInput = $state("");
  let fileEl = $state<HTMLInputElement | null>(null);
  let stopping = $state(false);

  const allFormats = $derived([...(formats?.video ?? []), ...(formats?.audio ?? [])]);

  onMount(() => {
    if (!IS_TAURI) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) => getCurrentWebview().onDragDropEvent((event) => {
        if (disposed || !active) return;
        if (event.payload.type === "enter" || event.payload.type === "over") dragOver = true;
        else if (event.payload.type === "leave") dragOver = false;
        else if (event.payload.type === "drop") {
          dragOver = false;
          for (const path of event.payload.paths) entries.push({ path });
        }
      }))
      .then((off) => { if (disposed) off(); else unlisten = off; })
      .catch((e: unknown) => { if (!disposed) toast(String(e instanceof Error ? e.message : e), "err"); });
    return () => { disposed = true; unlisten?.(); };
  });

  async function selectFiles() {
    if (IS_TAURI) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const paths = await invoke<string[]>("select_convert_files");
        for (const path of paths) entries.push({ path });
      } catch (e) { toast(String(e instanceof Error ? e.message : e), "err"); }
    } else if (IS_MOCK) fileEl?.click();
    else toast(tr("convert_browser_path_required"), "err");
  }

  function addFiles(files: FileList | null) {
    if (!files) return;
    if (IS_TAURI) return; // Native drop events supply the actual paths.
    if (!IS_MOCK) { toast(tr("convert_browser_path_required"), "err"); return; }
    for (const f of files) entries.push({ path: f.name, size: f.size });
  }
  function addTyped() {
    const paths = pathInput.split("\n").map((p) => p.trim()).filter(Boolean);
    for (const p of paths) entries.push({ path: p });
    pathInput = "";
  }
  function fmtSize(n?: number): string {
    if (n == null) return "";
    return n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`;
  }

  async function start() {
    if (entries.length === 0) return;
    const requested = entries.map((e) => e.path);
    busy.set(true);
    stopping = false;
    try {
      const response = await api.startConvert({
        files: requested,
        dst_fmt: dstFmt,
        save_path: savePath,
      });
      // OpenAI-Codex: an accepted request is not proof that files converted.
      const outcome = convertOutcome(response, requested.length);
      if (outcome.kind === "unknown") toast(tr("convert_result_unknown"), "err");
      else if (outcome.kind === "complete") toast(tr("status_all_done_cv", { t: outcome.total }), "ok");
      else if (outcome.failed === outcome.total) toast(tr("log_all_convert_failed", { t: outcome.failed }), "err");
      else toast(tr("log_all_converted_partial", { ok: outcome.total - outcome.failed,
        fail: outcome.failed, t: outcome.total }), "err");
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e), "err");
    } finally {
      stopping = false;
      busy.set(false);
    }
  }
  async function stop() {
    if (stopping) return;
    stopping = true;
    try { await api.stop(); }
    catch (e) { stopping = false; toast(String(e instanceof Error ? e.message : e), "err"); }
  }

  const inputCls =
    "w-full rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-2.5 text-sm " +
    "placeholder:text-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:placeholder:text-zinc-600";
  const labelCls = "mb-1.5 block text-xs font-medium text-zinc-600 dark:text-zinc-400";
</script>

<div class="flex flex-col gap-4">
  <!-- Drop zone -->
  <button
    type="button"
    class="grid w-full place-items-center gap-2 rounded-xl border-2 border-dashed p-8 text-center
           transition-colors
           {dragOver
             ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-950/30'
             : 'border-zinc-300 bg-white hover:border-indigo-400 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:border-indigo-600'}"
    ondragover={(e) => { e.preventDefault(); dragOver = true; }}
    ondragleave={() => (dragOver = false)}
    ondrop={(e) => { e.preventDefault(); dragOver = false; addFiles(e.dataTransfer?.files ?? null); }}
    onclick={selectFiles}
  >
    <Upload class="size-7 text-zinc-400 dark:text-zinc-500" aria-hidden="true" />
    <span class="text-sm font-medium">{tr("drop_title")}</span>
    <span class="text-xs text-zinc-400 dark:text-zinc-500">{tr("drop_or")} — {tr("btn_add_files")}</span>
    <input
      bind:this={fileEl}
      type="file"
      multiple
      class="hidden"
      onclick={(e) => e.stopPropagation()}
      onchange={(e) => addFiles((e.currentTarget as HTMLInputElement).files)}
    />
  </button>

  <!-- Manual path entry (works in both web and Tauri) -->
  <Card title={tr("cv_file_list")}>
    <div class="flex gap-2">
      <textarea
        rows="2"
        class={inputCls + " resize-y font-mono text-[13px]"}
        bind:value={pathInput}
        placeholder="C:\videos\a.mkv&#10;C:\videos\b.mov"
      ></textarea>
      <button
        class="shrink-0 self-start rounded-lg border border-zinc-300 px-3 py-2 text-xs
               hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
        onclick={addTyped}
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
            {#if entry.size != null}<span class="shrink-0 text-zinc-400">{fmtSize(entry.size)}</span>{/if}
            <button
              class="grid size-6 shrink-0 place-items-center rounded text-zinc-400 hover:bg-zinc-200
                     hover:text-red-500 dark:hover:bg-zinc-800"
              aria-label={tr("btn_remove_selected")}
              onclick={() => entries.splice(i, 1)}
            ><X class="size-3.5" aria-hidden="true" /></button>
          </li>
        {/each}
      </ul>
    {/if}
  </Card>

  <Card title={tr("cv_format")}>
    <div class="grid grid-cols-2 gap-3">
      <label>
        <span class={labelCls}>{tr("cv_to")}</span>
        <select class={inputCls} bind:value={dstFmt}>
          {#each allFormats as f}<option>{f}</option>{/each}
        </select>
      </label>
      <label>
        <span class={labelCls}>{tr("cv_output")}</span>
        <input class={inputCls} bind:value={savePath} placeholder="C:\Converted" />
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
      class="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-indigo-500
             text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-600
             active:scale-[0.99] disabled:opacity-50 sm:flex-none sm:px-6"
      onclick={start}
      disabled={$busy || entries.length === 0}
    >
      <Play class="size-4" aria-hidden="true" />{tr("btn_start_convert")}
    </button>
    <button
      class="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-zinc-300
             px-4 text-sm text-zinc-600 hover:bg-zinc-100 disabled:opacity-40
             dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
      onclick={stop}
      disabled={!$busy || stopping}
    >
      <Square class="size-3.5" aria-hidden="true" />{stopping ? tr("stop_requested") : tr("btn_stop")}
    </button>
  </div>
</div>


