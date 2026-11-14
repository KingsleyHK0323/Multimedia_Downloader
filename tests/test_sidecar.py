import unittest
from unittest.mock import patch

import _path  # noqa: F401
import engine_sidecar as sc


class DispatchPureTests(unittest.TestCase):
    # OpenAI-Codex_Fork_GitHub_REPO: queue preserves bitrate and its default.
    def test_download_task_bitrate(self):
        for options, expected in (({"save_path": "out", "bitrate": "320"}, "320"),
                                  ({"save_path": "out"}, "192")):
            task = sc.Sidecar._task_from_dict({"kind": "download", "url": "u", "options": options})
            self.assertEqual(task.options.bitrate, expected)

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
        r = self.side.dispatch({
            "id": "d1", "cmd": "download",
            "args": {"urls": ["u1", "u2"], "options": {"save_path": "out"}},
        })
        self.assertTrue(r["ok"])
        self.assertEqual(r["result"]["results"], [["u1", True, ""], ["u2", True, ""]])
        # results must be JSON arrays (lists), not tuples
        self.assertIsInstance(r["result"]["results"][0], list)
        # a log event was emitted during the op
        self.assertTrue(any(e.get("type") == "log" and e["key"] == "log_start_batch"
                            for e in self.events))

    # OpenAI-Codex_Fork_GitHub_REPO: validate desktop paths before starting Downloader.
    def test_desktop_cookie_path_rejected_before_download(self):
        with patch.object(sc, "Downloader") as downloader:
            for value in ("relative.txt", "bad\x00path", 42):
                with self.subTest(value=value):
                    result = self.side.dispatch({"id": "d", "cmd": "download", "args": {
                        "urls": [], "options": {"save_path": "out", "cookie_file": value},
                        "require_absolute_cookie_path": True}})
                    self.assertFalse(result["ok"])
            downloader.assert_not_called()

    def test_desktop_cookie_absolute_or_empty_is_forwarded(self):
        import os
        with patch.object(sc, "Downloader") as downloader:
            downloader.return_value.download_batch.return_value = []
            for value in (os.path.abspath("cookies.txt"), "", None):
                with self.subTest(value=value):
                    result = self.side.dispatch({"id": "d", "cmd": "download", "args": {
                        "urls": [], "options": {"save_path": "out", "cookie_file": value},
                        "require_absolute_cookie_path": True}})
                    self.assertTrue(result["ok"])
                    self.assertEqual(downloader.call_args.args[0].cookie_file, value)

    def test_legacy_download_can_use_relative_cookie_and_save_paths(self):
        with patch.object(sc, "Downloader") as downloader:
            downloader.return_value.download_batch.return_value = []
            result = self.side.dispatch({"id": "d", "cmd": "download", "args": {
                "urls": [], "options": {"save_path": "relative-output", "cookie_file": "relative.txt"}}})
            self.assertTrue(result["ok"])
            options = downloader.call_args.args[0]
            self.assertEqual(options.save_path, "relative-output")
            self.assertEqual(options.cookie_file, "relative.txt")

    def test_stop_calls_active_stop(self):
        # simulate an active op exposing .stop()
        class Active:
            stopped = False
            def stop(self):
                Active.stopped = True
        self.side._active = Active()
        r = self.side.dispatch({"id": "s1", "cmd": "stop"})
        self.assertTrue(r["result"]["stopping"])
        self.assertTrue(self.side._active.stopped)


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
        r = self.side.dispatch({
            "id": "p1", "cmd": "ai_plan",
            "args": {"api_key": "k", "prompt": "download that video"},
        })
        self.assertTrue(r["ok"])
        self.assertEqual(r["result"]["summary"], "plan for download that video")
        self.assertTrue(any(e.get("type") == "log" and e["key"] == "log_ai_plan_ready"
                            for e in self.events))

    def test_ai_plan_error_emits_log_and_fails(self):
        _FakeOrchestrator.fail = True
        r = self.side.dispatch({
            "id": "p2", "cmd": "ai_plan",
            "args": {"api_key": "k", "prompt": "x"},
        })
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"], "boom")
        self.assertTrue(any(e.get("type") == "log" and e["key"] == "log_ai_plan_error"
                            for e in self.events))

    def test_ai_summarize_routes(self):
        r = self.side.dispatch({
            "id": "s1", "cmd": "ai_summarize",
            "args": {"api_key": "k", "results": [{"status": "done"}, {"status": "error"}]},
        })
        self.assertTrue(r["ok"])
        self.assertEqual(r["result"]["text"], "summary of 2 result(s)")


if __name__ == "__main__":
    unittest.main()
