<script lang="ts">
  import { onMount } from "svelte";
  import { Sparkles } from "lucide-svelte";
  import { api, IS_MOCK, IS_TAURI, type Formats, type EngineEvent } from "./api";
  import { lang, t, pushLog, progress, busy, activeOperation, eventReady, markDownloadItem } from "./store";
  import type { ConnectionState } from "./lib/eventStream";
  import { Translator } from "./i18n";
  import Header from "./components/Header.svelte";
  import TabBar from "./components/TabBar.svelte";
  import type { TabId } from "./lib/tabs";
  import Toasts from "./components/Toasts.svelte";
  import UpdateBanner from "./components/UpdateBanner.svelte";
  import DownloadTab from "./tabs/DownloadTab.svelte";
  import ConvertTab from "./tabs/ConvertTab.svelte";
  import LogTab from "./tabs/LogTab.svelte";
  import AiPanel from "./ai/AiPanel.svelte";
  import ManualPanel from "./components/ManualPanel.svelte";

  let active = $state<TabId>("video");
  let showAi = $state(false);
  let showManual = $state(false);

  function toggleAi() {
    showAi = !showAi;
    if (showAi) showManual = false;
  }
  function toggleManual() {
    showManual = !showManual;
    if (showManual) showAi = false;
  }
  let formats = $state<Formats | null>(null);
  let formatError = $state(false);
  let eventState = $state<ConnectionState>("connecting");
  let eventGap = $state(false);
  let operationUncertain = $state(false);
  let operationOutcome = $state<"result_lost" | "not_started" | "result_unknown" | "response_error" | null>(null);
  // Display names (English / 繁體中文 / 简体中文) are static, bundled at build
  // time from the locale JSON's `_meta.name` — no need to round-trip through
  // the engine sidecar just to fetch 3 strings that never change. (Previously
  // fetched via `api.getLocales()`; an IPC/sidecar hiccup left this stuck as
  // `{}` forever with no error surfaced, so the dropdown silently fell back
  // to showing raw codes "en"/"zh_tw"/"zh_cn" — see GitHub issue #4.)
  let langNames = $state<Record<string, string>>(Translator.available());

  const tr = $derived($t);

  function loadFormats() {
    formatError = false;
    api.getFormats().then((f) => (formats = f)).catch(() => { formatError = true; });
  }

  // OpenAI-Codex_app_ui: subscribe before enabling operation controls.
  onMount(() => {
    loadFormats();
    let disposed = false;
    let offEvents: (() => void) | undefined;
    const offConnection = api.onConnectionState((state) => {
      if (disposed) return;
      if (eventState === "open" && state !== "open" && $busy) eventGap = true;
      eventState = state;
      eventReady.set(state === "open");
    });
    const offUncertain = api.onOperationUncertain((notice) => {
      if (disposed) return;
      if (notice === "uncertain") operationUncertain = true;
      else { operationUncertain = false; operationOutcome = notice; }
    });

    // Single global subscription: engine emits i18n KEYS; we translate here
    // with the language active at the moment the line arrives.
    void api.onEvent((e: EngineEvent) => {
      if (e.type === "log") {
        const translate = new Translator($lang);
        pushLog(e.level, translate.t(e.key, e.fmt));
        if ($activeOperation === "download" && (e.key === "log_item_done" || e.key === "log_item_error") &&
            (typeof e.operation_id !== "string" || !e.operation_id.trim())) return;
        if ($activeOperation === "download" && e.key === "log_item_done") markDownloadItem((e.fmt?.i as number) - 1, "done");
        else if ($activeOperation === "download" && e.key === "log_item_error") markDownloadItem((e.fmt?.i as number) - 1, "error");
      } else if (e.type === "progress" && $activeOperation === "download") {
        if (typeof e.operation_id !== "string" || !e.operation_id.trim()) return;
        progress.set({ pct: e.pct, speed: e.speed, eta: e.eta });
      } else if (e.type === "item_start" && $activeOperation === "download") {
        if (typeof e.operation_id !== "string" || !e.operation_id.trim()) return;
        progress.set({ pct: 0, speed: "--", eta: "--" });
        markDownloadItem(e.index - 1, "running");
      }
    }).then((off) => {
      if (disposed) off();
      else offEvents = off;
    }).catch((error: unknown) => {
      if (disposed) return;
      eventState = "disconnected";
      eventReady.set(false);
      pushLog("err", String(error instanceof Error ? error.message : error));
    });

    // Ctrl/Cmd+K toggles the AI assistant (desktop power-user shortcut).
    const onKey = (ev: KeyboardEvent) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "k") {
        ev.preventDefault();
        toggleAi();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      disposed = true;
      eventReady.set(false);
      offConnection();
      offUncertain();
      offEvents?.();
      window.removeEventListener("keydown", onKey);
    };
  });
</script>

