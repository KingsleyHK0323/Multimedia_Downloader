# OpenAI-Codex: simulate the streaming FFmpeg process interface.
"""Memory-only regression checks for protected batch and queue inputs.

OpenAI-Codex_engine_cli: the converter and queue are real; paths, files,
temporary outputs, process execution, publication, and network are substitutes.
"""

from __future__ import annotations

import ntpath
from pathlib import Path
import socket
import sys
from types import ModuleType, SimpleNamespace


ROOT = Path(__file__).absolute().parent.parent
sys.path.insert(0, str(ROOT))
sys.modules["yt_dlp"] = ModuleType("yt_dlp")


def _network_forbidden(*_args, **_kwargs):
    raise AssertionError("network access is not permitted in this synthetic check")


socket.socket = _network_forbidden
socket.create_connection = _network_forbidden

import engine.converter as converter_module  # noqa: E402
import engine.queue as queue_module  # noqa: E402
from engine.converter import Converter  # noqa: E402
from engine.options import ConvertJob  # noqa: E402
from engine.queue import TaskQueue, convert_task  # noqa: E402


class MemoryPaths:
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
        return getattr(ntpath, name)

    def abspath(self, path):
        return ntpath.normpath(
            path if ntpath.isabs(path) else ntpath.join("C:\\virtual", path)
        )

    def realpath(self, path):
        return self.abspath(path)

    def exists(self, path):
        return self.files.exists(path)

    def lexists(self, path):
        if self.files.is_dangling(path):
            return True
        return self.files.exists(path)

    # OpenAI-Codex_engine_cli: simulate same-file checks without real files.
    def samefile(self, first, second):
        if not self.exists(first) or not self.exists(second):
            raise FileNotFoundError("synthetic path is missing")
        return self.files._key(first) == self.files._key(second)


class MemoryFiles:
    def __init__(self):
        self.nodes = {}
        self.dangling_links = set()
        self.next_temp = 0
        self.publications = []
        self.reads = []
        self.fd_closes = []
        self.source = "C:\\virtual\\clip.wav"
        self.later_source = "C:\\virtual\\clip.mp3"
        self._put(self.source, b"synthetic source")

    @staticmethod
    def _key(path):
        return ntpath.normcase(ntpath.normpath(path))

    def _put(self, path, content):
        self.nodes[self._key(path)] = {"exists": True, "content": content}

    def exists(self, path):
        node = self.nodes.get(self._key(path))
        return bool(node and node["exists"])

    def add_dangling(self, path):
        self.dangling_links.add(self._key(path))

    def is_dangling(self, path):
        return self._key(path) in self.dangling_links

    def content(self, path):
        if not self.exists(path):
            raise FileNotFoundError(path)
        return self.nodes[self._key(path)]["content"]

    def mkstemp(self, *, prefix, suffix, dir):  # noqa: A002
        self.next_temp += 1
        path = ntpath.join(dir, f"{prefix}{self.next_temp}{suffix}")
        self._put(path, b"")
        return self.next_temp, path

    def close(self, fd):
        self.fd_closes.append(fd)

    def run(self, args, *, stderr, text):
        assert stderr == -1 and text is True
        source, temporary = args[3], args[-1]
        self.reads.append(source)
        if not self.exists(source):
            return SimpleNamespace(
                returncode=1, stderr=["synthetic source is missing"], wait=lambda: 1
            )
        self._put(temporary, b"converted:" + self.content(source))
        return SimpleNamespace(returncode=0, stderr=(), wait=lambda: 0)

    def link(self, source, destination):
        if self.is_dangling(destination):
            raise FileExistsError(destination)
        if self.exists(destination):
            raise FileExistsError(destination)
        self._put(destination, self.content(source))
        self.publications.append(("link", destination))

    def replace(self, source, destination):
        self._put(destination, self.content(source))
        self.nodes[self._key(source)]["exists"] = False
        self.publications.append(("replace", destination))

    def unlink(self, path):
        if not self.exists(path):
            raise FileNotFoundError(path)
        self.nodes[self._key(path)]["exists"] = False


