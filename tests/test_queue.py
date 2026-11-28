# OpenAI-Codex: mock the streaming FFmpeg process used by the converter.
# OpenAI-Codex_engine_cli
import ntpath
import stat
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
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

    def download_one(self, url):
        _FakeDownloader.seen.append(url)
        if _FakeDownloader.on_download:
            _FakeDownloader.on_download(url)
        if url in _FakeDownloader.fail_urls:
            raise RuntimeError("boom")

    def download_one_with_retry(self, url, index=1, total=1):
        return self.download_one(url)

    def stop(self):
        pass


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


class QueueSafetyTests(unittest.TestCase):
    def test_task_ids_are_unique_and_caller_id_is_preserved(self):
        first = q.Task(kind="download", label="same")
        second = q.Task(kind="download", label="same")
        supplied = q.Task(kind="download", task_id="request-1")
        self.assertTrue(first.task_id)
        self.assertNotEqual(first.task_id, second.task_id)
        self.assertEqual(supplied.task_id, "request-1")

    def test_stop_before_start_marks_every_task_skipped(self):
        tasks = [download_task("a", DownloadOptions(save_path=".")),
                 download_task("b", DownloadOptions(save_path="."))]
        queue = TaskQueue()
        queue.stop()
        with patch.object(q.Downloader, "download_one") as download:
            queue.run(tasks)
        download.assert_not_called()
        self.assertEqual([task.status for task in tasks], ["skipped", "skipped"])
        self.assertEqual(queue.last_summary, {
            "total": 2, "succeeded": 0, "failed": 0, "skipped": 2, "cancelled": True,
        })

    def test_queue_download_uses_same_transient_retry_as_batch(self):
        task = download_task("a", DownloadOptions(save_path="."))
        with patch.object(q.Downloader, "download_one", side_effect=[RuntimeError("403"), None]) as attempt:
            with patch("engine.downloader.time.sleep"):
                TaskQueue().run([task])
        self.assertEqual(attempt.call_count, 2)
        self.assertEqual(task.status, "done")

    def test_queue_error_redacts_sensitive_url_parts(self):
        task = download_task("a", DownloadOptions(save_path="."))
        error = "https://alice:password@example.com/?token=secret"
        with patch.object(q.Downloader, "download_one", side_effect=RuntimeError(error)):
            TaskQueue().run([task])
        self.assertEqual(task.status, "error")
        self.assertNotIn("password", task.error)
        self.assertNotIn("secret", task.error)

    def test_duplicate_task_ids_are_rejected_before_any_task_runs(self):
        tasks = [q.Task(kind="download", task_id="same"), q.Task(kind="download", task_id="same")]
        queue = TaskQueue()
        with patch.object(q.Downloader, "download_one") as download:
            with self.assertRaises(ValueError):
                queue.run(tasks)
        download.assert_not_called()

    def test_queue_conversion_reports_the_renamed_output(self):
        with tempfile.TemporaryDirectory() as directory:
            original = Path(directory) / "clip.mp4"
            original.write_bytes(b"existing")
            task = convert_task("clip.mkv", str(original))

            def fake_ffmpeg(args, **kwargs):
                Path(args[-1]).write_bytes(b"converted")
                return SimpleNamespace(returncode=0, stderr=(), wait=lambda: 0)

            with patch("engine.converter.subprocess.Popen", side_effect=fake_ffmpeg):
                TaskQueue().run([task])
            self.assertEqual(task.status, "done")
            self.assertNotEqual(Path(task.dst_path), original)
            self.assertEqual(Path(task.dst_path).read_bytes(), b"converted")
            self.assertEqual(original.read_bytes(), b"existing")

    def test_queue_skip_does_not_count_collision_as_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            original = Path(directory) / "clip.mp4"
            original.write_bytes(b"existing")
            task = convert_task("clip.mkv", str(original), conflict_policy="skip")
            queue = TaskQueue()
            with patch("engine.converter.subprocess.Popen") as ffmpeg:
                queue.run([task])
            ffmpeg.assert_not_called()
            self.assertEqual(task.status, "skipped")
            self.assertEqual(queue.last_summary, {
                "total": 1, "succeeded": 0, "failed": 0, "skipped": 1, "cancelled": False,
            })


