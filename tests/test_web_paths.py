"""
Tests for the web backend's path confinement (web_app.py).

Every path in a request to the web app comes from the browser, and the engine
reads and writes wherever it is pointed. Unconfined, a LAN-exposed server would
let any client write anywhere the process can write and pull any media file on
the host back out through /files/. These tests pin the confinement that closed
that, including the documented opt-out.
"""
from __future__ import annotations

import json
import os
import posixpath
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

import _deps
import _path  # noqa: F401  — puts the project root on sys.path

# Missing flask is an error, not a silent skip: these are the tests that pin
# the path confinement, and a run without them still printed OK.
web_app = _deps.require("web_app", "requirements-web.txt")


# OpenAI-Codex_web_ai: tests own and clean only their temporary directory;
# the process environment is never changed.
_test_directory = None
_original_downloads_dir = None


def setUpModule():
    global _test_directory, _original_downloads_dir
    _test_directory = tempfile.TemporaryDirectory(prefix="mmdl-test-")
    _original_downloads_dir = web_app.DOWNLOADS_DIR
    web_app.DOWNLOADS_DIR = _test_directory.name


def tearDownModule():
    web_app.DOWNLOADS_DIR = _original_downloads_dir
    _test_directory.cleanup()


class ConfineTests(unittest.TestCase):
    def setUp(self):
        # Each test starts from the secure default, whatever the environment
        # the suite happens to run in says.
        self._saved = web_app.ALLOW_ABSOLUTE_PATHS
        web_app.ALLOW_ABSOLUTE_PATHS = False
        os.makedirs(web_app.DOWNLOADS_DIR, exist_ok=True)

    def tearDown(self):
        web_app.ALLOW_ABSOLUTE_PATHS = self._saved

    @property
    def root(self) -> str:
        return os.path.realpath(web_app.DOWNLOADS_DIR)

    # ── the allowed cases ────────────────────────────────────────────────────
    def test_blank_save_path_uses_downloads_dir(self):
        self.assertEqual(web_app._save_path(""), web_app.DOWNLOADS_DIR)
        self.assertEqual(web_app._save_path(None), web_app.DOWNLOADS_DIR)

    def test_relative_path_resolves_inside_downloads(self):
        got = web_app._save_path("clips")
        self.assertEqual(got, os.path.join(self.root, "clips"))

    def test_nested_relative_path_allowed(self):
        got = web_app._save_path("a/b/c")
        self.assertTrue(got.startswith(self.root + os.sep))

    def test_downloads_root_itself_allowed(self):
        self.assertEqual(web_app._confine("."), self.root)

    # ── the rejected cases ───────────────────────────────────────────────────
    def test_parent_traversal_rejected(self):
        with self.assertRaises(web_app.UnsafePath):
            web_app._save_path("../../etc")

    def test_absolute_path_outside_rejected(self):
        outside = "C:\\Windows\\Temp" if os.name == "nt" else "/etc"
        with self.assertRaises(web_app.UnsafePath):
            web_app._save_path(outside)

    def test_existing_symlink_to_outside_is_rejected(self):
        root = self.root
        link = os.path.join(root, "escape")
        outside = os.path.join(os.path.dirname(root), "outside")
        realpath = os.path.realpath

        def resolve(path):
            return outside if os.path.normcase(path) == os.path.normcase(link) else realpath(path)

        with patch.object(web_app.os.path, "realpath", side_effect=resolve):
            with self.assertRaises(web_app.UnsafePath):
                web_app._confine("escape")

    def test_rejection_message_names_the_opt_out(self):
        # A legitimate local user who hits this needs to know the way out.
        with self.assertRaises(web_app.UnsafePath) as ctx:
            web_app._save_path("../elsewhere")
        self.assertIn("MMDL_ALLOW_ABSOLUTE_PATHS", str(ctx.exception))

    def test_convert_inputs_are_confined(self):
        with self.assertRaises(web_app.UnsafePath):
            web_app._confine_all(["../../secrets.mp4"])
        self.assertEqual(len(web_app._confine_all(["a.mkv", "sub/b.mkv"])), 2)

    # ── AI task lists (run_queue) ────────────────────────────────────────────
    def test_task_download_save_path_confined(self):
        tasks = [{"kind": "download", "url": "u",
                  "options": {"save_path": "out", "mode": "video"}}]
        got = web_app._confine_tasks(tasks)
        self.assertTrue(got[0]["options"]["save_path"].startswith(self.root))
        # the caller's dict must not be mutated in place
        self.assertEqual(tasks[0]["options"]["save_path"], "out")

    # OpenAI-Codex_web_ai: exercise queue inputs independently of the planner.
    def test_task_download_blank_save_path_uses_downloads_root(self):
        for blank in ("", "   ", None):
            with self.subTest(blank=blank):
                got = web_app._confine_tasks([{
                    "kind": "download", "url": "u", "options": {"save_path": blank},
                }])
                self.assertEqual(os.path.realpath(got[0]["options"]["save_path"]), self.root)

    def test_task_download_missing_save_path_uses_downloads_root(self):
        got = web_app._confine_tasks([{"kind": "download", "url": "u", "options": {}}])
        self.assertEqual(os.path.realpath(got[0]["options"]["save_path"]), self.root)

    def test_opt_out_still_defaults_blank_queue_destination(self):
        web_app.ALLOW_ABSOLUTE_PATHS = True
        got = web_app._confine_tasks([{
            "kind": "download", "url": "u", "options": {"save_path": ""},
        }])
        self.assertEqual(os.path.realpath(got[0]["options"]["save_path"]), self.root)

    def test_task_download_rejects_invalid_bitrate(self):
        for value in ("0", "10000", "1.5", "１２８", 128):
            with self.subTest(value=value), self.assertRaises(web_app.UnsafePath):
                web_app._confine_tasks([{
                    "kind": "download", "url": "u",
                    "options": {"save_path": "out", "bitrate": value},
                }])

    def test_task_download_rejects_invalid_mode(self):
        with self.assertRaises(web_app.UnsafePath):
            web_app._confine_tasks([{
                "kind": "download", "url": "u",
                "options": {"save_path": "out", "mode": "unexpected"},
            }])

    def test_download_queue_preserves_task_id_and_confines_cookie(self):
        got = web_app._confine_tasks([{
            "task_id": "job-1", "kind": "download", "url": "u",
            "options": {"save_path": "out", "cookie_file": "cookie.txt", "bitrate": "320"},
        }])
        self.assertEqual(got[0]["task_id"], "job-1")
        self.assertEqual(got[0]["options"]["cookie_file"], os.path.join(self.root, "cookie.txt"))
        self.assertEqual(got[0]["options"]["bitrate"], "320")

    def test_queue_rejects_unknown_conflict_policy(self):
        with self.assertRaises(web_app.UnsafePath):
            web_app._confine_tasks([{
                "kind": "convert", "src_path": "a.mkv", "dst_path": "a.mp4",
                "conflict_policy": "delete",
            }])

    def test_task_convert_paths_confined(self):
        got = web_app._confine_tasks(
            [{"kind": "convert", "src_path": "a.mkv", "dst_path": "a.mp4"}])
        self.assertTrue(got[0]["src_path"].startswith(self.root))
        self.assertTrue(got[0]["dst_path"].startswith(self.root))

    def test_task_escaping_path_rejected(self):
        with self.assertRaises(web_app.UnsafePath):
            web_app._confine_tasks(
                [{"kind": "convert", "src_path": "../../x.mkv", "dst_path": "x.mp4"}])

    # ── the opt-out ──────────────────────────────────────────────────────────
    def test_opt_out_restores_arbitrary_paths(self):
        web_app.ALLOW_ABSOLUTE_PATHS = True
        outside = "C:\\Windows\\Temp" if os.name == "nt" else "/etc"
        self.assertEqual(web_app._save_path(outside), outside)
        self.assertEqual(web_app._confine_all([outside]), [outside])

    def test_queue_bitrate_preserved_in_both_path_modes(self):
        task = {"kind": "download", "url": "https://example.com/media",
                "options": {"save_path": "out", "mode": "audio", "bitrate": "320"}}
        for allow in (False, True):
            with self.subTest(allow_absolute=allow):
                web_app.ALLOW_ABSOLUTE_PATHS = allow
                result = web_app._confine_tasks([task])
                self.assertEqual(result[0]["options"]["bitrate"], "320")
                self.assertEqual(task["options"]["save_path"], "out")


