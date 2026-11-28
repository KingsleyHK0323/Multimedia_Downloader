"""Exercise AI transport privacy with in-memory dependencies only.

OpenAI-Codex_engine_cli: this standalone check reads the current orchestrator
source but does not import the engine, yt-dlp, or make network connections.
"""

from __future__ import annotations

import ast
import copy
import io
import json
import socket
import traceback
import typing
import urllib.error
import urllib.request
from pathlib import Path
from types import SimpleNamespace


def _extract(source: str) -> dict:
    tree = ast.parse(source, filename="ai/orchestrator.py")
    picked = []
    functions = {"_reject_key_controls", "_default_transport", "_safe_default_transport"}
    assignments = {"_DEAD_MODEL_MARKERS", "_unchecked_default_transport", "_default_transport"}
    found_functions = set()
    found_class = False
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id in assignments for target in node.targets
        ):
            picked.append(copy.deepcopy(node))
        elif isinstance(node, ast.FunctionDef) and node.name in functions:
            found_functions.add(node.name)
            picked.append(copy.deepcopy(node))
        elif isinstance(node, ast.ClassDef) and node.name == "OrchestratorError":
            picked.append(copy.deepcopy(node))
        elif isinstance(node, ast.ClassDef) and node.name == "Orchestrator":
            selected = copy.deepcopy(node)
            selected.body = [
                method for method in selected.body
                if isinstance(method, ast.FunctionDef) and method.name in {"__init__", "_post", "_call"}
            ]
            assert {method.name for method in selected.body} == {"__init__", "_post", "_call"}
            picked.append(selected)
            found_class = True
    assert found_functions == functions and found_class
    module = ast.fix_missing_locations(ast.Module(body=[
        ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0),
        *picked,
    ], type_ignores=[]))
    namespace = {
        "json": json,
        "urllib": __import__("urllib"),
        "Callable": typing.Callable,
        "OPENROUTER_BASE_URL": "https://example.invalid",
    }
    exec(compile(module, "<ai-transport-privacy>", "exec"), namespace)  # noqa: S102
    return namespace


