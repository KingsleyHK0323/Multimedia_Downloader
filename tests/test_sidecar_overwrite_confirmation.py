# OpenAI-Codex_engine_cli
"""Fake-media checks for Sidecar overwrite confirmation and request snapshots."""

import unittest
from types import SimpleNamespace
from unittest.mock import patch

import _path  # noqa: F401
import engine_sidecar as sc


class OverwriteConfirmationTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        calls = self.calls

        class FakeConverter:
            def __init__(self, save_path, dst_fmt, conflict_policy, **_kwargs):
                self.save_path = save_path
                self.dst_fmt = dst_fmt
                self.conflict_policy = conflict_policy
                self.stopped = False
                calls.append(("converter_init", conflict_policy))

            def stop(self):
                self.stopped = True

            def make_job(self, source):
                stem = source.rsplit(".", 1)[0]
                return SimpleNamespace(
                    dst_path=self.save_path + "/" + stem + "." + self.dst_fmt
                )

            def convert_batch(self, files):
                files = list(files)
                calls.append(
                    ("convert_batch", self.conflict_policy, tuple(files), self.stopped)
                )
                status = "skipped" if self.stopped else "done"
                self.last_summary = {
                    "total": len(files),
                    "succeeded": 0 if self.stopped else len(files),
                    "failed": 0,
                    "skipped": len(files) if self.stopped else 0,
                    "cancelled": self.stopped,
                }
                return [
                    SimpleNamespace(
                        src_path=source,
                        dst_path=self.make_job(source).dst_path,
                        status=status,
                        error="",
                    )
                    for source in files
                ]

        class FakeQueue:
            def __init__(self, **_kwargs):
                self.stopped = False
                calls.append(("queue_init",))

            def stop(self):
                self.stopped = True

            def run(self, tasks):
                for task in tasks:
                    task.status = "skipped" if self.stopped else "done"
                self.last_summary = {
                    "total": len(tasks),
                    "succeeded": 0 if self.stopped else len(tasks),
                    "failed": 0,
                    "skipped": len(tasks) if self.stopped else 0,
                    "cancelled": self.stopped,
                }
                calls.append(
                    (
                        "queue_run",
                        tuple(
                            (
                                task.kind,
                                task.conflict_policy,
                                task.src_path,
                                task.dst_path,
                            )
                            for task in tasks
                        ),
                        self.stopped,
                    )
                )
                return tasks

        self.converter_patch = patch.object(sc, "Converter", FakeConverter)
        self.queue_patch = patch.object(sc, "TaskQueue", FakeQueue)
        self.converter_patch.start()
        self.queue_patch.start()
        self.addCleanup(self.converter_patch.stop)
        self.addCleanup(self.queue_patch.stop)
        self.side = sc.Sidecar(lambda _event: None)

    @staticmethod
    def convert_args(policy="rename"):
        return {
            "files": ["synthetic.mkv"],
            "save_path": "out",
            "dst_fmt": "mp4",
            "conflict_policy": policy,
        }

    @staticmethod
    def queue_args(policy="rename"):
        return {
            "tasks": [
                {
                    "kind": "convert",
                    "task_id": "synthetic-task",
                    "src_path": "synthetic.mkv",
                    "dst_path": "out/synthetic.mp4",
                    "conflict_policy": policy,
                }
            ]
        }

    def test_unconfirmed_convert_and_queue_fail_before_hook_or_media(self):
        for command, make_args in (
            ("convert", self.convert_args),
            ("run_queue", self.queue_args),
        ):
            for value in (None, False, 0, 1, "true", [], {}):
                with self.subTest(command=command, value=value):
                    self.calls.clear()
                    hooks = []
                    args = make_args("overwrite")
                    args["overwrite_confirmed"] = value
                    response = self.side.dispatch(
                        {
                            "cmd": command,
                            "args": args,
                            "before_execute": lambda: hooks.append(True),
                        }
                    )
                    self.assertFalse(response["ok"], response)
                    self.assertIn(
                        "overwrite requires explicit confirmation", response["error"]
                    )
                    self.assertEqual(hooks, [])
                    self.assertEqual(self.calls, [])

    def test_confirmed_overwrite_and_non_overwrite_still_route(self):
        for command, make_args in (
            ("convert", self.convert_args),
            ("run_queue", self.queue_args),
        ):
            for policy in ("rename", "skip", "overwrite"):
                with self.subTest(command=command, policy=policy):
                    self.calls.clear()
                    args = make_args(policy)
                    if policy == "overwrite":
                        args["overwrite_confirmed"] = True
                    response = self.side.dispatch({"cmd": command, "args": args})
                    self.assertTrue(response["ok"], response)
                    self.assertTrue(self.calls)
                    # OpenAI-Codex_engine_cli: verify the selected policy reaches the fake.
                    if command == "convert":
                        self.assertIn(("converter_init", policy), self.calls)
                        self.assertIn(
                            ("convert_batch", policy, ("synthetic.mkv",), False),
                            self.calls,
                        )
                    else:
                        expected = (
                            "convert",
                            policy,
                            "synthetic.mkv",
                            "out/synthetic.mp4",
                        )
                        self.assertIn(("queue_run", (expected,), False), self.calls)

    def test_download_task_extra_policy_is_not_a_convert_overwrite(self):
        response = self.side.dispatch(
            {
                "cmd": "run_queue",
                "args": {
                    "tasks": [
                        {
                            "kind": "download",
                            "task_id": "synthetic-download",
                            "url": "synthetic-url",
                            "options": {"save_path": "out"},
                            "conflict_policy": "overwrite",
                        }
                    ]
                },
            }
        )
        self.assertTrue(response["ok"], response)
        self.assertTrue(any(call[0] == "queue_run" for call in self.calls))

    def test_direct_handlers_reject_unconfirmed_overwrite(self):
        with self.assertRaisesRegex(
            ValueError, "overwrite requires explicit confirmation"
        ):
            self.side._cmd_convert(self.convert_args("overwrite"))
        with self.assertRaisesRegex(
            ValueError, "overwrite requires explicit confirmation"
        ):
            self.side._cmd_run_queue(self.queue_args("overwrite"))
        self.assertEqual(self.calls, [])

    def test_before_execute_mutation_cannot_change_validated_policy(self):
        args = self.convert_args("rename")

        def change_convert():
            args["conflict_policy"] = "overwrite"
            args["files"].append("late.mkv")

        response = self.side.dispatch(
            {
                "cmd": "convert",
                "args": args,
                "before_execute": change_convert,
            }
        )
        self.assertTrue(response["ok"], response)
        self.assertIn(
            ("convert_batch", "rename", ("synthetic.mkv",), False), self.calls
        )

        self.calls.clear()
        queue_args = self.queue_args("rename")

        def change_queue():
            queue_args["tasks"][0]["conflict_policy"] = "overwrite"
            queue_args["tasks"][0]["dst_path"] = "out/changed.mp4"

        response = self.side.dispatch(
            {
                "cmd": "run_queue",
                "args": queue_args,
                "before_execute": change_queue,
            }
        )
        self.assertTrue(response["ok"], response)
        expected = ("convert", "rename", "synthetic.mkv", "out/synthetic.mp4")
        self.assertIn(("queue_run", (expected,), False), self.calls)

    def test_overwrite_preview_needs_no_confirmation(self):
        tasks = [
            {
                "kind": "convert",
                "task_id": "preview",
                "src_path": "synthetic.mkv",
                "dst_path": "out/synthetic.mp4",
                "conflict_policy": "overwrite",
            }
        ]
        with patch.object(sc, "Converter") as converter:
            converter.preview_jobs.return_value = [{}]
            response = self.side.dispatch(
                {"cmd": "preview_queue", "args": {"tasks": tasks}}
            )
            self.assertTrue(response["ok"], response)
            converter.preview_jobs.assert_called_once()
            converter.assert_not_called()

    def test_pre_cancelled_confirmation_and_reservation_state(self):
        for confirmed in (False, True):
            with self.subTest(confirmed=confirmed):
                self.calls.clear()
                hooks = []
                prepared = self.side.dispatch(
                    {"cmd": "prepare", "args": {"command": "convert"}}
                )
                self.assertTrue(prepared["ok"], prepared)
                operation_id = prepared["result"]["operation_id"]
                stopped = self.side.dispatch(
                    {"cmd": "stop", "args": {"operation_id": operation_id}}
                )
                self.assertTrue(stopped["result"]["stopping"])
                args = self.convert_args("overwrite")
                if confirmed:
                    args["overwrite_confirmed"] = True
                response = self.side.dispatch(
                    {
                        "cmd": "convert",
                        "operation_id": operation_id,
                        "args": args,
                        "before_execute": lambda: hooks.append(True),
                    }
                )
                self.assertEqual(hooks, [])
                if confirmed:
                    self.assertTrue(response["ok"], response)
                    self.assertTrue(response["result"]["summary"]["cancelled"])
                    self.assertEqual(response["result"]["summary"]["skipped"], 1)
                    self.assertIn(
                        ("convert_batch", "overwrite", ("synthetic.mkv",), True),
                        self.calls,
                    )
                else:
                    self.assertFalse(response["ok"], response)
                    self.assertIn(
                        "overwrite requires explicit confirmation", response["error"]
                    )
                    self.assertEqual(self.calls, [])
                status = self.side.dispatch(
                    {"cmd": "status", "args": {"operation_id": operation_id}}
                )
                self.assertEqual(status["result"]["state"], "completed")
                self.assertTrue(status["result"]["idle"])

    # OpenAI-Codex_engine_cli: preview and pre-cancelled queue contracts.
    def test_convert_preview_needs_no_overwrite_confirmation(self):
        args = self.convert_args("overwrite")
        with patch.object(sc, "Converter") as converter:
            converter.return_value.preview_batch.return_value = [{}]
            response = self.side.dispatch({"cmd": "preview_convert", "args": args})
            self.assertTrue(response["ok"], response)
            converter.return_value.preview_batch.assert_called_once()
            converter.return_value.convert_batch.assert_not_called()

    def test_pre_cancelled_queue_confirmation_and_reservation_state(self):
        for confirmed in (False, True):
            with self.subTest(confirmed=confirmed):
                self.calls.clear()
                hooks = []
                prepared = self.side.dispatch(
                    {"cmd": "prepare", "args": {"command": "run_queue"}}
                )
                self.assertTrue(prepared["ok"], prepared)
                operation_id = prepared["result"]["operation_id"]
                stopped = self.side.dispatch(
                    {"cmd": "stop", "args": {"operation_id": operation_id}}
                )
                self.assertTrue(stopped["result"]["stopping"])
                args = self.queue_args("overwrite")
                if confirmed:
                    args["overwrite_confirmed"] = True
                response = self.side.dispatch(
                    {
                        "cmd": "run_queue",
                        "operation_id": operation_id,
                        "args": args,
                        "before_execute": lambda: hooks.append(True),
                    }
                )
                self.assertEqual(hooks, [])
                if confirmed:
                    self.assertTrue(response["ok"], response)
                    self.assertTrue(response["result"]["summary"]["cancelled"])
                    self.assertEqual(response["result"]["summary"]["skipped"], 1)
                    expected = (
                        "convert",
                        "overwrite",
                        "synthetic.mkv",
                        "out/synthetic.mp4",
                    )
                    self.assertIn(("queue_run", (expected,), True), self.calls)
                else:
                    self.assertFalse(response["ok"], response)
                    self.assertIn(
                        "overwrite requires explicit confirmation", response["error"]
                    )
                    self.assertEqual(self.calls, [])
                status = self.side.dispatch(
                    {"cmd": "status", "args": {"operation_id": operation_id}}
                )
                self.assertEqual(status["result"]["state"], "completed")
                self.assertTrue(status["result"]["idle"])

    # OpenAI-Codex_engine_cli: absent policy keeps the safe rename default.
    def test_absent_policy_defaults_to_rename_without_confirmation(self):
        requests = (
            (
                "convert",
                {
                    "files": ["synthetic.mkv"],
                    "save_path": "out",
                    "dst_fmt": "mp4",
                },
            ),
            (
                "run_queue",
                {
                    "tasks": [
                        {
                            "kind": "convert",
                            "task_id": "default-policy",
                            "src_path": "synthetic.mkv",
                            "dst_path": "out/synthetic.mp4",
                        }
                    ]
                },
            ),
        )
        for command, args in requests:
            with self.subTest(command=command):
                self.calls.clear()
                response = self.side.dispatch({"cmd": command, "args": args})
                self.assertTrue(response["ok"], response)
                if command == "convert":
                    self.assertIn(("converter_init", "rename"), self.calls)
                else:
                    expected = (
                        "convert",
                        "rename",
                        "synthetic.mkv",
                        "out/synthetic.mp4",
                    )
                    self.assertIn(("queue_run", (expected,), False), self.calls)

    # OpenAI-Codex_engine_cli: fixed overwrite and malformed-task errors.
    def test_rejected_overwrite_uses_fixed_error_without_request_details(self):
        marker = "SYNTHETIC_PRIVATE_MARKER"
        for command, make_args in (
            ("convert", self.convert_args),
            ("run_queue", self.queue_args),
        ):
            with self.subTest(command=command):
                self.calls.clear()
                hooks = []
                args = make_args("overwrite")
                args["overwrite_confirmed"] = marker
                if command == "convert":
                    args["files"] = [marker]
                else:
                    args["tasks"][0]["src_path"] = marker
                response = self.side.dispatch(
                    {
                        "cmd": command,
                        "args": args,
                        "before_execute": lambda: hooks.append(True),
                    }
                )
                self.assertFalse(response["ok"], response)
                self.assertEqual(
                    response["error"], "overwrite requires explicit confirmation"
                )
                self.assertNotIn(marker, response["error"])
                self.assertEqual(hooks, [])
                self.assertEqual(self.calls, [])

    def test_malformed_queue_tasks_use_fixed_error_before_hook(self):
        marker = "SYNTHETIC_PRIVATE_MARKER"
        for tasks in ([marker], {"key": marker}, marker, 42):
            with self.subTest(tasks=type(tasks).__name__):
                self.calls.clear()
                hooks = []
                response = self.side.dispatch(
                    {
                        "cmd": "run_queue",
                        "args": {"tasks": tasks},
                        "before_execute": lambda: hooks.append(True),
                    }
                )
                self.assertFalse(response["ok"], response)
                self.assertEqual(
                    response["error"], "queue tasks must be a sequence of objects"
                )
                self.assertNotIn(marker, response["error"])
                self.assertEqual(hooks, [])
                self.assertEqual(self.calls, [])

    def test_non_object_arguments_use_fixed_error_before_hook(self):
        hooks = []
        response = self.side.dispatch(
            {
                "cmd": "convert",
                "args": ["SYNTHETIC_PRIVATE_MARKER"],
                "before_execute": lambda: hooks.append(True),
            }
        )
        self.assertFalse(response["ok"], response)
        self.assertEqual(response["error"], "operation arguments must be an object")
        self.assertNotIn("SYNTHETIC_PRIVATE_MARKER", response["error"])
        self.assertEqual(hooks, [])
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