class FormatAndBrowserTests(unittest.TestCase):
    """
    `dst_fmt` is concatenated into the output path downstream, so an unchecked
    one escapes the confined directory without ever passing through _confine().
    That is exactly how the first version of this confinement was bypassed.
    """

    def setUp(self):
        self._saved = web_app.ALLOW_ABSOLUTE_PATHS
        web_app.ALLOW_ABSOLUTE_PATHS = False

    def tearDown(self):
        web_app.ALLOW_ABSOLUTE_PATHS = self._saved

    def _fmt(self, value):
        from engine import AUDIO_FORMATS, VIDEO_FORMATS
        return web_app._choice(value, set(VIDEO_FORMATS) | set(AUDIO_FORMATS),
                               "output format", "mp4")

    def test_known_formats_accepted(self):
        for fmt in ("mp4", "mkv", "mp3", "flac"):
            self.assertEqual(self._fmt(fmt), fmt)

    def test_blank_falls_back_to_default(self):
        self.assertEqual(self._fmt(""), "mp4")
        self.assertEqual(self._fmt(None), "mp4")

    def test_traversal_in_format_rejected(self):
        # The original bypass: dst_fmt steered the output path.
        with self.assertRaises(web_app.UnsafePath):
            self._fmt("../../../../Windows/Temp/evil.mp4")

    def test_separators_in_format_rejected(self):
        for bad in ("a/b", r"a\b", "sub/x.mp4"):
            with self.assertRaises(web_app.UnsafePath):
                self._fmt(bad)

    def test_unknown_format_rejected(self):
        with self.assertRaises(web_app.UnsafePath):
            self._fmt("exe")

    def test_unknown_browser_rejected(self):
        with self.assertRaises(web_app.UnsafePath):
            web_app._choice("../etc", {"none", "chrome"}, "browser", "none")

    def test_download_format_catalogues_are_the_engine_s(self):
        # The web layer must not be narrower or wider than what the engine
        # accepts, or one of them is wrong.
        from engine import AUDIO_FORMATS, QUALITY_PRESETS, VIDEO_FORMATS
        for fmt in VIDEO_FORMATS:
            self.assertEqual(
                web_app._choice(fmt, set(VIDEO_FORMATS), "video format", "mp4"),
                fmt)
        for fmt in AUDIO_FORMATS:
            self.assertEqual(
                web_app._choice(fmt, set(AUDIO_FORMATS), "audio format", "mp3"),
                fmt)
        for q in QUALITY_PRESETS:
            self.assertEqual(
                web_app._choice(q, set(QUALITY_PRESETS), "quality", "best"), q)


class CookieFileTests(unittest.TestCase):
    """cookie_file is a server-side path like save_path, and the file most
    likely to be there is the one worth stealing."""

    def setUp(self):
        self._saved = web_app.ALLOW_ABSOLUTE_PATHS
        web_app.ALLOW_ABSOLUTE_PATHS = False

    def tearDown(self):
        web_app.ALLOW_ABSOLUTE_PATHS = self._saved

    def test_cookie_file_is_confined(self):
        got = web_app._confine_tasks([{
            "kind": "download", "url": "u",
            "options": {"save_path": "out", "cookie_file": "jar.txt"}}])
        self.assertTrue(got[0]["options"]["cookie_file"].startswith(
            os.path.realpath(web_app.DOWNLOADS_DIR)))

    def test_cookie_file_outside_rejected(self):
        outside = r"C:\secret.txt" if os.name == "nt" else "/etc/passwd"
        with self.assertRaises(web_app.UnsafePath):
            web_app._confine_tasks([{
                "kind": "download", "url": "u",
                "options": {"save_path": "out", "cookie_file": outside}}])

    def test_task_without_options_still_handled(self):
        got = web_app._confine_tasks([{"kind": "download", "url": "u"}])
        self.assertEqual(len(got), 1)


class TrustedHostTests(unittest.TestCase):
    # OpenAI-Codex_web_ai: block DNS rebinding without treating Host as auth.
    def setUp(self):
        self.previous = web_app.app.config.get("MMDL_TRUSTED_HOSTS")
        web_app.app.config["MMDL_TRUSTED_HOSTS"] = web_app._configured_trusted_hosts(None)
        self.client = web_app.app.test_client()

    def tearDown(self):
        web_app.app.config["MMDL_TRUSTED_HOSTS"] = self.previous

    def test_default_hosts_are_only_explicit_loopback_names(self):
        self.assertEqual(web_app._configured_trusted_hosts(None),
                         ["localhost", "127.0.0.1", "[::1]"])
        self.assertEqual(web_app._configured_trusted_hosts("  ,  "),
                         ["localhost", "127.0.0.1", "[::1]"])

    def test_configured_hosts_replace_default_list(self):
        self.assertEqual(web_app._configured_trusted_hosts("192.168.1.12, media.example"),
                         ["192.168.1.12", "media.example"])

    def test_explicit_lan_host_is_allowed_and_unlisted_host_is_rejected(self):
        web_app.app.config["MMDL_TRUSTED_HOSTS"] = web_app._configured_trusted_hosts("192.168.1.12")
        with patch.object(web_app, "_dispatch", side_effect=lambda *_args: web_app.jsonify({})):
            self.assertEqual(self.client.get("/api/formats", headers={"Host": "192.168.1.12:5000"}).status_code, 200)
            self.assertEqual(self.client.get("/api/formats", headers={"Host": "localhost"}).status_code, 400)

    def test_exact_loopback_host_headers_are_allowed(self):
        for host in ("localhost", "localhost:5000", "127.0.0.1:5000", "[::1]:5000"):
            with self.subTest(host=host), \
                    patch.object(web_app, "_dispatch", side_effect=lambda *_args: web_app.jsonify({})):
                response = self.client.get("/api/formats", headers={"Host": host})
                self.assertEqual(response.status_code, 200)

    def test_rebinding_and_other_ipv6_hosts_are_rejected(self):
        for host in ("attacker.invalid", "127.0.0.2:5000", "[::2]:5000", "::1"):
            with self.subTest(host=host):
                response = self.client.get("/api/formats", headers={"Host": host})
                self.assertEqual(response.status_code, 400)

    def test_spoofed_matching_origin_does_not_authorize_untrusted_host(self):
        response = self.client.post("/api/download", json={"urls": ["u"]}, headers={
            "Host": "attacker.invalid", "Origin": "http://attacker.invalid",
        })
        self.assertEqual(response.status_code, 400)

    def test_ipv6_and_host_parser_enforces_exact_names(self):
        allowed = ["localhost", "127.0.0.1", "[::1]"]
        for host in ("LOCALHOST:5000", "127.0.0.1:5000", "[::1]:5000"):
            with self.subTest(host=host):
                self.assertTrue(web_app._is_trusted_host(host, allowed))
        for host in ("localhost.attacker.invalid", "localhost@attacker.invalid", "[::2]:5000",
                     "::1", "[::1]attacker", "[::1]:not-a-port", "localhost:5000/path",
                     "local\u200bhost"):
            with self.subTest(host=host):
                self.assertFalse(web_app._is_trusted_host(host, allowed))

    def test_ipv6_suffix_rejected_even_with_lenient_url_parser(self):
        class Parsed:
            username = password = None
            path = query = fragment = ""
            hostname = "::1"
            port = 5000

        with patch.object(web_app, "urlsplit", return_value=Parsed()):
            for authority in ("[::1]junk", "[::1]junk:5000", "[::1]:not-a-port"):
                with self.subTest(authority=authority):
                    self.assertIsNone(web_app._hostname(authority))

    def test_cross_origin_and_non_json_are_rejected(self):
        response = self.client.post("/api/download", json={"urls": ["u"]},
                                    headers={"Origin": "http://attacker.invalid"})
        self.assertEqual(response.status_code, 403)
        response = self.client.post("/api/download", data="{}", content_type="text/plain")
        self.assertEqual(response.status_code, 415)

    def test_explicit_extra_origin_is_allowed(self):
        web_app.app.config["MMDL_TRUSTED_ORIGINS"] = {"https://trusted.example"}
        with patch.object(web_app, "_dispatch", return_value=("", 204)):
            response = self.client.post("/api/download", json={"operation_id": "test-reservation", "urls": ["u"]},
                                        headers={"Origin": "https://trusted.example"})
            self.assertEqual(response.status_code, 204)

    def test_same_and_missing_origin_are_allowed(self):
        with patch.object(web_app, "_dispatch", return_value=("", 204)):
            for headers in ({}, {"Origin": "http://localhost"}):
                with self.subTest(headers=headers):
                    response = self.client.post("/api/download", json={"operation_id": "test-reservation", "urls": ["u"]}, headers=headers)
                    self.assertEqual(response.status_code, 204)


class ServerUrlTests(unittest.TestCase):
    def test_ipv6_host_is_bracketed_for_display(self):
        self.assertEqual(web_app._server_url("::1", 5000), "http://[::1]:5000")
        self.assertEqual(web_app._server_url("[::1]", 5000), "http://[::1]:5000")
        self.assertEqual(web_app._server_url("127.0.0.1", 8080), "http://127.0.0.1:8080")


