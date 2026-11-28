# OpenAI-Codex_engine_cli
import io
import unittest
from contextlib import redirect_stdout
from unittest.mock import MagicMock, patch

import _path  # noqa: F401
from engine import (
    AUDIO_FORMATS,
    QUALITY_PRESETS,
    VIDEO_FORMATS,
    DownloadOptions,
    Downloader,
)
from engine.log_safety import redact_sensitive_urls
from engine.downloader import (
    _add_bilibili_media_range,
    _bilibili_url,
    _install_bilibili_range_retry,
)


def _make_downloader(**cbs) -> Downloader:
    opts = DownloadOptions(save_path=".")
    return Downloader(opts, **cbs)


# OpenAI-Codex: cover both public download paths without touching the network.
class DownloadPreflightTests(unittest.TestCase):
    def test_queue_and_batch_reject_low_space(self):
        dl = _make_downloader()
        with patch("engine.downloader.shutil.disk_usage") as usage, patch.object(dl, "download_one") as transfer:
            usage.return_value.free = 1
            with self.assertRaises(ValueError):
                dl.download_one_with_retry("mock")
            with self.assertRaises(ValueError):
                dl.download_batch(["mock"])
            transfer.assert_not_called()

    def test_prestart_stop_applies_only_to_first_batch(self):
        dl = _make_downloader()
        dl.stop()
        with patch("engine.downloader.shutil.disk_usage") as usage, patch.object(dl, "download_one") as transfer:
            self.assertEqual(dl.download_batch(["first"]), [])
            usage.assert_not_called()
            transfer.assert_not_called()
            usage.return_value.free = 100 * 1024 * 1024
            self.assertEqual(dl.download_batch(["second"]), [("second", True, "")])
            transfer.assert_called_once_with("second")


class PlaylistLogTests(unittest.TestCase):
    """`_ydl_hook` should log a playlist-position line once per NEW entry,
    never for a single (non-playlist) download, and never repeatedly for the
    same entry's progress ticks."""

    def test_non_playlist_download_never_logs_playlist_item(self):
        log_cb = MagicMock()
        dl = _make_downloader(log_cb=log_cb)
        dl._ydl_hook({"status": "downloading", "info_dict": {"title": "solo"}})
        dl._ydl_hook({"status": "finished", "info_dict": {"title": "solo"}})
        keys = [c.args[1] for c in log_cb.call_args_list]
        self.assertNotIn("log_playlist_item", keys)

    def test_playlist_entry_logs_once_per_new_index(self):
        log_cb = MagicMock()
        dl = _make_downloader(log_cb=log_cb)

        info1 = {"title": "Track 1", "n_entries": 3, "playlist_index": 1}
        # Several progress ticks for the SAME entry -- must log only once.
        dl._ydl_hook({"status": "downloading", "info_dict": info1})
        dl._ydl_hook({"status": "downloading", "info_dict": info1})
        dl._ydl_hook({"status": "finished", "info_dict": info1})

        info2 = {"title": "Track 2", "n_entries": 3, "playlist_index": 2}
        dl._ydl_hook({"status": "downloading", "info_dict": info2})

        playlist_calls = [c for c in log_cb.call_args_list if c.args[1] == "log_playlist_item"]
        self.assertEqual(len(playlist_calls), 2)
        self.assertEqual(playlist_calls[0].kwargs, {"i": 1, "t": 3, "title": "Track 1"})
        self.assertEqual(playlist_calls[1].kwargs, {"i": 2, "t": 3, "title": "Track 2"})

    def test_download_one_resets_playlist_tracking_between_urls(self):
        # A second, non-playlist URL right after a playlist must not inherit
        # the previous URL's tracked index (each download_one() call is a
        # fresh potential playlist).
        dl = _make_downloader()
        dl._playlist_index_logged = 5
        with patch("engine.downloader.yt_dlp.YoutubeDL") as mock_ydl:
            mock_ydl.return_value.__enter__.return_value.download.return_value = None
            dl.download_one("https://example.com/not-a-playlist")
        self.assertIsNone(dl._playlist_index_logged)


