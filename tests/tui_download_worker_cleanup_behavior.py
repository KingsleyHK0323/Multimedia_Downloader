"""Check TUI download worker initialization cleanup without real Textual.

OpenAI-Codex_app_ui. The dispatcher and downloader are in-memory substitutes.
"""

from __future__ import annotations

import ast
import importlib.util
from pathlib import Path
from types import SimpleNamespace


HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("download_fake_ui", HERE / "tui_download_reentry_behavior.py")
assert SPEC is not None and SPEC.loader is not None
ui = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ui)
SOURCE = HERE.parent / "tui" / "download_tab.py"
tree = ast.parse(SOURCE.read_text(encoding="utf-8"), filename=str(SOURCE))
tab_node = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "DownloadTab")
worker = next(node for node in tab_node.body if isinstance(node, ast.FunctionDef) and node.name == "_run_download")
worker.decorator_list = []
module = ast.Module(
    body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0), worker],
    type_ignores=[],
)
ast.fix_missing_locations(module)
CODE = compile(module, str(SOURCE), "exec")


def scenario(kind, failure=None):
    tab = ui.make_tab()
    ui.press(tab, "start")
    # OpenAI-Codex_web_check: check operation ownership, not the widget lifecycle.
    assert tab._download_running and len(tab.runs) == 1
    urls, options = tab.runs[0]
    if kind in ("stop_failure", "pre_cancel"):
        ui.press(tab, "stop")
    dispatches = []
    marks = []
    stops = []
    batches = []

    def dispatch(callback, *args):
        dispatches.append(callback.__name__)
        return callback(*args)

    tab.app.call_from_thread = dispatch
    tab.app.log_line = lambda *_args, **_kwargs: None
    tab._mark_item = lambda index, status: marks.append((index, status))

    def make_downloader(_opts, **_callbacks):
        if kind == "constructor_failure":
            raise failure

        def stop():
            stops.append("stop")
            if kind == "stop_failure":
                raise failure

        def download_batch(given):
            batches.append(list(given))
            if kind == "batch_failure":
                raise failure
            return [] if kind == "pre_cancel" else [(given[0], True, "")]

        return SimpleNamespace(stop=stop, download_batch=download_batch)

    namespace = {"Downloader": make_downloader}
    exec(CODE, namespace)  # noqa: S102 - Execute the selected worker with a fake downloader.
    caught = None
    try:
        namespace["_run_download"](tab, urls, options)
    except BaseException as error:
        caught = error
    return tab, dispatches, marks, stops, batches, caught


def check_initialization_failure(kind, error_type):
    failure = error_type("synthetic initialization failure")
    tab, dispatches, marks, stops, batches, caught = scenario(kind, failure)
    assert caught is failure
    assert dispatches.count("_finish") == 1, "initialization failure did not dispatch finish exactly once"
    assert not tab._download_running and tab._downloader is None
    assert not tab.widgets["#start"].disabled and tab.widgets["#stop"].disabled
    assert not marks and not batches
    assert stops == (["stop"] if kind == "stop_failure" else [])


def check_normal_completion():
    tab, dispatches, marks, stops, batches, caught = scenario("success")
    assert caught is None and dispatches.count("_finish") == 1
    assert not tab._download_running and tab._downloader is None and not stops
    assert marks == [(0, "done")] and batches == [["https://example.invalid/a"]]


def check_batch_failure():
    failure = RuntimeError("synthetic batch failure")
    tab, dispatches, marks, _stops, batches, caught = scenario("batch_failure", failure)
    assert caught is failure and dispatches.count("_finish") == 1
    assert not tab._download_running and tab._downloader is None and not marks and len(batches) == 1


def check_pre_cancel():
    tab, dispatches, marks, stops, batches, caught = scenario("pre_cancel")
    assert caught is None and dispatches.count("_finish") == 1
    assert not tab._download_running and tab._downloader is None and stops == ["stop"]
    assert marks == [(0, "skipped")] and len(batches) == 1


# OpenAI-Codex_app_ui: expose failed dispatch without losing the initiating exception.
def check_finish_dispatch_failure_keeps_both_errors():
    tab = ui.make_tab()
    ui.press(tab, "start")
    urls, options = tab.runs[0]
    failure = RuntimeError("synthetic constructor failure")
    dispatch_failure = OSError("synthetic dispatch failure")
    attempts = []

    def dispatch(callback, *_args):
        attempts.append(callback.__name__)
        raise dispatch_failure

    def fail_constructor(_opts, **_callbacks):
        raise failure

    tab.app.call_from_thread = dispatch
    namespace = {"Downloader": fail_constructor}
    exec(CODE, namespace)  # noqa: S102 - Run the selected worker with fake components.
    try:
        namespace["_run_download"](tab, urls, options)
    except BaseException as error:
        assert error is failure and error.__cause__ is dispatch_failure
    else:
        raise AssertionError("expected both synthetic failures")
    assert attempts == ["_finish"] and tab._downloader is None


def main():
    checks = [
        (f"{kind} {error_type.__name__}", lambda k=kind, e=error_type: check_initialization_failure(k, e))
        for kind in ("constructor_failure", "stop_failure")
        for error_type in (RuntimeError, KeyboardInterrupt, SystemExit)
    ]
    checks.extend([
        ("normal completion", check_normal_completion),
        ("batch failure", check_batch_failure),
        ("pre-cancel", check_pre_cancel),
    ])
    checks.append(("failed finish dispatch preserves both errors", check_finish_dispatch_failure_keeps_both_errors))
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
