"""Exercise preview event guards with in-memory Textual and worker substitutes.

OpenAI-Codex_app_ui. This does not establish actual Textual event scheduling.
"""

from __future__ import annotations

import ast
import threading
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


class FakeBase:
    def __init__(self):
        self.is_mounted = True

    def watch(self, widget, name, callback, init=True):
        assert name == "value" and init is False
        widget.callbacks.append(callback)


class Input:
    def __init__(self, value, widget_id):
        self._value = value
        self.id = widget_id
        self.callbacks = []

    @property
    def value(self):
        return self._value

    @value.setter
    def value(self, value):
        if value != self._value:
            self._value = value
            for callback in self.callbacks:
                callback()


class Select(Input):
    pass


class TextArea:
    def __init__(self):
        self.id = "file-paths"
        self._text = ""
        self.events = []

    @property
    def text(self):
        return self._text

    @text.setter
    def text(self, text):
        self._text = text
        self.events.append(SimpleNamespace(text_area=self))


class Static:
    def __init__(self, text=""):
        self.text = text

    def update(self, text):
        self.text = text


class Button:
    def __init__(self):
        self.disabled = False


class ListItem:
    def __init__(self, child):
        self.child = child


class ListView:
    def __init__(self):
        self.items = []
        self.index = None

    def append(self, item):
        self.items.append(item)

    def pop(self, index):
        self.items.pop(index)


class ConfirmDialog:
    def __init__(self, *args):
        self.args = args


def load_convert_tab():
    source = Path(__file__).resolve().parents[1] / "tui" / "convert_tab.py"
    tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
    tab = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "ConvertTab")
    names = {
        "__init__", "on_mount", "on_input_changed", "on_select_changed", "on_text_area_changed",
        "_invalidate_preview", "_preview_inputs", "_add_files", "_remove_selected", "_preview",
        "_preview_done", "_start", "_begin", "_finish",
    }
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
        "FakeBase": FakeBase, "Input": Input, "Select": Select, "TextArea": TextArea,
        "Static": Static, "Button": Button, "ListItem": ListItem, "ListView": ListView,
        "ConfirmDialog": ConfirmDialog, "threading": threading,
        "redact_sensitive_urls": lambda text: text,
    }
    exec(compile(module, str(source), "exec"), namespace)  # noqa: S102 - Extract local methods without Textual.
    return namespace["ConvertTab"]


ConvertTab = load_convert_tab()


def make_tab(version="8.2.8"):
    tab = ConvertTab(SimpleNamespace(t=lambda key: key))
    tab._files = ["synthetic-a.mkv"]
    tab._item_widgets = [Static("synthetic-a.mkv")]
    tab.preview_calls = []
    tab.runs = []
    tab.dialogs = []
    tab.notifications = []
    tab.app = SimpleNamespace(
        notify=lambda *args, **kwargs: tab.notifications.append((args, kwargs)),
        push_screen=lambda screen, callback: tab.dialogs.append((screen, callback)),
    )
    tab.widgets = {
        "#save-path": Input("synthetic-output", "save-path"),
        "#ffmpeg-bin": Input("ffmpeg", "ffmpeg-bin"),
        "#dst-fmt": Select("mp4", "dst-fmt"),
        "#conflict-policy": Select("rename", "conflict-policy"),
        "#file-paths": TextArea(), "#files-list": ListView(), "#preview-results": Static(),
        **{f"#{name}": Button() for name in ("start", "stop", "add-file", "remove-file", "preview")},
    }
    tab.widgets["#files-list"].append(ListItem(tab._item_widgets[0]))
    tab.widgets["#files-list"].index = 0
    tab.query_one = lambda selector, *_: tab.widgets[selector]
    tab._run_preview = lambda *args: tab.preview_calls.append(args)
    tab._run_convert = lambda *args: tab.runs.append(args)
    with patch("importlib.metadata.version", return_value=version):
        tab.on_mount()
    return tab


ROWS = {
    "synthetic-a.mkv": {"src": "synthetic-a.mkv", "dst": "synthetic-output/a.mp4", "existing": "missing",
                        "batch_duplicate": False, "source_matches": "no"},
    "synthetic-b.mov": {"src": "synthetic-b.mov", "dst": "synthetic-output/b.mp4", "existing": "missing",
                        "batch_duplicate": False, "source_matches": "no"},
}


