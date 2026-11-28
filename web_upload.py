"""Bounded single-user upload storage; no automatic deletion.

OpenAI-Codex_app_ui: slots, append-only journals and completion markers keep
incomplete uploads private within the existing trusted-directory model.
"""

from __future__ import annotations

import base64
import binascii
from contextlib import contextmanager
import hashlib
import json
import os
import re
import secrets
import stat
import struct
from typing import Mapping

if os.name == "nt":
    import msvcrt
elif os.name == "posix":
    import fcntl


CHUNK_BYTES = 262144
_ROOT_NAME = ".mmdl-uploads-v1"
_ROOT_RESERVE = 4096
_SLOT_RESERVE = 8192
_MAX_SLOTS = 32
_MAX_INTEGER = (1 << 63) - 1
_RECORD = struct.Struct(">cQQ32s")
_ID = re.compile(r"^[0-9]{2}-[0-9a-f]{32}$")
_SLOT = re.compile(r"^slot-[0-9]{2}$")
_PAYLOAD = re.compile(r"^payload\.[a-z0-9]{1,10}$")
_EXT = re.compile(r"^[a-z0-9]{1,10}$")
_BINARY = getattr(os, "O_BINARY", 0)
_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
_REPARSE = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
_ERRORS = {
    "disabled": (403, "Uploads are disabled."),
    "invalid_config": (503, "The upload storage configuration is incompatible."),
    "invalid_request": (400, "The upload request is invalid."),
    "too_large": (413, "The upload exceeds an allowed limit."),
    "quota_exhausted": (409, "No upload slot is available."),
    "not_found": (404, "The upload was not found."),
    "conflict": (409, "The upload request conflicts with its current state."),
    "interrupted": (
        409,
        "The upload is incomplete or its recorded state is inconsistent.",
    ),
    "unsafe_path": (403, "The requested upload path is not available."),
    "unavailable": (503, "Upload storage is unavailable."),
}


class UploadError(Exception):
    """A fixed, public error that never includes a server path or input."""

    def __init__(self, code: str):
        if code not in _ERRORS:
            raise ValueError("unknown upload error code")
        self.code = code
        self.http_status, message = _ERRORS[code]
        super().__init__(message)


def _preserve_cleanup_control(control):
    """Preserve this scope's control exception if ordinary cleanup fails."""

    # OpenAI-Codex_engine_cli: a handled caller exception is not this scope's error.
    @contextmanager
    def guard():
        try:
            yield
        except Exception:
            if control is None:
                raise

    return guard()


def _is_reparse(info: os.stat_result) -> bool:
    return stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, "st_file_attributes", 0) & _REPARSE
    )


def _directory(path: str) -> None:
    info = os.lstat(path)
    if _is_reparse(info) or not stat.S_ISDIR(info.st_mode):
        raise UploadError("unsafe_path")


def _open_regular(path: str, flags: int) -> int:
    before = os.lstat(path)
    if _is_reparse(before) or not stat.S_ISREG(before.st_mode):
        raise UploadError("unsafe_path")
    fd = os.open(path, flags | _BINARY | _NOFOLLOW)
    try:
        after = os.fstat(fd)
        if not stat.S_ISREG(after.st_mode) or (before.st_dev, before.st_ino) != (
            after.st_dev,
            after.st_ino,
        ):
            raise UploadError("unsafe_path")
        return fd
    except BaseException:
        _open_control = None
        try:
            raise
        # OpenAI-Codex_restore127: Preserve the active exception for the outer re-raise.
        except Exception:  # noqa: S110
            pass
        except BaseException as _control_error:
            _open_control = _control_error
        with _preserve_cleanup_control(_open_control):
            os.close(fd)
        raise


def _write_all(fd: int, data: bytes) -> None:
    remaining = memoryview(data)
    while remaining:
        count = os.write(fd, remaining)
        if count <= 0:
            raise OSError("short upload write")
        remaining = remaining[count:]


