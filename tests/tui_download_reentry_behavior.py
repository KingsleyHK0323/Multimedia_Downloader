"""Exercise TUI download start/stop guards with in-memory substitutes.

OpenAI-Codex_app_ui. This does not establish actual Textual scheduling.
"""

from __future__ import annotations

import ast
import threading
from pathlib import Path
from types import SimpleNamespace


class FakeBase:
    def __init__(self):
        pass


class TextArea:
    def __init__(self, text):
        self._text = text
        self.on_read = None

    @property
    def text(self):
        if self.on_read is not None:
            callback, self.on_read = self.on_read, None
            callback()
        return self._text

    @text.setter
    def text(self, value):
        self._text = value


class Input:
    def __init__(self, value):
        self.value = value


class Select(Input):
    pass


class Button:
    def __init__(self, widget_id, disabled=False):
        self.id = widget_id
        self._disabled = disabled
        self.on_enable = None

    @property
    def disabled(self):
        return self._disabled

    @disabled.setter
    def disabled(self, value):
        self._disabled = value
        if not value and self.on_enable is not None:
            callback, self.on_enable = self.on_enable, None
            callback()


class Static:
    def __init__(self, text):
        self.text = text

    def update(self, text):
        self.text = text


class ListItem:
    def __init__(self, child):
        self.child = child


class ListView:
    def __init__(self):
        self.items = []
        self.on_clear = None

    def clear(self):
        self.items.clear()
        if self.on_clear is not None:
            callback, self.on_clear = self.on_clear, None
            callback()

    def append(self, item):
        self.items.append(item)


class ProgressBar:
    def __init__(self):
        self.error = None

    def update(self, **_kwargs):
        if self.error is not None:
            error, self.error = self.error, None
            raise error


def load_download_tab():
    source = Path(__file__).resolve().parents[1] / "tui" / "download_tab.py"
    tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
    tab = next(
        node
        for node in tree.body
        if isinstance(node, ast.ClassDef) and node.name == "DownloadTab"
    )
    names = {"__init__", "on_button_pressed", "_urls", "_start", "_stop", "_finish"}
    methods = [
        node
        for node in tab.body
        if isinstance(node, ast.FunctionDef) and node.name in names
    ]
    assert {node.name for node in methods} == names
    tab.body = methods
    tab.bases = [ast.Name(id="FakeBase", ctx=ast.Load())]
    tab.keywords = []
    tab.decorator_list = []
    module = ast.Module(
        body=[
            ast.ImportFrom(
                module="__future__", names=[ast.alias(name="annotations")], level=0
            ),
            tab,
        ],
        type_ignores=[],
    )
    ast.fix_missing_locations(module)
    namespace = {
        "FakeBase": FakeBase,
        "Input": Input,
        "Select": Select,
        "TextArea": TextArea,
        "Static": Static,
        "Button": Button,
        "ListItem": ListItem,
        "ListView": ListView,
        "ProgressBar": ProgressBar,
        "threading": threading,
        "DownloadOptions": lambda **kwargs: SimpleNamespace(**kwargs),
    }
    exec(
        compile(module, str(source), "exec"), namespace
    )  # noqa: S102 - Use real methods without Textual.
    return namespace["DownloadTab"]


DownloadTab = load_download_tab()


def make_tab(url="https://example.invalid/a"):
    tab = DownloadTab(SimpleNamespace(t=lambda key: key))
    tab.mode = "video"
    tab.runs = []
    tab.notifications = []
    tab.app = SimpleNamespace(
        notify=lambda *args, **kwargs: tab.notifications.append((args, kwargs))
    )
    tab.widgets = {
        "#urls": TextArea(url),
        "#save-path": Input("synthetic-output"),
        "#video-fmt": Select("mp4"),
        "#audio-fmt": Select("mp3"),
        "#quality": Select("720p"),
        "#cookie-file": Input(""),
        "#browser": Select("none"),
        "#bitrate": Select("192"),
        "#items-list": ListView(),
        "#progress": ProgressBar(),
        "#start": Button("start"),
        "#stop": Button("stop", disabled=True),
    }
    tab.query_one = lambda selector, *_: tab.widgets[selector]
    tab._run_download = lambda urls, opts: tab.runs.append((list(urls), opts))
    return tab


def press(tab, name):
    tab.on_button_pressed(SimpleNamespace(button=tab.widgets["#" + name]))


