"""OpenAI-Codex_app_ui: retained, synthetic checks for the upload storage core."""

import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid

if os.name == "nt":
    import ctypes
    from ctypes import wintypes

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from web_upload import UploadError, UploadStore  # noqa: E402
import web_upload as upload_module  # noqa: E402


ARTIFACTS = (
    Path(__file__).resolve().parents[2] / "_Retained_Upload_Safety_20261114_app_ui"
)
# OpenAI-Codex_app_ui: CI retains its own exclusively created workspace artifacts.
if os.environ.get("GITHUB_ACTIONS") == "true" and os.name == "nt":
    workspace_value = os.environ.get("GITHUB_WORKSPACE", "")
    if not workspace_value or not os.path.isabs(workspace_value):
        raise RuntimeError("GITHUB_WORKSPACE must be an absolute existing directory")
    workspace = Path(workspace_value).resolve(strict=True)
    if not workspace.is_dir():
        raise RuntimeError("GITHUB_WORKSPACE must be an absolute existing directory")
    ARTIFACTS = workspace / ("retained-upload-check-" + uuid.uuid4().hex)
    os.mkdir(ARTIFACTS, 0o700)
# OpenAI-Codex_Fork_Source_Code: keep the POSIX no-write probe inside the checkout.
if os.name != "nt":
    ARTIFACTS = Path(__file__).resolve().parents[1] / "retained-upload-posix-probe"
RUN = ARTIFACTS / ("storage-" + uuid.uuid4().hex)
DOWNLOADS = RUN / "downloads"
DIST = RUN / "frontend-dist"
CHUNK = 262144
ENV = {
    "MMDL_UPLOAD_MAX_FILE_BYTES": str(CHUNK + 16),
    "MMDL_UPLOAD_MAX_TOTAL_BYTES": str(3 * (CHUNK + 32768)),
}


def rejected(code, call, *args, **kwargs):
    try:
        call(*args, **kwargs)
    except UploadError as exc:
        assert exc.code == code, (exc.code, code, str(exc))
    else:
        raise AssertionError("expected " + code)


def b64(value):
    return base64.b64encode(value).decode("ascii")


# OpenAI-Codex_web_ai: release failures must still close the synthetic lock handle.
def check_lock_release_cleanup():
    from contextlib import ExitStack
    from types import SimpleNamespace
    from unittest.mock import patch

    def exercise(platform, failure=None):
        events = []
        fake_fd = 7319

        def acquire_or_release(fd, action):
            assert fd == fake_fd
            events.append(action)
            if action == failure:
                raise OSError("synthetic lock failure")
            if action == "release" and failure == "interrupt":
                raise KeyboardInterrupt()

        def locking(fd, mode, count):
            assert count == 1
            acquire_or_release(fd, "release" if mode == 2 else "acquire")

        def flock(fd, mode):
            acquire_or_release(fd, "release" if mode == 8 else "acquire")

        def seek(fd, offset, whence):
            assert fd == fake_fd and offset == 0 and whence == os.SEEK_SET
            events.append("seek")
            if failure == "release_seek" and "acquire" in events:
                raise OSError("synthetic seek failure")
            return 0

        def close(fd):
            assert fd == fake_fd
            events.append("close")

        backend = SimpleNamespace(
            LK_NBLCK=1,
            LK_UNLCK=2,
            locking=locking,
            LOCK_EX=2,
            LOCK_NB=4,
            LOCK_UN=8,
            flock=flock,
        )
        caught = None
        with ExitStack() as stack:
            stack.enter_context(
                patch.object(upload_module, "_directory", lambda _path: None)
            )
            stack.enter_context(
                patch.object(
                    upload_module, "_open_regular", lambda _path, _flags: fake_fd
                )
            )
            stack.enter_context(
                patch.object(os, "fstat", lambda _fd: SimpleNamespace(st_size=1))
            )
            stack.enter_context(patch.object(os, "lseek", seek))
            stack.enter_context(patch.object(os, "close", close))
            stack.enter_context(patch.object(os, "name", platform))
            stack.enter_context(
                patch.object(upload_module, "msvcrt", backend, create=True)
            )
            stack.enter_context(
                patch.object(upload_module, "fcntl", backend, create=True)
            )
            try:
                with UploadStore._locked("synthetic-slot"):
                    events.append("body")
                    if failure == "body":
                        raise RuntimeError("synthetic body failure")
            except BaseException as error:
                caught = error
        return events, caught

    for platform in ("nt", "posix"):
        prefix = ["seek"] if platform == "nt" else []
        release = ["seek", "release"] if platform == "nt" else ["release"]
        expected = prefix + ["acquire", "body"] + release + ["close"]
        events, error = exercise(platform)
        assert events == expected and error is None
        events, error = exercise(platform, "release")
        assert events == expected and isinstance(error, OSError)
        events, error = exercise(platform, "interrupt")
        assert events == expected and isinstance(error, KeyboardInterrupt)
        events, error = exercise(platform, "body")
        assert events == expected and isinstance(error, RuntimeError)
        events, error = exercise(platform, "acquire")
        assert events == prefix + ["acquire", "close"]
        assert isinstance(error, UploadError) and error.code == "conflict"
    events, error = exercise("nt", "release_seek")
    assert events == ["seek", "acquire", "body", "seek", "close"]
    assert isinstance(error, OSError)


