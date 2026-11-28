"""Exercise TUI conversion guards with in-memory Textual and worker substitutes.

OpenAI-Codex_app_ui. This is not a real Textual scheduling or media test.
"""

from __future__ import annotations

import ast
import threading
from pathlib import Path
from types import SimpleNamespace


class FakeBase:
    def __init__(self):
        self.is_mounted = True


class Input:
    def __init__(self, value):
        self.value = value


class Select(Input):
    pass


class Button:
    def __init__(self, widget_id):
        self.id = widget_id
        self.disabled = False


class Static:
    def __init__(self, text=""):
        self.text = text

    def update(self, text):
        self.text = text


class ConfirmDialog:
    def __init__(self, *args):
        self.args = args


def load_convert_tab():
    source = Path(__file__).resolve().parents[1] / "tui" / "convert_tab.py"
    tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
    tab = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "ConvertTab")
    names = {"__init__", "on_button_pressed", "_invalidate_preview", "_start", "_begin", "_finish"}
    methods = [node for node in tab.body if isinstance(node, ast.FunctionDef) and node.name in names]
    assert {node.name for node in methods} == names
    tab.body = methods
    tab.bases = [ast.Name(id="FakeBase", ctx=ast.Load())]
    tab.keywords = []
    tab.decorator_list = []
    module = ast.Module(
        body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0), tab],
        type_ignores=[],
    )
    ast.fix_missing_locations(module)
    namespace = {
        "FakeBase": FakeBase,
        "Input": Input,
        "Select": Select,
        "Button": Button,
        "Static": Static,
        "ConfirmDialog": ConfirmDialog,
        "threading": threading,
    }
    exec(compile(module, str(source), "exec"), namespace)  # noqa: S102 - Extract local methods without Textual.
    return namespace["ConvertTab"]


ConvertTab = load_convert_tab()


def make_tab(policy="rename"):
    tab = ConvertTab(SimpleNamespace(t=lambda key: key))
    tab._files = ["synthetic-a.mkv"]
    tab._item_widgets = [Static("synthetic-a.mkv")]
    tab.runs = []
    tab.dialogs = []
    tab.notifications = []
    tab.app = SimpleNamespace(
        notify=lambda *args, **kwargs: tab.notifications.append((args, kwargs)),
        push_screen=lambda screen, callback: tab.dialogs.append((screen, callback)),
    )
    widgets = {
        "#save-path": Input("synthetic-output"),
        "#ffmpeg-bin": Input("ffmpeg"),
        "#dst-fmt": Select("mp4"),
        "#conflict-policy": Select(policy),
        "#preview-results": Static(),
        **{f"#{name}": Button(name) for name in ("start", "stop", "add-file", "remove-file", "preview")},
    }
    tab.widgets = widgets
    tab.query_one = lambda selector, *_: widgets[selector]
    tab._run_convert = lambda *args: tab.runs.append(args)
    return tab


def press_start(tab):
    tab.on_button_pressed(SimpleNamespace(button=tab.widgets["#start"]))


def test_normal_modes_and_finish():
    for policy in ("rename", "skip"):
        tab = make_tab(policy)
        press_start(tab)
        assert tab.runs == [(["synthetic-a.mkv"], "synthetic-output", "mp4", "ffmpeg", policy)]
        assert tab._conversion_running and tab.widgets["#start"].disabled
        tab._finish()
        assert not tab._conversion_running and not tab.widgets["#start"].disabled
        press_start(tab)
        assert len(tab.runs) == 2


def test_busy_start_does_not_restart_or_clear_stop():
    tab = make_tab()
    press_start(tab)
    tab._cancel_requested.set()
    tab.widgets["#save-path"].value = "synthetic-other-output"
    press_start(tab)
    assert len(tab.runs) == 1, "a repeated start launched another conversion"
    assert tab._cancel_requested.is_set(), "a repeated start cleared the stop request"


def test_busy_begin_does_not_restart():
    tab = make_tab()
    press_start(tab)
    tab._begin(["synthetic-b.mov"], "synthetic-other-output", "mp3", "ffmpeg", "rename")
    assert len(tab.runs) == 1, "a repeated begin launched another conversion"


