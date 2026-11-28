"""Download tab — video/audio download form, wired to engine.Downloader."""

from __future__ import annotations

import threading

from textual import work
from textual.app import ComposeResult
from textual.containers import Vertical, Horizontal, VerticalScroll
from textual.reactive import reactive
from textual.widgets import (
    Button,
    Input,
    Label,
    ListItem,
    ListView,
    ProgressBar,
    RadioButton,
    RadioSet,
    Select,
    Static,
    TextArea,
)

from engine import (
    AUDIO_FORMATS,
    BROWSERS,
    QUALITY_PRESETS,
    VIDEO_FORMATS,
    DownloadOptions,
    Downloader,
)


class DownloadTab(VerticalScroll):
    """Composes the download form; owns a single in-flight ``Downloader``."""

    mode: reactive[str] = reactive("video")

    def __init__(self, tr) -> None:
        super().__init__()
        self.tr = tr
        self._downloader: Downloader | None = None
        self._cancel_requested = threading.Event()
        # OpenAI-Codex_web_check: keep download state separate from the Textual message pump.
        self._download_running = False

    def compose(self) -> ComposeResult:
        tr = self.tr
        yield Label(tr.t("sec_urls"), classes="section-title")
        yield TextArea(id="urls", soft_wrap=True)

        yield Label(tr.t("sec_mode"), classes="section-title")
        with RadioSet(id="mode"):
            yield RadioButton(tr.t("mode_video"), value=True, id="mode-video")
            yield RadioButton(tr.t("mode_audio"), id="mode-audio")

        yield Label(tr.t("sec_format"), classes="section-title")
        with Horizontal(id="video-fields", classes="field-row"):
            with Vertical():
                yield Label(tr.t("lbl_video_fmt"))
                yield Select(
                    ((f, f) for f in VIDEO_FORMATS),
                    value=VIDEO_FORMATS[0],
                    id="video-fmt",
                    allow_blank=False,
                )
            with Vertical():
                yield Label(tr.t("lbl_quality"))
                yield Select(
                    ((q, q) for q in QUALITY_PRESETS),
                    value=QUALITY_PRESETS[0],
                    id="quality",
                    allow_blank=False,
                )
        with Vertical(id="audio-fields", classes="field-row"):
            yield Label(tr.t("lbl_audio_fmt"))
            yield Select(
                ((f, f) for f in AUDIO_FORMATS),
                value=AUDIO_FORMATS[0],
                id="audio-fmt",
                allow_blank=False,
            )
            yield Label(tr.t("lbl_bitrate"))
            yield Select(
                ((f"{v} kbps", v) for v in ("128", "192", "320")),
                value="192",
                id="bitrate",
                allow_blank=False,
            )

        yield Label(tr.t("sec_cookie"), classes="section-title")
        with Vertical(classes="field-row"):
            yield Label(tr.t("cookie_m1"))
            yield Select(
                ((b, b) for b in BROWSERS),
                value=BROWSERS[0],
                id="browser",
                allow_blank=False,
            )
            yield Label(tr.t("cookie_m2"))
            yield Input(placeholder="cookies.txt", id="cookie-file")

        yield Label(tr.t("sec_save"), classes="section-title")
        yield Input(placeholder=".", id="save-path", classes="field-row")

        with Horizontal(classes="actions-row"):
            yield Button(tr.t("btn_start_download"), id="start", variant="success")
            yield Button(tr.t("btn_stop"), id="stop", variant="error", disabled=True)

        yield ProgressBar(id="progress", show_eta=False)
        yield Static("", id="status", classes="status-line")
        yield ListView(id="items-list")

    def on_mount(self) -> None:
        self.watch_mode(self.mode)

    def watch_mode(self, mode: str) -> None:
        video_fields = self.query_one("#video-fields")
        audio_fields = self.query_one("#audio-fields")
        video_fields.display = mode == "video"
        audio_fields.display = mode == "audio"

    def on_radio_set_changed(self, event: RadioSet.Changed) -> None:
        if event.radio_set.id == "mode":
            self.mode = "video" if event.pressed.id == "mode-video" else "audio"

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "start":
            self._start()
        elif event.button.id == "stop":
            self._stop()

    def _urls(self) -> list[str]:
        text = self.query_one("#urls", TextArea).text
        return [u.strip() for u in text.splitlines() if u.strip()]

    def _start(self) -> None:
        # OpenAI-Codex_app_ui: reserve the form before any callback can reenter.
        if self._download_running:
            return
        # OpenAI-Codex_app_ui: reset the old stop before any UI callback.
        self._cancel_requested.clear()
        self._download_running = True
        try:
            urls = self._urls()
            if not urls:
                self.app.notify(self.tr.t("msg_no_url_body"), severity="warning")
                self._download_running = False
                return

            save_path = self.query_one("#save-path", Input).value.strip() or "."
            opts = DownloadOptions(
                save_path=save_path,
                mode=self.mode,
                video_fmt=self.query_one("#video-fmt", Select).value,
                audio_fmt=self.query_one("#audio-fmt", Select).value,
                quality=self.query_one("#quality", Select).value,
                cookie_file=self.query_one("#cookie-file", Input).value.strip() or None,
                browser=self.query_one("#browser", Select).value,
                bitrate=self.query_one("#bitrate", Select).value,
            )

            items = self.query_one("#items-list", ListView)
            items.clear()
            self._item_widgets: dict[int, Static] = {}
            self._item_urls: dict[int, str] = {}
            for i, url in enumerate(urls):
                static = Static(f"⏳ {url}")
                self._item_widgets[i] = static
                self._item_urls[i] = url
                items.append(ListItem(static))

            # OpenAI-Codex_app_ui: only reset before an operation is reserved.
            if not self._download_running:
                self._cancel_requested.clear()
            self.query_one("#start", Button).disabled = True
            self.query_one("#stop", Button).disabled = False
            # OpenAI-Codex_app_ui: keep an early stop visibly pending.
            if self._cancel_requested.is_set():
                self.query_one("#stop", Button).disabled = True
            self.query_one("#progress", ProgressBar).update(progress=0, total=100)
            self._run_download(urls, opts)

        except BaseException:
            # OpenAI-Codex_app_ui: restore controls without masking the start error.
            try:
                for selector, disabled in (("#start", False), ("#stop", True)):
                    try:
                        self.query_one(selector, Button).disabled = disabled
                    # OpenAI-Codex_restore127: Preserve the original start error if a widget is gone.
                    except Exception:  # noqa: S112
                        continue
            finally:
                self._download_running = False
            raise

    def _stop(self) -> None:
        self._cancel_requested.set()
        downloader = self._downloader
        if downloader is not None:
            downloader.stop()
        self.query_one("#stop", Button).disabled = True

    @work(thread=True, exclusive=True)
    def _run_download(self, urls: list[str], opts: DownloadOptions) -> None:
        def log_cb(level: str, key: str, **fmt) -> None:
            self.app.call_from_thread(self.app.log_line, level, key, **fmt)

        def progress_cb(pct: float, speed: str, eta: str) -> None:
            self.app.call_from_thread(self._update_progress, pct, speed, eta)

        def item_start_cb(i: int, total: int, url: str) -> None:
            self.app.call_from_thread(self._mark_item, i - 1, "running")

        # OpenAI-Codex_app_ui: finish once if downloader initialization fails.
        try:
            downloader = Downloader(
                opts,
                log_cb=log_cb,
                progress_cb=progress_cb,
                item_start_cb=item_start_cb,
            )
            self._downloader = downloader
            if self._cancel_requested.is_set():
                downloader.stop()
        except BaseException as _initialization_error:
            self._downloader = None
            try:
                self.app.call_from_thread(self._finish)
            except Exception as _finish_error:
                raise _initialization_error from _finish_error
            raise
        try:
            results = downloader.download_batch(urls)
            for i, (_, success, _) in enumerate(results):
                self.app.call_from_thread(
                    self._mark_item, i, "done" if success else "error"
                )
            for i in range(len(results), len(urls)):
                self.app.call_from_thread(self._mark_item, i, "skipped")
        finally:
            self._downloader = None
            self.app.call_from_thread(self._finish)

    def _update_progress(self, pct: float, speed: str, eta: str) -> None:
        self.query_one("#progress", ProgressBar).update(progress=pct, total=100)
        self.query_one("#status", Static).update(
            self.tr.t("status_progress", pct=pct, speed=speed, eta=eta)
        )

    def _mark_item(self, index: int, status: str) -> None:
        icon = {"running": "▶", "done": "✓", "error": "✗", "skipped": "–"}.get(
            status, "⏳"
        )
        widget = self._item_widgets.get(index)
        url = self._item_urls.get(index)
        if widget is not None and url is not None:
            widget.update(f"{icon} {url}")

    def _finish(self) -> None:
        # OpenAI-Codex_app_ui: keep busy until both controls have been restored.
        try:
            self.query_one("#start", Button).disabled = False
            self.query_one("#stop", Button).disabled = True
        finally:
            self._download_running = False


# Updated by OpenAI-Codex_Fork_Source_Code.
