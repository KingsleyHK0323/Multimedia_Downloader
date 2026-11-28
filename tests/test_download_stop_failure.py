# OpenAI-Codex_app_ui: distinguish in-flight download failures from cancellation.
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import _path  # noqa: F401
import engine.downloader as downloader_module
from engine import DownloadOptions, Downloader, TaskQueue, download_task
from engine.errors import OperationCancelled


class DownloadStopFailureTests(unittest.TestCase):
    def test_inflight_failure_is_recorded_after_stop_without_retry(self):
        for error in (RuntimeError("HTTP Error 503: synthetic"), ValueError("synthetic"), RuntimeError("")):
            with self.subTest(error=repr(error)):
                events = []
                downloader = Downloader(
                    DownloadOptions(save_path="synthetic"),
                    log_cb=lambda level, key, **fmt: events.append((level, key, fmt)),
                )

                def fail_after_stop(_url):
                    downloader.stop()
                    raise error

                with patch.object(downloader, "download_one", side_effect=fail_after_stop) as attempt:
                    results = downloader.download_batch(["synthetic-a", "synthetic-b"])

                self.assertEqual(attempt.call_count, 1)
                self.assertEqual(results, [("synthetic-a", False, str(error))])
                self.assertEqual(downloader.last_summary, {
                    "total": 2, "succeeded": 0, "failed": 1, "skipped": 1, "cancelled": True,
                })
                keys = [key for _level, key, _fmt in events]
                self.assertIn("log_item_error", keys)
                self.assertIn("log_stopped_dl", keys)
                self.assertNotIn("log_item_done", keys)
                self.assertNotIn("log_item_retry", keys)

    def test_explicit_cancellation_is_not_retried_or_reclassified(self):
        downloader = Downloader(DownloadOptions(save_path="synthetic"))
        cancellation = OperationCancelled("HTTP Error 503: synthetic cancellation")
        fake_time = SimpleNamespace(sleep=lambda _delay: self.fail("unexpected retry"))
        with (
            patch.object(downloader, "download_one", side_effect=cancellation) as attempt,
            patch.object(downloader_module, "time", fake_time),
        ):
            with self.assertRaises(OperationCancelled) as caught:
                downloader.download_one_with_retry("synthetic")
        self.assertIs(caught.exception, cancellation)
        self.assertEqual(attempt.call_count, 1)

    def test_explicit_cancellation_after_stop_stays_cancelled(self):
        downloader = Downloader(DownloadOptions(save_path="synthetic"))
        cancellation = OperationCancelled("synthetic cancellation")

        def cancel_after_stop(_url):
            downloader.stop()
            raise cancellation

        with patch.object(downloader, "download_one", side_effect=cancel_after_stop) as attempt:
            self.assertEqual(downloader.download_batch(["synthetic-a", "synthetic-b"]), [])
        self.assertEqual(attempt.call_count, 1)
        self.assertEqual(downloader.last_summary, {
            "total": 2, "succeeded": 0, "failed": 0, "skipped": 2, "cancelled": True,
        })

    def test_stopped_inflight_success_is_still_recorded(self):
        downloader = Downloader(DownloadOptions(save_path="synthetic"))
        with patch.object(downloader, "download_one", side_effect=lambda _url: downloader.stop()) as attempt:
            results = downloader.download_batch(["synthetic-a", "synthetic-b"])
        self.assertEqual(attempt.call_count, 1)
        self.assertEqual(results, [("synthetic-a", True, "")])
        self.assertEqual(downloader.last_summary, {
            "total": 2, "succeeded": 1, "failed": 0, "skipped": 1, "cancelled": True,
        })

    def test_transient_failure_still_retries_without_stop(self):
        downloader = Downloader(DownloadOptions(save_path="synthetic"))
        delays = []
        with (
            patch.object(downloader, "download_one",
                         side_effect=[RuntimeError("HTTP Error 503: synthetic"), None]) as attempt,
            patch.object(downloader_module, "time", SimpleNamespace(sleep=delays.append)),
        ):
            downloader.download_one_with_retry("synthetic")
        self.assertEqual(attempt.call_count, 2)
        self.assertEqual(delays, [downloader_module._RETRY_DELAY_S])

    def test_queue_records_inflight_failure_and_skips_later_task(self):
        queue = TaskQueue()
        opts = DownloadOptions(save_path="synthetic")
        tasks = [download_task("synthetic-a", opts), download_task("synthetic-b", opts)]
        error = RuntimeError("HTTP Error 503: synthetic")

        def fail_after_stop(_downloader, _url):
            queue.stop()
            raise error

        with patch.object(Downloader, "download_one", autospec=True, side_effect=fail_after_stop) as attempt:
            result = queue.run(tasks)

        self.assertIs(result, tasks)
        self.assertEqual(attempt.call_count, 1)
        self.assertEqual([task.status for task in tasks], ["error", "skipped"])
        self.assertEqual(tasks[0].error, str(error))
        self.assertEqual(queue.last_summary, {
            "total": 2, "succeeded": 0, "failed": 1, "skipped": 1, "cancelled": True,
        })


    # OpenAI-Codex_app_ui: preserve a transient failure when stop arrives during retry.
    def test_stop_during_retry_sleep_records_the_previous_failure(self):
        downloader = Downloader(DownloadOptions(save_path="synthetic"))
        error = RuntimeError("HTTP Error 503: synthetic")
        delays = []

        def stop_during_sleep(delay):
            delays.append(delay)
            downloader.stop()

        with (
            patch.object(downloader, "download_one", side_effect=error) as attempt,
            patch.object(downloader_module, "time", SimpleNamespace(sleep=stop_during_sleep)),
        ):
            results = downloader.download_batch(["synthetic-a", "synthetic-b"])

        self.assertEqual(attempt.call_count, 1)
        self.assertEqual(delays, [downloader_module._RETRY_DELAY_S])
        self.assertEqual(results, [("synthetic-a", False, str(error))])
        self.assertEqual(downloader.last_summary, {
            "total": 2, "succeeded": 0, "failed": 1, "skipped": 1, "cancelled": True,
        })

    def test_stop_from_retry_log_does_not_enter_sleep(self):
        events = []
        downloader = None

        def log(level, key, **fmt):
            events.append((level, key, fmt))
            if key == "log_item_retry":
                downloader.stop()

        downloader = Downloader(DownloadOptions(save_path="synthetic"), log_cb=log)
        error = RuntimeError("HTTP Error 503: synthetic")
        fake_time = SimpleNamespace(sleep=lambda _delay: self.fail("unexpected sleep"))
        with (
            patch.object(downloader, "download_one", side_effect=error) as attempt,
            patch.object(downloader_module, "time", fake_time),
        ):
            results = downloader.download_batch(["synthetic-a", "synthetic-b"])

        self.assertEqual(attempt.call_count, 1)
        self.assertEqual(results, [("synthetic-a", False, str(error))])
        self.assertEqual(downloader.last_summary, {
            "total": 2, "succeeded": 0, "failed": 1, "skipped": 1, "cancelled": True,
        })
        self.assertIn("log_item_error", [key for _level, key, _fmt in events])


    # OpenAI-Codex_app_ui: a stop between adjacent checks must not hide the error.
    def test_stop_arriving_between_exception_checks_preserves_failure(self):
        class StopChangesDuringCatch(Downloader):
            def __init__(self):
                self.stop_reads = 0
                super().__init__(DownloadOptions(save_path="synthetic"))

            @property
            def _stop(self):
                self.stop_reads += 1
                return self.stop_reads >= 3

            @_stop.setter
            def _stop(self, _value):
                pass

        downloader = StopChangesDuringCatch()
        error = RuntimeError("HTTP Error 503: synthetic")
        with patch.object(downloader, "download_one", side_effect=error) as attempt:
            with self.assertRaises(RuntimeError) as caught:
                downloader.download_one_with_retry("synthetic")

        self.assertIs(caught.exception, error)
        self.assertEqual(attempt.call_count, 1)
        self.assertEqual(downloader.stop_reads, 3)


    # OpenAI-Codex_engine_cli: explicit cancellation ends either batch entry point.
    def test_explicit_cancellation_without_stop_cancels_download_batch(self):
        downloader = Downloader(DownloadOptions(save_path="synthetic"))
        cancellation = OperationCancelled("synthetic cancellation")
        events = []
        downloader.log_cb = lambda level, key, **fmt: events.append((level, key, fmt))
        with patch.object(downloader, "download_one", side_effect=cancellation) as attempt:
            results = downloader.download_batch(["synthetic-a", "synthetic-b"])
        self.assertEqual(results, [])
        self.assertEqual(attempt.call_count, 1)
        self.assertEqual(downloader.last_summary, {
            "total": 2, "succeeded": 0, "failed": 0, "skipped": 2, "cancelled": True,
        })
        self.assertIn("log_stopped_dl", [key for _level, key, _fmt in events])

    def test_explicit_cancellation_without_stop_cancels_queue(self):
        queue = TaskQueue()
        options = DownloadOptions(save_path="synthetic")
        tasks = [download_task("synthetic-a", options), download_task("synthetic-b", options)]
        cancellation = OperationCancelled("synthetic cancellation")
        with patch.object(Downloader, "download_one", autospec=True, side_effect=cancellation) as attempt:
            result = queue.run(tasks)
        self.assertIs(result, tasks)
        self.assertEqual(attempt.call_count, 1)
        self.assertEqual([task.status for task in tasks], ["skipped", "skipped"])
        self.assertEqual(queue.last_summary, {
            "total": 2, "succeeded": 0, "failed": 0, "skipped": 2, "cancelled": True,
        })

    # OpenAI-Codex_engine_cli: stop during classification is not repeated failure.
    def test_stop_during_classification_does_not_report_repeated_403(self):
        events = []
        downloader = Downloader(
            DownloadOptions(save_path="synthetic"),
            log_cb=lambda level, key, **fmt: events.append((level, key, fmt)),
        )
        error = RuntimeError("HTTP Error 403: synthetic")

        def classify_and_stop(exc):
            self.assertIs(exc, error)
            downloader.stop()
            return downloader_module.ErrorKind.TRANSIENT

        fake_time = SimpleNamespace(sleep=lambda _delay: self.fail("unexpected retry"))
        with (
            patch.object(downloader, "download_one", side_effect=error) as attempt,
            patch.object(downloader_module, "classify", side_effect=classify_and_stop),
            patch.object(downloader_module, "time", fake_time),
        ):
            results = downloader.download_batch(["synthetic-a", "synthetic-b"])
        self.assertEqual(attempt.call_count, 1)
        self.assertEqual(results, [("synthetic-a", False, str(error))])
        self.assertEqual(downloader.last_summary, {
            "total": 2, "succeeded": 0, "failed": 1, "skipped": 1, "cancelled": True,
        })
        self.assertNotIn("log_hint_outdated", [key for _level, key, _fmt in events])

    def test_exhausted_403_keeps_hint_when_stop_arrives_at_last_classification(self):
        events = []
        classifications = []
        downloader = Downloader(
            DownloadOptions(save_path="synthetic"),
            log_cb=lambda level, key, **fmt: events.append((level, key, fmt)),
        )
        error = RuntimeError("HTTP Error 403: synthetic")

        def classify_until_last(exc):
            self.assertIs(exc, error)
            classifications.append(exc)
            if len(classifications) == downloader_module._MAX_RETRIES + 1:
                downloader.stop()
            return downloader_module.ErrorKind.TRANSIENT

        with (
            patch.object(downloader, "download_one", side_effect=error) as attempt,
            patch.object(downloader_module, "classify", side_effect=classify_until_last),
            patch.object(downloader_module, "time", SimpleNamespace(sleep=lambda _delay: None)),
        ):
            results = downloader.download_batch(["synthetic-a"])
        self.assertEqual(attempt.call_count, downloader_module._MAX_RETRIES + 1)
        self.assertEqual(results, [("synthetic-a", False, str(error))])
        self.assertEqual(downloader.last_summary, {
            "total": 1, "succeeded": 0, "failed": 1, "skipped": 0, "cancelled": True,
        })
        self.assertIn("log_hint_outdated", [key for _level, key, _fmt in events])

if __name__ == "__main__":
    unittest.main()
