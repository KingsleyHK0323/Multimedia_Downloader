"""Memory-only descriptor cleanup checks for UploadStore._inspect.

OpenAI-Codex_engine_cli: synthetic handles are never real OS descriptors.
"""

from __future__ import annotations

import importlib.util
import ntpath
from pathlib import Path


TEST_MODULE = Path(__file__).absolute().with_name("web_upload_negative_behavior.py")
SPEC = importlib.util.spec_from_file_location("upload_cleanup_memory", TEST_MODULE)
assert SPEC is not None and SPEC.loader is not None
negative = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(negative)


class SyntheticAbort(BaseException):
    pass


def prepare():
    service = negative.bridge.FakeWeb(negative.SETTINGS)
    result = negative.post(
        service, "/api/uploads", {"name": "synthetic.mp4", "size": 3}
    )
    upload_id = result["body"]["upload_id"]
    assert negative.send_chunk(service, upload_id, 0, negative.encoded(b"abc"))["status"] == 200
    store = service.ns["_upload_store"]
    slot, plan = store._slot(upload_id)
    meta = store._meta(slot, plan, upload_id)
    assert not service.files.handles
    return service, store, slot, meta


def instrument_close(service, errors=None):
    errors = errors or {}
    calls = []
    original = service.os.close

    def close(fd):
        name = ntpath.basename(service.files.handles[fd]["key"])
        calls.append(name)
        if name in errors:
            # Model an OS failure with unknown handle state; do not retry it.
            raise errors[name]
        original(fd)

    service.os.close = close
    return calls


def assert_raised(call, expected):
    try:
        call()
    except BaseException as exc:
        assert exc is expected, (type(exc).__name__, str(exc))
        return exc
    raise AssertionError("the synthetic operation should have raised")


def normal_close_order():
    service, store, slot, meta = prepare()
    calls = instrument_close(service)
    size, last = store._inspect(slot, meta)
    assert size == 3 and last is not None and last[:2] == (0, 3)
    assert calls == ["payload.mp4", "journal.bin"], calls
    assert not service.files.handles


def payload_close_failure_still_closes_journal(error):
    service, store, slot, meta = prepare()
    calls = instrument_close(service, {"payload.mp4": error})
    assert_raised(lambda: store._inspect(slot, meta), error)
    assert calls == ["payload.mp4", "journal.bin"], calls
    assert len(service.files.handles) == 1


def both_closes_fail_preserving_payload_error(error):
    service, store, slot, meta = prepare()
    journal_error = OSError("synthetic journal close failure")
    calls = instrument_close(service, {"payload.mp4": error, "journal.bin": journal_error})
    raised = assert_raised(lambda: store._inspect(slot, meta), error)
    assert calls == ["payload.mp4", "journal.bin"], calls
    assert raised.__cause__ is journal_error, raised.__cause__
    assert len(service.files.handles) == 2


def payload_open_failure_still_closes_journal():
    service, store, slot, meta = prepare()
    open_error = OSError("synthetic payload open failure")
    original_open = service.ns["_open_regular"]
    calls = instrument_close(service)

    def failing_open(path, flags):
        if ntpath.basename(path) == "payload.mp4":
            raise open_error
        return original_open(path, flags)

    service.ns["_open_regular"] = failing_open
    assert_raised(lambda: store._inspect(slot, meta), open_error)
    assert calls == ["journal.bin"], calls
    assert not service.files.handles


def payload_open_and_journal_close_failure():
    service, store, slot, meta = prepare()
    open_error = OSError("synthetic payload open failure")
    close_error = OSError("synthetic journal close failure")
    original_open = service.ns["_open_regular"]
    calls = instrument_close(service, {"journal.bin": close_error})

    def failing_open(path, flags):
        if ntpath.basename(path) == "payload.mp4":
            raise open_error
        return original_open(path, flags)

    service.ns["_open_regular"] = failing_open
    raised = assert_raised(lambda: store._inspect(slot, meta), close_error)
    assert raised.__context__ is open_error
    assert calls == ["journal.bin"], calls


def journal_control_failure_precedes_payload_oserror(control_error):
    service, store, slot, meta = prepare()
    payload_error = OSError("synthetic payload close failure")
    calls = instrument_close(
        service, {"payload.mp4": payload_error, "journal.bin": control_error}
    )
    raised = assert_raised(lambda: store._inspect(slot, meta), control_error)
    assert calls == ["payload.mp4", "journal.bin"], calls
    assert raised.__cause__ is payload_error, raised.__cause__
    assert len(service.files.handles) == 2


def body_control_error_survives_close_failures(control_error, failed_closes):
    service, store, slot, meta = prepare()
    errors = {name: OSError(f"synthetic {name} close failure") for name in failed_closes}
    calls = instrument_close(service, errors)
    original_read = service.os.read

    def failing_read(fd, count):
        name = ntpath.basename(service.files.handles[fd]["key"])
        if name == "journal.bin":
            raise control_error
        return original_read(fd, count)

    service.os.read = failing_read
    try:
        store._inspect(slot, meta)
    except BaseException as exc:
        raised = exc
    else:
        raise AssertionError("the synthetic read should have raised")
    assert calls == ["payload.mp4", "journal.bin"], calls
    assert raised is control_error, (
        f"body control exception was replaced by {type(raised).__name__}: {raised}"
    )


def main():
    checks = (
        ("normal close order", normal_close_order),
        ("payload OSError still closes journal",
         lambda: payload_close_failure_still_closes_journal(OSError("synthetic payload close"))),
        ("payload BaseException still closes journal",
         lambda: payload_close_failure_still_closes_journal(SyntheticAbort("synthetic abort"))),
        ("dual OSError preserves payload",
         lambda: both_closes_fail_preserving_payload_error(OSError("synthetic payload close"))),
        ("dual failures preserve BaseException",
         lambda: both_closes_fail_preserving_payload_error(SyntheticAbort("synthetic abort"))),
        ("journal KeyboardInterrupt precedes payload OSError",
         lambda: journal_control_failure_precedes_payload_oserror(KeyboardInterrupt("synthetic interrupt"))),
        ("journal direct BaseException precedes payload OSError",
         lambda: journal_control_failure_precedes_payload_oserror(SyntheticAbort("synthetic abort"))),
        ("body KeyboardInterrupt survives payload close failure",
         lambda: body_control_error_survives_close_failures(
             KeyboardInterrupt("synthetic interrupt"), ("payload.mp4",))),
        ("body KeyboardInterrupt survives journal close failure",
         lambda: body_control_error_survives_close_failures(
             KeyboardInterrupt("synthetic interrupt"), ("journal.bin",))),
        ("body KeyboardInterrupt survives both close failures",
         lambda: body_control_error_survives_close_failures(
             KeyboardInterrupt("synthetic interrupt"), ("payload.mp4", "journal.bin"))),
        ("body direct BaseException survives payload close failure",
         lambda: body_control_error_survives_close_failures(
             SyntheticAbort("synthetic abort"), ("payload.mp4",))),
        ("body direct BaseException survives journal close failure",
         lambda: body_control_error_survives_close_failures(
             SyntheticAbort("synthetic abort"), ("journal.bin",))),
        ("body direct BaseException survives both close failures",
         lambda: body_control_error_survives_close_failures(
             SyntheticAbort("synthetic abort"), ("payload.mp4", "journal.bin"))),
        ("payload open failure closes journal", payload_open_failure_still_closes_journal),
        ("open and journal close failure preserve context", payload_open_and_journal_close_failure),
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
    print("All inspect cleanup memory checks passed.")


if __name__ == "__main__":
    main()
