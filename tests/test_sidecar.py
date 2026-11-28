import io
import json
from contextlib import redirect_stdout
import yt_dlp
from yt_dlp.downloader.common import FileDownloader
import os
import threading
import unittest
import uuid
from types import SimpleNamespace
from unittest.mock import patch

import _path  # noqa: F401
import engine_sidecar as sc


class DispatchPureTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.side = sc.Sidecar(self.events.append)

    def test_ping(self):
        r = self.side.dispatch({"id": "1", "cmd": "ping"})
        self.assertEqual(r, {"id": "1", "ok": True, "result": {"pong": True}})

    def test_formats(self):
        r = self.side.dispatch({"id": "2", "cmd": "formats"})
        self.assertTrue(r["ok"])
        self.assertIn("mp4", r["result"]["video"])
        self.assertIn("mp3", r["result"]["audio"])
        self.assertIn("best", r["result"]["quality"])

    def test_locales(self):
        r = self.side.dispatch({"id": "3", "cmd": "locales"})
        self.assertEqual(set(r["result"]["available"]), {"en", "zh_tw", "zh_cn"})

    def test_strings(self):
        r = self.side.dispatch({"id": "4", "cmd": "strings", "args": {"lang": "zh_tw"}})
        self.assertEqual(r["result"]["strings"]["app_title"], "多媒體下載器")

    def test_unknown_cmd(self):
        r = self.side.dispatch({"id": "5", "cmd": "frobnicate"})
        self.assertFalse(r["ok"])
        self.assertIn("unknown cmd", r["error"])

    def test_exception_becomes_error_response(self):
        # download with missing 'options' key -> KeyError -> ok:false
        r = self.side.dispatch({"id": "6", "cmd": "download", "args": {"urls": []}})
        self.assertFalse(r["ok"])

    def test_download_task_bitrate(self):
        for options, expected in (
            ({"save_path": "out", "bitrate": "320"}, "320"),
            ({"save_path": "out"}, "192"),
        ):
            task = sc.Sidecar._task_from_dict(
                {"kind": "download", "url": "u", "options": options}
            )
            self.assertEqual(task.options.bitrate, expected)


class _FakeDownloader:
    def __init__(self, options, log_cb=None, progress_cb=None, item_start_cb=None):
        self.log_cb = log_cb

    def download_batch(self, urls):
        urls = list(urls)
        if self.log_cb:
            self.log_cb("info", "log_start_batch", n=len(urls))
        return [(u, True, "") for u in urls]


class RoutingTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.side = sc.Sidecar(self.events.append)
        self._orig = sc.Downloader
        sc.Downloader = _FakeDownloader

    def tearDown(self):
        sc.Downloader = self._orig

    def test_download_routes_and_streams_log(self):
        r = self.side.dispatch(
            {
                "id": "d1",
                "cmd": "download",
                "args": {"urls": ["u1", "u2"], "options": {"save_path": "out"}},
            }
        )
        self.assertTrue(r["ok"])
        self.assertEqual(r["result"]["results"], [["u1", True, ""], ["u2", True, ""]])
        # results must be JSON arrays (lists), not tuples
        self.assertIsInstance(r["result"]["results"][0], list)
        # a log event was emitted during the op
        self.assertTrue(
            any(
                e.get("type") == "log" and e["key"] == "log_start_batch"
                for e in self.events
            )
        )

    def test_stop_calls_active_stop(self):
        # simulate an active op exposing .stop()
        class Active:
            stopped = False

            def stop(self):
                Active.stopped = True

        self.side._active = Active()
        self.side._current_command = "download"
        r = self.side.dispatch({"id": "s1", "cmd": "stop"})
        self.assertTrue(r["result"]["stopping"])
        self.assertTrue(self.side._active.stopped)

    def test_desktop_cookie_absolute_or_empty_is_forwarded(self):
        import os

        with patch.object(sc, "Downloader") as downloader:
            downloader.return_value.download_batch.return_value = []
            for value in (os.path.abspath("cookies.txt"), "", None):
                with self.subTest(value=value):
                    result = self.side.dispatch(
                        {
                            "id": "d",
                            "cmd": "download",
                            "args": {
                                "urls": [],
                                "options": {"save_path": "out", "cookie_file": value},
                                "require_absolute_cookie_path": True,
                            },
                        }
                    )
                    self.assertTrue(result["ok"])
                    self.assertEqual(downloader.call_args.args[0].cookie_file, value)

    def test_desktop_cookie_path_rejected_before_download(self):
        with patch.object(sc, "Downloader") as downloader:
            for value in ("relative.txt", "bad\x00path", 42):
                with self.subTest(value=value):
                    result = self.side.dispatch(
                        {
                            "id": "d",
                            "cmd": "download",
                            "args": {
                                "urls": [],
                                "options": {"save_path": "out", "cookie_file": value},
                                "require_absolute_cookie_path": True,
                            },
                        }
                    )
                    self.assertFalse(result["ok"])
            downloader.assert_not_called()

    def test_legacy_download_can_use_relative_cookie_and_save_paths(self):
        with patch.object(sc, "Downloader") as downloader:
            downloader.return_value.download_batch.return_value = []
            result = self.side.dispatch(
                {
                    "id": "d",
                    "cmd": "download",
                    "args": {
                        "urls": [],
                        "options": {
                            "save_path": "relative-output",
                            "cookie_file": "relative.txt",
                        },
                    },
                }
            )
            self.assertTrue(result["ok"])
            options = downloader.call_args.args[0]
            self.assertEqual(options.save_path, "relative-output")
            self.assertEqual(options.cookie_file, "relative.txt")