<div class="flex min-h-dvh flex-col">
  <Header {langNames} onToggleAi={toggleAi} onToggleManual={toggleManual} />

  {#if IS_TAURI}
    <UpdateBanner />
  {/if}

  {#if IS_MOCK}
    <div class="bg-amber-100 py-1 text-center text-[11px] text-amber-800 dark:bg-amber-950/60 dark:text-amber-400">
      {tr("mock_banner")}
    </div>
  {/if}

  <TabBar {active} onselect={(id) => (active = id)} />

  {#if formatError}
    <div role="alert" class="mx-auto mt-3 flex w-full max-w-3xl items-center justify-between gap-3 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
      <span>{tr("formats_load_failed")}</span><button type="button" class="underline" onclick={loadFormats}>{tr("retry")}</button>
    </div>
  {/if}
  {#if eventState !== "open"}
    <div role="alert" class="mx-auto mt-3 flex w-full max-w-3xl items-center justify-between gap-3 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
      <span>{tr(eventState === "connecting" ? "event_connecting" : "event_disconnected")}</span>
      <button type="button" class="underline" onclick={() => api.retryEvents()}>{tr("retry")}</button>
    </div>
  {/if}
  {#if eventGap}
    <div role="status" class="mx-auto mt-3 flex w-full max-w-3xl items-center justify-between gap-3 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
      <span>{tr("event_gap_warning")}</span>
      <button type="button" class="underline" onclick={() => (eventGap = false)}>{tr("dismiss")}</button>
    </div>
  {/if}
  {#if operationUncertain}
    <div role="alert" class="mx-auto mt-3 flex w-full max-w-3xl items-center justify-between gap-3 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
      <span>{tr("operation_state_unknown")}</span>
      <button type="button" class="underline" onclick={() => (operationUncertain = false)}>{tr("dismiss")}</button>
    </div>
  {/if}
  {#if operationOutcome}
    <div role="alert" class="mx-auto mt-3 flex w-full max-w-3xl items-center justify-between gap-3 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
      <span>{tr(operationOutcome === "result_lost" ? "operation_result_lost" : operationOutcome === "result_unknown" ? "operation_result_unknown" : operationOutcome === "response_error" ? "operation_response_error" : "operation_not_started")}</span>
      <button type="button" class="underline" onclick={() => (operationOutcome = null)}>{tr("dismiss")}</button>
    </div>
  {/if}

  <!-- pb-24 on mobile clears the fixed bottom nav + FAB (web build only —
       the desktop app never shows either, see TabBar.svelte). issue #8's
       other half: a maximized/wide window left large empty margins around
       a hard-capped 1024px column. A first attempt widened this via 2
       fixed breakpoint tiers, but that cap stopped growing past the 2xl
       (1536px) breakpoint -- so on any monitor wider than that, the margin
       grew back LARGER than before the "fix". Using clamp() instead gives
       genuinely continuous scaling with no such regression: floors at the
       original 64rem (1024px) for normal window sizes, grows fluidly as
       90% of viewport width, caps at 100rem (1600px) so very long lines
       don't form on ultrawide displays. -->
  <main class="mx-auto w-full max-w-[clamp(64rem,90vw,100rem)] flex-1 px-4 pt-4 {IS_TAURI ? 'pb-8' : 'pb-24 lg:pb-8'}">
    <div id="panel-video" role="tabpanel" aria-label={tr("tab_video")} hidden={active !== "video"}><DownloadTab mode="video" {formats} /></div>
    <div id="panel-music" role="tabpanel" aria-label={tr("tab_music")} hidden={active !== "music"}><DownloadTab mode="audio" {formats} /></div>
    <div id="panel-convert" role="tabpanel" aria-label={tr("tab_convert")} hidden={active !== "convert"}><ConvertTab {formats} active={active === "convert"} /></div>
    <div id="panel-log" role="tabpanel" aria-label={tr("tab_log")} hidden={active !== "log"}><LogTab /></div>
  </main>

  <!-- Mobile FAB for the AI assistant (web build only, header button is
       lg+ only there; the desktop app always shows the header button
       instead, see Header.svelte) -->
  {#if !showAi && !showManual && !IS_TAURI}
    <button
      class="fixed right-4 bottom-20 z-30 flex size-14 items-center justify-center rounded-full
             bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-lg
             shadow-indigo-500/30 transition-transform active:scale-90 lg:hidden"
      style="margin-bottom: env(safe-area-inset-bottom)"
      onclick={toggleAi}
      aria-label={tr("ai_assistant")}
    >
      <Sparkles class="size-6" aria-hidden="true" />
    </button>
  {/if}

  <div hidden={!showAi}>
    <AiPanel open={showAi} onclose={() => (showAi = false)} />
  </div>

  {#if showManual}
    <ManualPanel onclose={() => (showManual = false)} />
  {/if}

  <Toasts />
</div>
