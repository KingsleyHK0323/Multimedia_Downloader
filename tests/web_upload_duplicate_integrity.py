"""Memory-only checks for duplicate-chunk integrity and descriptor cleanup.

OpenAI-Codex_engine_cli: actual upload methods are loaded through the existing
in-memory bridge; no listener, real upload path, media, or network is used.
"""

from __future__ import annotations

import importlib.util
import ntpath
from pathlib import Path
from types import SimpleNamespace


TEST_MODULE = Path(__file__).absolute().with_name("web_upload_negative_behavior.py")
SPEC = importlib.util.spec_from_file_location("upload_negative_memory", TEST_MODULE)
assert SPEC is not None and SPEC.loader is not None
negative = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(negative)
CHUNK = negative.CHUNK


def prepare():
    service = negative.bridge.FakeWeb(negative.SETTINGS)
    created = negative.post(
        service, "/api/uploads", {"name": "synthetic.mp4", "size": CHUNK + 3}
    )
    assert created["status"] == 200
    upload_id = created["body"]["upload_id"]
    first = negative.encoded(b"x" * CHUNK)
    last = negative.encoded(b"end")
    assert negative.send_chunk(service, upload_id, 0, first)["status"] == 200
    assert negative.send_chunk(service, upload_id, CHUNK, last)["status"] == 200
    path = ntpath.join(
        service.files.cwd, "downloads", ".mmdl-uploads-v1", "slot-00", "payload.mp4"
    )
    return service, upload_id, last, path


def payload_handle(service, fd):
    return service.files.handles[fd]["key"].endswith("\\payload.mp4")


def no_open_handles_or_locks(service):
    assert not service.files.handles, service.files.handles
    assert not service.ns["msvcrt"].held, service.ns["msvcrt"].held


def duplicate_detects_last_chunk_corruption():
    service, upload_id, last, path = prepare()
    service.files.nodes[service.files.key(path)]["data"][-1] ^= 1
    before = service.files.snapshot(upload_id)
    replay = negative.send_chunk(service, upload_id, CHUNK, last)
    assert replay["status"] == 409 and replay["body"]["error_code"] == "interrupted", replay
    assert service.files.snapshot(upload_id) == before
    no_open_handles_or_locks(service)


def duplicate_reads_only_the_last_chunk():
    service, upload_id, last, _path = prepare()
    reads = []
    original_read = service.os.read

    def trace(fd, count):
        if payload_handle(service, fd):
            reads.append((service.files.handles[fd]["position"], count))
        return original_read(fd, count)

    service.os.read = trace
    replay = negative.send_chunk(service, upload_id, CHUNK, last)
    assert replay == {"status": 200, "body": {"next_offset": CHUNK + 3}}
    assert reads == [(CHUNK, 3)], reads
    no_open_handles_or_locks(service)


def duplicate_allows_fragmented_reads():
    service, upload_id, last, _path = prepare()
    reads = []
    original_read = service.os.read

    def fragmented(fd, count):
        if payload_handle(service, fd):
            reads.append((service.files.handles[fd]["position"], count))
            return original_read(fd, min(1, count))
        return original_read(fd, count)

    service.os.read = fragmented
    assert negative.send_chunk(service, upload_id, CHUNK, last)["status"] == 200
    assert reads == [(CHUNK, 3), (CHUNK + 1, 2), (CHUNK + 2, 1)], reads
    no_open_handles_or_locks(service)


def duplicate_rejects_short_read_and_releases_descriptor():
    service, upload_id, last, _path = prepare()
    original_read = service.os.read

    def short(fd, count):
        if payload_handle(service, fd):
            return b""
        return original_read(fd, count)

    service.os.read = short
    replay = negative.send_chunk(service, upload_id, CHUNK, last)
    assert replay["status"] == 409 and replay["body"]["error_code"] == "interrupted", replay
    no_open_handles_or_locks(service)


def duplicate_seek_failure_releases_descriptor():
    service, upload_id, last, _path = prepare()
    original_seek = service.os.lseek

    def failing_seek(fd, offset, whence):
        if payload_handle(service, fd):
            raise OSError("synthetic seek failure")
        return original_seek(fd, offset, whence)

    service.os.lseek = failing_seek
    replay = negative.send_chunk(service, upload_id, CHUNK, last)
    assert replay["status"] == 503 and replay["body"]["error_code"] == "unavailable", replay
    no_open_handles_or_locks(service)