class _FakeOrchestrator:
    """Stand-in for ai.Orchestrator — never touches the network."""

    fail = False

    def __init__(self, api_key, log_cb=None, transport=None):
        assert api_key, "api_key must be forwarded"
        self.log_cb = log_cb

    def plan(self, prompt, context=None):
        if self.log_cb:
            self.log_cb("ok", "log_ai_plan_ready", n=1)
        if _FakeOrchestrator.fail:
            raise sc.OrchestratorError("boom")
        return {"summary": f"plan for {prompt}", "tasks": [], "warnings": []}

    def summarize(self, results):
        if _FakeOrchestrator.fail:
            raise sc.OrchestratorError("boom")
        return f"summary of {len(results)} result(s)"


class AiRoutingTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.side = sc.Sidecar(self.events.append)
        self._orig = sc.Orchestrator
        sc.Orchestrator = _FakeOrchestrator
        _FakeOrchestrator.fail = False

    def tearDown(self):
        sc.Orchestrator = self._orig

    def test_ai_plan_routes(self):
        r = self.side.dispatch(
            {
                "id": "p1",
                "cmd": "ai_plan",
                "args": {"api_key": "k", "prompt": "download that video"},
            }
        )
        self.assertTrue(r["ok"])
        self.assertEqual(r["result"]["summary"], "plan for download that video")
        self.assertTrue(
            any(
                e.get("type") == "log" and e["key"] == "log_ai_plan_ready"
                for e in self.events
            )
        )

    def test_ai_plan_error_emits_log_and_fails(self):
        _FakeOrchestrator.fail = True
        r = self.side.dispatch(
            {
                "id": "p2",
                "cmd": "ai_plan",
                "args": {"api_key": "k", "prompt": "x"},
            }
        )
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"], "boom")
        self.assertTrue(
            any(
                e.get("type") == "log" and e["key"] == "log_ai_plan_error"
                for e in self.events
            )
        )

    def test_ai_summarize_routes(self):
        r = self.side.dispatch(
            {
                "id": "s1",
                "cmd": "ai_summarize",
                "args": {
                    "api_key": "k",
                    "results": [{"status": "done"}, {"status": "error"}],
                },
            }
        )
        self.assertTrue(r["ok"])
        self.assertEqual(r["result"]["text"], "summary of 2 result(s)")


class OperationLifecycleTests(unittest.TestCase):
    """Exercise operation ownership without media, files, or network access."""

    def test_overlapping_operation_is_rejected_but_stop_remains_available(self):
        started = threading.Event()
        finish = threading.Event()

        class BlockingDownloader:
            def __init__(self, options, **callbacks):
                self.stopped = False
                self.last_summary = {
                    "total": 1,
                    "succeeded": 0,
                    "failed": 0,
                    "skipped": 1,
                    "cancelled": True,
                }

            def download_batch(self, urls):
                started.set()
                if not finish.wait(2):
                    raise RuntimeError("test did not release the operation")
                return []

            def stop(self):
                self.stopped = True
                finish.set()

        side = sc.Sidecar(lambda event: None)
        original = sc.Downloader
        sc.Downloader = BlockingDownloader
        first = []
        worker = threading.Thread(
            target=lambda: first.append(
                side.dispatch(
                    {
                        "id": "first",
                        "cmd": "download",
                        "args": {
                            "urls": ["https://example.invalid/a"],
                            "options": {"save_path": "out"},
                        },
                    }
                )
            )
        )
        try:
            worker.start()
            self.assertTrue(started.wait(2))
            second = side.dispatch(
                {
                    "id": "second",
                    "cmd": "download",
                    "args": {"urls": [], "options": {"save_path": "out"}},
                }
            )
            self.assertFalse(second["ok"])
            self.assertEqual(second.get("error_code"), "busy")
            stopped = side.dispatch({"id": "stop", "cmd": "stop"})
            self.assertTrue(stopped["result"]["stopping"])
            worker.join(2)
            self.assertFalse(worker.is_alive())
            self.assertTrue(first[0]["result"]["summary"]["cancelled"])
        finally:
            finish.set()
            worker.join(2)
            sc.Downloader = original

    def test_queue_events_and_results_preserve_distinct_task_ids(self):
        events = []
        side = sc.Sidecar(events.append)
        result = side.dispatch(
            {
                "id": "queue",
                "cmd": "run_queue",
                "args": {
                    "tasks": [
                        {"task_id": "one", "kind": "unknown", "label": "same"},
                        {"task_id": "two", "kind": "unknown", "label": "same"},
                    ]
                },
            }
        )
        self.assertTrue(result["ok"])
        self.assertEqual(
            [task["task_id"] for task in result["result"]["tasks"]], ["one", "two"]
        )
        updates = [event for event in events if event.get("type") == "task_update"]
        self.assertEqual({event["task_id"] for event in updates}, {"one", "two"})

    def test_stop_requested_before_downloader_is_active_is_preserved(self):
        side = sc.Sidecar(lambda event: None)

        class StartingDownloader:
            def __init__(self, options, **callbacks):
                self.stopped = False
                self.last_summary = {
                    "total": 1,
                    "succeeded": 0,
                    "failed": 0,
                    "skipped": 1,
                    "cancelled": True,
                }
                response = side.dispatch({"id": "stop", "cmd": "stop"})
                assert response["result"]["stopping"]

            def stop(self):
                self.stopped = True

            def download_batch(self, urls):
                if not self.stopped:
                    raise AssertionError("early cancellation was lost")
                return []

        original = sc.Downloader
        sc.Downloader = StartingDownloader
        try:
            result = side.dispatch(
                {
                    "id": "download",
                    "cmd": "download",
                    "args": {
                        "urls": ["https://example.invalid/a"],
                        "options": {"save_path": "out"},
                    },
                }
            )
            self.assertTrue(result["ok"], result)
            self.assertTrue(result["result"]["summary"]["cancelled"])
        finally:
            sc.Downloader = original


class ReservationTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.side = sc.Sidecar(self.events.append)
        self.actions = []
        self.callbacks = []
        actions, callbacks = self.actions, self.callbacks

        class MemoryDownloader:
            def __init__(self, options, **registered):
                self.stopped = False
                self.registered = registered
                callbacks.append(registered)
                self.last_summary = {}

            def stop(self):
                self.stopped = True

            def download_batch(self, urls):
                urls = list(urls)
                if not self.stopped:
                    actions.append("media")
                    self.registered["log_cb"]("info", "started")
                    self.registered["progress_cb"](12, "speed", "eta")
                    self.registered["item_start_cb"](1, len(urls), "url")
                self.last_summary = {
                    "total": len(urls),
                    "succeeded": 0,
                    "failed": 0,
                    "skipped": len(urls),
                    "cancelled": self.stopped,
                }
                return []

        self.downloader = patch.object(sc, "Downloader", MemoryDownloader)
        self.downloader.start()
        self.addCleanup(self.downloader.stop)

    def prepare(self, command="download"):
        response = self.side.dispatch({"cmd": "prepare", "args": {"command": command}})
        self.assertTrue(response["ok"], response)
        self.assertEqual(response["result"]["command"], command)
        self.assertEqual(response["result"]["expires_in"], 120)
        operation_id = response["result"]["operation_id"]
        parts = operation_id.split(":")
        self.assertEqual(len(parts), 3)
        self.assertEqual(parts[0], response["result"]["instance_id"])
        self.assertEqual(uuid.UUID(parts[0]).version, 4)
        self.assertGreater(int(parts[1]), 0)
        self.assertEqual(uuid.UUID(parts[2]).version, 4)
        return operation_id

    @staticmethod
    def request(operation_id, **extra):
        return {
            "cmd": "download",
            "operation_id": operation_id,
            "args": {"urls": ["url"], "options": {"save_path": "out"}},
            **extra,
        }

    def test_stop_before_start_skips_callback_and_media(self):
        operation_id = self.prepare()
        hook = []
        stopped = self.side.dispatch(
            {"cmd": "stop", "args": {"operation_id": operation_id}}
        )
        self.assertTrue(stopped["result"]["stopping"])
        result = self.side.dispatch(
            self.request(operation_id, before_execute=lambda: hook.append(True))
        )
        self.assertTrue(result["ok"], result)
        self.assertTrue(result["result"]["summary"]["cancelled"])
        self.assertEqual(result["result"]["summary"]["skipped"], 1)
        self.assertEqual(hook, [])
        self.assertEqual(self.actions, [])
        repeated = self.side.dispatch(self.request(operation_id))
        self.assertEqual(repeated.get("error_code"), "invalid_operation")

    def test_legacy_pre_cancelled_and_reserved_flag_is_not_client_overridable(self):
        request = self.request("unused")
        del request["operation_id"]
        request["pre_cancelled"] = True
        result = self.side.dispatch(request)
        self.assertTrue(result["ok"], result)
        self.assertTrue(result["result"]["summary"]["cancelled"])
        self.assertEqual(self.actions, [])

        operation_id = self.prepare()
        result = self.side.dispatch(self.request(operation_id, pre_cancelled=True))
        self.assertTrue(result["ok"], result)
        self.assertFalse(result["result"]["summary"]["cancelled"])
        self.assertEqual(self.actions, ["media"])

    def test_reservation_rejects_unknown_wrong_command_and_unidentified_start(self):
        operation_id = self.prepare()
        busy = self.side.dispatch({"cmd": "prepare", "args": {"command": "convert"}})
        self.assertEqual(busy.get("error_code"), "busy")
        self.assertEqual(
            self.side.dispatch({"cmd": "ai_plan", "args": {}}).get("error_code"), "busy"
        )
        request = self.request(operation_id)
        del request["operation_id"]
        self.assertEqual(self.side.dispatch(request).get("error_code"), "busy")
        self.assertEqual(
            self.side.dispatch(self.request("unknown")).get("error_code"),
            "invalid_operation",
        )
        wrong = self.side.dispatch(
            {"cmd": "convert", "operation_id": operation_id, "args": {}}
        )
        self.assertEqual(wrong.get("error_code"), "invalid_operation")
        self.assertFalse(
            self.side.dispatch({"cmd": "release", "args": {"operation_id": "unknown"}})[
                "result"
            ]["released"]
        )
        self.assertTrue(
            self.side.dispatch(
                {"cmd": "release", "args": {"operation_id": operation_id}}
            )["result"]["released"]
        )

    def test_expired_reservation_is_not_revived_by_late_start_or_stop(self):
        now = [1000.0]
        with patch.object(sc, "time", SimpleNamespace(monotonic=lambda: now[0])):
            first = self.prepare()
            now[0] += 120
            second = self.prepare()
            self.assertNotEqual(first, second)
            self.assertEqual(
                self.side.dispatch(self.request(first)).get("error_code"),
                "invalid_operation",
            )
            self.assertFalse(
                self.side.dispatch({"cmd": "stop", "args": {"operation_id": first}})[
                    "result"
                ]["stopping"]
            )
            self.assertFalse(
                self.side.dispatch({"cmd": "release", "args": {"operation_id": first}})[
                    "result"
                ]["released"]
            )
            self.assertTrue(
                self.side.dispatch(
                    {"cmd": "release", "args": {"operation_id": second}}
                )["result"]["released"]
            )

    def test_stop_after_claim_before_active_is_preserved(self):
        operation_id = self.prepare()
        side, actions = self.side, self.actions

        class StartingDownloader:
            def __init__(self, options, **callbacks):
                self.stopped = False
                self.last_summary = {
                    "total": 1,
                    "succeeded": 0,
                    "failed": 0,
                    "skipped": 1,
                    "cancelled": True,
                }
                stopped = side.dispatch(
                    {"cmd": "stop", "args": {"operation_id": operation_id}}
                )
                assert stopped["result"]["stopping"]

            def stop(self):
                self.stopped = True

            def download_batch(self, urls):
                if not self.stopped:
                    actions.append("media")
                return []

        with patch.object(sc, "Downloader", StartingDownloader):
            result = side.dispatch(self.request(operation_id))
        self.assertTrue(result["ok"], result)
        self.assertTrue(result["result"]["summary"]["cancelled"])
        self.assertEqual(actions, [])

    def test_targeted_stop_reaches_the_active_operation(self):
        operation_id = self.prepare()
        side, actions = self.side, self.actions

        class ActiveDownloader:
            def __init__(self, options, **callbacks):
                self.stopped = False
                self.last_summary = {
                    "total": 1,
                    "succeeded": 0,
                    "failed": 0,
                    "skipped": 1,
                    "cancelled": True,
                }

            def stop(self):
                self.stopped = True

            def download_batch(self, urls):
                result = side.dispatch(
                    {"cmd": "stop", "args": {"operation_id": operation_id}}
                )
                assert result["result"]["stopping"]
                if not self.stopped:
                    actions.append("media")
                return []

        with patch.object(sc, "Downloader", ActiveDownloader):
            result = side.dispatch(self.request(operation_id))
        self.assertTrue(result["ok"], result)
        self.assertTrue(result["result"]["summary"]["cancelled"])
        self.assertEqual(actions, [])

    def test_delayed_stop_and_release_do_not_affect_next_operation_or_legacy(self):
        first = self.prepare()
        self.assertTrue(self.side.dispatch(self.request(first))["ok"])
        first_callbacks = self.callbacks[0]
        second = self.prepare()

        def while_second_is_active():
            self.assertFalse(
                self.side.dispatch({"cmd": "stop", "args": {"operation_id": first}})[
                    "result"
                ]["stopping"]
            )
            self.assertFalse(self.side.dispatch({"cmd": "stop"})["result"]["stopping"])
            self.assertFalse(
                self.side.dispatch({"cmd": "release", "args": {"operation_id": first}})[
                    "result"
                ]["released"]
            )
            first_callbacks["log_cb"]("info", "late")

        second_result = self.side.dispatch(
            self.request(second, before_execute=while_second_is_active)
        )
        self.assertTrue(second_result["ok"], second_result)
        self.assertFalse(second_result["result"]["summary"]["cancelled"])
        late = [event for event in self.events if event.get("key") == "late"]
        self.assertEqual([event["operation_id"] for event in late], [first])
        for event in self.events:
            self.assertIn(event.get("operation_id"), (first, second))

    def test_converter_and_queue_callbacks_keep_their_operation_ids(self):
        captured = {}

        class MemoryConverter:
            def __init__(self, **options):
                captured["convert_log"] = options["log_cb"]
                self.last_summary = {}
                # OpenAI-Codex_engine_cli: an empty batch still has a complete summary.
                self.last_summary.update(
                    {
                        "total": 0,
                        "succeeded": 0,
                        "failed": 0,
                        "skipped": 0,
                        "cancelled": False,
                    }
                )

            def convert_batch(self, files):
                captured["convert_log"]("info", "convert")
                return []

        class MemoryQueue:
            def __init__(self, **options):
                captured["queue_log"] = options["log_cb"]
                captured["queue_update"] = options["task_update_cb"]
                self.last_summary = {}

            def run(self, tasks):
                captured["queue_log"]("info", "queue")
                captured["queue_update"](tasks[0])

        with patch.object(sc, "Converter", MemoryConverter), patch.object(
            sc, "TaskQueue", MemoryQueue
        ):
            conversion = self.prepare("convert")
            result = self.side.dispatch(
                {
                    "cmd": "convert",
                    "operation_id": conversion,
                    "args": {"save_path": "out", "dst_fmt": "mp4", "files": []},
                }
            )
            self.assertTrue(result["ok"], result)
            queue = self.prepare("run_queue")
            result = self.side.dispatch(
                {
                    "cmd": "run_queue",
                    "operation_id": queue,
                    "args": {"tasks": [{"kind": "unknown", "task_id": "t"}]},
                }
            )
            self.assertTrue(result["ok"], result)
        captured["convert_log"]("warn", "late conversion")
        captured["queue_update"](sc.Task(kind="unknown", task_id="late"))
        self.assertEqual(
            [event["operation_id"] for event in self.events],
            [conversion, queue, queue, conversion, queue],
        )

    def test_callback_failure_releases_the_claim(self):
        operation_id = self.prepare()

        def fail():
            raise ValueError("setup failed")

        result = self.side.dispatch(self.request(operation_id, before_execute=fail))
        self.assertFalse(result["ok"])
        self.assertEqual(self.actions, [])
        self.prepare()

    def test_status_identifies_running_work_even_if_start_response_is_lost(self):
        started = threading.Event()
        finish = threading.Event()

        class BlockingDownloader:
            def __init__(self, options, **callbacks):
                self.last_summary = {
                    "total": 0,
                    "succeeded": 0,
                    "failed": 0,
                    "skipped": 0,
                    "cancelled": False,
                }

            def stop(self):
                finish.set()

            def download_batch(self, urls):
                started.set()
                if not finish.wait(2):
                    raise RuntimeError("test did not release the operation")
                return []

        operation_id = self.prepare()

        def status():
            return self.side.dispatch(
                {"cmd": "status", "args": {"operation_id": operation_id}}
            )

        self.assertEqual(status()["result"]["state"], "reserved")
        with patch.object(sc, "Downloader", BlockingDownloader):
            worker = threading.Thread(
                target=lambda: self.side.dispatch(self.request(operation_id))
            )
            try:
                worker.start()
                self.assertTrue(started.wait(2))
                self.assertEqual(status()["result"]["state"], "running")
                released = self.side.dispatch(
                    {"cmd": "release", "args": {"operation_id": operation_id}}
                )
                self.assertFalse(released["result"]["released"])
                self.assertEqual(status()["result"]["state"], "running")
            finally:
                finish.set()
                worker.join(2)
            self.assertFalse(worker.is_alive())
        self.assertEqual(status()["result"]["state"], "completed")

    def test_old_status_does_not_change_a_new_reservation(self):
        first = self.prepare()
        self.assertTrue(self.side.dispatch(self.request(first))["ok"])
        second = self.prepare()
        old = self.side.dispatch({"cmd": "status", "args": {"operation_id": first}})
        current = self.side.dispatch(
            {"cmd": "status", "args": {"operation_id": second}}
        )
        self.assertEqual(old["result"]["state"], "completed")
        self.assertEqual(current["result"]["state"], "reserved")
        self.assertFalse(
            self.side.dispatch({"cmd": "stop", "args": {"operation_id": first}})[
                "result"
            ]["stopping"]
        )
        self.assertTrue(
            self.side.dispatch({"cmd": "release", "args": {"operation_id": second}})[
                "result"
            ]["released"]
        )

    def test_status_expires_and_restart_returns_unknown(self):
        now = [1000.0]
        with patch.object(sc, "time", SimpleNamespace(monotonic=lambda: now[0])):
            operation_id = self.prepare()
            self.assertTrue(self.side.dispatch(self.request(operation_id))["ok"])
            query = {"cmd": "status", "args": {"operation_id": operation_id}}
            self.assertEqual(self.side.dispatch(query)["result"]["state"], "completed")
            self.assertEqual(
                sc.Sidecar(lambda event: None).dispatch(query)["result"]["state"],
                "unknown",
            )
            now[0] += sc.Sidecar._COMPLETED_TTL
            self.assertEqual(self.side.dispatch(query)["result"]["state"], "unknown")

            reserved = self.prepare()
            now[0] += sc.Sidecar._RESERVATION_TTL
            query["args"]["operation_id"] = reserved
            self.assertEqual(self.side.dispatch(query)["result"]["state"], "unknown")

    def test_completed_history_is_bounded(self):
        with patch.object(sc.Sidecar, "_COMPLETED_LIMIT", 2):
            operations = []
            for _ in range(3):
                operation_id = self.prepare()
                self.assertTrue(self.side.dispatch(self.request(operation_id))["ok"])
                operations.append(operation_id)
            states = [
                self.side.dispatch(
                    {"cmd": "status", "args": {"operation_id": operation_id}}
                )["result"]["state"]
                for operation_id in operations
            ]
            self.assertEqual(states, ["unknown", "completed", "completed"])

    def test_lost_release_response_is_recoverable_and_does_not_affect_next_operation(
        self,
    ):
        first = self.prepare()
        self.side.dispatch({"cmd": "release", "args": {"operation_id": first}})
        query = {"cmd": "status", "args": {"operation_id": first}}
        self.assertEqual(self.side.dispatch(query)["result"]["state"], "released")
        self.assertEqual(
            self.side.dispatch(self.request(first)).get("error_code"),
            "invalid_operation",
        )
        second = self.prepare()

        def check_while_running():
            self.assertEqual(self.side.dispatch(query)["result"]["state"], "released")
            self.assertFalse(
                self.side.dispatch({"cmd": "stop", "args": {"operation_id": first}})[
                    "result"
                ]["stopping"]
            )
            self.assertFalse(
                self.side.dispatch({"cmd": "release", "args": {"operation_id": first}})[
                    "result"
                ]["released"]
            )
            self.assertEqual(
                self.side.dispatch({"cmd": "status", "args": {"operation_id": second}})[
                    "result"
                ]["state"],
                "running",
            )

        result = self.side.dispatch(
            self.request(second, before_execute=check_while_running)
        )
        self.assertTrue(result["ok"], result)
        self.assertFalse(result["result"]["summary"]["cancelled"])

    def test_released_status_expires_and_restart_returns_unknown(self):
        now = [1000.0]
        with patch.object(sc, "time", SimpleNamespace(monotonic=lambda: now[0])):
            operation_id = self.prepare()
            self.assertTrue(
                self.side.dispatch(
                    {"cmd": "release", "args": {"operation_id": operation_id}}
                )["result"]["released"]
            )
            query = {"cmd": "status", "args": {"operation_id": operation_id}}
            self.assertEqual(self.side.dispatch(query)["result"]["state"], "released")
            self.assertEqual(
                sc.Sidecar(lambda event: None).dispatch(query)["result"]["state"],
                "unknown",
            )
            now[0] += sc.Sidecar._RELEASED_TTL
            self.assertEqual(self.side.dispatch(query)["result"]["state"], "unknown")

    def test_released_history_is_bounded_and_id_is_not_reused(self):
        first = uuid.UUID(int=1, version=4)
        second = uuid.UUID(int=2, version=4)
        with patch.object(sc, "uuid4", side_effect=[first, first, second]):
            operation_id = self.prepare()
            self.assertTrue(
                self.side.dispatch(
                    {"cmd": "release", "args": {"operation_id": operation_id}}
                )["result"]["released"]
            )
            next_id = self.prepare()
            self.assertNotEqual(operation_id, next_id)
            self.assertTrue(
                self.side.dispatch(
                    {"cmd": "release", "args": {"operation_id": next_id}}
                )["result"]["released"]
            )
        with patch.object(sc.Sidecar, "_RELEASED_LIMIT", 2):
            latest = self.prepare()
            self.assertTrue(
                self.side.dispatch(
                    {"cmd": "release", "args": {"operation_id": latest}}
                )["result"]["released"]
            )
            states = [
                self.side.dispatch({"cmd": "status", "args": {"operation_id": value}})[
                    "result"
                ]["state"]
                for value in (operation_id, next_id, latest)
            ]
            self.assertEqual(states, ["unknown", "released", "released"])

    def test_unknown_status_provides_only_same_instance_idle_evidence(self):
        now = [1000.0]
        with patch.object(sc, "time", SimpleNamespace(monotonic=lambda: now[0])):
            first = self.prepare()
            initial = self.side.dispatch(
                {"cmd": "status", "args": {"operation_id": first}}
            )["result"]
            self.assertEqual(initial["state"], "reserved")
            self.assertFalse(initial["idle"])
            self.assertTrue(self.side.dispatch(self.request(first))["ok"])
            now[0] += sc.Sidecar._COMPLETED_TTL
            query = {"cmd": "status", "args": {"operation_id": first}}
            expired = self.side.dispatch(query)["result"]
            self.assertEqual(
                expired,
                {
                    "state": "unknown",
                    "instance_id": initial["instance_id"],
                    "idle": True,
                },
            )
            second = self.prepare()
            self.assertNotEqual(first, second)
            self.assertFalse(self.side.dispatch(query)["result"]["idle"])
            self.assertEqual(
                self.side.dispatch(self.request(first)).get("error_code"),
                "invalid_operation",
            )

            def while_second_runs():
                current = self.side.dispatch(query)["result"]
                self.assertEqual(current["state"], "unknown")
                self.assertEqual(current["instance_id"], initial["instance_id"])
                self.assertFalse(current["idle"])

            self.assertTrue(
                self.side.dispatch(
                    self.request(second, before_execute=while_second_runs)
                )["ok"]
            )
            restarted = sc.Sidecar(lambda event: None).dispatch(query)["result"]
            self.assertEqual(restarted["state"], "unknown")
            self.assertTrue(restarted["idle"])
            self.assertNotEqual(restarted["instance_id"], initial["instance_id"])

    def test_simulated_fork_renews_instance_and_invalidates_inherited_state(self):
        operation_id = self.prepare()
        query = {"cmd": "status", "args": {"operation_id": operation_id}}
        original = self.side.dispatch(query)["result"]["instance_id"]
        self.side._after_fork()
        status = self.side.dispatch(query)["result"]
        self.assertNotEqual(status["instance_id"], original)
        self.assertEqual(status["state"], "unknown")
        self.assertTrue(status["idle"])
        self.assertEqual(
            self.side.dispatch(self.request(operation_id)).get("error_code"),
            "invalid_operation",
        )