def _read_exact(fd: int, length: int) -> bytes:
    chunks = []
    remaining = length
    while remaining:
        part = os.read(fd, remaining)
        if not part:
            raise UploadError("interrupted")
        chunks.append(part)
        remaining -= len(part)
    return b"".join(chunks)


def _create_file(path: str, data: bytes = b"") -> None:
    fd = os.open(
        path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | _BINARY | _NOFOLLOW, 0o600
    )
    _create_control = None
    try:
        _write_all(fd, data)
        os.fsync(fd)
    except BaseException as _control_error:
        if not isinstance(_control_error, Exception):
            _create_control = _control_error
        raise
    finally:
        with _preserve_cleanup_control(_create_control):
            os.close(fd)


def _read_json(path: str, limit: int) -> dict:
    fd = _open_regular(path, os.O_RDONLY)
    _json_control = None
    try:
        # OpenAI-Codex_engine_cli: include decode-handler failures.
        try:
            size = os.fstat(fd).st_size
            if size <= 0 or size > limit:
                raise UploadError("interrupted")
            value = json.loads(_read_exact(fd, size).decode("utf-8"))
            if not isinstance(value, dict):
                raise UploadError("interrupted")
            return value
        except (UnicodeError, json.JSONDecodeError):
            raise UploadError("interrupted") from None
        except BaseException as _control_error:
            if not isinstance(_control_error, Exception):
                _json_control = _control_error
            raise
    except BaseException as _json_handler_error:
        if not isinstance(_json_handler_error, Exception):
            _json_control = _json_handler_error
        raise
    finally:
        with _preserve_cleanup_control(_json_control):
            os.close(fd)


def _json_bytes(value: dict) -> bytes:
    return json.dumps(
        value, ensure_ascii=True, separators=(",", ":"), sort_keys=True
    ).encode("ascii")


def _within(path: str, root: str) -> bool:
    try:
        normalized = os.path.normcase(os.path.normpath(path))
        base = os.path.normcase(os.path.normpath(root))
        return os.path.commonpath((normalized, base)) == base
    except ValueError:
        return False


def _namespace_roots(path: str) -> list[str]:
    roots = []
    current = os.path.normpath(path)
    while True:
        if os.path.normcase(os.path.basename(current)) == os.path.normcase(_ROOT_NAME):
            roots.append(current)
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent
    return roots


# OpenAI-Codex_app_ui: Windows names may alias a directory without realpath changing the spelling.
def _windows_external_path(path: str) -> bool:
    text = path.replace("/", "\\")
    if (
        text.startswith("\\\\?\\")
        and len(text) >= 7
        and text[4].isascii()
        and text[4].isalpha()
        and text[5:7] == ":\\"
    ):
        return False
    return text.startswith("\\\\") or text.startswith("\\??\\")


def _reserved_hint(path: str) -> bool:
    for component in re.split(r"[\\/]+", path):
        name = component.split(":", 1)[0].rstrip(" .")
        if os.path.normcase(name) == os.path.normcase(_ROOT_NAME):
            return True
    return False


def _windows_local_root(path: str) -> bool:
    """Use the OS drive classification; unknown and network drives fail closed."""
    if _windows_external_path(path):
        return False
    drive, _ = os.path.splitdrive(os.path.abspath(path))
    if not re.fullmatch(r"[A-Za-z]:", drive):
        return False
    try:
        import ctypes
        from ctypes import wintypes

        function = ctypes.WinDLL("kernel32", use_last_error=True).GetDriveTypeW
        function.argtypes = [wintypes.LPCWSTR]
        function.restype = wintypes.UINT
        return function(drive + "\\") in (2, 3)
    except (OSError, AttributeError, TypeError, ValueError):
        return False


def _windows_local_candidate(path: str) -> bool:
    text = path.replace("/", "\\")
    if (
        text.startswith("\\\\?\\")
        and len(text) >= 7
        and text[4].isascii()
        and text[4].isalpha()
        and text[5:7] == ":\\"
    ):
        text = text[4:]
    return _windows_local_root(text)