class QueueDependencyTests(unittest.TestCase):
    @staticmethod
    def _convert_input(args, **kwargs):
        source = Path(args[3])
        if not source.exists():
            return SimpleNamespace(returncode=1, stderr=["missing source"], wait=lambda: 1)
        Path(args[-1]).write_bytes(source.read_bytes() + b" converted")
        return SimpleNamespace(returncode=0, stderr=(), wait=lambda: 0)

    def test_missing_intermediate_is_created_for_all_policies(self):
        for policy in ("rename", "skip", "overwrite"):
            with self.subTest(policy=policy), tempfile.TemporaryDirectory() as directory:
                source = Path(directory) / "a.mkv"
                middle = Path(directory) / "b.mp4"
                output = Path(directory) / "c.mp4"
                source.write_bytes(b"source")
                first = convert_task(str(source), str(middle), conflict_policy=policy)
                second = convert_task(str(middle), str(output))
                queue = TaskQueue()
                with patch("engine.converter.subprocess.Popen", side_effect=self._convert_input):
                    queue.run([first, second])
                self.assertEqual([first.status, second.status], ["done", "done"])
                self.assertEqual(Path(first.dst_path), middle)
                self.assertEqual(output.read_bytes(), b"source converted converted")
                self.assertEqual(queue.last_summary["succeeded"], 2)
                self.assertFalse(list(Path(directory).glob(".mmdl-*")))

    def test_existing_intermediate_is_not_silently_used_after_rename(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "a.mkv"
            middle = Path(directory) / "b.mp4"
            output = Path(directory) / "c.mp4"
            source.write_bytes(b"new")
            middle.write_bytes(b"old")
            prelude = download_task("https://example.com/video",
                                    DownloadOptions(save_path=str(Path(directory) / "downloads")))
            first = convert_task(str(source), str(middle))
            second = convert_task(str(middle), str(output))
            with patch("engine.converter.subprocess.Popen") as ffmpeg, \
                    patch.object(q.Downloader, "download_one_with_retry") as download:
                with self.assertRaisesRegex(ValueError, "earlier conversion destination"):
                    TaskQueue().run([prelude, first, second])
            ffmpeg.assert_not_called()
            download.assert_not_called()
            self.assertEqual([prelude.status, first.status, second.status],
                             ["pending", "pending", "pending"])
            self.assertEqual(middle.read_bytes(), b"old")
            self.assertFalse(output.exists())

    def test_intermediate_created_during_transcode_is_not_silently_used(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "a.mkv"
            middle = Path(directory) / "b.mp4"
            output = Path(directory) / "c.mp4"
            source.write_bytes(b"new")
            first = convert_task(str(source), str(middle))
            second = convert_task(str(middle), str(output))

            def race(args, **kwargs):
                result = self._convert_input(args, **kwargs)
                if Path(args[3]) == source:
                    middle.write_bytes(b"other writer")
                return result

            with patch("engine.converter.subprocess.Popen", side_effect=race):
                TaskQueue().run([first, second])
            self.assertEqual(first.status, "done")
            self.assertNotEqual(Path(first.dst_path), middle)
            self.assertEqual(second.status, "skipped")
            self.assertEqual(middle.read_bytes(), b"other writer")
            self.assertFalse(output.exists())

    def test_independent_conversion_still_runs_after_a_rename(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "a.mkv"
            middle = Path(directory) / "b.mp4"
            independent = Path(directory) / "d.mkv"
            output = Path(directory) / "e.mp4"
            source.write_bytes(b"new")
            middle.write_bytes(b"old")
            independent.write_bytes(b"independent")
            first = convert_task(str(source), str(middle))
            second = convert_task(str(independent), str(output))
            with patch("engine.converter.subprocess.Popen", side_effect=self._convert_input):
                TaskQueue().run([first, second])
            self.assertEqual([first.status, second.status], ["done", "done"])
            self.assertEqual(output.read_bytes(), b"independent converted")
            self.assertEqual(middle.read_bytes(), b"old")

    def test_rename_does_not_create_a_later_source(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "a.mkv"
            destination = Path(directory) / "b.mp4"
            reserved_source = Path(directory) / "b (1).mp4"
            output = Path(directory) / "c.mp4"
            source.write_bytes(b"new")
            destination.write_bytes(b"existing")
            first = convert_task(str(source), str(destination))
            second = convert_task(str(reserved_source), str(output))
            with patch("engine.converter.subprocess.Popen", side_effect=self._convert_input):
                TaskQueue().run([first, second])
            self.assertEqual(first.status, "done")
            self.assertEqual(Path(first.dst_path), Path(directory) / "b (2).mp4")
            self.assertEqual(second.status, "error")
            self.assertFalse(reserved_source.exists())
            self.assertFalse(output.exists())
            self.assertEqual(destination.read_bytes(), b"existing")

    def test_multiple_producers_for_a_later_source_are_rejected_before_any_task(self):
        with tempfile.TemporaryDirectory() as directory:
            middle = Path(directory) / "b.mp4"
            prelude = download_task("https://example.com/video",
                                    DownloadOptions(save_path=str(Path(directory) / "downloads")))
            first = convert_task("a.mkv", str(middle))
            second = convert_task("other.mkv", str(middle))
            dependent = convert_task(str(middle), str(Path(directory) / "c.mp4"))
            with patch("engine.converter.subprocess.Popen") as ffmpeg, \
                    patch.object(q.Downloader, "download_one_with_retry") as download:
                with self.assertRaisesRegex(ValueError, "multiple earlier conversions"):
                    TaskQueue().run([prelude, first, second, dependent])
            ffmpeg.assert_not_called()
            download.assert_not_called()
            self.assertEqual([task.status for task in (prelude, first, second, dependent)],
                             ["pending", "pending", "pending", "pending"])
            self.assertFalse(middle.exists())

    def test_prior_download_with_source_in_output_directory_is_rejected(self):
        for relative in ("clip.mkv", "nested/clip.mkv"):
            with self.subTest(relative=relative), tempfile.TemporaryDirectory() as directory:
                download = download_task("https://example.com/video", DownloadOptions(save_path=directory))
                convert = convert_task(str(Path(directory) / relative), str(Path(directory) / "out.mp4"))
                with patch("engine.converter.subprocess.Popen") as ffmpeg, \
                        patch.object(q.Downloader, "download_one_with_retry") as start_download:
                    with self.assertRaisesRegex(ValueError, "separately"):
                        TaskQueue().run([download, convert])
                ffmpeg.assert_not_called()
                start_download.assert_not_called()
                self.assertEqual([download.status, convert.status], ["pending", "pending"])

    def test_disjoint_directory_and_reverse_order_are_allowed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            download_dir = root / "downloads"
            download_dir.mkdir()
            separate = root / "separate"
            separate.mkdir()
            for source, reverse in ((separate / "first.mkv", False),
                                    (download_dir / "second.mkv", True)):
                with self.subTest(reverse=reverse):
                    source.write_bytes(b"source")
                    download = download_task("https://example.com/video",
                                             DownloadOptions(save_path=str(download_dir)))
                    convert = convert_task(str(source), str(separate / (source.stem + ".mp4")))
                    tasks = [convert, download] if reverse else [download, convert]
                    with patch("engine.converter.subprocess.Popen", side_effect=self._convert_input), \
                            patch.object(q.Downloader, "download_one_with_retry"):
                        TaskQueue().run(tasks)
                    self.assertEqual([task.status for task in tasks], ["done", "done"])

    def test_mixed_path_comparison_handles_relative_alias_and_other_drive(self):
        def absolute(value):
            return ntpath.normpath(value if ntpath.isabs(value) else ntpath.join(r"C:\work", value))

        def resolved(value, *, strict=False):
            value = absolute(value)
            alias = ntpath.normcase(r"C:\alias")
            if ntpath.normcase(value) == alias or ntpath.normcase(value).startswith(alias + "\\"):
                return r"C:\work\downloads" + value[len(alias):]
            return value

        fake_path = SimpleNamespace(abspath=absolute, realpath=resolved, normcase=ntpath.normcase,
                                    isabs=ntpath.isabs, splitdrive=ntpath.splitdrive,
                                    commonpath=ntpath.commonpath)
        with patch.object(q, "os", SimpleNamespace(path=fake_path)):
            contains = TaskQueue._download_may_contain_source
            self.assertTrue(contains("downloads", r"downloads\nested\clip.mkv"))
            self.assertTrue(contains("downloads", r"C:\alias\clip.mkv"))
            self.assertFalse(contains("downloads", r"C:\work\other\clip.mkv"))
            self.assertFalse(contains("downloads", r"D:\downloads\clip.mkv"))
            with self.assertRaisesRegex(ValueError, "separately"):
                contains(None, r"C:\work\clip.mkv")

    def test_mixed_path_comparison_supports_legacy_realpath_and_rejects_broken_links(self):
        def absolute(value):
            return ntpath.normpath(value if ntpath.isabs(value) else ntpath.join(r"C:\work", value))

        unresolved = [False]

        def legacy_realpath(value):
            value = absolute(value)
            alias = ntpath.normcase(r"C:\alias")
            if not unresolved[0] and (ntpath.normcase(value) == alias
                                      or ntpath.normcase(value).startswith(alias + "\\")):
                return r"C:\work\downloads" + value[len(alias):]
            return value

        broken = [False]
        directory_info = SimpleNamespace(st_mode=stat.S_IFDIR, st_file_attributes=0)
        link_info = SimpleNamespace(st_mode=stat.S_IFLNK, st_file_attributes=0)

        def fake_lstat(value):
            if ntpath.basename(value) == "clip.mkv":
                raise FileNotFoundError(value)
            return link_info if ntpath.normcase(value) == r"c:\alias" else directory_info

        def fake_stat(value):
            if broken[0]:
                raise FileNotFoundError(value)
            return directory_info

        fake_path = SimpleNamespace(abspath=absolute, realpath=legacy_realpath, normcase=ntpath.normcase,
                                    isabs=ntpath.isabs, splitdrive=ntpath.splitdrive,
                                    dirname=ntpath.dirname, commonpath=ntpath.commonpath,
                                    samefile=lambda first, second: True)
        fake_os = SimpleNamespace(path=fake_path, lstat=fake_lstat, stat=fake_stat)
        with patch.object(q, "os", fake_os):
            contains = TaskQueue._download_may_contain_source
            self.assertTrue(contains("downloads", r"C:\alias\clip.mkv"))
            self.assertFalse(contains("downloads", r"C:\work\other\clip.mkv"))
            self.assertFalse(contains("downloads", r"D:\downloads\clip.mkv"))
            broken[0] = True
            with self.assertRaisesRegex(ValueError, "separately"):
                contains("downloads", r"C:\alias\clip.mkv")
            broken[0] = False
            unresolved[0] = True
            with self.assertRaisesRegex(ValueError, "separately"):
                contains("downloads", r"C:\alias\clip.mkv")

    def test_skipped_or_failed_predecessor_blocks_dependent_conversion(self):
        for outcome in ("skipped", "failed"):
            with self.subTest(outcome=outcome), tempfile.TemporaryDirectory() as directory:
                source = Path(directory) / "a.mkv"
                middle = Path(directory) / "b.mp4"
                output = Path(directory) / "c.mp4"
                source.write_bytes(b"new")
                policy = "skip" if outcome == "skipped" else "rename"
                first = convert_task(str(source), str(middle), conflict_policy=policy)
                second = convert_task(str(middle), str(output))

                def collide_or_fail(args, **kwargs):
                    middle.write_bytes(b"old")
                    if outcome == "failed":
                        return SimpleNamespace(returncode=1, stderr=["failed"], wait=lambda: 1)
                    Path(args[-1]).write_bytes(b"converted")
                    return SimpleNamespace(returncode=0, stderr=(), wait=lambda: 0)

                with patch("engine.converter.subprocess.Popen", side_effect=collide_or_fail):
                    TaskQueue().run([first, second])
                self.assertEqual(first.status, "skipped" if outcome == "skipped" else "error")
                self.assertEqual(second.status, "skipped")
                self.assertIn("ambiguous", second.error)
                self.assertEqual(middle.read_bytes(), b"old")
                self.assertFalse(output.exists())

    def test_duplicate_destinations_with_overwrite_are_rejected_before_any_task(self):
        for policies in (("rename", "overwrite"), ("overwrite", "rename"),
                         ("overwrite", "overwrite")):
            with self.subTest(policies=policies):
                first = convert_task("a.mkv", "same.mp4", conflict_policy=policies[0])
                second = convert_task("b.mkv", "same.mp4", conflict_policy=policies[1])
                with patch("engine.converter.subprocess.Popen") as ffmpeg:
                    with self.assertRaisesRegex(ValueError, "overwrite"):
                        TaskQueue().run([first, second])
                ffmpeg.assert_not_called()
                self.assertEqual([first.status, second.status], ["pending", "pending"])


if __name__ == "__main__":
    unittest.main()


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