class ProgressHookTests(unittest.TestCase):
    # OpenAI-Codex: cover documented and styled yt-dlp progress payloads.
    def test_raw_download_fields_update_progress(self):
        callback = MagicMock()
        dl = _make_downloader(progress_cb=callback)

        dl._ydl_hook({
            "status": "downloading", "downloaded_bytes": 512,
            "total_bytes": 1024, "speed": 1536, "eta": 65,
        })

        callback.assert_called_once_with(50.0, "1.50KiB/s", "01:05")

    def test_styled_formatted_progress_is_usable(self):
        callback = MagicMock()
        dl = _make_downloader(progress_cb=callback)

        dl._ydl_hook({
            "status": "downloading", "_percent_str": "\x1b[0;32m 12.5%\x1b[0m",
            "_speed_str": "\x1b[0;32m2MiB/s\x1b[0m", "_eta_str": "00:03",
        })

        callback.assert_called_once_with(12.5, "2MiB/s", "00:03")

    def test_unknown_size_does_not_drop_speed_updates(self):
        callback = MagicMock()
        dl = _make_downloader(progress_cb=callback)

        dl._ydl_hook({
            "status": "downloading", "_percent_str": "N/A%",
            "downloaded_bytes": 512, "speed": 1024, "eta": None,
        })

        callback.assert_called_once_with(0.0, "1.00KiB/s", "--")

    def test_estimated_size_and_invalid_numeric_values(self):
        callback = MagicMock()
        dl = _make_downloader(progress_cb=callback)

        dl._ydl_hook({
            "status": "downloading", "_percent": float("nan"),
            "downloaded_bytes": 200, "total_bytes": 0,
            "total_bytes_estimate": 100, "speed": float("inf"),
            "eta": -1,
        })

        callback.assert_called_once_with(100.0, "--", "--")

