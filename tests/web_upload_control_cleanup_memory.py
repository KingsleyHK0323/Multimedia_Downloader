"""Check cleanup exception priority using production AST and fake OS handles.

OpenAI-Codex_app_ui. No real filesystem, locks, network, or media are used.
"""

from __future__ import annotations

import ast
import contextlib
import hashlib
import json
import ntpath
import stat
import sys
from pathlib import Path
from types import SimpleNamespace


SOURCE = Path(__file__).resolve().parents[1] / "web_upload.py"
TREE = ast.parse(SOURCE.read_text(encoding="utf-8"), filename=str(SOURCE))
TOP = {"_open_regular", "_read_json", "_create_file"}
METHODS = {"_completed", "_locked", "_inspect"}
nodes = [n for n in TREE.body if isinstance(n, ast.FunctionDef) and n.name in TOP]
nodes += [
    n
    for n in TREE.body
    if isinstance(n, ast.FunctionDef) and n.name == "_preserve_cleanup_control"
]
store = next(
    n for n in TREE.body if isinstance(n, ast.ClassDef) and n.name == "UploadStore"
)
methods = [
    n for n in store.body if isinstance(n, ast.FunctionDef) and n.name in METHODS
]
assert {n.name for n in nodes if n.name in TOP} == TOP
assert {n.name for n in methods} == METHODS
for method in methods:
    method.decorator_list = []
module = ast.Module(
    body=[
        ast.ImportFrom(
            module="__future__", names=[ast.alias(name="annotations")], level=0
        ),
        *nodes,
        *methods,
    ],
    type_ignores=[],
)
ast.fix_missing_locations(module)
CODE = compile(module, str(SOURCE), "exec")


class UploadError(Exception):
    pass


class FakeOS:
    name = "posix"
    O_RDONLY = 0
    O_WRONLY = 1
    O_RDWR = 2
    O_CREAT = 4
    O_EXCL = 8
    SEEK_SET = 0
    path = SimpleNamespace(join=ntpath.join, lexists=lambda _path: True)

    def __init__(self, kind, body_error, failed_closes, unlock_error):
        self.kind = kind
        self.body_error = body_error
        self.close_errors = {
            fd: OSError(f"synthetic close {fd}") for fd in failed_closes
        }
        self.unlock_error = OSError("synthetic unlock") if unlock_error else None
        self.close_calls = []
        self.unlock_calls = []

    def lstat(self, _path):
        return SimpleNamespace(st_mode=stat.S_IFREG, st_dev=1, st_ino=1)

    def open(self, *_args):
        return 11

    def fstat(self, fd):
        if self.body_error is not None and self.kind in {
            "_open_regular",
            "_read_json",
            "_completed",
            "_inspect",
        }:
            raise self.body_error
        if self.kind == "_open_regular":
            return SimpleNamespace(st_mode=stat.S_IFREG, st_dev=1, st_ino=1)
        return SimpleNamespace(
            st_size={"_read_json": 2, "_locked": 1}.get(self.kind, 0)
        )

    def fsync(self, _fd):
        return None

    def close(self, fd):
        self.close_calls.append(fd)
        if fd in self.close_errors:
            raise self.close_errors[fd]

    def flock(self, fd, flags):
        if flags == 8:
            self.unlock_calls.append(fd)
            if self.unlock_error is not None:
                raise self.unlock_error


def setup(kind, body_error, failed_closes, unlock_error=False):
    fake = FakeOS(kind, body_error, failed_closes, unlock_error)

    def open_regular(path, _flags):
        return 10 if ntpath.basename(path) == "journal.bin" else 11

    def write_all(_fd, _data):
        if body_error is not None and kind == "_create_file":
            raise body_error

    namespace = {
        "os": fake,
        "stat": stat,
        "json": json,
        "hashlib": hashlib,
        "sys": sys,
        "contextlib": contextlib,
        "contextmanager": contextlib.contextmanager,
        "fcntl": SimpleNamespace(flock=fake.flock, LOCK_EX=1, LOCK_NB=2, LOCK_UN=8),
        "_is_reparse": lambda _info: False,
        "_directory": lambda _path: None,
        "_BINARY": 0,
        "_NOFOLLOW": 0,
        "_RECORD": SimpleNamespace(size=49),
        "CHUNK_BYTES": 262144,
        "UploadError": UploadError,
        "_write_all": write_all,
        "_read_exact": lambda _fd, _length: b"{}",
    }
    exec(CODE, namespace)  # noqa: S102 - Execute selected local methods with a fake OS.
    if kind != "_open_regular":
        namespace["_open_regular"] = open_regular
    return fake, namespace