def setup():
    files = MemoryFiles()
    fake_os = SimpleNamespace(
        path=MemoryPaths(files),
        close=files.close,
        link=files.link,
        replace=files.replace,
        unlink=files.unlink,
    )
    converter_module.os = fake_os
    converter_module.tempfile = SimpleNamespace(mkstemp=files.mkstemp)
    converter_module.subprocess = SimpleNamespace(Popen=files.run, PIPE=-1)
    queue_module.os = fake_os
    return files


def direct_rename_protects_missing_later_input():
    files = setup()
    converter = Converter(
        save_path="C:\\virtual", dst_fmt="mp3", conflict_policy="rename"
    )
    jobs = converter.convert_batch([files.source, files.later_source])
    assert jobs[0].status == "done", (jobs[0].status, jobs[0].error)
    assert converter_module.os.path.normcase(
        jobs[0].dst_path
    ) != converter_module.os.path.normcase(
        files.later_source
    ), f"first job used the protected later source: {jobs[0].dst_path}"
    assert not files.exists(files.later_source), "the missing later source was created"
    assert all(
        converter_module.os.path.normcase(path)
        != converter_module.os.path.normcase(files.later_source)
        for _, path in files.publications
    ), f"protected later source was published: {files.publications}"
    assert jobs[1].status == "error", (jobs[1].status, jobs[1].error)


def direct_skip_protects_missing_later_input():
    files = setup()
    converter = Converter(
        save_path="C:\\virtual", dst_fmt="mp3", conflict_policy="skip"
    )
    jobs = converter.convert_batch([files.source, files.later_source])
    assert jobs[0].status == "skipped", (
        f"first job should skip the protected later source; got {jobs[0].status}, "
        f"publications={files.publications}"
    )
    assert not files.exists(files.later_source), "the missing later source was created"
    assert all(
        converter_module.os.path.normcase(path)
        != converter_module.os.path.normcase(files.later_source)
        for _, path in files.publications
    )


def direct_overwrite_rejected_before_execution():
    files = setup()
    converter = Converter(
        save_path="C:\\virtual", dst_fmt="mp3", conflict_policy="overwrite"
    )
    try:
        converter.convert_batch([files.source, files.later_source])
    except ValueError as exc:
        assert "overwrite" in str(exc).lower()
    else:
        raise AssertionError("duplicate overwrite destinations were not rejected")
    assert not files.reads and not files.publications
    assert not files.exists(files.later_source)


def direct_overwrite_rejects_external_protected_missing_destination():
    files = setup()
    converter = Converter(
        save_path="C:\\virtual",
        dst_fmt="mp3",
        conflict_policy="overwrite",
        protected_paths=[files.later_source],
    )
    try:
        jobs = converter.convert_batch([files.source])
    except ValueError:
        assert not files.exists(files.later_source)
        pass
    else:
        assert jobs[0].status == "error", (
            f"protected missing destination should be rejected; got {jobs[0].status}, "
            f"publications={files.publications}"
        )
    assert not files.exists(
        files.later_source
    ), "the externally protected path was created"


def reused_converter_does_not_protect_a_previous_missing_source():
    files = setup()
    converter = Converter(
        save_path="C:\\virtual", dst_fmt="mp3", conflict_policy="rename"
    )
    previous_source = "C:\\virtual\\clip (1).mp3"
    first = converter.convert_batch([previous_source])
    assert first[0].status == "error" and not files.exists(previous_source)
    files._put(files.later_source, b"preexisting")
    second = converter.convert_batch([files.source])
    assert second[0].status == "done", (second[0].status, second[0].error)
    assert converter_module.os.path.normcase(
        second[0].dst_path
    ) == converter_module.os.path.normcase(
        previous_source
    ), f"an earlier batch incorrectly reserved a free name: {second[0].dst_path}"
    assert files.content(files.later_source) == b"preexisting"


