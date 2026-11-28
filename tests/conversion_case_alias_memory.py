# OpenAI-Codex: simulate the streaming FFmpeg process interface.
"""Memory-only regressions for conversion aliases and concurrent entry.

OpenAI-Codex_engine_cli: the actual converter and queue run against virtual paths,
fake process output, and fake filesystem operations; no media files are used.
"""
from __future__ import annotations

import posixpath
import stat
import sys
import threading
import unicodedata
from pathlib import Path
from types import SimpleNamespace

TESTS = Path(__file__).absolute().parent
sys.path.insert(0, str(TESTS))

from conversion_protected_batch_memory import (  # noqa: E402
    Converter,
    ConvertJob,
    MemoryFiles,
    TaskQueue,
    convert_task,
    converter_module,
    queue_module,
)


class PosixFiles(MemoryFiles):
    def __init__(self, *, insensitive=True):
        self.insensitive = insensitive
        super().__init__()
        self.nodes = {}
        self.dangling_links = set()
        self.directories = {"/", "/in", "/out", "/downloads", "/downloads2"}
        self.source = "/in/clip.wav"
        self.later_source = "/out/CLIP.mp3"
        self._put(self.source, b"original source")

    def _key(self, path):
        value = posixpath.normpath(path)
        # OpenAI-Codex_engine_cli: virtual case-insensitive Unicode lookup.
        if self.insensitive:
            return unicodedata.normalize("NFD", value).casefold()
        return value.casefold() if self.insensitive else value

    def isdir(self, path):
        return self._key(path) in {self._key(p) for p in self.directories}

    def mkstemp(self, *, prefix, suffix, dir):  # noqa: A002
        self.next_temp += 1
        path = posixpath.join(dir, f"{prefix}{self.next_temp}{suffix}")
        self._put(path, b"")
        return self.next_temp, path

    def info(self, path):
        if self.isdir(path):
            return SimpleNamespace(st_mode=stat.S_IFDIR, st_file_attributes=0)
        if self.exists(path):
            return SimpleNamespace(st_mode=stat.S_IFREG, st_file_attributes=0)
        raise FileNotFoundError(path)


class PosixPaths:
    def __init__(self, files):
        self.files = files

    def __getattr__(self, name):
        if name not in {
            "normcase",
            "normpath",
            "isabs",
            "join",
            "basename",
            "dirname",
            "splitext",
            "splitdrive",
            "commonpath",
        }:
            raise AssertionError(f"unmodeled path operation: {name}")
        return getattr(posixpath, name)

    def abspath(self, path):
        return posixpath.normpath(
            path if posixpath.isabs(path) else posixpath.join("/work", path)
        )

    def realpath(self, path, *, strict=False):
        path = self.abspath(path)
        if strict and not self.exists(path):
            raise FileNotFoundError(path)
        return path

    def exists(self, path):
        return self.files.isdir(path) or self.files.exists(path)

    def lexists(self, path):
        return self.exists(path)

    def samefile(self, first, second):
        if not self.exists(first) or not self.exists(second):
            raise FileNotFoundError("virtual path is absent")
        return self.files._key(first) == self.files._key(second)


def setup(*, insensitive=True):
    files = PosixFiles(insensitive=insensitive)
    fake_os = SimpleNamespace(
        path=PosixPaths(files),
        close=files.close,
        link=files.link,
        replace=files.replace,
        unlink=files.unlink,
        lstat=files.info,
        stat=files.info,
    )
    converter_module.os = fake_os
    converter_module.tempfile = SimpleNamespace(mkstemp=files.mkstemp)
    converter_module.subprocess = SimpleNamespace(Popen=files.run, PIPE=-1)
    queue_module.os = fake_os
    return files


def raises_value_error(fn):
    try:
        fn()
    except ValueError:
        return
    raise AssertionError("expected conservative rejection before any conversion")


def direct_missing_case_alias_is_not_created():
    files = setup()
    converter = Converter(save_path="/out", dst_fmt="mp3")
    jobs = converter.convert_batch([files.source, files.later_source])
    assert jobs[0].status == "done", jobs
    assert jobs[0].dst_path == "/out/clip (1).mp3", jobs[0].dst_path
    assert jobs[1].status == "error", jobs[1]
    assert not files.exists(files.later_source), files.publications