class BilibiliRangeRetryTests(unittest.TestCase):
    # OpenAI-Codex: verify the 567 workaround never changes unrelated requests.
    def test_only_bilibili_media_without_existing_range_is_modified(self):
        formats = [
            {"url": "https://cdn.bilivideo.com/video", "http_headers": {"Referer": "https://www.bilibili.com/"}},
            {"url": "https://cdn.bilivideo.com/audio", "http_headers": {"range": "bytes=10-"}},
            {"url": "https://cdn.bilivideo.com.example/video", "http_headers": {}},
            {"url": "https://example.com/video", "http_headers": {}},
        ]

        _add_bilibili_media_range({"extractor_key": "BiliBili", "formats": formats})

        self.assertEqual(formats[0]["http_headers"]["Range"], "bytes=0-")
        self.assertEqual(formats[0]["http_headers"]["Referer"], "https://www.bilibili.com/")
        self.assertEqual(formats[1]["http_headers"], {"range": "bytes=10-"})
        self.assertEqual(formats[2]["http_headers"], {})
        self.assertEqual(formats[3]["http_headers"], {})

    def test_other_extractor_and_lookalike_domain_are_ignored(self):
        media = {"url": "https://cdn.bilivideo.com/video", "http_headers": {}}
        _add_bilibili_media_range({"extractor_key": "Other", "formats": [media]})
        self.assertEqual(media["http_headers"], {})
        self.assertTrue(_bilibili_url("https://www.bilibili.com/video/BV1"))
        self.assertFalse(_bilibili_url("https://bilibili.com.example/video/BV1"))

    def test_retry_registers_media_preprocessor_with_ytdlp(self):
        dl = _make_downloader()
        dl._bilibili_range_retry = True
        with patch("engine.downloader.yt_dlp.YoutubeDL") as factory:
            dl.download_one("https://www.bilibili.com/video/BV1")

        ydl = factory.return_value.__enter__.return_value
        args, kwargs = ydl.add_post_processor.call_args
        self.assertEqual(kwargs, {"when": "pre_process"})
        media = {"url": "https://cdn.bilivideo.com/video", "http_headers": {}}
        args[0].run({"extractor_key": "BiliBili", "formats": [media]})
        self.assertEqual(media["http_headers"]["Range"], "bytes=0-")

    def test_preprocessor_updates_ytdlp_selected_format_without_network(self):
        import yt_dlp

        info = {
            "id": "example", "title": "Synthetic", "extractor": "BiliBili",
            "extractor_key": "BiliBili", "formats": [{
                "format_id": "example", "url": "https://cdn.bilivideo.com/video.mp4",
                "ext": "mp4", "vcodec": "avc1", "acodec": "aac",
            }],
        }
        with yt_dlp.YoutubeDL({"quiet": True, "simulate": True}) as ydl:
            _install_bilibili_range_retry(ydl)
            with patch.object(ydl, "urlopen", side_effect=AssertionError("unexpected network call")):
                result = ydl.process_ie_result(info, download=False)

        self.assertEqual(result["http_headers"]["Range"], "bytes=0-")

    def test_567_enables_fallback_only_for_following_bilibili_attempt(self):
        dl = _make_downloader()
        seen = []

        def download(_url):
            seen.append(dl._bilibili_range_retry)
            if len(seen) == 1:
                raise RuntimeError("HTTP Error 567: Unknown Status")

        with patch.object(dl, "download_one", side_effect=download), patch("engine.downloader.time.sleep"):
            dl._download_one_with_retry("https://www.bilibili.com/video/BV1", 1, 1)

        self.assertEqual(seen, [False, True])
        self.assertFalse(dl._bilibili_range_retry)

    def test_non_bilibili_567_never_enables_fallback(self):
        dl = _make_downloader()
        seen = []

        def download(_url):
            seen.append(dl._bilibili_range_retry)
            raise RuntimeError("HTTP Error 567: Unknown Status")

        with patch.object(dl, "download_one", side_effect=download), patch("engine.downloader.time.sleep"):
            with self.assertRaisesRegex(RuntimeError, "HTTP Error 567"):
                dl._download_one_with_retry("https://example.com/video", 1, 1)

        self.assertEqual(seen, [False, False, False])
        self.assertFalse(dl._bilibili_range_retry)


class BatchSummaryTests(unittest.TestCase):
    """The batch-summary line must reflect what actually happened. Before this
    was fixed, a batch where every item 403'd still logged `log_all_done` at
    "ok" level -- a green checkmark on total failure (reported by a user)."""

    def _run_batch(self, side_effect):
        log_cb = MagicMock()
        dl = _make_downloader(log_cb=log_cb)
        with patch.object(Downloader, "download_one", side_effect=side_effect):
            results = dl.download_batch(["u1", "u2", "u3"])
        summary = [c for c in log_cb.call_args_list
                   if c.args[1].startswith("log_all_")]
        return results, summary

    def test_all_succeed_logs_ok(self):
        _, summary = self._run_batch(lambda url: None)
        self.assertEqual(len(summary), 1)
        self.assertEqual(summary[0].args[0], "ok")
        self.assertEqual(summary[0].args[1], "log_all_done")

    def test_all_fail_logs_error_not_ok(self):
        def boom(url):
            raise RuntimeError("HTTP Error 403: Forbidden")
        _, summary = self._run_batch(boom)
        self.assertEqual(len(summary), 1)
        self.assertEqual(summary[0].args[0], "err")
        self.assertEqual(summary[0].args[1], "log_all_failed")
        self.assertEqual(summary[0].kwargs, {"t": 3})

    def test_partial_failure_logs_warning_with_counts(self):
        calls = {"n": 0}

        def sometimes(url):
            calls["n"] += 1
            if calls["n"] == 2:
                raise RuntimeError("boom")
        _, summary = self._run_batch(sometimes)
        self.assertEqual(len(summary), 1)
        self.assertEqual(summary[0].args[0], "warn")
        self.assertEqual(summary[0].args[1], "log_all_done_partial")
        self.assertEqual(summary[0].kwargs, {"ok": 2, "fail": 1, "t": 3})