def callback_exception_restores_batch_guard():
    files = setup()

    def raise_callback(_job):
        raise RuntimeError("synthetic callback failure")

    converter = Converter(
        save_path="C:\\virtual",
        dst_fmt="mp3",
        conflict_policy="rename",
        job_update_cb=raise_callback,
    )
    try:
        converter.convert_batch([files.source, files.later_source])
    except RuntimeError as exc:
        assert str(exc) == "synthetic callback failure"
    else:
        raise AssertionError("synthetic callback did not fail")
    converter.job_update_cb = None
    job = ConvertJob(src_path=files.source, dst_path=files.later_source)
    converter.convert_one(job)
    assert job.status == "done", (job.status, job.error)
    assert files.exists(files.later_source)


def queue_declared_dependency_remains_supported():
    for policy in ("rename", "skip", "overwrite"):
        files = setup()
        final = "C:\\virtual\\result.wav"
        tasks = [
            convert_task(files.source, files.later_source, conflict_policy=policy),
            convert_task(files.later_source, final, conflict_policy=policy),
        ]
        queue = TaskQueue()
        queue.run(tasks)
        assert [task.status for task in tasks] == ["done", "done"], (
            policy,
            [(task.status, task.error) for task in tasks],
        )
        assert files.content(final) == b"converted:converted:synthetic source", policy
        assert queue.last_summary == {
            "total": 2,
            "succeeded": 2,
            "failed": 0,
            "skipped": 0,
            "cancelled": False,
        }


def direct_skip_missing_later_source_reports_error():
    files = setup()
    converter = Converter(
        save_path="C:\\virtual", dst_fmt="mp3", conflict_policy="skip"
    )
    jobs = converter.convert_batch([files.source, files.later_source])
    assert jobs[1].status == "error", (
        f"the originally missing later source must report error; got {jobs[1].status}, "
        f"publications={files.publications}"
    )


def direct_skip_missing_same_format_source_reports_error():
    files = setup()
    converter = Converter(
        save_path="C:\\virtual", dst_fmt="mp3", conflict_policy="skip"
    )
    jobs = converter.convert_batch([files.later_source])
    assert (
        jobs[0].status == "error"
    ), f"a missing same-format source must report error; got {jobs[0].status}"
    assert not files.exists(files.later_source)


def direct_skip_missing_source_and_missing_protected_destination_reports_error():
    files = setup()
    source = "C:\\virtual\\missing.wav"
    protected_source = "C:\\virtual\\missing.mp3"
    converter = Converter(
        save_path="C:\\virtual", dst_fmt="mp3", conflict_policy="skip"
    )
    jobs = converter.convert_batch([source, protected_source])
    assert jobs[0].status == "error", (
        f"the missing first source must report error, not {jobs[0].status}; "
        f"publications={files.publications}"
    )
    assert jobs[1].status == "error", (jobs[1].status, jobs[1].error)
    assert not files.exists(source) and not files.exists(protected_source)


def callback_reentry_is_rejected(kind):
    files = setup()
    state = {"attempted": False, "error": None}
    converter = Converter(
        save_path="C:\\virtual", dst_fmt="mp3", conflict_policy="rename"
    )

    def callback(job):
        if state["attempted"] or job.status != "converting":
            return
        state["attempted"] = True
        try:
            if kind == "nested_batch":
                converter.convert_batch([files.source])
            elif kind == "different_job":
                converter.convert_one(
                    ConvertJob(src_path=files.source, dst_path=files.later_source)
                )
            elif kind == "same_job":
                converter.convert_one(job)
            else:
                raise AssertionError(f"unknown synthetic reentry: {kind}")
        except RuntimeError as exc:
            state["error"] = str(exc)

    converter.job_update_cb = callback
    converter.convert_batch([files.source, files.later_source])
    assert state["attempted"], f"the {kind} callback did not attempt reentry"
    assert state["error"], (
        f"{kind} reentry did not raise a descriptive RuntimeError; "
        f"protected_created={files.exists(files.later_source)}, publications={files.publications}"
    )
    assert not files.exists(
        files.later_source
    ), f"{kind} created the outer protected input"
    assert all(
        converter_module.os.path.normcase(path)
        != converter_module.os.path.normcase(files.later_source)
        for _, path in files.publications
    ), f"{kind} published the outer protected input"


