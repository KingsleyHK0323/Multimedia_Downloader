"""
Tests for engine/errors.py — the single place that decides what a failure means.

Behaviour used to branch on substrings scattered across modules. Centralising
it does not make the string matching robust, so these tests exist to make it
*visible*: if an upstream library rewords a message, a test here should be what
tells you, rather than a quietly reduced success rate in the field.
"""
from __future__ import annotations

import unittest

import _path  # noqa: F401  — puts the project root on sys.path

from engine.errors import ErrorKind, classify, is_stale_tool


class ClassifyTests(unittest.TestCase):
    def test_missing_ffmpeg_detected_by_type_not_message(self):
        # The message is deliberately unhelpful: type alone must be enough.
        self.assertIs(classify(FileNotFoundError("")), ErrorKind.NO_FFMPEG)

    def test_type_wins_over_message(self):
        # A FileNotFoundError whose text contains a transient marker is still
        # NO_FFMPEG -- type is checked first for a reason.
        exc = FileNotFoundError("403 while looking for ffmpeg")
        self.assertIs(classify(exc), ErrorKind.NO_FFMPEG)

    def test_403_is_transient(self):
        self.assertIs(classify(RuntimeError("HTTP Error 403: Forbidden")),
                      ErrorKind.TRANSIENT)

    def test_forbidden_without_code_is_transient(self):
        self.assertIs(classify(RuntimeError("Forbidden")), ErrorKind.TRANSIENT)

    def test_5xx_is_transient(self):
        self.assertIs(classify(RuntimeError("HTTP Error 503: Service Unavailable")),
                      ErrorKind.TRANSIENT)

    def test_unrecognised_is_unknown(self):
        self.assertIs(classify(ValueError("something else entirely")),
                      ErrorKind.UNKNOWN)

    def test_404_is_not_transient(self):
        # Retrying a genuine 404 just wastes the user's time.
        self.assertIs(classify(RuntimeError("HTTP Error 404: Not Found")),
                      ErrorKind.UNKNOWN)

    # ── Documented non-behaviour ─────────────────────────────────────────────
    # These pin what we deliberately do NOT treat as transient. If either is
    # ever added, it needs its own backoff -- these tests should then be
    # updated consciously rather than silently starting to fail.
    def test_rate_limit_is_not_transient_today(self):
        self.assertIs(classify(RuntimeError("HTTP Error 429: Too Many Requests")),
                      ErrorKind.UNKNOWN)

    def test_timeout_is_not_transient_today(self):
        self.assertIs(classify(TimeoutError("timed out")), ErrorKind.UNKNOWN)


class StaleToolTests(unittest.TestCase):
    """
    STALE_TOOL is a transition, not a property: the same 403 means "retry" on
    the first attempt and "your downloader is out of date" once retrying has
    failed. Only the retry loop knows which, so this is a separate predicate.
    """

    def test_403_after_retries_points_at_a_stale_tool(self):
        self.assertTrue(is_stale_tool(RuntimeError("HTTP Error 403: Forbidden")))

    def test_5xx_does_not(self):
        # A 5xx that never recovered is the server's problem, not ours --
        # telling the user to update the app would be actively misleading.
        self.assertFalse(is_stale_tool(RuntimeError("HTTP Error 503")))

    def test_unknown_error_does_not(self):
        self.assertFalse(is_stale_tool(ValueError("boom")))

    def test_missing_ffmpeg_does_not(self):
        self.assertFalse(is_stale_tool(FileNotFoundError("ffmpeg")))


class EnumTests(unittest.TestCase):
    def test_serialises_as_plain_string(self):
        # str-subclass, so it survives json.dumps if it ever crosses IPC.
        self.assertEqual(ErrorKind.TRANSIENT.value, "transient")
        self.assertEqual(f"{ErrorKind.NO_FFMPEG.value}", "no_ffmpeg")

    def test_no_members_without_a_consumer(self):
        # Guards the decision to keep the enum minimal: BAD_INPUT/PERMISSION
        # were left out until something actually branches on them. Adding a
        # member should be a deliberate act that updates this test.
        self.assertEqual(
            {k.name for k in ErrorKind},
            {"TRANSIENT", "STALE_TOOL", "NO_FFMPEG", "UNKNOWN"},
        )


