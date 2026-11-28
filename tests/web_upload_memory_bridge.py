"""Memory-only upload bridge for the cross-language synthetic check.

OpenAI-Codex_engine_cli: no real listener, storage, media, or network is used.
This intentionally extracts the current upload core and route functions; Flask,
Windows path inspection, locks, the filesystem, and the engine are substitutes.
"""

from __future__ import annotations

import ast
import base64
import binascii
from contextlib import contextmanager
import hashlib
import hmac
import io
import ipaddress
import json
import ntpath
from pathlib import Path
import re
import socket
import stat
import struct
import sys
from types import SimpleNamespace
from urllib.parse import urlsplit


ROOT = Path(__file__).absolute().parent.parent
CORE = ast.parse((ROOT / "web_upload.py").read_text(encoding="utf-8"))
WEB = ast.parse((ROOT / "web_app.py").read_text(encoding="utf-8"))


def _network_blocked(*_args, **_kwargs):
    raise AssertionError("the synthetic bridge must not use the network")


socket.socket = _network_blocked
socket.create_connection = _network_blocked


def _pick_function(tree, name):
    node = next(
        item
        for item in tree.body
        if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef))
        and item.name == name
    )
    node.decorator_list = []
    return node


def _future():
    return ast.ImportFrom(
        module="__future__", names=[ast.alias(name="annotations")], level=0
    )


class MemoryFiles:
    """Minimal Windows-shaped filesystem implemented with Python objects."""

    def __init__(self):
        self.nodes = {}
        self.handles = {}
        self.next_inode = 0
        self.next_handle = 10
        self.cwd = "C:\\virtual"
        self._seed_directories("C:\\virtual\\frontend")

    def key(self, path):
        return ntpath.normcase(self.abspath(path))

    def abspath(self, path):
        if not ntpath.isabs(path):
            path = ntpath.join(self.cwd, path)
        return ntpath.normpath(path)

    def realpath(self, path):
        # The model contains no reparse points. Alias behavior is not tested.
        return self.abspath(path)

    def _new_node(self, directory):
        self.next_inode += 1
        return {
            "directory": directory,
            "data": bytearray(),
            "inode": self.next_inode,
        }

    def _seed_directories(self, path):
        drive, tail = ntpath.splitdrive(self.abspath(path))
        current = drive + "\\"
        self.nodes.setdefault(self.key(current), self._new_node(True))
        for part in re.split(r"[\\/]+", tail):
            if part:
                current = ntpath.join(current, part)
                self.nodes.setdefault(self.key(current), self._new_node(True))

    def exists(self, path):
        return self.key(path) in self.nodes

    def isdir(self, path):
        node = self.nodes.get(self.key(path))
        return bool(node and node["directory"])

    def mkdir(self, path, mode=0o777):
        del mode
        key = self.key(path)
        if key in self.nodes:
            raise FileExistsError(path)
        if not self.isdir(ntpath.dirname(path)):
            raise FileNotFoundError(path)
        self.nodes[key] = self._new_node(True)

    def makedirs(self, path, mode=0o777, exist_ok=False):
        del mode
        if self.exists(path):
            if not exist_ok or not self.isdir(path):
                raise FileExistsError(path)
            return
        parent = ntpath.dirname(path)
        if not self.isdir(parent):
            self.makedirs(parent, exist_ok=True)
        self.mkdir(path)

    def _info(self, node):
        kind = stat.S_IFDIR if node["directory"] else stat.S_IFREG
        return SimpleNamespace(
            st_mode=kind | 0o600,
            st_size=len(node["data"]),
            st_dev=1,
            st_ino=node["inode"],
            st_file_attributes=0,
        )

    def lstat(self, path):
        node = self.nodes.get(self.key(path))
        if node is None:
            raise FileNotFoundError(path)
        return self._info(node)

    def open(self, path, flags, mode=0o777):
        del mode
        key = self.key(path)
        node = self.nodes.get(key)
        if flags & FakeOS.O_CREAT:
            if node is not None and flags & FakeOS.O_EXCL:
                raise FileExistsError(path)
            if node is None:
                if not self.isdir(ntpath.dirname(path)):
                    raise FileNotFoundError(path)
                node = self._new_node(False)
                self.nodes[key] = node
        if node is None:
            raise FileNotFoundError(path)
        if node["directory"]:
            raise IsADirectoryError(path)
        self.next_handle += 1
        self.handles[self.next_handle] = {
            "key": key,
            "position": len(node["data"]) if flags & FakeOS.O_APPEND else 0,
            "append": bool(flags & FakeOS.O_APPEND),
        }
        return self.next_handle

    def fstat(self, handle):
        return self._info(self.nodes[self.handles[handle]["key"]])

    def read(self, handle, size):
        descriptor = self.handles[handle]
        data = self.nodes[descriptor["key"]]["data"]
        start = descriptor["position"]
        result = bytes(data[start : start + size])
        descriptor["position"] += len(result)
        return result

    def write(self, handle, value):
        descriptor = self.handles[handle]
        data = self.nodes[descriptor["key"]]["data"]
        value = bytes(value)
        start = len(data) if descriptor["append"] else descriptor["position"]
        if start > len(data):
            data.extend(b"\0" * (start - len(data)))
        end = start + len(value)
        data[start:end] = value
        descriptor["position"] = end
        return len(value)

    def lseek(self, handle, position, whence):
        if whence != FakeOS.SEEK_SET:
            raise AssertionError("unsupported synthetic seek")
        self.handles[handle]["position"] = position
        return position

    def close(self, handle):
        del self.handles[handle]

    def snapshot(self, upload_id):
        stage = ntpath.join(
            self.cwd, "downloads", ".mmdl-uploads-v1", "slot-" + upload_id[:2]
        )
        payloads = [
            (key, node)
            for key, node in self.nodes.items()
            if ntpath.dirname(key) == self.key(stage)
            and ntpath.basename(key).startswith("payload.")
        ]
        if len(payloads) != 1:
            raise AssertionError("expected one synthetic payload")
        data = bytes(payloads[0][1]["data"])
        journal = self.nodes[self.key(ntpath.join(stage, "journal.bin"))]["data"]
        return {
            "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "journal_bytes": len(journal),
            "completed": self.exists(ntpath.join(stage, "completed")),
        }


