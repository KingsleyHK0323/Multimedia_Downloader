# OpenAI-Codex_app_ui: exercise overwrite route forwarding with a fake dispatcher.
import unittest
from unittest.mock import patch

import _path  # noqa: F401 -- OpenAI-Codex: support standalone discovery.
import web_app


class OverwriteConfirmationRouteTests(unittest.TestCase):
    def test_explicit_boolean_is_required_and_forwarded(self):
        convert = {"operation_id": "synthetic", "files": ["input.mkv"],
                   "conflict_policy": "overwrite"}
        queue = {"operation_id": "synthetic", "tasks": [
            {"kind": "download", "url": "synthetic-url"},
            {"kind": "convert", "src_path": "input.mkv", "dst_path": "output.mp4",
             "conflict_policy": "overwrite"},
        ]}

        def capture(command, args, **_kwargs):
            return web_app.jsonify({"command": command, "args": args})

        with (
            # OpenAI-Codex_app_ui: isolate trusted-host configuration.
            patch.dict(web_app.app.config, {"MMDL_TRUSTED_HOSTS": web_app._configured_trusted_hosts(None),
                                        "MMDL_TRUSTED_ORIGINS": set(), "TESTING": True}),
            patch.object(web_app, "_confine_all", side_effect=lambda paths: paths),
            patch.object(web_app, "_confine", side_effect=lambda path: path),
            patch.object(web_app, "_guard_upload_path"),
            patch.object(web_app, "_save_path", side_effect=lambda value: value or "synthetic"),
            patch.object(web_app, "_dispatch", side_effect=capture) as dispatch,
        ):
            client = web_app.app.test_client()
            for path, body in (("/api/convert", convert), ("/api/run_queue", queue)):
                for candidate in ({}, {"overwrite_confirmed": False}, {"overwrite_confirmed": None},
                                  {"overwrite_confirmed": 1}, {"overwrite_confirmed": "true"}):
                    with self.subTest(path=path, candidate=candidate):
                        dispatch.reset_mock()
                        response = client.post(path, json={**body, **candidate})
                        self.assertEqual(response.status_code, 400)
                        dispatch.assert_not_called()
                dispatch.reset_mock()
                response = client.post(path, json={**body, "overwrite_confirmed": True})
                self.assertEqual(response.status_code, 200)
                self.assertIs(response.get_json()["args"]["overwrite_confirmed"], True)
                dispatch.assert_called_once()

    def test_rename_skip_and_previews_do_not_require_confirmation(self):
        def capture(command, args, **_kwargs):
            return web_app.jsonify({"command": command, "args": args})

        with (
            # OpenAI-Codex_app_ui: isolate trusted-host configuration.
            patch.dict(web_app.app.config, {"MMDL_TRUSTED_HOSTS": web_app._configured_trusted_hosts(None),
                                        "MMDL_TRUSTED_ORIGINS": set(), "TESTING": True}),
            patch.object(web_app, "_confine_all", side_effect=lambda paths: paths),
            patch.object(web_app, "_confine", side_effect=lambda path: path),
            patch.object(web_app, "_guard_upload_path"),
            patch.object(web_app, "_save_path", side_effect=lambda value: value or "synthetic"),
            patch.object(web_app, "_dispatch", side_effect=capture),
        ):
            client = web_app.app.test_client()
            for policy in ("rename", "skip"):
                for path, body in (
                    ("/api/convert", {"operation_id": "synthetic", "files": ["input.mkv"],
                                      "conflict_policy": policy}),
                    ("/api/run_queue", {"operation_id": "synthetic", "tasks": [
                        {"kind": "convert", "src_path": "input.mkv", "dst_path": "output.mp4",
                         "conflict_policy": policy}]}),
                ):
                    with self.subTest(path=path, policy=policy):
                        response = client.post(path, json=body)
                        self.assertEqual(response.status_code, 200)
                        self.assertNotIn("overwrite_confirmed", response.get_json()["args"])
            for path, body in (
                ("/api/preview_convert", {"files": ["input.mkv"]}),
                ("/api/preview_queue", {"tasks": [
                    {"kind": "convert", "task_id": "synthetic", "src_path": "input.mkv",
                     "dst_path": "output.mp4", "conflict_policy": "overwrite"}]}),
            ):
                with self.subTest(path=path):
                    response = client.post(path, json=body)
                    self.assertEqual(response.status_code, 200)
                    self.assertNotIn("overwrite_confirmed", response.get_json()["args"])