def duplicate_open_failure_releases_lock():
    service, upload_id, last, _path = prepare()
    original_open = service.os.open
    payload_opens = 0

    def failing_open(path, flags, *args):
        nonlocal payload_opens
        if ntpath.basename(path).lower() == "payload.mp4":
            payload_opens += 1
            if payload_opens == 2:
                raise OSError("synthetic duplicate open failure")
        return original_open(path, flags, *args)

    service.os.open = failing_open
    replay = negative.send_chunk(service, upload_id, CHUNK, last)
    assert replay["status"] == 503 and replay["body"]["error_code"] == "unavailable", replay
    assert payload_opens == 2
    no_open_handles_or_locks(service)


def duplicate_stat_failure_releases_descriptor():
    service, upload_id, last, _path = prepare()
    original_stat = service.os.fstat
    payload_stats = 0

    def failing_stat(fd):
        nonlocal payload_stats
        result = original_stat(fd)
        if payload_handle(service, fd):
            payload_stats += 1
            if payload_stats == 4:
                raise OSError("synthetic duplicate stat failure")
        return result

    service.os.fstat = failing_stat
    replay = negative.send_chunk(service, upload_id, CHUNK, last)
    assert replay["status"] == 503 and replay["body"]["error_code"] == "unavailable", replay
    assert payload_stats == 4
    no_open_handles_or_locks(service)


def duplicate_length_change_is_rejected():
    service, upload_id, last, _path = prepare()
    original_stat = service.os.fstat
    payload_stats = 0

    def changed_size(fd):
        nonlocal payload_stats
        result = original_stat(fd)
        if payload_handle(service, fd):
            payload_stats += 1
            if payload_stats == 4:
                return SimpleNamespace(st_size=result.st_size + 1)
        return result

    service.os.fstat = changed_size
    replay = negative.send_chunk(service, upload_id, CHUNK, last)
    assert replay["status"] == 409 and replay["body"]["error_code"] == "interrupted", replay
    assert payload_stats == 4
    no_open_handles_or_locks(service)


def duplicate_close_failure_is_reported():
    service, upload_id, last, _path = prepare()
    original_close = service.os.close
    payload_closes = 0

    def failing_close(fd):
        nonlocal payload_closes
        is_payload = payload_handle(service, fd)
        original_close(fd)
        if is_payload:
            payload_closes += 1
            if payload_closes == 2:
                raise OSError("synthetic error after duplicate descriptor close")

    service.os.close = failing_close
    replay = negative.send_chunk(service, upload_id, CHUNK, last)
    assert replay["status"] == 503 and replay["body"]["error_code"] == "unavailable", replay
    assert payload_closes == 2
    no_open_handles_or_locks(service)


def duplicate_full_chunk_has_bounded_read():
    service = negative.bridge.FakeWeb(negative.SETTINGS)
    created = negative.post(
        service, "/api/uploads", {"name": "synthetic.mp4", "size": CHUNK + 3}
    )
    upload_id = created["body"]["upload_id"]
    chunk = negative.encoded(b"x" * CHUNK)
    assert negative.send_chunk(service, upload_id, 0, chunk)["status"] == 200
    reads = []
    original_read = service.os.read

    def trace(fd, count):
        if payload_handle(service, fd):
            reads.append((service.files.handles[fd]["position"], count))
        return original_read(fd, count)

    service.os.read = trace
    replay = negative.send_chunk(service, upload_id, 0, chunk)
    assert replay == {"status": 200, "body": {"next_offset": CHUNK}}
    assert reads == [(0, CHUNK)], reads
    no_open_handles_or_locks(service)


def prior_chunk_corruption_remains_finish_check():
    service, upload_id, last, path = prepare()
    service.files.nodes[service.files.key(path)]["data"][0] ^= 1
    assert negative.send_chunk(service, upload_id, CHUNK, last)["status"] == 200
    finish = negative.post(service, "/api/uploads/finish", {"upload_id": upload_id})
    assert finish["status"] == 409 and finish["body"]["error_code"] == "interrupted", finish
    assert not service.files.snapshot(upload_id)["completed"]
    no_open_handles_or_locks(service)