class FakePath:
    def __init__(self, files):
        self.files = files

    def __getattr__(self, name):
        return getattr(ntpath, name)

    def abspath(self, path):
        return self.files.abspath(path)

    def realpath(self, path):
        return self.files.realpath(path)

    def lexists(self, path):
        return self.files.exists(path)

    def isdir(self, path):
        return self.files.isdir(path)


class FakeOS:
    name = "nt"
    sep = "\\"
    O_RDONLY = 0
    O_WRONLY = 1
    O_RDWR = 2
    O_CREAT = 256
    O_EXCL = 512
    O_APPEND = 1024
    SEEK_SET = 0

    def __init__(self, files):
        self.path = FakePath(files)
        self.environ = {}
        for name in (
            "lstat",
            "open",
            "fstat",
            "read",
            "write",
            "lseek",
            "close",
            "mkdir",
            "makedirs",
        ):
            setattr(self, name, getattr(files, name))
        self.fsync = lambda _handle: None
        self.getcwd = lambda: files.cwd


class MemoryLocks:
    LK_NBLCK = 1
    LK_UNLCK = 2

    def __init__(self, files):
        self.files = files
        self.held = set()

    def locking(self, handle, mode, size):
        if size != 1:
            raise AssertionError("unexpected synthetic lock size")
        key = self.files.handles[handle]["key"]
        if mode == self.LK_NBLCK:
            if key in self.held:
                raise OSError("synthetic conflict")
            self.held.add(key)
        elif mode == self.LK_UNLCK:
            self.held.remove(key)
        else:
            raise AssertionError("unexpected synthetic lock mode")


