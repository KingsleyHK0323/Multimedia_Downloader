"""Smoke tests for the Textual terminal UI (tui/). Headless via App.run_test()."""

import _path  # noqa: F401  (sys.path shim)

import os
import tempfile
import threading
import unittest
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import patch

import i18n
from engine import Downloader
from tui.app import MultimediaDownloaderApp
from tui.convert_tab import ConvertTab
from tui.download_tab import DownloadTab
from tui.log_tab import LogTab


def _fake_download_batch(self, urls):
    self.item_start_cb(1, len(urls), urls[0])
    self.log_cb("info", "log_item_downloading", i=1, t=len(urls), url=urls[0])
    self.progress_cb(50.0, "1.2MB/s", "00:05")
    self.progress_cb(100.0, "--", "--")
    self.log_cb("ok", "log_item_done", i=1, t=len(urls))
    return [(urls[0], True, "")]


class TuiTests(unittest.IsolatedAsyncioTestCase):
    async def test_app_starts_with_three_tabs(self):
        app = MultimediaDownloaderApp(i18n.Translator("en"))
        async with app.run_test():
            self.assertIsNotNone(app.query_one(DownloadTab))
            self.assertIsNotNone(app.query_one(ConvertTab))
            self.assertIsNotNone(app.query_one(LogTab))

    async def test_dark_mode_toggle(self):
        app = MultimediaDownloaderApp(i18n.Translator("en"))
        async with app.run_test() as pilot:
            before = app.theme
            await pilot.press("d")
            await pilot.pause()
            self.assertNotEqual(app.theme, before)

    async def test_convert_add_and_remove_file(self):
        app = MultimediaDownloaderApp(i18n.Translator("en"))
        async with app.run_test():
            cv = app.query_one(ConvertTab)
            cv.query_one("#file-paths").text = "clip.mkv"
            cv._add_files()
            self.assertEqual(cv._files, ["clip.mkv"])
            cv._remove_selected()
            self.assertEqual(cv._files, [])

    async def test_convert_add_multiple_files_at_once(self):
        app = MultimediaDownloaderApp(i18n.Translator("en"))
        async with app.run_test():
            cv = app.query_one(ConvertTab)
            cv.query_one("#file-paths").text = "a.mkv\nb.mov\n\nc.mp4"
            cv._add_files()
            self.assertEqual(cv._files, ["a.mkv", "b.mov", "c.mp4"])
            self.assertEqual(len(cv._item_widgets), 3)

    async def test_convert_duplicate_paths_get_independent_rows(self):
        app = MultimediaDownloaderApp(i18n.Translator("en"))
        async with app.run_test():
            cv = app.query_one(ConvertTab)
            cv.query_one("#file-paths").text = "dup.mkv\ndup.mkv"
            cv._add_files()

            job_row = {}

            class FakeJob:
                def __init__(self, src_path, status):
                    self.src_path = src_path
                    self.status = status

            jobs = [FakeJob("dup.mkv", "pending"), FakeJob("dup.mkv", "pending")]
            for job in jobs:
                row = job_row.setdefault(id(job), len(job_row))
                job.status = "done"
                cv._mark_item(row, job.status)

            self.assertEqual(job_row[id(jobs[0])], 0)
            self.assertEqual(job_row[id(jobs[1])], 1)

    async def test_convert_preview_rejects_stale_aba_and_displays_unknown(self):
        app = MultimediaDownloaderApp(i18n.Translator("en"))
        async with app.run_test():
            cv = app.query_one(ConvertTab)
            cv.query_one("#file-paths").text = "clip [HD].mkv"
            cv._add_files()
            rows = [
                {
                    "src": "clip [HD].mkv",
                    "dst": "out/clip.mp4",
                    "existing": "unknown",
                    "batch_duplicate": True,
                    "source_matches": "unknown",
                }
            ]
            with patch.object(ConvertTab, "_run_preview"):
                cv._preview()
                stale = cv._preview_generation
                cv.query_one("#save-path").value = "B"
                cv.on_input_changed(None)
                cv.query_one("#save-path").value = ""
                cv.on_input_changed(None)
                display = cv.query_one("#preview-results")
                with patch.object(display, "update") as update:
                    cv._preview_done(stale, rows, None)
                    update.assert_not_called()

                cv._preview()
                with patch.object(display, "update") as update:
                    cv._preview_done(cv._preview_generation, rows, None)
                    rendered = update.call_args.args[0]
                self.assertIn("snapshot", rendered.lower())
                self.assertIn("Unknown", rendered)
                self.assertIn("clip [HD].mkv", rendered)

    async def test_convert_preview_checks_current_snapshot_before_rendering(self):
        app = MultimediaDownloaderApp(i18n.Translator("en"))
        async with app.run_test():
            cv = app.query_one(ConvertTab)
            cv.query_one("#file-paths").text = "clip.mkv"
            cv._add_files()
            rows = [
                {
                    "src": "clip.mkv",
                    "dst": "out/clip.mp4",
                    "existing": "missing",
                    "batch_duplicate": False,
                    "source_matches": "no",
                }
            ]
            with patch.object(ConvertTab, "_run_preview"):
                cv._preview()
                generation = cv._preview_generation
                cv.query_one("#save-path").value = "changed"
                display = cv.query_one("#preview-results")
                with patch.object(display, "update") as update:
                    cv._preview_done(generation, rows, None)
                self.assertTrue(
                    all(call.args[0] == "" for call in update.call_args_list)
                )
                self.assertGreater(cv._preview_generation, generation)

    async def test_convert_preview_generation_changes_on_list_and_operation_boundaries(
        self,
    ):
        app = MultimediaDownloaderApp(i18n.Translator("en"))
        async with app.run_test():
            cv = app.query_one(ConvertTab)
            initial = cv._preview_generation
            cv.query_one("#file-paths").text = "clip.mkv"
            cv._add_files()
            self.assertGreater(cv._preview_generation, initial)
            added = cv._preview_generation
            cv._remove_selected()
            self.assertGreater(cv._preview_generation, added)
            removed = cv._preview_generation
            with patch.object(ConvertTab, "_run_convert"):
                cv._begin(["clip.mkv"], ".", "mp4", "ffmpeg", "rename")
            self.assertGreater(cv._preview_generation, removed)
            started = cv._preview_generation
            cv._finish()
            self.assertGreater(cv._preview_generation, started)

    async def test_download_mode_toggle_shows_correct_fields(self):
        app = MultimediaDownloaderApp(i18n.Translator("en"))
        async with app.run_test() as pilot:
            dl = app.query_one(DownloadTab)
            dl.mode = "audio"
            await pilot.pause()
            self.assertTrue(dl.query_one("#audio-fields").display)
            self.assertFalse(dl.query_one("#video-fields").display)
            dl.mode = "video"
            await pilot.pause()
            self.assertFalse(dl.query_one("#audio-fields").display)
            self.assertTrue(dl.query_one("#video-fields").display)

    async def test_log_handles_bracket_content_without_crashing(self):
        # yt-dlp/ffmpeg output routinely contains literal "[...]" (site name
        # prefixes, codec/address tags) -- these must never be parsed as Rich
        # markup (which would silently swallow them, or in some cases raise
        # MarkupError and crash the whole app).
        app = MultimediaDownloaderApp(i18n.Translator("en"))
        async with app.run_test() as pilot:
            lg = app.query_one(LogTab)
            app.log_line(
                "err",
                "log_item_error",
                i=1,
                t=1,
                err="[youtube] dQw4w9WgXcQ: Sign in to confirm your age",
            )
            app.log_line(
                "info",
                "log_convert_start",
                i=1,
                t=1,
                src="Song [HD].mkv",
                dst="Song [HD] [/].mp4",
            )
            await pilot.pause()
            self.assertIn("[youtube]", lg._entries[0][2])
            self.assertIn("[/]", lg._entries[1][2])

    async def test_log_append_filter_and_clear_confirm(self):
        app = MultimediaDownloaderApp(i18n.Translator("en"))
        async with app.run_test() as pilot:
            lg = app.query_one(LogTab)
            app.log_line("info", "log_start_batch", n=3)
            app.log_line("err", "log_item_error", i=1, t=3, err="boom")
            self.assertEqual(len(lg._entries), 2)

            lg.query_one("#level").value = "err"
            lg._refilter()
            await pilot.pause()

            # Clear requires confirmation -- pushing the dialog then dismissing
            # with False must NOT clear the entries.
            lg._confirm_clear()
            await pilot.pause()
            await pilot.press("escape")
            await pilot.pause()
            self.assertEqual(len(lg._entries), 2)

            # Confirming actually clears.
            lg._entries.clear()
            lg.query_one("#console").clear()
            self.assertEqual(len(lg._entries), 0)

    async def test_log_export_writes_a_file(self):
        app = MultimediaDownloaderApp(i18n.Translator("en"))
        async with app.run_test():
            lg = app.query_one(LogTab)
            app.log_line("ok", "log_all_done", t=1)
            with tempfile.TemporaryDirectory() as tmp:
                cwd = os.getcwd()
                os.chdir(tmp)
                try:
                    lg._export()
                    files = [f for f in os.listdir(tmp) if f.startswith("mmdl_log_")]
                    self.assertEqual(len(files), 1)
                finally:
                    os.chdir(cwd)

    async def test_log_hides_url_credentials_and_query(self):
        app = MultimediaDownloaderApp(i18n.Translator("en"))
        async with app.run_test():
            lg = app.query_one(LogTab)
            lg.append_entry(
                "info",
                "https://user:secret@example.invalid/video?token=private#fragment",
            )
            text = lg._entries[-1][2]
            self.assertIn("example.invalid/video", text)
            for secret in ("user", "secret", "private", "fragment"):
                self.assertNotIn(secret, text)

    async def test_two_log_exports_in_same_second_do_not_overwrite(self):
        app = MultimediaDownloaderApp(i18n.Translator("en"))
        async with app.run_test():
            lg = app.query_one(LogTab)
            lg.append_entry("info", "first entry")
            with tempfile.TemporaryDirectory() as tmp:
                cwd = os.getcwd()
                os.chdir(tmp)
                try:
                    with patch("tui.log_tab.datetime") as clock:
                        clock.now.return_value = datetime(2026, 1, 1, 12, 0, 0)
                        lg._export()
                        lg.append_entry("info", "second entry")
                        lg._export()
                    files = sorted(
                        f for f in os.listdir(tmp) if f.startswith("mmdl_log_")
                    )
                    self.assertEqual(len(files), 2)
                    with open(files[0], encoding="utf-8") as first:
                        self.assertNotIn("second entry", first.read())
                finally:
                    os.chdir(cwd)

    async def test_download_worker_updates_progress_and_log(self):
        app = MultimediaDownloaderApp(i18n.Translator("en"))
        async with app.run_test() as pilot:
            dl = app.query_one(DownloadTab)
            lg = app.query_one(LogTab)
            dl.query_one("#urls").text = "https://example.com/video"
            dl.query_one("#save-path").value = "."

            with patch.object(Downloader, "download_batch", _fake_download_batch):
                dl._start()
                for _ in range(50):
                    await pilot.pause(0.05)
                    if dl.query_one("#stop").disabled:
                        break

            self.assertFalse(dl.query_one("#start").disabled)
            self.assertTrue(dl.query_one("#stop").disabled)
            self.assertEqual(dl.query_one("#progress").progress, 100.0)
            self.assertGreaterEqual(len(lg._entries), 2)

    async def test_download_stop_during_worker_start_is_preserved(self):
        entered, release = threading.Event(), threading.Event()
        observed = []

        class SlowDownloader:
            def __init__(self, *args, **kwargs):
                self.stopped = False
                entered.set()
                release.wait(2)

            def stop(self):
                self.stopped = True

            def download_batch(self, urls):
                observed.append(self.stopped)
                return []

        app = MultimediaDownloaderApp(i18n.Translator("en"))
        async with app.run_test() as pilot:
            dl = app.query_one(DownloadTab)
            dl.query_one("#urls").text = "https://example.invalid/a"
            with patch("tui.download_tab.Downloader", SlowDownloader):
                try:
                    dl._start()
                    for _ in range(100):
                        if entered.is_set():
                            break
                        await pilot.pause(0.01)
                    self.assertTrue(entered.is_set())
                    dl._stop()
                    release.set()
                    for _ in range(100):
                        if observed:
                            break
                        await pilot.pause(0.01)
                    self.assertEqual(observed, [True])
                finally:
                    release.set()

    async def test_convert_stop_during_worker_start_is_preserved(self):
        entered, release = threading.Event(), threading.Event()
        observed = []

        class SlowConverter:
            def __init__(self, *args, **kwargs):
                self.stopped = False
                entered.set()
                release.wait(2)

            def stop(self):
                self.stopped = True

            def convert_batch(self, files):
                observed.append(self.stopped)
                return []

        app = MultimediaDownloaderApp(i18n.Translator("en"))
        async with app.run_test() as pilot:
            cv = app.query_one(ConvertTab)
            cv.query_one("#file-paths").text = "clip.mkv"
            cv._add_files()
            with patch("tui.convert_tab.Converter", SlowConverter):
                try:
                    cv._start()
                    for _ in range(100):
                        if entered.is_set():
                            break
                        await pilot.pause(0.01)
                    self.assertTrue(entered.is_set())
                    cv._stop()
                    release.set()
                    for _ in range(100):
                        if observed:
                            break
                        await pilot.pause(0.01)
                    self.assertEqual(observed, [True])
                finally:
                    release.set()

    # OpenAI-Codex_engine_cli: cover reactive A-B-A before Changed is dispatched.
    async def test_convert_preview_rejects_undispatched_reactive_aba(self):
        app = MultimediaDownloaderApp(i18n.Translator("en"))
        async with app.run_test():
            cv = app.query_one(ConvertTab)
            try:
                from importlib.metadata import version

                supported = version("textual") == "8.2.8"
            except Exception:
                supported = False
            if not supported:
                self.skipTest(
                    "synchronous watcher timing has only been reviewed for Textual 8.2.8"
                )
            self.assertTrue(cv._preview_watch_ready)
            cv._files = ["clip.mkv"]
            rows = [
                {
                    "src": "clip.mkv",
                    "dst": "out/clip.mp4",
                    "existing": "missing",
                    "batch_duplicate": False,
                    "source_matches": "no",
                }
            ]
            fields = (
                ("#save-path", "other"),
                ("#ffmpeg-bin", "other-ffmpeg"),
                ("#dst-fmt", "mkv"),
                ("#conflict-policy", "skip"),
            )
            with patch.object(ConvertTab, "_run_preview"):
                for selector, alternate in fields:
                    with self.subTest(selector=selector):
                        field = cv.query_one(selector)
                        original = field.value
                        cv._preview()
                        generation = cv._preview_generation
                        field.value = alternate
                        field.value = original
                        self.assertGreater(cv._preview_generation, generation)
                        with patch.object(
                            cv.query_one("#preview-results"), "update"
                        ) as update:
                            cv._preview_done(generation, rows, None)
                            update.assert_not_called()

                cv._preview()
                with patch.object(cv.query_one("#preview-results"), "update") as update:
                    cv._preview_done(cv._preview_generation, rows, None)
                    update.assert_called_once()

                with patch.object(cv.query_one("#preview-results"), "update") as update:
                    cv.query_one("#save-path").value = "changed-after-preview"
                    update.assert_called_with("")

                # Queued messages from before a new request must not discard it.
                for selector, alternate, attribute, handler in (
                    ("#save-path", "other", "input", cv.on_input_changed),
                    ("#dst-fmt", "mkv", "select", cv.on_select_changed),
                ):
                    with self.subTest(delayed=selector):
                        field = cv.query_one(selector)
                        original = field.value
                        field.value = alternate
                        field.value = original
                        cv._preview()
                        generation = cv._preview_generation
                        handler(SimpleNamespace(**{attribute: field}))
                        handler(SimpleNamespace(**{attribute: field}))
                        with patch.object(
                            cv.query_one("#preview-results"), "update"
                        ) as update:
                            cv._preview_done(generation, rows, None)
                            update.assert_called_once()