def changed_retry_still_rejects_without_payload_read():
    service, upload_id, _last, _path = prepare()
    original_read = service.os.read

    def no_payload_read(fd, count):
        if payload_handle(service, fd):
            raise AssertionError("different retry should be rejected before reading payload")
        return original_read(fd, count)

    service.os.read = no_payload_read
    replay = negative.send_chunk(service, upload_id, CHUNK, negative.encoded(b"bad"))
    assert replay["status"] == 409 and replay["body"]["error_code"] == "conflict", replay
    no_open_handles_or_locks(service)


def duplicate_body_control_survives_close_oserror(control_error):
    service, upload_id, last, _path = prepare()
    original_read = service.ns["_read_exact"]
    original_close = service.os.close
    payload_closes = 0
    close_error = OSError("synthetic duplicate close failure")

    def failing_read(fd, count):
        if payload_handle(service, fd):
            raise control_error
        return original_read(fd, count)

    def failing_close(fd):
        nonlocal payload_closes
        if payload_handle(service, fd):
            payload_closes += 1
            if payload_closes == 2:
                raise close_error
        return original_close(fd)

    service.ns["_read_exact"] = failing_read
    service.os.close = failing_close
    raised = None
    response = None
    try:
        response = negative.send_chunk(service, upload_id, CHUNK, last)
    except BaseException as exc:
        raised = exc
    assert payload_closes == 2, payload_closes
    assert not service.ns["msvcrt"].held
    assert raised is control_error, (
        f"body control exception was replaced; raised={raised!r}, response={response!r}"
    )


def handled_outer_control_does_not_hide_duplicate_close_error():
    service, upload_id, last, _path = prepare()
    original_close = service.os.close
    payload_closes = 0

    def failing_close(fd):
        nonlocal payload_closes
        if payload_handle(service, fd):
            payload_closes += 1
            if payload_closes == 2:
                raise OSError("synthetic duplicate close failure")
        return original_close(fd)

    service.os.close = failing_close
    try:
        raise KeyboardInterrupt("synthetic handled outer exception")
    except KeyboardInterrupt:
        response = negative.send_chunk(service, upload_id, CHUNK, last)
    assert payload_closes == 2, payload_closes
    assert response["status"] == 503 and response["body"]["error_code"] == "unavailable", response


def prepare_fresh_append():
    # OpenAI-Codex_engine_cli: the storage and descriptors here are memory-only fakes.
    service = negative.bridge.FakeWeb(negative.SETTINGS)
    created = negative.post(service, "/api/uploads", {"name": "append.mp4", "size": 3})
    assert created["status"] == 200, created
    return service, created["body"]["upload_id"]


def append_close_failure_service(failed_names, control_error=None):
    service, upload_id = prepare_fresh_append()
    original_write = service.os.write
    original_close = service.os.close
    close_calls = []

    def failing_write(fd, data):
        descriptor = service.files.handles[fd]
        if (control_error is not None and descriptor["append"]
                and ntpath.basename(descriptor["key"]) == "payload.mp4"):
            raise control_error
        return original_write(fd, data)

    def failing_close(fd):
        descriptor = service.files.handles[fd]
        name = ntpath.basename(descriptor["key"])
        if descriptor["append"] and name in ("payload.mp4", "journal.bin"):
            close_calls.append((fd, name))
            if name in failed_names:
                raise OSError(f"synthetic {name} append close failure")
        return original_close(fd)

    service.os.write = failing_write
    service.os.close = failing_close
    return service, upload_id, close_calls


def assert_append_closes_attempted_once(service, close_calls):
    assert [name for _fd, name in close_calls] == ["payload.mp4", "journal.bin"], close_calls
    assert len({fd for fd, _name in close_calls}) == 2, close_calls
    assert not service.ns["msvcrt"].held


