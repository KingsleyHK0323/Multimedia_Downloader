"""Check the upload replay path with in-memory handles and no Flask.

OpenAI-Codex_web_ai: this reads the production source but never opens upload
files, acquires real locks, starts services, or accesses the network.
"""

from __future__ import annotations

import ast
import base64
import binascii
import contextlib
import hashlib
import ntpath
from pathlib import Path
import secrets
import struct
from types import SimpleNamespace


SOURCE = Path(__file__).resolve().parents[1] / "web_upload.py"
TREE = ast.parse(SOURCE.read_text(encoding="utf-8"), filename=str(SOURCE))
constant_names = {"CHUNK_BYTES", "_ERRORS"}
constants = [
    node for node in TREE.body
    if isinstance(node, ast.Assign)
    and any(isinstance(target, ast.Name) and target.id in constant_names for target in node.targets)
]
function_names = {"_preserve_cleanup_control", "_read_exact"}
functions = [
    node for node in TREE.body
    if isinstance(node, ast.FunctionDef) and node.name in function_names
]
error_class = next(
    node for node in TREE.body if isinstance(node, ast.ClassDef) and node.name == "UploadError"
)
store_class = next(
    node for node in TREE.body if isinstance(node, ast.ClassDef) and node.name == "UploadStore"
)
write_chunk = next(
    node for node in store_class.body
    if isinstance(node, ast.FunctionDef) and node.name == "write_chunk"
)
assert {node.targets[0].id for node in constants} == constant_names
assert {node.name for node in functions} == function_names
module = ast.Module(
    body=[
        ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0),
        *constants, error_class, *functions, write_chunk,
    ],
    type_ignores=[],
)
ast.fix_missing_locations(module)
CODE = compile(module, str(SOURCE), "exec")


class FakeOS:
    path = ntpath
    O_RDONLY = 0
    O_WRONLY = 1
    O_APPEND = 8
    SEEK_SET = 0

    def __init__(self, payload):
        self.payload = payload
        self.position = 0
        self.is_open = False
        self.open_attempts = 0
        self.close_attempts = 0
        self.reads = []
        self.fragment = None
        self.open_error = None
        self.seek_error = None
        self.read_error = None
        self.close_error = None
        self.short_read = False
        self.size_override = None

    def open_regular(self, path, flags):
        assert path == ntpath.join("synthetic-slot", "payload.bin")
        assert flags == self.O_RDONLY
        self.open_attempts += 1
        if self.open_error is not None:
            raise self.open_error
        assert not self.is_open
        self.is_open = True
        return 11

    def fstat(self, fd):
        assert fd == 11 and self.is_open
        size = len(self.payload) if self.size_override is None else self.size_override
        return SimpleNamespace(st_size=size)

    def lseek(self, fd, offset, whence):
        assert fd == 11 and self.is_open and whence == self.SEEK_SET
        if self.seek_error is not None:
            raise self.seek_error
        self.position = offset
        return offset

    def read(self, fd, count):
        assert fd == 11 and self.is_open
        self.reads.append((self.position, count))
        if self.read_error is not None:
            raise self.read_error
        if self.short_read:
            return b""
        length = count if self.fragment is None else min(count, self.fragment)
        result = self.payload[self.position:self.position + length]
        self.position += len(result)
        return result

    def close(self, fd):
        assert fd == 11 and self.is_open
        self.close_attempts += 1
        if self.close_error is not None:
            raise self.close_error
        self.is_open = False


class FakeStore:
    def __init__(self, chunk_bytes, original, payload):
        self.offset = chunk_bytes
        self.current = chunk_bytes + len(original)
        self.last = (self.offset, len(original), hashlib.sha256(original).digest())
        self.meta = {"size": self.current, "payload": "payload.bin"}
        self.lock_active = False
        self.lock_enters = 0
        self.lock_exits = 0
        self.fake = FakeOS(b"x" * chunk_bytes + payload)

    def _slot(self, upload_id):
        assert upload_id == "synthetic-id"
        return "synthetic-slot", {}

    @contextlib.contextmanager
    def _locked(self, slot):
        assert slot == "synthetic-slot" and not self.lock_active
        self.lock_active = True
        self.lock_enters += 1
        try:
            yield
        finally:
            self.lock_active = False
            self.lock_exits += 1

    def _meta(self, _slot, _plan, _upload_id):
        return self.meta

    def _completed(self, _slot):
        return False

    def _inspect(self, _slot, _meta):
        return self.current, self.last