class RetryTests(unittest.TestCase):
    """403s are retried, but a 403 that survives every attempt means a stale
    bundled yt-dlp, not a blip -- say so instead of retrying forever."""

    def test_persistent_403_hints_at_outdated_downloader(self):
        log_cb = MagicMock()
        dl = _make_downloader(log_cb=log_cb)
        with patch.object(Downloader, "download_one",
                          side_effect=RuntimeError("HTTP Error 403: Forbidden")),                 patch("engine.downloader.time.sleep"):
            with self.assertRaises(RuntimeError):
                dl._download_one_with_retry("u1", 1, 1)
        keys = [c.args[1] for c in log_cb.call_args_list]
        self.assertEqual(keys.count("log_item_retry"), 2)
        self.assertIn("log_hint_outdated", keys)

    def test_non_transient_error_is_not_retried_and_gives_no_hint(self):
        log_cb = MagicMock()
        dl = _make_downloader(log_cb=log_cb)
        with patch.object(Downloader, "download_one",
                          side_effect=RuntimeError("no space left on device")),                 patch("engine.downloader.time.sleep"):
            with self.assertRaises(RuntimeError):
                dl._download_one_with_retry("u1", 1, 1)
        keys = [c.args[1] for c in log_cb.call_args_list]
        self.assertNotIn("log_item_retry", keys)
        self.assertNotIn("log_hint_outdated", keys)


class FormatValidationTests(unittest.TestCase):
    """
    `video_fmt` becomes yt-dlp's `merge_output_format`, which decides the
    `%(ext)s` in the output template -- so it helps compose the destination
    path, exactly like `dst_fmt` does for conversion. `video_fmt` and `quality`
    are also interpolated into the format-selector string. All three arrive
    from the network on the web backend, so `_build_ydl_opts` is the point that
    has to reject them.
    """

    def _opts(self, **kw) -> Downloader:
        return Downloader(DownloadOptions(save_path=".", **kw))

    # ── the allowed cases still work ────────────────────────────────────────
    def test_known_video_format_and_quality_accepted(self):
        got = self._opts(mode="video", video_fmt="mkv", quality="720p") \
            ._build_ydl_opts("https://example.com/v")
        self.assertEqual(got["merge_output_format"], "mkv")
        self.assertIn("height<=720", got["format"])

    def test_known_audio_format_accepted(self):
        got = self._opts(mode="audio", audio_fmt="flac") \
            ._build_ydl_opts("https://example.com/v")
        self.assertEqual(got["postprocessors"][0]["preferredcodec"], "flac")

    def test_every_catalogued_format_survives(self):
        # The check must not be narrower than the catalogue the UIs offer.
        for fmt in VIDEO_FORMATS:
            self._opts(mode="video", video_fmt=fmt)._build_ydl_opts("u")
        for fmt in AUDIO_FORMATS:
            self._opts(mode="audio", audio_fmt=fmt)._build_ydl_opts("u")
        for q in QUALITY_PRESETS:
            self._opts(mode="video", quality=q)._build_ydl_opts("u")

    # ── the rejected cases ──────────────────────────────────────────────────
    def test_traversal_in_video_format_rejected(self):
        with self.assertRaises(ValueError):
            self._opts(mode="video", video_fmt="../../../../Windows/Temp/evil") \
                ._build_ydl_opts("u")

    def test_selector_injection_in_quality_rejected(self):
        # Raw interpolation into the yt-dlp format selector, e.g.
        # bestvideo[height<=0]/all[height>0]+bestaudio
        with self.assertRaises(ValueError):
            self._opts(mode="video", quality="0]/all[height>0") \
                ._build_ydl_opts("u")

    def test_unknown_audio_format_rejected(self):
        with self.assertRaises(ValueError):
            self._opts(mode="audio", audio_fmt="../x.sh")._build_ydl_opts("u")

    def test_unused_field_of_the_other_mode_is_not_checked(self):
        # Audio mode never touches video_fmt, so a junk value there must not
        # break an otherwise valid request.
        got = self._opts(mode="audio", audio_fmt="mp3", video_fmt="") \
            ._build_ydl_opts("u")
        self.assertEqual(got["postprocessors"][0]["preferredcodec"], "mp3")