def legacy_publish_override_delegating_to_super_preserves_batch_guard():
    files = setup()

    class LegacyConverter(Converter):
        def _publish(self, temporary, desired, protected):
            return super()._publish(temporary, desired, protected)

    converter = LegacyConverter(
        save_path="C:\\virtual", dst_fmt="mp3", conflict_policy="rename"
    )
    jobs = converter.convert_batch([files.source, files.later_source])
    assert (
        jobs[0].status == "done"
    ), f"legacy three-argument override should remain usable: {jobs[0].status}, {jobs[0].error}"
    assert converter_module.os.path.normcase(
        jobs[0].dst_path
    ) != converter_module.os.path.normcase(files.later_source)
    assert not files.exists(files.later_source)
    assert jobs[1].status == "error", (jobs[1].status, jobs[1].error)


def direct_skip_dangling_source_reports_error():
    files = setup()
    source = "C:\\virtual\\broken.wav"
    protected_source = "C:\\virtual\\broken.mp3"
    files.add_dangling(source)
    assert converter_module.os.path.lexists(source)
    assert not converter_module.os.path.exists(source)
    converter = Converter(
        save_path="C:\\virtual", dst_fmt="mp3", conflict_policy="skip"
    )
    jobs = converter.convert_batch([source, protected_source])
    assert jobs[0].status == "error", (
        f"a dangling source must report error, not {jobs[0].status}; "
        f"fake reads={files.reads}, publications={files.publications}"
    )
    assert converter_module.os.path.lexists(source)
    assert not converter_module.os.path.exists(source)
    assert not files.exists(protected_source)


# OpenAI-Codex_engine_cli: existing file aliases make dependencies ambiguous.
def queue_existing_file_aliases_rejected_before_work():
    scenarios = (
        ("rename", True),
        ("skip", True),
        ("rename", False),
        ("overwrite", True),
    )
    for policy, source_present in scenarios:
        files = setup()
        destination = "C:\\virtual\\middle.mp3"
        alias = "C:\\virtual\\alias.mp3"
        files._put(destination, b"old destination")
        files._put(alias, b"old alias")
        source = files.source if source_present else "C:\\virtual\\absent.wav"
        tasks = [
            convert_task(source, destination, conflict_policy=policy),
            convert_task(alias, "C:\\virtual\\final.wav"),
        ]
        paths = queue_module.os.path
        original_samefile = paths.samefile

        def fake_samefile(first, second):
            pair = {ntpath.normcase(first), ntpath.normcase(second)}
            if pair == {ntpath.normcase(alias), ntpath.normcase(destination)}:
                return True
            return original_samefile(first, second)

        paths.samefile = fake_samefile
        try:
            try:
                TaskQueue().run(tasks)
            except ValueError as exc:
                assert "ambiguous dependency" in str(exc), str(exc)
            else:
                raise AssertionError("existing file aliases were not rejected")
        finally:
            paths.samefile = original_samefile
        assert [task.status for task in tasks] == ["pending", "pending"], tasks
        assert not files.reads and not files.publications
        assert files.content(destination) == b"old destination"
        assert files.content(alias) == b"old alias"


def queue_missing_intermediate_remains_supported():
    files = setup()
    middle = "C:\\virtual\\middle.mp3"
    final = "C:\\virtual\\final.wav"
    tasks = [convert_task(files.source, middle), convert_task(middle, final)]
    paths = queue_module.os.path
    original_samefile = paths.samefile
    comparisons = []

    def observed_samefile(first, second):
        comparisons.append((first, second))
        return original_samefile(first, second)

    paths.samefile = observed_samefile
    try:
        TaskQueue().run(tasks)
    finally:
        paths.samefile = original_samefile
    assert comparisons, "existing-file alias preflight did not run"
    assert [task.status for task in tasks] == ["done", "done"], tasks
    assert files.exists(final)