def run_checks(source: str) -> int:
    namespace = _extract(source)
    error_type = namespace["OrchestratorError"]
    transport = namespace["_default_transport"]
    orchestrator = namespace["Orchestrator"]
    marker = "FAKE_SECRET_42"
    completed = 0

    def deny(*_args, **_kwargs):
        raise AssertionError("network disabled")

    def rendered(error):
        return str(error) + "".join(traceback.format_exception(type(error), error, error.__traceback__))

    def expect_error(function, expected):
        try:
            function()
        except error_type as error:
            assert expected in str(error)
            return error
        raise AssertionError("expected a synthetic orchestrator error")

    class RecordingStream(io.BytesIO):
        def __init__(self, data):
            super().__init__(data)
            self.requests = []
            self.total_read = 0

        def read(self, size=-1):
            self.requests.append(size)
            data = super().read(min(size, 7) if size >= 0 else size)
            self.total_read += len(data)
            return data

    def fail_urlopen(error):
        def fake(*_args, **_kwargs):
            raise error
        urllib.request.urlopen = fake

    def invoke():
        return transport("https://example.invalid", {}, marker)

    old_socket = socket.socket
    old_connection = socket.create_connection
    old_urlopen = urllib.request.urlopen
    old_request = urllib.request.Request
    socket.socket = deny
    socket.create_connection = deny
    urllib.request.urlopen = deny
    try:
        stream = RecordingStream(("No endpoints found " + marker + "x" * 5000).encode())
        fail_urlopen(urllib.error.HTTPError("https://example.invalid", 503, "FAKE_REASON", {}, stream))
        error = expect_error(invoke, "HTTP 503")
        assert "No endpoints found" in str(error)
        assert marker not in rendered(error) and "FAKE_REASON" not in rendered(error)
        assert stream.closed and stream.total_read == 1200
        assert stream.requests and all(0 <= size <= 1200 for size in stream.requests)
        completed += 1

        for reason_marker in ("HTTP 404", "HTTP 400", "not a valid model",
                              "No endpoints found", "No allowed providers", ""):
            fail_urlopen(urllib.error.URLError("FAKE_REASON " + marker + " " + reason_marker))
            error = expect_error(invoke, "request failed")
            assert marker not in rendered(error) and "FAKE_REASON" not in rendered(error)
            if reason_marker:
                assert reason_marker in str(error)
            completed += 1

        fail_urlopen(TimeoutError("FAKE_REASON " + marker))
        error = expect_error(invoke, "timed out")
        assert marker not in rendered(error) and "FAKE_REASON" not in rendered(error)
        completed += 1

        def unexpected(*_args, **_kwargs):
            raise ValueError("FAKE_REASON " + marker)

        urllib.request.Request = unexpected
        error = expect_error(invoke, "unexpectedly")
        assert marker not in rendered(error)
        completed += 1
        urllib.request.Request = old_request
        fail_urlopen(ValueError("FAKE_REASON " + marker))
        error = expect_error(invoke, "unexpectedly")
        assert marker not in rendered(error)
        completed += 1

        for code in (0, 9, 10, 13, 31, 127, 128, 133, 159):
            key = "FAKE_HEAD" + chr(code) + "FAKE_TAIL"
            urllib.request.Request = deny
            error = expect_error(lambda: transport("https://example.invalid", {}, key), "control")
            assert "FAKE_HEAD" not in rendered(error) and "FAKE_TAIL" not in rendered(error)
            completed += 1
            error = expect_error(lambda: orchestrator(key, transport=lambda *_: None), "control")
            assert "FAKE_HEAD" not in rendered(error) and "FAKE_TAIL" not in rendered(error)
            completed += 1
        urllib.request.Request = old_request

        seen = []

        def success(request, timeout):
            assert timeout == 60
            seen.append(request.get_header("Authorization"))
            return io.BytesIO(b'{"choices":[{"message":{"content":"ok"}}]}')

        urllib.request.urlopen = success
        assert transport("https://example.invalid", {}, marker)["choices"][0]["message"]["content"] == "ok"
        assert seen == ["Bearer " + marker]
        completed += 1

        preferred = SimpleNamespace(role="planner", slug="fake-preferred")
        alternate = SimpleNamespace(role="planner", slug="fake-alternate")
        for status, body, retry in ((400, "", True), (404, "", True), (429, "", False),
                                    (503, "", False), (503, "No endpoints found", True)):
            calls = []

            def fake_retry(request, timeout):
                assert timeout == 60
                calls.append(1)
                if len(calls) == 1:
                    raise urllib.error.HTTPError(request.full_url, status, "FAKE_REASON", {},
                                                 io.BytesIO(body.encode()))
                return io.BytesIO(b'{"choices":[{"message":{"content":"ok"}}]}')

            urllib.request.urlopen = fake_retry
            instance = orchestrator(marker, transport=transport)
            instance._model = lambda model: model
            instance.roster = lambda: SimpleNamespace(
                next_alternate=lambda _role, tried: alternate if alternate.slug not in tried else None
            )
            if retry:
                assert instance._call(preferred, "system", "request") == "ok" and len(calls) == 2
            else:
                expect_error(lambda: instance._call(preferred, "system", "request"), "HTTP")
                assert len(calls) == 1
            completed += 1

        responses = (
            {}, [marker], {"choices": []}, {"choices": [marker]}, {"choices": [{}]},
            {"choices": [{"message": []}]}, {"choices": [{"message": {"content": 5}}]},
            {"unexpected": marker},
        )
        for response in responses:
            instance = orchestrator(marker, transport=lambda *_args, response=response: response)
            error = expect_error(lambda: instance._post(preferred, "system", "request"), "response")
            assert marker not in rendered(error)
            completed += 1

        instance = orchestrator(marker, transport=lambda *_: {"choices": [{"message": {"content": "ok"}}]})
        assert instance._post(preferred, "system", "request") == "ok"
        completed += 1

        class SensitiveMapping(dict):
            def __getitem__(self, _key):
                raise KeyError(marker)

        instance = orchestrator(marker, transport=lambda *_: SensitiveMapping())
        error = expect_error(lambda: instance._post(preferred, "system", "request"), "response shape")
        assert marker not in rendered(error)
        assert isinstance(error.__context__, KeyError) and marker in str(error.__context__)
        assert error.__suppress_context__ is True
        completed += 1
    finally:
        urllib.request.Request = old_request
        urllib.request.urlopen = old_urlopen
        socket.create_connection = old_connection
        socket.socket = old_socket
    return completed


if __name__ == "__main__":
    source_path = Path(__file__).absolute().parent.parent / "ai" / "orchestrator.py"
    total = run_checks(source_path.read_text(encoding="utf-8"))
    print(f"AI transport privacy memory checks passed: {total}.")