def preview(tab):
    tab._preview()
    return tab._preview_generation


def finish_preview(tab, generation):
    files = tab.preview_calls[-1][1]
    tab._preview_done(generation, [dict(ROWS[name]) for name in files], None)


def text_event(tab):
    return SimpleNamespace(text_area=tab.widgets["#file-paths"])


def test_delayed_text_events_do_not_discard_new_file_list():
    tab = make_tab()
    area = tab.widgets["#file-paths"]
    area.text = "synthetic-b.mov"
    tab._add_files()
    generation = preview(tab)
    assert tab.preview_calls[-1][1] == ["synthetic-a.mkv", "synthetic-b.mov"]
    for event in area.events:
        tab.on_text_area_changed(event)
    assert tab._preview_generation == generation, "old text events invalidated a current preview"
    finish_preview(tab, generation)
    assert "synthetic-a.mkv" in tab.widgets["#preview-results"].text
    assert "synthetic-b.mov" in tab.widgets["#preview-results"].text


def test_unchanged_event_does_not_erase_rendered_snapshot():
    tab = make_tab()
    generation = preview(tab)
    finish_preview(tab, generation)
    before = tab.widgets["#preview-results"].text
    tab.on_text_area_changed(text_event(tab))
    assert before and tab.widgets["#preview-results"].text == before


def test_pending_text_aba_keeps_current_actual_files():
    tab = make_tab()
    generation = preview(tab)
    area = tab.widgets["#file-paths"]
    area.text = "synthetic-b.mov"
    area.text = ""
    for event in area.events:
        tab.on_text_area_changed(event)
    assert tab.preview_calls[-1][1] == ["synthetic-a.mkv"]
    finish_preview(tab, generation)
    rendered = tab.widgets["#preview-results"].text
    assert "synthetic-a.mkv" in rendered and "synthetic-b.mov" not in rendered


def test_changed_pending_text_invalidates():
    tab = make_tab()
    generation = preview(tab)
    area = tab.widgets["#file-paths"]
    area.text = "synthetic-b.mov"
    tab.on_text_area_changed(area.events[-1])
    finish_preview(tab, generation)
    assert not tab.widgets["#preview-results"].text and tab._preview_snapshot is None


def test_adding_or_removing_files_invalidates_existing_preview():
    for operation in ("add", "remove"):
        tab = make_tab()
        generation = preview(tab)
        if operation == "add":
            tab.widgets["#file-paths"].text = "synthetic-b.mov"
            tab._add_files()
        else:
            tab._remove_selected()
        finish_preview(tab, generation)
        assert not tab.widgets["#preview-results"].text


def test_running_still_invalidates():
    tab = make_tab()
    generation = preview(tab)
    tab._start()
    assert tab._conversion_running and len(tab.runs) == 1
    tab.on_text_area_changed(text_event(tab))
    finish_preview(tab, generation)
    assert not tab.widgets["#preview-results"].text and tab.widgets["#preview"].disabled


def test_input_and_select_aba_invalidates_via_synchronous_fake_watchers():
    for selector, alternate in (("#save-path", "other-output"), ("#ffmpeg-bin", "other-ffmpeg"),
                                ("#dst-fmt", "mkv"), ("#conflict-policy", "skip")):
        tab = make_tab()
        generation = preview(tab)
        field = tab.widgets[selector]
        original = field.value
        field.value = alternate
        field.value = original
        tab.on_text_area_changed(text_event(tab))
        finish_preview(tab, generation)
        assert not tab.widgets["#preview-results"].text, selector


def test_changed_other_field_with_undispatched_watch_fails_closed():
    tab = make_tab()
    generation = preview(tab)
    tab.widgets["#save-path"]._value = "other-output"
    tab.on_text_area_changed(text_event(tab))
    finish_preview(tab, generation)
    assert not tab.widgets["#preview-results"].text and tab._preview_snapshot is None