def queue_distinct_existing_paths_remain_supported():
    files = setup()
    destination = "C:\\virtual\\middle.mp3"
    independent = "C:\\virtual\\independent.mp3"
    files._put(destination, b"existing output")
    files._put(independent, b"independent source")
    tasks = [
        convert_task(files.source, destination),
        convert_task(independent, "C:\\virtual\\final.wav"),
    ]
    TaskQueue().run(tasks)
    assert [task.status for task in tasks] == ["done", "done"], tasks
    assert files.content(destination) == b"existing output"
    assert files.content(independent) == b"independent source"


def queue_alias_query_errors_fail_closed():
    for error_type in (
        PermissionError,
        OSError,
        ValueError,
        TypeError,
        AttributeError,
        NotImplementedError,
    ):
        files = setup()
        tasks = [
            convert_task(files.source, "C:\\virtual\\middle.mp3"),
            convert_task("C:\\virtual\\independent.mp3", "C:\\virtual\\final.wav"),
        ]
        paths = queue_module.os.path
        original_samefile = paths.samefile

        def denied(_first, _second):
            raise error_type("synthetic private path")

        paths.samefile = denied
        try:
            try:
                TaskQueue().run(tasks)
            except ValueError as exc:
                assert "cannot safely determine" in str(exc), str(exc)
                assert "synthetic private path" not in str(exc)
            else:
                raise AssertionError("an uncertain alias query was not rejected")
        finally:
            paths.samefile = original_samefile
        assert [task.status for task in tasks] == ["pending", "pending"], tasks
        assert not files.reads and not files.publications


def main():
    checks = (
        (
            "queue existing aliases reject before work",
            queue_existing_file_aliases_rejected_before_work,
        ),
        (
            "queue missing intermediate remains supported",
            queue_missing_intermediate_remains_supported,
        ),
        (
            "queue distinct existing paths remain supported",
            queue_distinct_existing_paths_remain_supported,
        ),
        ("queue alias query errors fail closed", queue_alias_query_errors_fail_closed),
        (
            "direct rename protects missing later input",
            direct_rename_protects_missing_later_input,
        ),
        (
            "direct skip protects missing later input",
            direct_skip_protects_missing_later_input,
        ),
        (
            "direct skip reports missing later source",
            direct_skip_missing_later_source_reports_error,
        ),
        (
            "direct skip reports missing same-format source",
            direct_skip_missing_same_format_source_reports_error,
        ),
        (
            "direct skip reports missing first and protected sources",
            direct_skip_missing_source_and_missing_protected_destination_reports_error,
        ),
        (
            "direct skip reports dangling source",
            direct_skip_dangling_source_reports_error,
        ),
        (
            "direct overwrite rejects duplicates",
            direct_overwrite_rejected_before_execution,
        ),
        (
            "direct overwrite rejects external protected input",
            direct_overwrite_rejects_external_protected_missing_destination,
        ),
        (
            "reused converter forgets previous batch inputs",
            reused_converter_does_not_protect_a_previous_missing_source,
        ),
        (
            "callback exception restores batch guard",
            callback_exception_restores_batch_guard,
        ),
        (
            "callback rejects nested batch",
            lambda: callback_reentry_is_rejected("nested_batch"),
        ),
        (
            "callback rejects a different job",
            lambda: callback_reentry_is_rejected("different_job"),
        ),
        (
            "callback rejects the same job",
            lambda: callback_reentry_is_rejected("same_job"),
        ),
        (
            "legacy publish override delegates safely",
            legacy_publish_override_delegating_to_super_preserves_batch_guard,
        ),
        (
            "queue preserves declared dependencies",
            queue_declared_dependency_remains_supported,
        ),
    )
    failures = []
    for name, check in checks:
        try:
            check()
        except Exception as exc:
            failures.append(name)
            print(f"FAIL {name}: {type(exc).__name__}: {exc}")
        else:
            print(f"PASS {name}")
    if failures:
        print(f"{len(failures)} protected-input regression check(s) failed.")
        raise SystemExit(1)
    print("All protected-input memory checks passed.")


if __name__ == "__main__":
    main()