def append_body_control_survives_close_errors(control_error, failed_names):
    service, upload_id, close_calls = append_close_failure_service(failed_names, control_error)
    raised = None
    response = None
    try:
        response = negative.send_chunk(service, upload_id, 0, negative.encoded(b"abc"))
    except BaseException as exc:
        raised = exc
    assert_append_closes_attempted_once(service, close_calls)
    assert raised is control_error, (
        f"body control exception was replaced; raised={raised!r}, response={response!r}"
    )


def handled_outer_control_does_not_hide_append_close_errors(failed_names):
    service, upload_id, close_calls = append_close_failure_service(failed_names)
    try:
        raise KeyboardInterrupt("synthetic handled outer exception")
    except KeyboardInterrupt:
        response = negative.send_chunk(service, upload_id, 0, negative.encoded(b"abc"))
    assert_append_closes_attempted_once(service, close_calls)
    assert response["status"] == 503 and response["body"]["error_code"] == "unavailable", response


def main():
    checks = (
        ("detect last chunk corruption", duplicate_detects_last_chunk_corruption),
        ("read only last chunk", duplicate_reads_only_the_last_chunk),
        ("allow fragmented reads", duplicate_allows_fragmented_reads),
        ("reject short read and close", duplicate_rejects_short_read_and_releases_descriptor),
        ("close after seek failure", duplicate_seek_failure_releases_descriptor),
        ("release lock after open failure", duplicate_open_failure_releases_lock),
        ("close after stat failure", duplicate_stat_failure_releases_descriptor),
        ("reject changed payload length", duplicate_length_change_is_rejected),
        ("report close failure", duplicate_close_failure_is_reported),
        ("bound a full chunk read", duplicate_full_chunk_has_bounded_read),
        ("earlier corruption remains finish check", prior_chunk_corruption_remains_finish_check),
        ("different retry remains conflict", changed_retry_still_rejects_without_payload_read),
        ("duplicate SystemExit survives close OSError",
         lambda: duplicate_body_control_survives_close_oserror(SystemExit("synthetic exit"))),
        ("duplicate KeyboardInterrupt survives close OSError",
         lambda: duplicate_body_control_survives_close_oserror(KeyboardInterrupt("synthetic interrupt"))),
        ("handled outer control does not hide duplicate close failure",
         handled_outer_control_does_not_hide_duplicate_close_error),
        ("append KeyboardInterrupt survives payload close failure",
         lambda: append_body_control_survives_close_errors(
             KeyboardInterrupt("synthetic interrupt"), ("payload.mp4",))),
        ("append KeyboardInterrupt survives journal close failure",
         lambda: append_body_control_survives_close_errors(
             KeyboardInterrupt("synthetic interrupt"), ("journal.bin",))),
        ("append KeyboardInterrupt survives both close failures",
         lambda: append_body_control_survives_close_errors(
             KeyboardInterrupt("synthetic interrupt"), ("payload.mp4", "journal.bin"))),
        ("append SystemExit survives payload close failure",
         lambda: append_body_control_survives_close_errors(
             SystemExit("synthetic exit"), ("payload.mp4",))),
        ("append SystemExit survives journal close failure",
         lambda: append_body_control_survives_close_errors(
             SystemExit("synthetic exit"), ("journal.bin",))),
        ("append SystemExit survives both close failures",
         lambda: append_body_control_survives_close_errors(
             SystemExit("synthetic exit"), ("payload.mp4", "journal.bin"))),
        ("handled outer control does not hide append payload close failure",
         lambda: handled_outer_control_does_not_hide_append_close_errors(("payload.mp4",))),
        ("handled outer control does not hide append journal close failure",
         lambda: handled_outer_control_does_not_hide_append_close_errors(("journal.bin",))),
        ("handled outer control does not hide both append close failures",
         lambda: handled_outer_control_does_not_hide_append_close_errors(
             ("payload.mp4", "journal.bin"))),
    )
    failures = []
    for name, check in checks:
        try:
            check()
        except Exception as exc:
            failures.append(name)
            print(f"FAIL {name}: {type(exc).__name__}: {exc}")
        else:
            print(f"PASS {name}")
    if failures:
        raise SystemExit(1)
    print("All duplicate-chunk integrity memory checks passed.")


if __name__ == "__main__":
    main()