class EndpointTests(unittest.TestCase):
    """A rejected path must read as a client error, not a server crash."""

    def setUp(self):
        self._saved = web_app.ALLOW_ABSOLUTE_PATHS
        self._saved_hosts = web_app.app.config.get("MMDL_TRUSTED_HOSTS")
        self._saved_origins = web_app.app.config.get("MMDL_TRUSTED_ORIGINS")
        self._saved_testing = web_app.app.config.get("TESTING")
        self._saved_sidecar = web_app._sidecar
        web_app._sidecar = web_app.Sidecar(lambda _event: None)
        web_app.ALLOW_ABSOLUTE_PATHS = False
        web_app.app.config["MMDL_TRUSTED_HOSTS"] = web_app._configured_trusted_hosts(None)
        web_app.app.config["MMDL_TRUSTED_ORIGINS"] = set()
        web_app.app.config["TESTING"] = True
        self.client = web_app.app.test_client()

    def tearDown(self):
        web_app.ALLOW_ABSOLUTE_PATHS = self._saved
        web_app.app.config["MMDL_TRUSTED_HOSTS"] = self._saved_hosts
        web_app.app.config["MMDL_TRUSTED_ORIGINS"] = self._saved_origins
        web_app.app.config["TESTING"] = self._saved_testing
        web_app._sidecar = self._saved_sidecar

    def _reserve(self, command):
        response = self.client.post("/api/operations", json={"command": command})
        self.assertEqual(response.status_code, 200)
        return response.get_json()["operation_id"]

    # OpenAI-Codex_web_ai: exercise reservation identity and pre-start stop.
    def test_prepare_and_release_forward_the_contract(self):
        prepared = {"operation_id": "reservation-1", "command": "download", "expires_in": 120,
                    "instance_id": "instance-a"}
        responses = [
            {"id": "prepare", "ok": True, "result": prepared},
            {"id": "release", "ok": True, "result": {"released": True}},
        ]
        with patch.object(web_app._sidecar, "dispatch", side_effect=responses) as dispatch:
            create = self.client.post("/api/operations", json={"command": "download"})
            release = self.client.post("/api/operations/release", json={"operation_id": "reservation-1"})
        self.assertEqual(create.status_code, 200)
        self.assertEqual(create.get_json(), prepared)
        self.assertEqual(release.get_json(), {"released": True})
        self.assertEqual(dispatch.call_args_list[0].args[0]["args"], {"command": "download"})
        self.assertEqual(dispatch.call_args_list[1].args[0]["args"], {"operation_id": "reservation-1"})

    # OpenAI-Codex_web_ai: status reports lifecycle only, not operation success.
    def test_operation_status_forwards_the_identity_and_lifecycle_state(self):
        cases = (("reserved", False), ("running", False), ("completed", True),
                 ("completed", False), ("released", True), ("released", False),
                 ("unknown", True), ("unknown", False))
        for state, idle in cases:
            expected = {"state": state, "instance_id": "instance-a", "idle": idle}
            with self.subTest(state=state, idle=idle), \
                    patch.object(web_app._sidecar, "dispatch", return_value={
                        "id": "status", "ok": True, "result": expected,
                    }) as dispatch:
                response = self.client.post("/api/operations/status", json={"operation_id": "op-a"})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.get_json(), expected)
                req = dispatch.call_args.args[0]
                self.assertEqual(req["cmd"], "status")
                self.assertEqual(req["args"], {"operation_id": "op-a"})

    # OpenAI-Codex_web_ai: a lost release response can be checked until expiry.
    def test_released_status_expires_without_affecting_a_new_reservation(self):
        sidecar_module = sys.modules[web_app.Sidecar.__module__]
        now = [100.0]
        with patch.object(sidecar_module, "time", types.SimpleNamespace(monotonic=lambda: now[0])):
            prepared = self.client.post("/api/operations", json={"command": "download"}).get_json()
            old, instance_id = prepared["operation_id"], prepared["instance_id"]
            self.client.post("/api/operations/release", json={"operation_id": old})
            self.assertEqual(self.client.post("/api/operations/status", json={"operation_id": old}).get_json(),
                             {"state": "released", "instance_id": instance_id, "idle": True})
            new = self._reserve("download")
            self.assertEqual(self.client.post("/api/operations/status", json={"operation_id": old}).get_json(),
                             {"state": "released", "instance_id": instance_id, "idle": False})
            self.assertEqual(self.client.post("/api/operations/status", json={"operation_id": new}).get_json(),
                             {"state": "reserved", "instance_id": instance_id, "idle": False})
            self.assertEqual(self.client.post("/api/operations/status", json={"operation_id": "never-known"}).get_json(),
                             {"state": "unknown", "instance_id": instance_id, "idle": False})
            self.assertFalse(self.client.post("/api/stop", json={"operation_id": old}).get_json()["stopping"])
            stale_start = self.client.post("/api/download", json={"operation_id": old, "urls": ["u"]})
            self.assertEqual(stale_start.status_code, 409)
            self.assertEqual(self.client.post("/api/operations/status", json={"operation_id": new}).get_json(),
                             {"state": "reserved", "instance_id": instance_id, "idle": False})
            now[0] += 300
            self.assertEqual(self.client.post("/api/operations/status", json={"operation_id": old}).get_json(),
                             {"state": "unknown", "instance_id": instance_id, "idle": True})
            with patch.object(web_app, "_sidecar", web_app.Sidecar(lambda _event: None)):
                after_restart = self.client.post("/api/operations/status", json={"operation_id": old}).get_json()
            self.assertEqual(after_restart["state"], "unknown")
            self.assertTrue(after_restart["idle"])
            self.assertNotEqual(after_restart["instance_id"], instance_id)

    def test_operation_status_rejects_missing_and_invalid_ids(self):
        with patch.object(web_app._sidecar, "dispatch") as dispatch:
            for body in ({}, {"operation_id": ""}, {"operation_id": "   "},
                         {"operation_id": None}, {"operation_id": 1}):
                with self.subTest(body=body):
                    response = self.client.post("/api/operations/status", json=body)
                    self.assertEqual(response.status_code, 400)
            dispatch.assert_not_called()

    def test_operation_endpoints_require_valid_input(self):
        with patch.object(web_app._sidecar, "dispatch") as dispatch, \
                patch.object(web_app.os, "makedirs") as mkdir:
            for body in ({}, {"command": "ai_plan"}, {"command": []}):
                self.assertEqual(self.client.post("/api/operations", json=body).status_code, 400)
            for path, body in (("/api/download", {"urls": ["u"]}),
                               ("/api/convert", {"files": ["a.mkv"]}),
                               ("/api/run_queue", {"tasks": []}),
                               ("/api/stop", {}), ("/api/operations/release", {})):
                with self.subTest(path=path):
                    self.assertEqual(self.client.post(path, json=body).status_code, 400)
            dispatch.assert_not_called()
            mkdir.assert_not_called()

    def test_start_forwards_identity_and_deferred_directory_creation(self):
        operation_id = self._reserve("download")
        response_data = {"id": "download", "ok": True, "result": {"results": []}}
        with patch.object(web_app._sidecar, "dispatch", return_value=response_data) as dispatch, \
                patch.object(web_app.os, "makedirs") as mkdir:
            response = self.client.post("/api/download", json={
                "operation_id": operation_id, "urls": ["u"],
            })
            self.assertEqual(response.status_code, 200)
            req = dispatch.call_args.args[0]
            self.assertEqual(req["operation_id"], operation_id)
            self.assertTrue(callable(req["before_execute"]))
            mkdir.assert_not_called()
            req["before_execute"]()
            mkdir.assert_called_once_with(web_app.DOWNLOADS_DIR, exist_ok=True)

    def test_cancelled_reservations_do_not_create_downloads_directory(self):
        cases = (("download", "/api/download", {"urls": ["u"]}),
                 ("convert", "/api/convert", {"files": ["a.mkv"]}),
                 ("run_queue", "/api/run_queue", {"tasks": [
                     {"kind": "download", "url": "u", "options": {"save_path": ""}},
                 ]}))
        for command, path, body in cases:
            with self.subTest(command=command), \
                    patch.object(web_app, "_sidecar", web_app.Sidecar(lambda _event: None)), \
                    patch.object(web_app.os, "makedirs") as mkdir:
                prepared = self.client.post("/api/operations", json={"command": command}).get_json()
                operation_id = prepared["operation_id"]
                stopped = self.client.post("/api/stop", json={"operation_id": operation_id})
                self.assertTrue(stopped.get_json()["stopping"])
                result = self.client.post(path, json={**body, "operation_id": operation_id})
                self.assertEqual(result.status_code, 200)
                self.assertTrue(result.get_json()["summary"]["cancelled"])
                mkdir.assert_not_called()

    def test_stale_operation_cannot_stop_or_start_the_next_reservation(self):
        with patch.object(web_app, "_sidecar", web_app.Sidecar(lambda _event: None)), \
                patch.object(web_app.os, "makedirs") as mkdir:
            first = self.client.post("/api/operations", json={"command": "download"}).get_json()["operation_id"]
            self.client.post("/api/stop", json={"operation_id": first})
            first_result = self.client.post("/api/download", json={"urls": ["u"], "operation_id": first})
            self.assertTrue(first_result.get_json()["summary"]["cancelled"])
            second = self.client.post("/api/operations", json={"command": "download"}).get_json()["operation_id"]
            first_status = self.client.post("/api/operations/status", json={"operation_id": first}).get_json()
            second_status = self.client.post("/api/operations/status", json={"operation_id": second}).get_json()
            self.assertEqual(first_status["state"], "completed")
            self.assertEqual(second_status["state"], "reserved")
            self.assertEqual(first_status["instance_id"], second_status["instance_id"])
            self.assertFalse(first_status["idle"])
            self.assertFalse(second_status["idle"])
            stale_stop = self.client.post("/api/stop", json={"operation_id": first})
            self.assertFalse(stale_stop.get_json()["stopping"])
            stale_start = self.client.post("/api/download", json={"urls": ["u"], "operation_id": first})
            self.assertEqual(stale_start.status_code, 409)
            self.assertEqual(stale_start.get_json()["error_code"], "invalid_operation")
            self.assertEqual(self.client.post("/api/operations/status", json={"operation_id": second}).get_json(),
                             second_status)
            self.assertTrue(self.client.post("/api/stop", json={"operation_id": second}).get_json()["stopping"])
            second_result = self.client.post("/api/download", json={"urls": ["u"], "operation_id": second})
            self.assertTrue(second_result.get_json()["summary"]["cancelled"])
            mkdir.assert_not_called()

    def test_heartbeat_is_a_message_and_subscription_is_cleaned_up(self):
        class IdleQueue:
            def get(self, timeout):
                self.timeout = timeout
                raise web_app.queue.Empty

        idle = IdleQueue()
        with web_app.app.test_request_context("/events"), \
                patch.object(web_app.queue, "Queue", return_value=idle):
            response = web_app.events()
            stream = iter(response.response)
            self.assertEqual(next(stream), ": connected\n\n")
            message = next(stream)
            self.assertTrue(message.startswith("data: "))
            self.assertEqual(json.loads(message[len("data: "):].strip()), {"type": "heartbeat"})
            self.assertEqual(idle.timeout, 15)
            stream.close()
            self.assertNotIn(idle, web_app._subscribers)

    def test_unknown_id_is_rejected_without_creating_directory(self):
        with patch.object(web_app.os, "makedirs") as mkdir:
            response = self.client.post("/api/download", json={"operation_id": "unknown", "urls": ["u"]})
            self.assertEqual(response.status_code, 409)
            self.assertEqual(response.get_json()["error_code"], "invalid_operation")
            self.assertFalse(self.client.post("/api/stop", json={"operation_id": "unknown"}).get_json()["stopping"])
            mkdir.assert_not_called()

    def test_ai_plan_is_busy_while_a_reservation_exists(self):
        self._reserve("download")
        response = self.client.post("/api/ai_plan", json={"prompt": "example"})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.get_json()["error_code"], "busy")

    def test_control_endpoints_keep_origin_host_and_json_checks(self):
        for path, body in (("/api/operations", {"command": "download"}),
                           ("/api/operations/release", {"operation_id": "op"}),
                           ("/api/operations/status", {"operation_id": "op"}),
                           ("/api/stop", {"operation_id": "op"}),
                           ("/api/preview_convert", {"files": ["a.mkv"]}),
                           ("/api/preview_queue", {"tasks": []})):
            with self.subTest(path=path):
                self.assertEqual(self.client.post(path, json=body,
                                 headers={"Origin": "https://attacker.invalid"}).status_code, 403)
                self.assertEqual(self.client.post(path, json=body,
                                 headers={"Host": "attacker.invalid"}).status_code, 400)
                self.assertEqual(self.client.post(path, data=json.dumps(body),
                                 content_type="text/plain").status_code, 415)

    # OpenAI-Codex_web_ai: preview AI destinations without authorizing execution.
    def test_queue_preview_confines_paths_and_allows_read_only_overwrite(self):
        root = os.path.realpath(web_app.DOWNLOADS_DIR)
        source = os.path.join(root, "a.mkv")
        destination = os.path.join(root, "chosen", "different.flac")
        rows = [{"task_id": "job-a", "src": source, "dst": destination,
                 "existing": "missing", "batch_duplicate": False, "source_matches": "no"}]
        result = {"id": "preview_queue", "ok": True, "result": {"jobs": rows}}
        task = {"task_id": "job-a", "kind": "convert", "src_path": "a.mkv",
                "dst_path": "chosen/different.flac", "conflict_policy": "overwrite"}
        with patch.object(web_app._sidecar, "dispatch", return_value=result) as dispatch, \
                patch.object(web_app.os, "makedirs") as mkdir:
            response = self.client.post("/api/preview_queue", json={"tasks": [task]})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.get_json()["jobs"][0], {
                "task_id": "job-a", "src": "a.mkv", "dst": "chosen/different.flac",
                "existing": "missing", "batch_duplicate": False, "source_matches": "no",
            })
            req = dispatch.call_args.args[0]
            self.assertEqual(req["cmd"], "preview_queue")
            self.assertEqual(req["args"]["tasks"][0]["src_path"], source)
            self.assertEqual(req["args"]["tasks"][0]["dst_path"], destination)
            self.assertNotIn("operation_id", req)
            self.assertNotIn("before_execute", req)
            mkdir.assert_not_called()

    def test_queue_preview_rejects_invalid_and_escaping_paths_without_dispatch(self):
        valid = {"task_id": "one", "kind": "convert", "src_path": "a.mkv", "dst_path": "b.mp4"}
        cases = (None, {}, [valid, dict(valid)], [{**valid, "task_id": " "}],
                 [{**valid, "kind": "download"}], [{**valid, "src_path": "../private.mkv"}],
                 [{**valid, "dst_path": "../private.mp4"}], [{**valid, "conflict_policy": "delete"}])
        with patch.object(web_app._sidecar, "dispatch") as dispatch, \
                patch.object(web_app.os, "makedirs") as mkdir:
            for tasks in cases:
                with self.subTest(tasks=tasks):
                    response = self.client.post("/api/preview_queue", json={"tasks": tasks})
                    self.assertEqual(response.status_code, 400)
            dispatch.assert_not_called()
            mkdir.assert_not_called()

    def test_queue_preview_hides_resolved_external_paths(self):
        root = os.path.realpath(web_app.DOWNLOADS_DIR)
        outside = os.path.join(os.path.dirname(root), "outside", "secret.mp4")
        rows = [{"task_id": "job-a", "src": os.path.join(root, "a.mkv"), "dst": outside,
                 "existing": "exists", "batch_duplicate": False, "source_matches": "unknown"}]
        result = {"id": "preview_queue", "ok": True, "result": {"jobs": rows}}
        task = {"task_id": "job-a", "kind": "convert", "src_path": "a.mkv", "dst_path": "link.mp4"}
        with patch.object(web_app._sidecar, "dispatch", return_value=result):
            response = self.client.post("/api/preview_queue", json={"tasks": [task]})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["jobs"][0]["dst"], "[unavailable]")
        self.assertNotIn(outside, response.get_data(as_text=True))

    def test_queue_preview_rejects_external_symlink_without_leaking_target(self):
        root = os.path.realpath(web_app.DOWNLOADS_DIR)
        link = os.path.join(root, "link.mp4")
        outside = os.path.join(os.path.dirname(root), "outside", "secret.mp4")
        realpath = os.path.realpath

        def resolve(path):
            if os.path.normcase(path) == os.path.normcase(link):
                return outside
            return realpath(path)

        task = {"task_id": "job-a", "kind": "convert", "src_path": "a.mkv", "dst_path": "link.mp4"}
        with patch.object(web_app.os.path, "realpath", side_effect=resolve), \
                patch.object(web_app._sidecar, "dispatch") as dispatch:
            response = self.client.post("/api/preview_queue", json={"tasks": [task]})
            dispatch.assert_not_called()
        self.assertEqual(response.status_code, 400)
        self.assertNotIn(outside, response.get_data(as_text=True))

    def test_preview_conversion_is_read_only_and_preserves_the_result(self):
        root = os.path.realpath(web_app.DOWNLOADS_DIR)
        jobs = [{"src": os.path.join(root, "a.mkv"), "dst": os.path.join(root, "a.mp4"),
                 "existing": "missing", "batch_duplicate": False, "source_matches": "no"}]
        result = {"id": "preview_convert", "ok": True, "result": {"jobs": jobs}}
        with patch.object(web_app._sidecar, "dispatch", return_value=result) as dispatch, \
                patch.object(web_app.os, "makedirs") as mkdir:
            response = self.client.post("/api/preview_convert", json={
                "files": ["a.mkv"], "dst_fmt": "mp4", "save_path": "",
            })
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.get_json()["jobs"][0], {
                "src": "a.mkv", "dst": "a.mp4", "existing": "missing",
                "batch_duplicate": False, "source_matches": "no",
            })
            req = dispatch.call_args.args[0]
            self.assertEqual(req["cmd"], "preview_convert")
            self.assertEqual(req["args"], {"files": [os.path.join(root, "a.mkv")],
                                           "dst_fmt": "mp4", "save_path": web_app.DOWNLOADS_DIR})
            self.assertNotIn("operation_id", req)
            self.assertNotIn("before_execute", req)
            mkdir.assert_not_called()

    def test_preview_hides_paths_outside_downloads_in_restricted_mode(self):
        root = os.path.realpath(web_app.DOWNLOADS_DIR)
        outside = os.path.join(os.path.dirname(root), "external", "clip.mkv")
        self.assertEqual(web_app._preview_display_path(outside), "[unavailable]")

    # OpenAI-Codex_web_ai: model symlink and alias paths without touching disk.
    def test_preview_display_does_not_resolve_an_external_symlink_target(self):
        resolved = []

        def abspath(path):
            return posixpath.normpath(path if path.startswith("/") else "/server/" + path)

        def realpath(path):
            path = abspath(path)
            resolved.append(path)
            return {"/aliasroot": "/data/downloads",
                    "/data/downloads/link.mp4": "/private/secret.mp4",
                    "/outside-alias/file.mp4": "/data/downloads/file.mp4"}.get(path, path)

        path = types.SimpleNamespace(abspath=abspath, realpath=realpath,
                                     normcase=lambda value: value, commonpath=posixpath.commonpath,
                                     relpath=posixpath.relpath, isabs=posixpath.isabs)
        fake_os = types.SimpleNamespace(path=path, sep="/", pardir="..")
        with patch.object(web_app, "os", fake_os), \
                patch.object(web_app, "DOWNLOADS_DIR", "/aliasroot"), \
                patch.object(web_app, "ALLOW_ABSOLUTE_PATHS", False):
            self.assertEqual(web_app._preview_display_path("/data/downloads/link.mp4"), "link.mp4")
            self.assertEqual(web_app._preview_display_path("/aliasroot/inside.mp4"), "inside.mp4")
            self.assertEqual(web_app._preview_display_path("/outside-alias/file.mp4"), "[unavailable]")
            self.assertEqual(web_app._preview_display_path("/aliasroot/../private/secret.mp4"), "[unavailable]")
            self.assertEqual(web_app._preview_display_path(None), "[unavailable]")
            self.assertNotIn("/data/downloads/link.mp4", resolved)
            self.assertNotIn("/outside-alias/file.mp4", resolved)

    def test_preview_opt_out_retains_external_server_paths(self):
        root = os.path.realpath(web_app.DOWNLOADS_DIR)
        source = os.path.join(os.path.dirname(root), "external", "clip.mkv")
        destination = os.path.join(os.path.dirname(root), "external", "clip.mp4")
        result = {"id": "preview_convert", "ok": True, "result": {"jobs": [{
            "src": source, "dst": destination, "existing": "unknown",
            "batch_duplicate": False, "source_matches": "unknown",
        }]}}
        web_app.ALLOW_ABSOLUTE_PATHS = True
        with patch.object(web_app._sidecar, "dispatch", return_value=result), \
                patch.object(web_app.os, "makedirs") as mkdir:
            response = self.client.post("/api/preview_convert", json={
                "files": [source], "dst_fmt": "mp4", "save_path": os.path.dirname(destination),
            })
            self.assertEqual(response.status_code, 200)
            job = response.get_json()["jobs"][0]
            self.assertEqual(job["src"], os.path.realpath(source))
            self.assertEqual(job["dst"], os.path.realpath(destination))
            mkdir.assert_not_called()

    def test_preview_rejects_escaping_paths_and_format_without_writes(self):
        cases = ({"files": ["../secret.mkv"]},
                 {"files": ["a.mkv"], "save_path": "../outside"},
                 {"files": ["a.mkv"], "dst_fmt": "../mp4"})
        with patch.object(web_app._sidecar, "dispatch") as dispatch, \
                patch.object(web_app.os, "makedirs") as mkdir:
            for body in cases:
                with self.subTest(body=body):
                    self.assertEqual(self.client.post("/api/preview_convert", json=body).status_code, 400)
            dispatch.assert_not_called()
            mkdir.assert_not_called()

    def test_convert_with_escaping_path_returns_400(self):
        r = self.client.post("/api/convert",
                             json={"operation_id": "op", "files": ["../../etc/passwd"], "dst_fmt": "mp4"})
        self.assertEqual(r.status_code, 400)
        self.assertIn("outside", r.get_json()["error"])

    def test_convert_with_escaping_format_returns_400(self):
        r = self.client.post("/api/convert",
                             json={"operation_id": "op", "files": ["a.mkv"], "dst_fmt": "../../x.mp4"})
        self.assertEqual(r.status_code, 400)

    def test_run_queue_with_escaping_path_returns_400(self):
        r = self.client.post("/api/run_queue", json={"operation_id": "op", "tasks": [
            {"kind": "convert", "src_path": "../../x.mkv", "dst_path": "x.mp4"}]})
        self.assertEqual(r.status_code, 400)

    def test_download_format_fields_return_400(self):
        # /api/download feeds video_fmt into yt-dlp's merge_output_format --
        # which decides %(ext)s, and so the output path -- and feeds video_fmt
        # and quality into the format-selector string. The engine rejects these
        # too; checking here only turns a 500 into a 400.
        for field, bad in (("video_fmt", "../../x"),
                           ("audio_fmt", "../../x"),
                           ("quality", "0]/all[height>0"),
                           ("mode", "../../x")):
            with self.subTest(field=field):
                r = self.client.post("/api/download",
                                     json={"operation_id": "op", "urls": ["u"], field: bad})
                self.assertEqual(r.status_code, 400)

    # OpenAI-Codex_web_ai: assert the externally observable Web request contract.
    def test_download_forwards_bitrate_and_confined_cookie_file(self):
        operation_id = self._reserve("download")
        def capture(_cmd, args, **_kwargs):
            return web_app.jsonify(args)

        with patch.object(web_app, "_dispatch", side_effect=capture):
            response = self.client.post("/api/download", json={
                "operation_id": operation_id, "urls": ["u"], "bitrate": "320", "cookie_file": "cookies.txt",
            })
        self.assertEqual(response.status_code, 200)
        options = response.get_json()["options"]
        self.assertEqual(options["bitrate"], "320")
        self.assertEqual(options["cookie_file"],
                         os.path.join(os.path.realpath(web_app.DOWNLOADS_DIR), "cookies.txt"))

    def test_download_rejects_outside_cookie_file_and_invalid_bitrate(self):
        for fields in ({"cookie_file": "../outside.txt"}, {"bitrate": "1.5"}):
            with self.subTest(fields=fields):
                response = self.client.post("/api/download", json={"operation_id": "op", "urls": ["u"], **fields})
                self.assertEqual(response.status_code, 400)

    def test_convert_forwards_and_validates_conflict_policy(self):
        operation_id = self._reserve("convert")
        def capture(_cmd, args, **_kwargs):
            return web_app.jsonify(args)

        with patch.object(web_app, "_dispatch", side_effect=capture):
            response = self.client.post("/api/convert", json={
                "operation_id": operation_id, "files": ["a.mkv"], "conflict_policy": "skip",
            })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["conflict_policy"], "skip")
        response = self.client.post("/api/convert", json={
            "operation_id": "op", "files": ["a.mkv"], "conflict_policy": "delete",
        })
        self.assertEqual(response.status_code, 400)

    def test_overwrite_requires_explicit_confirmation_for_convert_and_queue(self):
        convert = {"operation_id": "op", "files": ["a.mkv"], "conflict_policy": "overwrite"}
        queue = {"operation_id": "op", "tasks": [{"kind": "convert", "src_path": "a.mkv", "dst_path": "a.mp4",
                            "conflict_policy": "overwrite"}]}
        for path, command, body in (("/api/convert", "convert", convert), ("/api/run_queue", "run_queue", queue)):
            with self.subTest(path=path):
                self.assertEqual(self.client.post(path, json=body).status_code, 400)
                operation_id = self._reserve(command)
                with patch.object(web_app, "_dispatch", side_effect=lambda _cmd, args, **_kwargs: web_app.jsonify(args)):
                    response = self.client.post(path, json={**body, "operation_id": operation_id,
                                                            "overwrite_confirmed": True})
                self.assertEqual(response.status_code, 200)
                self.client.post("/api/operations/release", json={"operation_id": operation_id})

    def test_busy_dispatch_is_reported_as_conflict(self):
        operation_id = self._reserve("download")
        busy = {"id": "download", "ok": False, "error_code": "busy",
                "error": "another operation is already running"}
        with patch.object(web_app._sidecar, "dispatch", return_value=busy):
            response = self.client.post("/api/download", json={"operation_id": operation_id, "urls": ["u"]})
        self.assertEqual(response.status_code, 409)

    def test_conversion_response_links_only_existing_confined_outputs(self):
        operation_id = self._reserve("convert")
        root = os.path.realpath(web_app.DOWNLOADS_DIR)
        inside = os.path.join(root, "clip #1.mp4")
        outside = os.path.join(os.path.dirname(root), "outside.mp4")
        result = {"id": "convert", "ok": True, "result": {"jobs": [
            {"src": "a", "dst": inside, "status": "done", "error": ""},
            {"src": "b", "dst": outside, "status": "done", "error": ""},
        ]}}
        with patch.object(web_app._sidecar, "dispatch", return_value=result), \
                patch.object(web_app.os.path, "isfile", return_value=True):
            response = self.client.post("/api/convert", json={"operation_id": operation_id, "files": ["a.mkv"]})
        jobs = response.get_json()["jobs"]
        self.assertEqual(jobs[0]["download_url"], "/files/clip%20%231.mp4")
        self.assertNotIn("download_url", jobs[1])

    def test_relative_downloads_directory_uses_process_relative_output(self):
        with web_app.app.test_request_context("/"), \
                patch.object(web_app, "DOWNLOADS_DIR", "relative-downloads"), \
                patch.object(web_app.os.path, "isfile", return_value=True):
            link = web_app._output_url(os.path.join("relative-downloads", "clip.mp4"))
        self.assertEqual(link, "/files/clip.mp4")

    def test_windows_nested_file_uses_url_path_separators(self):
        with web_app.app.test_request_context("/"), \
                patch.object(web_app.os.path, "relpath", return_value=r"nested\clip.mp4"), \
                patch.object(web_app.os, "sep", "\\"), \
                patch.object(web_app, "send_from_directory", return_value="sent") as send:
            self.assertEqual(web_app.files("nested/clip.mp4"), "sent")
        self.assertEqual(send.call_args.args[1], "nested/clip.mp4")

    def test_nested_file_can_be_retrieved(self):
        nested = os.path.join(web_app.DOWNLOADS_DIR, "nested")
        os.makedirs(nested, exist_ok=True)
        with open(os.path.join(nested, "sample.txt"), "wb") as output:
            output.write(b"synthetic media")
        response = self.client.get("/files/nested/sample.txt", buffered=True)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, b"synthetic media")

    def test_cross_origin_post_is_rejected(self):
        response = self.client.post("/api/download", json={"operation_id": "op", "urls": ["u"]},
                                    headers={"Origin": "https://attacker.invalid"})
        self.assertEqual(response.status_code, 403)

    def test_same_origin_and_no_origin_clients_can_post(self):
        operation_id = self._reserve("download")
        with patch.object(web_app, "_dispatch", side_effect=lambda _cmd, args, **_kwargs: web_app.jsonify(args)):
            for headers in ({}, {"Origin": "http://localhost"}):
                with self.subTest(headers=headers):
                    response = self.client.post("/api/download", json={"operation_id": operation_id, "urls": ["u"]}, headers=headers)
                    self.assertEqual(response.status_code, 200)

    def test_explicit_trusted_origin_can_post_through_proxy(self):
        operation_id = self._reserve("download")
        previous = web_app.app.config.get("MMDL_TRUSTED_ORIGINS")
        web_app.app.config["MMDL_TRUSTED_ORIGINS"] = {"https://media.example"}
        try:
            with patch.object(web_app, "_dispatch", side_effect=lambda _cmd, args, **_kwargs: web_app.jsonify(args)):
                response = self.client.post("/api/download", json={"operation_id": operation_id, "urls": ["u"]},
                                            headers={"Origin": "https://media.example"})
            self.assertEqual(response.status_code, 200)
        finally:
            web_app.app.config["MMDL_TRUSTED_ORIGINS"] = previous

    def test_configured_trusted_host_rejects_other_hosts(self):
        previous = web_app.app.config.get("MMDL_TRUSTED_HOSTS")
        web_app.app.config["MMDL_TRUSTED_HOSTS"] = ["localhost"]
        try:
            response = self.client.post("/api/download", json={"urls": ["u"]},
                                        headers={"Host": "attacker.invalid"})
            self.assertEqual(response.status_code, 400)
        finally:
            web_app.app.config["MMDL_TRUSTED_HOSTS"] = previous

    def test_text_plain_post_is_not_treated_as_json(self):
        response = self.client.post("/api/download", data='{"urls":["u"]}',
                                    content_type="text/plain")
        self.assertEqual(response.status_code, 415)

    def test_download_cookie_path_validation_and_opt_out(self):
        with patch.object(web_app, "_dispatch", return_value=("", 204)) as dispatch:
            for value in (None, "", "   "):
                response = self.client.post("/api/download", json={"operation_id": "test-reservation", "urls": ["u"], "cookie_file": value})
                self.assertEqual(response.status_code, 204)
                self.assertIsNone(dispatch.call_args.args[1]["options"]["cookie_file"])
            response = self.client.post("/api/download", json={"operation_id": "test-reservation", "urls": ["u"], "cookie_file": "cookies.txt"})
            self.assertEqual(response.status_code, 204)
            self.assertEqual(dispatch.call_args.args[1]["options"]["cookie_file"],
                             os.path.join(os.path.realpath(web_app.DOWNLOADS_DIR), "cookies.txt"))
            response = self.client.post("/api/download", json={"operation_id": "test-reservation", "urls": ["u"], "cookie_file": " spaced.txt "})
            self.assertEqual(response.status_code, 204)
            self.assertTrue(dispatch.call_args.args[1]["options"]["cookie_file"].endswith(" spaced.txt "))
            outside_default = os.path.abspath(os.path.join(web_app.DOWNLOADS_DIR, "..", "outside.txt"))
            for value in ("../outside.txt", outside_default, "bad\x00path", 42):
                with self.subTest(value=value):
                    response = self.client.post("/api/download", json={"operation_id": "test-reservation", "urls": ["u"], "cookie_file": value})
                    self.assertEqual(response.status_code, 400)
            web_app.ALLOW_ABSOLUTE_PATHS = True
            outside = os.path.abspath("outside.txt")
            response = self.client.post("/api/download", json={"operation_id": "test-reservation", "urls": ["u"], "cookie_file": outside})
            self.assertEqual(response.status_code, 204)
            self.assertEqual(dispatch.call_args.args[1]["options"]["cookie_file"], outside)

    def test_download_forwards_audio_bitrate_and_default(self):
        with patch.object(web_app, "_dispatch", return_value=("", 204)) as dispatch:
            for supplied, expected in (("0320", "320"), (None, "192")):
                body = {"operation_id": "test-reservation", "urls": ["https://example.com/media"], "mode": "audio"}
                if supplied is not None:
                    body["bitrate"] = supplied
                response = self.client.post("/api/download", json=body)
                self.assertEqual(response.status_code, 204)
                self.assertEqual(dispatch.call_args.args[1]["options"]["bitrate"], expected)

    def test_download_rejects_invalid_bitrate(self):
        with patch.object(web_app, "_dispatch", return_value=("", 204)) as dispatch:
            for bad in ("0", "10000", "1.5", "１２８", 192, None):
                with self.subTest(bitrate=bad):
                    response = self.client.post("/api/download",
                                                json={"operation_id": "test-reservation", "urls": ["https://example.com/media"], "bitrate": bad})
                    self.assertEqual(response.status_code, 400)
            dispatch.assert_not_called()