def setup(original=b"end", payload=None):
    probe = {}
    exec(compile(ast.Module(body=constants, type_ignores=[]), str(SOURCE), "exec"), probe)  # noqa: S102
    chunk_bytes = probe["CHUNK_BYTES"]
    store = FakeStore(chunk_bytes, original, original if payload is None else payload)
    fake = store.fake
    namespace = {
        "base64": base64, "binascii": binascii, "contextmanager": contextlib.contextmanager,
        "hashlib": hashlib, "os": fake, "secrets": secrets, "struct": struct,
        "_open_regular": fake.open_regular,
    }
    exec(CODE, namespace)  # noqa: S102 - Execute selected production code with fake handles.
    return store, namespace["write_chunk"], namespace["UploadError"]


def send(store, write, payload=b"end"):
    encoded = base64.b64encode(payload).decode("ascii")
    return write(store, "synthetic-id", store.offset, encoded)


def expect_error(error_type, code, operation):
    try:
        operation()
    except error_type as error:
        assert error.code == code
    else:
        raise AssertionError("the replay should have failed")


def cleaned(store, *, opened=True, close_failed=False):
    fake = store.fake
    assert not store.lock_active and store.lock_enters == 1 and store.lock_exits == 1
    assert fake.open_attempts == 1
    assert fake.close_attempts == (1 if opened else 0)
    if not close_failed:
        assert not fake.is_open


def valid_replay_reads_only_last_range():
    store, write, _error = setup()
    before = store.fake.payload
    assert send(store, write) == {"next_offset": store.current}
    assert store.fake.reads == [(store.offset, 3)]
    assert store.fake.payload == before
    cleaned(store)


def fragmented_replay_is_bounded():
    store, write, _error = setup()
    store.fake.fragment = 1
    assert send(store, write) == {"next_offset": store.current}
    assert store.fake.reads == [
        (store.offset, 3), (store.offset + 1, 2), (store.offset + 2, 1)
    ]
    assert store.fake.position == store.current
    cleaned(store)


def corrupted_replay_is_interrupted():
    store, write, error = setup(payload=b"bad")
    before = store.fake.payload
    expect_error(error, "interrupted", lambda: send(store, write))
    assert store.fake.payload == before
    cleaned(store)


def short_replay_is_interrupted():
    store, write, error = setup()
    store.fake.short_read = True
    expect_error(error, "interrupted", lambda: send(store, write))
    assert store.fake.reads == [(store.offset, 3)]
    cleaned(store)


def changed_length_is_interrupted():
    store, write, error = setup()
    store.fake.size_override = store.current + 1
    expect_error(error, "interrupted", lambda: send(store, write))
    assert not store.fake.reads
    cleaned(store)


def seek_failure_is_unavailable():
    store, write, error = setup()
    store.fake.seek_error = OSError("synthetic seek failure")
    expect_error(error, "unavailable", lambda: send(store, write))
    assert not store.fake.reads
    cleaned(store)


def read_failure_is_unavailable():
    store, write, error = setup()
    store.fake.read_error = OSError("synthetic read failure")
    expect_error(error, "unavailable", lambda: send(store, write))
    cleaned(store)


def open_failure_releases_lock():
    store, write, error = setup()
    store.fake.open_error = OSError("synthetic open failure")
    expect_error(error, "unavailable", lambda: send(store, write))
    cleaned(store, opened=False)


def close_failure_releases_lock():
    store, write, error = setup()
    store.fake.close_error = OSError("synthetic close failure")
    expect_error(error, "unavailable", lambda: send(store, write))
    cleaned(store, close_failed=True)


def control_exception_survives_close_failure():
    for control_type in (KeyboardInterrupt, SystemExit):
        store, write, _error = setup()
        control = control_type("synthetic control")
        store.fake.read_error = control
        store.fake.close_error = OSError("synthetic close failure")
        try:
            send(store, write)
        except BaseException as caught:
            assert caught is control
        else:
            raise AssertionError("control exception was lost")
        cleaned(store, close_failed=True)


def mismatching_replay_is_conflict():
    store, write, error = setup()
    expect_error(error, "conflict", lambda: send(store, write, b"bad"))
    assert not store.fake.is_open and not store.fake.open_attempts
    assert not store.lock_active and store.lock_enters == 1 and store.lock_exits == 1


