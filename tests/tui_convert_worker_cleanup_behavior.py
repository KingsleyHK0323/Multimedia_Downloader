"""Check TUI convert worker initialization cleanup without real Textual.

OpenAI-Codex_app_ui. The dispatcher and converter are in-memory substitutes.
"""

from __future__ import annotations

import ast
import importlib.util
from pathlib import Path
from types import SimpleNamespace


HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "convert_fake_ui", HERE / "tui_confirmation_behavior.py"
)
assert SPEC is not None and SPEC.loader is not None
ui = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ui)
SOURCE = HERE.parent / "tui" / "convert_tab.py"
tree = ast.parse(SOURCE.read_text(encoding="utf-8"), filename=str(SOURCE))
tab_node = next(
    node
    for node in tree.body
    if isinstance(node, ast.ClassDef) and node.name == "ConvertTab"
)
worker = next(
    node
    for node in tab_node.body
    if isinstance(node, ast.FunctionDef) and node.name == "_run_convert"
)
worker.decorator_list = []
module = ast.Module(
    body=[
        ast.ImportFrom(
            module="__future__", names=[ast.alias(name="annotations")], level=0
        ),
        worker,
    ],
    type_ignores=[],
)
ast.fix_missing_locations(module)
CODE = compile(module, str(SOURCE), "exec")


def scenario(kind, failure=None):
    tab = ui.make_tab()
    ui.press_start(tab)
    assert tab._conversion_running and len(tab.runs) == 1
    args = tab.runs[0]
    if kind in ("stop_failure", "pre_cancel"):
        tab._cancel_requested.set()
    dispatches = []
    marks = []
    stops = []
    batches = []
    logs = []

    def dispatch(callback, *args, **kwargs):
        dispatches.append(callback.__name__)
        return callback(*args, **kwargs)

    tab.app.call_from_thread = dispatch
    tab.app.log_line = lambda *args, **kwargs: logs.append((args, kwargs))
    tab._mark_item = lambda index, status: marks.append((index, status))

    def make_converter(**_kwargs):
        if kind == "constructor_failure":
            raise failure

        def stop():
            stops.append("stop")
            if kind == "stop_failure":
                raise failure

        def convert_batch(given):
            batches.append(list(given))
            if kind in ("batch_failure", "batch_value_error"):
                raise failure
            return []

        return SimpleNamespace(stop=stop, convert_batch=convert_batch)

    namespace = {
        "Converter": make_converter,
        "redact_sensitive_urls": lambda text: text,
    }
    exec(
        CODE, namespace
    )  # noqa: S102 - Execute the selected worker with a fake converter.
    caught = None
    try:
        namespace["_run_convert"](tab, *args)
    except BaseException as error:
        caught = error
    return tab, dispatches, marks, stops, batches, logs, caught


def check_initialization_failure(kind, error_type):
    failure = error_type("synthetic initialization failure")
    tab, dispatches, marks, stops, batches, _logs, caught = scenario(kind, failure)
    assert caught is failure
    assert (
        dispatches.count("_finish") == 1
    ), "initialization failure did not dispatch finish exactly once"
    assert not tab._conversion_running and tab._converter is None
    assert not tab.widgets["#start"].disabled and tab.widgets["#stop"].disabled
    assert not marks and not batches
    assert stops == (["stop"] if kind == "stop_failure" else [])


def check_normal_completion():
    tab, dispatches, marks, stops, batches, logs, caught = scenario("success")
    assert caught is None and dispatches.count("_finish") == 1
    assert (
        not tab._conversion_running
        and tab._converter is None
        and not stops
        and not marks
        and not logs
    )
    assert batches == [["synthetic-a.mkv"]]


def check_batch_failure(error_type):
    failure = error_type("synthetic batch failure")
    tab, dispatches, marks, _stops, batches, _logs, caught = scenario(
        "batch_failure", failure
    )
    assert caught is failure and dispatches.count("_finish") == 1
    assert (
        not tab._conversion_running
        and tab._converter is None
        and not marks
        and len(batches) == 1
    )


def check_batch_value_error_remains_reported():
    failure = ValueError("synthetic preflight failure")
    tab, dispatches, _marks, _stops, batches, logs, caught = scenario(
        "batch_value_error", failure
    )
    assert caught is None and dispatches.count("_finish") == 1 and len(batches) == 1
    assert not tab._conversion_running and tab._converter is None
    assert logs == [
        (("err", "log_convert_error"), {"i": 0, "t": 1, "err": str(failure)})
    ]
    assert tab.notifications == [((str(failure),), {"severity": "error"})]


def check_pre_cancel():
    tab, dispatches, _marks, stops, batches, _logs, caught = scenario("pre_cancel")
    assert caught is None and dispatches.count("_finish") == 1
    assert not tab._conversion_running and tab._converter is None and stops == ["stop"]
    assert batches == [["synthetic-a.mkv"]]


def check_finish_dispatch_failure_keeps_both_errors():
    tab = ui.make_tab()
    ui.press_start(tab)
    args = tab.runs[0]
    failure = RuntimeError("synthetic constructor failure")
    dispatch_failure = OSError("synthetic dispatch failure")
    attempts = []

    def dispatch(callback, *_args, **_kwargs):
        attempts.append(callback.__name__)
        raise dispatch_failure

    def fail_constructor(**_kwargs):
        raise failure

    tab.app.call_from_thread = dispatch
    namespace = {
        "Converter": fail_constructor,
        "redact_sensitive_urls": lambda text: text,
    }
    exec(CODE, namespace)  # noqa: S102 - Run the selected worker with fake components.
    try:
        namespace["_run_convert"](tab, *args)
    except BaseException as error:
        assert error is failure and error.__cause__ is dispatch_failure
    else:
        raise AssertionError("expected both synthetic failures")
    assert attempts == ["_finish"] and tab._converter is None


def main():
    checks = [
        (
            f"{kind} {error_type.__name__}",
            lambda k=kind, e=error_type: check_initialization_failure(k, e),
        )
        for kind in ("constructor_failure", "stop_failure")
        for error_type in (ValueError, RuntimeError, KeyboardInterrupt, SystemExit)
    ]
    checks.extend(
        [
            ("normal completion", check_normal_completion),
            ("batch RuntimeError", lambda: check_batch_failure(RuntimeError)),
            ("batch KeyboardInterrupt", lambda: check_batch_failure(KeyboardInterrupt)),
            (
                "batch ValueError remains reported",
                check_batch_value_error_remains_reported,
            ),
            ("pre-cancel", check_pre_cancel),
            (
                "failed finish dispatch preserves both errors",
                check_finish_dispatch_failure_keeps_both_errors,
            ),
        ]
    )
    failures = []
    for name, check in checks:
        try:
            check()
        except AssertionError as error:
            failures.append(name)
            print(f"FAIL {name}: {error}")
        else:
            print(f"PASS {name}")
    print(f"{len(checks) - len(failures)}/{len(checks)} synthetic checks passed")
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