def existing_destination_remains_untouched():
    files = setup()
    files._put("/out/CLIP.mp3", b"existing")
    converter = Converter(save_path="/out", dst_fmt="mp3")
    job = converter.convert_batch([files.source])[0]
    assert job.status == "done" and job.dst_path == "/out/clip (1).mp3", job
    assert files.content("/out/CLIP.mp3") == b"existing"


def overwrite_batch_case_alias_rejected():
    files = setup()
    files._put("/in/Clip.wav", b"one")
    files._put("/in/clip.mkv", b"two")
    converter = Converter(save_path="/out", dst_fmt="mp3", conflict_policy="overwrite")
    raises_value_error(
        lambda: converter.convert_batch(["/in/Clip.wav", "/in/clip.mkv"])
    )
    assert not files.publications and not files.reads


def queue_differently_cased_dependency_is_rejected():
    files = setup()
    tasks = [
        convert_task(files.source, "/out/clip.mp3"),
        convert_task("/out/CLIP.mp3", "/out/final.wav"),
    ]
    raises_value_error(lambda: TaskQueue().run(tasks))
    assert not files.publications and not files.reads


def queue_overwrite_case_alias_rejected():
    files = setup()
    tasks = [
        convert_task(files.source, "/out/Clip.mp3"),
        convert_task(files.source, "/out/clip.mp3", conflict_policy="overwrite"),
    ]
    raises_value_error(lambda: TaskQueue().run(tasks))
    assert not files.publications and not files.reads


def queue_exact_intermediate_remains_supported():
    files = setup()
    tasks = [
        convert_task(files.source, "/out/middle.mp3"),
        convert_task("/out/middle.mp3", "/out/final.wav"),
    ]
    done = TaskQueue().run(tasks)
    assert [task.status for task in done] == ["done", "done"], done
    assert files.exists("/out/final.wav")


def preview_marks_case_aliases():
    files = setup()
    files._put("/in/other.wav", b"other")
    converter = Converter(save_path="/out", dst_fmt="mp3")
    jobs = [
        ConvertJob(files.source, "/out/clip.mp3"),
        ConvertJob("/in/other.wav", "/out/CLIP.mp3"),
    ]
    rows = converter.preview_jobs(jobs)
    assert [row["batch_duplicate"] for row in rows] == [True, True], rows


def preview_uncertain_source_is_not_reported_as_no():
    files = setup(insensitive=False)
    files._put("/out/CLIP.mp3", b"source")
    converter = Converter(save_path="/out", dst_fmt="mp3")
    row = converter.preview_jobs([ConvertJob("/out/CLIP.mp3", "/out/clip.mp3")])[0]
    assert row["existing"] == "missing", row
    assert row["source_matches"] == "unknown", row


def queue_download_root_case_alias_is_rejected():
    setup()
    assert TaskQueue._download_may_contain_source(
        "/Downloads", "/downloads/nested/clip.mp3"
    )
    assert not TaskQueue._download_may_contain_source(
        "/Downloads", "/downloads2/clip.mp3"
    )
    assert not TaskQueue._download_may_contain_source(
        "/Downloads", "/elsewhere/clip.mp3"
    )


def concurrent_entry_is_rejected_before_batch_guard():
    files = setup()
    converter = Converter(save_path="/out", dst_fmt="mp3")
    entered = threading.Event()
    release = threading.Event()
    outcomes = []

    class SlowSources:
        def __iter__(self):
            entered.set()
            if not release.wait(5):
                raise AssertionError("virtual barrier timed out")
            yield files.source

    def worker():
        try:
            converter.convert_batch(SlowSources())
        except BaseException as exc:
            outcomes.append(exc)

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()
    if not entered.wait(5):
        release.set()
        thread.join(5)
        raise AssertionError("worker did not reach virtual barrier")
    checks = []
    try:
        for invoke in (
            lambda: converter.convert_batch([files.source]),
            lambda: converter.convert_one(ConvertJob(files.source, "/out/other.mp3")),
        ):
            try:
                invoke()
            except RuntimeError:
                checks.append(True)
            else:
                checks.append(False)
    finally:
        release.set()
        thread.join(5)
    assert not thread.is_alive(), "worker did not finish"
    assert not outcomes, outcomes
    assert checks == [True, True], checks