def oversized_input_is_rejected_before_lock():
    store, write, error = setup()
    limit = 4 * ((store.offset + 2) // 3)
    expect_error(error, "too_large", lambda: write(store, "synthetic-id", store.offset, "A" * (limit + 1)))
    assert not store.lock_active and not store.lock_enters and not store.fake.open_attempts


# OpenAI-Codex_web_ai: exercise the maximum final segment without real files.
def full_sized_final_chunk_replays_once():
    probe = {}
    exec(compile(ast.Module(body=constants, type_ignores=[]), str(SOURCE), "exec"), probe)  # noqa: S102
    chunk_bytes = probe["CHUNK_BYTES"]
    assert chunk_bytes == 262144
    final_chunk = b"z" * chunk_bytes
    store, write, _error = setup(original=final_chunk)
    before = store.fake.payload
    assert send(store, write, final_chunk) == {"next_offset": 2 * chunk_bytes}
    assert store.fake.reads == [(chunk_bytes, chunk_bytes)]
    assert store.fake.payload == before
    cleaned(store)


# OpenAI-Codex_web_ai: check actual open-helper calls inside the fake slot lock.
def replay_filesystem_calls_stay_within_slot_lock():
    import stat

    helpers = [
        node for node in TREE.body
        if isinstance(node, ast.FunctionDef) and node.name in {"_is_reparse", "_open_regular"}
    ]
    assert {node.name for node in helpers} == {"_is_reparse", "_open_regular"}
    helper_module = ast.Module(
        body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0), *helpers],
        type_ignores=[],
    )
    ast.fix_missing_locations(helper_module)
    helper_code = compile(helper_module, str(SOURCE), "exec")
    complete = ["lstat", "open", "fstat", "fstat", "lseek", "read", "close"]
    scenarios = {
        "success": complete,
        "open": ["lstat", "open"],
        "first_stat": ["lstat", "open", "fstat", "close"],
        "second_stat": ["lstat", "open", "fstat", "fstat", "close"],
        "seek": ["lstat", "open", "fstat", "fstat", "lseek", "close"],
        "read": complete,
        "close": complete,
    }
    for mode, expected in scenarios.items():
        store, write, error = setup()
        fake = store.fake
        events = []
        stat_calls = 0
        original_fstat = fake.fstat

        def lstat(path):
            assert path == ntpath.join("synthetic-slot", "payload.bin")
            return SimpleNamespace(st_mode=stat.S_IFREG, st_dev=1, st_ino=1)

        def open_file(path, flags):
            return fake.open_regular(path, flags)

        def fstat(fd):
            nonlocal stat_calls
            stat_calls += 1
            if (mode, stat_calls) in {("first_stat", 1), ("second_stat", 2)}:
                raise OSError("synthetic fstat failure")
            info = original_fstat(fd)
            return SimpleNamespace(st_mode=stat.S_IFREG, st_dev=1, st_ino=1, st_size=info.st_size)

        fake.lstat = lstat
        fake.open = open_file
        fake.fstat = fstat
        if mode in {"open", "seek", "read", "close"}:
            setattr(fake, mode + "_error", OSError("synthetic operation failure"))
        for name in ("lstat", "open", "fstat", "lseek", "read", "close"):
            operation = getattr(fake, name)

            def locked_operation(*args, _operation=operation, _name=name, **kwargs):
                assert store.lock_active, f"{_name} ran outside the fake slot lock"
                events.append(_name)
                return _operation(*args, **kwargs)

            setattr(fake, name, locked_operation)

        namespace = write.__globals__
        namespace.update({"stat": stat, "_REPARSE": 0x400, "_BINARY": 0, "_NOFOLLOW": 0})
        exec(helper_code, namespace)  # noqa: S102 - Run the real helper against fake OS methods.
        if mode == "success":
            assert send(store, write) == {"next_offset": store.current}
        else:
            expect_error(error, "unavailable", lambda: send(store, write))
        assert events == expected, (mode, events)
        cleaned(store, opened=mode != "open", close_failed=mode == "close")


def main():
    checks = (
        valid_replay_reads_only_last_range,
        full_sized_final_chunk_replays_once,
        replay_filesystem_calls_stay_within_slot_lock,
        fragmented_replay_is_bounded,
        corrupted_replay_is_interrupted,
        short_replay_is_interrupted,
        changed_length_is_interrupted,
        seek_failure_is_unavailable,
        read_failure_is_unavailable,
        open_failure_releases_lock,
        close_failure_releases_lock,
        control_exception_survives_close_failure,
        mismatching_replay_is_conflict,
        oversized_input_is_rejected_before_lock,
    )
    for check in checks:
        check()
        print("PASS " + check.__name__)
    print(f"{len(checks)}/{len(checks)} synthetic checks passed")


if __name__ == "__main__":
    main()
