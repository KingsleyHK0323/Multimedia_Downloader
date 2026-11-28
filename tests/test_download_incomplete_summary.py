# OpenAI-Codex_engine_cli
"""Fake download checks for incomplete-batch summary logging."""

import unittest

import _path  # noqa: F401
from engine import DownloadOptions, Downloader


class IncompleteDownloadSummaryTests(unittest.TestCase):
    def _run_batch(self, outcomes, stop_after=None):
        events = []
        calls = []
        downloader = Downloader(
            DownloadOptions(save_path="."),
            log_cb=lambda level, key, **fmt: events.append((level, key, fmt)),
        )

        def fake_download(url, _index, _total):
            calls.append(url)
            if stop_after == len(calls):
                downloader.stop()
            if not outcomes[len(calls) - 1]:
                raise RuntimeError("synthetic failure")

        downloader._download_one_with_retry = fake_download
        results = downloader.download_batch(["synthetic-a", "synthetic-b"])
        return results, calls, events

    def test_stopped_incomplete_batch_has_no_completion_summary(self):
        for first_succeeds in (True, False):
            with self.subTest(first_succeeds=first_succeeds):
                results, calls, events = self._run_batch(
                    (first_succeeds, True), stop_after=1
                )
                self.assertEqual(calls, ["synthetic-a"])
                self.assertEqual(len(results), 1)
                self.assertIs(results[0][1], first_succeeds)
                self.assertIn(
                    ("warn", "log_stopped_dl"),
                    [(level, key) for level, key, _fmt in events],
                )
                self.assertFalse(
                    [key for _level, key, _fmt in events if key.startswith("log_all_")]
                )
                if not first_succeeds:
                    self.assertIn(
                        ("err", "log_item_error"),
                        [(level, key) for level, key, _fmt in events],
                    )

    def test_complete_batches_keep_existing_summaries(self):
        for outcomes, expected in (
            ((True, True), ("ok", "log_all_done")),
            ((False, False), ("err", "log_all_failed")),
            ((True, False), ("warn", "log_all_done_partial")),
        ):
            with self.subTest(outcomes=outcomes):
                results, calls, events = self._run_batch(outcomes)
                self.assertEqual(len(results), 2)
                self.assertEqual(len(calls), 2)
                summaries = [
                    (level, key)
                    for level, key, _fmt in events
                    if key.startswith("log_all_")
                ]
                self.assertEqual(summaries, [expected])

    def test_more_results_than_total_have_no_completion_summary(self):
        events = []
        downloader = Downloader(
            DownloadOptions(save_path="."),
            log_cb=lambda level, key, **fmt: events.append((level, key, fmt)),
        )
        downloader._log_batch_summary(
            [("synthetic-a", True, ""), ("synthetic-b", True, "")], 1
        )
        self.assertEqual(events, [])

    # OpenAI-Codex_engine_cli: include failed outcomes in the overfull case.
    def test_more_results_with_failure_have_no_completion_summary(self):
        events = []
        downloader = Downloader(
            DownloadOptions(save_path="."),
            log_cb=lambda level, key, **fmt: events.append((level, key, fmt)),
        )
        downloader._log_batch_summary(
            [("synthetic-a", False, "synthetic"), ("synthetic-b", True, "")], 1
        )
        self.assertEqual(events, [])


if __name__ == "__main__":
    unittest.main()
