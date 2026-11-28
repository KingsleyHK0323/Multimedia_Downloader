# OpenAI-Codex_engine_cli
"""Memory-only checks for one TaskQueue instance's operation guard."""

import ast
from functools import wraps
from pathlib import Path
import threading
from types import SimpleNamespace
import unittest


# OpenAI-Codex_engine_cli: exercise callback exceptions matching cancellation.
class SyntheticCancelled(Exception):
    pass


def _load_queue():
    path = Path(__file__).absolute().parent.parent / "engine" / "queue.py"
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    helper = [
        node for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name == "_exclusive_queue_run"
    ]
    queue_class = [
        node for node in tree.body
        if isinstance(node, ast.ClassDef) and node.name == "TaskQueue"
    ]
    if len(helper) != 1 or len(queue_class) != 1:
        raise AssertionError("queue definitions are missing or ambiguous")

    class FakeConverter:
        @staticmethod
        def _identities(path):
            return {path}

    # OpenAI-Codex_engine_cli: execute the real download task path without I/O.
    class FakeDownloader:
        def __init__(self, _options, log_cb=None):
            self.log_cb = log_cb

        def stop(self):
            pass

        def download_one_with_retry(self, _url, index=1, total=1):
            pass

    def fake_summary(total, succeeded, failed, stopped):
        return {
            "total": total,
            "succeeded": succeeded,
            "failed": failed,
            "skipped": max(0, total - succeeded - failed),
            "cancelled": bool(stopped),
        }

    module = ast.Module(
        body=[
            ast.parse("from __future__ import annotations").body[0],
            helper[0],
            queue_class[0],
        ],
        type_ignores=[],
    )
    ast.fix_missing_locations(module)
    namespace = {
        "__name__": "synthetic_queue",
        "wraps": wraps,
        "Lock": threading.Lock,
        "Converter": FakeConverter,
        "CONVERT": "convert",
        "DOWNLOAD": "download",
        "Downloader": FakeDownloader,
        "OperationCancelled": SyntheticCancelled,
        "ErrorKind": SimpleNamespace(UNKNOWN=SimpleNamespace(value="unknown")),
        "classify": lambda _error: SimpleNamespace(value="unknown"),
        "redact_sensitive_urls": lambda text: text,
        "batch_summary": fake_summary,
    }
    # Execute only definitions extracted from the checked-in queue source.
    exec(compile(module, str(path), "exec"), namespace)  # noqa: S102
    return namespace["TaskQueue"]


def _task(name):
    return SimpleNamespace(
        task_id=name,
        kind="convert",
        src_path="/virtual/" + name,
        dst_path=None,
        status="pending",
        error="",
        error_kind="",
    )


# OpenAI-Codex_engine_cli: use simple fake tasks with the real queue runner.
def _download_task(name):
    return SimpleNamespace(
        task_id=name,
        kind="download",
        url="synthetic-" + name,
        options=object(),
        src_path=None,
        dst_path=None,
        status="pending",
        error="",
        error_kind="",
    )


class ControlSignal(BaseException):
    pass


class QueueOperationGuardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.Queue = _load_queue()

    def _queue(self):
        queue = self.Queue()
        queue._validate_plan = lambda _tasks: None

        def fake_run(task, _index, _total):
            queue._set_status(task, "running")
            queue._set_status(task, "done")

        queue._run_task = fake_run
        return queue

    def test_callback_reentry_cannot_replace_protected_sources(self):
        queue = self._queue()
        outer = _task("outer")
        inner = _task("inner")
        attempts = []
        observed = []

        def callback(task):
            if task is outer and task.status == "running":
                try:
                    queue.run([inner])
                except RuntimeError as exc:
                    attempts.append(str(exc))

        def fake_run(task, _index, _total):
            queue._set_status(task, "running")
            observed.append(tuple(queue._protected_paths))
            queue._set_status(task, "done")

        queue.task_update_cb = callback
        queue._run_task = fake_run
        queue.run([outer])
        self.assertEqual(len(attempts), 1)
        self.assertIn("active", attempts[0])
        self.assertEqual(observed, [(outer.src_path,)])
        self.assertEqual(inner.status, "pending")
        self.assertEqual(outer.status, "done")

    def test_concurrent_run_rejected_while_stop_remains_available(self):
        queue = self._queue()
        outer = _task("outer")
        inner = _task("inner")
        entered = threading.Event()
        release = threading.Event()
        stop_finished = threading.Event()
        failures = []

        def fake_run(task, _index, _total):
            queue._set_status(task, "running")
            if task is outer:
                entered.set()
                if not release.wait(5):
                    raise AssertionError("synthetic barrier timed out")
            queue._set_status(task, "done")

        def worker():
            try:
                queue.run([outer])
            except BaseException as exc:
                failures.append(exc)

        def request_stop():
            try:
                queue.stop()
            except BaseException as exc:
                failures.append(exc)
            finally:
                stop_finished.set()

        queue._run_task = fake_run
        worker_thread = threading.Thread(target=worker, daemon=True)
        stop_thread = None
        worker_thread.start()
        try:
            self.assertTrue(entered.wait(5))
            with self.assertRaisesRegex(RuntimeError, "active"):
                queue.run([inner])
            self.assertEqual(queue._protected_paths, [outer.src_path])
            self.assertEqual(inner.status, "pending")
            stop_thread = threading.Thread(target=request_stop, daemon=True)
            stop_thread.start()
            self.assertTrue(stop_finished.wait(5))
            self.assertTrue(queue._stop)
        finally:
            release.set()
            worker_thread.join(5)
            if stop_thread is not None:
                stop_thread.join(5)
        self.assertFalse(worker_thread.is_alive())
        self.assertFalse(failures, failures)

    def test_guard_released_after_preflight_or_callback_error(self):
        for location in ("preflight", "callback"):
            for error_type in (ValueError, ControlSignal):
                with self.subTest(location=location, error_type=error_type):
                    queue = self._queue()

                    def fail(_value):
                        raise error_type("synthetic failure")

                    if location == "preflight":
                        queue._validate_plan = fail
                    else:
                        queue.task_update_cb = fail
                    with self.assertRaises(error_type):
                        queue.run([_task("first")])
                    queue._validate_plan = lambda _tasks: None
                    queue.task_update_cb = None
                    later = _task("later")
                    queue.run([later])
                    self.assertEqual(later.status, "done")


    # OpenAI-Codex_engine_cli: callback failures clean up without calling back again.
    def test_running_callback_failure_marks_error_and_skips_pending(self):
        for error_type in (RuntimeError, SyntheticCancelled, ControlSignal):
            with self.subTest(error_type=error_type):
                first, current, pending = (_download_task(name) for name in ("first", "current", "pending"))
                failure = error_type("synthetic-private-marker")
                events = []

                def callback(task):
                    events.append((task.task_id, task.status))
                    if task is current and task.status == "running":
                        raise failure

                queue = self.Queue(task_update_cb=callback)
                queue._validate_plan = lambda _tasks: None
                with self.assertRaises(error_type) as caught:
                    queue.run([first, current, pending])
                self.assertIs(caught.exception, failure)
                self.assertEqual([first.status, current.status, pending.status], ["done", "error", "skipped"])
                self.assertEqual(current.error, "Task update callback failed; the task outcome is unknown.")
                self.assertEqual(current.error_kind, "unknown")
                self.assertEqual(queue.last_summary, {
                    "total": 3, "succeeded": 1, "failed": 1, "skipped": 1, "cancelled": False,
                })
                self.assertEqual(events, [("first", "running"), ("first", "done"), ("current", "running")])
                self.assertIsNone(queue._active)
                queue.task_update_cb = None
                later = _download_task("later")
                queue.run([later])
                self.assertEqual(later.status, "done")

    def test_done_callback_failure_keeps_terminal_result_and_skips_pending(self):
        for error_type in (RuntimeError, SyntheticCancelled, ControlSignal):
            with self.subTest(error_type=error_type):
                first, current, pending = (_download_task(name) for name in ("first", "current", "pending"))
                failure = error_type("synthetic-private-marker")
                events = []

                def callback(task):
                    events.append((task.task_id, task.status))
                    if task is current and task.status == "done":
                        raise failure

                queue = self.Queue(task_update_cb=callback)
                queue._validate_plan = lambda _tasks: None
                with self.assertRaises(error_type) as caught:
                    queue.run([first, current, pending])
                self.assertIs(caught.exception, failure)
                self.assertEqual([first.status, current.status, pending.status], ["done", "done", "skipped"])
                self.assertEqual(current.error, "")
                self.assertEqual(queue.last_summary, {
                    "total": 3, "succeeded": 2, "failed": 0, "skipped": 1, "cancelled": False,
                })
                self.assertEqual(events, [
                    ("first", "running"), ("first", "done"),
                    ("current", "running"), ("current", "done"),
                ])
                self.assertIsNone(queue._active)
                queue.task_update_cb = None
                later = _download_task("later")
                queue.run([later])
                self.assertEqual(later.status, "done")


    # OpenAI-Codex_engine_cli: reconcile non-callback exceptions after work begins.
    def test_non_callback_exception_reconciles_started_queue(self):
        for error_type in (ValueError, ControlSignal):
            with self.subTest(error_type=error_type):
                done, failed, skipped, active, pending = [
                    _task(name) for name in ("done", "failed", "skipped", "active", "pending")
                ]
                failure = error_type("synthetic-private-marker")
                events = []
                queue = self._queue()
                queue.task_update_cb = lambda task: events.append((task.task_id, task.status))

                def run_task(task, _index, _total):
                    queue._set_status(task, "running")
                    if task is done:
                        queue._set_status(task, "done")
                    elif task is failed:
                        queue._set_status(task, "error", "earlier synthetic failure")
                    elif task is skipped:
                        queue._set_status(task, "skipped")
                    else:
                        raise failure

                queue._run_task = run_task
                with self.assertRaises(error_type) as caught:
                    queue.run([done, failed, skipped, active, pending])
                self.assertIs(caught.exception, failure)
                self.assertEqual(
                    [task.status for task in (done, failed, skipped, active, pending)],
                    ["done", "error", "skipped", "error", "skipped"],
                )
                self.assertEqual(failed.error, "earlier synthetic failure")
                self.assertEqual(active.error, "Task execution interrupted; the task outcome is unknown.")
                self.assertEqual(active.error_kind, "unknown")
                self.assertEqual(queue.last_summary, {
                    "total": 5, "succeeded": 1, "failed": 2, "skipped": 2, "cancelled": False,
                })
                self.assertFalse(queue._stop)
                self.assertEqual(events, [
                    ("done", "running"), ("done", "done"),
                    ("failed", "running"), ("failed", "error"),
                    ("skipped", "running"), ("skipped", "skipped"),
                    ("active", "running"),
                ])

    def test_non_callback_preflight_exception_keeps_original_state(self):
        queue = self._queue()
        first, second = _task("first"), _task("second")
        old_summary = {"sentinel": "unchanged"}
        queue.last_summary = old_summary
        failure = ValueError("synthetic preflight")

        def fail_preflight(_tasks):
            raise failure

        queue._validate_plan = fail_preflight
        with self.assertRaises(ValueError) as caught:
            queue.run([first, second])
        self.assertIs(caught.exception, failure)
        self.assertEqual([first.status, second.status], ["pending", "pending"])
        self.assertIs(queue.last_summary, old_summary)
        self.assertFalse(queue._stop)

    def test_log_callback_error_after_stop_preserves_cancelled_summary(self):
        first, second = _task("first"), _task("second")
        failure = RuntimeError("synthetic log failure")
        events = []

        def log(_level, key, **_fmt):
            if key == "log_queue_stopped":
                raise failure

        queue = self.Queue(log_cb=log, task_update_cb=lambda task: events.append((task.task_id, task.status)))
        queue.stop()
        with self.assertRaises(RuntimeError) as caught:
            queue.run([first, second])
        self.assertIs(caught.exception, failure)
        self.assertEqual([first.status, second.status], ["skipped", "skipped"])
        self.assertEqual(queue.last_summary, {
            "total": 2, "succeeded": 0, "failed": 0, "skipped": 2, "cancelled": True,
        })
        self.assertEqual(events, [("first", "skipped"), ("second", "skipped")])
        self.assertFalse(queue._stop)

    def test_stop_is_consumed_by_one_run(self):
        # OpenAI-Codex: a stop before entry still applies to the next batch only.
        queue = self._queue()
        queue.stop()
        cancelled, fresh = _task("cancelled"), _task("fresh")
        queue.run([cancelled])
        self.assertEqual(cancelled.status, "skipped")
        self.assertTrue(queue.last_summary["cancelled"])
        queue.run([fresh])
        self.assertEqual(fresh.status, "done")
        self.assertFalse(queue.last_summary["cancelled"])

    def test_downloader_constructor_error_reconciles_real_task_path(self):
        for error_type in (RuntimeError, ControlSignal):
            with self.subTest(error_type=error_type):
                first, active, pending = (_download_task(name) for name in ("first", "active", "pending"))
                trigger = object()
                active.options = trigger
                failure = error_type("synthetic-private-marker")
                events = []
                queue = self.Queue(task_update_cb=lambda task: events.append((task.task_id, task.status)))
                queue._validate_plan = lambda _tasks: None
                namespace = self.Queue._run_task.__globals__
                old_downloader = namespace["Downloader"]

                class FailingDownloader(old_downloader):
                    def __init__(self, options, log_cb=None):
                        if options is trigger:
                            raise failure
                        super().__init__(options, log_cb=log_cb)

                try:
                    namespace["Downloader"] = FailingDownloader
                    with self.assertRaises(error_type) as caught:
                        queue.run([first, active, pending])
                finally:
                    namespace["Downloader"] = old_downloader
                self.assertIs(caught.exception, failure)
                self.assertEqual([first.status, active.status, pending.status], ["done", "error", "skipped"])
                self.assertEqual(active.error, "Task execution interrupted; the task outcome is unknown.")
                self.assertEqual(queue.last_summary, {
                    "total": 3, "succeeded": 1, "failed": 1, "skipped": 1, "cancelled": False,
                })
                self.assertEqual(events, [("first", "running"), ("first", "done"), ("active", "running")])
                self.assertIsNone(queue._active)

if __name__ == "__main__":
    unittest.main()