class PreviewRoutingTests(unittest.TestCase):
    def test_preview_returns_rows_without_starting_media(self):
        rows = [
            {
                "src": "a.mkv",
                "dst": "out/a.mp4",
                "existing": "missing",
                "batch_duplicate": False,
                "source_matches": "no",
            }
        ]
        with patch.object(sc, "Converter") as converter:
            converter.return_value.preview_batch.return_value = rows
            result = sc.Sidecar(lambda event: None).dispatch(
                {
                    "cmd": "preview_convert",
                    "args": {"save_path": "out", "dst_fmt": "mp4", "files": ["a.mkv"]},
                }
            )
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["result"]["jobs"], rows)
        converter.return_value.preview_batch.assert_called_once_with(["a.mkv"])
        converter.return_value.convert_batch.assert_not_called()

    def test_desktop_preview_rejects_relative_paths_before_constructing_converter(self):
        path = os.path.abspath("output")
        requests = [
            {"save_path": "relative", "dst_fmt": "mp4", "files": [path]},
            {"save_path": path, "dst_fmt": "mp4", "files": ["relative.mkv"]},
        ]
        with patch.object(sc, "Converter") as converter:
            for args in requests:
                args["require_absolute_paths"] = True
                result = sc.Sidecar(lambda event: None).dispatch(
                    {"cmd": "preview_convert", "args": args}
                )
                self.assertFalse(result["ok"])
                self.assertIn("absolute path", result["error"])
            converter.assert_not_called()

    # OpenAI-Codex_web_ai: queue preview keeps explicit destinations and task IDs.
    def test_queue_preview_forwards_explicit_jobs_without_execution(self):
        tasks = [
            {
                "kind": "convert",
                "task_id": "a",
                "src_path": "first.mkv",
                "dst_path": "chosen/name.flac",
                "conflict_policy": "overwrite",
            },
            {
                "kind": "convert",
                "task_id": "b",
                "src_path": "chosen/name.flac",
                "dst_path": "elsewhere/final.mp4",
            },
        ]
        rows = [
            {
                "src": "first.mkv",
                "dst": "chosen/name.flac",
                "existing": "missing",
                "batch_duplicate": False,
                "source_matches": "yes",
            },
            {
                "src": "chosen/name.flac",
                "dst": "elsewhere/final.mp4",
                "existing": "unknown",
                "batch_duplicate": False,
                "source_matches": "unknown",
            },
        ]
        with patch.object(sc, "Converter") as converter:
            converter.preview_jobs.return_value = rows
            result = sc.Sidecar(lambda event: None).dispatch(
                {"cmd": "preview_queue", "args": {"tasks": tasks}}
            )
        self.assertTrue(result["ok"], result)
        self.assertEqual(
            result["result"]["jobs"],
            [{"task_id": "a", **rows[0]}, {"task_id": "b", **rows[1]}],
        )
        jobs = converter.preview_jobs.call_args.args[0]
        self.assertEqual(
            [(job.src_path, job.dst_path) for job in jobs],
            [
                ("first.mkv", "chosen/name.flac"),
                ("chosen/name.flac", "elsewhere/final.mp4"),
            ],
        )
        converter.assert_not_called()

    def test_queue_preview_rejects_invalid_tasks_and_duplicate_ids(self):
        valid = {
            "kind": "convert",
            "task_id": "one",
            "src_path": "a.mkv",
            "dst_path": "b.mp4",
        }
        cases = (
            None,
            {},
            [valid, dict(valid)],
            [{**valid, "task_id": " "}],
            [{**valid, "kind": "download"}],
            [{**valid, "dst_path": ""}],
            [{**valid, "src_path": "a\x00.mkv"}],
            [{**valid, "conflict_policy": "delete"}],
        )
        with patch.object(sc, "Converter") as converter:
            for tasks in cases:
                with self.subTest(tasks=tasks):
                    result = sc.Sidecar(lambda event: None).dispatch(
                        {"cmd": "preview_queue", "args": {"tasks": tasks}}
                    )
                    self.assertFalse(result["ok"])
            converter.preview_jobs.assert_not_called()

    def test_desktop_queue_preview_requires_absolute_paths(self):
        native = os.path.abspath("output")
        tasks = [
            {
                "kind": "convert",
                "task_id": "one",
                "src_path": native,
                "dst_path": "relative.mp4",
            }
        ]
        with patch.object(sc, "Converter") as converter:
            result = sc.Sidecar(lambda event: None).dispatch(
                {
                    "cmd": "preview_queue",
                    "args": {"tasks": tasks, "require_absolute_paths": True},
                }
            )
            self.assertFalse(result["ok"])
            self.assertIn("absolute path", result["error"])
            converter.preview_jobs.assert_not_called()


