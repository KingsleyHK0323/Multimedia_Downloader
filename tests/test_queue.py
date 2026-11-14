import unittest
from unittest.mock import patch

import _path  # noqa: F401
import engine.queue as q
from engine import DownloadOptions, TaskQueue, download_task, convert_task


class FactoryTests(unittest.TestCase):
    def test_download_task(self):
        opts = DownloadOptions(save_path="out")
        t = download_task("http://x/v", opts)
        self.assertEqual(t.kind, "download")
        self.assertEqual(t.url, "http://x/v")
        self.assertIs(t.options, opts)
        self.assertEqual(t.label, "http://x/v")

    def test_convert_task(self):
        t = convert_task("in/clip.mkv", "out/clip.mp4")
        self.assertEqual(t.kind, "convert")
        self.assertEqual(t.label, "clip.mkv")


class _FakeDownloader:
    """Stand-in for engine.queue.Downloader — records URLs, optionally fails."""
    fail_urls: set = set()
    on_download = None  # optional hook(url) for side effects (e.g. stop)
    seen: list = []

    def __init__(self, options, log_cb=None):
        self.options = options

    # OpenAI-Codex_Fork_GitHub_REPO: preserve the fake queue contract.
    def download_one_with_retry(self, url, index=1, total=1):
        self.download_one(url)

    def download_one(self, url):
        _FakeDownloader.seen.append(url)
        if _FakeDownloader.on_download:
            _FakeDownloader.on_download(url)
        if url in _FakeDownloader.fail_urls:
            raise RuntimeError("boom")


class QueueRunTests(unittest.TestCase):
    def setUp(self):
        _FakeDownloader.fail_urls = set()
        _FakeDownloader.on_download = None
        _FakeDownloader.seen = []
        self._orig = q.Downloader
        q.Downloader = _FakeDownloader

    def tearDown(self):
        q.Downloader = self._orig

    def test_all_success(self):
        opts = DownloadOptions(save_path="out")
        tasks = [download_task(f"http://x/{i}", opts) for i in range(3)]
        updates = []
        tq = TaskQueue(task_update_cb=lambda t: updates.append((t.label, t.status)))
        result = tq.run(tasks)
        self.assertTrue(all(t.status == "done" for t in result))
        self.assertEqual(_FakeDownloader.seen, ["http://x/0", "http://x/1", "http://x/2"])

    def test_one_failure_recorded(self):
        opts = DownloadOptions(save_path="out")
        _FakeDownloader.fail_urls = {"http://x/1"}
        tasks = [download_task(f"http://x/{i}", opts) for i in range(3)]
        tq = TaskQueue()
        result = tq.run(tasks)
        self.assertEqual([t.status for t in result], ["done", "error", "done"])
        self.assertEqual(result[1].error, "boom")

    def test_stop_marks_remaining_skipped(self):
        opts = DownloadOptions(save_path="out")
        tasks = [download_task(f"http://x/{i}", opts) for i in range(4)]
        tq = TaskQueue()
        # Ask the queue to stop while the FIRST task is downloading.
        _FakeDownloader.on_download = lambda url: tq.stop()
        result = tq.run(tasks)
        self.assertEqual(result[0].status, "done")     # first still finishes
        self.assertTrue(all(t.status == "skipped" for t in result[1:]))

    def test_download_task_missing_fields(self):
        bad = q.Task(kind="download", url=None, options=None)
        tq = TaskQueue()
        tq.run([bad])
        self.assertEqual(bad.status, "error")

    def test_unknown_kind(self):
        bad = q.Task(kind="frobnicate")
        tq = TaskQueue()
        tq.run([bad])
        self.assertEqual(bad.status, "error")
        self.assertIn("unknown task kind", bad.error)


class QueueRetryTests(unittest.TestCase):
    # OpenAI-Codex_Fork_GitHub_REPO: verify retries without network or sleeps.
    def test_transient_failure_retries_and_succeeds(self):
        from engine.errors import ErrorKind
        task = download_task("https://example.com/media", DownloadOptions(save_path="out"))
        with patch.object(q.Downloader, "download_one", side_effect=[RuntimeError("temporary"), None]) as call:
            with patch("engine.downloader.classify", return_value=ErrorKind.TRANSIENT):
                with patch("engine.downloader.time.sleep") as sleep:
                    TaskQueue().run([task])
        self.assertEqual(task.status, "done")
        self.assertEqual(call.call_count, 2)
        sleep.assert_called_once()

    def test_non_transient_failure_does_not_retry(self):
        from engine.errors import ErrorKind
        task = download_task("https://example.com/media", DownloadOptions(save_path="out"))
        with patch.object(q.Downloader, "download_one", side_effect=RuntimeError("permanent")) as call:
            with patch("engine.downloader.classify", return_value=ErrorKind.UNKNOWN):
                with patch("engine.downloader.time.sleep") as sleep:
                    TaskQueue().run([task])
        self.assertEqual(task.status, "error")
        self.assertEqual(call.call_count, 1)
        sleep.assert_not_called()


if __name__ == "__main__":
    unittest.main()