def _plain_windows_ancestors(path: str) -> bool:
    """Refuse existing reparse points or unknown directory ancestors for upload roots."""
    absolute = path if os.path.isabs(path) else os.path.join(os.getcwd(), path)
    drive, tail = os.path.splitdrive(absolute)
    if not drive or not tail.startswith(("\\", "/")):
        return False
    current = drive + "\\"
    components = re.split(r"[\\/]+", tail)
    for component in [""] + components:
        if component == ".":
            continue
        if component == "..":
            current = os.path.normpath(os.path.join(current, ".."))
        elif component:
            current = os.path.join(current, component)
        try:
            info = os.lstat(current)
            if _is_reparse(info) or not stat.S_ISDIR(info.st_mode):
                return False
        except FileNotFoundError:
            pass
        except OSError:
            return False
    return True


def _windows_long_path(path: str) -> str:
    import ctypes
    from ctypes import wintypes

    function = ctypes.WinDLL("kernel32", use_last_error=True).GetLongPathNameW
    function.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD]
    function.restype = wintypes.DWORD
    buffer = ctypes.create_unicode_buffer(32768)
    length = function(path, buffer, len(buffer))
    if not length or length >= len(buffer):
        raise UploadError("unsafe_path")
    return buffer.value


def _ambiguous_windows_long_name(path: str) -> bool:
    """Identify short-name aliases without crossing an unknown reparse point."""
    drive, tail = os.path.splitdrive(path)
    if not drive or not tail.startswith(("\\", "/")):
        return False
    current = drive + "\\"
    for component in re.split(r"[\\/]+", tail):
        if not component or component == ".":
            continue
        if component == "..":
            current = os.path.normpath(os.path.join(current, ".."))
        else:
            current = os.path.join(current, component)
        try:
            info = os.lstat(current)
        except FileNotFoundError:
            break
        except OSError:
            raise UploadError("unsafe_path") from None
        if _is_reparse(info):
            break
        if _reserved_hint(_windows_long_path(current)) and not _reserved_hint(current):
            return True
    return False


def _ambiguous_windows_alias(path: str, downloads_dir: str) -> bool:
    """Reject a known stage ancestor whose spelling is not one of its configured names."""
    if not _windows_local_root(downloads_dir):
        return False
    if not _plain_windows_ancestors(downloads_dir):
        return False
    lexical_root = os.path.abspath(downloads_dir)
    real_root = os.path.realpath(downloads_dir)
    if not _windows_local_root(real_root):
        return False
    stage = os.path.join(real_root, _ROOT_NAME)
    if not os.path.lexists(stage):
        return False
    _directory(stage)
    allowed = {
        os.path.normcase(os.path.normpath(os.path.join(root, _ROOT_NAME)))
        for root in (lexical_root, real_root)
    }
    for candidate in (path, os.path.abspath(path), os.path.realpath(path)):
        current = candidate
        while True:
            try:
                if os.path.samefile(current, stage):
                    if os.path.normcase(os.path.normpath(current)) not in allowed:
                        return True
            except (FileNotFoundError, NotADirectoryError):
                pass
            parent = os.path.dirname(current)
            if parent == current:
                break
            current = parent
    return False


