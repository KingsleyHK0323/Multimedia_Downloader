"""Convert tab — local file format conversion, wired to engine.Converter."""

from __future__ import annotations

import threading

from textual import work
from textual.app import ComposeResult
from textual.containers import Horizontal, VerticalScroll
from textual.widgets import (
    Button,
    Input,
    Label,
    ListItem,
    ListView,
    Select,
    Static,
    TextArea,
)

from engine import AUDIO_FORMATS, VIDEO_FORMATS, Converter
from engine.log_safety import redact_sensitive_urls
from .widgets import ConfirmDialog


class ConvertTab(VerticalScroll):
    """Composes the convert form; owns a single in-flight ``Converter``."""

    def __init__(self, tr) -> None:
        super().__init__()
        self.tr = tr
        self._converter: Converter | None = None
        self._cancel_requested = threading.Event()
        self._preview_generation = 0
        self._preview_snapshot = None
        self._preview_inflight = False
        self._preview_watch_ready = False
        # OpenAI-Codex_ai_ui_check: Textual owns MessagePump._running.
        self._conversion_running = False
        # OpenAI-Codex_app_ui: invalidate stale overwrite confirmations.
        self._confirmation_generation = 0
        self._files: list[str] = []
        # Kept in lockstep with ``_files`` (index i is always file i's row
        # widget) instead of re-derived from ``items.children`` at run time,
        # so a run started right after an add/remove can never see a stale
        # or not-yet-applied ListView mutation.
        self._item_widgets: list[Static] = []

    def compose(self) -> ComposeResult:
        tr = self.tr
        all_formats = list(VIDEO_FORMATS) + list(AUDIO_FORMATS)

        yield Label(tr.t("cv_file_list"), classes="section-title")
        yield TextArea(id="file-paths", soft_wrap=True)
        with Horizontal(classes="field-row"):
            yield Button(tr.t("btn_add_files"), id="add-file")
            yield Button(tr.t("btn_remove_selected"), id="remove-file")
        yield ListView(id="files-list")

        yield Label(tr.t("cv_format"), classes="section-title")
        with Horizontal(classes="field-row"):
            yield Select(((f, f) for f in all_formats), value=all_formats[0], id="dst-fmt", allow_blank=False)

        yield Label(tr.t("conflict_label"), classes="section-title")
        yield Select(
            [(tr.t("conflict_rename"), "rename"), (tr.t("conflict_skip"), "skip"),
             (tr.t("conflict_overwrite"), "overwrite")],
            value="rename", id="conflict-policy", allow_blank=False,
        )

        yield Label(tr.t("adv_options"), classes="section-title")
        yield Input(value="ffmpeg", id="ffmpeg-bin", classes="field-row")

        yield Label(tr.t("cv_output"), classes="section-title")
        yield Input(placeholder=".", id="save-path", classes="field-row")

        with Horizontal(classes="actions-row"):
            yield Button(tr.t("preview_button"), id="preview")

        with Horizontal(classes="actions-row"):
            yield Button(tr.t("btn_start_convert"), id="start", variant="success")
            yield Button(tr.t("btn_stop"), id="stop", variant="error", disabled=True)

        yield Static("", id="status", classes="status-line")
        yield Static("", id="preview-results", markup=False)

    # OpenAI-Codex_engine_cli: invalidate before queued Changed messages can be delayed.
    def on_mount(self) -> None:
        self._preview_watch_ready = False
        try:
            for selector, widget_type in (("#save-path", Input), ("#ffmpeg-bin", Input),
                                          ("#dst-fmt", Select), ("#conflict-policy", Select)):
                self.watch(self.query_one(selector, widget_type), "value", self._invalidate_preview, init=False)
            self._preview_watch_ready = True
        except Exception:
            self._preview_watch_ready = False
            return
        try:
            from importlib.metadata import version
            # Callback ordering has only been reviewed for this Textual version.
            self._preview_watch_ready = version("textual") == "8.2.8"
        except Exception:
            self._preview_watch_ready = False

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "add-file":
            self._add_files()
        elif event.button.id == "remove-file":
            self._remove_selected()
        elif event.button.id == "preview":
            self._preview()
        elif event.button.id == "start":
            self._start()
        elif event.button.id == "stop":
            self._stop()

    def on_input_changed(self, event: Input.Changed) -> None:
        if (self._preview_watch_ready and event is not None
                and getattr(getattr(event, "input", None), "id", None) in ("save-path", "ffmpeg-bin")):
            return
        self._invalidate_preview()

    def on_select_changed(self, event: Select.Changed) -> None:
        if (self._preview_watch_ready and event is not None
                and getattr(getattr(event, "select", None), "id", None) in ("dst-fmt", "conflict-policy")):
            return
        self._invalidate_preview()

    def on_text_area_changed(self, event: TextArea.Changed) -> None:
        # OpenAI-Codex_app_ui: retain an unchanged snapshot for a delayed file-paths event.
        try:
            if (self._preview_watch_ready and self.is_mounted and not self._conversion_running
                    and self._preview_snapshot is not None
                    and getattr(getattr(event, "text_area", None), "id", None) == "file-paths"
                    and self._preview_snapshot == self._preview_inputs()):
                return
        except Exception:
            self._invalidate_preview()
            return
        self._invalidate_preview()

    def _invalidate_preview(self) -> None:
        self._preview_generation += 1
        self._preview_snapshot = None
        if self.is_mounted:
            self.query_one("#preview-results", Static).update("")

    def _preview_inputs(self):
        return (
            tuple(self._files),
            self.query_one("#save-path", Input).value.strip() or ".",
            self.query_one("#dst-fmt", Select).value,
            self.query_one("#conflict-policy", Select).value,
            self.query_one("#ffmpeg-bin", Input).value,
            self.query_one("#file-paths", TextArea).text,
        )

    def _add_files(self) -> None:
        paths_area = self.query_one("#file-paths", TextArea)
        paths = [p.strip() for p in paths_area.text.splitlines() if p.strip()]
        if not paths:
            return
        self._invalidate_preview()
        items = self.query_one("#files-list", ListView)
        for path in paths:
            self._files.append(path)
            static = Static(path)
            self._item_widgets.append(static)
            items.append(ListItem(static))
        items.index = len(self._files) - 1  # highlight the last added row
        paths_area.text = ""

    def _remove_selected(self) -> None:
        items = self.query_one("#files-list", ListView)
        index = items.index
        if index is None or not (0 <= index < len(self._files)):
            return
        self._invalidate_preview()
        del self._files[index]
        del self._item_widgets[index]
        items.pop(index)

    def _preview(self) -> None:
        if self._preview_inflight or self._conversion_running:
            return
        if not self._files:
            self.app.notify(self.tr.t("msg_no_files_body"), severity="warning")
            return
        snapshot = self._preview_inputs()
        files, save_path, dst_fmt, conflict_policy, _, _ = snapshot
        self._invalidate_preview()
        self._preview_snapshot = snapshot
        generation = self._preview_generation
        self._preview_inflight = True
        self.query_one("#preview", Button).disabled = True
        self._run_preview(generation, list(files), save_path, dst_fmt, conflict_policy)

    @work(thread=True, group="convert-preview")
    def _run_preview(self, generation: int, files: list[str], save_path: str,
                     dst_fmt: str, conflict_policy: str) -> None:
        try:
            converter = Converter(save_path=save_path, dst_fmt=dst_fmt, conflict_policy=conflict_policy)
            rows = converter.preview_batch(files)
        except Exception as exc:
            self.app.call_from_thread(self._preview_done, generation, None, str(exc))
        else:
            self.app.call_from_thread(self._preview_done, generation, rows, None)

    def _preview_done(self, generation: int, rows: list[dict] | None, error: str | None) -> None:
        self._preview_inflight = False
        if not self.is_mounted:
            return
        self.query_one("#preview", Button).disabled = self._conversion_running
        if generation != self._preview_generation:
            return
        if self._preview_snapshot != self._preview_inputs():
            self._invalidate_preview()
            return
        if error is not None:
            self.app.notify(redact_sensitive_urls(error), severity="error")
            return
        lines = [self.tr.t("preview_title"), self.tr.t("preview_snapshot_hint")]
        for row in rows or []:
            lines.append(redact_sensitive_urls(f"{row['src']} -> {row['dst']}"))
            lines.append(f"  {self.tr.t('preview_existing')}: {self.tr.t('preview_' + row['existing'])}")
            lines.append(f"  {self.tr.t('preview_source_matches')}: {self.tr.t('preview_' + row['source_matches'])}")
            if row["batch_duplicate"]:
                lines.append(f"  {self.tr.t('preview_batch_duplicate')}")
        self.query_one("#preview-results", Static).update("\n".join(lines))

    def _start(self) -> None:
        # OpenAI-Codex_app_ui: reject reentry and supersede earlier requests.
        if self._conversion_running:
            return
        self._confirmation_generation += 1
        confirmation_generation = self._confirmation_generation
        if not self._files:
            self.app.notify(self.tr.t("msg_no_files_body"), severity="warning")
            return

        self._invalidate_preview()
        save_path = self.query_one("#save-path", Input).value.strip() or "."
        dst_fmt = self.query_one("#dst-fmt", Select).value
        ffmpeg_bin = self.query_one("#ffmpeg-bin", Input).value.strip() or "ffmpeg"
        conflict_policy = self.query_one("#conflict-policy", Select).value
        files = list(self._files)

        if conflict_policy == "overwrite":
            def handle(confirmed: bool | None) -> None:
                # OpenAI-Codex_app_ui: consume each current response only once.
                if confirmation_generation != self._confirmation_generation:
                    return
                self._confirmation_generation += 1
                if self._conversion_running:
                    return
                if confirmed:
                    self._begin(files, save_path, dst_fmt, ffmpeg_bin, conflict_policy)

            self.app.push_screen(ConfirmDialog(
                self.tr.t("conflict_overwrite_title"),
                self.tr.t("conflict_overwrite_confirm"),
                self.tr.t("btn_confirm"), self.tr.t("btn_cancel"),
            ), handle)
            return
        self._begin(files, save_path, dst_fmt, ffmpeg_bin, conflict_policy)

    def _begin(self, files: list[str], save_path: str, dst_fmt: str,
               ffmpeg_bin: str, conflict_policy: str) -> None:
        # OpenAI-Codex_app_ui: guard callbacks and invalidate older dialogs.
        if self._conversion_running:
            return
        self._confirmation_generation += 1
        # OpenAI-Codex_app_ui: block synchronous reentry during widget updates.
        self._conversion_running = True
        try:
            self._invalidate_preview()
        except BaseException:
            self._conversion_running = False
            raise
        self._conversion_running = True
        pending = self.tr.t("tree_pending")
        for path, widget in zip(self._files, self._item_widgets):
            widget.update(f"{pending}  —  {path}")

        self._cancel_requested.clear()
        self.query_one("#start", Button).disabled = True
        self.query_one("#stop", Button).disabled = False
        self.query_one("#add-file", Button).disabled = True
        self.query_one("#remove-file", Button).disabled = True
        self.query_one("#preview", Button).disabled = True
        self._run_convert(files, save_path, dst_fmt, ffmpeg_bin, conflict_policy)

    def _stop(self) -> None:
        self._cancel_requested.set()
        converter = self._converter
        if converter is not None:
            converter.stop()
        self.query_one("#stop", Button).disabled = True

    @work(thread=True, exclusive=True)
    def _run_convert(self, files: list[str], save_path: str, dst_fmt: str,
                     ffmpeg_bin: str, conflict_policy: str) -> None:
        def log_cb(level: str, key: str, **fmt) -> None:
            self.app.call_from_thread(self.app.log_line, level, key, **fmt)

        # Map each ConvertJob to its row by object identity (in first-seen
        # order), not by re-looking-up job.src_path in `files` -- duplicate
        # paths would otherwise all resolve to the same (first) index.
        job_row: dict[int, int] = {}

        def job_update_cb(job) -> None:
            row = job_row.setdefault(id(job), len(job_row))
            self.app.call_from_thread(self._mark_item, row, job.status)

        # OpenAI-Codex_app_ui: finish once if converter initialization fails.
        try:
            converter = Converter(save_path=save_path, dst_fmt=dst_fmt, log_cb=log_cb,
                                   job_update_cb=job_update_cb, ffmpeg_bin=ffmpeg_bin,
                                   conflict_policy=conflict_policy)
            self._converter = converter
            if self._cancel_requested.is_set():
                converter.stop()
        except BaseException as _initialization_error:
            self._converter = None
            try:
                self.app.call_from_thread(self._finish)
            except Exception as _finish_error:
                raise _initialization_error from _finish_error
            raise
        try:
            converter.convert_batch(files)
        except ValueError as exc:
            # Surface preflight failures without leaving the worker in error.
            message = redact_sensitive_urls(str(exc))
            log_cb("err", "log_convert_error", i=0, t=len(files), err=message)
            self.app.call_from_thread(self.app.notify, message, severity="error")
        finally:
            self._converter = None
            self.app.call_from_thread(self._finish)

    _STATUS_KEY = {
        "converting": "tree_converting",
        "done": "tree_done",
        "error": "tree_error",
        "no_ffmpeg": "tree_need_ffmpeg",
        "skipped": "tree_skipped",
    }

    def _mark_item(self, index: int, status: str) -> None:
        label = self.tr.t(self._STATUS_KEY.get(status, "tree_pending"))
        if 0 <= index < len(self._item_widgets):
            self._item_widgets[index].update(f"{label}  —  {self._files[index]}")

    def _finish(self) -> None:
        self._invalidate_preview()
        self._conversion_running = False
        self.query_one("#start", Button).disabled = False
        self.query_one("#stop", Button).disabled = True
        self.query_one("#add-file", Button).disabled = False
        self.query_one("#remove-file", Button).disabled = False
        self.query_one("#preview", Button).disabled = self._preview_inflight


# Updated by OpenAI-Codex_Fork_Source_Code.
# Updated by OpenAI-Codex_engine_cli.