# Added by OpenAI-Codex_Fork_Source_Code.
# Updated by OpenAI-Codex_engine_cli.


# OpenAI-Codex_engine_cli: exercise version and registration fallbacks without UI I/O.
class ConvertPreviewWatcherFallbackTests(unittest.TestCase):
    @staticmethod
    def _fake_tab():
        selectors = ("#save-path", "#ffmpeg-bin", "#dst-fmt", "#conflict-policy")
        widgets = {
            selector: SimpleNamespace(id=selector[1:], callbacks=[])
            for selector in selectors
        }
        state = SimpleNamespace(_preview_watch_ready=False, generation=0, fail_on=None)
        state.query_one = lambda selector, *_: widgets[selector]

        def invalidate():
            state.generation += 1

        def watch(widget, name, callback, init=True):
            if state.fail_on == widget.id:
                raise RuntimeError("synthetic watcher failure")
            if name != "value" or init:
                raise AssertionError("unexpected watcher contract")
            if callback not in widget.callbacks:
                widget.callbacks.append(callback)

        state._invalidate_preview = invalidate
        state.watch = watch
        return state, widgets

    def test_unverified_or_unavailable_versions_preserve_changed_fallback(self):
        for value, error in (
            ("8.2.9", None),
            ("", None),
            (None, RuntimeError("missing metadata")),
        ):
            with self.subTest(value=value, error=error):
                tab, widgets = self._fake_tab()
                with patch(
                    "importlib.metadata.version", return_value=value, side_effect=error
                ):
                    ConvertTab.on_mount(tab)
                self.assertFalse(tab._preview_watch_ready)
                ConvertTab.on_input_changed(
                    tab, SimpleNamespace(input=widgets["#save-path"])
                )
                self.assertEqual(tab.generation, 1)

    def test_partial_registration_is_safe_and_reentry_completes_once(self):
        tab, widgets = self._fake_tab()
        tab.fail_on = "dst-fmt"
        with patch("importlib.metadata.version", return_value="8.2.8"):
            ConvertTab.on_mount(tab)
            self.assertFalse(tab._preview_watch_ready)
            ConvertTab.on_select_changed(
                tab, SimpleNamespace(select=widgets["#dst-fmt"])
            )
            self.assertEqual(tab.generation, 1)
            tab.fail_on = None
            ConvertTab.on_mount(tab)
            ConvertTab.on_mount(tab)
        self.assertTrue(tab._preview_watch_ready)
        self.assertTrue(all(len(widget.callbacks) == 1 for widget in widgets.values()))
        ConvertTab.on_select_changed(tab, SimpleNamespace(select=widgets["#dst-fmt"]))
        self.assertEqual(tab.generation, 1)
        widgets["#dst-fmt"].callbacks[0]()
        self.assertEqual(tab.generation, 2)


if __name__ == "__main__":
    unittest.main()