class DesktopPathTests(unittest.TestCase):
    def test_native_absolute_path_is_accepted(self):
        sc.Sidecar._require_native_absolute(os.path.abspath("output"), "save path")

    def test_desktop_requests_reject_relative_paths_before_starting(self):
        side = sc.Sidecar(lambda event: None)
        native_path = os.path.abspath("output")
        requests = [
            {
                "cmd": "download",
                "args": {
                    "require_absolute_paths": True,
                    "options": {"save_path": "relative"},
                    "urls": ["u"],
                },
            },
            {
                "cmd": "convert",
                "args": {
                    "require_absolute_paths": True,
                    "save_path": native_path,
                    "files": ["relative"],
                    "dst_fmt": "mp4",
                },
            },
            {
                "cmd": "run_queue",
                "args": {
                    "require_absolute_paths": True,
                    "tasks": [
                        {
                            "kind": "convert",
                            "src_path": native_path,
                            "dst_path": "relative.mp4",
                        }
                    ],
                },
            },
        ]
        for request in requests:
            with self.subTest(command=request["cmd"]):
                result = side.dispatch(request)
                self.assertFalse(result["ok"])
                self.assertIn("absolute path", result["error"])

    def test_desktop_rejects_invalid_cookie_paths_before_any_work(self):
        native_path = os.path.abspath("output")
        invalid = (
            "cookies.txt",
            " ",
            False,
            0,
            [],
            os.path.abspath("cookies.txt") + "\x00suffix",
        )
        with patch.object(sc, "Downloader") as downloader, patch.object(
            sc, "TaskQueue"
        ) as queue:
            for cookie_file in invalid:
                options = {"save_path": native_path, "cookie_file": cookie_file}
                requests = [
                    {
                        "cmd": "download",
                        "args": {
                            "require_absolute_paths": True,
                            "options": options,
                            "urls": ["u"],
                        },
                    },
                    {
                        "cmd": "run_queue",
                        "args": {
                            "require_absolute_paths": True,
                            "tasks": [
                                {
                                    "kind": "download",
                                    "url": "first",
                                    "options": {"save_path": native_path},
                                },
                                {
                                    "kind": "download",
                                    "url": "second",
                                    "options": options,
                                },
                            ],
                        },
                    },
                ]
                for request in requests:
                    with self.subTest(command=request["cmd"], cookie_file=cookie_file):
                        result = sc.Sidecar(lambda event: None).dispatch(request)
                        self.assertFalse(result["ok"])
                        self.assertIn("cookie file", result["error"])
                        self.assertIn("absolute path", result["error"])
            downloader.assert_not_called()
            queue.assert_not_called()

    def test_desktop_accepts_empty_or_absolute_cookie_and_preserves_legacy_relative_paths(
        self,
    ):
        native_path = os.path.abspath("output")
        absolute_cookie = os.path.abspath("cookies.txt")
        cases = [
            (True, None),
            (True, ""),
            (True, absolute_cookie),
            (False, "cookies.txt"),
            (None, "cookies.txt"),
        ]
        for required, cookie_file in cases:
            options = {"save_path": native_path, "cookie_file": cookie_file}
            for cmd in ("download", "run_queue"):
                with self.subTest(
                    command=cmd, required=required, cookie_file=cookie_file
                ):
                    args = (
                        {"urls": [], "options": options}
                        if cmd == "download"
                        else {
                            "tasks": [
                                {"kind": "download", "url": "u", "options": options}
                            ]
                        }
                    )
                    if required is not None:
                        args["require_absolute_paths"] = required
                    with patch.object(sc, "Downloader") as downloader, patch.object(
                        sc, "TaskQueue"
                    ) as queue:
                        downloader.return_value.download_batch.return_value = []
                        result = sc.Sidecar(lambda event: None).dispatch(
                            {"cmd": cmd, "args": args}
                        )
                    self.assertTrue(result["ok"], result)
                    if cmd == "download":
                        self.assertEqual(
                            downloader.call_args.args[0].cookie_file, cookie_file
                        )
                    else:
                        self.assertEqual(
                            queue.return_value.run.call_args.args[0][
                                0
                            ].options.cookie_file,
                            cookie_file,
                        )