# OpenAI-Codex_engine_cli: timeout type must precede message markers.
class TimeoutMarkerTests(unittest.TestCase):
    def test_message_markers_do_not_override_timeout_type(self):
        class DerivedTimeout(TimeoutError):
            pass

        for message in (
            "timed out: https://example.invalid/403",
            "timed out after HTTP Error 503",
            "timed out while receiving Forbidden",
        ):
            for error_type in (TimeoutError, DerivedTimeout):
                with self.subTest(message=message, error_type=error_type):
                    error = error_type(message)
                    self.assertIs(classify(error), ErrorKind.UNKNOWN)
                    self.assertFalse(is_stale_tool(error))

    def test_retry_loop_uses_error_type_with_fake_io(self):
        from unittest.mock import patch

        from engine.downloader import Downloader

        # OpenAI-Codex_engine_cli: isolate retry globals from the shared clock.
        from types import FunctionType, SimpleNamespace

        # OpenAI-Codex: isolate the function that executes the retry loop.
        real_retry = Downloader._download_one_with_retry_impl
        real_time = real_retry.__globals__["time"]
        real_sleep = real_time.sleep
        fake_time = SimpleNamespace(sleep=None)
        retry_globals = dict(real_retry.__globals__)
        retry_globals["time"] = fake_time
        fake_retry = FunctionType(
            real_retry.__code__,
            retry_globals,
            real_retry.__name__,
            real_retry.__defaults__,
            real_retry.__closure__,
        )
        self.assertIs(fake_retry.__code__, real_retry.__code__)
        self.assertIsNot(fake_retry.__globals__, real_retry.__globals__)
        self.assertIs(fake_retry.__globals__["time"], fake_time)
        self.assertIs(
            fake_retry.__globals__["classify"], real_retry.__globals__["classify"]
        )
        Downloader = SimpleNamespace(_download_one_with_retry=fake_retry)
        patch_object = patch.object

        def patch(target):
            if target != "engine.downloader.time.sleep":
                raise AssertionError("unexpected patch target")
            return patch_object(fake_time, "sleep")

        class FakeDownloader:
            def __init__(self, error):
                self._stop = False
                self.error = error
                self.attempts = 0
                self.log_keys = []

            def download_one(self, _url):
                self.attempts += 1
                raise self.error

            def _log(self, _level, key, **_kwargs):
                self.log_keys.append(key)

        scenarios = (
            (TimeoutError("timed out: 403"), 1, False),
            (TimeoutError("timed out: HTTP Error 503"), 1, False),
            (RuntimeError("HTTP Error 403: Forbidden"), 3, True),
            (RuntimeError("HTTP Error 503"), 3, False),
            (RuntimeError("HTTP Error 404: Not Found https://example.invalid/403"), 1, False),
            (RuntimeError("HTTP Error 429: Too Many Requests https://example.invalid/403"), 1, False),
            (RuntimeError("HTTP Error 429"), 1, False),
            (FileNotFoundError("403 while finding ffmpeg"), 1, False),
        )
        for error, expected_attempts, expect_hint in scenarios:
            with self.subTest(error=str(error)):
                fake = FakeDownloader(error)
                with patch("engine.downloader.time.sleep") as delay:
                    self.assertIs(real_retry.__globals__["time"], real_time)
                    self.assertIs(real_time.sleep, real_sleep)
                    with self.assertRaises(type(error)) as caught:
                        Downloader._download_one_with_retry(fake, "synthetic", 1, 1)
                self.assertIsNone(fake_time.sleep)
                self.assertIs(real_retry.__globals__["time"], real_time)
                self.assertIs(real_time.sleep, real_sleep)
                self.assertIs(caught.exception, error)
                self.assertEqual(fake.attempts, expected_attempts)
                self.assertEqual(delay.call_count, expected_attempts - 1)
                self.assertEqual(
                    fake.log_keys.count("log_hint_outdated"), int(expect_hint)
                )

# OpenAI-Codex_engine_cli: explicit 404/429 prefixes outrank later markers.
class ExplicitNonTransientStatusTests(unittest.TestCase):
    def test_non_transient_prefixes_ignore_later_markers(self):
        for status in (404, 429):
            for marker in ("403", "Forbidden", "HTTP Error 503"):
                with self.subTest(status=status, marker=marker):
                    error = RuntimeError(f"HTTP Error {status}: {marker}")
                    self.assertIs(classify(error), ErrorKind.UNKNOWN)
                    self.assertFalse(is_stale_tool(error))

    def test_other_primary_statuses_keep_existing_rules(self):
        forbidden = RuntimeError("HTTP Error 403: Forbidden; URL /429")
        server_error = RuntimeError("HTTP Error 503: Service Unavailable; URL /404")
        self.assertIs(classify(forbidden), ErrorKind.TRANSIENT)
        self.assertTrue(is_stale_tool(forbidden))
        self.assertIs(classify(server_error), ErrorKind.TRANSIENT)
        self.assertFalse(is_stale_tool(server_error))


if __name__ == "__main__":
    unittest.main()