def callback_failure_releases_operation_guard():
    files = setup()

    def callback(_job):
        raise RuntimeError("virtual callback failure")

    converter = Converter(save_path="/out", dst_fmt="mp3", job_update_cb=callback)
    try:
        converter.convert_batch([files.source])
    except RuntimeError:
        pass
    else:
        raise AssertionError("callback error did not propagate")
    converter.job_update_cb = None
    jobs = converter.convert_batch([files.source])
    assert jobs[0].status == "done", jobs


# OpenAI-Codex_engine_cli: emulate a common decomposed Unicode alias in memory.
def unicode_alias_of_missing_input_is_protected():
    files = setup()
    files._put("/in/café.wav", b"unicode source")
    converter = Converter(save_path="/out", dst_fmt="mp3")
    jobs = converter.convert_batch(["/in/café.wav", "/out/CAFE\u0301.mp3"])
    assert jobs[0].status == "done" and jobs[0].dst_path == "/out/café (1).mp3", jobs
    assert jobs[1].status == "error", jobs[1]
    assert not files.exists("/out/CAFE\u0301.mp3")


# OpenAI-Codex_engine_cli: exercise publication races and failure cleanup in memory.
def destination_created_during_transcode_is_preserved():
    files = setup()
    original_run = files.run

    def competing_run(args, *, stderr, text):
        result = original_run(args, stderr=stderr, text=text)
        files._put("/out/clip.mp3", b"competing output")
        return result

    converter_module.subprocess = SimpleNamespace(Popen=competing_run, PIPE=-1)
    job = Converter(save_path="/out", dst_fmt="mp3").convert_batch([files.source])[0]
    assert job.status == "done" and job.dst_path == "/out/clip (1).mp3", job
    assert files.content("/out/clip.mp3") == b"competing output"


def unavailable_hardlinks_fail_closed():
    files = setup()
    files._put("/out/clip.mp3", b"existing output")

    def no_hardlinks(_source, _destination):
        raise OSError("virtual hard links unavailable")

    converter_module.os.link = no_hardlinks
    job = Converter(save_path="/out", dst_fmt="mp3").convert_batch([files.source])[0]
    assert job.status == "error" and "cannot safely publish" in job.error, job
    assert files.content("/out/clip.mp3") == b"existing output"


def control_exception_releases_operation_guard():
    files = setup()

    def callback(_job):
        raise KeyboardInterrupt("virtual interruption")

    converter = Converter(save_path="/out", dst_fmt="mp3", job_update_cb=callback)
    try:
        converter.convert_batch([files.source])
    except KeyboardInterrupt:
        pass
    else:
        raise AssertionError("control exception did not propagate")
    converter.job_update_cb = None
    jobs = converter.convert_batch([files.source])
    assert jobs[0].status == "done", jobs


# OpenAI-Codex_engine_cli: protect canonical-order aliases in virtual paths.
def canonical_order_names():
    return "\u03b1\u0345\u0301", "\u03b1\u0301\u0345"


def canonical_order_missing_input_is_protected():
    files = setup()
    first, second = canonical_order_names()
    source = "/in/" + first + ".wav"
    missing = "/out/" + second + ".mp3"
    files._put(source, b"canonical source")
    jobs = Converter(save_path="/out", dst_fmt="mp3").convert_batch([source, missing])
    assert (
        jobs[0].status == "done" and jobs[0].dst_path == "/out/" + first + " (1).mp3"
    ), jobs
    assert jobs[1].status == "error", jobs[1]
    assert not files.exists(missing)


def canonical_order_overwrite_batch_rejected():
    files = setup()
    first, second = canonical_order_names()
    source_a, source_b = "/in/" + first + ".wav", "/in/" + second + ".mkv"
    files._put(source_a, b"first")
    files._put(source_b, b"second")
    converter = Converter(save_path="/out", dst_fmt="mp3", conflict_policy="overwrite")
    raises_value_error(lambda: converter.convert_batch([source_a, source_b]))
    assert not files.publications and not files.reads