class UploadStore:
    """Append-only, quota-accounted upload slots for a trusted single user."""

    def __init__(
        self,
        downloads_dir: str,
        frontend_dist: str,
        environ: Mapping[str, str] | None = None,
        *,
        restricted_paths: bool = True,
    ):
        self.downloads_dir = downloads_dir
        self.frontend_dist = frontend_dist
        self.environ = dict(os.environ if environ is None else environ)
        self.restricted_paths = restricted_paths

    def _configuration(self) -> tuple[dict | None, str | None]:
        if self.restricted_paths is not True:
            return None, "unrestricted_paths"
        if os.name != "nt":
            return None, "unsupported_platform"
        if os.name not in ("nt", "posix"):
            return None, "unsupported_platform"
        raw_file = self.environ.get("MMDL_UPLOAD_MAX_FILE_BYTES")
        raw_total = self.environ.get("MMDL_UPLOAD_MAX_TOTAL_BYTES")
        if raw_file is None or raw_total is None:
            return None, "not_configured"
        values = []
        for raw in (raw_file, raw_total):
            if not isinstance(raw, str):
                return None, "invalid_configuration"
            text = raw.strip()
            if not text or len(text) > 19 or not text.isascii() or not text.isdecimal():
                return None, "invalid_configuration"
            value = int(text)
            if not 0 < value <= _MAX_INTEGER:
                return None, "invalid_configuration"
            if value > (1 << 53) - 1:
                return None, "invalid_configuration"
            values.append(value)
        max_file, max_total = values
        chunks = (max_file + CHUNK_BYTES - 1) // CHUNK_BYTES
        reservation = max_file + _SLOT_RESERVE + 2 * _RECORD.size * chunks
        slots = min(_MAX_SLOTS, max(0, (max_total - _ROOT_RESERVE) // reservation))
        if not slots:
            return None, "insufficient_total"
        return {
            "version": 1,
            "max_file_bytes": max_file,
            "max_total_bytes": max_total,
            "chunk_bytes": CHUNK_BYTES,
            "slots": slots,
        }, None

    def capabilities(self) -> dict:
        """Report configuration only; never inspect or create filesystem paths."""
        plan, reason = self._configuration()
        if plan is None:
            return {"enabled": False, "reason": reason}
        return {
            "enabled": True,
            "max_file_bytes": plan["max_file_bytes"],
            "max_total_bytes": plan["max_total_bytes"],
            "chunk_bytes": CHUNK_BYTES,
        }

    def _required_plan(self) -> dict:
        plan, _ = self._configuration()
        if plan is None:
            raise UploadError("disabled")
        return plan

    def _paths(self) -> tuple[str, str, str]:
        if not isinstance(self.downloads_dir, str) or not isinstance(
            self.frontend_dist, str
        ):
            raise UploadError("unsafe_path")
        if os.name == "nt" and not _windows_local_root(self.downloads_dir):
            raise UploadError("unsafe_path")
        if os.name == "nt" and not _windows_local_candidate(self.frontend_dist):
            raise UploadError("unsafe_path")
        if os.name == "nt" and not _plain_windows_ancestors(self.downloads_dir):
            raise UploadError("unsafe_path")
        root = os.path.realpath(self.downloads_dir)
        if os.name == "nt" and not _windows_local_root(root):
            raise UploadError("unsafe_path")
        if os.name == "nt" and (
            not _plain_windows_ancestors(root)
            or not _plain_windows_ancestors(self.frontend_dist)
        ):
            raise UploadError("unsafe_path")
        frontend = os.path.realpath(self.frontend_dist)
        stage = os.path.join(root, _ROOT_NAME)
        if _within(stage, frontend) or _within(frontend, stage):
            raise UploadError("unsafe_path")
        return root, frontend, stage

    def _saved_plan(self, stage: str) -> dict:
        _directory(stage)
        plan = _read_json(os.path.join(stage, "plan.json"), _ROOT_RESERVE)
        if (
            set(plan)
            != {"version", "max_file_bytes", "max_total_bytes", "chunk_bytes", "slots"}
            or plan.get("version") != 1
            or plan.get("chunk_bytes") != CHUNK_BYTES
            or any(
                type(plan.get(k)) is not int
                for k in ("max_file_bytes", "max_total_bytes", "slots")
            )
            or not 0 < plan["max_file_bytes"] <= _MAX_INTEGER
            or not 0 < plan["max_total_bytes"] <= _MAX_INTEGER
            or not 1 <= plan["slots"] <= _MAX_SLOTS
        ):
            raise UploadError("interrupted")
        if (
            plan["max_file_bytes"] > (1 << 53) - 1
            or plan["max_total_bytes"] > (1 << 53) - 1
        ):
            raise UploadError("interrupted")
        chunks = (plan["max_file_bytes"] + CHUNK_BYTES - 1) // CHUNK_BYTES
        reservation = plan["max_file_bytes"] + _SLOT_RESERVE + 2 * _RECORD.size * chunks
        if _ROOT_RESERVE + plan["slots"] * reservation > plan["max_total_bytes"]:
            raise UploadError("interrupted")
        return plan

    def _write_root(self, *, may_create: bool = False) -> tuple[str, dict]:
        plan = self._required_plan()
        root, _, stage = self._paths()
        if may_create:
            os.makedirs(root, mode=0o700, exist_ok=True)
        elif not os.path.isdir(root):
            raise UploadError("not_found")
        _directory(root)
        if not may_create and not os.path.lexists(stage):
            raise UploadError("not_found")
        try:
            os.mkdir(stage, 0o700)
        except FileExistsError:
            pass
        else:
            _create_file(os.path.join(stage, "plan.json"), _json_bytes(plan))
        saved = self._saved_plan(stage)
        if saved != plan:
            raise UploadError("invalid_config")
        return stage, plan

    @staticmethod
    def _name(name: object) -> tuple[str, str]:
        if (
            not isinstance(name, str)
            or not name
            or len(name) > 255
            or name in (".", "..")
        ):
            raise UploadError("invalid_request")
        if any(ch in "/\\" or ord(ch) < 32 or 127 <= ord(ch) <= 159 for ch in name):
            raise UploadError("invalid_request")
        try:
            if len(name.encode("utf-8")) > 1024:
                raise UploadError("invalid_request")
        except UnicodeError:
            raise UploadError("invalid_request") from None
        extension = name.rsplit(".", 1)[-1].lower() if "." in name else ""
        return name, "payload." + (extension if _EXT.fullmatch(extension) else "bin")

    @staticmethod
    def _meta(slot: str, plan: dict, upload_id: str | None = None) -> dict:
        _directory(slot)
        meta = _read_json(os.path.join(slot, "meta.json"), _SLOT_RESERVE)
        if (
            set(meta) != {"version", "upload_id", "name", "size", "payload"}
            or meta.get("version") != 1
            or not isinstance(meta.get("upload_id"), str)
            or not _ID.fullmatch(meta["upload_id"])
            or type(meta.get("size")) is not int
            or not 0 <= meta["size"] <= plan["max_file_bytes"]
            or not isinstance(meta.get("payload"), str)
            or not _PAYLOAD.fullmatch(meta["payload"])
        ):
            raise UploadError("interrupted")
        try:
            _, expected = UploadStore._name(meta.get("name"))
        except UploadError:
            raise UploadError("interrupted") from None
        if (
            expected != meta["payload"]
            or os.path.basename(slot) != "slot-" + meta["upload_id"][:2]
        ):
            raise UploadError("interrupted")
        if upload_id is not None and not secrets.compare_digest(
            meta["upload_id"], upload_id
        ):
            raise UploadError("not_found")
        if int(meta["upload_id"][:2]) >= plan["slots"]:
            raise UploadError("interrupted")
        return meta

    @staticmethod
    @contextmanager
    def _locked(slot: str):
        _directory(slot)
        fd = _open_regular(os.path.join(slot, "lock"), os.O_RDWR)
        locked = False
        _lock_control = None
        try:
            if os.fstat(fd).st_size != 1:
                raise UploadError("interrupted")
            try:
                if os.name == "nt":
                    os.lseek(fd, 0, os.SEEK_SET)
                    msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                else:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                locked = True
            except OSError:
                raise UploadError("conflict") from None
            yield
        except BaseException as _control_error:
            if not isinstance(_control_error, Exception):
                _lock_control = _control_error
            raise
        finally:
            with _preserve_cleanup_control(_lock_control):
                # OpenAI-Codex_web_ai: close the lock handle even when unlocking fails.
                if locked:
                    try:
                        if os.name == "nt":
                            os.lseek(fd, 0, os.SEEK_SET)
                            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
                        else:
                            fcntl.flock(fd, fcntl.LOCK_UN)
                    except BaseException:
                        _unlock_control = None
                        try:
                            raise
                        # Preserve the active exception for the outer re-raise.
                        except Exception:  # noqa: S110
                            pass
                        except BaseException as _control_error:
                            _unlock_control = _control_error
                        with _preserve_cleanup_control(_unlock_control):
                            os.close(fd)
                        raise
                    locked = False
                if locked:
                    if os.name == "nt":
                        os.lseek(fd, 0, os.SEEK_SET)
                        msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
                    else:
                        fcntl.flock(fd, fcntl.LOCK_UN)
                os.close(fd)

    @staticmethod
    def _inspect(
        slot: str, meta: dict, *, verify: bool = False
    ) -> tuple[int, tuple | None]:
        journal = _open_regular(os.path.join(slot, "journal.bin"), os.O_RDONLY)
        payload = None
        _inspect_control = None
        try:
            payload = _open_regular(os.path.join(slot, meta["payload"]), os.O_RDONLY)
            length = os.fstat(journal).st_size
            max_chunks = (meta["size"] + CHUNK_BYTES - 1) // CHUNK_BYTES
            if length % (2 * _RECORD.size) or length > max_chunks * 2 * _RECORD.size:
                raise UploadError("interrupted")
            offset = 0
            last = None
            for _ in range(length // (2 * _RECORD.size)):
                intent = _RECORD.unpack(_read_exact(journal, _RECORD.size))
                done = _RECORD.unpack(_read_exact(journal, _RECORD.size))
                expected = min(CHUNK_BYTES, meta["size"] - offset)
                if (
                    intent[0] != b"I"
                    or done[0] != b"C"
                    or intent[1:] != done[1:]
                    or intent[1] != offset
                    or intent[2] != expected
                    or expected <= 0
                ):
                    raise UploadError("interrupted")
                if (
                    verify
                    and hashlib.sha256(_read_exact(payload, expected)).digest()
                    != intent[3]
                ):
                    raise UploadError("interrupted")
                last = (offset, expected, intent[3])
                offset += expected
            if os.fstat(payload).st_size != offset:
                raise UploadError("interrupted")
            return offset, last
        except BaseException as _control_error:
            if not isinstance(_control_error, Exception):
                _inspect_control = _control_error
            raise
        finally:
            with _preserve_cleanup_control(_inspect_control):
                # OpenAI-Codex_engine_cli: attempt both closes and preserve the first failure.
                try:
                    if payload is not None:
                        os.close(payload)
                except BaseException as payload_close_error:
                    try:
                        os.close(journal)
                    except BaseException as journal_close_error:
                        # OpenAI-Codex_engine_cli: never demote a control-flow exception.
                        if isinstance(
                            payload_close_error, Exception
                        ) and not isinstance(journal_close_error, Exception):
                            raise journal_close_error from payload_close_error
                        raise payload_close_error from journal_close_error
                    raise
                else:
                    os.close(journal)

    @staticmethod
    def _completed(slot: str) -> bool:
        path = os.path.join(slot, "completed")
        if not os.path.lexists(path):
            return False
        fd = _open_regular(path, os.O_RDONLY)
        _completed_control = None
        try:
            if os.fstat(fd).st_size:
                raise UploadError("interrupted")
            return True
        except BaseException as _control_error:
            if not isinstance(_control_error, Exception):
                _completed_control = _control_error
            raise
        finally:
            with _preserve_cleanup_control(_completed_control):
                os.close(fd)

    def create(self, name: object, size: object) -> dict:
        try:
            plan = self._required_plan()
            label, payload_name = self._name(name)
            if type(size) is not int or size < 0:
                raise UploadError("invalid_request")
            if size > plan["max_file_bytes"]:
                raise UploadError("too_large")
            stage, plan = self._write_root(may_create=True)
            for index in range(plan["slots"]):
                slot = os.path.join(stage, f"slot-{index:02d}")
                try:
                    os.mkdir(slot, 0o700)
                except FileExistsError:
                    continue
                upload_id = f"{index:02d}-{secrets.token_hex(16)}"
                meta = {
                    "version": 1,
                    "upload_id": upload_id,
                    "name": label,
                    "size": size,
                    "payload": payload_name,
                }
                _create_file(os.path.join(slot, "meta.json"), _json_bytes(meta))
                _create_file(os.path.join(slot, "lock"), b"L")
                _create_file(os.path.join(slot, "journal.bin"))
                _create_file(os.path.join(slot, payload_name))
                return {
                    "upload_id": upload_id,
                    "chunk_bytes": CHUNK_BYTES,
                    "next_offset": 0,
                }
            raise UploadError("quota_exhausted")
        except UploadError:
            raise
        except (OSError, ValueError, OverflowError):
            raise UploadError("unavailable") from None

    def _slot(self, upload_id: object) -> tuple[str, dict]:
        if not isinstance(upload_id, str) or not _ID.fullmatch(upload_id):
            raise UploadError("invalid_request")
        stage, plan = self._write_root()
        if int(upload_id[:2]) >= plan["slots"]:
            raise UploadError("not_found")
        slot = os.path.join(stage, "slot-" + upload_id[:2])
        if not os.path.lexists(slot):
            raise UploadError("not_found")
        return slot, plan

    def write_chunk(
        self, upload_id: object, offset: object, data_base64: object
    ) -> dict:
        try:
            if (
                type(offset) is not int
                or offset < 0
                or not isinstance(data_base64, str)
            ):
                raise UploadError("invalid_request")
            if len(data_base64) > 4 * ((CHUNK_BYTES + 2) // 3):
                raise UploadError("too_large")
            try:
                data = base64.b64decode(data_base64, validate=True)
            except (ValueError, binascii.Error):
                raise UploadError("invalid_request") from None
            if not data or len(data) > CHUNK_BYTES:
                raise UploadError("invalid_request")
            slot, plan = self._slot(upload_id)
            with self._locked(slot):
                meta = self._meta(slot, plan, upload_id)
                if self._completed(slot):
                    raise UploadError("conflict")
                current, last = self._inspect(slot, meta)
                digest = hashlib.sha256(data).digest()
                if last is not None and (offset, len(data), digest) == last:
                    # OpenAI-Codex_engine_cli: verify only the committed replay range.
                    payload = _open_regular(
                        os.path.join(slot, meta["payload"]), os.O_RDONLY
                    )
                    _replay_control = None
                    try:
                        if os.fstat(payload).st_size != current:
                            raise UploadError("interrupted")
                        if os.lseek(payload, offset, os.SEEK_SET) != offset:
                            raise UploadError("interrupted")
                        actual = hashlib.sha256(
                            _read_exact(payload, len(data))
                        ).digest()
                        if not secrets.compare_digest(actual, digest):
                            raise UploadError("interrupted")
                    except BaseException as _control_error:
                        if not isinstance(_control_error, Exception):
                            _replay_control = _control_error
                        raise
                    finally:
                        with _preserve_cleanup_control(_replay_control):
                            os.close(payload)
                    return {"next_offset": current}
                if offset != current:
                    raise UploadError("conflict")
                if len(data) != min(CHUNK_BYTES, meta["size"] - current):
                    raise UploadError("invalid_request")
                intent = _RECORD.pack(b"I", current, len(data), digest)
                done = _RECORD.pack(b"C", current, len(data), digest)
                journal = _open_regular(
                    os.path.join(slot, "journal.bin"), os.O_WRONLY | os.O_APPEND
                )
                _journal_control = None
                try:
                    _write_all(journal, intent)
                    os.fsync(journal)
                    payload = _open_regular(
                        os.path.join(slot, meta["payload"]), os.O_WRONLY | os.O_APPEND
                    )
                    _payload_control = None
                    try:
                        _write_all(payload, data)
                        os.fsync(payload)
                    except BaseException as _control_error:
                        if not isinstance(_control_error, Exception):
                            _payload_control = _control_error
                        raise
                    finally:
                        with _preserve_cleanup_control(_payload_control):
                            os.close(payload)
                    _write_all(journal, done)
                    os.fsync(journal)
                except BaseException as _control_error:
                    if not isinstance(_control_error, Exception):
                        _journal_control = _control_error
                    raise
                finally:
                    with _preserve_cleanup_control(_journal_control):
                        os.close(journal)
                return {"next_offset": current + len(data)}
        except UploadError:
            raise
        except (OSError, ValueError, OverflowError, struct.error):
            raise UploadError("unavailable") from None

    def finish(self, upload_id: object) -> dict:
        try:
            slot, plan = self._slot(upload_id)
            with self._locked(slot):
                meta = self._meta(slot, plan, upload_id)
                current, _ = self._inspect(slot, meta, verify=True)
                if current != meta["size"]:
                    raise UploadError("conflict")
                if not self._completed(slot):
                    _create_file(os.path.join(slot, "completed"))
                return {"path": f"{_ROOT_NAME}/slot-{upload_id[:2]}/{meta['payload']}"}
        except UploadError:
            raise
        except (OSError, ValueError, OverflowError, struct.error):
            raise UploadError("unavailable") from None

    def authorize_path(self, path: str, *, write: bool = False) -> None:
        """Fail closed for private namespace paths, regardless of upload settings."""
        try:
            if not isinstance(path, str) or "\x00" in path or not os.path.isabs(path):
                raise UploadError("unsafe_path")
            if os.name == "nt" and _windows_external_path(path):
                if _reserved_hint(path):
                    raise UploadError("unsafe_path")
                return
            if os.name == "nt" and not _windows_local_candidate(path):
                if _reserved_hint(path):
                    raise UploadError("unsafe_path")
                return
            if os.name == "nt" and _reserved_hint(path) and not _namespace_roots(path):
                raise UploadError("unsafe_path")
            if os.name == "nt" and _ambiguous_windows_long_name(path):
                raise UploadError("unsafe_path")
            if os.name == "nt" and _ambiguous_windows_alias(path, self.downloads_dir):
                raise UploadError("unsafe_path")
            lexical = os.path.abspath(path)
            resolved = os.path.realpath(path)
            lexical_roots = _namespace_roots(lexical)
            resolved_roots = _namespace_roots(resolved)
            if not lexical_roots and not resolved_roots:
                return
            if (
                len(lexical_roots) > 1
                or len(resolved_roots) > 1
                or (lexical_roots and not resolved_roots)
            ):
                raise UploadError("unsafe_path")
            valid_roots = {
                os.path.normcase(os.path.normpath(os.path.join(root, _ROOT_NAME)))
                for root in (
                    os.path.abspath(self.downloads_dir),
                    os.path.realpath(self.downloads_dir),
                )
            }
            if any(
                os.path.normcase(os.path.normpath(root)) not in valid_roots
                for root in lexical_roots + resolved_roots
            ):
                raise UploadError("unsafe_path")
            if write:
                raise UploadError("unsafe_path")
            stage = resolved_roots[0]
            relative = os.path.relpath(resolved, stage).split(os.sep)
            if (
                len(relative) != 2
                or not _SLOT.fullmatch(relative[0])
                or not _PAYLOAD.fullmatch(relative[1])
            ):
                raise UploadError("unsafe_path")
            plan = self._saved_plan(stage)
            slot = os.path.join(stage, relative[0])
            with self._locked(slot):
                meta = self._meta(slot, plan)
                if meta["payload"] != relative[1] or not self._completed(slot):
                    raise UploadError("unsafe_path")
                current, _ = self._inspect(slot, meta)
                if current != meta["size"]:
                    raise UploadError("unsafe_path")
        except UploadError as exc:
            if exc.code == "unsafe_path":
                raise
            raise UploadError("unsafe_path") from None
        except (OSError, ValueError, OverflowError, struct.error):
            raise UploadError("unsafe_path") from None