def invoke(kind, namespace, body_error):
    if kind == "_open_regular":
        return namespace[kind]("synthetic-file", 0)
    if kind == "_read_json":
        return namespace[kind]("synthetic-file", 20)
    if kind == "_create_file":
        return namespace[kind]("synthetic-file", b"{}")
    if kind == "_completed":
        return namespace[kind]("synthetic-slot")
    if kind == "_inspect":
        return namespace[kind]("synthetic-slot", {"size": 0, "payload": "payload.mp4"})
    if kind == "_locked":
        with contextlib.contextmanager(namespace[kind])("synthetic-slot"):
            if body_error is not None:
                raise body_error
        return None
    raise AssertionError(kind)


def capture(call):
    try:
        call()
    except BaseException as error:
        return error
    raise AssertionError("expected the synthetic operation to raise")


def check_control_precedence(kind, control_type, failed_closes, unlock_error=False):
    control = control_type("synthetic body control")
    fake, namespace = setup(kind, control, failed_closes, unlock_error)
    got = capture(lambda: invoke(kind, namespace, control))
    expected_closes = [11, 10] if kind == "_inspect" else [11]
    assert fake.close_calls == expected_closes, (kind, fake.close_calls)
    if kind == "_locked":
        assert fake.unlock_calls == [11], fake.unlock_calls
    assert (
        got is control
    ), f"{kind} body {control_type.__name__} became {type(got).__name__}"


def check_prior_control_does_not_replace_cleanup_error(
    kind, failed_closes, unlock_error=False
):
    fake, namespace = setup(kind, None, failed_closes, unlock_error)
    previous = KeyboardInterrupt("synthetic previously handled interrupt")
    try:
        raise previous
    except KeyboardInterrupt:
        got = capture(lambda: invoke(kind, namespace, None))
    expected_closes = [11, 10] if kind == "_inspect" else [11]
    assert fake.close_calls == expected_closes, (kind, fake.close_calls)
    if kind == "_locked":
        assert fake.unlock_calls == [11], fake.unlock_calls
    assert isinstance(got, OSError), f"{kind} re-raised a previous control exception"
    assert got in [*fake.close_errors.values(), fake.unlock_error]


def check_open_regular_success_ignores_prior_control():
    fake, namespace = setup("_open_regular", None, (), False)
    try:
        raise KeyboardInterrupt("synthetic previously handled interrupt")
    except KeyboardInterrupt:
        fd = invoke("_open_regular", namespace, None)
    assert fd == 11 and not fake.close_calls


# OpenAI-Codex_app_ui: retain unlock control exceptions if closing also fails.
def check_unlock_control_precedes_close_error(control_type, context_mode):
    fake, namespace = setup("_locked", None, (11,), False)
    control = control_type("synthetic unlock control")
    fake.unlock_error = control
    body = OSError("synthetic body error") if context_mode == "body_error" else None

    def operation():
        return invoke("_locked", namespace, body)

    if context_mode in ("prior_interrupt", "prior_oserror"):
        prior = (
            KeyboardInterrupt("old interrupt")
            if context_mode == "prior_interrupt"
            else OSError("old error")
        )
        try:
            raise prior
        except BaseException:
            got = capture(operation)
    else:
        got = capture(operation)
    assert fake.unlock_calls == [11] and fake.close_calls == [11]
    assert got is control, f"unlock {control_type.__name__} became {type(got).__name__}"


def check_locked_body_oserror_propagates():
    fake, namespace = setup("_locked", None, (), False)
    error = OSError("synthetic body error")
    got = capture(lambda: invoke("_locked", namespace, error))
    assert fake.unlock_calls == [11] and fake.close_calls == [11]
    assert got is error, "an ordinary body error was lost"


def check_locked_success_while_handling_prior_error(prior_type):
    fake, namespace = setup("_locked", None, (), False)
    try:
        raise prior_type("synthetic previously handled exception")
    except BaseException:
        result = invoke("_locked", namespace, None)
    assert result is None and fake.unlock_calls == [11] and fake.close_calls == [11]


# OpenAI-Codex_app_ui: cover failures raised inside the decode error handler.
def check_read_json_handler_control(control_type, input_case):
    fake, namespace = setup("_read_json", None, (11,), False)
    data = b"\xff\xff" if input_case == "unicode" else b"!!"
    namespace["_read_exact"] = lambda _fd, _length: data
    control = control_type("synthetic handler control")
    calls = []

    def fail_handler(code):
        calls.append(code)
        raise control

    namespace["UploadError"] = fail_handler
    got = capture(lambda: invoke("_read_json", namespace, None))
    assert calls == ["interrupted"] and fake.close_calls == [11]
    assert (
        got is control
    ), f"handler {control_type.__name__} became {type(got).__name__}"