class FakeRequest:
    def __init__(self, message):
        self.method = message.get("method", "GET")
        self.path = message["url"]
        self.headers = message.get("headers", {})
        self.host_url = "http://localhost:8080/"
        self.is_json = self.headers.get("Content-Type", "").startswith(
            "application/json"
        )
        self.body = message.get("body", "").encode("utf-8")
        self.stream = io.BytesIO(self.body)
        self.environ = {"HTTP_HOST": message.get("host", "localhost:8080")}
        if not message.get("omit_length", False):
            self.environ["CONTENT_LENGTH"] = str(len(self.body))

    def get_json(self):
        return json.loads(self.body.decode("utf-8"))


class FakeWeb:
    def __init__(self, settings):
        self.files = MemoryFiles()
        self.os = FakeOS(self.files)
        self.calls = []
        self.convert_calls = 0
        self.ns = {
            "os": self.os,
            "re": re,
            "stat": stat,
            "struct": struct,
            "base64": base64,
            "binascii": binascii,
            "hashlib": hashlib,
            "json": json,
            "contextmanager": contextmanager,
            "msvcrt": MemoryLocks(self.files),
            "secrets": SimpleNamespace(
                token_hex=lambda count: "ab" * count,
                compare_digest=hmac.compare_digest,
            ),
            "_windows_local_root": lambda _path: True,
            "_windows_local_candidate": lambda _path: True,
            "_plain_windows_ancestors": lambda _path: True,
            "_ambiguous_windows_long_name": lambda _path: False,
            "_ambiguous_windows_alias": lambda _path, _root: False,
        }
        constant_names = {
            "CHUNK_BYTES",
            "_ROOT_NAME",
            "_ROOT_RESERVE",
            "_SLOT_RESERVE",
            "_MAX_SLOTS",
            "_MAX_INTEGER",
            "_RECORD",
            "_ID",
            "_SLOT",
            "_PAYLOAD",
            "_EXT",
            "_BINARY",
            "_NOFOLLOW",
            "_REPARSE",
            "_ERRORS",
        }
        constants = [
            node
            for node in CORE.body
            if isinstance(node, ast.Assign)
            and any(
                isinstance(target, ast.Name) and target.id in constant_names
                for target in node.targets
            )
        ]
        core_names = (
            "_preserve_cleanup_control",
            "_is_reparse",
            "_directory",
            "_open_regular",
            "_write_all",
            "_read_exact",
            "_create_file",
            "_read_json",
            "_json_bytes",
            "_within",
            "_namespace_roots",
            "_windows_external_path",
            "_reserved_hint",
        )
        upload_error = next(
            node
            for node in CORE.body
            if isinstance(node, ast.ClassDef) and node.name == "UploadError"
        )
        upload_store = next(
            node
            for node in CORE.body
            if isinstance(node, ast.ClassDef) and node.name == "UploadStore"
        )
        core_nodes = [_future(), *constants, upload_error]
        core_nodes.extend(_pick_function(CORE, name) for name in core_names)
        core_nodes.append(upload_store)
        core_module = ast.fix_missing_locations(
            ast.Module(body=core_nodes, type_ignores=[])
        )
        # OpenAI-Codex_formatter_fix: Keep the security exception on the call.
        compiled = compile(
            core_module, "<upload core extracted from current source>", "exec"
        )
        exec(compiled, self.ns)  # noqa: S102
        self.ns.update(
            {
                "ipaddress": ipaddress,
                "urlsplit": urlsplit,
                "jsonify": lambda value: value,
                "app": SimpleNamespace(
                    config={
                        "MMDL_TRUSTED_HOSTS": ["localhost", "127.0.0.1", "[::1]"],
                        "MMDL_TRUSTED_ORIGINS": set(),
                    }
                ),
                "UnsafePath": type("UnsafePath", (ValueError,), {}),
                "DOWNLOADS_DIR": "C:\\virtual\\downloads",
                "FRONTEND_DIST": "C:\\virtual\\frontend",
                "ALLOW_ABSOLUTE_PATHS": False,
                "_UPLOAD_CONTROL_BODY_LIMIT": 16 * 1024,
                "_UPLOAD_CHUNK_BODY_LIMIT": 4 * ((262144 + 2) // 3) + 8192,
                "VIDEO_FORMATS": ("mp4", "mkv"),
                # OpenAI-Codex_web_check: provide the encoder inputs used by the extracted route.
                "VIDEO_ENCODERS": (
                    "software",
                    "h264_nvenc",
                    "h264_qsv",
                    "h264_amf",
                    "h264_videotoolbox",
                ),
                "HARDWARE_VIDEO_FORMATS": ("mp4", "mkv", "mov"),
                "AUDIO_FORMATS": ("mp3",),
                "_dispatch": self.dispatch,
            }
        )
        names = (
            "_hostname",
            "_is_trusted_host",
            "_protect_browser_post",
            "_is_unc_or_device_path",
            "_deny_named_remote_upload_path",
            "_guard_upload_path",
            "_upload_client_path",
            "_confine",
            "_save_path",
            "_prepare_downloads_dir",
            "_operation_id",
            "_choice",
            "_policy",
            "_video_encoder_choice",
            "_confine_all",
            "_read_upload_json",
            "_upload_json_call",
            "api_upload_config",
            "api_upload_create",
            "api_upload_chunk",
            "api_upload_finish",
            "api_convert",
        )
        web_module = ast.fix_missing_locations(
            ast.Module(
                body=[_future(), *(_pick_function(WEB, name) for name in names)],
                type_ignores=[],
            )
        )
        compiled = compile(
            web_module, "<web routes extracted from current source>", "exec"
        )
        exec(compiled, self.ns)  # noqa: S102
        self.ns["_upload_store"] = self.ns["UploadStore"](
            self.ns["DOWNLOADS_DIR"], self.ns["FRONTEND_DIST"], settings
        )

    def dispatch(self, cmd, args, *, operation_id=None, before_execute=None):
        # Deliberately do not call before_execute or any engine/media operation.
        del before_execute
        self.convert_calls += 1
        return {"cmd": cmd, "files": args["files"], "operation_id": operation_id}

    def request(self, message):
        self.calls.append(
            {"url": message["url"], "method": message.get("method", "GET")}
        )
        self.ns["request"] = FakeRequest(message)
        denied = self.ns["_protect_browser_post"]()
        if denied is not None:
            body, status = denied
            return {"status": status, "body": body}
        handlers = {
            ("GET", "/api/uploads/config"): "api_upload_config",
            ("POST", "/api/uploads"): "api_upload_create",
            ("POST", "/api/uploads/chunk"): "api_upload_chunk",
            ("POST", "/api/uploads/finish"): "api_upload_finish",
            ("POST", "/api/convert"): "api_convert",
        }
        key = (message.get("method", "GET"), message["url"])
        handler = handlers.get(key)
        if handler is None:
            return {"status": 404, "body": {"error": "synthetic route missing"}}
        try:
            return {"status": 200, "body": self.ns[handler]()}
        except self.ns["UploadError"] as exc:
            return {"status": exc.http_status, "body": {"error_code": exc.code}}
        except self.ns["UnsafePath"]:
            return {"status": 400, "body": {"error": "unsafe path"}}


def main():
    services = {
        "disabled": FakeWeb({}),
        "enabled": FakeWeb(
            {
                "MMDL_UPLOAD_MAX_FILE_BYTES": str(524288),
                "MMDL_UPLOAD_MAX_TOTAL_BYTES": str(3000000),
            }
        ),
    }
    for line in sys.stdin:
        message = json.loads(line)
        service = services[message.get("service", "enabled")]
        kind = message.get("kind", "request")
        if kind == "request":
            result = service.request(message)
        elif kind == "snapshot":
            result = service.files.snapshot(message["upload_id"])
        elif kind == "counts":
            result = {"calls": service.calls, "convert_calls": service.convert_calls}
        else:
            raise AssertionError("unexpected synthetic command")
        sys.stdout.write(json.dumps({"id": message["id"], "result": result}) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