# Added by OpenAI-Codex_Fork_Source_Code.
# Updated by OpenAI-Codex_engine_cli.


if __name__ == "__main__":
    unittest.main()


class SidecarProgressProtocolTests(unittest.TestCase):
    # OpenAI-Codex: use yt-dlp's real progress reporter on the sidecar's stdout.
    def test_downloading_and_finished_events_remain_valid_json_lines(self):
        output = io.StringIO()
        request = {
            "id": "download-1",
            "cmd": "download",
            "args": {
                "urls": ["https://example.invalid/video"],
                "options": {"save_path": "."},
            },
        }

        def report_progress(ydl, _urls):
            downloader = FileDownloader(ydl, ydl.params)
            for hook in ydl._progress_hooks:
                downloader.add_progress_hook(hook)
            info = {"id": "fixture", "title": "Fixture"}
            downloader._hook_progress(
                {
                    "status": "downloading",
                    "downloaded_bytes": 512,
                    "total_bytes": 1024,
                    "elapsed": 1,
                    "speed": 1024,
                    "eta": 5,
                },
                info,
            )
            downloader._hook_progress(
                {
                    "status": "finished",
                    "downloaded_bytes": 1024,
                    "total_bytes": 1024,
                    "elapsed": 2,
                },
                info,
            )
            downloader._finish_multiline_status()
            return 0

        with redirect_stdout(output), patch.object(
            yt_dlp.YoutubeDL, "download", report_progress
        ):
            sc.main(inp=io.StringIO(json.dumps(request) + "\n"), out=output)

        # The desktop parser accepts one JSON object per newline.
        lines = [line for line in output.getvalue().split("\n") if line]
        events = [json.loads(line) for line in lines]
        progress = [event for event in events if event.get("type") == "progress"]
        self.assertEqual([event["pct"] for event in progress], [50.0, 100.0])
        self.assertEqual(progress[0]["speed"], "1.00KiB/s")
        self.assertEqual(progress[0]["eta"], "00:05")
        self.assertTrue(events[-1]["ok"])