class DownloadSafetyTests(unittest.TestCase):
    def test_audio_bitrate_reaches_postprocessor(self):
        options = DownloadOptions(save_path=".", mode="audio", bitrate="320")
        actual = Downloader(options)._build_ydl_opts("https://example.com/video")
        self.assertEqual(actual["postprocessors"][0]["preferredquality"], "320")

    def test_invalid_audio_bitrate_is_rejected(self):
        for bitrate in ("0", "10000", "1.5", "１２８", "-1", "128k"):
            with self.subTest(bitrate=bitrate):
                options = DownloadOptions(save_path=".", mode="audio", bitrate=bitrate)
                with self.assertRaises(ValueError):
                    Downloader(options)._build_ydl_opts("https://example.com/video")

    def test_cli_accepts_audio_bitrate_option(self):
        from cli import build_parser

        args = build_parser().parse_args(["download", "https://example.com/video",
                                          "--audio", "--bitrate", "320"])
        self.assertEqual(args.bitrate, "320")

    def test_bitrate_with_many_leading_zeroes_is_normalized(self):
        options = DownloadOptions(save_path=".", mode="audio", bitrate="0" * 5000 + "192")
        actual = Downloader(options)._build_ydl_opts("https://example.com/video")
        self.assertEqual(actual["postprocessors"][0]["preferredquality"], "192")

    def test_missing_cookie_file_is_an_error_even_with_browser_selected(self):
        options = DownloadOptions(save_path=".", cookie_file="missing.txt", browser="chrome")
        with patch("engine.downloader.os.path.isfile", return_value=False):
            with self.assertRaisesRegex(ValueError, "[Cc]ookie"):
                Downloader(options)._build_ydl_opts("https://example.com/video")

    def test_stop_before_start_skips_every_url(self):
        downloader = _make_downloader()
        downloader.stop()
        with patch.object(Downloader, "download_one") as download:
            self.assertEqual(downloader.download_batch(["a", "b"]), [])
        download.assert_not_called()
        self.assertEqual(downloader.last_summary, {
            "total": 2, "succeeded": 0, "failed": 0, "skipped": 2, "cancelled": True,
        })

    def test_stop_after_success_does_not_report_all_done(self):
        events = []
        downloader = _make_downloader(log_cb=lambda level, key, **fmt: events.append((level, key)))
        with patch.object(Downloader, "download_one", side_effect=lambda url: downloader.stop()):
            results = downloader.download_batch(["a", "b"])
        self.assertEqual(len(results), 1)
        self.assertTrue(results[0][1])
        self.assertNotIn(("ok", "log_all_done"), events)
        self.assertEqual(downloader.last_summary, {
            "total": 2, "succeeded": 1, "failed": 0, "skipped": 1, "cancelled": True,
        })