def test_unverified_watcher_retains_existing_fallback():
    tab = make_tab("8.2.9")
    assert not tab._preview_watch_ready
    generation = preview(tab)
    tab.on_text_area_changed(text_event(tab))
    finish_preview(tab, generation)
    assert not tab.widgets["#preview-results"].text and tab._preview_snapshot is None


def test_unknown_none_or_other_textarea_retains_fallback():
    for event in (None, SimpleNamespace(), SimpleNamespace(text_area=SimpleNamespace(id="other"))):
        tab = make_tab()
        generation = preview(tab)
        tab.on_text_area_changed(event)
        finish_preview(tab, generation)
        assert not tab.widgets["#preview-results"].text and tab._preview_snapshot is None


def test_unmounted_retains_fallback():
    tab = make_tab()
    generation = preview(tab)
    tab.is_mounted = False
    tab.on_text_area_changed(text_event(tab))
    assert tab._preview_generation > generation and tab._preview_snapshot is None


def test_snapshot_read_error_fails_closed():
    tab = make_tab()
    generation = preview(tab)
    query = tab.query_one

    def fail_input(selector, *types):
        if selector == "#save-path":
            raise RuntimeError("synthetic read failure")
        return query(selector, *types)

    tab.query_one = fail_input
    tab.on_text_area_changed(text_event(tab))
    assert tab._preview_generation > generation and tab._preview_snapshot is None


def test_invalidation_error_still_propagates():
    tab = make_tab()
    preview(tab)
    tab.widgets["#file-paths"].text = "synthetic-b.mov"

    def fail_update(_text):
        raise RuntimeError("synthetic display failure")

    tab.widgets["#preview-results"].update = fail_update
    try:
        tab.on_text_area_changed(text_event(tab))
    except RuntimeError as exc:
        assert str(exc) == "synthetic display failure"
    else:
        raise AssertionError("expected the pre-existing invalidation error")
    assert tab._preview_snapshot is None


def test_delayed_unchanged_event_does_not_hide_worker_error():
    tab = make_tab()
    area = tab.widgets["#file-paths"]
    area.text = "synthetic-b.mov"
    area.text = ""
    generation = preview(tab)
    for event in area.events:
        tab.on_text_area_changed(event)
    tab._preview_done(generation, None, "synthetic preview error")
    assert tab.notifications == [(("synthetic preview error",), {"severity": "error"})]


def test_confirmation_guard_still_rejects_old_callback():
    tab = make_tab()
    tab.widgets["#conflict-policy"].value = "overwrite"
    tab._start()
    tab._start()
    old_callback = tab.dialogs[0][1]
    new_callback = tab.dialogs[1][1]
    old_callback(True)
    assert not tab.runs
    new_callback(True)
    assert len(tab.runs) == 1
    tab._finish()
    old_callback(True)
    assert len(tab.runs) == 1


# OpenAI-Codex_app_ui: preserve fallback when an event cannot be inspected.
def test_event_attribute_error_fails_closed():
    class BrokenEvent:
        @property
        def text_area(self):
            raise RuntimeError("synthetic event failure")

    tab = make_tab()
    generation = preview(tab)
    tab.on_text_area_changed(BrokenEvent())
    assert tab._preview_generation > generation and tab._preview_snapshot is None


def main():
    checks = [
        test_delayed_text_events_do_not_discard_new_file_list,
        test_unchanged_event_does_not_erase_rendered_snapshot,
        test_pending_text_aba_keeps_current_actual_files,
        test_changed_pending_text_invalidates,
        test_adding_or_removing_files_invalidates_existing_preview,
        test_running_still_invalidates,
        test_input_and_select_aba_invalidates_via_synchronous_fake_watchers,
        test_changed_other_field_with_undispatched_watch_fails_closed,
        test_unverified_watcher_retains_existing_fallback,
        test_unknown_none_or_other_textarea_retains_fallback,
        test_event_attribute_error_fails_closed,
        test_unmounted_retains_fallback,
        test_snapshot_read_error_fails_closed,
        test_invalidation_error_still_propagates,
        test_delayed_unchanged_event_does_not_hide_worker_error,
        test_confirmation_guard_still_rejects_old_callback,
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