def check_read_json_handler_ordinary(case_and_mode):
    input_case, mode = case_and_mode
    fake, namespace = setup(
        "_read_json", None, (11,) if mode == "ordinary_failure" else (), False
    )
    data = b"\xff\xff" if input_case == "unicode" else b"!!"
    namespace["_read_exact"] = lambda _fd, _length: data
    ordinary = RuntimeError("synthetic ordinary handler failure")
    if mode == "ordinary_failure":

        def fail_handler(_code):
            raise ordinary

        namespace["UploadError"] = fail_handler
    got = capture(lambda: invoke("_read_json", namespace, None))
    assert fake.close_calls == [11]
    if mode == "normal_handler":
        assert isinstance(got, UploadError) and got.args == ("interrupted",)
    else:
        assert got is fake.close_errors[11] and got.__context__ is ordinary


def main():
    checks = []
    # OpenAI-Codex_app_ui: exercise both decode-error handler entry paths.
    for input_case in ("unicode", "json"):
        for control_type in (KeyboardInterrupt, SystemExit):
            name = f"_read_json {input_case} handler {control_type.__name__} plus close"
            checks.append(
                (
                    name,
                    "_read_json_handler_control",
                    control_type,
                    (),
                    False,
                    input_case,
                )
            )
        for mode in ("normal_handler", "ordinary_failure"):
            name = f"_read_json {input_case} handler {mode}"
            checks.append(
                (
                    name,
                    "_read_json_handler_ordinary",
                    None,
                    (),
                    False,
                    (input_case, mode),
                )
            )
    # OpenAI-Codex_app_ui: cover unlock control, ordinary errors and old exception context.
    for control_type in (KeyboardInterrupt, SystemExit):
        for mode in ("normal", "body_error", "prior_interrupt", "prior_oserror"):
            name = (
                f"_locked unlock {control_type.__name__}, close OSError, context={mode}"
            )
            checks.append(
                (name, "_locked_unlock_control", control_type, (11,), False, mode)
            )
    checks.append(
        (
            "_locked body OSError propagates",
            "_locked_body_oserror",
            None,
            (),
            False,
            False,
        )
    )
    for prior_type in (KeyboardInterrupt, OSError):
        checks.append(
            (
                f"_locked succeeds during prior {prior_type.__name__}",
                "_locked_success_prior",
                prior_type,
                (),
                False,
                False,
            )
        )
    for kind in ("_open_regular", "_read_json", "_create_file", "_completed"):
        for control_type in (KeyboardInterrupt, SystemExit):
            checks.append(
                (
                    f"{kind} {control_type.__name__} plus close",
                    kind,
                    control_type,
                    (11,),
                    False,
                    False,
                )
            )
    for kind, variants in (
        ("_locked", (((11,), False), ((), True), ((11,), True))),
        ("_inspect", (((11,), False), ((10,), False), ((11, 10), False))),
    ):
        for control_type in (KeyboardInterrupt, SystemExit):
            for failed_closes, unlock_error in variants:
                name = f"{kind} {control_type.__name__} close={failed_closes} unlock={unlock_error}"
                checks.append(
                    (name, kind, control_type, failed_closes, unlock_error, False)
                )
    for kind in ("_read_json", "_create_file", "_completed"):
        checks.append(
            (f"{kind} prior interrupt plus close", kind, None, (11,), False, True)
        )
    for kind, variants in (
        ("_locked", (((11,), False), ((), True), ((11,), True))),
        ("_inspect", (((11,), False), ((10,), False), ((11, 10), False))),
    ):
        for failed_closes, unlock_error in variants:
            name = f"{kind} prior interrupt close={failed_closes} unlock={unlock_error}"
            checks.append((name, kind, None, failed_closes, unlock_error, True))
    failures = []
    for name, kind, control_type, failed_closes, unlock_error, prior in checks:
        try:
            if kind == "_read_json_handler_control":
                check_read_json_handler_control(control_type, prior)
                print(f"PASS {name}")
                continue
            if kind == "_read_json_handler_ordinary":
                check_read_json_handler_ordinary(prior)
                print(f"PASS {name}")
                continue
            if kind == "_locked_unlock_control":
                check_unlock_control_precedes_close_error(control_type, prior)
                print(f"PASS {name}")
                continue
            if kind == "_locked_body_oserror":
                check_locked_body_oserror_propagates()
                print(f"PASS {name}")
                continue
            if kind == "_locked_success_prior":
                check_locked_success_while_handling_prior_error(control_type)
                print(f"PASS {name}")
                continue
            if prior:
                check_prior_control_does_not_replace_cleanup_error(
                    kind, failed_closes, unlock_error
                )
            else:
                check_control_precedence(
                    kind, control_type, failed_closes, unlock_error
                )
        except AssertionError as error:
            failures.append(name)
            print(f"FAIL {name}: {error}")
        else:
            print(f"PASS {name}")
    check_open_regular_success_ignores_prior_control()
    print("PASS _open_regular successful body leaves its descriptor with the caller")
    print(
        f"{len(checks) - len(failures) + 1}/{len(checks) + 1} synthetic checks passed"
    )
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