# OpenAI-Codex_web_ai: upload route and path checks use only synthetic state.
class UploadSyntheticTests(unittest.TestCase):
    class FakeError(Exception):
        statuses = {"invalid_request": 400, "too_large": 413, "unsafe_path": 403, "unavailable": 503}

        def __init__(self, code):
            super().__init__(code)
            self.code = code
            self.http_status = self.statuses[code]

    class FakeStore:
        def __init__(self):
            self.calls = []
            self.completed = False

        def authorize_path(self, path, write=False):
            self.calls.append((path, write))
            normalized = path.replace(chr(92), "/").lower()
            if ".mmdl-uploads-v1" in normalized.split("/"):
                if write or not self.completed or not normalized.endswith("/payload.mp4"):
                    raise UploadSyntheticTests.FakeError("unsafe_path")

        def capabilities(self):
            return {"enabled": True, "max_file_bytes": 100, "max_total_bytes": 200, "chunk_bytes": 262144}

        def create(self, name, size):
            self.calls.append(("create", name, size))
            return {"upload_id": "fake-id", "chunk_bytes": 262144, "next_offset": 0}

        def write_chunk(self, upload_id, offset, data_base64):
            self.calls.append(("chunk", upload_id, offset, data_base64))
            return {"next_offset": 1}

        def finish(self, upload_id):
            self.calls.append(("finish", upload_id))
            self.completed = True
            return {"path": ".mmdl-uploads-v1/slot-00/payload.mp4"}

    def test_existing_host_origin_and_json_checks_apply_to_uploads(self):
        def probe(host, origin, is_json):
            headers = {} if origin is None else {"Origin": origin}
            request = types.SimpleNamespace(
                environ={"HTTP_HOST": host}, method="POST", path="/api/uploads/chunk",
                headers=headers, host_url="http://localhost/", is_json=is_json)
            with (patch.object(web_app, "request", request),
                  patch.object(web_app, "jsonify", side_effect=lambda value: value),
                  patch.dict(web_app.app.config, {"MMDL_TRUSTED_HOSTS": ["localhost"],
                                                  "MMDL_TRUSTED_ORIGINS": set()})):
                return web_app._protect_browser_post()

        self.assertEqual(probe("attacker.invalid", None, True)[1], 400)
        self.assertEqual(probe("localhost", "https://attacker.invalid", True)[1], 403)
        self.assertEqual(probe("localhost", None, False)[1], 415)
        self.assertIsNone(probe("localhost", None, True))
        self.assertIsNone(probe("localhost", "http://localhost", True))

    def test_modeled_symlink_alias_cannot_expose_incomplete_or_inline_upload(self):
        root = os.path.abspath("synthetic-upload-root")
        alias = os.path.join(root, "alias.mp4")
        target = os.path.join(root, ".mmdl-uploads-v1", "slot-00", "payload.mp4")
        original_realpath = os.path.realpath

        def resolve(path):
            if os.path.normcase(os.path.abspath(path)) == os.path.normcase(alias):
                return target
            return original_realpath(path)

        store = self.FakeStore()

        class ResolvingStore(self.FakeStore):
            def authorize_path(self, path, write=False):
                return super().authorize_path(os.path.realpath(path), write=write)

        store = ResolvingStore()
        with (patch.object(web_app, "DOWNLOADS_DIR", root),
              patch.object(web_app, "FRONTEND_DIST", root),
              patch.object(web_app, "ALLOW_ABSOLUTE_PATHS", False),
              patch.object(web_app, "_upload_store", store, create=True),
              patch.object(web_app, "UploadError", self.FakeError, create=True),
              patch.object(web_app.os.path, "realpath", side_effect=resolve),
              patch.object(web_app, "send_from_directory", return_value="sent")):
            with self.assertRaises(self.FakeError):
                web_app.files("alias.mp4")
            store.completed = True
            with self.assertRaises(self.FakeError):
                web_app.static_proxy("alias.mp4")

    def test_ordinary_root_and_non_upload_paths_remain_usable(self):
        root = os.path.abspath("synthetic-upload-root")
        store = self.FakeStore()
        with (patch.object(web_app, "DOWNLOADS_DIR", root),
              patch.object(web_app, "ALLOW_ABSOLUTE_PATHS", False),
              patch.object(web_app, "_upload_store", store, create=True),
              patch.object(web_app, "UploadError", self.FakeError, create=True)):
            self.assertEqual(web_app._save_path(None), root)
            self.assertEqual(web_app._confine_all(["regular.mp4"]),
                             [os.path.realpath(os.path.join(root, "regular.mp4"))])
            self.assertIsNone(web_app._cookie_file(""))

    def test_finish_does_not_return_an_absolute_local_path(self):
        import io
        root = os.path.abspath("synthetic-upload-root")
        local_path = os.path.abspath("synthetic-private-path")
        store = self.FakeStore()
        store.finish = lambda _id: {"path": local_path}
        raw = b'{"upload_id":"fake-id"}'
        request = types.SimpleNamespace(environ={"CONTENT_LENGTH": str(len(raw))}, stream=io.BytesIO(raw))
        with (patch.object(web_app, "DOWNLOADS_DIR", root),
              patch.object(web_app, "_upload_store", store, create=True),
              patch.object(web_app, "UploadError", self.FakeError, create=True),
              patch.object(web_app, "request", request)):
            with self.assertRaises(self.FakeError) as error:
                web_app.api_upload_finish()
        self.assertEqual(error.exception.code, "unavailable")
        self.assertNotIn(local_path, str(error.exception))

    def test_full_chunk_json_fits_the_bounded_route(self):
        import io
        payload = "A" * 349526 + "=="
        raw = json.dumps({"upload_id": "fake-id", "offset": 0, "data_base64": payload}).encode("utf-8")
        store = self.FakeStore()
        request = types.SimpleNamespace(environ={"CONTENT_LENGTH": str(len(raw))}, stream=io.BytesIO(raw))
        with (patch.object(web_app, "_upload_store", store, create=True),
              patch.object(web_app, "UploadError", self.FakeError, create=True),
              patch.object(web_app, "request", request),
              patch.object(web_app, "jsonify", side_effect=lambda value: value)):
            self.assertEqual(web_app.api_upload_chunk()["next_offset"], 1)
        self.assertIn(("chunk", "fake-id", 0, payload), store.calls)

    def test_upload_json_reads_fragmented_streams_to_declared_length(self):
        import io

        class ShortStream(io.BytesIO):
            def read(self, size=-1):
                return super().read(min(size, 2))

        raw = b'{"name":"x"}'
        request = types.SimpleNamespace(environ={"CONTENT_LENGTH": str(len(raw))}, stream=ShortStream(raw))
        with (patch.object(web_app, "request", request),
              patch.object(web_app, "UploadError", self.FakeError, create=True)):
            self.assertEqual(web_app._read_upload_json(32), {"name": "x"})

    def test_unrestricted_ordinary_unc_does_not_trigger_guard_resolution(self):
        slash = chr(92)
        path = slash * 2 + "server" + slash + "share" + slash + "clip.mp4"
        store = self.FakeStore()
        with (patch.object(web_app.os, "name", "nt"),
              patch.object(web_app, "ALLOW_ABSOLUTE_PATHS", True),
              patch.object(web_app, "_upload_store", store, create=True),
              patch.object(web_app, "UploadError", self.FakeError, create=True),
              patch.object(web_app.os.path, "abspath", side_effect=AssertionError("unexpected path probe")),
              patch.object(web_app.os.path, "realpath", side_effect=AssertionError("unexpected path probe"))):
            try:
                self.assertEqual(web_app._save_path(path), path)
                self.assertEqual(web_app._cookie_file(path), path)
                self.assertEqual(web_app._confine_all([path]), [path])
                task = {"kind": "convert", "src_path": path, "dst_path": path}
                self.assertEqual(web_app._confine_tasks([task])[0]["src_path"], path)
                preview = {"kind": "convert", "task_id": "id", "src_path": path, "dst_path": path}
                self.assertEqual(web_app._confine_preview_queue([preview])[0]["src_path"], path)
            except Exception:
                self.fail("ordinary UNC path was unexpectedly resolved or rejected")
        self.assertEqual(store.calls, [])

    def test_unc_known_reserved_components_are_denied_without_resolution(self):
        slash = chr(92)
        for component in (".mmdl-uploads-v1", ".MMDL-UPLOADS-V1. "):
            with self.subTest(component=component):
                path = slash * 2 + "server" + slash + "share" + slash + component + slash + "payload.mp4"
                with (patch.object(web_app.os, "name", "nt"),
                      patch.object(web_app, "ALLOW_ABSOLUTE_PATHS", True),
                      patch.object(web_app, "_upload_store", self.FakeStore(), create=True),
                      patch.object(web_app, "UploadError", self.FakeError, create=True),
                      patch.object(web_app.os.path, "abspath", side_effect=AssertionError("unexpected path probe")),
                      patch.object(web_app.os.path, "realpath", side_effect=AssertionError("unexpected path probe"))):
                    with self.assertRaises(self.FakeError) as error:
                        web_app._save_path(path)
                self.assertEqual(error.exception.code, "unsafe_path")

    def test_relative_path_resolving_to_unc_skips_extra_realpath(self):
        slash = chr(92)
        lexical = slash * 2 + "server" + slash + "share" + slash + "clip.mp4"
        store = self.FakeStore()
        with (patch.object(web_app.os, "name", "nt"),
              patch.object(web_app, "_upload_store", store, create=True),
              patch.object(web_app, "UploadError", self.FakeError, create=True),
              patch.object(web_app.os.path, "abspath", return_value=lexical),
              patch.object(web_app.os.path, "realpath", side_effect=AssertionError("unexpected path probe"))):
            try:
                web_app._guard_upload_path("relative.mp4")
            except Exception:
                self.fail("UNC lexical path unexpectedly reached realpath")
        self.assertEqual(store.calls, [])

    def test_confined_unc_root_client_path_does_not_add_root_resolution(self):
        slash = chr(92)
        root = slash * 2 + "server" + slash + "share"
        expected = os.path.join(root, "clip.mp4")
        with (patch.object(web_app.os, "name", "nt"),
              patch.object(web_app, "DOWNLOADS_DIR", root),
              patch.object(web_app, "ALLOW_ABSOLUTE_PATHS", False),
              patch.object(web_app.os.path, "realpath", side_effect=AssertionError("unexpected path probe"))):
            try:
                self.assertEqual(web_app._upload_client_path("clip.mp4"), expected)
            except Exception:
                self.fail("UNC root unexpectedly reached an additional realpath")

    def test_mapped_drive_is_delegated_before_any_web_realpath(self):
        slash = chr(92)
        path = "Z:" + slash + "share" + slash + "clip.mp4"
        store = self.FakeStore()
        with (patch.object(web_app.os, "name", "nt"),
              patch.object(web_app, "ALLOW_ABSOLUTE_PATHS", True),
              patch.object(web_app, "_upload_store", store, create=True),
              patch.object(web_app, "UploadError", self.FakeError, create=True),
              patch.object(web_app.os.path, "abspath", return_value=path),
              patch.object(web_app.os.path, "isabs", return_value=True),
              patch.object(web_app.os.path, "realpath", side_effect=AssertionError("unexpected path probe"))):
            try:
                self.assertEqual(web_app._save_path(path), path)
            except Exception:
                self.fail("mapped path was resolved before the store could classify it")
        self.assertEqual(store.calls, [(path, True)])

    def test_guard_preserves_absolute_symlink_dotdot_for_the_store(self):
        slash = chr(92)
        raw = "C:" + slash + "root" + slash + "link" + slash + ".." + slash + "clip.mp4"
        collapsed = "C:" + slash + "root" + slash + "clip.mp4"
        store = self.FakeStore()
        with (patch.object(web_app.os, "name", "nt"),
              patch.object(web_app, "_upload_store", store, create=True),
              patch.object(web_app, "UploadError", self.FakeError, create=True),
              patch.object(web_app.os.path, "abspath", return_value=collapsed),
              patch.object(web_app.os.path, "isabs", return_value=True),
              patch.object(web_app.os.path, "realpath", side_effect=AssertionError("unexpected path probe"))):
            try:
                web_app._guard_upload_path(raw)
            except Exception:
                self.fail("raw absolute path was resolved before delegation")
        self.assertEqual(store.calls, [(raw, False)])

    def test_confined_client_path_keeps_raw_root_for_store_classification(self):
        slash = chr(92)
        root = "Z:" + slash + "share"
        relative = "link" + slash + ".." + slash + "clip.mp4"
        expected = os.path.join(root, relative)
        with (patch.object(web_app.os, "name", "nt"),
              patch.object(web_app, "DOWNLOADS_DIR", root),
              patch.object(web_app, "ALLOW_ABSOLUTE_PATHS", False),
              patch.object(web_app.os.path, "realpath", side_effect=AssertionError("unexpected path probe"))):
            try:
                self.assertEqual(web_app._upload_client_path(relative), expected)
            except Exception:
                self.fail("client path unexpectedly resolved the configured root")

    def test_local_extended_path_is_delegated_to_store_without_web_resolution(self):
        slash = chr(92)
        path = slash * 2 + "?" + slash + "C:" + slash + "ordinary.mp4"
        store = self.FakeStore()
        with (patch.object(web_app.os, "name", "nt"),
              patch.object(web_app, "ALLOW_ABSOLUTE_PATHS", True),
              patch.object(web_app, "_upload_store", store, create=True),
              patch.object(web_app, "UploadError", self.FakeError, create=True),
              patch.object(web_app.os.path, "abspath", return_value=path),
              patch.object(web_app.os.path, "isabs", return_value=True),
              patch.object(web_app.os.path, "realpath", side_effect=AssertionError("unexpected path probe"))):
            try:
                self.assertEqual(web_app._save_path(path), path)
            except Exception:
                self.fail("local extended path did not reach the store")
        self.assertEqual(store.calls, [(path, True)])

    def test_local_extended_short_alias_is_not_skipped(self):
        slash = chr(92)
        path = slash * 2 + "?" + slash + "C:" + slash + "MMDLUP~1" + slash + "payload.mp4"

        class AliasStore(self.FakeStore):
            def authorize_path(self, value, write=False):
                self.calls.append((value, write))
                if "MMDLUP~1" in value:
                    raise UploadSyntheticTests.FakeError("unsafe_path")

        store = AliasStore()
        with (patch.object(web_app.os, "name", "nt"),
              patch.object(web_app, "ALLOW_ABSOLUTE_PATHS", True),
              patch.object(web_app, "_upload_store", store, create=True),
              patch.object(web_app, "UploadError", self.FakeError, create=True),
              patch.object(web_app.os.path, "abspath", return_value=path),
              patch.object(web_app.os.path, "isabs", return_value=True),
              patch.object(web_app.os.path, "realpath", side_effect=AssertionError("unexpected path probe"))):
            with self.assertRaises(self.FakeError) as error:
                web_app._save_path(path)
        self.assertEqual(error.exception.code, "unsafe_path")
        self.assertEqual(store.calls, [(path, True)])

    def test_unc_reserved_component_with_ads_is_denied_without_resolution(self):
        slash = chr(92)
        path = slash * 2 + "server" + slash + "share" + slash + ".mmdl-uploads-v1:stream"
        with (patch.object(web_app.os, "name", "nt"),
              patch.object(web_app, "ALLOW_ABSOLUTE_PATHS", True),
              patch.object(web_app, "_upload_store", self.FakeStore(), create=True),
              patch.object(web_app, "UploadError", self.FakeError, create=True),
              patch.object(web_app.os.path, "abspath", side_effect=AssertionError("unexpected path probe")),
              patch.object(web_app.os.path, "realpath", side_effect=AssertionError("unexpected path probe"))):
            with self.assertRaises(self.FakeError) as error:
                web_app._save_path(path)
        self.assertEqual(error.exception.code, "unsafe_path")

    def test_reserved_paths_are_guarded_in_restricted_and_absolute_modes(self):
        root = os.path.abspath("synthetic-upload-root")
        relative = os.path.join(".mmdl-uploads-v1", "slot-00", "payload.mp4")
        for unrestricted in (False, True):
            with self.subTest(unrestricted=unrestricted):
                store = self.FakeStore()
                path = os.path.join(root, relative) if unrestricted else relative
                with (patch.object(web_app, "DOWNLOADS_DIR", root),
                      patch.object(web_app, "ALLOW_ABSOLUTE_PATHS", unrestricted),
                      patch.object(web_app, "_upload_store", store, create=True),
                      patch.object(web_app, "UploadError", self.FakeError, create=True)):
                    actions = (
                        lambda: web_app._save_path(path),
                        lambda: web_app._cookie_file(path),
                        lambda: web_app._confine_all([path]),
                        lambda: web_app._confine_tasks([{"kind": "convert", "src_path": path, "dst_path": "out.mp4"}]),
                        lambda: web_app._confine_tasks([{"kind": "convert", "src_path": "in.mp4", "dst_path": path}]),
                        lambda: web_app._confine_preview_queue([{"kind": "convert", "task_id": "id", "src_path": path, "dst_path": "out.mp4"}]),
                        lambda: web_app._confine_preview_queue([{"kind": "convert", "task_id": "id", "src_path": "in.mp4", "dst_path": path}]),
                        lambda: web_app.files(relative),
                    )
                    for action in actions:
                        with self.assertRaises(self.FakeError):
                            action()

    def test_invalid_queue_nul_remains_an_unsafe_path_error(self):
        root = os.path.abspath("synthetic-upload-root")
        for unrestricted in (False, True):
            for field in ("src_path", "dst_path"):
                with self.subTest(unrestricted=unrestricted, field=field):
                    task = {"kind": "convert", "src_path": "in.mp4", "dst_path": "out.mp4"}
                    task[field] = "invalid" + chr(0) + "path"
                    with (patch.object(web_app, "DOWNLOADS_DIR", root),
                          patch.object(web_app, "ALLOW_ABSOLUTE_PATHS", unrestricted),
                          patch.object(web_app, "_upload_store", self.FakeStore(), create=True),
                          patch.object(web_app, "UploadError", self.FakeError, create=True)):
                        with self.assertRaises(web_app.UnsafePath):
                            web_app._confine_tasks([task])

    def test_completed_payload_can_be_read_but_not_written_or_served_inline(self):
        root = os.path.abspath("synthetic-upload-root")
        relative = os.path.join(".mmdl-uploads-v1", "slot-00", "payload.mp4")
        store = self.FakeStore()
        store.completed = True
        with (patch.object(web_app, "DOWNLOADS_DIR", root),
              patch.object(web_app, "FRONTEND_DIST", root),
              patch.object(web_app, "ALLOW_ABSOLUTE_PATHS", False),
              patch.object(web_app, "_upload_store", store, create=True),
              patch.object(web_app, "UploadError", self.FakeError, create=True),
              patch.object(web_app, "send_from_directory", return_value="attachment") as send):
            self.assertEqual(web_app.files(relative), "attachment")
            self.assertTrue(send.call_args.kwargs["as_attachment"])
            with self.assertRaises(self.FakeError):
                web_app._save_path(relative)
            with self.assertRaises(self.FakeError):
                web_app.static_proxy(relative)

    def test_upload_json_rejects_untrusted_length_before_reading(self):
        import io

        class Reader(io.BytesIO):
            def __init__(self, body):
                super().__init__(body)
                self.read_count = 0

            def read(self, size=-1):
                self.read_count += 1
                return super().read(size)

        self.assertTrue(callable(getattr(web_app, "_read_upload_json", None)))
        cases = (
            ({}, b"{}", "invalid_request"),
            ({"CONTENT_LENGTH": "x"}, b"{}", "invalid_request"),
            ({"CONTENT_LENGTH": "0"}, b"", "invalid_request"),
            ({"CONTENT_LENGTH": "999999999999999999999"}, b"", "too_large"),
            ({"CONTENT_LENGTH": "9"}, b"", "too_large"),
            ({"CONTENT_LENGTH": "2", "HTTP_TRANSFER_ENCODING": "chunked"}, b"{}", "invalid_request"),
        )
        for environ, body, code in cases:
            with self.subTest(environ=environ):
                reader = Reader(body)
                request = types.SimpleNamespace(environ=environ, stream=reader)
                with (patch.object(web_app, "request", request),
                      patch.object(web_app, "UploadError", self.FakeError, create=True)):
                    with self.assertRaises(self.FakeError) as error:
                        web_app._read_upload_json(8)
                self.assertEqual(error.exception.code, code)
                self.assertEqual(reader.read_count, 0)

    def test_upload_json_rejects_short_or_invalid_bodies(self):
        import io
        self.assertTrue(callable(getattr(web_app, "_read_upload_json", None)))
        cases = (({"CONTENT_LENGTH": "2"}, b"{"), ({"CONTENT_LENGTH": "1"}, b"["),
                 ({"CONTENT_LENGTH": "1"}, bytes([255])))
        for environ, body in cases:
            with self.subTest(body=body):
                request = types.SimpleNamespace(environ=environ, stream=io.BytesIO(body))
                with (patch.object(web_app, "request", request),
                      patch.object(web_app, "UploadError", self.FakeError, create=True)):
                    with self.assertRaises(self.FakeError):
                        web_app._read_upload_json(8)

    def test_upload_routes_forward_only_the_expected_fields(self):
        import io
        for name in ("api_upload_config", "api_upload_create", "api_upload_chunk", "api_upload_finish"):
            self.assertTrue(callable(getattr(web_app, name, None)))
        root = os.path.abspath("synthetic-upload-root")
        store = self.FakeStore()

        def request(body):
            raw = json.dumps(body).encode("utf-8")
            return types.SimpleNamespace(environ={"CONTENT_LENGTH": str(len(raw))}, stream=io.BytesIO(raw))

        with (patch.object(web_app, "DOWNLOADS_DIR", root),
              patch.object(web_app, "ALLOW_ABSOLUTE_PATHS", False),
              patch.object(web_app, "_upload_store", store, create=True),
              patch.object(web_app, "UploadError", self.FakeError, create=True),
              patch.object(web_app, "jsonify", side_effect=lambda value: value)):
            self.assertTrue(web_app.api_upload_config()["enabled"])
            with patch.object(web_app, "request", request({"name": "clip.mp4", "size": 1, "ignored": "x"})):
                self.assertEqual(web_app.api_upload_create()["upload_id"], "fake-id")
            with patch.object(web_app, "request", request({"upload_id": "fake-id", "offset": 0, "data_base64": "YQ==", "ignored": "x"})):
                self.assertEqual(web_app.api_upload_chunk()["next_offset"], 1)
            with patch.object(web_app, "request", request({"upload_id": "fake-id", "ignored": "x"})):
                self.assertEqual(web_app.api_upload_finish()["path"], ".mmdl-uploads-v1/slot-00/payload.mp4")
        self.assertIn(("create", "clip.mp4", 1), store.calls)
        self.assertIn(("chunk", "fake-id", 0, "YQ=="), store.calls)
        self.assertIn(("finish", "fake-id"), store.calls)



if __name__ == "__main__":
    unittest.main()