def test_overwrite_requires_confirmation():
    tab = make_tab("overwrite")
    press_start(tab)
    assert len(tab.dialogs) == 1 and not tab.runs
    tab.dialogs[0][1](True)
    assert tab.runs == [(["synthetic-a.mkv"], "synthetic-output", "mp4", "ffmpeg", "overwrite")]


def test_confirm_is_single_use_even_after_finish():
    tab = make_tab("overwrite")
    press_start(tab)
    callback = tab.dialogs[0][1]
    callback(True)
    assert len(tab.runs) == 1
    tab._finish()
    callback(True)
    assert len(tab.runs) == 1, "a consumed confirmation restarted a finished conversion"


def test_cancel_consumes_confirmation():
    for dismissed in (False, None):
        tab = make_tab("overwrite")
        press_start(tab)
        callback = tab.dialogs[0][1]
        callback(dismissed)
        callback(True)
        assert not tab.runs, "a dismissed confirmation was accepted on replay"


def test_new_overwrite_request_supersedes_old_confirmation():
    tab = make_tab("overwrite")
    press_start(tab)
    old_callback = tab.dialogs[0][1]
    press_start(tab)
    new_callback = tab.dialogs[1][1]
    old_callback(True)
    assert not tab.runs, "an older confirmation started a newer request"
    new_callback(True)
    assert len(tab.runs) == 1
    old_callback(True)
    assert len(tab.runs) == 1
    tab._finish()
    old_callback(True)
    assert len(tab.runs) == 1, "an older confirmation restarted a finished conversion"


def test_ordinary_run_invalidates_earlier_overwrite_confirmation():
    tab = make_tab("overwrite")
    press_start(tab)
    old_callback = tab.dialogs[0][1]
    tab.widgets["#conflict-policy"].value = "rename"
    press_start(tab)
    assert len(tab.runs) == 1 and tab.runs[0][-1] == "rename"
    tab._finish()
    old_callback(True)
    assert len(tab.runs) == 1, "a stale overwrite confirmation restarted an operation"


def test_empty_new_request_invalidates_earlier_confirmation():
    tab = make_tab("overwrite")
    press_start(tab)
    old_callback = tab.dialogs[0][1]
    tab._files = []
    tab._item_widgets = []
    press_start(tab)
    assert tab.notifications and not tab.runs
    old_callback(True)
    assert not tab.runs, "an invalid newer request left an older confirmation active"


# OpenAI-Codex_app_ui: check reentrant presentation updates and failure recovery.
def test_synchronous_reentry_during_begin_is_ignored():
    tab = make_tab()
    display = tab.widgets["#preview-results"]
    update = display.update
    calls = []

    def reentrant_update(text):
        update(text)
        calls.append(text)
        if len(calls) == 2:
            press_start(tab)

    display.update = reentrant_update
    press_start(tab)
    assert len(tab.runs) == 1, "reentry during preview invalidation launched a second conversion"


def test_failed_preview_invalidation_does_not_leave_busy():
    tab = make_tab()

    def fail_update(_text):
        raise RuntimeError("synthetic display failure")

    tab.widgets["#preview-results"].update = fail_update
    try:
        tab._begin(["synthetic-a.mkv"], "synthetic-output", "mp4", "ffmpeg", "rename")
    except RuntimeError as exc:
        assert str(exc) == "synthetic display failure"
    else:
        raise AssertionError("expected the display failure to propagate")
    assert not tab._conversion_running and not tab.runs


def main():
    checks = [
        test_normal_modes_and_finish,
        test_busy_start_does_not_restart_or_clear_stop,
        test_synchronous_reentry_during_begin_is_ignored,
        test_failed_preview_invalidation_does_not_leave_busy,
        test_busy_begin_does_not_restart,
        test_overwrite_requires_confirmation,
        test_confirm_is_single_use_even_after_finish,
        test_cancel_consumes_confirmation,
        test_new_overwrite_request_supersedes_old_confirmation,
        test_ordinary_run_invalidates_earlier_overwrite_confirmation,
        test_empty_new_request_invalidates_earlier_confirmation,
    ]
    failures = []
    for check in checks:
        try:
            check()
        except AssertionError as exc:
            failures.append(check.__name__)
            print(f"FAIL {check.__name__}: {exc}")
        else:
            print(f"PASS {check.__name__}")
    print(f"{len(checks) - len(failures)}/{len(checks)} synthetic checks passed")
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