class LogRedactionTests(unittest.TestCase):
    def test_redacts_url_credentials_query_and_fragment(self):
        line = "Downloading https://alice:password@example.com/watch?token=secret#private"
        self.assertEqual(
            redact_sensitive_urls(line),
            "Downloading https://[redacted]@example.com/watch?[redacted]#[redacted]",
        )

    def test_handles_multiple_urls_and_preserves_safe_url(self):
        line = "https://example.com/a and https://example.org/b?key=secret."
        self.assertEqual(
            redact_sensitive_urls(line),
            "https://example.com/a and https://example.org/b?[redacted].",
        )

    def test_malformed_url_is_redacted_instead_of_exposing_secrets(self):
        self.assertEqual(
            redact_sensitive_urls("https://user:secret@[invalid?token=private"),
            "[redacted URL]",
        )

    def test_engine_logs_and_error_result_redact_sensitive_urls(self):
        events = []
        downloader = _make_downloader(log_cb=lambda level, key, **fmt: events.append(fmt))
        url = "https://alice:password@example.com/watch?token=secret#private"
        with patch.object(Downloader, "download_one", side_effect=RuntimeError(url)):
            results = downloader.download_batch([url])
        self.assertNotIn("password", repr(events))
        self.assertNotIn("secret", repr(events))
        self.assertNotIn("password", results[0][2])
        self.assertNotIn("secret", results[0][2])

    def test_cli_logger_redacts_rendered_messages(self):
        from cli import _make_logger

        class Translator:
            def t(self, key, **fmt):
                return "https://alice:password@example.com/?token=secret"

        out = io.StringIO()
        with redirect_stdout(out):
            _make_logger(Translator())("err", "any")
        self.assertNotIn("password", out.getvalue())
        self.assertNotIn("secret", out.getvalue())


if __name__ == "__main__":
    unittest.main()


class CookieFileSelectionTests(unittest.TestCase):
    # OpenAI-Codex_Fork_GitHub_REPO: a specified file takes priority and must exist.
    def test_missing_file_does_not_fall_back_to_browser(self):
        options = DownloadOptions(
            save_path=".", cookie_file="missing.txt", browser="chrome"
        )
        with patch("engine.downloader.os.path.isfile", return_value=False):
            with self.assertRaisesRegex(ValueError, "Cookie file"):
                Downloader(options)._build_ydl_opts("https://example.com/media")

    def test_existing_file_takes_priority(self):
        options = DownloadOptions(
            save_path=".", cookie_file="cookies.txt", browser="chrome"
        )
        with patch("engine.downloader.os.path.isfile", return_value=True):
            result = Downloader(options)._build_ydl_opts("https://example.com/media")
        self.assertEqual(result["cookiefile"], "cookies.txt")
        self.assertNotIn("cookiesfrombrowser", result)

    def test_empty_file_allows_browser(self):
        options = DownloadOptions(save_path=".", cookie_file="", browser="chrome")
        result = Downloader(options)._build_ydl_opts("https://example.com/media")
        self.assertNotIn("cookiefile", result)
        self.assertEqual(result["cookiesfrombrowser"][0], "chrome")


class IssueRegressionTests(unittest.TestCase):
    def test_stop_during_progress_ends_batch_without_success_summary(self):
        logs = MagicMock()
        dl = _make_downloader(log_cb=logs)

        def stop_during_download(_url):
            dl.stop()
            dl._ydl_hook({"status": "downloading"})

        with patch.object(
            dl, "download_one", side_effect=stop_during_download
        ) as download:
            results = dl.download_batch(["first", "second"])
        self.assertEqual(results, [])
        self.assertEqual(download.call_count, 1)
        keys = [call.args[1] for call in logs.call_args_list]
        self.assertIn("log_stopped_dl", keys)
        self.assertNotIn("log_all_done", keys)
        self.assertNotIn("log_item_error", keys)

    def test_known_errors_emit_targeted_hints(self):
        cases = (
            ("Could not copy Chrome cookie database", "log_hint_cookie_database"),
            ("HTTP Error 567: Unknown Status", "log_hint_http_567"),
            ("389 bytes read, 747 more expected", "log_hint_incomplete_download"),
        )
        for message, expected in cases:
            with self.subTest(message=message):
                logs = MagicMock()
                dl = _make_downloader(log_cb=logs)
                with (
                    patch.object(dl, "download_one", side_effect=RuntimeError(message)),
                    patch("engine.downloader.time.sleep"),
                ):
                    result = dl.download_batch(["url"])
                self.assertFalse(result[0][1])
                self.assertIn(expected, [call.args[1] for call in logs.call_args_list])