def canonical_order_queue_dependency_rejected():
    files = setup()
    first, second = canonical_order_names()
    tasks = [
        convert_task(files.source, "/out/" + first + ".mp3"),
        convert_task("/out/" + second + ".mp3", "/out/final.wav"),
    ]
    raises_value_error(lambda: TaskQueue().run(tasks))
    assert not files.publications and not files.reads


def canonical_order_queue_overwrite_rejected():
    files = setup()
    first, second = canonical_order_names()
    tasks = [
        convert_task(files.source, "/out/" + first + ".mp3"),
        convert_task(
            files.source, "/out/" + second + ".mp3", conflict_policy="overwrite"
        ),
    ]
    raises_value_error(lambda: TaskQueue().run(tasks))
    assert not files.publications and not files.reads


def canonical_order_preview_reports_possible_alias():
    files = setup(insensitive=False)
    first, second = canonical_order_names()
    source = "/out/" + second + ".mp3"
    files._put(source, b"source")
    jobs = [
        ConvertJob(source, "/out/" + first + ".mp3"),
        ConvertJob(source, "/out/" + second + ".mp3"),
    ]
    rows = Converter(save_path="/out", dst_fmt="mp3").preview_jobs(jobs)
    assert rows[0]["source_matches"] == "unknown", rows
    assert [row["batch_duplicate"] for row in rows] == [True, True], rows


def canonical_order_download_root_is_detected():
    files = setup()
    first, second = canonical_order_names()
    directory = "/downloads/" + first
    files.directories.add(directory)
    assert TaskQueue._download_may_contain_source(
        directory, "/downloads/" + second + "/nested/clip.mp3"
    )


# OpenAI-Codex_engine_cli: exercise queue preflight before any download starts.
def canonical_order_queue_download_conflict_rejected():
    files = setup()
    first, second = canonical_order_names()
    directory = "/downloads/" + first
    files.directories.add(directory)
    download = queue_module.download_task(
        "https://example.invalid/synthetic",
        queue_module.DownloadOptions(save_path=directory),
    )
    conversion = convert_task(
        "/downloads/" + second + "/nested/clip.mp3", "/out/final.wav"
    )
    tasks = [download, conversion]

    class ForbiddenDownloader:
        def __init__(self, *_args, **_kwargs):
            raise AssertionError("download started before queue preflight completed")

    original_downloader = queue_module.Downloader
    queue_module.Downloader = ForbiddenDownloader
    try:
        raises_value_error(lambda: TaskQueue().run(tasks))
    finally:
        queue_module.Downloader = original_downloader
    assert [task.status for task in tasks] == ["pending", "pending"], tasks
    assert not files.publications and not files.reads


def main():
    checks = (
        direct_missing_case_alias_is_not_created,
        unicode_alias_of_missing_input_is_protected,
        canonical_order_missing_input_is_protected,
        canonical_order_overwrite_batch_rejected,
        canonical_order_queue_dependency_rejected,
        canonical_order_queue_overwrite_rejected,
        canonical_order_preview_reports_possible_alias,
        canonical_order_download_root_is_detected,
        canonical_order_queue_download_conflict_rejected,
        existing_destination_remains_untouched,
        overwrite_batch_case_alias_rejected,
        queue_differently_cased_dependency_is_rejected,
        queue_overwrite_case_alias_rejected,
        queue_exact_intermediate_remains_supported,
        preview_marks_case_aliases,
        preview_uncertain_source_is_not_reported_as_no,
        queue_download_root_case_alias_is_rejected,
        concurrent_entry_is_rejected_before_batch_guard,
        callback_failure_releases_operation_guard,
        destination_created_during_transcode_is_preserved,
        unavailable_hardlinks_fail_closed,
        control_exception_releases_operation_guard,
    )
    failures = []
    for check in checks:
        try:
            check()
        except Exception as exc:
            failures.append((check.__name__, type(exc).__name__, str(exc)))
            print(f"FAIL {check.__name__}: {type(exc).__name__}: {exc}")
        else:
            print(f"PASS {check.__name__}")
    if failures:
        raise SystemExit(f"{len(failures)} memory regression checks failed")
    print(f"All {len(checks)} memory regression checks passed.")


if __name__ == "__main__":
    main()