def test_repeated_start_preserves_stop_and_items():
    tab = make_tab()
    press(tab, "start")
    original_items = tab._item_widgets.copy()
    press(tab, "stop")
    tab.widgets["#urls"].text = "https://example.invalid/b"
    press(tab, "start")
    assert len(tab.runs) == 1, "a repeated start launched another worker"
    assert tab._cancel_requested.is_set(), "a repeated start cleared the stop request"
    assert (
        tab._item_widgets == original_items
    ), "a repeated start replaced the current items"
    assert tab.widgets["#stop"].disabled


def test_repeated_start_does_not_reset_active_downloader():
    tab = make_tab()
    press(tab, "start")
    stops = []
    tab._downloader = SimpleNamespace(stop=lambda: stops.append("stop"))
    press(tab, "stop")
    press(tab, "start")
    assert stops == ["stop"] and len(tab.runs) == 1 and tab._cancel_requested.is_set()


def test_reentry_during_list_clear_does_not_launch_twice():
    tab = make_tab()
    tab.widgets["#items-list"].on_clear = lambda: press(tab, "start")
    press(tab, "start")
    assert len(tab.runs) == 1, "reentry during list update launched another worker"


def test_reentry_during_url_read_does_not_launch_twice():
    tab = make_tab()
    tab.widgets["#urls"].on_read = lambda: press(tab, "start")
    press(tab, "start")
    assert len(tab.runs) == 1, "reentry during URL read launched another worker"


def test_finish_does_not_disable_stop_for_a_reentrant_new_worker():
    tab = make_tab()
    press(tab, "start")
    tab.widgets["#start"].on_enable = lambda: press(tab, "start")
    tab._finish()
    assert len(tab.runs) == 1, "finish allowed start before its UI cleanup completed"
    assert tab.widgets["#stop"].disabled
    press(tab, "start")
    assert len(tab.runs) == 2 and not tab.widgets["#stop"].disabled


def test_empty_url_allows_a_later_start():
    tab = make_tab("")
    press(tab, "start")
    assert tab.notifications and not tab.runs
    tab.widgets["#urls"].text = "https://example.invalid/a"
    press(tab, "start")
    assert len(tab.runs) == 1


def test_start_error_restores_controls_and_allows_retry():
    tab = make_tab()
    tab.widgets["#progress"].error = RuntimeError("synthetic progress failure")
    try:
        press(tab, "start")
    except RuntimeError as error:
        assert str(error) == "synthetic progress failure"
    else:
        raise AssertionError("expected synthetic progress failure")
    assert not tab.widgets["#start"].disabled and tab.widgets["#stop"].disabled
    press(tab, "start")
    assert len(tab.runs) == 1


# OpenAI-Codex_app_ui: keep a stop request delivered during form initialization.
def test_stop_during_url_read_remains_requested():
    tab = make_tab()
    tab.widgets["#urls"].on_read = lambda: press(tab, "stop")
    press(tab, "start")
    assert len(tab.runs) == 1 and tab._cancel_requested.is_set()
    assert tab.widgets["#stop"].disabled


def test_stop_during_list_update_remains_requested():
    tab = make_tab()
    tab.widgets["#items-list"].on_clear = lambda: press(tab, "stop")
    press(tab, "start")
    assert len(tab.runs) == 1 and tab._cancel_requested.is_set()
    assert tab.widgets["#stop"].disabled


def test_new_operation_clears_previous_stop():
    tab = make_tab()
    press(tab, "start")
    press(tab, "stop")
    tab._finish()
    press(tab, "start")
    assert len(tab.runs) == 2 and not tab._cancel_requested.is_set()
    assert not tab.widgets["#stop"].disabled


def main():
    checks = [
        test_repeated_start_preserves_stop_and_items,
        test_stop_during_url_read_remains_requested,
        test_stop_during_list_update_remains_requested,
        test_new_operation_clears_previous_stop,
        test_repeated_start_does_not_reset_active_downloader,
        test_reentry_during_list_clear_does_not_launch_twice,
        test_reentry_during_url_read_does_not_launch_twice,
        test_finish_does_not_disable_stop_for_a_reentrant_new_worker,
        test_empty_url_allows_a_later_start,
        test_start_error_restores_controls_and_allows_retry,
    ]
    failures = []
    for check in checks:
        try:
            check()
        except AssertionError as error:
            failures.append(check.__name__)
            print(f"FAIL {check.__name__}: {error}")
        else:
            print(f"PASS {check.__name__}")
    print(f"{len(checks) - len(failures)}/{len(checks)} synthetic checks passed")
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