def main():
    check_lock_release_cleanup()
    if os.name != "nt":
        assert UploadStore(str(DOWNLOADS), str(DIST), ENV).capabilities() == {
            "enabled": False,
            "reason": "unsupported_platform",
        }
        assert not RUN.exists(), "unsupported platforms must not create test artifacts"
        print("POSIX upload remains disabled; no synthetic artifacts created.")
        return
    assert ARTIFACTS.is_dir(), "retained parent must already exist"
    assert not RUN.exists()
    disabled = UploadStore(str(DOWNLOADS), str(DIST), {})
    assert disabled.capabilities() == {"enabled": False, "reason": "not_configured"}
    assert not RUN.exists(), "capabilities must not touch disk"
    original_os = {
        name: getattr(os, name) for name in ("open", "stat", "lstat", "mkdir")
    }
    original_realpath = os.path.realpath
    try:

        def deny_fs(*_args, **_kwargs):
            raise AssertionError("configuration must not inspect the filesystem")

        for name in original_os:
            setattr(os, name, deny_fs)
        os.path.realpath = deny_fs
        assert UploadStore(str(DOWNLOADS), str(DIST), ENV).capabilities()["enabled"]
        assert disabled.capabilities()["reason"] == "not_configured"
    finally:
        for name, value in original_os.items():
            setattr(os, name, value)
        os.path.realpath = original_realpath
    assert (
        UploadStore(
            str(DOWNLOADS), str(DIST), ENV, restricted_paths=False
        ).capabilities()["reason"]
        == "unrestricted_paths"
    )
    assert (
        UploadStore(
            str(DOWNLOADS), str(DIST), {**ENV, "MMDL_UPLOAD_MAX_TOTAL_BYTES": "1"}
        ).capabilities()["reason"]
        == "insufficient_total"
    )
    assert (
        UploadStore(
            str(DOWNLOADS),
            str(DIST),
            {**ENV, "MMDL_UPLOAD_MAX_TOTAL_BYTES": str(1 << 53)},
        ).capabilities()["reason"]
        == "invalid_configuration"
    )
    assert (
        UploadStore(
            str(DOWNLOADS),
            str(DIST),
            {**ENV, "MMDL_UPLOAD_MAX_FILE_BYTES": str(1 << 53)},
        ).capabilities()["reason"]
        == "invalid_configuration"
    )
    assert UploadStore(
        str(DOWNLOADS),
        str(DIST),
        {
            "MMDL_UPLOAD_MAX_FILE_BYTES": "1",
            "MMDL_UPLOAD_MAX_TOTAL_BYTES": str((1 << 53) - 1),
        },
    ).capabilities()["enabled"]
    assert not RUN.exists()
    original_name = os.name
    try:
        os.name = "posix"
        assert (
            UploadStore(str(DOWNLOADS), str(DIST), ENV).capabilities()["reason"]
            == "unsupported_platform"
        )
    finally:
        os.name = original_name
    os.mkdir(RUN)
    os.mkdir(DOWNLOADS)
    os.mkdir(DIST)
    store = UploadStore(str(DOWNLOADS), str(DIST), ENV)
    caps = store.capabilities()
    assert caps["enabled"] and caps["chunk_bytes"] == CHUNK
    assert caps["max_file_bytes"] == CHUNK + 16
    assert caps["max_total_bytes"] == int(ENV["MMDL_UPLOAD_MAX_TOTAL_BYTES"])
    before = DOWNLOADS / ".mmdl-uploads-v1" / "slot-00" / "payload.mkv"
    rejected("unsafe_path", store.authorize_path, str(before))
    rejected("unsafe_path", store.authorize_path, str(before), write=True)
    store.authorize_path(str(DOWNLOADS), write=True)
    rejected("invalid_request", store.create, "bad/name", 1)
    rejected("invalid_request", store.create, "bad\u0080name", 1)
    rejected("invalid_request", store.create, "ok.mkv", True)
    rejected("too_large", store.create, "ok.mkv", CHUNK + 17)

    created = store.create("synthetic.MKV", CHUNK + 5)
    upload_id = created["upload_id"]
    assert len(upload_id) == 35 and created["next_offset"] == 0
    slot = DOWNLOADS / ".mmdl-uploads-v1" / ("slot-" + upload_id[:2])
    payload = slot / "payload.mkv"
    rejected("unsafe_path", store.authorize_path, str(payload))
    rejected("unsafe_path", store.authorize_path, str(slot / "meta.json"))
    rejected("unsafe_path", store.authorize_path, str(slot / "nonexistent"), write=True)
    first = (b"OpenAI-Codex_app_ui:" * ((CHUNK // 20) + 1))[:CHUNK]
    assert len(first) == CHUNK
    assert store.write_chunk(upload_id, 0, b64(first))["next_offset"] == CHUNK
    assert store.write_chunk(upload_id, 0, b64(first))["next_offset"] == CHUNK
    rejected("conflict", store.write_chunk, upload_id, 0, b64(b"x" * CHUNK))
    rejected("conflict", store.write_chunk, upload_id, CHUNK + 1, b64(b"last!"))
    rejected(
        "invalid_request", store.write_chunk, upload_id, CHUNK, "not-valid-base64!"
    )
    assert (
        store.write_chunk(upload_id, CHUNK, b64(b"last!"))["next_offset"] == CHUNK + 5
    )
    rejected("unsafe_path", store.authorize_path, str(payload))
    finished = store.finish(upload_id)
    assert finished == {"path": f".mmdl-uploads-v1/slot-{upload_id[:2]}/payload.mkv"}
    assert store.finish(upload_id) == finished
    store.authorize_path(str(payload))
    UploadStore(str(DOWNLOADS), str(DIST), {}).authorize_path(str(payload))
    stage = DOWNLOADS / ".mmdl-uploads-v1"
    for suffix in (".", " ", "..."):
        alias = str(stage) + suffix
        if os.path.samefile(alias, stage):
            rejected("unsafe_path", store.authorize_path, alias, write=True)
            rejected(
                "unsafe_path",
                store.authorize_path,
                os.path.join(alias, "slot-00", "future"),
                write=True,
            )
    rejected("unsafe_path", store.authorize_path, str(stage).upper(), write=True)
    rejected("unsafe_path", store.authorize_path, "\\\\?\\" + str(stage), write=True)
    rejected("unsafe_path", store.authorize_path, str(stage) + ":synthetic", write=True)
    short_name = ctypes.WinDLL("kernel32", use_last_error=True).GetShortPathNameW
    short_name.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD]
    short_name.restype = wintypes.DWORD
    short_buffer = ctypes.create_unicode_buffer(32768)
    short_length = short_name(str(stage), short_buffer, len(short_buffer))
    distinct_short = bool(
        short_length
        and short_length < len(short_buffer)
        and os.path.normcase(short_buffer.value) != os.path.normcase(str(stage))
    )
    if distinct_short and os.path.samefile(short_buffer.value, stage):
        rejected(
            "unsafe_path",
            store.authorize_path,
            os.path.join(short_buffer.value, "slot-00", "future"),
            write=True,
        )
    print("Distinct Windows 8.3 stage alias tested:", distinct_short)

    # Simulate a short name for a nested or older staging root; no real short name is assumed.
    alias_parent = RUN / "short-alias-parent"
    os.mkdir(alias_parent)
    fake_short = alias_parent / "MMDLUP~1"
    os.mkdir(fake_short)
    saved_long = upload_module._windows_long_path
    try:

        def fake_long(value):
            if os.path.normcase(os.path.normpath(value)) == os.path.normcase(
                os.path.normpath(str(fake_short))
            ):
                return str(stage)
            return saved_long(value)

        upload_module._windows_long_path = fake_long
        rejected(
            "unsafe_path",
            store.authorize_path,
            str(fake_short / "slot-00" / "future"),
            write=True,
        )
    finally:
        upload_module._windows_long_path = saved_long

    # Generic UNC/device inputs retain existing behavior without core network probing.
    saved_realpath, saved_samefile = os.path.realpath, os.path.samefile
    try:

        def no_remote_probe(*_args, **_kwargs):
            raise AssertionError("the core must not probe a generic UNC path")

        os.path.realpath = no_remote_probe
        os.path.samefile = no_remote_probe
        store.authorize_path(r"\\synthetic.invalid\share\ordinary")
        rejected(
            "unsafe_path",
            store.authorize_path,
            r"\\synthetic.invalid\share\.mmdl-uploads-v1\payload",
        )
    finally:
        os.path.realpath, os.path.samefile = saved_realpath, saved_samefile
    rejected("unsafe_path", store.authorize_path, str(payload), write=True)
    rejected("unsafe_path", store.authorize_path, str(slot / "completed"))
    rejected("conflict", store.write_chunk, upload_id, CHUNK, b64(b"last!"))
    with open(payload, "rb") as stream:
        assert stream.read() == first + b"last!"

    empty = store.create("empty", 0)
    assert store.finish(empty["upload_id"])["path"].endswith("/payload.bin")
    broken = store.create("broken.mp4", 1)
    broken_slot = DOWNLOADS / ".mmdl-uploads-v1" / ("slot-" + broken["upload_id"][:2])
    with open(broken_slot / "journal.bin", "ab") as stream:
        stream.write(b"x")
        stream.flush()
        os.fsync(stream.fileno())
    rejected("interrupted", store.finish, broken["upload_id"])
    rejected("unsafe_path", store.authorize_path, str(broken_slot / "payload.mp4"))
    rejected("quota_exhausted", store.create, "extra.mp4", 1)

    other_root = RUN / "old-root" / ".mmdl-uploads-v1" / "slot-00" / "payload.mp4"
    rejected("unsafe_path", store.authorize_path, str(other_root))
    changed = UploadStore(
        str(DOWNLOADS), str(DIST), {**ENV, "MMDL_UPLOAD_MAX_FILE_BYTES": str(CHUNK)}
    )
    rejected("invalid_config", changed.create, "later.mp4", 1)

    # An uncreated root is not touched by a stray chunk; an explicit create may initialize it.
    fresh_root = RUN / "fresh-downloads"
    fresh = UploadStore(str(fresh_root), str(DIST), ENV)
    rejected("not_found", fresh.write_chunk, "00-" + "a" * 32, 0, b64(b"x"))
    assert not fresh_root.exists()
    fresh_create = fresh.create("fresh.mp4", 1)
    assert fresh_root.is_dir() and fresh_create["next_offset"] == 0

    # An unrelated pre-existing namespace is never adopted or overwritten.
    collision_root = RUN / "collision-downloads"
    os.mkdir(collision_root)
    collision_dir = collision_root / ".mmdl-uploads-v1"
    os.mkdir(collision_dir)
    user_marker = collision_dir / "user-owned.txt"
    with open(user_marker, "xb") as stream:
        stream.write(b"OpenAI-Codex_app_ui: preserved user content")
    collision = UploadStore(str(collision_root), str(DIST), ENV)
    rejected("unavailable", collision.create, "x.mp4", 1)
    with open(user_marker, "rb") as stream:
        assert stream.read() == b"OpenAI-Codex_app_ui: preserved user content"
    rejected("unsafe_path", collision.authorize_path, str(user_marker))

    # A staging root under the frontend static directory is not initialized.
    overlap_root = RUN / "overlap-downloads"
    os.mkdir(overlap_root)
    overlap = UploadStore(str(overlap_root), str(overlap_root), ENV)
    rejected("unsafe_path", overlap.create, "x.mp4", 1)
    assert not (overlap_root / ".mmdl-uploads-v1").exists()

    # A lexical fixed drive resolving to remote storage is rejected before any write.
    fixed_alias = str(RUN / "synthetic-fixed-alias")
    saved_realpath = os.path.realpath
    saved_local_root = upload_module._windows_local_root
    saved_mutations = {
        name: getattr(os, name) for name in ("mkdir", "makedirs", "open")
    }
    try:

        def forbidden_write(*_args, **_kwargs):
            raise AssertionError("remote upload root must be rejected before writing")

        for name in saved_mutations:
            setattr(os, name, forbidden_write)
        for remote in (r"Z:\synthetic-remote", r"\\synthetic.invalid\share\synthetic"):
            os.path.realpath = lambda value, *a, **kw: (
                remote if value == fixed_alias else saved_realpath(value, *a, **kw)
            )
            upload_module._windows_local_root = lambda value: value != remote
            remote_store = UploadStore(fixed_alias, str(DIST), ENV)
            rejected("unsafe_path", remote_store.create, "synthetic.mp4", 1)
    finally:
        os.path.realpath = saved_realpath
        upload_module._windows_local_root = saved_local_root
        for name, value in saved_mutations.items():
            setattr(os, name, value)

    # A reparse point in an existing root ancestor is rejected before resolution or creation.
    fake_junction = str(RUN / "synthetic-junction")
    fake_child = os.path.join(fake_junction, "missing", "downloads")
    saved_lstat, saved_realpath = os.lstat, os.path.realpath
    saved_mutations = {
        name: getattr(os, name) for name in ("mkdir", "makedirs", "open")
    }
    try:

        class FakeReparse:
            st_mode = 0o040700
            st_file_attributes = 0x400

        def fake_lstat(value, *args, **kwargs):
            if os.path.normcase(os.path.normpath(value)) == os.path.normcase(
                os.path.normpath(fake_junction)
            ):
                return FakeReparse()
            if os.path.normcase(value).startswith(
                os.path.normcase(fake_junction + os.sep)
            ):
                raise AssertionError(
                    "must not traverse beyond an untrusted reparse ancestor"
                )
            return saved_lstat(value, *args, **kwargs)

        def forbidden_reparse_io(*_args, **_kwargs):
            raise AssertionError(
                "reparse root must be rejected before resolution or writing"
            )

        os.lstat = fake_lstat
        os.path.realpath = forbidden_reparse_io
        for name in saved_mutations:
            setattr(os, name, forbidden_reparse_io)
        rejected(
            "unsafe_path",
            UploadStore(fake_child, str(DIST), ENV).create,
            "synthetic.mp4",
            1,
        )
    finally:
        os.lstat, os.path.realpath = saved_lstat, saved_realpath
        for name, value in saved_mutations.items():
            setattr(os, name, value)

    # A mapped or unknown drive is classified before realpath or filesystem probes.
    saved_local_root = upload_module._windows_local_root
    saved_realpath, saved_samefile, saved_lstat = (
        os.path.realpath,
        os.path.samefile,
        os.lstat,
    )
    try:

        def forbidden_mapped_probe(*_args, **_kwargs):
            raise AssertionError(
                "mapped drives must not be resolved or probed by the upload guard"
            )

        upload_module._windows_local_root = (
            lambda value: not str(value).lower().startswith("z:")
        )
        os.path.realpath = forbidden_mapped_probe
        os.path.samefile = forbidden_mapped_probe
        os.lstat = forbidden_mapped_probe
        store.authorize_path(r"Z:\synthetic\ordinary")
        rejected(
            "unsafe_path",
            store.authorize_path,
            r"Z:\synthetic\.mmdl-uploads-v1\payload",
        )
    finally:
        upload_module._windows_local_root = saved_local_root
        os.path.realpath, os.path.samefile, os.lstat = (
            saved_realpath,
            saved_samefile,
            saved_lstat,
        )

    # Competing processes with different bytes cannot both commit one offset.
    race_root = RUN / "race-downloads"
    racer = UploadStore(str(race_root), str(DIST), ENV)
    race = racer.create("race.mp4", CHUNK)
    child = r"""
import base64, json, sys
sys.path.insert(0, sys.argv[1])
from web_upload import UploadError, UploadStore
root, dist, upload_id, label, file_cap, total_cap = sys.argv[2:]
store = UploadStore(root, dist, {"MMDL_UPLOAD_MAX_FILE_BYTES": file_cap,
                                  "MMDL_UPLOAD_MAX_TOTAL_BYTES": total_cap})
sys.stdin.read(1)
try:
    result = store.write_chunk(upload_id, 0, base64.b64encode(label.encode() * 262144).decode())
    print(json.dumps({"result": "committed", "label": label, "offset": result["next_offset"]}))
except UploadError as exc:
    print(json.dumps({"result": exc.code, "label": label}))
"""
    procs = [
        subprocess.Popen(  # noqa: S603
            [
                sys.executable,
                "-B",
                "-c",
                child,
                str(Path(__file__).resolve().parents[1]),
                str(race_root),
                str(DIST),
                race["upload_id"],
                label,
                ENV["MMDL_UPLOAD_MAX_FILE_BYTES"],
                ENV["MMDL_UPLOAD_MAX_TOTAL_BYTES"],
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        for label in ("A", "B")
    ]
    for proc in procs:
        proc.stdin.write("x")
        proc.stdin.flush()
    outcomes = []
    for proc in procs:
        stdout, stderr = proc.communicate(timeout=30)
        assert proc.returncode == 0 and not stderr, (proc.returncode, stderr)
        outcomes.append(json.loads(stdout))
    winners = [outcome for outcome in outcomes if outcome["result"] == "committed"]
    assert (
        len(winners) == 1
        and sum(outcome["result"] == "conflict" for outcome in outcomes) == 1
    ), outcomes
    race_path = race_root / racer.finish(race["upload_id"])["path"]
    with open(race_path, "rb") as stream:
        assert (
            hashlib.sha256(stream.read()).digest()
            == hashlib.sha256(winners[0]["label"].encode() * CHUNK).digest()
        )

    # A process crash after recording an intent and writing data cannot publish or resume it.
    crash = racer.create("crash.mp4", 1)
    crash_slot = race_root / ".mmdl-uploads-v1" / ("slot-" + crash["upload_id"][:2])
    crash_child = r"""
import hashlib, os, struct, sys
slot = sys.argv[1]
with open(os.path.join(slot, "journal.bin"), "ab") as stream:
    stream.write(struct.pack(">cQQ32s", b"I", 0, 1, hashlib.sha256(b"x").digest()))
    stream.flush()
    os.fsync(stream.fileno())
with open(os.path.join(slot, "payload.mp4"), "ab") as stream:
    stream.write(b"x")
    stream.flush()
    os.fsync(stream.fileno())
os._exit(23)
"""
    crashed = subprocess.run(
        [sys.executable, "-B", "-c", crash_child, str(crash_slot)],  # noqa: S603
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert crashed.returncode == 23 and not crashed.stderr
    restarted = UploadStore(str(race_root), str(DIST), ENV)
    rejected("interrupted", restarted.write_chunk, crash["upload_id"], 0, b64(b"x"))
    rejected("interrupted", restarted.finish, crash["upload_id"])
    rejected("unsafe_path", restarted.authorize_path, str(crash_slot / "payload.mp4"))

    # An in-flight writer's lock prevents simultaneous seal or payload access.
    locked = racer.create("locked.mp4", 0)
    locked_slot = race_root / ".mmdl-uploads-v1" / ("slot-" + locked["upload_id"][:2])
    lock_child = r"""
import sys
sys.path.insert(0, sys.argv[1])
from web_upload import UploadStore
root, dist, upload_id, file_cap, total_cap = sys.argv[2:]
store = UploadStore(root, dist, {"MMDL_UPLOAD_MAX_FILE_BYTES": file_cap,
                                  "MMDL_UPLOAD_MAX_TOTAL_BYTES": total_cap})
slot, _ = store._slot(upload_id)
with store._locked(slot):
    print("locked", flush=True)
    sys.stdin.read(1)
"""
    holder = subprocess.Popen(  # noqa: S603
        [
            sys.executable,
            "-B",
            "-c",
            lock_child,
            str(Path(__file__).resolve().parents[1]),
            str(race_root),
            str(DIST),
            locked["upload_id"],
            ENV["MMDL_UPLOAD_MAX_FILE_BYTES"],
            ENV["MMDL_UPLOAD_MAX_TOTAL_BYTES"],
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert holder.stdout.readline().strip() == "locked"
    rejected("conflict", racer.finish, locked["upload_id"])
    rejected("unsafe_path", racer.authorize_path, str(locked_slot / "payload.mp4"))
    holder.stdin.write("x")
    holder.stdin.flush()
    _, holder_error = holder.communicate(timeout=30)
    assert holder.returncode == 0 and not holder_error
    locked_result = racer.finish(locked["upload_id"])
    racer.authorize_path(str(race_root / locked_result["path"]))

    # A forged completion marker cannot publish an incomplete payload.
    forged = fresh.create("forged.mp4", 1)
    forged_slot = fresh_root / ".mmdl-uploads-v1" / ("slot-" + forged["upload_id"][:2])
    with open(forged_slot / "completed", "xb"):
        pass
    rejected("unsafe_path", fresh.authorize_path, str(forged_slot / "payload.mp4"))
    rejected("conflict", fresh.finish, forged["upload_id"])

    # Model an existing symlink alias without requiring symlink privileges on this machine.
    alias = str(DOWNLOADS / "synthetic-alias")
    original_realpath = os.path.realpath
    try:
        os.path.realpath = lambda value, *a, **kw: (
            str(payload) if value == alias else original_realpath(value, *a, **kw)
        )
        store.authorize_path(alias)
        rejected("unsafe_path", store.authorize_path, alias, write=True)
    finally:
        os.path.realpath = original_realpath
    print(
        "Upload storage checks passed; all synthetic artifacts retained at " + str(RUN)
    )


if __name__ == "__main__":
    main()
